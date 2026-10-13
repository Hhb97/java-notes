---
level: 深入
tags: [PostgreSQL, MVCC, 元组可见性, 快照, Hint Bits, 页面剪枝, HOT, 可见性映射, VACUUM, autovacuum, 冻结, 事务回卷, 表膨胀, pg_repack]
summary: PostgreSQL 存储与 MVCC 内部机制深入：元组头与可见性判定规则（快照 xmin/xmax/xip、提交日志、Hint Bits）、子事务与 MultiXact、页面剪枝与 HOT 链、可见性映射与空闲空间映射、VACUUM 的完整流程与代价、autovacuum 的触发与限速调度、冻结与事务 ID 回卷、阻止清理的“元凶”（长事务/复制槽/备库反馈）、表与索引膨胀的检测与治理。
---

# PostgreSQL MVCC 内部机制：可见性、剪枝、VACUUM 与膨胀治理

> [!ABSTRACT] 核心要点
> - PG 的 MVCC 是**“多版本存放在堆表里”**：`UPDATE` = **写一个新版本（新元组）+ 给旧版本打上 `xmax`**，`DELETE` = 只打 `xmax`。**旧版本不会立刻消失**，由 **VACUUM**（以及页面剪枝）回收。这带来 PG 的两个“特色成本”：**表/索引膨胀**与**事务 ID 回卷**，也是 PG 运维的核心功课。
> - **可见性判定**：每个事务拿到一个**快照（xmin、xmax、xip 列表）**；对一个元组，用它的 `t_xmin`（创建事务）、`t_xmax`（删除/锁定事务）与快照、**提交日志（`pg_xact`）** 对照，判断“创建者是否已提交且对我可见、删除者是否已提交且对我可见”。**Hint Bits** 把“提交/中止”结果缓存在元组头，避免反复查提交日志——这也是为什么**只读查询也可能把页面弄脏（产生写 I/O）**。
> - **页面剪枝（Pruning）+ HOT**：访问页面时机会性地清理 HOT 链上的死版本；`UPDATE` 不改索引列且页内有空间时用 **HOT 更新**，**无需新增索引项**，是控制索引膨胀的关键。**`fillfactor`** 为页内更新留空间。
> - **可见性映射（VM）** 记录“整页对所有事务可见/已冻结”：**VACUUM 可跳过这些页，Index-Only Scan 可不回表**。VM 过期（长期没 VACUUM）→ 仅索引扫描退化为大量回表（`Heap Fetches` 高）。
> - **VACUUM 真正做的事**：扫描堆、收集死元组 TID、**清理索引项**、回收堆里的死元组空间、更新 FSM/VM、**冻结老元组**、更新统计。**瓶颈常在索引清理与 I/O**，由 `maintenance_work_mem` 与成本限速（`vacuum_cost_*`）控制。
> - **事务 ID 回卷**：XID 是 32 位（约 21 亿可用窗口），老元组必须在**到期前被冻结**，否则数据库会**强制只读/停机**保护数据。监控 `age(datfrozenxid)`。
> - **清理被“钉住”的元凶**：**长事务/idle in transaction、未使用的复制槽、`hot_standby_feedback`、未决的准备事务（2PC）、长查询的备库**。这些都会让**死元组无法被回收**，膨胀雪崩。治理要**先找元凶，再谈 VACUUM 参数**。

## 元组与可见性

### 元组头

堆表中每个元组（行版本）有 23 字节左右的头，关键字段：

| 字段 | 含义 |
| --- | --- |
| **`t_xmin`** | **创建**该版本的事务 ID（XID） |
| **`t_xmax`** | **删除或锁定**该版本的事务 ID（0 表示未删除）；行锁（`SELECT FOR UPDATE/SHARE`）也会写 xmax（多个锁持有者时指向 **MultiXact**） |
| **`t_cid`** | 事务内的命令序号（区分同一事务内先后语句的可见性） |
| **`t_ctid`** | 指向**本行的最新版本**（未被更新则指向自己）；更新后旧版本的 ctid 指向新版本，形成**版本链** |
| **`t_infomask`/`t_infomask2`** | 标志位：**Hint Bits（`XMIN_COMMITTED`、`XMIN_INVALID`、`XMAX_COMMITTED`、`XMAX_INVALID` 等）**、是否有 NULL、是否 HOT 更新（`HEAP_HOT_UPDATED`）/ HEAP_ONLY_TUPLE、是否被锁定等 |

