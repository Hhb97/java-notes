---
level: 深入
tags: [Flink, 流处理, 事件时间, Watermark, 窗口, 乱序, 迟到数据, 并行度]
summary: 讲清 Flink 的运行时架构与数据流模型，以及流处理最核心的难点——时间语义、Watermark 的生成与传播、三类窗口与触发机制、乱序与迟到数据处理，并给出 DataStream 的典型代码与常见坑。
---

# Flink 核心：时间、窗口与 Watermark

> [!ABSTRACT] 核心要点
> - Flink 是**有状态的流处理引擎**，把批处理视为有界流；核心价值是在**乱序、延迟、故障**的现实环境下给出**正确且一致**的计算结果。
> - **事件时间（Event Time）** 按数据自身携带的时间戳计算，结果可复现；**处理时间**按机器时钟，简单但受延迟和重放影响。生产计算以**事件时间**为准。
> - **Watermark** 是“事件时间不会再早于 T”的进度承诺：`Watermark(T)` 到达表示**时间 ≤ T 的数据已基本到齐**，用于触发窗口并容忍乱序；它是**对完整性的估计，不是保证**。
> - 窗口分**滚动 / 滑动 / 会话**；触发 = Watermark 越过窗口结束时间；**允许迟到（allowed lateness）+ 侧输出（side output）** 处理迟到数据，保证不丢。
> - 多并行度时，下游算子的 Watermark = **所有上游输入 Watermark 的最小值**；**空闲分区会卡住 Watermark**，必须配置 `withIdleness`。

## 为什么是 Flink

| 引擎 | 模型 | 延迟 | 状态与一致性 |
| --- | --- | --- | --- |
| MapReduce / Spark 批 | 批处理 | 分钟~小时 | 无状态或批内状态 |
| Spark Streaming / Structured Streaming | 微批（默认）/ 连续处理 | 秒级 | 支持状态，精确一次 |
| **Flink** | **真正的逐条事件流处理** | **毫秒~秒级** | **一等公民的大状态 + Checkpoint + Exactly-Once** |
| Kafka Streams | 库形式，依附 Kafka | 毫秒~秒级 | 本地状态 + changelog |
| Storm | 逐条处理 | 毫秒 | 较弱的一致性保证（早期） |

