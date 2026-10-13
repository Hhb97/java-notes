---
level: 深入
tags: [CountDownLatch, BlockingQueue, LongAdder, CompletableFuture, 结构化并发]
summary: 同步器、阻塞队列、写时复制、分段计数与 CompletableFuture 的实现原理与选型，以及异步编排在生产中的超时、异常与线程池陷阱
---

# 并发工具与 CompletableFuture

> [!ABSTRACT] 核心要点
> - `CountDownLatch`、`Semaphore` 直接基于 AQS 共享模式；`CyclicBarrier` 基于 `ReentrantLock + Condition`，可复用；`Phaser` 支持动态增减参与方与多阶段。
> - `ArrayBlockingQueue` 一把锁两个条件，`LinkedBlockingQueue` 读写两把锁可并行，但默认容量是 `Integer.MAX_VALUE`；`SynchronousQueue` 不存储元素，只做「手递手」。
> - `LongAdder` 把热点拆成 `base + Cell[]`，高并发写入性能远超 `AtomicLong`，代价是 `sum()` 不是原子快照。
> - `CompletableFuture` 用 `result` + Treiber 栈 `stack` 保存回调，完成时由 `postComplete` 依次触发；**默认异步线程池是 `ForkJoinPool.commonPool()`，IO 任务必须显式传入自己的线程池**。
> - `orTimeout` 只让 Future 超时完成，**不会中断底层任务**；`cancel(true)` 同样不中断。结构化并发（预览）用作用域管理子任务生命周期，解决「一个失败其他继续跑」的问题。

## 同步器

### CountDownLatch

```java
// JDK 17 CountDownLatch.Sync（节选）：state = 剩余计数
protected int tryAcquireShared(int acquires) {
    return (getState() == 0) ? 1 : -1;          // 计数为 0 才放行，返回 1 触发向后传播唤醒
}
protected boolean tryReleaseShared(int releases) {
    for (;;) {
        int c = getState();
        if (c == 0) return false;               // 已经是 0，多余的 countDown 无效果
        int nextc = c - 1;
        if (compareAndSetState(c, nextc))
            return nextc == 0;                  // 只有减到 0 的那一次才唤醒所有 await 线程
    }
}
```

一次性：计数到 0 后无法重置。典型场景：主线程等待 N 个子任务完成、N 个线程等待一个「发令枪」同时开始（计数为 1）。

### CyclicBarrier

- 内部是 `ReentrantLock lock` + `Condition trip` + `count` + `Generation`。每个线程 `await()` 时在锁内 `--count`；**最后一个到达的线程**执行 `barrierAction`，然后 `trip.signalAll()` 并开启新的 generation，屏障自动复用。
- 任一等待线程被中断或超时，屏障进入 **broken** 状态，其他线程全部抛 `BrokenBarrierException`；需要 `reset()` 才能继续使用。

### Semaphore

- AQS 共享模式，state = 剩余许可。非公平 `acquire` 循环 CAS 扣减，不够则排队；`release` CAS 增加并唤醒。
- **许可没有归属**：没 acquire 的线程也能 release，release 多了许可就会超过初始值。务必 `acquire` 成功后再在 finally 中 `release`。
- 用途：限制并发访问某资源的线程数（如对下游的并发调用、虚拟线程下的连接数控制）。它限制的是**并发数**而不是 QPS。

### Phaser 与 Exchanger

- `Phaser`（JDK 7）：可复用、参与方可动态 `register/arriveAndDeregister`，每一轮叫一个 phase，可重写 `onAdvance` 决定何时终止；参与方很多时可组成树形（tiered）结构分散竞争。状态压缩在一个 `long` 中（未到达数、参与方数、phase 号、终止位）。
- `Exchanger`：两个线程在交换点互换数据，适合双缓冲场景，日常业务很少使用。

