---
level: 进阶
tags: [gRPC, Protobuf, HTTP/2, RPC, 流式调用, Deadline, 拦截器, 负载均衡, 服务治理, Triple]
summary: gRPC 与 Protobuf 的完整笔记：为什么选 gRPC、Protobuf 的编码原理与向后兼容规则、基于 HTTP/2 的四种调用方式、Java 服务端/客户端代码、Deadline 与取消、状态码与错误处理、拦截器与元数据、负载均衡（长连接陷阱）、健康检查与重试、TLS/认证、与 REST/Dubbo 的对比与选型，以及生产踩坑。
---

# gRPC 与 Protobuf：协议、流式调用与治理

> [!ABSTRACT] 核心要点
> - **gRPC = Protobuf（IDL + 二进制序列化）+ HTTP/2（多路复用传输）+ 代码生成**：先写 `.proto` 契约，自动生成多语言的客户端/服务端桩代码，天然适合**多语言微服务**与**内部高性能调用**。
> - **Protobuf** 体积小、解析快，用**字段编号**而非字段名标识数据，**兼容性靠编号规则**：只能新增字段、不能复用或改变已有编号的含义。
> - **四种调用**：一元、服务端流、客户端流、双向流——流式是 gRPC 相对 REST 的显著能力（推送、大数据分块、实时通信）。
> - **每个调用必须设置 Deadline（截止时间）**，并沿调用链传播；否则下游故障会让线程/连接被无限占用，引发雪崩。
> - **负载均衡是 gRPC 最大的坑**：HTTP/2 是**长连接多路复用**，四层负载均衡器只在“建立连接”时分配，导致所有请求落在同一后端。要用**客户端负载均衡**（服务发现 + round_robin）或**七层（L7）代理**（Envoy/Istio）。
> - 适用：**内部服务间高吞吐低延迟调用、多语言、流式**；不适合：**浏览器直连（需 grpc-web）、对外开放 API、需要强缓存/可读性的场景**（用 REST）。