### 一次 UPDATE 发生了什么

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="UPDATE 的多版本：事务 100 创建了一行版本 v1，xmin 为 100；事务 200 执行 UPDATE，把 v1 的 xmax 设为 200，并在堆页内写入新版本 v2，xmin 为 200，v1 的 ctid 指向 v2；索引项仍指向 v1（若是 HOT 更新则索引不新增，通过 v1 的 HOT 链找到 v2）；事务 200 提交后，快照晚于 200 的事务看到 v2，早于它的快照看到 v1；之后 v1 成为死元组，等待 VACUUM 回收">
<rect class="b3" x="20" y="30" width="330" height="86" rx="8"/>
<text class="tb" x="185" y="48" text-anchor="middle" dominant-baseline="middle">v1：(id=7, balance=100)</text>
<text class="ts" x="185" y="72" text-anchor="middle">t_xmin=100（已提交）</text>
<text class="ts" x="185" y="92" text-anchor="middle">t_xmax=200（被事务 200 更新） · t_ctid → v2</text>
<rect class="b2" x="410" y="30" width="330" height="86" rx="8"/>
<text class="tb" x="575" y="48" text-anchor="middle" dominant-baseline="middle">v2：(id=7, balance=150)</text>
<text class="ts" x="575" y="72" text-anchor="middle">t_xmin=200 · t_xmax=0</text>
<text class="ts" x="575" y="92" text-anchor="middle">新版本写入同一页（HOT）或其他页</text>
<line class="l" x1="350" y1="73" x2="410" y2="73" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="136" width="720" height="184" rx="8"/>
<text class="th" x="32" y="156">后续的可见性</text>
<text class="ts" x="380" y="182" text-anchor="middle">事务 200 提交前：其他事务看到 v1（xmax=200 的事务未提交 → 删除不可见）；事务 200 自己看到 v2</text>
<text class="ts" x="380" y="204" text-anchor="middle">事务 200 提交后：快照在 200 提交之后的事务看到 v2；在其之前拿快照的长事务继续看到 v1（可重复读/快照一致）</text>
<text class="ts" x="380" y="226" text-anchor="middle">没有任何事务还需要 v1 时：v1 成为“死元组”，占着页内空间与索引项，等待页面剪枝或 VACUUM 回收</text>
<text class="ts" x="380" y="248" text-anchor="middle">非 HOT 更新：新版本需要在每个索引里新增指向 v2 的索引项（写放大）；HOT 更新：索引不变，经 v1→v2 的页内链找到新版本</text>
<text class="ta" x="380" y="274" text-anchor="middle">ROLLBACK：新版本的 xmin 标记为中止（不可见），无需 undo，留待 VACUUM 清理</text>
<text class="ta" x="380" y="298" text-anchor="middle">对比 InnoDB：旧版本放在 undo 段，由 purge 回收；PG 的旧版本就在表里，“清理”成本落在 VACUUM 上</text>
</svg>
<figcaption>图 1：一次 UPDATE 的多版本与可见性</figcaption>
</figure>

### 快照与可见性规则

事务（或语句，取决于隔离级别）开始时获取**快照**：

| 快照字段 | 含义 |
| --- | --- |
| **`xmin`** | 快照时刻**最老的仍在运行的事务 ID**：小于它的事务都已结束（已提交或已中止） |
| **`xmax`** | 快照时刻**下一个将分配的事务 ID**：大于等于它的事务对本快照“尚未开始”，一律不可见 |
| **`xip[]`** | 快照时刻处于 [xmin, xmax) 之间**仍在运行**的事务 ID 列表（这些事务的修改不可见） |

简化的可见性规则（对“版本 V”）：

1. **创建可见**：`V.xmin` 对应事务**已提交**，且 `V.xmin < 快照.xmax` 且 **不在 `xip` 里**（或是当前事务自己创建的、`cid` 更早）；
2. **删除不可见**（即版本仍有效）：`V.xmax == 0`，或 `V.xmax` 事务**未提交/已中止**，或 `V.xmax` 不在快照可见范围内（在 `xip` 中或 ≥ 快照.xmax）；
3. 同时满足 1 与 2 → **该版本对本快照可见**。

