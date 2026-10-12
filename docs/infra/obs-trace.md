---
level: 进阶
tags: [可观测性, 链路追踪, OpenTelemetry, SkyWalking, 日志, MDC, ELK, Loki, SLO, 告警]
summary: 分布式链路追踪（trace/span、W3C 上下文传播、OpenTelemetry Java Agent 与 Collector、采样策略）、结构化日志与 traceId 关联（MDC、ELK vs Loki）、SLO/错误预算/燃烧率告警，以及从指标到链路再到日志的完整排障流程。
---

# 链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO

> [!ABSTRACT] 核心要点
> - **链路追踪**把一次请求跨服务的调用串成一棵 **Trace（由多个 Span 组成）**，用来回答“**慢在哪一跳、错在哪个服务**”。关键是**上下文传播**：每次远程调用都要把 `traceId` 带过去（HTTP 头 `traceparent`、MQ 消息头、RPC 附件）。
> - **OpenTelemetry（OTel）** 是厂商中立的标准：**API/SDK + Collector + OTLP 协议**；Java 最省事是 **Java Agent 无侵入自动埋点**。后端存储可选 Jaeger/Tempo/SkyWalking/Elastic 等。
> - **采样**是成本与可见性的平衡：头部采样便宜但可能丢掉出错的链路；**尾部采样**在 Collector 中看完整链路再决定保留，能“保留所有错误和慢请求”。
> - **日志**要**结构化（JSON）+ 带 traceId**，并**控制成本**（分级、采样、保留期）；ELK 全文索引强大但贵，Loki 只索引标签、便宜。
> - **SLO** 把“可靠性”量化：用 **SLI（指标）→ SLO（目标）→ 错误预算 → 燃烧率告警**，避免凭感觉告警。

## 一、为什么需要链路追踪

单体时代看一个日志文件就能排查；微服务一次请求可能经过 网关 → 订单 → 库存 → 支付 → 数据库/缓存/MQ，**某个接口慢了，指标只能告诉你“整体 P99 变高”，不知道是哪一跳**。链路追踪还原整条调用的**时间线与依赖关系**。

<figure class="fig">
<svg viewBox="0 0 800 320" class="dg" role="img" aria-label="一次请求的调用链：网关 span 作为根，包含订单服务 span，订单服务又调用库存服务、支付服务和数据库 span；时间轴上可见支付服务耗时占大部分，定位慢点在支付调用">
<text class="th" x="20" y="26">Trace：traceId = 4bf92f3577b34da6…（时间轴 0 ~ 520 ms）</text>
<line class="ld" x1="200" y1="40" x2="200" y2="300"/>
<line class="ld" x1="400" y1="40" x2="400" y2="300"/>
<line class="ld" x1="600" y1="40" x2="600" y2="300"/>
<line class="ld" x1="780" y1="40" x2="780" y2="300"/>
<text class="ts" x="200" y="316" text-anchor="middle">100ms</text>
<text class="ts" x="400" y="316" text-anchor="middle">300ms</text>
<text class="ts" x="600" y="316" text-anchor="middle">450ms</text>
<text class="ts" x="20" y="62" text-anchor="start">gateway  POST /orders</text>
<rect class="b1" x="120" y="48" width="660" height="22" rx="4"/>
<text class="ts" x="20" y="102" text-anchor="start">order-service  createOrder</text>
<rect class="b3" x="140" y="88" width="620" height="22" rx="4"/>
<text class="ts" x="20" y="142" text-anchor="start">  ├ inventory  deduct</text>
<rect class="b2" x="170" y="128" width="130" height="22" rx="4"/>
<text class="ts" x="20" y="182" text-anchor="start">  ├ mysql  INSERT order</text>
<rect class="b5" x="310" y="168" width="60" height="22" rx="4"/>
<text class="ts" x="20" y="222" text-anchor="start">  └ payment  createPay</text>
<rect class="b4" x="380" y="208" width="370" height="22" rx="4"/>
<text class="ts" x="20" y="262" text-anchor="start">      └ 第三方渠道 HTTP</text>
<rect class="b4" x="430" y="248" width="300" height="22" rx="4"/>
<text class="ta" x="430" y="286" text-anchor="start">← 慢点：渠道调用约 300ms</text>
</svg>
<figcaption>图 1：调用链的瀑布图：一眼看出瓶颈在哪个 span</figcaption>
</figure>

