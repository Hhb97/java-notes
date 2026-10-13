---
level: 深入
tags: [MySQL, 优化器, 成本模型, 统计信息, 直方图, 索引潜水, 范围优化, ICP, MRR, Hash Join, 半连接, filesort, 临时表, optimizer_trace, Hint]
summary: MySQL 优化器原理深入：查询优化的阶段与成本模型（server_cost/engine_cost）、InnoDB 统计信息的采样与持久化、基数估计与索引潜水、直方图、范围优化与索引选择、ICP/MRR/索引合并/跳跃扫描、连接算法（NLJ/BNL/Hash Join/BKA）与连接顺序搜索、子查询与半连接策略、派生表合并、排序与临时表、optimizer_trace 解读、Hint 与优化器开关，以及选错索引的系统化排查。
---

# MySQL 优化器原理：成本模型、统计信息与 Optimizer Trace

> [!ABSTRACT] 核心要点
> - MySQL 优化器也是**基于成本（CBO）**：把 SQL 改写后，估算**各种访问路径、连接顺序、连接算法**的成本，选总成本最低者。**结果好坏取决于“行数估计”**——和 PG 一样，估算偏差是选错计划的根源。成本值可在 `EXPLAIN FORMAT=JSON` 的 `cost_info` 里看到。
> - **成本模型可配置**：成本常数存放在 `mysql.server_cost`（行评估、临时表创建等 CPU 类）与 `mysql.engine_cost`（读内存页/磁盘页 I/O 类）里，**默认值面向“机械盘+中等缓存”**；一般不改，但需要知道**它们决定了“全表扫描 vs 索引回表”的临界点**——**没有固定的“30% 命中就全表扫描”规则**，是成本比较的结果。
> - **统计信息**：InnoDB 通过**随机采样索引页**估算每个索引的**基数（Cardinality）**，默认**持久化**（`innodb_stats_persistent`），采样页数 `innodb_stats_persistent_sample_pages`（默认 20）；**自动重算**在表变化约 10% 时触发。**采样 + 数据倾斜 = 基数估不准**；8.0 引入**直方图**补充**非索引列**的分布。
> - **范围条件的估算**：多值 `IN (...)`/`OR` 的范围数少时用**索引潜水（index dive）**——**真正去 B+ 树里数各范围的行数，精确但有成本**；范围数超过 `eq_range_index_dive_limit`（默认 200）就退化为**用索引统计（平均值）估算，可能严重失真**——**大 IN 列表选错索引**的经典原因。
> - **执行层优化**：**ICP（索引条件下推）**、**MRR/BKA（把随机回表变成顺序）**、**Hash Join（8.0.18+，取代 Block Nested Loop）**、**半连接策略**（FirstMatch/LooseScan/Materialization/Duplicate Weedout）、**派生表合并**、**Skip Scan（8.0.13+）**。它们由 `optimizer_switch` 开关控制。
> - **排障利器：`optimizer_trace`**——展示优化器**每个候选计划的成本与取舍理由**（为什么没用某索引、为什么选这个连接顺序），比 `EXPLAIN` 多一层“为什么”。
> - **修复顺序**：**更新统计（ANALYZE）→ 直方图/索引 → 改写 SQL → 优化器 Hint/Index Hint → 调参数**；`FORCE INDEX` 是止血手段，不是长期方案。

