---
level: 深入
tags: [分布式时钟, NTP, 时钟漂移, 时钟回拨, Lamport, 向量时钟, HLC, TrueTime, TSO, 租约, 快照隔离, 事件排序]
summary: 分布式系统里的时间问题：物理时钟的漂移与同步（NTP/PTP）、单调时钟与墙上时钟的区别、时钟回拨与跳变对租约/锁/ID 的影响、逻辑时钟与向量时钟、混合逻辑时钟（HLC）、Spanner 的 TrueTime 与 commit-wait、TiDB/Percolator 的 TSO，以及基于时间做决策时应遵守的工程规则。
---

# 分布式时钟：物理时间、逻辑时钟与 HLC

> [!ABSTRACT] 核心要点
> - **不存在全局时钟**：每台机器有自己的晶振，会**漂移**（常见量级为每天几十毫秒到秒级，取决于硬件与温度），靠 NTP/PTP 校准也只能把误差压到**毫秒（NTP）~亚微秒（PTP+硬件）**级别，**不能保证两台机器的时间严格一致或单调向前**。
> - **墙上时钟（wall clock）与单调时钟（monotonic clock）要分清**：前者表示“现在几点”，可能被 NTP **回拨/跳变**；后者只保证**单调递增**，适合测量**时间间隔**（超时、耗时、租约剩余时间）。**用墙上时钟算超时是经典 bug。**
> - 因此分布式系统里**不要用物理时间判断“谁先谁后”**。要排序事件用**逻辑时钟**：**Lamport 时钟**（保证因果一致的全序，但无法判定并发）、**向量时钟**（能判定并发，代价是向量大小随节点数增长）、**HLC（混合逻辑时钟）**（物理时间 + 逻辑计数，兼顾可读时间与因果序，被多个数据库采用）。
> - 想要**跨节点的全局一致时间戳**，有三条主流路径：**集中授时 TSO**（Percolator/TiDB：一个中心服务发单调时间戳，简单但依赖中心与网络往返）、**TrueTime + commit-wait**（Spanner：用原子钟/GPS 得到**带误差区间**的时间，事务提交时**等待不确定区间过去**，换取外部一致性）、**HLC**（CockroachDB 等：无需特殊硬件，用最大偏移假设保证因果）。
> - 工程规则：**租约/锁/超时用单调时钟；跨机器比较时间必须考虑误差上界；任何依赖“时钟差不超过 X”的设计都要把 X 当作显式假设并监控；ID 生成要处理时钟回拨**。

## 物理时钟的现实

### 时钟是怎么出错的

