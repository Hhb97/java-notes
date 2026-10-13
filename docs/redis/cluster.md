---
level: 深入
tags: [Redis, 主从复制, PSYNC, 哨兵, Redis Cluster, 槽, Gossip, 脑裂, Lettuce]
summary: 主从复制的全量与增量同步、哨兵的下线判定与故障转移、Cluster 的槽分片、重定向、Gossip 与故障转移，以及脑裂与客户端拓扑刷新等生产问题
---

# 主从、哨兵与 Cluster

> [!ABSTRACT] 核心要点
> - 主从复制是**异步**的：首次连接走全量同步（RDB + 期间写命令的缓冲），断线重连时若 `replid` 一致且 offset 仍在 `repl_backlog` 范围内，只补差量（`+CONTINUE`）。4.0 的 PSYNC2 让主从切换、从库重启后也能增量同步。
> - 哨兵解决「自动故障转移」：单个哨兵判定**主观下线**，达到 quorum 判定**客观下线**，再选出 Leader 哨兵（需过半票），按「优先级 → 复制 offset → runid」选新主。
> - Cluster 用 16384 个槽做分片，`slot = CRC16(key) & 16383`；节点间用 Gossip 交换状态；客户端缓存槽映射，收到 `MOVED` 更新映射，收到 `ASK` 只做一次临时跳转。
> - 多 key 命令、事务、Lua 要求 key 在同一个槽，用 hash tag `{}` 解决；hash tag 用不好会造成数据和流量倾斜。
> - 异步复制注定可能丢数据和脑裂，`min-replicas-to-write` 只能缩小窗口；Lettuce 默认不会自适应刷新集群拓扑，故障转移后可能持续报错，必须显式打开。

## 主从复制

### 建立连接与全量同步

<figure class="fig">
<svg viewBox="0 0 720 350" class="dg" role="img" aria-label="全量同步时序：从库发送 PSYNC，主库回复 FULLRESYNC 并执行 BGSAVE，期间写命令进入缓冲，发送 RDB 后再发送缓冲中的增量命令，之后持续传播">
<rect class="b2" x="40" y="20" width="140" height="40" rx="8"/>
<text class="tb" x="110" y="40" text-anchor="middle" dominant-baseline="middle">Replica</text>
<rect class="b1" x="330" y="20" width="140" height="40" rx="8"/>
<text class="tb" x="400" y="40" text-anchor="middle" dominant-baseline="middle">Master</text>
<rect class="b3" x="540" y="20" width="160" height="40" rx="8"/>
<text class="tb" x="620" y="40" text-anchor="middle" dominant-baseline="middle">复制缓冲</text>
<line class="ld" x1="110" y1="60" x2="110" y2="320"/>
<line class="ld" x1="400" y1="60" x2="400" y2="320"/>
<line class="ld" x1="620" y1="60" x2="620" y2="320"/>
<text class="ts" x="20" y="96">①</text>
<line class="l" x1="110" y1="96" x2="398" y2="96" marker-end="url(#arr)"/>
<text class="tm" x="255" y="88" text-anchor="middle">PSYNC ? -1（首次）</text>
<text class="ts" x="20" y="130">②</text>
<line class="l" x1="400" y1="130" x2="112" y2="130" marker-end="url(#arr)"/>
<text class="tm" x="255" y="122" text-anchor="middle">+FULLRESYNC replid offset</text>
<text class="ts" x="410" y="158">BGSAVE 或无盘直接写 socket</text>
<text class="ts" x="20" y="185">③</text>
<line class="l" x1="400" y1="185" x2="618" y2="185" marker-end="url(#arr)"/>
<text class="ts" x="510" y="177" text-anchor="middle">期间新写命令</text>
<text class="ts" x="20" y="215">④</text>
<line class="la" x1="400" y1="215" x2="112" y2="215" marker-end="url(#arr-a)"/>
<text class="ta" x="255" y="207" text-anchor="middle">发送 RDB</text>
<text class="ts" x="120" y="240">清空旧数据，加载 RDB</text>
<text class="ts" x="20" y="270">⑤</text>
<line class="l" x1="620" y1="270" x2="112" y2="270" marker-end="url(#arr)"/>
<text class="ts" x="365" y="262" text-anchor="middle">发送缓冲中积累的写命令</text>
<text class="ts" x="20" y="305">⑥</text>
<line class="l" x1="400" y1="305" x2="112" y2="305" marker-end="url(#arr)"/>
<text class="ts" x="255" y="297" text-anchor="middle">持续异步传播写命令</text>
<text class="ts" x="20" y="340">从库每秒发送 REPLCONF ACK offset，主库据此计算复制延迟（INFO replication 的 lag）</text>
</svg>
<figcaption>图 1：主从全量同步时序</figcaption>
</figure>

