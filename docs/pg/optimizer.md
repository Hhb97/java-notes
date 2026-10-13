---
level: 深入
tags: [PostgreSQL, 优化器, 成本模型, 统计信息, 选择性估算, 扩展统计, 连接顺序, 并行查询, 计划缓存, EXPLAIN ANALYZE, pg_hint_plan]
summary: PostgreSQL 查询优化器的工作原理：查询处理流水线、基于成本的计划选择与成本参数、统计信息（MCV/直方图/n_distinct/相关性）与选择性估算、多列相关性与扩展统计、连接顺序搜索与三种连接算法的成本、并行查询、分区裁剪、Prepared Statement 的通用/定制计划、JIT，以及基数估计偏差的定位与治理（EXPLAIN ANALYZE 解读、auto_explain、pg_hint_plan）。
---

# PostgreSQL 优化器原理：成本模型、统计信息与计划选择

> [!ABSTRACT] 核心要点
> - PG 的优化器是**基于成本（CBO）**的：对一条 SQL 枚举多种**扫描方式、连接顺序、连接算法**，用**成本模型**估算每个候选计划的代价，**选总成本最低的**。**计划好不好，取决于“基数估计”准不准**——估算行数差一个数量级，选出的连接算法与顺序就可能差几个数量级。
> - 成本 = **I/O 成本（页读取）+ CPU 成本（处理行/算子）** 的加权和，权重由 `seq_page_cost`、`random_page_cost`、`cpu_tuple_cost` 等参数决定；这些**不是时间，是相对单位**。**SSD 上把 `random_page_cost` 从默认 4.0 降到 1.1~1.5** 是最常见的有效调优之一（否则优化器过度偏爱顺序扫描）。
> - 基数估计靠**统计信息**（`pg_statistic`/`pg_stats`）：每列的**NULL 比例、不同值数、最常见值（MCV）及频率、等深直方图、物理相关性**。`ANALYZE` 采样（默认约 `300 × default_statistics_target` 行）构建；**数据变化大后不及时 ANALYZE，估算会严重失真**。
> - **优化器默认假设各列“独立”**：`WHERE city='北京' AND zip='100000'` 会把两个选择性**相乘**，对强相关列严重低估行数。PG 的对策是**扩展统计（`CREATE STATISTICS`）**：函数依赖、多列 n-distinct、多列 MCV。
> - 排错的核心动作：**`EXPLAIN (ANALYZE, BUFFERS)` 对比“预估行数 vs 实际行数”**，找到**第一个偏差大的节点**——上游的误差会一路放大。修复手段按序：**更新/加大统计 → 扩展统计 → 改写 SQL → 调成本参数 → 最后才是 hint 或强制关闭某类算法**。
> - 其他容易踩的：**Prepared Statement 的通用计划（generic plan）** 对倾斜数据可能选错；**连接数超过 `join_collapse_limit` 时优化器不再重排顺序**；**并行查询**并非总是更快；**JIT 对 OLTP 常是负收益**。

