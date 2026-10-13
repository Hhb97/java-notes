---
level: 进阶
tags: [EXPLAIN, 慢查询, JOIN, Hash Join, filesort, 深分页]
summary: 系统掌握 EXPLAIN 每一列与 EXPLAIN ANALYZE 的读法，理解 JOIN、排序、分组、COUNT 在 MySQL 内部怎么执行，并通过完整案例掌握慢 SQL 的定位与改写套路。
---

# EXPLAIN 与 SQL 调优

> [!ABSTRACT] 核心要点
> - 看 EXPLAIN 先看四列：`type`（访问方式，至少到 range）、`key` + `key_len`（用了哪个索引的几列）、`rows × filtered`（估算扫描量）、`Extra`（`Using filesort` / `Using temporary` / `Using join buffer` 是危险信号）。
> - `EXPLAIN` 是**估算**，`EXPLAIN ANALYZE`（8.0.18+）**真实执行**并给出每个算子的实际耗时与行数，排查“估算和实际差很远”的问题必备。
> - JOIN：被驱动表关联字段有索引走 Index NLJ；没有索引时 8.0.18+ 用 **Hash Join**（8.0.20 起彻底替代 BNL）。
> - 深分页的本质是“扫描并丢弃大量行”，用**延迟关联**或**游标分页**解决。
> - 优化器选错索引多数源于统计信息偏差或 `ORDER BY ... LIMIT` 的代价误判，手段依次是 `ANALYZE TABLE`、改写 SQL / 调整索引、`FORCE INDEX` 兜底。

## EXPLAIN 每一列

```sql
EXPLAIN SELECT o.id, o.amount
FROM orders o JOIN user u ON o.user_id = u.id
WHERE u.city = 'Hangzhou' AND o.status = 1;
```

| 列 | 含义 | 关注点 |
| --- | --- | --- |
| `id` | 查询序号 | id 相同从上到下执行；id 不同，大的先执行（子查询） |
| `select_type` | `SIMPLE`、`PRIMARY`、`SUBQUERY`、`DERIVED`、`UNION`、`DEPENDENT SUBQUERY`、`MATERIALIZED` | `DEPENDENT SUBQUERY` 表示外层每行执行一次子查询，重点关注 |
| `table` | 访问的表，`<derived2>` 表示派生表 | |
| `partitions` | 命中的分区 | |
| `type` | 访问类型 | 见下图与下表 |
| `possible_keys` | 可能用到的索引 | 为空说明结构上没有可用索引 |
| `key` | 实际选择的索引 | 与 possible_keys 对比，判断是否选错 |
| `key_len` | 使用的索引字节数 | 推算联合索引用到了几列 |
| `ref` | 与索引比较的是常量还是哪一列 | `func` 表示经过函数转换，警惕隐式转换 |
| `rows` | 估算需要扫描的行数 | 基于统计信息，不是精确值 |
| `filtered` | 经过表条件过滤后剩余行的百分比估算 | `rows × filtered / 100` ≈ 传给下一个表的行数 |
| `Extra` | 额外信息 | 见下文 |

### type：访问类型层级

