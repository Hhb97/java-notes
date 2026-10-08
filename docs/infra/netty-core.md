---
level: 深入
tags: [Netty, EventLoop, ChannelPipeline, Reactor, NIO, 零拷贝, 线程模型]
summary: 从源码层面拆解 Netty 的线程模型：Boss/Worker 的启动与连接接入、EventLoop 的 select 循环与任务队列、ChannelPipeline 的双向责任链与事件传播，以及 JDK NIO 空轮询 bug 的规避。
---

# Netty 源码：线程模型与 Pipeline

> [!ABSTRACT] 核心要点
> - Netty 是**主从 Reactor** 的工程化实现：`BossGroup` 的 EventLoop 负责 accept，把新连接注册到 `WorkerGroup` 的某个 EventLoop；**一个 Channel 终生绑定一个 EventLoop（一个线程）**，所以 Handler 里通常不需要加锁。
> - `NioEventLoop#run` 是一个死循环：**select（等待 IO）→ processSelectedKeys（处理 IO）→ runAllTasks（处理任务队列）**，IO 与任务按 `ioRatio`（默认 50）分配时间。
> - `ChannelPipeline` 是**双向链表形式的责任链**：入站事件（读）从 Head 向 Tail 传播，出站事件（写）从 Tail 向 Head 传播；`ctx.fireChannelRead` 和 `ctx.write` 只会从**当前节点**向后/向前找下一个同方向 Handler。
> - **不要在 EventLoop 线程里做阻塞操作**（DB、同步 RPC、`sleep`），否则同一个 EventLoop 上所有连接都被拖慢；耗时业务丢到业务线程池。
> - Netty 对 JDK NIO 做了优化：用**数组替换 `selectedKeys` 的 HashSet**、规避 **epoll 空轮询 bug**（空转超阈值后重建 Selector）、提供 **Epoll native transport**。

