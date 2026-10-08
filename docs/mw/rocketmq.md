---
level: 深入
tags: [RocketMQ, NameServer, CommitLog, ConsumeQueue, 事务消息, 延迟消息, 顺序消息, 死信队列]
summary: RocketMQ 4.x/5.x 的架构与存储设计（CommitLog + ConsumeQueue + IndexFile）、刷盘与复制、事务消息回查、延迟/顺序/重试/过滤机制，以及与 Kafka 的取舍
---

# RocketMQ 原理与事务消息

> [!ABSTRACT] 核心要点
> - 架构由 **NameServer（无状态路由中心）+ Broker 主从 + Producer + Consumer** 组成；NameServer 之间互不通信，路由信息靠 Broker 定期注册、客户端定期拉取，是一个 AP 设计。
> - 存储是「**单一 CommitLog 顺序写 + 每个队列一个 ConsumeQueue 逻辑索引 + IndexFile 按 key 查询**」；与 Kafka 每分区一个日志相比，Topic 再多也是顺序写，但读取需要多一次索引跳转。
> - 可靠性由**刷盘策略**（同步 / 异步）和**复制策略**（同步 / 异步主从）组合决定；高可用从手动主从切换演进为 DLedger（4.5）和 5.x Controller 模式自动切换。
> - **事务消息** = 半消息 + 本地事务 + Commit/Rollback + Broker 回查，解决「本地事务与发消息」的一致性，消费端仍需幂等。
> - 延迟消息 4.x 只支持 18 个固定级别，5.x 支持任意时间的定时消息；顺序消费依赖**Broker 队列锁 + 客户端队列锁**；失败消息走 `%RETRY%` 重试队列，超过次数进入 `%DLQ%` 死信队列。

## 整体架构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="RocketMQ 架构：Broker 主从向所有 NameServer 注册，生产者和消费者从 NameServer 拉取路由后直连 Broker">
<rect class="bg" x="230" y="16" width="300" height="70" rx="12"/>
<text class="ts" x="242" y="32">NameServer 集群（无状态，彼此不通信）</text>
<rect class="b5" x="250" y="40" width="120" height="36" rx="8"/>
<text class="tb" x="310" y="58" text-anchor="middle" dominant-baseline="middle">NameServer 1</text>
<rect class="b5" x="390" y="40" width="120" height="36" rx="8"/>
<text class="tb" x="450" y="58" text-anchor="middle" dominant-baseline="middle">NameServer 2</text>
<line class="ld" x1="380" y1="126" x2="380" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="390" y="110">每 30s 注册 / 心跳</text>
<rect class="bg" x="180" y="126" width="400" height="160" rx="12"/>
<text class="ts" x="192" y="142">Broker 集群</text>
<rect class="b1" x="200" y="152" width="170" height="40" rx="8"/>
<text class="tb" x="285" y="172" text-anchor="middle" dominant-baseline="middle">broker-a Master</text>
<line class="l" x1="285" y1="192" x2="285" y2="220" marker-end="url(#arr)"/>
<text class="ts" x="293" y="210">复制</text>
<rect class="b" x="200" y="220" width="170" height="40" rx="8"/>
<text class="tb" x="285" y="240" text-anchor="middle" dominant-baseline="middle">broker-a Slave</text>
<rect class="b1" x="390" y="152" width="170" height="40" rx="8"/>
<text class="tb" x="475" y="172" text-anchor="middle" dominant-baseline="middle">broker-b Master</text>
<line class="l" x1="475" y1="192" x2="475" y2="220" marker-end="url(#arr)"/>
<text class="ts" x="483" y="210">复制</text>
<rect class="b" x="390" y="220" width="170" height="40" rx="8"/>
<text class="tb" x="475" y="240" text-anchor="middle" dominant-baseline="middle">broker-b Slave</text>
<text class="ts" x="380" y="278" text-anchor="middle">brokerId=0 为 Master，大于 0 为 Slave</text>
<rect class="b3" x="20" y="152" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="177" text-anchor="middle" dominant-baseline="middle">Producer</text>
<line class="l" x1="140" y1="172" x2="200" y2="172" marker-end="url(#arr)"/>
<text class="ts" x="170" y="164" text-anchor="middle">发送</text>
<line class="ld" x1="80" y1="152" x2="248" y2="66" marker-end="url(#arr)"/>
<text class="ts" x="96" y="108">拉取路由</text>
<rect class="b2" x="620" y="152" width="120" height="50" rx="8"/>
<text class="tb" x="680" y="177" text-anchor="middle" dominant-baseline="middle">Consumer</text>
<line class="l" x1="560" y1="182" x2="620" y2="182" marker-end="url(#arr)"/>
<text class="ts" x="680" y="222" text-anchor="middle">长轮询拉取</text>
<line class="ld" x1="680" y1="152" x2="512" y2="66" marker-end="url(#arr)"/>
<text class="ts" x="664" y="108" text-anchor="end">拉取路由</text>
<text class="ts" x="380" y="308" text-anchor="middle">5.x 可在客户端与 Broker 之间加入无状态 Proxy（gRPC），见下文</text>
</svg>
<figcaption>图 1：RocketMQ 4.x 经典部署架构</figcaption>
</figure>

