---
level: 深入
tags: [CAP, PACELC, BASE, 一致性模型, Quorum, 逻辑时钟, 幂等]
summary: 讲清 CAP 的准确定义与常见误读、一致性模型谱系、Quorum NWR、Lamport/向量时钟，以及工程上最常用的幂等设计
---

# CAP、BASE 与一致性模型

> [!ABSTRACT] 核心要点
> - CAP 中的 C 是**线性一致性**（不是 ACID 的 C），A 是**每个未宕机节点都必须在有限时间内给出非错误响应**，P 是**容忍节点间任意丢消息**。三者不是「三选二」，而是「**发生分区时，在 C 与 A 之间二选一**」。
> - 分布式系统不可能保证网络不分区，所以 P 不是可选项；没有分区时 C 和 A 可以同时满足，此时的真实取舍是**延迟 vs 一致性**（PACELC）。
> - 一致性模型从强到弱：线性一致 → 顺序一致 → 因果一致 → 最终一致；工程上常在最终一致上叠加「读己之写」「单调读」等会话保证。
> - Quorum：`W + R > N` 保证读写集合有交集，`W > N/2` 避免并发写分叉；但 sloppy quorum、并发写、时钟 LWW 都会破坏这个「看起来的强一致」。
> - 物理时钟不可信，排序靠逻辑时钟：Lamport 时钟给出与因果一致的全序，向量时钟能判断「并发」。最终一致系统里，**幂等**是重试、补偿、消息重投都能安全进行的前提。

## CAP 定理

### 三个字母的准确含义

CAP 由 Eric Brewer 在 2000 年提出猜想，2002 年 Gilbert 与 Lynch 给出形式化证明。很多误读都来自对三个字母定义的随意理解：

| 字母 | 证明中的定义 | 常见误读 |
| --- | --- | --- |
| C（Consistency） | **线性一致性**：所有操作看起来像在单副本上按真实时间顺序原子执行，读一定能读到最近一次完成的写 | 当成 ACID 中的「约束不被破坏」；或把最终一致也叫 C |
| A（Availability） | **每个**收到请求的非故障节点都必须返回**非错误**响应（不要求多快，但不能无限等） | 当成「SLA 99.99%」；实际上只要有节点拒绝服务就不满足 A |
| P（Partition tolerance） | 网络可以任意丢失节点间的消息，系统仍要继续按规约运行 | 当成「系统能扛住机器宕机」 |

注意 A 的定义非常苛刻：多数派可用、少数派返回「请稍后重试」的系统（如 ZooKeeper、etcd），在 CAP 意义下**不是 A**，尽管它们工程上的可用性很高。

### 为什么「P 必选」：一个直觉证明

