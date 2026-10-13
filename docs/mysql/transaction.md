---
level: 深入
tags: [事务, ACID, 隔离级别, MVCC, ReadView, 幻读]
summary: 讲透 InnoDB 如何用 undo 版本链 + ReadView 实现 MVCC，RC 与 RR 的本质差异，RR 到底有没有解决幻读，以及长事务为什么是线上头号隐患。
---

# 事务隔离与 MVCC

> [!ABSTRACT] 核心要点
> - ACID 的实现：**A 靠 undo log**，**D 靠 redo log（+ doublewrite）**，**I 靠锁 + MVCC**，C 是前三者加上约束共同追求的目标。
> - 每行有隐藏列 `DB_TRX_ID`（最后修改它的事务）与 `DB_ROLL_PTR`（指向 undo 中的上一版本），串起来就是**版本链**。
> - ReadView 记录创建时刻的活跃事务集合 `m_ids`、`min_trx_id`、`max_trx_id`、`creator_trx_id`，沿版本链找到第一个“对我可见”的版本。
> - **RC 每条语句生成新 ReadView，RR 在事务第一次快照读时生成并复用到事务结束**——这是两者行为差异的全部根源。
> - RR 下快照读靠 MVCC、当前读靠 Next-Key Lock 避免幻读；但**快照读与当前读混用**仍然能“看到幻影”。

## ACID 分别由什么保证

| 特性 | 含义 | InnoDB 的实现 |
| --- | --- | --- |
| 原子性 A | 要么全做，要么全不做 | undo log：回滚时按 undo 逆向恢复 |
| 一致性 C | 事务前后数据满足约束和业务规则 | 由 A、I、D 共同保证，再加上主键/唯一/外键约束和应用逻辑 |
| 隔离性 I | 并发事务互不干扰 | 写-写：行锁；读-写：MVCC（快照读）或锁（当前读） |
| 持久性 D | 提交后不丢 | redo log（WAL）+ doublewrite；复制场景下还依赖 binlog |

## 并发异象与隔离级别

| 异象 | 描述 |
| --- | --- |
| 脏写 | 一个事务覆盖了另一个未提交事务的写入；任何隔离级别都通过行锁禁止 |
| 脏读 | 读到其他事务未提交的数据 |
| 不可重复读 | 同一事务内两次读取同一行，值不同（被其他已提交事务修改） |
| 幻读 | 同一事务内两次按相同条件查询，第二次多出了“新插入”的行 |
| 丢失更新 | 两个事务读同一值后各自写回，后者覆盖前者（读-改-写模式） |

| 隔离级别 | 脏读 | 不可重复读 | 幻读（InnoDB） | 实现方式 |
| --- | --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 直接读最新版本 |
| READ COMMITTED | 否 | 可能 | 可能 | 每条语句新建 ReadView；基本只有行锁（无间隙锁，外键/唯一检查除外） |
| REPEATABLE READ（默认） | 否 | 否 | 快照读否；当前读靠 Next-Key Lock 避免 | 事务内复用 ReadView；当前读加间隙锁 |
| SERIALIZABLE | 否 | 否 | 否 | 关闭自动提交时，普通 SELECT 隐式变为 `SELECT ... FOR SHARE` |

