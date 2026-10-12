---
level: 高级
tags: [ClickHouse, OLAP, 列式存储, MergeTree, 稀疏索引, 跳数索引, 向量化, 压缩编码, Projection, Merge]
summary: ClickHouse 为什么快：列式存储与向量化执行的原理、MergeTree 的 part/granule/稀疏主键/mark 文件如何协作实现数据跳过、排序键与分区的设计、跳数索引与 Projection、压缩编码与数据类型选择、后台 merge 与 mutation（轻量删除）、ReplacingMergeTree 与 FINAL 的语义，以及如何用 EXPLAIN 与 system 表验证查询是否真的“跳”了数据。
---

# ClickHouse 存储与执行：MergeTree、稀疏索引与向量化

> [!ABSTRACT] 核心要点
> - ClickHouse 快的根因是**“少读 + 读得快 + 算得快”**：**列存**只读用到的列；**稀疏索引 + 分区 + 跳数索引**跳过大部分数据；**同列同类型数据压缩比高**减少 IO；**向量化执行 + 多核并行**让 CPU 吞吐拉满。
> - **MergeTree** 把每次 INSERT 写成**不可变的 part**（part 内按**排序键**排好序），后台**合并（merge）**小 part 为大 part。**排序键（ORDER BY）是最重要的设计决策**：它决定稀疏索引、数据局部性与压缩率。
> - **稀疏主键索引**：每隔一个 **granule（默认 8192 行）**记录一个索引条目，**常驻内存、体积极小**，通过二分定位“可能包含目标的 granule 范围”；**不是点查索引**，也**不保证唯一**。
> - **跳数索引（minmax/set/bloom_filter/ngrambf）**与 **Projection** 用来补充非排序键列的过滤与预聚合，但**不是万能的**，要用 EXPLAIN 验证是否生效。
> - **更新/删除不是强项**：mutation 重写 part；用 **ReplacingMergeTree + 版本** 或 **轻量删除**；注意**去重只在 merge 时发生**，查询需 `FINAL`/`argMax` 兜底。
> - 判断“数据跳没跳”：`EXPLAIN indexes=1`、`system.query_log` 的 `read_rows/read_bytes`，对比总行数。

