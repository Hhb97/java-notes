---
level: 深入
tags: [PostgreSQL, 锁, 表级锁, 行级锁, 隔离级别, SSI, 可串行化, 写偏斜, 死锁, 咨询锁, 锁队列, PgBouncer, 连接池, 超时]
summary: PostgreSQL 并发控制深入：锁管理器与 8 种表级锁的冲突矩阵、行级锁的实现与四种模式、DDL 锁队列放大效应与安全变更、隔离级别在 PG 中的真实语义（读已提交/可重复读/可串行化 SSI 与写偏斜）、死锁检测与排查、咨询锁、各类超时参数、连接模型与 PgBouncer 池化（三种模式及与会话特性的冲突）、锁等待的诊断 SQL。
---

# PostgreSQL 锁、隔离级别与连接池：并发控制深入

> [!ABSTRACT] 核心要点
> - PG 的并发控制 = **MVCC（读不阻塞写、写不阻塞读）+ 锁（解决写-写冲突与 DDL 协调）**。**普通 `SELECT` 只拿最弱的表锁 `ACCESS SHARE`**，所以大多数读写互不阻塞；**真正的阻塞来自：行级写冲突、`SELECT FOR UPDATE`、DDL 的重锁、长事务拖住的锁队列**。
> - **8 种表级锁模式**构成冲突矩阵，最重的 **`ACCESS EXCLUSIVE`** 与所有锁冲突（`DROP/TRUNCATE/大部分 ALTER TABLE/VACUUM FULL/REINDEX`）。**最危险的现象是“锁队列放大”**：一个 DDL 在等一个长事务，**后面所有普通读写都排在 DDL 之后一起阻塞**，几秒内把整个服务打挂。**对策：DDL 前设置 `lock_timeout`、避开长事务、用 CONCURRENTLY 与小步骤变更**。
> - **行级锁不放在内存锁表里，而是写在元组头（`xmax`）上**，所以**锁一百万行不会耗尽锁表内存**，但会**产生写（弄脏页、WAL）**；多个事务持有同一行共享锁时用 **MultiXact**。行锁有 4 种强度：`FOR KEY SHARE / FOR SHARE / FOR NO KEY UPDATE / FOR UPDATE`。
> - **隔离级别在 PG 里的真实含义**：**Read Committed（默认）**每条语句一个快照；**Repeatable Read = 快照隔离（SI）**，整个事务一个快照，**没有幻读，但有写偏斜**；**Serializable 用 SSI（可串行化快照隔离）**，通过检测“读写依赖的危险结构”**在提交时中止**部分事务，因此**应用必须准备好重试 `40001`**。PG **没有“脏读”**（Read Uncommitted 等同 Read Committed）。
> - **死锁**由**死锁检测器**在等待 `deadlock_timeout`（默认 1 秒）后发现并**中止其中一个事务**；治理靠**统一加锁顺序、缩短事务、避免用户交互期间持锁**。
> - **连接模型是“一个连接 = 一个后端进程”**：连接数不能无限大（内存、上下文切换、快照构造成本），**数千连接直连 PG 是反模式**。用 **PgBouncer** 等连接池把成千上万应用连接复用到几十~几百个数据库连接；**事务级池化**效率最高，但**与会话级特性（SET、会话级咨询锁、LISTEN、临时表、预编译语句等）冲突**，必须了解。

## 表级锁

### 8 种锁模式

| 模式（强→弱） | 典型命令 | 说明 |
| --- | --- | --- |
| **ACCESS EXCLUSIVE** | `DROP TABLE`、`TRUNCATE`、`VACUUM FULL`、`REINDEX`（非并发）、`CLUSTER`、**大多数 `ALTER TABLE`** | 与**所有**锁冲突，包括 `SELECT`；**独占整张表** |
| **EXCLUSIVE** | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | 只允许 `ACCESS SHARE`（读） |
| **SHARE ROW EXCLUSIVE** | `CREATE TRIGGER`、部分 `ALTER TABLE`（如外键添加） | 自身也互斥 |
| **SHARE** | `CREATE INDEX`（非并发） | **阻塞所有写**，允许读；允许其他 SHARE |
| **SHARE UPDATE EXCLUSIVE** | `VACUUM`（非 FULL）、`ANALYZE`、`CREATE INDEX CONCURRENTLY`、`ALTER TABLE VALIDATE CONSTRAINT`、部分 `ALTER TABLE` | **不阻塞读写**，但互相冲突（同表同时只能一个 VACUUM/并发建索引） |
| **ROW EXCLUSIVE** | `INSERT/UPDATE/DELETE/MERGE` | 写表自动获取，与 SHARE 及以上冲突 |
| **ROW SHARE** | `SELECT ... FOR UPDATE/SHARE` | |
| **ACCESS SHARE** | 普通 `SELECT` | **最弱**，只与 ACCESS EXCLUSIVE 冲突 |

