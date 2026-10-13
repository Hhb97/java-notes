---
level: 深入
tags: [JVM, G1, ZGC, Shenandoah, 着色指针, 读屏障]
summary: 深入 G1 的 Region/RSet/停顿预测/Mixed GC 与转移失败，ZGC 的着色指针、读屏障自愈、并发重定位与分代 ZGC，并给出收集器选型决策
---

# G1 与 ZGC 深入

> [!ABSTRACT] 核心要点
> - G1 把堆切成等大 Region，分代只是 Region 的逻辑角色；每个 Region 有 **RSet** 记录「谁指向我」，所以可以只回收一部分老年代（Mixed GC），并按**停顿预测模型**挑选 CSet 来满足 `MaxGCPauseMillis`。
> - G1 并发周期 = 初始标记（搭 Young GC）→ 根区域扫描 → 并发标记（SATB）→ 重新标记 → 清理 → 若干次 Mixed GC；触发阈值由**自适应 IHOP** 决定。转移失败（Evacuation Failure）严重时会退化成 Full GC。
> - ZGC 的核心是**着色指针 + 读屏障**：标记、转移、重映射都与应用并发，读屏障发现「坏颜色」指针时走慢路径并 CAS 修正字段（**自愈**），停顿与堆大小无关，通常在 1ms 以内。
> - JDK 21 引入**分代 ZGC**（JEP 439），JDK 23 成为默认模式，JDK 24 移除非分代模式；它取消了多重映射并加入写屏障，显著降低分配停滞风险与 CPU 开销。
> - 选型：堆 < 4GB、追求吞吐用 Parallel；通用服务默认 G1；延迟敏感或大堆（数十 GB 以上）用分代 ZGC（JDK 21+）。

## G1 设计目标与 Region 布局

G1（Garbage-First，JDK 9 起默认）的目标是**在可控停顿时间内获得尽量高的吞吐**。它放弃了物理连续的分代，把堆切成约 2048 个大小相同的 Region：

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="G1 堆由等大的 Region 组成，每个 Region 可扮演 Eden、Survivor、Old、Humongous 或空闲角色">
<text class="ts" x="20" y="30">G1 堆 = 等大 Region 网格（1～32MB，2 的幂）；分代是逻辑概念，Region 的角色随回收而变化</text>
<rect class="b1" x="20" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="60" y="66" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="108" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="148" y="66" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b1" x="196" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="236" y="66" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b" x="284" y="46" width="80" height="40" rx="4"/>
<text class="ts" x="324" y="66" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b3" x="372" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="412" y="66" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b2" x="460" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="500" y="66" text-anchor="middle" dominant-baseline="middle">S</text>
<rect class="b1" x="548" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="588" y="66" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="636" y="46" width="80" height="40" rx="4"/>
<text class="tb" x="676" y="66" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b3" x="20" y="94" width="80" height="40" rx="4"/>
<text class="tb" x="60" y="114" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b" x="108" y="94" width="80" height="40" rx="4"/>
<text class="ts" x="148" y="114" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b4" x="196" y="94" width="256" height="40" rx="4"/>
<text class="tb" x="324" y="114" text-anchor="middle" dominant-baseline="middle">Humongous（H-Start + 2 个 H-Cont）</text>
<rect class="b1" x="460" y="94" width="80" height="40" rx="4"/>
<text class="tb" x="500" y="114" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="548" y="94" width="80" height="40" rx="4"/>
<text class="tb" x="588" y="114" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b" x="636" y="94" width="80" height="40" rx="4"/>
<text class="ts" x="676" y="114" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b1" x="20" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="60" y="162" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="108" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="148" y="162" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b" x="196" y="142" width="80" height="40" rx="4"/>
<text class="ts" x="236" y="162" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b1" x="284" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="324" y="162" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="372" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="412" y="162" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b3" x="460" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="500" y="162" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b1" x="548" y="142" width="80" height="40" rx="4"/>
<text class="tb" x="588" y="162" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b" x="636" y="142" width="80" height="40" rx="4"/>
<text class="ts" x="676" y="162" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b2" x="20" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="60" y="210" text-anchor="middle" dominant-baseline="middle">S</text>
<rect class="b3" x="108" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="148" y="210" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b1" x="196" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="236" y="210" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b" x="284" y="190" width="80" height="40" rx="4"/>
<text class="ts" x="324" y="210" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b3" x="372" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="412" y="210" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b1" x="460" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="500" y="210" text-anchor="middle" dominant-baseline="middle">E</text>
<rect class="b3" x="548" y="190" width="80" height="40" rx="4"/>
<text class="tb" x="588" y="210" text-anchor="middle" dominant-baseline="middle">O</text>
<rect class="b" x="636" y="190" width="80" height="40" rx="4"/>
<text class="ts" x="676" y="210" text-anchor="middle" dominant-baseline="middle">空闲</text>
<rect class="b1" x="20" y="250" width="18" height="14" rx="2"/>
<text class="ts" x="44" y="261">Eden</text>
<rect class="b2" x="100" y="250" width="18" height="14" rx="2"/>
<text class="ts" x="124" y="261">Survivor</text>
<rect class="b3" x="200" y="250" width="18" height="14" rx="2"/>
<text class="ts" x="224" y="261">Old</text>
<rect class="b" x="270" y="250" width="18" height="14" rx="2"/>
<text class="ts" x="294" y="261">Free</text>
<rect class="b4" x="350" y="250" width="18" height="14" rx="2"/>
<text class="ts" x="374" y="261">Humongous：≥ 半个 Region 的大对象，占连续 Region</text>
<text class="ts" x="20" y="288">每个 Region 有自己的 RSet；CSet = 本次回收的 Region 集合（Young GC 为全部年轻代，Mixed GC 再加部分老年代）</text>
</svg>
<figcaption>图 1：G1 的 Region 布局</figcaption>
</figure>

