---
level: 深入
tags: [Flink SQL, 动态表, Changelog, Join, 反压, 数据倾斜, 调优, Kubernetes]
summary: 讲解 Flink SQL 的动态表与 Changelog 模型、几类 Join（常规、Interval、Temporal、Lookup）及状态代价，反压的成因与诊断、数据倾斜的治理、资源与并行度调优，以及在 Kubernetes 上部署与监控的实践。
---

# Flink SQL、反压与性能调优

> [!ABSTRACT] 核心要点
> - Flink SQL 把流看成**随时间变化的动态表**，查询产生**Changelog 流**（`+I/-U/+U/-D`）；理解 **Changelog 与 Sink 的主键/幂等关系**是写对 SQL 作业的关键。
> - **常规 Join/聚合会无限保留状态**，必须设置 `table.exec.state.ttl`，或改用 **Interval Join、Temporal Join、Lookup Join、窗口**等有界方案。
> - **反压（Backpressure）** 是下游处理慢导致上游被迫降速；诊断思路是**从 Source 往下找第一个“忙”的算子**，常见根因是数据倾斜、外部系统慢、GC、序列化与状态访问。
> - **数据倾斜**用**两阶段聚合（加盐预聚合）**、`MiniBatch`、`Local-Global` 聚合、拆分热点 key 解决。
> - 调优顺序：**先定位瓶颈（Metrics/火焰图）→ 再调并行度、资源、状态后端、Checkpoint**；盲目加并行度常常无效甚至更糟。

## 动态表与 Changelog

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="流转换为动态表，连续查询产生 Changelog 流并写入 Sink">
<rect class="b1" x="20" y="60" width="130" height="90" rx="10"/>
<text class="tb" x="85" y="84" text-anchor="middle" dominant-baseline="middle">输入流</text>
<text class="tm" x="85" y="106" text-anchor="middle">(a,1)(b,2)(a,3)</text>
<text class="ts" x="85" y="128" text-anchor="middle">追加（INSERT only）</text>
<rect class="b3" x="190" y="40" width="160" height="130" rx="10"/>
<text class="tb" x="270" y="62" text-anchor="middle" dominant-baseline="middle">动态表（逻辑视图）</text>
<text class="tm" x="270" y="88" text-anchor="middle">k | cnt</text>
<text class="tm" x="270" y="108" text-anchor="middle">a | 2</text>
<text class="tm" x="270" y="128" text-anchor="middle">b | 1</text>
<text class="ts" x="270" y="154" text-anchor="middle">SELECT k,COUNT(*) GROUP BY k</text>
<rect class="b5" x="390" y="40" width="190" height="130" rx="10"/>
<text class="tb" x="485" y="62" text-anchor="middle" dominant-baseline="middle">Changelog 流</text>
<text class="tm" x="485" y="88" text-anchor="middle">+I (a,1)</text>
<text class="tm" x="485" y="106" text-anchor="middle">+I (b,1)</text>
<text class="tm" x="485" y="124" text-anchor="middle">-U (a,1)  +U (a,2)</text>
<text class="ts" x="485" y="150" text-anchor="middle">结果持续被“更新”</text>
<rect class="b2" x="620" y="60" width="100" height="90" rx="10"/>
<text class="tb" x="670" y="84" text-anchor="middle" dominant-baseline="middle">Sink</text>
<text class="ts" x="670" y="106" text-anchor="middle">需要 upsert</text>
<text class="ts" x="670" y="126" text-anchor="middle">按主键更新</text>
<line class="l" x1="150" y1="105" x2="190" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="105" x2="390" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="105" x2="620" y2="105" marker-end="url(#arr)"/>
<text class="ts" x="370" y="212" text-anchor="middle">Changelog 四种类型：+I 插入 · -U 更新前 · +U 更新后 · -D 删除</text>
<text class="ts" x="370" y="236" text-anchor="middle">只追加的查询（过滤、投影、窗口聚合）输出 Append-only；GROUP BY 无窗口、非时态 Join 会产生更新/回撤</text>
<text class="ts" x="370" y="260" text-anchor="middle">Sink 必须能消费对应类型：upsert-kafka、JDBC 带主键、Doris/ClickHouse 主键表等</text>
</svg>
<figcaption>图 1：流 → 动态表 → 连续查询 → Changelog 流</figcaption>
</figure>