### 冲突矩阵（“✗ = 冲突”）

| 持有 \ 请求 | ACCESS SHARE | ROW SHARE | ROW EXCL | SHARE UPD EXCL | SHARE | SHARE ROW EXCL | EXCL | ACCESS EXCL |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **ACCESS SHARE** | | | | | | | | ✗ |
| **ROW SHARE** | | | | | | | ✗ | ✗ |
| **ROW EXCLUSIVE** | | | | | ✗ | ✗ | ✗ | ✗ |
| **SHARE UPDATE EXCL** | | | | ✗ | ✗ | ✗ | ✗ | ✗ |
| **SHARE** | | | ✗ | ✗ | | ✗ | ✗ | ✗ |
| **SHARE ROW EXCL** | | | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **EXCLUSIVE** | | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **ACCESS EXCLUSIVE** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

记忆要点：**`ROW EXCLUSIVE`（普通写）之间不冲突**（所以多个事务可同时写同一表，行级冲突另算）；**`SHARE`（建索引）会阻塞写**；**`ACCESS EXCLUSIVE` 阻塞一切**。

### 锁队列放大：DDL 的头号陷阱

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="锁队列放大：事务 A 是一个长事务，持有表的 ACCESS SHARE 锁（仅仅做了一次 SELECT 且未提交）；DDL 事务 B 请求 ACCESS EXCLUSIVE 锁被 A 阻塞，进入锁等待队列；之后所有新到的普通 SELECT 和 UPDATE 需要的弱锁虽然与 A 不冲突，但因为排在 B 之后，PG 为了避免 B 饥饿而让它们排队等待 B，结果整张表上的所有读写都被阻塞；解决办法是 DDL 设置 lock_timeout 失败重试，避免长事务，使用 CONCURRENTLY，分步变更">
<rect class="b3" x="20" y="30" width="170" height="70" rx="8"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">A：长事务</text>
<text class="ts" x="105" y="72" text-anchor="middle">SELECT 后未提交</text>
<text class="ts" x="105" y="90" text-anchor="middle">持有 ACCESS SHARE</text>
<rect class="b4" x="220" y="30" width="190" height="70" rx="8"/>
<text class="tb" x="315" y="50" text-anchor="middle" dominant-baseline="middle">B：ALTER TABLE</text>
<text class="ts" x="315" y="72" text-anchor="middle">请求 ACCESS EXCLUSIVE</text>
<text class="ts" x="315" y="90" text-anchor="middle">被 A 阻塞，排队等待</text>
<rect class="b5" x="440" y="30" width="300" height="70" rx="8"/>
<text class="tb" x="590" y="50" text-anchor="middle" dominant-baseline="middle">C、D、E…：新来的普通读写</text>
<text class="ts" x="590" y="72" text-anchor="middle">需要的锁与 A 不冲突，</text>
<text class="ts" x="590" y="90" text-anchor="middle">但排在 B 之后 → 全部排队等待</text>
<line class="l" x1="190" y1="65" x2="220" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="65" x2="440" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="720" height="210" rx="8"/>
<text class="th" x="32" y="140">结果与应对</text>
<text class="ts" x="380" y="166" text-anchor="middle">结果：这张表的所有读写在 B 拿到锁之前全部被堵住 → 连接池耗尽 → 全站故障（几秒到几十秒内发生）</text>
<text class="ts" x="380" y="190" text-anchor="middle">原因：锁请求按到达顺序排队（公平队列），后来的请求即使与持有者兼容，也不能“插队”到等待中的强锁请求之前</text>
<text class="ts" x="380" y="218" text-anchor="middle">安全的 DDL 做法：</text>
<text class="ts" x="380" y="240" text-anchor="middle">① 事先 SET lock_timeout = '2s'：拿不到锁就快速失败，稍后重试，宁可 DDL 失败，也不要拖垮线上</text>
<text class="ts" x="380" y="262" text-anchor="middle">② 先查 pg_stat_activity 确认没有长事务/idle in transaction 再执行；设置 idle_in_transaction_session_timeout</text>
<text class="ts" x="380" y="284" text-anchor="middle">③ 能用 CONCURRENTLY 就用（建/删索引、REINDEX、DETACH PARTITION）</text>
<text class="ts" x="380" y="306" text-anchor="middle">④ 把大变更拆成小步（加列可空→回填→加约束 NOT VALID→VALIDATE），每步持锁时间极短</text>
</svg>
<figcaption>图 1：锁队列放大效应与安全 DDL 做法</figcaption>
</figure>

### 常见 DDL 的锁与安全做法

