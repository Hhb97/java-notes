---
level: 进阶
tags: [消息队列, 幂等, 顺序消息, 消息积压, 延迟消息, 死信队列]
summary: 抛开具体产品，回答 MQ 的通用难题：为什么用、怎么选、如何不丢、如何不重、如何有序、积压了怎么办
---

# 消息队列核心问题

> [!ABSTRACT] 核心要点
> - MQ 的三大价值是**解耦、异步、削峰**，代价是系统可用性依赖 MQ、链路变长、要额外处理**丢失 / 重复 / 乱序 / 积压**四类问题，以及最终一致带来的业务复杂度。
> - 消息丢失要分三段看：**生产端**（acks + 重试 + 回调）、**Broker 端**（多副本 + 刷盘策略 + 禁止脏选举）、**消费端**（处理成功后再提交位点）。
> - 主流 MQ 都只承诺 **at-least-once**，重复消费不可避免，**幂等必须由业务保证**：唯一索引 / 去重表 / 状态机 / 带过期的 Redis 标记，最终兜底永远是数据库约束。
> - 生产上要的几乎都是**分区（局部）顺序**：同一业务键路由到同一分区 + 分区内串行消费；全局顺序意味着单分区单消费者，吞吐无法扩展。
> - 积压的根因是消费速度 < 生产速度：先止血（修 bug、扩容、降级），扩消费者受**分区数上限**约束，必要时用「临时 Topic + 更多分区」转储。

## 为什么用 MQ，以及代价

| 价值 | 典型场景 | 不用 MQ 的问题 |
| --- | --- | --- |
| 解耦 | 订单支付成功后，积分、物流、通知、风控各自订阅 | 上游每加一个下游就要改代码、发版，任何下游超时都拖垮主流程 |
| 异步 | 注册后发欢迎邮件、生成报表、写审计日志 | 非核心步骤串行执行，RT 叠加 |
| 削峰 | 秒杀下单、日志采集、埋点上报 | 瞬时流量直接打到 DB，DB 被打挂后雪崩 |

引入 MQ 的代价往往被低估：