```sql
-- Kafka 源表，声明事件时间与 Watermark
CREATE TABLE orders (
  order_id BIGINT, shop_id INT, amount DECIMAL(12,2), pay_time TIMESTAMP(3),
  WATERMARK FOR pay_time AS pay_time - INTERVAL '5' SECOND            -- 容忍 5 秒乱序
) WITH ('connector'='kafka','topic'='orders','properties.bootstrap.servers'='kafka:9092',
        'properties.group.id'='sql-agg','scan.startup.mode'='group-offsets','format'='json');

-- 窗口聚合：Append-only，窗口结束时输出一次（Window TVF 写法）
INSERT INTO shop_gmv_1min
SELECT window_start, window_end, shop_id, SUM(amount) AS gmv, COUNT(*) AS cnt
FROM TABLE(TUMBLE(TABLE orders, DESCRIPTOR(pay_time), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, shop_id;
```

```sql
-- JDBC Sink 带主键：以 upsert 模式写入，重放/更新幂等
CREATE TABLE shop_gmv_1min (
  window_start TIMESTAMP(3), window_end TIMESTAMP(3), shop_id INT, gmv DECIMAL(18,2), cnt BIGINT,
  PRIMARY KEY (window_start, shop_id) NOT ENFORCED
) WITH ('connector'='jdbc','url'='jdbc:postgresql://pg:5432/dw','table-name'='shop_gmv_1min',
        'username'='...','password'='...','sink.buffer-flush.max-rows'='1000','sink.buffer-flush.interval'='2s');
```

> [!NOTE] 语法版本差异
> 上述窗口使用 **Window TVF** 语法（较新版本推荐）；旧的 `GROUP BY TUMBLE(...)` 仍可用但逐步被取代。连接器参数名、可用性以所用版本和连接器文档为准。

## Join 与状态代价

流上的 Join 需要**把两侧数据缓存在状态中**，Join 类型决定状态是否无限增长：

| Join | 语义 | 状态 | 适用 |
| --- | --- | --- | --- |
| **常规 Join**（Regular） | 任意时间的两条数据只要键相等就关联 | **两侧全量永久保留**（需 TTL） | 小维表 + 小数据；慎用 |
| **Interval Join** | 一侧事件时间落在另一侧的时间区间内 | 只保留区间内数据，**自动清理** | 订单与支付（30 分钟内）、点击与曝光 |
| **Temporal Join（时态 Join）** | 事实流关联**某个时间点**的维表版本 | 仅保留版本表（需 Watermark 驱动清理） | 汇率、商品价格随时间变化 |
| **Lookup Join** | 每条流数据实时去**外部系统**（MySQL/Redis/HBase）查维表 | 无状态（可配缓存） | 维表在外部库，大维表 |
| Window Join | 同一窗口内的两流关联 | 窗口内 | 窗口对齐的场景 |

```sql
-- Interval Join：支付必须在下单后 30 分钟内
SELECT o.order_id, o.amount, p.pay_time
FROM orders o JOIN payments p
  ON o.order_id = p.order_id
 AND p.pay_time BETWEEN o.order_time AND o.order_time + INTERVAL '30' MINUTE;

-- Lookup Join：实时查 MySQL 维表（带缓存）
SELECT o.order_id, u.level
FROM orders AS o
JOIN dim_user FOR SYSTEM_TIME AS OF o.proc_time AS u ON o.user_id = u.id;
```

