---
level: 深入
tags: [OLAP, ClickHouse, MergeTree, Doris, StarRocks, 列式存储, 向量化, 实时写入]
summary: 讲清列式存储与向量化执行为什么适合分析，ClickHouse 的 MergeTree 存储与稀疏索引、分区与合并、常见引擎与使用禁忌，Doris/StarRocks 的 FE/BE 架构、数据模型与导入，以及 OLAP 选型与 Java 接入实践。
---

# OLAP：ClickHouse 与 Doris

> [!ABSTRACT] 核心要点
> - OLAP 面向**大量数据的聚合分析**：宽表、少量列、大范围扫描、很少单行更新。**列式存储 + 压缩 + 向量化执行 + 稀疏索引/排序键** 是核心设计。
> - **ClickHouse**：单机性能极高、MergeTree 家族、**写入要批量**（避免小批量产生大量小 part）、**不擅长高并发点查、事务与频繁更新删除、复杂多表 Join**。
> - **Doris / StarRocks**：MPP 架构（FE 元数据 + BE 存储计算），**MySQL 协议兼容**、Join 与高并发查询更友好、支持主键模型（实时更新）、运维相对简单。
> - 选型关键看**查询模式（宽表聚合 vs 多表关联）、更新需求、并发、团队运维能力**；OLAP 不是 OLTP 的替代品，**事务与强一致更新仍交给 MySQL/PG**。
> - 实时入库的正确姿势：**Flink 攒批（或 Kafka 引擎）+ 批量导入**，主键/去重模型保证幂等，见 [CDC 与实时数仓架构](#/bigdata/cdc)。

## 为什么列式存储适合分析

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="行存与列存对比：分析查询只需要少量列，列存只读取这些列并且同类数据压缩率高">
<text class="th" x="20" y="24">行式存储（OLTP：MySQL）</text>
<rect class="b1" x="20" y="38" width="320" height="30" rx="2"/>
<text class="tm" x="180" y="53" text-anchor="middle" dominant-baseline="middle">[id1|name1|city1|amt1|ts1]</text>
<rect class="b1" x="20" y="72" width="320" height="30" rx="2"/>
<text class="tm" x="180" y="87" text-anchor="middle" dominant-baseline="middle">[id2|name2|city2|amt2|ts2]</text>
<rect class="b1" x="20" y="106" width="320" height="30" rx="2"/>
<text class="tm" x="180" y="121" text-anchor="middle" dominant-baseline="middle">[id3|name3|city3|amt3|ts3]</text>
<text class="ts" x="180" y="158" text-anchor="middle">按行连续存放：取一整行快；</text>
<text class="ts" x="180" y="176" text-anchor="middle">SUM(amt) 却要读出所有列</text>
<text class="th" x="400" y="24">列式存储（OLAP）</text>
<rect class="b" x="400" y="38" width="60" height="98" rx="2"/>
<text class="tm" x="430" y="87" text-anchor="middle" dominant-baseline="middle">id</text>
<rect class="b" x="466" y="38" width="60" height="98" rx="2"/>
<text class="tm" x="496" y="87" text-anchor="middle" dominant-baseline="middle">name</text>
<rect class="b" x="532" y="38" width="60" height="98" rx="2"/>
<text class="tm" x="562" y="87" text-anchor="middle" dominant-baseline="middle">city</text>
<rect class="b3" x="598" y="38" width="60" height="98" rx="2"/>
<text class="tm" x="628" y="87" text-anchor="middle" dominant-baseline="middle">amt</text>
<rect class="b" x="664" y="38" width="56" height="98" rx="2"/>
<text class="tm" x="692" y="87" text-anchor="middle" dominant-baseline="middle">ts</text>
<text class="ta" x="628" y="156" text-anchor="middle">只读 amt 列</text>
<text class="ts" x="560" y="176" text-anchor="middle">每列单独存放：同类型数据连续，</text>
<text class="ts" x="560" y="194" text-anchor="middle">压缩率高（5~10 倍常见）、扫描 IO 少</text>
<rect class="b2" x="20" y="212" width="700" height="72" rx="8"/>
<text class="tb" x="370" y="234" text-anchor="middle" dominant-baseline="middle">列存 + 向量化执行（SIMD）：按“列块”批量计算，而非逐行解释执行，CPU 缓存友好</text>
<text class="ts" x="370" y="256" text-anchor="middle">配合：排序键/稀疏索引裁剪、分区裁剪、物化视图预聚合、MPP 并行扫描 → 亿级行聚合在秒级甚至亚秒级返回</text>
<text class="ts" x="370" y="274" text-anchor="middle">代价：单行写入/更新/删除代价高，不适合事务型负载</text>
</svg>
<figcaption>图 1：列存减少读取量并提升压缩率，向量化加速计算</figcaption>
</figure>

| | OLTP（MySQL/PG） | OLAP（ClickHouse/Doris） |
| --- | --- | --- |
| 负载 | 大量短事务、点查、小范围更新 | 少量复杂分析、大范围扫描聚合 |
| 存储 | 行存、B+ 树索引 | **列存**、稀疏索引/排序键 |
| 写入 | 单行/小批量即时可见 | **批量写入**，后台合并 |
| 更新/删除 | 原地更新，事务 | 代价高，通常异步/合并时生效 |
| 事务 | 完整 ACID | 弱或无 |
| 并发 | 高（万级 QPS） | 中（几十~几千 QPS，视引擎） |

## ClickHouse

### 架构要点

- **单进程、无外部依赖**（元数据可用 ClickHouse Keeper 做复制协调），部署简单，单机吞吐极高；
- **列存 + 向量化 + 并行**：一个查询在单机多核并行，多分片可横向扩展；
- 表引擎决定存储、索引、复制、合并行为，**MergeTree 家族是核心**。

### MergeTree：存储结构

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="ClickHouse MergeTree：数据按批写入为不可变的 part，part 内按排序键排序，稀疏主键索引按 granule 记录，后台合并 part">
<rect class="b" x="20" y="20" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="45" text-anchor="middle" dominant-baseline="middle">INSERT 批次</text>
<rect class="b3" x="170" y="14" width="190" height="62" rx="8"/>
<text class="tb" x="265" y="36" text-anchor="middle" dominant-baseline="middle">写入生成新 Part</text>
<text class="ts" x="265" y="58" text-anchor="middle">按 ORDER BY 排序后落盘</text>
<line class="l" x1="130" y1="45" x2="170" y2="45" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="100" width="720" height="130" rx="10"/>
<text class="th" x="36" y="122">一个 Part 的结构（不可变目录）</text>
<rect class="b1" x="40" y="136" width="170" height="80" rx="6"/>
<text class="tb" x="125" y="156" text-anchor="middle" dominant-baseline="middle">列文件 *.bin</text>
<text class="ts" x="125" y="178" text-anchor="middle">每列独立存储并压缩</text>
<text class="ts" x="125" y="198" text-anchor="middle">按 granule 分块</text>
<rect class="b5" x="230" y="136" width="200" height="80" rx="6"/>
<text class="tb" x="330" y="156" text-anchor="middle" dominant-baseline="middle">primary.idx 稀疏索引</text>
<text class="ts" x="330" y="178" text-anchor="middle">每 8192 行（一个 granule）</text>
<text class="ts" x="330" y="198" text-anchor="middle">记录一个排序键值</text>
<rect class="b2" x="450" y="136" width="130" height="80" rx="6"/>
<text class="tb" x="515" y="156" text-anchor="middle" dominant-baseline="middle">*.mrk 标记文件</text>
<text class="ts" x="515" y="178" text-anchor="middle">granule → 列文件</text>
<text class="ts" x="515" y="198" text-anchor="middle">偏移量</text>
<rect class="b3" x="600" y="136" width="120" height="80" rx="6"/>
<text class="tb" x="660" y="156" text-anchor="middle" dominant-baseline="middle">元数据</text>
<text class="ts" x="660" y="178" text-anchor="middle">分区信息、</text>
<text class="ts" x="660" y="198" text-anchor="middle">校验和、行数</text>
<line class="l" x1="265" y1="76" x2="265" y2="100" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="250" width="720" height="64" rx="8"/>
<text class="tb" x="380" y="272" text-anchor="middle" dominant-baseline="middle">后台 Merge：把多个小 Part 合并成大 Part（同一分区内），合并时执行去重/聚合/TTL 等引擎逻辑</text>
<text class="ts" x="380" y="294" text-anchor="middle">Part 数量过多会拖慢查询并触发 “Too many parts” 错误 → 写入必须批量；更新/删除通过合并或 mutation 异步完成</text>
<line class="ld" x1="380" y1="230" x2="380" y2="250"/>
</svg>
<figcaption>图 2：MergeTree 的 Part 结构与后台合并</figcaption>
</figure>

要点：

- 每次 `INSERT` 生成**一个新的 Part**（不可变），后台线程按策略**合并**；
- Part 内数据**按 `ORDER BY`（排序键）排序**；**稀疏主键索引**每隔 8192 行（`index_granularity`）记录一个键值，通过二分定位 granule，**索引体积极小，可常驻内存**；
- 因为索引稀疏，**点查不是强项**（读一个 granule 约 8192 行），范围/聚合扫描是强项；
- **主键 ≠ 唯一约束**：ClickHouse 的 PRIMARY KEY 只是索引，**不保证唯一**；
- **分区（`PARTITION BY`）**：按时间（月/日）分区，便于**分区裁剪、TTL、数据迁移与删除**（`DROP PARTITION` 极快）；分区粒度太细（比如按小时且多分片）会导致 Part 过多。

```sql
CREATE TABLE events (
    event_date   Date,
    event_time   DateTime,
    user_id      UInt64,
    event_type   LowCardinality(String),         -- 低基数字符串用字典编码，省空间提速
    page         String,
    amount       Decimal(12, 2),
    props        String CODEC(ZSTD(3))
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_type, user_id, event_time)       -- 排序键：把过滤条件常用、基数低的列放前面
TTL event_date + INTERVAL 180 DAY                -- 过期自动删除
SETTINGS index_granularity = 8192;
```

**排序键设计原则**：把**查询过滤最常用**的列放前面；**低基数列在前、高基数列在后**；排序键同时决定压缩率（相近值相邻压缩更好）。

### 常用引擎

| 引擎 | 作用 | 说明 |
| --- | --- | --- |
| **MergeTree** | 基础 | 明细存储 |
| **ReplacingMergeTree** | **按排序键去重**（合并时保留最新版本） | 用于“更新”场景（CDC upsert）；**去重只发生在合并时**，查询需 `FINAL` 或 `argMax`，有性能代价 |
| **SummingMergeTree / AggregatingMergeTree** | 合并时**预聚合** | 配合物化视图做实时汇总 |
| CollapsingMergeTree / VersionedCollapsing | 用符号列抵消行（模拟更新删除） | 复杂，较少用 |
| **Replicated\*MergeTree** | 在以上基础上增加**副本复制**（依赖 Keeper） | 生产高可用 |
| **Distributed** | 分布式表（路由层），不存数据，转发到各分片 | 横向扩展入口 |
| Kafka / MaterializedView | 消费 Kafka，经物化视图写入目标表 | 简易实时接入 |

### 物化视图：实时预聚合

```sql
CREATE TABLE events_agg_1m (
    minute DateTime, event_type LowCardinality(String), cnt UInt64, amt Decimal(18,2)
) ENGINE = SummingMergeTree ORDER BY (event_type, minute);

CREATE MATERIALIZED VIEW mv_events_agg TO events_agg_1m AS
SELECT toStartOfMinute(event_time) AS minute, event_type, count() AS cnt, sum(amount) AS amt
FROM events GROUP BY minute, event_type;        -- 每个写入 events 的批次，实时触发聚合写入 events_agg_1m
```

注意：ClickHouse 的物化视图是**插入触发器**，只处理新增批次，**不会回填历史**，也不感知 `events` 上的更新/删除。

### 分布式与副本

- **分片（Shard）** 横向扩展数据，**副本（Replica）** 做高可用；`Distributed` 表按分片键路由写入、扇出查询；
- 写入建议**直接写本地表**（按分片键客户端分发）或经 `Distributed` 异步转发；
- 多分片 Join 要注意**数据分布**（`GLOBAL JOIN`、colocate）；大表 Join 大表代价高。

### 使用禁忌与优化

| 注意点 | 说明 |
| --- | --- |
| **小批量高频写入** | 每次 INSERT 一个 Part，Part 暴涨 → **每批至少数千~数十万行**，每秒不超过个位数次插入；用 Flink 攒批或 Buffer 表/异步插入（`async_insert`） |
| 频繁 UPDATE/DELETE | `ALTER ... UPDATE/DELETE` 是重量级 mutation（重写 Part）；新版本有轻量删除；设计上用**ReplacingMergeTree + 版本** 或按分区重导 |
| 高并发点查 | 稀疏索引不适合；考虑放 Redis/PG，或用 Doris/StarRocks 的前缀索引 + 点查优化 |
| 多表复杂 Join | 优化器较弱，建议**预先宽表化**（在 Flink 中关联好再写入） |
| 选错数据类型 | 用 `LowCardinality`、合适的整型宽度、`Date` 而不是 `String`；避免 `Nullable`（有额外开销） |
| 查询不带分区/排序键条件 | 全表扫描；确保过滤条件命中分区与排序键前缀 |
| 内存 | 大聚合/排序占内存，设置 `max_memory_usage`、使用外部聚合 |
| 查询并发控制 | `max_concurrent_queries`；避免大查询拖垮集群，使用资源组/配额 |

## Doris / StarRocks

两者同源（Doris 源自百度 Palo，StarRocks 为其分支演进），架构与使用方式高度相似，下面以通用特性描述。

### 架构

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="Doris 架构：FE 负责元数据与查询规划，BE 负责存储与计算，客户端用 MySQL 协议连接 FE">
<rect class="b" x="20" y="120" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="142" text-anchor="middle" dominant-baseline="middle">客户端</text>
<text class="ts" x="80" y="162" text-anchor="middle">MySQL 协议 / JDBC</text>
<rect class="b3" x="190" y="30" width="220" height="130" rx="12"/>
<text class="th" x="300" y="54" text-anchor="middle">FE（Frontend）</text>
<text class="ts" x="300" y="78" text-anchor="middle">元数据管理（库表、分区、tablet）</text>
<text class="ts" x="300" y="98" text-anchor="middle">SQL 解析 · 优化 · 查询规划</text>
<text class="ts" x="300" y="118" text-anchor="middle">Leader/Follower/Observer</text>
<text class="ts" x="300" y="138" text-anchor="middle">BDB JE 同步元数据，高可用</text>
<line class="l" x1="140" y1="150" x2="190" y2="120" marker-end="url(#arr)"/>
<rect class="b2" x="190" y="190" width="520" height="110" rx="12"/>
<text class="th" x="450" y="214" text-anchor="middle">BE（Backend）：存储 + 计算，多节点</text>
<rect class="b1" x="210" y="228" width="150" height="56" rx="6"/>
<text class="tb" x="285" y="248" text-anchor="middle" dominant-baseline="middle">BE 1</text>
<text class="ts" x="285" y="268" text-anchor="middle">Tablet 副本 · 向量化执行</text>
<rect class="b1" x="380" y="228" width="150" height="56" rx="6"/>
<text class="tb" x="455" y="248" text-anchor="middle" dominant-baseline="middle">BE 2</text>
<text class="ts" x="455" y="268" text-anchor="middle">Tablet 副本 · 向量化执行</text>
<rect class="b1" x="550" y="228" width="140" height="56" rx="6"/>
<text class="tb" x="620" y="248" text-anchor="middle" dominant-baseline="middle">BE 3</text>
<text class="ts" x="620" y="268" text-anchor="middle">Tablet 副本</text>
<line class="l" x1="300" y1="160" x2="285" y2="228" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="160" x2="455" y2="228" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="160" x2="620" y2="228" marker-end="url(#arr)"/>
<text class="ts" x="500" y="100" text-anchor="start">MPP：查询计划拆成</text>
<text class="ts" x="500" y="118" text-anchor="start">多个 Fragment，</text>
<text class="ts" x="500" y="136" text-anchor="start">在 BE 间并行执行并交换数据</text>
</svg>
<figcaption>图 3：Doris 的 FE/BE 架构：FE 管元数据与规划，BE 管存储与计算</figcaption>
</figure>

- **FE**：解析 SQL、生成分布式执行计划、管理元数据；多个 FE 保证高可用；
- **BE**：数据存储（**列存**）与计算；数据按**分区 → 分桶 → Tablet**组织，Tablet 多副本；
- **MPP**：查询被拆成多个 Fragment，在多个 BE 上并行执行，节点间 Shuffle 交换数据，对**多表 Join、复杂聚合**支持好；
- **向量化执行引擎** + **CBO 优化器** + **物化视图**自动改写；
- 兼容 **MySQL 协议**：用 MySQL 客户端、JDBC、MyBatis 直接连接，BI 工具对接方便。

### 数据模型

| 模型 | 说明 | 适用 |
| --- | --- | --- |
| **Duplicate（明细）** | 保留所有原始行，不聚合 | 日志、明细分析 |
| **Aggregate（聚合）** | 相同 Key 的 Value 列按聚合函数（SUM/MAX/REPLACE…）合并 | 固定指标的预聚合 |
| **Unique / 主键模型** | 相同主键**保留最新**，支持**实时更新与删除**（Merge-on-Write 写时合并，查询性能好） | **CDC 同步、订单状态更新、维表** |

```sql
CREATE TABLE dws_shop_gmv (
    shop_id     INT,
    biz_date    DATE,
    gmv         DECIMAL(18,2),
    order_cnt   BIGINT
) UNIQUE KEY (shop_id, biz_date)                      -- 主键模型：按主键 upsert
PARTITION BY RANGE (biz_date) ()                      -- 按日期分区（可配置动态分区）
DISTRIBUTED BY HASH (shop_id) BUCKETS 16              -- 分桶：数据打散到 Tablet
PROPERTIES ("replication_num" = "3", "enable_unique_key_merge_on_write" = "true");
```

（建表语法、属性名在 Doris 与 StarRocks、不同版本间略有差异，以对应文档为准。）

**设计要点**：

- **分区**（按时间）用于裁剪与生命周期管理，**分桶**用于并行与均衡；**分桶键**选高基数、常用于过滤/Join 的列；单个 Tablet 大小建议适中（常见几百 MB~几 GB），分桶数过多过少都会影响性能；
- **Colocate Join**：相同分桶方式的表按相同列分布，Join 在本地完成，免 Shuffle；
- **前缀索引、Bloom Filter、倒排索引**用于加速过滤；
- **物化视图（同步/异步）**用于预聚合、加速固定查询。

### 数据导入

| 方式 | 说明 |
| --- | --- |
| **Stream Load** | HTTP 推送批量数据，**同步**返回；支持两阶段提交；Flink Doris Connector 内部使用，**配合 Checkpoint 实现 Exactly-Once** |
| **Routine Load** | 持续消费 Kafka，按批导入 | 
| Broker/Insert from S3/HDFS | 从对象存储/HDFS 批量导入 |
| **Flink Connector** | `doris` / `starrocks` Sink，攒批 + 两阶段提交 |
| CDC 整库同步 | Flink CDC / 官方整库同步工具 |
| `INSERT INTO ... VALUES` | 仅小量测试；不要高频逐条插入 |

```sql
-- Flink SQL 写入 Doris（Exactly-Once 依赖两阶段提交与 label）
CREATE TABLE doris_sink (shop_id INT, biz_date DATE, gmv DECIMAL(18,2), order_cnt BIGINT)
WITH ('connector'='doris','fenodes'='fe:8030','table.identifier'='dw.dws_shop_gmv',
      'username'='etl','password'='******',
      'sink.label-prefix'='gmv_job','sink.enable-2pc'='true','sink.buffer-flush.interval'='5s');
```

## ClickHouse vs Doris / StarRocks

| 维度 | ClickHouse | Doris / StarRocks |
| --- | --- | --- |
| 单表聚合性能 | **极强**，宽表分析标杆 | 很强，接近 |
| **多表 Join** | 较弱，建议宽表化 | **强（MPP + CBO + Colocate/Broadcast/Shuffle Join）** |
| 实时更新/删除 | 弱（ReplacingMergeTree、mutation） | **主键模型实时 upsert/删除，查询可见及时** |
| 高并发点查 | 不擅长 | 较好（前缀索引、点查优化、行存缓存） |
| 并发能力 | 中（几十~几百 QPS 的重查询） | **高（面向报表/看板高并发，几千 QPS）** |
| SQL / 生态 | 自有 SQL 方言（函数丰富） | **MySQL 协议兼容**，BI/JDBC 友好 |
| 运维 | 简单（单进程），但分片/重平衡需手工 | FE/BE 自动均衡副本、弹性扩缩容更省事 |
| 存算架构 | 存算一体为主（也有云版本） | 存算一体 + 存算分离（新版本） |
| 典型场景 | 日志/埋点/用户行为分析、时序明细 | **实时数仓、BI 报表、用户画像、需要更新的业务分析** |

**一般建议**：**以明细日志/埋点分析为主、查询模式固定 → ClickHouse**；**需要实时更新（CDC 同步）、多表关联、高并发看板、希望 MySQL 生态 → Doris/StarRocks**。也不是互斥，很多公司两者并存。

## 与其他方案的关系

| 系统 | 定位 | 说明 |
| --- | --- | --- |
| MySQL/PG | OLTP 主库 | 事务与强一致；PG 配合分区/列存扩展可做轻分析，见 [复制、高可用与实战](#/pg/ops) |
| **Elasticsearch** | 全文检索 + 日志/指标聚合 | 搜索强；大规模聚合成本高，见 [Elasticsearch 原理](#/mw/es) |
| Hive/Spark | **离线**大数据批处理 | 吞吐高、延迟高，见 [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |
| Presto/Trino | 联邦查询（跨数据源、湖上交互查询） | 查询湖仓表，不存数据 |
| 数据湖表格式 | 可更新的湖存储 | 与 OLAP 引擎结合做湖仓一体 |

## Java 接入实践

```java
// Doris / StarRocks：MySQL 协议，直接使用 JDBC + HikariCP
HikariConfig cfg = new HikariConfig();
cfg.setJdbcUrl("jdbc:mysql://fe-host:9030/dw?useSSL=false&rewriteBatchedStatements=true");
cfg.setMaximumPoolSize(20);
// 查询：普通 JDBC / MyBatis；写入：大批量用 Stream Load 或 Flink，不要逐条 INSERT

// ClickHouse：官方 JDBC 驱动（clickhouse-jdbc）或 HTTP 接口
String url = "jdbc:clickhouse://ch-host:8123/default";
// 批量写入：PreparedStatement addBatch，每批 1~10 万行；使用 async_insert 或 Buffer 表缓解小批量
```

| 实践 | 说明 |
| --- | --- |
| 读写分离 | OLAP 做分析查询，业务写入走 OLTP，通过 CDC/Flink 同步，不要让业务直连 OLAP 做事务 |
| 查询超时与并发限制 | 设置查询超时、最大并发、大查询资源隔离（Doris 资源组、ClickHouse 配额），避免一条慢查询拖垮集群 |
| 分页与导出 | 大结果集用游标/分批；避免 `SELECT *` 与深分页 |
| 接口缓存 | 看板类查询加 Redis/本地缓存，削峰，见 [缓存设计与一致性](#/redis/cache) |
| 数据一致性 | 实时写入与离线校正并存，提供“数据截止时间”字段供前端展示 |
| 监控 | 查询耗时 P99、慢查询、Part 数/Compaction（ClickHouse）、Tablet 数与 Compaction Score（Doris）、导入失败/延迟 |

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| ClickHouse `Too many parts` | 小批量高频写入、分区过细 → 增大批量、减少分区、调整 merge 参数 |
| ClickHouse 查询变慢 | 未命中排序键/分区；Part 过多；大 JOIN → 优化排序键、宽表化、预聚合 |
| ReplacingMergeTree 查到重复 | 去重仅在合并时发生 → 查询用 `FINAL`/`argMax`，或定期 `OPTIMIZE`（慎用） |
| Doris 导入 `too many versions` | 导入过于频繁，版本积压（Compaction 跟不上）→ 增大批量、降低频率、调 compaction |
| Doris 查询超时/OOM | 大 Join/聚合 → 设置查询内存与并行度、优化分桶与 Colocate、预聚合 |
| 数据倾斜 | 分桶键选择不当造成部分 Tablet 过大 → 换更均匀的分桶键或组合键 |
| 实时更新读到旧数据 | 非主键模型/Merge-on-Read 合并延迟 → 使用主键模型 MoW，或接受最终一致 |
| 磁盘/副本不均衡 | 节点扩缩容后需要数据均衡 → 使用自动均衡/迁移工具 |

## 面试追问

> [!QUESTION] 为什么列式存储适合 OLAP？
> 分析查询通常只涉及少量列、扫描大量行；列存只读需要的列，减少 IO，同列数据类型一致压缩率高，并且便于向量化批量计算，利用 SIMD 与 CPU 缓存。代价是单行写入和更新开销大。

> [!QUESTION] ClickHouse 的 MergeTree 是怎么工作的？为什么不能小批量写入？
> 每次写入生成一个按排序键排序的不可变 Part，后台把小 Part 合并成大 Part；主键是每 8192 行一条的稀疏索引。小批量高频写入会产生海量 Part，拖慢查询和合并，触发 Too many parts，所以需要批量写入。

> [!QUESTION] ClickHouse 的主键和 MySQL 的主键有什么区别？
> ClickHouse 的主键只是稀疏索引，用于定位数据块，不保证唯一；MySQL 的主键是唯一约束和聚簇索引，用于点查。ClickHouse 要实现去重需要 ReplacingMergeTree 等引擎，且去重只在合并时发生。

> [!QUESTION] Doris 和 ClickHouse 怎么选？
> 以明细日志、固定查询模式的单表宽表分析为主，选 ClickHouse；需要实时更新（CDC 同步）、多表 Join、高并发报表与 MySQL 协议生态，选 Doris 或 StarRocks。也可以同时使用。

> [!QUESTION] 如何把业务库数据实时同步到 OLAP？
> 用 Flink CDC 读取 binlog，在 Flink 内完成清洗与维度关联，攒批后写入 OLAP：Doris 用主键模型加 Stream Load 两阶段提交，ClickHouse 用 ReplacingMergeTree 或按分区覆盖；Sink 保证幂等，并与离线结果对账。
