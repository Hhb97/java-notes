---
level: 深入
tags: [Pulsar, BookKeeper, 存算分离, 多租户, 订阅模式, Key_Shared, 分层存储, 跨地域复制, Kafka 对比]
summary: Apache Pulsar 的架构与取舍：无状态 Broker + BookKeeper 的存算分离、Ledger 与分区、四种订阅模式（Exclusive/Failover/Shared/Key_Shared）、多租户与命名空间策略、分层存储、跨地域复制、延迟/死信/事务等消息特性、与 Kafka/RocketMQ 的对比与落地要点。
---

# Pulsar 架构与存算分离

> [!ABSTRACT] 核心要点
> - Pulsar 的核心特点是**存算分离**：**Broker 无状态**，只负责收发与路由；消息持久化在 **Apache BookKeeper** 的 Bookie 节点。扩缩容 Broker 不需要搬数据，Topic 在 Broker 间**秒级迁移**；存储层可以独立扩容。
> - 数据按 **Ledger（分段）** 写入多个 Bookie，**写入 Quorum 过半确认**；因此一个分区的数据**分散在多台存储节点**，不像 Kafka 把分区绑定在固定 Broker 上，扩容后新节点立刻能分担新写入。
> - **订阅（Subscription）模式**把“队列语义”和“流语义”统一：**Exclusive/Failover** 偏流式有序消费，**Shared** 偏队列式竞争消费（无序、可超过分区数扩展消费者），**Key_Shared** 按 key 保序的同时允许多消费者并行。
> - **多租户**是一等公民：**租户（Tenant）→ 命名空间（Namespace）→ Topic** 的层级，配额、权限、保留与限流策略都挂在命名空间上，适合平台化。
> - 额外能力：**分层存储**（冷数据卸载到对象存储）、**跨地域复制**、**延迟消息、死信与重试 Topic、事务**。
> - 代价是**组件多（Broker + Bookie + 元数据存储）、运维复杂度高、社区与生态规模不及 Kafka**。是否选择它取决于**是否真的需要它的特性**。

## 架构

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="Pulsar 架构：客户端连接无状态 Broker，Broker 将消息写入 BookKeeper 的多个 Bookie 节点，写入使用 Ledger 和 Quorum；元数据存放在 ZooKeeper 或 etcd 等元数据存储；冷数据可卸载到对象存储；Pulsar Proxy 可作为网关">
<rect class="b3" x="20" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">生产者</text>
<text class="ts" x="85" y="72" text-anchor="middle">客户端</text>
<rect class="b3" x="20" y="110" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="132" text-anchor="middle" dominant-baseline="middle">消费者</text>
<text class="ts" x="85" y="152" text-anchor="middle">订阅 Subscription</text>
<rect class="b5" x="190" y="60" width="130" height="80" rx="8"/>
<text class="tb" x="255" y="80" text-anchor="middle" dominant-baseline="middle">Proxy（可选）</text>
<text class="ts" x="255" y="104" text-anchor="middle">统一入口·TLS</text>
<text class="ts" x="255" y="122" text-anchor="middle">网络隔离场景</text>
<rect class="bg" x="360" y="14" width="200" height="190" rx="10"/>
<text class="th" x="460" y="34" text-anchor="middle">Broker 层（无状态）</text>
<rect class="b1" x="376" y="48" width="168" height="34" rx="6"/>
<text class="ts" x="460" y="65" text-anchor="middle" dominant-baseline="middle">Broker 1：Topic A/B 分区</text>
<rect class="b1" x="376" y="90" width="168" height="34" rx="6"/>
<text class="ts" x="460" y="107" text-anchor="middle" dominant-baseline="middle">Broker 2：Topic C 分区</text>
<rect class="b1" x="376" y="132" width="168" height="34" rx="6"/>
<text class="ts" x="460" y="149" text-anchor="middle" dominant-baseline="middle">Broker 3：Topic D 分区</text>
<text class="ts" x="460" y="188" text-anchor="middle">缓存·路由·负载均衡</text>
<rect class="bg" x="590" y="14" width="150" height="190" rx="10"/>
<text class="th" x="665" y="34" text-anchor="middle">BookKeeper 层</text>
<rect class="b2" x="604" y="48" width="122" height="34" rx="6"/>
<text class="ts" x="665" y="65" text-anchor="middle" dominant-baseline="middle">Bookie 1</text>
<rect class="b2" x="604" y="90" width="122" height="34" rx="6"/>
<text class="ts" x="665" y="107" text-anchor="middle" dominant-baseline="middle">Bookie 2</text>
<rect class="b2" x="604" y="132" width="122" height="34" rx="6"/>
<text class="ts" x="665" y="149" text-anchor="middle" dominant-baseline="middle">Bookie 3 …</text>
<text class="ts" x="665" y="188" text-anchor="middle">持久化·副本·日志</text>
<line class="l" x1="150" y1="58" x2="190" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="150" y1="138" x2="190" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="100" x2="360" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="100" x2="590" y2="100" marker-end="url(#arr)"/>
<rect class="b4" x="360" y="224" width="200" height="46" rx="8"/>
<text class="tb" x="460" y="244" text-anchor="middle" dominant-baseline="middle">元数据存储</text>
<text class="ts" x="460" y="262" text-anchor="middle">ZooKeeper / etcd 等</text>
<rect class="b5" x="590" y="224" width="150" height="46" rx="8"/>
<text class="tb" x="665" y="244" text-anchor="middle" dominant-baseline="middle">对象存储</text>
<text class="ts" x="665" y="262" text-anchor="middle">冷数据分层卸载</text>
<line class="ld" x1="460" y1="204" x2="460" y2="224"/>
<line class="ld" x1="665" y1="204" x2="665" y2="224"/>
<rect class="bg" x="20" y="288" width="720" height="40" rx="8"/>
<text class="ts" x="380" y="312" text-anchor="middle">Broker 宕机：Topic 所有权转移到其他 Broker，数据在 Bookie 上不动；Bookie 宕机：Ledger 副本自动补齐（Auto Recovery）</text>
</svg>
<figcaption>图 1：Pulsar 的存算分离架构</figcaption>
</figure>