Lookup Join 注意：外部库**QPS 压力**（开启缓存 `lookup.cache`、异步查询）、**缓存过期与一致性**、维表更新延迟。大维表更推荐 **CDC 维表（把维表也作为流加载到状态）** 或 Temporal Join，见 [CDC 与实时数仓架构](#/bigdata/cdc)。

**状态 TTL**（SQL 作业）：

```sql
SET 'table.exec.state.ttl' = '24 h';        -- 常规 Join/无窗口聚合的状态保留时间；过期后迟到数据可能产生不完整结果，需要业务权衡
```

## SQL 聚合优化

| 配置 | 作用 |
| --- | --- |
| **MiniBatch**（`table.exec.mini-batch.enabled/allow-latency/size`） | 把数据**攒批**再访问状态，降低状态读写次数，**吞吐大幅提升**，代价是延迟增加几秒 |
| **Local-Global 聚合**（`table.optimizer.agg-phase-strategy=TWO_PHASE`） | 先在上游本地预聚合，再全局聚合，**缓解热点 key 倾斜** |
| **Split Distinct**（`table.optimizer.distinct-agg.split.enabled`） | 把 `COUNT(DISTINCT)` 拆成两层，缓解去重倾斜 |
| Filter 子句 | 多个 `COUNT(DISTINCT CASE WHEN...)` 用 `COUNT(DISTINCT x) FILTER (WHERE ...)` 共享状态 |
| **TopN** | `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` 取前 N 要用标准写法才被识别为 TopN 优化 |
| 去重（Deduplication） | `ROW_NUMBER() ... ORDER BY proc_time ASC` 取第一条，状态小 |

```sql
SET 'table.exec.mini-batch.enabled' = 'true';
SET 'table.exec.mini-batch.allow-latency' = '2 s';
SET 'table.exec.mini-batch.size' = '5000';
SET 'table.optimizer.agg-phase-strategy' = 'TWO_PHASE';
```

## 反压（Backpressure）

### 机制

Flink 的网络传输基于**基于信用的流控（Credit-based flow control）**：下游 Task 有有限的接收缓冲（Network Buffer），告知上游“我还有多少空闲 Buffer（信用）”，上游据此发送；**下游处理不过来 → 缓冲耗尽 → 上游发不出去 → 上游被阻塞 → 层层向 Source 传导**，最终 Source 降低拉取速度（如不再消费 Kafka，造成 Lag）。反压是**自我保护机制**，本身不是错误，但持续反压说明**有算子成为瓶颈**。

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="反压诊断：沿数据流找到第一个忙碌的算子，其上游表现为反压">
<rect class="b2" x="20" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="82" text-anchor="middle" dominant-baseline="middle">Source</text>
<text class="ts" x="80" y="104" text-anchor="middle">backPressured</text>
<text class="ts" x="80" y="120" text-anchor="middle">高</text>
<rect class="b2" x="190" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="250" y="82" text-anchor="middle" dominant-baseline="middle">Map</text>
<text class="ts" x="250" y="104" text-anchor="middle">backPressured</text>
<text class="ts" x="250" y="120" text-anchor="middle">高</text>
<rect class="b4" x="360" y="60" width="130" height="70" rx="8"/>
<text class="tb" x="425" y="82" text-anchor="middle" dominant-baseline="middle">KeyBy+聚合</text>
<text class="ts" x="425" y="104" text-anchor="middle">busyTime 接近 100%</text>
<text class="ta" x="425" y="120" text-anchor="middle">← 瓶颈</text>
<rect class="b" x="540" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="600" y="82" text-anchor="middle" dominant-baseline="middle">Sink</text>
<text class="ts" x="600" y="104" text-anchor="middle">idle 高</text>
<text class="ts" x="600" y="120" text-anchor="middle">在等上游</text>
<line class="l" x1="140" y1="95" x2="190" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="95" x2="360" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="95" x2="540" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="370" y="186" text-anchor="middle">规律：被反压的是瓶颈算子的“上游”；瓶颈算子自己忙（busy），它的下游空闲</text>
<text class="ts" x="370" y="210" text-anchor="middle">看指标：backPressuredTimeMsPerSecond（被反压）· busyTimeMsPerSecond（忙）· idleTimeMsPerSecond（空闲）</text>
<text class="ts" x="370" y="234" text-anchor="middle">Web UI 的 BackPressure 页签 / 算子颜色（红=高反压），或 Metrics 系统</text>
</svg>
<figcaption>图 2：沿数据流找到“忙”的算子，它就是瓶颈</figcaption>
</figure>

### 常见根因与对策

| 根因 | 判断 | 对策 |
| --- | --- | --- |
| **数据倾斜** | 某个 SubTask busy 100%，其他很闲；该 SubTask 处理记录数远大于其他 | 加盐两阶段聚合、Local-Global、拆热点 key、调整分区 |
| **外部系统慢**（Sink/Lookup） | 瓶颈在 Sink 或带外部访问的算子；线程栈停在 IO | **批量写入、异步 IO（AsyncIO）、连接池、缓存**；提升外部系统容量；限流 |
| **状态访问慢**（RocksDB） | 状态读写耗时高、磁盘 IO 高 | SSD、增大块缓存/写缓冲、MiniBatch 减少访问、减小状态（TTL）、优化 key 设计 |
| **GC 频繁** | GC 时间占比高、TaskManager 日志 | 调整堆与托管内存、减少对象创建、对象复用、换状态后端 |
| **序列化开销** | CPU 占用高在序列化/Kryo | 使用 POJO/Row 类型避免 Kryo 回退，注册类型，使用高效序列化 |
| **并行度不足** | 所有 SubTask 都忙且 CPU 打满 | 提高瓶颈算子的并行度（而不是全局） |
| **窗口触发集中** | 整点同时触发大量窗口，瞬时压力大 | 错峰、增量聚合、预聚合 |
| **Checkpoint 同步阶段** | Checkpoint 时延迟毛刺 | 增量 Checkpoint、异步快照、拉长间隔 |
| **JVM/节点资源** | CPU/网络/磁盘争抢 | 独占资源、调整 Slot 数、隔离部署 |

## 数据倾斜

**表现**：Web UI 中各 SubTask 的“处理记录数/状态大小/耗时”**极不均衡**；一个 SubTask 拖慢整个作业；Checkpoint 中某算子状态远大于其他。

### 两阶段聚合（加盐）

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="加盐两阶段聚合：先对热点 key 加随机前缀局部聚合，再去掉前缀全局聚合">
<rect class="b4" x="20" y="90" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="112" text-anchor="middle" dominant-baseline="middle">热点 key</text>
<text class="ts" x="80" y="134" text-anchor="middle">k1 占 80% 数据</text>
<rect class="b3" x="190" y="30" width="160" height="40" rx="6"/>
<text class="tm" x="270" y="50" text-anchor="middle" dominant-baseline="middle">k1_0 局部 SUM</text>
<rect class="b3" x="190" y="90" width="160" height="40" rx="6"/>
<text class="tm" x="270" y="110" text-anchor="middle" dominant-baseline="middle">k1_1 局部 SUM</text>
<rect class="b3" x="190" y="150" width="160" height="40" rx="6"/>
<text class="tm" x="270" y="170" text-anchor="middle" dominant-baseline="middle">k1_2 局部 SUM</text>
<rect class="b2" x="420" y="80" width="150" height="60" rx="8"/>
<text class="tb" x="495" y="102" text-anchor="middle" dominant-baseline="middle">去前缀，全局聚合</text>
<text class="ts" x="495" y="122" text-anchor="middle">按 k1 再 SUM（数据量小）</text>
<rect class="b" x="620" y="80" width="100" height="60" rx="8"/>
<text class="tb" x="670" y="110" text-anchor="middle" dominant-baseline="middle">结果</text>
<line class="l" x1="140" y1="125" x2="190" y2="50" marker-end="url(#arr)"/>
<line class="l" x1="140" y1="125" x2="190" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="140" y1="125" x2="190" y2="170" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="50" x2="420" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="110" x2="420" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="170" x2="420" y2="125" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="110" x2="620" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="370" y="226" text-anchor="middle">第一阶段：key 加随机前缀（0~N-1）打散到 N 个子任务并行局部聚合；第二阶段去掉前缀，对少量局部结果汇总</text>
<text class="ts" x="370" y="246" text-anchor="middle">只适用于可分解的聚合（SUM/COUNT/MAX/MIN）；AVG 拆成 SUM 与 COUNT；SQL 可用 Local-Global 自动完成</text>
</svg>
<figcaption>图 3：加盐两阶段聚合缓解热点 key</figcaption>
</figure>

```java
// DataStream：第一阶段加盐
stream.map(e -> Tuple2.of(e.getKey() + "_" + ThreadLocalRandom.current().nextInt(16), e.getValue()))
      .keyBy(t -> t.f0)
      .window(TumblingEventTimeWindows.of(Time.seconds(10))).sum(1)
      // 第二阶段：去盐后全局聚合（带窗口信息）
      .map(t -> Tuple2.of(t.f0.substring(0, t.f0.lastIndexOf('_')), t.f1))
      .keyBy(t -> t.f0)
      .window(TumblingEventTimeWindows.of(Time.seconds(10))).sum(1);
```

其他倾斜场景：

- **Source 倾斜**：Kafka 分区数据不均 → 增加分区或在 Source 后 `rebalance`；
- **Join 倾斜**：热点 key 的一侧用广播/加盐扩容；
- **维度表热点**：Lookup 缓存、对热点 key 本地缓存；
- **空值/默认值 key**（`NULL`、`-1`、`unknown`）造成的倾斜：过滤或随机打散。

## 资源与并行度调优

| 项 | 建议 |
| --- | --- |
| **并行度** | Source 并行度 ≤ Kafka 分区数（多出的空闲）；**每个算子按瓶颈单独调**（`setParallelism`）；全局并行度≈目标吞吐 / 单 SubTask 吞吐 |
| **Slot 数** | `taskmanager.numberOfTaskSlots` 通常 = 每 TM 的 CPU 核数（1~4）；Slot 越多单个 TM 越大、故障影响面越大 |
| **TM 内存** | 总进程内存 = 堆 + **托管内存（RocksDB/排序/批处理）** + 网络内存 + JVM 开销；使用 RocksDB 时给足托管内存（`taskmanager.memory.managed.fraction`） |
| 网络缓冲 | 高并行度/多 Shuffle 时调大 `taskmanager.memory.network.*`；缓冲过大会增加 Checkpoint 数据量与延迟 |
| 算子链 | 默认链化是好的；需要拆开重算子时用 `startNewChain()`/`disableChaining()` 让瓶颈算子独占线程，便于定位 |
| **Slot 共享组** | 把重算子放入独立 `slotSharingGroup` 以隔离资源 |
| 序列化 | 使用 POJO / Row / Avro / Protobuf，避免 Kryo 回退（日志中出现 "Kryo" 即警示） |
| 对象复用 | `env.getConfig().enableObjectReuse()`（要求算子不缓存/修改输入对象），减少拷贝 |
| **异步 IO** | 查外部服务/库用 `AsyncDataStream.unorderedWait`，并发度与超时、容量要设置 |
| Source 限速 | 追赶历史数据时避免压垮下游，设置合理的拉取并发与批量 |

### 重启策略与稳定性

```java
env.setRestartStrategy(RestartStrategies.exponentialDelayRestart(
        Time.seconds(1), Time.minutes(5), 2.0, Time.minutes(10), 0.1));        // 指数退避重启
// 或固定次数：fixedDelayRestart(3, 10s)；失败率策略：failureRateRestart
```

频繁重启通常说明有**持久性错误**（脏数据、下游不可用、OOM），应通过**侧输出收集脏数据**、**死信队列**、**熔断**处理，而不是无限重启。

## 脏数据与容错

```java
OutputTag<String> dirty = new OutputTag<>("dirty") {};
SingleOutputStreamOperator<Order> parsed = raw.process(new ProcessFunction<String, Order>() {
    @Override public void processElement(String v, Context ctx, Collector<Order> out) {
        try { out.collect(JSON.parseObject(v, Order.class)); }
        catch (Exception e) { ctx.output(dirty, v); }                      // 解析失败不让作业崩，转入脏数据侧输出
    }
});
parsed.getSideOutput(dirty).sinkTo(dirtyKafkaSink);                       // 落死信队列，告警并人工处理
```

SQL 中的容错：`format.json.ignore-parse-errors`、`'scan.startup.mode'` 等；对不可信源，**宁可旁路记录也不要让作业因一条坏数据反复失败**。

## 在 Kubernetes 上部署与运维

- **Flink Kubernetes Operator**：通过 `FlinkDeployment` CRD 声明作业，支持 **Application Mode**、升级（带 Savepoint）、自动重启、自动扩缩容（Autoscaler）；
- 镜像：基础 Flink 镜像 + 作业 jar + 所需连接器/依赖；
- **高可用**：用 K8s 原生 HA（ConfigMap 选主）+ 持久化存储保存 Checkpoint/HA 元数据（对象存储）；
- 资源：JM/TM 的 requests/limits 与 Flink 内存配置匹配，避免 **OOMKilled**（容器限制需 ≥ Flink 进程总内存），见 [Kubernetes 核心概念](#/infra/k8s)；
- 日志与指标：日志收集、**Prometheus Reporter** 暴露指标、Grafana 看板、告警。

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata: { name: order-gmv }
spec:
  image: registry.example.com/flink-order-gmv:1.0
  flinkVersion: v1_19
  flinkConfiguration:
    taskmanager.numberOfTaskSlots: "2"
    state.backend: rocksdb
    state.backend.incremental: "true"
    state.checkpoints.dir: s3://bucket/flink/checkpoints
    state.savepoints.dir: s3://bucket/flink/savepoints
    execution.checkpointing.interval: "60s"
    high-availability.type: kubernetes
    high-availability.storageDir: s3://bucket/flink/ha
  jobManager: { resource: { memory: "2048m", cpu: 1 } }
  taskManager: { resource: { memory: "4096m", cpu: 2 } }
  job:
    jarURI: local:///opt/flink/usrlib/order-gmv.jar
    parallelism: 4
    upgradeMode: savepoint          # 升级时先做 Savepoint 再恢复
```

（版本字段与参数以所用 Operator/Flink 版本文档为准。）

### 监控告警清单

| 指标 | 说明与告警 |
| --- | --- |
| **消费延迟（Kafka Lag / `currentEmitEventTimeLag`）** | **最核心的业务指标**：作业是否跟得上 |
| Checkpoint 成功率与耗时 | 连续失败、耗时持续上升 |
| 反压/忙碌度 | 持续高反压 |
| 重启次数（`numRestarts`） | 频繁重启 |
| JVM（堆、GC 时间） | GC 占比过高 |
| 状态大小 | 持续增长趋势（泄漏） |
| Watermark 延迟 | 停滞或落后过多 |
| 吞吐（records in/out per second） | 突降 |
| Sink 失败/重试 | 外部系统异常 |

## 常见问题与排查

| 现象 | 排查与对策 |
| --- | --- |
| 作业延迟越来越大 | 看反压与 busy 算子；Source Lag；数据量增长 → 定位瓶颈后扩容/优化 |
| Checkpoint 超时 | 反压；状态大 → 非对齐、增量、调大超时、减少状态 |
| TM 频繁 OOM / 被 kill | 内存配置与容器限制不一致；RocksDB 托管内存不足；堆外泄漏 |
| 作业无法启动/依赖冲突 | 连接器、Hadoop 依赖版本冲突（用 shade、`provided` scope） |
| 升级后状态恢复失败 | uid 未固定；状态结构变更；Flink 版本不兼容 → 先在测试环境用 Savepoint 演练 |
| SQL 结果重复/回撤异常 | 理解 Changelog；Sink 缺主键；Join/聚合产生更新而 Sink 只支持追加 |
| 追历史数据压垮下游 | 限速、扩容下游、分批追赶 |

## 面试追问

> [!QUESTION] 什么是 Flink 反压？如何排查？
> 下游处理慢导致网络缓冲耗尽，上游被阻塞并向 Source 传导。沿数据流看各算子的反压与忙碌度，第一个忙碌的算子就是瓶颈，其上游表现为被反压。常见根因是数据倾斜、外部系统慢、状态访问慢、GC 和序列化，对症优化而不是盲目加并行度。

> [!QUESTION] 数据倾斜怎么处理？
> 先通过各 SubTask 的处理量与状态大小确认。可加盐做两阶段聚合、SQL 使用 Local-Global 聚合与 Split Distinct、拆分热点 key、广播小表、过滤空值 key；Source 倾斜可 rebalance 或调整分区。

> [!QUESTION] Flink SQL 里的 Changelog 是什么？为什么重要？
> 无窗口聚合、非时态 Join 等会产生更新，Flink 用 +I、-U、+U、-D 表示结果表的变更流。Sink 必须能处理对应类型，通常需要主键并采用 upsert 写入，否则会产生重复或错误。

> [!QUESTION] 常规 Join 有什么问题？有哪些替代？
> 它要永久保留两侧数据的状态，会无限增长。可以设置状态 TTL，或改用有界的 Interval Join、Temporal Join，外部维表用 Lookup Join，窗口场景用 Window Join。

> [!QUESTION] 如何保证 Flink 作业的稳定运行？
> 合理设置 Checkpoint 与重启策略；状态 TTL 防止无限增长；脏数据进侧输出；监控消费延迟、Checkpoint、反压、GC、状态大小；使用 Savepoint 做升级；资源配置与容器限制匹配；对外部系统写入做批量、幂等和限流。
