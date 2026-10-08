---
level: 深入
tags: [PostgreSQL, 索引, B-tree, GIN, GiST, BRIN, EXPLAIN, 统计信息, JSONB, 优化器]
summary: 梳理 PostgreSQL 的六类索引及其适用场景、部分/表达式/覆盖索引，读懂 EXPLAIN (ANALYZE, BUFFERS)、统计信息与连接算法，并给出 JSONB、全文检索与常见慢查询的优化方法。
---

# 索引类型与查询优化

> [!ABSTRACT] 核心要点
> - PG 有 **B-tree（默认）、Hash、GiST、SP-GiST、GIN、BRIN** 六种索引；选错类型是性能差的常见原因：**JSONB/数组/全文检索用 GIN，几何/范围/最近邻用 GiST，海量按序追加数据用 BRIN**。
> - **部分索引、表达式索引、覆盖索引**（`INCLUDE`）让索引更小更准；`CREATE INDEX CONCURRENTLY` 在线建索引不阻塞写。
> - 看计划用 **`EXPLAIN (ANALYZE, BUFFERS)`**：比较**预估行数与实际行数**——偏差大几乎总意味着统计信息问题，是坏计划的根源。
> - **Index Only Scan** 依赖 visibility map，因此 **VACUUM 越及时越有效**；表膨胀会让它退化。
> - 优化器基于**代价模型**，受 `random_page_cost`（默认 4.0，SSD 可调到 1.1~1.5）、统计信息、`work_mem` 等影响。

## 索引类型

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="六种索引类型及典型适用场景">
<rect class="b1" x="20" y="20" width="220" height="140" rx="10"/>
<text class="th" x="130" y="44" text-anchor="middle">B-tree（默认）</text>
<text class="ts" x="130" y="70" text-anchor="middle">等值、范围、排序、LIKE 'abc%'</text>
<text class="ts" x="130" y="90" text-anchor="middle">支持 UNIQUE、多列、INCLUDE</text>
<text class="ts" x="130" y="110" text-anchor="middle">&lt; &lt;= = &gt;= &gt; BETWEEN IN</text>
<text class="ta" x="130" y="140" text-anchor="middle">绝大多数场景</text>
<rect class="b2" x="260" y="20" width="220" height="140" rx="10"/>
<text class="th" x="370" y="44" text-anchor="middle">GIN（倒排）</text>
<text class="ts" x="370" y="70" text-anchor="middle">一个值包含多个键：数组、JSONB、</text>
<text class="ts" x="370" y="90" text-anchor="middle">全文检索 tsvector、trigram 模糊</text>
<text class="ts" x="370" y="110" text-anchor="middle">@&gt;  ?  @@  &amp;&amp;  LIKE '%abc%'</text>
<text class="ta" x="370" y="140" text-anchor="middle">读快，写入/更新慢</text>
<rect class="b3" x="500" y="20" width="220" height="140" rx="10"/>
<text class="th" x="610" y="44" text-anchor="middle">GiST（通用搜索树）</text>
<text class="ts" x="610" y="70" text-anchor="middle">几何、范围类型、全文、</text>
<text class="ts" x="610" y="90" text-anchor="middle">PostGIS 空间索引、最近邻 &lt;-&gt;</text>
<text class="ts" x="610" y="110" text-anchor="middle">排他约束 EXCLUDE</text>
<text class="ta" x="610" y="140" text-anchor="middle">有损、可扩展</text>
<rect class="b4" x="20" y="180" width="220" height="130" rx="10"/>
<text class="th" x="130" y="204" text-anchor="middle">BRIN（块范围）</text>
<text class="ts" x="130" y="230" text-anchor="middle">只记录每组页的 min/max</text>
<text class="ts" x="130" y="250" text-anchor="middle">极小；要求数据与物理顺序相关</text>
<text class="ts" x="130" y="270" text-anchor="middle">时序/日志按时间追加的大表</text>
<text class="ta" x="130" y="296" text-anchor="middle">体积是 B-tree 的几百分之一</text>
<rect class="b5" x="260" y="180" width="220" height="130" rx="10"/>
<text class="th" x="370" y="204" text-anchor="middle">Hash</text>
<text class="ts" x="370" y="230" text-anchor="middle">仅支持等值 =</text>
<text class="ts" x="370" y="250" text-anchor="middle">PG 10 起写 WAL，可用</text>
<text class="ts" x="370" y="270" text-anchor="middle">一般 B-tree 已足够</text>
<text class="ta" x="370" y="296" text-anchor="middle">很少需要</text>
<rect class="b" x="500" y="180" width="220" height="130" rx="10"/>
<text class="th" x="610" y="204" text-anchor="middle">SP-GiST</text>
<text class="ts" x="610" y="230" text-anchor="middle">空间分区树：四叉树、基数树、</text>
<text class="ts" x="610" y="250" text-anchor="middle">k-d 树；非均衡数据结构</text>
<text class="ts" x="610" y="270" text-anchor="middle">电话号码前缀、点数据</text>
<text class="ta" x="610" y="296" text-anchor="middle">特定场景</text>
</svg>
<figcaption>图 1：PostgreSQL 六类索引与典型场景</figcaption>
</figure>