<figure class="fig">
<svg viewBox="0 0 740 170" class="dg" role="img" aria-label="EXPLAIN type 列从 system 到 ALL 的性能层级">
<text class="ts" x="25" y="24">好</text>
<text class="ts" x="715" y="24" text-anchor="end">差</text>
<text class="ts" x="370" y="24" text-anchor="middle">线上 SQL 至少达到 range，最好 ref 及以上</text>
<line class="la" x1="25" y1="38" x2="713" y2="38" marker-end="url(#arr-a)"/>
<rect class="b2" x="25" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="70" y="78" text-anchor="middle" dominant-baseline="middle">system</text>
<rect class="b2" x="125" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="170" y="78" text-anchor="middle" dominant-baseline="middle">const</text>
<rect class="b2" x="225" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="270" y="78" text-anchor="middle" dominant-baseline="middle">eq_ref</text>
<rect class="b1" x="325" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="370" y="78" text-anchor="middle" dominant-baseline="middle">ref</text>
<rect class="b1" x="425" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="470" y="78" text-anchor="middle" dominant-baseline="middle">range</text>
<rect class="b3" x="525" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="570" y="78" text-anchor="middle" dominant-baseline="middle">index</text>
<rect class="b4" x="625" y="56" width="90" height="44" rx="6"/>
<text class="tm" x="670" y="78" text-anchor="middle" dominant-baseline="middle">ALL</text>
<text class="ts" x="70" y="122" text-anchor="middle">表只有一行</text>
<text class="ts" x="70" y="140" text-anchor="middle">（系统表）</text>
<text class="ts" x="170" y="122" text-anchor="middle">主键/唯一索引</text>
<text class="ts" x="170" y="140" text-anchor="middle">常量等值</text>
<text class="ts" x="270" y="122" text-anchor="middle">JOIN 被驱动表</text>
<text class="ts" x="270" y="140" text-anchor="middle">唯一键匹配</text>
<text class="ts" x="370" y="122" text-anchor="middle">非唯一索引</text>
<text class="ts" x="370" y="140" text-anchor="middle">等值匹配</text>
<text class="ts" x="470" y="122" text-anchor="middle">索引范围扫描</text>
<text class="ts" x="470" y="140" text-anchor="middle">&gt; &lt; IN BETWEEN</text>
<text class="ts" x="570" y="122" text-anchor="middle">扫描整棵</text>
<text class="ts" x="570" y="140" text-anchor="middle">索引树</text>
<text class="ts" x="670" y="122" text-anchor="middle">全表扫描</text>
<text class="ts" x="670" y="140" text-anchor="middle">（聚簇索引）</text>
</svg>
<figcaption>图 1：常见 type 的性能层级（省略了 fulltext、ref_or_null、index_merge、unique_subquery 等，位于 ref 与 range 之间）</figcaption>
</figure>

| type | 触发条件 | 示例 |
| --- | --- | --- |
| `const` | 主键或唯一索引全部列与常量等值比较，最多一行 | `WHERE id = 1` |
| `eq_ref` | JOIN 时被驱动表通过主键/唯一非空索引关联，每次最多一行 | `ON o.user_id = u.id`（u 为被驱动表） |
| `ref` | 非唯一索引等值，或唯一索引的最左前缀 | `WHERE user_id = 10` |
| `ref_or_null` | ref 再加上 `OR col IS NULL` | |
| `index_merge` | 多个索引分别扫描后取交集/并集 | `WHERE a = 1 OR b = 2` |
| `range` | 索引范围扫描 | `BETWEEN`、`>`、`IN (...)`、`LIKE 'x%'` |
| `index` | 遍历整棵二级索引（通常配合覆盖索引） | `SELECT COUNT(*) FROM t` |
| `ALL` | 全表扫描 | 无可用索引 |

> [!WARNING] `type=index` 不等于用上了索引
> 它表示把整棵索引树从头扫到尾，只是比 ALL 扫的页更少（二级索引比聚簇索引窄）。千万级表上依然很慢。

### key_len 计算

key_len 用来判断联合索引实际用到了几列。规则（utf8mb4）：

| 类型 | 字节数 |
| --- | --- |
| `TINYINT` / `SMALLINT` / `INT` / `BIGINT` | 1 / 2 / 4 / 8 |
| `DATE` / `DATETIME` / `TIMESTAMP` | 3 / 5 / 4（5.6.4+，不含小数秒） |
| `CHAR(n)` | 4n |
| `VARCHAR(n)` | 4n + 2（变长长度字节） |
| 允许 NULL | 再 + 1 |

例：`idx(user_id BIGINT NOT NULL, status TINYINT NOT NULL, create_time DATETIME NULL)`，若 `key_len = 9`，说明只用到了 `user_id` 和 `status`（8 + 1），`create_time` 没用于定位（例如它前面某列是范围，或 ORDER BY 中只是利用了顺序）。

### Extra 常见值

