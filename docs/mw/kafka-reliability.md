---
level: 深入
tags: [Kafka, ISR, HW, Leader Epoch, acks, 幂等生产者, 事务, Exactly-Once]
summary: 从 LEO/HW/ISR 到 Leader Epoch、acks 与 min.insync.replicas、幂等与事务，讲清 Kafka 可靠性的边界，并给出不丢消息与性能调优的配置清单
---

# Kafka 副本与可靠性

> [!ABSTRACT] 核心要点
> - 每个副本有 **LEO**（下一条待写入位置），Leader 的 **HW** = ISR 中所有副本 LEO 的最小值；HW 之前的消息才算「已提交」、对消费者可见。
> - 只依赖 HW 做截断会在连续故障下**丢数据或副本不一致**，0.11 引入 **Leader Epoch**：按「任期 + 起始 offset」决定截断点，而不是按 HW。
> - 不丢消息的黄金组合：`acks=all` + `min.insync.replicas=2`（3 副本）+ `unclean.leader.election.enable=false` + 消费端处理成功后再提交位点。
> - 幂等生产者用 **PID + 分区序列号** 去除重试重复，只在单会话、单分区内有效；事务用 **transactional.id + 事务协调器 + 控制标记** 实现跨分区原子写，配合 `read_committed`。
> - Kafka 的 Exactly-Once 只覆盖「Kafka → 处理 → Kafka」闭环；一旦写外部系统，仍要靠**幂等或把位点与结果原子存储**。

## 副本机制：LEO、HW 与 ISR

<figure class="fig">
<svg viewBox="0 0 760 280" class="dg" role="img" aria-label="三个副本的日志：Leader LEO 为 8，ISR 中的 Follower LEO 为 6，因此 HW 为 6；落后的 Follower 被移出 ISR">
<text class="ta" x="452" y="30" text-anchor="middle">HW = 6</text>
<rect class="bg" x="10" y="48" width="740" height="108" rx="10"/>
<text class="ts" x="740" y="66" text-anchor="end">ISR = {B1, B2}</text>
<rect class="b1" x="20" y="60" width="150" height="36" rx="8"/>
<text class="tb" x="95" y="78" text-anchor="middle" dominant-baseline="middle">Leader（B1）</text>
<rect class="b2" x="190" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="210" y="78" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b2" x="234" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="254" y="78" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b2" x="278" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="298" y="78" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b2" x="322" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="342" y="78" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b2" x="366" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="386" y="78" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b2" x="410" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="430" y="78" text-anchor="middle" dominant-baseline="middle">5</text>
<rect class="b3" x="454" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="474" y="78" text-anchor="middle" dominant-baseline="middle">6</text>
<rect class="b3" x="498" y="60" width="40" height="36" rx="4"/>
<text class="tm" x="518" y="78" text-anchor="middle" dominant-baseline="middle">7</text>
<text class="ts" x="550" y="82">LEO = 8</text>
<rect class="b" x="20" y="110" width="150" height="36" rx="8"/>
<text class="tb" x="95" y="128" text-anchor="middle" dominant-baseline="middle">Follower（B2）</text>
<rect class="b2" x="190" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="210" y="128" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b2" x="234" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="254" y="128" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b2" x="278" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="298" y="128" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b2" x="322" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="342" y="128" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b2" x="366" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="386" y="128" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b2" x="410" y="110" width="40" height="36" rx="4"/>
<text class="tm" x="430" y="128" text-anchor="middle" dominant-baseline="middle">5</text>
<text class="ts" x="462" y="132">LEO = 6</text>
<line class="la" x1="452" y1="38" x2="452" y2="152"/>
<rect class="b4" x="20" y="174" width="150" height="36" rx="8"/>
<text class="tb" x="95" y="192" text-anchor="middle" dominant-baseline="middle">Follower（B3）</text>
<rect class="b" x="190" y="174" width="40" height="36" rx="4"/>
<text class="tm" x="210" y="192" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b" x="234" y="174" width="40" height="36" rx="4"/>
<text class="tm" x="254" y="192" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b" x="278" y="174" width="40" height="36" rx="4"/>
<text class="tm" x="298" y="192" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="ts" x="330" y="196">LEO = 3，超过 replica.lag.time.max.ms 未追上，移出 ISR</text>
<rect class="b2" x="20" y="236" width="24" height="16" rx="3"/>
<text class="ts" x="52" y="249">HW 之前：已提交，消费者可见</text>
<rect class="b3" x="300" y="236" width="24" height="16" rx="3"/>
<text class="ts" x="332" y="249">HW 及之后：未提交，消费者不可见</text>
</svg>
<figcaption>图 1：LEO、HW 与 ISR（HW = ISR 内最小 LEO）</figcaption>
</figure>

