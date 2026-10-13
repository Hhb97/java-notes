---
level: 深入
tags: [MQTT 5.0, 属性, 原因码, 会话过期, Will Delay, 主题别名, 流控, 请求响应, 共享订阅, 订阅选项, 增强认证, 用户属性]
summary: MQTT 5.0 的深入解析：属性（Properties）机制与编码、原因码体系、会话过期与 Clean Start、遗嘱延迟、消息过期、主题别名、Receive Maximum 流控与最大报文、请求/响应模式（Response Topic/Correlation Data）、共享订阅与订阅选项（No Local/Retain As Published/Retain Handling）、服务端断开通知与重定向、增强认证、用户属性，以及与 3.1.1 的差异、迁移策略和物联网场景的落地建议。
---

# MQTT 5.0 深入：属性、原因码与新机制

> [!ABSTRACT] 核心要点
> - 5.0 的设计主线是**把过去靠“约定/厂商扩展/应用层补丁”做的事，下沉为协议标准**：**可观测性与可诊断性（原因码、原因字符串）、会话与消息生命周期（会话过期、消息过期、遗嘱延迟）、流控与资源保护（Receive Maximum、最大报文、主题别名）、可扩展性（属性、用户属性）、新交互模式（请求/响应、共享订阅、订阅选项）、更好的认证（增强认证）**。
> - **属性（Properties）** 是 5.0 的扩展机制：多数报文在可变报头末尾带一个“**属性长度（变长整数）+ 若干 [属性ID, 值]**”。新能力几乎都是通过属性加入的，**向后可扩展**，未识别的属性按规则处理。
> - **原因码（Reason Code）** 取代了 3.1.1 里粗糙的返回码：**CONNACK、PUBACK/PUBREC、SUBACK、UNSUBACK、DISCONNECT、AUTH 都带原因码**，而且**服务器可以主动发 DISCONNECT 告知断开原因**（3.1.1 里服务器只能直接断开）。**排障体验的飞跃**。
> - **对物联网最有价值的特性**：**会话过期间隔（防僵尸会话）、消息过期间隔（指令不过期执行）、遗嘱延迟（抗抖动）、主题别名（省流量）、Receive Maximum（背压）、请求/响应模式（标准化指令应答）、共享订阅（后端水平扩展）、用户属性（携带元数据，如 traceId）**。
> - **迁移不是“换个版本号”**：客户端库、Broker、规则引擎、网关、监控、固件都要支持；设备固件升级周期长，所以通常是**Broker 同时支持 3.1.1 与 5.0，新设备/新服务逐步用 5.0**。
> - 具体属性 ID、取值范围与默认值以 **MQTT 5.0 规范**为准，本文列出常用项并给出工程建议。

## 属性机制

### 编码

5.0 中 **CONNECT/CONNACK/PUBLISH/PUBACK/…/DISCONNECT/AUTH** 等报文的可变报头末尾增加：

```text
[属性长度：变长整数] [属性1: ID(1字节)+值] [属性2: ID+值] …
```

