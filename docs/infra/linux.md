---
level: 进阶
tags: [Linux, 线上排查, USE 方法, CPU, 内存, IO, 网络]
summary: 用 USE 方法系统化排查 Java 服务所在 Linux 主机的 CPU、内存、磁盘、网络与句柄问题，附命令速查、日志统计组合拳与三个完整案例
---

# Linux 线上排查

> [!ABSTRACT] 核心要点
> - 排查要有方法论：**USE 方法**——对每种资源（CPU、内存、磁盘、网络、句柄）依次检查利用率（Utilization）、饱和度（Saturation）、错误（Errors），先全局后进程再线程。
> - **load average ≠ CPU 使用率**：Linux 的 load 统计的是 R（运行 + 排队）和 D（不可中断睡眠，多为等 IO）状态的任务数，load 高 CPU 低通常是 IO 或 D 状态卡住。
> - Java CPU 高的标准路径：`top` 找进程 → `top -Hp` 找线程 → 转十六进制 → `jstack` 对照 nid；区分是业务线程、GC 线程还是 JIT 线程。
> - `free` 中 buff/cache 大不是问题，看 **available**；进程「无声消失」且没有 `hs_err_pid` 文件，先查 `dmesg` 的 OOM Killer 记录。
> - `Too many open files` 先看进程实际 limit（`/proc/<pid>/limits`），systemd 服务不读 `limits.conf`；句柄泄漏最常见的是未关闭的连接（伴随 CLOSE_WAIT）。

## 排查方法论

### USE 方法

| 资源 | 利用率 U | 饱和度 S | 错误 E |
| --- | --- | --- | --- |
| CPU | `mpstat -P ALL 1` 的 us+sy；`top` | `vmstat 1` 的 `r` 列 > 核数；load；`pidstat -w` 上下文切换 | `dmesg` 中 MCE；容器中 CPU throttling |
| 内存 | `free -h` 的 used / available | `vmstat` 的 `si/so`（swap 换入换出）；直接回收、kswapd 活跃 | `dmesg` 中 OOM Killer；应用 OOM |
| 磁盘 | `iostat -x 1` 的 `%util` | `aqu-sz`（平均队列长度）、`await`；`wa` | `dmesg` 中 IO error、文件系统只读 |
| 网络 | `sar -n DEV 1` 吞吐 vs 带宽 | `ss -lnt` Recv-Q（accept 队列）；重传率；`ss` 中 Send-Q 堆积 | `ip -s link` 的 errors/dropped；`netstat -s` 重传与溢出 |
| 句柄/进程数 | `/proc/<pid>/fd` 数量 vs limit | 接近 `ulimit -n` / `pids.max` | `Too many open files`、`unable to create native thread` |

排查顺序：**先确认现象与时间点**（监控曲线、告警时刻、是否刚发布），然后**全局 → 进程 → 线程 → 代码**逐层收敛。经典的「60 秒速查」：

```bash
uptime                 # load 趋势：1/5/15 分钟，判断问题在恶化还是缓解
dmesg -T | tail -50    # OOM Killer、磁盘错误、conntrack 满、TCP 相关告警
vmstat 1 5             # r 运行队列、b 阻塞、si/so swap、us/sy/wa/st
mpstat -P ALL 1 3      # 是否单核打满（单线程瓶颈、网卡软中断集中在一个核）
pidstat 1 3            # 哪个进程吃 CPU
iostat -xz 1 3         # 磁盘 %util、await、队列
free -h                # available、swap 使用
sar -n DEV 1 3         # 网卡吞吐
sar -n TCP,ETCP 1 3    # 每秒主动/被动建连数、重传
top -c                 # 汇总确认
```

## 命令速查表

