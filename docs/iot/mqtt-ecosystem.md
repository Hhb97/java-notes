---
level: 深入
tags: [MQTT-SN, CoAP, LwM2M, Sparkplug B, MQTT over QUIC, WebSocket, AMQP, HTTP, 协议选型, 工业物联网, 云物联网平台]
summary: MQTT 的协议生态与选型：MQTT-SN（UDP/低功耗网络）、CoAP 与 LwM2M（受限设备的 REST 与设备管理）、Sparkplug B（工业物联网的 MQTT 规范与状态管理）、MQTT over WebSocket 与 QUIC、与 HTTP/WebSocket/AMQP/Kafka 的对比、云厂商 MQTT 子集的差异、工业协议网关接入，以及按场景的协议选型决策。
---

# MQTT 协议生态与选型：MQTT-SN、CoAP、Sparkplug B 与 QUIC

> [!ABSTRACT] 核心要点
> - MQTT 是物联网的**事实标准**，但**不是唯一答案**：它基于 **TCP**，对**极端受限设备（无 TCP 栈、非 IP 网络、深度睡眠）**偏重，对**工业数据语义**又过于“自由”。围绕它形成了一圈补充协议与规范：**MQTT-SN**（UDP/ZigBee/BLE 的精简版）、**CoAP/LwM2M**（UDP 上的 REST 与设备管理）、**Sparkplug B**（工业场景在 MQTT 之上的主题与载荷规范）、**MQTT over WebSocket/QUIC**（适配浏览器与移动网络）。
> - 选型的本质是**“设备约束 × 网络条件 × 数据模型 × 生态”**：**电源与算力**（MCU 内存多大、能否跑 TCP/TLS）、**网络**（蜂窝/Wi-Fi/LoRa/ZigBee/NB-IoT，NAT 与丢包）、**交互模式**（上报为主还是需要指令、是否要订阅）、**平台与云生态**（云厂商支持什么）、**团队能力**。
> - **最常见的真实形态是“组合”**：**设备侧**用最适合其约束的协议（MQTT / MQTT-SN / CoAP / Modbus / OPC UA），在**网关**汇聚并转成 **MQTT** 上云，云端用 **Kafka** 等做数据管道。**MQTT 是“设备到云”的汇聚层**，而不一定是每个设备的原生协议。
> - **云厂商的 MQTT 是子集**：QoS2、保留消息、主题长度/层级、报文大小、共享订阅、遗嘱等常有限制或差异，**接入前对照官方文档**，不要假设与自建 EMQX 行为一致。
> - 新趋势：**MQTT 5.0 普及、MQTT over QUIC（弱网与移动场景）、Sparkplug 在工业领域落地、与 Kafka/数据湖集成**；但**成熟度与生态**要按项目实际评估。

