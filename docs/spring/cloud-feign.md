---
level: 深入
tags: [OpenFeign, 声明式客户端, 负载均衡, 超时, 重试, 拦截器, ErrorDecoder, 连接池, 上下文透传, HTTP Interface, 微服务调用]
summary: OpenFeign 的深入实践：@FeignClient 到 HTTP 请求的完整调用链、Contract/Encoder/Decoder/Client 的扩展点、超时与重试的放大效应及正确配置、错误处理与 ErrorDecoder、请求拦截与上下文透传（鉴权、灰度、追踪）、连接池与性能、熔断降级集成、常见坑，以及与 RestClient/HTTP Interface 的取舍。
---

# OpenFeign 深入：调用链、超时重试与上下文透传

> [!ABSTRACT] 核心要点
> - OpenFeign 的本质：**把接口方法通过动态代理翻译成 HTTP 调用**——解析注解得到请求模板，经编码、拦截、**负载均衡选实例**、HTTP 客户端发送，再解码响应。它是**同步阻塞**的调用方式，线程会在等待响应时被占用。
> - **线上事故 80% 出在三件事**：①**超时**没设或上下游不递减（线程池被慢下游拖死）；②**重试**对非幂等写接口开启（重复下单、重复扣款）；③**上下文透传**缺失（token、灰度标、traceId 在跨服务时丢失，或在线程切换后丢失）。
> - 默认配置只适合 Demo：**必须显式设置连接/读取超时、使用连接池客户端（HttpClient5/OkHttp）、关闭对写接口的重试、生产只开 BASIC 日志**。
> - **错误处理要有契约**：下游返回的错误体用 `ErrorDecoder` 统一翻译为业务异常；区分**业务失败（不应重试、不应熔断）**与**系统失败（超时、5xx，可重试/熔断）**。
> - 熔断降级用 Sentinel 或 Resilience4j 集成（见 [熔断限流实战](#/spring/cloud-resilience)）；fallback 只做**简单、无外部依赖**的兜底，不要在降级里再发远程调用。
> - 新项目也可评估 Spring 6 的 **RestClient / HTTP Interface**（同样是声明式、官方内建）；但存量体系里 OpenFeign 仍是主流，关键是用对。

## 调用链路

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="OpenFeign 一次调用的完整链路：业务代码调用接口代理，Contract 解析注解生成请求模板，Encoder 编码请求体，RequestInterceptor 追加请求头，LoadBalancer 把服务名解析为实例地址，Client 通过连接池发出 HTTP 请求，Decoder 解码响应，错误响应经 ErrorDecoder 转为异常，Retryer 与熔断在外层控制">
<rect class="b3" x="20" y="30" width="120" height="56" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">业务代码</text>
<text class="ts" x="80" y="72" text-anchor="middle">调用接口方法</text>
<rect class="b5" x="160" y="30" width="120" height="56" rx="8"/>
<text class="tb" x="220" y="52" text-anchor="middle" dominant-baseline="middle">动态代理</text>
<text class="ts" x="220" y="72" text-anchor="middle">按方法分发</text>
<rect class="b1" x="300" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="365" y="52" text-anchor="middle" dominant-baseline="middle">Contract</text>
<text class="ts" x="365" y="72" text-anchor="middle">注解→请求模板</text>
<rect class="b4" x="450" y="30" width="120" height="56" rx="8"/>
<text class="tb" x="510" y="52" text-anchor="middle" dominant-baseline="middle">Encoder</text>
<text class="ts" x="510" y="72" text-anchor="middle">对象→请求体</text>
<rect class="b2" x="590" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="665" y="52" text-anchor="middle" dominant-baseline="middle">RequestInterceptor</text>
<text class="ts" x="665" y="72" text-anchor="middle">追加头·透传上下文</text>
<line class="l" x1="140" y1="58" x2="160" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="58" x2="300" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="58" x2="450" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="58" x2="590" y2="58" marker-end="url(#arr)"/>
<rect class="b5" x="590" y="116" width="150" height="56" rx="8"/>
<text class="tb" x="665" y="138" text-anchor="middle" dominant-baseline="middle">LoadBalancer</text>
<text class="ts" x="665" y="158" text-anchor="middle">服务名→实例地址</text>
<rect class="b1" x="430" y="116" width="140" height="56" rx="8"/>
<text class="tb" x="500" y="138" text-anchor="middle" dominant-baseline="middle">HTTP Client</text>
<text class="ts" x="500" y="158" text-anchor="middle">连接池·超时</text>
<rect class="b3" x="270" y="116" width="140" height="56" rx="8"/>
<text class="tb" x="340" y="138" text-anchor="middle" dominant-baseline="middle">下游服务</text>
<text class="ts" x="340" y="158" text-anchor="middle">返回响应</text>
<rect class="b4" x="110" y="116" width="140" height="56" rx="8"/>
<text class="tb" x="180" y="138" text-anchor="middle" dominant-baseline="middle">Decoder</text>
<text class="ts" x="180" y="158" text-anchor="middle">成功→对象</text>
<line class="l" x1="665" y1="86" x2="665" y2="116" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="144" x2="570" y2="144" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="144" x2="410" y2="144" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="144" x2="250" y2="144" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="116" width="70" height="56" rx="8"/>
<text class="ts" x="55" y="134" text-anchor="middle" dominant-baseline="middle">Error</text>
<text class="ts" x="55" y="154" text-anchor="middle" dominant-baseline="middle">Decoder</text>
<line class="ld" x1="180" y1="172" x2="55" y2="172"/>
<rect class="bg" x="20" y="196" width="720" height="124" rx="8"/>
<text class="th" x="32" y="216">外层控制（包裹整个调用）</text>
<text class="ts" x="380" y="242" text-anchor="middle">Retryer：失败重试（Feign 自带默认关闭）；LoadBalancer 重试：换实例重试（Spring Cloud 提供，注意只对幂等请求）</text>
<text class="ts" x="380" y="264" text-anchor="middle">熔断/限流/舱壁：Sentinel 或 Resilience4j 在代理层拦截，失败快速返回 fallback</text>
<text class="ts" x="380" y="286" text-anchor="middle">指标与追踪：Micrometer 记录耗时与状态码，Tracing 把 trace 上下文写入请求头</text>
<text class="ts" x="380" y="308" text-anchor="middle">任何一环缺配置都会变成线上隐患：超时、重试、连接池、透传、错误翻译</text>
</svg>
<figcaption>图 1：OpenFeign 一次调用的链路与扩展点</figcaption>
</figure>

### 核心扩展点

| 扩展点 | 作用 | 常见用法 |
| --- | --- | --- |
| **Contract** | 解析接口注解（Spring 注解 `@GetMapping`、`@RequestParam` 等，由 `SpringMvcContract` 实现） | 一般不改；注意 `@RequestParam`、`@PathVariable` 的名称必须显式写出 |
| **Encoder / Decoder** | 请求体编码、响应体解码（默认 Jackson） | 统一返回包装 `Result<T>` 的拆包、日期格式、Protobuf 等 |
| **ErrorDecoder** | 把非 2xx 响应转成异常 | 翻译业务错误码、区分可重试异常 |
| **RequestInterceptor** | 在发送前修改请求 | 透传 token、traceId、灰度标签、租户 |
| **Client** | 实际发 HTTP 的实现（JDK 默认、HttpClient5、OkHttp） | **生产使用连接池实现** |
| **Retryer** | 重试策略 | 默认不重试；自定义时限制次数与退避 |
| **Logger.Level** | 日志级别 | 生产 BASIC；排查时临时 FULL |
| **Capability** | 对 Feign 构造过程的横向增强 | 指标（Micrometer）、熔断 |

**配置层级**：全局默认 `default` 与按客户端名称（`contextId`）的配置，后者覆盖前者；`@FeignClient(configuration=...)` 指定的配置类**不要被组件扫描到全局**，否则会对所有 Client 生效（常见踩坑）。

## 超时、重试与雪崩

### 超时必须显式配置

```yaml
spring:
  cloud:
    openfeign:
      httpclient:
        hc5:
          enabled: true                       # 使用 HttpClient5 连接池
        max-connections: 500                  # 总连接数
        max-connections-per-route: 100        # 每个目标主机
      client:
        config:
          default:
            connect-timeout: 1000             # 毫秒：建立连接
            read-timeout: 3000                # 毫秒：读取响应
            logger-level: BASIC
          stock-service:                      # 针对某个下游单独调
            read-timeout: 800
```

要点：

- **超时来自 SLA，而不是随便写**：下游 P99 的 2~3 倍作为起点，再结合上游整体预算；
- **连接超时短、读取超时按接口特性**：连接超时一般 1~2 秒；慢接口（导出、批处理）改成**异步任务**而不是拉长超时；
- **按下游分别配置**，不要全局一个值；
- **超时之后下游可能仍在处理**：写接口超时 ≠ 失败，需要幂等或查询确认，见 [分布式事务](#/distributed/transaction)。

### 超时预算递减与重试放大

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="超时与重试在调用链上的放大：网关到服务 A 到服务 B 到服务 C，若每层读超时 5 秒且重试 2 次，则 C 变慢时 A 最多等待 45 秒；正确做法是超时自内向外递增、重试只在最外层或幂等读接口、使用熔断与舱壁限制并发">
<rect class="b3" x="20" y="40" width="110" height="54" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="75" y="82" text-anchor="middle">读超时 10s</text>
<rect class="b5" x="170" y="40" width="110" height="54" rx="8"/>
<text class="tb" x="225" y="62" text-anchor="middle" dominant-baseline="middle">服务 A</text>
<text class="ts" x="225" y="82" text-anchor="middle">读超时 5s</text>
<rect class="b1" x="320" y="40" width="110" height="54" rx="8"/>
<text class="tb" x="375" y="62" text-anchor="middle" dominant-baseline="middle">服务 B</text>
<text class="ts" x="375" y="82" text-anchor="middle">读超时 5s</text>
<rect class="b4" x="470" y="40" width="110" height="54" rx="8"/>
<text class="tb" x="525" y="62" text-anchor="middle" dominant-baseline="middle">服务 C</text>
<text class="ts" x="525" y="82" text-anchor="middle">变慢/故障</text>
<line class="l" x1="130" y1="67" x2="170" y2="67" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="67" x2="320" y2="67" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="67" x2="470" y2="67" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="120" width="360" height="150" rx="8"/>
<text class="th" x="32" y="140">错误配置的后果</text>
<text class="ts" x="200" y="166" text-anchor="middle">每层“读超时 5s + 重试 2 次（共 3 次）”</text>
<text class="ts" x="200" y="188" text-anchor="middle">C 慢时：B 等 15s，A 对 B 重试再乘 3 ⇒ 约 45s</text>
<text class="ts" x="200" y="210" text-anchor="middle">上游早已超时放弃，下游仍在重复处理（无效劳动）</text>
<text class="ts" x="200" y="232" text-anchor="middle">线程与连接被占满 → 整条链路雪崩</text>
<text class="ts" x="200" y="254" text-anchor="middle">非幂等写接口被重复执行 → 数据错误</text>
<rect class="b2" x="400" y="120" width="340" height="150" rx="8"/>
<text class="th" x="412" y="140">正确做法</text>
<text class="ts" x="570" y="166" text-anchor="middle">超时预算由外向内递减：10s &gt; 5s &gt; 2s</text>
<text class="ts" x="570" y="188" text-anchor="middle">重试只在一层做，且只对幂等读（或带幂等键）</text>
<text class="ts" x="570" y="210" text-anchor="middle">重试必须退避+抖动，并受重试预算限制</text>
<text class="ts" x="570" y="232" text-anchor="middle">熔断 + 舱壁：快速失败，限制占用线程数</text>
<text class="ts" x="570" y="254" text-anchor="middle">传递截止时间（deadline），下游发现已超时就不再处理</text>
</svg>
<figcaption>图 2：超时重试的放大效应与正确做法</figcaption>
</figure>

| 项 | 推荐做法 |
| --- | --- |
| **Feign Retryer** | 默认 `NEVER_RETRY`，保持；自定义时仅用于**幂等读** |
| **LoadBalancer 重试** | `spring.cloud.loadbalancer.retry.enabled` 默认对 GET 重试；**显式限制 `max-retries-on-next-service-instance`** 并确认不对 POST 生效 |
| **写接口** | **不要自动重试**；要重试就带**幂等键**（请求 ID）并在服务端去重，见 [分布式 ID 生成](#/distributed/id) 与 [事件驱动架构](#/design/event-driven) |
| **重试位置** | 只在**离用户最近的一层**（网关或入口服务）做；中间层不叠加 |
| **退避与限流** | 指数退避 + 随机抖动；对失败率高的下游启用**重试预算**（重试流量不超过正常流量的一定比例） |
| **截止时间传递** | 入口计算整体 deadline 放入请求头，下游剩余时间不足时直接快速失败 |
| **熔断** | 慢调用比例、错误率超阈值时熔断，避免持续冲击故障下游，见 [限流、熔断与降级](#/distributed/governance) |

## 错误处理

### 区分业务失败与系统失败

| 类型 | 例子 | 处理 |
| --- | --- | --- |
| **业务失败** | 库存不足、参数不合法、余额不足 | 翻译为**业务异常**向上抛；**不重试、不计入熔断**；展示给用户 |
| **系统失败** | 超时、连接拒绝、5xx、实例不可用 | 可重试（幂等）、计入熔断统计、触发降级 |
| **协议/契约失败** | 4xx 解析失败、字段缺失 | 视为缺陷，告警；不要无限重试 |

约定下游的错误返回格式（HTTP 状态码 + 错误码 + 消息 + traceId），在调用方用 `ErrorDecoder` 统一解析：

```java
public class BizErrorDecoder implements ErrorDecoder {
    private final ErrorDecoder fallback = new ErrorDecoder.Default();

    @Override
    public Exception decode(String methodKey, Response resp) {
        int status = resp.status();
        if (status == 400 || status == 409 || status == 422) {
            // 业务错误：读取统一错误体，抛业务异常（不应重试、不应熔断）
            ApiError err = readBody(resp, ApiError.class);
            return new BizException(err.getCode(), err.getMessage());
        }
        if (status == 429 || status == 503) {
            // 可重试的系统错误：带上 Retry-After 信息
            return new RetryableException(status, "downstream busy", resp.request().httpMethod(),
                    (Long) null, resp.request());   // 是否真正重试由 Retryer 与幂等性决定
        }
        return fallback.decode(methodKey, resp);
    }
}
```

要点：

- **不要吞异常**：降级返回默认值会掩盖问题，必须记录指标和日志（带 traceId）；
- **熔断统计要忽略业务异常**（Sentinel/Resilience4j 都支持“忽略异常列表”），否则“用户输错参数”会把熔断器打开；
- **统一返回包装 `Result<T>`** 的体系里，HTTP 200 里装业务失败码，调用方要自己判断 `code`，建议封装统一的“拆包”工具，而不是到处手写 `if (!result.isSuccess())`；
- **fallbackFactory** 能拿到异常原因，优先于 `fallback`；降级逻辑保持简单（返回缓存、默认值、空集合），**不要在降级里再调远程服务**。

## 请求拦截与上下文透传

微服务调用要在多个服务间**传递上下文**：身份、租户、灰度标签、追踪、语言、幂等键。

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="上下文透传：入口网关解析令牌并生成内部上下文头，入站拦截器把请求头放入线程上下文，业务代码调用 Feign，出站拦截器把线程上下文重新写入请求头；线程池和异步调用会丢失线程上下文，需要显式传递；消息队列也要把上下文放在消息头里">
<rect class="b3" x="20" y="40" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="62" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="80" y="84" text-anchor="middle">验令牌·生成内部头</text>
<rect class="b5" x="170" y="20" width="250" height="110" rx="8"/>
<text class="tb" x="295" y="38" text-anchor="middle" dominant-baseline="middle">服务 A</text>
<rect class="b1" x="184" y="50" width="100" height="30" rx="6"/>
<text class="ts" x="234" y="65" text-anchor="middle" dominant-baseline="middle">入站过滤器</text>
<rect class="b2" x="294" y="50" width="112" height="30" rx="6"/>
<text class="ts" x="350" y="65" text-anchor="middle" dominant-baseline="middle">线程上下文</text>
<rect class="b4" x="184" y="90" width="222" height="30" rx="6"/>
<text class="ts" x="295" y="105" text-anchor="middle" dominant-baseline="middle">出站 RequestInterceptor 写回请求头</text>
<rect class="b3" x="450" y="40" width="120" height="70" rx="8"/>
<text class="tb" x="510" y="62" text-anchor="middle" dominant-baseline="middle">服务 B</text>
<text class="ts" x="510" y="84" text-anchor="middle">同样入站解析</text>
<rect class="b2" x="600" y="40" width="140" height="70" rx="8"/>
<text class="tb" x="670" y="62" text-anchor="middle" dominant-baseline="middle">服务 C …</text>
<text class="ts" x="670" y="84" text-anchor="middle">逐层透传</text>
<line class="l" x1="140" y1="75" x2="170" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="75" x2="450" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="75" x2="600" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="150" width="720" height="146" rx="8"/>
<text class="th" x="32" y="170">透传什么、怎么传、哪里会丢</text>
<text class="ts" x="380" y="196" text-anchor="middle">传：用户/租户 ID（内部头，不是原始令牌）、traceId/spanId、灰度标签、请求来源、语言区域、幂等键、截止时间</text>
<text class="ts" x="380" y="218" text-anchor="middle">不要无脑透传：外部请求带来的内部头必须在网关清除再重新生成，防止伪造“我是管理员”</text>
<text class="ts" x="380" y="240" text-anchor="middle">会丢：@Async/线程池/CompletableFuture 切线程后 ThreadLocal 丢失 → 装饰线程池或用可传递上下文</text>
<text class="ts" x="380" y="262" text-anchor="middle">会丢：响应式链路里 ThreadLocal 无效 → 用 Reactor Context；消息要写进消息头再恢复</text>
<text class="ts" x="380" y="284" text-anchor="middle">会丢：旧栈线程隔离与定时任务；排查：每一跳打印 traceId，看在哪一跳消失</text>
</svg>
<figcaption>图 3：请求上下文在服务间的透传路径与易丢位置</figcaption>
</figure>

```java
@Component
public class ContextRelayInterceptor implements RequestInterceptor {
    // 只透传白名单头，避免把外部随意头带到下游
    private static final List<String> RELAY = List.of("X-User-Id", "X-Tenant-Id", "X-Gray-Tag", "X-Request-Id");

    @Override
    public void apply(RequestTemplate template) {
        RequestContext ctx = RequestContextHolder.current();   // 线程上下文（入站过滤器填充）
        if (ctx == null) return;                               // 定时任务/异步线程可能没有
        RELAY.forEach(h -> {
            String v = ctx.header(h);
            if (v != null) template.header(h, v);
        });
        // 令牌：对内可用“内部调用令牌”，而不是转发用户的原始令牌（见微服务安全）
        template.header("X-Internal-Token", internalTokenProvider.token());
        // 剩余时间预算：下游据此决定是否还值得处理
        template.header("X-Deadline", String.valueOf(ctx.deadlineMillis()));
    }
}
```

> [!WARNING] 异步与响应式场景
> `RequestContextHolder` 之类基于 ThreadLocal 的实现，在 `@Async`、线程池、响应式链路中会拿不到值，Feign 调用时就**默默不带头**，表现为“偶发无权限/灰度失效/链路断裂”。应对：线程池使用上下文装饰器，或在提交任务时显式把上下文作为参数传入。

## 连接池、性能与资源

| 方面 | 要点 |
| --- | --- |
| **HTTP 客户端** | 使用 HttpClient5 或 OkHttp 的**连接池**；JDK 默认客户端每次调用性能和可调性较差 |
| **连接池大小** | 总连接数与单路由连接数按**并发度 × 下游数量**估算；过小会在池里排队（表现为耗时升高但下游不忙），过大浪费并冲击下游 |
| **连接存活** | 设置空闲连接回收与存活时间，避免用到下游已关闭的连接（偶发 `Connection reset`）；留意负载均衡/网关的空闲超时，客户端存活时间要**小于**它们 |
| **线程池** | Feign 同步调用占用**调用方线程**（Tomcat 线程）；下游变慢会耗尽线程，需熔断与舱壁（并发数限制）保护 |
| **压缩** | 大响应开启 gzip，小响应不要压缩（得不偿失） |
| **大对象/文件** | 不要用 Feign 传大文件/大报文；用对象存储预签名 URL，见 [对象存储与文件服务](#/design/case-objectstore) |
| **序列化** | 默认 JSON；热点内部调用可考虑 Protobuf/gRPC，见 [gRPC 与 Protobuf](#/mw/grpc) |
| **日志** | 生产 BASIC，避免 FULL 打印请求/响应体（性能与敏感信息泄露） |
| **指标** | 按下游、方法记录耗时分位、错误率、重试次数、连接池使用与等待，接入 [指标监控](#/infra/obs-metrics) |

## 常见坑

| 坑 | 说明与处理 |
| --- | --- |
| **GET 带请求体 / 参数对象** | GET 的复杂参数要用 `@SpringQueryMap`；`@RequestBody` 在 GET 上会被转成 POST 或被忽略，行为不一致 |
| **`@RequestParam`/`@PathVariable` 不写名称** | Feign 不像 MVC 能从参数名推断（编译参数问题），务必显式写 `value` |
| **同一服务名多个 @FeignClient** | 需要用 `contextId` 区分，否则 Bean 冲突 |
| **全局配置类被扫描** | `@FeignClient(configuration=...)` 的配置类放到扫描范围外，或避免 `@Configuration` 注解造成全局生效 |
| **fallback 不生效** | 需开启对应熔断集成（如 `spring.cloud.openfeign.circuitbreaker.enabled`），Sentinel/Resilience4j 依赖是否引入，fallback 类要是 Spring Bean |
| **返回 `ResponseEntity` 与异常** | 默认非 2xx 抛 `FeignException`；需要读取状态码时可用 `ResponseEntity` 或自定义 ErrorDecoder |
| **日期/枚举序列化不一致** | 调用双方 Jackson 配置不同导致解析失败；用共享的接口模型 + 统一序列化配置，并在 CI 做契约测试 |
| **接口模型共享引发紧耦合** | 提供方发布 `api` 模块被调用方依赖，字段变更会级联编译失败；采用**向后兼容演进**（只增不删），或用契约测试（如基于消费者的契约）替代共享类 |
| **服务启动时第一次调用慢** | 懒加载 Client/负载均衡器、预热不足；可开启 Feign 预热或启动后主动调用探活 |
| **线程上下文丢失** | 见上节，异步与响应式需显式传递 |
| **超时配置名称写错不报错** | 配置错位等于没配；用集成测试或启动日志核对生效值 |
| **重试导致重复写入** | 写接口禁止自动重试；使用幂等键 |

## 契约与演进

- **接口兼容性**：新增字段给默认值、不删除/改类型/改含义，破坏性变更走新版本接口（路径或头带版本），和 [Kafka 生态](#/mw/kafka-ecosystem) 中的 Schema 兼容性思路一致；
- **消费者驱动契约测试**：调用方声明期望，提供方在 CI 验证，防止“我改了字段，下游线上挂了”；
- **接口文档**：OpenAPI 描述作为契约，生成客户端或校验；
- **API 版本与灰度**：新旧接口并存，依赖元数据路由实现灰度，见 [配置管理与全链路灰度](#/spring/cloud-config-gray)。

## OpenFeign 与 RestClient / HTTP Interface

Spring 6 / Boot 3 提供了内建的声明式 HTTP 客户端（**HTTP Interface**，底层可用 `RestClient`/`WebClient`）：

```java
@HttpExchange("/stock")
public interface StockApi {
    @PostExchange("/deduct")
    Result<Boolean> deduct(@RequestBody DeductRequest req);
}

// 通过代理工厂创建，底层使用 RestClient（同步）或 WebClient（响应式）
RestClient rc = RestClient.builder().baseUrl("http://stock-service").build();
StockApi api = HttpServiceProxyFactory.builderFor(RestClientAdapter.create(rc)).build()
        .createClient(StockApi.class);
```

| 对比 | OpenFeign | HTTP Interface + RestClient |
| --- | --- | --- |
| 来源 | Spring Cloud 集成（Netflix → 社区） | Spring Framework 内建 |
| 与 Spring Cloud 集成度 | 高：负载均衡、熔断、拦截器开箱即用 | 需配置负载均衡拦截器、熔断等（可用 `@LoadBalanced` 的 Builder） |
| 生态与存量 | 非常多，文档案例丰富 | 较新，案例逐步增多 |
| 响应式 | 不支持 | 可用 WebClient |
| 迁移成本 | — | 注解风格相近，可逐步替换 |

经验：**存量项目不必为换而换**，保持 OpenFeign 并把超时、重试、透传、连接池做对；新项目或需要响应式时评估 HTTP Interface。具体项目状态与建议以官方文档和发布说明为准。

## 相关阅读

- [Spring Cloud 微服务全景](#/spring/cloud)：组件分工与版本对应
- [熔断限流实战：Sentinel 与 Resilience4j](#/spring/cloud-resilience)：Feign 的熔断与舱壁
- [微服务安全：网关鉴权、服务间认证与令牌传递](#/spring/cloud-security)：跨服务的身份传递
- [限流、熔断与降级](#/distributed/governance)：治理原理与算法
- [Dubbo 集群容错与服务治理](#/mw/dubbo-practice)：RPC 框架中的同类问题

## 面试追问

> [!QUESTION] OpenFeign 的调用流程是什么？
> `@FeignClient` 接口被动态代理，调用方法时由 Contract 解析注解得到请求模板，Encoder 编码请求体，RequestInterceptor 追加请求头，LoadBalancer 把服务名解析成实例地址，Client（最好是连接池实现）发送 HTTP 请求，成功响应由 Decoder 解码，失败响应由 ErrorDecoder 转异常；外层有重试与熔断降级。

> [!QUESTION] Feign 的超时和重试怎么配置才不会引起雪崩？
> 显式配置连接和读取超时，并让超时预算由外向内递减；写接口不自动重试，需要重试就带幂等键；重试只在最外层或幂等读上做，使用指数退避与抖动并限制重试预算；配合熔断和舱壁限制并发，再传递截止时间让下游快速失败。否则多层“超时加重试”会把延迟放大几十倍并耗尽线程。

> [!QUESTION] 服务间的请求头（token、traceId、灰度标）怎么透传？有什么坑？
> 入站过滤器把头放进线程上下文，出站 RequestInterceptor 再写回 Feign 请求，只透传白名单头，网关要清除外部伪造的内部头。坑在线程池、@Async、CompletableFuture 和响应式链路里 ThreadLocal 丢失，需要装饰线程池或用 Reactor Context，消息队列则写进消息头；排查就看哪一跳 traceId 消失。

> [!QUESTION] Feign 的熔断统计应该包含业务异常吗？
> 不应该。库存不足、参数错误这类业务失败不代表下游不健康，不应重试也不应计入熔断，否则用户输错参数会把熔断器打开。应在 ErrorDecoder 中把业务错误翻译成业务异常，并在熔断配置里忽略这些异常，只统计超时、连接失败、5xx 等系统失败。

> [!QUESTION] fallback 里应该做什么？
> 只做简单、无外部依赖的兜底：返回缓存、默认值或空集合，并记录指标与日志，用 fallbackFactory 获取异常原因。不要在降级里再发远程调用，否则故障会连锁扩散；也不要吞掉异常掩盖问题。

> [!QUESTION] OpenFeign 和 Spring 6 的 HTTP Interface 怎么选？
> OpenFeign 与 Spring Cloud 的负载均衡、熔断、拦截器集成度高、存量多；HTTP Interface 是 Spring Framework 内建，底层可用 RestClient 或 WebClient，支持响应式，但需要自行配置负载均衡与熔断。存量项目不必为换而换，把超时、重试、透传和连接池做对更重要；新项目或需要响应式时可评估后者。
