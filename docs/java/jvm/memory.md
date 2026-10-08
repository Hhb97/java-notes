---
level: 深入
tags: [JVM, 运行时数据区, 对象头, 压缩指针, 元空间, 逃逸分析]
summary: 从规范到 HotSpot 实现，讲清楚 JVM 各内存区域、对象如何被创建与布局、元空间/字符串常量池/直接内存的位置变迁，以及逃逸分析与四种引用
---

# 运行时数据区与对象模型

> [!ABSTRACT] 核心要点
> - 线程私有：程序计数器、虚拟机栈、本地方法栈（HotSpot 中两栈合一）；线程共享：堆、方法区（JDK 8 起由**元空间**实现，位于本地内存）。直接内存、Code Cache 不属于规范定义的区域，但都计入进程 RSS。
> - 对象创建五步：类加载检查 → 分配内存（指针碰撞 / 空闲列表，靠 **TLAB** + CAS 保证并发安全）→ 零值初始化 → 设置对象头 → 执行 `<init>`。
> - 对象 = 对象头（Mark Word 8B + Klass Pointer 4B/8B [+ 数组长度 4B]）+ 实例数据 + 对齐填充（8 字节对齐）。64 位下 `new Object()` 占 16 字节。
> - 压缩指针靠「8 字节对齐 + 左移 3 位」把 32 位编码成 35 位地址，所以堆超过约 32GB 就会自动关闭，**31GB 堆可能比 40GB 堆装得下更多对象**。
> - 逃逸分析是 C2 的优化，HotSpot 实际做的是**标量替换**与**锁消除**，并没有真正的「栈上分配」。

## 运行时数据区全景

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="JVM 运行时数据区全景：线程共享的堆与元空间，线程私有的栈与程序计数器，以及堆外的直接内存和代码缓存">
<rect class="bg" x="20" y="20" width="440" height="262" rx="12"/>
<text class="ts" x="36" y="40">线程共享</text>
<rect class="b1" x="40" y="54" width="400" height="128" rx="8"/>
<text class="tb" x="240" y="76" text-anchor="middle" dominant-baseline="middle">堆 Heap（-Xms / -Xmx）</text>
<rect class="b" x="56" y="100" width="128" height="62" rx="6"/>
<text class="tb" x="120" y="122" text-anchor="middle" dominant-baseline="middle">Eden</text>
<text class="ts" x="120" y="144" text-anchor="middle" dominant-baseline="middle">TLAB 在此划分</text>
<rect class="b" x="192" y="100" width="56" height="62" rx="6"/>
<text class="tb" x="220" y="131" text-anchor="middle" dominant-baseline="middle">S0</text>
<rect class="b" x="256" y="100" width="56" height="62" rx="6"/>
<text class="tb" x="284" y="131" text-anchor="middle" dominant-baseline="middle">S1</text>
<rect class="b" x="320" y="100" width="104" height="62" rx="6"/>
<text class="tb" x="372" y="122" text-anchor="middle" dominant-baseline="middle">Old</text>
<text class="ts" x="372" y="144" text-anchor="middle" dominant-baseline="middle">老年代</text>
<rect class="b5" x="40" y="196" width="400" height="70" rx="8"/>
<text class="tb" x="240" y="218" text-anchor="middle" dominant-baseline="middle">方法区 = 元空间 Metaspace（本地内存）</text>
<text class="ts" x="240" y="244" text-anchor="middle" dominant-baseline="middle">Klass、Method、运行时常量池、注解；JDK 8 起取代永久代</text>
<rect class="bg" x="480" y="20" width="260" height="262" rx="12"/>
<text class="ts" x="496" y="40">线程私有（每个线程一份）</text>
<rect class="b2" x="500" y="54" width="220" height="70" rx="8"/>
<text class="tb" x="610" y="76" text-anchor="middle" dominant-baseline="middle">虚拟机栈 VM Stack</text>
<text class="ts" x="610" y="102" text-anchor="middle" dominant-baseline="middle">栈帧 × N，大小由 -Xss 决定</text>
<rect class="b2" x="500" y="136" width="220" height="56" rx="8"/>
<text class="tb" x="610" y="156" text-anchor="middle" dominant-baseline="middle">本地方法栈</text>
<text class="ts" x="610" y="176" text-anchor="middle" dominant-baseline="middle">HotSpot 与虚拟机栈合一</text>
<rect class="b2" x="500" y="204" width="220" height="62" rx="8"/>
<text class="tb" x="610" y="226" text-anchor="middle" dominant-baseline="middle">程序计数器 PC</text>
<text class="ts" x="610" y="248" text-anchor="middle" dominant-baseline="middle">规范中唯一不会 OOM 的区域</text>
<rect class="b3" x="20" y="298" width="440" height="46" rx="8"/>
<text class="tb" x="240" y="321" text-anchor="middle" dominant-baseline="middle">直接内存 Direct Memory（堆外，NIO / Netty）</text>
<rect class="b3" x="480" y="298" width="260" height="46" rx="8"/>
<text class="tb" x="610" y="321" text-anchor="middle" dominant-baseline="middle">Code Cache（JIT 产物）</text>
</svg>
<figcaption>图 1：运行时数据区全景（底部两块不属于规范定义的区域，但都占用进程内存）</figcaption>
</figure>