## 优化的阶段

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="MySQL 查询优化阶段：解析后进行逻辑转换（常量折叠、外连接化简、子查询转换为半连接、派生表合并、条件下推与等值传递），再做基于成本的优化（单表访问方法选择、连接顺序搜索、连接算法选择），最后生成执行计划；统计信息与成本模型为成本优化提供输入；优化器 trace 记录各阶段">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 解析</text>
<text class="ts" x="75" y="74" text-anchor="middle">语法·语义检查</text>
<rect class="b5" x="145" y="30" width="190" height="64" rx="8"/>
<text class="tb" x="240" y="52" text-anchor="middle" dominant-baseline="middle">② 逻辑转换</text>
<text class="ts" x="240" y="74" text-anchor="middle">子查询/外连接/派生表改写</text>
<rect class="b1" x="350" y="30" width="190" height="64" rx="8"/>
<text class="tb" x="445" y="52" text-anchor="middle" dominant-baseline="middle">③ 基于成本的优化</text>
<text class="ts" x="445" y="74" text-anchor="middle">访问方法·连接顺序·算法</text>
<rect class="b4" x="555" y="30" width="185" height="64" rx="8"/>
<text class="tb" x="647" y="52" text-anchor="middle" dominant-baseline="middle">④ 执行计划</text>
<text class="ts" x="647" y="74" text-anchor="middle">执行器逐行驱动</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="335" y1="62" x2="350" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="62" x2="555" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="350" height="190" rx="8"/>
<text class="th" x="32" y="136">② 逻辑转换（与成本无关的改写）</text>
<text class="ts" x="195" y="162" text-anchor="middle">常量折叠、无用条件消除</text>
<text class="ts" x="195" y="184" text-anchor="middle">等值传递（a=b AND b=5 ⇒ a=5）</text>
<text class="ts" x="195" y="206" text-anchor="middle">外连接 → 内连接（WHERE 过滤右表）</text>
<text class="ts" x="195" y="228" text-anchor="middle">IN/EXISTS 子查询 → 半连接</text>
<text class="ts" x="195" y="250" text-anchor="middle">派生表/视图合并（避免物化）</text>
<text class="ts" x="195" y="272" text-anchor="middle">条件下推到派生表（8.0.22+）</text>
<rect class="bg" x="390" y="116" width="350" height="190" rx="8"/>
<text class="th" x="402" y="136">③ 基于成本的决策</text>
<text class="ts" x="565" y="162" text-anchor="middle">单表：全表扫描 / 各索引 range / ref / 索引合并</text>
<text class="ts" x="565" y="184" text-anchor="middle">连接顺序：贪心+剪枝搜索（表多时不穷举）</text>
<text class="ts" x="565" y="206" text-anchor="middle">连接算法：NLJ / Hash Join / BKA</text>
<text class="ts" x="565" y="228" text-anchor="middle">排序：利用索引有序 or filesort</text>
<text class="ts" x="565" y="250" text-anchor="middle">输入：统计信息 + 成本常数</text>
<text class="ts" x="565" y="272" text-anchor="middle">输出：最低成本计划</text>
</svg>
<figcaption>图 1：MySQL 优化的阶段</figcaption>
</figure>

