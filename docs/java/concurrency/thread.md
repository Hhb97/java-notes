---
level: 进阶
tags: [线程, 线程状态, 中断, 虚拟线程, ThreadLocal]
summary: 从 OS 线程映射、六种状态、监视器等待、中断协议到虚拟线程与 ThreadLocal 泄漏，建立排查并发问题的线程级心智模型
---

# 线程与生命周期

> [!ABSTRACT] 核心要点
> - HotSpot 的平台线程与 OS 内核线程 **1:1** 映射：创建、阻塞、切换都要经过内核，线程是「贵」资源，所以要池化。
> - `Thread.State` 只有 6 种：`RUNNABLE` 包含 OS 的就绪、运行，**也包含阻塞在 socket 读上的线程**；`BLOCKED` 只表示「等 monitor」。
> - 中断是**协作式**的：`interrupt()` 只置标志位，能响应的只有 `sleep/wait/join`、`park`、可中断 IO；吞掉 `InterruptedException` 是最常见的错误。
> - 虚拟线程（JDK 21 GA）是 **M:N** 调度：阻塞时把栈帧卸载到堆、释放载体线程；JDK 21–23 中 `synchronized` 会 pin 住载体，JDK 24（JEP 491）基本解决。
> - `ThreadLocalMap` 挂在 `Thread` 上，Entry 的 key 是弱引用、value 是强引用；线程池线程长寿，**不 `remove()` 就会泄漏和串数据**。

## Java 线程与 OS 线程

### 1:1 映射

HotSpot 中 `new Thread().start()` 最终调用 `JVM_StartThread` → 创建 `JavaThread`（C++ 对象）→ `os::create_thread` → Linux 上即 `pthread_create`。因此：

