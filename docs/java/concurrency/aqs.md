---
level: 深入
tags: [AQS, ReentrantLock, Condition, ReadWriteLock, StampedLock, LockSupport]
summary: 读懂 AQS 的 state + CLH 变体队列、独占/共享获取与释放、Condition 节点转移，再看读写锁、StampedLock 与自定义同步器
---

# AQS 与显式锁

> [!ABSTRACT] 核心要点
> - AQS = 一个 `volatile int state` + 一个 FIFO 双向等待队列（CLH 变体）+ `LockSupport.park/unpark`。子类只需实现 `tryAcquire/tryRelease`（独占）或 `tryAcquireShared/tryReleaseShared`（共享）来定义 state 的含义。
> - 获取失败的线程封装成 Node 入队尾，**把前驱的 waitStatus 置为 SIGNAL 后才 park**；释放时由 head 唤醒后继。被唤醒者只有在「前驱是 head」时才有资格再次 tryAcquire。
> - 公平与非公平的差别只在 tryAcquire 是否先检查 `hasQueuedPredecessors()`；非公平吞吐更高，是默认选择。
> - Condition 有自己的单向条件队列：`await` 入条件队列并完全释放锁，`signal` 把节点**转移到同步队列尾部**，被唤醒后还要重新竞争锁。
> - 读写锁用 state 高 16 位计读、低 16 位计写，支持锁降级不支持升级；StampedLock 的乐观读不加锁，适合读极多写极少且临界区很短的场景。

## AQS 的数据结构

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="AQS 的 state、head、tail 与双向同步队列">
<rect class="b1" x="20" y="20" width="200" height="130" rx="10"/>
<text class="tb" x="120" y="42" text-anchor="middle" dominant-baseline="middle">AQS</text>
<text class="tm" x="36" y="68" dominant-baseline="middle">volatile int state</text>
<text class="tm" x="36" y="92" dominant-baseline="middle">Node head</text>
<text class="tm" x="36" y="116" dominant-baseline="middle">Node tail</text>
<text class="tm" x="36" y="138" dominant-baseline="middle">exclusiveOwnerThread</text>
<rect class="bg" x="260" y="20" width="480" height="96" rx="10"/>
<text class="ts" x="276" y="42">ReentrantLock：state = 重入次数，0 表示未被持有</text>
<text class="ts" x="276" y="62">Semaphore：state = 剩余许可数</text>
<text class="ts" x="276" y="82">CountDownLatch：state = 剩余计数，0 时放行所有等待者</text>
<text class="ts" x="276" y="102">ReentrantReadWriteLock：高 16 位读计数，低 16 位写重入</text>
<line class="l" x1="80" y1="150" x2="80" y2="180" marker-end="url(#arr)"/>
<text class="ts" x="88" y="170">head</text>
<line class="l" x1="220" y1="116" x2="620" y2="180" marker-end="url(#arr)"/>
<text class="ts" x="450" y="142">tail</text>
<rect class="b" x="20" y="180" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="200" text-anchor="middle" dominant-baseline="middle">head（哑节点）</text>
<text class="ts" x="80" y="222" text-anchor="middle" dominant-baseline="middle">thread = null</text>
<rect class="b3" x="200" y="180" width="120" height="60" rx="8"/>
<text class="tb" x="260" y="200" text-anchor="middle" dominant-baseline="middle">T1</text>
<text class="ts" x="260" y="222" text-anchor="middle" dominant-baseline="middle">ws = SIGNAL</text>
<rect class="b3" x="380" y="180" width="120" height="60" rx="8"/>
<text class="tb" x="440" y="200" text-anchor="middle" dominant-baseline="middle">T2</text>
<text class="ts" x="440" y="222" text-anchor="middle" dominant-baseline="middle">ws = SIGNAL</text>
<rect class="b3" x="560" y="180" width="120" height="60" rx="8"/>
<text class="tb" x="620" y="200" text-anchor="middle" dominant-baseline="middle">T3（tail）</text>
<text class="ts" x="620" y="222" text-anchor="middle" dominant-baseline="middle">ws = 0</text>
<line class="l" x1="140" y1="198" x2="200" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="170" y="191" text-anchor="middle">next</text>
<line class="l" x1="200" y1="222" x2="140" y2="222" marker-end="url(#arr)"/>
<text class="ts" x="170" y="236" text-anchor="middle">prev</text>
<line class="l" x1="320" y1="198" x2="380" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="350" y="191" text-anchor="middle">next</text>
<line class="l" x1="380" y1="222" x2="320" y2="222" marker-end="url(#arr)"/>
<text class="ts" x="350" y="236" text-anchor="middle">prev</text>
<line class="l" x1="500" y1="198" x2="560" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="530" y="191" text-anchor="middle">next</text>
<line class="l" x1="560" y1="222" x2="500" y2="222" marker-end="url(#arr)"/>
<text class="ts" x="530" y="236" text-anchor="middle">prev</text>
</svg>
<figcaption>图 1：AQS 同步队列。持锁线程不在队列中（或对应 head），节点的 SIGNAL 表示「我释放时要唤醒后继」</figcaption>
</figure>