```sql
SELECT @@transaction_isolation;                        -- 8.0；5.7 还可用 @@tx_isolation（8.0 已移除）
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

> [!NOTE] 为什么不少互联网公司把隔离级别改成 RC
> RC 下几乎没有间隙锁，并发插入冲突和死锁明显减少；每条语句看到最新已提交数据，更符合多数业务直觉。代价是必须使用 `binlog_format=ROW`（RC + STATEMENT 格式会导致主从不一致，MySQL 会直接拒绝），且应用要接受不可重复读。

## MVCC 的数据基础：隐藏列与版本链

聚簇索引的每条记录都有两个隐藏列：

- `DB_TRX_ID`（6 字节）：最近一次插入或修改该行的事务 ID。
- `DB_ROLL_PTR`（7 字节）：回滚指针，指向 undo log 中该行的上一个版本。

每次 UPDATE，InnoDB 先把旧值写进 undo log，再在原记录上原地修改并把 `DB_ROLL_PTR` 指向这条 undo，于是形成一条从新到旧的**版本链**。

<figure class="fig">
<svg viewBox="0 0 740 270" class="dg" role="img" aria-label="一行记录通过 DB_ROLL_PTR 串联 undo log 中的历史版本形成版本链">
<text class="ts" x="20" y="38">聚簇索引中的记录（最新版本）</text>
<rect class="b2" x="20" y="50" width="60" height="40"/>
<text class="tm" x="50" y="70" text-anchor="middle" dominant-baseline="middle">id=1</text>
<rect class="b2" x="80" y="50" width="90" height="40"/>
<text class="tm" x="125" y="70" text-anchor="middle" dominant-baseline="middle">name=C</text>
<rect class="b2" x="170" y="50" width="110" height="40"/>
<text class="tm" x="225" y="70" text-anchor="middle" dominant-baseline="middle">trx_id=300</text>
<rect class="b2" x="280" y="50" width="100" height="40"/>
<text class="tm" x="330" y="70" text-anchor="middle" dominant-baseline="middle">roll_ptr</text>
<line class="la" x1="330" y1="90" x2="330" y2="110"/>
<line class="la" x1="330" y1="110" x2="50" y2="110"/>
<line class="la" x1="50" y1="110" x2="50" y2="128" marker-end="url(#arr-a)"/>
<text class="ts" x="400" y="118" text-anchor="end">undo log</text>
<rect class="b3" x="20" y="130" width="60" height="40"/>
<text class="tm" x="50" y="150" text-anchor="middle" dominant-baseline="middle">id=1</text>
<rect class="b3" x="80" y="130" width="90" height="40"/>
<text class="tm" x="125" y="150" text-anchor="middle" dominant-baseline="middle">name=B</text>
<rect class="b3" x="170" y="130" width="110" height="40"/>
<text class="tm" x="225" y="150" text-anchor="middle" dominant-baseline="middle">trx_id=200</text>
<rect class="b3" x="280" y="130" width="100" height="40"/>
<text class="tm" x="330" y="150" text-anchor="middle" dominant-baseline="middle">roll_ptr</text>
<line class="la" x1="330" y1="170" x2="330" y2="190"/>
<line class="la" x1="330" y1="190" x2="50" y2="190"/>
<line class="la" x1="50" y1="190" x2="50" y2="208" marker-end="url(#arr-a)"/>
<rect class="b3" x="20" y="210" width="60" height="40"/>
<text class="tm" x="50" y="230" text-anchor="middle" dominant-baseline="middle">id=1</text>
<rect class="b3" x="80" y="210" width="90" height="40"/>
<text class="tm" x="125" y="230" text-anchor="middle" dominant-baseline="middle">name=A</text>
<rect class="b3" x="170" y="210" width="110" height="40"/>
<text class="tm" x="225" y="230" text-anchor="middle" dominant-baseline="middle">trx_id=100</text>
<rect class="b3" x="280" y="210" width="100" height="40"/>
<text class="tm" x="330" y="230" text-anchor="middle" dominant-baseline="middle">roll_ptr</text>
<text class="tb" x="430" y="62">trx 300：UPDATE name='C'</text>
<text class="ts" x="430" y="82">未提交，持有该行 X 锁</text>
<text class="tb" x="430" y="142">trx 200：UPDATE name='B'</text>
<text class="ts" x="430" y="162">已提交；旧值保存在 update undo 中</text>
<text class="tb" x="430" y="222">trx 100：INSERT (1, 'A')</text>
<text class="ts" x="430" y="242">已提交；没有 ReadView 需要时由 purge 回收</text>
</svg>
<figcaption>图 1：版本链。读事务从最新版本开始，沿 roll_ptr 向旧版本走，直到找到对自己可见的版本</figcaption>
</figure>

几个细节：

- undo 分为 **insert undo**（事务提交后即可删除，因为插入前的“版本”不存在，没人需要）和 **update undo**（含删除，需保留到没有任何 ReadView 需要它）。
- DELETE 并不立刻删除记录，只是打上 `delete_mask` 并生成 undo；真正删除由后台 **purge** 线程完成。
- 版本链上的旧版本**不是物理存储的完整行**，而是从 undo 记录逆向构造出来的，链越长，构造越慢。

## ReadView 与可见性判断

ReadView（源码 `ReadView` 类）创建时记录：

| 字段 | 源码名 | 含义 |
| --- | --- | --- |
| `m_ids` | `m_ids` | 创建时刻所有**活跃（未提交）读写事务**的 ID 列表 |
| `min_trx_id` | `m_up_limit_id` | `m_ids` 中最小的 ID |
| `max_trx_id` | `m_low_limit_id` | 创建时刻系统**将要分配的下一个**事务 ID（不是 m_ids 中最大值） |
| `creator_trx_id` | `m_creator_trx_id` | 创建该 ReadView 的事务自身 ID（只读事务为 0） |

> [!NOTE] 源码命名是反的
> `m_up_limit_id` 是下界、`m_low_limit_id` 是上界，按“高水位/低水位”的视角命名。阅读源码时别被绕进去。另外，**只读事务不分配事务 ID**（5.6+ 优化），直到第一次写或加锁读时才分配，所以只读事务不会出现在别人的 `m_ids` 里。

<figure class="fig">
<svg viewBox="0 0 740 395" class="dg" role="img" aria-label="ReadView 判断某个版本是否可见的流程">
<rect class="b1" x="250" y="10" width="240" height="40" rx="8"/>
<text class="tb" x="370" y="30" text-anchor="middle" dominant-baseline="middle">取当前版本的 trx_id</text>
<line class="l" x1="370" y1="50" x2="370" y2="74" marker-end="url(#arr)"/>
<rect class="b3" x="200" y="76" width="340" height="40" rx="8"/>
<text class="tm" x="370" y="96" text-anchor="middle" dominant-baseline="middle">trx_id == creator_trx_id ?</text>
<line class="l" x1="540" y1="96" x2="598" y2="96" marker-end="url(#arr)"/>
<text class="ts" x="569" y="88" text-anchor="middle">是</text>
<rect class="b2" x="600" y="76" width="110" height="40" rx="8"/>
<text class="tb" x="655" y="96" text-anchor="middle" dominant-baseline="middle">可见</text>
<line class="l" x1="370" y1="116" x2="370" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="380" y="132">否</text>
<rect class="b3" x="200" y="142" width="340" height="40" rx="8"/>
<text class="tm" x="370" y="162" text-anchor="middle" dominant-baseline="middle">trx_id &lt; min_trx_id ?</text>
<line class="l" x1="540" y1="162" x2="598" y2="162" marker-end="url(#arr)"/>
<text class="ts" x="569" y="154" text-anchor="middle">是</text>
<rect class="b2" x="600" y="142" width="110" height="40" rx="8"/>
<text class="tb" x="655" y="162" text-anchor="middle" dominant-baseline="middle">可见</text>
<line class="l" x1="370" y1="182" x2="370" y2="206" marker-end="url(#arr)"/>
<text class="ts" x="380" y="198">否</text>
<rect class="b3" x="200" y="208" width="340" height="40" rx="8"/>
<text class="tm" x="370" y="228" text-anchor="middle" dominant-baseline="middle">trx_id &gt;= max_trx_id ?</text>
<line class="l" x1="540" y1="228" x2="598" y2="228" marker-end="url(#arr)"/>
<text class="ts" x="569" y="220" text-anchor="middle">是</text>
<rect class="b4" x="600" y="208" width="110" height="40" rx="8"/>
<text class="tb" x="655" y="228" text-anchor="middle" dominant-baseline="middle">不可见</text>
<line class="l" x1="370" y1="248" x2="370" y2="272" marker-end="url(#arr)"/>
<text class="ts" x="380" y="264">否</text>
<rect class="b3" x="200" y="274" width="340" height="40" rx="8"/>
<text class="tm" x="370" y="294" text-anchor="middle" dominant-baseline="middle">trx_id 在 m_ids 中 ?</text>
<line class="l" x1="540" y1="294" x2="598" y2="294" marker-end="url(#arr)"/>
<text class="ts" x="569" y="286" text-anchor="middle">是</text>
<rect class="b4" x="600" y="274" width="110" height="40" rx="8"/>
<text class="tb" x="655" y="294" text-anchor="middle" dominant-baseline="middle">不可见</text>
<line class="l" x1="370" y1="314" x2="370" y2="338" marker-end="url(#arr)"/>
<text class="ts" x="380" y="330">否</text>
<rect class="b2" x="230" y="340" width="280" height="40" rx="8"/>
<text class="tb" x="370" y="360" text-anchor="middle" dominant-baseline="middle">可见（创建 ReadView 前已提交）</text>
<line class="la" x1="710" y1="228" x2="725" y2="228"/>
<line class="la" x1="710" y1="294" x2="725" y2="294"/>
<line class="la" x1="725" y1="294" x2="725" y2="30"/>
<line class="la" x1="725" y1="30" x2="492" y2="30" marker-end="url(#arr-a)"/>
<text class="ts" x="715" y="20" text-anchor="end">沿 roll_ptr 取上一版本再判断</text>
</svg>
<figcaption>图 2：可见性判断。不可见就沿版本链回退；链走到头仍不可见，说明这行对当前事务“不存在”</figcaption>
</figure>

用一句话记：**我自己改的可见；ReadView 创建前已提交的可见；创建时还活跃或之后才开始的不可见**。

对于二级索引，记录上没有 `DB_TRX_ID`。InnoDB 先看二级索引页头的 `PAGE_MAX_TRX_ID`：如果小于 `min_trx_id`，整页都可见；否则必须回表到聚簇索引用版本链判断。这也是“覆盖索引在有大量并发更新时仍然可能回表”的原因。

## RC 与 RR：ReadView 生成时机

| | READ COMMITTED | REPEATABLE READ |
| --- | --- | --- |
| ReadView 生成 | **每条**快照读语句开始时 | 事务中**第一次**快照读时，之后复用 |
| 表现 | 能看到其他事务在本语句之前提交的修改 | 整个事务看到同一个快照 |

示例（id=1 初始 name='A'）：

| 时刻 | 事务 T1 | 事务 T2 |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SELECT name FROM t WHERE id=1;` → A | |
| 3 | | `UPDATE t SET name='B' WHERE id=1; COMMIT;` |
| 4 | `SELECT name FROM t WHERE id=1;` → **RC：B，RR：A** | |

