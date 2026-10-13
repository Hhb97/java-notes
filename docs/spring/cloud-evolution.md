---
level: 深入
tags: [Spring Boot 3, Spring Cloud, 组件演进, 虚拟线程, GraalVM, Jakarta EE, 升级迁移, 服务网格, 云原生, 微服务反模式, 治理成熟度]
summary: 微服务体系的演进与升级：Netflix 组件退场后的主流替代、Spring Boot 3 的关键变化（JDK 17+、Jakarta、可观测、HTTP 客户端、原生镜像）、虚拟线程对微服务的影响与限制、存量系统的升级路线与常见坑、治理能力从 SDK 下沉到 Sidecar/平台的取舍、微服务反模式与治理成熟度。
---

# 微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍

> [!ABSTRACT] 核心要点
> - Spring Cloud 的组件格局在变：**Netflix 系（Eureka/Ribbon/Hystrix/Zuul）已退场**，主流是 **Nacos/Consul/K8s Service（发现与配置）+ Spring Cloud LoadBalancer + Resilience4j/Sentinel + Spring Cloud Gateway + Micrometer Tracing**。看老项目要能“翻译”对应关系。
> - **Spring Boot 3 / Spring 6** 带来基线变化：**JDK 17+、`javax.*` → `jakarta.*`、Observation 可观测、HTTP Interface/RestClient、原生镜像（AOT/GraalVM）支持**，以及对 **JDK 21 虚拟线程**的适配。升级的成本主要在**依赖对齐与包名迁移**，而不是业务代码。
> - **虚拟线程**让“阻塞式写法 + 高并发”重新成立：每个请求一个虚拟线程，阻塞 IO 时让出载体线程。**但不会增加下游容量**——数据库连接池、下游并发、CPU 仍是瓶颈；还要留意 **`synchronized` 固定（pinning）**、`ThreadLocal` 滥用、第三方库兼容。它改变的是**线程模型成本**，不是系统的容量上限。
> - **升级要分步**：先评估依赖与兼容性 → 自动化迁移工具处理包名 → **单服务逐个升级并灰度** → 保持新旧版本在调用上的兼容 → 可回滚。一次性全量升级是最危险的方式。
> - **治理能力放哪一层**是核心架构取舍：**SDK（Spring Cloud 库）→ Sidecar（服务网格）→ 平台（K8s/Ingress/云厂商）**。多语言、治理要集中时下沉；纯 Java、团队小时，SDK 更简单。**没有绝对正确，只有与团队能力匹配。**
> - 最大的微服务风险不是技术栈，而是**反模式**：分布式单体、过度拆分、共享数据库、过长的同步调用链。治理要先看**边界与依赖**，再谈组件。

## 组件格局：从 Netflix 到现在

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Spring Cloud 组件的演进对照：服务发现从 Eureka 到 Nacos、Consul 或 Kubernetes Service；客户端负载均衡从 Ribbon 到 Spring Cloud LoadBalancer；熔断从 Hystrix 到 Resilience4j 或 Sentinel；网关从 Zuul 到 Spring Cloud Gateway；配置从 Spring Cloud Config 到 Nacos 或 Apollo；链路追踪从 Sleuth 到 Micrometer Tracing 加 OpenTelemetry；声明式调用 OpenFeign 与 HTTP Interface">
<text class="th" x="20" y="22">能力</text>
<text class="th" x="190" y="22">旧栈（逐步退场）</text>
<text class="th" x="440" y="22">当前主流</text>
<rect class="bg" x="20" y="34" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="58" dominant-baseline="middle">服务发现</text>
<text class="ts" x="190" y="58" dominant-baseline="middle">Eureka（维护模式）</text>
<text class="ts" x="440" y="58" dominant-baseline="middle">Nacos / Consul / Kubernetes Service</text>
<rect class="b" x="20" y="80" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="104" dominant-baseline="middle">负载均衡</text>
<text class="ts" x="190" y="104" dominant-baseline="middle">Ribbon</text>
<text class="ts" x="440" y="104" dominant-baseline="middle">Spring Cloud LoadBalancer</text>
<rect class="bg" x="20" y="126" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="150" dominant-baseline="middle">熔断限流</text>
<text class="ts" x="190" y="150" dominant-baseline="middle">Hystrix</text>
<text class="ts" x="440" y="150" dominant-baseline="middle">Resilience4j / Sentinel</text>
<rect class="b" x="20" y="172" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="196" dominant-baseline="middle">网关</text>
<text class="ts" x="190" y="196" dominant-baseline="middle">Zuul 1.x</text>
<text class="ts" x="440" y="196" dominant-baseline="middle">Spring Cloud Gateway / Envoy / APISIX</text>
<rect class="bg" x="20" y="218" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="242" dominant-baseline="middle">配置中心</text>
<text class="ts" x="190" y="242" dominant-baseline="middle">Spring Cloud Config</text>
<text class="ts" x="440" y="242" dominant-baseline="middle">Nacos / Apollo / K8s ConfigMap</text>
<rect class="b" x="20" y="264" width="720" height="40" rx="6"/>
<text class="tb" x="40" y="288" dominant-baseline="middle">链路追踪</text>
<text class="ts" x="190" y="288" dominant-baseline="middle">Sleuth</text>
<text class="ts" x="440" y="288" dominant-baseline="middle">Micrometer Tracing + OpenTelemetry / SkyWalking</text>
<text class="ts" x="380" y="322" text-anchor="middle">注：项目维护状态与推荐替代随时间变化，选型以官方发布说明和路线图为准</text>
</svg>
<figcaption>图 1：Spring Cloud 组件的新旧对照</figcaption>
</figure>

