---
level: 高级
tags: [事件驱动, EDA, 领域事件, Outbox, Saga, 幂等, 事件设计, Kafka, 最终一致]
summary: 事件驱动架构（EDA）的完整实践：事件与命令的区别、事件的四种用法（通知/状态传递/溯源/集成）、事件设计与 Schema 演进、可靠发布（Outbox/CDC）、可靠消费（幂等/乱序/重试/死信）、编排与协同两种 Saga 及补偿设计、订单下单端到端案例，以及排障与反模式。
---

# 事件驱动架构：事件设计、Outbox 与 Saga

> [!ABSTRACT] 核心要点
> - **事件**描述“**已经发生的事实**”（过去式、不可变、发布者不关心谁订阅）；**命令**是“请你去做某事”（有明确接收者、可被拒绝）。混淆两者是 EDA 里最常见的设计错误。
> - 事件驱动用**异步消息解耦服务**：发布者与订阅者在**时间、空间、逻辑**上解耦，换来扩展性与弹性，代价是**最终一致、调试困难、顺序与重复问题**。
> - **可靠发布靠 Outbox**（业务变更与事件在同一本地事务写入，再由中继/CDC 投递）；**可靠消费靠幂等**（至少一次投递是现实，恰好一次靠“至少一次 + 幂等”达成）。
> - 跨服务长事务用 **Saga**：每步是本地事务，失败则**反向补偿**；两种风格：**协同式（Choreography，事件接力）**与**编排式（Orchestration，协调者集中控制）**。
> - 事件是**公共契约**：要有 Schema、版本与兼容性策略，否则一次改字段就让所有订阅方崩溃。