| 工具 | 实现 | 可复用 | 计数方向 | 典型场景 |
| --- | --- | --- | --- | --- |
| `CountDownLatch` | AQS 共享 | 否 | 递减到 0 放行 | 等待 N 个任务完成 |
| `CyclicBarrier` | Lock + Condition | 是 | 到齐 N 个放行 | 多线程分阶段计算互相等待 |
| `Semaphore` | AQS 共享 | 是 | 许可增减 | 并发数限流 |
| `Phaser` | 自身 CAS + 等待队列 | 是 | 动态参与方 | 多阶段、参与方变化 |

## BlockingQueue 家族

| 操作 | 抛异常 | 返回特殊值 | 阻塞 | 超时 |
| --- | --- | --- | --- | --- |
| 入队 | `add` | `offer` → false | `put` | `offer(e, t, unit)` |
| 出队 | `remove` | `poll` → null | `take` | `poll(t, unit)` |
| 查看 | `element` | `peek` | — | — |

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="ArrayBlockingQueue 单锁环形数组与 LinkedBlockingQueue 双锁链表的对比">
<rect class="bg" x="20" y="20" width="350" height="210" rx="12"/>
<text class="ts" x="32" y="40">ArrayBlockingQueue：一把锁 + 两个条件</text>
<rect class="b4" x="120" y="54" width="150" height="32" rx="6"/>
<text class="tb" x="195" y="70" text-anchor="middle" dominant-baseline="middle">ReentrantLock</text>
<rect class="b" x="40" y="110" width="36" height="36"/>
<rect class="b" x="76" y="110" width="36" height="36"/>
<rect class="b3" x="112" y="110" width="36" height="36"/>
<rect class="b3" x="148" y="110" width="36" height="36"/>
<rect class="b3" x="184" y="110" width="36" height="36"/>
<rect class="b3" x="220" y="110" width="36" height="36"/>
<rect class="b" x="256" y="110" width="36" height="36"/>
<rect class="b" x="292" y="110" width="36" height="36"/>
<line class="l" x1="130" y1="164" x2="130" y2="148" marker-end="url(#arr)"/>
<text class="ts" x="130" y="178" text-anchor="middle">takeIndex</text>
<line class="l" x1="274" y1="164" x2="274" y2="148" marker-end="url(#arr)"/>
<text class="ts" x="274" y="178" text-anchor="middle">putIndex</text>
<text class="ts" x="195" y="202" text-anchor="middle">环形数组：put / take 都要先拿同一把锁</text>
<text class="ts" x="195" y="220" text-anchor="middle">notFull / notEmpty 两个 Condition</text>
<rect class="bg" x="390" y="20" width="350" height="210" rx="12"/>
<text class="ts" x="402" y="40">LinkedBlockingQueue：两把锁 + AtomicInteger</text>
<rect class="b2" x="400" y="54" width="120" height="32" rx="6"/>
<text class="tb" x="460" y="70" text-anchor="middle" dominant-baseline="middle">takeLock</text>
<rect class="b2" x="600" y="54" width="120" height="32" rx="6"/>
<text class="tb" x="660" y="70" text-anchor="middle" dominant-baseline="middle">putLock</text>
<rect class="b" x="400" y="110" width="60" height="36" rx="6"/>
<text class="t" x="430" y="128" text-anchor="middle" dominant-baseline="middle">head</text>
<rect class="b3" x="480" y="110" width="60" height="36" rx="6"/>
<text class="t" x="510" y="128" text-anchor="middle" dominant-baseline="middle">n1</text>
<rect class="b3" x="560" y="110" width="60" height="36" rx="6"/>
<text class="t" x="590" y="128" text-anchor="middle" dominant-baseline="middle">n2</text>
<rect class="b3" x="640" y="110" width="60" height="36" rx="6"/>
<text class="t" x="670" y="128" text-anchor="middle" dominant-baseline="middle">last</text>
<line class="l" x1="460" y1="128" x2="480" y2="128" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="128" x2="560" y2="128" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="128" x2="640" y2="128" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="86" x2="430" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="670" y1="86" x2="670" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="565" y="172" text-anchor="middle">count：AtomicInteger</text>
<text class="ts" x="565" y="202" text-anchor="middle">入队只锁尾、出队只锁头，生产消费可并行</text>
<text class="ts" x="565" y="220" text-anchor="middle">跨锁通知：signalNotEmpty / signalNotFull</text>
</svg>
<figcaption>图 1：数组队列共用一把锁，链表队列头尾分离加锁，所以后者在生产者和消费者都多时吞吐更高</figcaption>
</figure>

