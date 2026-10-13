---
level: 进阶
tags: [Java, MQTT, Eclipse Paho, HiveMQ Client, Spring Integration, Netty, 设备接入, 幂等]
summary: 用 Java 做 MQTT 设备接入的完整实践：Paho 客户端的可靠连接与重连、Spring Boot 集成与线程模型、后端消费与幂等、用 Netty 的 MQTT 编解码做自定义接入网关，以及测试与压测方法。
---

# Java 接入：Paho、Spring 与 Netty

> [!ABSTRACT] 核心要点
> - Java 常用客户端：**Eclipse Paho**（经典、稳定）、**HiveMQ MQTT Client**（响应式/异步、支持 5.0、API 现代）。Spring 项目可用 **Spring Integration MQTT**（基于 Paho）。
> - 客户端三件事：**可靠连接**（自动重连 + 重连后**重新订阅**）、**回调线程不阻塞**（耗时操作转线程池）、**幂等处理**（QoS 1 会重复）。
> - **ClientID 唯一**；后端多实例消费同一主题要用**共享订阅**（`$share/组/主题`），否则每个实例各收一份。
> - 后端不要“直连海量设备主题后同步处理”：**Broker → Kafka → 消费服务**更稳；需要定制协议或接入非 MQTT 设备时，用 **Netty** 自建接入网关（`netty-codec-mqtt`、自定义二进制协议）。
> - 上线前必须做**连接数、吞吐、重连风暴、断网恢复**测试。

## 典型接入架构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Java 后端接入 IoT 的典型架构：设备经 Broker 到 Kafka，再由消费服务处理，并通过 API 下发指令">
<rect class="b1" x="20" y="20" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="45" text-anchor="middle" dominant-baseline="middle">MQTT 设备</text>
<rect class="b" x="20" y="100" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="125" text-anchor="middle" dominant-baseline="middle">私有 TCP 设备</text>
<rect class="b3" x="200" y="20" width="130" height="50" rx="8"/>
<text class="tb" x="265" y="45" text-anchor="middle" dominant-baseline="middle">EMQX 集群</text>
<rect class="b5" x="200" y="100" width="130" height="50" rx="8"/>
<text class="tb" x="265" y="118" text-anchor="middle" dominant-baseline="middle">Netty 接入网关</text>
<text class="ts" x="265" y="136" text-anchor="middle">协议转换</text>
<line class="l" x1="140" y1="45" x2="200" y2="45" marker-end="url(#arr)"/>
<line class="l" x1="140" y1="125" x2="200" y2="125" marker-end="url(#arr)"/>
<line class="l" x1="265" y1="70" x2="265" y2="100"/>
<text class="ts" x="276" y="90" text-anchor="start">网关作为 MQTT 客户端</text>
<rect class="b4" x="390" y="60" width="110" height="50" rx="8"/>
<text class="tb" x="445" y="80" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<text class="ts" x="445" y="98" text-anchor="middle">缓冲 · 解耦</text>
<line class="la" x1="330" y1="45" x2="400" y2="68" marker-end="url(#arr-a)"/>
<line class="la" x1="330" y1="125" x2="400" y2="100" marker-end="url(#arr-a)"/>
<text class="ts" x="368" y="46" text-anchor="middle">规则引擎</text>
<rect class="b2" x="560" y="20" width="180" height="60" rx="8"/>
<text class="tb" x="650" y="42" text-anchor="middle" dominant-baseline="middle">数据处理服务</text>
<text class="ts" x="650" y="62" text-anchor="middle">解析 · 清洗 · 去重 · 告警</text>
<rect class="b2" x="560" y="100" width="180" height="50" rx="8"/>
<text class="tb" x="650" y="125" text-anchor="middle" dominant-baseline="middle">设备管理服务</text>
<line class="l" x1="500" y1="85" x2="560" y2="50" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="90" x2="560" y2="125" marker-end="url(#arr)"/>
<rect class="b5" x="560" y="190" width="180" height="50" rx="8"/>
<text class="tb" x="650" y="215" text-anchor="middle" dominant-baseline="middle">时序库 / 业务库</text>
<line class="l" x1="650" y1="80" x2="650" y2="190" marker-end="url(#arr)"/>
<rect class="b" x="200" y="230" width="260" height="60" rx="8"/>
<text class="tb" x="330" y="252" text-anchor="middle" dominant-baseline="middle">业务 API（Spring Boot）</text>
<text class="ts" x="330" y="272" text-anchor="middle">下发指令：REST → MQTT publish</text>
<line class="la" x1="330" y1="230" x2="265" y2="70" marker-end="url(#arr-a)"/>
<text class="ts" x="490" y="290" text-anchor="start">上行：设备→Broker→Kafka→服务→存储</text>
<text class="ts" x="490" y="308" text-anchor="start">下行：API→Broker→设备（msgId）</text>
</svg>
<figcaption>图 1：设备上行经 Kafka 缓冲，下行通过 Broker 发布</figcaption>
</figure>