| 区域 | 线程 | 存放内容 | 典型异常 | 相关参数 |
| --- | --- | --- | --- | --- |
| 程序计数器 | 私有 | 当前字节码行号；执行 native 方法时为空（undefined） | 无 | — |
| 虚拟机栈 | 私有 | 栈帧：局部变量表、操作数栈、动态链接、返回地址 | `StackOverflowError`；创建线程时栈内存不足报 OOM | `-Xss`（Linux x64 默认 1MB） |
| 本地方法栈 | 私有 | native 方法调用；HotSpot 不区分 | 同上 | 同上 |
| 堆 | 共享 | 对象实例、数组；JDK 7+ 还有字符串常量池里的 String 对象与类静态变量 | `Java heap space` | `-Xms` `-Xmx` `-Xmn` |
| 方法区（元空间） | 共享 | 类元数据、方法字节码、运行时常量池、JIT 相关计数 | `Metaspace` / `Compressed class space` | `MaxMetaspaceSize` `CompressedClassSpaceSize` |
| 直接内存 | — | `DirectByteBuffer`、`Unsafe.allocateMemory` | `Direct buffer memory` | `MaxDirectMemorySize` |

> [!NOTE] 规范 vs 实现
> 《JVM 规范》只定义「方法区」这个逻辑概念。JDK 7 及以前 HotSpot 用**永久代**（堆内、受 `-XX:MaxPermSize` 限制）实现它；JDK 8（JEP 122）移除永久代，改为本地内存中的**元空间**。说「元空间就是方法区」不严谨，应说「元空间是 HotSpot 在 JDK 8+ 对方法区的实现」。

## 栈帧结构

每次方法调用压入一个栈帧，返回（正常或异常）时弹出。栈帧大小在**编译期**就已确定：Code 属性中的 `max_locals` 与 `max_stack` 写死了局部变量表槽位数和操作数栈最大深度，运行期不会因为数据变化而改变。

<figure class="fig">
<svg viewBox="0 0 720 310" class="dg" role="img" aria-label="虚拟机栈与当前栈帧的内部结构：局部变量表、操作数栈、动态链接、方法返回地址">
<text class="ts" x="120" y="34" text-anchor="middle">虚拟机栈（线程私有）</text>
<rect class="b1" x="40" y="50" width="160" height="50" rx="6"/>
<text class="tb" x="120" y="75" text-anchor="middle" dominant-baseline="middle">b() 当前栈帧</text>
<rect class="b" x="40" y="110" width="160" height="50" rx="6"/>
<text class="tb" x="120" y="135" text-anchor="middle" dominant-baseline="middle">a()</text>
<rect class="b" x="40" y="170" width="160" height="50" rx="6"/>
<text class="tb" x="120" y="195" text-anchor="middle" dominant-baseline="middle">main()</text>
<text class="ts" x="120" y="244" text-anchor="middle">调用压栈，返回弹栈</text>
<text class="ts" x="120" y="262" text-anchor="middle">深度超过 -Xss → StackOverflowError</text>
<line class="la" x1="200" y1="75" x2="276" y2="75" marker-end="url(#arr-a)"/>
<rect class="bg" x="280" y="20" width="420" height="276" rx="12"/>
<text class="ts" x="296" y="40">栈帧 Frame（大小编译期确定：max_locals / max_stack）</text>
<rect class="b2" x="296" y="52" width="388" height="76" rx="8"/>
<text class="tb" x="312" y="70" dominant-baseline="middle">局部变量表 Local Variables</text>
<rect class="b" x="312" y="84" width="84" height="32" rx="4"/>
<text class="tm" x="354" y="100" text-anchor="middle" dominant-baseline="middle">0: this</text>
<rect class="b" x="400" y="84" width="84" height="32" rx="4"/>
<text class="tm" x="442" y="100" text-anchor="middle" dominant-baseline="middle">1: int a</text>
<rect class="b" x="488" y="84" width="84" height="32" rx="4"/>
<text class="tm" x="530" y="100" text-anchor="middle" dominant-baseline="middle">2: long b</text>
<rect class="b" x="576" y="84" width="92" height="32" rx="4"/>
<text class="tm" x="622" y="100" text-anchor="middle" dominant-baseline="middle">3: (b 续)</text>
<rect class="b3" x="296" y="140" width="188" height="100" rx="8"/>
<text class="tb" x="390" y="158" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<rect class="b" x="316" y="172" width="148" height="26" rx="4"/>
<text class="tm" x="390" y="185" text-anchor="middle" dominant-baseline="middle">栈顶: value2</text>
<rect class="b" x="316" y="204" width="148" height="26" rx="4"/>
<text class="tm" x="390" y="217" text-anchor="middle" dominant-baseline="middle">value1</text>
<rect class="b5" x="496" y="140" width="188" height="46" rx="8"/>
<text class="tb" x="590" y="156" text-anchor="middle" dominant-baseline="middle">动态链接</text>
<text class="ts" x="590" y="175" text-anchor="middle" dominant-baseline="middle">指向运行时常量池的方法引用</text>
<rect class="b5" x="496" y="194" width="188" height="46" rx="8"/>
<text class="tb" x="590" y="210" text-anchor="middle" dominant-baseline="middle">方法返回地址</text>
<text class="ts" x="590" y="229" text-anchor="middle" dominant-baseline="middle">调用者 PC / 异常处理表</text>
<text class="ts" x="296" y="264">long / double 占 2 个 slot；实例方法 slot 0 固定是 this</text>
<text class="ts" x="296" y="284">slot 可被作用域已结束的变量复用；另有实现相关的附加信息</text>
</svg>
<figcaption>图 2：虚拟机栈与栈帧结构</figcaption>
</figure>

