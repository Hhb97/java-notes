---
level: 深入
tags: [redo log, undo log, binlog, WAL, 两阶段提交, 组提交]
summary: 讲清 InnoDB 三大日志各自解决什么问题、怎么写盘、何时可以丢弃，以及 redo 与 binlog 如何通过两阶段提交和组提交实现崩溃一致与高吞吐。
---

# redo / undo / binlog

> [!ABSTRACT] 核心要点
> - **redo log**：InnoDB 的物理日志，实现 WAL，保证**持久性与崩溃恢复**；固定大小循环写，write pos 不能追上 checkpoint。
> - **undo log**：逻辑日志，保证**原子性（回滚）和 MVCC**；没有 ReadView 需要时由 purge 回收。
> - **binlog**：Server 层逻辑日志，用于**复制与按时间点恢复**；追加写，有 STATEMENT / ROW / MIXED 三种格式，生产用 ROW。
> - redo 与 binlog 通过**两阶段提交**（prepare → 写 binlog → commit）保证一致；崩溃恢复时 prepare 状态的事务以 binlog 中是否有完整 XID 为准。
> - “双 1”（`innodb_flush_log_at_trx_commit=1` + `sync_binlog=1`）保证已提交事务不丢；**组提交**把多个事务的 fsync 合并，使双 1 下仍有高吞吐。

## redo log

### 为什么需要 WAL

如果每次提交都把修改过的数据页刷盘：一个页 16KB，修改可能只有几十字节，且页分散在磁盘各处，是**大量随机写**。WAL（Write-Ahead Logging）的思路是：提交时只把“对哪个页的哪个位置做了什么修改”顺序追加到 redo log 并落盘，数据页留在 Buffer Pool 中由后台慢慢刷。崩溃后用 redo 重放即可恢复。

redo 是**物理逻辑日志**（physiological）：以页为单位记录修改，例如“表空间 5 第 1024 页偏移 120 处插入一条记录，内容为……”。重放是幂等的——每个页头记录了 `FIL_PAGE_LSN`，页上的 LSN 已经大于该条 redo 的 LSN 时直接跳过。

### 写入路径与 innodb_flush_log_at_trx_commit

redo 先写到内存中的 **log buffer**（`innodb_log_buffer_size`，8.0 默认 16MB），再 `write` 到操作系统 page cache，最后 `fsync` 到磁盘。

| 取值 | 提交时的动作 | MySQL 进程崩溃 | 操作系统崩溃 / 掉电 |
| --- | --- | --- | --- |
| **1**（默认） | write + fsync | 不丢 | 不丢 |
| 2 | 只 write 到 page cache，每秒 fsync 一次 | 不丢 | 可能丢约 1 秒 |
| 0 | 不做任何事，后台线程每秒 write + fsync | 可能丢约 1 秒 | 可能丢约 1 秒 |

除了提交触发，以下情况也会写 redo 到磁盘：后台线程每秒刷一次（因此**未提交事务的 redo 也可能已经落盘**，恢复时靠 undo 回滚它们）；log buffer 使用超过一半时；checkpoint 时。

### 环形写：write pos 与 checkpoint

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="redo log 循环写入，write pos 与 checkpoint 之间为未刷脏的日志区">
<text class="ts" x="200" y="38" text-anchor="middle">checkpoint（之前的修改已刷盘）</text>
<line class="l" x1="200" y1="46" x2="200" y2="98" marker-end="url(#arr)"/>
<text class="ta" x="470" y="38" text-anchor="middle">write pos（当前写入位置）</text>
<line class="la" x1="470" y1="46" x2="470" y2="98" marker-end="url(#arr-a)"/>
<rect class="b2" x="60" y="100" width="140" height="50"/>
<text class="t" x="130" y="125" text-anchor="middle" dominant-baseline="middle">可覆盖</text>
<rect class="b3" x="200" y="100" width="270" height="50"/>
<text class="t" x="335" y="125" text-anchor="middle" dominant-baseline="middle">对应脏页未刷盘，不可覆盖</text>
<rect class="b2" x="470" y="100" width="210" height="50"/>
<text class="t" x="575" y="125" text-anchor="middle" dominant-baseline="middle">空闲，可写</text>
<line class="ld" x1="215" y1="100" x2="215" y2="150"/>
<line class="ld" x1="370" y1="100" x2="370" y2="150"/>
<line class="ld" x1="525" y1="100" x2="525" y2="150"/>
<text class="tm" x="137" y="170" text-anchor="middle">file 0</text>
<text class="tm" x="292" y="170" text-anchor="middle">file 1</text>
<text class="tm" x="447" y="170" text-anchor="middle">file 2</text>
<text class="tm" x="602" y="170" text-anchor="middle">file 3</text>
<line class="l" x1="680" y1="125" x2="705" y2="125"/>
<line class="l" x1="705" y1="125" x2="705" y2="200"/>
<line class="l" x1="705" y1="200" x2="35" y2="200"/>
<line class="l" x1="35" y1="200" x2="35" y2="125"/>
<line class="l" x1="35" y1="125" x2="58" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="370" y="222" text-anchor="middle">写到末尾回到开头循环写；write pos 追上 checkpoint 时所有更新阻塞，必须先刷脏推进 checkpoint</text>
<text class="ts" x="370" y="244" text-anchor="middle">8.0.30+ 由 innodb_redo_log_capacity 管理，#innodb_redo 目录下 32 个文件</text>
</svg>
<figcaption>图 1：redo 是固定大小的环形空间。checkpoint 之前的日志对应的脏页都已落盘，可以被覆盖</figcaption>
</figure>

