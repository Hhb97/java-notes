# 垃圾回收

## 如何判断对象已死

- **引用计数**：循环引用无法回收，Java **不采用**。
- **可达性分析**：从 **GC Roots** 出发沿引用链搜索，不可达即可回收。

GC Roots 包括：虚拟机栈中的局部变量、静态变量、常量、本地方法栈中引用的对象、活跃线程、同步锁持有的对象。

> 对象被判定不可达后，至少要经过两次标记才会真正回收；`finalize()` 已被废弃，不要依赖它。

## 回收算法

| 算法 | 思路 | 优缺点 |
| --- | --- | --- |
| 标记-清除 | 标记后直接清除 | 产生内存碎片 |
| 标记-复制 | 存活对象复制到另一半 | 无碎片、效率高，浪费空间（适合新生代） |
| 标记-整理 | 存活对象向一端移动 | 无碎片，移动成本高（适合老年代） |

## 分代收集

```text
新生代 (1/3)：Eden : S0 : S1 = 8 : 1 : 1       →  Minor GC（频繁、快）
老年代 (2/3)：长期存活 / 大对象                  →  Major / Full GC（慢）
```

对象晋升流程：

1. 新对象在 **Eden** 分配；
2. Eden 满触发 Minor GC，存活对象复制到 Survivor，年龄 +1；
3. 年龄达到阈值（默认 15）→ 晋升老年代；
4. 大对象（`-XX:PretenureSizeThreshold`）、Survivor 放不下、动态年龄判定也会直接进入老年代。

## 垃圾收集器

| 收集器 | 特点 | 适用 |
| --- | --- | --- |
| Serial / Serial Old | 单线程，STW | 小内存、客户端 |
| Parallel Scavenge / Old | 多线程，**吞吐量优先**（JDK 8 默认） | 后台批处理 |
| CMS | 并发标记清除，低停顿，有碎片；JDK 14 移除 | 老系统 |
| **G1** | 堆划分为多个 Region，按收益优先回收，可设停顿目标（**JDK 9+ 默认**） | 大多数服务端应用 |
| **ZGC** | 着色指针 + 读屏障，停顿 < 1ms（JDK 15 GA，21 分代 ZGC） | 大堆、超低延迟 |
| Shenandoah | 类似 ZGC，并发整理 | 低延迟 |

### G1 要点

- `-XX:MaxGCPauseMillis=200`：期望停顿目标（默认 200ms）；
- 回收阶段：Young GC → 并发标记 → Mixed GC（同时回收新生代与部分老年代 Region）；
- 极端情况退化为单线程 Full GC，应尽量避免。

## STW 与常见 GC 日志

**Stop-The-World**：GC 时暂停所有应用线程。停顿越短，响应越稳定。

```bash
# JDK 9+ 统一日志
-Xlog:gc*:file=gc.log:time,uptime,level,tags

# 示例输出
[2.345s][info][gc] GC(12) Pause Young (Normal) (G1 Evacuation Pause) 512M->48M(1024M) 8.123ms
```

读法：回收前堆 → 回收后堆（堆总容量）与停顿时间。

## 什么时候会 Full GC

- 老年代空间不足（晋升失败 / Concurrent Mode Failure）；
- 元空间不足；
- 显式调用 `System.gc()`（可用 `-XX:+DisableExplicitGC` 关闭）；
- 大量大对象分配。

排查思路见 [调优与问题排查](#/jvm/tuning)。
