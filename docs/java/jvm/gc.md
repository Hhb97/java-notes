---
level: 深入
tags: [JVM, GC, 三色标记, 卡表, 安全点, GC 日志]
summary: 垃圾回收的通用底座：可达性分析、三色标记与漏标、记忆集与写屏障、安全点、分代与晋升规则、GC 触发条件，以及如何逐字段读懂 JDK 9+ 统一 GC 日志
---

# 垃圾回收算法与分代

> [!ABSTRACT] 核心要点
> - HotSpot 用**可达性分析**判活，GC Roots 包括栈中引用、静态字段、JNI 引用、锁对象等；借助 **OopMap** 在安全点上精确枚举根。
> - 并发标记会**漏标**，必须同时满足「插入黑→白引用」和「删除灰→白全部路径」两个条件；CMS 用**增量更新**破坏前者，G1/Shenandoah 用 **SATB** 破坏后者，都靠写屏障实现。
> - 分代收集的前提是跨代引用很少；老年代→新生代的引用由**卡表**（每 512 字节一个字节）记录，Young GC 只扫脏卡，不扫全部老年代。
> - 对象晋升三条路：年龄达到 `MaxTenuringThreshold`、**动态年龄判定**、Survivor 放不下；大对象可直接进入老年代。
> - JDK 9+ 统一用 `-Xlog:gc*` 输出 GC 日志，读懂 `Pause Young (Normal)`、`Eden regions: 150->0(148)`、`1866M->1290M(4096M) 13.9ms` 是线上排查的基本功。

## 判活：可达性分析与 GC Roots

引用计数无法处理循环引用（A↔B 互相引用但外界不可达），HotSpot 所有收集器都使用**可达性分析**：从一组 GC Roots 出发遍历引用图，不可达的对象即为垃圾。

GC Roots 主要包括：

| 类别 | 说明 |
| --- | --- |
| 虚拟机栈中的引用 | 各线程栈帧局部变量表、操作数栈中的 reference |
| 本地方法栈中的 JNI 引用 | JNI Local / Global Reference |
| 类的静态字段 | 存在 `java.lang.Class` mirror 中（JDK 7+） |
| 常量引用 | 字符串常量池（StringTable）中的引用 |
| 同步锁持有的对象 | 被 `synchronized` 锁住的对象 |
| JVM 内部引用 | 基本类型的 Class 对象、常驻异常对象（如预分配的 OOM）、系统类加载器等 |
| 局部回收时的「临时根」 | 只收新生代时，老年代指向新生代的引用（由记忆集提供） |

**OopMap**：如果每次 GC 都去逐个扫描栈的每个字，既慢又无法区分「这是引用还是恰好长得像地址的 long」。JIT 在编译时会在特定位置（安全点）记录「此刻哪些寄存器、栈槽是引用」，即 OopMap。GC 时直接读 OopMap 就能**精确**枚举根，这也是 HotSpot 是**准确式 GC** 的基础。根节点枚举必须在一致性快照下进行，所以这一步总要 STW（ZGC/Shenandoah 在 JDK 16 前后把线程栈扫描也做成了并发的）。

## 三种基础算法

| 算法 | 过程 | 优点 | 缺点 | 使用者 |
| --- | --- | --- | --- | --- |
| 标记-清除 | 标记存活后直接清除垃圾 | 不移动对象，停顿可控 | 碎片；分配需空闲列表 | CMS 老年代 |
| 标记-复制 | 存活对象复制到另一块空间 | 无碎片，分配快（指针碰撞） | 浪费空间；存活率高时复制代价大 | 各收集器新生代 |
| 标记-整理 | 存活对象向一端滑动 | 无碎片，不浪费空间 | 移动对象需更新所有引用，停顿长 | Serial Old、Parallel Old、Full GC |

