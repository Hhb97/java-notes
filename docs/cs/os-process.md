---
level: 进阶
tags: [操作系统, 进程, 线程, 调度, 上下文切换, 协程, 死锁, 同步, futex, 信号]
summary: 后端工程师需要的操作系统进程与线程知识：进程/线程/协程的区别与开销、进程状态与 PCB、CPU 调度算法与 Linux CFS、上下文切换的代价与观测、用户态内核态与系统调用、进程间通信、同步原语（互斥锁/信号量/futex）与死锁，并与 Java 线程、线程池大小、容器 CPU 限制对应起来。
---

# 进程、线程与 CPU 调度

> [!ABSTRACT] 核心要点
> - **进程**是资源分配的单位（独立地址空间、文件描述符表），**线程**是 CPU 调度的单位（共享进程的地址空间，各有栈与寄存器）。Linux 里线程就是共享资源的“轻量进程”（`clone` 带不同共享标志）。
> - **Java 平台线程 = 一对一映射到内核线程**；创建/切换/调度都由内核完成，有成本，所以有线程池，也才有 [虚拟线程](#/java/concurrency/thread)。
> - **上下文切换**要保存/恢复寄存器与调度状态，直接开销微秒级，**真正的代价是缓存与 TLB 失效**；线程数不是越多越好，CPU 密集看核数，IO 密集看等待比例。
> - Linux 调度器（CFS/EEVDF）追求**公平**：按**虚拟运行时间**挑选最小者；容器的 CPU limit 是靠 **CFS 带宽控制（quota/period）限流**，这是延迟毛刺的常见隐形原因。
> - 死锁四条件：**互斥、持有并等待、不可抢占、循环等待**，破坏任一即可预防；工程里最常用“**统一加锁顺序 + 超时**”。
> - 用户态/内核态切换（系统调用）本身有开销，是 **epoll、零拷贝、批量写、io_uring** 等优化的出发点（见 [文件系统、页缓存与零拷贝](#/cs/os-io)）。

## 一、进程、线程、协程

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="进程与线程的资源关系：每个进程拥有独立的虚拟地址空间，包含代码段、数据段、堆、文件描述符表；同一进程内多个线程共享这些资源，但各自拥有栈、寄存器和程序计数器；协程运行在线程之上，由用户态调度，切换不经过内核">
<rect class="b3" x="20" y="20" width="360" height="290" rx="14"/>
<text class="th" x="36" y="46">进程 A（独立地址空间）</text>
<rect class="b5" x="40" y="62" width="320" height="86" rx="8"/>
<text class="ts" x="56" y="84">共享：代码段 · 数据段 · 堆 · 文件描述符表 · 信号处理</text>
<text class="ts" x="56" y="106">一个线程崩溃（段错误）→ 整个进程退出</text>
<text class="ts" x="56" y="128">共享堆 → 线程间通信快，但需要同步</text>
<rect class="b2" x="40" y="164" width="96" height="70" rx="8"/>
<text class="ts" x="88" y="186" text-anchor="middle">线程 1</text>
<text class="ts" x="88" y="206" text-anchor="middle">私有：栈</text>
<text class="ts" x="88" y="222" text-anchor="middle">寄存器 / PC</text>
<rect class="b2" x="152" y="164" width="96" height="70" rx="8"/>
<text class="ts" x="200" y="186" text-anchor="middle">线程 2</text>
<text class="ts" x="200" y="206" text-anchor="middle">私有：栈</text>
<text class="ts" x="200" y="222" text-anchor="middle">寄存器 / PC</text>
<rect class="b2" x="264" y="164" width="96" height="70" rx="8"/>
<text class="ts" x="312" y="186" text-anchor="middle">线程 3</text>
<text class="ts" x="312" y="206" text-anchor="middle">私有：栈</text>
<text class="ts" x="312" y="222" text-anchor="middle">寄存器 / PC</text>
<text class="ts" x="200" y="262" text-anchor="middle">线程由内核调度；Java 平台线程一一对应</text>
<text class="ts" x="200" y="284" text-anchor="middle">默认栈约 1MB（-Xss），虚拟地址，按需提交物理页</text>
<rect class="b1" x="420" y="20" width="360" height="130" rx="14"/>
<text class="th" x="436" y="46">进程 B（另一个地址空间）</text>
<text class="ts" x="436" y="72">与进程 A 互相隔离，不能直接访问对方内存</text>
<text class="ts" x="436" y="94">通信必须借助 IPC：管道、共享内存、Socket…</text>
<text class="ts" x="436" y="116">一个进程崩溃不影响另一个（隔离性好）</text>
<rect class="b4" x="420" y="170" width="360" height="140" rx="14"/>
<text class="th" x="436" y="196">协程 / 虚拟线程（用户态调度）</text>
<text class="ts" x="436" y="220">多个协程复用少量内核线程</text>
<text class="ts" x="436" y="240">切换在用户态完成：几十~几百 ns，不进内核</text>
<text class="ts" x="436" y="260">栈很小、可海量（百万级）；遇到阻塞 IO 时让出线程</text>
<text class="ts" x="436" y="280">Go goroutine、Kotlin 协程、Java 21 虚拟线程</text>
</svg>
<figcaption>图 1：进程、线程、协程的资源边界</figcaption>
</figure>

| | 进程 | 线程 | 协程 |
| --- | --- | --- | --- |
| 地址空间 | 独立 | 共享所属进程 | 共享所属线程/进程 |
| 创建/切换开销 | 最大（页表、TLB 刷新） | 中（微秒级） | 最小（用户态函数调用级） |
| 通信 | IPC | 共享内存（需同步） | 共享内存 / channel |
| 隔离性 | 强 | 弱（一个崩溃全挂） | 弱 |
| 调度者 | 内核 | 内核 | 用户态运行时 |
| 并行 | 多核真并行 | 多核真并行 | 取决于承载线程数 |

**为什么 Nginx 用多进程、Redis 单线程、Tomcat 用线程池？** Nginx 追求隔离与稳定（worker 崩溃不影响 master）；Redis 的瓶颈在内存和网络，单线程避免锁开销（6.0 起网络 IO 多线程）；Tomcat 的业务代码阻塞多，需要线程并发，见 [Nginx](#/infra/nginx)、[Redis 线程模型](#/redis/overview)。

### Linux 里的实现

- 内核中进程与线程都是 `task_struct`；`fork` 创建独立地址空间（写时复制 COW），`pthread_create` 底层是 `clone(CLONE_VM | CLONE_FS | ...)` 共享地址空间；
- **写时复制（COW）**：`fork` 后父子共享物理页并标记只读，谁写才复制。Redis `BGSAVE` 的 RDB 持久化就依赖 COW——写入越多，复制页越多，内存占用越接近两倍（见 [Redis 持久化](#/redis/persistence)）；
- `ps -eLf`、`top -H` 查看线程；`/proc/<pid>/status` 的 `Threads`、`voluntary_ctxt_switches`、`nonvoluntary_ctxt_switches`。

## 二、进程状态与 PCB

<figure class="fig">
<svg viewBox="0 0 780 260" class="dg" role="img" aria-label="进程状态转换：新建到就绪，就绪被调度器选中进入运行，时间片用完回到就绪，等待 IO 或锁进入阻塞，事件完成回到就绪，运行结束到终止；Linux 中还有不可中断睡眠 D 状态和僵尸进程 Z 状态">
<rect class="b" x="20" y="100" width="90" height="46" rx="8"/>
<text class="tb" x="65" y="123" text-anchor="middle" dominant-baseline="middle">新建</text>
<rect class="b5" x="180" y="100" width="110" height="46" rx="8"/>
<text class="tb" x="235" y="123" text-anchor="middle" dominant-baseline="middle">就绪 Ready</text>
<rect class="b2" x="400" y="100" width="110" height="46" rx="8"/>
<text class="tb" x="455" y="123" text-anchor="middle" dominant-baseline="middle">运行 Running</text>
<rect class="b" x="660" y="100" width="90" height="46" rx="8"/>
<text class="tb" x="705" y="123" text-anchor="middle" dominant-baseline="middle">终止</text>
<rect class="b4" x="290" y="190" width="130" height="46" rx="8"/>
<text class="tb" x="355" y="213" text-anchor="middle" dominant-baseline="middle">阻塞 Blocked</text>
<line class="l" x1="110" y1="123" x2="180" y2="123" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="112" x2="400" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="345" y="104" text-anchor="middle">调度器选中</text>
<line class="l" x1="400" y1="136" x2="290" y2="136" marker-end="url(#arr)"/>
<text class="ts" x="345" y="156" text-anchor="middle">时间片用完/被抢占</text>
<line class="l" x1="470" y1="146" x2="400" y2="196" marker-end="url(#arr)"/>
<text class="ts" x="480" y="180" text-anchor="start">等待 IO / 锁 / 睡眠</text>
<line class="l" x1="320" y1="190" x2="250" y2="146" marker-end="url(#arr)"/>
<text class="ts" x="130" y="180" text-anchor="start">事件完成 → 就绪</text>
<line class="l" x1="510" y1="123" x2="660" y2="123" marker-end="url(#arr)"/>
<text class="ts" x="585" y="115" text-anchor="middle">退出</text>
<text class="ts" x="30" y="30" text-anchor="start">Linux 常见状态码：R 运行/就绪　S 可中断睡眠　D 不可中断睡眠（等磁盘 IO，kill 不掉）</text>
<text class="ts" x="30" y="50" text-anchor="start">Z 僵尸（已退出、父进程没 wait 回收）　T 暂停　大量 D 状态 = 磁盘/NFS 卡住；大量 Z = 父进程有 bug</text>
<text class="ts" x="30" y="250" text-anchor="start">平均负载 load average = 运行/就绪 + 不可中断睡眠(D) 的平均数量，所以磁盘卡死也会让 load 飙高而 CPU 空闲</text>
</svg>
<figcaption>图 2：进程状态转换与 Linux 状态码</figcaption>
</figure>

**PCB（进程控制块，Linux 的 `task_struct`）**保存：PID、状态、寄存器现场、调度信息（优先级、已用时间）、内存管理信息（页表指针）、打开文件表、信号、父子关系、cgroup/命名空间归属。上下文切换就是**保存当前任务的 PCB 现场、加载下一个任务的**。

排查经验：`load` 很高但 `CPU` 很闲 → 看 `vmstat 1` 的 `b` 列（阻塞数）、`iostat`，多半是磁盘/网络文件系统；见 [Linux 线上排查](#/infra/linux)。

## 三、CPU 调度

### 1. 目标与经典算法

| 目标 | 说明 |
| --- | --- |
| 吞吐量 | 单位时间完成的任务多 |
| 响应时间 | 交互任务尽快得到 CPU |
| 公平性 | 避免饥饿 |
| 周转/等待时间 | 任务总耗时更短 |

| 算法 | 思想 | 特点 |
| --- | --- | --- |
| FCFS 先来先服务 | 排队 | 简单，长任务拖累短任务（护航效应） |
| SJF/SRTF 短作业优先 | 先跑最短的 | 平均等待最优，但需预知时长、长任务饥饿 |
| **时间片轮转 RR** | 每个任务轮流一个时间片 | 响应好，时间片太小切换频繁、太大退化为 FCFS |
| **优先级调度** | 高优先级先运行 | 低优先级饥饿 → 老化（aging）提升 |
| **多级反馈队列 MLFQ** | 多个队列，用得多的降级，等得久的升级 | 兼顾交互与批处理，实际系统的基础 |
| 实时调度（FIFO/RR/EDF） | 满足截止时间 | 实时任务优先，`SCHED_FIFO/SCHED_RR` |

### 2. Linux 的 CFS（完全公平调度器）

- 每个任务有**虚拟运行时间 vruntime**（实际运行时间按权重折算：优先级高（nice 小）权重大，vruntime 增长慢）；
- 调度器总是选择 **vruntime 最小**的任务运行（用**红黑树**存放可运行任务，取最左节点，O(log n)）；
- 睡眠任务醒来时 vruntime 被调整到不至于“补偿过头”，既保证交互任务响应又不饿死别人；
- 新内核（6.6+）逐步由 **EEVDF** 取代 CFS，目标仍是公平与低延迟；
- 多核：每个 CPU 一个运行队列，**负载均衡**在核间迁移任务；**CPU 亲和性**（`taskset`）可固定线程到核，减少缓存失效（NUMA 下尤其重要）。

### 3. 容器里的 CPU 限制：CFS 带宽控制

K8s 的 `resources.limits.cpu: 2` 对应 cgroup 的 `cpu.cfs_quota_us / cpu.cfs_period_us`（如每 100ms 周期最多用 200ms CPU 时间）：

- 一个周期内**用完配额就被强制暂停（throttled）**，直到下一个周期——即便节点 CPU 空闲；
- 多线程应用 8 个线程并发跑，12.5ms 就可能耗光 100ms×2 的配额，之后停顿 87.5ms → **P99 延迟毛刺**；
- 观测：`container_cpu_cfs_throttled_periods_total` 占比（见 [指标监控](#/infra/obs-metrics)）；
- 对策：适当调大/去掉 limit（只保留 request）、减少线程数、使用 **JDK 10+ 的容器感知**（`-XX:ActiveProcessorCount`，让 JVM 的 `availableProcessors()`、GC 线程数、ForkJoin 并行度按容器核数）。见 [Kubernetes](#/infra/k8s)、[JVM 调优](#/java/jvm/tuning)。

## 四、上下文切换

### 1. 发生时机

- **进程/线程切换**：时间片用尽、被更高优先级抢占、主动阻塞（IO、锁、`sleep`）；
- **中断**：硬件中断（网卡、磁盘）处理；
- **模式切换（不等于任务切换）**：用户态 → 内核态的系统调用，只需切换特权级与栈，比任务切换便宜，但也有成本（尤其开启安全缓解措施后）。

| 类别 | 说明 | 观测 |
| --- | --- | --- |
| **自愿切换（voluntary）** | 因等待资源主动让出 CPU（IO、锁） | 高 → 任务在频繁阻塞（IO 密集/锁竞争） |
| **非自愿切换（nonvoluntary）** | 时间片耗尽被抢占 | 高 → CPU 争抢激烈、线程太多 |

### 2. 代价

- **直接开销**：保存/恢复寄存器、切换内核栈、调度器计算——约 **1~5 µs**；
- **间接开销（更大）**：**CPU 缓存（L1/L2）与 TLB 失效**，新任务要重新“热身”；进程切换还要切页表（刷新 TLB），**线程切换（同进程）免去地址空间切换**更便宜；
- 线程过多还会带来：栈内存占用、调度器负担、锁竞争放大。

### 3. 观测与线程数估算

```bash
vmstat 1                      # cs 列：每秒上下文切换总数；r 就绪队列长度；b 阻塞数
pidstat -w 1 -p <pid>         # cswch/s 自愿，nvcswch/s 非自愿
pidstat -wt 1 -p <pid>        # 按线程
perf stat -e context-switches,cpu-migrations -p <pid>
cat /proc/<pid>/status | grep ctxt
```

线程池大小经验（见 [线程池](#/java/concurrency/pool)）：

- **CPU 密集型**：`N_cpu + 1`（多一个防页缺失等偶发停顿）；
- **IO 密集型**：`N_cpu × (1 + 等待时间 / 计算时间)`，需**压测校准**；
- 要同时考虑**下游容量**（数据库连接池、第三方限流），线程数不能超过它们的承受；
- 上下文切换率持续很高（如每核数万/秒）且 CPU `sy` 占比高 → 线程过多或锁竞争，优化方向：减少线程数、无锁/细粒度锁、批处理、异步化。

## 五、用户态与内核态、系统调用

<figure class="fig">
<svg viewBox="0 0 780 250" class="dg" role="img" aria-label="用户态与内核态：应用程序调用库函数，库函数通过系统调用陷入内核，内核在特权级执行如读写文件、网络、创建线程等操作后返回用户态；系统调用有模式切换开销，频繁小调用应批量化">
<rect class="b1" x="20" y="30" width="740" height="80" rx="12"/>
<text class="th" x="36" y="54">用户态（受限，不能直接访问硬件和内核内存）</text>
<rect class="b" x="40" y="68" width="120" height="30" rx="6"/>
<text class="ts" x="100" y="83" text-anchor="middle" dominant-baseline="middle">应用 / JVM</text>
<rect class="b" x="200" y="68" width="150" height="30" rx="6"/>
<text class="ts" x="275" y="83" text-anchor="middle" dominant-baseline="middle">glibc 封装 read()</text>
<line class="l" x1="160" y1="83" x2="200" y2="83" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="83" x2="470" y2="130" marker-end="url(#arr)"/>
<text class="ta" x="420" y="108" text-anchor="start">syscall 指令（陷入）</text>
<rect class="b3" x="20" y="130" width="740" height="100" rx="12"/>
<text class="th" x="36" y="154">内核态（特权级，可访问全部资源）</text>
<rect class="b" x="40" y="168" width="130" height="30" rx="6"/>
<text class="ts" x="105" y="183" text-anchor="middle" dominant-baseline="middle">进程/线程调度</text>
<rect class="b" x="190" y="168" width="130" height="30" rx="6"/>
<text class="ts" x="255" y="183" text-anchor="middle" dominant-baseline="middle">虚拟内存管理</text>
<rect class="b" x="340" y="168" width="130" height="30" rx="6"/>
<text class="ts" x="405" y="183" text-anchor="middle" dominant-baseline="middle">文件系统 / 块层</text>
<rect class="b" x="490" y="168" width="130" height="30" rx="6"/>
<text class="ts" x="555" y="183" text-anchor="middle" dominant-baseline="middle">网络协议栈</text>
<rect class="b" x="640" y="168" width="100" height="30" rx="6"/>
<text class="ts" x="690" y="183" text-anchor="middle" dominant-baseline="middle">设备驱动</text>
<text class="ts" x="390" y="222" text-anchor="middle">一次系统调用约几十到几百 ns；高频小 IO 要批量化（缓冲、writev、io_uring 批量提交）</text>
</svg>
<figcaption>图 3：系统调用：用户态陷入内核态</figcaption>
</figure>

- 常见系统调用：`read/write/open/close`、`mmap`、`clone/fork/execve`、`epoll_wait`、`futex`、`sendfile`；
- `strace -f -c -p <pid>` 统计系统调用次数与耗时，`strace -T` 看单次耗时，定位“卡在哪个系统调用”（如 `futex` 等锁、`read` 等网络）；
- Java 的 `FileInputStream.read` 无缓冲时每次都是一次系统调用，所以要用缓冲流（见 [Java IO](#/java/api/io)）。

## 六、进程间通信（IPC）

| 方式 | 特点 | 场景 |
| --- | --- | --- |
| 管道 `pipe` / 命名管道 FIFO | 字节流，半双工；shell `\|` | 父子进程、命令组合 |
| **共享内存**（`mmap`/`shm`） | **最快**（无需内核拷贝），需自行同步 | 高性能场景（Java `MappedByteBuffer`、Chronicle Queue、Disruptor 思想） |
| 消息队列 | 内核维护，有类型和边界 | 系统内小消息 |
| **Socket** | 跨机器/本机（Unix Domain Socket 比 TCP 回环更快） | 微服务、数据库客户端；Docker、MySQL 本地连接常用 UDS |
| 信号 Signal | 异步通知（`SIGTERM`、`SIGKILL`、`SIGHUP`） | 优雅停机、重载配置 |
| 文件 / 内存映射文件 | 通过文件共享数据 | 简单场景、持久化 |

**优雅停机与信号**：K8s/Docker 先发 `SIGTERM`，宽限期（默认 30s）后发 `SIGKILL`（不可捕获）。Java 用 **shutdown hook**，Spring Boot 开启 `server.shutdown=graceful`；**容器里 PID 1 不转发信号**（shell 脚本启动 java 时信号到不了 JVM）→ 用 `exec java ...` 或 `tini`（见 [Docker](#/infra/docker)）。

## 七、同步原语与死锁

### 1. 同步原语

| 原语 | 说明 | 典型用途 |
| --- | --- | --- |
| **互斥锁 Mutex** | 同一时刻一个持有者，拿不到就**阻塞**（睡眠） | 保护临界区 |
| **自旋锁 Spinlock** | 拿不到**忙等**（不睡眠） | 临界区极短、不能睡眠的内核场景；单核无意义 |
| **读写锁** | 多读单写 | 读多写少 |
| **信号量 Semaphore** | 计数器，P/V 操作 | 限制并发数、生产者-消费者 |
| **条件变量** | 等待某条件成立（`wait/notify`） | 生产者消费者、线程协作 |
| **原子操作 / CAS** | CPU 指令级（`cmpxchg`） | 无锁结构、计数器、AQS 的基础 |
| **屏障/内存栅栏** | 约束指令重排与可见性 | volatile、JMM（见 [JMM](#/java/concurrency/jmm)） |

**futex（Fast Userspace muTEX）**：Linux 锁的底层实现。**无竞争时纯用户态原子操作完成加解锁（不进内核）**；**有竞争才通过 `futex` 系统调用进入内核睡眠/唤醒**。所以 Java 的 `synchronized` 重量级锁、`ReentrantLock`/`LockSupport.park` 最终都落到 futex；`strace` 里大量 `futex` 调用提示锁竞争严重（见 [synchronized](#/java/concurrency/sync)、[AQS](#/java/concurrency/aqs)）。

### 2. 死锁

**四个必要条件（缺一不可）**：

1. **互斥**：资源一次只能被一个线程使用；
2. **持有并等待**：持有资源的同时请求新资源；
3. **不可抢占**：资源只能由持有者主动释放；
4. **循环等待**：存在线程-资源的环形等待链。

| 破坏条件 | 工程做法 |
| --- | --- |
| 破坏**循环等待** | **统一加锁顺序**（按 ID/地址排序加锁，如转账先锁小账号后锁大账号）——最常用 |
| 破坏**持有并等待** | 一次性申请全部资源；`tryLock` 拿不到就释放已持有的并重试 |
| 破坏**不可抢占** | `tryLock(timeout)` 超时放弃；数据库锁等待超时回滚（见 [MySQL 锁](#/mysql/lock)） |
| 破坏**互斥** | 无锁结构、不可变对象、乐观锁/CAS、副本（读时复制） |

诊断（Java）：`jstack <pid>` 末尾会输出 "Found one Java-level deadlock"，或用 `jcmd <pid> Thread.print`、Arthas `thread -b`（找阻塞他人的线程）。数据库死锁看 `SHOW ENGINE INNODB STATUS`。

**其他并发问题**：**活锁**（不断重试互相谦让，没有进展 → 随机退避）、**饥饿**（低优先级长期得不到资源 → 公平锁/老化）、**优先级反转**（低优先级持锁、高优先级被阻塞、中优先级抢占 → 优先级继承）。

### 3. 经典问题：生产者-消费者

```java
// 用 BlockingQueue 即可，内部是 ReentrantLock + 两个 Condition（notFull / notEmpty）
BlockingQueue<Task> q = new ArrayBlockingQueue<>(1024);
// 生产者：q.put(t)  队列满则阻塞    消费者：q.take()  队列空则阻塞
```

底层对应“互斥锁 + 条件变量”或“两个信号量（空位、数据）+ 一个互斥量”。

## 八、与 Java 的对应关系

| OS 概念 | Java / 工程中的体现 |
| --- | --- |
| 内核线程 | `Thread` 平台线程（一对一）；`-Xss` 是线程栈大小；线程数受 `ulimit -u`、`/proc/sys/kernel/threads-max`、内存限制 |
| 用户态调度 | **虚拟线程**（JDK 21）：遇到阻塞 IO 自动卸载，百万并发；注意固定（pinning）问题 |
| 上下文切换 | 线程池大小、锁竞争优化、避免无谓的线程切换 |
| 写时复制 | Redis fork、`CopyOnWriteArrayList` |
| futex | `synchronized`、`ReentrantLock`、`park/unpark` |
| 信号 | 优雅停机、`kill -3` 打印线程栈、`SIGTERM` |
| CFS 带宽控制 | 容器 CPU limit 导致 throttling；JVM 的 `availableProcessors` |
| 死锁条件 | 统一加锁顺序、`tryLock` 超时、数据库死锁重试 |

## 面试追问

> [!QUESTION] 进程和线程的区别？为什么线程切换比进程切换快？
> 进程是资源分配单位，有独立地址空间；线程是调度单位，共享进程的地址空间、文件描述符，各有栈和寄存器。线程切换不需要切换页表和刷新 TLB，缓存局部性也更好，所以更轻量；但线程共享内存需要同步，一个线程崩溃会导致整个进程退出。

> [!QUESTION] 什么是上下文切换？有什么开销？怎么降低？
> 保存当前任务寄存器等现场并恢复下一个任务的现场。直接开销是微秒级，更大的间接开销是 CPU 缓存和 TLB 失效。降低方法包括减少线程数、使用线程池、减少锁竞争、用无锁结构和批处理、异步化或使用虚拟线程，可用 vmstat、pidstat 观察自愿和非自愿切换。

> [!QUESTION] 线程池线程数怎么设置？
> CPU 密集型约为核数加一，IO 密集型约为核数乘以一加等待时间与计算时间之比，并通过压测校准；还要考虑下游数据库连接池和第三方限流，以及容器 CPU limit 对可用核数的限制。

> [!QUESTION] 死锁的四个条件？如何预防和排查？
> 互斥、持有并等待、不可抢占、循环等待。预防最常用统一加锁顺序破坏循环等待，也可用 tryLock 超时、一次性申请资源。排查用 jstack 或 jcmd 看 Java 层死锁报告，数据库死锁看 InnoDB 状态，并给锁等待设置超时。

> [!QUESTION] 容器里 CPU limit 为什么会导致延迟抖动？
> cgroup 用 CFS 带宽控制，每个周期有固定配额，多线程并发很快用完配额后整个容器被限流暂停到下个周期，即使节点空闲也会停顿，表现为 P99 毛刺。可监控 throttled 指标，放宽或取消 limit、减少线程数，并让 JVM 感知容器核数。

> [!QUESTION] load average 很高但 CPU 使用率很低是怎么回事？
> Linux 的平均负载包含运行、就绪以及不可中断睡眠（D 状态）的任务，磁盘或网络文件系统卡住时大量进程处于 D 状态，会推高 load 而 CPU 空闲，应看 vmstat 的阻塞数、iostat 和磁盘延迟。

> [!QUESTION] fork 和写时复制是什么？Redis 持久化为什么受影响？
> fork 后父子共享物理页并标记只读，谁写入才复制该页。Redis 做 RDB 时子进程读取快照，主进程继续写入会触发页复制，写入越多额外内存越大，极端接近两倍，所以要预留内存并避免大页干扰。
