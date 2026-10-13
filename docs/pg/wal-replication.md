---
level: 深入
tags: [PostgreSQL, WAL, LSN, 检查点, Full Page Write, 崩溃恢复, 流复制, 同步提交, 复制槽, 逻辑复制, 逻辑解码, 时间线, pg_rewind, PITR, pgBackRest]
summary: PostgreSQL WAL 与复制深入：WAL 记录结构与 LSN、写入与刷盘路径、检查点机制与调优、Full Page Write 的代价、崩溃恢复流程、物理流复制（walsender/walreceiver）与同步提交级别、Quorum 同步、复制槽与 WAL 保留风险、备库查询冲突、逻辑解码与逻辑复制（发布订阅、REPLICA IDENTITY、限制）、时间线与 pg_rewind、基础备份与 PITR、备份工具与演练。
---

# PostgreSQL WAL 与复制深入：检查点、流复制、逻辑复制与 PITR

> [!ABSTRACT] 核心要点
> - **WAL（Write-Ahead Log）是 PG 一切持久性、复制与备份的基石**：任何对数据页的修改，**必须先把对应的 WAL 记录持久化**，再允许脏页落盘。**事务提交 = WAL 的提交记录刷盘成功**（由 `synchronous_commit` 控制策略），而不是数据页落盘。数据页由 **checkpointer / bgwriter** 异步慢慢写。
> - **LSN（Log Sequence Number）** 是 WAL 的 **64 位字节偏移**：每条记录有唯一 LSN，页头记录该页最后修改的 LSN。**所有“进度”都用 LSN 表达**：刷盘位置、复制位置（sent/write/flush/replay）、检查点位置、备份起点。
> - **检查点（Checkpoint）** 把截至某一 LSN 的脏页全部刷盘并写检查点记录，**崩溃恢复只需从最近检查点的 redo 起点重放 WAL**。检查点频率是**恢复时间 vs 写 I/O 平滑度**的权衡：`checkpoint_timeout`、`max_wal_size`、`checkpoint_completion_target`。**检查点后第一次修改每个页，要写整页镜像（Full Page Write）**，是 WAL 体量与写放大的主要来源。
> - **物理流复制**：备库通过 walreceiver 实时接收并**重放**主库 WAL，**字节级一致的副本**（用于高可用/读扩展）；**逻辑复制**：解码 WAL 成行变更，**按表发布/订阅**，可跨版本/跨平台/部分表（用于迁移、数据集成、选择性同步）。二者**用途不同、不可互相替代**。
> - **复制槽是双刃剑**：它保证主库**保留消费者尚未接收的 WAL**，避免备库掉队；但**失效/落后的槽会让 WAL 无限堆积撑爆磁盘**，并**钉住 xmin/catalog_xmin 导致膨胀**。必须设置 `max_slot_wal_keep_size` 并监控。
> - **同步复制的取舍**：`synchronous_commit` 的五个级别（off/local/remote_write/on/remote_apply）对应不同的**持久性/一致性/延迟**；**Quorum 同步（ANY k）** 容忍个别备库慢；**切换后的数据一致性、时间线、旧主回收（pg_rewind）** 是高可用正确性的关键。
> - **备份是最后的底线**：**基础备份 + 连续 WAL 归档 = 可恢复到任意时间点（PITR）**；备份必须**定期恢复演练**、校验，推荐使用 **pgBackRest/Barman** 等工具。

## WAL 的结构与写入

### 记录与段文件

- **WAL 记录**：包含**资源管理器 ID（Heap、Btree、Transaction、Standby…）**、**事务 ID**、**对数据块的引用（表空间/库/关系/块号）**、**重做数据（redo data）**，以及可能的**整页镜像（Full Page Image, FPI）**；
- **段文件**：WAL 存放在 `pg_wal/` 下的**固定大小段文件**（默认 **16MB**，`initdb --wal-segsize` 可调），文件名编码**时间线 + 段号**；
- **LSN**：形如 `0/3000060`（高 32 位/低 32 位），可用 `pg_wal_lsn_diff(a,b)` 计算字节差，`pg_walfile_name(lsn)` 得到所在段文件；
- **页头的 `pd_lsn`**：记录该数据页最后一次修改对应的 WAL LSN，**用于恢复时判断“这条 WAL 是否已应用到该页”（幂等重放）**和刷脏前确认 WAL 已刷盘（**WAL 先行规则**）。

