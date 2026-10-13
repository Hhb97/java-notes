---
level: 深入
tags: [Kafka, Kafka Connect, Kafka Streams, Schema Registry, Avro, Protobuf, CDC, 状态存储, 兼容性, 死信队列]
summary: Kafka 生态三件套：Kafka Connect（Source/Sink 连接器、Worker 与 Task、转换器与 SMT、错误处理与死信、分布式部署与运维）、Kafka Streams（流表对偶、拓扑、状态存储与变更日志、窗口、重分区、Exactly-Once、与 Flink 取舍）、Schema Registry（序列化、兼容性规则与演进策略）。
---

# Kafka 生态：Connect、Streams 与 Schema Registry

> [!ABSTRACT] 核心要点
> - 只有 Kafka Broker 不足以搭起数据平台。**数据进出**靠 **Kafka Connect**（声明式配置的连接器，免写生产消费代码），**流式计算**靠 **Kafka Streams**（嵌入应用的轻量库）或 Flink，**数据契约**靠 **Schema Registry**（统一管理消息结构与兼容性）。
> - **Connect**：Source 连接器把外部系统（数据库 CDC、文件、API）写入 Kafka，Sink 连接器把 Kafka 数据写出（数据库、搜索引擎、对象存储、数仓）。要点是**分布式模式部署、位点由 Connect 自己托管、错误要走死信、转换用 SMT、连接器版本与配置要纳入变更管理**。
> - **Kafka Streams**：**一个 Java 库，没有独立集群**，应用实例即计算节点；用**流（KStream）与表（KTable）的对偶**表达聚合、Join、窗口；状态存在本地（RocksDB），并用**变更日志 Topic** 做容错；扩展靠**增加实例（上限为分区数）**。
> - **Schema Registry** 把“消息格式”从代码约定变成**可治理的契约**：消息只带 Schema ID，生产者注册、消费者按需拉取；用**兼容性规则**（向后/向前/完全）约束演进，避免上游改字段把下游打崩。
> - 选型：**简单的数据同步用 Connect，轻量的流处理用 Streams，复杂的大状态、事件时间、SQL 化处理用 Flink**，见 [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core)。

## 整体位置

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="Kafka 生态位置：左侧外部数据源经 Source 连接器写入 Kafka，中间 Kafka 集群含主题，Streams 应用或 Flink 做流处理，右侧经 Sink 连接器写到数据库搜索引擎对象存储数仓；Schema Registry 在生产者消费者与连接器之间提供格式契约">
<rect class="b3" x="20" y="40" width="120" height="150" rx="10"/>
<text class="tb" x="80" y="60" text-anchor="middle" dominant-baseline="middle">数据源</text>
<text class="ts" x="80" y="92" text-anchor="middle">MySQL（CDC）</text>
<text class="ts" x="80" y="114" text-anchor="middle">日志文件</text>
<text class="ts" x="80" y="136" text-anchor="middle">业务服务</text>
<text class="ts" x="80" y="158" text-anchor="middle">SaaS / API</text>
<rect class="b5" x="170" y="80" width="100" height="70" rx="8"/>
<text class="tb" x="220" y="104" text-anchor="middle" dominant-baseline="middle">Source</text>
<text class="ts" x="220" y="126" text-anchor="middle">Connector</text>
<rect class="b1" x="300" y="40" width="160" height="150" rx="10"/>
<text class="tb" x="380" y="60" text-anchor="middle" dominant-baseline="middle">Kafka 集群</text>
<text class="ts" x="380" y="92" text-anchor="middle">原始 Topic</text>
<text class="ts" x="380" y="114" text-anchor="middle">处理后 Topic</text>
<text class="ts" x="380" y="136" text-anchor="middle">变更日志 Topic</text>
<text class="ts" x="380" y="158" text-anchor="middle">死信 Topic</text>
<rect class="b5" x="490" y="80" width="100" height="70" rx="8"/>
<text class="tb" x="540" y="104" text-anchor="middle" dominant-baseline="middle">Sink</text>
<text class="ts" x="540" y="126" text-anchor="middle">Connector</text>
<rect class="b2" x="620" y="40" width="120" height="150" rx="10"/>
<text class="tb" x="680" y="60" text-anchor="middle" dominant-baseline="middle">目的地</text>
<text class="ts" x="680" y="92" text-anchor="middle">ClickHouse/Doris</text>
<text class="ts" x="680" y="114" text-anchor="middle">Elasticsearch</text>
<text class="ts" x="680" y="136" text-anchor="middle">对象存储/数据湖</text>
<text class="ts" x="680" y="158" text-anchor="middle">关系库</text>
<line class="l" x1="140" y1="115" x2="170" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="115" x2="300" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="115" x2="490" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="115" x2="620" y2="115" marker-end="url(#arr)"/>
<rect class="b4" x="300" y="206" width="160" height="40" rx="8"/>
<text class="tb" x="380" y="226" text-anchor="middle" dominant-baseline="middle">Streams / Flink</text>
<line class="l" x1="380" y1="190" x2="380" y2="206" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="256" width="720" height="28" rx="6"/>
<text class="ts" x="380" y="274" text-anchor="middle">Schema Registry：生产者、消费者、连接器、流处理共同遵守的“消息契约”，兼容性规则防止破坏性变更</text>
</svg>
<figcaption>图 1：Connect、Streams 与 Schema Registry 在数据平台中的位置</figcaption>
</figure>