```java
// JDK 8 AbstractQueuedSynchronizer.Node（节选）
static final class Node {
    static final int CANCELLED =  1;   // 超时或中断而取消，会被跳过
    static final int SIGNAL    = -1;   // 后继需要被唤醒
    static final int CONDITION = -2;   // 在条件队列中
    static final int PROPAGATE = -3;   // 共享模式下唤醒需要继续传播
    volatile int waitStatus;
    volatile Node prev, next;
    volatile Thread thread;
    Node nextWaiter;                   // 条件队列链接 / 标记独占或共享模式
}
```

为什么叫「CLH 变体」：原始 CLH 锁是每个节点自旋在前驱的状态上的隐式单链表；AQS 保留了「前驱状态决定我是否该等」的思想（SIGNAL 记在前驱上），但改为显式双向链表 + park 阻塞，`prev` 用于处理取消节点，`next` 用于唤醒的快速路径。

## 独占模式：acquire 与 release

```java
// JDK 8 AQS（节选，中文注释为补充）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                               // 1. 子类尝试获取（可能插队）
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))    // 2. 失败则入队并在队列中等待
        selfInterrupt();                                  // 3. 等待期间被中断过：补上中断标志
}
private Node addWaiter(Node mode) {
    Node node = new Node(Thread.currentThread(), mode);
    Node pred = tail;
    if (pred != null) {
        node.prev = pred;                                 // ① 先设 prev
        if (compareAndSetTail(pred, node)) {              // ② CAS 成为新 tail
            pred.next = node;                             // ③ 最后设 next（非原子，可能暂时为 null）
            return node;
        }
    }
    enq(node);                                            // 队列为空或 CAS 失败：自旋入队，必要时初始化哑 head
    return node;
}
final boolean acquireQueued(final Node node, int arg) {
    boolean interrupted = false;
    for (;;) {
        final Node p = node.predecessor();
        if (p == head && tryAcquire(arg)) {               // 只有 head 的后继才有资格抢
            setHead(node);                                // 自己成为新的哑 head（thread 置 null）
            p.next = null;                                // help GC
            return interrupted;
        }
        if (shouldParkAfterFailedAcquire(p, node) &&      // 把前驱 ws 设为 SIGNAL，跳过已取消的前驱
            parkAndCheckInterrupt())                      // LockSupport.park(this)，醒来返回并清除中断标志
            interrupted = true;                           // acquire() 不响应中断，只记录
    }
}
public final boolean release(int arg) {
    if (tryRelease(arg)) {                                // 子类释放：state 归零才返回 true
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);                           // 唤醒后继
        return true;
    }
    return false;
}
private void unparkSuccessor(Node node) {
    // ...把 node.ws CAS 为 0
    Node s = node.next;
    if (s == null || s.waitStatus > 0) {                  // next 为空或已取消：
        s = null;
        for (Node t = tail; t != null && t != node; t = t.prev)  // 从 tail 向前找
            if (t.waitStatus <= 0) s = t;
    }
    if (s != null) LockSupport.unpark(s.thread);
}
```