| 概念 | 含义 |
| --- | --- |
| AR | Assigned Replicas，分区的全部副本 |
| ISR | In-Sync Replicas，与 Leader 保持同步的副本集合（包含 Leader 自己） |
| OSR | 落后太多被移出 ISR 的副本 |
| LEO | Log End Offset，副本日志下一条消息将写入的 offset |
| HW | High Watermark，消费者只能读到 HW 之前的消息；也是「已提交」的边界 |

**HW 的更新过程**（以 Leader + 1 个 Follower 为例）：

1. 生产者写入 Leader，Leader 的 LEO 增加。
2. Follower 发 Fetch 请求（携带自己的 fetchOffset，即自己的 LEO），Leader 据此更新「远程副本 LEO」，并把 Leader HW 推进为 ISR 中最小的 LEO。
3. Fetch 响应里带上 Leader 的 HW，Follower 写入数据后把自己的 HW 更新为 `min(Leader HW, 自身 LEO)`。

关键点：**Follower 的 HW 总是比 Leader 晚一轮 Fetch 才更新**。这个延迟就是下文数据丢失问题的根源。

**ISR 的进出**：Follower 在 `replica.lag.time.max.ms`（2.5 起默认 30s，之前 10s）内没有追上 Leader 的 LEO，就被移出 ISR；追上后重新加入。0.9 之前还有按消息条数判断的 `replica.lag.max.messages`，因为突发流量下容易让 ISR 反复抖动而被移除。

## HW 截断问题与 Leader Epoch

0.11 之前，副本重启或成为 Follower 时，会先把日志**截断到自己的 HW**，再向 Leader 拉取。由于 Follower 的 HW 滞后，这会导致两类问题（KIP-101 描述的场景）。

