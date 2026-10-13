---
level: 深入
tags: [JMM, volatile, happens-before, 内存屏障, 伪共享]
summary: 从 CPU 缓存、Store Buffer 讲清可见性与重排的硬件根源，再落到 happens-before、volatile 实现、DCL、final 语义与伪共享
---

# Java 内存模型与 volatile

> [!ABSTRACT] 核心要点
> - 可见性与有序性问题来自三层：**编译器/JIT 重排**、**CPU 乱序执行**、**Store Buffer 与 Invalidate Queue** 造成的写延迟可见。MESI 本身保证缓存一致，问题出在它前面的这两个缓冲。
> - JMM 不描述硬件，而是用 **happens-before** 给程序员一个承诺：只要 A hb B，A 的写对 B 可见且不会被重排到 B 之后。
> - `volatile` = 可见性 + 禁止特定重排，**不保证复合操作原子性**。HotSpot 在 x86 上只需在 volatile 写后加一条 `lock` 前缀指令（StoreLoad 屏障）。
> - DCL 单例必须加 `volatile`，防止「引用先赋值、构造后完成」导致其他线程拿到半初始化对象；`final` 字段在正确构造下自带安全发布语义。
> - 伪共享：不同核写同一缓存行上的不同变量会互相失效。用 `@Contended` 或填充隔离热点字段，`LongAdder` 的 `Cell` 就是这么做的。

## 硬件根源：缓存、MESI 与缓冲

### 多级缓存与 MESI

现代 CPU 每核有私有 L1（指令/数据分离）、L2，多核共享 L3；缓存以**缓存行**（x86 通常 64 字节）为单位读写。多核间通过 MESI 类协议维持一致性：

| 状态 | 含义 | 本核写入时 |
| --- | --- | --- |
| M（Modified） | 独占且已修改，与内存不一致 | 直接写 |
| E（Exclusive） | 独占且干净 | 直接写，转 M |
| S（Shared） | 多核共享只读副本 | 需先广播 **Invalidate**，等所有核 **Ack** 后才能写 |
| I（Invalid） | 无效 | 需先 Read 再 Invalidate |

问题在 S 状态的写：等待其他核 Ack 可能要上百个周期。为了不让执行单元干等，CPU 引入了两个缓冲：

<figure class="fig">
<svg viewBox="0 0 760 350" class="dg" role="img" aria-label="双核 CPU 的执行单元、Store Buffer、Invalidate Queue 与多级缓存">
<rect class="bg" x="30" y="10" width="320" height="230" rx="12"/>
<rect class="bg" x="410" y="10" width="320" height="230" rx="12"/>
<rect class="b1" x="46" y="30" width="290" height="36" rx="6"/>
<text class="tb" x="191" y="48" text-anchor="middle" dominant-baseline="middle">Core 0 执行单元</text>
<rect class="b3" x="46" y="86" width="140" height="40" rx="6"/>
<text class="t" x="116" y="106" text-anchor="middle" dominant-baseline="middle">Store Buffer</text>
<rect class="b4" x="196" y="86" width="140" height="40" rx="6"/>
<text class="t" x="266" y="106" text-anchor="middle" dominant-baseline="middle">Invalidate Queue</text>
<rect class="b2" x="46" y="146" width="290" height="36" rx="6"/>
<text class="t" x="191" y="164" text-anchor="middle" dominant-baseline="middle">L1 Cache（64B 行，MESI 状态）</text>
<rect class="b" x="46" y="192" width="290" height="36" rx="6"/>
<text class="t" x="191" y="210" text-anchor="middle" dominant-baseline="middle">L2 Cache</text>
<line class="l" x1="116" y1="66" x2="116" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="116" y1="126" x2="116" y2="146" marker-end="url(#arr)"/>
<line class="l" x1="266" y1="126" x2="266" y2="146" marker-end="url(#arr)"/>
<rect class="b1" x="426" y="30" width="290" height="36" rx="6"/>
<text class="tb" x="571" y="48" text-anchor="middle" dominant-baseline="middle">Core 1 执行单元</text>
<rect class="b3" x="426" y="86" width="140" height="40" rx="6"/>
<text class="t" x="496" y="106" text-anchor="middle" dominant-baseline="middle">Store Buffer</text>
<rect class="b4" x="576" y="86" width="140" height="40" rx="6"/>
<text class="t" x="646" y="106" text-anchor="middle" dominant-baseline="middle">Invalidate Queue</text>
<rect class="b2" x="426" y="146" width="290" height="36" rx="6"/>
<text class="t" x="571" y="164" text-anchor="middle" dominant-baseline="middle">L1 Cache（64B 行，MESI 状态）</text>
<rect class="b" x="426" y="192" width="290" height="36" rx="6"/>
<text class="t" x="571" y="210" text-anchor="middle" dominant-baseline="middle">L2 Cache</text>
<line class="l" x1="496" y1="66" x2="496" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="496" y1="126" x2="496" y2="146" marker-end="url(#arr)"/>
<line class="l" x1="646" y1="126" x2="646" y2="146" marker-end="url(#arr)"/>
<rect class="b5" x="30" y="256" width="700" height="34" rx="6"/>
<text class="t" x="380" y="273" text-anchor="middle" dominant-baseline="middle">片上互连：Read / Invalidate / Ack 等一致性消息</text>
<line class="l" x1="191" y1="228" x2="191" y2="256"/>
<line class="l" x1="571" y1="228" x2="571" y2="256"/>
<rect class="b" x="30" y="304" width="700" height="34" rx="6"/>
<text class="t" x="380" y="321" text-anchor="middle" dominant-baseline="middle">L3 共享缓存 → 主内存</text>
<line class="l" x1="380" y1="290" x2="380" y2="304"/>
</svg>
<figcaption>图 1：写先进 Store Buffer（不等 Ack），收到的失效请求先进 Invalidate Queue（先回 Ack 再慢慢处理）</figcaption>
</figure>