| 命令 | 用途 | 常用写法 / 关注点 |
| --- | --- | --- |
| `top` / `htop` | 进程级 CPU、内存 | `top -c` 显示完整命令；`top -Hp <pid>` 看线程；按 `P`/`M` 排序；`1` 展开每个核 |
| `vmstat` | 系统整体 | `vmstat 1`：r、b、si/so、bi/bo、in/cs、us/sy/id/wa/st |
| `mpstat` | 每核 CPU | `mpstat -P ALL 1`：看 `%soft`（软中断）、单核是否打满 |
| `pidstat` | 进程/线程维度 | `-u` CPU、`-r` 内存、`-d` 磁盘、`-w` 上下文切换、`-t` 展开线程 |
| `iostat` | 磁盘 | `iostat -xz 1`：`r/s w/s`、`r_await/w_await`、`aqu-sz`、`%util` |
| `free` | 内存 | `free -h`：看 `available` 而不是 `free` |
| `sar` | 历史与实时 | `sar -u`、`sar -q`（load）、`sar -n DEV`、`sar -f /var/log/sa/saDD` 回看历史 |
| `df` / `du` | 磁盘空间 | `df -h`、`df -i`（inode）、`du -sh * \| sort -h` |
| `ss` / `netstat` | 连接 | `ss -s`、`ss -antp`、`ss -lnt`；`netstat -s` 协议统计 |
| `lsof` | 打开的文件 | `lsof -p <pid>`、`lsof -i :8080`、`lsof +L1`（已删除仍被占用） |
| `strace` | 系统调用 | `strace -f -T -tt -p <tid>`；`-c` 汇总；对进程有明显性能影响，慎用 |
| `tcpdump` | 抓包 | `tcpdump -i any -nn host 10.0.0.8 and port 3306 -w a.pcap` |
| `perf` | CPU 剖析 | `perf top -p <pid>`；Java 需配合 async-profiler 或 perf-map-agent 才能看到 Java 方法名 |
| `dmesg` | 内核日志 | `dmesg -T \| grep -iE 'oom\|killed\|error'` |
| `journalctl` | systemd 日志 | `journalctl -u app.service --since "10 min ago"`、`journalctl -k`（内核） |

## CPU

### load average 与 CPU 使用率

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="load average 统计运行中、排队中的 R 状态任务以及 D 状态任务，而 CPU 使用率只统计 CPU 上正在执行的时间">
<text class="ta" x="120" y="34" text-anchor="middle">CPU 使用率只看这里</text>
<rect class="bg" x="20" y="50" width="200" height="120" rx="10"/>
<text class="ts" x="34" y="70">CPU（2 核）</text>
<rect class="b2" x="35" y="90" width="80" height="50" rx="6"/>
<text class="tb" x="75" y="115" text-anchor="middle" dominant-baseline="middle">R 运行</text>
<rect class="b2" x="125" y="90" width="80" height="50" rx="6"/>
<text class="tb" x="165" y="115" text-anchor="middle" dominant-baseline="middle">R 运行</text>
<rect class="bg" x="240" y="50" width="220" height="120" rx="10"/>
<text class="ts" x="254" y="70">运行队列（等 CPU）</text>
<rect class="b3" x="255" y="90" width="60" height="50" rx="6"/>
<text class="tb" x="285" y="115" text-anchor="middle" dominant-baseline="middle">R</text>
<rect class="b3" x="325" y="90" width="60" height="50" rx="6"/>
<text class="tb" x="355" y="115" text-anchor="middle" dominant-baseline="middle">R</text>
<rect class="b3" x="395" y="90" width="60" height="50" rx="6"/>
<text class="tb" x="425" y="115" text-anchor="middle" dominant-baseline="middle">R</text>
<rect class="bg" x="480" y="50" width="220" height="120" rx="10"/>
<text class="ts" x="494" y="70">D 状态（不可中断睡眠）</text>
<rect class="b4" x="495" y="90" width="95" height="50" rx="6"/>
<text class="tb" x="542" y="115" text-anchor="middle" dominant-baseline="middle">D 等磁盘</text>
<rect class="b4" x="600" y="90" width="90" height="50" rx="6"/>
<text class="tb" x="645" y="115" text-anchor="middle" dominant-baseline="middle">D 等 NFS</text>
<line class="l" x1="20" y1="190" x2="700" y2="190"/>
<line class="l" x1="20" y1="182" x2="20" y2="190"/>
<line class="l" x1="700" y1="182" x2="700" y2="190"/>
<text class="ts" x="360" y="212" text-anchor="middle">load average = R（运行 + 排队）+ D 的任务数，按 1 / 5 / 15 分钟做指数衰减平均；本例瞬时值为 7</text>
</svg>
<figcaption>图 1：load average 与 CPU 使用率的统计范围不同</figcaption>
</figure>

