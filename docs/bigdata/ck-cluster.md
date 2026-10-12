---
level: 高级
tags: [ClickHouse, 集群, 分片, 副本, Keeper, Distributed, 写入, 物化视图, Kafka引擎, 冷热分层, Java]
summary: ClickHouse 的集群与工程实践：分片与副本的拓扑、ReplicatedMergeTree 的复制原理与 ClickHouse Keeper、Distributed 表的写入与查询路径及 GLOBAL JOIN、批量/异步写入与 Kafka 引擎和 Flink 接入、去重与幂等、物化视图实时预聚合、冷热分层与 TTL、查询优化与资源隔离、Java 接入、监控运维与常见坑。
---

# ClickHouse 集群、写入与表设计实战

> [!ABSTRACT] 核心要点
> - **分片（Shard）横向扩展数据与算力，副本（Replica）保证高可用**；两者正交。生产推荐 **2 分片 × 2 副本**起步的思路：**ReplicatedMergeTree + ClickHouse Keeper（协调服务）+ Distributed 表（路由层）**。
> - **复制是“逻辑复制”**：写入到某个副本后，**元数据（日志）记录在 Keeper，其他副本据此从该副本拉取 part**；数据本身不经 Keeper。Keeper 只存元数据，但**它不可用会让副本表变成只读**。
> - **写入的三条铁律**：**批量（数千~数十万行/批）**、**低频（每秒个位数次插入）**、**幂等/去重**（重试可能重复）。小批量用 **async_insert / Buffer / Kafka 引擎**缓冲，或由 **Flink/消费者**攒批。
> - **Distributed 表只是路由层**，不存数据：写入建议**绕开它直接写本地表**（客户端按分片键路由）或通过它异步转发；查询时它把子查询扇出到各分片再合并。**多分片 JOIN 用 GLOBAL 或让数据共置（colocate）**。
> - **物化视图是“插入触发器”**，用于实时预聚合；**冷热分层 + TTL**控制成本；**查询优化靠设计（排序键/分区）+ 预聚合 + 资源隔离**。
> - ClickHouse 不是 OLTP：**业务事务留在 MySQL/PG，通过 CDC/Flink 同步到 ClickHouse 做分析**（见 [CDC 与实时数仓](#/bigdata/cdc)）。

> [!NOTE] 版本说明
> 默认值与新特性随版本变化；托管云版本（ClickHouse Cloud）使用存算分离的 SharedMergeTree，拓扑与运维方式与自建不同。本文以自建开源集群为主，请以所用版本文档为准。存储原理见 [ClickHouse 存储与执行](#/bigdata/ck-engine)。

## 一、集群拓扑

### 1. 分片与副本

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="ClickHouse 集群：客户端请求任一节点上的 Distributed 表；Distributed 表把写入按分片键路由到分片、把查询扇出到每个分片的一个副本再合并；每个分片有两个副本，副本通过 ClickHouse Keeper 协调的日志互相拉取 part；Keeper 由三个节点组成的集群提供，存放复制元数据">
<rect class="b1" x="20" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="55" text-anchor="middle" dominant-baseline="middle">应用 / 查询</text>
<rect class="b3" x="210" y="20" width="220" height="70" rx="10"/>
<text class="tb" x="320" y="44" text-anchor="middle" dominant-baseline="middle">Distributed 表（路由层）</text>
<text class="ts" x="320" y="66" text-anchor="middle">写入路由 · 查询扇出与合并</text>
<line class="l" x1="150" y1="55" x2="210" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="500" y="20" width="280" height="70" rx="10"/>
<text class="tb" x="640" y="44" text-anchor="middle" dominant-baseline="middle">ClickHouse Keeper（3 节点）</text>
<text class="ts" x="640" y="66" text-anchor="middle">复制日志 · 副本状态 · 选主（元数据，不存数据）</text>
<rect class="b2" x="40" y="130" width="330" height="130" rx="12"/>
<text class="th" x="56" y="154">分片 1</text>
<rect class="b" x="56" y="168" width="140" height="76" rx="8"/>
<text class="ts" x="126" y="188" text-anchor="middle">副本 1-1</text>
<text class="ts" x="126" y="208" text-anchor="middle">events_local</text>
<text class="ts" x="126" y="226" text-anchor="middle">ReplicatedMergeTree</text>
<rect class="b" x="214" y="168" width="140" height="76" rx="8"/>
<text class="ts" x="284" y="188" text-anchor="middle">副本 1-2</text>
<text class="ts" x="284" y="208" text-anchor="middle">events_local</text>
<text class="ts" x="284" y="226" text-anchor="middle">ReplicatedMergeTree</text>
<rect class="b2" x="420" y="130" width="330" height="130" rx="12"/>
<text class="th" x="436" y="154">分片 2</text>
<rect class="b" x="436" y="168" width="140" height="76" rx="8"/>
<text class="ts" x="506" y="188" text-anchor="middle">副本 2-1</text>
<text class="ts" x="506" y="208" text-anchor="middle">events_local</text>
<text class="ts" x="506" y="226" text-anchor="middle">ReplicatedMergeTree</text>
<rect class="b" x="594" y="168" width="140" height="76" rx="8"/>
<text class="ts" x="664" y="188" text-anchor="middle">副本 2-2</text>
<text class="ts" x="664" y="208" text-anchor="middle">events_local</text>
<text class="ts" x="664" y="226" text-anchor="middle">ReplicatedMergeTree</text>
<line class="l" x1="260" y1="90" x2="170" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="90" x2="540" y2="130" marker-end="url(#arr)"/>
<line class="la" x1="196" y1="206" x2="214" y2="206" marker-end="url(#arr-a)"/>
<line class="la" x1="576" y1="206" x2="594" y2="206" marker-end="url(#arr-a)"/>
<line class="ld" x1="640" y1="90" x2="640" y2="130"/>
<line class="ld" x1="560" y1="90" x2="284" y2="168"/>
<rect class="bg" x="20" y="280" width="760" height="86" rx="10"/>
<text class="ts" x="36" y="304">• 数据按分片键（如 cityHash64(user_id)）分散到不同分片；同一分片内两个副本数据一致（互相拉取 part）</text>
<text class="ts" x="36" y="324">• 查询：Distributed 表向每个分片的某一副本发子查询（可负载均衡/就近），在发起节点合并结果</text>
<text class="ts" x="36" y="344">• 容错：副本宕机不影响读写（其他副本继续）；分片内所有副本都挂则该分片数据不可用；Keeper 需多数派存活（建议 3 或 5 节点）</text>
<text class="ts" x="36" y="360">• 配置 remote_servers 描述集群拓扑；宏（macros）定义每个节点的 shard / replica 名称，便于统一建表语句</text>
</svg>
<figcaption>图 1：分片、副本、Distributed 表与 Keeper</figcaption>
</figure>

### 2. 建表（本地表 + 分布式表）

```sql
-- 1) 每个节点上的本地表（ON CLUSTER 在所有节点创建）；路径与副本名用宏避免手写
CREATE TABLE db.events_local ON CLUSTER my_cluster (
    event_date  Date,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    amount      Decimal(12, 2)
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/db/events_local', '{replica}')
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_type, toDate(event_time), user_id)
TTL event_date + INTERVAL 180 DAY;

-- 2) 分布式表：路由层，不存数据；分片键决定写入落到哪个分片
CREATE TABLE db.events ON CLUSTER my_cluster AS db.events_local
ENGINE = Distributed(my_cluster, db, events_local, cityHash64(user_id));
```

**分片键选择**：

- **均匀**（避免数据倾斜）：哈希函数 `cityHash64(user_id)`；
- **对查询友好**：常按 user_id 聚合/JOIN → 用它做分片键，同一用户落同一分片，`GROUP BY user_id`、`COUNT(DISTINCT user_id)` 可在分片本地完成（再合并），而不是跨分片全量交换；
- 分片键一旦确定难以更改（重分片代价高，需要数据迁移）。

## 二、复制原理与 Keeper

### 1. 写入如何复制

1. 客户端把一个批次写入**任意一个副本**（通常经负载均衡）；
2. 该副本生成 part，并把“新增 part X”的日志条目写入 **Keeper**；
3. 其他副本监视到日志，**从该副本（或其他已有 part 的副本）拉取 part** 并校验；
4. merge 同理：由某个副本决定合并方案并写日志，其他副本**各自执行相同的合并**（或拉取合并结果）；

### 2. 一致性与写确认

- 默认**异步复制**：INSERT 在**一个副本落盘后即返回**，其他副本稍后追上——副本短时间内可能不一致（读到旧数据）；
- `insert_quorum = N`：要求至少 N 个副本确认写入成功才返回（更强一致，写延迟与可用性代价）；读取时配合 `select_sequential_consistency = 1` 保证读到已确认数据；
- **去重**：对 Replicated 表，ClickHouse 对最近若干个插入块**按内容哈希去重**（`replicated_deduplication_window` 相关设置），**重试同一批相同数据不会重复写入**——这是实现“至少一次 + 幂等”的重要基础（**要求重试时批次内容与顺序完全一致**）；
- 副本落后：`system.replicas` 的 `absolute_delay`、`queue_size`、`inserts_in_queue` 反映积压。

### 3. ClickHouse Keeper

- **兼容 ZooKeeper 协议**的 C++ 实现（基于 Raft，见 [Raft 共识](#/distributed/consensus)），比 ZooKeeper 更省资源、没有 JVM GC 问题，是新部署的首选；
- **只存元数据**：复制日志、副本状态、part 校验和、DDL 队列等；数据量小但**对延迟和可用性敏感**；
- 部署：**3 个节点**（容忍 1 个故障）或 5 个；**独立于数据节点部署**（至少不要和高负载的数据节点争抢磁盘/CPU）；SSD；
- Keeper 故障：副本表**变为只读**（无法写入新数据，查询仍可），恢复后继续；因此要监控 Keeper 并设告警；
- 一个集群的复制表非常多时，Keeper 的 znode 数量与 watch 压力会增大，要控制表/分区数量。

## 三、写入

### 1. 写入原则

| 原则 | 做法 |
| --- | --- |
| **批量** | 每批**数千到数十万行**（官方常建议至少 1000 行，更大更好），每个 INSERT 生成一个 part |
| **低频** | 每秒约 1 次或更少；高并发写入端要**合并**批次（消费者攒批） |
| **避免跨多分区的单批** | 先按分区键分组，否则一批产生很多 part |
| **直接写本地表 vs Distributed** | 写本地表更可控（客户端按分片键路由，批量原子落到一个分片）；写 Distributed 会在本节点先落盘“待发送”文件再异步转发，易积压且有重复/丢失边界情形 |
| **幂等** | 失败重试用**完全相同的批次**（利用块级去重）；或业务侧用 ReplacingMergeTree + 去重键 |
| 压缩传输 | HTTP/原生协议开启压缩，减少带宽 |

### 2. 小批量场景的缓冲手段

| 手段 | 说明 |
| --- | --- |
| **`async_insert = 1`** | 服务端收集多个小 INSERT，攒批后统一写入；`wait_for_async_insert = 1`（默认）等落盘再返回，保证确认语义；缓冲时间与大小可调（`async_insert_busy_timeout_ms`、`async_insert_max_data_size`） |
| **Buffer 表引擎** | 内存缓冲层，定时/阈值刷入目标表；**宕机会丢缓冲数据**，一般不如 async_insert |
| **Kafka 引擎 + 物化视图** | 表引擎直接消费 Kafka，物化视图把数据写入目标 MergeTree；简单，但消费语义、反压与错误处理弱，复杂场景用外部消费者 |
| **Flink / 自研消费者** | 流处理中攒批、去重、宽表化后批量写入（推荐），见 [Flink](#/bigdata/flink-core)、[Kafka](#/mw/kafka) |
| **clickhouse-local / Spark / 对象存储导入** | 离线批量导入 |

```sql
-- Kafka 引擎 + 物化视图 把 Kafka 数据落到 MergeTree（简易接入）
CREATE TABLE events_kafka (user_id UInt64, event_type String, ts DateTime, amount Decimal(12,2))
ENGINE = Kafka SETTINGS kafka_broker_list = 'k1:9092,k2:9092', kafka_topic_list = 'events',
        kafka_group_name = 'ch_events', kafka_format = 'JSONEachRow', kafka_num_consumers = 4;

CREATE MATERIALIZED VIEW events_kafka_mv TO events_local AS
SELECT toDate(ts) AS event_date, ts AS event_time, user_id, event_type, amount FROM events_kafka;
```

> [!WARNING] 这条链路里的“恰好一次”靠不住
> Kafka 引擎在失败重试时可能重复写入；要求精确的场景应在外部消费者里控制位点与批次，并配合 ReplacingMergeTree 或块级去重。

### 3. 更新与 CDC 同步

MySQL/PG 的变更通过 CDC（Debezium/Flink CDC，见 [CDC 与实时数仓](#/bigdata/cdc)）进入 Kafka：

- 目标表用 **ReplacingMergeTree(ver)**，`ver` 用 binlog 位点/更新时间；删除用 `is_deleted` 标记（或写入墓碑版本）；
- 查询用 `FINAL`/`argMax`，或定期在下游物化“最新快照表”；
- 不要把 ClickHouse 当“镜像库”做高频小更新；**宽表化放在 Flink 里做**，写入时已是分析友好的结构。

## 四、物化视图与预聚合

### 1. 增量物化视图

```sql
-- 目标：实时的分钟级汇总（用 SummingMergeTree / AggregatingMergeTree 在合并时汇总）
CREATE TABLE events_1m ON CLUSTER my_cluster (
    minute DateTime, event_type LowCardinality(String),
    cnt UInt64, amount_sum Decimal(18,2), users AggregateFunction(uniq, UInt64)
) ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/db/events_1m', '{replica}')
ORDER BY (event_type, minute);

CREATE MATERIALIZED VIEW events_1m_mv ON CLUSTER my_cluster TO events_1m AS
SELECT toStartOfMinute(event_time) AS minute, event_type,
       count() AS cnt, sum(amount) AS amount_sum, uniqState(user_id) AS users     -- State 函数产出中间聚合状态
FROM events_local GROUP BY minute, event_type;

-- 查询：Merge 函数把状态合并为最终值
SELECT minute, event_type, sum(cnt), sum(amount_sum), uniqMerge(users) FROM events_1m GROUP BY minute, event_type;
```

要点：

- 物化视图是**对每个插入批次的触发器**：只处理**新数据**，**不回填历史**（历史需手动 `INSERT INTO ... SELECT` 回灌），也**不感知源表的更新/删除/DROP PARTITION**；
- **聚合状态类型**（`AggregateFunction`、`-State/-Merge`）支持**可合并的**近似/精确去重等，是实现“分钟表再汇总成小时表”的基础；
- 视图里的 SQL 越重，**写入越慢**（每次 INSERT 同步执行视图），视图出错会让 INSERT 失败；
- **多级汇总**：明细 → 分钟 → 小时 → 天，不同保留期（对应 TTL）；看板按时间跨度选表。

### 2. 可刷新物化视图 / 定时汇总

较新版本提供 Refreshable Materialized View（定时全量/增量刷新，更接近传统“物化”）；也可由调度系统定时 `INSERT INTO ... SELECT` 汇总，适合复杂 JOIN 的维度加工。

## 五、冷热分层与 TTL

```sql
-- storage_policy 在配置里定义卷：hot（NVMe）→ warm（SATA）→ cold（对象存储 S3）
CREATE TABLE events_local (...) ENGINE = ReplicatedMergeTree(...)
ORDER BY (...)
TTL event_date + INTERVAL 7 DAY  TO VOLUME 'warm',
    event_date + INTERVAL 30 DAY TO VOLUME 'cold',
    event_date + INTERVAL 365 DAY DELETE
SETTINGS storage_policy = 'tiered';
```

- **TTL 可作用于行或列**：到期删除、移动到更便宜的卷、对旧数据重压缩（`RECOMPRESS`）、聚合降采样（`TTL ... GROUP BY ... SET ...`）；
- 对象存储（S3）作为冷层：成本低，查询延迟更高；可配合本地缓存；
- TTL 由后台 merge 执行，**不是精确到秒的实时删除**；`ttl_only_drop_parts = 1` 可在整个 part 过期时直接丢弃，更高效。

## 六、查询：分布式执行与 JOIN

### 1. Distributed 查询过程

1. 发起节点收到 `SELECT ... FROM events`（Distributed 表）；
2. 对每个分片选一个副本，下发**改写后的子查询**（在本地表上执行，尽可能完成聚合）；
3. 各分片返回**部分聚合结果**，发起节点合并（并做最终排序/LIMIT）；

要点：聚合类查询通信量小；**`SELECT *` 大结果、`ORDER BY` 全局排序、高基数 `GROUP BY`** 会把大量数据拉到发起节点（内存与网络压力）。

### 2. 分布式 JOIN

| 写法 | 行为 | 适用 |
| --- | --- | --- |
| `JOIN` / `IN` 右侧为 **Distributed 表**（默认） | 每个分片拿着右表去**各分片的右表**子查询，可能**重复扫描右表 N 次**（读放大） | 右表很小才可接受 |
| **`GLOBAL JOIN` / `GLOBAL IN`** | 先在发起节点计算右表结果，**广播到各分片**，再本地 Join | 右表较小（广播代价可控） |
| **Colocate Join**（两表按**相同分片键**分布） | 每个分片只 Join 本地数据，**零网络交换**（`distributed_product_mode = 'local'` 等） | **大表 Join 大表的首选设计** |
| 小维表：**字典（Dictionary）** | 内存哈希字典，`dictGet` 取值，比 Join 快得多 | 维度关联（地区、商品、渠道） |
| 预先宽表化 | 在 Flink/ETL 阶段把维度并进明细 | **最推荐**：ClickHouse 的 Join 优化器较弱 |

```sql
SELECT e.event_type, d.channel_name, count() 
FROM events AS e
GLOBAL INNER JOIN dim_channel AS d ON e.channel_id = d.id      -- 小维表广播；更好的做法：dictGet('dict_channel','name', e.channel_id)
GROUP BY e.event_type, d.channel_name;
```

## 七、查询优化与资源保护

| 方向 | 做法 |
| --- | --- |
| **设计优先** | 排序键/分区命中过滤条件；列裁剪；PREWHERE（见 [存储与执行](#/bigdata/ck-engine)） |
| **预聚合** | 物化视图/Projection/汇总表；看板查汇总而非明细 |
| **近似计算** | `uniq`/`uniqCombined`/`uniqHLL12` 代替 `uniqExact`；`quantileTDigest` 代替精确分位；`SAMPLE` 抽样（见 [行为分析](#/bigdata/ck-analytics)） |
| **减少传输** | 只取必要列；`LIMIT`；避免对超大结果 `ORDER BY` |
| **避免大 Join** | 宽表化、字典、colocate |
| **并发与内存** | `max_threads`、`max_memory_usage`（单查询内存上限）、`max_bytes_before_external_group_by/sort`（超限落盘）、`max_execution_time`、`max_concurrent_queries` |
| **隔离** | 用户/配额/Profile 区分交互看板与离线大查询；`readonly` 账号；`workload`/资源调度（新版本）；必要时拆分读写集群 |
| **查询缓存** | 新版本有 Query Cache；也可在应用层 Redis 缓存看板结果（见 [缓存设计](#/redis/cache)） |

```sql
-- 找最耗时/最耗读的查询
SELECT normalized_query_hash, count() AS n, avg(query_duration_ms) AS avg_ms, sum(read_bytes) AS bytes, any(query) AS q
FROM system.query_log
WHERE type = 'QueryFinish' AND event_date = today()
GROUP BY normalized_query_hash ORDER BY bytes DESC LIMIT 10;
```

## 八、Java 接入

```xml
<dependency>
  <groupId>com.clickhouse</groupId>
  <artifactId>clickhouse-jdbc</artifactId>          <!-- 官方驱动，版本以官方为准；新项目也可评估官方 client-v2 API -->
  <version>${clickhouse.jdbc.version}</version>
</dependency>
```

```java
// 连接串（HTTP 接口，默认 8123；可配置压缩、超时）
String url = "jdbc:ch://ch-lb:8123/db?compress=1&socket_timeout=60000&max_execution_time=30";

// 批量写入：攒批后 addBatch/executeBatch，一次一个批次
String sql = "INSERT INTO db.events_local (event_date, event_time, user_id, event_type, amount) VALUES (?, ?, ?, ?, ?)";
try (Connection c = ds.getConnection(); PreparedStatement ps = c.prepareStatement(sql)) {
    for (Event e : batch) {                               // batch：数千~数十万行，且按分片/分区分好组
        ps.setDate(1, Date.valueOf(e.time().toLocalDate()));
        ps.setTimestamp(2, Timestamp.from(e.time().toInstant(ZoneOffset.UTC)));
        ps.setLong(3, e.userId()); ps.setString(4, e.type()); ps.setBigDecimal(5, e.amount());
        ps.addBatch();
    }
    ps.executeBatch();                                    // 失败重试时重发“完全相同”的批次，利用块级去重
}
```

| 实践 | 说明 |
| --- | --- |
| **不要逐条 `executeUpdate`** | 每条一个 part，必然 `Too many parts` |
| 写入线程/批次隔离 | 业务线程只入队，**独立写入线程**攒批与重试，避免拖慢业务；队列有界 + 背压 |
| 路由 | 多节点连接串或负载均衡；写本地表时按分片键选节点；失败切换副本 |
| 查询 | 连接池（HikariCP）+ 超时 + 只读账号；分页用 `LIMIT … OFFSET` 谨慎，深分页改键集分页；参数化防注入（见 [Web 安全](#/security/web)） |
| 看板接口 | 缓存 + 限流 + 降采样表（见 [限流算法](#/cs/algo-engineering)） |
| 时区 | 服务端/客户端时区不一致会导致 `DateTime` 偏移，统一 UTC，显示层转换 |
| 凭据 | 配置中心/密钥管理，最小权限（见 [加密与密钥管理](#/security/crypto)） |

## 九、监控与运维

| 项 | 关注点 |
| --- | --- |
| **Part 与合并** | `system.parts` 每分区 active part 数；`system.merges` 合并积压；`system.part_log` |
| **复制** | `system.replicas`（`is_readonly`、`absolute_delay`、`queue_size`）、`system.replication_queue`；Keeper 延迟与连接 |
| **查询** | `system.query_log`（耗时/读行数/内存）、`system.processes`（当前执行）、慢查询告警 |
| **资源** | CPU、内存（`MemoryTracking`）、磁盘使用与 IO、网络；`system.metrics`、`system.asynchronous_metrics`、Prometheus 导出（见 [指标监控](#/infra/obs-metrics)） |
| **Mutation** | `system.mutations` 是否卡住 |
| **写入** | 每批大小、写入延迟、失败率、Kafka lag |
| **备份** | `clickhouse-backup`、`BACKUP/RESTORE` 命令、分区冻结（`FREEZE`）+ 对象存储；**副本不是备份**；定期恢复演练 |
| **升级** | 滚动升级（先副本后主，逐个节点），先在预发验证；注意兼容性说明 |
| **扩容** | 加分片：**新数据路由到新分片**，历史数据不会自动均衡，需要重分布脚本/`INSERT SELECT` 迁移或按时间分区迁移；加副本：自动从已有副本拉取数据 |
| **安全** | 用户/角色权限、网络隔离、TLS、禁止默认空密码账号、敏感列脱敏（见 [Web 安全](#/security/web)） |

## 十、常见坑

| 坑 | 对策 |
| --- | --- |
| 小批量高频写入，`Too many parts` | 批量、async_insert、Kafka 引擎/外部消费者攒批、减分区 |
| 写 Distributed 表积压、重启后数据丢失/重复 | 写本地表；或监控 `system.distribution_queue`；理解异步转发语义 |
| 重试批次内容变化，去重失效产生重复 | 保证批次内容与顺序一致；或业务去重（Replacing） |
| 分片键选择不当，数据倾斜或聚合要跨分片 | 哈希均匀；按常用聚合/Join 键；上线前评估 |
| Keeper 部署在数据节点上，抖动导致只读 | 独立部署、SSD、监控 |
| 大表 Join 大表直接上 | 宽表化、colocate、字典、预聚合 |
| 物化视图假设会回填历史/感知删除 | 手动回灌；删除更新要同步处理视图目标表 |
| 把 ClickHouse 当 OLTP/高频点查 | 业务库+缓存负责在线读写，ClickHouse 做分析 |
| 扩分片后以为数据自动均衡 | 规划重分布方案 |
| 没有查询资源限制，一个大查询拖垮集群 | quota/profile、max_memory_usage、max_execution_time、隔离看板与离线 |
| 备份只靠副本 | 定期备份到对象存储并演练恢复 |
| 时区与 DateTime 混乱 | 统一 UTC，必要时 DateTime64 带时区 |

## 面试追问

> [!QUESTION] ClickHouse 集群怎么做高可用？复制是怎么实现的？
> 用分片扩展、副本容错。ReplicatedMergeTree 在写入一个副本后把复制日志写入 Keeper，其他副本据此从该副本拉取 part，合并也由日志驱动，数据本身不经 Keeper。默认异步复制，需要更强确认可用 insert_quorum。Keeper 基于 Raft，建议三节点独立部署，故障时复制表变只读。

> [!QUESTION] Distributed 表是什么？写入和查询怎么走？
> 它是路由层，不存数据。写入时按分片键把数据发到对应分片，默认先落本地待发送文件再异步转发，生产更推荐客户端直接写本地表。查询时向每个分片的一个副本下发子查询，各分片先局部聚合，再在发起节点合并结果。

> [!QUESTION] ClickHouse 里大表 Join 怎么优化？
> 优先在上游宽表化，把维度并进明细；小维表用字典替代 Join；两张大表按相同分片键分布做 colocate join 避免网络交换；右表较小时用 GLOBAL JOIN 广播；并尽量先过滤和聚合再 Join。默认对 Distributed 右表的 Join 会造成重复扫描，要避免。

> [!QUESTION] 如何保证写入 ClickHouse 不重不丢？
> 写入端批量重试，对 Replicated 表利用块级哈希去重，要求重试的批次内容与顺序完全一致；消费端控制位点与批次边界实现至少一次，再配合 ReplacingMergeTree 加去重键在查询或合并时去重。Kafka 引擎的重试语义较弱，精确场景用外部消费者或 Flink。

> [!QUESTION] 物化视图的原理和局限？
> 它是插入触发器，每个写入批次触发视图查询并把结果写入目标表，用于实时预聚合，配合 AggregatingMergeTree 和 State、Merge 函数实现可合并的聚合。局限是不回填历史、不感知源表更新删除、视图越重写入越慢，且出错会导致插入失败。

> [!QUESTION] 如何做 ClickHouse 的冷热分层和数据生命周期管理？
> 配置存储策略定义 NVMe、SATA、对象存储等卷，用 TTL 按时间把数据移动到更便宜的卷并最终删除，也可对旧数据重压缩或降采样；TTL 由后台合并执行不是实时，整个 part 过期时可直接丢弃。配合按时间分区，DROP PARTITION 是最高效的清理方式。

> [!QUESTION] 扩容 ClickHouse 集群要注意什么？
> 加副本会自动拉取已有数据；加分片只让新写入路由到新分片，历史数据不会自动均衡，需要规划重分布，如按时间分区迁移或 INSERT SELECT。分片键一旦确定更改代价很大，因此上线前要评估数据分布与常用聚合、Join 键。