| 组件 | 职责 | 关键机制 |
| --- | --- | --- |
| NameServer | Topic 路由注册中心 | Broker 每 30s 向**所有** NameServer 发送心跳（含 Topic 配置）；NameServer 每 10s 扫描，超过 120s 无心跳的 Broker 被剔除 |
| Broker | 存储消息、处理读写、维护消费位点 | 一组 Master/Slave 共享 brokerName；Master 读写，Slave 同步数据，Master 繁忙时可分担读 |
| Producer | 发送消息 | 每 30s 从 NameServer 拉取路由；选择 MessageQueue 发送，支持故障延迟规避（`sendLatencyFaultEnable`） |
| Consumer | 消费消息 | 消费组内按队列做负载均衡（客户端每 20s 重新均衡）；集群模式下位点存在 Broker |

**为什么不用 ZooKeeper？** RocketMQ 认为路由信息允许短暂不一致：Broker 宕机后 NameServer 最长要 2 分钟才剔除，客户端最长 30s 才感知，但生产者有重试和故障规避，消费者有重新均衡，短暂的路由过期不影响正确性。用 AP 的无状态 NameServer 换来极简的部署和无单点。

**高可用演进**：

| 方案 | 版本 | 特点 |
| --- | --- | --- |
| Master/Slave | 4.x 早期 | Master 宕机后不能自动切换，Slave 只能读，该组无法写入新消息（生产者会转向其它 Broker 组） |
| DLedger | 4.5+ | 基于 Raft 复制 CommitLog，自动选主；至少 3 副本 |
| Controller 模式 | 5.x | 独立（或内嵌于 NameServer）的 Controller 负责选主，Broker 间维护类似 ISR 的 SyncStateSet，支持 2 副本自动切换 |

## 存储设计