| 操作 | 锁 | 风险与安全做法 |
| --- | --- | --- |
| `ALTER TABLE ADD COLUMN`（可空/带常量默认值） | ACCESS EXCLUSIVE（瞬间） | PG11+ 带**常量默认值**的加列**不重写表**，瞬时；仍需 `lock_timeout` |
| `ADD COLUMN ... DEFAULT volatile_func()` / `ALTER TYPE` | ACCESS EXCLUSIVE + **重写全表** | 大表分步回填；避免 |
| `ADD CONSTRAINT ... CHECK/FOREIGN KEY` | 需要扫描验证，持强锁 | 先 **`NOT VALID`**（只加约束不验证，短锁）再 **`VALIDATE CONSTRAINT`**（SHARE UPDATE EXCLUSIVE，不阻塞写） |
| `SET NOT NULL` | 扫描全表，ACCESS EXCLUSIVE | PG12+：先加 `CHECK (col IS NOT NULL) NOT VALID` 并 VALIDATE，再 `SET NOT NULL` 可跳过扫描 |
| `CREATE INDEX` | SHARE（**阻塞写**） | 用 **`CREATE INDEX CONCURRENTLY`**（不阻塞写，较慢，不能在事务块内，失败会留下 INVALID 索引需清理） |
| `DROP INDEX` | ACCESS EXCLUSIVE | `DROP INDEX CONCURRENTLY` |
| `TRUNCATE` | ACCESS EXCLUSIVE | 业务低峰、`lock_timeout` |
| `VACUUM FULL` / `CLUSTER` | ACCESS EXCLUSIVE + 重写 | 用 `pg_repack` 替代，见 [PG MVCC 内部机制深入](#/pg/vacuum-internals) |
| 外键引用端被改动 | 对被引用表加 SHARE ROW EXCLUSIVE 等 | 外键多的表 DDL 更需小心 |

## 行级锁

### 实现：锁在元组头

- 行锁**不占用共享内存锁表**，而是**把持有锁的事务 ID 写到元组的 `xmax`**，并在 `infomask` 标记“仅锁定（locked only）”；
- 好处：**可以锁任意多行不耗锁表内存**；
- 代价：**加行锁会写页（弄脏、产生 WAL）**，`SELECT FOR UPDATE` 一大批行代价不小；
- **多个事务共享同一行锁**（如多个外键引用同一父行的 `FOR KEY SHARE`）时，`xmax` 存的是 **MultiXact ID**，成员在 `pg_multixact` 里，**高并发下可能成为瓶颈**，且有自己的回卷问题。

### 四种行锁模式

| 模式 | 获取方式 | 与谁冲突 | 用途 |
| --- | --- | --- | --- |
| **FOR KEY SHARE** | 外键检查自动获取（引用方写入时对父行） | 仅与 `FOR UPDATE` 冲突 | 允许并发修改非键列 |
| **FOR SHARE** | `SELECT ... FOR SHARE` | 与 `FOR NO KEY UPDATE`、`FOR UPDATE` 冲突 | 读后防止别人修改 |
| **FOR NO KEY UPDATE** | **不改键列的 `UPDATE`**、`SELECT ... FOR NO KEY UPDATE` | 与 `FOR SHARE`、`FOR NO KEY UPDATE`、`FOR UPDATE` 冲突 | 更新非主键/唯一键列 |
| **FOR UPDATE** | `DELETE`、**修改键列的 `UPDATE`**、`SELECT ... FOR UPDATE` | 与所有行锁冲突 | 独占行 |

**`FOR NO KEY UPDATE`（4 种中的“温和写锁”）的价值**：普通更新非键列时只用它，**不会与外键的 `FOR KEY SHARE` 冲突**，所以“更新子表引用的父行的非键列”不会被外键检查堵住——这是 PG 9.3 后外键并发性大幅提升的原因。

### 行锁的等待与控制

| 选项 | 行为 | 使用场景 |
| --- | --- | --- |
| 默认 | 阻塞等待，直到持有者结束 | 一般事务 |
| **`NOWAIT`** | 拿不到锁**立即报错** | 不愿等待的交互场景 |
| **`SKIP LOCKED`** | **跳过被锁的行**，只处理未锁的行 | **用数据库做任务队列/并行消费**，多个 worker 各取不同行，见 [PG 的 MVCC、VACUUM 与锁](#/pg/mvcc) 的 SKIP LOCKED 示例 |
| `lock_timeout` | 等待超过时限报错 | **所有写事务/DDL 建议设置** |

> [!TIP] 更新热点行 vs 行锁
> “扣库存/累加计数”这类**同一行高并发更新**会在行锁上**串行排队**，吞吐上限≈1/（单次持锁时间）。治理（拆分、合并、异步）见 [案例：高并发写入与热点治理](#/design/case-highwrite)。**尽量缩短持锁事务**（先做完耗时计算再 UPDATE），不要在持锁期间调用外部服务。

## 隔离级别在 PG 中的真实语义

### 四个级别的映射

| SQL 隔离级别 | PG 实际实现 | 脏读 | 不可重复读 | 幻读 | 写偏斜等序列化异常 |
| --- | --- | --- | --- | --- | --- |
| Read Uncommitted | **等同 Read Committed** | 不会 | 可能 | 可能 | 可能 |
| **Read Committed（默认）** | **每条语句**取新快照 | 不会 | 可能 | 可能 | 可能 |
| **Repeatable Read** | **整个事务**一个快照（**快照隔离 SI**） | 不会 | 不会 | **不会（比标准更强）** | **可能（写偏斜）** |
| **Serializable** | **SSI**：在 SI 基础上检测危险结构并中止 | 不会 | 不会 | 不会 | **不会**（代价：可能 `40001` 失败） |

要点：

- **Read Committed 下的更新冲突处理**：`UPDATE` 遇到行被并发事务修改并提交后，会**重新评估 WHERE 条件**（在最新版本上），可能出现“**丢失更新**之外的异常语义”（如两次 `UPDATE ... WHERE balance >= 100` 的行为依赖最新版本）；需要原子性用 `UPDATE ... SET x = x - 1 WHERE ...` 或 `SELECT FOR UPDATE`；
- **Repeatable Read 下的写-写冲突**：若更新的行在本事务快照之后被别的事务修改并提交，**直接报错 `could not serialize access due to concurrent update`（40001）**，**应用必须重试整个事务**；
- **与 MySQL 差异**：InnoDB 的 Repeatable Read 用 Next-Key Lock 防幻读且允许“当前读”看到最新数据；PG 的 RR 是纯快照，**不会看到别人后提交的数据，也不阻塞**，而是冲突时失败，见 [事务隔离与 MVCC（MySQL）](#/mysql/transaction)。

### 写偏斜（Write Skew）与 SSI

**写偏斜**：两个事务**读取重叠的数据集，各自基于读到的结果写不同的行**，单看每个都合法，合起来违反约束。典型：**值班医生至少留一人**——A、B 同时检查“值班人数 ≥ 2”，各自把自己改成休息，结果 0 人值班。快照隔离下**不会冲突**（写的是不同的行）。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="写偏斜与 SSI：两个医生同时值班，事务 A 和 B 都读取到值班人数为 2，各自把自己的状态改为休息，快照隔离下两个更新写不同的行不冲突，都提交后值班人数为 0 违反业务约束；在 Serializable 级别下 SSI 追踪读写依赖，发现 A 读了 B 将要写的数据且 B 读了 A 将要写的数据形成危险结构，在提交时中止其中一个事务返回序列化失败，应用重试后看到只剩一人从而拒绝休息">
<rect class="b3" x="20" y="30" width="350" height="110" rx="10"/>
<text class="tb" x="195" y="50" text-anchor="middle" dominant-baseline="middle">事务 A（医生 Alice）</text>
<text class="ts" x="195" y="76" text-anchor="middle">1) SELECT count(*) 值班 → 2</text>
<text class="ts" x="195" y="98" text-anchor="middle">2) UPDATE doctors SET oncall=false</text>
<text class="ts" x="195" y="118" text-anchor="middle">　　WHERE name='Alice'</text>
<rect class="b5" x="390" y="30" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="50" text-anchor="middle" dominant-baseline="middle">事务 B（医生 Bob）</text>
<text class="ts" x="565" y="76" text-anchor="middle">1) SELECT count(*) 值班 → 2</text>
<text class="ts" x="565" y="98" text-anchor="middle">2) UPDATE doctors SET oncall=false</text>
<text class="ts" x="565" y="118" text-anchor="middle">　　WHERE name='Bob'</text>
<rect class="bg" x="20" y="156" width="720" height="174" rx="8"/>
<text class="th" x="32" y="176">不同隔离级别下的结果</text>
<text class="ts" x="380" y="202" text-anchor="middle">Read Committed / Repeatable Read：两个更新写不同的行，互不冲突，都成功 → 值班 0 人（违反约束）</text>
<text class="ts" x="380" y="224" text-anchor="middle">Serializable（SSI）：检测到 A 读的数据被 B 的写影响、B 读的被 A 的写影响（rw 依赖环）→ 中止其中一个，报 40001</text>
<text class="ts" x="380" y="246" text-anchor="middle">被中止者重试：重新读到值班人数为 1 → 业务逻辑拒绝休息 → 约束得以保持</text>
<text class="ts" x="380" y="274" text-anchor="middle">不用 SERIALIZABLE 的替代：对“被检查的集合”显式加锁（SELECT ... FOR UPDATE 锁住所有值班记录），或用约束/触发器/排他约束保证</text>
<text class="ts" x="380" y="296" text-anchor="middle">SSI 的代价：额外追踪谓词读（SIREAD 锁，不阻塞），有一定性能开销与假阳性中止；应用必须实现对 40001 的重试</text>
<text class="ta" x="380" y="318" text-anchor="middle">其他典型写偏斜：会议室预订冲突、唯一用户名检查、超卖（先查库存再扣）、余额透支检查</text>
</svg>
<figcaption>图 2：写偏斜与可串行化快照隔离（SSI）</figcaption>
</figure>

