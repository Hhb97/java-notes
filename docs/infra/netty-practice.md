---
level: 深入
tags: [Netty, ByteBuf, 内存池, 粘包拆包, 编解码, 心跳, 写背压, 调优]
summary: Netty 工程实践：ByteBuf 的结构与池化内存管理、引用计数与泄漏排查、粘包拆包与自定义协议编解码、心跳与断线重连、写缓冲背压，以及系统参数与性能调优清单。
---

# Netty 实战：编解码、内存与调优

> [!ABSTRACT] 核心要点
> - **ByteBuf** 有独立的读写指针（`readerIndex` / `writerIndex`），默认使用**池化的堆外内存**；必须遵守**引用计数**规则，漏 `release` 就是堆外内存泄漏。
> - TCP 是字节流，**粘包/拆包必须由应用层协议解决**：定长、分隔符、长度字段（`LengthFieldBasedFrameDecoder`）；生产协议几乎都用**长度字段**。
> - 自定义协议要包含：**魔数、版本、类型、序列号（请求-响应匹配）、长度、负载、（可选）校验**。
> - **心跳 + 空闲检测**（`IdleStateHandler`）和**指数退避+抖动的重连**是长连接服务的标配；断线重连必须加抖动，防止**重连风暴**。
> - **写背压**：对端消费慢会导致 `ChannelOutboundBuffer` 无限堆积直至 OOM，必须依据 `channel.isWritable()` 和 `WriteBufferWaterMark` 做流控。

## ByteBuf

### 结构

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="ByteBuf 的 readerIndex、writerIndex、capacity 划分出可丢弃、可读、可写三个区域">
<rect class="b" x="40" y="60" width="200" height="56" rx="0"/>
<text class="tb" x="140" y="82" text-anchor="middle" dominant-baseline="middle">可丢弃字节</text>
<text class="ts" x="140" y="100" text-anchor="middle">discardable（已读）</text>
<rect class="b2" x="240" y="60" width="260" height="56" rx="0"/>
<text class="tb" x="370" y="82" text-anchor="middle" dominant-baseline="middle">可读字节 readable</text>
<text class="ts" x="370" y="100" text-anchor="middle">writerIndex - readerIndex</text>
<rect class="b3" x="500" y="60" width="200" height="56" rx="0"/>
<text class="tb" x="600" y="82" text-anchor="middle" dominant-baseline="middle">可写字节 writable</text>
<text class="ts" x="600" y="100" text-anchor="middle">capacity - writerIndex</text>
<line class="l" x1="40" y1="140" x2="40" y2="124"/>
<line class="l" x1="240" y1="140" x2="240" y2="124"/>
<line class="l" x1="500" y1="140" x2="500" y2="124"/>
<line class="l" x1="700" y1="140" x2="700" y2="124"/>
<text class="tm" x="40" y="160" text-anchor="middle">0</text>
<text class="tm" x="240" y="160" text-anchor="middle">readerIndex</text>
<text class="tm" x="500" y="160" text-anchor="middle">writerIndex</text>
<text class="tm" x="700" y="160" text-anchor="middle">capacity</text>
<text class="ts" x="370" y="206" text-anchor="middle">read 系方法移动 readerIndex，write 系方法移动 writerIndex；无需像 NIO ByteBuffer 那样 flip()</text>
<text class="ts" x="370" y="228" text-anchor="middle">maxCapacity 限制自动扩容的上限；discardReadBytes() 把可读区搬到起点，释放前部空间</text>
</svg>
<figcaption>图 1：ByteBuf 的三段式结构与双指针</figcaption>
</figure>

对比 JDK `ByteBuffer`：只有一个 `position`，读写切换要 `flip()/clear()`；容量固定；Netty 的 ByteBuf **读写指针分离、可动态扩容、支持引用计数和池化、支持复合缓冲**。

### 类型

