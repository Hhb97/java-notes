---
level: 深入
tags: [Flink, 状态, Checkpoint, Barrier, RocksDB, Savepoint, Exactly-Once, 两阶段提交]
summary: 深入 Flink 的状态管理与容错机制：Keyed/Operator 状态与状态后端、基于 Barrier 的分布式快照（Chandy-Lamport）、对齐与非对齐 Checkpoint、Savepoint，以及端到端 Exactly-Once 如何依靠可重放 Source 与两阶段提交 Sink 实现。
---

# Flink 状态、Checkpoint 与 Exactly-Once

> [!ABSTRACT] 核心要点
> - **状态（State）** 是 Flink 区别于无状态处理的关键：算子在处理数据时**记住历史**（计数、去重集合、窗口缓冲、机器学习模型）。状态必须**可容错、可扩缩容、可迁移**。
> - **Checkpoint** 是基于 **Barrier 的异步分布式快照**（Chandy-Lamport 变体）：Barrier 随数据流动，每个算子在收到 Barrier 时**快照自身状态**，所有算子快照完成即构成一次全局一致快照；故障时回滚到最近快照并**让 Source 从对应位点重放**。
> - Flink **内部**的 Exactly-Once 靠 Checkpoint；**端到端** Exactly-Once 还需要 **Source 可重放 + Sink 幂等或事务（两阶段提交）**。
> - **状态后端**：`HashMapStateBackend`（堆内存，快，受堆大小限制）与 `EmbeddedRocksDBStateBackend`（本地磁盘，**大状态**，支持**增量 Checkpoint**）。大状态选 RocksDB。
> - 运维要点：**为每个有状态算子设置 uid**、状态 **TTL**、合适的 Checkpoint 间隔与超时、**Savepoint** 用于升级与迁移。

## 状态分类

| 类型 | 作用域 | 例子 |
| --- | --- | --- |
| **Keyed State（键控状态）** | 只能在 `keyBy` 之后使用，**每个 key 一份独立状态**；随 key 重分区迁移（Key Group） | 用户累计金额、窗口缓冲、去重 Set |
| **Operator State（算子状态）** | 每个并行子任务一份，与 key 无关 | Kafka Source 的 offset、Sink 的缓冲 |
| **Broadcast State** | 广播流的状态，所有子任务**相同副本** | 动态规则、配置下发 |

### Keyed State 的类型

| 类型 | 用途 |
| --- | --- |
| `ValueState<T>` | 单个值（最近一次时间、累计和） |
| `ListState<T>` | 列表（窗口内的明细，需要控制大小） |
| `MapState<K,V>` | 映射（去重表、子维度计数）——**RocksDB 下按 entry 读写，比 ValueState 存大 Map 更高效** |
| `ReducingState` / `AggregatingState` | 自动聚合 |

```java
public class DedupFunction extends KeyedProcessFunction<String, Event, Event> {
    private MapState<String, Boolean> seen;

    @Override public void open(Configuration c) {
        var desc = new MapStateDescriptor<>("seen", String.class, Boolean.class);
        desc.enableTimeToLive(StateTtlConfig.newBuilder(Time.hours(24))              // 状态 TTL：24 小时后过期，避免无限增长
                .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
                .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
                .cleanupInRocksdbCompactFilter(1000).build());                       // RocksDB 后端在 compaction 时清理
        seen = getRuntimeContext().getMapState(desc);
    }
    @Override public void processElement(Event e, Context ctx, Collector<Event> out) throws Exception {
        if (!seen.contains(e.getId())) { seen.put(e.getId(), true); out.collect(e); }   // 首次出现才输出
    }
}
```

> [!WARNING] 状态无限增长是 Flink 作业的头号隐患
> 去重集合、会话、无过期的 Map 都会随时间膨胀，最终 OOM 或 Checkpoint 越来越慢。对策：**状态 TTL**、定时器主动清理、窗口自动清理、SQL 里设置 `table.exec.state.ttl`。