- **Store Buffer**：写操作先放进去就继续执行后续指令，等 Ack 到齐再写入 L1。代价：其他核暂时看不到这个写（可见性），且本核后续的读可能先于这个写完成（**StoreLoad 重排**）。
- **Invalidate Queue**：收到失效请求先回 Ack、放入队列稍后处理。代价：本核可能从 L1 读到一个**本该已失效的旧值**。

### 一个经典的「不可能」结果

```java
int x = 0, y = 0;
// 线程 1          // 线程 2
x = 1;             y = 1;
r1 = y;            r2 = x;
// 直觉：r1、r2 至少有一个是 1；实际在 x86 上也能观察到 r1 == r2 == 0
```

<figure class="fig">
<svg viewBox="0 0 760 380" class="dg" role="img" aria-label="Store Buffer 导致的 StoreLoad 重排时序">
<rect class="b1" x="30" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="90" y="38" text-anchor="middle" dominant-baseline="middle">Core 0</text>
<rect class="b3" x="180" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="240" y="38" text-anchor="middle" dominant-baseline="middle">SB 0</text>
<rect class="b2" x="320" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="380" y="38" text-anchor="middle" dominant-baseline="middle">共享缓存</text>
<rect class="b3" x="460" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="520" y="38" text-anchor="middle" dominant-baseline="middle">SB 1</text>
<rect class="b1" x="610" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="670" y="38" text-anchor="middle" dominant-baseline="middle">Core 1</text>
<line class="ld" x1="90" y1="56" x2="90" y2="340"/>
<line class="ld" x1="240" y1="56" x2="240" y2="340"/>
<line class="ld" x1="380" y1="56" x2="380" y2="340"/>
<line class="ld" x1="520" y1="56" x2="520" y2="340"/>
<line class="ld" x1="670" y1="56" x2="670" y2="340"/>
<line class="l" x1="90" y1="90" x2="240" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="165" y="82" text-anchor="middle">① x=1 入 SB</text>
<line class="l" x1="670" y1="125" x2="520" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="595" y="117" text-anchor="middle">② y=1 入 SB</text>
<line class="l" x1="90" y1="165" x2="380" y2="165" marker-end="url(#arr)"/>
<text class="ts" x="165" y="157" text-anchor="middle">③ 读 y</text>
<line class="la" x1="380" y1="195" x2="90" y2="195" marker-end="url(#arr-a)"/>
<text class="ta" x="165" y="187" text-anchor="middle">y = 0（旧值）</text>
<line class="l" x1="670" y1="230" x2="380" y2="230" marker-end="url(#arr)"/>
<text class="ts" x="595" y="222" text-anchor="middle">④ 读 x</text>
<line class="la" x1="380" y1="260" x2="670" y2="260" marker-end="url(#arr-a)"/>
<text class="ta" x="595" y="252" text-anchor="middle">x = 0（旧值）</text>
<line class="l" x1="240" y1="295" x2="380" y2="295" marker-end="url(#arr)"/>
<text class="ts" x="310" y="287" text-anchor="middle">⑤ 刷出 x=1</text>
<line class="l" x1="520" y1="325" x2="380" y2="325" marker-end="url(#arr)"/>
<text class="ts" x="450" y="317" text-anchor="middle">⑥ 刷出 y=1</text>
<text class="ts" x="380" y="366" text-anchor="middle">程序顺序是「先写后读」，效果却是「读先于写生效」：这就是 StoreLoad 重排</text>
</svg>
<figcaption>图 2：写还滞留在 Store Buffer 时，后面的读已经从缓存拿到旧值</figcaption>
</figure>

