---
level: 深入
tags: [InnoDB, MDL, 间隙锁, Next-Key Lock, 死锁, data_locks]
summary: 从全局锁、表锁、MDL 到行级的 Record/Gap/Next-Key/插入意向锁，用具体数据画出加锁范围，并给出死锁日志解读与线上锁问题的排查路径。
---

# 锁机制与死锁分析

> [!ABSTRACT] 核心要点
> - 锁的层级：全局锁（FTWRL）→ 表级（表锁、**MDL**、意向锁、AUTO-INC 锁）→ 行级（Record / Gap / Next-Key / Insert Intention）。
> - **MDL 是加字段导致全库雪崩的元凶**：长事务持有 MDL 读锁 → DDL 等 MDL 写锁 → 后续所有读写排在 DDL 后面被阻塞。DDL 前务必设 `lock_wait_timeout`。
> - InnoDB 行锁**锁的是索引记录**，RR 下默认加 Next-Key Lock（前开后闭），唯一索引等值命中退化为记录锁，等值未命中退化为间隙锁；**查询条件没走索引就会锁住全表所有记录和间隙**。
> - 间隙锁之间不冲突，只阻止插入；“先 `SELECT ... FOR UPDATE` 判断不存在再 INSERT”在并发下是经典死锁模式。
> - 排查：8.0 用 `performance_schema.data_locks` / `data_lock_waits`，死锁看 `SHOW ENGINE INNODB STATUS` 的 `LATEST DETECTED DEADLOCK`，并开启 `innodb_print_all_deadlocks`。

## 全局锁

```sql
FLUSH TABLES WITH READ LOCK;   -- FTWRL：整个实例只读，DML、DDL、事务提交都会阻塞
UNLOCK TABLES;
```

典型用途是做全库逻辑备份时获得一致性位点。对全 InnoDB 的库，`mysqldump --single-transaction` 利用 MVCC 快照即可，不需要长时间持有全局锁。8.0 还提供了更轻量的备份锁 `LOCK INSTANCE FOR BACKUP`，只阻止 DDL 等会破坏备份一致性的操作，不阻止 DML。

> [!CAUTION] 在主库上执行 FTWRL
> FTWRL 首先要等待所有正在执行的查询结束（关闭表），如果此时有一个运行很久的大查询，FTWRL 会一直等，而它已经阻塞了后续所有写入——整个库的写入因为一个慢查询而停摆。XtraBackup 等工具在备份非 InnoDB 表时也会短暂使用它，应在从库上备份。

## 表级锁

### 表锁

`LOCK TABLES t READ / WRITE` 显式加表锁，InnoDB 场景下基本没有使用必要，且会限制本线程只能访问被锁的表。

### MDL 元数据锁

5.5 引入，**自动加、无需显式操作**：

- 对表做 DML / SELECT 时加 **MDL 读锁**（共享）；
- 对表做 DDL（改结构）时加 **MDL 写锁**（排他）；
- MDL 在**事务提交时**才释放，而不是语句结束时。

MDL 的等待队列有个关键规则：**写锁请求优先级高于读锁**，一个写锁在排队时，后来的读锁请求也必须排在它后面。这就导致了一个经典事故：

