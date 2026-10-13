---
level: 深入
tags: [Kafka, 运维, 容量规划, 分区数, Rebalance, Lag, 分区迁移, 配额, 安全, 跨集群复制, MirrorMaker, 升级]
summary: Kafka 生产运维与治理：容量与分区数规划、Broker 与客户端关键参数、Rebalance 治理（协作式、静态成员）、Lag 监控与积压处置、分区迁移与扩缩容、磁盘与日志策略、配额与限流、安全（TLS/SASL/ACL）、跨集群复制与容灾、滚动升级、常见故障排查。
---

# Kafka 生产运维：容量规划、Rebalance 治理与故障排查

> [!ABSTRACT] 核心要点
> - 架构与副本原理见 [Kafka 架构与存储](#/mw/kafka)、[Kafka 副本与可靠性](#/mw/kafka-reliability)。本页回答的是**“集群怎么规划、怎么稳定跑、出事怎么查”**。
> - **分区数是最难回头的决策之一**：分区只能增不能减，增加分区会**破坏按 key 的顺序语义**；规划按“**目标吞吐 ÷ 单分区吞吐**”与“**最大消费者并行度**”两者取大，并留 2~3 倍余量，同时警惕分区过多带来的元数据、文件句柄与选主开销。
> - **Rebalance 是消费端稳定性的头号杀手**：处理超时（`max.poll.interval.ms`）、心跳丢失、频繁扩缩容都会触发。用**协作式再均衡 + 静态成员（`group.instance.id`）+ 合理超时**治理，并让消费逻辑可控地批量化。
> - **Lag 是核心业务指标**：看**绝对积压量与时间维度（消息年龄）**，按“生产变快、消费变慢、消费者掉线、Rebalance 风暴、下游慢”分类处置。
> - **运维动作要有“限速与回退”**：分区迁移限流、滚动重启一次一台并等 ISR 恢复、升级先升 Broker 再升客户端、变更先在预发演练。
> - **安全与隔离**：TLS 加密 + SASL 认证 + ACL 授权 + 配额，防止一个业务把集群拖垮。

## 容量规划

### 需要回答的问题

| 问题 | 估算方法 |
| --- | --- |
| **集群总吞吐** | 峰值写入 MB/s（含副本放大）= 峰值入流量 × 副本数；读取 = 入流量 × 消费者组数（每组读一遍） |
| **磁盘容量** | 日写入量 × 保留天数 × 副本数 ÷ 压缩比 × (1 + 余量 30%~50%) |
| **网络** | Broker 网卡既承担生产者写入、follower 复制、消费者读取：总出入带宽留 50% 以上余量，避免打满 |
| **Broker 数量** | 取“磁盘、网络、分区数”约束中最大者；至少 3 台，跨可用区时副本分散 |
| **内存** | Kafka 靠**页缓存**提速：内存留给 OS 缓存比堆更重要；堆通常不需要很大（如 6~8GB 量级），其余交给页缓存，以让热数据读取不落盘 |
| **磁盘类型** | 顺序读写为主，普通 SSD 或高性能 HDD 阵列均可；**日志目录多盘（JBOD）**需注意单盘故障处理；NVMe 可显著降低尾延迟 |

经验数值（吞吐、堆大小等）强依赖硬件与消息大小，务必用自己的压测结果替代，见 [压测方法与容量规划](#/design/eng-loadtest)。

### 分区数规划

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="分区数规划：由目标吞吐除以单分区吞吐、消费者最大并行度、未来增长三个因素取最大值，再受限于集群总分区数、文件句柄、选主与元数据开销，并说明分区只增不减且增加分区会改变 key 的映射">
<rect class="b3" x="20" y="30" width="200" height="86" rx="10"/>
<text class="tb" x="120" y="50" text-anchor="middle" dominant-baseline="middle">① 吞吐维度</text>
<text class="ts" x="120" y="74" text-anchor="middle">目标 MB/s ÷ 单分区实测</text>
<text class="ts" x="120" y="94" text-anchor="middle">（生产与消费分别测）</text>
<rect class="b5" x="240" y="30" width="200" height="86" rx="10"/>
<text class="tb" x="340" y="50" text-anchor="middle" dominant-baseline="middle">② 并行度维度</text>
<text class="ts" x="340" y="74" text-anchor="middle">期望的最大消费者数</text>
<text class="ts" x="340" y="94" text-anchor="middle">一个分区同组内仅一个消费者</text>
<rect class="b1" x="460" y="30" width="140" height="86" rx="10"/>
<text class="tb" x="530" y="50" text-anchor="middle" dominant-baseline="middle">③ 增长余量</text>
<text class="ts" x="530" y="74" text-anchor="middle">未来 1~2 年</text>
<text class="ts" x="530" y="94" text-anchor="middle">乘 2~3 倍</text>
<rect class="b2" x="620" y="30" width="120" height="86" rx="10"/>
<text class="tb" x="680" y="50" text-anchor="middle" dominant-baseline="middle">取最大值</text>
<text class="ts" x="680" y="74" text-anchor="middle">再取整</text>
<text class="ts" x="680" y="94" text-anchor="middle">常为 Broker 数倍数</text>
<line class="l" x1="220" y1="73" x2="240" y2="73" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="73" x2="460" y2="73" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="73" x2="620" y2="73" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="140" width="350" height="136" rx="8"/>
<text class="th" x="32" y="160">分区过多的代价</text>
<text class="ts" x="195" y="184" text-anchor="middle">元数据与控制器负担：故障时选主、恢复耗时变长</text>
<text class="ts" x="195" y="204" text-anchor="middle">文件句柄与内存：每分区多个 segment 与索引文件</text>
<text class="ts" x="195" y="224" text-anchor="middle">端到端延迟：副本复制与批次变小，吞吐下降</text>
<text class="ts" x="195" y="244" text-anchor="middle">Rebalance 变慢：分配与位点管理的规模变大</text>
<text class="ts" x="195" y="264" text-anchor="middle">没有固定“安全值”，按版本与硬件压测，而非拍脑袋</text>
<rect class="bg" x="390" y="140" width="350" height="136" rx="8"/>
<text class="th" x="402" y="160">分区调整的约束</text>
<text class="ts" x="565" y="184" text-anchor="middle">只能增加，不能减少（减少需新建 Topic 迁移）</text>
<text class="ts" x="565" y="204" text-anchor="middle">增加分区后，相同 key 可能落到不同分区</text>
<text class="ts" x="565" y="224" text-anchor="middle">→ 依赖按 key 有序的业务，扩分区会破坏顺序</text>
<text class="ts" x="565" y="244" text-anchor="middle">→ 需要业务停写/新 Topic 双写迁移，提前规划</text>
<text class="ts" x="565" y="264" text-anchor="middle">按 key 路由的下游状态（如有状态流处理）也要重分布</text>
</svg>
<figcaption>图 1：分区数的规划维度与调整约束</figcaption>
</figure>

要点：

- **Topic 拆分原则**：按业务域和数据特征拆分，不要“一个 Topic 装一切”；不同保留期、不同吞吐、不同重要程度的数据分开；
- **Key 设计**：避免**热点 key** 造成单分区过热（如全部用同一个 key）；如需有序又要打散，用“业务 key + 子序号”折中；
- **副本数**：核心 Topic 副本 3、`min.insync.replicas=2`；非核心可降低；
- **预留扩容空间**：给消费者组留出“分区数 ≥ 最大消费者数”的余量，避免到需要扩消费者时才发现分区不够。

## 关键参数速览

可靠性相关参数见 [Kafka 副本与可靠性](#/mw/kafka-reliability)。这里补充运维常调的：

### Broker 与 Topic

| 参数 | 说明 | 建议 |
| --- | --- | --- |
| `num.network.threads` / `num.io.threads` | 网络与磁盘 IO 线程 | 按 CPU 核数与负载调，监控请求队列与线程空闲率 |
| `log.retention.hours` / `retention.bytes` | 按时间/大小保留 | 同时设置大小上限，防止磁盘写满 |
| `log.segment.bytes` | segment 大小 | 过小文件多、过大清理与恢复慢；按默认量级评估 |
| `message.max.bytes` / `max.message.bytes` | 单条消息上限 | **与生产者 `max.request.size`、消费者 `fetch.max.bytes`、副本 `replica.fetch.max.bytes` 联动调整**，否则会“发得进收不出/复制卡住” |
| `auto.create.topics.enable` | 自动创建 Topic | **生产环境关闭**，防止拼写错误创建出垃圾 Topic，Topic 统一走审批与平台创建 |
| `unclean.leader.election.enable` | 允许非 ISR 副本当 Leader | 关闭，除非明确接受丢数据换可用性 |
| `default.replication.factor` | 默认副本数 | 3 |
| `delete.topic.enable` | 允许删除 Topic | 受控开启，配合权限 |

### 生产者

| 参数 | 作用 | 调优思路 |
| --- | --- | --- |
| `batch.size` + `linger.ms` | 批大小与等待时间 | 吞吐优先：增大 `linger.ms`（如 5~20ms）与 `batch.size`；延迟优先则减小 |
| `compression.type` | 压缩 | `lz4`/`zstd` 常用，节省网络与磁盘；CPU 换带宽，对文本/JSON 收益明显 |
| `acks` + `enable.idempotence` | 可靠性与幂等 | 关键数据 `acks=all` + 幂等 |
| `buffer.memory` / `max.block.ms` | 发送缓冲与阻塞上限 | 缓冲满时 send 会阻塞，超时抛异常，需有降级 |
| `delivery.timeout.ms` / `retries` | 发送整体超时与重试 | 以超时为主，重试次数设大即可 |
| `max.in.flight.requests.per.connection` | 并发请求数 | 开启幂等后可保持较大值（受版本限制）而不乱序 |

### 消费者

| 参数 | 作用 | 调优思路 |
| --- | --- | --- |
| `max.poll.records` | 单次 poll 返回条数 | 处理慢则调小，保证在 `max.poll.interval.ms` 内处理完一批 |
| `max.poll.interval.ms` | 两次 poll 的最大间隔 | 超过被踢出组触发 Rebalance；按最坏处理耗时设置 |
| `session.timeout.ms` / `heartbeat.interval.ms` | 心跳存活判定 | 心跳线程独立于处理线程；心跳间隔约为会话超时的 1/3 |
| `fetch.min.bytes` / `fetch.max.wait.ms` | 拉取批量与等待 | 增大可提升吞吐，降低请求次数 |
| `enable.auto.commit` | 自动提交位点 | 关键业务关闭，处理成功后手动提交 |
| `partition.assignment.strategy` | 分配策略 | 使用**协作式粘性（CooperativeSticky）** 降低再均衡影响 |
| `group.instance.id` | 静态成员 ID | 固定标识让重启不触发 Rebalance（在会话超时内回归） |

## Rebalance 治理

Rebalance 期间（传统“全员停止”模式）整个消费组暂停消费，造成延迟毛刺甚至重复消费。

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="Rebalance 的触发原因与治理：成员加入离开、处理超时、心跳丢失、订阅变化触发再均衡；治理手段为协作式粘性分配、静态成员、合理超时与批量大小、业务处理异步化与限流、避免频繁扩缩容">
<rect class="b4" x="20" y="20" width="350" height="140" rx="10"/>
<text class="th" x="32" y="40">常见触发原因</text>
<text class="ts" x="195" y="68" text-anchor="middle">消费者启动/停止/发布重启（滚动发布最常见）</text>
<text class="ts" x="195" y="90" text-anchor="middle">处理一批耗时超过 max.poll.interval.ms 被踢出</text>
<text class="ts" x="195" y="112" text-anchor="middle">心跳超时：长时间 GC、网络抖动、CPU 饱和</text>
<text class="ts" x="195" y="134" text-anchor="middle">订阅的 Topic 或分区数变化</text>
<text class="ts" x="195" y="152" text-anchor="middle">自动扩缩容 HPA 频繁调整副本数</text>
<rect class="b2" x="390" y="20" width="350" height="140" rx="10"/>
<text class="th" x="402" y="40">治理手段</text>
<text class="ts" x="565" y="68" text-anchor="middle">① 协作式粘性分配：只迁移必要分区，其余继续消费</text>
<text class="ts" x="565" y="90" text-anchor="middle">② 静态成员：重启在会话超时内回来，不触发再均衡</text>
<text class="ts" x="565" y="112" text-anchor="middle">③ 调小 max.poll.records，保证单批处理远小于间隔</text>
<text class="ts" x="565" y="134" text-anchor="middle">④ 慢处理交给线程池，poll 线程保持心跳并暂停分区</text>
<text class="ts" x="565" y="152" text-anchor="middle">⑤ 滚动发布放慢节奏；HPA 设置稳定窗口</text>
<rect class="bg" x="20" y="180" width="720" height="116" rx="8"/>
<text class="th" x="32" y="200">排查线索</text>
<text class="ts" x="380" y="224" text-anchor="middle">日志里频繁出现 “Revoke/Assigned partitions”“Member ... has failed”“CommitFailedException”</text>
<text class="ts" x="380" y="244" text-anchor="middle">监控：组状态在 PreparingRebalance/CompletingRebalance 停留时间、每分钟再均衡次数、Lag 周期性尖刺</text>
<text class="ts" x="380" y="264" text-anchor="middle">位点提交失败会导致重复消费：Rebalance 前后要保证已处理消息的位点已提交，处理逻辑要幂等</text>
<text class="ts" x="380" y="284" text-anchor="middle">Kafka 新版本提供了新一代消费者组协议，由 Broker 端协调、减少全员停顿，升级前以官方文档为准评估</text>
</svg>
<figcaption>图 2：Rebalance 的原因与治理</figcaption>
</figure>

在消费端用线程池处理时要注意：**poll 线程仍需周期性 poll 以保持成员存活**，可用 `pause()` 暂停分区拉取、处理完再 `resume()`；位点要在对应消息**处理完成后**才能提交，避免“已提交但未处理”导致丢消息。通用的消费幂等与失败处理见 [消息队列核心问题](#/mw/mq)。

## Lag 监控与积压处置

### 看什么

| 指标 | 说明 |
| --- | --- |
| **Consumer Lag（条数）** | 最新位点 − 已提交位点；按组、Topic、分区看 |
| **Lag 时间（消息年龄）** | 积压消息的最早时间到现在的差；比条数更贴近业务（“落后 10 分钟”） |
| **生产速率 / 消费速率** | 趋势对比，判断是持续恶化还是短期尖峰 |
| **分区倾斜** | 个别分区 Lag 异常大：热点 key 或某消费者卡死 |
| **组状态** | Stable/Rebalancing/Empty/Dead；Empty 表示无消费者 |
| **Broker 指标** | 请求延迟（Produce/Fetch）、ISR 变化、Under Replicated Partitions、磁盘与网络、请求队列时间 |

常用采集：Broker 的 JMX 指标、专门的 Lag 导出器（如 Burrow、kafka-exporter 等）接入 Prometheus，见 [指标监控：Prometheus 与告警](#/infra/obs-metrics)。**告警按“Lag 持续增长 + 时间维度”触发**，避免短暂尖峰误报。

### 处置思路

| 原因 | 判断依据 | 处置 |
| --- | --- | --- |
| 生产突增 | 生产速率飙升，消费速率正常 | 扩容消费者（不超过分区数）；评估是否限流上游；临时提高消费并行度 |
| 消费变慢 | 单条处理耗时上升，下游（DB/外部服务）变慢 | 先治理下游瓶颈；批量处理；异步化；必要时降级非核心逻辑 |
| 消费者掉线/Rebalance 风暴 | 组状态抖动，消费者数下降 | 按上节治理；修复崩溃原因 |
| 分区倾斜 | 单分区 Lag 极大 | 热点 key 拆分；该分区的消费者排查卡死（死循环/毒消息） |
| 毒消息 | 同一位点反复失败 | 跳过并转入死信 Topic，保留现场，后续修复重放 |
| 分区数不足 | 消费者数已等于分区数仍追不上 | 扩分区（注意 key 顺序影响）或单消费者内多线程并行处理 |

紧急追赶：**临时新增一个消费组/临时 Topic 并行消费历史数据**，或让消费者**批量+多线程**；不要直接跳到最新位点，除非业务明确允许丢弃。

## 扩缩容与分区迁移

Broker 增减或负载不均时，需要**重新分配分区副本**：

- 使用官方的分区重分配工具（`kafka-reassign-partitions`）生成迁移计划，或使用集群均衡工具（如 Cruise Control）自动计算与执行；
- **必须限流**（复制带宽限制），否则迁移流量会挤占业务流量造成延迟抖动；
- **分批迁移**：按 Topic 或按一批分区，观察 ISR、延迟、磁盘，再继续；
- **先扩 Broker 再迁移**：新 Broker 加入后默认不会自动获得旧分区，需要主动迁移；
- **缩容**：先把分区迁出再下线，禁止直接关机；
- **Leader 均衡**：迁移或重启后执行首选副本选举，使 Leader 回到首选副本，避免单节点承载过多 Leader；
- 迁移完成后清理限流设置，检查 **Under Replicated Partitions** 归零。

## 磁盘与日志

| 问题 | 处置 |
| --- | --- |
| **磁盘快满** | 缩短保留期/加大小上限、清理无用 Topic、扩容磁盘、迁移分区；**绝不要手动删除日志文件**（会破坏元数据和位点一致性） |
| 单盘故障（JBOD） | 受影响分区的副本离线，由其他副本继续服务；替换磁盘后自动重新同步；留意日志目录离线告警 |
| 磁盘使用不均 | 多盘间分区分布不均：迁移或均衡工具处理 |
| 压缩 Topic（compaction） | 用于状态/变更日志，`min.cleanable.dirty.ratio`、`delete.retention.ms` 影响清理时机；墓碑消息（value 为空）保留期要覆盖所有消费者重放窗口 |
| 日志恢复慢 | 异常关机后重启要恢复日志，分区过多恢复时间长；优雅关闭、增加恢复线程 |

## 配额、安全与多租户

### 配额（Quota）

- 可以按**用户、客户端 ID**设置生产/消费字节速率与请求占用比例，超限的客户端会被**延迟响应（节流）**，保护集群不被单个业务打垮；
- 核心业务与离线业务**分账号分配额**；监控被节流的次数以发现异常客户端。

### 安全

| 层面 | 做法 |
| --- | --- |
| **传输加密** | 客户端与 Broker、Broker 之间启用 TLS，证书轮换要有流程 |
| **认证** | SASL（SCRAM、OAUTHBEARER、Kerberos 等）或双向 TLS，避免明文密码写在代码里（从密钥管理系统获取） |
| **授权** | ACL：按“用户 × 资源（Topic/Group/TransactionalId）× 操作”最小授权；禁止给业务账号集群管理权限 |
| **审计** | 记录 ACL 变更、Topic 创建删除、认证失败；与 [认证与授权](#/security/auth) 的体系对齐 |
| **网络** | Broker 内网部署，限制 advertised.listeners 暴露范围，避免公网直连；公网访问走专线/代理 |
| **数据保护** | 敏感字段在应用层加密或脱敏后再写入，见 [加密与密钥管理](#/security/crypto) |

### 平台化治理

多团队共用集群时，建议由平台统一管理 Topic 生命周期（申请、审批、命名规范、容量与保留策略、负责人）、账号与 ACL、配额与监控，详见 [消息队列平台化与治理](#/mw/mq-governance)。

## 跨集群复制与容灾

| 方案 | 说明 | 注意 |
| --- | --- | --- |
| **MirrorMaker 2 / 集群链接** | 把 Topic 异步复制到另一集群，同步部分消费者位点 | 复制是**异步**的：故障切换会有 RPO > 0；Topic 命名常带源集群前缀，需处理消费者切换 |
| **主备（Active-Passive）** | 备集群平时只接收复制数据，故障时切换流量 | 切换流程要演练：生产者切换、消费者位点翻译、避免双写 |
| **双活（Active-Active）** | 两地都有读写，互相复制 | 需处理**循环复制**与冲突；业务要能容忍重复与乱序 |
| **拉伸集群（跨可用区）** | 一个集群的副本分布在多个可用区 | 同城低延迟网络可行，副本放置要机架感知（`broker.rack`）；跨地域延迟高不适用 |

容灾要讲清楚三件事：**RPO（可丢多少）、RTO（多久恢复）、切换后消费位点怎么对齐**；演练比方案本身更重要，参考 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)。

## 滚动升级与变更

1. **阅读发行说明**：协议版本、废弃配置、行为变化（例如元数据管理模式、默认值变化）；
2. **预发演练**：用与生产相近的数据和客户端版本验证；
3. **滚动升级 Broker**：一次一台，等待该节点**回到 ISR、Under Replicated 为 0** 再继续；保持 `inter.broker.protocol.version` 与 `log.message.format.version`（随版本而定）的升级顺序：先升级二进制，稳定后再提升协议版本，便于回退；
4. **再升级客户端**：Kafka 对新旧客户端有较好的双向兼容，但仍需关注版本矩阵；
5. **可回退**：保留回退方案，协议版本提升前可回退二进制；
6. **窗口与监控**：低峰期执行，盯住延迟、错误率、ISR、Lag。

## 常见故障排查

| 现象 | 常见根因 | 排查与处理 |
| --- | --- | --- |
| 生产者超时 / `TimeoutException` | Broker 过载、ISR 不足（`min.insync.replicas` 不满足）、网络问题、元数据过期 | 看 Broker 请求延迟与 ISR，检查磁盘与网络；`NotEnoughReplicas` 说明副本不足 |
| `RecordTooLargeException` / 消息发不出 | 消息超过上限，限制参数不一致 | 按前述四个参数联动调整，或改“引用+对象存储” |
| 消费者一直重复消费同一批 | 位点提交失败、处理异常循环、Rebalance 导致提交丢失 | 检查提交逻辑、毒消息隔离、幂等 |
| Under Replicated Partitions 持续不为 0 | 某 Broker 磁盘/网络慢、GC、被限流迁移占满带宽 | 定位慢节点，降低迁移限速，检查磁盘 IO |
| 控制器频繁切换 | Controller 所在节点不稳定、元数据量过大 | 排查节点稳定性与 GC；治理分区总量 |
| 磁盘写满、Broker 下线 | 保留期设置不当、突发流量 | 紧急扩容或缩短保留期，事后补容量告警与上限 |
| 某分区 Leader 过多/单节点负载高 | Leader 分布不均 | 首选副本选举、迁移分区、均衡工具 |
| 消费 Lag 周期性尖刺 | 定时任务/批处理、Rebalance、下游定时变慢 | 对照时间点关联事件，治理 Rebalance 与下游 |
| 长时间 GC 导致被踢出组/ISR | 堆过大或消息过大 | 调整堆与 GC、控制批大小，监控 GC 暂停 |

## 相关阅读

- [Kafka 架构与存储](#/mw/kafka)：分区、segment、生产者与消费者原理
- [Kafka 副本与可靠性](#/mw/kafka-reliability)：ISR、HW、幂等与事务
- [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)：数据集成与流处理
- [消息队列平台化与治理](#/mw/mq-governance)：Topic 规范、配额与消费者治理
- [压测方法与容量规划](#/design/eng-loadtest)：吞吐与容量的实测方法

## 面试追问

> [!QUESTION] Kafka 的分区数怎么定？有什么注意？
> 按目标吞吐除以单分区实测吞吐、期望的最大消费并行度、未来增长余量三者取最大并留余量。分区只能增不能减，增加分区会改变 key 到分区的映射，破坏按 key 有序的业务；分区过多会增加元数据、文件句柄、选主恢复和 Rebalance 的开销，所以要压测并提前规划。

> [!QUESTION] 消费者频繁 Rebalance 怎么治理？
> 先定位原因：滚动发布、处理超过 max.poll.interval.ms 被踢、心跳超时、自动扩缩容。治理手段包括使用协作式粘性分配减少停顿、静态成员让重启不触发再均衡、调小 max.poll.records 与合理设置超时、慢处理异步化并保持 poll、放慢发布与扩缩容节奏，同时保证位点正确提交和业务幂等。

> [!QUESTION] 消息积压了怎么处理？
> 先看积压类型：生产突增就扩消费者（不超过分区数）并评估上游限流；消费变慢就治理下游瓶颈、批量与异步化；消费者掉线或 Rebalance 风暴就修复稳定性；分区倾斜就拆热点 key 并排查卡死消费者；毒消息就转死信跳过；分区数不足则扩分区或单消费者多线程。紧急时可用临时消费组并行追赶，不要随意跳到最新位点。

> [!QUESTION] 怎么安全地做分区迁移和扩缩容？
> 用官方重分配工具或 Cruise Control 生成计划，必须对复制带宽限流，分批迁移并观察 ISR、延迟和磁盘，扩容先加 Broker 再迁移分区，缩容先迁出再下线，迁移后做首选副本选举并清理限流，确认 Under Replicated Partitions 归零。

> [!QUESTION] Kafka 如何做多机房容灾？
> 常用 MirrorMaker 2 等异步复制到备集群，主备切换时 RPO 大于零，需要演练生产者切换和消费者位点翻译；双活要处理循环复制和冲突；同城低延迟可用拉伸集群并配置机架感知。要明确 RPO、RTO 与位点对齐方案，并定期演练。

> [!QUESTION] 如何防止某个业务拖垮整个 Kafka 集群？
> 用配额限制用户或客户端的生产消费速率，超限会被节流；核心与离线业务分账号分配额，用 ACL 做最小授权，关闭自动创建 Topic、由平台统一审批；监控节流与异常流量，并设置 Topic 的保留与大小上限。