不同架构允许的重排不同：x86（TSO）只允许 **StoreLoad**；ARM/POWER 是弱内存模型，四种重排都可能发生。**在 x86 开发机上测不出的并发 bug，迁移到 ARM 服务器（如 Graviton、鲲鹏）后可能暴露**。

### 编译器层面的重排

JIT 只需保证**单线程语义不变（as-if-serial）**。经典案例：

```java
static boolean stop = false;           // 非 volatile
// 线程 A
while (!stop) { i++; }                  // C2 可能把 stop 的读取提到循环外：if (!stop) while (true) i++;
// 线程 B
stop = true;                            // 线程 A 永远停不下来
```

这和 CPU 缓存无关（缓存一致性最终会让新值可见），而是**读取被 JIT 优化掉了**。加 `volatile` 后 JIT 不能做这种提升。

## 内存屏障

JSR-133 Cookbook 把屏障抽象为四类（`XY` 表示：屏障前的 X 操作不能与屏障后的 Y 操作重排）：

| 屏障 | 语义 | x86 上 |
| --- | --- | --- |
| LoadLoad | 前面的读先于后面的读 | 空操作（TSO 已保证） |
| StoreStore | 前面的写先于后面的写对外可见 | 空操作 |
| LoadStore | 前面的读先于后面的写 | 空操作 |
| StoreLoad | 前面的写对所有核可见后，才执行后面的读 | **需要真实指令**（`mfence` 或 `lock` 前缀指令） |

StoreLoad 最贵，因为它要等 Store Buffer 排空。JMM 对 volatile 的保守插入策略：

```text
普通写 / 普通读
StoreStore 屏障
volatile 写          ← 之前的写不能下沉到它后面
StoreLoad 屏障       ← 之后的 volatile 读/写不能上浮到它前面

volatile 读
LoadLoad 屏障
LoadStore 屏障       ← 之后的读写不能上浮到 volatile 读前面
```

## happens-before 规则

JLS §17.4.5 定义的 hb 关系（A hb B ⇒ A 的结果对 B 可见，且从 B 的视角 A 在前）：

1. **程序次序**：同一线程内，前面的操作 hb 后面的操作。
2. **监视器锁**：对一个锁的 unlock hb 后续对同一个锁的 lock。
3. **volatile**：对 volatile 变量的写 hb 后续对它的读。
4. **线程启动**：`t.start()` hb 线程 t 中的任何操作。
5. **线程终止**：线程 t 中的所有操作 hb 其他线程从 `t.join()` 返回 / `isAlive()` 返回 false。
6. **中断**：`t.interrupt()` hb 被中断线程检测到中断。
7. **终结器**：构造函数结束 hb `finalize()` 开始。
8. **传递性**：A hb B 且 B hb C ⇒ A hb C。

JUC 在此基础上还有约定：放入并发集合 hb 取出；`Future` 任务中的操作 hb `get()` 返回；`CountDownLatch.countDown()` hb `await()` 返回；`Executor.execute(r)` 之前的操作 hb r 的执行。