<figure class="fig">
<svg viewBox="0 0 720 280" class="dg" role="img" aria-label="网络分区下 N1 已接受写入 x=2 但无法同步给 N2，客户端从 N2 读取时只能拒绝服务或返回旧值">
<text class="ta" x="360" y="18" text-anchor="middle" dominant-baseline="middle">网络分区</text>
<line class="ld" x1="360" y1="30" x2="360" y2="270"/>
<rect class="bg" x="20" y="30" width="320" height="240" rx="12"/>
<text class="ts" x="36" y="48">分区 1</text>
<rect class="bg" x="380" y="30" width="320" height="240" rx="12"/>
<text class="ts" x="396" y="48">分区 2</text>
<rect class="b" x="110" y="58" width="140" height="40" rx="8"/>
<text class="tb" x="180" y="78" text-anchor="middle" dominant-baseline="middle">Client A</text>
<line class="l" x1="180" y1="98" x2="180" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="190" y="112">① 写 x=2</text>
<rect class="b1" x="110" y="120" width="140" height="52" rx="8"/>
<text class="tb" x="180" y="138" text-anchor="middle" dominant-baseline="middle">N1</text>
<text class="tm" x="180" y="158" text-anchor="middle" dominant-baseline="middle">x = 2</text>
<rect class="b" x="470" y="58" width="140" height="40" rx="8"/>
<text class="tb" x="540" y="78" text-anchor="middle" dominant-baseline="middle">Client B</text>
<line class="l" x1="540" y1="98" x2="540" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="550" y="112">③ 读 x</text>
<rect class="b1" x="470" y="120" width="140" height="52" rx="8"/>
<text class="tb" x="540" y="138" text-anchor="middle" dominant-baseline="middle">N2</text>
<text class="tm" x="540" y="158" text-anchor="middle" dominant-baseline="middle">x = 1</text>
<line class="la" x1="250" y1="146" x2="466" y2="146" marker-end="url(#arr-a)"/>
<text class="ts" x="300" y="136" text-anchor="middle">② 复制 x=2</text>
<text class="ta" x="420" y="136" text-anchor="middle">✕ 丢失</text>
<text class="ts" x="180" y="200" text-anchor="middle">N1 已接受写入</text>
<text class="ts" x="180" y="218" text-anchor="middle">但无法通知 N2</text>
<line class="l" x1="520" y1="172" x2="467" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="172" x2="622" y2="200" marker-end="url(#arr)"/>
<rect class="b4" x="395" y="200" width="145" height="56" rx="8"/>
<text class="tb" x="467" y="220" text-anchor="middle" dominant-baseline="middle">选 C：拒绝请求</text>
<text class="ts" x="467" y="242" text-anchor="middle" dominant-baseline="middle">返回错误 = 不可用</text>
<rect class="b3" x="550" y="200" width="145" height="56" rx="8"/>
<text class="tb" x="622" y="220" text-anchor="middle" dominant-baseline="middle">选 A：返回 x=1</text>
<text class="ts" x="622" y="242" text-anchor="middle" dominant-baseline="middle">读到旧值 = 不一致</text>
</svg>
<figcaption>图 1：网络分区下 N2 只能在「拒绝服务」与「返回旧值」之间二选一</figcaption>
</figure>

推理只需三步：

1. 只要系统跨越多于一台机器，就要靠网络同步状态；网络会丢包、交换机会挂、GC 停顿会让心跳超时——**从其他节点视角看，「对方很慢」与「网络断了」无法区分**。因此分区是必然发生的事件，而不是可以「选择不要」的属性。
2. 分区期间，N2 收到读请求。若返回本地的 x=1，违反线性一致（A 已经被告知写入成功）；若等待同步或报错，违反可用性。
3. 所以「CA 系统」只存在于单机或者「假设网络永不分区」的场景。单机 MySQL 可以说是 CA，主从异步复制的 MySQL 集群在主库宕机切换时一样要面对 C 与 A 的取舍（切过去会丢数据，不切就不可写）。

> [!NOTE]
> Brewer 在 2012 年的回顾文章中也强调：CAP 的「三选二」是误导性的说法。分区很少发生，**没有分区时应当同时追求 C 和 A**；分区发生时要做的是**检测分区 → 进入受限模式 → 分区恢复后做补偿**，而不是在系统设计之初就永久放弃某个字母。

### CP / AP 系统举例

| 系统 | 归类 | 分区或故障时的行为 |
| --- | --- | --- |
| ZooKeeper | CP | 基于 ZAB，少数派节点不能处理写；Leader 选举期间整个集群不可写。默认读走本地副本，可能读到旧值（需要时先 `sync()`），所以 ZK 的读并非线性一致 |
| etcd | CP | 基于 Raft，默认读为线性一致（ReadIndex），也可选 `serializable` 读本地以换取性能 |
| Consul | CP | Raft；提供 `default` / `consistent` / `stale` 三种读一致性模式 |
| Eureka | AP | 节点对等、异步复制，任一节点都能注册与查询；有**自我保护**：续约数低于阈值时不再剔除实例，宁可返回可能已下线的实例也不清空注册表 |
| Nacos 注册中心 | AP / CP 可选 | **临时实例**（默认，`ephemeral=true`）走自研 Distro 协议，AP，靠心跳维持；**持久实例**走 Raft（JRaft），CP，由服务端主动探活 |
| Redis Cluster | 偏 AP（但不满足严格 A） | 主从异步复制，主库确认写入后宕机会丢已确认的写；少数派分区中的主节点在 `cluster-node-timeout` 后停止接受写入 |
| Kafka | 可调 | `acks=all` + `min.insync.replicas` + 关闭 unclean 选举偏 CP；开启 `unclean.leader.election.enable` 偏 A |

