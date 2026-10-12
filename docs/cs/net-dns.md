---
level: 进阶
tags: [计算机网络, DNS, CDN, 递归解析, TTL, GSLB, HTTPDNS, CoreDNS, ndots, Java DNS 缓存, Anycast]
summary: DNS 与 CDN 的原理与线上坑：域名解析的完整链路（递归与迭代、各级缓存）、记录类型与 TTL、负载均衡与 GSLB/故障切换的局限、HTTPDNS、CDN 的调度与缓存回源、Java 里的 DNS 缓存（networkaddress.cache.ttl）与连接池陷阱、K8s 里的 CoreDNS 与 ndots 放大查询、常见故障的排查命令。
---

# DNS 与 CDN：解析流程、缓存与线上坑

> [!ABSTRACT] 核心要点
> - **DNS 把域名翻译成 IP**，是几乎所有请求的第一步；它是**分层缓存**系统：浏览器/应用 → 操作系统 → 本地递归 DNS → 权威 DNS，**TTL 决定各级缓存多久刷新**。
> - **DNS 切换不是即时的**：改了记录后，全球各级缓存按 TTL 逐步过期；**“用 DNS 做故障切换”的速度由 TTL 与客户端缓存（尤其是 JVM 与连接池）共同决定**，往往比预想慢得多。
> - **Java 的坑**：JVM 自带 DNS 缓存（`networkaddress.cache.ttl`），**长连接/连接池根本不会重新解析**，后端 IP 变了也一直连旧地址；HttpClient 等要设置合适的连接存活时间。
> - **CDN = DNS 调度（CNAME 到就近边缘节点）+ 边缘缓存 + 回源**；静态资源加速、抗 DDoS、减源站压力；缓存键、`Cache-Control`、刷新（purge）与回源保护是核心。
> - **K8s 里 DNS 是高频故障点**：`ndots:5` 让一次外部域名查询放大成多次，CoreDNS 压力与偶发 5 秒超时（UDP conntrack 竞争）是经典问题。