### 场景一：已提交的消息丢失

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="HW 截断导致数据丢失：B 的 HW 滞后，重启后截断 m2，随后 A 宕机，B 成为 Leader，A 恢复后与 B 对齐，m2 永久丢失">
<text class="tb" x="370" y="30" text-anchor="middle" dominant-baseline="middle">副本 A</text>
<text class="tb" x="630" y="30" text-anchor="middle" dominant-baseline="middle">副本 B</text>
<line class="ld" x1="20" y1="48" x2="740" y2="48"/>
<text class="ts" x="20" y="76">① B 已拉到 m2，A 的 HW 推进到 2</text>
<text class="ts" x="20" y="94">生产者 acks=all 已收到成功</text>
<rect class="b2" x="270" y="66" width="50" height="30" rx="4"/>
<text class="tm" x="295" y="81" text-anchor="middle" dominant-baseline="middle">m1</text>
<rect class="b2" x="326" y="66" width="50" height="30" rx="4"/>
<text class="tm" x="351" y="81" text-anchor="middle" dominant-baseline="middle">m2</text>
<text class="ts" x="388" y="86">Leader HW=2</text>
<rect class="b2" x="530" y="66" width="50" height="30" rx="4"/>
<text class="tm" x="555" y="81" text-anchor="middle" dominant-baseline="middle">m1</text>
<rect class="b3" x="586" y="66" width="50" height="30" rx="4"/>
<text class="tm" x="611" y="81" text-anchor="middle" dominant-baseline="middle">m2</text>
<text class="ts" x="648" y="86">HW=1</text>
<line class="ld" x1="20" y1="118" x2="740" y2="118"/>
<text class="ts" x="20" y="146">② B 重启，按自己的 HW=1 截断</text>
<text class="ts" x="20" y="164">m2 在 B 上被删除</text>
<rect class="b2" x="270" y="136" width="50" height="30" rx="4"/>
<text class="tm" x="295" y="151" text-anchor="middle" dominant-baseline="middle">m1</text>
<rect class="b2" x="326" y="136" width="50" height="30" rx="4"/>
<text class="tm" x="351" y="151" text-anchor="middle" dominant-baseline="middle">m2</text>
<rect class="b2" x="530" y="136" width="50" height="30" rx="4"/>
<text class="tm" x="555" y="151" text-anchor="middle" dominant-baseline="middle">m1</text>
<rect class="b4" x="586" y="136" width="50" height="30" rx="4"/>
<text class="tm" x="611" y="151" text-anchor="middle" dominant-baseline="middle">m2 ✗</text>
<line class="ld" x1="20" y1="188" x2="740" y2="188"/>
<text class="ts" x="20" y="216">③ A 宕机，B 被选为新 Leader</text>
<text class="ts" x="20" y="234">B 只有 m1，LEO=1</text>
<rect class="b4" x="270" y="206" width="106" height="30" rx="4"/>
<text class="tb" x="323" y="221" text-anchor="middle" dominant-baseline="middle">宕机</text>
<rect class="b2" x="530" y="206" width="50" height="30" rx="4"/>
<text class="tm" x="555" y="221" text-anchor="middle" dominant-baseline="middle">m1</text>
<text class="ts" x="592" y="226">Leader</text>
<line class="ld" x1="20" y1="258" x2="740" y2="258"/>
<text class="ts" x="20" y="286">④ A 恢复成为 Follower，与新 Leader</text>
<text class="ts" x="20" y="304">对齐，m2 被截断，永久丢失</text>
<rect class="b2" x="270" y="276" width="50" height="30" rx="4"/>
<text class="tm" x="295" y="291" text-anchor="middle" dominant-baseline="middle">m1</text>
<rect class="b4" x="326" y="276" width="50" height="30" rx="4"/>
<text class="tm" x="351" y="291" text-anchor="middle" dominant-baseline="middle">m2 ✗</text>
<rect class="b2" x="530" y="276" width="50" height="30" rx="4"/>
<text class="tm" x="555" y="291" text-anchor="middle" dominant-baseline="middle">m1</text>
<text class="ts" x="592" y="296">Leader</text>
</svg>
<figcaption>图 2：仅依赖 HW 截断导致已提交消息丢失</figcaption>
</figure>

m2 已经被 Leader 确认提交（生产者收到成功），却最终丢失——这违反了 Kafka 的承诺。

### 场景二：副本数据不一致

前提是 `min.insync.replicas=1`：A 是 Leader，有 m1、m2，HW=2；B 只同步了 m1。两台同时掉电，**B 先恢复**成为 Leader，接收新消息 m3 写在 offset 1。A 恢复后成为 Follower，自己的 HW 是 2，不需要截断，于是 offset 1 处 A 是 m2、B 是 m3，两个副本**数据分叉**，且永远不会被发现。

### Leader Epoch 的解决方式

每个分区维护一个 **Leader Epoch**（每次选出新 Leader 就加 1），每个副本在 `leader-epoch-checkpoint` 文件里记录 `(epoch, 该 epoch 的起始 offset)` 序列。副本成为 Follower 后，不再按自己的 HW 截断，而是先问 Leader：「我最后的 epoch 在你那里结束于哪个 offset？」