**SSI 的实现要点**：

- 事务读取时记录**谓词锁（SIREAD 锁）**——**只是“标记”，不阻塞任何人**；
- 检测到 **rw-依赖（读写冲突）**构成**“危险结构”（两个相邻的 rw 边，且 pivot 事务）**时，在某个事务提交/执行时**中止它**；
- **只读事务**有特殊优化（`SET TRANSACTION READ ONLY DEFERRABLE` 可等待到安全快照后无冲突运行）；
- **假阳性**：SSI 保守，可能中止本不会异常的事务，需要重试；
- **使用建议**：对**必须无异常的少数关键事务**使用 Serializable，**必须写重试循环**（捕获 SQLSTATE `40001`/`40P01`，有限次数+退避重试）；

```java
// Java：对 PG 序列化失败/死锁做有限重试
for (int attempt = 1; ; attempt++) {
    try {
        return txTemplate.execute(status -> doBusiness());   // 隔离级别 SERIALIZABLE
    } catch (CannotSerializeTransactionException | DeadlockLoserDataAccessException e) {
        if (attempt >= 3) throw e;
        Thread.sleep(backoffWithJitter(attempt));            // 退避+抖动，避免再次碰撞
    }
}
```

## 死锁

### 检测与处理

- 事务等待锁超过 **`deadlock_timeout`（默认 1s）** 后，PG 运行**死锁检测**（在等待图中找环）：找到环则**中止其中一个事务（通常是触发检测的那个）**，返回 `40P01 deadlock detected`，**日志里有双方的语句与锁信息**；
- **不要把 `deadlock_timeout` 调得很小**（检测有开销）；也不要很大（死锁持续时间久）。