## Kafka Connect

### 架构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Kafka Connect 分布式架构：多个 Worker 组成集群，连接器被拆分成多个 Task 分布在 Worker 上；位点、配置、状态存储在 Kafka 内部 Topic；数据经过转换器与单消息转换后读写 Kafka；失败记录进入死信 Topic">
<rect class="bg" x="20" y="14" width="480" height="180" rx="12"/>
<text class="th" x="260" y="34" text-anchor="middle">Connect 集群（多个 Worker 进程）</text>
<rect class="b3" x="40" y="48" width="140" height="130" rx="8"/>
<text class="tb" x="110" y="66" text-anchor="middle" dominant-baseline="middle">Worker 1</text>
<rect class="b5" x="52" y="80" width="116" height="28" rx="6"/>
<text class="ts" x="110" y="94" text-anchor="middle" dominant-baseline="middle">连接器 A · Task 0</text>
<rect class="b5" x="52" y="114" width="116" height="28" rx="6"/>
<text class="ts" x="110" y="128" text-anchor="middle" dominant-baseline="middle">连接器 A · Task 1</text>
<rect class="b5" x="52" y="148" width="116" height="24" rx="6"/>
<text class="ts" x="110" y="160" text-anchor="middle" dominant-baseline="middle">连接器 B · Task 0</text>
<rect class="b3" x="190" y="48" width="140" height="130" rx="8"/>
<text class="tb" x="260" y="66" text-anchor="middle" dominant-baseline="middle">Worker 2</text>
<rect class="b5" x="202" y="80" width="116" height="28" rx="6"/>
<text class="ts" x="260" y="94" text-anchor="middle" dominant-baseline="middle">连接器 A · Task 2</text>
<rect class="b5" x="202" y="114" width="116" height="28" rx="6"/>
<text class="ts" x="260" y="128" text-anchor="middle" dominant-baseline="middle">连接器 B · Task 1</text>
<rect class="b3" x="340" y="48" width="140" height="130" rx="8"/>
<text class="tb" x="410" y="66" text-anchor="middle" dominant-baseline="middle">Worker 3</text>
<rect class="b5" x="352" y="80" width="116" height="28" rx="6"/>
<text class="ts" x="410" y="94" text-anchor="middle" dominant-baseline="middle">连接器 B · Task 2</text>
<text class="ts" x="410" y="140" text-anchor="middle">Worker 故障时</text>
<text class="ts" x="410" y="158" text-anchor="middle">Task 自动重新分配</text>
<rect class="b1" x="520" y="14" width="220" height="180" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">Kafka 内部 Topic</text>
<text class="ts" x="630" y="64" text-anchor="middle">config：连接器配置</text>
<text class="ts" x="630" y="88" text-anchor="middle">offsets：Source 位点</text>
<text class="ts" x="630" y="112" text-anchor="middle">status：运行状态</text>
<text class="ts" x="630" y="148" text-anchor="middle">集群共享，Worker 无状态</text>
<text class="ts" x="630" y="168" text-anchor="middle">通过 REST API 管理</text>
<rect class="b" x="20" y="210" width="720" height="98" rx="8"/>
<text class="th" x="32" y="230">数据流经处理链</text>
<text class="ts" x="380" y="254" text-anchor="middle">外部系统 → Connector（读取）→ SMT 单消息转换（改字段、路由、脱敏）→ Converter（序列化为 Avro/JSON/Protobuf）→ Kafka</text>
<text class="ts" x="380" y="274" text-anchor="middle">Sink 方向相反：Kafka → Converter（反序列化）→ SMT → Connector（写出）</text>
<text class="ts" x="380" y="294" text-anchor="middle">错误处理：容错策略 + 死信 Topic（保留原始记录与错误原因），避免一条坏数据让任务整体失败</text>
</svg>
<figcaption>图 2：Connect 分布式模式的构件与数据流</figcaption>
</figure>