| Extra | 含义 | 好坏 |
| --- | --- | --- |
| `Using index` | 覆盖索引，不回表 | 好 |
| `Using index condition` | 索引下推 ICP | 好 |
| `Using where` | Server 层对引擎返回的行再做过滤 | 中性，结合 rows 看 |
| `Using filesort` | 无法利用索引顺序，需要额外排序 | 数据量大时差 |
| `Using temporary` | 使用临时表（GROUP BY、DISTINCT、UNION 等） | 差 |
| `Using join buffer (hash join)` | 被驱动表无可用索引，使用 Hash Join（8.0.20 前可能是 Block Nested Loop） | 差，通常该加索引 |
| `Using MRR` | 多范围读优化 | 中性 |
| `Using index for group-by` | 松散索引扫描 | 好 |
| `Using index for skip scan` | 8.0.13+ 索引跳跃扫描 | 中性 |
| `Backward index scan` | 8.0 反向扫描索引 | 好 |
| `Select tables optimized away` | 优化阶段即得出结果，如 `MIN(id)` | 好 |
| `Impossible WHERE` | 条件恒假 | — |

> [!TIP] `EXPLAIN` 之后紧跟 `SHOW WARNINGS`
> 可以看到优化器改写后的 SQL，例如子查询被转换为半连接、条件被常量传播、隐式转换被加上了 `cast()`，这是定位“为什么没走索引”的捷径。

### EXPLAIN ANALYZE 与 FORMAT=TREE

```sql
EXPLAIN FORMAT=TREE SELECT ...;     -- 8.0.16+，树形展示执行计划与估算成本
EXPLAIN ANALYZE SELECT ...;         -- 8.0.18+，真正执行 SQL，输出实际时间与行数
```

```text
-> Limit: 10 row(s)  (cost=20.5 rows=10) (actual time=852.3..852.4 rows=10 loops=1)
    -> Filter: (o.user_id = 42)  (cost=20.5 rows=10) (actual time=852.3..852.4 rows=10 loops=1)
        -> Index scan on o using PRIMARY (reverse)  (cost=20.5 rows=200)
           (actual time=0.05..790.2 rows=3200000 loops=1)
```

读法：括号里第一组 `cost`/`rows` 是估算，`actual time=首行耗时..全部行耗时`（毫秒），后面的 `rows` 是实际行数，`loops` 是执行次数（被驱动表的 loops 等于驱动表行数）。**估算 rows 与实际 rows 相差几个数量级的算子就是问题所在**——上例中优化器以为倒序扫 200 行主键就能凑够 10 行，实际扫了 320 万行（见下文案例一）。

> [!CAUTION] EXPLAIN ANALYZE 会真正执行语句
> 它主要用于 SELECT（较新版本也支持多表 UPDATE/DELETE），本质是把 SQL 完整跑一遍。在主库上对慢查询执行等于再制造一次慢查询，应放到从库或测试环境。

更深入地看优化器为什么这样选，用 optimizer trace：

```sql
SET optimizer_trace = 'enabled=on';
SELECT ...;
SELECT * FROM information_schema.OPTIMIZER_TRACE\G   -- 看 rows_estimation、considered_execution_plans
SET optimizer_trace = 'enabled=off';
```

## 慢查询日志与 pt-query-digest

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `slow_query_log` | OFF | 线上开启 |
| `long_query_time` | 10 秒 | 一般设 0.5～1 秒，核心库更低 |
| `log_queries_not_using_indexes` | OFF | 开启时配合 `log_throttle_queries_not_using_indexes` 限流，否则日志暴涨 |
| `min_examined_row_limit` | 0 | 扫描行数少于该值的不记录 |
| `log_slow_extra` | OFF | 8.0.14+，记录更多字段（如读取字节数、排序行数） |

```bash
# 按总耗时汇总最慢的 SQL 指纹（参数化后的模板）
pt-query-digest /var/lib/mysql/slow.log > slow_report.txt
# 只看某时间段、某个库
pt-query-digest --since '2024-06-01 09:00:00' --until '2024-06-01 10:00:00' \
  --filter '$event->{db} eq "order_db"' slow.log
```