- 一个 Java 平台线程 = 一个内核调度实体（Linux 上的 LWP），`top -H -p <pid>` 看到的每个线程 ID（十进制）转成十六进制，就是 `jstack` 里的 `nid=0x...`——这是定位「哪个线程吃 CPU」的标准手法，见 [Linux 线上排查](#/infra/linux)。
- 每个线程有独立的**虚拟机栈**（`-Xss`，Linux x64 默认 1MB，是虚拟地址预留、按需提交物理页）、本地方法栈、程序计数器。
- 线程数受 `ulimit -u`、`/proc/sys/kernel/threads-max`、`pid_max`、容器 `pids.limit` 以及内存共同约束。报 `OutOfMemoryError: unable to create native thread` 时，通常不是堆满了，而是这些限制之一触顶。

### 创建方式与 start 语义

```java
new Thread(() -> work()).start();                      // Runnable
FutureTask<Integer> ft = new FutureTask<>(() -> 42);   // Callable：有返回值、可抛受检异常
new Thread(ft).start();
Thread.ofPlatform().name("io-", 0).start(task);        // JDK 21 Builder API
Thread.ofVirtual().start(task);                        // JDK 21 虚拟线程
```

- 只有 `start()` 才会创建新线程；直接调 `run()` 是在当前线程执行。
- 同一个 `Thread` 对象 `start()` 两次抛 `IllegalThreadStateException`（`threadStatus != 0`）。
- 本质上**只有一种创建线程的方式**：构造 `Thread` 并 `start()`；Runnable/Callable/线程池只是「任务」的不同包装。

## 六种状态与转换

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Java 线程六种状态的转换关系">
<rect class="b" x="20" y="98" width="100" height="44" rx="8"/>
<text class="tb" x="70" y="120" text-anchor="middle" dominant-baseline="middle">NEW</text>
<rect class="b" x="20" y="198" width="100" height="44" rx="8"/>
<text class="tb" x="70" y="220" text-anchor="middle" dominant-baseline="middle">TERMINATED</text>
<rect class="b1" x="170" y="20" width="200" height="320" rx="10"/>
<text class="th" x="270" y="44" text-anchor="middle" dominant-baseline="middle">RUNNABLE</text>
<text class="ts" x="270" y="66" text-anchor="middle" dominant-baseline="middle">含 OS 就绪与运行</text>
<rect class="b" x="195" y="100" width="150" height="40" rx="6"/>
<text class="t" x="270" y="120" text-anchor="middle" dominant-baseline="middle">Ready 就绪</text>
<rect class="b" x="195" y="200" width="150" height="40" rx="6"/>
<text class="t" x="270" y="220" text-anchor="middle" dominant-baseline="middle">Running 运行</text>
<line class="l" x1="245" y1="140" x2="245" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="238" y="172" text-anchor="end">调度</text>
<line class="l" x1="295" y1="200" x2="295" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="302" y="172">时间片到</text>
<text class="ts" x="270" y="282" text-anchor="middle">阻塞式 socket 读</text>
<text class="ts" x="270" y="300" text-anchor="middle">在 Java 层也显示 RUNNABLE</text>
<line class="la" x1="120" y1="120" x2="195" y2="120" marker-end="url(#arr-a)"/>
<text class="ts" x="157" y="110" text-anchor="middle">start()</text>
<line class="l" x1="195" y1="220" x2="120" y2="220" marker-end="url(#arr)"/>
<text class="ts" x="157" y="210" text-anchor="middle">run 结束</text>
<rect class="b4" x="530" y="40" width="210" height="56" rx="8"/>
<text class="tb" x="635" y="60" text-anchor="middle" dominant-baseline="middle">BLOCKED</text>
<text class="ts" x="635" y="82" text-anchor="middle" dominant-baseline="middle">等待进入 monitor</text>
<rect class="b3" x="530" y="150" width="210" height="56" rx="8"/>
<text class="tb" x="635" y="170" text-anchor="middle" dominant-baseline="middle">WAITING</text>
<text class="ts" x="635" y="192" text-anchor="middle" dominant-baseline="middle">无限期等待被唤醒</text>
<rect class="b2" x="530" y="260" width="210" height="56" rx="8"/>
<text class="tb" x="635" y="280" text-anchor="middle" dominant-baseline="middle">TIMED_WAITING</text>
<text class="ts" x="635" y="302" text-anchor="middle" dominant-baseline="middle">超时自动返回</text>
<line class="l" x1="370" y1="60" x2="530" y2="60" marker-end="url(#arr)"/>
<text class="ts" x="450" y="54" text-anchor="middle">抢 monitor 失败</text>
<line class="l" x1="530" y1="78" x2="370" y2="78" marker-end="url(#arr)"/>
<text class="ts" x="450" y="94" text-anchor="middle">获得锁</text>
<line class="l" x1="370" y1="170" x2="530" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="450" y="164" text-anchor="middle">wait / join / park</text>
<line class="l" x1="530" y1="188" x2="370" y2="188" marker-end="url(#arr)"/>
<text class="ts" x="450" y="204" text-anchor="middle">notify / unpark</text>
<line class="l" x1="370" y1="280" x2="530" y2="280" marker-end="url(#arr)"/>
<text class="ts" x="450" y="274" text-anchor="middle">sleep(n) / wait(n)</text>
<line class="l" x1="530" y1="298" x2="370" y2="298" marker-end="url(#arr)"/>
<text class="ts" x="450" y="314" text-anchor="middle">超时 / 唤醒</text>
<line class="ld" x1="635" y1="150" x2="635" y2="96" marker-end="url(#arr)"/>
<text class="ts" x="627" y="126" text-anchor="end">notify 后需重新抢锁</text>
</svg>
<figcaption>图 1：线程状态机。wait 被 notify 后并不直接回到 RUNNABLE，而是先进入 BLOCKED 重新竞争 monitor</figcaption>
</figure>

| 状态 | 进入方式 | jstack 中的典型样子 |
| --- | --- | --- |
| `NEW` | 已构造未 `start()` | 不会出现 |
| `RUNNABLE` | 运行中 / 就绪 / 阻塞在 native IO | `at java.net.SocketInputStream.socketRead0` |
| `BLOCKED` | 进入 `synchronized` 失败；`wait` 被唤醒后重新抢锁 | `waiting to lock <0x...>` |
| `WAITING` | `Object.wait()`、`Thread.join()`、`LockSupport.park()` | `parking to wait for <0x...> (a ...AQS$ConditionObject)` |
| `TIMED_WAITING` | `sleep(n)`、`wait(n)`、`join(n)`、`parkNanos` | 线程池空闲线程常见于 `LinkedBlockingQueue.poll` |
| `TERMINATED` | `run()` 正常返回或抛出未捕获异常 | 不会出现 |

> [!WARNING] 状态误判
> - `ReentrantLock.lock()` 抢不到锁时线程是 **WAITING**（底层是 `park`），不是 BLOCKED。jstack 里大量 BLOCKED 只说明 `synchronized` 竞争。
> - 一个「卡住的」RPC 调用可能显示 RUNNABLE（阻塞在 socket read），CPU 却是 0。判断是否真在跑要结合 `top -H` 的 CPU 和多次 jstack 对比栈顶是否变化。

### wait / notify 与监视器

每个对象关联一个 monitor（HotSpot 中为 `ObjectMonitor`），它有两类等待者：

- **EntryList / cxq**：想进入临界区但没抢到锁的线程（BLOCKED）。
- **WaitSet**：持有锁后主动调用 `wait()` 的线程（WAITING / TIMED_WAITING），`wait()` 会**释放锁**。

`notify()` 只是把 WaitSet 中的一个线程移到竞争队列（具体放到 cxq 还是 EntryList 由 HotSpot 内部策略决定，随版本有变化），被唤醒者要等 notify 方退出同步块并重新抢到锁后才能从 `wait()` 返回。细节结构见 [synchronized 与锁升级](#/java/concurrency/sync)。

```java
// 标准的条件等待范式
synchronized (lock) {
    while (!condition) {          // 必须用 while：防虚假唤醒 & 被唤醒时条件可能已被别人改掉
        lock.wait();
    }
    doSomething();
}
// 通知方
synchronized (lock) {
    condition = true;
    lock.notifyAll();             // 多种条件共用一个 monitor 时用 notifyAll，避免「信号丢给了错误的等待者」
}
```

- 不持有锁就调 `wait/notify` → `IllegalMonitorStateException`。
- `sleep()` 不释放锁、`wait()` 释放锁；`yield()` 只是提示调度器，不保证让出。
- `join()` 的实现就是在 `Thread` 对象上 `wait()`，线程终止时 JVM 会对该 Thread 对象 `notifyAll`——所以**不要拿 Thread 对象当锁**。

## 中断机制

```java
t.interrupt();                    // 置位中断标志；若 t 正阻塞在可中断方法上则唤醒它
Thread.currentThread().isInterrupted();  // 只读，不清除
Thread.interrupted();             // 静态方法：读取并【清除】当前线程的标志
```

| 目标线程所处位置 | 调用 `interrupt()` 的效果 |
| --- | --- |
| `sleep / wait / join` | 抛 `InterruptedException`，**同时清除标志位** |
| `LockSupport.park` | 立即返回，不抛异常，标志位保留 |
| `InterruptibleChannel` 上的 IO | 通道被关闭，抛 `ClosedByInterruptException` |
| `Selector.select` | 立即返回 |
| 等待进入 `synchronized` | **无效**，继续 BLOCKED |
| 传统 `InputStream.read`（BIO） | **无效**，只能关闭 socket |
| 纯计算循环 | 仅置位，需代码主动检查 |

正确姿势：要么继续向上抛 `InterruptedException`，要么**恢复中断标志**，让上层能感知：

```java
try {
    queue.take();
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();   // 恢复标志，不要吞掉
    return;                               // 并尽快退出
}
```

> [!CAUTION] 吞中断导致无法关闭
> `catch (InterruptedException e) { log.warn(...); }` 后继续循环，会让 `shutdownNow()`、`Future.cancel(true)`、Spring 容器优雅停机全部失效，进程只能被 `kill -9`。

`Thread.stop()` 会在任意位置抛 `ThreadDeath`、释放所有锁，破坏不变式；JDK 20 起直接抛 `UnsupportedOperationException`。

## 上下文切换与守护线程

### 上下文切换的代价

- **直接开销**：保存/恢复寄存器、内核态切换、调度器运行，通常在微秒量级。
- **间接开销**（往往更大）：切走后 L1/L2 缓存、TLB、分支预测被其他线程污染，切回来后大量 cache miss。
- 来源：时间片耗尽（非自愿切换）、阻塞在锁/IO/sleep 上（自愿切换）。
- 观察：`vmstat 1` 的 `cs` 列看系统总量；`pidstat -w -p <pid>` 看 `cswch/s`（自愿）与 `nvcswch/s`（非自愿）。自愿切换高 → 锁竞争或 IO 等待多；非自愿高 → 线程数远超核数，CPU 争抢。

降低手段：减少线程数（合理设线程池）、缩小临界区或改无锁、用 CAS、协程/虚拟线程。

### 守护线程

- `setDaemon(true)` 必须在 `start()` 之前，否则 `IllegalThreadStateException`；新线程默认继承创建者的 daemon 属性。
- 所有**非守护线程**结束后 JVM 退出，守护线程被直接终止，其 `finally` **不保证执行**——不要在守护线程里做落盘、提交事务这类收尾。
- GC 线程、JIT 编译线程、`Reference Handler`、`Finalizer` 都是守护线程；`ForkJoinPool.commonPool` 的工作线程也是守护线程，这就是 `main` 里 `CompletableFuture.runAsync` 后不等待，任务可能还没跑完进程就退出的原因。

## 虚拟线程（JDK 21+）

### M:N 模型

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="虚拟线程挂载在载体线程上运行，阻塞时卸载到堆">
<rect class="bg" x="20" y="20" width="250" height="250" rx="12"/>
<text class="ts" x="32" y="40">堆：已卸载（unmount）的虚拟线程</text>
<rect class="b" x="40" y="60" width="210" height="40" rx="6"/>
<text class="t" x="145" y="80" text-anchor="middle" dominant-baseline="middle">VT3 · 等待 socket 读</text>
<rect class="b" x="40" y="110" width="210" height="40" rx="6"/>
<text class="t" x="145" y="130" text-anchor="middle" dominant-baseline="middle">VT4 · sleep(100)</text>
<rect class="b" x="40" y="160" width="210" height="40" rx="6"/>
<text class="t" x="145" y="180" text-anchor="middle" dominant-baseline="middle">VT5 · 等 ReentrantLock</text>
<text class="ts" x="145" y="226" text-anchor="middle">栈帧以 StackChunk 对象存于堆</text>
<text class="ts" x="145" y="246" text-anchor="middle">就绪后重新提交给调度器</text>
<line class="la" x1="270" y1="95" x2="330" y2="95" marker-end="url(#arr-a)"/>
<text class="ts" x="300" y="87" text-anchor="middle">mount</text>
<line class="l" x1="330" y1="130" x2="270" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="300" y="146" text-anchor="middle">unmount</text>
<rect class="bg" x="330" y="20" width="410" height="170" rx="12"/>
<text class="ts" x="342" y="40">调度器：ForkJoinPool（FIFO，默认并行度 = CPU 核数）</text>
<rect class="b5" x="345" y="54" width="120" height="36" rx="6"/>
<text class="t" x="405" y="72" text-anchor="middle" dominant-baseline="middle">VT1 已挂载</text>
<rect class="b5" x="475" y="54" width="120" height="36" rx="6"/>
<text class="t" x="535" y="72" text-anchor="middle" dominant-baseline="middle">VT2 已挂载</text>
<rect class="b4" x="605" y="54" width="120" height="36" rx="6"/>
<text class="t" x="665" y="72" text-anchor="middle" dominant-baseline="middle">VT6 pinned</text>
<line class="l" x1="405" y1="90" x2="405" y2="110"/>
<line class="l" x1="535" y1="90" x2="535" y2="110"/>
<line class="l" x1="665" y1="90" x2="665" y2="110"/>
<rect class="b1" x="345" y="110" width="120" height="56" rx="6"/>
<text class="tb" x="405" y="130" text-anchor="middle" dominant-baseline="middle">Carrier-1</text>
<text class="ts" x="405" y="150" text-anchor="middle" dominant-baseline="middle">平台线程</text>
<rect class="b1" x="475" y="110" width="120" height="56" rx="6"/>
<text class="tb" x="535" y="130" text-anchor="middle" dominant-baseline="middle">Carrier-2</text>
<text class="ts" x="535" y="150" text-anchor="middle" dominant-baseline="middle">平台线程</text>
<rect class="b1" x="605" y="110" width="120" height="56" rx="6"/>
<text class="tb" x="665" y="130" text-anchor="middle" dominant-baseline="middle">Carrier-3</text>
<text class="ts" x="665" y="150" text-anchor="middle" dominant-baseline="middle">平台线程</text>
<line class="l" x1="405" y1="166" x2="405" y2="215"/>
<line class="l" x1="535" y1="166" x2="535" y2="215"/>
<line class="l" x1="665" y1="166" x2="665" y2="215"/>
<text class="ts" x="412" y="204">1:1</text>
<text class="ts" x="542" y="204">1:1</text>
<text class="ts" x="672" y="204">1:1</text>
<rect class="b" x="345" y="215" width="120" height="36" rx="6"/>
<text class="t" x="405" y="233" text-anchor="middle" dominant-baseline="middle">OS 线程</text>
<rect class="b" x="475" y="215" width="120" height="36" rx="6"/>
<text class="t" x="535" y="233" text-anchor="middle" dominant-baseline="middle">OS 线程</text>
<rect class="b" x="605" y="215" width="120" height="36" rx="6"/>
<text class="t" x="665" y="233" text-anchor="middle" dominant-baseline="middle">OS 线程</text>
<text class="ts" x="20" y="292">pinned：虚拟线程在 native 调用或（JDK 21–23）synchronized 内阻塞时无法卸载，</text>
<text class="ts" x="20" y="310">连带载体线程一起阻塞；载体被占满后，其他就绪的虚拟线程全部饿死</text>
</svg>
<figcaption>图 2：虚拟线程的 M:N 调度。大量虚拟线程复用少量载体线程，阻塞即卸载</figcaption>
</figure>

- 虚拟线程是 JDK 层面实现的用户态线程：`VirtualThread` 内部持有一个 `Continuation`。运行时被**挂载**到载体线程（carrier，`ForkJoinPool` 的工作线程）上；遇到阻塞操作时 `Continuation.yield`，栈帧拷贝到堆上的 `StackChunk`，载体线程立即去跑别的虚拟线程。
- 会触发卸载的阻塞：JUC 锁与队列（`park`）、`Thread.sleep`、`Socket`/NIO 网络 IO（JDK 内部改为非阻塞 + Poller 回调唤醒）等。文件 IO 等无法异步化的操作会临时**补偿**一个载体线程（扩容调度器）。
- 调度器参数：`jdk.virtualThreadScheduler.parallelism`（默认 CPU 核数）、`jdk.virtualThreadScheduler.maxPoolSize`（补偿上限）。
- 创建成本约几百字节到 KB 级、栈按需增长，百万级虚拟线程可行；但它只提升 **IO 密集型**任务的吞吐，**不会让 CPU 密集型代码更快**。

### Pinning 与 JEP 491

| 场景 | JDK 21–23 | JDK 24+（JEP 491） |
| --- | --- | --- |
| 在 `synchronized` 块内阻塞（IO、park、sleep） | pin 住载体 | 可以卸载 |
| 阻塞在进入 `synchronized`（抢 monitor） | pin 住载体 | 可以卸载 |
| `Object.wait()` | pin 住载体 | 可以卸载 |
| native 方法 / FFM 外部函数调用期间阻塞 | pin | 仍然 pin |

JDK 21–23 下排查 pinning：`-Djdk.tracePinnedThreads=full` 打印栈，或 JFR 事件 `jdk.VirtualThreadPinned`（推荐，JDK 24 后以 JFR 为准）。在这些版本上，热路径里「`synchronized` + 网络调用」应改成 `ReentrantLock`。很多老版本 JDBC 驱动、连接池内部用了 `synchronized`，是虚拟线程落地时最常见的吞吐塌陷原因。

> [!TIP] 虚拟线程使用守则
> - **不要池化虚拟线程**：用 `Executors.newVirtualThreadPerTaskExecutor()`，一个任务一个线程。
> - 限流靠 `Semaphore` 而不是「固定大小线程池」——下游连接池、数据库才是真正的瓶颈。
> - 慎用 `ThreadLocal` 缓存大对象：百万线程 × 每线程一份 = 内存爆炸；上下文传递优先考虑 `ScopedValue`（JDK 25 转正，此前为预览）。

## ThreadLocal

### 数据结构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Thread 持有 ThreadLocalMap，Entry 的 key 弱引用 ThreadLocal，value 强引用">
<rect class="bg" x="20" y="20" width="210" height="280" rx="12"/>
<text class="ts" x="32" y="40">栈（局部变量 / 静态引用）</text>
<rect class="b" x="40" y="60" width="160" height="40" rx="6"/>
<text class="t" x="120" y="80" text-anchor="middle" dominant-baseline="middle">currentThread 引用</text>
<rect class="b" x="40" y="230" width="160" height="40" rx="6"/>
<text class="t" x="120" y="250" text-anchor="middle" dominant-baseline="middle">static TL-B 引用</text>
<rect class="bg" x="250" y="20" width="490" height="280" rx="12"/>
<text class="ts" x="262" y="40">堆</text>
<rect class="b1" x="270" y="60" width="170" height="60" rx="8"/>
<text class="tb" x="355" y="80" text-anchor="middle" dominant-baseline="middle">Thread</text>
<text class="tm" x="355" y="102" text-anchor="middle" dominant-baseline="middle">threadLocals</text>
<rect class="b2" x="270" y="150" width="170" height="50" rx="8"/>
<text class="tb" x="355" y="168" text-anchor="middle" dominant-baseline="middle">ThreadLocalMap</text>
<text class="tm" x="355" y="188" text-anchor="middle" dominant-baseline="middle">Entry[] table</text>
<line class="l" x1="200" y1="80" x2="270" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="355" y1="120" x2="355" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="175" x2="480" y2="175" marker-end="url(#arr)"/>
<text class="ts" x="600" y="50" text-anchor="middle">Entry extends WeakReference</text>
<rect class="b" x="480" y="60" width="110" height="44"/>
<text class="t" x="535" y="82" text-anchor="middle" dominant-baseline="middle">TL-A（weak）</text>
<rect class="b" x="590" y="60" width="130" height="44"/>
<text class="t" x="655" y="82" text-anchor="middle" dominant-baseline="middle">UserCtx</text>
<rect class="b4" x="480" y="104" width="110" height="44"/>
<text class="t" x="535" y="126" text-anchor="middle" dominant-baseline="middle">null</text>
<rect class="b4" x="590" y="104" width="130" height="44"/>
<text class="t" x="655" y="126" text-anchor="middle" dominant-baseline="middle">旧 value</text>
<rect class="b" x="480" y="148" width="110" height="44"/>
<text class="t" x="535" y="170" text-anchor="middle" dominant-baseline="middle">TL-B（weak）</text>
<rect class="b" x="590" y="148" width="130" height="44"/>
<text class="t" x="655" y="170" text-anchor="middle" dominant-baseline="middle">Connection</text>
<rect class="b3" x="480" y="232" width="110" height="36" rx="6"/>
<text class="t" x="535" y="250" text-anchor="middle" dominant-baseline="middle">TL-B 对象</text>
<line class="ld" x1="535" y1="192" x2="535" y2="232" marker-end="url(#arr)"/>
<text class="ts" x="543" y="216">弱引用</text>
<line class="l" x1="200" y1="250" x2="480" y2="250" marker-end="url(#arr)"/>
<text class="ts" x="340" y="242" text-anchor="middle">强引用</text>
<text class="ts" x="600" y="250">stale：key=null</text>
<text class="ts" x="600" y="268">value 仍强可达</text>
</svg>
<figcaption>图 3：ThreadLocal 的值存在 Thread 自己的 ThreadLocalMap 里，ThreadLocal 对象只是查找用的 key</figcaption>
</figure>

```java
// JDK 17 ThreadLocal（节选）
public T get() {
    Thread t = Thread.currentThread();
    ThreadLocalMap map = t.threadLocals;              // 值挂在线程上，而不是 ThreadLocal 上
    if (map != null) {
        ThreadLocalMap.Entry e = map.getEntry(this);  // 以 ThreadLocal 自身为 key
        if (e != null) return (T) e.value;
    }
    return setInitialValue();
}
static class Entry extends WeakReference<ThreadLocal<?>> {
    Object value;                                     // value 是强引用
    Entry(ThreadLocal<?> k, Object v) { super(k); value = v; }
}
private static final int HASH_INCREMENT = 0x61c88647; // 斐波那契散列，让下标均匀分布
```

- 每个 `ThreadLocal` 实例有固定的 `threadLocalHashCode`（每创建一个递增 `0x61c88647`）。
- `ThreadLocalMap` 用**开放寻址 + 线性探测**解决冲突（不是链表），初始容量 16，阈值为容量的 2/3。
- `get/set/remove` 在探测过程中会顺带调用 `expungeStaleEntry` 清理 key 为 null 的条目——这是「被动清理」，不可依赖。

### 为什么会泄漏 / 串数据

1. key 是弱引用：`ThreadLocal` 对象只被 Entry 引用时，GC 后 key 变 null，但 **value 被 `Thread → ThreadLocalMap → Entry → value` 强引用链抓住**。
2. 实际上业务里的 `ThreadLocal` 几乎都是 `static final`，key 永远不会被回收，弱引用根本不起作用——**value 会一直活到线程死亡**。
3. 线程池线程几乎不死：上一个请求 `set` 的用户上下文没 `remove`，下一个请求在同一线程上 `get` 就拿到了**别人的数据**（越权事故）。
4. Web 容器热部署时，value 若是应用类加载器加载的对象，会把整个 `ClassLoader` 钉住，导致 Metaspace 泄漏。

```java
// 正确用法：set 与 remove 成对出现在 try/finally 中
USER_CTX.set(user);
try {
    chain.doFilter(req, resp);
} finally {
    USER_CTX.remove();
}
```

### 跨线程传递：InheritableThreadLocal 与 TTL

| 方案 | 原理 | 局限 |
| --- | --- | --- |
| `InheritableThreadLocal` | `Thread` 构造时把父线程的 `inheritableThreadLocals` 复制一份（浅拷贝，可重写 `childValue`） | 只在**创建线程时**复制一次；线程池复用线程时拿到的是创建时那一刻的旧值 |
| 手动包装 | 提交任务时捕获上下文，任务内 set、finally remove | 侵入代码，容易遗漏 |
| TransmittableThreadLocal（阿里开源 TTL） | 提交时 **capture** 父线程所有 TTL 值 → 执行前 **replay** 到工作线程 → 执行后 **restore** 工作线程原值 | 需包装 `TtlRunnable`/`TtlExecutors` 或挂 Java Agent |
| `ScopedValue`（JDK 25 正式） | 不可变、按作用域绑定，结构化并发的子任务自动继承 | 不能随意修改；不适用于普通线程池 |

链路追踪的 traceId、MDC、租户 ID 在异步线程池中丢失，基本都是这一类问题：MDC 本身基于 `ThreadLocal`，需要用 TTL 或 `TaskDecorator`（Spring）把上下文搬过去。

## 生产实践与踩坑

> [!WARNING] 线程数持续上涨
> **现象**：`jstack | grep -c 'java.lang.Thread.State'` 一直增长，最终 `unable to create native thread`。
> **排查**：按线程名前缀分组统计（`pool-N-thread-M` 说明有人在循环里 `Executors.newFixedThreadPool` 且没 shutdown）；每个线程池都要用自定义 `ThreadFactory` 命名，否则无从定位。

> [!WARNING] CPU 100% 定位
> `top -Hp <pid>` 找到最忙的线程 ID → `printf '%x' <tid>` → 在 jstack 里搜 `nid=0x...`，连续抓 3 次看栈顶是否一致。常见元凶：死循环、正则回溯、`HashMap` 并发扩容（JDK 7）、自旋 CAS 失败重试。

> [!CAUTION] 线程池 + ThreadLocal 串用户
> 网关鉴权把 `userId` 放进 `ThreadLocal`，异常分支提前 `return` 忘了 `remove`。下一个落在同一 Tomcat 线程上的匿名请求读到了上一位用户的身份。**规则：所有 `set` 必须配对 `finally remove()`，或在框架拦截器的 `afterCompletion` 统一清理。**

- 未捕获异常默认只打印到 `System.err`：给线程池的 `ThreadFactory` 设置 `UncaughtExceptionHandler`，接入日志。
- `Thread.sleep` 做轮询会白白占线程；能用 `ScheduledExecutorService`、阻塞队列或 `CompletableFuture` 就别轮询。
- 生产上不要依赖线程优先级（`setPriority`），Linux 下 HotSpot 默认基本忽略它。

## 相关阅读

- [进程、线程与 CPU 调度](#/cs/os-process)：进程、线程、协程与调度的操作系统基础
- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：线程池/异步场景下的链路上下文传播

## 面试追问

> [!QUESTION] 线程调用 `ReentrantLock.lock()` 阻塞和 `synchronized` 阻塞，jstack 中的状态一样吗？
> 不一样。`synchronized` 抢锁失败是 `BLOCKED`（waiting to lock）；`ReentrantLock` 底层是 `LockSupport.park`，状态是 `WAITING`/`TIMED_WAITING`（parking to wait for）。前者不可中断，后者可用 `lockInterruptibly` 响应中断。

> [!QUESTION] `Thread.interrupted()` 和 `isInterrupted()` 有什么区别？为什么 catch 到 `InterruptedException` 要再 `interrupt()` 一次？
> 前者是静态方法，读取并清除当前线程标志；后者只读。可中断方法抛出 `InterruptedException` 时已经清除了标志，如果当前方法不能继续抛出，就要恢复标志让调用栈上层（如线程池的 worker 循环）还能感知到「有人要求停止」。

> [!QUESTION] ThreadLocal 的 key 为什么设计成弱引用？用了弱引用为什么还会泄漏？
> 弱 key 让「ThreadLocal 对象已无人引用」时，Entry 能被识别为 stale 并在后续 get/set 中被清理。但 value 是强引用，只有在线程继续操作该 Map 时才会顺带清除；且业务中 ThreadLocal 多为 static，key 根本不会被回收。根治只能靠 `remove()`。

> [!QUESTION] 虚拟线程适合什么场景？为什么 JDK 21 上用了虚拟线程吞吐反而下降？
> 适合高并发、IO 等待占比高的请求处理。吞吐下降常见原因：`synchronized` 内做 IO 导致 pinning，载体线程（数量≈核数）很快被占满；或在虚拟线程里跑 CPU 密集任务。用 JFR `jdk.VirtualThreadPinned` 定位，改用 `ReentrantLock` 或升级到 JDK 24+。

> [!QUESTION] 为什么说 Java 只有一种创建线程的方式？
> 只有 `Thread#start()` 会调用 native `start0` 创建 OS 线程。实现 Runnable、Callable、线程池都只是提供「任务」，线程池内部同样通过 `ThreadFactory` new Thread 并 start。

> [!QUESTION] 守护线程里的 finally 一定会执行吗？
> 不一定。JVM 在最后一个非守护线程结束时退出，守护线程会被直接终止，不会走 finally。因此需要可靠收尾的逻辑应放在非守护线程，或注册 `Runtime.addShutdownHook`。