### 关键概念

| 概念 | 说明 |
| --- | --- |
| **Connector** | 逻辑作业的定义（如“把这几张表同步到 Kafka”），由配置声明 |
| **Task** | 实际并行执行的工作单元；`tasks.max` 控制并行度（受数据源/分区特性限制，如 Sink 并行度不超过 Topic 分区数） |
| **Worker** | 运行连接器与任务的进程；**分布式模式**下多个 Worker 组成集群，自动做任务分配与故障转移；独立模式仅用于开发 |
| **Converter** | 数据序列化格式转换（JSON、Avro、Protobuf、字符串），与 Schema Registry 配合 |
| **SMT（Single Message Transform）** | 对单条消息做轻量变换：加/删/改字段、重命名 Topic、路由、展开 CDC 包装；**不适合复杂业务逻辑与跨消息计算** |
| **位点管理** | Source 连接器的读取进度由 Connect 存到内部 Topic；Sink 的消费位点是普通消费者组位点 |
| **REST API** | 创建、更新、暂停、重启连接器和任务，查看状态 |

### 数据库 CDC（Source）

典型是 Debezium 一类连接器：读取 MySQL binlog / PostgreSQL 逻辑复制，把行变更转换为带 `before/after/op` 的变更事件写入 Kafka（每表一个 Topic）。要点：

