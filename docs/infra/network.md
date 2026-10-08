---
level: 进阶
tags: [TCP, HTTP, HTTPS, TLS, TIME_WAIT, 连接池]
summary: 从 Java 后端视角吃透 TCP 握手挥手、连接队列、拥塞控制、HTTP/1.1~3 与 TLS，以及 HTTP 客户端连接池与超时的线上排查
---

# TCP/IP 与 HTTP(S)

> [!ABSTRACT] 核心要点
> - 三次握手是为了**双方都确认对方的初始序列号（ISN）**并防止历史连接误建立；四次挥手是因为 TCP 全双工，**被动方收到 FIN 后可能还有数据要发**，ACK 与 FIN 不能总是合并。
> - `TIME_WAIT` 出现在**主动关闭方**，持续 2MSL（Linux 固定 60s），是正常现象；大量 `CLOSE_WAIT` 才是 bug——几乎都是**应用没有 close 连接**。
> - 服务端有两个队列：SYN 半连接队列和 accept 全连接队列，后者上限是 `min(backlog, net.core.somaxconn)`；队列溢出会表现为「偶发连接超时 / 握手后被 RST」。
> - HTTP/2 用二进制帧 + 流解决了 HTTP 层队头阻塞，但 TCP 层队头阻塞仍在；HTTP/3 基于 QUIC（UDP）彻底解决，并支持连接迁移。
> - TLS 1.3 把握手压到 1-RTT，只保留具备前向安全的 (EC)DHE；Java 客户端调用的**三种超时**（取连接 / 建连 / 读）必须全部显式配置，连接池要定期清理空闲连接。

## 分层模型与数据封装

| TCP/IP 四层 | 对应 OSI | 典型协议 | 数据单元 | Java 视角 |
| --- | --- | --- | --- | --- |
| 应用层 | 应用/表示/会话 | HTTP、TLS、DNS、gRPC、Dubbo | 消息 | 业务代码、Feign、OkHttp |
| 传输层 | 传输 | TCP、UDP、QUIC(基于 UDP) | 段 Segment / 数据报 | `Socket`、`SocketChannel`、Netty |
| 网络层 | 网络 | IP、ICMP | 包 Packet | 路由、`ping`、MTU |
| 链路层 | 数据链路/物理 | Ethernet、ARP | 帧 Frame | 网卡、VLAN、容器 veth |

发送时每一层给上层数据加自己的头（封装），接收时逐层剥离：

```text
应用数据                                   [ HTTP 报文 ]
TCP 段      [TCP 头 20~60B][ HTTP 报文 ]                       ← 端口、seq、ack、窗口、标志位
IP 包       [IP 头 20B][TCP 头][ HTTP 报文 ]                   ← 源/目的 IP、TTL、协议号
以太网帧    [MAC 头 14B][IP 头][TCP 头][ HTTP 报文 ][FCS 4B]   ← 一帧 payload 上限 MTU=1500
```

- **MSS**（Maximum Segment Size）= MTU − IP 头 − TCP 头，以太网下通常 1460；握手时双方在 SYN 中通告。
- 隧道 / VPN / 容器 overlay 网络（VXLAN 额外约 50B）会缩小有效 MTU，出现「小请求正常、大响应卡死」时要怀疑 MTU 与 PMTU 发现被防火墙拦截（ICMP 被禁）。
- 一个 TCP 连接由**四元组**（源 IP、源端口、目的 IP、目的端口）唯一确定；客户端可用端口范围由 `net.ipv4.ip_local_port_range` 决定，这是「客户端端口耗尽」问题的根源。

## 三次握手与四次挥手