- **Region 大小**：`-XX:G1HeapRegionSize`，默认按「堆大小 / 2048」取 2 的幂，范围 1～32MB（JDK 18 起上限放宽到 512MB）。
- **Humongous**：大小 ≥ Region 一半的对象直接分配在一组连续的 Humongous Region 中，逻辑上属于老年代。它不参与复制，只能在并发标记后或 Young GC 时「急切回收」（主要针对没有引用字段的基本类型数组）。频繁的大对象分配会导致碎片和提前的并发周期。
- **TAMS 与位图**：每个 Region 记录并发标记开始时的 top 指针（Top-At-Mark-Start），TAMS 之上的对象是标记期间新分配的，SATB 语义下一律视为存活；存活信息记录在独立的标记位图中，不写对象头。

## RSet 与 Card Table

G1 依然使用 512 字节卡页的全局卡表，但在其上为每个 Region 维护一个 **RSet（Remembered Set）**，记录「哪些其他 Region 的哪些卡页里有指向本 Region 的引用」（points-into）。回收某个 Region 时，只需扫描它 RSet 指向的卡，无需扫描全堆。

- **只记录必要的方向**：年轻代 Region 每次都会被整体回收，所以「年轻代 → 任意 Region」的引用不需要记录；需要记录的是 Old → Young 与 Old → Old（供 Mixed GC 使用）。JDK 11 起，G1 只为下一轮可能被回收的老年代 Region 在并发周期中**重建** RSet，平时不维护全部老年代的 RSet，大幅节省内存。
- **数据结构**：早期为稀疏表 / 细粒度位图 / 粗粒度位图三级结构，引用多时会退化为粗粒度（整 Region 扫描）；JDK 20 前后重写为多种 card set 容器，内存占用进一步下降。

写后屏障先做过滤，再异步更新 RSet：

```cpp
// G1 写后屏障（概念伪代码，JDK 17）：obj.field = new_val
void g1_post_write_barrier(oop* field, oop new_val) {
    if (region_of(field) == region_of(new_val)) return;   // 同 Region 引用不需要记录
    if (new_val == nullptr) return;
    CardValue* card = card_for(field);
    if (*card == g1_young_card) return;                   // 年轻代对象中的字段，不需要记录
    StoreLoad_fence();
    if (*card == dirty_card) return;                      // 已经脏了
    *card = dirty_card;
    thread_local_dirty_card_queue.enqueue(card);          // 交给 Refinement 线程异步更新 RSet
}
```

> [!NOTE] 为什么 G1 比 Parallel 更「吃 CPU」
> 每次引用写入都要执行 SATB 写前屏障（标记期间）与上面的写后屏障，Refinement 线程还要并发处理脏卡。这就是 G1 在纯吞吐场景通常比 Parallel 低几个百分点、以及 RSet 占用额外内存的原因。

## Young GC

触发：Eden Region 数达到当前目标（由停顿预测模型动态决定）。全程 STW、多线程并行，CSet = 全部年轻代 Region。JDK 17 日志中的阶段：

