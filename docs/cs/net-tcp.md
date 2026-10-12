---
level: 高级
tags: [计算机网络, TCP, 重传, RTO, SACK, Nagle, 延迟ACK, keepalive, RST, UDP, QUIC, WebSocket, 内核调优]
summary: 在已有 TCP 基础之上深入：丢包检测与重传机制（RTO、快速重传、SACK）、Nagle 与延迟 ACK 造成的 40ms 延迟、零窗口与缓冲区/BDP、keepalive 与应用层心跳的配合、RST 的各种来源与排查、UDP 与 QUIC/HTTP3 的取舍、WebSocket/SSE/长轮询、`ss -ti` 读数，以及一份后端服务的内核与应用参数调优清单。
---

# TCP 深入与 UDP/QUIC：重传、保活、RST 与内核调优

> [!ABSTRACT] 核心要点
> - 三次握手、四次挥手、TIME_WAIT、半/全连接队列、滑动窗口与拥塞控制见 [TCP/IP 与 HTTP(S)](#/infra/network)。本页补充**“出了问题怎么判断”**：**重传（RTO/快速重传/SACK）**、**Nagle×延迟 ACK 的 40ms**、**零窗口**、**keepalive**、**RST 的来源**。
> - TCP 靠**序号 + ACK + 超时重传**保证可靠：**三个重复 ACK 触发快速重传**（不等 RTO）；**超时重传按指数退避**，初始 RTO 约 200ms 起，连续丢包延迟会陡增到秒级——**“偶发 1s/3s/6s 超时”往往是 SYN 或数据包重传的指纹**。
> - **小包延迟**：Nagle 算法（攒小包）与**延迟 ACK**（等 40ms 再确认）相互等待，会让“写-写-读”型协议出现固定约 **40ms** 延迟；RPC/网络框架通常开启 **`TCP_NODELAY`**。
> - **keepalive 默认 2 小时才开始探测**，远大于 NAT/LB 的空闲超时（常为几分钟）；**长连接要同时配置 TCP keepalive 与应用层心跳**。
> - **RST（连接重置）**是“异常终止”的信号，常见来源：端口无监听、对端已关闭仍收到数据、防火墙/LB 空闲回收后收到数据、`SO_LINGER=0`、半连接队列溢出；**抓包看谁发的 RST** 是定位关键。
> - **UDP** 无连接、不可靠、低开销，适合 DNS、实时音视频与自定义可靠协议；**QUIC（HTTP/3）**在 UDP 上实现可靠、多路复用、TLS1.3 内置与连接迁移，规避 TCP 队头阻塞。

## 一、可靠传输：丢了怎么发现、怎么补

### 1. 序号、ACK 与累计确认

- 每个字节有**序号**，接收方回复**累计 ACK**（“我已收到序号 < N 的所有数据，下一个要 N”）；
- 发送方为每个已发未确认的段启动**重传定时器**；超时未被确认就重发；
- 接收方对乱序到达的数据先缓存，重复 ACK 同一个 N，提示发送方“N 还没到”。

### 2. 两种重传触发

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="重传机制：发送方连续发送段 1 到 5，其中段 2 丢失；接收方收到段 3 4 5 时反复回复 ACK 2 即重复 ACK；发送方收到三个重复 ACK 后立即快速重传段 2，不等超时；若没有后续数据产生重复 ACK，只能等重传超时 RTO 到期才重传，且 RTO 按指数退避翻倍；启用 SACK 时接收方在 ACK 中告知已收到的不连续区间，发送方只重传真正缺失的段">
<text class="th" x="20" y="24">快速重传（丢包后仍有后续数据）</text>
<rect class="b1" x="20" y="36" width="100" height="30" rx="6"/>
<text class="ts" x="70" y="51" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b3" x="680" y="36" width="100" height="30" rx="6"/>
<text class="ts" x="730" y="51" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="ld" x1="70" y1="66" x2="70" y2="230"/>
<line class="ld" x1="730" y1="66" x2="730" y2="230"/>
<line class="l" x1="70" y1="86" x2="730" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="400" y="80" text-anchor="middle">seq=1</text>
<line class="l" x1="70" y1="106" x2="420" y2="116"/>
<text class="ta" x="440" y="118" text-anchor="start">✗ seq=2 丢失</text>
<line class="l" x1="70" y1="126" x2="730" y2="126" marker-end="url(#arr)"/>
<text class="ts" x="560" y="120" text-anchor="middle">seq=3</text>
<line class="la" x1="730" y1="146" x2="70" y2="146" marker-end="url(#arr-a)"/>
<text class="ta" x="400" y="140" text-anchor="middle">ACK=2（重复 ①：我要 2）</text>
<line class="l" x1="70" y1="162" x2="730" y2="162" marker-end="url(#arr)"/>
<line class="la" x1="730" y1="178" x2="70" y2="178" marker-end="url(#arr-a)"/>
<text class="ta" x="400" y="172" text-anchor="middle">ACK=2（重复 ② ③）</text>
<line class="l" x1="70" y1="200" x2="730" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="400" y="194" text-anchor="middle">收到 3 个重复 ACK → 立即重传 seq=2（不等 RTO）</text>
<text class="ts" x="40" y="224" text-anchor="start">SACK：ACK 里附带“已收到 3~5”，发送方只重传缺的 2</text>
<rect class="bg" x="20" y="246" width="760" height="84" rx="10"/>
<text class="ts" x="36" y="270">• 超时重传：无后续数据（窗口小、尾部丢包）时只能等 RTO；Linux 下限约 200ms，每次翻倍 0.2→0.4→0.8s</text>
<text class="ts" x="36" y="290">• SYN 丢失：初始 RTO 1s，重试 1s/2s/4s…（tcp_syn_retries 默认 6）；偶发慢 1s/3s 常是 SYN 重传</text>
<text class="ts" x="36" y="310">• 丢包后拥塞窗口减半或降为 1，吞吐骤降；优化：BBR、多路径、QUIC</text>
</svg>
<figcaption>图 1：快速重传与超时重传</figcaption>
</figure>

| 机制 | 说明 |
| --- | --- |
| **超时重传（RTO）** | 定时器到期重传；**指数退避**；Linux 最小 RTO ≈ 200ms；`tcp_retries2`（默认 15）决定已建立连接最多重试多久后放弃（约 15 分钟量级） |
| **快速重传** | 收到 **3 个重复 ACK** 判定丢包，立即重传，不等 RTO |
| **SACK（选择确认）** | ACK 携带已收到的不连续区间，避免“回退 N 重传”重复发送已到达数据；现代系统默认开启 |
| **TLP（尾丢包探测）** | 在 RTO 之前对尾部丢包做一次探测，减少尾延迟（内核实现） |
| **DSACK** | 通知发送方“某段被重复接收”，帮助识别虚假重传 |
| **ECN** | 路由器标记拥塞而不丢包，端到端降速 |

## 二、小包延迟：Nagle 与延迟 ACK

- **Nagle 算法**：有未确认数据时，**小包先攒着**，等 ACK 回来或攒够一个 MSS 再发，减少“小包泛滥”；
- **延迟 ACK**：接收方收到数据不立即确认，**最多等约 40ms（Linux）**，指望捎带在回复数据里，或凑两个包一起确认；
- **两者相遇**：发送方连发两个小写（先写请求头、再写请求体）。第一个小包发出后，第二个小包因 Nagle 要等第一个的 ACK；而接收方因延迟 ACK 要等 40ms 才回 ACK → **固定约 40ms 的延迟**。表现：压测 RT 恰好在 40ms 上下、抓包看到“发一个小包 → 停顿 40ms → 再发”。

```java
// 解决：关闭 Nagle（对时延敏感的 RPC/缓存/数据库协议默认都应开启 TCP_NODELAY）
socket.setTcpNoDelay(true);
// Netty：.childOption(ChannelOption.TCP_NODELAY, true)；Redis/MySQL 驱动、gRPC、Dubbo 默认已开启
// 配合：应用层合并写（一次 write 发送完整消息，避免“写-写-读”），见 Netty 的 flush 策略
```

> [!NOTE] 取舍
> 关闭 Nagle 后小包更多、开销略增；对吞吐型大数据传输影响不大，对**低延迟请求-响应**收益明显。Netty 里“多次 `write` + 一次 `flush`”能合并写入，见 [Netty 实战](#/infra/netty-practice)。

## 三、窗口、缓冲区与零窗口

- **接收窗口（rwnd）** 由接收缓冲区剩余空间决定：应用 `read` 太慢 → 缓冲区满 → 通告**零窗口**，发送方暂停并定期发**零窗口探测**。表现：对端“发不动”，`ss -ti` 看到发送队列堆积、`rwnd` 为 0；
- **带宽时延积（BDP）= 带宽 × RTT**：要跑满长肥管道（如 1Gbps、RTT 100ms → BDP ≈ 12.5MB），窗口/缓冲区至少要有 BDP 那么大，否则吞吐被窗口限制；Linux 默认**自动调优**（`tcp_moderate_rcvbuf`），上限由 `net.ipv4.tcp_rmem/wmem` 第三个值决定；
- **拥塞控制算法**：默认 CUBIC（基于丢包）；**BBR**（基于带宽与 RTT 估计）在高丢包/高 RTT（跨洋、弱网）链路上吞吐明显更好；`sysctl net.ipv4.tcp_congestion_control=bbr`（需内核支持，先压测）；
- **慢启动重启**：连接空闲后再发数据，拥塞窗口会被重置为初始值（`tcp_slow_start_after_idle=1`），长连接“间歇性大响应”场景可考虑关闭；
- **队头阻塞**：TCP 把多个应用流映射成一条字节流，前面的段丢了，后面的数据即使到了也要等——HTTP/2 在 TCP 上多路复用仍受此影响，这是 QUIC 的动机之一。

## 四、保活：keepalive 与应用层心跳

### 1. TCP keepalive

连接空闲一段时间后，内核发送探测包，对端回 ACK 则连接正常；多次无应答则判定死亡并关闭。

| 内核参数 | 默认 | 含义 |
| --- | --- | --- |
| `net.ipv4.tcp_keepalive_time` | **7200 秒（2 小时）** | 空闲多久开始探测 |
| `net.ipv4.tcp_keepalive_intvl` | 75 秒 | 探测间隔 |
| `net.ipv4.tcp_keepalive_probes` | 9 | 失败次数 |

**默认约 2 小时 + 11 分钟才发现死连接**，远不足以应对 NAT/负载均衡的**空闲回收**（云 SLB/NAT 常见 **60 秒~15 分钟**）：中间设备悄悄删了连接表项，两端都不知道，下次发数据才收到 RST 或超时。

### 2. 与应用层心跳的配合

| 层面 | 作用 | 建议 |
| --- | --- | --- |
| **TCP keepalive**（`SO_KEEPALIVE`，应用开启后用内核参数或 socket 选项调整） | 保持中间设备连接表不过期；发现对端宕机/网络断开 | 间隔 **小于**最短的空闲超时（如 60 秒），Java 可通过 `-Djdk.net.ExtendedSocketOptions` / Netty `EpollChannelOption.TCP_KEEPIDLE` 等设置，或直接用应用层心跳 |
| **应用层心跳**（Ping/Pong，MQTT PINGREQ、gRPC keepalive PING、WebSocket ping） | 可检测“进程卡死但 TCP 仍通”（内核会替它回 ACK），并带业务语义 | 周期 15~60 秒 + 超时判断，见 [Netty 心跳](#/infra/netty)、[gRPC keepalive](#/mw/grpc)、[MQTT](#/iot/mqtt) |
| **连接池层面** | 取连接前校验/空闲回收 | HttpClient `evictIdleConnections`、HikariCP `keepaliveTime`/`maxLifetime`（略小于中间设备超时） |

**典型故障**：数据库连接池里的连接被防火墙在 10 分钟空闲后静默丢弃，业务低峰后第一个请求用到“死连接”→ 超时/`Connection reset`/`Communications link failure`。对策：连接池 `maxLifetime` < 中间设备超时，开启 `keepaliveTime`，配合重试。

## 五、RST：连接被重置

**RST 是 TCP 的“立即中止”**（对端收到后连接直接关闭，应用侧表现为 `Connection reset`/`Connection reset by peer`/`ECONNRESET`）。

| 来源场景 | 说明 | 排查 |
| --- | --- | --- |
| **目标端口无监听** | 对没有监听的端口发 SYN，内核回 RST → `Connection refused` | `ss -lntp`、服务是否启动/监听地址（127.0.0.1 vs 0.0.0.0） |
| **对端进程已关闭连接，本端继续发数据** | 对端 `close` 后又收到数据，回 RST | 检查两端关闭时机、连接池里的“僵尸连接” |
| **中间设备空闲回收后收到数据** | NAT/LB/防火墙删表项，之后到达的包被 RST 或静默丢弃 | 对比空闲时长与设备超时；keepalive/心跳 |
| **应用异常退出/崩溃** | 进程退出，内核对未关闭连接发 RST | 看进程日志/崩溃 |
| **`SO_LINGER` 设为 0 的 `close`** | 不走四次挥手，直接发 RST，丢弃发送缓冲区未发数据 | 排查代码/框架配置（有些场景为避免 TIME_WAIT 而误用） |
| **全连接/半连接队列溢出（`tcp_abort_on_overflow=1`）** | 队列满时回 RST 而非丢弃 | `netstat -s | grep -i overflow`，见 [TCP/IP 与 HTTP](#/infra/network) |
| **对端缓冲区未读完就 close**（Linux 下有未读数据时 close 会发 RST） | 如服务端读完请求前就关闭连接，客户端读响应时收到 RST，**响应丢失** | HTTP 服务器请求体未读完就返回错误并关闭，需“排空”请求体 |
| **防火墙/安全设备主动注入 RST** | IPS/GFW/中间盒策略 | 抓包看 RST 的 TTL、IP ID 是否与对端一致 |

**定位方法**：在两端同时抓包 `tcpdump -i any -nn 'tcp[tcpflags] & tcp-rst != 0'`，看**谁先发 RST**、RST 的 TTL/序号是否合理、RST 前的包是什么；对比客户端与服务端抓到的 RST，若只有一端有 → 中间设备注入。

## 六、UDP 与 QUIC

### 1. UDP

| 特性 | 说明 |
| --- | --- |
| 无连接、无握手 | 直接发，省 RTT；一个 socket 可与多个对端通信 |
| **不可靠、不保序、无拥塞控制/流控** | 丢了不重传、乱序不重排；需要应用层自己处理 |
| 保留消息边界 | 一次 send ≈ 一个数据报（TCP 是字节流，需处理粘包/拆包，见 [Netty 粘包拆包](#/infra/netty)） |
| 头部仅 8 字节 | 开销小 |
| 大小限制 | 避免超过 MTU（否则 IP 分片，见 [网络层与 MTU](#/cs/net-ip)），常用 ≤ 1200~1400 字节 |
| 典型应用 | **DNS、NTP、DHCP、syslog、SNMP**、实时音视频（WebRTC）、游戏、**QUIC/HTTP3**、服务发现广播、IoT（CoAP） |

自己基于 UDP 做可靠传输要实现：序号、ACK、重传、拥塞控制、流控——正是 **QUIC** 做的事。**UDP 需要注意的坑**：NAT 对 UDP 映射超时更短（需心跳保活）；部分网络对 UDP 限速/丢弃（QoS）；缺少拥塞控制会挤占带宽。

### 2. QUIC 与 HTTP/3

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="HTTP/2 over TCP 与 TLS 对比 HTTP/3 over QUIC：HTTP/2 需要 TCP 三次握手加 TLS 握手，多个流共享一条 TCP 连接，一个包丢失会阻塞所有流；QUIC 基于 UDP，把传输与 TLS 1.3 握手合并为 1 个 RTT（恢复时 0-RTT），每个流独立，丢包只影响所在的流，并且用连接 ID 标识连接，网络切换时无需重建连接">
<rect class="b4" x="20" y="30" width="370" height="150" rx="12"/>
<text class="th" x="36" y="54">HTTP/2 over TCP + TLS</text>
<text class="ts" x="36" y="80">握手：TCP 1 RTT + TLS 1.3 1 RTT ≈ 2 RTT</text>
<text class="ts" x="36" y="102">多路复用的多个流共用一条 TCP 字节流</text>
<text class="ts" x="36" y="124">一个包丢失 → 整条连接的所有流都等重传</text>
<text class="ts" x="36" y="146">（TCP 层队头阻塞）</text>
<text class="ts" x="36" y="168">连接按 四元组 标识：换网络（Wi-Fi→4G）必须重连</text>
<rect class="b2" x="410" y="30" width="370" height="150" rx="12"/>
<text class="th" x="426" y="54">HTTP/3 over QUIC（UDP）</text>
<text class="ts" x="426" y="80">握手：传输 + TLS 1.3 合并 ≈ 1 RTT（恢复 0-RTT）</text>
<text class="ts" x="426" y="102">每个流独立：丢包只阻塞所在流</text>
<text class="ts" x="426" y="124">用户态实现，迭代快；拥塞控制可插拔</text>
<text class="ts" x="426" y="146">连接 ID 标识连接 → 网络切换可迁移，不断连</text>
<text class="ts" x="426" y="168">强制加密（TLS 1.3 内置）</text>
<rect class="bg" x="20" y="200" width="760" height="84" rx="10"/>
<text class="ts" x="36" y="224">• 收益在弱网/移动/高丢包场景最明显；机房内网差距不大，且 UDP 处理在用户态 CPU 开销更高</text>
<text class="ts" x="36" y="244">• 部署：需要负载均衡/网关支持 UDP 443 与 QUIC；服务端通过 Alt-Svc 头告知客户端可升级到 HTTP/3；保留 TCP 回退</text>
<text class="ts" x="36" y="264">• 注意 0-RTT 的重放风险（只用于幂等请求）；企业网络可能拦截 UDP，需要回退到 HTTP/2</text>
</svg>
<figcaption>图 2：HTTP/2（TCP）与 HTTP/3（QUIC）的区别</figcaption>
</figure>

## 七、应用层长连接：WebSocket、SSE 与长轮询

| 方案 | 方向 | 机制 | 适用 | 注意 |
| --- | --- | --- | --- | --- |
| **长轮询** | 服务端“伪推送” | 请求挂起直到有数据或超时再返回 | 兼容性最好、简单 | 每次都是完整 HTTP 请求，开销大、延迟受限 |
| **SSE（Server-Sent Events）** | **服务端 → 客户端 单向** | 一个长 HTTP 响应（`text/event-stream`），自动重连与 `Last-Event-ID` | 通知、实时看板、**LLM 流式输出**（见 [LLM 应用](#/ai/llm)） | 单向；HTTP/1.1 下浏览器每域名连接数有限；代理需关闭缓冲 |
| **WebSocket** | **全双工** | HTTP `Upgrade` 握手（101 Switching Protocols）后切换为帧协议 | 聊天、协同、行情、游戏（见 [IM 案例](#/design/case-im)） | 要自己做心跳、重连、鉴权、背压；代理与 LB 要支持 Upgrade 与长超时 |

**WebSocket 握手与帧**：

```text
GET /chat HTTP/1.1
Host: example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
→ HTTP/1.1 101 Switching Protocols
   Sec-WebSocket-Accept: <由 Key 计算得到>
之后：2~14 字节头 + 载荷的二进制帧；有 Ping/Pong/Close 控制帧；客户端→服务端帧必须掩码（防缓存投毒）
```

工程要点：**Nginx 代理需要 `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"` 并调大 `proxy_read_timeout`**（见 [Nginx](#/infra/nginx)）；LB 空闲超时要大于心跳间隔；鉴权在握手阶段（令牌放 query 要注意日志泄露，见 [认证授权](#/security/auth)）；Origin 校验防跨站 WebSocket 劫持；连接数多时关注文件描述符与内存（见 [Netty](#/infra/netty-practice)）。

## 八、用 `ss -ti` 读懂一条连接

```bash
$ ss -tin dst 10.0.0.8:3306
ESTAB 0 0 10.0.0.5:51234 10.0.0.8:3306
   cubic wscale:7,7 rto:204 rtt:1.2/0.6 ato:40 mss:1448 pmtu:1500 rcvmss:1448
   cwnd:10 ssthresh:20 bytes_sent:45123 bytes_acked:45123 segs_out:312 segs_in:298
   retrans:0/3 lost:0 unacked:0 send 96Mbps pacing_rate 192Mbps delivery_rate 80Mbps rcv_space:14600
```

| 字段 | 含义 / 异常信号 |
| --- | --- |
| `Recv-Q / Send-Q`（第 2、3 列） | ESTAB：未被应用读取 / 未被对端确认的字节。**Send-Q 持续很大 → 对端处理慢/网络拥塞/零窗口**；**Recv-Q 很大 → 本端应用读得慢**。LISTEN 状态下 Recv-Q 是全连接队列当前长度、Send-Q 是上限 |
| `rto` | 当前重传超时（ms），远大于 200 说明发生过多次重传/RTT 大 |
| `rtt:均值/方差` | 往返时延；突增说明链路拥塞或对端卡顿 |
| `cwnd / ssthresh` | 拥塞窗口/慢启动阈值；cwnd 长期很小说明频繁丢包 |
| `retrans:当前/累计` | **重传次数**，累计持续增长 → 丢包链路 |
| `lost / unacked` | 判定丢失的段数 / 未确认段数 |
| `mss / pmtu` | 若 pmtu 异常小 → MTU 问题（见 [网络层与 MTU](#/cs/net-ip)） |
| `delivery_rate / send` | 实际传输速率估计 |
| 全局：`ss -s`、`netstat -s \| grep -i retrans` | 全机重传率；`nstat -az TcpRetransSegs` |

**重传率判断**：全局重传率 `TcpRetransSegs / TcpOutSegs` 持续 > 1% 就值得查（链路质量、拥塞、对端过载、队列溢出）。

## 九、调优清单（后端服务）

先说原则：**先用监控与抓包确认瓶颈，再改参数；默认值多数合理，盲目复制“万能内核参数”常适得其反**（例如 `tcp_tw_recycle` 已被移除，`tcp_tw_reuse` 仅对出站连接有意义）。

### 1. 内核参数（sysctl）

| 参数 | 常见调整 | 场景/说明 |
| --- | --- | --- |
| `net.core.somaxconn` | 提到 1024~65535 | 全连接队列上限（还要应用 `listen(backlog)`、Netty/Tomcat 的 `backlog`/`acceptCount`） |
| `net.ipv4.tcp_max_syn_backlog` | 提高 | 半连接队列；配合 `tcp_syncookies=1` 抵御 SYN Flood |
| `net.ipv4.ip_local_port_range` | `1024 65535` | 增加可用临时端口，缓解大量出站短连接端口耗尽 |
| `net.ipv4.tcp_tw_reuse` | `1` | 允许复用 TIME_WAIT 连接**用于出站**（需时间戳）；根本解决靠连接池/长连接 |
| `net.ipv4.tcp_fin_timeout` | 30 | FIN_WAIT_2 超时（并非 TIME_WAIT 时长，后者固定 60s） |
| `net.ipv4.tcp_rmem / tcp_wmem` | 调大第三个值 | 高 BDP 链路（跨机房/长肥管道）需要更大缓冲；内网通常默认即可 |
| `net.core.rmem_max / wmem_max` | 配合上面 | socket 缓冲上限 |
| `net.ipv4.tcp_congestion_control` | `bbr` | 跨地域/弱网/高丢包链路 |
| `net.ipv4.tcp_slow_start_after_idle` | `0` | 长连接间歇性突发传输 |
| `net.ipv4.tcp_keepalive_time` 等 | 如 600/30/5 | 配合 NAT/LB 空闲超时（或用应用层心跳） |
| `net.netfilter.nf_conntrack_max` | 提高 | NAT/容器节点，见 [网络层](#/cs/net-ip) |
| `fs.file-max` / `ulimit -n` | 提高 | 连接数上限的前提（见 [文件系统](#/cs/os-io)） |

### 2. 应用层

| 项 | 建议 |
| --- | --- |
| **连接池/长连接** | 复用连接，避免短连接风暴；设置 `maxLifetime`/空闲回收小于中间设备超时 |
| **超时** | 连接/读/写/请求总超时都要设置（见 [HTTP 客户端三种超时](#/infra/network)） |
| **TCP_NODELAY** | 请求-响应类协议开启 |
| **一次写完整消息** | 避免“写-写-读”，合并 flush |
| **Netty 水位线、`SO_BACKLOG`、`SO_REUSEPORT`** | 见 [Netty 实战](#/infra/netty-practice) |
| **重试与幂等** | 重传/超时都可能造成“成功但响应丢失”，写操作必须幂等 |
| **优雅关闭** | 先停止接收新连接、处理完在途请求再关，避免 RST（见 [发布策略](#/infra/release)） |

## 面试追问

> [!QUESTION] TCP 如何发现丢包并重传？快速重传与超时重传的区别？
> 发送方对已发未确认的段启动定时器，超时未被确认则重传，超时时间按 RTT 估算并指数退避；接收方对乱序数据重复回复同一个 ACK，发送方收到三个重复 ACK 就立即重传缺失段，不等超时。SACK 让 ACK 携带已收到的区间，只重传真正缺失的段。尾部丢包等没有后续数据时只能等超时，延迟更大。

> [!QUESTION] 为什么有的接口响应时间总是约 40ms？怎么解决？
> 典型是 Nagle 算法与延迟 ACK 相互等待：写-写-读的协议中，第二个小包因 Nagle 等第一个的 ACK，而接收方延迟 ACK 最多等 40ms。解决方法是开启 TCP_NODELAY，并让应用一次写出完整消息，Netty 里合并 write 后一次 flush。

> [!QUESTION] TCP keepalive 的默认参数有什么问题？长连接怎么保活？
> 默认空闲两小时才开始探测，远大于 NAT 和负载均衡常见的几分钟空闲回收，连接被悄悄删除后两端都不知道。应把保活间隔调到小于最短空闲超时，并配合应用层心跳，应用层心跳还能发现进程卡死但 TCP 仍通的情况，连接池也要设置最大存活时间和空闲检测。

> [!QUESTION] Connection reset by peer 可能是什么原因？怎么排查？
> 对端发来了 RST，常见于端口无监听、对端已关闭连接仍收到数据、NAT 或负载均衡空闲回收后收到数据、对方使用 SO_LINGER 为 0 关闭、队列溢出时配置了 abort、对端未读完数据就关闭，或中间设备注入。要在两端同时抓包，看谁先发 RST、TTL 与序号是否合理、RST 之前发生了什么。

> [!QUESTION] UDP 和 TCP 的区别？QUIC 为什么基于 UDP？
> TCP 面向连接、可靠有序、有流控和拥塞控制但有队头阻塞和握手开销；UDP 无连接、不可靠、保留消息边界、开销小。QUIC 在 UDP 之上用户态实现可靠传输、多路复用、拥塞控制和内置 TLS 1.3，握手合并只需一个 RTT，每个流独立避免队头阻塞，用连接 ID 支持网络切换不断连，基于 UDP 也避开了中间设备和内核对 TCP 的僵化。

> [!QUESTION] WebSocket、SSE、长轮询怎么选？
> 长轮询兼容性最好但开销大；SSE 是基于 HTTP 的服务端单向推送，自带重连，适合通知和 LLM 流式输出；WebSocket 全双工，适合聊天、协同和行情，但要自己处理心跳、重连、鉴权和背压，代理要支持 Upgrade 和较长超时。

> [!QUESTION] 线上发现重传率高，怎么排查？
> 先用 nstat 或 netstat -s 计算全局重传率，再用 ss -ti 看具体连接的 rtt、cwnd、retrans 和 Send-Q，判断是链路丢包、对端过载、队列溢出还是 MTU 问题；在两端抓包对比丢包发生的位置，检查网卡错误计数、交换机和安全设备，并结合拥塞控制算法或链路优化。
