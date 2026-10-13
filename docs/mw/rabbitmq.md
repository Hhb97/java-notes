---
level: 深入
tags: [RabbitMQ, AMQP, Exchange, Queue, 仲裁队列, Stream, 发布确认, 死信, 延迟消息, 流控, Spring AMQP]
summary: RabbitMQ 的工作模型与生产实践：AMQP 的 Exchange/Binding/Queue 路由、四种交换机、经典队列/仲裁队列/Stream 的取舍、端到端可靠性（发布确认、持久化、手动 ack、死信与重试）、延迟消息、预取与流控、集群与高可用、Spring AMQP 用法与常见线上问题，以及与 Kafka、RocketMQ 的选型。
---

# RabbitMQ 原理与可靠性（AMQP、仲裁队列与死信）

> [!ABSTRACT] 核心要点
> - RabbitMQ 是**以“路由”见长的消息代理**：生产者不直接写队列，而是把消息发给 **Exchange**，由 **Binding 规则**决定投递到哪些 **Queue**，消费者从队列取。灵活的路由（直连、主题、扇出、头部）是它相对 Kafka 的核心特色。
> - 它的定位是**“智能代理 + 简单消费者”**：代理负责路由、确认、重投、死信、TTL、优先级；队列是**消费即删除**的模型，适合**任务分发、业务事件通知、RPC 回包**等场景，不擅长超大吞吐的日志流与消息回溯。
> - **可靠性是三段链路**：生产端（**发布确认 Publisher Confirm** + 失败重发）、代理端（**持久化 + 仲裁队列**）、消费端（**手动 ack + 幂等**）。少一段都会丢或重复。
> - **队列类型决定高可用**：现代集群应使用**仲裁队列（Quorum Queue，基于 Raft）**，不要再用已被淘汰的**镜像队列**；需要海量吞吐与回溯的场景可用 **Stream** 队列。
> - 线上最常见的问题是**消息堆积导致内存/磁盘告警触发流控**、**预取（prefetch）设置不当造成消费不均或内存暴涨**、**未 ack 的消息卡住**、**死信/重试风暴**，需要从队列长度、未确认数、消费速率三个指标入手监控。

## 它适合做什么，不适合做什么

| 场景 | 适合度 | 说明 |
| --- | --- | --- |
| 业务事件通知、任务分发、异步解耦 | 很适合 | 路由灵活，接入简单，延迟低（毫秒级） |
| 工作队列（多个消费者争抢任务） | 很适合 | 公平分发 + 手动 ack + 重投 |
| 复杂路由（按主题、按属性广播、多系统订阅） | 很适合 | Topic/Headers/Fanout 交换机 |
| 延迟/定时、TTL、优先级、死信 | 适合 | 内建支持（延迟需插件或 TTL+死信方案） |
| RPC 回包（请求-响应） | 适合 | 回复队列 + correlationId |
| 日志/埋点/流式处理，**百万级 TPS、长期保留、重复消费** | 不适合 | 用 Kafka；RabbitMQ 消费后即删除，不支持按位点回放（Stream 队列例外） |
| 严格全局顺序、超大堆积 | 不适合 | 堆积会触发流控与内存压力，顺序仅在“单队列单消费者”下成立 |