<figure class="fig">
<svg viewBox="0 0 740 290" class="dg" role="img" aria-label="长事务持有 MDL 读锁导致 ALTER TABLE 等待，进而阻塞后续所有查询的时序">
<line class="ld" x1="620" y1="40" x2="620" y2="245"/>
<text class="ts" x="620" y="30" text-anchor="middle">A 提交，释放 MDL</text>
<text class="tb" x="20" y="62">A：长事务</text>
<text class="ts" x="20" y="80">SELECT 后未提交</text>
<rect class="b2" x="180" y="50" width="440" height="36" rx="4"/>
<text class="t" x="400" y="68" text-anchor="middle" dominant-baseline="middle">持有 MDL 读锁</text>
<text class="tb" x="20" y="112">B：ALTER TABLE</text>
<text class="ts" x="20" y="130">加字段</text>
<rect class="b4" x="300" y="100" width="320" height="36" rx="4"/>
<text class="t" x="460" y="118" text-anchor="middle" dominant-baseline="middle">等待 MDL 写锁</text>
<rect class="b1" x="620" y="100" width="100" height="36" rx="4"/>
<text class="t" x="670" y="118" text-anchor="middle" dominant-baseline="middle">执行 DDL</text>
<text class="tb" x="20" y="162">C：SELECT</text>
<text class="ts" x="20" y="180">普通查询</text>
<rect class="b4" x="400" y="150" width="220" height="36" rx="4"/>
<text class="t" x="510" y="168" text-anchor="middle" dominant-baseline="middle">排在写锁之后，阻塞</text>
<text class="tb" x="20" y="212">D：UPDATE</text>
<text class="ts" x="20" y="230">后续所有读写</text>
<rect class="b4" x="500" y="200" width="120" height="36" rx="4"/>
<text class="t" x="560" y="218" text-anchor="middle" dominant-baseline="middle">阻塞，连接打满</text>
<line class="l" x1="170" y1="250" x2="725" y2="250" marker-end="url(#arr)"/>
<text class="tm" x="180" y="270" text-anchor="middle">t1</text>
<text class="tm" x="300" y="270" text-anchor="middle">t2</text>
<text class="tm" x="400" y="270" text-anchor="middle">t3</text>
<text class="tm" x="500" y="270" text-anchor="middle">t4</text>
<text class="tm" x="620" y="270" text-anchor="middle">t5</text>
</svg>
<figcaption>图 1：MDL 雪崩时序。B 本身只是在等，但它的写锁请求挡住了之后所有需要 MDL 读锁的语句</figcaption>
</figure>

`SHOW PROCESSLIST` 中会看到大量 `Waiting for table metadata lock`。找出阻塞源：

```sql
-- 8.0（metadata_locks 默认开启采集）：谁持有、谁在等
SELECT * FROM sys.schema_table_lock_waits\G
-- 关注 blocking_pid / sql_kill_blocking_connection 字段
-- 再结合 information_schema.innodb_trx 找到没提交的长事务
```

> [!TIP] 安全执行 DDL 的姿势
> 1. 执行前查 `information_schema.innodb_trx`，确认没有长事务；
> 2. 设置等待超时，拿不到锁就放弃而不是无限排队：`SET SESSION lock_wait_timeout = 5;`（默认值是 31536000 秒，即一年）；
> 3. 失败后在低峰期重试，或使用 gh-ost、pt-online-schema-change 等工具；
> 4. Online DDL 并非全程无锁：开始和结束阶段都要短暂获取 MDL 写锁。8.0 的 `ALGORITHM=INSTANT` 加列（8.0.12+ 末尾加列，8.0.29+ 任意位置）只改元数据，速度极快，但同样需要 MDL 写锁。

### 意向锁

意向锁是表级锁，表示“表里有某些行被加了 S/X 锁”：

- 对行加 S 锁前，先对表加 **IS**；对行加 X 锁前，先对表加 **IX**。
- 作用：让表级 S/X 锁（如 `LOCK TABLES ... WRITE`）判断冲突时不必逐行检查。

| | IS | IX | 表 S | 表 X |
| --- | --- | --- | --- | --- |
| IS | 兼容 | 兼容 | 兼容 | 冲突 |
| IX | 兼容 | 兼容 | 冲突 | 冲突 |
| 表 S | 兼容 | 冲突 | 兼容 | 冲突 |
| 表 X | 冲突 | 冲突 | 冲突 | 冲突 |

意向锁之间全部兼容，所以它**不会阻塞任何行级操作**，只与表级锁冲突。

### AUTO-INC 锁

`innodb_autoinc_lock_mode`：0 传统模式（语句级表锁）；1 连续模式（5.7 默认，简单 INSERT 用轻量互斥量，`INSERT ... SELECT` 等批量插入仍用表级 AUTO-INC 锁）；2 交错模式（8.0 默认，全部用轻量互斥量，并发最好，但批量插入的 ID 可能不连续，需要 ROW 格式 binlog 保证主从一致）。

## 行级锁