> [!NOTE] 关联阅读
> 领域事件的来源见 [DDD 战术设计](#/design/ddd-tactical)；MQ 基础与可靠性见 [消息队列通用问题](#/mw/mq)、[Kafka 可靠性](#/mw/kafka-reliability)；分布式事务对比见 [分布式事务](#/distributed/transaction)。

## 一、事件、命令、查询

| | 命令 Command | 事件 Event | 查询 Query |
| --- | --- | --- | --- |
| 含义 | 请求做某事 | **某事已发生** | 请求读取数据 |
| 命名 | 祈使句：`ReserveStock` | **过去式**：`StockReserved` | `GetOrder` |
| 接收者 | **明确的一个** | **不确定，0~N 个订阅者** | 一个 |
| 可否被拒绝 | 可以（校验失败） | **不可以**（已发生） | — |
| 耦合 | 发送方知道接收方 | 发布方**不知道**订阅方 | — |
| 典型载体 | RPC、点对点队列 | **主题 Topic / 事件总线** | RPC |

经验：**当你发现自己在事件里写“请…”（如 `PleaseSendEmail`），那其实是命令**，应走点对点并明确责任方。

## 二、事件的四种用法

| 模式 | 事件内容 | 例子 | 取舍 |
| --- | --- | --- | --- |
| **事件通知**（Notification） | 很小：只有 ID 和类型 | `OrderPaid{orderId}` | 耦合最低；订阅方需回调查询详情，**有回调压力与时序问题** |
| **事件携带状态传递**（Event-Carried State Transfer） | 带订阅者所需的**完整数据快照** | `CustomerAddressChanged{id, newAddress...}` | 订阅方可**本地缓存副本**、无需回调，解耦、可用性高；数据冗余、事件变大 |
| **事件溯源**（Event Sourcing） | 事件**就是数据本身**，状态由事件重放得出 | 账户的存取款流水 | 见 [CQRS 与事件溯源](#/design/cqrs-es) |
| **集成事件 vs 领域事件** | 领域事件在**上下文内部**，可含内部细节；**集成事件**是对外**稳定契约**，由领域事件翻译而来 | 内部 `OrderLinePriced` → 对外 `OrderPlaced` | 避免内部模型变化直接波及外部订阅者 |

选择原则：**默认用“事件携带必要数据”**，减少回调；对外只暴露**精心设计的集成事件**。

## 三、基础架构

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="事件驱动架构：订单服务发布订单已支付事件到事件总线，库存、积分、通知、数据分析等订阅服务各自消费；发布者与订阅者互不知晓；总线可以是 Kafka 或 RocketMQ，事件携带统一的元数据与 Schema">
<rect class="b3" x="20" y="120" width="170" height="80" rx="12"/>
<text class="th" x="36" y="146">订单服务（发布者）</text>
<text class="ts" x="36" y="170">业务变更 + Outbox</text>
<text class="ts" x="36" y="188">发布 OrderPaid</text>
<rect class="b5" x="270" y="90" width="250" height="140" rx="12"/>
<text class="th" x="286" y="116">事件总线（Kafka / RocketMQ）</text>
<text class="ts" x="286" y="140">Topic: order.events</text>
<text class="ts" x="286" y="160">分区键 = orderId（同单有序）</text>
<text class="ts" x="286" y="180">持久化 · 可回放 · 多订阅组</text>
<text class="ts" x="286" y="200">Schema Registry（Avro/Protobuf）</text>
<line class="l" x1="190" y1="160" x2="270" y2="160" marker-end="url(#arr)"/>
<rect class="b2" x="600" y="30" width="170" height="46" rx="8"/>
<text class="tb" x="685" y="53" text-anchor="middle" dominant-baseline="middle">库存：确认扣减</text>
<rect class="b2" x="600" y="96" width="170" height="46" rx="8"/>
<text class="tb" x="685" y="119" text-anchor="middle" dominant-baseline="middle">积分：发放积分</text>
<rect class="b2" x="600" y="162" width="170" height="46" rx="8"/>
<text class="tb" x="685" y="185" text-anchor="middle" dominant-baseline="middle">通知：发送消息</text>
<rect class="b2" x="600" y="228" width="170" height="46" rx="8"/>
<text class="tb" x="685" y="251" text-anchor="middle" dominant-baseline="middle">数据平台：实时统计</text>
<line class="l" x1="520" y1="130" x2="600" y2="53" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="145" x2="600" y2="119" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="175" x2="600" y2="185" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="190" x2="600" y2="251" marker-end="url(#arr)"/>
<text class="ts" x="400" y="310" text-anchor="middle">新增订阅者不需要改发布者；订阅者故障不影响发布者（消息在总线里等待重试）</text>
</svg>
<figcaption>图 1：事件驱动：发布者与订阅者解耦</figcaption>
</figure>

**收益与代价**：

| 收益 | 代价 |
| --- | --- |
| 服务解耦，易扩展（加订阅者即可） | **最终一致**：不再有“调用返回即全部完成” |
| 削峰填谷、异步提升吞吐与可用性 | **流程分散**，“谁在响应这个事件”难以一眼看清；排障靠链路追踪（见 [链路追踪](#/infra/obs-trace)） |
| 天然留痕、可回放、可接入数据平台 | **重复、乱序、丢失**必须被设计对待 |
| 弹性：下游宕机恢复后继续消费 | 事件契约成为公共 API，演进成本高 |

## 四、事件设计

### 1. 事件结构（信封 + 载荷）

```json
{
  "eventId": "0192f6c4-9b1a-7e3c-8d11-5a4f2e6b7c90",
  "eventType": "order.paid",
  "schemaVersion": 2,
  "occurredAt": "2026-10-12T08:30:15.123Z",
  "producer": "order-service",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "aggregateType": "Order",
  "aggregateId": "O20261012000123",
  "aggregateVersion": 7,
  "data": { "orderId": "O20261012000123", "customerId": "C1001", "amountFen": 19900, "currency": "CNY",
            "paymentId": "P8899", "items": [ { "sku": "S-1", "qty": 2 } ] }
}
```

| 字段 | 作用 |
| --- | --- |
| `eventId` | **全局唯一**，消费端幂等去重的依据 |
| `eventType` + `schemaVersion` | 路由与兼容性 |
| `aggregateId` / `aggregateVersion` | 分区键与**乱序检测**（版本号单调递增，旧版本事件可丢弃） |
| `occurredAt` | 业务发生时间（≠ 消息投递时间） |
| `traceId` | 与链路追踪、日志关联 |

### 2. 设计原则

- **按业务含义命名，不按技术动作**：`OrderPaid` 而不是 `OrderTableUpdated`；**不要把数据库变更当业务事件对外暴露**（CDC 直出表变更会把内部表结构泄露成公共契约）；
- **事件要“自描述 + 足够完整”**，订阅者尽量不回查发布者；但**不要塞入敏感信息**（见 [Web 安全](#/security/web)、[加密与密钥](#/security/crypto)），含个人信息的字段按最小化原则；
- **一个事件只表达一个业务事实**，不要用一个 `OrderChanged` 事件带 type 字段表示十种变化；
- **幂等友好**：事件携带稳定的业务键与版本。

### 3. Schema 演进与兼容性

| 变更类型 | 兼容？ | 做法 |
| --- | --- | --- |
| 新增**可选**字段（带默认值） | 向后兼容 | 允许；订阅者忽略未知字段 |
| 删除/重命名字段、改变类型/语义 | **破坏性** | 新增 `schemaVersion` 或新事件类型，**新旧并行一段时间**再下线旧版 |
| 枚举新增值 | 需约定 | 订阅者对未知枚举值要有容错（走默认分支/忽略） |

用 **Schema Registry + Avro/Protobuf** 在发布时强制兼容性检查（如 BACKWARD/FULL）；订阅者遵循**“宽进”（tolerant reader）**：只读自己需要的字段、忽略未知字段。

## 五、可靠发布：Outbox

**问题（双写）**：先改库再发 MQ，或先发 MQ 再改库，中间任何一步失败都会导致**数据与事件不一致**（订单已入库但事件丢了，或事件已发但订单回滚）。

**方案：Transactional Outbox**——业务数据与事件在**同一个本地事务**写入；事件由独立进程可靠地投递出去。

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="Outbox 模式：服务在同一个数据库事务中写业务表和 outbox 表；中继进程轮询 outbox 或通过 CDC 读取 binlog，把事件投递到 Kafka，成功后标记已发送；消费者幂等处理；两种中继方式：轮询发布者简单，CDC 日志尾随延迟低且对业务无侵入">
<rect class="b3" x="20" y="40" width="240" height="120" rx="12"/>
<text class="th" x="36" y="66">应用 + 数据库（本地事务）</text>
<rect class="b" x="36" y="80" width="208" height="28" rx="6"/>
<text class="ts" x="140" y="94" text-anchor="middle" dominant-baseline="middle">写 orders 表（业务数据）</text>
<rect class="b" x="36" y="118" width="208" height="28" rx="6"/>
<text class="ts" x="140" y="132" text-anchor="middle" dominant-baseline="middle">写 outbox 表（事件）</text>
<rect class="b5" x="320" y="60" width="170" height="80" rx="12"/>
<text class="tb" x="405" y="86" text-anchor="middle" dominant-baseline="middle">中继 Relay</text>
<text class="ts" x="405" y="108" text-anchor="middle">轮询 outbox</text>
<text class="ts" x="405" y="124" text-anchor="middle">或 CDC 读 binlog</text>
<rect class="b2" x="550" y="60" width="110" height="80" rx="12"/>
<text class="tb" x="605" y="94" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<text class="ts" x="605" y="116" text-anchor="middle">至少一次</text>
<rect class="b1" x="700" y="60" width="80" height="80" rx="12"/>
<text class="tb" x="740" y="94" text-anchor="middle" dominant-baseline="middle">消费者</text>
<text class="ts" x="740" y="116" text-anchor="middle">幂等</text>
<line class="l" x1="260" y1="100" x2="320" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="100" x2="550" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="660" y1="100" x2="700" y2="100" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="180" width="760" height="100" rx="10"/>
<text class="th" x="36" y="204">要点</text>
<text class="ts" x="36" y="226">• 业务与事件同事务 → 要么都成功要么都失败，消除双写不一致　• 中继崩溃/重复发送 → 至少一次，靠消费者幂等兜底</text>
<text class="ts" x="36" y="246">• 轮询：简单（SELECT ... WHERE status=0 ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED），有延迟与库压力；</text>
<text class="ts" x="36" y="264">• CDC（Debezium 读 binlog）：低延迟、无轮询压力、保持提交顺序；需要运维 CDC 组件（见 CDC 笔记）</text>
</svg>
<figcaption>图 2：Outbox：业务变更与事件在同一事务落库，再可靠投递</figcaption>
</figure>

```sql
CREATE TABLE outbox (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id      CHAR(36) NOT NULL UNIQUE,
  aggregate_id  VARCHAR(64) NOT NULL,     -- 作为 Kafka 分区键，保证同一聚合有序
  event_type    VARCHAR(64) NOT NULL,
  payload       JSON NOT NULL,
  status        TINYINT NOT NULL DEFAULT 0,   -- 0 待发 1 已发
  created_at    DATETIME(3) NOT NULL,
  KEY idx_status_id (status, id)
);
```

```java
@Transactional
public void pay(...) {
    order.pay(...); orderRepo.save(order);                       // 业务变更
    outboxRepo.save(Outbox.of(order.pullEvents()));              // 同事务写事件
}
// 中继：批量取待发事件 → 发送 Kafka（同步等 ack）→ 标记已发/删除；失败下次重试；发送顺序按 id 且按聚合分区
```

要点：**outbox 表要定期清理/归档**；发布顺序以**聚合为单位**保证（同一聚合键进同一分区）；中继多实例时用 `SKIP LOCKED` 或分片避免重复抢占。与“本地消息表”本质相同，见 [订单、支付与对账系统设计](#/design/case-payment)；CDC 原理见 [CDC 与实时数仓](#/bigdata/cdc)。

**替代方案**：RocketMQ 事务消息（半消息 + 回查）；对一致性要求不高时“先写库、事务提交后发 MQ（失败重试/补偿扫描）”。

## 六、可靠消费：幂等、乱序、重试

消息系统通常保证**至少一次**投递（见 [Kafka 可靠性](#/mw/kafka-reliability)），所以消费端必须能处理：**重复、乱序、延迟、毒丸消息**。

### 1. 幂等消费

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **去重表** | 同事务里插入 `processed_event(event_id UNIQUE)`，插入成功才执行业务，重复则跳过 | 通用、最可靠 |
| **业务天然幂等** | 条件更新（`WHERE status='UNPAID'`）、`INSERT ... ON DUPLICATE KEY`、按版本号覆盖 | 状态机类 |
| **Redis `SET NX` 去重** | 高性能但 TTL 过期后可能重复，**不能作为唯一保障** | 辅助 |
| **版本号/序号比较** | 事件版本 ≤ 本地已处理版本则丢弃 | 同时解决乱序 |

```java
@Transactional
public void handle(OrderPaid e) {
    try { processedRepo.insert(e.eventId()); }                 // eventId 唯一索引：重复则抛异常
    catch (DuplicateKeyException dup) { return; }              // 已处理，直接确认消息
    stockService.confirmDeduct(e.orderId());                   // 业务与“已处理”标记在同一事务
}
```

### 2. 顺序

- **只保证同一聚合内有序**：用聚合 ID 做分区键，Kafka 同分区有序；**全局有序代价极高，不要追求**；
- 并发消费会打乱同分区顺序：同一分区**单线程消费**或按 key 在内存中分桶串行；
- 即使有序，**重试可能乱序**（A 失败重试时 B 已处理）：靠 `aggregateVersion` 判断，旧版本丢弃，**缺失版本则暂存等待或回查**。

### 3. 失败处理：重试与死信

<figure class="fig">
<svg viewBox="0 0 800 240" class="dg" role="img" aria-label="消费失败处理：消费事件失败后先本地重试，仍失败进入带延迟的重试主题，按递增间隔多次重试，超过次数进入死信队列，告警并人工或自动修复后重新投递；毒丸消息不能阻塞整条分区">
<rect class="b2" x="20" y="40" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="68" text-anchor="middle" dominant-baseline="middle">主 Topic</text>
<rect class="b3" x="190" y="40" width="130" height="56" rx="8"/>
<text class="tb" x="255" y="68" text-anchor="middle" dominant-baseline="middle">消费者</text>
<rect class="b5" x="360" y="40" width="150" height="56" rx="8"/>
<text class="tb" x="435" y="60" text-anchor="middle" dominant-baseline="middle">重试 Topic</text>
<text class="ts" x="435" y="80" text-anchor="middle">10s → 1m → 10m</text>
<rect class="b4" x="550" y="40" width="130" height="56" rx="8"/>
<text class="tb" x="615" y="60" text-anchor="middle" dominant-baseline="middle">死信 DLQ</text>
<text class="ts" x="615" y="80" text-anchor="middle">告警 · 排查</text>
<line class="l" x1="150" y1="68" x2="190" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="68" x2="360" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="68" x2="550" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="340" y="34" text-anchor="middle">失败</text>
<text class="ts" x="530" y="34" text-anchor="middle">超次数</text>
<rect class="bg" x="20" y="120" width="760" height="100" rx="10"/>
<text class="th" x="36" y="144">原则</text>
<text class="ts" x="36" y="166">• 区分可重试错误（超时、下游暂不可用）与不可重试错误（数据非法、业务规则拒绝）：后者直接入 DLQ</text>
<text class="ts" x="36" y="186">• 不要原地无限重试阻塞整个分区：转入重试 Topic 带退避延迟，主流程继续消费</text>
<text class="ts" x="36" y="206">• DLQ 必须有监控告警和重新投递工具；修复后可重放；重试次数、原因记录在消息头</text>
</svg>
<figcaption>图 3：消费失败：重试主题 + 死信队列</figcaption>
</figure>

### 4. 其他消费端要点

- **背压与限速**：下游慢时用有界队列与限流，避免打垮数据库；
- **事务边界**：消费逻辑本地事务提交**之后**再提交 offset（或在事务内与业务一起，如 Kafka 事务/幂等去重表）；
- **消费延迟监控**：lag 是 EDA 的核心健康指标（见 [指标监控](#/infra/obs-metrics)）；
- **版本兼容**：同时部署新旧版本消费者时，处理未知版本事件要容错。

## 七、Saga：跨服务的长事务

### 1. 为什么需要 Saga

跨多个服务的业务流程（下单：扣库存 → 扣余额 → 创建物流）无法用单个 ACID 事务覆盖。**Saga** 把长事务拆成一系列**本地事务**，每步有对应的**补偿事务**；任一步失败则按**相反顺序执行已完成步骤的补偿**，达到**最终一致**。

> [!WARNING] 补偿不是回滚
> 补偿是**新的业务操作**（如“退款”“释放库存”“发送取消通知”），而不是数据库级回滚。中间状态**对外可见**（用户可能看到“订单处理中”），所以必须**设计中间状态**，并考虑补偿本身也可能失败（需要重试到成功，补偿必须幂等且“必须成功”）。

### 2. 两种实现风格

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="Saga 两种风格：协同式各服务订阅上一步的事件并发布自己的事件形成事件接力，无中心；编排式由一个 Saga 协调者向各服务发送命令并接收回复，集中管理流程和补偿">
<rect class="b3" x="20" y="20" width="370" height="200" rx="12"/>
<text class="th" x="36" y="46">协同式 Choreography（事件接力）</text>
<rect class="b2" x="36" y="64" width="100" height="40" rx="6"/>
<text class="ts" x="86" y="84" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<rect class="b2" x="156" y="64" width="100" height="40" rx="6"/>
<text class="ts" x="206" y="84" text-anchor="middle" dominant-baseline="middle">库存服务</text>
<rect class="b2" x="276" y="64" width="100" height="40" rx="6"/>
<text class="ts" x="326" y="84" text-anchor="middle" dominant-baseline="middle">支付服务</text>
<line class="l" x1="136" y1="84" x2="156" y2="84" marker-end="url(#arr)"/>
<line class="l" x1="256" y1="84" x2="276" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="146" y="60" text-anchor="middle">OrderCreated</text>
<text class="ts" x="266" y="60" text-anchor="middle">StockReserved</text>
<text class="ts" x="36" y="130" text-anchor="start">支付失败 → 发 PaymentFailed</text>
<text class="ts" x="36" y="150" text-anchor="start">→ 库存订阅并释放 → 订单订阅并取消</text>
<text class="ts" x="36" y="176" text-anchor="start">✓ 无中心、松耦合、易扩展少量参与者</text>
<text class="ts" x="36" y="196" text-anchor="start">✗ 流程隐含在事件里，步骤多时难以理解、易循环依赖</text>
<rect class="b5" x="410" y="20" width="370" height="200" rx="12"/>
<text class="th" x="426" y="46">编排式 Orchestration（协调者）</text>
<rect class="b4" x="540" y="62" width="110" height="40" rx="6"/>
<text class="ts" x="595" y="82" text-anchor="middle" dominant-baseline="middle">Saga 协调者</text>
<rect class="b2" x="430" y="140" width="100" height="36" rx="6"/>
<text class="ts" x="480" y="158" text-anchor="middle" dominant-baseline="middle">库存</text>
<rect class="b2" x="555" y="140" width="100" height="36" rx="6"/>
<text class="ts" x="605" y="158" text-anchor="middle" dominant-baseline="middle">支付</text>
<rect class="b2" x="680" y="140" width="90" height="36" rx="6"/>
<text class="ts" x="725" y="158" text-anchor="middle" dominant-baseline="middle">物流</text>
<line class="l" x1="570" y1="102" x2="490" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="595" y1="102" x2="605" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="102" x2="715" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="426" y="196" text-anchor="start">✓ 流程集中可见、易加步骤/补偿、状态可查</text>
<text class="ts" x="426" y="212" text-anchor="start">✗ 协调者是新组件，需防“上帝服务”与单点</text>
<rect class="bg" x="20" y="240" width="760" height="124" rx="10"/>
<text class="th" x="36" y="264">选型与实践</text>
<text class="ts" x="36" y="286">• 参与者少（≤3~4）、流程简单 → 协同式；流程长、分支多、需可视化与超时管理 → 编排式</text>
<text class="ts" x="36" y="306">• 编排式的协调者要持久化 Saga 状态（状态机 + 重试 + 超时），可用 Seata Saga、Temporal、Camunda、Netflix Conductor 或自建</text>
<text class="ts" x="36" y="326">• 每个步骤与补偿都必须幂等，必须能在“请求未知结果”（超时）时安全重试；先“预留”再“确认/取消”（TCC 思想）可减少补偿副作用</text>
<text class="ts" x="36" y="346">• 对比：TCC 侵入大、隔离性好；Saga 无锁、最终一致、中间状态可见；2PC/XA 强一致但性能与可用性差（见 分布式事务）</text>
</svg>
<figcaption>图 4：Saga 的协同式与编排式</figcaption>
</figure>

### 3. 设计 Saga 的注意事项

| 问题 | 对策 |
| --- | --- |
| **中间状态可见** | 订单设“处理中/待确认”等状态；对用户展示合适文案；禁止对中间状态做不可逆操作 |
| **补偿失败** | 补偿必须幂等并**无限重试**直到成功；仍失败进入人工处理队列并告警 |
| **步骤顺序** | 把**最可能失败、最难补偿**的步骤放前面；把**不可补偿**的步骤（发货、扣第三方）放最后 |
| **超时与悬挂** | 每步设超时；“**空补偿**”（补偿先到、正向后到）和“**悬挂**”（补偿后正向才到）要用状态记录避免执行 |
| **隔离性缺失** | 脏读/丢失更新：用语义锁（状态标记）、可交换更新、对账兜底 |
| **可观测** | 每个 Saga 实例有 ID，全链路带上；监控卡住的 Saga 数量与时长 |

## 八、端到端示例：下单 Saga（编排 + 事件）

1. 订单服务：创建订单（状态 `PENDING`）+ Outbox 写 `OrderCreated`；
2. 协调者收到事件，向库存发命令 `ReserveStock`；库存成功 → 回复 `StockReserved`，失败 → `StockRejected`（订单取消，结束）；
3. 协调者向支付发 `CreatePayment`；用户支付成功 → `PaymentCaptured`；超时未付 → `PaymentExpired`；
4. 成功：订单置 `PAID`，向库存发 `ConfirmStock`、向营销发 `GrantPoints`；
5. 失败/超时：协调者向库存发 `ReleaseStock` 补偿，订单置 `CANCELLED`；
6. **所有消息幂等；所有状态变更伴随 Outbox；协调者状态落库**；整个过程 `sagaId + traceId` 贯穿，卡死的实例定时扫描告警。

支付与对账细节：[订单、支付与对账系统设计详解](#/design/case-payment)；秒杀场景下的异步化下单：[秒杀系统设计](#/design/seckill)。

## 九、同步调用 vs 事件：怎么选

| 场景 | 推荐 |
| --- | --- |
| 需要**立即结果**（查询、校验、用户在等待） | 同步（RPC/HTTP） |
| 通知类、衍生动作（发短信、积分、统计、搜索索引更新） | **事件** |
| 需要**强一致**的小范围操作 | 同一服务/同一数据库事务内完成 |
| 跨服务流程、允许最终一致 | **Saga + 事件** |
| 调用链很长、下游经常不可用 | 事件异步化提升可用性（配合降级，见 [限流、熔断与降级](#/distributed/governance)） |

反模式：**把所有调用都改成事件**，结果得到一个“分布式的 GOTO”，没人知道流程怎么走；**用事件实现请求-响应**（发布命令再等回复）通常比直接 RPC 更复杂。

## 十、常见坑与排障

| 坑 | 对策 |
| --- | --- |
| 双写不一致（先写库后发 MQ） | Outbox / 事务消息 |
| 消费者没做幂等，重复扣款/发券 | 去重表 + 条件更新 |
| 乱序导致状态被旧事件覆盖 | 聚合版本号比较；按聚合分区 |
| 毒丸消息卡死分区 | 重试 Topic + DLQ，不阻塞主消费 |
| 事件变成“数据库变更日志”外泄 | 对外只发设计过的集成事件 |
| 事件 Schema 随意改，下游崩溃 | Schema Registry + 兼容性规则 + 版本并行 |
| 事件风暴：级联事件循环 | 绘制事件流图，避免 A→B→A；设置循环检测/最大跳数 |
| 消息积压 | 扩容消费者/分区、限流上游、先处理高优先级；监控 lag 并告警 |
| 排查困难 | 事件带 `traceId`/`sagaId`；链路追踪覆盖 MQ；保留事件日志可回放 |
| 测试困难 | 契约测试（Pact/Schema 兼容）；消费者幂等与乱序的专项测试；故障注入 |
| 发布顺序依赖 | 先发布订阅方（容忍新事件），再发布发布方 |

## 相关阅读

- [消息队列平台化与治理](#/mw/mq-governance)：统一事件信封、死信与消息轨迹
- [RabbitMQ 原理与可靠性（AMQP、仲裁队列与死信）](#/mw/rabbitmq)：一种消息代理的可靠投递实践
- [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)：双写问题与对账
- [幂等设计与重试：幂等键、去重表与超时未知](#/distributed/idempotent)：消费幂等

## 面试追问

> [!QUESTION] 事件和命令有什么区别？
> 事件是已经发生的事实，过去式命名，不可变，发布者不关心谁订阅，可有零到多个订阅者；命令是请求某个明确的接收者去做某事，可以被拒绝。把请求写成事件会造成隐式耦合和责任不清，应走点对点命令。

> [!QUESTION] 如何保证业务数据变更与事件发布的一致性？
> 用 Outbox 模式：在同一个本地事务里写业务表和 outbox 表，由中继进程轮询或通过 CDC 读 binlog 投递到消息队列，成功后标记；投递至少一次，消费端靠幂等兜底。也可用 RocketMQ 事务消息，避免先写库后发 MQ 的双写不一致。

> [!QUESTION] 事件重复、乱序、丢失分别怎么处理？
> 重复靠幂等：eventId 去重表或条件更新；乱序靠按聚合 ID 分区保证同聚合有序，再用聚合版本号丢弃旧事件；丢失靠 Outbox 保证发布、消费端手动提交位点与重试，再用对账兜底。毒丸消息用重试主题和死信队列，避免阻塞分区。

> [!QUESTION] Saga 是什么？协同式和编排式如何选？
> Saga 把跨服务长事务拆成一系列本地事务，每步有补偿，失败时反向补偿达到最终一致。协同式靠事件接力、无中心、适合少量参与者但流程隐含；编排式由协调者集中控制流程和补偿，易管理和可视化，适合步骤多、有分支和超时的流程，但协调者要持久化状态避免成为单点。

> [!QUESTION] Saga 的补偿有哪些坑？
> 补偿不是回滚而是新的业务操作，中间状态对外可见，补偿必须幂等并重试到成功；要处理空补偿和悬挂，把难补偿或不可补偿的步骤放后面，缺乏隔离性要用语义锁和对账兜底。

> [!QUESTION] 事件应该带多少数据？如何演进事件结构？
> 通知式事件只带 ID，订阅方要回查；携带状态的事件带必要快照，减少回调并提高解耦与可用性。对外应是稳定的集成事件而非内部表变更。演进时新增可选字段是兼容的，删除或改语义要加版本并新旧并行，用 Schema Registry 强制兼容性，订阅方采用宽进策略忽略未知字段。

> [!QUESTION] 什么时候不该用事件驱动？
> 需要立即返回结果的查询和校验、需要强一致的小范围操作、流程简单且不需要解耦的场景，不应强行事件化。滥用会让流程分散、难以理解和排查，请求响应场景用事件反而更复杂。