### 写入路径

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="WAL 写入路径：后端进程修改共享缓冲区中的数据页并生成 WAL 记录写入 WAL 缓冲区；提交时 walwriter 或后端把 WAL 缓冲区写入并 fsync 到 pg_wal 段文件，提交返回；脏页由 bgwriter 和 checkpointer 异步写入数据文件，写页前必须保证对应 LSN 的 WAL 已落盘；检查点记录标记恢复起点；归档进程把写满的 WAL 段复制到归档存储；walsender 把 WAL 发送给备库">
<rect class="b3" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">后端进程</text>
<text class="ts" x="85" y="74" text-anchor="middle">改页 + 生成 WAL</text>
<rect class="b5" x="170" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="235" y="52" text-anchor="middle" dominant-baseline="middle">WAL 缓冲区</text>
<text class="ts" x="235" y="74" text-anchor="middle">内存中追加</text>
<rect class="b1" x="320" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="390" y="52" text-anchor="middle" dominant-baseline="middle">pg_wal 段文件</text>
<text class="ts" x="390" y="74" text-anchor="middle">提交时 fsync</text>
<rect class="b4" x="480" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="545" y="52" text-anchor="middle" dominant-baseline="middle">提交返回</text>
<text class="ts" x="545" y="74" text-anchor="middle">WAL 已持久化</text>
<rect class="b2" x="630" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="685" y="52" text-anchor="middle" dominant-baseline="middle">脏页</text>
<text class="ts" x="685" y="74" text-anchor="middle">异步落盘</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="62" x2="320" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="62" x2="480" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="112" width="350" height="104" rx="8"/>
<text class="th" x="32" y="132">谁在写 WAL / 页</text>
<text class="ts" x="195" y="158" text-anchor="middle">walwriter：周期刷 WAL 缓冲（异步提交的兜底）</text>
<text class="ts" x="195" y="180" text-anchor="middle">bgwriter：持续把脏页写出，减轻检查点压力</text>
<text class="ts" x="195" y="202" text-anchor="middle">checkpointer：周期性做检查点，刷全部脏页</text>
<rect class="bg" x="390" y="112" width="350" height="104" rx="8"/>
<text class="th" x="402" y="132">谁在读 WAL</text>
<text class="ts" x="565" y="158" text-anchor="middle">崩溃恢复/备库启动：从检查点 redo 点重放</text>
<text class="ts" x="565" y="180" text-anchor="middle">walsender：流式发送给备库/逻辑订阅者</text>
<text class="ts" x="565" y="202" text-anchor="middle">archiver：把写满的段归档到外部存储</text>
<rect class="bg" x="20" y="232" width="720" height="96" rx="8"/>
<text class="ts" x="380" y="256" text-anchor="middle">WAL 先行规则：脏页写盘前，必须确保该页 pd_lsn 之前的 WAL 已刷盘 → 崩溃后能用 WAL 重放恢复，不会出现“页比 WAL 新”</text>
<text class="ts" x="380" y="278" text-anchor="middle">顺序写 + 一次 fsync 提交一个事务（组提交可合并多个事务的 fsync）；数据文件是随机写但延后、可合并、可异步</text>
<text class="ts" x="380" y="300" text-anchor="middle">wal_level：minimal（最少）/ replica（支持物理复制与归档）/ logical（额外信息，支持逻辑解码）；越高 WAL 越大</text>
<text class="ta" x="380" y="320" text-anchor="middle">wal_buffers 默认自动（约 shared_buffers 的 1/32，上限一个段）；高并发写入时过小会导致后端自己刷 WAL 竞争</text>
</svg>
<figcaption>图 1：WAL 的写入路径与相关后台进程</figcaption>
</figure>

### 提交的持久性级别

`synchronous_commit` 控制提交返回前等待什么：

| 值 | 等待 | 持久性/风险 | 说明 |
| --- | --- | --- | --- |
| **off** | 不等待本地刷盘 | 崩溃可能丢最近 ≤ 约 3×`wal_writer_delay` 的已提交事务（**不会损坏数据库，只是丢事务**） | 日志/可重放类数据；吞吐显著提升 |
| **local** | 本地 WAL 刷盘 | 不等备库 | 有同步备库配置时也可对个别事务降级 |
| **remote_write** | 本地刷盘 + 备库**写入 OS 缓冲**（未必 fsync） | 备库 OS 崩溃可能丢，主库崩溃不丢 | 延迟较小 |
| **on（默认）** | 本地刷盘；若配置了同步备库则等**备库 fsync 到磁盘** | 备库持久化 | 常用的强持久级别 |
| **remote_apply** | 备库**已重放（对查询可见）** | 最强：备库读自己的写 | 延迟最高；用于“读备库也要强一致” |

要点：**可以按事务/会话/库设置**（`SET LOCAL synchronous_commit = off`），让关键事务强持久、非关键事务高吞吐。

## 检查点与崩溃恢复

### 检查点做什么

**检查点**是**“已知所有 LSN ≤ X 的修改都已刷到数据文件”的一致性点**：

1. 记录 **redo 起点**（检查点开始时的 WAL 位置）；
2. **把检查点开始前的所有脏页刷盘**（分散写，持续一段时间）；
3. 写入**检查点记录**并更新 `pg_control`（指向最新检查点）；
4. 回收不再需要的旧 WAL 段（受 `wal_keep_size`、复制槽、归档限制）。

