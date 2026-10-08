---
level: 深入
tags: [Redis, RDB, AOF, fork, 写时复制, Multi Part AOF, 混合持久化]
summary: RDB 快照与 AOF 日志的完整机制：fork 与写时复制、三种 fsync 策略、AOF 重写及 7.0 Multi Part AOF、混合持久化、启动加载顺序与生产配置
---

# RDB 与 AOF

> [!ABSTRACT] 核心要点
> - RDB 是某一时刻的内存快照，`BGSAVE` 通过 **fork + 写时复制（COW）** 让子进程写文件，父进程继续服务；恢复快、文件小，但两次快照之间的数据会丢。
> - AOF 记录每条写命令，`appendfsync everysec`（默认）在可靠性和性能间折中，最多丢约 1～2 秒数据；`always` 每个事件循环都在主线程 fsync，性能代价大。
> - AOF 会越写越大，需要重写（`BGREWRITEAOF`）。7.0 引入 **Multi Part AOF**：base 文件 + incr 文件 + manifest 清单，去掉了旧版的重写缓冲区和父子进程管道，消除了双写内存与主线程合并开销。
> - 生产推荐：**AOF everysec + 混合持久化（`aof-use-rdb-preamble yes`）+ 定期 RDB 备份到异地**。纯缓存实例可以关闭持久化，靠回源重建。
> - fork 是持久化最大的风险点：耗时与实例内存成正比，期间主线程阻塞；写入多时 COW 让内存接近翻倍；**透明大页（THP）会把这两个问题放大数十倍**。

## RDB

### 触发方式

