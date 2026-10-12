---
level: 进阶
tags: [计算机网络, 以太网, ARP, IP, 子网, CIDR, 路由, NAT, ICMP, MTU, 分片, conntrack]
summary: 后端工程师需要的网络层知识：一个包从应用到网卡经过哪些封装、以太网/MAC/交换机与 ARP、IP 地址与子网 CIDR（私网/回环/链路本地）、路由表与最长前缀匹配、NAT 与 conntrack、ICMP 与 ping/traceroute 的原理、MTU/MSS/分片与路径 MTU 发现，以及“连不上、偶发超时、大包失败”等线上问题的对应原因。
---

# 网络层：以太网、IP、路由、NAT 与 MTU

> [!ABSTRACT] 核心要点
> - 一个数据包在发送方被**逐层封装**（应用数据 → TCP 段 → IP 包 → 以太网帧），在**同一网段内靠 MAC 地址（ARP 解析）转发，跨网段靠 IP 地址 + 路由**；每经过一个路由器，MAC 变、IP 不变（NAT 例外）。
> - **子网掩码/CIDR 决定“同一网段”的边界**：目的 IP 与自己同网段 → 直接 ARP 发送；否则交给**默认网关**。规划网段时要避免与对端/VPN/K8s 的地址冲突。
> - **路由选择 = 最长前缀匹配**；**NAT** 在边界改写地址与端口，依赖 **conntrack 连接跟踪表**——表满会**静默丢包**，是高并发出网/容器场景的隐形杀手。
> - **ICMP** 承载 ping、traceroute 与“目标不可达/需要分片”等差错报告；**把 ICMP 全部屏蔽会破坏路径 MTU 发现**，造成“小包通、大包卡死”的黑洞。
> - **MTU 1500 → MSS 1460**；隧道/overlay（VXLAN、IPsec、VPN）会吃掉头部空间，**MTU 配置不一致**是容器与跨云网络里最常见的玄学问题。