新生代对象「朝生夕死」，存活率通常远低于 10%，所以 HotSpot 用 Appel 式复制：Eden + 两个 Survivor，默认 `-XX:SurvivorRatio=8`，即 Eden : S0 : S1 = 8 : 1 : 1，只浪费 10%。

## 三色标记与并发标记的漏标

<figure class="fig">
<svg viewBox="0 0 760 305" class="dg" role="img" aria-label="三色标记过程中用户线程并发修改引用导致白色对象被漏标">
<rect class="bg" x="20" y="20" width="350" height="190" rx="12"/>
<text class="ts" x="36" y="40">① 并发标记进行中</text>
<rect class="b" x="40" y="100" width="60" height="40" rx="6"/>
<text class="tb" x="70" y="120" text-anchor="middle" dominant-baseline="middle">Root</text>
<rect class="bf" x="130" y="100" width="60" height="40" rx="6"/>
<text class="tw" x="160" y="120" text-anchor="middle" dominant-baseline="middle">A</text>
<rect class="b3" x="220" y="100" width="60" height="40" rx="6"/>
<text class="tb" x="250" y="120" text-anchor="middle" dominant-baseline="middle">B</text>
<rect class="b" x="304" y="100" width="56" height="40" rx="6"/>
<text class="tb" x="332" y="120" text-anchor="middle" dominant-baseline="middle">C</text>
<line class="l" x1="100" y1="120" x2="128" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="120" x2="218" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="120" x2="302" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="36" y="172">实心 = 黑（自身及引用均已扫描）</text>
<text class="ts" x="36" y="192">琥珀 = 灰（已标记，引用未扫完）；白底 = 白</text>
<rect class="bg" x="390" y="20" width="350" height="190" rx="12"/>
<text class="ts" x="406" y="40">② 用户线程并发修改引用</text>
<rect class="b" x="410" y="100" width="60" height="40" rx="6"/>
<text class="tb" x="440" y="120" text-anchor="middle" dominant-baseline="middle">Root</text>
<rect class="bf" x="500" y="100" width="60" height="40" rx="6"/>
<text class="tw" x="530" y="120" text-anchor="middle" dominant-baseline="middle">A</text>
<rect class="b3" x="590" y="100" width="60" height="40" rx="6"/>
<text class="tb" x="620" y="120" text-anchor="middle" dominant-baseline="middle">B</text>
<rect class="b" x="680" y="100" width="56" height="40" rx="6"/>
<text class="tb" x="708" y="120" text-anchor="middle" dominant-baseline="middle">C</text>
<line class="l" x1="470" y1="120" x2="498" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="120" x2="588" y2="120" marker-end="url(#arr)"/>
<line class="ld" x1="650" y1="120" x2="678" y2="120"/>
<text class="ta" x="664" y="156" text-anchor="middle">B.c = null</text>
<line class="la" x1="530" y1="100" x2="530" y2="70"/>
<line class="la" x1="530" y1="70" x2="708" y2="70"/>
<line class="la" x1="708" y1="70" x2="708" y2="98" marker-end="url(#arr-a)"/>
<text class="ta" x="619" y="62" text-anchor="middle">A.c = C（新增）</text>
<text class="ta" x="406" y="192">C 仍被 A 引用，却始终是白色 → 被误回收</text>
<text class="t" x="20" y="242">漏标需同时满足：(1) 插入一条黑 → 白的引用；(2) 删除了灰 → 该白对象的全部路径。</text>
<text class="t" x="20" y="266">增量更新（CMS）破坏条件 1：记录新插入的引用，重新标记时以这些黑对象为根再扫一遍。</text>
<text class="t" x="20" y="290">SATB（G1 / Shenandoah）破坏条件 2：删除引用前把旧值记入队列，按标记开始时的快照视为存活。</text>
</svg>
<figcaption>图 1：三色标记与漏标（对象消失）问题</figcaption>
</figure>

三色抽象：

