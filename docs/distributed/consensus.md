---
level: 深入
tags: [Paxos, Raft, ZAB, ZooKeeper, etcd, 选主, 脑裂]
summary: 从 Paxos 的两阶段到 Raft 的选举、日志复制与安全性证明要点，再落到 ZooKeeper 与 etcd 的工程用法（分布式锁、选主、Lease）
---

# Raft 与共识算法

> [!ABSTRACT] 核心要点
> - 共识解决的是「多个副本对一串操作的顺序达成一致」：只要多数派存活，已提交的日志就不会丢、不会被改写。2N+1 个节点容忍 N 个故障，所以集群用奇数节点。
> - Raft 把共识拆成三件事：**Leader 选举**（随机超时 + 每任期一票 + 日志更新者优先）、**日志复制**（AppendEntries + 一致性检查 + 多数派提交）、**安全性**（选举限制 + 只按副本数提交当前任期的日志）。
> - 任期 term 是 Raft 的逻辑时钟：任何消息携带的 term 比自己大，立刻更新 term 并退回 Follower；比自己小的请求直接拒绝。这是防止旧 Leader 作乱的根本机制。
> - ZooKeeper 用 ZAB（zxid = epoch + 计数器），读默认本地处理；etcd 用 Raft，默认线性一致读，配合 MVCC 和 Lease 做配置中心、分布式锁和选主。
> - 分布式锁和选主都要防「假死的旧主」：依赖会话/租约过期 + **fencing token**（单调递增的版本号）在资源侧拦截旧主的写入。

## 共识问题与 Paxos

### 要解决什么

复制状态机（Replicated State Machine）：每个副本按**相同顺序**执行**相同的命令**，就能得到相同状态。共识算法保证的就是「日志序列一致」，并满足：

- **安全性**：永远不会返回错误结果（非拜占庭故障下：网络延迟、丢包、乱序、宕机重启）；
- **活性**：多数派存活且能互相通信时，系统能继续推进；
- **不依赖时钟保证正确性**：时钟只影响可用性（超时选举），不影响安全性。

### Basic Paxos

Lamport 的 Paxos 有三种角色：**Proposer**（提议者）、**Acceptor**（接受者，多数派构成 Quorum）、**Learner**（学习已决定的值）。一个实例只对**一个值**达成一致，分两个阶段：

| 阶段 | 消息 | Acceptor 的规则 |
| --- | --- | --- |
| 1a Prepare | Proposer 选一个全局唯一且递增的编号 n，发 `Prepare(n)` | — |
| 1b Promise | Acceptor 若 n 大于它响应过的所有编号，承诺不再接受编号小于 n 的提案，并回复自己**已接受过的编号最大的提案** `(n', v')` | 否则忽略或拒绝 |
| 2a Accept | Proposer 收到多数派 Promise：若有人回复过已接受值，必须选其中**编号最大者的值**；否则用自己的值，发 `Accept(n, v)` | — |
| 2b Accepted | Acceptor 若没有承诺过更大的编号，就接受 `(n, v)` | 被多数派接受即**已选定** |

关键点在 2a 的「必须沿用已接受的最大编号的值」：一旦某个值被多数派接受，之后任何更高编号的提案在 Phase 1 都会从交集 Acceptor 处得知这个值，从而只能继续提议它。

Basic Paxos 的问题：每个值两轮 RPC；多个 Proposer 交替抢编号可能**活锁**。**Multi-Paxos** 选出一个稳定的 Leader，后续实例跳过 Phase 1，只走 Phase 2，这就和 Raft 的形态非常接近了。但 Multi-Paxos 在论文中细节缺失（日志空洞、成员变更），工程实现差异大——这正是 Raft「可理解性优先」设计的出发点。

## Raft

### 角色与任期

- **Leader**：处理所有客户端写请求，向 Follower 复制日志、发心跳；
- **Follower**：被动响应 Leader 和 Candidate 的 RPC；
- **Candidate**：选举中的临时角色。

**任期（term）** 是单调递增的整数，每次选举开始 term+1。每个任期至多一个 Leader（可能没有，选票瓜分时）。每个节点**持久化**三样东西后才能响应 RPC：`currentTerm`、`votedFor`、`log[]`。

