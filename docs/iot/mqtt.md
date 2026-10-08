---
level: 深入
tags: [MQTT, 物联网, QoS, 遗嘱消息, 保留消息, 共享订阅, MQTT 5.0, 协议]
summary: 讲透 MQTT 协议：发布订阅模型与主题通配、报文结构、三种 QoS 的握手与语义边界、会话与遗嘱、保留消息、保活与重连，以及 MQTT 5.0 的关键增强和主题设计规范。
---

# MQTT 协议详解

> [!ABSTRACT] 核心要点
> - MQTT 是基于 **TCP 的轻量发布/订阅协议**：设备（Client）通过 **Broker** 中转，发布者与订阅者**互不相识**；固定头只有 **2 字节起**，适合弱网与低功耗设备。
> - **主题（Topic）** 层级用 `/` 分隔，订阅支持通配符：`+` 匹配**单层**、`#` 匹配**多层**（必须放最后）。
> - **QoS 0/1/2**：至多一次 / **至少一次**（可能重复）/ 恰好一次（四步握手）。**QoS 是“发布者→Broker”和“Broker→订阅者”两段分别协商，取两者较小值**。
> - **会话（Clean Session / Clean Start）**、**遗嘱消息（LWT）**、**保留消息（Retain）** 是设备在线状态与最新状态下发的核心机制；**保活（Keep Alive）** 靠 PINGREQ 探测死连接。
> - 生产主流是 **MQTT 3.1.1** 与 **MQTT 5.0**；5.0 新增**原因码、用户属性、共享订阅、会话/消息过期、主题别名、请求/响应模式、流控**等。

## 为什么是 MQTT

| 协议 | 模型 | 特点 | 适用 |
| --- | --- | --- | --- |
| **MQTT** | 发布/订阅，TCP 长连接 | 报文极小、**异步**、保活、QoS、遗嘱、保留 | 设备上报与下行控制，**IoT 事实标准** |
| HTTP | 请求/响应 | 头部大、设备难以被动接收下行 | 管理接口、固件下载 |
| CoAP | 请求/响应，UDP | 极轻、面向受限设备（RFC 7252） | 超低功耗传感器、NB-IoT |
| AMQP | 队列模型 | 功能完备、较重 | 企业消息 |
| LwM2M | 设备管理协议（基于 CoAP） | 标准化对象模型、固件管理 | 运营商/设备管理 |
| WebSocket | 全双工通道 | 浏览器可用 | 浏览器接入 MQTT（MQTT over WebSocket） |

MQTT 的价值：**设备主动连接到云**（穿透 NAT 与防火墙），云可通过已建立的长连接**随时下发指令**——这是 HTTP 做不到的。

## 发布/订阅模型与主题

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="MQTT 发布订阅：设备发布到主题，Broker 按订阅匹配分发给多个订阅者">
<rect class="b1" x="20" y="30" width="170" height="50" rx="8"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">传感器 dev-001</text>
<text class="tm" x="105" y="68" text-anchor="middle">PUBLISH 上报温度</text>
<rect class="b1" x="20" y="110" width="170" height="50" rx="8"/>
<text class="tb" x="105" y="130" text-anchor="middle" dominant-baseline="middle">网关 gw-9</text>
<text class="tm" x="105" y="148" text-anchor="middle">PUBLISH 状态</text>
<rect class="b3" x="280" y="60" width="200" height="140" rx="12"/>
<text class="th" x="380" y="86" text-anchor="middle">Broker</text>
<text class="ts" x="380" y="110" text-anchor="middle">主题树 · 订阅表</text>
<text class="ts" x="380" y="130" text-anchor="middle">会话 · 保留消息 · 遗嘱</text>
<text class="ts" x="380" y="150" text-anchor="middle">按订阅匹配并分发</text>
<text class="ts" x="380" y="170" text-anchor="middle">QoS 降级 / 离线排队</text>
<line class="l" x1="190" y1="55" x2="280" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="135" x2="280" y2="150" marker-end="url(#arr)"/>
<text class="tm" x="246" y="86" text-anchor="middle">factory/a/dev-001/temp</text>
<rect class="b2" x="570" y="20" width="170" height="56" rx="8"/>
<text class="tb" x="655" y="40" text-anchor="middle" dominant-baseline="middle">监控大屏</text>
<text class="tm" x="655" y="60" text-anchor="middle">订阅 factory/a/+/temp</text>
<rect class="b2" x="570" y="100" width="170" height="56" rx="8"/>
<text class="tb" x="655" y="120" text-anchor="middle" dominant-baseline="middle">规则引擎 / 入库服务</text>
<text class="tm" x="655" y="140" text-anchor="middle">订阅 factory/#</text>
<rect class="b2" x="570" y="180" width="170" height="56" rx="8"/>
<text class="tb" x="655" y="200" text-anchor="middle" dominant-baseline="middle">手机 App</text>
<text class="tm" x="655" y="220" text-anchor="middle">订阅 factory/a/dev-001/#</text>
<line class="la" x1="480" y1="90" x2="570" y2="50" marker-end="url(#arr-a)"/>
<line class="la" x1="480" y1="130" x2="570" y2="128" marker-end="url(#arr-a)"/>
<line class="la" x1="480" y1="170" x2="570" y2="208" marker-end="url(#arr-a)"/>
<text class="ts" x="380" y="266" text-anchor="middle">发布者不知道订阅者是谁、有几个；订阅者也不知道消息来自谁——空间、时间、同步三个维度解耦</text>
<text class="ts" x="380" y="290" text-anchor="middle">下行同理：服务端发布 factory/a/dev-001/cmd，设备订阅该主题即可接收指令</text>
</svg>
<figcaption>图 1：Broker 按订阅关系分发，发布者与订阅者彼此解耦</figcaption>
</figure>