利用传递性，一个 volatile 写可以把它之前的所有普通写一起「发布」出去（程序次序 + volatile 规则 + 传递性）：

```java
data = load();       // 普通写
ready = true;        // volatile 写
// 另一线程：if (ready) use(data);  —— 一定能看到 data 的完整值
```

> [!TIP] 「搭便车」发布
> `FutureTask` 的 `outcome` 字段是普通字段，靠随后对 volatile `state` 的写发布出去；JUC 中大量非 volatile 字段都用这种方式保证可见性。

## volatile

### 语义与实现

- **可见性**：写会立即对其他线程可见；读一定读到最新写入。
- **有序性**：按上面的屏障规则禁止重排。
- **long/double 原子性**：JLS 允许非 volatile 的 64 位写被拆成两次 32 位写，`volatile long` 保证单次读写原子（64 位 JVM 实际上普通 long 也是原子的）。
- **不保证复合操作原子性**：`count++` 是读-改-写三步，两线程可能读到同一个值；用 `AtomicInteger`/`LongAdder`。

x86 上 HotSpot 为 volatile 写生成类似下面的汇编（`-XX:+PrintAssembly` 配合 hsdis 可见）：

```text
mov    %edi,0x70(%rsi)          ; 写 volatile 字段
lock addl $0x0,(%rsp)           ; 对栈顶加 0：无实际效果，只为借用 lock 前缀
```

`lock` 前缀的作用：

1. 把当前核 Store Buffer 中的写全部刷到缓存，并通过一致性协议使其他核的对应缓存行失效；
2. 作为全屏障：禁止它前后的读写跨越它重排。

HotSpot 选用 `lock addl` 而不是 `mfence`，是因为在多数 x86 实现上前者更快。AArch64 上则用 `stlr`/`ldar` 这类带 release/acquire 语义的指令。

### 适用场景

| 场景 | 是否适合 volatile |
| --- | --- |
| 状态标志（`running`、`shutdown`） | 适合：一写多读、无复合条件 |
| 一次性安全发布（DCL、配置热更新时整体替换引用） | 适合：替换不可变对象的引用 |
| 读多写少 + CAS 更新 | 适合：`AtomicXxx` 内部 `value` 就是 volatile |
| `count++`、`if (x == null) x = ...` | 不适合，需要锁或 CAS |
| 多个变量之间有不变式约束 | 不适合，需要锁 |

### JDK 9+ VarHandle 的访问模式

| 模式 | 保证 | 典型用途 |
| --- | --- | --- |
| Plain | 无 | 普通字段访问 |
| Opaque | 单变量的访问不被优化掉、按程序序 | 进度标志 |
| Acquire / Release | 读-获取、写-释放的单向屏障 | 生产者-消费者发布，比 volatile 便宜（省 StoreLoad） |
| Volatile | 完全的顺序一致 | 等同 volatile 字段 |

`AtomicInteger.lazySet`（= `setRelease`）就是 Release 写，JUC 内部大量用它来减少 StoreLoad 开销。

## DCL 单例为什么需要 volatile

```java
public class Singleton {
    private static volatile Singleton INSTANCE;
    public static Singleton get() {
        Singleton s = INSTANCE;                // 读一次到局部变量，减少 volatile 读
        if (s == null) {
            synchronized (Singleton.class) {
                s = INSTANCE;
                if (s == null) {
                    INSTANCE = s = new Singleton();
                }
            }
        }
        return s;
    }
}
```

`new Singleton()` 大致分为：① 分配内存 ② 执行构造器初始化字段 ③ 把引用写入 `INSTANCE`。没有 volatile 时 ②③ 可以重排：线程 A 先写了引用，线程 B 在**第一次检查（锁外）**看到非 null，直接返回一个字段还是默认值的对象。

- volatile 写前的 StoreStore 屏障保证 ② 在 ③ 之前；B 的 volatile 读保证读到引用后能看到完整字段。
- JDK 5（JSR-133）之前 volatile 语义不足，DCL 即使加 volatile 也是错的；现代 JDK 无此问题。
- 更简洁的替代：**静态内部类 Holder**（依赖类初始化锁，`<clinit>` 天然线程安全且懒加载）或**枚举单例**（还能防反射与反序列化）。

## final 字段语义