值的类型有：**1 字节整数、2 字节整数、4 字节整数、变长整数、UTF-8 字符串、二进制数据、UTF-8 字符串对（用户属性）**。**同一属性通常只能出现一次**（用户属性、订阅标识符可重复）；出现不该出现的属性是**协议错误**。

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="MQTT 5.0 属性在 CONNECT 报文中的位置：可变报头依次是协议名、协议级别 5、连接标志（Clean Start）、保活、属性长度及属性列表，例如会话过期间隔 4 字节、接收最大值 2 字节、最大报文大小 4 字节、主题别名最大值 2 字节；载荷中的遗嘱部分也有遗嘱属性，例如遗嘱延迟间隔、消息过期间隔">
<text class="th" x="20" y="22">CONNECT（5.0）的结构</text>
<rect class="b3" x="20" y="34" width="110" height="40" rx="6"/>
<text class="ts" x="75" y="54" text-anchor="middle" dominant-baseline="middle">固定报头</text>
<rect class="b5" x="140" y="34" width="120" height="40" rx="6"/>
<text class="ts" x="200" y="54" text-anchor="middle" dominant-baseline="middle">协议名+级别 05</text>
<rect class="b5" x="270" y="34" width="110" height="40" rx="6"/>
<text class="ts" x="325" y="54" text-anchor="middle" dominant-baseline="middle">连接标志</text>
<rect class="b5" x="390" y="34" width="70" height="40" rx="6"/>
<text class="ts" x="425" y="54" text-anchor="middle" dominant-baseline="middle">保活</text>
<rect class="b4" x="470" y="34" width="270" height="40" rx="6"/>
<text class="ts" x="605" y="54" text-anchor="middle" dominant-baseline="middle">属性长度 + 属性列表（5.0 新增）</text>
<text class="ts" x="380" y="96" text-anchor="middle">之后是载荷：客户端 ID → 遗嘱属性/主题/消息 → 用户名 → 密码</text>
<rect class="bg" x="20" y="116" width="350" height="214" rx="8"/>
<text class="th" x="32" y="136">CONNECT 常用属性</text>
<text class="ts" x="195" y="162" text-anchor="middle">会话过期间隔（4B）：断开后会话保留秒数</text>
<text class="ts" x="195" y="184" text-anchor="middle">接收最大值（2B）：我最多同时处理几个 QoS1/2</text>
<text class="ts" x="195" y="206" text-anchor="middle">最大报文大小（4B）：我能接收的最大报文</text>
<text class="ts" x="195" y="228" text-anchor="middle">主题别名最大值（2B）：我支持的别名数</text>
<text class="ts" x="195" y="250" text-anchor="middle">请求响应信息 / 请求问题信息（1B）</text>
<text class="ts" x="195" y="272" text-anchor="middle">认证方法 / 认证数据：增强认证</text>
<text class="ts" x="195" y="294" text-anchor="middle">用户属性：键值对，可多次出现</text>
<rect class="bg" x="390" y="116" width="350" height="214" rx="8"/>
<text class="th" x="402" y="136">遗嘱属性与 PUBLISH 属性</text>
<text class="ts" x="565" y="162" text-anchor="middle">遗嘱延迟间隔：延迟多久再发布遗嘱</text>
<text class="ts" x="565" y="184" text-anchor="middle">消息过期间隔：消息的有效期（秒）</text>
<text class="ts" x="565" y="206" text-anchor="middle">载荷格式指示（0 二进制/1 UTF-8）、内容类型</text>
<text class="ts" x="565" y="228" text-anchor="middle">响应主题 + 关联数据：请求/响应</text>
<text class="ts" x="565" y="250" text-anchor="middle">主题别名：用 2 字节代替长主题</text>
<text class="ts" x="565" y="272" text-anchor="middle">订阅标识符：标记消息命中哪个订阅</text>
<text class="ts" x="565" y="294" text-anchor="middle">用户属性：携带 traceId 等元数据</text>
</svg>
<figcaption>图 1：5.0 的 CONNECT 与属性</figcaption>
</figure>

### CONNACK 的能力声明

服务器在 CONNACK 里用属性**声明自己的能力与限制**，客户端**必须遵守**：

| 属性 | 含义 |
| --- | --- |
| **最大 QoS** | 服务器支持的最高 QoS（如 1） |
| **保留消息可用** | 是否支持保留消息 |
| **最大报文大小** | 服务器愿意接收的最大报文 |
| **通配符订阅/订阅标识符/共享订阅 可用** | 是否支持相应特性（不支持的特性使用会被拒绝） |
| **服务器保活（Server Keep Alive）** | **覆盖客户端提出的保活值**（服务器根据负载/NAT 调整） |
| **分配的客户端 ID** | 客户端传空 ID 时，服务器分配的 ID |
| **会话过期间隔** | 服务器**调整**后的值（可小于客户端请求） |
| **接收最大值 / 主题别名最大值** | 服务器侧的流控与别名上限 |
| **响应信息 / 服务器引用** | 请求响应的主题前缀；重定向到另一台服务器 |

**意义**：客户端不再“盲发”，而是**协商后遵守对端能力**；例如服务器只支持 QoS1 时，客户端发 QoS2 会被拒绝（`0x9B`），客户端应读取声明提前降级。

## 原因码与可诊断性

### 原因码体系

3.1.1 只有 CONNACK 的 0~5 与 SUBACK 的 0x80；5.0 在**所有应答类报文**中携带 **1 字节原因码**（`< 0x80` 表示成功类，`≥ 0x80` 表示失败）。