## 协议全景

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="物联网协议全景：按传输层分，基于 TCP 的有 MQTT、AMQP、HTTP、WebSocket；基于 UDP 的有 CoAP、MQTT-SN、LwM2M；工业协议有 Modbus、OPC UA、BACnet；规范层有 Sparkplug B 构建在 MQTT 之上；设备经网关汇聚到 MQTT，云端经消息队列进入数据平台">
<rect class="b3" x="20" y="14" width="350" height="110" rx="10"/>
<text class="th" x="32" y="34">TCP 系（可靠流，连接成本较高）</text>
<text class="ts" x="195" y="62" text-anchor="middle">MQTT 3.1.1 / 5.0：发布订阅，轻量，生态最广</text>
<text class="ts" x="195" y="84" text-anchor="middle">HTTP/WebSocket：通用，浏览器友好，开销较大</text>
<text class="ts" x="195" y="106" text-anchor="middle">AMQP：路由丰富，企业消息，设备侧偏重</text>
<rect class="b5" x="390" y="14" width="350" height="110" rx="10"/>
<text class="th" x="402" y="34">UDP 系（无连接，省电，需自管可靠性）</text>
<text class="ts" x="565" y="62" text-anchor="middle">CoAP：REST 风格，CON/NON，Observe，块传输</text>
<text class="ts" x="565" y="84" text-anchor="middle">LwM2M：基于 CoAP 的设备管理与对象模型</text>
<text class="ts" x="565" y="106" text-anchor="middle">MQTT-SN：MQTT 的 UDP/非 TCP 精简版</text>
<rect class="b1" x="20" y="140" width="350" height="86" rx="10"/>
<text class="th" x="32" y="160">工业协议（现场层）</text>
<text class="ts" x="195" y="186" text-anchor="middle">Modbus（RTU/TCP）、OPC UA、BACnet、PROFINET…</text>
<text class="ts" x="195" y="208" text-anchor="middle">通常由边缘网关采集后转换为 MQTT 上云</text>
<rect class="b4" x="390" y="140" width="350" height="86" rx="10"/>
<text class="th" x="402" y="160">规范/语义层</text>
<text class="ts" x="565" y="186" text-anchor="middle">Sparkplug B：MQTT 上的工业主题、载荷与状态规范</text>
<text class="ts" x="565" y="208" text-anchor="middle">物模型（TSL）：平台层的数据语义（见 IoT 平台）</text>
<rect class="bg" x="20" y="242" width="720" height="88" rx="8"/>
<text class="th" x="32" y="262">典型架构：设备 → 网关（协议转换）→ MQTT Broker → 规则引擎/桥接 → Kafka → 数据平台</text>
<text class="ts" x="380" y="288" text-anchor="middle">设备侧协议随约束而变；Broker 与云端统一为 MQTT 与 Kafka，减少云端协议种类</text>
<text class="ts" x="380" y="310" text-anchor="middle">平台整体、Broker 与容量另有专文</text>
</svg>
<figcaption>图 1：物联网协议全景与典型汇聚架构</figcaption>
</figure>

## MQTT-SN

**MQTT for Sensor Networks**：为**非 TCP/IP 或极低功耗网络**（ZigBee、BLE、LoRa 网关、UDP）设计的 MQTT 变体，**协议语义与 MQTT 对应，但报文更短、不要求 TCP**。

| 特点 | 说明 |
| --- | --- |
| **传输** | 通常 **UDP**（也可 ZigBee、串口）；**报文很短**（适配 ≤ 几十字节的帧） |
| **网关（Gateway）** | 设备通过 **MQTT-SN 网关**接入，**网关与 Broker 之间转成标准 MQTT/TCP**；有**透明网关**（每个设备对应一个到 Broker 的 MQTT 连接）与**聚合网关**（多设备共用连接） |
| **主题 ID** | 用 **2 字节主题 ID** 代替长主题字符串：**REGISTER/REGACK** 向网关登记主题名得到 ID；也有**预定义主题 ID**与**短主题名（2 字符）**，免注册 |
| **睡眠支持** | 设备进入**睡眠**期间，**网关/Broker 为其缓存下行消息**，设备醒来发起轮询取回——非常适合电池设备 |
| **QoS -1** | **无需连接**即可发布（发了就走，适合极简传感器，类似“广播式上报”） |
| **网关发现** | ADVERTISE/SEARCHGW/GWINFO 广播发现网关 |
| **局限** | 生态较小（部分 Broker/网关支持），UDP 的可靠性/NAT/安全需自行处理（DTLS 等） |

适用：**ZigBee/BLE 传感网、LoRa 汇聚、不具备 TCP 栈的 MCU**；如果设备能跑 TCP 与 TLS，通常直接用 MQTT 更简单。

## CoAP 与 LwM2M

### CoAP（Constrained Application Protocol）

**面向受限设备的 REST 协议**，基于 **UDP**：

