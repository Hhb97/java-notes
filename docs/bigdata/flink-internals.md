---
level: 深入
tags: [Flink, 执行图, Mailbox, 网络栈, 信用流控, 内存模型, Key Group, RocksDB, 调度]
summary: 打开 Flink 的黑盒：从 StreamGraph 到 ExecutionGraph 的转换与算子链、Task 的 Mailbox 单线程模型、网络栈与信用流控、TaskManager 内存模型、Key Group 与状态重分布、RocksDB 状态后端的内部结构与调优。
---

# Flink 内部机制：执行图、网络栈、内存与 Key Group

> [!ABSTRACT] 核心要点
> - 一个作业经历 **StreamGraph → JobGraph（算子链合并）→ ExecutionGraph（按并行度展开）→ 物理 Task**；理解“链化”与“Slot 共享”就理解了资源与性能的大部分问题。
> - 每个 Task 由**单个线程 + Mailbox** 驱动：数据处理、Checkpoint 触发、定时器回调都在**同一线程**串行执行，所以算子内无需加锁，但**任何阻塞都会卡住整个 Task**。
> - 网络层是 **Netty + 基于信用的流控**：下游按 Buffer 数告知上游“信用”，上游才发送；这就是**反压的物理来源**；Buffer Debloating 可自动缩小飞行数据量，缩短 Checkpoint 对齐。
> - **TaskManager 内存**分为框架堆、任务堆、**托管内存**（RocksDB/排序）、网络内存、JVM 开销；用 RocksDB 时托管内存决定性能与稳定性。
> - **Key Group** 是状态的最小重分配单元：`keyGroup = hash(key) % maxParallelism`；**maxParallelism 一旦定下就不能随意改**（改了无法从旧快照恢复），它决定了日后最大可扩并行度。

> [!NOTE] 版本
> 内部实现随版本演进（例如 Flink 1.14+ 的 Buffer Debloating、1.15+ 的统一 Sink API、2.x 的存算分离状态后端）。本页描述稳定的架构与关键机制，具体类名与参数以所用版本为准。