<figure class="fig">
<svg viewBox="0 0 720 250" class="dg" role="img" aria-label="Raft 节点状态机：Follower 选举超时变为 Candidate，获得多数票成为 Leader，发现更高任期退回 Follower">
<text class="ts" x="110" y="64" text-anchor="middle">启动</text>
<line class="l" x1="110" y1="72" x2="110" y2="98" marker-end="url(#arr)"/>
<rect class="b1" x="40" y="100" width="140" height="56" rx="8"/>
<text class="tb" x="110" y="128" text-anchor="middle" dominant-baseline="middle">Follower</text>
<rect class="b3" x="290" y="100" width="140" height="56" rx="8"/>
<text class="tb" x="360" y="128" text-anchor="middle" dominant-baseline="middle">Candidate</text>
<rect class="b2" x="540" y="100" width="140" height="56" rx="8"/>
<text class="tb" x="610" y="128" text-anchor="middle" dominant-baseline="middle">Leader</text>
<text class="ts" x="610" y="90" text-anchor="middle">周期性发送心跳</text>
<line class="l" x1="180" y1="116" x2="288" y2="116" marker-end="url(#arr)"/>
<text class="ts" x="234" y="108" text-anchor="middle">选举超时</text>
<line class="l" x1="290" y1="142" x2="182" y2="142" marker-end="url(#arr)"/>
<text class="ts" x="235" y="176" text-anchor="middle">发现合法 Leader 或更高 term</text>
<line class="la" x1="430" y1="128" x2="538" y2="128" marker-end="url(#arr-a)"/>
<text class="ts" x="484" y="118" text-anchor="middle">获得多数票</text>
<line class="l" x1="340" y1="100" x2="340" y2="70"/>
<line class="l" x1="340" y1="70" x2="380" y2="70"/>
<line class="l" x1="380" y1="70" x2="380" y2="98" marker-end="url(#arr)"/>
<text class="ts" x="360" y="56" text-anchor="middle">选票瓜分：再次超时，term+1</text>
<line class="l" x1="610" y1="156" x2="610" y2="214"/>
<line class="l" x1="610" y1="214" x2="110" y2="214"/>
<line class="l" x1="110" y1="214" x2="110" y2="158" marker-end="url(#arr)"/>
<text class="ts" x="360" y="232" text-anchor="middle">发现更高 term（如分区恢复后的旧 Leader）</text>
</svg>
<figcaption>图 1：Raft 节点状态转换</figcaption>
</figure>

### Leader 选举

1. Follower 在**选举超时**（论文建议 150～300ms 的随机值）内没收到心跳，`currentTerm++`，转为 Candidate，投自己一票，并行发送 `RequestVote(term, candidateId, lastLogIndex, lastLogTerm)`。
2. 投票规则（每个节点每个 term 只投一票，先到先得）：
   - 请求 term < 自己的 term → 拒绝；
   - 已投给别人 → 拒绝；
   - **候选人的日志不比自己旧**才投：先比最后一条日志的 term，大者更新；term 相同比 index，长者更新。
3. 结果三选一：拿到多数票成为 Leader，立刻发心跳宣示；收到 term ≥ 自己的 AppendEntries，承认对方，退回 Follower；超时无结果，term+1 重新选举。

**随机超时**让多数情况下只有一个节点率先超时并赢得选举，避免反复瓜分选票。选举超时要远大于广播耗时（心跳 RTT），远小于平均故障间隔：`broadcastTime ≪ electionTimeout ≪ MTBF`。

> [!TIP] Pre-Vote 与 CheckQuorum
> 被隔离的少数派节点会不停超时、不停 term+1，网络恢复后携带巨大的 term 回来，迫使正常 Leader 退位，造成一次无谓的选举。Raft 博士论文中的 **Pre-Vote** 让节点先试探「我能赢吗」，确认能获得多数响应后才真正增加 term；**CheckQuorum** 让 Leader 在一个选举周期内联系不上多数派时主动降级。etcd 均支持这两个选项。

### 日志复制与提交

