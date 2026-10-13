---
level: 高级
tags: [TiDB, NewSQL, TiKV, PD, TiFlash, Raft, Region, Percolator, 分布式事务, HTAP]
summary: TiDB 的整体架构与原理：为什么出现 NewSQL、计算存储分离（TiDB / TiKV / PD / TiFlash）、数据如何映射成 KV 与 Region、Raft 多副本复制与 Region 调度、基于 Percolator 的分布式事务（2PC、TSO、乐观/悲观）与快照隔离、MVCC 与 GC、SQL 执行与下推、TiFlash 列存与 HTAP。
---

# TiDB 架构：TiKV、PD、Raft 与分布式事务

> [!ABSTRACT] 核心要点
> - **TiDB 是兼容 MySQL 协议的分布式 SQL 数据库（NewSQL）**：**水平扩展 + 强一致分布式事务 + 高可用（多副本自动故障转移）+ HTAP**，目标是**替代“MySQL 分库分表”的复杂度**。
> - 架构是**计算存储分离**：**TiDB Server**（无状态 SQL 层）、**TiKV**（分布式事务型 KV 存储，行存）、**PD**（元数据 + 调度 + 全局时间戳 TSO）、**TiFlash**（列存副本，用于分析）。
> - 数据按 **Region（默认约 96MB）** 切分，每个 Region 用 **Raft** 复制 3 副本（可配置），Leader 负责读写；**Region 自动分裂、迁移、均衡**，对应用透明。
> - 事务基于 **Percolator 模型**：**两阶段提交 + PD 提供的全局时间戳 TSO + MVCC**；隔离级别是**快照隔离（SI）**，对外表现为“可重复读”；默认**悲观事务**（与 MySQL 行为更接近）。
> - **代价**：单次提交至少涉及 PD 取时间戳与多副本 Raft 写，**单条事务延迟高于单机 MySQL**；热点、大事务、自增主键等需要专门设计。适用于**数据量大（TB 级以上）、需要弹性扩展、又想保持 SQL/事务**的场景。