> [!NOTE] 关联
> 对比 Dubbo 见 [Dubbo 架构](#/mw/dubbo)；HTTP/2 基础见 [TCP/IP 与 HTTP(S)](#/infra/network)；Netty 是 grpc-java 的传输层，见 [Netty](#/infra/netty)。

## 一、为什么是 gRPC

REST/JSON 的痛点（内部服务调用场景）：

| 痛点 | gRPC 的方案 |
| --- | --- |
| JSON 文本体积大、解析慢 | Protobuf 二进制，体积通常小数倍，解析快 |
| 接口契约靠文档，易漂移 | `.proto` 即契约，**强类型 + 代码生成** |
| HTTP/1.1 一个连接一次一个请求（队头阻塞） | **HTTP/2 多路复用**，一个连接并发多个流 |
| 只有请求-响应 | **双向流**、服务端推送 |
| 多语言各写各的客户端 | 官方支持 Java/Go/C++/Python/Node/C#/Rust 等 |
| 超时、取消、元数据没有标准 | **Deadline、取消传播、Metadata、标准状态码**内建 |

代价：**可读性与调试性差**（二进制，需要工具如 `grpcurl`、Postman、BloomRPC 类客户端）、浏览器不能直接调用、依赖代码生成流程、**对 L4 负载均衡不友好**。

## 二、整体架构

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="gRPC 架构：开发者编写 proto 文件，protoc 加插件生成客户端存根与服务端骨架；客户端调用存根方法，经 Protobuf 序列化，通过 HTTP/2 流发送到服务端；服务端框架反序列化后调用业务实现并返回；通道 Channel 负责连接管理、负载均衡与服务发现">
<rect class="b5" x="20" y="30" width="170" height="70" rx="10"/>
<text class="tb" x="105" y="54" text-anchor="middle" dominant-baseline="middle">order.proto</text>
<text class="ts" x="105" y="76" text-anchor="middle">服务与消息的契约</text>
<rect class="b3" x="230" y="30" width="170" height="70" rx="10"/>
<text class="tb" x="315" y="54" text-anchor="middle" dominant-baseline="middle">protoc + 插件</text>
<text class="ts" x="315" y="76" text-anchor="middle">生成桩代码</text>
<line class="l" x1="190" y1="65" x2="230" y2="65" marker-end="url(#arr)"/>
<rect class="b1" x="20" y="150" width="200" height="110" rx="10"/>
<text class="th" x="36" y="174">客户端</text>
<text class="ts" x="36" y="196">Stub.createOrder(req)</text>
<text class="ts" x="36" y="216">Channel：连接池/LB/重试</text>
<text class="ts" x="36" y="236">拦截器：鉴权/日志/追踪</text>
<rect class="b2" x="580" y="150" width="200" height="110" rx="10"/>
<text class="th" x="596" y="174">服务端</text>
<text class="ts" x="596" y="196">ServiceImplBase 的实现</text>
<text class="ts" x="596" y="216">线程池执行业务</text>
<text class="ts" x="596" y="236">拦截器 / 健康检查</text>
<rect class="bg" x="260" y="160" width="290" height="90" rx="10"/>
<text class="th" x="276" y="184">HTTP/2 连接</text>
<text class="ts" x="276" y="206">一个连接 = 多个并发 Stream</text>
<text class="ts" x="276" y="226">HEADERS + DATA（Protobuf 帧）+ Trailers(状态)</text>
<line class="l" x1="220" y1="205" x2="260" y2="205" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="205" x2="580" y2="205" marker-end="url(#arr)"/>
<line class="ld" x1="315" y1="100" x2="120" y2="150"/>
<line class="ld" x1="315" y1="100" x2="680" y2="150"/>
<text class="ts" x="400" y="284" text-anchor="middle">传输层：grpc-java 默认基于 Netty；序列化：Protobuf；也可插入压缩（gzip）与 TLS</text>
</svg>
<figcaption>图 1：gRPC 的契约、代码生成与调用链路</figcaption>
</figure>

## 三、Protobuf

### 1. 定义

```protobuf
syntax = "proto3";
package shop.order.v1;                     // 包名带版本，便于未来出 v2
option java_multiple_files = true;
option java_package = "com.example.shop.order.v1";

import "google/protobuf/timestamp.proto";

service OrderService {
  rpc CreateOrder (CreateOrderRequest) returns (CreateOrderResponse);            // 一元
  rpc WatchOrder  (WatchOrderRequest)  returns (stream OrderEvent);              // 服务端流
  rpc UploadItems (stream Item)        returns (UploadSummary);                  // 客户端流
  rpc Chat        (stream ChatMsg)     returns (stream ChatMsg);                 // 双向流
}

message CreateOrderRequest {
  string request_id = 1;                    // 幂等键
  int64  user_id    = 2;
  repeated Item items = 3;                  // 列表
  map<string, string> attrs = 4;            // 映射
  Address ship_to   = 5;
  reserved 6, 7;                            // 已删除字段的编号：永远保留，禁止复用
  reserved "legacy_coupon";                 // 同时保留字段名
}

message Item { int64 sku_id = 1; int32 quantity = 2; int64 price_fen = 3; }       // 金额用整数分
message Address { string province = 1; string city = 2; string detail = 3; }

message CreateOrderResponse {
  int64 order_id = 1;
  Status status  = 2;
  google.protobuf.Timestamp created_at = 3;
  enum Status { STATUS_UNSPECIFIED = 0; CREATED = 1; REJECTED = 2; }   // 枚举第一个必须是 0 作默认值
}
```

### 2. 编码原理（为什么小又快）

每个字段编码为 **`tag + value`**：`tag = (字段编号 << 3) | wire type`，字段名**不出现在数据里**；整数用 **Varint**（小数字占更少字节，7 位一组、最高位表示是否继续），负数的 `int32/int64` 要 10 字节（负数多用 `sint32/sint64` 的 **ZigZag** 编码）。

<figure class="fig">
<svg viewBox="0 0 800 270" class="dg" role="img" aria-label="Protobuf 编码示例：字段 user_id 编号 2 值 150；tag 为 2 左移 3 加 wire type 0 等于 0x10；150 的 varint 编码为 0x96 0x01 两个字节；整条消息只有 3 个字节；字符串字段使用长度前缀编码 wire type 2；JSON 则需要写字段名和引号冒号">
<text class="th" x="20" y="26">message { int64 user_id = 2; }   user_id = 150</text>
<rect class="b5" x="40" y="44" width="100" height="50" rx="6"/>
<text class="tb" x="90" y="64" text-anchor="middle" dominant-baseline="middle">0x10</text>
<text class="ts" x="90" y="84" text-anchor="middle">tag = 2&lt;&lt;3 | 0</text>
<rect class="b3" x="160" y="44" width="100" height="50" rx="6"/>
<text class="tb" x="210" y="64" text-anchor="middle" dominant-baseline="middle">0x96</text>
<text class="ts" x="210" y="84" text-anchor="middle">150 低7位|续位</text>
<rect class="b3" x="280" y="44" width="100" height="50" rx="6"/>
<text class="tb" x="330" y="64" text-anchor="middle" dominant-baseline="middle">0x01</text>
<text class="ts" x="330" y="84" text-anchor="middle">高位部分</text>
<text class="ts" x="410" y="62" text-anchor="start">共 3 字节：字段编号 + 类型合并成 tag，数值用变长整数</text>
<text class="ts" x="410" y="82" text-anchor="start">同样的 JSON：{"userId":150} 约 14 字节，且要解析文本</text>
<rect class="bg" x="20" y="116" width="760" height="140" rx="10"/>
<text class="th" x="36" y="140">Wire type：0 Varint · 1 64 位 · 2 长度前缀（string/bytes/嵌套消息）· 5 32 位</text>
<text class="ts" x="36" y="166">• 未知字段：旧代码读到新字段会保留或忽略（proto3 现在默认保留），不会报错 → 这就是前后向兼容的基础</text>
<text class="ts" x="36" y="188">• 默认值不编码：值等于默认值（0、空串、false）的字段不会出现在字节流中，省空间；因此 proto3 普通标量无法区分“没设置”与“设置为 0”</text>
<text class="ts" x="36" y="210">  → 需要区分时用 optional（有 presence）或包装类型（google.protobuf.Int32Value）或 FieldMask</text>
<text class="ts" x="36" y="232">• 字段编号 1~15 只占 1 字节 tag，常用/高频字段放 1~15；16 以上占 2 字节</text>
<text class="ts" x="36" y="250">• 编码是确定的但不保证跨语言字节完全一致（map 顺序等），不要把序列化结果当哈希/签名的唯一输入</text>
</svg>
<figcaption>图 2：Protobuf 编码：tag + varint，字段名不上线</figcaption>
</figure>

### 3. 兼容性规则（最重要）

| 操作 | 是否安全 | 说明 |
| --- | --- | --- |
| **新增字段**（用新编号） | ✅ | 旧客户端忽略；新客户端读旧数据得到默认值 |
| **删除字段** | ⚠️ | 必须 `reserved` 编号与名称，**永不复用** |
| **修改字段编号** | ❌ | 等同于删除并新增，数据会被误解 |
| **修改字段类型** | ❌/⚠️ | 仅少数兼容（int32/int64/uint/bool 间部分可兼容），一般视为不兼容 |
| 重命名字段 | ✅（二进制）/⚠️（JSON） | 二进制只看编号；但 JSON 映射和使用字段名的代码会受影响 |
| 枚举新增值 | ✅ | 旧代码遇到未知枚举值要有处理（proto3 保留为未知数值） |
| 把单个字段改为 repeated | ⚠️ | 部分情形兼容，谨慎 |
| 把非嵌套改为 oneof | ⚠️ | 仅单字段移入是兼容的 |

工程实践：用 **`buf`**（`buf lint`、`buf breaking`）在 CI 中**自动检查破坏性变更**；`.proto` 放独立仓库或统一目录，版本化管理；包名带 `v1`，不兼容时发布新的 `v2` 包并行迁移（参见 [发布策略：接口兼容](#/infra/release)）。

## 四、四种调用方式

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="gRPC 四种调用方式：一元调用一个请求一个响应；服务端流一个请求多个响应；客户端流多个请求一个响应；双向流两端各自独立读写；流式适合实时推送、大数据分块上传下载和聊天">
<rect class="b3" x="20" y="20" width="370" height="130" rx="12"/>
<text class="th" x="36" y="44">一元 Unary（最常用）</text>
<text class="ts" x="36" y="70">客户端 ── 1 个请求 ──► 服务端</text>
<text class="ts" x="36" y="90">客户端 ◄── 1 个响应 ── 服务端</text>
<text class="ts" x="36" y="116">等价 REST 的请求-响应；绝大多数接口</text>
<text class="ts" x="36" y="136">rpc Get(Req) returns (Resp)</text>
<rect class="b2" x="410" y="20" width="370" height="130" rx="12"/>
<text class="th" x="426" y="44">服务端流 Server streaming</text>
<text class="ts" x="426" y="70">客户端 ── 1 个请求 ──► 服务端</text>
<text class="ts" x="426" y="90">客户端 ◄── N 个响应 ── 服务端（持续推送）</text>
<text class="ts" x="426" y="116">订阅事件、大结果集分批返回、日志 tail</text>
<text class="ts" x="426" y="136">rpc Watch(Req) returns (stream Resp)</text>
<rect class="b5" x="20" y="170" width="370" height="150" rx="12"/>
<text class="th" x="36" y="194">客户端流 Client streaming</text>
<text class="ts" x="36" y="220">客户端 ── N 个请求 ──► 服务端</text>
<text class="ts" x="36" y="240">客户端 ◄── 1 个响应（汇总）── 服务端</text>
<text class="ts" x="36" y="266">大文件分块上传、批量上报、传感器数据汇聚</text>
<text class="ts" x="36" y="286">rpc Upload(stream Req) returns (Resp)</text>
<rect class="b1" x="410" y="170" width="370" height="150" rx="12"/>
<text class="th" x="426" y="194">双向流 Bidirectional</text>
<text class="ts" x="426" y="220">客户端 ◄──► 服务端：两条独立的流，任意时机读写</text>
<text class="ts" x="426" y="242">聊天、实时协作、语音识别、边传边处理</text>
<text class="ts" x="426" y="264">要注意：背压（流控）、心跳保活、异常与取消、</text>
<text class="ts" x="426" y="284">长连接占用资源与负载均衡粘性</text>
<text class="ts" x="426" y="304">rpc Chat(stream Msg) returns (stream Msg)</text>
</svg>
<figcaption>图 3：四种调用模式</figcaption>
</figure>

## 五、Java 实战

### 1. 构建与代码生成（Maven）

```xml
<dependencies>
  <dependency><groupId>io.grpc</groupId><artifactId>grpc-netty-shaded</artifactId><version>${grpc.version}</version></dependency>
  <dependency><groupId>io.grpc</groupId><artifactId>grpc-protobuf</artifactId><version>${grpc.version}</version></dependency>
  <dependency><groupId>io.grpc</groupId><artifactId>grpc-stub</artifactId><version>${grpc.version}</version></dependency>
</dependencies>
<build>
  <extensions><extension><groupId>kr.motd.maven</groupId><artifactId>os-maven-plugin</artifactId></extension></extensions>
  <plugins>
    <plugin>
      <groupId>org.xolstice.maven.plugins</groupId><artifactId>protobuf-maven-plugin</artifactId>
      <configuration>
        <protocArtifact>com.google.protobuf:protoc:${protoc.version}:exe:${os.detected.classifier}</protocArtifact>
        <pluginId>grpc-java</pluginId>
        <pluginArtifact>io.grpc:protoc-gen-grpc-java:${grpc.version}:exe:${os.detected.classifier}</pluginArtifact>
      </configuration>
      <executions><execution><goals><goal>compile</goal><goal>compile-custom</goal></goals></execution></executions>
    </plugin>
  </plugins>
</build>
```

（版本号以官方最新稳定版为准；生成的代码在 `target/generated-sources`。）

### 2. 服务端

```java
public class OrderServiceImpl extends OrderServiceGrpc.OrderServiceImplBase {
    @Override
    public void createOrder(CreateOrderRequest req, StreamObserver<CreateOrderResponse> out) {
        try {
            if (req.getItemsCount() == 0) {
                out.onError(Status.INVALID_ARGUMENT.withDescription("items 不能为空").asRuntimeException());   // 标准状态码
                return;
            }
            long id = orderService.create(req);                               // 业务逻辑（注意：阻塞操作占用 gRPC 执行线程）
            out.onNext(CreateOrderResponse.newBuilder().setOrderId(id).setStatus(Status.CREATED).build());
            out.onCompleted();                                                // 一元调用：onNext 一次 + onCompleted
        } catch (BusinessException e) {
            out.onError(Status.FAILED_PRECONDITION.withDescription(e.getMessage()).asRuntimeException());
        }
    }

    // 服务端流：持续 onNext，要检查客户端是否已取消
    @Override
    public void watchOrder(WatchOrderRequest req, StreamObserver<OrderEvent> out) {
        ServerCallStreamObserver<OrderEvent> so = (ServerCallStreamObserver<OrderEvent>) out;
        Subscription sub = events.subscribe(req.getOrderId(), e -> { if (!so.isCancelled()) so.onNext(e); });
        so.setOnCancelHandler(sub::cancel);                                   // 客户端取消/断开时释放资源，防泄漏
    }
}

Server server = ServerBuilder.forPort(9090)
        .executor(Executors.newFixedThreadPool(64))        // 默认是缓存线程池；业务阻塞多时自定义并隔离
        .maxInboundMessageSize(4 * 1024 * 1024)            // 默认 4MB，超出返回 RESOURCE_EXHAUSTED
        .addService(new OrderServiceImpl())
        .addService(ProtoReflectionService.newInstance())  // 反射服务：便于 grpcurl 调试（生产环境按需开启）
        .build().start();
```

### 3. 客户端

```java
ManagedChannel channel = ManagedChannelBuilder.forTarget("dns:///order-service.shop.svc:9090")   // 带 scheme 的目标
        .defaultLoadBalancingPolicy("round_robin")          // 客户端负载均衡（默认 pick_first）
        .keepAliveTime(30, TimeUnit.SECONDS).keepAliveTimeout(10, TimeUnit.SECONDS)
        .useTransportSecurity()                              // TLS；内网明文用 usePlaintext()（不推荐生产）
        .build();                                            // Channel 线程安全、可复用，进程内共享，不要每次调用新建！

OrderServiceGrpc.OrderServiceBlockingStub stub = OrderServiceGrpc.newBlockingStub(channel);

CreateOrderResponse resp = stub
        .withDeadlineAfter(500, TimeUnit.MILLISECONDS)       // 每次调用设置截止时间（重点！）
        .createOrder(CreateOrderRequest.newBuilder().setRequestId(uuid).setUserId(1).addItems(item).build());

// 异步/流式：用 newStub()（异步）或 newFutureStub()（Future）
OrderServiceGrpc.newStub(channel).watchOrder(req, new StreamObserver<OrderEvent>() {
    public void onNext(OrderEvent e) { /* 处理推送 */ }
    public void onError(Throwable t) { /* 处理失败，必要时重连并从断点订阅 */ }
    public void onCompleted() { }
});
```

**要点**：`ManagedChannel` 昂贵，**全局复用**，关闭时 `channel.shutdown().awaitTermination(...)`；Spring Boot 项目可用 **grpc-spring-boot-starter**（`@GrpcService`、`@GrpcClient`）简化配置，或通过 Spring Cloud 服务发现集成。

## 六、Deadline、取消与错误处理

### 1. Deadline（必须设置）

**Deadline 是绝对时间点，随调用链向下游传播**：A（总预算 1s）调用 B 时，B 看到的剩余时间已减去 A 已消耗的部分；一旦超时，客户端立即返回 `DEADLINE_EXCEEDED`，**并通过 RST_STREAM 取消**服务端的处理。

- **永远不要使用默认的“无限期”**：下游挂住时，调用方线程、连接、内存都会被拖死；
- 服务端应检查 `Context.current().isCancelled()` / `Deadline`，对耗时循环及时退出（见 [限流、熔断与降级：超时与级联故障](#/distributed/governance)）；
- 设置分层预算：入口总超时 > 各下游超时之和（含重试），避免“上游已放弃，下游仍在忙”。

### 2. 标准状态码（与 HTTP 状态码不同）

| 状态码 | 含义 | 是否可重试 |
| --- | --- | --- |
| `OK` | 成功 | — |
| `INVALID_ARGUMENT` | 参数非法 | 否 |
| `NOT_FOUND` / `ALREADY_EXISTS` | 资源不存在/已存在 | 否 |
| `PERMISSION_DENIED` / `UNAUTHENTICATED` | 无权限 / 未认证 | 否 |
| `RESOURCE_EXHAUSTED` | 限流/配额/消息过大 | 视情况（退避后可重试） |
| `FAILED_PRECONDITION` | 当前状态不满足（业务状态机） | 否 |
| `ABORTED` | 并发冲突（事务冲突） | 可重试（重新读取后） |
| `DEADLINE_EXCEEDED` | 超时 | **非幂等操作谨慎**（可能已执行） |
| `UNAVAILABLE` | 服务暂不可用/连接问题 | **可重试**（退避） |
| `INTERNAL` / `UNKNOWN` | 内部错误 | 通常否 |
| `CANCELLED` | 调用方取消 | — |

- 错误详情：用 **`google.rpc.Status` + `details`**（`ErrorInfo`、`BadRequest` 等）携带结构化错误，通过 Trailers 传回，避免把业务错误码塞进 description 字符串；
- 业务错误与系统错误区分：业务拒绝（库存不足）可作为**响应体里的 code** 或 `FAILED_PRECONDITION`，不要滥用 `INTERNAL`，否则监控与重试策略都会混乱。

## 七、拦截器与元数据

**Metadata** 相当于 HTTP 头（键值对，二进制值键以 `-bin` 结尾），用于传递认证令牌、`traceparent`、灰度标签、租户 ID。**拦截器**在客户端和服务端两侧统一处理横切关注点：

```java
// 服务端拦截器：校验令牌 + 把用户放入 Context 供业务代码读取
public class AuthInterceptor implements ServerInterceptor {
    static final Metadata.Key<String> AUTH = Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER);
    static final Context.Key<String> USER = Context.key("user");
    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        String token = headers.get(AUTH);
        String user = tokenService.verify(token);                       // 验证 JWT（见认证授权）
        if (user == null) {
            call.close(Status.UNAUTHENTICATED.withDescription("invalid token"), new Metadata());
            return new ServerCall.Listener<>() {};
        }
        return Contexts.interceptCall(Context.current().withValue(USER, user), call, headers, next);
    }
}
// 注册：ServerInterceptors.intercept(service, new AuthInterceptor(), new TracingInterceptor(), new MetricsInterceptor())
```

典型拦截器链：**鉴权 → 限流 → 链路追踪（OpenTelemetry 自动 instrument）→ 指标 → 日志（脱敏）→ 异常映射**。认证方案见 [认证授权](#/security/auth)，追踪与指标见 [链路追踪](#/infra/obs-trace)、[指标监控](#/infra/obs-metrics)。

## 八、负载均衡与连接管理

### 1. 为什么 gRPC 的 LB 特殊

HTTP/2 在**一个 TCP 连接上复用大量请求**，连接是长连接。传统 **L4 负载均衡（如 K8s ClusterIP Service、LVS、NLB）按“连接”分配**：客户端建立 1 个连接后，其后所有 RPC 都走这个连接 → **所有请求打到同一个 Pod**，新扩容的实例拿不到流量。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="gRPC 负载均衡三种方案：四层代理只在连接层面均衡导致流量倾斜；客户端负载均衡通过服务发现获得所有后端地址，对每个后端建立子连接并轮询分发请求；七层代理如 Envoy 或服务网格终止 HTTP/2 并在请求粒度分发到后端">
<rect class="b4" x="20" y="20" width="240" height="140" rx="12"/>
<text class="th" x="36" y="44">✗ L4 代理（按连接）</text>
<rect class="b1" x="36" y="62" width="70" height="36" rx="6"/>
<text class="ts" x="71" y="80" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b5" x="130" y="62" width="50" height="36" rx="6"/>
<text class="ts" x="155" y="80" text-anchor="middle" dominant-baseline="middle">L4</text>
<rect class="b3" x="200" y="46" width="48" height="26" rx="4"/>
<rect class="b" x="200" y="76" width="48" height="26" rx="4"/>
<rect class="b" x="200" y="106" width="48" height="26" rx="4"/>
<line class="l" x1="106" y1="80" x2="130" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="78" x2="200" y2="59" marker-end="url(#arr)"/>
<text class="ts" x="36" y="150" text-anchor="start">1 个长连接 → 全部请求同一后端</text>
<rect class="b2" x="280" y="20" width="240" height="140" rx="12"/>
<text class="th" x="296" y="44">✓ 客户端负载均衡</text>
<rect class="b1" x="296" y="62" width="80" height="60" rx="6"/>
<text class="ts" x="336" y="86" text-anchor="middle" dominant-baseline="middle">客户端</text>
<text class="ts" x="336" y="104" text-anchor="middle" dominant-baseline="middle">round_robin</text>
<rect class="b3" x="440" y="46" width="64" height="26" rx="4"/>
<rect class="b3" x="440" y="76" width="64" height="26" rx="4"/>
<rect class="b3" x="440" y="106" width="64" height="26" rx="4"/>
<line class="l" x1="376" y1="80" x2="440" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="376" y1="92" x2="440" y2="89" marker-end="url(#arr)"/>
<line class="l" x1="376" y1="104" x2="440" y2="119" marker-end="url(#arr)"/>
<text class="ts" x="296" y="150" text-anchor="start">服务发现返回全部地址，各连一条</text>
<rect class="b3" x="540" y="20" width="240" height="140" rx="12"/>
<text class="th" x="556" y="44">✓ L7 代理 / Service Mesh</text>
<rect class="b1" x="556" y="62" width="64" height="36" rx="6"/>
<text class="ts" x="588" y="80" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b5" x="636" y="62" width="62" height="36" rx="6"/>
<text class="ts" x="667" y="80" text-anchor="middle" dominant-baseline="middle">Envoy</text>
<rect class="b3" x="716" y="46" width="48" height="26" rx="4"/>
<rect class="b3" x="716" y="76" width="48" height="26" rx="4"/>
<rect class="b3" x="716" y="106" width="48" height="26" rx="4"/>
<line class="l" x1="620" y1="80" x2="636" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="698" y1="78" x2="716" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="698" y1="82" x2="716" y2="89" marker-end="url(#arr)"/>
<line class="l" x1="698" y1="86" x2="716" y2="119" marker-end="url(#arr)"/>
<text class="ts" x="556" y="150" text-anchor="start">按请求粒度分发，可做灰度/重试</text>
<rect class="bg" x="20" y="180" width="760" height="140" rx="10"/>
<text class="th" x="36" y="204">方案与要点</text>
<text class="ts" x="36" y="226">• K8s 中用 Headless Service（clusterIP: None）让 DNS 返回所有 Pod IP，配合客户端 round_robin；Pod 变化靠 DNS 刷新/连接重建</text>
<text class="ts" x="36" y="246">• 或接入注册中心/xDS（Nacos、Consul、Istio xDS、gRPC 的 xDS 支持）做动态服务发现</text>
<text class="ts" x="36" y="266">• 服务端设置 MAX_CONNECTION_AGE（如 5~30 分钟，加抖动）+ GRACE，定期让连接“重新平衡”，缓解新实例分不到流量/缩容摘除问题</text>
<text class="ts" x="36" y="286">• 流式长连接要考虑粘性：流不会随负载变化迁移；发布时要优雅关闭让客户端重连</text>
<text class="ts" x="36" y="306">• 常见组合：Istio/Envoy 做 L7；或 Nginx（支持 grpc_pass，但配置与超时需专门调整，见 Nginx 笔记）</text>
</svg>
<figcaption>图 4：gRPC 负载均衡：别用纯 L4 代理</figcaption>
</figure>

### 2. 连接与保活

- **Keepalive**：客户端 `keepAliveTime` 定期发 HTTP/2 PING 检测死连接（穿透 NAT/负载均衡的空闲超时）；服务端有 `permitKeepAliveTime` 限制，客户端过于频繁会被服务端以 `GOAWAY too_many_pings` 断开——**两端配置要匹配**；
- **`GOAWAY`** 是优雅关闭信号：服务端发布/缩容时让客户端停止在该连接上发起新流，并重建连接；
- **并发流上限**：HTTP/2 `MAX_CONCURRENT_STREAMS`（默认 100 级别，实现/代理相关）；单连接并发过高会排队，高并发场景可用**多个连接（channel pool）**。

## 九、重试、对冲与健康检查

### 1. 重试与服务配置

gRPC 支持通过 **Service Config**（JSON）声明重试策略，客户端透明执行：

```json
{ "methodConfig": [{
    "name": [ { "service": "shop.order.v1.OrderService", "method": "GetOrder" } ],
    "timeout": "0.5s",
    "retryPolicy": {
      "maxAttempts": 3, "initialBackoff": "0.05s", "maxBackoff": "0.5s", "backoffMultiplier": 2,
      "retryableStatusCodes": [ "UNAVAILABLE" ] }
}]}
```

**只对幂等方法重试**；非幂等的（创建订单、扣款）要靠**幂等键 `request_id`**，否则重试会重复执行；设置**重试预算**（retry throttling）避免重试风暴放大故障；重试总耗时不得超过 Deadline。

### 2. 健康检查

gRPC 有标准的 **Health Checking Protocol**（`grpc.health.v1.Health`）：K8s（1.24+ 原生 `grpc` 探针）或 LB 可据此判断实例是否可服务；Java 用 `HealthStatusManager`，**依赖异常时置为 `NOT_SERVING`**（注意避免级联摘除，见 [Kubernetes 探针](#/infra/k8s)）。

### 3. 流控与背压

HTTP/2 自带**流量控制窗口**；流式场景下发送方要用 `isReady()` / `onReadyHandler` 判断对端是否能接收，避免无限缓冲导致内存暴涨（`ServerCallStreamObserver.setOnReadyHandler`）。

## 十、安全

| 方面 | 做法 |
| --- | --- |
| **传输加密** | TLS（`useTransportSecurity`/Netty SslContext）；服务间 **mTLS**（双向认证），Service Mesh 可自动签发与轮换证书（见 [加密、签名与 mTLS](#/security/crypto)） |
| **认证** | 令牌放 Metadata（`authorization: Bearer ...`），拦截器校验；`CallCredentials` 在客户端统一附加 |
| **授权** | 方法级权限、租户隔离，在服务端拦截器/业务层校验 |
| **输入限制** | 限制消息大小（`maxInboundMessageSize`）、流消息数量与时长，防资源耗尽 |
| **反射服务** | 生产环境谨慎暴露（泄露接口结构），仅内网/调试开启 |

## 十一、与 REST、Dubbo 对比与选型

| | REST/JSON | **gRPC** | Dubbo（Triple 协议） |
| --- | --- | --- | --- |
| 序列化 | JSON 文本 | **Protobuf 二进制** | Triple 基于 HTTP/2 + Protobuf，兼容 gRPC；也支持 Hessian2 等 |
| 契约 | OpenAPI（可选） | **.proto（强制）** | IDL（Protobuf）或 Java 接口 |
| 传输 | HTTP/1.1 或 2 | **HTTP/2** | 自有 Dubbo 协议 / Triple(HTTP/2) |
| 流式 | 弱（SSE/WebSocket 另行） | **原生四种** | Triple 支持流 |
| 多语言 | 通用 | **官方多语言** | Java 为主，其他语言在增长 |
| 服务治理 | 需网关/框架 | 基础能力 + 依赖 LB/Mesh/拦截器 | **内建丰富**（注册发现、路由、容错、限流，见 [Dubbo 治理](#/mw/dubbo-practice)） |
| 浏览器 | **直接** | 需 grpc-web / 网关转换 | 需网关 |
| 可读性/调试 | **好** | 需工具（grpcurl） | 需工具 |
| 适用 | 对外 API、前后端 | **内部多语言微服务、流式、高性能** | Java 生态内部微服务（尤其已有 Dubbo 体系） |

**选型建议**：

- **对外开放 API / 前端调用 / 第三方集成** → REST（可用 gRPC-Gateway 或 Envoy 的 gRPC-JSON 转码，**一份 proto 同时提供 gRPC 与 REST**）；
- **内部微服务，多语言，性能与强契约优先** → gRPC；
- **纯 Java 且重度依赖服务治理能力** → Dubbo，或 Spring Cloud + gRPC；
- **IoT 终端、弱网小包** → 更轻量的 MQTT/CoAP（见 [MQTT](#/iot/mqtt)），gRPC 的 HTTP/2 头和连接成本对极低功耗设备偏重。

## 十二、常见坑

| 坑 | 对策 |
| --- | --- |
| 没设 Deadline，下游卡死拖垮调用方 | 每个调用设置超时，并沿链路传播；服务端响应取消 |
| 在 L4 LB 后所有流量打到同一实例 | 客户端 LB（headless + round_robin）或 L7 代理；服务端 `MAX_CONNECTION_AGE` |
| 每次调用 new 一个 Channel | 全局复用 Channel，进程退出时关闭 |
| 滥用 `INTERNAL`/`UNKNOWN`，重试与告警失灵 | 使用准确状态码，结构化错误详情 |
| 对非幂等接口开启重试，重复扣款 | 幂等键 + 仅幂等方法重试 + 重试预算 |
| 消息超过 4MB 默认限制 | 调整限制或改流式分块；避免超大消息 |
| Keepalive 参数不一致被 `GOAWAY too_many_pings` 断开 | 两端协调配置，不要过于频繁 |
| 阻塞 IO 占用 gRPC 默认执行线程，吞吐骤降 | 自定义业务线程池隔离；使用异步 stub |
| 修改/复用字段编号，数据错乱 | `reserved` + `buf breaking` 检查 |
| proto3 标量无法区分“未设置”与默认值 | `optional`、包装类型、FieldMask |
| 流式调用不处理取消，资源泄漏 | `setOnCancelHandler`、`isCancelled` 检查、finally 清理 |
| 打印整个请求日志泄露敏感信息 | 拦截器统一脱敏，限制 payload 日志 |
| 浏览器直接调用失败 | grpc-web + Envoy，或提供 REST 网关 |
| Protobuf 对象当作可变领域模型到处传 | 在边界转换成领域对象，避免耦合传输模型（防腐层思想，见 [DDD](#/design/ddd-strategic)） |

## 面试追问

> [!QUESTION] gRPC 相比 REST 有什么优势？有什么缺点？
> 优势是 Protobuf 二进制体积小解析快，HTTP/2 多路复用，强类型契约加代码生成，原生支持四种流式调用，并内建 Deadline、取消、元数据和标准状态码，适合多语言内部微服务。缺点是可读性和调试差、浏览器不能直接调用需要 grpc-web、对 L4 负载均衡不友好、对外开放不如 REST 通用。

> [!QUESTION] Protobuf 为什么高效？怎么保证向前向后兼容？
> 字段用编号加类型的 tag 标识，字段名不进数据，整数用 Varint 变长编码，默认值不编码，所以体积小解析快。兼容靠规则：只能新增字段用新编号，删除字段要 reserved 编号和名字且永不复用，不能修改编号或类型，旧代码遇到未知字段会忽略或保留。可在 CI 用 buf breaking 检查。

> [!QUESTION] gRPC 的四种调用方式及适用场景？
> 一元调用是请求响应；服务端流是一个请求多个响应，适合订阅推送和大结果分批；客户端流是多个请求一个响应，适合大文件分块上传和批量上报；双向流两端独立读写，适合聊天和实时协作。流式要注意背压、取消、保活和资源释放。

> [!QUESTION] 为什么 gRPC 在 Kubernetes 里负载不均衡？怎么解决？
> HTTP/2 在单个长连接上复用请求，四层负载均衡如 ClusterIP 只在建立连接时选择后端，连接建立后所有请求都走同一个 Pod。解决方案是用 Headless Service 配合客户端 round_robin 的客户端负载均衡，或使用 Envoy、Istio 等七层代理按请求分发，并在服务端设置最大连接存活时间让连接定期重新平衡。

> [!QUESTION] Deadline 为什么重要？怎么传播？
> 没有 Deadline 时下游卡死会让调用方的线程、连接长期被占用并引发级联故障。Deadline 是绝对时间点，随调用链向下游传播，下游看到的是剩余时间，超时后客户端返回 DEADLINE_EXCEEDED 并取消服务端处理，服务端应响应取消及时释放资源，同时要为重试预留预算。

> [!QUESTION] gRPC 的重试要注意什么？
> 只对幂等方法和 UNAVAILABLE 等可重试状态码重试，使用指数退避和重试预算防止重试风暴，总耗时不能超过 Deadline；非幂等操作用请求幂等键保证重复执行安全，DEADLINE_EXCEEDED 可能意味着服务端已执行，要谨慎。

> [!QUESTION] gRPC、Dubbo、REST 怎么选型？
> 对外开放和浏览器调用用 REST，必要时用网关把 gRPC 转 REST；内部多语言微服务、强契约、流式与高性能用 gRPC；纯 Java 且依赖丰富服务治理的体系用 Dubbo，Triple 协议兼容 gRPC。需要同时提供多种形态时，用同一份 proto 生成并通过网关转码。
