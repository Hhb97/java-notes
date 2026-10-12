---
level: 进阶
tags: [MongoDB, 文档数据库, BSON, WiredTiger, 数据建模, 索引, ESR, 聚合管道, Spring Data MongoDB]
summary: MongoDB 的数据模型与查询优化：何时选文档库、BSON 与存储引擎 WiredTiger、嵌入与引用的建模取舍及常用模式（子集/桶/扩展引用）、索引类型与复合索引 ESR 规则、explain 分析、聚合管道、分页与批量写、Java 访问示例，以及无限增长数组、大文档、深分页等常见坑。
---

# MongoDB 数据模型、索引与聚合

> [!ABSTRACT] 核心要点
> - MongoDB 是**文档数据库**：数据以 **BSON 文档**存储，**模式灵活**、天然贴合对象结构，适合**结构多变、层次嵌套、读多以“聚合对象”为单位**的场景（内容/商品目录/用户画像/日志事件/IoT 数据）。**强关系、多表复杂事务、复杂联表分析**仍是关系型数据库的主场。
> - **建模的核心决策：嵌入还是引用**。按“**一起读、一起改、数量有界**”的原则嵌入，按“**独立生命周期、多对多、无限增长**”的原则引用；**为查询模式而设计，而不是为实体关系而设计**。
> - 索引是性能关键：**复合索引遵循 ESR 规则（等值 Equality → 排序 Sort → 范围 Range）**；用 `explain("executionStats")` 看 `totalDocsExamined / nReturned`，避免 `COLLSCAN`。
> - **聚合管道**（`$match → $group → $sort → …`）是 MongoDB 的分析与报表能力：尽早 `$match`/`$project` 减少数据，注意 `$lookup` 的代价与 100MB 阶段内存限制（`allowDiskUse`）。
> - 常见坑：**数组无限增长**、文档过大（16MB 上限）、`skip` 深分页、缺失索引、过多索引拖慢写、把 MongoDB 当关系库用（大量 `$lookup`）。