| 特性 | 说明 |
| --- | --- |
| **REST 模型** | `GET/POST/PUT/DELETE` + URI（`coap://host/sensors/temp`），与 HTTP 语义一一对应，**易与 HTTP 互转（代理）** |
| **可靠性** | **CON（需确认）** 消息由发送方**超时重传**（指数退避）+ ACK；**NON（不需确认）** 消息即发即忘；消息 ID 去重 |
| **Observe（RFC 7641）** | 客户端“订阅”资源，资源变化时服务器**推送通知**，实现类似发布订阅的效果 |
| **块传输（Block-wise，RFC 7959）** | 大载荷（如固件）分块传输，适应 UDP 小 MTU |
| **安全** | **DTLS**（UDP 上的 TLS）；**OSCORE**（对象级安全，端到端，适合经过代理/多跳） |
| **报文** | 固定 4 字节头 + 选项 + 载荷，非常紧凑 |
| **多播** | 支持组播（局域网发现、批量操作） |
| **TCP/WebSocket 承载** | RFC 8323 定义了 CoAP over TCP/TLS/WebSocket，用于穿越 NAT 或 UDP 受阻的网络 |

### LwM2M（Lightweight M2M）

**OMA 定义的设备管理协议**，**基于 CoAP**，提供**标准化的设备管理与对象模型**：

- **对象/资源模型**：设备信息、连接监控、固件更新、位置、传感器等有**标准对象 ID**，平台能**直接理解**数据语义；
- 操作：**Bootstrap（引导）、Registration（注册与保活）、Device Management（读写/执行）、Information Reporting（观察上报）**；
- 与 NB-IoT/蜂窝物联网（运营商平台如 OneNET、CTWing 等）结合紧密，**低功耗与省流量**；
- 对比 MQTT 自建物模型 + 影子：LwM2M **更标准化**、管理能力更全，但**生态与工具链较窄**，实现与调试难度较高。

### MQTT 与 CoAP 的关键差异

| 维度 | MQTT | CoAP |
| --- | --- | --- |
| **模型** | **发布/订阅**（经 Broker 解耦） | **请求/响应（REST）**，Observe 补充推送 |
| **传输** | TCP（保活维持连接） | UDP（无连接，睡眠友好） |
| **连接成本** | 建连 + 保活心跳（NAT 老化需应对） | 无需长连接，按需发包（但 NAT 映射仍会过期，需周期性刷新） |
| **可靠性** | QoS0/1/2 由协议保证 | CON 重传 / NON，应用自管 |
| **多对多** | **原生**（一对多广播、主题路由） | 点对点为主，一对多需组播/Observe/代理 |
| **指令下发** | 订阅主题即可推送 | 设备需暴露资源或使用 Observe/轮询；NAT 后设备被动接收较难 |
| **安全** | TLS（TCP） | DTLS/OSCORE |
| **生态** | **最大**（Broker、云平台、工具） | 受限设备、运营商 IoT、LwM2M |
| **适用** | 通用物联网、需要实时指令与多订阅 | 极度受限、电池供电、局域/蜂窝 NB-IoT 上报 |

## Sparkplug B：工业物联网的 MQTT 规范