## 从代码到物理执行

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="作业的四层图：StreamGraph 是用户算子 DAG，JobGraph 把可链化算子合并成 JobVertex，ExecutionGraph 按并行度展开成 ExecutionVertex，最后部署为 TaskManager 上的 Task">
<rect class="b1" x="20" y="20" width="170" height="320" rx="10"/>
<text class="th" x="105" y="42" text-anchor="middle">StreamGraph</text>
<text class="ts" x="105" y="62" text-anchor="middle">客户端生成</text>
<rect class="b" x="40" y="80" width="130" height="34" rx="6"/>
<text class="tm" x="105" y="97" text-anchor="middle" dominant-baseline="middle">Source</text>
<rect class="b" x="40" y="132" width="130" height="34" rx="6"/>
<text class="tm" x="105" y="149" text-anchor="middle" dominant-baseline="middle">Map</text>
<rect class="b" x="40" y="184" width="130" height="34" rx="6"/>
<text class="tm" x="105" y="201" text-anchor="middle" dominant-baseline="middle">Filter</text>
<rect class="b" x="40" y="236" width="130" height="34" rx="6"/>
<text class="tm" x="105" y="253" text-anchor="middle" dominant-baseline="middle">KeyedProcess</text>
<rect class="b" x="40" y="288" width="130" height="34" rx="6"/>
<text class="tm" x="105" y="305" text-anchor="middle" dominant-baseline="middle">Sink</text>
<line class="l" x1="105" y1="114" x2="105" y2="132" marker-end="url(#arr)"/>
<line class="l" x1="105" y1="166" x2="105" y2="184" marker-end="url(#arr)"/>
<line class="l" x1="105" y1="218" x2="105" y2="236" marker-end="url(#arr)"/>
<line class="l" x1="105" y1="270" x2="105" y2="288" marker-end="url(#arr)"/>
<rect class="b3" x="230" y="20" width="170" height="320" rx="10"/>
<text class="th" x="315" y="42" text-anchor="middle">JobGraph</text>
<text class="ts" x="315" y="62" text-anchor="middle">合并算子链</text>
<rect class="b5" x="250" y="80" width="130" height="138" rx="6"/>
<text class="tb" x="315" y="102" text-anchor="middle" dominant-baseline="middle">JobVertex 1</text>
<text class="ts" x="315" y="130" text-anchor="middle">Source → Map</text>
<text class="ts" x="315" y="150" text-anchor="middle">→ Filter（链化）</text>
<text class="ts" x="315" y="178" text-anchor="middle">同线程执行</text>
<text class="ts" x="315" y="198" text-anchor="middle">无序列化/网络</text>
<rect class="b5" x="250" y="236" width="130" height="86" rx="6"/>
<text class="tb" x="315" y="258" text-anchor="middle" dominant-baseline="middle">JobVertex 2</text>
<text class="ts" x="315" y="280" text-anchor="middle">KeyedProcess → Sink</text>
<text class="ts" x="315" y="300" text-anchor="middle">（keyBy 后）</text>
<line class="la" x1="315" y1="218" x2="315" y2="236" marker-end="url(#arr-a)"/>
<text class="ta" x="372" y="230" text-anchor="start">Shuffle</text>
<rect class="b2" x="440" y="20" width="170" height="320" rx="10"/>
<text class="th" x="525" y="42" text-anchor="middle">ExecutionGraph</text>
<text class="ts" x="525" y="62" text-anchor="middle">JobManager 按并行度展开</text>
<rect class="b" x="460" y="80" width="130" height="28" rx="6"/>
<text class="tm" x="525" y="94" text-anchor="middle" dominant-baseline="middle">V1 [0/3]</text>
<rect class="b" x="460" y="114" width="130" height="28" rx="6"/>
<text class="tm" x="525" y="128" text-anchor="middle" dominant-baseline="middle">V1 [1/3]</text>
<rect class="b" x="460" y="148" width="130" height="28" rx="6"/>
<text class="tm" x="525" y="162" text-anchor="middle" dominant-baseline="middle">V1 [2/3]</text>
<rect class="b" x="460" y="236" width="130" height="28" rx="6"/>
<text class="tm" x="525" y="250" text-anchor="middle" dominant-baseline="middle">V2 [0/2]</text>
<rect class="b" x="460" y="270" width="130" height="28" rx="6"/>
<text class="tm" x="525" y="284" text-anchor="middle" dominant-baseline="middle">V2 [1/2]</text>
<text class="ts" x="525" y="320" text-anchor="middle">全连接（keyBy）按 key 哈希分发</text>
<rect class="b4" x="650" y="20" width="110" height="320" rx="10"/>
<text class="th" x="705" y="42" text-anchor="middle">物理 Task</text>
<text class="ts" x="705" y="62" text-anchor="middle">部署到 Slot</text>
<text class="ts" x="705" y="100" text-anchor="middle">TM1: V1[0] V2[0]</text>
<text class="ts" x="705" y="124" text-anchor="middle">TM2: V1[1] V2[1]</text>
<text class="ts" x="705" y="148" text-anchor="middle">TM3: V1[2]</text>
<text class="ts" x="705" y="190" text-anchor="middle">Slot 共享：</text>
<text class="ts" x="705" y="210" text-anchor="middle">同一流水线的</text>
<text class="ts" x="705" y="230" text-anchor="middle">不同算子 Task</text>
<text class="ts" x="705" y="250" text-anchor="middle">可放同一 Slot</text>
<line class="l" x1="190" y1="180" x2="230" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="180" x2="440" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="180" x2="650" y2="180" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：从用户代码到物理 Task 的四层图</figcaption>
</figure>

### 算子链（Operator Chain）

两个相邻算子能链化的条件：**并行度相同、数据传输是 Forward（One-to-One）、同一个 Slot 共享组、链化策略允许**（`startNewChain()` / `disableChaining()` 可控制）。链化后：

- 在**同一个线程**里直接方法调用传递对象，**省去序列化、反序列化、网络与线程切换**；
- 链内的 `collector.collect(x)` 就是一次函数调用，所以链化是 Flink 最重要的性能优化之一；
- 代价：链内任一算子慢，整条链都慢；排查瓶颈时常需 `disableChaining()` 拆开，才能在 UI 里看清**每个算子的忙碌度**。

### Slot 与资源

