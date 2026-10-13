---
level: 深入
tags: [Redis, 故障排查, 延迟, slowlog, LATENCY, 连接, 复制, 持久化, OOM, 安全加固, ACL, 应急预案]
summary: Redis 线上故障排查与安全加固手册：按症状（延迟突刺、超时、内存暴涨/OOM、连接异常、复制与主从切换问题、持久化失败、数据丢失）的排查路径与工具（INFO、SLOWLOG、LATENCY、CLIENT LIST、系统层观测），延迟来源地图，应急止血与预案，以及网络隔离、认证、ACL、危险命令与配置的安全加固清单。
---

# Redis 故障排查与安全加固

> [!ABSTRACT] 核心要点
> - 排查要**按症状走固定路径**，而不是凭感觉重启：**确认影响范围（单实例/单分片/全部）→ 看趋势与起始时间 → 关联变更 → 用 Redis 自带工具与系统工具定位 → 先止血再根因**。
> - 绝大多数“Redis 变慢”不是 Redis 本身慢，而是**主线程被阻塞**：**慢命令/大 key、持久化 fork、AOF fsync 与磁盘、内存换页（swap）、过期/淘汰集中、网络与连接风暴、CPU 争用**。用 `SLOWLOG`、`LATENCY`、`INFO` 的 fork/AOF 指标即可对号入座。
> - **工具链**：`INFO` 全家桶、`SLOWLOG GET`、`LATENCY DOCTOR/HISTORY`、`redis-cli --latency/--intrinsic-latency`、`CLIENT LIST`、`MEMORY` 命令，加上系统层的 `top/iostat/vmstat/ss/sar`；**`MONITOR`、`KEYS *`、对大 key 的 `DEBUG` 类命令在线上要极度克制**。
> - **复制与持久化**问题多由**配置边界**触发：`repl-backlog-size` 过小造成反复全量同步、`client-output-buffer-limit` 掐断副本、磁盘满导致 bgsave 失败并拒写（`stop-writes-on-bgsave-error`）。
> - **安全**是另一半：**不暴露公网、必须认证（ACL）、最小权限、禁用/限制危险命令（`CONFIG`、`FLUSHALL`、`MODULE`、`SLAVEOF`）、TLS、审计与备份加密**。历史上大量 Redis 事故和入侵源于“无密码 + 暴露公网”。
> - **应急预案**要提前写好：限流降级保护数据库、切换副本、扩容/限流、禁用危险操作；并通过演练验证，见 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)。

## 排查方法与工具

### 总流程

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Redis 故障排查流程：先确认症状和影响范围，再看监控趋势与起始时间，关联发布配置和流量变化，使用 INFO、SLOWLOG、LATENCY 与系统工具定位根因，先止血再修复，最后复盘并补充监控与告警；按症状分类为延迟超时、内存、连接、复制、持久化、数据异常">
<rect class="b3" x="20" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">① 确认症状</text>
<text class="ts" x="80" y="74" text-anchor="middle">范围·起始·量级</text>
<rect class="b5" x="155" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="215" y="52" text-anchor="middle" dominant-baseline="middle">② 看趋势</text>
<text class="ts" x="215" y="74" text-anchor="middle">哪个指标先变</text>
<rect class="b1" x="290" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="350" y="52" text-anchor="middle" dominant-baseline="middle">③ 找变更</text>
<text class="ts" x="350" y="74" text-anchor="middle">发布·流量·配置</text>
<rect class="b4" x="425" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="500" y="52" text-anchor="middle" dominant-baseline="middle">④ 工具定位</text>
<text class="ts" x="500" y="74" text-anchor="middle">INFO·SLOWLOG·系统</text>
<rect class="b2" x="590" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="665" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 止血→根因</text>
<text class="ts" x="665" y="74" text-anchor="middle">降级·切换·修复</text>
<line class="l" x1="140" y1="62" x2="155" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="275" y1="62" x2="290" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="62" x2="425" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="575" y1="62" x2="590" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="114" width="720" height="206" rx="8"/>
<text class="th" x="32" y="134">症状 → 首查位置</text>
<text class="ts" x="380" y="160" text-anchor="middle">延迟升高/客户端超时 → SLOWLOG、LATENCY、fork 耗时、AOF fsync、磁盘/网络、CPU、swap、大 key 与热 key</text>
<text class="ts" x="380" y="182" text-anchor="middle">内存暴涨/OOM → used_memory 构成、客户端缓冲、复制缓冲、COW、碎片、无 TTL/无界增长、大 key</text>
<text class="ts" x="380" y="204" text-anchor="middle">连接异常（拒绝/耗尽/超时）→ connected_clients、maxclients、CLIENT LIST、TIME_WAIT、连接池泄漏、重连风暴</text>
<text class="ts" x="380" y="226" text-anchor="middle">主从切换频繁/复制延迟 → 复制偏移、repl-backlog、output buffer、全量同步次数、网络、阻塞导致心跳超时</text>
<text class="ts" x="380" y="248" text-anchor="middle">持久化失败/重启慢 → bgsave 状态、磁盘空间/IO、AOF 完整性、THP、加载耗时</text>
<text class="ts" x="380" y="270" text-anchor="middle">数据“丢了/错了” → 过期与淘汰、主从切换丢写、误删、客户端序列化、读副本旧数据、多库/集群路由</text>
<text class="ta" x="380" y="298" text-anchor="middle">每一类先用“指标证据”确认，再动手；记录时间线，便于复盘</text>
</svg>
<figcaption>图 1：排查总流程与症状首查位置</figcaption>
</figure>