Flink 的突出优势：**事件时间语义、大状态管理、精确一次、批流统一（SQL）**。典型场景：实时 ETL、实时数仓、实时风控、监控告警、CDC 同步、实时推荐特征，见 [CDC 与实时数仓架构](#/bigdata/cdc)。

## 运行时架构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Flink 运行时：Client 提交作业，JobManager 调度，TaskManager 的 slot 中运行算子链，状态后端与 Checkpoint 存储">
<rect class="b" x="20" y="20" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="45" text-anchor="middle" dominant-baseline="middle">Client</text>
<text class="ts" x="75" y="62" text-anchor="middle">提交作业 JobGraph</text>
<rect class="b3" x="190" y="20" width="250" height="110" rx="12"/>
<text class="th" x="315" y="44" text-anchor="middle">JobManager（Master）</text>
<text class="ts" x="315" y="68" text-anchor="middle">Dispatcher · ResourceManager</text>
<text class="ts" x="315" y="88" text-anchor="middle">JobMaster：调度、Checkpoint 协调、故障恢复</text>
<text class="ts" x="315" y="112" text-anchor="middle">HA：ZooKeeper / K8s 选主</text>
<line class="l" x1="130" y1="45" x2="190" y2="45" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="160" width="720" height="190" rx="12"/>
<text class="th" x="36" y="184">TaskManager（Worker，多个）</text>
<rect class="b1" x="40" y="200" width="320" height="130" rx="10"/>
<text class="tb" x="200" y="222" text-anchor="middle" dominant-baseline="middle">TaskManager 1：2 个 Slot</text>
<rect class="b2" x="56" y="238" width="140" height="78" rx="6"/>
<text class="ts" x="126" y="258" text-anchor="middle">Slot 1（线程）</text>
<text class="tm" x="126" y="280" text-anchor="middle">Source→Map→Filter</text>
<text class="ts" x="126" y="300" text-anchor="middle">算子链</text>
<rect class="b2" x="206" y="238" width="140" height="78" rx="6"/>
<text class="ts" x="276" y="258" text-anchor="middle">Slot 2</text>
<text class="tm" x="276" y="280" text-anchor="middle">keyBy→Window</text>
<text class="ts" x="276" y="300" text-anchor="middle">有状态算子</text>
<rect class="b1" x="400" y="200" width="320" height="130" rx="10"/>
<text class="tb" x="560" y="222" text-anchor="middle" dominant-baseline="middle">TaskManager 2：2 个 Slot</text>
<rect class="b2" x="416" y="238" width="140" height="78" rx="6"/>
<text class="ts" x="486" y="258" text-anchor="middle">Slot 1</text>
<text class="tm" x="486" y="280" text-anchor="middle">keyBy→Window</text>
<rect class="b2" x="566" y="238" width="140" height="78" rx="6"/>
<text class="ts" x="636" y="258" text-anchor="middle">Slot 2</text>
<text class="tm" x="636" y="280" text-anchor="middle">Sink</text>
<line class="l" x1="360" y1="130" x2="200" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="130" x2="560" y2="200" marker-end="url(#arr)"/>
<line class="la" x1="360" y1="270" x2="400" y2="270" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="258" text-anchor="middle">Shuffle</text>
<rect class="b5" x="480" y="20" width="260" height="110" rx="12"/>
<text class="th" x="610" y="44" text-anchor="middle">外部存储</text>
<text class="ts" x="610" y="68" text-anchor="middle">Checkpoint：HDFS / S3 / OSS</text>
<text class="ts" x="610" y="88" text-anchor="middle">Source / Sink：Kafka · DB · ES · 数据湖</text>
<text class="ts" x="610" y="112" text-anchor="middle">状态后端：堆内存 / RocksDB</text>
</svg>
<figcaption>图 1：Flink 运行时：JobManager 调度，TaskManager 的 Slot 执行算子链</figcaption>
</figure>

| 概念 | 说明 |
| --- | --- |
| **JobManager** | 作业的主控：生成执行图、分配 Slot、触发 Checkpoint、故障恢复；可 HA |
| **TaskManager** | 工作进程，有若干 **Slot**（资源切片，一个 Slot 对应一份固定内存，**CPU 不隔离**） |
| **并行度（Parallelism）** | 算子的并行实例数；一个算子 = 多个 SubTask，分布在各 Slot |
| **算子链（Operator Chain）** | 满足条件（同并行度、One-to-One 连接）的相邻算子**合并成一个 Task** 在同一线程执行，省去序列化和网络传输 |
| **Slot Sharing** | 同一作业的不同算子的 SubTask 可共享 Slot，一个 Slot 可持有整条流水线，**作业所需 Slot 数 = 最大并行度** |
| 部署模式 | **Application Mode**（推荐，作业 main 在集群中运行）、Session Mode（共享集群）；资源管理器：**Kubernetes**（常用）、YARN、Standalone |

数据传输方式：**One-to-One**（保持分区，可链化）、**Redistributing**（keyBy 哈希、rebalance、broadcast，需要 Shuffle 网络传输）。

## 数据流编程模型

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
env.setParallelism(4);
env.enableCheckpointing(60_000);                                         // 开启 Checkpoint，见《状态、Checkpoint 与 Exactly-Once》

KafkaSource<String> source = KafkaSource.<String>builder()
        .setBootstrapServers("kafka:9092").setTopics("orders")
        .setGroupId("order-agg")
        .setStartingOffsets(OffsetsInitializer.committedOffsets(OffsetResetStrategy.EARLIEST))
        .setValueOnlyDeserializer(new SimpleStringSchema()).build();

WatermarkStrategy<Order> wm = WatermarkStrategy
        .<Order>forBoundedOutOfOrderness(Duration.ofSeconds(5))          // 容忍 5 秒乱序
        .withTimestampAssigner((o, ts) -> o.getEventTime())              // 从数据中提取事件时间（毫秒）
        .withIdleness(Duration.ofMinutes(1));                            // 空闲分区不阻塞 Watermark

env.fromSource(source, WatermarkStrategy.noWatermarks(), "kafka")
   .map(json -> JSON.parseObject(json, Order.class))
   .assignTimestampsAndWatermarks(wm)
   .keyBy(Order::getShopId)
   .window(TumblingEventTimeWindows.of(Time.minutes(1)))                // 每分钟一个滚动窗口
   .allowedLateness(Time.minutes(1))                                    // 窗口触发后再等 1 分钟接收迟到数据
   .sideOutputLateData(lateTag)                                         // 更迟的数据进侧输出，不丢
   .aggregate(new SumAmount(), new WindowResult())                      // 增量聚合 + 窗口信息包装
   .addSink(...);
env.execute("order-gmv");
```

> [!NOTE] 版本说明
> Flink 1.x 与 2.x 在部分 API（如旧的 `SourceFunction/SinkFunction`、DataSet API）上有移除与调整，上述写法基于较新的 Source/Sink API；具体以所用版本官方文档为准。

## 时间语义

| 时间 | 含义 | 特点 |
| --- | --- | --- |
| **事件时间 Event Time** | 事件在源头**实际发生**的时间（数据里的时间戳） | 结果**确定、可重放复现**；需要 Watermark 处理乱序 |
| **处理时间 Processing Time** | 算子**处理该事件时**机器的系统时间 | 最简单、延迟最低；结果受负载/重启影响，不可复现 |
| 摄入时间 Ingestion Time | 事件进入 Flink 的时间 | 介于两者之间，较少使用 |

为什么要事件时间：**网络延迟、上游重试、Kafka 分区间到达速度不同**会让数据乱序到达；用到达时间统计“每分钟订单数”，一次故障后追赶历史数据（重放）会把几小时的数据挤进同一分钟，**结果完全错误**。

## Watermark

### 它是什么

乱序流中，Flink 无法知道某个窗口的数据是否到齐。**Watermark(T)** 是一条特殊的**进度标记**，随数据流动，含义是：“**此后不会再有事件时间 ≤ T 的数据**”（承诺）。窗口算子看到 `Watermark ≥ 窗口结束时间` 就触发计算。

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="乱序事件流与 Watermark：Watermark 等于已见最大事件时间减去允许的乱序延迟">
<line class="l" x1="30" y1="120" x2="710" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="30" y="150" text-anchor="start">到达顺序 →</text>
<rect class="b2" x="60" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="83" y="113" text-anchor="middle" dominant-baseline="middle">t=3</text>
<rect class="b2" x="120" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="143" y="113" text-anchor="middle" dominant-baseline="middle">t=5</text>
<rect class="b2" x="180" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="203" y="113" text-anchor="middle" dominant-baseline="middle">t=4</text>
<rect class="b3" x="240" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="263" y="113" text-anchor="middle" dominant-baseline="middle">t=9</text>
<rect class="b2" x="300" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="323" y="113" text-anchor="middle" dominant-baseline="middle">t=7</text>
<rect class="b2" x="360" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="383" y="113" text-anchor="middle" dominant-baseline="middle">t=8</text>
<rect class="b4" x="420" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="443" y="113" text-anchor="middle" dominant-baseline="middle">t=2</text>
<rect class="b3" x="480" y="96" width="46" height="34" rx="4"/>
<text class="tm" x="503" y="113" text-anchor="middle" dominant-baseline="middle">t=12</text>
<text class="ts" x="83" y="84" text-anchor="middle">乱序</text>
<line class="la" x1="263" y1="96" x2="263" y2="56" marker-end="url(#arr-a)"/>
<text class="ta" x="263" y="46" text-anchor="middle">W=4</text>
<line class="la" x1="503" y1="96" x2="503" y2="56" marker-end="url(#arr-a)"/>
<text class="ta" x="503" y="46" text-anchor="middle">W=7</text>
<text class="ts" x="263" y="174" text-anchor="middle">已见最大 t=9</text>
<text class="ts" x="263" y="192" text-anchor="middle">W = 9 - 5 = 4</text>
<text class="ts" x="503" y="174" text-anchor="middle">已见最大 t=12</text>
<text class="ts" x="503" y="192" text-anchor="middle">W = 12 - 5 = 7</text>
<text class="ts" x="443" y="154" text-anchor="middle">t=2 在 W=4 之后到达</text>
<text class="ts" x="443" y="172" text-anchor="middle">→ 迟到数据</text>
<text class="ts" x="370" y="236" text-anchor="middle">Watermark = 当前已见最大事件时间 − 允许的乱序延迟（本例 5）；单调不减</text>
<text class="ts" x="370" y="258" text-anchor="middle">窗口 [0,5) 在 Watermark 到达 ≥5 时触发；W=4 时 t=2 尚属“迟到”（窗口 [0,5) 仍未触发则正常入窗）</text>
</svg>
<figcaption>图 2：Watermark 随已见最大事件时间推进，落后它的数据视为迟到</figcaption>
</figure>

### 生成与传播

- **生成**：`forBoundedOutOfOrderness(d)`：`W = 当前最大事件时间 − d − 1ms`（最常用）；`forMonotonousTimestamps()`：事件时间严格递增（`d=0`）；也可自定义（周期性/标点式）；周期默认 **200ms** 发射一次（`pipeline.auto-watermark-interval`）；
- **应在尽量靠近 Source 处生成**（理想是 Kafka Source 内按分区生成），这样能感知分区级别的乱序与空闲；
- **传播规则**：算子有多个输入通道时，其当前 Watermark = **所有输入通道 Watermark 的最小值**；算子处理后向下游广播新的 Watermark。

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="多输入通道的 Watermark 取最小值，空闲分区会拖住整体进度">
<rect class="b1" x="20" y="30" width="150" height="40" rx="6"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">分区 0：W=100</text>
<rect class="b1" x="20" y="90" width="150" height="40" rx="6"/>
<text class="tb" x="95" y="110" text-anchor="middle" dominant-baseline="middle">分区 1：W=95</text>
<rect class="b4" x="20" y="150" width="150" height="40" rx="6"/>
<text class="tb" x="95" y="170" text-anchor="middle" dominant-baseline="middle">分区 2：W=20（空闲）</text>
<rect class="b3" x="300" y="70" width="170" height="90" rx="10"/>
<text class="tb" x="385" y="94" text-anchor="middle" dominant-baseline="middle">下游算子（窗口）</text>
<text class="ts" x="385" y="116" text-anchor="middle">当前 W = min(100, 95, 20)</text>
<text class="ta" x="385" y="138" text-anchor="middle">= 20，进度被卡住！</text>
<line class="l" x1="170" y1="50" x2="300" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="110" x2="300" y2="115" marker-end="url(#arr)"/>
<line class="la" x1="170" y1="170" x2="300" y2="130" marker-end="url(#arr-a)"/>
<rect class="b2" x="520" y="60" width="200" height="110" rx="10"/>
<text class="tb" x="620" y="84" text-anchor="middle" dominant-baseline="middle">解决：withIdleness</text>
<text class="ts" x="620" y="108" text-anchor="middle">分区超过阈值没数据</text>
<text class="ts" x="620" y="128" text-anchor="middle">→ 标记为空闲</text>
<text class="ts" x="620" y="148" text-anchor="middle">→ 不再参与 min 计算</text>
<text class="ts" x="370" y="224" text-anchor="middle">典型现象：Kafka 分区数 &gt; 数据到达的分区数、夜间低峰、某些分区长期无数据 → 窗口迟迟不触发</text>
</svg>
<figcaption>图 3：多输入取最小值，空闲分区会让 Watermark 停滞</figcaption>
</figure>

> [!WARNING] 窗口不触发的头号原因
> 1. 有空闲分区/并行子任务没有数据，Watermark 停滞 → `withIdleness`；2. 使用了事件时间却**没有分配时间戳与 Watermark**；3. 数据的事件时间单位错误（秒 vs 毫秒）；4. 数据时间远超当前时间或乱序延迟设置过大。排查：在 Web UI 的算子 **Watermarks** 页签查看各子任务当前 Watermark。

### 乱序延迟（delay）怎么选

- 太小：大量数据迟到被丢弃/进入侧输出，**结果不完整**；
- 太大：窗口等待时间长，**延迟变高、状态变大**；
- 经验：统计上游数据**实际乱序程度（P99 乱序时间）**，并取一个保证大部分数据按时的值；配合 `allowedLateness` 和侧输出做**兜底修正**。

## 窗口

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="三种窗口：滚动窗口、滑动窗口、会话窗口">
<text class="th" x="20" y="24">滚动窗口 Tumbling（固定大小，不重叠）</text>
<line class="l" x1="20" y1="64" x2="720" y2="64"/>
<rect class="b1" x="20" y="44" width="160" height="30" rx="4"/>
<rect class="b2" x="180" y="44" width="160" height="30" rx="4"/>
<rect class="b3" x="340" y="44" width="160" height="30" rx="4"/>
<rect class="b5" x="500" y="44" width="160" height="30" rx="4"/>
<text class="tm" x="100" y="59" text-anchor="middle" dominant-baseline="middle">[0,10)</text>
<text class="tm" x="260" y="59" text-anchor="middle" dominant-baseline="middle">[10,20)</text>
<text class="tm" x="420" y="59" text-anchor="middle" dominant-baseline="middle">[20,30)</text>
<text class="tm" x="580" y="59" text-anchor="middle" dominant-baseline="middle">[30,40)</text>
<text class="th" x="20" y="116">滑动窗口 Sliding（大小 10，步长 5，重叠）</text>
<rect class="b1" x="20" y="130" width="320" height="24" rx="4"/>
<text class="tm" x="180" y="142" text-anchor="middle" dominant-baseline="middle">[0,10)</text>
<rect class="b2" x="180" y="160" width="320" height="24" rx="4"/>
<text class="tm" x="340" y="172" text-anchor="middle" dominant-baseline="middle">[5,15)</text>
<rect class="b3" x="340" y="190" width="320" height="24" rx="4"/>
<text class="tm" x="500" y="202" text-anchor="middle" dominant-baseline="middle">[10,20)</text>
<text class="ts" x="690" y="172" text-anchor="end">一条数据属于 size/slide 个窗口</text>
<text class="th" x="20" y="250">会话窗口 Session（按“活动间隙 gap”切分）</text>
<rect class="b1" x="20" y="262" width="60" height="30" rx="4"/>
<rect class="b1" x="90" y="262" width="60" height="30" rx="4"/>
<rect class="b1" x="150" y="262" width="60" height="30" rx="4"/>
<text class="ts" x="115" y="310" text-anchor="middle">会话 1</text>
<rect class="bg" x="210" y="262" width="100" height="30" rx="4"/>
<text class="ts" x="260" y="280" text-anchor="middle">间隙 &gt; gap</text>
<rect class="b3" x="310" y="262" width="60" height="30" rx="4"/>
<rect class="b3" x="380" y="262" width="60" height="30" rx="4"/>
<text class="ts" x="375" y="310" text-anchor="middle">会话 2</text>
<rect class="bg" x="440" y="262" width="140" height="30" rx="4"/>
<text class="ts" x="510" y="280" text-anchor="middle">间隙 &gt; gap</text>
<rect class="b5" x="580" y="262" width="60" height="30" rx="4"/>
<text class="ts" x="610" y="310" text-anchor="middle">会话 3</text>
</svg>
<figcaption>图 4：滚动、滑动、会话窗口</figcaption>
</figure>

| 窗口 | 适用 | 注意 |
| --- | --- | --- |
| 滚动 | 每分钟/每小时统计 | 窗口按**时间对齐**（如整分钟），时区需考虑（`Time.days(1, Time.hours(-8))` 对齐北京时间） |
| 滑动 | 最近 5 分钟、每分钟刷新 | 状态与计算量约为滚动的 `size/slide` 倍 |
| 会话 | 用户行为会话、设备连接会话 | 窗口会随新数据**合并**，状态管理更复杂 |
| 全局窗口 + 自定义触发器 | 按条数、自定义规则 | 需自己管理触发与清理 |
| 计数窗口 | 每 N 条 | 少用，状态不过期会泄露 |

### 窗口计算函数

| 函数 | 特点 |
| --- | --- |
| `reduce` / `aggregate` | **增量聚合**：每来一条数据就更新累加器，只存一个累加值，**首选** |
| `process`（ProcessWindowFunction） | **全量**：缓存窗口内所有数据，窗口触发时一次计算；可拿到窗口元信息，内存大 |
| 组合：`aggregate(增量函数, 窗口函数)` | 增量计算结果再交给窗口函数包装（带上窗口起止时间），**兼顾内存与元信息** |

### 触发、迟到与侧输出

```text
窗口 [00:00, 00:01)：
  Watermark ≥ 00:01          → 触发计算，输出结果（第 1 次）
  allowedLateness = 1 分钟    → 窗口状态保留到 Watermark ≥ 00:02
  这期间到达的迟到数据         → 再次触发计算，输出更新后的结果（需下游幂等/按键覆盖）
  Watermark ≥ 00:02 之后到达  → 窗口已清理，数据进入 sideOutputLateData（侧输出）
```

处理迟到数据的三层策略：**Watermark 延迟（主）→ allowedLateness（补）→ 侧输出（兜底，落库后离线修正）**。下游 Sink 必须能处理“同一窗口多次输出”（`upsert`，主键 = 窗口+维度）。

## ProcessFunction 与定时器

窗口不够灵活时，用底层的 `KeyedProcessFunction`：可访问**状态、定时器（事件时间/处理时间）**与侧输出。

```java
public class TimeoutAlert extends KeyedProcessFunction<String, Event, Alert> {
    private ValueState<Long> lastSeen;

    @Override public void open(Configuration c) {
        lastSeen = getRuntimeContext().getState(new ValueStateDescriptor<>("last", Long.class));
    }
    @Override public void processElement(Event e, Context ctx, Collector<Alert> out) throws Exception {
        lastSeen.update(e.getTs());
        ctx.timerService().registerEventTimeTimer(e.getTs() + 60_000);    // 60 秒后检查
    }
    @Override public void onTimer(long ts, OnTimerContext ctx, Collector<Alert> out) throws Exception {
        Long last = lastSeen.value();
        if (last != null && ts >= last + 60_000) out.collect(new Alert(ctx.getCurrentKey(), "设备失联"));   // 60 秒内无新数据
    }
}
```

场景：超时检测、会话超时、状态过期清理、复杂事件模式（也可用 **Flink CEP**）。定时器同样受 Checkpoint 保护，并按 key 去重（同 key 同时间戳的定时器只触发一次）。

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| 窗口不触发 / 结果延迟很大 | 空闲分区使 Watermark 停滞；未分配 Watermark；时间单位错误 → `withIdleness`、检查时间戳 |
| 结果比预期少 | 数据迟到被丢弃 → 增大乱序延迟、`allowedLateness`、侧输出统计迟到量 |
| 窗口状态越来越大 | 用了全量窗口函数、`allowedLateness` 过长、会话窗口 gap 过大 → 增量聚合、缩短保留 |
| 同一窗口输出多次 | `allowedLateness` 的预期行为 → Sink 幂等 upsert |
| 重放历史数据结果不一致 | 使用了处理时间 → 改事件时间 |
| 数据倾斜 | 热点 key 集中在某个 SubTask → 两阶段聚合（加随机前缀预聚合再汇总），见 [Flink SQL、反压与性能调优](#/bigdata/flink-ops) |
| 时区错位（日窗口差 8 小时） | 窗口对齐使用 UTC → 设置窗口 offset |

## 面试追问

> [!QUESTION] 事件时间和处理时间有什么区别？为什么要用事件时间？
> 事件时间是事件实际发生的时间，处理时间是算子处理时的系统时间。数据会因网络延迟、重试而乱序到达，重放历史数据时处理时间会得到错误结果；事件时间配合 Watermark 能得到确定、可复现的结果。

> [!QUESTION] Watermark 是什么？怎么传播？
> Watermark 是事件时间的进度标记，表示小于等于该时间的数据已基本到齐，用于触发窗口和容忍乱序；通常取已见最大事件时间减允许延迟。多输入算子的 Watermark 取各输入通道的最小值，因此空闲分区会拖住进度，需要配置 idleness。

> [!QUESTION] 如何处理迟到数据？
> 三层：Watermark 乱序延迟吸收大部分乱序；allowedLateness 在窗口触发后继续保留状态并更新结果；仍然迟到的数据进入侧输出，单独落库做离线修正。下游需要幂等写入以处理同窗口多次输出。

> [!QUESTION] 窗口为什么不触发？怎么排查？
> 常见是空闲并行子任务使 Watermark 不前进、没分配时间戳和 Watermark、时间戳单位错误。在 Web UI 查看各子任务的 Watermark，配置 withIdleness，检查事件时间提取逻辑。

> [!QUESTION] 增量聚合和全量窗口函数有什么区别？
> 增量聚合每条数据来了就更新累加器，只保存一个聚合值，内存小；全量窗口函数缓存所有数据到触发时才计算，灵活但占内存。推荐增量聚合并与 ProcessWindowFunction 组合获取窗口信息。
