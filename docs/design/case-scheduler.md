---
level: 高级
tags: [架构案例, 分布式调度, 定时任务, Cron, 防重复触发, 任务分片, 时间轮, misfire, XXL-JOB, Quartz, 幂等]
summary: 以企业级分布式任务调度平台为例拆解：为什么单机定时任务在多实例下会出问题、调度中心与执行器的架构、如何保证同一任务同一时刻只触发一次（DB 行锁/SKIP LOCKED/选主/分片）、任务分片与路由策略、超时/重试/失败告警、幂等与错过触发（misfire）策略、任务依赖编排（DAG）、时间轮与海量延迟任务、与 XXL-JOB/Quartz/ElasticJob/K8s CronJob/Airflow 的选型。
---

# 案例：分布式任务调度平台设计详解

> [!ABSTRACT] 核心要点
> - 单机的 `@Scheduled`/`Timer` 在**多实例部署**下会**重复执行**；业务需要“**到点只执行一次**、可分片并行、失败可重试、可观测、可管理（暂停/手动触发/告警）”，这就是分布式调度平台要解决的问题。
> - 经典架构：**调度中心（Scheduler，负责“什么时候触发谁”）+ 执行器（Executor，负责“怎么执行”）+ 存储（任务/日志）**；触发与执行**解耦**，通过 RPC/HTTP 通知执行器。
> - **“只触发一次”靠抢占**：调度器多实例竞争，用**数据库行锁（`SELECT ... FOR UPDATE SKIP LOCKED`）/ 分布式锁 / 选主**保证同一时刻同一任务只有一个调度器触发；**触发 ≠ 执行成功**，执行端必须**幂等**。
> - 规模化的关键：**任务分片（一个任务拆成 N 片并行）**、**调度器分片（不同调度器负责不同任务子集）**、**时间轮/最小堆**高效管理海量定时点、避免大批任务同时到点造成**惊群**。
> - 必须设计的“异常语义”：**错过触发（misfire）**、**任务超时**、**执行器宕机**、**重试与告警**、**并发控制（上次没跑完这次要不要跑）**、**时区与夏令时**。
> - 选型：**XXL-JOB**（轻量易用）、**Quartz**（库）、**ElasticJob**（分片强）、**K8s CronJob**（容器批任务）、**Airflow/DolphinScheduler**（数据工作流 DAG）。

