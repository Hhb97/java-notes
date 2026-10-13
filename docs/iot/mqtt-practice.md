---
level: 深入
tags: [MQTT, 弱网, 保活, NAT, 重连退避, 指令可靠性, 幂等, 防重放, TLS, ACL, 安全, 抓包, 排障, 性能调优]
summary: MQTT 在真实物联网环境下的工程实践：弱网与蜂窝网络（NAT 老化、半开连接、保活间隔选择、重连退避与风暴、省电模式）、设备指令的应用层可靠性（msgId/ack/过期/幂等/状态机、离线策略、防重放）、上行数据的缓存与补传、载荷与吞吐调优、安全体系（TLS、认证方式、ACL 设计、防滥用、常见攻击）以及系统化排障（症状到原因、抓包与 Broker 追踪）。
---

# 弱网、可靠性、安全与排障：MQTT 工程实践

> [!ABSTRACT] 核心要点
> - 实验室里 MQTT 很稳，**生产里的问题 80% 来自“网络与设备的现实”**：蜂窝网络 NAT 会**悄悄回收空闲连接**，TCP **半开连接**让双方都不知道对方已死，设备休眠/信号切换造成**频繁重连**，海量设备同时重连形成**风暴**。对策是**保活间隔适配网络、快速发现断线、指数退避+抖动重连、会话与幂等兜底**。
> - **协议级 QoS 不等于业务可靠**：QoS1/2 只保证“Broker 收到/投递到对端协议栈”，**不保证设备执行了指令**。可靠的指令下发需要**应用层闭环**：**msgId + 应答（ack/result）+ 有效期（expireAt）+ 重试 + 设备端幂等 + 状态机**，并用**设备影子（期望/上报状态）**解决离线与最终一致，见 [IoT 平台架构与设备管理](#/iot/platform)。
> - **上行数据的可靠性**在设备侧解决：**本地缓存（断网时落盘/环形缓冲）+ 带时间戳与序号 + 恢复后批量补传 + 服务端按（设备, 序号/时间戳）去重**；不要指望 Broker 的离线队列替设备兜底上行。
> - **安全是默认项而不是选配**：**全程 TLS；每设备独立身份（证书/令牌）；ACL 按“设备只能发布/订阅自己的主题”最小授权；禁止设备使用宽泛通配订阅；连接/消息速率与报文大小限制；指令签名与防重放**。物联网设备数量大、物理暴露、固件难更新，**一个共享密码泄露 = 全网沦陷**。
> - 排障要**系统化**：先分层（设备/网络/Broker/服务端），再用**连接事件日志 + Broker 对单个客户端的追踪 + 抓包**还原时序；常见症状（连不上、频繁掉线、收不到、重复、延迟高、被踢）都有典型根因，见文末对照表。

## 弱网与连接保活

### 为什么连接会“悄悄死掉”

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="NAT 老化与半开连接：设备经蜂窝网络 NAT 访问 Broker；连接空闲超过 NAT 超时（常见几十秒到数分钟，不同运营商不同）后，NAT 映射被回收；之后设备发包到达的是无映射的新端口，Broker 回包被丢弃，双方的 TCP 都认为连接仍然存在，形成半开连接；设备发送的数据看似成功但对端收不到；只有保活心跳在 NAT 超时前刷新映射才能避免，或在应用层通过 PINGRESP 超时检测半开连接">
<rect class="b3" x="20" y="30" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">设备</text>
<text class="ts" x="80" y="72" text-anchor="middle">TCP 状态：已连接</text>
<rect class="b5" x="200" y="30" width="140" height="60" rx="8"/>
<text class="tb" x="270" y="52" text-anchor="middle" dominant-baseline="middle">运营商 NAT</text>
<text class="ts" x="270" y="72" text-anchor="middle">映射表（带空闲超时）</text>
<rect class="b1" x="420" y="30" width="140" height="60" rx="8"/>
<text class="tb" x="490" y="52" text-anchor="middle" dominant-baseline="middle">负载均衡/Broker</text>
<text class="ts" x="490" y="72" text-anchor="middle">TCP 状态：已连接</text>
<line class="l" x1="140" y1="60" x2="200" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="60" x2="420" y2="60" marker-end="url(#arr)"/>
<rect class="b4" x="580" y="30" width="160" height="60" rx="8"/>
<text class="tb" x="660" y="52" text-anchor="middle" dominant-baseline="middle">空闲超过 NAT 超时</text>
<text class="ts" x="660" y="72" text-anchor="middle">映射被静默删除</text>
<rect class="bg" x="20" y="108" width="720" height="110" rx="8"/>
<text class="th" x="32" y="128">后果：半开连接（Half-open）</text>
<text class="ts" x="380" y="152" text-anchor="middle">Broker 往设备发数据：经 NAT 找不到映射 → 被丢弃（没有 RST 返回，Broker 一直以为连着）</text>
<text class="ts" x="380" y="174" text-anchor="middle">设备往 Broker 发数据：NAT 分配新端口映射 → Broker 端 TCP 四元组对不上 → 被拒或丢弃</text>
<text class="ts" x="380" y="196" text-anchor="middle">两端都认为在线，但消息单向或双向不通——表现为“设备显示在线但收不到指令/数据不上报”</text>
<rect class="b2" x="20" y="234" width="350" height="94" rx="8"/>
<text class="th" x="32" y="254">预防：在 NAT 超时之前发活动</text>
<text class="ts" x="195" y="278" text-anchor="middle">Keep Alive 小于最短 NAT 超时（留余量）</text>
<text class="ts" x="195" y="298" text-anchor="middle">任何报文都会刷新映射；空闲时靠 PINGREQ</text>
<text class="ts" x="195" y="318" text-anchor="middle">Broker 可用 Server Keep Alive 统一下发（5.0）</text>
<rect class="b5" x="390" y="234" width="350" height="94" rx="8"/>
<text class="th" x="402" y="254">检测：不能只靠 TCP</text>
<text class="ts" x="565" y="278" text-anchor="middle">发出 PINGREQ 后在限定时间内必须收到 PINGRESP</text>
<text class="ts" x="565" y="298" text-anchor="middle">否则主动关闭并重连（检测半开）</text>
<text class="ts" x="565" y="318" text-anchor="middle">可叠加 TCP Keepalive / User Timeout 作辅助</text>
</svg>
<figcaption>图 1：NAT 老化与半开连接</figcaption>
</figure>

### 保活间隔怎么选

| 网络类型 | 空闲连接容忍度（经验） | Keep Alive 建议起点 | 说明 |
| --- | --- | --- | --- |
| **固定宽带/内网/Wi-Fi** | 长（数分钟~小时） | 60~120 秒 | 受家用路由器 NAT 影响，一般较宽松 |
| **4G/5G 蜂窝** | 因运营商而异，常见**几十秒到数分钟** | **30~120 秒**，取实测最短值的 1/2~2/3 | 不同运营商/地区/APN 的 NAT 超时不同，**要实测并留余量** |
| **NB-IoT/Cat-M（省电）** | 设备常处于 PSM/eDRX，网络侧也会释放连接 | 较长（分钟~小时），配合**周期性重连+持久会话** | 保活不是主要手段，通常**“唤醒→连接→收发→断开”** |
| **卫星/高延迟链路** | RTT 数百毫秒~数秒 | 较长保活 + 更大超时容忍 | 避免过短保活造成误判 |

经验原则：

- **保活 ≤ 最短 NAT 超时的 1/2**，并在**不同运营商、不同地区**抽样实测（可用“空闲 N 秒后发数据”的测试脚本二分查找 NAT 超时）；
- **保活越短 → 断线发现越快，但心跳流量与功耗越高**。粗估心跳月流量：`2 字节 PINGREQ + 2 字节 PINGRESP + TCP/IP 头与 ACK（每次交互约上百字节，TLS 下更多）`；**每 30 秒一次 ≈ 每月约 86,400 次**，按每次约 200 字节算 ≈ 17MB/月，对流量卡不是小数，需要权衡；
- **Broker 判定离线是 1.5×Keep Alive**，保活 60 秒意味着最长约 90 秒才发现静默掉线；对实时性要求高的场景配合**应用层状态上报/遗嘱**；
- 5.0 的 **Server Keep Alive** 让服务端按负载与网络统一调整，减少设备侧硬编码。

### 重连策略

| 要点 | 做法 |
| --- | --- |
| **指数退避 + 抖动** | 例如 `delay = min(cap, base × 2^n) × random(0.5~1.5)`：1s、2s、4s…上限 60s~数分钟；**抖动**避免大量设备同时重连（惊群） |
| **区分失败原因** | 网络错误→退避重连；认证失败/被拒绝（未授权、被禁止）→**停止重连并上报**；被接管（`0x8E`）→**不立即重连**，避免互踢；服务器繁忙/限速→更长退避，见 [MQTT 5.0 深入](#/iot/mqtt-v5) |
| **重连后的恢复** | 按 **Session Present** 决定是否重新订阅；重发未确认报文（库自动处理）；重新发布 `online` 状态；补传缓存数据 |
| **重连风暴** | Broker/网关重启或网络恢复时，百万设备同时重连：TLS 握手、认证、路由同步压垮服务；用**设备端抖动**、**服务端连接速率限制（返回 `0x9F`/拒绝）**、**分批放量**、**TLS 会话复用**、**多入口多地域分流**，见 [Broker 架构与集群（EMQX）](#/iot/broker) 的重连风暴章节 |
| **多地址/故障转移** | 配置多个 Broker 地址（DNS 轮询/多 A 记录/按优先级回退）；Server Reference 重定向；避免永远连一个故障节点 |
| **DNS 与证书** | 缓存 DNS 但不要无限期；证书过期、设备时间不准（无 RTC）会导致 TLS 失败，需处理时间同步 |

### 省电与低功耗模式

- **长连接 + 长保活**适合有电源的设备；**电池设备**更常用**“周期唤醒 → 建连/恢复会话 → 收发 → 断开”**，用**持久会话（Clean Session=0 / Session Expiry）**让 Broker 为其排队下行；
- **减少握手开销**：TLS 会话恢复（Session ID/Ticket）、TLS 1.3 的 0-RTT（有重放风险，慎用于指令类）、复用连接；
- **PSK（预共享密钥）TLS**：算力受限设备可用，省去证书与非对称计算，但密钥管理要严格；
- **批量与聚合上报**：攒一批数据一次发送，减少唤醒次数；
- **CoAP/UDP + DTLS** 在极端受限场景更省，但可靠性与生态不同，见 [协议生态与选型](#/iot/mqtt-ecosystem)。

## 设备指令的应用层可靠性

### 为什么 QoS 不够

QoS1/2 解决的是**协议传输层的投递**：Broker 收到、设备的 MQTT 栈收到。但：

- 设备 MQTT 栈收到 ≠ **业务线程已处理**（可能崩溃、队列满、校验失败）；
- QoS1 **会重复投递**，设备若未幂等会**重复执行**（重启两次、开阀两次）；
- 离线很久后上线，**过期的指令**被执行；
- Broker 有离线队列上限、重启丢失等**非协议保证**。

### 指令生命周期与状态机

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="设备指令的状态机与时序：平台创建指令记录并生成 msgId 和过期时间，状态为待下发；发布到设备命令主题后状态为已下发；设备收到后立即回复接收确认并检查是否已处理过该 msgId，幂等；设备执行完成后回复执行结果；平台状态变为已执行或失败；超时未收到确认则按策略重试，超过有效期则标记为过期；离线设备通过设备影子的期望状态在上线后同步">
<rect class="b3" x="20" y="30" width="110" height="56" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">PENDING</text>
<text class="ts" x="75" y="72" text-anchor="middle">已创建，待下发</text>
<rect class="b5" x="150" y="30" width="110" height="56" rx="8"/>
<text class="tb" x="205" y="52" text-anchor="middle" dominant-baseline="middle">SENT</text>
<text class="ts" x="205" y="72" text-anchor="middle">已发布到 Broker</text>
<rect class="b1" x="280" y="30" width="110" height="56" rx="8"/>
<text class="tb" x="335" y="52" text-anchor="middle" dominant-baseline="middle">DELIVERED</text>
<text class="ts" x="335" y="72" text-anchor="middle">设备已接收确认</text>
<rect class="b2" x="410" y="30" width="110" height="56" rx="8"/>
<text class="tb" x="465" y="52" text-anchor="middle" dominant-baseline="middle">EXECUTED</text>
<text class="ts" x="465" y="72" text-anchor="middle">执行成功+结果</text>
<rect class="b4" x="540" y="14" width="200" height="34" rx="8"/>
<text class="ts" x="640" y="31" text-anchor="middle" dominant-baseline="middle">FAILED：设备回报失败</text>
<rect class="b4" x="540" y="58" width="200" height="34" rx="8"/>
<text class="ts" x="640" y="75" text-anchor="middle" dominant-baseline="middle">EXPIRED：超过有效期</text>
<line class="l" x1="130" y1="58" x2="150" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="58" x2="280" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="58" x2="410" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="52" x2="540" y2="32" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="66" x2="540" y2="74" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="108" width="720" height="212" rx="8"/>
<text class="th" x="32" y="128">设计要点</text>
<text class="ts" x="380" y="154" text-anchor="middle">msgId：平台生成全局唯一指令 ID，放在载荷（或 5.0 的关联数据）里；设备按 msgId 做幂等（记录最近 N 条已处理 ID 或带 TTL 的缓存）</text>
<text class="ts" x="380" y="176" text-anchor="middle">两级应答：先快速回 ack（已收到、校验通过，表示“我接了”），执行完再回 result（成功/失败+数据）；长耗时指令不要卡住应答</text>
<text class="ts" x="380" y="198" text-anchor="middle">有效期：载荷带 expireAt（绝对时间，设备要有可信时间）或 ttl（相对）；5.0 同时用 Message Expiry；设备收到过期指令直接丢弃并回报</text>
<text class="ts" x="380" y="220" text-anchor="middle">平台超时与重试：ack 超时重发同一 msgId（幂等），有限次数 + 退避；仍无应答标记 TIMEOUT 并告警，不要无限重试</text>
<text class="ts" x="380" y="242" text-anchor="middle">离线策略：关键配置/期望状态走设备影子（上线后自动对账收敛）；一次性动作（重启）宜带短有效期，不应无限排队</text>
<text class="ts" x="380" y="264" text-anchor="middle">并发与顺序：同一设备的指令按序号串行（或声明可并发）；乱序到达时依据序号/版本丢弃过时指令</text>
<text class="ts" x="380" y="286" text-anchor="middle">防重放与篡改：指令带时间戳+随机数+签名（HMAC/非对称），设备验证；防止抓包重放“开锁”命令</text>
<text class="ta" x="380" y="308" text-anchor="middle">大数据（固件、日志）不要走 MQTT 指令通道：下发 URL + 校验和，设备用 HTTP 分段下载（OTA）</text>
</svg>
<figcaption>图 2：设备指令的状态机与可靠性设计</figcaption>
</figure>

```json
// 指令载荷示例（JSON，实际也可用 Protobuf/CBOR）
{
  "msgId": "cmd-20240115-8f3a",       // 全局唯一，设备据此幂等
  "seq": 1042,                         // 同一设备内单调递增，用于顺序与过时判断
  "type": "SET_THRESHOLD",
  "params": { "temp_max": 85 },
  "ts": 1705312800000,                 // 平台时间戳
  "ttl": 60,                           // 有效期 60 秒，过期丢弃
  "sig": "base64(HMAC-SHA256(key, msgId|seq|type|params|ts))"  // 签名防篡改/重放
}
```

### 期望状态（设备影子）与指令的取舍

| 场景 | 推荐 |
| --- | --- |
| **设置类**（阈值、开关、配置）：目标是让设备**最终处于某状态** | **设备影子 / 期望状态**：平台写 `desired`，设备上线或收到差量后收敛并上报 `reported`；天然幂等、离线友好、无需关心“是否执行过” |
| **动作类**（重启、抓拍、开阀）：一次性、有时效 | **指令 + ack/result + 有效期 + 幂等 + 重试** |
| **实时交互**（远程控制，需要秒级反馈） | 指令走在线通道，**不用离线排队**；超时即失败，由用户重试 |

详见 [IoT 平台架构与设备管理](#/iot/platform) 的设备影子与指令章节。

## 上行数据的可靠性

| 风险 | 对策 |
| --- | --- |
| **断网期间数据丢失** | 设备本地**环形缓冲/落盘队列**（容量按断网时长估算）；恢复后按时间顺序**批量补传**（限速，避免冲击） |
| **补传与实时数据混杂** | 每条数据带**设备采样时间**与**序号**；平台用设备时间做时序，用接收时间做审计；补传消息加标记（`backfill=true`） |
| **重复数据** | QoS1 重发与补传造成重复：服务端按（设备 ID, 序号 或 设备 ID + 采样时间）**幂等去重**（时序库按主键/时间戳覆盖写） |
| **时间不可信** | 设备无 RTC 或时间漂移：上线后与服务端校时（NTP/平台下发时间），数据同时带“相对启动时间”以便修正 |
| **QoS 选择** | 高频可丢遥测用 QoS0；重要事件（告警、计量）用 QoS1 + 设备端缓存确认；一般不需要 QoS2（可用 QoS1 + 服务端幂等替代，减少往返） |
| **背压与限流** | 设备按 Broker 允许的速率与 in-flight 上限发布；窗口满时本地排队；Broker 限速时指数退避 |
| **批量发布** | 将多个采样点合并成一条消息（数组载荷）：减少报文头开销与 TCP 往返，但要控制大小（不超过最大报文）与延迟 |

## 性能与吞吐调优

| 方向 | 要点 |
| --- | --- |
| **QoS 开销** | QoS0 无应答，最快；QoS1 每条一个 PUBACK；QoS2 四步。吞吐 ≈ 飞行窗口 / RTT，高延迟链路要加大窗口（`max_inflight`/Receive Maximum） |
| **载荷编码** | JSON 可读但冗余；**Protobuf/CBOR/MessagePack** 体积小很多；浮点用定点整数、字段名缩短；**压缩**（小报文压缩收益有限，批量大报文才划算） |
| **主题设计** | 层级清晰但**不要过长**（每条消息都带主题）；高频上报考虑 **Topic Alias**（5.0）；避免把设备 ID 与大量业务字段都塞主题 |
| **订阅扇出** | Broker 吞吐的头号变量：一条消息被多少会话订阅；设备**禁止订阅 `#`/`+/+/…`**；后端用**共享订阅**分摊而非每实例全量订阅 |
| **连接模型** | 一个设备一个连接；网关场景**一个连接承载多个子设备**（子设备身份在主题/载荷里）以节约连接，但要处理子设备级的认证与 ACL；后端服务端**少量连接 + 共享订阅 + 高并发处理**，而不是成百上千个连接 |
| **持久化与规则引擎** | 开启消息持久化、重规则、桥接 Kafka 会显著降低 Broker 吞吐，需要压测评估；重处理尽量异步化，见 [Broker 架构与集群（EMQX）](#/iot/broker) |
| **客户端线程模型** | 回调线程不能阻塞（Paho 回调里做耗时业务会堵塞网络线程，造成保活超时）；回调只入队，业务线程池消费，见 [Java 接入：Paho、Spring 与 Netty](#/iot/java) |
| **压测** | 用 `emqtt-bench`、JMeter MQTT 插件、自研 Netty 客户端模拟**连接数、发布速率、订阅扇出、重连风暴**；关注 CPU、内存、网络、文件句柄、延迟分位数与 Broker 的消息积压 |

## 安全

### 分层防护

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="MQTT 安全分层：传输层使用 TLS 加密与服务端证书校验，建议双向认证；身份层每个设备独立凭证，可用 X.509 证书、令牌或预共享密钥，避免共享密码；授权层按主题 ACL 最小授权，设备只能发布订阅自己的主题，禁止宽泛通配；限流层限制连接速率、消息速率、报文大小、订阅数；载荷层可对关键指令签名与加密；运营层包括证书与凭证轮换吊销、审计日志与异常检测">
<rect class="b3" x="20" y="14" width="720" height="44" rx="8"/>
<text class="tb" x="40" y="36" dominant-baseline="middle">传输层</text>
<text class="ts" x="130" y="36" dominant-baseline="middle">全程 TLS（建议 1.2+/1.3）；设备校验服务端证书（防中间人）；条件允许启用双向 TLS；禁用明文 1883 对公网开放</text>
<rect class="b5" x="20" y="64" width="720" height="44" rx="8"/>
<text class="tb" x="40" y="86" dominant-baseline="middle">身份层</text>
<text class="ts" x="130" y="86" dominant-baseline="middle">每设备独立身份：X.509 证书 / 一机一密令牌 / PSK；绝不全体设备共用一个用户名密码；ClientID 与身份绑定</text>
<rect class="b1" x="20" y="114" width="720" height="44" rx="8"/>
<text class="tb" x="40" y="136" dominant-baseline="middle">授权层</text>
<text class="ts" x="130" y="136" dominant-baseline="middle">主题 ACL 最小授权：只发布 dev/{自己ID}/up、只订阅 dev/{自己ID}/cmd；禁止 # 与 + 宽泛订阅</text>
<rect class="b4" x="20" y="164" width="720" height="44" rx="8"/>
<text class="tb" x="40" y="186" dominant-baseline="middle">限流层</text>
<text class="ts" x="130" y="186" dominant-baseline="middle">连接速率、消息速率、最大报文、订阅数、遗嘱大小、未认证连接超时；防 DoS 与滥用</text>
<rect class="b2" x="20" y="214" width="720" height="44" rx="8"/>
<text class="tb" x="40" y="236" dominant-baseline="middle">载荷层</text>
<text class="ts" x="130" y="236" dominant-baseline="middle">关键指令签名+防重放；敏感数据端到端加密（Broker 不可见）；固件签名校验</text>
<rect class="bg" x="20" y="264" width="720" height="66" rx="8"/>
<text class="tb" x="40" y="286" dominant-baseline="middle">运营层</text>
<text class="ts" x="130" y="286" dominant-baseline="middle">证书/凭证签发、轮换、吊销；审计日志；异常检测；密钥存安全元件/TEE</text>
<text class="ts" x="130" y="310" dominant-baseline="middle">设备被攻破/丢失的应急：吊销该设备身份，不影响其他设备</text>
</svg>
<figcaption>图 3：MQTT 物联网安全分层</figcaption>
</figure>

### 认证方式对比

| 方式 | 特点 | 风险与适用 |
| --- | --- | --- |
| **用户名/密码（共享）** | 简单 | **一个泄露全部沦陷**，不可用于生产设备群 |
| **一机一密（设备三元组）** | 每设备独立用户名+密钥/令牌，平台校验 | 常用；密钥需**安全存储**，传输必须 TLS；支持吊销 |
| **JWT/令牌（短期）** | 设备持有带过期的令牌，Broker 验签 | 好于长期密钥，可定期续期（5.0 重新认证）；需要签发服务与时钟 |
| **X.509 双向 TLS** | 设备证书即身份；CN/SAN 映射 ClientID | **最强**，抗中间人；需 PKI：签发、轮换、吊销、证书存储；设备时钟与算力要求 |
| **PSK-TLS** | 预共享密钥，省算力 | 适合受限设备；密钥分发与管理要严 |
| **外部认证（HTTP/数据库/LDAP）** | Broker 回调认证服务 | 灵活，注意**认证服务性能与可用性**（重连风暴时的压力）、缓存认证结果 |

证书与密钥管理见 [加密与密钥管理](#/security/crypto)，令牌与协议见 [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)。

### ACL 设计

```text
# 授权规则示例（语法因 Broker 而异；%c=ClientID，%u=用户名）
允许 用户 {设备}  发布  dev/%c/up/#
允许 用户 {设备}  订阅  dev/%c/cmd/#
拒绝 用户 {设备}  订阅  #        # 禁止通配订阅（防窃听他人数据）
拒绝 用户 {设备}  发布  $SYS/#   # 禁止伪造系统主题
允许 用户 {后端}  订阅  $share/backend/dev/+/up   # 后端以共享订阅消费
允许 用户 {后端}  发布  dev/+/cmd/#               # 后端下发指令
```

要点：

- **ClientID 与身份绑定**：ACL 用 `%c` 约束设备只能操作与自己 ID 对应的主题，**ClientID 必须与认证身份一致**（防止设备 A 冒用设备 B 的 ID 订阅其指令主题）；
- **缓存 ACL 决策**：每次发布/订阅都查外部 ACL 会拖垮性能，Broker 通常本地缓存；**权限变更要能快速生效**（吊销时踢掉连接）；
- **默认拒绝**：未匹配规则默认拒绝；
- **保留消息与遗嘱也要授权**：防止设备往他人主题发保留消息污染状态；限制遗嘱主题与大小；
- **网关/子设备**：网关代理多个子设备时，ACL 按“网关→所属子设备主题范围”授权。

### 防滥用与常见攻击

| 攻击/问题 | 对策 |
| --- | --- |
| **伪造设备/凭证泄露** | 一机一密、证书绑定；异常检测；快速吊销 |
| **ClientID 劫持踢人** | 认证身份与 ClientID 绑定；同 ID 接管只允许同一身份；接管事件告警 |
| **宽泛通配订阅窃听** | ACL 禁止；限制订阅数与过滤器深度 |
| **保留消息污染/垃圾** | 限制保留消息发布权限与大小；TTL |
| **连接/订阅耗尽（DoS）** | 未认证连接超时、连接速率限制、IP 限流、最大连接数、每客户端订阅数上限 |
| **超大报文攻击** | 最大报文大小；解码器校验剩余长度，见 [MQTT 报文详解](#/iot/mqtt-wire) |
| **指令重放** | 时间戳+随机数+签名；设备端维护已处理 msgId 窗口 |
| **弱 TLS 配置** | 禁用旧协议与弱套件；证书校验不可跳过（设备代码里常见“信任所有证书”的坑） |
| **日志泄露** | 日志不记录密码/令牌/敏感载荷；脱敏 |
| **WebSocket 入口** | MQTT over WebSocket 同样要 TLS（wss）、校验 Origin（浏览器场景）、限流 |
| **固件/凭证提取** | 密钥存安全元件，固件签名与加密，防回滚 |

## 排障

### 系统化流程

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="MQTT 排障流程：先确认症状和影响范围，是单设备还是批量；检查网络层是否可达，DNS、TCP、TLS 握手；检查连接层，是否收到 CONNACK 及原因，是否被踢，保活超时；检查订阅与授权，SUBACK 返回码和 ACL；检查消息层，QoS 降级、飞行窗口、离线队列；检查应用层，回调阻塞、幂等、解码；使用 Broker 对单客户端追踪与抓包还原时序">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 定范围</text>
<text class="ts" x="75" y="74" text-anchor="middle">单设备/批量</text>
<rect class="b5" x="145" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="52" text-anchor="middle" dominant-baseline="middle">② 网络层</text>
<text class="ts" x="200" y="74" text-anchor="middle">DNS·TCP·TLS</text>
<rect class="b1" x="270" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="52" text-anchor="middle" dominant-baseline="middle">③ 连接层</text>
<text class="ts" x="325" y="74" text-anchor="middle">CONNACK·断开原因</text>
<rect class="b4" x="395" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="450" y="52" text-anchor="middle" dominant-baseline="middle">④ 订阅授权</text>
<text class="ts" x="450" y="74" text-anchor="middle">SUBACK·ACL</text>
<rect class="b2" x="520" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="575" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 消息层</text>
<text class="ts" x="575" y="74" text-anchor="middle">QoS·窗口·队列</text>
<rect class="b3" x="645" y="30" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 应用层</text>
<text class="ts" x="692" y="74" text-anchor="middle">回调·幂等·解码</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="62" x2="270" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="62" x2="395" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="505" y1="62" x2="520" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="62" x2="645" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="720" height="204" rx="8"/>
<text class="th" x="32" y="136">工具与手段</text>
<text class="ts" x="380" y="162" text-anchor="middle">命令行：mosquitto_sub -h host -p 8883 --cafile ca.crt -t dev/# -v -d；MQTTX 等图形工具</text>
<text class="ts" x="380" y="184" text-anchor="middle">Broker 侧：对指定 ClientID 开启追踪日志（EMQX 的 client trace）、管理 API 查询连接/订阅/会话、$SYS 系统主题与 Prometheus 指标</text>
<text class="ts" x="380" y="206" text-anchor="middle">抓包：Wireshark `mqtt` 过滤器看报文序列；TLS 需要密钥日志才能解密；tcpdump 在设备/网关/LB 多点抓，对比两端是否一致</text>
<text class="ts" x="380" y="228" text-anchor="middle">设备侧日志：连接/断开事件、重连次数与原因、PINGRESP 延迟、飞行窗口使用率、本地缓存深度</text>
<text class="ts" x="380" y="250" text-anchor="middle">时间线还原：设备日志 + Broker 连接事件（connected/disconnected 及原因）+ 链路追踪 traceId，三者对齐时间</text>
<text class="ts" x="380" y="272" text-anchor="middle">对照实验：同一设备换网络/换 Broker 节点/换账号，缩小范围；用最小客户端复现，排除业务代码</text>
<text class="ta" x="380" y="302" text-anchor="middle">先看断开原因：Broker 的 disconnected 事件（keepalive_timeout、kicked、takeover…）直接指明方向</text>
</svg>
<figcaption>图 4：MQTT 排障的分层流程与工具</figcaption>
</figure>

### 症状 → 常见根因

| 症状 | 常见根因 | 排查与处理 |
| --- | --- | --- |
| **连不上（无 CONNACK/被拒）** | DNS/防火墙/安全组、TLS 证书不信任或过期、设备时间错误、协议版本不匹配、认证失败、ClientID 非法、Broker 连接数上限/限速 | 逐层：ping/telnet/openssl s_client 测 TLS；看 CONNACK 返回码或 5.0 原因码；Broker 认证日志 |
| **频繁掉线重连** | 保活大于 NAT 超时、信号差、回调线程阻塞导致保活超时、**ClientID 重复被互踢**、Broker 限速/过载断开、LB 空闲超时小于保活 | 看 Broker 断开原因；检查 ClientID 唯一性；调小保活；LB 的空闲超时要大于 1.5×保活 |
| **显示在线但收不到指令** | 半开连接；订阅丢失（Session Present=0 未重订阅）；ACL 拒绝订阅（SUBACK 0x80）；QoS 降级；设备回调阻塞；主题拼写/大小写 | 查 SUBACK；检查订阅表；抓包看下行是否到达设备；缩短保活并检测 PINGRESP |
| **消息重复** | QoS1 重发（预期行为）；应用层又叠加重试；设备重复订阅同一消息；共享/多个过滤器命中 | 业务幂等；去掉应用层对 MQTT 报文的重发；检查订阅过滤器重叠 |
| **消息丢失** | QoS0；Clean Session=1 重连丢飞行消息；离线队列满/过期；ACL 拒绝发布（QoS0 下无应答难发现）；Broker 重启未持久化；客户端发送缓冲满 | 关键数据用 QoS1+设备缓存；启用 5.0 原因码看发布失败；设备端发布返回值/回调要处理 |
| **延迟高** | 飞行窗口小+高 RTT；慢消费者积压；Broker 过载/规则引擎慢；订阅扇出大；回调线程阻塞；跨地域链路 | 看 Broker 队列与延迟指标；调大窗口；扩容；就近接入 |
| **被踢（takeover/kicked）** | 两个设备同 ClientID；服务端管理员/策略踢人；凭证撤销 | 唯一 ClientID（含设备序列号）；查事件原因；5.0 `0x8E`/`0x98` |
| **Broker 内存/磁盘持续增长** | 僵尸持久会话、离线队列无上限、保留消息堆积、慢消费者 | 会话过期、队列上限、消息 TTL、清理保留消息，见 [QoS、会话与 Broker 语义](#/iot/mqtt-qos-session) |
| **重启后大量连接失败/雪崩** | 重连风暴、TLS 握手 CPU 打满、认证后端扛不住 | 设备抖动、服务端限速、分批、认证缓存，见 [Broker 架构与集群（EMQX）](#/iot/broker) |
| **订阅成功但无消息** | 发布主题与过滤器不匹配（多层/通配）、`$` 主题通配规则、发布方 ACL 被拒、保留消息选项（Retain Handling） | 用宽松过滤器临时验证（仅测试）；检查主题大小写与层级 |
| **TLS 握手失败** | 证书链不全、CN/SAN 与域名不符、时间错误、套件/版本不匹配、SNI 缺失 | openssl s_client -connect；对比证书有效期；设备时间 |
| **日志里没有设备的断开记录** | 半开连接未被发现，Broker 仍在等超时 | 保活超时后才会出现；缩短保活或使用应用层心跳 |

## 检查清单

- [ ] Keep Alive 是否经运营商实测并小于最短 NAT 超时；是否有 PINGRESP 超时检测半开连接？
- [ ] 重连是否指数退避+抖动，是否按断开原因区分策略（认证失败不重连、被接管不立即重连）？
- [ ] 重连后是否按 Session Present 处理重订阅、重发与补传？
- [ ] 指令是否有 msgId、两级应答、有效期、设备幂等、平台超时重试，设置类是否用设备影子？
- [ ] 上行是否有设备本地缓存、序号/时间戳、补传与服务端去重？
- [ ] 回调线程是否不阻塞，业务处理是否异步？
- [ ] 是否全程 TLS，每设备独立身份，ACL 最小授权且禁止通配订阅，ClientID 与身份绑定？
- [ ] 是否有连接/消息速率、报文大小、订阅数限制，指令是否签名防重放？
- [ ] 是否有 Broker 对单客户端的追踪、断开原因日志、连接数与重连率监控？

## 相关阅读

- [MQTT 协议详解](#/iot/mqtt)：协议概念与基本用法
- [MQTT 报文详解：从字节看协议](#/iot/mqtt-wire)：抓包解读的基础
- [QoS、会话与 Broker 语义](#/iot/mqtt-qos-session)：会话、遗嘱与离线队列
- [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5)：原因码、会话与消息过期
- [Broker 架构与集群（EMQX）](#/iot/broker)：重连风暴、慢消费者与容量
- [IoT 平台架构与设备管理](#/iot/platform)：设备影子、指令与 OTA

## 面试追问

> [!QUESTION] 为什么设备显示在线却收不到指令？
> 常见是 NAT 空闲超时后映射被静默回收造成半开连接，双方 TCP 都认为连着；也可能是 Session Present 为 0 后没有重新订阅、ACL 拒绝订阅、QoS 降级或回调线程阻塞。要缩短保活到小于 NAT 超时、用 PINGRESP 超时检测半开、检查 SUBACK 和订阅表，并抓包确认下行是否到达设备。

> [!QUESTION] Keep Alive 应该设多大？
> 要小于所在网络最短的 NAT 空闲超时，通常取实测值的一半到三分之二，蜂窝网络常见在 30 到 120 秒之间，需分运营商实测。越短断线发现越快但心跳流量和功耗越高，Broker 在 1.5 倍保活时间后判定离线，所以最长约 1.5 倍保活才能发现静默掉线；省电设备更常用周期唤醒加持久会话。

> [!QUESTION] 设备重连应该怎么设计？
> 指数退避加随机抖动避免惊群，上限几十秒到几分钟；按原因区分，网络错误退避重连，认证失败或被禁止则停止并上报，被接管则不要立即重连避免互踢，服务器繁忙则更长退避；重连后按 Session Present 重新订阅、重发未确认报文并补传缓存数据；服务端配合连接速率限制和分批放量防重连风暴。

> [!QUESTION] 怎么保证设备指令可靠送达并只执行一次？
> QoS 只保证传输层投递，不保证执行。需要应用层闭环：平台生成唯一 msgId，设备先回 ack 再回执行结果，指令带有效期，平台超时按退避重试同一 msgId，设备按 msgId 幂等去重，同设备指令带序号处理乱序，关键指令签名防重放；设置类用设备影子的期望状态收敛，离线友好天然幂等。

> [!QUESTION] MQTT 的安全怎么做？
> 全程 TLS 并校验服务端证书，每个设备独立身份（证书、一机一密或短期令牌），绝不共用密码；ACL 按主题最小授权，ClientID 与身份绑定，禁止设备通配订阅；限制连接速率、消息速率、报文大小和订阅数；关键指令签名和防重放；证书与凭证可轮换可吊销，密钥存安全元件，并做审计和异常检测。

> [!QUESTION] MQTT 线上问题怎么系统化排查？
> 先定范围是单设备还是批量，再分层检查网络（DNS、TCP、TLS）、连接层（CONNACK 与断开原因）、订阅授权（SUBACK 与 ACL）、消息层（QoS 降级、飞行窗口、离线队列）和应用层（回调阻塞、幂等）。工具上用 Broker 对单客户端追踪与断开事件日志、Wireshark 的 mqtt 过滤器抓包、命令行客户端复现，并对齐设备日志、Broker 事件和链路追踪的时间线。