| 锁 | 锁住什么 | `data_locks.LOCK_MODE` | 说明 |
| --- | --- | --- | --- |
| Record Lock | 一条索引记录 | `X,REC_NOT_GAP` | |
| Gap Lock | 两条索引记录之间的开区间 | `X,GAP` | 只阻止插入；间隙锁之间互不冲突（S/X 都一样） |
| Next-Key Lock | 记录 + 它前面的间隙，前开后闭 `(prev, cur]` | `X` | RR 下的默认加锁单位 |
| Insert Intention | 插入位置所在的间隙 | `X,INSERT_INTENTION` | 一种特殊的间隙锁；与其他事务持有的 Gap/Next-Key 冲突，插入意向锁之间不冲突 |

间隙锁只在 **RR 及以上**隔离级别存在，目的是防止当前读的幻读。RC 下除外键检查和唯一键冲突检查外不加间隙锁。

### 加锁规则（RR）

社区广泛引用的总结（基于 5.7 / 8.0 早期版本的源码与实验）：

1. **原则 1**：加锁的基本单位是 Next-Key Lock，前开后闭。
2. **原则 2**：查找过程中**访问到的对象**才会加锁（覆盖索引上的 `FOR SHARE` 不回表，就不会锁主键；但 `FOR UPDATE` 会认为你要更新，顺带锁主键）。
3. **优化 1**：索引上的等值查询，给**唯一索引**加锁时，命中记录则 Next-Key Lock 退化为**记录锁**。
4. **优化 2**：索引上的等值查询，向右遍历到**最后一个不满足等值条件**的值时，Next-Key Lock 退化为**间隙锁**。
5. **曾经的 bug**：唯一索引上的范围查询会多访问到不满足条件的第一个值，并加 Next-Key Lock。8.0.18 起修复。

### 用数据画出锁的范围

```sql
CREATE TABLE t (
  id INT PRIMARY KEY,
  c  INT, KEY idx_c (c),
  d  INT
) ENGINE=InnoDB;
INSERT INTO t VALUES (0,0,0),(5,5,5),(10,10,10),(15,15,15),(20,20,20),(25,25,25);
```

<figure class="fig">
<svg viewBox="0 0 740 365" class="dg" role="img" aria-label="不同查询条件在 RR 隔离级别下锁住的索引区间">
<text class="ts" x="20" y="16">索引上的记录：0、5、10、15、20、25，最右为 supremum 伪记录</text>
<line class="l" x1="80" y1="50" x2="700" y2="50"/>
<circle class="b" cx="100" cy="50" r="4"/>
<circle class="b" cx="200" cy="50" r="4"/>
<circle class="b" cx="300" cy="50" r="4"/>
<circle class="b" cx="400" cy="50" r="4"/>
<circle class="b" cx="500" cy="50" r="4"/>
<circle class="b" cx="600" cy="50" r="4"/>
<circle class="b" cx="680" cy="50" r="4"/>
<text class="tm" x="100" y="36" text-anchor="middle">0</text>
<text class="tm" x="200" y="36" text-anchor="middle">5</text>
<text class="tm" x="300" y="36" text-anchor="middle">10</text>
<text class="tm" x="400" y="36" text-anchor="middle">15</text>
<text class="tm" x="500" y="36" text-anchor="middle">20</text>
<text class="tm" x="600" y="36" text-anchor="middle">25</text>
<text class="tm" x="680" y="36" text-anchor="middle">sup</text>
<text class="ts" x="100" y="84">① WHERE c=10 FOR UPDATE（c 普通索引）</text>
<rect class="b4" x="200" y="92" width="100" height="22"/>
<text class="tm" x="250" y="103" text-anchor="middle" dominant-baseline="middle">(5,10]</text>
<rect class="b3" x="300" y="92" width="100" height="22"/>
<text class="tm" x="350" y="103" text-anchor="middle" dominant-baseline="middle">(10,15)</text>
<text class="ts" x="412" y="107">+ 主键 id=10 记录锁</text>
<text class="ts" x="100" y="144">② WHERE id=7 FOR UPDATE（主键等值，记录不存在）</text>
<rect class="b3" x="200" y="152" width="100" height="22"/>
<text class="tm" x="250" y="163" text-anchor="middle" dominant-baseline="middle">(5,10)</text>
<text class="ts" x="312" y="167">退化为间隙锁</text>
<text class="ts" x="100" y="204">③ WHERE id=10 FOR UPDATE（主键等值，记录存在）</text>
<rect class="b4" x="292" y="212" width="16" height="22"/>
<text class="ts" x="320" y="227">退化为记录锁，只锁 id=10</text>
<text class="ts" x="100" y="264">④ WHERE id&gt;=10 AND id&lt;11 FOR UPDATE（主键范围）</text>
<rect class="b4" x="292" y="272" width="16" height="22"/>
<rect class="b4" x="308" y="272" width="92" height="22"/>
<text class="tm" x="354" y="283" text-anchor="middle" dominant-baseline="middle">(10,15]</text>
<text class="ts" x="412" y="287">8.0.18+ 只锁间隙 (10,15)，不锁 15</text>
<text class="ts" x="100" y="324">⑤ WHERE d=10 FOR UPDATE（d 无索引）</text>
<rect class="b4" x="80" y="332" width="620" height="22"/>
<text class="t" x="390" y="343" text-anchor="middle" dominant-baseline="middle">扫描聚簇索引：所有记录 + 所有间隙，等同锁表</text>
</svg>
<figcaption>图 2：红色为记录锁或 Next-Key Lock（含右端记录），琥珀色为纯间隙锁（开区间，只阻止插入）</figcaption>
</figure>

