---
level: 深入
tags: [PostgreSQL, MVCC, VACUUM, 表膨胀, HOT, 事务隔离, xid 回卷, 锁, SKIP LOCKED]
summary: 解释 PostgreSQL 如何用 xmin/xmax 与快照实现 MVCC，为什么必须 VACUUM、表膨胀与 xid 回卷如何发生与预防，以及隔离级别、行锁、SKIP LOCKED 队列与死锁处理。
---

# MVCC、VACUUM 与锁

> [!ABSTRACT] 核心要点
> - PG 的 MVCC：每个元组带 **`xmin`（谁创建）/ `xmax`（谁删除或锁定）**；事务启动或语句开始时取**快照**，据此判断哪些版本可见。**UPDATE = 旧版本标记 xmax + 插入新版本**。
> - 旧版本留在堆里，成为**死元组（dead tuple）**，由 **VACUUM** 回收；VACUUM 跟不上就产生**表膨胀**，影响性能与磁盘。
> - **长事务/长时间不提交的复制槽/未结束的预备事务**会阻止 VACUUM 回收（因为旧版本可能还会被它们看见）——这是膨胀最常见的原因。
> - **事务 ID 是 32 位**，会回卷；**freeze** 机制保证数据不会“消失”，autovacuum 必须能跑通，否则库会被迫**停止写入**。
> - 隔离级别：`READ COMMITTED`（默认）、`REPEATABLE READ`（快照隔离，**无幻读**，但可能出现序列化失败）、`SERIALIZABLE`（SSI）。**没有脏读**。

## MVCC 可见性

### 元组头与版本链

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="UPDATE 产生新版本：旧元组 xmax 被设置，新元组 xmin 为更新事务，ctid 串起版本链">
<text class="th" x="20" y="26">初始：事务 100 插入 (id=1, balance=100)</text>
<rect class="b2" x="20" y="38" width="320" height="46" rx="6"/>
<text class="tm" x="180" y="62" text-anchor="middle" dominant-baseline="middle">T1  xmin=100 xmax=0  (1,100)</text>
<text class="th" x="20" y="124">事务 105 执行 UPDATE balance=80</text>
<rect class="b3" x="20" y="136" width="320" height="46" rx="6"/>
<text class="tm" x="180" y="160" text-anchor="middle" dominant-baseline="middle">T1  xmin=100 xmax=105  (1,100)</text>
<rect class="b2" x="400" y="136" width="320" height="46" rx="6"/>
<text class="tm" x="560" y="160" text-anchor="middle" dominant-baseline="middle">T2  xmin=105 xmax=0  (1,80)</text>
<line class="la" x1="340" y1="159" x2="400" y2="159" marker-end="url(#arr-a)"/>
<text class="ta" x="370" y="150" text-anchor="middle">ctid</text>
<text class="ts" x="20" y="212">事务 103（快照在 105 提交之前）：看到 T1（xmin=100 已提交，xmax=105 在快照中尚未提交 → 视为未删除）</text>
<text class="ts" x="20" y="234">事务 110（快照在 105 提交之后）：T1 的 xmax=105 已提交 → T1 不可见；T2 的 xmin=105 已提交 → T2 可见</text>
<text class="ts" x="20" y="260">T1 变为“死元组”：当没有任何事务还需要看到它时，VACUUM 才能回收其空间</text>
</svg>
<figcaption>图 1：UPDATE 在堆中产生新版本，旧版本等待 VACUUM 回收</figcaption>
</figure>

可见性判断（简化）：元组对某个快照可见，当且仅当

1. `xmin` 对应的事务**已提交**且在快照看来“已完成”（`xmin` < 快照的 `xmax` 且不在活跃列表 `xip` 中，或就是当前事务自身）；
2. 并且 `xmax` **为 0 或对应事务未提交/已中止/在快照看来未完成**。

事务提交状态存在 **commit log（`pg_xact`）**，为避免每次查 clog，第一次判断后会把结果写进元组头的**提示位（hint bits）**——这意味着**读操作也可能产生写（弄脏页）**，大批量刚写入的数据第一次被读时会出现写 IO。