### 主题与通配符

```text
主题（Topic Name）：区分大小写，UTF-8，用 / 分层
  factory/a/dev-001/temperature

订阅过滤器（Topic Filter）才允许通配符：
  +   单层通配：factory/a/+/temperature   匹配 factory/a/dev-001/temperature
                                           不匹配 factory/a/dev-001/sensor/temperature
  #   多层通配（只能在末尾）：factory/a/#  匹配 factory/a、factory/a/x、factory/a/x/y/z

特殊：以 $ 开头的主题（如 $SYS/...）不会被以 # 或 + 开头的订阅匹配；用于 Broker 内部/系统统计
```

主题**不需要预先创建**，发布即存在。设计规范（见本页末）会直接影响权限控制、扩展性与性能。

## 报文结构

所有 MQTT 报文 = **固定头（Fixed Header）+ 可变头（Variable Header）+ 负载（Payload）**。

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="MQTT 固定头：报文类型 4 位、标志 4 位、剩余长度变长编码 1 到 4 字节">
<rect class="b1" x="20" y="40" width="200" height="56" rx="0"/>
<text class="tb" x="120" y="60" text-anchor="middle" dominant-baseline="middle">报文类型 (4 bit)</text>
<text class="tm" x="120" y="80" text-anchor="middle">1=CONNECT 3=PUBLISH 8=SUBSCRIBE…</text>
<rect class="b3" x="220" y="40" width="160" height="56" rx="0"/>
<text class="tb" x="300" y="60" text-anchor="middle" dominant-baseline="middle">标志 (4 bit)</text>
<text class="tm" x="300" y="80" text-anchor="middle">PUBLISH: DUP|QoS|RETAIN</text>
<rect class="b2" x="380" y="40" width="200" height="56" rx="0"/>
<text class="tb" x="480" y="60" text-anchor="middle" dominant-baseline="middle">剩余长度 (1~4 字节)</text>
<text class="tm" x="480" y="80" text-anchor="middle">变长编码，最大 256MB</text>
<rect class="b" x="580" y="40" width="140" height="56" rx="0"/>
<text class="tb" x="650" y="60" text-anchor="middle" dominant-baseline="middle">可变头 + 负载</text>
<text class="ts" x="650" y="80" text-anchor="middle">随报文类型而变</text>
<text class="th" x="20" y="132">剩余长度编码（每字节：低 7 位数据，最高位=1 表示还有后续字节）</text>
<text class="tm" x="20" y="158">0 ~ 127            → 1 字节</text>
<text class="tm" x="20" y="180">128 ~ 16,383       → 2 字节    例：321 = 0xC1 0x02</text>
<text class="tm" x="20" y="202">…  最多 4 字节，表示到 268,435,455（约 256MB）</text>
<text class="ts" x="20" y="236">PUBLISH 可变头：主题名（2 字节长度+UTF-8）+ 报文标识符（QoS&gt;0 才有）；5.0 另有属性；负载是任意二进制</text>
</svg>
<figcaption>图 2：固定头只需 2 字节起，对窄带网络极其友好</figcaption>
</figure>