## 查询处理流水线

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="PostgreSQL 查询处理流水线：词法语法分析得到解析树，语义分析与重写（视图展开、规则）得到查询树，规划器基于统计信息与成本模型生成候选路径并选出最优计划，执行器按计划树自顶向下拉取元组；规划器内部包括路径生成、成本估算、连接顺序搜索与计划选择">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① Parser</text>
<text class="ts" x="75" y="74" text-anchor="middle">语法 → 解析树</text>
<rect class="b5" x="145" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="205" y="52" text-anchor="middle" dominant-baseline="middle">② Analyzer</text>
<text class="ts" x="205" y="74" text-anchor="middle">语义 → 查询树</text>
<rect class="b1" x="280" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="335" y="52" text-anchor="middle" dominant-baseline="middle">③ Rewriter</text>
<text class="ts" x="335" y="74" text-anchor="middle">视图展开·规则</text>
<rect class="b4" x="405" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="480" y="52" text-anchor="middle" dominant-baseline="middle">④ Planner</text>
<text class="ts" x="480" y="74" text-anchor="middle">路径→成本→最优计划</text>
<rect class="b2" x="570" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="655" y="52" text-anchor="middle" dominant-baseline="middle">⑤ Executor</text>
<text class="ts" x="655" y="74" text-anchor="middle">火山模型逐行拉取</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="265" y1="62" x2="280" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="62" x2="405" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="555" y1="62" x2="570" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="720" height="170" rx="8"/>
<text class="th" x="32" y="136">规划器（Planner）的内部步骤</text>
<text class="ts" x="380" y="162" text-anchor="middle">1) 预处理：子查询上拉、外连接化简、常量折叠、表达式化简、分区裁剪（计划期）</text>
<text class="ts" x="380" y="184" text-anchor="middle">2) 单表访问路径：顺序扫描 / 索引扫描 / 仅索引扫描 / 位图扫描 / 并行扫描，各估算 startup cost 与 total cost</text>
<text class="ts" x="380" y="206" text-anchor="middle">3) 连接顺序搜索：动态规划枚举（≤ 阈值）或遗传算法 GEQO（表很多时），每对关系考虑 NestLoop / Hash / Merge</text>
<text class="ts" x="380" y="228" text-anchor="middle">4) 上层算子：聚合（Hash/Sort+Group）、排序、LIMIT、窗口函数、Gather（并行）等路径叠加</text>
<text class="ts" x="380" y="250" text-anchor="middle">5) 从最终关系的候选路径里选“总成本最低”（或兼顾 startup cost 的 LIMIT/游标场景），转换为执行计划树</text>
<text class="ta" x="380" y="274" text-anchor="middle">“路径（Path）”是带成本的候选方案；只有最终胜出的才会变成“计划（Plan）”。EXPLAIN 展示的是计划。</text>
</svg>
<figcaption>图 1：PostgreSQL 的查询处理流水线与规划器步骤</figcaption>
</figure>

## 成本模型

### 成本是什么

`EXPLAIN` 输出的 `cost=0.43..1250.18` 含两个数：**启动成本（startup，返回第一行前的代价）..总成本（total）**。单位是**相对代价**，**以“顺序读一个页”= `seq_page_cost`=1.0 为基准**，不是毫秒。

### 关键成本参数

| 参数 | 默认 | 含义与调优 |
| --- | --- | --- |
| `seq_page_cost` | 1.0 | 顺序读一页的成本，基准 |
| **`random_page_cost`** | **4.0** | 随机读一页的成本。**为机械盘设计**；**SSD/NVMe/云盘通常设 1.1~1.5**，否则优化器过度偏好顺序扫描、不愿用索引 |
| `cpu_tuple_cost` | 0.01 | 处理一行的 CPU 成本 |
| `cpu_index_tuple_cost` | 0.005 | 处理一个索引项的成本 |
| `cpu_operator_cost` | 0.0025 | 执行一个算子/函数的成本 |
| `effective_cache_size` | 4GB | **告诉优化器“OS 缓存+shared_buffers 大概有多大”**，影响索引扫描的成本估算（缓存越大，随机读越便宜）；**不分配内存**，只是估计。通常设为物理内存的 50%~75% |
| `parallel_setup_cost` / `parallel_tuple_cost` | 1000 / 0.1 | 并行查询的启动与元组传输成本，决定小查询是否值得并行 |
| `work_mem` | 4MB | 排序/哈希可用内存（**影响计划选择**：内存够则选 Hash Join/内存排序，否则落盘） |
| `default_statistics_target` | 100 | 统计信息的精度（见下） |
| `enable_seqscan/indexscan/hashjoin/nestloop/…` | on | **诊断开关**：把某类算法成本设为极大值，用于**验证“若不选它会怎样”**，**不要作为生产常驻配置** |

### 成本如何估算（顺序扫描 vs 索引扫描的直觉）

```text
顺序扫描成本  ≈ 页数 × seq_page_cost  +  行数 × cpu_tuple_cost  +  行数 × (过滤条件的 cpu_operator_cost)
索引扫描成本  ≈ 索引页访问（树高+叶子页）+ 回表堆页访问（取决于相关性：高相关则近似顺序，低相关则近似随机）
              + 命中行数 × (cpu_index_tuple_cost + cpu_tuple_cost)
位图扫描      ≈ 先扫索引得到“页位图”，再按页序读堆页：介于两者之间，适合中等选择性与多条件 OR/AND 合并
```

