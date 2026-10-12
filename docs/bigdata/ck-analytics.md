---
level: 高级
tags: [ClickHouse, 用户行为分析, 漏斗, 留存, 路径分析, windowFunnel, retention, uniq, 近似计算, 采样, 窗口函数]
summary: 用 ClickHouse 做用户行为与业务分析：事件明细表设计（宽表、排序键、列拆分）、PV/UV/DAU 等基础指标与近似去重（uniq 系列与精度权衡）、漏斗（windowFunnel）、留存（retention）、路径与会话分析（sequenceMatch、窗口函数）、分位数与 TopK、采样、Bitmap 人群圈选，以及实时看板的预聚合方案与常见坑。
---

# ClickHouse 行为分析：漏斗、留存与近似计算

> [!ABSTRACT] 核心要点
> - 行为分析的数据底座是**事件明细宽表**：一行一个事件（谁、何时、做了什么、在什么上下文），按 **(事件类型, 日期, 用户)** 一类排序键组织；热点属性**拆成独立列**，长尾属性放 `Map/JSON`。
> - **UV/DAU 去重是最大的成本点**：`uniqExact` 精确但占内存，**`uniq` / `uniqCombined` / `uniqHLL12` 近似**（误差约 1%~2%，内存极小、可合并）；报表要做“**日表 → 周/月表再汇总**”时必须用**可合并的聚合状态**（`uniqState / uniqMerge`），不能把日 UV 相加。
> - **漏斗用 `windowFunnel`**（在时间窗口内按顺序匹配步骤），**留存用 `retention`**，**路径/序列用 `sequenceMatch`、`sequenceCount`**；这些函数都是**单次扫描**完成，比自连接快几个数量级。
> - **人群圈选/用户标签**：用 **Bitmap（RoaringBitmap）**表示用户集合，交并差在内存里完成，适合“既买过 A 又看过 B 的用户”。
> - 实时看板：**明细 + 物化视图（分钟/小时汇总）+ 缓存**，不要让每个看板请求都扫明细。

