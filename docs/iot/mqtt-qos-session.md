---
level: 深入
tags: [MQTT, QoS, 会话, 飞行窗口, 离线消息, 遗嘱, 保留消息, 共享订阅, 主题匹配, Broker 语义, 重传, 顺序]
summary: MQTT 的 QoS 与会话在 Broker 与客户端内部是如何实现的：QoS1/QoS2 的发送方与接收方状态机与持久化要求、重传规则与顺序保证、飞行窗口与背压、会话状态的组成（订阅、未确认报文、离线队列）与生命周期、客户端 ID 接管、遗嘱触发条件、保留消息的存储与投递规则、主题树匹配算法与共享订阅的分发策略、投递 QoS 的降级。
---

# QoS、会话与 Broker 语义：状态机、离线队列与共享订阅

> [!ABSTRACT] 核心要点
> - **QoS 是“逐跳（hop-by-hop）”的承诺，不是端到端的**：发布者→Broker 一段有自己的 QoS，Broker→订阅者一段另有 QoS，**实际投递 QoS = min(发布 QoS, 订阅授予 QoS)**。端到端“业务送达”必须靠应用层确认（见 [弱网、可靠性、安全与排障](#/iot/mqtt-practice)）。
> - **QoS1 = 至少一次**：发送方**保存消息直到收到 PUBACK**，断线重连后（且会话保留时）**用原 Packet ID、DUP=1 重发**；接收方可能收到重复，**必须由应用幂等**。**QoS2 = 恰好一次（协议内）**：靠**四步握手 + 接收方记住已收到的 Packet ID 直到 PUBREL**，确保应用只被交付一次，代价是**多两个往返和两侧状态存储**。
> - **重传只发生在“重连之后”**（3.1.1 与 5.0 一致）：**同一条 TCP 连接内 MQTT 不重传**（TCP 已保证可靠有序），超时没收到 PUBACK 不应该自行重发；这与很多人的直觉相反，也是**实现与排障**的关键。
> - **会话（Session）= 订阅集合 + 飞行中的 QoS1/2 状态 + 离线期间排队的消息**。`Clean Session=0`（5.0 为 `Clean Start=0` + `Session Expiry>0`）才会**跨连接保留**；**会话占用 Broker 内存/磁盘**，大规模场景下要限制离线队列、过期时间与 in-flight 数。
> - **同一个客户端 ID 只能有一个活跃连接**：新连接到来，Broker **踢掉旧连接（takeover）**；两个设备配置了相同 ID 会**互相踢、不断重连**（经典事故）。
> - **Broker 的匹配性能取决于主题树（Trie）与订阅表的设计**；**共享订阅**让多个消费者按组**负载均衡地分摊**同一主题消息，是 MQTT 做“服务端消费集群”的标准方式。

## QoS 状态机

### QoS 0：至多一次

`PUBLISH(QoS0)` 发出即忘，**无应答、无状态、无重传**；Broker 也不保证写入队列。适合**高频、可丢的遥测**（每秒一次的温度）。**QoS0 消息不占 Packet ID，不占飞行窗口**，是最高吞吐、最低开销的选项。注意：即使是 QoS0，**TCP 连接断开时，缓冲区里尚未发出/未被对端读取的数据会丢**。

### QoS 1：至少一次

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="QoS1 的发送方与接收方状态：发送方发出 PUBLISH 并保存报文，进入等待 PUBACK 状态；收到 PUBACK 后删除保存的报文，释放 Packet ID；若连接断开且会话保留，重连后用相同 Packet ID 和 DUP 为 1 重发；接收方收到 PUBLISH 后交付给应用然后回复 PUBACK，若 PUBACK 丢失则会收到重复的 PUBLISH 需要应用层幂等处理">
<rect class="b3" x="20" y="14" width="150" height="40" rx="8"/>
<text class="tb" x="95" y="34" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b1" x="590" y="14" width="150" height="40" rx="8"/>
<text class="tb" x="665" y="34" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="ld" x1="95" y1="54" x2="95" y2="230"/>
<line class="ld" x1="665" y1="54" x2="665" y2="230"/>
<line class="l" x1="95" y1="84" x2="665" y2="104" marker-end="url(#arr)"/>
<text class="ta" x="380" y="86" text-anchor="middle">① PUBLISH (QoS1, id=7)</text>
<rect class="b4" x="20" y="96" width="150" height="30" rx="6"/>
<text class="ts" x="95" y="111" text-anchor="middle" dominant-baseline="middle">持久保存报文，占用 id=7</text>
<rect class="b5" x="590" y="116" width="150" height="30" rx="6"/>
<text class="ts" x="665" y="131" text-anchor="middle" dominant-baseline="middle">交付给应用（或入队）</text>
<line class="la" x1="665" y1="156" x2="95" y2="176" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="158" text-anchor="middle">② PUBACK (id=7)</text>
<rect class="b2" x="20" y="186" width="150" height="30" rx="6"/>
<text class="ts" x="95" y="201" text-anchor="middle" dominant-baseline="middle">删除报文，释放 id=7</text>
<rect class="bg" x="20" y="244" width="720" height="86" rx="8"/>
<text class="th" x="32" y="264">异常路径</text>
<text class="ts" x="380" y="288" text-anchor="middle">PUBACK 丢失/连接断：发送方仍保存报文；若会话保留，重连后以 id=7、DUP=1 重发 → 接收方可能第二次收到同一消息</text>
<text class="ts" x="380" y="310" text-anchor="middle">所以 QoS1 的接收方应用必须幂等（DUP 位只是提示，不能作为可靠的去重依据，需要业务唯一键）</text>
</svg>
<figcaption>图 1：QoS1 的握手与重传语义</figcaption>
</figure>

状态存储要求：

| 一方 | 必须保存什么 | 何时释放 |
| --- | --- | --- |
| **发送方** | 完整的 PUBLISH 报文（含 Packet ID） | 收到 PUBACK |
| **接收方** | 无需保存（交付后即可回 PUBACK；重复到达就再交付一次） | — |

### QoS 2：恰好一次

<figure class="fig">
<svg viewBox="0 0 760 380" class="dg" role="img" aria-label="QoS2 四步握手与状态：发送方发出 PUBLISH 并保存报文；接收方收到后保存 Packet ID 并回复 PUBREC，此时按方法 A 可立即交付给应用；发送方收到 PUBREC 后丢弃已保存的 PUBLISH，改为保存 PUBREL 状态并发出 PUBREL；接收方收到 PUBREL 后丢弃 Packet ID 记录并回复 PUBCOMP；发送方收到 PUBCOMP 后释放 Packet ID；任何一步丢失都在重连后重发 PUBLISH 或 PUBREL，接收方凭记录的 Packet ID 去重">
<rect class="b3" x="20" y="14" width="150" height="40" rx="8"/>
<text class="tb" x="95" y="34" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b1" x="590" y="14" width="150" height="40" rx="8"/>
<text class="tb" x="665" y="34" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="ld" x1="95" y1="54" x2="95" y2="300"/>
<line class="ld" x1="665" y1="54" x2="665" y2="300"/>
<line class="l" x1="95" y1="78" x2="665" y2="92" marker-end="url(#arr)"/>
<text class="ta" x="380" y="76" text-anchor="middle">① PUBLISH (QoS2, id=9)</text>
<rect class="b4" x="20" y="84" width="150" height="26" rx="6"/>
<text class="ts" x="95" y="97" text-anchor="middle" dominant-baseline="middle">保存 PUBLISH</text>
<rect class="b5" x="590" y="102" width="150" height="26" rx="6"/>
<text class="ts" x="665" y="115" text-anchor="middle" dominant-baseline="middle">记录 id=9，向应用交付</text>
<line class="la" x1="665" y1="140" x2="95" y2="154" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="138" text-anchor="middle">② PUBREC (id=9)</text>
<rect class="b4" x="20" y="146" width="150" height="26" rx="6"/>
<text class="ts" x="95" y="159" text-anchor="middle" dominant-baseline="middle">改存 PUBREL 态</text>
<line class="l" x1="95" y1="190" x2="665" y2="204" marker-end="url(#arr)"/>
<text class="ta" x="380" y="188" text-anchor="middle">③ PUBREL (id=9)</text>
<rect class="b5" x="590" y="214" width="150" height="26" rx="6"/>
<text class="ts" x="665" y="227" text-anchor="middle" dominant-baseline="middle">删除 id=9 记录</text>
<line class="la" x1="665" y1="252" x2="95" y2="266" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="250" text-anchor="middle">④ PUBCOMP (id=9)</text>
<rect class="b2" x="20" y="258" width="150" height="26" rx="6"/>
<text class="ts" x="95" y="271" text-anchor="middle" dominant-baseline="middle">释放 id=9</text>
<rect class="bg" x="20" y="306" width="720" height="66" rx="8"/>
<text class="ts" x="380" y="328" text-anchor="middle">关键：接收方在回 PUBREC 后一直记着 id=9，直到收到 PUBREL；期间再收到 PUBLISH(id=9) 只回 PUBREC、不再交付 → 去重</text>
<text class="ts" x="380" y="350" text-anchor="middle">发送方收到 PUBREC 后不再重发 PUBLISH，只重发 PUBREL；两侧各自持久化状态，崩溃重启后能继续</text>
</svg>
<figcaption>图 2：QoS2 的四步握手与两侧状态</figcaption>
</figure>

| 一方 | 阶段与保存内容 |
| --- | --- |
| **发送方** | 发出 PUBLISH 后保存**整个报文**；收到 PUBREC 后**丢弃报文**，改为保存**“已发 PUBREL”的 Packet ID 状态**；收到 PUBCOMP 后释放 |
| **接收方** | 收到 PUBLISH 后**记录 Packet ID**并回 PUBREC；收到 PUBREL 后**删除记录**并回 PUBCOMP |

**规范允许两种交付时机**：**方法 A**——收到 PUBLISH 时即向应用交付（并记录 ID 防重）；**方法 B**——收到 PUBREL 后才交付。两者对订阅者都是“恰好一次”，区别在延迟与存储。

为什么需要两阶段？只靠 PUBREC 无法区分“接收方已收到并交付”与“PUBREC 丢了”：**PUBREL 是发送方对“你收到了”的确认，接收方据此才敢忘记 ID**。多出的往返换来**协议内的去重**。

### 重传规则：只在重连后

| 规则 | 说明 |
| --- | --- |
| **同一连接内不重传** | TCP 保证有序可靠；MQTT 不应“超时后重发 PUBLISH”。这样做会造成**重复消息**，并且在拥塞时**雪上加霜** |
| **重连后（会话保留）必须重发** | 客户端和服务端都要**按原顺序**重发所有未确认的 PUBLISH（QoS>0，DUP=1，原 ID）与 PUBREL（原 ID） |
| **会话不保留则丢弃** | `Clean Session=1` 重连，旧的未确认状态全部丢弃，**消息可能丢失** |
| **PUBLISH 重发保持顺序** | 重发的顺序必须与原发送顺序一致 |
| **PUBREL 重发不带 DUP** | `PUBREL` 固定标志位是 `0010`，没有 DUP 位 |

> [!WARNING] “我给 MQTT 加了超时重发，怎么出现重复了？”
> 很多业务层在“QoS1 + 应用层超时重发”上叠加了第二层重发，导致**重复指令**。要么完全信任协议层（并由应用幂等），要么在**应用层**用业务 ID 做确认与重试，**但不要对同一连接内的 MQTT 报文自行重传**。见 [弱网、可靠性、安全与排障](#/iot/mqtt-practice)。

### 顺序保证

规范要求：**对同一主题、同一 QoS 级别，Broker 应按发布的顺序投递（有序主题 Ordered Topic，可选）**；**不同 QoS 之间不保证相对顺序**（例如 QoS0 的消息可能先于更早发布的 QoS1 到达）。实践：

- 同一连接上 QoS1/2 的飞行窗口内，**应答可能乱序**，但**消息交付顺序**由 Broker 维护；
- 需要严格顺序（如状态变更）时，**消息体里带序号/时间戳**，接收方丢弃过期的，不要完全依赖协议顺序；
- Broker 集群下跨节点转发可能带来**乱序**（取决于实现），见 [Broker 架构与集群（EMQX）](#/iot/broker)。

### 飞行窗口与背压

**飞行窗口（in-flight window）**：已发出但尚未收到最终应答的 QoS1/2 报文数量上限。

- 发送方（客户端或 Broker 向订阅者投递）**不能无限发送**：未确认数达到窗口上限就**暂停发送，排队等待**；
- 5.0 用 **Receive Maximum**（接收方声明最多同时处理多少 QoS1/2）**显式协商**；3.1.1 没有协议内协商，靠实现自身上限（Broker 常见默认几十量级，如 20~32，以所用产品配置为准）；
- **窗口大小决定了吞吐**：吞吐 ≈ 窗口大小 / RTT，高延迟链路上窗口过小会严重限速；
- **慢消费者**：订阅者处理慢、窗口占满，Broker 侧该会话的**消息堆积在队列中**，队列满则丢弃（QoS0 最先丢）或拒绝，见 [Broker 架构与集群（EMQX）](#/iot/broker) 的慢消费者章节；
- 客户端侧发布：库（如 Paho）的 `maxInflight` 控制，窗口满时 `publish` 可能阻塞或抛异常，需要**限流与背压**设计。

## 会话（Session）

### 会话里有什么

| 内容 | 说明 |
| --- | --- |
| **订阅集合** | 客户端的所有主题过滤器与授予的 QoS（含 5.0 订阅选项） |
| **客户端→服务器方向的飞行状态** | 未确认的 QoS1/2 PUBLISH、未完成的 PUBREL（客户端侧保存） |
| **服务器→客户端方向的飞行状态** | 服务器已发出未确认的 QoS1/2 PUBLISH 与 PUBREL |
| **离线排队消息** | 客户端离线期间匹配其订阅的 QoS1/2 消息（QoS0 是否排队由实现决定） |
| **QoS2 接收记录** | 已收到、等待 PUBREL 的 Packet ID |

**不属于会话**：保留消息（属于主题）、遗嘱（属于连接，但 5.0 的 Will Delay 与会话过期交互）。

### 生命周期

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="会话生命周期：客户端用 Clean Session 为 1 连接则创建全新会话，断开即销毁；用 Clean Session 为 0 连接则恢复旧会话或创建新会话，连接断开后会话继续保留并为订阅排队消息，直到客户端重连恢复或会话过期被清除；5.0 用 Clean Start 与会话过期间隔精确控制；客户端 ID 相同的新连接会接管旧连接">
<rect class="b3" x="20" y="30" width="170" height="110" rx="10"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">Clean Session = 1</text>
<text class="ts" x="105" y="76" text-anchor="middle">连接：丢弃旧会话，新建</text>
<text class="ts" x="105" y="96" text-anchor="middle">断开：会话立即销毁</text>
<text class="ts" x="105" y="116" text-anchor="middle">无离线消息，重连需重订阅</text>
<rect class="b5" x="210" y="30" width="250" height="110" rx="10"/>
<text class="tb" x="335" y="50" text-anchor="middle" dominant-baseline="middle">Clean Session = 0（持久会话）</text>
<text class="ts" x="335" y="76" text-anchor="middle">连接：有旧会话则恢复，否则新建</text>
<text class="ts" x="335" y="96" text-anchor="middle">断开：会话保留，持续排队</text>
<text class="ts" x="335" y="116" text-anchor="middle">重连：补投离线消息与未确认报文</text>
<rect class="b1" x="480" y="30" width="260" height="110" rx="10"/>
<text class="tb" x="610" y="50" text-anchor="middle" dominant-baseline="middle">5.0：Clean Start + Session Expiry</text>
<text class="ts" x="610" y="76" text-anchor="middle">Clean Start：连接时是否丢弃旧会话</text>
<text class="ts" x="610" y="96" text-anchor="middle">Session Expiry：断开后保留多久</text>
<text class="ts" x="610" y="116" text-anchor="middle">0=断开即清；0xFFFFFFFF=不过期</text>
<rect class="bg" x="20" y="160" width="720" height="160" rx="8"/>
<text class="th" x="32" y="180">要点</text>
<text class="ts" x="380" y="206" text-anchor="middle">持久会话占订阅表、离线队列、in-flight 状态；海量设备要设会话过期、队列上限与消息 TTL，防僵尸会话耗尽资源</text>
<text class="ts" x="380" y="228" text-anchor="middle">3.1.1 没有会话过期机制（由 Broker 实现定义）；5.0 用 Session Expiry Interval 解决，推荐迁移</text>
<text class="ts" x="380" y="250" text-anchor="middle">客户端 ID 接管：同一 ID 的新连接到来，Broker 必须断开旧连接，再按 Clean 标志处理会话</text>
<text class="ts" x="380" y="272" text-anchor="middle">随机 ClientID + 持久会话：每次重连都是新会话，旧会话永不恢复却占资源（泄漏），须用稳定设备 ID</text>
<text class="ts" x="380" y="294" text-anchor="middle">Session Present：重连时 Broker 告知是否恢复了旧会话；若为 0，客户端要重新订阅，已发送未确认的消息按需重发</text>
<text class="ta" x="380" y="312" text-anchor="middle">离线消息只针对“持久会话 + QoS≥1 的订阅”；QoS0 消息、保留消息的投递不依赖会话</text>
</svg>
<figcaption>图 3：会话的类型与生命周期</figcaption>
</figure>

### 离线消息队列

Broker 对持久会话离线期间到达的、**订阅 QoS ≥1** 的消息进行排队（QoS0 通常不排队，可配置）。需要治理：

| 项 | 说明与建议 |
| --- | --- |
| **队列长度上限** | 防止长期离线设备把磁盘撑爆；超限策略：丢弃最旧/最新/拒绝（EMQX 等可配置 `max_mqueue_len` 之类，名称以产品为准） |
| **消息 TTL** | 5.0 的 Message Expiry Interval：过期消息不再投递（指令类消息必须设置，否则设备半年后上线会执行“过时”的指令） |
| **队列持久化** | 默认可能只在内存；Broker 重启丢失；需要**持久化存储**（消息持久化/外部数据库）的场景要评估成本 |
| **重连补投风暴** | 大量设备同时上线，Broker 同时补投离线消息，造成冲击；窗口 + 速率限制，见 [Broker 架构与集群（EMQX）](#/iot/broker) |
| **离线指令设计** | 控制类指令不要依赖 MQTT 离线队列，用**设备影子**（期望状态）更稳，见 [IoT 平台架构与设备管理](#/iot/platform) |
| **是否需要排队** | 遥测/上行不需要订阅端会话排队；**下行指令**才涉及设备端会话 |

### 订阅恢复与重新订阅

- 持久会话重连且 **Session Present=1**：订阅已恢复，**不要再订阅**（重复订阅无害但浪费，且会让保留消息被重新投递）；
- **Session Present=0** 或 Clean Session=1：**必须重新订阅**；
- Paho 的 `setAutomaticReconnect` 重连后**不会自动重新订阅**（取决于会话状态），需要在 `connectComplete(reconnect=true)` 回调里按 Session Present 处理，见 [Java 接入：Paho、Spring 与 Netty](#/iot/java)。

## 遗嘱消息（LWT）的触发条件

| 情形 | 是否发布遗嘱 |
| --- | --- |
| 客户端发送 DISCONNECT 后断开 | **否**（正常断开丢弃遗嘱；5.0 可用 reason code 0x04 要求“带遗嘱断开”） |
| 网络错误/连接意外关闭 | **是** |
| 保活超时（1.5×Keep Alive 未收到任何报文） | **是** |
| 协议错误（畸形报文、重复 CONNECT 等）导致服务器断开 | **是** |
| 被相同 ClientID 接管 | 视版本/实现：旧连接被关闭，遗嘱是否发布以所用 Broker 与版本规则为准（需实测） |
| 服务器自身故障/重启 | 遗嘱不一定发布（取决于实现与持久化） |

使用要点：

- 遗嘱在 CONNECT 时设置，**包含主题、消息、QoS、Retain**；常见用法是**遗嘱发布到 `status` 主题且 Retain=1，内容为 `offline`**，连接成功后设备自己再发布 `online`（Retain），实现**在线状态**；
- **遗嘱触发有延迟**：网络静默断开（拔电、信号丢失）时，Broker 要等 **1.5×Keep Alive** 才知道，在线状态更新有最大延迟 —— 保活越短，检测越快，但心跳开销越大；
- 5.0 的 **Will Delay Interval**：延迟发布遗嘱，**期间客户端重连则取消**，避免短暂网络抖动导致“离线→上线”抖动告警；
- 遗嘱消息**只是一条普通消息**，要幂等地处理（尤其是离线告警与恢复的去抖）；
- 在线状态的完整设计（遗嘱 + 心跳 + Broker 事件）见 [MQTT 协议详解](#/iot/mqtt) 与 [IoT 平台架构与设备管理](#/iot/platform)。

## 保留消息（Retained）

| 规则 | 说明 |
| --- | --- |
| **每个主题最多一条** | 新的保留消息覆盖旧的；保留的是**最后一条带 RETAIN=1 的消息**（含 QoS） |
| **清除** | 发布**零长度载荷 + RETAIN=1** 的消息，清除该主题的保留消息 |
| **投递时机** | 新订阅**建立时**，Broker 把匹配该过滤器的所有保留消息发给订阅者（RETAIN=1） |
| **实时转发时的 RETAIN 位** | 3.1.1：Broker 转发给**已存在订阅**的订阅者时，RETAIN 位为 0；5.0 可用订阅选项 **Retain As Published** 保持原值，用 **Retain Handling** 控制订阅时是否发送保留消息 |
| **QoS** | 保留消息的投递 QoS 同样取 min(保留消息 QoS, 订阅 QoS) |
| **存储与成本** | 保留消息占 Broker 存储；每个主题一份，海量设备 × 状态主题要规划；要有 TTL（5.0 Message Expiry）或清理策略 |
| **通配订阅与保留消息** | `#` 订阅会一次性拿到大量保留消息（冲击）；设备不要用宽泛通配订阅 |
| **适合** | 设备**最新状态**、配置、在线状态；**不适合**事件流（会被覆盖） |

## 主题匹配与共享订阅

### 主题树匹配

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Broker 的主题匹配：订阅过滤器按层级存入前缀树（Trie），节点保存订阅者列表；发布时沿主题层级向下遍历，同时考虑精确匹配、加号单层匹配和井号多层匹配三种分支，收集所有匹配节点的订阅者；复杂度与主题层数及通配符分支相关，与订阅总数关系较小；精确订阅可用哈希表直接命中加速；共享订阅在匹配后按组选择一个成员">
<rect class="b3" x="20" y="14" width="340" height="190" rx="10"/>
<text class="th" x="32" y="34">订阅过滤器 → 前缀树（Trie）</text>
<rect class="b5" x="150" y="48" width="60" height="26" rx="6"/>
<text class="ts" x="180" y="61" text-anchor="middle" dominant-baseline="middle">根</text>
<rect class="b1" x="40" y="96" width="70" height="26" rx="6"/>
<text class="ts" x="75" y="109" text-anchor="middle" dominant-baseline="middle">dev</text>
<rect class="b1" x="150" y="96" width="60" height="26" rx="6"/>
<text class="ts" x="180" y="109" text-anchor="middle" dominant-baseline="middle">+</text>
<rect class="b1" x="250" y="96" width="70" height="26" rx="6"/>
<text class="ts" x="285" y="109" text-anchor="middle" dominant-baseline="middle">$share</text>
<rect class="b2" x="20" y="146" width="70" height="26" rx="6"/>
<text class="ts" x="55" y="159" text-anchor="middle" dominant-baseline="middle">d1 ✓</text>
<rect class="b2" x="100" y="146" width="60" height="26" rx="6"/>
<text class="ts" x="130" y="159" text-anchor="middle" dominant-baseline="middle">+ ✓</text>
<rect class="b2" x="170" y="146" width="60" height="26" rx="6"/>
<text class="ts" x="200" y="159" text-anchor="middle" dominant-baseline="middle">up ✓</text>
<text class="ts" x="285" y="159" text-anchor="middle">组→成员</text>
<line class="ld" x1="180" y1="74" x2="75" y2="96"/>
<line class="ld" x1="180" y1="74" x2="180" y2="96"/>
<line class="ld" x1="180" y1="74" x2="285" y2="96"/>
<line class="ld" x1="75" y1="122" x2="55" y2="146"/>
<line class="ld" x1="75" y1="122" x2="130" y2="146"/>
<line class="ld" x1="180" y1="122" x2="200" y2="146"/>
<text class="ts" x="190" y="192" text-anchor="middle">✓ = 该节点挂有订阅者列表</text>
<rect class="bg" x="380" y="14" width="360" height="190" rx="10"/>
<text class="th" x="392" y="34">匹配一条 PUBLISH 的过程</text>
<text class="ts" x="560" y="62" text-anchor="middle">发布主题 dev/d1/up 逐层向下：</text>
<text class="ts" x="560" y="84" text-anchor="middle">每层同时尝试 精确层名、'+'、'#' 三种分支</text>
<text class="ts" x="560" y="106" text-anchor="middle">命中节点的订阅者全部收集（去重）</text>
<text class="ts" x="560" y="134" text-anchor="middle">'#' 节点在任意深度都匹配（含父层）</text>
<text class="ts" x="560" y="156" text-anchor="middle">'$' 开头的主题跳过首层通配</text>
<text class="ts" x="560" y="184" text-anchor="middle">然后按订阅者的授予 QoS 取 min 投递</text>
<rect class="bg" x="20" y="220" width="720" height="100" rx="8"/>
<text class="th" x="32" y="240">性能与实现要点</text>
<text class="ts" x="380" y="264" text-anchor="middle">匹配代价取决于主题层数与通配分支，几乎与订阅总数无关；百万订阅也可毫秒级匹配（EMQX 等采用优化的 Trie/路由表）</text>
<text class="ts" x="380" y="286" text-anchor="middle">纯精确订阅（无通配）占绝大多数时，用哈希表直接命中，通配订阅另存 Trie，是常见的混合优化</text>
<text class="ts" x="380" y="308" text-anchor="middle">宽泛通配订阅（如 #）会让每条消息扇出到大量会话，是吞吐杀手；ACL 应禁止设备订阅宽泛通配</text>
</svg>
<figcaption>图 4：订阅表（Trie）与发布匹配</figcaption>
</figure>

### 共享订阅

普通订阅是**广播**：每个订阅者都收到一份。**共享订阅**让一组订阅者**分摊**同一主题消息（一条消息只投给组内一个成员）：

```text
订阅过滤器：$share/<组名>/<主题过滤器>
例：$share/backend/dev/+/up      ← 一组后端消费者，共同处理所有设备的上行
```

| 要点 | 说明 |
| --- | --- |
| **用途** | 服务端消费集群**水平扩展**（避免每个后端实例都收到全量数据）；类似 Kafka 消费者组，但是**推模式** |
| **标准化** | MQTT 5.0 正式纳入 `$share`；3.1.1 下许多 Broker 以**扩展**支持（如 EMQX 的 `$queue` 与 `$share`） |
| **分发策略** | 随机、轮询、按客户端 ID 哈希、按发布者 ID 哈希（保序）、本地优先、粘性等，**Broker 可配置**；需要“同一设备消息总到同一消费者”（保序）时选**哈希类**策略 |
| **QoS 与确认** | 投递给组内成员后，若该成员未确认且断线，Broker 可**把消息改投组内其他成员**（实现相关，QoS1/2 下行为需验证）；这使得共享订阅更接近“竞争消费” |
| **离线与会话** | 共享订阅的成员仍有各自会话；成员离线后消息的归属取决于实现 |
| **背压** | 消费者处理慢，窗口满，Broker 会向组内其他成员投递；整体仍受消费能力约束 |
| **与规则引擎/桥接的关系** | 数据入库、转发 Kafka 通常用 Broker 的规则引擎/数据桥，而非自建共享订阅消费者，见 [Broker 架构与集群（EMQX）](#/iot/broker) |

### 投递 QoS 的降级与消息重复

- **实际 QoS = min(发布 QoS, 订阅授予 QoS)**：发布者用 QoS2、订阅者订阅 QoS0，则订阅者只能 QoS0 收到；
- **同一条消息匹配同一订阅者的多个订阅**：3.1.1 下订阅者可能**收到多份**（每个匹配订阅一份，或按最大 QoS 合并为一份，规范允许实现选择）；5.0 加了**订阅标识符**以区分；设计主题与订阅时避免“一条消息被同一客户端的多个过滤器重复命中”；
- **No Local**（5.0）：订阅者不接收自己发布的消息，解决“自己发布又被自己订阅收到”的回环问题；3.1.1 需要业务过滤（消息里带发送者 ID）。

## 实现者视角的检查清单

| 主题 | 检查 |
| --- | --- |
| **QoS 状态持久化** | 发送方保存 PUBLISH/PUBREL 状态、接收方保存 QoS2 的 Packet ID；进程崩溃重启后能恢复并继续重传（需要持久化存储） |
| **重传时机** | 仅在重连后；顺序与原发送一致；DUP=1 |
| **飞行窗口** | 有上限与背压；窗口满时排队而不是无限堆积内存 |
| **离线队列** | 长度、TTL、持久化、满了的策略 |
| **会话回收** | 过期清理，避免僵尸会话泄漏 |
| **客户端 ID 接管** | 旧连接的关闭与状态迁移（飞行状态、离线消息）要正确；防踢出循环（限制重连频率） |
| **遗嘱** | 触发条件完整；延迟发布与取消；与会话过期的交互 |
| **保留消息** | 覆盖、清除、订阅时投递、存储与淘汰 |
| **订阅与 ACL** | 授权失败返回 0x80；订阅数上限；通配符限制 |
| **共享订阅分发** | 策略可配置，消费者故障时重投 |

## 相关阅读

- [MQTT 报文详解：从字节看协议](#/iot/mqtt-wire)：Packet ID 与报文字节结构
- [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5)：会话过期、共享订阅、订阅选项
- [弱网、可靠性、安全与排障](#/iot/mqtt-practice)：应用层确认与幂等
- [Broker 架构与集群（EMQX）](#/iot/broker)：慢消费者、集群路由与容量
- [IoT 平台架构与设备管理](#/iot/platform)：在线状态与指令设计
- [消息队列核心问题](#/mw/mq)：至少一次与幂等的通用方案

## 面试追问

> [!QUESTION] MQTT 的 QoS 是端到端的吗？
> 不是，是逐跳的：发布者到 Broker 是一段，Broker 到订阅者是另一段，实际投递 QoS 取发布 QoS 与订阅授予 QoS 的较小值。要保证业务端到端送达，需要应用层确认（如指令应答）加幂等。

> [!QUESTION] QoS2 为什么需要四步握手？
> 只靠一次 PUBREC 确认，发送方无法区分接收方已收到并交付，还是确认丢了。PUBREL 是发送方对已收到的确认，接收方在收到 PUBREL 之前一直记着 Packet ID，期间重复的 PUBLISH 只回 PUBREC 不再交付，收到 PUBREL 后才删除记录并回 PUBCOMP，由此在协议内实现恰好一次，代价是多两个往返和两侧状态存储。

> [!QUESTION] MQTT 的重传是怎么规定的？
> TCP 已保证连接内可靠有序，所以同一连接内 MQTT 不应超时重传。只有在重连且会话保留时，客户端和服务端才必须按原顺序、原 Packet ID、DUP=1 重发未确认的 PUBLISH，以及原 ID 的 PUBREL。接收方可能收到重复，所以 QoS1 要应用层幂等。

> [!QUESTION] 持久会话里保存了什么？有什么运维风险？
> 订阅集合、双向未确认的 QoS1/2 状态、离线期间排队的消息和 QoS2 接收记录。风险是占用 Broker 内存和磁盘，随机客户端 ID 加持久会话会不断创建永远不被恢复的僵尸会话，长期离线设备的队列无限增长，重连时还会引发补投风暴。要用稳定设备 ID、会话过期、队列上限与消息 TTL 治理。

> [!QUESTION] 遗嘱消息什么时候会发布？
> 客户端没有发送 DISCONNECT 就断开时发布，包括网络错误、保活超时（1.5 倍 Keep Alive 无报文）和协议错误；正常 DISCONNECT 会丢弃遗嘱。静默断网要等保活超时才触发，所以在线状态有最大延迟；5.0 的 Will Delay 可以在短暂抖动时避免误报。

> [!QUESTION] 共享订阅解决什么问题？
> 让一组订阅者分摊同一主题的消息，每条消息只投给组内一个成员，用于后端消费者集群水平扩展，类似消费者组的推模式。可配置随机、轮询、按客户端或发布者哈希等策略，需要保序时用哈希类，MQTT 5.0 将其标准化。