- **Slot** 是 TaskManager 资源的切片，**隔离内存（托管内存按 Slot 平分），不隔离 CPU**；
- **Slot 共享**：默认同一作业内的所有算子可共享 Slot，使“一个 Slot 持有整条流水线的一个并行实例”，**作业需要的 Slot 数 = 最大并行度**（而不是所有 Task 数之和）；重算子可放入独立共享组做资源隔离；
- 调度：`Scheduler` 按 **Pipelined Region**（通过流水线边相连的 Task 集合）整体调度与恢复；**Region Failover** 只重启受影响的 Region；
- **自适应调度器 / Reactive Mode**：根据可用资源**自动调整并行度**（配合 K8s 弹性伸缩），本质是用 Savepoint 式的状态重分配实现。

## Task 的线程模型：Mailbox

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Task 的 Mailbox 模型：主线程循环处理输入数据与邮箱中的事件，其他线程把 Checkpoint、定时器等事件放入邮箱，由主线程串行执行">
<rect class="b3" x="260" y="30" width="230" height="130" rx="12"/>
<text class="th" x="375" y="54" text-anchor="middle">Task 主线程（单线程）</text>
<text class="ts" x="375" y="80" text-anchor="middle">循环：</text>
<text class="ts" x="375" y="100" text-anchor="middle">1) 先处理邮箱中的“邮件”</text>
<text class="ts" x="375" y="120" text-anchor="middle">2) 再从输入读取并处理一批数据</text>
<text class="ts" x="375" y="140" text-anchor="middle">processElement / Watermark</text>
<rect class="b5" x="20" y="40" width="190" height="110" rx="10"/>
<text class="th" x="115" y="62" text-anchor="middle">Mailbox 邮箱队列</text>
<text class="ts" x="115" y="86" text-anchor="middle">Checkpoint 触发/完成通知</text>
<text class="ts" x="115" y="106" text-anchor="middle">处理时间定时器回调</text>
<text class="ts" x="115" y="126" text-anchor="middle">异步结果回调（AsyncIO）</text>
<line class="l" x1="210" y1="95" x2="260" y2="95" marker-end="url(#arr)"/>
<rect class="b1" x="540" y="30" width="190" height="60" rx="8"/>
<text class="tb" x="635" y="52" text-anchor="middle" dominant-baseline="middle">网络线程（Netty）</text>
<text class="ts" x="635" y="72" text-anchor="middle">收数据放入输入缓冲</text>
<rect class="b1" x="540" y="100" width="190" height="60" rx="8"/>
<text class="tb" x="635" y="122" text-anchor="middle" dominant-baseline="middle">RPC / 定时线程</text>
<text class="ts" x="635" y="142" text-anchor="middle">把事件作为邮件投递</text>
<line class="l" x1="540" y1="60" x2="490" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="130" x2="210" y2="110"/>
<rect class="bg" x="20" y="180" width="710" height="86" rx="10"/>
<text class="ts" x="375" y="204" text-anchor="middle">结果：数据处理、定时器、Checkpoint 快照触发、状态读写都在同一线程串行 → 算子与状态访问无需加锁、无竞态</text>
<text class="ts" x="375" y="226" text-anchor="middle">代价：在 processElement 里做阻塞 IO（同步查库/HTTP）会卡住该 Task 的一切（包括 Checkpoint barrier 的处理）</text>
<text class="ts" x="375" y="248" text-anchor="middle">对策：AsyncIO（异步 + 回调经邮箱回到主线程）、批量化、把慢操作移出热路径</text>
</svg>
<figcaption>图 2：Mailbox 模型：所有事件在 Task 主线程里串行处理</figcaption>
</figure>

- 这是 Flink 1.9+ 的线程模型（取代早先的“全局 checkpoint lock”），**让 Checkpoint 与数据处理的互斥更简单高效**；
- **`ProcessFunction` 中的状态访问、定时器触发都在主线程**，自定义逻辑不要阻塞；
- 同步快照阶段（对状态做引用/本地快照）占用主线程，**状态很大且同步部分慢**会造成延迟毛刺——这也是增量 Checkpoint 与异步快照的意义。

