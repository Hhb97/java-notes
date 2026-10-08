---
level: 深入
tags: [Dubbo, RPC, SPI, Triple, 服务发现, 调用链路, Netty, 序列化]
summary: 讲清 Dubbo 3.x 的整体架构与分层、一次 RPC 调用从代理到 Netty 再到 Provider 的完整链路、Dubbo 协议报文结构、SPI 扩展机制，以及应用级服务发现和 Triple 协议带来的变化。
---

# Dubbo 架构与调用链路

> [!ABSTRACT] 核心要点
> - Dubbo 是 **RPC + 服务治理框架**：Provider 暴露接口，Consumer 通过**动态代理**像调本地方法一样调用；注册中心做服务发现，中间层负责**集群容错、负载均衡、路由**。
> - 调用链路：`Proxy → Filter → Cluster Invoker → Directory → Router → LoadBalance → Protocol Invoker → Netty Client → ……Netty Server → Filter → Provider 实现`。
> - **Dubbo 协议**基于 TCP 长连接，16 字节固定头 + 序列化负载（默认 Hessian2），通过 **requestId** 把异步响应与请求配对；**Triple 协议**基于 HTTP/2，与 gRPC 兼容，3.x 推荐。
> - **SPI 扩展机制**（`ExtensionLoader`、`@SPI/@Adaptive/@Activate`）是 Dubbo 的灵魂：协议、序列化、负载均衡、注册中心、Filter 全部可插拔。
> - 3.x 的重要变化：**应用级服务发现**（注册表项从“接口数”降到“实例数”）、**Triple 协议**、统一的**元数据中心**。

> [!NOTE] 版本
> 本文以 **Dubbo 3.x** 为主，必要处标注 2.7.x 差异。具体默认值可能随小版本变化，**以所用版本官方文档为准**。

## 整体架构

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="Dubbo 整体架构：Provider、Consumer、Registry、Monitor 与配置/元数据中心">
<rect class="b3" x="270" y="20" width="220" height="74" rx="12"/>
<text class="th" x="380" y="46" text-anchor="middle">Registry 注册中心</text>
<text class="ts" x="380" y="68" text-anchor="middle">Nacos / ZooKeeper / Consul</text>
<rect class="b" x="20" y="20" width="200" height="74" rx="12"/>
<text class="th" x="120" y="46" text-anchor="middle">元数据 / 配置中心</text>
<text class="ts" x="120" y="68" text-anchor="middle">服务元数据 · 动态配置 · 路由规则</text>
<rect class="b" x="540" y="20" width="200" height="74" rx="12"/>
<text class="th" x="640" y="46" text-anchor="middle">Monitor / 观测</text>
<text class="ts" x="640" y="68" text-anchor="middle">调用次数 · 耗时 · 链路追踪</text>
<rect class="b1" x="20" y="200" width="300" height="110" rx="12"/>
<text class="th" x="170" y="226" text-anchor="middle">Consumer（服务消费者）</text>
<text class="ts" x="170" y="252" text-anchor="middle">@DubboReference 代理 → 容错 / 路由 / 负载均衡</text>
<text class="ts" x="170" y="274" text-anchor="middle">本地缓存提供者地址列表</text>
<rect class="b2" x="440" y="200" width="300" height="110" rx="12"/>
<text class="th" x="590" y="226" text-anchor="middle">Provider（服务提供者）</text>
<text class="ts" x="590" y="252" text-anchor="middle">@DubboService 暴露接口 → 启动 Netty Server</text>
<text class="ts" x="590" y="274" text-anchor="middle">线程池执行业务实现</text>
<line class="la" x1="590" y1="200" x2="420" y2="94" marker-end="url(#arr-a)"/>
<text class="ta" x="540" y="140" text-anchor="middle">① 注册</text>
<line class="l" x1="150" y1="200" x2="320" y2="94" marker-end="url(#arr)"/>
<text class="ts" x="196" y="140" text-anchor="middle">② 订阅</text>
<line class="l" x1="360" y1="94" x2="210" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="318" y="164" text-anchor="middle">③ 推送变更</text>
<line class="la" x1="320" y1="255" x2="440" y2="255" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="244" text-anchor="middle">④ RPC 调用</text>
<line class="ld" x1="170" y1="310" x2="170" y2="328"/>
<line class="ld" x1="170" y1="328" x2="640" y2="328"/>
<line class="ld" x1="640" y1="328" x2="640" y2="94"/>
<text class="ts" x="400" y="322" text-anchor="middle">⑤ 异步上报统计与调用数据</text>
</svg>
<figcaption>图 1：Provider 注册、Consumer 订阅，调用直连不经过注册中心</figcaption>
</figure>