快照 `pg_snapshot`：包含 `xmin`（最小活跃事务）、`xmax`（下一个将分配的事务 ID）、`xip`（活跃事务列表）：

```sql
SELECT txid_current(), txid_current_snapshot();        -- 如 105 | 100:110:100,103
SELECT xmin, xmax, ctid, * FROM accounts WHERE id = 1;  -- 直接查看系统列
```

### 与 InnoDB 对比

| | PostgreSQL | InnoDB |
| --- | --- | --- |
| 旧版本位置 | **堆表中**（同表同页） | undo log |
| 回收 | VACUUM（后台进程，需调优） | purge 线程 |
| 读旧版本 | 直接读堆中元组，不必重建 | 沿 undo 版本链回溯重建 |
| 长事务影响 | 阻止回收 → **表和索引膨胀** | undo 膨胀（`history list length`） |
| 回滚 | **极快**（只标记事务中止，不需要撤销修改） | 需要根据 undo 逐条撤销 |

详细对比 InnoDB 机制见 [事务隔离与 MVCC](#/mysql/transaction)。

## HOT 更新

普通 UPDATE 产生新元组，**所有索引都要新增指向新元组的条目**，代价大。**HOT（Heap-Only Tuple）**优化：当满足

1. 更新**没有修改任何索引列**；
2. **同一页内有足够空闲空间**放下新版本；

则新版本不产生新的索引条目，旧版本通过页内的重定向链连到新版本（索引仍指向旧版本的行指针，沿链找到最新）。HOT 链上的死元组可被**页内修剪（pruning）**，无需等待 VACUUM。

实践意义：

- **频繁更新的表**应留出页空闲空间：`ALTER TABLE t SET (fillfactor = 80)`（默认 100），为 HOT 预留空间；
- 尽量**少建索引**，尤其是更新频繁列上的索引；
- 观察：`pg_stat_user_tables.n_tup_hot_upd / n_tup_upd` 比例。

## VACUUM

### 做什么

| 动作 | 说明 |
| --- | --- |
| 回收死元组空间 | 空间标记为可重用（记录到 **FSM**，Free Space Map），**普通 VACUUM 通常不把空间还给操作系统**（仅截断尾部空页） |
| 清理索引中的死条目 | 先扫描堆收集死元组 TID，再批量删除索引条目（受 `maintenance_work_mem` 限制，空间小会多遍扫描索引） |
| 更新 **visibility map（VM）** | 标记“整页所有元组对所有事务可见”的页，**Index Only Scan 与后续 VACUUM 都依赖它** |
| **冻结（freeze）** | 把足够老的元组标记为“永远可见”，防止事务 ID 回卷 |
| 更新统计信息（`VACUUM ANALYZE`） | `ANALYZE` 收集优化器统计 |

`VACUUM FULL`：**重写整张表**，真正缩小文件，但需要 **ACCESS EXCLUSIVE 锁**（阻塞读写），生产慎用；在线收缩用 `pg_repack` / `pg_squeeze` 扩展。

### autovacuum

后台进程自动触发，触发条件（表级）：

```text
死元组数 > autovacuum_vacuum_threshold(50) + autovacuum_vacuum_scale_factor(0.2) × 表行数
```

大表的问题：1 亿行的表要累积 **2000 万死元组**才触发，太晚 → 膨胀。常规调优：

```sql
-- 对大表/热点表单独调小 scale_factor
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01,
                        autovacuum_vacuum_threshold = 1000,
                        autovacuum_analyze_scale_factor = 0.02);
```

| 参数 | 说明 |
| --- | --- |
| `autovacuum_max_workers`（默认 3） | 同时运行的 worker 数，大库可加到 5~10 |
| `autovacuum_vacuum_cost_limit` / `cost_delay` | **成本限流**，防止 VACUUM 抢占 IO；默认较保守，磁盘好的机器要放大（如 cost_limit=2000）|
| `autovacuum_naptime`（1min） | 唤醒周期 |
| `vacuum_cost_*` | 手动 VACUUM 的限流 |

> [!WARNING] 不要关闭 autovacuum
> 关掉 autovacuum 的短期收益是“少了 IO”，长期代价是表膨胀、统计信息过时导致**坏执行计划**，最终可能走向 xid 回卷故障。正确做法是**调优**而不是关闭。

### 表膨胀：成因与排查

<figure class="fig">
<svg viewBox="0 0 740 240" class="dg" role="img" aria-label="长事务阻止 VACUUM 回收死元组，导致表膨胀的时间线">
<line class="l" x1="30" y1="120" x2="710" y2="120" marker-end="url(#arr)"/>
<rect class="b4" x="60" y="60" width="440" height="30" rx="4"/>
<text class="tb" x="280" y="76" text-anchor="middle" dominant-baseline="middle">长事务 / 空闲事务（idle in transaction）持有旧快照</text>
<text class="ts" x="60" y="52" text-anchor="start">BEGIN（xmin 被固定）</text>
<text class="ts" x="500" y="52" text-anchor="end">一直未提交</text>
<rect class="b3" x="130" y="140" width="80" height="34" rx="4"/>
<text class="ts" x="170" y="157" text-anchor="middle" dominant-baseline="middle">大量 UPDATE</text>
<rect class="b3" x="250" y="140" width="80" height="34" rx="4"/>
<text class="ts" x="290" y="157" text-anchor="middle" dominant-baseline="middle">autovacuum</text>
<rect class="b3" x="370" y="140" width="110" height="34" rx="4"/>
<text class="ts" x="425" y="157" text-anchor="middle" dominant-baseline="middle">回收不了死元组</text>
<text class="ta" x="620" y="157" text-anchor="middle">表/索引持续膨胀</text>
<text class="ts" x="370" y="214" text-anchor="middle">VACUUM 只能回收“比最老活跃快照还早”的死元组；任何一个老事务都会把回收线卡在它那里</text>
</svg>
<figcaption>图 2：长事务阻止 VACUUM，导致膨胀</figcaption>
</figure>

阻止回收的“罪魁”清单（按常见程度）：

1. **长事务**或 `idle in transaction`（应用开启事务后忘记提交/连接泄漏）；
2. **滞后的复制槽**（`pg_replication_slots` 中 `restart_lsn/xmin` 很老）：逻辑复制或备库掉线后槽仍保留 WAL 与 xmin；
3. 备库开启 `hot_standby_feedback` 且备库上有长查询；
4. 未提交的 **prepared transaction**（两阶段提交遗留）。

```sql
-- 找长事务与 idle in transaction
SELECT pid, usename, state, now()-xact_start AS xact_age, now()-state_change AS idle_age, left(query,80)
FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 10;

-- 看死元组与 autovacuum 情况
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;

-- 看复制槽
SELECT slot_name, active, xmin, restart_lsn FROM pg_replication_slots;
```

预防措施：`idle_in_transaction_session_timeout`（如 60s）、`statement_timeout`、`lock_timeout`；应用侧保证事务短小、连接池泄漏检测；复制槽设置 `max_slot_wal_keep_size`。

## 事务 ID 回卷（Wraparound）

事务 ID（XID）是 **32 位**无符号数（约 42 亿），按**模运算**比较新旧：任意时刻，**对一个事务而言，约 21 亿个事务在“过去”，21 亿个在“未来”**。如果一个元组的 `xmin` 太老（距今超过 21 亿），它会**突然“看起来”变成未来事务创建的，变得不可见**——数据“消失”。

对策：**freeze**。VACUUM 把足够老的元组 `xmin` 标记为“冻结”（永远可见）：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `vacuum_freeze_min_age` | 5000 万 | 老于此值的元组在 VACUUM 时被冻结 |
| `autovacuum_freeze_max_age` | **2 亿** | 表的最老未冻结 XID 年龄到此值，**强制触发防回卷 autovacuum**（不可被取消） |
| 警告阈值 | 剩余约 4000 万 | 日志警告 |
| 停写阈值 | 剩余约 300 万 | **拒绝新事务，只能单用户模式 VACUUM 修复** |

监控：

```sql
SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY 2 DESC;
SELECT relname, age(relfrozenxid) FROM pg_class WHERE relkind='r' ORDER BY 2 DESC LIMIT 10;
```

`age` 接近 `autovacuum_freeze_max_age`（2 亿）说明防回卷 VACUUM 即将/正在进行；这类 VACUUM **会扫描整表**，大表耗时长，需要监控并**提前手动在业务低峰执行 `VACUUM FREEZE`**。PG 9.6+ 的 **visibility map 的 all-frozen 位**让已冻结的页可跳过，大幅降低重复冻结成本。（注意：PG 目前仍是 32 位事务 ID 的实现，64 位 XID 的改造在社区讨论中，请以所用版本为准。）

## 隔离级别

| 级别 | PG 实现 | 异象 |
| --- | --- | --- |
| Read Uncommitted | 与 Read Committed 相同（**不会读到脏数据**） | — |
| **Read Committed**（默认） | **每条语句**获取新快照 | 不可重复读、幻读 |
| **Repeatable Read** | **事务内**所有语句共用第一条语句的快照（快照隔离 SI） | **无幻读**；但可能**写偏斜**；并发更新同一行时后者得到 `could not serialize access due to concurrent update` |
| **Serializable** | **SSI**（可串行化快照隔离）：在 SI 基础上检测危险的读写依赖环 | 无异象；可能抛序列化失败，**应用必须重试** |

```java
// Repeatable Read / Serializable 下要处理 SQLState 40001（serialization_failure）并重试整个事务
for (int i = 0; i < 3; i++) {
    try { return tx.execute(...); }
    catch (PSQLException e) { if (!"40001".equals(e.getSQLState())) throw e; Thread.sleep(backoff(i)); }
}
```

与 MySQL 的差异：MySQL RR 用**间隙锁**防幻读，且“快照读/当前读”混用时仍有幻读（见 [事务隔离与 MVCC](#/mysql/transaction)）；PG 的 RR 是纯快照，**不加间隙锁**，靠检测冲突而非阻塞。

## 锁

### 行级锁

- 行锁**不占用内存中的锁表**，直接**写在元组头**（`xmax` + 锁模式位）：因此锁几百万行不会撑爆内存（与 InnoDB 不同），但**加锁会弄脏页（产生写）**；
- `SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE`：四种行锁强度；`UPDATE` 自动加 `FOR NO KEY UPDATE`（不更新键列）或 `FOR UPDATE`；外键检查用 `FOR KEY SHARE`，与 `FOR NO KEY UPDATE` 兼容，因此**更新非键列不会阻塞外键引用**；
- 等待行锁时，进程等待“持锁事务 ID 的锁”（transactionid lock）。

### SKIP LOCKED：用数据库做任务队列

```sql
-- 多个 worker 并发取任务，互不阻塞，不会重复处理
WITH job AS (
  SELECT id FROM task WHERE status = 'PENDING'
  ORDER BY id LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE task t SET status = 'RUNNING', started_at = now()
FROM job WHERE t.id = job.id
RETURNING t.*;
```

`NOWAIT`：拿不到锁立刻报错；`SKIP LOCKED`：跳过已被锁定的行。**适合轻量任务队列**（见 [消息队列核心问题](#/mw/mq)），高吞吐场景仍应使用专业 MQ。

### 表级锁与 DDL 的坑

| 锁模式 | 典型命令 | 与谁冲突 |
| --- | --- | --- |
| ACCESS SHARE | `SELECT` | 仅 ACCESS EXCLUSIVE |
| ROW EXCLUSIVE | `INSERT/UPDATE/DELETE` | SHARE 及以上 |
| SHARE UPDATE EXCLUSIVE | `VACUUM`、`CREATE INDEX CONCURRENTLY` | 自己与更强锁 |
| SHARE | `CREATE INDEX`（非并发） | 阻塞写 |
| **ACCESS EXCLUSIVE** | `ALTER TABLE` 多数形式、`DROP`、`VACUUM FULL`、`TRUNCATE` | **与所有锁冲突，包括 SELECT** |

> [!CAUTION] DDL 排队效应
> `ALTER TABLE` 要拿 ACCESS EXCLUSIVE，若有一个**长查询**持有 ACCESS SHARE，DDL 会等；而**后续所有新查询又会排在 DDL 后面等待**——一个 DDL 就能让整张表“卡死”。对策：DDL 前设置 `SET lock_timeout = '3s'`，失败重试；建索引用 `CREATE INDEX CONCURRENTLY`；加列带默认值在 11+ 已是**元数据操作**（不重写表）；重大变更用**在线迁移**工具。（MySQL 中同类问题叫 MDL 锁，见 [锁机制与死锁分析](#/mysql/lock)。）

### 死锁

PG 自动检测死锁（`deadlock_timeout` 默认 1s 后检查），**中止其中一个事务**并报错 `deadlock detected`。预防同 MySQL：**统一加锁顺序**、缩短事务、避免用户交互期间持锁。日志里会输出涉及的进程与语句；`log_lock_waits = on` 记录超过 `deadlock_timeout` 的锁等待。

```sql
-- 查谁在阻塞谁
SELECT a.pid AS waiting, pg_blocking_pids(a.pid) AS blockers, a.wait_event_type, a.wait_event, left(a.query,80)
FROM pg_stat_activity a WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```

## 相关阅读

- [TiDB 架构：TiKV、PD、Raft 与分布式事务](#/db/tidb-arch)：TiDB 的 MVCC 与 GC 对比
- [事务隔离与 MVCC](#/mysql/transaction)：MySQL 的 MVCC 实现
- [PostgreSQL MVCC 内部机制：可见性、剪枝、VACUUM 与膨胀治理](#/pg/vacuum-internals)：元组头、快照、剪枝、VACUUM 阶段与冻结
- [PostgreSQL 锁、隔离级别与连接池：并发控制深入](#/pg/concurrency)：表锁矩阵、SSI、死锁与连接池

## 面试追问

> [!QUESTION] PostgreSQL 的 MVCC 是如何实现的？与 InnoDB 有什么不同？
> 元组头保存 xmin/xmax，UPDATE 产生新版本、旧版本标记 xmax，旧版本留在堆里；读时用快照与事务状态判断可见性。InnoDB 把旧版本放在 undo log 并通过版本链回溯。PG 因此需要 VACUUM 清理死元组，但回滚极快、读旧版本无需重建。

> [!QUESTION] 什么是表膨胀？怎么发现和解决？
> 死元组无法及时回收，导致表/索引占用空间远大于有效数据。通过 `pg_stat_user_tables` 的 `n_dead_tup`、pgstattuple、体积对比发现；先排查长事务/复制槽/idle in transaction，调小大表的 autovacuum scale factor，必要时用 pg_repack 在线重整，而不是 VACUUM FULL。

> [!QUESTION] 什么是事务 ID 回卷？如何避免？
> XID 是 32 位，会循环使用，太老的元组会被误判为未来事务创建而不可见。VACUUM 通过冻结老元组避免；要保证 autovacuum 正常运行、监控 age(datfrozenxid)、对大表提前在低峰手动 VACUUM FREEZE。逼近停写阈值时数据库会拒绝写入。

> [!QUESTION] HOT 更新是什么？怎么利用？
> 更新未修改索引列且页内有空间时，新版本不产生索引条目，沿页内链指向，可被页内修剪回收。给频繁更新的表设置较低 fillfactor、减少无用索引可提升 HOT 比例。

> [!QUESTION] PG 的 Repeatable Read 会出现幻读吗？
> 不会，它基于事务级快照，不加间隙锁；但并发更新同一行会收到序列化失败错误，应用要重试；要完全避免写偏斜等异常需使用 Serializable（SSI）并同样重试。