| 问题 | 说明 | 影响 |
| --- | --- | --- |
| **漂移（drift）** | 晶振频率不精确，随温度、老化变化；虚拟机里还受宿主调度影响 | 机器间时间越差越大，直到被同步 |
| **同步误差（offset）** | NTP 通过网络往返估计偏移，网络不对称/抖动导致误差，公网 NTP 常见数毫秒到数十毫秒 | 比较跨机时间戳不可靠 |
| **跳变（step）** | 时间偏差较大时 NTP/管理员可能**直接把时间拨到正确值**（向前或向后） | **时间回拨**：时间戳倒退，ID/租约/日志顺序异常 |
| **平滑校正（slew）** | 小偏差时通过略微加快/减慢时钟逐渐校正 | 不会回拨，但时间流速不均 |
| **闰秒** | 某分钟多/少一秒，处理方式不一（跳变、平滑“涂抹”） | 历史上引发过大面积故障；云厂商多采用“闰秒涂抹”，同一集群应使用一致策略 |
| **虚拟机暂停/迁移** | VM 被挂起或热迁移，恢复后墙上时间向前跳 | 租约过期判断错乱 |
| **进程暂停（GC/调度）** | 进程在检查时间与使用结果之间被暂停很久（STW、被调度走） | “检查时锁有效”到“使用时锁已失效”，见 [分布式协调](#/mw/coordination) 的 fencing |

### 墙上时钟 vs 单调时钟

| 对比 | 墙上时钟（`System.currentTimeMillis()`、`Instant.now()`） | 单调时钟（`System.nanoTime()`、`Clock` 的单调实现） |
| --- | --- | --- |
| 含义 | 日历时间（自 1970-01-01） | 自某个未指定起点以来的时间，**只增不减** |
| 可被修改 | **会**（NTP 跳变、人工修改） | 不会被调回 |
| 适用 | 展示、记录事件发生时间、跨机大致对齐 | **测量时间间隔**：超时、耗时、限流窗口、租约剩余 |
| 跨机比较 | 有误差，不可靠 | **没有意义**（每台机器起点不同） |

```java
// 反例：用墙上时钟计算超时，时钟被回拨会让“永远不超时”，被前拨会“立刻超时”
long deadline = System.currentTimeMillis() + 5000;
while (System.currentTimeMillis() < deadline) { /* ... */ }

// 正例：用单调时钟计算间隔
long start = System.nanoTime();
while (System.nanoTime() - start < TimeUnit.SECONDS.toNanos(5)) { /* ... */ }
```

### 时钟同步的手段

| 协议/方式 | 精度量级 | 说明 |
| --- | --- | --- |
| **NTP**（chrony/ntpd） | 毫秒~数十毫秒 | 常用；用内网时间源（而不是公网）可更稳；chrony 对虚拟化与间歇网络更友好；配置**限制单次跳变幅度**与“只平滑不跳变”的策略（`makestep` 的使用要慎重） |
| **PTP（IEEE 1588）+ 硬件时间戳** | 微秒~亚微秒 | 数据中心内高精度需求（金融、交易、Spanner 类） |
| **GPS/原子钟** | 纳秒~微秒 | 作为时间源，提供给机房的时间服务器 |
| **云厂商时间同步服务** | 通常亚毫秒~毫秒 | 内网专用，延迟小，优先使用 |

运维要点：**监控时钟偏移**（`chronyc tracking`、NTP offset 指标）并告警，偏移超过阈值的节点要隔离/摘除；容器共享宿主机时钟，**偏移是宿主机问题**；跨可用区/跨地域部署时误差更大。

## 为什么不能靠物理时间排序

两个节点各自给事件打时间戳，时钟差 5ms，则在 5ms 内发生的事件，**时间戳大小不能代表真实先后**。典型后果：

- **LWW（Last Write Wins）冲突解决**：时钟快的节点写入总是“赢”，慢节点的更新被静默覆盖，**丢数据且难排查**；
- **分布式锁/租约过期判断**：节点 A 认为租约还剩 2 秒，节点 B 的时钟快 3 秒，已认为过期并把锁授予他人，两个持有者并存；
- **事务快照/MVCC 可见性**：用本地时间当版本号，会读到“未来”或错过已提交的数据；
- **日志合并与审计**：跨节点日志按时间戳排序会出现“果在因之前”。

结论：**物理时间适合做“大致对齐”和“人类可读”，不适合做“因果判断”**。需要因果判断就用逻辑时钟或有误差界的时间。

## 逻辑时钟

### Lamport 时钟

规则：每个节点维护计数器 `L`；本地事件 `L = L + 1`；**发送消息带上 `L`**；**收到消息时 `L = max(L, 消息中的 L) + 1`**。

- 保证：**若 a 因果先于 b（a → b），则 L(a) < L(b)**；
- **反过来不成立**：`L(a) < L(b)` 不能推出 a 先于 b，也可能是并发事件；
- 用途：为所有事件给出一个**与因果一致的全序**（再用节点 ID 打破平局），如分布式互斥算法、日志排序、乐观并发中的版本号。

### 向量时钟

每个节点维护一个**向量**（每个节点一个计数），事件与消息携带向量；比较规则：

- `V(a) < V(b)`：所有分量 ≤ 且至少一个 <，则 a **因果先于** b；
- 互不可比（有的大有的小）：a 与 b **并发**，需要业务/冲突解决处理。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="向量时钟示例：三个节点 A、B、C 各自维护向量，A 的事件 a1 向量 1,0,0 发送给 B，B 收到后向量变为 1,1,0；C 独立产生事件 向量 0,0,1，与 B 的事件互不可比，因此是并发事件，需要冲突处理；向量比较规则与代价说明">
<text class="th" x="20" y="22">三个节点，时间向右</text>
<line class="ld" x1="60" y1="60" x2="720" y2="60"/>
<line class="ld" x1="60" y1="130" x2="720" y2="130"/>
<line class="ld" x1="60" y1="200" x2="720" y2="200"/>
<text class="tb" x="30" y="64" dominant-baseline="middle">A</text>
<text class="tb" x="30" y="134" dominant-baseline="middle">B</text>
<text class="tb" x="30" y="204" dominant-baseline="middle">C</text>
<rect class="b3" x="130" y="46" width="90" height="28" rx="6"/>
<text class="ts" x="175" y="60" text-anchor="middle" dominant-baseline="middle">a1 [1,0,0]</text>
<rect class="b5" x="330" y="116" width="100" height="28" rx="6"/>
<text class="ts" x="380" y="130" text-anchor="middle" dominant-baseline="middle">b1 [1,1,0]</text>
<rect class="b1" x="180" y="186" width="90" height="28" rx="6"/>
<text class="ts" x="225" y="200" text-anchor="middle" dominant-baseline="middle">c1 [0,0,1]</text>
<rect class="b4" x="520" y="116" width="110" height="28" rx="6"/>
<text class="ts" x="575" y="130" text-anchor="middle" dominant-baseline="middle">b2 [1,2,0]</text>
<rect class="b2" x="520" y="46" width="110" height="28" rx="6"/>
<text class="ts" x="575" y="60" text-anchor="middle" dominant-baseline="middle">a2 [2,0,0]</text>
<line class="l" x1="220" y1="64" x2="330" y2="124" marker-end="url(#arr)"/>
<text class="ta" x="260" y="82">消息携带 [1,0,0]</text>
<rect class="bg" x="20" y="232" width="720" height="86" rx="8"/>
<text class="ts" x="380" y="254" text-anchor="middle">a1 [1,0,0] → b1 [1,1,0]：每个分量 ≤ 且有一个 <，因果先后</text>
<text class="ts" x="380" y="274" text-anchor="middle">b1 [1,1,0] 与 c1 [0,0,1]：互不可比，并发（需要冲突处理：合并、保留多版本、业务裁决）</text>
<text class="ts" x="380" y="294" text-anchor="middle">b2 [1,2,0] 与 a2 [2,0,0]：互不可比，并发；代价：向量长度随参与节点数增长，需要裁剪或用版本向量</text>
</svg>
<figcaption>图 1：向量时钟判定因果先后与并发</figcaption>
</figure>

| 对比 | Lamport 时钟 | 向量时钟 |
| --- | --- | --- |
| 空间 | 一个整数 | N 个整数（N=节点数） |
| 因果判定 | 只能保证单向（因果 ⇒ 数值小） | **完整**：因果先后、并发都能判定 |
| 并发检测 | 不能 | **能** |
| 典型使用 | 全序化事件、乐观版本 | Dynamo 风格存储的**冲突检测**（保留并发版本交给客户端合并）、CRDT 的因果追踪 |
| 工程变体 | — | **版本向量（Version Vector）**：以“副本”为维度而不是“事件/客户端”，更紧凑；Dotted Version Vector 解决同一副本内的并发 |

局限：节点动态增减时向量管理复杂；向量过长占用元数据与带宽，生产中常配合**裁剪**或**按副本而非按客户端**记录。复制与冲突处理见 [复制与一致性](#/distributed/replication)。

## HLC：混合逻辑时钟

**动机**：Lamport/向量时钟是“纯逻辑”的，**和真实时间无关**，不能用来做“最近 1 小时”“按时间范围查询”；物理时钟又不保证因果。HLC 把二者结合：

- 时间戳 = `(l, c)`：`l` 取**物理时间与见过的最大时间中较大者**，`c` 是**逻辑计数**（同一 `l` 内区分先后）；
- 发送/本地事件：取 `pt = 当前物理时间`，`l' = max(l, pt)`；若 `l' == l` 则 `c = c + 1`，否则 `c = 0`；
- 接收消息 `(lm, cm)`：`l' = max(l, lm, pt)`，按三者相等情况调整 `c`；
- **性质**：保证因果一致（a → b 则 HLC(a) < HLC(b)）；`l` **与真实时间的偏差有界**（不超过时钟误差上界），所以**时间戳依然“看起来像时间”**，可用于范围查询、TTL、可读日志；
- **代价与假设**：需要**时钟偏差有上界**（超过则拒绝或告警，如 CockroachDB 的最大偏移配置）；不能像 TrueTime 那样提供外部一致性（真实时间顺序）保证。

实践：CockroachDB、YugabyteDB 等使用 HLC 做 MVCC 时间戳与事务排序，**在不需要原子钟的前提下得到因果一致、接近真实时间的版本号**。

## 全局一致的时间戳：TSO、TrueTime 与 HLC

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="三种获取全局时间戳的方案对比：TSO 由中心服务单调发号，事务开始和提交都向 TSO 申请时间戳，一致性强但依赖中心与网络往返；TrueTime 用原子钟和 GPS 提供带误差区间的时间，事务提交时等待误差区间过去以保证外部一致性；HLC 在每个节点本地生成时间戳，用物理时间加逻辑计数并假设时钟偏差有上界，无中心依赖但保证较弱">
<rect class="b3" x="20" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">TSO（集中授时）</text>
<text class="ts" x="135" y="62" text-anchor="middle">中心服务发单调递增时间戳</text>
<text class="ts" x="135" y="84" text-anchor="middle">代表：Percolator、TiDB(PD)</text>
<text class="ts" x="135" y="112" text-anchor="middle">＋ 实现简单，全局全序</text>
<text class="ts" x="135" y="132" text-anchor="middle">＋ 无需精确时钟</text>
<text class="ts" x="135" y="152" text-anchor="middle">－ 每次事务多一次往返</text>
<text class="ts" x="135" y="172" text-anchor="middle">－ 中心是性能/可用性瓶颈</text>
<text class="ts" x="135" y="192" text-anchor="middle">－ 跨地域延迟高</text>
<rect class="b5" x="270" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">TrueTime + commit-wait</text>
<text class="ts" x="385" y="62" text-anchor="middle">时间 = 区间 [earliest, latest]</text>
<text class="ts" x="385" y="84" text-anchor="middle">代表：Google Spanner</text>
<text class="ts" x="385" y="112" text-anchor="middle">＋ 外部一致性（真实时间序）</text>
<text class="ts" x="385" y="132" text-anchor="middle">＋ 无中心，本地取时间</text>
<text class="ts" x="385" y="152" text-anchor="middle">－ 需要原子钟/GPS 基础设施</text>
<text class="ts" x="385" y="172" text-anchor="middle">－ 提交需“等待误差区间”</text>
<text class="ts" x="385" y="192" text-anchor="middle">　（几毫秒量级的写延迟）</text>
<rect class="b1" x="520" y="14" width="220" height="200" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">HLC（混合逻辑时钟）</text>
<text class="ts" x="630" y="62" text-anchor="middle">物理时间 + 逻辑计数</text>
<text class="ts" x="630" y="84" text-anchor="middle">代表：CockroachDB、YugabyteDB</text>
<text class="ts" x="630" y="112" text-anchor="middle">＋ 无中心，普通硬件可用</text>
<text class="ts" x="630" y="132" text-anchor="middle">＋ 时间戳接近真实时间</text>
<text class="ts" x="630" y="152" text-anchor="middle">－ 依赖最大时钟偏差假设</text>
<text class="ts" x="630" y="172" text-anchor="middle">－ 不保证外部一致性，</text>
<text class="ts" x="630" y="192" text-anchor="middle">　不确定窗口内需重试/等待</text>
<rect class="bg" x="20" y="232" width="720" height="98" rx="8"/>
<text class="th" x="32" y="252">Spanner 的 commit-wait（直觉）</text>
<text class="ts" x="380" y="276" text-anchor="middle">事务选择提交时间戳 s = TT.now().latest；提交后等待到 TT.now().earliest > s 才对外可见</text>
<text class="ts" x="380" y="298" text-anchor="middle">于是任何“之后开始”的事务获得的时间戳必然大于 s ⇒ 时间戳顺序与真实时间顺序一致（外部一致性）</text>
<text class="ts" x="380" y="318" text-anchor="middle">误差区间越小，等待越短；这就是 Spanner 投入原子钟与 GPS 的原因</text>
</svg>
<figcaption>图 2：三种全局时间戳方案对比</figcaption>
</figure>

选择依据：

| 需求 | 倾向 |
| --- | --- |
| 单地域、事务量中等、要简单可靠 | **TSO**（并做好中心的高可用、批量发号、时间戳预分配以降低往返），见 [TiDB 架构](#/db/tidb-arch) |
| 全球分布、要严格外部一致性、愿意投入基础设施 | **TrueTime 类** |
| 想要无中心、可在普通云主机运行的分布式 SQL | **HLC** + 偏移监控 |
| 只需因果一致/冲突检测，不需要全局顺序 | **向量时钟/版本向量** |

## 时间相关的典型 Bug 与对策

| 场景 | 问题 | 对策 |
| --- | --- | --- |
| **分布式 ID（Snowflake）时钟回拨** | 回拨后生成与历史重复或递减的 ID | 检测回拨：小幅（毫秒）等待追平；大幅拒绝服务/切换备用 workerId；持久化最后时间戳；见 [分布式 ID 生成](#/distributed/id) |
| **租约/锁到期判断** | 用墙上时钟，或不同机器时钟差异导致两个持有者 | 用**单调时钟**度量本地剩余时间；租约时长要远大于时钟误差与暂停；**fencing token** 兜底，见 [分布式协调](#/mw/coordination) |
| **缓存/Token 过期时间** | 多机时间不一致，同一令牌在 A 有效在 B 过期 | 过期判断留**容忍窗口**（clock skew leeway，如 JWT 的 `nbf/exp` 允许几十秒偏差）；监控时钟偏移 |
| **按时间戳 LWW 合并** | 时钟快的节点覆盖正确数据 | 用逻辑版本号/向量；必须用 LWW 时用 HLC 并限制偏移；关键数据不要 LWW |
| **定时任务重复/漏执行** | 多机时钟不一致，各自触发 | 单点选主调度 + 幂等，见 [案例：分布式任务调度平台](#/design/case-scheduler) |
| **日志排查顺序错乱** | 跨服务日志按本地时间排序出现因果倒置 | 用 traceId + spanId 的父子关系还原因果，而不是靠时间戳排序，见 [微服务可观测](#/spring/cloud-observability) |
| **限流窗口/超时** | 用墙上时钟，回拨时窗口异常 | 用单调时钟；窗口按相对时间推进 |
| **数据库事务时间戳** | 用 `NOW()` 当版本，多库并发写顺序不确定 | 使用数据库内建的事务版本；跨库不依赖时间排序 |
| **虚拟机暂停后继续执行过期操作** | 进程醒来仍以为锁有效 | 操作前再次校验有效性；资源端做 fencing |

## 工程规则清单

1. **度量时间间隔用单调时钟，记录发生时间用墙上时钟**；
2. **不要用物理时间戳判断跨节点事件先后**；需要排序就用逻辑时钟/版本号/HLC；
3. **任何“依赖时钟偏差小于 X”的设计，把 X 写进设计文档并监控偏移指标**，超出阈值自动降级/摘除；
4. **租约时长 ≫ 最大时钟误差 + 进程暂停时间**，并配合 fencing token；
5. **时间源使用内网/云厂商 NTP，限制时间跳变；容器环境的时间由宿主机负责**；
6. **JWT/证书等时间敏感的校验留出时钟偏差窗口**；
7. **ID 生成器、定时器等必须处理时钟回拨**，并有告警；
8. **复盘时用 traceId 重建因果，不用时间戳排序跨服务日志**。

## 相关阅读

- [CAP、BASE 与一致性模型](#/distributed/theory)：线性一致、顺序一致、因果一致与逻辑时钟入门
- [Raft 与共识算法](#/distributed/consensus)：任期（term）作为逻辑时钟
- [复制与一致性：主从、多主与无主](#/distributed/replication)：冲突检测与向量时钟的应用
- [分布式 ID 生成](#/distributed/id)：Snowflake 与时钟回拨
- [分布式协调：ZooKeeper 与 etcd](#/mw/coordination)：租约、会话与 fencing
- [TiDB 架构与存储](#/db/tidb-arch)：TSO 与分布式事务

## 面试追问

> [!QUESTION] 为什么分布式系统里不能依赖物理时间排序事件？
> 每台机器时钟有漂移，NTP 只能把误差压到毫秒级且可能跳变回拨，所以跨节点的时间戳大小不代表真实先后。用它做 LWW 会让时钟快的节点覆盖正确数据，用它判断租约会出现双持有者，用它做快照版本会读到错误可见性。需要因果判断应使用逻辑时钟、版本号或有误差界的时间。

> [!QUESTION] 墙上时钟和单调时钟有什么区别？超时应该用哪个？
> 墙上时钟表示日历时间，可能被 NTP 跳变或人工修改；单调时钟只保证递增，不会被回拨，但没有绝对含义、跨机器不可比。测量超时、耗时、租约剩余时间应该用单调时钟，用墙上时钟会在回拨时永不超时、前拨时立刻超时。

> [!QUESTION] Lamport 时钟和向量时钟的区别？
> Lamport 时钟用一个整数，保证因果先后对应数值更小，但反过来不成立，不能判断并发；向量时钟每个节点一个分量，能完整判定因果先后和并发，用于 Dynamo 风格存储的冲突检测，代价是向量大小随节点数增长，实践中用版本向量按副本记录。

> [!QUESTION] HLC 是什么？解决什么问题？
> 混合逻辑时钟把物理时间和逻辑计数结合：时间戳取物理时间与见过的最大时间中较大者，同一时间内用逻辑计数区分先后。它保证因果一致，又让时间戳接近真实时间可用于范围查询和 TTL，不需要原子钟，但依赖时钟偏差有上界，不提供外部一致性。CockroachDB 等使用它。

> [!QUESTION] Spanner 的 TrueTime 和 commit-wait 是怎么保证外部一致性的？
> TrueTime 用原子钟和 GPS 返回带误差区间的时间。事务选择区间上界作为提交时间戳，并等待当前时间的下界超过它才对外可见，这样之后开始的事务时间戳一定更大，时间戳顺序与真实时间顺序一致。代价是每次提交要等待几毫秒的误差区间。

> [!QUESTION] TSO 和 HLC 怎么选？
> TSO 由中心服务发单调时间戳，实现简单、全局全序，但每个事务多一次往返，中心是瓶颈和可用性依赖，适合单地域；HLC 无中心、普通硬件即可，但依赖最大偏差假设、不保证外部一致性，适合不想引入中心授时的分布式 SQL。

> [!QUESTION] Snowflake 遇到时钟回拨怎么办？
> 小幅回拨（毫秒级）可短暂等待追平；大幅回拨应拒绝发号或切换到备用 workerId，并告警；持久化最后一次时间戳以防重启后回拨，同时监控时钟偏移并避免 NTP 做大幅跳变。