> [!NOTE] 版本说明
> 本文基于较新的 MongoDB 版本（6.x/7.x 的通用特性）；个别默认值和功能随版本变化，请以所用版本的官方文档为准。复制集与分片见 [复制集、分片与事务](#/db/mongo-cluster)。

## 一、什么时候选 MongoDB

| 适合 | 不适合 / 谨慎 |
| --- | --- |
| 结构多变、字段异构（商品属性、表单、配置、CMS 内容） | 强事务、多表复杂关联、严格的关系约束（金融核心账务，优先 MySQL/PG，见 [MySQL](#/mysql/architecture)、[PostgreSQL](#/pg/architecture)） |
| 读写以“一个聚合对象”为单位（订单快照、用户档案、文章+评论） | 需要大量跨集合 JOIN 的复杂报表（用 OLAP，见 [OLAP](#/bigdata/olap)） |
| 高写入、海量半结构化数据（日志、事件、IoT 时序，见 [IoT 平台](#/iot/platform)） | 数据极小、团队只熟 SQL 且无灵活性需求（关系库更省心） |
| 需要水平扩展（自带分片）与多文档类型共存 | 强一致、低延迟的缓存/计数（用 Redis，见 [Redis](#/redis/overview)） |

对比一句话：**关系库先建模数据、再回答问题（范式化）；MongoDB 先看要回答什么问题、再决定怎么存（反范式化）。**

## 二、基本概念与存储

### 1. 概念映射

| 关系库 | MongoDB |
| --- | --- |
| 数据库 / 表 / 行 / 列 | 数据库 / **集合 Collection** / **文档 Document** / 字段 |
| 主键 | `_id`（默认 **ObjectId**：12 字节，含时间戳、随机数、计数器，大致按时间递增） |
| JOIN | 嵌入 / `$lookup` |
| 索引 | 索引（B 树） |
| 事务 | 多文档事务（4.0+ 复制集、4.2+ 分片集群） |

### 2. BSON

BSON 是 JSON 的**二进制扩展**：增加了 `Date`、`ObjectId`、`Decimal128`（**金额请用 Decimal128 或整数分，不要用 double**）、`Binary`、`Int64` 等类型，并带有长度前缀便于快速遍历。**单文档最大 16MB**，嵌套深度有限制。

```javascript
{
  _id: ObjectId("66f0a1b2c3d4e5f607182930"),
  orderNo: "O20261012000123",
  userId: NumberLong(10086),
  status: "PAID",
  amount: NumberDecimal("199.00"),
  items: [ { skuId: 1, name: "键盘", qty: 1, priceFen: 19900 } ],     // 嵌入数组
  shipTo: { province: "广东", city: "深圳", detail: "…" },             // 嵌入对象
  createdAt: ISODate("2026-10-12T08:30:15.123Z")
}
```

### 3. 存储引擎 WiredTiger（默认）

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="WiredTiger 存储结构：写请求先更新内存中的缓存，同时写入 journal 预写日志；每隔一段时间做 checkpoint 把一致性快照写入数据文件；读取优先命中 WiredTiger 内部缓存，其次是操作系统文件系统缓存；文档级并发控制和 MVCC 快照；数据和索引默认用 snappy 压缩">
<rect class="b1" x="20" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="58" text-anchor="middle" dominant-baseline="middle">写请求</text>
<rect class="b3" x="210" y="20" width="230" height="76" rx="10"/>
<text class="th" x="226" y="44">WiredTiger 缓存</text>
<text class="ts" x="226" y="66">默认 ≈ (RAM−1GB)/2 与 256MB 取大</text>
<text class="ts" x="226" y="84">B 树页 · 文档级锁 · MVCC 快照</text>
<line class="l" x1="150" y1="58" x2="210" y2="58" marker-end="url(#arr)"/>
<rect class="b5" x="210" y="130" width="110" height="56" rx="8"/>
<text class="tb" x="265" y="152" text-anchor="middle" dominant-baseline="middle">Journal</text>
<text class="ts" x="265" y="172" text-anchor="middle">预写日志(WAL)</text>
<rect class="b2" x="340" y="130" width="140" height="56" rx="8"/>
<text class="tb" x="410" y="152" text-anchor="middle" dominant-baseline="middle">数据文件</text>
<text class="ts" x="410" y="172" text-anchor="middle">checkpoint 约每 60s</text>
<line class="l" x1="300" y1="96" x2="265" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="96" x2="410" y2="130" marker-end="url(#arr)"/>
<rect class="bg" x="520" y="20" width="260" height="166" rx="10"/>
<text class="th" x="536" y="44">特点</text>
<text class="ts" x="536" y="68">• 文档级并发：不同文档写互不阻塞</text>
<text class="ts" x="536" y="88">• MVCC：读不阻塞写，快照读</text>
<text class="ts" x="536" y="108">• 压缩：snappy/zstd，省磁盘</text>
<text class="ts" x="536" y="128">• 崩溃恢复：最近 checkpoint + 重放 journal</text>
<text class="ts" x="536" y="148">• 内存：自身缓存 + OS 页缓存两层</text>
<text class="ts" x="536" y="168">• 容器内要为非缓存内存留余量</text>
<rect class="bg" x="20" y="210" width="760" height="76" rx="10"/>
<text class="ts" x="36" y="234">• 工作集（频繁访问的数据 + 索引）能放进内存，性能才稳定；否则频繁缺页读盘，延迟陡增</text>
<text class="ts" x="36" y="254">• 写入持久性由 journal 与写关注（writeConcern j:true / w:majority）决定，而不是 checkpoint（见 复制集）</text>
<text class="ts" x="36" y="274">• 与 InnoDB 对比：同为 WAL + 缓存页，但 WiredTiger 面向文档与 MVCC 快照，压缩默认开启（见 MySQL 存储与日志）</text>
</svg>
<figcaption>图 1：WiredTiger：缓存、journal 与 checkpoint</figcaption>
</figure>

## 三、数据建模

### 1. 嵌入 vs 引用

| | 嵌入（Embed） | 引用（Reference） |
| --- | --- | --- |
| 形态 | 子数据放在父文档内 | 存对方的 `_id`，另行查询或 `$lookup` |
| 读取 | **一次读取取回全部**（无 JOIN） | 多次查询或 `$lookup` |
| 原子性 | **单文档原子更新**（天然事务） | 跨文档需要事务 |
| 适用 | **一对一、一对少**；子数据**总是随父一起读**；数量**有界**；生命周期一致 | **一对很多、多对多**；子数据经常**单独访问/更新**；数量**无界**；被多处共享 |
| 风险 | 文档膨胀（16MB 上限）、更新放大、热点文档 | 查询变复杂，一致性自己维护 |

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="嵌入与引用建模：订单文档把订单项数组嵌入，因为一起读取且数量有限；商品信息以引用方式存在独立集合，订单项里只保存商品 ID 与下单时的价格快照；评论数量无界，使用独立集合并引用文章 ID">
<rect class="b2" x="20" y="30" width="300" height="150" rx="12"/>
<text class="th" x="36" y="54">orders（嵌入订单项）</text>
<text class="ts" x="36" y="78">{ orderNo, userId, status,</text>
<text class="ts" x="36" y="98">  items: [ {skuId, name, priceFen, qty} ],</text>
<text class="ts" x="36" y="118">  shipTo: {…} }</text>
<text class="ts" x="36" y="148">✓ 一次读出整单；单文档原子更新</text>
<text class="ts" x="36" y="166">✓ 下单价格是“快照”，不随商品改价变化</text>
<rect class="b3" x="360" y="30" width="190" height="80" rx="12"/>
<text class="th" x="376" y="54">products（独立集合）</text>
<text class="ts" x="376" y="76">商品被多处引用、独立更新</text>
<text class="ts" x="376" y="94">订单只存 skuId 快照字段</text>
<rect class="b5" x="590" y="30" width="190" height="150" rx="12"/>
<text class="th" x="606" y="54">posts / comments</text>
<text class="ts" x="606" y="78">评论数量无界</text>
<text class="ts" x="606" y="98">→ 独立 comments 集合</text>
<text class="ts" x="606" y="118">{ postId, user, text, ts }</text>
<text class="ts" x="606" y="140">索引 (postId, ts)</text>
<text class="ts" x="606" y="160">按需分页读取</text>
<line class="ld" x1="320" y1="70" x2="360" y2="70"/>
<rect class="bg" x="20" y="200" width="760" height="70" rx="10"/>
<text class="ts" x="36" y="224">判断口诀：一起读 → 嵌入；数量有界 → 嵌入；独立访问/更新/共享 → 引用；无限增长 → 一定引用</text>
<text class="ts" x="36" y="246">反范式（冗余）是常态，但冗余字段要有明确的“更新责任”：用快照（不需要同步）或变更事件同步（需要同步）</text>
<text class="ts" x="36" y="262">建模前先列出：主要的读操作（频率、延迟）与写操作，再选结构</text>
</svg>
<figcaption>图 2：嵌入与引用的取舍</figcaption>
</figure>

### 2. 常用建模模式

| 模式 | 解决的问题 | 做法 |
| --- | --- | --- |
| **子集模式（Subset）** | 文档内数组很大，但常用只需最近若干条 | 主文档只嵌入最近/最热的 N 条，完整数据放独立集合（如商品只嵌最新 10 条评论） |
| **扩展引用（Extended Reference）** | 频繁 `$lookup` 取少量字段 | 在引用处冗余保存常用字段（订单里存商品名、价格快照） |
| **桶模式（Bucket）** | 海量时序/事件数据，每条一个文档开销大 | 按时间窗口把多条数据打包进一个文档（如每设备每小时一个桶，内含数组）；减少文档数与索引；注意 MongoDB 5.0+ 原生有 **Time Series Collection** |
| **计算模式（Computed）** | 读取时要频繁聚合 | 写入时预计算并保存（总数、均值），或定时任务/聚合管道物化到 `$merge` |
| **多态模式（Polymorphic）** | 同一集合存相似但异构的文档 | 加 `type` 字段，按类型分支；索引覆盖公共字段 |
| **模式版本（Schema Versioning）** | 结构演进，历史文档与新文档并存 | 文档带 `schemaVersion`，读取时兼容旧版，后台逐步迁移 |
| **异常值模式（Outlier）** | 少数文档远超平均大小（如热门账号） | 超大文档打标并溢出到另一集合，避免拖累常规设计 |

### 3. 模式校验

“灵活”不等于“随意”：用 **JSON Schema 校验**约束关键字段（类型、必填、枚举），防止脏数据：

```javascript
db.createCollection("orders", { validator: { $jsonSchema: {
  bsonType: "object", required: ["orderNo", "userId", "status", "amountFen"],
  properties: {
    orderNo: { bsonType: "string" }, userId: { bsonType: "long" },
    status: { enum: ["CREATED", "PAID", "SHIPPED", "CANCELLED"] },
    amountFen: { bsonType: "long", minimum: 0 }
  } } }, validationLevel: "strict", validationAction: "error" });
```

## 四、索引

### 1. 索引类型

| 类型 | 用途 |
| --- | --- |
| 单字段 / **复合索引** | 最常用；B 树；支持前缀 |
| **多键索引（Multikey）** | 对**数组字段**自动为每个元素建索引条目；复合索引里最多一个数组字段 |
| **唯一索引** | 唯一约束（分片集群中须包含分片键） |
| **部分索引（Partial）** | 只索引满足条件的文档（如 `status: "ACTIVE"`），省空间 |
| 稀疏索引 | 只索引含该字段的文档 |
| **TTL 索引** | 到期自动删除（日志、会话、验证码），由后台线程每分钟扫描 |
| 文本索引 / Atlas Search | 全文检索（复杂场景用 Elasticsearch，见 [ES](#/mw/es)） |
| 地理空间（2dsphere） | 附近的人/店 |
| 哈希索引 | 等值查询、哈希分片键 |
| **通配符索引（Wildcard）** | 字段名不固定的动态结构 |
| 列式/时序 | Time Series Collection 内部优化 |

### 2. 复合索引与 ESR 规则

**ESR：Equality（等值）→ Sort（排序）→ Range（范围）**。索引字段顺序按此排列，能同时满足过滤与排序，避免内存排序。

```javascript
// 查询：某用户、状态为 PAID，按创建时间倒序，金额 > 100 的订单
db.orders.find({ userId: 10086, status: "PAID", amountFen: { $gt: 10000 } }).sort({ createdAt: -1 })

// 按 ESR：等值(userId, status) → 排序(createdAt) → 范围(amountFen)
db.orders.createIndex({ userId: 1, status: 1, createdAt: -1, amountFen: 1 })
```

要点：

- **最左前缀**：索引 `{a,b,c}` 可支持 `a`、`a,b`、`a,b,c`，不能支持只查 `b`；
- 排序方向要与索引一致（整体同向或整体反向均可）；
- **覆盖查询**：查询字段与返回字段都在索引中（`projection` 只取索引字段，`_id: 0`），不回表读文档，`totalDocsExamined = 0`；
- **选择性**高的等值字段更靠前（但仍遵守 ESR）；低基数字段（性别）单独建索引意义小；
- **每个索引都有写入与内存成本**：索引总大小应能放入内存；定期用 `$indexStats` 清理无用索引；
- 线上建索引：4.2+ 使用优化的构建流程（只在开始/结束短暂加锁），仍会消耗 IO/CPU，选低峰；分片集群/复制集可**滚动建索引**。

### 3. 用 explain 诊断

```javascript
db.orders.find({ userId: 10086, status: "PAID" }).sort({ createdAt: -1 }).explain("executionStats")
```

| 看什么 | 含义与目标 |
| --- | --- |
| `winningPlan.stage` | **`IXSCAN`**（走索引）好；**`COLLSCAN`**（全表扫描）要警惕；`SORT`（内存排序）说明索引未满足排序 |
| `totalKeysExamined` / `totalDocsExamined` / `nReturned` | 理想：三者接近。`docsExamined ≫ nReturned` 说明索引选择性差或缺字段 |
| `executionTimeMillis` | 实际耗时 |
| `rejectedPlans` | 优化器放弃的其他计划；必要时 `hint()` 指定索引（慎用） |

`db.setProfilingLevel(1, { slowms: 100 })` 开启慢查询分析，`db.system.profile` 查看；生产用 `mongostat`、`mongotop`、Atlas/Ops Manager、Prometheus mongodb_exporter（见 [指标监控](#/infra/obs-metrics)）。

## 五、聚合管道

把文档依次通过多个**阶段**，每个阶段的输出是下一个的输入：

```javascript
// 统计最近 7 天各渠道已支付订单数与金额，取金额前 5
db.orders.aggregate([
  { $match: { status: "PAID", createdAt: { $gte: ISODate("2026-10-05") } } },     // 尽早过滤，走索引
  { $project: { channel: 1, amountFen: 1 } },                                     // 只保留需要的字段
  { $group: { _id: "$channel", cnt: { $sum: 1 }, total: { $sum: "$amountFen" } } },
  { $sort: { total: -1 } },
  { $limit: 5 }
], { allowDiskUse: true })
```

| 阶段 | 作用 | 备注 |
| --- | --- | --- |
| `$match` | 过滤 | **放最前**，才能用索引；与 `$sort` 紧邻可利用索引 |
| `$project` / `$addFields` | 选择/计算字段 | 减少后续数据量 |
| `$group` | 分组聚合 | 受内存限制（100MB/阶段），可 `allowDiskUse` |
| `$sort` / `$limit` | 排序/截断 | `$sort + $limit` 会合并为 Top-K 优化 |
| `$unwind` | 展开数组 | 数据量会放大 |
| **`$lookup`** | 类似左连接 | **代价高**：被关联集合的连接字段必须有索引；分片集群里限制更多；大量 `$lookup` 说明模型更适合关系库或需要反范式 |
| `$facet` | 多路并行聚合 | 同一输入多种统计 |
| `$merge` / `$out` | 结果写回集合 | 做物化视图/预计算 |

聚合不是大数据分析引擎：大规模分析应导出到 OLAP 或使用专门方案（见 [CDC 与实时数仓](#/bigdata/cdc)、[OLAP](#/bigdata/olap)）。

## 六、读写操作要点

### 1. 更新操作符（原子、局部更新）

```javascript
// 原子自增、数组追加（限制长度）、条件更新、upsert
db.users.updateOne({ _id: 1 }, { $inc: { points: 10 }, $push: { logs: { $each: [ { t: new Date(), a: "login" } ], $slice: -100 } } })
db.stock.updateOne({ sku: 1, qty: { $gte: 1 } }, { $inc: { qty: -1 } })     // 条件更新，天然防超卖（修改数=0 即失败）
db.cfg.updateOne({ k: "a" }, { $set: { v: 1 } }, { upsert: true })
```

使用 `$set/$inc/$push` 等**局部更新**而不是整文档替换，减少写放大与并发覆盖；`findOneAndUpdate` 可实现“取并改”原子操作（如发号器、抢任务）。

### 2. 分页

- `skip(n).limit(m)`：**n 大时要扫描并丢弃前 n 条，深分页很慢**；
- 改用**范围分页（游标/键集分页）**：`find({ _id: { $gt: lastId } }).sort({ _id: 1 }).limit(m)`，或按 `(createdAt, _id)` 联合条件，基于索引常数代价。

### 3. 批量与写关注

- 批量写：`insertMany` / `bulkWrite`（`ordered: false` 可并行、遇错继续），一批 1000 条左右；
- 写关注 `writeConcern` 与读关注见 [复制集](#/db/mongo-cluster)。

## 七、Java 访问

### 1. Spring Data MongoDB

```java
@Document("orders")
@CompoundIndex(name = "user_status_time", def = "{'userId':1,'status':1,'createdAt':-1}")
public class OrderDoc {
    @Id private ObjectId id;
    @Indexed(unique = true) private String orderNo;
    private Long userId;
    private String status;
    private Decimal128 amount;                  // 或用整数分 long
    private List<ItemDoc> items;                 // 嵌入
    private Instant createdAt;
    @Version private Long version;               // 乐观锁
    // getters/setters 略
}

public interface OrderRepo extends MongoRepository<OrderDoc, ObjectId> {
    Page<OrderDoc> findByUserIdAndStatus(Long userId, String status, Pageable pageable);
}

// 复杂/局部更新用 MongoTemplate
mongoTemplate.updateFirst(
    Query.query(Criteria.where("orderNo").is(no).and("status").is("CREATED")),     // 条件更新实现状态机
    new Update().set("status", "PAID").set("paidAt", Instant.now()),
    OrderDoc.class);
```

### 2. 连接与配置

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://app:***@mongo1:27017,mongo2:27017,mongo3:27017/shop?replicaSet=rs0&w=majority&readPreference=primaryPreferred&maxPoolSize=100&connectTimeoutMS=3000&socketTimeoutMS=10000
```

- 驱动自带**连接池**（`maxPoolSize`）与**服务器选择/故障转移**；**连接串必须列出多个节点并带 `replicaSet`**，让驱动自动发现主节点；
- 设置超时（`serverSelectionTimeoutMS`、`socketTimeoutMS`、`maxTimeMS` 限制单次查询耗时），避免慢查询占满连接；
- **不要在每次请求里创建 `MongoClient`**，全局单例；
- 凭据放配置中心/密钥管理（见 [加密与密钥管理](#/security/crypto)），启用认证与 TLS。

## 八、变更流与其他能力

- **Change Streams**：监听集合/库的变更（基于 oplog，支持断点续传 `resumeToken`），用于**数据同步、缓存失效、事件驱动**（见 [事件驱动架构](#/design/event-driven) 中的 Outbox/CDC 思路）；
- **Time Series Collection**（5.0+）：为时序数据优化存储与查询，适合 IoT/监控；
- **GridFS**：存超过 16MB 的大文件（通常更推荐对象存储 + 存元数据）；
- **Atlas Search / Vector Search**：托管版提供全文与向量检索（RAG 场景，见 [RAG](#/ai/rag)）。

## 九、常见坑

| 坑 | 说明 / 对策 |
| --- | --- |
| **数组无限增长** | 文档越来越大、更新放大、触及 16MB；改为独立集合（引用）、桶模式或 `$slice` 限长 |
| 过度嵌套/文档过大 | 读取传输大、更新慢；拆分、子集模式 |
| 缺失/错误的索引 | `COLLSCAN` 拖垮实例；对核心查询做 explain，监控慢查询 |
| 索引过多 | 写入变慢、内存被占；定期清理未使用索引 |
| `skip` 深分页 | 改键集分页 |
| 大量 `$lookup` | 模型不合适：反范式（扩展引用）或换关系库 |
| 把金额存成 double | 用 Decimal128 或整数分 |
| 不设 `maxTimeMS`/超时 | 慢查询占满连接池；设置超时与限流 |
| 工作集超过内存 | 加内存/分片、精简索引与文档、冷热分离 |
| 无 schema 约束导致脏数据与字段名混乱 | JSON Schema 校验 + `schemaVersion` |
| `_id` 选择不当（分片时热点） | 自增/时间递增的 `_id` 作为范围分片键会写热点，见 [分片](#/db/mongo-cluster) |
| 迁移后遗留时区与类型问题 | 日期统一存 UTC `Date`；数值类型明确（Int32/Int64/Decimal128） |
| 误以为默认“不会丢数据” | 写关注 `w:1` 可能在主节点宕机后丢失/回滚，重要数据用 `w:majority` |

## 面试追问

> [!QUESTION] MongoDB 适合什么场景？不适合什么场景？
> 适合结构多变、以聚合对象为读写单位、高写入的半结构化数据，如商品目录、内容、用户画像、日志事件和 IoT 数据，并且需要水平扩展。不适合强事务、多表复杂关联和复杂联表分析的核心账务场景，这些仍应用关系型数据库。

> [!QUESTION] 嵌入和引用怎么选？
> 数据总是一起读取、数量有界、生命周期一致时嵌入，可一次读取且单文档更新原子；子数据需要独立访问更新、多对多或数量无界时引用，如评论。同时用子集、扩展引用等模式平衡读取与冗余，建模要从查询模式出发。

> [!QUESTION] 复合索引的 ESR 规则是什么？
> 字段顺序按等值、排序、范围排列：等值条件放最前保证选择性，排序字段紧随其后让索引直接提供有序结果避免内存排序，范围字段放最后。还要满足最左前缀，必要时设计覆盖索引，并用 explain 检查是否 IXSCAN 以及扫描文档数是否接近返回数。

> [!QUESTION] 如何排查 MongoDB 慢查询？
> 开启慢查询分析或查看日志，对慢语句用 explain executionStats 看是否 COLLSCAN、内存 SORT、docsExamined 远大于 nReturned；对应补建或调整复合索引，改写深分页为键集分页，减少 lookup，限制返回字段，必要时用 maxTimeMS 保护实例，并检查工作集是否超出内存。

> [!QUESTION] WiredTiger 如何保证数据不丢？
> 写入先更新缓存并写 journal 预写日志，约每 60 秒做 checkpoint 把一致快照写入数据文件，崩溃恢复时从最近 checkpoint 加上重放 journal。持久性最终还取决于写关注，如 j:true 与 w:majority，以及副本集的复制。

> [!QUESTION] 为什么说数组无限增长是 MongoDB 的反模式？
> 文档会不断变大，更新放大、可能触发文档迁移与缓存压力，甚至触及 16MB 上限，多键索引条目也随之膨胀。应改为独立集合引用、按时间分桶，或用 push 配合 slice 限制长度。