| 阶段 | 做什么 |
| --- | --- |
| Pre Evacuate Collection Set | 准备工作：退休 TLAB、选定 CSet、Humongous 急切回收候选 |
| Merge Heap Roots | 把 CSet 中各 Region 的 RSet 与 Refinement 尚未处理的脏卡合并进卡表 |
| Evacuate Collection Set | 扫描根（线程栈、类、JNI 等）+ 扫描脏卡（Scan Heap Roots）+ 复制存活对象（Object Copy）+ 线程间工作窃取（Termination） |
| Post Evacuate Collection Set | 引用处理、重新弄脏卡、释放 CSet Region、Humongous 回收 |
| Other | 其他杂项，含选择下一次 CSet |

存活对象被复制到 Survivor Region，年龄达到阈值的复制到 Old Region。最后 G1 根据本次各阶段的实际耗时更新预测模型，调整下一轮 Eden 大小。

## 并发标记周期

当老年代占用（含 Humongous）超过 IHOP 阈值后，G1 在下一次 Young GC 时顺带开始并发周期：

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="G1 并发标记周期的各阶段及其是否 STW">
<rect class="b4" x="20" y="40" width="156" height="60" rx="8"/>
<text class="tb" x="98" y="60" text-anchor="middle" dominant-baseline="middle">初始标记</text>
<text class="ts" x="98" y="82" text-anchor="middle" dominant-baseline="middle">STW · 搭 Young GC</text>
<rect class="b2" x="208" y="40" width="156" height="60" rx="8"/>
<text class="tb" x="286" y="60" text-anchor="middle" dominant-baseline="middle">根区域扫描</text>
<text class="ts" x="286" y="82" text-anchor="middle" dominant-baseline="middle">并发 · 扫 Survivor</text>
<rect class="b2" x="396" y="40" width="156" height="60" rx="8"/>
<text class="tb" x="474" y="60" text-anchor="middle" dominant-baseline="middle">并发标记</text>
<text class="ts" x="474" y="82" text-anchor="middle" dominant-baseline="middle">并发 · SATB 标记</text>
<rect class="b4" x="584" y="40" width="156" height="60" rx="8"/>
<text class="tb" x="662" y="60" text-anchor="middle" dominant-baseline="middle">重新标记 Remark</text>
<text class="ts" x="662" y="82" text-anchor="middle" dominant-baseline="middle">STW · 清空 SATB 队列</text>
<line class="l" x1="176" y1="70" x2="206" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="364" y1="70" x2="394" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="552" y1="70" x2="582" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="662" y1="100" x2="662" y2="125"/>
<line class="l" x1="662" y1="125" x2="98" y2="125"/>
<line class="l" x1="98" y1="125" x2="98" y2="148" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="150" width="156" height="60" rx="8"/>
<text class="tb" x="98" y="170" text-anchor="middle" dominant-baseline="middle">重建 RSet</text>
<text class="ts" x="98" y="192" text-anchor="middle" dominant-baseline="middle">并发 · JDK 11+</text>
<rect class="b4" x="208" y="150" width="156" height="60" rx="8"/>
<text class="tb" x="286" y="170" text-anchor="middle" dominant-baseline="middle">清理 Cleanup</text>
<text class="ts" x="286" y="192" text-anchor="middle" dominant-baseline="middle">STW · 统计、选候选</text>
<rect class="b4" x="396" y="150" width="156" height="60" rx="8"/>
<text class="tb" x="474" y="170" text-anchor="middle" dominant-baseline="middle">Prepare Mixed</text>
<text class="ts" x="474" y="192" text-anchor="middle" dominant-baseline="middle">STW · 纯年轻代</text>
<rect class="b4" x="584" y="150" width="156" height="60" rx="8"/>
<text class="tb" x="662" y="170" text-anchor="middle" dominant-baseline="middle">Mixed GC × N</text>
<text class="ts" x="662" y="192" text-anchor="middle" dominant-baseline="middle">STW · 年轻代+部分老年代</text>
<line class="l" x1="176" y1="180" x2="206" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="364" y1="180" x2="394" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="552" y1="180" x2="582" y2="180" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="234" width="18" height="14" rx="2"/>
<text class="ts" x="44" y="245">STW 暂停</text>
<rect class="b2" x="120" y="234" width="18" height="14" rx="2"/>
<text class="ts" x="144" y="245">与应用线程并发</text>
<text class="ts" x="20" y="274">触发：老年代占用 > IHOP（初始 45%，自适应）；Mixed 目标 8 次（G1MixedGCCountTarget），可回收比例 &lt; 5%（G1HeapWastePercent）即停止</text>
</svg>
<figcaption>图 2：G1 并发标记周期与 Mixed GC</figcaption>
</figure>