## 状态后端与存储

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="HashMapStateBackend 与 RocksDB 状态后端的对比：状态存放位置与 Checkpoint 数据流向">
<rect class="b1" x="20" y="20" width="340" height="170" rx="12"/>
<text class="th" x="190" y="44" text-anchor="middle">HashMapStateBackend</text>
<text class="ts" x="190" y="70" text-anchor="middle">运行时状态：TaskManager 堆内存对象</text>
<text class="ts" x="190" y="92" text-anchor="middle">读写：直接对象访问，极快</text>
<text class="ts" x="190" y="114" text-anchor="middle">限制：状态 ≤ 堆内存；GC 压力大</text>
<text class="ts" x="190" y="136" text-anchor="middle">Checkpoint：全量序列化到远程存储</text>
<text class="ta" x="190" y="170" text-anchor="middle">适合：小状态、低延迟</text>
<rect class="b5" x="380" y="20" width="340" height="170" rx="12"/>
<text class="th" x="550" y="44" text-anchor="middle">EmbeddedRocksDBStateBackend</text>
<text class="ts" x="550" y="70" text-anchor="middle">运行时状态：本地磁盘 RocksDB（堆外）</text>
<text class="ts" x="550" y="92" text-anchor="middle">读写：序列化/反序列化 + 磁盘，较慢</text>
<text class="ts" x="550" y="114" text-anchor="middle">限制：仅受磁盘容量；单 key/value ≤ 2GB</text>
<text class="ts" x="550" y="136" text-anchor="middle">Checkpoint：支持增量（上传新增 SST 文件）</text>
<text class="ta" x="550" y="170" text-anchor="middle">适合：大状态（GB~TB）、生产常用</text>
<rect class="b3" x="20" y="214" width="700" height="50" rx="10"/>
<text class="tb" x="370" y="234" text-anchor="middle" dominant-baseline="middle">Checkpoint 存储（HDFS / S3 / OSS / 共享文件系统）：持久化快照，故障恢复时下载并加载到各 TaskManager</text>
<text class="ts" x="370" y="254" text-anchor="middle">Flink 2.x 引入存算分离的状态后端（状态放远端存储）以应对超大状态，具体特性以版本文档为准</text>
<line class="ld" x1="190" y1="190" x2="190" y2="214"/>
<line class="ld" x1="550" y1="190" x2="550" y2="214"/>
</svg>
<figcaption>图 1：堆状态后端 vs RocksDB 状态后端</figcaption>
</figure>

| 项目 | HashMap（堆） | RocksDB |
| --- | --- | --- |
| 状态容量 | 受 JVM 堆限制 | 受本地磁盘限制（TB 级） |
| 访问速度 | **快**（对象引用） | 慢 1~2 个数量级（序列化 + LSM 读写，有块缓存） |
| GC | 状态多时 GC 重 | 状态在堆外，GC 轻 |
| 增量 Checkpoint | 不支持 | **支持**（大状态必备） |
| 调优 | 堆大小、GC | 块缓存、写缓冲、compaction 线程、本地 SSD、managed memory |

选择原则：**状态小（≤ 几 GB）且追求延迟 → 堆；状态大或增长不可控 → RocksDB**。RocksDB 本地目录要用 **SSD**。

## Checkpoint：分布式快照

### 目标

在不停止数据处理的前提下，得到**所有算子状态与输入位点的全局一致快照**。故障恢复时，所有算子回到快照，Source 从快照记录的位点重放，保证“**每条数据对状态的影响恰好一次**”。

