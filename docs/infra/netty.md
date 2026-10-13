---
level: 深入
tags: [IO 模型, epoll, Reactor, Netty, ByteBuf, 粘包拆包]
summary: 从五种 IO 模型、epoll 内核实现到 Reactor 与 Netty 线程模型、ByteBuf 内存管理和粘包拆包，理解 Dubbo/gRPC/WebFlux 的通信底座
---

# IO 模型与 Netty

> [!ABSTRACT] 核心要点
> - 一次网络读分两个阶段：**等待数据就绪**与**内核拷贝到用户空间**。前四种 IO 模型第二阶段都阻塞，只有 AIO 是真正的异步。
> - epoll 用**红黑树**管理所有监听的 fd、用**就绪链表**收集有事件的 fd，事件到来时由内核回调入链，`epoll_wait` 只返回就绪的 fd，所以连接数增加不会让单次调用变慢。
> - Netty 是**主从 Reactor**：BossGroup 负责 accept，WorkerGroup 的每个 EventLoop 是**一个线程 + 一个 Selector + 任务队列**，一个 Channel 终身绑定一个 EventLoop，因此 Handler 内天然无锁。
> - 最重要的一条纪律：**绝不在 EventLoop 线程里做阻塞操作**（DB、RPC、锁等待、大计算），否则该线程上的成百上千个连接全部卡住。
> - ByteBuf 默认池化 + 直接内存 + 引用计数，**谁最后使用谁 release**；TCP 是字节流，必须用解码器（如 `LengthFieldBasedFrameDecoder`）处理粘包拆包。

## 五种 IO 模型

以一次 `recvfrom` 为例，数据先由网卡 DMA 到内核 socket 缓冲区，再由内核拷贝到用户空间：

<figure class="fig">
<svg viewBox="0 0 720 330" class="dg" role="img" aria-label="五种 IO 模型在等待数据和数据拷贝两个阶段的阻塞情况对比">
<text class="tb" x="100" y="28" text-anchor="middle">IO 模型</text>
<text class="tb" x="325" y="28" text-anchor="middle">阶段一：等待数据就绪</text>
<text class="tb" x="590" y="28" text-anchor="middle">阶段二：内核 → 用户空间</text>
<rect class="b" x="20" y="44" width="160" height="40" rx="6"/>
<text class="tb" x="100" y="64" text-anchor="middle" dominant-baseline="middle">阻塞 IO（BIO）</text>
<rect class="b4" x="200" y="44" width="250" height="40" rx="6"/>
<text class="t" x="325" y="64" text-anchor="middle" dominant-baseline="middle">阻塞在 recvfrom</text>
<rect class="b4" x="470" y="44" width="230" height="40" rx="6"/>
<text class="t" x="585" y="64" text-anchor="middle" dominant-baseline="middle">阻塞</text>
<rect class="b" x="20" y="98" width="160" height="40" rx="6"/>
<text class="tb" x="100" y="118" text-anchor="middle" dominant-baseline="middle">非阻塞 IO</text>
<rect class="b3" x="200" y="98" width="250" height="40" rx="6"/>
<text class="t" x="325" y="118" text-anchor="middle" dominant-baseline="middle">反复轮询，返回 EAGAIN</text>
<rect class="b4" x="470" y="98" width="230" height="40" rx="6"/>
<text class="t" x="585" y="118" text-anchor="middle" dominant-baseline="middle">阻塞</text>
<rect class="b" x="20" y="152" width="160" height="40" rx="6"/>
<text class="tb" x="100" y="172" text-anchor="middle" dominant-baseline="middle">IO 多路复用</text>
<rect class="b4" x="200" y="152" width="250" height="40" rx="6"/>
<text class="t" x="325" y="172" text-anchor="middle" dominant-baseline="middle">阻塞在 epoll_wait（等多个 fd）</text>
<rect class="b4" x="470" y="152" width="230" height="40" rx="6"/>
<text class="t" x="585" y="172" text-anchor="middle" dominant-baseline="middle">阻塞（再调 read）</text>
<rect class="b" x="20" y="206" width="160" height="40" rx="6"/>
<text class="tb" x="100" y="226" text-anchor="middle" dominant-baseline="middle">信号驱动 IO</text>
<rect class="b2" x="200" y="206" width="250" height="40" rx="6"/>
<text class="t" x="325" y="226" text-anchor="middle" dominant-baseline="middle">不阻塞，就绪时 SIGIO 通知</text>
<rect class="b4" x="470" y="206" width="230" height="40" rx="6"/>
<text class="t" x="585" y="226" text-anchor="middle" dominant-baseline="middle">阻塞</text>
<rect class="b5" x="20" y="260" width="160" height="40" rx="6"/>
<text class="tb" x="100" y="280" text-anchor="middle" dominant-baseline="middle">异步 IO（AIO）</text>
<rect class="b2" x="200" y="260" width="250" height="40" rx="6"/>
<text class="t" x="325" y="280" text-anchor="middle" dominant-baseline="middle">不阻塞，提交后立即返回</text>
<rect class="b2" x="470" y="260" width="230" height="40" rx="6"/>
<text class="t" x="585" y="280" text-anchor="middle" dominant-baseline="middle">不阻塞，拷贝完成后通知</text>
<text class="ts" x="20" y="322">红色 = 线程阻塞；前四种第二阶段都阻塞，按 POSIX 定义都属于同步 IO；只有 AIO 是异步 IO</text>
</svg>
<figcaption>图 1：五种 IO 模型在两个阶段的阻塞情况</figcaption>
</figure>

