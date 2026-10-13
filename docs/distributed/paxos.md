---
level: 深入
tags: [Paxos, Multi-Paxos, Raft, ZAB, Viewstamped Replication, EPaxos, Flexible Paxos, 共识, 日志复制, 拜占庭容错, PBFT]
summary: Paxos 与共识算法族的原理与对比：Basic Paxos 的两阶段与安全性证明直觉、活性问题与领导者、Multi-Paxos 的日志槽与空洞处理、Fast/Flexible/EPaxos 等变体、Viewstamped Replication 与 ZAB、与 Raft 的逐项对比、读路径（租约读/ReadIndex）与成员变更等工程问题、实际系统的选择，以及拜占庭容错的边界。
---

# Paxos 与共识算法族：原理、变体与对比

> [!ABSTRACT] 核心要点
> - **共识**要解决的问题：一组可能故障、消息可能丢失乱序延迟的节点，如何**就一个值（或一串值）达成一致**，且满足 **安全性（Safety：不会决定出两个不同的值）** 与 **活性（Liveness：最终能决定）**。FLP 不可能性告诉我们：异步系统里**无法同时保证二者在所有情况下成立**，实际算法保证**安全性永远成立**，**活性依赖“网络最终稳定”**这类假设。
> - **Basic Paxos** 用**两阶段**决定单个值：**Prepare/Promise**（抢占提案号并承诺不接受更小编号，同时取回已接受的最高编号值）+ **Accept/Accepted**（在多数派上接受值）。核心规则只有一条：**提案者必须采用它在 Promise 中看到的编号最高的已接受值**，否则才能用自己的值——这条规则使得“已被多数派接受的值”不会被覆盖。
> - 实际系统需要的是**一串值（复制日志）**：**Multi-Paxos** 选出稳定的**领导者**，对每个日志槽（slot）只需**一次 Accept 往返**（跳过 Prepare），遇到**空洞**用 no-op 填补；**Raft、ZAB、Viewstamped Replication** 本质上都是“领导者 + 日志复制”的 Multi-Paxos 家族，只是在**日志连续性、选主约束、成员变更**上做了更易实现的取舍。
> - **多数派（Quorum）** 是共识的数学根基：任意两个多数派必有交集，所以后来者一定能“看到”前面已经决定的值。**Flexible Paxos** 指出：只要**两个阶段的法定集合相交**即可，不必都取多数，可以用“小的 Accept 集合 + 大的 Prepare 集合”换取更低的稳定期延迟。
> - 工程上共识协议的难点不在“协议图”，而在：**磁盘 fsync、批处理与流水线、快照与日志压缩、读路径（线性一致读）、成员变更、故障检测与选主抖动、与状态机的幂等应用**。
> - **拜占庭容错（BFT）** 假设节点可能作恶，需要 3f+1 个节点，开销高；企业内部系统通常只需**崩溃容错（CFT）**，即 2f+1 个节点容忍 f 个崩溃。

## 共识问题与基本假设

| 概念 | 说明 |
| --- | --- |
| **系统模型** | 节点会**崩溃停止/重启**（崩溃恢复），消息可能**丢失、延迟、重复、乱序**，但**不篡改**；时钟不可靠 |
| **安全性（Safety）** | **一致性**（Agreement）：不会有两个节点决定不同的值；**有效性**（Validity）：决定的值必须是某个节点提出过的 |
| **活性（Liveness）** | **终止**：只要多数节点存活并能通信、网络足够稳定，最终会决定 |
| **FLP 不可能性** | 在完全异步、允许一个节点崩溃的系统中，**没有确定性算法能保证有限时间内一定达成共识**。实际做法：保证 Safety 恒成立，Liveness 借助超时/随机/领导者在“多数时候”达到 |
| **容错能力** | 崩溃容错：N = 2f + 1 节点容忍 f 个故障；拜占庭：N = 3f + 1 |
| **复制状态机（RSM）** | 共识用于给所有副本一个**相同顺序的命令日志**，各副本**确定性地**按序应用到状态机，得到相同状态；数据库、协调服务、元数据存储都是这个模式 |