- **白**：尚未访问。标记结束仍为白的对象就是垃圾。
- **灰**：自身已被标记，但它引用的对象还没全部扫描。
- **黑**：自身及其所有引用都已扫描完。黑色对象**不会再被重新扫描**。

单线程 STW 下三色标记没有问题；与用户线程并发时，用户线程可能「把白对象藏到黑对象后面」，如图 1。错标为存活（浮动垃圾）只是晚一轮回收，**错标为死亡**则是程序崩溃级别的错误。Wilson 在 1994 年证明，漏标当且仅当以下两个条件同时成立：

1. 赋值器插入了一条从黑对象到白对象的新引用；
2. 赋值器删除了全部从灰对象到该白对象的直接或间接引用。

| 方案 | 破坏的条件 | 屏障位置 | 记录内容 | 代价 | 使用者 |
| --- | --- | --- | --- | --- | --- |
| 增量更新 Incremental Update | 条件 1 | 写后（post-write） | 新插入的引用（或把黑对象重新置灰） | 重新标记阶段要重扫，STW 可能较长 | CMS |
| 原始快照 SATB | 条件 2 | 写前（pre-write） | 被覆盖的旧引用值 | 产生更多浮动垃圾；标记期间新分配对象一律视为存活 | G1、Shenandoah |

```cpp
// G1 SATB 写前屏障（概念伪代码）：obj.field = new_val
void g1_pre_write_barrier(oop* field) {
    if (marking_is_active) {               // 只在并发标记期间生效
        oop old = *field;
        if (old != nullptr) {
            satb_queue.enqueue(old);       // 记录旧值，保证快照中可达的对象不丢
        }
    }
}
```