<figure class="fig">
<svg viewBox="0 0 760 305" class="dg" role="img" aria-label="所有 Topic 的消息顺序追加到 CommitLog，后台线程异步构建每个队列的 ConsumeQueue 定长索引和按 key 查询的 IndexFile">
<text class="ts" x="20" y="30">所有 Topic 的消息顺序追加到同一组 CommitLog 文件（单个 1GB，文件名为起始物理偏移）</text>
<text class="tb" x="20" y="70" dominant-baseline="middle">CommitLog</text>
<rect class="b1" x="120" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="170" y="70" text-anchor="middle" dominant-baseline="middle">TopicA m1</text>
<rect class="b3" x="224" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="274" y="70" text-anchor="middle" dominant-baseline="middle">TopicB m1</text>
<rect class="b1" x="328" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="378" y="70" text-anchor="middle" dominant-baseline="middle">TopicA m2</text>
<rect class="b5" x="432" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="482" y="70" text-anchor="middle" dominant-baseline="middle">TopicC m1</text>
<rect class="b1" x="536" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="586" y="70" text-anchor="middle" dominant-baseline="middle">TopicA m3</text>
<rect class="b" x="640" y="50" width="100" height="40" rx="4"/>
<text class="tm" x="690" y="70" text-anchor="middle" dominant-baseline="middle">写入点 →</text>
<text class="ts" x="380" y="116" text-anchor="middle">ReputMessageService 异步分发：构建 ConsumeQueue 与 IndexFile</text>
<rect class="bg" x="20" y="130" width="390" height="165" rx="12"/>
<text class="ts" x="32" y="148">ConsumeQueue：TopicA / queueId=0</text>
<line class="la" x1="60" y1="152" x2="160" y2="90" marker-end="url(#arr-a)"/>
<text class="tm" x="40" y="172">phyOffset 8B</text>
<text class="tm" x="200" y="172">size 4B</text>
<text class="tm" x="290" y="172">tagHash 8B</text>
<rect class="b1" x="36" y="180" width="150" height="26" rx="4"/>
<text class="tm" x="111" y="193" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b" x="192" y="180" width="86" height="26" rx="4"/>
<text class="tm" x="235" y="193" text-anchor="middle" dominant-baseline="middle">180</text>
<rect class="b" x="284" y="180" width="110" height="26" rx="4"/>
<text class="tm" x="339" y="193" text-anchor="middle" dominant-baseline="middle">hash(TagX)</text>
<rect class="b1" x="36" y="212" width="150" height="26" rx="4"/>
<text class="tm" x="111" y="225" text-anchor="middle" dominant-baseline="middle">380</text>
<rect class="b" x="192" y="212" width="86" height="26" rx="4"/>
<text class="tm" x="235" y="225" text-anchor="middle" dominant-baseline="middle">220</text>
<rect class="b" x="284" y="212" width="110" height="26" rx="4"/>
<text class="tm" x="339" y="225" text-anchor="middle" dominant-baseline="middle">hash(TagY)</text>
<rect class="b1" x="36" y="244" width="150" height="26" rx="4"/>
<text class="tm" x="111" y="257" text-anchor="middle" dominant-baseline="middle">790</text>
<rect class="b" x="192" y="244" width="86" height="26" rx="4"/>
<text class="tm" x="235" y="257" text-anchor="middle" dominant-baseline="middle">190</text>
<rect class="b" x="284" y="244" width="110" height="26" rx="4"/>
<text class="tm" x="339" y="257" text-anchor="middle" dominant-baseline="middle">hash(TagX)</text>
<text class="ts" x="215" y="286" text-anchor="middle">每条 20 字节定长，逻辑 offset × 20 直接定位</text>
<rect class="bg" x="430" y="130" width="310" height="165" rx="12"/>
<text class="ts" x="442" y="148">IndexFile：按 Key / 时间区间查询</text>
<line class="ld" x1="585" y1="152" x2="590" y2="90" marker-end="url(#arr)"/>
<rect class="b" x="450" y="160" width="270" height="28" rx="4"/>
<text class="tm" x="585" y="174" text-anchor="middle" dominant-baseline="middle">Header 40B</text>
<rect class="b3" x="450" y="196" width="270" height="28" rx="4"/>
<text class="tm" x="585" y="210" text-anchor="middle" dominant-baseline="middle">Hash 槽 500 万 × 4B</text>
<rect class="b2" x="450" y="232" width="270" height="28" rx="4"/>
<text class="tm" x="585" y="246" text-anchor="middle" dominant-baseline="middle">Index 条目 2000 万 × 20B</text>
<text class="ts" x="585" y="286" text-anchor="middle">hash(key) → 槽 → 条目链 → phyOffset</text>
</svg>
<figcaption>图 2：CommitLog、ConsumeQueue 与 IndexFile 的关系</figcaption>
</figure>