| 模型 | Java 对应 | 特点 | 适用 |
| --- | --- | --- | --- |
| 阻塞 IO | `java.io` / `Socket` | 一连接一线程，简单 | 连接少、Tomcat BIO（已移除） |
| 非阻塞 IO | `SocketChannel.configureBlocking(false)` 单独使用 | 用户态空转轮询，浪费 CPU | 几乎不单独使用 |
| IO 多路复用 | `java.nio.channels.Selector`（Linux 上是 epoll） | 一个线程管理成千上万连接 | **Netty、Tomcat NIO、Redis、Nginx 的基础** |
| 信号驱动 | 无 | 信号处理复杂，TCP 上信号过于频繁 | 很少使用 |
| 异步 IO | `AsynchronousSocketChannel`（NIO.2） | 内核完成拷贝后回调 | Linux 上 JDK 的 AIO 实际用 epoll + 线程池模拟；io_uring 才是 Linux 上实用的真异步接口 |

> [!NOTE] 同步/异步 与 阻塞/非阻塞 是两个维度
> 阻塞/非阻塞说的是**调用在数据未就绪时是否立刻返回**；同步/异步说的是**数据拷贝由谁完成、是否需要用户线程等待**。多路复用的 `epoll_wait` 是阻塞的，但一个线程阻塞换来同时监听很多 fd，这才是它高效的原因。NIO 与零拷贝的基础见 [IO / NIO 与零拷贝](#/java/api/io)。

## select、poll 与 epoll

| | select | poll | epoll |
| --- | --- | --- | --- |
| fd 集合 | 位图 `fd_set`，上限 `FD_SETSIZE`（通常 1024） | `pollfd` 数组，无硬上限 | 内核红黑树，无硬上限 |
| 每次调用 | 整个集合从用户态拷贝到内核 | 同左 | 只在 `epoll_ctl` 时注册一次 |
| 找就绪 fd | 内核遍历全部 fd，用户再遍历一次，O(n) | O(n) | 回调把就绪 fd 放进就绪链表，返回的只有就绪 fd |
| 触发方式 | 水平触发 | 水平触发 | LT（默认）/ ET 可选 |
| 跨平台 | 全平台 | 类 Unix | 仅 Linux（BSD/macOS 用 kqueue） |

### epoll 的内核实现

<figure class="fig">
<svg viewBox="0 0 720 310" class="dg" role="img" aria-label="epoll 内部结构：红黑树保存所有监听的 fd，数据到达时回调把 fd 加入就绪链表，epoll_wait 只返回就绪链表">
<rect class="b1" x="20" y="30" width="300" height="40" rx="8"/>
<text class="tb" x="170" y="50" text-anchor="middle" dominant-baseline="middle">channel.register(selector, OP_READ)</text>
<rect class="b1" x="400" y="30" width="300" height="40" rx="8"/>
<text class="tb" x="550" y="50" text-anchor="middle" dominant-baseline="middle">selector.select() → epoll_wait</text>
<line class="ld" x1="10" y1="100" x2="710" y2="100"/>
<text class="ts" x="20" y="94">用户态</text>
<text class="ts" x="20" y="116">内核态</text>
<line class="l" x1="170" y1="70" x2="170" y2="158" marker-end="url(#arr)"/>
<text class="ts" x="178" y="88">① epoll_ctl(ADD)</text>
<text class="ts" x="40" y="146">红黑树 rbr：所有监听的 fd</text>
<circle class="b2" cx="170" cy="176" r="16"/>
<text class="tm" x="170" y="176" text-anchor="middle" dominant-baseline="middle">fd5</text>
<line class="l" x1="160" y1="189" x2="120" y2="209"/>
<line class="l" x1="180" y1="189" x2="220" y2="209"/>
<circle class="b2" cx="110" cy="220" r="16"/>
<text class="tm" x="110" y="220" text-anchor="middle" dominant-baseline="middle">fd2</text>
<circle class="b2" cx="230" cy="220" r="16"/>
<text class="tm" x="230" y="220" text-anchor="middle" dominant-baseline="middle">fd9</text>
<line class="l" x1="102" y1="234" x2="88" y2="250"/>
<line class="l" x1="118" y1="234" x2="132" y2="250"/>
<line class="l" x1="238" y1="234" x2="252" y2="250"/>
<circle class="b2" cx="80" cy="262" r="16"/>
<text class="tm" x="80" y="262" text-anchor="middle" dominant-baseline="middle">fd1</text>
<circle class="b2" cx="140" cy="262" r="16"/>
<text class="tm" x="140" y="262" text-anchor="middle" dominant-baseline="middle">fd3</text>
<circle class="b2" cx="260" cy="262" r="16"/>
<text class="tm" x="260" y="262" text-anchor="middle" dominant-baseline="middle">fd12</text>
<text class="ts" x="400" y="146">就绪链表 rdllist</text>
<rect class="b3" x="400" y="160" width="70" height="32" rx="6"/>
<text class="tm" x="435" y="176" text-anchor="middle" dominant-baseline="middle">fd3</text>
<line class="l" x1="470" y1="176" x2="498" y2="176" marker-end="url(#arr)"/>
<rect class="b3" x="500" y="160" width="70" height="32" rx="6"/>
<text class="tm" x="535" y="176" text-anchor="middle" dominant-baseline="middle">fd9</text>
<line class="l" x1="570" y1="176" x2="598" y2="176" marker-end="url(#arr)"/>
<rect class="b3" x="600" y="160" width="70" height="32" rx="6"/>
<text class="tm" x="635" y="176" text-anchor="middle" dominant-baseline="middle">fd12</text>
<line class="la" x1="550" y1="158" x2="550" y2="72" marker-end="url(#arr-a)"/>
<text class="ts" x="558" y="88">④ 返回就绪事件</text>
<rect class="b4" x="400" y="232" width="300" height="40" rx="8"/>
<text class="tb" x="550" y="252" text-anchor="middle" dominant-baseline="middle">数据到达 → 协议栈 → ep_poll_callback</text>
<line class="l" x1="550" y1="232" x2="550" y2="194" marker-end="url(#arr)"/>
<text class="ts" x="558" y="216">③ 把 fd 加入就绪链表</text>
<text class="ts" x="20" y="300">② epoll_ctl 时为每个 fd 在其 socket 等待队列上挂好回调 ep_poll_callback，之后无需再遍历</text>
</svg>
<figcaption>图 2：epoll 的红黑树 + 就绪链表，事件驱动而非轮询</figcaption>
</figure>

三个系统调用：

- `epoll_create`：创建 eventpoll 对象，包含红黑树根 `rbr`、就绪链表 `rdllist`、等待队列。
- `epoll_ctl(ADD/MOD/DEL)`：把 fd 包装成 `epitem` 插入红黑树（O(log n)），并在 socket 的等待队列上注册回调。
- `epoll_wait`：若就绪链表为空就睡眠；非空则把就绪事件拷贝到用户提供的数组返回。

> [!WARNING] 「epoll 用 mmap 共享内存避免拷贝」是错误说法
> `epoll_wait` 通过 `copy_to_user` 把就绪事件拷贝给用户态，拷贝的只是就绪事件，量很小。epoll 快的原因是**注册一次 + 回调入链 + 只返回就绪 fd**。

### LT 与 ET

| | 水平触发 LT | 边缘触发 ET |
| --- | --- | --- |
| 通知时机 | 只要缓冲区有数据，每次 `epoll_wait` 都通知 | 只在状态变化（新数据到达）时通知一次 |
| 读写要求 | 可以一次读一部分 | 必须循环读到 `EAGAIN`，否则剩余数据不会再通知；fd 必须非阻塞 |
| 优缺点 | 编程简单，不易丢事件；通知次数多 | 系统调用更少；编程易出错 |
| 使用者 | JDK NIO `EPollSelectorImpl` | Netty 原生 `EpollEventLoop` 默认 ET；Nginx 使用 ET |

Netty 提供 `EpollEventLoopGroup` / `EpollSocketChannel`（JNI 原生传输），相比 JDK NIO 产生更少的垃圾、支持 ET 和更多 socket 选项（如 `SO_REUSEPORT`、`TCP_FASTOPEN`）。生产 Linux 上常见写法是 `Epoll.isAvailable()` 时使用原生传输，否则回退 NIO。

## Reactor 线程模型

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="单 Reactor 单线程、单 Reactor 多线程、主从 Reactor 三种线程模型对比">
<rect class="bg" x="10" y="10" width="230" height="280" rx="10"/>
<text class="th" x="125" y="34" text-anchor="middle">单 Reactor 单线程</text>
<rect class="b1" x="25" y="50" width="200" height="48" rx="8"/>
<text class="tb" x="125" y="68" text-anchor="middle" dominant-baseline="middle">Reactor</text>
<text class="ts" x="125" y="88" text-anchor="middle">select + dispatch</text>
<line class="l" x1="125" y1="98" x2="125" y2="122" marker-end="url(#arr)"/>
<rect class="b" x="25" y="124" width="200" height="48" rx="8"/>
<text class="tb" x="125" y="142" text-anchor="middle" dominant-baseline="middle">Acceptor / Handler</text>
<text class="ts" x="125" y="162" text-anchor="middle">建连、read、send</text>
<line class="l" x1="125" y1="172" x2="125" y2="196" marker-end="url(#arr)"/>
<rect class="b3" x="25" y="198" width="200" height="48" rx="8"/>
<text class="tb" x="125" y="216" text-anchor="middle" dominant-baseline="middle">业务处理</text>
<text class="ts" x="125" y="236" text-anchor="middle">仍在同一个线程</text>
<text class="ts" x="125" y="272" text-anchor="middle">一个线程做所有事，不能有阻塞</text>
<rect class="bg" x="255" y="10" width="230" height="280" rx="10"/>
<text class="th" x="370" y="34" text-anchor="middle">单 Reactor 多线程</text>
<rect class="b1" x="270" y="50" width="200" height="48" rx="8"/>
<text class="tb" x="370" y="68" text-anchor="middle" dominant-baseline="middle">Reactor</text>
<text class="ts" x="370" y="88" text-anchor="middle">select + dispatch</text>
<line class="l" x1="370" y1="98" x2="370" y2="122" marker-end="url(#arr)"/>
<rect class="b" x="270" y="124" width="200" height="48" rx="8"/>
<text class="tb" x="370" y="142" text-anchor="middle" dominant-baseline="middle">Acceptor / Handler</text>
<text class="ts" x="370" y="162" text-anchor="middle">建连、read、decode、send</text>
<line class="la" x1="370" y1="172" x2="370" y2="196" marker-end="url(#arr-a)"/>
<rect class="b2" x="270" y="198" width="200" height="48" rx="8"/>
<text class="tb" x="370" y="216" text-anchor="middle" dominant-baseline="middle">Worker 线程池</text>
<text class="ts" x="370" y="236" text-anchor="middle">业务计算</text>
<text class="ts" x="370" y="272" text-anchor="middle">Reactor 自身仍是单点瓶颈</text>
<rect class="bg" x="500" y="10" width="230" height="280" rx="10"/>
<text class="th" x="615" y="34" text-anchor="middle">主从 Reactor</text>
<rect class="b1" x="515" y="50" width="200" height="48" rx="8"/>
<text class="tb" x="615" y="68" text-anchor="middle" dominant-baseline="middle">MainReactor</text>
<text class="ts" x="615" y="88" text-anchor="middle">只负责 accept</text>
<line class="la" x1="615" y1="98" x2="615" y2="122" marker-end="url(#arr-a)"/>
<rect class="b5" x="515" y="124" width="200" height="48" rx="8"/>
<text class="tb" x="615" y="142" text-anchor="middle" dominant-baseline="middle">SubReactor × N</text>
<text class="ts" x="615" y="162" text-anchor="middle">各自 select，read / send</text>
<line class="l" x1="615" y1="172" x2="615" y2="196" marker-end="url(#arr)"/>
<rect class="b2" x="515" y="198" width="200" height="48" rx="8"/>
<text class="tb" x="615" y="216" text-anchor="middle" dominant-baseline="middle">业务线程池</text>
<text class="ts" x="615" y="236" text-anchor="middle">可选，承接阻塞逻辑</text>
<text class="ts" x="615" y="272" text-anchor="middle">Netty / Nginx / Tomcat NIO</text>
</svg>
<figcaption>图 3：三种 Reactor 模型，Netty 默认是主从 Reactor</figcaption>
</figure>

- **单 Reactor 单线程**：Redis 6 之前的命令处理就是这种模型，前提是每个操作都极快。
- **单 Reactor 多线程**：IO 在 Reactor 线程，业务交给线程池；海量连接时 Reactor 一个线程处理所有 IO 事件成为瓶颈。
- **主从 Reactor**：accept 与 IO 分离，IO 线程数可按 CPU 扩展。Tomcat NIO 的 Acceptor + Poller + Worker 线程池也是这一思路。

## Netty 架构

<figure class="fig">
<svg viewBox="0 0 740 335" class="dg" role="img" aria-label="Netty 架构：BossGroup 接收连接后注册到 WorkerGroup 的某个 EventLoop，每个 Channel 有一条 ChannelPipeline，入站从 Head 到 Tail，出站从 Tail 到 Head">
<rect class="bg" x="20" y="20" width="220" height="130" rx="10"/>
<text class="ts" x="34" y="40">BossGroup（通常 1 个线程）</text>
<rect class="b1" x="40" y="60" width="180" height="56" rx="8"/>
<text class="tb" x="130" y="80" text-anchor="middle" dominant-baseline="middle">NioEventLoop</text>
<text class="ts" x="130" y="102" text-anchor="middle">监听 OP_ACCEPT</text>
<line class="la" x1="240" y1="88" x2="278" y2="88" marker-end="url(#arr-a)"/>
<text class="ts" x="259" y="80" text-anchor="middle">注册</text>
<rect class="bg" x="280" y="20" width="440" height="130" rx="10"/>
<text class="ts" x="294" y="40">WorkerGroup（默认 CPU 核数 × 2 个 EventLoop）</text>
<rect class="b5" x="295" y="60" width="130" height="56" rx="8"/>
<text class="tb" x="360" y="80" text-anchor="middle" dominant-baseline="middle">EventLoop-1</text>
<text class="ts" x="360" y="102" text-anchor="middle">OP_READ / WRITE</text>
<rect class="b5" x="435" y="60" width="130" height="56" rx="8"/>
<text class="tb" x="500" y="80" text-anchor="middle" dominant-baseline="middle">EventLoop-2</text>
<text class="ts" x="500" y="102" text-anchor="middle">1 线程 : N Channel</text>
<rect class="b5" x="575" y="60" width="130" height="56" rx="8"/>
<text class="tb" x="640" y="80" text-anchor="middle" dominant-baseline="middle">EventLoop-N</text>
<text class="ts" x="640" y="102" text-anchor="middle">Selector + 任务队列</text>
<line class="ld" x1="360" y1="116" x2="360" y2="180"/>
<text class="ts" x="368" y="140">Channel 终身绑定一个 EventLoop</text>
<rect class="bg" x="20" y="180" width="700" height="148" rx="10"/>
<text class="ts" x="34" y="198">每个 Channel 一条 ChannelPipeline（ChannelHandlerContext 双向链表）</text>
<line class="la" x1="40" y1="222" x2="700" y2="222" marker-end="url(#arr-a)"/>
<text class="ts" x="370" y="216" text-anchor="middle">入站事件 read：Head → Tail</text>
<rect class="b" x="40" y="240" width="90" height="40" rx="6"/>
<text class="tb" x="85" y="260" text-anchor="middle" dominant-baseline="middle">Head</text>
<line class="l" x1="130" y1="260" x2="160" y2="260"/>
<rect class="b2" x="160" y="240" width="130" height="40" rx="6"/>
<text class="tb" x="225" y="260" text-anchor="middle" dominant-baseline="middle">Decoder（入站）</text>
<line class="l" x1="290" y1="260" x2="320" y2="260"/>
<rect class="b2" x="320" y="240" width="150" height="40" rx="6"/>
<text class="tb" x="395" y="260" text-anchor="middle" dominant-baseline="middle">业务 Handler（入站）</text>
<line class="l" x1="470" y1="260" x2="500" y2="260"/>
<rect class="b3" x="500" y="240" width="130" height="40" rx="6"/>
<text class="tb" x="565" y="260" text-anchor="middle" dominant-baseline="middle">Encoder（出站）</text>
<line class="l" x1="630" y1="260" x2="650" y2="260"/>
<rect class="b" x="650" y="240" width="56" height="40" rx="6"/>
<text class="tb" x="678" y="260" text-anchor="middle" dominant-baseline="middle">Tail</text>
<line class="l" x1="700" y1="298" x2="40" y2="298" marker-end="url(#arr)"/>
<text class="ts" x="370" y="318" text-anchor="middle">出站操作 write：从当前位置向 Head 方向传播，最终由 Head 调用底层 Unsafe 写出</text>
</svg>
<figcaption>图 4：Netty 主从 Reactor 与 ChannelPipeline 中事件的传播方向</figcaption>
</figure>

### 核心组件

| 组件 | 职责 | 要点 |
| --- | --- | --- |
| `EventLoopGroup` | 一组 EventLoop | 默认线程数 `CPU 核数 × 2`（`io.netty.eventLoopThreads` 可改） |
| `EventLoop` | 单线程执行器 | 循环：`select` → 处理就绪 IO 事件 → 执行任务队列；`ioRatio` 默认 50 控制 IO 与任务的时间比例 |
| `Channel` | 连接的抽象 | 注册到一个 EventLoop 后不再变化；所有 IO 都在该线程执行 |
| `ChannelPipeline` | Handler 责任链 | 入站从 Head 到 Tail，出站从当前 Handler 向 Head |
| `ChannelHandler` | 编解码、业务处理 | `@Sharable` 才能被多个 Channel 共享，有状态 Handler 每个连接 new 一个 |
| `ChannelHandlerContext` | Handler 在链上的节点 | `ctx.write()` 从当前节点向前传播；`ctx.channel().write()` 从 Tail 开始传播 |
| `ChannelFuture` | 异步结果 | 不要在 EventLoop 中调用 `sync()`/`await()`，会死锁或报 `BlockingOperationException` |

```java
// Netty 4.1 服务端骨架
EventLoopGroup boss = new NioEventLoopGroup(1);
EventLoopGroup worker = new NioEventLoopGroup();          // 默认 CPU*2
EventExecutorGroup bizGroup = new DefaultEventExecutorGroup(64); // 业务线程，隔离阻塞逻辑
new ServerBootstrap()
    .group(boss, worker)
    .channel(NioServerSocketChannel.class)
    .option(ChannelOption.SO_BACKLOG, 1024)                // accept 队列，仍受 somaxconn 限制
    .childOption(ChannelOption.TCP_NODELAY, true)
    .childOption(ChannelOption.WRITE_BUFFER_WATER_MARK,
                 new WriteBufferWaterMark(32 * 1024, 64 * 1024))
    .childHandler(new ChannelInitializer<SocketChannel>() {
        @Override
        protected void initChannel(SocketChannel ch) {
            ch.pipeline()
              .addLast(new IdleStateHandler(60, 0, 0, TimeUnit.SECONDS))
              .addLast(new LengthFieldBasedFrameDecoder(1 << 20, 4, 4, 0, 0))
              .addLast(new MyDecoder(), new MyEncoder())
              .addLast(bizGroup, "biz", new BizHandler());  // 业务 Handler 在独立线程池执行
        }
    })
    .bind(8080).sync();
```

### Netty 对 JDK NIO 做的改进

- 用数组实现的 `SelectedSelectionKeySet` 通过反射替换 JDK Selector 内部的 `HashSet`，遍历就绪 key 更快。
- 规避 JDK epoll **空轮询 bug**（`select` 无事件立即返回导致 CPU 100%）：统计连续空轮询次数，超过阈值（默认 512）就重建 Selector。
- 统一的异步 Future/Promise 模型、Pipeline 责任链、丰富的编解码器、内存池。

## ByteBuf

### 读写指针

```text
+-------------------+------------------+------------------+
| discardable bytes |  readable bytes  |  writable bytes  |
|  （已读，可丢弃）  |    （待读）       |   （可写空间）    |
+-------------------+------------------+------------------+
0      <=      readerIndex   <=   writerIndex    <=    capacity
```

相比 `java.nio.ByteBuffer`：读写两个独立指针，不需要 `flip()`；容量可自动扩容（到 `maxCapacity`）；支持池化与引用计数。`discardReadBytes()` 会搬移内存，不要频繁调用。

### 池化与直接内存

- Netty 4.1 的 `ByteBufAllocator.DEFAULT` 默认是 `PooledByteBufAllocator`，IO 场景优先分配**直接内存**（写 socket 时少一次堆到堆外的拷贝）。
- 内存池借鉴 jemalloc：多个 `PoolArena`（默认与 CPU 核数相关，降低竞争）→ `PoolChunk` → `Page` / `Subpage`，并有线程本地缓存 `PoolThreadCache`。
- 直接内存不在堆上，上限由 `-XX:MaxDirectMemorySize` 或 `io.netty.maxDirectMemory` 控制，泄漏时报 `OutOfDirectMemoryError`，堆 dump 里看不出问题，进程 RSS 却不断上涨。

### 引用计数与泄漏检测

`ByteBuf` 实现 `ReferenceCounted`，创建时 refCnt=1，`retain()` +1、`release()` −1，降为 0 时归还内存池。**规则：谁最后消费，谁负责 release。**

```java
// 入站 Handler：要么传给下一个 Handler（交出所有权），要么自己释放
@Override
public void channelRead(ChannelHandlerContext ctx, Object msg) {
    ByteBuf buf = (ByteBuf) msg;
    try {
        if (!accept(buf)) {
            return;                       // 不往后传，就必须在 finally 中释放
        }
        ctx.fireChannelRead(buf.retain()); // 往后传前 retain，抵消下面的 release
    } finally {
        ReferenceCountUtil.release(buf);
    }
}
// 更简单：继承 SimpleChannelInboundHandler<T>，channelRead0 返回后自动 release
```

泄漏检测级别 `-Dio.netty.leakDetection.level=`：`DISABLED` / `SIMPLE`（默认，约 1% 采样）/ `ADVANCED`（采样并记录访问轨迹）/ `PARANOID`（全量，仅测试用）。日志中出现 `LEAK: ByteBuf.release() was not called before it's garbage-collected` 时，在测试环境开 `ADVANCED` 或 `PARANOID` 拿到最后访问位置。

### 零拷贝

Netty 的「零拷贝」包含两层：

| 手段 | 作用 |
| --- | --- |
| `CompositeByteBuf` | 把多个 ByteBuf 逻辑组合成一个（如 header + body），不复制数据 |
| `slice()` / `duplicate()` | 共享底层内存的视图，只是独立的读写指针（注意引用计数共享） |
| `Unpooled.wrappedBuffer(byte[])` | 包装已有数组，不复制 |
| `FileRegion`（`DefaultFileRegion`） | 底层用 `FileChannel.transferTo`，即操作系统 `sendfile`，文件直接从页缓存发往 socket |
| 直接内存 | 避免 JVM 堆与内核之间多一次拷贝 |

## TCP 粘包与拆包

TCP 是**字节流**，没有消息边界。发送端两次 write 可能被合并成一个段（Nagle、发送缓冲区），一次 write 的大消息也可能被拆成多个段（MSS），接收端一次 read 可能读到半个或一个半消息。UDP 有消息边界，不存在这个问题。

| 方案 | Netty 解码器 | 适用 |
| --- | --- | --- |
| 固定长度 | `FixedLengthFrameDecoder` | 定长报文 |
| 分隔符 | `LineBasedFrameDecoder`、`DelimiterBasedFrameDecoder` | 文本协议（如 Redis RESP 按 `\r\n`） |
| 长度字段 | `LengthFieldBasedFrameDecoder` | **二进制 RPC 协议的标准做法**（Dubbo、自定义协议） |

以协议「魔数 2B + 版本 1B + 类型 1B + 包体长度 4B + 包体」为例：

```java
// 长度字段从第 4 字节开始，占 4 字节，值仅表示 body 长度
new LengthFieldBasedFrameDecoder(
        1024 * 1024, // maxFrameLength：必须设上限，防止恶意大长度把内存撑爆
        4,           // lengthFieldOffset：长度字段前面有 2+1+1 字节
        4,           // lengthFieldLength
        0,           // lengthAdjustment：长度值之后到 body 之间的额外字节数（长度含 header 时为负数）
        0);          // initialBytesToStrip：保留 header 交给后续解码器
```

自定义解码器继承 `ByteToMessageDecoder` 时，数据不足要 `return` 等下次（它内部有累积缓冲区 cumulation），并且**不要在 decode 里 release 输入 buf**。

## 心跳与空闲检测

```java
// 客户端：30s 没写过数据就发心跳
pipeline.addLast(new IdleStateHandler(0, 30, 0, TimeUnit.SECONDS));
// 服务端：90s 没读到数据（约 3 个心跳周期）认为连接已死
pipeline.addLast(new IdleStateHandler(90, 0, 0, TimeUnit.SECONDS));

@Override
public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
    if (evt instanceof IdleStateEvent e && e.state() == IdleState.READER_IDLE) {
        ctx.close();                          // 回收半开连接
    } else {
        super.userEventTriggered(ctx, evt);
    }
}
```

为什么不靠 TCP keepalive：默认 2 小时才探测，且只能确认对端内核活着，不能确认对端应用能处理请求；中间的 NAT / LB 可能早已把空闲连接从表里删掉（见 [TCP/IP 与 HTTP(S)](#/infra/network)）。

## 不要阻塞 EventLoop

一个 EventLoop 线程上挂着成百上千个 Channel，在 Handler 里执行一次 200ms 的 DB 查询，这个线程上的所有连接就都被延迟 200ms，心跳超时、请求堆积连锁发生。

- 阻塞或耗时逻辑放到业务线程池：`pipeline.addLast(bizGroup, handler)`，或在 Handler 里 `executor.execute(...)`，完成后 `ctx.writeAndFlush()`（Netty 会把非 EventLoop 线程的写操作封装为任务投递回 EventLoop，线程安全）。
- 不要在 EventLoop 中调用 `future.sync()`、`Thread.sleep`、`synchronized` 长等待、`CompletableFuture.join`。
- WebFlux / Gateway 中同理：在 Reactor Netty 的 `reactor-http-nio-*` 线程上调 JDBC、`block()` 会让吞吐断崖下降，用 `publishOn(Schedulers.boundedElastic())` 隔离。
- **写缓冲背压**：对端读得慢时出站数据会堆积在 `ChannelOutboundBuffer`，持续写会撑爆直接内存。写之前检查 `channel.isWritable()`，并在 `channelWritabilityChanged` 中暂停 / 恢复生产（高低水位默认 64KB / 32KB）。

## Netty 在主流框架中的应用

| 框架 | 角色 | 值得知道的点 |
| --- | --- | --- |
| Dubbo | 默认通信层 `netty4` | IO 线程只做编解码，请求派发到业务线程池（默认固定 200 线程）；`Thread pool is EXHAUSTED` 说明业务线程池满，而不是 IO 线程 |
| gRPC-Java | `grpc-netty` / `grpc-netty-shaded` 传输 | HTTP/2 帧在 Netty 中编解码，业务回调默认在 gRPC 的 executor 中执行，可替换为自定义线程池 |
| Spring WebFlux | 默认运行在 Reactor Netty 上 | 事件循环线程数默认约为 CPU 核数（最少 4），全链路必须非阻塞 |
| Spring Cloud Gateway | 基于 WebFlux + Reactor Netty | 下游连接池 `spring.cloud.gateway.httpclient.pool.*`，过滤器中禁止阻塞调用（见 [Spring Cloud 微服务全景](#/spring/cloud)） |
| 其他 | Lettuce（Redis 客户端）、RocketMQ remoting、Elasticsearch 节点通信 | 都是同一套 EventLoop 模型 |

## 生产实践与踩坑

1. **直接内存泄漏**：RSS 持续上涨但堆正常，日志有 LEAK 警告。原因多是自定义 Handler 吞掉消息没 release，或 `retain` 多次。开启 `ADVANCED` 级别复现，用 `PooledByteBufAllocator.DEFAULT.metric()` 暴露池使用量做监控。
2. **EventLoop 被阻塞**：表现为 RT 毛刺、心跳超时断连。`jstack` 看 `nioEventLoopGroup-*` / `reactor-http-nio-*` 线程栈里是否有 JDBC、`SocketInputStream.read`、`LockSupport.park`。
3. **只在测试里正常的粘包问题**：本地网络好，一次 read 刚好一个包；线上大包、高并发就出现解析错乱。永远使用帧解码器。
4. **`LengthFieldBasedFrameDecoder` 未设合理 maxFrameLength**：恶意或错误的长度字段导致分配巨大内存，应设置上限并在超限时关闭连接。
5. **容器中 EventLoop 线程过多**：老版本 JDK 在容器里拿到宿主机核数，`CPU*2` 个线程远超配额，造成上下文切换与 CPU throttling。用新版 JDK 或显式设置 `-XX:ActiveProcessorCount`、`io.netty.eventLoopThreads`（见 [Docker 容器化](#/infra/docker)）。
6. **`ctx.write` 与 `ctx.channel().write` 混用**：前者从当前 Handler 往 Head 走，跳过了位于其后的出站 Handler（如 Encoder 在业务 Handler 之后添加时就会漏编码）。

## 相关阅读

- [TCP 深入与 UDP/QUIC：重传、保活、RST 与内核调优](#/cs/net-tcp)：TCP_NODELAY 与保活
- [文件系统、页缓存与零拷贝](#/cs/os-io)：零拷贝与页缓存

## 面试追问

> [!QUESTION] epoll 为什么比 select 高效？ET 模式下要注意什么？
> select 每次调用都要拷贝整个 fd 集合并线性扫描，且 fd 数受 1024 限制；epoll 通过 `epoll_ctl` 一次注册到红黑树，内核在数据到达时通过回调把 fd 放进就绪链表，`epoll_wait` 只处理就绪 fd，代价与就绪数成正比而非总连接数。ET 只在状态变化时通知一次，必须使用非阻塞 fd 并循环读写到 `EAGAIN`，否则残留数据不会再被通知。

> [!QUESTION] Netty 的线程模型是怎样的？一个 Channel 的事件会被多个线程处理吗？
> 主从 Reactor：BossGroup accept 后把 Channel 按轮询注册到 WorkerGroup 的某个 EventLoop，Channel 生命周期内所有 IO 事件和 Handler 回调都在这一个线程执行（除非 Handler 绑定了独立的 EventExecutorGroup），因此同一 Channel 内无需加锁，事件天然有序。其他线程发起的 write 会被封装成任务投递到该 EventLoop 的队列。

> [!QUESTION] ByteBuf 什么时候需要 release？SimpleChannelInboundHandler 做了什么？
> 引用计数对象由最后一个使用者释放：入站消息如果不再 `fireChannelRead` 传递，就要自己 release；传递下去则所有权转移。`SimpleChannelInboundHandler` 在 `channelRead0` 执行完后自动 `ReferenceCountUtil.release(msg)`，所以若要异步使用该消息必须先 `retain()`。出站 `write` 的 ByteBuf 由 Netty 在写出后释放。

> [!QUESTION] 什么是粘包拆包？LengthFieldBasedFrameDecoder 的几个参数怎么理解？
> TCP 是无边界字节流，应用层消息可能被合并或拆分。长度字段解码器先按 `lengthFieldOffset` 和 `lengthFieldLength` 读出长度值，帧总长 = offset + lengthFieldLength + 长度值 + `lengthAdjustment`（长度值包含 header 时为负），不够就等待更多数据；`initialBytesToStrip` 决定交给下游前剥掉多少字节；`maxFrameLength` 防止异常长度。

> [!QUESTION] Netty 所说的零拷贝和操作系统的零拷贝是一回事吗？
> 不完全是。OS 层零拷贝指 `sendfile` / `mmap` 减少内核态与用户态之间的拷贝，Netty 通过 `FileRegion` 利用了它；Netty 还有用户态层面的「零拷贝」，即 `CompositeByteBuf`、`slice`、`wrap` 避免 JVM 内部的内存复制，以及用直接内存避免堆到堆外的拷贝。

> [!QUESTION] 在 WebFlux 里调用了一个阻塞的 JDBC 接口，会发生什么？怎么改？
> 阻塞发生在 Reactor Netty 的事件循环线程上，而这类线程只有约 CPU 核数个，几个慢查询就能让所有请求排队，吞吐远低于 Spring MVC。改法：用 R2DBC 等响应式驱动；或者把阻塞调用包在 `Mono.fromCallable(...).subscribeOn(Schedulers.boundedElastic())` 中隔离；如果整个链路大都是阻塞依赖，直接用 Spring MVC（或 MVC + 虚拟线程）更合适。
