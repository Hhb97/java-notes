---
level: 深入
tags: [Kafka, KRaft, 分区, Segment, 零拷贝, 生产者, 消费者组, Rebalance]
summary: Kafka 3.x/4.x 的架构、KRaft、分区日志存储与稀疏索引、高吞吐原理、生产者内部流水线、消费者组与 Rebalance、位点管理和日志清理
---

# Kafka 架构与存储

> [!ABSTRACT] 核心要点
> - Kafka 是**分区化的、多副本的提交日志**：Topic 切成 Partition，Partition 是有序、只追加的日志，是并行度、顺序性和副本复制的基本单位。
> - 元数据管理从 ZooKeeper 迁移到 **KRaft**（基于 Raft 的 Controller 集群）：3.3 起可用于生产，**4.0 彻底移除 ZooKeeper**。
> - 分区在磁盘上是一组 **segment**（`.log` + `.index` + `.timeindex`），索引是**稀疏索引**：二分定位 segment → 二分查索引 → 顺序扫描日志。
> - 快的原因：**顺序追加写、依赖 PageCache、sendfile 零拷贝、端到端批量与压缩**，而不是什么特殊的数据结构。
> - 消费者组内一个分区只能被一个消费者消费；成员变化触发 **Rebalance**，3.x 推荐 CooperativeSticky + 静态成员，4.0 新协议（KIP-848）把分配下沉到 Broker。

## 整体架构

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Kafka KRaft 架构：Controller 仲裁集群管理元数据，三个 Broker 上分布着三个分区的 Leader 和 Follower 副本，生产者写 Leader，消费者组拉取">
<rect class="bg" x="200" y="16" width="360" height="70" rx="12"/>
<text class="ts" x="212" y="32">KRaft Controller Quorum（__cluster_metadata）</text>
<rect class="b5" x="215" y="40" width="100" height="36" rx="8"/>
<text class="tb" x="265" y="58" text-anchor="middle" dominant-baseline="middle">Active</text>
<rect class="b" x="330" y="40" width="100" height="36" rx="8"/>
<text class="tb" x="380" y="58" text-anchor="middle" dominant-baseline="middle">Standby</text>
<rect class="b" x="445" y="40" width="100" height="36" rx="8"/>
<text class="tb" x="495" y="58" text-anchor="middle" dominant-baseline="middle">Standby</text>
<line class="ld" x1="380" y1="86" x2="380" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="390" y="102">元数据日志拉取</text>
<rect class="bg" x="200" y="110" width="360" height="150" rx="12"/>
<rect class="b" x="215" y="120" width="100" height="130" rx="8"/>
<text class="tb" x="265" y="138" text-anchor="middle" dominant-baseline="middle">Broker 1</text>
<rect class="b1" x="223" y="152" width="84" height="24" rx="5"/>
<text class="tm" x="265" y="164" text-anchor="middle" dominant-baseline="middle">P0 · L</text>
<rect class="b" x="223" y="182" width="84" height="24" rx="5"/>
<text class="tm" x="265" y="194" text-anchor="middle" dominant-baseline="middle">P1 · F</text>
<rect class="b" x="223" y="212" width="84" height="24" rx="5"/>
<text class="tm" x="265" y="224" text-anchor="middle" dominant-baseline="middle">P2 · F</text>
<rect class="b" x="330" y="120" width="100" height="130" rx="8"/>
<text class="tb" x="380" y="138" text-anchor="middle" dominant-baseline="middle">Broker 2</text>
<rect class="b" x="338" y="152" width="84" height="24" rx="5"/>
<text class="tm" x="380" y="164" text-anchor="middle" dominant-baseline="middle">P0 · F</text>
<rect class="b1" x="338" y="182" width="84" height="24" rx="5"/>
<text class="tm" x="380" y="194" text-anchor="middle" dominant-baseline="middle">P1 · L</text>
<rect class="b" x="338" y="212" width="84" height="24" rx="5"/>
<text class="tm" x="380" y="224" text-anchor="middle" dominant-baseline="middle">P2 · F</text>
<rect class="b" x="445" y="120" width="100" height="130" rx="8"/>
<text class="tb" x="495" y="138" text-anchor="middle" dominant-baseline="middle">Broker 3</text>
<rect class="b" x="453" y="152" width="84" height="24" rx="5"/>
<text class="tm" x="495" y="164" text-anchor="middle" dominant-baseline="middle">P0 · F</text>
<rect class="b" x="453" y="182" width="84" height="24" rx="5"/>
<text class="tm" x="495" y="194" text-anchor="middle" dominant-baseline="middle">P1 · F</text>
<rect class="b1" x="453" y="212" width="84" height="24" rx="5"/>
<text class="tm" x="495" y="224" text-anchor="middle" dominant-baseline="middle">P2 · L</text>
<rect class="b3" x="20" y="150" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="175" text-anchor="middle" dominant-baseline="middle">Producer</text>
<line class="l" x1="150" y1="175" x2="200" y2="175" marker-end="url(#arr)"/>
<text class="ts" x="175" y="165" text-anchor="middle">写 L</text>
<line class="l" x1="560" y1="185" x2="600" y2="185" marker-end="url(#arr)"/>
<text class="ts" x="580" y="175" text-anchor="middle">拉取</text>
<rect class="bg" x="600" y="110" width="150" height="150" rx="12"/>
<text class="ts" x="612" y="128">Consumer Group A</text>
<rect class="b2" x="615" y="140" width="120" height="40" rx="8"/>
<text class="tm" x="675" y="160" text-anchor="middle" dominant-baseline="middle">C1 ← P0, P1</text>
<rect class="b2" x="615" y="200" width="120" height="40" rx="8"/>
<text class="tm" x="675" y="220" text-anchor="middle" dominant-baseline="middle">C2 ← P2</text>
<text class="ts" x="380" y="288" text-anchor="middle">Topic orders：3 分区 × 3 副本；L = Leader，F = Follower；默认读写都走 Leader</text>
<text class="ts" x="380" y="310" text-anchor="middle">ZooKeeper 模式下由某个 Broker 兼任 Controller、元数据存 ZK；4.0 起只支持 KRaft</text>
</svg>
<figcaption>图 1：KRaft 模式下的 Kafka 集群</figcaption>
</figure>

