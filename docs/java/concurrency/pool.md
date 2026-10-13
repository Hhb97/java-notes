---
level: 深入
tags: [ThreadPoolExecutor, 线程池, 动态调参, ForkJoinPool, 优雅关闭]
summary: 从 ctl 位运算、execute 流程、Worker 设计到参数估算、动态调参、监控、异常与关闭，覆盖线程池在生产中的全部关键点
---

# 线程池原理与调优

> [!ABSTRACT] 核心要点
> - `ctl` 一个 `AtomicInteger` 同时存**运行状态（高 3 位）**和**线程数（低 29 位）**，保证「状态 + 线程数」的联合判断可以用一次 CAS 完成。
> - 提交顺序：**核心线程 → 队列 → 非核心线程 → 拒绝**。队列不满就不会扩到 max，所以「无界队列 + 大 max」等于 max 失效。
> - `Worker` 继承 AQS 实现一把**不可重入**锁，用来标记「是否正在执行任务」，让 `shutdown`/调参只中断空闲线程。
> - `Executors` 的工厂方法要么无界队列（OOM），要么无界线程数（线程爆炸），生产环境应显式 new `ThreadPoolExecutor` 并命名、限界、设置拒绝策略。
> - `submit` 会把异常封进 `Future`，不 `get()` 就永远看不到；关闭要 `shutdown → awaitTermination → shutdownNow` 三段式。

## 构造参数

```java
new ThreadPoolExecutor(
    corePoolSize,      // 核心线程数：默认不会因空闲而回收
    maximumPoolSize,   // 最大线程数：队列满后才会扩到这里
    keepAliveTime, unit, // 非核心线程（或 allowCoreThreadTimeOut 时的核心线程）空闲存活时间
    workQueue,         // 任务队列：决定了排队与扩容行为
    threadFactory,     // 线程命名、daemon、UncaughtExceptionHandler
    handler);          // 拒绝策略，默认 AbortPolicy
```

| 队列 | 特点 | 典型用途 |
| --- | --- | --- |
| `ArrayBlockingQueue(n)` | 有界数组，单锁 | 通用，需要明确上限 |
| `LinkedBlockingQueue(n)` | 链表，读写双锁；**不传容量即 `Integer.MAX_VALUE`** | 通用；必须指定容量 |
| `SynchronousQueue` | 不存储，直接移交 | 希望尽快扩线程（`newCachedThreadPool`） |
| `PriorityBlockingQueue` | 无界优先级堆 | 按优先级调度，注意无界 |
| `DelayedWorkQueue` | 内部小顶堆 | `ScheduledThreadPoolExecutor` 专用 |

## ctl：状态与线程数打包

```java
// JDK 17 ThreadPoolExecutor（节选）
private final AtomicInteger ctl = new AtomicInteger(ctlOf(RUNNING, 0));
private static final int COUNT_BITS = Integer.SIZE - 3;          // 29
private static final int COUNT_MASK = (1 << COUNT_BITS) - 1;     // JDK 8 中叫 CAPACITY
private static final int RUNNING    = -1 << COUNT_BITS;          // 111
private static final int SHUTDOWN   =  0 << COUNT_BITS;          // 000
private static final int STOP       =  1 << COUNT_BITS;          // 001
private static final int TIDYING    =  2 << COUNT_BITS;          // 010
private static final int TERMINATED =  3 << COUNT_BITS;          // 011
private static int runStateOf(int c)     { return c & ~COUNT_MASK; }
private static int workerCountOf(int c)  { return c & COUNT_MASK; }
private static int ctlOf(int rs, int wc) { return rs | wc; }
private static boolean isRunning(int c)  { return c < SHUTDOWN; } // 只有 RUNNING 是负数
```