| 阶段 | STW | 说明 | 日志关键字（JDK 17） |
| --- | --- | --- | --- |
| 初始标记 | 是 | 标记 GC Roots 直接可达的对象，借用一次 Young GC 完成，几乎无额外开销 | `Pause Young (Concurrent Start)` |
| 根区域扫描 | 否 | 扫描 Survivor Region 中对老年代的引用；**必须在下一次 Young GC 前完成**，否则 Young GC 要等待 | `Concurrent Scan Root Regions` |
| 并发标记 | 否 | 遍历对象图，处理 SATB 队列；`ConcGCThreads` 个线程 | `Concurrent Mark` |
| 重新标记 | 是 | 处理剩余 SATB 缓冲、引用处理（软/弱/虚引用）、类卸载 | `Pause Remark` |
| 重建 RSet | 否 | 为回收候选的老年代 Region 重建 RSet | `Concurrent Rebuild Remembered Sets` |
| 清理 | 是 | 计算各 Region 存活率，**直接回收全空 Region**，排序候选 | `Pause Cleanup` |
| 并发清理 | 否 | 清理下一轮要用的标记位图 | `Concurrent Cleanup for Next Mark` |

## Mixed GC

清理阶段之后，G1 有了一份按「回收收益 / 回收成本」排序的老年代候选 Region 列表（这正是 Garbage-First 名字的由来）。接下来先做一次 `Prepare Mixed` 的年轻代回收，然后进行若干次 Mixed GC：CSet = 全部年轻代 + 一部分候选老年代 Region。

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `G1MixedGCLiveThresholdPercent` | 85 | 存活率高于 85% 的 Region 不进入候选（复制代价大、收益低） |
| `G1MixedGCCountTarget` | 8 | 期望在 8 次 Mixed GC 内处理完候选，决定每次最少回收多少老年代 Region |
| `G1OldCSetRegionThresholdPercent` | 10 | 单次 Mixed GC 最多包含堆 10% 的老年代 Region |
| `G1HeapWastePercent` | 5 | 剩余候选可回收空间低于堆的 5% 时停止 Mixed，接受这些浪费 |

JDK 12 起（JEP 344）Mixed GC 可中止：CSet 分为必选和可选部分，预测超时就只回收必选部分，减少停顿超标。

## IHOP 自适应

`-XX:InitiatingHeapOccupancyPercent`（默认 45）是**初始**阈值。JDK 9 起 `-XX:+G1UseAdaptiveIHOP` 默认开启，G1 根据以往「并发标记耗时」与「这段时间内老年代的增长速率」预测：要在老年代被填满（预留 `G1ReservePercent`，默认 10%）之前完成标记，最晚应该何时开始。

- 标记开始太晚：Mixed GC 还没来得及回收，老年代就满了 → 转移失败 → Full GC。
- 标记开始太早：频繁并发周期，浪费 CPU。
- 自适应需要几次完整周期积累数据，启动初期仍按 45% 触发；如果应用晋升模式剧烈变化，可以关闭自适应、手动设置更低的 IHOP。

## 停顿预测模型

`-XX:MaxGCPauseMillis`（默认 200ms）是**软目标**。G1 对各项成本维护带衰减的样本序列（`TruncatedSeq`），用「衰减平均值 + 若干倍衰减标准差」作为保守预测：

```cpp
// JDK 17 g1Predictions.hpp（节选）
double predict(TruncatedSeq const* seq) const {
    // davg：衰减平均；sigma 默认 0.5（G1ConfidencePercent=50）
    return seq->davg() + _sigma * stddev_estimate(seq);
}
```

被预测的量包括：每张脏卡的合并/扫描成本、每字节复制成本、每个 Region 的固定开销、RSet 长度等。据此 G1 决定：

1. **下一轮年轻代大小**：在 `G1NewSizePercent`（5%）与 `G1MaxNewSizePercent`（60%）之间调整 Eden Region 数，使 Young GC 预测时间不超过目标。
2. **每次 Mixed GC 带多少老年代 Region**：在不超时的前提下尽量多带。

