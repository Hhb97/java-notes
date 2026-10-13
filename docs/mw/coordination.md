---
level: 深入
tags: [ZooKeeper, etcd, ZAB, Raft, znode, Watch, Lease, 选主, 分布式锁, 配置中心, Curator, fencing]
summary: 分布式协调服务 ZooKeeper 与 etcd 的原理与实践：数据模型（znode、MVCC revision）、会话与租约、Watch 机制、读写一致性、选主/分布式锁/服务注册等经典配方（含羊群效应与 fencing）、Java 客户端（Curator、jetcd）、部署与运维坑，以及与 Consul、Nacos 的取舍。
---

# 分布式协调：ZooKeeper 与 etcd

> [!ABSTRACT] 核心要点
> - 协调服务用**一个小而强一致的元数据存储**，为分布式系统提供**选主、分布式锁、配置分发、成员管理、服务发现、屏障**等基础能力。它**不是通用数据库**：数据量小（MB~GB 级）、读多写少、写入要经共识协议，吞吐有限。
> - **ZooKeeper**：**树形 znode** 数据模型，**ZAB** 协议保证写入有序一致，**临时节点 + 会话**表达“存活”，**Watch**（一次性触发）通知变化；经典配方靠**顺序临时节点**。**读可以由 Follower 返回，默认可能读到旧数据**，需要强一致读要先 `sync`。
> - **etcd**：**扁平键值 + Raft + MVCC**（每次修改产生全局递增 **revision**），**Lease（租约）** 表达存活，**Watch 是流式、可从历史 revision 续订**，**事务（Txn）** 做比较并交换；是 **Kubernetes 的核心存储**。
> - 协调类原语的**正确性陷阱**比用法更重要：**会话/租约过期后的“僵尸持有者”**（GC 停顿、网络分区）会让两个节点同时以为自己是 Leader/锁持有者，必须靠 **fencing token（防护令牌）** 在资源端拒绝过期持有者。
> - 运维上最常见的问题：**磁盘 fsync 延迟高导致选主抖动**、**会话超时配置与 GC 不匹配**、**大数据/海量 key/海量 Watch 压垮集群**、**etcd 数据库空间耗尽（需压缩与碎片整理）**。
> - 选型：Kubernetes 与云原生基础设施用 **etcd**；传统大数据与 Dubbo/Kafka(旧版)/HBase 等生态用 **ZooKeeper**；微服务注册配置见 [Nacos 与服务注册发现、配置中心](#/mw/registry)。

## 协调服务到底提供什么

| 能力 | 说明 | 依赖的底层原语 |
| --- | --- | --- |
| **配置管理** | 集中存放、变更实时通知 | 数据节点 + Watch |
| **服务注册与发现** | 实例上线注册，下线或宕机自动摘除 | 临时节点/租约 + Watch |
| **Leader 选举** | 多副本中选出唯一主 | 顺序临时节点 / 带租约的唯一 key |
| **分布式锁** | 跨进程互斥 | 同上 |
| **成员管理与心跳** | 谁在线、谁掉线 | 会话/租约 |
| **屏障与计数** | 等所有人到齐再继续 | 子节点计数 + Watch |
| **元数据存储** | 集群元信息（如 Kafka 旧版控制器与 Topic 元数据、K8s 对象状态） | 一致的 KV |

因为所有写入都要经过共识（多数派确认），**写吞吐和延迟有限**，并且每个节点保存全量数据在内存/磁盘。**不要把业务数据、大文件、高频计数放进去**。共识算法原理见 [Raft 与共识算法](#/distributed/consensus)，一致性模型见 [CAP、BASE 与一致性模型](#/distributed/theory)。

## ZooKeeper

### 数据模型：znode

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="ZooKeeper 数据模型与 Watch：树形 znode，包含持久节点、临时节点、顺序节点；客户端建立会话，临时节点随会话结束删除；客户端对节点设置 Watch，节点变化时服务端一次性通知客户端，客户端需重新读取并重新设置 Watch">
<rect class="b3" x="20" y="14" width="360" height="200" rx="10"/>
<text class="th" x="200" y="34" text-anchor="middle">znode 树</text>
<rect class="b5" x="150" y="48" width="100" height="26" rx="6"/>
<text class="ts" x="200" y="61" text-anchor="middle" dominant-baseline="middle">/ （根）</text>
<rect class="b1" x="40" y="96" width="110" height="26" rx="6"/>
<text class="ts" x="95" y="109" text-anchor="middle" dominant-baseline="middle">/config（持久）</text>
<rect class="b1" x="165" y="96" width="110" height="26" rx="6"/>
<text class="ts" x="220" y="109" text-anchor="middle" dominant-baseline="middle">/services</text>
<rect class="b1" x="290" y="96" width="80" height="26" rx="6"/>
<text class="ts" x="330" y="109" text-anchor="middle" dominant-baseline="middle">/locks</text>
<rect class="b2" x="150" y="148" width="130" height="26" rx="6"/>
<text class="ts" x="215" y="161" text-anchor="middle" dominant-baseline="middle">/svc/host1（临时）</text>
<rect class="b4" x="290" y="148" width="80" height="26" rx="6"/>
<text class="ts" x="330" y="161" text-anchor="middle" dominant-baseline="middle">lock-0001</text>
<line class="ld" x1="200" y1="74" x2="95" y2="96"/>
<line class="ld" x1="200" y1="74" x2="220" y2="96"/>
<line class="ld" x1="200" y1="74" x2="330" y2="96"/>
<line class="ld" x1="220" y1="122" x2="215" y2="148"/>
<line class="ld" x1="330" y1="122" x2="330" y2="148"/>
<text class="ts" x="200" y="198" text-anchor="middle">每个节点有数据（默认 &lt;1MB）+ 子节点 + 版本 + 状态信息</text>
<rect class="bg" x="400" y="14" width="340" height="200" rx="10"/>
<text class="th" x="570" y="34" text-anchor="middle">节点类型</text>
<text class="ts" x="570" y="62" text-anchor="middle">持久（Persistent）：显式删除才消失</text>
<text class="ts" x="570" y="88" text-anchor="middle">临时（Ephemeral）：会话结束自动删除，不能有子节点</text>
<text class="ts" x="570" y="114" text-anchor="middle">顺序（Sequential）：名称后自动追加递增序号</text>
<text class="ts" x="570" y="140" text-anchor="middle">容器（Container）：子节点删光后自动清理</text>
<text class="ts" x="570" y="166" text-anchor="middle">TTL 节点：未修改超时后自动删除（需开启）</text>
<text class="ts" x="570" y="196" text-anchor="middle">组合：临时顺序节点 = 选主/锁的基石</text>
<rect class="b" x="20" y="232" width="720" height="86" rx="8"/>
<text class="th" x="32" y="252">Watch（观察者）</text>
<text class="ts" x="380" y="276" text-anchor="middle">客户端读取时可对节点注册 Watch；节点数据变化/删除/子节点变化时，服务端向客户端发送一次通知</text>
<text class="ts" x="380" y="296" text-anchor="middle">一次性：触发后失效，必须重新读取并再次注册；通知只告知“发生了变化”，需要重新读取最新值，期间的多次变化可能被合并</text>
<text class="ts" x="380" y="312" text-anchor="middle">重新读取与重新注册之间有间隙：靠“读取时带上 Watch”原子完成，不要先读后注册</text>
</svg>
<figcaption>图 1：ZooKeeper 的 znode 树、节点类型与 Watch</figcaption>
</figure>

### 会话（Session）

- 客户端连接后创建**会话**，带一个**会话超时时间**（协商出 tickTime 的倍数范围）；客户端周期性发心跳；
- 连接断开不等于会话结束：客户端会**重连集群中的其他服务器**，只要在超时内重新连上，会话和临时节点就保留；
- 会话**过期**（超时未恢复）后，服务端删除该会话的所有临时节点并触发相关 Watch；客户端收到过期事件后**必须重建会话与状态**（锁已失效、Leader 身份已丢失）；
- 客户端状态：Connected / Disconnected（暂时断开，可能恢复）/ Expired（已过期，不可恢复）。**区分 Disconnected 与 Expired** 是写出正确选主与锁代码的关键。

### 一致性保证

| 保证 | 含义 |
| --- | --- |
| **顺序一致性** | 来自同一客户端的更新按发送顺序应用 |
| **原子性** | 更新要么成功要么失败，没有中间状态 |
| **单一系统映像** | 客户端无论连到哪台服务器，看到的视图一致（不会回退到更旧的状态） |
| **可靠性** | 一旦更新成功，除非被覆盖，会一直保持 |
| **及时性** | 客户端视图在一定时间范围内保证最新 |

**读不一定是线性一致的**：读请求由**所连接的服务器本地处理**（含 Follower），可能读到**落后于 Leader 的数据**。需要读到最新数据时，先调用 `sync()` 再读。写请求都转发给 Leader，经 **ZAB 协议**（类似两阶段：Leader 提议 → 过半 Follower 确认 → 提交）全局有序。

**角色**：Leader（处理写）、Follower（参与投票、服务读）、**Observer**（不参与投票，只服务读并同步数据，用于**扩展读能力而不影响写性能**，适合跨机房读）。

### 经典配方

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="基于顺序临时节点的选主与公平锁：每个客户端创建临时顺序节点，序号最小者为 Leader 或锁持有者，其余客户端只 Watch 自己的前一个节点，前驱删除时才被唤醒，避免羊群效应；持有者宕机则会话过期节点删除，下一位接管；需要 fencing token 防止僵尸持有者">
<text class="th" x="20" y="22">/election 下的临时顺序节点</text>
<rect class="b2" x="20" y="34" width="150" height="46" rx="8"/>
<text class="tb" x="95" y="52" text-anchor="middle" dominant-baseline="middle">n-0000001</text>
<text class="ts" x="95" y="70" text-anchor="middle">客户端 A（Leader）</text>
<rect class="b1" x="200" y="34" width="150" height="46" rx="8"/>
<text class="tb" x="275" y="52" text-anchor="middle" dominant-baseline="middle">n-0000002</text>
<text class="ts" x="275" y="70" text-anchor="middle">客户端 B（Watch 前驱）</text>
<rect class="b1" x="380" y="34" width="150" height="46" rx="8"/>
<text class="tb" x="455" y="52" text-anchor="middle" dominant-baseline="middle">n-0000003</text>
<text class="ts" x="455" y="70" text-anchor="middle">客户端 C（Watch 前驱）</text>
<line class="la" x1="275" y1="80" x2="95" y2="100" marker-end="url(#arr-a)"/>
<line class="la" x1="455" y1="80" x2="275" y2="100" marker-end="url(#arr-a)"/>
<text class="ta" x="190" y="112" text-anchor="middle">B 只监听 A 的节点</text>
<text class="ta" x="370" y="112" text-anchor="middle">C 只监听 B 的节点</text>
<rect class="bg" x="560" y="30" width="180" height="82" rx="8"/>
<text class="th" x="650" y="50" text-anchor="middle">为什么只 Watch 前驱</text>
<text class="ts" x="650" y="74" text-anchor="middle">避免“羊群效应”：</text>
<text class="ts" x="650" y="94" text-anchor="middle">一个节点变化唤醒全部</text>
<rect class="b" x="20" y="130" width="720" height="86" rx="8"/>
<text class="th" x="32" y="150">流程</text>
<text class="ts" x="380" y="174" text-anchor="middle">① 创建临时顺序节点 → ② 读取所有子节点，若自己序号最小则成为 Leader / 获得锁</text>
<text class="ts" x="380" y="194" text-anchor="middle">③ 否则对序号恰好比自己小的节点设置 Watch → ④ 它被删除（释放或会话过期）后重新检查，成为最小者即上位</text>
<text class="ts" x="380" y="210" text-anchor="middle">公平：按创建顺序依次获得；持有者进程崩溃，会话过期后节点自动删除，锁自动释放</text>
<rect class="b4" x="20" y="232" width="720" height="86" rx="8"/>
<text class="th" x="32" y="252">陷阱：僵尸持有者</text>
<text class="ts" x="380" y="276" text-anchor="middle">Leader 因长时间 GC 暂停/网络分区，会话已过期、节点已被删除、新 Leader 已产生，但旧 Leader 恢复后仍以为自己是 Leader</text>
<text class="ts" x="380" y="296" text-anchor="middle">对策：写下游资源时携带单调递增的 fencing token（如节点序号/事务 ID），资源端拒绝较旧 token 的写入</text>
<text class="ts" x="380" y="312" text-anchor="middle">同时在客户端监听连接状态，进入 Disconnected 就应该暂停关键操作，Expired 就放弃领导权</text>
</svg>
<figcaption>图 2：顺序临时节点实现选主与公平锁，以及 fencing 防护</figcaption>
</figure>

| 配方 | 做法 |
| --- | --- |
| **服务注册** | 每个实例在 `/services/<名>/` 下创建**临时节点**（数据为地址与元信息）；调用方读取子节点列表并 Watch 子节点变化；实例宕机后会话过期自动摘除 |
| **配置中心** | 配置存于持久节点；客户端本地缓存并 Watch，变更后重新读取；注意**变更风暴**与客户端缓存一致性 |
| **Leader 选举** | 如上，顺序临时节点；Curator 提供 `LeaderLatch`、`LeaderSelector` |
| **公平分布式锁** | 同选主；Curator 提供 `InterProcessMutex`（可重入）、读写锁、信号量 |
| **屏障/计数** | 子节点数量达到阈值后放行（DoubleBarrier） |
| **队列** | 顺序节点做队列，量大时性能不佳，不建议当消息队列用 |

> [!WARNING] 分布式锁的正确期望
> 基于 ZooKeeper/etcd 的锁**能保证互斥的前提是会话/租约有效**。GC 停顿、时钟与网络问题会造成“持有者以为自己还持有”。**要保证安全性，被保护的资源必须支持 fencing**；若只是“尽量避免重复执行”的效率型锁，可接受偶发违例。基于 Redis 的锁与对比见 [Redis 分布式锁](#/redis/lock)。

### Java 客户端：Curator

原生客户端较底层（Watch 一次性、重连需自己处理）。**Apache Curator** 封装了重连、重试、配方与缓存：

```java
CuratorFramework client = CuratorFrameworkFactory.builder()
        .connectString("zk1:2181,zk2:2181,zk3:2181")
        .sessionTimeoutMs(30_000)
        .connectionTimeoutMs(5_000)
        .retryPolicy(new ExponentialBackoffRetry(1000, 5))
        .build();
client.start();

// 选主：LeaderLatch
LeaderLatch latch = new LeaderLatch(client, "/jobs/rebalancer/leader");
latch.addListener(new LeaderLatchListener() {
    public void isLeader()  { startWork(); }        // 获得领导权
    public void notLeader() { stopWorkImmediately(); } // 失去领导权（含连接挂起）必须立即停止
});
latch.start();

// 互斥锁
InterProcessMutex lock = new InterProcessMutex(client, "/locks/order-123");
if (lock.acquire(3, TimeUnit.SECONDS)) {
    try { doBusiness(); } finally { lock.release(); }
}

// 配置缓存：本地缓存 + 变更监听
CuratorCache cache = CuratorCache.build(client, "/config/app");
cache.listenable().addListener(CuratorCacheListener.builder()
        .forChanges((oldNode, node) -> reload(node.getData())).build());
cache.start();
```

要点：重试策略要有上限；监听 `ConnectionState`（SUSPENDED 时暂停关键动作，LOST 时放弃身份）；会话超时需与应用 **GC 暂停时间**匹配（过短易误判过期，过长故障摘除慢）。

### 部署与运维

| 要点 | 说明 |
| --- | --- |
| **节点数** | **奇数**，3 台容忍 1 个故障，5 台容忍 2 个；更多节点会拖慢写入，扩读用 Observer |
| **磁盘** | **事务日志（dataLogDir）使用独立的低延迟磁盘**（SSD），与快照目录分离；磁盘 fsync 慢是延迟与选主抖动的头号原因 |
| **内存** | 全量数据在内存，堆需足够并避免交换；JVM GC 暂停会导致会话超时，调好 GC 与堆 |
| **快照与日志清理** | 开启自动清理（`autopurge`），否则日志无限增长 |
| **数据规模** | 单节点数据默认限制约 1MB；控制节点总数与 Watch 总数；不要存大对象 |
| **ACL 与安全** | 启用 SASL/TLS，按路径设置 ACL；暴露到内网之外是高危 |
| **监控** | 延迟（avg/max latency）、未处理请求数、连接数、Watch 数、节点数、Leader 变化次数、fsync 时间；四字命令/管理端点谨慎开放 |
| **跨机房** | 多数派跨机房则写延迟高；通常 3 机房奇数部署或用 Observer 做异地读，避免跨洲际写 |

## etcd

### 架构与数据模型

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="etcd 架构：客户端经 gRPC 访问，请求进入 Raft 模块，Leader 复制日志到多数节点后提交，应用到 MVCC 存储，存储使用 bbolt 保存多版本键值，WAL 做预写日志；Watch 从历史 revision 流式推送；Lease 到期删除附着的键；Txn 做比较并交换">
<rect class="b3" x="20" y="30" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">客户端</text>
<text class="ts" x="80" y="74" text-anchor="middle">gRPC / HTTP2</text>
<rect class="b5" x="170" y="14" width="120" height="100" rx="8"/>
<text class="tb" x="230" y="34" text-anchor="middle" dominant-baseline="middle">API 层</text>
<text class="ts" x="230" y="58" text-anchor="middle">KV·Watch</text>
<text class="ts" x="230" y="76" text-anchor="middle">Lease·Txn</text>
<text class="ts" x="230" y="94" text-anchor="middle">Auth·Maintenance</text>
<rect class="b4" x="320" y="14" width="130" height="100" rx="8"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">Raft 模块</text>
<text class="ts" x="385" y="58" text-anchor="middle">选主·日志复制</text>
<text class="ts" x="385" y="76" text-anchor="middle">过半提交</text>
<text class="ts" x="385" y="94" text-anchor="middle">WAL 预写日志</text>
<rect class="b1" x="480" y="14" width="260" height="100" rx="8"/>
<text class="tb" x="610" y="34" text-anchor="middle" dominant-baseline="middle">MVCC 存储（bbolt）</text>
<text class="ts" x="610" y="58" text-anchor="middle">每次写产生新 revision，保留历史版本</text>
<text class="ts" x="610" y="76" text-anchor="middle">key → (revision, 值)；B+ 树索引</text>
<text class="ts" x="610" y="94" text-anchor="middle">定期 compaction 回收旧版本</text>
<line class="l" x1="140" y1="65" x2="170" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="65" x2="320" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="65" x2="480" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="134" width="720" height="176" rx="8"/>
<text class="th" x="32" y="154">关键特性</text>
<text class="ts" x="380" y="178" text-anchor="middle">Revision：全局单调递增的版本号，每次事务 +1；支持“读历史版本”“从某 revision 起 Watch”，断线续订不丢事件</text>
<text class="ts" x="380" y="200" text-anchor="middle">Lease：租约带 TTL，需 KeepAlive 续约；到期则附着的 key 全部删除（类似临时节点，可多 key 共享）</text>
<text class="ts" x="380" y="222" text-anchor="middle">Txn：If（比较 version/value/revision）→ Then / Else 操作，原子执行，是锁与选举的基础（比较并交换）</text>
<text class="ts" x="380" y="244" text-anchor="middle">读：默认线性一致读（ReadIndex，经 Leader 确认）；也可选串行读（本地读，更快但可能旧）</text>
<text class="ts" x="380" y="266" text-anchor="middle">前缀与范围：key 是扁平字节串，用“/a/b/”前缀模拟目录，支持范围查询与前缀 Watch</text>
<text class="ts" x="380" y="288" text-anchor="middle">容量：建议数据库大小控制在数 GB 量级（默认配额较小，需要显式调整），超出配额会进入只读告警</text>
</svg>
<figcaption>图 3：etcd 的架构与关键机制</figcaption>
</figure>

### 与 ZooKeeper 的差异

| 维度 | ZooKeeper | etcd |
| --- | --- | --- |
| 共识 | ZAB | **Raft** |
| 数据模型 | 层级 znode 树 | **扁平键值**，用前缀模拟目录 |
| 版本与历史 | 节点版本号，不保留历史 | **MVCC**，全局 revision，可读历史、可从历史 revision Watch |
| Watch | **一次性**，需重新注册，可能漏中间变化 | **流式**，可持续订阅并从指定 revision 续订，不漏事件 |
| 存活表达 | 会话 + 临时节点 | **Lease** + 附着 key（更灵活） |
| 事务 | 多操作 `multi`（有限） | **Txn**（比较-执行），表达力更强 |
| 读一致性 | 默认读本地，可能旧，`sync` 后强一致 | **默认线性一致读**，可选串行读 |
| 协议与接入 | 自有二进制协议，客户端库较复杂 | **gRPC**，多语言客户端易生成 |
| 典型生态 | Hadoop/HBase/老版 Kafka/Dubbo/Curator | **Kubernetes**、云原生组件 |
| 数据规模 | 小（受限于单节点内存） | 数 GB 级，注意配额与碎片 |

### 分布式锁与选主（etcd）

- 基础做法：**用 Lease 创建 key（带 revision）**，比较 key 的创建 revision 排队，**最小 revision 持有锁**，其余 Watch 前一个 key（与 ZooKeeper 思路一致）；
- 官方客户端库提供 `concurrency` 包的 `Session`、`Mutex`、`Election`；
- **fencing**：锁 key 的 **revision 是天然单调递增的 fencing token**，下游写入时携带，资源端拒绝更小的 revision；
- Session 的 Lease 过期（网络分区、GC）后锁自动释放，同样存在僵尸持有者问题，原则同上。

```java
// jetcd 示例：租约 + 锁（示意）
Client client = Client.builder().endpoints("http://etcd1:2379", "http://etcd2:2379").build();
Lease lease = client.getLeaseClient();
long leaseId = lease.grant(15).get().getID();         // TTL 15 秒
lease.keepAlive(leaseId, new StreamObserver<>() { /* 续约回调，出错要感知并放弃锁 */ });

Lock lock = client.getLockClient();
ByteSequence key = lock.lock(ByteSequence.from("/locks/job-1", UTF_8), leaseId).get().getKey();
try {
    long fencingToken = parseRevision(key);           // 用锁 key 的 revision 作为 fencing token
    doBusiness(fencingToken);
} finally {
    lock.unlock(key).get();
}
```

### 运维要点

| 问题 | 说明与对策 |
| --- | --- |
| **磁盘延迟** | WAL fsync 慢会导致心跳超时、频繁选主；使用独立 SSD，监控 `wal_fsync` 与 `backend_commit` 延迟 |
| **数据库空间耗尽（NOSPACE）** | MVCC 历史版本累积；开启**自动压缩（compaction）**，并定期**碎片整理（defrag）** 释放磁盘；达到配额后集群只读，需要先压缩+整理再解除告警 |
| **大 value / 大事务** | 单个请求大小有限制；不要放大对象；批量操作分批 |
| **Watch 过多** | 每个 Watch 占内存与 CPU；K8s 等大规模场景需要合理的 watch 缓存与分片，避免“惊群” |
| **节点数** | 3 或 5，奇数；更多节点降低写性能 |
| **成员变更** | 一次只变更一个成员，先加后减；先备份快照 |
| **备份恢复** | 定期 `snapshot save`，演练恢复；K8s 的 etcd 备份是集群灾备的核心 |
| **网络** | 节点间低延迟；跨可用区部署要评估心跳与选举超时参数 |
| **安全** | 启用客户端与对等通信的 TLS、认证与 RBAC；etcd 等于集群“大脑”，不能暴露 |
| **监控** | Leader 变化次数、提案失败/落后、DB 大小与使用率、fsync 延迟、gRPC 请求延迟、Watcher 数量 |

在 Kubernetes 中，etcd 保存全部 API 对象，**控制面稳定性取决于 etcd**；大规模集群要限制对象数量与大小、避免频繁的大范围 List/Watch，见 [Kubernetes 核心概念](#/infra/k8s)。

## 选型：ZooKeeper、etcd、Consul 与 Nacos

| 需求 | 倾向 | 原因 |
| --- | --- | --- |
| Kubernetes、云原生控制面 | **etcd** | 事实标准，Watch/Lease 契合 |
| Hadoop/HBase 等传统大数据生态、Curator 配方成熟 | **ZooKeeper** | 生态与存量 |
| 微服务注册发现 + 配置中心（Java/Spring Cloud/Dubbo 国内体系） | **Nacos** | 面向服务发现与配置的完整产品，健康检查、控制台、灰度配置，见 [Nacos 与服务注册发现、配置中心](#/mw/registry) |
| 多数据中心服务发现、服务网格 | Consul | 多 DC、健康检查、KV 与 ACL 集成 |
| 仅需要“选主/互斥”且已有 Redis/数据库 | 评估数据库/Redis 方案 | 避免为一个小需求引入新集群；但要明确一致性代价 |
| 强安全性的锁 | 基于协调服务 + fencing | 单靠 TTL 的锁不安全 |

选型时不要仅比较理论特性，**优先复用组织内已经有运维能力的系统**；新引入的协调集群会成为所有依赖方的单点级基础设施，需要同等级别的监控与演练。

## 常见坑汇总

| 坑 | 后果 | 对策 |
| --- | --- | --- |
| 把协调服务当数据库/消息队列 | 写入压垮、内存暴涨、延迟抖动 | 只存元数据与小配置；大数据放别处 |
| 会话/租约超时与 GC 暂停不匹配 | 频繁误判下线、反复选主 | 调优 GC，合理设置超时，监控 GC 暂停 |
| 忽略 Disconnected 状态 | 连接断开期间仍执行领导任务，出现双主 | 监听连接状态，暂停关键操作，过期后放弃身份 |
| 锁没有 fencing | 僵尸持有者破坏数据 | 资源端校验单调令牌 |
| Watch 被当作可靠队列 | 丢事件（ZK 一次性）或漏处理 | 通知后重新读取全量状态；etcd 用 revision 续订；业务以状态为准而非以事件为准 |
| 海量节点/Key/Watch | 内存与启动恢复时间爆炸 | 控制规模，分层与分片，客户端缓存 |
| 磁盘与网络共用、混部重负载 | 心跳超时、选主抖动 | 专用盘、独立部署、监控 |
| 配置变更无灰度 | 一次全量下发引发全局事故 | 配置分层、灰度、版本与回滚（见配置中心） |
| 偶数节点或跨洲部署 | 容错度不增加、写延迟高 | 奇数节点；跨地域用 Observer 或多集群 |

## 相关阅读

- [Raft 与共识算法](#/distributed/consensus)：etcd 使用的共识原理
- [CAP、BASE 与一致性模型](#/distributed/theory)：线性一致与顺序一致的区别
- [Redis 分布式锁](#/redis/lock)：效率型锁与安全型锁的取舍
- [Nacos 与服务注册发现、配置中心](#/mw/registry)：微服务场景的注册与配置
- [案例：分布式任务调度系统设计详解](#/design/case-scheduler)：选主与任务分片的实际应用
- [Paxos 与共识算法族：原理、变体与对比](#/distributed/paxos)：共识算法族
- [故障模型、故障检测与脑裂](#/distributed/fault)：租约与 fencing

## 面试追问

> [!QUESTION] ZooKeeper 的数据模型和 Watch 机制是什么？
> 数据是树形的 znode，每个节点存小数据和子节点，类型有持久、临时、顺序、容器和 TTL；临时节点随会话结束删除。客户端读取时可设置 Watch，节点变化时服务端发送一次性通知，触发后失效，需要重新读取并重新注册，期间多次变化可能合并，所以应以重新读取的状态为准。

> [!QUESTION] ZooKeeper 怎么实现分布式锁和选主？如何避免羊群效应？
> 每个客户端在锁目录下创建临时顺序节点，序号最小者持有锁或成为 Leader，其他客户端只 Watch 序号比自己小的前一个节点，前驱删除才被唤醒，这样每次只唤醒一个，避免全部客户端被同时唤醒的羊群效应。持有者宕机会话过期后节点自动删除，下一个接管。

> [!QUESTION] 基于 ZooKeeper 或 etcd 的锁一定安全吗？
> 不一定。会话或租约过期后，持有者可能因 GC 停顿或网络分区仍以为自己持有锁，造成两个持有者并存。要保证安全，被保护资源要支持 fencing token，资源端拒绝旧令牌的写入；客户端也要监听连接状态，断开就暂停关键操作，过期就放弃身份。

> [!QUESTION] etcd 和 ZooKeeper 有什么区别？
> etcd 用 Raft、扁平键值和 MVCC，有全局 revision，Watch 是流式且可从历史 revision 续订，Lease 灵活，Txn 表达力强，默认线性一致读，通过 gRPC 访问，是 Kubernetes 的存储；ZooKeeper 用 ZAB、层级 znode，Watch 一次性，读默认可能旧，生态在 Hadoop、HBase、Curator 等传统体系。

> [!QUESTION] ZooKeeper 读到的数据一定是最新的吗？
> 不一定。读由所连服务器本地处理，Follower 可能落后于 Leader，ZooKeeper 保证的是顺序一致而非线性一致。需要最新数据时先调用 sync 再读；写则统一经 Leader 通过 ZAB 过半提交，全局有序。

> [!QUESTION] etcd 线上遇到空间告警（NOSPACE）怎么处理？
> 原因是 MVCC 历史版本累积超过配额。先做 compaction 回收旧版本，再 defrag 整理碎片释放磁盘，然后解除告警；根治办法是开启自动压缩、控制写入频率和 value 大小，监控数据库使用率，并检查是否有高频更新的 key。
