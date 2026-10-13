---
level: 深入
tags: [Redis Cluster, 运维, 容量规划, 扩缩容, 槽迁移, 滚动升级, 故障转移, 数据倾斜, 监控, 数据迁移, 跨机房]
summary: Redis Cluster 的生产运维：分片与副本规划、内存与 fork 余量、关键参数、扩缩容与槽迁移的流程与风险（大 key 阻塞、限速、回滚）、滚动升级与节点替换、故障转移与分区场景下的行为、数据倾斜与热分片治理、监控指标、备份与迁移工具、跨机房部署，以及典型故障案例与检查清单。
---

# Redis Cluster 生产运维：规划、扩缩容与故障处理

> [!ABSTRACT] 核心要点
> - 原理（槽、MOVED/ASK、Gossip、故障转移）见 [主从、哨兵与 Cluster](#/redis/cluster)。本页回答“**怎么规划、怎么变更、出故障怎么办**”。
> - **容量规划的底线是留余量**：每个分片的 `used_memory` 要给 **fork 写时复制（COW）**、**主从复制缓冲**、**碎片**和**突发增长**留出空间，经验上单实例用到 `maxmemory` 的 60%~70% 就该扩容；**分片数一开始就要留扩展空间**，因为扩缩容是最危险的在线操作之一。
> - **扩缩容 = 槽迁移**：按槽逐个 `MIGRATE` key，**迁移期间大 key 会阻塞源/目标节点**，所以**先治理大 key 再扩容**，迁移要**限速、分批、避开高峰、可回滚**。
> - **故障转移默认依赖多数主节点投票**：少于半数主节点存活的分区一侧**无法完成选主**；`cluster-node-timeout` 决定故障判定速度与误判概率；**整个槽范围缺主节点时集群默认拒绝服务**（`cluster-require-full-coverage`），要想清楚是否可接受。
> - **数据倾斜与热分片**比“容量不够”更常见：大 key、热 key、hash tag 使用不当会让个别分片 CPU/内存/带宽被打满，而整体看似空闲；运维要**按分片维度**看监控，而不是看集群平均值。
> - 变更前必须演练：**滚动升级、节点替换、扩缩容、主从切换**在预发做一遍，生产有回退方案与观测指标。

## 规划与部署

### 分片、副本与机器

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Redis Cluster 部署规划：多个分片，每个分片一个主节点加一到两个副本；主从分散在不同机器和机架，避免同一台机器放置同一分片的主从；每台机器混部多个节点时要保证主节点均匀分布，单机故障不会同时丢失一个分片的所有副本；内存按 maxmemory 的七成规划并预留 fork 与复制缓冲余量">
<rect class="b" x="20" y="14" width="220" height="188" rx="10"/>
<text class="th" x="130" y="34" text-anchor="middle">机架/可用区 A</text>
<rect class="b3" x="34" y="48" width="192" height="68" rx="8"/>
<text class="tb" x="130" y="64" text-anchor="middle" dominant-baseline="middle">机器 1</text>
<text class="ts" x="130" y="86" text-anchor="middle">分片1 主 · 分片2 副本</text>
<text class="ts" x="130" y="104" text-anchor="middle">分片3 副本</text>
<rect class="b3" x="34" y="126" width="192" height="68" rx="8"/>
<text class="tb" x="130" y="142" text-anchor="middle" dominant-baseline="middle">机器 2</text>
<text class="ts" x="130" y="164" text-anchor="middle">分片2 主 · 分片3 副本</text>
<text class="ts" x="130" y="182" text-anchor="middle">分片1 副本</text>
<rect class="b" x="270" y="14" width="220" height="188" rx="10"/>
<text class="th" x="380" y="34" text-anchor="middle">机架/可用区 B</text>
<rect class="b5" x="284" y="48" width="192" height="68" rx="8"/>
<text class="tb" x="380" y="64" text-anchor="middle" dominant-baseline="middle">机器 3</text>
<text class="ts" x="380" y="86" text-anchor="middle">分片3 主 · 分片1 副本</text>
<text class="ts" x="380" y="104" text-anchor="middle">分片2 副本</text>
<rect class="b5" x="284" y="126" width="192" height="68" rx="8"/>
<text class="tb" x="380" y="142" text-anchor="middle" dominant-baseline="middle">机器 4</text>
<text class="ts" x="380" y="164" text-anchor="middle">更多分片的主/副本交错放置</text>
<text class="ts" x="380" y="182" text-anchor="middle">…</text>
<rect class="bg" x="510" y="14" width="230" height="188" rx="10"/>
<text class="th" x="625" y="34" text-anchor="middle">放置原则</text>
<text class="ts" x="625" y="62" text-anchor="middle">同一分片的主与副本</text>
<text class="ts" x="625" y="82" text-anchor="middle">不在同一机器/机架</text>
<text class="ts" x="625" y="108" text-anchor="middle">主节点在机器间均匀分布</text>
<text class="ts" x="625" y="128" text-anchor="middle">单机宕机最多影响少量主节点</text>
<text class="ts" x="625" y="154" text-anchor="middle">至少 3 个主节点才能选举</text>
<text class="ts" x="625" y="174" text-anchor="middle">生产常用 3 主 3 从起步</text>
<rect class="bg" x="20" y="222" width="720" height="98" rx="8"/>
<text class="th" x="32" y="242">内存与资源规划（单分片）</text>
<text class="ts" x="380" y="266" text-anchor="middle">数据量 ≤ maxmemory 的约 60%~70%；剩余留给：COW（RDB/AOF 重写期间写入量）、复制缓冲、客户端缓冲、碎片</text>
<text class="ts" x="380" y="288" text-anchor="middle">机器物理内存 ≥ 该机所有 Redis 实例 maxmemory 之和 + 系统与余量；开启 overcommit_memory=1，关闭 THP，避免 swap</text>
<text class="ts" x="380" y="308" text-anchor="middle">CPU：单线程命令执行，核数主要给 IO 线程、后台线程与 fork；网络带宽要覆盖主从复制与全量同步的峰值</text>
</svg>
<figcaption>图 1：分片、副本与机器的放置原则</figcaption>
</figure>

| 规划项 | 经验与注意 |
| --- | --- |
| **分片数** | 先估算总数据量与峰值 QPS，除以单分片的合理承载；**单分片内存不宜过大**（通常控制在 10~32GB 量级，视 fork、全量同步耗时而定），过大则 RDB/AOF 重写与全量同步时间长、故障恢复慢 |
| **副本数** | 每分片至少 1 个副本；重要业务 2 个，跨机架；副本也承担 failover，不要和主节点同机 |
| **单机混部** | 一台机器多个实例要**错开主从**，并且给每个实例限定 `maxmemory` 与 CPU 亲和；避免“某台机器宕机，同一分片的主和从同时丢失” |
| **扩展余量** | 初期槽分配均匀；业务增长预期要在分片数上留余量，因为后续扩容需要迁移槽（有风险）；**不要等内存 90% 才扩容** |
| **版本** | 使用受支持的稳定版本；升级前评估协议与行为变化（如新版本对槽迁移、复制、客户端缓存的改进，具体以官方发行说明为准） |
| **客户端兼容** | 客户端必须是**集群感知**的（自动路由、拓扑刷新），并配置合理的重定向次数与超时，见 [主从、哨兵与 Cluster](#/redis/cluster) 的客户端拓扑刷新 |

### 关键参数清单

| 参数 | 说明 | 建议 |
| --- | --- | --- |
| `maxmemory` | 单实例内存上限 | 必须设置；与淘汰策略配合，见 [过期策略与内存淘汰](#/redis/expire) |
| `maxmemory-policy` | 淘汰策略 | 缓存用 `allkeys-lru/lfu`；存储型用 `noeviction`（写满时拒绝写入并告警） |
| `cluster-enabled` / `cluster-config-file` | 集群开关与节点配置 | 配置文件路径要持久化，**不要手改** |
| `cluster-node-timeout` | 节点失联判定时间（默认 15000ms） | 过小易误判（GC/网络抖动）引发无谓切换，过大故障恢复慢；一般几秒到十几秒，按网络质量评估 |
| `cluster-replica-validity-factor` / `cluster-slave-validity-factor` | 副本与主断开多久后不再有资格参选 | 数据新鲜度与可用性的取舍 |
| `cluster-require-full-coverage` | 是否要求所有槽都有节点才对外服务（默认 yes） | yes：一个分片整体故障则整个集群拒绝服务，数据一致性强；no：存活的槽仍可用，业务要容忍部分不可用 |
| `cluster-allow-reads-when-down` | 集群 down 时是否仍允许读（版本相关） | 读多可容忍旧数据的场景考虑 |
| `cluster-migration-barrier` | 副本迁移：保证主至少保留多少个副本才允许副本迁移出去 | 副本不均衡时让富余副本自动支援孤立主 |
| `repl-backlog-size` | 复制积压缓冲 | 调大以减少断线后全量同步，按写入速率与预期断线时长估算 |
| `client-output-buffer-limit` | 客户端输出缓冲上限（含副本、发布订阅） | 防止慢客户端/副本把内存撑爆，也要避免过小导致副本被断开 |
| `min-replicas-to-write` / `min-replicas-max-lag` | 主节点至少有 N 个副本延迟在 M 秒内才接受写 | 降低“脑裂时丢写”窗口，代价是副本不可用时拒写 |
| `tcp-backlog`、`timeout`、`tcp-keepalive` | 连接层 | 与系统参数配合，见 [Linux 线上排查](#/infra/linux) |
| `appendonly` / `save` | 持久化 | 见 [RDB 与 AOF](#/redis/persistence)；缓存集群可以只保留副本不持久化主节点，权衡恢复方式 |
| 保护类 | `rename-command`/ACL、`bind`、`protected-mode`、`requirepass` | 见 [故障排查与安全](#/redis/troubleshooting) |

## 扩缩容与槽迁移

### 流程

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="扩容流程：新节点加入集群，先作为空主节点，再按计划把一部分槽从旧分片迁移过来；迁移单位是槽，逐 key 迁移并设置 IMPORTING 和 MIGRATING 状态，ASK 重定向保证迁移期读写正确；大 key 会长时间阻塞，需限速、分批、校验槽分布，完成后给新主节点添加副本，监控各分片负载">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 准备</text>
<text class="ts" x="75" y="74" text-anchor="middle">治理大 key·备份</text>
<rect class="b5" x="145" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="52" text-anchor="middle" dominant-baseline="middle">② 加节点</text>
<text class="ts" x="200" y="74" text-anchor="middle">空主+副本</text>
<rect class="b1" x="270" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="330" y="52" text-anchor="middle" dominant-baseline="middle">③ 迁移槽</text>
<text class="ts" x="330" y="74" text-anchor="middle">分批·限速</text>
<rect class="b4" x="405" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="460" y="52" text-anchor="middle" dominant-baseline="middle">④ 校验</text>
<text class="ts" x="460" y="74" text-anchor="middle">槽覆盖·key 数</text>
<rect class="b2" x="530" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="585" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 观察</text>
<text class="ts" x="585" y="74" text-anchor="middle">负载·延迟</text>
<rect class="b3" x="655" y="30" width="85" height="64" rx="8"/>
<text class="tb" x="697" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 收尾</text>
<text class="ts" x="697" y="74" text-anchor="middle">更新文档</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="62" x2="270" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="62" x2="405" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="62" x2="530" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="62" x2="655" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="114" width="350" height="212" rx="8"/>
<text class="th" x="32" y="134">单个槽的迁移过程</text>
<text class="ts" x="195" y="160" text-anchor="middle">1. 目标节点标记槽为 IMPORTING</text>
<text class="ts" x="195" y="180" text-anchor="middle">2. 源节点标记槽为 MIGRATING</text>
<text class="ts" x="195" y="200" text-anchor="middle">3. 循环：取该槽的一批 key → MIGRATE 到目标</text>
<text class="ts" x="195" y="220" text-anchor="middle">4. 迁移中：key 在源则源处理；不在则 ASK 重定向</text>
<text class="ts" x="195" y="240" text-anchor="middle">5. 槽迁完 → 通知全集群槽归属变更</text>
<text class="ts" x="195" y="266" text-anchor="middle">MIGRATE 是原子的“序列化→发送→目标写入→</text>
<text class="ts" x="195" y="286" text-anchor="middle">源删除”，期间会阻塞源节点与目标节点，</text>
<text class="ts" x="195" y="306" text-anchor="middle">key 越大阻塞越久</text>
<rect class="b4" x="390" y="114" width="350" height="212" rx="8"/>
<text class="th" x="402" y="134">风险与对策</text>
<text class="ts" x="565" y="160" text-anchor="middle">大 key 迁移 → 长时间阻塞 → 请求超时/误触发 failover</text>
<text class="ts" x="565" y="180" text-anchor="middle">对策：迁移前扫描并拆分大 key，按槽分批</text>
<text class="ts" x="565" y="206" text-anchor="middle">迁移叠加业务高峰 → 延迟抖动</text>
<text class="ts" x="565" y="226" text-anchor="middle">对策：低峰执行，限制迁移批大小与并发</text>
<text class="ts" x="565" y="252" text-anchor="middle">中途失败 → 槽处于半迁移状态</text>
<text class="ts" x="565" y="272" text-anchor="middle">对策：用官方 fix/check 工具修复，保留迁移日志</text>
<text class="ts" x="565" y="298" text-anchor="middle">客户端缓存旧拓扑 → 大量 MOVED</text>
<text class="ts" x="565" y="318" text-anchor="middle">对策：客户端开启自动拓扑刷新</text>
</svg>
<figcaption>图 2：扩容流程与槽迁移的风险</figcaption>
</figure>

### 具体步骤（概念）

1. **评估**：目标分片数、每个新节点分得的槽数；检查现有分片是否有大 key、热 key（见 [大 key 与热 key 治理](#/redis/bigkey)）；
2. **备份**：对各分片做 RDB 备份（或确认副本有最新快照），保证可回退；
3. **加入新节点**：先启动新节点（集群模式、同样的配置、密码与参数），用官方工具的 `add-node` 加入；按需添加副本节点；
4. **迁移槽**：用 `redis-cli --cluster reshard`（可指定源、目标、槽数、每次迁移的 key 批量与超时）或 `rebalance`（自动按权重均衡）；**分多批执行**，每批后检查延迟与错误；
5. **校验**：`--cluster check` 检查槽覆盖、节点状态；对比迁移前后 key 数量；抽样读写验证；
6. **观察**：24 小时内关注各分片 CPU、内存、延迟、MOVED/ASK 比例；
7. **缩容**：先把要下线的主节点的槽全部迁出，再从集群中 `del-node`（包括其副本），**禁止直接关机删除**，否则槽无主。

```bash
# 示意命令（实际参数以所用版本 redis-cli 帮助为准）
redis-cli --cluster check 10.0.0.1:6379                       # 先检查集群状态
redis-cli --cluster add-node 10.0.1.1:6379 10.0.0.1:6379      # 加入新节点（空主）
redis-cli --cluster add-node 10.0.1.2:6379 10.0.0.1:6379 --cluster-slave --cluster-master-id <新主ID>
redis-cli --cluster reshard 10.0.0.1:6379 \
    --cluster-from <源主ID> --cluster-to <新主ID> --cluster-slots 1000 \
    --cluster-pipeline 10 --cluster-yes                       # 每批迁移 1000 个槽，pipeline 控制批量
redis-cli --cluster check 10.0.0.1:6379                       # 迁移后再次检查
```

### 加速与降风险的做法

| 做法 | 说明 |
| --- | --- |
| **扩容前拆大 key** | 迁移阻塞的主因；见 [大 key 与热 key 治理](#/redis/bigkey) |
| **小批量多轮** | 每次只迁一小批槽，观察指标，再继续；便于随时中止 |
| **低峰窗口** | 避开大促、定时批量任务 |
| **控制迁移并发** | 同一时刻只在一对节点间迁移，避免多个迁移叠加 |
| **提前扩容而不是应急扩容** | 内存已紧张时迁移还会放大内存（key 同时存在于源和目标的短暂时间、复制缓冲），应急扩容常常会失败 |
| **替代方案：新集群双写迁移** | 创建新集群，业务双写+回填，再切读，最后切写；比原地迁移更慢但风险更可控，适合大版本升级或分片数大幅变化 |
| **缩容谨慎** | 缩容把数据集中到更少的分片，内存与 QPS 要提前验证；缩容后再扩容代价高 |

## 滚动升级与节点替换

### 升级

1. **阅读发行说明**：配置项变更、持久化格式（RDB/AOF 版本兼容）、复制与集群协议变化；
2. **预发演练**：用相同数据规模与客户端版本验证；
3. **顺序**：先升级**副本**，再对主节点做**手动故障转移**（`CLUSTER FAILOVER`，在副本上执行，数据对齐后无损切换）把主角色切到已升级的节点，再升级原主（现在是副本）；一次只操作一个分片；
4. **每步确认**：副本与主节点的复制偏移量追平、集群状态 ok、延迟与错误无异常，再继续下一个；
5. **回退**：保留旧版本二进制与备份；新版本写出的持久化文件旧版本可能无法读取，回退需要用升级前备份。

### 手动故障转移的三种模式

| 命令模式 | 行为 | 用途 |
| --- | --- | --- |
| 默认 `CLUSTER FAILOVER` | 与主节点协调：暂停客户端写入、等副本追平后切换，**无数据丢失** | 计划内维护、升级 |
| `FORCE` | 不与主节点协调，副本直接发起选举，仍需多数主节点同意 | 主节点不可达但多数主存活 |
| `TAKEOVER` | 不经选举，直接接管并提升纪元 | 多数主不可用的极端情况，**有数据丢失与冲突风险**，仅应急使用 |

### 节点替换

- **副本替换**：新机器启动新节点作为目标主节点的副本，等待全量同步完成与追平，再下线旧副本（`del-node`）；
- **主节点替换**：先给该主节点添加一个新副本，同步完成后对该副本执行手动故障转移，使新节点成为主，再下线旧节点；
- **IP 变化**：集群配置按节点 ID 与 IP:端口记录，容器/K8s 环境里 Pod IP 变化要使用稳定的网络标识（如 StatefulSet 的固定域名）并确认版本对主机名的支持（`cluster-announce-hostname` 等相关选项随版本提供，以官方文档为准）；
- **同机房多实例**：重启前确认不会同时重启同一分片的主从。

## 故障转移与异常场景

### 故障转移回顾

主节点被多数主节点判定为 FAIL 后，**其副本之间选举**，数据偏移量最大的副本优先；获得**多数主节点**投票的副本成为新主，接管槽并通过 Gossip 广播。要点：

- **需要多数主节点存活**才能完成选举：3 主集群**同时坏 2 个主**则整个集群无法自动恢复；
- 故障判定时间 ≈ `cluster-node-timeout` + 投票与选举耗时，**期间该分片不可写**；
- 副本数据可能略落后于主（异步复制），故障转移**可能丢失最近的写**（可用 `min-replicas-to-write` 缩小窗口，但无法消除）。

### 典型异常与行为

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Redis Cluster 典型异常：单个分片主副本全部宕机则该槽范围不可用，若 cluster-require-full-coverage 为 yes 则整个集群拒绝服务；网络分区时多数主节点所在的一侧可继续选举，少数侧无法写入但旧主可能短暂接受写入造成丢失；主节点因大 key 或慢命令阻塞超过 node-timeout 会被误判为故障触发无谓切换；副本落后过多无资格参选导致无法切换；纪元冲突与配置不一致需要修复">
<rect class="b4" x="20" y="14" width="350" height="86" rx="8"/>
<text class="tb" x="195" y="32" text-anchor="middle" dominant-baseline="middle">分片整体丢失（主+副本都挂）</text>
<text class="ts" x="195" y="56" text-anchor="middle">该分片的槽不可用</text>
<text class="ts" x="195" y="76" text-anchor="middle">full-coverage=yes → 整个集群拒绝服务</text>
<text class="ts" x="195" y="92" text-anchor="middle">全部副本同机架是典型诱因</text>
<rect class="b2" x="390" y="14" width="350" height="86" rx="8"/>
<text class="tb" x="565" y="32" text-anchor="middle" dominant-baseline="middle">应对</text>
<text class="ts" x="565" y="56" text-anchor="middle">机架/可用区分散放置；重要业务 2 副本</text>
<text class="ts" x="565" y="76" text-anchor="middle">预案：从备份恢复分片，必要时先 no-full-coverage</text>
<text class="ts" x="565" y="92" text-anchor="middle">评估部分可用对业务的影响</text>
<rect class="b4" x="20" y="112" width="350" height="86" rx="8"/>
<text class="tb" x="195" y="130" text-anchor="middle" dominant-baseline="middle">网络分区</text>
<text class="ts" x="195" y="154" text-anchor="middle">多数主所在侧可选举新主</text>
<text class="ts" x="195" y="174" text-anchor="middle">少数侧旧主在超时前仍可能接受写（会丢）</text>
<text class="ts" x="195" y="190" text-anchor="middle">分区恢复后旧主降为副本，丢失其期间写入</text>
<rect class="b2" x="390" y="112" width="350" height="86" rx="8"/>
<text class="tb" x="565" y="130" text-anchor="middle" dominant-baseline="middle">应对</text>
<text class="ts" x="565" y="154" text-anchor="middle">min-replicas-to-write 限制孤立主接受写</text>
<text class="ts" x="565" y="174" text-anchor="middle">客户端对关键写做幂等与对账</text>
<text class="ts" x="565" y="190" text-anchor="middle">合理的 node-timeout，网络质量监控</text>
<rect class="b4" x="20" y="210" width="350" height="100" rx="8"/>
<text class="tb" x="195" y="228" text-anchor="middle" dominant-baseline="middle">主节点“假死”被误判</text>
<text class="ts" x="195" y="252" text-anchor="middle">大 key 删除/迁移、KEYS、长 Lua、fork 卡顿</text>
<text class="ts" x="195" y="272" text-anchor="middle">阻塞超过 node-timeout 无法响应心跳</text>
<text class="ts" x="195" y="292" text-anchor="middle">→ 被标 FAIL → 副本接管 → 抖动甚至双主短暂并存</text>
<rect class="b2" x="390" y="210" width="350" height="100" rx="8"/>
<text class="tb" x="565" y="228" text-anchor="middle" dominant-baseline="middle">应对</text>
<text class="ts" x="565" y="252" text-anchor="middle">禁止危险命令，大 key 治理，UNLINK 代替 DEL</text>
<text class="ts" x="565" y="272" text-anchor="middle">fork 的内存与 THP 配置，给 node-timeout 足够余量</text>
<text class="ts" x="565" y="292" text-anchor="middle">监控延迟尖刺、failover 次数并告警</text>
</svg>
<figcaption>图 3：集群常见异常场景与应对</figcaption>
</figure>

### 手工修复与恢复

| 场景 | 处理 |
| --- | --- |
| **槽未覆盖/槽状态异常（半迁移）** | `redis-cli --cluster check` 发现问题后，用 `--cluster fix` 修复；修复前确认数据在哪个节点，避免修复方向错误导致覆盖；先备份 |
| **节点被误标 FAIL 但已恢复** | 通常自动清除标记；长时间不清除时检查网络与 Gossip 端口（集群总线端口 = 服务端口 + 10000，防火墙必须放行） |
| **节点配置文件（nodes.conf）损坏/丢失** | 该节点以新 ID 启动会被当成新节点；应从备份恢复节点配置，或按流程重新加入并迁移 |
| **新节点无法加入** | 检查集群总线端口、`cluster-announce-*`、密码/ACL 一致性、节点是否残留旧集群信息（先 `CLUSTER RESET`） |
| **集群状态 fail 但节点都在** | 检查是否有槽未分配、少数主节点分区、`cluster-require-full-coverage` 影响；看 `CLUSTER INFO` 的 `cluster_state` 与 `cluster_slots_*` |
| **全量恢复分片** | 用 RDB 备份在新节点启动，作为原节点的替代，经手动加入和槽重新指派；复杂，务必预先演练 |

## 数据倾斜与热分片

### 倾斜类型

| 类型 | 现象 | 根因 | 治理 |
| --- | --- | --- | --- |
| **内存倾斜** | 某分片 `used_memory` 远高于其他 | 大 key、hash tag 把大量 key 绑到同一槽、槽分配不均 | 拆大 key，慎用 hash tag，重新均衡槽 |
| **QPS/CPU 倾斜** | 某分片 CPU 接近 100%，其他很低 | **热 key**、热点业务集中在少数槽 | 本地缓存、key 分散、副本读，见 [大 key 与热 key 治理](#/redis/bigkey) |
| **带宽倾斜** | 某分片网卡打满 | 大 value 高频读取、热 key | 压缩、拆分、本地缓存 |
| **连接倾斜** | 某节点连接数偏多 | 客户端路由或拓扑刷新异常 | 检查客户端实现与连接池 |
| **副本读不均** | 开启读写分离后副本负载不均 | 路由策略、副本数量差异 | 客户端读策略与副本均衡 |

### hash tag 的双刃剑

hash tag（`{user:1001}:profile`）让相关 key 落在同一槽，支持多 key 命令、事务与 Lua。但：

- **同一 tag 下的数据总量会限制在单分片**，如果 tag 选择过粗（如 `{tenant}`），大租户会造成严重倾斜；
- **热点集中**：同一个 tag 的所有请求命中同一节点；
- 建议：tag 的粒度细到**业务实体**（订单、用户），不要用大范围的聚合维度；能不用就不用，业务上尽量避免跨 key 操作。

### 重新均衡

- `redis-cli --cluster rebalance` 可按**槽权重**重新分布，默认按槽数均衡，**不会考虑实际内存/QPS**；因此要结合监控，针对性迁移高负载分片的槽，或按权重调整；
- 倾斜严重且由少量大 key/热 key 造成时，**迁槽治标不治本**，应该先治理 key 本身；
- 重新均衡也要遵守前述迁移风险控制。

## 监控与告警

**按分片/节点维度**监控，而不是集群平均值：

| 类别 | 指标 | 告警思路 |
| --- | --- | --- |
| **可用性** | `cluster_state`、`cluster_slots_ok/fail`、节点存活、主从角色变化、failover 次数 | state 非 ok、有槽 fail、发生切换立即告警 |
| **内存** | `used_memory`、`used_memory_rss`、`mem_fragmentation_ratio`、`maxmemory` 使用率、淘汰数 `evicted_keys`、过期数 | 使用率 > 70% 预警；碎片率异常；evicted 突增 |
| **性能** | `instantaneous_ops_per_sec`、命中率（`keyspace_hits/misses`）、命令耗时、`slowlog` 数量、`latency` 事件、阻塞客户端数 | P99 延迟、慢日志数量、延迟尖刺 |
| **复制** | `master_repl_offset` 与副本偏移差、`repl_backlog` 使用、全量同步次数、副本连接状态 | 偏移差持续增大、频繁全量同步告警 |
| **持久化** | 最近一次 RDB/AOF 重写耗时与状态、`rdb_last_bgsave_status`、fork 耗时（`latest_fork_usec`） | bgsave 失败、fork 耗时过长 |
| **连接** | `connected_clients`、`blocked_clients`、拒绝连接数、客户端输出缓冲 | 连接数接近 `maxclients` |
| **网络** | 入/出带宽、重传 | 接近网卡上限 |
| **倾斜** | 各分片 QPS/内存/CPU 的离散程度（最大/平均） | 比值超阈值告警 |
| **客户端侧** | MOVED/ASK 次数、重定向失败、超时、连接池等待 | MOVED 激增说明拓扑变化或客户端未刷新 |

采集方式：exporter（如 redis_exporter）+ Prometheus + Grafana，见 [指标监控](#/infra/obs-metrics)；**慢日志与延迟监控**要持久化保存，便于事后分析。

## 备份、迁移与数据导入

| 需求 | 方案与要点 |
| --- | --- |
| **备份** | 各分片分别做 RDB（在副本上做，避免主节点 fork 压力）；备份文件按分片与时间归档，带集群拓扑信息；**定期做恢复演练** |
| **恢复** | 用备份启动对应分片节点并重建集群关系；整体恢复要保证各分片备份时间点接近（跨分片非强一致快照） |
| **跨集群迁移** | 使用迁移工具（如 RedisShake 等）做全量+增量同步（基于复制协议），切换时短暂停写、校验后切流量；注意**大 key、过期时间、Lua/脚本、不同版本/模式（单机→集群）**的兼容 |
| **单机迁集群** | 先检查业务是否使用了多 key 命令/事务/Lua（跨槽会失败）、`SELECT` 多库（集群仅 DB0）、`KEYS`/`SCAN` 全局语义；必要时改造为 hash tag 或拆分 |
| **数据校验** | 迁移后抽样比对、key 数量对比、关键业务回归；双写期间监控差异 |
| **回滚** | 迁移期间保留源集群读写能力，直到观察稳定；有明确的回滚开关 |

## 跨机房与多活

| 方案 | 说明与风险 |
| --- | --- |
| **同城多可用区拉伸集群** | 主从分散在不同可用区；复制延迟低；可用区故障自动转移；注意写入需要跨区复制的网络延迟与带宽，客户端就近读副本时要容忍复制延迟 |
| **异地主备** | 备集群通过复制工具异步同步；故障时切换，有 RPO；**不要让一个 Redis Cluster 跨城部署**（Gossip、选举和复制延迟敏感） |
| **双活** | 两地各自读写并双向同步，需要处理冲突与循环复制；通常按用户/租户分区写入，避免同 key 双写 |
| **缓存场景的取舍** | 多数缓存数据可重建，异地用**独立缓存集群 + 回源重建**比跨地域复制更简单可靠 |

## 案例与教训

| 案例 | 根因 | 教训 |
| --- | --- | --- |
| 扩容时集群大量超时并发生切换 | 迁移的槽里有 GB 级大 key，MIGRATE 长时间阻塞，心跳超时被误判为故障 | 扩容前扫描大 key；小批量迁移；适当调高 node-timeout 或在低峰迁移 |
| 单个分片 CPU 100%，其他空闲 | 热 key（秒杀商品）全部命中同一槽 | 本地缓存、key 分散、监控分片维度而不是平均值 |
| 机房某机架断电，整个集群不可用 | 同一分片的主从放在同一机架，`full-coverage=yes` | 机架感知放置；评估 full-coverage 的取舍 |
| 重启一台机器后，数据量激增、全量同步风暴 | 多个副本同时重启，主节点同时生成 RDB 与大量复制缓冲，内存暴涨被 OOM | 滚动重启一次一台；调大 backlog；预留 COW 内存 |
| 升级后部分 key 读取异常 | 新旧版本编码与行为差异，客户端序列化变化 | 预发回归；灰度升级；确认客户端兼容 |
| 误执行危险命令导致阻塞 | `KEYS *`、`FLUSHALL`、大集合 `SMEMBERS` | 命令 ACL/禁用，权限最小化，代码审查与规范 |
| 新节点加入后集群状态异常 | 集群总线端口未放行 | 部署清单检查网络；自动化校验 |

## 运维检查清单

- [ ] 每个分片是否有 ≥1 副本，主从是否跨机器/机架/可用区？
- [ ] `used_memory` 是否 ≤ `maxmemory` 的 70%，是否为 fork/复制预留了内存？
- [ ] 是否设置了 `cluster-node-timeout`、`min-replicas-to-write`、`client-output-buffer-limit` 并评估过取舍？
- [ ] 扩缩容前是否扫描并治理了大 key，是否小批量、限速、低峰执行并有回退方案？
- [ ] 是否演练过滚动升级、手动故障转移、节点替换、分片恢复？
- [ ] 监控是否覆盖分片维度（倾斜）、failover、复制偏移、慢日志、MOVED？
- [ ] 客户端是否支持集群拓扑自动刷新，超时与重试是否合理？
- [ ] 是否禁用或权限控制了危险命令，网络是否隔离且设置了认证？
- [ ] 是否有定期备份与恢复演练？

## 相关阅读

- [主从、哨兵与 Cluster](#/redis/cluster)：复制、故障转移与槽迁移原理
- [Redis 大 key 与热 key 治理](#/redis/bigkey)：扩容前的必做治理
- [Redis 故障排查与安全加固](#/redis/troubleshooting)：延迟、内存、连接等线上问题
- [RDB 与 AOF](#/redis/persistence)：fork、COW 与持久化配置
- [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)：故障演练方法

## 面试追问

> [!QUESTION] Redis Cluster 怎么扩容？有什么风险？
> 先加入空的新节点，再用 reshard 把部分槽迁移过去，迁移是按槽逐个 key 通过 MIGRATE 传输，期间用 IMPORTING/MIGRATING 状态和 ASK 重定向保证读写正确，完成后给新主加副本并校验。风险是大 key 迁移会长时间阻塞源和目标节点，甚至导致心跳超时被误判故障，所以要先治理大 key、小批量限速、低峰执行并准备回退，扩容要提前而不是内存快满时。

> [!QUESTION] Cluster 的故障转移需要什么条件？哪些场景会不可用？
> 主节点被多数主节点判定 FAIL 后，其副本发起选举，需要获得多数主节点投票，所以 3 主集群同时坏 2 个主无法自动恢复。某个分片主从全丢则其槽不可用，cluster-require-full-coverage 为 yes 时整个集群拒绝服务；网络分区时少数侧无法选主，旧主可能短暂接受写造成丢失，可用 min-replicas-to-write 缩小窗口。

> [!QUESTION] 为什么主节点会被误判故障？怎么避免？
> 主节点被大 key 删除或迁移、KEYS、长耗时 Lua、fork 卡顿阻塞，超过 cluster-node-timeout 无法响应心跳，就会被标记 FAIL 触发切换。办法是禁止危险命令、用 UNLINK、治理大 key、关闭 THP 并为 fork 留足内存、合理设置 node-timeout，同时监控延迟尖刺和 failover 次数。

> [!QUESTION] 怎么做 Redis Cluster 的滚动升级？
> 先读发行说明并在预发演练；先升级副本，再对主节点所在分片执行手动故障转移（默认模式会等副本追平，无数据丢失），让已升级节点成为主，再升级原主；一次只动一个分片，每步确认复制偏移追平、集群状态 ok、延迟正常；保留旧版本和升级前备份以便回退。

> [!QUESTION] 集群里某个分片 CPU 打满，其他很空闲，怎么回事？
> 数据或访问倾斜：热 key 集中在同一槽、大 key 造成内存和带宽倾斜，或 hash tag 太粗把大量 key 绑到一个分片。要按分片维度看监控定位热 key 和大 key，用本地缓存、key 后缀分散、副本读等治理，hash tag 粒度细到业务实体；单纯迁槽只是治标。

> [!QUESTION] 单机 Redis 迁移到 Cluster 要注意什么？
> Cluster 只支持 DB0；多 key 命令、事务、Lua 要求所有 key 在同一槽，需用 hash tag 或改造业务；KEYS 等全局命令语义变化；客户端要用集群感知实现。迁移用复制类工具做全量加增量，校验后切流量，并保留回滚。