全量同步的代价：主库一次 fork + 生成 RDB、网络传输整个数据集、从库清空并加载（加载期间默认阻塞，不能服务读）。期间主库为每个从库维护的输出缓冲受 `client-output-buffer-limit replica 256mb 64mb 60` 限制：超过 256MB，或持续 60 秒超过 64MB，就断开从库 → 从库重连 → 又一次全量同步，形成**复制风暴**。大实例、高写入时要调大这个限制。

### 增量同步：replication backlog

<figure class="fig">
<svg viewBox="0 0 720 190" class="dg" role="img" aria-label="复制积压缓冲区：从库 offset 仍在 backlog 范围内则增量补发，已被覆盖则需要全量同步">
<rect class="bg" x="40" y="70" width="160" height="36"/>
<text class="ts" x="120" y="88" text-anchor="middle" dominant-baseline="middle">已被环形覆盖</text>
<rect class="b1" x="200" y="70" width="440" height="36"/>
<text class="t" x="420" y="88" text-anchor="middle" dominant-baseline="middle">repl_backlog（默认 1mb，环形缓冲区）</text>
<line class="ld" x1="200" y1="52" x2="200" y2="120"/>
<text class="ts" x="200" y="44" text-anchor="middle">backlog 起始 offset</text>
<line class="ld" x1="640" y1="52" x2="640" y2="120"/>
<text class="tm" x="640" y="44" text-anchor="middle">master_repl_offset</text>
<line class="la" x1="470" y1="150" x2="470" y2="110" marker-end="url(#arr-a)"/>
<text class="ta" x="470" y="168" text-anchor="middle">从库 A 的 offset → +CONTINUE 补差量</text>
<line class="l" x1="120" y1="150" x2="120" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="120" y="168" text-anchor="middle">从库 B 的 offset → 全量同步</text>
<text class="ts" x="40" y="186">前提：从库发来的 replid 与主库的 replid（或 PSYNC2 的 replid2）一致</text>
</svg>
<figcaption>图 2：增量同步依赖 replid 与 backlog 范围</figcaption>
</figure>

- 主库所有写命令既发给从库，也写入固定大小的环形缓冲 `repl_backlog`；从库记录自己已处理的 offset；
- 重连时从库发送 `PSYNC <replid> <offset>`，满足图中条件就 `+CONTINUE`，只补差量；
- **PSYNC2（4.0）**：每个实例有 `replid`（当前复制 ID）和 `replid2`（上一任主库的 ID）。从库被提升为主库时把旧主的 replid 存为 replid2，其他从库拿旧 replid 来同步也能被接受，切换后不必全量；从库重启时从 RDB 中恢复 replid 和 offset，也能增量；
- 7.0 起复制缓冲区改为**共享**：backlog 和各从库的输出缓冲共用一份数据（引用计数），多从库时内存大幅下降。

`repl-backlog-size` 默认 1mb 对生产来说太小，建议按「**主库每秒写入字节数 × 允许的最长断线秒数 × 2**」估算，常见设置 64mb～512mb。`repl-backlog-ttl`（默认 3600 秒）控制没有从库后多久释放 backlog。

### 无盘复制