Raft 的任期、日志匹配、选主与成员变更见 [Raft 与共识算法](#/distributed/consensus)，本页聚焦 Paxos 族与整体对比。

## Basic Paxos

### 角色与两阶段

三个角色（一个节点可兼任多个）：**Proposer（提案者）**、**Acceptor（接受者）**、**Learner（学习者）**。每个提案是 `(编号 n, 值 v)`，编号全局唯一且可比较（常用 `(轮次, 节点ID)`）。

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Basic Paxos 两阶段：阶段 1a 提案者发送 Prepare(n) 给多数 Acceptor；阶段 1b Acceptor 若 n 大于已承诺的编号则承诺不再接受小于 n 的提案，并返回已接受的最大编号提案；阶段 2a 提案者若收到多数 Promise，选择返回中编号最大的已接受值，若没有则用自己的值，发送 Accept(n, v)；阶段 2b Acceptor 若未承诺更大编号则接受；多数 Acceptor 接受则值被决定">
<rect class="b3" x="20" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="55" text-anchor="middle" dominant-baseline="middle">Proposer</text>
<rect class="b1" x="300" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="360" y="55" text-anchor="middle" dominant-baseline="middle">Acceptor 1</text>
<rect class="b1" x="450" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="510" y="55" text-anchor="middle" dominant-baseline="middle">Acceptor 2</text>
<rect class="b1" x="600" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="660" y="55" text-anchor="middle" dominant-baseline="middle">Acceptor 3</text>
<line class="ld" x1="80" y1="80" x2="80" y2="340"/>
<line class="ld" x1="360" y1="80" x2="360" y2="340"/>
<line class="ld" x1="510" y1="80" x2="510" y2="340"/>
<line class="ld" x1="660" y1="80" x2="660" y2="340"/>
<line class="l" x1="80" y1="110" x2="360" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="80" y1="110" x2="510" y2="124" marker-end="url(#arr)"/>
<text class="ta" x="230" y="104">1a Prepare(n)</text>
<line class="la" x1="360" y1="150" x2="80" y2="160" marker-end="url(#arr-a)"/>
<line class="la" x1="510" y1="154" x2="80" y2="166" marker-end="url(#arr-a)"/>
<text class="ta" x="230" y="146">1b Promise(n, 已接受的最大 (n', v'))</text>
<rect class="bg" x="30" y="184" width="300" height="44" rx="6"/>
<text class="ts" x="180" y="202" text-anchor="middle">选值规则：若 Promise 中有已接受值，</text>
<text class="ts" x="180" y="220" text-anchor="middle">必须采用编号最大的那个 v'；否则用自己的 v</text>
<line class="l" x1="80" y1="256" x2="360" y2="266" marker-end="url(#arr)"/>
<line class="l" x1="80" y1="256" x2="510" y2="270" marker-end="url(#arr)"/>
<text class="ta" x="230" y="250">2a Accept(n, v)</text>
<line class="la" x1="360" y1="296" x2="80" y2="306" marker-end="url(#arr-a)"/>
<line class="la" x1="510" y1="300" x2="80" y2="312" marker-end="url(#arr-a)"/>
<text class="ta" x="230" y="292">2b Accepted(n, v)</text>
<text class="ts" x="600" y="200" text-anchor="middle">Acceptor 规则</text>
<text class="ts" x="600" y="222" text-anchor="middle">Prepare(n)：n &gt; 已承诺 → 承诺</text>
<text class="ts" x="600" y="242" text-anchor="middle">Accept(n,v)：n ≥ 已承诺 → 接受</text>
<text class="ts" x="600" y="262" text-anchor="middle">状态必须先落盘再回复</text>
<text class="ts" x="600" y="296" text-anchor="middle">多数派接受 ⇒ 值被决定</text>
</svg>
<figcaption>图 1：Basic Paxos 的两阶段消息流</figcaption>
</figure>

### 为什么安全：核心不变式

关键性质：**一旦某个值被多数派接受（即被“选定”），之后任何更高编号的提案，其值都必然等于这个值。**

直觉论证：

1. 值 `v` 在编号 `n` 被多数派 A 接受；
2. 之后有提案者以更大编号 `m > n` 执行 Prepare，需要从**多数派 B** 收到 Promise；
3. **A 与 B 必有交集**（任意两个多数派相交），交集中的 Acceptor 既接受过 `(n, v)`，又对 `m` 做了 Promise，会把 `(n, v)` 返回给提案者；
4. 提案者**必须选用返回中编号最大的已接受值**。因为 `n` 之后没有更大编号被接受（否则归纳地它的值也是 `v`），选出的值就是 `v`。

所以“**多数派相交 + 承诺不接受更小编号 + 采用最大编号已接受值**”三者共同保证安全。

### 一个例子：并发提案如何被收敛

- P1 提出 `(1, X)`：Prepare(1) 得到 A、B 的 Promise，发 Accept(1, X) 给 A；
- 此时 P2 发 Prepare(2)，C、B 回复 Promise（B 此前承诺 1，现承诺 2）；B 回复中**没有已接受值**（B 尚未接受 X），C 也没有，于是 P2 可以用自己的值 Y，发 Accept(2, Y) 给 B、C，多数派 {B,C} 接受 → **Y 被决定**；
- P1 的 Accept(1, X) 到达 B 时，B 已承诺 2，**拒绝**；A 虽接受了 `(1, X)`，但不是多数，**X 没有被决定**；
- 之后 P1 重新以更大编号 3 发起，Prepare 会从 A（`(1,X)`）、B/C（`(2,Y)`）看到编号最大的已接受是 `(2,Y)`，必须用 Y。

### 活性问题：对决（duelling proposers）

两个提案者轮流用更大的编号抢占对方（P1 的 Prepare 使 P2 的 Accept 失败，P2 再 Prepare 使 P1 的 Accept 失败……），可能**无限循环**。对策：**选出唯一领导者**由其提案，其他节点只在检测到领导者失效后才竞选，并配合**随机化退避**。这就是 Multi-Paxos 引入稳定领导者的原因。

## Multi-Paxos

### 日志槽与稳定领导者

复制状态机需要决定**一个序列**：第 1 条命令、第 2 条命令……每个**槽位（slot/instance）**运行一轮 Paxos。朴素做法每个槽两阶段，开销大。优化：

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Multi-Paxos：领导者当选时对所有未决槽位一次性执行 Prepare 取得领导权；之后对每个新命令只需一次 Accept 往返；日志按槽位排列，可能出现空洞，新领导者用 no-op 填补未决槽位，已决定的槽位被所有副本按顺序应用到状态机；故障切换时新领导者重新执行 Prepare 并从多数派恢复已接受的值">
<rect class="b3" x="20" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">选主（一次 Prepare）</text>
<text class="ts" x="105" y="74" text-anchor="middle">对所有未决槽位生效</text>
<rect class="b5" x="210" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="295" y="52" text-anchor="middle" dominant-baseline="middle">稳定期：每槽 1 次 Accept</text>
<text class="ts" x="295" y="74" text-anchor="middle">1 个往返即可决定</text>
<rect class="b4" x="400" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="485" y="52" text-anchor="middle" dominant-baseline="middle">领导者故障</text>
<text class="ts" x="485" y="74" text-anchor="middle">新主重新 Prepare</text>
<rect class="b2" x="590" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="665" y="52" text-anchor="middle" dominant-baseline="middle">恢复未决槽位</text>
<text class="ts" x="665" y="74" text-anchor="middle">采用已接受值/no-op</text>
<line class="l" x1="190" y1="62" x2="210" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="62" x2="400" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="62" x2="590" y2="62" marker-end="url(#arr)"/>
<text class="th" x="20" y="124">日志（槽位）视图：某副本</text>
<rect class="b2" x="20" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="55" y="154" text-anchor="middle" dominant-baseline="middle">1 已决定</text>
<rect class="b2" x="96" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="131" y="154" text-anchor="middle" dominant-baseline="middle">2 已决定</text>
<rect class="b" x="172" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="207" y="154" text-anchor="middle" dominant-baseline="middle">3 空洞</text>
<rect class="b2" x="248" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="283" y="154" text-anchor="middle" dominant-baseline="middle">4 已决定</text>
<rect class="b1" x="324" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="359" y="154" text-anchor="middle" dominant-baseline="middle">5 已接受</text>
<rect class="b" x="400" y="134" width="70" height="40" rx="6"/>
<text class="ts" x="435" y="154" text-anchor="middle" dominant-baseline="middle">6 空</text>
<text class="ts" x="620" y="150" text-anchor="middle">应用到状态机：只能按序，</text>
<text class="ts" x="620" y="168" text-anchor="middle">遇到空洞要先补齐才能越过</text>
<rect class="bg" x="20" y="196" width="720" height="124" rx="8"/>
<text class="th" x="32" y="216">要点</text>
<text class="ts" x="380" y="240" text-anchor="middle">槽位之间相互独立：允许乱序地决定（槽 4 先于槽 3 决定），因此日志可能有空洞，必须补齐才能顺序应用</text>
<text class="ts" x="380" y="262" text-anchor="middle">新领导者对空洞：先通过 Prepare 读取多数派中该槽已接受的值，有则重新提议该值；无则提议 no-op（空命令）占位</text>
<text class="ts" x="380" y="284" text-anchor="middle">Raft 的取舍：要求日志无空洞（严格连续、按序复制），选主时要求候选人日志足够新——实现更简单，但牺牲了乱序提交的灵活性</text>
<text class="ts" x="380" y="306" text-anchor="middle">领导者是性能优化，不是正确性前提：多个自认领导者同时存在时，Paxos 的编号机制仍保证安全，只损失活性</text>
</svg>
<figcaption>图 2：Multi-Paxos 的领导者、日志槽与空洞处理</figcaption>
</figure>

### 与单值 Paxos 的差异小结

| 方面 | Basic Paxos | Multi-Paxos |
| --- | --- | --- |
| 决定对象 | 一个值 | 一个值的序列（日志） |
| 每个值的开销 | Prepare + Accept 两个往返 | **稳定领导者下一个往返** |
| 领导者 | 无需，但会对决 | **稳定领导者**，降低冲突 |
| 日志形态 | — | 槽位独立，可有空洞，需 no-op 补齐 |
| 论文与实现 | 论文清晰 | **论文只描述了 Basic Paxos，Multi-Paxos 细节留给实现者**，导致各家实现差别大、难度高（“Paxos Made Live”） |

## 变体与优化

| 变体 | 思路 | 价值与代价 |
| --- | --- | --- |
| **Fast Paxos** | 客户端直接把值发给 Acceptor，**跳过领导者转发**，冲突时再回退到经典轮 | 无冲突时一个往返（少一跳）；需要更大的快速法定集合（约 3N/4），冲突时更慢 |
| **Flexible Paxos** | 只要求**阶段 1 的法定集合与阶段 2 的法定集合相交**即可，不要求各自都是多数 | 稳定期用**小的 Accept 集合**降低延迟（如 N=5 取 Accept 2 个、Prepare 4 个），换取选主/故障恢复更慢更脆弱；可在地理分布场景下优化 |
| **EPaxos（Egalitarian Paxos）** | **无领导者**，任何副本可提议；对**互不冲突的命令并行提交**，冲突命令通过依赖图排序 | 广域网下延迟低、负载均衡；实现与依赖图执行复杂，冲突多时退化；工程使用少 |
| **Mencius** | 轮转槽位所有权，多个领导者分摊 | 广域多主，负载均衡；慢节点会拖慢 |
| **Generalized Paxos** | 命令不冲突可不排序 | 理论推广 |
| **WPaxos 等** | 对象粒度的领导者迁移，适合地理分布 | 研究型 |

选择建议：绝大多数系统用**领导者型（Multi-Paxos/Raft）**即可；除非有明确的**广域低延迟**或**多主**需求，才考虑 EPaxos 类变体。

## Viewstamped Replication 与 ZAB

| 算法 | 来源 | 特点 |
| --- | --- | --- |
| **Viewstamped Replication（VR）** | 与 Paxos 同期独立提出，领导者称 primary，**视图（view）**对应任期，视图变更选新主 | 与 Raft 极相似；Raft 的设计很大程度受其启发；常被认为是“更清晰的 Multi-Paxos 表述” |
| **ZAB（ZooKeeper Atomic Broadcast）** | ZooKeeper 使用 | **主备**模式的原子广播：发现→同步→广播三阶段；强调**按提交顺序**与**主备切换后的一致前缀**；zxid（epoch + 计数）排序；详见 [Raft 与共识算法](#/distributed/consensus) 的 ZAB 章节 |
| **Raft** | Ongaro 2014 | 为**可理解性**设计：强领导者、日志连续、随机选举超时、联合共识成员变更 |

三者的共同点：**领导者 + 多数派复制有序日志 + 选主时保证新领导者拥有所有已提交日志**。

## Raft 与 Multi-Paxos 逐项对比

| 维度 | Multi-Paxos | Raft |
| --- | --- | --- |
| **领导者** | 优化手段，可多主并存（仍安全） | **强领导者**，所有写经领导者 |
| **日志** | 槽位独立，可有空洞，可乱序决定 | **连续无空洞**，必须按序复制 |
| **选主约束** | 任何节点可当选，当选后**补齐**缺失日志 | **只有日志足够新的节点**能当选，避免补齐 |
| **提交规则** | 槽位被多数接受即决定 | 领导者在**当前任期**有日志被多数复制才提交（间接提交旧任期） |
| **成员变更** | 论文未规定，实现自定 | **明确**：联合共识或单步变更 |
| **复杂度/可理解性** | 难，论文留白多 | 易，规范完整，社区实现多 |
| **灵活性** | 高（并行提交、变体丰富） | 较低但够用 |
| **使用实例** | Chubby、Spanner 的 Paxos 组、OceanBase、PolarDB、阿里云系 | etcd、Consul、TiKV、CockroachDB、Kafka KRaft、RabbitMQ 仲裁队列 |

结论：**新系统直接用成熟的 Raft 库**（如 etcd/raft、Dragonboat、SOFAJRaft、Apache Ratis、OpenRaft）；除非有特殊需求，**不要自己实现共识**——正确性与测试成本极高。

## 工程问题

### 读路径：如何做到线性一致读

写必须经过共识，**读如果直接读本地状态可能读到旧值**（节点可能已被取代而不自知）。常见做法：

| 方式 | 做法 | 代价 |
| --- | --- | --- |
| **走日志的读** | 把读也当作一条命令提交 | 最简单，**读的延迟与吞吐等同写**，慢 |
| **ReadIndex** | 领导者记录当前提交位置，**向多数派确认自己仍是领导者**后，等状态机应用到该位置再读 | 一次心跳往返，不写日志；etcd、TiKV 采用 |
| **租约读（Lease Read）** | 领导者在选举超时内收到多数派心跳则认为租约有效，期间本地读 | **依赖时钟漂移有界**，需要把漂移纳入租约；性能最好，见 [分布式时钟](#/distributed/clock) |
| **Follower Read** | 副本向领导者取得最新已提交位置后本地读 | 分担领导者读压力，延迟多一次往返 |
| **有界旧读/快照读** | 允许读到一定时间内的旧数据 | 适合统计、报表，业务需接受 |

### 性能优化

- **批处理（Batching）**：把多条客户端请求合并成一次日志追加/一次 fsync/一次网络消息，提高吞吐；
- **流水线（Pipelining）**：不等上一批确认就发送下一批，需要处理乱序与回退；
- **并行磁盘写与网络复制**：领导者本地落盘与向副本发送同时进行；
- **fsync 是延迟地板**：每次提交至少一次磁盘强制刷盘，使用 **NVMe/带电池缓存**、把日志与数据分盘，**不要为性能关闭 fsync**（会破坏持久性保证）；
- **分组共识（Multi-Raft/Paxos Group）**：数据按范围/哈希切成许多组，每组独立共识，领导者分散到各节点，水平扩展，见 [TiDB 架构与存储](#/db/tidb-arch)；
- **心跳合并**：Multi-Raft 下合并各组心跳以减少开销。

### 快照与日志压缩

日志不能无限增长：定期对状态机做**快照**，截断快照之前的日志；落后太多的副本通过**安装快照**追赶。要点：快照期间不阻塞写（写时复制/分块）、快照校验、传输限速。

### 成员变更

增减节点是危险操作（新旧配置的多数派可能不相交导致脑裂）：Raft 用**联合共识**或**一次只变更一个节点**；Paxos 系的做法是把配置变更也作为日志命令，生效点延后若干槽。实践：先加 **Learner（不参与投票的追赶副本）** 追平数据，再提升为投票成员，避免新节点拖慢提交。

### 故障检测与选主抖动

- 选举超时要大于心跳间隔与网络抖动，避免**误判故障引发频繁选主**（选主期间不可写）；
- **Pre-Vote** 防止被分区隔离的节点恢复后用大任期打断稳定的领导者；
- 磁盘慢、GC 停顿、CPU 争抢都会表现为“领导者失联”；监控选主次数；
- 与 [分布式协调](#/mw/coordination)、[故障模型与故障检测](#/distributed/fault) 中的会话/租约思想相同。

### 状态机的确定性与幂等

- 状态机必须**确定性**：不能在应用命令时读本地时间、随机数、外部状态（否则各副本结果不同）；时间戳应由领导者写入命令；
- 客户端重试会导致**命令重复提交**，需要客户端会话 + 序列号实现**幂等去重**，见 [幂等设计与重试](#/distributed/idempotent)；
- 应用与持久化的原子性：先写日志，再应用，崩溃重启后重放日志要保证幂等。

## 实际系统怎么用共识

| 系统 | 共识 | 用途 |
| --- | --- | --- |
| **Google Chubby / Spanner** | Multi-Paxos | 锁服务；Spanner 每个数据分片一个 Paxos 组 + 两阶段提交跨组 |
| **ZooKeeper** | ZAB | 协调服务，见 [分布式协调](#/mw/coordination) |
| **etcd / Consul / Kubernetes** | Raft | 元数据与配置存储 |
| **TiKV / CockroachDB / YugabyteDB** | Multi-Raft | 分布式数据库的数据副本复制 |
| **Kafka（KRaft）** | Raft | 控制器元数据，取代 ZooKeeper，见 [Kafka 架构与存储](#/mw/kafka) |
| **RabbitMQ 仲裁队列、Pulsar（BookKeeper 另有协议）** | Raft / 类 Paxos 的 quorum 写 | 消息复制，见 [RabbitMQ 原理与可靠性](#/mw/rabbitmq)、[Pulsar 架构](#/mw/pulsar) |
| **OceanBase、PolarDB 等** | Multi-Paxos / Raft 变体 | 国产分布式数据库 |

注意区分：**共识用于元数据/小数据与强一致复制**，而**大数据量的存储常用链式复制/主从 + 仲裁**（成本与吞吐不同），见 [复制与一致性](#/distributed/replication)。

## 拜占庭容错（BFT）简介

当节点可能**作恶**（发送矛盾消息、伪造）时，需要拜占庭容错：

- **PBFT**：三阶段（pre-prepare、prepare、commit），**N = 3f + 1**，通信复杂度 O(N²)，节点数增加后吞吐急剧下降；
- 区块链的共识（PoW、PoS、各类 BFT 变体）解决**开放网络中不信任参与者**的问题；
- **企业内部数据中心系统一般只需崩溃容错**：节点是自己运维的，假设“不作恶，只会宕机/丢包”，用 Raft/Paxos 即可，BFT 的成本与复杂度没有必要；
- 例外：多方互不信任的联盟链、金融清算联盟、需防范内部恶意或软件 bug 导致错误输出的场景。

## 常见误区

| 误区 | 事实 |
| --- | --- |
| “Paxos 保证一定能达成共识” | 保证**安全性**，不保证**活性**（FLP）；依赖领导者与网络稳定 |
| “有了共识，系统就强一致且高可用” | CAP 仍成立：分区时少数派不可写；共识提供的是**多数派可用的强一致** |
| “三节点就能容忍两个故障” | 3 节点只容忍 **1** 个故障（多数派 2）；容忍 f 需 2f+1 |
| “偶数节点更安全” | 偶数节点不增加容错（4 节点仍只容忍 1）却增加复制开销，并可能出现无多数的平局 |
| “关闭 fsync 提升性能没关系” | 破坏持久性：已确认的提交可能在断电后丢失，多数派一起丢会让**已提交数据丢失** |
| “读本地副本就是强一致” | 可能读到旧值；需要 ReadIndex/租约/走日志 |
| “自己实现 Paxos/Raft 不难” | 论文到可用实现之间有巨大工程鸿沟（快照、成员变更、故障测试、Jepsen 验证） |
| “共识可以跨洲际低延迟” | 提交至少一个多数派往返，跨洲延迟百毫秒级；地理分布需要权衡（Flexible Paxos、分区就近领导者） |

## 相关阅读

- [Raft 与共识算法](#/distributed/consensus)：Raft 的选主、日志复制、成员变更与 ZAB
- [CAP、BASE 与一致性模型](#/distributed/theory)：一致性谱系与 Quorum
- [分布式时钟](#/distributed/clock)：租约读与时钟假设
- [分布式协调：ZooKeeper 与 etcd](#/mw/coordination)：共识的典型应用
- [故障模型、故障检测与脑裂](#/distributed/fault)：选主抖动与租约

## 面试追问

> [!QUESTION] Paxos 是怎么保证安全性的？
> 两阶段：Prepare 阶段提案者拿到多数派的承诺，承诺不再接受小于该编号的提案，并带回已接受的最大编号提案；提案者必须采用返回中编号最大的已接受值，没有才用自己的值。因为任意两个多数派相交，后来的提案者一定能从交集节点看到已被多数接受的值并沿用它，所以不会决定出不同的值。

> [!QUESTION] Multi-Paxos 相比 Basic Paxos 做了什么优化？
> 引入稳定领导者，当选时对所有未决槽位一次 Prepare，之后每个日志槽只需一次 Accept 往返；槽位独立所以日志可能有空洞，新领导者通过 Prepare 恢复已接受的值，没有就用 no-op 填补；领导者只是性能与活性优化，不影响安全性。

> [!QUESTION] Raft 和 Multi-Paxos 的主要区别？
> Raft 是强领导者、日志连续无空洞、只有日志足够新的节点能当选、成员变更有明确规范，更易理解和实现；Multi-Paxos 槽位独立、灵活，可乱序决定，但论文留白多，工程实现差异大。两者本质都是领导者加多数派复制有序日志。

> [!QUESTION] 为什么 3 个节点只能容忍 1 个故障？偶数节点为什么不好？
> 多数派要求超过半数，3 节点的多数派是 2，故障 2 个就无法形成多数；容忍 f 个故障需要 2f+1 个节点。偶数节点如 4 个仍只容忍 1 个，却增加复制开销，还可能出现 2:2 平局无法形成多数。

> [!QUESTION] 共识系统里怎么做线性一致读？
> 直接读本地可能读到旧值。方案有：把读走日志（慢）、ReadIndex（领导者确认自己仍是领导者并等应用到提交位置再读）、租约读（依赖时钟漂移有界，性能最好）、follower read（向领导者取最新提交位置后本地读）。

> [!QUESTION] FLP 不可能性对工程意味着什么？
> 在完全异步且允许节点崩溃的模型下，没有确定性算法能保证有限时间内一定达成共识。实际系统保证安全性始终成立，活性依赖超时、领导者和随机化，在网络多数时间稳定时达成；所以要监控选主频率和选举超时设置，避免活性问题。

> [!QUESTION] 什么时候需要拜占庭容错？
> 当节点可能作恶或输出错误结果且互不信任时，如联盟链、多方清算。需要 3f+1 个节点，通信开销大。企业内部自己运维的系统通常只考虑崩溃容错，用 Raft 或 Paxos 即可。