**提交状态来源**：事务的最终状态记录在 **提交日志 `pg_xact`**（以前叫 clog，**每个事务 2 位**：in progress / committed / aborted / sub-committed）。每次判断都查 `pg_xact` 代价高，于是引入 **Hint Bits**。

### Hint Bits：只读查询为何会“写”

- 第一次访问某元组并查清其 xmin/xmax 事务的提交状态后，**把结论写进元组头的 `infomask` 位**（如 `HEAP_XMIN_COMMITTED`），之后的访问不再查 `pg_xact`；
- 这个“写”**弄脏了数据页**（即使是 `SELECT`），在**大批量导入后首次全表扫描**时会产生大量**写 I/O**，表现为“导入完第一次查询特别慢、且产生 WAL（若开启校验和/`wal_log_hints`）”；
- 对策：批量导入后**主动 `VACUUM`（或 `VACUUM FREEZE`）**一次，在离峰期把 hint bits 与冻结状态补好。

### 子事务与 MultiXact

| 机制 | 说明与风险 |
| --- | --- |
| **子事务（SAVEPOINT / PL/pgSQL 的 EXCEPTION 块）** | 每个子事务有自己的 XID；状态记录在 `pg_subtrans`。**每个会话缓存 64 个子事务 XID，超出会“溢出（overflowed）”，快照判断需要频繁访问 `pg_subtrans`，在高并发下造成严重的 SLRU 争用**。**不要在高频路径里滥用 SAVEPOINT / 带 EXCEPTION 的函数循环**（经典线上故障） |
| **MultiXact** | 多个事务**同时持有同一行的共享锁**（`FOR SHARE`/外键检查的 `FOR KEY SHARE`）时，`xmax` 指向一个 **MultiXact ID**（成员列表存在 `pg_multixact`）。**外键密集的表高并发更新会放大 MultiXact 压力**，也有自己的回卷问题（`multixact` age） |

## 页面剪枝、HOT 与映射

### 页面剪枝（Pruning）

- 访问堆页时（`heap_page_prune_opt`），若页内**空闲空间低于阈值**（接近 `fillfactor` 剩余或页快满）且存在**可回收的 HOT 链死版本**，**当场清理**：把死元组的存储空间合并、行指针转为**重定向（redirect）或死（dead）**，**不需要扫描索引**；
- 剪枝**不能回收有索引项指向的死元组**（那需要 VACUUM 先清理索引项）；它只能回收 **HOT 链中间的版本**（没有索引项直接指向它们）；
- 价值：**让频繁更新的热点页自我维护**，减缓膨胀，降低对 autovacuum 的依赖。

### HOT 更新条件

**HOT（Heap-Only Tuple）更新**要求：

1. **更新的列都不是任何索引的键列**（含表达式索引与部分索引的谓词涉及的列）；
2. **新版本能放进同一个堆页**（页内有足够空闲）。

满足则：**新版本在同一页，索引不新增项**，旧→新通过页内链接。**不满足**（改了被索引的列，或页满）→ 普通更新：新元组可能落到别页，且**所有索引都要新增一项**（写放大、索引膨胀）。

调优手段：

| 手段 | 说明 |
| --- | --- |
| **降低 `fillfactor`**（如 70~90） | 在页内为更新预留空间，提高 HOT 比例；代价是表变大、顺序扫描多读页 |
| **避免对被更新的列建索引** | 频繁更新的状态/计数列，谨慎加索引（`n_tup_hot_upd` 对比 `n_tup_upd` 观察 HOT 比例） |
| **减少无意义更新** | `UPDATE` 把值更新成相同的值**仍会产生新版本**；应用层/触发器 `WHERE col IS DISTINCT FROM 新值` 避免空更新 |

### 可见性映射（Visibility Map）与空闲空间映射（FSM）

| 映射 | 内容 | 用途 |
| --- | --- |---|
| **VM（`_vm`）** | 每个堆页 **2 个位**：**all-visible**（页内所有元组对所有事务可见）、**all-frozen**（页内所有元组已冻结） | ① **VACUUM 跳过 all-visible 页**（普通 VACUUM）/ all-frozen 页（激进冻结），大幅减少 I/O；② **Index-Only Scan** 遇到 all-visible 页**不必回表**检查可见性 |
| **FSM（`_fsm`）** | 每个堆页的**空闲空间**（粗粒度 1 字节） | `INSERT`/`UPDATE` 快速找到有空位的页，避免总是追加到文件末尾 |