### 常见成因与对策

| 成因 | 对策 |
| --- | --- |
| **加锁顺序不一致**（A 先锁 1 再 2，B 先锁 2 再 1） | **统一顺序**（如按主键升序更新批量行：`ORDER BY id FOR UPDATE`） |
| **批量更新顺序不确定** | `UPDATE ... WHERE id IN (...)` 的锁定顺序取决于扫描顺序；先 `SELECT ... ORDER BY id FOR UPDATE` 排序加锁 |
| **外键检查的锁交互** | 缩小事务；调整外键与更新顺序；评估外键必要性 |
| **事务过大/持锁过久** | 缩小事务，早提交 |
| **用户交互期间持锁** | 不在事务中等待用户输入 |
| **应用层重试放大** | 死锁后立刻重试加剧碰撞：退避+抖动 |

### 排查

- 打开 `log_lock_waits = on`（等待超过 `deadlock_timeout` 就记日志）；
- 死锁日志里的 `Process X waits for ShareLock on transaction Y; blocked by process Z` 与双方 SQL；
- 实时看锁等待（见“诊断 SQL”）。

## 咨询锁（Advisory Lock）

**由应用定义语义的锁**，PG 只负责互斥，**不与任何表/行关联**：

```sql
SELECT pg_advisory_lock(12345);                 -- 会话级：持有到显式释放或会话结束
SELECT pg_try_advisory_lock(12345);             -- 非阻塞尝试
SELECT pg_advisory_xact_lock(hashtext('order:1001'));   -- 事务级：事务结束自动释放（推荐）
```