> [!WARNING] RR 的快照不是在 BEGIN 时建立的
> `BEGIN` / `START TRANSACTION` 并不创建 ReadView，第一条 SELECT 才创建。如果 T1 在时刻 2 之前什么都没查，时刻 4 第一次查询在 RR 下也会看到 B。需要在开启事务时立即建立快照用 `START TRANSACTION WITH CONSISTENT SNAPSHOT`（mysqldump `--single-transaction` 就是这样做的）。

## 快照读与当前读

| 类型 | 语句 | 读到什么 | 是否加锁 |
| --- | --- | --- | --- |
| 快照读 | 普通 `SELECT` | ReadView 可见的版本 | 不加锁（SERIALIZABLE 除外） |
| 当前读 | `SELECT ... FOR UPDATE`、`SELECT ... FOR SHARE`（5.7 为 `LOCK IN SHARE MODE`）、`UPDATE`、`DELETE`、`INSERT` | **最新已提交版本** | 加行锁，RR 下还加间隙锁 |

为什么更新必须是当前读？如果 UPDATE 基于旧快照计算 `stock = stock - 1`，就会覆盖别人已提交的扣减，产生丢失更新。所以 RR 下即使快照里 stock=10，`UPDATE ... SET stock = stock - 1` 也是基于最新值计算的。