MQTT 只规定了传输，**不规定主题命名、载荷格式、状态管理**，导致各厂商私有方案互不兼容。**Sparkplug（Eclipse 基金会/原 Cirrus Link）** 在 MQTT 之上定义了**工业场景的互操作规范**：

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="Sparkplug B：主题命名空间 spBv1.0/组/消息类型/边缘节点/设备；边缘节点建立连接时设置遗嘱 NDEATH，连接后发布 NBIRTH 和 DBIRTH 声明所有指标（出生证书），之后用 NDATA/DDATA 上报变化的指标；平台用 NCMD/DCMD 下发命令；主机应用通过 STATE 主题声明在线状态；Protobuf 编码的载荷包含指标、数据类型、时间戳；序号用于检测丢失，必要时请求 Rebirth">
<rect class="b3" x="20" y="14" width="720" height="40" rx="8"/>
<text class="tb" x="380" y="34" text-anchor="middle" dominant-baseline="middle">主题命名空间：spBv1.0 / {group_id} / {message_type} / {edge_node_id} [/ {device_id}]</text>
<rect class="b5" x="20" y="64" width="350" height="160" rx="10"/>
<text class="th" x="32" y="84">消息类型</text>
<text class="ts" x="195" y="110" text-anchor="middle">NBIRTH / DBIRTH：节点/设备上线，声明全部指标</text>
<text class="ts" x="195" y="132" text-anchor="middle">NDEATH / DDEATH：节点/设备下线（NDEATH 做遗嘱）</text>
<text class="ts" x="195" y="154" text-anchor="middle">NDATA / DDATA：指标值变化上报（只报变化）</text>
<text class="ts" x="195" y="176" text-anchor="middle">NCMD / DCMD：向节点/设备下发命令</text>
<text class="ts" x="195" y="198" text-anchor="middle">STATE：主机应用的在线状态（Primary Host）</text>
<rect class="b1" x="390" y="64" width="350" height="160" rx="10"/>
<text class="th" x="402" y="84">核心机制</text>
<text class="ts" x="565" y="110" text-anchor="middle">出生证书：上线先发完整指标清单与初值</text>
<text class="ts" x="565" y="132" text-anchor="middle">遗嘱即死亡证书：连接时注册 NDEATH，断线自动发</text>
<text class="ts" x="565" y="154" text-anchor="middle">序号 seq（0~255）+ bdSeq：检测丢包与重连会话</text>
<text class="ts" x="565" y="176" text-anchor="middle">发现序号断档或乱序 → 请求 Rebirth 重新同步</text>
<text class="ts" x="565" y="198" text-anchor="middle">载荷 Protobuf：指标名、类型、值、时间戳、质量</text>
<rect class="bg" x="20" y="240" width="720" height="90" rx="8"/>
<text class="ts" x="380" y="262" text-anchor="middle">解决的问题：主题与载荷标准化 → 不同厂商设备、网关、SCADA/MES、云平台即插即用；统一的在线/离线语义与状态一致性</text>
<text class="ts" x="380" y="284" text-anchor="middle">“只报变化 + 出生证书”大幅降低带宽，适合带宽受限的工业现场；“状态而非轮询”让平台始终知道设备当前全貌</text>
<text class="ts" x="380" y="306" text-anchor="middle">注意：具体消息格式、QoS/Retain 约定、版本差异以 Sparkplug 规范文档为准；与通用物联网平台的物模型可映射但不等同</text>
</svg>
<figcaption>图 2：Sparkplug B 的主题、消息类型与状态管理</figcaption>
</figure>

适用与权衡：

| 适合 | 不一定适合 |
| --- | --- |
| **工业自动化/SCADA/MES** 与 IT 系统集成，多厂商互通 | 消费级 IoT（物模型更偏向平台自定义） |
| 需要**统一在线状态与设备全貌** | 对载荷灵活性要求极高、完全自定义格式 |
| 带宽/连接数有限的现场，需要“只报变化” | 团队没有工业背景、生态工具不齐 |

## MQTT over WebSocket 与 QUIC

### MQTT over WebSocket

**让浏览器与受限网络能使用 MQTT**：

- 在 **WebSocket（子协议 `mqtt`）** 的**二进制帧**里承载 MQTT 报文；端口通常 **80/443**，易穿越防火墙与代理；
- 适合**浏览器前端实时订阅**（监控大屏、在线状态）、**小程序**（部分平台只允许 WebSocket）；
- 注意：必须 **wss（TLS）**；浏览器无法设置自定义 TLS 客户端证书 → 认证用令牌（用户名=JWT 等）；**Origin 校验、限流、ACL**同样必要；
- **每个浏览器标签页一个连接**，规模大时注意 Broker 的 WebSocket 连接数与负载均衡（`Upgrade` 头与会话保持）；
- **不适合**替代设备端的原生 TCP 连接（多一层帧开销）。

### MQTT over QUIC

**QUIC**（HTTP/3 的传输层，基于 UDP，内建 TLS 1.3）为 MQTT 带来的潜在好处：

| 优势 | 说明 |
| --- | --- |
| **更快的建连** | **1-RTT 握手（可 0-RTT 恢复）**，相比 TCP + TLS 少往返；弱网下重连更快 |
| **连接迁移** | **网络切换（Wi-Fi ↔ 4G、IP 变化）时保持连接**，不必重新握手重新建连——对车联网/移动设备意义大 |
| **多路复用无队头阻塞** | 一个连接多条流，丢包只影响对应流；可把**指令流**与**大数据流**分开 |
| **更适应弱网/高丢包** | 拥塞控制与丢包恢复在用户态实现，可灵活优化 |