**VM 位被清除**：该页发生任何写入（插入/更新/删除）都会清 all-visible 位，直到下次 VACUUM 重新标记。所以**写入频繁的表，Index-Only Scan 效果依赖 autovacuum 的及时性**。

## VACUUM 全流程

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="VACUUM 的阶段：扫描堆（跳过全可见页）收集死元组 TID 到内存数组；内存数组满或扫描结束后，清理所有索引中指向这些 TID 的索引项；再回到堆，把死元组的行指针标记为未使用并整理页空间，更新 FSM 和 VM；必要时截断表尾部的空页；冻结符合条件的老元组；最后更新统计信息和 relfrozenxid；每一步受成本限速影响">
<rect class="b3" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">① 扫描堆</text>
<text class="ts" x="85" y="74" text-anchor="middle">跳过全可见页</text>
<rect class="b5" x="165" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="230" y="52" text-anchor="middle" dominant-baseline="middle">② 收集死 TID</text>
<text class="ts" x="230" y="74" text-anchor="middle">存入内存数组</text>
<rect class="b1" x="310" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="380" y="52" text-anchor="middle" dominant-baseline="middle">③ 清理索引</text>
<text class="ts" x="380" y="74" text-anchor="middle">逐个索引删项</text>
<rect class="b4" x="465" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="530" y="52" text-anchor="middle" dominant-baseline="middle">④ 回收堆</text>
<text class="ts" x="530" y="74" text-anchor="middle">指针置未使用</text>
<rect class="b2" x="610" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="675" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 更新映射</text>
<text class="ts" x="675" y="74" text-anchor="middle">FSM·VM·冻结</text>
<line class="l" x1="150" y1="62" x2="165" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="295" y1="62" x2="310" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="62" x2="465" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="595" y1="62" x2="610" y2="62" marker-end="url(#arr)"/>
<path class="la" d="M380 94 L380 124 L85 124 L85 98" marker-end="url(#arr-a)"/>
<text class="ta" x="232" y="118" text-anchor="middle">内存数组满则先走 ③④ 再继续扫描（多轮）</text>
<rect class="bg" x="20" y="142" width="720" height="186" rx="8"/>
<text class="th" x="32" y="162">要点</text>
<text class="ts" x="380" y="188" text-anchor="middle">死元组 TID 数组受 maintenance_work_mem 限制：内存小则多轮，每轮重扫所有索引</text>
<text class="ts" x="380" y="210" text-anchor="middle">索引越多越慢；新版本改进：可跳过不必要的索引清理、并行清理索引、更省内存</text>
<text class="ts" x="380" y="232" text-anchor="middle">普通 VACUUM 不阻塞读写，但耗 I/O；一般不把空间还给 OS（仅尾部空页可截断）</text>
<text class="ts" x="380" y="254" text-anchor="middle">VACUUM FULL：重写整张表，回收空间给 OS，但持有 ACCESS EXCLUSIVE 锁（阻塞所有读写），仅在极端情况维护窗口使用</text>
<text class="ts" x="380" y="276" text-anchor="middle">VACUUM 不能回收“仍可能被某个事务看到”的死元组：由最老的活动快照/复制槽/备库反馈决定的“可清理水位（OldestXmin）”决定</text>
<text class="ta" x="380" y="304" text-anchor="middle">VACUUM ANALYZE：清理后顺带更新统计；autovacuum 的 analyze 与 vacuum 是两个独立触发的任务</text>
</svg>
<figcaption>图 2：VACUUM 的阶段与关键约束</figcaption>
</figure>

### OldestXmin：清理的水位线

VACUUM 只能删除**对所有现存和未来快照都不可见**的死元组，即 `xmax` 事务已提交且 `xmax < OldestXmin`。**OldestXmin = min(最老的活动事务 xmin、复制槽的 xmin/catalog_xmin、备库 hot_standby_feedback 的 xmin、未决 2PC 事务…)**。**任何一个“钉住 xmin”的东西都会让整库的清理停滞**。

