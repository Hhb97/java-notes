---
level: 进阶
tags: [操作系统, 虚拟内存, 分页, TLB, 缺页, 页面置换, swap, OOM, mmap, 大页, NUMA]
summary: 虚拟内存与内存管理：为什么需要虚拟地址、分页与多级页表、TLB、缺页中断与页面置换（LRU/Clock）、进程地址空间布局、malloc 与堆外内存、Linux 的内存回收/swap/OOM Killer、mmap、透明大页与 NUMA，并对应 JVM 堆/堆外/容器内存限制与线上排查。
---

# 虚拟内存、分页与内存管理

> [!ABSTRACT] 核心要点
> - **虚拟内存**让每个进程拥有独立、连续的地址空间：**隔离**（互不可见）、**简化**（统一布局）、**超额使用**（物理内存不够可换出）、**共享**（共享库/mmap/COW）。
> - **分页**把虚拟地址空间与物理内存切成固定大小的页（通常 4KB），由 **页表**映射；**多级页表**节省空间，**TLB** 缓存映射加速翻译；**缺页中断**时按需把页调入。
> - Java 进程的内存 ≠ 堆：**RSS = 堆 + 元空间 + 线程栈 + 直接内存 + 代码缓存 + GC/JIT 本地结构 + 库的 native 内存**。容器 OOMKilled 往往是堆外内存或限制配置问题，而不是 `OutOfMemoryError`。
> - Linux 内存回收：**页缓存可回收**（所以 `free` 少不一定有问题，看 `available`），匿名页只能 **swap**；彻底不足触发 **OOM Killer** 按 `oom_score` 杀进程。
> - **swap 对低延迟服务通常是毒药**（GC 遍历到换出页会卡顿数秒）；`vm.swappiness`、关闭 swap（K8s 默认要求）是常见做法。

## 一、为什么需要虚拟内存

直接用物理地址的问题：进程之间可以互相破坏内存、地址不连续难以编程、物理内存有限不能运行更大的程序、程序必须加载到固定位置。

虚拟内存的方案：**CPU 发出的是虚拟地址，由 MMU（内存管理单元）借助页表翻译成物理地址**，操作系统控制映射。

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="虚拟地址翻译：虚拟地址分为页号和页内偏移，先查 TLB，命中则直接得到物理页框号；未命中则遍历多级页表；页表项有效位为 0 则触发缺页中断，由内核从磁盘调入页并更新页表，然后重试指令；得到物理页框号加偏移访问物理内存">
<rect class="b1" x="20" y="30" width="170" height="60" rx="10"/>
<text class="tb" x="105" y="54" text-anchor="middle" dominant-baseline="middle">CPU 发出虚拟地址</text>
<text class="ts" x="105" y="76" text-anchor="middle">[ 页号 | 页内偏移 ]</text>
<rect class="b5" x="250" y="30" width="130" height="60" rx="10"/>
<text class="tb" x="315" y="54" text-anchor="middle" dominant-baseline="middle">TLB</text>
<text class="ts" x="315" y="76" text-anchor="middle">页表缓存</text>
<line class="l" x1="190" y1="60" x2="250" y2="60" marker-end="url(#arr)"/>
<rect class="b2" x="640" y="30" width="140" height="60" rx="10"/>
<text class="tb" x="710" y="54" text-anchor="middle" dominant-baseline="middle">物理内存</text>
<text class="ts" x="710" y="76" text-anchor="middle">页框号 + 偏移</text>
<line class="l" x1="380" y1="52" x2="640" y2="52" marker-end="url(#arr)"/>
<text class="ta" x="510" y="44" text-anchor="middle">TLB 命中（约 1ns）</text>
<rect class="b3" x="250" y="140" width="170" height="60" rx="10"/>
<text class="tb" x="335" y="164" text-anchor="middle" dominant-baseline="middle">多级页表遍历</text>
<text class="ts" x="335" y="186" text-anchor="middle">4 级 × 一次内存访问</text>
<line class="l" x1="315" y1="90" x2="315" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="325" y="120" text-anchor="start">未命中</text>
<line class="l" x1="420" y1="170" x2="640" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="560" y="140" text-anchor="start">有效 → 填 TLB</text>
<rect class="b4" x="250" y="240" width="170" height="60" rx="10"/>
<text class="tb" x="335" y="264" text-anchor="middle" dominant-baseline="middle">缺页中断（内核）</text>
<text class="ts" x="335" y="286" text-anchor="middle">页不在内存 / 无权限</text>
<line class="l" x1="335" y1="200" x2="335" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="345" y="226" text-anchor="start">有效位=0</text>
<rect class="bg" x="460" y="220" width="320" height="100" rx="10"/>
<text class="ts" x="474" y="242">• 合法但未加载：分配物理页，读磁盘/清零，更新页表后重试</text>
<text class="ts" x="474" y="262">• 写时复制：复制页并改为可写</text>
<text class="ts" x="474" y="282">• 非法访问：发 SIGSEGV（段错误），进程崩溃</text>
<text class="ts" x="474" y="302">• 内存不足：先回收/换出别的页</text>
</svg>
<figcaption>图 1：虚拟地址到物理地址的翻译与缺页处理</figcaption>
</figure>