| 概念 | 说明 |
| --- | --- |
| Broker | 存储分区副本、处理客户端读写的服务节点 |
| Topic / Partition | Topic 是逻辑分类；Partition 是物理有序日志，分区内 offset 单调递增，**只保证分区内有序** |
| Replica | 每个分区有 `replication.factor` 个副本，一个 Leader，其余 Follower 从 Leader 拉取复制；ISR 机制见 [Kafka 副本与可靠性](#/mw/kafka-reliability) |
| Controller | 负责分区 Leader 选举、副本分配、Broker 上下线处理、元数据传播 |
| Producer | 决定消息发往哪个分区，直接与该分区 Leader 所在 Broker 通信 |
| Consumer Group | 组内成员瓜分分区；不同组之间互不影响，各自维护位点（广播语义靠多个组实现） |
| Group Coordinator | 某个 Broker 上的组件，管理消费者组成员关系和位点提交 |

> [!NOTE]
> 从 2.4（KIP-392）开始，消费者可以配置 `client.rack` 并配合 Broker 端 `replica.selector.class` 从**同机架的 Follower 读取**，用于跨机房场景节省流量；默认仍从 Leader 读。

## KRaft：取代 ZooKeeper

ZooKeeper 模式的问题：

- **两套系统**：要单独部署、监控、调优 ZK，安全配置也要做两遍。
- **元数据扩展性差**：Controller 故障切换时，新 Controller 要从 ZK 全量加载所有分区元数据，分区数到几十万时切换耗时可达分钟级，期间无法选举 Leader。
- **元数据传播不一致**：Controller 通过 RPC 把元数据推给 Broker，ZK 与 Broker 缓存之间容易出现短暂不一致。

KRaft 的做法：把元数据本身做成一个**内部 Topic `__cluster_metadata`**，由 3 或 5 个 Controller 节点组成 Raft 仲裁（Raft 原理见 [Raft 与共识算法](#/distributed/consensus)），Active Controller 就是 Raft Leader。Broker 像消费普通日志一样**拉取**元数据增量，并定期生成快照。Controller 切换时备用节点内存里已经有完整元数据，几乎可以瞬时接管。

| 版本 | 状态 |
| --- | --- |
| 2.8 | KRaft 早期预览（不可用于生产） |
| 3.3 | KRaft 可用于生产（新集群） |
| 3.5 / 3.6 | ZK 模式标记废弃；ZK → KRaft 在线迁移逐步可用 |
| 3.9 | 最后一个 3.x 版本，作为从 ZK 迁移到 4.x 的过渡版本；支持动态 Controller 仲裁（KIP-853） |
| 4.0 | **移除 ZooKeeper**，只能运行 KRaft；新消费者组协议（KIP-848）正式可用 |

```properties
# KRaft 组合模式（开发测试用）；生产建议 Controller 与 Broker 分开部署
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@k1:9093,2@k2:9093,3@k3:9093
listeners=PLAINTEXT://:9092,CONTROLLER://:9093
controller.listener.names=CONTROLLER
```

> [!WARNING]
> 存量 ZK 集群不能直接升级到 4.0：必须先在 3.x（建议 3.9）上完成 ZK → KRaft 迁移，再升级。另外 4.0 要求 Broker 运行在 Java 17+，客户端 Java 11+。

## 存储：分区、segment 与稀疏索引

每个分区对应一个目录，如 `orders-0/`。分区日志被切成多个 **segment**，文件名是该 segment 第一条消息的 offset（baseOffset），补齐 20 位：

```text
orders-0/
├── 00000000000000000000.log         # 消息数据（RecordBatch 序列）
├── 00000000000000000000.index       # 偏移量索引：相对 offset → 文件物理位置
├── 00000000000000000000.timeindex   # 时间索引：时间戳 → 相对 offset
├── 00000000000000368769.log
├── 00000000000000368769.index
├── 00000000000000368769.timeindex
├── 00000000000000368769.snapshot    # 生产者状态快照（幂等 / 事务用）
├── 00000000000000368769.txnindex    # 已中止事务索引（read_committed 过滤用）
└── leader-epoch-checkpoint          # Leader Epoch → 起始 offset
```

只有最新的 **active segment** 可写，满足任一条件就滚动出新 segment：大小达到 `log.segment.bytes`（默认 1GB）、时间达到 `log.roll.hours`（默认 7 天）、索引文件写满。日志删除也是以 segment 为单位整体删除，这是「按 segment 切分」的主要目的之一。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="按 offset 查找消息：二分定位 segment，在稀疏 index 中二分找到不大于目标的最大索引项，再从对应物理位置顺序扫描 log">
<text class="ts" x="20" y="30">① 目标 offset = 368776：按 baseOffset 二分定位 segment（Broker 内存中是一个跳表）</text>
<rect class="b" x="20" y="44" width="220" height="40" rx="8"/>
<text class="tm" x="130" y="64" text-anchor="middle" dominant-baseline="middle">00000000000000000000.log</text>
<rect class="b1" x="270" y="44" width="220" height="40" rx="8"/>
<text class="tm" x="380" y="64" text-anchor="middle" dominant-baseline="middle">00000000000000368769.log</text>
<rect class="b" x="520" y="44" width="220" height="40" rx="8"/>
<text class="tm" x="630" y="64" text-anchor="middle" dominant-baseline="middle">00000000000000737337.log</text>
<line class="la" x1="380" y1="84" x2="380" y2="130" marker-end="url(#arr-a)"/>
<text class="ts" x="392" y="112">② 相对 offset = 7，二分找 ≤ 7 的最大索引项</text>
<rect class="b" x="20" y="130" width="220" height="130" rx="8"/>
<text class="tb" x="130" y="150" text-anchor="middle" dominant-baseline="middle">一个 segment 的三个文件</text>
<text class="tm" x="36" y="178">.log</text>
<text class="ts" x="120" y="178">RecordBatch 序列</text>
<text class="tm" x="36" y="204">.index</text>
<text class="ts" x="120" y="204">相对 offset → 位置</text>
<text class="tm" x="36" y="230">.timeindex</text>
<text class="ts" x="120" y="230">时间戳 → 相对 offset</text>
<rect class="b3" x="270" y="130" width="220" height="130" rx="8"/>
<text class="tb" x="380" y="150" text-anchor="middle" dominant-baseline="middle">.index（稀疏，mmap）</text>
<text class="tm" x="290" y="176">rel 0   → pos 0</text>
<text class="tm ta" x="290" y="198">rel 6   → pos 4352</text>
<text class="tm" x="290" y="220">rel 12  → pos 8710</text>
<text class="tm" x="290" y="242">rel 19  → pos 13120</text>
<line class="la" x1="490" y1="194" x2="520" y2="176" marker-end="url(#arr-a)"/>
<rect class="b2" x="520" y="130" width="220" height="130" rx="8"/>
<text class="tb" x="630" y="150" text-anchor="middle" dominant-baseline="middle">.log</text>
<text class="tm" x="536" y="176">pos 4352  off 368775</text>
<text class="tm ta" x="536" y="198">pos 4891  off 368776</text>
<text class="tm" x="536" y="220">pos 5420  off 368777</text>
<text class="tm" x="536" y="242">…</text>
<text class="ts" x="380" y="284" text-anchor="middle">约每写入 4KB 追加一条索引</text>
<text class="ts" x="630" y="284" text-anchor="middle">③ 从 pos 4352 顺序扫描到目标</text>
</svg>
<figcaption>图 2：Kafka 按 offset 查找消息的过程</figcaption>
</figure>

几个要点：

- **稀疏索引**：并不是每条消息都建索引，而是每写入 `log.index.interval.bytes`（默认 4096 字节）才追加一条。索引项很小（偏移量索引每项 8 字节：4 字节相对 offset + 4 字节物理位置），可以整个 mmap 到内存里二分查找。
- **相对 offset**：索引里存的是相对 baseOffset 的差值，4 字节就够，节省一半空间。
- **时间索引**：`offsetsForTimes()`、按时间重置位点、按时间删除 segment 都依赖它：先在 `.timeindex` 找到 offset，再走 offset 查找流程。
- **消息格式 v2**（0.11+）：以 RecordBatch 为单位存储，批次头里有 baseOffset、PID、producer epoch、baseSequence、是否事务等字段，批内消息用 varint 存相对偏移和时间戳增量，压缩也是以批为单位。

## 为什么 Kafka 这么快

| 手段 | 原理 | 注意 |
| --- | --- | --- |
| 顺序追加写 | 只在 active segment 末尾追加，磁盘顺序写远快于随机写，HDD 上差距可达数量级 | 单 Broker 分区过多时，大量分区的「顺序写」在磁盘层面又变成了随机写 |
| PageCache | 写入只到 PageCache，由 OS 异步刷盘；读取热数据直接命中 PageCache。不在 JVM 堆里缓存，避免 GC 和双份缓存 | Broker 堆不需要很大（通常 6～8G），把内存留给 PageCache |
| 零拷贝 | 消费时用 `FileChannel.transferTo` → `sendfile`，数据从 PageCache 直接到网卡，不经过用户态 | **开启 SSL/TLS 后失效**，因为要在用户态加密；零拷贝原理见 [IO / NIO 与零拷贝](#/java/api/io) |
| 批量 | 生产者按分区攒批，Broker 按批写入，消费者按批拉取，摊薄网络和系统调用开销 | 批越大吞吐越高、延迟越高 |
| 端到端压缩 | 生产者压缩整个批次，Broker 原样存储，消费者解压 | Broker 端 `compression.type` 若与生产者不同会触发重新压缩，消耗 CPU |
| 分区并行 | 分区分布在多个 Broker，读写水平扩展 | 分区数决定消费并行度上限 |

> [!NOTE]
> 由于 Kafka 依赖 PageCache 而不是每条 fsync（默认 `log.flush.interval.messages` 无限大），它的持久性来自**多副本**而不是刷盘：单机掉电可能丢掉 PageCache 中的数据，但只要 `acks=all` 且其它 ISR 副本还活着，消息就不会丢。

## 生产者内部原理

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="Kafka 生产者流水线：主线程经过拦截器、序列化器、分区器写入 RecordAccumulator，Sender 线程按 Broker 聚合批次发送">
<rect class="bg" x="20" y="16" width="720" height="104" rx="12"/>
<text class="ts" x="32" y="32">调用方线程：KafkaProducer.send(record, callback)</text>
<rect class="b" x="40" y="44" width="120" height="44" rx="8"/>
<text class="tb" x="100" y="66" text-anchor="middle" dominant-baseline="middle">send()</text>
<line class="l" x1="160" y1="66" x2="190" y2="66" marker-end="url(#arr)"/>
<rect class="b1" x="190" y="44" width="120" height="44" rx="8"/>
<text class="tb" x="250" y="66" text-anchor="middle" dominant-baseline="middle">拦截器</text>
<line class="l" x1="310" y1="66" x2="340" y2="66" marker-end="url(#arr)"/>
<rect class="b1" x="340" y="44" width="120" height="44" rx="8"/>
<text class="tb" x="400" y="66" text-anchor="middle" dominant-baseline="middle">序列化器</text>
<line class="l" x1="460" y1="66" x2="490" y2="66" marker-end="url(#arr)"/>
<rect class="b1" x="490" y="44" width="120" height="44" rx="8"/>
<text class="tb" x="550" y="66" text-anchor="middle" dominant-baseline="middle">分区器</text>
<text class="ts" x="250" y="106" text-anchor="middle">onSend()</text>
<text class="ts" x="400" y="106" text-anchor="middle">key/value → byte[]</text>
<text class="ts" x="550" y="106" text-anchor="middle">key 哈希 / 粘性</text>
<line class="l" x1="610" y1="66" x2="690" y2="66"/>
<line class="l" x1="690" y1="66" x2="690" y2="150" marker-end="url(#arr)"/>
<rect class="bg" x="470" y="150" width="270" height="112" rx="12"/>
<text class="ts" x="482" y="168">RecordAccumulator（buffer.memory）</text>
<text class="tm" x="482" y="196">orders-0</text>
<rect class="b3" x="560" y="182" width="56" height="22" rx="4"/>
<text class="tm" x="588" y="193" text-anchor="middle" dominant-baseline="middle">batch</text>
<rect class="b3" x="624" y="182" width="56" height="22" rx="4"/>
<text class="tm" x="652" y="193" text-anchor="middle" dominant-baseline="middle">batch</text>
<text class="tm" x="482" y="228">orders-1</text>
<rect class="b3" x="560" y="214" width="56" height="22" rx="4"/>
<text class="tm" x="588" y="225" text-anchor="middle" dominant-baseline="middle">batch</text>
<text class="ts" x="482" y="254">每个分区一个 Deque&lt;ProducerBatch&gt;</text>
<line class="la" x1="470" y1="205" x2="420" y2="205" marker-end="url(#arr-a)"/>
<rect class="b2" x="260" y="175" width="160" height="60" rx="8"/>
<text class="tb" x="340" y="196" text-anchor="middle" dominant-baseline="middle">Sender 线程</text>
<text class="ts" x="340" y="218" text-anchor="middle">按 Broker 聚合批次</text>
<line class="l" x1="260" y1="205" x2="190" y2="205" marker-end="url(#arr)"/>
<text class="ts" x="225" y="196" text-anchor="middle">请求</text>
<rect class="b" x="40" y="175" width="150" height="60" rx="8"/>
<text class="tb" x="115" y="196" text-anchor="middle" dominant-baseline="middle">Broker Leader</text>
<text class="ts" x="115" y="218" text-anchor="middle">按 acks 应答 → 回调</text>
<text class="ts" x="20" y="284">批次可发送：batch.size 写满，或 linger.ms 到期；每个连接未确认请求数 ≤ max.in.flight.requests.per.connection</text>
<text class="ts" x="20" y="302">缓冲区写满时 send() 最多阻塞 max.block.ms；整体发送时限 delivery.timeout.ms（含重试）</text>
</svg>
<figcaption>图 3：生产者的双线程模型</figcaption>
</figure>

`send()` 是异步的：调用方线程只负责把消息放进 `RecordAccumulator` 对应分区的批次里就返回 Future；真正的网络发送由后台 **Sender 线程**完成，它把可发送的批次按目标 Broker 归并成一个 ProduceRequest，收到响应后在 Sender 线程里执行回调（所以**回调里不要做耗时操作**）。

```java
// Kafka 3.x KafkaProducer#doSend（节选，简化）
clusterAndWaitTime = waitOnMetadata(...);          // 首次发送需要拉取元数据，最多阻塞 max.block.ms
byte[] k = keySerializer.serialize(topic, key);
byte[] v = valueSerializer.serialize(topic, value);
int partition = partition(record, k, v, cluster);  // 指定了分区 > 自定义分区器 > key 哈希 > 内置粘性
RecordAccumulator.RecordAppendResult result =
        accumulator.append(topic, partition, timestamp, k, v, headers, callback, ...);
if (result.batchIsFull || result.newBatchCreated)
    this.sender.wakeup();                          // 批满或新建批次时唤醒 Sender
return result.future;
```

| 参数 | 默认值（3.x） | 说明与建议 |
| --- | --- | --- |
| `acks` | `all`（3.0 起） | 0 不等应答；1 Leader 写入即应答；all 等 ISR 全部写入 |
| `enable.idempotence` | `true`（3.0 起） | 幂等生产者，要求 acks=all、retries>0、in.flight≤5 |
| `batch.size` | 16384（16KB） | 单分区批次上限；高吞吐场景可调到 64KB～256KB |
| `linger.ms` | 0（**4.0 改为 5**） | 等待攒批的时间；设 5～20ms 吞吐提升明显 |
| `buffer.memory` | 32MB | 累加器总内存，满了 `send()` 阻塞 |
| `compression.type` | none | 推荐 `lz4` 或 `zstd`（2.1+），文本类消息压缩率高 |
| `max.in.flight.requests.per.connection` | 5 | 开启幂等时 ≤5 仍保证分区内有序 |
| `retries` | Integer.MAX_VALUE | 实际由 `delivery.timeout.ms`（默认 120s）限制总时长 |
| `max.request.size` | 约 1MB | 需与 Broker `message.max.bytes`、消费者 `max.partition.fetch.bytes` 协同调整 |

> [!WARNING]
> 3.0.0 / 3.1.0 中存在默认幂等实际未生效的问题（KAFKA-13598），后续补丁版本修复。对可靠性有要求时，**显式配置** `acks=all` 和 `enable.idempotence=true`，不要依赖默认值。

### 分区策略

- 指定了分区号：直接使用。
- 有 key：`murmur2(keyBytes) % numPartitions`，同 key 同分区，这是分区顺序的基础。
- 无 key：
  - 2.4 之前是**轮询**，每条消息换分区，批次很碎。
  - 2.4（KIP-480）改为**粘性分区**：一直往同一个分区写，直到该分区的批次满了或被发送，再换下一个分区，显著提升批量效果、降低延迟。
  - 3.3（KIP-794）进一步改进为**均匀粘性分区**：按写入字节数（约 `batch.size`）切换分区，并支持自适应（`partitioner.adaptive.partitioning.enable`，默认开启）——给响应慢的 Broker 上的分区分配更少数据。原来的 `DefaultPartitioner`、`UniformStickyPartitioner` 类标记废弃，不配置 `partitioner.class` 即使用内置逻辑。

> [!CAUTION]
> 有 key 时数据倾斜完全取决于 key 分布：用「商户号」做 key，大商户的分区会成为热点，消费 lag 只在个别分区飙升。热点 key 可以加后缀打散（牺牲该 key 的顺序），或者换更细粒度的 key（如订单号）。

## 消费者组与分区分配

同一个消费者组内，**一个分区同一时刻只分配给一个消费者**，所以消费者数大于分区数时多出来的消费者空闲。分配由组内选出的 Leader 消费者（经典协议）在客户端计算：

| 策略 | 行为 | 特点 |
| --- | --- | --- |
| `RangeAssignor` | 按 Topic 逐个分配，分区按范围切块 | 订阅多个 Topic 时排在前面的消费者分得更多；同编号分区落到同一消费者，便于多 Topic join |
| `RoundRobinAssignor` | 所有分区轮询分配 | 均匀，但 Rebalance 时分配变化大 |
| `StickyAssignor` | 均匀且尽量保留原分配 | 仍是 Eager 协议 |
| `CooperativeStickyAssignor` | Sticky + 增量协作式 Rebalance | **3.x 推荐** |

3.x 的默认值是 `[RangeAssignor, CooperativeStickyAssignor]`，目的是允许滚动升级：先让所有实例同时支持两种策略，再去掉 Range，切换到协作式。

### Rebalance

触发原因：

- 成员加入 / 离开（扩缩容、发版重启、进程崩溃）。
- 心跳超时：超过 `session.timeout.ms`（3.0 起默认 45s）没有心跳。
- **处理太慢**：两次 `poll()` 间隔超过 `max.poll.interval.ms`（默认 5 分钟），消费者被踢出组。这是线上最常见的原因。
- 订阅的 Topic 分区数变化，或正则订阅匹配到新 Topic。

经典协议流程：`FindCoordinator` → 所有成员 `JoinGroup`（Coordinator 选出 Leader 消费者并下发成员列表）→ Leader 计算分配方案 → 所有成员 `SyncGroup` 获取各自分区 → 定期 `Heartbeat`。

| | Eager（急切式） | Cooperative（增量协作式，2.4+） |
| --- | --- | --- |
| 过程 | 所有成员先**撤销全部分区**，再重新分配 | 只撤销需要迁移的分区，未变动的分区继续消费；需两轮 Rebalance |
| 影响 | 全组 Stop-The-World，期间无人消费 | 只影响被迁移的分区 |
| 策略 | Range / RoundRobin / Sticky | CooperativeSticky |

降低 Rebalance 影响的手段：

- **静态成员**（2.3+，KIP-345）：为每个实例配置固定的 `group.instance.id`。实例重启时只要在 `session.timeout.ms` 内回来，就不会触发 Rebalance，直接拿回原来的分区。适合 K8s StatefulSet 这类有稳定标识的部署。
- 合理设置 `max.poll.records`（默认 500）和 `max.poll.interval.ms`，保证一批消息能在时限内处理完。
- Broker 端 `group.initial.rebalance.delay.ms`（默认 3s）让组首次启动时等待更多成员加入，避免反复 Rebalance。

> [!NOTE]
> **4.0 新消费者组协议（KIP-848）**：设置 `group.protocol=consumer` 启用。分配计算从客户端 Leader 移到 Broker 端的 Group Coordinator，成员通过心跳增量获取分配，不再有全组同步屏障，单个成员的变化不会阻塞其它成员。经典协议仍然保留。

## 位点提交与 __consumer_offsets

位点（offset）表示「下一条要消费的消息位置」，提交到内部 Topic `__consumer_offsets`（默认 50 个分区，`abs(groupId.hashCode()) % 50` 决定写入哪个分区，该分区 Leader 所在的 Broker 就是这个组的 Coordinator）。该 Topic 使用 **compact** 清理策略，每个 `(group, topic, partition)` 只保留最新位点。

| 方式 | 写法 | 语义与风险 |
| --- | --- | --- |
| 自动提交 | `enable.auto.commit=true`（默认），每 `auto.commit.interval.ms`（5s）在 `poll()` 时提交上次 poll 返回的位点 | 正常情况下是 at-least-once；但若把消息交给其它线程异步处理，会提前提交导致丢失 |
| 手动同步 | `commitSync()` | 阻塞直到成功，失败会重试，影响吞吐 |
| 手动异步 | `commitAsync(callback)` | 不阻塞、不重试（防止旧位点覆盖新位点） |
| 指定位点 | `commitSync(Map<TopicPartition, OffsetAndMetadata>)` | 细粒度控制，提交值是「已处理的最后 offset + 1」 |

```java
// 常用组合：循环内异步提交，退出时同步提交兜底
consumer.subscribe(List.of("orders"), rebalanceListener);
try {
    while (running) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
        for (ConsumerRecord<String, String> r : records) {
            handle(r);                       // 业务处理，必须幂等
        }
        consumer.commitAsync();
    }
} finally {
    try { consumer.commitSync(); } finally { consumer.close(); }
}
```

> [!TIP]
> 使用手动提交时要实现 `ConsumerRebalanceListener#onPartitionsRevoked`，在分区被收回前同步提交已处理的位点，否则 Rebalance 后接手的消费者会重复消费更多消息。

`auto.offset.reset` 决定没有已提交位点（新组或位点已过期）时从哪开始：`latest`（默认，只消费新消息）、`earliest`、`none`（抛异常）。组内所有消费者都离线超过 `offsets.retention.minutes`（2.0 起默认 7 天）后，已提交位点会被清除，之后重启会按 `auto.offset.reset` 处理，可能导致**大量重复或跳过**。

## 日志清理

| 策略 | 配置 | 行为 | 场景 |
| --- | --- | --- | --- |
| delete（默认） | `retention.ms`（默认 7 天）、`retention.bytes`（默认不限） | 按 segment 整体删除过期 / 超量的**非活跃** segment | 普通消息流 |
| compact | `cleanup.policy=compact` | 同 key 只保留最新值；value 为 null 的消息是墓碑，保留 `delete.retention.ms`（默认 1 天）后删除 | `__consumer_offsets`、CDC 表快照、KTable、配置下发 |
| delete,compact | 两者组合 | 先压缩，再按时间删除 | 有界的状态日志 |

Compaction 由后台 Log Cleaner 线程执行，把日志分为已清理的 head 之前部分和「脏」部分，脏数据比例超过 `min.cleanable.dirty.ratio`（默认 0.5）时清理：为脏部分建 key → 最新 offset 的映射，重写 segment 时丢弃被覆盖的旧值。**active segment 永远不参与清理**，所以低流量 Topic 想尽快压缩，要调小 `segment.ms`。

> [!WARNING]
> 按时间删除的判断依据是 segment 中**最大时间戳**。如果生产者发送了一条时间戳在很远未来的消息（客户端时钟错误），整个 segment 会迟迟不被删除，磁盘持续上涨。可设置 `message.timestamp.type=LogAppendTime` 或限制时间戳偏差（3.6 起有 `log.message.timestamp.after.max.ms`）。

## 生产实践与踩坑

- **分区数规划**：分区数 ≥ 峰值消费并行度；但单集群分区过多会增加文件句柄、内存占用和 Leader 选举耗时，ZK 时代建议单 Broker 数千分区以内，KRaft 上限大幅提升但仍要评估。分区**只能增加不能减少**，增加分区会打乱 key → 分区映射。
- **消费者频繁被踢出组**：日志出现 `CommitFailedException` 或 "consumer poll timeout has expired"，基本是单批处理时间超过 `max.poll.interval.ms`。减小 `max.poll.records`，或把处理放到线程池并配合暂停分区（`pause/resume`）。
- **消费者数量多于分区数**：多出来的实例空转，扩容无效。
- **Broker 堆配太大**：Kafka 不需要大堆，大堆反而挤占 PageCache，导致消费者读历史数据时大量走磁盘，延迟抖动。
- **滞后消费者污染 PageCache**：某个消费者从很早的位点回溯读取，把冷数据读进 PageCache，挤掉了实时消费者需要的热数据，所有消费者延迟上升。回溯任务应错峰执行或使用单独集群。
- **SSL 开启后 CPU 飙升**：零拷贝失效 + 加解密开销，需要预留 CPU 或评估使用更高效的加密套件。

## 相关阅读

- [文件系统、页缓存与零拷贝](#/cs/os-io)：零拷贝与页缓存
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：事件驱动架构
- [ClickHouse 集群、写入与表设计实战](#/bigdata/ck-cluster)：Kafka 引擎与 ClickHouse 写入
- [Kafka 生产运维：容量规划、Rebalance 治理与故障排查](#/mw/kafka-ops)：分区规划、Lag 与迁移
- [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)：数据集成、流处理与契约

## 面试追问

> [!QUESTION] Kafka 为什么不用 B+ 树之类的索引？稀疏索引是怎么查找的？
> Kafka 的访问模式是「按 offset 顺序追加和顺序读」，不需要随机更新。稀疏索引体积小，可以全部 mmap 到内存：先按 baseOffset 二分找到 segment，再在 `.index` 中二分找到不大于目标相对 offset 的最大索引项，最后从该物理位置在 `.log` 中顺序扫描，扫描范围约 4KB，代价很低。

> [!QUESTION] 零拷贝具体减少了哪些拷贝？什么情况下失效？
> 传统 read + write 需要 4 次拷贝（磁盘→内核缓冲→用户缓冲→socket 缓冲→网卡）和 4 次上下文切换；`sendfile` 让数据在内核态从 PageCache 直接到 socket（支持 DMA gather 时连 CPU 拷贝也省掉），用户态不参与。开启 SSL 时需要在用户态加密，零拷贝失效；消息格式需要下转换给老版本客户端时也会失效。

> [!QUESTION] 为什么 KRaft 能支持更多分区？
> ZK 模式下 Controller 切换要从 ZK 全量读取元数据，并通过 RPC 推送给所有 Broker，耗时与分区数线性相关；KRaft 把元数据做成 Raft 复制的日志，备用 Controller 内存中已有最新状态，Broker 增量拉取元数据，故障切换和元数据传播都不再与分区总数强相关。

> [!QUESTION] 线上消费者频繁 Rebalance，怎么排查和优化？
> 先看 Coordinator 日志中成员离开的原因：心跳超时（GC 停顿、网络）还是 poll 超时（处理慢）。处理慢就减小 `max.poll.records`、优化消费逻辑或异步化；发版重启导致的用静态成员；分配策略换成 CooperativeSticky 减小每次 Rebalance 的影响；4.0 可以评估新的消费者组协议。

> [!QUESTION] 粘性分区器解决了什么问题？
> 无 key 消息轮询分区会让每个分区的批次都很小，`linger.ms=0` 时几乎一条一发，请求数多、延迟反而高。粘性分区让一段时间内的消息集中到一个分区形成大批次，满了再切换；3.3 的均匀粘性分区器按字节数切换并能避开慢 Broker，解决了旧粘性分区在 Broker 变慢时数据越积越多的倾斜问题。
