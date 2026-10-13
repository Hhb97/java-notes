---
level: 深入
tags: [Dubbo, 集群容错, 负载均衡, 路由, 超时重试, 泛化调用, 优雅停机, 治理]
summary: Dubbo 服务治理实战：容错策略与重试陷阱、负载均衡算法实现、路由与灰度、超时与线程池隔离、泛化调用、优雅上下线，以及线上最常见的故障清单。
---

# Dubbo 集群容错与服务治理

> [!ABSTRACT] 核心要点
> - 调用失败时的行为由**集群容错策略**决定：默认 **Failover**（失败自动切换，`retries=2` 即最多调用 3 次）。**写操作/非幂等接口必须关闭重试**（`retries=0`）或改用 Failfast。
> - **负载均衡**默认 `random`（带权重）；`leastactive` 适合性能差异大的实例；`consistenthash` 保证同参数落同一节点（缓存亲和）；`shortestresponse` 倾向响应最快的节点。
> - **超时是第一道保护**：Consumer 与 Provider 都能设置，**Consumer 端优先**；超时必须自内向外递减，否则上游超时下游仍在做无用功。
> - 治理能力：**路由规则（条件/标签）**做灰度与机房就近、**权重**做流量调度与预热、**动态配置**不重启调参、**线程池隔离**防止慢接口拖垮全局。
> - 上下线必须**优雅**：先注销（摘流）→ 等待在途请求 → 关闭；配合 K8s 探针与 preStop。

## 集群容错（Cluster）

Consumer 持有的是 `ClusterInvoker`，它封装了“多个 Provider”并决定**失败后怎么办**：

<figure class="fig">
<svg viewBox="0 0 740 290" class="dg" role="img" aria-label="Failover 容错：调用失败后重新选择另一个提供者重试，直到次数用尽">
<rect class="b1" x="20" y="100" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="125" text-anchor="middle" dominant-baseline="middle">Consumer</text>
<rect class="b3" x="190" y="100" width="150" height="50" rx="8"/>
<text class="tb" x="265" y="119" text-anchor="middle" dominant-baseline="middle">FailoverCluster</text>
<text class="ts" x="265" y="137" text-anchor="middle">retries=2，共 3 次机会</text>
<line class="l" x1="130" y1="125" x2="190" y2="125" marker-end="url(#arr)"/>
<rect class="b2" x="440" y="30" width="130" height="44" rx="8"/>
<text class="tb" x="505" y="52" text-anchor="middle" dominant-baseline="middle">Provider A</text>
<rect class="b2" x="440" y="110" width="130" height="44" rx="8"/>
<text class="tb" x="505" y="132" text-anchor="middle" dominant-baseline="middle">Provider B</text>
<rect class="b2" x="440" y="190" width="130" height="44" rx="8"/>
<text class="tb" x="505" y="212" text-anchor="middle" dominant-baseline="middle">Provider C</text>
<line class="la" x1="340" y1="112" x2="440" y2="56" marker-end="url(#arr-a)"/>
<text class="ta" x="372" y="74" text-anchor="middle">① 失败</text>
<line class="la" x1="340" y1="125" x2="440" y2="132" marker-end="url(#arr-a)"/>
<text class="ta" x="388" y="118" text-anchor="middle">② 失败</text>
<line class="la" x1="340" y1="138" x2="440" y2="206" marker-end="url(#arr-a)"/>
<text class="ta" x="372" y="190" text-anchor="middle">③ 成功</text>
<text class="ts" x="590" y="52" text-anchor="start">已调用过的节点会被排除</text>
<text class="ts" x="590" y="70" text-anchor="start">（invoked 列表）</text>
<text class="ts" x="370" y="268" text-anchor="middle">注意：超时也算失败。若 A 实际已执行成功只是响应慢，重试到 B 会导致业务被执行两次</text>
</svg>
<figcaption>图 1：Failover 把失败换节点重试；对非幂等操作是危险的</figcaption>
</figure>

| 策略 | `cluster=` | 行为 | 适用 |
| --- | --- | --- | --- |
| **Failover**（默认） | `failover` | 失败重试其他节点，`retries` 默认 2（不含首次） | **读操作、幂等操作** |
| Failfast | `failfast` | 失败立即抛错，不重试 | **非幂等写**（下单、扣款）|
| Failsafe | `failsafe` | 失败忽略，返回空结果 | 审计、日志等旁路 |
| Failback | `failback` | 失败记录，定时重发 | 消息通知 |
| Forking | `forking` | **并行**调用多个节点，一个成功即返回（`forks`） | 实时性高的读，浪费资源 |
| Broadcast | `broadcast` | 广播所有节点，任一失败则失败 | 通知所有节点刷新缓存 |
| Available | `available` | 调用第一个可用节点，不做负载均衡 | 测试/简单场景 |
| Mergeable | `mergeable` | 调用所有节点并合并结果 | 分组聚合 |