现实约束：

- **生态与成熟度**：EMQX 等 Broker 与部分客户端 SDK 支持，规范与互操作仍在演进，**生产使用前要评估成熟度**；
- **UDP 被限制**：部分企业/运营商网络**限制或降级 UDP**，需要**回退到 TCP**；
- **设备资源**：QUIC 栈对 MCU 偏重；
- 适用场景：**车联网、移动终端、弱网环境**；传统固定设备用 TCP+TLS 已足够。

## 与 HTTP / WebSocket / AMQP / Kafka 的对比

| 维度 | MQTT | HTTP（轮询/长轮询） | WebSocket | AMQP | Kafka |
| --- | --- | --- | --- | --- | --- |
| **模型** | 发布/订阅 | 请求/响应 | 双向消息通道 | 代理、路由丰富 | 分区日志 |
| **报文开销** | **极小**（2 字节起） | 大（头部几百字节） | 小（帧头 2~14 字节） | 中 | 批量，面向服务端 |
| **连接** | 长连接 | 短连接/长轮询 | 长连接 | 长连接 | 服务端到集群 |
| **设备实时推送** | **原生** | 需轮询（延迟/开销大） | 可以（需自定义协议） | 可以（偏重） | 不面向设备 |
| **QoS/可靠性** | 协议内三级 | 靠重试 | 自定义 | 丰富（事务、确认） | 副本与确认 |
| **离线消息** | 持久会话 | 不支持 | 自定义 | 队列支持 | 日志保留 |
| **适合设备** | **受限设备首选** | 偶尔上报、可接受开销 | 浏览器/中等设备 | 服务端/较强设备 | 云端数据管道 |
| **规模（连接数）** | **百万级/Broker** | 取决于网关 | 十万级 | 万级 | 万级（不适合百万设备直连） |