### 基本概念

| 概念 | 说明 |
| --- | --- |
| **Trace** | 一次请求的完整调用链，全局唯一 `traceId`（16 字节） |
| **Span** | 链路中的一个操作（一次 HTTP 调用、一条 SQL、一次方法），有 `spanId`、`parentSpanId`、开始时间、耗时、状态 |
| **Attributes** | span 上的键值（`http.method`、`db.statement`、`user.tier`），遵循 OTel 语义约定 |
| **Events** | span 内的时间点事件（异常堆栈、重试） |
| **Links** | 关联其他 trace（如批处理消费多条消息） |
| **Baggage** | 随链路传播的业务键值（如租户 ID），**会随每个请求传递，要克制，别放敏感信息** |
| **SpanKind** | SERVER / CLIENT / PRODUCER / CONSUMER / INTERNAL |

## 二、上下文传播

关键在于**每次跨进程调用都要传递 trace 上下文**，否则链路会断开。

<figure class="fig">
<svg viewBox="0 0 780 230" class="dg" role="img" aria-label="上下文传播：服务 A 在出站请求头中写入 traceparent，服务 B 解析请求头后继续同一个 trace 并创建子 span；消息队列场景把上下文写入消息头，消费者解析后继续链路">
<rect class="b1" x="20" y="30" width="160" height="56" rx="8"/>
<text class="tb" x="100" y="52" text-anchor="middle" dominant-baseline="middle">服务 A</text>
<text class="ts" x="100" y="72" text-anchor="middle">span A (client)</text>
<rect class="b3" x="310" y="30" width="160" height="56" rx="8"/>
<text class="tb" x="390" y="52" text-anchor="middle" dominant-baseline="middle">服务 B</text>
<text class="ts" x="390" y="72" text-anchor="middle">span B (server)</text>
<rect class="b5" x="600" y="30" width="160" height="56" rx="8"/>
<text class="tb" x="680" y="52" text-anchor="middle" dominant-baseline="middle">服务 C（MQ 消费者）</text>
<text class="ts" x="680" y="72" text-anchor="middle">span C (consumer)</text>
<line class="l" x1="180" y1="58" x2="310" y2="58" marker-end="url(#arr)"/>
<text class="ts" x="245" y="50" text-anchor="middle">HTTP 头</text>
<line class="l" x1="470" y1="58" x2="600" y2="58" marker-end="url(#arr)"/>
<text class="ts" x="535" y="50" text-anchor="middle">消息头</text>
<rect class="bg" x="20" y="110" width="740" height="100" rx="10"/>
<text class="th" x="36" y="134">W3C Trace Context：traceparent: 00-{traceId 32位hex}-{parentSpanId 16位hex}-{flags 01=采样}</text>
<text class="ts" x="36" y="158">00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01</text>
<text class="ts" x="36" y="180">HTTP/gRPC/MQ 都靠“请求/消息头”携带；线程池、异步、响应式要靠 Context 传播机制，否则在线程切换处断链</text>
<text class="ts" x="36" y="198">旧协议：B3（Zipkin）、SkyWalking sw8、Jaeger uber-trace-id；OTel 默认 W3C，可配置多种并存</text>
</svg>
<figcaption>图 2：trace 上下文随请求头 / 消息头传递</figcaption>
</figure>

**Java 里最容易断链的位置**：

