---
level: 深入
tags: [JVM 调优, jstack, jmap, Arthas, JFR, 火焰图, OOM, Full GC, 排障]
summary: 一套可落地的线上 Java 故障排查手册：调优方法论、工具链、CPU/内存/GC/死锁/线程池打满等场景的定位路径，并附三个完整案例。
---

# 线上调优与故障排查

> [!ABSTRACT] 核心要点
> - **先定位后调参**：没有数据的调优都是猜测；大多数性能问题根因在代码、SQL 与下游依赖，而非 JVM 参数。
> - 排查三板斧：**看指标（CPU/内存/GC/线程/IO）→ 抓现场（线程栈、堆转储、火焰图）→ 复现与验证**。
> - 生产必备参数：`-XX:+HeapDumpOnOutOfMemoryError`、GC 日志（`-Xlog:gc*`）、容器下 `MaxRAMPercentage`、固定 `Xms=Xmx`。
> - 工具选择：轻量用 `jcmd/jstat/jstack`，在线深挖用 **Arthas**，CPU 热点用 **async-profiler 火焰图**，长期低开销采样用 **JFR**。
> - 故障先**止血**（扩容、限流、回滚、摘流量保留现场）再**根因**；排查前先保存现场（dump、线程栈），重启会让证据消失。

## 调优方法论

<figure class="fig">
<svg viewBox="0 0 740 190" class="dg" role="img" aria-label="性能调优闭环：监控、定位、假设、改动、验证">
<rect class="b1" x="20" y="60" width="116" height="60" rx="8"/>
<text class="tb" x="78" y="82" text-anchor="middle" dominant-baseline="middle">监控发现</text>
<text class="ts" x="78" y="102" text-anchor="middle">指标 / 告警</text>
<rect class="b3" x="170" y="60" width="116" height="60" rx="8"/>
<text class="tb" x="228" y="82" text-anchor="middle" dominant-baseline="middle">定位瓶颈</text>
<text class="ts" x="228" y="102" text-anchor="middle">CPU/内存/IO/锁</text>
<rect class="b3" x="320" y="60" width="116" height="60" rx="8"/>
<text class="tb" x="378" y="82" text-anchor="middle" dominant-baseline="middle">提出假设</text>
<text class="ts" x="378" y="102" text-anchor="middle">有证据支撑</text>
<rect class="b5" x="470" y="60" width="116" height="60" rx="8"/>
<text class="tb" x="528" y="82" text-anchor="middle" dominant-baseline="middle">单变量改动</text>
<text class="ts" x="528" y="102" text-anchor="middle">一次只改一处</text>
<rect class="b2" x="620" y="60" width="100" height="60" rx="8"/>
<text class="tb" x="670" y="82" text-anchor="middle" dominant-baseline="middle">压测验证</text>
<text class="ts" x="670" y="102" text-anchor="middle">对比前后</text>
<line class="l" x1="136" y1="90" x2="170" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="286" y1="90" x2="320" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="436" y1="90" x2="470" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="586" y1="90" x2="620" y2="90" marker-end="url(#arr)"/>
<line class="ld" x1="670" y1="120" x2="670" y2="156"/>
<line class="ld" x1="670" y1="156" x2="78" y2="156"/>
<line class="ld" x1="78" y1="156" x2="78" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="374" y="148" text-anchor="middle">未达标则回到定位；达标则固化配置并加监控</text>
</svg>
<figcaption>图 1：调优是实验闭环，不是参数堆砌</figcaption>
</figure>

核心指标：**吞吐量**（QPS/TPS）、**延迟**（P50/P99，关注长尾）、**资源占用**（CPU、内存、线程数）。GC 层面看：Young/Full GC 频率、单次停顿、总停顿占比（建议 < 5%）、晋升速率。

## 生产推荐参数

```bash
java \
  -XX:MaxRAMPercentage=70 \                 # 容器内按内存比例设堆；物理机用 -Xms/-Xmx 且设为相同
  -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \   # JDK 9+ 默认 G1；超低延迟可评估 ZGC
  -XX:MaxMetaspaceSize=512m \
  -Xss512k \                                 # 线程栈，默认 1MB；线程多时可调小
  -XX:+HeapDumpOnOutOfMemoryError \          # OOM 时自动 dump，必开
  -XX:HeapDumpPath=/data/dump/ \
  -XX:+ExitOnOutOfMemoryError \              # OOM 后退出交给编排系统重启，避免“僵尸”进程（JDK 8u92+）
  -Xlog:gc*,safepoint:file=/data/logs/gc.log:time,uptime,level,tags:filecount=5,filesize=50m \
  -XX:+DisableExplicitGC \                   # 屏蔽 System.gc()（使用 NIO 堆外内存时需谨慎）
  -XX:NativeMemoryTracking=summary \         # 排查堆外内存，约 5%~10% 开销，按需开启
  -jar app.jar
```