- **初始快照 + 增量**：首次先对表做一致性快照，再接增量日志；快照期间会占用连接和读压力，大表要评估窗口；
- **位点与日志保留**：数据库日志（binlog）保留期必须覆盖连接器可能停止的时间，否则位点失效需要重新快照；
- **表结构变更（DDL）**：连接器会记录 Schema 历史；字段变更要配合 Schema Registry 的兼容性策略；
- **删除事件与墓碑**：行删除产生删除事件及墓碑消息，配合压缩 Topic 使用；
- **大事务与主键**：没有主键的表难以保证下游幂等，建议所有同步表有主键；
- 完整的 CDC 与实时数仓架构见 [CDC 与实时数仓架构](#/bigdata/cdc)，MySQL 到 ES 的同步见 [ES 实战与数据同步](#/mw/es-practice)。

### 数据 Sink

| 目标 | 要点 |
| --- | --- |
| **关系库（JDBC Sink）** | 使用 upsert 模式并以主键保证幂等；批量写入大小与事务大小调优；目标表结构演进要同步 |
| **Elasticsearch** | 以文档 ID 做幂等；批量与重试；索引映射提前创建，避免自动映射错乱 |
| **对象存储/数据湖** | 按时间或大小滚动文件；分区目录与小文件问题；格式选 Parquet 等列式，见 [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |
| **ClickHouse/Doris 等** | 以批量写入为主；注意去重语义，见 [ClickHouse 存储与执行](#/bigdata/ck-engine) |

> [!NOTE] 恰好一次的边界
> Sink 的 Exactly-Once 取决于**目标系统是否支持幂等写入或事务**。多数实践是 **at-least-once + 目标端幂等（主键 upsert）**，而不是追求端到端事务。

### 运维与坑

| 问题 | 说明与对策 |
| --- | --- |
| **一条坏数据导致任务失败** | 配置容错（`errors.tolerance=all`）、记录错误上下文、**死信 Topic**，坏数据另行处理；注意容错不等于无视错误，要对死信量告警 |
| **Task 之间不均衡** | 看单 Task 吞吐与 Lag；表/分区数量决定可并行度 |
| **重平衡造成同步抖动** | 连接器与任务重新分配时会短暂停顿；使用协作式再均衡并避免频繁增删连接器 |
| **配置/密钥管理** | 数据库密码不要明文写在连接器配置中，使用配置提供者从密钥系统注入 |
| **版本管理** | 连接器插件版本与 Connect、Kafka 版本的兼容性；升级先在预发验证；连接器配置纳入 Git 与审批 |
| **监控** | 连接器/任务状态、失败重启次数、延迟（源库延迟与 Kafka 延迟）、吞吐、死信量；与 [指标监控](#/infra/obs-metrics) 集成 |
| **资源隔离** | 重型同步（大表快照）与关键链路分集群，避免互相影响 |
| **幂等与顺序** | 同一主键的变更需进入同一分区以保证顺序（按主键作 key） |

## Kafka Streams

### 定位与模型

Kafka Streams 是**嵌入应用的 Java 库**：没有独立的计算集群，应用实例启动就是计算节点，部署、扩缩容、监控都与普通微服务一致。适合**与 Kafka 紧耦合、状态规模中等、不想引入额外集群**的场景（实时聚合、轻量 ETL、事件驱动的微服务内部处理）。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Kafka Streams 拓扑：输入 Topic 经 Source 节点，filter/map 等无状态算子，按 key 分组触发重分区 Topic，聚合算子使用本地状态存储并把变更写入变更日志 Topic，结果流输出到输出 Topic；扩展靠增加应用实例，任务数等于分区数">
<rect class="b3" x="20" y="40" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="62" text-anchor="middle" dominant-baseline="middle">输入 Topic</text>
<text class="ts" x="70" y="82" text-anchor="middle">orders</text>
<rect class="b5" x="150" y="40" width="110" height="56" rx="8"/>
<text class="tb" x="205" y="62" text-anchor="middle" dominant-baseline="middle">无状态算子</text>
<text class="ts" x="205" y="82" text-anchor="middle">filter·map·flatMap</text>
<rect class="b4" x="290" y="40" width="110" height="56" rx="8"/>
<text class="tb" x="345" y="62" text-anchor="middle" dominant-baseline="middle">groupBy(key)</text>
<text class="ts" x="345" y="82" text-anchor="middle">换 key 触发重分区</text>
<rect class="b1" x="430" y="40" width="130" height="56" rx="8"/>
<text class="tb" x="495" y="62" text-anchor="middle" dominant-baseline="middle">有状态聚合</text>
<text class="ts" x="495" y="82" text-anchor="middle">count/窗口/join</text>
<rect class="b2" x="590" y="40" width="150" height="56" rx="8"/>
<text class="tb" x="665" y="62" text-anchor="middle" dominant-baseline="middle">输出 Topic</text>
<text class="ts" x="665" y="82" text-anchor="middle">结果流/变更流</text>
<line class="l" x1="120" y1="68" x2="150" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="68" x2="290" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="68" x2="430" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="68" x2="590" y2="68" marker-end="url(#arr)"/>
<rect class="b" x="290" y="130" width="110" height="44" rx="8"/>
<text class="ts" x="345" y="152" text-anchor="middle" dominant-baseline="middle">重分区 Topic</text>
<line class="ld" x1="345" y1="96" x2="345" y2="130"/>
<rect class="b" x="430" y="130" width="130" height="44" rx="8"/>
<text class="ts" x="495" y="146" text-anchor="middle" dominant-baseline="middle">本地状态存储</text>
<text class="ts" x="495" y="164" text-anchor="middle">RocksDB</text>
<line class="ld" x1="495" y1="96" x2="495" y2="130"/>
<rect class="b" x="430" y="190" width="130" height="44" rx="8"/>
<text class="ts" x="495" y="206" text-anchor="middle" dominant-baseline="middle">变更日志 Topic</text>
<text class="ts" x="495" y="224" text-anchor="middle">状态备份，用于恢复</text>
<line class="l" x1="495" y1="174" x2="495" y2="190" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="250" height="104" rx="8"/>
<text class="th" x="32" y="150">并行与扩展</text>
<text class="ts" x="145" y="174" text-anchor="middle">任务数 = 输入分区数</text>
<text class="ts" x="145" y="194" text-anchor="middle">增加应用实例即可水平扩展</text>
<text class="ts" x="145" y="214" text-anchor="middle">实例数上限 = 任务数</text>
<rect class="bg" x="20" y="252" width="720" height="68" rx="8"/>
<text class="ts" x="380" y="274" text-anchor="middle">故障恢复：实例宕机后任务迁移到其他实例，用变更日志重建本地状态（耗时取决于状态大小）</text>
<text class="ts" x="380" y="294" text-anchor="middle">加速：配置备用副本（standby replicas）让其他实例预热状态，缩短故障转移时间</text>
<text class="ts" x="380" y="312" text-anchor="middle">Exactly-Once：事务把“输出 + 状态变更 + 位点提交”原子提交，保证读-处理-写在 Kafka 内端到端一次</text>
</svg>
<figcaption>图 3：Streams 拓扑、状态存储与扩展方式</figcaption>
</figure>

### 流与表的对偶

| 抽象 | 含义 | 例子 |
| --- | --- | --- |
| **KStream** | 无界的**事件流**，每条记录是独立事件 | 每一次下单、点击 |
| **KTable** | **变更日志流**的物化视图，同一个 key 只保留最新值 | 用户最新资料、商品当前价格 |
| **GlobalKTable** | 在每个实例上**全量复制**的表 | 小而稳定的维表（国家、渠道），Join 时不需要同分区 |
| **聚合** | 流按 key 聚合成表 | 每个用户的订单数 |
| **Join** | 流-流（带窗口）、流-表（用最新值丰富事件）、表-表 | 订单流 Join 用户表补全用户信息 |

**Join 的共同分区要求**：参与 Join 的两个流/表需要**相同的分区数且按相同方式分区**（Join key 相同），否则要先重分区；流-表 Join 用 GlobalKTable 可避免此要求。

### 一个例子

```java
StreamsBuilder b = new StreamsBuilder();

KStream<String, Order> orders = b.stream("orders",
        Consumed.with(Serdes.String(), orderSerde));

// 按用户统计 5 分钟滚动窗口内的下单金额
KTable<Windowed<String>, Long> amount = orders
        .filter((k, o) -> o.status() == Status.PAID)
        .groupBy((k, o) -> o.userId(), Grouped.with(Serdes.String(), orderSerde)) // 换 key → 重分区
        .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5)))
        .aggregate(() -> 0L, (uid, o, agg) -> agg + o.amountCents(),
                Materialized.with(Serdes.String(), Serdes.Long()));

amount.toStream()
      .map((wk, v) -> KeyValue.pair(wk.key(), new UserAmount(wk.key(), wk.window().start(), v)))
      .to("user-amount-5m", Produced.with(Serdes.String(), userAmountSerde));

Properties p = new Properties();
p.put(StreamsConfig.APPLICATION_ID_CONFIG, "user-amount-app");      // 同时是消费者组 ID 与状态目录前缀
p.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);
new KafkaStreams(b.build(), p).start();
```

### 使用要点与坑

| 要点 | 说明 |
| --- | --- |
| **时间语义** | 默认按记录时间戳（事件时间）；乱序数据通过**窗口宽限期（grace）**接收迟到数据；迟到太久的会被丢弃，要监控丢弃指标 |
| **状态大小** | 状态在本地磁盘（RocksDB），状态过大导致重启恢复慢、磁盘压力；设置合适的保留期、使用备用副本、容器要挂持久卷避免每次全量重建 |
| **重分区代价** | `groupBy` 换 key 会写入内部重分区 Topic，增加一次网络与存储；尽量在源头就用目标 key 生产 |
| **内部 Topic 管理** | 变更日志与重分区 Topic 由 Streams 自动创建，命名带 `application.id`；**修改拓扑后内部 Topic 可能不兼容**，需要重置或迁移；生产环境要预创建并控制副本数 |
| **拓扑升级** | 改动算子顺序/名称会改变内部存储名；给算子显式命名以保持兼容 |
| **交互式查询** | 可对本地状态做查询并通过 RPC 暴露，需要自己处理“某 key 在哪个实例”的路由 |
| **背压与吞吐** | 以单线程处理每个任务为基本模型，处理耗时过长要注意 `max.poll.interval.ms` |
| **监控** | 吞吐、处理延迟、任务状态、重平衡次数、状态存储大小、Lag |

### Streams 与 Flink 的取舍

| 维度 | Kafka Streams | Flink |
| --- | --- | --- |
| 部署 | 库，嵌入业务应用，无独立集群 | 独立集群（或托管服务） |
| 数据源 | 仅 Kafka | 多种（Kafka、文件、数据库 CDC 等） |
| 状态与规模 | 本地 RocksDB，规模中等 | 托管状态与增量检查点，**大状态更强** |
| 时间与窗口 | 支持，能力相对简单 | **事件时间、水位线、丰富窗口与复杂事件处理**更强 |
| SQL 能力 | 有限（ksqlDB 等） | Flink SQL 成熟 |
| 一致性 | Kafka 内 Exactly-Once | 与多种 Sink 端到端 Exactly-Once |
| 运维 | 随应用走，简单 | 需要集群治理 |
| 适合 | 微服务内的轻量流处理、事件驱动聚合 | 复杂实时数仓、大状态、多源整合、SQL 化分析 |

详见 [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core) 与 [案例：电商实时数据平台设计详解](#/bigdata/case-realtime)。

## Schema Registry

### 为什么需要

没有约束的 Topic，消息格式靠“口头约定”：上游悄悄改个字段类型，下游消费者批量反序列化失败。Schema Registry 提供：

- **集中存储 Schema**，每个 Subject（通常是“Topic 名-value”）有版本历史；
- 消息格式：**魔数 + Schema ID + 序列化负载**，消息体小（只带 ID，不带完整 Schema）；
- **兼容性检查**：注册新版本时校验是否符合规则，不兼容则拒绝；
- 支持 **Avro、Protobuf、JSON Schema** 等格式，Connect、Streams、客户端均可集成。

### 兼容性规则

| 规则 | 含义 | 允许的典型变更 | 升级顺序 |
| --- | --- | --- | --- |
| **BACKWARD（常用默认）** | 新 Schema 能读旧数据 | 删除字段、**新增带默认值的字段** | 先升级**消费者**，再升级生产者 |
| **FORWARD** | 旧 Schema 能读新数据 | 新增字段、删除带默认值的字段 | 先升级**生产者**，再升级消费者 |
| **FULL** | 同时满足前两者 | 只增删带默认值的可选字段 | 任意顺序 |
| **NONE** | 不检查 | 任意变更 | 风险自担 |
| **TRANSITIVE 版本** | 与**所有历史版本**都兼容而不是仅上一版 | 更严格 | 回放历史数据必须使用 |

**实践建议：**

- 新增字段一律**给默认值**；不要改字段类型和含义，不要重用已删除字段的名称；
- 需要回放历史数据的 Topic，使用 **TRANSITIVE** 的规则；
- 破坏性变更走**新 Topic / 新版本事件类型**，双写迁移，而不是强行改；
- 把 Schema 文件放进代码仓库，**CI 里做兼容性检查**，注册权限收敛到流水线而不是开放给所有开发者；
- Subject 命名策略：按 Topic、按记录类型或二者组合；一个 Topic 承载多种事件类型时选择按记录类型；
- Protobuf 的兼容演进有自己的规则（字段编号不可复用、新增字段可选），见 [gRPC 与 Protobuf：协议、流式调用与治理](#/mw/grpc)。

### 与事件设计的关系

消息 Schema 是**事件契约**：命名、版本、必填字段、业务含义要有文档；事件要携带 `eventId`、`eventTime`、`traceId` 以支持幂等与追踪，设计方法见 [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)。

## 选型小结

| 需求 | 方案 |
| --- | --- |
| 数据库变更同步到下游（搜索、缓存、数仓） | **Connect + CDC 连接器**，下游 Sink 幂等写入 |
| Kafka 数据落到对象存储/数据湖/ClickHouse | **Sink Connector** 或 Flink |
| 微服务内部实时聚合、事件驱动的轻量计算 | **Kafka Streams** |
| 大状态、事件时间复杂、SQL 化的实时数仓 | **Flink** |
| 多团队共享 Topic、防止格式破坏 | **Schema Registry + 兼容性规则 + CI 校验** |
| 一次性、小规模数据导入 | 脚本/批处理即可，不必引入 Connect |

## 相关阅读

- [Kafka 架构与存储](#/mw/kafka)：分区、消费者组与位点
- [Kafka 生产运维](#/mw/kafka-ops)：容量、Rebalance 与故障排查
- [CDC 与实时数仓架构](#/bigdata/cdc)：从数据库到数仓的完整链路
- [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core)：状态、水位线与检查点
- [消息队列平台化与治理](#/mw/mq-governance)：Topic 规范与 Schema 治理

## 面试追问

> [!QUESTION] Kafka Connect 解决什么问题？核心概念有哪些？
> 解决数据在 Kafka 与外部系统间进出的通用集成问题，用配置而不是代码实现。核心概念是 Connector（作业定义）、Task（并行单元）、Worker（运行进程，分布式模式下自动分配与故障转移）、Converter（序列化格式）、SMT（单消息轻量转换），位点、配置、状态存放在 Kafka 内部 Topic。

> [!QUESTION] Connect 同步数据怎么保证不丢不重？
> Source 位点由 Connect 托管，故障后从位点继续，通常是至少一次；Sink 端靠目标系统幂等写入（主键 upsert、文档 ID）保证结果一致，而不是追求端到端事务。坏数据通过容错加死信 Topic 隔离，并对死信量告警；CDC 场景还要保证日志保留期覆盖停机时间。

> [!QUESTION] Kafka Streams 的状态是怎么容错的？怎么扩展？
> 状态存在本地 RocksDB，每次变更同时写入变更日志 Topic；实例故障后任务迁移到其他实例，用变更日志重建状态，可配置备用副本预热以缩短恢复。扩展靠增加应用实例，任务数等于输入分区数，实例数上限由分区数决定。

> [!QUESTION] KStream、KTable 有什么区别？Join 要注意什么？
> KStream 是事件流，每条记录独立；KTable 是按 key 保留最新值的物化视图。Join 要求参与方分区数相同且按 Join key 分区，不满足要先重分区；小维表可用 GlobalKTable 避免共同分区要求；流-流 Join 必须带窗口。

> [!QUESTION] Kafka Streams 和 Flink 怎么选？
> Streams 是嵌入应用的库，无独立集群，仅处理 Kafka，适合微服务内轻量聚合和事件驱动处理；Flink 有独立集群，多数据源、大状态增量检查点、事件时间与水位线、SQL 能力更强，适合复杂实时数仓与大规模状态计算。按状态规模、数据源、时间语义复杂度和团队运维能力选择。

> [!QUESTION] Schema Registry 的兼容性规则怎么选？
> 默认常用 BACKWARD：新 Schema 能读旧数据，允许删字段和新增带默认值的字段，先升级消费者再升级生产者；需要先升级生产者用 FORWARD；对升级顺序没有保证、或要回放全部历史数据时用 FULL 加 TRANSITIVE。关键是新增字段给默认值、不改类型、不复用字段，破坏性变更走新 Topic 或新事件类型，并在 CI 里做兼容性检查。