| 参数 | 默认（7.x） | 说明 |
| --- | --- | --- |
| `repl-diskless-sync` | yes（7.0 之前默认 no） | 主库 fork 出的子进程直接把 RDB 写入 socket，不落盘。磁盘慢、网络快时收益大 |
| `repl-diskless-sync-delay` | 5 | 等待几秒，让同时到来的多个从库共享一次传输 |
| `repl-diskless-sync-max-replicas` | 0 | 7.0+，等到的从库数达到此值就不必等满 delay |
| `repl-diskless-load` | disabled | 从库侧：`on-empty-db` / `swapdb` 可直接从 socket 加载，`swapdb` 加载期间保留旧数据集用于服务读，内存需要两份 |
| `repl-timeout` | 60 | 复制超时 |
| `replica-serve-stale-data` | yes | 与主库断开时，从库是否继续用旧数据响应读 |
| `replica-read-only` | yes | 从库只读 |

## 哨兵 Sentinel

### 部署与发现

至少 3 个哨兵，部署在不同机器上。哨兵只需要配置主库地址，其余自动发现：

- 每 10 秒向主库、从库发 `INFO`，发现从库列表和角色变化；
- 每 2 秒通过主从库上的 `__sentinel__:hello` 频道发布自己的信息，从而发现其他哨兵；
- 每 1 秒向所有主库、从库、其他哨兵发 `PING`，用于下线判定。

### 故障转移流程

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="哨兵故障转移六步：主观下线、客观下线、选举 Leader 哨兵、选择新主、提升新主、重新配置其他节点">
<rect class="b3" x="20" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="120" y="50" text-anchor="middle" dominant-baseline="middle">① 主观下线 SDOWN</text>
<text class="ts" x="120" y="72" text-anchor="middle" dominant-baseline="middle">超过 down-after 无有效回复</text>
<line class="l" x1="220" y1="60" x2="258" y2="60" marker-end="url(#arr)"/>
<rect class="b3" x="260" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="360" y="50" text-anchor="middle" dominant-baseline="middle">② 客观下线 ODOWN</text>
<text class="ts" x="360" y="72" text-anchor="middle" dominant-baseline="middle">≥ quorum 个哨兵确认</text>
<line class="l" x1="460" y1="60" x2="498" y2="60" marker-end="url(#arr)"/>
<rect class="b4" x="500" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="600" y="50" text-anchor="middle" dominant-baseline="middle">③ 选举 Leader 哨兵</text>
<text class="ts" x="600" y="72" text-anchor="middle" dominant-baseline="middle">每个 epoch 一票，需过半</text>
<line class="l" x1="600" y1="90" x2="600" y2="118"/>
<line class="l" x1="600" y1="118" x2="120" y2="118"/>
<line class="l" x1="120" y1="118" x2="120" y2="146" marker-end="url(#arr)"/>
<rect class="b1" x="20" y="148" width="200" height="66" rx="8"/>
<text class="tb" x="120" y="166" text-anchor="middle" dominant-baseline="middle">④ 选择新主</text>
<text class="ts" x="120" y="186" text-anchor="middle" dominant-baseline="middle">过滤不健康、断连过久的</text>
<text class="ts" x="120" y="202" text-anchor="middle" dominant-baseline="middle">优先级 → offset → runid</text>
<line class="l" x1="220" y1="181" x2="258" y2="181" marker-end="url(#arr)"/>
<rect class="b1" x="260" y="148" width="200" height="66" rx="8"/>
<text class="tb" x="360" y="166" text-anchor="middle" dominant-baseline="middle">⑤ 提升新主</text>
<text class="tm" x="360" y="186" text-anchor="middle" dominant-baseline="middle">REPLICAOF NO ONE</text>
<text class="ts" x="360" y="202" text-anchor="middle" dominant-baseline="middle">等待 INFO 确认角色变化</text>
<line class="l" x1="460" y1="181" x2="498" y2="181" marker-end="url(#arr)"/>
<rect class="b2" x="500" y="148" width="200" height="66" rx="8"/>
<text class="tb" x="600" y="166" text-anchor="middle" dominant-baseline="middle">⑥ 重新配置</text>
<text class="ts" x="600" y="186" text-anchor="middle" dominant-baseline="middle">其他从库 REPLICAOF 新主</text>
<text class="ts" x="600" y="202" text-anchor="middle" dominant-baseline="middle">旧主恢复后降为从库</text>
<text class="ts" x="20" y="250">客户端：订阅哨兵的 +switch-master 频道，或调用 SENTINEL get-master-addr-by-name 获取新主地址</text>
<text class="ts" x="20" y="272">parallel-syncs（默认 1）控制同时向新主发起全量同步的从库数，避免新主同时 fork 多次、从库同时不可读</text>
</svg>
<figcaption>图 3：哨兵故障转移流程</figcaption>
</figure>