### Barrier 机制

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="Checkpoint Barrier 在数据流中传播，算子收到 Barrier 后快照状态并向下游转发">
<rect class="b3" x="20" y="130" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="152" text-anchor="middle" dominant-baseline="middle">Source</text>
<text class="ts" x="75" y="172" text-anchor="middle">记录 offset</text>
<rect class="b1" x="200" y="130" width="120" height="60" rx="8"/>
<text class="tb" x="260" y="152" text-anchor="middle" dominant-baseline="middle">算子 A</text>
<text class="ts" x="260" y="172" text-anchor="middle">快照 State A</text>
<rect class="b1" x="390" y="130" width="120" height="60" rx="8"/>
<text class="tb" x="450" y="152" text-anchor="middle" dominant-baseline="middle">算子 B</text>
<text class="ts" x="450" y="172" text-anchor="middle">快照 State B</text>
<rect class="b2" x="580" y="130" width="110" height="60" rx="8"/>
<text class="tb" x="635" y="152" text-anchor="middle" dominant-baseline="middle">Sink</text>
<text class="ts" x="635" y="172" text-anchor="middle">预提交</text>
<line class="l" x1="130" y1="160" x2="200" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="160" x2="390" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="160" x2="580" y2="160" marker-end="url(#arr)"/>
<rect class="b4" x="150" y="146" width="10" height="28" rx="2"/>
<text class="ta" x="155" y="136" text-anchor="middle">B₍n₎</text>
<rect class="b" x="165" y="150" width="8" height="20" rx="2"/>
<rect class="b" x="177" y="150" width="8" height="20" rx="2"/>
<rect class="b" x="125" y="150" width="8" height="20" rx="2"/>
<rect class="b" x="135" y="150" width="8" height="20" rx="2"/>
<rect class="b3" x="76" y="20" width="108" height="46" rx="8"/>
<text class="tb" x="130" y="38" text-anchor="middle" dominant-baseline="middle">JobManager</text>
<text class="ts" x="130" y="56" text-anchor="middle">Checkpoint 协调器</text>
<line class="la" x1="75" y1="66" x2="75" y2="130" marker-end="url(#arr-a)"/>
<text class="ta" x="40" y="104" text-anchor="middle">①注入</text>
<text class="ts" x="260" y="230" text-anchor="middle">②收到 Barrier：</text>
<text class="ts" x="260" y="248" text-anchor="middle">快照状态（异步上传）</text>
<text class="ts" x="260" y="266" text-anchor="middle">并把 Barrier 转发下游</text>
<text class="ts" x="450" y="230" text-anchor="middle">多输入时要“对齐”：</text>
<text class="ts" x="450" y="248" text-anchor="middle">先到的通道数据缓存等待</text>
<text class="ts" x="450" y="266" text-anchor="middle">所有通道 Barrier 到齐再快照</text>
<text class="ts" x="635" y="230" text-anchor="middle">③ 全部算子确认 →</text>
<text class="ts" x="635" y="248" text-anchor="middle">Checkpoint 完成</text>
<text class="ts" x="635" y="266" text-anchor="middle">通知 Sink 提交事务</text>
<text class="ts" x="380" y="310" text-anchor="middle">Barrier n 把数据流切成“属于 Checkpoint n 之前”和“之后”两部分；各算子状态对应同一个逻辑时刻</text>
</svg>
<figcaption>图 2：Barrier 随数据流动，算子在收到 Barrier 时快照状态</figcaption>
</figure>

**流程**：

1. JobManager 的 **Checkpoint Coordinator** 周期性（`checkpoint interval`）向所有 **Source** 注入 **Barrier n**；
2. Source 收到后**记录自己的位点（如 Kafka offset）**，把 Barrier 插入输出流；
3. 算子收到 Barrier：
   - 单输入：立即**快照自己的状态**（先同步做本地快照点，再**异步**上传到远程存储），并把 Barrier 向下游广播；
   - 多输入：**Barrier 对齐**——先到 Barrier 的输入通道被暂时阻塞（数据缓存），等所有输入通道的 Barrier 都到达，再快照并继续；
4. **Sink** 完成预提交（见下节）；
5. 所有算子向 JobManager 确认 → **Checkpoint n 完成**，位点与状态元数据写入存储；之后可通知算子（`notifyCheckpointComplete`），Sink 此时提交事务。

### 对齐 vs 非对齐（Unaligned）

| | 对齐（Aligned，默认） | **非对齐（Unaligned）** |
| --- | --- | --- |
| 机制 | Barrier 对齐时，先到的通道**阻塞等待** | Barrier **越过**缓冲数据，**把飞行中的数据（in-flight）也写入快照** |
| 优点 | 快照小，不含网络数据 | **反压严重时 Checkpoint 仍能快速完成** |
| 缺点 | 反压时对齐等待长，Checkpoint 超时 | 快照更大（含 in-flight 数据），恢复需重新处理这些数据 |
| 使用 | 默认 | 反压导致 Checkpoint 超时的作业；可配合 `aligned-checkpoint-timeout`（先尝试对齐，超时自动切非对齐） |

### 增量 Checkpoint 与异步快照

- **异步**：快照的“同步阶段”只做很短的元数据与引用固定，上传在后台进行，**不阻塞数据处理**；
- **增量（仅 RocksDB）**：只上传相对上一次新增/变更的 SST 文件，大状态下 Checkpoint 时间和存储流量大幅降低；恢复时需要合并多个增量；
- **Changelog 状态后端**（较新）：持续写变更日志，使 Checkpoint 更快更稳定，代价是额外写入，按版本支持情况使用。

### 关键参数