报告里优先关注：**总耗时占比（Response time %）最高**的模板，而不是单次最慢的 SQL。一个 50ms 但每秒执行一千次的 SQL，比一个每天跑一次 10 秒的报表更值得优化。另外看 `Rows examine` 与 `Rows sent` 的比值，比值很大说明扫描了大量无用行。

8.0 也可以直接查 `performance_schema.events_statements_summary_by_digest` 或 `sys.statement_analysis` 获取同样的指纹聚合信息。

## 深分页优化

```sql
SELECT * FROM orders WHERE status = 1 ORDER BY create_time DESC LIMIT 1000000, 10;
```

MySQL 没有“跳过 N 行”的捷径：必须按索引顺序找出前 1000010 行，每一行都回表取整行，再在 Server 层丢掉前 1000000 行。

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="深分页直接查询与延迟关联的执行步骤对比">
<rect class="bg" x="20" y="20" width="340" height="270" rx="12"/>
<text class="tb" x="190" y="40" text-anchor="middle" dominant-baseline="middle">直接 LIMIT 1000000, 10</text>
<rect class="b1" x="40" y="56" width="300" height="44" rx="8"/>
<text class="t" x="190" y="78" text-anchor="middle" dominant-baseline="middle">扫描二级索引 1000010 条</text>
<line class="l" x1="190" y1="100" x2="190" y2="114" marker-end="url(#arr)"/>
<rect class="b4" x="40" y="116" width="300" height="44" rx="8"/>
<text class="t" x="190" y="138" text-anchor="middle" dominant-baseline="middle">回表 1000010 次（随机 I/O）</text>
<line class="l" x1="190" y1="160" x2="190" y2="174" marker-end="url(#arr)"/>
<rect class="b" x="40" y="176" width="300" height="44" rx="8"/>
<text class="t" x="190" y="198" text-anchor="middle" dominant-baseline="middle">Server 层丢弃前 1000000 行</text>
<line class="l" x1="190" y1="220" x2="190" y2="234" marker-end="url(#arr)"/>
<rect class="b2" x="40" y="236" width="300" height="44" rx="8"/>
<text class="t" x="190" y="258" text-anchor="middle" dominant-baseline="middle">返回 10 行</text>
<rect class="bg" x="380" y="20" width="340" height="270" rx="12"/>
<text class="tb" x="550" y="40" text-anchor="middle" dominant-baseline="middle">延迟关联：先取 id 再回表</text>
<rect class="b1" x="400" y="56" width="300" height="44" rx="8"/>
<text class="t" x="550" y="78" text-anchor="middle" dominant-baseline="middle">子查询走覆盖索引，只扫索引页</text>
<line class="l" x1="550" y1="100" x2="550" y2="114" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="116" width="300" height="44" rx="8"/>
<text class="t" x="550" y="138" text-anchor="middle" dominant-baseline="middle">得到 10 个 id（不回表）</text>
<line class="l" x1="550" y1="160" x2="550" y2="174" marker-end="url(#arr)"/>
<rect class="b1" x="400" y="176" width="300" height="44" rx="8"/>
<text class="t" x="550" y="198" text-anchor="middle" dominant-baseline="middle">按主键 JOIN 回表 10 次</text>
<line class="l" x1="550" y1="220" x2="550" y2="234" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="236" width="300" height="44" rx="8"/>
<text class="t" x="550" y="258" text-anchor="middle" dominant-baseline="middle">返回 10 行</text>
</svg>
<figcaption>图 2：延迟关联把一百万次回表降为 10 次，但索引扫描量不变；彻底解决要靠游标分页</figcaption>
</figure>

```sql
-- 方案一：延迟关联（需要 idx(status, create_time)，主键自动在索引中）
SELECT o.* FROM orders o
JOIN (SELECT id FROM orders WHERE status = 1
      ORDER BY create_time DESC LIMIT 1000000, 10) t ON o.id = t.id;

-- 方案二：游标（seek）分页，前端传上一页最后一条的排序值和 id
SELECT * FROM orders
WHERE status = 1
  AND (create_time < ? OR (create_time = ? AND id < ?))
ORDER BY create_time DESC, id DESC
LIMIT 10;
```