要点：**注册中心只参与“发现”，不在调用链路上**。注册中心短暂不可用，Consumer 依靠**本地缓存的地址列表**继续调用。

```java
// Provider
@DubboService(version = "1.0.0", timeout = 3000, retries = 0)
public class OrderServiceImpl implements OrderService {
    @Override public OrderDTO query(long id) { ... }
}

// Consumer
@Service
public class BizService {
    @DubboReference(version = "1.0.0", check = false, timeout = 3000)
    private OrderService orderService;       // 注入的是动态代理

    public OrderDTO get(long id) { return orderService.query(id); }
}
```

```yaml
dubbo:
  application: { name: order-provider }
  registry:    { address: nacos://127.0.0.1:8848 }
  protocol:    { name: dubbo, port: 20880 }        # 或 tri（Triple）
  scan:        { base-packages: com.example.provider }
```

## 分层架构

Dubbo 官方把框架分为 10 层（自底向上），理解这张分层图就掌握了源码主干：

| 层 | 作用 |
| --- | --- |
| Service | 业务接口与实现，使用者关心的一层 |
| **Config** | 配置层：`ServiceConfig`（暴露）、`ReferenceConfig`（引用）解析 |
| **Proxy** | 服务代理：Consumer 侧生成接口代理（Javassist / JDK），Provider 侧生成 Wrapper 调用实现 |
| Registry | 注册与发现 |
| **Cluster** | 集群：封装多个 Provider 为一个 Invoker，含**容错、路由、负载均衡** |
| Monitor | 监控 |
| **Protocol** | 协议层：封装 RPC 调用，`export`/`refer` |
| Exchange | 信息交换：封装请求-响应模式，**同步转异步**（`DefaultFuture`） |
| **Transport** | 网络传输：抽象 mina / netty，默认 **Netty** |
| Serialize | 序列化：Hessian2、Protobuf、Kryo、FastJson2…… |

核心抽象是 **`Invoker`**：一个“可调用的东西”，可以是本地实现、远程调用代理、集群封装……通过装饰器层层包装，实现过滤、容错等能力（`Invoker` 是 Dubbo 的“统一领域模型”）。

## 一次 RPC 调用的完整链路

