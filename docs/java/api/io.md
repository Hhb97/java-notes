---
level: 深入
tags: [IO, NIO, ByteBuffer, DirectBuffer, 零拷贝, mmap, sendfile]
summary: 梳理 BIO/NIO/AIO 模型与 Buffer 状态机，剖析堆外内存的分配与回收、Direct buffer OOM，以及 mmap、sendfile 零拷贝的拷贝次数与适用场景
---

# IO / NIO 与零拷贝

> [!ABSTRACT] 核心要点
> - BIO 一连接一线程、阻塞读写；NIO 基于 `Channel + Buffer + Selector`，一个线程用 epoll 管理大量连接；Java 的 AIO 在 Linux 上是用 epoll + 线程池模拟的，并非内核异步 IO，所以 Netty 没有采用。
> - `Buffer` 的核心是 `0 ≤ mark ≤ position ≤ limit ≤ capacity`：写完 `flip()` 切换为读，读完 `clear()` / `compact()` 切回写。
> - 堆内 `HeapByteBuffer` 做 IO 时，JDK 会先拷贝到一块**临时 DirectBuffer**；`DirectByteBuffer` 由 `Unsafe.allocateMemory` 分配，靠 `Cleaner`（虚引用）在 GC 后释放，受 `-XX:MaxDirectMemorySize` 限制，超限抛 `OutOfMemoryError: Direct buffer memory`。
> - 传统 `read + write`：4 次拷贝（2 DMA + 2 CPU）、4 次上下文切换；`mmap + write`：3 次拷贝、4 次切换；`sendfile`（`FileChannel.transferTo`）配合网卡 SG-DMA：2 次拷贝（全是 DMA）、2 次切换。
> - 所有文件 IO 都经过 **page cache**；零拷贝的「零」指的是零次 CPU 拷贝，前提是数据不需要在用户态加工（比如 TLS 加密会破坏零拷贝）。

## IO 模型：BIO / NIO / AIO

| 模型 | Java API | 线程模型 | 底层（Linux） | 适用场景 |
| --- | --- | --- | --- | --- |
| BIO | `InputStream`/`OutputStream`、`ServerSocket` | 一连接一线程，`read` 阻塞 | 阻塞 `read/write` 系统调用 | 连接数少、实现简单；JDK 21 虚拟线程下重新可行 |
| NIO | `Channel`、`Buffer`、`Selector` | 少量线程 + 多路复用，非阻塞读写 | `epoll_create/epoll_ctl/epoll_wait` | 高并发长连接（Netty、Tomcat NIO Connector） |
| AIO（NIO.2） | `AsynchronousSocketChannel`、`CompletionHandler` | 回调，由线程池执行 | **epoll + 线程池模拟**（`LinuxAsynchronousChannelProvider`） | Windows 上基于 IOCP 是真异步；Linux 上收益不大 |