## Eclipse Paho 客户端

### 依赖

```xml
<dependency>
  <groupId>org.eclipse.paho</groupId>
  <artifactId>org.eclipse.paho.client.mqttv3</artifactId>
  <version>1.2.5</version>
</dependency>
<!-- MQTT 5.0 使用 org.eclipse.paho.mqttv5.client -->
```

### 可靠连接：自动重连与重新订阅

```java
public class MqttService implements MqttCallbackExtended {

    private final MqttAsyncClient client;
    private final ExecutorService bizPool = new ThreadPoolExecutor(8, 16, 60, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(10_000), new ThreadPoolExecutor.CallerRunsPolicy());

    public MqttService(String broker, String clientId, String user, String pwd) throws MqttException {
        client = new MqttAsyncClient(broker, clientId, new MemoryPersistence());   // 3.x 客户端的未确认消息持久化
        client.setCallback(this);

        MqttConnectOptions opt = new MqttConnectOptions();
        opt.setUserName(user);
        opt.setPassword(pwd.toCharArray());
        opt.setCleanSession(false);                  // 持久会话：离线期间 QoS 1 消息重连后补发
        opt.setKeepAliveInterval(60);
        opt.setConnectionTimeout(10);
        opt.setAutomaticReconnect(true);             // 内置指数退避（1s → 最大 128s）自动重连
        opt.setMaxInflight(100);                     // 未确认消息窗口
        opt.setWill("acme/" + clientId + "/up/status", "offline".getBytes(UTF_8), 1, true);   // 遗嘱
        client.connect(opt).waitForCompletion(15_000);
    }

    @Override public void connectComplete(boolean reconnect, String serverURI) {
        // 每次连接成功（含自动重连）都会回调；使用 Clean Session=true 或会话过期后必须重新订阅
        try {
            client.subscribe("$share/ingest/acme/+/up/telemetry", 1);               // 共享订阅，后端水平扩展
            client.publish("acme/" + clientId + "/up/status", "online".getBytes(UTF_8), 1, true);
        } catch (MqttException e) { log.error("订阅失败", e); }
    }

    @Override public void connectionLost(Throwable cause) { log.warn("连接断开，等待自动重连", cause); }

    @Override public void messageArrived(String topic, MqttMessage msg) {
        // ⚠ 此方法运行在 Paho 的回调线程中：不要阻塞，否则会拖慢整个客户端并导致保活超时
        byte[] payload = msg.getPayload();
        bizPool.execute(() -> handle(topic, payload, msg.getQos(), msg.isDuplicate()));
    }

    @Override public void deliveryComplete(IMqttDeliveryToken token) { /* 发布的 QoS≥1 消息已被 Broker 确认 */ }
}
```

注意点：

- **`MqttClient`（同步）** 与 **`MqttAsyncClient`（异步）**：同步版内部也靠异步实现，高吞吐场景优先异步；
- `setAutomaticReconnect(true)` 重连后**不会自动重新订阅**（除非会话仍保留）：在 `connectComplete` 里统一订阅，既处理首次也处理重连；
- 回调线程中**不能再同步调用阻塞型 API**（如 `client.publish(...).waitForCompletion()`）否则死锁/超时；
- `MemoryPersistence` 重启后未确认消息丢失；需要**应用重启后仍不丢发布消息**，使用 `MqttDefaultFilePersistence` 或在应用层做**发件箱（outbox）**；
- 发布大量消息时观察 `getPendingDeliveryTokens()` 与飞行窗口，**避免无限积压在客户端内存**；
- 5.0 客户端（`mqttv5`）支持共享订阅、用户属性、原因码、会话过期等，新项目建议直接上 5.0。

### 发布指令：带 msgId 与应答

```java
public CompletableFuture<CmdReply> sendCommand(String deviceId, String method, Map<String, Object> params) {
    String msgId = UUID.randomUUID().toString();
    var future = new CompletableFuture<CmdReply>().orTimeout(10, TimeUnit.SECONDS);   // 超时视为失败
    pending.put(msgId, future);                                                       // msgId → 等待应答的 Future
    future.whenComplete((r, e) -> pending.remove(msgId));

    byte[] body = json.writeValueAsBytes(Map.of("msgId", msgId, "method", method, "params", params, "ts", System.currentTimeMillis()));
    mqtt.publish("acme/" + deviceId + "/down/cmd", body, 1, false);
    return future;
}

// 订阅 acme/+/up/cmd-reply 收到应答：
void onReply(String json) { var r = parse(json); var f = pending.get(r.msgId()); if (f != null) f.complete(r); }
```