> [!NOTE] 说明
> 容量数字为推演用的**假设**。并发、锁与死锁基础见 [进程与线程](#/cs/os-process)，分布式锁见 [Redis 分布式锁](#/redis/lock)。

## 一、需求与约束

### 1. 问题场景

- 每天凌晨对账、清理过期数据、生成报表；每分钟扫描超时订单；定时推送；
- 实例有多个，**同一个任务只能有一个实例执行**，或需要**拆成 N 份各实例并行处理**；
- 任务数从几十到**几十万**（平台化后多业务线接入），触发峰值可能集中在整点（00:00、每 5 分钟）。

### 2. 功能与非功能目标（假设）

| 维度 | 目标 |
| --- | --- |
| 功能 | Cron/固定频率/延迟/一次性；暂停/恢复/手动触发；分片；失败重试；超时终止；执行日志；告警；任务依赖；多租户与权限 |
| 触发准确性 | 秒级任务误差 < 1~2 秒；**不漏触发**（故障恢复后按策略补偿）、**不重复触发** |
| 规模 | 10 万个任务、峰值每秒触发 5000 次；执行器 1000+ 节点 |
| 可用性 | 调度中心无单点；调度中心全挂时已在执行的任务不受影响，恢复后补偿 |
| 可观测 | 每次触发/执行有记录、可追溯、可告警；延迟、失败率可监控 |

## 二、总体架构

<figure class="fig">
<svg viewBox="0 0 820 400" class="dg" role="img" aria-label="分布式调度架构：管理控制台通过 API 管理任务；多个调度器实例组成调度中心，共享任务与调度状态存储，通过数据库行锁或选主保证每个任务同一时刻只被一个调度器触发；调度器根据路由策略选择执行器并通过 RPC 触发；执行器注册到注册中心并上报心跳，执行任务后回调结果；日志和告警独立服务处理">
<rect class="b1" x="20" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="55" text-anchor="middle" dominant-baseline="middle">管理控制台 / API</text>
<rect class="b3" x="200" y="20" width="300" height="150" rx="12"/>
<text class="th" x="216" y="44">调度中心（多实例，无状态）</text>
<rect class="b" x="216" y="58" width="130" height="44" rx="6"/>
<text class="ts" x="281" y="80" text-anchor="middle" dominant-baseline="middle">调度器 A</text>
<rect class="b" x="356" y="58" width="130" height="44" rx="6"/>
<text class="ts" x="421" y="80" text-anchor="middle" dominant-baseline="middle">调度器 B</text>
<text class="ts" x="216" y="126" text-anchor="start">扫描到期任务 → 抢占 → 路由 → 触发</text>
<text class="ts" x="216" y="146" text-anchor="start">时间轮 / 最小堆加载近期任务</text>
<line class="l" x1="150" y1="55" x2="200" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="560" y="20" width="240" height="70" rx="10"/>
<text class="tb" x="680" y="44" text-anchor="middle" dominant-baseline="middle">存储（MySQL）</text>
<text class="ts" x="680" y="68" text-anchor="middle">任务定义 · 下次触发时间 · 触发/执行记录</text>
<line class="l" x1="500" y1="55" x2="560" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="560" y="110" width="240" height="60" rx="10"/>
<text class="tb" x="680" y="132" text-anchor="middle" dominant-baseline="middle">注册中心</text>
<text class="ts" x="680" y="152" text-anchor="middle">执行器地址 · 心跳 · 分组</text>
<line class="l" x1="500" y1="130" x2="560" y2="140" marker-end="url(#arr)"/>
<rect class="b4" x="200" y="210" width="420" height="100" rx="12"/>
<text class="th" x="216" y="234">执行器集群（业务应用内嵌 SDK）</text>
<rect class="b" x="216" y="248" width="120" height="44" rx="6"/>
<text class="ts" x="276" y="270" text-anchor="middle" dominant-baseline="middle">执行器 1（分片0）</text>
<rect class="b" x="346" y="248" width="120" height="44" rx="6"/>
<text class="ts" x="406" y="270" text-anchor="middle" dominant-baseline="middle">执行器 2（分片1）</text>
<rect class="b" x="476" y="248" width="130" height="44" rx="6"/>
<text class="ts" x="541" y="270" text-anchor="middle" dominant-baseline="middle">执行器 N（分片…）</text>
<line class="l" x1="350" y1="170" x2="350" y2="210" marker-end="url(#arr)"/>
<text class="ta" x="360" y="196" text-anchor="start">RPC 触发（任务 ID、分片参数）</text>
<line class="la" x1="640" y1="260" x2="720" y2="170"/>
<text class="ts" x="690" y="214" text-anchor="start">注册/心跳</text>
<rect class="bg" x="20" y="330" width="780" height="56" rx="10"/>
<text class="ts" x="36" y="354">• 调度与执行解耦：调度中心只触发和记录，不执行业务；执行器把结果回调/上报，触发成功不等于业务成功</text>
<text class="ts" x="36" y="374">• 调度中心全挂：已触发的任务继续执行；恢复后根据 misfire 策略补偿；执行器与调度中心通过心跳互相感知</text>
</svg>
<figcaption>图 1：调度中心、执行器、存储与注册中心</figcaption>
</figure>

## 三、核心设计

### 1. 数据模型（精简）

```sql
CREATE TABLE job_info (
  id BIGINT PRIMARY KEY, app VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL,
  schedule_type TINYINT NOT NULL,                 -- 1 cron 2 固定频率 3 固定延迟 4 一次性
  cron VARCHAR(64), timezone VARCHAR(32) DEFAULT 'Asia/Shanghai',
  handler VARCHAR(128) NOT NULL,                  -- 执行器上的处理器名
  route_strategy TINYINT NOT NULL,                -- 轮询/随机/一致性哈希/故障转移/广播/分片
  shard_total INT DEFAULT 1,                      -- 分片总数
  timeout_sec INT DEFAULT 0, retry_max INT DEFAULT 0,
  misfire_policy TINYINT DEFAULT 1,               -- 错过触发策略
  concurrency TINYINT DEFAULT 1,                  -- 1 串行(上次未完则跳过) 2 并行 3 覆盖
  status TINYINT NOT NULL,                        -- 启用/暂停
  next_fire_time BIGINT NOT NULL,                 -- 下次触发时间（毫秒），调度的核心索引
  KEY idx_status_next (status, next_fire_time)
);
CREATE TABLE job_log (                            -- 每次触发一条（按月分表/定期归档）
  id BIGINT PRIMARY KEY, job_id BIGINT, trigger_time DATETIME(3), executor_addr VARCHAR(64),
  shard_idx INT, status TINYINT, cost_ms INT, msg VARCHAR(512),
  KEY idx_job_time (job_id, trigger_time)
);
```

### 2. “只触发一次”：多调度器的抢占

**问题**：调度器 A、B 同时发现任务 X 到点，只能有一个触发。

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **数据库行锁（推荐）** | 事务里 `SELECT ... WHERE status=1 AND next_fire_time <= now ORDER BY next_fire_time LIMIT N FOR UPDATE SKIP LOCKED`，取到的任务由当前调度器**独占**；触发后 `UPDATE next_fire_time = 下次时间`，提交 | 简单可靠、多实例无需选主；**SKIP LOCKED**（MySQL 8.0+/PG）让各调度器并行抢不同任务，不互相阻塞 |
| 全局锁/选主 | 同一时刻只有一个调度器干活（ZooKeeper/etcd/Redis 锁） | 简单但调度器是单点瓶颈，其他实例空闲（仅热备） |
| **调度器分片** | 按 `job_id % 调度器数` 把任务划给不同调度器，各管各的 | 吞吐可线性扩展；调度器增减要重新分配（一致性哈希） |
| 乐观更新 | `UPDATE job_info SET next_fire_time=新值 WHERE id=? AND next_fire_time=旧值`，影响行数为 1 才算抢到 | 无需长事务锁；冲突时重试 |
| 分布式锁（Redis） | 对每个任务触发加 `SET NX PX` 锁 | 可用但依赖锁的正确性，见 [Redis 分布式锁](#/redis/lock)；数据库已有行锁时通常不需要 |

```java
@Scheduled(fixedDelay = 500)                       // 调度循环：不断取到期任务
public void scan() {
    List<Job> due = tx.execute(s -> {
        List<Job> jobs = jobMapper.lockDue(System.currentTimeMillis() + PRE_READ_MS, BATCH);   // FOR UPDATE SKIP LOCKED
        jobs.forEach(j -> jobMapper.updateNextFire(j.getId(), cron.next(j, j.getNextFireTime())));   // 先推进下次时间，防重复
        return jobs;
    });
    due.forEach(j -> wheel.schedule(j, j.getFireTime()));     // 放入时间轮，精确到点再触发
}
```

**预读 + 时间轮**：每次扫描读取未来几秒内到期的任务（`PRE_READ_MS`，如 5 秒），放进**内存时间轮**，到点精确触发——避免每个任务都去数据库轮询，也降低触发抖动（见 [时间轮](#/cs/algo-engineering)）。

### 3. 触发：路由与任务分片

调度器触发时决定**发给哪些执行器**：

| 路由策略 | 说明 | 场景 |
| --- | --- | --- |
| 轮询 / 随机 | 均匀分配 | 无状态通用任务 |
| **一致性哈希** | 按任务（或参数）哈希到固定执行器 | 任务有本地状态/缓存亲和 |
| 第一个 / 最后一个 | 固定某个 | 单点执行 |
| **故障转移** | 按顺序探活，选第一个存活的 | 主备式 |
| 忙碌转移 | 选当前空闲的执行器 | 长任务 |
| **广播** | 触发所有执行器 | 刷新本地缓存、清理本地文件 |
| **分片广播** | 把任务分成 N 片，每个执行器收到 `(分片序号 i, 总数 N)` | **海量数据并行处理** |

**分片示例**：对账任务需要处理 1000 万条订单，分成 10 片，每片处理 `order_id % 10 == i` 的数据：

```java
@JobHandler("orderReconcile")
public void execute(JobContext ctx) {
    int idx = ctx.shardIndex(), total = ctx.shardTotal();        // 当前分片、总分片
    long last = 0;
    while (true) {
        List<Order> batch = orderRepo.scan(last, idx, total, 1000);   // WHERE id > ? AND id % total = idx ORDER BY id LIMIT 1000
        if (batch.isEmpty()) break;
        batch.forEach(this::reconcile);                           // 业务处理（必须幂等）
        last = batch.get(batch.size() - 1).getId();
        ctx.heartbeat();                                          // 向调度中心上报进度/续期，防止被判超时
        if (ctx.isCancelled()) return;                            // 响应取消/超时终止
    }
}
```

分片要点：**分片数 ≥ 执行器数**更均衡；执行器数量变化时分片归属会变（任务幂等才能安全）；**数据倾斜**时按范围分片而不是取模；分片结果由调度中心聚合状态（全部成功才算成功）。

### 4. 执行：超时、重试、并发控制

| 机制 | 说明 |
| --- | --- |
| **超时终止** | 超过 `timeout_sec` 调度中心通知执行器中断（线程 `interrupt`/取消标志），任务代码要**响应中断**；强杀线程有数据一致性风险（见 [线程中断](#/java/concurrency/thread)） |
| **失败重试** | 失败后按次数/间隔（指数退避）重试；**重试可能与原执行重叠**（执行器仍在跑）→ 幂等/幂等键；区分“触发失败（执行器不可达，换一个重试）”与“执行失败（业务异常）” |
| **并发控制** | 上次触发的实例**还没跑完**时，本次触发怎么办：①**串行跳过**（默认，防堆积）②**排队等待** ③**并行执行**（需业务允许）④**取消旧的、执行新的** |
| **执行器宕机** | 心跳超时 → 注册中心摘除；正在执行的任务标记失败并按策略重试（路由到其他执行器），**因此任务必须可重入/幂等** |
| **结果回调** | 执行器异步上报结果；调度中心有**结果超时检测**（超过期望时间未回调判失败）；回调丢失靠心跳/状态轮询补偿 |

### 5. Misfire（错过触发）与补偿

调度中心宕机、数据库抖动、线程耗尽都可能让任务**没在预定时间被触发**。恢复后怎么办？

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| **忽略**（Do nothing） | 错过的不补，等下一个周期 | 周期性清理、心跳类任务 |
| **立即补一次**（Fire once now） | 无论错过多少次，只补一次 | 报表/对账（只需最新一次） |
| **全部补齐**（Fire all） | 错过几次补几次 | 严格按周期累计的业务（少用，可能雪崩） |
| **从下一个周期开始** | 重新计算 | 默认安全策略 |

同时设置**触发容忍窗口**（如到点后 60 秒内仍触发，超过视为 misfire）。补偿要**限流**（恢复后大量任务同时补触发会瞬间压垮执行器）。

### 6. 惊群与整点风暴

大量任务都配在 `0 0 * * * ?`（整点）：触发瞬间执行器与下游数据库被打满。

- **抖动（jitter）**：任务注册时对触发时间加随机偏移（几秒到几十秒）；
- **平台提醒/强制错峰**：同一分钟内任务数超阈值告警，建议业务错开；
- 调度器触发做**令牌桶限流**（见 [限流算法](#/cs/algo-engineering)）；执行器按**线程池 + 队列**排队并有拒绝策略；
- **执行器资源隔离**：不同业务线/重要度用不同执行器组与线程池，避免一个重任务拖垮全部（舱壁隔离，见 [限流、熔断与降级](#/distributed/governance)）。

### 7. 任务依赖与 DAG 编排

数据加工类场景（ETL）有依赖：A 完成 → B、C 并行 → D。

- 定义 **DAG**（有向无环图），上游成功才触发下游；失败节点支持**重跑/跳过**，**回溯补数**（按日期区间重跑）；
- 依赖检测：Kahn 算法拓扑排序检测环（见 [解题套路：拓扑排序](#/cs/algo-patterns)）；
- 数据依赖优于时间依赖：**“A 的分区产出就绪”触发 B**，而不是“A 约 2 点完成所以 B 设 3 点”；
- 这类场景常选 **Airflow / DolphinScheduler / Azkaban**，而不是通用的定时任务平台。

### 8. 时区、夏令时与日历

- 任务保存**时区**，Cron 按任务时区计算，避免服务器时区变化导致漂移；
- **夏令时**切换日会出现“重复的 1 小时/缺失的 1 小时”：关键任务使用 UTC 或避开切换窗口；
- 节假日/工作日：自定义日历（Quartz Calendar）或在任务内判断；
- **时钟**：调度节点要 **NTP 同步**，时钟漂移会让到期判断提前/延后（见 [Linux 线上排查](#/infra/linux)）。

## 四、规模化与高可用

| 维度 | 做法 |
| --- | --- |
| **海量任务（几十万）** | 调度器按任务分片；`next_fire_time` 索引扫描 + 批量；仅加载近几秒窗口进时间轮；冷任务（间隔很长）不常驻内存 |
| **高频任务（每秒）** | 不适合走“中心调度”：由执行器本地循环（本地 `ScheduledExecutor`）或消息队列驱动；调度平台适合分钟级及以上的任务 |
| **调度中心高可用** | 多实例 + 行锁抢占，任一实例宕机其他继续；数据库主从 + 自动切换；无状态便于扩缩 |
| **执行器规模** | 注册中心承载心跳；分组管理；分片并行；弹性扩缩（K8s HPA） |
| **日志与存储** | 触发日志分表+归档、保留 N 天；执行日志写对象存储/ELK，不要都压在调度库 |
| **灰度与变更** | 任务定义变更有审计与版本；修改 Cron/分片数灰度生效；平台升级时调度器滚动，已触发任务不受影响 |

## 五、幂等与可观测

### 1. 任务必须幂等

调度系统天然是“**至少一次**”：重试、故障转移、misfire 补偿、网络重复都可能让同一任务**多次执行**。因此：

- 业务处理基于**业务唯一键**（如 `对账日期 + 批次`）；写入用 **upsert/唯一键**；
- 记录**执行批次号**（`jobId + 触发时间`），已处理过的批次直接跳过；
- 外部副作用（发短信、扣款）前先查记录或用幂等键（见 [订单支付案例：幂等](#/design/case-payment)、[事件驱动：幂等消费](#/design/event-driven)）。

### 2. 监控与告警

| 指标/告警 | 说明 |
| --- | --- |
| **触发延迟** | `实际触发时间 − 计划触发时间` P99；超过阈值说明调度器过载或 misfire |
| **失败率/超时数** | 按任务/应用统计，连续失败 N 次告警（电话/IM） |
| **执行时长趋势** | 突增预示数据量增长或性能退化；接近 Cron 间隔时告警（任务会自己追尾） |
| **未触发检测（死人开关）** | 重要任务设置“**预期触发/完成时间**”，到点未完成告警（任务没跑也要被发现） |
| **执行器在线数、心跳** | 掉线告警 |
| **积压** | 待执行队列长度、被并发策略跳过的次数 |

指标体系见 [指标监控](#/infra/obs-metrics)；每次执行带 `traceId`，日志可追溯（见 [链路追踪、日志与告警](#/infra/obs-trace)）。

## 六、选型对比

| | **XXL-JOB** | **Quartz** | **ElasticJob** | **K8s CronJob** | **Airflow / DolphinScheduler** |
| --- | --- | --- | --- | --- | --- |
| 形态 | 调度中心 + 执行器，开箱即用，有控制台 | **嵌入式库**（可集群模式，DB 锁） | 去中心化，依赖 ZooKeeper，**分片能力强** | K8s 原生，每次触发起一个 Pod | 数据工作流平台 |
| 分片 | 支持 | 需自行实现 | **强**（弹性分片、失效转移） | 无（自行并行） | 任务级并行 |
| 管理/可视化 | ✓ 控制台、日志 | 基本无（需自建） | 控制台可选 | `kubectl`、Dashboard | ✓ 强（DAG 可视化、回溯） |
| 依赖编排 | 子任务（有限） | 弱 | 弱 | 弱（Argo Workflows 补） | ✓ **强** |
| 适合 | 中小规模业务定时任务、快速落地 | 单应用内定时、与 Spring 集成 | 大规模数据分片处理 | 容器化批处理、一次性作业 | **数据 ETL/报表 DAG** |
| 注意 | 调度中心依赖 DB，需做高可用 | 集群模式调度在 DB 行锁上有瓶颈 | 运维 ZooKeeper | 触发时间精度/并发策略 `concurrencyPolicy` | 较重，学习成本 |

**选型建议**：业务系统里的**普通定时任务** → XXL-JOB 之类轻量平台（或 Quartz 集群，规模小）；**海量数据分片处理** → ElasticJob 或平台分片 + 业务按范围分片；**数据仓库/ETL 依赖** → Airflow/DolphinScheduler；**容器化批任务/运维脚本** → K8s CronJob（注意 `concurrencyPolicy: Forbid`、`startingDeadlineSeconds`、`activeDeadlineSeconds`）；**极高频/低延迟定时** → 不走分布式调度，用本地定时器或延迟队列（RocketMQ 定时消息、时间轮，见 [RocketMQ](#/mw/rocketmq)）。

> [!WARNING] 选型提醒
> 上表是通用对比，具体产品的功能与版本差异（XXL-JOB 的路由与分片参数、ElasticJob 的架构版本等）请以官方文档为准。

## 七、常见坑

| 坑 | 对策 |
| --- | --- |
| 多实例都跑 `@Scheduled`，任务重复执行 | 使用分布式调度；或用分布式锁/行锁让只有一个实例执行 |
| 任务非幂等，重试/补偿造成重复处理 | 业务唯一键 + upsert + 批次号 |
| 整点所有任务同时触发，打满下游 | 抖动错峰、限流、线程池隔离 |
| 上次未跑完下次又触发，任务堆叠/数据重复 | 并发策略默认串行跳过；设置超时与告警 |
| 任务超时无法终止（`interrupt` 被忽略） | 代码响应中断/取消标志；分批处理便于检查取消 |
| 调度中心宕机恢复后一次补触发上千个任务 | misfire 策略 + 补偿限流 |
| 时区/夏令时导致任务漂移 | 任务存时区；关键任务用 UTC |
| 分片依赖取模但数据倾斜，某片特别慢 | 按范围/权重分片，监控各分片耗时 |
| 把高频（秒级）任务放进中心调度 | 本地调度/MQ 驱动 |
| 执行日志全写调度库，库被撑爆 | 日志分级存储与归档 |
| 没人知道任务“没跑” | 预期完成时间告警（死人开关） |
| 发布时正在执行的任务被杀 | 优雅停机：等待任务完成或可恢复；任务分批 + 断点续跑（见 [发布策略](#/infra/release)） |

## 面试追问

> [!QUESTION] 为什么需要分布式任务调度？多实例下 @Scheduled 有什么问题？
> 多个实例都会在同一时间执行同一个定时任务，导致重复处理；业务还需要分片并行、失败重试、超时控制、告警、手动触发和可观测。分布式调度由调度中心统一决定何时触发哪个执行器，并保证同一任务同一时刻只触发一次。

> [!QUESTION] 如何保证一个任务同一时刻只被触发一次？
> 多调度器通过抢占实现：数据库行锁，取到期任务时 SELECT FOR UPDATE SKIP LOCKED 独占，触发时先推进 next_fire_time 再提交；或者用乐观更新比较 next_fire_time，或全局选主，或按任务分片给不同调度器。触发并不等于执行成功，所以执行端必须幂等。

> [!QUESTION] 任务分片是什么？怎么用？
> 把一个大任务拆成 N 片并行执行，调度中心分片广播，每个执行器收到分片序号和总数，只处理属于自己的数据，如按主键取模或范围。要保证业务幂等，分片数不少于执行器数，数据倾斜时按范围分片，并对各分片耗时与整体状态做监控和聚合。

> [!QUESTION] 调度中心宕机一段时间后恢复，错过的任务怎么办？
> 由 misfire 策略决定：忽略、只补一次、全部补齐或从下一周期开始，并设置触发容忍窗口。补偿要限流，避免恢复后大量任务同时触发压垮执行器；关键任务还需要预期完成时间告警来发现漏跑。

> [!QUESTION] 整点大量任务同时触发怎么治理？
> 给任务触发时间加随机抖动，平台检测同一时间窗口任务数并提醒业务错峰，调度器触发限流，执行器用线程池和队列排队并设拒绝策略，不同业务用独立执行器组做舱壁隔离，避免一个重任务拖垮全部。

> [!QUESTION] XXL-JOB、Quartz、ElasticJob、Airflow 怎么选？
> 普通业务定时任务选 XXL-JOB 这类有控制台的轻量平台，单应用内简单定时用 Quartz，大规模数据分片处理选 ElasticJob，数据仓库和 ETL 的依赖编排与回溯补数选 Airflow 或 DolphinScheduler，容器化批任务用 K8s CronJob；秒级高频任务不适合中心调度，应使用本地定时器或延迟队列。