触发：`checkpoint_timeout`（默认 5 分钟）、WAL 增长到 `max_wal_size`（默认 1GB）、手动 `CHECKPOINT`、关机、`pg_basebackup` 开始等。

### 检查点调优

| 参数 | 默认 | 建议与原因 |
| --- | --- | --- |
| `checkpoint_timeout` | 5min | 写入密集型调到 **15~30min**：减少检查点次数 → **减少 Full Page Write → 降低 WAL 体量与写放大**；代价：崩溃恢复要重放更多 WAL（恢复变慢） |
| `max_wal_size` | 1GB | **调大**（数 GB~数十 GB）避免因 WAL 增长频繁触发“被动”检查点（日志里出现 `checkpoints are occurring too frequently`）；磁盘要留够 |
| `min_wal_size` | 80MB | 保留的回收 WAL 数量，避免反复创建/删除文件 |
| `checkpoint_completion_target` | 0.9（PG14+） | 把脏页刷盘**分散到检查点间隔的 90% 时间内**，平滑 I/O，避免 I/O 尖刺 |
| `bgwriter_*` | — | 让 bgwriter 提前清理脏页，缓解检查点与后端自己写脏页 |
| `log_checkpoints` | on(新版) | 打开，观察每次检查点的写页数、耗时、是否被动触发 |

观察指标：`pg_stat_bgwriter`（新版 `pg_stat_checkpointer`）里 `checkpoints_timed` vs `checkpoints_req`（**req 远多于 timed 说明 max_wal_size 偏小**）、`buffers_backend`（后端自己刷脏页多，说明 bgwriter/检查点跟不上）。

### Full Page Write

- **问题**：数据页 8KB，操作系统/磁盘写入的原子单位通常更小（如 4KB 或 512B）。崩溃时可能**只写了页的一半（torn page）**，仅靠增量 WAL 无法修复一个“半新半旧”的页；
- **解法**：**检查点之后，某页第一次被修改时，WAL 里记录该页的完整镜像（FPI）**；恢复时先用 FPI 覆盖该页，再应用后续增量；
- **代价**：**检查点后的突发修改会放大 WAL**（每个“新触碰”的页写 8KB）；这是为什么**检查点太频繁会让 WAL 暴增**，也是大批量更新后 WAL 体积异常的原因；
- **缓解**：拉长检查点间隔（上表）；**`wal_compression`（lz4/zstd，新版本）压缩 FPI**，用少量 CPU 换大量 WAL 体积；使用支持**原子写**的文件系统/存储（如 ZFS）可考虑关闭 `full_page_writes`（**需深入评估，错误关闭会导致数据损坏**）；
- 校验：`data_checksums`（`initdb` 时启用或 `pg_checksums` 离线启用）检测磁盘静默损坏；开启 checksums 后会启用 hint bit 的 WAL 记录，写放大略增。

### 崩溃恢复

启动时若发现上次未正常关闭（`pg_control` 状态非 shut down）：

1. 读 `pg_control` 找到**最近检查点的 redo 起点**；
2. 从该 LSN 开始**顺序重放 WAL**：对每条记录，若目标页的 `pd_lsn` ≥ 记录 LSN 则跳过（已应用，幂等），否则应用（FPI 先覆盖整页）；
3. 重放到 WAL 末尾后，结束恢复，**未提交事务的修改因 xmin 未提交而不可见**（MVCC 使 PG **不需要 undo 阶段**，回滚的垃圾留给 VACUUM）；
4. 做一次**结束检查点**，开始提供服务。

恢复时间 ≈ 检查点间隔内产生的 WAL 量 / 重放速度（重放主要是随机读数据页 + 应用），**检查点越稀疏、写入越密集，崩溃恢复越慢**。

## 物理流复制