> [!TIP] 为什么 unparkSuccessor 要从 tail 往前找？
> 入队是「先设 prev → CAS tail → 再设 next」，第 ③ 步之前 `pred.next` 可能还是 null；而 prev 链在 CAS 成功时一定已经完整。另外取消节点的处理也只保证 prev 链的正确性。所以从后往前遍历 prev 才能保证不漏掉节点。

> [!NOTE] JDK 14 起的 AQS 重写
> JDK 14 前后 Doug Lea 重写了 AQS：Node 拆成 `ExclusiveNode/SharedNode/ConditionNode`，`waitStatus` 改为 `status`，独占/共享/可中断/超时的获取逻辑合并到一个 `acquire(node, arg, shared, interruptible, timed, time)` 方法中，并在 park 前增加了少量自旋。思想（state + 双向队列 + 前驱唤醒）不变，面试按 JDK 8 源码讲即可，注明版本差异。

### 公平与非公平

```java
// JDK 8 ReentrantLock（节选）
final boolean nonfairTryAcquire(int acquires) {        // NonfairSync 使用
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        if (compareAndSetState(0, acquires)) {          // 直接 CAS 抢，不管队列里有没有人
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {  // 重入
        setState(c + acquires);                         // 只有持有者能走到这，无需 CAS
        return true;
    }
    return false;
}
protected final boolean tryAcquire(int acquires) {      // FairSync
    // ...
    if (c == 0) {
        if (!hasQueuedPredecessors() &&                 // 唯一区别：队列里有人排在我前面就不抢
            compareAndSetState(0, acquires)) { /* ... */ }
    }
    // ...
}
```

| 维度 | 非公平（默认） | 公平 |
| --- | --- | --- |
| 新到线程 | 先 CAS 插队，失败才排队 | 有人排队就直接排队 |
| 吞吐 | 高：减少「唤醒排队线程」的切换空窗 | 低：每次释放几乎都要一次 unpark + 上下文切换 |
| 饥饿 | 理论上可能 | 不会 |
| 注意 | — | `tryLock()` 无参版本**不遵守公平性**，总是插队 |

非公平之所以快：持有者释放后，被唤醒线程从 park 返回到真正运行需要几十微秒，这个空窗内新来的线程正好可以直接拿锁执行完。

### 可中断与超时

- `lockInterruptibly()` → `acquireInterruptibly` → `doAcquireInterruptibly`：park 醒来发现被中断，直接 `cancelAcquire(node)` 并抛 `InterruptedException`。
- `tryLock(timeout)` → `doAcquireNanos`：每轮计算剩余时间，用 `parkNanos` 等待；剩余时间小于 `spinForTimeoutThreshold`（JDK 8 中为 1000 纳秒）时不再 park 而是自旋，避免 park 本身的开销超过等待时间。超时返回 false 并取消节点。
- 取消的节点 `waitStatus = CANCELLED`，后续节点在 `shouldParkAfterFailedAcquire` 中会跳过它们重连 prev 链。

## 共享模式

- `tryAcquireShared` 返回值：**负数**失败；**0** 成功但后续共享获取不会成功；**正数**成功且后续可能也成功。
- `setHeadAndPropagate`：共享节点获取成功成为 head 后，如果还有剩余资源（返回值 > 0）或 PROPAGATE 标记，会继续唤醒后继的共享节点，形成「一个接一个」的连锁唤醒。`CountDownLatch` 计数归零时所有 `await` 线程就是这样被依次放行的。
- `PROPAGATE` 状态是为修复并发释放时传播丢失的 bug（JDK 6 时期的 Semaphore 问题）而引入的。