逐条解释：

- **①** 在 idx_c 上找 c=10，加 Next-Key `(5,10]`；c 不唯一，要继续向右扫描到 c=15 才能确认没有更多 10，按优化 2 退化为间隙 `(10,15)`；`FOR UPDATE` 还会回表给主键 id=10 加记录锁。此时插入 c=7 或 c=12 都会被阻塞，插入 c=16 不受影响。
- **②** 主键找 id=7，落在 (5,10) 间隙，按优化 2 退化为间隙锁。另一个事务 `UPDATE ... WHERE id=10` 不受影响，但插入 id=8 会阻塞。
- **③** 唯一索引等值命中，退化为记录锁。
- **④** 范围查询：id=10 是等值部分，退化为记录锁；继续向后扫到 15 发现不满足 `<11`。5.7 和 8.0.17 及以前给 15 加 Next-Key `(10,15]`（连 id=15 也被锁住），8.0.18 起只锁到间隙。
- **⑤** 无索引只能全表扫描，扫描到的每条记录都加 Next-Key Lock，等于锁表。**UPDATE/DELETE 的 WHERE 条件必须走索引**，这是行锁变表锁的头号原因。

> [!WARNING] 规则会随版本微调，以实测为准
> 上面的结论适用于 5.7 与 8.0 主流版本，但细节（尤其范围查询边界、LIMIT 对加锁的影响）在小版本间有变化。拿不准时在测试库用 `performance_schema.data_locks` 直接看实际加了哪些锁，比背规则可靠。

### 插入意向锁与唯一键冲突

- INSERT 时先在插入位置的间隙申请**插入意向锁**；如果别的事务在该间隙上持有 Gap / Next-Key Lock，就等待。多个事务往同一间隙的不同位置插入，插入意向锁之间不冲突，互不阻塞。
- 插入成功后，新记录上是**隐式锁**（靠记录的 trx_id 判断），有其他事务要访问时才转换为显式记录锁。
- INSERT 遇到**唯一键冲突**时，会在冲突记录上加 **S 型 Next-Key Lock**（RC 下也会加），这是很多“并发插入同一唯一键”死锁的根源。

## 死锁

### 经典案例：先查不存在再插入