## AMQP 工作模型

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="RabbitMQ 路由模型：生产者在连接的信道上发布消息到 Exchange，Exchange 根据类型与 Binding 的路由键规则把消息投递到一个或多个 Queue，消费者订阅队列；包含 direct、topic、fanout、headers 四种交换机的匹配方式">
<rect class="b3" x="20" y="40" width="100" height="60" rx="8"/>
<text class="tb" x="70" y="62" text-anchor="middle" dominant-baseline="middle">生产者</text>
<text class="ts" x="70" y="82" text-anchor="middle">routing key</text>
<rect class="b5" x="170" y="30" width="130" height="80" rx="8"/>
<text class="tb" x="235" y="52" text-anchor="middle" dominant-baseline="middle">Exchange</text>
<text class="ts" x="235" y="74" text-anchor="middle">只路由，不存储</text>
<text class="ts" x="235" y="92" text-anchor="middle">类型决定匹配规则</text>
<rect class="b1" x="380" y="14" width="140" height="44" rx="8"/>
<text class="tb" x="450" y="36" text-anchor="middle" dominant-baseline="middle">Queue A</text>
<rect class="b1" x="380" y="70" width="140" height="44" rx="8"/>
<text class="tb" x="450" y="92" text-anchor="middle" dominant-baseline="middle">Queue B</text>
<rect class="b1" x="380" y="126" width="140" height="44" rx="8"/>
<text class="tb" x="450" y="148" text-anchor="middle" dominant-baseline="middle">Queue C</text>
<rect class="b2" x="600" y="14" width="140" height="44" rx="8"/>
<text class="ts" x="670" y="36" text-anchor="middle" dominant-baseline="middle">消费者 1（ack）</text>
<rect class="b2" x="600" y="70" width="140" height="44" rx="8"/>
<text class="ts" x="670" y="92" text-anchor="middle" dominant-baseline="middle">消费者 2、3 竞争</text>
<rect class="b2" x="600" y="126" width="140" height="44" rx="8"/>
<text class="ts" x="670" y="148" text-anchor="middle" dominant-baseline="middle">消费者 4</text>
<line class="l" x1="120" y1="70" x2="170" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="55" x2="380" y2="36" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="70" x2="380" y2="92" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="85" x2="380" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="36" x2="600" y2="36" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="92" x2="600" y2="92" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="148" x2="600" y2="148" marker-end="url(#arr)"/>
<text class="ta" x="340" y="120" text-anchor="middle">Binding（绑定键）</text>
<rect class="bg" x="20" y="192" width="720" height="124" rx="8"/>
<text class="th" x="32" y="212">四种交换机</text>
<text class="ts" x="380" y="238" text-anchor="middle">direct：routing key 与绑定键完全相等才投递（精确匹配，如按订单类型分发）</text>
<text class="ts" x="380" y="258" text-anchor="middle">topic：绑定键支持通配（* 匹配一个词，# 匹配零个或多个词），如 order.*.paid、log.#</text>
<text class="ts" x="380" y="278" text-anchor="middle">fanout：忽略 routing key，广播到所有绑定队列（如配置变更通知、多系统订阅）</text>
<text class="ts" x="380" y="298" text-anchor="middle">headers：按消息头属性匹配（用得少，性能与可读性不如 topic）；另有默认交换机：按队列名直投</text>
</svg>
<figcaption>图 1：Exchange → Binding → Queue 的路由模型</figcaption>
</figure>

### 核心概念

| 概念 | 说明 |
| --- | --- |
| **Connection / Channel** | 一个 TCP **连接**内复用多个**信道（Channel）**；信道是轻量的“逻辑连接”，**不要多线程共享一个信道**；每个线程/任务用独立 Channel，连接尽量复用 |
| **Virtual Host（vhost）** | 逻辑隔离的命名空间：不同业务线/环境用不同 vhost，权限和资源独立 |
| **Exchange** | 路由器，**没有存储能力**：若没有任何匹配的队列，消息会被丢弃（除非设置 mandatory 或备用交换机） |
| **Queue** | 存储消息的缓冲，**消息在队列中，不在交换机中** |
| **Binding** | 交换机与队列之间的绑定规则（含绑定键） |
| **消息属性** | `delivery_mode`（持久化）、`correlation_id`、`reply_to`、`expiration`（TTL）、`priority`、`headers` 等 |
| **Consumer / ack** | 消费者订阅队列；成功处理后**手动 ack**，失败可 nack/reject 并选择重新入队或进入死信 |

### 与 Kafka 的模型差异