> [!NOTE] 版本说明
> ClickHouse 迭代很快（每月发版），引擎行为、默认值与新特性（轻量更新、全文/向量索引等）随版本变化。本文讲通用且稳定的原理，细节请以所用版本文档为准。基础概览见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap)，集群与实战见 [集群、写入与表设计](#/bigdata/ck-cluster)。

## 一、为什么分析型查询适合列存

分析查询的特征：**扫描大量行、只用少数几列、做聚合**。

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="行存与列存对比：行存按整行连续存放，查询只需要两列也要读出所有列；列存每列单独存放，只读需要的列，且同列数据类型一致，压缩比高，适合向量化批量计算">
<rect class="b4" x="20" y="30" width="360" height="130" rx="12"/>
<text class="th" x="36" y="54">行存（OLTP：MySQL / PG）</text>
<text class="ts" x="36" y="80">[id, user, city, amount, ts] [id, user, city, amount, ts] …</text>
<text class="ts" x="36" y="102">整行连续存放，按主键点查很快</text>
<text class="ts" x="36" y="124">SELECT sum(amount) 也要把所有列读进来</text>
<text class="ts" x="36" y="146">不同类型混在一起，压缩差</text>
<rect class="b2" x="400" y="30" width="380" height="130" rx="12"/>
<text class="th" x="416" y="54">列存（ClickHouse）</text>
<text class="ts" x="416" y="80">id: [1,2,3…]  user: […]  amount: [9.9, 5.0…]</text>
<text class="ts" x="416" y="102">每列单独文件，只读 amount、ts 两列</text>
<text class="ts" x="416" y="124">同列同类型 → 压缩比高（常 5~10 倍）</text>
<text class="ts" x="416" y="146">一批值连续放 → 适合 SIMD 向量化</text>
<rect class="bg" x="20" y="180" width="760" height="100" rx="10"/>
<text class="th" x="36" y="204">读放大对比（直觉）</text>
<text class="ts" x="36" y="226">表有 100 列，查询用 3 列：行存读 100 列数据，列存只读 3 列 → 至少约 30 倍的 IO 差距，再叠加压缩与跳过</text>
<text class="ts" x="36" y="246">代价：按行写入/更新需要同时改多列文件，所以列存适合“批量追加 + 少改”；单行点查与事务不是它的强项</text>
<text class="ts" x="36" y="266">与行存索引（B+ 树，见 B+ 树索引）的取舍：分析靠“跳过 + 扫描”，不靠“精确定位单行”</text>
</svg>
<figcaption>图 1：行存与列存的读取差异</figcaption>
</figure>

## 二、MergeTree 的物理结构

### 1. 从一次 INSERT 到一个 Part

每次 `INSERT`（一个批次）会在磁盘上生成**一个新的 part 目录**：数据**按排序键排序**后，**每列写成独立文件**，并生成稀疏索引与标记文件。part **一旦写入不可修改**，后台 merge 会把多个 part 合成一个更大的新 part，旧 part 之后被清理。

```text
/var/lib/clickhouse/data/db/events/
  202610_1_1_0/                 ← part 名：分区_最小块号_最大块号_合并层级
    columns.txt                  列清单
    count.txt                    行数
    primary.idx                  稀疏主键索引（常驻内存）
    event_type.bin / .mrk3       列数据文件（压缩块）/ 标记文件
    user_id.bin    / .mrk3
    amount.bin     / .mrk3
    checksums.txt  partition.dat minmax_event_date.idx …
  202610_2_5_1/                 ← 合并后：覆盖块 2~5，层级 +1
```

part 有两种格式：**Wide**（每列独立文件，大 part 常用）与 **Compact**（所有列放在一个文件，小 part 减少文件数与写放大），由大小阈值自动选择。

### 2. granule、稀疏索引与 mark 文件

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="稀疏索引工作方式：数据按排序键排序后每 8192 行为一个 granule；主键索引每个 granule 只记录第一行的排序键值；查询条件先在索引上二分，得到可能命中的 granule 范围；mark 文件记录每个 granule 在各列压缩文件中的偏移，从而只读取这些 granule 的数据块并解压；其余 granule 被整体跳过">
<text class="th" x="20" y="24">按排序键 (event_type, user_id) 排好序的数据，每 8192 行一个 granule</text>
<rect class="b" x="20" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="70" y="60" text-anchor="middle" dominant-baseline="middle">granule 0</text>
<rect class="b" x="126" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="176" y="60" text-anchor="middle" dominant-baseline="middle">granule 1</text>
<rect class="b2" x="232" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="282" y="60" text-anchor="middle" dominant-baseline="middle">granule 2 ✓</text>
<rect class="b2" x="338" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="388" y="60" text-anchor="middle" dominant-baseline="middle">granule 3 ✓</text>
<rect class="b" x="444" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="494" y="60" text-anchor="middle" dominant-baseline="middle">granule 4</text>
<rect class="b" x="550" y="40" width="100" height="40" rx="6"/>
<text class="ts" x="600" y="60" text-anchor="middle" dominant-baseline="middle">granule 5</text>
<text class="ts" x="664" y="60" text-anchor="start">…</text>
<rect class="b5" x="20" y="108" width="630" height="44" rx="6"/>
<text class="tb" x="36" y="124" dominant-baseline="middle">primary.idx</text>
<text class="ts" x="130" y="124" dominant-baseline="middle">每个 granule 一条：首行排序键   (a,1) | (a,9000) | (b,3) | (b,8100) | (c,5) | (d,2) …</text>
<text class="ts" x="36" y="142" dominant-baseline="middle">WHERE event_type='b' → 二分定位 granule 2~3 可能命中（✓），其余整体跳过</text>
<line class="l" x1="282" y1="80" x2="282" y2="108" marker-end="url(#arr)"/>
<rect class="b3" x="20" y="170" width="300" height="86" rx="10"/>
<text class="th" x="36" y="194">mark 文件（*.mrk）</text>
<text class="ts" x="36" y="216">granule 号 → (压缩块在 .bin 中的偏移,</text>
<text class="ts" x="36" y="234">解压后块内偏移)；每列一份</text>
<rect class="b1" x="340" y="170" width="440" height="86" rx="10"/>
<text class="th" x="356" y="194">只读命中的 granule</text>
<text class="ts" x="356" y="216">用 mark 直接定位到各列 .bin 的对应位置，</text>
<text class="ts" x="356" y="234">只解压并读取 2 个 granule（约 1.6 万行），不是全表</text>
<rect class="bg" x="20" y="272" width="760" height="56" rx="10"/>
<text class="ts" x="36" y="296">• 索引条目 = 行数 / 8192：10 亿行只有约 12 万条，几 MB，轻松常驻内存；代价是粒度粗，点查要读整个 granule（约 8192 行）</text>
<text class="ts" x="36" y="314">• 前缀有效：条件包含排序键的前缀列才能高效跳过；只过滤后面的列（如只按 user_id）跳过效果差，需要跳数索引/Projection/调整排序键</text>
</svg>
<figcaption>图 2：稀疏主键索引 + mark 文件：只读命中的 granule</figcaption>
</figure>

要点：

- `index_granularity` 默认 **8192 行**；还有自适应粒度（`index_granularity_bytes`，默认约 10MB）防止宽行 granule 过大；
- **PRIMARY KEY 默认等于 ORDER BY**（可以是其前缀，用于缩小常驻内存的索引）；
- **不是唯一约束**：相同排序键的行可以重复写入；
- **点查**命中后仍要读一个 granule 并解压，**几十万 QPS 的单行点查不是 ClickHouse 的强项**（用 Redis/PG/KV，见 [Redis](#/redis/overview)）。

### 3. 排序键设计

| 原则 | 说明 |
| --- | --- |
| **把常用过滤列放前面** | 只有排序键**前缀**能高效裁剪 |
| **低基数在前、高基数在后** | 前面列基数低 → 同值数据聚集，索引跳过效率高、压缩比高；时间戳等高基数列放后面 |
| **等值过滤列优先于范围列** | 与组合索引最左前缀思想一致（见 [MySQL 索引](#/mysql/index)） |
| **兼顾压缩** | 相似行靠在一起，压缩比显著提高；排序键选得好，存储可差数倍 |
| **不要过长** | 每个排序键列都要写入与比较，常用 2~4 列；过长影响写入与 merge 成本 |
| **不是越多越好** | 与分区区分：分区用来“管理数据”，排序键用来“加速查询” |

```sql
-- 典型埋点明细：多数查询按事件类型 + 时间范围过滤，再按用户聚合
ORDER BY (event_type, toDate(event_time), user_id)
-- 对比：ORDER BY (user_id, event_time) 更适合“看某个用户的行为轨迹”
-- 若两类查询都重要，可用 Projection 或物化视图（另一份排序）满足第二种
```

### 4. 分区（PARTITION BY）

- 目的：**数据管理**（按分区删除/TTL/迁移/备份、`DROP PARTITION` 瞬间完成）与**分区裁剪**，不是主要的查询加速手段；
- **粒度宁大勿小**：按月（或天，数据量巨大时）；**每个分区会产生独立的 part 集合**，分区过细（按小时、按用户）会导致 part 总数爆炸与 `Too many parts`；
- 单次 INSERT 跨很多分区会生成很多 part（`max_partitions_per_insert_block` 保护），**写入前按分区键对数据分组**；
- 不要用高基数列做分区键。

## 三、数据跳过的补充手段

### 1. 跳数索引（Data Skipping Index）

对**非排序键列**建立“块级摘要”，查询时用摘要判断某组 granule 是否可能含目标值，**能整体跳过则跳过**：

| 类型 | 摘要内容 | 适用 |
| --- | --- | --- |
| `minmax` | 每块的最小/最大值 | 与排序弱相关的数值/时间列的范围过滤 |
| `set(N)` | 每块不重复值集合（上限 N） | **低基数**列的等值/IN |
| `bloom_filter(p)` | 布隆过滤器（见 [布隆过滤器](#/cs/algo-engineering)） | 高基数列的**等值**判断（如 trace_id、user_id） |
| `tokenbf_v1` / `ngrambf_v1` | 按分词/ngram 的布隆过滤 | 日志**文本包含**类匹配（`LIKE '%xxx%'`、`hasToken`） |

```sql
ALTER TABLE events ADD INDEX idx_trace trace_id TYPE bloom_filter(0.01) GRANULARITY 4;   -- 每 4 个 granule 一个摘要块
ALTER TABLE events MATERIALIZE INDEX idx_trace;                                            -- 对已有数据构建索引
```

> [!WARNING] 跳数索引不是 B 树
> 它只能**整块跳过**，**数据分布与排序键无关时，每个块里几乎都可能包含目标值，索引等于没用**（还增加写入与存储成本）。只有当目标值在数据中**聚集**（排序相关或本身稀疏）时才有效。**务必用 EXPLAIN 与 `read_rows` 验证收益**，不要盲目加。

### 2. Projection（投影）

Projection 在**同一张表内**为 part 额外维护一份**不同排序键或预聚合**的数据，查询优化器**自动选择**最合适的来源：

```sql
ALTER TABLE events ADD PROJECTION p_by_user (SELECT * ORDER BY user_id, event_time);       -- 另一种排序：按用户查轨迹
ALTER TABLE events ADD PROJECTION p_daily (SELECT toDate(event_time) AS d, event_type, count(), sum(amount) GROUP BY d, event_type);
ALTER TABLE events MATERIALIZE PROJECTION p_by_user;
```

| | Projection | 物化视图（见 [集群与实战](#/bigdata/ck-cluster)） |
| --- | --- | --- |
| 位置 | **表内部**，随 part 一起生成与合并，自动一致 | **独立的目标表** |
| 使用 | **自动命中**，不改查询 | 要显式查询目标表 |
| 灵活性 | 较低（限制多，如不支持 JOIN 等） | 高（可 JOIN、可写入不同引擎） |
| 代价 | 增加存储与写入（每个 part 多一份） | 同样额外存储与写入 |

选择：**查询模式固定且需要不同排序/预聚合**，又不想改应用 → Projection；需要复杂转换、不同引擎或精确控制 → 物化视图。

## 四、压缩与数据类型

### 1. 压缩

- 每列数据按块（默认约 64KB~1MB 未压缩）压缩，默认编码 **LZ4**（快）或 **ZSTD**（压缩比更高、CPU 稍多）；
- 在通用压缩前先用**专用编码（Codec）**把数据变得更“可压缩”：

| Codec | 适合 | 说明 |
| --- | --- | --- |
| `Delta` | 单调/缓变整数（时间、递增 ID） | 存相邻差值 |
| `DoubleDelta` | 时间戳、规律间隔的序列 | 存差值的差值，等间隔采集压缩极好 |
| `Gorilla` | 浮点指标 | XOR 编码，类似时序库（见 [InfluxDB](#/db/influx-model)） |
| `T64` | 取值范围小的整数 | 位压缩 |
| `ZSTD(n)` / `LZ4` | 通用 | 常与上面组合：`CODEC(DoubleDelta, ZSTD(1))` |

### 2. 数据类型选择（直接影响速度与体积）

| 建议 | 原因 |
| --- | --- |
| **低基数字符串用 `LowCardinality(String)`** | 字典编码（通常基数 < 1 万~10 万），存储与过滤/分组大幅加速 |
| **尽量避免 `Nullable`** | 额外一列存空值标记，影响性能与体积；用默认值（0、空串）表达缺失 |
| 整型用最小够用宽度（`UInt8/16/32/64`） | 省空间，向量化更快 |
| 时间用 `Date` / `DateTime`（`DateTime64` 需要毫秒时） | 不要用 `String` 存时间 |
| 金额用 `Decimal` 或整数分 | 避免浮点误差（见 [订单支付案例](#/design/case-payment)） |
| 枚举类可用 `Enum8/16` | 紧凑 |
| JSON/半结构化：热点字段拆成独立列，其余放 `String`/`JSON`（新版本原生 JSON 类型） | 列拆分才享受列存收益 |
| 数组/嵌套（`Array`、`Nested`、`Map`） | 适合行为属性，但查询要展开（`arrayJoin`），成本更高 |

## 五、向量化与并行执行

- **向量化**：算子一次处理**一批值（block，默认约 65536 行）**而不是一行，减少函数调用与分支开销，**充分利用 CPU 缓存与 SIMD 指令**；
- **并行**：一个查询在单机上拆成多个数据流（按 part / granule 范围）由多个线程并行处理（`max_threads`，默认≈核数），再合并；
- **管线（Pipeline）**：读取 → 过滤 → 计算 → 聚合（局部）→ 合并（全局），各阶段流式衔接；
- **PREWHERE**：先只读**过滤列**判断哪些行满足，再只读这些行的其余列——对“过滤性强、选择列多”的查询大幅减少 IO；优化器会**自动**把合适的 WHERE 条件移到 PREWHERE，也可手动指定；
- **表达式 JIT、哈希聚合专用实现（按键类型选择）、Join 多种算法**等进一步优化；
- 对比行式火山模型（一行一次 `next()`，见 [SQL 调优](#/mysql/optimize)），向量化在分析场景下有数量级差异。

一个查询的“总耗时 ≈ 读取（IO+解压）+ 计算”。常用手段：**少读（索引/分区/列裁剪）**、**少算（预聚合/近似）**、**并行**。

## 六、Merge、Mutation 与删除

### 1. 后台 Merge

- 后台线程根据策略把**同一分区**内的小 part 合并为大 part（保持排序、重新压缩）；
- 合并**不会跨分区**；合并过程**消耗 CPU 与磁盘 IO**，写入越频繁、part 越小，合并压力越大；
- part 过多的保护：达到阈值先**延迟写入**，再抛 **`Too many parts`** 拒绝写入（阈值随版本而异）。**根因几乎总是小批量高频写入或分区过细**；
- 监控：`system.parts`（每分区 active part 数）、`system.merges`（进行中的合并）、`system.part_log`。

### 2. 更新与删除

| 方式 | 机制 | 特点 |
| --- | --- | --- |
| `ALTER TABLE … UPDATE/DELETE`（**Mutation**） | 异步**重写受影响的 part** | 重量级，不适合高频；不是事务 |
| **轻量删除** `DELETE FROM t WHERE …` | 标记删除行（隐藏掩码），查询时过滤，merge 时物理清除 | 比 mutation 轻，版本相关，大量删除仍有开销 |
| 轻量更新（较新版本逐步引入） | 以补丁/标记方式更新 | 以所用版本文档为准 |
| **ReplacingMergeTree** | merge 时按**排序键**去重，保留**版本最大/最后写入**的行 | 适合 CDC upsert；新版本支持 `is_deleted` 标记行 |
| **CollapsingMergeTree** | 用 sign 列抵消 | 复杂，较少用 |
| `DROP PARTITION` / TTL | 整分区删除 | **最高效的“删除”**，用时间分区管理生命周期 |

### 3. ReplacingMergeTree 的陷阱

```sql
CREATE TABLE user_profile (
  user_id UInt64, name String, level UInt8, updated_at DateTime, ver UInt64
) ENGINE = ReplacingMergeTree(ver) ORDER BY user_id;       -- 按 user_id 去重，保留 ver 最大的行
```

- **去重只发生在后台 merge 时**，且**只在同一分区内**、不保证及时：查询可能读到多个版本；
- 正确读取最新版本：

```sql
SELECT * FROM user_profile FINAL WHERE user_id = 42;                       -- FINAL：查询时合并去重（较慢，但逐步优化）
-- 或：
SELECT user_id, argMax(name, ver) AS name, argMax(level, ver) AS level FROM user_profile GROUP BY user_id;
```

- **排序键必须包含去重所依据的全部键**；**分区键不同的行不会互相去重**（更新时分区列变化会产生“幽灵”副本）；
- 不要依赖 `OPTIMIZE ... FINAL` 做常规去重（极重）。

## 七、验证：数据到底跳没跳

```sql
-- 1) 看索引是否生效、跳过了多少 granule
EXPLAIN indexes = 1
SELECT count() FROM events WHERE event_type = 'pay' AND event_time >= '2026-10-01';
-- 输出中关注：MinMax(分区裁剪)、PrimaryKey(Parts: 选中/总数, Granules: 选中/总数)、Skip(跳数索引)

-- 2) 看真实读取量（query_log 在查询结束后写入）
SELECT query_duration_ms, read_rows, read_bytes, result_rows, memory_usage
FROM system.query_log
WHERE type = 'QueryFinish' AND query LIKE '%FROM events%' ORDER BY event_time DESC LIMIT 5;
```

**判断标准**：`read_rows` 应远小于表总行数；`Granules: x/y` 中 x 远小于 y。若几乎等于全部 → 排序键/分区/索引没对上查询，**回头改设计而不是加机器**。

其他常用诊断：`EXPLAIN PIPELINE`（并行度）、`EXPLAIN PLAN`、`system.processes`（正在运行的查询）、`SET send_logs_level='trace'` 看详细日志。

## 八、常见坑

| 坑 | 对策 |
| --- | --- |
| 排序键设计不当，每条查询都近全表扫描 | 按主要查询的过滤列设计前缀；用 EXPLAIN 验证 |
| 排序键里放高基数列在最前（如 user_id 首位） | 低基数在前；多种查询用 Projection/物化视图 |
| 分区过细，Part 数暴涨 | 月/天粒度；避免高基数分区键 |
| 小批量高频写入 | 批量（数千~数十万行）、异步写入、Buffer/Kafka 引擎 + 物化视图 |
| 以为 PRIMARY KEY 保证唯一 | 它只是索引；需要唯一性在上游/ReplacingMergeTree + 查询去重 |
| 依赖 mutation 做频繁更新 | 改 Replacing/Collapsing 设计，或轻量删除，或 OLTP 库承担更新 |
| `Nullable` 到处用 | 用默认值；仅真正需要区分时用 |
| 滥用跳数索引 | 先验证数据聚集性；用 EXPLAIN 看 Skip 效果 |
| `SELECT *` 读全部列 | 只选需要的列（列存的核心收益） |
| 大表 `FINAL` 查询过慢 | 限定分区/条件、argMax 聚合、或上游去重 |
| 字符串存时间、JSON 整个塞一列 | 正确类型；热点字段拆列 |

## 面试追问

> [!QUESTION] ClickHouse 为什么这么快？
> 列式存储只读用到的列并且同列压缩比高，稀疏索引、分区和跳数索引让大部分数据被跳过，数据按块向量化处理并利用 SIMD，查询在多核上并行执行，再加上专用的聚合与 Join 实现。核心是少读、读得快、算得快。

> [!QUESTION] MergeTree 的稀疏索引是什么？和 MySQL 的 B+ 树索引有什么区别？
> 数据按排序键排序后每 8192 行为一个 granule，主键索引每个 granule 只记录首行键值，体积很小可常驻内存，查询通过二分找到可能命中的 granule 范围，再用 mark 文件定位各列数据只读这些块。它不能精确定位单行，也不保证唯一，适合范围扫描和聚合；B+ 树为每行建索引，适合点查和事务。

> [!QUESTION] ClickHouse 的排序键应该怎么选？分区键呢？
> 排序键把常用过滤列放前面，低基数列在前、高基数列在后，等值优先于范围，也要考虑压缩，一般两到四列。分区键用于数据管理和裁剪，按月或天，粒度宁大勿小，避免高基数分区导致 part 爆炸，不是主要的查询加速手段。

> [!QUESTION] 为什么会出现 Too many parts？怎么解决？
> 每次 INSERT 生成一个 part，小批量高频写入或分区过细时 part 增长速度超过后台合并速度，超过阈值就先限速再拒绝写入。解决是增大批量、降低写入频率、使用异步写入或 Buffer 与 Kafka 引擎加物化视图、减少分区数，并监控 part 数与合并。

> [!QUESTION] ClickHouse 怎么做更新和删除？ReplacingMergeTree 有什么坑？
> mutation 会重写 part 很重，轻量删除只标记行，更常用的是 ReplacingMergeTree 按排序键在合并时去重保留最新版本，或用时间分区直接 DROP PARTITION。坑在于去重只在后台合并时发生且仅限同一分区，查询可能读到多版本，需要用 FINAL 或 argMax 取最新，排序键必须包含去重键。

> [!QUESTION] 跳数索引什么时候有用？怎么验证？
> 目标值在数据中聚集或稀疏时有用，如对高基数列用 bloom_filter 做等值过滤、对文本用 tokenbf 或 ngrambf。如果数据分布与排序键无关，每个块都可能包含目标值，索引等于无效还增加成本。应该用 EXPLAIN indexes 看 Skip 跳过的 granule 数，并对比 query_log 的 read_rows。

> [!QUESTION] Projection 和物化视图有什么区别？
> Projection 在表内为每个 part 维护另一种排序或预聚合的数据，随 part 自动一致且查询自动命中，不用改 SQL，但限制较多；物化视图是独立目标表，靠插入触发，灵活可做转换和 JOIN，但要显式查询目标表并自己保证历史回填。