## 网络栈与信用流控

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="Flink 网络栈：上游 Task 写入 ResultPartition 的 Buffer，经 Netty 发送到下游的 InputGate 的 InputChannel，信用机制告知空闲 Buffer 数，本地传输则直接内存交换">
<rect class="b1" x="20" y="40" width="250" height="200" rx="12"/>
<text class="th" x="145" y="64" text-anchor="middle">上游 Task（TM A）</text>
<rect class="b" x="40" y="80" width="210" height="34" rx="6"/>
<text class="ts" x="145" y="97" text-anchor="middle" dominant-baseline="middle">算子 → 序列化为字节记录</text>
<rect class="b5" x="40" y="126" width="210" height="56" rx="6"/>
<text class="tb" x="145" y="146" text-anchor="middle" dominant-baseline="middle">ResultPartition</text>
<text class="ts" x="145" y="166" text-anchor="middle">按下游并行实例分 Subpartition</text>
<rect class="b3" x="40" y="194" width="210" height="34" rx="6"/>
<text class="ts" x="145" y="211" text-anchor="middle" dominant-baseline="middle">写满的 NetworkBuffer（32KB）排队</text>
<line class="l" x1="145" y1="114" x2="145" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="145" y1="182" x2="145" y2="194" marker-end="url(#arr)"/>
<rect class="b2" x="510" y="40" width="250" height="200" rx="12"/>
<text class="th" x="635" y="64" text-anchor="middle">下游 Task（TM B）</text>
<rect class="b5" x="530" y="80" width="210" height="56" rx="6"/>
<text class="tb" x="635" y="100" text-anchor="middle" dominant-baseline="middle">InputGate</text>
<text class="ts" x="635" y="120" text-anchor="middle">每个上游一个 InputChannel</text>
<rect class="b3" x="530" y="148" width="210" height="34" rx="6"/>
<text class="ts" x="635" y="165" text-anchor="middle" dominant-baseline="middle">Buffer 池：独占 + 浮动</text>
<rect class="b" x="530" y="194" width="210" height="34" rx="6"/>
<text class="ts" x="635" y="211" text-anchor="middle" dominant-baseline="middle">反序列化 → 交给算子处理</text>
<line class="l" x1="635" y1="136" x2="635" y2="148"/>
<line class="l" x1="635" y1="182" x2="635" y2="194" marker-end="url(#arr)"/>
<line class="la" x1="250" y1="211" x2="530" y2="108" marker-end="url(#arr-a)"/>
<text class="ta" x="410" y="140" text-anchor="middle">Netty 传输（跨 TM）</text>
<line class="l" x1="530" y1="172" x2="250" y2="172" marker-end="url(#arr)"/>
<text class="ts" x="395" y="190" text-anchor="middle">信用 credit = 下游空闲 Buffer 数</text>
<rect class="bg" x="20" y="262" width="740" height="84" rx="10"/>
<text class="ts" x="390" y="284" text-anchor="middle">信用流控：上游只在对端有信用时发送；信用为 0 则 Buffer 在上游堆积，上游 ResultPartition 无可用 Buffer 时算子写不出去 → 被阻塞 = 反压</text>
<text class="ts" x="390" y="306" text-anchor="middle">同一 TM 内的 Task 之间不走 Netty，直接传递 Buffer（本地通道）；Buffer Debloating 根据吞吐动态调整“飞行中”缓冲量，使 Checkpoint 对齐更快</text>
<text class="ts" x="390" y="328" text-anchor="middle">网络内存太小 → 高并行度下 Buffer 不够；太大 → 飞行数据多，Checkpoint 慢且恢复重放多</text>
</svg>
<figcaption>图 3：网络栈：Buffer、Netty 与基于信用的流控</figcaption>
</figure>

### 反压的物理含义

- 反压 = **下游 InputChannel 没有空闲 Buffer → 无信用 → 上游 ResultPartition 的 Buffer 不能被释放 → 上游算子 `emit` 阻塞**；
- Web UI 中算子的“被反压/忙碌/空闲”指标，本质是**统计主线程等待输出 Buffer 的时间占比**；
- Checkpoint Barrier 与数据**同通道排队**（对齐模式），所以反压严重时 Barrier 到不了，Checkpoint 超时；**非对齐 Checkpoint** 让 Barrier 越过队列中的 Buffer，把它们作为通道状态写入快照，见 [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state)；
- **Shuffle 并行度越高，连接数与 Buffer 需求按“上游并行度 × 下游并行度”增长**，大规模作业要关注网络内存（`taskmanager.memory.network.*`）与 TCP 连接（可用连接复用）。