## autovacuum：触发与调度

### 触发阈值

| 任务 | 触发条件（默认） |
| --- | --- |
| **VACUUM（死元组）** | `死元组数 > autovacuum_vacuum_threshold(50) + autovacuum_vacuum_scale_factor(0.2) × reltuples` |
| **VACUUM（仅插入表）**（PG13+） | `插入数 > autovacuum_vacuum_insert_threshold(1000) + autovacuum_vacuum_insert_scale_factor(0.2) × reltuples`：让只增不改的表也能**冻结与更新 VM** |
| **ANALYZE** | `变更行数 > autovacuum_analyze_threshold(50) + autovacuum_analyze_scale_factor(0.1) × reltuples` |
| **防回卷 VACUUM** | 表的 `age(relfrozenxid) > autovacuum_freeze_max_age(2 亿)`：**即使关闭 autovacuum 也会强制触发**，且**不可被取消**（激进、耗 I/O） |

**大表的陷阱**：`scale_factor=0.2` 意味着 **10 亿行的表要累积 2 亿死元组才触发**——此时一次清理耗时数小时、膨胀已严重。**大表应在表级降低阈值**：

```sql
ALTER TABLE big_orders SET (
  autovacuum_vacuum_scale_factor = 0.01,        -- 或直接用 threshold 绝对值
  autovacuum_vacuum_threshold    = 100000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit   = 2000          -- 放宽该表的清理速度
);
```

### 成本限速（节流）

autovacuum 通过**成本模型**限制 I/O 速度，防止影响业务：

- 每次页面操作累加成本：命中缓存页 `vacuum_cost_page_hit`(1)、读磁盘页 `vacuum_cost_page_miss`(2，PG14 前 10)、弄脏页 `vacuum_cost_page_dirty`(20)；
- 累计到 **`autovacuum_vacuum_cost_limit`（默认沿用 `vacuum_cost_limit`=200）** 就**睡眠 `autovacuum_vacuum_cost_delay`（默认 2ms，PG12 前 20ms）**；
- **成本限制在所有 autovacuum worker 之间按比例分摊**（`autovacuum_max_workers` 默认 3）：worker 越多，单个越慢，**总速度不变**；
- 调优：**现代 SSD/云盘上默认值常常过于保守**——表现为“autovacuum 一直在跑但永远追不上”。可**提高 `autovacuum_vacuum_cost_limit`（如 1000~3000）、降低 delay**、增加 `autovacuum_max_workers`（并同步调大总 limit），并给热点大表单独配置；
- 调度：autovacuum launcher 每 `autovacuum_naptime`（默认 1 分钟）轮询数据库，worker 选表按“距离阈值的紧迫程度”（防回卷优先）。

### 监控 autovacuum 是否健康

```sql
-- 死元组与最近清理情况
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 1) AS dead_pct,
       last_autovacuum, last_autoanalyze, n_tup_upd, n_tup_hot_upd
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 20;

-- 正在运行的清理进度（含阶段与内存数组使用）
SELECT * FROM pg_stat_progress_vacuum;
```

打开 **`log_autovacuum_min_duration = 0`（或较小值）**，日志里能看到每次清理的**扫描页数、移除元组数、索引扫描轮数（index scans）、跳过的页、耗时**——“index scans 次数 > 1”说明 `maintenance_work_mem` 不够。

## 冻结与事务 ID 回卷

### 为什么会回卷

- XID 是 **32 位**无符号整数，**循环使用**；比较采用**模 2³² 的“半圆”**：对任一事务，**约 21 亿个事务在它“之前”（过去），21 亿在“之后”（未来）**；
- 如果一个元组的 `xmin` 太老（距今超过 ~21 亿），它就会**“翻转”成未来事务**，变得**不可见 → 数据“消失”**；
- 所以必须在**到期前把老元组冻结**：**冻结 = 标记该元组 xmin 为“已冻结（永远可见）”**（`HEAP_XMIN_FROZEN`，早期通过替换 xmin 为 `FrozenXID`）。

