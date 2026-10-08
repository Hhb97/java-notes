---
level: 深入
tags: [PostgreSQL, 进程模型, shared_buffers, WAL, checkpoint, 堆表, TOAST, 连接池]
summary: 讲清 PostgreSQL 的进程模型与内存结构、堆表与页的存储布局、WAL 与 checkpoint 的崩溃恢复，以及与 MySQL InnoDB 的核心差异和对 Java 应用连接管理的影响。
---

# 架构、WAL 与存储结构

> [!ABSTRACT] 核心要点
> - PostgreSQL 是**多进程**架构：postmaster 为每个连接 **fork 一个 backend 进程**，所以连接成本高、`max_connections` 不能开太大，**必须用连接池**（应用池 + PgBouncer）。
> - 数据存放在**堆表（heap）**中，表是 8KB 页的集合，**所有索引都是二级索引**（指向 `ctid`，即页号+行号），没有聚簇索引概念；`CLUSTER` 只是一次性排序。
> - **MVCC 把多版本直接存在堆里**（没有 undo 表空间），因此需要 **VACUUM** 回收死元组——这是和 InnoDB 最大的区别，见 [MVCC、VACUUM 与锁](#/pg/mvcc)。
> - **WAL（预写日志）**保证持久性与崩溃恢复，也是**流复制、PITR、逻辑复制**的基础；写入路径：修改 shared_buffers → 写 WAL → 提交时 fsync WAL → 后台 checkpoint 刷脏页。
> - 版本选择：生产建议使用**受支持的最新大版本**（如 15/16/17）；PG 每年一个大版本，支持周期约 5 年。

## 进程与内存架构

<figure class="fig">
<svg viewBox="0 0 760 400" class="dg" role="img" aria-label="PostgreSQL 进程与内存结构：postmaster、backend、后台进程、共享内存与磁盘文件">
<rect class="b" x="20" y="20" width="110" height="46" rx="8"/>
<text class="tb" x="75" y="43" text-anchor="middle" dominant-baseline="middle">应用 / JDBC</text>
<rect class="b3" x="170" y="20" width="150" height="46" rx="8"/>
<text class="tb" x="245" y="43" text-anchor="middle" dominant-baseline="middle">postmaster</text>
<line class="l" x1="130" y1="43" x2="170" y2="43" marker-end="url(#arr)"/>
<text class="ts" x="150" y="34" text-anchor="middle">连接</text>
<rect class="b1" x="360" y="20" width="370" height="100" rx="12"/>
<text class="th" x="545" y="42" text-anchor="middle">Backend 进程（每连接一个 fork）</text>
<rect class="b" x="380" y="56" width="100" height="50" rx="6"/>
<text class="ts" x="430" y="72" text-anchor="middle">解析 · 重写</text>
<text class="ts" x="430" y="90" text-anchor="middle">规划 · 执行</text>
<rect class="b" x="490" y="56" width="110" height="50" rx="6"/>
<text class="ts" x="545" y="72" text-anchor="middle">work_mem</text>
<text class="ts" x="545" y="90" text-anchor="middle">（每排序/哈希）</text>
<rect class="b" x="610" y="56" width="100" height="50" rx="6"/>
<text class="ts" x="660" y="72" text-anchor="middle">本地缓存</text>
<text class="ts" x="660" y="90" text-anchor="middle">relcache 等</text>
<line class="l" x1="320" y1="43" x2="360" y2="43" marker-end="url(#arr)"/>
<text class="ts" x="340" y="34" text-anchor="middle">fork</text>
<rect class="b5" x="20" y="150" width="440" height="130" rx="12"/>
<text class="th" x="240" y="172" text-anchor="middle">共享内存 Shared Memory</text>
<rect class="b" x="40" y="188" width="180" height="76" rx="6"/>
<text class="tb" x="130" y="212" text-anchor="middle" dominant-baseline="middle">shared_buffers</text>
<text class="ts" x="130" y="234" text-anchor="middle">数据页缓存（常设内存 25%）</text>
<text class="ts" x="130" y="250" text-anchor="middle">时钟扫描替换</text>
<rect class="b" x="236" y="188" width="100" height="76" rx="6"/>
<text class="tb" x="286" y="212" text-anchor="middle" dominant-baseline="middle">WAL buffers</text>
<text class="ts" x="286" y="234" text-anchor="middle">日志缓冲</text>
<rect class="b" x="352" y="188" width="92" height="76" rx="6"/>
<text class="tb" x="398" y="212" text-anchor="middle" dominant-baseline="middle">锁表 / CLOG</text>
<text class="ts" x="398" y="234" text-anchor="middle">事务状态等</text>
<rect class="b2" x="500" y="150" width="230" height="130" rx="12"/>
<text class="th" x="615" y="172" text-anchor="middle">后台进程</text>
<text class="ts" x="615" y="198" text-anchor="middle">checkpointer：定期刷脏页</text>
<text class="ts" x="615" y="218" text-anchor="middle">background writer：渐进写脏页</text>
<text class="ts" x="615" y="238" text-anchor="middle">WAL writer · autovacuum launcher</text>
<text class="ts" x="615" y="258" text-anchor="middle">WAL sender/receiver（复制）· archiver</text>
<line class="l" x1="430" y1="106" x2="150" y2="188" marker-end="url(#arr)"/>
<rect class="b3" x="20" y="310" width="710" height="70" rx="12"/>
<text class="th" x="375" y="332" text-anchor="middle">磁盘</text>
<text class="ts" x="375" y="354" text-anchor="middle">base/（数据文件：表、索引，1GB 分段，8KB 页）· pg_wal/（WAL 段文件，默认 16MB）· pg_xact · 配置文件</text>
<line class="ld" x1="240" y1="280" x2="240" y2="310"/>
<line class="ld" x1="615" y1="280" x2="615" y2="310"/>
</svg>
<figcaption>图 1：PostgreSQL 的进程与内存结构</figcaption>
</figure>

### 关键内存参数

| 参数 | 含义 | 建议 |
| --- | --- | --- |
| `shared_buffers` | 共享缓冲池 | 通常**物理内存的 25%**（OS page cache 也会缓存，PG 依赖“双缓冲”，不要设太大） |
| `work_mem` | **每个**排序/哈希操作可用内存 | 默认 4MB；复杂查询会有多个节点各占一份，且**每连接**，不要盲目调大：`总占用 ≈ 并发 × 节点数 × work_mem` |
| `maintenance_work_mem` | VACUUM、建索引用 | 可设 512MB~2GB |
| `effective_cache_size` | 告诉**优化器**可用缓存总量（shared_buffers + OS cache） | 约内存的 50%~75%，只影响计划选择 |
| `max_connections` | 最大连接数 | 默认 100；不要盲目调到几千，用连接池 |
| `wal_buffers` | WAL 缓冲 | 默认 -1 自动（约 shared_buffers 的 1/32） |

### 连接数与连接池

- 每个连接一个**操作系统进程**（几 MB 内存，加上缓存与上下文切换），连接数过多会**严重拖慢**整体性能；
- Java 应用：HikariCP 的 `maximumPoolSize` 不要设大（经验：`CPU 核数×2 + 磁盘数` 量级，通常 10~30），**每个应用实例都有一个池**，实例数×池大小 ≤ `max_connections`；
- 微服务实例很多时，在数据库前面加 **PgBouncer**（事务级连接池，transaction pooling），让几千个应用连接复用几十个真正的后端连接；
- 事务级池化下不能使用会话级特性：`SET`（需用 `SET LOCAL`）、会话级 advisory lock、`LISTEN/NOTIFY`、预编译语句（JDBC 需配置 `prepareThreshold=0` 或使用 PgBouncer 1.21+ 支持的协议级预编译语句）。

## 存储结构：堆表与页

### 逻辑与物理对应

```text
Cluster（实例）→ Database → Schema → Table
物理：$PGDATA/base/<db_oid>/<relfilenode>    每张表/索引一个（或多个，1GB 分段）文件
      每个文件由 8KB 的页（page/block）组成
```

### 堆页（Heap Page）布局

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="PostgreSQL 8KB 堆页布局：页头、行指针数组向后增长、元组从页尾向前增长">
<rect class="b3" x="40" y="30" width="660" height="40" rx="0"/>
<text class="tb" x="370" y="50" text-anchor="middle" dominant-baseline="middle">PageHeader（24B）：LSN · checksum · lower · upper · special</text>
<rect class="b1" x="40" y="70" width="330" height="60" rx="0"/>
<text class="tb" x="205" y="92" text-anchor="middle" dominant-baseline="middle">ItemId 数组（行指针 4B/个）→ 向后增长</text>
<text class="ts" x="205" y="112" text-anchor="middle">(offset, length, flags)；ctid = (页号, 行指针序号)</text>
<rect class="bg" x="40" y="130" width="660" height="50" rx="0"/>
<text class="ts" x="370" y="155" text-anchor="middle">空闲空间 free space（lower 与 upper 之间）</text>
<rect class="b2" x="370" y="180" width="330" height="70" rx="0"/>
<text class="tb" x="535" y="202" text-anchor="middle" dominant-baseline="middle">元组 Tuple ← 从页尾向前增长</text>
<text class="tm" x="535" y="226" text-anchor="middle">header(23B: xmin xmax cid ctid infomask) | 数据</text>
<text class="ts" x="40" y="270" text-anchor="start">行指针间接寻址：更新同页元组、HOT 链、VACUUM 整理页面时，外部索引仍指向行指针，不必改动</text>
</svg>
<figcaption>图 2：8KB 页的结构，行指针从前向后、元组从后向前，中间是空闲空间</figcaption>
</figure>

- **元组头**中有 `xmin`（创建它的事务 ID）、`xmax`（删除/锁定它的事务 ID）、`ctid`（指向新版本）、`infomask` 位（提示位，缓存事务状态）——**MVCC 的可见性判断全靠它们**；
- **所有索引都是二级索引**：索引条目 = 键值 + `ctid`；`UPDATE` 产生新元组，通常索引也要新增条目（除非满足 **HOT** 条件，见下），这是 PG 更新放大、索引膨胀的来源；
- 页大小固定 **8KB**（编译期决定）；行不能跨页，超过约 2KB 的大字段走 **TOAST**。

### TOAST

大字段（`text/bytea/jsonb` 等变长类型）当元组超过约 2KB 时：先**压缩**（pglz / lz4，14+ 可选），仍太大则切片存到专用的 **TOAST 表**，主表里只放指针。影响：

- 读取大字段需要额外 IO，`SELECT *` 会无谓地读取 TOAST 数据，**只查需要的列**；
- 更新其他列时不会重写未改变的 TOAST 值（优势）；
- 大 JSONB 频繁整体更新代价高。

### 与 MySQL InnoDB 的主要差异

| | PostgreSQL | MySQL / InnoDB |
| --- | --- | --- |
| 数据组织 | **堆表**；所有索引指向 `ctid` | **聚簇索引**（主键 B+ 树存整行），二级索引存主键 |
| MVCC | 旧版本留在**堆页**中，靠 VACUUM 回收 | 旧版本在 **undo log**，purge 回收 |
| 更新开销 | 新版本整行写入，可能更新所有索引（HOT 例外） | 原地更新 + undo；二级索引按需更新 |
| 回表 | 索引 → `ctid` → 堆；**Index Only Scan** 需 visibility map | 二级索引 → 主键 → 聚簇索引 |
| 事务 DDL | **DDL 支持事务，可回滚** | DDL 隐式提交（8.0 起原子 DDL，但不可在事务内回滚） |
| 复制 | 物理流复制（WAL）+ 逻辑复制 | binlog 逻辑复制 |
| 连接模型 | 进程 / 连接 | 线程 / 连接 |
| 类型与扩展 | 丰富：数组、JSONB、范围、几何、全文检索；**扩展生态强**（PostGIS、pgvector、Timescale） | 相对精简 |
| SQL 能力 | 窗口函数、CTE、物化视图、部分索引、表达式索引等更完整 | 8.0 之后大幅补齐 |

## WAL：预写日志

### 写入路径

1. 事务修改页（在 shared_buffers 中变脏）；
2. 同时生成 **WAL 记录**，写入 WAL buffers；
3. **提交时**：把该事务的 WAL 刷盘（`fsync`）后才向客户端返回成功（`synchronous_commit = on` 时）；
4. 脏数据页由 **background writer** 与 **checkpointer** 异步刷盘，不需要在提交时写。

WAL 是**顺序追加写**，比随机写数据页高效；崩溃恢复时从最近的 checkpoint 开始**重放 WAL（redo）**。PG 没有单独的 undo（旧版本在堆里），所以恢复只需要 redo，回滚由 MVCC 可见性自然实现（中止事务的元组对其他人不可见）。

### Full Page Write 与 checkpoint

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="checkpoint 时间线：checkpoint 之后首次修改页会写入整页镜像到 WAL">
<line class="l" x1="30" y1="110" x2="710" y2="110" marker-end="url(#arr)"/>
<rect class="b3" x="120" y="86" width="14" height="48" rx="2"/>
<text class="ta" x="127" y="76" text-anchor="middle">checkpoint N</text>
<rect class="b3" x="480" y="86" width="14" height="48" rx="2"/>
<text class="ta" x="487" y="76" text-anchor="middle">checkpoint N+1</text>
<rect class="b4" x="170" y="140" width="110" height="36" rx="6"/>
<text class="tb" x="225" y="158" text-anchor="middle" dominant-baseline="middle">首次改页 P</text>
<text class="ts" x="225" y="194" text-anchor="middle">WAL 写入整页镜像（FPI）</text>
<rect class="b1" x="320" y="140" width="110" height="36" rx="6"/>
<text class="tb" x="375" y="158" text-anchor="middle" dominant-baseline="middle">再次改页 P</text>
<text class="ts" x="375" y="194" text-anchor="middle">只写增量记录</text>
<text class="ts" x="620" y="150" text-anchor="middle">崩溃：从 checkpoint N</text>
<text class="ts" x="620" y="168" text-anchor="middle">起重放 WAL</text>
<text class="ts" x="370" y="224" text-anchor="middle">full_page_writes 防止“撕裂页”（8KB 页只写入一部分）；代价是 checkpoint 后 WAL 突增</text>
</svg>
<figcaption>图 3：checkpoint 之后每个页第一次被修改会记录整页镜像</figcaption>
</figure>

- **Checkpoint**：把所有脏页刷盘并记录“恢复起点”；触发条件：`checkpoint_timeout`（默认 5min）或 WAL 增长到 `max_wal_size`（默认 1GB）；
- 为避免 IO 尖峰，`checkpoint_completion_target`（默认 0.9）把刷盘分散到间隔的 90% 时间；
- **Full Page Write**：OS 写 8KB 页不是原子的，可能撕裂；因此 checkpoint 后每个页**第一次**被修改时，WAL 会记录整页内容。代价：checkpoint 后写入放大。**调大 `checkpoint_timeout`/`max_wal_size` 减少 checkpoint 频率**，可明显降低 WAL 量；
- 关键 WAL 参数：

| 参数 | 说明 |
| --- | --- |
| `wal_level` | `minimal` < `replica`（默认，支持流复制/PITR）< `logical`（支持逻辑复制）|
| `synchronous_commit` | `on`（默认，等本地 WAL 刷盘）、`remote_write`、`remote_apply`（同步复制级别）、`off`（异步提交：不等刷盘，崩溃可能**丢最近几百毫秒**事务，但**不会损坏数据**）|
| `max_wal_size` / `min_wal_size` | 触发 checkpoint 的 WAL 上限 |
| `wal_compression` | 压缩整页镜像，减少 WAL |
| `archive_mode` / `archive_command` | WAL 归档，用于 PITR |

> [!TIP] 性能取舍：synchronous_commit
> 对**允许丢失极少量数据**的场景（日志、埋点），可以对**会话或事务级**设置 `SET LOCAL synchronous_commit = off`，吞吐大幅提升。这与 MySQL 的 `innodb_flush_log_at_trx_commit` 类似，见 [redo / undo / binlog](#/mysql/log)。

## 面向 Java 开发者的实践要点

```java
// HikariCP 连接 PostgreSQL 的典型配置
HikariConfig cfg = new HikariConfig();
cfg.setJdbcUrl("jdbc:postgresql://pg-host:5432/app?reWriteBatchedInserts=true&ApplicationName=order-service");
cfg.setMaximumPoolSize(20);              // 与 max_connections、实例数一起核算
cfg.setConnectionTimeout(3000);
cfg.setMaxLifetime(30 * 60 * 1000);      // 小于数据库/代理的连接超时
cfg.addDataSourceProperty("prepareThreshold", "5");   // 同一语句执行 5 次后转为服务端预编译
```

- **`reWriteBatchedInserts=true`**：JDBC 批量 insert 合并成多值 insert，批量写入吞吐提升数倍；
- `ApplicationName` 便于在 `pg_stat_activity` 中识别连接来源；
- **时区**：`timestamptz` 存 UTC，驱动按会话时区转换；统一使用 `timestamptz`，避免 `timestamp without time zone` 的歧义；
- 自增主键：`GENERATED ... AS IDENTITY`（推荐）或 `bigserial`；序列**不会回滚**，会产生空洞，不要要求连续；
- 事务中某条语句出错，**整个事务进入 aborted 状态**，后续语句都报错直到回滚（与 MySQL 不同）；需要用 `SAVEPOINT` 局部回滚；
- 排查入口：`pg_stat_activity`（会话与等待事件）、`pg_stat_statements`（慢 SQL 汇总）、`pg_locks`，见 [复制、高可用与实战](#/pg/ops)。

## 面试追问

> [!QUESTION] PostgreSQL 与 MySQL 的主要架构差异？
> PG 是多进程、堆表+二级索引、MVCC 多版本存储在堆中需 VACUUM、DDL 可事务回滚、扩展能力强；MySQL 是多线程、InnoDB 聚簇索引、MVCC 用 undo log、生态上更偏简单 OLTP。

> [!QUESTION] 为什么 PostgreSQL 需要连接池？
> 每个连接是一个独立进程，内存和上下文切换开销大，连接数过多会明显降低性能，并受 `max_connections` 限制；使用应用侧连接池和 PgBouncer 可复用少量后端连接。

> [!QUESTION] WAL 的作用与写入流程？
> 先写日志再写数据：提交时仅需顺序 fsync WAL，脏页后台异步刷；崩溃后从 checkpoint 起重放 WAL 恢复；同时是流复制、PITR 和逻辑复制的基础。

> [!QUESTION] full_page_writes 是做什么的？
> 防止操作系统写入 8KB 页发生撕裂：checkpoint 后第一次修改某页时，在 WAL 中记录整页镜像，崩溃恢复时用它修复；代价是 checkpoint 后 WAL 量上升，可通过拉长 checkpoint 间隔缓解。

> [!QUESTION] work_mem 为什么不能随意调大？
> 它是每个排序/哈希节点、每个连接各自使用的内存，复杂查询并发时总占用成倍放大，可能导致内存耗尽被 OOM；应按并发和查询复杂度估算，对个别大查询用会话级临时调大。
