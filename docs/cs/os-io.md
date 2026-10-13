---
level: 进阶
tags: [操作系统, 文件系统, 页缓存, 零拷贝, sendfile, mmap, fsync, 磁盘IO, io_uring, 顺序写]
summary: 文件系统与 IO 的内核视角：inode/目录/硬链接与软链接、VFS、页缓存与脏页回写、fsync 与持久化语义、磁盘与调度（顺序/随机、SSD）、传统 IO 的四次拷贝与零拷贝（mmap、sendfile、splice）、Direct IO、io_uring，并映射到 Kafka、MySQL、Redis AOF、Netty 的设计。
---

# 文件系统、页缓存与零拷贝

> [!ABSTRACT] 核心要点
> - **文件的本质是 inode**（元数据 + 数据块指针），文件名只是目录里指向 inode 的一条记录；`rm` 删的是名字，**句柄没关闭时空间不会释放**（线上“磁盘满了但 `du` 找不到”的经典原因）。
> - **读写默认经过页缓存（page cache）**：读命中缓存不碰磁盘，写只写入缓存并标记脏页，**异步回写**——所以 `write` 返回不代表落盘，**要持久化必须 `fsync`**（见 MySQL `innodb_flush_log_at_trx_commit`、Kafka 刷盘、Redis AOF `appendfsync`）。
> - **顺序写远快于随机写**（机械盘差几个数量级，SSD 也有差距）：这是 **WAL/redo log、Kafka、LSM-Tree** 的共同出发点。
> - **零拷贝**减少 CPU 拷贝与用户/内核切换：传统读文件发网络需要 **4 次拷贝 + 4 次切换**，`sendfile` 降到 **2 次 DMA 拷贝 + 2 次切换**（支持 SG-DMA 时无 CPU 拷贝）。Kafka、Nginx、Netty 的 `FileRegion` 都用它。
> - `mmap` 与 `sendfile` 适用场景不同：`mmap` 适合**需要在用户态读写/处理数据**，`sendfile` 适合**纯转发不改内容**。