| 能力 | 当前选择要点 |
| --- | --- |
| **发现与配置** | Java 微服务体系常用 Nacos；Kubernetes 上可由 Service/DNS 承担服务发现，见 [Nacos 与服务注册发现、配置中心](#/mw/registry) |
| **调用** | OpenFeign 存量多；新项目可评估 HTTP Interface + RestClient，见 [OpenFeign 深入](#/spring/cloud-feign) |
| **容错** | Sentinel（国内/Dubbo 体系）或 Resilience4j（轻量），见 [熔断限流实战](#/spring/cloud-resilience) |
| **入口** | Spring Cloud Gateway 或 Envoy/APISIX 等，外层再有 Nginx/WAF，见 [Spring Cloud Gateway 深入](#/spring/cloud-gateway) |
| **可观测** | Micrometer + OTel，见 [微服务可观测](#/spring/cloud-observability) |
| **RPC** | 内部高频调用可用 Dubbo/gRPC，见 [Dubbo 架构与调用链路](#/mw/dubbo)、[gRPC 与 Protobuf](#/mw/grpc) |

## Spring Boot 3 / Spring 6 的关键变化

| 变化 | 影响与对策 |
| --- | --- |
| **JDK 17+ 基线** | 升级 JDK 本身要先做：运行环境、构建镜像、字节码增强库（Agent、Lombok、CGLIB 相关）与 JDK 17 兼容；强封装（模块系统）导致**反射访问 JDK 内部 API** 的库会失败，需要升级或加 `--add-opens` 作为临时方案 |
| **Jakarta EE**（`javax.*` → `jakarta.*`） | Servlet、JPA、Validation、JMS 等包名整体迁移；**所有依赖的第三方库都要有 Jakarta 版本**；用自动化迁移工具（如 OpenRewrite 的 Spring Boot 3 迁移配方）处理源码，再人工处理反射字符串、XML 配置、`spring.factories` 等 |
| **自动配置注册方式** | `spring.factories` 中的自动配置改为 `META-INF/spring/...AutoConfiguration.imports`；自研 starter 需调整，见 [Spring Boot 自动配置与启动](#/spring/boot) |
| **Spring Security 6** | 配置 API 变化（`WebSecurityConfigurerAdapter` 移除，改为 `SecurityFilterChain` Bean；默认行为更严格） |
| **可观测** | Sleuth 移除，使用 Micrometer Observation/Tracing；监控指标名称与默认标签有变化，**看板与告警要同步调整** |
| **HTTP 客户端** | 新增 RestClient 与 HTTP Interface；RestTemplate 仍可用但进入“维护”倾向 |
| **ProblemDetail** | 内建 RFC 7807 错误响应格式，统一错误体 |
| **AOT 与原生镜像** | 支持 GraalVM 原生镜像：启动毫秒级、内存低，但**反射/动态代理需要提示（hints）**、构建慢、调试与库兼容有成本 |
| **Hibernate 6、Tomcat 10 等依赖大版本** | SQL 方言、ID 生成、HQL 行为有差异；需回归测试数据层 |
| **配置属性变化** | 部分属性改名/移除；使用配置迁移辅助（`spring-boot-properties-migrator`）识别 |

版本对应关系见 [Spring Cloud 微服务全景](#/spring/cloud) 的版本表，**Boot、Cloud、Cloud Alibaba 必须配套**，具体小版本以官方发布说明为准。

## 虚拟线程对微服务的影响

### 它改变了什么

传统的“**一个请求一个平台线程**”模型在高并发下受限于线程数量（每个线程占内存与调度成本），因此出现了响应式编程。JDK 21 的**虚拟线程**让线程变得**极其廉价**：阻塞 IO 时虚拟线程被“卸载”，载体线程可以去运行别的虚拟线程，于是**同步阻塞的代码风格也能支撑大量并发**。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="平台线程与虚拟线程的对比：平台线程模型下请求数受线程池大小限制，阻塞时线程被占用；虚拟线程模型下每个请求一个虚拟线程，阻塞时让出载体线程，线程数不再是瓶颈，但数据库连接池、下游并发、CPU 仍然是上限，且需要注意 synchronized 固定载体线程和 ThreadLocal 使用">
<rect class="b3" x="20" y="14" width="350" height="160" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">平台线程池模型</text>
<text class="ts" x="195" y="62" text-anchor="middle">线程池（如 200）：并发 = 线程数</text>
<text class="ts" x="195" y="84" text-anchor="middle">阻塞等待 IO 时线程被占住</text>
<text class="ts" x="195" y="106" text-anchor="middle">下游变慢 → 线程耗尽 → 请求排队/拒绝</text>
<text class="ts" x="195" y="128" text-anchor="middle">线程内存与上下文切换成本高</text>
<text class="ts" x="195" y="150" text-anchor="middle">高并发要靠响应式或加线程（有限）</text>
<rect class="b2" x="390" y="14" width="350" height="160" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">虚拟线程模型（JDK 21+）</text>
<text class="ts" x="565" y="62" text-anchor="middle">每个请求一个虚拟线程，数量可很大</text>
<text class="ts" x="565" y="84" text-anchor="middle">阻塞 IO 时让出载体线程，不占 OS 线程</text>
<text class="ts" x="565" y="106" text-anchor="middle">同步代码风格，易写易读易调试</text>
<text class="ts" x="565" y="128" text-anchor="middle">线程数不再是并发的主要瓶颈</text>
<text class="ts" x="565" y="150" text-anchor="middle">Spring Boot 3.2+ 可通过配置开启</text>
<rect class="b4" x="20" y="190" width="720" height="130" rx="8"/>
<text class="th" x="32" y="210">但是：瓶颈转移，不是消失</text>
<text class="ts" x="380" y="236" text-anchor="middle">数据库连接池（如 20 个连接）仍是硬上限：成千上万虚拟线程会在连接池前排队；下游服务的并发能力同样有限</text>
<text class="ts" x="380" y="258" text-anchor="middle">要用限流、舱壁、信号量限制对下游/数据库的并发，否则更容易把下游打垮（原来线程池大小起到了“隐式限流”）</text>
<text class="ts" x="380" y="280" text-anchor="middle">pinning：在 synchronized 块内阻塞会固定载体线程；老库大量用 synchronized/本地阻塞调用时收益打折（新版本 JDK 持续改善）</text>
<text class="ts" x="380" y="302" text-anchor="middle">CPU 密集型任务不会因虚拟线程变快；ThreadLocal 存大对象会随虚拟线程数量放大内存占用</text>
</svg>
<figcaption>图 2：平台线程与虚拟线程的差异，以及瓶颈的转移</figcaption>
</figure>

### 在微服务里怎么用

| 方面 | 建议 |
| --- | --- |
| **开启方式** | Boot 3.2+ 可用 `spring.threads.virtual.enabled=true` 让 Web 容器与异步执行使用虚拟线程（具体行为与版本、组件有关，以官方文档为准）；先在非核心服务灰度 |
| **适用场景** | **IO 密集**、大量阻塞调用（下游 HTTP、数据库、Feign）的服务；对**网关**这类已用响应式的组件不必强行改写 |
| **必须配套的保护** | 对数据库与下游设置**并发上限**（连接池大小、舱壁/信号量、限流），否则请求洪峰会直接压垮它们，见 [熔断限流实战](#/spring/cloud-resilience) |
| **排查 pinning** | 用 JFR 或 JDK 提供的诊断选项发现固定事件；把热点路径上的 `synchronized` 替换为 `ReentrantLock`（尤其在包裹阻塞操作时）；升级有问题的库 |
| **ThreadLocal** | 减少使用或存小对象；上下文传递可用 Scoped Values（随 JDK 版本成熟度而定）；MDC 等基于 ThreadLocal 的上下文仍可用，但要关注对象大小 |
| **监控** | 关注载体线程使用、虚拟线程创建/挂起、连接池等待时间；传统的“线程池活跃数”指标含义改变，看板要调整，见 [微服务可观测](#/spring/cloud-observability) |
| **与响应式的关系** | 虚拟线程让**绝大多数业务服务不需要响应式**；响应式仍适合流式处理、背压语义强、已有响应式生态的场景（如网关） |
| **不是银弹** | 先量化：压测对比平台线程池与虚拟线程的吞吐、延迟、资源占用，再决定，见 [压测方法与容量规划](#/design/eng-loadtest) |

## 升级路线

### 大型存量系统的升级方式

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="升级路线：评估依赖与兼容性，建立测试与基线，升级 JDK，依赖对齐与包名迁移，选一个低风险服务试点，灰度发布验证，逐批升级其余服务，保持新旧版本调用兼容，全程可回滚，最后清理遗留配置与兼容层">
<rect class="b3" x="20" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">① 评估</text>
<text class="ts" x="75" y="82" text-anchor="middle">依赖·插件·风险</text>
<rect class="b5" x="145" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">② 基线</text>
<text class="ts" x="200" y="82" text-anchor="middle">测试·性能·指标</text>
<rect class="b1" x="270" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="325" y="62" text-anchor="middle" dominant-baseline="middle">③ 升 JDK</text>
<text class="ts" x="325" y="82" text-anchor="middle">先于框架升级</text>
<rect class="b4" x="395" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="455" y="62" text-anchor="middle" dominant-baseline="middle">④ 依赖与迁移</text>
<text class="ts" x="455" y="82" text-anchor="middle">jakarta·自动化</text>
<rect class="b2" x="530" y="40" width="100" height="60" rx="8"/>
<text class="tb" x="580" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 试点</text>
<text class="ts" x="580" y="82" text-anchor="middle">低风险服务</text>
<rect class="b3" x="645" y="40" width="95" height="60" rx="8"/>
<text class="tb" x="692" y="62" text-anchor="middle" dominant-baseline="middle">⑥ 逐批</text>
<text class="ts" x="692" y="82" text-anchor="middle">灰度推广</text>
<line class="l" x1="130" y1="70" x2="145" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="70" x2="270" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="70" x2="395" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="70" x2="530" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="70" x2="645" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="720" height="158" rx="8"/>
<text class="th" x="32" y="140">关键原则</text>
<text class="ts" x="380" y="166" text-anchor="middle">小步多次：JDK 升级与框架升级分开做，每步都能独立验证与回滚；避免“JDK、Boot、Cloud、Hibernate 一起升”</text>
<text class="ts" x="380" y="188" text-anchor="middle">新旧共存：服务间用 HTTP/RPC 通信，天然允许 Boot 2 与 Boot 3 服务并存；接口保持向后兼容，逐服务升级而非整体切换</text>
<text class="ts" x="380" y="210" text-anchor="middle">共享库先行：公共 jar（工具、starter、API 模型）需要同时提供 javax 与 jakarta 两个版本，或先完成其改造，否则会卡住所有业务服务</text>
<text class="ts" x="380" y="232" text-anchor="middle">自动化为主：用迁移工具批量改源码与依赖，人工处理反射、字符串、XML、构建脚本；CI 中加入兼容性检查</text>
<text class="ts" x="380" y="254" text-anchor="middle">度量收益与回归：升级前后对比启动时间、内存、延迟、错误率；监控指标名变化要同步改看板告警</text>
<text class="ta" x="380" y="272" text-anchor="middle">回滚方案先于升级：保留旧版本镜像与配置，数据库与消息格式保持兼容</text>
</svg>
<figcaption>图 3：分步、可回滚的升级路线</figcaption>
</figure>

### 常见升级坑

| 坑 | 说明与处理 |
| --- | --- |
| **第三方库没有 Jakarta 版本** | 评估替换或升级；老旧组件（如停止维护的 SDK）可能成为卡点，提前列清单 |
| **Swagger/文档库不兼容** | 旧版 springfox 不支持新版本，迁移到 springdoc 等 |
| **MyBatis、Druid、分页插件等版本** | 需要与 Boot 3 兼容的版本；回归 SQL 与事务 |
| **Hibernate 6 行为变化** | SQL 生成、主键策略、HQL 严格性；回归数据层并对比 SQL |
| **Spring Security 配置重写** | 旧的适配器写法移除；权限默认更严格，需要逐接口验证 |
| **Feign/Gateway/LoadBalancer 配置变化** | 属性名与默认值调整；重试、超时配置要重新核对，见 [OpenFeign 深入](#/spring/cloud-feign) |
| **Sleuth 移除** | 追踪切换到 Micrometer Tracing，MDC 键与传播行为变化，日志格式要调整 |
| **启动与内存变化** | 新版本启动与内存特征不同；容器内存/探针时间要重新评估 |
| **原生镜像的反射问题** | 动态代理、反射、序列化需要提示配置；先在边缘服务试验，收益（启动/内存）是否值得要量化 |
| **自研 starter/公共配置** | 自动配置注册方式变化，需要重构并双版本发布 |
| **构建与 CI 环境** | 构建插件、Docker 基础镜像、静态检查工具要同步升级 |
| **测试覆盖不足** | 升级无信心；先补关键路径的集成测试与契约测试 |

## 治理能力放在哪一层

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="治理能力的三种承载方式：SDK 方式把负载均衡熔断追踪等放在应用内库中；Sidecar 服务网格把能力放在每个服务旁的代理中，与应用语言无关；平台方式由 Kubernetes、Ingress、云厂商网关承担部分治理；三者在语言无关性、升级成本、性能开销、治理集中度、运维复杂度上的取舍">
<rect class="b3" x="20" y="14" width="230" height="168" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">SDK（Spring Cloud 库）</text>
<text class="ts" x="135" y="62" text-anchor="middle">能力在应用进程内</text>
<text class="ts" x="135" y="84" text-anchor="middle">＋ 无额外一跳，性能好</text>
<text class="ts" x="135" y="106" text-anchor="middle">＋ 与业务代码结合紧，灵活</text>
<text class="ts" x="135" y="128" text-anchor="middle">－ 绑定语言，多语言要多套</text>
<text class="ts" x="135" y="150" text-anchor="middle">－ 升级要业务服务重新发布</text>
<text class="ts" x="135" y="172" text-anchor="middle">－ 各服务版本不一致难治理</text>
<rect class="b5" x="270" y="14" width="230" height="168" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">Sidecar（服务网格）</text>
<text class="ts" x="385" y="62" text-anchor="middle">能力在每个服务旁的代理</text>
<text class="ts" x="385" y="84" text-anchor="middle">＋ 语言无关，治理集中</text>
<text class="ts" x="385" y="106" text-anchor="middle">＋ 治理升级不需改业务代码</text>
<text class="ts" x="385" y="128" text-anchor="middle">－ 多一跳延迟与资源开销</text>
<text class="ts" x="385" y="150" text-anchor="middle">－ 运维与排障复杂度高</text>
<text class="ts" x="385" y="172" text-anchor="middle">－ 业务级语义（降级逻辑）仍需应用</text>
<rect class="b2" x="520" y="14" width="220" height="168" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">平台（K8s/Ingress/云）</text>
<text class="ts" x="630" y="62" text-anchor="middle">能力由平台基础设施提供</text>
<text class="ts" x="630" y="84" text-anchor="middle">＋ 服务发现、扩缩容、探针内建</text>
<text class="ts" x="630" y="106" text-anchor="middle">＋ 运维统一，应用更简单</text>
<text class="ts" x="630" y="128" text-anchor="middle">－ 治理粒度较粗（L4/L7 基础）</text>
<text class="ts" x="630" y="150" text-anchor="middle">－ 灰度/熔断等高级能力有限</text>
<text class="ts" x="630" y="172" text-anchor="middle">－ 受平台与厂商限制</text>
<rect class="bg" x="20" y="200" width="720" height="120" rx="8"/>
<text class="th" x="32" y="220">选择思路</text>
<text class="ts" x="380" y="246" text-anchor="middle">纯 Java、服务数量中等、团队熟悉 Spring Cloud：SDK 为主 + K8s 平台能力（探针、扩缩容、服务发现），最简单</text>
<text class="ts" x="380" y="268" text-anchor="middle">多语言、服务众多、需要统一的 mTLS/流量治理/灰度：评估服务网格（含无 sidecar 的新模式），接受运维成本</text>
<text class="ts" x="380" y="290" text-anchor="middle">混合是常态：入口网关 + SDK 做业务相关治理，K8s 承担基础设施能力；能力放在谁那里，要明确分工，避免两层重复（如双重重试）</text>
<text class="ts" x="380" y="310" text-anchor="middle">不要为“技术先进”引入网格：先确认现有 SDK 方案的痛点（多语言？治理升级难？）再决策</text>
</svg>
<figcaption>图 4：治理能力在 SDK、Sidecar 与平台之间的取舍</figcaption>
</figure>

特别提醒：**多层叠加会产生重复治理**——如应用内重试 + 网格重试 + 网关重试，一次失败放大成几十次；超时、重试、熔断**只在一层明确负责**，其他层关闭或配置为配合，见 [OpenFeign 深入](#/spring/cloud-feign) 的超时重试章节。

## 反模式与治理成熟度

### 常见反模式

| 反模式 | 表现 | 后果 | 改进 |
| --- | --- | --- | --- |
| **分布式单体** | 服务拆了，但必须一起发布、互相强依赖 | 拥有微服务的所有复杂度，却没有独立演进的收益 | 按业务边界重新划分，减少同步强依赖，见 [DDD 战略设计](#/design/ddd-strategic) |
| **过度拆分** | 一个功能拆成十几个小服务 | 调用链过长、事务困难、运维成本爆炸 | 合并边界不清的服务，以团队与变更频率为拆分依据 |
| **共享数据库/共享表** | 多个服务直接读写同一库表 | 耦合隐蔽，改表结构牵一发动全身 | 每个服务独占数据，其他服务通过 API 或事件获取 |
| **共享业务库（Jar）** | 公共 jar 里放业务逻辑与实体 | 升级需要全体同步，形成隐式耦合 | 只共享无业务的基础能力，接口契约化，见 [OpenFeign 深入](#/spring/cloud-feign) |
| **同步调用链过长** | A→B→C→D→E，任一环节故障全链路受影响 | 可用性乘积下降，延迟叠加 | 缩短链路、异步事件化、聚合服务、缓存冗余数据 |
| **缺少边界与负责人** | 服务无人负责、文档缺失 | 事故无人处理、僵尸服务 | 服务目录、负责人、等级与 SLO |
| **治理组件“装而不用”** | 引入了熔断/限流，没有规则与演练 | 故障时形同虚设 | 规则管理、演练、告警，见 [熔断限流实战](#/spring/cloud-resilience) |
| **没有可观测就拆分** | 拆了服务但没有追踪与统一日志 | 排障靠猜 | 基础设施先行，见 [微服务可观测](#/spring/cloud-observability) |
| **配置/密钥散落** | 配置写在代码或镜像中，密钥明文 | 变更与审计困难、泄露风险 | 配置中心与密钥管理，见 [配置管理与全链路灰度](#/spring/cloud-config-gray) |
| **数据一致性靠祈祷** | 跨服务多写没有补偿与对账 | 数据不一致无人发现 | Saga/Outbox/对账，见 [分布式事务](#/distributed/transaction) |

### 治理成熟度参考

| 层级 | 特征 | 能力要点 |
| --- | --- | --- |
| **L1 可用** | 能拆、能部署、能调用 | 注册发现、基本网关、集中日志 |
| **L2 可控** | 变更与故障可管理 | 配置中心、超时重试规范、熔断限流、基础监控告警、CI/CD |
| **L3 可观测与韧性** | 问题可快速定位并自愈 | 全链路追踪、SLO 与告警、优雅上下线、灰度发布、故障演练 |
| **L4 平台化** | 治理由平台提供，开发者低成本使用 | 服务目录、统一脚手架/SDK、流水线内置规范与安全扫描、自助配置与容量管理 |
| **L5 持续演进** | 度量驱动改进 | 依赖拓扑治理、成本与效能度量、定期架构评审与技术债清理 |

不必每个系统都追求高层级，**与业务规模、团队能力、故障代价匹配**即可；但 L2 的基础（超时重试、熔断限流、配置治理、监控告警）是生产级微服务的底线。

## 相关阅读

- [Spring Cloud 微服务全景](#/spring/cloud)：组件分工与版本对应
- [Spring Boot 自动配置与启动](#/spring/boot)：自动配置机制与 starter 迁移背景
- [DDD 战略设计：限界上下文与上下文映射](#/design/ddd-strategic)：服务边界的划分方法
- [设计方法论：从需求到架构](#/design/method)：拆分与取舍的通用方法
- [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)：验证治理措施有效性

## 面试追问

> [!QUESTION] Spring Cloud Netflix 组件退场后，分别用什么替代？
> Eureka 由 Nacos、Consul 或 Kubernetes Service 替代，Ribbon 由 Spring Cloud LoadBalancer 替代，Hystrix 由 Resilience4j 或 Sentinel 替代，Zuul 由 Spring Cloud Gateway 替代，Sleuth 由 Micrometer Tracing 加 OpenTelemetry 替代，配置中心常用 Nacos 或 Apollo。

> [!QUESTION] 从 Spring Boot 2 升级到 3 有哪些主要工作？
> JDK 升到 17+，`javax` 包迁移为 `jakarta` 并确保所有依赖都有对应版本，自动配置注册方式变化需调整自研 starter，Spring Security 6 与 Hibernate 6 等依赖大版本变化要回归，Sleuth 换成 Micrometer Tracing 并调整看板告警。建议分步、逐服务灰度升级，新旧版本通过兼容接口共存，并准备回滚。

> [!QUESTION] 虚拟线程对 Spring 微服务有什么影响？有什么坑？
> 它让同步阻塞写法也能支撑高并发，不需要为 IO 密集服务改写成响应式，Boot 3.2 以上可配置开启。但瓶颈会转移：数据库连接池、下游服务并发和 CPU 仍是上限，需要用舱壁、限流保护下游；还要注意 synchronized 导致载体线程被固定、ThreadLocal 滥用放大内存，以及线程池类指标含义改变。要先压测对比再决策。

> [!QUESTION] 治理能力应该放在 SDK 还是服务网格？
> SDK 无额外一跳、与业务结合灵活，但绑定语言、升级需业务重新发布；服务网格语言无关、治理集中，但带来延迟、资源与运维复杂度。纯 Java、团队熟悉 Spring Cloud 时 SDK 加 Kubernetes 平台能力最简单；多语言、服务众多、需统一 mTLS 与流量治理时再评估网格，并避免多层重复重试。

> [!QUESTION] 什么是分布式单体？怎么避免？
> 服务虽然拆开部署，但必须同时发布、强依赖同步调用、共享数据库，既没有独立演进的收益，又承担了分布式的复杂度。避免办法是按业务边界和团队划分服务、每个服务独占数据、减少同步强依赖并改用事件、契约化接口并保持向后兼容。

> [!QUESTION] 生产级微服务的最低治理底线是什么？
> 统一的超时与重试规范、熔断限流与舱壁、配置中心与变更治理、全链路追踪与集中日志、基础监控与告警、优雅上下线与健康探针、灰度发布与回滚能力，以及服务目录与负责人。缺少这些，故障时无法定位和止血。