多实例部署时，**应答可能落在另一个实例**（共享订阅会把应答随机分给某实例）：解法是**每个实例订阅自己的应答主题**（`acme/+/up/cmd-reply/{instanceId}`，下发时在消息里带上 replyTo），或把 pending 状态放 Redis 并通过 pub/sub 通知（见 [Redis 高频场景实战](#/redis/practice)），或使用 MQTT 5.0 的 `Response Topic`。

## Spring Boot 集成

使用 **Spring Integration MQTT** 管理连接、订阅与发布：

```xml
<dependency>
  <groupId>org.springframework.integration</groupId>
  <artifactId>spring-integration-mqtt</artifactId>
</dependency>
```

```java
@Configuration
public class MqttConfig {

    @Bean
    public MqttPahoClientFactory mqttClientFactory(MqttProps p) {
        var opt = new MqttConnectOptions();
        opt.setServerURIs(new String[]{p.getUrl()});
        opt.setUserName(p.getUser()); opt.setPassword(p.getPassword().toCharArray());
        opt.setCleanSession(false); opt.setAutomaticReconnect(true); opt.setKeepAliveInterval(60);
        var f = new DefaultMqttPahoClientFactory();
        f.setConnectionOptions(opt);
        return f;
    }

    // ---------- 入站：订阅 → 消息通道 ----------
    @Bean public MessageChannel mqttInputChannel() { return new ExecutorChannel(Executors.newFixedThreadPool(8)); }  // 异步，脱离 Paho 回调线程

    @Bean
    public MqttPahoMessageDrivenChannelAdapter inbound(MqttPahoClientFactory f, MqttProps p) {
        var a = new MqttPahoMessageDrivenChannelAdapter(p.getClientId() + "-sub", f, "$share/ingest/acme/+/up/#");
        a.setCompletionTimeout(5000);
        a.setConverter(new DefaultPahoMessageConverter());
        a.setQos(1);
        a.setOutputChannel(mqttInputChannel());
        return a;
    }

    @ServiceActivator(inputChannel = "mqttInputChannel")
    public void handle(Message<?> msg) {
        String topic = (String) msg.getHeaders().get(MqttHeaders.RECEIVED_TOPIC);
        telemetryService.process(topic, (String) msg.getPayload());     // 必须幂等
    }

    // ---------- 出站：发布 ----------
    @Bean
    @ServiceActivator(inputChannel = "mqttOutChannel")
    public MessageHandler outbound(MqttPahoClientFactory f, MqttProps p) {
        var h = new MqttPahoMessageHandler(p.getClientId() + "-pub", f);
        h.setAsync(true);                  // 异步发布，不阻塞业务线程
        h.setDefaultQos(1);
        return h;
    }
}

@MessagingGateway(defaultRequestChannel = "mqttOutChannel")
public interface MqttGateway {
    void send(@Header(MqttHeaders.TOPIC) String topic, @Header(MqttHeaders.QOS) int qos, String payload);
}
```

要点：

- **订阅与发布使用不同的 ClientID**，且同一 ClientID 不能在两个连接中共用（否则互相踢）；
- 多实例部署时 ClientID 要带实例标识（如 Pod 名/随机串）并且**共享订阅组名一致**；
- `MqttPahoMessageDrivenChannelAdapter` 默认在 Paho 回调线程里把消息投递给通道，**用 `ExecutorChannel` 异步化**，避免阻塞；
- 对更现代的响应式/MQTT 5.0 需求，评估 **HiveMQ MQTT Client**（`Mqtt5AsyncClient`/`Mqtt5RxClient`，内置背压与重连）。

## 消费端的可靠性与幂等

QoS 1 + 自动重试 → **消息会重复**；多实例/重连/再均衡也会重复，处理链路必须幂等：

| 手段 | 做法 |
| --- | --- |
| 消息唯一键 | 设备在负载中带 `deviceId + 序列号/时间戳`，服务端 `INSERT ... ON CONFLICT DO NOTHING` / 唯一索引 / Redis `SETNX` 去重（带 TTL） |
| 乱序/过期 | 以**设备时间戳**与**服务端版本号**为准，旧数据不覆盖新状态（`UPDATE ... WHERE ts < ?`） |
| 状态类数据 | “最后写入为准”（设备影子、当前值）；事件类数据（告警）按事件 ID 去重 |
| 先持久后确认 | 使用手动 ACK（Paho 5/HiveMQ 支持手动确认），处理成功才确认，避免“确认了但处理失败导致丢失” |
| 背压 | 消费慢时降低接收速率（Receive Maximum、`maxInflight`），或把消息先落 Kafka 再慢慢处理 |

```sql
-- 遥测去重入库（PostgreSQL / TimescaleDB 示例）
INSERT INTO telemetry (device_id, ts, metric, value)
VALUES (?, ?, ?, ?)
ON CONFLICT (device_id, ts, metric) DO NOTHING;
```

时序存储见 [IoT 平台架构与设备管理](#/iot/platform) 与 [复制、高可用与实战](#/pg/ops)。

## 用 Netty 自建 MQTT/私有协议网关

场景：① 非 MQTT 的**私有 TCP 协议设备**（Modbus 网关、定制二进制协议）；② 需要**定制 Broker 能力**；③ 协议转换（私有协议 ↔ MQTT/Kafka）。

### Netty 内置的 MQTT 编解码

```xml
<dependency>
  <groupId>io.netty</groupId>
  <artifactId>netty-codec-mqtt</artifactId>
</dependency>
```

```java
b.childHandler(new ChannelInitializer<SocketChannel>() {
    @Override protected void initChannel(SocketChannel ch) {
        ChannelPipeline p = ch.pipeline();
        p.addLast("idle", new IdleStateHandler(90, 0, 0));          // Keep Alive 的 1.5 倍
        p.addLast("decoder", new MqttDecoder(256 * 1024));          // 最大报文长度，防止恶意大包
        p.addLast("encoder", MqttEncoder.INSTANCE);
        p.addLast("handler", new MqttServerHandler());
    }
});

public class MqttServerHandler extends SimpleChannelInboundHandler<MqttMessage> {
    @Override protected void channelRead0(ChannelHandlerContext ctx, MqttMessage msg) {
        switch (msg.fixedHeader().messageType()) {
            case CONNECT -> onConnect(ctx, (MqttConnectMessage) msg);          // 认证、绑定会话、回 CONNACK
            case PUBLISH -> onPublish(ctx, (MqttPublishMessage) msg);          // QoS 1 回 PUBACK
            case SUBSCRIBE -> onSubscribe(ctx, (MqttSubscribeMessage) msg);    // 回 SUBACK
            case PINGREQ -> ctx.writeAndFlush(new MqttMessage(new MqttFixedHeader(PINGRESP, false, AT_MOST_ONCE, false, 0)));
            case DISCONNECT -> ctx.close();
            default -> {}
        }
    }
    @Override public void userEventTriggered(ChannelHandlerContext ctx, Object evt) {
        if (evt instanceof IdleStateEvent) ctx.close();                        // 保活超时 → 断开（并触发遗嘱）
    }
}
```

要点：

- `MqttDecoder` 已基于长度字段处理**粘包拆包**；`MqttPublishMessage` 的 `payload()` 是引用计数的 `ByteBuf`，**读取后注意 release/retain**（`SimpleChannelInboundHandler` 会自动 release，如需异步处理必须 `retain()` 或先拷贝成 byte[]）；
- 自建 Broker 要实现：**会话管理、订阅树（主题 Trie）、QoS 1/2 状态机、保留消息、遗嘱、保活、离线消息、集群路由、认证授权**——工作量巨大，**除非有强定制需求，不要自研 Broker**，直接用 EMQX；
- 更实用的场景是**接入网关**：用 Netty 接私有协议设备，转换后以 MQTT 客户端身份或直接写 Kafka。

### 私有协议接入网关要点

结合 [Netty 实战：编解码、内存与调优](#/infra/netty-practice)：

| 环节 | 做法 |
| --- | --- |
| 编解码 | `LengthFieldBasedFrameDecoder` + 自定义 Decoder（魔数/版本/类型/序列号/长度/校验） |
| 连接管理 | `Map<deviceId, Channel>` 登记在线设备；**同一设备新连接顶掉旧连接**；`channelInactive` 清理 |
| 心跳 | `IdleStateHandler`；设备心跳同时更新在线状态（Redis/内存） |
| 业务隔离 | 收到数据后**投递业务线程池/Kafka**，不在 EventLoop 做阻塞操作 |
| 下行指令 | 通过设备 ID 找到所在网关实例（Redis 记录 `deviceId → gatewayNode`），RPC/MQ 转发到该实例再 `channel.writeAndFlush` |
| 水平扩展 | 多网关实例 + 四层 LB；**设备路由表**放 Redis；连接数/带宽监控 |
| 背压 | `isWritable()` 控制下行；按设备限速 |

## 测试与压测

| 目标 | 工具与方法 |
| --- | --- |
| 功能调试 | **MQTTX**（图形客户端）、`mosquitto_pub/sub` |
| 压测连接与吞吐 | **emqtt-bench**、JMeter MQTT 插件；模拟 N 万设备连接、发布速率、订阅数 |
| 单元/集成测试 | **Testcontainers 启动 EMQX/Mosquitto**（见 [单元测试：JUnit 5 与 Mockito](#/java/eng/testing)），验证订阅、重连、幂等 |
| 异常场景 | 断网重连、Broker 重启、重复消息、乱序、超大消息、非法 payload、ClientID 冲突 |
| 观测 | 客户端：连接状态、重连次数、发布/接收速率、未确认消息数；Broker：见 [Broker 架构与集群（EMQX）](#/iot/broker) |

```java
@Testcontainers
class MqttIT {
    @Container static GenericContainer<?> emqx = new GenericContainer<>("emqx/emqx:5.7").withExposedPorts(1883);
    @Test void shouldReceiveAfterReconnect() { /* 连接 → 订阅 → 断开 → 离线发布 → 重连 → 断言收到离线消息 */ }
}
```

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| 客户端频繁断开重连 | ClientID 冲突；回调线程阻塞导致保活失败；网络 NAT 超时；Keep Alive 设置不当 |
| 重连后收不到消息 | 未在 `connectComplete` 里重新订阅；Clean Session=true 导致会话丢失 |
| 内存持续增长 | 发布速度远大于网络/Broker 处理速度，客户端未确认消息堆积；加背压、限速 |
| 多实例重复处理 | 没有使用共享订阅；或没有做幂等 |
| 收不到下行指令 | 设备端未订阅/ACL 拒绝/会话过期；服务端用了 QoS 0 |
| 异常断开后状态不一致 | 遗嘱触发时机与重连竞争；用连接序号/时间戳判断最新状态 |

## 相关阅读

- [MQTT 协议详解](#/iot/mqtt)：MQTT 协议
- [Broker 架构与集群（EMQX）](#/iot/broker)：Broker 集群
- [InfluxDB 实战：基数、降采样、Java 写入与选型](#/db/influx-practice)：遥测数据写入时序库
- [TCP 深入与 UDP/QUIC：重传、保活、RST 与内核调优](#/cs/net-tcp)：长连接保活与重连
- [MQTT 报文详解：从字节看协议](#/iot/mqtt-wire)：解码器实现与报文校验清单
- [弱网、可靠性、安全与排障：MQTT 工程实践](#/iot/mqtt-practice)：回调线程、重连与指令可靠性
- [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5)：Paho MQTT v5 客户端相关特性

## 面试追问

> [!QUESTION] Java 中使用 Paho 要注意哪些坑？
> 回调线程中不能做阻塞操作，应转交线程池；`connectComplete` 中统一订阅以覆盖重连；ClientID 唯一；持久会话与 QoS≥1 保证离线消息；未确认消息堆积要做背压；多实例消费使用共享订阅并保证幂等。

> [!QUESTION] 如何保证设备指令下发的可靠性？
> 指令携带唯一 msgId，使用 QoS 1 与持久会话；设备按 msgId 去重并回复应答；服务端维护待应答表并设置超时重发与告警；对设备离线的指令设置有效期，过期丢弃或转为待办。

> [!QUESTION] 为什么不建议自研 MQTT Broker？什么时候需要用 Netty 自建网关？
> Broker 要实现会话、订阅树、QoS 状态机、保留/遗嘱、集群路由与安全，成本极高，成熟方案（EMQX 等）更稳。当要接入私有协议设备或做协议转换时，用 Netty 自建网关才合适。

> [!QUESTION] 多个后端实例如何消费同一批设备的上行数据？
> 使用 MQTT 5.0 共享订阅让组内实例分摊消息，或在 Broker 规则中转发到 Kafka 用消费组消费；两者都要保证处理幂等，因为 QoS 1 和再均衡会产生重复。

> [!QUESTION] 回调线程阻塞会有什么后果？
> Paho 的回调线程同时负责处理网络事件与保活，阻塞会导致无法及时收发 PING，Broker 判定超时断开，并引发重连与重复投递；耗时操作应放入有界线程池，并设置合理拒绝策略。