**选择性（selectivity）** = 满足条件的行占比，是成本公式里的核心输入。**选择性很低（命中很少）→ 索引扫描；选择性很高（命中大部分）→ 顺序扫描更便宜**；中间地带常用位图扫描。这就是“为什么有索引却走全表扫描”的根本原因，往往是**正确的**。

## 统计信息

### `pg_statistic` / `pg_stats` 里有什么

`ANALYZE`（手动或 autovacuum 触发）对表**随机采样**（约 `300 × default_statistics_target` 行，默认 3 万行；大表按比例，不是全量扫描），为每列生成：

| 统计项 | `pg_stats` 字段 | 用途 |
| --- | --- | --- |
| **NULL 比例** | `null_frac` | `IS NULL` 的选择性 |
| **平均宽度** | `avg_width` | 估算排序/哈希内存与行宽 |
| **不同值数** | `n_distinct` | 正值=绝对个数；**负值=占行数的比例（如 -1 表示唯一）**；用于 `=`、`GROUP BY`、连接基数估计 |
| **最常见值与频率** | `most_common_vals / most_common_freqs` | **倾斜列的精确选择性**：`WHERE status='PAID'` 若在 MCV 中，直接用其频率 |
| **等深直方图** | `histogram_bounds` | **范围条件**（`<`, `BETWEEN`）：不含 MCV 的其余值被切成等行数的桶，按桶估算比例 |
| **物理相关性** | `correlation` | 列值顺序与**物理存储顺序**的相关度（-1~1）：越接近 ±1，索引扫描的回表越接近顺序读，成本越低 |

估算示例：`WHERE amount BETWEEN 100 AND 200` → 在直方图里数落在区间内的桶比例 × 非 MCV 行数 + MCV 中落在区间内的频率之和。

### 统计信息失真的常见原因

| 原因 | 说明与对策 |
| --- | --- |
| **数据变化后未 ANALYZE** | 批量导入/大量更新后统计过时；autovacuum 只在变化比例超过阈值时才触发 ANALYZE（`autovacuum_analyze_scale_factor` 默认 0.1），**大表阈值很大**；批量作业后手动 `ANALYZE` |
| **采样不足** | 长尾分布、高基数倾斜列，MCV/直方图不够精细：`ALTER TABLE t ALTER COLUMN c SET STATISTICS 500;`（或更大）再 `ANALYZE`，代价是 ANALYZE 变慢、计划时间略增 |
| **`n_distinct` 估错** | 大表采样低估/高估不同值数：可手动设置 `ALTER TABLE t ALTER COLUMN c SET (n_distinct = ...)` |
| **临时表/刚创建的表没有统计** | 临时表不会被 autovacuum 处理，需手动 `ANALYZE` |
| **表达式/函数** | `WHERE lower(email)=...` 没有表达式的统计（除非有**表达式索引**，其统计会被收集）；用**表达式索引**或扩展统计 |
| **类型转换/函数包裹列** | 失去使用列统计与索引的机会，估算退化为默认选择性（如等值 0.5%、范围 33%） |

### 多列相关性与扩展统计

优化器**对多个条件默认按独立处理，选择性相乘**：

```text
city='北京'（选择性 5%）AND zip='100000'（选择性 1%）→ 估算 0.05% 行
实际：北京的邮编几乎都是 10xxxx，zip 命中后 city 必然匹配 → 真实约 1%
→ 低估 20 倍，可能把本该用 Hash Join 的选成 Nested Loop
```

**扩展统计**（`CREATE STATISTICS`）：

```sql
-- 函数依赖：zip 决定 city，修正多条件相乘的低估
CREATE STATISTICS s_addr (dependencies) ON city, zip FROM address;
-- 多列 n-distinct：修正 GROUP BY city, district 的组数估计
CREATE STATISTICS s_grp (ndistinct) ON city, district FROM address;
-- 多列 MCV（PG12+）：对常见组合给出准确联合频率
CREATE STATISTICS s_mcv (mcv) ON city, zip FROM address;
ANALYZE address;     -- 创建后必须 ANALYZE 才会收集
```

要点：**只对确有相关性且影响了计划的列组合创建**（每个都增加 ANALYZE 与规划开销）；表达式扩展统计（PG14+）可用于函数表达式。

## 连接：顺序与算法

### 三种连接算法的成本直觉

