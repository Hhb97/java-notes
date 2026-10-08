# synchronized 与 volatile

## synchronized

保证**原子性、可见性、有序性**的内置锁（监视器锁 monitor），可重入。

```java
public synchronized void a() { }              // 锁 this
public static synchronized void b() { }       // 锁 Class 对象
public void c() {
    synchronized (lock) { /* 临界区 */ }      // 锁指定对象
}
```

### 实现原理

- 同步代码块编译为 `monitorenter` / `monitorexit` 指令；同步方法用 `ACC_SYNCHRONIZED` 标志。
- 对象头的 **Mark Word** 记录锁状态。
- **锁升级**（JDK 6+ 优化）：无锁 → 偏向锁 → 轻量级锁（CAS 自旋）→ 重量级锁（操作系统 mutex，线程阻塞）。偏向锁在 JDK 15 起默认禁用，JDK 18 移除。

## volatile

```java
private volatile boolean running = true;
```

- **可见性**：写入立刻刷回主内存，读取总是读主内存最新值。
- **有序性**：通过内存屏障禁止指令重排。
- **不保证原子性**：`count++` 是读-改-写三步，volatile 无法保证安全。

典型用途：状态标志位；双重检查锁定的单例：

```java
public class Singleton {
    private static volatile Singleton instance;   // volatile 防止半初始化对象被看到
    public static Singleton get() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) instance = new Singleton();
            }
        }
        return instance;
    }
}
```

`new` 分三步：分配内存 → 初始化 → 赋值引用。没有 volatile，2 与 3 可能被重排，另一线程拿到未初始化完成的对象。

## Java 内存模型（JMM）

- 每个线程有私有**工作内存**（对 CPU 缓存 / 寄存器的抽象），共享变量存在**主内存**。
- **happens-before** 规则（部分）：
  - 同一线程内，按程序顺序；
  - 对一个锁的 `unlock` happens-before 之后对同一锁的 `lock`；
  - 对 `volatile` 的写 happens-before 之后对它的读；
  - `Thread.start()` happens-before 线程内的所有操作；线程所有操作 happens-before `join()` 返回。

## CAS 与原子类

**Compare-And-Swap**：硬件级原子指令，「如果值等于预期则更新，否则失败」。

```java
AtomicInteger n = new AtomicInteger();
n.incrementAndGet();                 // 内部是 CAS 自旋
n.compareAndSet(5, 6);
```

问题：
- **ABA**：值 A→B→A，CAS 误以为没变过。用 `AtomicStampedReference` 加版本号。
- **自旋开销**：竞争激烈时空转耗 CPU；高竞争计数用 `LongAdder`。
- 只能保证单个变量的原子性。

## synchronized vs ReentrantLock

| | synchronized | ReentrantLock |
| --- | --- | --- |
| 释放 | 自动 | 手动 `finally { unlock() }` |
| 可中断 | 否 | `lockInterruptibly()` |
| 超时 | 否 | `tryLock(timeout)` |
| 公平锁 | 否 | 可选 |
| 多条件 | 一个 | 多个 `Condition` |

默认用 `synchronized`；需要高级特性再用 `ReentrantLock`。

## 死锁

四个必要条件：互斥、持有并等待、不可剥夺、循环等待。预防：**统一加锁顺序**、使用 `tryLock` 超时、减小锁粒度。排查用 `jstack` 会直接提示 `Found one Java-level deadlock`。
