---
level: 进阶
tags: [Spring Cloud, Nacos, OpenFeign, Gateway, LoadBalancer, 微服务, 链路追踪]
summary: 梳理微服务体系的组件分工：注册配置中心、服务调用与负载均衡、网关、治理与观测，讲清 Nacos、OpenFeign、Gateway 的核心原理和选型要点。
---

# Spring Cloud 微服务全景

> [!ABSTRACT] 核心要点
> - 微服务 = 服务拆分 + **注册发现、配置中心、服务调用、网关、熔断限流、链路追踪、分布式事务**这套基础设施，Spring Cloud 是对它们的编程抽象。
> - **Nacos**：临时实例走心跳（AP，Distro 协议），持久实例走 Raft（CP）；配置中心用**长轮询**实现准实时推送。
> - **OpenFeign** 把接口通过动态代理变成 HTTP 调用，叠加负载均衡、重试、熔断；**超时与重试配置**是线上事故高发区。
> - **Spring Cloud Gateway** 基于 WebFlux + Netty，路由 = 断言（Predicate）+ 过滤器（Filter），**不能写阻塞代码**。
> - 先有清晰的**服务边界**再谈框架：拆分过细会把本地调用变成分布式事务和网络故障。

## 全景图

<figure class="fig">
<svg viewBox="0 0 760 400" class="dg" role="img" aria-label="Spring Cloud 微服务体系的组件分层">
<rect class="b" x="20" y="20" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="40" text-anchor="middle" dominant-baseline="middle">客户端</text>
<line class="l" x1="130" y1="40" x2="190" y2="40" marker-end="url(#arr)"/>
<rect class="b1" x="190" y="20" width="190" height="40" rx="8"/>
<text class="tb" x="285" y="40" text-anchor="middle" dominant-baseline="middle">网关 Spring Cloud Gateway</text>
<text class="ts" x="285" y="78" text-anchor="middle">鉴权 · 限流 · 路由 · 灰度</text>
<line class="l" x1="285" y1="88" x2="285" y2="124" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="540" height="150" rx="12"/>
<text class="th" x="36" y="148">业务服务</text>
<rect class="b2" x="40" y="162" width="130" height="44" rx="8"/>
<text class="tb" x="105" y="184" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<rect class="b2" x="215" y="162" width="130" height="44" rx="8"/>
<text class="tb" x="280" y="184" text-anchor="middle" dominant-baseline="middle">库存服务</text>
<rect class="b2" x="390" y="162" width="130" height="44" rx="8"/>
<text class="tb" x="455" y="184" text-anchor="middle" dominant-baseline="middle">用户服务</text>
<line class="l" x1="170" y1="184" x2="215" y2="184" marker-end="url(#arr)"/>
<line class="l" x1="345" y1="184" x2="390" y2="184" marker-end="url(#arr)"/>
<text class="ts" x="192" y="174" text-anchor="middle">Feign</text>
<text class="ts" x="367" y="174" text-anchor="middle">Feign</text>
<text class="ts" x="290" y="236" text-anchor="middle">LoadBalancer 客户端负载均衡 · Sentinel 熔断限流 · Micrometer Tracing</text>
<text class="ts" x="290" y="256" text-anchor="middle">每个服务：Spring Boot + MyBatis + Redis + MQ</text>
<rect class="b3" x="590" y="124" width="150" height="150" rx="12"/>
<text class="th" x="665" y="148" text-anchor="middle">Nacos</text>
<text class="t" x="665" y="178" text-anchor="middle">注册中心</text>
<text class="t" x="665" y="204" text-anchor="middle">配置中心</text>
<text class="ts" x="665" y="232" text-anchor="middle">服务上下线 / 配置热更新</text>
<line class="ld" x1="560" y1="199" x2="590" y2="199"/>
<rect class="b5" x="20" y="300" width="150" height="70" rx="10"/>
<text class="tb" x="95" y="322" text-anchor="middle" dominant-baseline="middle">数据层</text>
<text class="ts" x="95" y="344" text-anchor="middle">MySQL · Redis · ES</text>
<rect class="b5" x="190" y="300" width="150" height="70" rx="10"/>
<text class="tb" x="265" y="322" text-anchor="middle" dominant-baseline="middle">消息队列</text>
<text class="ts" x="265" y="344" text-anchor="middle">Kafka · RocketMQ</text>
<rect class="b4" x="360" y="300" width="150" height="70" rx="10"/>
<text class="tb" x="435" y="322" text-anchor="middle" dominant-baseline="middle">分布式事务</text>
<text class="ts" x="435" y="344" text-anchor="middle">Seata · 本地消息表</text>
<rect class="b" x="530" y="300" width="210" height="70" rx="10"/>
<text class="tb" x="635" y="322" text-anchor="middle" dominant-baseline="middle">可观测</text>
<text class="ts" x="635" y="344" text-anchor="middle">Prometheus · SkyWalking · ELK</text>
</svg>
<figcaption>图 1：微服务体系组件全景</figcaption>
</figure>