```java
CheckpointConfig cc = env.getCheckpointConfig();
env.enableCheckpointing(60_000, CheckpointingMode.EXACTLY_ONCE);       // 间隔 60s
cc.setMinPauseBetweenCheckpoints(30_000);                              // 两次之间至少间隔 30s，避免 Checkpoint 连着做占满资源
cc.setCheckpointTimeout(10 * 60_000);                                  // 超时视为失败
cc.setTolerableCheckpointFailureNumber(3);                             // 容忍连续失败次数，超出则作业失败
cc.setMaxConcurrentCheckpoints(1);
cc.enableUnalignedCheckpoints();                                       // 反压严重时启用
cc.setExternalizedCheckpointCleanup(ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION);   // 取消作业时保留，便于手动恢复
env.setStateBackend(new EmbeddedRocksDBStateBackend(true));            // true = 增量
cc.setCheckpointStorage("s3://bucket/flink/checkpoints");
```

| 参数 | 建议 |
| --- | --- |
| 间隔 | 秒级~分钟级（常见 30s~5min）：间隔越短恢复时重放越少但开销越大；与**端到端延迟**有关（事务型 Sink 在 Checkpoint 完成时才提交） |
| 超时 | 大于正常耗时的数倍；持续超时说明反压或状态过大 |
| 失败容忍 | 允许偶发失败，避免一次网络抖动导致作业重启 |
| 保留策略 | 保留最近 N 个（`state.checkpoints.num-retained`）|

### 故障恢复

1. 检测到失败（Task 异常/TaskManager 丢失）；
2. 根据**重启策略**（固定延迟、失败率、指数退避）重启；
3. 从**最近一次完成的 Checkpoint**恢复：各算子加载状态，Source 回到记录的位点；
4. 重放该位点之后的数据，**状态与输出保持一致**。

可以用 **局部恢复（Local Recovery）** 在 TaskManager 本地保留一份快照，加快恢复；**Region Failover** 只重启受影响的子图，而不是整个作业。

## Savepoint

**Savepoint** 是**手动触发的、用于运维的快照**：

| | Checkpoint | Savepoint |
| --- | --- | --- |
| 触发 | 系统周期性 | **用户手动**（升级、迁移前） |
| 用途 | 故障自动恢复 | **有计划的停机/升级/迁移/扩缩容/A-B 测试** |
| 格式 | 为恢复速度优化，可能是增量 | **标准、可移植**格式，保证跨版本兼容 |
| 清理 | 系统自动 | 用户管理 |

```bash
flink stop --savepointPath s3://bucket/sp --drain <jobId>        # 优雅停止：触发 savepoint 并处理完在途数据
flink run -s s3://bucket/sp/savepoint-xxx -d job.jar              # 从 savepoint 恢复
# 改并行度：从 savepoint 以新并行度恢复；状态按 Key Group 重新分配
```

> [!WARNING] 升级作业必须给算子设置 uid
> 状态通过**算子 ID**与快照对应。没有显式 `uid`，Flink 按拓扑自动生成 ID，**修改作业结构后状态无法匹配，恢复失败或状态丢失**。对每个有状态算子 `.uid("order-agg")`，并为 Source/Sink 同样设置。需要删除状态时用 `--allowNonRestoredState`。

状态演进（Schema Evolution）：POJO/Avro 类型支持字段增减；**自定义序列化**要做好兼容；不要依赖 Kryo 做长期状态序列化。

## 端到端 Exactly-Once

### 三个层次

| 语义 | 含义 |
| --- | --- |
| At-most-once | 最多一次：可能丢 |
| At-least-once | 至少一次：可能重复（Checkpoint 间隔内重放） |
| **Exactly-once** | 恰好一次：每条数据对**状态**和**输出**的影响恰好一次 |

**Flink 内部状态的 Exactly-Once 靠 Checkpoint**。端到端（含外部系统）则需要三件事：

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="端到端 Exactly-Once 的三个条件：可重放的 Source、Flink Checkpoint、幂等或事务 Sink">
<rect class="b1" x="20" y="60" width="200" height="110" rx="12"/>
<text class="th" x="120" y="84" text-anchor="middle">① 可重放的 Source</text>
<text class="ts" x="120" y="110" text-anchor="middle">Kafka：offset 随 Checkpoint 保存</text>
<text class="ts" x="120" y="130" text-anchor="middle">失败后回到该位点重新读取</text>
<text class="ts" x="120" y="150" text-anchor="middle">（不可重放源无法精确一次）</text>
<rect class="b3" x="270" y="60" width="200" height="110" rx="12"/>
<text class="th" x="370" y="84" text-anchor="middle">② Flink Checkpoint</text>
<text class="ts" x="370" y="110" text-anchor="middle">算子状态 + Source 位点</text>
<text class="ts" x="370" y="130" text-anchor="middle">一致性快照</text>
<text class="ts" x="370" y="150" text-anchor="middle">保证内部处理恰好一次</text>
<rect class="b2" x="520" y="60" width="200" height="110" rx="12"/>
<text class="th" x="620" y="84" text-anchor="middle">③ 幂等 / 事务 Sink</text>
<text class="ts" x="620" y="110" text-anchor="middle">幂等写：按主键 upsert，</text>
<text class="ts" x="620" y="130" text-anchor="middle">重复写入结果相同</text>
<text class="ts" x="620" y="150" text-anchor="middle">或两阶段提交事务</text>
<line class="l" x1="220" y1="115" x2="270" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="115" x2="520" y2="115" marker-end="url(#arr)"/>
<text class="ts" x="370" y="226" text-anchor="middle">三者缺一不可：任何一环退化，端到端就退化为至少一次</text>
</svg>
<figcaption>图 3：端到端 Exactly-Once 的三个必要条件</figcaption>
</figure>