> [!WARNING] 不要给 G1 设置 -Xmn / NewRatio
> 固定年轻代大小会让 G1 无法通过调整 Eden 来满足停顿目标，相当于关闭了停顿预测的主要手段。停顿目标也不要设得过小（如 10ms），否则 Eden 被压得很小，Young GC 极其频繁，晋升变快，反而更容易触发 Full GC。

## Evacuation Failure 与 Full GC

复制存活对象时找不到空闲 Region（Survivor 和 Old 都放不下），就发生**转移失败**（JDK 8 日志为 `to-space exhausted`，JDK 17 为 `(Evacuation Failure)`）：

1. 复制失败的对象原地保留（自转发，指向自己），所在 Region 直接变为老年代；
2. 需要额外修复这些对象的引用和卡表，本次停顿明显变长；
3. 如果之后仍无法分配，G1 回退到 **Full GC**（`Pause Full (G1 Compaction Pause)`）。JDK 10 之前 G1 的 Full GC 是单线程标记-整理，几十 GB 的堆可能停顿数十秒；JDK 10（JEP 307）改为并行，但依然是全堆 STW。

常见诱因与对策：

| 诱因 | 现象 | 对策 |
| --- | --- | --- |
| 堆太小 / 存在泄漏 | 老年代 Mixed 后仍居高不下 | 先排查泄漏，再扩堆 |
| 并发标记开始太晚 | 标记还没完成就满了 | 降低 IHOP 或关闭自适应、增加 `ConcGCThreads` |
| 大量 Humongous 分配 | 日志中 `G1 Humongous Allocation` 频繁 | 调大 `G1HeapRegionSize`，或改代码避免巨型数组/大 `StringBuilder` |
| 晋升突增 | 流量洪峰时 Old regions 暴涨 | 增大 `G1ReservePercent` 预留空间 |

> [!NOTE] JNI Critical 与 Region 钉住
> JDK 22 之前，线程处于 JNI Critical Region（`GetPrimitiveArrayCritical`）时 G1 会**整体禁止 GC**（GCLocker），可能引发「GCLocker Initiated GC」与分配线程停滞。JDK 22（JEP 423）改为只钉住相关 Region，不再阻塞整个 GC。

## G1 关键参数

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `-XX:MaxGCPauseMillis` | 200 | 在线服务 100～200；不要追求极低值 |
| `-XX:G1HeapRegionSize` | 自动 | 大对象多时手动调大（如 16m/32m） |
| `-XX:InitiatingHeapOccupancyPercent` | 45 | 晋升突增型应用可降到 30～35 |
| `-XX:G1ReservePercent` | 10 | 转移失败时调到 15～20 |
| `-XX:ParallelGCThreads` | ≤ 8 核时等于核数，之上约为 8 + (N−8)×5/8 | 容器中确认识别正确 |
| `-XX:ConcGCThreads` | 约 ParallelGCThreads 的 1/4 | 标记跟不上时调大 |
| `-XX:G1PeriodicGCInterval` | 0（关闭） | JDK 12+（JEP 346），空闲时周期性并发回收并归还内存 |
| `-XX:+UseStringDeduplication` | 关闭 | 大量重复字符串时开启 |

## ZGC：着色指针

ZGC 的发展：JDK 11 实验（JEP 333）→ JDK 15 正式（JEP 377）→ JDK 16 并发线程栈扫描（JEP 376），停顿降至亚毫秒 → JDK 21 分代 ZGC（JEP 439，需 `-XX:+ZGenerational`）→ JDK 23 分代成为默认（JEP 474）→ JDK 24 移除非分代模式（JEP 490）。

ZGC 不在对象头里记录 GC 状态，而是把元数据「染」在**指针本身**的高位上：