JLS §17.5：对象构造器内对 final 字段的写，与随后把该对象引用赋给其他变量的操作**不能重排**。因此其他线程只要拿到引用，就能看到 final 字段被正确初始化的值，即使引用是通过数据竞争（非 volatile）拿到的。

- 实现：构造函数含 final 字段写时，编译器在构造结束处插入 StoreStore 屏障（x86 上为空）。
- 前提：**构造过程中 `this` 没有逃逸**（例如构造器里把 `this` 注册给监听器或启动线程），否则保证失效。
- 只保证 final 字段本身及其**通过它可达的对象**在构造结束时的状态；构造后再修改 final 引用指向的可变对象不在保证范围内。
- 这也是不可变对象（`String`、`record`）可以在线程间无锁共享的基础。

## 伪共享（False Sharing）

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="两个变量位于同一缓存行导致伪共享，以及填充后的布局">
<text class="tb" x="20" y="26">伪共享：X、Y 同在一个 64B 缓存行</text>
<rect class="b1" x="20" y="44" width="130" height="40" rx="6"/>
<text class="t" x="85" y="64" text-anchor="middle" dominant-baseline="middle">Core 0 写 X</text>
<rect class="b1" x="610" y="44" width="130" height="40" rx="6"/>
<text class="t" x="675" y="64" text-anchor="middle" dominant-baseline="middle">Core 1 写 Y</text>
<rect class="b4" x="180" y="44" width="50" height="40"/>
<text class="tb" x="205" y="64" text-anchor="middle" dominant-baseline="middle">X</text>
<rect class="b4" x="230" y="44" width="50" height="40"/>
<text class="tb" x="255" y="64" text-anchor="middle" dominant-baseline="middle">Y</text>
<rect class="b" x="280" y="44" width="50" height="40"/>
<rect class="b" x="330" y="44" width="50" height="40"/>
<rect class="b" x="380" y="44" width="50" height="40"/>
<rect class="b" x="430" y="44" width="50" height="40"/>
<rect class="b" x="480" y="44" width="50" height="40"/>
<rect class="b" x="530" y="44" width="50" height="40"/>
<line class="la" x1="150" y1="64" x2="180" y2="64" marker-end="url(#arr-a)"/>
<line class="la" x1="610" y1="64" x2="580" y2="64" marker-end="url(#arr-a)"/>
<text class="ts" x="380" y="104" text-anchor="middle">任一核写入都会让另一核整行失效，缓存行在两核间来回迁移（ping-pong）</text>
<text class="tb" x="20" y="140">填充后：X、Y 各占独立缓存行</text>
<rect class="b2" x="40" y="156" width="40" height="40"/>
<text class="tb" x="60" y="176" text-anchor="middle" dominant-baseline="middle">X</text>
<rect class="b" x="80" y="156" width="280" height="40"/>
<text class="ts" x="220" y="176" text-anchor="middle" dominant-baseline="middle">padding</text>
<rect class="b2" x="400" y="156" width="40" height="40"/>
<text class="tb" x="420" y="176" text-anchor="middle" dominant-baseline="middle">Y</text>
<rect class="b" x="440" y="156" width="280" height="40"/>
<text class="ts" x="580" y="176" text-anchor="middle" dominant-baseline="middle">padding</text>
<text class="ts" x="200" y="218" text-anchor="middle">Core 0 独占这一行</text>
<text class="ts" x="560" y="218" text-anchor="middle">Core 1 独占这一行</text>
</svg>
<figcaption>图 3：逻辑上无关的两个变量因为物理上相邻而互相拖累</figcaption>
</figure>

```java
// JDK 8：sun.misc.Contended；JDK 9+：jdk.internal.vm.annotation.Contended
// 业务代码使用需要 -XX:-RestrictContended（JDK 9+ 还需 --add-exports java.base/jdk.internal.vm.annotation=ALL-UNNAMED）
@jdk.internal.vm.annotation.Contended
static final class Cell {          // JDK 17 Striped64.Cell（节选）
    volatile long value;
}
```