主要报文类型：

| 报文 | 方向 | 作用 |
| --- | --- | --- |
| CONNECT / CONNACK | C→S / S→C | 建立会话，携带 ClientID、用户名密码、保活、遗嘱、Clean Session |
| PUBLISH | 双向 | 发布消息 |
| PUBACK / PUBREC / PUBREL / PUBCOMP | 双向 | QoS 1 与 QoS 2 的确认握手 |
| SUBSCRIBE / SUBACK | C→S / S→C | 订阅与结果（含授予的 QoS） |
| UNSUBSCRIBE / UNSUBACK | C→S / S→C | 取消订阅 |
| PINGREQ / PINGRESP | C→S / S→C | 心跳 |
| DISCONNECT | 双向（5.0 服务端也可发） | 正常断开（**正常断开不触发遗嘱**） |
| AUTH（5.0） | 双向 | 增强认证（如 SCRAM、Kerberos 多轮） |

## QoS：服务质量

### 三个等级

| QoS | 语义 | 报文交互 | 特点 |
| --- | --- | --- | --- |
| 0 | **至多一次**（fire and forget） | PUBLISH | 不确认、不重传，可能丢；最快 |
| **1** | **至少一次** | PUBLISH → PUBACK | 未收到 PUBACK 会**重发**（DUP=1），**可能重复**；最常用 |
| 2 | **恰好一次** | PUBLISH → PUBREC → PUBREL → PUBCOMP | 四步握手，不丢不重，开销最大 |

### QoS 1 与 QoS 2 的握手

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="QoS 1 的两步确认与 QoS 2 的四步握手时序">
<text class="th" x="190" y="24" text-anchor="middle">QoS 1：至少一次</text>
<rect class="b1" x="60" y="40" width="100" height="30" rx="6"/>
<text class="tb" x="110" y="55" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b3" x="220" y="40" width="100" height="30" rx="6"/>
<text class="tb" x="270" y="55" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="ld" x1="110" y1="70" x2="110" y2="200"/>
<line class="ld" x1="270" y1="70" x2="270" y2="200"/>
<line class="l" x1="110" y1="100" x2="270" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="190" y="92" text-anchor="middle">PUBLISH(id=7)</text>
<text class="ts" x="276" y="124" text-anchor="start">收到→交付并存储</text>
<line class="l" x1="270" y1="150" x2="110" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="190" y="142" text-anchor="middle">PUBACK(id=7)</text>
<text class="ts" x="190" y="186" text-anchor="middle">PUBACK 丢失 → 发送方重发 DUP=1</text>
<text class="ta" x="190" y="210" text-anchor="middle">⇒ 接收方可能收到两次</text>
<text class="th" x="570" y="24" text-anchor="middle">QoS 2：恰好一次</text>
<rect class="b1" x="440" y="40" width="100" height="30" rx="6"/>
<text class="tb" x="490" y="55" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b3" x="620" y="40" width="100" height="30" rx="6"/>
<text class="tb" x="670" y="55" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="ld" x1="490" y1="70" x2="490" y2="300"/>
<line class="ld" x1="670" y1="70" x2="670" y2="300"/>
<line class="l" x1="490" y1="96" x2="670" y2="96" marker-end="url(#arr)"/>
<text class="ts" x="580" y="88" text-anchor="middle">① PUBLISH(id=7)</text>
<line class="l" x1="670" y1="136" x2="490" y2="136" marker-end="url(#arr)"/>
<text class="ts" x="580" y="128" text-anchor="middle">② PUBREC(id=7) 已记录</text>
<line class="l" x1="490" y1="176" x2="670" y2="176" marker-end="url(#arr)"/>
<text class="ts" x="580" y="168" text-anchor="middle">③ PUBREL(id=7) 可以交付了</text>
<line class="l" x1="670" y1="216" x2="490" y2="216" marker-end="url(#arr)"/>
<text class="ts" x="580" y="208" text-anchor="middle">④ PUBCOMP(id=7) 完成</text>
<text class="ts" x="580" y="256" text-anchor="middle">接收方在 ②~③ 间保存 id，重复的 PUBLISH 不再交付</text>
<text class="ts" x="580" y="278" text-anchor="middle">③ 之后才向应用交付（3.1.1 的常见实现）</text>
</svg>
<figcaption>图 3：QoS 1 两步（可能重复），QoS 2 四步（去重）</figcaption>
</figure>