## 版本对应（避免踩坑）

Spring Boot、Spring Cloud、Spring Cloud Alibaba 三者必须**配套**，不能随意混用；升级时先查官方版本对应表。

| Spring Boot | Spring Cloud | Spring Cloud Alibaba | JDK |
| --- | --- | --- | --- |
| 2.7.x | 2021.0.x | 2021.0.x | 8 / 11 |
| 3.0.x ~ 3.2.x | 2022.0.x ~ 2023.0.x | 2022.0.x ~ 2023.0.x | **17+** |
| 3.3.x | 2023.0.x | 2023.0.x | 17+ |

> [!NOTE] 以官方发布说明为准
> 上表只给出大致对应关系；具体小版本以 Spring Cloud / Spring Cloud Alibaba 官网的 release notes 为准。Spring Cloud Netflix 的 Ribbon、Hystrix、Zuul 已停止维护，对应替代为 LoadBalancer、Resilience4j/Sentinel、Gateway。

## 注册中心：Nacos

### 工作流程

1. 服务启动，**注册**（IP、端口、元数据）到 Nacos；
2. 临时实例通过**心跳**（默认 5s）续约；15s 无心跳标记为不健康，30s 摘除；
3. 消费者**拉取**服务列表缓存在本地，并通过 UDP / gRPC 接收变更推送；
4. 服务下线时主动注销。

### 临时与持久实例

| | 临时实例（默认） | 持久实例 |
| --- | --- | --- |
| 健康检查 | 客户端上报心跳 | 服务端主动探测 |
| 实例下线 | 心跳超时自动删除 | 保留，仅标记不健康 |
| 一致性协议 | **Distro**（AP，每个节点负责一部分数据，异步同步） | **Raft（CP）** |
| 适用 | 绝大多数微服务 | 需要服务端控制的基础组件 |

对比：

| | Nacos | Eureka | ZooKeeper | Consul |
| --- | --- | --- | --- | --- |
| CAP | AP/CP 可切换 | AP | CP | CP |
| 健康检查 | 心跳 / 探测 | 心跳 | 会话 + 临时节点 | 多种探测 |
| 配置中心 | **内置** | 无 | 可存 | KV |
| 维护状态 | 活跃 | 停更 | 活跃 | 活跃 |

注册中心短暂不可用时，客户端靠**本地缓存**继续调用；这是“注册中心选 AP”的原因：宁可调到过期实例（被重试/熔断兜底），也不能让整个调用链停摆。

### 配置中心：长轮询

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="Nacos 配置中心长轮询时序">
<rect class="b1" x="60" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="125" y="37" text-anchor="middle" dominant-baseline="middle">应用（客户端）</text>
<rect class="b3" x="540" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="605" y="37" text-anchor="middle" dominant-baseline="middle">Nacos Server</text>
<line class="ld" x1="125" y1="54" x2="125" y2="232"/>
<line class="ld" x1="605" y1="54" x2="605" y2="232"/>
<line class="l" x1="125" y1="84" x2="605" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="365" y="76" text-anchor="middle">① 长轮询：携带本地配置 MD5，超时 30s</text>
<text class="ts" x="620" y="114" text-anchor="start">② 无变更：挂起请求</text>
<text class="ta" x="620" y="134" text-anchor="start">③ 管理员发布新配置</text>
<line class="la" x1="605" y1="160" x2="125" y2="160" marker-end="url(#arr-a)"/>
<text class="ts" x="365" y="152" text-anchor="middle">④ 立即响应：返回变更的 dataId 列表</text>
<line class="l" x1="125" y1="190" x2="605" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="365" y="182" text-anchor="middle">⑤ 拉取最新配置 → 触发 @RefreshScope / 监听器</text>
<text class="ts" x="365" y="224" text-anchor="middle">（2.x 起底层改为 gRPC 长连接推送变更，思路相同）</text>
</svg>
<figcaption>图 2：配置变更通过长轮询（或长连接）准实时下发</figcaption>
</figure>

