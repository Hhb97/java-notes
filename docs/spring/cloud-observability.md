---
level: 深入
tags: [可观测性, Micrometer, Observation, 链路追踪, OpenTelemetry, traceId, MDC, 采样, Actuator, 健康探针, 优雅停机, SkyWalking]
summary: Spring Cloud 微服务的可观测性落地：Micrometer Observation 与 Tracing 的统一模型、trace 在 HTTP/Feign/网关/消息/异步线程中的传播与断点、日志与 traceId 关联、指标设计（RED、标签基数）、采样与成本、Actuator 健康与探针、优雅停机，以及从“调用变慢”到根因的排障流程和 SkyWalking 方案对比。
---

# 微服务可观测：Micrometer、链路追踪与排障

> [!ABSTRACT] 核心要点
> - 微服务的故障**跨进程、跨线程、跨消息**，单看某个服务的日志找不到原因。可观测的三个支柱——**指标（Metrics）、日志（Logs）、追踪（Traces）**——必须能**用同一个 traceId 串起来**：从告警（指标）→ 定位慢/错的调用链（追踪）→ 看具体日志。
> - Spring Boot 3 / Spring Cloud 的新一代做法是 **Micrometer Observation API**：**一次埋点，同时产出指标与追踪**；追踪由 **Micrometer Tracing** 桥接到 **OpenTelemetry**（或 Brave），导出到 Zipkin、Tempo、Jaeger、各类 APM。
> - **trace 传播**靠请求头（W3C `traceparent` 等）：HTTP、Feign/RestClient/WebClient、网关、消息队列框架大多**自动传播**；**断点几乎都在“线程切换”和“自己造的异步/调度/消息通道”**——排查丢 trace 先看哪一跳没带头。
> - 指标设计用 **RED（Rate、Errors、Duration）**；**标签基数（cardinality）是头号杀手**：把用户 ID、订单号当标签会撑爆时序库。追踪要**采样**，并保证错误和慢请求被保留。
> - 运行时健康：`liveness`（是否存活）与 `readiness`（是否可接流量）要分开配置；**优雅停机**与注册中心下线、探针配合，才能做到发布无损。
> - 本页是**Spring Cloud 的集成实践**；指标/追踪/日志体系的通用设计见 [指标监控](#/infra/obs-metrics)、[链路追踪、日志与告警](#/infra/obs-trace)。

## 统一模型：Observation 与三大支柱

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Micrometer Observation：业务与框架代码用 Observation 埋点一次，通过 ObservationHandler 同时生成指标、追踪 span 和日志上下文；指标导出到 Prometheus，追踪经 OpenTelemetry 导出到 Tempo、Zipkin 或 Jaeger，日志带 traceId 进入日志系统；三者通过 traceId 关联，从指标告警下钻到追踪再到日志">
<rect class="b3" x="20" y="30" width="170" height="90" rx="10"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">埋点（一次）</text>
<text class="ts" x="105" y="74" text-anchor="middle">Spring MVC/WebFlux</text>
<text class="ts" x="105" y="92" text-anchor="middle">Feign/RestClient/DB/MQ</text>
<text class="ts" x="105" y="110" text-anchor="middle">自定义 @Observed</text>
<rect class="b5" x="220" y="30" width="150" height="90" rx="10"/>
<text class="tb" x="295" y="50" text-anchor="middle" dominant-baseline="middle">Observation</text>
<text class="ts" x="295" y="74" text-anchor="middle">名称·低基数标签</text>
<text class="ts" x="295" y="92" text-anchor="middle">高基数标签·上下文</text>
<rect class="b1" x="400" y="14" width="150" height="38" rx="8"/>
<text class="ts" x="475" y="33" text-anchor="middle" dominant-baseline="middle">指标 Timer/Counter</text>
<rect class="b1" x="400" y="62" width="150" height="38" rx="8"/>
<text class="ts" x="475" y="81" text-anchor="middle" dominant-baseline="middle">追踪 Span</text>
<rect class="b1" x="400" y="110" width="150" height="38" rx="8"/>
<text class="ts" x="475" y="129" text-anchor="middle" dominant-baseline="middle">日志上下文 MDC</text>
<line class="l" x1="190" y1="75" x2="220" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="60" x2="400" y2="33" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="75" x2="400" y2="81" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="90" x2="400" y2="129" marker-end="url(#arr)"/>
<rect class="b2" x="580" y="14" width="160" height="38" rx="8"/>
<text class="ts" x="660" y="33" text-anchor="middle" dominant-baseline="middle">Prometheus / Grafana</text>
<rect class="b2" x="580" y="62" width="160" height="38" rx="8"/>
<text class="ts" x="660" y="81" text-anchor="middle" dominant-baseline="middle">OTel → Tempo/Zipkin</text>
<rect class="b2" x="580" y="110" width="160" height="38" rx="8"/>
<text class="ts" x="660" y="129" text-anchor="middle" dominant-baseline="middle">日志系统（带 traceId）</text>
<line class="l" x1="550" y1="33" x2="580" y2="33" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="81" x2="580" y2="81" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="129" x2="580" y2="129" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="176" width="720" height="140" rx="8"/>
<text class="th" x="32" y="196">关联与下钻路径</text>
<text class="ts" x="380" y="222" text-anchor="middle">① 指标告警：某接口 P99 升高 / 5xx 增加（Grafana 面板，指标样本可挂 exemplar 指向具体 trace）</text>
<text class="ts" x="380" y="244" text-anchor="middle">② 追踪：按 traceId 或按条件检索慢/错的调用链，看哪一跳（哪个服务、哪个 SQL、哪个下游）耗时异常</text>
<text class="ts" x="380" y="266" text-anchor="middle">③ 日志：用 traceId 在日志系统过滤，看该请求在各服务的详细上下文与异常堆栈</text>
<text class="ts" x="380" y="288" text-anchor="middle">没有 traceId 贯穿，这三者就是三个孤岛；排障效率取决于它们能否一键跳转</text>
<text class="ts" x="380" y="306" text-anchor="middle">具体依赖、配置属性与默认值随 Spring Boot / Micrometer / OTel 版本变化，以官方文档为准</text>
</svg>
<figcaption>图 1：一次埋点同时生成指标、追踪与日志上下文，并用 traceId 关联</figcaption>
</figure>

### 依赖与配置（示意）

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus        # 只暴露必要端点；管理端口建议独立并受保护
  endpoint:
    health:
      probes:
        enabled: true                          # 开启 liveness / readiness 探针
      show-details: when-authorized
  metrics:
    tags:
      application: ${spring.application.name} # 公共标签：应用名、环境（低基数）
      env: prod
    distribution:
      percentiles-histogram:
        http.server.requests: true            # 直方图，便于在服务端聚合分位数
  tracing:
    sampling:
      probability: 0.1                         # 采样率（示意；生产常用“头部低采样 + 尾部保留错误/慢请求”）
  otlp:
    tracing:
      endpoint: http://otel-collector:4318/v1/traces   # 导出到 OTel Collector，由 Collector 做路由、采样、批处理

logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"   # 日志带 traceId/spanId
```

要点：

- **用 OTel Collector 做中转**：应用只导出到 Collector，Collector 负责重试、批处理、尾部采样、多后端分发，应用与后端解耦；
- **管理端点只暴露必要项**，并走独立端口或鉴权，避免暴露 `env`、`heapdump` 等敏感端点，见 [微服务安全](#/spring/cloud-security)；
- **公共标签**使用低基数字段（应用、环境、版本、区域），版本标签便于灰度对比，见 [配置管理与全链路灰度](#/spring/cloud-config-gray)。

## trace 的传播与断点

### 传播机制

一次请求的 trace 由 **traceId（整条链路）+ spanId（一跳）+ 采样标志**组成，沿调用方向通过**请求头**传播：

- **W3C Trace Context**（`traceparent`/`tracestate`）是标准，**B3**（Zipkin）是常见旧格式；全链路要**统一传播格式**，混用会导致链路断裂；
- **入口服务**（网关）生成或接续 trace，并在响应头返回 traceId，方便前端/客服拿来反馈问题；
- **每个服务**收到请求创建 server span，调用下游时创建 client span 并把上下文写入请求头。

### 哪些环节自动，哪些要处理

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="trace 传播覆盖与断点：入口网关、Spring MVC、Feign、RestClient、WebClient 通常自动传播；消息队列模板与监听容器需启用观测；线程池与异步任务需要上下文装饰；定时任务是新的 trace 起点；自研的 HTTP 客户端、自定义协议、手写线程需要手动传播；缺失传播会产生断开的 trace">
<rect class="b2" x="20" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">通常自动传播（确认已启用观测）</text>
<text class="ts" x="195" y="62" text-anchor="middle">Spring MVC / WebFlux 入站</text>
<text class="ts" x="195" y="84" text-anchor="middle">Feign / RestClient / WebClient / RestTemplate</text>
<text class="ts" x="195" y="106" text-anchor="middle">Spring Cloud Gateway 转发</text>
<text class="ts" x="195" y="128" text-anchor="middle">JDBC / Redis / Kafka / RabbitMQ 客户端（需对应观测）</text>
<text class="ts" x="195" y="150" text-anchor="middle">注意：必须使用 Spring 管理的 Builder/Bean 创建客户端</text>
<rect class="b4" x="390" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">常见断点（trace 会断开或孤立）</text>
<text class="ts" x="565" y="62" text-anchor="middle">自己 new 的线程、线程池、@Async 未装饰</text>
<text class="ts" x="565" y="84" text-anchor="middle">CompletableFuture 默认池、并行流</text>
<text class="ts" x="565" y="106" text-anchor="middle">自己 new 的 RestTemplate/OkHttp（绕过 Builder）</text>
<text class="ts" x="565" y="128" text-anchor="middle">消息：未写入/未读取消息头；批量消费合并多条</text>
<text class="ts" x="565" y="150" text-anchor="middle">自定义 RPC/TCP 协议、定时任务（本就是新起点）</text>
<rect class="bg" x="20" y="184" width="720" height="146" rx="8"/>
<text class="th" x="32" y="204">修复与约定</text>
<text class="ts" x="380" y="230" text-anchor="middle">线程池：用框架提供的上下文感知装饰（如 ContextExecutorService / TaskDecorator），或统一封装线程池工厂，禁止裸用 Executors</text>
<text class="ts" x="380" y="252" text-anchor="middle">响应式：上下文在 Reactor Context 里，用 Observation 的响应式支持；不要依赖 ThreadLocal</text>
<text class="ts" x="380" y="274" text-anchor="middle">消息：生产者把 trace 上下文写入消息头；消费者创建新 span 并关联生产者上下文（link 或父子），批量消费用 link</text>
<text class="ts" x="380" y="296" text-anchor="middle">定时任务/批处理：每次执行创建根 span，附上任务名与批次号；跨系统异步用业务单号做关联补充</text>
<text class="ts" x="380" y="316" text-anchor="middle">排查：从断开的位置往上游看——那一跳的请求头里有没有 traceparent？日志里 traceId 是否为空？</text>
</svg>
<figcaption>图 2：trace 传播的自动覆盖范围与常见断点</figcaption>
</figure>

### 日志与 traceId 关联

- 日志格式统一输出 `traceId`、`spanId`、应用名、环境、版本；用结构化（JSON）日志便于检索；
- 日志里的 traceId 来自 **MDC**，同样受**线程切换**影响：异步线程里 MDC 为空，日志就“断了”——和 trace 传播同样的修复手段；
- 网关在响应头返回 traceId，前端报错时展示它，**用户反馈一个 ID 就能定位整条链路**；
- 业务关键字段（订单号、用户 ID）**放日志和 span 属性里（高基数，不放指标标签）**，便于按业务键检索，注意脱敏；
- 日志级别与采样：错误日志全量，调试日志按需动态开启，避免日志量成为成本与性能问题。

### 追踪属性与采样

| 项 | 做法 |
| --- | --- |
| **Span 命名** | 用**低基数的操作名**（`GET /orders/{id}`、`SELECT orders`），不要把具体 ID 放名称里 |
| **属性（Attributes）** | 放业务键、结果状态、重试次数等排障线索；敏感信息脱敏 |
| **采样（头部）** | 在入口按比例采样（如 1%~10%），成本低但可能丢掉稀有的慢/错请求 |
| **采样（尾部）** | 在 Collector 等处等整条 trace 完成后，按**是否错误、是否慢**决定保留，**保证问题请求不丢**，但需要缓冲与更多资源 |
| **强制采样** | 带特定头（调试标）或 VIP 用户的请求强制采样，方便排障 |
| **成本** | 采样率、span 数量、属性大小决定存储成本；高频内部调用（缓存命中）可不单独记录 span |
| **一致性** | 全链路所有服务遵守入口的采样决定（采样标志随 trace 传播），避免“半条 trace” |

## 指标

### RED 与四个黄金信号

| 对象 | 指标 |
| --- | --- |
| **服务入口（每个接口）** | **R**ate 请求速率、**E**rrors 错误率（按状态码分类）、**D**uration 延迟分位数（P50/P95/P99） |
| **下游调用（每个依赖）** | 调用量、错误率、延迟、重试与熔断次数 |
| **资源（USE）** | 线程池（活跃/队列/拒绝）、连接池（使用/等待）、JVM（堆、GC 暂停、线程）、CPU/内存 |
| **业务** | 下单量、支付成功率、消息积压、关键漏斗 |

Spring Boot 默认提供 `http.server.requests`、`http.client.requests`（Feign 等客户端）、JVM、线程池、数据源连接池（HikariCP）等指标；**自定义业务指标用 Micrometer 的 Counter/Timer/Gauge**。

### 标签与基数

| 做法 | 说明 |
| --- | --- |
| **标签取值要有限且稳定** | 接口模板（`/orders/{id}`）、状态码类别、方法、结果（成功/失败）、服务名、版本 |
| **绝不要放高基数值** | 用户 ID、订单号、完整 URL、IP、异常消息全文 → 时间序列数量爆炸，拖垮 Prometheus 与账单；这些放到**追踪属性和日志** |
| **路径模板化** | 使用路由模板而不是原始路径，避免 `/orders/1`、`/orders/2` … 各一条时间序列 |
| **限制基数** | 为指标设置最大标签组合数或使用 MeterFilter 过滤异常标签值 |
| **分位数** | 优先导出**直方图桶**，在服务端聚合分位数；客户端算的分位数无法跨实例聚合 |

### 告警与 SLO

- 告警基于**症状**（用户可见：错误率、延迟、可用性）而不是原因（CPU 高不一定有问题）；
- 用 **SLO + 错误预算**与**多窗口燃烧速率告警**降低噪声，见 [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics) 与 [链路追踪、日志与告警](#/infra/obs-trace)；
- 告警携带**服务、环境、版本、仪表盘与 Runbook 链接**，并路由到负责人。

## 健康检查、探针与优雅停机

### liveness 与 readiness

| 探针 | 回答的问题 | 失败后果 | 应该检查什么 |
| --- | --- | --- | --- |
| **liveness** | 进程是否活着、能否继续运行（是否死锁/卡死） | 容器被**重启** | **只检查应用自身**；**不要把数据库/下游依赖放进去**，否则下游抖动会导致所有实例被重启，引发雪崩 |
| **readiness** | 是否可以接收流量 | 从负载均衡/Service **摘除**，不重启 | 应用启动完成、必要依赖就绪（可含数据库连接），过载时可主动设为不就绪 |
| **startup** | 启动是否完成 | 启动期间不做 liveness 判定 | 慢启动应用（预热、迁移） |

Spring Boot 的 Actuator 提供 `/actuator/health/liveness` 与 `/readiness`，并能随**应用生命周期状态**（正在启动/接受流量/停机中）变化；在 Kubernetes 中配置对应探针，见 [Kubernetes 核心概念](#/infra/k8s)。

### 优雅停机

发布与缩容时要做到**无损下线**：

1. 收到终止信号后，**先把 readiness 置为不可用**（或先从注册中心注销），让新流量不再进入；
2. **等待一小段缓冲时间**，覆盖负载均衡与注册中心缓存刷新的延迟（客户端缓存的实例列表仍可能指向该实例），见 [Nacos 与服务注册发现、配置中心](#/mw/registry)；
3. **处理完在途请求**（设置最长等待时间，如 `server.shutdown=graceful` 与 `spring.lifecycle.timeout-per-shutdown-phase`）；
4. **停止消息消费并提交位点**，停止定时任务，关闭连接池与线程池；
5. 最后退出进程。

容器环境中还要让 `terminationGracePeriodSeconds` 大于应用的优雅停机时间，必要时在 `preStop` 里加缓冲睡眠；否则会被强杀，造成请求中断与消息重复。

## 排障流程：调用变慢怎么查

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="排障流程：从指标告警确认影响范围和时间点，查看是否与发布或配置变更相关，在追踪里找慢调用链定位耗时最长的 span，判断是服务自身、下游依赖、数据库、线程池或网络，再用日志和线程栈、GC 指标验证根因，最后修复并复盘，补充告警">
<rect class="b3" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">① 看指标</text>
<text class="ts" x="85" y="74" text-anchor="middle">范围·起始时间</text>
<rect class="b5" x="170" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="235" y="52" text-anchor="middle" dominant-baseline="middle">② 查变更</text>
<text class="ts" x="235" y="74" text-anchor="middle">发布·配置·流量</text>
<rect class="b1" x="320" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="385" y="52" text-anchor="middle" dominant-baseline="middle">③ 看追踪</text>
<text class="ts" x="385" y="74" text-anchor="middle">最慢 span 在哪</text>
<rect class="b4" x="470" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="535" y="52" text-anchor="middle" dominant-baseline="middle">④ 定位层次</text>
<text class="ts" x="535" y="74" text-anchor="middle">自身/下游/库/网络</text>
<rect class="b2" x="620" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="680" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 验证</text>
<text class="ts" x="680" y="74" text-anchor="middle">日志·线程栈·GC</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="62" x2="320" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="62" x2="470" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="62" x2="620" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="720" height="206" rx="8"/>
<text class="th" x="32" y="136">按症状快速判断</text>
<text class="ts" x="380" y="162" text-anchor="middle">某个下游的 client span 很长，下游自身的 server span 很短 → 网络/连接池排队/负载均衡/DNS；看连接池等待与重试</text>
<text class="ts" x="380" y="184" text-anchor="middle">下游 server span 本身很长 → 下游内部慢；继续沿下游往里看（SQL、缓存、再下游）</text>
<text class="ts" x="380" y="206" text-anchor="middle">自己服务的 span 前面有一段“空白” → 线程池排队/GC 暂停/锁竞争；看线程池活跃与队列、GC 暂停、线程栈</text>
<text class="ts" x="380" y="228" text-anchor="middle">多个请求同时变慢、与流量正相关 → 容量不足或被限流熔断；看饱和度、限流熔断指标</text>
<text class="ts" x="380" y="250" text-anchor="middle">仅个别请求慢 → 特定参数/数据量/热点 key；用追踪属性（业务键）对比慢与快的请求</text>
<text class="ts" x="380" y="272" text-anchor="middle">trace 在某处断开 → 先修传播问题，否则会在盲区里打转（检查线程池、消息头、手建客户端）</text>
<text class="ta" x="380" y="298" text-anchor="middle">收尾：根因修复 → 补监控与告警（让下次更早发现）→ 复盘写入知识库</text>
</svg>
<figcaption>图 3：从告警到根因的排障流程</figcaption>
</figure>

## SkyWalking 与 Micrometer/OTel 的取舍

| 维度 | Micrometer Tracing + OpenTelemetry | Apache SkyWalking（Java Agent） |
| --- | --- | --- |
| 接入方式 | 依赖与配置，框架原生支持（Spring Boot 3） | **Java Agent 字节码增强，无需改代码** |
| 覆盖 | Spring 生态自动；其他需要依赖/手动 | 插件覆盖面广（大量中间件与框架），老项目快速接入 |
| 标准与生态 | **开放标准**，后端可换（Tempo/Jaeger/商业 APM） | 自有协议与生态，也支持对接 OTel |
| 指标/日志联动 | 与 Micrometer 指标天然统一 | 自带指标与拓扑分析、告警 |
| 性能与风险 | 侵入小，可控 | Agent 带来额外开销与版本兼容风险，需压测验证 |
| 适合 | 新项目、Spring Boot 3、希望避免厂商绑定 | 存量大量服务、希望零改动快速获得拓扑与追踪 |

不必二选一的极端：很多公司用 Agent 快速覆盖存量，同时在新服务中使用 Micrometer/OTel；**统一传播格式与 traceId 规范**是混用的关键。

## 常见问题

| 问题 | 根因 | 处理 |
| --- | --- | --- |
| trace 在某一跳断开 | 线程池/@Async 未装饰、消息头未传、手建客户端 | 装饰执行器；启用消息观测；用 Spring 提供的 Builder |
| 日志没有 traceId | MDC 未设置或线程切换丢失 | 统一日志格式，异步上下文传递 |
| 指标膨胀、Prometheus 内存暴涨 | 高基数标签（ID、完整 URL） | 路径模板化，移除高基数标签，MeterFilter 限制 |
| 追踪成本太高 | 采样率过高、span 太细 | 头部低采样 + 尾部保留错误/慢，过滤低价值 span |
| 100% 采样压垮后端 | 全量上报 | 采样、Collector 缓冲与批处理 |
| liveness 失败导致重启风暴 | 把下游依赖放进 liveness | liveness 只看自身，依赖放 readiness |
| 发布时出现 502/请求失败 | 未优雅停机、注册中心缓存未刷新 | readiness 置不可用 + 缓冲 + 等待在途 + 调大终止宽限期 |
| 看板指标对不上 | 标签不一致、实例未带公共标签 | 统一公共标签与命名规范，指标目录管理 |
| 告警太多无人看 | 基于原因告警、阈值拍脑袋 | 基于症状与 SLO 告警，分级路由，定期清理 |
| 上下游 trace 格式不兼容 | 一边 B3 一边 W3C | 统一传播格式，或在网关/Collector 做转换 |

## 相关阅读

- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：指标体系、告警与 SLO
- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：追踪与日志的通用设计
- [OpenFeign 深入：调用链、超时重试与上下文透传](#/spring/cloud-feign)：Feign 的上下文传播
- [Spring Cloud Gateway 深入](#/spring/cloud-gateway)：入口 trace 与访问日志
- [事故复盘与改进](#/design/eng-postmortem)：从排障到复盘

## 面试追问

> [!QUESTION] 微服务如何做全链路追踪？traceId 是怎么传递的？
> 入口服务生成或接续 trace，调用下游时把 traceId、spanId 与采样标志通过请求头（W3C traceparent 或 B3）传播，下游据此创建子 span，Spring Boot 3 通过 Micrometer Tracing 桥接 OpenTelemetry 并导出到后端；日志通过 MDC 带上 traceId。消息要写入消息头，异步线程要显式传递上下文。

> [!QUESTION] 为什么 trace 经常在异步线程或消息处断开？怎么办？
> 上下文放在 ThreadLocal 或 MDC 中，线程切换后丢失，消息队列需要把上下文写进消息头并在消费端恢复。解决办法是使用上下文感知的线程池装饰器、统一线程池工厂、启用消息框架的观测支持，响应式用 Reactor Context，排查时看是哪一跳请求头里没有 traceparent。

> [!QUESTION] Prometheus 指标的标签有什么注意事项？
> 标签取值必须有限且稳定，如接口模板、状态类别、服务名；不能放用户 ID、订单号、完整 URL 等高基数值，否则时间序列爆炸拖垮存储，这些信息应放追踪属性与日志。路径要模板化，分位数优先导出直方图在服务端聚合。

> [!QUESTION] liveness 和 readiness 探针应该分别检查什么？
> liveness 只判断进程是否活着、是否卡死，失败会重启，不要把数据库等下游依赖放进去，否则下游抖动会让所有实例被重启造成雪崩；readiness 判断能否接收流量，失败只摘除不重启，可以包含必要依赖就绪和过载保护；慢启动应用再加 startup 探针。

> [!QUESTION] 怎么做到发布时无损（优雅停机）？
> 先把 readiness 置为不可用或从注册中心注销，等待一段缓冲时间让负载均衡和客户端缓存刷新，再处理完在途请求，停止消息消费并提交位点，关闭线程池与连接池后退出；容器的终止宽限期要大于应用的停机时间。

> [!QUESTION] 追踪采样怎么设计才既省成本又不漏问题？
> 头部采样按比例在入口决定，成本低但可能丢失稀有的慢或错请求；尾部采样在 Collector 等整条 trace 完成后按是否错误、是否慢来决定保留，保证问题请求不丢但需要缓冲资源。常见做法是头部低采样加尾部保留错误和慢请求，并支持对特定用户或调试头强制采样，全链路遵守入口的采样决定。