> [!NOTE] ZGC 为什么不需要这两种方案
> ZGC 用**读屏障**：应用线程从堆中加载引用时，若指针颜色不是当前「好颜色」，屏障会顺手把对象标记（推入标记栈）。应用线程想把白对象挂到黑对象下，必须先读到这个白对象的引用，而读的那一刻它就被标记了，从源头上避免了漏标。详见 [G1 与 ZGC 深入](#/java/jvm/collectors)。

## 记忆集、卡表与写屏障

只回收新生代时，老年代对象可能引用新生代对象，这些引用必须当作根，否则会误回收。为了不扫描整个老年代，收集器维护**记忆集（Remembered Set）**：记录「从非收集区域指向收集区域的指针」的抽象数据结构。按精度可以是字长精度、对象精度或**卡精度**，HotSpot 普遍采用卡精度，即**卡表（Card Table）**：

- 堆按 **512 字节**（`card_shift = 9`）划分为卡页，卡表是一个字节数组，每个元素对应一张卡页。
- 某卡页中只要有一个对象字段存在跨代引用，该卡标记为脏（HotSpot 中脏卡值为 0）。
- Young GC 时只需把脏卡对应的老年代内存当作根来扫描。

维护卡表的时机是「引用字段被赋值时」，靠**写屏障**（可以理解为 JVM 层面对引用赋值操作的 AOP 环绕，与 CPU 内存屏障无关）：

```cpp
// Serial / Parallel / CMS 的卡表写后屏障（概念伪代码）
void oop_field_store(oop* field, oop new_value) {
    *field = new_value;
    card_table[(uintptr_t)field >> 9] = 0;   // 0 = dirty，无条件标脏，只有两三条机器指令
}
```

> [!WARNING] 卡表的伪共享
> 64 字节缓存行对应 64 个卡表项，即 64 × 512B = 32KB 堆内存。多线程频繁更新这 32KB 范围内的不同对象时，会反复写同一缓存行。`-XX:+UseCondCardMark`（JDK 7 引入）改为「先判断是否已脏再写」，用一次额外读换掉无谓的写，在高并发写场景下有收益，默认关闭。

G1 的写后屏障更复杂：先过滤同 Region 引用、null 值、新生代卡，再把脏卡放入线程的 dirty card queue，由 Refinement 线程异步更新目标 Region 的 RSet，详见 [G1 与 ZGC 深入](#/java/jvm/collectors)。

## 安全点与安全区域

OopMap 只在特定位置生成，线程也只能在这些位置停下来配合 GC，这些位置叫**安全点（Safepoint）**。选择标准是「指令序列复用、可能长时间执行」的位置：

- 方法返回前 / 方法调用处
- 非计数循环的回边（循环跳转处）
- 可能抛出异常的位置

**如何让线程停下**：HotSpot 用主动式中断，VM 线程设置标志，Java 线程在安全点轮询（polling）该标志并自行挂起。JDK 10 起轮询改为**线程级握手**（Thread-Local Handshakes，JEP 312），每个线程有自己的 polling word，可以只停单个线程（如撤销偏向锁、获取单个线程栈）。

**安全区域（Safe Region）**：处于 `sleep`、`BLOCKED`、执行 native 代码的线程无法响应轮询。它们进入安全区域时打标记，期间引用关系不会变化，GC 无需等待它们；离开安全区域时若 GC 未结束（根枚举未完成）就必须等待。这也是执行 JNI 代码的线程不阻塞 GC 的原因。

> [!CAUTION] 计数循环导致的「进入安全点超时」
> C2 认为 `int` 计数循环（`for (int i = 0; i < n; i++)`）很快会结束，历史上会**省略循环内的安全点轮询**。如果循环体处理上亿元素，其它所有线程已停在安全点，只等这一个线程，表现为一次 GC 实际停顿几秒但日志里 GC 本身只有几十毫秒。
> - JDK 10 起引入 Loop Strip Mining（`-XX:LoopStripMiningIter`，默认 1000），把大循环切成小段插入轮询，基本解决了这一问题；
> - JDK 8 下可用 `-XX:+UseCountedLoopSafepoints` 规避，或把循环变量改为 `long`；
> - 排查用 `-Xlog:safepoint`（JDK 9+），关注 `Reaching safepoint` 耗时，即 TTSP（Time To Safepoint）。

## 分代收集理论

| 假说 | 内容 | 推论 |
| --- | --- | --- |
| 弱分代假说 | 绝大多数对象朝生夕死 | 新生代用复制算法，频繁、低成本地回收 |
| 强分代假说 | 熬过越多次 GC 的对象越难消亡 | 老年代低频回收，用标记-清除/整理 |
| 跨代引用假说 | 跨代引用相对同代引用占极少数 | 不必为跨代引用扫描整个老年代，用卡表记录即可 |

## 对象分配与晋升规则

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="对象从 Eden 经 Survivor 晋升到老年代的路径及晋升条件">
<text class="ts" x="265" y="30" text-anchor="middle">新生代（Eden : S0 : S1 默认 8 : 1 : 1，SurvivorRatio=8）</text>
<text class="ts" x="650" y="30" text-anchor="middle">老年代</text>
<rect class="b1" x="20" y="44" width="220" height="80" rx="8"/>
<text class="tb" x="130" y="72" text-anchor="middle" dominant-baseline="middle">Eden</text>
<text class="ts" x="130" y="98" text-anchor="middle" dominant-baseline="middle">新对象优先在此分配（TLAB）</text>
<rect class="b2" x="270" y="44" width="110" height="80" rx="8"/>
<text class="tb" x="325" y="72" text-anchor="middle" dominant-baseline="middle">S0 / From</text>
<text class="ts" x="325" y="98" text-anchor="middle" dominant-baseline="middle">age 1..n</text>
<rect class="b2" x="400" y="44" width="110" height="80" rx="8"/>
<text class="tb" x="455" y="72" text-anchor="middle" dominant-baseline="middle">S1 / To</text>
<text class="ts" x="455" y="98" text-anchor="middle" dominant-baseline="middle">本次复制目标</text>
<rect class="b3" x="560" y="44" width="180" height="80" rx="8"/>
<text class="tb" x="650" y="72" text-anchor="middle" dominant-baseline="middle">Old</text>
<text class="ts" x="650" y="98" text-anchor="middle" dominant-baseline="middle">长期存活 / 大对象</text>
<line class="l" x1="130" y1="124" x2="130" y2="152"/>
<line class="l" x1="130" y1="152" x2="455" y2="152"/>
<line class="l" x1="455" y1="152" x2="455" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="84" x2="398" y2="84" marker-end="url(#arr)"/>
<line class="la" x1="510" y1="84" x2="558" y2="84" marker-end="url(#arr-a)"/>
<text class="ta" x="534" y="74" text-anchor="middle">②</text>
<text class="ts" x="292" y="172" text-anchor="middle">① Minor GC：Eden 与 From 中的存活对象复制到 To，age + 1，然后 From / To 互换</text>
<text class="tb" x="20" y="208">② 晋升到老年代的条件</text>
<text class="t" x="20" y="232">· age ≥ MaxTenuringThreshold（默认 15，Mark Word 中只有 4 位；使用 CMS 时默认 6）</text>
<text class="t" x="20" y="254">· 动态年龄：age 1..n 的对象总大小 > To 容量 × TargetSurvivorRatio（50%），阈值降为 n</text>
<text class="t" x="20" y="276">· To 区放不下本次存活对象：溢出部分提前晋升（premature promotion）</text>
<text class="t" x="20" y="298">· 大对象直接进老年代：Serial / ParNew 的 PretenureSizeThreshold，G1 的 Humongous Region</text>
</svg>
<figcaption>图 2：对象分配与晋升路径</figcaption>
</figure>

动态年龄判定的源码（JDK 8 `ageTable.cpp`，节选）：

```cpp
uint ageTable::compute_tenuring_threshold(size_t survivor_capacity) {
  // 期望的 Survivor 使用量 = Survivor 容量 × TargetSurvivorRatio%
  size_t desired_survivor_size = (size_t)((((double) survivor_capacity) * TargetSurvivorRatio) / 100);
  size_t total = 0;
  uint age = 1;
  while (age < table_size) {
    total += sizes[age];                       // 从年龄 1 开始累加各年龄对象的大小
    if (total > desired_survivor_size) break;  // 累加超过阈值时停下
    age++;
  }
  // 新阈值取「停下的年龄」与 MaxTenuringThreshold 的较小值
  uint result = age < MaxTenuringThreshold ? age : MaxTenuringThreshold;
  return result;
}
```

注意是**从年龄 1 累加到 n**，而不是「某个年龄的对象超过一半」。加 `-Xlog:gc+age=trace` 可以在每次 Young GC 后打印年龄分布和新阈值 `Desired survivor size ... new threshold 3 (max threshold 15)`。

**空间分配担保**：Minor GC 前，若老年代最大连续可用空间 > 新生代所有对象总和，则这次 Minor GC 是安全的；否则看老年代可用空间是否 > 历次晋升的平均大小，满足就冒险做 Minor GC，失败（promotion failed）再做 Full GC；不满足直接改做 Full GC。JDK 6u24 之后 `-XX:HandlePromotionFailure` 参数已不再生效，规则固定为上述后半段。

## Minor / Major / Full GC 的触发条件

| 名称 | 回收范围 | 典型触发条件 |
| --- | --- | --- |
| Minor GC / Young GC | 新生代 | Eden 无法为新对象（或新 TLAB）分配空间 |
| Major GC / Old GC | 老年代 | 只有 CMS 有单独的老年代并发收集，达到 `CMSInitiatingOccupancyFraction`；口语中常与 Full GC 混用 |
| Mixed GC | 新生代 + 部分老年代 Region | G1 并发标记结束后 |
| Full GC | 整个堆 + 元空间 | 见下表 |

Full GC 的常见原因（GC 日志中的 cause 字段）：

| GC cause | 含义 | 处理思路 |
| --- | --- | --- |
| `Allocation Failure`（老年代） | 老年代放不下晋升对象或大对象 | 检查是否内存泄漏、老年代是否过小 |
| `Metadata GC Threshold` | 元空间达到高水位线 | 启动期调大 `MetaspaceSize`；运行期持续发生则查类泄漏 |
| `System.gc()` | 显式调用（含 `Bits.reserveMemory`、RMI DGC 每小时一次） | `ExplicitGCInvokesConcurrent`，排查调用方 |
| `Heap Dump Initiated GC` / `Heap Inspection Initiated GC` | `jmap -dump:live`、`jmap -histo:live` | 线上谨慎使用 `live` 选项 |
| `promotion failed` / `concurrent mode failure` | CMS 晋升失败或并发回收赶不上分配 | 提前触发 CMS、加大老年代 |
| `G1 Evacuation Pause` → `to-space exhausted` | G1 复制时没有空闲 Region | 加大堆、降低 IHOP、避免大对象 |
| `G1 Compaction Pause` | G1 回退到 Full GC | 同上，属于严重告警 |

## 收集器总览

| 收集器 | 区域 | 算法 | 线程 | 关注点 | 版本状态 |
| --- | --- | --- | --- | --- | --- |
| Serial / Serial Old | 新生代 / 老年代 | 复制 / 标记-整理 | 单线程 STW | 小内存、客户端、容器单核 | 一直保留；非 server 级机器（< 2 核或 < 2GB）默认 |
| ParNew | 新生代 | 复制 | 多线程 STW | 配合 CMS | JDK 9 起只能与 CMS 组合，随 CMS 移除 |
| Parallel Scavenge / Old | 新生代 / 老年代 | 复制 / 标记-整理 | 多线程 STW | 吞吐量 | JDK 8 默认 |
| CMS | 老年代 | 标记-清除，并发 | 并发 | 低停顿 | JDK 9 废弃，JDK 14 移除（JEP 363） |
| G1 | 全堆（Region） | 整体标记-整理，局部复制 | 并发标记 + 并行转移 | 可预测停顿 | JDK 9 起默认（JEP 248） |
| ZGC | 全堆 | 并发标记-整理（着色指针 + 读屏障） | 并发 | 亚毫秒停顿 | JDK 15 正式；JDK 21 分代；JDK 23 默认分代模式 |
| Shenandoah | 全堆 | 并发标记-整理 | 并发 | 低停顿 | JDK 15 正式（JEP 379） |
| Epsilon | — | 只分配不回收 | — | 性能测试、极短任务 | JDK 11（JEP 318） |

> [!TIP] 如何确认当前用的是什么收集器
> `java -XX:+PrintCommandLineFlags -version` 会打印 JVM 按机器配置自动选择的收集器；运行中的进程用 `jcmd <pid> VM.flags`。容器中如果只给了 1 个 CPU 或不到约 2GB 内存，JDK 9+ 会认为不是「服务器级机器」而悄悄选择 Serial，导致停顿异常，建议显式指定收集器。

## 统一 GC 日志：-Xlog 逐字段解读

JDK 9（JEP 158、271）把所有日志统一到 `-Xlog`，语法是 `-Xlog:<tags>=<level>:<output>:<decorators>:<output-options>`：

```bash
# JDK 9+ 推荐：GC 全部标签 info 级，写文件、带时间戳，按 50MB 滚动保留 10 个
-Xlog:gc*=info:file=/data/logs/gc-%p-%t.log:time,uptime,level,tags:filecount=10,filesize=50m

# 只看安全点与年龄分布
-Xlog:safepoint=info,gc+age=trace:file=/data/logs/safepoint.log:time,uptime
```

JDK 8 旧参数的对应关系：`-XX:+PrintGCDetails` → `-Xlog:gc*`；`-Xloggc:file` → `:file=`；`-XX:+PrintGCDateStamps` → 装饰器 `time`；`-XX:+PrintTenuringDistribution` → `gc+age=trace`；`-XX:+PrintGCApplicationStoppedTime` → `safepoint`。

JDK 17 + G1 一次 Young GC 的日志（Region 4MB，省略了时间装饰器）：

```text
[info][gc,start    ] GC(42) Pause Young (Normal) (G1 Evacuation Pause)
[info][gc,task     ] GC(42) Using 8 workers of 8 for evacuation
[info][gc,phases   ] GC(42)   Pre Evacuate Collection Set: 0.1ms
[info][gc,phases   ] GC(42)   Merge Heap Roots: 0.3ms
[info][gc,phases   ] GC(42)   Evacuate Collection Set: 11.8ms
[info][gc,phases   ] GC(42)   Post Evacuate Collection Set: 1.2ms
[info][gc,phases   ] GC(42)   Other: 0.5ms
[info][gc,heap     ] GC(42) Eden regions: 150->0(148)
[info][gc,heap     ] GC(42) Survivor regions: 10->12(19)
[info][gc,heap     ] GC(42) Old regions: 300->305
[info][gc,heap     ] GC(42) Archive regions: 2->2
[info][gc,heap     ] GC(42) Humongous regions: 5->5
[info][gc,metaspace] GC(42) Metaspace: 98765K(99840K)->98765K(99840K) NonClass: 86000K(86528K)->86000K(86528K) Class: 12765K(13312K)->12765K(13312K)
[info][gc          ] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 1866M->1290M(4096M) 13.9ms
[info][gc,cpu      ] GC(42) User=0.09s Sys=0.01s Real=0.01s
```

| 字段 | 含义 | 看什么 |
| --- | --- | --- |
| `GC(42)` | JVM 启动后第 42 次 GC，同一次 GC 的多行用它关联 | 用 grep 把一次 GC 的所有行串起来 |
| `Pause Young (Normal)` | 纯年轻代回收；还可能是 `(Concurrent Start)`、`(Prepare Mixed)`、`(Mixed)` | 出现 `Pause Full` 要高度警惕 |
| `(G1 Evacuation Pause)` | GC cause，Eden 满触发 | `G1 Humongous Allocation`、`Metadata GC Threshold` 等说明另有原因 |
| `Using 8 workers of 8` | 并行 GC 线程数 `ParallelGCThreads` | 容器中是否被识别为过少 CPU |
| `Evacuate Collection Set` | 扫描根、复制存活对象的主体耗时 | 占比最大；高说明存活对象多 |
| `Merge Heap Roots` | 把 RSet 与未处理的脏卡合并进卡表（较新 JDK 的阶段名） | 高说明跨 Region 引用多，Refinement 跟不上 |
| `Eden regions: 150->0(148)` | GC 前 150 个、GC 后 0 个，括号内是**下次**的 Eden 目标数 | 括号值在变化，说明 G1 在按停顿目标调整年轻代 |
| `Survivor regions: 10->12(19)` | 括号内是 Survivor 上限 | 接近上限说明会提前晋升 |
| `Old regions: 300->305` | 本次晋升了约 5 个 Region | 持续增长且 Mixed 后不降 → 泄漏嫌疑 |
| `Humongous regions` | 大对象占用 | 数值大/变化频繁 → 考虑调大 Region |
| `Metaspace: 98765K(99840K)` | 已用（已提交） | 持续上涨 → 类泄漏 |
| `1866M->1290M(4096M) 13.9ms` | 堆已用 GC 前 → GC 后（当前堆总容量），**本次停顿时长** | 停顿是否超出 `MaxGCPauseMillis` |
| `User / Sys / Real` | GC 线程用户态、内核态 CPU 时间，以及墙钟时间 | `Real` 远大于 `User/线程数` → 等待 IO/swap；`Sys` 高 → 内存换页或透明大页问题 |

> [!TIP] 日志分析工具
> GCViewer、GCeasy（在线）可以直接导入 `-Xlog` 日志，输出吞吐、停顿分布、晋升速率等指标。更细的分析用 JFR 的 GC 事件，见 [线上调优与故障排查](#/java/jvm/tuning)。

## 生产实践与踩坑

1. **日志写在容器临时目录被清掉**：务必用 `%p`（PID）、`%t`（启动时间）避免重启覆盖，并挂载到持久卷；GC 日志对性能影响极小，生产必须常开。
2. **DisableExplicitGC 导致直接内存 OOM**：NIO 依赖 `System.gc()` 回收 `DirectByteBuffer`，应使用 `-XX:+ExplicitGCInvokesConcurrent`。
3. **停顿时间对不上**：GC 日志显示 20ms，但接口 P99 毛刺 2s。看 `-Xlog:safepoint` 中的 TTSP，常见原因是计数循环、大数组拷贝（`System.arraycopy` 在 JDK 8 中不可中断）、或者进程被 swap。
4. **Survivor 过小导致提前晋升**：G1 下表现为 Old regions 每次 Young GC 都涨，但 Mixed GC 又能大量回收——说明晋升的是「中年对象」。增大年轻代（G1 调大 `G1NewSizePercent` 或放宽停顿目标）比调 `MaxTenuringThreshold` 更有效。
5. **用 `jmap -histo:live` 看对象分布**：会触发一次 Full GC，在大堆服务上可能停顿数秒；高峰期改用不带 `live` 的版本或 JFR 的对象统计。

## 面试追问

> [!QUESTION] 并发标记为什么会漏标？增量更新和 SATB 各有什么代价？
> 用户线程在标记期间插入黑→白引用、同时删除灰→白的所有路径，白对象就会被漏标。增量更新记录新插入引用，重新标记阶段需要重扫这些黑对象，STW 时间与修改量相关；SATB 记录被删除的旧引用，重新标记只需处理少量 SATB 队列，停顿更短，代价是把快照时刻存活的对象都当作存活，浮动垃圾更多。

> [!QUESTION] 卡表和记忆集是什么关系？为什么需要写屏障？
> 记忆集是「记录从非收集区域指向收集区域指针」的抽象，卡表是它以卡页（512B）为精度的具体实现。引用关系只在字段赋值时变化，所以必须在每次引用写入时由写屏障更新卡表，否则 GC 时无从得知哪些老年代区域含有跨代指针。

> [!QUESTION] 什么是安全点？为什么 GC 日志显示停顿很短，应用却卡了很久？
> 安全点是线程可以安全暂停、且 OopMap 有效的位置。GC 必须等所有线程到达安全点才能开始，等待时间（TTSP）不计入 GC 本身的停顿。计数循环被 JIT 省略轮询、大数组拷贝等会让个别线程迟迟到不了安全点，所有已停下的线程都陪着等。用 `-Xlog:safepoint` 定位。

> [!QUESTION] 对象一定要达到 15 岁才能晋升老年代吗？
> 不是。还有动态年龄判定（从年龄 1 累加到 n，总大小超过 Survivor 的 `TargetSurvivorRatio`（默认 50%）时阈值降为 n）、Survivor 空间不足时直接溢出晋升、大对象直接分配到老年代。15 只是上限，因为 Mark Word 里年龄只有 4 位。

> [!QUESTION] 哪些情况会触发 Full GC？如何从日志判断原因？
> 老年代空间不足（晋升失败/大对象）、元空间达到阈值、`System.gc()`、`jmap -dump:live`、CMS 并发模式失败、G1 转移失败后回退。统一日志中 `Pause Full (原因)` 括号里就是 cause，结合 Full GC 前后的堆、元空间变化即可判断是泄漏、容量不足还是外部调用。