## Condition：条件队列与节点转移

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="Condition 的 await 与 signal 在条件队列和同步队列之间转移节点">
<rect class="b2" x="20" y="115" width="150" height="60" rx="8"/>
<text class="tb" x="95" y="136" text-anchor="middle" dominant-baseline="middle">持锁线程 T4</text>
<text class="ts" x="95" y="158" text-anchor="middle" dominant-baseline="middle">lock() 成功</text>
<rect class="bg" x="220" y="20" width="520" height="90" rx="10"/>
<text class="ts" x="232" y="40">条件队列（ConditionObject）：单向 nextWaiter，ws = CONDITION</text>
<rect class="b3" x="380" y="54" width="110" height="40" rx="6"/>
<text class="t" x="435" y="74" text-anchor="middle" dominant-baseline="middle">T4 · last</text>
<rect class="b3" x="520" y="54" width="110" height="40" rx="6"/>
<text class="t" x="575" y="74" text-anchor="middle" dominant-baseline="middle">T5 · first</text>
<line class="l" x1="520" y1="74" x2="490" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="130" x2="435" y2="94" marker-end="url(#arr)"/>
<text class="ts" x="250" y="146">① await：入队 → 完全释放锁 → park</text>
<rect class="bg" x="220" y="190" width="520" height="90" rx="10"/>
<text class="ts" x="232" y="210">同步队列（AQS）：双向 prev / next</text>
<rect class="b" x="240" y="224" width="110" height="40" rx="6"/>
<text class="t" x="295" y="244" text-anchor="middle" dominant-baseline="middle">head</text>
<rect class="b" x="380" y="224" width="110" height="40" rx="6"/>
<text class="t" x="435" y="244" text-anchor="middle" dominant-baseline="middle">T1</text>
<rect class="b5" x="520" y="224" width="110" height="40" rx="6"/>
<text class="t" x="575" y="244" text-anchor="middle" dominant-baseline="middle">T5（新 tail）</text>
<line class="l" x1="350" y1="238" x2="380" y2="238"/>
<line class="l" x1="490" y1="238" x2="520" y2="238"/>
<line class="la" x1="575" y1="94" x2="575" y2="224" marker-end="url(#arr-a)"/>
<text class="ta" x="583" y="152">② signal</text>
<text class="ts" x="583" y="172">CAS ws: -2 → 0</text>
<text class="ts" x="583" y="190">enq 到同步队列尾</text>
<line class="l" x1="240" y1="250" x2="95" y2="250"/>
<line class="l" x1="95" y1="250" x2="95" y2="175" marker-end="url(#arr)"/>
<text class="ts" x="20" y="300">③ 排到 head 之后并 acquireQueued 抢到锁（恢复原重入次数），才从 await() 返回</text>
</svg>
<figcaption>图 2：signal 并不直接唤醒线程去执行，而是把节点从条件队列搬到同步队列，让它重新排队抢锁</figcaption>
</figure>

```java
// JDK 8 AQS.ConditionObject（节选）
public final void await() throws InterruptedException {
    if (Thread.interrupted()) throw new InterruptedException();
    Node node = addConditionWaiter();          // 入条件队列尾，ws = CONDITION
    int savedState = fullyRelease(node);       // 完全释放（重入 3 次也一次性释放），记住原 state
    int interruptMode = 0;
    while (!isOnSyncQueue(node)) {             // 还没被 signal 转移到同步队列
        LockSupport.park(this);
        if ((interruptMode = checkInterruptWhileWaiting(node)) != 0) break;
    }
    if (acquireQueued(node, savedState) && interruptMode != THROW_IE)  // 重新抢锁并恢复重入次数
        interruptMode = REINTERRUPT;
    // ...清理取消节点、按 interruptMode 抛异常或补中断
}
final boolean transferForSignal(Node node) {   // signal 调用
    if (!compareAndSetWaitStatus(node, Node.CONDITION, 0))
        return false;                          // 已被取消（中断/超时）
    Node p = enq(node);                        // 加到同步队列尾，返回前驱
    int ws = p.waitStatus;
    if (ws > 0 || !compareAndSetWaitStatus(p, ws, Node.SIGNAL))
        LockSupport.unpark(node.thread);       // 前驱已取消或设置失败：直接唤醒让它自己去修正
    return true;
}
```