> [!TIP] 注册中心为什么更偏爱 AP
> 服务发现的数据本身就有时效性（实例随时上下线），读到几秒前的旧列表完全可以由客户端重试、负载均衡剔除来兜底；而注册中心整体不可用会让所有新请求找不到服务。所以 Eureka、Nacos 临时实例选 AP；而配置中心、分布式锁、选主需要「不能读到错的」，适合 CP。

### PACELC：没有分区时的取舍

Daniel Abadi 提出 PACELC：**if Partition → A or C; Else → Latency or Consistency**。它补上了 CAP 不讨论的常态：没有分区时，要强一致就得同步等多数派确认（高延迟），要低延迟就只能异步复制（弱一致）。

| 系统 | 分区时 | 常态时 | 说明 |
| --- | --- | --- | --- |
| Dynamo / Cassandra（默认） | PA | EL | 默认一致性级别低，可按请求调到 QUORUM |
| HBase、etcd、ZK | PC | EC | 写入必须多数派或主节点确认 |
| MySQL 异步复制 | PA（若自动切主） | EL | 半同步复制向 EC 靠拢 |

## BASE

BASE 是 eBay 架构师 Dan Pritchett 提出的，与 ACID 相对的工程哲学：

- **Basically Available（基本可用）**：故障时允许损失部分可用性——响应变慢、降级为简化页面、非核心功能关闭，但核心链路可用。
- **Soft state（软状态）**：允许系统存在中间状态，例如订单处于「支付中」、库存「已预扣未确认」，且该状态不影响整体可用。
- **Eventually consistent（最终一致）**：中间状态经过一段时间后收敛到一致。

