---
level: 深入
tags: [分片, 分区, 一致性哈希, 虚拟节点, Rendezvous 哈希, 范围分片, 哈希分片, 再平衡, 热点, 二级索引, 跨分片事务, 路由]
summary: 分布式系统的数据分片：分片策略（范围/哈希/目录/一致性哈希/Rendezvous/槽位）的原理与取舍、一致性哈希与虚拟节点、再平衡与迁移（固定分区、动态分裂、按节点比例）、分片键设计与热点治理、二级索引（本地/全局）、跨分片查询与事务、路由层设计与常见故障。
---

# 分片、一致性哈希与再平衡

> [!ABSTRACT] 核心要点
> - **分片（Partitioning/Sharding）** 把数据与负载切到多个节点，解决**单机容量与吞吐上限**；它与**复制**正交——通常是“**每个分片多副本**”的组合（见 [复制与一致性](#/distributed/replication)）。
> - 分片的**核心目标**：**数据与请求均匀**（无热点）、**扩缩容时搬迁量小**、**路由简单且可靠**、**常用查询尽量落在单个分片**。这些目标彼此冲突：**哈希分片均匀但范围查询差；范围分片范围查询好但易热点**。
> - **一致性哈希**让“增删节点只影响相邻一小段数据”（理想搬迁量约 1/N），用**虚拟节点**解决分布不均与故障时负载集中；**Rendezvous（HRW）哈希**与**预分槽（Redis Cluster 16384 槽）**是同类目标下更简单/更可控的替代。
> - **再平衡**的关键是**不要用 `hash(key) mod N`**（N 变化会让几乎所有数据搬迁）：采用**固定数量的分区（分片数 ≫ 节点数）**、**动态分裂/合并**、**按节点数比例分配**，并**限速迁移、可回退**。
> - **分片键决定一切**：选择高基数、分布均匀、与主要查询一致的键；**热点（大 V、秒杀商品、时间递增主键）**要用**键拆分、加盐、复合键、本地缓存**等治理。
> - **跨分片代价高**：二级索引（本地索引需 scatter-gather，全局索引要维护一致性）、跨分片 JOIN/聚合、**分布式事务**（2PC/Saga）——**设计时尽量让事务与热查询落在同一分片**，见 [分布式事务](#/distributed/transaction)。

## 为什么分片、怎么分

| 维度 | 说明 |
| --- | --- |
| **目的** | 容量扩展（数据超过单机）、吞吐扩展（读写压力分摊）、**故障隔离**（一个分片坏不影响全部）、数据就近/合规（按地域/租户） |
| **与复制的关系** | 分片=水平切；复制=每片多份；二者叠加：N 个分片 × R 个副本 |
| **与分库分表** | 业务层常说“分库分表”即分片的一种实现，见 [分库分表实践](#/mysql/sharding) |
| **何时不需要** | 单机/主从能满足且有明确余量；分片带来跨分片查询、事务、运维复杂度，**不要过早分片**（先垂直拆分、读写分离、缓存、归档） |

## 分片策略

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="常见分片策略对比：范围分片按键的连续区间分配，支持范围查询但易出现热点；哈希取模分片均匀但增减节点需大规模迁移；一致性哈希把节点和键映射到环上，增删节点只影响相邻区间；预分槽把键哈希到固定数量的槽，再把槽分配给节点，迁移以槽为单位；目录/查找表分片通过映射表灵活指定归属">
<rect class="b3" x="20" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">范围分片（Range）</text>
<text class="ts" x="195" y="60" text-anchor="middle">按键区间划分：[a–f]→节点1，[g–m]→节点2…</text>
<text class="ts" x="195" y="84" text-anchor="middle">＋ 范围查询/排序友好，可动态分裂区间</text>
<text class="ts" x="195" y="104" text-anchor="middle">－ 递增键（时间/自增）集中写最后一个分片</text>
<text class="ts" x="195" y="124" text-anchor="middle">－ 热点区间难均衡；代表：HBase、TiKV、Spanner</text>
<rect class="b5" x="390" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">哈希取模（hash mod N）</text>
<text class="ts" x="565" y="60" text-anchor="middle">节点 = hash(key) % N</text>
<text class="ts" x="565" y="84" text-anchor="middle">＋ 实现最简单，分布均匀</text>
<text class="ts" x="565" y="104" text-anchor="middle">－ N 变化时几乎全部数据要搬迁</text>
<text class="ts" x="565" y="124" text-anchor="middle">－ 范围查询要扫全部分片</text>
<rect class="b1" x="20" y="170" width="230" height="160" rx="10"/>
<text class="tb" x="135" y="190" text-anchor="middle" dominant-baseline="middle">一致性哈希（环）</text>
<text class="ts" x="135" y="216" text-anchor="middle">节点与键映射到环，</text>
<text class="ts" x="135" y="236" text-anchor="middle">键归顺时针第一个节点</text>
<text class="ts" x="135" y="262" text-anchor="middle">＋ 增删节点只动相邻区间</text>
<text class="ts" x="135" y="282" text-anchor="middle">－ 需虚拟节点保均衡</text>
<text class="ts" x="135" y="302" text-anchor="middle">代表：Dynamo、Cassandra</text>
<rect class="b2" x="270" y="170" width="230" height="160" rx="10"/>
<text class="tb" x="385" y="190" text-anchor="middle" dominant-baseline="middle">预分槽（Hash Slot）</text>
<text class="ts" x="385" y="216" text-anchor="middle">hash(key) % 固定槽数 → 槽</text>
<text class="ts" x="385" y="236" text-anchor="middle">槽 → 节点（映射表）</text>
<text class="ts" x="385" y="262" text-anchor="middle">＋ 迁移以槽为单位，可控</text>
<text class="ts" x="385" y="282" text-anchor="middle">－ 槽数需预先规划</text>
<text class="ts" x="385" y="302" text-anchor="middle">代表：Redis Cluster、Couchbase</text>
<rect class="b4" x="520" y="170" width="220" height="160" rx="10"/>
<text class="tb" x="630" y="190" text-anchor="middle" dominant-baseline="middle">目录/查找表</text>
<text class="ts" x="630" y="216" text-anchor="middle">映射表记录 key→分片</text>
<text class="ts" x="630" y="236" text-anchor="middle">（可按租户/用户）</text>
<text class="ts" x="630" y="262" text-anchor="middle">＋ 最灵活，可手动迁移大户</text>
<text class="ts" x="630" y="282" text-anchor="middle">－ 目录是单点与瓶颈</text>
<text class="ts" x="630" y="302" text-anchor="middle">需缓存+高可用</text>
</svg>
<figcaption>图 1：常见分片策略的原理与取舍</figcaption>
</figure>

| 策略 | 适合 | 不适合 |
| --- | --- | --- |
| **范围** | 需要范围扫描/排序（时序、分页、按区间查询）；可动态分裂 | 单调递增键且写入集中；需要极均匀负载 |
| **哈希 mod N** | 节点数基本固定、无需弹性 | 需要扩缩容 |
| **一致性哈希** | 缓存节点增减、无主 KV 存储 | 需要范围查询 |
| **预分槽** | 需要可控迁移、有集群管理器（Redis Cluster） | 完全去中心化无路由表场景 |
| **目录** | 多租户、有大客户需单独隔离、迁移灵活 | 目录服务难以高可用时 |
| **复合策略** | 先按租户/地域目录分，再在内部按哈希/范围分 | — |

## 一致性哈希

### 原理与问题

把哈希空间（如 0 ~ 2³²−1）看作一个**环**：节点按其哈希值放在环上；一个键 `k` 取 `hash(k)`，沿环**顺时针**找到的第一个节点即其归属。

- **新增节点**：只接管环上它前一个节点到它之间的键，**搬迁量约 1/N**；
- **删除/故障节点**：其负责区间交给顺时针下一个节点；
- **问题**：节点少时在环上分布不均，**负载倾斜**；一个节点故障，**全部压力落到下一个节点**，可能引发连锁过载。

### 虚拟节点（vnode）

每个物理节点映射成**多个虚拟节点**（如 100~500 个）散布在环上：

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="一致性哈希与虚拟节点：哈希环上有三个物理节点，每个物理节点对应多个虚拟节点交错分布；键沿顺时针找到第一个虚拟节点，再映射到物理节点；新增物理节点时，从多个其他节点各自匀出一小段区间，搬迁量约为一份均摊；节点故障时负载分散到多个节点而不是压在单个节点上">
<circle class="bg" cx="190" cy="165" r="120"/>
<circle cx="190" cy="45" r="10" class="b3"/>
<circle cx="294" cy="105" r="10" class="b5"/>
<circle cx="294" cy="225" r="10" class="b1"/>
<circle cx="190" cy="285" r="10" class="b3"/>
<circle cx="86" cy="225" r="10" class="b5"/>
<circle cx="86" cy="105" r="10" class="b1"/>
<text class="ts" x="190" y="30" text-anchor="middle">A#1</text>
<text class="ts" x="324" y="104" text-anchor="start">B#1</text>
<text class="ts" x="324" y="232" text-anchor="start">C#1</text>
<text class="ts" x="190" y="312" text-anchor="middle">A#2</text>
<text class="ts" x="56" y="232" text-anchor="end">B#2</text>
<text class="ts" x="56" y="104" text-anchor="end">C#2</text>
<text class="tb" x="190" y="160" text-anchor="middle" dominant-baseline="middle">哈希环</text>
<text class="ts" x="190" y="182" text-anchor="middle">A、B、C 各 2+ 个 vnode</text>
<rect class="bg" x="360" y="30" width="380" height="270" rx="8"/>
<text class="th" x="372" y="52">虚拟节点的作用</text>
<text class="ts" x="550" y="82" text-anchor="middle">① 均衡：vnode 数量多，随机分布更接近均匀</text>
<text class="ts" x="550" y="106" text-anchor="middle">② 故障分摊：A 故障时其多个 vnode 的区间</text>
<text class="ts" x="550" y="124" text-anchor="middle">　分别由不同节点接管，不会压垮单个邻居</text>
<text class="ts" x="550" y="148" text-anchor="middle">③ 异构容量：性能强的机器分配更多 vnode</text>
<text class="ts" x="550" y="172" text-anchor="middle">④ 扩容：新节点的 vnode 从各节点各取一小段</text>
<text class="ts" x="550" y="196" text-anchor="middle">代价：</text>
<text class="ts" x="550" y="216" text-anchor="middle">元数据变大（环的成员表）；</text>
<text class="ts" x="550" y="236" text-anchor="middle">复制时副本需要落在不同物理节点</text>
<text class="ts" x="550" y="256" text-anchor="middle">（沿环顺时针选 N 个不同物理节点）</text>
<text class="ts" x="550" y="284" text-anchor="middle">一个物理节点承载的数据由很多小段拼成</text>
</svg>
<figcaption>图 2：哈希环与虚拟节点</figcaption>
</figure>

```java
// 一致性哈希环（含虚拟节点）的核心实现思路
public class ConsistentHashRing<T> {
    private final TreeMap<Long, T> ring = new TreeMap<>();
    private final int vnodes;

    public ConsistentHashRing(int vnodes) { this.vnodes = vnodes; }

    public void addNode(T node) {
        for (int i = 0; i < vnodes; i++) {
            ring.put(hash(node + "#" + i), node);      // 每个物理节点放 vnodes 个虚拟节点
        }
    }
    public void removeNode(T node) {
        for (int i = 0; i < vnodes; i++) ring.remove(hash(node + "#" + i));
    }
    public T route(String key) {
        if (ring.isEmpty()) throw new IllegalStateException("no node");
        Map.Entry<Long, T> e = ring.ceilingEntry(hash(key));   // 顺时针第一个
        return (e != null ? e : ring.firstEntry()).getValue();  // 绕回环首
    }
    private long hash(String s) { /* 使用分布均匀的哈希（如 MurmurHash3），不要用 String.hashCode */ return 0; }
}
```

要点：**哈希函数要分布均匀且跨语言/版本稳定**（不要用 `String.hashCode` 或 JVM 相关的不稳定哈希，不同客户端算出的归属会不一致）；节点标识要稳定；成员变更要**让所有客户端/路由节点最终看到一致的环**，否则同一个键在不同客户端被路由到不同节点（缓存场景表现为命中率下降，存储场景表现为数据找不到）。

### 其他哈希方案

| 方案 | 思路 | 特点 |
| --- | --- | --- |
| **Rendezvous（HRW，最高随机权重）** | 对每个节点计算 `hash(key, node)`，**取得分最高的节点** | 无需环与虚拟节点，实现极简，**增删节点搬迁量同样最小**，天然支持**取前 K 个副本**；每次路由 O(N)（节点数不多时无碍） |
| **Jump Consistent Hash** | 谷歌提出的无状态算法，只需键与桶数，O(ln N)，几乎零内存 | 分布极均匀；**只支持桶编号 0..N-1 连续变化（尾部增减）**，不支持任意删除节点，适合有序分片编号的存储 |
| **Maglev 哈希** | 构建查找表，保证均衡与最小扰动 | 用于负载均衡器（如 Google Maglev） |
| **预分槽（固定分区）** | 槽数固定，维护“槽→节点”表 | 迁移粒度可控，管理器掌握分布，**Redis Cluster 16384 槽**，见 [主从、哨兵与 Cluster](#/redis/cluster) |
| **有界负载一致性哈希** | 给每个节点设置负载上限，超限顺延到下一个 | 缓解热点引发的单节点过载 |

## 再平衡

增删节点、数据增长、热点出现都需要**重新分配分片**。

### 策略

| 策略 | 做法 | 特点 |
| --- | --- | --- |
| **固定数量的分区（分片数 ≫ 节点数）** | 一开始创建很多分区（如 1000），新增节点时**从各节点匀走若干个完整分区** | 简单、迁移单位固定；分区数一旦选定难改（要预估上限：太少单分区过大，太多管理开销大）。Elasticsearch、Kafka、Redis Cluster、Couchbase 采用 |
| **动态分裂/合并** | 分区**达到大小/负载阈值时自动分裂**，过小则合并；新分区可迁移到新节点 | 适应数据量变化，**分区数随数据增长**；需要范围/哈希区间元数据支持。HBase、TiKV、Spanner、MongoDB 采用 |
| **按节点比例（每节点固定 vnode 数）** | 新节点随机选取已有分区一部分接管 | Cassandra 风格，分区数随节点数增长 |
| **手动/半自动** | 人工指定迁移对象，平台辅助执行 | 可控，适合大客户迁移，易出错 |

> [!WARNING] 不要用 `hash(key) % N` 做可扩缩容的分片
> N 从 3 变 4，约 **75% 的键归属变化**，缓存雪崩/数据大搬迁。若业务已经这样做（如分库分表按 `id % 库数`），扩容用**翻倍扩容**（N→2N，迁移约一半数据且规则清晰）或**逻辑分片 + 物理映射**（先分成很多逻辑库，再把逻辑库映射到物理库，扩容只改映射）。

### 迁移的工程要点

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="在线数据迁移流程：先决定要迁移的分区与目标节点，再对分区做快照拷贝，同时记录迁移期间的增量写，增量追平后短暂切换路由并停写校验，更新路由表并通知客户端，最后清理源数据；全程限速、可暂停、可回退，路由表版本化避免新旧路由混乱">
<rect class="b3" x="20" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">① 计划</text>
<text class="ts" x="75" y="82" text-anchor="middle">选分区·目标</text>
<rect class="b5" x="145" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">② 全量拷贝</text>
<text class="ts" x="200" y="82" text-anchor="middle">快照·限速</text>
<rect class="b1" x="270" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="330" y="62" text-anchor="middle" dominant-baseline="middle">③ 增量追平</text>
<text class="ts" x="330" y="82" text-anchor="middle">变更日志回放</text>
<rect class="b4" x="405" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="465" y="62" text-anchor="middle" dominant-baseline="middle">④ 切换</text>
<text class="ts" x="465" y="82" text-anchor="middle">短暂停写·校验</text>
<rect class="b2" x="540" y="40" width="100" height="60" rx="8"/>
<text class="tb" x="590" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 路由更新</text>
<text class="ts" x="590" y="82" text-anchor="middle">版本化下发</text>
<rect class="b3" x="655" y="40" width="85" height="60" rx="8"/>
<text class="tb" x="697" y="62" text-anchor="middle" dominant-baseline="middle">⑥ 清理</text>
<text class="ts" x="697" y="82" text-anchor="middle">延迟删源</text>
<line class="l" x1="130" y1="70" x2="145" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="70" x2="270" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="70" x2="405" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="525" y1="70" x2="540" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="70" x2="655" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="720" height="166" rx="8"/>
<text class="th" x="32" y="144">要点</text>
<text class="ts" x="380" y="168" text-anchor="middle">限速：迁移流量与线上业务争用带宽/IO，设置速率与并发上限，低峰执行，监控延迟</text>
<text class="ts" x="380" y="190" text-anchor="middle">一致性：增量追平 + 短暂停写（或双写）保证切换瞬间无丢失；切换后写入落到新位置，旧位置拒绝写（防止“双写分叉”）</text>
<text class="ts" x="380" y="212" text-anchor="middle">路由版本化：每份路由表带版本号；客户端发现路由过期（收到“不归我”的响应）后刷新，避免新旧混用</text>
<text class="ts" x="380" y="234" text-anchor="middle">可回退：迁移失败保留源数据，路由可切回；清理源数据延迟到确认稳定之后</text>
<text class="ts" x="380" y="256" text-anchor="middle">校验：迁移前后数量、校验和对比；抽样读写验证</text>
<text class="ts" x="380" y="278" text-anchor="middle">Redis Cluster 的槽迁移（MIGRATE + ASK）、ES 分片再平衡、Kafka 分区重分配做法类似</text>
</svg>
<figcaption>图 3：在线再平衡的典型流程</figcaption>
</figure>

## 分片键设计与热点

### 选择分片键

| 原则 | 说明 |
| --- | --- |
| **高基数** | 取值足够多，才能均匀分布；性别、状态这类低基数键不能做分片键 |
| **分布均匀** | 避免少数取值占据大部分数据/流量（偏斜） |
| **与主要查询一致** | 最常用的查询带上分片键，**单分片即可完成**；否则就是 scatter-gather（向所有分片查） |
| **事务边界对齐** | 需要原子操作的数据放同一分片（如订单与订单明细按订单号/用户号分片） |
| **不可变** | 分片键值变化意味着数据要搬家 |
| **避免单调递增** | 时间戳、自增 ID 作范围分片键会把写入集中到最后一个分片 |
| **兼顾多维度** | 订单既要按用户查又要按商家查：常见做法是**冗余写两份**（按用户分片一份、按商家分片一份，异步同步）或**全局索引表** |

> [!TIP] 常见实践
> 订单类：**按用户 ID 分片**（用户查订单最常见），商家侧通过冗余表/ES/数据仓库满足；ID 里**内嵌分片信息**（基因法：订单号包含用户 ID 的低几位），使得通过订单号也能直接定位分片，见 [分布式 ID 生成](#/distributed/id)。

### 热点与倾斜

| 类型 | 例子 | 治理 |
| --- | --- | --- |
| **键热点** | 明星用户、爆款商品、全局配置 | **本地缓存/多级缓存**、热点 key 复制多副本分散读、写热点拆分（分段计数后合并），见 [案例：高并发写入与热点治理](#/design/case-highwrite)、[Redis 大 key 与热 key 治理](#/redis/bigkey) |
| **范围热点** | 时间序列写入集中在最新区间 | **键前缀加盐**（如 `hash(id)%N` 前缀）打散，或复合键（设备 ID + 时间）；牺牲部分范围查询 |
| **租户倾斜** | 大租户数据量/流量远超其他 | 目录式分片，大租户独占分片或再细分；配额与限流 |
| **数据倾斜** | 分片数据量差异大 | 分片键选择、虚拟节点、再平衡；监控分片大小分布 |
| **访问模式变化** | 业务活动引起热点迁移 | 动态分裂与自动负载均衡（按负载而非仅按大小） |

**加盐的代价**：读取时需要查询所有盐值分片再合并（scatter-gather），适合“写热点、读可接受聚合”的场景。

## 二级索引与跨分片查询

数据按主键分片后，**按非分片键查询**怎么办：

| 方案 | 做法 | 优缺点 |
| --- | --- | --- |
| **本地二级索引（Document-partitioned）** | 每个分片只索引自己的数据；查询时**向所有分片发起、合并结果（scatter-gather）** | 写入简单（索引与数据同分片，单分片事务）；**读放大，尾延迟取决于最慢分片**（ES、MongoDB、Cassandra 的二级索引） |
| **全局二级索引（Term-partitioned）** | 索引本身再按索引键分片，查询只需访问相关的索引分片 | **读高效**；写入要更新多个分片上的索引，通常**异步更新（最终一致）**或需要分布式事务 |
| **冗余表/多份存储** | 按另一个维度再存一份 | 读最快；多写一致性靠异步同步 + 对账 |
| **搜索引擎旁路** | 把数据同步到 ES，复杂条件查询走 ES，见 [案例：搜索系统设计详解](#/design/case-search) | 灵活；最终一致，数据同步链路需治理 |
| **预聚合/宽表** | 按查询维度预计算结果 | 适合报表/看板 |

### 跨分片 JOIN、聚合、排序与分页

| 操作 | 难点 | 常用做法 |
| --- | --- | --- |
| **JOIN** | 数据在不同分片，网络 Shuffle | 小表广播、**让关联数据按相同键分片（共定位 co-location）**、应用层 JOIN、宽表冗余 |
| **聚合（COUNT/SUM/GROUP BY）** | 各分片局部聚合再合并 | 两阶段聚合；大规模用 OLAP 系统，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |
| **排序 + LIMIT** | 需要各分片取 Top(offset+limit) 再归并 | **深分页代价巨大**：offset 越大每个分片要返回越多；改用**游标/基于上一页末尾键的分页**（search_after） |
| **全局唯一约束** | 跨分片唯一性难保证 | 把唯一键作为分片键或在全局索引表上维护；或用分布式 ID 避免冲突 |
| **自增主键** | 各分片自增冲突 | 分布式 ID，见 [分布式 ID 生成](#/distributed/id) |

### 跨分片事务

- **尽量避免**：把需要原子更新的数据设计在同一分片；
- 不可避免时：**2PC/TCC/Saga/事务消息/本地消息表**，见 [分布式事务](#/distributed/transaction)；分布式数据库内部通常用 **“分片内共识 + 跨分片两阶段提交”**（Spanner、TiDB、CockroachDB）；
- 业务上用**最终一致 + 对账**替代强一致（如订单与库存通过事件同步），见 [事件驱动架构](#/design/event-driven)。

## 路由层设计

| 路由方式 | 说明 | 适用 |
| --- | --- | --- |
| **客户端路由（胖客户端）** | 客户端拿到分片/路由表，自己计算目标节点（Redis Cluster 客户端、Kafka 生产者） | 少一跳、低延迟；**客户端复杂**，拓扑变更要通知/刷新，升级困难 |
| **代理路由（Proxy）** | 客户端连接代理（ShardingSphere-Proxy、Twemproxy、Codis 等），由代理路由并聚合 | 客户端简单、集中治理；多一跳、代理需高可用与横向扩展 |
| **集群内转发** | 客户端连任意节点，节点转发或返回重定向（MOVED/ASK） | 实现简单；多一跳或需重试 |
| **中间层 SDK 内嵌分片逻辑** | ORM/数据源层分片（ShardingSphere-JDBC 等），见 [分库分表实践](#/mysql/sharding) | 无额外一跳；语言绑定，升级需重新发布 |

路由元数据的管理：**路由表由管理节点/元数据存储（如 etcd/ZooKeeper）持有、版本化、变更通知**，见 [分布式协调](#/mw/coordination)；客户端缓存路由并在收到“路由错误”响应时刷新；元数据服务不可用时客户端使用最后已知路由继续服务（降级）。

## 常见问题

| 现象 | 根因 | 对策 |
| --- | --- | --- |
| 扩容后缓存命中率暴跌 | `mod N` 分片导致大量键重新映射 | 一致性哈希/预分槽；翻倍扩容；预热 |
| 某个分片 CPU/IO 打满 | 热点键、范围热点、租户倾斜 | 本地缓存、加盐/复合键、租户隔离、动态分裂 |
| 分片数据量严重不均 | 分片键选择不当、vnode 过少 | 重选分片键/增加 vnode/再平衡 |
| 迁移期间读写失败或丢数据 | 切换时路由与数据不同步、双写分叉 | 版本化路由、短暂停写、旧位置拒写、可回退 |
| 跨分片查询慢 | scatter-gather，被最慢分片拖累 | 建全局索引/冗余表/搜索引擎；限制查询范围；超时与部分结果策略 |
| 深分页越翻越慢 | offset 越大各分片返回越多 | 游标分页 |
| 路由不一致（同一键不同客户端落不同节点） | 哈希函数不一致、成员视图不一致 | 统一哈希实现与版本，路由表版本化 |
| 分片数无法再增加 | 初期槽/分区数估计过小 | 预留余量；设计支持分裂的机制 |
| 热点迁走后新节点又热 | 只按数据量均衡未考虑负载 | 按 QPS/延迟做负载感知均衡 |
| 全局唯一/自增冲突 | 各分片独立生成 | 分布式 ID、号段、Snowflake |

## 相关阅读

- [复制与一致性：主从、多主与无主](#/distributed/replication)：每个分片的副本策略
- [分库分表实践](#/mysql/sharding)：MySQL 的分片落地
- [主从、哨兵与 Cluster](#/redis/cluster)：Redis 槽与迁移
- [分布式 ID 生成](#/distributed/id)：基因法与分片信息内嵌
- [分布式事务](#/distributed/transaction)：跨分片事务方案
- [Elasticsearch 原理](#/mw/es)：分片与路由的另一种实现

## 面试追问

> [!QUESTION] 为什么不能用 hash(key) % N 做可扩缩容的分片？应该怎么做？
> N 变化时几乎所有键的归属都会改变，需要大规模搬迁并造成缓存雪崩。应使用一致性哈希（带虚拟节点）、预分槽或固定数量的逻辑分区，再把分区映射到节点，扩容时只迁移少量分区；已用取模的系统可以翻倍扩容或引入逻辑分片到物理库的映射。

> [!QUESTION] 一致性哈希为什么要虚拟节点？
> 节点少时在环上分布不均导致负载倾斜，节点故障时全部负载落到顺时针下一个节点可能连锁过载。每个物理节点映射多个虚拟节点后分布更均匀，故障时负载分摊到多个节点，还能按机器能力分配不同数量的虚拟节点；代价是元数据变大，复制时要保证副本落在不同物理节点。

> [!QUESTION] 范围分片和哈希分片怎么选？
> 范围分片范围查询和排序友好、可动态分裂，但递增键会造成写入热点；哈希分片分布均匀、写入分散，但范围查询要扫所有分片。需要范围扫描用范围分片并对写热点加盐或复合键，纯点查与均衡优先用哈希分片，也可组合：先按租户或地域目录分，再内部哈希。

> [!QUESTION] 分片后按非分片键查询怎么办？
> 本地二级索引需要向所有分片发起并合并，读放大；全局二级索引按索引键再分片，读高效但写入需更新多个分片，通常异步最终一致；也可冗余存一份按另一个维度分片的表，或把数据同步到搜索引擎。要结合读写比例和一致性要求选择，并尽量让主要查询带分片键。

> [!QUESTION] 热点分片怎么治理？
> 先定位是键热点、范围热点还是租户倾斜。键热点用本地缓存、热 key 多副本、写热点分段合并；范围热点给键加盐或使用复合键打散，读时 scatter-gather；大租户用目录式分片独占；同时用动态分裂与按负载的均衡，监控分片大小和 QPS 分布。

> [!QUESTION] 在线再平衡要注意什么？
> 全量快照拷贝加增量追平，短暂停写或双写完成切换，切换后旧位置拒写防止分叉；路由表版本化，客户端发现路由过期就刷新；迁移限速避免影响线上，可暂停可回退，延迟清理源数据，迁移前后做数量与校验和比对。
