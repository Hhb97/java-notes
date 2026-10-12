---
level: 高级
tags: [计算机网络, 容器网络, CNI, veth, bridge, VXLAN, iptables, IPVS, kube-proxy, tcpdump, Wireshark, 排障]
summary: 容器与 K8s 网络的底层原理（network namespace、veth、bridge、Docker 端口映射的 DNAT、overlay/VXLAN 与 CNI 方案对比、Service 的 iptables/IPVS 转发、NodePort/源 IP 保留）与网络排障方法论：自上而下的分层定位流程、curl 分阶段耗时、tcpdump 过滤与读包、Wireshark 常用过滤器、ss/mtr/nc/dig 工具箱，以及典型故障案例。
---

# 容器网络与网络排障：CNI、iptables/IPVS、tcpdump

> [!ABSTRACT] 核心要点
> - 容器网络本质是 **Linux network namespace（隔离网络栈）+ veth pair（虚拟网线）+ bridge/路由 + iptables（NAT 与过滤）**。**Docker `-p` 是 iptables DNAT**，**K8s Service 的 ClusterIP 是 kube-proxy 在每个节点写的 iptables/IPVS 规则**——并没有一个真实监听 ClusterIP 的进程。
> - **K8s 网络模型**要求：每个 Pod 有独立可路由的 IP，Pod 之间无需 NAT 即可互通。**CNI 插件**（Flannel/Calico/Cilium）负责实现，分为 **overlay（封装，如 VXLAN）**与**路由（BGP/host-gw，无封装）**两类，后者性能好但依赖底层网络。
> - **iptables 规则线性匹配**，Service 与规则数量上万时转发与更新变慢，**IPVS（哈希表）**或 **eBPF（Cilium）**更适合大规模。
> - **排障要自上而下、逐层缩小范围**：DNS → 路由/连通 → TCP 握手 → TLS → HTTP → 应用；用 **`curl -w` 看各阶段耗时**、**`ss` 看连接状态与队列**、**`tcpdump` 在两端抓包对比**，用证据代替猜测。
> - 抓包时最先看三件事：**有没有重传、有没有 RST、握手哪一步卡住**。