### 工作机制

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="物理流复制：主库的 walsender 进程把 WAL 流实时发送给备库的 walreceiver；备库 walreceiver 写入并 fsync WAL，启动进程 startup 持续重放 WAL 到数据页；备库可以提供只读查询（热备）；复制位置分为 sent、write、flush、replay；备库查询与重放冲突时会取消查询或延迟重放；级联复制中备库可以再向下游发送；流复制中断时可通过归档恢复追赶">
<rect class="b3" x="20" y="30" width="220" height="110" rx="10"/>
<text class="tb" x="130" y="50" text-anchor="middle" dominant-baseline="middle">主库（Primary）</text>
<text class="ts" x="130" y="76" text-anchor="middle">事务写 WAL</text>
<text class="ts" x="130" y="96" text-anchor="middle">walsender 读取并发送</text>
<text class="ts" x="130" y="118" text-anchor="middle">pg_stat_replication 查看进度</text>
<rect class="b1" x="520" y="30" width="220" height="110" rx="10"/>
<text class="tb" x="630" y="50" text-anchor="middle" dominant-baseline="middle">备库（Standby）</text>
<text class="ts" x="630" y="76" text-anchor="middle">walreceiver 接收并写入</text>
<text class="ts" x="630" y="96" text-anchor="middle">startup 进程持续重放</text>
<text class="ts" x="630" y="118" text-anchor="middle">hot_standby 提供只读查询</text>
<line class="l" x1="240" y1="85" x2="520" y2="85" marker-end="url(#arr)"/>
<text class="ta" x="380" y="76" text-anchor="middle">WAL 流（TCP）</text>
<text class="ta" x="380" y="108" text-anchor="middle">同步级别决定主库等多久</text>
<rect class="bg" x="20" y="156" width="720" height="174" rx="8"/>
<text class="th" x="32" y="176">复制进度的四个位置（pg_stat_replication）</text>
<text class="ts" x="380" y="202" text-anchor="middle">sent_lsn：主库已发出 → write_lsn：备库已写入 OS → flush_lsn：备库已 fsync → replay_lsn：备库已重放（查询可见）</text>
<text class="ts" x="380" y="224" text-anchor="middle">延迟 = 主库当前 LSN − 各位置：write_lag / flush_lag / replay_lag 也直接给出时间维度的延迟</text>
<text class="ts" x="380" y="250" text-anchor="middle">备库查询冲突：重放要清理行版本而备库查询仍需要 → 等待 max_standby_streaming_delay 后取消查询</text>
<text class="ts" x="380" y="272" text-anchor="middle">缓解：hot_standby_feedback（反馈最老 xmin，代价是主库膨胀）；报表备库放宽延迟</text>
<text class="ts" x="380" y="294" text-anchor="middle">级联复制：备库可作为上游给下游备库发送 WAL，减轻主库发送压力；归档与 restore_command 可在流复制中断后追赶</text>
<text class="ta" x="380" y="318" text-anchor="middle">物理复制是“同版本同架构的字节级副本”：不能选表同步，主库的任何变更（含大事务）都会被备库按序重放</text>
</svg>
<figcaption>图 2：物理流复制的进程、位置与冲突</figcaption>
</figure>

### 同步复制与 Quorum

```text
# 主库配置（postgresql.conf）
synchronous_commit = on
synchronous_standby_names = 'ANY 1 (standby1, standby2, standby3)'   # Quorum：任意 1 个备库确认即可
# 或严格优先级：'FIRST 1 (s1, s2)'  s1 不可用才轮到 s2
```

| 模式 | 行为 | 取舍 |
| --- | --- | --- |
| **FIRST k（优先级同步）** | 列表中前 k 个可用备库作同步备库 | 行为可预测；同步备库故障时顺位替补 |
| **ANY k（Quorum）** | 任意 k 个备库确认即可 | **容忍个别备库慢/故障，尾延迟更低**；多机房常用 |
| **所有同步备库都不可用** | 主库提交**一直等待（阻塞写入）** | **同步复制的可用性代价**：需要至少 N+1 个备库或监控降级策略 |

一致性提醒：