```java
// JDK 8 LinkedBlockingQueue#put（节选）
public void put(E e) throws InterruptedException {
    int c = -1;
    Node<E> node = new Node<>(e);
    final ReentrantLock putLock = this.putLock;
    final AtomicInteger count = this.count;
    putLock.lockInterruptibly();
    try {
        while (count.get() == capacity) notFull.await();  // 满了等待
        enqueue(node);                                     // last = last.next = node
        c = count.getAndIncrement();
        if (c + 1 < capacity) notFull.signal();            // 还有空位：唤醒其他生产者（级联唤醒）
    } finally { putLock.unlock(); }
    if (c == 0) signalNotEmpty();                          // 从空变非空：拿 takeLock 唤醒消费者
}
```

| 实现 | 结构 | 有界 | 特点 / 场景 |
| --- | --- | --- | --- |
| `ArrayBlockingQueue` | 环形数组 + 单锁 | 必须指定 | 内存预分配、无节点对象 GC；可选公平锁 |
| `LinkedBlockingQueue` | 单链表 + 双锁 | 可选（默认 `Integer.MAX_VALUE`） | 吞吐高；每个元素一个 Node，GC 压力略大 |
| `SynchronousQueue` | 无容量，dual stack / dual queue | 0 | 生产者必须等到消费者接手；公平模式用队列、非公平用栈；`newCachedThreadPool` 使用。较新的 JDK 中其实现基于 `LinkedTransferQueue` 重写，语义不变 |
| `PriorityBlockingQueue` | 数组二叉堆 + 单锁 | 无界 | 按优先级出队；扩容时用一个 CAS 自旋锁避免持主锁分配数组 |
| `DelayQueue` | `PriorityQueue` + 锁 + leader 线程 | 无界 | 元素实现 `Delayed`，到期才能取出；只有 leader 线程定时等待堆顶，其余无限等待 |
| `LinkedTransferQueue` | 无锁 dual queue | 无界 | `transfer(e)` 阻塞到被消费者取走；兼具 SynchronousQueue 与 LBQ 能力 |
| `LinkedBlockingDeque` | 双向链表 + 单锁 | 可选 | 双端操作，可用于工作窃取的简单实现 |