| 维度 | 选项 | 说明 |
| --- | --- | --- |
| 存储位置 | **Heap**（堆内 byte[]） | 创建快，受 GC 管理；读写 socket 时多一次拷贝到堆外 |
| | **Direct**（堆外） | 无需拷贝到内核，适合 IO；分配释放成本高，所以要**池化** |
| 分配方式 | **Pooled** | 内存池复用，降低分配/GC 压力（默认） |
| | Unpooled | 每次新建，简单 |
| 特殊 | `CompositeByteBuf` | 逻辑上组合多个 ByteBuf，**不拷贝**（零拷贝的一种形式） |
| | `slice()` / `duplicate()` | 共享底层内存的视图，不拷贝；共享引用计数，注意 retain |
| | `Unpooled.wrappedBuffer(byte[])` | 包装数组，不拷贝 |

> [!NOTE] Netty 的“零拷贝”指什么
> 不等同于操作系统的 `sendfile`。Netty 层面有三点：`CompositeByteBuf` 合并不拷贝、`slice` 共享内存、`FileRegion`（底层 `transferTo`/sendfile）传输文件；另外使用堆外内存避免 JVM 堆 → 直接内存的一次拷贝。OS 层面见 [IO / NIO 与零拷贝](#/java/api/io)。

### 池化内存分配（PooledByteBufAllocator）

借鉴 jemalloc：

- 每个线程（EventLoop）绑定一个 **PoolArena**，减少多线程锁竞争；
- Arena 管理多个 **PoolChunk**（默认一块 4MB，内部以**伙伴算法**划分为 8KB 的 Page）；
- 小于一个 Page 的请求由 **PoolSubpage** 切成固定规格的小块（Tiny/Small，按位图管理）；
- 线程本地缓存 **PoolThreadCache**：释放的小块先放回线程本地，下次**无锁**命中；
- 超过 Chunk 的**巨型内存（Huge）**不池化，直接分配/释放。

```java
// 全局默认已是池化 Direct，一般无需自己 new；需要时：
ByteBuf buf = ctx.alloc().directBuffer(256);       // 使用 Channel 配置的分配器
try {
    buf.writeInt(1).writeBytes(payload);
} finally {
    buf.release();                                   // 不经过 pipeline 的 buf 必须自己释放
}
```

调试/调优相关：`-Dio.netty.allocator.type=pooled|unpooled`、`-Dio.netty.maxDirectMemory`（Netty 自己跟踪的堆外上限，默认接近 `-XX:MaxDirectMemorySize`/堆大小）、`PlatformDependent.usedDirectMemory()` 查看已用。Netty 4.2 引入**自适应分配器（Adaptive）**，请以所用版本文档为准。

### 引用计数与泄漏

- 创建时 refCnt = 1，`retain()` +1，`release()` −1，**降到 0 时归还内存池**；
- 规则：**谁最后使用，谁负责释放**。入站消息：`SimpleChannelInboundHandler` 自动释放；继承 `ChannelInboundHandlerAdapter` 的要自己 `ReferenceCountUtil.release(msg)` 或继续向后传递；
- 如果 Handler 把 msg 传给 `fireChannelRead`，就**不要再自己释放**；
- 泄漏检测：`-Dio.netty.leakDetection.level=`

| 级别 | 说明 |
| --- | --- |
| `DISABLED` | 关闭 |
| `SIMPLE`（默认） | 采样约 1/128 的 buffer，只报告“泄漏了”，无调用栈 |
| `ADVANCED` | 采样，报告最近访问位置 |
| `PARANOID` | 100% 追踪，开销大，**压测/排查时开启** |

日志出现 `LEAK: ByteBuf.release() was not called before it's garbage collected` 即泄漏；用 `ADVANCED/PARANOID` 复现可看到创建与最近使用的位置。**定位和排查 OOM 的完整流程**见 [线上调优与故障排查](#/java/jvm/tuning)。

## 粘包与拆包

TCP 只保证**字节顺序**，不保证消息边界。一次 `read` 可能读到半条消息（拆包）或多条消息（粘包）。

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="粘包与拆包：发送的两条消息在接收端被合并或切开">
<text class="th" x="30" y="30">发送方：两条消息</text>
<rect class="b1" x="30" y="44" width="150" height="40" rx="4"/>
<text class="tb" x="105" y="64" text-anchor="middle" dominant-baseline="middle">消息 A（150B）</text>
<rect class="b3" x="190" y="44" width="230" height="40" rx="4"/>
<text class="tb" x="305" y="64" text-anchor="middle" dominant-baseline="middle">消息 B（230B）</text>
<line class="l" x1="225" y1="90" x2="225" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="245" y="104" text-anchor="start">TCP 字节流，边界消失</text>
<text class="th" x="30" y="130">接收方可能收到</text>
<rect class="b1" x="30" y="144" width="150" height="34" rx="4"/>
<text class="t" x="105" y="161" text-anchor="middle" dominant-baseline="middle">A + B 一起（粘包）</text>
<rect class="b1" x="200" y="144" width="100" height="34" rx="4"/>
<text class="t" x="250" y="161" text-anchor="middle" dominant-baseline="middle">A 前半</text>
<rect class="b1" x="304" y="144" width="140" height="34" rx="4"/>
<text class="t" x="374" y="161" text-anchor="middle" dominant-baseline="middle">A 后半 + B 前半</text>
<rect class="b3" x="448" y="144" width="100" height="34" rx="4"/>
<text class="t" x="498" y="161" text-anchor="middle" dominant-baseline="middle">B 后半（拆包）</text>
<text class="ts" x="30" y="206">解决办法：应用层协议划定边界 → 定长 / 分隔符 / 长度字段</text>
</svg>
<figcaption>图 2：TCP 字节流没有消息边界</figcaption>
</figure>

| 方案 | Netty 类 | 特点 |
| --- | --- | --- |
| 定长 | `FixedLengthFrameDecoder` | 简单，浪费带宽 |
| 分隔符 | `DelimiterBasedFrameDecoder`、`LineBasedFrameDecoder` | 文本协议（Redis 的 `\r\n`），负载中不能出现分隔符 |
| **长度字段** | **`LengthFieldBasedFrameDecoder`** | 通用，二进制协议首选 |
| 带状态的解析 | `ByteToMessageDecoder` / `ReplayingDecoder` | 复杂协议自己写 |

### LengthFieldBasedFrameDecoder 参数

```text
协议：| 魔数 2B | 版本 1B | 类型 1B | 序列号 4B | 长度 4B | 负载 N 字节 |
       0        2         3         4          8          12
```

```java
new LengthFieldBasedFrameDecoder(
    1 << 20,   // maxFrameLength：单帧最大长度，超过抛 TooLongFrameException（防恶意大包）
    8,         // lengthFieldOffset：长度字段从第 8 字节开始
    4,         // lengthFieldLength：长度字段占 4 字节
    0,         // lengthAdjustment：长度值与“后续内容”之间的修正（长度字段只表示负载时为 0）
    0          // initialBytesToStrip：解码后丢弃的前缀字节数；0 表示整帧保留（含头部）
);
```

`lengthAdjustment` 与 `initialBytesToStrip` 最易错，官方 Javadoc 有多种图示例，写协议前对照验证。

### 一个完整的自定义协议编解码

```java
public final class Frame {
    public static final short MAGIC = (short) 0xCAFE;
    public byte version = 1;
    public byte type;
    public int seq;
    public byte[] body;
}

public class FrameEncoder extends MessageToByteEncoder<Frame> {
    @Override protected void encode(ChannelHandlerContext ctx, Frame f, ByteBuf out) {
        out.writeShort(Frame.MAGIC).writeByte(f.version).writeByte(f.type)
           .writeInt(f.seq).writeInt(f.body.length).writeBytes(f.body);
    }
}

public class FrameDecoder extends ByteToMessageDecoder {          // 配合前置的 LengthFieldBasedFrameDecoder 已得到完整帧
    @Override protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
        if (in.readableBytes() < 12) return;
        if (in.readShort() != Frame.MAGIC) { ctx.close(); return; }     // 魔数不对：非法连接，直接断开
        Frame f = new Frame();
        f.version = in.readByte(); f.type = in.readByte(); f.seq = in.readInt();
        int len = in.readInt();
        f.body = new byte[len];
        in.readBytes(f.body);
        out.add(f);                                                       // 解出的对象向后传递
    }
}
```

要点：

- **魔数**快速识别非法流量；**版本**支持协议演进；**序列号**用于异步请求-响应匹配（`Map<seq, Promise>`）；
- 校验长度上限，**防止恶意超大长度导致 OOM**；
- 序列化选型：Protobuf（高效、跨语言）、Kryo/Hessian（Java 内部）、JSON（调试方便）；**不要用 JDK 序列化**（性能差且有安全风险）；
- `ByteToMessageDecoder` 内部有累积缓冲区（`cumulation`），自动处理半包；`decode` 中若数据不够直接 return，下次数据到来会再被调用。

## 心跳、空闲检测与重连

### 服务端：检测死连接

```java
pipeline.addLast(new IdleStateHandler(60, 0, 0));        // 60s 没读到任何数据 → 触发 READER_IDLE
pipeline.addLast(new ChannelInboundHandlerAdapter() {
    @Override public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof IdleStateEvent e && e.state() == IdleState.READER_IDLE) {
            log.warn("心跳超时，关闭连接 {}", ctx.channel().remoteAddress());
            ctx.close();
        } else super.userEventTriggered(ctx, evt);
    }
});
```

### 客户端：定时发送心跳

```java
pipeline.addLast(new IdleStateHandler(0, 20, 0));        // 20s 没有写 → 触发 WRITER_IDLE，发心跳
// 在 userEventTriggered 中：if (WRITER_IDLE) ctx.writeAndFlush(Frame.ping());
```

经验：**服务端超时 ≥ 3 倍心跳间隔**，容忍丢包；移动网络下 NAT 超时常在 2~5 分钟，心跳间隔要小于它。TCP 层 `SO_KEEPALIVE` 默认 2 小时，不能替代应用心跳。

### 客户端重连：指数退避 + 抖动

```java
void scheduleReconnect(EventLoop loop, int attempt) {
    long base = Math.min(30_000, 1000L << Math.min(attempt, 5));         // 1s,2s,4s,... 封顶 30s
    long delay = base / 2 + ThreadLocalRandom.current().nextLong(base / 2);   // 加抖动
    loop.schedule(() -> connect(attempt + 1), delay, TimeUnit.MILLISECONDS);
}
```

没有抖动时，服务端重启后所有客户端**同一时刻重连**，形成**重连风暴**，可能再次压垮服务。海量设备接入场景见 [Broker 架构与集群（EMQX）](#/iot/broker)。

## 写缓冲背压

```java
// 通过水位线控制：积压超过 high 则 isWritable() 变为 false，回落到 low 以下再变为 true
bootstrap.childOption(ChannelOption.WRITE_BUFFER_WATER_MARK, new WriteBufferWaterMark(32 * 1024, 64 * 1024));

void send(Channel ch, Object msg) {
    if (ch.isWritable()) {
        ch.writeAndFlush(msg);
    } else {
        // 策略：丢弃低优先级消息 / 暂停读取上游 / 缓存到有界队列 / 返回繁忙
    }
}

// 也可在 Handler 中监听
@Override public void channelWritabilityChanged(ChannelHandlerContext ctx) {
    if (ctx.channel().isWritable()) resumeUpstream(); else pauseUpstream();
}
```

不做背压的后果：慢客户端的写队列无限增长，堆外内存耗尽，**一个慢连接拖垮整个进程**。作为代理/网关时尤其重要：**上游读速度要与下游写速度联动**（关闭 `autoRead`，`isWritable` 恢复后再 `read()`）。

## 性能调优清单

| 方向 | 做法 |
| --- | --- |
| 线程数 | Worker 默认 2×CPU，对 CPU 密集业务不要再大；耗时业务放业务线程池，**不阻塞 EventLoop** |
| 传输层 | Linux 用 `EpollEventLoopGroup`；`SO_REUSEPORT` 让多个 EventLoop 各自 accept（`EpollChannelOption.SO_REUSEPORT`） |
| 内存 | 池化 Direct（默认）；确认没有泄漏；`-XX:MaxDirectMemorySize` 与 Netty 上限配合；避免频繁 `copy()` |
| 选项 | `TCP_NODELAY=true`（小包低延迟）；`SO_BACKLOG` 与内核 `somaxconn` 一起调大；`SO_RCVBUF/SNDBUF` 按 BDP 调整；`SO_KEEPALIVE` 仅辅助 |
| flush | 批量 `write` 再 `flush`；或使用 `FlushConsolidationHandler` 合并 flush 减少系统调用 |
| 序列化 | 二进制（Protobuf）优于 JSON；复用对象；避免在 EventLoop 做大对象序列化 |
| 连接 | 客户端复用连接（连接池 / 多路复用），避免每次请求建连 |
| 内核 | `fs.file-max` / `ulimit -n`、`net.ipv4.tcp_max_syn_backlog`、`net.core.somaxconn`、`tcp_tw_reuse`（客户端）、`ip_local_port_range` |
| 监控 | 暴露 EventLoop 任务队列长度（`SingleThreadEventExecutor.pendingTasks()`）、连接数、堆外内存使用、`isWritable` 为 false 的比例、GC |

百万连接服务的主要成本是**内存**（每连接的内核 socket 缓冲区 + ChannelPipeline + 应用对象），而不是 CPU；估算时 `连接数 × 每连接内存` 要预留余量，并关注文件描述符与端口范围（见 [Linux 线上排查](#/infra/linux)）。

## 优雅关闭

```java
// 先停止接收新连接 → 通知客户端/完成在途请求 → 关闭线程组
serverChannel.close().sync();
worker.shutdownGracefully(2, 15, TimeUnit.SECONDS).sync();   // quietPeriod=2s：期间无新任务才真正关闭；timeout=15s 上限
boss.shutdownGracefully(0, 5, TimeUnit.SECONDS).sync();
```

在 Kubernetes 中需与 `preStop` 摘流、`terminationGracePeriodSeconds` 配合，见 [Kubernetes 核心概念](#/infra/k8s)。

## 面试追问

> [!QUESTION] Netty 如何解决粘包和拆包？
> TCP 无消息边界，应用层必须划定。Netty 提供定长、分隔符和长度字段解码器，二进制协议通常用 `LengthFieldBasedFrameDecoder`，按长度字段累积完整帧再向后传递；还要限制最大帧长度防止恶意大包。

> [!QUESTION] ByteBuf 相比 JDK ByteBuffer 有什么优势？
> 读写指针分离无需 flip；容量可动态扩容；支持池化与引用计数；提供 CompositeByteBuf、slice 等零拷贝视图；API 更丰富，并且可使用堆外内存减少拷贝。

> [!QUESTION] 堆外内存泄漏怎么定位？
> 日志里有 `LEAK` 提示时设置 `leakDetection.level=PARANOID` 复现，根据报告的创建/访问位置检查是否漏了 `release`；用 NMT 或 Netty 的 `PlatformDependent.usedDirectMemory()` 观察增长；常见原因是 Handler 未释放入站消息、异常分支没有释放。

> [!QUESTION] 如何设计心跳与重连？
> 服务端用 IdleStateHandler 检测读空闲并断开死连接；客户端写空闲时发送心跳；超时阈值为心跳间隔的 3 倍左右；重连使用指数退避并加入随机抖动，避免故障恢复时的重连风暴。

> [!QUESTION] 为什么要做写背压？怎么做？
> 对端读得慢时，Netty 的出站缓冲区会无限增长导致内存耗尽。设置 WriteBufferWaterMark，写前检查 `isWritable()`，超过高水位时暂停上游读取或丢弃/缓存消息，低水位恢复后继续。