- `signal()` 必须持有锁（`isHeldExclusively()`），否则 `IllegalMonitorStateException`。
- 一个锁可以 `newCondition()` 多次：经典的有界缓冲区用 `notFull`、`notEmpty` 两个条件，生产者只唤醒消费者，避免 `notifyAll` 的惊群。`ArrayBlockingQueue` 正是这么实现的。
- 中断在 signal 之前发生 → await 抛 `InterruptedException`；在 signal 之后 → 只补中断标志。这是 `THROW_IE` 与 `REINTERRUPT` 两种模式的含义。

## ReentrantReadWriteLock

<figure class="fig">
<svg viewBox="0 0 760 160" class="dg" role="img" aria-label="ReentrantReadWriteLock 的 state 高 16 位为读计数、低 16 位为写计数">
<text class="ts" x="40" y="30">bit 31</text>
<text class="ts" x="380" y="30" text-anchor="middle">bit 16 | bit 15</text>
<text class="ts" x="720" y="30" text-anchor="end">bit 0</text>
<rect class="b2" x="40" y="40" width="340" height="50"/>
<text class="tb" x="210" y="65" text-anchor="middle" dominant-baseline="middle">高 16 位：读锁持有总数（所有线程）</text>
<rect class="b1" x="380" y="40" width="340" height="50"/>
<text class="tb" x="550" y="65" text-anchor="middle" dominant-baseline="middle">低 16 位：写锁重入次数</text>
<text class="tm" x="210" y="112" text-anchor="middle" dominant-baseline="middle">sharedCount(c) = c &gt;&gt;&gt; 16</text>
<text class="tm" x="550" y="112" text-anchor="middle" dominant-baseline="middle">exclusiveCount(c) = c &amp; 0xFFFF</text>
<text class="ts" x="380" y="142" text-anchor="middle">读锁 +1 即 c + 65536；每个线程自己的读重入次数另存在 ThreadLocal 的 HoldCounter 中</text>
</svg>
<figcaption>图 3：一个 int 同时编码读写两种计数，因此读锁、写锁最多各 65535 次</figcaption>
</figure>

获取规则（JDK 8 `Sync`，简化）：

- **写锁 tryAcquire**：`c != 0` 时，若 `w == 0`（有人持读锁）或持有者不是自己 → 失败。也就是说**只要有读锁，连自己都拿不到写锁**。
- **读锁 tryAcquireShared**：若写锁被**其他线程**持有 → 失败；否则 CAS 高 16 位 +1。自己持有写锁时可以再拿读锁——这就是锁降级的基础。
- 读重入计数：`firstReader/firstReaderHoldCount` 和 `cachedHoldCounter` 做快速路径，其余线程走 `ThreadLocal<HoldCounter>`。
- 非公平模式下 `readerShouldBlock()` 会检查**队列第一个等待者是否是写线程**（`apparentlyFirstQueuedIsExclusive`），是则读线程不插队，缓解写饥饿。

```java
// 锁降级：持写锁 → 获取读锁 → 释放写锁（改编自 JDK javadoc 的 CachedData 示例）
rwl.writeLock().lock();
try {
    if (!cacheValid) { data = load(); cacheValid = true; }
    rwl.readLock().lock();        // 降级：在释放写锁前先拿读锁，保证随后读到的是自己刚写的数据
} finally {
    rwl.writeLock().unlock();     // 现在只持有读锁，其他读线程可以并发进入
}
try { use(data); } finally { rwl.readLock().unlock(); }
```

> [!CAUTION] 读锁升级为写锁会死锁
> 持有读锁时调用 `writeLock().lock()`：写锁要求读计数为 0，而读计数里就有自己，于是永远等待。不支持升级是刻意设计——两个读线程同时尝试升级必然互相等待。

## StampedLock（JDK 8）

```java
// 改编自 JDK javadoc 的 Point 示例
private final StampedLock sl = new StampedLock();
double distanceFromOrigin() {
    long stamp = sl.tryOptimisticRead();        // 不加锁，只拿一个版本戳
    double cx = x, cy = y;                      // 读到局部变量
    if (!sl.validate(stamp)) {                  // 期间有写发生：版本变了
        stamp = sl.readLock();                  // 退化为悲观读锁
        try { cx = x; cy = y; } finally { sl.unlockRead(stamp); }
    }
    return Math.sqrt(cx * cx + cy * cy);
}
```