整体架构与执行路径见 [架构与 SQL 执行流程](#/mysql/architecture)，EXPLAIN 逐列解读见 [EXPLAIN 与 SQL 调优](#/mysql/optimize)。本页回答**“优化器为什么这样选”**。

## 成本模型

| 成本类型 | 来源 | 典型常数（默认值随版本略有差异，以所用版本为准） |
| --- | --- | --- |
| **CPU 成本** | `mysql.server_cost` | `row_evaluate_cost`（评估一行条件，约 0.1~0.2）、`key_compare_cost`（比较索引键，约 0.05~0.1）、`memory_temptable_create_cost`/`row_cost`、`disk_temptable_create_cost`/`row_cost`（磁盘临时表代价高得多） |
| **I/O 成本** | `mysql.engine_cost` | `memory_block_read_cost`（读 Buffer Pool 内的页，约 0.25）、`io_block_read_cost`（读磁盘页，约 1.0）；8.0 起能**区分页是否在 Buffer Pool 中**估算 |

**查看与调整**：

```sql
SELECT * FROM mysql.server_cost;     -- cost_value 为 NULL 表示使用内置默认值
SELECT * FROM mysql.engine_cost;
-- 例：SSD 环境把磁盘块读成本调低（谨慎，需压测验证；调整后 FLUSH OPTIMIZER_COSTS）
UPDATE mysql.engine_cost SET cost_value = 0.5 WHERE cost_name = 'io_block_read_cost';
FLUSH OPTIMIZER_COSTS;
```

要点：

- 成本是**相对值**，用来**比较**候选计划，不是时间；
- **“全表扫描 vs 索引”的取舍**：全表扫描成本≈页数×I/O 成本 + 行数×CPU；索引范围扫描成本≈索引页 + **回表次数×随机 I/O**。命中行数少 → 索引，多 → 全表；**临界点取决于表大小、缓存命中、行宽，而不是固定百分比**；
- **覆盖索引**（不回表）成本大幅下降，常是更优选择，见 [B+ 树索引原理](#/mysql/index)；
- 在 `EXPLAIN FORMAT=JSON` 里可看到 `query_cost`、`read_cost`、`eval_cost`、`prefix_cost` 用于对比两个 SQL 的优劣。

## 统计信息与基数估计

### InnoDB 统计信息怎么来

- **索引基数（Cardinality）** = 索引列**不同值的估计数**，`SHOW INDEX` 的 `Cardinality` 列；优化器据此估算**等值条件的平均命中行数 ≈ 总行数 / Cardinality**；
- **采样方式**：对索引 B+ 树**随机抽取 N 个叶子页**（`innodb_stats_persistent_sample_pages`，默认 20；可用表属性 `STATS_SAMPLE_PAGES` 按表调大），统计其中的不同值，**外推全表**；
- **持久化统计**（`innodb_stats_persistent=ON`，默认）：存在 `mysql.innodb_table_stats` 与 `mysql.innodb_index_stats`，**重启不丢、不易抖动**；非持久统计（旧默认）每次重启/表打开时重算，计划易漂移；
- **自动重算**（`innodb_stats_auto_recalc=ON`）：自上次统计后，表变更行数超过 **约 10%** 触发后台重算；**大表要累积很多变更才触发**，所以大量批量更新后统计可能长期过时；
- **手动**：`ANALYZE TABLE t`（InnoDB 下对表持读锁时间短；会重采样并更新统计）。批量导入/大规模变更后要手动执行。

### 采样为什么会不准

| 情形 | 后果 |
| --- | --- |
| **数据倾斜** | 某个值占大头（如 `status='DELETED'` 占 90%），采样得到的 Cardinality 把“平均”当“每个值”，对热门值**严重低估命中行数**、对稀有值**高估** |
| **采样页数太少** | 大表 20 页的样本方差大，两次 ANALYZE 的 Cardinality 可能差几倍，导致**计划在 ANALYZE 前后突变** |
| **高基数/长尾** | 不同值很多时估计误差大 |
| **联合索引的前缀基数** | `index_name` 每个前缀有各自基数；列相关性不被建模（独立性假设） |
| **非索引列** | 默认没有统计，优化器用**固定默认选择性**（如等值 0.1、范围约 1/3）估算 |

### 直方图（8.0+）

对**没有索引的列**（或索引不覆盖其分布的列）收集**列值分布**，帮助估算 `WHERE` 过滤的选择性与连接基数：

```sql
ANALYZE TABLE orders UPDATE HISTOGRAM ON status, channel WITH 100 BUCKETS;
SELECT * FROM information_schema.COLUMN_STATISTICS WHERE TABLE_NAME='orders'\G   -- 查看直方图
ANALYZE TABLE orders DROP HISTOGRAM ON status;
```

| 类型 | 说明 |
| --- | --- |
| **Singleton（单值桶）** | 不同值数 ≤ 桶数时，每个值一个桶，记录**精确频率** |
| **Equi-height（等高）** | 值很多时按“每桶包含大致相同行数”划分，记录桶范围与累积频率 |

要点：

- **直方图不是索引**，**不会让查询走索引**，只让**估算更准**（尤其对**倾斜的非索引列**与**多表连接顺序**的估算）；
- **不会自动更新**：数据分布变化后要**手动重新收集**；
- **只对 `WHERE col op const` 的估算起作用**（及部分连接场景）；对于已有索引的列，优化器优先用索引统计/索引潜水；
- 适用：状态、类型、渠道这类**低基数且倾斜**的列做过滤，连接顺序因估算错误而选错时。

### 索引潜水（Index Dive）与大 IN 列表

对**等值/范围条件**，优化器要估算命中行数：

- **范围/等值的区间数较少**（≤ **`eq_range_index_dive_limit`**，默认 200）：**潜水**——沿 B+ 树找到区间两端，**数出实际页数/行数**，**精确**，但每个区间一次树遍历有成本；
- **区间数过多**（如 `IN` 列表有 500 个值）：**不再潜水**，改用**索引统计（Cardinality 平均值）**估算：每个值按平均命中行数相加。**对倾斜数据严重失真**，可能把本该走的索引放弃或选错；
- 对策：控制 `IN` 列表长度（分批）、调大 `eq_range_index_dive_limit`（代价是优化耗时增加）、改写为连接临时表、更新统计。

## 访问路径与索引选择

### 访问方法（`type`）的成本直觉

`const/eq_ref` ≪ `ref` < `range` < `index`（全索引扫描）< `ALL`（全表）；优化器对每个可用索引计算 **range 方案的成本**（含范围数、预估行数、回表）并与全表扫描比较，**选最低**。

### 常见优化技术

| 技术 | 说明 | 控制 |
| --- | --- | --- |
| **ICP（Index Condition Pushdown，5.6+）** | 把可用索引列判断的条件**下推到存储引擎层的索引扫描中**，在**回表之前**先过滤，**减少回表次数**；EXPLAIN 的 Extra 显示 `Using index condition` | `optimizer_switch='index_condition_pushdown'`；联合索引上**非最左前缀但在索引里的列**条件受益 |
| **覆盖索引** | 查询所需列都在索引中，**无需回表**（Extra: `Using index`） | 设计索引 |
| **MRR（Multi-Range Read）** | 先收集一批范围匹配的**主键**，**排序后按顺序回表**（把随机 I/O 变顺序），对机械盘与大范围回表有益 | `mrr`、`mrr_cost_based`（默认成本决策，常需手动开启 `mrr_cost_based=off` 才触发） |
| **索引合并（Index Merge）** | 多个单列索引的 `OR`/`AND` 条件，分别扫描再合并（union/intersection/sort-union）；Extra 显示 `Using union(...)` | `index_merge*`；常见更优做法是**建合适的联合索引**，索引合并往往意味着缺联合索引 |
| **Skip Scan（8.0.13+）** | **联合索引缺少前导列条件**时，优化器自动枚举前导列的不同值，对每个值做范围扫描（前导列基数低时有效） | `skip_scan` |
| **降序索引/不可见索引/函数索引（8.0）** | 降序索引支持混合排序方向；**不可见索引（invisible）**用于**无风险验证“删除索引”的影响**；函数索引对表达式 `WHERE f(col)` 建索引 | 见 [B+ 树索引原理](#/mysql/index) |
| **`use_index_extensions`** | 二级索引自动附带主键列，可用于排序/覆盖 | 默认开 |

### 为什么选错索引（最常见的几类）

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `ORDER BY ... LIMIT` 选了排序索引而非过滤索引（或反之） | **优化器估计“沿排序索引扫描能很快凑够 LIMIT 行”**，但过滤条件选择性被低估/高估导致实际扫描大量行 | 建联合索引同时覆盖过滤+排序；更新统计；`FORCE INDEX` 临时止血，见 [EXPLAIN 与 SQL 调优](#/mysql/optimize) 的调优案例 |
| 大 `IN` 列表选错索引 | 超过 `eq_range_index_dive_limit` 用平均统计估算 | 控制 IN 长度；调大阈值；分批 |
| 统计在 ANALYZE 前后计划突变 | 采样不稳 | 增大 `STATS_SAMPLE_PAGES`；持久化统计；定期 ANALYZE |
| 联合索引选到了不理想的那个 | 多个索引都能用，成本接近 | 删除冗余索引；调整索引设计；Hint |
| 倾斜列过滤估算严重偏差 | 无直方图/索引统计平均化 | 收集直方图；建索引 |
| 隐式类型转换使索引失效 | 列类型与参数类型不一致 | 保持类型一致，见 [EXPLAIN 与 SQL 调优](#/mysql/optimize) |
| 小表被优化器“嫌弃”索引 | 表很小，全表扫描成本更低（正确） | 不用处理 |

## 连接优化

### 连接算法

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="MySQL 的连接算法：Nested Loop Join 对驱动表每一行在被驱动表索引上查找；Block Nested Loop 在被驱动表无索引时把驱动表若干行缓冲到 join buffer 一次扫描被驱动表以减少扫描次数，8.0.20 起被 Hash Join 取代；Hash Join 对等值连接用小表建哈希表大表探测，无需索引，内存放不下则落盘分块；Batched Key Access 先收集一批连接键再排序后到被驱动表批量查找并配合 MRR">
<rect class="b3" x="20" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">Nested Loop Join（NLJ）</text>
<text class="ts" x="195" y="60" text-anchor="middle">驱动表每行 → 被驱动表索引查找</text>
<text class="ts" x="195" y="82" text-anchor="middle">被驱动表连接列必须有索引</text>
<text class="ts" x="195" y="104" text-anchor="middle">成本 ≈ 驱动表行数 × 单次索引查找</text>
<text class="ts" x="195" y="132" text-anchor="middle">小表驱动大表：驱动表行数小才划算</text>
<rect class="b5" x="390" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">Hash Join（8.0.18+）</text>
<text class="ts" x="565" y="60" text-anchor="middle">等值连接、被驱动表无索引时使用</text>
<text class="ts" x="565" y="82" text-anchor="middle">小表构建哈希表，大表逐行探测</text>
<text class="ts" x="565" y="104" text-anchor="middle">内存不够按块落盘（join_buffer_size）</text>
<text class="ts" x="565" y="132" text-anchor="middle">取代 BNL；EXPLAIN Extra: Using join buffer (hash join)</text>
<rect class="b1" x="20" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="200" text-anchor="middle" dominant-baseline="middle">Block Nested Loop（BNL，旧）</text>
<text class="ts" x="195" y="226" text-anchor="middle">被驱动表无索引：驱动表行缓冲到 join buffer</text>
<text class="ts" x="195" y="248" text-anchor="middle">被驱动表对每批缓冲扫描一次</text>
<text class="ts" x="195" y="270" text-anchor="middle">成本 ≈ 扫描次数 × 被驱动表全表</text>
<text class="ts" x="195" y="298" text-anchor="middle">8.0.20 起由 Hash Join 取代</text>
<rect class="b2" x="390" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="200" text-anchor="middle" dominant-baseline="middle">Batched Key Access（BKA）</text>
<text class="ts" x="565" y="226" text-anchor="middle">先收集一批连接键，排序后批量查被驱动表</text>
<text class="ts" x="565" y="248" text-anchor="middle">配合 MRR：把随机回表变顺序</text>
<text class="ts" x="565" y="270" text-anchor="middle">需 optimizer_switch 开启 bka 与 mrr</text>
<text class="ts" x="565" y="298" text-anchor="middle">适合大量随机 I/O 的连接</text>
</svg>
<figcaption>图 2：MySQL 的连接算法</figcaption>
</figure>

**关键认知**：

- **被驱动表的连接列没有索引 → 在 8.0.18 之前是灾难（BNL，多次全表扫描）**，8.0.18+ 是 Hash Join（好很多，但仍是全表扫描 + 内存/落盘，不如有索引的 NLJ）。**线上看到 `Using join buffer` 就要警惕缺索引**；
- **驱动表选择**：优化器选**预估行数少**的作驱动表；`STRAIGHT_JOIN` 可强制顺序；
- **连接顺序搜索**：表数多时**不穷举**，用**贪心 + 剪枝**（`optimizer_search_depth` 默认 62、`optimizer_prune_level=1` 按启发式剪枝）；表很多的 SQL 规划时间也会增长；
- **外连接**限制重排；能改成内连接就改（WHERE 里对右表列有过滤时优化器会自动转换）；
- 连接字段**字符集/排序规则/类型不一致**会导致索引失效或隐式转换，是线上常见坑，见 [EXPLAIN 与 SQL 调优](#/mysql/optimize) 的案例二。

### 子查询与半连接

`WHERE id IN (SELECT ...)` / `EXISTS` 子查询，优化器优先**转换为半连接（semi-join）**，再选择执行策略（`optimizer_switch` 的 `semijoin`、`materialization`、`firstmatch`、`loosescan`、`duplicateweedout`）：

| 策略 | 做法 | 适用 |
| --- | --- | --- |
| **Table Pull-out** | 子查询表直接上拉为连接（子查询列唯一时） | 子查询返回唯一键 |
| **FirstMatch** | 外表每行去子查询找到**第一个匹配就停止** | 外表小、子查询可索引查找 |
| **LooseScan** | 利用子查询列上的索引，每组只取一行 | 子查询列有索引且分组多 |
| **Materialization** | 子查询结果**物化成带唯一索引的临时表**，再连接 | 子查询不相关、结果适中 |
| **Duplicate Weedout** | 先正常连接，用临时表**去重** | 兜底 |

- `NOT IN`/`NOT EXISTS`（反连接）、**含 `LIMIT` 的子查询**、**包含聚合的子查询**不能转半连接，走子查询物化或相关子查询执行；
- **相关子查询**对外表每行执行一次，慢；**改写成 JOIN 或确保子查询内可走索引**；
- 8.0.21+：`IN` 子查询可转为**派生表**（`subquery_to_derived`，默认关）。

### 派生表与视图

- **派生表合并（derived_merge，默认开）**：`FROM (SELECT ...) t` 能合并进外层查询时**不物化**，当作原表参与优化；含 `GROUP BY/DISTINCT/LIMIT/UNION/聚合/窗口函数` 的**不能合并，需物化成临时表**（物化后外层条件无法用其索引，8.0.22 起**条件下推**部分缓解）；
- **CTE**（`WITH`）：非递归 CTE 与派生表类似，可合并或物化；**多次引用同一个 CTE 时物化一次复用**；
- 建议：**大结果的派生表前置过滤**；避免多层嵌套视图造成难以优化的计划。

## 排序、分组与临时表

### 排序（`Using filesort`）

- **能利用索引有序**则免排序：`WHERE` 的等值列 + `ORDER BY` 列构成联合索引的前缀，**且排序方向一致**（8.0 支持降序索引混合排序）；
- 否则 **filesort**：先按条件取行，把**排序键（+ 需要的列或行 ID）**放入 **`sort_buffer`（`sort_buffer_size`）** 排序；**内存不足则分块外部排序（`Sort_merge_passes` 状态变量 > 0 表示落过盘）**；
- 排序模式：**单趟（single-pass，行宽较小时把所需全部列放进 sort buffer，一趟排序后直接输出）** vs **两趟（只放排序键+行位置，排序后再回表取列）**；`max_length_for_sort_data`（旧）影响选择，8.0 自动判断；**`SELECT *` 会让排序行变宽，更易落盘或退化为两趟**；
- **`ORDER BY ... LIMIT N`**：8.0 使用**优先队列（堆）**只保留 N 行，内存很小；**但 LIMIT 很大或 offset 深时代价高**（深分页见 [EXPLAIN 与 SQL 调优](#/mysql/optimize)）；
- **`Using filesort` 不等于磁盘排序**，只是“没用索引排序”；是否落盘看 `Sort_merge_passes`。

### GROUP BY / DISTINCT 与临时表

- 能用索引**有序分组（松散/紧凑索引扫描）**则无需临时表；否则创建**临时表**（Extra: `Using temporary`）聚合；
- **内存临时表 → 磁盘临时表**：超过 `tmp_table_size` / `max_heap_table_size`（8.0 默认 `TempTable` 引擎受 `temptable_max_ram` 限制，再溢出到磁盘 `mmap`/InnoDB 文件）；`Created_tmp_disk_tables` 状态变量监控；**含 BLOB/TEXT 列或超长列的临时表直接落磁盘**；
- 优化：**减少分组列宽度与结果集行数**、加合适索引、拆查询先过滤再聚合、`SELECT` 只取必要列。

## optimizer_trace：看见优化器的“思考过程”

```sql
SET optimizer_trace = 'enabled=on', optimizer_trace_max_mem_size = 1000000;   -- 会话级
SELECT /* 你的 SQL */ ...;
SELECT TRACE FROM information_schema.OPTIMIZER_TRACE\G
SET optimizer_trace = 'enabled=off';
```

**Trace 的主要结构**（JSON）：

| 段 | 内容 | 看什么 |
| --- | --- | --- |
| `join_preparation` | 逻辑改写前后的 SQL（如子查询如何转半连接） | 子查询是否被转换 |
| `join_optimization → condition_processing` | 条件变换（等值传递、常量折叠） | 条件是否被意外改写 |
| `join_optimization → rows_estimation` | **每个表每个索引的访问成本**：`range_analysis` 里的 `table_scan`（rows、cost）、`potential_range_indexes`（可用索引及原因 `usable`/`not_usable`）、`analyzing_range_alternatives` 的 **`range_scan_alternatives`**（每个索引的 `rows`、`cost`、`chosen`、`cause`，如 `cost`/`too_many_roads_to_scan`）、`chosen_range_access_summary` | **“为什么没用某个索引”**：看该索引的 `cost` 是否高于全表扫描或其他索引、或 `usable: false` 的原因（如类型不匹配、`ORDER BY` 不可用） |
| `considered_execution_plans` | 连接顺序候选：每个候选的 `rows_for_plan`、`cost_for_plan`、选择的访问方法、`chosen` | 连接顺序为什么这样；`condition_filtering_pct` |
| `attaching_conditions_to_tables` | 条件挂到哪个表 | ICP 条件 |
| `join_execution` | 排序/临时表/分组方式（`filesort_summary`：`sort_algorithm`、`sort_mode`、`num_rows`、`peak_memory_used`） | 排序是否落盘 |

用法：对**两个相似 SQL（走了不同计划）**或**强制索引前后**各抓一份 trace 对比 `cost`。

## Hint 与优化器开关

| 工具 | 示例 | 说明 |
| --- | --- | --- |
| **Index Hint（旧）** | `FROM t FORCE INDEX (idx_a)`、`USE INDEX`、`IGNORE INDEX` | 作用于单表索引选择；`FORCE` 强烈建议，仍可能被忽略的情形较少 |
| **Optimizer Hints（5.7+/8.0）** | `SELECT /*+ INDEX(t idx_a) JOIN_ORDER(a, b) NO_MERGE(dt) BKA(t2) SET_VAR(sort_buffer_size=16M) MAX_EXECUTION_TIME(2000) */ ...` | **注释形式，语句级，更丰富**：索引、连接顺序、连接算法、子查询策略、派生表合并、**单语句设置变量**、**最大执行时间** |
| **`STRAIGHT_JOIN`** | `SELECT STRAIGHT_JOIN ...` | 强制按 FROM 顺序连接 |
| **`optimizer_switch`** | `SET optimizer_switch='index_merge=off,block_nested_loop=off'` | **会话/全局开关**：开关某类优化；适合**诊断/个别场景**，全局改动影响面大 |
| **不可见索引** | `ALTER TABLE t ALTER INDEX idx INVISIBLE` | **验证删除索引的影响**，可秒级回滚 |
| **SQL 层绕过** | 改写 SQL（如拆子查询、先 UNION ALL） | 不依赖 Hint 的稳定方案 |

**使用原则**：

- Hint 是**“对当前数据分布的赌注”**：数据变化后可能反而变慢；放在代码里**要有注释与监控**；
- **优先解决根因**（统计、索引、改写），Hint 用于**紧急止血或稳定关键 SQL**；
- ORM 生成的 SQL 无法直接加 Hint 时，用 `SET_VAR`/连接级设置或改为原生 SQL；
- MySQL 8.0 起还可通过 **Query Rewrite 插件**在服务端改写（不改应用）。

## 排查流程（选错计划）

1. **复现并抓取**：`EXPLAIN`（FORMAT=TREE/JSON）+ `EXPLAIN ANALYZE`（8.0.18+，看**实际行数与耗时**对比预估）；
2. **找偏差**：预估 `rows` vs 实际 rows；偏差最大的节点是源头；
3. **看 trace**：对比被放弃的索引/连接顺序的成本，找出**“为什么”**；
4. **修复**（按序）：
   - `ANALYZE TABLE`（必要时调大 `STATS_SAMPLE_PAGES`）；
   - 对倾斜的非索引列**收集直方图**；
   - 补/改索引（联合索引、覆盖索引、去冗余）；
   - 改写 SQL（去函数、统一类型、拆 IN 列表、子查询改 JOIN、深分页改游标）；
   - 个别 SQL 用 Optimizer Hint/`FORCE INDEX`；
   - 极少数调 `optimizer_switch`、成本常数；
5. **回归验证**：压测或影子流量验证，监控慢查询与 P99；
6. **防复发**：慢查询日志 + `pt-query-digest`/Performance Schema 统计；重要 SQL 纳入计划回归检查。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 同一 SQL 不同时间计划不同 | 统计信息重算后基数变化（采样波动） | 增大采样页数；持久化统计；稳定 SQL 用 Hint |
| 批量导入后查询突然变慢 | 统计过时（未达 10% 触发重算或重算滞后） | 导入后 `ANALYZE TABLE` |
| 大 IN 列表选了全表扫描/错索引 | 超过 `eq_range_index_dive_limit` 用平均统计 | 分批、调大阈值、改写 |
| 倾斜列过滤很慢 | 估算为平均选择性 | 直方图、联合索引 |
| `Using join buffer` 出现，连接慢 | 被驱动表连接列无索引 | 加索引；检查字符集/类型 |
| `Using temporary; Using filesort` + 磁盘临时表 | GROUP BY/ORDER BY 无索引，结果大 | 索引、减列、调大临时表限制、拆查询 |
| 优化后 `LIMIT` 查询反而慢 | 优化器假设沿排序索引能快速凑够行数 | 联合索引覆盖过滤+排序 |
| `EXPLAIN` 预估很小但实际很慢 | 统计错误/相关性；或锁等待、缓存未命中 | `EXPLAIN ANALYZE` 对比；查锁与 I/O |
| 优化器很慢（规划时间长） | 连接表很多、`IN` 列表极长、分区多 | 降低复杂度、`optimizer_search_depth` |

## 调优清单

- [ ] 统计信息是否持久化，大表采样页数是否足够，批量变更后是否手动 ANALYZE？
- [ ] 倾斜的非索引过滤列是否收集了直方图？
- [ ] 大 `IN` 列表是否分批或评估了 `eq_range_index_dive_limit`？
- [ ] 连接字段是否都有索引且类型/字符集一致，是否出现 `Using join buffer`？
- [ ] 排序/分组是否能利用索引，`Sort_merge_passes`、`Created_tmp_disk_tables` 是否被监控？
- [ ] 是否用 `EXPLAIN ANALYZE` 与 `optimizer_trace` 做过“为什么选这个计划”的诊断？
- [ ] Hint/`FORCE INDEX` 是否有注释、监控与失效回退？
- [ ] 删除索引前是否用不可见索引验证？

## 相关阅读

- [架构与 SQL 执行流程](#/mysql/architecture)：优化器在整体执行中的位置
- [EXPLAIN 与 SQL 调优](#/mysql/optimize)：EXPLAIN 解读、深分页、调优案例
- [B+ 树索引原理](#/mysql/index)：索引结构、覆盖索引与回表
- [InnoDB 存储结构与 Buffer Pool](#/mysql/storage)：页、缓存与 I/O 成本来源
- [PG 优化器原理](#/pg/optimizer)：另一种 CBO 的对照
- [在线 DDL 与大表治理](#/mysql/online-ddl)：索引变更与大表变更

## 面试追问

> [!QUESTION] MySQL 优化器是怎么选择执行计划的？
> 基于成本：先做逻辑改写（常量折叠、等值传递、子查询转半连接、派生表合并），再对每个表估算全表扫描和各索引的访问成本，对多表用贪心加剪枝搜索连接顺序并选择 Nested Loop、Hash Join 等算法，成本由 mysql.server_cost 和 engine_cost 里的常数与统计信息估算的行数决定，选总成本最低的。

> [!QUESTION] 为什么明明有索引，优化器却选了全表扫描或别的索引？
> 成本比较的结果：命中行多时回表的随机 I/O 比全表扫描更贵，没有固定百分比的临界点；也可能是统计信息采样不准或过时、数据倾斜导致基数估错、大 IN 列表超过 eq_range_index_dive_limit 退化为平均统计估算、ORDER BY LIMIT 让优化器误以为沿排序索引能快速凑够行数。要用 EXPLAIN ANALYZE 对比预估与实际行数，再看 optimizer_trace 里各索引的成本。

> [!QUESTION] InnoDB 的统计信息是怎么来的？怎么影响计划？
> 对索引随机抽样若干叶子页，统计不同值数外推得到基数，默认持久化存储，采样页数默认 20，表变化约 10% 后触发自动重算。优化器用基数估算等值条件命中行数，采样与倾斜会造成估计偏差，导致选错索引或连接顺序；批量变更后应手动 ANALYZE，必要时调大采样页数，8.0 还可对非索引列收集直方图。

> [!QUESTION] 直方图有什么用？和索引有什么区别？
> 直方图记录列值的分布，帮助优化器更准确估算过滤条件的选择性和连接基数，尤其是倾斜的非索引列，有单值桶和等高桶两种。它不是索引，不会加速查询或让查询走索引，只改善估算，而且不会自动更新，数据分布变化后要手动重新收集。

> [!QUESTION] Hash Join 和 Block Nested Loop 有什么区别？
> 被驱动表连接列没有索引时，BNL 把驱动表若干行缓冲进 join buffer，被驱动表对每批缓冲全扫一次，成本是批数乘全表；8.0.18 引入的 Hash Join 对等值连接用小表建哈希表、大表逐行探测，只需各扫一遍，内存不够再分块落盘，8.0.20 起取代 BNL。但仍不如有索引的 Nested Loop，出现 Using join buffer 应检查缺索引。

> [!QUESTION] optimizer_trace 怎么用？能看到什么？
> 会话级开启后执行 SQL，再查 information_schema.OPTIMIZER_TRACE，能看到逻辑改写、条件处理、每个表每个索引的访问成本与是否可用及原因、连接顺序候选的成本与选择、排序和临时表的方式。用来回答为什么没用某个索引、为什么选这个连接顺序，对比不同计划的成本。

> [!QUESTION] 优化器选错索引怎么处理？
> 先复现并用 EXPLAIN ANALYZE 找预估与实际偏差最大的节点，用 optimizer_trace 看被放弃方案的成本；修复按序：ANALYZE 更新统计、对倾斜列收集直方图、补或调整联合索引与覆盖索引、改写 SQL、个别 SQL 用 Optimizer Hint 或 FORCE INDEX 止血，最后才调 optimizer_switch 或成本常数；Hint 是对当前数据分布的赌注，要有注释和监控。