<figure class="fig">
<svg viewBox="0 0 760 420" class="dg" role="img" aria-label="Dubbo 一次调用：Consumer 侧代理、过滤器、集群、负载均衡、Netty 到 Provider 侧过滤器与实现的流程">
<rect class="bg" x="20" y="10" width="340" height="396" rx="12"/>
<text class="th" x="190" y="34" text-anchor="middle">Consumer</text>
<rect class="b1" x="50" y="50" width="280" height="38" rx="8"/>
<text class="tb" x="190" y="69" text-anchor="middle" dominant-baseline="middle">① 代理 Proxy 拦截方法 → RpcInvocation</text>
<rect class="b1" x="50" y="100" width="280" height="38" rx="8"/>
<text class="tb" x="190" y="119" text-anchor="middle" dominant-baseline="middle">② Consumer Filter 链（监控/上下文/限流）</text>
<rect class="b3" x="50" y="150" width="280" height="62" rx="8"/>
<text class="tb" x="190" y="170" text-anchor="middle" dominant-baseline="middle">③ ClusterInvoker：容错策略</text>
<text class="ts" x="190" y="192" text-anchor="middle">Directory 取列表 → Router 过滤 → LoadBalance 选一个</text>
<rect class="b1" x="50" y="224" width="280" height="38" rx="8"/>
<text class="tb" x="190" y="243" text-anchor="middle" dominant-baseline="middle">④ DubboInvoker：序列化编码，获取长连接</text>
<rect class="b5" x="50" y="274" width="280" height="50" rx="8"/>
<text class="tb" x="190" y="292" text-anchor="middle" dominant-baseline="middle">⑤ Netty Client 发送，Future 等待</text>
<text class="ts" x="190" y="312" text-anchor="middle">DefaultFuture 按 requestId 登记</text>
<rect class="b1" x="50" y="340" width="280" height="50" rx="8"/>
<text class="tb" x="190" y="358" text-anchor="middle" dominant-baseline="middle">⑩ 收到响应 → 完成 Future → 返回结果</text>
<text class="ts" x="190" y="378" text-anchor="middle">超时则抛 TimeoutException，交容错策略</text>
<rect class="bg" x="400" y="10" width="340" height="396" rx="12"/>
<text class="th" x="570" y="34" text-anchor="middle">Provider</text>
<rect class="b5" x="430" y="274" width="280" height="50" rx="8"/>
<text class="tb" x="570" y="292" text-anchor="middle" dominant-baseline="middle">⑥ Netty Server 收包，解码</text>
<text class="ts" x="570" y="312" text-anchor="middle">IO 线程只做编解码，业务交线程池</text>
<rect class="b2" x="430" y="224" width="280" height="38" rx="8"/>
<text class="tb" x="570" y="243" text-anchor="middle" dominant-baseline="middle">⑦ 业务线程池（Dispatcher）执行</text>
<rect class="b2" x="430" y="150" width="280" height="62" rx="8"/>
<text class="tb" x="570" y="170" text-anchor="middle" dominant-baseline="middle">⑧ Provider Filter 链 → Wrapper 调用</text>
<text class="ts" x="570" y="192" text-anchor="middle">（鉴权 / 限流 / 上下文 / 令牌校验）</text>
<rect class="b2" x="430" y="100" width="280" height="38" rx="8"/>
<text class="tb" x="570" y="119" text-anchor="middle" dominant-baseline="middle">⑨ 业务实现 OrderServiceImpl</text>
<line class="l" x1="190" y1="88" x2="190" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="138" x2="190" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="212" x2="190" y2="224" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="262" x2="190" y2="274" marker-end="url(#arr)"/>
<line class="la" x1="330" y1="299" x2="430" y2="299" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="288" text-anchor="middle">TCP</text>
<line class="l" x1="570" y1="274" x2="570" y2="262" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="224" x2="570" y2="212" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="150" x2="570" y2="138" marker-end="url(#arr)"/>
<line class="ld" x1="430" y1="120" x2="400" y2="120"/>
<line class="ld" x1="400" y1="120" x2="400" y2="365"/>
<line class="ld" x1="400" y1="365" x2="330" y2="365" marker-end="url(#arr)"/>
<text class="ts" x="410" y="390" text-anchor="start">响应沿原连接返回</text>
</svg>
<figcaption>图 2：一次 Dubbo 调用的完整链路</figcaption>
</figure>

### 同步调用如何基于异步网络实现

Netty 是异步的，Dubbo 要提供“同步调用”的体验：

1. `DubboInvoker.doInvoke` 生成唯一 **requestId**，创建 `DefaultFuture`，存入全局 `FUTURES` Map；
2. 通过 Channel 异步发送请求；
3. 调用线程在 `future.get(timeout)` 上等待（同步调用），或直接返回 `CompletableFuture`（异步调用）；
4. 响应到达，Netty IO 线程解码出 `Response`，按 `requestId` 找到 `DefaultFuture` 并 `complete`，唤醒调用线程；
5. 超时由**时间轮定时器**检查（`TimeoutCheckTask`），超时后抛出 `TimeoutException`，并**清理 Future**。

关键点：**单条 TCP 连接上可以并发多个请求**（多路复用，靠 requestId 配对），因此 Dubbo 默认每个 Provider 只建**一条（或少数）长连接**，而不是连接池。

### 线程模型