> [!NOTE] 参数的来源
> JDK 8 的 GC 日志使用 `-XX:+PrintGCDetails -Xloggc:` 系列参数；JDK 9+ 统一为 `-Xlog`。收集器选择与参数细节见 [G1 与 ZGC 深入](#/java/jvm/collectors)。

## 工具链

| 工具 | 用途 | 典型命令 |
| --- | --- | --- |
| `jps` | 找 Java 进程 | `jps -lvm` |
| `jstat` | 实时 GC 统计 | `jstat -gcutil <pid> 1000` |
| `jstack` / `jcmd Thread.print` | 线程快照、死锁 | `jstack -l <pid>` |
| `jmap` / `jcmd GC.heap_dump` | 堆直方图、堆转储 | `jmap -histo:live <pid> \| head -30` |
| `jcmd` | 万能入口 | `jcmd <pid> VM.flags`、`GC.heap_info`、`VM.native_memory` |
| **Arthas** | 在线诊断：不重启、不改代码 | `dashboard`、`thread -n 3`、`trace`、`watch`、`jad`、`profiler` |
| **async-profiler** | CPU / 内存分配 / 锁火焰图，低开销 | `./profiler.sh -d 30 -e cpu -f flame.html <pid>` |
| **JFR / JMC** | 低开销事件记录（<1%），可长期开启 | `jcmd <pid> JFR.start duration=120s filename=/tmp/a.jfr` |
| **MAT / VisualVM** | 分析 hprof 堆转储 | Dominator Tree、Leak Suspects、Path to GC Roots |
| `jhsdb` / `jinfo` | 查看/修改运行参数 | `jinfo -flag +PrintGC <pid>` |

> [!CAUTION] jmap 与 dump 的代价
> `jmap -dump` 和 `jmap -histo:live` 会触发 **Full GC / STW**，堆越大停顿越长，生产上先**摘掉流量**或在从节点执行。`-dump:live` 会先 Full GC；`jcmd GC.heap_dump` 同理。

## 场景一：CPU 飙高

<figure class="fig">
<svg viewBox="0 0 740 220" class="dg" role="img" aria-label="定位 CPU 飙高线程的步骤">
<rect class="b1" x="20" y="60" width="150" height="70" rx="8"/>
<text class="tb" x="95" y="82" text-anchor="middle" dominant-baseline="middle">1. 定位进程</text>
<text class="tm" x="95" y="106" text-anchor="middle">top → 找 pid</text>
<rect class="b1" x="200" y="60" width="150" height="70" rx="8"/>
<text class="tb" x="275" y="82" text-anchor="middle" dominant-baseline="middle">2. 定位线程</text>
<text class="tm" x="275" y="106" text-anchor="middle">top -Hp pid</text>
<rect class="b3" x="380" y="60" width="150" height="70" rx="8"/>
<text class="tb" x="455" y="82" text-anchor="middle" dominant-baseline="middle">3. 转十六进制</text>
<text class="tm" x="455" y="106" text-anchor="middle">printf %x tid</text>
<rect class="b2" x="560" y="60" width="160" height="70" rx="8"/>
<text class="tb" x="640" y="82" text-anchor="middle" dominant-baseline="middle">4. 查线程栈</text>
<text class="tm" x="640" y="106" text-anchor="middle">jstack | grep nid</text>
<line class="l" x1="170" y1="95" x2="200" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="95" x2="380" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="95" x2="560" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="370" y="176" text-anchor="middle">jstack 中线程的 nid=0x... 即十六进制线程 id；Arthas 一步到位：thread -n 3</text>
</svg>
<figcaption>图 2：CPU 飙高排查四步</figcaption>
</figure>

```bash
top -Hp 12345                       # 找占用 CPU 最高的线程 id，如 12399
printf '%x\n' 12399                 # 306f
jstack 12345 | grep -A 25 'nid=0x306f'
```

| 栈里看到的 | 通常原因 |
| --- | --- |
| 业务循环、`HashMap.get` 死循环 | 代码死循环；JDK 7 的 HashMap 并发扩容死链 |
| `GC task thread`、VM Thread 占满 | **频繁 GC**，转场景三 |
| 大量线程在 `Pattern.matches` / 正则 | 正则**灾难性回溯** |
| `C2 CompilerThread` 高 | JIT 编译风暴（启动初期正常） |
| 大量线程 `RUNNABLE` 在 `epollWait` 以外的 native | 序列化、加解密、压缩等 CPU 密集操作 |

找出热点方法后，用 async-profiler 火焰图确认**占比**，而不是只看单次栈快照（栈快照是瞬时的，可能不具代表性）。

## 场景二：内存泄漏与 OOM

| OOM 信息 | 含义与常见原因 |
| --- | --- |
| `Java heap space` | 堆满：泄漏（缓存/静态集合无上限、ThreadLocal）或一次性加载过多数据（大查询、大文件）|
| `GC overhead limit exceeded` | 98% 时间在 GC 但回收不足 2% 内存，本质也是堆不足 |
| `Metaspace` | 动态生成类过多（CGLIB/反射/Groovy）、类加载器泄漏 |
| `Direct buffer memory` | NIO 直接内存耗尽；Netty 未释放 ByteBuf（引用计数泄漏） |
| `unable to create native thread` | 线程数达到 OS 上限（`ulimit -u`、容器 pids 限制）或可用内存不足 |
| `Requested array size exceeds VM limit` | 申请超大数组 |

排查路径：

1. **GC 日志**：Full GC 之后老年代是否持续上升？（上升 = 泄漏；平稳 = 容量不足）
2. `jmap -histo:live <pid> | head -20`：哪类对象数量/大小异常；
3. 拿 `.hprof`：MAT 打开 → **Leak Suspects** → **Dominator Tree** 看谁持有最多内存 → 右键 **Path to GC Roots（excluding weak/soft refs）** 找到引用链；
4. 常见泄漏源：
   - 静态 `Map`/`List` 无限增长、没有淘汰策略的本地缓存；
   - `ThreadLocal` 在线程池中未 `remove()`；
   - 未关闭的连接、流、`Statement`；
   - 监听器 / 回调注册后未注销；
   - 自定义类加载器未释放；
   - 大对象被长生命周期对象间接持有（如把请求对象放进静态 Map）。

```bash
# 堆外内存：开启 NMT 后对比基线
jcmd <pid> VM.native_memory baseline
jcmd <pid> VM.native_memory summary.diff
```

## 场景三：频繁 Full GC

先看 GC 日志判断是哪一类：

| 现象 | 可能原因 | 对策 |
| --- | --- | --- |
| 老年代增长快、Full GC 后回收很少 | 内存泄漏或堆过小 | 场景二；评估扩堆 |
| 老年代增长快、能被回收 | **对象过早晋升**（Survivor 太小、大对象直接进老年代） | 调大新生代 / Survivor、避免大对象、检查 `MaxTenuringThreshold` |
| Metaspace 触发 Full GC | 元空间初始值过小反复扩容 | 设置 `MetaspaceSize` 与 `MaxMetaspaceSize` |
| 定时出现 | 代码或依赖库调用了 `System.gc()` | 查 `jstack`/日志；`-XX:+DisableExplicitGC` 或改用 `ExplicitGCInvokesConcurrent` |
| G1 出现 `to-space exhausted` / Full GC | 并发标记来不及、晋升失败 | 降低 `InitiatingHeapOccupancyPercent`（IHOP）、增大堆、减小分配速率 |
| 大对象分配 | G1 Humongous 对象（≥ Region 一半） | 增大 `G1HeapRegionSize`、避免超大数组 |

GC 参数不是越多越好：**先降低对象分配速率与存活量**（优化代码：避免循环里创建大对象、避免大批量查询一次性载入内存）通常比调参数更有效。

## 场景四：死锁、线程卡住、线程池打满

```text
$ jstack -l 12345
Found one Java-level deadlock:
=============================
"Thread-1":
  waiting to lock monitor 0x... (object 0x..., a java.lang.Object),
  which is held by "Thread-0"
"Thread-0":
  waiting to lock monitor 0x... (object 0x..., a java.lang.Object),
  which is held by "Thread-1"
```

- **死锁**：`jstack` 直接报告；预防见 [synchronized 与锁升级](#/java/concurrency/sync)（统一加锁顺序、`tryLock` 超时）。
- **大量线程 BLOCKED / WAITING 在同一位置**：锁竞争或下游慢（等待数据库连接、HTTP 响应）。多次取线程栈（间隔几秒，抓 3~5 次），看是否**始终卡在同一行**；
- **线程池打满**：业务线程全部阻塞在慢调用上，队列堆积 → 请求超时。看 `ThreadPoolExecutor` 的 `activeCount/queue.size`，对照 [线程池原理与调优](#/java/concurrency/pool)；对策：下游超时、舱壁隔离、限流、扩容；
- **连接池耗尽**（HikariCP `Connection is not available`）：多半是慢 SQL、事务过长或连接泄漏（未关闭），开启 `leakDetectionThreshold` 定位。

## 案例一：接口偶发超时，原因是 GC 停顿

**现象**：P99 延迟每隔十几分钟出现 2~3 秒尖刺，CPU、数据库正常。
**定位**：GC 日志显示每次尖刺对应一次 `Pause Full (G1 Evacuation Pause) 4.2s`，Full GC 之前堆使用率 90%+，老年代中 `byte[]` 占 60%。
**根因**：导出报表接口一次性把整表查出并拼接成大 `byte[]`（~200MB），分配的是 G1 Humongous 对象，占满 Region 后触发 Full GC。
**修复**：改为**分页流式写出**（`Stream` + 分批 flush）；同时限制导出并发。尖刺消失，Full GC 从 12 次/小时降为 0。

## 案例二：线程数持续上涨最终 OOM

**现象**：服务运行几天后报 `unable to create native thread`，`ls /proc/<pid>/task | wc -l` 超过 3 万。
**定位**：`jstack` 中大量名为 `pool-N-thread-1` 的线程，栈在 `LinkedBlockingQueue.take`——说明有**不停创建的线程池**，且线程没有被回收。
**根因**：某工具方法里每次调用都 `Executors.newFixedThreadPool(1)`，用完没有 `shutdown()`。
**修复**：改为全局共享的有界线程池，并在代码审查规则中禁止方法内创建线程池。

## 案例三：内存缓慢上涨，堆外泄漏

**现象**：堆使用稳定，但容器 RSS 持续上涨，最终 OOMKilled。
**定位**：开启 NMT，`summary.diff` 显示 `Internal`/`Other` 在增长；async-profiler `-e malloc` 看到调用来自 Netty `PooledByteBufAllocator`；加上 `-Dio.netty.leakDetection.level=PARANOID` 复现，日志出现 `LEAK: ByteBuf.release() was not called`。
**根因**：自定义 Handler 解码后没有 `release()` 引用计数对象。
**修复**：用 `ReferenceCountUtil.release` / `try-finally`，或继承 `SimpleChannelInboundHandler` 自动释放。

## 排查清单（贴在墙上）

- [ ] 变更：最近是否发版、改配置、流量突增、依赖升级？
- [ ] 抓现场：线程栈（间隔多次）、`jstat`/GC 日志、堆直方图、必要时 dump；
- [ ] 区分是**自身问题**还是**下游慢**（线程是否阻塞在 IO/锁上）；
- [ ] 先止血：扩容、限流、降级、回滚、摘除异常实例（保留现场）；
- [ ] 复盘：根因、检测手段为什么没提前发现、补监控与告警、写入故障库。

## 面试追问

> [!QUESTION] CPU 100% 怎么排查？
> `top -Hp` 找到最耗 CPU 的线程，转十六进制后在 `jstack` 中定位线程栈；若是 GC 线程，转内存排查；也可用 Arthas `thread -n 3` 或 async-profiler 火焰图确认热点。

> [!QUESTION] 线上 OOM 了怎么办？
> 先靠自动 dump（`HeapDumpOnOutOfMemoryError`）保留现场并重启止血；再用 MAT 看 Dominator Tree 和到 GC Roots 的引用链；结合 GC 日志判断是泄漏还是容量不足，同时关注堆外和元空间。

> [!QUESTION] 如何判断是内存泄漏还是内存不足？
> 看 Full GC 之后老年代使用量的趋势：每次回收后基线持续抬升是泄漏；回收后基线平稳但接近上限是容量不足或对象过早晋升。

> [!QUESTION] jmap 能在生产上随便用吗？
> 不能。`-histo:live` 和 `-dump:live` 会触发 Full GC 与 STW，堆大时停顿很长，而且 dump 文件占用大量磁盘；应先摘流量或在备用实例上执行，或使用启动参数自动 dump。

> [!QUESTION] 为什么说调优先看代码而不是 JVM 参数？
> 对象分配速率、存活对象规模、锁竞争、下游调用方式都是代码层面决定的；JVM 参数只能在既有行为上做微调。优化代码（减少分配、避免大对象、缩短临界区）往往收益大于调参。