| 特性 | ReentrantReadWriteLock | StampedLock |
| --- | --- | --- |
| 乐观读 | 无 | 有：读不写共享变量，写线程不会被读阻塞 |
| 可重入 | 是 | **否**，同线程重复获取写锁会死锁 |
| Condition | 写锁支持 | 不支持 |
| 锁转换 | 仅降级 | `tryConvertToWriteLock` 等可尝试升级 |
| 实现 | AQS | 自己维护 `long state`（版本位 + 写位 + 读计数）与 CLH 队列 |

注意：乐观读期间读到的字段可能是不一致的中间状态，**validate 之前不能基于这些值做有副作用的操作**（如数组下标访问可能越界）；被中断的线程在 `readLock()/writeLock()` 上的行为在早期 JDK 8 版本中有过 CPU 飙高的问题报告，需要响应中断时使用 `readLockInterruptibly()` 等方法。

## LockSupport：park / unpark

- 每个线程有一个**许可（permit）**，最多为 1，不累加。`unpark(t)` 置许可为 1；`park()` 若有许可则消耗并立即返回，否则阻塞。
- 因此 **unpark 可以先于 park 调用**，不会像 `notify` 先于 `wait` 那样丢失信号；也不需要持有任何锁。
- `park` 返回的情况：被 unpark、被中断（**不抛异常、不清标志**）、超时、**无理由的虚假返回**——调用方必须在循环中重新检查条件。
- HotSpot 中每个线程有一个 `Parker` 对象，Linux 上基于 `pthread_mutex` + `pthread_cond` 实现。
- 用 `park(Object blocker)`：jstack 中会显示 `parking to wait for <0x...> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)`，排查时能直接看出在等哪把锁。

## 用 AQS 自定义同步器

```java
// 不可重入的互斥锁：state 0 = 未锁，1 = 已锁（改编自 AQS javadoc 的 Mutex 示例）
public class Mutex implements Lock {
    private static final class Sync extends AbstractQueuedSynchronizer {
        @Override protected boolean tryAcquire(int arg) {
            if (compareAndSetState(0, 1)) {
                setExclusiveOwnerThread(Thread.currentThread());
                return true;
            }
            return false;
        }
        @Override protected boolean tryRelease(int arg) {
            if (getState() == 0) throw new IllegalMonitorStateException();
            setExclusiveOwnerThread(null);
            setState(0);                       // volatile 写，发布临界区内的修改
            return true;
        }
        @Override protected boolean isHeldExclusively() {
            return getExclusiveOwnerThread() == Thread.currentThread();
        }
        Condition newCondition() { return new ConditionObject(); }
    }
    private final Sync sync = new Sync();
    public void lock()                 { sync.acquire(1); }
    public boolean tryLock()           { return sync.tryAcquire(1); }
    public void unlock()               { sync.release(1); }
    public void lockInterruptibly() throws InterruptedException { sync.acquireInterruptibly(1); }
    public boolean tryLock(long t, TimeUnit u) throws InterruptedException {
        return sync.tryAcquireNanos(1, u.toNanos(t));
    }
    public Condition newCondition()    { return sync.newCondition(); }
}

// 一次性开关（共享模式）：signal 前所有 await 阻塞，signal 后全部放行
class BooleanLatch {
    private static final class Sync extends AbstractQueuedSynchronizer {
        protected int tryAcquireShared(int ignore) { return getState() != 0 ? 1 : -1; }
        protected boolean tryReleaseShared(int ignore) { setState(1); return true; }
    }
    private final Sync sync = new Sync();
    public void signal() { sync.releaseShared(1); }
    public void await() throws InterruptedException { sync.acquireSharedInterruptibly(1); }
}
```