| 对比 | RabbitMQ | Kafka |
| --- | --- | --- |
| 模型 | 代理管路由；消息**投递给消费者后删除**（ack 后） | 分区日志；消息**按保留策略保留**，消费者自己管位点 |
| 回溯重放 | 一般不支持（Stream 队列支持） | 天然支持 |
| 消息路由 | 灵活（交换机 + 绑定） | 按 Topic + 分区，消费端过滤 |
| 单队列吞吐 | 万~数万 msg/s 量级（取决于消息大小、持久化与确认方式） | 单分区/集群可到更高量级，批量与顺序写友好 |
| 延迟 | 低（毫秒级） | 批量带来稍高延迟 |
| 消费模型 | 代理推送（push）+ prefetch 控制 | 消费者拉取（pull） |
| 典型场景 | 业务消息、任务队列、RPC | 日志、流式、大数据管道、事件溯源 |

以上吞吐为经验量级，实际取决于硬件、消息大小与配置，请以自己的压测为准。

## 队列类型与高可用

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="RabbitMQ 三种队列类型对比：经典队列单节点无复制，镜像队列已被弃用，仲裁队列基于 Raft 多副本，Stream 基于追加日志支持重复读取；展示仲裁队列的 Leader 与 Follower 复制和过半确认">
<rect class="b" x="20" y="14" width="220" height="130" rx="10"/>
<text class="tb" x="130" y="34" text-anchor="middle" dominant-baseline="middle">经典队列 Classic</text>
<text class="ts" x="130" y="60" text-anchor="middle">单节点存储，无复制</text>
<text class="ts" x="130" y="80" text-anchor="middle">节点宕机则不可用/可能丢</text>
<text class="ts" x="130" y="100" text-anchor="middle">适合临时队列、可丢数据</text>
<text class="ts" x="130" y="124" text-anchor="middle">（镜像队列已弃用）</text>
<rect class="b2" x="260" y="14" width="260" height="130" rx="10"/>
<text class="tb" x="390" y="34" text-anchor="middle" dominant-baseline="middle">仲裁队列 Quorum（推荐）</text>
<rect class="b3" x="276" y="52" width="70" height="36" rx="6"/>
<text class="ts" x="311" y="70" text-anchor="middle" dominant-baseline="middle">Leader</text>
<rect class="b1" x="356" y="52" width="70" height="36" rx="6"/>
<text class="ts" x="391" y="70" text-anchor="middle" dominant-baseline="middle">Follower</text>
<rect class="b1" x="436" y="52" width="70" height="36" rx="6"/>
<text class="ts" x="471" y="70" text-anchor="middle" dominant-baseline="middle">Follower</text>
<text class="ts" x="390" y="108" text-anchor="middle">Raft：过半副本写入才确认</text>
<text class="ts" x="390" y="128" text-anchor="middle">自动选主，数据安全优先</text>
<rect class="b5" x="540" y="14" width="200" height="130" rx="10"/>
<text class="tb" x="640" y="34" text-anchor="middle" dominant-baseline="middle">Stream</text>
<text class="ts" x="640" y="60" text-anchor="middle">追加日志，非破坏性消费</text>
<text class="ts" x="640" y="80" text-anchor="middle">按偏移量重复读取</text>
<text class="ts" x="640" y="100" text-anchor="middle">高吞吐、多消费者共享</text>
<text class="ts" x="640" y="124" text-anchor="middle">类 Kafka 语义</text>
<rect class="bg" x="20" y="164" width="720" height="124" rx="8"/>
<text class="th" x="32" y="184">选择与注意</text>
<text class="ts" x="380" y="208" text-anchor="middle">默认业务队列：仲裁队列（durable），副本数一般 3（奇数），跨可用区部署时关注网络延迟对写入的影响</text>
<text class="ts" x="380" y="228" text-anchor="middle">仲裁队列代价：比经典队列更耗磁盘与网络，不支持部分高级特性（如全局优先级、非持久化队列等，随版本变化，需查官方文档）</text>
<text class="ts" x="380" y="248" text-anchor="middle">需要回放/超高吞吐/海量消费者：用 Stream；但流式生态与工具链不如 Kafka 完整</text>
<text class="ts" x="380" y="268" text-anchor="middle">迁移：镜像队列→仲裁队列需要新建队列并迁移流量，不能原地转换，提前规划</text>
</svg>
<figcaption>图 2：队列类型与高可用</figcaption>
</figure>