<figure class="fig">
<svg viewBox="0 0 720 520" class="dg" role="img" aria-label="TCP 三次握手与四次挥手时序及两端状态变迁">
<rect class="b1" x="60" y="20" width="160" height="40" rx="8"/>
<text class="tb" x="140" y="40" text-anchor="middle" dominant-baseline="middle">Client（主动方）</text>
<rect class="b2" x="500" y="20" width="160" height="40" rx="8"/>
<text class="tb" x="580" y="40" text-anchor="middle" dominant-baseline="middle">Server（被动方）</text>
<line class="ld" x1="140" y1="60" x2="140" y2="505"/>
<line class="ld" x1="580" y1="60" x2="580" y2="505"/>
<text class="th" x="360" y="84" text-anchor="middle">三次握手</text>
<text class="tm" x="128" y="92" text-anchor="end">CLOSED</text>
<text class="tm" x="592" y="92">LISTEN</text>
<line class="l" x1="140" y1="118" x2="576" y2="118" marker-end="url(#arr)"/>
<text class="ts" x="360" y="110" text-anchor="middle">① SYN, seq=x</text>
<text class="tm" x="128" y="122" text-anchor="end">SYN_SENT</text>
<line class="l" x1="580" y1="152" x2="144" y2="152" marker-end="url(#arr)"/>
<text class="ts" x="360" y="144" text-anchor="middle">② SYN+ACK, seq=y, ack=x+1</text>
<text class="tm" x="592" y="156">SYN_RCVD</text>
<line class="l" x1="140" y1="186" x2="576" y2="186" marker-end="url(#arr)"/>
<text class="ts" x="360" y="178" text-anchor="middle">③ ACK, ack=y+1（可携带数据）</text>
<text class="tm" x="128" y="190" text-anchor="end">ESTABLISHED</text>
<text class="tm" x="592" y="204">ESTABLISHED</text>
<text class="ts" x="360" y="226" text-anchor="middle">…… 双向数据传输 ……</text>
<text class="th" x="360" y="256" text-anchor="middle">四次挥手</text>
<line class="la" x1="140" y1="280" x2="576" y2="280" marker-end="url(#arr-a)"/>
<text class="ts" x="360" y="272" text-anchor="middle">④ FIN, seq=u（应用调用 close）</text>
<text class="tm" x="128" y="284" text-anchor="end">FIN_WAIT_1</text>
<line class="l" x1="580" y1="314" x2="144" y2="314" marker-end="url(#arr)"/>
<text class="ts" x="360" y="306" text-anchor="middle">⑤ ACK, ack=u+1</text>
<text class="tm" x="592" y="318">CLOSE_WAIT</text>
<text class="tm" x="128" y="330" text-anchor="end">FIN_WAIT_2</text>
<text class="ts" x="460" y="350" text-anchor="middle">被动方读到 EOF，发完剩余数据后应用 close()</text>
<line class="la" x1="580" y1="384" x2="144" y2="384" marker-end="url(#arr-a)"/>
<text class="ts" x="360" y="376" text-anchor="middle">⑥ FIN, seq=w</text>
<text class="tm" x="592" y="388">LAST_ACK</text>
<line class="l" x1="140" y1="418" x2="576" y2="418" marker-end="url(#arr)"/>
<text class="ts" x="360" y="410" text-anchor="middle">⑦ ACK, ack=w+1</text>
<text class="tm" x="128" y="422" text-anchor="end">TIME_WAIT</text>
<text class="tm" x="592" y="436">CLOSED</text>
<rect class="b3" x="134" y="428" width="12" height="62" rx="3"/>
<text class="ts" x="128" y="458" text-anchor="end">等待 2MSL</text>
<text class="tm" x="128" y="500" text-anchor="end">CLOSED</text>
</svg>
<figcaption>图 1：三次握手与四次挥手时序，左右两侧为各自的 TCP 状态</figcaption>
</figure>

### 为什么是三次，不是两次或四次

1. **同步双方 ISN**：每个方向都需要「我发 seq，对方 ack」一次确认。两次握手只能确认客户端的 ISN 被服务端收到，服务端的 ISN 没有被确认。第 2 步把「服务端的 SYN」和「对客户端 SYN 的 ACK」合并，所以是三次而不是四次。
2. **防止历史连接**：客户端早先发出的、在网络中滞留的旧 SYN 到达服务端时，如果两次握手就建立连接，服务端会白白分配资源；三次握手下客户端看到不匹配的 SYN+ACK 会回 RST。
3. **ISN 随机化**：ISN 基于时钟 + 四元组哈希生成，防止序列号预测攻击，也降低旧报文落入新连接窗口的概率。

### 为什么挥手是四次

TCP 是全双工的，FIN 只表示「我这个方向不再发数据」。被动方收到 FIN 时内核立刻回 ACK（⑤），但应用层可能还没读完、还有响应要发，**FIN（⑥）要等应用调用 `close()` 才发**。若被动方恰好也没有数据要发且开启了延迟确认，⑤⑥ 可能合并，抓包会看到「三次挥手」。

### TIME_WAIT 的作用

主动关闭方发出最后一个 ACK 后进入 `TIME_WAIT`，等待 2MSL：

- **保证最后的 ACK 能到达**：如果 ⑦ 丢了，被动方会重传 FIN，处于 TIME_WAIT 的一方还能再回 ACK；若直接 CLOSED，只能回 RST，对端会报错。
- **让旧连接的报文在网络中消亡**：避免同一四元组的新连接收到上一个连接的延迟报文。

Linux 中 `TIME_WAIT` 时长硬编码为 60s（`TCP_TIMEWAIT_LEN`），**不受** `tcp_fin_timeout` 控制——后者管的是孤儿连接的 `FIN_WAIT_2` 超时，这是最常见的误解之一。

## TIME_WAIT 与 CLOSE_WAIT 排查