```yaml
spring:
  application:
    name: order-service
  config:
    import: "nacos:order-service.yaml?refreshEnabled=true"   # Boot 2.4+/3.x 的 import 方式
  cloud:
    nacos:
      discovery:
        server-addr: nacos:8848
        namespace: prod         # 环境隔离
        group: DEFAULT_GROUP
      config:
        server-addr: nacos:8848
        file-extension: yaml
```

配置建议：用 **namespace 隔离环境**、group 隔离业务；敏感配置加密；配置变更要有灰度和回滚；`@RefreshScope` 的 Bean 刷新会重建，注意其中的有状态资源（连接池等）。

## 服务调用：OpenFeign

```java
@FeignClient(name = "stock-service", fallbackFactory = StockClientFallback.class)
public interface StockClient {
    @PostMapping("/stock/deduct")
    Result<Boolean> deduct(@RequestBody DeductRequest req);
}
```

### 调用链路

`@FeignClient` 接口 → **动态代理**（`ReflectiveFeignInvocationHandler`）→ 方法元数据解析为 HTTP 请求模板 → **Spring Cloud LoadBalancer** 从注册中心的实例列表中选一个 → HTTP 客户端发送（默认 `HttpURLConnection`，应换成 **Apache HttpClient5 / OkHttp** 以启用连接池）→ Decoder 解码响应。

### 超时、重试与熔断

| 项 | 要点 |
| --- | --- |
| 超时 | `spring.cloud.openfeign.client.config.default.connect-timeout=2000`、`read-timeout=5000`；**链路上游超时必须大于下游**之和，否则上游已超时下游还在执行 |
| 重试 | Feign 自带 `Retryer`（默认关闭），Spring Cloud LoadBalancer 的重试（`spring.cloud.loadbalancer.retry`）默认对 **GET** 重试；**非幂等的 POST 不要重试**，否则重复扣款 |
| 熔断降级 | 集成 Sentinel / Resilience4j，`fallbackFactory` 能拿到异常原因；降级逻辑要简单、无外部依赖 |
| 连接池 | `spring.cloud.openfeign.httpclient.hc5.enabled=true`，设置最大连接数与每路由连接数 |
| 日志 | 生产只开 BASIC 级别，FULL 会打印 body，性能与泄露风险高 |
| 传递请求头 | 用 `RequestInterceptor` 透传 token、traceId |