### 组件职责

| 组件 | 职责 |
| --- | --- |
| **Broker** | 无状态服务层：处理生产与消费请求、维护订阅与游标、缓存热点数据、做 Topic 到 Broker 的负载均衡；Topic 的“所有权”可动态迁移 |
| **BookKeeper（Bookie）** | 分布式追加日志存储：把写入拆成 Ledger，按配置的副本数写多个 Bookie；日志盘（Journal）顺序写保证低延迟，数据盘（Ledger 盘）用于读取；磁盘 IO 是性能关键 |
| **元数据存储** | 保存集群、租户、命名空间、Topic、Ledger 元数据；传统用 ZooKeeper，新版本支持 etcd 等可插拔实现；**元数据存储是关键依赖**，需要高可用与监控 |
| **Proxy** | 可选的网关，用于客户端不能直连 Broker 的网络环境（如 K8s 外部访问），统一鉴权与 TLS |
| **Functions / IO** | 轻量流处理与连接器框架（Source/Sink），类似 Kafka Streams/Connect 的角色，生态规模较小 |

### 存储模型：Ledger 与分段

- 一个 Topic（或分区）的消息写入**当前 Ledger**，Ledger 达到大小/时间阈值后关闭并创建新的，Topic 实质是**一串 Ledger 的有序序列**；
- 每个 Ledger 的写入遵循 **(E, Qw, Qa)** 三个参数：**Ensemble Size（E）**可选的 Bookie 数、**Write Quorum（Qw）**每条消息写几份、**Ack Quorum（Qa）**几份确认才算成功；例如 E=3、Qw=3、Qa=2 表示写 3 个副本、2 个确认即返回；
- 因为不同 Ledger 可以选择不同的 Bookie 组合，**分区的数据均匀散落在整个存储集群**，新增 Bookie 马上能接收新 Ledger，**无需像 Kafka 那样做分区数据迁移**；
- Broker 宕机后，新的 Broker 接管 Topic，**对旧 Ledger 做恢复（fencing）并开启新 Ledger**，不需要复制数据，故障切换快。

## 订阅模式