### 工具箱

| 工具 | 用途 | 注意 |
| --- | --- | --- |
| **`INFO [section]`** | 全景指标：`server`、`clients`、`memory`、`persistence`、`stats`、`replication`、`cpu`、`commandstats`、`latencystats`、`keyspace` | 排障的第一站；保存快照做前后对比 |
| **`INFO commandstats`** | 每个命令的调用次数、总耗时、平均耗时 | 找“谁占用了 CPU 时间”（如大量 `HGETALL`、`ZRANGE`） |
| **`SLOWLOG GET n`** | 执行时间超过阈值（`slowlog-log-slower-than`，默认 10ms）的命令；**不含排队等待与网络时间** | 阈值可调小（如 1~5ms）；定期导出保留 |
| **`LATENCY DOCTOR` / `LATENCY LATEST` / `LATENCY HISTORY`** | 延迟事件监控（需 `latency-monitor-threshold`，如 100ms）：fork、AOF fsync、过期、命令等事件的尖刺 | 回答“**什么时候、因为什么**慢了”，有人工可读建议 |
| **`redis-cli --latency` / `--latency-history`** | 实测客户端到服务端的往返延迟 | 区分网络与服务端问题 |
| **`redis-cli --intrinsic-latency N`** | 在**运行 redis-cli 的机器**上测系统本身的固有延迟（虚拟化/CPU 争抢） | 在服务器本机运行，若固有延迟就高，则 Redis 无能为力 |
| **`CLIENT LIST` / `CLIENT INFO`** | 连接来源、状态、空闲时间、输入输出缓冲、当前命令 | 找连接泄漏、慢客户端、异常来源 |
| **`MEMORY STATS/DOCTOR/USAGE`** | 内存分项与单 key 占用 | 见 [内存优化与容量治理](#/redis/memory) |
| **`MONITOR`** | 实时输出所有命令 | **严重拖慢实例，仅在副本/低流量短时使用** |
| **`DEBUG SLEEP/OBJECT` 等** | 调试用 | 生产禁用；`DEBUG` 命令可能阻塞或崩溃 |
| **系统工具** | `top/htop`（CPU）、`vmstat/free`（内存与 swap）、`iostat/pidstat -d`（磁盘）、`ss/netstat/sar -n`（网络）、`dmesg`（OOM Killer）、`strace/perf`（深度） | 见 [Linux 线上排查](#/infra/linux)、[TCP/IP 与 HTTP(S)](#/infra/network) |
| **客户端与应用侧** | 客户端超时、重试、连接池指标、trace | Redis 慢还是应用慢，要看两端数据 |

## 延迟与超时

### 延迟来源地图

Redis 命令执行是**单线程**，任何占用主线程或拖慢系统的因素都会放大为所有请求的延迟。

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="延迟来源地图：主线程被占用（慢命令、大 key、Lua 脚本、集中过期与淘汰）、系统与硬件（fork 与 COW、THP、swap、CPU 争抢与容器限额、磁盘 fsync、网络丢包与带宽）、复制与持久化（全量同步、AOF 重写）、客户端与连接（连接风暴、重试放大、慢客户端输出缓冲）；每类给出判断依据">
<rect class="b4" x="20" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">A. 主线程被占用</text>
<text class="ts" x="195" y="62" text-anchor="middle">O(N) 慢命令：KEYS、HGETALL、SMEMBERS、大 ZRANGE</text>
<text class="ts" x="195" y="84" text-anchor="middle">大 key 的读写、DEL、过期、序列化</text>
<text class="ts" x="195" y="106" text-anchor="middle">长耗时 Lua/事务</text>
<text class="ts" x="195" y="128" text-anchor="middle">大量 key 同时过期或批量淘汰</text>
<text class="ta" x="195" y="152" text-anchor="middle">证据：SLOWLOG、commandstats、LATENCY</text>
<rect class="b3" x="390" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">B. 系统与硬件</text>
<text class="ts" x="565" y="62" text-anchor="middle">fork 慢（内存大、THP 开启、虚拟化）</text>
<text class="ts" x="565" y="84" text-anchor="middle">swap：内存被换出，访问变成磁盘 IO</text>
<text class="ts" x="565" y="106" text-anchor="middle">CPU 争抢/容器限额节流（CFS throttling）</text>
<text class="ts" x="565" y="128" text-anchor="middle">磁盘慢导致 AOF fsync 阻塞</text>
<text class="ta" x="565" y="152" text-anchor="middle">证据：fork 耗时、vmstat、iostat、LATENCY</text>
<rect class="b5" x="20" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="200" text-anchor="middle" dominant-baseline="middle">C. 复制与持久化</text>
<text class="ts" x="195" y="228" text-anchor="middle">全量同步：主节点 fork + 传输 RDB + 缓冲</text>
<text class="ts" x="195" y="250" text-anchor="middle">AOF 重写与 RDB 同时进行，IO 与内存压力叠加</text>
<text class="ts" x="195" y="272" text-anchor="middle">副本过多/复制带宽不足</text>
<text class="ts" x="195" y="294" text-anchor="middle">main 线程 AOF 写入阻塞（fsync always/磁盘忙）</text>
<text class="ta" x="195" y="318" text-anchor="middle">证据：INFO persistence/replication、sync_full 次数</text>
<rect class="b2" x="390" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="200" text-anchor="middle" dominant-baseline="middle">D. 网络与客户端</text>
<text class="ts" x="565" y="228" text-anchor="middle">网络抖动/丢包/带宽打满（大 value、热 key）</text>
<text class="ts" x="565" y="250" text-anchor="middle">连接风暴：重连、连接池失控、短连接</text>
<text class="ts" x="565" y="272" text-anchor="middle">超时重试放大流量，形成雪崩</text>
<text class="ts" x="565" y="294" text-anchor="middle">慢客户端造成输出缓冲堆积</text>
<text class="ta" x="565" y="318" text-anchor="middle">证据：--latency、sar -n、CLIENT LIST、客户端日志</text>
</svg>
<figcaption>图 2：Redis 延迟的四大来源与判断证据</figcaption>
</figure>

### 逐项排查

| 来源 | 判断与处理 |
| --- | --- |
| **慢命令** | `SLOWLOG GET` 看是否有 O(N) 命令；`INFO commandstats` 看平均耗时高的命令。处理：禁用 `KEYS`，用 `SCAN`；`HGETALL/SMEMBERS` 改分页/`HSCAN`；拆大 key；ZRANGE 限制范围；Lua 脚本控制耗时 |
| **大 key** | 慢日志里单 key 操作耗时长；见 [大 key 与热 key 治理](#/redis/bigkey)。删除用 `UNLINK` |
| **fork 延迟** | `INFO` 的 `latest_fork_usec`；内存越大 fork 越慢（页表复制）；关闭 THP、使用物理机/较新虚拟化、控制实例内存、**在副本上做持久化**；见 [RDB 与 AOF](#/redis/persistence) |
| **AOF fsync** | `LATENCY` 出现 `aof-fsync-always`/`aof-write` 事件；`appendfsync everysec` 的后台 fsync 若磁盘忙，主线程写入也可能被阻塞（`aof_delayed_fsync` 计数）；处理：独立 SSD、避免 AOF 重写与其他 IO 争用、`no-appendfsync-on-rewrite` 的取舍 |
| **swap** | `vmstat` 的 `si/so` 非零、`INFO` 碎片率 < 1；处理：关闭 swap 或减少内存压力，预留内存，避免与其他进程混部 |
| **CPU 争抢与容器限额** | 容器 `cpu.cfs_throttled`、宿主机负载高；Redis 主线程需要稳定的 CPU，容器里**不要用过紧的 CPU 限额**，必要时绑核；`--intrinsic-latency` 看固有延迟 |
| **过期与淘汰集中** | `LATENCY` 出现 `expire-cycle` 事件，`expired_keys`、`evicted_keys` 突增；处理：TTL 加抖动，开启 lazyfree，扩容 |
| **网络** | `redis-cli --latency` 对比本机与跨机延迟；`sar -n`/网卡出入带宽、丢包重传；处理：带宽、热 key/大 key、就近部署 |
| **全量同步** | 副本重连触发全量，主节点 fork 并生成 RDB；`sync_full` 增加；处理：调大 `repl-backlog-size`，避免副本频繁断开 |
| **客户端问题** | 连接数突增、重试风暴；`CLIENT LIST` 看来源与命令；处理：连接池上限、退避重试、熔断，见 [熔断限流实战](#/spring/cloud-resilience) |

### 客户端超时的两面性

客户端“超时”**不一定是 Redis 慢**：可能是连接池耗尽（拿不到连接）、网络抖动、客户端 GC、线程池排队、DNS 或负载均衡问题。排查要同时看：

- **客户端侧**：连接池等待时间、命令发送到响应的耗时、GC 暂停、线程池排队；
- **服务端侧**：慢日志（只含命令执行时间）、`latencystats`、CPU；
- 如果服务端慢日志干净而客户端超时严重，重点怀疑**网络、连接池、客户端自身**；
- **超时设置**：连接超时与命令超时分开（连接几百毫秒，命令按业务 SLA），避免超时过长拖垮线程；重试要有上限与退避，见 [OpenFeign 深入](#/spring/cloud-feign) 的超时预算思想。

## 内存问题与 OOM

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| **内存持续上涨** | 内存画像（前缀、TTL 覆盖、大 key）、`INFO memory` 各分项 | TTL 治理、清理僵尸、拆大 key、扩容，见 [内存优化与容量治理](#/redis/memory) |
| **达到 `maxmemory` 后写入报错 `OOM command not allowed`** | 策略为 `noeviction` 或 `volatile-*` 且无可淘汰 key | 紧急：清理/扩容/临时调高 maxmemory（谨慎）；根治：容量规划与告警，缓存场景改 `allkeys-*` |
| **进程被系统 OOM Killer 杀死** | `dmesg` 看 OOM 记录；fork COW、客户端缓冲、复制缓冲叠加 | 预留内存、限制客户端缓冲（`client-output-buffer-limit`）、避免同机混部、控制写入峰值、副本做持久化 |
| **客户端输出缓冲暴涨** | `CLIENT LIST` 看 `omem`；订阅者慢、`MONITOR` 开着、大 key 读取 | 设置缓冲上限，修复慢消费者，避免长期 `MONITOR` |
| **复制缓冲暴涨** | 副本落后/重连；写入大量 | 调整 backlog 与缓冲限制，修复副本网络 |
| **碎片导致 RSS 过高** | 碎片率高 | 主动碎片整理、副本切换重启 |
| **删除后内存不降** | 分配器不归还 | 同上 |

## 连接问题

| 现象 | 根因与排查 | 处理 |
| --- | --- | --- |
| **`max number of clients reached`** | `connected_clients` 达到 `maxclients`（受系统文件描述符限制） | 找到来源（`CLIENT LIST` 按 `addr`/`name` 聚合），修复连接泄漏；调大 `maxclients` 与 `ulimit -n`；客户端连接池上限；使用代理收敛连接 |
| **大量 TIME_WAIT/短连接** | 客户端每次请求新建连接 | 使用连接池与长连接，Pipeline |
| **连接数周期性飙升** | 应用重启、拓扑刷新、重连风暴 | 客户端重连带退避与抖动，错峰发布 |
| **连接突然被断开** | `timeout`（空闲超时）、`client-output-buffer-limit`、网络设备空闲超时、服务端重启/主从切换 | 客户端心跳/保活（`tcp-keepalive`），处理断连重试；留意 LB/NAT 的空闲超时 |
| **客户端报 `connection reset`/`broken pipe`** | 服务端关闭了连接（缓冲超限、超时、重启） | 查服务端日志与缓冲配置，客户端自动重连 |
| **Cluster 下大量 MOVED** | 拓扑变化客户端未刷新 | 开启自动拓扑刷新，见 [主从、哨兵与 Cluster](#/redis/cluster) |
| **阻塞命令占用连接** | `BLPOP`/`XREAD BLOCK` 的客户端过多 | 专用连接/池，限制并发 |

## 复制、哨兵与主从切换问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| **副本反复全量同步** | `repl-backlog-size` 小于断线期间的写入量；副本落后太多；网络反复断开 | 调大 backlog（按写入速率 × 预期断线时间估算），修复网络，减少副本断开 |
| **副本因输出缓冲被主节点断开** | 全量同步时写入量大，`client-output-buffer-limit replica` 触发 | 适当调大，错峰同步，控制写入 |
| **复制延迟增大** | 主节点写入压力、副本执行慢（大 key/慢命令）、网络带宽 | 看 `master_repl_offset` 与副本偏移差；治理慢命令；增大带宽 |
| **主从切换频繁（哨兵/Cluster）** | 主节点阻塞（大 key/fork/慢命令）超过 `down-after-milliseconds`/`cluster-node-timeout`；网络抖动 | 治理阻塞；合理设置超时；检查网络；监控 failover 次数 |
| **切换后丢数据** | 异步复制，旧主的最近写未同步 | `min-replicas-to-write`、业务幂等与对账，见 [主从、哨兵与 Cluster](#/redis/cluster) 的脑裂章节 |
| **脑裂（旧主恢复后双主）** | 网络分区 | 限制孤立主写入，客户端用哨兵/集群感知，恢复后数据对账 |
| **客户端没感知到切换** | 缓存了旧地址、DNS 缓存、拓扑未刷新 | 客户端使用哨兵/集群发现，缩短 DNS TTL |
| **读副本读到旧数据** | 复制延迟 | 业务容忍度评估，关键读走主，或读后校验 |

## 持久化问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| **`MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist`，写入被拒绝** | bgsave 失败（磁盘满、权限、fork 失败）且 `stop-writes-on-bgsave-error yes` | 先处理根因（释放磁盘、修复权限、解决 fork 内存），再恢复；不要轻易把该选项设为 no 掩盖问题，除非接受丢数据 |
| **fork 失败 `Cannot allocate memory`** | `vm.overcommit_memory` 不是 1 或内存不足 | 设置 `overcommit_memory=1`，预留内存 |
| **AOF 文件损坏/截断，重启失败** | 异常断电或磁盘问题 | 用 `redis-check-aof` 检查修复（会丢弃损坏部分），了解可能丢失的数据，优先用副本数据 |
| **AOF 重写频繁/持续增长** | 阈值设置不当、写入量大 | 调整 `auto-aof-rewrite-percentage/min-size`，监控重写耗时；见 [RDB 与 AOF](#/redis/persistence) |
| **重启加载很慢** | 数据量大、AOF 过大 | 使用混合持久化（RDB 前缀 + AOF 增量）、控制单实例规模、用副本接管后再重启 |
| **磁盘 IO 打满影响延迟** | RDB/AOF 与业务争用磁盘 | 独立磁盘、限制重写 IO、在副本上持久化 |
| **备份不可用** | 从未演练恢复 | 定期恢复演练，校验 RDB 与 AOF |

## 数据异常：“数据丢了”的排查

| 可能原因 | 如何确认 |
| --- | --- |
| **过期** | key 带 TTL，`TTL`/业务写入逻辑；`expired_keys` 统计；业务是否误设了短 TTL |
| **被淘汰** | `evicted_keys` 增长，`maxmemory-policy`；缓存场景属于正常，存储场景是配置错误 |
| **主从切换丢写** | 切换时间点附近的写入丢失；复制偏移差；`min-replicas-to-write` |
| **误操作（FLUSHALL/DEL）** | 审计日志、命令统计、ACL 记录；是否有人/脚本执行了危险命令 |
| **客户端路由错误** | 写入了错误的库（`SELECT`）、集群的槽/hash tag、读副本导致读旧值 |
| **序列化不一致** | 新旧版本反序列化失败被当成不存在（缓存穿透到 DB 而不是真的丢了） |
| **多环境混用** | 测试环境连到了生产，或反之 |
| **数据本身未写入** | 写入失败被吞异常；管道/事务中的错误；超时但已写入（结果未知） |

**防护**：关键数据不要只放缓存；写入失败要有日志与告警；开启审计，禁用危险命令；重要变更前备份。

## 应急止血手册

| 场景 | 止血动作 | 注意 |
| --- | --- | --- |
| **Redis 变慢，应用被拖垮** | 对依赖 Redis 的接口**限流/降级**（返回缓存的静态内容、降级功能），保护应用线程池与数据库；熔断 Redis 调用 | 避免“缓存失效 → 请求打到 DB → DB 崩溃”的连锁，见 [缓存设计与一致性](#/redis/cache) |
| **单分片过载（热 key/大 key）** | 对热点 key 临时启用本地缓存；限流；封禁异常调用方；对大 key 暂停相关功能 | 先止血，后治理 |
| **主节点阻塞/不可用** | 确认副本数据新鲜后**手动故障转移**；暂停写入入口 | 小心数据丢失窗口 |
| **内存将满** | 紧急清理无用 key（限速 `UNLINK`）、缩短 TTL、临时扩容或迁移部分数据；缓存场景可 `FLUSH` 特定前缀（评估回源压力） | 不要在高峰对全库 `FLUSHALL` |
| **连接耗尽** | 找出并重启泄漏的应用实例；临时调大 `maxclients`；限流 | 先定位来源 |
| **副本全量同步风暴** | 暂停重启副本，逐个恢复；调大 backlog 与缓冲限制 | 一次一个副本 |
| **疑似安全入侵** | 隔离网络、修改密码、检查 `CONFIG`/`DIR`/`MODULE`/持久化目录与定时任务、审计登录；从可信备份恢复 | 保留证据；评估数据泄露范围 |

预案必须**提前写成 Runbook，并演练**；变更窗口与应急操作都要有审批与记录。

## 安全加固

### 威胁模型

Redis 默认设计为**在受信任的内网使用**，早期版本默认无认证。常见攻击：

- **暴露公网且无密码**：任何人可读写数据、`FLUSHALL`；
- **通过 `CONFIG SET dir/dbfilename` + `SAVE` 写入任意文件**（如 SSH 公钥、定时任务）实现远程执行；
- **主从复制/模块加载滥用**（`SLAVEOF` 指向恶意主节点加载恶意模块）；
- **弱密码/密码泄露、明文传输被嗅探**；
- **危险命令误用**（运维或程序 bug）；
- **容器/云上配置错误**（安全组 0.0.0.0/0、端口映射到公网）。

### 加固清单

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Redis 安全加固分层：网络层只内网访问并用防火墙或安全组限制来源；认证层启用 ACL 与强密码；传输层启用 TLS；命令层最小权限并禁用危险命令；系统层非 root 运行、限制文件权限；审计层记录登录与高危命令；数据层备份加密与敏感数据不明文存放">
<rect class="b3" x="20" y="14" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="34" dominant-baseline="middle">网络层</text>
<text class="ts" x="140" y="34" dominant-baseline="middle">只绑定内网地址；安全组/防火墙白名单；不暴露公网；保护模式开启；集群总线端口仅节点间互通</text>
<rect class="b5" x="20" y="62" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="82" dominant-baseline="middle">认证层</text>
<text class="ts" x="140" y="82" dominant-baseline="middle">必须认证；使用 ACL 给不同应用分配独立用户与强密码；密码放密钥管理系统并定期轮换</text>
<rect class="b1" x="20" y="110" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="130" dominant-baseline="middle">传输层</text>
<text class="ts" x="140" y="130" dominant-baseline="middle">跨主机/跨网络启用 TLS（客户端、复制、集群总线）；校验证书；证书自动轮换</text>
<rect class="b4" x="20" y="158" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="178" dominant-baseline="middle">命令层</text>
<text class="ts" x="140" y="178" dominant-baseline="middle">ACL 最小权限（命令类别与 key 前缀）；禁用 FLUSHALL、CONFIG、DEBUG、MODULE、SLAVEOF</text>
<rect class="b2" x="20" y="206" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="226" dominant-baseline="middle">系统层</text>
<text class="ts" x="140" y="226" dominant-baseline="middle">非 root 专用用户运行；数据目录与配置文件权限最小；容器非特权、只读根文件系统、资源限制</text>
<rect class="b3" x="20" y="254" width="720" height="40" rx="8"/>
<text class="tb" x="40" y="274" dominant-baseline="middle">审计与数据</text>
<text class="ts" x="140" y="274" dominant-baseline="middle">记录认证失败与高危命令；备份加密与访问控制；敏感数据脱敏/加密后再存；定期安全扫描</text>
<text class="ta" x="380" y="312" text-anchor="middle">纵深防御：任何一层被突破，其余层仍能限制损失</text>
</svg>
<figcaption>图 3：Redis 安全加固的分层措施</figcaption>
</figure>

### ACL 示例与危险命令

Redis 6.0+ 的 **ACL** 可以按用户限制**命令、key 模式、通道**：

```text
# 给订单服务一个只能访问 order:* 前缀、禁止危险命令的用户（示意，具体语法以所用版本为准）
ACL SETUSER order-svc on >强密码 ~order:* &* +@read +@write +@string +@hash +@list -@dangerous

# 只读监控用户
ACL SETUSER monitor on >另一个强密码 ~* +info +ping +slowlog|get +latency|latest -@all

# 禁用默认无密码用户
ACL SETUSER default off
```

| 手段 | 说明 |
| --- | --- |
| **按应用分账号** | 一个应用一个用户，权限与 key 前缀隔离，便于审计与回收 |
| **`-@dangerous`、`-@admin`** | 禁止命令类别（`FLUSHALL`、`CONFIG`、`DEBUG`、`KEYS` 等多在其中） |
| **命令重命名/禁用** | 旧方式 `rename-command`，ACL 出现后优先用 ACL；云托管 Redis 通常已限制 |
| **`protected-mode yes` + `bind`** | 未配置认证/绑定时拒绝外部连接，是**最后一道保险**，不能作为唯一防护 |
| **`CONFIG` 限制** | 禁止业务账号修改配置（防止写任意文件） |
| **`enable-protected-configs`、`enable-debug-command`、`enable-module-command`**（7.0+） | 默认禁止危险配置与命令，保持默认 |
| **TLS** | `tls-port`、证书与 CA；复制与集群总线也要 TLS |
| **密码管理** | 不写入代码仓库/镜像/日志；由密钥系统注入；定期轮换，见 [加密与密钥管理](#/security/crypto) |
| **Lua 脚本** | 脚本也受 ACL 约束；避免执行不可信脚本；限制 `EVAL` 权限 |

### 云与容器环境

- 云上 Redis 优先使用**托管服务的私网接入 + 白名单 + 账号体系**，不要开放公网；
- Kubernetes：不要用 `hostNetwork`/NodePort 暴露 Redis；用 NetworkPolicy 限制访问来源；Secret 管理密码；
- 备份文件（RDB/AOF）包含**全部数据明文**，要加密存储并控制访问；
- 定期做安全巡检：端口扫描、弱密码检查、版本漏洞（关注官方安全公告并及时升级）。

## 排查与加固检查清单

- [ ] 是否有 Redis 值班手册（症状→排查→止血→升级路径）并演练过？
- [ ] 慢日志阈值、延迟监控（`latency-monitor-threshold`）是否开启，并持久化保存？
- [ ] 是否监控 fork 耗时、AOF 延迟 fsync、复制偏移、连接数、碎片率、慢日志数量？
- [ ] `repl-backlog-size`、`client-output-buffer-limit`、`maxclients`、`timeout`、`tcp-keepalive` 是否按负载设置？
- [ ] 是否关闭 THP、禁用 swap、设置 `overcommit_memory=1`，容器 CPU 限额是否合理？
- [ ] 危险命令是否禁用或受 ACL 限制，业务账号是否最小权限？
- [ ] Redis 是否仅内网访问、需要认证、跨网络启用 TLS？
- [ ] 备份是否加密、是否定期演练恢复？
- [ ] 应用侧是否有 Redis 故障时的限流、降级、熔断与回源保护？

## 相关阅读

- [线程模型与高性能原理](#/redis/overview)：单线程模型与慢命令阻塞
- [RDB 与 AOF](#/redis/persistence)：fork、AOF 与 THP
- [主从、哨兵与 Cluster](#/redis/cluster)：复制、故障转移与脑裂
- [Redis Cluster 生产运维](#/redis/cluster-ops)：集群层面的运维与故障
- [Linux 线上排查](#/infra/linux)：系统层面的 CPU、内存、IO、网络排查
- [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)：安全体系背景

## 面试追问

> [!QUESTION] Redis 突然变慢，你怎么排查？
> 先确认范围和起始时间，关联发布与流量变化。服务端看 SLOWLOG 与 commandstats 找慢命令和大 key，LATENCY 看 fork、AOF fsync、过期等事件，INFO 看 fork 耗时、内存、连接、复制；系统层看 CPU、swap、磁盘 IO 与网络；同时对比客户端侧的连接池、GC 与网络。常见根因是主线程被慢命令或大 key 占住、fork 过慢、swap、磁盘 fsync 或网络问题。

> [!QUESTION] 客户端超时一定是 Redis 慢吗？
> 不一定。可能是连接池耗尽拿不到连接、客户端 GC、线程池排队、网络抖动或重试放大。如果服务端慢日志干净而客户端超时严重，应重点看网络、连接池和客户端自身；慢日志只统计命令执行时间，不含排队和网络时间。

> [!QUESTION] 主从为什么会反复全量同步？
> 常见原因是 repl-backlog-size 小于副本断线期间主节点的写入量，副本重连时无法增量同步，只能全量；还有副本落后太多、网络反复断开、输出缓冲超限被主节点断开。应按写入速率乘预期断线时间调大 backlog，修复网络并避免副本频繁重启。

> [!QUESTION] 写入报 MISCONF 错误是什么意思？
> 开启了 RDB 且最近一次 bgsave 失败，同时 stop-writes-on-bgsave-error 为 yes，Redis 为保护数据一致性拒绝写入。要先排查 bgsave 失败原因，如磁盘满、权限、fork 内存不足，修复后恢复；不要简单关闭该选项来掩盖问题。

> [!QUESTION] 怎么加固 Redis 的安全？
> 只绑定内网并用安全组限制来源、不暴露公网；必须认证并用 ACL 给每个应用独立账号做最小权限，禁用危险命令如 FLUSHALL、CONFIG、DEBUG、MODULE；跨网络启用 TLS；非 root 运行、限制文件权限；记录审计；备份加密；密码由密钥系统管理并轮换。历史上大量入侵源于无密码加公网暴露，再通过 CONFIG 写文件实现远程执行。

> [!QUESTION] Redis 出问题时，应用侧应该有哪些保护？
> 对依赖 Redis 的接口做限流与降级，给 Redis 调用设置合理的超时、有限重试和熔断，避免连接池和线程池被拖垮；防止缓存失效或 Redis 不可用时请求全部打到数据库，需有回源保护（互斥、限流、降级）；关键数据不要只存缓存，并对写入失败有日志与告警。