```java
@DubboReference(cluster = "failfast", timeout = 2000)                    // 写操作
private PayService payService;

@DubboReference(cluster = "failover", retries = 1, timeout = 1000)       // 读操作
private ProductService productService;

@DubboService(retries = 0)                                              // Provider 侧声明默认值，Consumer 可覆盖
```

> [!WARNING] 重试与幂等：最常见的生产事故之一
> 默认 Failover + 超时，会让一个“响应慢但已执行成功”的写请求被重复执行，造成重复下单/重复扣款。规则：**写接口显式 `retries=0`**（或设计成幂等：业务唯一键、状态机、去重表），并且重试次数要纳入整个调用链的超时预算，避免重试放大雪崩（见 [限流、熔断与降级](#/distributed/governance)）。

### 服务降级：mock

```java
@DubboReference(mock = "return null")                                  // 失败时返回 null
@DubboReference(mock = "com.example.StockServiceMock")                 // 实现接口的本地降级类
```

2.x/3.x 的 `mock` 在调用**失败**（含超时）时触发；`force:return` 可由治理控制台强制屏蔽调用（紧急降级）。现代做法常结合 Sentinel 的熔断降级实现。

## 负载均衡（LoadBalance）

| 算法 | 值 | 原理 | 适用 |
| --- | --- | --- | --- |
| **加权随机** | `random`（默认） | 按权重随机，权重越大概率越高 | 通用 |
| 加权轮询 | `roundrobin` | 平滑加权轮询（类似 Nginx） | 请求耗时均匀 |
| **最少活跃数** | `leastactive` | 优先选当前**未完成请求数**最少的节点；活跃数相同按权重随机 | 节点性能差异大：慢节点活跃数高，自然少分请求 |
| **一致性哈希** | `consistenthash` | 相同参数（默认第一个参数）落到同一节点；160 个虚拟节点 | 需要缓存亲和、有状态路由 |
| **最短响应** | `shortestresponse` | 选取最近一段时间平均响应最快的节点（2.7.7+） | 响应时间差异明显 |

权重的作用：除了影响分配比例，**预热（warmup）**机制在 Provider 刚启动的前 10 分钟（默认）线性提升权重，避免冷启动（JIT 未就绪、缓存为空）被打满：

```text
有效权重 = 配置权重 × min(1, 运行时长 / warmup)       # warmup 默认 600000ms
```

```java
@DubboReference(loadbalance = "leastactive")
@DubboService(weight = 200)                      // 高配机器给更高权重；也可通过动态配置实时调整
```

## 路由（Router）

Directory 得到的是**全量**地址列表，Router 按规则**筛选出可用子集**，再交给负载均衡：

| 路由 | 用途 |
| --- | --- |
| **条件路由** | `host != 10.0.0.9 => …`：表达式匹配请求参数/方法，把特定流量导向特定 Provider |
| **标签路由（Tag Router）** | 给 Provider 打标签（`dubbo.tag=gray`），请求携带标签时只路由到对应实例，**用于灰度、泳道、蓝绿** |
| 脚本路由 | 用脚本自定义复杂规则 |
| 自定义 Router | 实现 `Router` SPI（例如就近机房路由） |

```java
// 全链路灰度示例：Consumer 请求设置 tag，Provider 打了对应标签的实例才会接收
RpcContext.getClientAttachment().setAttachment(CommonConstants.TAG_KEY, "gray");
```

```yaml
# Provider（灰度实例）
dubbo:
  provider:
    tag: gray
```

路由规则可通过**配置中心/治理控制台动态下发**，无需重启。**标签要沿调用链透传**（通过 attachment 在多级服务间传递）才能实现全链路灰度。

## 超时、线程池与隔离

### 超时

- 优先级：**方法级 Consumer > 方法级 Provider > 接口级 Consumer > 接口级 Provider > 全局**（Consumer 端配置优先，这是“消费者最清楚自己能等多久”的设计）；
- 默认 `timeout = 1000ms`，对慢接口要显式放大，但**不能无限大**；
- 超时只是 Consumer 放弃等待，**Provider 的业务线程仍在继续执行**，会造成资源浪费。Provider 侧也应有**自己的超时与取消**（如 DB 查询超时）；
- 超时预算：A → B → C，A 的超时 > B 的超时 + 重试 > C 的超时。

### Provider 线程池与隔离

| 配置 | 说明 |
| --- | --- |
| `threadpool`（`fixed` 默认/`cached`/`limited`/`eager`） | 线程池类型；`fixed` 默认 `threads=200` |
| `threads` / `queues` | 线程数与队列长度；**队列大会让请求排队过久直至超时**，通常设小或 0 |
| `accepts` | 服务端最大连接数 |
| `executes` | **服务级并发控制**：同一服务方法同时执行数上限（`ExecuteLimitFilter`），超限直接拒绝 |
| `actives`（Consumer） | 单个消费者对该服务的最大并发调用数，防止自己被慢服务拖死 |
| 线程池隔离 | 3.x 可为重要服务配置独立线程池，避免慢接口耗尽共享池 |

```java
@DubboService(executes = 50)                                 // 限制该服务并发执行 50，超出快速失败，保护实例
@DubboReference(actives = 20, timeout = 800)                 // Consumer 侧限流
```

## 泛化调用与异步

```java
// 泛化引用：Consumer 不依赖接口 jar，用于网关、测试平台、协议转换
ReferenceConfig<GenericService> ref = new ReferenceConfig<>();
ref.setInterface("com.example.OrderService");
ref.setGeneric("true");
GenericService svc = ref.get();
Object result = svc.$invoke("query", new String[]{"long"}, new Object[]{1001L});   // 返回 Map 等通用结构
```

```java
// 异步调用：返回 CompletableFuture，不阻塞调用线程
@DubboReference
private AsyncOrderService asyncService;      // 接口方法返回 CompletableFuture<OrderDTO>
asyncService.queryAsync(id).whenComplete((r, e) -> {...});
```

- 泛化调用适合**API 网关**（HTTP → Dubbo 的协议转换）、动态调用平台；
- 异步调用在 **Consumer 并发调用多个下游**时可显著降低总耗时，但注意线程上下文（`RpcContext`、`ThreadLocal`、事务）不会自动传递。

## 上下文传递与隐式参数

```java
// Consumer 设置，随请求透传到 Provider（仅一次调用有效，调用后清除）
RpcContext.getClientAttachment().setAttachment("traceId", traceId);

// Provider 读取
String traceId = RpcContext.getServerAttachment().getAttachment("traceId");
```

用于**链路追踪 ID、灰度标签、租户 ID、用户身份**的透传。注意 attachment 只对**当前这次调用**生效，在 Provider 中再发起新的 Dubbo 调用时需要**重新设置**（或用 Filter 统一透传）。生产上通常在 Filter 中把 MDC / TraceContext 自动注入 attachment。

## 优雅上下线

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="Dubbo 优雅下线的步骤：注销、等待在途请求、关闭连接与线程池">
<rect class="b4" x="20" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="84" text-anchor="middle" dominant-baseline="middle">1 收到 SIGTERM</text>
<text class="ts" x="80" y="108" text-anchor="middle">JVM Shutdown Hook</text>
<rect class="b3" x="170" y="60" width="130" height="70" rx="8"/>
<text class="tb" x="235" y="84" text-anchor="middle" dominant-baseline="middle">2 从注册中心注销</text>
<text class="ts" x="235" y="108" text-anchor="middle">Consumer 不再选中我</text>
<rect class="b3" x="330" y="60" width="130" height="70" rx="8"/>
<text class="tb" x="395" y="84" text-anchor="middle" dominant-baseline="middle">3 等待在途请求</text>
<text class="ts" x="395" y="108" text-anchor="middle">timeout.shutdown 超时</text>
<rect class="b5" x="490" y="60" width="110" height="70" rx="8"/>
<text class="tb" x="545" y="84" text-anchor="middle" dominant-baseline="middle">4 关闭服务端</text>
<text class="ts" x="545" y="108" text-anchor="middle">Netty / 线程池</text>
<rect class="b2" x="630" y="60" width="90" height="70" rx="8"/>
<text class="tb" x="675" y="84" text-anchor="middle" dominant-baseline="middle">5 进程退出</text>
<line class="l" x1="140" y1="95" x2="170" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="95" x2="330" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="95" x2="490" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="95" x2="630" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="370" y="176" text-anchor="middle">要点：注销与连接关闭之间留出时间，让 Consumer 感知到变更并停止新请求；Consumer 侧失败自动重试到其他节点</text>
<text class="ts" x="370" y="200" text-anchor="middle">在 K8s 里：preStop sleep → SIGTERM → terminationGracePeriodSeconds 要大于 Dubbo 的关闭等待</text>
</svg>
<figcaption>图 2：先摘流量再停服务，滚动发布才不会产生调用失败</figcaption>
</figure>

要点：

- Provider：`dubbo.application.shutwait`（旧）/ `dubbo.shutdown.timeout`（3.x）设置等待时间；确保 JVM 通过 `SIGTERM`（而非 `kill -9`）退出；
- **启动期预热**：服务启动后先延迟暴露（`delay`）或在**初始化完成（缓存预热、连接池建立）后再注册**，避免接收流量时尚未就绪；
- Consumer 侧启动 `check=false`（不因下游暂不可用而启动失败），或启动时 `check=true` 以便尽早暴露配置错误；
- Kubernetes 中：把**注册时机**与 readiness 探针对齐，滚动更新参见 [Kubernetes 核心概念](#/infra/k8s)。

## 治理动态配置

Dubbo 将超时、权重、路由、标签等做成**动态配置**（配置中心 Nacos/ZK + Dubbo Admin 控制台）：

| 能力 | 场景 |
| --- | --- |
| 动态调整权重 | 新机器预热、故障机器降权、压测引流 |
| 禁用/启用提供者 | 不重启下线某个异常实例 |
| 动态覆盖超时/重试 | 线上事故时调大/调小超时 |
| 路由规则 | 灰度、机房就近、白名单 |
| 服务降级（mock） | 紧急屏蔽非核心依赖 |

> [!TIP] 治理最佳实践
> 1. 所有写接口 `retries=0` 并保证幂等；2. 超时按调用链自内向外递减；3. 每个服务都设 `executes/actives` 做并发保护；4. 统一 Filter 透传 traceId 与灰度标签；5. Provider 启动预热、下线优雅；6. 监控每个方法的 QPS、RT、失败率与线程池使用率；7. 对非核心依赖配 mock/Sentinel 降级。

## 常见线上故障清单

| 现象 | 根因 | 对策 |
| --- | --- | --- |
| 下单被重复执行 | 超时 + Failover 重试，非幂等 | 写接口 `retries=0`；幂等键 |
| 某个慢接口拖垮整个服务 | 共享线程池被占满 | 服务级线程池隔离、`executes`、超时与限流 |
| 发布期间出现大量调用失败 | 实例下线未摘流 / 新实例未就绪就接流量 | 优雅下线；预热；注册时机与 readiness 对齐 |
| Consumer 调用到已下线实例 | 注册中心推送延迟或本地缓存未更新 | 失败重试、健康检查；保证优雅注销 |
| `RpcException: Failed to invoke ... Tried 3 times` | Failover 3 次均失败 | 看每次失败的**根因**（通常是 Provider 异常或超时），不是重试本身的问题 |
| 反序列化异常 | 接口 jar 不一致、返回对象新增字段不兼容 | 接口演进只**增加**字段；通过版本号灰度；严格的 jar 管理 |
| 流量打到有问题的单个实例 | 负载均衡不感知实例异常 | 使用 `leastactive`/`shortestresponse`；配合熔断与健康检查摘除 |
| 注册中心压力大 | 大量接口级注册 | 升级到应用级服务发现 |

## 相关阅读

- [Nacos 与服务注册发现、配置中心](#/mw/registry)：注册发现与配置治理
- [熔断限流实战：Sentinel 与 Resilience4j](#/spring/cloud-resilience)：Sentinel 在 Dubbo 与 Spring Cloud 中的使用

## 面试追问

> [!QUESTION] Dubbo 有哪些集群容错策略？默认是什么？有什么坑？
> Failover（默认，失败重试其他节点）、Failfast、Failsafe、Failback、Forking、Broadcast 等。坑在 Failover 对非幂等写操作会因超时重试导致重复执行，写接口应设 `retries=0` 或保证幂等。

> [!QUESTION] Dubbo 的负载均衡算法有哪些？leastactive 的原理？
> random（默认，加权）、roundrobin、leastactive、consistenthash、shortestresponse。leastactive 统计每个提供者当前未完成的请求数，优先选最小的，慢节点活跃数高自然被少分配，适合性能差异明显的集群。

> [!QUESTION] Dubbo 超时设置有什么原则？
> Consumer 端优先于 Provider 端；超时要自内向外递减并计入重试；超时后 Provider 仍可能在执行，所以 Provider 要有自己的执行超时；配合限流与线程池隔离避免慢请求堆积。

> [!QUESTION] 如何用 Dubbo 实现灰度发布？
> 给灰度实例打标签（Tag Router），灰度流量在请求 attachment 中携带标签并沿调用链透传，路由时只选择匹配标签的实例；也可以用条件路由或权重逐步放量，规则由配置中心动态下发。

> [!QUESTION] 如何保证 Dubbo 服务发布时不丢请求？
> 先从注册中心注销让 Consumer 停止选中，再等待在途请求完成后关闭 Netty 和线程池；新实例在预热完成后再注册；Consumer 对失败做重试切换节点；在 K8s 中配合 preStop、readiness 与足够的 terminationGracePeriodSeconds。