Pulsar 用**订阅**来表达消费语义：一个 Topic 可以有多个订阅，**每个订阅独立保存消费进度（游标）**，彼此互不影响（类似 Kafka 的消费者组）；同一订阅内的消费者按模式分配消息。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Pulsar 四种订阅模式：Exclusive 只允许一个消费者，Failover 主备消费者，Shared 多个消费者轮询竞争无序，Key_Shared 按 key 哈希保序分配给多个消费者">
<rect class="b3" x="20" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">Exclusive / Failover（流式，分区内有序）</text>
<rect class="b" x="40" y="52" width="100" height="40" rx="6"/>
<text class="ts" x="90" y="72" text-anchor="middle" dominant-baseline="middle">分区 P0</text>
<rect class="b2" x="240" y="48" width="110" height="26" rx="6"/>
<text class="ts" x="295" y="61" text-anchor="middle" dominant-baseline="middle">消费者 A（活跃）</text>
<rect class="b" x="240" y="82" width="110" height="26" rx="6"/>
<text class="ts" x="295" y="95" text-anchor="middle" dominant-baseline="middle">消费者 B（备用）</text>
<line class="l" x1="140" y1="72" x2="240" y2="61" marker-end="url(#arr)"/>
<line class="ld" x1="140" y1="72" x2="240" y2="95"/>
<text class="ts" x="195" y="132" text-anchor="middle">Exclusive：仅一个消费者；Failover：活跃宕机由备用接管</text>
<rect class="b5" x="390" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">Shared（队列式，无序，可超分区数扩展）</text>
<rect class="b" x="410" y="52" width="100" height="40" rx="6"/>
<text class="ts" x="460" y="72" text-anchor="middle" dominant-baseline="middle">Topic 消息</text>
<rect class="b2" x="610" y="44" width="110" height="24" rx="6"/>
<text class="ts" x="665" y="56" text-anchor="middle" dominant-baseline="middle">消费者 1</text>
<rect class="b2" x="610" y="72" width="110" height="24" rx="6"/>
<text class="ts" x="665" y="84" text-anchor="middle" dominant-baseline="middle">消费者 2</text>
<rect class="b2" x="610" y="100" width="110" height="24" rx="6"/>
<text class="ts" x="665" y="112" text-anchor="middle" dominant-baseline="middle">消费者 3</text>
<line class="l" x1="510" y1="72" x2="610" y2="56" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="72" x2="610" y2="84" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="72" x2="610" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="565" y="140" text-anchor="middle">轮询分发 + 单条 ack，支持重投与死信</text>
<rect class="b1" x="20" y="174" width="720" height="150" rx="10"/>
<text class="tb" x="380" y="194" text-anchor="middle" dominant-baseline="middle">Key_Shared（按 key 保序 + 多消费者并行）</text>
<rect class="b" x="40" y="212" width="130" height="40" rx="6"/>
<text class="ts" x="105" y="232" text-anchor="middle" dominant-baseline="middle">消息（带 key）</text>
<rect class="b4" x="230" y="206" width="150" height="24" rx="6"/>
<text class="ts" x="305" y="218" text-anchor="middle" dominant-baseline="middle">哈希环 / 区间分配</text>
<rect class="b2" x="450" y="204" width="130" height="24" rx="6"/>
<text class="ts" x="515" y="216" text-anchor="middle" dominant-baseline="middle">消费者 1：key a,d…</text>
<rect class="b2" x="450" y="234" width="130" height="24" rx="6"/>
<text class="ts" x="515" y="246" text-anchor="middle" dominant-baseline="middle">消费者 2：key b,e…</text>
<line class="l" x1="170" y1="232" x2="230" y2="222" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="218" x2="450" y2="216" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="224" x2="450" y2="246" marker-end="url(#arr)"/>
<text class="ts" x="380" y="288" text-anchor="middle">同一 key 始终由同一消费者处理（保序），消费者增减时 key 范围重新分配</text>
<text class="ts" x="380" y="308" text-anchor="middle">兼顾“按 key 有序”和“消费者数量不受分区数限制”，是它相对 Kafka 的亮点之一</text>
</svg>
<figcaption>图 2：四种订阅模式</figcaption>
</figure>

| 模式 | 并行度 | 顺序 | 确认方式 | 典型场景 |
| --- | --- | --- | --- | --- |
| **Exclusive** | 1（每订阅仅一个消费者） | 分区内有序 | 累积 ack 或单条 | 严格顺序的流式处理 |
| **Failover** | 活跃 1 + 备用 | 分区内有序 | 同上 | 需要高可用的顺序消费 |
| **Shared** | 任意多个消费者 | **无序** | **单条 ack**，可重投 | 任务分发、工作队列 |
| **Key_Shared** | 任意多个消费者 | **同 key 有序** | 单条 ack | 按用户/订单有序又要高并行 |

**注意**：Key_Shared 在消费者上下线时会出现 key 范围重新分配，期间要避免乱序（有“按序投递”的相关配置与权衡，细节随版本变化，需查阅官方文档）；单条 ack 在大量乱序确认时会产生“确认空洞”，需要关注游标的状态存储开销。

### 消费可靠性与特性

