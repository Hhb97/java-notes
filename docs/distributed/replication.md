---
level: 深入
tags: [数据复制, 主从复制, 多主, 无主, Dynamo, Quorum, 读修复, 反熵, Merkle 树, 冲突解决, CRDT, 复制延迟, 因果一致]
summary: 分布式数据复制与一致性的完整图景：主从（同步/异步/半同步、复制延迟引发的读异常及对策）、多主（冲突检测与解决、拓扑）、无主（Dynamo 风格 Quorum、读修复、提示移交、反熵与 Merkle 树）、冲突解决（LWW、版本向量、CRDT）、链式复制、复制协议的选型与常见故障。
---

# 复制与一致性：主从、多主与无主

> [!ABSTRACT] 核心要点
> - 复制的目的有三：**高可用（副本接管）、低延迟（就近读）、读扩展（多副本分担读）**。**难点不在“复制”本身，而在“数据会变”**：如何让副本在**不丢更新、不乱序、可容忍故障**的前提下保持一致。
> - 三大模型：**单主（主从）**——所有写到主，副本异步/同步跟随，**简单、冲突少，写入有单点上限**；**多主**——多个节点接受写，**写入可用性与跨地域低延迟好，必须处理写冲突**；**无主（Dynamo 风格）**——客户端/协调者把读写发给多个副本，靠 **Quorum（W+R>N）+ 读修复 + 反熵**收敛，**最终一致、容忍部分节点故障，冲突要交给应用/CRDT**。
> - **复制延迟是读异常的根源**：**读自己写的内容读不到（read-your-writes）**、**读到过去的版本（单调读被破坏）**、**因果倒置（先看到回复后看到问题）**。要用**会话粘性、读主、版本等待、因果一致读**等手段按需修复，不要默认“读副本就一定是新的”。
> - **冲突解决没有银弹**：LWW（最后写入赢）简单但**会静默丢数据**且受时钟影响；**版本向量**保留并发版本交给应用合并；**CRDT** 通过数学设计让合并无冲突（计数器、集合、寄存器、文本序列）。**能避免冲突（路由同一数据到同一主）就别解决冲突**。
> - **同步 vs 异步**是可用性与持久性的权衡：全同步任一副本不可用就阻塞写；全异步主故障可能丢最近写；**半同步（至少 1 个副本确认）**是常见折中。**Quorum 与共识不同**：Quorum 读写不保证线性一致（时钟、并发、重试、sloppy quorum 都会破坏）。
> - 选型：**强一致与事务 → 单主 + 共识（Raft/Paxos）复制**；**多地域写入与高可用优先 → 多主/无主 + 冲突策略**；**协作编辑 → CRDT/OT**，见 [案例：在线协作文档](#/design/case-collab)。

## 复制模型总览

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="三种复制模型：单主复制中客户端写入主节点，主节点把变更日志同步或异步复制给从节点，读可以走主或从；多主复制中多个节点都可写，节点间相互复制，需要冲突检测与解决；无主复制中客户端或协调者把写入发送到多个副本，读取时向多个副本读并通过版本比较和读修复收敛">
<rect class="b3" x="20" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">单主（Leader/Follower）</text>
<rect class="b5" x="80" y="56" width="110" height="34" rx="6"/>
<text class="ts" x="135" y="73" text-anchor="middle" dominant-baseline="middle">主：接受所有写</text>
<rect class="b1" x="36" y="130" width="90" height="34" rx="6"/>
<text class="ts" x="81" y="147" text-anchor="middle" dominant-baseline="middle">从 1</text>
<rect class="b1" x="144" y="130" width="90" height="34" rx="6"/>
<text class="ts" x="189" y="147" text-anchor="middle" dominant-baseline="middle">从 2</text>
<line class="l" x1="110" y1="90" x2="81" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="160" y1="90" x2="189" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="135" y="190" text-anchor="middle">冲突少、实现简单</text>
<text class="ts" x="135" y="206" text-anchor="middle">写入受单主限制</text>
<rect class="b5" x="270" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">多主（Multi-Leader）</text>
<rect class="b3" x="290" y="64" width="86" height="34" rx="6"/>
<text class="ts" x="333" y="81" text-anchor="middle" dominant-baseline="middle">主 A（地域1）</text>
<rect class="b3" x="394" y="64" width="86" height="34" rx="6"/>
<text class="ts" x="437" y="81" text-anchor="middle" dominant-baseline="middle">主 B（地域2）</text>
<line class="l" x1="376" y1="76" x2="394" y2="76" marker-end="url(#arr)"/>
<line class="l" x1="394" y1="88" x2="376" y2="88" marker-end="url(#arr)"/>
<text class="ts" x="385" y="130" text-anchor="middle">各自接受写，异步互相复制</text>
<text class="ts" x="385" y="152" text-anchor="middle">必须检测并解决写冲突</text>
<text class="ts" x="385" y="190" text-anchor="middle">就近写入，容忍地域故障</text>
<rect class="b1" x="520" y="14" width="220" height="200" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">无主（Leaderless）</text>
<rect class="b2" x="536" y="56" width="188" height="30" rx="6"/>
<text class="ts" x="630" y="71" text-anchor="middle" dominant-baseline="middle">客户端/协调者</text>
<rect class="b3" x="536" y="124" width="56" height="32" rx="6"/>
<text class="ts" x="564" y="140" text-anchor="middle" dominant-baseline="middle">副本1</text>
<rect class="b3" x="602" y="124" width="56" height="32" rx="6"/>
<text class="ts" x="630" y="140" text-anchor="middle" dominant-baseline="middle">副本2</text>
<rect class="b3" x="668" y="124" width="56" height="32" rx="6"/>
<text class="ts" x="696" y="140" text-anchor="middle" dominant-baseline="middle">副本3</text>
<line class="l" x1="570" y1="86" x2="564" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="86" x2="630" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="690" y1="86" x2="696" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="630" y="182" text-anchor="middle">W+R&gt;N 读写交集</text>
<text class="ts" x="630" y="202" text-anchor="middle">读修复·反熵收敛</text>
<rect class="bg" x="20" y="232" width="720" height="98" rx="8"/>
<text class="ts" x="380" y="254" text-anchor="middle">单主：强一致易做（配合共识），写扩展靠分片；多主/无主：写可用性与跨地域延迟好，一致性弱，冲突需治理</text>
<text class="ts" x="380" y="276" text-anchor="middle">常见产品：MySQL/PG 主从（单主）；跨地域 CRDT 库（多主）；Cassandra/Riak（无主）</text>
<text class="ts" x="380" y="298" text-anchor="middle">复制的是什么：语句、WAL/binlog 物理或逻辑日志、状态快照、操作（OT/CRDT 操作）——粒度决定兼容性与冲突处理能力</text>
<text class="ts" x="380" y="318" text-anchor="middle">共识（Raft/Paxos）是“单主 + 同步多数派 + 自动选主”的强一致特例</text>
</svg>
<figcaption>图 1：单主、多主、无主三种复制模型</figcaption>
</figure>

## 单主复制

### 同步、异步与半同步

| 方式 | 主节点何时返回客户端 | 持久性 | 可用性与延迟 |
| --- | --- | --- | --- |
| **全异步** | 本地提交后立即返回 | **主故障可能丢最近已确认的写** | 高，低延迟；副本掉线不影响写 |
| **半同步** | 至少 **1 个**副本确认后返回 | 主故障时至少有一个副本有最新数据（但可能不是被提升的那个，需选择最新副本） | 折中；少数副本慢时用超时降级为异步（MySQL 半同步的常见行为） |
| **全同步 / 多数派同步** | 所有副本或多数派确认后返回 | 强（多数派方式即共识） | 延迟取决于最慢的副本；全同步任一副本故障会阻塞写 |

> [!WARNING] 异步复制的“丢数据窗口”
> 主节点宕机、副本被提升后，**旧主上尚未复制的已确认写永久丢失**；旧主恢复后其多余的写要被丢弃或人工处理（还可能与新主产生冲突，造成**脑裂**），见 [故障模型与脑裂](#/distributed/fault)。涉及资金、订单的数据要用半同步/多数派同步并配合对账。

### 复制的实现方式

| 方式 | 说明 | 特点 |
| --- | --- | --- |
| **基于语句** | 复制 SQL 语句 | 体积小，但 `NOW()`、`RAND()`、自增、触发器等非确定性语句会导致副本不一致，**基本不推荐** |
| **物理日志（WAL）传输** | 复制底层存储的字节级变更 | 精确、高效；**与存储引擎和版本强绑定**，难以跨版本升级、不能选择性复制（PostgreSQL 流复制） |
| **逻辑日志** | 以行为单位的变更记录（MySQL ROW 格式 binlog、PG 逻辑复制） | 与引擎解耦，可跨版本、可订阅给外部系统（CDC），见 [CDC 与实时数仓架构](#/bigdata/cdc) |
| **基于触发器/应用层** | 应用或触发器记录变更 | 灵活但开销大、易出错 |
| **共识日志复制** | Raft/Paxos 的日志 | 强一致，见 [Raft 与共识算法](#/distributed/consensus) |

### 故障切换（Failover）

自动故障切换的难点：

1. **判断主确实故障**（超时过短误判、过长恢复慢）；
2. **选新主**（数据最新的副本；半同步下优先含最新已确认写的副本）；
3. **重新配置客户端与副本**到新主；
4. **处理旧主恢复**：必须**降级为副本并丢弃/回滚多余写**，防止双主（**fencing**）；
5. **主键/自增冲突**：旧主上未复制的自增 ID 可能被新主重新分配，引发下游/缓存不一致。

数据库层面的实践（MySQL MHA/Orchestrator/Group Replication、PostgreSQL Patroni）与共识型自动选主（etcd/Raft 管理）差异，见 [MySQL 主从复制与 binlog](#/mysql/replication)（如已收录）与 [Redis 主从、哨兵与 Cluster](#/redis/cluster)。

### 复制延迟带来的读异常

主从异步复制时，从库落后主库**毫秒到秒、极端时分钟**。读从库会出现：

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="复制延迟的三种读异常：读自己的写读不到，用户提交评论后刷新从库看不到；读到旧版本再读到新版本又读到旧版本的单调读被破坏，两次读落在不同副本；因果倒置，观察者先看到回答后看到问题；以及对应的解决方案：读自己的写通过读主或带版本等待，单调读通过会话粘性到同一副本，因果一致通过携带因果令牌或同分区路由">
<rect class="b4" x="20" y="14" width="230" height="150" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">① 读不到自己的写</text>
<text class="ts" x="135" y="62" text-anchor="middle">用户提交后刷新</text>
<text class="ts" x="135" y="82" text-anchor="middle">请求落到未同步的从库</text>
<text class="ts" x="135" y="102" text-anchor="middle">看起来“写丢了”</text>
<text class="ts" x="135" y="130" text-anchor="middle">违反 read-your-writes</text>
<rect class="b4" x="270" y="14" width="230" height="150" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">② 单调读被破坏</text>
<text class="ts" x="385" y="62" text-anchor="middle">第一次读到新数据（副本 A）</text>
<text class="ts" x="385" y="82" text-anchor="middle">第二次读到旧数据（副本 B）</text>
<text class="ts" x="385" y="102" text-anchor="middle">“时间倒流”</text>
<text class="ts" x="385" y="130" text-anchor="middle">违反 monotonic reads</text>
<rect class="b4" x="520" y="14" width="220" height="150" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">③ 因果倒置</text>
<text class="ts" x="630" y="62" text-anchor="middle">问题与回答在不同分片</text>
<text class="ts" x="630" y="82" text-anchor="middle">回答复制得比问题快</text>
<text class="ts" x="630" y="102" text-anchor="middle">先看到答案后看到问题</text>
<text class="ts" x="630" y="130" text-anchor="middle">违反 consistent prefix</text>
<rect class="b2" x="20" y="180" width="230" height="150" rx="10"/>
<text class="tb" x="135" y="200" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="135" y="228" text-anchor="middle">刚写过的数据读主（带时间窗）</text>
<text class="ts" x="135" y="248" text-anchor="middle">或记录写入位点，从库等待追平</text>
<text class="ts" x="135" y="268" text-anchor="middle">或按用户把读粘到主一段时间</text>
<text class="ts" x="135" y="296" text-anchor="middle">代价：主压力上升</text>
<rect class="b2" x="270" y="180" width="230" height="150" rx="10"/>
<text class="tb" x="385" y="200" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="385" y="228" text-anchor="middle">会话粘性：同一用户总读同一副本</text>
<text class="ts" x="385" y="248" text-anchor="middle">（按用户 ID 哈希选副本）</text>
<text class="ts" x="385" y="268" text-anchor="middle">副本故障时切换要保证不回退</text>
<text class="ts" x="385" y="296" text-anchor="middle">代价：负载可能不均</text>
<rect class="b2" x="520" y="180" width="220" height="150" rx="10"/>
<text class="tb" x="630" y="200" text-anchor="middle" dominant-baseline="middle">对策</text>
<text class="ts" x="630" y="228" text-anchor="middle">相关数据放同一分区（保序）</text>
<text class="ts" x="630" y="248" text-anchor="middle">或携带因果令牌，读等待依赖</text>
<text class="ts" x="630" y="268" text-anchor="middle">因果一致读（版本向量/HLC）</text>
<text class="ts" x="630" y="296" text-anchor="middle">代价：实现复杂</text>
</svg>
<figcaption>图 2：复制延迟的三种读异常与对策</figcaption>
</figure>

工程实践（常见组合）：

- **写后读主**：用户刚发起写操作后的短时间内（如 1~5 秒，或直到观测到副本追平）把该用户的读路由到主库，或把读标记为“需要最新”；
- **位点/GTID 等待**：写返回主库提交位点，读请求携带位点，从库等待应用到该位点再读（MySQL 的 `WAIT_FOR_EXECUTED_GTID_SET`、各类代理中间件的“读自己写”功能）；
- **会话粘性**：同一用户固定到同一个从库；
- **监控复制延迟**，延迟超过阈值时**将该从库从读池摘除**；
- **关键路径不读从**：下单后的订单详情、资金余额等强一致读直接读主；
- 与缓存配合时，注意**缓存里可能放进旧值**（读从库回填缓存），见 [缓存设计与一致性](#/redis/cache)。

## 多主复制

### 适用场景

| 场景 | 说明 |
| --- | --- |
| **多数据中心** | 每个中心有一个主，用户写本地，异步复制到其他中心：写延迟低、容忍整个中心故障 |
| **离线客户端** | 手机/笔记本本地即“一个主”，联网后同步（如日历、笔记应用） |
| **协作编辑** | 每个用户的编辑器是一个副本，实时互相同步（OT/CRDT） |

代价：**写冲突**。单主下同一数据的写被串行化；多主下两个主可能**并发修改同一数据**，同步时发现冲突。

### 冲突检测与避免

- **避免冲突**（最佳）：把同一份数据的所有写路由到**同一个主**（如按用户归属地域、按数据主键哈希），在地域内相当于单主，跨地域只做异步备份与故障接管；
- **检测冲突**：同步时比较版本——基于版本向量/修订号判断两个更新是否并发；
- **同步 vs 异步检测**：同步检测要先写所有主（失去多主的意义），实际多为**异步检测**，冲突在复制到达时发现。

### 冲突解决策略

| 策略 | 做法 | 优缺点 |
| --- | --- | --- |
| **LWW（最后写入赢）** | 以时间戳（或 HLC）最大的写为准，其余丢弃 | 简单、收敛；**静默丢失并发更新**，且物理时钟不准会让“后写”被先写覆盖，见 [分布式时钟](#/distributed/clock)；适合缓存、会话等可丢更新的数据 |
| **保留所有版本（兄弟，siblings）** | 存储并发版本，由读取方（应用/用户）**合并** | 不丢数据；应用要实现合并逻辑（购物车取并集），Riak/Dynamo 风格 |
| **优先级规则** | 按节点 ID/地域优先级决定 | 确定性但可能丢掉“更重要”的更新 |
| **应用层合并函数** | 注册回调（如数值相加、集合并集） | 灵活，需谨慎设计满足交换/结合/幂等 |
| **CRDT** | 数据结构本身保证任意顺序合并结果相同 | 无需冲突处理，**数据类型受限**，元数据会增长（墓碑） |
| **OT（操作转换）** | 把并发操作相互转换后再应用 | 协作编辑经典方案，需要中心服务器排序，正确性难 |
| **人工解决** | 交给用户选择 | 适合低频冲突（Git 合并） |

### 多主拓扑

- **环形/星形**：复制消息沿环或经中心转发，**需要避免循环**（给写打上来源标识，节点不重复转发）；单点故障会中断复制；
- **全连接（all-to-all）**：容错好，但网络延迟不同可能造成**因果乱序**（一个主先收到“更新”后收到“创建”），需要**版本向量/因果追踪**或保证按序投递；
- **注意**：多主下自增主键、唯一约束、触发器、级联删除等数据库特性会遇到各种坑，**很多数据库的多主模式限制很多**，慎用。

## 无主复制（Dynamo 风格）

### Quorum 读写

N 个副本；写需要 **W** 个确认，读需要 **R** 个响应。**W + R > N** 时读集合与写集合必有交集，读到至少一个最新副本（再通过版本选最新）。

| 配置（N=3） | 含义 |
| --- | --- |
| W=2, R=2 | 读写都容忍 1 个副本不可用，常用均衡配置 |
| W=3, R=1 | 写强（全部确认）、读快；写可用性低（任一副本故障写失败） |
| W=1, R=3 | 写快、读重 |
| W=1, R=1 | 无交集保证，最终一致，最快 |

> [!WARNING] Quorum 不等于强一致
> 即使 W+R>N，以下情况**仍可能读到旧值**：①**sloppy quorum + 提示移交**（写被临时发到非指定副本，读不一定覆盖）；②**并发写**导致版本冲突，LWW 时钟问题；③写在部分副本成功但整体失败（**不回滚**），读可能读到失败的写；④副本故障恢复时用旧数据补充，破坏已计算的 Quorum；⑤时序：读与写并发，读可能先到未更新的副本。若要强一致，应使用共识协议，见 [Paxos 与共识算法族](#/distributed/paxos)。

### 数据修复：读修复与反熵

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="无主复制的数据修复：读取时向多个副本读取并比较版本，发现旧副本后把新值写回称为读修复；后台的反熵进程用 Merkle 树比较副本间的数据差异并只同步不一致的范围；写入时对暂时不可用的副本，由其他节点保存提示（hinted handoff），待恢复后移交；三者互补">
<rect class="b3" x="20" y="14" width="230" height="170" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">读修复（Read Repair）</text>
<text class="ts" x="135" y="62" text-anchor="middle">读时向多个副本取值</text>
<text class="ts" x="135" y="82" text-anchor="middle">比较版本，选最新返回</text>
<text class="ts" x="135" y="102" text-anchor="middle">顺手把新值写回旧副本</text>
<text class="ts" x="135" y="130" text-anchor="middle">＋ 热数据快速收敛</text>
<text class="ts" x="135" y="150" text-anchor="middle">－ 冷数据长期不读不修复</text>
<rect class="b5" x="270" y="14" width="230" height="170" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">反熵（Anti-Entropy）</text>
<text class="ts" x="385" y="62" text-anchor="middle">后台定期比对副本数据</text>
<text class="ts" x="385" y="82" text-anchor="middle">用 Merkle 树按范围对比哈希</text>
<text class="ts" x="385" y="102" text-anchor="middle">只同步不一致的范围</text>
<text class="ts" x="385" y="130" text-anchor="middle">＋ 覆盖冷数据，保证最终一致</text>
<text class="ts" x="385" y="150" text-anchor="middle">－ 占 IO 与 CPU，需限速</text>
<rect class="b1" x="520" y="14" width="220" height="170" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">提示移交（Hinted Handoff）</text>
<text class="ts" x="630" y="62" text-anchor="middle">目标副本暂时宕机</text>
<text class="ts" x="630" y="82" text-anchor="middle">其他节点代存写入+提示</text>
<text class="ts" x="630" y="102" text-anchor="middle">恢复后移交</text>
<text class="ts" x="630" y="130" text-anchor="middle">＋ 提高写可用性</text>
<text class="ts" x="630" y="150" text-anchor="middle">－ 提示过期/丢失则需反熵</text>
<rect class="bg" x="20" y="202" width="720" height="118" rx="8"/>
<text class="th" x="32" y="222">Merkle 树的作用</text>
<text class="ts" x="380" y="246" text-anchor="middle">每个副本对键范围构建哈希树：叶子是数据的哈希，父节点是子节点哈希的哈希</text>
<text class="ts" x="380" y="268" text-anchor="middle">两副本比对根哈希：相同则一致；不同则沿树向下比较，快速定位不一致的范围，只传输差异</text>
<text class="ts" x="380" y="290" text-anchor="middle">避免全量比对，节省网络与 IO；代价是维护树的开销（写入更新树）</text>
<text class="ts" x="380" y="310" text-anchor="middle">Gossip 协议用于成员与状态传播，是这类系统的基础设施</text>
</svg>
<figcaption>图 3：无主复制的三种数据修复机制</figcaption>
</figure>

### 无主系统的特点与代价

| 特点 | 说明 |
| --- | --- |
| **无故障切换** | 没有“选主”过程，节点故障时请求自然落到其他副本，**可用性高、尾延迟低**（等最快的 W/R 个响应） |
| **最终一致** | 副本最终收敛，窗口内读可能旧 |
| **冲突需要处理** | 并发写产生兄弟版本，需 LWW/合并/CRDT |
| **版本元数据** | 版本向量/时间戳随写入增长，需裁剪 |
| **范围查询与二级索引受限** | 数据按哈希分布，范围扫描代价高 |
| **运维** | 调参（N/W/R）、修复（repair）调度、墓碑清理（删除标记要保留到所有副本同步后才能清理，否则“僵尸数据复活”） |
| **典型产品** | Amazon Dynamo 论文、Cassandra、Riak、ScyllaDB；MongoDB/ES 使用主副本模型，不属于此类 |

## CRDT：让合并无需协调

**CRDT（无冲突复制数据类型）** 通过**数学性质**保证：不同副本以任意顺序、任意次数（幂等）应用更新，最终状态相同。两大类：

| 类别 | 机制 | 要求 |
| --- | --- | --- |
| **状态型（CvRDT）** | 副本间传输**完整状态**，用**合并函数（join）** 合并 | 合并满足**交换律、结合律、幂等**（状态构成半格） |
| **操作型（CmRDT）** | 传输**操作**，各副本应用 | 操作需**可交换**，并且传输层保证**因果有序、至少一次**（或操作幂等） |

常见 CRDT：

| 类型 | 做法 | 说明 |
| --- | --- | --- |
| **G-Counter（只增计数器）** | 每个副本一个计数分量，求和得总数，合并取各分量最大值 | 只增 |
| **PN-Counter** | 两个 G-Counter（增、减），值 = 增 − 减 | 可增可减 |
| **G-Set / 2P-Set** | 只增集合 / 增删各一个集合（删除后不可再添加） | 删除语义受限 |
| **OR-Set（Observed-Remove Set）** | 每次添加带唯一标签，删除只删“已观察到的标签” | 支持并发的“添加优先” |
| **LWW-Register** | 带时间戳的单值，取最大 | 简单，丢并发更新 |
| **序列 CRDT（RGA、Logoot、LSEQ、Yjs/Automerge 的结构）** | 为每个字符分配**全局唯一且可排序的位置标识** | 协作文本编辑，元数据较大，需要垃圾回收墓碑 |

使用要点：**CRDT 适合“可交换的更新”**（计数、点赞、集合、购物车、协作文档、在线状态），**不适合需要“不变式”约束的场景**（如余额不能为负、库存不能超卖——这类约束需要协调/事务）。**墓碑与元数据膨胀**是长期运行的主要工程难点。

## 链式复制与其他变体

| 方案 | 做法 | 特点 |
| --- | --- | --- |
| **链式复制（Chain Replication）** | 副本排成链：写从头部进入，沿链传播，**尾部确认**；读从尾部 | **强一致**，吞吐高（头部卸载了复制扇出），读只打尾部；故障需要重配置链；CRAQ 允许任意节点读 |
| **主-备（Primary-Backup）带状态转移** | 主执行请求，把结果状态传给备 | 适合非确定性操作 |
| **状态机复制（SMR）** | 所有副本执行相同的有序命令 | 需要共识排序与确定性执行 |
| **多副本存储的纠删码** | 数据切片 + 校验块代替多副本 | 降低存储成本（对象存储），修复代价高，见 [分布式文件/对象存储](#/design/case-objectstore) |

## 选型与组合

| 需求 | 方案 |
| --- | --- |
| 事务数据、强一致、自动故障切换 | **单主 + 共识复制**（分布式 SQL 的 Multi-Raft）或**数据库主从 + 半同步 + 编排工具** |
| 读多写少、读扩展 | 单主 + 多个异步只读副本，配合读主/会话粘性处理一致性 |
| 多地域用户，写要就近 | **按用户/租户地域归属路由**（单主分区化，写不冲突）为首选；其次多主 + 冲突策略 |
| 极高写可用性、可接受最终一致（购物车、会话、画像） | 无主（Dynamo 风格）+ 版本向量/CRDT |
| 协作编辑、离线优先 | **CRDT / OT** |
| 海量对象存储 | 纠删码 + 元数据强一致，见 [分布式文件/对象存储](#/design/case-objectstore) |
| 缓存 | 主从/分片，注意主从异步丢写与旧读，见 [Redis 主从、哨兵与 Cluster](#/redis/cluster) |

## 常见问题

| 现象 | 根因 | 对策 |
| --- | --- | --- |
| 提交后立刻读不到 | 读从库，复制延迟 | 写后读主、位点等待、会话粘性 |
| 主故障切换后丢了数据 | 异步复制，新主缺少最近写 | 半同步/多数派同步；选最新副本；对账补偿 |
| 旧主恢复后出现双主/数据分叉 | 缺少 fencing，旧主继续接受写 | 隔离旧主（STONITH/租约/fencing token），恢复后回滚多余写 |
| 多主冲突导致数据被静默覆盖 | LWW + 时钟漂移 | 避免冲突（路由归属）；用版本向量/业务合并；监控时钟偏移 |
| 删除的数据“复活” | 无主复制中墓碑过早清理，旧副本把数据同步回来 | 墓碑保留期大于最大副本离线时间，定期 repair |
| 复制延迟持续增大 | 从库单线程回放、大事务、网络/IO 瓶颈 | 并行复制、拆大事务、升级硬件、限流写入 |
| 从库读到半截数据（未提交事务） | 复制模式/隔离级别问题 | 使用基于 GTID/多线程一致的复制，了解快照读语义 |
| 自增 ID 冲突 | 多主各自自增 | 步长+偏移或使用分布式 ID，见 [分布式 ID 生成](#/distributed/id) |
| 读修复造成读放大 | 热点读触发大量修复写 | 合理 R 值，修复限流 |
| 跨地域复制延迟大导致业务异常 | 异步复制跨洲 | 业务按地域分区，容忍延迟或同步到少量节点 |

## 相关阅读

- [CAP、BASE 与一致性模型](#/distributed/theory)：一致性谱系与 Quorum NWR
- [Paxos 与共识算法族](#/distributed/paxos)：强一致复制的共识路线
- [分布式时钟](#/distributed/clock)：LWW、HLC 与版本向量
- [分片、一致性哈希与再平衡](#/distributed/partitioning)：复制与分片的组合
- [故障模型、故障检测与脑裂](#/distributed/fault)：故障切换与 fencing
- [案例：在线协作文档设计详解](#/design/case-collab)：OT/CRDT 实战

## 面试追问

> [!QUESTION] 主从复制有哪几种同步方式？各有什么取舍？
> 异步复制主节点本地提交就返回，延迟低、可用性高，但主故障可能丢最近的已确认写；全同步等所有副本确认，数据最安全但任一副本故障会阻塞写；半同步等至少一个副本确认，是常见折中，副本慢时可降级为异步。强一致要求用多数派同步，即共识。

> [!QUESTION] 复制延迟会带来哪些问题？怎么解决？
> 会读不到自己刚写的数据、两次读落在不同副本造成时间倒流、因果倒置。解决：刚写过的数据读主或等待从库追平位点，同一用户粘性读同一副本，相关数据放同一分区或携带因果令牌，并监控延迟、把落后过多的从库摘除，关键强一致读直接读主。

> [!QUESTION] 多主复制的冲突怎么处理？
> 首先尽量避免冲突，把同一数据的写路由到同一个主；其次检测冲突并选择策略：LWW 简单但会丢并发更新且受时钟影响，保留兄弟版本交给应用合并，应用层合并函数，或者使用 CRDT 使合并天然无冲突，协作编辑常用 OT 或序列 CRDT。

> [!QUESTION] Quorum 的 W+R>N 能保证强一致吗？
> 不能。它只保证读写集合相交，但 sloppy quorum 与提示移交、并发写与时钟问题、写在部分副本成功后失败不回滚、副本恢复用旧数据等情况仍会读到旧值或脏值。强一致需要共识协议或带领导者的协议，Quorum 只提供更强的最终一致。

> [!QUESTION] 无主复制如何修复副本间的不一致？
> 三种机制互补：读修复在读取时发现旧副本并回写新值，只覆盖被读的热数据；反熵后台用 Merkle 树比对副本，只同步不一致的范围，覆盖冷数据；提示移交让其他节点暂存宕机副本的写，待恢复后移交。删除要保留墓碑直到所有副本同步，防止数据复活。

> [!QUESTION] CRDT 是什么？适合什么、不适合什么？
> 无冲突复制数据类型，通过交换、结合、幂等的合并设计，使各副本以任意顺序应用更新最终状态一致，有状态型和操作型两类，如计数器、OR-Set、LWW 寄存器、序列 CRDT。适合计数、集合、协作编辑等可交换更新；不适合需要不变式的场景如余额不能为负、库存不能超卖，这类需要协调或事务；还要处理墓碑与元数据膨胀。

> [!QUESTION] 主从切换后为什么需要 fencing？
> 旧主可能只是被网络隔离或暂停，恢复后仍以为自己是主继续接受写，造成双主与数据分叉。需要通过租约、STONITH 或 fencing token 保证旧主被隔离或其写入被资源端拒绝，并在恢复后回滚它未复制的多余写。