<figure class="fig">
<svg viewBox="0 0 760 350" class="dg" role="img" aria-label="Leader Epoch 解决副本分叉：A 向新 Leader B 查询 epoch 0 的结束 offset，得到 1 后截断 m2，再复制 m3">
<rect class="b" x="60" y="16" width="160" height="40" rx="8"/>
<text class="tb" x="140" y="36" text-anchor="middle" dominant-baseline="middle">副本 A（旧 Leader）</text>
<rect class="b" x="510" y="16" width="180" height="40" rx="8"/>
<text class="tb" x="600" y="36" text-anchor="middle" dominant-baseline="middle">副本 B（新 Leader）</text>
<line class="ld" x1="140" y1="56" x2="140" y2="340"/>
<line class="ld" x1="600" y1="56" x2="600" y2="340"/>
<rect class="b3" x="70" y="76" width="140" height="28" rx="6"/>
<text class="tm" x="140" y="90" text-anchor="middle" dominant-baseline="middle">m1 m2 · e0</text>
<rect class="b3" x="530" y="76" width="140" height="28" rx="6"/>
<text class="tm" x="600" y="90" text-anchor="middle" dominant-baseline="middle">m1 · e0</text>
<text class="ts" x="370" y="94" text-anchor="middle">① 两副本同时宕机</text>
<rect class="b1" x="510" y="124" width="180" height="28" rx="6"/>
<text class="tm" x="600" y="138" text-anchor="middle" dominant-baseline="middle">m1 m3 · e1 起始=1</text>
<text class="ts" x="500" y="142" text-anchor="end">② B 先恢复成为 Leader（epoch 1），写入 m3</text>
<line class="l" x1="140" y1="190" x2="600" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="370" y="182" text-anchor="middle">③ OffsetsForLeaderEpoch(epoch = 0)</text>
<line class="l" x1="600" y1="234" x2="140" y2="234" marker-end="url(#arr)"/>
<text class="ts" x="370" y="226" text-anchor="middle">④ epoch 0 的结束 offset = 1</text>
<rect class="b4" x="60" y="262" width="160" height="28" rx="6"/>
<text class="tm" x="140" y="276" text-anchor="middle" dominant-baseline="middle">m1 · 截断 m2</text>
<text class="ts" x="232" y="280">⑤ A 截断到 offset 1，而不是按 HW=2</text>
<line class="l" x1="600" y1="320" x2="140" y2="320" marker-end="url(#arr)"/>
<text class="ts" x="370" y="312" text-anchor="middle">⑥ 正常 Fetch 复制 m3，两副本一致</text>
</svg>
<figcaption>图 3：Leader Epoch 让 Follower 按任期边界截断</figcaption>
</figure>

- **场景一**：B 重启后不再截断到 HW，而是问 Leader A「epoch 0 的结束 offset」，A 仍在 epoch 0，返回自己的 LEO=2，B 无需截断，m2 得以保留。之后 A 宕机，B 当选时拥有 m2。
- **场景二**：A 问 epoch 0 的结束位置，B 回答 1（epoch 1 从 offset 1 开始），A 截断 m2 后复制 m3，副本重新一致。m2 丢了，但它本来就只在 `min.insync.replicas=1` 下写入一个副本，这是配置允许的代价。

> [!NOTE]
> Leader Epoch 由 0.11（KIP-101）引入，2.0 前后又修复了若干边界场景（KIP-279）。较新的版本中，Follower 在 Fetch 请求里直接携带 `lastFetchedEpoch`，由 Leader 在响应中返回分叉点（diverging epoch），不再单独发 OffsetsForLeaderEpoch 请求，但思想完全相同。KRaft 的元数据日志复制也采用同样的机制。

## acks 与 min.insync.replicas