```bash
# 按状态统计连接数（比 netstat 快得多）
ss -ant | awk 'NR>1{++s[$1]} END{for(k in s) print k, s[k]}'
ss -s                                   # 汇总：estab / timewait / orphan
# 看 CLOSE_WAIT 都连向哪个对端
ss -ant state close-wait | awk '{print $4}' | sort | uniq -c | sort -rn | head
```

| 现象 | 出现在哪端 | 典型原因 | 处理 |
| --- | --- | --- | --- |
| 大量 `TIME_WAIT` | 主动关闭方 | 短连接；服务端主动关闭（如 HTTP/1.0、`Connection: close`）；客户端没有用连接池 | 改长连接 / 连接池；客户端可开 `net.ipv4.tcp_tw_reuse=1`（需开启 timestamps，仅对**出站**连接有效）；调大 `ip_local_port_range` |
| 大量 `CLOSE_WAIT` | 被动关闭方 | 对端已关闭，**本端应用没有调用 close**：响应流未关闭、连接未归还连接池、线程阻塞在别处根本走不到 close | 修代码，用 try-with-resources；`jstack` 看处理线程卡在哪 |
| 大量 `FIN_WAIT_2` | 主动关闭方 | 对端一直处于 CLOSE_WAIT 不发 FIN | 根因在对端；`tcp_fin_timeout` 只能兜底孤儿连接 |
| 大量 `SYN_RECV` | 服务端 | SYN Flood 或 accept 慢、客户端 ACK 丢失 | 开 `tcp_syncookies`，查 accept 队列 |

> [!WARNING] 不要再用 tcp_tw_recycle
> `net.ipv4.tcp_tw_recycle` 在 NAT 环境下（多个客户端共用出口 IP、时间戳不单调）会导致 SYN 被静默丢弃，表现为部分用户随机连不上。该参数已在 Linux 4.12 移除，看到旧文章推荐它直接忽略。

> [!TIP] Java 中 CLOSE_WAIT 的高发场景
> - Apache HttpClient 拿到 `CloseableHttpResponse` 后没有 `EntityUtils.consume()` / `close()`，连接既不归还池，也不关闭。
> - 下游服务关闭了空闲长连接，而本端连接池里的连接长期没人用，也没有空闲检测，一直挂在 CLOSE_WAIT 直到下次被取出才发现。
> - 自己写的 `Socket` / `InputStream` 在异常分支上没关。

## 半连接队列与全连接队列

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="服务端内核 SYN 半连接队列与 accept 全连接队列，应用通过 accept 从全连接队列取出连接">
<rect class="b1" x="20" y="100" width="110" height="48" rx="8"/>
<text class="tb" x="75" y="124" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="bg" x="170" y="16" width="370" height="230" rx="12"/>
<text class="ts" x="186" y="36">Server 内核（某个 LISTEN socket）</text>
<rect class="b3" x="200" y="52" width="310" height="62" rx="8"/>
<text class="tb" x="355" y="72" text-anchor="middle" dominant-baseline="middle">半连接队列 SYN Queue</text>
<text class="ts" x="355" y="96" text-anchor="middle">SYN_RCVD；上限与 tcp_max_syn_backlog 相关</text>
<rect class="b2" x="200" y="160" width="310" height="62" rx="8"/>
<text class="tb" x="355" y="180" text-anchor="middle" dominant-baseline="middle">全连接队列 Accept Queue</text>
<text class="ts" x="355" y="204" text-anchor="middle">ESTABLISHED；上限 min(backlog, somaxconn)</text>
<line class="l" x1="130" y1="112" x2="198" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="150" y="84" text-anchor="middle">① SYN</text>
<line class="l" x1="130" y1="136" x2="198" y2="186" marker-end="url(#arr)"/>
<text class="ts" x="140" y="178" text-anchor="middle">③ ACK</text>
<line class="la" x1="355" y1="114" x2="355" y2="158" marker-end="url(#arr-a)"/>
<text class="ts" x="365" y="140">收到 ③ 后移入</text>
<rect class="b5" x="580" y="160" width="120" height="62" rx="8"/>
<text class="tb" x="640" y="180" text-anchor="middle" dominant-baseline="middle">应用 accept()</text>
<text class="ts" x="640" y="204" text-anchor="middle">Tomcat / Netty Boss</text>
<line class="l" x1="510" y1="191" x2="578" y2="191" marker-end="url(#arr)"/>
<text class="ts" x="20" y="266">SYN 队列满：丢弃 SYN（开启 tcp_syncookies 时改用 cookie 不入队）</text>
<text class="ts" x="20" y="283">accept 队列满：默认丢弃 ③ 的 ACK 让客户端重传；tcp_abort_on_overflow=1 时直接回 RST</text>
</svg>
<figcaption>图 2：两个队列与 accept()，应用取得慢就会让全连接队列溢出</figcaption>
</figure>

