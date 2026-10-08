---
level: 深入
tags: [synchronized, Mark Word, ObjectMonitor, 锁升级, 偏向锁]
summary: 从字节码、Mark Word 到 ObjectMonitor 的队列结构，讲清 synchronized 的实现、锁升级的真实路径与偏向锁被移除的原因
---

# synchronized 与锁升级

> [!ABSTRACT] 核心要点
> - 同步块编译为 `monitorenter/monitorexit`（含一条异常路径上的 `monitorexit`），同步方法靠 `ACC_SYNCHRONIZED` 标志；锁的状态记录在对象头 **Mark Word** 的低 2～3 位。
> - 重量级锁是 HotSpot 的 `ObjectMonitor`：`_owner` 记录持有者，竞争者进 `_cxq`/`_EntryList`，调用 `wait()` 的进 `_WaitSet`；它是**非公平**的。
> - 经典升级路径：无锁 → 偏向锁 → 轻量级锁 → 重量级锁。**偏向锁在 JDK 15（JEP 374）默认禁用并废弃，随后的版本中被移除**，现代 JDK 实际路径是：无锁 → 轻量级锁 → 重量级锁。
> - 自旋发生在**膨胀为重量级锁之后、park 之前**（自适应自旋），而不是「轻量级锁一直 CAS 自旋」；空闲的 monitor 会被回收，锁并非「只升不降」。
> - 简单互斥用 `synchronized`；需要可中断、超时、公平、多条件队列或读写分离时用 `ReentrantLock` 家族。

## 用法与字节码

```java
public synchronized void a() { }          // 锁 this
public static synchronized void b() { }   // 锁 Xxx.class
public void c() {
    synchronized (lock) { doWork(); }     // 锁指定对象
}
```

`javap -c -v` 看 `c()` 的字节码（JDK 17，偏移量省略）：

```text
aload_0
getfield      #lock
dup
astore_1                 // 锁对象存入局部变量槽 1
monitorenter             // 进入
invokevirtual doWork
aload_1
monitorexit              // 正常出口
goto          END
astore_2                 // 异常处理器入口（Exception table: type any）
aload_1
monitorexit              // 异常出口：保证锁一定被释放
aload_2
athrow
```

- 编译器保证每条执行路径上 enter/exit 配对，因此 `synchronized` **不会因为异常而忘记解锁**——这是它相对 `Lock` 的一大安全优势。
- 同步方法没有这两条指令，方法表上有 `ACC_SYNCHRONIZED`，解释器/JIT 在方法入口和出口隐式加解锁。
- 可重入：同一线程再次进入，重量级锁中 `_recursions++`；轻量级锁中再压一个 Lock Record。

## Mark Word 布局