```sql
-- 表 t 中有 id=5 和 id=10，没有 id=7，RR 隔离级别
-- T1                                        -- T2
BEGIN;                                       BEGIN;
SELECT * FROM t WHERE id=7 FOR UPDATE;       
-- 加间隙锁 (5,10)，成功
                                             SELECT * FROM t WHERE id=7 FOR UPDATE;
                                             -- 也加间隙锁 (5,10)，间隙锁互不冲突，成功
INSERT INTO t VALUES (7,7,7);
-- 插入意向锁被 T2 的间隙锁阻塞，等待
                                             INSERT INTO t VALUES (7,7,7);
                                             -- 被 T1 的间隙锁阻塞 → 形成环，死锁
```

“锁住再判断，不存在就插入”的写法在高并发下几乎一定会死锁。正确做法：直接 `INSERT`，依靠唯一键冲突判断（`INSERT ... ON DUPLICATE KEY UPDATE` 或捕获 `DuplicateKeyException`）；或者改用 RC 隔离级别。

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="两个事务按相反顺序锁两行导致死锁的时序">
<rect class="b1" x="80" y="10" width="120" height="36" rx="8"/>
<text class="tb" x="140" y="28" text-anchor="middle" dominant-baseline="middle">事务 T1</text>
<rect class="b" x="240" y="10" width="120" height="36" rx="8"/>
<text class="tb" x="300" y="28" text-anchor="middle" dominant-baseline="middle">id=1 行锁</text>
<rect class="b" x="380" y="10" width="120" height="36" rx="8"/>
<text class="tb" x="440" y="28" text-anchor="middle" dominant-baseline="middle">id=2 行锁</text>
<rect class="b5" x="540" y="10" width="120" height="36" rx="8"/>
<text class="tb" x="600" y="28" text-anchor="middle" dominant-baseline="middle">事务 T2</text>
<line class="ld" x1="140" y1="46" x2="140" y2="215"/>
<line class="ld" x1="300" y1="46" x2="300" y2="215"/>
<line class="ld" x1="440" y1="46" x2="440" y2="215"/>
<line class="ld" x1="600" y1="46" x2="600" y2="215"/>
<line class="l" x1="140" y1="80" x2="298" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="220" y="72" text-anchor="middle">① 加 X 锁成功</text>
<line class="l" x1="600" y1="120" x2="442" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="520" y="112" text-anchor="middle">② 加 X 锁成功</text>
<line class="la" x1="140" y1="160" x2="438" y2="160" marker-end="url(#arr-a)"/>
<text class="ts" x="220" y="152" text-anchor="middle">③ 等待 T2 释放</text>
<line class="la" x1="600" y1="200" x2="302" y2="200" marker-end="url(#arr-a)"/>
<text class="ts" x="520" y="192" text-anchor="middle">④ 等待 T1 释放</text>
<text class="ts" x="370" y="238" text-anchor="middle">等待图出现环 T1 → T2 → T1，InnoDB 选择回滚代价较小的事务</text>
</svg>
<figcaption>图 3：交叉加锁死锁。批量更新时按主键排序后再加锁可以避免</figcaption>
</figure>

### 死锁检测与超时

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `innodb_deadlock_detect` | ON | 主动检测：每次锁等待时在等待图中找环，发现死锁立即回滚其中一个事务（通常是 undo 量较小的） |
| `innodb_lock_wait_timeout` | 50 秒 | 锁等待超时，报 `Lock wait timeout exceeded` |
| `innodb_rollback_on_timeout` | OFF | **超时默认只回滚当前语句，不回滚整个事务**，应用若捕获异常后继续提交，会提交一个“半成品”事务 |
| `innodb_print_all_deadlocks` | OFF | 建议开启，把每次死锁写入错误日志；`SHOW ENGINE INNODB STATUS` 只保留最近一次 |

**死锁检测的开销**：当大量事务同时更新同一行（热点行，如库存、账户余额）时，每个新加入的等待者都要遍历等待图，整体复杂度接近 O(n²)，CPU 被死锁检测耗尽，TPS 断崖式下跌。8.0.18 起检测移到了后台线程，缓解了对用户线程的影响，但热点更新的根本解法仍是：

- 在应用层或中间件层对同一行的更新**排队**（如按商品 ID 哈希到同一线程/队列）；
- 把一行拆成多行（库存分桶），分散热点；
- 极端情况下关闭死锁检测，依靠较短的锁等待超时（风险是真死锁要等超时才解开）。