细节：

- **quorum 与过半是两回事**：quorum 只决定「几个哨兵同意才算客观下线」；真正执行故障转移需要 Leader 获得**过半哨兵**（且不少于 quorum）的投票。5 个哨兵、quorum=2：2 个同意即判定 ODOWN，但至少 3 票才能选出 Leader。
- **Leader 选举**类似 Raft：发现 ODOWN 的哨兵把 `current_epoch` +1 并向其他哨兵发 `SENTINEL is-master-down-by-addr` 拉票，每个哨兵在一个 epoch 内只投一票（先到先得）。选举失败等待随机时间后重试，`failover-timeout`（默认 180000ms）内同一主库不会重复故障转移。
- **新主选择**：先排除已下线、5 秒内未回复 INFO、与主库断连超过 `down-after-milliseconds × 10` 的从库；然后按 `replica-priority` 升序（0 表示永不当主）、复制 offset 降序、runid 字典序升序挑选。
- `down-after-milliseconds` 默认 30000，生产常调到 5000～10000；太小会因网络抖动、慢命令误判，造成不必要的切换。

## Redis Cluster

### 槽与路由

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="Cluster 槽路由：key 的 hash tag 经 CRC16 取模 16384 得到槽 15391，落在节点 C 负责的 10923 到 16383 区间">
<rect class="b" x="20" y="30" width="200" height="40" rx="8"/>
<text class="tm" x="120" y="50" text-anchor="middle" dominant-baseline="middle">user:{1001}:cart</text>
<line class="l" x1="220" y1="50" x2="258" y2="50" marker-end="url(#arr)"/>
<text class="ts" x="239" y="40" text-anchor="middle">取 {}</text>
<rect class="b5" x="260" y="30" width="220" height="40" rx="8"/>
<text class="tm" x="370" y="50" text-anchor="middle" dominant-baseline="middle">CRC16("1001") &amp; 16383</text>
<line class="l" x1="480" y1="50" x2="518" y2="50" marker-end="url(#arr)"/>
<rect class="b3" x="520" y="30" width="180" height="40" rx="8"/>
<text class="tb" x="610" y="50" text-anchor="middle" dominant-baseline="middle">slot = 15391</text>
<line class="la" x1="610" y1="70" x2="610" y2="116" marker-end="url(#arr-a)"/>
<rect class="b1" x="20" y="118" width="227" height="36"/>
<text class="tm" x="133" y="136" text-anchor="middle" dominant-baseline="middle">slot 0 – 5460</text>
<rect class="b2" x="247" y="118" width="226" height="36"/>
<text class="tm" x="360" y="136" text-anchor="middle" dominant-baseline="middle">slot 5461 – 10922</text>
<rect class="b4" x="473" y="118" width="227" height="36"/>
<text class="tm" x="586" y="136" text-anchor="middle" dominant-baseline="middle">slot 10923 – 16383</text>
<line class="l" x1="133" y1="154" x2="133" y2="178" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="154" x2="360" y2="178" marker-end="url(#arr)"/>
<line class="l" x1="586" y1="154" x2="586" y2="178" marker-end="url(#arr)"/>
<rect class="b1" x="58" y="180" width="150" height="36" rx="8"/>
<text class="tb" x="133" y="198" text-anchor="middle" dominant-baseline="middle">Master A</text>
<rect class="b2" x="285" y="180" width="150" height="36" rx="8"/>
<text class="tb" x="360" y="198" text-anchor="middle" dominant-baseline="middle">Master B</text>
<rect class="b4" x="511" y="180" width="150" height="36" rx="8"/>
<text class="tb" x="586" y="198" text-anchor="middle" dominant-baseline="middle">Master C</text>
<line class="ld" x1="133" y1="216" x2="133" y2="234"/>
<line class="ld" x1="360" y1="216" x2="360" y2="234"/>
<line class="ld" x1="586" y1="216" x2="586" y2="234"/>
<rect class="b" x="58" y="234" width="150" height="30" rx="8"/>
<text class="t" x="133" y="249" text-anchor="middle" dominant-baseline="middle">Replica A1</text>
<rect class="b" x="285" y="234" width="150" height="30" rx="8"/>
<text class="t" x="360" y="249" text-anchor="middle" dominant-baseline="middle">Replica B1</text>
<rect class="b" x="511" y="234" width="150" height="30" rx="8"/>
<text class="t" x="586" y="249" text-anchor="middle" dominant-baseline="middle">Replica C1</text>
<text class="ts" x="20" y="288">节点之间通过集群总线（默认数据端口 + 10000，7.0 可用 cluster-port 指定）两两相连交换 Gossip 消息</text>
</svg>
<figcaption>图 4：Cluster 的槽映射（redis-cli 为 3 主默认分配的区间）</figcaption>
</figure>

