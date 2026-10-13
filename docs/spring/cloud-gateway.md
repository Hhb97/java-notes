---
level: 深入
tags: [Spring Cloud Gateway, WebFlux, Reactor Netty, 路由, Predicate, Filter, 动态路由, 鉴权, 限流, 灰度, 响应式, 性能调优]
summary: Spring Cloud Gateway 深入：响应式执行模型与线程陷阱、路由/断言/过滤器的匹配与执行顺序、全局过滤器实现鉴权与日志、动态路由与灰度路由、限流与熔断集成、超时与连接池、请求体读取与内存泄漏坑、跨域与安全头、可观测与性能调优、常见线上问题。
---

# Spring Cloud Gateway 深入：过滤器链、动态路由与响应式陷阱

> [!ABSTRACT] 核心要点
> - Spring Cloud Gateway 基于 **WebFlux + Reactor Netty**，用**少量事件循环线程**处理大量连接。优势是**高并发、低线程开销**；代价是**任何阻塞调用都会拖垮整个网关**（同步 JDBC、阻塞 Redis 客户端、`Thread.sleep`、同步 HTTP 调用）。
> - 核心模型：**Route（id + uri + predicates + filters）**。请求先由 Predicate 匹配路由，再依次经过**全局过滤器与路由过滤器**（按 order 排序的链），最后由路由转发过滤器发送到下游，响应再沿链返回。
> - 网关的业务职责应**窄而稳**：路由、鉴权（令牌校验）、限流、灰度/流量染色、跨域、日志与追踪、协议适配。**不要把业务逻辑写进网关**，否则它会变成发布最频繁、风险最大的单点。
> - **读取请求体是最容易踩的坑**：请求体是一次性流，读取后必须**缓存并重新包装**，否则下游收到空体；同时要警惕 **DataBuffer 未释放导致的内存泄漏**与**大请求体占用内存**。
> - **动态路由**（路由规则放配置中心、实时刷新）是网关的标配能力；配套要有**路由变更校验、灰度与回滚**，否则一次错误路由会让全站不可用。
> - 生产要点：**多实例 + 外层负载均衡、超时与连接池显式配置、限流熔断保护下游与自身、完整的访问日志与指标、不同入口（对外/对内/管理）分离部署**。整体设计方法见 [案例：API 网关设计详解](#/design/case-gateway)。

## 响应式执行模型

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Gateway 的响应式模型：少量 Reactor Netty 事件循环线程同时处理大量连接，过滤器链以非阻塞方式异步编排；如果在过滤器中执行阻塞调用，事件循环线程被占用，所有请求排队，造成网关整体卡死；阻塞操作应使用响应式客户端或调度到专用线程池">
<rect class="b3" x="20" y="30" width="170" height="90" rx="10"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">大量客户端连接</text>
<text class="ts" x="105" y="76" text-anchor="middle">数千到数万</text>
<text class="ts" x="105" y="96" text-anchor="middle">长短连接混合</text>
<rect class="b1" x="230" y="14" width="290" height="124" rx="10"/>
<text class="tb" x="375" y="34" text-anchor="middle" dominant-baseline="middle">事件循环线程（少量，≈CPU 核数）</text>
<rect class="b5" x="246" y="48" width="120" height="30" rx="6"/>
<text class="ts" x="306" y="63" text-anchor="middle" dominant-baseline="middle">loop-1 处理多连接</text>
<rect class="b5" x="384" y="48" width="120" height="30" rx="6"/>
<text class="ts" x="444" y="63" text-anchor="middle" dominant-baseline="middle">loop-2 处理多连接</text>
<text class="ts" x="375" y="102" text-anchor="middle">过滤器链以异步非阻塞方式串联</text>
<text class="ts" x="375" y="122" text-anchor="middle">等待 IO 时让出线程</text>
<rect class="b2" x="560" y="30" width="180" height="90" rx="10"/>
<text class="tb" x="650" y="52" text-anchor="middle" dominant-baseline="middle">下游服务</text>
<text class="ts" x="650" y="76" text-anchor="middle">非阻塞转发</text>
<text class="ts" x="650" y="96" text-anchor="middle">连接池复用</text>
<line class="l" x1="190" y1="75" x2="230" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="75" x2="560" y2="75" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="158" width="350" height="160" rx="8"/>
<text class="th" x="32" y="178">反面：过滤器里阻塞一次的后果</text>
<text class="ts" x="195" y="204" text-anchor="middle">同步查库/同步 RPC/阻塞 Redis/Thread.sleep</text>
<text class="ts" x="195" y="226" text-anchor="middle">⇒ 占住一个事件循环线程（总共才几个）</text>
<text class="ts" x="195" y="248" text-anchor="middle">⇒ 该线程负责的所有连接都被卡住</text>
<text class="ts" x="195" y="270" text-anchor="middle">⇒ 延迟飙升、超时、整体“假死”，但 CPU 不高</text>
<text class="ts" x="195" y="296" text-anchor="middle">症状：下游健康而网关 RT 很高，线程栈在阻塞点</text>
<rect class="b2" x="390" y="158" width="350" height="160" rx="8"/>
<text class="th" x="402" y="178">正确：响应式客户端或隔离阻塞</text>
<text class="ts" x="565" y="204" text-anchor="middle">Redis：用响应式客户端（Lettuce reactive）</text>
<text class="ts" x="565" y="226" text-anchor="middle">远程调用：WebClient，而非 RestTemplate/Feign</text>
<text class="ts" x="565" y="248" text-anchor="middle">必须阻塞（遗留 SDK）：publishOn 到有界弹性线程池</text>
<text class="ts" x="565" y="270" text-anchor="middle">CPU 密集（加解密/大 JSON）：同样隔离到专用线程池</text>
<text class="ts" x="565" y="296" text-anchor="middle">用阻塞检测工具（如 BlockHound）在测试环境发现违规</text>
</svg>
<figcaption>图 1：事件循环模型与阻塞调用的危害</figcaption>
</figure>

要点：

- 一旦网关里出现“**偶发全站延迟、下游正常**”，先抓线程栈看事件循环线程是不是卡在阻塞调用；
- **响应式不是更快，而是更省线程**：若网关逻辑本身全是阻塞的（如大量同步调用），用传统 Servlet 模型的网关（或 Nginx/OpenResty）可能更简单可靠；
- 线程上下文：响应式链路里 **ThreadLocal 不可靠**，上下文用 `ServerWebExchange` 的 attributes 或 Reactor Context 传递；
- 异常处理：全局异常处理器统一输出格式，避免把内部堆栈暴露给外部。

## 路由、断言与过滤器

### 请求处理流程

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Gateway 处理流程：请求到达后由 RoutePredicateHandlerMapping 遍历路由，用 Predicate 匹配，匹配成功后组装全局过滤器与路由过滤器，按 order 排序形成过滤器链，依次执行前置逻辑，到达路由转发过滤器发请求到下游，响应返回时按相反顺序执行后置逻辑">
<rect class="b3" x="20" y="30" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">请求</text>
<text class="ts" x="75" y="72" text-anchor="middle">进入网关</text>
<rect class="b5" x="150" y="30" width="150" height="60" rx="8"/>
<text class="tb" x="225" y="52" text-anchor="middle" dominant-baseline="middle">路由匹配</text>
<text class="ts" x="225" y="72" text-anchor="middle">Predicate 逐个判断</text>
<rect class="b1" x="320" y="30" width="170" height="60" rx="8"/>
<text class="tb" x="405" y="52" text-anchor="middle" dominant-baseline="middle">组装过滤器链</text>
<text class="ts" x="405" y="72" text-anchor="middle">全局+路由·按 order 排序</text>
<rect class="b4" x="510" y="30" width="110" height="60" rx="8"/>
<text class="tb" x="565" y="52" text-anchor="middle" dominant-baseline="middle">前置逻辑</text>
<text class="ts" x="565" y="72" text-anchor="middle">order 小者先执行</text>
<rect class="b2" x="640" y="30" width="100" height="60" rx="8"/>
<text class="tb" x="690" y="52" text-anchor="middle" dominant-baseline="middle">转发下游</text>
<text class="ts" x="690" y="72" text-anchor="middle">NettyRouting</text>
<line class="l" x1="130" y1="60" x2="150" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="60" x2="320" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="60" x2="510" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="60" x2="640" y2="60" marker-end="url(#arr)"/>
<path class="la" d="M690 90 L690 118 L565 118 L565 90" marker-end="url(#arr-a)"/>
<text class="ta" x="628" y="134" text-anchor="middle">响应沿链反向：后置逻辑 order 大者先</text>
<rect class="bg" x="20" y="150" width="350" height="170" rx="8"/>
<text class="th" x="32" y="170">常用 Predicate</text>
<text class="ts" x="195" y="196" text-anchor="middle">Path：路径匹配（最常用）</text>
<text class="ts" x="195" y="216" text-anchor="middle">Host / Method / Header / Query / Cookie</text>
<text class="ts" x="195" y="236" text-anchor="middle">After / Before / Between：时间窗口（定时上线）</text>
<text class="ts" x="195" y="256" text-anchor="middle">Weight：按权重分流（灰度比例）</text>
<text class="ts" x="195" y="276" text-anchor="middle">RemoteAddr / XForwarded：来源限制</text>
<text class="ts" x="195" y="302" text-anchor="middle">多个 Predicate 默认“与”；多路由按顺序，先匹配先用</text>
<rect class="bg" x="390" y="150" width="350" height="170" rx="8"/>
<text class="th" x="402" y="170">常用 Filter</text>
<text class="ts" x="565" y="196" text-anchor="middle">StripPrefix / RewritePath：改写路径</text>
<text class="ts" x="565" y="216" text-anchor="middle">AddRequestHeader / RemoveRequestHeader</text>
<text class="ts" x="565" y="236" text-anchor="middle">RequestRateLimiter：限流（Redis 令牌桶）</text>
<text class="ts" x="565" y="256" text-anchor="middle">CircuitBreaker：熔断与降级</text>
<text class="ts" x="565" y="276" text-anchor="middle">Retry：重试（仅幂等，限制次数）</text>
<text class="ts" x="565" y="302" text-anchor="middle">SetStatus / Redirect / ModifyResponseBody 等</text>
</svg>
<figcaption>图 2：路由匹配与过滤器链的执行顺序</figcaption>
</figure>

### 路由配置示例

```yaml
spring:
  cloud:
    gateway:
      httpclient:
        connect-timeout: 1000          # 毫秒：连接下游
        response-timeout: 5s           # 全局响应超时
        pool:
          type: FIXED
          max-connections: 500         # 每个下游地址的连接上限
          max-idle-time: 20s           # 小于下游/负载均衡的空闲超时
      routes:
        - id: order-v1
          uri: lb://order-service      # 通过 LoadBalancer 选实例
          predicates:
            - Path=/api/order/**
          filters:
            - StripPrefix=1
            - name: CircuitBreaker
              args: { name: orderCb, fallbackUri: 'forward:/fallback/order' }
            - name: Retry
              args:
                retries: 2
                methods: GET           # 只对幂等的 GET 重试
                statuses: BAD_GATEWAY, SERVICE_UNAVAILABLE
                backoff: { firstBackoff: 50ms, maxBackoff: 500ms, factor: 2 }
          metadata:
            response-timeout: 2000     # 单路由覆盖超时
            connect-timeout: 500
```

要点：

- **路由顺序**：先匹配先生效，宽泛的路径放在后面；
- **order**：全局过滤器与路由过滤器**混排**，鉴权、限流、日志等应有明确的 order 约定（鉴权通常先于限流和业务过滤器）；
- **`lb://` 与服务发现**：依赖负载均衡与注册中心；注册信息变化会影响路由目标，见 [Nacos 与服务注册发现](#/mw/registry)；
- **Retry**：只对 GET（幂等）且按状态码/异常重试，必须有退避；POST 默认不要开。

## 全局过滤器：鉴权、日志与染色

```java
@Component
public class AuthGlobalFilter implements GlobalFilter, Ordered {

    private final TokenVerifier verifier;           // 本地校验 JWT（公钥验签），不要每次远程调用

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        ServerHttpRequest req = exchange.getRequest();
        String path = req.getURI().getPath();
        if (Whitelist.match(path)) return chain.filter(exchange);   // 登录、健康检查等免鉴权路径

        String token = extractBearer(req.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
        return verifier.verify(token)                // 返回 Mono<Principal>，必须是非阻塞实现
            .flatMap(p -> {
                // 先清除外部伪造的内部头，再写入网关生成的可信内部头
                ServerHttpRequest mutated = req.mutate()
                    .headers(h -> {
                        h.remove("X-User-Id"); h.remove("X-Tenant-Id"); h.remove("X-Gray-Tag");
                        h.add("X-User-Id", p.userId());
                        h.add("X-Tenant-Id", p.tenantId());
                    }).build();
                return chain.filter(exchange.mutate().request(mutated).build());
            })
            .switchIfEmpty(Mono.defer(() -> unauthorized(exchange)))   // 令牌无效
            .onErrorResume(e -> unauthorized(exchange));
    }

    @Override public int getOrder() { return -100; }    // 越小越先执行
}
```

要点：

- **只做“认证与粗粒度授权”**（令牌有效、路径级权限）；**资源级授权留给业务服务**，服务不能因为“网关已校验”就放弃自己的校验，见 [微服务安全](#/spring/cloud-security)；
- **JWT 本地验签**（缓存公钥/JWKS），不要每次请求远程调用认证中心（会成为瓶颈）；撤销与黑名单用缓存（响应式 Redis）；
- **清理外部传入的内部头**再重新生成，防止伪造；
- **访问日志**：记录 `requestId/traceId`、路由 ID、方法、路径（脱敏）、状态码、耗时、下游地址、用户 ID；用独立的日志过滤器并**异步输出**；
- **生成 `X-Request-Id`/traceId**：入口统一生成并向下游传递，与链路追踪结合，见 [微服务可观测](#/spring/cloud-observability)。

## 动态路由与灰度路由

### 动态路由

静态 yaml 路由需要重启才能生效，不适合频繁变更。常见做法：

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="动态路由：路由规则存放在配置中心，网关监听变更，校验后构建新的路由定义并刷新路由表；刷新要保证原子性、可回滚，并在管理端提供灰度发布与审计；异常规则被拒绝并保留旧路由">
<rect class="b3" x="20" y="40" width="150" height="70" rx="8"/>
<text class="tb" x="95" y="62" text-anchor="middle" dominant-baseline="middle">管理端</text>
<text class="ts" x="95" y="84" text-anchor="middle">编辑·审批·灰度</text>
<rect class="b5" x="200" y="40" width="150" height="70" rx="8"/>
<text class="tb" x="275" y="62" text-anchor="middle" dominant-baseline="middle">配置中心</text>
<text class="ts" x="275" y="84" text-anchor="middle">版本化存储路由</text>
<rect class="b1" x="380" y="40" width="170" height="70" rx="8"/>
<text class="tb" x="465" y="62" text-anchor="middle" dominant-baseline="middle">网关监听变更</text>
<text class="ts" x="465" y="84" text-anchor="middle">校验·构建定义</text>
<rect class="b2" x="580" y="40" width="160" height="70" rx="8"/>
<text class="tb" x="660" y="62" text-anchor="middle" dominant-baseline="middle">刷新路由表</text>
<text class="ts" x="660" y="84" text-anchor="middle">原子替换，失败回退</text>
<line class="l" x1="170" y1="75" x2="200" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="75" x2="380" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="75" x2="580" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="136" width="720" height="140" rx="8"/>
<text class="th" x="32" y="156">安全地动态变更</text>
<text class="ts" x="380" y="182" text-anchor="middle">变更前校验：路径冲突、目标服务存在、必填字段、过滤器参数合法；不合法则拒绝并告警，保留旧路由</text>
<text class="ts" x="380" y="204" text-anchor="middle">按网关实例灰度：先让少数网关实例加载新路由，观察错误率，再全量；保留历史版本一键回滚</text>
<text class="ts" x="380" y="226" text-anchor="middle">变更留痕：谁、何时、改了什么，与发布系统和告警联动；大促期间冻结路由变更</text>
<text class="ts" x="380" y="248" text-anchor="middle">兜底：配置中心不可用时使用本地快照路由，网关不能因配置中心故障而起不来或清空路由</text>
<text class="ts" x="380" y="268" text-anchor="middle">一次错误路由等于全站故障：动态能力越强，变更治理越重要</text>
</svg>
<figcaption>图 3：动态路由的变更与保护</figcaption>
</figure>

实现思路：自定义 `RouteDefinitionRepository`/`RouteDefinitionLocator` 从配置中心读取路由，监听变更后发布 `RefreshRoutesEvent` 刷新路由；更多路由的场景（成百上千个）要关注**路由匹配的线性开销与刷新耗时**，必要时按前缀分层或在前面的负载均衡层做第一级分发。

### 灰度路由

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| **按请求头/Cookie** | Predicate 匹配灰度标，路由到灰度服务/版本 | 内部测试、指定用户灰度 |
| **按比例（Weight）** | 同一路径配置多个路由，按权重分流 | 渐进放量 |
| **按用户/租户特征** | 过滤器按用户 ID 哈希、白名单决定灰度标，写入头 | 稳定的用户灰度（同一用户始终命中同一版本） |
| **全链路染色** | 网关写入灰度标头，之后的所有服务在调用中透传并按标选择实例 | 多服务联动的新版本验证，见 [配置管理与全链路灰度](#/spring/cloud-config-gray) |

注意：**比例灰度要保证粘性**（同一用户不要一会儿新版本一会儿旧版本），按用户 ID 哈希而不是随机；灰度实例的元数据通过注册中心标记，选择实例时按标签过滤并**优雅回退**到稳定版本。

## 限流、熔断与保护

| 能力 | 做法 | 要点 |
| --- | --- | --- |
| **限流** | `RequestRateLimiter`（Redis 令牌桶）或集成 Sentinel | 限流维度：IP、用户、API、租户；Redis 限流依赖响应式客户端，Redis 故障时要**失败放行或降级本地限流**，不能让网关因此不可用；见 [限流、熔断与降级](#/distributed/governance) |
| **熔断** | `CircuitBreaker` 过滤器 + Resilience4j/Sentinel | 按路由配置；降级走 `forward:/fallback` 返回友好错误 |
| **舱壁/并发限制** | 限制对单个下游的并发请求数 | 防止一个慢下游占满网关的连接池 |
| **超时** | 全局 + 路由级 `response-timeout`、`connect-timeout` | 必须显式设置，且**小于**客户端到网关的超时，网关 < 调用方 |
| **请求体大小限制** | `spring.codec.max-in-memory-size`、上传走直传 | 防止大请求占满内存 |
| **慢速攻击/连接耗尽** | 外层 LB/WAF 限制连接数与空闲时间 | 网关不是 WAF，不要独自承担安全防护 |
| **IP 黑白名单、来源校验** | 全局过滤器 | 需要时配合 WAF |

## 请求体、响应体与内存

### 读取请求体的正确姿势

请求体是**只能消费一次的流**。需要读取（签名校验、参数审计、改写）时：

```java
// 反例：直接读取 body，下游将收到空请求体
// 正例：读取后缓存，并用装饰器重新提供给下游
return DataBufferUtils.join(exchange.getRequest().getBody()).flatMap(buf -> {
    byte[] bytes = new byte[buf.readableByteCount()];
    buf.read(bytes);
    DataBufferUtils.release(buf);                    // 必须释放，否则内存泄漏

    ServerHttpRequestDecorator decorated = new ServerHttpRequestDecorator(exchange.getRequest()) {
        @Override public Flux<DataBuffer> getBody() {
            return Flux.just(exchange.getResponse().bufferFactory().wrap(bytes)); // 重新提供
        }
    };
    // 在这里对 bytes 做校验/签名/审计 …
    return chain.filter(exchange.mutate().request(decorated).build());
});
```

要点与坑：

- **DataBuffer 必须释放**：Netty 的池化直接内存不会被 GC 回收，忘记释放会表现为**直接内存持续增长、最终 OOM（`OutOfDirectMemoryError`）**；
- **不要读取大请求体/文件上传**：`join` 会把整个体放进内存；网关只处理小报文，大文件走对象存储直传；
- **限制最大体积**：避免恶意大包；
- **修改响应体（`ModifyResponseBody`）同理**：会聚合整个响应，流式响应（SSE/下载）不适合；
- **`ServerHttpRequest` 是不可变的**：修改要 `mutate()` 后构建新的 exchange。

### 流式与长连接

- **SSE/大文件下载**：网关支持流式转发，不要在过滤器里聚合响应体；设置合理的响应超时（长连接路由单独放宽）；
- **WebSocket**：Gateway 支持 `ws://`/`wss://` 路由；注意**空闲超时**与心跳、连接数上限；有大量长连接时考虑独立的接入层，见 [案例：实时推送系统设计详解](#/design/case-push)。

## 跨域、安全头与协议

| 方面 | 做法 |
| --- | --- |
| **CORS** | 在网关统一配置（`globalcors`），**不要网关与下游服务各配一份**导致重复头或冲突；生产限制允许的源，不用 `*` 加凭证 |
| **安全响应头** | 统一添加 `X-Content-Type-Options`、`Strict-Transport-Security` 等；去掉暴露内部实现的头（服务器版本、内部地址） |
| **HTTPS** | 通常在外层负载均衡/网关终止 TLS，注意 `X-Forwarded-*` 头可信链，获取真实客户端 IP 要信任受控代理 |
| **请求头大小** | 令牌过大会触发 431/400；调整头部大小限制并精简令牌 |
| **HTTP/2、gRPC** | 网关对 HTTP/2 与 gRPC 的支持要核对版本与配置；纯 gRPC 流量常用 Envoy/Nginx 等专用代理，见 [gRPC 与 Protobuf](#/mw/grpc) |
| **路径与编码** | 路径规范化，防止通过编码绕过路由与鉴权规则（如 `//`、`%2e%2e`），见 [Web 安全](#/security/web) |

## 可观测与性能调优

### 观测

- **访问日志与指标**：路由级 QPS、延迟分位、状态码分布、下游错误率、连接池使用、事件循环线程繁忙度；用 Micrometer + Prometheus；
- **链路追踪**：网关是 trace 起点，生成/接续 trace，采样率按需设置；
- **健康与就绪**：优雅上下线，实例下线前从注册中心/负载均衡摘除并等待在途请求完成；
- **审计与告警**：路由变更、5xx 突增、延迟突增、下游熔断状态。

### 调优清单

| 方向 | 做法 |
| --- | --- |
| **线程与内存** | 事件循环线程数默认随核数；限制堆外内存；监控直接内存；容器内存与 JVM 参数一致 |
| **连接池** | 调整到下游的最大连接数、空闲回收、获取连接超时；避免因连接池耗尽出现“排队型”延迟 |
| **过滤器开销** | 精简全局过滤器数量；避免在每个请求上做重 JSON 解析、正则、加解密；鉴权结果可短期缓存 |
| **日志** | 异步日志，避免同步写盘阻塞；不要打印大 body |
| **GC** | 低延迟 GC，监控停顿 |
| **压测** | 用接近真实的路径与报文压测，观察事件循环繁忙度与下游，见 [压测方法与容量规划](#/design/eng-loadtest) |
| **部署** | 多实例横向扩展；与下游同机房；对外/对内/管理多套网关隔离故障域 |

## 常见线上问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 网关延迟高、CPU 低，下游正常 | 过滤器中阻塞调用占住事件循环 | 抓线程栈定位，改响应式或隔离线程池；BlockHound 检测 |
| 直接内存持续增长、`OutOfDirectMemoryError` | 读取请求体未释放 DataBuffer、响应体聚合过大 | 确保 release，限制体积，避免聚合流式响应 |
| 下游收到空请求体 | 过滤器读取了 body 未重新包装 | 用装饰器重新提供请求体 |
| 偶发 502/`Connection reset` | 连接池复用了已被下游/LB 关闭的空闲连接 | 网关空闲连接存活时间小于下游与 LB 的空闲超时，开启重试（仅幂等） |
| 新增路由后全站异常 | 路由顺序/匹配过宽覆盖了已有路由 | 变更前校验与灰度，路由 order 与冲突检测，一键回滚 |
| 配置中心故障后网关起不来或路由丢失 | 强依赖配置中心且无本地快照 | 本地快照兜底，启动容错 |
| 限流 Redis 故障导致大量请求失败 | 限流组件故障策略为失败即拒绝 | 失败放行/降级为本地限流，并告警 |
| 灰度用户来回切换版本 | 随机灰度无粘性 | 按用户哈希，粘性路由 |
| CORS 重复头/预检失败 | 网关与服务都配置了 CORS | 统一在网关处理，下游移除 |
| 实例下线时请求报错 | 未优雅下线，注册信息延迟摘除 | 先摘除再停止，等待在途请求，下游重试幂等读 |
| 超时层层不一致 | 网关、服务、客户端超时没有递减 | 统一超时预算：客户端 > 网关 > 服务 > 下游 |

## 选型：自研/Gateway/Nginx/Envoy/Kong

| 方案 | 特点 | 适合 |
| --- | --- | --- |
| **Spring Cloud Gateway** | 与 Spring 生态一致，Java 团队易扩展，过滤器编写方便；响应式有学习门槛 | Java 技术栈，业务定制多 |
| **Nginx / OpenResty** | 性能极高，稳定，Lua 可扩展；动态配置与治理能力需自建 | 流量入口、静态路由、高性能反向代理；常置于 Gateway 之前，见 [Nginx 与负载均衡](#/infra/nginx) |
| **Envoy / Istio Ingress** | 云原生标准，丰富的流量治理、gRPC 支持好 | K8s 与服务网格场景 |
| **Kong / APISIX** | 插件生态丰富，控制台成熟，基于 Nginx 内核 | 希望开箱即用的 API 管理与插件 |
| **云厂商网关** | 免运维、集成云服务 | 上云团队，成本可接受 |

常见分层：**外层 LB/Nginx（TLS、WAF、粗粒度限流）→ Spring Cloud Gateway（鉴权、路由、灰度、业务相关限流）→ 微服务**。选型时优先考虑团队能力与运维成本。网关整体设计与取舍见 [案例：API 网关设计详解](#/design/case-gateway)。

## 相关阅读

- [Spring Cloud 微服务全景](#/spring/cloud)：网关在微服务体系中的位置
- [案例：API 网关设计详解](#/design/case-gateway)：网关的整体架构、鉴权、限流与灰度
- [微服务安全：网关鉴权、服务间认证与令牌传递](#/spring/cloud-security)：认证授权的分工
- [配置管理与全链路灰度](#/spring/cloud-config-gray)：动态路由与灰度的配置治理
- [Netty 实战：编解码、内存与调优](#/infra/netty-practice)：Reactor Netty 的底层机制与直接内存

## 面试追问

> [!QUESTION] Spring Cloud Gateway 的原理是什么？和 Zuul 1.x 有什么区别？
> 基于 WebFlux 与 Reactor Netty，少量事件循环线程异步处理大量连接；请求经路由匹配（Predicate）后组装全局与路由过滤器链，按 order 执行前置逻辑，再由转发过滤器调用下游，响应反向执行后置逻辑。Zuul 1.x 是 Servlet 阻塞模型，每个请求占用一个线程，高并发下线程开销大。

> [!QUESTION] 在网关过滤器里能做阻塞调用吗？为什么？
> 不能。事件循环线程数很少，一次阻塞就会卡住它负责的所有连接，表现为延迟飙升而 CPU 不高。需要用响应式客户端（WebClient、响应式 Redis），或把必须阻塞的操作调度到专用有界线程池，并用 BlockHound 等工具在测试中发现阻塞调用。

> [!QUESTION] 网关里读取了请求体，下游收到空数据，为什么？
> 请求体是只能消费一次的流，读取后没有重新提供。需要用 DataBufferUtils 聚合并释放缓冲，再通过 ServerHttpRequestDecorator 重写 getBody 把缓存的字节重新提供给下游；还要注意释放 DataBuffer 防止直接内存泄漏，并避免读取大请求体。

> [!QUESTION] 网关的鉴权应该怎么做？服务还需要再鉴权吗？
> 网关本地验签 JWT（缓存公钥），完成认证与粗粒度授权，清除外部伪造的内部头后写入可信的用户与租户头。服务仍需做资源级授权，不能因为网关已校验就信任一切，因为内部也可能被绕过或误调用。

> [!QUESTION] 动态路由怎么做才安全？
> 路由放配置中心并版本化，网关监听变更，先校验路径冲突、目标服务和参数合法性，不合法则拒绝保留旧路由；按网关实例灰度生效，观察后全量，保留历史版本一键回滚；变更审计，大促冻结；配置中心故障时用本地快照兜底，避免网关起不来或清空路由。

> [!QUESTION] 网关偶发 502、Connection reset 怎么排查？
> 常见是连接池复用了已被下游或负载均衡关闭的空闲连接。要让网关到下游的空闲连接存活时间小于下游和负载均衡的空闲超时，对幂等请求开启退避重试，同时检查下游实例是否优雅下线、注册信息是否及时摘除。