> [!NOTE] 关联
> 浏览器输入 URL 的完整流程见 [TCP/IP 与 HTTP(S)](#/infra/network)；负载均衡与 GSLB 见 [Nginx 与负载均衡](#/infra/nginx)；K8s 服务发现见 [Kubernetes](#/infra/k8s)；容器网络排障见 [容器网络与网络排障](#/cs/net-debug)。

## 一、DNS 解析流程

### 1. 层级结构与一次完整解析

域名是一棵树：`www.example.com.` = 根（`.`）→ 顶级域（`com`）→ 二级域（`example`）→ 主机（`www`）。

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="DNS 递归解析：应用先查浏览器和系统缓存与 hosts 文件；未命中则向本地递归 DNS 发起查询；本地递归 DNS 若无缓存则迭代地依次询问根服务器、顶级域服务器、权威服务器，最终得到记录并缓存后返回给客户端；各级缓存按 TTL 过期">
<rect class="b1" x="20" y="30" width="150" height="60" rx="8"/>
<text class="tb" x="95" y="52" text-anchor="middle" dominant-baseline="middle">应用 / 浏览器</text>
<text class="ts" x="95" y="72" text-anchor="middle">① 应用缓存 · ② /etc/hosts</text>
<rect class="b3" x="210" y="30" width="150" height="60" rx="8"/>
<text class="tb" x="285" y="52" text-anchor="middle" dominant-baseline="middle">操作系统 stub</text>
<text class="ts" x="285" y="72" text-anchor="middle">③ 系统缓存 · resolv.conf</text>
<rect class="b5" x="400" y="30" width="170" height="60" rx="8"/>
<text class="tb" x="485" y="52" text-anchor="middle" dominant-baseline="middle">本地递归 DNS</text>
<text class="ts" x="485" y="72" text-anchor="middle">④ 运营商/公司/公共 DNS，带缓存</text>
<line class="l" x1="170" y1="60" x2="210" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="60" x2="400" y2="60" marker-end="url(#arr)"/>
<rect class="b2" x="620" y="20" width="160" height="40" rx="8"/>
<text class="tb" x="700" y="40" text-anchor="middle" dominant-baseline="middle">根服务器 .</text>
<rect class="b2" x="620" y="72" width="160" height="40" rx="8"/>
<text class="tb" x="700" y="92" text-anchor="middle" dominant-baseline="middle">顶级域 .com</text>
<rect class="b2" x="620" y="124" width="160" height="40" rx="8"/>
<text class="tb" x="700" y="144" text-anchor="middle" dominant-baseline="middle">权威 DNS example.com</text>
<line class="l" x1="570" y1="48" x2="620" y2="40" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="64" x2="620" y2="92" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="80" x2="620" y2="144" marker-end="url(#arr)"/>
<text class="ts" x="500" y="116" text-anchor="middle">⑤ 迭代查询（无缓存时）</text>
<text class="ts" x="500" y="134" text-anchor="middle">根 → “去问 .com”</text>
<text class="ts" x="500" y="152" text-anchor="middle">.com → “去问 example.com 的 NS”</text>
<text class="ts" x="500" y="170" text-anchor="middle">权威 → 最终 A 记录 + TTL</text>
<rect class="bg" x="20" y="190" width="760" height="176" rx="10"/>
<text class="th" x="36" y="214">要点</text>
<text class="ts" x="36" y="238">• 客户端发的是“递归查询”（帮我查到底），本地递归 DNS 对外做“迭代查询”（逐级问）；结果在各级缓存，TTL 倒计时</text>
<text class="ts" x="36" y="258">• 常用协议：UDP 53（快）；响应过大（被截断 TC 位）、区域传送、DoT 用 TCP；EDNS0 扩大 UDP 报文；DoH/DoT 加密解析</text>
<text class="ts" x="36" y="278">• 负缓存：“域名不存在（NXDOMAIN）”也会被缓存一段时间（由 SOA 的 minimum 决定），新建域名后短时间仍解析失败</text>
<text class="ts" x="36" y="298">• 权威 DNS 的 NS 记录与“胶水记录”保证顶级域能找到权威服务器；权威 DNS 本身需要多机房高可用（或用云 DNS 服务）</text>
<text class="ts" x="36" y="318">• 查看完整过程：dig +trace www.example.com；只看缓存结果：dig www.example.com @本地递归DNS；看 TTL：dig +ttlunits</text>
<text class="ts" x="36" y="338">• 缓存层次越多，“改了记录却不生效”的原因越多：逐级排查（应用 → JVM → 系统 → 递归 DNS → 权威）</text>
<text class="ts" x="36" y="356">• 一次未命中的解析要经过多次网络往返，毫秒到几百毫秒；首屏性能优化包含 dns-prefetch、减少域名数量</text>
</svg>
<figcaption>图 1：DNS 递归解析与多级缓存</figcaption>
</figure>

### 2. 常见记录类型

| 类型 | 含义 | 例子 / 注意 |
| --- | --- | --- |
| **A / AAAA** | 域名 → IPv4 / IPv6 地址 | 一个域名可有多个 A 记录（简单的 DNS 轮询负载均衡） |
| **CNAME** | 别名：域名 → 另一个域名 | **同一名字下不能与其他记录并存，且根域（apex，如 `example.com`）不能用 CNAME**（云厂商用 ALIAS/ANAME 方案绕过） |
| **NS** | 该域的权威服务器 | 域名托管/迁移时修改 |
| **MX** | 邮件交换 | 带优先级 |
| **TXT** | 任意文本 | SPF/DKIM/DMARC、域名所有权验证、ACME 证书验证 |
| **SRV** | 服务位置（主机+端口+权重+优先级） | K8s 服务发现、部分协议（如 SIP、Kerberos、gRPC xDS） |
| **PTR** | 反向解析：IP → 域名 | 邮件反垃圾、日志可读性 |
| **SOA** | 区域元数据（序列号、负缓存 TTL） | 影响 NXDOMAIN 缓存 |
| CAA | 限制哪些 CA 可签发证书 | 安全加固 |

### 3. TTL 的取舍

| TTL | 好处 | 代价 |
| --- | --- | --- |
| **长（小时~天）** | 命中缓存多，解析快，权威 DNS 压力小，抗权威故障 | **切换慢**：故障切换/迁移要等缓存过期 |
| **短（30~60 秒）** | 切换快、便于灰度与故障转移 | 权威 DNS 查询量大、首次解析延迟更常见；**很多客户端/运营商不严格遵守 TTL**，实际生效比 TTL 长 |

**迁移最佳实践**：变更前**提前把 TTL 调低**（要早于变更至少一个旧 TTL 周期），变更并稳定后再调回；新旧环境并行运行一段时间，不要依赖“瞬间切换”。

## 二、DNS 与负载均衡、故障切换

| 方案 | 做法 | 局限 |
| --- | --- | --- |
| **DNS 轮询** | 一个域名返回多个 A 记录，客户端通常取第一个/随机 | 无健康检查（死节点仍在列表）；粒度粗；缓存导致不均 |
| **加权/健康检查解析（云 DNS、GSLB）** | 权威 DNS 探测后端，剔除故障、按权重/地域/运营商返回不同 IP | 受 TTL 与客户端缓存限制，**故障切换以分钟计**，不能替代四层/七层 LB |
| **智能解析（地域/运营商/就近）** | 根据本地 DNS 的来源 IP 返回最近的机房 IP | 本地 DNS 位置 ≠ 用户位置（EDNS Client Subnet 可缓解）；公共 DNS（8.8.8.8）会影响判断 |
| **Anycast** | 多地宣告同一个 IP，BGP 就近路由到最近节点 | 根 DNS、公共 DNS、CDN 使用；有状态长连接受路由变化影响 |
| 内部服务发现（Nacos/Consul/K8s Service） | 注册中心实时感知实例，不走公网 DNS | 内部服务首选，见 [Spring Cloud](#/spring/cloud) |

**分层思路**：DNS/GSLB 负责**机房/区域级**流量分配与容灾 → 四层 LB（LVS/NLB）→ 七层网关（Nginx/Gateway）→ 服务发现，见 [Nginx 与负载均衡](#/infra/nginx)。

### HTTPDNS

移动端 App 绕过运营商本地 DNS，**直接通过 HTTP(S) 接口向 HTTPDNS 服务查询域名对应 IP**：

- 防运营商 DNS 劫持与污染、解析结果可控（可做精准调度与灰度）、更新及时；
- 代价：需要接入 SDK，自己处理缓存、降级（HTTPDNS 失败回退本地 DNS）与证书校验（用 IP 直连时 TLS 的 SNI/Host 需要正确设置，见 [加密与 TLS](#/security/crypto)）。

## 三、CDN

### 1. 工作原理

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="CDN 工作流程：用户请求静态资源域名，该域名通过 CNAME 指向 CDN 的调度域名；CDN 的 DNS 调度根据用户位置返回最近的边缘节点 IP；用户访问边缘节点，命中缓存则直接返回；未命中时边缘节点回源到源站拉取并缓存，之后的请求直接命中；源站只承受少量回源流量">
<rect class="b1" x="20" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="65" text-anchor="middle" dominant-baseline="middle">用户</text>
<rect class="b5" x="190" y="30" width="200" height="70" rx="10"/>
<text class="tb" x="290" y="54" text-anchor="middle" dominant-baseline="middle">CDN 调度（DNS/HTTP）</text>
<text class="ts" x="290" y="76" text-anchor="middle">cdn.example.com → CNAME → 就近节点 IP</text>
<line class="l" x1="130" y1="65" x2="190" y2="65" marker-end="url(#arr)"/>
<rect class="b3" x="450" y="30" width="150" height="70" rx="10"/>
<text class="tb" x="525" y="54" text-anchor="middle" dominant-baseline="middle">边缘节点 Edge</text>
<text class="ts" x="525" y="76" text-anchor="middle">缓存命中 → 直接返回</text>
<line class="l" x1="390" y1="65" x2="450" y2="65" marker-end="url(#arr)"/>
<rect class="b2" x="660" y="30" width="120" height="70" rx="10"/>
<text class="tb" x="720" y="54" text-anchor="middle" dominant-baseline="middle">源站</text>
<text class="ts" x="720" y="76" text-anchor="middle">OSS / Nginx</text>
<line class="l" x1="600" y1="65" x2="660" y2="65" marker-end="url(#arr)"/>
<text class="ts" x="630" y="55" text-anchor="middle">未命中回源</text>
<rect class="bg" x="20" y="130" width="760" height="156" rx="10"/>
<text class="th" x="36" y="154">关键点</text>
<text class="ts" x="36" y="176">• 缓存键：通常 = 域名 + 路径 + （可选）查询参数/请求头；URL 带版本号/哈希（app.3f9a.js）可长期缓存，发布新版本换 URL，避免依赖刷新</text>
<text class="ts" x="36" y="196">• 缓存策略：Cache-Control（max-age / s-maxage / no-store / immutable）、ETag/Last-Modified 协商缓存；CDN 与浏览器缓存分别设置</text>
<text class="ts" x="36" y="216">• 刷新：URL 刷新 / 目录刷新 / 预热（把热点资源推到边缘）；刷新有额度与延迟，不要把“刷新”当常规发布手段</text>
<text class="ts" x="36" y="236">• 回源保护：多层缓存（边缘→区域→源）、回源合并（同一资源并发 miss 只回源一次）、源站限流，防止热点过期瞬间的缓存击穿</text>
<text class="ts" x="36" y="256">• 动态加速：非缓存内容走 CDN 的优化链路回源（TCP 优化、骨干网），降低跨地域延迟；适合 API 加速（但鉴权与缓存要谨慎）</text>
<text class="ts" x="36" y="276">• 安全：隐藏源站 IP（只允许 CDN 回源 IP 访问）、WAF/抗 DDoS、HTTPS 证书托管、防盗链（Referer/签名 URL/Token 鉴权）</text>
</svg>
<figcaption>图 2：CDN 的调度、缓存与回源</figcaption>
</figure>

### 2. 实践要点

| 场景 | 做法 |
| --- | --- |
| **静态资源**（JS/CSS/图片/视频） | 内容哈希文件名 + `Cache-Control: public, max-age=31536000, immutable`；HTML 入口短缓存或 no-cache |
| **私有内容**（付费视频、用户文件） | 签名 URL（带过期时间与签名，见 [加密与签名](#/security/crypto)）、Token 鉴权，**不要缓存带用户身份的响应到公共缓存** |
| **大文件/视频** | Range 请求与分片缓存、HLS/DASH 切片 |
| **缓存穿透到源站** | 回源限流 + 缓存空结果 + 预热；见 [缓存穿透/击穿/雪崩](#/redis/cache) |
| **跨域资源** | CORS 头需要被 CDN 正确缓存与区分（`Vary: Origin`） |
| **源站与 CDN 不一致** | 以 `Age`、`X-Cache`、`Via` 等响应头判断是否命中；`curl -I` 对比 |

## 四、Java 里的 DNS：缓存与连接池陷阱

### 1. JVM 的 DNS 缓存

`InetAddress` 会缓存解析结果，由安全属性控制：

```java
// 永久缓存的隐患：没有 SecurityManager 时默认缓存约 30 秒（正向）、10 秒（负缓存）；
// 设置了 SecurityManager 的环境默认是“永久缓存” —— 后端 IP 变了应用不会感知
java.security.Security.setProperty("networkaddress.cache.ttl", "30");            // 成功解析缓存秒数
java.security.Security.setProperty("networkaddress.cache.negative.ttl", "5");    // 解析失败缓存秒数
// 或在 $JAVA_HOME/conf/security/java.security 中配置；也可 -Dsun.net.inetaddr.ttl=30（旧方式）
```

> [!WARNING] 默认值随运行环境与版本不同
> 是否有 SecurityManager、JDK 版本、容器基础镜像都会影响默认行为，**不要依赖默认值，显式配置**，并在预发验证“后端 IP 变更后应用多久感知”。

### 2. 连接池与长连接：根本不重新解析

**DNS 只在“建立新连接”时用到**。HikariCP 数据库连接、HttpClient/OkHttp 连接池、gRPC/Netty 长连接一旦建立，就一直连着**当时解析到的 IP**，即使 DNS 已经切换：

| 场景 | 问题 | 对策 |
| --- | --- | --- |
| **数据库主从切换/云数据库 IP 变化**（域名指向新主） | 连接池里还是旧主连接，写失败/只读错误 | 连接池设置 `maxLifetime`（如 30 分钟，加抖动）让连接轮换；检测只读错误后驱逐连接；用云厂商驱动/代理（RDS Proxy）处理切换 |
| **HTTP 客户端连接池**连接的后端扩缩容/下线 | 请求打到已下线实例，或流量不再均衡 | 设置**连接最大存活时间**（`timeToLive`）、空闲淘汰、失败重试换连接；见 [TCP/IP 与 HTTP：连接池与超时](#/infra/network) |
| **gRPC 长连接** | HTTP/2 单连接复用，流量集中在少数后端 | 客户端负载均衡 + DNS 定期刷新（`dns:///` + 周期性 re-resolve）、服务端 `MAX_CONNECTION_AGE`，见 [gRPC](#/mw/grpc) |
| **JVM 缓存了旧 IP** | 新连接也连旧地址 | 配置合理的 `networkaddress.cache.ttl` |
| **同一域名多个 IP**（DNS 轮询） | 默认客户端常只取第一个，负载不均 | 客户端 LB（多地址轮询）或前置 LB |

### 3. 解析耗时与失败

- **每次新建连接都解析一遍**会放大延迟：保持长连接/连接池，必要时本地缓存；
- 解析超时默认可能很长（resolv.conf `timeout:5 attempts:2`，多 nameserver 轮询，累计 10 秒以上）——接口偶发“恰好慢 5 秒”是 DNS 超时的经典指纹；
- 域名解析出 AAAA 但 IPv6 不通 → 连接回退前的等待（`-Djava.net.preferIPv4Stack=true` 或修正 DNS）；
- 依赖外部域名（第三方 API）要有**超时 + 重试 + 降级**，别让一次 DNS 抖动拖死线程（见 [限流、熔断与降级](#/distributed/governance)）。

## 五、K8s 与容器里的 DNS

### 1. 服务发现

- 每个 Service 有域名 `<svc>.<namespace>.svc.cluster.local`，由 **CoreDNS** 解析为 ClusterIP（Headless Service 直接返回 Pod IP 列表）；
- Pod 的 `/etc/resolv.conf` 指向集群 DNS，并带 **search 域**与 **`ndots:5`**：

```text
nameserver 10.96.0.10
search shop.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

### 2. ndots:5 放大查询

**域名里点的个数 < 5 时，先按 search 列表依次拼接尝试**，都失败才按绝对域名查询。解析外部域名 `api.example.com`（2 个点）：

```text
api.example.com.shop.svc.cluster.local   → NXDOMAIN
api.example.com.svc.cluster.local        → NXDOMAIN
api.example.com.cluster.local            → NXDOMAIN
api.example.com                          → 成功      （每种还要同时查 A 和 AAAA，共约 8 次查询）
```

| 对策 | 说明 |
| --- | --- |
| 域名**末尾加点**（`api.example.com.`）表示绝对域名，直接查询 | 代码/配置中使用 FQDN（注意 HTTP Host/TLS 证书校验需处理） |
| 在 Pod 级设置 `dnsConfig.options: ndots: 2` | 减少无效 search 查询（注意不要破坏集群内短名访问） |
| **NodeLocal DNSCache**（节点级缓存 DaemonSet） | 降低 CoreDNS 压力与延迟，缓解 conntrack 问题 |
| 扩容 CoreDNS、调缓存时间、监控 `coredns` 指标 | 大规模集群必做 |
| 应用层缓存解析结果、连接池复用 | 减少重复解析 |

### 3. 偶发 5 秒超时

经典现象：Pod 里偶发 DNS 解析要 **5 秒**。原因之一是**同一 socket 并行发 A 与 AAAA 两个 UDP 请求，在 conntrack 里发生竞争，其中一个包被丢弃**，等待 resolv.conf 默认 5 秒超时后重试。缓解：**NodeLocal DNSCache**（用 TCP 到 CoreDNS）、`options single-request-reopen`、升级内核修复、减少 DNS 查询量。Alpine（musl libc）的解析行为与 glibc 有差异（早期版本 search 域处理、并行查询等），出现玄学问题时可对比 glibc 镜像（见 [Docker](#/infra/docker)）。

## 六、排查速查

```bash
dig www.example.com +short                    # 解析结果
dig www.example.com @8.8.8.8                  # 指定 DNS 服务器对比
dig +trace www.example.com                    # 从根开始的完整迭代过程
dig www.example.com +noall +answer +ttlid     # 看 TTL
dig -x 1.2.3.4                                # 反向解析
nslookup www.example.com                      # 另一常用工具（Windows 也有）
getent hosts www.example.com                  # 经系统解析库（含 hosts 与 nsswitch），更接近应用实际行为
cat /etc/resolv.conf /etc/hosts /etc/nsswitch.conf
curl -w "dns:%{time_namelookup}s connect:%{time_connect}s\n" -o /dev/null -s https://api.example.com   # 分阶段耗时
tcpdump -i any -nn udp port 53                # 抓 DNS 包，看是否无应答/重传
```

| 现象 | 常见原因 |
| --- | --- |
| 改了 DNS 记录，部分用户/服务仍访问旧 IP | 各级缓存未过期；JVM 缓存；连接池长连接；客户端不遵守 TTL |
| 新域名解析失败，几分钟后又好了 | 负缓存（NXDOMAIN）未过期 |
| 接口偶发恰好慢 5 秒 | DNS 超时重试（UDP 丢包、conntrack 竞争、某个 nameserver 不通） |
| 容器内解析慢/失败，宿主机正常 | CoreDNS 过载、ndots 放大、网络策略拦截 53 端口、上游 DNS 不通 |
| `dig` 正常但应用失败 | 应用走的是 JVM/libc 缓存、`/etc/hosts`、不同 nameserver 或 IPv6 |
| 不同地区用户解析到不同 IP 且有的很慢 | 智能解析调度问题、本地 DNS 位置偏差 |
| 证书/Host 校验失败（用 IP 直连） | TLS SNI 与 Host 头需设置为域名（HTTPDNS 场景常见） |

## 面试追问

> [!QUESTION] 描述一次 DNS 解析的完整过程。
> 应用先查自己的缓存和 hosts，再到操作系统缓存，然后向本地递归 DNS 发起递归查询；若无缓存，递归 DNS 迭代地询问根服务器、顶级域服务器和权威服务器，得到最终记录和 TTL，缓存后返回给客户端。每一级缓存都按 TTL 过期，通常基于 UDP 53，响应过大会使用 TCP。

> [!QUESTION] 为什么修改 DNS 记录后切换不是即时的？怎么平滑迁移？
> 各级缓存按 TTL 保留旧结果，部分运营商和客户端还不严格遵守 TTL，JVM 和连接池里的长连接更不会重新解析。迁移前要提前调低 TTL，新旧环境并行运行并观察旧流量衰减，稳定后再调回，不能依赖瞬间切换，应用层也要设置合理的连接存活时间。

> [!QUESTION] Java 应用的 DNS 缓存有什么坑？
> InetAddress 有自己的缓存，由 networkaddress.cache.ttl 控制，默认值随是否有 SecurityManager 而不同，可能永久缓存。更常见的是连接池和长连接只在建连时解析，后端 IP 变化后仍连旧地址，所以要显式配置缓存时间，设置连接最大存活时间、空闲淘汰，并在数据库和 gRPC 场景做连接轮换。

> [!QUESTION] CDN 的原理？如何避免回源压垮源站？
> 域名 CNAME 到 CDN，调度系统按用户位置返回最近边缘节点，命中缓存直接返回，未命中回源并缓存。要用内容哈希 URL 与合理的 Cache-Control，多层缓存和回源合并减少回源，源站限流并只允许 CDN 回源 IP，热点资源预热，避免依赖频繁刷新。

> [!QUESTION] K8s 中 DNS 为什么容易出问题？ndots 是什么？
> 集群内服务发现依赖 CoreDNS，所有 Pod 的解析都打到它。Pod 的 resolv.conf 默认 ndots 为 5，点数少于 5 的域名会先依次拼接 search 域查询，外部域名一次解析可放大为多次查询，加上 A 与 AAAA 并行引发的 conntrack 竞争会出现偶发 5 秒超时。可用 FQDN 末尾加点、调低 ndots、NodeLocal DNSCache、扩容 CoreDNS 来缓解。

> [!QUESTION] 能用 DNS 做负载均衡和故障切换吗？
> 可以做粗粒度的机房或区域级调度，如轮询、加权、健康检查和智能解析，但受 TTL 和客户端缓存限制，切换以分钟计，也没有请求级的健康感知。实际应分层：DNS 或 GSLB 做区域级分流，四层和七层负载均衡做实例级分发，内部用注册中心做服务发现。