- 判断标准是 **load / CPU 核数**：持续大于 1 说明有任务在排队；但 D 状态也计入，所以「load 30、CPU 20%」在 Linux 上很常见，通常是磁盘慢、NFS 挂死或大量进程卡在内核。
- `ps -eLo state,pid,tid,comm | awk '$1=="D"' | head` 找 D 状态线程，`cat /proc/<pid>/stack`（需 root）看卡在哪个内核函数。
- 容器里看到的 load 是**宿主机**的，判断容器 CPU 是否饱和要看 cgroup 的 `cpu.stat` 中 `nr_throttled`、`throttled_time`（cgroup v2 为 `throttled_usec`）。

### CPU 各项指标

| 指标 | 含义 | 偏高时怀疑 |
| --- | --- | --- |
| `us` | 用户态 | 业务计算、死循环、GC、序列化、正则 |
| `sy` | 内核态 | 线程过多导致上下文切换（`vmstat` 的 `cs` 很高）、锁竞争、频繁系统调用、小包 IO |
| `wa` | 等待 IO 的空闲时间 | 磁盘慢；注意 wa 高不一定 CPU 忙 |
| `si` | 软中断 | 网络包量大；若集中在一个核，考虑 RPS/RSS 多队列网卡分散 |
| `st` | 被宿主机偷走的时间 | 云主机超卖、邻居争抢；只能迁移或升配 |

### CPU 高定位到 Java 线程

<figure class="fig">
<svg viewBox="0 0 740 190" class="dg" role="img" aria-label="Java 进程 CPU 高的定位路径：top 找进程，top -Hp 找线程，转十六进制，jstack 定位线程栈，再判断是 GC、JIT 还是业务线程">
<rect class="b1" x="10" y="20" width="130" height="72" rx="8"/>
<text class="tb" x="75" y="38" text-anchor="middle" dominant-baseline="middle">① 找进程</text>
<text class="tm" x="75" y="58" text-anchor="middle" dominant-baseline="middle">top -c</text>
<text class="ts" x="75" y="78" text-anchor="middle">PID 1234，CPU 380%</text>
<line class="l" x1="140" y1="56" x2="158" y2="56" marker-end="url(#arr)"/>
<rect class="b1" x="160" y="20" width="130" height="72" rx="8"/>
<text class="tb" x="225" y="38" text-anchor="middle" dominant-baseline="middle">② 找线程</text>
<text class="tm" x="225" y="58" text-anchor="middle" dominant-baseline="middle">top -Hp 1234</text>
<text class="ts" x="225" y="78" text-anchor="middle">TID 1301 占 95%</text>
<line class="l" x1="290" y1="56" x2="308" y2="56" marker-end="url(#arr)"/>
<rect class="b1" x="310" y="20" width="130" height="72" rx="8"/>
<text class="tb" x="375" y="38" text-anchor="middle" dominant-baseline="middle">③ 转十六进制</text>
<text class="tm" x="375" y="58" text-anchor="middle" dominant-baseline="middle">printf '%x' 1301</text>
<text class="ts" x="375" y="78" text-anchor="middle">得到 515</text>
<line class="l" x1="440" y1="56" x2="458" y2="56" marker-end="url(#arr)"/>
<rect class="b1" x="460" y="20" width="130" height="72" rx="8"/>
<text class="tb" x="525" y="38" text-anchor="middle" dominant-baseline="middle">④ 看线程栈</text>
<text class="tm" x="525" y="58" text-anchor="middle" dominant-baseline="middle">jstack 1234</text>
<text class="ts" x="525" y="78" text-anchor="middle">搜 nid=0x515</text>
<line class="la" x1="590" y1="56" x2="608" y2="56" marker-end="url(#arr-a)"/>
<rect class="b5" x="610" y="20" width="120" height="72" rx="8"/>
<text class="tb" x="670" y="46" text-anchor="middle" dominant-baseline="middle">⑤ 判断类型</text>
<text class="ts" x="670" y="70" text-anchor="middle">看线程名与栈顶</text>
<line class="ld" x1="670" y1="92" x2="670" y2="112"/>
<line class="ld" x1="125" y1="112" x2="670" y2="112"/>
<line class="ld" x1="125" y1="112" x2="125" y2="128" marker-end="url(#arr)"/>
<line class="ld" x1="370" y1="112" x2="370" y2="128" marker-end="url(#arr)"/>
<line class="ld" x1="615" y1="112" x2="615" y2="128" marker-end="url(#arr)"/>
<rect class="b3" x="10" y="130" width="230" height="48" rx="8"/>
<text class="tb" x="125" y="146" text-anchor="middle" dominant-baseline="middle">GC 线程</text>
<text class="ts" x="125" y="166" text-anchor="middle">jstat -gcutil 看 FGC 是否飙升</text>
<rect class="b2" x="255" y="130" width="230" height="48" rx="8"/>
<text class="tb" x="370" y="146" text-anchor="middle" dominant-baseline="middle">C2 CompilerThread</text>
<text class="ts" x="370" y="166" text-anchor="middle">发布后 JIT 预热，通常自行回落</text>
<rect class="b4" x="500" y="130" width="230" height="48" rx="8"/>
<text class="tb" x="615" y="146" text-anchor="middle" dominant-baseline="middle">业务线程</text>
<text class="ts" x="615" y="166" text-anchor="middle">死循环、正则回溯、大对象序列化</text>
</svg>
<figcaption>图 2：从进程到 Java 线程栈的 CPU 定位路径</figcaption>
</figure>