| 算法 | 原理 | 擅长 | 成本关键因素 |
| --- | --- | --- | --- |
| **Nested Loop** | 外表每行去内表查找（内表走索引则每次 O(log N)） | **外表很小**、内表有高效索引；也是唯一支持非等值连接的通用方式 | 外表行数 × 内表单次查找成本。**外表行数估错 → 灾难**（估 10 行实际 100 万行） |
| **Hash Join** | 小表构建哈希表，大表探测 | **大表等值连接**、无索引 | 构建表是否能放进 `work_mem`（超出则**分批（batches）落盘**，变慢）；启动成本高（要先建完哈希表） |
| **Merge Join** | 两边按连接键排序后归并 | 两边**已有序**（索引扫描有序）或需要有序输出 | 排序成本；对大表且已有序时很划算 |

### 连接顺序搜索

- N 个表的连接顺序有 N! 种，PG 用**动态规划**（自底向上）枚举，**表数 ≥ `geqo_threshold`（默认 12）时改用遗传算法 GEQO**（近似、不保证最优）；
- **`join_collapse_limit`（默认 8）与 `from_collapse_limit`（默认 8）**：超过该数量的显式 `JOIN` 或子查询，优化器**按 SQL 书写顺序**连接，**不再重排**。表很多的复杂 SQL，**书写顺序会影响计划**；需要全局重排时调高（代价：规划时间指数上升）；
- **外连接限制重排**：`LEFT JOIN` 不能随意交换顺序，外连接多的 SQL 优化空间小；能改写成内连接（有 `WHERE` 过滤右表列时优化器会自动化简）就改写。

### 为什么 Nested Loop 是“估算偏差”的头号受害者

估算 → 外表 5 行 → 选 Nested Loop（内表索引查找 5 次，很便宜）。实际外表 50 万行 → 50 万次索引查找 + 回表，**分钟级**。**排障时第一眼看 Nested Loop 的外表（outer）实际行数与预估行数的差距。**

## EXPLAIN ANALYZE：把估算与现实对账

### 读懂输出

```text
Nested Loop  (cost=0.85..120.4 rows=8 width=40) (actual time=0.05..3150.2 rows=482113 loops=1)
  ->  Index Scan using idx_user_city on users u  (cost=0.43..8.5 rows=5 width=16)
                                                 (actual time=0.02..120.5 rows=51302 loops=1)
        Index Cond: (city = '北京')
  ->  Index Scan using idx_orders_uid on orders o  (cost=0.43..22.4 rows=2 width=24)
                                                    (actual time=0.01..0.05 rows=9 loops=51302)
        Index Cond: (user_id = u.id)
Buffers: shared hit=1450211 read=38211
Planning Time: 0.9 ms   Execution Time: 3160 ms
```

| 看什么 | 含义 |
| --- | --- |
| **`rows=` 预估 vs `actual rows=` 实际** | **最重要**。差 10 倍以上就要警觉。注意：**实际 `rows` 是“每次循环的平均行数”**，总行数 = `rows × loops` |
| **`loops`** | 该节点被执行了多少次（Nested Loop 的内表节点 loops = 外表行数）。时间也是**每次循环的平均**，总耗时 = `actual time × loops` |
| **`Buffers: shared hit/read`** | `hit` 命中 shared_buffers，`read` 从 OS/磁盘读；`dirtied/written` 表示写；用 `BUFFERS` 选项看 I/O 量比看时间更稳定 |
| **`Rows Removed by Filter`** | 扫描后被过滤掉的行数：很大说明**缺合适的索引**或条件不可索引 |
| **`Heap Fetches`（Index Only Scan）** | 仍需回表的行数：大说明**可见性映射（VM）没标记 all-visible**（需 VACUUM） |
| **`Sort Method: external merge Disk`** | 排序溢出磁盘：`work_mem` 不足 |
| **`Hash Batches > 1`** | 哈希表溢出分批：`work_mem` 不足或构建侧选错 |
| **`Planning Time`** | 规划耗时；分区很多/连接很多/扩展统计多时会变大 |

### 定位偏差的步骤

1. 找到**自底向上第一个**预估与实际偏差大的节点（**误差向上放大**，源头在底层）；
2. 判断偏差类型：
   - **过滤条件的选择性估错**：统计过时/采样不足/多列相关/表达式；
   - **连接基数估错**：连接键的 `n_distinct` 不准/相关性；
   - **参数化（generic plan）**：值倾斜下的通用计划；