<figure class="fig">
<svg viewBox="0 0 760 265" class="dg" role="img" aria-label="ctl 位布局与线程池五种状态的转换">
<rect class="b4" x="20" y="20" width="180" height="40"/>
<text class="t" x="110" y="40" text-anchor="middle" dominant-baseline="middle">runState（高 3 位）</text>
<rect class="b1" x="200" y="20" width="540" height="40"/>
<text class="t" x="470" y="40" text-anchor="middle" dominant-baseline="middle">workerCount（低 29 位，上限 2^29 - 1）</text>
<rect class="b2" x="20" y="125" width="120" height="56" rx="8"/>
<text class="tb" x="80" y="145" text-anchor="middle" dominant-baseline="middle">RUNNING</text>
<text class="tm" x="80" y="166" text-anchor="middle" dominant-baseline="middle">111（负数）</text>
<rect class="b3" x="250" y="80" width="120" height="56" rx="8"/>
<text class="tb" x="310" y="100" text-anchor="middle" dominant-baseline="middle">SHUTDOWN</text>
<text class="tm" x="310" y="121" text-anchor="middle" dominant-baseline="middle">000</text>
<rect class="b4" x="250" y="170" width="120" height="56" rx="8"/>
<text class="tb" x="310" y="190" text-anchor="middle" dominant-baseline="middle">STOP</text>
<text class="tm" x="310" y="211" text-anchor="middle" dominant-baseline="middle">001</text>
<rect class="b5" x="470" y="125" width="120" height="56" rx="8"/>
<text class="tb" x="530" y="145" text-anchor="middle" dominant-baseline="middle">TIDYING</text>
<text class="tm" x="530" y="166" text-anchor="middle" dominant-baseline="middle">010</text>
<rect class="b" x="625" y="125" width="120" height="56" rx="8"/>
<text class="tb" x="685" y="145" text-anchor="middle" dominant-baseline="middle">TERMINATED</text>
<text class="tm" x="685" y="166" text-anchor="middle" dominant-baseline="middle">011</text>
<line class="l" x1="140" y1="140" x2="250" y2="108" marker-end="url(#arr)"/>
<text class="ts" x="190" y="112" text-anchor="middle">shutdown()</text>
<line class="l" x1="140" y1="166" x2="250" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="190" y="208" text-anchor="middle">shutdownNow()</text>
<line class="l" x1="310" y1="136" x2="310" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="318" y="157">shutdownNow()</text>
<line class="l" x1="370" y1="108" x2="470" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="420" y="104" text-anchor="middle">队列空且 wc = 0</text>
<line class="l" x1="370" y1="198" x2="470" y2="166" marker-end="url(#arr)"/>
<text class="ts" x="420" y="210" text-anchor="middle">wc = 0</text>
<line class="la" x1="590" y1="153" x2="625" y2="153" marker-end="url(#arr-a)"/>
<text class="ts" x="530" y="200" text-anchor="middle">执行 terminated()</text>
<text class="ts" x="685" y="200" text-anchor="middle">awaitTermination 返回</text>
<text class="ts" x="380" y="252" text-anchor="middle">状态值单调递增：RUNNING &lt; SHUTDOWN &lt; STOP &lt; TIDYING &lt; TERMINATED，可直接用整数比较</text>
</svg>
<figcaption>图 1：ctl 位布局与线程池状态机。SHUTDOWN 不接新任务但处理完队列，STOP 不接新任务、清空队列并中断所有线程</figcaption>
</figure>