| 特性 | 说明 |
| --- | --- |
| **Ack 与重投** | 未 ack 的消息超时（ackTimeout）或被 negative ack 后重新投递；Shared 模式适合 |
| **重试 Topic / 死信 Topic** | 失败消息自动进入重试 Topic 延迟重试，超过次数进入死信 Topic（可按订阅配置） |
| **延迟消息** | 生产时指定延迟时间，仅对 Shared 等订阅有效；适合中小规模延迟需求 |
| **消息保留与 TTL** | **保留策略**：已 ack 的消息仍保留一段时间（可回溯）；**TTL**：未 ack 的消息过期丢弃；**积压配额**：限制未消费消息大小 |
| **Reader / Seek** | 按消息 ID 或时间回溯，类似 Kafka 重置位点 |
| **压缩 Topic（Compaction）** | 按 key 保留最新值 |
| **事务** | 支持跨 Topic 的生产与消费确认的原子性（读-处理-写），能力与成熟度随版本演进 |
| **Schema 管理** | 内置 Schema Registry，支持兼容性策略 |

## 多租户与命名空间

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="Pulsar 多租户层级：集群包含多个租户，租户包含命名空间，命名空间包含 Topic；权限、保留、TTL、限流、副本策略、跨地域复制策略都在命名空间级别配置">
<rect class="b3" x="20" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">集群 Cluster</text>
<text class="ts" x="85" y="72" text-anchor="middle">物理资源</text>
<rect class="b5" x="190" y="30" width="150" height="60" rx="8"/>
<text class="tb" x="265" y="52" text-anchor="middle" dominant-baseline="middle">租户 Tenant</text>
<text class="ts" x="265" y="72" text-anchor="middle">团队/业务线·管理员</text>
<rect class="b1" x="380" y="30" width="170" height="60" rx="8"/>
<text class="tb" x="465" y="52" text-anchor="middle" dominant-baseline="middle">命名空间 Namespace</text>
<text class="ts" x="465" y="72" text-anchor="middle">策略的载体</text>
<rect class="b2" x="590" y="30" width="150" height="60" rx="8"/>
<text class="tb" x="665" y="52" text-anchor="middle" dominant-baseline="middle">Topic</text>
<text class="ts" x="665" y="72" text-anchor="middle">persistent://t/ns/名</text>
<line class="l" x1="150" y1="60" x2="190" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="60" x2="380" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="60" x2="590" y2="60" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="118" width="720" height="108" rx="8"/>
<text class="th" x="32" y="138">命名空间级策略（一次配置，整个命名空间下的 Topic 生效）</text>
<text class="ts" x="380" y="164" text-anchor="middle">访问控制：谁能生产/消费/管理 · 消息保留时长与大小 · TTL · 积压配额与达到配额后的处理（拒绝/丢最旧）</text>
<text class="ts" x="380" y="186" text-anchor="middle">限流：生产/分发速率 · 副本参数（E/Qw/Qa）· 自动创建 Topic 的策略 · 分层存储卸载阈值</text>
<text class="ts" x="380" y="208" text-anchor="middle">跨地域复制的集群集合 · Schema 兼容性策略 · 反亲和与隔离（将命名空间绑定到特定 Broker/Bookie 组）</text>
</svg>
<figcaption>图 3：租户-命名空间-Topic 层级与策略归属</figcaption>
</figure>