> [!NOTE] 关联
> 存储与排序键原理见 [ClickHouse 存储与执行](#/bigdata/ck-engine)；集群、写入与物化视图见 [集群与表设计](#/bigdata/ck-cluster)；实时数据链路与案例见 [CDC 与实时数仓](#/bigdata/cdc)、[电商实时数据平台案例](#/bigdata/case-realtime)；概率结构原理见 [工程中的算法](#/cs/algo-engineering)。

## 一、事件明细表设计

### 1. 典型表结构

```sql
CREATE TABLE ods.user_events_local ON CLUSTER my_cluster (
    event_date    Date,
    event_time    DateTime64(3, 'UTC'),
    user_id       UInt64,                     -- 登录用户；匿名用户用 device_id 映射（见下）
    device_id     String,
    session_id    String,
    event_type    LowCardinality(String),     -- view / click / add_cart / pay …（低基数）
    page          LowCardinality(String),
    sku_id        UInt64,
    channel       LowCardinality(String),
    platform      LowCardinality(String),
    amount        Decimal(12, 2),
    props         Map(LowCardinality(String), String)     -- 长尾属性
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ods/user_events', '{replica}')
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_type, event_date, user_id, event_time)
TTL event_date + INTERVAL 400 DAY;
-- 分布式表按 cityHash64(user_id) 分片：同一用户的事件落同一分片，漏斗/留存/路径都能在分片内完成
```

### 2. 设计要点

| 要点 | 说明 |
| --- | --- |
| **分片键用 user_id** | 行为分析的核心是“按用户聚合”，同一用户数据必须在同一分片，否则 `windowFunnel`、`retention` 需要跨分片 shuffle |
| **排序键含 user_id 与 event_time** | 便于按用户读取其时间序列；漏斗函数要求**按时间排序的事件序列**（`windowFunnel` 内部按时间排序，但数据局部有序更快） |
| **热点属性拆列** | `channel`、`platform`、`sku_id` 等高频过滤/分组字段拆成独立列；仅长尾属性放 `Map`（读取 Map 要整个列，代价高） |
| **匿名到登录的用户打通（ID-Mapping）** | 设备 ID → 用户 ID 的映射表（`user_map`），分析时用统一 `uid`（写入时回填，或查询时 Join 字典） |
| **事件时间 vs 上报时间** | 以**事件发生时间**为准，并保留上报时间排查延迟；迟到数据落入旧分区（合并与物化视图汇总要考虑迟到） |
| **去重** | 客户端重试会重复上报：加 `event_id`，用 ReplacingMergeTree 或写入前去重（见 [集群与写入](#/bigdata/ck-cluster)） |
| **隐私与合规** | 手机号、身份证等不入明细或哈希/加密；遵循最小化与保留期（TTL） |

## 二、基础指标与近似去重

### 1. PV / UV / DAU

```sql
-- 每日 PV、UV（近似）、人均事件数
SELECT event_date,
       count()                       AS pv,
       uniq(user_id)                 AS uv,                    -- 近似去重（默认 uniq：自适应采样，误差通常 <2%）
       round(pv / uv, 2)             AS events_per_user
FROM ods.user_events
WHERE event_date BETWEEN '2026-10-01' AND '2026-10-07' AND event_type = 'view'
GROUP BY event_date ORDER BY event_date;
```

### 2. 去重函数怎么选

| 函数 | 精度 | 内存 | 可合并 | 适用 |
| --- | --- | --- | --- | --- |
| `uniqExact` | **精确** | 大（保存全部值的哈希集合） | 是（但状态大） | 对账、小基数、必须精确 |
| `uniq` | 近似（误差约 1~2%） | 小 | 是 | **默认选择** |
| `uniqCombined` | 近似，小基数时更准（内部分段切换算法） | 小 | 是 | 通用 |
| `uniqCombined64` | 同上，用 64 位哈希，**超大基数（>数十亿）更稳** | 小 | 是 | 超大规模 |
| `uniqHLL12` | HyperLogLog，误差约 1.6% | **最小**（约 2.5KB） | 是 | 极致内存、对精度要求低 |
| `uniqTheta*` | Theta Sketch，支持**集合交并差**近似 | 小 | 是 | 近似的人群交叠分析 |

HyperLogLog 原理见 [工程中的算法](#/cs/algo-engineering)。**注意：近似函数的结果不可相加**，下面这个是最常见的错误：

```sql
-- ✗ 错误：把每日 UV 相加得到周 UV（同一个人在多天出现被重复计数）
SELECT sum(daily_uv) FROM (SELECT event_date, uniq(user_id) AS daily_uv FROM ... GROUP BY event_date);

-- ✓ 正确：直接对整周去重
SELECT uniq(user_id) FROM ods.user_events WHERE event_date BETWEEN '2026-10-01' AND '2026-10-07';

-- ✓ 预聚合表保存可合并状态，月/周 UV 通过 Merge 得到
SELECT toStartOfWeek(day) AS week, uniqMerge(uv_state) AS wau FROM dws.uv_daily GROUP BY week;
```

### 3. 预聚合（可合并的 UV 状态）

```sql
CREATE TABLE dws.uv_daily_local (
    day Date, channel LowCardinality(String), pv UInt64, uv_state AggregateFunction(uniq, UInt64)
) ENGINE = ReplicatedAggregatingMergeTree(...) PARTITION BY toYYYYMM(day) ORDER BY (channel, day);

CREATE MATERIALIZED VIEW dws.uv_daily_mv TO dws.uv_daily_local AS
SELECT event_date AS day, channel, count() AS pv, uniqState(user_id) AS uv_state
FROM ods.user_events_local WHERE event_type = 'view' GROUP BY day, channel;
```

这样“日 → 周 → 月”都从 `uv_state` 合并，**既快又保持去重语义**。

## 三、漏斗分析：windowFunnel

**需求**：统计用户在 N 小时内依次完成“浏览商品 → 加购 → 下单 → 支付”各步骤的人数。

```sql
SELECT level, count() AS users
FROM (
    SELECT user_id,
           windowFunnel(86400)(                     -- 窗口 24 小时（秒）；从第一步开始计时
               event_time,                          -- 时间列（必须是 DateTime/UInt）
               event_type = 'view',                 -- 步骤 1
               event_type = 'add_cart',             -- 步骤 2
               event_type = 'order',                -- 步骤 3
               event_type = 'pay'                   -- 步骤 4
           ) AS level                               -- 返回该用户走到的最深步骤数（0~4）
    FROM ods.user_events
    WHERE event_date BETWEEN '2026-10-01' AND '2026-10-07'
    GROUP BY user_id
)
GROUP BY level ORDER BY level;
```

- 结果是“**最深到达第 level 步的用户数**”，累计到达人数需要做后缀和（到达第 k 步的人数 = level ≥ k 的人数之和）；
- 条件**必须按顺序**发生（中间可夹杂其他事件）；可加 `'strict_order'`、`'strict_deduplication'`、`'strict_increase'` 等模式调整严格程度；
- 步骤条件可带属性：`event_type='view' AND channel='ads'`，按渠道/平台/日期**分组对比转化率**：

```sql
SELECT channel,
       countIf(level >= 1) AS s1, countIf(level >= 2) AS s2, countIf(level >= 4) AS s4,
       round(s4 / s1 * 100, 2) AS conv_rate
FROM ( SELECT user_id, any(channel) AS channel, windowFunnel(86400)(event_time, event_type='view', event_type='add_cart', event_type='order', event_type='pay') AS level
       FROM ods.user_events WHERE event_date BETWEEN '2026-10-01' AND '2026-10-07' GROUP BY user_id )
GROUP BY channel ORDER BY s1 DESC;
```

**性能与正确性**：

- 分片键为 user_id 时，**每个分片本地计算漏斗，再汇总各 level 的计数**（`GROUP BY level` 的合并开销极小）；
- 先用 `WHERE` 的**时间范围、必要的事件类型**缩小扫描（`event_type IN ('view','add_cart','order','pay')` 命中排序键前缀）；
- 老办法“多次自连接 + 时间比较”慢且易错，**优先用 windowFunnel**。

## 四、留存分析：retention

**需求**：某日新增/活跃用户，在之后第 1、3、7 天是否回访。

```sql
-- 以 10-01 为起始日的次日、3 日、7 日留存
SELECT sum(r[1]) AS day0_users,                    -- 起始日活跃（作为分母）
       sum(r[2]) AS day1_retained,
       sum(r[3]) AS day3_retained,
       sum(r[4]) AS day7_retained,
       round(day1_retained / day0_users * 100, 2) AS d1_rate
FROM (
    SELECT user_id,
           retention(
               event_date = '2026-10-01',          -- 条件 1：起始日活跃
               event_date = '2026-10-02',          -- 条件 2：次日活跃（且条件 1 成立才计 1）
               event_date = '2026-10-04',
               event_date = '2026-10-08'
           ) AS r                                  -- 数组 [1,0/1,0/1,0/1]：第一个条件成立才可能后续为 1
    FROM ods.user_events
    WHERE event_date IN ('2026-10-01','2026-10-02','2026-10-04','2026-10-08')
    GROUP BY user_id
);
```

- `retention(cond1, cond2, …)` 返回 0/1 数组，**第一个条件成立时，后续每个条件是否成立**；一次扫描得到全部留存点；
- 滚动留存（N 日内任意回访）、**新增用户留存**（起始集合限定为首次访问用户：需要“首次事件日”，可用 `min(event_date)` 子查询或维表）等变体，用 `min/max/groupArray` 组合实现；
- 大规模留存矩阵（每日 cohort × 天数）可用**日维度用户 Bitmap**预计算（见下）。

## 五、路径、会话与序列分析

### 1. 序列匹配

```sql
-- 用户是否“先浏览 → 加购 → 并在加购后 30 分钟内下单”（pattern 语法）
SELECT user_id
FROM ods.user_events WHERE event_date = '2026-10-01'
GROUP BY user_id
HAVING sequenceMatch('(?1)(?t<=1800)(?2)(?t<=1800)(?3)')(
          event_time, event_type = 'view', event_type = 'add_cart', event_type = 'order');
-- sequenceCount 统计出现次数；sequenceMatchEvents 返回匹配到的事件时间
```

### 2. 会话切分与路径

```sql
-- 以 30 分钟无操作为界切分会话（窗口函数 + 累计和）
SELECT user_id, event_time, page,
       sum(new_session) OVER (PARTITION BY user_id ORDER BY event_time) AS session_no
FROM (
    SELECT user_id, event_time, page,
           if(event_time - lagInFrame(event_time, 1, event_time) OVER (PARTITION BY user_id ORDER BY event_time
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) > 1800, 1, 0) AS new_session
    FROM ods.user_events WHERE event_date = '2026-10-01'
);
-- 页面路径 Top N：groupArray 把一个会话内页面按时间串成数组，再统计路径出现次数
SELECT arrayStringConcat(arraySlice(groupArray(page), 1, 5), ' → ') AS path, count() AS sessions
FROM (SELECT session_id, event_time, page FROM ods.user_events WHERE event_date = '2026-10-01' ORDER BY session_id, event_time)
GROUP BY session_id ORDER BY sessions DESC LIMIT 20;
```

要点：

- 会话 ID 最好**客户端/埋点侧直接生成**并上报，避免 SQL 里复杂切分；
- 路径分析数据量大，**先限定日期与入口页面**，必要时对用户采样；
- 窗口函数需要把同一用户数据集中在一个分片（user_id 分片键）才高效。

## 六、分布、TopK 与采样

| 需求 | 函数/做法 |
| --- | --- |
| 响应时间分位数 | `quantileTDigest(0.99)(latency)`（近似、可合并）、`quantilesTDigest(0.5,0.9,0.99)(latency)`；精确 `quantileExact` 内存大 |
| 热门页面/商品 TopK | `topK(10)(page)`（近似，Space-Saving 算法）、`topKWeighted`；精确则 `GROUP BY ... ORDER BY count() DESC LIMIT 10` |
| 属性取最新值 | `argMax(value, ts)`；最早 `argMin` |
| 条件聚合 | `countIf / sumIf / avgIf`，一次扫描多指标，替代多条 SQL |
| 数组展开 | `arrayJoin(tags)` 把标签数组展开成行再聚合 |
| 日期分桶 | `toStartOfInterval(event_time, INTERVAL 5 MINUTE)`、`toStartOfHour` |
| 汇总行 | `GROUP BY ... WITH TOTALS / ROLLUP / CUBE` |
| **采样** | 建表 `SAMPLE BY intHash32(user_id)`，查询 `SAMPLE 0.1` 只读约 10% 用户，结果按比例放大；探索性分析大幅提速（需要采样表达式在排序键中） |

```sql
SELECT toStartOfFiveMinute(event_time) AS t,
       count() AS req, countIf(status >= 500) AS err,
       round(err / req * 100, 3) AS err_rate, quantileTDigest(0.99)(latency_ms) AS p99
FROM ods.access_log WHERE event_date = today() GROUP BY t ORDER BY t;
```

## 七、Bitmap：人群圈选与用户集合

当需要对**用户集合做交并差**（“买过 A 且看过 B 但没买过 C”），逐步 Join 太慢。**RoaringBitmap** 把整数集合压缩存储，集合运算在内存里极快（见 [位图](#/cs/algo-engineering)）。

```sql
-- 每个标签/事件一个用户集合（user_id 必须是整数；非整数先映射成连续整数 ID）
CREATE TABLE dws.tag_users (tag String, day Date, users AggregateFunction(groupBitmap, UInt64))
ENGINE = AggregatingMergeTree ORDER BY (tag, day);

INSERT INTO dws.tag_users
SELECT concat('event:', event_type), event_date, groupBitmapState(user_id) FROM ods.user_events GROUP BY event_type, event_date;

-- 人群计算：买过(pay) 且 看过(view) 但没有 add_cart 的用户数
WITH
  (SELECT groupBitmapMergeState(users) FROM dws.tag_users WHERE tag='event:pay')       AS pay,
  (SELECT groupBitmapMergeState(users) FROM dws.tag_users WHERE tag='event:view')      AS view,
  (SELECT groupBitmapMergeState(users) FROM dws.tag_users WHERE tag='event:add_cart')  AS cart
SELECT bitmapCardinality(bitmapAndnot(bitmapAnd(pay, view), cart)) AS target_users;
```

适用：**标签系统、人群圈选、留存矩阵（日活 Bitmap 做交集）、精确 UV 去重**（用户 ID 连续且范围有限时 Bitmap 可得到**精确**去重）。注意：ID 稀疏/范围巨大时压缩效果差；需要稳定的“用户 → 整数 ID”映射。

## 八、实时看板的数据流

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="行为分析数据流：埋点经网关写入 Kafka；Flink 做清洗、去重、ID 打通和宽表化后批量写入 ClickHouse 明细表；物化视图生成分钟和小时汇总表；看板查询汇总表并通过 Redis 缓存；漏斗留存路径等探索性分析直接查询明细；超长周期的数据降采样或归档到对象存储">
<rect class="b1" x="20" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="65" text-anchor="middle" dominant-baseline="middle">埋点 SDK</text>
<rect class="b5" x="160" y="40" width="100" height="50" rx="8"/>
<text class="tb" x="210" y="65" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<rect class="b3" x="290" y="30" width="140" height="70" rx="8"/>
<text class="tb" x="360" y="54" text-anchor="middle" dominant-baseline="middle">Flink</text>
<text class="ts" x="360" y="76" text-anchor="middle">清洗·去重·ID 打通·宽表</text>
<line class="l" x1="130" y1="65" x2="160" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="65" x2="290" y2="65" marker-end="url(#arr)"/>
<rect class="b2" x="460" y="30" width="150" height="70" rx="8"/>
<text class="tb" x="535" y="54" text-anchor="middle" dominant-baseline="middle">ClickHouse 明细</text>
<text class="ts" x="535" y="76" text-anchor="middle">批量写入 · 本地表</text>
<line class="l" x1="430" y1="65" x2="460" y2="65" marker-end="url(#arr)"/>
<rect class="b4" x="640" y="30" width="140" height="70" rx="8"/>
<text class="tb" x="710" y="54" text-anchor="middle" dominant-baseline="middle">汇总表（MV）</text>
<text class="ts" x="710" y="76" text-anchor="middle">分钟 / 小时 / 天</text>
<line class="l" x1="610" y1="65" x2="640" y2="65" marker-end="url(#arr)"/>
<rect class="b1" x="460" y="140" width="150" height="56" rx="8"/>
<text class="tb" x="535" y="162" text-anchor="middle" dominant-baseline="middle">探索分析</text>
<text class="ts" x="535" y="182" text-anchor="middle">漏斗·留存·路径 → 查明细</text>
<rect class="b5" x="640" y="140" width="140" height="56" rx="8"/>
<text class="tb" x="710" y="162" text-anchor="middle" dominant-baseline="middle">实时看板</text>
<text class="ts" x="710" y="182" text-anchor="middle">查汇总 + Redis 缓存</text>
<line class="l" x1="535" y1="100" x2="535" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="710" y1="100" x2="710" y2="140" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="216" width="760" height="70" rx="10"/>
<text class="ts" x="36" y="240">• 看板高并发 → 汇总表 + 缓存 + 限流；探索分析低并发大扫描 → 明细，限制时间范围与并发、独立队列/资源组</text>
<text class="ts" x="36" y="260">• 旧数据：TTL 降采样或迁冷层/对象存储；迟到数据：汇总表按事件时间落分区，允许“修正窗口”并重算最近窗口</text>
<text class="ts" x="36" y="278">• 指标口径统一：UV 口径、会话口径、去重规则写入指标字典，避免“同名不同数”</text>
</svg>
<figcaption>图 1：行为分析的数据流与分层查询</figcaption>
</figure>

## 九、与其他方案对比

| | ClickHouse | Doris / StarRocks | Elasticsearch | 商业行为分析（神策、GrowingIO 等） |
| --- | --- | --- | --- | --- |
| 行为分析函数 | **丰富**（windowFunnel/retention/sequenceMatch/Bitmap） | 有（窗口漏斗、Bitmap 等，随版本） | 弱（聚合为主） | 产品化，开箱即用 |
| 高并发点查/看板 | 一般（需预聚合+缓存） | **较强**（前缀索引、物化视图、MySQL 协议） | 强（检索） | — |
| 更新/删除 | 弱（Replacing/mutation） | 主键模型较好 | 文档级 | — |
| 运维 | 中（集群、Keeper） | 中（FE/BE） | 中 | 低（SaaS/私有化） |
| 适合 | 海量事件明细与自助分析、日志与指标分析 | 实时数仓、混合负载 | 全文检索、日志检索 | 缺乏研发资源的业务团队 |

选择见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap)。

## 十、常见坑

| 坑 | 对策 |
| --- | --- |
| 把每日 UV 相加当周 UV | 直接对整周去重，或用 `uniqState/uniqMerge` 的可合并状态 |
| 全部用 `uniqExact`，内存爆炸/慢 | 默认 `uniq`/`uniqCombined`；仅对账用精确 |
| 分片键不是 user_id，漏斗/留存/窗口函数要跨分片 | 以 user_id 为分片键；或接受 shuffle 代价 |
| 漏斗不限时间范围，扫全量明细 | 加分区日期范围、事件类型过滤；先小范围验证 |
| 事件时间乱序/迟到，漏斗步骤错乱 | 用事件时间；容忍窗口；`strict_order` 等模式按口径选择 |
| 匿名与登录用户未打通，同一人被算两次 | ID-Mapping，统一 uid |
| 看板每次请求都扫明细 | 物化视图汇总 + Redis 缓存 + 限流 |
| Bitmap 用在非整数/稀疏巨大 ID 上 | 先映射为连续整数 ID |
| Map/JSON 里放高频过滤字段 | 拆成独立列 |
| 重复上报导致 PV 虚高 | event_id 去重（写入前或 Replacing） |
| 指标口径不一致 | 指标字典 + 统一的汇总层（DWS），不让各看板自写 SQL |
| 采样结果直接当精确值汇报 | 标注采样比例与误差，关键指标用全量 |

## 面试追问

> [!QUESTION] 用 ClickHouse 怎么做漏斗分析？
> 用 windowFunnel(窗口秒数)(时间列, 步骤1条件, 步骤2条件, …) 按用户分组，返回每个用户在时间窗口内按顺序走到的最深步骤，再按 level 统计人数，累计后得到每一步的到达人数和转化率。要求按用户聚合，所以分片键用 user_id 让计算在分片本地完成，并用日期和事件类型过滤缩小扫描范围。

> [!QUESTION] UV 去重怎么做？为什么不能把每天的 UV 相加？
> 近似场景用 uniq、uniqCombined 或 uniqHLL12，内存小、误差约 1% 到 2%，精确场景才用 uniqExact 或用户连续整数时的 Bitmap。每日 UV 相加会重复计算多天出现的同一用户，应对整周直接去重，或在汇总表保存 uniqState 聚合状态，周月 UV 通过 uniqMerge 合并，既快又保持去重语义。

> [!QUESTION] 留存分析怎么写？
> 用 retention 函数传入起始日活跃、次日活跃、第三日活跃等条件，按用户分组得到 0 或 1 的数组，第一个条件成立时后续条件是否成立表示是否留存，再对各位置求和并相除得到留存率。一次扫描完成全部留存点，大规模矩阵可用每日用户 Bitmap 的交集预计算。

> [!QUESTION] 行为明细表的排序键和分片键怎么设计？
> 分片键用 user_id，让同一用户事件在同一分片，漏斗、留存、路径、窗口函数都能本地计算；排序键把低基数的事件类型和日期放前面，再放 user_id 和事件时间，兼顾按事件类型过滤、按用户读取时间序列和压缩。热点属性拆成独立列，长尾属性才放 Map。

> [!QUESTION] 如何支撑高并发的实时看板？
> 明细表只用于探索分析，看板查询物化视图生成的分钟、小时、天汇总表，汇总表使用 AggregatingMergeTree 保存可合并状态，再加 Redis 缓存与限流，探索性大查询用独立资源组和并发限制。迟到数据通过事件时间落分区并允许重算最近窗口。

> [!QUESTION] 什么时候用 Bitmap？有什么限制？
> 需要对用户集合做交并差的人群圈选、标签系统、留存矩阵和精确去重时，用 RoaringBitmap 压缩存储并在内存中做集合运算，速度极快。前提是 ID 是整数且最好连续，稀疏巨大范围压缩效果差，需要稳定的用户到整数 ID 映射。