<figure class="fig">
<svg viewBox="0 0 720 320" class="dg" role="img" aria-label="五节点 Raft 日志，index 7 已复制到 S1 S2 S4 三个节点达到多数派而提交，index 8 只在两个节点上未提交">
<text class="ts" x="700" y="20" text-anchor="end">格内数字 = 该条目写入时的 term</text>
<text class="ts" x="20" y="40">index</text>
<text class="ts" x="140" y="40" text-anchor="middle">1</text>
<text class="ts" x="210" y="40" text-anchor="middle">2</text>
<text class="ts" x="280" y="40" text-anchor="middle">3</text>
<text class="ts" x="350" y="40" text-anchor="middle">4</text>
<text class="ts" x="420" y="40" text-anchor="middle">5</text>
<text class="ts" x="490" y="40" text-anchor="middle">6</text>
<text class="ts" x="560" y="40" text-anchor="middle">7</text>
<text class="ts" x="630" y="40" text-anchor="middle">8</text>
<text class="tb" x="20" y="70" dominant-baseline="middle">S1 Leader</text>
<rect class="b1" x="110" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="140" y="70" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="180" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="210" y="70" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="250" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="280" y="70" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b5" x="320" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="350" y="70" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="390" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="420" y="70" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="460" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="490" y="70" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="530" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="560" y="70" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="600" y="52" width="60" height="36" rx="6"/>
<text class="tm" x="630" y="70" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tb" x="20" y="118" dominant-baseline="middle">S2</text>
<rect class="b1" x="110" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="140" y="118" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="180" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="210" y="118" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="250" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="280" y="118" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b5" x="320" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="350" y="118" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="390" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="420" y="118" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="460" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="490" y="118" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="530" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="560" y="118" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="600" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="630" y="118" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tb" x="20" y="166" dominant-baseline="middle">S3</text>
<rect class="b1" x="110" y="148" width="60" height="36" rx="6"/>
<text class="tm" x="140" y="166" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="180" y="148" width="60" height="36" rx="6"/>
<text class="tm" x="210" y="166" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="250" y="148" width="60" height="36" rx="6"/>
<text class="tm" x="280" y="166" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b5" x="320" y="148" width="60" height="36" rx="6"/>
<text class="tm" x="350" y="166" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="390" y="148" width="60" height="36" rx="6"/>
<text class="tm" x="420" y="166" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tb" x="20" y="214" dominant-baseline="middle">S4</text>
<rect class="b1" x="110" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="140" y="214" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="180" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="210" y="214" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="250" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="280" y="214" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b5" x="320" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="350" y="214" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="390" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="420" y="214" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="460" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="490" y="214" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="530" y="196" width="60" height="36" rx="6"/>
<text class="tm" x="560" y="214" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tb" x="20" y="262" dominant-baseline="middle">S5</text>
<rect class="b1" x="110" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="140" y="262" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="180" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="210" y="262" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="250" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="280" y="262" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b5" x="320" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="350" y="262" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="390" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="420" y="262" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b3" x="460" y="244" width="60" height="36" rx="6"/>
<text class="tm" x="490" y="262" text-anchor="middle" dominant-baseline="middle">3</text>
<line class="la" x1="595" y1="46" x2="595" y2="288"/>
<text class="ts" x="360" y="308" text-anchor="middle">commitIndex = 7：index 7 已在 S1、S2、S4 多数派上；index 8 仅 2/5，未提交</text>
</svg>
<figcaption>图 2：日志复制与多数派提交（5 节点，当前 term = 3）</figcaption>
</figure>

写请求处理流程：

1. Leader 把命令追加到本地日志（index, term, command），**并行**发送 `AppendEntries(term, leaderId, prevLogIndex, prevLogTerm, entries[], leaderCommit)`；
2. Follower 做**一致性检查**：本地 `prevLogIndex` 处的 term 必须等于 `prevLogTerm`，否则拒绝；通过则删除冲突的后续条目并追加新条目；
3. Leader 为每个 Follower 维护 `nextIndex`（下一条要发的）和 `matchIndex`（已确认复制到的位置）。被拒绝时 `nextIndex--` 重试（工程上 Follower 会回带冲突 term 的首个 index，一次回退一个 term）；
4. 某条日志被**多数派**复制，且是**当前任期**的日志，Leader 推进 `commitIndex`、应用到状态机、响应客户端；
5. 通过后续 AppendEntries 的 `leaderCommit` 字段告知 Follower 提交进度。