- **IO 线程**（Netty Worker）：负责收发与编解码，**不执行业务**；
- **业务线程池**（Provider 侧，`dubbo` 协议默认 `fixed`，200 线程）：执行 Filter 与业务实现；
- **Dispatcher** 决定哪些事件交给业务线程池：`all`（默认，所有消息派发）、`direct`（全在 IO 线程）、`message`、`execution`、`connection`；
- 线程池耗尽 → 抛 `RejectedExecutionException`/ `Thread pool is EXHAUSTED`，Consumer 看到调用失败。需要对不同重要程度的服务设置**线程池隔离**（3.x 支持按服务/方法隔离、`executor-management-mode`）；
- Consumer 侧线程：同步调用阻塞业务线程，**调用线程被占用**，所以超时与下游容量必须设计合理。

## Dubbo 协议报文

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="Dubbo 协议报文：16 字节固定头加上序列化的负载">
<rect class="b3" x="20" y="40" width="70" height="56" rx="0"/>
<text class="tm" x="55" y="62" text-anchor="middle" dominant-baseline="middle">Magic</text>
<text class="ts" x="55" y="82" text-anchor="middle">2B 0xdabb</text>
<rect class="b3" x="90" y="40" width="130" height="56" rx="0"/>
<text class="tm" x="155" y="62" text-anchor="middle" dominant-baseline="middle">Flag</text>
<text class="ts" x="155" y="82" text-anchor="middle">1B Req/Resp·2way·Event·序列化ID</text>
<rect class="b3" x="220" y="40" width="80" height="56" rx="0"/>
<text class="tm" x="260" y="62" text-anchor="middle" dominant-baseline="middle">Status</text>
<text class="ts" x="260" y="82" text-anchor="middle">1B 响应状态</text>
<rect class="b3" x="300" y="40" width="190" height="56" rx="0"/>
<text class="tm" x="395" y="62" text-anchor="middle" dominant-baseline="middle">Request ID</text>
<text class="ts" x="395" y="82" text-anchor="middle">8B 异步配对的关键</text>
<rect class="b3" x="490" y="40" width="110" height="56" rx="0"/>
<text class="tm" x="545" y="62" text-anchor="middle" dominant-baseline="middle">Data Length</text>
<text class="ts" x="545" y="82" text-anchor="middle">4B 负载长度</text>
<rect class="b2" x="600" y="40" width="140" height="56" rx="0"/>
<text class="tm" x="670" y="62" text-anchor="middle" dominant-baseline="middle">Body</text>
<text class="ts" x="670" y="82" text-anchor="middle">序列化后的变长数据</text>
<text class="th" x="20" y="130">Request Body（序列化）</text>
<text class="tm" x="20" y="154">dubbo 版本 | 接口名 | 服务版本 | 方法名 | 参数类型描述 | 参数值… | attachments（隐式参数）</text>
<text class="th" x="20" y="188">Response Body</text>
<text class="tm" x="20" y="212">返回值类型标记（正常 / 异常 / null） | 返回值或异常对象 | attachments</text>
<text class="ts" x="600" y="124" text-anchor="start">固定头共 16 字节</text>
</svg>
<figcaption>图 3：Dubbo 协议帧结构；固定头 + 长度字段，天然解决粘包</figcaption>
</figure>