### 解读 SHOW ENGINE INNODB STATUS

```text
------------------------
LATEST DETECTED DEADLOCK
------------------------
*** (1) TRANSACTION:
TRANSACTION 421937, ACTIVE 3 sec inserting
LOCK WAIT 3 lock struct(s), heap size 1128, 2 row lock(s)
MySQL thread id 12, query id 380 localhost root update
INSERT INTO t VALUES (7,7,7)
*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 30 page no 4 n bits 80 index PRIMARY of table `test`.`t`
trx id 421937 lock_mode X locks gap before rec
Record lock, heap no 4 PHYSICAL RECORD: n_fields 5; ... 0: len 4; hex 8000000a; ...
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 30 page no 4 n bits 80 index PRIMARY of table `test`.`t`
trx id 421937 lock_mode X locks gap before rec insert intention waiting
*** (2) TRANSACTION:
...
*** WE ROLL BACK TRANSACTION (2)
```

（以上为示意性精简输出）读法：

| 字段 | 含义 |
| --- | --- |
| `index PRIMARY of table` | 锁在哪个索引上 |
| `lock_mode X` | Next-Key Lock |
| `lock_mode X locks rec but not gap` | 记录锁 |
| `lock_mode X locks gap before rec` | 间隙锁，间隙在这条记录之前 |
| `insert intention waiting` | 插入意向锁等待 |
| `hex 8000000a` | 锁住的记录键值（INT 有符号存储，最高位翻转，`0x0a` 即 10） |
| `WE ROLL BACK TRANSACTION (2)` | 被回滚的事务 |

注意 5.7/8.0 的死锁日志里，每个事务**只显示最后一条 SQL**，持有锁可能来自之前的语句，需要结合业务代码或 binlog 还原整个事务。

### performance_schema.data_locks（8.0）

5.7 用 `information_schema.innodb_locks` / `innodb_lock_waits`（只显示存在等待时的锁），8.0 换成了 `performance_schema.data_locks` 与 `data_lock_waits`，**能看到所有已持有的锁**。

```sql
-- 当前所有行锁/表锁
SELECT ENGINE_TRANSACTION_ID AS trx, OBJECT_NAME, INDEX_NAME,
       LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA
FROM performance_schema.data_locks;
-- LOCK_MODE 示例：IX / X / X,REC_NOT_GAP / X,GAP / X,INSERT_INTENTION
-- LOCK_DATA 为锁住的索引键值，supremum pseudo-record 表示正无穷

-- 谁在等谁（sys 视图更直观，直接给出 KILL 语句）
SELECT waiting_pid, waiting_query, blocking_pid, blocking_query, sql_kill_blocking_connection
FROM sys.innodb_lock_waits;
```

## 乐观锁与悲观锁

| | 悲观锁 | 乐观锁 |
| --- | --- | --- |
| 实现 | `SELECT ... FOR UPDATE`，或直接带条件的 UPDATE | 版本号 / 时间戳：`UPDATE t SET ..., version = version + 1 WHERE id = ? AND version = ?` |
| 冲突处理 | 后到者阻塞等待 | 影响行数为 0 即冲突，由应用重试或报错 |
| 适用 | 冲突概率高、重试代价大（如扣款） | 冲突概率低、读多写少（如编辑资料） |
| 风险 | 锁等待、死锁、持锁期间不能有慢操作 | 高冲突下大量重试，浪费资源甚至活锁 |