游标分页每次都是从索引中定位起点后取 10 行，性能与页码无关；代价是不能跳页。产品上可以限制最大页码（如只允许前 100 页），或用搜索引擎承担深度翻页。

## JOIN 算法与驱动表

<figure class="fig">
<svg viewBox="0 0 740 220" class="dg" role="img" aria-label="Index Nested-Loop Join 与 Hash Join 的执行方式对比">
<rect class="bg" x="20" y="20" width="340" height="190" rx="12"/>
<text class="tb" x="190" y="40" text-anchor="middle" dominant-baseline="middle">Index Nested-Loop Join</text>
<rect class="b1" x="40" y="60" width="110" height="120" rx="8"/>
<text class="tb" x="95" y="80" text-anchor="middle" dominant-baseline="middle">驱动表 t1</text>
<text class="tm" x="95" y="110" text-anchor="middle" dominant-baseline="middle">row 1</text>
<text class="tm" x="95" y="135" text-anchor="middle" dominant-baseline="middle">row 2</text>
<text class="tm" x="95" y="160" text-anchor="middle" dominant-baseline="middle">row 3</text>
<rect class="b2" x="230" y="60" width="110" height="120" rx="8"/>
<text class="tb" x="285" y="80" text-anchor="middle" dominant-baseline="middle">t2 索引</text>
<text class="ts" x="285" y="120" text-anchor="middle" dominant-baseline="middle">每行一次</text>
<text class="ts" x="285" y="140" text-anchor="middle" dominant-baseline="middle">B+ 树查找</text>
<line class="l" x1="150" y1="110" x2="228" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="150" y1="135" x2="228" y2="135" marker-end="url(#arr)"/>
<line class="l" x1="150" y1="160" x2="228" y2="160" marker-end="url(#arr)"/>
<text class="ts" x="190" y="198" text-anchor="middle" dominant-baseline="middle">代价 ≈ N + N × log M</text>
<rect class="bg" x="380" y="20" width="340" height="190" rx="12"/>
<text class="tb" x="550" y="40" text-anchor="middle" dominant-baseline="middle">Hash Join（8.0.18+）</text>
<rect class="b3" x="400" y="60" width="90" height="50" rx="8"/>
<text class="tb" x="445" y="85" text-anchor="middle" dominant-baseline="middle">小表 t1</text>
<line class="l" x1="490" y1="85" x2="538" y2="85" marker-end="url(#arr)"/>
<text class="ts" x="514" y="74" text-anchor="middle">build</text>
<rect class="b5" x="540" y="60" width="160" height="50" rx="8"/>
<text class="tb" x="620" y="78" text-anchor="middle" dominant-baseline="middle">内存哈希表</text>
<text class="ts" x="620" y="98" text-anchor="middle" dominant-baseline="middle">join_buffer_size</text>
<rect class="b1" x="400" y="130" width="90" height="50" rx="8"/>
<text class="tb" x="445" y="155" text-anchor="middle" dominant-baseline="middle">大表 t2</text>
<line class="l" x1="490" y1="155" x2="598" y2="113" marker-end="url(#arr)"/>
<text class="ts" x="600" y="160" text-anchor="middle">probe：逐行哈希匹配</text>
<text class="ts" x="550" y="198" text-anchor="middle" dominant-baseline="middle">代价 ≈ N + M，超出内存则分片落盘</text>
</svg>
<figcaption>图 3：被驱动表有索引时用 NLJ；没有索引的等值连接，8.0.18+ 用 Hash Join 替代老的 Block Nested-Loop</figcaption>
</figure>