## execute 流程

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="ThreadPoolExecutor.execute 的三步决策流程">
<rect class="b1" x="20" y="25" width="130" height="40" rx="8"/>
<text class="tb" x="85" y="45" text-anchor="middle" dominant-baseline="middle">execute(task)</text>
<line class="l" x1="150" y1="45" x2="200" y2="45" marker-end="url(#arr)"/>
<rect class="b3" x="200" y="25" width="240" height="40" rx="20"/>
<text class="t" x="320" y="45" text-anchor="middle" dominant-baseline="middle">wc &lt; corePoolSize ?</text>
<rect class="b3" x="200" y="115" width="240" height="40" rx="20"/>
<text class="t" x="320" y="135" text-anchor="middle" dominant-baseline="middle">RUNNING 且入队成功？</text>
<rect class="b3" x="200" y="205" width="240" height="40" rx="20"/>
<text class="t" x="320" y="225" text-anchor="middle" dominant-baseline="middle">wc &lt; maximumPoolSize ?</text>
<rect class="b4" x="200" y="285" width="240" height="40" rx="8"/>
<text class="tb" x="320" y="305" text-anchor="middle" dominant-baseline="middle">reject(task) → 拒绝策略</text>
<line class="l" x1="320" y1="65" x2="320" y2="115" marker-end="url(#arr)"/>
<text class="ts" x="328" y="94">否</text>
<line class="l" x1="320" y1="155" x2="320" y2="205" marker-end="url(#arr)"/>
<text class="ts" x="328" y="184">否（队列满）</text>
<line class="l" x1="320" y1="245" x2="320" y2="285" marker-end="url(#arr)"/>
<text class="ts" x="328" y="270">否</text>
<line class="la" x1="440" y1="45" x2="490" y2="45" marker-end="url(#arr-a)"/>
<text class="ts" x="465" y="37" text-anchor="middle">是</text>
<line class="la" x1="440" y1="135" x2="490" y2="135" marker-end="url(#arr-a)"/>
<text class="ts" x="465" y="127" text-anchor="middle">是</text>
<line class="la" x1="440" y1="225" x2="490" y2="225" marker-end="url(#arr-a)"/>
<text class="ts" x="465" y="217" text-anchor="middle">是</text>
<rect class="b2" x="490" y="18" width="250" height="54" rx="8"/>
<text class="tm" x="615" y="38" text-anchor="middle" dominant-baseline="middle">addWorker(task, true)</text>
<text class="ts" x="615" y="58" text-anchor="middle" dominant-baseline="middle">新建核心线程，task 作为 firstTask</text>
<rect class="b2" x="490" y="108" width="250" height="54" rx="8"/>
<text class="t" x="615" y="128" text-anchor="middle" dominant-baseline="middle">进入 workQueue 排队</text>
<text class="ts" x="615" y="148" text-anchor="middle" dominant-baseline="middle">复查：停止则移除并拒绝，无线程则补一个</text>
<rect class="b2" x="490" y="198" width="250" height="54" rx="8"/>
<text class="tm" x="615" y="218" text-anchor="middle" dominant-baseline="middle">addWorker(task, false)</text>
<text class="ts" x="615" y="238" text-anchor="middle" dominant-baseline="middle">新建非核心线程</text>
<rect class="bg" x="20" y="110" width="160" height="130" rx="10"/>
<text class="tb" x="32" y="132">Worker 循环</text>
<text class="ts" x="32" y="154">先执行 firstTask</text>
<text class="ts" x="32" y="174">再循环 getTask() 取任务</text>
<text class="ts" x="32" y="194">超时取不到则退出</text>
<text class="ts" x="32" y="214">直到线程数降到 core</text>
</svg>
<figcaption>图 2：execute 的决策顺序：先核心线程，再排队，队列满了才扩到最大线程数，最后拒绝</figcaption>
</figure>

```java
// JDK 17 ThreadPoolExecutor#execute（节选）
public void execute(Runnable command) {
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) {               // 1. 核心线程未满：直接建线程
        if (addWorker(command, true)) return;
        c = ctl.get();                                   //    失败（并发/状态变化）则继续往下
    }
    if (isRunning(c) && workQueue.offer(command)) {      // 2. 入队
        int recheck = ctl.get();
        if (!isRunning(recheck) && remove(command))      //    入队后池被关闭：撤回并拒绝
            reject(command);
        else if (workerCountOf(recheck) == 0)            //    核心线程为 0 或都超时退出了：
            addWorker(null, false);                      //    补一个线程，保证队列有人消费
    }
    else if (!addWorker(command, false))                 // 3. 队列满：尝试非核心线程
        reject(command);                                 // 4. 也失败：拒绝
}
```