库存扣减这类高并发场景，最实用的是**条件更新**：`UPDATE goods SET stock = stock - 1 WHERE id = ? AND stock >= 1`，本质是悲观锁（行锁）但持锁时间极短，再配合 Redis 预扣减削峰（见 [秒杀系统设计](#/design/seckill)）。

## 生产实践与踩坑

**1. 一个 UPDATE 锁住了整张表**

`UPDATE orders SET status = 2 WHERE order_no = ?`，`order_no` 没有索引（或隐式类型转换导致索引失效）。RR 下扫描的每一行都被加 Next-Key Lock。所有 UPDATE/DELETE 上线前都要 EXPLAIN，开启 `sql_safe_updates` 可以在开发环境拦截无索引的更新。

**2. 批量更新的死锁**

两个任务分别以不同顺序更新同一批行。修复：按主键排序后再更新；把大批量拆成小批量，缩短持锁时间。

**3. `Lock wait timeout exceeded` 后数据不一致**

`innodb_rollback_on_timeout=OFF` 时只回滚超时的那条语句。代码捕获异常后继续执行并提交，结果事务部分成功。正确做法：锁超时异常一律回滚整个事务（Spring 中抛出到事务边界即可）。

**4. 删除大量数据导致主从延迟和锁冲突**

`DELETE FROM log WHERE create_time < ?` 一次删几百万行：持有大量锁、生成巨大 binlog 事务、从库回放同样耗时。改为按主键分批删除（每批几千行，批次间 sleep），或使用分区表直接 `DROP PARTITION`。

**5. 唯一键并发插入死锁**

多个事务同时插入相同的唯一键：第一个成功插入（未提交），后面的检测到冲突后申请 S 锁等待；第一个回滚时，等待者们都拿到 S 锁，又都想升级为插入需要的 X/插入意向锁，互相等待形成死锁。业务上用“幂等键 + 先查缓存”减少重复插入，并对死锁异常做有限次重试。

## 相关阅读

- [事务隔离与 MVCC](#/mysql/transaction)：事务隔离与 MVCC
- [TiDB 架构：TiKV、PD、Raft 与分布式事务](#/db/tidb-arch)：TiDB 快照隔离与无间隙锁的差异
- [进程、线程与 CPU 调度](#/cs/os-process)：死锁条件与预防
- [案例：高并发写入与热点治理](#/design/case-highwrite)：热点行与持锁时间、分段库存

## 面试追问

> [!QUESTION] 给一张大表加字段，为什么整个业务都卡住了？
> 有长事务或慢查询持有该表的 MDL 读锁，ALTER 需要 MDL 写锁而排队；MDL 写锁请求优先，后续所有 SELECT/DML 的 MDL 读锁请求都排在它后面，连接迅速堆满。预防：DDL 前检查长事务、设置 `lock_wait_timeout`、低峰执行或用 gh-ost。

> [!QUESTION] RR 下 `SELECT * FROM t WHERE c = 10 FOR UPDATE`（c 普通索引）锁了哪些范围？
> 在索引 c 上加 Next-Key `(5,10]` 和间隙 `(10,15)`（向右扫到第一个不满足的值退化为间隙锁），并对主键 id=10 加记录锁。若 c 无索引，则锁住全表所有记录和间隙。

> [!QUESTION] 间隙锁之间冲突吗？为什么会导致死锁？
> 不冲突，多个事务可以同时持有同一间隙的间隙锁，它只阻止插入。于是两个事务都对同一不存在的值 `FOR UPDATE` 成功后，再各自插入时，插入意向锁都被对方的间隙锁阻塞，形成死锁。

> [!QUESTION] InnoDB 怎么检测死锁？有什么代价？
> 默认开启死锁检测，锁等待时构建等待图查找环，发现后回滚 undo 量较小的事务。热点行上大量事务等待时检测代价接近 O(n²)，会耗尽 CPU。可以通过应用层排队、拆分热点行，或关闭检测依赖锁超时来应对。

> [!QUESTION] 线上出现锁等待，你怎么排查？
> 8.0 查 `sys.innodb_lock_waits` 找到阻塞者和被阻塞者，`performance_schema.data_locks` 看具体锁住的索引和键值，`information_schema.innodb_trx` 看阻塞事务的开始时间和状态，结合 processlist 定位来源后决定是否 KILL；死锁则看 INNODB STATUS 的最近死锁信息和错误日志。

> [!QUESTION] 乐观锁和悲观锁怎么选？
> 冲突概率低、读多写少选乐观锁（版本号 CAS，失败重试）；冲突概率高或重试代价高选悲观锁，但要保证持锁期间没有慢操作、按固定顺序加锁。高并发扣减常用带条件的单条 UPDATE，兼顾简单和性能。