| 场景 | 原因 | 对策 |
| --- | --- | --- |
| 线程池 `execute/submit` | ThreadLocal 不跨线程 | OTel Agent 自动包装；或 `Context.taskWrapping(executor)`；`@Async` 用带上下文的 TaskDecorator |
| `CompletableFuture`、响应式 | 线程切换 | Agent 支持主流框架；响应式用 Reactor 的 context propagation |
| 消息队列 | 头里没带 | 使用对应 instrumentation（Kafka/RocketMQ/RabbitMQ），或手动在 header 注入与提取（见 [Kafka](#/mw/kafka)） |
| 自研 RPC/私有协议 | 没人帮你传 | 在拦截器里 `inject/extract` |
| 定时任务、批处理 | 没有入口请求 | 手动创建根 span |

## 三、OpenTelemetry

### 1. 组成

<figure class="fig">
<svg viewBox="0 0 800 260" class="dg" role="img" aria-label="OpenTelemetry 架构：应用内使用 API 与 SDK 或 Java Agent 产生 trace、指标、日志，通过 OTLP 协议发送到 OpenTelemetry Collector，Collector 经过接收、处理、导出流水线后分别写入 Tempo 或 Jaeger、Prometheus、Loki 或 Elasticsearch">
<rect class="b1" x="20" y="60" width="190" height="130" rx="12"/>
<text class="th" x="36" y="86">应用（Java）</text>
<text class="ts" x="36" y="110">OTel Java Agent（自动埋点）</text>
<text class="ts" x="36" y="130">或 API + SDK（手动埋点）</text>
<text class="ts" x="36" y="150">Traces · Metrics · Logs</text>
<text class="ts" x="36" y="170">资源属性：service.name…</text>
<rect class="b3" x="290" y="40" width="220" height="170" rx="12"/>
<text class="th" x="306" y="66">OTel Collector</text>
<rect class="b" x="306" y="80" width="188" height="28" rx="6"/>
<text class="ts" x="400" y="94" text-anchor="middle" dominant-baseline="middle">Receivers（OTLP…）</text>
<rect class="b" x="306" y="116" width="188" height="28" rx="6"/>
<text class="ts" x="400" y="130" text-anchor="middle" dominant-baseline="middle">Processors（批量/采样/脱敏）</text>
<rect class="b" x="306" y="152" width="188" height="28" rx="6"/>
<text class="ts" x="400" y="166" text-anchor="middle" dominant-baseline="middle">Exporters</text>
<line class="l" x1="210" y1="125" x2="290" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="250" y="117" text-anchor="middle">OTLP</text>
<rect class="b2" x="590" y="30" width="190" height="48" rx="8"/>
<text class="tb" x="685" y="54" text-anchor="middle" dominant-baseline="middle">Tempo / Jaeger / SkyWalking</text>
<rect class="b2" x="590" y="106" width="190" height="48" rx="8"/>
<text class="tb" x="685" y="130" text-anchor="middle" dominant-baseline="middle">Prometheus / Mimir</text>
<rect class="b2" x="590" y="182" width="190" height="48" rx="8"/>
<text class="tb" x="685" y="206" text-anchor="middle" dominant-baseline="middle">Loki / Elasticsearch</text>
<line class="l" x1="510" y1="100" x2="590" y2="54" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="125" x2="590" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="150" x2="590" y2="206" marker-end="url(#arr)"/>
<text class="ts" x="400" y="242" text-anchor="middle">应用只对接 OTLP；换后端只改 Collector 配置，不改业务代码</text>
</svg>
<figcaption>图 3：OpenTelemetry：统一采集标准，后端可替换</figcaption>
</figure>

### 2. Java Agent 接入（零代码）

```bash
java -javaagent:/opt/otel/opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -Dotel.exporter.otlp.endpoint=http://otel-collector:4317 \
     -Dotel.resource.attributes=deployment.environment=prod,service.version=1.8.2 \
     -Dotel.traces.sampler=parentbased_traceidratio \
     -Dotel.traces.sampler.arg=0.1 \
     -jar app.jar
```

Agent 通过字节码增强自动为 Spring MVC、RestTemplate/WebClient/OkHttp、JDBC、Redis（Lettuce/Jedis）、Kafka、gRPC、Dubbo 等生成 span 并传播上下文。（**升级版本前在预发验证**；Agent 有少量性能开销，通常在个位数百分比。）

### 3. 手动埋点（业务关键步骤）

```java
private static final Tracer tracer = GlobalOpenTelemetry.getTracer("com.example.order");

public Order createOrder(OrderReq req) {
    Span span = tracer.spanBuilder("order.create").setSpanKind(SpanKind.INTERNAL).startSpan();
    try (Scope ignored = span.makeCurrent()) {                       // 让子调用能继承当前 span
        span.setAttribute("order.channel", req.getChannel());       // 低基数、有分析价值的属性
        Order o = doCreate(req);
        span.setAttribute("order.amount", o.getAmountFen());
        return o;
    } catch (Exception e) {
        span.recordException(e);
        span.setStatus(StatusCode.ERROR, e.getMessage());
        throw e;
    } finally {
        span.end();                                                   // 一定要 end，否则 span 泄露不上报
    }
}
```

Spring 里也可用 `@Observed` / Micrometer Tracing 桥接 OTel，同一埋点同时产出指标与链路。

### 4. Collector 配置要点

```yaml
receivers:
  otlp: { protocols: { grpc: {}, http: {} } }
processors:
  memory_limiter: { check_interval: 1s, limit_mib: 1500 }     # 防 Collector 自己 OOM
  batch: {}                                                    # 批量发送，降低开销
  attributes/redact:                                           # 脱敏：删除敏感属性
    actions: [ { key: http.request.header.authorization, action: delete } ]
exporters:
  otlp/tempo: { endpoint: tempo:4317, tls: { insecure: true } }
service:
  pipelines:
    traces: { receivers: [otlp], processors: [memory_limiter, attributes/redact, batch], exporters: [otlp/tempo] }
```

部署模式：**Agent 模式**（每节点 DaemonSet，就近收集）+ **Gateway 模式**（集中处理：尾部采样、路由）。

### 5. 采样

全量采集成本极高（每个请求几十个 span）。**采样**决定保留哪些 trace。

| 策略 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **头部采样** | 链路**起点**按比例（如 10%）或规则决定，并通过 `flags` 传播给全链路 | 简单、开销小 | 起点不知道会不会出错 → **可能恰好丢掉出错/慢的链路** |
| **尾部采样** | Collector 收齐一条 trace 的所有 span 后再决策：**保留错误、保留慢请求、其余按比例** | **有价值的链路不丢** | Collector 需要缓存并按 traceId 路由（同一 trace 到同一实例），资源消耗大 |
| 自适应/限速 | 按服务每秒限制采集条数 | 可控成本 | 需要工具支持 |

推荐：**头部低比例 + 尾部保错/保慢**；关键接口（支付）提高采样率；`parentbased` 保证整条链路要么全采要么全不采。

### 6. 方案选型

| 方案 | 特点 |
| --- | --- |
| **OpenTelemetry + Tempo/Jaeger** | 标准化，云原生首选，多语言一致，生态最活跃 |
| **SkyWalking** | Java 友好、Agent 功能强、自带拓扑与告警 UI、国内使用广；协议为自有 + 兼容 OTel |
| Zipkin | 轻量老牌，功能相对简单 |
| 商业 APM（Datadog、New Relic、阿里 ARMS） | 开箱即用，成本高 |

链路追踪的价值不止排障：**服务依赖拓扑**、**慢调用分析**、**异常聚合**、**容量规划**。

## 四、日志

### 1. 结构化日志与 traceId

非结构化文本日志难以检索与聚合；用 **JSON 结构化**，并带上 `traceId`、`spanId`、`service`、`level`。OTel Agent 会自动把 `trace_id`、`span_id` 放入 **MDC**，在日志格式里引用即可：

```xml
<!-- logback：输出 JSON（logstash-logback-encoder），自动包含 MDC 字段 -->
<appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
  <encoder class="net.logstash.logback.encoder.LogstashEncoder">
    <includeMdcKeyName>trace_id</includeMdcKeyName>
    <includeMdcKeyName>span_id</includeMdcKeyName>
    <customFields>{"service":"order-service","env":"prod"}</customFields>
  </encoder>
</appender>
```

```java
// 业务上下文也放 MDC（注意：线程池里要传递并在 finally 清理，否则串号）
MDC.put("orderId", String.valueOf(orderId));
try { log.info("create order, amount={}", amount); } finally { MDC.remove("orderId"); }
```

### 2. 日志规范（节省成本、提高价值）

| 规范 | 说明 |
| --- | --- |
| **分级** | ERROR（需关注）、WARN（可恢复异常）、INFO（关键业务节点）、DEBUG（默认关闭）；**不要 ERROR 满天飞**，否则告警失效 |
| **用参数占位符** | `log.info("x={}", x)`，避免无谓字符串拼接；高成本参数先判断级别 |
| **异常要带堆栈，且只打印一次** | 不要“捕获-打印-再抛出”导致重复打印；`log.error("msg", e)` |
| **脱敏** | 手机号、身份证、令牌、密码不得明文输出（见 [Web 安全](#/security/web)、[加密与密钥](#/security/crypto)） |
| **不要在循环/高频路径打大量 INFO** | 压垮磁盘与采集；用采样/限频 |
| **异步日志** | Logback AsyncAppender / Log4j2 Async，避免同步写盘阻塞业务线程（队列满时的策略要定：丢弃 or 阻塞） |
| **保留期分层** | 热数据 7~14 天，冷数据低成本存储，合规审计日志单独长期保留 |

### 3. 日志平台：ELK vs Loki

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="日志采集链路：应用写 JSON 日志到 stdout 或文件，Filebeat 或 Fluent Bit 或 Promtail 采集，可经 Kafka 缓冲，再进入 Elasticsearch（全文索引）或 Loki（仅索引标签、日志块存对象存储），最后由 Kibana 或 Grafana 查询">
<rect class="b1" x="20" y="100" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="124" text-anchor="middle" dominant-baseline="middle">应用</text>
<text class="ts" x="80" y="144" text-anchor="middle">JSON 日志</text>
<rect class="b3" x="170" y="100" width="130" height="60" rx="8"/>
<text class="tb" x="235" y="124" text-anchor="middle" dominant-baseline="middle">采集器</text>
<text class="ts" x="235" y="144" text-anchor="middle">Filebeat/Fluent Bit</text>
<rect class="b5" x="330" y="100" width="110" height="60" rx="8"/>
<text class="tb" x="385" y="124" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<text class="ts" x="385" y="144" text-anchor="middle">削峰缓冲（可选）</text>
<line class="l" x1="140" y1="130" x2="170" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="130" x2="330" y2="130" marker-end="url(#arr)"/>
<rect class="b2" x="500" y="30" width="280" height="90" rx="10"/>
<text class="th" x="516" y="54">ELK：Elasticsearch + Kibana</text>
<text class="ts" x="516" y="76">• 全文倒排索引，任意关键字检索快</text>
<text class="ts" x="516" y="94">• 聚合分析能力强</text>
<text class="ts" x="516" y="112">• 代价：索引大、存储与内存成本高</text>
<rect class="b4" x="500" y="150" width="280" height="100" rx="10"/>
<text class="th" x="516" y="174">Loki + Grafana</text>
<text class="ts" x="516" y="196">• 只索引标签，正文压缩存对象存储</text>
<text class="ts" x="516" y="214">• 成本低、与 Prometheus 标签体系一致</text>
<text class="ts" x="516" y="232">• 查询靠标签缩小范围 + 管道过滤，大范围全文较慢</text>
<line class="l" x1="440" y1="125" x2="500" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="135" x2="500" y2="195" marker-end="url(#arr)"/>
</svg>
<figcaption>图 4：日志采集链路与两类存储取舍</figcaption>
</figure>

选择：**需要强大检索/分析、预算充足 → ELK**（ES 见 [Elasticsearch](#/mw/es)，索引按天滚动、ILM 冷热分层、控制字段映射与分片数）；**成本敏感、以“按服务+时间+traceId 查”为主 → Loki**。无论哪种，**traceId 检索**是第一等需求。

## 五、SLO 与告警

### 1. 概念

| 名词 | 含义 | 例子 |
| --- | --- | --- |
| **SLI**（指标） | 衡量服务质量的**比率型**指标 | 成功请求数 / 总请求数；耗时 < 300ms 的请求占比 |
| **SLO**（目标） | 对 SLI 在时间窗口内的承诺 | 30 天内成功率 ≥ **99.9%** |
| **SLA** | 对外的合同，违约有赔偿 | 可用性 99.5%，低于则赔付 |
| **错误预算** | `1 − SLO`，允许出错的额度 | 99.9% → 30 天约 **43 分钟**不可用额度 |

错误预算的意义：**把可靠性与发布速度的争论变成数据**——预算充足可以放心发布与实验；预算耗尽就**暂停功能发布，优先稳定性**。

可用性与允许停机时间（30 天）：99% ≈ 7.2 小时；99.9% ≈ 43 分钟；99.99% ≈ 4.3 分钟。**每多一个 9，成本数量级上升**，要按业务价值选。

### 2. 燃烧率告警（Burn Rate）

**燃烧率 = 实际错误率 / 允许错误率（1−SLO）**。燃烧率 1 表示恰好在窗口末耗尽预算，14.4 表示 **1 小时内就烧掉 2% 的月预算**。

多窗口多燃烧率告警（Google SRE 推荐的组合思路，阈值可按业务调整）：

| 严重度 | 长窗口 | 短窗口 | 燃烧率 | 含义 |
| --- | --- | --- | --- | --- |
| 立即呼叫 | 1h | 5m | 14.4 | 约 2% 月预算在 1 小时内耗光 |
| 立即呼叫 | 6h | 30m | 6 | 约 5% 月预算在 6 小时内耗光 |
| 工单 | 3d | 6h | 1 | 缓慢但持续在烧预算 |

**长窗口 + 短窗口同时满足才告警**：长窗口保证问题足够严重，短窗口保证**问题仍在发生**（避免已恢复还在响）。

```promql
# SLO 99.9%，允许错误率 0.001；1h/5m 燃烧率 > 14.4 同时成立
(
  sum(rate(http_requests_total{status=~"5.."}[1h])) / sum(rate(http_requests_total[1h])) > (14.4 * 0.001)
) and (
  sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > (14.4 * 0.001)
)
```

实践提示：为每个**核心用户旅程**（下单、支付、登录）定义 SLI，而不是只针对服务；工具有 **Sloth、Pyrra** 可自动生成规则与看板。

## 六、一次完整的排障流程

<figure class="fig">
<svg viewBox="0 0 800 250" class="dg" role="img" aria-label="排障漏斗：告警触发后先看指标确认影响范围和时间点，再看变更与依赖饱和度，通过链路定位慢或错的 span，最后用 traceId 查日志取证并复盘，修复后回补监控与告警">
<rect class="b4" x="20" y="30" width="170" height="80" rx="10"/>
<text class="tb" x="105" y="54" text-anchor="middle" dominant-baseline="middle">① 告警 / 指标</text>
<text class="ts" x="105" y="76" text-anchor="middle">影响范围？起始时间？</text>
<text class="ts" x="105" y="94" text-anchor="middle">哪些接口/实例？</text>
<rect class="b5" x="215" y="30" width="170" height="80" rx="10"/>
<text class="tb" x="300" y="54" text-anchor="middle" dominant-baseline="middle">② 变更与依赖</text>
<text class="ts" x="300" y="76" text-anchor="middle">是否刚发布/改配置？</text>
<text class="ts" x="300" y="94" text-anchor="middle">DB/Redis/MQ 饱和？</text>
<rect class="b3" x="410" y="30" width="170" height="80" rx="10"/>
<text class="tb" x="495" y="54" text-anchor="middle" dominant-baseline="middle">③ 链路</text>
<text class="ts" x="495" y="76" text-anchor="middle">慢/错的 span 在哪</text>
<text class="ts" x="495" y="94" text-anchor="middle">Exemplar → trace</text>
<rect class="b2" x="605" y="30" width="170" height="80" rx="10"/>
<text class="tb" x="690" y="54" text-anchor="middle" dominant-baseline="middle">④ 日志</text>
<text class="ts" x="690" y="76" text-anchor="middle">traceId 查具体异常</text>
<text class="ts" x="690" y="94" text-anchor="middle">必要时 profile/dump</text>
<line class="l" x1="190" y1="70" x2="215" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="70" x2="410" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="70" x2="605" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="140" width="755" height="88" rx="10"/>
<text class="th" x="36" y="164">原则</text>
<text class="ts" x="36" y="186">• 先止血后定位：回滚、降级、扩容、限流优先于找根因</text>
<text class="ts" x="36" y="206">• 应用层定位不到再下沉：线程栈/堆（jstack、Arthas、async-profiler）、容器、网络</text>
<text class="ts" x="36" y="222">• 复盘产出：补监控、补告警、补 Runbook、补自动化，让下一次更快</text>
</svg>
<figcaption>图 5：从告警到取证的排障漏斗</figcaption>
</figure>

## 七、常见坑

| 坑 | 说明 |
| --- | --- |
| 链路断在异步/线程池/MQ | 用支持上下文传播的执行器与 instrumentation；检查消息头 |
| span 忘记 `end()` | 内存泄漏、数据不上报；用 try/finally |
| 在 span 属性放高基数/敏感数据 | 成本暴涨与泄露；脱敏并限制长度（SQL 参数默认不记录） |
| 采样率 100% 上生产 | 存储与性能压力；头部低比例 + 尾部保错 |
| 各服务采样决策不一致 | 使用 `parentbased`，由根决定 |
| 日志没有 traceId | 链路与日志无法关联，排障效率低一半 |
| 日志同步写盘 + 大量 INFO | 阻塞业务线程；用异步并限频 |
| MDC 在线程池串号 | 提交任务时拷贝并在 finally 清理 |
| 监控只看均值 | 用分位数；告警按 SLO 而非阈值 |
| Collector 单点/无限流 | 加 memory_limiter、批处理、多副本；应用侧发送失败不要阻塞业务 |
| 时钟不同步 | span 时间错乱；所有节点启用 NTP（见 [Linux 排查](#/infra/linux)） |

## 面试追问

> [!QUESTION] 链路追踪的原理是什么？traceId 如何跨服务传递？
> 一次请求对应一个 Trace，由多个带父子关系的 Span 构成，每个 Span 记录操作名、耗时和属性。入口生成 traceId，出站调用时把 traceId 和当前 spanId 写入请求头（如 W3C traceparent）或消息头，下游解析后创建子 span 继续同一 trace，各 span 异步上报到后端再按 traceId 拼成调用树。

> [!QUESTION] 异步线程池、MQ 场景下链路如何不断？
> ThreadLocal 不跨线程，需要用上下文传播机制包装线程池或使用 Agent 自动增强；MQ 要在生产者把上下文注入消息头、消费者提取并创建 consumer span，批量消费用 Link 关联多个来源。自研协议则在拦截器里手动注入和提取。

> [!QUESTION] 头部采样和尾部采样的区别？如何保证出错的请求不丢？
> 头部采样在链路起点按比例决定，简单开销小，但起点不知道请求是否会出错，可能丢掉关键链路；尾部采样在 Collector 收齐整条 trace 后再决策，可保留所有错误和慢请求、其余按比例抽样，代价是需要缓存并按 traceId 路由到同一实例。通常头部低比例加尾部保错保慢组合使用。

> [!QUESTION] ELK 和 Loki 怎么选？
> ELK 对正文做全文倒排索引，检索与聚合分析强，但索引与存储成本高；Loki 只索引标签，日志块压缩后放对象存储，成本低并与 Prometheus 标签一致，适合按服务、时间、traceId 检索，大范围全文扫描较慢。预算与检索需求决定选型。

> [!QUESTION] 什么是 SLO 和错误预算？燃烧率告警怎么设计？
> SLI 是比率型质量指标，SLO 是对其在时间窗口内的目标，如 30 天成功率 99.9%，错误预算为 1 减 SLO。燃烧率是实际错误率与允许错误率之比，用长短两个窗口同时超阈值触发告警，如 1 小时与 5 分钟窗口燃烧率超过 14.4 立即呼叫，长窗口保证严重、短窗口保证问题仍在，预算耗尽则暂停发布优先稳定性。

> [!QUESTION] 线上突然变慢，说说你的完整排查思路。
> 先看告警与 RED 指标确认范围和起始时间，对照发布与配置变更；检查依赖和资源饱和度，如连接池、慢 SQL、Redis、MQ 堆积、线程池队列、GC 和容器限流；用链路找出最慢的 span 定位服务，再用 traceId 查日志取证，必要时抓线程栈和火焰图；期间优先止血，如回滚、降级、限流，事后补监控与 Runbook。