| acks | 应答时机 | 可能丢失的情况 | 吞吐 / 延迟 |
| --- | --- | --- | --- |
| `0` | 发出即认为成功 | 网络失败、Broker 宕机都会丢 | 最高 / 最低 |
| `1` | Leader 写入本地日志（PageCache）即应答 | Leader 应答后、Follower 同步前宕机 | 高 |
| `all`（`-1`） | ISR 中所有副本都写入 | ISR 只剩 Leader 时退化为 acks=1 | 较低 |

`acks=all` 的语义是「**当前 ISR** 全部写入」，而 ISR 可能缩到只剩 Leader。所以必须配合 Topic / Broker 级别的 `min.insync.replicas`（默认 1）：ISR 数量小于该值时，`acks=all` 的写入直接失败，返回 `NotEnoughReplicasException`。

| 副本数 | min.insync.replicas | 效果 |
| --- | --- | --- |
| 3 | 1（默认） | 只剩 Leader 也能写，`acks=all` 名存实亡 |
| 3 | **2（推荐）** | 允许挂 1 个副本仍可写，且每条消息至少 2 份 |
| 3 | 3 | 任何一个副本故障都无法写入，可用性差 |

> [!CAUTION]
> `min.insync.replicas` 只对 `acks=all` 的生产者生效。`acks=1` 的生产者在 ISR 不足时仍能写成功，所以「Broker 配了 min.insync=2 就不会丢」是误解，两边必须同时配。

## unclean.leader.election.enable

当 ISR 内所有副本都挂了，只剩 OSR 中落后的副本存活时：

- `false`（0.11 起默认）：分区保持不可用，直到某个 ISR 副本恢复。**一致性优先**。
- `true`：允许落后副本当选 Leader，分区立即可用，但它缺失的消息永久丢失，原 Leader 恢复后还会被截断。**可用性优先**，适合日志、监控指标等可容忍丢失的场景。

> [!NOTE]
> 可以对单个 Topic 覆盖该配置；3.x 中也可以用 `kafka-leader-election.sh --election-type unclean` 对指定分区手动执行一次脏选举，作为故障时的人工决策。KRaft 后续版本引入的 Eligible Leader Replicas（KIP-966）进一步缩小了「ISR 全挂」时的数据丢失窗口，具体可用版本以官方发布说明为准。

## 幂等生产者

问题：生产者发送成功、但响应在网络中丢失，生产者重试导致 Broker 写入两份。

机制（0.11 引入，3.0 起默认开启）：

- 生产者初始化时从 Broker 获取 **PID（Producer ID）** 和 **producer epoch**。
- 对每个 `<PID, 分区>` 维护单调递增的 **序列号**，写在 RecordBatch 头中。
- Broker 为每个 `<PID, 分区>` 缓存最近 **5 个**批次的序列号元数据：
  - 序列号 = 上次 + 1：正常写入。
  - 序列号是已存在的重复批次：不重复写入，直接返回成功。
  - 序列号跳跃：返回 `OutOfOrderSequenceException`。

正因为只缓存 5 个批次，所以要求 `max.in.flight.requests.per.connection ≤ 5`；在这个范围内，即使前面的批次失败重试，Broker 也会拒绝乱序的后续批次，**同时保证不重复和分区内有序**。

局限：

- **单分区**：不同分区之间没有原子性。
- **单会话**：生产者重启后 PID 改变，重启前后的重复无法识别。
- 只解决「Kafka 内部重试」造成的重复，不能解决业务层重复调用 `send()`。

## 事务与 Exactly-Once

事务解决的是：**跨多个分区的写入原子化**，以及「消费位点提交 + 结果写入」原子化（consume-transform-produce）。