`addWorker` 分两步：先在自旋中 CAS 把 `workerCount + 1`（同时检查状态和上限），成功后再 new `Worker`、在 `mainLock` 保护下加入 `HashSet<Worker> workers`、启动线程；启动失败则 `addWorkerFailed` 回滚计数。

### Worker 为什么继承 AQS

```java
// JDK 17 ThreadPoolExecutor.Worker（节选）
private final class Worker extends AbstractQueuedSynchronizer implements Runnable {
    final Thread thread;
    Runnable firstTask;
    volatile long completedTasks;
    Worker(Runnable firstTask) {
        setState(-1);                        // 构造到 runWorker 开始前禁止被中断
        this.firstTask = firstTask;
        this.thread = getThreadFactory().newThread(this);
    }
    protected boolean tryAcquire(int unused) {  // 不可重入：只认 0 → 1
        if (compareAndSetState(0, 1)) { setExclusiveOwnerThread(Thread.currentThread()); return true; }
        return false;
    }
    // ...
}
final void runWorker(Worker w) {
    Runnable task = w.firstTask; w.firstTask = null;
    w.unlock();                               // state 从 -1 变 0，此后允许中断
    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) {
            w.lock();                         // 标记「忙」
            // 若池已 STOP 确保线程被中断，否则清除残留中断标志
            try {
                beforeExecute(w.thread, task);
                task.run();
                afterExecute(task, null);     // 异常时 afterExecute(task, ex) 后继续抛出
            } finally { task = null; w.completedTasks++; w.unlock(); }
        }
        completedAbruptly = false;
    } finally {
        processWorkerExit(w, completedAbruptly);  // 异常退出会补建一个新 Worker
    }
}
```

- `interruptIdleWorkers()` 对每个 Worker 先 `w.tryLock()`，**能拿到锁说明它空闲**（阻塞在 `getTask()`），才中断它；正在跑任务的 Worker 锁被自己持有，不会被打断。`shutdown()`、`setCorePoolSize()` 缩容、`allowCoreThreadTimeOut(true)` 都用这个方法。
- 为什么不用 `ReentrantLock`：它是可重入的，若任务代码里调用了 `setCorePoolSize` 之类的方法，线程会成功「重入」自己的锁并把自己当成空闲线程中断。
- `getTask()` 中，`timed = allowCoreThreadTimeOut || wc > corePoolSize`：为 true 时用 `workQueue.poll(keepAliveTime)`，超时返回 null，Worker 退出；否则 `take()` 永久阻塞——**核心线程不回收就是这么实现的**，并没有给线程打「核心」标签。

## 拒绝策略

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| `AbortPolicy`（默认） | 抛 `RejectedExecutionException` | 调用方能感知并处理（降级/重试） |
| `CallerRunsPolicy` | 由提交线程自己执行 | 天然反压，但会拖慢提交线程（如 Tomcat 线程），关闭后的池直接丢弃 |
| `DiscardPolicy` | 静默丢弃 | 几乎不应使用，丢了也不知道 |
| `DiscardOldestPolicy` | 丢弃队头最老任务再重试提交 | 只关心最新数据的场景；与优先级队列一起用会丢掉最高优先级任务 |
| 自定义 | 记录指标 + 告警 + 持久化/MQ 兜底 | 生产推荐 |

## Executors 的坑

| 工厂方法 | 实际配置 | 风险 |
| --- | --- | --- |
| `newFixedThreadPool(n)` | core = max = n，`LinkedBlockingQueue()` 无界 | 任务堆积 → OOM |
| `newSingleThreadExecutor()` | 同上，n = 1 | 同上；且被包装后无法强转调参 |
| `newCachedThreadPool()` | core 0，max `Integer.MAX_VALUE`，`SynchronousQueue` | 突发流量创建海量线程 → `unable to create native thread` |
| `newScheduledThreadPool(n)` | `DelayedWorkQueue` 无界 | 任务堆积 → OOM |
| `newWorkStealingPool()` | `ForkJoinPool`，并行度 = CPU 数 | 不适合阻塞任务 |
| `newVirtualThreadPerTaskExecutor()`（JDK 21） | 每任务一个虚拟线程 | 无上限，需自己用 Semaphore 限流 |