| 手段 | 说明 |
| --- | --- |
| `@Contended` | JVM 在字段/类前后插入填充，默认宽度 `-XX:ContendedPaddingWidth=128` 字节（考虑相邻行预取） |
| 手工填充 | 前后各 7 个 `long`（Disruptor 早期做法）；字段可能被 JVM 重排，常用**继承层级**来固定布局 |
| 数据分片 | 每线程独立计数后汇总（`LongAdder`、`ThreadLocalRandom` 的种子放在 `Thread` 中并 `@Contended`） |

JDK 内部使用 `@Contended` 的地方：`Striped64.Cell`、`ConcurrentHashMap.CounterCell`、`Thread` 中 `ThreadLocalRandom` 相关字段、`ForkJoinPool` 的部分字段等。

## 生产实践与踩坑

> [!WARNING] 用 volatile 做计数器
> `volatile int qps; qps++;` 在压测下计数明显偏少。volatile 不保证复合操作原子性，改为 `LongAdder`（高并发写、偶尔读）或 `AtomicLong`（需要精确 CAS 语义）。

> [!WARNING] 配置热更新只改了字段
> 配置对象是可变的，刷新线程逐个 set 字段，读线程可能读到「一半新一半旧」的组合。正确做法：构建新的**不可变**配置对象，然后对 `volatile Config current` 做一次引用替换。

> [!CAUTION] 停止标志不生效
> 后台线程 `while (!stop)` 永不退出，只在压测/长时间运行后出现（C2 编译后才会提升读取）。所有跨线程标志位都要 `volatile` 或用 `AtomicBoolean`。

- 伪共享的识别：Linux `perf c2c` 可以直接找出被多核争抢的缓存行；JMH 对比填充前后吞吐。
- 不要为了「保险」把所有字段都加 volatile：每次 volatile 写都有 StoreLoad 成本，还会阻止 JIT 优化。

## 相关阅读

- [synchronized 与锁升级](#/java/concurrency/sync)：锁与 happens-before 的落地
- [AQS 与显式锁](#/java/concurrency/aqs)：volatile/CAS 在 AQS 中的应用
- [进程、线程与 CPU 调度](#/cs/os-process)：内存屏障、上下文切换与线程调度的系统视角
- [运行时数据区与对象模型](#/java/jvm/memory)：对象内存布局与 Mark Word

## 面试追问

> [!QUESTION] MESI 已经保证缓存一致性了，为什么还需要 volatile？
> MESI 只管缓存之间的一致，但写在进入缓存前会滞留在 Store Buffer，失效请求会滞留在 Invalidate Queue，加上 JIT 和 CPU 的指令重排，其他线程仍可能看到旧值或乱序结果。volatile 通过内存屏障强制排空这些缓冲并禁止重排，同时约束 JIT 不能缓存读取。

> [!QUESTION] volatile 在 x86 上是怎么实现的？为什么只需要一个屏障？
> x86 是 TSO，只允许 StoreLoad 重排，LoadLoad/LoadStore/StoreStore 已由硬件保证。HotSpot 在 volatile 写后插入 `lock addl $0x0,(%rsp)`，借用 lock 前缀排空 Store Buffer 并充当全屏障；volatile 读在 x86 上不需要额外指令，但仍限制 JIT 重排。

> [!QUESTION] DCL 中去掉 volatile，除了重排还有什么问题？
> 关键就是重排导致半初始化对象被发布：引用写先于构造器中字段写对其他线程可见。锁内的线程没问题（monitor 保证 hb），问题出在第一次检查是锁外的无同步读，缺少 hb 关系。若对象的字段全是 final，由于 final 语义，即使不加 volatile 也能看到初始化后的 final 字段，但这依赖实现细节，不推荐。

> [!QUESTION] happens-before 和「时间上先发生」是一回事吗？
> 不是。hb 是可见性与排序的偏序约束：A hb B 不要求 A 在时间上先执行（只要结果等价即可重排）；时间上先发生的操作若无 hb 关系，也不保证可见。判断线程安全只看 hb，不看时间先后。

> [!QUESTION] 为什么 `@Contended` 默认填充 128 字节而不是 64？
> 主流 x86 缓存行为 64 字节，但硬件的相邻行预取（adjacent line prefetch）常按 128 字节成对加载，部分 ARM 平台缓存行本身就是 128 字节。填 128 字节可以同时规避这两种情况。