```java
// Kafka 3.x：读 → 处理 → 写 的事务闭环
props.put("transactional.id", "order-enricher-" + instanceIndex); // 稳定且每个实例唯一
producer.initTransactions();          // 获取 PID，epoch+1，隔离（fence）同 id 的僵尸实例

while (running) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(200));
    if (records.isEmpty()) continue;
    producer.beginTransaction();
    try {
        for (ConsumerRecord<String, String> r : records) {
            producer.send(new ProducerRecord<>("orders-enriched", r.key(), enrich(r.value())));
        }
        // 把消费位点作为事务的一部分提交（消费者需关闭自动提交）
        producer.sendOffsetsToTransaction(nextOffsets(records), consumer.groupMetadata());
        producer.commitTransaction();
    } catch (ProducerFencedException e) {
        producer.close();             // 被新实例隔离，只能退出
        break;
    } catch (KafkaException e) {
        producer.abortTransaction();  // 中止后需要把消费位置回退到上次提交处重新处理
        resetToCommittedOffsets(consumer);
    }
}
```

内部流程：

1. **事务协调器**：`transactional.id` 哈希到内部 Topic `__transaction_state` 的某个分区，该分区 Leader 就是协调器，事务状态（Ongoing / PrepareCommit / CompleteCommit 等）持久化在这个 Topic 中，协调器故障可恢复。
2. **首次写某分区前**，生产者向协调器登记该分区（AddPartitionsToTxn）。
3. 消息正常写入各分区，但处于「未决」状态。
4. **提交时**：协调器先把状态写为 PrepareCommit（此后无论如何都会提交成功），再向所有涉及的分区写入 **COMMIT 控制标记**，最后写 CompleteCommit。
5. **消费端**：`isolation.level=read_committed` 时，消费者最多只能读到 **LSO（Last Stable Offset，第一个未决事务之前的位置）**，并借助 `.txnindex` 过滤掉已中止事务的消息；默认 `read_uncommitted` 能看到所有消息。

僵尸隔离：同一个 `transactional.id` 的新实例调用 `initTransactions()` 时 epoch 加 1，旧实例（如长时间 GC 后醒来）再提交会收到 `ProducerFencedException`。

### Exactly-Once 的边界

| 场景 | 能否 EOS | 做法 |
| --- | --- | --- |
| 生产者 → Kafka，单分区 | 去重层面可以 | 幂等生产者 |
| Kafka → 处理 → Kafka | 可以 | 事务 + `sendOffsetsToTransaction` + `read_committed`；Kafka Streams 设置 `processing.guarantee=exactly_once_v2` |
| Kafka → 外部 DB / 服务 | **Kafka 本身做不到** | 消费端幂等；或把 offset 与业务结果存到同一个 DB 事务里，启动时从 DB 读取 offset 并 `seek` |
| 业务调用方 → 生产者 | 做不到 | 业务唯一键去重 |

> [!WARNING]
> 事务有成本：每次提交都要写控制标记和事务日志，事务太小会严重拖慢吞吐；事务太大（`transaction.timeout.ms` 默认 60s 以内）又会让 `read_committed` 消费者因 LSO 停滞而延迟上升。一个未结束的「悬挂事务」会卡住整个分区的 LSO，表现为 read_committed 消费者 lag 只增不减。

## 消费端 at-least-once 的正确写法

```java
props.put("enable.auto.commit", "false");
props.put("max.poll.records", "200");               // 保证一批能在 max.poll.interval.ms 内处理完

while (running) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(500));
    Map<TopicPartition, OffsetAndMetadata> toCommit = new HashMap<>();
    for (ConsumerRecord<String, String> r : records) {
        try {
            idempotentHandle(r);                     // 业务幂等
        } catch (RetryableException e) {
            throw e;                                 // 不提交，交给外层重试/重启后重新消费
        } catch (Exception e) {
            deadLetterProducer.send(toDlt(r, e));    // 不可重试错误：进死信，不阻塞分区
        }
        toCommit.put(new TopicPartition(r.topic(), r.partition()),
                     new OffsetAndMetadata(r.offset() + 1));   // 提交的是下一条的位置
    }
    if (!toCommit.isEmpty()) consumer.commitSync(toCommit);    // 处理完成后再提交
}
```