### 两段 QoS 与降级

<figure class="fig">
<svg viewBox="0 0 740 190" class="dg" role="img" aria-label="发布者到 Broker 与 Broker 到订阅者是两段独立的 QoS，取较小值">
<rect class="b1" x="20" y="60" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="85" text-anchor="middle" dominant-baseline="middle">发布者</text>
<rect class="b3" x="310" y="60" width="120" height="50" rx="8"/>
<text class="tb" x="370" y="85" text-anchor="middle" dominant-baseline="middle">Broker</text>
<rect class="b2" x="610" y="60" width="110" height="50" rx="8"/>
<text class="tb" x="665" y="85" text-anchor="middle" dominant-baseline="middle">订阅者</text>
<line class="la" x1="130" y1="85" x2="310" y2="85" marker-end="url(#arr-a)"/>
<text class="ta" x="220" y="76" text-anchor="middle">PUBLISH QoS = 2</text>
<line class="la" x1="430" y1="85" x2="610" y2="85" marker-end="url(#arr-a)"/>
<text class="ta" x="520" y="76" text-anchor="middle">转发 QoS = min(2, 1) = 1</text>
<text class="ts" x="370" y="150" text-anchor="middle">端到端不存在“恰好一次”保证：每一段各自协商；订阅者订阅时声明的 QoS 就是上限</text>
</svg>
<figcaption>图 4：QoS 是逐段（hop-by-hop）的</figcaption>
</figure>

> [!WARNING] “恰好一次”只在协议的单段内成立
> 即使两段都用 QoS 2，**也不能保证业务层面端到端恰好一次**：客户端崩溃重启、会话丢失（Clean Session）、Broker 切换都可能造成重复或丢失。物联网业务要做**幂等**：消息携带**唯一 ID/时间戳/序列号**，消费端去重；指令类消息带 `correlationId`，设备按 ID 去重并响应。实践中**QoS 1 + 业务幂等**是最常见组合。

选择建议：高频遥测（温度每秒一次）→ QoS 0；告警、状态变化、指令 → QoS 1；极少数不能重复且无法幂等的场景 → QoS 2（注意性能与离线堆积）。

## 会话、遗嘱、保留消息

### 会话（Session）

| 项 | MQTT 3.1.1 | MQTT 5.0 |
| --- | --- | --- |
| 开关 | `Clean Session`：1=不保留（连接断开会话销毁）；0=保留 | `Clean Start`（连接时是否丢弃旧会话）+ **`Session Expiry Interval`**（断开后会话保留多久，秒） |
| 会话里保存什么 | 订阅关系、**未确认的 QoS 1/2 消息、离线期间 QoS 1/2 消息（订阅者）** | 同左 |

要点：

- 设备要**收到离线期间的下行指令**，必须使用**持久会话（Clean Session = 0）**，并且**每次重连用同一个 ClientID**；
- 离线队列**不是无限**的：Broker 对每个会话有最大排队数（EMQX 的 `max_mqueue_len` 等），超过丢弃；
- **ClientID 全局唯一**：同一 ClientID 再次连接，Broker 会**踢掉旧连接**（常见“互相踢下线、频繁重连”故障就是多台设备/多个程序用了相同 ClientID）。

### 遗嘱消息（Last Will and Testament）

CONNECT 时设置：遗嘱主题、内容、QoS、Retain。**客户端异常断开**（网络断、保活超时、协议错误）时，Broker 代为发布这条消息；**正常发送 DISCONNECT 则不发布**（5.0 可通过原因码要求发布）。

典型用途：**在线状态**——

```text
设备连接成功：  PUBLISH  devices/dev-001/status  "online"   (retain=1, QoS 1)
CONNECT 遗嘱：  devices/dev-001/status  "offline"  (retain=1, QoS 1)
→ 任何时刻订阅 devices/+/status 都能拿到每台设备的最新在线状态
```

5.0 还支持 **Will Delay Interval**：延迟发布遗嘱，设备短暂断线重连（如切换基站）就不会误报离线。

### 保留消息（Retained Message）

PUBLISH 时 `RETAIN=1`：Broker 为该主题**保存最后一条消息**；新的订阅者订阅匹配主题时**立即收到**这条“最新状态”（不必等设备下次上报）。发布**空负载的保留消息**会清除该主题的保留消息。适合：设备状态、配置、传感器最新值。