- 头部的 `Data Length` 使解码端可以用**长度字段**判断帧边界（同 [Netty 实战：编解码、内存与调优](#/infra/netty-practice)）；
- **Flag** 中包含序列化方式 id，使同一端口可以接收不同序列化；`Event` 位标记心跳（心跳包是 Event 类型的 Request）；
- **心跳**：默认 60s 间隔，`heartbeat.timeout` 为 3 倍，超时关闭连接并触发重连；
- 常见序列化：**Hessian2**（默认，2.x 的 dubbo 协议）、**Protobuf**（Triple 默认）、Kryo、FST、Fastjson2；注意**序列化兼容性**：参数类必须是 Hessian 友好的（实现 `Serializable`，避免复杂泛型与循环引用，慎用 `Optional/LocalDateTime` 的版本差异）；
- **安全**：Hessian2 反序列化曾有多个 CVE，务必升级到修复版本并开启**序列化白名单/类检查**（`serialization-check` 默认开启严格检查，3.x）。

## SPI 扩展机制

Dubbo 没有直接使用 JDK `ServiceLoader`，而是自建 `ExtensionLoader`，原因：JDK SPI 一次性实例化所有实现、无法按名字获取、不支持 IoC/AOP。

```text
META-INF/dubbo/org.apache.dubbo.rpc.cluster.LoadBalance
random=org.apache.dubbo.rpc.cluster.loadbalance.RandomLoadBalance
roundrobin=org.apache.dubbo.rpc.cluster.loadbalance.RoundRobinLoadBalance
```

```java
@SPI("random")                                             // 默认扩展名
public interface LoadBalance {
    @Adaptive("loadbalance")                               // 自适应：根据 URL 参数在运行时决定用哪个实现
    <T> Invoker<T> select(List<Invoker<T>> invokers, URL url, Invocation invocation);
}
```

| 注解 / 概念 | 作用 |
| --- | --- |
| `@SPI` | 声明扩展点，可指定默认实现名 |
| `@Adaptive` | 自适应扩展：Dubbo **动态生成代码**（`LoadBalance$Adaptive`），从 URL 取参数决定委托给哪个实现 |
| `@Activate` | 自动激活：满足条件（group、参数）的扩展自动生效，如 Filter 链 |
| Wrapper（AOP） | 以目标接口为构造参数的类被视为包装类，`ExtensionLoader` 自动层层包装，实现类似 AOP（如 `ProtocolFilterWrapper`、`ProtocolListenerWrapper`） |
| IoC | 通过 setter 注入其他扩展点的自适应实例 |

**URL 是 Dubbo 的统一数据模型**：协议、地址、参数都编码在 URL 中（如 `dubbo://10.0.0.1:20880/com.foo.OrderService?timeout=3000&version=1.0.0&weight=100`），在各层之间传递配置，配合 `@Adaptive` 实现运行时决策。自定义 Filter 示例：

```java
@Activate(group = CommonConstants.PROVIDER, order = -10000)
public class AuthFilter implements Filter {
    @Override
    public Result invoke(Invoker<?> invoker, Invocation inv) throws RpcException {
        String token = inv.getAttachment("token");
        if (!authService.valid(token)) throw new RpcException("unauthorized");
        return invoker.invoke(inv);                    // 继续责任链
    }
}
// META-INF/dubbo/org.apache.dubbo.rpc.Filter：auth=com.example.AuthFilter
```

## 服务发现：从接口级到应用级

| | 接口级（2.x 默认） | **应用级（3.x 默认）** |
| --- | --- | --- |
| 注册粒度 | 每个服务接口一条（`provider://ip:port/接口名`） | 每个**应用实例**一条（`应用名 → ip:port`） |
| 注册中心数据量 | 实例数 × 接口数，大规模下压力大 | 实例数，**大幅减少** |
| 接口元数据 | 在注册信息 URL 中 | 放到**元数据中心 / 元数据服务**（MetadataService），Consumer 按需拉取 |
| 与 Spring Cloud / K8s 互通 | 困难 | **对齐实例级模型，可互通** |

3.x 默认**双注册/双订阅**以便平滑迁移（`dubbo.registry.register-mode=all`）。灰度升级时先打开“接口级 + 应用级”，稳定后切到纯应用级。

## 协议对比：Dubbo vs Triple vs REST/gRPC

| 协议 | 传输 | 特点 | 场景 |
| --- | --- | --- | --- |
| `dubbo` | TCP 自定义帧，单连接多路复用 | **高性能、Java 生态成熟**，Hessian2 | 内部 Java 服务调用（存量最多） |
| **`tri`（Triple）** | **HTTP/2** + Protobuf（也可 JSON） | 兼容 gRPC，支持 **Streaming**、跨语言、网关/Mesh 友好；3.x 推荐 | 多语言、云原生、需要流式 |
| `rest` | HTTP/1.1 | 与 REST 生态互通 | 对外开放接口 |
| gRPC | HTTP/2 + Protobuf | 跨语言标准 | 多语言体系 |

Triple 的意义：用标准 HTTP/2 取代私有二进制协议，**可以被 Envoy/Nginx 等通用网关直接代理**，并让 Dubbo 与 gRPC 互通；性能与 dubbo 协议相当或略低，取决于场景。

## 与 Spring Cloud 对比

| | Dubbo | Spring Cloud（OpenFeign） |
| --- | --- | --- |
| 通信 | RPC（TCP / HTTP2），二进制序列化，高性能 | HTTP/JSON，跨语言友好 |
| 治理能力 | 内置：负载均衡、容错、路由、泛化、限流（配合 Sentinel） | 组合：LoadBalancer + Resilience4j/Sentinel + Gateway |
| 接口契约 | Java 接口（接口 jar 共享，耦合较强） | HTTP 接口，OpenAPI |
| 生态 | 国内互联网大量使用，阿里系 | 全球主流，Spring 生态一体 |
| 趋势 | 3.x 云原生化，可与 Spring Cloud Alibaba 并用 | 持续演进，配合 K8s |

两者并非互斥：对外/跨语言用 HTTP（网关 + REST），内部核心链路用 Dubbo/Triple，见 [Spring Cloud 微服务全景](#/spring/cloud)。

## 常见问题

| 现象 | 原因 / 排查 |
| --- | --- |
| `No provider available for the service` | 注册中心无提供者：版本号/分组不一致、Provider 未启动、命名空间/注册中心地址不一致、被路由规则过滤 |
| `Invoke remote method timeout` | 业务慢或 Provider 线程池满；检查超时设置（Consumer 与 Provider 谁生效）、GC、下游依赖 |
| `Thread pool is EXHAUSTED` | Provider 线程池打满；扩容、限流、隔离慢接口、减少同步阻塞 |
| 反序列化失败 / `ClassNotFoundException` | 接口 jar 版本不一致、参数类缺失、序列化不兼容 |
| 重复提交/重复执行 | 超时重试导致非幂等操作被多次执行（`retries` 默认 2，写操作要设 0） |
| 注册中心抖动导致服务不可用 | 3.x 对空列表有**保护**（`registry.protocol-parameters`），仍需监控；本地缓存文件 `~/.dubbo` |

## 面试追问

> [!QUESTION] 描述一次 Dubbo 调用的完整过程。
> Consumer 的动态代理将方法调用封装为 RpcInvocation，经 Filter 链，进入 ClusterInvoker，通过 Directory 获取 Provider 列表，Router 过滤，LoadBalance 选择实例，DubboInvoker 序列化并通过 Netty 发送，DefaultFuture 按 requestId 登记等待；Provider 端 Netty 解码后交业务线程池，经 Filter 链调用实现，结果沿原连接返回，Consumer 按 requestId 完成 Future。

> [!QUESTION] Dubbo 如何在异步的 Netty 上实现同步调用？
> 发送时生成唯一 requestId 并创建 DefaultFuture 登记到全局 Map；调用线程等待该 Future；响应到达后 IO 线程按 requestId 找到 Future 并完成，唤醒调用线程；超时由时间轮检测。

> [!QUESTION] Dubbo 的 SPI 与 JDK SPI 有什么区别？
> JDK SPI 一次性加载并实例化所有实现，不能按名字获取；Dubbo SPI 按需加载，支持按名取扩展、默认扩展、`@Adaptive` 自适应（运行时据 URL 动态选择）、`@Activate` 条件激活，并支持依赖注入与包装类（类似 AOP）。

> [!QUESTION] 注册中心挂了，服务还能调用吗？
> 已建立的订阅有本地缓存的地址列表，Consumer 之间仍可直连调用；新启动的 Consumer 若有本地缓存文件也可读取；但无法感知实例上下线变化。注册中心不在调用链路上。

> [!QUESTION] 应用级服务发现解决了什么问题？
> 接口级注册数据量等于“实例数 × 接口数”，大规模下注册中心压力大；应用级只注册实例，接口元数据放到元数据中心/元数据服务，减少注册数据量，并与 Spring Cloud、Kubernetes 的实例级模型对齐。

> [!QUESTION] Triple 协议相比 dubbo 协议的价值？
> 基于标准 HTTP/2，与 gRPC 兼容，支持流式调用与跨语言，能被通用网关和 Service Mesh 直接处理，更适合云原生；dubbo 协议在纯 Java 内网场景仍有成熟与性能优势。