## 线程数估算与压测

- **CPU 密集**：约 `N_cpu + 1`（多出的一个用于填补偶发缺页/停顿）。
- **IO 密集**：`N_threads = N_cpu × U_cpu × (1 + W / C)`（《Java 并发编程实战》），W/C 为等待时间与计算时间之比。例：8 核、期望 CPU 利用率 80%、每次请求计算 10ms 等待 90ms → 8 × 0.8 × 10 = 64。
- **从吞吐反推（Little 定律）**：并发数 = 吞吐 × 平均耗时。目标 1000 QPS、平均 RT 50ms → 需要约 50 个并发处理单元，再留余量。
- 队列长度：`可接受排队时间 × 吞吐`。例如最多容忍排队 200ms、吞吐 500/s → 队列约 100。队列过长只会把超时从「拒绝」变成「排队超时」，并让内存里堆积大量请求对象。

公式只给起点，**最终以压测为准**：固定 RT 目标逐步加压，观察 CPU、RT 的 P99、队列长度和拒绝数的拐点。同一个进程里若有多个池，要合起来看总线程数与 CPU 竞争。容器中注意 `availableProcessors()` 返回的是 cgroup 配额（JDK 10+ 及 8u191+ 支持容器感知）。

## 动态调参

`ThreadPoolExecutor` 原生支持运行期修改：

| 方法 | 行为 |
| --- | --- |
| `setCorePoolSize(n)` | 调小：中断多余的空闲线程；调大：按需预启动新线程去消费队列。JDK 9+ 若 `n > maximumPoolSize` 抛 `IllegalArgumentException` |
| `setMaximumPoolSize(n)` | 小于 core 时抛异常；调小时中断空闲线程 |
| `setKeepAliveTime`、`allowCoreThreadTimeOut` | 即时生效 |
| `setRejectedExecutionHandler` | 即时生效 |
| `prestartAllCoreThreads()` | 启动时预热全部核心线程 |

```java
// 扩容：先调 max 再调 core；缩容：先调 core 再调 max，避免 core > max 的瞬间抛异常
if (newCore > executor.getMaximumPoolSize()) {
    executor.setMaximumPoolSize(newMax);
    executor.setCorePoolSize(newCore);
} else {
    executor.setCorePoolSize(newCore);
    executor.setMaximumPoolSize(newMax);
}
```

队列容量是难点：`LinkedBlockingQueue` 的 `capacity` 是 `final` 的。业界做法（美团技术团队公开的动态线程池方案、开源项目 DynamicTp、Hippo4j 等）是拷贝一份队列实现、把容量改为可修改的 volatile 字段，再配合配置中心推送参数、上报监控、阈值告警。

## 监控指标

| 指标 | 来源 | 告警含义 |
| --- | --- | --- |
| 活跃度 = `getActiveCount() / getMaximumPoolSize()` | 采样 | 持续接近 1：线程不够或下游变慢 |
| 队列积压 `getQueue().size()`、剩余容量 `remainingCapacity()` | 采样 | 持续增长：消费跟不上 |
| 拒绝次数 | 自定义拒绝策略计数 | 大于 0 即需关注 |
| 任务耗时、排队耗时 | 包装任务记录提交时间，`beforeExecute/afterExecute` 计时 | P99 劣化定位 |
| `getPoolSize()`、`getLargestPoolSize()` | 采样 | 是否曾扩到 max |
| `getCompletedTaskCount()`、`getTaskCount()` | 采样（近似值） | 吞吐 |

Spring Boot + Micrometer 可用 `ExecutorServiceMetrics` 直接绑定线程池，暴露到 Prometheus。

## 异常处理：submit 吞异常