| 要点 | 说明 |
| --- | --- |
| **用途** | 分布式互斥/选主（单库内）、避免重复执行定时任务、对“不存在的行”加锁（如串行化某业务键下的创建） |
| **会话级 vs 事务级** | **优先事务级**（`pg_advisory_xact_lock`），避免泄漏；会话级锁在**连接池复用**连接时会遗留，配合事务级 PgBouncer **不可用** |
| **键空间** | 一个 bigint 或两个 int；**不同模块避免撞键**（统一命名空间/哈希前缀） |
| **与锁表容量** | 占用共享内存锁表（`max_locks_per_transaction`），大量咨询锁要评估 |
| **局限** | 仅在**同一个 PG 实例**内有效；跨库/跨实例的分布式锁见 [分布式锁](#/redis/lock)、[分布式协调](#/mw/coordination) |

## 超时参数组合

| 参数 | 作用 | 建议 |
| --- | --- | --- |
| **`lock_timeout`** | 等待**任何锁**超过时限报错 | **DDL 与关键写事务必设**（如 2~5 秒） |
| **`statement_timeout`** | 单条语句最大执行时间 | OLTP 设置合理上限（如 30~60 秒），报表库单独放宽 |
| **`idle_in_transaction_session_timeout`** | 事务内空闲（`idle in transaction`）超时则断开 | **强烈建议设置**（如 1~10 分钟）：防止应用泄漏的未提交事务拖住清理与锁 |
| `idle_session_timeout`（PG14+） | 空闲会话超时断开 | 配合连接池 |
| `transaction_timeout`（PG17+） | 整个事务最长时长 | 新版本可用 |
| `deadlock_timeout` | 触发死锁检测前等待 | 默认 1s，一般不改 |
| `tcp_keepalives_*` / `client_connection_check_interval` | 检测客户端断开 | 防止僵尸连接与长查询继续占资源 |

可以**按角色/数据库/会话**设置：`ALTER ROLE app SET statement_timeout='30s'`；应用连接串里也可传 `options='-c statement_timeout=30000'`。

## 连接模型与连接池

### 为什么不能直连大量连接

- PG 是**“每个连接一个后端进程”**（fork 模型）：每连接占内存（几 MB 到更多，含 `work_mem` 使用）、有**上下文切换与进程调度**成本；
- **快照构造的代价随活动连接数增长**（PG13~14 优化了部分，仍有影响），`max_connections` 设成几千会让**整体吞吐下降**（缓存/锁竞争）；
- 经验：**活跃连接数 ≈ CPU 核数 × 2~4**时吞吐最佳，超出后只是排队；`max_connections` 常设几百，用连接池承接海量客户端，见 [架构、WAL 与存储结构（PG）](#/pg/architecture) 的连接数章节与 [HikariCP 配置](#/mysql/architecture)（池大小原则相同）。

### PgBouncer 的三种池化模式

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="PgBouncer 连接池：大量应用连接接入 PgBouncer；会话模式下一个客户端独占一个服务端连接直到断开，几乎无复用但功能完整；事务模式下服务端连接只在事务期间分配给客户端，事务结束归还，复用率最高但不支持会话级特性；语句模式每条语句后归还，不支持多语句事务；服务端连接数远小于客户端连接数">
<rect class="b3" x="20" y="30" width="170" height="130" rx="10"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">应用实例 × N</text>
<text class="ts" x="105" y="76" text-anchor="middle">每实例连接池 20~50</text>
<text class="ts" x="105" y="98" text-anchor="middle">总客户端连接：数千</text>
<text class="ts" x="105" y="124" text-anchor="middle">（微服务多副本时更多）</text>
<rect class="b5" x="240" y="30" width="190" height="130" rx="10"/>
<text class="tb" x="335" y="50" text-anchor="middle" dominant-baseline="middle">PgBouncer</text>
<text class="ts" x="335" y="76" text-anchor="middle">轻量单进程多路复用</text>
<text class="ts" x="335" y="98" text-anchor="middle">default_pool_size 等</text>
<text class="ts" x="335" y="124" text-anchor="middle">按 库×用户 建池</text>
<rect class="b1" x="480" y="30" width="260" height="130" rx="10"/>
<text class="tb" x="610" y="50" text-anchor="middle" dominant-baseline="middle">PostgreSQL</text>
<text class="ts" x="610" y="76" text-anchor="middle">服务端连接：几十~几百</text>
<text class="ts" x="610" y="98" text-anchor="middle">max_connections 受控</text>
<text class="ts" x="610" y="124" text-anchor="middle">保持高吞吐区间</text>
<line class="l" x1="190" y1="95" x2="240" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="95" x2="480" y2="95" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="176" width="720" height="146" rx="8"/>
<text class="th" x="32" y="196">池化模式（pool_mode）</text>
<text class="ts" x="380" y="222" text-anchor="middle">session：服务端连接在客户端连接期间独占；复用只发生在断开后；功能完整，节省的主要是“建连成本”</text>
<text class="ts" x="380" y="244" text-anchor="middle">transaction（最常用）：事务开始时分配服务端连接，事务结束立即归还；复用率最高，吞吐最大</text>
<text class="ts" x="380" y="266" text-anchor="middle">statement：每条语句后归还，不支持多语句事务；极少使用</text>
<text class="ts" x="380" y="292" text-anchor="middle">事务模式下，同一客户端的不同事务可能落在不同的服务端连接上 → 依赖“同一会话状态”的特性会失效</text>
<text class="ta" x="380" y="314" text-anchor="middle">PgBouncer 单线程：高并发多实例并联（SO_REUSEPORT）或换 Odyssey/pgcat/云代理</text>
</svg>
<figcaption>图 3：PgBouncer 的位置与三种池化模式</figcaption>
</figure>

### 事务模式下失效的会话特性

| 特性 | 问题 | 对策 |
| --- | --- | --- |
| **`SET`（会话级设置）、`SET search_path`** | 设置落在某个服务端连接，下个事务换连接就失效 | 用 **`SET LOCAL`**（事务内）、连接参数/角色级 `ALTER ROLE ... SET`、`PgBouncer` 的 `track_extra_parameters`/`ignore_startup_parameters` 配置 |
| **会话级咨询锁** | 锁属于服务端连接，复用后泄漏或丢失 | 改用**事务级** `pg_advisory_xact_lock` |
| **`LISTEN/NOTIFY`** | 通知绑定在会话 | 用专用的非池化连接监听 |
| **临时表、`WITH HOLD` 游标** | 跨事务不可见 | 避免，或在单事务内使用 |
| **服务端预编译语句（Prepared Statements）** | 预编译绑定服务端连接；事务模式下换连接后“prepared statement does not exist/已存在”错误 | PgBouncer **1.21+** 支持协议级预编译（`max_prepared_statements`）；旧版本用 JDBC `prepareThreshold=0` 禁用服务端预编译（失去计划复用，规划开销上升，且与 [PG 优化器原理](#/pg/optimizer) 的 generic plan 问题相关） |
| **`DISCARD ALL` / 会话状态清理** | 需配置 `server_reset_query` | 按版本与模式配置 |
| **事务内多语句依赖同一连接** | 事务模式保证**同一事务**在同一连接，没问题；跨事务的会话状态才有问题 | — |

### 应用侧配置

- **应用连接池（HikariCP）+ PgBouncer**：应用池大小按“并发需求”设置，PgBouncer 汇聚；**不要让各层池大小相乘成为失控的数字**；
- **Spring/JPA**：避免长事务（尤其 `@Transactional` 覆盖远程调用），避免“开启事务后等待外部”造成连接占用；
- **读写分离**：读备库+写主库的路由、复制延迟处理，见 [复制与一致性](#/distributed/replication)；
- **故障切换**：连接串支持多主机与 `target_session_attrs=read-write`（JDBC `targetServerType=primary`），自动找到当前主库，见 [PG 复制、高可用与实战](#/pg/ops)；
- **连接泄漏**：`idle in transaction` 堆积是最常见的线上隐患（见超时参数）。

## 诊断 SQL：谁在阻塞谁

```sql
-- 1) 当前被阻塞的会话及其阻塞者（PG 9.6+ 的 pg_blocking_pids）
SELECT a.pid AS blocked_pid, a.usename, a.state, now() - a.query_start AS wait_time,
       left(a.query, 80) AS blocked_query,
       pg_blocking_pids(a.pid) AS blocking_pids
FROM pg_stat_activity a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0;

-- 2) 阻塞者在做什么（通常是 idle in transaction 的长事务）
SELECT pid, usename, state, xact_start, now() - xact_start AS xact_age,
       wait_event_type, wait_event, left(query, 100) AS last_query
FROM pg_stat_activity
WHERE pid = ANY (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity);

-- 3) 锁详情（按表）
SELECT l.locktype, l.mode, l.granted, c.relname, l.pid
FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
WHERE NOT l.granted OR c.relname = 'orders' ORDER BY l.granted, l.pid;

-- 4) 当前等待事件分布（定位 Lock / LWLock / IO 等）
SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity
WHERE state = 'active' GROUP BY 1,2 ORDER BY 3 DESC;
```

处置原则：**先找到并处理根阻塞者**（通常是 `idle in transaction`：与应用确认后 `pg_terminate_backend(pid)`），而不是逐个杀被阻塞者；终止前确认影响；随后补上 `idle_in_transaction_session_timeout` 防复发。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 一个 `ALTER TABLE` 后全站读写卡住 | 锁队列放大：DDL 排在长事务后面 | `lock_timeout`、避开长事务、分步 DDL |
| `idle in transaction` 持续增长，表膨胀、锁堆积 | 应用泄漏未提交事务 | `idle_in_transaction_session_timeout`，修复应用事务边界 |
| `could not serialize access due to concurrent update (40001)` | RR/Serializable 下写冲突 | 应用重试；缩小事务；评估隔离级别 |
| `deadlock detected (40P01)` | 加锁顺序不一致 | 统一顺序、缩短事务、重试 |
| 更新同一行（计数/库存）吞吐上不去 | 行锁串行化 | 拆分/异步/缓存聚合 |
| 连接数打满 `too many clients already` | 直连过多/连接泄漏/池配置过大 | PgBouncer、控制应用池、排查泄漏 |
| PgBouncer 事务模式下 `prepared statement ... does not exist` | 预编译语句与连接复用冲突 | 升级支持协议级预编译或禁用服务端预编译 |
| 会话级咨询锁“莫名其妙”不释放/失效 | 连接池复用 | 改事务级咨询锁 |
| Serializable 下大量失败 | 热点数据、冲突多、事务大 | 缩小事务；对关键事务才用；重试策略 |
| `CREATE INDEX CONCURRENTLY` 失败留下 INVALID 索引 | 并发建索引中途失败 | `DROP INDEX CONCURRENTLY` 后重建 |

## 检查清单

- [ ] DDL 是否统一带 `lock_timeout`，是否有变更前检查长事务的流程与重试？
- [ ] 是否设置 `idle_in_transaction_session_timeout`、`statement_timeout`，并监控 `idle in transaction`？
- [ ] 建索引/删索引/重建索引是否使用 `CONCURRENTLY`，加约束是否用 `NOT VALID` + `VALIDATE`？
- [ ] 批量更新是否按固定顺序加锁？热点行是否治理？
- [ ] 是否明确了每个业务事务的隔离级别，Serializable/Repeatable Read 下是否实现了 40001/40P01 重试？
- [ ] 是否有写偏斜风险的业务（先查后写的约束检查），是否用锁/约束/Serializable 保护？
- [ ] 是否使用连接池（应用侧 + PgBouncer），事务模式下是否评估了会话特性与预编译语句兼容性？
- [ ] 是否有“谁阻塞谁”的诊断脚本与应急预案？

## 相关阅读

- [MVCC、VACUUM 与锁（PG）](#/pg/mvcc)：锁与 MVCC 的基础
- [PG MVCC 内部机制深入](#/pg/vacuum-internals)：长事务如何阻止清理
- [PG 优化器原理](#/pg/optimizer)：Prepared Statement 与计划缓存
- [PG 复制、高可用与实战](#/pg/ops)：多主机连接串与故障切换
- [锁机制与死锁分析（MySQL）](#/mysql/lock)：InnoDB 锁的对照
- [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release)：expand/contract 的数据库变更

## 面试追问

> [!QUESTION] PostgreSQL 为什么 `ALTER TABLE` 会把整个服务拖垮？怎么避免？
> 它请求 ACCESS EXCLUSIVE 锁，若前面有长事务持有弱锁，DDL 就排队等待，而锁请求是按到达顺序排队的，后来的普通读写即使与持有者兼容也要排在 DDL 之后，结果整张表所有读写都被阻塞。避免办法是 DDL 前设置 lock_timeout 失败重试，确认没有长事务，使用 CONCURRENTLY 与 NOT VALID 加 VALIDATE 的分步变更，让每步持锁极短。

> [!QUESTION] PG 的行锁是怎么实现的？和表锁有什么区别？
> 表锁放在共享内存锁表里，有 8 种模式；行锁把持有事务 ID 写在元组头的 xmax 并标记仅锁定，所以锁多少行都不耗锁表内存，但会产生写和 WAL；多个事务共享同一行锁时用 MultiXact。行锁有 FOR KEY SHARE、FOR SHARE、FOR NO KEY UPDATE、FOR UPDATE 四种，普通更新非键列只用 FOR NO KEY UPDATE，不会和外键检查冲突。

> [!QUESTION] PG 的可重复读和 MySQL 的可重复读有什么不同？
> PG 的可重复读是整个事务一个快照的快照隔离，没有幻读但有写偏斜，遇到快照之后被别人提交修改的行写冲突时直接报 40001 要求重试，不阻塞也看不到别人后提交的数据；InnoDB 用间隙锁和当前读防止幻读，更新会读最新版本并阻塞等待。

> [!QUESTION] 什么是写偏斜？PG 怎么解决？
> 两个事务读取重叠数据后各自写不同的行，单看合法合起来违反约束，如两个医生同时休息导致没人值班。快照隔离下不冲突。PG 的 Serializable 用 SSI 追踪读写依赖，发现危险结构就在提交时中止一个事务返回 40001，应用重试；不用 Serializable 时可对被检查的集合 SELECT FOR UPDATE 加锁，或用约束保证。

> [!QUESTION] 为什么 PG 不适合直接连接几千个客户端？怎么办？
> 每个连接是一个后端进程，占内存和调度开销，快照构造成本也随活动连接数增长，连接过多吞吐反而下降。用 PgBouncer 等连接池把大量客户端连接复用到几十到几百个服务端连接，事务模式复用率最高，但会话级特性如 SET、会话级咨询锁、LISTEN、临时表和旧版预编译语句会失效，需要用 SET LOCAL、事务级咨询锁、专用连接或支持协议级预编译的版本。

> [!QUESTION] 线上发现大量请求被阻塞，怎么定位？
> 用 pg_blocking_pids 找出被阻塞会话及阻塞者，通常根阻塞者是 idle in transaction 的长事务，看它的事务开始时间和最后语句，确认后终止它；同时看 wait_event 分布判断是 Lock、LWLock 还是 IO。治理上设置 idle_in_transaction_session_timeout、lock_timeout，开启 log_lock_waits，修复应用事务边界。