| 参数 | 含义 | 默认值 | 建议 |
| --- | --- | --- | --- |
| `listen(fd, backlog)` | 应用传入的全连接队列长度 | Java `ServerSocket` 50；Tomcat `acceptCount` 100；Netty `SO_BACKLOG` 默认读取 somaxconn | 高并发入口调到 1024 以上 |
| `net.core.somaxconn` | 全连接队列的系统上限 | 内核 5.4 前 128，之后 4096 | 与 backlog 一起调大，**两者取小** |
| `net.ipv4.tcp_max_syn_backlog` | 半连接队列相关上限 | 与内存有关，常见 128～1024+ | 抗突发可调大 |
| `net.ipv4.tcp_syncookies` | SYN 队列满时启用 cookie | 1 | 保持开启 |
| `net.ipv4.tcp_abort_on_overflow` | 全连接队列满时是否回 RST | 0 | 一般保持 0，让客户端重传 |

排查队列溢出：

```bash
ss -lnt 'sport = :8080'
# State  Recv-Q  Send-Q  Local Address:Port
# LISTEN 101     100     *:8080          ← LISTEN 状态下 Recv-Q=当前队列长度，Send-Q=队列上限，已满
netstat -s | grep -iE 'listen|overflow'
# 1234 times the listen queue of a socket overflowed   ← 持续增长说明在溢出
# 1234 SYNs to LISTEN sockets dropped
```

> [!NOTE] 队列溢出的根因通常不在内核
> accept 队列满说明应用 accept 不过来：Tomcat 的连接数达到 `maxConnections`（NIO 默认 8192）后 Acceptor 会停止 accept；或者 JVM 处于长时间 Full GC / STW。只调大 backlog 是延后症状，要同时看线程池、GC 和下游耗时。

## 可靠传输：滑动窗口与拥塞控制

### 滑动窗口（流量控制）

- 接收方在每个 ACK 中通告**接收窗口 rwnd**（接收缓冲区剩余空间），发送方在途未确认数据不能超过它。窗口字段 16 位，靠握手时协商的 **Window Scale** 选项放大，最大约 1GB。
- 接收方应用读得慢（比如 Java 线程迟迟不 `read`），rwnd 会降到 0（**零窗口**），发送方停止发送并周期性发送窗口探测。抓包看到 `TCP ZeroWindow` 说明**对端应用消费慢**，而不是网络慢。
- 实际发送窗口 = `min(rwnd, cwnd)`。

### 拥塞控制（网络容量）

| 阶段 | 触发 | cwnd 变化 |
| --- | --- | --- |
| 慢启动 | 新连接 / 超时重传后 | 每收到一个 ACK cwnd+1 MSS，即每个 RTT 翻倍；Linux 初始窗口 10 MSS（IW10） |
| 拥塞避免 | cwnd ≥ ssthresh | 每个 RTT 约 +1 MSS，线性增长 |
| 超时重传（RTO） | 很久收不到 ACK | ssthresh = cwnd/2，cwnd 回到初始值重新慢启动，代价最大 |
| 快重传 | 收到 3 个重复 ACK | 不等超时，立即重传丢失段 |
| 快恢复 | 快重传之后 | ssthresh = cwnd/2，cwnd ≈ ssthresh，直接进入拥塞避免 |

Linux 默认拥塞算法是 **CUBIC**（基于丢包，cwnd 按三次函数增长）；**BBR** 基于带宽和 RTT 估计，在有随机丢包的长肥管道（跨国、跨云）上吞吐明显更好：`sysctl net.ipv4.tcp_congestion_control=bbr`。

对 Java 服务的影响：**短连接每次都要从慢启动开始**，大响应在新连接上需要好几个 RTT 才能「跑满」。这也是连接池、HTTP keep-alive 带来的不止是省握手。

### Nagle 算法与延迟确认

- **Nagle**：若有已发送但未确认的数据，小包（小于 MSS）先攒着，等 ACK 回来再发。目的是减少小包。
- **延迟确认（Delayed ACK）**：接收方不立即 ACK，等一会儿（Linux 最长约 40ms）看能不能和响应数据捎带。
- 两者叠加：客户端「写头 → 写体」两次小写，第二次写被 Nagle 卡住等 ACK，服务端在等完整请求不发响应，ACK 又被延迟 → **每个请求固定多出约 40ms**。
- 解决：RPC / 交互式场景设置 `TCP_NODELAY`。`socket.setTcpNoDelay(true)`；Netty 默认已开启 `TCP_NODELAY`；Tomcat 默认 `tcpNoDelay=true`。更根本的是**合并写**（一次 write 发完整个报文）。

### TCP keepalive vs HTTP keep-alive

