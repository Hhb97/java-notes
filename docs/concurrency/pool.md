# 线程池

线程的创建与销毁成本高；线程池**复用线程、限制并发量、统一管理**。

## ThreadPoolExecutor 七大参数

```java
new ThreadPoolExecutor(
    4,                                  // corePoolSize     核心线程数
    8,                                  // maximumPoolSize  最大线程数
    60, TimeUnit.SECONDS,               // keepAliveTime    非核心线程空闲存活时间
    new ArrayBlockingQueue<>(100),      // workQueue        任务队列（务必有界）
    new NamedThreadFactory("order"),    // threadFactory    给线程起名，便于排查
    new ThreadPoolExecutor.CallerRunsPolicy()  // handler    拒绝策略
);
```

## 任务提交流程

```text
提交任务
  ├─ 线程数 < core            → 新建核心线程执行
  ├─ 否则 队列未满             → 放入队列等待
  ├─ 否则 线程数 < max         → 新建非核心线程执行
  └─ 否则                     → 触发拒绝策略
```

> 注意顺序：**先入队列，队列满了才扩到最大线程数**。使用无界队列时 `maximumPoolSize` 永远不会生效。

## 拒绝策略

| 策略 | 行为 |
| --- | --- |
| `AbortPolicy`（默认） | 抛 `RejectedExecutionException` |
| `CallerRunsPolicy` | 由提交任务的线程自己执行，形成**背压** |
| `DiscardPolicy` | 静默丢弃 |
| `DiscardOldestPolicy` | 丢弃队列最老的任务后重试 |

## Executors 工厂方法的坑

| 方法 | 问题 |
| --- | --- |
| `newFixedThreadPool` / `newSingleThreadExecutor` | 队列是**无界** `LinkedBlockingQueue`，任务堆积会 OOM |
| `newCachedThreadPool` | 最大线程数 `Integer.MAX_VALUE`，可能创建海量线程 |
| `newScheduledThreadPool` | 同样最大线程无界 |

阿里巴巴开发手册明确**禁止使用 Executors 创建线程池**，应手动 `new ThreadPoolExecutor`。

## 线程数怎么设

- **CPU 密集型**：`N + 1`（N 为核数）。
- **IO 密集型**：`N * (1 + 等待时间 / 计算时间)`，常取 `2N` 起步。
- 最终以压测与监控为准，并给不同业务**隔离线程池**，避免慢任务拖垮全局。

## 使用示例

```java
ExecutorService pool = new ThreadPoolExecutor(...);

Future<String> f = pool.submit(() -> query());     // 有返回值
pool.execute(() -> log());                         // 无返回值，异常直接抛到线程的未捕获处理器

CompletableFuture<String> cf = CompletableFuture
        .supplyAsync(() -> query(), pool)          // 一定要传自定义线程池，别用公共 ForkJoinPool
        .thenApply(String::trim)
        .exceptionally(ex -> "default");

pool.shutdown();                                   // 不再接收新任务，等已提交的执行完
pool.awaitTermination(30, TimeUnit.SECONDS);
```

> `submit` 提交的任务异常会被吞进 `Future`，不调 `get()` 就看不到；排查「任务莫名没执行」时先想这个。

## 虚拟线程（21+）

IO 密集场景下可以直接 `Executors.newVirtualThreadPerTaskExecutor()`：每个任务一个廉价的虚拟线程，无需池化与调参。注意：虚拟线程不适合 CPU 密集任务，且应避免在 `synchronized` 内做阻塞 IO（可能导致载体线程被 pin 住）。