<figure class="fig">
<svg viewBox="0 0 760 220" class="dg" role="img" aria-label="非分代 ZGC 的 64 位着色指针布局：高 18 位未使用，4 个颜色位，低 42 位为对象地址">
<text class="th" x="20" y="24">非分代 ZGC 着色指针（JDK 11 布局示意）</text>
<text class="ts" x="24" y="50">63</text>
<text class="ts" x="192" y="50" text-anchor="end">46</text>
<text class="ts" x="244" y="50" text-anchor="middle">45</text>
<text class="ts" x="340" y="50" text-anchor="middle">44</text>
<text class="ts" x="436" y="50" text-anchor="middle">43</text>
<text class="ts" x="532" y="50" text-anchor="middle">42</text>
<text class="ts" x="584" y="50">41</text>
<text class="ts" x="736" y="50" text-anchor="end">0</text>
<rect class="b" x="20" y="58" width="176" height="50" rx="4"/>
<text class="tb" x="108" y="83" text-anchor="middle" dominant-baseline="middle">未使用 18 位</text>
<rect class="b5" x="196" y="58" width="96" height="50" rx="4"/>
<text class="tm" x="244" y="83" text-anchor="middle" dominant-baseline="middle">Finalizable</text>
<rect class="b2" x="292" y="58" width="96" height="50" rx="4"/>
<text class="tm" x="340" y="83" text-anchor="middle" dominant-baseline="middle">Remapped</text>
<rect class="b3" x="388" y="58" width="96" height="50" rx="4"/>
<text class="tm" x="436" y="83" text-anchor="middle" dominant-baseline="middle">Marked1</text>
<rect class="b3" x="484" y="58" width="96" height="50" rx="4"/>
<text class="tm" x="532" y="83" text-anchor="middle" dominant-baseline="middle">Marked0</text>
<rect class="b1" x="580" y="58" width="160" height="50" rx="4"/>
<text class="tb" x="660" y="83" text-anchor="middle" dominant-baseline="middle">对象地址 42 位</text>
<text class="t" x="20" y="136">同一块物理内存被映射到 Marked0 / Marked1 / Remapped 三个虚拟地址视图（多重映射），带色指针可直接解引用。</text>
<text class="t" x="20" y="160">读屏障：加载堆中引用时检查颜色是否为当前 good color，否则走慢路径（标记 / 转移 / 重映射）。</text>
<text class="t" x="20" y="184">慢路径得到正确地址后 CAS 写回原字段，之后再读该字段走快路径，这就是「自愈」。</text>
<text class="ts" x="20" y="208">分代 ZGC（JDK 21+）改为把颜色位放在指针低位、取消多重映射，并新增写屏障维护记忆集。</text>
</svg>
<figcaption>图 3：ZGC 着色指针</figcaption>
</figure>

- **Marked0 / Marked1**：两轮 GC 交替使用，用来区分「本轮已标记」与「上一轮的标记」，无需清理标记位。
- **Remapped**：指针已指向对象的最新地址（不在转移集合中，或已更新过）。
- **Finalizable**：只能通过 finalizer 到达。
- 因为 64 位指针要用来存颜色，ZGC **不支持压缩指针**，引用固定 8 字节；也因此只支持 64 位平台。JDK 13 起可寻址堆上限为 16TB。

## 读屏障与自愈

```java
// 应用代码
Object o = obj.field;

// JIT 在加载后插入的读屏障（概念伪代码）
Object o = obj.field;
if ((o & bad_mask) != 0) {                 // 快路径：一条 test + 一个跳转
    o = zgc_load_barrier_slow(&obj.field, o);
}

Object zgc_load_barrier_slow(Object* addr, Object o) {
    Object good;
    if (in_relocation_set(o)) {
        good = relocate_or_forward(o);     // 对象还没搬就由应用线程帮忙搬，搬过了就查转发表
    } else {
        good = remap_and_mark(o);          // 标记阶段：标记对象并推入标记栈
    }
    CAS(addr, o, good);                    // 自愈：修正字段，下次读不再进慢路径
    return good;
}
```

要点：

- 屏障只作用于**从堆中加载引用**，栈上局部变量之间的赋值、基本类型读写都没有屏障。
- 自愈让慢路径只发生一次，屏障整体开销通常在个位数百分比。
- 转移由 GC 线程和应用线程**共同**完成：谁先访问到待转移对象，谁就把它搬走并写入转发表（forwarding table，位于堆外），保证只搬一次。

## 并发转移与重定位

非分代 ZGC 一次 GC 周期：

| 阶段 | STW | 说明 |
| --- | --- | --- |
| Pause Mark Start | 是 | 翻转 good color（Marked0↔Marked1），标记根；只与 GC Roots 数量有关 |
| Concurrent Mark / Remap | 否 | 遍历对象图；顺带把上一轮未修正的指针重映射（上一轮的 Remap 合并到本轮 Mark 中做） |
| Pause Mark End | 是 | 确认标记完成 |
| Concurrent Process Non-Strong References | 否 | 处理软/弱/虚引用、类卸载 |
| Concurrent Reset / Select Relocation Set | 否 | 按页存活率选出转移集合（ZGC 的 Region 叫 ZPage：小页 2MB、中页 32MB、大页 N×2MB） |
| Pause Relocate Start | 是 | 翻转 good color 为 Remapped，转移根直接引用的对象 |
| Concurrent Relocate | 否 | 把转移集合中的存活对象搬到新页，旧页释放；对象旧地址在转发表中保留到下一轮 Remap 完成 |