> [!WARNING] 超时叠加导致雪崩
> A → B → C，每层读超时 5s 且 3 次重试，C 变慢时 A 最多被拖 5×3×3 = 45s，线程池耗尽。应**自内向外递减超时**、限制重试次数、对下游做熔断与线程隔离，见 [限流、熔断与降级](#/distributed/governance)。

### 负载均衡

Spring Cloud LoadBalancer 内置**轮询**与**随机**，可自定义 `ReactorLoadBalancer`（加权、同机房优先、灰度标签）。客户端负载均衡的特点：调用方本地选择实例，不经过中心代理，无额外网络跳；缺点是每个客户端要维护实例列表与路由逻辑。

## 网关：Spring Cloud Gateway

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="Spring Cloud Gateway 请求处理流程">
<rect class="b" x="20" y="80" width="90" height="46" rx="8"/>
<text class="tb" x="65" y="103" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="bg" x="150" y="30" width="480" height="150" rx="12"/>
<text class="th" x="166" y="54">Gateway（Netty + WebFlux）</text>
<rect class="b3" x="170" y="76" width="120" height="50" rx="8"/>
<text class="tb" x="230" y="94" text-anchor="middle" dominant-baseline="middle">Handler Mapping</text>
<text class="ts" x="230" y="112" text-anchor="middle">匹配 Route</text>
<rect class="b1" x="320" y="76" width="130" height="50" rx="8"/>
<text class="tb" x="385" y="94" text-anchor="middle" dominant-baseline="middle">Pre Filters</text>
<text class="ts" x="385" y="112" text-anchor="middle">鉴权 / 限流 / 改写</text>
<rect class="b1" x="480" y="76" width="130" height="50" rx="8"/>
<text class="tb" x="545" y="94" text-anchor="middle" dominant-baseline="middle">Post Filters</text>
<text class="ts" x="545" y="112" text-anchor="middle">响应头 / 日志</text>
<line class="l" x1="290" y1="101" x2="320" y2="101" marker-end="url(#arr)"/>
<text class="ts" x="400" y="160" text-anchor="middle">NettyRoutingFilter 调用下游</text>
<line class="l" x1="110" y1="103" x2="170" y2="103" marker-end="url(#arr)"/>
<rect class="b2" x="660" y="80" width="70" height="46" rx="8"/>
<text class="tb" x="695" y="103" text-anchor="middle" dominant-baseline="middle">下游</text>
<line class="l" x1="450" y1="101" x2="480" y2="101" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="101" x2="660" y2="101" marker-end="url(#arr)"/>
</svg>
<figcaption>图 3：网关处理链路：路由匹配、前置过滤、转发、后置过滤</figcaption>
</figure>

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order
          uri: lb://order-service            # lb:// 表示通过 LoadBalancer 选实例
          predicates:
            - Path=/api/order/**
            - Header=X-Gray, true            # 灰度：带头的请求
          filters:
            - StripPrefix=1
            - name: RequestRateLimiter       # 基于 Redis 令牌桶
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@userKeyResolver}"
```

- **Route**（id、uri、predicates、filters）→ **Predicate** 决定“是否匹配”（Path/Header/Method/Weight…）→ **GlobalFilter / GatewayFilter** 修改请求与响应；
- 因为运行在少量 Netty 事件循环线程上，**过滤器里不能有阻塞调用**（同步 JDBC、`Thread.sleep`、阻塞式 Feign）；必须用响应式客户端，或切到弹性线程池；
- 常见职责：统一鉴权（JWT 校验）、限流、黑白名单、灰度路由、跨域、请求日志、协议转换；
- 网关自身需要多实例 + 外层 Nginx / SLB。

## 治理与观测

| 能力 | 常见组件 | 参考 |
| --- | --- | --- |
| 限流熔断降级 | Sentinel / Resilience4j | [限流、熔断与降级](#/distributed/governance) |
| 分布式事务 | Seata（AT/TCC）、本地消息表 | [分布式事务](#/distributed/transaction) |
| 链路追踪 | Micrometer Tracing + Zipkin、**SkyWalking**（Java Agent 无侵入） | traceId 透传到日志 MDC |
| 指标监控 | Micrometer + Prometheus + Grafana | Actuator 暴露 `/actuator/prometheus` |
| 日志 | ELK / Loki | 统一日志格式含 traceId |
| 服务网格 | Istio（把治理下沉到 sidecar） | 多语言团队可考虑，运维成本高 |

## 服务拆分原则

1. 围绕**业务能力 / 限界上下文**拆（订单、库存、用户），而非技术层（Controller 服务、DAO 服务）；
2. 每个服务**独占自己的数据库**，不跨库直连表；
3. 高内聚低耦合：频繁一起修改、一起发布的代码应在同一服务；
4. 同步调用尽量少，能异步（事件、MQ）就异步，减少调用链长度；
5. 团队规模与服务数量匹配（康威定律），不要“为了微服务而微服务”；
6. 基础设施先行：CI/CD、监控、日志、链路追踪、灰度能力不到位时，不宜大规模拆分。

## 相关阅读

- [gRPC 与 Protobuf：协议、流式调用与治理](#/mw/grpc)：服务间调用：gRPC
- [认证授权：Session、JWT、OAuth2 与 Spring Security](#/security/auth)：微服务统一认证
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：事件驱动与 Saga
- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：全链路追踪

## 面试追问

> [!QUESTION] Nacos 注册中心的 AP 与 CP 模式有什么区别？
> 临时实例使用 Distro 协议（AP）、客户端心跳续约，节点故障时仍可读写；持久实例用 Raft（CP），服务端主动健康检查，保证强一致。默认临时实例，更看重可用性。

> [!QUESTION] Nacos 配置中心如何做到动态刷新？
> 客户端长轮询（1.x）或 gRPC 长连接（2.x）监听配置的 MD5 / 版本，服务端发现变更立刻通知，客户端拉取新配置并触发监听器，`@RefreshScope` 重新创建 Bean。

> [!QUESTION] OpenFeign 的调用流程？
> 接口通过 JDK 动态代理生成实现，解析方法与注解生成请求模板，经 LoadBalancer 选择实例，由 HTTP 客户端发送并解码响应；可叠加拦截器、重试和熔断。

> [!QUESTION] 为什么 Gateway 里不能写阻塞代码？
> Gateway 基于 WebFlux + Netty，用少量事件循环线程处理大量连接，阻塞会占住事件循环导致其他请求都被卡住；需使用响应式客户端或将阻塞调用提交到有界弹性线程池。

> [!QUESTION] 微服务调用链路上如何防止雪崩？
> 超时自内向外递减、限制重试并仅对幂等操作重试、对下游熔断、线程池/信号量隔离、限流、降级兜底，并通过监控和链路追踪快速定位慢服务。