> [!NOTE] 关联
> TCP/HTTP/TLS 见 [TCP/IP 与 HTTP(S)](#/infra/network)，传输层深入见 [TCP 深入](#/cs/net-tcp)，DNS 见 [DNS 与 CDN](#/cs/net-dns)，容器与排障见 [容器网络与网络排障](#/cs/net-debug)。

## 一、封装：一个包的旅程

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="数据封装：应用数据交给传输层加上 TCP 头形成段，交给网络层加上 IP 头形成包，交给链路层加上以太网头和尾形成帧，物理层发送比特；接收方逐层解封装；同一网段内用目的 MAC 直接送达，跨网段时目的 MAC 是网关的 MAC，经过每个路由器 MAC 被改写而 IP 保持不变">
<text class="th" x="20" y="24">逐层封装（发送方）</text>
<rect class="b1" x="20" y="40" width="760" height="40" rx="6"/>
<text class="tb" x="400" y="60" text-anchor="middle" dominant-baseline="middle">应用数据：GET /orders HTTP/1.1 …</text>
<rect class="b3" x="20" y="90" width="90" height="40" rx="6"/>
<text class="ts" x="65" y="110" text-anchor="middle" dominant-baseline="middle">TCP 头 20B</text>
<rect class="b1" x="110" y="90" width="670" height="40" rx="6"/>
<text class="ts" x="445" y="110" text-anchor="middle" dominant-baseline="middle">应用数据（段 Segment：源/目的端口、序号、窗口…）</text>
<rect class="b5" x="20" y="140" width="90" height="40" rx="6"/>
<text class="ts" x="65" y="160" text-anchor="middle" dominant-baseline="middle">IP 头 20B</text>
<rect class="b3" x="110" y="140" width="670" height="40" rx="6"/>
<text class="ts" x="445" y="160" text-anchor="middle" dominant-baseline="middle">TCP 段（包 Packet：源/目的 IP、TTL、协议号…）</text>
<rect class="b4" x="20" y="190" width="90" height="40" rx="6"/>
<text class="ts" x="65" y="210" text-anchor="middle" dominant-baseline="middle">以太头 14B</text>
<rect class="b5" x="110" y="190" width="630" height="40" rx="6"/>
<text class="ts" x="425" y="210" text-anchor="middle" dominant-baseline="middle">IP 包（帧 Frame：源/目的 MAC、类型）</text>
<rect class="b4" x="740" y="190" width="40" height="40" rx="6"/>
<text class="ts" x="760" y="210" text-anchor="middle" dominant-baseline="middle">FCS</text>
<rect class="bg" x="20" y="250" width="760" height="64" rx="10"/>
<text class="ts" x="36" y="274">• 以太网最大载荷 MTU = 1500B → IP 包最大 1500B → TCP 载荷最大（MSS）= 1500 − 20(IP) − 20(TCP) = 1460B</text>
<text class="ts" x="36" y="294">• 同网段：目的 MAC = 对方 MAC；跨网段：目的 MAC = 网关 MAC，目的 IP 仍是最终目标，每经过一跳 MAC 被重写</text>
<text class="ts" x="36" y="308">• 抓包看到的就是这些头部，排障时按“MAC → IP → 端口 → 序号”逐层定位（见 容器网络与网络排障）</text>
</svg>
<figcaption>图 1：从应用数据到以太网帧的封装</figcaption>
</figure>

## 二、链路层：以太网、MAC 与 ARP

### 1. 交换机与广播域

- **MAC 地址**（48 位，如 `52:54:00:ab:cd:ef`）标识网卡，仅在**同一二层网络（广播域）**内有意义；
- **二层交换机**按“MAC → 端口”表转发：**自学习**（收到帧记录源 MAC 与入端口），未知目的 MAC 则**泛洪**；
- **VLAN（802.1Q）**把一台物理交换机切成多个独立广播域，隔离广播与安全域；
- 广播域过大 → 广播风暴、ARP 压力；大规模数据中心用三层（路由到机架）+ **overlay**（VXLAN）扩展二层。

### 2. ARP：IP → MAC

发送方只知道目的 IP，要发以太帧必须知道目的 MAC：

1. 判断目的 IP 是否与自己**同网段**（用自己的 IP+掩码比较）：同网段 → 解析目的 IP 的 MAC；不同 → 解析**默认网关**的 MAC；
2. 查本机 **ARP 缓存**（`ip neigh` / `arp -n`）；没有则**广播**“谁拥有 10.0.0.8？请告诉 10.0.0.5”（ARP Request）；
3. 目标单播回复自己的 MAC，发送方缓存（有老化时间）。

| 现象 | 原因 |
| --- | --- |
| 同网段 ping 不通，`ip neigh` 显示 `INCOMPLETE/FAILED` | ARP 无应答：对方宕机、不在同一 VLAN、防火墙/安全组、网线/交换机问题 |
| **IP 冲突**（两台机器同一 IP） | ARP 缓存被来回覆盖，**时通时断**；`arping -D`/日志中的 duplicate address 提示 |
| ARP 欺骗（中间人） | 伪造 ARP 应答；内网需静态绑定/动态 ARP 检测 |
| **VIP 漂移**（Keepalived）后部分客户端仍连旧机器 | 旧 ARP 缓存；VIP 切换时发 **免费 ARP（Gratuitous ARP）**通知刷新 |

## 三、IP 地址、子网与路由

### 1. 地址与 CIDR

IPv4 32 位，**CIDR 表示法**：`10.1.2.0/24` = 前 24 位是网络号、后 8 位是主机号。

| CIDR | 地址数 | 可用主机 | 子网掩码 |
| --- | --- | --- | --- |
| /32 | 1 | 单个地址 | 255.255.255.255 |
| /30 | 4 | 2（点对点链路） | 255.255.255.252 |
| /24 | 256 | 254（去掉网络号与广播地址） | 255.255.255.0 |
| /16 | 65536 | 65534 | 255.255.0.0 |
| /8 | 约 1677 万 | | 255.0.0.0 |

**特殊/私有地址段**（工程里天天遇到）：

| 范围 | 用途 |
| --- | --- |
| `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` | **私有地址（RFC1918）**，不在公网路由 |
| `127.0.0.0/8` | 回环（`localhost` = 127.0.0.1），不出网卡 |
| `169.254.0.0/16` | 链路本地；**云厂商元数据服务 `169.254.169.254`**（SSRF 的经典目标，见 [Web 安全](#/security/web)） |
| `100.64.0.0/10` | 运营商级 NAT（CGNAT）/ 部分云内部使用 |
| `0.0.0.0` | “任意地址”（监听全部网卡 `0.0.0.0:8080`）/ 默认路由 `0.0.0.0/0` |
| 224.0.0.0/4 | 组播 |

**网段规划的坑**：

- 公司内网/VPN/云 VPC/K8s（Pod CIDR、Service CIDR）**地址空间不能重叠**，否则路由冲突无解；规划时留足余量并文档化；
- 子网过小（/28）后期扩容困难；
- **IPv6**：128 位，几乎无 NAT 需求；双栈环境下客户端可能优先走 IPv6，**服务只监听 IPv4 或 AAAA 记录异常**会造成“偶发慢/超时”（回退等待）。

### 2. 路由：最长前缀匹配

主机/路由器根据**路由表**决定“下一跳”：

```bash
$ ip route
default via 10.0.0.1 dev eth0                 # 默认路由 0.0.0.0/0：其它一切流量交网关
10.0.0.0/24 dev eth0 proto kernel scope link  # 直连网段，直接 ARP
10.8.0.0/16 via 10.0.0.254 dev eth0           # 去往 10.8.x.x 的流量交给 10.0.0.254
172.17.0.0/16 dev docker0                     # Docker 网桥
```

- **最长前缀匹配**：多条路由匹配同一目的地时，**掩码最长（最具体）的优先**；
- **默认网关**必须与本机同网段，否则不可达；
- **多网卡/多路由问题**：回程包从错误网卡发出（非对称路由）被防火墙丢弃——**策略路由（`ip rule`）**与 `rp_filter`（反向路径过滤）相关；
- `traceroute`/`mtr` 查看逐跳路径；`ip route get 8.8.8.8` 看本机会选哪条路。

### 3. 路由器之间：了解即可

内部网关协议 **OSPF**（区域内）、边界网关协议 **BGP**（自治系统之间，互联网骨干；数据中心里 Calico 等也用 BGP 宣告 Pod 网段）、**ECMP**（等价多路径，按五元组哈希分流，LVS/ECMP 集群常用，见 [Nginx 与负载均衡](#/infra/nginx)）。

## 四、NAT 与连接跟踪

### 1. 为什么需要 NAT

IPv4 地址不够，内网使用私有地址，**出网时由网关把源 IP:端口改写为公网 IP:端口**，回包再反向改写。

| 类型 | 作用 | 例子 |
| --- | --- | --- |
| **SNAT / PAT（NAPT）** | 改写**源**地址（并映射端口），多个内网主机共用一个公网 IP | 家庭路由器、云 NAT 网关、K8s 节点出网 |
| **DNAT** | 改写**目的**地址/端口 | 端口映射、负载均衡 VIP→后端、**Docker `-p`、K8s Service/NodePort** |
| 一对一 NAT（Elastic IP） | 固定公网 IP 映射到某个内网 IP | 云主机弹性公网 IP |

### 2. conntrack：NAT 的状态表

Linux 的 NAT/防火墙（iptables/nftables）依赖 **conntrack（连接跟踪）**：为每条连接（五元组）记录状态与改写映射。

```bash
conntrack -L | wc -l                               # 当前跟踪条目数
cat /proc/sys/net/netfilter/nf_conntrack_max       # 上限
cat /proc/sys/net/netfilter/nf_conntrack_count     # 当前数量
dmesg | grep conntrack                             # "nf_conntrack: table full, dropping packet"
```

| 问题 | 说明 / 对策 |
| --- | --- |
| **conntrack 表满 → 新连接被静默丢弃**（表现为随机连接超时、SYN 重传） | 调大 `nf_conntrack_max`（并相应调 hashsize）；缩短 `nf_conntrack_tcp_timeout_*`（如 TIME_WAIT、established 超时）；高并发短连接场景用连接池/长连接 |
| **SNAT 端口耗尽**（同一目标 IP:端口，每个公网 IP 最多约 6.4 万并发连接） | 增加 SNAT 公网 IP 池、使用长连接、减少短连接；云 NAT 网关监控端口使用率 |
| NAT 超时回收空闲连接 | 云 NAT/负载均衡常有 **350 秒~15 分钟空闲超时**：应用层/TCP keepalive 要**小于**该值（见 [TCP 深入：保活](#/cs/net-tcp)） |
| 源地址被改写，服务端看不到真实客户端 IP | 用 `X-Forwarded-For`/`X-Real-IP`（七层）或 **Proxy Protocol**（四层）；K8s `externalTrafficPolicy: Local` 保留源 IP |
| 对称性 | NAT 要求去回路径一致，回包不经过 NAT 设备会失败 |

## 五、ICMP：差错报告与探测

ICMP 是网络层的“控制消息”协议（IP 协议号 1），**不是 TCP/UDP，没有端口**。

| 类型 | 用途 |
| --- | --- |
| Echo Request/Reply（8/0） | `ping`：测可达性与 RTT |
| **Destination Unreachable（3）** | 目标主机/端口不可达（Code 3 端口不可达：UDP 到无监听端口；**Code 4 需要分片但 DF 置位**） |
| **Time Exceeded（11）** | TTL 减到 0：`traceroute` 的原理 |
| Redirect | 通知更优路由 |

**traceroute 原理**：依次发送 **TTL=1,2,3…** 的探测包，每个路由器把 TTL 减 1，减到 0 时丢弃并返回 ICMP Time Exceeded（含自己的 IP），于是得到逐跳路径与延迟；`*` 表示该跳不回复 ICMP（被限速/屏蔽，并不一定是故障）。

**排障注意**：

- **ping 不通 ≠ 服务不可用**：很多环境屏蔽 ICMP（安全组/防火墙）；反过来 ping 通也不代表端口通——用 `nc -vz host port` / `curl` 测 TCP/应用层；
- `mtr`（持续的 traceroute+ping）能看每一跳的**丢包与延迟**，定位是本地、运营商还是对端的问题；中间某跳显示丢包但后续跳正常 → 通常是**该路由器对 ICMP 限速**，不是真丢包。

## 六、MTU、MSS、分片与路径 MTU 发现

### 1. 概念

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="MTU 与路径 MTU 发现：发送方根据本地 MTU 与对端通告的 MSS 发包并设置 DF 不分片标志；路径中某个链路 MTU 更小时，路由器丢弃过大的包并返回 ICMP 需要分片的差错，发送方据此降低包大小；如果防火墙屏蔽了这个 ICMP，发送方永远不知道，大包被静默丢弃，表现为小包正常大包卡死">
<rect class="b1" x="20" y="60" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="90" text-anchor="middle" dominant-baseline="middle">发送方</text>
<rect class="b3" x="210" y="60" width="130" height="60" rx="8"/>
<text class="tb" x="275" y="82" text-anchor="middle" dominant-baseline="middle">路由器 A</text>
<text class="ts" x="275" y="102" text-anchor="middle">出口 MTU 1400</text>
<rect class="b2" x="420" y="60" width="110" height="60" rx="8"/>
<text class="tb" x="475" y="90" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b5" x="610" y="60" width="110" height="60" rx="8"/>
<text class="tb" x="665" y="90" text-anchor="middle" dominant-baseline="middle">接收方</text>
<line class="l" x1="130" y1="90" x2="210" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="170" y="80" text-anchor="middle">1500B, DF=1</text>
<line class="la" x1="210" y1="108" x2="130" y2="108" marker-end="url(#arr-a)"/>
<text class="ta" x="170" y="132" text-anchor="middle">ICMP 3/4：需分片，MTU=1400</text>
<line class="l" x1="340" y1="90" x2="420" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="90" x2="610" y2="90" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="160" width="760" height="124" rx="10"/>
<text class="th" x="36" y="184">要点</text>
<text class="ts" x="36" y="206">• TCP 默认设置 DF（不允许路由器分片），依靠 PMTUD：收到 ICMP“需要分片”后降低 MSS 重发，之后的包都不超过路径 MTU</text>
<text class="ts" x="36" y="226">• 防火墙/安全组把 ICMP 一律丢弃 → PMTUD 失效 → 三次握手（小包）正常，传输大响应时卡死：典型的“PMTU 黑洞”</text>
<text class="ts" x="36" y="246">• 对策：放行 ICMP type 3 code 4；隧道/VPN 接口做 MSS clamping；统一各网卡/overlay 的 MTU</text>
<text class="ts" x="36" y="266">• UDP 没有 PMTUD，应用层要自己控制包大小（DNS 大响应改走 TCP、QUIC 自行探测、日志 syslog 超长被截断/丢弃）</text>
</svg>
<figcaption>图 2：路径 MTU 发现与 ICMP 黑洞</figcaption>
</figure>

### 2. 常见 MTU 与头部开销

| 链路/封装 | 额外开销 | 内层可用 MTU（外层 1500） |
| --- | --- | --- |
| 普通以太网 | — | 1500 |
| PPPoE（家庭宽带） | 8B | 1492 |
| **VXLAN**（Flannel/Calico overlay、云 VPC 部分场景） | 约 50B | **约 1450** |
| IPIP | 20B | 1480 |
| IPsec/VPN/GRE | 约 50~100B | 视协议，常 1400 左右 |
| 云内部巨型帧（Jumbo frame） | — | 部分环境 9001（AWS 同 VPC）/ 8500+，需端到端一致 |

**实践**：K8s 使用 overlay 时，**Pod 网卡 MTU 应设为（物理 MTU − 封装开销）**；跨云专线/VPN 链路要实测（`ping -M do -s 1472 host` 逐步增大包，`-M do` 禁止分片，找出最大不分片包：载荷 = MTU − 28）。

```bash
ping -M do -s 1472 10.0.0.8      # 1472 + 8(ICMP) + 20(IP) = 1500，能通说明路径 MTU ≥ 1500
ip link show eth0 | grep mtu      # 查看接口 MTU
tracepath 10.0.0.8                # 探测路径 MTU（pmtu 值）
```

### 3. IP 分片

当包超过出口 MTU 且未设置 DF 时，路由器会**分片**，在接收端**重组**。分片的问题：任意一片丢失整个包失败、重组耗内存、防火墙/NAT 对非首片处理不一、可被用于攻击。因此现代协议尽量避免分片（PMTUD、MSS 协商、QUIC 的自适应包大小）。

## 七、综合：线上问题与定位

| 现象 | 可能原因 | 定位 |
| --- | --- | --- |
| 同网段偶发不通/时通时断 | **IP 冲突**、ARP 缓存异常 | `ip neigh`、`arping`、交换机 MAC 漂移日志 |
| 能 ping 通但服务端口不通 | 防火墙/安全组、服务未监听、监听了 127.0.0.1 | `ss -lntp`、`nc -vz`、`iptables -L -n` |
| 握手正常，传输大文件/大响应卡住 | **MTU/PMTU 黑洞**、overlay MTU 不一致 | `ping -M do -s`、tcpdump 看重传、MSS clamping |
| 随机连接超时、SYN 重传，CPU 不高 | **conntrack 表满**、SNAT 端口耗尽、安全组连接数限制 | `dmesg | grep conntrack`、`conntrack -C`、云 NAT 监控 |
| 高并发出网部分请求失败 | 同一目标 IP:端口的 SNAT 端口耗尽（约 6.4 万/源 IP） | 增加 NAT IP、长连接、连接池 |
| 内网互通但跨 VPC/VPN 不通 | 地址段重叠、路由未配置、安全组/ACL 拦截 | `ip route get`、`traceroute`/`mtr`、云路由表 |
| VIP 切换后部分客户端连不上 | ARP 缓存未刷新 | 免费 ARP；检查 Keepalived 配置 |
| IPv6 环境偶发慢 | AAAA 解析到不可达地址，回退 IPv4 前超时 | `curl -4/-6`、检查双栈监听与 DNS |
| 日志服务看到的客户端 IP 全是网关 IP | NAT/代理改写源地址 | `X-Forwarded-For`、Proxy Protocol、`externalTrafficPolicy: Local` |

## 面试追问

> [!QUESTION] 同一网段和跨网段通信有什么区别？ARP 在其中的作用？
> 发送方用自己的 IP 和子网掩码判断目的 IP 是否同网段：同网段则通过 ARP 广播解析目的 IP 对应的 MAC 后直接发以太帧；不同网段则解析默认网关的 MAC，把包交给网关，目的 IP 不变，经过每个路由器 MAC 会被改写。ARP 负责 IP 到 MAC 的映射并缓存。

> [!QUESTION] NAT 是什么？有哪些类型？高并发下有什么问题？
> NAT 在边界改写地址和端口，SNAT 改写源地址让内网共用公网 IP，DNAT 改写目的地址实现端口映射和负载均衡，容器和 K8s Service 大量使用。高并发下要关注 conntrack 表满会静默丢包、同一目标地址的 SNAT 端口耗尽、NAT 空闲超时回收连接，以及源 IP 被改写需要用 XFF 或 Proxy Protocol 传递。

> [!QUESTION] traceroute 的原理？ping 不通是否说明服务不可用？
> traceroute 依次发送 TTL 从 1 递增的探测包，每个路由器把 TTL 减一，减到零时丢弃并回送 ICMP 超时报文，据此得到逐跳路径。ping 用 ICMP，常被防火墙屏蔽，不通不代表服务不可用，应该用 nc 或 curl 测试 TCP 端口和应用层。

> [!QUESTION] 什么是 MTU、MSS？为什么会出现小包正常大包卡死？
> MTU 是链路层一帧能承载的最大 IP 包，以太网 1500，MSS 是 TCP 载荷上限，通常 1460。TCP 设置 DF 靠路径 MTU 发现，路径上某链路 MTU 更小时路由器返回 ICMP 需要分片通知发送方降低包大小；若防火墙屏蔽 ICMP，发送方不知情，握手小包正常而大包被静默丢弃。要放行 ICMP、做 MSS clamping 并统一 overlay 的 MTU。

> [!QUESTION] 为什么 K8s overlay 网络里容易出 MTU 问题？
> VXLAN 等封装会增加约 50 字节头部，如果 Pod 网卡 MTU 仍是 1500，封装后超过物理网卡 MTU，就会分片或被丢弃，表现为连接建立正常但大数据传输卡顿或失败。应把 Pod MTU 设为物理 MTU 减封装开销，并在跨云和 VPN 链路上实测。

> [!QUESTION] 路由是怎么选择的？
> 主机和路由器根据路由表做最长前缀匹配，掩码最长即最具体的路由优先，没有匹配时走默认路由。默认网关必须与本机同网段，多网卡环境还要注意非对称路由与反向路径过滤导致回包被丢弃。