## RR 到底有没有解决幻读

- **纯快照读**：没有幻读，ReadView 固定，别人新插入的行 trx_id 不在可见范围内。
- **纯当前读**：没有幻读，`SELECT ... FOR UPDATE` 对扫描范围加 Next-Key Lock，别人插不进来（见 [锁机制与死锁分析](#/mysql/lock)）。
- **快照读与当前读混用**：会出现幻读。

反例（RR，表 t 中不存在 id=5）：

| 时刻 | T1 | T2 |
| --- | --- | --- |
| 1 | `BEGIN;` `SELECT * FROM t WHERE id=5;` → 空 | |
| 2 | | `INSERT INTO t(id, name) VALUES (5, 'x'); COMMIT;` |
| 3 | `SELECT * FROM t WHERE id=5;` → 空（快照读，仍不可见） | |
| 4 | `UPDATE t SET name='y' WHERE id=5;` → **影响 1 行**（当前读看到了 T2 的插入） | |
| 5 | `SELECT * FROM t WHERE id=5;` → **出现 (5,'y')** | |

时刻 4 的 UPDATE 把这行的 `DB_TRX_ID` 改成了 T1 自己，时刻 5 按“自己改的可见”规则就看到了这一行——同一事务内两次相同的快照读，结果从无到有。

另一个常见变体：T1 先快照读 `COUNT(*)` 得到 10，T2 插入并提交，T1 再 `SELECT COUNT(*) ... FOR UPDATE` 得到 11。

> [!TIP] 结论怎么答
> InnoDB 的 RR 在很大程度上避免了幻读：快照读靠 MVCC，当前读靠 Next-Key Lock；但它不等于 SERIALIZABLE，快照读和当前读混用时仍可能出现幻读。需要“读后基于读结果写”的场景，第一次读就应该用 `FOR UPDATE`。

## 长事务的危害与排查

长事务指持续时间长、迟迟不提交的事务（包括执行完 SQL 但忘记 commit 的连接）。危害：

1. **undo 无法 purge**：只要还有一个老的 ReadView，比它新的所有 update undo 都不能删，undo 表空间膨胀，`History list length` 不断增长；版本链变长，所有快照读都变慢。
2. **持有行锁**：其他事务长时间锁等待，甚至超时（`innodb_lock_wait_timeout` 默认 50 秒）。
3. **持有 MDL 读锁**：此时执行 DDL 会被阻塞，并进一步阻塞后续所有查询（见 [锁机制与死锁分析](#/mysql/lock)）。
4. **占用连接**：连接池被占满。
5. **主从延迟**：大事务在从库回放也需要同样长的时间。

排查：

```sql
-- 运行超过 60 秒的事务
SELECT trx_id, trx_state, trx_started, trx_mysql_thread_id, trx_rows_locked, trx_rows_modified, trx_query
FROM information_schema.innodb_trx
WHERE trx_started < NOW() - INTERVAL 60 SECOND
ORDER BY trx_started;

-- 找到对应连接的来源（主机、用户），trx_query 为 NULL 说明是“执行完不提交”的空闲事务
SELECT * FROM information_schema.processlist WHERE id = <trx_mysql_thread_id>;

-- 8.0：查看该线程最近执行过的 SQL，定位是哪段代码开启的事务
SELECT t.PROCESSLIST_ID, h.SQL_TEXT
FROM performance_schema.threads t
JOIN performance_schema.events_statements_history h ON h.THREAD_ID = t.THREAD_ID
WHERE t.PROCESSLIST_ID = <trx_mysql_thread_id>;
```

`SHOW ENGINE INNODB STATUS` 的 `TRANSACTIONS` 段中 `History list length` 持续上升（几十万甚至百万级）是 purge 跟不上或存在长事务的明确信号。

治理手段：

- 应用侧：`@Transactional` 方法内不要做 RPC、MQ 发送、文件 IO 等慢操作（见 [声明式事务原理](#/spring/tx)）；设置事务超时。
- 连接侧：`autocommit` 保持开启；连接池归还连接时确保回滚未提交事务（HikariCP 默认在归还时对未提交事务执行 rollback）。
- 数据库侧：监控 `innodb_trx` 中超过阈值的事务并告警；8.0 可配合 `innodb_undo_log_truncate` 回收 undo 空间。

## 生产实践与踩坑

**1. 先查后改导致超卖**

```sql
-- 错误：快照读判断后再扣减，并发下两个事务都看到 stock=1
SELECT stock FROM goods WHERE id = 1;          -- 1
UPDATE goods SET stock = stock - 1 WHERE id = 1;

-- 正确：条件更新，用影响行数判断是否成功
UPDATE goods SET stock = stock - 1 WHERE id = 1 AND stock > 0;
-- 或者 SELECT ... FOR UPDATE 先锁住再判断
```

**2. mysqldump 备份导致业务变慢**

`--single-transaction` 在整个备份期间持有一个一致性快照，等于一个超长事务：undo 无法 purge，版本链越来越长。大库备份应放在从库执行，或使用 XtraBackup 等物理备份。

**3. 同一事务里“读不到刚刚别的服务写入的数据”**

RR 下事务第一次读就固定了快照。如果业务在一个长事务中轮询等待其他服务写入的数据，永远读不到。要么缩短事务，要么改用当前读，要么把轮询放到事务外。

**4. 只读查询也开了事务**

`@Transactional(readOnly = true)` 包着大量查询和远程调用，同样会持有 ReadView 阻止 purge。只读事务也应尽量短。

## 相关阅读

- [MySQL 在线 DDL 与大表治理](#/mysql/online-ddl)：长事务与 MDL、undo 膨胀的关系

## 面试追问

> [!QUESTION] MVCC 是怎么实现的？
> 依赖三样东西：行的隐藏列 `DB_TRX_ID`/`DB_ROLL_PTR`、undo log 构成的版本链、ReadView。快照读时从最新版本开始，用 ReadView 判断 trx_id 是否可见（自己的可见；小于 min_trx_id 可见；大于等于 max_trx_id 不可见；在 m_ids 中不可见；否则可见），不可见就沿 roll_ptr 找上一版本。

> [!QUESTION] RC 和 RR 在 MVCC 上的区别是什么？
> 唯一区别是 ReadView 的生成时机：RC 每条语句生成一个新的，RR 在事务第一次快照读时生成并复用。加锁层面 RC 基本不加间隙锁，RR 当前读会加 Next-Key Lock。

> [!QUESTION] InnoDB 的 RR 解决幻读了吗？
> 快照读不会幻读（固定 ReadView）；当前读通过 Next-Key Lock 阻止范围内插入，也不会幻读。但快照读与当前读混用时可能出现：先快照读不存在，别人插入提交后自己 UPDATE 该行成功，再快照读就能看到。所以严格说 RR 没有完全等价于串行化。

> [!QUESTION] max_trx_id 是 m_ids 里的最大值吗？
> 不是。它是创建 ReadView 时系统下一个将要分配的事务 ID。大于等于它的事务是 ReadView 创建之后才开始的，一定不可见。

> [!QUESTION] 长事务有什么危害？怎么发现？
> 阻止 undo purge 导致 undo 膨胀和版本链变长、长时间持有行锁和 MDL、占用连接、造成主从延迟。通过 `information_schema.innodb_trx` 按 `trx_started` 排查，结合 processlist 与 performance_schema 定位来源；监控 History list length。

> [!QUESTION] 二级索引如何做 MVCC 判断？
> 二级索引记录没有 trx_id 隐藏列。先看页头 `PAGE_MAX_TRX_ID`，若小于 ReadView 的 min_trx_id，页内所有记录可见；否则需要回表到聚簇索引沿版本链判断，并且要处理带删除标记的记录。