> [!NOTE] 保留消息与持久会话的区别
> 保留消息是**每个主题一条**、给**所有后来订阅者**的“最新值”；持久会话里的离线消息是给**某个特定订阅者**、在它离线期间错过的**多条**消息。

## 保活与连接管理

- **Keep Alive**：CONNECT 时声明间隔（秒）；在 1.5 倍间隔内没有收到客户端任何报文，Broker 判定连接已死并关闭（触发遗嘱）；客户端空闲时需要发 **PINGREQ**，Broker 回 PINGRESP；
- 取值权衡：太短增加流量与电量消耗，太长发现死连接慢；常用 **30~120 秒**（蜂窝网络需考虑运营商 NAT 超时，通常几分钟）；
- **断线重连**：设备应使用**指数退避 + 随机抖动**重连，否则 Broker 重启后海量设备同时重连形成**重连风暴**（见 [Netty 实战：编解码、内存与调优](#/infra/netty-practice) 中的重连策略）；
- 连接认证：用户名/密码、**TLS 客户端证书**、JWT（把 token 放密码字段）；生产必须 **TLS（8883 端口）**，明文 1883 仅内网/测试。

## MQTT 5.0 关键增强

| 特性 | 说明 |
| --- | --- |
| **原因码（Reason Code）** | 所有确认报文带原因码（如 `0x87 Not authorized`、`0x97 Quota exceeded`），定位问题更精确（3.1.1 的 CONNACK 只有少数返回码，其他直接断开） |
| **用户属性（User Properties）** | 报文里携带自定义键值对，类似 HTTP 头，可传递租户、追踪 ID |
| **共享订阅（Shared Subscription）** | `$share/{group}/{filter}`：同一组内的多个订阅者**负载均衡**消费，用于后端服务**水平扩展**消费设备数据 |
| **会话/消息过期** | `Session Expiry Interval`、`Message Expiry Interval`：离线消息与会话有生命周期 |
| **主题别名（Topic Alias）** | 用整数代替冗长主题名，节省带宽 |
| **请求/响应模式** | `Response Topic` + `Correlation Data`，标准化“指令-应答” |
| **流控（Receive Maximum）** | 限制未确认的 QoS 1/2 消息并发数，避免慢消费者被压垮（反向压力） |
| **增强认证（AUTH）** | 多轮挑战应答（SCRAM、OAuth） |
| 载荷格式指示、内容类型 | `Payload Format Indicator`、`Content Type`，声明负载是 UTF-8 / JSON 等 |
| 服务端主动断开原因 | Broker 发 DISCONNECT 告知原因 |

共享订阅是后端消费设备上行的关键：**没有共享订阅时，N 个后端实例各订阅同一主题会各收到一份完整消息（重复处理）**；使用 `$share/ingest/factory/+/+/up` 则**同一条消息只会投递给组内一个实例**，实现水平扩展。

```text
# 后端服务实例 1、2、3 都订阅：
$share/ingest/devices/+/telemetry
# Broker 在三者之间分发（轮询/随机/哈希等策略），同一条消息只给其中一个
```

## 主题设计规范

好的主题设计决定了**权限控制、可扩展性与可维护性**：

```text
推荐结构：{产品或租户}/{设备ID}/{方向}/{消息类型}

上行（设备→云）  acme/dev-001/up/telemetry        遥测
                 acme/dev-001/up/event            事件/告警
                 acme/dev-001/up/status           在线状态（保留）
下行（云→设备）  acme/dev-001/down/cmd            指令
                 acme/dev-001/down/config         配置
                 acme/dev-001/down/ota            固件升级
应答             acme/dev-001/up/cmd-reply        指令应答（带 correlationId）
```

| 原则 | 原因 |
| --- | --- |
| **设备 ID 放在主题里**，且订阅粒度由设备权限限定（ACL：设备只能发布/订阅含自己 ID 的主题，如 `acme/${clientid}/#`） | 防止设备越权读写他人数据；**不要让设备订阅 `#`** |
| 层级固定、语义稳定，**不在主题里放易变数据**（时间戳、值） | 主题数量爆炸会拖垮订阅树与内存 |
| 上行与下行分开 | 方便做 ACL 与规则匹配 |
| 避免以 `/` 开头、避免空层级、避免过深层级（建议 ≤ 6 层） | 兼容性与匹配效率 |
| 不用空格与非 ASCII 字符 | 兼容性 |
| **负载格式统一**（JSON 或 Protobuf/CBOR），带版本字段与时间戳 | 演进与排错；资源受限设备用二进制（Protobuf/CBOR）省流量 |
| 下行指令带 `msgId`/`correlationId` | 幂等、应答匹配、超时重发 |

## 典型交互模式

### 指令下发与应答

```text
1. 云端发布    acme/dev-001/down/cmd      {"msgId":"c-1001","method":"reboot","params":{}}   QoS 1
2. 设备订阅了该主题并收到，执行，然后发布
               acme/dev-001/up/cmd-reply  {"msgId":"c-1001","code":0,"msg":"ok"}              QoS 1
3. 云端按 msgId 匹配应答；超时未应答 → 重发/告警；设备按 msgId 去重避免重复执行
```

5.0 可用 `Response Topic/Correlation Data` 原生表达这个模式。

### 设备在线状态

连接成功后发布保留消息 `online`，遗嘱为保留消息 `offline`；后台服务订阅 `+/+/up/status`（共享订阅）维护在线表。注意**重连竞态**：设备已重连成功，旧连接的遗嘱可能后到，导致误判离线；对策：状态消息携带**连接序号/时间戳**，或使用 Broker 的**连接/断开事件**（EMQX 的 `$SYS`/规则引擎事件 `client.connected/disconnected`）并带上连接信息，以最新连接为准。

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| 设备不停被踢、反复重连 | ClientID 冲突（多设备共用），或同一设备多进程；保证 ClientID 唯一 |
| 离线收不到下行指令 | Clean Session=1，或会话已过期，或离线队列已满；改持久会话并限定过期时间 |
| 收到重复消息 | QoS 1 的正常语义；业务幂等 |
| 订阅了却收不到 | 通配符与 `$` 开头主题规则、ACL 拒绝（订阅被静默拒绝，SUBACK 返回失败码 0x80）、订阅 QoS 过低 |
| 消息体很大被断开 | 超过 Broker `max_packet_size`；大文件不要走 MQTT，下发 URL 让设备走 HTTPS 下载 |
| 弱网下掉线频繁 | Keep Alive 过长被 NAT 回收；过短耗电；断线后快速重连并保持会话 |
| 后端消费重复 | 多实例订阅同一主题未使用共享订阅；使用 `$share` 或 Broker 侧规则转发到 MQ |

## 面试追问

> [!QUESTION] MQTT 的 QoS 三个等级有什么区别？实际怎么选？
> QoS 0 至多一次不确认；QoS 1 至少一次（PUBLISH+PUBACK，可能重复）；QoS 2 恰好一次（四步握手）。高频遥测用 0；告警和指令用 1 并做业务幂等；QoS 2 开销大，仅在不能重复且无法幂等时使用。另外 QoS 是发布者到 Broker、Broker 到订阅者分段协商，取较小值。

> [!QUESTION] MQTT 如何保证设备离线期间的消息不丢？
> 订阅者使用持久会话（Clean Session=0 或 5.0 的 Session Expiry），且订阅 QoS ≥ 1；Broker 为该会话保存离线期间的 QoS 1/2 消息，重连后投递；同时需要固定 ClientID，并注意离线队列长度和过期时间的限制。

> [!QUESTION] 遗嘱消息和保留消息各是什么？怎么配合实现在线状态？
> 遗嘱是客户端异常断开时由 Broker 代发的消息；保留消息是 Broker 为主题保存的最后一条消息，新订阅者立刻可收到。设备上线发布保留的 online，遗嘱设置为保留的 offline，订阅者任何时候都能获得设备最新在线状态。

> [!QUESTION] MQTT 5.0 的共享订阅解决什么问题？
> 后端多个实例订阅同一主题时，每个实例都会收到一份消息导致重复处理；共享订阅 `$share/group/topic` 让同组实例分摊消息，同一条消息只投递给组内一个成员，实现消费端水平扩展。

> [!QUESTION] 为什么 MQTT 适合物联网而不是 HTTP？
> 设备主动建立并保持长连接，云可随时下行；报文头极小、流量和电量开销低；发布订阅解耦且支持一对多；有 QoS、保活、遗嘱、保留消息等针对不稳定网络的机制；HTTP 是请求/响应模式，下行困难且头部大。