```bash
pid=$(pgrep -f app.jar)
top -Hp $pid -b -n 1 | head -20                      # 批处理模式便于保存现场
tid=1301; hex=$(printf '%x' $tid)
jstack $pid > /tmp/js.$(date +%s).txt                # 先落盘，连续抓 3 次间隔 5s 对比
grep -A 30 "nid=0x$hex" /tmp/js.*.txt
# 统计线程状态分布，判断是否大量线程 BLOCKED 在同一把锁上
grep 'java.lang.Thread.State' /tmp/js.*.txt | sort | uniq -c
```

- 只抓一次 jstack 可能恰好抓在「路过」的位置，**连续抓 3 次**，同一个线程总停在同一段代码才是热点。
- 更省事的是 Arthas `thread -n 3`（直接列出最忙的 3 个线程及栈）或 async-profiler 生成火焰图，适合 CPU 被很多线程分摊、单线程不突出的情况。
- JDK 19 起线程 dump 中的 `nid` 改为十进制显示，此时不需要转十六进制，以实际输出格式为准。
- 更完整的 JVM 侧分析（GC、内存泄漏、死锁）见 [线上调优与故障排查](#/java/jvm/tuning)。

## 内存

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="free 命令输出的构成：used、buff/cache、free，available 约等于 free 加可回收的缓存">
<text class="th" x="360" y="28" text-anchor="middle">total（物理内存）</text>
<rect class="b4" x="20" y="44" width="280" height="50" rx="6"/>
<text class="tb" x="160" y="62" text-anchor="middle" dominant-baseline="middle">used</text>
<text class="ts" x="160" y="84" text-anchor="middle">进程匿名页（JVM 堆、堆外）+ 内核</text>
<rect class="b3" x="300" y="44" width="80" height="50" rx="6"/>
<text class="ts" x="340" y="62" text-anchor="middle">不可回收</text>
<text class="ts" x="340" y="84" text-anchor="middle">脏页 / shm</text>
<rect class="b3" x="380" y="44" width="180" height="50" rx="6"/>
<text class="tb" x="470" y="62" text-anchor="middle" dominant-baseline="middle">buff/cache</text>
<text class="ts" x="470" y="84" text-anchor="middle">可回收的页缓存、slab</text>
<rect class="b2" x="560" y="44" width="140" height="50" rx="6"/>
<text class="tb" x="630" y="62" text-anchor="middle" dominant-baseline="middle">free</text>
<text class="ts" x="630" y="84" text-anchor="middle">完全空闲</text>
<line class="la" x1="380" y1="112" x2="700" y2="112"/>
<line class="la" x1="380" y1="104" x2="380" y2="112"/>
<line class="la" x1="700" y1="104" x2="700" y2="112"/>
<text class="ta" x="540" y="132" text-anchor="middle">available ≈ free + 可回收缓存</text>
<text class="ts" x="20" y="166">Linux 会把空闲内存尽量用作页缓存，free 列很小不代表内存不足；</text>
<text class="ts" x="20" y="184">真正的危险信号是 available 持续走低、si/so 持续不为 0、dmesg 出现 OOM Killer。</text>
</svg>
<figcaption>图 3：free 输出中各列的含义，判断内存是否紧张要看 available</figcaption>
</figure>

### OOM Killer

内存耗尽时内核按 `oom_score`（主要依据内存占用，可用 `oom_score_adj` 调整）选择进程 `SIGKILL`。Java 进程被杀时**来不及写 `hs_err_pid` 也不会触发 `HeapDumpOnOutOfMemoryError`**，日志戛然而止。

```bash
dmesg -T | grep -iE 'killed process|out of memory'
# [Tue Oct  8 10:21:33 2026] Out of memory: Killed process 1234 (java) total-vm:12GB, anon-rss:7.6GB ...
journalctl -k --since "1 hour ago" | grep -i oom
cat /proc/$pid/oom_score
```

Java 进程 RSS 往往大于 `-Xmx`，组成大致为：

```text
RSS ≈ 堆（已提交部分） + 元空间 + 线程栈（线程数 × Xss）+ CodeCache
      + 直接内存（NIO / Netty）+ GC 自身数据结构 + JNI / glibc malloc 分配
```

- 用 NMT 拿到 JVM 视角的分项：启动加 `-XX:NativeMemoryTracking=summary`，运行时 `jcmd <pid> VM.native_memory summary`。
- NMT 统计不到 JNI 库自己 malloc 的内存；glibc 多 arena 可能让 RSS 虚高，可尝试 `MALLOC_ARENA_MAX=2~4` 或换 jemalloc 观察。
- 堆 + 其他开销留足余量：物理机部署时 `-Xmx` 一般不超过可用内存的 60%～70%；容器场景见 [Docker 容器化](#/infra/docker)。

### swap

GC 需要遍历整个堆，堆页一旦被换出，GC 停顿会从毫秒级变成秒级甚至更长。Java 服务器建议关闭 swap 或把 `vm.swappiness` 调到很低（如 1～10），宁可 OOM 快速失败被重启，也不要长时间半死不活。`vmstat` 中 `si/so` 持续非 0 就是正在发生换页。

## 磁盘 IO

```bash
iostat -xz 1
# Device  r/s   w/s   rkB/s   wkB/s  r_await w_await aqu-sz  %util
# vdb     2.0  850.0   16.0 98000.0   1.20   180.50  150.3  100.0
pidstat -d 1            # 哪个进程在读写
iotop -oP               # 需要 root，直观看进程 IO
```

| 指标 | 含义 | 注意 |
| --- | --- | --- |
| `r_await` / `w_await` | 单次 IO 平均耗时（**含排队时间**），ms | SSD 通常应在个位数 ms 以内；几十上百 ms 说明饱和 |
| `aqu-sz`（旧版 `avgqu-sz`） | 平均队列长度 | 持续大于设备并行能力即饱和 |
| `%util` | 设备有 IO 在处理的时间占比 | 对 SSD / RAID / 云盘这类可并行设备，100% **不一定**到达上限，要结合 await 判断 |
| `wa`（CPU） | CPU 空闲且有 IO 未完成的时间 | 只能说明有 IO 等待，不能单独作为磁盘瓶颈依据 |

磁盘相关的 Java 典型问题：

- **同步日志写满磁盘带宽**：DEBUG 日志、大对象 toString；改用异步 Appender（Logback `AsyncAppender`、Log4j2 `AsyncLogger`），并评估 `discardingThreshold` / `neverBlock`（队列满时丢日志还是阻塞业务）。
- **磁盘满**：`df -h` 看空间，`df -i` 看 inode（大量小文件也会「满」）。
- **删了文件空间不释放**：日志被 `rm` 但 Java 进程仍持有句柄，`lsof +L1` 或 `lsof -p <pid> | grep deleted` 可见；用 `: > file` 截断或重启进程，日志轮转用 `copytruncate` 或交给日志框架自己滚动。
- GC 日志 / hsperfdata 写在高负载磁盘上时可能放大 STW，有报告称 `-XX:+PerfDisableSharedMem` 可缓解（代价是 `jps`/`jstat` 无法使用）。

## 网络

```bash
ss -s                                        # 总览：estab、timewait、orphan
ss -ant | awk 'NR>1{++s[$1]} END{for(k in s) print k, s[k]}'   # 连接状态分布
ss -antp | grep ':3306' | wc -l              # 到 MySQL 的连接数，对照连接池上限
ss -tnp state established '( dport = :6379 )' # 本机到 Redis 的连接
ss -lnt                                      # LISTEN socket：Recv-Q 为 accept 队列长度
netstat -s | grep -iE 'retrans|overflow|drop|reset'
sar -n TCP,ETCP 1                            # retrans/s 重传速率
ip -s link show eth0                         # 网卡 RX/TX errors、dropped
nstat -az | grep -iE 'TcpExtListenOverflows|TcpRetransSegs'
```

- **重传率**（`retrans/s ÷ oseg/s`）持续超过 1% 就会明显影响 RT，多为链路丢包、对端处理慢或带宽打满。
- `dmesg` 出现 `nf_conntrack: table full, dropping packet`：连接跟踪表满导致随机丢包，常见于高并发短连接且开了 iptables 的机器（包括 K8s 节点），调大 `net.netfilter.nf_conntrack_max` 或减少短连接。
- `mtr <ip>` 可逐跳看丢包和延迟；跨机房问题先确认是否只是某一跳 ICMP 限速。
- 连接状态异常（TIME_WAIT、CLOSE_WAIT、队列溢出）的原理与处理见 [TCP/IP 与 HTTP(S)](#/infra/network)。

## 文件句柄耗尽

`java.io.IOException: Too many open files` 或 Tomcat 日志刷 `Socket accept failed`。在 Linux 上一切皆文件，socket、jar、日志、管道都占用 fd。

```bash
cat /proc/$pid/limits | grep -i 'open files'     # 进程实际生效的 limit（最可信）
ls /proc/$pid/fd | wc -l                          # 当前打开数
lsof -p $pid | awk '{print $5}' | sort | uniq -c | sort -rn   # 按类型统计：IPv4 / REG / FIFO
lsof -p $pid -a -i | awk '{print $NF}' | sort | uniq -c | sort -rn | head  # 按连接状态统计
cat /proc/sys/fs/file-nr                          # 系统级：已分配 / 未使用 / 上限
```

| 层级 | 配置 | 说明 |
| --- | --- | --- |
| 进程 | `ulimit -n`（软/硬限制） | 很多发行版默认软限制 1024，对 Java 服务远远不够，一般设 65535 或更高 |
| 登录会话 | `/etc/security/limits.conf` | 由 PAM 在登录时应用，**对 systemd 启动的服务无效** |
| systemd 服务 | unit 文件中 `LimitNOFILE=` | systemd 托管的 Java 服务要改这里 |
| 系统 | `fs.file-max`、`fs.nr_open` | 全局上限 |
| 容器 | 容器运行时 / K8s 节点配置 | 进入容器看 `/proc/1/limits` 确认 |

> [!WARNING] 调大 limit 不是修复
> 如果句柄数随时间单调上涨，调大 limit 只是推迟故障。看增长的是哪类 fd：大量 `IPv4` 且对应 CLOSE_WAIT → 连接未关闭；大量 `REG` 同一文件 → 流未关闭。修代码，用 try-with-resources。

与之类似的还有 `java.lang.OutOfMemoryError: unable to create native thread`：多数不是内存问题，而是触到了 `ulimit -u`（max user processes，线程也计入）、`kernel.pid_max`、`kernel.threads-max` 或容器 `pids.max`。先 `ls /proc/$pid/task | wc -l` 看线程数，再查是不是有人在循环里 `new Thread` / 创建线程池。

## 日志分析组合拳

以 Nginx access log 为例（假设格式为 combined，最后一列追加 `$request_time`）：

```bash
LOG=/var/log/nginx/access.log
# 每秒 QPS（取时间到秒），按 QPS 降序看峰值
awk '{print substr($4, 2, 20)}' $LOG | sort | uniq -c | sort -rn | head
# 某一分钟内的 QPS 曲线
grep '08/Oct/2026:10:2' $LOG | awk '{print substr($4, 14, 8)}' | uniq -c
# TopN 接口（去掉 query string）
awk '{split($7, a, "?"); print a[1]}' $LOG | sort | uniq -c | sort -rn | head -20
# 状态码分布
awk '{print $9}' $LOG | sort | uniq -c | sort -rn
# 5xx 最多的接口
awk '$9 ~ /^5/ {split($7, a, "?"); print $9, a[1]}' $LOG | sort | uniq -c | sort -rn | head
# 慢请求 Top 20（最后一列为 request_time，秒）
awk '{print $NF, $7}' $LOG | sort -rn | head -20
# 接口平均耗时
awk '{split($7, a, "?"); s[a[1]] += $NF; c[a[1]]++} END {for (k in s) printf "%.3f %d %s\n", s[k]/c[k], c[k], k}' $LOG | sort -rn | head
# 访问最多的 IP（排查刷接口）
awk '{print $1}' $LOG | sort | uniq -c | sort -rn | head
```

Java 应用日志：

```bash
# 截取时间窗口（日志按时间有序时）
sed -n '/2026-10-08 10:20:00/,/2026-10-08 10:25:00/p' app.log > window.log
# 异常类型统计
grep -oE '[a-zA-Z.]+(Exception|Error)\b' window.log | sort | uniq -c | sort -rn | head
# 按 traceId 串起一次请求的全部日志（多实例时配合 pssh / 日志平台）
grep 'traceId=abc123' app.log*
# 实时观察错误
tail -F app.log | grep --line-buffered -E 'ERROR|Exception'
```

> [!TIP] 现场优先，分析其次
> 排查前先保存现场再重启：`jstack`（3 次）、`jstat -gcutil <pid> 1000 10`、`top -Hp` 截图、`ss -s`、`free -h`、`dmesg`、必要时 `jmap -dump`（会 STW，大堆耗时长，先摘流量）。重启能恢复服务，但会抹掉所有证据。

## 三个完整排查案例

### 案例一：CPU 打满，接口全部超时

1. **现象**：发布后 30 分钟，某服务 4 核 CPU 均接近 100%，接口大面积超时，load 12。
2. **定位**：`top -Hp` 发现 4 个 `http-nio-8080-exec-*` 线程各占约 95%；连续 3 次 `jstack` 均停在 `java.util.regex.Pattern$Loop.match` / `Pattern$GroupCurly.match`，上层是用户输入的邮箱校验。
3. **根因**：新加的正则 `^([a-zA-Z0-9]+\.?)+@...` 存在嵌套量词，遇到某些不匹配的长输入发生**灾难性回溯**，时间复杂度呈指数级。
4. **修复**：改写正则消除嵌套量词、限制输入长度；在网关层对该接口限流；单测补充恶意输入用例。
5. **教训**：CPU 高时只要线程栈稳定停在 `Pattern`，基本可以直接锁定正则回溯。

### 案例二：load 很高但 CPU 很闲，接口偶发数秒卡顿

1. **现象**：load 25（8 核），`top` 中 us 15%、wa 45%；部分请求 RT 从 50ms 跳到 3s。
2. **定位**：`iostat -xz 1` 显示数据盘 `w_await` 200ms+、`%util` 100%、`aqu-sz` 上百；`pidstat -d 1` 显示 Java 进程写入 90MB/s；`jstack` 中大量业务线程 BLOCKED 在 Logback 的 `OutputStreamAppender` 锁上。
3. **根因**：排查问题时临时把一个包的日志级别调成 DEBUG 忘了改回，同步日志打满云盘带宽，业务线程排队等日志锁。
4. **修复**：恢复日志级别；改用 `AsyncAppender`（明确队列满时的策略）；日志盘与数据盘分离；对日志级别变更做审计与自动回滚。
5. **教训**：load 高而 CPU 低时先看 `wa`、`iostat` 和 D 状态线程，不要盲目扩容 CPU。

### 案例三：Java 进程每隔几天无声消失

1. **现象**：进程突然不见，应用日志没有任何异常，没有 `hs_err_pid` 文件，也没有 heap dump。
2. **定位**：`dmesg -T` 中有 `Out of memory: Killed process ... (java) anon-rss:7.8GB`，而 `-Xmx4g`。开启 NMT 观察一天，`Internal`/`Other` 分项（直接内存）持续上涨；Netty 日志有 `LEAK:` 警告。
3. **根因**：自定义 Netty Handler 在某个分支丢弃消息时没有 `release()`，池化直接内存不断泄漏，进程 RSS 超出机器内存，被 OOM Killer 杀掉。
4. **修复**：补 `ReferenceCountUtil.release`；设置 `-XX:MaxDirectMemorySize` 让泄漏以 Java 异常形式尽早暴露；监控进程 RSS 与 Netty 内存池指标（见 [IO 模型与 Netty](#/infra/netty)）。
5. **教训**：「无日志、无 dump 的死亡」= 外部 kill，第一时间查 `dmesg` 或容器的 OOMKilled 事件。

## 生产实践与踩坑

- **不要在高峰期对大堆执行 `jmap -dump` / `jmap -histo:live`**：会触发 STW（`:live` 会先 Full GC），先把实例从负载均衡摘除。
- `strace` 基于 ptrace，会让目标进程显著变慢，线上只短时间、针对单线程（`-p <tid>`）使用。
- `top` 的 `%CPU` 是相对单核的，多核进程可以超过 100%；`mpstat` 看是否只有一个核被打满（单线程瓶颈或软中断集中）。
- 容器内的 `top`、`free` 看到的通常是宿主机资源，应查看 cgroup 文件或使用容器感知的工具，详见 [Docker 容器化](#/infra/docker)。
- 把常用排查命令固化为脚本（一键采集现场打包），故障时比手敲可靠得多。

## 相关阅读

- [进程、线程与 CPU 调度](#/cs/os-process)：进程、调度与上下文切换
- [虚拟内存、分页与内存管理](#/cs/os-memory)：内存与 OOM
- [容器网络与网络排障：CNI、iptables/IPVS、tcpdump](#/cs/net-debug)：网络排障：tcpdump 与 ss
- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：把排查经验沉淀为监控
- [Redis 故障排查与安全加固](#/redis/troubleshooting)：Redis 延迟问题的系统层排查

## 面试追问

> [!QUESTION] load average 很高但 CPU 使用率很低，可能是什么原因？怎么查？
> Linux 的 load 包含 D 状态（不可中断睡眠）任务，常见于磁盘 IO 慢、NFS 挂死、大量进程争用内核资源。先看 `vmstat` 的 `b` 列与 `wa`，`iostat -x` 看 await 和 `%util`，`ps` 找 D 状态线程并通过 `/proc/<pid>/stack` 看卡在哪个内核调用。

> [!QUESTION] 线上 Java 进程 CPU 100%，你的排查步骤？
> `top` 定位进程 → `top -Hp` 找高 CPU 线程 → `printf '%x'` 转十六进制 → `jstack` 搜 `nid` 看栈，连续抓多次确认；按线程名区分 GC 线程（再看 `jstat -gcutil` 和 GC 日志）、C2 编译线程（发布后预热）还是业务线程（死循环、正则回溯、大集合计算）。也可用 Arthas `thread -n 3` 或 async-profiler 火焰图一步到位。

> [!QUESTION] free 显示只剩 200M 了，需要扩内存吗？
> 先看 available 而不是 free。Linux 会把空闲内存用作 page cache，需要时可回收；只有 available 持续很低、出现 swap 换入换出或 OOM Killer 记录时才说明真正不足。

> [!QUESTION] Java 进程被杀但没有任何日志，可能是什么原因？
> 外部 `SIGKILL`：最常见的是内核 OOM Killer（`dmesg` 可见）或容器超过 memory limit 被 cgroup OOM（K8s 中 `OOMKilled`），也可能是运维脚本或 systemd 的 kill。JVM 来不及做任何处理，所以没有 `hs_err` 和 heap dump。常见原因是 RSS 远大于 Xmx：直接内存、线程栈、元空间、native 泄漏。

> [!QUESTION] 出现 Too many open files，怎么处理？
> 先看 `/proc/<pid>/limits` 中实际生效的上限和 `/proc/<pid>/fd` 当前数量，确认是 limit 太小（如默认 1024、systemd 服务没配 `LimitNOFILE`）还是泄漏（数量随时间单调增长）；泄漏时用 `lsof` 按类型、对端统计，常见是连接未关闭（伴随 CLOSE_WAIT）或文件流未关闭。