要点：AQS 已经处理好排队、阻塞、唤醒、中断和超时，子类只负责「state 怎样算获取成功」。`tryXxx` 方法要非阻塞、快速、线程安全（用 CAS 或仅持有者可写的 `setState`）。

## 生产实践与踩坑

> [!CAUTION] lock() 写在 try 里面
> 写成 `try { lock.lock(); ... } finally { lock.unlock(); }` 时，若 `lock()` 之前或其本身抛异常（如 `lockInterruptibly` 被中断），finally 中 `unlock()` 会抛 `IllegalMonitorStateException` 并**覆盖原始异常**。正确写法是 `lock.lock();` 放在 `try` 之前紧挨着。

> [!WARNING] tryLock 后无条件 unlock
> `if (!lock.tryLock()) {...}` 分支外的 finally 里直接 `unlock()`，没拿到锁的线程解锁会抛异常。用 `if (lock.tryLock()) { try {...} finally { lock.unlock(); } }` 结构。

> [!WARNING] 读写锁写饥饿与性能误判
> 读线程持续涌入时写线程可能长时间等待；而且读锁获取本身也要 CAS 修改 state 并维护 HoldCounter，**临界区很短时读写锁未必比 ReentrantLock 快**。读多写少且读临界区较长才值得用；极端读多写少考虑 StampedLock 乐观读或 Copy-On-Write。

- 排查「卡住」：jstack 中大量线程 `parking to wait for <0xABC>`，再搜 `<0xABC>` 的 `Locked ownable synchronizers` 段即可找到持锁线程（需要 `jstack -l`）。
- `ReentrantLock` 可通过 `getQueueLength()`、`getHoldCount()`、`isLocked()` 暴露到监控；自定义同步器也建议提供类似方法。
- 不要在 `Condition.await` 外用 `if` 判断条件：同样存在虚假唤醒，必须 `while`。

## 相关阅读

- [Java 内存模型与 volatile](#/java/concurrency/jmm)：volatile、CAS 的内存语义
- [并发工具与 CompletableFuture](#/java/concurrency/juc)：基于 AQS 的并发工具类
- [进程、线程与 CPU 调度](#/cs/os-process)：futex、park/unpark 与阻塞唤醒的底层
- [分布式锁](#/redis/lock)：分布式锁：单机锁语义的延伸与局限

## 面试追问

> [!QUESTION] AQS 为什么要用双向链表？只用单链表行不行？
> 取消节点时需要找到有效前驱并重连（`prev`），线程判断「前驱是否为 head」也要用 prev；唤醒时用 `next` 快速定位后继，next 不可靠时再从 tail 沿 prev 回溯。单链表无法高效处理中间节点取消。

> [!QUESTION] 线程被 unpark 后一定能拿到锁吗？
> 不一定。非公平模式下被唤醒线程要再次 tryAcquire，可能被新来的线程抢先，失败后重新 park。这也是 acquireQueued 是一个 for 循环的原因。

> [!QUESTION] Condition 的 await 和 Object.wait 有什么异同？
> 都会释放锁、等待通知、返回前重新获得锁，都需要 while 防虚假唤醒。不同：Condition 一个锁可以有多个条件队列；支持 `awaitUninterruptibly`、`awaitNanos`、`awaitUntil`；实现上是 AQS 条件队列 + park，而 wait 是 ObjectMonitor 的 WaitSet。

> [!QUESTION] 读写锁为什么不支持升级？锁降级的意义是什么？
> 升级需要等所有读锁释放，若两个读线程同时升级会互相等待对方的读锁，必然死锁。降级（持写拿读再放写）保证在释放写锁到读取数据之间没有其他写线程插入，读到的正是自己写的版本，同时尽早允许其他读线程并发。

> [!QUESTION] LockSupport.park 和 Object.wait、Thread.sleep 的区别？
> park 不需要持有锁、不释放任何锁，基于许可所以 unpark 可以先于 park；响应中断但不抛异常。wait 必须持有 monitor 并会释放它；sleep 不释放锁、被中断时抛异常。AQS 和几乎所有 JUC 阻塞都建立在 park 之上。