> [!NOTE] 版本
> 源码引用基于 **Netty 4.1.x**（4.2 在分配器与部分 API 上有调整，主线程模型一致）。示例经过精简，只保留关键逻辑；前置的 IO 模型与 epoll 基础见 [IO 模型与 Netty](#/infra/netty)。

## 整体线程模型

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Netty 主从 Reactor 线程模型：BossGroup 接入连接，WorkerGroup 处理读写与 Pipeline">
<rect class="b" x="20" y="150" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="178" text-anchor="middle" dominant-baseline="middle">客户端们</text>
<rect class="b1" x="170" y="40" width="200" height="110" rx="12"/>
<text class="th" x="270" y="64" text-anchor="middle">BossGroup（1 线程）</text>
<rect class="b3" x="190" y="80" width="160" height="50" rx="8"/>
<text class="tb" x="270" y="98" text-anchor="middle" dominant-baseline="middle">EventLoop-boss</text>
<text class="ts" x="270" y="116" text-anchor="middle">Selector 监听 OP_ACCEPT</text>
<rect class="b2" x="440" y="30" width="300" height="300" rx="12"/>
<text class="th" x="590" y="54" text-anchor="middle">WorkerGroup（默认 2×CPU 线程）</text>
<rect class="b3" x="460" y="74" width="260" height="76" rx="8"/>
<text class="tb" x="590" y="92" text-anchor="middle" dominant-baseline="middle">EventLoop-1</text>
<text class="ts" x="590" y="112" text-anchor="middle">Selector · taskQueue · 绑定 Channel A、B、C</text>
<text class="ts" x="590" y="130" text-anchor="middle">每个 Channel 一条 ChannelPipeline</text>
<rect class="b3" x="460" y="164" width="260" height="76" rx="8"/>
<text class="tb" x="590" y="182" text-anchor="middle" dominant-baseline="middle">EventLoop-2</text>
<text class="ts" x="590" y="202" text-anchor="middle">绑定 Channel D、E</text>
<text class="ts" x="590" y="220" text-anchor="middle">连接按 Chooser 轮询分配</text>
<rect class="b5" x="460" y="254" width="260" height="60" rx="8"/>
<text class="tb" x="590" y="272" text-anchor="middle" dominant-baseline="middle">业务线程池（可选）</text>
<text class="ts" x="590" y="292" text-anchor="middle">耗时/阻塞任务在此执行，完成后回写</text>
<line class="l" x1="120" y1="178" x2="170" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="132" y="130" text-anchor="middle">① 连接</text>
<line class="la" x1="370" y1="105" x2="460" y2="112" marker-end="url(#arr-a)"/>
<text class="ta" x="415" y="86" text-anchor="middle">② 注册 Channel</text>
<line class="l" x1="120" y1="190" x2="460" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="290" y="182" text-anchor="middle">③ 后续读写事件直达 Worker</text>
<line class="ld" x1="590" y1="150" x2="590" y2="164"/>
<line class="ld" x1="590" y1="240" x2="590" y2="254"/>
</svg>
<figcaption>图 1：主从 Reactor：Boss 负责接入，Worker 负责 IO，业务线程池可选</figcaption>
</figure>

```java
EventLoopGroup boss = new NioEventLoopGroup(1);
EventLoopGroup worker = new NioEventLoopGroup();                // 默认线程数 = max(1, CPU*2)
try {
    ServerBootstrap b = new ServerBootstrap();
    b.group(boss, worker)
     .channel(NioServerSocketChannel.class)
     .option(ChannelOption.SO_BACKLOG, 1024)                     // 作用于监听 socket：全连接队列长度
     .childOption(ChannelOption.TCP_NODELAY, true)               // 作用于每个客户端连接
     .childHandler(new ChannelInitializer<SocketChannel>() {
         @Override protected void initChannel(SocketChannel ch) {
             ch.pipeline().addLast(new IdleStateHandler(60, 0, 0))
                          .addLast(new LengthFieldBasedFrameDecoder(1 << 20, 0, 4, 0, 4))
                          .addLast(new MyDecoder(), new MyBizHandler());
         }
     });
    b.bind(8080).sync().channel().closeFuture().sync();
} finally {
    boss.shutdownGracefully(); worker.shutdownGracefully();
}
```

`option` 配置给 ServerChannel（监听），`childOption` 配置给接入的子 Channel，常见易混点。

## 服务端启动：bind 做了什么

1. `initAndRegister()`：反射创建 `NioServerSocketChannel`（内部持有 JDK 的 `ServerSocketChannel`），`init` 时向其 Pipeline 添加一个 `ServerBootstrapAcceptor`；
2. **注册**：把 Channel 提交给 BossGroup 的一个 EventLoop，**在 EventLoop 线程里**执行 `javaChannel().register(selector, 0, this)`（此时 ops=0，只是建立关联）；
3. `doBind0`：同样提交成任务由 EventLoop 线程执行，调用 JDK `bind`；
4. 绑定成功后触发 `channelActive`，`HeadContext` 在 `readIfIsAutoRead` 中把 `OP_ACCEPT` 加入 interestOps，开始监听。

要点：Netty 中几乎所有对 Channel 的操作最终都会**转到它绑定的 EventLoop 线程**中执行（`eventLoop.inEventLoop()` 判断，不在则 `execute` 提交任务），这就是它**无锁串行化**的来源。

### 新连接接入

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="新连接接入流程：Boss 线程 accept 后通过 ServerBootstrapAcceptor 注册到 Worker">
<rect class="b3" x="20" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="52" text-anchor="middle" dominant-baseline="middle">Boss EventLoop</text>
<text class="ts" x="95" y="70" text-anchor="middle">select 到 OP_ACCEPT</text>
<rect class="b1" x="210" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="285" y="52" text-anchor="middle" dominant-baseline="middle">NioMessageUnsafe</text>
<text class="ts" x="285" y="70" text-anchor="middle">read() → doReadMessages</text>
<rect class="b1" x="400" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="475" y="52" text-anchor="middle" dominant-baseline="middle">accept() 得到 SocketChannel</text>
<text class="ts" x="475" y="70" text-anchor="middle">包装成 NioSocketChannel</text>
<rect class="b5" x="590" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="655" y="52" text-anchor="middle" dominant-baseline="middle">pipeline.fire</text>
<text class="ts" x="655" y="70" text-anchor="middle">ChannelRead(子Channel)</text>
<line class="l" x1="170" y1="58" x2="210" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="58" x2="400" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="58" x2="590" y2="58" marker-end="url(#arr)"/>
<rect class="b4" x="400" y="140" width="320" height="76" rx="10"/>
<text class="tb" x="560" y="162" text-anchor="middle" dominant-baseline="middle">ServerBootstrapAcceptor#channelRead</text>
<text class="ts" x="560" y="184" text-anchor="middle">① 把 childHandler 加入子 Channel 的 Pipeline</text>
<text class="ts" x="560" y="202" text-anchor="middle">② 设置 childOption；③ childGroup.register(child)</text>
<line class="la" x1="655" y1="86" x2="655" y2="140" marker-end="url(#arr-a)"/>
<rect class="b2" x="20" y="140" width="320" height="76" rx="10"/>
<text class="tb" x="180" y="162" text-anchor="middle" dominant-baseline="middle">Worker EventLoop（chooser 轮询选出）</text>
<text class="ts" x="180" y="184" text-anchor="middle">注册 Selector（ops=0）→ channelRegistered</text>
<text class="ts" x="180" y="202" text-anchor="middle">→ channelActive → 添加 OP_READ</text>
<line class="la" x1="400" y1="178" x2="340" y2="178" marker-end="url(#arr-a)"/>
</svg>
<figcaption>图 2：新连接由 Boss accept，再通过 Acceptor 交给 Worker</figcaption>
</figure>

`MultithreadEventExecutorGroup` 用 `EventExecutorChooser` 选择下一个 EventLoop：线程数是 2 的幂时用**位运算**（`idx++ & (len-1)`），否则取模，这也是一个常见的“Netty 为何喜欢 2 的幂”的细节。

## EventLoop：核心循环

`NioEventLoop` 同时是一个 `Executor`（有 `taskQueue`）和一个 Reactor（持有 Selector）。`run()` 精简后如下：

```java
// Netty 4.1 NioEventLoop#run（节选，已简化）
protected void run() {
    for (;;) {
        try {
            switch (selectStrategy.calculateStrategy(selectNowSupplier, hasTasks())) {
                case SelectStrategy.SELECT:
                    select(wakenUp.getAndSet(false));            // 有定时任务则带超时 select，否则阻塞
                    if (wakenUp.get()) selector.wakeup();
                default:
            }
            final int ioRatio = this.ioRatio;                    // 默认 50
            if (ioRatio == 100) {
                try { processSelectedKeys(); } finally { runAllTasks(); }
            } else {
                final long ioStartTime = System.nanoTime();
                try { processSelectedKeys(); }                   // ① 处理就绪的 IO 事件
                finally {
                    final long ioTime = System.nanoTime() - ioStartTime;
                    runAllTasks(ioTime * (100 - ioRatio) / ioRatio);   // ② 按比例限时执行任务队列
                }
            }
        } catch (Throwable t) { handleLoopException(t); }
        // ……检查 shutdown
    }
}
```

三部分：

| 阶段 | 内容 |
| --- | --- |
| `select` | 阻塞等待 IO；若队列里有任务则 `selectNow` 立即返回；有**定时任务**则 select 超时设为最近一个到期时间；外部提交任务时会 `wakeup()` 唤醒 |
| `processSelectedKeys` | 遍历就绪 key，OP_READ / OP_WRITE / OP_ACCEPT / OP_CONNECT 分别交给 `Unsafe` 处理；Netty 把 JDK 的 `selectedKeys`（HashSet）**反射替换为数组实现**，遍历更快、少 GC |
| `runAllTasks` | 把定时任务队列中到期的搬到普通队列，然后依次执行：用户 `execute()` 的任务、`channel.write` 转发的任务等；有时间预算，防止任务过多饿死 IO |

### 三种任务

- **普通任务**：`eventLoop.execute(Runnable)`，进入 MPSC（多生产者单消费者）无锁队列；
- **定时任务**：`schedule(...)`，进入优先级队列（`ScheduledFutureTask`），**心跳、超时检测**都基于它；
- **尾部任务**：`executeAfterEachLoop`，每次循环末尾执行（如统计、flush 合并）。

### 空轮询 bug 的规避

JDK NIO 在 Linux 上有一个已知 bug：某些情况下 `select()` 没有就绪事件也会立即返回，导致 EventLoop **空转 100% CPU**。Netty 的对策（`select` 方法内）：

```java
// 统计在“预期阻塞时间”内是否被提前唤醒；连续空转次数达到阈值，则重建 Selector
if (time - TimeUnit.MILLISECONDS.toNanos(timeoutMillis) >= currentTimeNanos) {
    selectCnt = 1;                                  // 正常阻塞过，计数清零
} else if (SELECTOR_AUTO_REBUILD_THRESHOLD > 0 && selectCnt >= SELECTOR_AUTO_REBUILD_THRESHOLD) {
    selector = selectRebuildSelector(selectCnt);    // 新建 Selector，把所有 Channel 重新注册过去
    selectCnt = 1;
}
```

阈值默认 **512**（`io.netty.selectorAutoRebuildThreshold`）。使用 **Epoll native transport**（`EpollEventLoopGroup`）可以完全绕开 JDK Selector。

## ChannelPipeline：双向责任链

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="ChannelPipeline 的双向链表结构，入站从 Head 到 Tail，出站从 Tail 到 Head">
<rect class="b4" x="20" y="90" width="90" height="60" rx="8"/>
<text class="tb" x="65" y="112" text-anchor="middle" dominant-baseline="middle">HeadContext</text>
<text class="ts" x="65" y="132" text-anchor="middle">与 Unsafe 交互</text>
<rect class="b1" x="150" y="90" width="110" height="60" rx="8"/>
<text class="tb" x="205" y="112" text-anchor="middle" dominant-baseline="middle">IdleState</text>
<text class="ts" x="205" y="132" text-anchor="middle">Inbound+Outbound</text>
<rect class="b1" x="300" y="90" width="110" height="60" rx="8"/>
<text class="tb" x="355" y="112" text-anchor="middle" dominant-baseline="middle">Decoder</text>
<text class="ts" x="355" y="132" text-anchor="middle">Inbound</text>
<rect class="b3" x="450" y="90" width="110" height="60" rx="8"/>
<text class="tb" x="505" y="112" text-anchor="middle" dominant-baseline="middle">Encoder</text>
<text class="ts" x="505" y="132" text-anchor="middle">Outbound</text>
<rect class="b1" x="600" y="90" width="80" height="60" rx="8"/>
<text class="tb" x="640" y="112" text-anchor="middle" dominant-baseline="middle">BizHandler</text>
<text class="ts" x="640" y="132" text-anchor="middle">Inbound</text>
<rect class="b4" x="700" y="90" width="50" height="60" rx="8"/>
<text class="tb" x="725" y="120" text-anchor="middle" dominant-baseline="middle">Tail</text>
<line class="l" x1="110" y1="110" x2="150" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="110" x2="300" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="110" x2="450" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="110" x2="600" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="680" y1="110" x2="700" y2="110" marker-end="url(#arr)"/>
<text class="ta" x="380" y="70" text-anchor="middle">入站（Inbound）：读事件，Head → Tail，只经过 InboundHandler</text>
<line class="la" x1="720" y1="150" x2="590" y2="150"/>
<line class="la" x1="590" y1="150" x2="590" y2="190"/>
<line class="la" x1="590" y1="190" x2="130" y2="190"/>
<line class="la" x1="130" y1="190" x2="130" y2="150" marker-end="url(#arr-a)"/>
<text class="ts" x="360" y="212" text-anchor="middle">出站（Outbound）：write/flush/connect，Tail → Head，只经过 OutboundHandler</text>
<text class="ts" x="380" y="248" text-anchor="middle">ctx.writeAndFlush(msg) 从当前节点向前找；channel.writeAndFlush(msg) 从 Tail 开始</text>
</svg>
<figcaption>图 3：Pipeline 是带 Head 和 Tail 哨兵的双向链表，入站与出站方向相反</figcaption>
</figure>

### 关键结构

- 每个 Handler 被包装在 `AbstractChannelHandlerContext`（双向链表节点）中，节点持有 `prev/next`、所属 Pipeline、所绑定的 `EventExecutor`；
- `ChannelInboundHandler`：`channelRegistered / Active / Read / ReadComplete / Inactive / exceptionCaught / userEventTriggered`；
- `ChannelOutboundHandler`：`bind / connect / write / flush / read / close`；
- **事件传播**要手动继续：入站用 `ctx.fireChannelRead(msg)`，不调用就**在此终止**；出站用 `ctx.write(msg)`；
- `ChannelHandlerAdapter` 的默认实现就是“继续传播”，只重写关心的方法即可。

```java
// 入站传播的核心：找到“下一个入站节点”并在它的 executor 线程里调用
private AbstractChannelHandlerContext findContextInbound(int mask) {
    AbstractChannelHandlerContext ctx = this;
    do { ctx = ctx.next; } while ((ctx.executionMask & mask) == 0);   // 位掩码跳过不关心该事件的 Handler
    return ctx;
}
static void invokeChannelRead(final AbstractChannelHandlerContext next, Object msg) {
    EventExecutor executor = next.executor();
    if (executor.inEventLoop()) next.invokeChannelRead(msg);
    else executor.execute(() -> next.invokeChannelRead(msg));         // 跨线程则提交任务
}
```

`executionMask` 是 4.1.4x 之后的优化：在添加 Handler 时通过反射/注解**预先计算它实现了哪些事件方法**，传播时用位运算快速跳过无关节点。

### 写操作的路径

1. `ctx.write(msg)`：沿 Outbound 方向传播到 `HeadContext`，调用 `Unsafe.write`，把消息放入 `ChannelOutboundBuffer`（**写缓冲链表**，此时没有真正发送）；
2. `flush()`：同样传到 Head，`Unsafe.flush` 把缓冲区中的 `ByteBuf` 转成 `ByteBuffer[]`，调用 `SocketChannel.write(ByteBuffer[])`（**gather write**，一次系统调用写多块）；
3. 若一次没写完（socket 发送缓冲区满），注册 **OP_WRITE**，待可写时继续，写完取消关注；
4. `writeAndFlush` 只是 write + flush 的组合；**高吞吐场景应批量 write 再 flush**，减少系统调用。

> [!WARNING] 在 Handler 里持有和使用 ByteBuf 的生命周期
> 入站的 `ByteBuf` 引用计数由**最后一个消费它的 Handler 负责 release**；`SimpleChannelInboundHandler` 默认帮你释放（所以不能把 msg 传给别的线程再用）。出站的 `write` 会在写完后自动 release。漏 release 造成堆外内存泄漏，见 [Netty 实战：编解码、内存与调优](#/infra/netty-practice)。

## 线程模型里的几条铁律

| 规则 | 原因 |
| --- | --- |
| 一个 Channel 的所有 IO 与 Pipeline 事件都在同一个 EventLoop 线程 | 串行化，无需同步；Handler 内可安全使用成员变量（非 `@Sharable`） |
| `@Sharable` 的 Handler 必须无状态或自行保证线程安全 | 同一个实例被加入多个 Pipeline，会被多个 EventLoop 并发调用 |
| **绝不在 EventLoop 线程执行阻塞调用** | 阻塞会让该 EventLoop 上所有 Channel 停摆；耗时业务用独立线程池，或 `pipeline.addLast(bizGroup, handler)` |
| 从非 IO 线程调用 `channel.write` 是安全的 | 会被包装成任务提交到 EventLoop；但回调（Future listener）也在 EventLoop 线程 |
| 一个 EventLoop 服务多个 Channel | 某个 Channel 的慢处理影响同线程其他 Channel，注意**长尾隔离** |

给 Handler 指定业务线程池：

```java
EventExecutorGroup bizGroup = new DefaultEventExecutorGroup(32);
pipeline.addLast(bizGroup, "biz", new MyBizHandler());      // 该 Handler 的回调在 bizGroup 的线程中运行
```

注意：此时同一个 Channel 的事件仍然绑定到 bizGroup 里**固定的一个线程**（保持顺序），而不是随意分发。

## 其他值得掌握的实现细节

- **FastThreadLocal**：用数组下标代替 `ThreadLocalMap` 的哈希查找，`FastThreadLocalThread` 持有 `InternalThreadLocalMap`，读写更快；
- **HashedWheelTimer**：时间轮定时器，适合海量**粗精度**定时任务（超时检测），每个任务 O(1) 插入；默认 tick 100ms；
- **Recycler**：对象池，线程本地栈 + 跨线程 WeakOrderQueue，减少频繁创建 `PooledByteBuf` 等对象；
- **Promise/Future**：可写的 Future，`addListener` 回调在 EventLoop 线程执行；`sync()/await()` **不能在 EventLoop 线程里调用**（会抛 `BlockingOperationException` 检测死锁）；
- **Epoll native transport**：`EpollEventLoopGroup`、`EpollServerSocketChannel`，直接调用 epoll，支持**边缘触发**、`SO_REUSEPORT`、TCP_FASTOPEN 等，Linux 上性能和 GC 更好；
- **io_uring**：作为 `netty-incubator-transport-native-io_uring` 提供，仍在演进。

## 常见问题与排查

| 现象 | 原因与排查 |
| --- | --- |
| CPU 100%，jstack 里线程停在 `NioEventLoop.select` / `epollWait` 附近 | 空轮询 bug（调低 JDK 风险、升 Netty、用 Epoll transport） |
| 少数连接响应极慢 | 同 EventLoop 上有 Handler 阻塞或做了重计算；`jstack` 查看 `nioEventLoopGroup-3-x` 的栈 |
| `BlockingOperationException` | 在 EventLoop 线程调用了 `sync()/await()` |
| 内存持续上涨、`LEAK: ByteBuf.release() was not called` | 引用计数未释放，设置 `-Dio.netty.leakDetection.level=PARANOID` 复现 |
| 写入大量数据后 OOM | 对端消费慢，`ChannelOutboundBuffer` 积压；必须按 `isWritable()` 做**写背压** |
| 客户端连接大量 `CLOSE_WAIT` | 收到对端 FIN 后没有 `ctx.close()`（检查 `channelInactive`/异常处理） |

## 面试追问

> [!QUESTION] Netty 的线程模型是怎样的？
> 主从 Reactor：BossGroup 的 EventLoop 监听 OP_ACCEPT 并通过 ServerBootstrapAcceptor 把新连接注册到 WorkerGroup 的一个 EventLoop；该 Channel 之后的所有读写和 Pipeline 事件都由这个线程串行处理，因此 Handler 无需加锁。耗时业务应交给独立线程池。

> [!QUESTION] NioEventLoop 的 run 循环做了什么？
> 循环执行 select（等待 IO，或根据任务/定时任务调整超时）、processSelectedKeys（处理 IO）、runAllTasks（执行任务队列并受 ioRatio 控制时间占比）；同时检测空轮询并重建 Selector。

> [!QUESTION] 入站和出站事件是如何在 Pipeline 中传播的？
> Pipeline 是带 Head/Tail 的双向链表；入站事件从 Head 向 Tail 传播，只经过 InboundHandler，需要 `ctx.fireXxx` 继续传递；出站事件（write/flush/close）从 Tail 向 Head，只经过 OutboundHandler。`ctx.write` 从当前节点往前，`channel.write` 从 Tail 开始。

> [!QUESTION] Netty 如何解决 JDK NIO 空轮询问题？
> 统计 select 提前返回的连续次数，超过阈值（默认 512）就新建 Selector，把所有 Channel 重新注册，丢弃旧 Selector；也可以使用 Epoll native transport 直接避开。

> [!QUESTION] 为什么说 Netty 的 Handler 通常是线程安全的，什么时候不是？
> 因为一个 Channel 绑定唯一 EventLoop，其 Handler 在同一线程串行执行；但标注 `@Sharable` 的 Handler 实例被多个 Channel（不同 EventLoop）共享，需要自己保证线程安全。