**Log Matching 性质**：两个日志中 index 和 term 都相同的条目，命令一定相同，且之前的所有条目也相同。归纳证明：Leader 在一个 term 内对一个 index 只创建一条日志；一致性检查保证每次追加时前一条一致。

### 安全性

只靠上面的机制还不够，Raft 加了两条约束：

1. **选举限制**：投票时要求候选人日志「至少一样新」。已提交的日志存在于多数派，新 Leader 也需要多数派投票，两个多数派必有交集，交集节点会拒绝日志较旧的候选人。所以**新 Leader 一定包含所有已提交日志**（Leader Completeness），Leader 永远只追加、不删改自己的日志。
2. **只通过计数提交当前任期的日志**：Leader 不能因为「之前任期的某条日志已复制到多数派」就提交它。论文 Figure 8 给出了反例：旧 term 的日志即便已在多数派上，仍可能被一个拥有更高 term 日志的新 Leader 覆盖。正确做法是提交当前任期的一条日志，借 Log Matching 性质**间接提交**之前的所有日志。因此新 Leader 上任后会立刻追加一条 **no-op** 日志，尽快推进提交，也让 ReadIndex 读有据可依。

> [!NOTE] 线性一致读
> 直接读 Leader 本地状态不安全——它可能已经被隔离、已有新 Leader。**ReadIndex**：记下当前 commitIndex，发一轮心跳确认自己仍是多数派认可的 Leader，等状态机应用到该位置再读。**LeaseRead**：心跳确认后的一个租期内（小于选举超时）免确认直接读，依赖各节点时钟漂移有界。etcd 默认线性一致读用 ReadIndex。

### 成员变更

直接从旧配置切到新配置，不同节点切换时机不同，可能在同一 term 出现两个多数派（旧配置的多数派 + 新配置的多数派互不相交），选出两个 Leader。

- **联合共识（Joint Consensus）**：先提交 `C_old,new` 配置日志，期间选举和提交需要**同时**获得旧、新两个配置各自的多数派；`C_old,new` 提交后再提交 `C_new`。安全，但实现复杂。
- **单节点变更**：每次只增删一个节点，新旧配置的多数派必然相交，因此可以直接切换。实现简单，是 etcd、多数工程实现的主流。注意：Ongaro 后来指出单节点变更在 Leader 切换时存在一个边界 bug，修复办法是**新 Leader 在提交本任期的一条日志（no-op）之前不处理配置变更**。
- 工程补充：新节点先以 **Learner**（不参与投票）身份追日志，追平后再提升为投票成员，避免加入瞬间拖慢提交（etcd 3.4+ 支持 learner）。

### 日志压缩与快照

日志无限增长会耗尽磁盘、拉长重启回放时间。各节点独立地把已提交（已应用）的状态做成**快照**，记录 `lastIncludedIndex` / `lastIncludedTerm`，丢弃之前的日志。Follower 落后太多（需要的日志已被 Leader 压缩），Leader 改发 **InstallSnapshot** RPC 传输快照。

快照会和写请求争抢 IO：通常用写时复制（fork、或 MVCC 存储天然的一致性视图）生成，避免阻塞状态机。

## ZAB 与 ZooKeeper

### ZAB 协议

ZooKeeper Atomic Broadcast，与 Raft 非常相似，区别在于术语与细节：

| 概念 | ZAB | Raft |
| --- | --- | --- |
| 任期 | epoch（zxid 高 32 位） | term |
| 日志序号 | zxid 低 32 位计数器，epoch 变化时归零 | index |
| 写流程 | Leader 发 PROPOSAL → 多数派 ACK → 发 COMMIT | AppendEntries → 多数派 → leaderCommit |
| 选举比较 | 先比 epoch，再比 zxid，最后比 myid（大者胜） | lastLogTerm，再比 lastLogIndex |
| 恢复 | 选举后有 Discovery、Synchronization 阶段，同步完成才对外服务 | 新 Leader 通过 AppendEntries 逐步修复 |
| 读 | 默认本地读（可能旧） | 默认线性一致读（etcd） |