- 同步复制保证“**已提交的事务至少在某个备库持久化**”，**不保证备库已能读到**（除非 `remote_apply`）；
- **故障切换时要选择“已确认 LSN 最高”的备库**，否则会丢已确认事务；Patroni 等工具内置此逻辑（`maximum_lag_on_failover`、同步模式），见 [PG 复制、高可用与实战](#/pg/ops)；
- 异步备库切换**可能丢最近提交**（RPO > 0），要业务可接受或使用同步/Quorum。

### 复制槽（Replication Slot）

| 作用 | 说明 |
| --- | --- |
| **保证主库保留所需 WAL** | 槽记录消费者的 `restart_lsn`，主库**不会回收**该 LSN 之后的 WAL，备库掉线再回来也能继续（不依赖 `wal_keep_size` 的估算） |
| **逻辑槽还钉住 `catalog_xmin`** | 保证系统目录旧版本不被清理，以便解码历史变更 |

**风险（线上高发事故）**：

- **消费者永久失联的槽**（备库下线、订阅端宕机、旧的测试订阅未删）→ **WAL 无限堆积撑满磁盘，主库宕机**；同时钉住 xmin → **膨胀**，见 [PG MVCC 内部机制深入](#/pg/vacuum-internals)；
- 治理：
  - `max_slot_wal_keep_size`（PG13+）：给每个槽保留 WAL 设上限，**超过后槽失效**（消费者需要重建），用丢失同步换取主库安全；
  - 监控 `pg_replication_slots` 的 `active`、`retained_wal`；
  - 及时 `pg_drop_replication_slot` 清理无人消费的槽；
  - 逻辑槽与物理槽的**故障切换**：逻辑槽通常**不会自动同步到新主**（新版本引入了槽同步/failover 能力，需确认版本与配置），切换后订阅端可能要重建，设计逻辑复制方案时必须考虑。

### 备库的使用与监控

- **读扩展**：只读查询分担主库，但有**复制延迟**（见读一致性：[复制与一致性](#/distributed/replication)）；
- **监控**：`pg_stat_replication`（主库侧）、`pg_stat_wal_receiver`（备库侧）、`pg_last_wal_replay_lsn()`、`pg_last_xact_replay_timestamp()`；
- **延迟的常见原因**：备库 I/O 慢、重放是**单进程串行**（大事务、大量 DDL/VACUUM 产生的 WAL 回放慢；新版本对重放有部分并行化/预取优化 `recovery_prefetch`）、网络带宽、长查询冲突造成重放等待；
- **备库提升（promote）**：`pg_ctl promote` / `pg_promote()`，产生**新时间线**。

## 时间线与 pg_rewind

### 时间线（Timeline）

每次**恢复完成后提升为主库**（PITR 或 failover），PG 会**开启新的时间线**（`timeline ID` 加 1），WAL 文件名带时间线号，并生成 `.history` 文件记录分叉点。**时间线防止“不同历史的 WAL 混淆”**：

- 备库要跟随新主，必须从**分叉点之前的共同历史**开始，沿新时间线继续；
- **旧主**如果在切换时仍有未复制到备库的 WAL，它与新主**已经分叉**，**不能直接作为备库重新加入**（会数据不一致）。

### pg_rewind

**`pg_rewind`** 把分叉的旧主**“回退”到与新主一致的历史点**，再跟随新主，**避免重做全量基础备份**：

1. 找到分叉点；
2. 从目标（新主）**复制分叉点之后发生变化的数据块**（根据旧主 WAL 找出被修改的页），丢弃旧主多余变化；
3. 之后作为备库从新主追 WAL。

前提：旧主启用了 **`wal_log_hints = on` 或数据校验和（data checksums）**，且 WAL 历史完整（`full_page_writes = on`）。HA 工具（Patroni）会在旧主恢复时自动尝试 pg_rewind，失败再重建。

> [!WARNING] 旧主上“多出来的”事务会被丢弃
> 异步复制下，旧主崩溃前已向客户端确认但未传到新主的事务，在 pg_rewind 后**永久丢失**——这是异步复制 RPO>0 的体现。需要这类事务时要做对账或使用同步复制，见 [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)。

## 逻辑复制与逻辑解码

### 逻辑解码

**逻辑解码**把 WAL（物理变更）**解码成逻辑行变更**（INSERT/UPDATE/DELETE 的表与列值），要求 **`wal_level = logical`**：

- 通过**输出插件**呈现：内置 **`pgoutput`**（逻辑复制使用）、`test_decoding`（调试）、第三方 **`wal2json`**、**Debezium 使用 pgoutput/decoderbufs** 等；
- **按事务提交顺序**输出，只输出**已提交**事务；
- 需要**逻辑复制槽**保存消费进度（见上），**长事务会让解码延迟**（要等事务提交才能输出）。

### 发布/订阅（Publication / Subscription）

```sql
-- 发布端
CREATE PUBLICATION pub_orders FOR TABLE orders, order_items;       -- 或 FOR ALL TABLES
-- 订阅端（可以是不同大版本的 PG）
CREATE SUBSCRIPTION sub_orders
  CONNECTION 'host=pub-host dbname=app user=repl password=***'
  PUBLICATION pub_orders;            -- 自动先做初始数据同步（COPY），再持续接增量
```

| 特性 | 说明 |
| --- | --- |
| **按表选择** | 可只同步部分表；PG15+ 支持**行过滤（WHERE）与列列表** |
| **跨版本/跨平台** | 订阅端可为不同大版本、不同操作系统；常用于**大版本升级零停机迁移**与**数据集成** |
| **订阅端可写** | 订阅端的表可以有额外索引、触发器、甚至本地写（注意冲突） |
| **初始同步** | 创建订阅时对每表 COPY 全量，期间的变更暂存在槽，再追平 |

### 逻辑复制的限制与坑

| 限制/坑 | 说明与对策 |
| --- | --- |
| **`REPLICA IDENTITY`** | UPDATE/DELETE 要能在订阅端**定位到行**：默认用**主键**；没有主键的表需设 `REPLICA IDENTITY FULL`（性能差，WAL 变大）或指定唯一索引。**没有主键的表无法复制 UPDATE/DELETE** |
| **DDL 不复制** | 表结构变更需要**手动在两端同步**（先加订阅端列，再改发布端），否则复制中断；有第三方/新版本的 DDL 复制辅助，仍需谨慎 |
| **序列不复制** | 序列当前值不会同步；切换前要手动对齐（`setval`） |
| **大对象（LO）不复制**、**部分对象类型** | 视图/物化视图/外部表不复制数据 |
| **冲突** | 订阅端数据与发布端不一致（唯一键冲突、行不存在）会**使订阅 worker 报错并停止重试**，需要人工处理（跳过事务 `ALTER SUBSCRIPTION ... SKIP`、修复数据）；新版本有冲突日志与自动处理选项 |
| **性能** | 逻辑复制比物理复制开销大（解码 + 应用 SQL 级操作）；大事务延迟高；高写入吞吐场景用物理复制 |
| **WAL 保留与长事务** | 逻辑槽落后会堆积 WAL 与 catalog_xmin；监控延迟 |
| **故障切换** | 逻辑槽与订阅的切换要预先设计（槽同步/重建），否则 failover 后下游需重新同步 |

### 物理复制 vs 逻辑复制

| 维度 | 物理流复制 | 逻辑复制 |
| --- | --- | --- |
| **粒度** | **整个实例**（所有库所有对象） | **按表/按发布** |
| **版本要求** | 主备**同大版本**同架构 | 可跨大版本/跨平台 |
| **备库可写** | 否（只读热备） | 订阅端可写（表级） |
| **DDL/序列** | **自动同步**（WAL 全量） | **不同步**，需手动 |
| **开销与延迟** | 低，字节级重放 | 较高，解码与应用 |
| **用途** | **高可用、读扩展、灾备** | **在线升级迁移、数据集成/CDC、选择性同步、多主汇聚（谨慎）** |

CDC 到数仓/Flink/Kafka 的链路（Debezium 读取 PG 逻辑槽）见 [CDC 与实时数仓架构](#/bigdata/cdc)、[Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)。

## 备份与 PITR

### 备份类型

| 类型 | 做法 | 特点 |
| --- | --- | --- |
| **逻辑备份** | `pg_dump/pg_dumpall` 导出 SQL/自定义格式 | 跨版本、可选对象、可恢复到不同结构；**慢、恢复慢、是时间点快照（单个 pg_dump 内一致）**，不含 WAL，不能 PITR |
| **物理基础备份** | `pg_basebackup` / pgBackRest 拷贝数据目录（备份期间 WAL 保证一致性） | 速度快、恢复快；可配合 WAL 归档做 PITR；需要同大版本 |
| **WAL 归档** | `archive_mode=on` + `archive_command`（或 `archive_library`）把每个写满的 WAL 段拷到外部存储 | **与基础备份组合 = 可恢复到任意时间点** |
| **快照备份** | 存储/云盘快照 + WAL | 快速，需保证一致性（`pg_backup_start/stop` 或 crash-consistent 加 WAL） |

### PITR（基于时间点的恢复）

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="PITR 流程：定期做基础备份并持续归档 WAL；故障或误操作后，选择一个基础备份恢复数据目录，配置 restore_command 与恢复目标（时间、LSN、事务、命名还原点），启动后 PG 从基础备份的起点重放归档 WAL 到目标点，然后提升为新时间线并开始服务；恢复前要先停止应用写入防止继续破坏">
<rect class="b3" x="20" y="40" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="62" text-anchor="middle" dominant-baseline="middle">① 基础备份</text>
<text class="ts" x="85" y="84" text-anchor="middle">周期执行</text>
<rect class="b5" x="165" y="40" width="130" height="64" rx="8"/>
<text class="tb" x="230" y="62" text-anchor="middle" dominant-baseline="middle">② 持续归档 WAL</text>
<text class="ts" x="230" y="84" text-anchor="middle">archive_command</text>
<rect class="b1" x="310" y="40" width="140" height="64" rx="8"/>
<text class="tb" x="380" y="62" text-anchor="middle" dominant-baseline="middle">③ 选恢复点</text>
<text class="ts" x="380" y="84" text-anchor="middle">时间/LSN/事务</text>
<rect class="b4" x="465" y="40" width="140" height="64" rx="8"/>
<text class="tb" x="535" y="62" text-anchor="middle" dominant-baseline="middle">④ 恢复启动</text>
<text class="ts" x="535" y="84" text-anchor="middle">还原+重放 WAL</text>
<rect class="b2" x="620" y="40" width="120" height="64" rx="8"/>
<text class="tb" x="680" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 提升</text>
<text class="ts" x="680" y="84" text-anchor="middle">新时间线服务</text>
<line class="l" x1="150" y1="72" x2="165" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="295" y1="72" x2="310" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="72" x2="465" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="605" y1="72" x2="620" y2="72" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="720" height="154" rx="8"/>
<text class="th" x="32" y="144">恢复配置要点</text>
<text class="ts" x="380" y="170" text-anchor="middle">恢复配置：restore_command + recovery_target_time/_lsn/_xid/_name + recovery_target_action</text>
<text class="ts" x="380" y="192" text-anchor="middle">数据目录放 recovery.signal 后启动；到达目标后默认 pause，确认数据正确再 promote（避免恢复点选错造成二次错误）</text>
<text class="ts" x="380" y="214" text-anchor="middle">误操作恢复：恢复到“误操作之前”的时间点，到独立实例，导出所需数据再回灌，而不是直接覆盖生产</text>
<text class="ts" x="380" y="236" text-anchor="middle">RPO：取决于归档的及时性（archive_timeout）或使用流式归档（pg_receivewal）；RTO：取决于基础备份大小与待重放 WAL 量</text>
<text class="ta" x="380" y="262" text-anchor="middle">没有演练过的备份不可信：定期把备份恢复到测试环境、校验数据（pg_checksums、业务校验）并记录实际恢复耗时</text>
</svg>
<figcaption>图 3：基础备份 + WAL 归档的 PITR 流程</figcaption>
</figure>

### 备份工具与实践

| 工具 | 特点 |
| --- | --- |
| **pg_basebackup** | 官方内置，简单；全量；不含高级管理 |
| **pgBackRest** | 业界常用：**全量/差异/增量**、并行与压缩、**异地仓库（S3 等）**、加密、保留策略、校验、从备库备份、**异步归档**、一键 PITR |
| **Barman** | 备份服务器集中管理，支持流式归档、保留策略、远程恢复 |
| **WAL-G** | 云对象存储友好，增量/压缩/加密 |
| **云托管** | 云数据库的自动备份与 PITR（要了解其保留期与恢复粒度） |

要点：**备份保留与加密**（含合规）、**备份异地、不可变存储（防勒索）**、**从备库备份降低主库压力**、**监控归档积压与失败**（`pg_stat_archiver`，`archive_command` 失败会让 WAL 堆积在 pg_wal 撑满磁盘）、**备份校验与恢复演练**。

## 参数与监控速查

| 方向 | 关键参数/视图 |
| --- | --- |
| **WAL 与检查点** | `wal_level`、`max_wal_size`、`min_wal_size`、`checkpoint_timeout`、`checkpoint_completion_target`、`wal_compression`、`wal_buffers`、`synchronous_commit`、`full_page_writes`、`wal_log_hints` |
| **复制** | `max_wal_senders`、`max_replication_slots`、`wal_keep_size`、`max_slot_wal_keep_size`、`hot_standby`、`hot_standby_feedback`、`max_standby_streaming_delay`、`synchronous_standby_names`、`recovery_prefetch` |
| **归档** | `archive_mode`、`archive_command`、`archive_timeout`、`restore_command` |
| **监控视图** | `pg_stat_replication`、`pg_stat_wal_receiver`、`pg_replication_slots`、`pg_stat_archiver`、`pg_stat_bgwriter/pg_stat_checkpointer`、`pg_stat_wal`、`pg_control_checkpoint()` |
| **告警** | 复制延迟、槽 retained_wal、`pg_wal` 目录体积、归档失败、检查点被动触发比例、备份失败/过期、磁盘使用率 |

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `pg_wal` 目录暴涨撑满磁盘 | **失效复制槽**、归档失败堆积、`wal_keep_size` 过大、检查点异常 | 查槽与归档状态；设置 `max_slot_wal_keep_size`；修复 `archive_command` |
| 日志提示 `checkpoints are occurring too frequently` | `max_wal_size` 过小 | 调大 `max_wal_size`、`checkpoint_timeout` |
| 大批量更新后 WAL 暴增 | Full Page Write + 非 HOT 更新放大索引 | 拉长检查点间隔、`wal_compression`、分批、优化索引与 fillfactor |
| 备库延迟越来越大 | 重放慢（I/O/大事务/冲突）、网络、备库资源不足 | 看 replay_lag；拆大事务；升级备库磁盘；调整冲突策略 |
| 备库查询被取消 `canceling statement due to conflict with recovery` | 与重放冲突 | 调 `max_standby_streaming_delay`/`hot_standby_feedback`，专用报表备库 |
| 切换后旧主无法加入 | 时间线分叉 | `pg_rewind`（需 wal_log_hints/checksums）或重建 |
| 同步复制下主库写入全部卡住 | 同步备库全部不可用 | 增加备库/Quorum；有降级策略（谨慎改 `synchronous_standby_names`） |
| 逻辑订阅停止、日志报唯一键冲突 | 订阅端数据冲突/DDL 未同步 | 修复数据/同步结构，`SKIP` 事务，补全 REPLICA IDENTITY |
| 恢复后数据缺了几秒 | 异步复制/归档不及时 | 评估同步复制、`archive_timeout`、流式归档 |

## 运维清单

- [ ] 检查点参数是否按写入量调优（`max_wal_size`/`checkpoint_timeout`），`log_checkpoints` 是否开启并观察？
- [ ] 是否开启 `wal_compression`，是否评估过 `synchronous_commit` 的分级使用？
- [ ] 所有复制槽是否有监控与 `max_slot_wal_keep_size`，无主的槽是否及时清理？
- [ ] 备库是否监控延迟与冲突，读备库的业务是否能容忍延迟？
- [ ] 高可用切换是否选择已确认 LSN 最高的备库，旧主是否能 `pg_rewind`（`wal_log_hints`/checksums）？
- [ ] 逻辑复制的表是否都有主键/REPLICA IDENTITY，DDL 变更流程、序列同步、冲突处理是否有方案？
- [ ] 是否有基础备份 + 连续 WAL 归档，归档失败是否告警？
- [ ] 是否定期做 PITR 恢复演练并记录 RTO/RPO？备份是否异地、加密、不可变？

## 相关阅读

- [架构、WAL 与存储结构（PG）](#/pg/architecture)：WAL 与存储的基础
- [PG 复制、高可用与实战](#/pg/ops)：Patroni、流复制配置与实战
- [PG MVCC 内部机制深入](#/pg/vacuum-internals)：复制槽与 xmin 钉住
- [redo / undo / binlog（MySQL）](#/mysql/log)：MySQL 的日志体系对照
- [复制与一致性：主从、多主与无主](#/distributed/replication)：复制延迟与读一致性通用问题
- [CDC 与实时数仓架构](#/bigdata/cdc)：基于逻辑解码的数据集成

## 面试追问

> [!QUESTION] PostgreSQL 的 WAL 是怎么保证持久性与崩溃恢复的？
> 修改数据页之前必须先把对应的 WAL 记录持久化，事务提交时 WAL 提交记录 fsync 成功才返回，数据页由 bgwriter 和 checkpointer 异步落盘。崩溃后从最近检查点的 redo 起点重放 WAL，页头的 LSN 让重放幂等，Full Page Write 修复半写页。由于 MVCC，未提交事务的修改不可见，不需要 undo 阶段。

> [!QUESTION] 检查点的作用是什么？怎么调优？
> 把检查点前的脏页全部刷盘并写检查点记录，崩溃恢复只需从其 redo 点开始，也使旧 WAL 可回收。调优是在恢复时间和写 I/O 之间权衡：拉长 checkpoint_timeout 与调大 max_wal_size 能减少检查点次数，减少 Full Page Write 带来的 WAL 放大，checkpoint_completion_target 平滑 I/O，但崩溃恢复要重放更多 WAL；用 log_checkpoints 和统计视图观察被动检查点比例。

> [!QUESTION] 为什么需要 Full Page Write？
> 数据页 8KB 而磁盘原子写单位更小，崩溃可能只写一半造成 torn page，仅靠增量 WAL 无法修复。所以检查点后每个页第一次被修改时，WAL 里记录整页镜像，恢复时先覆盖整页再应用增量。代价是检查点后 WAL 放大，可用拉长检查点和 wal_compression 缓解。

> [!QUESTION] synchronous_commit 各级别有什么区别？
> off 不等本地刷盘，崩溃可能丢最近事务但不损坏库；local 等本地刷盘；remote_write 等备库写入系统缓冲；on 等本地刷盘并在配置同步备库时等备库持久化；remote_apply 等备库重放完成，备库可读到自己的写，延迟最高。可以按事务设置，关键事务强持久、非关键事务高吞吐。

> [!QUESTION] 复制槽有什么风险？怎么治理？
> 槽让主库保留消费者未接收的 WAL，并让逻辑槽钉住 catalog_xmin。消费者失联的槽会使 WAL 无限堆积撑满磁盘，还会钉住 xmin 造成膨胀。要设置 max_slot_wal_keep_size 限制保留量，监控 active 与 retained_wal，及时删除无人消费的槽，并设计切换后逻辑槽的处理。

> [!QUESTION] 物理复制与逻辑复制有什么区别？分别用在哪？
> 物理流复制按字节重放整个实例的 WAL，要求同大版本、备库只读、DDL 和序列自动同步、开销低，用于高可用、读扩展和灾备；逻辑复制解码成行变更按表发布订阅，可跨版本跨平台、可选表和行列、订阅端可写，但不同步 DDL 和序列、需要主键或 REPLICA IDENTITY、开销更高，用于在线升级迁移、数据集成和 CDC。

> [!QUESTION] 故障切换后旧主怎么处理？
> 备库提升会开启新时间线，旧主若有未复制的 WAL 就与新主分叉，不能直接作为备库加入。可用 pg_rewind 把旧主回退到分叉点并跟随新主，要求开启 wal_log_hints 或数据校验和；异步复制下旧主上已确认但未传到新主的事务会丢失，需要同步复制或对账。

> [!QUESTION] 怎么做到恢复到任意时间点？
> 定期做物理基础备份并持续归档 WAL。恢复时还原基础备份，配置 restore_command 和恢复目标（时间、LSN、事务或还原点），启动后从备份起点重放归档 WAL 到目标点，确认无误后提升为新时间线。误操作恢复应先恢复到独立实例导出数据再回灌，并定期演练验证 RTO 和 RPO。