- 只有 key 中**第一个** `{` 和其后第一个 `}` 之间非空时才算 hash tag；`{}` 为空则对整个 key 计算；
- 槽 → 节点的映射存在每个节点和每个客户端（Smart Client）上，客户端直连目标节点，不需要代理；
- 集群模式只支持 db0，不能 `SELECT`。

### MOVED 与 ASK

| 重定向 | 触发 | 客户端行为 |
| --- | --- | --- |
| `MOVED 15391 10.0.0.3:6379` | 槽已经**稳定地**属于另一个节点（客户端映射过期） | 更新本地槽映射，重发请求；Lettuce 还会触发拓扑刷新（若开启） |
| `ASK 15391 10.0.0.4:6379` | 槽**正在迁移**，源节点上找不到该 key（可能已迁走） | 先向目标节点发 `ASKING`，再发命令；**不更新**槽映射，仅本次跳转 |
| `TRYAGAIN` | 迁移中的多 key 命令，key 分布在源和目标两侧 | 稍后重试 |
| `CROSSSLOT` | 一条命令的多个 key 不在同一槽 | 改用 hash tag 或拆成多条 |
| `CLUSTERDOWN` | 有槽无人负责且 `cluster-require-full-coverage yes` | 整个集群拒绝服务 |

`ASKING` 的作用：目标节点上该槽处于 `IMPORTING` 状态，正常请求会被 MOVED 回源节点；带 `ASKING` 标记的下一条命令才会被处理。

### Gossip 与 PING/PONG

节点间通过集群总线发送二进制消息：`MEET`（邀请加入）、`PING`、`PONG`、`FAIL`（广播下线）、`PUBLISH`、`UPDATE`（通知槽配置更新）、`FAILOVER_AUTH_REQUEST/ACK`（选举）等。

- `clusterCron` 每 100ms 执行一次：每秒随机抽 5 个节点，向其中最久没收到 PONG 的那个发 PING；另外，任何超过 `cluster-node-timeout / 2` 没收到 PONG 的节点都会立即被 PING，保证不会漏检；
- 每条 PING/PONG 的消息头带上发送者负责的**槽位图（16384 bit = 2KB）**、`configEpoch`、主从关系；消息体携带若干个其他节点的状态（约总节点数的 1/10，至少 3 个），这就是 Gossip——信息逐步扩散到全网。

### 故障检测与转移