另外 ZK 有 **Observer** 角色：接收并应用提交但不投票，用于扩展读能力而不拉长写入的多数派等待。

### ZNode 类型与 Watcher

| 类型 | 特点 | 用途 |
| --- | --- | --- |
| 持久节点 | 客户端断开后仍存在 | 配置、元数据 |
| 临时节点 | 与会话绑定，会话过期自动删除；不能有子节点 | 服务注册、存活检测 |
| 持久顺序 / 临时顺序 | 创建时自动追加 10 位单调递增序号 | 分布式锁、选主、队列 |
| 容器节点（3.5+） | 最后一个子节点删除后被服务端清理 | 锁的父目录 |
| TTL 节点（3.5+） | 持久节点在指定时间内无修改且无子节点时删除，需开启扩展类型 | 过期数据 |

**Watcher** 是一次性触发器：注册在 `getData` / `exists` / `getChildren` 上，事件触发一次后失效，需要重新注册，且**通知只告诉你「变了」，不携带新数据**，期间的多次变化可能只收到一次通知。3.6 起提供 `addWatch` 的持久 / 递归 Watch。

### 临时顺序节点实现分布式锁

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="ZooKeeper 分布式锁：各客户端在锁目录下创建临时顺序节点，序号最小者持锁，其他节点只监听前一个节点">
<rect class="b" x="250" y="16" width="220" height="40" rx="8"/>
<text class="tm" x="360" y="36" text-anchor="middle" dominant-baseline="middle">/locks/order_1001</text>
<line class="l" x1="330" y1="56" x2="120" y2="98" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="56" x2="360" y2="98" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="56" x2="600" y2="98" marker-end="url(#arr)"/>
<rect class="b2" x="30" y="100" width="180" height="52" rx="8"/>
<text class="tm" x="120" y="118" text-anchor="middle" dominant-baseline="middle">lock-0000000001</text>
<text class="ts" x="120" y="138" text-anchor="middle" dominant-baseline="middle">Client A：序号最小，持锁</text>
<rect class="b3" x="270" y="100" width="180" height="52" rx="8"/>
<text class="tm" x="360" y="118" text-anchor="middle" dominant-baseline="middle">lock-0000000002</text>
<text class="ts" x="360" y="138" text-anchor="middle" dominant-baseline="middle">Client B：等待</text>
<rect class="b3" x="510" y="100" width="180" height="52" rx="8"/>
<text class="tm" x="600" y="118" text-anchor="middle" dominant-baseline="middle">lock-0000000003</text>
<text class="ts" x="600" y="138" text-anchor="middle" dominant-baseline="middle">Client C：等待</text>
<line class="ld" x1="270" y1="126" x2="212" y2="126" marker-end="url(#arr)"/>
<line class="ld" x1="510" y1="126" x2="452" y2="126" marker-end="url(#arr)"/>
<text class="ts" x="240" y="174" text-anchor="middle">B watch 前驱</text>
<text class="ts" x="480" y="174" text-anchor="middle">C watch 前驱</text>
<text class="ts" x="360" y="210" text-anchor="middle">A 释放锁或会话过期 → 节点删除 → 只唤醒 B，避免羊群效应</text>
</svg>
<figcaption>图 3：基于临时顺序节点的公平分布式锁</figcaption>
</figure>

1. 在锁目录下创建**临时顺序节点**；
2. `getChildren` 排序，自己序号最小则获得锁；
3. 否则只对**前一个节点** `exists` + Watch，等它删除后回到第 2 步（不能直接认为自己拿到锁，前驱可能是因会话过期而删除，而更前面还有人）；
4. 释放锁即删除自己的节点；客户端宕机时会话过期，临时节点自动删除，不会死锁。

只监听前驱而不是监听整个目录，是为了避免**羊群效应**：一次释放唤醒所有等待者，造成大量无效的 `getChildren`。工程上直接用 Curator 的 `InterProcessMutex`（可重入）：