要点：处理完成后才提交；提交的是 `offset + 1`；失败的消息要么阻塞重试、要么转死信，不能静默跳过；业务必须幂等；Rebalance 回调中提交已处理的位点。

## 「不丢消息」配置清单

| 位置 | 配置 | 推荐值 | 作用 |
| --- | --- | --- | --- |
| 生产者 | `acks` | `all` | 等待 ISR 全部写入 |
| 生产者 | `enable.idempotence` | `true` | 重试不重复、不乱序 |
| 生产者 | `retries` / `delivery.timeout.ms` | 默认（无限 / 120s）或按业务调大 | 覆盖 Leader 切换的时间窗 |
| 生产者 | `max.in.flight.requests.per.connection` | ≤ 5 | 幂等保序的前提 |
| 生产者 | 发送回调 | 检查异常并落库补偿 | 兜住最终失败 |
| Broker / Topic | `replication.factor` | 3 | 多副本 |
| Broker / Topic | `min.insync.replicas` | 2 | 配合 acks=all |
| Broker / Topic | `unclean.leader.election.enable` | `false` | 禁止落后副本当选 |
| Broker | `default.replication.factor` / `offsets.topic.replication.factor` | 3 | 避免自动创建的 Topic 和位点 Topic 只有 1 副本 |
| Broker | 机架感知 `broker.rack` | 按机架 / 可用区配置 | 副本分散在不同故障域 |
| 消费者 | `enable.auto.commit` | `false` | 处理成功后手动提交 |
| 消费者 | `auto.offset.reset` | 视业务（通常 `earliest`） | 位点丢失时不跳过数据 |
| 消费者 | `isolation.level` | 用事务时 `read_committed` | 不读未提交 / 已中止数据 |

## 性能调优参数

| 位置 | 参数 | 默认 | 调优方向 |
| --- | --- | --- | --- |
| 生产者 | `batch.size` | 16KB | 吞吐优先调到 64KB～256KB |
| 生产者 | `linger.ms` | 0（4.0 为 5） | 5～50ms，换取更大批次 |
| 生产者 | `compression.type` | none | `lz4` / `zstd` |
| 生产者 | `buffer.memory` | 32MB | 分区多、批次大时调大 |
| Broker | `num.network.threads` | 3 | 连接多、请求多时调大 |
| Broker | `num.io.threads` | 8 | 按磁盘数量调整 |
| Broker | `num.replica.fetchers` | 1 | 副本同步跟不上时调大 |
| Broker | `log.dirs` | — | 多块盘分别挂载，分区分散在多个目录 |
| 消费者 | `fetch.min.bytes` / `fetch.max.wait.ms` | 1 / 500ms | 增大 min.bytes 提高批量，代价是延迟 |
| 消费者 | `max.poll.records` | 500 | 处理慢时调小，避免超时 Rebalance |
| 消费者 | `max.partition.fetch.bytes` | 1MB | 大消息时调大 |
| OS | `vm.swappiness`、文件句柄、`vm.max_map_count` | — | 降低 swap；分区多时提高句柄和 mmap 数量上限 |

## 常见线上问题

**Rebalance 风暴**

- 现象：消费者组反复进入 PreparingRebalance，消费 lag 锯齿状上升，日志大量 `Attempt to heartbeat failed since group is rebalancing`。
- 原因：处理超时（超过 `max.poll.interval.ms`）→ 被踢出 → 重新加入 → 再次超时；或者实例 Full GC 导致心跳超时；或者滚动发布。
- 处理：调小 `max.poll.records`、优化处理逻辑；静态成员 `group.instance.id`；`CooperativeStickyAssignor`；监控 GC。

**消费延迟持续上升**