要点：

- **集群 ≠ 高可用**：普通集群只共享元数据（交换机、绑定、队列定义），**队列内容只在一个节点**；队列所在节点挂掉，数据不可用。真正的高可用来自**队列的复制**（仲裁队列）；
- **脑裂与分区**：网络分区时的处理策略（`cluster_partition_handling`，如 pause_minority）要明确选择，避免两侧各自接受写入；
- **节点数**：仲裁队列依赖多数派，3 节点容忍 1 个故障，5 节点容忍 2 个；
- **磁盘与内存水位**：触发水位（内存高水位、磁盘空闲下限）后 Broker 会**阻塞所有生产者连接**（流控），这是线上最常见的“突然发不出消息”的原因。

## 可靠性：三段链路

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="RabbitMQ 端到端可靠性：生产端使用发布确认并在失败时重发，代理端使用持久化消息、持久化队列与仲裁队列，消费端使用手动 ack 和幂等处理，失败可重试并进入死信队列">
<rect class="b3" x="20" y="30" width="210" height="110" rx="10"/>
<text class="tb" x="125" y="50" text-anchor="middle" dominant-baseline="middle">① 生产端</text>
<text class="ts" x="125" y="76" text-anchor="middle">Publisher Confirm 异步确认</text>
<text class="ts" x="125" y="96" text-anchor="middle">mandatory/备用交换机防路由丢失</text>
<text class="ts" x="125" y="116" text-anchor="middle">未确认则重发（需幂等）</text>
<rect class="b5" x="275" y="30" width="210" height="110" rx="10"/>
<text class="tb" x="380" y="50" text-anchor="middle" dominant-baseline="middle">② 代理端</text>
<text class="ts" x="380" y="76" text-anchor="middle">消息持久化 delivery_mode=2</text>
<text class="ts" x="380" y="96" text-anchor="middle">durable 交换机 + 队列</text>
<text class="ts" x="380" y="116" text-anchor="middle">仲裁队列（多副本过半确认）</text>
<rect class="b2" x="530" y="30" width="210" height="110" rx="10"/>
<text class="tb" x="635" y="50" text-anchor="middle" dominant-baseline="middle">③ 消费端</text>
<text class="ts" x="635" y="76" text-anchor="middle">关闭自动 ack，处理成功再 ack</text>
<text class="ts" x="635" y="96" text-anchor="middle">失败：有限重试 → 死信</text>
<text class="ts" x="635" y="116" text-anchor="middle">业务幂等去重</text>
<line class="l" x1="230" y1="85" x2="275" y2="85" marker-end="url(#arr)"/>
<line class="l" x1="485" y1="85" x2="530" y2="85" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="162" width="720" height="142" rx="8"/>
<text class="th" x="32" y="182">每一环常见的丢/重复原因</text>
<text class="ts" x="380" y="208" text-anchor="middle">生产端：没开确认，网络断开时以为发送成功；交换机没有匹配队列消息被静默丢弃</text>
<text class="ts" x="380" y="228" text-anchor="middle">代理端：队列或消息非持久化，重启丢失；经典队列单节点故障；磁盘满触发流控或阻塞</text>
<text class="ts" x="380" y="248" text-anchor="middle">消费端：autoAck 下消费者崩溃，消息已出队即丢；处理成功但 ack 前宕机，会被重投 → 重复消费</text>
<text class="ts" x="380" y="270" text-anchor="middle">结论：RabbitMQ 只能做到“至少一次”，业务必须幂等；对账兜底才是最终保证</text>
<text class="ta" x="380" y="292" text-anchor="middle">事务模式（txSelect）性能很差，生产端应使用发布确认而不是 AMQP 事务</text>
</svg>
<figcaption>图 3：生产、存储、消费三段链路的可靠性措施</figcaption>
</figure>

### 生产端：发布确认