### B-tree

与 MySQL 的 B+ 树类似（实际是 B+ 树变体，页内有指向兄弟节点的链接），**但叶子存 `ctid` 而非主键/整行**，因此：

- 查询需要 **“索引 → 堆”回表**，除非 **Index Only Scan**（要求所需列都在索引中，且对应堆页在 visibility map 中标记为 all-visible）；
- 多列索引遵循**最左前缀**，列顺序：等值条件列在前、范围列在后、排序列兼顾；
- `INCLUDE`（11+）把**非键列**放到叶子里实现覆盖，不参与排序/唯一性：

```sql
CREATE INDEX idx_orders_user ON orders (user_id, created_at DESC) INCLUDE (status, amount);
-- 可 Index Only Scan：SELECT status, amount FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 20;
```

### 部分索引与表达式索引

```sql
-- 部分索引：只索引需要的行，体积小、维护成本低（适合“少数状态的热数据”）
CREATE INDEX idx_task_pending ON task (created_at) WHERE status = 'PENDING';

-- 唯一性也可以是部分的：软删除表上“有效数据唯一”
CREATE UNIQUE INDEX uk_user_email ON users (email) WHERE deleted_at IS NULL;

-- 表达式索引：查询条件必须与表达式一致才能命中
CREATE INDEX idx_user_lower_email ON users (lower(email));
SELECT * FROM users WHERE lower(email) = 'a@x.com';       -- 命中
```

> [!NOTE] 对比 MySQL
> MySQL 8.0.13+ 才有函数索引，没有部分索引。软删除下的“有效数据唯一”在 MySQL 中常需要技巧（唯一键加删除标记列），在 PG 里一个部分唯一索引搞定。

### GIN：JSONB、数组、全文检索

GIN 是**倒排索引**：键 → 包含该键的行列表（posting list/tree）。

```sql
-- JSONB
CREATE INDEX idx_dev_attrs ON device USING gin (attrs jsonb_path_ops);
SELECT * FROM device WHERE attrs @> '{"model":"X1","online":true}';        -- 包含查询，命中 GIN
-- 只想索引某个键，用表达式 B-tree：
CREATE INDEX idx_dev_model ON device ((attrs->>'model'));
SELECT * FROM device WHERE attrs->>'model' = 'X1';

-- 数组
CREATE INDEX idx_post_tags ON post USING gin (tags);
SELECT * FROM post WHERE tags && ARRAY['java','pg'];                       -- 任一重叠

-- 全文检索
ALTER TABLE doc ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED;
CREATE INDEX idx_doc_tsv ON doc USING gin (tsv);
SELECT * FROM doc WHERE tsv @@ plainto_tsquery('simple', 'netty dubbo');

-- 模糊匹配 LIKE '%abc%'（pg_trgm 扩展）
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_user_name_trgm ON users USING gin (name gin_trgm_ops);
SELECT * FROM users WHERE name LIKE '%张三%';
```