多租户的意义：**一套集群安全地被多个团队共享**，策略以命名空间为单位统一管理，可通过**资源隔离策略**把重要业务绑定到专属的 Broker/Bookie 组，避免“邻居噪声”。平台化管理思路见 [消息队列平台化与治理](#/mw/mq-governance)。

## 分层存储与跨地域复制

### 分层存储（Tiered Storage）

- 将**较旧的 Ledger 卸载到对象存储**（如 S3 兼容存储），Bookie 只保留热数据，**降低存储成本、支持长期保留**；
- 消费者读取历史数据时，Broker 透明地从对象存储读取（延迟较高）；
- 触发条件按命名空间配置（达到大小阈值或保留时间），要关注卸载速度、读取延迟与对象存储成本；
- 适合：审计、回放、数据湖入口等“保留很久但很少读”的场景。

### 跨地域复制（Geo-Replication）

- 命名空间配置复制集群集合，消息**异步复制**到其他集群，**无需额外搭建独立的同步工具**；
- 模式：主备（灾备）、多活（各地区写入互相复制）；多活要解决**重复与冲突**、**订阅位点不同步**（各集群的订阅独立）等问题；
- 复制是异步的，故障切换存在 **RPO > 0**，需要演练；
- 与 Kafka 的 MirrorMaker 相比，复制是内建能力，配置更简单，但仍要关注网络带宽、延迟和成本。

## 与 Kafka、RocketMQ 对比

| 维度 | Pulsar | Kafka | RocketMQ |
| --- | --- | --- | --- |
| 架构 | **存算分离**（Broker + BookKeeper） | 存算一体（分区绑定 Broker），较新版本引入分层存储 | 存算一体（5.x 引入存算分离方向） |
| 扩容 | Broker 秒级、Bookie 加入即承接新数据，**无需搬迁历史数据** | 增加 Broker 后需**分区重分配（搬数据）** | 类似 Kafka，需迁移队列 |
| 消费模型 | 订阅（独占/故障转移/共享/Key 共享），队列与流统一 | 消费者组，并行度 ≤ 分区数 | 集群/广播消费，队列分配 |
| 多租户 | **原生**租户/命名空间/配额 | 需平台层封装（ACL、配额） | 有命名空间概念，较弱 |
| 单条 ack / 重投 | 原生支持，Shared 模式 | 位点提交，无单条重投 | 支持重试队列/死信 |
| 延迟消息 | 支持（偏中小规模） | 原生不支持 | 原生支持定时/延迟 |
| 事务消息 | 支持事务（能力随版本） | 事务（读-处理-写） | **事务消息（半消息）成熟** |
| 跨地域复制 | 内建 | MirrorMaker / 集群链接 | 需额外方案 |
| 生态与社区 | 中等，流处理/连接器生态较小 | **最大**，工具与人才最丰富 | 国内较强（金融、电商） |
| 运维复杂度 | **较高**（多组件，Bookie 磁盘与元数据调优） | 中等（KRaft 后简化） | 中等 |
| 吞吐与延迟 | 高吞吐低延迟，依赖 Bookie 磁盘（Journal 用独立 SSD 很关键） | 极高吞吐，批量顺序写 | 高，适合业务消息 |

性能数字强依赖硬件与配置，以上只做定性对比，具体选型必须用自己的负载压测。Kafka 与 RocketMQ 详见 [Kafka 架构与存储](#/mw/kafka)、[RocketMQ 原理与事务消息](#/mw/rocketmq)，整体对比见 [消息队列核心问题](#/mw/mq)。

## 落地与运维要点

| 方面 | 要点 |
| --- | --- |
| **磁盘规划** | Bookie 的 **Journal 盘（写前日志）与数据盘分开**，Journal 使用低延迟 SSD/NVMe；磁盘 IO 是写入延迟的第一决定因素 |
| **副本参数** | 常见 E=3/Qw=3/Qa=2（或 3/2/2），按数据重要性与延迟取舍；Qa 越大越安全但越慢 |
| **元数据存储** | 它是控制面关键依赖，要独立部署、监控延迟与会话，避免与重负载混部 |
| **Topic 数量** | 大量小 Topic 会增加元数据与内存开销；设计上控制数量，使用分区而不是海量 Topic |
| **积压与保留** | 设置积压配额和保留策略，否则慢订阅会让存储无限增长；监控 backlog |
| **Broker 负载均衡** | 开启自动负载均衡并观察 Bundle（Topic 分组）分布；热点 Bundle 会被拆分迁移 |
| **客户端** | 重用客户端与生产者对象；设置批量发送、压缩；Shared 订阅配置 ackTimeout 与重试策略；注意消费者接收队列大小（receiver queue）对内存的影响 |
| **监控** | Broker：吞吐、延迟、backlog、未确认消息数；Bookie：Journal 写延迟、磁盘使用、Ledger 数；元数据存储延迟；订阅与消费者状态 |
| **升级** | 按官方滚动升级顺序（通常元数据存储、Bookie、Broker 依次），先预发验证；注意客户端与服务端版本兼容 |
| **团队能力** | 评估是否有人懂 BookKeeper；没有的话优先考虑托管服务 |

### 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 生产延迟突然升高 | Bookie Journal 盘 IO 饱和或写入副本中有慢节点 | 检查磁盘延迟，Journal 独立 SSD，调整副本参数，隔离慢节点 |
| 某个订阅 backlog 持续增长 | 消费慢、消费者掉线、Shared 下单条 ack 空洞 | 扩消费者、修复故障、检查 ack 与重试策略 |
| 存储持续增长 | 保留策略与积压配额未设置，慢订阅阻碍清理 | 设置命名空间级保留/TTL/配额，清理无用订阅 |
| Topic 在 Broker 间频繁迁移 | 负载均衡阈值过敏感或 Bundle 热点 | 调整均衡策略，拆分 Bundle |
| 消费者内存暴涨 | receiver queue 过大、消息大 | 调小接收队列，限制批量大小 |
| 元数据存储不稳定导致集群抖动 | 元数据存储负载高/磁盘慢 | 独立部署与监控，控制 Topic 数量 |

## 什么时候选 Pulsar

| 适合 | 不一定适合 |
| --- | --- |
| 需要**多租户**平台，一套集群服务多个业务线，策略集中管理 | 团队小、场景单一，Kafka 或 RabbitMQ 足够 |
| **队列与流混合**需求：既要流式回放又要 Shared 竞争消费与单条重投 | 重度依赖 Kafka 生态（Connect 连接器、Streams、周边工具） |
| **频繁弹性扩缩容**，不希望为扩容搬数据（云原生/K8s） | 没有能力运维 BookKeeper 与元数据存储 |
| 需要**内建跨地域复制**与长期保留（分层存储） | 追求最大社区资源与招聘便利 |
| 大量小租户、多 Topic（有节制） | 超大规模极致吞吐的日志管道，Kafka 更成熟 |

## 相关阅读

- [消息队列核心问题](#/mw/mq)：丢失、重复、顺序、积压的通用方案与选型
- [Kafka 架构与存储](#/mw/kafka)：存算一体模型的对照
- [RocketMQ 原理与事务消息](#/mw/rocketmq)：另一种面向业务的消息队列
- [分布式协调：ZooKeeper 与 etcd](#/mw/coordination)：Pulsar 的元数据存储依赖
- [消息队列平台化与治理](#/mw/mq-governance)：多租户与 Topic 治理

## 面试追问

> [!QUESTION] Pulsar 的架构有什么特点？存算分离带来了什么？
> Broker 无状态，只做收发与路由，消息持久化在 BookKeeper 的 Bookie 上，元数据放在 ZooKeeper 或 etcd 等。好处是扩缩容 Broker 不搬数据，Topic 可秒级迁移，Bookie 加入后立即承接新 Ledger，存储与计算可独立扩展；代价是组件多、运维复杂。

> [!QUESTION] Pulsar 的数据是怎么存的？写入怎么保证可靠？
> Topic 的消息写入一串 Ledger，每个 Ledger 按 (E, Qw, Qa) 配置写多个 Bookie：Ensemble 是可选节点数，Write Quorum 是每条消息的副本数，Ack Quorum 是确认数。例如 3/3/2 表示写三份，两份确认即成功。不同 Ledger 可落在不同节点，因此数据分散在整个存储集群。

> [!QUESTION] Pulsar 的四种订阅模式是什么？和 Kafka 消费者组有什么区别？
> Exclusive 仅一个消费者，Failover 主备，二者分区内有序；Shared 多消费者轮询竞争、无序、单条 ack，可超过分区数扩展；Key_Shared 按 key 保序并允许多消费者并行。Kafka 消费者组并行度受分区数限制且按位点提交，没有单条 ack 重投，Pulsar 同时支持队列和流语义。

> [!QUESTION] Pulsar 的多租户是怎么实现的？
> 通过租户、命名空间、Topic 三级结构，权限、保留、TTL、积压配额、限流、副本参数、跨地域复制和 Schema 策略都在命名空间级别统一配置，还可通过隔离策略把命名空间绑定到特定 Broker 或 Bookie 组，避免邻居噪声，适合作为共享消息平台。

> [!QUESTION] Pulsar 和 Kafka 怎么选？
> 需要多租户平台、队列与流混合、频繁弹性扩缩容、内建跨地域复制与分层存储时可选 Pulsar；场景单一、依赖 Kafka 生态（Connect、Streams）、追求社区与人才资源、极致日志吞吐时选 Kafka。还要评估团队是否有能力运维 BookKeeper 与元数据存储。

> [!QUESTION] Pulsar 线上最常见的性能与稳定性问题有哪些？
> Bookie 的 Journal 盘 IO 饱和导致写延迟升高，应使用独立低延迟 SSD；订阅 backlog 增长与未设置保留和积压配额导致存储膨胀；Topic 数量过多拖累元数据存储；元数据存储不稳定引发集群抖动；Bundle 热点引发频繁迁移。需要监控 Journal 延迟、backlog、元数据延迟并设置命名空间策略。