```java
// Spring AMQP：开启发布确认与退回
// application.yml:
// spring.rabbitmq.publisher-confirm-type: correlated
// spring.rabbitmq.publisher-returns: true
// spring.rabbitmq.template.mandatory: true

@Component
public class OrderPublisher {
    private final RabbitTemplate template;

    public OrderPublisher(RabbitTemplate template) {
        this.template = template;
        // 交换机是否收到：ack=true 表示 Broker 已接收（队列持久化时已落盘/过半副本）
        template.setConfirmCallback((cd, ack, cause) -> {
            if (!ack) {
                // 重发或落库待补偿；cd.getId() 关联到业务消息
                log.warn("publish nack id={} cause={}", cd.getId(), cause);
            }
        });
        // 路由不到队列：消息被退回
        template.setReturnsCallback(r ->
            log.error("unroutable exchange={} key={} reply={}", r.getExchange(), r.getRoutingKey(), r.getReplyText()));
    }

    public void publish(OrderEvent e) {
        CorrelationData cd = new CorrelationData(e.getEventId());
        template.convertAndSend("order.exchange", "order.paid", e, cd);
    }
}
```

要点：

- **confirm 只表示 Broker 收到了**，不表示消费者处理了；
- 高吞吐下用**异步确认 + 批量**，不要每条消息同步等待 confirm（延迟高、吞吐低）；
- 重要业务用 **Outbox（本地消息表）** 保证“业务数据与消息发送”一致，见 [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)，并保留 eventId 作为幂等键。

### 代理端：持久化

- 三件事都要持久：**交换机 durable、队列 durable、消息 delivery_mode=2（persistent）**；缺一不可；
- 持久化消息仍有短暂窗口（先进内存缓冲、批量刷盘）；**仲裁队列**在多数副本落盘后才确认，数据安全性更强；
- 不要在 Broker 重启后才发现队列没声明：应用启动时**幂等地声明拓扑**（`RabbitAdmin` 或基础设施即代码统一管理）。

### 消费端：ack 与重试

```java
@RabbitListener(queues = "order.paid.queue", ackMode = "MANUAL")
public void onMessage(OrderEvent e, Channel ch, @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        if (!idempotent.firstTime(e.getEventId())) { // 幂等：已处理过直接 ack
            ch.basicAck(tag, false);
            return;
        }
        service.handle(e);
        ch.basicAck(tag, false);
    } catch (BusinessRetryableException ex) {
        // 可重试：不重新入队（避免立即无限重投），交给延迟重试队列
        ch.basicNack(tag, false, false);
    } catch (Exception ex) {
        // 不可重试：直接进入死信
        ch.basicReject(tag, false);
    }
}
```

> [!WARNING] 不要无脑 requeue
> `nack(requeue=true)` 会让失败消息立刻回到队首再次投递，形成**毒消息死循环**：CPU 打满、日志刷屏、阻塞后面的正常消息。应使用**有限重试 + 死信队列**。

## 死信、重试与延迟消息

### 死信交换机（DLX）