## TaskManager 内存模型

<figure class="fig">
<svg viewBox="0 0 740 340" class="dg" role="img" aria-label="TaskManager 进程内存构成：JVM 堆（框架堆与任务堆）、托管内存、网络内存、JVM Metaspace 与 Overhead，并说明各部分用途">
<rect class="b" x="20" y="20" width="700" height="44" rx="0"/>
<text class="tb" x="370" y="42" text-anchor="middle" dominant-baseline="middle">Total Process Memory（taskmanager.memory.process.size，对应容器内存上限）</text>
<rect class="b1" x="20" y="64" width="300" height="100" rx="0"/>
<text class="th" x="170" y="86" text-anchor="middle">Total Flink Memory</text>
<rect class="b3" x="20" y="96" width="150" height="68" rx="0"/>
<text class="tb" x="95" y="118" text-anchor="middle" dominant-baseline="middle">JVM Heap</text>
<text class="ts" x="95" y="138" text-anchor="middle">框架堆(128MB)</text>
<text class="ts" x="95" y="154" text-anchor="middle">+ 任务堆（用户代码）</text>
<rect class="b5" x="170" y="96" width="75" height="68" rx="0"/>
<text class="tb" x="207" y="118" text-anchor="middle" dominant-baseline="middle">托管内存</text>
<text class="ts" x="207" y="138" text-anchor="middle">默认 40%</text>
<text class="ts" x="207" y="154" text-anchor="middle">堆外</text>
<rect class="b2" x="245" y="96" width="75" height="68" rx="0"/>
<text class="tb" x="282" y="118" text-anchor="middle" dominant-baseline="middle">网络内存</text>
<text class="ts" x="282" y="138" text-anchor="middle">默认 10%</text>
<text class="ts" x="282" y="154" text-anchor="middle">64MB~1GB</text>
<rect class="b4" x="320" y="64" width="200" height="100" rx="0"/>
<text class="tb" x="420" y="106" text-anchor="middle" dominant-baseline="middle">JVM Metaspace</text>
<text class="ts" x="420" y="128" text-anchor="middle">默认 256MB</text>
<rect class="bg" x="520" y="64" width="200" height="100" rx="0"/>
<text class="tb" x="620" y="106" text-anchor="middle" dominant-baseline="middle">JVM Overhead</text>
<text class="ts" x="620" y="128" text-anchor="middle">默认 10%（192MB~1GB）</text>
<text class="ts" x="620" y="146" text-anchor="middle">线程栈·代码缓存·GC·native</text>
<text class="th" x="20" y="198">各部分的用途与调优要点</text>
<text class="ts" x="20" y="222">• 任务堆：算子对象、HashMapStateBackend 的状态、用户数据结构；堆小了 OOM，堆大了 GC 暂停变长</text>
<text class="ts" x="20" y="242">• 托管内存：RocksDB 的块缓存与写缓冲（默认按此上限约束 RocksDB 内存）、批处理排序/哈希；用 RocksDB 的作业应适当调大该比例</text>
<text class="ts" x="20" y="262">• 网络内存：Network Buffer 池；高并行度 Shuffle 需要更多；不足会导致启动失败或吞吐受限</text>
<text class="ts" x="20" y="282">• JVM Overhead：给线程栈、直接内存、native 库留余量；容器 OOMKilled 往往是这里或 RocksDB 超限</text>
<text class="ts" x="20" y="306">• 配置原则：只指定 process.size（容器限制），让 Flink 自动推导各部分；有特殊需求再覆盖局部比例；容器内存 request=limit</text>
</svg>
<figcaption>图 4：TaskManager 内存划分，托管内存决定 RocksDB 的稳定性</figcaption>
</figure>

排查内存问题的路径：