对象头 = Mark Word（64 位 JVM 上 8 字节）+ 类型指针（开启压缩类指针时 4 字节）+ 数组长度（仅数组）。对象整体布局见 [运行时数据区与对象模型](#/java/jvm/memory)。

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="64 位 HotSpot Mark Word 在不同锁状态下的位布局">
<text class="ts" x="180" y="30">bit 63</text>
<text class="ts" x="535" y="30" text-anchor="middle">age:4</text>
<text class="ts" x="605" y="30" text-anchor="middle">biased:1</text>
<text class="ts" x="690" y="30" text-anchor="middle">lock:2</text>
<text class="tb" x="20" y="62" dominant-baseline="middle">无锁</text>
<rect class="b" x="180" y="44" width="90" height="36"/>
<text class="tm" x="225" y="62" text-anchor="middle" dominant-baseline="middle">unused:25</text>
<rect class="b" x="270" y="44" width="190" height="36"/>
<text class="tm" x="365" y="62" text-anchor="middle" dominant-baseline="middle">identity_hash:31</text>
<rect class="b" x="460" y="44" width="40" height="36"/>
<text class="tm" x="480" y="62" text-anchor="middle" dominant-baseline="middle">-</text>
<rect class="b" x="500" y="44" width="70" height="36"/>
<text class="tm" x="535" y="62" text-anchor="middle" dominant-baseline="middle">age</text>
<rect class="b" x="570" y="44" width="70" height="36"/>
<text class="tm" x="605" y="62" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b3" x="640" y="44" width="100" height="36"/>
<text class="tm" x="690" y="62" text-anchor="middle" dominant-baseline="middle">01</text>
<text class="tb" x="20" y="106" dominant-baseline="middle">偏向锁</text>
<rect class="b2" x="180" y="88" width="230" height="36"/>
<text class="tm" x="295" y="106" text-anchor="middle" dominant-baseline="middle">thread_id:54</text>
<rect class="b2" x="410" y="88" width="50" height="36"/>
<text class="tm" x="435" y="106" text-anchor="middle" dominant-baseline="middle">epoch</text>
<rect class="b2" x="460" y="88" width="40" height="36"/>
<text class="tm" x="480" y="106" text-anchor="middle" dominant-baseline="middle">-</text>
<rect class="b2" x="500" y="88" width="70" height="36"/>
<text class="tm" x="535" y="106" text-anchor="middle" dominant-baseline="middle">age</text>
<rect class="b2" x="570" y="88" width="70" height="36"/>
<text class="tm" x="605" y="106" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="640" y="88" width="100" height="36"/>
<text class="tm" x="690" y="106" text-anchor="middle" dominant-baseline="middle">01</text>
<text class="tb" x="20" y="150" dominant-baseline="middle">轻量级锁</text>
<rect class="b1" x="180" y="132" width="460" height="36"/>
<text class="tm" x="410" y="150" text-anchor="middle" dominant-baseline="middle">ptr_to_lock_record:62（栈上 Lock Record）</text>
<rect class="b3" x="640" y="132" width="100" height="36"/>
<text class="tm" x="690" y="150" text-anchor="middle" dominant-baseline="middle">00</text>
<text class="tb" x="20" y="194" dominant-baseline="middle">重量级锁</text>
<rect class="b4" x="180" y="176" width="460" height="36"/>
<text class="tm" x="410" y="194" text-anchor="middle" dominant-baseline="middle">ptr_to_ObjectMonitor:62</text>
<rect class="b3" x="640" y="176" width="100" height="36"/>
<text class="tm" x="690" y="194" text-anchor="middle" dominant-baseline="middle">10</text>
<text class="tb" x="20" y="238" dominant-baseline="middle">GC 标记</text>
<rect class="b" x="180" y="220" width="460" height="36"/>
<text class="tm" x="410" y="238" text-anchor="middle" dominant-baseline="middle">GC 使用（如转发指针）</text>
<rect class="b3" x="640" y="220" width="100" height="36"/>
<text class="tm" x="690" y="238" text-anchor="middle" dominant-baseline="middle">11</text>
</svg>
<figcaption>图 1：64 位 Mark Word（经典 JDK 8 布局，各段宽度未按比例绘制）。低 2 位 lock 标志区分状态，01 时再看 biased 位</figcaption>
</figure>

几个推论：

- **identity hashCode 与偏向锁互斥**：偏向锁把 hash 的位置让给了线程 ID。对象一旦计算过 `System.identityHashCode`（或未重写的 `hashCode()`），就无法再偏向；已偏向的对象调用 hashCode 会触发撤销。轻量级锁时 hash 在栈上的 Displaced Mark Word 里，重量级锁时在 `ObjectMonitor._header` 里。
- **分代年龄只有 4 位**，所以 `-XX:MaxTenuringThreshold` 最大 15。
- JDK 24 起引入实验性的紧凑对象头（JEP 450，`-XX:+UseCompactObjectHeaders`），JDK 25 起成为正式特性（默认仍关闭），对象头压缩到 8 字节、布局随之改变；上图是经典布局。

## ObjectMonitor：重量级锁的结构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="ObjectMonitor 的 owner、cxq、EntryList 与 WaitSet 之间的线程流转">
<text class="ts" x="20" y="36">_cxq：单链表，新竞争者 CAS 压入头部</text>
<rect class="b" x="20" y="50" width="60" height="34" rx="6"/>
<text class="t" x="50" y="67" text-anchor="middle" dominant-baseline="middle">T4</text>
<rect class="b" x="110" y="50" width="60" height="34" rx="6"/>
<text class="t" x="140" y="67" text-anchor="middle" dominant-baseline="middle">T5</text>
<rect class="b" x="200" y="50" width="60" height="34" rx="6"/>
<text class="t" x="230" y="67" text-anchor="middle" dominant-baseline="middle">T6</text>
<line class="l" x1="200" y1="67" x2="170" y2="67" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="67" x2="80" y2="67" marker-end="url(#arr)"/>
<line class="ld" x1="140" y1="84" x2="140" y2="164" marker-end="url(#arr)"/>
<text class="ts" x="148" y="128">释放锁时批量迁入</text>
<rect class="b" x="110" y="164" width="60" height="34" rx="6"/>
<text class="t" x="140" y="181" text-anchor="middle" dominant-baseline="middle">T3</text>
<rect class="b" x="200" y="164" width="60" height="34" rx="6"/>
<text class="t" x="230" y="181" text-anchor="middle" dominant-baseline="middle">T2</text>
<line class="l" x1="170" y1="181" x2="200" y2="181"/>
<text class="ts" x="20" y="222">_EntryList：双向链表</text>
<rect class="b1" x="290" y="20" width="180" height="170" rx="10"/>
<text class="tb" x="380" y="40" text-anchor="middle" dominant-baseline="middle">ObjectMonitor</text>
<text class="tm" x="306" y="66" dominant-baseline="middle">_header</text>
<text class="tm" x="306" y="88" dominant-baseline="middle">_owner</text>
<text class="tm" x="306" y="110" dominant-baseline="middle">_recursions</text>
<text class="tm" x="306" y="132" dominant-baseline="middle">_cxq</text>
<text class="tm" x="306" y="154" dominant-baseline="middle">_EntryList</text>
<text class="tm" x="306" y="176" dominant-baseline="middle">_WaitSet</text>
<line class="l" x1="290" y1="132" x2="260" y2="76" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="154" x2="260" y2="178" marker-end="url(#arr)"/>
<rect class="b2" x="560" y="70" width="160" height="40" rx="6"/>
<text class="t" x="640" y="90" text-anchor="middle" dominant-baseline="middle">T1（持有锁）</text>
<line class="l" x1="470" y1="88" x2="560" y2="90" marker-end="url(#arr)"/>
<line class="la" x1="600" y1="110" x2="600" y2="170" marker-end="url(#arr-a)"/>
<text class="ts" x="608" y="144">wait() 释放锁</text>
<rect class="b3" x="560" y="170" width="70" height="34" rx="6"/>
<text class="t" x="595" y="187" text-anchor="middle" dominant-baseline="middle">T7</text>
<rect class="b3" x="650" y="170" width="70" height="34" rx="6"/>
<text class="t" x="685" y="187" text-anchor="middle" dominant-baseline="middle">T8</text>
<line class="l" x1="470" y1="176" x2="560" y2="184" marker-end="url(#arr)"/>
<text class="ts" x="560" y="226">_WaitSet：环形双向链表</text>
<line class="ld" x1="685" y1="204" x2="685" y2="270"/>
<line class="ld" x1="685" y1="270" x2="230" y2="270"/>
<line class="ld" x1="230" y1="270" x2="230" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="458" y="262" text-anchor="middle">notify：移回竞争队列（cxq 或 EntryList，视策略与版本）</text>
<text class="ts" x="20" y="302">owner 释放锁：唤醒 EntryList 头节点重新竞争；非公平，新来的线程可能直接插队成功</text>
</svg>
<figcaption>图 2：ObjectMonitor 的三个队列。cxq 承接新竞争者，EntryList 是候选唤醒队列，WaitSet 存放 wait 的线程</figcaption>
</figure>

```cpp
// HotSpot objectMonitor.hpp（JDK 8/17 结构节选，字段名在更高版本有调整）
class ObjectMonitor {
  volatile markWord _header;      // 对象原来的 Mark Word（含 hash、age）
  void*     volatile _owner;      // 持有锁的线程
  volatile intx _recursions;      // 重入次数
  ObjectWaiter* volatile _cxq;    // 最近到达的竞争者，CAS 头插的单链表
  ObjectWaiter* volatile _EntryList; // 等待被唤醒竞争锁的线程
  ObjectWaiter* volatile _WaitSet;   // 调用 wait() 的线程
  Thread* volatile _succ;         // 「假定继承人」，避免重复唤醒
  volatile int _SpinDuration;     // 自适应自旋的历史时长
};
```

**enter**（简化）：CAS `_owner` 从 null 到自己 → 成功则返回；是自己则 `_recursions++`；否则**自适应自旋**若干轮 → 仍失败则把自己包成 `ObjectWaiter` CAS 压入 `_cxq` → `park` 挂起，被唤醒后再次尝试。

**exit**（简化）：`_recursions--` 到 0 后清 `_owner`；如果 `_EntryList` 为空而 `_cxq` 不空，把 cxq 整体转移到 EntryList；然后 `unpark` EntryList 头节点。被唤醒的线程**还要重新抢**，此时新到的线程可能在它之前 CAS 成功——所以 synchronized 是非公平锁。

**wait / notify**：`wait()` 把当前线程加入 `_WaitSet`、完全释放锁（保存重入次数）后 park；`notify()` 从 WaitSet 取一个节点放到 cxq 或 EntryList（具体策略由 HotSpot 内部决定）；被移动的线程要等到通知方 exit 并重新抢到锁后，才能从 `wait()` 返回。

## 锁升级

<figure class="fig">
<svg viewBox="0 0 760 210" class="dg" role="img" aria-label="synchronized 锁状态升级路径与 JDK 15 之后的变化">
<line class="ld" x1="670" y1="60" x2="670" y2="40"/>
<line class="ld" x1="670" y1="40" x2="90" y2="40"/>
<line class="ld" x1="90" y1="40" x2="90" y2="60" marker-end="url(#arr)"/>
<text class="ts" x="380" y="32" text-anchor="middle">空闲的监视器可被回收（deflation），对象回到无锁状态</text>
<rect class="b" x="20" y="60" width="140" height="80" rx="8"/>
<text class="tb" x="90" y="80" text-anchor="middle" dominant-baseline="middle">无锁</text>
<text class="tm" x="90" y="102" text-anchor="middle" dominant-baseline="middle">001</text>
<text class="ts" x="90" y="124" text-anchor="middle" dominant-baseline="middle">hash 可存在 Mark Word</text>
<rect class="b2" x="213" y="60" width="140" height="80" rx="8"/>
<text class="tb" x="283" y="80" text-anchor="middle" dominant-baseline="middle">偏向锁</text>
<text class="tm" x="283" y="102" text-anchor="middle" dominant-baseline="middle">101</text>
<text class="ts" x="283" y="124" text-anchor="middle" dominant-baseline="middle">Mark Word 记录线程 ID</text>
<rect class="b1" x="407" y="60" width="140" height="80" rx="8"/>
<text class="tb" x="477" y="80" text-anchor="middle" dominant-baseline="middle">轻量级锁</text>
<text class="tm" x="477" y="102" text-anchor="middle" dominant-baseline="middle">00</text>
<text class="ts" x="477" y="124" text-anchor="middle" dominant-baseline="middle">指向栈上 Lock Record</text>
<rect class="b4" x="600" y="60" width="140" height="80" rx="8"/>
<text class="tb" x="670" y="80" text-anchor="middle" dominant-baseline="middle">重量级锁</text>
<text class="tm" x="670" y="102" text-anchor="middle" dominant-baseline="middle">10</text>
<text class="ts" x="670" y="124" text-anchor="middle" dominant-baseline="middle">指向 ObjectMonitor</text>
<line class="l" x1="160" y1="100" x2="213" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="186" y="92" text-anchor="middle">首次加锁</text>
<line class="l" x1="353" y1="100" x2="407" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="380" y="92" text-anchor="middle">有竞争</text>
<line class="l" x1="547" y1="100" x2="600" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="573" y="92" text-anchor="middle">CAS 失败</text>
<line class="la" x1="90" y1="140" x2="90" y2="176"/>
<line class="la" x1="90" y1="176" x2="477" y2="176"/>
<line class="la" x1="477" y1="176" x2="477" y2="140" marker-end="url(#arr-a)"/>
<text class="ta" x="283" y="196" text-anchor="middle">JDK 15+ 偏向锁默认关闭：首次加锁直接走轻量级锁</text>
</svg>
<figcaption>图 3：锁状态流转。偏向锁这条路在现代 JDK 上已不存在，重量级锁在空闲时也能降回无锁</figcaption>
</figure>

### 偏向锁（历史机制）

- 动机：大量锁实际上只被一个线程反复获取（如早期的 `Vector`、`StringBuffer`），连 CAS 都想省掉。
- 加锁：第一次 CAS 把线程 ID 写入 Mark Word；之后同一线程进入只需比较线程 ID，无原子指令。
- 撤销：另一线程来竞争时，需要在**安全点**（较新版本部分改为线程级 handshake）检查偏向线程是否仍在同步块内，再升级为轻量级锁或恢复无锁——撤销代价很高。
- 批量重偏向/批量撤销：以类为单位统计撤销次数，达到阈值（默认 20 次重偏向、40 次撤销）后通过 `epoch` 让该类对象批量重偏向，或直接禁用该类的偏向。
- JDK 8 默认在启动 4 秒后才启用（`-XX:BiasedLockingStartupDelay=4000`），因为启动阶段竞争多、撤销频繁。

> [!NOTE] 偏向锁的废弃时间线
> - **JDK 15（JEP 374）**：默认禁用（`UseBiasedLocking=false`），并标记为废弃；仍可手动 `-XX:+UseBiasedLocking` 打开。
> - **之后的版本**：相关参数被置为过时（obsolete），HotSpot 中的实现代码被移除（大约在 JDK 18 前后），现代 JDK 已无法再开启。
>
> 理由：现代应用普遍使用不加锁的集合或 JUC，偏向锁的收益变小；撤销依赖安全点、实现侵入 HotSpot 多处代码，维护成本大。升级到 JDK 17 后若发现某些老代码（大量 `Vector`/`Hashtable`/`StringBuffer` 单线程使用）性能略降，可能与此有关。

### 轻量级锁

经典实现（JDK 8 及之后的 legacy 模式）：

1. 在当前栈帧中分配 **Lock Record**，把对象当前 Mark Word 复制进去（Displaced Mark Word）。
2. CAS 把对象 Mark Word 替换为指向该 Lock Record 的指针（低位 00）。
3. 成功即获得锁；若 Mark Word 已指向**自己栈上**的 Lock Record，说明是重入，压一个 displaced 为 null 的 Lock Record 计数。
4. 失败说明有竞争 → **膨胀**（inflate）为重量级锁。
5. 解锁时 CAS 把 Displaced Mark Word 写回；失败说明期间已被膨胀，走重量级锁的 exit 流程。

> [!NOTE] 新的轻量级锁实现
> JDK 21 引入了基于线程私有 **lock-stack** 的新轻量级锁（`-XX:LockingMode=2`，即 LM_LIGHTWEIGHT），不再把 Mark Word 复制到栈上，只在 Mark Word 中改锁位，并在线程的 lock-stack 里记录持有的对象；它在后续版本（约 JDK 23）成为默认，也是 JDK 24 虚拟线程不再因 synchronized 而 pin（JEP 491）的基础之一。概念上「无竞争时一次 CAS、竞争时膨胀」不变。

### 自适应自旋

- 常见误解：「轻量级锁失败后会一直自旋 CAS」。HotSpot 实际是轻量级 CAS 失败就膨胀，**自旋发生在 `ObjectMonitor::enter` 中、park 之前**。
- 自适应：同一个锁上次自旋成功获得过锁，就允许更长的自旋；很少成功则缩短甚至跳过，直接 park。JDK 7 起 `-XX:+UseSpinning` 等早期自旋参数已失效，自旋策略由 JVM 自行决定。
- 自旋只在多核上有意义；临界区很短时，自旋几十到几百个周期远比 park/unpark 的两次上下文切换便宜。

### 锁消除与锁粗化（JIT 优化）

```java
// 锁消除：sb 没有逃逸出方法，StringBuffer 内部的 synchronized 被 C2 删除
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer();
    sb.append(a).append(b);
    return sb.toString();
}
// 锁粗化：循环内反复对同一对象加解锁，JIT 可能合并为一次更大范围的加锁
for (int i = 0; i < 100; i++) {
    synchronized (lock) { count++; }
}
```

- 锁消除依赖逃逸分析（`-XX:+DoEscapeAnalysis`、`-XX:+EliminateLocks`，C2 下默认开启）。
- 这些都是 JIT 编译后的优化，解释执行阶段不生效；基准测试必须充分预热（用 JMH），否则结论会失真。

### 监视器的回收（deflation）

重量级锁并非「只升不降」：长期空闲的 `ObjectMonitor` 会被 deflate，对象 Mark Word 恢复为无锁状态，monitor 回收复用。早期版本只能在安全点批量做，JDK 15 起改为由专门线程**异步** deflation，减少了安全点停顿。

## synchronized vs ReentrantLock

| 维度 | synchronized | ReentrantLock |
| --- | --- | --- |
| 实现层 | JVM（ObjectMonitor + Mark Word） | JDK 代码（AQS + CAS + park） |
| 释放 | 自动，异常也安全 | 必须 `finally { unlock(); }` |
| 可中断 | 否 | `lockInterruptibly()` |
| 超时 / 尝试 | 否 | `tryLock()`、`tryLock(timeout)` |
| 公平性 | 非公平 | 默认非公平，可选公平 |
| 条件队列 | 一个（wait/notify） | 多个 `Condition` |
| 可观测性 | jstack 显示锁持有者 | `getQueueLength`、`isLocked`、`hasQueuedThreads` 等 |
| 性能 | JDK 6 后与 ReentrantLock 相当，无竞争时更省 | 高竞争下相当，功能更多 |
| 虚拟线程 | JDK 21–23 阻塞时 pin 载体；JDK 24+ 改善 | 不 pin |

选择原则：**默认 `synchronized`**（代码简单、不会漏解锁、JVM 持续优化）；需要上表中 ReentrantLock 独有的能力时再换。原理见 [AQS 与显式锁](#/java/concurrency/aqs)。

## 生产实践与踩坑

> [!CAUTION] 锁住了错误的对象
> - `synchronized ("LOCK")`：字符串字面量全 JVM 共享，不相关的模块会互相阻塞。
> - `synchronized (count)`（`Integer`）：`count++` 后对象换了，等于每次锁不同对象；且 -128~127 的 `Integer` 是缓存共享的。
> - `synchronized (this.list)` 后又给 `list` 重新赋值：锁对象被替换，互斥失效。锁字段应为 `private final Object lock = new Object();`。

> [!WARNING] 实例锁与静态锁混用
> `synchronized` 实例方法锁 `this`，`static synchronized` 锁 `Class`，二者**互不互斥**。实例方法修改静态变量时用实例锁是保护不住的。

> [!WARNING] 死锁排查
> `jstack <pid>` 末尾会直接打印 `Found one Java-level deadlock`，列出互相等待的线程与锁地址；Arthas `thread -b` 可找出阻塞其他线程最多的持锁线程。预防：固定加锁顺序、缩小同步块、对 `ReentrantLock` 使用 `tryLock(timeout)` 兜底。

- 同步块内不要做 RPC、IO、`Thread.sleep`：持锁时间放大后，所有竞争者都在 BLOCKED，吞吐直接塌陷；在 JDK 21–23 的虚拟线程上还会 pin 住载体线程。
- `wait/notify` 用于新代码时优先考虑 `Condition` 或更高层的 `BlockingQueue`、`CountDownLatch`。
- 观测锁竞争：JFR 的 `jdk.JavaMonitorEnter`（等待进入 monitor 超过阈值的事件）、`jdk.JavaMonitorWait`；async-profiler 的 `-e lock` 模式可以给出锁竞争火焰图。

## 面试追问

> [!QUESTION] synchronized 是怎么保证可见性和有序性的？
> 依据 happens-before 的监视器规则：对同一锁的 unlock hb 后续的 lock。实现上 monitorenter 之后有 acquire 语义的屏障、monitorexit 之前有 release 语义的屏障，CAS 本身（x86 的 `lock cmpxchg`）也是全屏障。注意临界区**内部**仍可能重排，只是不会移出临界区。

> [!QUESTION] 为什么说 synchronized 是非公平的？公平在哪里体现不了？
> 释放锁时 owner 先清空再唤醒后继，被唤醒线程需要重新竞争；此时新到达的线程在 enter 的快速 CAS 或自旋中就可能直接拿到锁。另外 cxq 是 LIFO 头插，迁移到 EntryList 后的唤醒顺序也不保证先来先得。

> [!QUESTION] 偏向锁为什么被废弃？去掉后对性能有什么影响？
> 收益只在「单线程反复加锁」场景，而现代代码中这类场景已很少；撤销需要安全点/handshake，在有竞争的服务端应用里反而增加停顿；实现复杂、牵扯 HotSpot 多个子系统。去掉后单线程加锁多一次 CAS，对绝大多数应用影响可忽略，少数重度使用老式同步容器的程序可能略有下降。

> [!QUESTION] 锁会降级吗？
> 对象层面，空闲的重量级锁会被 deflate 回无锁状态（JDK 15 起异步进行），所以不是严格「只升不降」；但在持锁或竞争期间不会从重量级降回轻量级。偏向锁被撤销后也可能回到无锁。

> [!QUESTION] wait() 为什么要在 synchronized 中调用？notify 之后被唤醒的线程立刻执行吗？
> wait 需要释放并在返回前重新获取 monitor，必须先持有它；同时「检查条件 + 等待」必须原子，否则会丢失唤醒。notify 只是把线程从 WaitSet 移到竞争队列，它要等通知方退出同步块并重新抢到锁后才会从 wait 返回，返回后还应在 while 中重新检查条件。
