# 线程基础

## 进程与线程

- **进程**：资源分配的基本单位，有独立地址空间。
- **线程**：CPU 调度的基本单位，同进程内线程共享堆与方法区，各自拥有**程序计数器、虚拟机栈**。

## 创建线程

```java
// 1. 继承 Thread（不推荐，占用单继承名额）
class T extends Thread { public void run() { } }

// 2. 实现 Runnable（常用）
new Thread(() -> System.out.println("run")).start();

// 3. Callable + FutureTask / 线程池，可以有返回值和异常
FutureTask<Integer> f = new FutureTask<>(() -> 1 + 1);
new Thread(f).start();
int r = f.get();

// 4. 虚拟线程 (21+)
Thread.startVirtualThread(() -> System.out.println("virtual"));
```

> 调用 `start()` 才会启动新线程；直接调 `run()` 只是普通方法调用。同一线程对象不能 `start()` 两次。

## 线程状态

```text
NEW → RUNNABLE ⇄ BLOCKED     等待获取 synchronized 监视器锁
                ⇄ WAITING     Object.wait() / join() / LockSupport.park()，无限期
                ⇄ TIMED_WAITING   sleep(n) / wait(n) / join(n)
              → TERMINATED
```

## 常用方法

| 方法 | 说明 |
| --- | --- |
| `sleep(ms)` | 休眠，**不释放锁** |
| `wait()` / `notify()` | 必须在 `synchronized` 内；`wait` **释放锁** |
| `join()` | 等待目标线程结束 |
| `yield()` | 让出时间片，只是提示 |
| `interrupt()` | 设置中断标志，**协作式**终止 |
| `setDaemon(true)` | 守护线程，所有非守护线程结束时 JVM 退出 |

## 正确地终止线程

不要用已废弃的 `stop()`。使用中断标志：

```java
Thread t = new Thread(() -> {
    while (!Thread.currentThread().isInterrupted()) {
        try {
            doWork();
            Thread.sleep(100);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();   // sleep 抛出异常会清除标志，需要恢复
            break;
        }
    }
});
t.start();
t.interrupt();
```

## 三大特性（并发问题的根源）

| 特性 | 含义 | 解决手段 |
| --- | --- | --- |
| **原子性** | 操作不可分割 | `synchronized`、`Lock`、CAS、原子类 |
| **可见性** | 一个线程的修改其他线程能立刻看到 | `volatile`、`synchronized`、`final` |
| **有序性** | 禁止指令重排破坏语义 | `volatile`、`happens-before` 规则 |

详见 [synchronized 与 volatile](#/concurrency/sync)。

## ThreadLocal

为每个线程提供独立的变量副本，常用来保存用户上下文、`SimpleDateFormat` 等。

```java
private static final ThreadLocal<User> CTX = new ThreadLocal<>();
CTX.set(user);
try { /* ... */ } finally { CTX.remove(); }   // 线程池里必须 remove，否则内存泄漏 / 数据串用
```