| 原因码 | 名称 | 常见场景 |
| --- | --- | --- |
| `0x00` | 成功/正常断开/授予 QoS0 | 一切正常 |
| `0x01/0x02` | 授予 QoS1/QoS2 | SUBACK |
| `0x04` | 带遗嘱断开 | 客户端希望发布遗嘱的断开 |
| `0x10` | 无匹配订阅者 | PUBACK/PUBREC：消息被接收但无人订阅 |
| `0x11` | 订阅不存在 | UNSUBACK |
| `0x80` | 未指明错误 | 兜底 |
| `0x81/0x82` | 畸形报文 / 协议错误 | 解码/时序错误 |
| `0x84~0x86` | 不支持的协议版本 / 客户端 ID 无效 / 用户名密码错误 | CONNACK |
| `0x87` | **未授权** | ACL 拒绝 |
| `0x88/0x89` | 服务器不可用 / 服务器繁忙 | 过载保护 |
| `0x8A` | 被禁止 | 黑名单 |
| `0x8B` | 服务器关闭中 | 维护 |
| `0x8D` | **保活超时** | DISCONNECT（服务器通知） |
| `0x8E` | **会话被接管** | 同 ID 新连接顶掉旧连接 |
| `0x8F/0x90` | 主题过滤器无效 / 主题名无效 | SUBACK/PUBLISH |
| `0x91/0x92` | Packet ID 已被使用 / 未找到 | 状态机错误 |
| `0x93` | 超出接收最大值 | 违反流控 |
| `0x94` | 主题别名无效 | |
| `0x95` | **报文过大** | 超过最大报文大小 |
| `0x96` | 消息速率过高 | 限速 |
| `0x97` | **超出配额** | 订阅数/队列/连接数配额 |
| `0x98` | 管理员操作 | 运维踢人 |
| `0x99` | 载荷格式无效 | 声明 UTF-8 但不是 |
| `0x9A/0x9B` | 不支持保留消息 / 不支持该 QoS | 能力限制 |
| `0x9C/0x9D` | **使用其他服务器 / 服务器已迁移** | 重定向 |
| `0x9E` | 不支持共享订阅 | |
| `0x9F` | **连接速率过高** | 防重连风暴 |
| `0xA0` | 超出最大连接时间 | |
| `0xA1/0xA2` | 不支持订阅标识符 / 不支持通配符订阅 | |

（编号与名称请以规范为准，此处用于建立“失败可定位”的认知。）

### 服务器主动 DISCONNECT 与原因字符串

- 3.1.1：服务器出错只能**直接关 TCP**，客户端看到的是“连接被重置”，**完全不知道原因**（认证被撤销？被踢？限流？）；
- 5.0：服务器可以发送 **DISCONNECT（带原因码与可选的“原因字符串”）** 再关闭连接，客户端**据此决定重连策略**：

| 收到的原因码 | 客户端应做 |
| --- | --- |
| `0x8E` 会话被接管 | **不要立刻重连**（否则两端互踢循环），检查是否 ID 冲突 |
| `0x8A` 被禁止 / `0x87` 未授权 / `0x86` 认证失败 | 停止重连，上报/等待凭证更新 |
| `0x8C`/`0x89` 服务器繁忙、`0x9F` 连接速率过高 | **指数退避+抖动**后重连 |
| `0x9C/0x9D` 使用其他服务器 | 按 **Server Reference** 切换到新地址 |
| `0x95` 报文过大 | 修复发送逻辑，不是重连能解决的 |
| `0x97` 超出配额 | 减少订阅/并发，不要无脑重试 |

- **原因字符串**是**给人看的诊断信息**，不应被程序解析逻辑依赖；客户端可通过 `Request Problem Information=0` 要求不带诊断信息（省流量、避免泄露细节）。

## 会话、消息与遗嘱的生命周期控制

### 会话过期与 Clean Start

3.1.1 的 `Clean Session` 把“**连接时是否丢弃旧会话**”与“**断开后是否保留**”混在一起；5.0 拆开：

| 参数 | 作用 |
| --- | --- |
| **Clean Start**（连接标志位） | 连接时：1 = **丢弃**该客户端已有会话，从全新开始；0 = **恢复**已有会话（没有则新建） |
| **Session Expiry Interval**（属性，秒） | 连接断开后**会话保留多久**：0 = 断开即删（默认）；`0xFFFFFFFF` = 永不过期；其他 = 保留这么多秒 |