| 算法 | 条件 | 说明 |
| --- | --- | --- |
| Index Nested-Loop Join | 被驱动表关联列有索引 | 最常见、最理想；驱动表每行在被驱动表索引上查一次 |
| Block Nested-Loop（BNL） | 被驱动表无索引，8.0.20 之前 | 把驱动表行批量放进 `join_buffer`，再全表扫被驱动表逐行比较，比较次数 N×M |
| Hash Join | 8.0.18+ 等值连接无索引；8.0.20+ 所有无索引连接 | build 小表成哈希表，probe 大表；内存不够时按哈希分片写临时文件 |
| Batched Key Access（BKA） | 需手动开启 | NLJ + MRR，批量排序主键后回表 |

**驱动表选择**：优化器会估算并选择代价更低的顺序，原则是“**过滤后结果集小的表做驱动表**”，而不是表本身行数小。`LEFT JOIN` 一般左表驱动，但如果 WHERE 中对右表列有非 NULL 条件，优化器会把它改写成内连接并重新选择顺序。确需固定顺序时用 `STRAIGHT_JOIN`。

> [!TIP] JOIN 调优三板斧
> 1. 被驱动表关联字段必须有索引，且两侧**类型、字符集、排序规则一致**；
> 2. 尽量先过滤再关联，让驱动表结果集小；
> 3. 一般不超过 3 张表 JOIN，复杂报表交给数仓或在应用层拼装。

## ORDER BY 与 GROUP BY

### filesort

ORDER BY 能直接利用索引顺序时不需要排序（例如 `idx(user_id, create_time)` 上 `WHERE user_id = ? ORDER BY create_time`）。否则出现 `Using filesort`：

- 在 `sort_buffer`（`sort_buffer_size`，默认 256KB）中排序，放不下就分块排序后写临时文件做外部归并，`SHOW STATUS LIKE 'Sort_merge_passes'` 持续增长说明排序在频繁落盘。
- **单路排序（全字段）**：把需要返回的列都放进 sort buffer，排完直接返回，不回表。
- **双路排序（rowid）**：只放排序列和主键，排完再按主键回表取其他列，多一次随机 I/O。
- 5.7 由 `max_length_for_sort_data` 决定用哪种；8.0.20 起该参数被废弃，优化器使用紧凑格式存放变长字段，尽量走单路排序。可以在 optimizer trace 的 `sort_mode` 中看到实际方式。
- 有 `LIMIT N` 且 N 较小时，用**优先队列（堆）**只保留前 N 行，不需要完整排序（trace 中 `filesort_priority_queue_optimization`）。

### GROUP BY

- 能利用索引顺序时分组无需临时表；最理想是 `Using index for group-by`（松散索引扫描，例如 `SELECT a, MIN(b) FROM t GROUP BY a`，索引 `(a,b)`）。
- 否则建临时表聚合：`Using temporary`。8.0 内存临时表默认用 TempTable 引擎（`internal_tmp_mem_storage_engine`），超过 `temptable_max_ram` 等限制后转磁盘；5.7 用 Memory 引擎，受 `tmp_table_size` 与 `max_heap_table_size` 中较小者限制。
- **8.0 去掉了 GROUP BY 的隐式排序**：5.7 中 `GROUP BY a` 结果按 a 排序，8.0 不再保证，需要显式 `ORDER BY`。升级时依赖这一行为的代码会出现结果顺序变化。

## COUNT(*) vs COUNT(1) vs COUNT(列)

| 写法 | 语义 | 性能 |
| --- | --- | --- |
| `COUNT(*)` | 统计行数 | InnoDB 官方说明与 `COUNT(1)` 处理方式相同，没有性能差异；优化器会选最小的二级索引扫描 |
| `COUNT(1)` | 统计行数 | 同上 |
| `COUNT(主键)` | 统计主键非 NULL 的行 | 需要读取主键值，略慢或相近 |
| `COUNT(列)` | 统计该列非 NULL 的行 | 语义不同！需要判断 NULL；列无索引时全表扫描 |

推荐统一用 `COUNT(*)`。大表实时精确计数很贵，常见方案：Redis 计数器（注意与 DB 的一致性）、单独的计数表与业务同事务更新、或接受近似值（`SHOW TABLE STATUS` 的 `Rows`、`EXPLAIN` 的 rows）。

## 优化器选错索引与统计信息