1. **PFAIL**：节点 A 超过 `cluster-node-timeout`（默认 15000ms）没收到节点 B 的 PONG，标记 B 为疑似下线，并通过 Gossip 告诉别人；
2. **FAIL**：某节点收集到**过半主节点**在有效期（node_timeout × 2）内都报告 B 为 PFAIL，就标记 FAIL 并广播 `FAIL` 消息，所有节点立即接受；
3. **从库发起选举**：B 的从库等待 `500ms + random(0~500ms) + rank × 1000ms`（rank 按复制 offset 排序，offset 越大 rank 越小越早发起），然后把 `currentEpoch` +1，广播 `FAILOVER_AUTH_REQUEST`；
4. **主节点投票**：每个主节点在一个 epoch 内只投一票，同一个故障主库的从库在 node_timeout × 2 时间内不重复投票；获得**过半主节点**选票的从库胜出；
5. **接管**：新主执行 `REPLICAOF NO ONE`，接管槽，更新 `configEpoch`，广播 PONG 让全网更新槽映射。

- `cluster-replica-validity-factor`（默认 10）：从库与主库断开超过 `node_timeout × factor` 就不参与选举，避免数据过旧的从库上位；设为 0 则总是允许；
- **手动切换** `CLUSTER FAILOVER`：在从库上执行，先让主库停止写入并等从库追平 offset，再切换，不丢数据，适合升级运维；`FORCE` / `TAKEOVER` 用于主库不可达时；
- `cluster-require-full-coverage yes`（默认）：任何槽无人负责，整个集群停止服务；对可用性要求高可以改 no，让其他槽继续可用；
- `cluster-allow-reads-when-down`（6.0+，默认 no）：集群状态为 fail 时是否允许读。

### 为什么是 16384 个槽

- **心跳包大小**：每条 PING/PONG 都携带完整的槽位图。16384 个槽 = 2KB；如果是 65536（CRC16 的完整空间）就是 8KB，每秒大量心跳会浪费带宽；
- **集群规模**：作者建议主节点不超过约 1000 个，16384 个槽足够每个节点分到十几个以上，迁移粒度也合适；
- 槽太少则迁移粒度粗、难以均衡，太多则心跳大、映射表大，16384 是折中。

### hash tag 与多 key 限制

```java
// 同一订单的相关数据放到同一槽，才能用 Lua / 事务 / MGET 原子操作
String k1 = "order:{10086}:info";
String k2 = "order:{10086}:items";
redisTemplate.execute(script, List.of(k1, k2), args);
```

- 受限的操作：`MGET/MSET/DEL` 多 key、`SUNION`/`ZUNIONSTORE` 等、`RENAME`、`MULTI/EXEC` 中跨槽 key、Lua 的 `KEYS`、`SMOVE`；
- Lettuce 的集群 API 会把 `MGET/MSET/DEL/EXISTS/UNLINK` 这类命令**按槽拆分后并行发送再合并**，所以应用层看起来能用，但已不具备原子性；
- hash tag 的风险：`{tenant}` 这类低基数 tag 会把一个租户的所有数据压到一个节点，造成**数据倾斜和热点**。tag 的粒度应该是「需要原子操作的最小数据集」。

### 扩缩容与槽迁移

```bash
redis-cli --cluster add-node 10.0.0.7:6379 10.0.0.1:6379
redis-cli --cluster reshard 10.0.0.1:6379 --cluster-from <srcId> --cluster-to <dstId> --cluster-slots 1000 --cluster-yes
redis-cli --cluster rebalance 10.0.0.1:6379 --cluster-use-empty-masters
redis-cli --cluster check 10.0.0.1:6379
```

单个槽的迁移步骤（redis-cli 自动完成）：

1. 目标节点 `CLUSTER SETSLOT <slot> IMPORTING <srcId>`；
2. 源节点 `CLUSTER SETSLOT <slot> MIGRATING <dstId>`；
3. 循环 `CLUSTER GETKEYSINSLOT <slot> <count>` + `MIGRATE host port "" 0 <timeout> KEYS k1 k2 ...`（每个 key 在源端序列化、目标端 RESTORE、源端删除，**对两端都是同步阻塞的**）；
4. 向所有主节点（至少源和目标）发送 `CLUSTER SETSLOT <slot> NODE <dstId>`。