典型组合：

| 需求 | 设置 |
| --- | --- |
| 临时/无状态客户端 | Clean Start=1，Expiry=0 |
| 设备需要离线收指令（保留 1 天） | Clean Start=0，Expiry=86400 |
| 每次连接都重新开始，但允许短暂断线内恢复 | Clean Start=1，Expiry=N（连接时清空，断开后保留 N 秒） |

**价值**：Broker 可以**自动回收**长期不回来的会话（**根治僵尸会话**）；客户端也可以在 DISCONNECT 里**修改**过期间隔（比如“我下线了，保留 10 分钟”）；服务器可通过 CONNACK 调整过期值。

### 消息过期间隔

PUBLISH 的 **Message Expiry Interval**（秒）：消息在 Broker 队列里**超过该时间仍未投递就丢弃**；Broker 转发时会**扣除已等待的时间**。

- **指令类消息必须设置**：设备离线 3 天后上线，不应该执行 3 天前的“重启”命令；
- **保留消息**也可带过期，过期后自动清除；
- 无此属性则**永不过期**（受 Broker 自身队列策略限制）。

### 遗嘱延迟

- 遗嘱属性 **Will Delay Interval**（秒）：连接断开后，**延迟这么久才发布遗嘱**；若期间**客户端用同 ID 重连（会话恢复）**，**遗嘱取消**；
- 与会话过期的关系：遗嘱在“**延迟间隔到期**或**会话过期**”中**较早者**触发；
- **用途**：**抗网络抖动**。设备经过隧道、电梯，掉线几秒又上线，不应该触发“离线告警”；设置 `Will Delay=30s`，30 秒内回来就静默。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="会话过期与遗嘱延迟的时间线：设备在时间点 0 意外断线，保活超时后 Broker 判定断开；遗嘱延迟 30 秒内设备重连则遗嘱被取消；若 30 秒后仍未重连则发布遗嘱；会话在过期间隔 1 天后被清除，期间为离线设备排队 QoS1 消息，消息各自带过期间隔">
<line class="l" x1="40" y1="110" x2="720" y2="110" marker-end="url(#arr)"/>
<rect class="b4" x="40" y="86" width="12" height="48" rx="2"/>
<text class="ts" x="46" y="150" text-anchor="middle">t0 断线</text>
<rect class="b5" x="150" y="96" width="12" height="28" rx="2"/>
<text class="ts" x="156" y="150" text-anchor="middle">保活超时判定</text>
<rect class="b1" x="320" y="96" width="12" height="28" rx="2"/>
<text class="ts" x="326" y="150" text-anchor="middle">遗嘱延迟到期</text>
<rect class="b2" x="640" y="96" width="12" height="28" rx="2"/>
<text class="ts" x="646" y="150" text-anchor="middle">会话过期</text>
<rect class="bg" x="162" y="160" width="158" height="30" rx="6"/>
<text class="ts" x="241" y="175" text-anchor="middle" dominant-baseline="middle">遗嘱延迟窗口：重连则取消</text>
<rect class="bg" x="162" y="196" width="478" height="30" rx="6"/>
<text class="ts" x="401" y="211" text-anchor="middle" dominant-baseline="middle">会话保留期（Session Expiry）：为离线设备排队 QoS≥1 消息（各带消息过期间隔）</text>
<rect class="bg" x="20" y="240" width="720" height="50" rx="8"/>
<text class="ts" x="380" y="262" text-anchor="middle">结果：短抖动不报警；长离线才发布遗嘱；会话与排队消息自动回收；过期的指令不会在设备上线后被执行</text>
<text class="ts" x="380" y="282" text-anchor="middle">三个时间参数协同设计：Keep Alive（检测速度）· Will Delay（去抖）· Session/Message Expiry（资源与业务有效期）</text>
</svg>
<figcaption>图 2：保活、遗嘱延迟与会话过期的时间关系</figcaption>
</figure>

## 流控与资源保护