### 冻结参数与流程

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `vacuum_freeze_min_age` | 5000 万 | VACUUM 扫描到的元组，**xmin 年龄超过此值就冻结** |
| `vacuum_freeze_table_age` | 1.5 亿 | 表的 `relfrozenxid` 年龄超过此值，VACUUM 升级为**激进（aggressive）扫描**（不能跳过非 all-frozen 页） |
| `autovacuum_freeze_max_age` | 2 亿 | 超过则**强制防回卷 autovacuum**（不可取消） |
| `vacuum_failsafe_age`（PG14+） | 16 亿 | 逼近危险线时进入**failsafe 模式**：忽略成本限速、跳过索引清理，尽快冻结 |

**保护机制**：当距离回卷约 **4000 万**事务时开始警告；距离 **300 万**时**拒绝新的事务分配（只读）**，必须在单用户模式下手动 VACUUM（长时间停机）。

### 监控与处置

```sql
-- 库级与表级的年龄
SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY xid_age DESC;
SELECT relname, age(relfrozenxid) AS xid_age, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class
WHERE relkind IN ('r','m','t') ORDER BY age(relfrozenxid) DESC LIMIT 20;
```

- **告警阈值**：年龄 > 5 亿开始关注，> 10 亿需要主动干预；
- **常见回卷风险来源**：**长事务/复制槽钉住 xmin 使 VACUUM 无法推进 relfrozenxid**、autovacuum 被关闭/被锁阻塞（如 DDL 与 autovacuum 互斥）、超大表单次冻结耗时过长、**大量只读/追加表没被及时冻结**（PG13 之前 insert-only 表不触发 autovacuum）；
- 处置：先**解除钉住**（结束长事务、清理失效复制槽），再手动 `VACUUM (FREEZE, VERBOSE)` 针对最老的表，必要时调大 cost_limit 加速；
- 预防：监控 `age()`，对大表设置表级 `autovacuum_freeze_max_age`（可调大但要谨慎）与表级 vacuum 参数；**不要关闭 autovacuum**；
- **MultiXact** 同样有 `age(datminmxid)`、`autovacuum_multixact_freeze_max_age`，外键密集的系统要一起监控。

## 谁在阻止清理：定位“元凶”

膨胀失控时，**先看谁钉住了 xmin**：

```sql
-- 1) 长事务与 idle in transaction
SELECT pid, usename, state, xact_start, now() - xact_start AS xact_age, backend_xmin, left(query, 80)
FROM pg_stat_activity WHERE backend_xmin IS NOT NULL ORDER BY age(backend_xmin) DESC LIMIT 10;

-- 2) 复制槽（尤其是不再被消费的逻辑/物理槽）
SELECT slot_name, slot_type, active, xmin, catalog_xmin, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

-- 3) 未决的准备事务（2PC）
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;
```