| 现象 | 可能原因 | 方向 |
| --- | --- | --- |
| `java.lang.OutOfMemoryError: Java heap space` | 任务堆不足、状态在堆里增长、热点 key | 增大任务堆或换 RocksDB；状态 TTL |
| `Direct buffer memory` | 网络/直接内存不足 | 增大网络内存、Overhead |
| 容器 OOMKilled，但堆未满 | RocksDB/native 内存超出托管内存、Overhead 不足 | 开启 RocksDB 托管内存限制，调大托管内存与 Overhead，见 [Kubernetes 核心概念](#/infra/k8s) |
| 频繁 Full GC | 状态大、对象多 | RocksDB、对象复用、减少装箱，见 [垃圾回收算法与分代](#/java/jvm/gc) |
| `Insufficient number of network buffers` | 并行度高 Shuffle 多 | 增大 `network` 内存或降低并行度 |

## Key Group：状态如何分片与重分布

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="Key 通过哈希映射到 Key Group，Key Group 按连续范围分配给算子并行实例，扩缩容时 Key Group 整体迁移">
<rect class="b" x="20" y="20" width="160" height="50" rx="8"/>
<text class="tb" x="100" y="40" text-anchor="middle" dominant-baseline="middle">key = userId</text>
<text class="ts" x="100" y="58" text-anchor="middle">keyBy(userId)</text>
<rect class="b3" x="220" y="20" width="220" height="50" rx="8"/>
<text class="tb" x="330" y="40" text-anchor="middle" dominant-baseline="middle">keyGroup =</text>
<text class="tm" x="330" y="58" text-anchor="middle" dominant-baseline="middle">murmur(hash(key)) % maxPar</text>
<line class="l" x1="180" y1="45" x2="220" y2="45" marker-end="url(#arr)"/>
<rect class="b" x="20" y="110" width="700" height="60" rx="0"/>
<text class="th" x="36" y="130">Key Group 空间（maxParallelism = 128，状态按 Key Group 切成 128 份）</text>
<rect class="b1" x="20" y="136" width="235" height="34" rx="0"/>
<text class="tm" x="137" y="153" text-anchor="middle" dominant-baseline="middle">KG 0 ~ 42   → 子任务 0</text>
<rect class="b2" x="255" y="136" width="235" height="34" rx="0"/>
<text class="tm" x="372" y="153" text-anchor="middle" dominant-baseline="middle">KG 43 ~ 85  → 子任务 1</text>
<rect class="b5" x="490" y="136" width="230" height="34" rx="0"/>
<text class="tm" x="605" y="153" text-anchor="middle" dominant-baseline="middle">KG 86 ~ 127 → 子任务 2</text>
<text class="tm" x="20" y="200">子任务索引 = keyGroup × parallelism ÷ maxParallelism   （并行度 3 时，连续区间分配）</text>
<text class="th" x="20" y="232">从 Savepoint 把并行度 3 调整为 4</text>
<rect class="b1" x="20" y="244" width="170" height="30" rx="0"/>
<text class="tm" x="105" y="259" text-anchor="middle" dominant-baseline="middle">KG 0~31</text>
<rect class="b2" x="190" y="244" width="170" height="30" rx="0"/>
<text class="tm" x="275" y="259" text-anchor="middle" dominant-baseline="middle">KG 32~63</text>
<rect class="b5" x="360" y="244" width="170" height="30" rx="0"/>
<text class="tm" x="445" y="259" text-anchor="middle" dominant-baseline="middle">KG 64~95</text>
<rect class="b3" x="530" y="244" width="190" height="30" rx="0"/>
<text class="tm" x="625" y="259" text-anchor="middle" dominant-baseline="middle">KG 96~127</text>
<text class="ts" x="370" y="302" text-anchor="middle">Key Group 是状态的最小迁移单位：重分配只是把若干整个 Key Group 的状态文件分给新的子任务，无需逐 key 重新哈希</text>
<text class="ts" x="370" y="322" text-anchor="middle">所以 maxParallelism 必须固定：它决定 Key Group 总数，改变它会使旧快照的状态分布与新映射不一致，无法恢复</text>
</svg>
<figcaption>图 5：Key → Key Group → 子任务，扩缩容以 Key Group 为单位迁移</figcaption>
</figure>

要点：

- **`maxParallelism`** 默认由并行度推导（约 1.5 倍向上取 2 的幂，最小 128，上限 32768），**生产务必显式设置并长期不变**（如 `env.setMaxParallelism(512)`），它是**将来能扩到多大并行度**的上限；
- 设得过大：Key Group 元数据与每个 Key Group 的开销增加（轻微）；过小：并行度被限制、各子任务负载不均；
- 数据倾斜时，某个 Key Group 内热点 key 无法被拆分，需要业务层加盐；
- **Operator State（非 key 状态）**重分配是按**列表平均拆分**（如 Kafka Source 的分区 offset 列表），与 Key Group 无关。

## RocksDB 状态后端内部

### 结构

RocksDB 是 **LSM-Tree** 存储引擎：

```text
写入 → WAL（Flink 关闭 WAL，靠 Checkpoint）→ MemTable（内存，写缓冲，按 Column Family）
      → 写满后变为不可变 MemTable → Flush 为 L0 的 SST 文件（磁盘，有序）
      → 后台 Compaction 逐层合并到 L1、L2…（删除过期/被覆盖的版本）
读取 ← MemTable → Block Cache（块缓存，LRU）→ SST（布隆过滤器快速排除）
```

Flink 把每个状态（State Name）映射为一个 **Column Family**，**键编码**为 `KeyGroup | Key | Namespace`（Namespace 对窗口状态是窗口，对普通 keyed state 为空），值是序列化的字节。因此：

- **每次状态读写都有序列化/反序列化和潜在的磁盘 IO**（比堆慢 1~2 个数量级）；
- **`ValueState<大Map>` 反模式**：每次读写整个 Map 都要整体反序列化；**用 `MapState` 按 entry 访问**，RocksDB 只读写相关键；
- **`ListState`** 使用 RocksDB 的 **merge 操作**追加，读取时一次取出整个列表，避免超大列表；
- **TTL 清理**：`cleanupInRocksdbCompactFilter` 在 Compaction 时丢弃过期条目，**依赖 Compaction 进度**。

### 调优要点

| 配置 / 手段 | 说明 |
| --- | --- |
| **托管内存约束**（`state.backend.rocksdb.memory.managed: true`，默认开启） | 让所有 RocksDB 实例共享一个 Block Cache 与写缓冲上限，防止内存无限增长被容器杀掉 |
| 块缓存大小 / 写缓冲 | 读多：增大块缓存与布隆过滤器；写多：增大写缓冲（`write-buffer-size`、`max-write-buffer-number`）减少 L0 文件 |
| **本地磁盘用 SSD**（NVMe） | 状态读写与 Compaction 都是磁盘 IO；网络盘延迟高影响很大 |
| Compaction 线程 | `state.backend.rocksdb.thread.num`，Compaction 追不上会让读放大、L0 文件堆积、写入停顿（write stall） |
| **增量 Checkpoint** | 只上传新增 SST（共享文件 + 引用计数），`state.backend.incremental: true`；大状态必开 |
| 本地恢复 | `state.backend.local-recovery`，TM 本地保留快照，故障恢复更快 |
| 预定义选项 | `SPINNING_DISK_OPTIMIZED_HIGH_MEM`/`FLASH_SSD_OPTIMIZED` 等，或自定义 `RocksDBOptionsFactory` |
| 监控 | 开启 RocksDB 原生指标（块缓存命中率、Compaction 待处理字节、L0 文件数、写停顿） |

### 状态访问成本的直觉

- 堆后端：对象引用访问，**纳秒~微秒**；
- RocksDB：命中块缓存**微秒级**，穿透到 SST **毫秒级**，且伴随 CPU 序列化；
- 所以**减少状态访问次数**（MiniBatch 攒批、在内存中先局部聚合再写状态）和**减小每次访问的字节数**（精简状态结构、用 `AggregatingState` 增量聚合）是 RocksDB 作业最有效的优化，见 [Flink SQL、反压与性能调优](#/bigdata/flink-ops)。

## Checkpoint 内部要点

- **CheckpointCoordinator**（JobManager）：触发、收集确认、持久化元数据；基于**增量文件引用计数**管理保留与清理；
- Barrier 对齐发生在 **InputGate**：多输入通道的 Barrier 到齐才继续；**非对齐**时 Barrier 越过缓冲，缓冲数据写入通道状态；
- **同步阶段**（主线程，短）：对状态做快照标记（RocksDB 做 checkpoint/引用已有 SST 硬链接；堆后端做 copy-on-write 引用）→ **异步阶段**（后台线程）：把快照上传到远程存储；
- **Sink**（统一 Sink API）：`SinkWriter`（写入）→ 在 Checkpoint 时 `prepareCommit` 产生 **Committable** → 状态中保存 → Checkpoint 完成后 `Committer` 提交；恢复时对未确认的 Committable **重新提交（要求幂等）**，见 [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state)；
- **失败恢复**：重启策略 → 申请 Slot → 下载状态 → 重建算子 → Source 回到位点；恢复时间主要取决于**状态大小与下载/加载速度**（本地恢复可显著缩短）。

## 定时器与时间服务

- 定时器按 `(key, namespace, timestamp)` 存放，**同一 key 同一时间戳去重**；
- 存储位置：**堆（默认，基于优先队列）**或 **RocksDB**（`state.backend.rocksdb.timer-service.factory`），定时器很多（如每个 key 一个）时用 RocksDB 避免堆撑爆，但触发更慢；
- 事件时间定时器由 **Watermark 推进触发**；处理时间定时器由系统时钟触发（通过邮箱回到主线程）；
- 大量定时器是**常见隐患**：每个 key 注册后不清理会无限堆积，务必在 `onTimer`/状态过期时清理。

## 排查工具与方法

| 目标 | 工具 / 指标 |
| --- | --- |
| 找瓶颈算子 | UI：Busy / Backpressured / Idle；指标 `busyTimeMsPerSecond`、`backPressuredTimeMsPerSecond` |
| 看数据倾斜 | 各子任务的 `numRecordsIn`、状态大小、Checkpoint 各子任务耗时 |
| CPU 热点 | `jstack` / **async-profiler 火焰图**（TM 进程），UI 的 Flame Graph（部分版本）；见 [线上调优与故障排查](#/java/jvm/tuning) |
| 状态与 RocksDB | RocksDB 原生指标、磁盘 IO（`iostat`）、`du` 本地状态目录 |
| 网络 | 反压 + `outPoolUsage/inPoolUsage`、Buffer Debloating 指标 |
| Checkpoint | UI 中每个算子的 Sync/Async 耗时、对齐耗时、状态大小、端到端耗时 |
| GC | GC 日志、`Status.JVM.GarbageCollector.*` |

## Flink 2.x 的方向（了解）

Flink 2.0 起：移除 DataSet 等旧 API、推进**存算分离的状态后端（将状态放远端存储、本地做缓存）**与**异步状态 API**以应对超大状态、改进 SQL 与批流一体能力。落地前请阅读对应版本的迁移说明；本页描述的执行图、网络、Key Group 等基本概念仍然适用。

## 面试追问

> [!QUESTION] Flink 作业从代码到执行经过哪些阶段？算子链有什么作用？
> StreamGraph 在客户端由 API 生成，转换为 JobGraph 时合并可链化算子，JobManager 再按并行度展开成 ExecutionGraph 并调度到 Slot。算子链把相邻的 Forward 算子放在同一线程内直接调用，省去序列化和网络开销，是重要的性能优化。

> [!QUESTION] Flink 的 Task 线程模型是怎样的？为什么算子里不能阻塞？
> 采用 Mailbox 模型：每个 Task 一个主线程，数据处理、定时器回调、Checkpoint 触发等事件在同一线程串行执行，因此无需加锁；但算子里的阻塞调用会占住主线程，导致该 Task 的数据处理和 Checkpoint Barrier 处理都被卡住，应使用 AsyncIO 或批量化。

> [!QUESTION] 反压在底层是怎么产生的？
> 基于信用的流控：下游按空闲 Buffer 数告知上游信用，上游只在有信用时发送。下游处理慢导致 Buffer 无法释放，信用耗尽，上游 ResultPartition 的 Buffer 排满，算子写不出数据而阻塞，并逐级向 Source 传导。

> [!QUESTION] 什么是 Key Group？为什么 maxParallelism 不能随便改？
> Key Group 是状态的最小分配单元，key 先哈希到 Key Group，再把连续的 Key Group 区间分配给各并行子任务；扩缩容时按 Key Group 整体迁移状态。maxParallelism 决定 Key Group 总数，改变它会使 key 到 Key Group 的映射变化，旧快照无法对应恢复，所以必须显式设置并保持不变。

> [!QUESTION] RocksDB 状态后端用在大状态时要注意什么？
> 状态在本地磁盘，读写要序列化，比堆慢很多：用 SSD，开启托管内存约束防止被容器杀掉，调整块缓存和写缓冲，监控 Compaction，开启增量 Checkpoint；业务上用 MapState 按条目访问、减少状态访问次数并设置 TTL。