| 机制 | 说明 |
| --- | --- |
| **Receive Maximum** | 接收方声明**同时未确认的 QoS1/2 消息上限**（默认 65535）。发送方**不得超过**。服务器据此限制向慢设备的投递；设备据此限制给服务器的并发。违反返回 `0x93` |
| **Maximum Packet Size** | 任一方声明自己能接受的最大报文；对方**发送超限报文是错误**，接收方可断开（`0x95`）。**低内存设备必设**（如 MCU 只能处理 4KB） |
| **Topic Alias（主题别名）** | 发布时**先发一次完整主题+别名编号**，之后只发**空主题+别名**，把长主题压缩成 2 字节；**别名仅在当前连接有效**，上限由对方的 Topic Alias Maximum 决定 |
| **Server Keep Alive** | 服务器强制客户端使用的保活，便于**统一管理 NAT 与心跳开销** |
| **配额/限速原因码** | `0x96/0x97/0x9F` 让服务器能明确告知“你太快了/超配额” |

**主题别名的收益**：物联网主题常很长（`$company/prod/region/device/{id}/telemetry/temperature` 可达 60~100 字节），高频上报时**每条消息节省几十字节**；在 NB-IoT/LoRa 类按流量计费的链路上收益明显。注意：别名是**连接级状态**，重连后需重新建立；服务端转发给订阅者时是否保留别名由服务端决定（订阅者与服务端之间另有独立的别名协商）。

## 请求/响应模式

3.1.1 做“指令下发+应答”要靠约定（主题里编码 msgId、设备订阅 `reply` 主题）；5.0 把它标准化：

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="MQTT 5.0 请求响应模式：服务端向设备发布请求，携带响应主题和关联数据；设备处理后向请求中给出的响应主题发布响应，并回传相同的关联数据；服务端根据关联数据匹配请求与响应；服务端预先订阅响应主题，可使用共享订阅或带自身标识的主题；请求消息设置消息过期间隔，避免过期指令被执行">
<rect class="b3" x="20" y="14" width="190" height="44" rx="8"/>
<text class="tb" x="115" y="36" text-anchor="middle" dominant-baseline="middle">平台服务（请求方）</text>
<rect class="b1" x="290" y="14" width="180" height="44" rx="8"/>
<text class="tb" x="380" y="36" text-anchor="middle" dominant-baseline="middle">Broker</text>
<rect class="b2" x="550" y="14" width="190" height="44" rx="8"/>
<text class="tb" x="645" y="36" text-anchor="middle" dominant-baseline="middle">设备（响应方）</text>
<line class="ld" x1="115" y1="58" x2="115" y2="250"/>
<line class="ld" x1="380" y1="58" x2="380" y2="250"/>
<line class="ld" x1="645" y1="58" x2="645" y2="250"/>
<rect class="b5" x="20" y="72" width="190" height="26" rx="6"/>
<text class="ts" x="115" y="85" text-anchor="middle" dominant-baseline="middle">订阅 resp/platform-7/#</text>
<line class="l" x1="115" y1="120" x2="380" y2="132" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="132" x2="645" y2="146" marker-end="url(#arr)"/>
<text class="ta" x="380" y="112" text-anchor="middle">① PUBLISH dev/d1/cmd</text>
<text class="ts" x="380" y="170" text-anchor="middle">属性：Response Topic=resp/platform-7/d1</text>
<text class="ts" x="380" y="188" text-anchor="middle">Correlation Data=req-0042 · Message Expiry=30</text>
<line class="la" x1="645" y1="212" x2="380" y2="224" marker-end="url(#arr-a)"/>
<line class="la" x1="380" y1="224" x2="115" y2="236" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="204" text-anchor="middle">② PUBLISH resp/platform-7/d1（Correlation=req-0042）</text>
<rect class="bg" x="20" y="256" width="720" height="64" rx="8"/>
<text class="ts" x="380" y="278" text-anchor="middle">设备：从请求中取 Response Topic 与 Correlation Data，把结果发布到该主题并原样回传关联数据；请求方用关联数据匹配等待中的请求</text>
<text class="ts" x="380" y="300" text-anchor="middle">好处：应答主题与关联 ID 由协议字段表达，不必拼进主题名；请求带过期间隔，超时未被处理的指令自动失效</text>
</svg>
<figcaption>图 3：MQTT 5.0 的请求/响应模式</figcaption>
</figure>

要点：