> [!WARNING]
> 迁移大 key 时 `MIGRATE` 会同时阻塞源和目标节点，可能导致节点被判 PFAIL 甚至触发故障转移。迁移前先用 `--bigkeys`/`--memkeys` 排查并拆分大 key，且在低峰执行。7.0 起 `CLUSTER SHARDS` 取代 `CLUSTER SLOTS` 作为拓扑查询命令，客户端需要较新版本才能用上。

## 脑裂

场景：主库 M 与哨兵/多数节点之间网络分区，但 M 仍能被部分客户端访问。哨兵把从库 S 提升为新主，此时出现两个主库同时接受写入；分区恢复后 M 降为从库，**全量同步新主数据，期间写入 M 的数据全部丢失**。

```properties
min-replicas-to-write 1
min-replicas-max-lag 10
```

含义：至少 1 个从库的复制延迟（最近一次 ACK 距今）在 10 秒以内，主库才接受写命令。孤立的旧主最多再写入约 10 秒就会拒绝写，把丢失窗口从「分区持续时间」缩短到 `max-lag` 量级。代价：从库全部故障时主库也不可写，可用性下降。

- Cluster 中：处于少数派分区的主节点在 `cluster-node-timeout` 后感知不到多数派，会把集群状态置为 fail 并停止接受写入，窗口约为 node_timeout；
- 根本上 Redis 是 AP 倾向的系统，**异步复制决定了故障转移一定可能丢数据**。不能接受丢数据的场景（如资金）不要把 Redis 当唯一存储。

## 客户端拓扑刷新（Lettuce 的坑）

Spring Boot 2.x 起默认客户端是 Lettuce。它会在启动时获取集群拓扑并缓存，但**默认不开启拓扑自适应刷新**。主节点宕机、从库被提升后，Lettuce 仍向旧地址发命令，表现为持续数分钟的超时 / `Connection refused`，直到重启应用。（收到 MOVED 时 Lettuce 会正确重定向，但旧主直接不可达时根本收不到 MOVED。）

```yaml
spring:
  data:
    redis:
      cluster:
        nodes: 10.0.0.1:6379,10.0.0.2:6379,10.0.0.3:6379
        max-redirects: 3
      lettuce:
        cluster:
          refresh:
            adaptive: true
            period: 30s
```

（Spring Boot 2.x 的前缀是 `spring.redis`，2.3 起支持上述 refresh 配置。）手动配置时：

```java
ClusterTopologyRefreshOptions refresh = ClusterTopologyRefreshOptions.builder()
        .enablePeriodicRefresh(Duration.ofSeconds(30))
        .enableAllAdaptiveRefreshTriggers()           // MOVED、ASK、连接失败、重连等触发刷新
        .adaptiveRefreshTriggersTimeout(Duration.ofSeconds(10))
        .build();
ClusterClientOptions clientOptions = ClusterClientOptions.builder()
        .topologyRefreshOptions(refresh)
        .build();
LettuceClientConfiguration config = LettuceClientConfiguration.builder()
        .clientOptions(clientOptions)
        .commandTimeout(Duration.ofSeconds(2))
        .build();
```

其他客户端注意点：

- **哨兵模式**下 Lettuce 会订阅哨兵的切换事件，一般不需要额外配置，但 `RedisSentinelConfiguration` 要配齐所有哨兵地址；
- **读写分离**：`ReadFrom.REPLICA_PREFERRED` 可以读从库，但要接受复制延迟带来的旧数据；
- Redisson 默认有定时扫描拓扑（`scanInterval`，默认 1000ms），Jedis 遇到 MOVED 或连接失败时会刷新槽缓存。

## 方案对比