> [!NOTE] 关联
> 网络层与 MTU 见 [网络层：IP、路由、NAT 与 MTU](#/cs/net-ip)，DNS 见 [DNS 与 CDN](#/cs/net-dns)，TCP 细节见 [TCP 深入](#/cs/net-tcp)，K8s 基础见 [Kubernetes](#/infra/k8s)，Docker 基础见 [Docker](#/infra/docker)，主机排查见 [Linux 线上排查](#/infra/linux)。

## 一、Docker 网络原理

### 1. namespace + veth + bridge

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="Docker bridge 网络：宿主机上有 docker0 网桥；每个容器有独立的网络命名空间，通过 veth pair 的一端在容器内作为 eth0，另一端挂到 docker0 网桥；容器之间通过网桥二层互通；访问外部网络时经 docker0 到宿主机路由并由 iptables MASQUERADE 做源地址转换；发布端口 -p 8080:80 通过 iptables DNAT 把宿主机端口转发到容器">
<rect class="bg" x="20" y="20" width="760" height="300" rx="14"/>
<text class="th" x="36" y="44">宿主机</text>
<rect class="b3" x="60" y="70" width="190" height="90" rx="10"/>
<text class="th" x="76" y="94">容器 A 的 netns</text>
<text class="ts" x="76" y="116">eth0 172.17.0.2</text>
<text class="ts" x="76" y="136">独立的路由表 / iptables / 端口空间</text>
<rect class="b3" x="300" y="70" width="190" height="90" rx="10"/>
<text class="th" x="316" y="94">容器 B 的 netns</text>
<text class="ts" x="316" y="116">eth0 172.17.0.3</text>
<text class="ts" x="316" y="136">与 A 互不可见（除非走网络）</text>
<rect class="b5" x="130" y="200" width="300" height="44" rx="8"/>
<text class="tb" x="280" y="222" text-anchor="middle" dominant-baseline="middle">docker0 网桥（172.17.0.1，二层交换）</text>
<line class="l" x1="155" y1="160" x2="190" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="70" y="186" text-anchor="start">veth 对</text>
<line class="l" x1="395" y1="160" x2="360" y2="200" marker-end="url(#arr)"/>
<rect class="b4" x="520" y="140" width="240" height="120" rx="10"/>
<text class="th" x="536" y="164">宿主机网络栈 + iptables</text>
<text class="ts" x="536" y="188">出网：MASQUERADE（SNAT 成宿主 IP）</text>
<text class="ts" x="536" y="208">-p 8080:80：DNAT 宿主:8080→容器:80</text>
<text class="ts" x="536" y="228">ip_forward=1 转发；conntrack 记录映射</text>
<line class="l" x1="430" y1="222" x2="520" y2="210" marker-end="url(#arr)"/>
<rect class="b" x="520" y="280" width="240" height="30" rx="6"/>
<text class="ts" x="640" y="295" text-anchor="middle" dominant-baseline="middle">物理网卡 eth0 → 外部网络</text>
<line class="l" x1="640" y1="260" x2="640" y2="280" marker-end="url(#arr)"/>
<text class="ts" x="60" y="290" text-anchor="start">查看：ip netns / nsenter -t PID -n ip addr / docker network inspect / iptables -t nat -L -n</text>
</svg>
<figcaption>图 1：Docker bridge 网络的结构与端口映射</figcaption>
</figure>

| 概念 | 说明 |
| --- | --- |
| **network namespace** | 内核提供的网络栈隔离：独立的网卡、IP、路由表、iptables、端口空间。容器 = 进程 + 一组 namespace（还有 PID、mount 等，见 [Docker](#/infra/docker)） |
| **veth pair** | 一对虚拟网卡，像网线两端：一端在容器 netns（eth0），另一端在宿主机并接入网桥 |
| **bridge（docker0）** | 软件二层交换机，同一网桥上的容器互通 |
| **端口映射 `-p`** | iptables `DNAT` 规则：宿主机端口 → 容器 IP:端口；出网用 `MASQUERADE` |
| `--network host` | 容器与宿主机**共享 netns**，无隔离无 NAT，性能最好但端口会冲突 |
| 用户态代理 `docker-proxy` | 处理从宿主机本机访问映射端口等场景，有额外开销 |

### 2. 常见现象

- **容器内 `ping` 外网通但访问某些服务不通**：DNS（容器 `/etc/resolv.conf`）、MTU（overlay/VPN）、iptables 规则被其它软件（防火墙、安全工具）覆盖；
- **宿主机重启防火墙服务后容器网络断**：防火墙清空了 Docker 的 iptables 规则（`systemctl restart docker` 恢复）；
- **容器访问宿主机服务**：用宿主机在网桥上的 IP（`172.17.0.1`）或 `host.docker.internal`（Docker Desktop），不是 `127.0.0.1`；
- **端口映射后源 IP 被改成网桥地址**：DNAT 路径上的 SNAT/userland-proxy 导致服务端看不到真实客户端 IP。

## 二、Kubernetes 网络

### 1. 网络模型与 CNI

K8s 的约定：**① Pod 之间无需 NAT 直接互通；② 节点与 Pod 之间互通；③ Pod 看到的自己 IP 与别人看到的一致**。由 **CNI（Container Network Interface）插件**在创建 Pod 时配置 netns、分配 IP、设置路由。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="跨节点 Pod 通信的两种实现：overlay 方案把 Pod 的数据包封装进 UDP 的 VXLAN 隧道，经节点网络传输到对端节点解封装后送给 Pod，兼容任意底层网络但有封装开销和 MTU 变小；路由方案由 BGP 或静态路由把各节点的 Pod 网段宣告给网络，Pod 包直接路由转发，无封装、性能好，但要求底层网络支持">
<rect class="b3" x="20" y="30" width="360" height="150" rx="12"/>
<text class="th" x="36" y="54">Overlay（VXLAN）：Flannel / Calico VXLAN</text>
<text class="ts" x="36" y="80">Pod 包 → 封装进 UDP（外层 IP 为节点 IP）</text>
<text class="ts" x="36" y="100">→ 经任意三层网络 → 对端节点解封装 → Pod</text>
<text class="ts" x="36" y="124">✓ 对底层网络无要求（跨子网、公有云都行）</text>
<text class="ts" x="36" y="144">✗ 封装/解封装开销；MTU 变小约 50B；排障多一层</text>
<text class="ts" x="36" y="164">节点上的 flannel.1 / vxlan 设备、VTEP</text>
<rect class="b2" x="410" y="30" width="370" height="150" rx="12"/>
<text class="th" x="426" y="54">路由模式：Calico BGP / Flannel host-gw</text>
<text class="ts" x="426" y="80">每个节点持有一个 Pod 网段（如 10.244.1.0/24）</text>
<text class="ts" x="426" y="100">BGP 把“该网段在本节点”宣告给其他节点/交换机</text>
<text class="ts" x="426" y="124">✓ 无封装，性能接近物理网络，MTU 不变</text>
<text class="ts" x="426" y="144">✗ 依赖底层二层可达或支持 BGP（云上有限制）</text>
<text class="ts" x="426" y="164">NetworkPolicy 由 Calico/Cilium 实现</text>
<rect class="bg" x="20" y="200" width="760" height="116" rx="10"/>
<text class="th" x="36" y="224">CNI 选型</text>
<text class="ts" x="36" y="246">• Flannel：简单（VXLAN/host-gw），不支持 NetworkPolicy，适合小集群/学习</text>
<text class="ts" x="36" y="266">• Calico：BGP 路由或 IPIP/VXLAN、强大的 NetworkPolicy（iptables 或 eBPF 数据面），生产常用</text>
<text class="ts" x="36" y="286">• Cilium：基于 eBPF，可替代 kube-proxy，高性能、L7 策略与可观测（Hubble），较新内核</text>
<text class="ts" x="36" y="306">• 云厂商 CNI（AWS VPC CNI、阿里 Terway 等）：Pod 直接使用 VPC IP，性能好且与云网络集成，受 ENI/IP 配额限制</text>
</svg>
<figcaption>图 2：跨节点 Pod 通信：overlay 与路由两种实现</figcaption>
</figure>

### 2. Service 转发：kube-proxy 的 iptables 与 IPVS

**ClusterIP 是虚拟 IP**，没有任何网卡或进程拥有它。kube-proxy 在**每个节点**监听 Service/Endpoints 变化，并写入转发规则，把 `ClusterIP:port` **DNAT** 成某个后端 Pod 的 `PodIP:port`：

<figure class="fig">
<svg viewBox="0 0 800 290" class="dg" role="img" aria-label="Service 转发：客户端 Pod 访问 ClusterIP；报文进入节点 netfilter 的 PREROUTING 或 OUTPUT 链，命中 kube-proxy 写入的 KUBE-SERVICES 规则；iptables 模式下按概率随机选择一个 KUBE-SEP 规则做 DNAT 到后端 Pod IP；IPVS 模式使用内核哈希表和调度算法选择后端；conntrack 记录映射使同一连接后续包一致，回包做反向转换">
<rect class="b1" x="20" y="40" width="130" height="60" rx="8"/>
<text class="tb" x="85" y="62" text-anchor="middle" dominant-baseline="middle">客户端 Pod</text>
<text class="ts" x="85" y="82" text-anchor="middle">→ 10.96.0.20:80</text>
<rect class="b5" x="190" y="30" width="250" height="80" rx="10"/>
<text class="th" x="206" y="54">节点内核 netfilter</text>
<text class="ts" x="206" y="76">KUBE-SERVICES 规则命中 ClusterIP</text>
<text class="ts" x="206" y="96">DNAT → 选中的后端 PodIP:8080</text>
<line class="l" x1="150" y1="70" x2="190" y2="70" marker-end="url(#arr)"/>
<rect class="b2" x="490" y="20" width="130" height="40" rx="8"/>
<text class="tb" x="555" y="40" text-anchor="middle" dominant-baseline="middle">Pod 1 10.244.1.5</text>
<rect class="b2" x="490" y="70" width="130" height="40" rx="8"/>
<text class="tb" x="555" y="90" text-anchor="middle" dominant-baseline="middle">Pod 2 10.244.2.7</text>
<rect class="b2" x="490" y="120" width="130" height="40" rx="8"/>
<text class="tb" x="555" y="140" text-anchor="middle" dominant-baseline="middle">Pod 3 10.244.3.9</text>
<line class="l" x1="440" y1="60" x2="490" y2="40" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="70" x2="490" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="80" x2="490" y2="140" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="180" width="760" height="96" rx="10"/>
<text class="ts" x="36" y="204">• iptables 模式：KUBE-SVC 按概率选 KUBE-SEP 做 DNAT；规则线性匹配，Service 数万时变慢</text>
<text class="ts" x="36" y="224">• IPVS 模式：内核 L4 负载均衡（哈希表，O(1)），支持 rr/lc/sh 等调度算法，大规模集群更合适（仍借助少量 iptables/ipset）</text>
<text class="ts" x="36" y="244">• eBPF（Cilium）可替代 kube-proxy：在 socket/网卡层直接转发，更快且可观测；conntrack 记录映射保证同一连接路径一致</text>
<text class="ts" x="36" y="264">• 查看：iptables-save -t nat | grep KUBE-SVC；ipvsadm -Ln；kubectl get endpointslices；conntrack -L | grep 10.96.0.20</text>
</svg>
<figcaption>图 3：kube-proxy 如何把 ClusterIP 转成 Pod IP</figcaption>
</figure>

| 服务类型 | 实现 | 要点 |
| --- | --- | --- |
| **ClusterIP** | 节点上 DNAT 到后端 Pod | 仅集群内可达；DNS 解析到 ClusterIP |
| **NodePort** | 每个节点开放同一端口（30000+），DNAT 到后端 | 外部可通过任意节点 IP:端口访问；多一跳 |
| **LoadBalancer** | 云 LB → NodePort（或直连 Pod） | 云上对外暴露 |
| **Headless** | 无 ClusterIP，DNS 直接返回 Pod IP | StatefulSet、gRPC 客户端负载均衡（见 [gRPC](#/mw/grpc)） |
| **externalTrafficPolicy** | `Cluster`（默认）：可能跨节点转发并 SNAT（丢失源 IP）；`Local`：只转发给本节点 Pod，**保留客户端源 IP**，但需 LB 做健康检查避免打到无 Pod 的节点 | 需要真实客户端 IP 时使用 |

**排障要点**：

- **Service 不通先看 Endpoints**：`kubectl get endpoints svc` 为空 → selector 与 Pod label 不匹配或 Pod 未就绪（readinessProbe 失败）；
- **Pod 能通 Pod IP 但不通 Service**：kube-proxy 异常/规则未同步、IPVS 模块缺失、CNI 与 kube-proxy 冲突；
- **偶发连接失败/超时**：conntrack 表满、Pod 重建导致旧连接被 DNAT 到已不存在的后端（短时间的 RST/超时，靠优雅停机与重试缓解，见 [发布策略](#/infra/release)）；
- **跨节点不通**：节点安全组/防火墙未放行 VXLAN（UDP 8472）/IPIP/BGP（179）；MTU 不一致；
- **NetworkPolicy** 默认拒绝后遗漏放行 DNS（53）。

## 三、排障方法论：自上而下，逐层定位

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="网络排障流程：先确认现象与范围，然后依次检查 DNS 解析、网络连通与路由、TCP 握手、TLS 握手、HTTP 响应、应用处理；每一层用对应工具验证：dig、ping 与 mtr、nc 与 ss 与 tcpdump、openssl s_client、curl、应用日志与链路追踪；curl 的分阶段耗时可以一次性定位卡在哪一层">
<rect class="b1" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① DNS</text>
<text class="ts" x="75" y="74" text-anchor="middle">dig / getent</text>
<rect class="b3" x="145" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="52" text-anchor="middle" dominant-baseline="middle">② 连通/路由</text>
<text class="ts" x="200" y="74" text-anchor="middle">ping / mtr / ip route</text>
<rect class="b5" x="270" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="52" text-anchor="middle" dominant-baseline="middle">③ TCP</text>
<text class="ts" x="325" y="74" text-anchor="middle">nc / ss / tcpdump</text>
<rect class="b2" x="395" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="450" y="52" text-anchor="middle" dominant-baseline="middle">④ TLS</text>
<text class="ts" x="450" y="74" text-anchor="middle">openssl s_client</text>
<rect class="b4" x="520" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="575" y="52" text-anchor="middle" dominant-baseline="middle">⑤ HTTP</text>
<text class="ts" x="575" y="74" text-anchor="middle">curl -v / 抓包</text>
<rect class="b1" x="645" y="30" width="135" height="64" rx="8"/>
<text class="tb" x="712" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 应用</text>
<text class="ts" x="712" y="74" text-anchor="middle">日志 / 链路 / jstack</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="62" x2="270" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="62" x2="395" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="505" y1="62" x2="520" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="62" x2="645" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="760" height="200" rx="10"/>
<text class="th" x="36" y="140">先确认三件事</text>
<text class="ts" x="36" y="162">• 范围：所有客户端还是个别？所有实例还是某个？某个时间点开始（对照发布/变更）？是持续还是偶发？</text>
<text class="ts" x="36" y="182">• 方向：客户端 → 服务端哪一段慢/失败？用“二分”缩小：在中间节点（网关/LB）抓包或访问，判断问题在其前还是其后</text>
<text class="ts" x="36" y="202">• 症状类型：超时（无响应/丢包/阻塞）vs 拒绝（RST/Connection refused）vs 错误响应（HTTP 4xx/5xx）——不同类型指向不同层</text>
<text class="th" x="36" y="232">一个命令定位卡在哪一层</text>
<text class="ts" x="36" y="254">curl -o /dev/null -s -w 'dns:%{time_namelookup} tcp:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer}
' URL</text>
<text class="ts" x="36" y="276">dns 大 → DNS；(tcp−dns) 大 → 握手/丢包/队列；(tls−tcp) 大 → TLS；(ttfb−tls) 大 → 服务端处理慢；(total−ttfb) 大 → 传输慢/大响应</text>
<text class="ts" x="36" y="298">原则：先用证据缩小层级，再深入；两端同时观测（客户端与服务端抓包、日志对时间）；一次只改一个变量</text>
</svg>
<figcaption>图 4：自上而下的网络排障路径</figcaption>
</figure>

## 四、工具箱

### 1. 连通与路径

```bash
ping -c 4 10.0.0.8                    # ICMP 连通与 RTT（可能被屏蔽）
mtr -rwzc 100 10.0.0.8                # 逐跳丢包/延迟统计（-r 报告 -z 显示 AS）
traceroute -n 10.0.0.8                # 路径；TCP 版：traceroute -T -p 443 host（绕过 ICMP 屏蔽）
ip route get 10.0.0.8                 # 本机将选择哪条路由/源地址
nc -vz 10.0.0.8 3306                  # TCP 端口是否通（握手成功）
nc -vzu 10.0.0.8 53                   # UDP 探测（不可靠）
```

### 2. 连接与队列状态

```bash
ss -s                                 # 各状态连接总数
ss -ant state time-wait | wc -l       # TIME_WAIT 数量
ss -lnt                               # LISTEN：Recv-Q=全连接队列当前长度，Send-Q=上限
ss -tnp '( dport = :3306 )'           # 到 3306 的连接及进程
ss -ti dst 10.0.0.8                   # 详细 TCP 信息：rtt/rto/cwnd/retrans（见 TCP 深入）
nstat -az | egrep 'Retrans|ListenOverflows|ListenDrops|TCPTimeouts'
sar -n DEV,EDEV,TCP 1                 # 网卡吞吐、错误、TCP 重传（需 sysstat）
ethtool -S eth0 | egrep 'drop|err|miss'   # 网卡层丢包/错误计数
```

### 3. 抓包 tcpdump

```bash
# 基本：-nn 不解析主机名/端口，-i any 所有接口，-s0 抓完整包，-w 写文件（线上限制大小与时长）
tcpdump -i any -nn -s0 host 10.0.0.8 and port 3306 -w /tmp/mysql.pcap -c 10000
tcpdump -i eth0 -nn 'tcp[tcpflags] & (tcp-syn|tcp-rst) != 0'          # 只看握手与 RST
tcpdump -i any -nn 'tcp[tcpflags] & tcp-rst != 0'                       # 只看 RST：谁在重置连接
tcpdump -i any -nn udp port 53                                          # DNS
tcpdump -i any -nn -A 'tcp port 8080 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'   # 只看有载荷的包（明文 HTTP）
tcpdump -i any -nn 'icmp'                                               # ICMP（含需要分片的差错）
# 容器内抓包：nsenter -t <容器进程PID> -n tcpdump -i eth0 -nn …；K8s 可用 kubectl debug / ephemeral container / ksniff
# 滚动抓包防止撑爆磁盘：-C 100（每个文件 100MB）-W 10（最多 10 个）
```

> [!WARNING] 抓包的合规与成本
> 抓包可能包含密码、令牌、个人信息：**限定范围与时长，加密保存并及时删除**，遵守公司安全与隐私规定；高流量机器上抓包会消耗 CPU 与磁盘，先加过滤条件。HTTPS 流量需要密钥日志（`SSLKEYLOGFILE`）才能在 Wireshark 解密，见 [加密与 TLS](#/security/crypto)。

### 4. Wireshark 常用过滤器

| 目标 | 过滤器 |
| --- | --- |
| 重传 | `tcp.analysis.retransmission` / `tcp.analysis.fast_retransmission` |
| 重复 ACK、丢失段 | `tcp.analysis.duplicate_ack`、`tcp.analysis.lost_segment` |
| 零窗口 | `tcp.analysis.zero_window` / `tcp.window_size == 0` |
| RST | `tcp.flags.reset == 1` |
| 只看握手 | `tcp.flags.syn == 1` |
| 某个流 | 右键 Follow TCP Stream（`tcp.stream eq N`） |
| 响应慢 | `http.time > 1`；`tcp.time_delta > 0.5`（需开启 TCP 选项“跟踪流时间”） |
| TLS 握手 | `tls.handshake`；看 Alert：`tls.alert_message` |
| DNS | `dns`、`dns.flags.rcode != 0`（NXDOMAIN 等） |
| 统计 | Statistics → Conversations / IO Graphs / **Expert Information**（自动汇总重传、乱序、零窗口） |

### 5. 怎么读一段抓包

按顺序问：

1. **握手**：SYN → SYN-ACK → ACK 是否完整、耗时多少？只有 SYN 重传（1s、3s…）→ 对端/中间设备不回（防火墙丢弃、队列满、对端没监听且被丢弃）；SYN 后立刻 RST → 端口无监听或被拒绝；
2. **TLS**：ClientHello 之后有无 ServerHello；Alert（握手失败/证书错误/协议版本不匹配）；
3. **请求与响应的时间差**：请求发出到第一个响应字节（TTFB）是**服务端处理慢**还是**网络慢**——抓包上看**服务端是否迅速 ACK**（说明网络和 TCP 栈正常，只是应用没处理）；
4. **重传、乱序、零窗口、RST、FIN** 的位置与间隔；
5. **两端对比**：客户端侧抓到发出但服务端侧没收到 → 丢在中间；服务端收到但无响应 → 应用问题；
6. **时间对齐**：两端机器 NTP 同步（见 [Linux 线上排查](#/infra/linux)）。

## 五、典型案例

### 案例 1：偶发 1 秒/3 秒的接口超时

**现象**：压测中有少量请求 RT 恰好是 1s、3s，服务端日志里处理时间正常。
**定位**：`nstat` 发现 `ListenOverflows/ListenDrops` 在增长；`ss -lnt` 显示全连接队列 Recv-Q 接近上限；抓包看到客户端 SYN 重传（1s、3s）。
**原因**：突发连接数超过 `accept` 队列容量（`backlog = min(应用 backlog, somaxconn)`），队列满后丢弃握手最后一个 ACK/SYN，客户端按 1s、3s 指数退避重传。
**处理**：调大 `somaxconn` 与应用 backlog（Tomcat `acceptCount`、Netty `SO_BACKLOG`），加快 accept（Netty boss 线程不被阻塞），客户端用连接池减少连接风暴。

### 案例 2：容器里请求大响应卡住，小响应正常

**现象**：Pod 调用跨集群服务，查询小结果正常，导出大结果时挂起直到超时。
**定位**：`curl -w` 显示 TCP/TLS 都正常，TTFB 之后卡住；抓包看到大量重传与 ICMP 流量缺失；`ping -M do -s 1400` 失败，`-s 1300` 成功。
**原因**：跨集群链路使用 VPN/隧道，实际路径 MTU 小于 Pod 网卡 MTU，ICMP“需要分片”被安全组丢弃，PMTUD 失效。
**处理**：放行 ICMP type 3 code 4；Pod/CNI 设置匹配的 MTU；在隧道网关做 MSS clamping。

### 案例 3：K8s 内偶发 DNS 5 秒超时

见 [DNS 与 CDN](#/cs/net-dns)：A/AAAA 并行 UDP 查询的 conntrack 竞争。处理：NodeLocal DNSCache、降低 ndots、升级内核/CNI。

### 案例 4：连接被中间设备静默回收

**现象**：低峰后第一笔数据库请求失败（`Communications link failure`），重试成功。
**定位**：抓包显示空闲约 15 分钟后客户端发数据收到 RST；云 SLB 空闲超时为 15 分钟；连接池 `maxLifetime` 为 30 分钟。
**处理**：连接池 `maxLifetime` 小于中间设备超时、开启 keepalive/心跳，应用层对幂等读重试，见 [TCP 深入：保活](#/cs/net-tcp)。

## 六、常见坑

| 坑 | 对策 |
| --- | --- |
| 凭感觉怀疑“网络不稳定”，不取证 | 先 `curl -w` 分阶段、`ss -ti`、抓包，用数据说话 |
| 只在一端抓包 | 两端（或经过的网关）同时抓并对时 |
| 抓包不加过滤，撑爆磁盘/CPU | 限制接口、过滤、`-c/-C/-W` |
| 把 ping 通当作服务可用 | 用 nc/curl 测对应端口与协议 |
| 忽略 conntrack、SNAT 端口、安全组连接数限制 | 把这些纳入监控（见 [指标监控](#/infra/obs-metrics)） |
| 修改一堆内核参数“碰运气” | 先定位瓶颈，每次只改一项并压测验证 |
| K8s Service 不通不看 Endpoints | `kubectl get endpoints`、Pod readiness、label selector |
| 容器内工具缺失无法排查 | 使用带网络工具的调试镜像（netshoot）/ `kubectl debug` 共享目标 Pod 的 netns |
| 抓包文件含敏感数据随意传播 | 脱敏、加密、限期删除 |

## 面试追问

> [!QUESTION] Docker 容器网络是怎么实现的？-p 端口映射的原理？
> 每个容器有独立的 network namespace，通过 veth pair 一端在容器内作为 eth0，另一端接到宿主机的 docker0 网桥，容器间经网桥二层互通，出网时由 iptables MASQUERADE 做源地址转换。-p 端口映射是 iptables 的 DNAT 规则，把宿主机端口转发到容器 IP 与端口，conntrack 记录映射。

> [!QUESTION] K8s 的 ClusterIP 是怎么工作的？iptables 和 IPVS 模式有什么区别？
> ClusterIP 是虚拟 IP，没有进程或网卡拥有它，kube-proxy 在每个节点监听 Service 和 Endpoints，写入转发规则把访问 ClusterIP 的报文 DNAT 到某个后端 Pod。iptables 模式规则线性匹配、概率选择后端，规模大时更新和匹配变慢；IPVS 用内核哈希表和多种调度算法，大规模下更稳定；Cilium 的 eBPF 还可以替代 kube-proxy。

> [!QUESTION] overlay 与路由模式的 CNI 有什么区别？
> overlay 把 Pod 包封装进 UDP 的 VXLAN 隧道，对底层网络无要求但有封装开销且 MTU 变小；路由模式通过 BGP 或静态路由宣告各节点的 Pod 网段，无封装、性能好，但依赖底层网络支持。选型还要看 NetworkPolicy、规模和云环境，如 Calico、Cilium 或云厂商 CNI。

> [!QUESTION] 怎么快速判断请求慢卡在网络哪一层？
> 用 curl -w 输出 DNS、TCP 连接、TLS、首字节和总耗时，逐段相减定位；再用 ss 看队列与重传，在客户端和服务端两端同时抓包对比，看握手是否完整、是否有重传或 RST、请求发出后服务端是否迅速 ACK，从而区分网络问题还是应用处理慢。

> [!QUESTION] 偶发 1 秒、3 秒的超时可能是什么原因？
> 典型是 SYN 或握手最后一个 ACK 因半连接或全连接队列溢出被丢弃，客户端按 1 秒、3 秒指数退避重传；也可能是丢包后的超时重传。可用 nstat 看 ListenOverflows，ss -lnt 看队列，并抓包确认 SYN 重传，通过调大 backlog 和 somaxconn、加快 accept、使用连接池解决。

> [!QUESTION] K8s 里 Service 访问不通，你怎么排查？
> 先看 Endpoints 是否为空，检查 selector 与 Pod label、Pod 是否就绪；再区分能否直连 Pod IP，若能通 Pod 但不通 Service 则检查 kube-proxy 和规则、IPVS 模块；跨节点不通检查安全组和 VXLAN、BGP 端口与 MTU；还要看 NetworkPolicy 是否拦截，DNS 是否解析正确，必要时在 Pod 内抓包和查看 conntrack。