- **CommitLog**：存放消息完整内容，所有 Topic 混写、严格顺序追加，单文件默认 1GB，用 mmap（`MappedFile`）映射。写入时加锁（自旋锁或可重入锁，`useReentrantLockWhenPutMessage`）保证顺序。
- **ConsumeQueue**：每个 `Topic + queueId` 一个目录（`consumequeue/{topic}/{queueId}/`），每条 20 字节：CommitLog 物理偏移（8B）+ 消息大小（4B）+ Tag 哈希（8B）。单文件 30 万条（约 5.72MB）。消费者的「逻辑 offset」就是 ConsumeQueue 下标，`下标 × 20` 即可 O(1) 定位，再到 CommitLog 读取正文。
- **IndexFile**：按消息 Key 或 msgId 查询（控制台查消息、排查问题），结构类似磁盘上的 HashMap：40B 头 + 500 万哈希槽 + 2000 万个 20B 条目（keyHash、phyOffset、时间差、前一条目下标，冲突时链式串起来），单文件约 400MB。
- **ReputMessageService**：后台线程不断从 CommitLog 读取新消息，分发构建 ConsumeQueue 和 IndexFile。ConsumeQueue 是可以从 CommitLog **重建**的派生数据，所以只需要保证 CommitLog 可靠。

### 与 Kafka 存储对比

| 维度 | Kafka | RocketMQ |
| --- | --- | --- |
| 数据文件 | 每个分区一组 segment | 全部 Topic 共用 CommitLog |
| Topic / 分区很多时 | 文件数增多，顺序写退化为随机写，性能下降明显 | 写入始终是单文件顺序写，对海量 Topic 更友好 |
| 读取 | 按分区直接顺序读 | 先读 ConsumeQueue 再随机读 CommitLog，依赖 PageCache 命中 |
| 索引 | 稀疏 offset / 时间索引 | 定长 ConsumeQueue + 按 Key 的 IndexFile |
| 消息查询 | 只能按 offset / 时间 | 支持按 Key、msgId 查询 |
| 数据删除 | 按分区 segment 过期删除 | 按 CommitLog 文件过期删除（默认保留 72 小时，`fileReservedTime`），不区分 Topic |

> [!NOTE]
> 这也是选型时常说的「Kafka 分区数多了性能下降、RocketMQ 支持海量 Topic」的根源。但 RocketMQ 的读路径更依赖 PageCache：消费者读取冷数据时会产生大量 CommitLog 随机读，回溯消费对 Broker 冲击更大。

## 刷盘与主从同步

| 配置 | 取值 | 含义 |
| --- | --- | --- |
| `flushDiskType` | `ASYNC_FLUSH`（默认） | 写入 PageCache 即返回，后台线程定期刷盘（默认约 500ms 一次） |
| | `SYNC_FLUSH` | `GroupCommitService` 批量刷盘后才返回，吞吐下降、延迟上升 |
| `brokerRole` | `ASYNC_MASTER`（默认） | 写入 Master 即返回，Slave 异步复制 |
| | `SYNC_MASTER` | Slave 也写入成功才返回 |
| | `SLAVE` | 从节点 |

常见组合：

- **异步刷盘 + 同步复制**：生产中最常用的折中。单机掉电依靠 Slave 保底，性能损失可控。
- **同步刷盘 + 同步复制**：金融级，性能最低。
- **异步刷盘 + 异步复制**：性能最好，Master 宕机且磁盘损坏时可能丢少量消息。

> [!TIP]
> 异步刷盘还可以开启 `transientStorePoolEnable`：消息先写入堆外内存池，再批量提交到 FileChannel，实现读写分离，减少 PageCache 锁竞争带来的写入毛刺；代价是 Broker 进程崩溃时堆外数据会丢。

## 事务消息