- 请求方**预先订阅**自己的响应主题（含自身标识，避免多实例相互收到）；
- **关联数据**由请求方生成（唯一），设备**不解析、原样回传**；
- 请求设置 **Message Expiry**，响应方应在有效期内处理；超时由请求方自己判定失败；
- 这是 MQTT 上的**异步 RPC**，不是同步调用；请求方要有**超时与重试（幂等）**，见 [设备指令设计](#/iot/mqtt-practice)；
- Broker 可在 CONNACK 里通过 **Response Information** 给出推荐的响应主题前缀，帮助客户端遵循统一规范。

## 共享订阅与订阅选项

### 共享订阅（标准化）

`$share/<组名>/<主题过滤器>`：组内成员**分摊**消息；5.0 规范了语法与基本语义，**分发策略仍由 Broker 决定**（随机/轮询/哈希等），细节见 [QoS、会话与 Broker 语义](#/iot/mqtt-qos-session)。服务端通过 CONNACK 的 **Shared Subscription Available** 声明是否支持。

### 订阅选项（SUBSCRIBE 中每个过滤器的选项字节）

| 位 | 选项 | 说明与用途 |
| --- | --- | --- |
| bit0-1 | **最大 QoS** | 请求的最高 QoS（同 3.1.1） |
| bit2 | **No Local** | **订阅者不接收自己发布的消息**。解决“自己发布又被自己订阅收到”的回环（如网关双向桥接、同一客户端既发又收），3.1.1 需要业务层过滤。**共享订阅中不允许设为 1** |
| bit3 | **Retain As Published** | 1 = 转发时**保持**发布者设置的 RETAIN 位；0 = 清零（3.1.1 行为）。用于桥接/镜像场景，保证保留语义不丢 |
| bit4-5 | **Retain Handling** | **订阅建立时是否发送保留消息**：0 = 总是发送；1 = 仅当订阅是新建时发送（避免重连重订阅时重复收到）；2 = 不发送 |
| bit6-7 | 保留 | 必须为 0 |

**Retain Handling=1 的价值**：设备**重连后重新订阅**，3.1.1 下会再次收到全部保留消息（可能是大量历史状态，造成冲击/重复处理）；5.0 设为 1，则只有**全新订阅**才收保留消息。

### 订阅标识符与用户属性

- **订阅标识符（Subscription Identifier）**：SUBSCRIBE 时指定一个数字，Broker 在投递匹配消息时**带上命中订阅的标识符**，客户端据此**快速路由到处理逻辑**，不必再自己做主题匹配（尤其多个过滤器可能命中同一条消息时）；
- **用户属性（User Property）**：UTF-8 键值对，可多次出现，**随消息透传**。适合携带 **traceId、租户 ID、来源系统、业务类型**等元数据，而不污染载荷；注意**大小开销**与 Broker 是否转发、规则引擎是否可用这些属性。

## 增强认证

3.1.1 只有 CONNECT 里的用户名/密码（明文，依赖 TLS）；5.0 增加 **AUTH 报文**与 **Authentication Method / Authentication Data** 属性，支持**多轮挑战-响应认证**（如 SCRAM、Kerberos、OAuth 令牌交换）：

1. CONNECT 带 `Authentication Method`（如 `SCRAM-SHA-256`）与首轮数据；
2. 服务器回 **AUTH（原因码 0x18 继续认证）** 带挑战；
3. 客户端再发 AUTH 带响应；循环直至服务器回 **CONNACK 成功**；
4. 连接中还可发 **AUTH（0x19 重新认证）** **不断开连接地刷新凭证/令牌**（长连接设备令牌过期续期的标准做法）。

对物联网的意义：**避免长期静态密码**、支持**令牌过期续期**、与现有身份体系（OAuth/JWT）对接，见 [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)。落地时仍需 TLS 保护通道；**设备资源紧张时，复杂的多轮认证成本要评估**（很多场景用“TLS 客户端证书 + 用户名/令牌”已足够）。

## 服务端重定向与其他

- **Server Reference + 原因码 0x9C/0x9D**：服务器可通知客户端**改连另一台服务器**（负载均衡、集群迁移、扩缩容），无需 DNS 抖动；
- **Payload Format Indicator / Content Type**：声明载荷是 UTF-8 文本还是二进制、MIME 类型（`application/json`、`application/x-protobuf`），**消费者无需猜测格式**；
- **负向确认**：PUBACK/PUBREC 可返回失败原因码（如 `0x87` 未授权、`0x97` 超配额、`0x10` 无匹配订阅者），**发布者能知道消息为何没被接收/没人订阅**；
- **Topic Alias、Maximum QoS、Retain Available、Wildcard Subscription Available** 等能力协商，使客户端在受限 Broker 上也能正确降级；
- **订阅/取消订阅的原因码列表**：多过滤器的逐项结果更明确（含 `0x9E` 不支持共享订阅、`0xA2` 不支持通配符等）。

## 与 3.1.1 的差异汇总

| 方面 | 3.1.1 | 5.0 |
| --- | --- | --- |
| **扩展机制** | 无（靠厂商扩展/约定） | **属性**（含用户属性） |
| **返回/原因码** | CONNACK 0~5，SUBACK 0x80 | **全报文原因码** + 原因字符串 |
| **服务器通知断开原因** | 不可，直接断 TCP | **DISCONNECT 带原因码** |
| **会话控制** | Clean Session（保留多久由实现定） | **Clean Start + Session Expiry** |
| **消息过期** | 无 | **Message Expiry Interval** |
| **遗嘱** | 断连立即发布 | **Will Delay Interval** |
| **流控** | 无协商 | **Receive Maximum、Maximum Packet Size** |
| **主题压缩** | 无 | **Topic Alias** |
| **请求/响应** | 约定 | **Response Topic + Correlation Data** |
| **共享订阅** | 厂商扩展 | **标准** `$share` |
| **订阅选项** | 仅 QoS | **No Local、Retain As Published、Retain Handling、订阅标识符** |
| **认证** | 用户名/密码 | **增强认证（AUTH 报文）** |
| **服务端能力声明** | 无 | **CONNACK 声明能力与限制** |
| **报文复杂度/开销** | 更精简 | 属性带来少量额外字节与解析复杂度 |

## 迁移与落地建议

| 事项 | 建议 |
| --- | --- |
| **Broker** | 选择**同时支持 3.1.1 与 5.0**的 Broker（EMQX、HiveMQ、Mosquitto 2.x 等均支持），逐步切换；确认你用到的特性（共享订阅、规则引擎访问属性、桥接）对 5.0 的支持度 |
| **客户端库** | Java 的 Paho 有独立的 **MQTT v5 客户端**（包名区别于 v3 的 `org.eclipse.paho.client.mqttv3`），API 不兼容，需要改代码；HiveMQ Client 等原生支持 5.0；嵌入式 C 库（Paho Embedded、Eclipse Mosquitto client、NanoMQ、wolfMQTT 等）需确认版本支持 |
| **设备固件** | 存量设备多为 3.1.1，升级周期长；**新设备/新固件用 5.0**，Broker 兼容两者，平台侧**抽象协议差异**（例如统一的“会话过期”配置） |
| **优先采用的特性** | ① **会话过期**（根治僵尸会话）② **消息过期**（指令有效期）③ **原因码与服务端 DISCONNECT**（排障）④ **Will Delay**（去抖）⑤ **共享订阅**（后端扩展）⑥ **Receive Maximum / Max Packet Size**（保护弱设备与 Broker）⑦ **主题别名**（流量敏感链路）⑧ **请求/响应**（指令应答标准化） |
| **监控与日志** | 把原因码纳入日志与指标（断开原因分布：`0x8E` 被接管比例、`0x8D` 保活超时比例），定位问题更快 |
| **规则引擎与数据桥** | 确认能读取用户属性/响应主题等；转发到 Kafka 时决定属性如何映射（作为 header） |
| **测试** | 协议一致性测试 + 与不同厂商 Broker 互通测试；对**能力降级**路径（服务器不支持某特性）做测试 |
| **安全** | 5.0 的增强认证与重新认证需要在 Broker 与设备两端都支持；错误处理要防止原因字符串泄露内部信息 |

## 常见坑

| 坑 | 说明与对策 |
| --- | --- |
| **库 API 不兼容** | v3 与 v5 客户端不是同一套类；规划改造范围 |
| **会话过期默认为 0** | 5.0 默认**断开即删会话**；想要离线消息必须显式设置 Session Expiry 且 Clean Start=0 |
| **忽略 CONNACK 的能力声明** | 向不支持 QoS2/保留/共享订阅的服务器发请求被拒绝；读取并遵守声明 |
| **主题别名跨连接复用** | 别名仅当前连接有效；重连后要重新发送“主题+别名”建立 |
| **依赖原因字符串做逻辑** | 它是人读信息，不稳定；用原因码 |
| **No Local 与共享订阅冲突** | 共享订阅不能设 No Local；协议错误 |
| **属性过多导致报文膨胀** | 用户属性滥用占用带宽，窄带链路慎用 |
| **Retain Handling 误解** | 设为 2 会让设备永远收不到保留状态；按需求选择 0/1 |
| **服务器重定向循环** | 处理 `0x9C/0x9D` 要限制重定向次数与退避 |
| **混用版本导致规则/监控缺口** | 平台侧以统一抽象处理两种版本，避免 5.0 特性在 3.1.1 设备上“静默缺失” |

## 相关阅读

- [MQTT 协议详解](#/iot/mqtt)：5.0 增强的概览
- [MQTT 报文详解：从字节看协议](#/iot/mqtt-wire)：3.1.1 的报文结构（5.0 的基础）
- [QoS、会话与 Broker 语义](#/iot/mqtt-qos-session)：会话、遗嘱、共享订阅的实现语义
- [弱网、可靠性、安全与排障](#/iot/mqtt-practice)：指令设计、重连退避与安全
- [Broker 架构与集群（EMQX）](#/iot/broker)：Broker 对 5.0 特性的支持与容量
- [Java 接入：Paho、Spring 与 Netty](#/iot/java)：Java 客户端实践

## 面试追问

> [!QUESTION] MQTT 5.0 相比 3.1.1 有哪些重要改进？
> 引入属性机制作为扩展点，全报文原因码和服务端主动 DISCONNECT 带原因，会话过期与 Clean Start 拆分，消息过期和遗嘱延迟，Receive Maximum 与最大报文大小的流控，主题别名省流量，请求响应模式，标准化共享订阅，订阅选项如 No Local、Retain As Published、Retain Handling，增强认证和 CONNACK 能力声明。

> [!QUESTION] 5.0 的会话过期和 3.1.1 的 Clean Session 有什么区别？
> Clean Session 把连接时是否丢弃旧会话与断开后是否保留混在一起，保留多久由 Broker 实现决定。5.0 拆成 Clean Start 决定连接时是否清空，Session Expiry Interval 决定断开后保留多少秒，0 表示断开即删，最大值表示永不过期。这样可以自动回收僵尸会话，默认值是 0，想要离线消息必须显式设置。

> [!QUESTION] 遗嘱延迟解决了什么问题？
> 网络抖动时设备短暂掉线又很快重连，3.1.1 下遗嘱立即发布会产生离线再上线的告警抖动。设置 Will Delay Interval 后，断开后延迟一段时间才发布遗嘱，期间同一客户端重连则取消，长时间离线才发布，实现去抖。

> [!QUESTION] 5.0 里怎么做指令下发和应答？
> 用请求响应模式：请求方发布指令时在属性里带 Response Topic 和 Correlation Data，并设置 Message Expiry；设备处理后向响应主题发布结果，并原样回传关联数据；请求方预先订阅响应主题，用关联数据匹配请求。这是异步 RPC，仍需请求方做超时、重试和幂等。

> [!QUESTION] 主题别名有什么用？有什么限制？
> 把长主题在连接内映射成 2 字节的别名，首次发送完整主题和别名，之后只发别名，节省高频上报的流量。别名只在当前连接有效，重连需重新建立，数量受对方的 Topic Alias Maximum 限制。

> [!QUESTION] Retain Handling 选项有什么用？
> 控制订阅建立时是否发送保留消息：0 总是发送，1 仅在新建订阅时发送，2 不发送。设备重连后重新订阅时设为 1，可以避免每次重连都重复收到全部保留状态，造成冲击和重复处理。

> [!QUESTION] 把现有系统迁移到 MQTT 5.0 要注意什么？
> Broker 要同时支持两个版本，客户端库不兼容需改代码，存量设备固件升级周期长，所以平台侧兼容并存、新设备用 5.0。优先采用会话过期、消息过期、原因码、Will Delay、共享订阅和流控；规则引擎、监控和桥接要确认能处理属性与原因码，并测试服务器不支持某特性时的降级路径。