```java
pool.execute(() -> { throw new RuntimeException("boom"); });
// → 异常从 runWorker 抛出，线程死亡并被替换，UncaughtExceptionHandler（默认打印 stderr）可见

Future<?> f = pool.submit(() -> { throw new RuntimeException("boom"); });
// → 任务被包装成 FutureTask，run() 中 catch Throwable 存入 outcome，什么都不打印
//   只有 f.get() 时才以 ExecutionException 抛出
```

统一处理方式：

```java
@Override
protected void afterExecute(Runnable r, Throwable t) {
    super.afterExecute(r, t);
    if (t == null && r instanceof Future<?> f && f.isDone()) {   // submit 提交的任务 t 永远是 null
        try { f.get(); }
        catch (CancellationException ce) { t = ce; }
        catch (ExecutionException ee) { t = ee.getCause(); }
        catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }
    if (t != null) log.error("task failed", t);
}
```

另外 `execute` 抛异常会导致线程销毁重建，频繁异常时线程反复创建，任务里最好自己 catch 住。

## 优雅关闭

```java
void shutdownGracefully(ExecutorService pool) {
    pool.shutdown();                                        // 1. 不再接收新任务，队列中的继续执行
    try {
        if (!pool.awaitTermination(30, TimeUnit.SECONDS)) { // 2. 等待一段时间
            List<Runnable> dropped = pool.shutdownNow();    // 3. 中断所有线程，返回未执行的任务
            log.warn("dropped {} tasks", dropped.size());   //    可持久化以便重放
            pool.awaitTermination(10, TimeUnit.SECONDS);    // 4. 再给响应中断一点时间
        }
    } catch (InterruptedException e) {
        pool.shutdownNow();
        Thread.currentThread().interrupt();
    }
}
```

- `shutdownNow` 只是中断：任务代码若吞中断或阻塞在不可中断的 IO 上，依旧停不下来。
- JDK 19+ `ExecutorService` 实现了 `AutoCloseable`，`close()` 会 shutdown 并等待所有任务完成，可配合 try-with-resources。
- Spring 的 `ThreadPoolTaskExecutor` 设置 `waitForTasksToCompleteOnShutdown=true` 与 `awaitTerminationSeconds`，并保证线程池 Bean 晚于依赖资源（如数据源）销毁。

## ScheduledThreadPoolExecutor

- 继承 `ThreadPoolExecutor`，使用无界 `DelayedWorkQueue`（基于小顶堆，按触发时间排序），所以 **maximumPoolSize 实际无效**，线程数恒为 core。
- `scheduleAtFixedRate`：按固定频率，以上次**开始**时间计算；任务耗时超过周期时不会并发执行，而是下一次紧接着执行。`scheduleWithFixedDelay`：以上次**结束**时间加延迟计算。
- 周期任务**一旦抛出异常，后续执行全部取消，且没有任何日志**：任务体内必须 try-catch 全部异常。
- 取队列用 Leader-Follower 模式：只有一个 leader 线程按堆顶剩余延迟 `awaitNanos`，其他线程无限期等待，避免所有线程同时定时醒来。
- 被取消的任务默认仍留在队列中直到到期，大量 cancel 时设置 `setRemoveOnCancelPolicy(true)`。