| 元凶 | 说明与处置 |
| --- | --- |
| **长事务 / idle in transaction** | 应用层**连接池泄漏未提交**、批处理大事务、BI 长查询；设置 **`idle_in_transaction_session_timeout`**、`statement_timeout`、`transaction_timeout`（新版本）；应用修正事务边界 |
| **复制槽（逻辑/物理）** | 消费者宕机的槽会**无限保留 WAL 并钉住 catalog_xmin/xmin**；监控 `retained_wal`，设置 **`max_slot_wal_keep_size`** 上限，失效槽及时删除，见 [PG WAL 与复制深入](#/pg/wal-replication) |
| **备库 `hot_standby_feedback=on`** | 备库的长查询把 xmin 反馈给主库，**主库无法清理**；权衡：避免备库查询冲突被取消 vs 主库膨胀。长报表放专门的备库并**不开 feedback**，或接受 `max_standby_streaming_delay` 后取消 |
| **未决 2PC 事务** | 分布式事务悬挂；定期清理超时的 prepared transactions |
| **逻辑解码的长事务** | 逻辑复制消费者落后，同样钉住 catalog_xmin |

## 膨胀：成因、检测与治理

### 成因

| 成因 | 说明 |
| --- | --- |
| **清理跟不上** | autovacuum 阈值太高/限速太慢/worker 太少 |
| **被钉住** | 上节的“元凶” |
| **非 HOT 更新多** | 频繁更新带索引的列，产生大量死索引项；索引膨胀更难回收（页面只在完全为空时才能被回收复用） |
| **大批量更新/删除** | 一次性产生海量死元组，VACUUM 回收后空间留在表内（复用但不归还 OS） |
| **fillfactor 与页内布局** | 无 HOT 空间导致更新落到新页 |
| **表尾部空页不连续** | VACUUM 只能截断尾部连续空页 |

### 检测

| 方法 | 说明 |
| --- | --- |
| **`pg_stat_user_tables.n_dead_tup`** | 估算死元组数（统计信息，近似） |
| **`pgstattuple` 扩展** | `pgstattuple(table)` 精确统计死元组比例、空闲空间；`pgstattuple_approx` 近似但更快（利用 VM） |
| **估算膨胀的检查 SQL** | 社区常用的 bloat estimation 查询（基于 `pg_class` 与统计估算理论大小 vs 实际大小），误差较大但免扩展 |
| **表/索引大小趋势** | 数据量不变而体积持续增长 |
| **`pg_stat_user_indexes` + `pgstatindex`** | 索引的叶子密度、碎片化 |

### 治理手段

| 手段 | 锁与影响 | 适用 |
| --- | --- | --- |
| **调优 autovacuum**（阈值/限速/worker） | 无锁，持续 | **首选与根本**：让清理跟上写入 |
| **解除钉住元凶** | — | 先做，否则清理无效 |
| **`VACUUM`（手动）** | 轻量锁，不阻塞读写 | 追赶，复用空间 |
| **`REINDEX INDEX CONCURRENTLY`**（PG12+） | 不阻塞读写（较慢，需额外空间） | **索引膨胀**重建 |
| **`pg_repack`（扩展）** | 短暂排他锁（开始/结束），过程中在线 | **表膨胀**在线整理：建新表+触发器同步增量+交换；需要额外磁盘与主键/唯一索引 |
| **`VACUUM FULL` / `CLUSTER`** | **ACCESS EXCLUSIVE**，阻塞读写，重写全表 | 仅维护窗口 |
| **`TRUNCATE` + 分区** | 分区表按分区 `DROP/DETACH`，**根本避免“删大量历史数据”产生的膨胀** | 时间序列/日志型数据首选，见 [PG 分区与扩展生态](#/pg/partition-ext) |
| **降低更新放大** | 提高 HOT 比例（fillfactor、减少被索引列更新）、避免空更新、合并多次更新为一次 | 持续优化 |
| **应用层** | 避免“更新同一行千万次的计数器”热点（改为追加+汇总，或用缓存/Redis 累加），见 [案例：高并发写入与热点治理](#/design/case-highwrite) | 热点行 |

**膨胀对性能的影响**：顺序扫描要读更多页；索引变大、缓存命中降低；`Index-Only Scan` 回表增多；备份/复制/恢复体量变大；**极端情况下磁盘打满**。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 表越来越大，autovacuum 一直在跑 | 清理速度跟不上写入；被长事务钉住 | 提速（cost limit、worker）；找元凶 |
| autovacuum 日志 `dead tuples cannot be removed yet` | 有活跃快照/复制槽钉住 xmin | 定位并解除 |
| `Index Only Scan` 的 `Heap Fetches` 很高 | VM 位过期（长期没 VACUUM） | 及时 VACUUM；调低表级阈值 |
| 导入后首个查询特别慢并产生大量写 | Hint bits 写入 | 导入后 VACUUM/ANALYZE |
| 突然出现“database is not accepting commands to avoid wraparound” | 防回卷保护触发 | 单用户模式 VACUUM；根因是回卷风险长期未监控 |
| `could not truncate` 或 VACUUM 被取消 | 尾部页被其他锁占用；DDL 冲突 | 重试；避免与 DDL 并发 |
| 高并发下 CPU 高、等待 `SubtransSLRU`/`MultiXactOffsetSLRU` | 子事务溢出、MultiXact 压力 | 减少 SAVEPOINT/异常块；外键与锁模型优化 |
| 更新很慢、WAL 暴增 | 非 HOT 更新放大索引；FPW | 调整索引与 fillfactor，见 [PG WAL 与复制深入](#/pg/wal-replication) |

## 运维清单

- [ ] 是否监控 `age(datfrozenxid)`、`age(relfrozenxid)`、`age(datminmxid)` 并设告警？
- [ ] 大表是否有表级 autovacuum 参数（降低 scale_factor、提高 cost_limit）？
- [ ] 是否开启 `log_autovacuum_min_duration` 并观察 index scans 次数？
- [ ] 是否设置 `idle_in_transaction_session_timeout`，并监控长事务、复制槽、2PC 悬挂？
- [ ] 复制槽是否有 `max_slot_wal_keep_size` 兜底与失效槽清理？
- [ ] 批量导入/大批量更新后是否手动 VACUUM/ANALYZE？
- [ ] 频繁更新的表是否评估了 fillfactor 与 HOT 比例？
- [ ] 历史数据是否用分区 DROP 代替大批量 DELETE？
- [ ] 是否有 `pg_repack`/`REINDEX CONCURRENTLY` 的在线整理流程与磁盘余量？

## 相关阅读

- [MVCC、VACUUM 与锁（PG）](#/pg/mvcc)：MVCC、VACUUM 与锁的基础
- [PG 优化器原理](#/pg/optimizer)：可见性映射与仅索引扫描对计划的影响
- [PG WAL 与复制深入](#/pg/wal-replication)：复制槽、反馈与 WAL 保留
- [PG 锁、隔离级别与连接池](#/pg/concurrency)：长事务与锁
- [PG 分区与扩展生态](#/pg/partition-ext)：用分区治理历史数据与膨胀
- [事务隔离与 MVCC（MySQL）](#/mysql/transaction)：InnoDB 的 undo 版本链对照

## 面试追问

> [!QUESTION] PostgreSQL 的 MVCC 是怎么实现的？和 InnoDB 有什么区别？
> 多版本存放在堆表里：UPDATE 写新版本并给旧版本设置 xmax，DELETE 只设 xmax，每个元组头有 xmin、xmax、ctid 等。事务拿快照（xmin、xmax、活动事务列表），结合提交日志判断元组可见性。InnoDB 把旧版本放在 undo 段并由 purge 回收，PG 的旧版本留在表中，由 VACUUM 清理，所以会有表膨胀和事务 ID 回卷问题，但回滚很快。

> [!QUESTION] 什么是 HOT 更新？有什么条件？
> Heap-Only Tuple 更新：更新的列都不是索引列，且新版本能放进同一个堆页，此时索引不新增项，通过页内链接找到新版本，避免索引写放大和膨胀。可降低 fillfactor 为页内预留空间、避免对频繁更新的列建索引、避免空更新来提高 HOT 比例，用 n_tup_hot_upd 与 n_tup_upd 观察。

> [!QUESTION] VACUUM 做了什么？为什么大表上很慢？
> 扫描堆（跳过 VM 标记全可见的页）收集死元组 TID，清理所有索引中指向它们的项，再回收堆里的死元组空间并更新 FSM 和 VM，冻结老元组，更新统计。死元组数组受 maintenance_work_mem 限制，装不下就分多轮，每轮都要扫一遍所有索引，所以大表、多索引、内存小时很慢；还受成本限速影响。

> [!QUESTION] 事务 ID 回卷是什么？怎么防止？
> XID 是 32 位循环使用，比较按半圆，约 21 亿事务在过去、21 亿在未来，元组 xmin 太老会翻转成未来导致数据不可见。所以要在到期前冻结老元组。防止要监控 age(datfrozenxid)，让 autovacuum 正常运行，防回卷 vacuum 在 autovacuum_freeze_max_age 时强制触发，并找出长事务、复制槽等钉住 xmin 的元凶；危险时数据库会拒绝新事务。

> [!QUESTION] 表膨胀怎么排查和治理？
> 先查谁钉住了清理水位：长事务、idle in transaction、未使用的复制槽、备库 hot_standby_feedback、未决 2PC；再看 autovacuum 是否跟得上，大表降低 scale_factor、提高 cost_limit；用 pgstattuple 检测，治理用 pg_repack 或 REINDEX CONCURRENTLY 在线整理，VACUUM FULL 只在维护窗口；历史数据用分区 DROP 代替大批量 DELETE。

> [!QUESTION] 为什么只读查询也可能产生写 I/O？
> 第一次访问元组时要查提交日志确定 xmin/xmax 事务状态，PG 把结果缓存为元组头的 Hint Bits，这会弄脏数据页。大批量导入后首次全表扫描会产生大量写，所以导入后应主动 VACUUM，在离峰期把 hint bits 和冻结状态补好。