```java
// Curator 5.x
CuratorFramework client = CuratorFrameworkFactory.newClient(
        "zk1:2181,zk2:2181,zk3:2181",
        30_000,                                  // session timeout
        10_000,                                  // connection timeout
        new ExponentialBackoffRetry(1000, 3));
client.start();

InterProcessMutex lock = new InterProcessMutex(client, "/locks/order_1001");
if (lock.acquire(3, TimeUnit.SECONDS)) {         // 内部即「临时顺序节点 + 监听前驱」
    try {
        doBusiness();
    } finally {
        lock.release();
    }
}
```

**选主**同理：所有候选者创建临时顺序节点，序号最小者为主（Curator `LeaderLatch`）；或者抢占创建同一个临时节点，成功者为主、失败者 Watch 它（`LeaderSelector` 的另一种实现思路）。

> [!CAUTION] 会话过期 ≠ 客户端已停止工作
> 持锁客户端发生长时间 Full GC，会话超时被 ZK 删除节点，另一个客户端拿到锁；GC 结束后旧客户端以为自己还持锁继续写——双写。ZK 锁、etcd 锁、Redis 锁都有这个问题。解决：写资源时携带 **fencing token**（ZK 可用节点的 zxid / 序号，etcd 用 revision），存储侧拒绝 token 更小的写入。另见 [分布式锁](#/redis/lock)。

## etcd

etcd 是 Kubernetes 的元数据存储，核心是 **Raft + MVCC + Lease + Watch**：

- **MVCC**：每次修改分配全局递增的 `revision`；内存中用 B 树索引 `key → revision 列表`（keyIndex），数据按 revision 存在 BoltDB 中。可以读历史版本、从指定 revision 开始 Watch，不会丢事件（只要没被压缩）。
- **Lease**：带 TTL 的租约，key 绑定 Lease，客户端 `KeepAlive` 续约；租约过期，绑定的所有 key 删除。是实现服务注册、锁、选主的基础。
- **Txn**：`If(compare...).Then(ops...).Else(ops...)` 的原子事务，可以实现 CAS。
- **锁 / 选主**：`concurrency` 包中 `Mutex` 以 `prefix/leaseID` 为 key 写入，按 `CreateRevision` 排序，最小者持锁，其他人 Watch 比自己小的前一个 key——与 ZK 方案同构。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--heartbeat-interval` | 100ms | 心跳间隔，建议接近节点间 RTT |
| `--election-timeout` | 1000ms | 选举超时，建议为心跳的 10 倍左右；跨机房要调大 |
| `--quota-backend-bytes` | 2GB | 后端存储配额，超过后集群只读（NOSPACE 告警），官方建议不超过 8GB |
| `--auto-compaction-*` | 关闭 | 自动压缩历史 revision，生产必须开启并定期 defrag |
| `--snapshot-count` | 100000（3.2 起） | 多少条已应用日志后做一次快照 |

## 脑裂与奇数节点

**脑裂**：集群被分区后出现两个都认为自己是主的节点，各自接受写入，恢复后数据冲突。多数派协议从机制上避免：只有拿到多数票的才能成为 Leader，两个分区不可能都有多数派。即便旧 Leader 还没意识到自己被隔离，它也无法提交任何写入（拿不到多数派 ACK），恢复后看到更高 term 自动退位。

| 节点数 | 多数派 | 可容忍故障 | 结论 |
| --- | --- | --- | --- |
| 3 | 2 | 1 | 最小生产规模 |
| 4 | 3 | 1 | 与 3 节点容错相同，但写入多等一个节点 |
| 5 | 3 | 2 | 常用规模 |
| 6 | 4 | 2 | 与 5 节点相同，更慢 |
| 7 | 4 | 3 | 一般不再增加，写延迟变高 |

所以用奇数：偶数节点不增加容错能力，反而增加写入延迟和对称分区时（3:3）整体不可用的风险。跨机房部署时要考虑机房级故障：两机房部署 3 节点（2+1），节点多的机房宕机就不可用；建议 **三机房 2+2+1** 部署 5 节点。

## 生产实践与踩坑

- **etcd 磁盘慢导致频繁选主**：Raft 日志每次提交都要 fsync，机械盘或共享云盘延迟抖动会让心跳超时。监控 `wal_fsync_duration_seconds` 的 P99（官方建议 < 10ms）与 `leader_changes_seen_total`，etcd 用独立 SSD。
- **etcd 数据库超配额只读**：未开启自动压缩，历史 revision 堆积超过 2GB 后集群报 `mvcc: database space exceeded`。处理：compact 到当前 revision → `defrag` 每个成员 → `alarm disarm`。
- **ZK 会话超时设置不当**：太短，GC 或网络抖动就丢会话，临时节点被删、服务被误摘；太长，宕机后很久才能感知。通常 10～30 秒，并处理好 `SUSPENDED` / `LOST` 状态（Curator 的 `ConnectionStateListener`），LOST 后必须视为已失去锁。
- **ZK 存大数据**：单个 ZNode 默认上限约 1MB（`jute.maxbuffer`），且全量数据在内存、写入走多数派。ZK 只适合存元数据，不要当数据库。
- **ZK 大量 Watch 导致惊群**：几千个客户端 Watch 同一节点（如配置节点），一次修改引发几千个回调和读请求。配置中心场景用推拉结合 + 本地缓存。
- **自研 Raft 的坑**：持久化 `currentTerm` / `votedFor` 未 fsync 就回复，重启后同 term 再投一票，导致同一任期两个 Leader。优先使用成熟库：etcd/raft、SOFAJRaft、Apache Ratis。

## 相关阅读

- [TiDB 架构：TiKV、PD、Raft 与分布式事务](#/db/tidb-arch)：TiKV 中的 Raft 多副本
- [MongoDB 复制集、分片与事务](#/db/mongo-cluster)：MongoDB 复制集选举
- [分布式锁](#/redis/lock)：分布式锁与 fencing

## 面试追问

> [!QUESTION] Raft 如何保证新选出的 Leader 包含所有已提交的日志？
> 已提交日志存在于多数派；候选人要当选也需多数派投票；两个多数派必有交集节点，而投票规则要求候选人日志至少和投票者一样新（比较最后一条的 term 再比 index），所以日志缺失已提交条目的候选人不可能赢得交集节点的票。

> [!QUESTION] 为什么 Leader 不能直接提交之前任期的日志？
> 前任期的日志即使复制到多数派，也可能被后来拥有更高 term 日志的节点当选后覆盖（论文 Figure 8）。只有当前任期的日志被多数派复制才算提交，并通过 Log Matching 间接提交之前的日志；所以新 Leader 上任先写一条 no-op。

> [!QUESTION] Raft 和 ZAB 的主要区别？
> 本质都是单 Leader + 多数派。区别：ZAB 用 epoch+counter 组成 zxid，选举优先比较 zxid 和 myid，选出后有专门的同步阶段；Raft 新 Leader 通过 AppendEntries 一致性检查逐步修复 Follower。ZK 读默认本地，etcd 默认线性一致读。

> [!QUESTION] 网络分区后，旧 Leader 还在接收写请求会怎样？
> 它拿不到多数派 ACK，写入无法提交，客户端会超时；分区恢复后它看到更高 term，退为 Follower，未提交的日志被新 Leader 的日志覆盖。为减少客户端等待，可开启 CheckQuorum 让它主动降级。

> [!QUESTION] ZooKeeper 分布式锁和 Redis 分布式锁怎么选？
> ZK 锁基于会话和临时节点，客户端宕机自动释放、可公平排队、有 Watch 唤醒，可靠性高但写性能有限；Redis 锁性能高，但主从异步复制可能导致锁丢失，需要续期（看门狗）。对正确性要求高（如防重复执行的调度任务）用 ZK/etcd，对性能要求高、可容忍极少数冲突的用 Redis，两者都应在资源侧配合 fencing token。

> [!QUESTION] 为什么集群节点数是奇数？
> 2N+1 和 2N+2 个节点容忍的故障数相同（都是 N），偶数只增加写入要等待的节点数和成本；对称分区时偶数集群可能两边都不过半，整体不可用。