## ForkJoinPool 与工作窃取

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="ForkJoinPool 每个工作线程拥有双端队列，空闲线程从其他队列的 base 端窃取任务">
<rect class="b5" x="20" y="20" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="42" text-anchor="middle" dominant-baseline="middle">外部线程</text>
<rect class="b" x="170" y="20" width="50" height="44"/>
<text class="t" x="195" y="42" text-anchor="middle" dominant-baseline="middle">T</text>
<rect class="b" x="220" y="20" width="50" height="44"/>
<text class="t" x="245" y="42" text-anchor="middle" dominant-baseline="middle">T</text>
<rect class="b" x="270" y="20" width="200" height="44"/>
<line class="l" x1="130" y1="42" x2="170" y2="42" marker-end="url(#arr)"/>
<text class="ts" x="490" y="46">外部提交进入共享队列（偶数槽）</text>
<text class="ts" x="195" y="84" text-anchor="middle">base</text>
<text class="ts" x="445" y="84" text-anchor="middle">top</text>
<rect class="b1" x="20" y="90" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="112" text-anchor="middle" dominant-baseline="middle">Worker 1</text>
<rect class="b3" x="170" y="90" width="50" height="44"/>
<text class="t" x="195" y="112" text-anchor="middle" dominant-baseline="middle">t1</text>
<rect class="b3" x="220" y="90" width="50" height="44"/>
<text class="t" x="245" y="112" text-anchor="middle" dominant-baseline="middle">t2</text>
<rect class="b3" x="270" y="90" width="50" height="44"/>
<text class="t" x="295" y="112" text-anchor="middle" dominant-baseline="middle">t3</text>
<rect class="b3" x="320" y="90" width="50" height="44"/>
<text class="t" x="345" y="112" text-anchor="middle" dominant-baseline="middle">t4</text>
<rect class="b3" x="370" y="90" width="50" height="44"/>
<text class="t" x="395" y="112" text-anchor="middle" dominant-baseline="middle">t5</text>
<rect class="b" x="420" y="90" width="50" height="44"/>
<text class="ts" x="490" y="106">每个 worker 一个双端队列（奇数槽）</text>
<text class="ts" x="490" y="124">自己 fork / 取任务：top 端 LIFO</text>
<rect class="b1" x="20" y="160" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="182" text-anchor="middle" dominant-baseline="middle">Worker 2</text>
<rect class="b3" x="170" y="160" width="50" height="44"/>
<text class="t" x="195" y="182" text-anchor="middle" dominant-baseline="middle">u1</text>
<rect class="b3" x="220" y="160" width="50" height="44"/>
<text class="t" x="245" y="182" text-anchor="middle" dominant-baseline="middle">u2</text>
<rect class="b3" x="270" y="160" width="50" height="44"/>
<text class="t" x="295" y="182" text-anchor="middle" dominant-baseline="middle">u3</text>
<rect class="b" x="320" y="160" width="150" height="44"/>
<text class="ts" x="490" y="186">LIFO 处理刚 fork 的小任务，缓存局部性好</text>
<rect class="b1" x="20" y="230" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="252" text-anchor="middle" dominant-baseline="middle">Worker 3</text>
<rect class="b" x="170" y="230" width="300" height="44"/>
<text class="ts" x="320" y="256" text-anchor="middle">空</text>
<line class="la" x1="195" y1="230" x2="195" y2="204" marker-end="url(#arr-a)"/>
<text class="ta" x="205" y="221">窃取 base 端（FIFO）</text>
<text class="ts" x="490" y="256">队列空：扫描其他队列，从 base 端偷</text>
</svg>
<figcaption>图 3：工作窃取。所有者与窃取者在双端队列的两端操作，竞争很少；base 端多是较早 fork 出来的大任务，偷一个能分到更多工作</figcaption>
</figure>