3. 针对修复（见下一节）；
4. 用 `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)` 复验（`SETTINGS` 显示被修改的计划相关参数）；
5. **线上无法手动 EXPLAIN 的慢查询**：开启 **`auto_explain`**（`auto_explain.log_min_duration`、`log_analyze`、`log_buffers`、`log_nested_statements`），自动记录慢 SQL 的真实计划；配合 **`pg_stat_statements`** 找最耗时/最频繁的 SQL，见 [PG 索引类型与查询优化](#/pg/index)。

> [!WARNING] `EXPLAIN ANALYZE` 会真正执行
> 对 `INSERT/UPDATE/DELETE` 使用要放进事务并 `ROLLBACK`；对耗时很长的查询可能压垮线上，先在副本或限制超时（`statement_timeout`）。

## 修复手段（按优先级）

| 层级 | 做法 |
| --- | --- |
| **① 统计信息** | 手动 `ANALYZE`；调高列的 `SET STATISTICS`；设置 `n_distinct`；调整 `autovacuum_analyze_*`（大表降低 scale_factor）；批量作业后立即 ANALYZE |
| **② 扩展统计** | 对相关列创建 `dependencies / ndistinct / mcv`；表达式统计 |
| **③ 改写 SQL** | 避免列上函数/类型转换；`OR` 改 `UNION ALL`；`NOT IN` 改 `NOT EXISTS`；用 `EXISTS` 替代 `IN (大子查询)`（PG 会处理，但复杂时仍需注意）；**CTE**：PG12+ 默认可内联（非递归、无副作用、仅引用一次），`MATERIALIZED`/`NOT MATERIALIZED` 可显式控制；避免把过滤条件写在 CTE 外导致大结果物化 |
| **④ 索引** | 补合适索引（联合索引列顺序、部分索引、覆盖 `INCLUDE`）；让数据**物理有序**（`CLUSTER` 或建表时按键写入）以提升 `correlation` |
| **⑤ 成本参数** | **`random_page_cost`（SSD 调低）、`effective_cache_size`、`work_mem`（谨慎，按会话/查询设置）**；`cpu_*` 一般不动 |
| **⑥ 会话级诊断开关** | `SET enable_nestloop=off` 等**仅用于验证假设**；找到根因后用 ①~⑤ 解决 |
| **⑦ Hint** | PG **核心不提供 hint**；社区扩展 **`pg_hint_plan`** 可用注释指定扫描/连接方式与顺序。**作为最后手段、用于紧急止血或稳定关键 SQL**，要有文档与回归，避免统计变化后 hint 反而变成负担 |

## Prepared Statement 与计划缓存

PG 对 **Prepared Statement**（JDBC `PreparedStatement` 默认的服务端预编译，参数 `prepareThreshold` 默认 5 次后启用）缓存计划：

- 前几次（默认约 5 次）使用**定制计划（custom plan）**——**带着实际参数值规划**，选择性估算准确；
- 之后比较**通用计划（generic plan）**（不看参数值规划）的**平均成本**，若不比定制计划的平均成本差太多就**切换为通用计划，之后不再重新规划**；
- **隐患**：数据**严重倾斜**时（如 `status='DELETED'` 占 99%，`status='NEW'` 占 0.01%），通用计划按“平均选择性”规划，对稀有值或常见值**其中一类会很差**；表现为**“同一条 SQL，有时快有时慢”**、重启连接后恢复；
- **控制**：`plan_cache_mode`（`auto` / `force_custom_plan` / `force_generic_plan`），会话或函数级 `SET plan_cache_mode = force_custom_plan` 可规避倾斜；JDBC 可设置 `prepareThreshold=0` 禁用服务端预编译（失去计划复用，规划开销增加）；连接池（如 PgBouncer 事务模式）与预编译语句的交互要特别测试，见 [PG 锁、隔离级别与连接池](#/pg/concurrency)；
- **监控**：`pg_prepared_statements`（含 generic/custom plan 使用计数，新版本）、`auto_explain`。

## 并行查询

PG 可对**扫描、连接、聚合**启用多进程并行：**Gather / Gather Merge** 节点收集多个 **Parallel Worker** 的结果。

| 要点 | 说明 |
| --- | --- |
| **触发条件** | 表足够大（`min_parallel_table_scan_size`，默认 8MB）、成本评估值得（`parallel_setup_cost`/`parallel_tuple_cost`）、所有算子**并行安全（parallel safe）** |
| **关键参数** | `max_parallel_workers_per_gather`（默认 2）、`max_parallel_workers`、`max_worker_processes` |
| **并行扫描方式** | Parallel Seq Scan（按块分配）、Parallel Index/Bitmap Scan、Parallel Hash Join（共享哈希表）、Parallel Append（分区） |
| **不会并行** | 写操作（INSERT/UPDATE/DELETE，除 `CREATE TABLE AS`/`CREATE INDEX` 等）、含 `FOR UPDATE`、**并行不安全的函数**（函数标 `PARALLEL UNSAFE` 的默认值）、游标、可串行化隔离级别（旧版本）、已处于并行 worker 内 |
| **收益与代价** | 大表扫描/聚合明显加速（OLAP 型）；**OLTP 短查询不值得**（进程协调开销）；占用更多 CPU 与内存（`work_mem` × worker 数），高并发下可能**互相抢占**导致整体变差 |
| **建议** | OLTP 库保持较保守的并行度；报表/分析库调大；对自定义函数标注正确的 `PARALLEL SAFE`；监控 `Workers Planned/Launched`（计划了但没启动说明 worker 池耗尽） |

## 分区裁剪与 JIT

- **分区裁剪（Partition Pruning）**：**计划期裁剪**（条件为常量）与**执行期裁剪**（参数/子查询/嵌套循环中的值，EXPLAIN 里显示 `Subplans Removed`）；**条件必须直接作用于分区键**（不能对分区键套函数），见 [PG 分区与扩展生态](#/pg/partition-ext)；
- **JIT（即时编译）**：用 LLVM 把表达式求值、元组解构编译成机器码，对**大量行的复杂表达式分析查询**有收益；**`jit_above_cost`（默认 100000）** 满足就启用。**OLTP 或估算成本虚高的中等查询常因 JIT 编译耗时（几十到几百毫秒）反而更慢**——EXPLAIN 末尾的 `JIT:` 段显示编译耗时。OLTP 库常 `jit = off`，分析库按需开启。

## 实战案例

| 现象 | 根因 | 解决 |
| --- | --- | --- |
| 有索引却走全表扫描 | 命中比例高（正确选择）；或 `random_page_cost` 对 SSD 偏高；或条件含函数/隐式转换 | 先确认选择性；调 `random_page_cost`；去掉列上函数，建表达式索引 |
| 联表查询突然变慢，计划里出现 Nested Loop 且外表行数估错 | 统计过时/多列相关 | ANALYZE；扩展统计；必要时降低 `default_statistics_target` 反而不会有帮助，应增大 |
| 同一 SQL 有时快有时慢（连接池里连接间差异） | Prepared Statement 通用计划 + 数据倾斜 | `plan_cache_mode=force_custom_plan`；或对该 SQL 禁用服务端预编译 |
| `GROUP BY` 很慢且内存暴涨 | 组数被严重低估，选了 HashAggregate 后溢出 | `ndistinct` 扩展统计；提高 `work_mem`（会话级）；或让它走 Sort+GroupAggregate |
| `ORDER BY ... LIMIT 10` 慢 | 优化器选了“先过滤后排序”而不是沿索引有序扫描并提前停止（成本估算认为过滤选择性高） | 建与排序+过滤匹配的联合索引；统计修正 |
| 分区表查询没有裁剪 | 分区键上有函数/类型不匹配，或 `enable_partition_pruning` 被关 | 条件直接作用于分区键并类型一致 |
| 并行查询没有启用 | 表太小/函数 parallel unsafe/成本评估不划算/`max_parallel_workers_per_gather=0` | 检查函数标注与参数 |
| 查询规划本身很慢 | 分区数过多、连接表很多、扩展统计过多、`join_collapse_limit` 调得过大 | 减少分区/连接；Prepared 复用计划；评估是否需要调大限制 |

## 调优清单

- [ ] SSD 环境 `random_page_cost` 是否已调低（1.1~1.5），`effective_cache_size` 是否合理？
- [ ] 大表的 autovacuum/analyze 阈值是否足够灵敏，批量作业后是否手动 `ANALYZE`？
- [ ] 倾斜/高基数列是否调高了 `STATISTICS` 目标？相关列是否创建了扩展统计？
- [ ] 慢 SQL 是否用 `EXPLAIN (ANALYZE, BUFFERS)` 对比了预估与实际行数，并找到第一个偏差节点？
- [ ] 是否开启 `auto_explain` 与 `pg_stat_statements` 持续发现慢 SQL？
- [ ] 倾斜数据下 Prepared Statement 是否评估过通用计划风险？
- [ ] OLTP 是否关闭 JIT、保守设置并行度？
- [ ] 是否把 `enable_*` 与 hint 仅作为诊断/最后手段并留有文档？

## 相关阅读

- [PG 索引类型与查询优化](#/pg/index)：EXPLAIN 入门、索引类型与慢 SQL 定位
- [PG 存储与 MVCC 内部机制深入](#/pg/vacuum-internals)：可见性映射、仅索引扫描与 VACUUM 的关系
- [PG 锁、隔离级别与连接池](#/pg/concurrency)：Prepared Statement 与 PgBouncer
- [PG 分区与扩展生态](#/pg/partition-ext)：分区裁剪与扩展
- [MySQL 优化器原理](#/mysql/optimizer)：另一种优化器的对照
- [EXPLAIN 与 SQL 调优（MySQL）](#/mysql/optimize)：执行计划解读方法

## 面试追问

> [!QUESTION] PostgreSQL 的优化器是怎么选择执行计划的？
> 基于成本：对每个表枚举顺序扫描、索引扫描、位图扫描等访问路径，对多表连接用动态规划（表很多时用遗传算法）枚举连接顺序与 Nested Loop、Hash Join、Merge Join 算法，用成本模型（页读取加 CPU 处理，由 seq_page_cost、random_page_cost、cpu_tuple_cost 等参数加权）估算每个路径，选总成本最低的。成本依赖统计信息估算的行数。

> [!QUESTION] 为什么有索引却不走索引？
> 往往是正确选择：命中行占比高时顺序扫描比大量随机回表更便宜，位图扫描介于两者之间。也可能是 SSD 上 random_page_cost 仍是默认 4.0 导致偏向顺序扫描，或统计信息过时，或条件上有函数、隐式类型转换使索引失效。要用 EXPLAIN 对比选择性和成本，再决定调参数、改写或建索引。

> [!QUESTION] 统计信息里有什么？怎么影响估算？
> pg_statistic 里有每列的 NULL 比例、平均宽度、不同值数、最常见值及频率、等深直方图和物理相关性。等值条件用 MCV 频率或 1/n_distinct，范围条件用直方图，相关性影响索引扫描回表成本。统计由 ANALYZE 采样生成，数据变化后不及时更新或倾斜列采样不足，估算就会失真。

> [!QUESTION] 多个条件的选择性为什么会估错？怎么解决？
> 优化器默认各列独立，把选择性相乘，对强相关列如城市与邮编会严重低估行数，进而错选 Nested Loop。用 CREATE STATISTICS 创建扩展统计，类型包括函数依赖、多列不同值数和多列最常见值，创建后需要 ANALYZE，且只对确实相关并影响计划的列组合创建。

> [!QUESTION] 怎么排查一个慢查询的执行计划问题？
> 用 EXPLAIN (ANALYZE, BUFFERS) 对比每个节点的预估行数与实际行数，注意实际行数是每次循环的平均值要乘以 loops，找到自底向上第一个偏差大的节点，判断是统计过时、采样不足、多列相关还是参数化计划问题，再依次修复：更新或加大统计、扩展统计、改写 SQL、调成本参数，最后才用 pg_hint_plan。线上用 auto_explain 和 pg_stat_statements 收集。

> [!QUESTION] Prepared Statement 为什么会导致同一条 SQL 有时快有时慢？
> 前几次使用带实际参数的定制计划，之后若通用计划成本相近就切换为不看参数值的通用计划并缓存。数据严重倾斜时通用计划按平均选择性规划，对稀有值或常见值其中一类会很差。可通过 plan_cache_mode 设为 force_custom_plan，或禁用服务端预编译规避。