InnoDB 统计信息通过**采样**得到：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `innodb_stats_persistent` | ON | 统计信息持久化在 `mysql.innodb_table_stats` / `innodb_index_stats` |
| `innodb_stats_persistent_sample_pages` | 20 | 采样页数，大表可适当调大 |
| `innodb_stats_auto_recalc` | ON | 表中超过 10% 的行变化后自动重算 |
| `eq_range_index_dive_limit` | 200 | IN 列表值超过该数量时不再逐个“index dive”估算，改用统计信息，估算可能变得很不准 |

处理顺序：

1. `ANALYZE TABLE t;` 重新采样统计信息（很快，只读采样页；但它会让表从表定义缓存中失效，若此时有长查询在跑，后续访问该表的查询可能出现 `Waiting for table flush`，应避开长查询执行）。
2. 8.0 对**无索引的列**可以建直方图，让优化器更准确估算过滤率：`ANALYZE TABLE t UPDATE HISTOGRAM ON status WITH 32 BUCKETS;`
3. 改写 SQL 或调整索引，让正确的索引“明显更优”。
4. 兜底：`FORCE INDEX(idx)`，或 8.0 的优化器提示 `/*+ INDEX(t idx) */`。缺点是索引改名或删除后 SQL 报错/失效，需要纳入变更评审。

## 隐式类型转换

```sql
-- phone 为 VARCHAR(20) 并有索引
SELECT * FROM user WHERE phone = 13800000000;     -- 全表扫描：等价于 CAST(phone AS DOUBLE) = 13800000000
SELECT * FROM user WHERE phone = '13800000000';   -- 走索引
```

规则：字符串和数字比较时，**把字符串转换成数字**。如果字符串在列这一侧，就等于对索引列使用了函数。反之 `INT` 列与字符串常量比较，转换发生在常量上，不影响索引。

在 Java 中最常见的来源是 MyBatis 参数类型与列类型不一致（如 `Long` 参数对应 `VARCHAR` 列），或 JOIN 两表关联字段类型/字符集不同。

## 调优案例

### 案例一：ORDER BY id LIMIT 选错索引

```sql
-- 索引：PRIMARY(id)、idx_user(user_id)
SELECT * FROM orders WHERE user_id = 42 ORDER BY id DESC LIMIT 10;
```

现象：大多数用户很快，少数订单很少的“冷用户”查询要好几秒。EXPLAIN ANALYZE 显示走的是 `PRIMARY` 反向扫描，一边扫一边过滤 `user_id = 42`。优化器认为按主键倒序扫描很快就能凑够 10 行从而省掉排序，但对于订单很少或很早期的用户，几乎要扫完整张表。

修复：二级索引叶子天然带主键，`idx_user(user_id)` 实际是 `(user_id, id)` 有序，理论上已能避免 filesort。若优化器仍选错，可改为显式联合索引 `idx_user_id(user_id, id)` 以让代价对比更明确，或 `FORCE INDEX(idx_user)`。教训：`ORDER BY ... LIMIT` 是选错索引的高发区，压测要覆盖数据分布极端的样本。

### 案例二：关联字段字符集不一致

```sql
-- trade.trade_no 为 utf8mb4，trade_log.trade_no 为 utf8（老表）
SELECT l.* FROM trade t JOIN trade_log l ON l.trade_no = t.trade_no WHERE t.id = 100;
```

`EXPLAIN` 中 `l` 的 type=ALL，`SHOW WARNINGS` 能看到条件变成了 `convert(l.trade_no using utf8mb4) = t.trade_no`：utf8 是 utf8mb4 的子集，比较时把 utf8 一侧升级为 utf8mb4，被驱动表的列被函数包裹，索引失效。修复：把老表字段改为 utf8mb4；临时方案是把转换放到驱动表一侧的值上：`ON l.trade_no = CONVERT(t.trade_no USING utf8)`（仅当数据中没有 4 字节字符时才安全）。

### 案例三：统计报表 GROUP BY 产生磁盘临时表