- **checkpoint** 能推进到哪里，取决于 Flush 链表上最老脏页的 `oldest_modification`（见 [InnoDB 存储结构与 Buffer Pool](#/mysql/storage)）。
- 两者之间的距离叫 **checkpoint age**。它接近容量的一定比例时，InnoDB 开始激进的异步刷脏，再接近就是同步刷脏、阻塞用户线程——这就是“写多时 MySQL 周期性卡顿”的重要原因。
- **redo 容量太小**：频繁触发刷脏，写性能抖动；**太大**：崩溃恢复时间变长（要重放的日志多）。一般让 redo 容纳高峰期约 1 小时左右的写入量是常见经验值。

| 版本 | 参数 | 说明 |
| --- | --- | --- |
| 5.7 / 8.0.30 前 | `innodb_log_file_size` × `innodb_log_files_in_group` | 默认 48MB × 2，修改需重启 |
| 8.0.30+ | `innodb_redo_log_capacity` | 默认 100MB，**可在线动态调整**；文件位于 `#innodb_redo` 目录 |

### LSN

LSN（Log Sequence Number）是一个单调递增的 64 位数，表示**自实例创建以来写入 redo 的字节总量**。它贯穿整个恢复体系：

- redo 中每条记录有 LSN；
- 每个页的 `FIL_PAGE_LSN` 记录最后修改它的 LSN；
- 脏页的 `oldest_modification`、checkpoint LSN、已 flush 到磁盘的 LSN。

```text
SHOW ENGINE INNODB STATUS → LOG 段
Log sequence number          88021345678   -- 当前已生成的 redo
Log flushed up to            88021345678   -- 已落盘
Pages flushed up to          88010023456   -- 最老脏页对应的 LSN
Last checkpoint at           88010023400   -- checkpoint
checkpoint age = Log sequence number - Last checkpoint at
```

崩溃恢复：从 checkpoint LSN 开始扫描 redo，对每条记录比较页 LSN，小于才重放；之后对未提交的事务用 undo 回滚，对 prepare 状态的事务查 binlog 决定提交还是回滚。

## undo log

### 作用

1. **回滚**：事务执行 `ROLLBACK` 或崩溃恢复时撤销未提交的修改。INSERT 对应记“删除这个主键”，DELETE 对应记“恢复这行”，UPDATE 记录被修改列的旧值。
2. **MVCC**：通过 `DB_ROLL_PTR` 构成版本链，供快照读构造历史版本（见 [事务隔离与 MVCC](#/mysql/transaction)）。

undo 本身也存放在页中，**undo 页的修改同样会写 redo**，所以崩溃后 undo 能被恢复，进而回滚未提交事务。

### 存储与 purge

- 5.7 可以把 undo 放在独立 undo 表空间（需初始化时指定）；8.0 默认有两个独立 undo 表空间，每个包含若干回滚段（rollback segment），每个回滚段有多个 undo slot，限制了最大并发读写事务数。
- **insert undo**：提交后即可释放。**update undo**：提交后放入 history list，等**所有 ReadView 都不再需要**时由 purge 线程清理，同时真正删除带删除标记的记录。
- 观察指标：`History list length`（INNODB STATUS 的 TRANSACTIONS 段）。持续增长说明有长事务或 purge 跟不上（可调 `innodb_purge_threads`，默认 4）。
- 8.0 中 `innodb_undo_log_truncate=ON`（默认），undo 表空间超过 `innodb_max_undo_log_size`（默认 1GB）时自动截断回收。

## binlog

### 与 redo 的区别

| 维度 | redo log | binlog |
| --- | --- | --- |
| 所属层 | InnoDB | Server 层，所有引擎共享 |
| 内容 | 物理逻辑：某页某处的修改 | 逻辑：SQL 语句或行的前后镜像 |
| 写入方式 | 固定大小循环写 | 追加写，写满一个文件（`max_binlog_size` 默认 1GB）切换下一个 |
| 写入时机 | 事务执行过程中不断写 | 事务提交时一次性写入（执行时先缓存在 binlog cache） |
| 用途 | 崩溃恢复 | 主从复制、按时间点恢复、CDC（Canal、Debezium） |
| 能否恢复整个库的历史 | 不能，旧日志会被覆盖 | 能，配合全量备份可恢复到任意时间点 |

### 三种格式

| 格式 | 记录内容 | 优点 | 缺点 |
| --- | --- | --- | --- |
| STATEMENT | 原始 SQL | 日志小 | `NOW()`、`UUID()`、`LIMIT` 无 ORDER BY 等不确定语句会导致主从不一致 |
| **ROW**（5.7.7+ 默认） | 每一行修改前后的数据 | 准确，可用于数据闪回和 CDC | 批量更新时日志很大 |
| MIXED | 默认 STATEMENT，不安全时切换 ROW | 折中 | 行为不易预测 |

ROW 格式下可以用 `binlog_row_image=MINIMAL` 只记录必要列来减少体积（但会降低闪回和部分 CDC 工具的可用性，默认 `FULL`）。

### binlog 写盘与 sync_binlog

每个线程有自己的 **binlog cache**（`binlog_cache_size`，超出则落临时文件），事务提交时把整个事务写入 binlog 文件——**一个事务的 binlog 不能被拆开**，这是从库能按事务回放的基础。

| `sync_binlog` | 含义 |
| --- | --- |
| 0 | 只 write 到 page cache，fsync 交给操作系统，掉电可能丢失 |
| **1**（5.7.7+ 默认） | 每次提交都 fsync |
| N | 每 N 个事务组提交 fsync 一次，掉电可能丢最近 N 个事务的 binlog |

## 两阶段提交

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="两阶段提交的步骤与崩溃恢复判断逻辑">
<rect class="b1" x="40" y="30" width="260" height="44" rx="8"/>
<text class="t" x="170" y="52" text-anchor="middle" dominant-baseline="middle">执行更新：写 undo、改内存页</text>
<line class="l" x1="170" y1="74" x2="170" y2="98" marker-end="url(#arr)"/>
<rect class="b3" x="40" y="100" width="260" height="44" rx="8"/>
<text class="t" x="170" y="122" text-anchor="middle" dominant-baseline="middle">redo 写入并落盘：prepare（XID）</text>
<line class="l" x1="170" y1="144" x2="170" y2="168" marker-end="url(#arr)"/>
<text class="ta" x="180" y="160">崩溃点 A</text>
<rect class="b2" x="40" y="170" width="260" height="44" rx="8"/>
<text class="t" x="170" y="192" text-anchor="middle" dominant-baseline="middle">binlog 写入并落盘（含 XID 事件）</text>
<line class="l" x1="170" y1="214" x2="170" y2="238" marker-end="url(#arr)"/>
<text class="ta" x="180" y="230">崩溃点 B</text>
<rect class="b3" x="40" y="240" width="260" height="44" rx="8"/>
<text class="t" x="170" y="262" text-anchor="middle" dominant-baseline="middle">redo 写 commit 标记</text>
<rect class="b" x="430" y="20" width="290" height="40" rx="8"/>
<text class="tb" x="575" y="40" text-anchor="middle" dominant-baseline="middle">重启：扫描 redo 中的事务状态</text>
<line class="l" x1="500" y1="60" x2="497" y2="98" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="60" x2="652" y2="98" marker-end="url(#arr)"/>
<rect class="b2" x="430" y="100" width="135" height="50" rx="8"/>
<text class="tb" x="497" y="118" text-anchor="middle" dominant-baseline="middle">commit 状态</text>
<text class="ts" x="497" y="138" text-anchor="middle" dominant-baseline="middle">直接提交</text>
<rect class="b3" x="585" y="100" width="135" height="50" rx="8"/>
<text class="tb" x="652" y="118" text-anchor="middle" dominant-baseline="middle">prepare 状态</text>
<text class="ts" x="652" y="138" text-anchor="middle" dominant-baseline="middle">按 XID 查 binlog</text>
<line class="l" x1="630" y1="150" x2="500" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="652" y1="150" x2="652" y2="188" marker-end="url(#arr)"/>
<rect class="b2" x="430" y="190" width="135" height="50" rx="8"/>
<text class="tb" x="497" y="208" text-anchor="middle" dominant-baseline="middle">binlog 完整</text>
<text class="ts" x="497" y="228" text-anchor="middle" dominant-baseline="middle">提交（崩溃点 B）</text>
<rect class="b4" x="585" y="190" width="135" height="50" rx="8"/>
<text class="tb" x="652" y="208" text-anchor="middle" dominant-baseline="middle">binlog 不完整</text>
<text class="ts" x="652" y="228" text-anchor="middle" dominant-baseline="middle">回滚（崩溃点 A）</text>
<text class="ts" x="575" y="268" text-anchor="middle">binlog 是否完整：ROW 格式以 XID event 为准</text>
</svg>
<figcaption>图 2：左为提交步骤，右为崩溃恢复决策。binlog 充当“仲裁者”：它有，就必须提交，因为从库可能已经拿到了</figcaption>
</figure>

**为什么必须两阶段**：redo 和 binlog 是两个独立的日志，必须做到“要么都有，要么都没有”。

- 先 redo 后 binlog，中间崩溃：主库重启后通过 redo 恢复了数据，但 binlog 没有，从库和用 binlog 恢复的备份库少了这个事务。
- 先 binlog 后 redo，中间崩溃：主库回滚了这个事务，但从库已经通过 binlog 执行了它。

两阶段提交之后，崩溃点 A（prepare 后、binlog 前）回滚，崩溃点 B（binlog 完整、未 commit）提交，结果都与 binlog 一致。恢复判断本质上是：**以 binlog 为准**。

### 组提交（Group Commit）

双 1 下每个事务提交需要两次 fsync（redo prepare + binlog），单次 fsync 在 SSD 上通常是几十到几百微秒级，TPS 有上限。5.6 起引入 binlog 组提交（BLGC），提交分为三个阶段，每个阶段有一个队列，**队首（leader）替整个队列做事**：

| 阶段 | 动作 | 说明 |
| --- | --- | --- |
| Flush | leader 把队列中所有事务的 binlog 从 cache 写入文件（write） | 5.7 起此阶段前还会把 redo prepare 一起批量 fsync（redo 组提交） |
| Sync | 对 binlog 文件做一次 fsync | 一组事务共享一次 fsync |
| Commit | 按顺序在 InnoDB 中提交 | 保证 binlog 顺序与提交顺序一致 |

可以通过延迟 fsync 让更多事务凑成一组：`binlog_group_commit_sync_delay`（微秒）与 `binlog_group_commit_sync_no_delay_count`。代价是单个事务的提交延迟变大。

组提交还有一个附带收益：**同一组提交的事务在主库上没有锁冲突**，从库可以并行回放它们，这是基于组提交的并行复制的依据（见 [主从复制与高可用](#/mysql/replication)）。

## “双 1”配置与取舍

| 配置 | 安全性 | 性能 | 适用 |
| --- | --- | --- | --- |
| `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1` | 不丢已提交事务 | 依赖组提交 | 核心交易库（默认推荐） |
| `=2`, `sync_binlog=N(100~1000)` | 主机掉电可能丢少量事务 | 显著提升 | 可容忍少量丢失的业务、从库、批量导入期间 |
| `=0`, `sync_binlog=0` | MySQL 崩溃即可能丢 | 最高 | 仅限临时数据迁移 |

> [!WARNING] 非双 1 的隐患不止丢数据
> `sync_binlog≠1` 时，掉电后可能出现 redo 已提交但 binlog 丢失的情况，主从或备份恢复出来的数据与主库不一致；若该库是主库，故障切换后从库反而“多”出数据或“少”数据。核心库请保持双 1，靠组提交和更好的磁盘提升吞吐。

## redo vs binlog 速查

| 问题 | 回答 |
| --- | --- |
| 只用 binlog 能做崩溃恢复吗？ | 不能。binlog 不知道哪些修改已经刷到数据页，没有 checkpoint 概念；而且是逻辑日志，无法修复页级的部分写入 |
| 只用 redo 能做复制吗？ | 不能。redo 循环覆盖，不保留历史；且是 InnoDB 私有的物理格式，其他引擎、异构系统无法使用 |
| 未提交事务的 redo 会落盘吗？ | 会，后台每秒刷、log buffer 过半、其他事务提交时都可能把它一起刷下去；恢复时用 undo 回滚 |
| 未提交事务的 binlog 会落盘吗？ | 不会，只在提交时写入 binlog 文件 |
| 写 redo 会不会也是随机写？ | 不会，顺序追加，这正是 WAL 的意义 |

## 生产实践与踩坑

**1. 大事务导致 binlog 暴涨和主从延迟**

一次 `UPDATE` 几百万行，ROW 格式下 binlog 一个事务几个 GB，超过 `max_binlog_cache_size` 会直接报错；即使成功，从库也要用同样时间回放，期间延迟持续增长。修复：拆成小批量提交。

**2. 误删数据的闪回**

ROW + `binlog_row_image=FULL` 下，binlog 中保存了删除前的完整行，可以用 binlog2sql、MyFlash 等工具把 DELETE 反转为 INSERT。前提是 binlog 保留足够长：8.0 用 `binlog_expire_logs_seconds`（默认 30 天），5.7 用 `expire_logs_days`（默认 0 不清理）。

**3. redo 太小引起写入抖动**

5.7 默认 48MB × 2 对于写密集业务太小，checkpoint age 频繁打满。观察 INNODB STATUS 中 LSN 增速估算每小时 redo 量，调大 redo（8.0.30+ 可在线设 `innodb_redo_log_capacity`）。

**4. 按时间点恢复（PITR）**

全量备份（XtraBackup 或 mysqldump，记录 binlog 位点/GTID）+ 增量 binlog：先还原全量，再用 `mysqlbinlog --start-position/--stop-datetime` 重放到误操作之前。定期演练，确认 binlog 完整可用。

## 面试追问

> [!QUESTION] redo log 和 binlog 有什么区别？为什么要两份日志？
> redo 是 InnoDB 的物理日志、循环写，用于崩溃恢复；binlog 是 Server 层的逻辑日志、追加写，用于复制与时间点恢复。历史上 MySQL 先有 binlog 与 MyISAM（无崩溃恢复），InnoDB 作为插件引入了 redo，两者职责不同，谁也替代不了谁。

> [!QUESTION] 两阶段提交过程中崩溃，重启后怎么处理？
> 扫描 redo：commit 状态的直接提交；prepare 状态的拿 XID 去 binlog 查找，binlog 中存在完整事务则提交，否则回滚。这样保证主库数据与 binlog（从库）一致。

> [!QUESTION] innodb_flush_log_at_trx_commit 三个值分别是什么？
> 1：每次提交 write + fsync，最安全；2：提交时只写 page cache，每秒 fsync，MySQL 崩溃不丢、主机掉电可能丢约 1 秒；0：提交不写，每秒写并刷，MySQL 崩溃就可能丢约 1 秒。

> [!QUESTION] 双 1 配置下怎么保证性能？
> 组提交：flush、sync、commit 三阶段各由队首事务代表整组执行，多个事务共享一次 redo fsync 与一次 binlog fsync；还可以用 `binlog_group_commit_sync_delay` 主动凑组。加上 SSD 低延迟 fsync，双 1 能支撑较高 TPS。

> [!QUESTION] redo 写满了会发生什么？
> write pos 追上 checkpoint 时不能再写 redo，所有更新阻塞，InnoDB 必须先刷脏把 checkpoint 推进。表现为 TPS 断崖下跌。应合理设置 redo 容量与 `innodb_io_capacity`。

> [!QUESTION] undo log 什么时候删除？
> insert undo 事务提交即可释放；update undo 要等没有任何 ReadView 需要访问它后，由 purge 线程回收，同时物理删除打了删除标记的记录。长事务会阻止 purge，导致 undo 膨胀。