- `jsonb_ops`（默认）支持 `? ?| ?& @>` 等更多操作符，`jsonb_path_ops` 只支持 `@>` 但**更小更快**；
- GIN 写入慢（`fastupdate` 使用待处理列表批量合并），**写多读少**的表要评估；
- 中文全文检索需要中文分词扩展（zhparser、pg_jieba）或使用 [Elasticsearch](#/mw/es)。

### BRIN

```sql
-- 按时间顺序追加的 10 亿行日志表：索引只有几 MB
CREATE INDEX idx_log_time ON log USING brin (created_at) WITH (pages_per_range = 64);
```

原理：每 N 个连续页（`pages_per_range`）记录一次列的最小/最大值；查询时用范围排除不可能的页。**前提：列值与物理存储顺序强相关**（自增 ID、时间戳追加）。若数据被大量乱序更新，BRIN 退化。

### GiST 与最近邻

```sql
CREATE INDEX idx_shop_geo ON shop USING gist (location);              -- PostGIS geometry/geography
SELECT name FROM shop ORDER BY location <-> ST_MakePoint(116.4, 39.9)::geography LIMIT 10;   -- KNN 最近的 10 家
```

范围类型 + **排他约束**防止预订冲突（同一会议室时间段不重叠）：

```sql
CREATE EXTENSION btree_gist;
ALTER TABLE booking ADD CONSTRAINT no_overlap EXCLUDE USING gist (room_id WITH =, period WITH &&);
```

### 索引维护

```sql
CREATE INDEX CONCURRENTLY idx_x ON t (col);            -- 在线建，不阻塞写（耗时更长，失败会留下 INVALID 索引需清理）
REINDEX INDEX CONCURRENTLY idx_x;                      -- 12+：在线重建膨胀的索引
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes ORDER BY idx_scan; -- 找无用索引
```

索引不是越多越好：**每个索引都会让 INSERT/UPDATE 变慢、占用空间、阻碍 HOT**。定期清理 `idx_scan = 0` 的索引。

## 读懂 EXPLAIN

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT o.id, u.name FROM orders o JOIN users u ON u.id = o.user_id
WHERE o.created_at >= now() - interval '1 day' AND o.status = 'PAID';
```

```text
Hash Join  (cost=412.5..9021.3 rows=380 width=40) (actual time=3.2..48.7 rows=12840 loops=1)
  Hash Cond: (o.user_id = u.id)
  Buffers: shared hit=2210 read=640
  ->  Bitmap Heap Scan on orders o  (cost=88.1..7500 rows=380 width=16) (actual time=1.1..30.2 rows=12840 loops=1)
        Recheck Cond: (created_at >= ...)
        Filter: (status = 'PAID')   Rows Removed by Filter: 2100
        Heap Blocks: exact=1850
        ->  Bitmap Index Scan on idx_orders_created  (actual time=0.9..0.9 rows=14940 loops=1)
  ->  Hash  (actual time=2.0..2.0 rows=5000 loops=1)
        Buckets: 8192  Batches: 1  Memory Usage: 310kB
        ->  Seq Scan on users u
Planning Time: 0.4 ms   Execution Time: 52.1 ms
```

### 关键字段

| 字段 | 含义 |
| --- | --- |
| `cost=启动..总` | 优化器估算（相对单位，非毫秒） |
| **`rows=` 预估 vs `actual rows`** | **偏差一个数量级以上通常就是问题所在**（示例中预估 380 实际 12840） |
| `actual time=首行..全部` | 实际耗时（毫秒），`loops` 要**乘**（嵌套循环里的内层） |
| `Buffers: shared hit/read` | 命中 shared_buffers / 读磁盘（或 OS cache）的页数 |
| `Rows Removed by Filter` | 取出后被过滤掉的行数，**过多说明索引选择性差或缺少索引** |
| `Heap Blocks` / `Recheck` | Bitmap 扫描的细节 |
| `Batches > 1`（Hash）、`Sort Method: external merge Disk` | **work_mem 不足，溢出到磁盘** |

### 扫描方式

| 节点 | 说明 |
| --- | --- |
| **Seq Scan** | 全表扫描；小表或需要大部分行时是最优 |
| **Index Scan** | 逐个通过索引取行回表（随机 IO），适合选择性高 |
| **Index Only Scan** | 不回表（依赖 VM）；`Heap Fetches` 高说明 VM 未更新，需 VACUUM |
| **Bitmap Index Scan + Bitmap Heap Scan** | 先收集所有匹配行的页位图，再**按物理顺序**读页，适合中等选择性，可合并多个索引（`BitmapAnd/Or`） |

### 连接算法

| 算法 | 原理 | 适用 |
| --- | --- | --- |
| **Nested Loop** | 外表每行去内表（最好有索引）查 | 外表小、内表有索引；OLTP 常见 |
| **Hash Join** | 小表建哈希表，大表探测 | 等值连接、无索引、中大表；注意 work_mem |
| **Merge Join** | 双方按连接键排序后归并 | 两侧已有序（索引）或大表等值连接 |

### 排序、聚合、并行

- `Sort`：内存快排或外部归并（`Sort Method: external merge  Disk: 52MB` → 调 `work_mem`）；`LIMIT` + 索引有序可避免排序（`Incremental Sort` 利用部分有序，13+）；
- 聚合：`HashAggregate`（内存）/ `GroupAggregate`（要排序）；
- **并行查询**：`Gather` + `Parallel Seq Scan`，`max_parallel_workers_per_gather` 控制；大表聚合/扫描受益，OLTP 小查询一般不会并行。

## 统计信息与优化器

优化器依据 `pg_statistic`（`ANALYZE` 采集：行数、NULL 比例、不同值数、最常见值 MCV、直方图、**列间相关性**）估算选择度。

```sql
ANALYZE orders;                                           -- 手动更新统计
SELECT attname, n_distinct, most_common_vals FROM pg_stats WHERE tablename='orders' AND attname='status';
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500; -- 倾斜列提高采样精度（默认 default_statistics_target=100）
CREATE STATISTICS st_city_zip (dependencies) ON city, zip FROM address;   -- 多列相关性（扩展统计，10+）
```

**估算不准的典型原因**：

1. 统计信息过期（大量写入后 autovacuum 的 analyze 还没跑）；
2. **多列相关性**（`city='北京' AND zip='100000'` 被当作独立事件相乘），用扩展统计解决；
3. 表达式、函数条件没有统计（建**表达式索引**会同时建统计）；
4. 数据倾斜，需调高统计目标；
5. 参数化查询的**通用计划（generic plan）** 与自定义计划差异：预编译语句执行 5 次后可能切到 generic plan，对倾斜数据可能变差，可设 `plan_cache_mode = force_custom_plan`。

关键代价参数：

| 参数 | 默认 | 建议 |
| --- | --- | --- |
| `random_page_cost` | 4.0 | **SSD 调到 1.1~1.5**，否则优化器过度偏向顺序扫描 |
| `effective_cache_size` | 4GB | 设为可用缓存总量（内存 50%~75%） |
| `work_mem` | 4MB | 参见 [架构、WAL 与存储结构](#/pg/architecture) |
| `default_statistics_target` | 100 | 复杂/倾斜表可到 200~1000 |
| `jit` | on（12+） | OLTP 短查询 JIT 可能得不偿失，可对 OLTP 库关闭 |

## 常见慢查询模式与优化

| 模式 | 问题 | 优化 |
| --- | --- | --- |
| `WHERE col::text = ...`、函数包裹列 | 索引失效 | 表达式索引或改写条件 |
| `LIKE '%abc%'` | B-tree 无法使用 | `pg_trgm` + GIN |
| `OFFSET 100000 LIMIT 20` | 要扫描并丢弃前 10 万行 | **键集分页（keyset pagination）**：`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20` |
| `COUNT(*)` 大表 | 全表/全索引扫描（MVCC 无法直接给行数） | 近似值 `reltuples`、汇总表、缓存；条件计数用合适索引 |
| `IN (子查询)` / `NOT IN` | NOT IN 遇 NULL 语义坑且慢 | `EXISTS` / `NOT EXISTS` / `LEFT JOIN ... IS NULL` |
| `OR` 条件 | 可能放弃索引 | `UNION ALL` 或 Bitmap OR（优化器可自动） |
| `SELECT *` | 读取 TOAST 大字段、阻止 Index Only Scan | 只查需要的列 |
| CTE | 12+ 非递归 CTE 默认**内联**（`MATERIALIZED` 可强制物化），11 及以前总是物化形成优化屏障 | 关注版本差异 |
| 大批量 `UPDATE` | 产生大量死元组与 WAL | 分批（按主键范围）、低峰执行 |
| N+1 查询（应用层） | 网络往返多 | `JOIN`/`IN` 批量，或 JDBC 批处理 |

```sql
-- 键集分页 vs OFFSET
SELECT id, created_at FROM orders
WHERE (created_at, id) < ('2026-01-01 10:00:00', 987654)
ORDER BY created_at DESC, id DESC LIMIT 20;       -- 需要 (created_at, id) 复合索引
```

### 定位慢 SQL：pg_stat_statements

```sql
CREATE EXTENSION pg_stat_statements;                       -- shared_preload_libraries 中预加载
SELECT calls, round(total_exec_time::numeric,1) AS total_ms, round(mean_exec_time::numeric,2) AS mean_ms,
       rows, left(query,100)
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

另配 `log_min_duration_statement = 500`（记录超过 500ms 的 SQL）、`auto_explain`（自动记录慢查询计划）。对比 MySQL 的流程见 [EXPLAIN 与 SQL 调优](#/mysql/optimize)。

## 面试追问

> [!QUESTION] PostgreSQL 有哪些索引类型？分别什么时候用？
> B-tree（默认，等值范围排序）、GIN（数组/JSONB/全文/trigram 的倒排）、GiST（几何、范围、KNN、排他约束）、BRIN（按序追加的海量数据，体积极小）、Hash（仅等值，很少用）、SP-GiST（空间分区结构）。

> [!QUESTION] 部分索引和表达式索引有什么价值？
> 部分索引只索引满足条件的行，更小更快，可实现“软删除下有效数据唯一”；表达式索引让函数/计算条件也能走索引（如 `lower(email)`），查询表达式须与索引定义一致。

> [!QUESTION] EXPLAIN 里最该关注什么？
> 预估行数与实际行数的偏差（统计问题）、Rows Removed by Filter（选择性）、Buffers 的读取量、是否溢出磁盘（外部排序、Hash 多批）、Index Only Scan 的 Heap Fetches，以及各节点 actual time × loops。

> [!QUESTION] 为什么 Index Only Scan 有时仍会访问堆？
> PG 的索引不含可见性信息，需要 visibility map 确认页是否全部可见；VM 未更新（VACUUM 不及时、页被频繁修改）时必须回堆检查，`Heap Fetches` 会很高。

> [!QUESTION] 大表深分页怎么优化？
> 避免 OFFSET，改用键集分页（基于上一页最后一行的排序键），配合复合索引；需要跳页时限制最大页数或借助搜索引擎。