> [!TIP] DelayQueue 做延迟任务的边界
> 适合单机、量不大、可丢失的延迟任务（如本地缓存过期、超时检测）。订单超时关闭这类需要持久化与分布式的场景，应使用 MQ 延迟消息、Redis ZSet 或时间轮方案，见 [高频场景实战](#/redis/practice)。

## CopyOnWriteArrayList

```java
// JDK 17 CopyOnWriteArrayList#add（节选）——JDK 8 用 ReentrantLock，JDK 9+ 改为 synchronized
public boolean add(E e) {
    synchronized (lock) {
        Object[] es = getArray();
        int len = es.length;
        es = Arrays.copyOf(es, len + 1);     // 复制一份新数组
        es[len] = e;
        setArray(es);                        // volatile 写，发布新数组
        return true;
    }
}
public E get(int index) { return elementAt(getArray(), index); }  // 读不加锁
```

- 读完全无锁；迭代器持有创建时的数组**快照**，不会抛 `ConcurrentModificationException`，但也看不到之后的修改，且不支持 `iterator.remove()`。
- 每次写都复制整个数组：写 O(n) 且产生大量垃圾。只适合**读远多于写、集合不大**的场景：监听器列表、路由表、黑白名单配置。
- 需要并发 Map 时看 [ConcurrentHashMap 源码剖析](#/java/api/chm)；需要有序并发容器用 `ConcurrentSkipListMap/Set`。

## LongAdder：分段累加

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="LongAdder 由 base 与 Cell 数组组成，竞争时线程按 probe 散列到不同 Cell">
<rect class="b1" x="40" y="20" width="90" height="36" rx="6"/>
<text class="tb" x="85" y="38" text-anchor="middle" dominant-baseline="middle">T1</text>
<rect class="b1" x="230" y="20" width="90" height="36" rx="6"/>
<text class="tb" x="275" y="38" text-anchor="middle" dominant-baseline="middle">T2</text>
<rect class="b1" x="420" y="20" width="90" height="36" rx="6"/>
<text class="tb" x="465" y="38" text-anchor="middle" dominant-baseline="middle">T3</text>
<rect class="b1" x="610" y="20" width="90" height="36" rx="6"/>
<text class="tb" x="655" y="38" text-anchor="middle" dominant-baseline="middle">T4</text>
<rect class="b2" x="20" y="110" width="160" height="50" rx="8"/>
<text class="tb" x="100" y="128" text-anchor="middle" dominant-baseline="middle">base</text>
<text class="ts" x="100" y="148" text-anchor="middle" dominant-baseline="middle">无竞争时直接 CAS</text>
<rect class="bg" x="220" y="96" width="520" height="78" rx="10"/>
<rect class="b3" x="240" y="110" width="110" height="44" rx="6"/>
<text class="t" x="295" y="132" text-anchor="middle" dominant-baseline="middle">Cell[0] = 7</text>
<rect class="b3" x="365" y="110" width="110" height="44" rx="6"/>
<text class="t" x="420" y="132" text-anchor="middle" dominant-baseline="middle">Cell[1] = 3</text>
<rect class="b3" x="490" y="110" width="110" height="44" rx="6"/>
<text class="t" x="545" y="132" text-anchor="middle" dominant-baseline="middle">Cell[2] = 5</text>
<rect class="b3" x="615" y="110" width="110" height="44" rx="6"/>
<text class="t" x="670" y="132" text-anchor="middle" dominant-baseline="middle">Cell[3] = 2</text>
<line class="l" x1="85" y1="56" x2="100" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="104" y="86">① CAS base</text>
<line class="la" x1="275" y1="56" x2="295" y2="110" marker-end="url(#arr-a)"/>
<line class="la" x1="465" y1="56" x2="545" y2="110" marker-end="url(#arr-a)"/>
<line class="la" x1="655" y1="56" x2="670" y2="110" marker-end="url(#arr-a)"/>
<text class="ts" x="380" y="196" text-anchor="middle">② 出现竞争后：按线程 probe &amp; (n-1) 选 Cell 再 CAS；Cell 上仍冲突则 rehash probe 或扩容</text>
<text class="ts" x="380" y="216" text-anchor="middle">Cell[] 长度为 2 的幂、不超过不小于 CPU 数的最小 2 的幂；每个 Cell 用 @Contended 隔离缓存行</text>
<text class="ta" x="380" y="242" text-anchor="middle">sum() = base + Σ cells[i].value（遍历期间的并发写可能漏计，不是原子快照）</text>
</svg>
<figcaption>图 2：LongAdder 把一个热点变量拆成多个，用空间换并发度，读取时再求和</figcaption>
</figure>

```java
// JDK 8 LongAdder#add（JDK 17 写法略有不同，逻辑一致）
public void add(long x) {
    Cell[] as; long b, v; int m; Cell a;
    if ((as = cells) != null || !casBase(b = base, b + x)) {  // cells 未初始化时先尝试 base
        boolean uncontended = true;
        if (as == null || (m = as.length - 1) < 0 ||
            (a = as[getProbe() & m]) == null ||                  // 线程的 probe 散列到槽位
            !(uncontended = a.cas(v = a.value, v + x)))          // 对该 Cell CAS
            longAccumulate(x, null, uncontended);                // 初始化 / 新建 Cell / rehash / 扩容
    }
}
```

`longAccumulate` 用一个 `cellsBusy` 自旋锁（CAS 0→1）保护 cells 的初始化（长度 2）、新 Cell 创建与扩容（翻倍）；CAS 冲突时先 `advanceProbe` 换个槽位重试，多次冲突且长度小于 CPU 数时才扩容。

| 维度 | AtomicLong | LongAdder |
| --- | --- | --- |
| 低竞争 | 一次 CAS | 一次 CAS（base），几乎相同 |
| 高竞争写 | 大量 CAS 失败自旋，缓存行来回失效 | 分散到多个 Cell，吞吐高一个数量级以上 |
| 读 | `get()` 精确 | `sum()` 需遍历，非原子快照 |
| 内存 | 一个 long | base + 多个带填充的 Cell |
| 能力 | `compareAndSet`、`incrementAndGet` 返回新值 | 只能累加，`increment()` 无返回值 |

结论：**统计计数（QPS、调用次数）用 `LongAdder`**；需要用返回值做判断（如生成序号、`if (count.incrementAndGet() > limit)`）用 `AtomicLong`。`LongAccumulator` 可自定义累加函数（如求最大值）。`ConcurrentHashMap` 的 `size()` 也用了同样的 `CounterCell` 思路。

## CompletableFuture

### 内部结构

```java
// JDK 17 CompletableFuture（节选）
volatile Object result;       // null = 未完成；AltResult(NIL) 表示结果为 null；AltResult(ex) 表示异常
volatile Completion stack;    // 依赖动作组成的 Treiber 栈（无锁栈，CAS 压栈）

abstract static class Completion extends ForkJoinTask<Void>
        implements Runnable, AsynchronousCompletionTask {
    volatile Completion next;
    abstract CompletableFuture<?> tryFire(int mode);  // mode: SYNC / ASYNC / NESTED
}
// UniApply（thenApply）、UniAccept、UniCompose、BiApply（thenCombine）、OrApply 等都是 Completion 子类，
// 持有 src（源）、dep（返回给调用方的新 future）、fn（回调）、executor
```

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="CompletableFuture 的 result 字段与 Completion 依赖栈，完成时逐个触发依赖">
<text class="ts" x="130" y="22" text-anchor="middle">complete(v) / 异常完成</text>
<rect class="b1" x="20" y="30" width="230" height="96" rx="10"/>
<text class="tb" x="135" y="50" text-anchor="middle" dominant-baseline="middle">CompletableFuture cf1</text>
<text class="tm" x="34" y="78" dominant-baseline="middle">volatile Object result</text>
<text class="tm" x="34" y="102" dominant-baseline="middle">volatile Completion stack</text>
<text class="ts" x="495" y="62" text-anchor="middle">Treiber 栈：后注册的在栈顶，CAS 压栈</text>
<rect class="b3" x="280" y="76" width="130" height="50" rx="8"/>
<text class="tb" x="345" y="94" text-anchor="middle" dominant-baseline="middle">BiApply</text>
<text class="ts" x="345" y="114" text-anchor="middle" dominant-baseline="middle">thenCombine</text>
<rect class="b3" x="430" y="76" width="130" height="50" rx="8"/>
<text class="tb" x="495" y="94" text-anchor="middle" dominant-baseline="middle">UniAccept</text>
<text class="ts" x="495" y="114" text-anchor="middle" dominant-baseline="middle">thenAccept</text>
<rect class="b3" x="580" y="76" width="130" height="50" rx="8"/>
<text class="tb" x="645" y="94" text-anchor="middle" dominant-baseline="middle">UniApply</text>
<text class="ts" x="645" y="114" text-anchor="middle" dominant-baseline="middle">thenApply</text>
<line class="l" x1="250" y1="102" x2="280" y2="102" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="102" x2="430" y2="102" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="102" x2="580" y2="102" marker-end="url(#arr)"/>
<line class="ld" x1="345" y1="126" x2="345" y2="170" marker-end="url(#arr)"/>
<line class="ld" x1="495" y1="126" x2="495" y2="170" marker-end="url(#arr)"/>
<line class="ld" x1="645" y1="126" x2="645" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="353" y="152">dep</text>
<text class="ts" x="503" y="152">dep</text>
<text class="ts" x="653" y="152">dep</text>
<rect class="b" x="280" y="170" width="130" height="40" rx="8"/>
<text class="t" x="345" y="190" text-anchor="middle" dominant-baseline="middle">cf4</text>
<rect class="b" x="430" y="170" width="130" height="40" rx="8"/>
<text class="t" x="495" y="190" text-anchor="middle" dominant-baseline="middle">cf3</text>
<rect class="b" x="580" y="170" width="130" height="40" rx="8"/>
<text class="t" x="645" y="190" text-anchor="middle" dominant-baseline="middle">cf2</text>
<text class="ts" x="20" y="240">cf1 完成 → postComplete() 循环弹出 Completion 并 tryFire：执行回调、完成 dep，再继续处理 dep 自己的栈</text>
</svg>
<figcaption>图 3：先后调用 thenApply、thenAccept、thenCombine 后 cf1 的依赖栈。同一个源上多个回调的执行顺序不应被依赖</figcaption>
</figure>

- 注册回调（如 `thenApply`）时：若源已完成，直接在**当前调用线程**执行（非 async 版本）；否则创建 Completion CAS 压入源的 stack，压栈后再检查一次是否已完成，防止错过。
- 源完成时（`complete` / 任务结束）：`postComplete()` 不断弹出栈顶 Completion 执行 `tryFire(NESTED)`；被触发的 dep 如果也有自己的依赖，会把它们**挪到当前栈上**循环处理，而不是递归调用，避免长链路导致栈溢出。
- 非 async 回调由「**完成源的那个线程**」或「**注册回调的线程**」执行，取决于谁先谁后——这是很多「回调跑在了 IO 线程 / 超时线程上」问题的根源。

### 编排 API

| 类别 | 方法 | 说明 |
| --- | --- | --- |
| 创建 | `supplyAsync(s, executor)`、`runAsync`、`completedFuture`、`failedFuture`（9+） | 不传 executor 则用默认池 |
| 串行变换 | `thenApply`、`thenAccept`、`thenRun` | 拿上一步结果做同步变换 |
| 串行扁平化 | `thenCompose` | 回调返回另一个 CF 时用，相当于 flatMap |
| 汇聚 AND | `thenCombine`、`thenAcceptBoth`、`allOf` | 两个/多个都完成 |
| 汇聚 OR | `applyToEither`、`acceptEither`、`anyOf` | 任一完成（另一个不会被取消） |
| 异常 | `exceptionally`、`handle`、`whenComplete`、`exceptionallyCompose`（12+） | 见下文 |
| 超时 | `orTimeout`、`completeOnTimeout`（9+） | 见下文 |
| 主动完成 | `complete`、`completeExceptionally`、`obtrudeValue` | 适配回调式 API |

每个方法都有 `xxxAsync(fn)` 与 `xxxAsync(fn, executor)` 变体：async 版本把回调提交到线程池执行。

```java
ExecutorService io = ...; // 专用于远程调用的有界线程池
CompletableFuture<User>  u = CompletableFuture.supplyAsync(() -> userClient.get(id), io);
CompletableFuture<Order> o = CompletableFuture.supplyAsync(() -> orderClient.list(id), io);
CompletableFuture<Page> page = u.thenCombine(o, Page::new)
        .orTimeout(800, TimeUnit.MILLISECONDS)                // 整体超时
        .exceptionally(ex -> Page.degraded(unwrap(ex)));      // 降级
// 多个任务汇总结果
List<CompletableFuture<Item>> fs = ids.stream()
        .map(i -> CompletableFuture.supplyAsync(() -> load(i), io)).toList();
CompletableFuture.allOf(fs.toArray(new CompletableFuture[0])).join();   // allOf 本身不带结果
List<Item> items = fs.stream().map(CompletableFuture::join).toList();
```

### 默认线程池的坑

```java
// JDK 17 CompletableFuture（节选）
private static final boolean USE_COMMON_POOL = (ForkJoinPool.getCommonPoolParallelism() > 1);
private static final Executor ASYNC_POOL = USE_COMMON_POOL
        ? ForkJoinPool.commonPool() : new ThreadPerTaskExecutor();   // 并行度 ≤ 1 时每个任务新建一个线程！
```

1. **共享**：commonPool 被整个 JVM 的并行流、所有未指定线程池的 CF 共享；一处在里面做阻塞 IO，其他地方全部排队。
2. **太小**：并行度默认 `CPU 数 - 1`，4 核容器里只有 3 个线程，IO 型任务吞吐极低。
3. **退化**：容器只分到 1～2 核时 commonPool 并行度为 1，CF 改用 `ThreadPerTaskExecutor`——**每个异步任务新建一个线程**，高并发下线程数失控。
4. **守护线程**：commonPool 线程是 daemon，`main` 方法里提交后不 join，进程可能先退出。
5. **上下文丢失**：ThreadLocal 中的 traceId 等不会自动传递。

规则：**所有 `xxxAsync` 都显式传入业务自己的线程池**，并按依赖隔离（见 [线程池原理与调优](#/java/concurrency/pool)）。

### 异常处理

| 方法 | 能拿到异常 | 能改变结果 | 说明 |
| --- | --- | --- | --- |
| `exceptionally(fn)` | 是 | 是：返回降级值 | 只在异常时调用 |
| `handle((v, ex) -> ...)` | 是 | 是 | 成功失败都调用，可统一转换 |
| `whenComplete((v, ex) -> ...)` | 是 | **否**，原结果/异常继续传递 | 适合打日志、打点 |

- 异常在链上传播时会被包装成 `CompletionException`，在下游 `exceptionally/handle` 中拿到的 `ex` 往往需要 `ex.getCause()` 才是原始异常（写一个 `unwrap` 工具方法循环剥离 `CompletionException/ExecutionException`）。
- `join()` 抛非受检的 `CompletionException`；`get()` 抛受检的 `ExecutionException`。
- 链尾没有任何异常处理，又没人 `join/get`，异常就**悄无声息地丢失**——每条异步链末端都应有 `exceptionally` 或 `whenComplete` 记录日志。

### 超时与取消

- `orTimeout(t)`：到时以 `TimeoutException` 异常完成；`completeOnTimeout(v, t)`：到时以默认值完成。二者都由 CF 内部一个静态的单线程 `ScheduledThreadPoolExecutor`（Delayer，守护线程）触发。
- **底层任务不会被中断**：远程调用仍在占用 `io` 线程池，直到它自己结束。真正的超时必须同时设置在 HTTP 客户端 / RPC 框架 / JDBC 上。
- 超时触发后，后续的非 async 回调会在 Delayer 线程上执行；回调里若有重活会堵住所有 CF 的超时调度——超时后的处理应使用 async 版本并指定线程池。
- `cancel(true)` 的 `mayInterruptIfRunning` 参数在 CF 中**被忽略**，只是以 `CancellationException` 完成该 future。JDK 8 没有 `orTimeout`，需要自己用调度线程池 + `completeExceptionally` 实现。

## 结构化并发（预览特性）

传统 CF/线程池编排中，子任务的生命周期不受父任务约束：一个子任务失败，其他子任务仍在跑；父任务被取消，子任务也不知道。结构化并发把并发子任务限制在一个**词法作用域**内：作用域结束时所有子任务必然已完成或被取消。

```java
// JDK 21–24 预览 API 风格（需 --enable-preview）
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Subtask<User>  user  = scope.fork(() -> findUser(id));     // 每个子任务一个虚拟线程
    Subtask<Order> order = scope.fork(() -> fetchOrder(id));
    scope.join()                  // 等待全部完成，或任一失败
         .throwIfFailed();        // 有失败则抛出，其余子任务已被取消（中断）
    return new Response(user.get(), order.get());
}
```

> [!NOTE] 版本状态
> 结构化并发自 JDK 21（JEP 453）起以预览形式提供，后续多个版本持续调整；JDK 25 的预览版对 API 做了较大改动（改为 `StructuredTaskScope.open(...)` 配合 `Joiner` 策略）。截至本文所覆盖版本仍为**预览特性**，生产使用前以所用 JDK 版本的 API 文档为准。它与 `ScopedValue`（JDK 25 正式）配合，子任务可以自动继承父作用域绑定的上下文。

## 生产实践与踩坑

> [!CAUTION] CF 默认池被 IO 打满
> 现象：某接口 RT 飙升，同时进程内所有并行流变慢。jstack 发现 `ForkJoinPool.commonPool-worker-*` 全部阻塞在 socket read 上。根因：`supplyAsync(() -> httpCall())` 未指定线程池。修复：为每类下游配置独立线程池并显式传入。

> [!WARNING] 线程池嵌套导致死锁
> 在 `pool` 的任务里 `supplyAsync(..., pool).join()`：外层任务占满线程后等待内层结果，内层任务在队列中等线程。CF 编排应全程异步（`thenCompose`），避免在池内线程上 `join`。

> [!WARNING] LinkedBlockingQueue 未指定容量
> 生产者速度短时超过消费者，队列无限增长，最终 Full GC 频繁直至 OOM。所有 `BlockingQueue` 都要有界，并配套满队列时的降级策略。

- `CountDownLatch.await()` 一定要带超时，否则某个子任务异常没 `countDown` 时主线程永久挂起（`countDown` 放在 finally 中）。
- `CopyOnWriteArrayList` 存放频繁变化的大集合，会造成 Young GC 频繁甚至大对象直接进老年代。
- 用 `Semaphore` 做限流时 `tryAcquire(timeout)` 失败要快速失败返回，不要无限 `acquire`。

## 相关阅读

- [AQS 与显式锁](#/java/concurrency/aqs)：AQS 原理
- [复杂度与核心数据结构](#/cs/algo-ds)：并发容器背后的数据结构
- [线程池原理与调优](#/java/concurrency/pool)：线程池

## 面试追问

> [!QUESTION] CountDownLatch 和 CyclicBarrier 的区别？
> 前者是「一组线程等待另一组事件发生」，计数由 countDown 递减，一次性，基于 AQS 共享模式；后者是「一组线程互相等待到齐」，由最后到达者触发 barrierAction，可复用，基于 ReentrantLock + Condition，一个线程失败会让整个屏障 broken。

> [!QUESTION] LinkedBlockingQueue 为什么能用两把锁？ArrayBlockingQueue 为什么不这样做？
> 链表的入队只改 last、出队只改 head（哑节点），两端不共享字段，用 AtomicInteger 维护 count 即可解耦。数组实现也可以做双锁，但 ABQ 的作者认为单锁实现简单且对数组队列已经足够快；ABQ 优势在预分配内存、无额外节点对象。

> [!QUESTION] LongAdder 为什么比 AtomicLong 快？它能替代 AtomicLong 吗？
> 高并发下 AtomicLong 所有线程 CAS 同一个缓存行，失败重试和缓存行失效开销巨大；LongAdder 把写分散到多个带填充的 Cell 上，冲突大幅减少。但 sum 不是原子快照、不支持 CAS 与返回新值，需要精确比较或序号生成时仍用 AtomicLong。

> [!QUESTION] thenApply 和 thenApplyAsync 的回调分别在哪个线程执行？
> thenApply：若注册时源已完成，在注册线程中执行；否则在完成源的线程中执行（可能是上游的线程池线程、超时 Delayer 线程甚至调用 complete 的业务线程）。thenApplyAsync：提交到指定 executor，不指定则到默认池（通常是 commonPool）。

> [!QUESTION] CompletableFuture 设置了 orTimeout，为什么下游服务的连接数还是被打满？
> orTimeout 只是让这个 future 以超时异常完成，底层执行远程调用的线程并不会被中断，请求仍在进行并占用连接；cancel(true) 同样不会中断。必须在 HTTP/RPC 客户端上设置连接、读超时，并限制并发数，才能真正释放资源。