<figure class="fig">
<svg viewBox="0 0 760 400" class="dg" role="img" aria-label="事务消息流程：发送半消息，执行本地事务，提交或回滚，状态未知时 Broker 回查生产者">
<rect class="b3" x="50" y="20" width="140" height="40" rx="8"/>
<text class="tb" x="120" y="40" text-anchor="middle" dominant-baseline="middle">Producer</text>
<rect class="b1" x="310" y="20" width="140" height="40" rx="8"/>
<text class="tb" x="380" y="40" text-anchor="middle" dominant-baseline="middle">Broker</text>
<rect class="b2" x="570" y="20" width="140" height="40" rx="8"/>
<text class="tb" x="640" y="40" text-anchor="middle" dominant-baseline="middle">Consumer</text>
<line class="ld" x1="120" y1="60" x2="120" y2="385"/>
<line class="ld" x1="380" y1="60" x2="380" y2="385"/>
<line class="ld" x1="640" y1="60" x2="640" y2="385"/>
<line class="l" x1="120" y1="100" x2="380" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="250" y="92" text-anchor="middle">① 发送半消息（HALF Topic，不可见）</text>
<line class="l" x1="380" y1="140" x2="120" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="250" y="132" text-anchor="middle">② 半消息写入成功</text>
<rect class="b3" x="60" y="160" width="120" height="30" rx="6"/>
<text class="tb" x="120" y="175" text-anchor="middle" dominant-baseline="middle">③ 执行本地事务</text>
<line class="l" x1="120" y1="230" x2="380" y2="230" marker-end="url(#arr)"/>
<text class="ts" x="250" y="222" text-anchor="middle">④ Commit / Rollback</text>
<text class="ts" x="392" y="226">Rollback：写 Op 记录，不投递</text>
<line class="l" x1="380" y1="280" x2="640" y2="280" marker-end="url(#arr)"/>
<text class="ts" x="510" y="272" text-anchor="middle">⑤ Commit：写入真实 Topic，可消费</text>
<line class="la" x1="380" y1="320" x2="120" y2="320" marker-end="url(#arr-a)"/>
<text class="ts" x="250" y="312" text-anchor="middle">⑥ 超时未决：回查 checkLocalTransaction</text>
<line class="l" x1="120" y1="360" x2="380" y2="360" marker-end="url(#arr)"/>
<text class="ts" x="250" y="352" text-anchor="middle">⑦ 查本地事务记录，返回 COMMIT / ROLLBACK</text>
</svg>
<figcaption>图 3：事务消息的两阶段提交与回查</figcaption>
</figure>

实现细节：

- **半消息**：Broker 把消息的真实 Topic 和 queueId 存到属性里，改写到内部 Topic `RMQ_SYS_TRANS_HALF_TOPIC`，消费者订阅不到。
- **Commit**：从半消息恢复原 Topic，重新写入 CommitLog 投递；同时向 `RMQ_SYS_TRANS_OP_HALF_TOPIC` 写一条 Op 消息，标记该半消息已处理。**Rollback** 只写 Op 消息。RocketMQ 是追加写，不能真的删除半消息，Op 消息相当于「删除标记」。
- **回查**：`TransactionalMessageCheckService` 定期扫描（`transactionCheckInterval`，默认 60s）既没有 Op 记录、又已超过 `transactionTimeOut`（默认 6s）的半消息，向生产者组中**任意一个在线实例**发起回查；超过最大回查次数（`transactionCheckMax`，默认 15）后默认丢弃该半消息（5.x 会转入专门的 Topic 便于人工处理）。

```java
// RocketMQ 4.x 事务生产者
TransactionMQProducer producer = new TransactionMQProducer("order-tx-group");
producer.setTransactionListener(new TransactionListener() {
    @Override
    public LocalTransactionState executeLocalTransaction(Message msg, Object arg) {
        try {
            orderService.createOrderWithTxLog((OrderDTO) arg, msg.getTransactionId()); // 业务 + 事务日志同一本地事务
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (Exception e) {
            return LocalTransactionState.ROLLBACK_MESSAGE;
        }
    }
    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        // 回查：只能依据持久化的业务数据判断，不能依赖内存状态
        return txLogMapper.exists(msg.getTransactionId())
                ? LocalTransactionState.COMMIT_MESSAGE
                : LocalTransactionState.UNKNOW;   // 继续等待下次回查
    }
});
producer.start();
producer.sendMessageInTransaction(new Message("order-created", body), orderDTO);
```

