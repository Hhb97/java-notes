---
level: 深入
tags: [故障模型, 故障检测, 心跳, Phi Accrual, SWIM, Gossip, 租约, fencing, 脑裂, 灰度故障, 级联故障, 亚稳态, 背压]
summary: 分布式系统的故障与应对：故障模型（崩溃、遗漏、时序、拜占庭）、网络与“灰色故障”、故障检测的根本难题（慢与死无法区分）及方案（心跳超时、Phi Accrual、SWIM/Gossip）、租约与 fencing、脑裂的成因与预防、重试风暴与级联故障、亚稳态失败、背压与过载保护，以及故障测试方法。
---

# 故障模型、故障检测与脑裂

> [!ABSTRACT] 核心要点
> - 单机程序“要么对要么挂”，分布式系统有**部分失败（partial failure）**：一部分节点/链路出问题，其余照常。更麻烦的是**你无法区分“对方宕机”“对方很慢”“网络丢了消息”**——发出请求后没收到响应，这三种情形外观完全一样。**故障检测本质上是猜测**，必然在“**检测慢（影响恢复）**”与“**误判（引发不必要切换）**”之间权衡。
> - **故障模型**决定了可用的算法：**崩溃停止/崩溃恢复**（Raft/Paxos 的假设）、**遗漏故障**（丢消息）、**时序故障**（超时）、**拜占庭**（任意恶意/错误行为）。多数企业系统假设**崩溃恢复 + 消息丢失/延迟 + 时钟不可靠**。
> - **灰色故障（gray failure）** 比“干净地宕机”更常见也更难：节点**部分功能失效、变慢、对部分客户端不可达**，心跳正常但业务超时，导致检测器认为它健康而实际已拖垮系统。要用**多视角检测（业务探针、来自调用方的观察）**而不只依赖心跳。
> - **租约（lease）+ fencing token** 是处理“旧主/旧锁持有者以为自己仍有权”的基本手段；**脑裂**（两个节点同时认为自己是主）靠**多数派（quorum）、租约、STONITH/隔离、单调递增的 fencing token**防护。
> - **重试是双刃剑**：无退避、无预算的重试会把局部故障放大成**重试风暴**与**级联故障**；系统一旦被推入**亚稳态**（过载→重试→更过载），**即使触发因素消失也难以自行恢复**，需要**负载削减与背压**。
> - **验证靠故障注入**：用混沌工程、Jepsen 风格测试、网络分区演练去**证明**容错设计，而不是相信“设计上是容错的”，见 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)。

## 故障模型