- 适合**可分治、无阻塞**的计算任务（`RecursiveTask`、并行流）。`join()` 时当前 worker 不会傻等，而是尝试执行其他任务（helpJoin / tryCompensate），阻塞过多时可能补偿创建线程。
- `ForkJoinPool.commonPool()` 并行度默认 `CPU 数 - 1`（可用 `-Djava.util.concurrent.ForkJoinPool.common.parallelism` 调整），被并行流、`CompletableFuture` 默认异步方法共享——**在里面做阻塞 IO 会拖垮整个进程的并行流和异步任务**，详见 [并发工具与 CompletableFuture](#/java/concurrency/juc)。
- 阻塞任务若必须跑在 FJP 中，用 `ForkJoinPool.managedBlock` 通知池补偿线程。

## 线程池隔离

- **按业务/依赖隔离**（舱壁模式）：核心下单与非核心推荐、不同下游服务各用独立线程池，一个下游变慢只会耗尽自己的池。Hystrix 的线程池隔离、Sentinel 的并发数限制都是这一思路，见 [限流、熔断与降级](#/distributed/governance)。
- **父子任务不要共用一个有界池**：父任务占满线程后等待子任务结果，而子任务在队列里等线程——线程饥饿死锁，所有线程 WAITING 在 `Future.get`。
- **Tomcat 的线程池与 JDK 不同**：Tomcat 的 `TaskQueue.offer` 在线程数未达 max 时返回 false，迫使线程池**先扩线程再排队**，适合 IO 型请求处理。Dubbo 的 `EagerThreadPool` 也是同样思路。

## 生产实践与踩坑

> [!CAUTION] 线程池在方法内创建且不关闭
> 每次请求 `Executors.newFixedThreadPool(10)` 用完不 shutdown，核心线程永远不会退出，线程数线性上涨直到进程崩溃。线程池必须是长生命周期的单例 Bean。

> [!WARNING] 配置了 max 却从不扩容
> `core=10, max=100, queue=LinkedBlockingQueue()`：队列无界永远不满，线程数永远是 10，RT 随排队飙升。要么用有界队列，要么采用 Tomcat 式「先扩线程」的队列。

> [!WARNING] 上下文丢失
> traceId、登录用户、`RequestContextHolder` 都是 ThreadLocal，异步任务里全部为空。用 Spring 的 `TaskDecorator` 或 TTL 包装任务传递；并在任务结束清理，避免串数据。

- 线程命名：`new ThreadFactoryBuilder().setNameFormat("order-async-%d")`（Guava）或 Spring `setThreadNamePrefix`，jstack 时一眼看出归属。
- 超时控制：`Future.get(timeout)` 超时后记得 `cancel(true)`，否则任务继续占着线程。
- 任务中尽量不要再同步等待同池的其他任务结果；需要编排时用 `CompletableFuture` 并指定不同的池。

## 相关阅读

- [进程、线程与 CPU 调度](#/cs/os-process)：线程数、上下文切换与容器 CPU 限制
- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：线程池与连接池饱和度监控
- [限流、熔断与降级](#/distributed/governance)：舱壁隔离与线程池的拒绝策略

## 面试追问

> [!QUESTION] 为什么用一个 int 同时存状态和线程数？
> 很多决策需要同时满足「状态为 RUNNING 且线程数小于上限」，如果分成两个变量，就需要加锁才能保证两者一起判断和修改的原子性。打包到一个 `AtomicInteger` 后，一次 CAS 就能同时校验状态并让线程数 +1，`addWorker` 的自旋就是这样做的。

> [!QUESTION] 核心线程会被回收吗？线程池怎么区分核心和非核心线程？
> 默认不会，`allowCoreThreadTimeOut(true)` 后会。线程本身没有核心标记：`getTask()` 中根据当前线程数是否大于 core 决定用 `poll(timeout)` 还是 `take()`，超时返回 null 的线程退出，所以最后留下的就是 core 个，至于是哪几个线程无所谓。

> [!QUESTION] 线程池里一个任务抛异常会怎样？
> execute 提交：异常向上抛出，`afterExecute` 收到异常，Worker 线程终止，`processWorkerExit` 补一个新线程，异常交给 UncaughtExceptionHandler。submit 提交：异常被 FutureTask 捕获存起来，线程不死，不调 `get()` 就完全不可见。

> [!QUESTION] 如何设计一个支持动态调参的线程池？
> 参数放配置中心并监听变更；core/max/keepAlive 直接调用 JDK setter（注意调整顺序）；队列容量通过自定义可变容量队列实现；配套采集活跃度、队列积压、拒绝数、任务耗时并设阈值告警；拒绝策略里打点并兜底。参考美团动态线程池、DynamicTp、Hippo4j。

> [!QUESTION] shutdown 和 shutdownNow 的区别？调用后任务一定会停吗？
> shutdown 进入 SHUTDOWN：拒绝新任务、继续执行队列中的任务，只中断空闲线程；shutdownNow 进入 STOP：拒绝新任务、清空并返回队列中的任务、中断所有线程。中断是协作式的，任务不响应中断就不会停，因此需要 awaitTermination 超时兜底和任务代码配合。