> [!WARNING]
> - `executeLocalTransaction` 里**不要返回 UNKNOW 来「异步处理」**，也不要做耗时的远程调用；本地事务提交后立即返回 COMMIT。
> - 回查接口必须**基于持久化数据**判断：本地事务里顺带写一张事务日志表（以 transactionId 或业务单号为键），回查时查它。仅凭「订单存在」判断，在订单可被删除或有多种消息的场景下会误判。
> - 事务消息只保证「本地事务成功 ⇔ 消息最终可被消费」，**不保证消费成功**；消费失败要靠重试和人工补偿，消费端必须幂等。和其它分布式事务方案的对比见 [分布式事务](#/distributed/transaction)。

## 延迟消息与定时消息

**4.x：18 个固定延迟级别**

```properties
# broker.conf 默认值，level 从 1 开始
messageDelayLevel=1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h
```

发送时 `msg.setDelayTimeLevel(3)`（10s）。Broker 把消息改写到内部 Topic `SCHEDULE_TOPIC_XXXX`，**每个延迟级别对应一个队列**，同一队列内消息的到期时间天然有序，所以每个级别只需一个定时任务按顺序检查队首，到期就恢复原 Topic 重新投递。这就是只支持固定级别的原因：任意时间会破坏队列内的到期有序性。

**5.x：任意时间定时消息**

5.0 起 Broker 内置基于**时间轮（TimerWheel）+ TimerLog** 的定时消息，可以指定任意投递时间戳（`setDeliverTimestamp`），精度为秒级，最大延迟有上限（默认通常为 3 天，可由 `timerMaxDelaySec` 调整）。5.x 中定时消息需要使用消息类型为 DELAY 的 Topic。

> [!CAUTION]
> 大量消息集中在同一时刻到期（例如所有订单都设置 30 分钟后关单，而大促在整点涌入）会在到期时刻形成投递洪峰。可以给到期时间加随机抖动，或者把延迟消息只作为「触发器」，真正的处理逻辑做限流。

## 顺序消息

```java
// 生产端：同一订单的消息选择同一个队列
producer.send(msg, (mqs, message, orderId) -> {
    int index = Math.abs(orderId.hashCode() % mqs.size());
    return mqs.get(index);
}, order.getOrderId());

// 消费端：MessageListenerOrderly 保证同一队列串行消费
consumer.registerMessageListener((MessageListenerOrderly) (msgs, ctx) -> {
    try {
        handle(msgs);
        return ConsumeOrderlyStatus.SUCCESS;
    } catch (Exception e) {
        return ConsumeOrderlyStatus.SUSPEND_CURRENT_QUEUE_A_MOMENT; // 暂停该队列片刻后原地重试
    }
});
```

消费端的「三把锁」：

1. **Broker 端队列锁**：负载均衡分到队列后，消费者先向 Broker 申请锁定该队列（`lockBatchMQ`），锁有过期时间（约 60s），客户端每 20s 续期。保证 Rebalance 过程中同一队列不会同时被两个消费者处理。
2. **客户端 ProcessQueue 锁**：Rebalance 移除队列时，要等正在处理的消息完成才能释放。
3. **消费线程锁**：对 MessageQueue 对象加 `synchronized`，保证同一时刻只有一个线程消费该队列。

> [!WARNING]
> - 顺序发送只能**同步发送**，并且不能开启发送失败重试到其它队列；Broker 宕机时该队列不可写，选择器若换队列就会破坏顺序。
> - 顺序消费失败会阻塞整个队列，默认重试次数非常大，务必设置 `maxReconsumeTimes`，超过后进入死信并告警，否则一条坏消息会让该队列永久卡住。
> - 扩缩队列数会改变 `hash % size` 的结果，期间可能乱序。

## 重试队列与死信队列

- **并发消费**失败（返回 `RECONSUME_LATER`、返回 null 或抛异常）：客户端把消息发回 Broker（`sendMessageBack`），写入 `%RETRY%{消费组}` Topic，延迟级别从 3（10s）开始逐次递增：10s、30s、1m、2m … 1h、2h，默认最多 **16 次**（`maxReconsumeTimes`），总跨度约 4 小时 46 分。
- 重试 Topic 是**按消费组**建立的：同一 Topic 的不同消费组互不影响，只有失败的那个组会重新收到。
- 超过最大次数进入 `%DLQ%{消费组}` 死信 Topic，不再自动消费。死信 Topic 默认权限可能不可读，需在控制台调整权限后再订阅处理。
- **广播模式不支持重试**，失败即丢弃，需要业务自行处理。
- 本地消费失败也可能因为发回 Broker 失败而在客户端本地延迟重试。

## 集群消费与广播消费

| | 集群消费（CLUSTERING，默认） | 广播消费（BROADCASTING） |
| --- | --- | --- |
| 投递 | 一条消息只被组内一个实例消费 | 组内每个实例都消费一次 |
| 位点存储 | Broker（`consumerOffset.json`） | 客户端本地文件 |
| 重试 / 死信 | 支持 | 不支持 |
| 场景 | 绝大多数业务 | 本地缓存刷新、配置下发 |

## 消息过滤

| 方式 | 原理 | 代价 |
| --- | --- | --- |
| Tag | ConsumeQueue 中存 Tag 哈希，Broker 先按哈希过滤，客户端再按字符串精确比对（防哈希冲突） | 几乎无额外开销，**推荐** |
| SQL92 | 基于消息属性写表达式，如 `a > 5 AND b = 'abc'`；Broker 需开启 `enablePropertyFilter=true` | Broker 要读取消息属性计算，开销较大 |

> [!CAUTION]
> **同一消费组内所有实例的订阅关系必须完全一致**（相同 Topic、相同 Tag）。若实例 1 订阅 `TagA`、实例 2 订阅 `TagB`，负载均衡按组分配队列，实例 1 拿到的队列中的 TagB 消息会被它过滤掉并提交位点——这些消息就「丢」了。这是 RocketMQ 最经典的线上事故之一。

## 5.x：Proxy、Pop 与存算分离

- **Proxy**：新增无状态的 Proxy 层，承担协议适配（gRPC，多语言轻量客户端）、权限、流量治理；Broker 专注存储。可以独立部署（Cluster 模式），也可以和 Broker 同进程（Local 模式）。
- **Pop 消费 / SimpleConsumer**：4.x 的消费者与队列强绑定，单个消费者卡住会导致其队列积压，且消费者数受队列数限制。5.x 的 Pop 模式由 Broker 端分配消息，消费者 `receive` → 处理 → `ack`，未 ack 的消息在不可见时间到期后重新投递，消费者数量可以超过队列数。
- **消息类型显式化**：Topic 声明消息类型（NORMAL / FIFO / DELAY / TRANSACTION），发送不匹配类型的消息会被拒绝。
- **分层存储**：较新的 5.x 版本支持把冷数据卸载到对象存储，降低本地磁盘成本。

> [!NOTE]
> 4.x 的 Remoting 客户端（`DefaultMQProducer` / `DefaultMQPushConsumer`）仍可连接 5.x Broker；新项目建议使用 5.x 的 gRPC 客户端（`rocketmq-client-java`），API 风格完全不同。

## 与 Kafka 的选型对比

| 维度 | Kafka | RocketMQ |
| --- | --- | --- |
| 吞吐 | 更高，适合海量日志 | 高，适合业务消息 |
| Topic 数量 | 分区多时性能下降 | 支持海量 Topic |
| 事务 | 面向流处理的 EOS | 面向业务的事务消息（半消息 + 回查） |
| 延迟消息 | 无原生支持 | 4.x 固定级别，5.x 任意时间 |
| 重试 / 死信 | 需自行实现（或借助 Spring Kafka） | 内置 |
| 消息查询 | 按 offset / 时间 | 按 Key、msgId |
| 过滤 | 客户端过滤 | Broker 端 Tag / SQL92 |
| 生态 | 流计算、CDC、数据湖的事实标准 | Java 业务系统、阿里云生态 |

一句话：**数据管道选 Kafka，业务消息选 RocketMQ**。更通用的选型讨论见 [消息队列核心问题](#/mw/mq)。

## 生产实践与踩坑

- **broker busy**：日志出现 `[PC_SYNCHRONIZED]broker busy` 或 `[TIMEOUT_CLEAN_QUEUE]broker busy`，前者表示写 PageCache 加锁时间超过阈值（`osPageCacheBusyTimeOutMills`，默认约 1s），后者表示请求在发送线程池队列里等待过久被快速失败。通常是磁盘 IO 抖动或内存不足导致的页回收；可以开启 `transientStorePoolEnable`、扩容 Broker，生产者侧依靠重试和故障规避。
- **生产环境关闭自动创建 Topic**（`autoCreateTopicEnable=false`）：自动创建的 Topic 只会出现在最先收到消息的 Broker 上，后续流量无法均衡。
- **消息大小**：默认上限约 4MB（`maxMessageSize`），大对象放 OSS。
- **消费组订阅不一致**：见上文，排查时在控制台查看消费组各实例的订阅关系。
- **新消费组的起始位置**：`ConsumeFromWhere` 只对 Broker 上没有位点记录的新消费组生效。4.x 中即使配置 `CONSUME_FROM_LAST_OFFSET`，如果队列的历史消息从未被清理过（最小逻辑 offset 仍为 0 且数据还在内存中），Broker 也可能让新组从头消费，造成「一上线就收到大量旧消息」。首次上线要确认是否允许消费历史消息，必要时先在控制台重置位点。
- **消息 Key**：务必为每条消息设置业务唯一 Key（`msg.setKeys(orderId)`），方便通过 IndexFile 查询消息轨迹，也可直接作为幂等键。
- **消息堆积监控**：关注消费组的 Diff Total（堆积量）和消费 TPS，结合死信 Topic 数量告警。

## 面试追问

> [!QUESTION] RocketMQ 为什么所有 Topic 共用一个 CommitLog？有什么代价？
> 为了保证写入始终是单文件顺序写，Topic 和队列再多也不会退化为随机写，这是它支持海量 Topic 的基础。代价是读取要先查 ConsumeQueue 再随机读 CommitLog，冷数据读取性能依赖 PageCache；数据过期按文件整体删除，无法按 Topic 设置不同保留期；所有 Topic 共享 IO，一个大流量 Topic 会影响其他 Topic。

> [!QUESTION] 事务消息的回查是怎么触发的？回查接口应该怎么写？
> Broker 定时扫描 HALF Topic，对没有 Op 记录且超过事务超时时间的半消息，向生产者组任一在线实例发回查请求，最多回查若干次（默认 15）。回查实现必须依据持久化数据判断，通常在本地事务里写一条事务日志（transactionId / 业务单号），回查时查表：存在则 COMMIT，确认不存在且已超时则 ROLLBACK，不确定返回 UNKNOW。

> [!QUESTION] 为什么 4.x 的延迟消息只支持固定级别？5.x 怎么做到任意时间？
> 4.x 把同一级别的消息放在同一个队列里，入队顺序就是到期顺序，定时任务只需检查队首，实现简单高效；任意时间会破坏这个有序性。5.x 用时间轮 + TimerLog：消息按到期时间挂到时间轮的槽位上，指针走到该槽时取出到期消息投递，实现任意时间点，代价是额外的存储和更复杂的恢复逻辑。

> [!QUESTION] RocketMQ 如何保证顺序消费？Rebalance 期间会不会乱序？
> 生产端用 MessageQueueSelector 把同一业务键发到同一队列；消费端使用 MessageListenerOrderly，消费者先向 Broker 申请队列锁并定期续期，再在本地对队列加锁串行处理。Rebalance 时，新消费者必须拿到 Broker 端的队列锁才能消费，而旧消费者在释放队列前会等待正在处理的消息完成，因此不会两个实例同时消费同一队列；但旧实例处理完未提交位点的消息会被新实例重复消费，所以仍需幂等。

> [!QUESTION] 同步刷盘 + 异步复制、异步刷盘 + 同步复制，哪个更可靠？
> 要看故障模型。整机房掉电时，异步刷盘的主从都可能丢 PageCache 中的数据，同步刷盘更可靠；单机故障（磁盘损坏、宕机无法恢复）时，同步复制保证数据至少在两台机器上，更可靠。生产中更常见的选择是「异步刷盘 + 同步复制」，用多副本代替每条 fsync，兼顾性能与可靠性。