BASE 不是放弃一致性，而是**把一致性从「每一时刻」放宽到「最终」**，并通过补偿、对账、重试来保证收敛。分布式事务中的 TCC、Saga、本地消息表都是 BASE 思想的落地，详见 [分布式事务](#/distributed/transaction)。

## 一致性模型谱系

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="一致性模型从强到弱依次为线性一致、顺序一致、因果一致、最终一致，越强越易编程但延迟越高">
<text class="ts" x="20" y="24">更强：更易编程，代价是延迟与可用性</text>
<text class="ts" x="740" y="24" text-anchor="end">更弱：更高可用与性能，需应用处理异常</text>
<line class="la" x1="20" y1="38" x2="736" y2="38" marker-end="url(#arr-a)"/>
<rect class="b4" x="20" y="56" width="165" height="56" rx="8"/>
<text class="tb" x="102" y="76" text-anchor="middle" dominant-baseline="middle">线性一致</text>
<text class="tm" x="102" y="96" text-anchor="middle" dominant-baseline="middle">Linearizable</text>
<rect class="b5" x="205" y="56" width="165" height="56" rx="8"/>
<text class="tb" x="287" y="76" text-anchor="middle" dominant-baseline="middle">顺序一致</text>
<text class="tm" x="287" y="96" text-anchor="middle" dominant-baseline="middle">Sequential</text>
<rect class="b1" x="390" y="56" width="165" height="56" rx="8"/>
<text class="tb" x="472" y="76" text-anchor="middle" dominant-baseline="middle">因果一致</text>
<text class="tm" x="472" y="96" text-anchor="middle" dominant-baseline="middle">Causal</text>
<rect class="b2" x="575" y="56" width="165" height="56" rx="8"/>
<text class="tb" x="657" y="76" text-anchor="middle" dominant-baseline="middle">最终一致</text>
<text class="tm" x="657" y="96" text-anchor="middle" dominant-baseline="middle">Eventual</text>
<text class="ts" x="102" y="134" text-anchor="middle">操作在调用与返回之间</text>
<text class="ts" x="102" y="152" text-anchor="middle">某一瞬间原子生效</text>
<text class="ts" x="102" y="170" text-anchor="middle">尊重真实时间先后</text>
<text class="ts" x="287" y="134" text-anchor="middle">存在一个全局顺序</text>
<text class="ts" x="287" y="152" text-anchor="middle">保持各进程的程序序</text>
<text class="ts" x="287" y="170" text-anchor="middle">不要求真实时间</text>
<text class="ts" x="472" y="134" text-anchor="middle">有因果关系的写</text>
<text class="ts" x="472" y="152" text-anchor="middle">所有节点看到同一顺序</text>
<text class="ts" x="472" y="170" text-anchor="middle">并发写顺序可以不同</text>
<text class="ts" x="657" y="134" text-anchor="middle">停止写入后</text>
<text class="ts" x="657" y="152" text-anchor="middle">所有副本终将收敛</text>
<text class="ts" x="657" y="170" text-anchor="middle">中途可能读到旧值</text>
<text class="ta" x="102" y="200" text-anchor="middle">etcd 默认读写</text>
<text class="ta" x="287" y="200" text-anchor="middle">ZK 写入顺序</text>
<text class="ta" x="472" y="200" text-anchor="middle">MongoDB 因果会话</text>
<text class="ta" x="657" y="200" text-anchor="middle">DNS、Eureka</text>
<text class="ts" x="380" y="236" text-anchor="middle">会话保证（读己之写、单调读、单调写、写后读）是在最终一致之上的常用加强</text>
</svg>
<figcaption>图 2：一致性模型谱系（单对象 / 复制层面）</figcaption>
</figure>

### 逐个理解

- **线性一致**：给每个操作一个「生效点」，位于调用与返回之间；所有生效点构成的顺序必须与真实时间一致。直观效果：**一旦某个读看到新值，之后（按真实时间）的所有读都不能再看到旧值**。实现手段：单 Leader + 多数派提交 + 读也走一次共识（ReadIndex / LeaseRead）。
- **顺序一致**（Lamport 1979）：存在某个全局顺序，且每个进程自己的操作在这个顺序里保持程序顺序，但**不必与真实时间对齐**。A 先写完，B 后读，B 读到旧值并不违反顺序一致。
- **因果一致**：只要求有因果关系（同一会话先后操作、读到某值后再写）的操作被所有节点按相同顺序看到；无因果关系的并发写，各节点看到的顺序可以不同。它是「不牺牲可用性」所能达到的较强模型之一。
- **最终一致**：只保证收敛，不保证中间读到什么。

### 会话保证（工程上最实用）

| 保证 | 含义 | 典型实现 |
| --- | --- | --- |
| 读己之写 | 用户刚写的数据自己一定能读到 | 写后一段时间内读主库；客户端携带写入版本号，副本追上该版本才返回 |
| 单调读 | 不会先读到新值再读到旧值 | 同一用户固定路由到同一副本（按 userId 哈希） |
| 单调写 | 同一客户端的写按顺序生效 | 单连接串行、带序号 |
| 写后读（Writes Follow Reads） | 基于读到的值做的写，排在该值之后 | 携带因果依赖版本 |

> [!WARNING] 线性一致 ≠ 可串行化
> 可串行化（Serializable）是**事务**隔离级别，要求多个事务的效果等价于某个串行顺序，但不要求这个顺序与真实时间一致；线性一致是**单对象**的复制一致性。两者都满足叫**严格可串行化**（Strict Serializability），Spanner 提供的就是它。

## Quorum NWR

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="N=3 W=2 R=2 时写集合 R1 R2 与读集合 R2 R3 在 R2 处相交，读取方取版本最大的值">
<rect class="b3" x="20" y="90" width="140" height="44" rx="8"/>
<text class="tb" x="90" y="112" text-anchor="middle" dominant-baseline="middle">写 v2（W=2）</text>
<rect class="b2" x="290" y="30" width="150" height="44" rx="8"/>
<text class="tb" x="365" y="52" text-anchor="middle" dominant-baseline="middle">R1：v2</text>
<rect class="b2" x="290" y="90" width="150" height="44" rx="8"/>
<text class="tb" x="365" y="112" text-anchor="middle" dominant-baseline="middle">R2：v2（交集）</text>
<rect class="b" x="290" y="150" width="150" height="44" rx="8"/>
<text class="tb" x="365" y="172" text-anchor="middle" dominant-baseline="middle">R3：v1（落后）</text>
<line class="la" x1="160" y1="104" x2="290" y2="56" marker-end="url(#arr-a)"/>
<line class="la" x1="160" y1="112" x2="290" y2="112" marker-end="url(#arr-a)"/>
<line class="ld" x1="160" y1="120" x2="290" y2="168" marker-end="url(#arr)"/>
<text class="ts" x="200" y="172" text-anchor="middle">异步/延迟</text>
<rect class="b1" x="570" y="90" width="130" height="44" rx="8"/>
<text class="tb" x="635" y="112" text-anchor="middle" dominant-baseline="middle">读（R=2）</text>
<line class="l" x1="570" y1="112" x2="440" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="120" x2="440" y2="168" marker-end="url(#arr)"/>
<text class="ts" x="520" y="172" text-anchor="middle">读回 v1、v2</text>
<text class="ts" x="360" y="218" text-anchor="middle">N=3、W=2、R=2：W+R&gt;N，读写集合必有交集，按版本号取最新 v2，并可顺带读修复 R3</text>
</svg>
<figcaption>图 3：Quorum 读写集合相交原理</figcaption>
</figure>

- **N**：副本数；**W**：写成功需要确认的副本数；**R**：读需要查询的副本数。
- `W + R > N`：任意读集合与写集合至少有一个公共副本，读能拿到最新版本（需要版本号/时间戳来判断谁新）。
- `W > N/2`：两个并发写不可能各自拿到多数派，避免写冲突无法裁决。
- 常见配置：`N=3, W=2, R=2` 均衡；`W=N, R=1` 读多写少；`W=1, R=N` 写多读少（但写的持久性很弱）。

> [!CAUTION] Quorum 不等于线性一致
> - **Sloppy Quorum + Hinted Handoff**（Dynamo 风格）：目标副本不可达时写到其他临时节点，读写集合可能不再相交。
> - **并发写 + LWW**（Last Write Wins）：Cassandra 按客户端/协调者时间戳裁决，时钟漂移会让「后写」的值被「先写」覆盖，静默丢数据。
> - **写失败未回滚**：W=2 只写成功 1 个副本时返回失败，但那个副本上的新值不会被撤销，后续读可能读到「失败的写」。
> - 读到新值的读与之后读到旧值的读可以同时存在（没有读修复同步完成）。要线性一致必须引入单 Leader 共识，见 [Raft 与共识算法](#/distributed/consensus)。

副本收敛的辅助手段：**读修复**（读时发现落后的副本顺带写回）、**反熵**（后台用 Merkle 树比较副本差异）。

## 逻辑时钟

### 为什么不能用物理时钟排序

NTP 同步后不同机器的时钟仍有毫秒级甚至更大的偏差，还可能因为 NTP 校正**回拨**；虚拟机暂停、闰秒都会导致跳变。用 `System.currentTimeMillis()` 判断两个事件谁先谁后，在分布式环境下是不可靠的（同样的问题也出现在 [Snowflake 时钟回拨](#/distributed/id)）。

### Lamport 时钟

规则：

1. 每个进程维护计数器 `C`，每发生一个本地事件 `C++`；
2. 发送消息时 `C++` 并把 `C` 附在消息里；
3. 收到消息时 `C = max(C, msg.C) + 1`。

性质：若事件 a **happens-before** b，则 `C(a) < C(b)`；**反之不成立**——`C(a) < C(b)` 不能推出 a 在 b 之前，它们可能是并发的。用 `(C, 进程 ID)` 字典序比较可得到一个与因果一致的全序，这就是 Lamport 分布式互斥算法的基础。

### 向量时钟

N 个进程，每个进程维护长度 N 的向量 `V`：本地事件 `V[i]++`；发送时附带整个向量；收到时逐分量取 max 再 `V[i]++`。比较规则：

- `V(a) ≤ V(b)` 且至少一个分量严格小 → a 发生在 b 之前；
- 两者互不小于等于 → **a 与 b 并发**（冲突）。

Dynamo、Riak 用向量时钟（或其变种 dotted version vector）检测并发写冲突，把多个版本（siblings）交给应用合并，例如购物车取并集。代价是向量随参与节点数增长，需要裁剪。

| 时钟 | 能做什么 | 不能做什么 | 代表应用 |
| --- | --- | --- | --- |
| 物理时钟 | 近似真实时间 | 精确排序，可能回拨 | 日志时间、TTL |
| Lamport 时钟 | 与因果一致的全序 | 判断是否并发 | 分布式互斥、全序广播 |
| 向量时钟 | 精确判断因果/并发 | 规模大时开销大 | Dynamo、Riak 冲突检测 |
| 混合逻辑时钟 HLC | 接近物理时间 + 因果 | 依赖时钟误差有界 | CockroachDB、YugabyteDB |
| TrueTime | 带误差区间的全局时间 | 需要 GPS/原子钟硬件 | Spanner |

## 幂等性设计

在最终一致的世界里，**超时 ≠ 失败**：请求可能已经执行，只是响应丢了。于是重试、MQ 重投、补偿重放随处可见，接口必须幂等——同一请求执行一次和执行多次，对系统状态的影响相同。

### 常用手段

| 手段 | 做法 | 适用 |
| --- | --- | --- |
| 唯一索引 | 业务唯一键（订单号、`requestId`）建唯一索引，重复插入捕获 `DuplicateKeyException` 当作成功 | 创建类操作 |
| 状态机 + 条件更新 | `UPDATE order SET status='PAID' WHERE id=? AND status='UNPAID'`，影响行数 0 即重复 | 状态流转 |
| 乐观锁版本号 | `UPDATE ... SET v=v+1 WHERE id=? AND v=?` | 更新类操作 |
| 去重表 / 防重 Token | 先申请 token（Redis 存储），提交时 `DEL` 成功才执行 | 表单重复提交 |
| 消费去重 | 以消息业务 ID 写去重表，与业务操作同一本地事务 | MQ 消费 |

```java
// 消费去重：去重记录与业务写在同一个本地事务里，避免「业务成功、去重记录失败」
@Transactional(rollbackFor = Exception.class)
public void onMessage(PaymentEvent evt) {
    try {
        dedupMapper.insert(new Dedup(evt.getEventId(), "payment"));  // 唯一索引 (event_id, biz)
    } catch (DuplicateKeyException e) {
        log.info("duplicate event {}, skip", evt.getEventId());
        return;                                                      // 重复消息，直接视为成功
    }
    int rows = orderMapper.markPaid(evt.getOrderId());               // WHERE status = 'UNPAID'
    if (rows == 0) {
        log.warn("order {} not in UNPAID state", evt.getOrderId());
    }
}
```

> [!WARNING] 「先查后写」不是幂等
> `if (!exists(id)) insert(id)` 在并发下两个请求都能通过检查。幂等必须落到**原子操作**上：唯一索引、条件更新、`SET NX`、Lua 脚本。用 Redis 去重时还要考虑 Redis 写成功但业务失败的情况（需要删除标记或设置「处理中」状态）。

## 生产实践与踩坑

- **把注册中心当强一致存储用**：用 Eureka / Nacos 临时实例做选主或分布式锁，分区时会出现双主。选主与锁请用 ZooKeeper / etcd，且要配合 fencing token（见 [Raft 与共识算法](#/distributed/consensus)）。
- **ZooKeeper 读到旧数据**：客户端连在一个落后的 Follower 上，刚由另一客户端写入的数据读不到。需要严格读时先调 `sync()`，或者让读写走同一会话（ZK 保证单会话内的顺序）。
- **主从延迟导致「读己之写」失败**：用户改完资料刷新页面看到旧值。方案：写后短时间内（如几秒）该用户读主库；或在 Session 中记录写入时的 GTID，从库执行到该位置再读。详见 [主从复制与高可用](#/mysql/replication)。
- **Cassandra / 多活场景 LWW 丢写**：两地同时修改同一行，时钟较慢的一方的更新被覆盖。对必须合并的数据改用 CRDT、业务字段拆分，或指定单元为写入主。
- **超时当失败处理**：转账接口超时后直接给用户报失败并允许重新发起，结果扣了两次。超时状态必须为「未知」，通过查询接口或对账确定结果，重新发起时复用同一业务流水号。
- **重试 + 非幂等接口**：网关、RPC 框架、MQ 都可能自动重试，Feign/Dubbo 默认重试策略要逐个确认；写接口默认关闭框架层重试，由业务层带幂等键重试。

## 相关阅读

- [MongoDB 复制集、分片与事务](#/db/mongo-cluster)：MongoDB 一致性旋钮
- [TiDB 架构：TiKV、PD、Raft 与分布式事务](#/db/tidb-arch)：NewSQL 如何在 CAP 中取舍

## 面试追问

> [!QUESTION] 为什么说 CAP 中 P 是必选的？「CA 系统」存在吗？
> 只要是跨网络的多节点系统，分区就一定会发生且无法与节点慢区分，系统必须定义分区时的行为，所以只能在 C 和 A 之间选。CA 只存在于单机或不复制数据的系统，单机 MySQL 可以算，但它一旦做主从就要面对切换时的 C/A 取舍。

> [!QUESTION] ZooKeeper 是强一致的吗？
> 写是线性一致的（经 Leader 由 ZAB 多数派提交），但读默认由客户端所连节点本地处理，可能读到旧值，整体提供的是顺序一致性加单会话 FIFO 保证；需要读到最新值时先 `sync()` 再读。etcd 默认读则走 ReadIndex，是线性一致的。

> [!QUESTION] Nacos 为什么同时支持 AP 和 CP？
> 两类实例需求不同：临时实例靠客户端心跳续约，掉线可快速剔除，用 Distro（AP）保证分区时仍能注册和发现；持久实例由服务端探活、不会因心跳丢失而删除，元数据需要强一致，用 Raft（CP）。

> [!QUESTION] W+R>N 就一定能读到最新值吗？
> 理想情况下是，但 sloppy quorum 会让集合不相交；并发写时靠时间戳 LWW 可能丢写；部分成功的写不会回滚；读到新值后另一个读仍可能读到旧值（非线性一致）。真正的线性一致需要单 Leader + 共识，或读写都做额外的同步/修复。

> [!QUESTION] Lamport 时钟和向量时钟的区别？
> Lamport 时钟是一个标量，能保证因果先后的事件时间戳有序，但时间戳小不代表发生在前，无法识别并发；向量时钟每个节点一个分量，可以精确判断两事件是先后还是并发，代价是空间随节点数增长。

> [!QUESTION] 如何设计一个支付回调接口的幂等？
> 以支付流水号为唯一键：先插入回调记录（唯一索引）或直接用状态机条件更新 `WHERE status='PAYING'`；影响行数为 0 时查询当前状态，已支付则直接返回成功；整个处理放在一个本地事务里，后续发 MQ 用本地消息表保证不丢。