**结论**：**设备到云用 MQTT（或 CoAP/LwM2M 于极端受限场景）；云内部数据管道用 Kafka；业务服务间用 gRPC/HTTP；浏览器前端用 WebSocket（可承载 MQTT）**。把 Kafka 当“设备直连协议”并不合适（连接数、协议复杂度、设备端 SDK），见 [Kafka 架构与存储](#/mw/kafka)、[消息队列核心问题](#/mw/mq)。

## 云厂商的 MQTT 差异

| 方面 | 常见差异（以各厂商文档为准） |
| --- | --- |
| **协议版本** | 通常支持 3.1.1，部分支持 5.0；5.0 特性可能只实现子集（如不支持共享订阅/请求响应/增强认证） |
| **QoS** | 部分不支持 QoS2（只到 QoS1），或 QoS2 行为与标准有差异 |
| **保留消息/遗嘱** | 可能限制（不支持保留消息或有数量/大小限制；遗嘱行为不同） |
| **主题** | **主题结构被平台预定义**（如 `$aws/things/{thing}/shadow/...`、设备孪生主题），自定义主题的层级、长度、字符集受限；保留系统主题不能乱用 |
| **报文大小** | 对单报文设置上限（通常 KB 级到 128KB 左右，视产品），大载荷需拆分 |
| **会话** | 持久会话与离线队列的保留时长、容量有限；离线消息保留策略不同 |
| **连接与保活** | 保活范围限制（如最小/最大值），单账号连接数/速率配额 |
| **认证与权限** | 绑定自家身份体系（证书 + 策略、设备密钥签名、SAS 令牌）；ACL 通过策略文档 |
| **规则/转发** | 规则引擎语法与 EMQX 不同；数据桥接到自家存储/队列 |
| **产品生命周期** | 云物联网产品可能被下线或重组（例如部分厂商的 IoT 产品已停服并要求迁移），**避免深度绑定私有 API**，用标准 MQTT + 可迁移的设备身份与数据模型 |

选型建议：**设备端尽量只依赖标准 MQTT 特性**；平台特有的功能（影子、孪生、规则）封装在**适配层**；自建 Broker 与云平台**行为差异用兼容性测试覆盖**，见 [Broker 架构与集群（EMQX）](#/iot/broker) 的选型。

## 工业协议接入与边缘网关

现场设备多使用工业协议，**边缘网关**负责**采集、转换、缓存、上云**：

| 协议 | 特点 | 接入要点 |
| --- | --- | --- |
| **Modbus（RTU/TCP）** | 简单、广泛、**轮询式**主从，无时间戳、无语义 | 网关**周期轮询寄存器**，按点表映射为带时间戳的物模型属性；注意轮询间隔与总线负载 |
| **OPC UA** | 面向对象的信息模型、**订阅**机制、安全完备 | 网关订阅节点变化，映射为 MQTT 消息或 Sparkplug；证书与信任管理 |
| **BACnet、KNX 等楼宇协议** | 场景化 | 网关适配 |
| **CAN/车载总线** | 车联网 | 车载终端采集 → MQTT 上云 |
| **串口/私有协议** | 各厂商自定义 | 自研解析插件 |

网关的关键能力：**协议插件化、断网缓存与补传、本地规则/边缘计算、设备身份与子设备代理、批量上报与压缩、远程配置与 OTA**；详见 [IoT 平台架构与设备管理](#/iot/platform) 的边缘章节与 [弱网、可靠性、安全与排障](#/iot/mqtt-practice) 的上行可靠性。

## 协议选型决策

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="协议选型决策：设备能运行 TCP 和 TLS 且网络是蜂窝或 Wi-Fi，选 MQTT；设备极端受限、非 IP 网络或需要睡眠缓存，选 MQTT-SN 或 CoAP/LwM2M；工业现场接入，使用 Modbus 或 OPC UA 经网关转 MQTT，并可采用 Sparkplug B；浏览器与小程序用 WebSocket 承载 MQTT；移动与弱网场景可评估 MQTT over QUIC；云端数据管道使用 Kafka">
<rect class="b3" x="20" y="14" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">通用设备（能跑 TCP+TLS）</text>
<text class="ts" x="195" y="58" text-anchor="middle">→ MQTT 3.1.1/5.0（首选）</text>
<rect class="b5" x="390" y="14" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">极端受限/非 IP/需睡眠缓存</text>
<text class="ts" x="565" y="58" text-anchor="middle">→ MQTT-SN（经网关）或 CoAP/LwM2M</text>
<rect class="b1" x="20" y="96" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="116" text-anchor="middle" dominant-baseline="middle">工业现场（Modbus/OPC UA…）</text>
<text class="ts" x="195" y="140" text-anchor="middle">→ 边缘网关转换 → MQTT（可用 Sparkplug B）</text>
<rect class="b4" x="390" y="96" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="116" text-anchor="middle" dominant-baseline="middle">浏览器/小程序订阅</text>
<text class="ts" x="565" y="140" text-anchor="middle">→ MQTT over WebSocket（wss）</text>
<rect class="b2" x="20" y="178" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="198" text-anchor="middle" dominant-baseline="middle">移动/车联网/强弱网切换</text>
<text class="ts" x="195" y="222" text-anchor="middle">→ 评估 MQTT over QUIC（连接迁移）</text>
<rect class="b3" x="390" y="178" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="198" text-anchor="middle" dominant-baseline="middle">云端数据管道/服务间</text>
<text class="ts" x="565" y="222" text-anchor="middle">→ Kafka / gRPC / HTTP，MQTT 只做设备汇聚</text>
<rect class="bg" x="20" y="262" width="720" height="58" rx="8"/>
<text class="ts" x="380" y="284" text-anchor="middle">决策依据：设备算力/电源 · 网络类型与 NAT · 交互模式（上报/指令/订阅）· 数据语义与互操作 · 平台与云生态 · 团队能力与运维</text>
<text class="ts" x="380" y="306" text-anchor="middle">宁可一个主协议 + 网关适配，也不要在云端同时直面五六种设备协议</text>
</svg>
<figcaption>图 3：协议选型决策</figcaption>
</figure>

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 智能家居/可穿戴/共享设备/车载终端（有 TCP+TLS 能力） | **MQTT 5.0/3.1.1** | 生态最全、实时指令、成本低 |
| 电池供电传感器（NB-IoT/LoRa 网关汇聚） | **CoAP/LwM2M** 或 **MQTT-SN**，周期唤醒上报 | 省电、无需长连接 |
| ZigBee/BLE 传感网 | **MQTT-SN** 经网关 | 非 TCP 网络 |
| 工业设备数据采集与 MES/SCADA 集成 | **边缘网关 + MQTT（Sparkplug B）** | 标准语义与状态 |
| Web 监控大屏/小程序实时数据 | **MQTT over WebSocket** | 浏览器可用 |
| 车联网/弱网强移动 | MQTT（TCP）+ 重连与会话优化，评估 **QUIC** | 连接迁移与弱网表现 |
| 大规模设备管理（OMA 体系、运营商平台） | **LwM2M** | 标准设备管理与对象模型 |
| 服务端异步集成、数据入湖 | **Kafka**（经 Broker 桥接） | 大吞吐持久日志 |

## 相关阅读

- [MQTT 协议详解](#/iot/mqtt)：MQTT 的基础与使用
- [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5)：5.0 特性与迁移
- [弱网、可靠性、安全与排障](#/iot/mqtt-practice)：弱网与可靠性工程
- [Broker 架构与集群（EMQX）](#/iot/broker)：Broker 选型与容量
- [IoT 平台架构与设备管理](#/iot/platform)：边缘网关、物模型与协议接入
- [Kafka 架构与存储](#/mw/kafka)：云端数据管道

## 面试追问

> [!QUESTION] MQTT 和 CoAP 有什么区别？各适合什么场景？
> MQTT 是基于 TCP 的发布订阅，经 Broker 解耦，原生支持多对多、实时下行指令和三级 QoS，生态最广，但需要长连接和保活。CoAP 是基于 UDP 的 REST 协议，无连接、报文紧凑，靠 CON 重传保证可靠，Observe 可推送，适合极度受限和低功耗的 NB-IoT 类场景，但点对点为主、指令下发在 NAT 后较难。

> [!QUESTION] MQTT-SN 解决什么问题？
> 为 ZigBee、BLE 等非 TCP 或 UDP 网络与极低功耗设备设计，报文更短，用 2 字节主题 ID 代替长主题，通过网关转为标准 MQTT，支持设备睡眠期间由网关缓存下行消息，还有无需连接即可发布的 QoS -1。设备能跑 TCP 与 TLS 时直接用 MQTT 更简单。

> [!QUESTION] Sparkplug B 是什么？
> 工业物联网在 MQTT 之上的互操作规范，定义主题命名空间、消息类型和 Protobuf 载荷：节点上线发 NBIRTH 声明全部指标，遗嘱注册 NDEATH 作为死亡证书，之后只上报变化的 NDATA，用序号检测丢失并可请求 Rebirth 重新同步，还有 STATE 声明主机应用在线。解决了各厂商私有主题与载荷导致的互不兼容。

> [!QUESTION] MQTT over QUIC 有什么好处？有什么限制？
> QUIC 带来更快建连、网络切换时的连接迁移、多路复用且无队头阻塞，对车联网和弱网移动设备有价值。限制是生态与互操作仍在演进，部分网络限制 UDP 需要回退 TCP，MCU 实现偏重，所以要先评估成熟度，固定设备用 TCP 加 TLS 已足够。

> [!QUESTION] 为什么不让设备直连 Kafka？
> Kafka 面向服务端数据管道，协议复杂、客户端偏重，不适合百万级受限设备直连，连接数与保活模型也不合适。常见做法是设备用 MQTT 接入 Broker，通过规则引擎或桥接把数据汇聚到 Kafka，云端再做流处理与存储。

> [!QUESTION] 接入云厂商的 MQTT 服务要注意什么？
> 云厂商通常实现的是标准的子集，QoS2、保留消息、遗嘱、共享订阅、主题结构与长度、报文大小、会话与离线队列都可能有限制或差异，认证也绑定自家身份体系。设备端尽量只依赖标准特性，把平台特有功能放在适配层，并避免深度绑定私有 API，以便迁移。