### 两阶段提交（2PC）Sink

事务型 Sink（Kafka、部分数据库/文件系统）与 Checkpoint 协同，实现“**Checkpoint 成功才对外可见**”：

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="两阶段提交 Sink 与 Checkpoint 的时序：开启事务、预提交、全部确认后提交、失败则回滚">
<rect class="b3" x="40" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="105" y="37" text-anchor="middle" dominant-baseline="middle">JobManager</text>
<rect class="b1" x="320" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="385" y="37" text-anchor="middle" dominant-baseline="middle">Sink 算子</text>
<rect class="b5" x="570" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="635" y="37" text-anchor="middle" dominant-baseline="middle">外部系统(Kafka)</text>
<line class="ld" x1="105" y1="54" x2="105" y2="310"/>
<line class="ld" x1="385" y1="54" x2="385" y2="310"/>
<line class="ld" x1="635" y1="54" x2="635" y2="310"/>
<text class="ts" x="395" y="80" text-anchor="start">开启事务 txn-n，之后的数据写入该事务（对消费者不可见）</text>
<line class="l" x1="385" y1="94" x2="635" y2="94" marker-end="url(#arr)"/>
<line class="l" x1="105" y1="132" x2="385" y2="132" marker-end="url(#arr)"/>
<text class="ts" x="245" y="124" text-anchor="middle">① Barrier n 到来</text>
<line class="l" x1="385" y1="170" x2="635" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="510" y="162" text-anchor="middle">② 预提交：flush，事务保持待定</text>
<text class="ts" x="395" y="196" text-anchor="start">状态快照中保存“事务句柄”，随 Checkpoint 持久化</text>
<line class="l" x1="385" y1="218" x2="105" y2="218" marker-end="url(#arr)"/>
<text class="ts" x="245" y="210" text-anchor="middle">③ 向 JM 确认快照完成</text>
<line class="la" x1="105" y1="250" x2="385" y2="250" marker-end="url(#arr-a)"/>
<text class="ta" x="245" y="242" text-anchor="middle">④ 所有算子确认 → Checkpoint n 完成</text>
<line class="la" x1="385" y1="284" x2="635" y2="284" marker-end="url(#arr-a)"/>
<text class="ta" x="510" y="276" text-anchor="middle">⑤ 提交事务 txn-n，数据对外可见</text>
<text class="ts" x="370" y="322" text-anchor="middle">失败恢复：根据 Checkpoint 中保存的事务句柄，重新提交已完成的、回滚未完成的 → 不重不丢</text>
</svg>
<figcaption>图 4：两阶段提交 Sink 与 Checkpoint 的协同</figcaption>
</figure>

要点：