- 「阻塞/非阻塞」说的是**数据未就绪时调用是否立即返回**；「同步/异步」说的是**数据从内核拷贝到用户空间这一步由谁完成**。NIO 是同步非阻塞（拷贝仍由调用线程完成），AIO 是异步。
- JDK 13（JEP 353）用 `NioSocketImpl` 重写了旧的 `Socket/ServerSocket` 实现；JDK 21 的虚拟线程（JEP 444）在阻塞式 Socket 调用时会把虚拟线程挂起、底层交给 NIO poller，从而让 BIO 写法也能支撑大量连接。
- Selector 底层：Linux 上是 `EPollSelectorImpl`，`select()` 对应 `epoll_wait`，注册/修改兴趣集对应 `epoll_ctl`。epoll 的红黑树 + 就绪链表、水平触发与边缘触发、JDK 的 epoll 空轮询 bug 以及 Netty 的处理方式见 [IO 模型与 Netty](#/infra/netty)。

## Buffer：position / limit / capacity

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="ByteBuffer 在 put 5 字节、flip、get 3 字节后 position、limit、capacity 的位置变化">
<text class="tb" x="20" y="48">put 5 字节后</text>
<rect class="b1" x="150" y="30" width="50" height="36"/>
<rect class="b1" x="200" y="30" width="50" height="36"/>
<rect class="b1" x="250" y="30" width="50" height="36"/>
<rect class="b1" x="300" y="30" width="50" height="36"/>
<rect class="b1" x="350" y="30" width="50" height="36"/>
<rect class="b" x="400" y="30" width="50" height="36"/>
<rect class="b" x="450" y="30" width="50" height="36"/>
<rect class="b" x="500" y="30" width="50" height="36"/>
<rect class="b" x="550" y="30" width="50" height="36"/>
<rect class="b" x="600" y="30" width="50" height="36"/>
<line class="la" x1="400" y1="100" x2="400" y2="70" marker-end="url(#arr-a)"/>
<text class="ta" x="400" y="114" text-anchor="middle">position=5</text>
<line class="l" x1="650" y1="100" x2="650" y2="70" marker-end="url(#arr)"/>
<text class="ts" x="650" y="114" text-anchor="middle">limit=capacity=10</text>
<text class="ts" x="670" y="52">写模式</text>
<text class="tb" x="20" y="148">flip() 后</text>
<rect class="b1" x="150" y="130" width="50" height="36"/>
<rect class="b1" x="200" y="130" width="50" height="36"/>
<rect class="b1" x="250" y="130" width="50" height="36"/>
<rect class="b1" x="300" y="130" width="50" height="36"/>
<rect class="b1" x="350" y="130" width="50" height="36"/>
<rect class="b" x="400" y="130" width="50" height="36"/>
<rect class="b" x="450" y="130" width="50" height="36"/>
<rect class="b" x="500" y="130" width="50" height="36"/>
<rect class="b" x="550" y="130" width="50" height="36"/>
<rect class="b" x="600" y="130" width="50" height="36"/>
<line class="la" x1="150" y1="200" x2="150" y2="170" marker-end="url(#arr-a)"/>
<text class="ta" x="150" y="214" text-anchor="middle">position=0</text>
<line class="l" x1="400" y1="200" x2="400" y2="170" marker-end="url(#arr)"/>
<text class="t" x="400" y="214" text-anchor="middle">limit=5</text>
<line class="l" x1="650" y1="200" x2="650" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="650" y="214" text-anchor="middle">capacity=10</text>
<text class="ts" x="670" y="152">读模式</text>
<text class="tb" x="20" y="248">get 3 字节后</text>
<rect class="b" x="150" y="230" width="50" height="36"/>
<rect class="b" x="200" y="230" width="50" height="36"/>
<rect class="b" x="250" y="230" width="50" height="36"/>
<rect class="b1" x="300" y="230" width="50" height="36"/>
<rect class="b1" x="350" y="230" width="50" height="36"/>
<rect class="b" x="400" y="230" width="50" height="36"/>
<rect class="b" x="450" y="230" width="50" height="36"/>
<rect class="b" x="500" y="230" width="50" height="36"/>
<rect class="b" x="550" y="230" width="50" height="36"/>
<rect class="b" x="600" y="230" width="50" height="36"/>
<line class="la" x1="300" y1="300" x2="300" y2="270" marker-end="url(#arr-a)"/>
<text class="ta" x="300" y="314" text-anchor="middle">position=3</text>
<line class="l" x1="400" y1="300" x2="400" y2="270" marker-end="url(#arr)"/>
<text class="t" x="400" y="314" text-anchor="middle">limit=5</text>
<line class="l" x1="650" y1="300" x2="650" y2="270" marker-end="url(#arr)"/>
<text class="ts" x="650" y="314" text-anchor="middle">capacity=10</text>
<text class="ts" x="670" y="252">剩余 2 字节</text>
</svg>
<figcaption>图 1：同一块 10 字节缓冲区在写、flip、读三个阶段的指针（蓝色为有效数据）</figcaption>
</figure>

```java
// JDK 17 java.nio.Buffer（节选）
public Buffer flip()    { limit = position; position = 0; mark = -1; return this; }  // 写 → 读
public Buffer clear()   { position = 0; limit = capacity; mark = -1; return this; }  // 准备重新写（数据未擦除）
public Buffer rewind()  { position = 0; mark = -1; return this; }                    // 重读一遍
// ByteBuffer#compact：把 [position, limit) 的未读数据挪到开头，position = 剩余数，limit = capacity
```

典型读写循环与常见错误：

```java
ByteBuffer buf = ByteBuffer.allocate(8192);
while (channel.read(buf) != -1) {
    buf.flip();                       // ★ 忘记 flip：position 在末尾，什么也读不到 / 写出去是垃圾数据
    while (buf.hasRemaining()) {
        out.write(buf);               // ★ write 不保证一次写完，必须循环
    }
    buf.compact();                    // 半包场景用 compact 保留未消费数据；确认读完才用 clear
}
```

- `duplicate()`、`slice()` 与原 buffer **共享内容**、各自维护指针；`asReadOnlyBuffer()` 只读视图。多线程共享同一个 Buffer 的指针是不安全的。
- `ByteBuffer` 默认**大端序**，与网络字节序一致；和 C 程序/本机结构交互时用 `order(ByteOrder.LITTLE_ENDIAN)`。
- Netty 的 `ByteBuf` 用 `readerIndex/writerIndex` 双指针，读写切换不需要 flip，并支持池化与引用计数，这是它替换 JDK ByteBuffer 的主要原因。

## HeapByteBuffer vs DirectByteBuffer

| 对比 | `ByteBuffer.allocate`（Heap） | `ByteBuffer.allocateDirect`（Direct） |
| --- | --- | --- |
| 内存位置 | Java 堆中的 `byte[]` | 进程本地内存（`malloc`） |
| 分配/释放成本 | 低，GC 管理 | 高（系统调用 + 清零 + 注册 Cleaner），释放依赖 GC 触发 |
| 做 Channel IO 时 | 先拷贝到临时 DirectBuffer 再系统调用 | 直接传地址给系统调用 |
| 受限参数 | `-Xmx` | `-XX:MaxDirectMemorySize`（默认约等于最大堆） |
| 适合 | 短生命周期、频繁创建、需要 `array()` 访问 | 长期复用的大缓冲（网络 IO、池化） |

**为什么堆内存不能直接交给系统调用**：GC 可能移动对象（压缩、复制），而 `read/write` 系统调用执行期间内核要求地址稳定。所以 `sun.nio.ch.IOUtil` 在写堆 buffer 时会：

```java
// JDK sun.nio.ch.IOUtil#write（逻辑节选）
if (src instanceof DirectBuffer) return writeFromNativeBuffer(fd, src, ...);
ByteBuffer bb = Util.getTemporaryDirectBuffer(rem);   // 线程本地缓存的临时 DirectBuffer
bb.put(src); bb.flip();                               // 一次额外的内存拷贝
int n = writeFromNativeBuffer(fd, bb, ...);
Util.offerFirstTemporaryDirectBuffer(bb);             // 归还给线程本地缓存
```

> [!WARNING] 临时 DirectBuffer 缓存导致堆外内存膨胀
> 临时 DirectBuffer 按线程缓存，大小等于这次要写的数据量。如果很多线程用**很大的堆 ByteBuffer**（例如一次写 50 MB）做 IO，每个线程都会缓存一块同样大小的堆外内存，并且不会释放。可以用 `-Djdk.nio.maxCachedBufferSize=262144`（JDK 9 引入，8u102 已回补）限制可缓存的单块大小，或者自己分块写。

### 分配与 Cleaner 回收

```java
// JDK 8 DirectByteBuffer 构造器（节选）
DirectByteBuffer(int cap) {
    Bits.reserveMemory(size, cap);          // 1. 记账：超过 MaxDirectMemorySize 时尝试回收
    long base = unsafe.allocateMemory(size);// 2. malloc
    unsafe.setMemory(base, size, (byte) 0); // 3. 清零
    cleaner = Cleaner.create(this, new Deallocator(base, size, cap));  // 4. 注册虚引用
}

// Bits.reserveMemory 的关键逻辑（JDK 8）
if (tryReserveMemory(size, cap)) return;
jlra.tryHandlePendingReference();           // 先处理已入队的引用（可能释放一些）
System.gc();                                // 触发 GC，让不可达的 DirectByteBuffer 进入引用队列
// 之后以指数退避 sleep 重试若干次（JDK 8 约 9 次），仍失败则
throw new OutOfMemoryError("Direct buffer memory");
```

回收链路：`DirectByteBuffer` 对象不可达 → GC 发现其 `Cleaner`（`PhantomReference`）→ Reference Handler 线程执行 `Deallocator.run()` → `Unsafe.freeMemory`。**堆外内存的释放完全依赖 GC 处理这个小小的 Java 对象**。

### Direct buffer OOM 的典型成因

1. **对象晋升到老年代而没有 Full/Mixed GC**：DirectByteBuffer 对象本身只有几十字节，堆压力很小，迟迟不触发老年代回收，它背后的大块堆外内存就一直不释放。
2. **`-XX:+DisableExplicitGC`**：`reserveMemory` 里的 `System.gc()` 变成空操作，失去了「堆外不够时主动 GC 一下」的自救机会。使用 CMS/G1 时可以改用 `-XX:+ExplicitGCInvokesConcurrent`。
3. **`MaxDirectMemorySize` 设得太小**，或真的存在泄漏（如 Netty `ByteBuf` 未 `release`，Netty 有自己的计数与 `ResourceLeakDetector`）。
4. 容器环境中：堆 + 堆外 + Metaspace + 线程栈 + 代码缓存之和超过容器 limit，进程直接被 OOM Killer 杀掉（没有 Java 异常），需要整体规划内存。

排查手段：

```bash
# 堆外使用量（BufferPoolMXBean：direct / mapped）
jcmd <pid> VM.native_memory summary          # 需启动参数 -XX:NativeMemoryTracking=summary
# 代码中：ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class)
# Arthas：dashboard 中 direct / mapped 一栏
```

> [!TIP] 堆外内存的确定性释放
> JDK 自身没有公开的 `free` API。Netty 通过反射调用 Cleaner 或使用 `Unsafe` 自行管理（并池化复用）。JDK 22 正式发布的 FFM API（JEP 454）提供 `Arena`：`try (Arena arena = Arena.ofConfined()) { MemorySegment seg = arena.allocate(size); }`，作用域结束即释放，这是新代码的推荐方式。

## Page Cache

Linux 下普通文件读写都经过内核的 **page cache**：

- **读**：命中 page cache 直接从内存拷贝；未命中则缺页，从磁盘 DMA 读入，并按顺序访问模式做**预读（readahead）**。
- **写**：`write` 只是把数据拷进 page cache 并标记为脏页就返回，由内核回写线程按 `vm.dirty_background_ratio`、`vm.dirty_ratio`、`vm.dirty_expire_centisecs` 等参数异步刷盘。脏页超过 `dirty_ratio` 时写线程会被阻塞同步刷盘——这是 Kafka/日志类应用写延迟毛刺的常见原因。
- **持久化**：只有 `fsync`（Java 中 `FileChannel.force(true)`、`FileDescriptor.sync()`）才保证落盘；`force(false)` 只刷数据不刷元数据（对应 `fdatasync`）。
- **绕过 page cache**：数据库通常用 `O_DIRECT` 自己管理缓存，JDK 10 起可用 `ExtendedOpenOption.DIRECT` 打开文件，要求缓冲区与读写位置按块大小对齐。
- Kafka 依赖 page cache 而非 JVM 堆缓存消息：重启后缓存仍在、避免 GC 压力，配合顺序读写和零拷贝获得高吞吐，见 [Kafka 架构与存储](#/mw/kafka)。

## 零拷贝

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="read+write、mmap+write、sendfile 加 SG-DMA 三种方式的数据拷贝路径对比">
<text class="t" x="20" y="20">① read + write：4 次拷贝（2 DMA + 2 CPU），4 次上下文切换</text>
<rect class="b" x="20" y="36" width="80" height="36" rx="6"/>
<text class="tb" x="60" y="54" text-anchor="middle" dominant-baseline="middle">磁盘</text>
<rect class="b1" x="150" y="36" width="120" height="36" rx="6"/>
<text class="tb" x="210" y="54" text-anchor="middle" dominant-baseline="middle">Page Cache</text>
<rect class="b3" x="320" y="36" width="110" height="36" rx="6"/>
<text class="tb" x="375" y="54" text-anchor="middle" dominant-baseline="middle">用户缓冲区</text>
<rect class="b1" x="490" y="36" width="120" height="36" rx="6"/>
<text class="tb" x="550" y="54" text-anchor="middle" dominant-baseline="middle">Socket 缓冲区</text>
<rect class="b" x="660" y="36" width="80" height="36" rx="6"/>
<text class="tb" x="700" y="54" text-anchor="middle" dominant-baseline="middle">网卡</text>
<line class="l" x1="100" y1="54" x2="150" y2="54" marker-end="url(#arr)"/>
<text class="ts" x="125" y="88" text-anchor="middle">DMA</text>
<line class="la" x1="270" y1="54" x2="320" y2="54" marker-end="url(#arr-a)"/>
<text class="ta" x="295" y="88" text-anchor="middle">CPU</text>
<line class="la" x1="430" y1="54" x2="490" y2="54" marker-end="url(#arr-a)"/>
<text class="ta" x="460" y="88" text-anchor="middle">CPU</text>
<line class="l" x1="610" y1="54" x2="660" y2="54" marker-end="url(#arr)"/>
<text class="ts" x="635" y="88" text-anchor="middle">DMA</text>
<text class="t" x="20" y="112">② mmap + write：3 次拷贝（2 DMA + 1 CPU），4 次上下文切换</text>
<rect class="b3" x="320" y="122" width="110" height="28" rx="6"/>
<text class="ts" x="375" y="136" text-anchor="middle" dominant-baseline="middle">用户态映射（共享页）</text>
<line class="ld" x1="320" y1="140" x2="270" y2="162"/>
<rect class="b" x="20" y="156" width="80" height="36" rx="6"/>
<text class="tb" x="60" y="174" text-anchor="middle" dominant-baseline="middle">磁盘</text>
<rect class="b1" x="150" y="156" width="120" height="36" rx="6"/>
<text class="tb" x="210" y="174" text-anchor="middle" dominant-baseline="middle">Page Cache</text>
<rect class="b1" x="490" y="156" width="120" height="36" rx="6"/>
<text class="tb" x="550" y="174" text-anchor="middle" dominant-baseline="middle">Socket 缓冲区</text>
<rect class="b" x="660" y="156" width="80" height="36" rx="6"/>
<text class="tb" x="700" y="174" text-anchor="middle" dominant-baseline="middle">网卡</text>
<line class="l" x1="100" y1="174" x2="150" y2="174" marker-end="url(#arr)"/>
<text class="ts" x="125" y="208" text-anchor="middle">DMA</text>
<line class="la" x1="270" y1="182" x2="490" y2="182" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="208" text-anchor="middle">CPU（内核内拷贝）</text>
<line class="l" x1="610" y1="174" x2="660" y2="174" marker-end="url(#arr)"/>
<text class="ts" x="635" y="208" text-anchor="middle">DMA</text>
<text class="t" x="20" y="232">③ sendfile + SG-DMA（transferTo）：2 次拷贝（均为 DMA），2 次上下文切换</text>
<rect class="bg" x="490" y="242" width="120" height="28" rx="6"/>
<text class="ts" x="550" y="256" text-anchor="middle" dominant-baseline="middle">仅追加描述符</text>
<line class="ld" x1="270" y1="282" x2="490" y2="262"/>
<rect class="b" x="20" y="276" width="80" height="36" rx="6"/>
<text class="tb" x="60" y="294" text-anchor="middle" dominant-baseline="middle">磁盘</text>
<rect class="b1" x="150" y="276" width="120" height="36" rx="6"/>
<text class="tb" x="210" y="294" text-anchor="middle" dominant-baseline="middle">Page Cache</text>
<rect class="b" x="660" y="276" width="80" height="36" rx="6"/>
<text class="tb" x="700" y="294" text-anchor="middle" dominant-baseline="middle">网卡</text>
<line class="l" x1="100" y1="294" x2="150" y2="294" marker-end="url(#arr)"/>
<text class="ts" x="125" y="328" text-anchor="middle">DMA</text>
<line class="l" x1="270" y1="302" x2="660" y2="302" marker-end="url(#arr)"/>
<text class="ts" x="465" y="328" text-anchor="middle">DMA gather：网卡直接从 page cache 取数据</text>
<text class="ts" x="20" y="352">DMA = 设备直接搬运，不占 CPU；CPU = 由 CPU 执行 memcpy（内核态与用户态之间，或内核内部）</text>
</svg>
<figcaption>图 2：「文件 → 网络」发送的三种路径，零拷贝的目标是消灭 CPU 拷贝与多余的上下文切换</figcaption>
</figure>

| 方式 | 系统调用 | DMA 拷贝 | CPU 拷贝 | 上下文切换 | Java API |
| --- | --- | --- | --- | --- | --- |
| 传统 | `read` + `write` | 2 | 2 | 4 | `InputStream.read` + `OutputStream.write` |
| mmap | `mmap` + `write` | 2 | 1 | 4 | `FileChannel.map` → `MappedByteBuffer` |
| sendfile | `sendfile` | 2 | 1（page cache → socket buffer） | 2 | `FileChannel.transferTo` |
| sendfile + SG-DMA | `sendfile`（Linux 2.4+，网卡支持 gather） | 2 | 0 | 2 | 同上，由内核与网卡自动决定 |

上下文切换的计数：每个系统调用一次「用户态 → 内核态」加一次「内核态 → 用户态」。传统方式 `read`、`write` 两个调用共 4 次；sendfile 一个调用 2 次。

### FileChannel.transferTo

```java
try (FileChannel file = FileChannel.open(path, StandardOpenOption.READ);
     SocketChannel socket = SocketChannel.open(addr)) {
    long pos = 0, size = file.size();
    while (pos < size) {
        // 单次调用可能只传一部分（Linux sendfile 单次约 2GB 上限、非阻塞 socket 缓冲区满等）
        pos += file.transferTo(pos, size - pos, socket);
    }
}
```

- Linux 上目标为 socket 时使用 `sendfile`；不支持的组合会退化为 mmap 或普通读写拷贝，API 层面透明。
- 使用者：Kafka 消费端拉取日志段（`FileRecords.writeTo` → `transferTo`）；Netty 的 `FileRegion` / `DefaultFileRegion`；Tomcat、Nginx 的静态文件 `sendfile on`。
- **TLS 破坏零拷贝**：数据需要在用户态加密，只能读进 JVM 再写出。Kafka 开启 SSL 后消费吞吐明显下降就是这个原因（Linux 内核 TLS（kTLS）可部分恢复，但 Java 生态支持有限）。
- 需要修改内容（压缩、拼协议头）时也无法完全零拷贝；Netty 用 `CompositeByteBuf` 做「逻辑零拷贝」，避免用户态内部的合并拷贝，这是另一层意义上的零拷贝。

### mmap：MappedByteBuffer

```java
try (FileChannel ch = FileChannel.open(path, READ, WRITE)) {
    MappedByteBuffer mbb = ch.map(FileChannel.MapMode.READ_WRITE, 0, 1 << 30);  // 映射 1GB
    mbb.putLong(0, 42L);       // 直接写内存 = 写 page cache，无系统调用
    mbb.force();               // 刷盘（msync）
}
```

- 优点：读写像访问内存一样，没有 `read/write` 系统调用与用户态拷贝，随机访问友好。RocketMQ 的 CommitLog / ConsumeQueue 基于 mmap 并做了预热（预先写入触发缺页、`mlock` 锁定），见 [RocketMQ 原理与事务消息](#/mw/rocketmq)。
- 缺点与坑：
  - 单个 `MappedByteBuffer` 最大 `Integer.MAX_VALUE`（约 2GB），大文件需分段映射（JDK 22 FFM 的 `FileChannel.map(..., Arena)` 返回 `MemorySegment` 无此限制）；
  - **没有公开的 unmap**：映射在 buffer 被 GC 后才解除，期间文件句柄与虚拟内存都不释放；Windows 下映射中的文件无法删除；
  - 首次访问每个页都会触发**缺页中断**，造成延迟毛刺，需要预热；
  - 读写映射区时若磁盘出错或文件被截断，会收到 `SIGBUS`，JVM 会把它转换为 `InternalError`，严重时进程崩溃；
  - 映射的内存不受 `MaxDirectMemorySize` 限制，但计入进程 RSS，容器环境要计算在内。

## 传统 IO 的工程细节

- **装饰器模式**：`new BufferedReader(new InputStreamReader(new FileInputStream(f), UTF_8))`，`BufferedInputStream`/`BufferedReader` 默认缓冲 8192 字节/字符，减少系统调用次数。
- **字符集**：`FileReader`、`String.getBytes()` 不指定字符集时使用平台默认；JDK 18（JEP 400）起默认字符集统一为 UTF-8，升级时 Windows 上读写 GBK 文件的老代码可能乱码，显式指定 `StandardCharsets`。
- **便捷 API**：`Files.readString/writeString`（JDK 11）、`InputStream.transferTo(OutputStream)`（JDK 9）、`InputStream.readAllBytes`（JDK 9）。`Files.lines()`、`Files.list()`、`Files.walk()` 返回的 Stream 持有文件句柄，**必须用 try-with-resources 关闭**。
- `FileInputStream/FileOutputStream` 在旧版本依赖 `finalize` 兜底关闭，JDK 9 之后改为 Cleaner，但都不能代替显式关闭。

## 生产实践与踩坑

1. **`Too many open files`**：流 / Channel / `Files.lines` 未关闭，或高并发连接超过 `ulimit -n`。`lsof -p <pid> | wc -l` 观察句柄增长，统一 try-with-resources。
2. **`OutOfMemoryError: Direct buffer memory`**：检查 Netty `ByteBuf` 是否泄漏（开启 `-Dio.netty.leakDetection.level=advanced`）、是否禁用了显式 GC、`MaxDirectMemorySize` 是否合理；用 NMT 和 BufferPoolMXBean 观察趋势。
3. **大文件读入内存**：`Files.readAllBytes` 读几个 GB 的文件直接 OOM，改为流式或 `transferTo`。
4. **NIO `write` 没有写完**：非阻塞 Channel 的 `write` 返回实际写入字节数，socket 缓冲区满时可能只写一部分甚至 0，必须保留剩余数据并注册 `OP_WRITE` 等待可写，写完再取消，否则 Selector 空转。
5. **日志/数据文件写入延迟毛刺**：page cache 脏页回写阻塞，调整 `vm.dirty_*` 参数或使用独立磁盘；关键数据定期 `force`。
6. **容器内存被 OOM Killer 杀掉**：堆外（Direct、mmap、Netty 池、线程栈）没有计入规划，`-Xmx` 只能约束堆。
7. **跨平台换行与编码**：日志、CSV 导出在 Windows 与 Linux 间乱码，显式指定 UTF-8 并统一换行符。

## 相关阅读

- [文件系统、页缓存与零拷贝](#/cs/os-io)：页缓存、零拷贝与 fsync 的内核视角
- [IO 模型与 Netty](#/infra/netty)：IO 模型与 Netty

## 面试追问

> [!QUESTION] 什么是零拷贝？Java 中如何实现？
> 指数据传输中不经过 CPU 在用户态与内核态之间来回拷贝。Java 用 `FileChannel.transferTo/transferFrom`（Linux 上为 sendfile，网卡支持 SG-DMA 时 CPU 拷贝为 0，只有 2 次 DMA、2 次上下文切换）和 `FileChannel.map`（mmap，省掉内核到用户态的拷贝）。Kafka 消费、Netty FileRegion、RocketMQ CommitLog 都用到了它们。

> [!QUESTION] 为什么堆内 ByteBuffer 做 IO 要额外拷贝一次？
> GC 可能移动堆中的对象，而系统调用期间要求内存地址稳定。JDK 会先把数据拷到一块线程本地缓存的临时 DirectBuffer 再发起系统调用；所以高频网络 IO 应直接使用（池化的）DirectBuffer。

> [!QUESTION] DirectByteBuffer 的内存是怎么释放的？为什么会出现 Direct buffer OOM？
> 构造时注册 Cleaner（虚引用），对象不可达后由 GC 发现、Reference Handler 线程调用 `freeMemory` 释放。DirectByteBuffer 对象很小，晋升老年代后可能长时间不被回收，堆外内存随之堆积；分配超过 `MaxDirectMemorySize` 时 JDK 会 `System.gc()` 并重试，若禁用了显式 GC 或确实泄漏就会 OOM。

> [!QUESTION] Buffer 的 flip、clear、compact 有什么区别？
> flip：`limit = position; position = 0`，写转读；clear：`position = 0; limit = capacity`，丢弃全部数据准备写；compact：把未读数据移到开头，`position` 置为剩余数，适合处理半包后继续写入。

> [!QUESTION] Java 的 AIO 为什么在 Linux 上用得少？
> Linux 上 `AsynchronousSocketChannel` 是用 epoll + 线程池模拟的，并非内核异步 IO，性能相比 NIO 没有优势，反而多了线程切换；Netty 曾尝试 AIO 后放弃。Linux 真正的异步 IO 是 io_uring，JDK 尚未在标准库中采用。

> [!QUESTION] mmap 和 sendfile 各适合什么场景？
> sendfile 适合文件原样发往网络（静态文件、消息消费），数据不进用户态；mmap 适合需要在用户态随机读写文件内容的场景（消息存储、索引文件），但要注意 2GB 单映射上限、缺页延迟、无法主动 unmap 等问题。