消息变成“死信”的三种情况：**被拒绝且不重新入队**、**TTL 过期**、**队列达到长度上限**。队列可以配置死信交换机，让死信被路由到专门的死信队列，用于排查、重试、告警。

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="重试与死信拓扑：主队列处理失败后消息进入带 TTL 的重试队列，TTL 到期后通过死信交换机回到主交换机再次投递；超过最大重试次数则进入最终死信队列由人工处理">
<rect class="b3" x="20" y="40" width="120" height="56" rx="8"/>
<text class="tb" x="80" y="62" text-anchor="middle" dominant-baseline="middle">主交换机</text>
<text class="ts" x="80" y="82" text-anchor="middle">order.exchange</text>
<rect class="b1" x="190" y="40" width="130" height="56" rx="8"/>
<text class="tb" x="255" y="62" text-anchor="middle" dominant-baseline="middle">主队列</text>
<text class="ts" x="255" y="82" text-anchor="middle">消费者处理</text>
<rect class="b4" x="380" y="40" width="150" height="56" rx="8"/>
<text class="tb" x="455" y="62" text-anchor="middle" dominant-baseline="middle">重试队列</text>
<text class="ts" x="455" y="82" text-anchor="middle">TTL 如 10s/60s/5min</text>
<rect class="b5" x="590" y="40" width="150" height="56" rx="8"/>
<text class="tb" x="665" y="62" text-anchor="middle" dominant-baseline="middle">最终死信队列</text>
<text class="ts" x="665" y="82" text-anchor="middle">告警·人工处理</text>
<line class="l" x1="140" y1="68" x2="190" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="68" x2="380" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="68" x2="590" y2="68" marker-end="url(#arr)"/>
<text class="ta" x="350" y="36" text-anchor="middle">失败 nack</text>
<text class="ta" x="560" y="36" text-anchor="middle">超过最大次数</text>
<path class="la" d="M455 96 L455 140 L80 140 L80 96" marker-end="url(#arr-a)"/>
<text class="ta" x="270" y="134" text-anchor="middle">TTL 到期 → 经死信交换机回到主交换机重新投递</text>
<rect class="bg" x="20" y="164" width="720" height="92" rx="8"/>
<text class="ts" x="380" y="186" text-anchor="middle">用消息头 x-death / 自定义 retryCount 记录重试次数，达到上限改投最终死信队列，避免无限循环</text>
<text class="ts" x="380" y="206" text-anchor="middle">梯度退避：多个不同 TTL 的重试队列（10s、1min、10min），而不是单个固定间隔</text>
<text class="ts" x="380" y="226" text-anchor="middle">注意：队列级 TTL 比消息级 TTL 可靠——消息级 TTL 只在消息到达队首时才检查，前面的长 TTL 消息会阻塞后面短 TTL 的</text>
<text class="ts" x="380" y="246" text-anchor="middle">死信队列要有监控和处理流程（重放工具、定期清理），否则只是把问题“藏起来”</text>
</svg>
<figcaption>图 4：基于 TTL + 死信交换机的梯度重试拓扑</figcaption>
</figure>

### 延迟消息

