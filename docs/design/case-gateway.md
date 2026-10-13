---
level: 高级
tags: [架构案例, API网关, 路由, 鉴权, 限流, 灰度, 协议转换, 过滤器链, 热更新, Spring Cloud Gateway, APISIX, Envoy]
summary: 以十万级 QPS 的统一接入网关为例，拆解 API 网关的职责边界、数据面与控制面分离、过滤器/插件链的顺序设计、路由匹配与动态配置热更新、鉴权（JWT/API Key/签名）与内部头可信、分层限流熔断与重试、灰度与流量染色、协议转换、高性能与异步非阻塞要点、高可用与降级（fail-open/closed）、可观测、安全加固，以及选型对比与常见坑。
---

# 案例：API 网关设计详解

> [!ABSTRACT] 核心要点
> - 网关是**所有南北向流量的统一入口**，承担**横切关注点**：路由、鉴权、限流熔断、灰度、协议转换、观测、安全。**原则：网关做“通用的、与业务无关的事”，不写业务逻辑**——网关一旦承载业务就会成为所有团队的发布瓶颈和故障放大器。
> - 架构上**数据面（转发请求）与控制面（管理配置）分离**：控制面配置变更**热推**到数据面（版本化、原子切换、可回滚），**控制面全挂时数据面靠本地缓存的配置继续转发**。
> - 请求在网关里走一条**有序的过滤器/插件链**：**越便宜、越能提前拒绝的越靠前**（黑名单 → 限流 → 鉴权 → 路由 → 灰度 → 负载均衡 → 熔断/超时/重试）。
> - **高性能的前提是全程异步非阻塞**：一次同步调用 Redis/数据库/鉴权服务就可能卡住 EventLoop，吞吐崩塌；热点数据（路由表、JWKS 公钥、限流配额）必须**本地缓存**。
> - **网关不是信任边界的终点**：对外**剥离伪造的内部头**，向内注入**可验证的身份**；**各服务仍需自行校验和做数据权限**（零信任，见 [认证授权](#/security/auth)）。
> - **失败语义要事先定**：Redis 限流不可用 fail-open 还是 fail-closed？鉴权服务挂了怎么办？重试是否会放大故障？

> [!NOTE] 说明
> 容量数字均为用于推演的**假设**。TLS、HTTP/2、负载均衡基础见 [TCP/IP 与 HTTP(S)](#/infra/network)、[Nginx 与负载均衡](#/infra/nginx)；Netty 线程模型见 [Netty 源码](#/infra/netty-core)。

## 一、需求与约束

### 1. 功能

| 类别 | 功能 |
| --- | --- |
| **接入** | TLS 终止、HTTP/1.1/2、WebSocket/SSE 透传、域名与证书管理 |
| **路由** | 按域名/路径/方法/Header/Query 路由到后端服务，支持权重与规则优先级，前缀改写 |
| **安全** | 认证（JWT/OAuth2/API Key/签名）、IP 黑白名单、WAF、防重放、请求大小限制 |
| **流量治理** | 限流（多维度）、熔断、超时、重试、负载均衡、过载保护 |
| **发布** | 灰度/金丝雀、AB 分流、流量染色、蓝绿切换 |
| **转换** | HTTP→gRPC/Dubbo 协议转换、请求/响应改写、聚合（BFF，谨慎） |
| **观测** | 访问日志、按路由指标、链路追踪注入、审计 |
| **管理** | 控制台 + OpenAPI，配置版本与审计、多租户与权限 |

### 2. 非功能目标与容量估算（假设）

| 维度 | 目标 |
| --- | --- |
| 额外延迟 | 网关自身增加 **P99 < 5ms**（不含后端） |
| 吞吐 | 峰值 **10 万 QPS**，平均报文 4KB（请求+响应）→ 带宽 ≈ 10 万 × 4KB × 8 ≈ **3.2 Gbps**（需多节点 + 万兆网卡） |
| 单节点 | 8 核 16G 的异步网关，纯转发（含鉴权/限流本地化）约 **1~3 万 QPS**（视过滤器复杂度、是否 TLS 终止，**以压测为准**）→ 至少 **6~10 节点**，N+2 冗余与单可用区故障容忍 → **约 15 节点** |
| 可用性 | 99.99%；单节点/单可用区故障无感；配置变更不丢请求 |
| 配置生效 | 路由/限流规则变更 **秒级**下发，不重启、不断连 |

## 二、总体架构

<figure class="fig">
<svg viewBox="0 0 820 400" class="dg" role="img" aria-label="网关架构：客户端经 DNS 与四层负载均衡到达多节点网关集群，数据面每个节点包含监听器、过滤器链和后端连接池；控制面包含管理控制台、配置存储和推送服务，向数据面推送路由限流灰度等配置；数据面通过注册中心发现后端实例，转发到各业务服务；观测系统收集日志指标与追踪">
<rect class="b1" x="20" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="55" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b3" x="160" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="215" y="48" text-anchor="middle" dominant-baseline="middle">DNS / L4 LB</text>
<text class="ts" x="215" y="68" text-anchor="middle">VIP · 健康检查</text>
<line class="l" x1="130" y1="55" x2="160" y2="55" marker-end="url(#arr)"/>
<rect class="bg" x="300" y="20" width="330" height="180" rx="12"/>
<text class="th" x="316" y="44">数据面：网关集群（无状态）</text>
<rect class="b2" x="316" y="58" width="298" height="38" rx="6"/>
<text class="ts" x="465" y="77" text-anchor="middle" dominant-baseline="middle">监听器：TLS 终止 · HTTP/1.1/2 · WebSocket</text>
<rect class="b5" x="316" y="102" width="298" height="52" rx="6"/>
<text class="ts" x="465" y="120" text-anchor="middle" dominant-baseline="middle">过滤器 / 插件链</text>
<text class="ts" x="465" y="140" text-anchor="middle" dominant-baseline="middle">黑名单→限流→鉴权→路由→灰度→LB→熔断/重试</text>
<rect class="b4" x="316" y="160" width="298" height="30" rx="6"/>
<text class="ts" x="465" y="175" text-anchor="middle" dominant-baseline="middle">后端连接池（长连接 keep-alive / HTTP2）</text>
<line class="l" x1="270" y1="55" x2="300" y2="55" marker-end="url(#arr)"/>
<rect class="b1" x="660" y="20" width="140" height="180" rx="12"/>
<text class="th" x="676" y="44">控制面</text>
<text class="ts" x="676" y="70">管理控制台 / API</text>
<text class="ts" x="676" y="92">配置存储（版本化）</text>
<text class="ts" x="676" y="114">推送服务（增量+全量）</text>
<text class="ts" x="676" y="136">发布审批与审计</text>
<text class="ts" x="676" y="158">灰度/回滚</text>
<line class="la" x1="660" y1="110" x2="630" y2="110" marker-end="url(#arr-a)"/>
<text class="ta" x="645" y="102" text-anchor="middle">热推</text>
<rect class="b2" x="300" y="230" width="150" height="50" rx="8"/>
<text class="tb" x="375" y="255" text-anchor="middle" dominant-baseline="middle">注册中心</text>
<rect class="b3" x="490" y="230" width="310" height="50" rx="8"/>
<text class="tb" x="645" y="255" text-anchor="middle" dominant-baseline="middle">后端服务集群（订单/用户/商品…）</text>
<line class="l" x1="465" y1="200" x2="450" y2="230" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="200" x2="600" y2="230" marker-end="url(#arr)"/>
<line class="ld" x1="450" y1="255" x2="490" y2="255"/>
<rect class="b5" x="20" y="230" width="250" height="50" rx="8"/>
<text class="tb" x="145" y="255" text-anchor="middle" dominant-baseline="middle">观测：日志 · 指标 · 追踪</text>
<line class="l" x1="300" y1="190" x2="145" y2="230" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="300" width="780" height="84" rx="10"/>
<text class="ts" x="36" y="324">• 数据面只依赖本地配置快照即可转发；控制面/配置中心不可用时仍照常服务，仅暂停配置变更</text>
<text class="ts" x="36" y="344">• 后端实例来自注册中心（或 DNS/K8s Endpoints），变更通过订阅推送，不在请求路径上查询</text>
<text class="ts" x="36" y="364">• 网关自身无状态，水平扩展；多可用区部署，LB 层做健康检查与跨区故障转移</text>
</svg>
<figcaption>图 1：网关的数据面与控制面</figcaption>
</figure>

## 三、选型：自研还是开源

| | **Spring Cloud Gateway** | **Kong / APISIX**（Nginx + Lua/OpenResty） | **Envoy / Istio Gateway** | **Zuul 1.x** |
| --- | --- | --- | --- | --- |
| 技术栈 | Java，Reactor Netty（异步非阻塞） | C + Lua，事件驱动，插件生态丰富 | C++，xDS 动态配置 | Java，**同步阻塞**（Servlet） |
| 性能 | 中高（受 JVM、GC、过滤器影响） | **高**（Nginx 内核） | **高** | 低（阻塞模型） |
| 扩展方式 | Java Filter，团队熟悉 | Lua/多语言插件（Wasm），需学习 | Filter/Wasm/Lua | Java Filter |
| 动态配置 | 配合配置中心/自定义 | **原生动态路由与插件**（etcd） | **xDS**（标准） | 一般 |
| 运维 | JVM 调优 | 运维 Nginx/etcd | 复杂（尤其 Istio） | — |
| 适合 | **Java 技术栈团队**、需深度定制与代码级逻辑 | 多语言、高性能、插件丰富的**通用 API 网关** | 云原生/服务网格统一入口 | 遗留系统（不推荐新建） |

**选型建议**：团队以 Java 为主、规模中等 → **Spring Cloud Gateway**（见 [Spring Cloud](#/spring/cloud)）足够；追求极致性能、多语言、插件生态 → **APISIX/Kong**；已经上服务网格 → **Envoy/Istio Gateway** 统一东西向与南北向。**不建议从零自研**，除非有非常特殊的需求与专职团队。

> [!WARNING] 版本与能力差异
> 上表是通用对比，具体产品的功能、性能与配置方式随版本演进，选型前请以官方文档与自己的压测为准。

## 四、请求处理链

### 1. 过滤器链的顺序设计

<figure class="fig">
<svg viewBox="0 0 820 330" class="dg" role="img" aria-label="过滤器链顺序：请求进入后依次经过基础防护（TLS、黑名单、请求大小与头清洗）、全局限流、认证鉴权、路由匹配、灰度分流、协议转换与改写、负载均衡与熔断超时重试、转发到后端；响应方向经过响应改写、缓存、访问日志与指标；越靠前的越便宜越能提前拒绝">
<rect class="b4" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 基础防护</text>
<text class="ts" x="75" y="74" text-anchor="middle">黑名单·头清洗</text>
<rect class="b5" x="140" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="195" y="52" text-anchor="middle" dominant-baseline="middle">② 限流</text>
<text class="ts" x="195" y="74" text-anchor="middle">全局·IP·租户</text>
<rect class="b3" x="260" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="315" y="52" text-anchor="middle" dominant-baseline="middle">③ 认证鉴权</text>
<text class="ts" x="315" y="74" text-anchor="middle">JWT·Key·签名</text>
<rect class="b1" x="380" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="435" y="52" text-anchor="middle" dominant-baseline="middle">④ 路由匹配</text>
<text class="ts" x="435" y="74" text-anchor="middle">命中服务/版本</text>
<rect class="b2" x="500" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="555" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 灰度</text>
<text class="ts" x="555" y="74" text-anchor="middle">染色·权重</text>
<rect class="b5" x="620" y="30" width="180" height="64" rx="8"/>
<text class="tb" x="710" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 转换与改写</text>
<text class="ts" x="710" y="74" text-anchor="middle">协议·头·路径·限制 body</text>
<line class="l" x1="130" y1="62" x2="140" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="62" x2="260" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="62" x2="380" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="62" x2="500" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="62" x2="620" y2="62" marker-end="url(#arr)"/>
<rect class="b3" x="20" y="120" width="360" height="64" rx="8"/>
<text class="tb" x="200" y="142" text-anchor="middle" dominant-baseline="middle">⑦ 负载均衡 + 韧性</text>
<text class="ts" x="200" y="164" text-anchor="middle">选实例·熔断·超时·重试(预算)·异常摘除</text>
<rect class="b2" x="400" y="120" width="190" height="64" rx="8"/>
<text class="tb" x="495" y="142" text-anchor="middle" dominant-baseline="middle">⑧ 转发后端</text>
<text class="ts" x="495" y="164" text-anchor="middle">长连接池 · 流式透传</text>
<rect class="b1" x="610" y="120" width="190" height="64" rx="8"/>
<text class="tb" x="705" y="142" text-anchor="middle" dominant-baseline="middle">⑨ 响应阶段</text>
<text class="ts" x="705" y="164" text-anchor="middle">改写·缓存·日志·指标</text>
<line class="l" x1="380" y1="152" x2="400" y2="152" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="152" x2="610" y2="152" marker-end="url(#arr)"/>
<path class="l nf" d="M710 94 L710 108 L200 108 L200 120" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="204" width="780" height="112" rx="10"/>
<text class="th" x="36" y="228">排序原则</text>
<text class="ts" x="36" y="252">• 越便宜、越能提前拒绝的越靠前：黑名单、限流、请求大小检查放在昂贵的鉴权与转发之前，保护后续环节</text>
<text class="ts" x="36" y="272">• 先限流后鉴权，防止未认证的洪水请求打满鉴权依赖；但按用户限流需要先识别身份——可拆分为粗限流（IP）+ 精限流（用户）</text>
<text class="ts" x="36" y="292">• 鉴权通过后才注入内部身份头；任何对外传入的内部头必须在最前面清除</text>
<text class="ts" x="36" y="308">• 每个过滤器只做一件事、无共享可变状态、可配置启停；过滤器数量与复杂度直接决定延迟</text>
</svg>
<figcaption>图 2：网关过滤器链的顺序与职责</figcaption>
</figure>

### 2. 路由匹配与动态路由

**路由模型**（控制面下发的配置）：

```yaml
routes:
  - id: order-v2
    match:                                    # 匹配条件（全部满足）
      host: api.example.com
      path: { prefix: /order/ }               # exact / prefix / regex
      methods: [GET, POST]
      headers: { x-app-version: { regex: "^2\\." } }
    priority: 100                             # 多条规则同时匹配时，优先级高者胜出
    upstream:
      service: order-service                  # 来自注册中心
      subset: v2                              # 灰度版本子集
      lb: weighted_round_robin
    rewrite: { path_strip_prefix: /order }    # 转发前改写路径
    timeout_ms: 800
    retry: { attempts: 1, on: [connect-failure, 503], idempotent_only: true }
    plugins: [auth-jwt, rate-limit-user, cors]
```

**匹配实现与性能**：

- **路径匹配用前缀树（Radix Tree/Trie）**，复杂度与路径长度相关而不是路由条数，**避免 O(n) 逐条正则**（路由上万条时正则线性扫描会拖垮延迟）；
- 域名匹配先分桶（HashMap），再在桶内匹配路径；正则只用于少数需要的场景，且**预编译**并限制复杂度（防 ReDoS）；
- 路由表**不可变快照 + 原子替换**（Copy-on-Write）：请求线程无锁读取，更新时构建新表再切换指针；
- **冲突检测**：控制面在发布前检测重复/遮蔽的路由（高优先级规则无意间遮盖了其他规则），防止上线后流量走错。

## 五、认证鉴权与内部头可信

### 1. 常见方式

| 方式 | 网关做什么 | 注意 |
| --- | --- | --- |
| **JWT** | 本地验签（缓存 JWKS 公钥，按 `kid` 选，定时刷新），校验 `exp/iss/aud` | **不要每次请求远程取公钥**；算法白名单固定；吊销靠短有效期 + 黑名单（见 [认证授权：JWT](#/security/auth)） |
| **API Key / AK-SK 签名** | 校验 key、签名（HMAC）、时间戳窗口与 nonce 防重放 | nonce 去重需要共享存储（Redis），要评估性能与失败语义（见 [加密与签名：接口签名](#/security/crypto)） |
| **OAuth2 Token 内省** | 调用授权服务器 introspection | **必须缓存结果**（短 TTL），否则授权服务器成为瓶颈与单点 |
| **Session/Cookie** | 网关查共享 Session（Redis） | 增加网络依赖，优先改为 JWT 或本地缓存 |
| **mTLS** | 校验客户端证书（设备/合作方） | 证书管理与吊销 |

### 2. 内部头的可信

后端服务常通过网关注入的头拿用户信息（`X-User-Id`、`X-Tenant-Id`）。**风险**：外部客户端直接伪造这些头。

- **入口先清洗**：网关对外部请求**强制删除所有内部保留头**（`X-User-*`、`X-Internal-*`、`X-Stress-*` 等），再按鉴权结果重新注入；
- **内部传输可验证**：内网仍用 mTLS 或对身份头做**签名**（`X-Auth-Sig` = HMAC(用户信息 + 时间戳)），后端校验，防止“绕过网关直接访问后端”冒充用户；
- **后端不信任网关就等于零信任**：重要服务仍应校验令牌或签名，并做**数据权限**（越权 IDOR 防护见 [Web 安全](#/security/web)）；网络层用安全组/NetworkPolicy 限制只允许网关访问后端；
- **权限粒度**：网关做**粗粒度**（该用户能否访问该 API/路由），**细粒度**（该订单是不是你的）必须在业务服务。

## 六、流量治理

### 1. 限流

**多维度、分层**：

| 层 | 维度 | 目的 |
| --- | --- | --- |
| **全局/路由** | 每路由总 QPS | 保护后端容量 |
| **租户/应用（AppKey）** | 按调用方配额 | 公平与商业化（套餐） |
| **用户/IP** | 单用户/单 IP 频率 | 防刷、防爬 |
| **接口级** | 重接口（导出、搜索）单独更严 | 保护慢接口 |
| **并发限制** | 单后端实例最大并发（Semaphore） | 防慢请求堆积（见 [压测：Little 定律](#/design/eng-loadtest)） |

**实现要点**（算法见 [工程中的算法：限流](#/cs/algo-engineering)）：

- **本地令牌桶 + 分布式近似**：每个网关节点本地限流（延迟近 0），全局精确限流用 **Redis + Lua**，但**每个请求访问 Redis 会增加延迟与依赖**——折中：**本地批量预取令牌**（每次向 Redis 领一批配额，本地消耗完再领），或按节点数把全局阈值**等分**（假设流量均匀）；
- **返回**：HTTP **429** + `Retry-After`，附限流原因，便于客户端退避；
- **失败语义（必须事先决策）**：Redis 不可用时 **fail-open（放行，只依赖本地限流）** 还是 **fail-closed（拒绝）**？一般限流用 fail-open（保可用），安全类（防暴力破解）可 fail-closed；
- **规则热更新**：阈值调整秒级生效；支持**临时提升/紧急收紧**（大促预案）。

### 2. 熔断、超时、重试

| 能力 | 要点 |
| --- | --- |
| **超时** | 每路由配置连接/读超时；**网关超时 < 客户端超时**，且**大于后端内部调用总耗时**；长连接/流式接口单独配置 |
| **重试** | 仅**幂等**（GET/幂等键）、仅在**连接失败/特定 5xx**、**重试预算**（占总请求 ≤ 10%）、换实例重试；**避免多层重试放大**（网关重试 + 服务内重试 + 客户端重试，见 [稳定性工程](#/design/eng-chaos)） |
| **熔断/异常摘除** | 按**后端实例**统计连续失败/慢请求，达到阈值暂时摘除（Outlier Detection）并半开探测；比整服务熔断更精细 |
| **负载均衡** | 轮询/加权/最少连接/一致性哈希（有缓存亲和需求时）；考虑**慢启动**（新实例预热，逐步提升权重）；就近（同可用区优先） |
| **过载保护** | 网关自身 CPU/并发超阈值时，**主动丢弃低优先级请求**（Load Shedding），保护核心路由 |

### 3. 灰度与流量染色

- **分流维度**：按**权重**（5%）、**用户 ID 哈希**（同一用户稳定落在同一版本）、**Header/Cookie**（内部测试/白名单）、**地域/渠道**；
- **流量染色**：网关给请求打**灰度标签**（`x-gray: v2`），**沿调用链透传**（HTTP 头/RPC 附件/MQ 消息头），下游服务按标签路由到灰度实例，实现**全链路灰度**（见 [发布策略：灰度](#/infra/release)、[Spring Cloud](#/spring/cloud)）；
- **自动化**：配合指标对比（错误率/延迟）自动放量或回滚（Argo Rollouts/Flagger）。

### 4. 协议转换与聚合

| 场景 | 做法 | 注意 |
| --- | --- | --- |
| **HTTP→gRPC / Dubbo** | 网关按 IDL 把 JSON 转为 Protobuf/RPC 调用（泛化调用、gRPC-JSON 转码） | 需要加载 IDL/元数据并热更新；错误码映射 |
| **WebSocket / SSE** | 透传并设置较长空闲超时、连接数限制 | 长连接占用资源，且发布时需优雅迁移（见 [TCP 深入：WebSocket](#/cs/net-tcp)） |
| **请求/响应改写** | 头部增删、路径前缀改写、字段脱敏 | 避免**缓冲整个 Body**（大文件/流式应透传） |
| **聚合（BFF）** | 一个前端请求聚合多个后端调用 | **谨慎**：聚合逻辑属于业务，放网关会膨胀；更推荐独立 BFF 服务 |

## 七、配置热更新与控制面

### 1. 下发机制

| 方式 | 说明 |
| --- | --- |
| **推送（长连接/ xDS / etcd Watch / 配置中心订阅）** | 变更实时推送，数据面本地持久化最近一版快照 |
| 定时拉取 | 简单兜底，有延迟 |
| **全量 + 增量** | 启动时全量，运行时增量；**版本号/修订号**保证顺序与幂等；断线重连后以全量对齐 |

### 2. 安全地变更配置

- **原子生效**：构建新配置对象 → 校验 → **原子替换**引用；请求线程无锁读，**不能边改边用**；
- **发布前校验**：语法、路由冲突、引用的上游服务存在、正则复杂度、限流阈值合理性；
- **灰度发布配置**：先下发到部分网关节点，观察错误率，再全量；**一键回滚到上一版本**；
- **审计与权限**：谁在何时改了什么，变更审批（重要路由/限流需双人复核）；
- **不要用“reload/重启”换配置**：会断连或丢请求；Nginx 类 reload 虽平滑，但大量长连接场景仍要谨慎；
- **本地降级**：控制面不可用，数据面用本地最近快照；启动时也要能从本地快照启动（避免“配置中心挂了网关启动不了”）。

## 八、高性能设计

### 1. 线程模型与异步非阻塞

网关是典型的 **IO 密集 + 低计算**：少量 EventLoop 线程（≈ CPU 核数）处理成千上万连接（见 [IO 模型与 Netty](#/infra/netty)、[Netty 源码：线程模型](#/infra/netty-core)）。

> [!WARNING] 在 EventLoop 里阻塞 = 全局卡死
> 一次同步的 Redis/JDBC/HTTP 调用、`Thread.sleep`、大 JSON 解析、同步日志写盘，都会占住 EventLoop，让这个线程上所有连接的请求停摆，吞吐骤降、延迟飙升。**所有外部调用必须异步非阻塞**（Reactor/Lettuce 响应式、异步 HTTP 客户端）；不可避免的阻塞操作放**独立线程池**隔离。

### 2. 优化清单

| 方向 | 做法 |
| --- | --- |
| **热点数据本地化** | 路由表、JWKS 公钥、限流配额、黑名单（布隆/哈希集）、灰度规则都在**本地内存**；变更由推送更新 |
| **后端连接池** | 到后端使用**长连接 keep-alive**（HTTP/1.1）或 **HTTP/2 多路复用**，避免每请求握手；空闲回收小于后端/中间设备的超时（见 [TCP 深入：保活](#/cs/net-tcp)） |
| **零拷贝与流式** | 大请求/响应**流式透传**，不缓冲整个 Body；必要时设置最大 Body 并快速 413 |
| **减少内存分配** | 池化 ByteBuf、复用对象；避免在热路径创建大量临时对象；GC 选择低停顿（ZGC/G1 调优，见 [JVM 调优](#/java/jvm/tuning)） |
| **序列化与解析最小化** | 只解析必要的头/字段，不做完整 Body 反序列化 |
| **日志异步 + 采样** | 访问日志异步批量写；Debug 日志默认关闭；高流量下采样 |
| **内核与网卡** | `somaxconn`、`ip_local_port_range`、fd 上限、`SO_REUSEPORT` 多进程监听、中断绑核（见 [TCP 深入：调优](#/cs/net-tcp)） |
| **TLS 优化** | 会话复用、OCSP Stapling、TLS 1.3、必要时 TLS 卸载到 L4/硬件 |
| **度量先行** | 压测 + Profile（火焰图）定位真实热点（见 [压测与容量规划](#/design/eng-loadtest)） |

### 3. 网关层缓存（多级缓存的一环）

对**高频、可缓存的 GET 接口**（商品详情、配置、字典），在网关缓存响应数秒到数分钟：

- 缓存键 = 方法 + 规范化 URL + 影响内容的 Header（`Accept-Language`、版本）+（必要时）用户维度；**带用户身份的响应不能放共享缓存**；
- 遵循 `Cache-Control`/`Vary`，支持**主动失效（purge）**与 `stale-while-revalidate`；
- **防击穿**：同一 Key 并发 miss 时只回源一次（请求合并/单飞）；
- 与 CDN（静态资源）、应用本地缓存、Redis 构成**多级缓存**（见 [缓存设计与一致性](#/redis/cache)、[短链接案例：多级缓存](#/design/case-shorturl)）；注意缓存带来的**一致性与鉴权绕过**风险（缓存命中也必须先通过鉴权）。

## 九、高可用与失败语义

| 风险 | 对策 |
| --- | --- |
| **网关单点/节点故障** | 无状态多实例 + L4 LB 健康检查（主动 + 被动）；跨可用区；N+2 容量 |
| **配置中心/控制面故障** | 数据面使用本地快照继续服务；启动可用本地快照 |
| **后端实例故障** | 异常摘除 + 熔断；重试到其他实例（幂等）；快速失败而非长时间阻塞 |
| **Redis（限流/缓存）故障** | 限流降级为本地限流（fail-open）；缓存回源；不要因依赖故障拖垮整体 |
| **鉴权依赖（授权服务器）故障** | JWT 本地验签不依赖；内省结果缓存；明确“不可用时放行/拒绝”的策略与告警 |
| **流量洪峰/攻击** | 前置 CDN/WAF/高防；网关限流与过载保护；按优先级卸载 |
| **发布与滚动** | 优雅停机（停止接收新连接、处理完在途请求、通知 LB 摘除）；连接排空时间 > 请求最大时长；长连接分批迁移 |
| **网关升级回归** | 灰度升级；流量回放对比；一键回滚 |
| **雪崩风险** | 超时与重试预算；舱壁（按路由/租户隔离线程池与连接池）；限制单路由占用的网关资源 |

**隔离建议**：核心路由（交易）与非核心路由（运营/推荐）**使用不同的网关集群或资源配额**，避免一个路由异常拖垮全部；重要租户独立集群（多租户 SaaS）。

## 十、可观测与安全加固

### 1. 可观测

| 项 | 内容 |
| --- | --- |
| **访问日志** | 时间、路由 ID、方法、路径模板（不含具体 ID，防基数爆炸）、状态码、耗时（网关耗时/后端耗时）、上游实例、请求 ID、租户/用户（脱敏）、限流/熔断标记 |
| **指标** | 按路由：QPS、错误码分布、P50/P99、上游耗时；限流/熔断/重试次数；连接数；过滤器耗时；配置版本；JVM/GC（见 [指标监控](#/infra/obs-metrics)） |
| **追踪** | 生成/透传 `traceparent` 与 `x-request-id`，网关是链路根 span（见 [链路追踪](#/infra/obs-trace)）；高流量采样 |
| **告警** | 5xx 比例、延迟、限流命中突增、上游实例异常摘除数、配置推送失败、证书到期 |
| **审计** | 配置变更、管理操作、敏感接口访问 |

### 2. 安全加固

| 风险 | 对策 |
| --- | --- |
| **请求头伪造** | 清洗内部头、校验 `Host`、规范化 `X-Forwarded-*`（只信任上游 LB 的 IP 段） |
| **HTTP 请求走私/头部注入** | 严格解析（拒绝歧义的 `Content-Length` 与 `Transfer-Encoding` 组合）、限制头大小与数量、使用较新的 HTTP 栈 |
| **慢速攻击（Slowloris/Slow POST）** | 头/体读超时、最小传输速率、连接数与每 IP 连接限制 |
| **大 Body / 大 Header** | 全局与按路由的大小上限，超限返回 413/431 |
| **ReDoS** | 路由/WAF 正则预编译并限制复杂度、超时 |
| **SSRF** | 若网关支持“转发到任意 URL”的功能必须白名单（见 [Web 安全：SSRF](#/security/web)） |
| **CORS 误配** | 来源白名单，避免 `*` 与凭证共存 |
| **证书与密钥** | 证书自动续期与到期告警；私钥在 KMS/硬件保护（见 [加密与密钥管理](#/security/crypto)） |
| **敏感信息泄露** | 日志脱敏（令牌、手机号）；错误响应不暴露内部细节与堆栈 |

## 十一、常见坑

| 坑 | 对策 |
| --- | --- |
| **网关里堆业务逻辑**（聚合、定制规则、数据加工） | 业务放服务/BFF；网关只做通用治理；插件有评审与隔离 |
| **EventLoop 里同步调用外部依赖** | 全异步；阻塞操作隔离线程池；用压测暴露 |
| **每次请求远程取公钥/内省/查规则** | 本地缓存 + 推送更新 + 兜底 |
| **缓冲整个请求/响应 Body** | 流式透传；设置大小上限；大文件走直传（对象存储预签名 URL）而不是经网关 |
| **路由正则滥用、规则数万条线性匹配** | 前缀树/哈希分桶；预编译；发布前校验 |
| **多层重试放大故障** | 网关重试预算；其他层 fail fast；仅幂等 |
| **超时配置不一致**（网关 < 后端，导致网关超时而后端仍在处理） | 超时链路统一规划；后端支持取消/幂等 |
| **信任外部传入的内部头** | 入口清洗 + 签名校验 + 后端二次校验 |
| **配置热更新导致抖动/不一致** | 原子替换、版本号、灰度推送、可回滚 |
| **控制面故障让网关无法启动** | 本地快照启动；数据面与控制面解耦 |
| **长连接（WebSocket/SSE）被默认超时切断** | 路由级超时与心跳；LB 空闲超时大于心跳间隔 |
| **所有路由共用资源，一个坏路由拖垮全部** | 路由/租户级隔离、过载保护、独立集群 |
| **限流依赖 Redis 且无降级** | 本地限流兜底；明确 fail-open/closed |
| **客户端真实 IP 丢失** | 信任链上的 `X-Forwarded-For` 处理；Proxy Protocol；仅信任已知 LB |
| **网关变成全链路瓶颈却无容量规划** | 压测、水位、N+2、自动扩缩容 |

## 相关阅读

- [Spring Cloud Gateway 深入：过滤器链、动态路由与响应式陷阱](#/spring/cloud-gateway)：Spring Cloud Gateway 的实现细节与陷阱
- [微服务安全：网关鉴权、服务间认证与令牌传递](#/spring/cloud-security)：网关鉴权与内部信任
- [API 设计与演进：REST、兼容性与开放平台](#/design/arch-api)：API 设计与开放平台签名
- [多租户 SaaS 架构：隔离、治理与运营](#/design/arch-multitenant)：租户识别与配额

## 面试追问

> [!QUESTION] API 网关的作用？应该承担哪些职责，不该承担哪些？
> 作为南北向流量统一入口，承担路由、负载均衡、认证鉴权、限流熔断、灰度、协议转换、日志监控追踪和安全防护等与业务无关的横切关注点。不应承担业务逻辑和复杂的数据聚合，否则会成为所有团队的发布瓶颈和故障放大器，聚合更适合独立的 BFF 服务。

> [!QUESTION] 网关为什么要把数据面和控制面分离？配置怎么热更新？
> 数据面只负责高性能转发，控制面负责配置管理、审批与下发，分离后控制面故障不影响转发，数据面凭本地快照继续服务。配置通过推送或 xDS、etcd Watch 等下发，全量加增量并带版本号，数据面校验后原子替换路由表，支持灰度推送和一键回滚，避免 reload 造成断连。

> [!QUESTION] 网关如何做到高性能？最常见的性能事故是什么？
> 基于 Netty 或 Nginx 的异步非阻塞模型，少量 EventLoop 处理大量连接；路由表、公钥、限流配额等热点数据本地缓存；到后端使用长连接或 HTTP/2；流式透传大 Body；异步日志；池化内存和合适的 GC。最常见的事故是在 EventLoop 里做了同步阻塞调用，如同步访问 Redis 或鉴权服务，会让整个线程上的请求停摆。

> [!QUESTION] 网关限流怎么设计？Redis 挂了怎么办？
> 多维度分层限流：路由、租户、用户、IP、接口和并发数，返回 429 和 Retry-After。本地令牌桶延迟最低，全局精确限流用 Redis 加 Lua，可批量预取令牌或按节点数均分阈值减少访问。Redis 不可用时要事先决定语义，一般限流 fail-open 降级为本地限流，安全类防暴力破解可 fail-closed，并配合告警。

> [!QUESTION] 网关鉴权后，后端还需要校验吗？内部头如何防伪造？
> 需要，遵循零信任。网关入口强制清除所有外部传入的内部头，鉴权成功后重新注入身份，内网传输用 mTLS 或对身份头做签名，网络层限制只允许网关访问后端；网关只做粗粒度的接口访问控制，细粒度的数据权限如订单归属必须在业务服务校验。

> [!QUESTION] 如何通过网关实现全链路灰度？
> 网关按权重、用户哈希、Header 或地域分流，并给请求打灰度标签，标签沿调用链通过 HTTP 头、RPC 附件和 MQ 消息头透传，下游服务和负载均衡按标签路由到灰度实例，配合指标对比自动放量或回滚，并保证同一用户稳定落在同一版本。

> [!QUESTION] 网关的重试和超时要注意什么？
> 只对幂等请求、连接失败或特定 5xx 重试，设置重试预算并换实例，避免网关、服务内和客户端多层重试乘法放大；超时要分层规划，网关超时大于后端内部总耗时、小于客户端超时，并按路由配置；结合异常实例摘除与熔断，防止慢请求堆积拖垮网关。