1. **预提交**：Barrier 到达 Sink 时，把当前事务内数据刷到外部系统但**不提交**；
2. **提交**：Checkpoint **全局完成**后，收到 `notifyCheckpointComplete` 才提交事务；
3. **恢复**：事务句柄保存在状态里；重启后对“Checkpoint 已完成”的事务**重试提交**（要求提交幂等），对“未完成”的**回滚**；
4. **代价**：数据在 Checkpoint 完成后才可见 → **端到端延迟 ≥ Checkpoint 间隔**；
5. Kafka 事务需要下游消费者设置 `isolation.level=read_committed`，并注意 Kafka 事务超时（`transaction.timeout.ms`）要**大于** Checkpoint 间隔 + 恢复时间，见 [Kafka 副本与可靠性](#/mw/kafka-reliability)。

### 幂等 Sink（更简单的方案）

若外部系统支持**按主键覆盖写**（MySQL/PG `INSERT ... ON CONFLICT DO UPDATE`、ES 指定 `_id`、Doris/ClickHouse 的主键/ReplacingMergeTree、Redis SET），把输出设计成**确定性且带唯一键**，即使重放产生重复写入，结果也一致——**用至少一次 + 幂等达到效果上的精确一次**，实现简单、延迟低。

```sql
-- 以窗口+维度作为主键 upsert，迟到数据的更新与重放都幂等
INSERT INTO shop_gmv_1min (shop_id, window_start, gmv) VALUES (?, ?, ?)
ON CONFLICT (shop_id, window_start) DO UPDATE SET gmv = EXCLUDED.gmv;
```

### 各 Sink 的一致性

| Sink | 方式 |
| --- | --- |
| Kafka | 事务（2PC）实现 Exactly-Once；或至少一次 + 下游去重 |
| JDBC（MySQL/PG） | 幂等 upsert；或 XA 事务（不推荐，性能差） |
| Elasticsearch | 指定文档 ID 幂等写入 |
| 文件/数据湖（Iceberg/Paimon/Hudi） | 提交快照/事务与 Checkpoint 绑定，天然 Exactly-Once，见 [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |
| Doris / StarRocks | Stream Load 两阶段提交 / 主键模型幂等，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |

## 状态与 Checkpoint 的常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| Checkpoint 越来越慢直至超时 | **反压**（Barrier 被阻塞）、状态过大、存储慢 → 查反压、用 RocksDB 增量、非对齐 Checkpoint、加资源 |
| 状态无限增长 | 无 TTL 的去重/会话/窗口 → TTL、定时器清理 |
| 恢复后数据重复 | Sink 非幂等且非事务 → 改幂等 upsert 或 2PC |
| 修改代码后无法从 Savepoint 恢复 | 没有设置 uid、改了状态类型/序列化 → 固定 uid、兼容的状态演进 |
| RocksDB 性能差 | 磁盘慢、块缓存小、compaction 压力 → SSD、调整内存配置、分散热点 key |
| 状态数据倾斜 | 热点 key → 打散预聚合；检查 Key Group 分布 |
| Kafka 事务 Sink 失败 `ProducerFenced`/事务超时 | 事务超时小于恢复时间；`transactional.id` 冲突 → 调大事务超时 |
| Checkpoint 间隔过短导致吞吐下降 | 同步阶段与 IO 开销 → 拉长间隔，`minPause` |

## 面试追问

> [!QUESTION] Flink 的 Checkpoint 机制是怎样的？
> 基于 Chandy-Lamport 的异步分布式快照：协调器周期性向 Source 注入 Barrier，Barrier 随数据流传播，算子收到 Barrier 就快照自己的状态并向下转发，多输入需要对齐；全部算子确认后 Checkpoint 完成。故障时回滚到最近快照，Source 从记录位点重放，保证状态一致。

> [!QUESTION] 对齐与非对齐 Checkpoint 有什么区别？
> 对齐 Checkpoint 在多输入算子上等待所有通道的 Barrier 到齐，先到的通道被阻塞，反压严重时会超时；非对齐让 Barrier 越过缓冲数据，把飞行中的数据一并写入快照，反压下仍能完成，代价是快照更大。

> [!QUESTION] Flink 如何实现端到端 Exactly-Once？
> 三个条件：Source 可重放（如 Kafka 位点保存在 Checkpoint 中）、Flink 内部 Checkpoint 保证状态一致、Sink 幂等或事务。事务 Sink 用两阶段提交：Barrier 到达时预提交，Checkpoint 全部完成后提交，失败则按保存的事务句柄恢复提交或回滚。

> [!QUESTION] Checkpoint 和 Savepoint 有什么区别？
> Checkpoint 由系统周期触发、用于故障自动恢复，可使用增量格式；Savepoint 由用户手动触发，格式标准可移植，用于升级、迁移、改并行度，需用户自己管理。

> [!QUESTION] 状态后端怎么选？
> 状态小且要求低延迟用堆状态后端，速度最快但受内存和 GC 限制；状态大或持续增长用 RocksDB，状态在本地磁盘，支持增量 Checkpoint，但读写需要序列化、延迟更高。RocksDB 要使用 SSD 并合理配置内存。

> [!QUESTION] 为什么要给算子设置 uid？
> 状态靠算子 ID 与快照匹配。没有显式 uid 时 ID 由拓扑自动生成，作业结构变化后会匹配不上，导致无法恢复或状态丢失。给有状态算子和 Source/Sink 设置固定 uid 才能安全升级。