三次停顿都只处理根（JDK 16 后连线程栈也并发处理），所以停顿时间与堆大小、存活对象数量基本无关。

## 分代 ZGC（JDK 21，JEP 439）

非分代 ZGC 每次都要标记整个堆，对分配速率高的应用容易出现**分配停滞（Allocation Stall）**：GC 回收速度赶不上分配，应用线程被阻塞等待内存。分代 ZGC 引入年轻代/老年代：

- 年轻代频繁回收（Minor Collection），老年代低频回收（Major Collection，同时收两代）。
- **取消多重映射**：颜色位移到指针低位，读屏障通过移位去掉颜色，对 RSS 统计和大页更友好。
- **新增写屏障**：用于维护老→年轻的记忆集（基于位图，而非卡表），以及配合 SATB 式的老年代标记。
- 官方给出的效果是：在相同堆下 CPU 开销更低、分配停滞显著减少，所需堆空间也更小。

```bash
# JDK 21～22
-XX:+UseZGC -XX:+ZGenerational
# JDK 23+（分代已是默认）；JDK 24+ 不再有非分代模式
-XX:+UseZGC
```

| ZGC 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Xmx` | — | ZGC 最重要的参数：堆要给足余量，让并发回收跑得过分配 |
| `-XX:SoftMaxHeapSize` | = Xmx | 软上限，GC 尽量把堆控制在此值以内，应对突发时可以突破 |
| `-XX:ConcGCThreads` | 动态 | 并发 GC 线程数，分配停滞时可调大 |
| `-XX:ZAllocationSpikeTolerance` | 2 | 对分配速率突增的容忍系数，调大会更早启动 GC |
| `-XX:ZUncommitDelay` | 300（秒） | 空闲内存归还 OS 的延迟 |
| `-XX:+AlwaysPreTouch` | 关闭 | 启动时预先触碰内存，避免运行期缺页抖动 |

## Shenandoah 简述

Shenandoah 由 Red Hat 开发，JDK 12 实验引入、JDK 15 正式（JEP 379），目标与 ZGC 相同：停顿与堆大小无关。

- **并发整理**：初始标记（STW）→ 并发标记（SATB）→ 最终标记（STW）→ 并发清理 → **并发转移** → 初始更新引用（STW）→ 并发更新引用 → 最终更新引用（STW）→ 并发清理。
- **转发指针**：1.0 版本在每个对象前额外放一个 Brooks 转发指针字；JDK 13 改用 Load Reference Barrier（LRB）并去掉了这个额外字，内存开销和屏障开销都降低。
- 与 ZGC 的区别：不用着色指针，**支持压缩指针**，对中小堆更省内存；Oracle 官方构建不包含 Shenandoah，需使用 OpenJDK 社区或 Red Hat、Corretto 等发行版。JDK 24 引入实验性分代 Shenandoah（JEP 404）。

## 收集器选型决策

| 场景 | 推荐 | 理由 |
| --- | --- | --- |
| 批处理、离线计算、只关心吞吐 | Parallel | 没有并发屏障开销，吞吐最高 |
| 单核容器、堆 < 1GB 的小工具 | Serial | 开销最小 |
| 通用在线服务，堆 4～32GB，P99 停顿可接受 100～200ms | G1 | 默认收集器，成熟、可调，生态资料最多 |
| 延迟敏感（交易、网关、实时推荐），要求 P99 停顿 < 10ms | 分代 ZGC（JDK 21+） | 停顿与堆大小无关 |
| 超大堆（几十 GB～TB 级） | 分代 ZGC | G1 的 Full GC 或混合回收在大堆下代价难控 |
| 中小堆但要低延迟，且在意内存占用 | Shenandoah | 支持压缩指针 |
| 还在 JDK 8 | G1（8u40+）或 Parallel；CMS 不建议新用 | CMS 已被移除，迁移成本只会越来越高 |

> [!TIP] 迁移到 ZGC 前的检查清单
> - 并发收集器的代价是 CPU：并发 GC 线程会和业务线程争抢 CPU，在 CPU 已经很紧张的容器里 ZGC 可能表现更差。
> - 堆要预留余量：ZGC 依赖「回收速度 > 分配速度」，堆用到 90% 以上时会频繁分配停滞，日志中搜索 `Allocation Stall`。
> - 不支持压缩指针：引用密集型应用的堆占用会明显上升，同等 `Xmx` 下可用空间变少。
> - 用压测对比 P99/P999 与吞吐，而不是只看 GC 日志里的停顿。

## 生产实践与踩坑

1. **Humongous 引发的连锁反应**：一次查询返回 10 万行拼成一个大 JSON 字符串，`byte[]` 超过半个 Region，被直接分配为 Humongous；大量 Humongous 使老年代占用飙升触发并发周期，甚至因碎片找不到连续 Region 而 Full GC。对策：调大 Region、流式输出、分页查询。
2. **根区域扫描拖慢 Young GC**：Young GC 的阶段日志中 `Root Region Scan Waiting` 耗时明显，说明并发周期刚开始时 Survivor 太大或并发线程太少，可适当增加 `ConcGCThreads`。
3. **非分代 ZGC 的 RSS 「三倍」假象**：多重映射导致 `top` 中的 RSS 统计把同一物理页计算多次，容器监控误报内存翻倍。看 `PSS` 或 cgroup 的实际用量；分代 ZGC 已无此问题。
4. **ZGC 分配停滞**：日志中 `Allocation Stall (thread) 120ms`，接口出现超时。加大堆、调大 `ConcGCThreads`，或升级到分代 ZGC。
5. **G1 停顿目标设得太低**：设为 20ms 后 Young GC 每秒数十次，CPU 被 GC 吃掉，吞吐下降，晋升加快反而触发 Full GC。

## 相关阅读

- [线上调优与故障排查](#/java/jvm/tuning)：GC 日志分析与调优实战
- [虚拟内存、分页与内存管理](#/cs/os-memory)：大页、NUMA 与 swap 对 GC 停顿的影响
- [Kubernetes 核心概念](#/infra/k8s)：容器内存与 JVM 堆的配比

## 面试追问

> [!QUESTION] G1 如何做到「可预测停顿」？
> 一是 Region 化，让每次只回收一部分堆；二是 RSet，让回收某些 Region 时无需扫描全堆；三是停顿预测模型：基于衰减平均和标准差估算各类工作成本，动态调整年轻代大小与每次 Mixed GC 带入的老年代 Region 数。它是软目标，转移失败或 Full GC 时无法保证。

> [!QUESTION] G1 的 RSet 和卡表是什么关系？为什么 RSet 只记录「老年代指向我」？
> 卡表是全局的 512B 卡页脏标记，RSet 是每个 Region 维护的「哪些卡里有指向本 Region 的引用」的索引，二者通过写后屏障 + Refinement 线程联系。年轻代每次 GC 都会被整体收集，来自年轻代的引用在扫描年轻代时自然能发现，无需记录。

> [!QUESTION] ZGC 的读屏障为什么能做到并发转移？和 G1 的写屏障有何不同？
> 对象被并发搬走后，堆中旧指针仍指向旧地址。ZGC 在每次加载引用时检查颜色，若指向待转移/已转移对象就查转发表或帮忙搬运，并用 CAS 把字段修正为新地址。G1 的写屏障只维护 RSet 和 SATB，转移阶段必须 STW 一次性更新所有引用，所以 G1 的转移停顿与存活对象数量成正比。

> [!QUESTION] 分代 ZGC 相比非分代 ZGC 解决了什么问题？
> 非分代 ZGC 每轮都要标记全堆，分配速率高时回收跟不上，出现分配停滞，只能靠加大堆缓解。分代后大部分垃圾在年轻代被低成本回收，CPU 与内存开销更低；同时去掉多重映射，改为低位颜色 + 写屏障维护记忆集。

> [!QUESTION] 线上 G1 出现 Full GC，你会如何排查？
> 先看日志里 Full GC 前的事件：是 `Evacuation Failure`、`Humongous Allocation` 还是 `Metadata GC Threshold`、`System.gc()`。转移失败则看老年代在 Mixed GC 后能否下降：不能下降说明泄漏或堆太小，要 dump 分析；能下降说明并发周期开始太晚，降低 IHOP、加 `ConcGCThreads`、加 `G1ReservePercent`；大对象则调 Region 大小或改代码。