> [!NOTE] 关联
> IO 模型（阻塞/非阻塞/多路复用/AIO）、select/poll/epoll 在 [IO 模型与 Netty](#/infra/netty) 已有详解；本页聚焦**文件、缓存、持久化与拷贝**。

## 一、文件系统基础

### 1. inode、目录与链接

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="文件系统结构：目录项把文件名映射到 inode 号；inode 保存元数据如权限大小时间和数据块指针；硬链接是多个文件名指向同一个 inode，软链接是一个存放目标路径的特殊文件；文件的数据保存在磁盘数据块中">
<rect class="b3" x="20" y="30" width="190" height="100" rx="10"/>
<text class="th" x="36" y="54">目录（一种特殊文件）</text>
<text class="ts" x="36" y="78">app.log  →  inode 1024</text>
<text class="ts" x="36" y="98">hard.log →  inode 1024</text>
<text class="ts" x="36" y="118">other.txt → inode 2048</text>
<rect class="b5" x="270" y="30" width="230" height="130" rx="10"/>
<text class="th" x="286" y="54">inode 1024（元数据）</text>
<text class="ts" x="286" y="78">权限 / 属主 / 大小 / 时间戳</text>
<text class="ts" x="286" y="98">链接计数 = 2</text>
<text class="ts" x="286" y="118">数据块指针（直接 / 间接 / extent）</text>
<text class="ts" x="286" y="138">文件名不在 inode 里</text>
<rect class="b2" x="560" y="30" width="210" height="130" rx="10"/>
<text class="th" x="576" y="54">磁盘数据块</text>
<rect class="b" x="576" y="70" width="50" height="30" rx="4"/>
<rect class="b" x="636" y="70" width="50" height="30" rx="4"/>
<rect class="b" x="696" y="70" width="50" height="30" rx="4"/>
<text class="ts" x="576" y="124">文件内容分散在块中</text>
<text class="ts" x="576" y="144">ext4 用 extent 描述连续区间</text>
<line class="l" x1="210" y1="70" x2="270" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="95" x2="560" y2="95" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="185" width="760" height="100" rx="10"/>
<text class="ts" x="36" y="208">• 硬链接：多个名字指向同一 inode，删除一个名字链接计数减一，减到 0 且无进程打开才真正释放；不能跨文件系统、不能链接目录</text>
<text class="ts" x="36" y="230">• 软链接（符号链接）：保存目标路径的小文件，可跨文件系统，目标删除后悬空</text>
<text class="ts" x="36" y="252">• 删除了一个仍被进程打开的大日志：df 显示已用、du 却找不到 → lsof +L1 | grep deleted，重启进程或 truncate /proc/pid/fd/N 释放</text>
<text class="ts" x="36" y="274">• inode 耗尽（df -i 100%）：大量小文件会导致“磁盘有空间却创建不了文件”</text>
</svg>
<figcaption>图 1：目录项、inode 与数据块</figcaption>
</figure>

### 2. VFS 与常见文件系统

**VFS（虚拟文件系统）**为 `open/read/write` 提供统一接口，屏蔽 ext4、XFS、NFS、overlayfs、tmpfs 的差别。

| 文件系统 | 特点 | 场景 |
| --- | --- | --- |
| **ext4** | 日志（journal）保证元数据一致，成熟稳定 | Linux 默认 |
| **XFS** | 大文件、高并发扩展好，延迟分配 | 大容量数据盘、数据库（RHEL 默认） |
| overlayfs | 分层联合挂载（只读层 + 可写层） | **Docker 镜像与容器层**（写时复制，容器内大量写要用 volume，见 [Docker](#/infra/docker)） |
| tmpfs | 内存文件系统 | `/dev/shm`、临时目录（占用内存） |
| NFS | 网络文件系统 | 共享存储（性能与一致性需谨慎，卡住时进程进入 D 状态） |

**日志式文件系统**：写数据前先写 journal，崩溃后重放以保证元数据一致；默认只对元数据做日志（`data=ordered`）。**数据库自己的 WAL 与文件系统日志是两层独立机制**，不能互相替代。

### 3. 文件描述符

- 进程通过**文件描述符（fd）**访问文件、socket、管道，内核维护三层结构：进程 fd 表 → 系统打开文件表（偏移量、状态）→ inode；
- **“Too many open files”**：fd 达到 `ulimit -n`（进程）或系统上限，常见于连接泄漏、未关闭流、高并发连接（Netty 十万连接需调大）；排查 `ls /proc/<pid>/fd | wc -l`、`lsof -p`；
- Java 里要用 try-with-resources 关闭流（见 [Java IO](#/java/api/io)）。

## 二、页缓存与脏页回写

### 1. 读写路径

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="页缓存读写路径：应用 read 先查页缓存，命中直接拷贝给用户缓冲区，未命中则从磁盘读入页缓存并可触发预读；应用 write 只写入页缓存并把页标脏，由内核线程在脏页比例或超时后异步回写磁盘，fsync 强制同步刷盘；Direct IO 绕过页缓存">
<rect class="b1" x="20" y="30" width="150" height="56" rx="10"/>
<text class="tb" x="95" y="58" text-anchor="middle" dominant-baseline="middle">应用（用户缓冲区）</text>
<rect class="b3" x="270" y="30" width="190" height="56" rx="10"/>
<text class="tb" x="365" y="52" text-anchor="middle" dominant-baseline="middle">页缓存 Page Cache</text>
<text class="ts" x="365" y="72" text-anchor="middle">空闲内存做缓存</text>
<rect class="b2" x="560" y="30" width="150" height="56" rx="10"/>
<text class="tb" x="635" y="58" text-anchor="middle" dominant-baseline="middle">磁盘（块设备）</text>
<line class="l" x1="170" y1="50" x2="270" y2="50" marker-end="url(#arr)"/>
<text class="ts" x="220" y="42" text-anchor="middle">write</text>
<line class="l" x1="270" y1="68" x2="170" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="220" y="84" text-anchor="middle">read(命中)</text>
<line class="la" x1="460" y1="50" x2="560" y2="50" marker-end="url(#arr-a)"/>
<text class="ta" x="510" y="42" text-anchor="middle">异步回写</text>
<line class="l" x1="560" y1="68" x2="460" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="510" y="84" text-anchor="middle">未命中 + 预读</text>
<path class="la nf" d="M95 86 L95 120 L635 120 L635 86" marker-end="url(#arr-a)"/>
<text class="ta" x="365" y="114" text-anchor="middle">Direct IO（O_DIRECT）：绕过页缓存，自管缓存（MySQL InnoDB、部分数据库）</text>
<rect class="bg" x="20" y="150" width="760" height="170" rx="10"/>
<text class="th" x="36" y="174">要点</text>
<text class="ts" x="36" y="198">• write() 返回只表示“写进了页缓存”，掉电会丢；需要持久就调 fsync()/fdatasync()，或 O_SYNC/O_DSYNC 打开</text>
<text class="ts" x="36" y="218">• 回写触发：脏页占比超过 vm.dirty_background_ratio（后台）/ dirty_ratio（阻塞写入）、脏页超时 dirty_expire_centisecs、内存紧张</text>
<text class="ts" x="36" y="238">• 顺序读会触发预读（readahead），顺序读吞吐远高于随机读；posix_fadvise/madvise 可给内核提示</text>
<text class="ts" x="36" y="258">• 脏页堆积后集中回写会造成 IO 尖刺、写入被阻塞（延迟毛刺）：调小 dirty_background_ratio，让回写更平滑</text>
<text class="ts" x="36" y="278">• 页缓存是“空闲内存的自动利用”：重启服务后缓存仍在（除非 drop_caches），但容器重启到新节点就冷了</text>
<text class="ts" x="36" y="298">• 双重缓存：应用缓存 + 页缓存同时缓存同一份数据浪费内存，所以数据库用 Direct IO 自管 Buffer Pool</text>
</svg>
<figcaption>图 2：页缓存：读命中、写回写、fsync 与 Direct IO</figcaption>
</figure>

### 2. fsync 与持久化语义

| 组件 | 配置 | 含义 |
| --- | --- | --- |
| MySQL | `innodb_flush_log_at_trx_commit` = 1/2/0 | 1：每次提交 `fsync` redo log（**最安全**）；2：写入 OS 缓存、每秒刷盘（MySQL 挂了不丢，机器掉电丢 ≤1s）；0：每秒写并刷 |
| MySQL | `sync_binlog` | 每多少次提交刷 binlog；`1` 最安全（见 [redo/undo/binlog](#/mysql/log)） |
| Redis AOF | `appendfsync always/everysec/no` | everysec 最常用，最多丢 1 秒（见 [Redis 持久化](#/redis/persistence)） |
| Kafka | `flush.messages/flush.ms`（默认不主动 fsync） | **依赖多副本而不是单机 fsync** 保证可靠，由 OS 异步刷盘（见 [Kafka 可靠性](#/mw/kafka-reliability)） |
| 通用 | `fsync` 的代价 | 机械盘约 10ms，SSD 约 0.1~1ms；**批量/组提交（group commit）**摊薄成本 |

**写文件的正确持久化姿势**（避免损坏）：写临时文件 → `fsync` → `rename` 覆盖原文件（rename 原子）→ 必要时 `fsync` 父目录。

```java
// Java 里 force 对应 fsync
try (FileChannel ch = FileChannel.open(path, CREATE, WRITE, APPEND)) {
    ch.write(buf);
    ch.force(false);   // false: 只刷数据（fdatasync）；true: 同时刷元数据（fsync）
}
```

## 三、磁盘与顺序写

| | 机械盘 HDD | SSD / NVMe |
| --- | --- | --- |
| 随机 IOPS | 约 100~200（需机械寻道） | 数万~百万 |
| 顺序吞吐 | 约 100~200 MB/s | 数百 MB/s ~ 数 GB/s |
| 特点 | 顺序/随机差距**极大**（百倍以上） | 差距小但仍存在；**写放大、GC、磨损**；4K 随机与顺序大块的效率不同 |

设计启示：

- **追加写日志（WAL / redo / binlog / Kafka 分区日志）** 把随机写变顺序写，成倍提升吞吐；
- **LSM-Tree**（RocksDB、HBase、ClickHouse MergeTree 思想）：随机写先进内存表再顺序落盘，后台合并（Compaction），用读放大与写放大换写吞吐；**B+ 树**（InnoDB）原地更新，读友好，随机写靠 Buffer Pool + 双写缓冲 + redo 缓解（见 [B+ 树索引](#/mysql/index)）；
- **IO 调度器**：HDD 用 `mq-deadline`，SSD/NVMe 通常 `none`/`noop`；
- 监控：`iostat -x 1` 看 `%util`、`await`（单次 IO 平均耗时）、`aqu-sz`（队列长度）、`r/s w/s`；`iotop`/`pidstat -d` 找哪个进程；**`await` 飙高 + 队列变长 = 磁盘饱和**（见 [Linux 线上排查](#/infra/linux)）。

## 四、零拷贝

### 1. 传统方式：读文件发网络

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="传统读文件再发送网络：磁盘经 DMA 到内核页缓存，CPU 拷贝到用户缓冲区，CPU 再拷贝到 socket 缓冲区，DMA 拷贝到网卡，共四次拷贝四次上下文切换；sendfile 在内核内直接把页缓存数据送到 socket 缓冲区或网卡，减少为两次或三次拷贝和两次切换，无需用户态参与">
<text class="th" x="20" y="24">传统 read + write：4 次拷贝 / 4 次切换</text>
<rect class="b2" x="20" y="40" width="110" height="46" rx="8"/>
<text class="ts" x="75" y="63" text-anchor="middle" dominant-baseline="middle">磁盘</text>
<rect class="b3" x="170" y="40" width="130" height="46" rx="8"/>
<text class="ts" x="235" y="63" text-anchor="middle" dominant-baseline="middle">内核页缓存</text>
<rect class="b1" x="340" y="40" width="130" height="46" rx="8"/>
<text class="ts" x="405" y="63" text-anchor="middle" dominant-baseline="middle">用户缓冲区</text>
<rect class="b3" x="510" y="40" width="130" height="46" rx="8"/>
<text class="ts" x="575" y="63" text-anchor="middle" dominant-baseline="middle">socket 缓冲区</text>
<rect class="b5" x="680" y="40" width="100" height="46" rx="8"/>
<text class="ts" x="730" y="63" text-anchor="middle" dominant-baseline="middle">网卡</text>
<line class="l" x1="130" y1="63" x2="170" y2="63" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="63" x2="340" y2="63" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="63" x2="510" y2="63" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="63" x2="680" y2="63" marker-end="url(#arr)"/>
<text class="ts" x="150" y="108" text-anchor="middle">① DMA</text>
<text class="ts" x="320" y="108" text-anchor="middle">② CPU 拷贝</text>
<text class="ts" x="490" y="108" text-anchor="middle">③ CPU 拷贝</text>
<text class="ts" x="660" y="108" text-anchor="middle">④ DMA</text>
<text class="ts" x="405" y="132" text-anchor="middle">用户态只是“搬运工”，数据根本没被修改；两次 CPU 拷贝与多次用户/内核切换纯属浪费</text>
<text class="th" x="20" y="176">sendfile：数据不进用户态</text>
<rect class="b2" x="20" y="192" width="110" height="46" rx="8"/>
<text class="ts" x="75" y="215" text-anchor="middle" dominant-baseline="middle">磁盘</text>
<rect class="b3" x="170" y="192" width="130" height="46" rx="8"/>
<text class="ts" x="235" y="215" text-anchor="middle" dominant-baseline="middle">内核页缓存</text>
<rect class="b3" x="340" y="192" width="130" height="46" rx="8"/>
<text class="ts" x="405" y="215" text-anchor="middle" dominant-baseline="middle">socket 缓冲区</text>
<rect class="b5" x="510" y="192" width="100" height="46" rx="8"/>
<text class="ts" x="560" y="215" text-anchor="middle" dominant-baseline="middle">网卡</text>
<line class="l" x1="130" y1="215" x2="170" y2="215" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="215" x2="340" y2="215" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="215" x2="510" y2="215" marker-end="url(#arr)"/>
<text class="ts" x="150" y="258" text-anchor="middle">DMA</text>
<text class="ts" x="320" y="258" text-anchor="middle">CPU（仅拷贝描述符/少量）</text>
<text class="ts" x="490" y="258" text-anchor="middle">DMA</text>
<text class="ta" x="630" y="215" text-anchor="start">2 次切换，无用户态拷贝</text>
<text class="ta" x="630" y="235" text-anchor="start">SG-DMA：几乎零 CPU 拷贝</text>
<rect class="bg" x="20" y="280" width="760" height="86" rx="10"/>
<text class="ts" x="36" y="304">• 关键点：绕开用户态，减少 CPU 拷贝和系统调用；缺点：数据在用户态不可见，无法修改（所以走 TLS 加密的场景受限，除非 kTLS）</text>
<text class="ts" x="36" y="324">• Kafka 消费：Broker 直接 sendfile 把页缓存里的日志送到网卡，不反序列化也不拷贝 → 高吞吐的重要原因（见 Kafka 笔记）</text>
<text class="ts" x="36" y="344">• Java：FileChannel.transferTo() / transferFrom()（底层 sendfile）；Netty 的 DefaultFileRegion、CompositeByteBuf 避免合并拷贝</text>
<text class="ts" x="36" y="360">• Nginx：sendfile on; tcp_nopush on; 静态文件高效发送（见 Nginx）</text>
</svg>
<figcaption>图 3：传统 IO 与 sendfile 零拷贝</figcaption>
</figure>

### 2. 零拷贝的几种手段

| 手段 | 做法 | 适用 |
| --- | --- | --- |
| **mmap + write** | 文件映射到用户空间（与页缓存共享），再 `write` 到 socket：3 次拷贝（省一次 CPU 拷贝） | 需要在用户态读写内容（如处理后再发送），RocketMQ 读 CommitLog 用 mmap |
| **sendfile** | 内核内部直接从页缓存送到 socket：2 次切换，最少拷贝 | 纯转发（静态文件、Kafka 消费） |
| **splice / tee** | 在内核中通过管道在两个 fd 间移动数据 | 代理、socket 间转发 |
| **Direct IO + DMA** | 绕过页缓存，应用缓冲区直接和磁盘 DMA | 数据库自管缓存 |
| **用户态内存减拷贝** | Netty `CompositeByteBuf`、`slice`（共享而非复制）、直接内存减少堆内→堆外的拷贝 | 应用层“零拷贝”（概念不同，只是少复制） |

> [!NOTE] 说明“零拷贝”
> 并非真的没有拷贝，而是**没有 CPU 在用户态与内核态之间的冗余拷贝**。DMA 拷贝（设备与内存之间）仍然存在。

### 3. Java 代码

```java
// 文件传输：transferTo 底层使用 sendfile（Linux）
try (FileChannel in = FileChannel.open(path, READ);
     SocketChannel out = SocketChannel.open(new InetSocketAddress(host, port))) {
    long pos = 0, size = in.size();
    while (pos < size) pos += in.transferTo(pos, size - pos, out);   // 单次可能传不完，需循环（有 2GB 限制，大文件分块）
}

// mmap：随机读写大文件
try (FileChannel ch = FileChannel.open(path, READ, WRITE)) {
    MappedByteBuffer mb = ch.map(FileChannel.MapMode.READ_WRITE, 0, 1L << 30);
    mb.putInt(0, 42);
    mb.force();        // 脏页刷盘（msync）
}
```

## 五、io_uring：新一代异步 IO

传统 Linux 异步文件 IO（AIO）只支持 Direct IO 且限制多。**io_uring**（Linux 5.1+）用**两个共享内存环形队列**（提交队列 SQ、完成队列 CQ）：

- 用户态把多个 IO 请求写入 SQ，**一次系统调用批量提交**（甚至轮询模式下零系统调用），内核完成后写入 CQ；
- 统一支持**文件与网络**、缓冲与直接 IO、批量与链式操作，大幅减少系统调用与上下文切换；
- 生态：RocksDB/数据库、Netty 的 io_uring 传输（孵化中）、Tokio-uring、liburing；注意**安全风险**（部分环境默认禁用）与内核版本要求。

与 [epoll](#/infra/netty) 的区别：epoll 是**就绪通知**（告诉你 fd 可读，你再自己 read），io_uring 是**完成通知**（真正的异步，内核替你把活干完）。

## 六、对应到系统设计

| 系统 | OS 层面的设计点 |
| --- | --- |
| **Kafka** | 顺序追加写 + 页缓存（不自己缓存）+ sendfile 零拷贝 + 批量与压缩；依赖多副本而非 fsync |
| **MySQL InnoDB** | Buffer Pool 自管缓存 + Direct IO（`innodb_flush_method=O_DIRECT`）避免双缓存；redo log 顺序写 + 组提交；双写缓冲防页断裂 |
| **Redis** | AOF 顺序追加 + `fsync` 策略；RDB 用 fork + COW；大 key 删除阻塞（`UNLINK` 异步释放） |
| **Elasticsearch/Lucene** | 段文件 mmap 读取、依赖页缓存（所以堆别设太大，要给页缓存留一半内存，见 [ES 实践](#/mw/es-practice)） |
| **RocketMQ** | CommitLog 顺序写 + mmap 读，`flushDiskType` ASYNC/SYNC 刷盘（见 [RocketMQ](#/mw/rocketmq)） |
| **Netty/Nginx** | epoll 多路复用 + 零拷贝（`FileRegion`/sendfile）+ 直接内存池 |
| **日志框架** | 异步写、批量刷盘；大量同步 `fsync` 会拖慢请求线程 |

## 七、排查清单

| 现象 | 排查 |
| --- | --- |
| `df` 满了但 `du` 对不上 | `lsof +L1`（已删除仍被占用的文件）；overlay 层/容器日志；inode 耗尽 `df -i` |
| 磁盘 `%util` 100%、`await` 高 | `iostat -x`，`iotop` 找进程；是否脏页集中回写、刷盘策略过激、慢盘、RAID 重建 |
| `Too many open files` | `ulimit -n`、`lsof -p`；找泄漏（socket/文件未关闭） |
| 写入周期性卡顿 | 脏页阈值过高导致集中回写；调 `vm.dirty_*`；检查 fsync 频率 |
| 容器内写大量小文件很慢 | overlayfs 写时复制；改用 volume/hostPath/emptyDir |
| 新节点启动后性能低、缓存冷 | 页缓存冷启动；预热（`vmtouch`、预读关键文件） |
| 内存看似被吃光 | 页缓存正常占用，看 `available`；`echo 1 > /proc/sys/vm/drop_caches` 仅测试用，勿在生产随意执行 |

## 相关阅读

- [案例：分布式对象存储](#/design/case-objectstore)：顺序追加、小文件合并与校验和在存储系统中的应用

## 面试追问

> [!QUESTION] write() 返回成功，数据就安全落盘了吗？
> 不是。write 只是把数据写进页缓存并标脏，由内核异步回写，机器掉电会丢失。要保证持久化需调用 fsync 或 fdatasync，或以 O_SYNC 打开。数据库通过组提交摊薄 fsync 成本，Kafka 则依赖多副本而不是单机 fsync。

> [!QUESTION] 什么是零拷贝？sendfile 相比传统读写省了什么？
> 传统读文件发网络需要磁盘到页缓存、页缓存到用户缓冲区、用户缓冲区到 socket 缓冲区、再到网卡四次拷贝和四次上下文切换。sendfile 让数据在内核内直接从页缓存送到 socket 或网卡，省去用户态参与，减少两次拷贝和两次切换。Kafka、Nginx、Netty 的文件传输都用到它。

> [!QUESTION] mmap 和 sendfile 的区别和适用场景？
> mmap 把文件映射到用户地址空间，可以在用户态读写内容，适合需要处理数据或随机访问的场景，RocketMQ、Lucene 使用；sendfile 在内核内完成转发，用户态看不到数据，适合不修改内容的纯传输，Kafka 消费使用。

> [!QUESTION] 为什么顺序写比随机写快很多？哪些系统利用了这一点？
> 机械盘随机写需要寻道，顺序写只需连续写入，SSD 也受益于大块连续写和更低的写放大。WAL、redo log、Kafka 分区日志、LSM-Tree 都把随机写转换为顺序追加以提升吞吐。

> [!QUESTION] 为什么数据库喜欢用 Direct IO？
> 数据库有自己的缓冲池和更了解访问模式的置换策略，使用页缓存会造成双重缓存浪费内存，并带来不可控的回写时机；Direct IO 绕过页缓存由数据库自行管理缓存和落盘，如 InnoDB 的 O_DIRECT。

> [!QUESTION] 磁盘显示已满但找不到大文件，怎么排查？
> 先 df -i 排除 inode 耗尽，再用 lsof +L1 查找已被删除但仍被进程打开的文件，这类文件在进程关闭句柄前空间不会释放，重启进程或截断对应 fd 即可；另外检查容器日志层、挂载点遮盖和快照。

> [!QUESTION] epoll 和 io_uring 有什么区别？
> epoll 是就绪通知，告诉你文件描述符可读写，数据拷贝仍需自己发起系统调用；io_uring 是完成通知，通过共享环形队列批量提交请求，内核真正异步完成后写入完成队列，减少系统调用与切换，并统一支持文件和网络。