- **局部变量表**：以 slot 为单位，`boolean/byte/char/short/int/float/reference/returnAddress` 各占 1 个 slot，`long/double` 占 2 个。实例方法 slot 0 是 `this`，随后是参数，再是方法内局部变量。
- **操作数栈**：字节码指令的工作区，`iadd` 就是弹两个 int、压回一个结果。HotSpot 解释器做了栈顶缓存（TOS caching），JIT 后则直接映射到寄存器。
- **动态链接**：栈帧持有指向运行时常量池中「当前方法所属类」的引用，用来在运行期把符号引用解析为直接引用（详见 [字节码与执行引擎](#/java/jvm/bytecode)）。
- **返回地址**：正常返回时恢复调用者的 PC；异常退出则查异常表，栈帧本身不保存返回值。

> [!WARNING] slot 复用与 GC 的经典「误解」
> 书上常举的例子：方法里 `byte[] buf = new byte[64MB]` 出了作用域后调用 `System.gc()` 回收不掉，必须 `buf = null`。这只在**解释执行**时成立（slot 仍持有引用）。方法一旦被 JIT 编译，编译器通过 OopMap 精确知道每个安全点上哪些 slot 还活着，已死的引用不会被当作 GC Roots。生产代码里不需要刻意置 null。

## 对象创建流程

以 `User u = new User();` 为例，字节码是：

```text
0: new           #7      // class User          → 分配内存 + 零值 + 对象头，引用压栈
3: dup                   // 复制引用，一份给构造器消费，一份留着赋值
4: invokespecial #9      // Method User."<init>":()V
7: astore_1              // 存入局部变量 u
```

1. **类加载检查**：`new` 指令的参数是常量池中的类符号引用，先检查该类是否已加载、链接、初始化，否则先走 [类加载流程](#/java/jvm/classloader)。
2. **分配内存**：对象大小在类加载完成后即可确定。
   - **指针碰撞（Bump the Pointer）**：堆是规整的（Serial、ParNew、Parallel、G1 等带压缩/复制的收集器），只需把空闲指针往后挪对象大小。
   - **空闲列表（Free List）**：堆不规整（CMS 的老年代基于标记-清除），需要维护可用块列表。
   - **并发安全**：多个线程同时 `new` 会争抢同一个指针。HotSpot 的办法是 **TLAB（Thread Local Allocation Buffer）**：每个线程先在 Eden 中预先占一小块，线程内分配只是无锁的指针碰撞；TLAB 用完再用 CAS 去 Eden 申请新的 TLAB。`-XX:+UseTLAB` 默认开启，TLAB 大小由 JVM 根据线程分配速率自适应。
   - 大对象或 TLAB 剩余空间不足（且浪费阈值不允许丢弃当前 TLAB）时，走慢路径在共享 Eden 上 CAS 分配，或直接进入老年代（G1 中为 Humongous Region）。
3. **零值初始化**：把实例数据区域清零，这保证了字段不赋初值也能读到 `0/false/null`。
4. **设置对象头**：写入 Mark Word（哈希码延迟计算，此时为 0；GC 年龄 0；锁标志）和 Klass Pointer。
5. **执行 `<init>`**：按源码顺序执行实例变量初始化语句、实例代码块、构造器体（先调父类 `<init>`）。

> [!CAUTION] 半初始化对象
> 第 4、5 步与「把引用赋值给变量」之间可能被重排序。双重检查锁单例里如果 `instance` 不加 `volatile`，其它线程可能拿到一个已分配、未执行完 `<init>` 的对象。原理见 [Java 内存模型与 volatile](#/java/concurrency/jmm)。

## 对象内存布局

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="64 位 HotSpot 中普通对象与数组对象的内存布局，以及无锁状态下 Mark Word 的位分布">
<text class="ts" x="20" y="34">普通对象（开启压缩类指针）</text>
<rect class="b3" x="20" y="44" width="200" height="54" rx="4"/>
<text class="tb" x="120" y="63" text-anchor="middle" dominant-baseline="middle">Mark Word</text>
<text class="ts" x="120" y="84" text-anchor="middle" dominant-baseline="middle">8 字节</text>
<rect class="b1" x="220" y="44" width="120" height="54" rx="4"/>
<text class="tb" x="280" y="63" text-anchor="middle" dominant-baseline="middle">Klass Pointer</text>
<text class="ts" x="280" y="84" text-anchor="middle" dominant-baseline="middle">4 字节（未压缩 8）</text>
<rect class="b2" x="340" y="44" width="280" height="54" rx="4"/>
<text class="tb" x="480" y="63" text-anchor="middle" dominant-baseline="middle">实例数据 Instance Data</text>
<text class="ts" x="480" y="84" text-anchor="middle" dominant-baseline="middle">父类字段在前，按宽度重排并填补空隙</text>
<rect class="b" x="620" y="44" width="120" height="54" rx="4"/>
<text class="tb" x="680" y="63" text-anchor="middle" dominant-baseline="middle">对齐填充</text>
<text class="ts" x="680" y="84" text-anchor="middle" dominant-baseline="middle">补齐到 8 的倍数</text>
<text class="ts" x="20" y="128">数组对象</text>
<rect class="b3" x="20" y="138" width="200" height="54" rx="4"/>
<text class="tb" x="120" y="165" text-anchor="middle" dominant-baseline="middle">Mark Word</text>
<rect class="b1" x="220" y="138" width="120" height="54" rx="4"/>
<text class="tb" x="280" y="165" text-anchor="middle" dominant-baseline="middle">Klass Pointer</text>
<rect class="b4" x="340" y="138" width="100" height="54" rx="4"/>
<text class="tb" x="390" y="157" text-anchor="middle" dominant-baseline="middle">数组长度</text>
<text class="ts" x="390" y="178" text-anchor="middle" dominant-baseline="middle">4 字节</text>
<rect class="b2" x="440" y="138" width="180" height="54" rx="4"/>
<text class="tb" x="530" y="165" text-anchor="middle" dominant-baseline="middle">元素数据</text>
<rect class="b" x="620" y="138" width="120" height="54" rx="4"/>
<text class="tb" x="680" y="165" text-anchor="middle" dominant-baseline="middle">对齐填充</text>
<text class="ts" x="20" y="226">Mark Word 展开（64 位，无锁态，JDK 8～17）</text>
<rect class="b" x="20" y="236" width="150" height="44" rx="4"/>
<text class="tm" x="95" y="258" text-anchor="middle" dominant-baseline="middle">unused:25</text>
<rect class="b3" x="170" y="236" width="200" height="44" rx="4"/>
<text class="tm" x="270" y="258" text-anchor="middle" dominant-baseline="middle">identity_hash:31</text>
<rect class="b" x="370" y="236" width="70" height="44" rx="4"/>
<text class="tm" x="405" y="258" text-anchor="middle" dominant-baseline="middle">unused:1</text>
<rect class="b2" x="440" y="236" width="100" height="44" rx="4"/>
<text class="tm" x="490" y="258" text-anchor="middle" dominant-baseline="middle">age:4</text>
<rect class="b5" x="540" y="236" width="100" height="44" rx="4"/>
<text class="tm" x="590" y="258" text-anchor="middle" dominant-baseline="middle">biased:1</text>
<rect class="b4" x="640" y="236" width="100" height="44" rx="4"/>
<text class="tm" x="690" y="258" text-anchor="middle" dominant-baseline="middle">lock:2</text>
</svg>
<figcaption>图 3：对象内存布局与 Mark Word 位分布</figcaption>
</figure>

### Mark Word 的五种状态

Mark Word 是复用的：同样 64 位，随锁状态不同而解释不同（`lock` 两位 + `biased` 一位区分）。

| 状态 | 高位内容 | biased | lock |
| --- | --- | --- | --- |
| 无锁 | identity hash（31 位）、分代年龄（4 位） | 0 | 01 |
| 偏向锁 | 线程 ID（54 位）、epoch（2 位）、年龄 | 1 | 01 |
| 轻量级锁 | 指向栈中 Lock Record 的指针（62 位） | — | 00 |
| 重量级锁 | 指向 ObjectMonitor 的指针（62 位） | — | 10 |
| GC 标记 | 转发指针等（GC 内部使用） | — | 11 |

几个由布局直接推出的结论：

- **分代年龄只有 4 位**，所以 `-XX:MaxTenuringThreshold` 最大只能设 15。
- **调用过 `Object.hashCode()`（identity hash）的对象无法再进入偏向锁**，因为 Mark Word 里没地方同时放线程 ID 和哈希码；轻量级/重量级锁会把原 Mark Word 备份到 Lock Record / ObjectMonitor 中，因此可以共存。
- 偏向锁在 JDK 15 被默认关闭并废弃（JEP 374），随后版本移除了实现；锁升级的细节见 [synchronized 与锁升级](#/java/concurrency/sync)。

> [!NOTE] 紧凑对象头（JDK 24+）
> Project Lilliput 的 JEP 450 在 JDK 24 以实验特性引入 `-XX:+UseCompactObjectHeaders`，把 Mark Word 与压缩类指针合并为 8 字节对象头，`new Object()` 可降到 8 字节，小对象密集的应用堆占用明显下降。JDK 25 起该特性转为正式（JEP 519），但仍需显式开启。

### 压缩指针与 32GB 边界

64 位 JVM 的引用原本是 8 字节，`-XX:+UseCompressedOops`（堆 < 约 32GB 时默认开启）把堆内引用压成 4 字节：因为对象都按 8 字节对齐，地址低 3 位恒为 0，存储时右移 3 位、使用时左移 3 位，32 位能寻址 2^32 × 8 = 32GB。

| 模式 | 条件 | 解码方式 |
| --- | --- | --- |
| Unscaled | 堆顶 < 4GB | 直接当地址用，零开销 |
| Zero-based | 堆顶 < 32GB | `addr = narrow << 3` |
| Heap-based | 堆无法放在低 32GB 地址空间 | `addr = base + (narrow << 3)` |
| 关闭 | `-Xmx` ≥ 约 32GB | 引用回到 8 字节 |

压缩类指针（`-XX:+UseCompressedClassPointers`）是另一回事：它压缩的是对象头里的 Klass Pointer，Klass 结构放在元空间中一块独立的 **Compressed Class Space**（`-XX:CompressedClassSpaceSize` 默认 1GB）。JDK 15 之前它依赖 `UseCompressedOops`，JDK 15 起两者解耦，即使堆超过 32GB 也能单独压缩类指针。

> [!WARNING] 堆不是越大越好
> 从 31GB 调到 36GB，引用全部膨胀为 8 字节，引用密集型应用（大量 `HashMap`、对象图）可用空间可能不增反降，同时 CPU 缓存命中率下降。经验值：要么控制在 31GB 以内，要么直接上到 48GB 以上；或者用 `-XX:ObjectAlignmentInBytes=16` 把压缩边界推到 64GB（代价是每个对象平均多浪费一些填充）。用 `java -Xmx32g -XX:+PrintFlagsFinal -version | grep UseCompressedOops` 可以确认是否仍在压缩。

## 用 JOL 观察对象布局

```xml
<dependency>
    <groupId>org.openjdk.jol</groupId>
    <artifactId>jol-core</artifactId>
    <version>0.17</version>
</dependency>
```

```java
import org.openjdk.jol.info.ClassLayout;

public class LayoutDemo {
    static class User {
        int id;
        boolean active;
        long ts;
        String name;
    }

    public static void main(String[] args) {
        System.out.println(ClassLayout.parseInstance(new Object()).toPrintable());
        System.out.println(ClassLayout.parseInstance(new User()).toPrintable());
        Object lock = new Object();
        synchronized (lock) {   // 加锁后 Mark Word 低位变化
            System.out.println(ClassLayout.parseInstance(lock).toPrintable());
        }
    }
}
```

JDK 17、默认参数下的输出（节选，具体偏移随 JDK 的字段布局算法略有差异）：

```text
java.lang.Object object internals:
OFF  SZ   TYPE DESCRIPTION               VALUE
  0   8        (object header: mark)     0x0000000000000001 (non-biasable; age: 0)
  8   4        (object header: class)    0x00000e80
 12   4        (object alignment gap)
Instance size: 16 bytes

LayoutDemo$User object internals:
OFF  SZ               TYPE DESCRIPTION               VALUE
  0   8                    (object header: mark)     0x0000000000000001 (non-biasable; age: 0)
  8   4                    (object header: class)    0x00c01200
 12   4                int User.id                   0
 16   8               long User.ts                   0
 24   1            boolean User.active               false
 25   3                    (alignment/padding gap)
 28   4   java.lang.String User.name                 null
Instance size: 32 bytes
```

读法：

- `new Object()` = 8（mark）+ 4（class）+ 4（填充）= **16 字节**；关闭压缩类指针时是 8 + 8 = 16，同样 16。
- `int id` 被塞进了对象头后面的 4 字节空隙（字段重排），`long` 需要 8 字节对齐所以从 16 开始。
- 引用字段 `name` 只占 4 字节，说明压缩指针生效。
- 第三段输出 mark 低位变为 `00`（轻量级锁，值是 Lock Record 地址），验证了上一节的状态表。

> [!TIP] 估算集合的真实内存
> `ArrayList<Integer>` 存 100 万个元素：每个 `Integer` 16 字节 + 数组每个引用 4 字节 ≈ 20MB，而 `int[]` 只需 4MB。JOL 的 `GraphLayout.parseInstance(obj).totalSize()` 可以计算整个对象图的大小，评估本地缓存容量时很有用。

## 元空间与类元数据

| 对比项 | 永久代（JDK 7 及以前） | 元空间（JDK 8+） |
| --- | --- | --- |
| 位置 | 堆的一部分（逻辑上） | 本地内存 |
| 上限 | `-XX:MaxPermSize`，默认很小 | `-XX:MaxMetaspaceSize`，默认不限（受物理内存/容器限制） |
| 存放 | 类元数据、字符串常量池（JDK 6）、静态变量（JDK 6） | 仅类元数据；字符串常量池与静态变量在 JDK 7 已移入堆 |
| 回收 | 随 Full GC | 随类卸载，以 ClassLoader 为单位整体释放 |

实现要点（HotSpot）：

- 每个类加载器对应一个 `ClassLoaderData`，从元空间按块（chunk）申请内存；**类加载器被回收时，它加载的全部类元数据整块释放**。这也意味着「卸载单个类」不存在，只能以加载器为粒度。
- `java.lang.Class` 对象（mirror）在**堆**上，静态变量自 JDK 7 起存放在 mirror 里；`Klass`、`Method`、`ConstMethod`（字节码）、`ConstantPool` 在元空间。
- 元空间分 Class Space（存 `Klass`，受 `CompressedClassSpaceSize` 限制）和 Non-Class Space（其余元数据），所以有两种 OOM 信息：`Metaspace` 与 `Compressed class space`。
- `-XX:MetaspaceSize` **不是初始大小**，而是首次触发 GC 的高水位线（64 位默认约 21MB）。达到后会触发一次 Full GC（G1 中为并发周期 + 卸载），之后水位线动态调整。
- JDK 16 的弹性元空间（JEP 387）改用伙伴分配，空闲内存能更及时地归还操作系统，碎片也更少。

> [!WARNING] 启动期的 Metadata GC Threshold
> Spring Boot 应用启动时加载上万个类，元空间很快越过默认约 21MB 的水位线，GC 日志里会出现若干次 `Pause Full (Metadata GC Threshold)`（或 G1 的 `Metadata GC Threshold` 引发的并发周期）。启动参数加 `-XX:MetaspaceSize=256m` 即可消除；同时务必设置 `-XX:MaxMetaspaceSize`，否则类泄漏会一直吃掉本地内存直到被 OOM Killer 杀掉。

## 字符串常量池的位置变迁

| 版本 | StringTable 中的 String 对象 | `intern()` 行为 |
| --- | --- | --- |
| JDK 6 | 永久代 | 池中没有时，**复制**一份字符串到永久代，返回副本引用 |
| JDK 7 | 堆 | 池中没有时，**记录堆中已有对象的引用**，返回原对象 |
| JDK 8+ | 堆（永久代已移除） | 同 JDK 7 |

StringTable 本身是 JVM 内部的哈希表（本地内存），表项指向堆中的 String。JDK 7u40 起默认桶数为 60013，JDK 11 起改为可并发扩容的哈希表，`-XX:StringTableSize` 仍可调初始大小。

```java
String s = new StringBuilder("计算机").append("软件").toString();
System.out.println(s.intern() == s);   // JDK 6: false（返回永久代副本）；JDK 7+: true（池里记录的就是 s）

String j = new StringBuilder("ja").append("va").toString();
System.out.println(j.intern() == j);   // 通常为 false：JDK 启动时已有 "java" 被驻留
```

> [!TIP] 大量重复字符串的优化
> - 对少量取值固定的字段（如状态码、城市名）手动 `intern()` 可以显著降低堆占用，但 StringTable 过大时 `intern` 本身会变慢，且要把 `StringTableSize` 调大。
> - G1 的 `-XX:+UseStringDeduplication` 在 GC 时对存活字符串的底层 `byte[]` 做去重，不改变引用身份，更安全；较新的 JDK 已把它扩展到其它收集器。

## 直接内存

`ByteBuffer.allocateDirect()` 通过 `Unsafe.allocateMemory`（底层 `malloc`）申请堆外内存，Java 堆上只有一个很小的 `DirectByteBuffer` 对象，靠 `Cleaner`（虚引用）在它被 GC 后释放堆外内存。

```java
// JDK 17 java.nio.Bits#reserveMemory（节选）
static void reserveMemory(long size, long cap) {
    if (tryReserveMemory(size, cap)) return;          // 1. 直接在额度内预留
    final JavaLangRefAccess jlra = SharedSecrets.getJavaLangRefAccess();
    while (jlra.waitForReferenceProcessing()) {        // 2. 帮着处理已入队的 Cleaner
        if (tryReserveMemory(size, cap)) return;
    }
    System.gc();                                       // 3. 触发 Full GC 回收无主的 DirectByteBuffer
    // 4. 指数退避重试若干次，仍失败则
    throw new OutOfMemoryError("Cannot reserve " + size + " bytes of direct buffer memory ...");
}
```

- 上限 `-XX:MaxDirectMemorySize`，默认等于 `-Xmx`（`Runtime.maxMemory()`）。
- `MappedByteBuffer`（mmap）**不计入**这个额度；Netty 默认池化分配器在可用时会绕过 `Cleaner` 直接调用 `Unsafe`，用自己的计数器（`io.netty.maxDirectMemory`）限额，泄漏时 JVM 的额度检查看不到。

> [!CAUTION] DisableExplicitGC 与直接内存
> 第 3 步依赖 `System.gc()`。如果启动参数里有 `-XX:+DisableExplicitGC`，`DirectByteBuffer` 对象躲在老年代迟迟不被回收时就会直接抛 `OutOfMemoryError: Direct buffer memory`。使用 NIO/Netty 的服务应改用 `-XX:+ExplicitGCInvokesConcurrent`（CMS/G1 下把 `System.gc()` 变成并发周期），而不是禁用。

## 逃逸分析与标量替换

C2 编译器在方法内联之后分析对象的作用域：

| 逃逸状态 | 含义 | 可做的优化 |
| --- | --- | --- |
| NoEscape | 对象只在当前方法（含已内联的被调方法）内使用 | 标量替换、锁消除 |
| ArgEscape | 作为参数传给未内联的方法，但不会被全局持有 | 锁消除 |
| GlobalEscape | 赋给静态字段/堆中对象字段、被返回 | 无 |

```java
// -XX:+DoEscapeAnalysis（JDK 6u23 起默认开启）
int distance(int x, int y) {
    Point p = new Point(x, y);      // NoEscape
    return p.x * p.x + p.y * p.y;
}
// 标量替换后等价于：
int distance(int x, int y) {
    int px = x, py = y;             // 对象被拆成两个局部标量，放在寄存器/栈上，堆上根本不分配
    return px * px + py * py;
}
```

- **标量替换**（`-XX:+EliminateAllocations`）：把对象拆成字段级局部变量。HotSpot **没有实现**真正的「栈上分配整个对象」，面试说「逃逸分析会把对象分配在栈上」是不准确的。
- **锁消除**（`-XX:+EliminateLocks`）：对不逃逸对象的 `synchronized`（如方法内 `StringBuffer`）直接去掉。
- **局限**：只对 C2 编译后的热点代码生效；依赖内联，方法太大（超过 `FreqInlineSize`）或多态调用导致未内联就会判为逃逸；对象在控制流合并点（if/else 两边各 new 一个再合并）上 C2 的分析也会失效。GraalVM 的部分逃逸分析（Partial Escape Analysis）在这方面更强。

> [!TIP] 怎么验证
> 循环中 new 大量短命对象，分别用 `-XX:+DoEscapeAnalysis` 与 `-XX:-DoEscapeAnalysis` 跑，配合 `-Xlog:gc` 比较 Young GC 次数。要用 JMH 做基准测试，避免 OSR 与死代码消除干扰结论。

## 四种引用

| 类型 | 回收时机 | `get()` | 典型用途 |
| --- | --- | --- | --- |
| 强引用 | 可达就不回收 | 对象本身 | 普通引用 |
| 软引用 `SoftReference` | 内存不足、抛 OOM 前一定会清理；平时按 LRU 策略 | 回收前可取到 | 内存敏感缓存（慎用） |
| 弱引用 `WeakReference` | 下一次 GC 发现只有弱引用可达即回收 | 回收前可取到 | `WeakHashMap`、`ThreadLocalMap` 的 key |
| 虚引用 `PhantomReference` | 不影响回收，只用于得到「已被回收」通知 | 恒为 `null` | `Cleaner` 释放堆外资源 |

- 软引用在 HotSpot 中的存活策略：距上次访问时间 > `空闲堆 MB × SoftRefLRUPolicyMSPerMB`（默认 1000ms/MB）就可以被回收。堆很大时软引用几乎不会被清，一旦清理就是集中清理，常见于「GC 后堆突然掉一大截 + 停顿变长」。
- 弱/软/虚引用都可以关联 `ReferenceQueue`，对象被回收后引用对象入队，可用于清理映射表。JDK 9 起虚引用在入队时会被 GC 自动清除。
- `finalize()` 在 JDK 9 废弃，JDK 18（JEP 421）标记为待移除：它让对象至少多活一轮 GC、执行线程不可控、可能「复活」对象，应改用 `Cleaner` 或 try-with-resources。

> [!WARNING] ThreadLocal 的「弱引用」并不能防泄漏
> `ThreadLocalMap.Entry` 的 key（ThreadLocal 对象）是弱引用，value 是强引用。线程池线程长期存活时，ThreadLocal 被回收后 key 变成 null，value 却仍被 `Thread → ThreadLocalMap → Entry` 强引用。只有后续 `get/set/remove` 碰到这个槽位才会顺带清理。规范写法永远是 `try { ... } finally { tl.remove(); }`。

## 生产实践与踩坑

1. **容器内 RSS 远大于 -Xmx**：进程内存 = 堆 + 元空间 + Code Cache（默认最大 240MB）+ 直接内存 + 线程栈（线程数 × `Xss`）+ GC 数据结构（G1 的 RSet/卡表可达堆的百分之几）+ glibc malloc arena。用 `-XX:NativeMemoryTracking=summary` + `jcmd <pid> VM.native_memory summary` 分项核对，详见 [线上调优与故障排查](#/java/jvm/tuning)。
2. **线程太多导致 OOM**：`unable to create native thread` 通常不是堆不够，而是进程/容器的线程数（pids）上限或虚拟内存不足；调小 `-Xss` 能缓解但治标不治本，根因是无界创建线程。
3. **深递归 StackOverflowError**：JSON 序列化循环引用、无终止条件的递归、过深的 AOP 代理链。`-Xss` 调大只是延后爆炸，要查调用栈中的重复模式。
4. **跨过 32GB 后吞吐反而下降**：见上文压缩指针。
5. **Metaspace 持续上涨**：动态生成类（CGLIB、Javassist、Groovy 脚本、`Proxy`、Lambda 表单）每次都用新 ClassLoader 加载且被缓存持有。`jcmd <pid> VM.classloader_stats`、Arthas `classloader` 可以按加载器统计类数量。
6. **Netty 直接内存泄漏**：`ByteBuf` 未 `release()`。开启 `-Dio.netty.leakDetection.level=advanced` 在测试环境定位泄漏点。

## 面试追问

> [!QUESTION] TLAB 是什么？有了 TLAB，对象分配还需要 CAS 吗？
> TLAB 是每个线程在 Eden 中预留的私有分配缓冲区，线程内分配只需移动自己的指针，无需同步。但**申请新 TLAB** 本身仍是在共享 Eden 上做 CAS；大对象、TLAB 剩余不足且不宜丢弃时走共享 Eden 的 CAS 慢路径。TLAB 只解决分配时的竞争，对象创建后仍然对所有线程可见。

> [!QUESTION] 一个 `new Object()` 占多少字节？`new int[0]` 呢？
> 64 位、开启压缩类指针：`new Object()` = 8（Mark Word）+ 4（Klass）+ 4（对齐）= 16 字节；`new int[0]` = 8 + 4 + 4（长度）= 16 字节。关闭压缩类指针时 Object 为 8 + 8 = 16，`int[0]` 为 8 + 8 + 4 再对齐到 24。

> [!QUESTION] 为什么堆超过 32GB 压缩指针会失效？如何突破？
> 压缩指针利用对象 8 字节对齐，把 32 位偏移左移 3 位得到 35 位地址空间，即 32GB。超过后无法编码，JVM 自动关闭压缩，所有引用变为 8 字节。可用 `-XX:ObjectAlignmentInBytes=16` 把上限扩到 64GB，代价是填充浪费；或干脆控制单实例堆不超过 31GB，多实例部署。

> [!QUESTION] JDK 8 为什么用元空间取代永久代？
> 永久代大小难以预估、容易 `PermGen space` OOM，且与堆一起由 GC 管理，增加 Full GC 负担；另外 HotSpot 与 JRockit 合并时 JRockit 本就没有永久代。元空间放到本地内存，以类加载器为单位分配和释放，默认不设上限。代价是泄漏时会吃掉宿主机内存，所以生产要设 `MaxMetaspaceSize`。

> [!QUESTION] 逃逸分析一定能带来性能提升吗？HotSpot 有栈上分配吗？
> 不一定：分析本身消耗编译时间，且效果依赖内联，多态/大方法下经常判定为逃逸。HotSpot 实现的是标量替换和锁消除，没有把完整对象分配在栈上的实现；被标量替换的对象根本不存在于内存中，字段直接成为局部变量。

> [!QUESTION] 软引用做缓存有什么问题？
> 回收时机由 GC 根据空闲堆和 LRU 时间决定，不可预测；大堆下缓存几乎不被清，堆长期高位导致 GC 频繁，一旦清理又集中发生。生产缓存应使用有容量/过期策略的 Caffeine 等组件，而不是依赖 GC 语义。