- **可用性**：MQ 成为核心依赖，MQ 集群故障 = 所有异步链路中断，需要有发送失败的降级方案（本地落库、同步直调）。
- **一致性**：生产者「本地事务提交」与「消息发出」不是原子的，需要事务消息或本地消息表，详见 [分布式事务](#/distributed/transaction)。
- **复杂度**：要处理丢失、重复、乱序、积压、消费失败、死信，还要有监控（堆积量、消费延迟、发送失败率）。
- **排查难度**：调用链被切断，需要通过 traceId 透传到消息头，才能把生产和消费串起来。

> [!TIP]
> 判断是否该引入 MQ 的一个简单标准：下游的执行结果**是否需要同步返回给调用方**。需要立即拿结果的（如扣库存是否成功），用 RPC；只需要「最终会发生」的，才适合 MQ。

## 选型对比

| 维度 | Kafka | RocketMQ | RabbitMQ | Pulsar |
| --- | --- | --- | --- | --- |
| 定位 | 高吞吐日志流 / 流处理底座 | 业务消息（电商、金融） | 企业集成、复杂路由 | 云原生、多租户、存算分离 |
| 吞吐 | 极高（单集群百万级 TPS） | 高（十万级） | 中（万级～十万级） | 高 |
| 延迟 | ms 级，批量越大越高 | ms 级 | 微秒～ms 级，低负载最低 | ms 级 |
| 存储模型 | 每分区独立日志文件 | 所有 Topic 共用 CommitLog | 队列（经典队列 / Quorum 队列 / Stream） | BookKeeper 分片存储，Broker 无状态 |
| 消费模型 | 拉（长轮询） | 拉（Push 是长轮询封装）；5.x 增加 Pop | 推（prefetch 控制） | 推（基于 permit 流控） |
| 事务 / 延迟 | 有事务（面向流处理 EOS），无原生延迟 | 事务消息、延迟 / 定时消息、重试、死信全内置 | 无事务消息；延迟靠 TTL+DLX 或插件 | 支持事务、延迟投递 |
| 顺序 | 分区内有序 | 队列内有序（顺序消费有队列锁） | 单队列单消费者有序 | 分区内有序（Key_Shared 支持按 key 有序） |
| 生态 | Connect、Streams、Flink、CDC 首选 | Java 生态、阿里系 | 多语言、AMQP 标准 | 分层存储、跨地域复制 |

选型建议：

- **日志、埋点、CDC、流计算**：Kafka，生态无可替代。
- **交易链路、需要事务消息 / 定时消息 / 重试死信开箱即用**：RocketMQ，详见 [RocketMQ 原理与事务消息](#/mw/rocketmq)。
- **消息量不大、路由规则复杂（topic/direct/fanout/headers 交换机）、追求低延迟**：RabbitMQ。
- **海量 Topic、多租户、需要计算存储独立扩缩容**：Pulsar（运维复杂度最高）。

### 推模式 vs 拉模式

| | 推（Push） | 拉（Pull） |
| --- | --- | --- |
| 实时性 | 高，Broker 有消息立即推送 | 依赖拉取间隔；**长轮询**可做到接近推的实时性 |
| 流控 | Broker 难以感知消费者能力，容易压垮消费者，需要 prefetch / 背压 | 消费者按自身能力拉取，天然背压 |
| Broker 复杂度 | 要维护每个消费者的投递状态 | Broker 无状态，只按 offset 返回数据 |
| 批量 | 不便批量 | 便于批量拉取、批量处理 |

Kafka 和 RocketMQ 都是拉模式：消费者拉取时如果没有新数据，Broker 会把请求挂起（Kafka 的 `fetch.max.wait.ms`、RocketMQ 的长轮询挂起），有新消息或超时才返回，避免空轮询。RocketMQ 的 `DefaultMQPushConsumer` 名字叫 Push，本质仍是客户端长轮询拉取。

## 消息丢失：三个环节

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="消息从生产者到 Broker 再到消费者三个阶段的丢失原因与对应对策">
<rect class="b1" x="60" y="40" width="140" height="52" rx="8"/>
<text class="tb" x="130" y="66" text-anchor="middle" dominant-baseline="middle">Producer</text>
<line class="l" x1="200" y1="66" x2="310" y2="66" marker-end="url(#arr)"/>
<text class="ts" x="255" y="56" text-anchor="middle">send</text>
<rect class="b2" x="310" y="40" width="140" height="52" rx="8"/>
<text class="tb" x="380" y="66" text-anchor="middle" dominant-baseline="middle">Broker</text>
<line class="l" x1="450" y1="66" x2="560" y2="66" marker-end="url(#arr)"/>
<text class="ts" x="505" y="56" text-anchor="middle">pull</text>
<rect class="b1" x="560" y="40" width="140" height="52" rx="8"/>
<text class="tb" x="630" y="66" text-anchor="middle" dominant-baseline="middle">Consumer</text>
<text class="ta" x="130" y="114" text-anchor="middle">① 生产阶段</text>
<text class="ta" x="380" y="114" text-anchor="middle">② 存储阶段</text>
<text class="ta" x="630" y="114" text-anchor="middle">③ 消费阶段</text>
<rect class="b4" x="20" y="128" width="220" height="78" rx="8"/>
<text class="tb" x="130" y="148" text-anchor="middle" dominant-baseline="middle">丢失原因</text>
<text class="ts" x="130" y="172" text-anchor="middle">网络超时、未处理发送回调</text>
<text class="ts" x="130" y="192" text-anchor="middle">acks=0/1，Leader 宕机未同步</text>
<rect class="b4" x="270" y="128" width="220" height="78" rx="8"/>
<text class="tb" x="380" y="148" text-anchor="middle" dominant-baseline="middle">丢失原因</text>
<text class="ts" x="380" y="172" text-anchor="middle">只写入 PageCache 就整机掉电</text>
<text class="ts" x="380" y="192" text-anchor="middle">未同步完的副本被选为 Leader</text>
<rect class="b4" x="520" y="128" width="220" height="78" rx="8"/>
<text class="tb" x="630" y="148" text-anchor="middle" dominant-baseline="middle">丢失原因</text>
<text class="ts" x="630" y="172" text-anchor="middle">先提交 offset 再处理业务</text>
<text class="ts" x="630" y="192" text-anchor="middle">丢给异步线程处理，异常被吞</text>
<line class="l" x1="130" y1="206" x2="130" y2="226" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="206" x2="380" y2="226" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="206" x2="630" y2="226" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="226" width="220" height="92" rx="8"/>
<text class="tb" x="130" y="246" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="130" y="268" text-anchor="middle">acks=all + 重试 + 幂等生产者</text>
<text class="ts" x="130" y="286" text-anchor="middle">失败回调落库 / 本地消息表</text>
<text class="ts" x="130" y="304" text-anchor="middle">关键链路检查发送结果</text>
<rect class="b2" x="270" y="226" width="220" height="92" rx="8"/>
<text class="tb" x="380" y="246" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="380" y="268" text-anchor="middle">3 副本 + min.insync=2</text>
<text class="ts" x="380" y="286" text-anchor="middle">禁止 unclean leader 选举</text>
<text class="ts" x="380" y="304" text-anchor="middle">RocketMQ 可选同步刷盘/同步复制</text>
<rect class="b2" x="520" y="226" width="220" height="92" rx="8"/>
<text class="tb" x="630" y="246" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="630" y="268" text-anchor="middle">业务成功后再手动提交位点</text>
<text class="ts" x="630" y="286" text-anchor="middle">失败进入重试 / 死信队列</text>
<text class="ts" x="630" y="304" text-anchor="middle">消费逻辑保证幂等</text>
</svg>
<figcaption>图 1：消息丢失的三个环节与对策</figcaption>
</figure>

**生产阶段**最常见的事故是「异步发送 + 不看回调」：`producer.send(record)` 返回的是 Future，网络抖动、Leader 切换、缓冲区满（`max.block.ms` 超时）都会让发送失败，如果没有回调处理，消息就静默丢失了。

```java
// Kafka 3.x：异步发送也必须处理回调
producer.send(record, (metadata, ex) -> {
    if (ex != null) {
        // 可重试异常已经被客户端按 retries / delivery.timeout.ms 重试过，到这里是最终失败
        log.error("send failed, key={}", record.key(), ex);
        failedMessageRepo.save(record);   // 落库，由定时任务补偿重发
    }
});
```

**存储阶段**：Kafka 默认只写 PageCache 由操作系统异步刷盘，依靠**多副本**而不是刷盘保证可靠，所以必须 `acks=all` + `min.insync.replicas>=2` + 关闭 unclean 选举，详见 [Kafka 副本与可靠性](#/mw/kafka-reliability)。RocketMQ 可以选同步刷盘（`SYNC_FLUSH`）和同步复制（`SYNC_MASTER`），代价是吞吐下降。

**消费阶段**：Kafka 自动提交（`enable.auto.commit=true`）是按时间周期提交 poll 到的位点，如果业务还没处理完消费者就崩溃，重启后从已提交位点开始，中间的消息就丢了；另一个常见坑是把消息丢进线程池就立即返回成功。原则：**处理成功 → 再提交位点**，宁可重复不可丢失。

> [!WARNING]
> 「不丢消息」的配置只能保证 MQ 内部链路。消息在发送之前（本地事务已提交但应用崩溃、消息还没发）和消费之后（写下游失败但位点已提交）丢失，需要业务层用**本地消息表 / 事务消息 / 对账**兜底。

## 重复消费与幂等设计

重复消费的来源是不可消除的：

- 生产者发送超时重试，而第一次其实已经写入成功（Kafka 幂等生产者只能消除单会话、单分区内的这类重复）。
- 消费者处理完成但位点提交前崩溃、或发生 Rebalance，分区交给别的消费者从旧位点重新消费。
- RocketMQ 消费失败重试、事务消息回查、Broker 主从切换。

所以必须在消费端做幂等，核心是**找到业务唯一标识**（订单号、支付流水号、业务 ID + 事件类型），而不是依赖 MQ 的 messageId（重发时 messageId 可能不同）。

| 方案 | 做法 | 优点 | 缺点 / 注意 |
| --- | --- | --- | --- |
| 唯一索引 | 业务表对业务键建唯一索引，重复插入抛 `DuplicateKeyException` 即视为已处理 | 最可靠，DB 兜底 | 只适合「插入型」操作 |
| 去重表 | 独立表 `(msg_key, consumer_group)` 唯一，**与业务操作在同一本地事务**里插入 | 通用，可审计 | 要求业务和去重表在同一个库；表要定期清理 |
| 状态机 | `UPDATE ... SET status='PAID' WHERE id=? AND status='UNPAID'`，影响行数为 0 即已处理 | 天然幂等，无额外存储 | 只适合有明确状态流转的业务 |
| 版本号 / 乐观锁 | `WHERE version=?`，消息带版本，旧版本直接丢弃 | 同时解决乱序覆盖问题 | 生产端要能给出单调版本 |
| Redis SETNX | `SET key 1 NX EX 86400` 成功才处理 | 快，挡住大部分重复 | 与 DB 不是原子的：处理失败要删 key；Redis 故障 / 过期后仍可能重复，需要 DB 兜底 |

```java
// 去重表 + 业务操作同一个本地事务：要么都成功，要么都回滚
@Transactional(rollbackFor = Exception.class)
public void onOrderPaid(OrderPaidEvent e) {
    try {
        dedupMapper.insert(e.getPayNo(), "points-consumer");   // UNIQUE(msg_key, consumer)
    } catch (DuplicateKeyException dup) {
        return;                                                // 已处理过，直接确认
    }
    pointsService.addPoints(e.getUserId(), e.getAmount());
}
```

> [!TIP]
> Redis 去重推荐用三态：`SET key PROCESSING NX EX 60` 抢占 → 处理成功后改为 `DONE` 并延长过期 → 失败时删除 key 让重试可以进来。只用「存在 / 不存在」两态，会出现处理中崩溃导致后续重试被永久拦截的问题。

## 顺序消息

| | 全局顺序 | 分区（局部）顺序 |
| --- | --- | --- |
| 定义 | Topic 内所有消息严格 FIFO | 同一业务键（如订单号）的消息有序 |
| 实现 | 1 个分区 + 1 个消费者单线程 | 按业务键哈希到固定分区 + 分区内串行消费 |
| 吞吐 | 无法水平扩展 | 随分区数扩展 |
| 适用 | 极少（如 binlog 全库强序回放） | 订单状态流转、账户流水、CDC 按主键 |

做到分区顺序要三端配合：

1. **生产端**：同一业务键发往同一分区（Kafka 指定 key；RocketMQ 用 `MessageQueueSelector`）；并且发送本身不能乱序——Kafka 未开幂等时 `max.in.flight.requests.per.connection>1` + 重试会乱序，开启幂等后 ≤5 也能保序。
2. **Broker 端**：分区数不能随便改。扩分区后 `hash(key) % N` 变化，同一订单的新旧消息落在不同分区，短时间内可能乱序。
3. **消费端**：一个分区只被一个消费者线程串行处理。如果为了提速把消息丢进线程池，要**按业务键二次哈希到固定的内存队列**，每个队列单线程处理，而不是随机分发。

> [!WARNING]
> 顺序消费遇到一条处理失败的消息时，不能跳过去处理后面的（否则就乱序了），只能原地重试，这会**阻塞整个分区**。所以顺序消费必须给重试设上限，超限后转人工或死信，并对「分区卡住」做告警。

## 消息积压应急处理

积压 = 消费速度持续低于生产速度。先判断原因，再动手：

- **消费端变慢**：下游 DB / RPC 变慢、慢 SQL、消费逻辑有 bug 一直失败重试、GC 频繁。
- **生产端突增**：大促、批量任务、上游重放数据。
- **消费者异常**：Rebalance 风暴、消费线程卡死（死锁、无超时的 HTTP 调用）。

处置顺序：

1. **止血**：修复 bug、给下游扩容或限流；非核心消息可以先降级（只记录不处理）。
2. **扩容消费者**：在分区数范围内增加消费者实例或消费线程。**消费者数超过分区数的部分是空闲的**。
3. **临时 Topic 转储**：分区数不够时，写一个「只转发不处理」的消费者，把积压消息原样搬到一个分区数大得多的临时 Topic，再用大量消费者并行处理。

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="积压时用转储消费者把原 Topic 的消息搬到分区更多的临时 Topic，再用扩容的消费者并行处理">
<rect class="bg" x="20" y="30" width="150" height="190" rx="12"/>
<text class="ts" x="32" y="50">原 Topic（4 分区）</text>
<rect class="b1" x="40" y="64" width="110" height="28" rx="6"/>
<text class="tm" x="95" y="78" text-anchor="middle" dominant-baseline="middle">P0 积压</text>
<rect class="b1" x="40" y="102" width="110" height="28" rx="6"/>
<text class="tm" x="95" y="116" text-anchor="middle" dominant-baseline="middle">P1 积压</text>
<rect class="b1" x="40" y="140" width="110" height="28" rx="6"/>
<text class="tm" x="95" y="154" text-anchor="middle" dominant-baseline="middle">P2 积压</text>
<rect class="b1" x="40" y="178" width="110" height="28" rx="6"/>
<text class="tm" x="95" y="192" text-anchor="middle" dominant-baseline="middle">P3 积压</text>
<line class="l" x1="170" y1="125" x2="210" y2="125" marker-end="url(#arr)"/>
<rect class="b3" x="210" y="95" width="130" height="60" rx="8"/>
<text class="tb" x="275" y="117" text-anchor="middle" dominant-baseline="middle">转储消费者</text>
<text class="ts" x="275" y="139" text-anchor="middle">只转发，不处理</text>
<line class="la" x1="340" y1="125" x2="380" y2="125" marker-end="url(#arr-a)"/>
<rect class="bg" x="380" y="30" width="150" height="190" rx="12"/>
<text class="ts" x="392" y="50">临时 Topic（20 分区）</text>
<rect class="b2" x="400" y="64" width="110" height="26" rx="6"/>
<text class="tm" x="455" y="77" text-anchor="middle" dominant-baseline="middle">P0</text>
<rect class="b2" x="400" y="98" width="110" height="26" rx="6"/>
<text class="tm" x="455" y="111" text-anchor="middle" dominant-baseline="middle">P1</text>
<rect class="b2" x="400" y="132" width="110" height="26" rx="6"/>
<text class="tm" x="455" y="145" text-anchor="middle" dominant-baseline="middle">P2</text>
<text class="tb" x="455" y="170" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b2" x="400" y="182" width="110" height="26" rx="6"/>
<text class="tm" x="455" y="195" text-anchor="middle" dominant-baseline="middle">P19</text>
<line class="l" x1="530" y1="125" x2="570" y2="125" marker-end="url(#arr)"/>
<rect class="bg" x="570" y="30" width="170" height="190" rx="12"/>
<text class="ts" x="582" y="50">扩容后的消费者 ×20</text>
<rect class="b1" x="590" y="64" width="130" height="26" rx="6"/>
<text class="tm" x="655" y="77" text-anchor="middle" dominant-baseline="middle">consumer-1</text>
<rect class="b1" x="590" y="98" width="130" height="26" rx="6"/>
<text class="tm" x="655" y="111" text-anchor="middle" dominant-baseline="middle">consumer-2</text>
<rect class="b1" x="590" y="132" width="130" height="26" rx="6"/>
<text class="tm" x="655" y="145" text-anchor="middle" dominant-baseline="middle">consumer-3</text>
<text class="tb" x="655" y="170" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b1" x="590" y="182" width="130" height="26" rx="6"/>
<text class="tm" x="655" y="195" text-anchor="middle" dominant-baseline="middle">consumer-20</text>
<text class="ts" x="380" y="242" text-anchor="middle">前提：瓶颈不在下游 DB，否则扩容只会把压力转移到 DB；需要保序时转储也要按 key 路由</text>
</svg>
<figcaption>图 2：临时 Topic 转储，突破分区数对并行度的限制</figcaption>
</figure>

4. **事后**：积压消费完后恢复原架构，复盘容量规划：分区数要按「峰值生产速率 / 单消费者处理速率」预留余量；给消费延迟（Kafka 的 consumer lag、RocketMQ 的堆积量）配告警。

> [!CAUTION]
> 积压期间**不要随手重置位点跳过消息**来「清积压」，除非业务明确允许丢弃；还要检查消息保留期（Kafka 默认 7 天、RocketMQ 默认 72 小时），积压时间超过保留期，消息会被直接删除，此时只能从上游重新导数。

## 延迟消息方案

| 方案 | 原理 | 精度 / 范围 | 适用 |
| --- | --- | --- | --- |
| RocketMQ 4.x 延迟级别 | 18 个固定级别（1s～2h），先写入内部调度 Topic，到期再投递 | 只能选固定级别 | 订单超时关单（30m） |
| RocketMQ 5.x 定时消息 | 时间轮 + TimerLog，任意时间点 | 秒级，有最大延迟上限（可配置） | 通用定时任务 |
| RabbitMQ TTL + 死信交换机 | 消息在延迟队列过期后转入死信队列被消费 | 队头阻塞：同一队列需同一 TTL | 固定延迟 |
| RabbitMQ 延迟插件 | `x-delayed-message` 交换机 | 任意时间，大量消息时性能一般 | 中小规模 |
| Kafka 自建 | 按延迟分级的多个 Topic + 消费端判断未到期就暂停分区 / 时间轮转发 | 自己实现 | 已重度依赖 Kafka 的团队 |
| Redis ZSet | score 为到期时间戳，定时 `ZRANGEBYSCORE` 拉取 | 依赖轮询间隔；注意多实例并发抢占和持久化 | 轻量场景 |
| DB 扫表 | 记录到期时间，定时任务扫描 | 分钟级，数据量大时扫描压力大 | 兜底、对账 |

> [!TIP]
> 订单超时关单这种场景，常见做法是「延迟消息为主 + 定时任务扫表兜底」：延迟消息保证实时性，扫表兜住消息丢失或消费失败的长尾。消费时一定要检查订单当前状态（状态机幂等），因为用户可能在延迟期间已经支付。

## 事务消息与本地消息表

核心问题：**本地 DB 事务提交** 和 **消息发送** 要么都成功要么都失败。

- 先发消息后提交事务：消息发出去了，事务回滚了 → 下游处理了一条不存在的业务。
- 先提交事务后发消息：事务提交了，应用崩溃没发出去 → 消息丢失。

两种主流解法：

| | 本地消息表 | RocketMQ 事务消息 |
| --- | --- | --- |
| 原理 | 业务数据和「待发送消息」在同一个本地事务里写入；后台任务扫描未发送记录投递，成功后标记 | 先发半消息（对消费者不可见）→ 执行本地事务 → Commit / Rollback；状态不明时 Broker 回查 |
| 依赖 | 任意 MQ | RocketMQ（或支持该语义的 MQ） |
| 侵入 | 每个业务库一张消息表，要有扫描投递任务 | 需要实现回查接口 |
| 投递延迟 | 取决于扫描间隔（可在事务提交后立即异步发送一次，扫描只做兜底） | 低 |

两者都只保证「生产端的本地事务与消息发送一致」，消费端仍是 at-least-once，**消费者必须幂等**；消费失败不会回滚生产者的事务，只能重试或人工补偿。完整的分布式事务方案对比见 [分布式事务](#/distributed/transaction)，事务消息的回查机制见 [RocketMQ 原理与事务消息](#/mw/rocketmq)。

## 消费失败重试与死信

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="消费失败进入重试 Topic 延迟重投，超过最大次数进入死信 Topic 并告警">
<rect class="b1" x="20" y="40" width="140" height="50" rx="8"/>
<text class="tb" x="90" y="65" text-anchor="middle" dominant-baseline="middle">业务 Topic</text>
<line class="l" x1="160" y1="65" x2="230" y2="65" marker-end="url(#arr)"/>
<rect class="b2" x="230" y="40" width="140" height="50" rx="8"/>
<text class="tb" x="300" y="65" text-anchor="middle" dominant-baseline="middle">消费者组</text>
<line class="l" x1="370" y1="65" x2="470" y2="65" marker-end="url(#arr)"/>
<text class="ts" x="420" y="55" text-anchor="middle">处理成功</text>
<rect class="b" x="470" y="40" width="130" height="50" rx="8"/>
<text class="tb" x="535" y="65" text-anchor="middle" dominant-baseline="middle">提交位点</text>
<line class="la" x1="330" y1="90" x2="330" y2="150" marker-end="url(#arr-a)"/>
<text class="ts" x="342" y="124">失败</text>
<line class="l" x1="270" y1="150" x2="270" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="258" y="124" text-anchor="end">到期重投</text>
<rect class="b3" x="230" y="150" width="140" height="50" rx="8"/>
<text class="tb" x="300" y="175" text-anchor="middle" dominant-baseline="middle">重试 Topic</text>
<text class="ts" x="300" y="222" text-anchor="middle">间隔递增：10s → 30s → 1m → … → 2h</text>
<line class="la" x1="370" y1="175" x2="470" y2="175" marker-end="url(#arr-a)"/>
<text class="ts" x="420" y="165" text-anchor="middle">超过最大次数</text>
<rect class="b4" x="470" y="150" width="130" height="50" rx="8"/>
<text class="tb" x="535" y="175" text-anchor="middle" dominant-baseline="middle">死信 Topic</text>
<line class="l" x1="600" y1="175" x2="630" y2="175" marker-end="url(#arr)"/>
<rect class="b" x="630" y="150" width="110" height="50" rx="8"/>
<text class="tb" x="685" y="175" text-anchor="middle" dominant-baseline="middle">告警 / 人工</text>
</svg>
<figcaption>图 3：消费失败的重试与死信流转（以 RocketMQ 默认行为为例）</figcaption>
</figure>

- **RocketMQ** 内置：并发消费返回 `RECONSUME_LATER` 或抛异常，消息被发回 `%RETRY%消费组`，按延迟级别递增重试，默认最多 16 次，之后进入 `%DLQ%消费组`。
- **Kafka** 没有内置重试 Topic，常见做法是 Spring Kafka 的 `DefaultErrorHandler`（本地退避重试）+ `DeadLetterPublishingRecoverer`，或者 `@RetryableTopic` 自动创建多级重试 Topic 和 DLT。
- **RabbitMQ**：`basic.nack(requeue=false)` 或消息过期进入死信交换机（DLX）。

> [!WARNING]
> 区分**可重试错误**（下游超时、锁冲突）和**不可重试错误**（消息格式非法、业务校验不通过）。后者重试 16 次也不会成功，只会白白占用资源、拖慢正常消息，应该直接进死信。死信队列必须有监控和处理流程，否则就是「静默丢消息」。

## 生产实践与踩坑

- **消息体过大**：Kafka 默认单条上限约 1MB（`message.max.bytes` / `max.request.size`），大对象应该存 OSS / DB，消息里只放 ID。
- **消费逻辑里调用无超时的 HTTP**：一个请求卡死，整个分区停止消费，Kafka 还会因为超过 `max.poll.interval.ms` 触发 Rebalance，形成恶性循环。
- **事务内发消息**：在 `@Transactional` 方法里直接发 MQ，事务回滚了消息已发出。正确做法是用事务消息 / 本地消息表，或者至少用 `TransactionSynchronization#afterCommit` 在提交后发送（仍有崩溃丢失风险）。
- **消息里只放「变更通知」还是「完整数据」**：只放 ID 让消费者回查，能天然避免乱序覆盖（总是拿到最新状态），代价是回查压力；放完整数据要处理版本号以防旧消息覆盖新数据。
- **消费者组共用**：两个不同业务用了同一个 group，结果消息被瓜分，各自只收到一部分。
- **监控三件套**：发送失败率、消费延迟（lag / 堆积量）、死信数量；再加上消费耗时 P99。

## 面试追问

> [!QUESTION] 如何保证消息不丢失？请按链路回答。
> - 生产端：同步发送或异步回调检查结果；`acks=all`、开启重试与幂等；失败落库补偿。
> - Broker：多副本（3 副本 + `min.insync.replicas=2`）、禁止 unclean 选举；RocketMQ 可选同步刷盘 + 同步复制。
> - 消费端：业务处理成功后再提交位点；失败进重试 / 死信。
> - 链路外：本地消息表 / 事务消息解决「事务与发送」的一致性，定期对账兜底。

> [!QUESTION] 既然 Kafka 有幂等生产者和事务，消费端还需要做幂等吗？
> 需要。幂等生产者只消除单个生产者会话内、单分区上的重试重复；事务的 Exactly-Once 只覆盖「从 Kafka 读 → 处理 → 写回 Kafka」的闭环。只要消费结果写到外部系统（DB、Redis、RPC），位点提交和外部写入就不是原子的，Rebalance 或崩溃都会导致重复，消费端幂等必不可少。

> [!QUESTION] 订单的创建、支付、发货三条消息如何保证顺序？消费失败怎么办？
> 以订单号为 key 发到同一分区；消费端单分区串行，或按订单号哈希到固定的内存队列并行。失败时原地有限次重试，阻塞该分区；超过上限转人工并告警。更稳妥的设计是消费端用状态机校验（只允许合法的状态流转），乱序到达的消息先暂存或丢弃后回查最新状态。

> [!QUESTION] 线上积压了几千万条消息，你怎么处理？
> 先看消费延迟曲线和消费端日志，定位是消费变慢还是生产突增；修复根因或降级；在分区数内扩消费者；分区不够就用转储消费者把消息搬到更多分区的临时 Topic 并行消费；确认积压时长没有超过消息保留期；事后按峰值重新规划分区和容量，补告警。

> [!QUESTION] 本地消息表和事务消息怎么选？
> 本地消息表不依赖特定 MQ，可靠性只依赖本地事务，代价是每个服务维护消息表和扫描任务；事务消息由 RocketMQ 托管半消息和回查，接入更轻，但绑定 RocketMQ，回查接口必须能根据业务数据判断事务结果。两者都要求消费端幂等。