- 用 `kafka-consumer-groups.sh --describe --group xxx` 看每个分区的 LAG：只有个别分区高 → 数据倾斜或该分区的消费线程卡住（看线程栈）；所有分区都高 → 整体消费能力不足或下游变慢。
- 也要检查 Broker 侧：磁盘 IO 打满、PageCache 未命中导致读磁盘。

**磁盘打满**

- 原因：保留期 / 保留大小配置过大、流量突增、未来时间戳导致 segment 不过期、副本重分配期间数据翻倍、compact Topic 清理不动。
- 应急：临时调小 Topic 的 `retention.ms`（动态生效）；迁移部分分区到其它磁盘或 Broker（`kafka-reassign-partitions.sh`，注意限流）；**不要手动删 segment 文件**。
- 磁盘写满后 Broker 会把该日志目录标记为离线，上面的分区 Leader 迁走，引发连锁反应。

**ISR 频繁收缩扩张**

- 现象：监控 `IsrShrinksPerSec` / `IsrExpandsPerSec` 持续非零，`acks=all` 的生产延迟抖动，`min.insync=2` 时出现 `NotEnoughReplicas`。
- 原因：Follower 所在 Broker 负载高、磁盘慢、网络带宽打满、副本同步线程不足。

## 相关阅读

- [Kafka 架构与存储](#/mw/kafka)：Kafka 架构与存储
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：Outbox、幂等消费与死信
- [文件系统、页缓存与零拷贝](#/cs/os-io)：页缓存、顺序写与刷盘
- [消息队列核心问题](#/mw/mq)：消息队列通用问题
- [Kafka 生产运维：容量规划、Rebalance 治理与故障排查](#/mw/kafka-ops)：运维与故障排查

## 面试追问

> [!QUESTION] acks=all 一定不会丢消息吗？
> 不一定。`acks=all` 等的是当前 ISR，ISR 只剩 Leader 时等同于 acks=1，必须配合 `min.insync.replicas>=2`；开启 unclean 选举时落后副本当选也会丢；所有副本同时掉电且数据都只在 PageCache 也会丢（Kafka 默认不同步刷盘）；另外消费端提前提交位点同样表现为丢消息。

> [!QUESTION] HW 已经能表示提交位置了，为什么还需要 Leader Epoch？
> HW 在 Follower 上滞后一轮 Fetch 才更新，用 HW 作截断依据会在「重启后立即发生 Leader 切换」时误删已提交的消息，或在多副本同时宕机后出现数据分叉。Leader Epoch 记录每个任期的起始 offset，Follower 按「自己最后任期在 Leader 上的结束位置」截断，截断点由 Leader 的真实日志决定，与 HW 是否滞后无关。

> [!QUESTION] 幂等生产者为什么要求 max.in.flight ≤ 5？
> Broker 端为每个 PID + 分区只缓存最近 5 个批次的序列号元数据，用于识别重复批次和判断乱序。in-flight 超过 5 时，重试的批次可能已不在缓存中，Broker 无法判断是否重复；在 5 以内，Broker 能拒绝序列号不连续的批次，让客户端按序重发，所以同时保证幂等和有序。

> [!QUESTION] Kafka 事务能保证写数据库和发消息的一致性吗？
> 不能。Kafka 事务只能让多个 Kafka 分区的写入以及消费位点提交原子化，数据库不参与 Kafka 的两阶段提交。DB 与消息的一致性要靠本地消息表、CDC（Debezium 读 binlog 发 Kafka）或 Outbox 模式；消费写 DB 则靠幂等或把 offset 与业务数据放在同一个 DB 事务里。

> [!QUESTION] read_committed 的消费者为什么会出现延迟突然变大？
> read_committed 只能读到 LSO 之前的数据，只要分区上有一个事务迟迟不提交或中止（生产者卡住、悬挂事务），LSO 就停在那里，后面即使是已提交的消息也读不到，lag 持续增长。排查用 `kafka-transactions.sh` 查看进行中的事务，必要时中止悬挂事务。