| 方案 | 做法 | 优缺点 |
| --- | --- | --- |
| **TTL + 死信** | 消息进入无消费者的延迟队列，TTL 到期后被死信路由到真正的处理队列 | 无需插件；**消息级 TTL 有队首阻塞问题**，通常按固定档位建多个队列 |
| **延迟消息插件**（delayed-message exchange） | 交换机内部按延迟时间暂存后投递 | 使用方便、延迟任意；但**不适合海量延迟消息**（存在内存与持久化局限，且与仲裁队列的配合需看版本支持） |
| **业务侧定时任务** | 延迟事件入库，定时扫描到期的发送 | 可控、可对账，适合关键业务，如订单超时关闭 |
| **换用 RocketMQ 等** | 原生定时/延迟消息 | 延迟需求大时更合适，见 [RocketMQ 原理与事务消息](#/mw/rocketmq) |

通用的延迟方案对比见 [消息队列核心问题](#/mw/mq)。

## 预取、流控与消费调优

| 机制 | 作用 | 经验 |
| --- | --- | --- |
| **prefetch（QoS）** | 每个消费者最多持有多少条**未 ack** 的消息 | 默认较大时，慢消费者会囤积大量消息，其他消费者空闲（**消费不均**）；任务处理耗时长（秒级以上）设置**小值（如 1~10）**；耗时短、吞吐优先可适当调大（几十到几百） |
| **并发消费者** | 一个队列多个消费者并行 | 并发提升吞吐，但**破坏顺序**；需要顺序的业务按 key 分到不同队列，每队列单消费者 |
| **批量 ack** | `multiple=true` 一次确认多条 | 减少网络往返，但失败时要小心确认范围 |
| **内存/磁盘水位** | 达到阈值触发流控 | 监控并预留余量；堆积消息过多时优先**扩容消费者**，而不是等告警 |
| **连接级流控（credit flow）** | 内部背压，生产者连接被阻塞 | 看到连接状态 `blocking/blocked` 即为被限流 |
| **消息大小** | 大消息放对象存储，消息只带引用 | 大消息拖慢整个 Broker，见 [对象存储与文件服务](#/design/case-objectstore) |
| **惰性队列/磁盘优先** | 队列内容更多落盘以节省内存 | 现代版本队列已偏向磁盘友好；堆积严重的场景要评估磁盘 IO |

## Spring AMQP 实践要点

- **拓扑声明**：交换机、队列、绑定用 `@Bean`（`Queue`、`DirectExchange`、`Binding`）声明，指定 `durable`、死信参数、队列类型（`x-queue-type=quorum`）；
- **消息转换**：用 JSON 转换器（`Jackson2JsonMessageConverter`），并限制可反序列化的类型白名单，避免反序列化安全问题与类名耦合；
- **监听容器**：设置 `concurrency`/`maxConcurrency`、`prefetch`、`acknowledge-mode: manual`、`default-requeue-rejected: false`；
- **重试**：Spring 的 `retry` 属于**消费者线程内重试**，会占用线程且重试期间消息未 ack；耗时重试应走延迟重试队列；
- **连接管理**：生产者和消费者**使用不同的连接**，避免生产被流控阻塞时影响消费；
- **故障恢复**：开启自动恢复（默认），监听连接事件，网络闪断后重新订阅；
- **消息追踪**：为每条消息设置 `messageId`/`traceId`，日志与链路追踪串联，见 [链路追踪、日志与告警](#/infra/obs-trace)。

## 运维与监控

| 指标 | 含义与告警 |
| --- | --- |
| **队列长度（ready）** | 堆积情况；持续增长说明消费能力不足 |
| **未确认数（unacked）** | 已投递未 ack；长期很大说明消费者卡住或 prefetch 过大 |
| **入队/出队速率** | 生产与消费是否匹配；出速率为 0 而 ready 增长是故障信号 |
| **消费者数量** | 掉到 0 说明消费者全部断开 |
| **内存、磁盘水位、文件句柄、Erlang 进程数** | 触发流控前预警 |
| **连接与信道数** | 信道泄漏（只开不关）会耗尽资源 |
| **死信队列长度** | 异常消息累积，需人工介入 |
| **集群与队列主节点分布** | 主节点集中在少数节点会造成负载倾斜，需要再平衡 |

管理插件与指标导出（如 Prometheus 插件）可接入监控体系，见 [指标监控：Prometheus 与告警](#/infra/obs-metrics)。

## 常见线上问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 生产者突然全部卡住/超时 | 内存或磁盘水位触发流控，阻塞发布 | 先扩容消费、清理堆积，调整水位与容量；生产端设置超时与降级 |
| 消息丢了 | 未开 confirm、队列/消息非持久化、autoAck、路由不到队列静默丢弃 | 按三段链路逐项检查，开启 mandatory/备用交换机并监控退回 |
| 重复消费 | ack 前宕机、网络闪断、重复发布 | 业务幂等（唯一键/去重表），不要依赖“恰好一次” |
| 消费者一个很忙、其他空闲 | prefetch 过大，慢消息被囤积 | 调小 prefetch，按处理时长分队列 |
| unacked 持续增长 | 消费者卡死、忘记 ack、异常路径漏 ack | 超时监控、确保所有分支 ack/nack，设置消费超时 |
| 毒消息循环刷屏 | 失败后 requeue=true | 改为有限重试 + 死信，隔离毒消息 |
| 队列主节点倾斜 | 队列都建在同一节点 | 使用队列主节点均衡策略，重建/迁移队列 |
| 连接数暴涨 | 每次发送新建连接/信道不关闭 | 复用连接，信道池化，监控 channel 泄漏 |
| 网络分区后数据不一致 | 分区处理策略不当 | 使用仲裁队列并选择合适的分区处理策略 |
| 升级后队列行为变化 | 版本特性差异（队列类型、插件支持） | 升级前阅读发行说明，预发验证，滚动升级并监控 |

## 选型：RabbitMQ、Kafka 还是 RocketMQ

| 需求 | 倾向 |
| --- | --- |
| 复杂路由、任务队列、低延迟、RPC 回包、中小规模 | **RabbitMQ** |
| 日志/埋点/流式处理、超高吞吐、重放、大数据生态 | **Kafka**，见 [Kafka 架构与存储](#/mw/kafka) |
| 金融级业务消息、事务消息、定时消息、顺序消息 | **RocketMQ**，见 [RocketMQ 原理与事务消息](#/mw/rocketmq) |
| 多租户、存算分离、跨地域复制 | 考虑 **Pulsar**，见 [Pulsar 架构与存算分离](#/mw/pulsar) |
| 已有团队技术栈与运维能力 | 运维成熟度往往比理论指标更重要 |

整体对比与取舍框架见 [消息队列核心问题](#/mw/mq)。

## 相关阅读

- [消息队列核心问题](#/mw/mq)：丢失、重复、顺序、积压、延迟与事务消息的通用方案
- [Kafka 副本与可靠性](#/mw/kafka-reliability)：另一种可靠性模型的对照
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：消息可靠投递与幂等的架构做法
- [案例：实时推送系统设计详解](#/design/case-push)：消息队列在推送链路中的使用

## 面试追问

> [!QUESTION] RabbitMQ 的消息是怎么路由的？四种交换机有什么区别？
> 生产者把消息发给 Exchange，Exchange 按类型和 Binding 规则投递到队列。direct 按 routing key 精确匹配；topic 支持 * 和 # 通配；fanout 广播到所有绑定队列；headers 按消息头属性匹配。Exchange 不存消息，没有匹配队列时消息会被丢弃，除非开启 mandatory 或配置备用交换机。

> [!QUESTION] 如何保证 RabbitMQ 不丢消息？
> 三段链路：生产端用发布确认并在失败时重发，开启 mandatory 防路由丢失；代理端使用 durable 交换机和队列、持久化消息，高可用用仲裁队列；消费端关闭自动 ack、处理成功后再手动 ack，失败走有限重试和死信。最终只能保证至少一次，业务要幂等并辅以对账。

> [!QUESTION] 仲裁队列与镜像队列、经典队列有什么区别？
> 经典队列单节点存储，无复制；镜像队列用链式复制但在网络分区、同步性能上问题多，已被弃用；仲裁队列基于 Raft，多数副本写入才确认，自动选主，数据安全性更好，是现代集群的高可用推荐方案，代价是资源消耗更高、部分特性受限。需要回放和更高吞吐可用 Stream。

> [!QUESTION] 消息堆积、消费者空闲不均，怎么排查？
> 看队列的 ready 与 unacked、消费速率和消费者数量。unacked 很大说明消费者卡住或 prefetch 过大，慢消费者囤积消息导致其他消费者空闲，应调小 prefetch；ready 持续增长说明消费能力不足，需要增加并发或优化处理逻辑；同时检查内存和磁盘水位，防止触发流控阻塞生产者。

> [!QUESTION] 怎么实现重试和延迟消息？
> 重试用“TTL 重试队列 + 死信交换机”：失败后消息进入带 TTL 的重试队列，到期通过死信回到主交换机，多个不同 TTL 的队列实现梯度退避，超过次数进入最终死信队列。延迟消息可用 TTL+死信、延迟消息插件或业务侧定时任务；注意消息级 TTL 的队首阻塞问题，海量延迟需求考虑 RocketMQ。

> [!QUESTION] RabbitMQ 和 Kafka 怎么选？
> RabbitMQ 擅长灵活路由、低延迟的业务消息与任务队列，消费后删除，代理管理确认与重投；Kafka 是分区日志，擅长高吞吐、长期保留、重放与流式处理，消费者管位点。业务事件通知、任务分发选 RabbitMQ，日志与大数据管道选 Kafka，要事务和定时消息的金融场景可选 RocketMQ。
