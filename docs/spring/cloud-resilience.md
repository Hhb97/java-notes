---
level: 深入
tags: [Sentinel, Resilience4j, 熔断, 限流, 舱壁, 热点参数, 系统保护, 规则持久化, 集群限流, fallback, Spring Cloud]
summary: 熔断限流在 Spring Cloud 中的落地：Sentinel 的规则体系（流控、熔断、热点、系统保护、授权）与资源定义、规则持久化与动态推送、与 Feign/Gateway/Dubbo 的集成；Resilience4j 的模块化组合与配置；参数设计方法、fallback 与异常分类、集群限流、监控与演练，以及两者的选型。
---

# 熔断限流实战：Sentinel 与 Resilience4j

> [!ABSTRACT] 核心要点
> - 原理（令牌桶、滑动窗口、熔断状态机、舱壁）见 [限流、熔断与降级](#/distributed/governance)。本页解决“**在 Spring Cloud 里怎么选、怎么配、怎么治理规则、怎么验证**”。
> - 两大主流：**Sentinel**（阿里，规则体系丰富，带控制台、实时统计、热点参数、系统自适应保护，**国内 Spring Cloud Alibaba/Dubbo 体系首选**）与 **Resilience4j**（轻量、函数式、模块化，**与 Spring Cloud CircuitBreaker 抽象天然契合**，国际社区常用）。
> - 保护的是**资源**：先识别要保护什么（对外接口、对下游调用、热点方法），再给每个资源配**限流、熔断、并发隔离**，**而不是给所有方法都套一遍**。
> - **规则不能只放在内存里**：控制台里配的规则重启即丢。生产必须**持久化到配置中心（如 Nacos）并动态推送**，规则与代码一样要版本化、审批、灰度。
> - 参数来自**容量与压测**：QPS 阈值取压测拐点的七成左右，熔断阈值看错误率与慢调用比例；**拍脑袋的阈值要么不触发、要么误杀**。
> - **异常要分类**：业务异常不应触发熔断；降级逻辑要简单；熔断/限流的触发要**可观测、可告警、可演练**。

## 在什么位置保护

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="微服务中熔断限流的位置：入口网关做粗粒度限流和系统保护；服务入口资源做接口限流和并发控制；调用下游的客户端侧做熔断、舱壁和超时；热点参数限流保护热点数据；系统自适应保护按负载、RT、线程数、入口 QPS 兜底">
<rect class="b3" x="20" y="30" width="130" height="70" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="85" y="74" text-anchor="middle">粗粒度限流</text>
<text class="ts" x="85" y="90" text-anchor="middle">黑白名单</text>
<rect class="b5" x="180" y="14" width="260" height="130" rx="8"/>
<text class="tb" x="310" y="34" text-anchor="middle" dominant-baseline="middle">服务 A（被调用方视角）</text>
<rect class="b1" x="194" y="48" width="110" height="34" rx="6"/>
<text class="ts" x="249" y="65" text-anchor="middle" dominant-baseline="middle">入口接口限流</text>
<rect class="b1" x="314" y="48" width="112" height="34" rx="6"/>
<text class="ts" x="370" y="65" text-anchor="middle" dominant-baseline="middle">热点参数限流</text>
<rect class="b4" x="194" y="90" width="232" height="44" rx="6"/>
<text class="ts" x="310" y="107" text-anchor="middle" dominant-baseline="middle">系统自适应保护（负载/RT/线程/入口 QPS）</text>
<text class="ts" x="310" y="124" text-anchor="middle">全局兜底，防止整体被打垮</text>
<rect class="b2" x="470" y="14" width="270" height="130" rx="8"/>
<text class="tb" x="605" y="34" text-anchor="middle" dominant-baseline="middle">服务 A（调用方视角）</text>
<rect class="b3" x="484" y="48" width="120" height="34" rx="6"/>
<text class="ts" x="544" y="65" text-anchor="middle" dominant-baseline="middle">下游熔断降级</text>
<rect class="b3" x="614" y="48" width="112" height="34" rx="6"/>
<text class="ts" x="670" y="65" text-anchor="middle" dominant-baseline="middle">舱壁/并发隔离</text>
<rect class="b3" x="484" y="90" width="242" height="44" rx="6"/>
<text class="ts" x="605" y="107" text-anchor="middle" dominant-baseline="middle">超时 + 受控重试</text>
<text class="ts" x="605" y="124" text-anchor="middle">失败快速返回，不堆积线程</text>
<line class="l" x1="150" y1="65" x2="180" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="65" x2="470" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="164" width="720" height="146" rx="8"/>
<text class="th" x="32" y="184">三个角度的分工</text>
<text class="ts" x="380" y="210" text-anchor="middle">限流（保护自己）：别人调我太多 → 入口限流/热点限流/系统保护；超出能力的请求快速拒绝，保证已接受的请求质量</text>
<text class="ts" x="380" y="232" text-anchor="middle">熔断（保护自己免受下游拖累）：我调别人慢/错 → 熔断打开，快速失败或降级，避免线程被拖死、故障扩散</text>
<text class="ts" x="380" y="254" text-anchor="middle">隔离（限制影响范围）：给每个下游/资源单独的并发配额，一个慢下游不能占满全部线程</text>
<text class="ts" x="380" y="276" text-anchor="middle">降级（保住核心）：在资源紧张时关闭非核心功能，返回缓存/默认值，优先保证主流程</text>
<text class="ts" x="380" y="298" text-anchor="middle">四者配合：限流防洪峰，熔断断链路，隔离控范围，降级保核心</text>
</svg>
<figcaption>图 1：限流、熔断、隔离、降级在调用链上的位置</figcaption>
</figure>

## Sentinel

### 概念与规则体系

| 概念 | 说明 |
| --- | --- |
| **资源（Resource）** | 被保护的对象，用一个名字标识：接口、方法、对下游的调用 |
| **规则（Rule）** | 作用于资源的保护策略，运行时动态生效 |
| **Entry / Slot Chain** | 每次调用进入资源时经过一串 Slot：统计、流控、熔断、系统保护、授权等 |
| **实时统计** | 基于**滑动窗口**统计 QPS、响应时间、异常数、并发线程数 |
| **控制台（Dashboard）** | 查看实时指标、配置规则（生产要结合持久化，不能只在控制台里点） |

| 规则类型 | 作用 | 典型配置 |
| --- | --- | --- |
| **流控规则** | 限制 QPS 或并发线程数 | 阈值、**流控模式**（直接/关联/链路）、**流控效果**（快速失败/预热/匀速排队） |
| **熔断规则** | 下游异常/慢时断开 | **慢调用比例**、**异常比例**、**异常数**；最小请求数、统计窗口、熔断时长、半开探测 |
| **热点参数规则** | 对某参数值（如商品 ID、用户 ID）单独限流 | 参数索引、阈值、例外项（特定值单独阈值） |
| **系统保护规则** | 从整体维度兜底 | 系统 Load、平均 RT、线程数、入口 QPS、CPU 使用率 |
| **授权规则** | 按调用来源黑白名单 | 来源标识（如调用方应用名） |

### 流控模式与效果

| 选项 | 含义 | 场景 |
| --- | --- | --- |
| **直接** | 资源自身达到阈值就限 | 最常用的接口限流 |
| **关联** | 关联资源达到阈值时，限制本资源 | 写接口压力大时限制读接口，或反之，保护核心 |
| **链路** | 只统计从某个入口链路来的调用 | 同一方法被多个入口调用，只限制某个入口 |
| **快速失败** | 超阈值直接拒绝（抛 `BlockException`） | 默认 |
| **Warm Up（预热）** | 阈值从低到高逐步放开 | 冷启动、缓存/连接池未热，防止刚起来被打垮 |
| **匀速排队** | 请求按固定间隔通过，超出排队等待（有超时） | 削峰填谷，如处理消息的平滑消费 |

### 使用方式

```java
// 1. 注解方式：定义资源与处理方法
@Service
public class StockService {

    @SentinelResource(
        value = "stock:deduct",                       // 资源名
        blockHandler = "deductBlocked",               // 被限流/熔断时的处理（BlockException）
        fallback = "deductFallback",                  // 业务异常的降级（其他 Throwable）
        exceptionsToIgnore = { BizException.class }   // 业务异常不计入熔断统计
    )
    public boolean deduct(Long skuId, int n) {
        return stockClient.deduct(skuId, n);          // 调用下游
    }

    public boolean deductBlocked(Long skuId, int n, BlockException ex) {
        throw new TooBusyException("系统繁忙，请稍后重试");   // 限流/熔断：快速失败，不要偷偷成功
    }

    public boolean deductFallback(Long skuId, int n, Throwable t) {
        log.warn("deduct fallback sku={}", skuId, t);
        return false;                                  // 简单降级，不再发远程调用
    }
}
```

```yaml
spring:
  cloud:
    sentinel:
      transport:
        dashboard: sentinel-dashboard:8080     # 控制台地址（仅用于上报与调试）
      eager: true                              # 启动即初始化，避免首次调用才注册资源
      datasource:
        flow:                                  # 规则持久化：从 Nacos 读取并动态更新
          nacos:
            server-addr: nacos1:8848
            namespace: prod
            data-id: ${spring.application.name}-flow-rules
            group-id: SENTINEL_GROUP
            rule-type: flow
        degrade:
          nacos:
            server-addr: nacos1:8848
            namespace: prod
            data-id: ${spring.application.name}-degrade-rules
            group-id: SENTINEL_GROUP
            rule-type: degrade
feign:
  sentinel:
    enabled: true                              # Feign 调用自动成为资源（以 服务名+方法 命名）
```

要点：

- **资源命名规范**：`模块:动作` 或 `HTTP方法:路径`，避免参数化路径（如 `/order/123`）直接作资源名导致资源数爆炸，需要路径归一化；
- **`blockHandler` 与 `fallback` 区别**：前者处理被 Sentinel 规则拦截（`BlockException`），后者处理业务方法抛出的异常；二者职责分开；
- **异常忽略**：业务异常（参数错误、库存不足）用 `exceptionsToIgnore` 排除，避免误触发熔断；
- **Web 接口**：Sentinel 对 Spring MVC 接口自动适配，被限流时统一异常处理器返回 429 或业务码，而不是默认的“Blocked by Sentinel”页面；
- **Gateway 集成**：支持**路由维度**和 **API 分组维度**的限流，与 [Spring Cloud Gateway 深入](#/spring/cloud-gateway) 配合；注意网关是响应式，使用对应的适配模块。

### 规则持久化与推送

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="Sentinel 规则持久化与推送：控制台修改规则直接写入内存只在客户端生效，重启即丢；生产应将规则写入配置中心如 Nacos，客户端监听配置变化并更新内存规则；发布规则经审批灰度，客户端状态回报到控制台用于监控">
<rect class="b4" x="20" y="30" width="330" height="110" rx="10"/>
<text class="tb" x="185" y="50" text-anchor="middle" dominant-baseline="middle">原始模式（仅演示）</text>
<text class="ts" x="185" y="76" text-anchor="middle">控制台 → 直接推送到客户端内存</text>
<text class="ts" x="185" y="96" text-anchor="middle">应用重启规则丢失</text>
<text class="ts" x="185" y="116" text-anchor="middle">多实例规则不一致，无版本无审计</text>
<rect class="b2" x="390" y="30" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="50" text-anchor="middle" dominant-baseline="middle">推荐：配置中心持久化（推模式）</text>
<text class="ts" x="565" y="76" text-anchor="middle">规则写入 Nacos（Data ID 约定）</text>
<text class="ts" x="565" y="96" text-anchor="middle">客户端监听变更，更新内存规则</text>
<text class="ts" x="565" y="116" text-anchor="middle">版本化·审批·灰度·回滚·审计</text>
<rect class="bg" x="20" y="160" width="720" height="120" rx="8"/>
<text class="th" x="32" y="180">落地要点</text>
<text class="ts" x="380" y="206" text-anchor="middle">自研或改造控制台：让“保存规则”写入配置中心而不是直接推客户端（官方控制台默认是原始模式，需要改造或用对应适配）</text>
<text class="ts" x="380" y="228" text-anchor="middle">规则 JSON 纳入代码仓库/配置平台管理，与发布流程一致；大促前预置“应急预案规则”，需要时一键启用</text>
<text class="ts" x="380" y="250" text-anchor="middle">规则校验：阈值范围、资源名存在；变更先灰度到少量实例并观察拦截量，再全量</text>
<text class="ts" x="380" y="270" text-anchor="middle">控制台只用于观测与排查；控制台自身要鉴权，并限制内网访问</text>
</svg>
<figcaption>图 2：Sentinel 规则的持久化与动态推送</figcaption>
</figure>

### 集群限流

单机限流（每台各限 N）在实例数变化时总量不可控。**集群流控**用集中式 Token Server 统一计数：

| 方式 | 说明 | 注意 |
| --- | --- | --- |
| **单机阈值 × 实例数** | 简单，常用；实例间不均衡时误差大 | 弹性扩缩容时要同步调整 |
| **集群流控（Token Server）** | 所有实例向 Token Server 申请令牌，全局精确 | Token Server 是新的**依赖与单点**，需高可用、超时降级（失败时退化为本地限流）、成本；多数场景网关层单机限流 + 业务按比例分配已够用 |
| **Redis 计数** | 在 Redis 里做全局滑动窗口/令牌桶 | 每次请求一次网络往返，延迟与 Redis 压力要评估，见 [分布式限流](#/distributed/governance) |

## Resilience4j

Resilience4j 是**轻量、模块化、基于函数式装饰**的容错库，每个能力一个模块，按需组合：

| 模块 | 作用 | 关键配置 |
| --- | --- | --- |
| **CircuitBreaker** | 熔断 | 滑动窗口类型（计数/时间）、大小、失败率阈值、慢调用阈值与比例、**最小调用数**、打开状态等待时间、半开允许调用数 |
| **RateLimiter** | 限流（周期内允许次数） | 周期、每周期次数、等待超时 |
| **Bulkhead** | 舱壁：并发调用数限制（信号量）或线程池隔离 | 最大并发数、最大等待时间；线程池版本有核心/最大线程与队列 |
| **Retry** | 重试 | 最大次数、等待时间、**指数退避与抖动**、哪些异常重试/忽略 |
| **TimeLimiter** | 超时（针对异步 Future） | 超时时间、是否取消 |
| **Cache** | 结果缓存 | — |

组合顺序影响效果，常见嵌套（由外到内）：**Retry → CircuitBreaker → RateLimiter → TimeLimiter → Bulkhead → 实际调用**（也有 Bulkhead 在外的约定，以官方文档与自己的语义为准）。**重试在熔断外层**意味着熔断打开后重试也会快速失败；顺序错了会出现“熔断统计被重试放大”等问题。

```yaml
resilience4j:
  circuitbreaker:
    instances:
      stockClient:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 50
        minimum-number-of-calls: 20           # 少于此调用数不统计，避免样本太少误判
        failure-rate-threshold: 50            # 失败率 ≥ 50% 打开
        slow-call-duration-threshold: 800ms   # 慢调用判定
        slow-call-rate-threshold: 60          # 慢调用比例 ≥ 60% 打开
        wait-duration-in-open-state: 10s      # 打开后等待多久进入半开
        permitted-number-of-calls-in-half-open-state: 5
        ignore-exceptions:                    # 业务异常不计入失败
          - com.example.BizException
  bulkhead:
    instances:
      stockClient:
        max-concurrent-calls: 30              # 对该下游的最大并发
        max-wait-duration: 0                  # 不等待，直接拒绝
  retry:
    instances:
      stockQuery:
        max-attempts: 3
        wait-duration: 100ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        retry-exceptions: [ java.io.IOException, java.util.concurrent.TimeoutException ]
```

```java
@Service
public class StockService {
    @CircuitBreaker(name = "stockClient", fallbackMethod = "fallback")
    @Bulkhead(name = "stockClient")
    public Stock query(Long skuId) { return stockClient.query(skuId); }

    private Stock fallback(Long skuId, Throwable t) {
        return Stock.unknown(skuId);              // 简单降级
    }
}
```

**Spring Cloud CircuitBreaker 抽象**：用 `CircuitBreakerFactory` 以统一 API 使用 Resilience4j 或 Sentinel 作为实现，**OpenFeign、Gateway 的熔断过滤器**都基于它，方便替换，但**高级特性**（热点参数、系统保护等）仍要用各自原生接口。

## 选型：Sentinel 还是 Resilience4j

| 维度 | Sentinel | Resilience4j |
| --- | --- | --- |
| 规则与动态性 | **运行时动态规则**、控制台、多种持久化数据源 | 配置驱动为主，动态调整相对弱（可配合配置刷新） |
| 流量控制 | 丰富：QPS/并发、关联/链路、预热、排队、**热点参数**、**系统自适应** | RateLimiter/Bulkhead 较基础 |
| 熔断 | 慢调用比例、异常比例/数 | 失败率/慢调用比例，滑动窗口配置灵活 |
| 使用方式 | 资源 + 规则，注解/适配器 | 函数式装饰/注解，**模块化** |
| 观测 | 控制台实时监控、Dubbo/Gateway 适配成熟 | 与 Micrometer 指标集成良好 |
| 生态 | Spring Cloud Alibaba、Dubbo、国内案例多 | Spring Cloud CircuitBreaker、国际社区 |
| 学习与运维成本 | 需要部署控制台并解决规则持久化 | 依赖轻，上手快，缺少统一控制台 |

经验：**国内 Alibaba/Dubbo 技术栈、需要热点限流与统一规则管理 → Sentinel**；**轻量、希望代码里清晰组合容错、已用 Micrometer 观测 → Resilience4j**；也可以**网关/入口用 Sentinel 做限流，调用下游用 Resilience4j 做熔断重试**，但要避免同一资源上两套机制语义叠加导致难以排查。

## 参数设计与验证

### 阈值怎么定

| 参数 | 方法 |
| --- | --- |
| **QPS 阈值** | 压测得到单实例**拐点**（再增加并发延迟急剧上升的点），取其 **70%~80%** 作为限流阈值；留出突发余量与实例故障余量，见 [压测方法与容量规划](#/design/eng-loadtest) |
| **并发阈值** | 约等于 吞吐 × 平均耗时（Little 定律）；线程池/连接池大小的一部分 |
| **熔断：慢调用阈值** | 取下游 P99 的 2~3 倍，并考虑调用方整体超时预算 |
| **熔断：比例与最小请求数** | 比例过低易误熔断，过高保护不及时；**最小请求数**避免低流量时一次失败就打开 |
| **熔断时长** | 给下游恢复时间（数秒到数十秒），太短会反复试探冲击，太长恢复慢；半开探测要少量 |
| **预热时长** | 取决于缓存、JIT、连接池预热时间 |
| **优先级** | 核心接口与非核心接口分别限流，核心更宽松、非核心先被牺牲 |

### 异常分类

| 异常类别 | 是否计入熔断 | 是否重试 |
| --- | --- | --- |
| 业务异常（参数、状态、余额） | **否** | 否 |
| 超时、连接失败、5xx | **是** | 视幂等性 |
| 限流/熔断拒绝（本地） | 不再计入下游 | 否 |
| 下游返回 429/503 | 是 | 带退避重试（幂等） |

### 降级设计

| 层级 | 做法 |
| --- | --- |
| **读接口** | 返回缓存/静态默认值/上一次成功结果，并标注“可能不是最新” |
| **写接口** | 一般不降级为“假成功”；返回明确失败并提示重试，或进入**异步队列**稍后处理（需用户可见状态） |
| **非核心功能** | 直接关闭（推荐、评论、积分），保住主流程 |
| **友好错误** | 统一错误码与文案；前端能区分“系统繁忙”与“业务失败” |
| **降级开关** | 手动开关（配置中心）与自动熔断并存，大促时可预先降级 |

### 验证与演练

- **压测验证**：在预发压到阈值，确认限流生效、延迟稳定、被拒请求返回正确；
- **故障注入**：让下游延迟或报错，验证熔断打开、降级返回、半开恢复；见 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)；
- **回归**：规则变更与阈值调整进入评审与灰度；
- **监控**：被限流次数、熔断状态变化、降级调用量、fallback 异常；熔断打开必须**告警**并附带资源名与原因。

## 常见坑

| 坑 | 说明与处理 |
| --- | --- |
| **规则丢失** | 控制台配的规则重启即丢，未持久化；改为配置中心推送 |
| **资源名爆炸** | 把带参数的路径当资源名，产生海量资源占内存；路径归一化 |
| **业务异常触发熔断** | 用户输错参数导致熔断；设置忽略异常 |
| **熔断样本太少误触发** | 低流量一次失败就打开；设最小请求数，或低流量服务关闭熔断 |
| **限流后返回 200 空数据** | 调用方误以为成功；限流应返回明确状态码与可识别的错误 |
| **fallback 里再调远程** | 级联故障；降级逻辑保持本地、简单 |
| **只在入口限流，不保护下游调用** | 下游慢拖垮线程；调用侧加熔断与舱壁 |
| **多层重复限流叠加** | 网关、服务、客户端各限一次，阈值不协调，难以排查；明确每层职责与阈值关系 |
| **阈值不随扩缩容调整** | 单机阈值 × 实例数变化；按实例数联动或用集群限流 |
| **线程池隔离的上下文丢失** | 线程切换后 ThreadLocal 丢失（身份、traceId）；用信号量隔离或传递上下文 |
| **控制台暴露** | 控制台无鉴权被外部访问；内网 + 鉴权 |
| **限流/熔断无告警** | 触发了没人知道；接入指标与告警 |

## 相关阅读

- [限流、熔断与降级](#/distributed/governance)：算法与原理
- [OpenFeign 深入：调用链、超时重试与上下文透传](#/spring/cloud-feign)：Feign 与熔断的集成
- [Spring Cloud Gateway 深入](#/spring/cloud-gateway)：网关限流与熔断
- [配置管理与全链路灰度](#/spring/cloud-config-gray)：规则的配置中心管理
- [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)：故障注入与演练

## 面试追问

> [!QUESTION] Sentinel 和 Resilience4j 怎么选？
> Sentinel 规则体系丰富（流控、熔断、热点参数、系统自适应保护），有控制台和动态规则，适合 Alibaba/Dubbo 技术栈和需要统一治理的场景；Resilience4j 轻量、模块化、函数式，与 Spring Cloud CircuitBreaker 和 Micrometer 契合，缺少统一控制台。要热点限流和集中规则管理选 Sentinel，要轻量组合容错选 Resilience4j。

> [!QUESTION] Sentinel 的规则怎么持久化？为什么要做？
> 控制台直接推送的规则只在客户端内存里，重启就丢且多实例不一致。生产应把规则写入 Nacos 等配置中心，客户端监听变更更新内存规则，并让规则版本化、审批、灰度和回滚，控制台只用于观测。

> [!QUESTION] 熔断器的参数怎么设置？
> 慢调用阈值取下游 P99 的两三倍，失败率和慢调用比例按容忍度设置，必须设置最小请求数避免低流量误判，熔断时长给下游恢复时间，半开阶段少量探测。业务异常要忽略，不计入失败。参数用压测和故障注入验证，而不是拍脑袋。

> [!QUESTION] 限流阈值怎么确定？单机限流和集群限流怎么选？
> 压测找到单实例拐点，取七八成作为阈值并留突发与故障余量。单机阈值乘实例数简单常用但弹性伸缩时要调整；集群限流用 Token Server 全局精确，但引入新的依赖和单点，需要高可用和降级为本地限流。多数场景网关单机限流加业务分配足够。

> [!QUESTION] 降级应该怎么设计？
> 读接口返回缓存或默认值并标注时效；非核心功能直接关闭；写接口不要降级成假成功，应返回明确失败或进入异步队列并让用户可见状态；降级逻辑简单、无外部依赖，保留手动降级开关，并监控与告警。

> [!QUESTION] 为什么业务异常不应该触发熔断？
> 熔断用来识别下游不健康，而库存不足、参数错误等业务失败说明下游工作正常。把它们计入失败会让用户输错参数就把熔断器打开，造成误杀。应通过忽略异常列表把业务异常排除，只统计超时、连接失败和 5xx。