> [!NOTE] 版本说明
> TiDB 版本迭代快，默认值与特性（如默认事务模式、Region 大小、资源管控）随版本变化，下文数字以“典型默认值”为参考，请以所用版本的官方文档为准。实战与选型见 [TiDB 实战](#/db/tidb-practice)。

## 一、为什么需要 NewSQL

| 方案 | 问题 |
| --- | --- |
| **单机 MySQL** | 容量与写入受单机限制；主从只能扩展读；故障切换需要额外组件（见 [MySQL 主从复制](#/mysql/replication)） |
| **MySQL 分库分表** | 应用/中间件感知分片键；**跨分片事务与 JOIN 复杂**；扩容要数据迁移；全局唯一 ID、二级索引、DDL 都痛苦（见 [分库分表](#/mysql/sharding)） |
| **NoSQL（如 MongoDB）** | 扩展性好，但事务与 SQL 能力弱（见 [MongoDB](#/db/mongo-model)） |
| **NewSQL（TiDB/CockroachDB/…）** | **自动分片 + 分布式事务 + SQL**，用共识协议（Raft）做多副本强一致，借鉴 Google Spanner/F1 与 Percolator |

TiDB 的定位：**对应用呈现“一个很大的 MySQL”**，把分片、复制、故障转移、扩缩容交给系统。

## 二、整体架构

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="TiDB 架构：应用通过 MySQL 协议连接多个无状态的 TiDB Server；TiDB 把 SQL 转换为对 TiKV 的 KV 请求；TiKV 集群由多个节点组成，每个节点存放多个 Region 的副本，Region 之间用 Raft 复制；PD 集群保存元数据、分配全局时间戳并调度 Region；TiFlash 列存节点以 Raft Learner 角色异步复制 TiKV 数据，用于分析查询">
<rect class="b1" x="20" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="55" text-anchor="middle" dominant-baseline="middle">应用 / MySQL 驱动</text>
<rect class="b3" x="210" y="20" width="360" height="70" rx="12"/>
<text class="th" x="226" y="44">TiDB Server（无状态，可水平扩展）</text>
<text class="ts" x="226" y="66">解析 · 优化 · 执行 SQL；事务协调；经 LB（HAProxy/LVS）接入</text>
<line class="l" x1="150" y1="55" x2="210" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="620" y="20" width="160" height="150" rx="12"/>
<text class="th" x="636" y="44">PD 集群（≥3）</text>
<text class="ts" x="636" y="68">元数据：Region 路由</text>
<text class="ts" x="636" y="88">TSO：全局递增时间戳</text>
<text class="ts" x="636" y="108">调度：均衡 · 分裂 · 迁移</text>
<text class="ts" x="636" y="128">基于 etcd/Raft 高可用</text>
<line class="l" x1="570" y1="55" x2="620" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="130" width="540" height="130" rx="12"/>
<text class="th" x="36" y="154">TiKV 集群（行存，RocksDB）</text>
<rect class="b" x="36" y="168" width="150" height="76" rx="8"/>
<text class="ts" x="111" y="188" text-anchor="middle">TiKV 节点 1</text>
<text class="ts" x="111" y="208" text-anchor="middle">R1(L) R2 R4</text>
<text class="ts" x="111" y="228" text-anchor="middle">多个 Region 副本</text>
<rect class="b" x="206" y="168" width="150" height="76" rx="8"/>
<text class="ts" x="281" y="188" text-anchor="middle">TiKV 节点 2</text>
<text class="ts" x="281" y="208" text-anchor="middle">R1 R2(L) R3</text>
<rect class="b" x="376" y="168" width="170" height="76" rx="8"/>
<text class="ts" x="461" y="188" text-anchor="middle">TiKV 节点 3</text>
<text class="ts" x="461" y="208" text-anchor="middle">R1 R3(L) R4(L)</text>
<line class="l" x1="390" y1="90" x2="300" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="332" y="116" text-anchor="start">KV 读写</text>
<rect class="b4" x="580" y="190" width="200" height="70" rx="12"/>
<text class="th" x="596" y="214">TiFlash（列存）</text>
<text class="ts" x="596" y="236">Raft Learner 异步复制</text>
<text class="ts" x="596" y="252">MPP 分析引擎</text>
<line class="la" x1="546" y1="215" x2="580" y2="225" marker-end="url(#arr-a)"/>
<rect class="bg" x="20" y="280" width="760" height="86" rx="10"/>
<text class="ts" x="36" y="304">• 同一个 Region 的 3 个副本分布在不同 TiKV 节点（可跨机架/机房，用 label 约束），一个 Leader + 两个 Follower</text>
<text class="ts" x="36" y="324">• 写入：经 Leader → Raft 日志复制到多数副本 → 提交；任一节点宕机，Region 自动选主，数据不丢（多数派存活）</text>
<text class="ts" x="36" y="344">• 存储（TiKV/TiFlash）与计算（TiDB）可独立扩缩容；TiDB 无状态，故障时由 LB 剔除即可</text>
<text class="ts" x="36" y="360">• 生态组件：TiCDC（变更数据捕获）、BR（备份恢复）、DM（MySQL 迁移/同步）、Lightning（批量导入）、Dashboard（运维界面）</text>
</svg>
<figcaption>图 1：TiDB 架构：TiDB、TiKV、PD 与 TiFlash</figcaption>
</figure>

| 组件 | 职责 | 要点 |
| --- | --- | --- |
| **TiDB Server** | 兼容 MySQL 协议；SQL 解析、逻辑/物理优化、执行；把算子下推到 TiKV；事务协调者 | **无状态**，数量按计算与连接需求扩展；大查询/OOM 可能影响单个 TiDB 节点（有内存保护 `tidb_mem_quota_query`） |
| **PD（Placement Driver）** | 集群“大脑”：存储 Region 路由元数据；**分配全局单调递增时间戳 TSO**；**调度**（均衡负载、处理热点、副本补全、Leader 均衡） | 奇数节点（通常 3）、Raft 高可用；**PD 是事务的关键依赖**（取时间戳），要保证低延迟和高可用 |
| **TiKV** | 分布式事务 KV 存储；每个节点用 RocksDB 存数据；Raft 多副本；MVCC；Coprocessor 计算下推 | 数据以 Region 为单位管理 |
| **TiFlash** | **列式存储副本**，通过 Raft Learner 异步复制 TiKV 数据，**强一致读**（读时校验进度）；MPP 并行分析 | 实现 **HTAP**：同一份数据，行存服务 OLTP，列存服务分析，**互不干扰** |

## 三、数据如何存储：从表到 KV 到 Region

### 1. 行 → KV 映射

TiDB 把关系表编码成有序的 KV：

```text
行数据：  Key = t{tableID}_r{rowID或主键}                → Value = 各列编码后的值
索引：    Key = t{tableID}_i{indexID}{索引列值}{rowID}   → Value = (空/rowID)
```

- 主键为整数且聚簇（`PRIMARY KEY CLUSTERED` 整型）时，rowID 就是主键值，**点查只需一次 KV 读**；
- 二级索引是**独立的 KV 条目**（非聚簇索引需“回表”：索引查到 rowID 再读行）；
- Key 的有序性（按字节序）使**范围扫描**高效，这是用 Raft 复制的有序 KV 构建 SQL 的基础。

### 2. Region：数据分片的单位

<figure class="fig">
<svg viewBox="0 0 800 270" class="dg" role="img" aria-label="Region：整个 Key 空间按范围切成连续的 Region，每个 Region 约 96MB；Region 超过阈值自动分裂为两个，过小则合并；每个 Region 有三个副本分布在不同 TiKV 节点上，其中一个是 Leader；PD 根据负载和热点调度 Leader 与副本的位置">
<text class="th" x="20" y="24">Key 空间（按字节序排列）被切成连续的 Region</text>
<rect class="b2" x="20" y="40" width="160" height="44" rx="6"/>
<text class="ts" x="100" y="62" text-anchor="middle" dominant-baseline="middle">Region 1 [−∞, a)</text>
<rect class="b3" x="190" y="40" width="160" height="44" rx="6"/>
<text class="ts" x="270" y="62" text-anchor="middle" dominant-baseline="middle">Region 2 [a, k)</text>
<rect class="b5" x="360" y="40" width="160" height="44" rx="6"/>
<text class="ts" x="440" y="62" text-anchor="middle" dominant-baseline="middle">Region 3 [k, t)</text>
<rect class="b1" x="530" y="40" width="160" height="44" rx="6"/>
<text class="ts" x="610" y="62" text-anchor="middle" dominant-baseline="middle">Region 4 [t, +∞)</text>
<text class="ts" x="700" y="62" text-anchor="start">…</text>
<rect class="bg" x="20" y="110" width="360" height="140" rx="10"/>
<text class="th" x="36" y="134">Region 生命周期</text>
<text class="ts" x="36" y="158">• 超过阈值（约 96MB / 一定行数）→ 自动分裂 split</text>
<text class="ts" x="36" y="178">• 过小 → 合并 merge，减少管理开销</text>
<text class="ts" x="36" y="198">• 每个 Region 3 副本，Raft 组独立：一个 Leader 对外服务</text>
<text class="ts" x="36" y="218">• Region 数量过多（百万级）→ 心跳与调度压力，需调整大小</text>
<text class="ts" x="36" y="238">• 按需分裂，天然支持热点切分（热点 Region 负载分裂 load-base split）</text>
<rect class="bg" x="400" y="110" width="380" height="140" rx="10"/>
<text class="th" x="416" y="134">PD 调度做什么</text>
<text class="ts" x="416" y="158">• 保持每个 Region 副本数达标（节点故障后在别处补副本）</text>
<text class="ts" x="416" y="178">• 均衡各 TiKV 的 Region 数量、Leader 数量、存储与读写负载</text>
<text class="ts" x="416" y="198">• 迁移热点 Region 的 Leader / 切分热点 Region</text>
<text class="ts" x="416" y="218">• 满足 placement 规则（副本跨机架/机房/按标签放置）</text>
<text class="ts" x="416" y="238">• 加节点 → 自动搬迁数据；缩容 → 自动迁出（无需应用介入）</text>
</svg>
<figcaption>图 2：Region 的切分、副本与调度</figcaption>
</figure>

**客户端路由**：TiDB 先向 PD 查询“某个 Key 属于哪个 Region、Leader 在哪”，并**缓存路由信息**；Leader 变化时请求失败（`NotLeader`/`RegionError`）后刷新缓存并重试——这是偶发延迟的原因之一。

## 四、Raft 多副本

- 每个 Region 是一个 **Raft Group**：写请求由 Leader 追加到 Raft 日志，**复制到多数副本（3 副本中的 2 个）后提交**并应用到 RocksDB，然后返回；
- **Leader 宕机**：Follower 在选举超时后选主，数据不丢，通常秒级恢复；
- **读**：默认读 Leader；为保证线性一致，Leader 通过 **ReadIndex / Lease Read** 确认自己仍是 Leader；也可配置 **Follower Read** 减轻 Leader 压力（可能读取略旧数据，取决于模式）；
- **写放大**：一次写在 3 个副本上各落盘（RocksDB WAL + Raft log），跨机房部署会受网络 RTT 影响；
- 通用共识原理见 [Raft 与共识](#/distributed/consensus)，与 MongoDB 复制集、MySQL 半同步对比：**TiKV 的每个分片都是独立的强一致 Raft 组**，而不是“一个主库 + 异步从库”。

## 五、分布式事务：Percolator

### 1. 基本思想

TiDB 的事务模型源自 Google **Percolator**：在**不支持跨行事务的分布式 KV** 之上，用**两阶段提交（2PC）+ 全局时间戳 + MVCC** 实现跨行、跨 Region 的事务。

- **时间戳**：每个事务开始时向 PD 获取 `start_ts`（读快照版本），提交时获取 `commit_ts`；TSO 全局单调递增，决定事务的先后；
- **MVCC**：每个 Key 保存多个版本（按 commit_ts 排列），读事务按 `start_ts` 读取**不晚于它的最新已提交版本**（快照读）；
- **读不阻塞写，写不阻塞读**（快照读），读写冲突很少。

### 2. 两阶段提交过程

<figure class="fig">
<svg viewBox="0 0 800 360" class="dg" role="img" aria-label="Percolator 两阶段提交：事务开始时向 PD 获取 start_ts；执行阶段写入缓存在 TiDB；提交时选一个 Key 作为 primary；Prewrite 阶段对所有 Key 加锁并写入数据，检查写冲突；全部成功后向 PD 获取 commit_ts；Commit 阶段先提交 primary 这一步是事务的提交点，再异步提交 secondary 的锁；若 primary 已提交，其他锁可由后续读事务代为清理">
<rect class="b1" x="20" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="75" y="37" text-anchor="middle" dominant-baseline="middle">TiDB（协调）</text>
<rect class="b5" x="250" y="20" width="90" height="34" rx="6"/>
<text class="tb" x="295" y="37" text-anchor="middle" dominant-baseline="middle">PD</text>
<rect class="b2" x="460" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="525" y="37" text-anchor="middle" dominant-baseline="middle">TiKV（primary）</text>
<rect class="b2" x="650" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="715" y="37" text-anchor="middle" dominant-baseline="middle">TiKV（secondary）</text>
<line class="ld" x1="75" y1="54" x2="75" y2="346"/>
<line class="ld" x1="295" y1="54" x2="295" y2="346"/>
<line class="ld" x1="525" y1="54" x2="525" y2="346"/>
<line class="ld" x1="715" y1="54" x2="715" y2="346"/>
<line class="l" x1="75" y1="80" x2="295" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="185" y="72" text-anchor="middle">① BEGIN：取 start_ts</text>
<text class="ts" x="85" y="106" text-anchor="start">② 读数据（快照）；写操作缓存在 TiDB 内存</text>
<line class="l" x1="75" y1="136" x2="525" y2="136" marker-end="url(#arr)"/>
<line class="l" x1="75" y1="150" x2="715" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="400" y="128" text-anchor="middle">③ Prewrite：对所有 Key 加锁 + 写入临时数据；primary 是其中一个</text>
<text class="ts" x="400" y="172" text-anchor="middle">检查：是否有 commit_ts > start_ts 的更新（写写冲突）/ 是否被别的事务锁住</text>
<line class="l" x1="75" y1="198" x2="295" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="185" y="190" text-anchor="middle">④ 全部成功：取 commit_ts</text>
<line class="l" x1="75" y1="236" x2="525" y2="236" marker-end="url(#arr)"/>
<text class="ts" x="300" y="228" text-anchor="middle">⑤ Commit primary（提交点！成功即事务已提交）</text>
<text class="ta" x="85" y="262" text-anchor="start">⑥ 此时即可向客户端返回成功</text>
<line class="l" x1="75" y1="290" x2="715" y2="290" marker-end="url(#arr)"/>
<text class="ts" x="400" y="282" text-anchor="middle">⑦ 异步 Commit secondary：释放锁、写入提交记录</text>
<text class="ts" x="400" y="322" text-anchor="middle">崩溃恢复：读到残留锁的事务检查 primary 的状态——已提交则帮忙提交，未提交且超时则回滚</text>
</svg>
<figcaption>图 3：Percolator 两阶段提交：primary 的提交是事务的原子点</figcaption>
</figure>

要点：

- **primary key** 的提交状态是整个事务的**唯一事实**：primary 提交成功 = 事务成功，secondary 只是随后“补提交”；这样把分布式原子提交归结为**单个 Key 的原子操作**（由 Region 的 Raft 保证）；
- **崩溃容错**：协调者宕机留下的锁，由后续遇到锁的读/写事务**检查 primary 并清理**（锁有 TTL）；
- **1PC / Async Commit 优化**：只涉及单个 Region 的事务可用 1PC；Async Commit 让提交在 Prewrite 成功后即可返回，减少一次往返（延迟更低，可能影响某些一致性细节，按版本文档为准）。

### 3. 乐观 vs 悲观事务

| | 乐观事务 | **悲观事务（默认，3.0.8+）** |
| --- | --- | --- |
| 加锁时机 | 提交时（Prewrite）才检测冲突 | 执行 DML 时**即加悲观锁**（`SELECT ... FOR UPDATE`、UPDATE） |
| 冲突表现 | 提交时失败（`Write conflict`），应用需重试 | 与 MySQL 类似：等待锁，死锁检测 |
| 适用 | 冲突很少、追求吞吐 | **冲突多、从 MySQL 迁移（行为兼容）** |
| 注意 | 需要重试逻辑 | 持锁期间长事务会占用资源；有锁等待超时 `innodb_lock_wait_timeout` 对应的设置 |

### 4. 隔离级别

- TiDB 提供**快照隔离（Snapshot Isolation）**，对外声明为 `REPEATABLE READ`（兼容 MySQL 语法）。它与 MySQL 的 RR 有差异：**没有间隙锁（gap lock）**、**不会出现幻读**（快照读保证）但**会出现写偏斜（write skew）**；`SELECT ... FOR UPDATE` 当前读读取最新数据；
- 同时支持 `READ COMMITTED`（需开启）；不支持 `SERIALIZABLE`（设置会被忽略/降级，按版本）；
- 迁移时要检查依赖**间隙锁防幻读/防重复插入**的逻辑（改用唯一索引或显式 `FOR UPDATE` 校验）。MySQL 事务与锁细节见 [事务与 MVCC](#/mysql/transaction)、[InnoDB 锁](#/mysql/lock)。

### 5. 事务限制

| 限制 | 说明 |
| --- | --- |
| **单事务大小** | 受 `txn-total-size-limit`（默认约 100MB）与 TiKV Raft 日志/消息大小限制；**大事务（一次改百万行）会失败或极慢**，要分批（见 [实战](#/db/tidb-practice)）；新版本有流式提交/Pipelined DML 改进 |
| **延迟** | 一次提交至少：PD 取 start_ts → Prewrite（Raft）→ PD 取 commit_ts → Commit（Raft）。**跨 Region 越多越慢** |
| **PD 依赖** | 取时间戳要访问 PD（TiDB 有批量请求与缓存优化），PD 抖动影响全部事务 |
| 热点 Key 冲突 | 悲观锁排队、乐观事务大量重试 |

## 六、MVCC 与垃圾回收（GC）

- TiKV 在 RocksDB 中保存每个 Key 的多版本；旧版本用于满足长事务/快照读与 `AS OF TIMESTAMP`（**历史读/闪回**）；
- **GC**：后台按 `tidb_gc_life_time`（默认 10 分钟）清理过期版本；**长事务/长时间的快照读会阻止 GC 推进**，导致版本堆积、扫描变慢（类似 PostgreSQL 的 VACUUM 问题，见 [MVCC 与 VACUUM](#/pg/mvcc)）；
- 删除大量数据后，旧版本与墓碑在 GC/Compaction 前仍占空间并拖慢范围扫描——表现为“删了数据但变慢”，需要关注 GC 进度与 Compaction；
- 支持**历史读**：`SELECT * FROM t AS OF TIMESTAMP '2026-10-12 08:00:00'`，用于误操作排查与数据回溯（受 GC 时间限制）。

## 七、SQL 执行与计算下推

<figure class="fig">
<svg viewBox="0 0 800 270" class="dg" role="img" aria-label="TiDB 的 SQL 执行：SQL 解析成抽象语法树，经逻辑优化和基于代价的物理优化得到执行计划；过滤、聚合、TopN 等算子下推给 TiKV 的 Coprocessor 在存储节点并行执行，只把结果返回 TiDB 汇总；分析型查询可选择 TiFlash 的列存和 MPP 并行计算">
<rect class="b1" x="20" y="30" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="55" text-anchor="middle" dominant-baseline="middle">SQL</text>
<rect class="b3" x="150" y="30" width="150" height="50" rx="8"/>
<text class="tb" x="225" y="55" text-anchor="middle" dominant-baseline="middle">解析 → 逻辑优化</text>
<rect class="b5" x="330" y="30" width="170" height="50" rx="8"/>
<text class="tb" x="415" y="55" text-anchor="middle" dominant-baseline="middle">CBO 物理优化</text>
<text class="ts" x="415" y="96" text-anchor="middle">依赖统计信息 ANALYZE</text>
<rect class="b2" x="530" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="585" y="55" text-anchor="middle" dominant-baseline="middle">执行</text>
<line class="l" x1="120" y1="55" x2="150" y2="55" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="55" x2="330" y2="55" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="55" x2="530" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="660" y="20" width="120" height="30" rx="6"/>
<text class="ts" x="720" y="35" text-anchor="middle" dominant-baseline="middle">TiKV 行存 + 下推</text>
<rect class="b4" x="660" y="60" width="120" height="30" rx="6"/>
<text class="ts" x="720" y="75" text-anchor="middle" dominant-baseline="middle">TiFlash 列存 MPP</text>
<line class="l" x1="640" y1="48" x2="660" y2="38" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="62" x2="660" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="760" height="136" rx="10"/>
<text class="th" x="36" y="144">要点</text>
<text class="ts" x="36" y="166">• 算子下推（Coprocessor）：Selection（过滤）、Aggregation、TopN、Limit 在 TiKV 本地并行执行，只回传少量数据，减少网络与 TiDB 内存</text>
<text class="ts" x="36" y="186">• 分布式 Join：Hash Join（TiDB 内）、Index Join、Merge Join；大表 Join 可走 TiFlash MPP（Shuffle/Broadcast Join）</text>
<text class="ts" x="36" y="206">• 优化器依赖统计信息：数据变化大后要 ANALYZE；统计信息过期会选错计划（与 MySQL/PG 同理，见 SQL 调优）</text>
<text class="ts" x="36" y="226">• EXPLAIN ANALYZE 看真实执行：算子类型（root / cop[tikv] / mpp[tiflash]）、actRows 与 estRows 偏差、耗时、扫描 Key 数</text>
<text class="ts" x="36" y="246">• 优化器可通过 Hint 指定索引/Join 方式，或用 SQL Plan Management（绑定）固定执行计划</text>
</svg>
<figcaption>图 4：SQL 执行与计算下推</figcaption>
</figure>

## 八、TiFlash 与 HTAP

- TiFlash 以 **Raft Learner** 身份复制 TiKV 数据，**不参与投票和写入确认**（不拖慢 OLTP 写入），读取时通过 Raft 索引保证**与 TiKV 一致的快照**；
- **按表设置副本**：`ALTER TABLE orders SET TIFLASH REPLICA 1;`；之后优化器**基于代价自动选择**走行存（点查/小范围）还是列存（大范围聚合扫描），也可 Hint 强制；
- 列存 + MPP（并行、向量化）使分析型 SQL（多表 Join、大聚合）比行存快一个数量级以上；
- 价值：**同一份数据既跑交易又跑实时分析**，省去 ETL/CDC 到数仓的链路与延迟（对比 [CDC 与实时数仓](#/bigdata/cdc)、[OLAP](#/bigdata/olap)）；
- 限制：超大规模、复杂分析、成本敏感时，专用数仓/湖仓（ClickHouse、Doris、Spark）仍更合适；TiFlash 会占用额外存储与资源，要做资源隔离（独立节点）。

## 九、与其他方案对比

| | **TiDB** | MySQL 主从 | MySQL 分库分表 | MongoDB 分片 |
| --- | --- | --- | --- | --- |
| 水平扩展写 | ✅ 自动 | ❌（单主） | ✅（需中间件，迁移复杂） | ✅ 自动 |
| 分布式事务 | ✅（Percolator，强一致） | 单机事务 | 复杂（XA/柔性） | ✅（代价高） |
| SQL / MySQL 兼容 | 高（非完全） | 原生 | 受限（中间件） | 无 SQL（MQL） |
| 高可用 | Raft 自动 | 需 MHA/Orchestrator 等 | 每个分片各自主从 | 复制集自动 |
| 单事务延迟 | 较高（多次往返、Raft） | **最低** | 低（单分片） | 中 |
| 运维复杂度 | 组件多（TiDB/PD/TiKV），但统一 | 低 | 高（应用与中间件侵入） | 中 |
| HTAP | ✅ TiFlash | ❌ | ❌ | 弱 |

## 十、常见误区

| 误区 | 事实 |
| --- | --- |
| “TiDB 就是更快的 MySQL” | **单点查询延迟通常高于单机 MySQL**（多一层 SQL 层、PD 取时间戳、Raft 复制）；优势在**扩展性、可用性、弹性与大数据量下的稳定性** |
| “完全兼容 MySQL” | 高度兼容但有差异：隔离级别语义、不支持部分特性（存储过程/触发器/外键的支持随版本变化）、自增 ID 语义、大事务限制等，迁移需评估 |
| “自动分片，所以不用关心数据分布” | 仍有**热点问题**（自增主键、时间递增索引导致写入集中在一个 Region），见 [实战](#/db/tidb-practice) |
| “数据量小也该上” | 数据量/并发不大时，单机 MySQL/PG 成本更低、延迟更低、运维更简单 |
| “有 Raft 就不会丢数据，不需要备份” | 误删/逻辑错误仍需**备份（BR）+ 历史读 + CDC**；多副本不是备份 |

## 相关阅读

- [案例：分布式对象存储：元数据层](#/design/case-objectstore)：强一致分片 KV 作为元数据存储
- [分布式时钟：物理时间、逻辑时钟与 HLC](#/distributed/clock)：TSO 与 HLC 的对比
- [Paxos 与共识算法族：原理、变体与对比](#/distributed/paxos)：Multi-Raft 与共识算法族

## 面试追问

> [!QUESTION] TiDB 的整体架构是什么？各组件职责？
> 计算存储分离：TiDB Server 是无状态的 SQL 层，负责解析优化执行和事务协调；TiKV 是基于 RocksDB 的分布式事务 KV 存储，数据按 Region 切分并用 Raft 多副本复制；PD 保存元数据、分配全局时间戳 TSO 并做 Region 调度；TiFlash 是通过 Raft Learner 复制的列存副本，用于分析，实现 HTAP。

> [!QUESTION] TiDB 如何实现分布式事务？
> 基于 Percolator：事务开始从 PD 取 start_ts，写入先缓存，提交时选一个 primary key，Prewrite 阶段对所有 Key 加锁并写入并检查冲突，成功后取 commit_ts，先提交 primary，这是事务的提交点，再异步提交 secondary。崩溃遗留的锁由后续事务检查 primary 状态后清理或补提交，配合 MVCC 实现快照读。

> [!QUESTION] TiDB 的隔离级别与 MySQL 的 RR 有什么区别？
> TiDB 实现快照隔离，对外声明为可重复读。没有间隙锁，快照读不会幻读，但存在写偏斜，当前读读取最新数据；不支持 SERIALIZABLE。从 MySQL 迁移时依赖间隙锁防止并发重复插入或幻读的逻辑要改用唯一索引或显式 FOR UPDATE。

> [!QUESTION] Region 是什么？数据如何分布与扩容？
> Region 是按 Key 范围切分的连续数据块，默认约 96MB，每个 Region 三个副本组成一个 Raft 组，Leader 对外服务。数据增长会自动分裂，PD 根据副本数、存储、负载与热点调度副本和 Leader 迁移，新增节点后自动搬迁数据，对应用透明。

> [!QUESTION] TiDB 为什么单条事务延迟比 MySQL 高？适合什么场景？
> 一次提交要访问 PD 取两次时间戳，经过 Prewrite 和 Commit 两轮 Raft 多副本复制，跨 Region 越多越慢，而单机 MySQL 只有本地事务。TiDB 的价值在于水平扩展、自动故障转移和强一致分布式事务，适合数据量达到 TB 级以上、单机或分库分表难以维护且需要 SQL 与事务的场景。

> [!QUESTION] TiFlash 的作用？它如何保证与 TiKV 的数据一致？
> TiFlash 是列式副本，用 Raft Learner 异步复制 TiKV 数据，不参与投票所以不影响 OLTP 写入。读取时通过 Raft 索引确认已同步到所需进度，保证与 TiKV 一致的快照。优化器按代价选择行存或列存，实现同一份数据支持交易和实时分析。

> [!QUESTION] TiDB 的 GC 是怎么回事？有什么注意点？
> TiKV 保存多版本数据，后台按 gc_life_time 清理过期版本。长事务或长时间快照读会阻止 GC 推进，造成版本堆积使扫描变慢，大量删除后在 GC 和 Compaction 完成前空间不释放且范围扫描变慢，所以要避免长事务并监控 GC 进度，历史读也受 GC 时间限制。