```sql
SELECT DATE(create_time) d, COUNT(*) FROM orders
WHERE create_time >= '2024-01-01' GROUP BY d;
```

`Using temporary; Using filesort`（5.7），扫描千万行后在临时表中分组，临时表超过内存上限转为磁盘表。优化路径：

1. 建 `idx_ct(create_time)`，使扫描变为覆盖索引的 range 扫描；
2. 8.0 可建函数索引 `((DATE(create_time)))`，让 GROUP BY 利用索引顺序；
3. 根本方案：按天预聚合到统计表（定时任务或流式计算），报表查汇总表，原始表只服务在线业务。

## 生产实践与踩坑

- **不要在主库直接跑 EXPLAIN ANALYZE 或 optimizer trace 排查大查询**，它们会真实执行。
- **加索引前先评估**：大表 `ALTER TABLE ADD INDEX` 虽然是 Online DDL，但会产生大量 I/O，并在开始和结束阶段需要短暂的 MDL 排他锁，被长事务阻塞时会连带阻塞所有读写（见 [锁机制与死锁分析](#/mysql/lock)）。
- **IN 列表过长**：几千个值的 IN 会让优化器估算失准（超过 `eq_range_index_dive_limit`），也让 SQL 解析变慢；拆批，每批几百个。
- **`SELECT *`**：无法使用覆盖索引，多读大字段溢出页，并且表结构变化可能影响应用。
- **分页查总数**：`COUNT(*)` 和分页列表各一条 SQL，总数在大表上可能比列表还慢，可缓存总数或只显示“下一页”。

## 相关阅读

- [B+ 树索引原理](#/mysql/index)：B+ 树索引原理
- [TiDB 实战：热点、迁移、选型与调优](#/db/tidb-practice)：TiDB 的执行计划与统计信息
- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：慢查询监控

## 面试追问

> [!QUESTION] 拿到一条慢 SQL，你的排查步骤是什么？
> 先从慢日志/pt-query-digest 拿到 SQL 和执行频率、Rows_examined；`EXPLAIN` 看 type、key、key_len、rows、Extra；必要时在从库 `EXPLAIN ANALYZE` 对比估算与实际行数；`SHOW WARNINGS` 看改写；判断是缺索引、索引失效、选错索引、深分页、还是 SQL 本身需要改写；修改后再用 EXPLAIN 和压测验证。

> [!QUESTION] key_len 怎么用来判断联合索引用了几列？
> 按列类型累加：INT 4、BIGINT 8、DATETIME 5、utf8mb4 的 VARCHAR(n) 为 4n+2，可为 NULL 再加 1。把 key_len 与各列长度前缀和对比即可知道用到第几列。

> [!QUESTION] Hash Join 和 Block Nested-Loop 有什么区别？
> 两者都用于被驱动表没有可用索引的情况。BNL 把驱动表一批行放进 join buffer，然后全表扫描被驱动表逐行与 buffer 中所有行比较，比较次数 N×M；Hash Join 用小表构建哈希表，大表每行只需一次哈希查找，复杂度 N+M。8.0.18 引入，8.0.20 起完全替代 BNL。

> [!QUESTION] 深分页为什么慢？有哪些方案？
> LIMIT M,N 需要按顺序找出前 M+N 行（每行回表）再丢弃 M 行。方案：延迟关联（子查询用覆盖索引取 id，只回表 N 次）；游标分页（用上一页最后一条的排序值做条件）；业务上限制最大页数或交给搜索引擎。

> [!QUESTION] COUNT(*) 和 COUNT(1) 哪个快？
> InnoDB 中两者处理方式相同，没有性能区别，都会选择最小的二级索引来遍历计数。COUNT(列) 语义不同，只统计非 NULL 值。

> [!QUESTION] 线上发现优化器选错了索引，怎么处理？
> 先 `ANALYZE TABLE` 更新统计信息；用 optimizer trace 看各索引的估算代价；调整 SQL 或建更合适的联合索引让正确索引代价明显更低；最后用 FORCE INDEX 或优化器 hint 兜底，并记录在案防止后续索引变更导致 SQL 报错。
