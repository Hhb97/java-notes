# JUC 并发工具

`java.util.concurrent` 的核心：**AQS** 是大多数同步器的基础。

## AQS（AbstractQueuedSynchronizer）

- 一个 `volatile int state` 表示同步状态；
- 一个 **CLH 变体的双向 FIFO 队列**存放等待线程；
- 子类只需实现 `tryAcquire` / `tryRelease`（独占）或 `tryAcquireShared` / `tryReleaseShared`（共享）。

| 同步器 | state 含义 |
| --- | --- |
| `ReentrantLock` | 重入次数，0 表示无人持有 |
| `Semaphore` | 剩余许可数 |
| `CountDownLatch` | 剩余计数 |
| `ReentrantReadWriteLock` | 高 16 位读锁数，低 16 位写锁重入数 |

## 常用同步工具

### CountDownLatch：等待 N 个任务完成

```java
var latch = new CountDownLatch(3);
for (int i = 0; i < 3; i++) pool.execute(() -> { work(); latch.countDown(); });
latch.await();            // 主线程等待；一次性，不可重置
```

### CyclicBarrier：N 个线程互相等待，到齐后一起出发

```java
var barrier = new CyclicBarrier(3, () -> System.out.println("全部到达"));
// 每个线程调用 barrier.await()；可循环复用
```

### Semaphore：限流 / 资源池

```java
var sem = new Semaphore(10);
sem.acquire();
try { call(); } finally { sem.release(); }
```

### ReentrantReadWriteLock：读多写少

读读不互斥，读写、写写互斥。写锁可以降级为读锁，反之不行。

## 并发集合

| 类 | 说明 |
| --- | --- |
| `ConcurrentHashMap` | 见 [HashMap 原理](#/api/hashmap) |
| `CopyOnWriteArrayList` | 写时复制整个数组，读无锁；写多时开销大 |
| `BlockingQueue` | `put` 满则阻塞，`take` 空则阻塞，生产者-消费者模型 |
| `ConcurrentLinkedQueue` | CAS 无锁队列 |
| `ConcurrentSkipListMap` | 并发有序 Map（跳表） |

生产者-消费者：

```java
BlockingQueue<Task> q = new LinkedBlockingQueue<>(1000);
// 生产者：q.put(task);   消费者：Task t = q.take();
```

## CompletableFuture：异步编排

```java
CompletableFuture<User> userF  = CompletableFuture.supplyAsync(() -> getUser(id), pool);
CompletableFuture<List<Order>> ordersF = CompletableFuture.supplyAsync(() -> getOrders(id), pool);

userF.thenCombine(ordersF, (u, o) -> new Profile(u, o))   // 两个都完成后合并
     .orTimeout(2, TimeUnit.SECONDS)                        // 9+：超时
     .exceptionally(ex -> Profile.EMPTY)
     .thenAccept(System.out::println);

CompletableFuture.allOf(f1, f2, f3).join();               // 全部完成
CompletableFuture.anyOf(f1, f2, f3);                       // 任一完成
```

## 锁的分类速记

| 维度 | 对比 |
| --- | --- |
| 乐观 / 悲观 | CAS、版本号 vs `synchronized`、`Lock` |
| 公平 / 非公平 | 排队 vs 允许插队（默认，吞吐更高） |
| 可重入 | 同一线程可重复获取同一把锁 |
| 独占 / 共享 | 写锁 vs 读锁、`Semaphore` |
| 自旋 | 不阻塞线程，循环尝试，适合临界区极短 |