| 维度 | 主从 + 哨兵 | Cluster |
| --- | --- | --- |
| 容量 / 写扩展 | 单主，受单机内存和 CPU 限制 | 水平扩展，多主分摊写 |
| 故障转移 | 哨兵（独立进程） | 节点内置，主节点投票 |
| 多 key 操作 | 无限制 | 必须同槽 |
| 客户端 | 普通客户端 + 哨兵发现 | Smart Client，需要处理重定向和拓扑 |
| 运维 | 简单 | 迁移、均衡、大 key 处理更复杂 |
| 适用 | 数据量 < 单机内存（10～20GB 内）、多 key 事务多 | 数据量大或写 QPS 超单机能力 |

## 生产实践与踩坑

- **复制风暴**：多个从库同时全量同步、或 `client-output-buffer-limit` 太小反复断连。调大 backlog 与输出缓冲限制、控制单实例内存、错开从库重启。
- **从库数据落后**：监控 `master_repl_offset - slave_repl_offset` 与 `lag`；读从库的业务要能容忍。
- **哨兵误切换**：主库执行慢命令或 fork 卡顿超过 `down-after-milliseconds`，被判下线；排查慢日志与 `latest_fork_usec`。
- **Cluster 大 key 与热 key**：一个节点 CPU 打满而其他节点空闲。`redis-cli --cluster info` 看各节点 key 数，`--hotkeys` 或客户端埋点找热点，见 [缓存设计与一致性](#/redis/cache)。
- **Pub/Sub 在 Cluster 中**：普通 `PUBLISH` 会广播到所有节点，占用集群总线带宽；7.0 的 Sharded Pub/Sub（`SPUBLISH`/`SSUBSCRIBE`）按频道的槽路由，只在对应分片内传播。
- **跨机房**：Cluster 节点间心跳对延迟敏感，跨地域部署容易误判；通常每个机房独立集群，上层做双写或同步。

## 相关阅读

- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：一致性哈希与哈希槽
- [Raft 与共识算法](#/distributed/consensus)：共识与选主
- [MongoDB 复制集、分片与事务](#/db/mongo-cluster)：MongoDB 复制集与分片

## 面试追问

> [!QUESTION] 全量同步和增量同步分别在什么时候发生？
> 首次复制、replid 不匹配、offset 已不在 backlog 范围内时全量；短暂断线重连且 offset 仍在 backlog 范围内时增量。4.0 PSYNC2 通过 replid2 和 RDB 中保存的复制信息，让故障切换后和从库重启后也能增量同步。

> [!QUESTION] 哨兵的 quorum 设为 2，5 个哨兵挂了 3 个，还能完成故障转移吗？
> 不能。quorum=2 时剩下 2 个哨兵可以判定客观下线，但选 Leader 需要过半（5 个中至少 3 票），只剩 2 个无法选出 Leader，不会执行故障转移。

> [!QUESTION] MOVED 和 ASK 的区别？
> MOVED 表示槽已经归属新节点，客户端应更新槽映射；ASK 表示槽正在迁移、这个 key 可能已迁到目标节点，客户端只对本次请求先发 ASKING 再访问目标节点，不更新映射，因为槽的其他 key 可能还在源节点。

> [!QUESTION] 为什么 Redis Cluster 用 16384 个槽而不是 65536？
> 每个心跳包都带完整槽位图，16384 位是 2KB，65536 位是 8KB；集群建议不超过 1000 个主节点，16384 个槽已足够均衡分配，因此用较小的槽数换取更小的心跳开销。

> [!QUESTION] Redis 主从切换会丢数据吗？怎么减少？
> 会。复制是异步的，主库已确认但未同步到从库的写入在切换后丢失；脑裂时旧主上的写入也会丢失。可以用 `min-replicas-to-write` / `min-replicas-max-lag` 缩小窗口，或在关键写入后用 `WAIT numreplicas timeout` 等待从库确认（只能降低概率，不是强一致）。

> [!QUESTION] Spring Boot 应用在 Redis Cluster 主节点宕机后一直报超时，原因是什么？
> 多半是 Lettuce 没开启拓扑刷新，仍连接旧主节点地址。开启 `spring.data.redis.lettuce.cluster.refresh.adaptive=true` 和定期刷新 `period`，或手动配置 `ClusterTopologyRefreshOptions`。