| | TCP keepalive | HTTP keep-alive（持久连接） |
| --- | --- | --- |
| 层次 | 传输层，内核实现 | 应用层协议语义 |
| 作用 | 探测空闲连接对端是否还活着 | 一个 TCP 连接上复用多个 HTTP 请求 |
| 开启 | `SO_KEEPALIVE` | HTTP/1.1 默认开启，`Connection: close` 关闭 |
| 参数 | `tcp_keepalive_time` 默认 7200s，`intvl` 75s，`probes` 9 | 服务端空闲超时：Nginx `keepalive_timeout` 默认 75s；Tomcat `keepAliveTimeout` 默认等于 `connectionTimeout`（官方 server.xml 示例为 20s），Spring Boot 可用 `server.tomcat.keep-alive-timeout` 设置 |

默认 2 小时的 TCP keepalive 基本发现不了「中间设备（NAT、防火墙、LB）静默丢弃空闲连接」的问题，所以 RPC 框架都在应用层做心跳（见 [IO 模型与 Netty](#/infra/netty)）。JDK 11+ 可通过 `jdk.net.ExtendedSocketOptions` 的 `TCP_KEEPIDLE` / `TCP_KEEPINTERVAL` / `TCP_KEEPCOUNT` 按连接设置（平台相关）。

## HTTP/1.1、HTTP/2 与 HTTP/3

| 维度 | HTTP/1.1 | HTTP/2 | HTTP/3 |
| --- | --- | --- | --- |
| 传输 | TCP | TCP（实践中基本都基于 TLS） | QUIC（UDP 之上，内置 TLS 1.3） |
| 报文格式 | 文本 | 二进制帧（HEADERS / DATA 等），带 Stream ID | 二进制帧，流由 QUIC 原生提供 |
| 并发 | 一个连接同时只能一个请求在途（pipelining 基本没人用），浏览器对同域开约 6 个连接 | **多路复用**：一个连接上多个流交错传输 | 多路复用，且流之间互不阻塞 |
| 队头阻塞 | HTTP 层 + TCP 层 | 解决 HTTP 层；**TCP 丢一个包所有流都等** | 彻底解决（丢包只影响所在流） |
| 头部压缩 | 无 | **HPACK**：静态表（61 项常用头）+ 动态表 + Huffman 编码 | QPACK（适配乱序到达） |
| 建连 | TCP 1-RTT + TLS 1~2 RTT | 同左，ALPN 协商 `h2` | 首次 1-RTT，恢复可 0-RTT |
| 连接迁移 | 无（四元组变就断） | 无 | 有：用 Connection ID 标识连接，Wi-Fi 切 4G 不断 |

Java 生态要点：

- **gRPC 跑在 HTTP/2 上**，一个长连接承载大量并发调用；在 K8s 中经 ClusterIP（四层）负载会出现「连接粘在一个 Pod 上」的不均衡问题，需要客户端负载均衡或七层代理。
- Spring Boot 开启 HTTP/2：`server.http2.enabled=true`（需 TLS；明文 h2c 仅部分容器支持）。JDK 11+ 自带的 `java.net.http.HttpClient` 原生支持 HTTP/2。
- HTTP/2 Server Push 实践效果差，主流浏览器已移除支持，不要再当作优势来讲。

## HTTPS 与 TLS

<figure class="fig">
<svg viewBox="0 0 740 360" class="dg" role="img" aria-label="TLS 1.2 需要两个往返才能发送应用数据，TLS 1.3 在 ClientHello 中携带密钥份额只需一个往返">
<text class="th" x="180" y="20" text-anchor="middle">TLS 1.2（ECDHE，2-RTT）</text>
<text class="th" x="560" y="20" text-anchor="middle">TLS 1.3（1-RTT）</text>
<line class="ld" x1="370" y1="10" x2="370" y2="350"/>
<rect class="b1" x="15" y="34" width="90" height="32" rx="6"/>
<text class="tb" x="60" y="50" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b2" x="255" y="34" width="90" height="32" rx="6"/>
<text class="tb" x="300" y="50" text-anchor="middle" dominant-baseline="middle">Server</text>
<line class="ld" x1="60" y1="66" x2="60" y2="310"/>
<line class="ld" x1="300" y1="66" x2="300" y2="310"/>
<line class="l" x1="60" y1="100" x2="296" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="180" y="92" text-anchor="middle">ClientHello（随机数、套件列表）</text>
<line class="l" x1="300" y1="150" x2="64" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="180" y="128" text-anchor="middle">ServerHello, Certificate</text>
<text class="ts" x="180" y="142" text-anchor="middle">ServerKeyExchange, HelloDone</text>
<line class="l" x1="60" y1="200" x2="296" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="180" y="178" text-anchor="middle">ClientKeyExchange</text>
<text class="ts" x="180" y="192" text-anchor="middle">ChangeCipherSpec, Finished</text>
<line class="l" x1="300" y1="240" x2="64" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="180" y="232" text-anchor="middle">ChangeCipherSpec, Finished</text>
<line class="la" x1="60" y1="285" x2="296" y2="285" marker-end="url(#arr-a)"/>
<text class="ts" x="180" y="277" text-anchor="middle">应用数据（已加密）</text>
<text class="ts" x="180" y="335" text-anchor="middle">第 2 个 RTT 结束后才能发应用数据</text>
<rect class="b1" x="395" y="34" width="90" height="32" rx="6"/>
<text class="tb" x="440" y="50" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b2" x="635" y="34" width="90" height="32" rx="6"/>
<text class="tb" x="680" y="50" text-anchor="middle" dominant-baseline="middle">Server</text>
<line class="ld" x1="440" y1="66" x2="440" y2="310"/>
<line class="ld" x1="680" y1="66" x2="680" y2="310"/>
<line class="l" x1="440" y1="100" x2="676" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="560" y="78" text-anchor="middle">ClientHello</text>
<text class="ts" x="560" y="92" text-anchor="middle">+ key_share（ECDHE 公钥）</text>
<line class="l" x1="680" y1="150" x2="444" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="560" y="128" text-anchor="middle">ServerHello + key_share</text>
<text class="ts" x="560" y="142" text-anchor="middle">{Cert, CertVerify, Finished}</text>
<line class="la" x1="440" y1="200" x2="676" y2="200" marker-end="url(#arr-a)"/>
<text class="ts" x="560" y="192" text-anchor="middle">{Finished} + 应用数据</text>
<line class="la" x1="680" y1="240" x2="444" y2="240" marker-end="url(#arr-a)"/>
<text class="ts" x="560" y="232" text-anchor="middle">应用数据</text>
<text class="ts" x="560" y="335" text-anchor="middle">1-RTT；会话恢复可 0-RTT（有重放风险）</text>
</svg>
<figcaption>图 3：TLS 1.2 与 TLS 1.3 完整握手对比，花括号表示已加密的消息</figcaption>
</figure>

### 握手在做什么

1. **协商**：版本、密码套件（如 `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`：密钥交换 ECDHE、身份认证 RSA、对称加密 AES-GCM、摘要 SHA256）。
2. **认证**：服务端出示证书链，客户端校验，并验证服务端确实持有私钥（1.2 里是对 ServerKeyExchange 的签名，1.3 里是 CertificateVerify）。
3. **密钥交换**：用 ECDHE 让双方各自算出相同的 pre-master secret，再结合双方随机数派生会话密钥。之后全部用对称加密（性能原因）。

TLS 1.3 的关键变化：

- 删除 RSA 密钥交换（私钥泄露可解密历史流量）、删除 CBC、RC4、SHA-1 等弱算法，**只保留具备前向安全的 (EC)DHE**；
- 客户端在 ClientHello 中**猜测**曲线并直接带上 key_share，省掉一个 RTT；证书也被加密传输；
- 0-RTT（early data）可被重放，只应用于幂等请求。
- JDK 11 起支持 TLS 1.3，JDK 8 在 8u261 起回移植。

### 证书链校验

```text
服务器证书 (leaf, CN/SAN=api.example.com)  ← 由中间 CA 签发
        ↑ 用中间 CA 公钥验签
中间 CA 证书                                 ← 由根 CA 签发
        ↑ 用根 CA 公钥验签
根 CA 证书（预置在信任库：浏览器/OS，或 Java 的 $JAVA_HOME/lib/security/cacerts）
```

校验项：签名链能否追溯到受信根、有效期、域名是否匹配 SAN（CN 已不被现代客户端用于匹配）、用途扩展、吊销状态（CRL / OCSP，OCSP Stapling 由服务端附带）。

> [!WARNING] Java 里最常见的 HTTPS 报错
> - `PKIX path building failed: unable to find valid certification path`：服务端**没有发中间证书**（浏览器能自动补全所以测不出来，Java 不会），或用了私有 CA 而 JVM 信任库里没有。用 `openssl s_client -connect host:443 -showcerts` 看服务端实际发了几张证书；私有 CA 用 `keytool -importcert` 导入自定义 truststore，**不要用「信任所有证书」的 TrustManager 上生产**。
> - `No subject alternative names matching ...`：证书 SAN 不含访问的域名 / IP。
> - `handshake_failure` / `protocol_version`：版本或套件不匹配，老 JDK 访问只开 TLS 1.3 的服务、或服务端禁用了旧协议。用 `-Djavax.net.debug=ssl:handshake` 看细节。

## 从输入 URL 到页面展示

1. **URL 解析**：协议、域名、端口、路径；HSTS 列表中的域名直接改走 https。
2. **DNS 解析**：浏览器缓存 → OS 缓存 / hosts → 本地 DNS（递归）→ 根 → 顶级域 → 权威 DNS，可能经过 CNAME 到 CDN。Java 侧注意 JVM 的 DNS 缓存：`networkaddress.cache.ttl`，未装 SecurityManager 时默认缓存 30s，失败结果默认缓存 10s。
3. **建连**：TCP 三次握手 → TLS 握手（ALPN 协商 h2）；HTTP/3 则是 QUIC 握手。
4. **发送请求**：请求经 CDN / LVS / Nginx 等多层代理（见 [Nginx 与负载均衡](#/infra/nginx)），到网关、到业务服务；服务端经过 Tomcat 线程池 → DispatcherServlet → 业务 → DB/缓存。
5. **响应**：状态码、头（缓存、Cookie、压缩），浏览器按 `Cache-Control` / `ETag` 处理缓存。
6. **渲染**：解析 HTML 构建 DOM、解析 CSS 构建 CSSOM → 合成渲染树 → 布局（layout）→ 绘制（paint）→ 合成（composite）；遇到同步 `<script>` 会阻塞解析。
7. **连接复用或关闭**：keep-alive 连接留在池中供后续请求使用。

## Java HTTP 客户端：连接池与三种超时

### 三种超时

| 超时 | 含义 | 不设的后果 |
| --- | --- | --- |
| **取连接超时** connectionRequestTimeout | 从连接池拿连接的等待时间 | 池耗尽时线程无限排队，表现为服务「假死」，`jstack` 大量线程 WAITING 在池上 |
| **连接超时** connectTimeout | TCP 握手（+TLS）的最长时间 | 对端宕机 / 防火墙丢包时卡到系统 SYN 重试上限（Linux 默认约 2 分钟） |
| **读超时** socketTimeout / readTimeout | 两次读到数据之间的最大间隔，**不是整个请求的总时长** | 下游慢时线程被长期占用，级联雪崩 |

> [!CAUTION] 读超时不等于总超时
> socketTimeout 是「两个数据包之间」的空闲时间。下游每 9 秒吐一个字节，10 秒的读超时永远不会触发。需要总时长上限时使用 OkHttp 的 `callTimeout`、JDK HttpClient 的 `request.timeout()`，或在上层用 `CompletableFuture.orTimeout` / 熔断组件兜底（见 [限流、熔断与降级](#/distributed/governance)）。

### 连接池参数

| 客户端 | 关键参数 | 默认值 | 建议 |
| --- | --- | --- | --- |
| Apache HttpClient 4.x | `maxTotal` / `defaultMaxPerRoute` | 20 / **2** | 每路由 2 个几乎必然成为瓶颈，按下游 QPS × RT 估算，如 200 / 50 |
| | `validateAfterInactivity` | 2000ms | 空闲超过该值的连接在复用前先检查 |
| | `evictIdleConnections` / `evictExpiredConnections` | 未开启 | 开启，空闲时间**小于**服务端 keep-alive 超时 |
| Apache HttpClient 5.x | `ConnectionRequestTimeout`、`ConnectTimeout`、`ResponseTimeout` | 不同小版本有差异 | 显式配置，勿依赖默认 |
| OkHttp | `ConnectionPool(maxIdle, keepAlive)` | 5 个空闲连接，5 分钟 | 高并发调大空闲数；keepAlive 小于服务端超时 |
| | `Dispatcher.maxRequestsPerHost` | 5（仅约束异步调用） | 异步调用多时调大 |
| | connect / read / write timeout | 各 10s；`callTimeout` 0（不限） | 按 SLA 设置 |

```java
// Apache HttpClient 4.5：生产可用的最小配置
PoolingHttpClientConnectionManager cm = new PoolingHttpClientConnectionManager();
cm.setMaxTotal(200);
cm.setDefaultMaxPerRoute(50);
cm.setValidateAfterInactivity(2_000);

RequestConfig rc = RequestConfig.custom()
        .setConnectionRequestTimeout(500)   // 取连接
        .setConnectTimeout(1_000)           // 建连
        .setSocketTimeout(3_000)            // 读
        .build();

CloseableHttpClient client = HttpClients.custom()
        .setConnectionManager(cm)
        .setDefaultRequestConfig(rc)
        .evictExpiredConnections()
        .evictIdleConnections(30, TimeUnit.SECONDS)   // 小于服务端 keep-alive 超时
        .build();

try (CloseableHttpResponse resp = client.execute(new HttpGet(url))) {
    String body = EntityUtils.toString(resp.getEntity()); // 读完 entity 连接才会归还池
}
```

> [!WARNING] NoHttpResponseException / Connection reset 的经典原因
> 服务端（或中间的 Nginx、SLB）关闭了空闲 keep-alive 连接，客户端池里的连接已经是半死状态，取出来一发请求就失败。修复三件套：客户端空闲回收时间 < 服务端 keep-alive 超时；开启 `validateAfterInactivity`；对幂等请求开启重试。
>
> 另外注意 Spring 的 `RestTemplate` 默认用 `SimpleClientHttpRequestFactory`（基于 `HttpURLConnection`），没有可配置的连接池；Feign 默认客户端同理，生产应切换到 Apache HttpClient 或 OkHttp 实现。

## 生产实践与踩坑

1. **压测时客户端报 `Cannot assign requested address`**：压测机短连接把本地端口用光（TIME_WAIT 占着端口）。改用长连接，或调大 `ip_local_port_range`、开 `tcp_tw_reuse`。
2. **服务上线后 CLOSE_WAIT 每天涨几千，最后 `Too many open files`**：某个分支拿到 HttpClient 响应后没关闭。`lsof -p <pid> | grep CLOSE_WAIT` 确认，`ss` 找到对端是哪个下游，再翻调用这个下游的代码。
3. **RT 稳定多出 40ms**：Nagle + 延迟确认，抓包看到请求被拆成两个小包，第二个包等了约 40ms。开 `TCP_NODELAY`、合并写。
4. **高峰期偶发 connect timeout，但服务端 CPU 不高**：accept 队列溢出。`netstat -s` 中 overflowed 计数持续增长；检查 Tomcat `maxConnections`/`acceptCount`、`somaxconn`，以及是否有长 GC。
5. **大文件下载跨地域很慢**：长肥管道下 CUBIC 遇到少量丢包就把 cwnd 砍半；切换 BBR、调大 `tcp_rmem/tcp_wmem` 让窗口能放大。
6. **K8s 中 gRPC 负载不均**：HTTP/2 长连接被 kube-proxy 在建连时一次性分配。见 [Kubernetes 核心概念](#/infra/k8s)。
7. **抓包定位**：`tcpdump -i any -nn port 8080 -w a.pcap` 后用 Wireshark 看重传、零窗口、RST 的发起方；谁先发 RST / FIN 往往就是答案。更多命令见 [Linux 线上排查](#/infra/linux)。

## 面试追问

> [!QUESTION] 服务端出现大量 TIME_WAIT 和大量 CLOSE_WAIT，分别说明什么，怎么处理？
> TIME_WAIT 在主动关闭方，说明本端在主动关连接（短连接或 `Connection: close`），本身是协议保护机制，主要问题是占端口 / 内存，改长连接、`tcp_tw_reuse`（只对出站有效）解决。CLOSE_WAIT 在被动关闭方，说明对端已关而本端应用没 close，是代码 bug：未关闭响应 / 连接未归还池 / 线程卡住，靠 `ss` 定位对端、`jstack` 与代码审查定位。

> [!QUESTION] 第三次握手的 ACK 丢了会怎样？
> 服务端停留在 SYN_RCVD，超时重传 SYN+ACK（次数由 `tcp_synack_retries` 控制），客户端已经认为 ESTABLISHED，如果客户端紧接着发数据，数据报文本身携带 ACK，服务端收到后也能完成建连。重传耗尽后服务端丢弃该半连接，之后客户端发数据会收到 RST。

> [!QUESTION] backlog 设成 1024 为什么 ss 看到的上限还是 128？
> 全连接队列上限是 `min(backlog, net.core.somaxconn)`，老内核 somaxconn 默认 128；且容器里 somaxconn 是**网络命名空间级别**的参数，需要在 Pod 的 `securityContext.sysctls` 里设置，宿主机改了不生效。

> [!QUESTION] HTTP/2 已经多路复用了，为什么还需要 HTTP/3？
> HTTP/2 的多个流共享一个 TCP 连接，TCP 保证字节流有序，一个包丢失时后续所有流的数据都被内核挡住（TCP 队头阻塞），弱网下可能比多个 HTTP/1.1 连接还差。QUIC 在 UDP 上为每个流独立做可靠传输，并把 TLS 1.3 集成进握手，支持 0-RTT 和基于 Connection ID 的连接迁移。

> [!QUESTION] TLS 1.3 为什么能 1-RTT，又为什么去掉了 RSA 密钥交换？
> 客户端在 ClientHello 中直接带上 ECDHE 公钥（key_share），服务端一次回复即可算出密钥并发送加密的证书与 Finished。RSA 密钥交换下 pre-master secret 用服务器公钥加密传输，私钥一旦泄露可解密所有录下来的历史流量，不具备前向安全；ECDHE 每次会话临时生成密钥对，规避了这个问题。

> [!QUESTION] 设置了 socketTimeout=3s，为什么接口还是会卡 30 秒？
> 可能原因：① 卡在从连接池取连接，而 connectionRequestTimeout 未设置；② 卡在建连，connectTimeout 未设置；③ 下游持续缓慢吐数据，每次间隔都小于 3s，读超时永远不触发；④ DNS 解析慢（不在这三种超时里）；⑤ 有重试，总耗时是多次叠加。需要总超时兜底。