| 方式 | 说明 |
| --- | --- |
| `SAVE` | 主线程直接写，期间阻塞所有请求，线上禁用 |
| `BGSAVE` | fork 子进程写，父进程继续服务 |
| `save <秒> <修改次数>` | 满足任一条件自动 BGSAVE。7.x 默认 `save 3600 1 300 100 60 10000`；`save ""` 关闭 |
| 主从全量复制 | 主库执行 BGSAVE 生成 RDB 发给从库（无盘复制则直接写 socket），见 [主从、哨兵与 Cluster](#/redis/cluster) |
| `SHUTDOWN` / `FLUSHALL` | 默认在关闭时保存一次（配置了 save 时） |

### fork 与写时复制

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="BGSAVE 写时复制：fork 只复制页表，父子进程共享物理页，父进程修改页 C 时内核复制出新页，子进程仍看到 fork 时刻的快照">
<rect class="b1" x="20" y="30" width="180" height="56" rx="8"/>
<text class="tb" x="110" y="50" text-anchor="middle" dominant-baseline="middle">父进程（主线程）</text>
<text class="ts" x="110" y="70" text-anchor="middle" dominant-baseline="middle">继续处理写命令</text>
<line class="la" x1="200" y1="58" x2="518" y2="58" marker-end="url(#arr-a)"/>
<text class="ta" x="360" y="48" text-anchor="middle">fork()：只复制页表，期间父进程阻塞</text>
<rect class="b2" x="520" y="30" width="180" height="56" rx="8"/>
<text class="tb" x="610" y="50" text-anchor="middle" dominant-baseline="middle">子进程</text>
<text class="ts" x="610" y="70" text-anchor="middle" dominant-baseline="middle">遍历内存写 temp RDB</text>
<rect class="b1" x="20" y="110" width="180" height="34" rx="6"/>
<text class="t" x="110" y="127" text-anchor="middle" dominant-baseline="middle">父进程页表</text>
<rect class="b2" x="520" y="110" width="180" height="34" rx="6"/>
<text class="t" x="610" y="127" text-anchor="middle" dominant-baseline="middle">子进程页表</text>
<rect class="b4" x="40" y="190" width="80" height="40" rx="4"/>
<text class="tm" x="80" y="210" text-anchor="middle" dominant-baseline="middle">C′</text>
<rect class="b" x="200" y="190" width="80" height="40" rx="4"/>
<text class="tm" x="240" y="210" text-anchor="middle" dominant-baseline="middle">页 A</text>
<rect class="b" x="300" y="190" width="80" height="40" rx="4"/>
<text class="tm" x="340" y="210" text-anchor="middle" dominant-baseline="middle">页 B</text>
<rect class="b" x="400" y="190" width="80" height="40" rx="4"/>
<text class="tm" x="440" y="210" text-anchor="middle" dominant-baseline="middle">页 C</text>
<line class="l" x1="90" y1="144" x2="80" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="144" x2="238" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="144" x2="336" y2="188" marker-end="url(#arr)"/>
<line class="ld" x1="590" y1="144" x2="244" y2="188" marker-end="url(#arr)"/>
<line class="ld" x1="610" y1="144" x2="344" y2="188" marker-end="url(#arr)"/>
<line class="ld" x1="630" y1="144" x2="444" y2="188" marker-end="url(#arr)"/>
<text class="ts" x="80" y="250" text-anchor="middle">父进程写 C 时复制出新页</text>
<text class="ts" x="290" y="250" text-anchor="middle">共享页（只读）</text>
<text class="ts" x="460" y="250" text-anchor="middle">子进程仍看到 fork 时刻的快照</text>
<text class="ts" x="20" y="278">写入越多 → 被复制的页越多 → 内存最多接近翻倍；fork 耗时与页表大小（即实例内存）成正比</text>
</svg>
<figcaption>图 1：BGSAVE 的 fork 与写时复制</figcaption>
</figure>

关键细节：

- **fork 期间父进程是阻塞的**。fork 要复制整张页表，物理机上通常每 GB 内存十几毫秒，虚拟机（尤其是老的 Xen）更慢。`INFO stats` 的 `latest_fork_usec` 记录最近一次耗时。
- 子进程把数据写到 `temp-<pid>.rdb`，完成后 `rename` 原子替换 `dump.rdb`，所以不会出现半个 RDB 文件。
- COW 以页为单位：父进程改一个字节，内核也要复制一整页（4KB；开启 THP 时是 2MB）。
- 有子进程时，dict 尽量不扩容（见 [数据结构与底层编码](#/redis/types)），主动减少页复制。
- RDB 内容：魔数 `REDIS` + 版本号、辅助字段（Redis 版本、创建时间、复制 ID 与 offset 等）、各 db 的 key-value（含过期时间、LRU/LFU 信息）、EOF、CRC64 校验和。

### RDB 的优缺点

- 优点：紧凑的二进制格式，适合备份和全量复制；恢复时直接加载，比重放 AOF 快得多。
- 缺点：不可能做到频繁快照（每次都是全量 fork），宕机会丢失最后一次快照之后的所有写入；**版本兼容性**：新版 RDB 不能被旧版加载（如 7.0 的 RDB 格式版本升到 10，6.x 无法读取）。

## AOF

### 写入链路与三种策略

<figure class="fig">
<svg viewBox="0 0 720 220" class="dg" role="img" aria-label="AOF 写入链路：写命令追加到 aof_buf，beforeSleep 中 write 到操作系统页缓存，再按 appendfsync 策略 fsync 到磁盘">
<rect class="b1" x="20" y="60" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="82" text-anchor="middle" dominant-baseline="middle">写命令执行</text>
<line class="l" x1="130" y1="82" x2="168" y2="82" marker-end="url(#arr)"/>
<text class="ts" x="150" y="50" text-anchor="middle">追加</text>
<rect class="b5" x="170" y="60" width="110" height="44" rx="8"/>
<text class="tm" x="225" y="82" text-anchor="middle" dominant-baseline="middle">aof_buf</text>
<line class="l" x1="280" y1="82" x2="328" y2="82" marker-end="url(#arr)"/>
<text class="ts" x="305" y="50" text-anchor="middle">beforeSleep 中 write()</text>
<rect class="b3" x="330" y="60" width="150" height="44" rx="8"/>
<text class="tb" x="405" y="82" text-anchor="middle" dominant-baseline="middle">OS 页缓存</text>
<line class="la" x1="480" y1="82" x2="538" y2="82" marker-end="url(#arr-a)"/>
<text class="ts" x="510" y="50" text-anchor="middle">按 appendfsync 策略 fsync()</text>
<rect class="b2" x="540" y="60" width="160" height="44" rx="8"/>
<text class="tb" x="620" y="82" text-anchor="middle" dominant-baseline="middle">磁盘 AOF 文件</text>
<text class="ts" x="20" y="140">always：每轮事件循环 write 后在主线程立即 fsync，回复客户端前已落盘，几乎不丢但吞吐大降</text>
<text class="ts" x="20" y="162">everysec（默认）：bio 线程每秒 fsync 一次；上次 fsync 超过 2 秒未完成时主线程推迟/阻塞 write</text>
<text class="ts" x="20" y="184">no：只 write 不 fsync，由内核决定刷盘时机（通常几十秒内），宕机丢失量不可控</text>
<text class="ts" x="20" y="206">注意：AOF 先写缓冲再回复客户端，因此 always 下「已响应即已落盘」</text>
</svg>
<figcaption>图 2：AOF 的写入链路</figcaption>
</figure>

为什么先执行命令再写 AOF（不像 MySQL 先写 redo）？Redis 不在写 AOF 前做语法检查，先执行能保证写进 AOF 的都是合法命令，也不会阻塞执行本身；代价是执行成功但还没落盘时宕机会丢失。

**everysec 下也可能阻塞主线程**：`flushAppendOnlyFile` 发现后台 fsync 还没完成，会推迟本次 write；推迟超过 2 秒就强制 write，而此时 write 可能因为磁盘繁忙被内核阻塞。日志中会出现 "Asynchronous AOF fsync is taking too long (disk is busy?)"，`INFO persistence` 的 `aof_delayed_fsync` 计数增加。这在同机多实例同时 BGSAVE/重写、或与其他高 IO 服务混布时很常见。

### AOF 重写

AOF 记录的是命令流水，对同一个 key `INCR` 一万次就有一万条。重写并不读旧 AOF，而是 **fork 子进程，把当前内存数据转成最少的命令**（或直接以 RDB 格式写出），替换旧文件。

触发条件：

- 手动 `BGREWRITEAOF`；
- 自动：AOF 大小超过 `auto-aof-rewrite-min-size`（默认 64mb）且比上次重写后增长了 `auto-aof-rewrite-percentage`（默认 100%）。

**7.0 之前的做法与问题**：重写期间父进程的新写命令要同时写入旧 AOF 的 `aof_buf` 和 `aof_rewrite_buf`，后者通过管道发给子进程，子进程结束后父进程在主线程把剩余的重写缓冲追加到新文件再 rename。问题是：

- 重写期间每条写命令在内存里存两份，写入量大时内存暴涨；
- 结束时主线程要写入剩余缓冲并 rename、关闭旧文件（关闭大文件慢，所以交给 bio 线程），可能造成明显延迟。

### 7.0 Multi Part AOF

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="Multi Part AOF：重写前 manifest 指向 1 号 base 与 incr 文件，重写后指向 2 号 base 与 incr 文件，旧文件标记为 history 异步删除">
<rect class="bg" x="20" y="40" width="320" height="160" rx="10"/>
<text class="ts" x="36" y="58">重写前 appendonlydir/</text>
<rect class="b5" x="36" y="70" width="288" height="30" rx="4"/>
<text class="tm" x="180" y="85" text-anchor="middle" dominant-baseline="middle">appendonly.aof.manifest</text>
<rect class="b1" x="36" y="110" width="288" height="30" rx="4"/>
<text class="tm" x="180" y="125" text-anchor="middle" dominant-baseline="middle">appendonly.aof.1.base.rdb</text>
<rect class="b2" x="36" y="150" width="288" height="30" rx="4"/>
<text class="tm" x="180" y="165" text-anchor="middle" dominant-baseline="middle">appendonly.aof.1.incr.aof</text>
<line class="la" x1="340" y1="125" x2="378" y2="125" marker-end="url(#arr-a)"/>
<text class="ta" x="359" y="145" text-anchor="middle">重写</text>
<rect class="bg" x="380" y="40" width="320" height="196" rx="10"/>
<text class="ts" x="396" y="58">重写完成后</text>
<rect class="b5" x="396" y="70" width="288" height="30" rx="4"/>
<text class="tm" x="540" y="85" text-anchor="middle" dominant-baseline="middle">manifest（临时文件 + rename）</text>
<rect class="b1" x="396" y="110" width="288" height="30" rx="4"/>
<text class="tm" x="540" y="125" text-anchor="middle" dominant-baseline="middle">appendonly.aof.2.base.rdb</text>
<rect class="b2" x="396" y="150" width="288" height="30" rx="4"/>
<text class="tm" x="540" y="165" text-anchor="middle" dominant-baseline="middle">appendonly.aof.2.incr.aof</text>
<rect class="b" x="396" y="190" width="288" height="30" rx="4"/>
<text class="t" x="540" y="205" text-anchor="middle" dominant-baseline="middle">1 号 base / incr → history，后台删除</text>
<text class="ts" x="20" y="226">① 重写开始：父进程立即新开 2 号 incr，</text>
<text class="ts" x="20" y="244">   之后的写命令只写它</text>
<text class="ts" x="20" y="266">② 子进程把内存快照写成新 base；完成后父进程只需更新 manifest，</text>
<text class="ts" x="20" y="284">   没有重写缓冲、没有管道、没有主线程的合并写入</text>
</svg>
<figcaption>图 3：7.0 Multi Part AOF 的文件组织与重写</figcaption>
</figure>

- `appenddirname`（默认 `appendonlydir`）下保存所有文件，`appendfilename` 只作为前缀；
- base 文件最多一个，格式由 `aof-use-rdb-preamble` 决定（`.rdb` 或 `.aof`）；incr 文件可以有多个（重写失败时会累积）；
- manifest 是文本清单，记录各文件名、序号、类型（`b` base / `i` incr / `h` history），加载时按清单顺序读取；
- 重写失败时不删除新开的 incr，下次重试；连续失败会有退避（避免无限重写）；
- 7.0 还新增 `aof-timestamp-enabled`，在 AOF 中写时间戳注释，配合 `redis-check-aof --truncate-to-timestamp` 做按时间点恢复。

> [!WARNING]
> 从 6.x 升级到 7.0 时，旧的单个 `appendonly.aof` 会在启动时被自动迁移到 `appendonlydir/` 并生成 manifest。备份脚本、监控文件大小的脚本要同步改目录。

## 混合持久化

`aof-use-rdb-preamble yes`（4.0 引入，5.0 起默认开启）：重写时 base 部分用 RDB 格式写全量数据，后续增量用 AOF 格式。兼得 RDB 的加载速度和 AOF 的数据完整性，代价是 base 部分不再是可读文本。

## 启动加载顺序

```text
appendonly yes？
 ├─ 是 → 只加载 AOF（7.0：读 manifest → base（RDB 或 AOF 格式）→ 依次重放 incr）
 │       即使存在更新的 dump.rdb 也不会加载
 └─ 否 → 加载 dump.rdb（存在的话）
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `aof-load-truncated` | yes | AOF 末尾不完整（如宕机时写了半条命令）时丢弃残缺部分继续启动；no 则拒绝启动，需 `redis-check-aof --fix` |
| `rdbchecksum` | yes | RDB 末尾写 CRC64，加载时校验，大文件会多耗约 10% 时间 |
| `stop-writes-on-bgsave-error` | yes | BGSAVE 失败后拒绝写入，防止「以为有备份其实没有」 |

> [!CAUTION] 在线开启 AOF 的坑
> 一个只开了 RDB 的实例，直接在配置文件里改 `appendonly yes` 后重启：Redis 会优先加载 AOF，而此时 AOF 不存在或为空，至少在 6.x 及更早版本会以**空数据集**启动，随后的 RDB 快照还会把旧数据覆盖掉。正确做法是先 `CONFIG SET appendonly yes`（会触发一次重写生成 AOF），确认 `aof_rewrite_in_progress` 结束后，再 `CONFIG REWRITE` 或手动改配置文件。

## fork 阻塞与大内存实例

| 问题 | 现象 | 对策 |
| --- | --- | --- |
| fork 耗时长 | BGSAVE/重写时出现百毫秒到秒级的卡顿，`latest_fork_usec` 很大 | 单实例内存控制在 10～20GB 以内，用 Cluster 横向拆分；避免老旧虚拟化平台 |
| COW 内存翻倍 | 持久化期间 rss 暴涨，被 OOM Killer 杀死 | `maxmemory` 预留 30% 以上物理内存；避开写高峰做 BGSAVE |
| fork 失败 | 日志 "Can't save in background: fork: Cannot allocate memory" | `vm.overcommit_memory = 1` |
| 同机多实例同时持久化 | 磁盘 IO 打满，AOF fsync 阻塞 | 错峰（由运维脚本控制 BGSAVE 时机），`aof_rewrite_cpulist`/`bgsave_cpulist` 绑核 |
| 子进程与主线程争 CPU | 持久化期间延迟上升 | 绑核、预留 CPU |
| 重写期间 fsync 竞争 | everysec 下主线程被阻塞 | 可设 `no-appendfsync-on-rewrite yes`：重写期间不 fsync，代价是这段时间内宕机可能丢更多数据 |

### 透明大页 THP

Linux 的 Transparent Huge Pages 会把 4KB 页合并成 2MB 大页。对 Redis 有两重伤害：

1. **COW 放大**：父进程改一个字节就要复制 2MB，写入稍多内存就迅速翻倍，复制本身也带来明显延迟；
2. **内存分配延迟**：内核做大页整理（khugepaged / 直接 compaction）时会引起不可预测的停顿。

Redis 启动时检测到 THP 为 `always` 会打印警告。处理方式：

```bash
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag    # 两条都要写入开机脚本（rc.local 或 systemd unit）
```

较新的版本（7.x）提供 `disable-thp`（默认 yes），在 THP 为 `madvise` 模式时可以只对 Redis 进程关闭；系统设为 `always` 时仍应在 OS 层关闭。

## 对比与生产配置

| 维度 | RDB | AOF（everysec） | 混合持久化 |
| --- | --- | --- | --- |
| 数据安全 | 丢失最后一次快照之后的数据（分钟级） | 最多丢约 1～2 秒 | 同 AOF |
| 文件大小 | 小（二进制、可压缩） | 大（命令文本），需要重写 | 较小 |
| 恢复速度 | 快 | 慢（重放命令） | 快（base 是 RDB） |
| 运行开销 | 周期性 fork | 持续写盘 + 周期性重写 fork | 同 AOF |
| 可读性 / 修复 | 不可读 | 可读，误操作（如 `FLUSHALL`）可在重写前删掉对应命令恢复 | base 不可读 |
| 适用 | 备份、容灾、可容忍分钟级丢失的缓存 | 要求数据较完整 | **大多数生产场景** |

7.x 推荐的持久化配置如下（redis.conf 不支持行尾注释，说明放在代码块之后）：

```properties
appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 1gb
no-appendfsync-on-rewrite no
aof-load-truncated yes
save 3600 1 300 100
stop-writes-on-bgsave-error yes
rdbcompression yes
dir /data/redis
```

- `auto-aof-rewrite-min-size` 大实例适当调大，避免频繁重写；
- `no-appendfsync-on-rewrite` 在对数据安全要求不高、延迟敏感时可改为 yes；
- 保留 `save` 是为了同时有 RDB 作为备份手段。

> [!TIP] 常见部署组合
> - **纯缓存**：关闭 AOF，`save ""` 或低频 RDB；挂了从数据库回源。
> - **主从高可用**：主库关闭持久化以减少 fork 抖动、从库开 AOF 的做法存在严重风险——主库重启后以空数据启动，从库会同步成空。主库关闭持久化时必须同时**禁止主库自动拉起**。
> - **备份**：定时把 RDB 拷贝到对象存储，并定期演练恢复。

## 生产实践与踩坑

- **误执行 FLUSHALL 怎么救**：立刻 `CONFIG SET auto-aof-rewrite-percentage 1000` 之类阻止自动重写（重写会把空数据集写成新 base），然后停机，编辑 AOF（7.0 为最新的 incr 文件）删除末尾的 `FLUSHALL`，再启动。纯 RDB 实例只能用最近的备份。
- **RDB 文件突然变小**：检查是否有人执行了 `FLUSHDB`、或大量 key 过期；监控 `rdb_last_bgsave_status`、`aof_last_bgrewrite_status`。
- **磁盘写满**：AOF 无法写入时，Redis 会对写命令返回错误；重写失败会累积 incr 文件。磁盘监控要包含 `appendonlydir`。
- **容器环境**：容器内存限制（cgroup）不感知 COW 的共享页，持久化期间更容易被 OOM；`overcommit_memory` 和 THP 是宿主机级参数，需要在节点上配置。
- **持久化相关的监控项**：`rdb_last_bgsave_status`、`rdb_changes_since_last_save`、`aof_last_write_status`、`aof_delayed_fsync`、`latest_fork_usec`、`mem_fragmentation_ratio`。

## 面试追问

> [!QUESTION] BGSAVE 期间父进程还在写，子进程生成的 RDB 是哪个时刻的数据？
> fork 时刻的快照。fork 后父子进程共享物理页，父进程修改某页时内核复制出新页给父进程，子进程看到的始终是旧页，因此 RDB 是一致的时点快照。

> [!QUESTION] appendfsync everysec 一定最多只丢 1 秒吗？
> 不一定。fsync 由后台线程每秒执行，如果磁盘慢导致 fsync 超过 2 秒未完成，主线程才会强制 write（并可能被阻塞），因此极端情况下丢失量约 2 秒；而且已 write 但未 fsync 的数据在操作系统崩溃时也会丢。进程崩溃（非 OS 崩溃）时，只要 write 到页缓存就不会丢。

> [!QUESTION] AOF 重写时新写入的命令怎么处理？7.0 有什么改进？
> 7.0 前：同时写旧 AOF 和重写缓冲，缓冲通过管道发给子进程，结束时由主线程把剩余部分追加到新文件，内存双份且主线程有额外开销。7.0 Multi Part AOF：重写开始时直接新开一个 incr 文件接收新命令，子进程只负责生成 base，完成后更新 manifest 即可，不再需要重写缓冲。

> [!QUESTION] 为什么大内存 Redis 实例不推荐？
> fork 耗时与内存成正比，期间主线程阻塞；COW 可能让内存翻倍；全量复制要传输和加载巨大的 RDB，恢复时间长，复制缓冲容易溢出导致复制风暴。所以单实例通常控制在 10～20GB 内，通过 Cluster 横向扩展。

> [!QUESTION] 同时开启 RDB 和 AOF，重启时加载哪个？
> 优先加载 AOF，因为它数据更完整；只有 `appendonly no` 时才加载 RDB。这也是「直接改配置开启 AOF 后重启导致数据丢失」的根源。