## 二、分页、页表与 TLB

| 概念 | 说明 |
| --- | --- |
| **页（Page）/ 页框（Frame）** | 虚拟空间/物理内存的固定大小块，通常 **4KB**；也可用 2MB/1GB **大页（Huge Page）** |
| **页表** | 虚拟页号 → 物理页框号的映射，每页还有 **有效位、读/写/执行权限、脏位、访问位** |
| **多级页表** | 64 位系统用 4 级（或 5 级）页表：只为实际使用的地址范围建立下级页表，避免一张巨大扁平页表（48 位地址 4KB 页需要 2^36 项） |
| **TLB（快表）** | CPU 内的小缓存，缓存最近的页号→页框映射；命中约 1 ns，未命中要多次访存（4 级页表 = 4 次） |
| **内部碎片** | 页内未用空间（页越大越多）；**外部碎片**在分页下基本不存在，但物理连续大块分配可能失败 |

**为什么大页有益**：同样的内存范围需要的页表项和 TLB 条目少 512 倍（2MB/4KB），**TLB 命中率更高**，对大堆 JVM、数据库、内存数据库有明显收益（`-XX:+UseLargePages`）。**透明大页（THP）**由内核自动合并，但可能带来**延迟抖动和内存膨胀**（Redis、MongoDB、很多数据库官方建议**关闭 THP**，见 [Redis 持久化](#/redis/persistence)）。

## 三、缺页中断与页面置换

### 1. 请求调页

进程启动时只建立映射，**页真正被访问时才调入物理内存**（懒加载）。

| 类型 | 说明 | 代价 |
| --- | --- | --- |
| **次要缺页（minor）** | 页在内存（如页缓存、共享库已加载）只需建立映射；或首次访问匿名页分配并清零 | 约 1 µs 以下，较便宜 |
| **主要缺页（major）** | 需要**读磁盘**（或从 swap 换入） | **毫秒级**，是性能杀手 |
| 保护缺页 | 违反权限：COW 写入时复制（合法）；非法访问 → SIGSEGV | — |

`ps -o min_flt,maj_flt -p <pid>`、`pidstat -r`、`sar -B` 观测缺页；**`maj_flt` 持续增长**说明在频繁读盘/换入。

### 2. 页面置换算法

物理内存满时选择哪个页换出：

| 算法 | 思想 | 评价 |
| --- | --- | --- |
| OPT（最佳） | 淘汰未来最久不用的 | 理论最优，不可实现，用作对比基准 |
| FIFO | 淘汰最早进入的 | 简单，可能出现 **Belady 异常**（内存增大反而缺页更多） |
| **LRU** | 淘汰**最久未使用**的 | 效果好，精确实现开销大 |
| **Clock（二次机会）** | 环形链表 + 访问位，近似 LRU | 实际常用（Linux 的 active/inactive 双链表是其演进） |
| LFU | 淘汰使用次数最少的 | 适合频率稳定的场景 |

**与缓存淘汰同源**：Redis 的近似 LRU/LFU（见 [Redis 过期与淘汰](#/redis/expire)）、MySQL Buffer Pool 的 young/old 分区（防止全表扫描污染缓存，见 [InnoDB](#/mysql/storage)）、Caffeine 的 W-TinyLFU，都是页面置换思想的应用。LRU 的手写实现见 [复杂度与核心数据结构](#/cs/algo-ds)。

### 3. 抖动（Thrashing）

工作集（活跃使用的页）大于物理内存时，系统把大量时间花在换入换出，CPU 利用率反而下降。表现：`si/so` 持续非零、`wa` 高、响应时间爆炸。对策：减少并发/内存占用、加内存、限制容器内存、关闭 swap 让问题快速暴露（宁可 OOM 重启也不要拖死）。

## 四、进程地址空间布局（Linux 64 位）

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="进程虚拟地址空间从低地址到高地址：代码段、数据段 BSS、堆向高地址增长、内存映射区包含共享库和 mmap、栈向低地址增长，最高处是内核空间；Java 进程的堆元空间直接内存线程栈都位于这些区域">
<text class="th" x="20" y="24">高地址</text>
<rect class="b" x="20" y="34" width="300" height="40" rx="6"/>
<text class="ts" x="170" y="54" text-anchor="middle" dominant-baseline="middle">内核空间（用户态不可访问）</text>
<rect class="b4" x="20" y="78" width="300" height="50" rx="6"/>
<text class="ts" x="170" y="96" text-anchor="middle" dominant-baseline="middle">栈 Stack（向低地址增长）</text>
<text class="ts" x="170" y="114" text-anchor="middle" dominant-baseline="middle">局部变量、调用帧；主线程默认 8MB</text>
<rect class="b5" x="20" y="132" width="300" height="60" rx="6"/>
<text class="ts" x="170" y="152" text-anchor="middle" dominant-baseline="middle">内存映射区 mmap</text>
<text class="ts" x="170" y="172" text-anchor="middle" dominant-baseline="middle">共享库 .so · mmap 文件 · 线程栈 · 大块 malloc</text>
<rect class="b2" x="20" y="196" width="300" height="46" rx="6"/>
<text class="ts" x="170" y="212" text-anchor="middle" dominant-baseline="middle">堆 Heap（向高地址增长，brk）</text>
<text class="ts" x="170" y="230" text-anchor="middle" dominant-baseline="middle">malloc / new 的小块内存</text>
<rect class="b3" x="20" y="246" width="300" height="34" rx="6"/>
<text class="ts" x="170" y="263" text-anchor="middle" dominant-baseline="middle">数据段 .data / .bss（全局变量）</text>
<rect class="b1" x="20" y="284" width="300" height="34" rx="6"/>
<text class="ts" x="170" y="301" text-anchor="middle" dominant-baseline="middle">代码段 .text（只读）</text>
<text class="th" x="20" y="340">低地址</text>
<rect class="bg" x="370" y="34" width="400" height="284" rx="12"/>
<text class="th" x="386" y="60">一个 Java 进程在这些区域里放了什么</text>
<text class="ts" x="386" y="90">• Java 堆：JVM 启动时 mmap 预留一大块（-Xmx），按需提交</text>
<text class="ts" x="386" y="114">• 元空间 Metaspace：类元数据（native 内存）</text>
<text class="ts" x="386" y="138">• 线程栈：每个线程 -Xss（默认 1MB）× 线程数</text>
<text class="ts" x="386" y="162">• 直接内存：DirectByteBuffer / Netty（MaxDirectMemorySize）</text>
<text class="ts" x="386" y="186">• 代码缓存：JIT 编译产物（ReservedCodeCacheSize）</text>
<text class="ts" x="386" y="210">• GC 辅助结构：卡表、记忆集、标记位图（G1 可占堆的 10%+）</text>
<text class="ts" x="386" y="234">• glibc malloc 的 arena（多线程碎片）、JNI 库、zip 解压缓冲</text>
<text class="ts" x="386" y="262">→ 容器内存限制要为“堆 + 以上所有”留余量：</text>
<text class="ts" x="386" y="282">一般 -Xmx 设为容器内存的 50%~75%，或用</text>
<text class="ts" x="386" y="302">-XX:MaxRAMPercentage 并用 NMT 核算</text>
</svg>
<figcaption>图 2：进程地址空间与 Java 进程内存构成</figcaption>
</figure>

### 栈与堆的区别（操作系统层面）

| | 栈 | 堆 |
| --- | --- | --- |
| 管理 | 编译器/硬件自动（压栈出栈） | 程序员/运行时（malloc/free、GC） |
| 速度 | 极快（移动栈指针） | 较慢（需要分配算法） |
| 大小 | 受限（默认 1~8MB），递归太深 → **栈溢出** | 受可用内存限制 |
| 碎片 | 无 | 有（外部碎片） |

## 五、用户态内存分配与常见问题

- `malloc` 小块用 `brk` 扩展堆，**大块（默认 ≥128KB）用 `mmap`**；释放后 glibc 不一定立即还给 OS（碎片、arena 缓存），所以**进程 RSS 看起来只增不减**；
- **glibc 多线程 arena 问题**：每个线程倾向于独立 arena（默认 8×核数个），导致 Java 进程 RSS 远大于堆 + 已知 native；常见对策：`MALLOC_ARENA_MAX=2~4`，或换用 **jemalloc / tcmalloc**（Redis 默认 jemalloc 就是为了减少碎片，见 [Redis 数据结构编码](#/redis/types)）；
- **内存泄漏的类型**：Java 堆泄漏（引用不释放，看 heap dump）、**堆外泄漏**（`DirectByteBuffer` 未释放、Netty `ByteBuf` 忘记 release、JNI、线程泄漏导致栈累积）；
- **内存碎片**：长期运行后物理连续大页难分配，触发内存规整（compaction）带来停顿。

## 六、Linux 内存管理与 OOM

### 1. 看懂 `free`

```text
              total   used   free   shared  buff/cache   available
Mem:           31Gi   9.5Gi  1.2Gi   0.3Gi      20Gi        21Gi
```

- **`free` 很小不代表不够**：Linux 会把空闲内存拿来做**页缓存（page cache）**，需要时立刻回收（见 [文件系统、页缓存与零拷贝](#/cs/os-io)）；
- 看 **`available`**（估算不换出就能分配给应用的内存）；
- 匿名内存（堆、栈）只能 swap 换出，不能直接丢弃；文件页缓存干净页可直接丢，脏页要先写回。

### 2. 回收与 swap

- **水位线**：`low/high/min`，低于 low 唤醒 `kswapd` 异步回收，低于 min 则进程**直接回收（direct reclaim）**同步阻塞——这是**延迟抖动**的来源；
- **`vm.swappiness`**（0~100，默认 60）：倾向回收匿名页（swap）还是页缓存；服务器常调到 1~10；
- **swap 的代价**：换出的页被访问时是**主要缺页（读盘）**，JVM 的 GC 会扫描整个堆，若堆被换出会造成秒级停顿——**延迟敏感服务一般关闭 swap 或限制极小**；K8s 早期要求关闭 swap 以保证内存限制可预测；
- `vm.overcommit_memory`：允许超额分配虚拟内存（`malloc` 成功不代表物理内存够，访问时才缺页）；Redis 建议设为 1，避免 `fork` 失败。

### 3. OOM Killer 与容器 OOMKilled

| 场景 | 现象 | 判断 |
| --- | --- | --- |
| **JVM 堆满** | 抛 `java.lang.OutOfMemoryError: Java heap space`，进程仍在 | 应用日志、heap dump |
| **系统/cgroup 内存不足** | 进程被 **SIGKILL**，没有 Java 异常，K8s 显示 `OOMKilled`（exit code 137） | `dmesg -T \| grep -i "killed process"`、`kubectl describe pod` |
| **元空间/直接内存/栈** | 各自的 OutOfMemoryError 类型（Metaspace、Direct buffer memory、unable to create new native thread） | 异常信息 |

- OOM Killer 按 `oom_score`（占用内存越多分越高，`oom_score_adj` 可调）选择受害者；
- **容器 OOMKilled 排查**：RSS 超过 limit。用 `-XX:NativeMemoryTracking=summary` + `jcmd <pid> VM.native_memory summary` 核算 JVM 内部各区；对比 `-Xmx` 与 limit，是否线程过多、直接内存过大、glibc arena 碎片；
- `unable to create new native thread`：不是堆满，而是**线程数/进程数/虚拟内存**达上限（`ulimit -u`、`threads-max`、`pid_max`、容器 pids limit、内存不足建栈）。

## 七、mmap：内存映射文件

`mmap` 把文件（或匿名内存）映射进进程地址空间，之后像访问内存一样读写，缺页时才由内核从页缓存/磁盘调入：

- 好处：**避免 `read/write` 的用户态缓冲拷贝**（直接访问页缓存）、随机访问方便、多进程共享；
- 代价：缺页中断；**写入是脏页，落盘时机由内核决定**（需要 `msync`/`force` 保证持久）；大文件映射后异常（IO 错误）表现为信号而不是返回码；
- Java：`FileChannel.map` → `MappedByteBuffer`；Kafka 的索引文件、RocketMQ 的 CommitLog、Lucene 的索引读取、LMDB 都大量使用（见 [Kafka](#/mw/kafka)、[RocketMQ](#/mw/rocketmq)、[Elasticsearch](#/mw/es)）；
- 注意：`MappedByteBuffer` 的释放不及时（依赖 GC/Cleaner），大量映射文件可能造成地址空间/文件句柄压力。

## 八、NUMA 与大页

- **NUMA（非统一内存访问）**：多路服务器每个 CPU 插槽有**本地内存**，访问远端内存延迟更高。线程与内存跨节点会拖慢性能；`numactl --interleave=all` 或绑定、JVM `-XX:+UseNUMA`；数据库（MySQL）在 NUMA 上可能出现“一侧内存耗尽而整体未满就 swap”的问题，需交错分配（`innodb_numa_interleave`）；
- 大页：`vm.nr_hugepages` 预留静态大页，JVM `-XX:+UseLargePages`；THP 视场景开关（延迟敏感的数据库类通常**关闭**）。

## 九、常用排查命令

```bash
free -h                          # 总体，看 available
vmstat 1                         # si/so 换入换出，b 阻塞，wa
cat /proc/meminfo                # 细节：Cached、Dirty、AnonPages、Slab、HugePages
cat /proc/<pid>/status | egrep "VmRSS|VmSwap|Threads"
pmap -x <pid> | sort -k3 -n | tail      # 进程内存映射区域，找大头
smem -t -k -P java               # 按 PSS 统计（更准确地分摊共享内存）
sar -B 1                         # 缺页、换页速率
dmesg -T | grep -i "out of memory\|killed process"
jcmd <pid> VM.native_memory summary      # JVM 内部 native 内存（需 -XX:NativeMemoryTracking）
```

RSS vs VSZ：**VSZ（虚拟大小）远大于 RSS（常驻物理内存）是正常的**（预留但未使用）；看 **RSS/PSS** 才反映真实占用。

## 十、对应关系

| OS 概念 | 工程中的体现 |
| --- | --- |
| 虚拟内存 + 懒分配 | JVM `-Xms` 不等于立即占用物理内存；`-XX:+AlwaysPreTouch` 提前缺页换确定性 |
| 页缓存 | MySQL 双写缓冲/刷盘策略、Kafka 依赖页缓存做高吞吐（见 [Kafka](#/mw/kafka)） |
| 写时复制 | Redis RDB/AOF 重写 fork |
| swap/OOM | 容器 OOMKilled、`kill -9` 无日志；Redis `maxmemory` + 淘汰策略 |
| mmap | Kafka 索引、RocketMQ CommitLog、Lucene |
| 大页/NUMA | 数据库和大堆 JVM 调优 |
| 页面置换 | LRU/LFU 缓存、Buffer Pool |

## 面试追问

> [!QUESTION] 什么是虚拟内存？有什么好处？
> 每个进程拥有独立连续的虚拟地址空间，由 MMU 通过页表翻译为物理地址。好处是进程隔离、简化编程、可以运行大于物理内存的程序并按需调页，以及共享库、mmap 和写时复制等共享机制。

> [!QUESTION] 页表为什么要多级？TLB 的作用是什么？
> 单级页表要为整个地址空间建表，占用巨大；多级页表只为实际使用的区域建立下级表，节省内存。TLB 缓存最近的地址翻译结果，命中时避免多次访存遍历页表，是虚拟内存性能的关键，大页能减少所需条目提高命中率。

> [!QUESTION] 缺页中断的处理过程？主要缺页和次要缺页的区别？
> 访问的页不在物理内存或无权限时触发，内核判断是否合法，合法则分配物理页并从磁盘或页缓存调入，更新页表后重试指令，非法则发段错误。次要缺页无需读磁盘代价小，主要缺页需要读磁盘或 swap 换入，毫秒级，是性能杀手。

> [!QUESTION] Java 容器被 OOMKilled，但堆没满，可能是什么原因？
> 进程总内存 RSS 超过了容器限制，包括元空间、线程栈、直接内存、代码缓存、GC 结构和 glibc arena 碎片等。应该用 NMT 核算各区，调小 Xmx 为容器内存的一部分，限制直接内存和线程数，必要时设置 MALLOC_ARENA_MAX 或换 jemalloc。

> [!QUESTION] free 命令显示空闲内存很少，是内存不足吗？
> 不一定。Linux 会用空闲内存做页缓存，需要时可立即回收，应看 available。只有 available 很低、si/so 持续非零、频繁直接回收或 OOM 日志时才是真正不足。

> [!QUESTION] 为什么延迟敏感的服务通常关闭 swap？
> 被换出的页再被访问会触发读盘的主要缺页，JVM 的 GC 会遍历整个堆，若堆被换出会造成秒级停顿，且让内存问题表现为慢而不是明确失败。关闭 swap 让内存不足快速暴露为 OOM 并由编排系统重启。

> [!QUESTION] mmap 和普通 read/write 有什么区别？
> mmap 把文件映射到进程地址空间，直接访问页缓存，省去用户缓冲区的拷贝，缺页时才加载，适合随机访问和多进程共享；但有缺页开销、脏页落盘时机不确定需要 force，释放依赖 Cleaner。Kafka、RocketMQ、Lucene 都大量使用。