| 模型 | 含义 | 典型原因 | 对应的算法/假设 |
| --- | --- | --- | --- |
| **崩溃停止（Crash-stop）** | 节点失效后不再恢复 | 硬件故障、永久下线 | 理想化假设，便于证明 |
| **崩溃恢复（Crash-recovery）** | 节点崩溃后可能重启并**保留持久化状态、丢失内存状态** | 进程崩溃、重启、断电 | **Raft/Paxos 的标准模型**，要求关键状态**先落盘再响应** |
| **遗漏故障（Omission）** | 消息丢失或节点漏处理 | 丢包、队列满、缓冲溢出 | 重传、超时、幂等 |
| **时序故障（Timing）** | 响应超出预期时间 | 过载、GC 停顿、调度、慢盘、网络拥塞 | 部分同步模型：**多数时候有界，偶尔无界** |
| **拜占庭（Byzantine）** | 节点任意行为，含作恶、软件 bug 产生错误输出 | 恶意攻击、内存损坏、bug | PBFT/区块链共识，见 [Paxos 与共识算法族](#/distributed/paxos) |

### 网络的现实

“网络是可靠的”是分布式系统八大谬误之首。真实情况：

| 现象 | 说明 |
| --- | --- |
| **丢包/重复/乱序** | TCP 在连接内保证有序可靠，但**连接断开、重连、应用层重试**会导致重复与乱序 |
| **延迟与抖动** | 排队、拥塞、跨可用区/地域；尾延迟（P99/P999）远高于平均 |
| **网络分区** | 一部分节点之间无法通信；可能是**完全分区**、**部分分区**，也可能是**非对称**（A 能发给 B，B 的回复到不了 A） |
| **链路单向故障/MTU 问题/防火墙状态表满** | 看似“偶发超时”，常难排查，见 [计算机网络](#/cs/net-debug) |
| **DNS/服务发现延迟** | 实例已下线但地址仍被缓存 |
| **时钟问题** | 见 [分布式时钟](#/distributed/clock) |

**CAP 的含义**：分区一定会发生，系统要在分区期间选择**一致性（拒绝部分请求）**或**可用性（接受可能不一致）**，见 [CAP、BASE 与一致性模型](#/distributed/theory)。

## 故障检测

### 根本困难

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="故障检测的根本困难：发送方发送请求后没有收到响应，可能的原因包括请求丢失、对方宕机、对方处理很慢、响应丢失；这几种情形从发送方看完全一致；因此超时只是对故障的猜测，超时设置过短会误判活节点为死节点，过长则故障发现慢；误判代价包括不必要的主从切换、重复执行">
<rect class="b3" x="20" y="40" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="62" text-anchor="middle" dominant-baseline="middle">发送方</text>
<text class="ts" x="80" y="84" text-anchor="middle">等待响应…</text>
<rect class="b4" x="190" y="14" width="260" height="140" rx="10"/>
<text class="tb" x="320" y="34" text-anchor="middle" dominant-baseline="middle">没收到响应，可能是：</text>
<text class="ts" x="320" y="62" text-anchor="middle">① 请求在路上丢了</text>
<text class="ts" x="320" y="84" text-anchor="middle">② 对方宕机/崩溃</text>
<text class="ts" x="320" y="106" text-anchor="middle">③ 对方活着但很慢（GC/过载）</text>
<text class="ts" x="320" y="128" text-anchor="middle">④ 处理成功但响应丢了</text>
<rect class="b5" x="500" y="40" width="240" height="70" rx="8"/>
<text class="tb" x="620" y="62" text-anchor="middle" dominant-baseline="middle">四种情形外观完全相同</text>
<text class="ts" x="620" y="84" text-anchor="middle">发送方无法区分</text>
<line class="l" x1="140" y1="75" x2="190" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="75" x2="500" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="176" width="720" height="144" rx="8"/>
<text class="th" x="32" y="196">由此带来的权衡</text>
<text class="ts" x="380" y="222" text-anchor="middle">超时短：快速发现真故障；但把“慢”误判为“死”→ 不必要的主从切换、重复执行、流量洪峰</text>
<text class="ts" x="380" y="244" text-anchor="middle">超时长：误判少；但真故障发现慢 → 恢复时间长，请求长时间失败或悬挂</text>
<text class="ts" x="380" y="266" text-anchor="middle">所以：故障检测器只能是“不完美”的；设计要保证“被误判为死的节点”不会造成数据损坏</text>
<text class="ts" x="380" y="288" text-anchor="middle">（⇒ 对被判死的节点做 fencing，使其即使还活着也无法继续写入）</text>
<text class="ta" x="380" y="310" text-anchor="middle">同样，调用失败要假设“可能已经执行”：重试必须幂等</text>
</svg>
<figcaption>图 1：无响应时发送方无法区分的几种情形</figcaption>
</figure>

### 检测方法

| 方法 | 原理 | 特点 |
| --- | --- | --- |
| **固定超时心跳** | 周期发送心跳，连续 N 次/超过 T 未收到则判定故障 | 简单；T 难以在不同网络质量下设置；ZooKeeper 会话、Redis `cluster-node-timeout`、K8s 就绪探针、负载均衡健康检查都属此类 |
| **Phi 累积检测（Phi Accrual）** | 根据**心跳到达间隔的历史分布**，输出一个**怀疑度 φ**（连续值）而不是二值；应用按阈值决定 | **自适应网络抖动**，给上层灵活性；Cassandra、Akka 使用 |
| **SWIM / Gossip** | 每个节点周期性**随机探测**其他节点：直接 ping，未响应则**请其他节点间接探测**，仍无响应才标记“可疑”，经过一段时间再确认“死亡”，并通过**捎带（piggyback）**把成员变化传播给全网 | **去中心化、检测负载 O(1)/节点、扩展性好**；间接探测降低因单链路问题的误判；Consul/Serf（含 Lifeguard 改进）、Cassandra 的 Gossip 思路 |
| **租约（Lease）** | 持有者定期续约，**过期即视为失效**，不依赖“探测到失败” | 把“失败检测”转化为“过期”，见下节 |
| **多视角/业务探针** | 来自调用方的实际请求成功率、延迟、业务级健康检查（能否真正读写） | 发现灰色故障；比“进程存活”更接近真实可用性 |
| **K8s 探针** | liveness/readiness/startup，见 [微服务可观测](#/spring/cloud-observability) | 重启与摘流分离 |

### 灰色故障（Gray Failure）

特征：**检测器认为节点健康，但应用实际受损**。例子：

- 节点能响应心跳，但**磁盘极慢**或**线程池耗尽**，业务请求全部超时；
- **单向网络故障**：A→B 通，B→A 不通；
- 对**部分客户端/可用区**不可达，其他正常；
- 内存泄漏逐步变慢，CPU 被抢占，GC 频繁；
- 依赖的下游慢导致本节点“活着但无用”。

对策：

1. **健康检查贴近业务**：就绪探针执行真实依赖检查（受控、轻量）；
2. **客户端侧观察**：调用方统计目标节点的**错误率/延迟**，**异常实例剔除（outlier detection）**、熔断，见 [熔断限流实战](#/spring/cloud-resilience)；
3. **多观察者投票**：多个节点对同一目标的观察汇总，防止单一视角误判；
4. **慢也视为故障**：对延迟设置 SLO，持续超标节点摘除/降权；
5. **监控四个黄金信号**（延迟、流量、错误、饱和度），而不是只看“进程在不在”。

## 租约与 fencing

### 租约（Lease）

**租约 = 带过期时间的授权**：节点在租期内享有某项权利（做主、持有锁、缓存有效）；需要在到期前**续约**；到期未续约，权利自动失效。

- 好处：**不需要“探测对方已死”才能收回权利**——等租约过期即可，简化故障检测；
- 前提：持有者与授予者对**租约剩余时间**有一致的判断，**依赖时钟速率偏差有界**（不要求绝对时间同步，但要求时钟走速近似）；
- 实践：**持有者的判断要比授予者保守**（持有者认为租约比授予者更早过期），并预留时钟误差与暂停时间；用**单调时钟**计时，见 [分布式时钟](#/distributed/clock)；
- 应用：Raft 领导者租约读、Chubby/ZooKeeper 会话、etcd Lease、Redis 锁的过期、缓存的 TTL、负载均衡会话保持。

### 进程暂停：租约的天敌

```text
时间线（持有者 A）：
t0   A 检查：租约还剩 10s，有效 → 准备写入共享资源
t1   A 因 GC/VM 暂停/调度被冻结 30s
t2   租约在 t0+10s 过期，授予者把锁/主身份给了 B；B 写入资源
t3   A 恢复，**不知道租约已过期**，继续写入 → 覆盖了 B 的数据
```

检查与使用之间的间隔**不可控**。无论检查多么及时，都无法完全避免。解决的是**资源端防护**。

### Fencing Token（防护令牌）

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Fencing token 原理：锁服务每次授予锁时发放单调递增的令牌；持有者 A 获得令牌 33 后因暂停租约过期；B 获得令牌 34 并写入存储；A 恢复后用旧令牌 33 写入，存储发现已处理过更大的令牌 34，拒绝旧令牌的写入，防止僵尸持有者破坏数据">
<rect class="b3" x="20" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="55" text-anchor="middle" dominant-baseline="middle">客户端 A</text>
<rect class="b5" x="190" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="250" y="55" text-anchor="middle" dominant-baseline="middle">锁服务</text>
<rect class="b1" x="360" y="30" width="120" height="50" rx="8"/>
<text class="tb" x="420" y="55" text-anchor="middle" dominant-baseline="middle">客户端 B</text>
<rect class="b2" x="560" y="30" width="180" height="50" rx="8"/>
<text class="tb" x="650" y="55" text-anchor="middle" dominant-baseline="middle">共享存储（校验令牌）</text>
<line class="ld" x1="80" y1="80" x2="80" y2="310"/>
<line class="ld" x1="250" y1="80" x2="250" y2="310"/>
<line class="ld" x1="420" y1="80" x2="420" y2="310"/>
<line class="ld" x1="650" y1="80" x2="650" y2="310"/>
<line class="l" x1="80" y1="105" x2="250" y2="105" marker-end="url(#arr)"/>
<text class="ta" x="165" y="98" text-anchor="middle">① 加锁</text>
<line class="la" x1="250" y1="130" x2="80" y2="130" marker-end="url(#arr-a)"/>
<text class="ta" x="165" y="123" text-anchor="middle">令牌 33</text>
<rect class="b4" x="30" y="150" width="100" height="26" rx="6"/>
<text class="ts" x="80" y="163" text-anchor="middle" dominant-baseline="middle">A 长时间暂停</text>
<line class="l" x1="420" y1="190" x2="250" y2="190" marker-end="url(#arr)"/>
<text class="ta" x="335" y="183" text-anchor="middle">② 租约过期，B 加锁</text>
<line class="la" x1="250" y1="214" x2="420" y2="214" marker-end="url(#arr-a)"/>
<text class="ta" x="335" y="207" text-anchor="middle">令牌 34</text>
<line class="l" x1="420" y1="238" x2="650" y2="238" marker-end="url(#arr)"/>
<text class="ta" x="535" y="231" text-anchor="middle">③ 写入(令牌 34) ✓</text>
<line class="l" x1="80" y1="272" x2="650" y2="272" marker-end="url(#arr)"/>
<text class="ta" x="365" y="265" text-anchor="middle">④ A 恢复，写入(令牌 33) ✗ 被拒绝</text>
<text class="ts" x="650" y="298" text-anchor="middle">存储记录“见过的最大令牌”，拒绝更小者</text>
</svg>
<figcaption>图 2：fencing token 阻止僵尸持有者</figcaption>
</figure>

要点：

- **令牌由授予者单调递增发放**（etcd 的 revision、ZooKeeper 的 zxid/节点序号、数据库序列）；
- **资源端必须校验**（存储、数据库、下游服务），仅靠客户端判断没有意义；
- 如果资源不支持校验（如第三方 API），需要**把写操作改造为幂等/带版本的条件写**（CAS：`UPDATE ... WHERE version = ?`）；
- 数据库乐观锁、Kafka 的 producer epoch、Raft 的 term 都是同一思想：**用单调递增的“代”标识合法持有者**。

## 脑裂

**脑裂（Split-Brain）**：因网络分区或故障误判，**系统中同时出现两个（或更多）自认为是主的节点**，各自接受写入，数据分叉。

### 成因

| 成因 | 说明 |
| --- | --- |
| **网络分区** | 主与副本/协调者之间断开，副本提升为新主，旧主不知情仍在服务 |
| **误判故障** | 主节点只是慢（GC/过载），被判死并切换，随后恢复 |
| **切换流程缺少隔离** | 新主上位但没有确保旧主停止 |
| **配置不一致/多数派理解不同** | 成员视图不同，各自成多数 |
| **偶数节点分成对等两半** | 2:2 都不是多数，若算法错误允许“少数也服务”则双主 |

### 预防

| 手段 | 说明 |
| --- | --- |
| **多数派（Quorum）选主与写入** | 只有拥有多数的一方能选主与提交；少数方**拒绝写入**（牺牲可用性）。Raft/Paxos 天然如此，见 [Raft 与共识算法](#/distributed/consensus) |
| **奇数节点** | 避免对半分裂无多数 |
| **租约** | 旧主租约过期后**自动放弃主身份**，新主等待旧租约过期后才上位（等待期 ≥ 租约 + 误差） |
| **Fencing token** | 资源端拒绝旧主的写入 |
| **STONITH（Shoot The Other Node In The Head）** | 切换时**强制关闭旧主**（断电、拔网络、杀虚拟机）以确保只有一个主；HA 集群软件（Pacemaker）常用 |
| **仲裁设备（Witness/Quorum Disk）** | 第三方仲裁节点帮助判定多数 |
| **限制孤立主写入** | Redis 的 `min-replicas-to-write`、数据库的同步复制要求，少副本时拒写，见 [Redis Cluster 生产运维](#/redis/cluster-ops) |
| **客户端感知拓扑** | 客户端通过配置中心/哨兵获得当前主，避免直连旧主 |

### 事后处理

脑裂一旦发生，**两边都写入了不同数据**。处理：

1. **立即隔离其中一个**，停止其写入；
2. **判定以哪一方为准**（通常是多数派一方/数据更新的一方），另一方的**多余写入导出保存**；
3. **数据合并/回放**：对账、业务级合并（无法自动合并的需要人工）；
4. **复盘**：为什么检测器误判、为什么缺少 fencing；补上防护。

## 重试风暴与级联故障

### 局部故障如何放大

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="级联故障与亚稳态：某个下游服务变慢，调用方线程被占用，请求超时后重试，重试流量叠加原有流量，下游更加过载，更多超时，形成正反馈；即使最初的触发因素（流量尖峰或短暂故障）消失，重试与排队仍维持系统过载，进入亚稳态；打破方法包括削减负载、限制重试、熔断、背压和快速失败">
<rect class="b3" x="20" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">触发</text>
<text class="ts" x="85" y="72" text-anchor="middle">流量尖峰/下游抖动</text>
<rect class="b4" x="180" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">延迟升高</text>
<text class="ts" x="245" y="72" text-anchor="middle">线程/连接被占</text>
<rect class="b5" x="340" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="405" y="52" text-anchor="middle" dominant-baseline="middle">超时+重试</text>
<text class="ts" x="405" y="72" text-anchor="middle">流量成倍放大</text>
<rect class="b1" x="500" y="30" width="110" height="60" rx="8"/>
<text class="tb" x="555" y="52" text-anchor="middle" dominant-baseline="middle">更加过载</text>
<text class="ts" x="555" y="72" text-anchor="middle">更多超时</text>
<rect class="b2" x="640" y="30" width="100" height="60" rx="8"/>
<text class="tb" x="690" y="52" text-anchor="middle" dominant-baseline="middle">雪崩</text>
<text class="ts" x="690" y="72" text-anchor="middle">波及上下游</text>
<line class="l" x1="150" y1="60" x2="180" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="60" x2="340" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="60" x2="500" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="60" x2="640" y2="60" marker-end="url(#arr)"/>
<path class="la" d="M555 90 L555 120 L245 120 L245 94" marker-end="url(#arr-a)"/>
<text class="ta" x="400" y="114" text-anchor="middle">正反馈：重试推高负载，负载推高延迟</text>
<rect class="b4" x="20" y="140" width="350" height="180" rx="8"/>
<text class="th" x="32" y="160">亚稳态失败（Metastable Failure）</text>
<text class="ts" x="195" y="186" text-anchor="middle">触发因素已消失（如尖峰结束），</text>
<text class="ts" x="195" y="206" text-anchor="middle">但系统因重试、排队、缓存失效、冷启动等</text>
<text class="ts" x="195" y="226" text-anchor="middle">“持续性放大机制”仍停留在过载状态</text>
<text class="ts" x="195" y="252" text-anchor="middle">例：缓存清空→回源打满 DB→DB 慢→请求超时重试</text>
<text class="ts" x="195" y="272" text-anchor="middle">→ 缓存仍填不起来，系统无法自愈</text>
<text class="ts" x="195" y="298" text-anchor="middle">特点：需要人工干预或强力削减负载才能恢复</text>
<rect class="b2" x="390" y="140" width="350" height="180" rx="8"/>
<text class="th" x="402" y="160">防护与打破手段</text>
<text class="ts" x="565" y="186" text-anchor="middle">重试：有限次数 + 指数退避 + 抖动 + 重试预算</text>
<text class="ts" x="565" y="206" text-anchor="middle">超时预算由外向内递减；传递截止时间</text>
<text class="ts" x="565" y="226" text-anchor="middle">熔断、舱壁：快速失败，限制并发占用</text>
<text class="ts" x="565" y="246" text-anchor="middle">背压与负载削减：过载时主动拒绝/排队上限</text>
<text class="ts" x="565" y="266" text-anchor="middle">降级：关闭非核心功能，优先主流程</text>
<text class="ts" x="565" y="286" text-anchor="middle">缓存：预热、逻辑过期、请求合并，避免回源洪峰</text>
<text class="ts" x="565" y="306" text-anchor="middle">限流在入口，把负载压回系统能承受的水平</text>
</svg>
<figcaption>图 3：重试风暴、级联故障与亚稳态</figcaption>
</figure>

### 重试的正确姿势

| 规则 | 说明 |
| --- | --- |
| **只在最外层重试** | 每一层都重试会指数级放大（3 层各重试 2 次 = 27 倍） |
| **指数退避 + 抖动** | `delay = min(cap, base × 2^n) × random(0.5~1)`，避免同步重试形成脉冲 |
| **重试预算** | 重试请求占总请求的比例上限（如 10%），超出直接失败；故障时自动抑制 |
| **幂等才重试** | 写操作必须幂等，见 [幂等设计与重试](#/distributed/idempotent) |
| **区分可重试错误** | 超时/503/连接失败可重试；400/业务错误/认证失败不可重试 |
| **传递截止时间** | 上游已超时放弃的请求，下游不应继续处理（避免无效劳动） |
| **对冲请求（Hedged Requests）** | 在尾延迟敏感的读场景，等待超过 P95 后向另一副本再发一份，取先到者；**要有预算与取消机制**，否则放大负载 |

具体到框架的配置，见 [OpenFeign 深入：调用链、超时重试与上下文透传](#/spring/cloud-feign) 与 [熔断限流实战](#/spring/cloud-resilience)。

### 背压与过载保护

**过载时系统应当“优雅地变差”，而不是“突然崩溃”**：

- **有界队列**：所有队列、线程池、连接池都要有上限，满了就**快速拒绝**（比无限排队好——无限排队只会让所有请求都变得很慢直到超时）；
- **准入控制/限流**：入口按容量限制并发或速率，优先保证高优先级请求；
- **自适应并发限制**（如基于延迟梯度的 AIMD/Vegas 思路）：延迟升高自动降低并发；
- **负载削减（Load Shedding）**：过载时按优先级丢弃（先丢后台任务、低价值请求）；
- **背压传播**：下游处理不过来，向上游传递“慢一点”的信号（反应式流、TCP 窗口、消息队列的消费速率控制），而不是无限缓冲；
- **LIFO 队列/CoDel 思路**：过载时优先处理新请求（旧请求很可能已超时），丢弃已等待太久的请求。

## 故障隔离

| 手段 | 说明 |
| --- | --- |
| **舱壁（Bulkhead）** | 按下游/业务隔离线程池、连接池，一处耗尽不影响其他 |
| **Cell-based（单元化）架构** | 把系统切成若干**独立单元（cell）**，每个单元承载部分用户，故障**限制在单元内**（爆炸半径小），见 [异地多活与单元化架构](#/design/arch-multi-active) |
| **Shuffle Sharding** | 每个客户端映射到多个节点的**随机子集**，两个客户端完全重叠的概率很低，一个“毒请求”只影响少数客户端 |
| **故障域规划** | 机架、可用区、地域；副本跨故障域放置 |
| **依赖隔离与降级** | 非关键依赖失败时降级，不拖垮主流程 |
| **灰度与变更控制** | 变更是最大的故障来源：分批发布、自动回滚，见 [发布策略](#/infra/release) |

## 验证容错：故障测试

| 方法 | 做法 |
| --- | --- |
| **混沌工程** | 在生产或类生产环境**受控地注入故障**（杀进程、延迟、丢包、分区、磁盘满、依赖不可用），验证系统行为与告警，见 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos) |
| **Jepsen 式测试** | 并发执行操作 + 注入网络分区/时钟偏移/进程暂停，**用检查器验证结果是否违反一致性模型**（线性一致等）；业界用它发现了许多数据库的一致性 bug |
| **故障演练（Game Day）** | 团队演练故障响应流程：切换主库、区域故障、依赖降级 |
| **故障注入测试（单元/集成层）** | 测试中模拟超时、异常、慢响应，验证重试、降级、幂等逻辑 |
| **确定性模拟测试** | 在可控的模拟网络与时钟中重放故障场景（FoundationDB 的模拟测试），可复现 |
| **长时间浸泡与容量测试** | 发现内存泄漏、慢速劣化 |

测试要覆盖**部分失败**与**灰色故障**，而不仅是“整个节点宕机”。

## 工程检查清单

- [ ] 系统假设的故障模型是什么？（崩溃恢复、消息丢失延迟、时钟不可靠）是否写进设计？
- [ ] 故障检测的超时、心跳间隔是否基于实测网络与 GC 暂停，并监控误判与切换次数？
- [ ] 是否有业务级/多视角的健康检查，能发现灰色故障？
- [ ] 所有“主/锁/租约”是否有 fencing 或资源端的条件写保护？
- [ ] 主从切换是否有隔离旧主的机制，是否防止脑裂？
- [ ] 所有重试是否有上限、退避、抖动、预算，写操作是否幂等？
- [ ] 队列、线程池、连接池是否有界，过载时是否快速拒绝而不是无限排队？
- [ ] 是否有熔断、舱壁、降级、限流与单元化等隔离手段？
- [ ] 是否做过网络分区、时钟偏移、进程暂停、依赖慢/不可用的演练？

## 相关阅读

- [CAP、BASE 与一致性模型](#/distributed/theory)：分区与取舍
- [Paxos 与共识算法族](#/distributed/paxos)：选主、多数派与活性
- [分布式时钟](#/distributed/clock)：租约与时钟假设
- [分布式协调：ZooKeeper 与 etcd](#/mw/coordination)：会话、租约与 fencing 的实现
- [限流、熔断与降级](#/distributed/governance)：过载保护与隔离
- [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos)：故障注入方法

## 面试追问

> [!QUESTION] 为什么分布式系统里故障检测很难？
> 发出请求没收到响应，可能是请求丢失、对方宕机、对方很慢、响应丢失，这些情形从发送方看完全一样，所以超时只是对故障的猜测。超时短会把慢误判为死引发不必要切换，超时长则恢复慢。因此设计要保证被误判为死的节点不会造成数据损坏，如用 fencing，并要求重试幂等。

> [!QUESTION] 什么是脑裂？怎么预防？
> 因网络分区或误判，系统里同时出现多个自认为是主的节点，各自接受写入造成数据分叉。预防靠多数派选主与提交（少数方拒绝写）、奇数节点、租约（旧主租约过期自动放弃，新主等待过期后上位）、fencing token 让资源端拒绝旧主、STONITH 强制隔离旧主、限制孤立主接受写。

> [!QUESTION] 租约和 fencing token 解决什么问题？
> 租约把“探测对方死亡”变成“等待授权过期”，用于主选举、锁、读租约；但进程暂停会让持有者在过期后仍以为有权。Fencing token 由授予者单调递增发放，资源端记录见过的最大令牌并拒绝更小的，从而挡住僵尸持有者，etcd 的 revision、数据库乐观锁版本、Raft 的 term 都是同一思想。

> [!QUESTION] 什么是灰色故障？怎么发现？
> 节点心跳正常、被认为健康，但实际因磁盘慢、线程耗尽、单向网络故障、对部分客户端不可达等已部分失效。靠只看进程存活发现不了，需要业务级健康检查、调用方对目标节点的错误率和延迟观察与异常实例剔除、多观察者投票，以及对延迟设置 SLO。

> [!QUESTION] 重试为什么可能让故障更严重？怎么做才对？
> 超时后重试会叠加在原有流量上，让已过载的下游更慢，形成正反馈，多层重试还会指数放大，甚至进入重试和排队维持的亚稳态。应只在最外层重试，有限次数加指数退避与抖动，设置重试预算，写操作幂等，传递截止时间，并配合熔断、限流、背压和有界队列。

> [!QUESTION] SWIM 故障检测相比固定心跳有什么优点？
> 每个节点周期性随机探测其他节点，直接探测无响应时请其他节点间接探测，降低单条链路故障造成的误判，再经过可疑状态才确认死亡，并通过捎带传播成员变化。检测与传播开销在每节点是常数级，去中心化、可扩展，适合大规模集群，Consul、Cassandra 的 Gossip 都采用类似思想。

> [!QUESTION] 如何验证系统真的容错？
> 靠故障注入而不是相信设计：混沌工程在受控环境注入宕机、延迟、丢包、分区、依赖不可用，Jepsen 式测试在并发操作中注入分区与时钟偏移并用检查器验证一致性，定期做故障演练，并覆盖部分失败和灰色故障。
