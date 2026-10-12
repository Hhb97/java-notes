---
level: 高级
tags: [MongoDB, 复制集, oplog, 选举, writeConcern, readConcern, 分片, 分片键, 事务, 变更流]
summary: MongoDB 的高可用与扩展：复制集的 oplog 复制与选举、故障转移与回滚、写关注/读关注/读偏好的组合与一致性语义、因果一致性、多文档事务及其代价、分片集群架构（mongos、配置服务器、分片）、分片键选择（范围/哈希/复合）与热点、chunk 迁移与均衡器、跨分片查询、备份与运维要点和常见坑。
---

# MongoDB 复制集、分片与事务

> [!ABSTRACT] 核心要点
> - **复制集（Replica Set）**是 MongoDB 高可用的基本单位：一主多从，**主节点写入并记录 oplog，从节点异步重放**；主节点宕机后**自动选举**新主（类 Raft 协议，需**多数派**）。生产至少 **3 个投票节点**。
> - **一致性由三个旋钮决定**：**写关注（w/j）**决定写入确认到什么程度、**读关注（readConcern）**决定读到什么级别的数据、**读偏好（readPreference）**决定读哪个节点。**重要数据：`w:"majority"` + `readConcern:"majority"`**，否则主节点故障时可能出现**已确认的写入被回滚**。
> - **分片（Sharding）**解决单机容量与吞吐：**mongos 路由 + 配置服务器存元数据 + 多个分片（每个分片是复制集）**。**分片键**一旦选错代价极大：要同时兼顾**基数高、写入分布均匀、查询能带上分片键**。
> - **多文档事务**从 4.0（复制集）/ 4.2（分片集群）起支持，但**有性能代价与限制**；MongoDB 的最佳实践是**用文档模型尽量避免跨文档事务**。
> - 常见问题：写关注太弱导致回滚丢数据、单调递增分片键造成写热点、scatter-gather 广播查询、jumbo chunk、从库延迟读到旧数据。

> [!NOTE] 关联
> 数据模型与索引见 [MongoDB 数据模型、索引与聚合](#/db/mongo-model)；复制与共识的通用原理见 [CAP 与 BASE](#/distributed/theory)、[Raft 与共识](#/distributed/consensus)；与 MySQL 主从对比见 [MySQL 主从复制](#/mysql/replication)。

## 一、复制集

### 1. 架构与 oplog 复制

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="复制集架构：客户端写入主节点，主节点把操作记录到 oplog 集合；两个从节点持续拉取主节点的 oplog 并重放到自己的数据；节点之间互相发送心跳；主节点故障时从节点发起选举，获得多数票的成为新主；可选仲裁节点只投票不存数据；隐藏节点和延迟节点用于备份与报表">
<rect class="b1" x="20" y="130" width="110" height="56" rx="8"/>
<text class="tb" x="75" y="158" text-anchor="middle" dominant-baseline="middle">应用 / 驱动</text>
<rect class="b3" x="230" y="40" width="190" height="96" rx="12"/>
<text class="th" x="246" y="64">Primary 主节点</text>
<text class="ts" x="246" y="86">接收所有写入</text>
<text class="ts" x="246" y="106">写数据 + 写 oplog（local.oplog.rs）</text>
<text class="ts" x="246" y="124">oplog 是固定大小的 capped 集合</text>
<rect class="b2" x="500" y="20" width="200" height="76" rx="12"/>
<text class="th" x="516" y="44">Secondary 1</text>
<text class="ts" x="516" y="66">拉取 oplog → 重放</text>
<text class="ts" x="516" y="84">可承担读（读偏好）</text>
<rect class="b2" x="500" y="110" width="200" height="76" rx="12"/>
<text class="th" x="516" y="134">Secondary 2</text>
<text class="ts" x="516" y="156">拉取 oplog → 重放</text>
<text class="ts" x="516" y="174">可设为隐藏/延迟节点</text>
<line class="l" x1="130" y1="150" x2="230" y2="100" marker-end="url(#arr)"/>
<line class="la" x1="500" y1="58" x2="420" y2="70" marker-end="url(#arr-a)"/>
<line class="la" x1="500" y1="148" x2="420" y2="118" marker-end="url(#arr-a)"/>
<text class="ta" x="440" y="52" text-anchor="start">拉取 oplog</text>
<line class="ld" x1="600" y1="96" x2="600" y2="110"/>
<rect class="bg" x="20" y="210" width="760" height="106" rx="10"/>
<text class="th" x="36" y="234">要点</text>
<text class="ts" x="36" y="256">• 选举：主节点心跳超时（默认约 10s 选举超时）→ 从节点发起选举，需获得多数票；优先级、数据新旧影响结果；通常几十秒内恢复写入</text>
<text class="ts" x="36" y="276">• 投票节点建议奇数（3/5/7，最多 7 个投票成员）；仲裁节点（Arbiter）只投票不存数据，但会削弱 majority 写入的保证，不推荐生产使用</text>
<text class="ts" x="36" y="296">• 复制是异步的：从节点有延迟（replication lag），读从节点可能读到旧数据；oplog 窗口不足时落后过多的节点需要重新全量同步</text>
<text class="ts" x="36" y="312">• 驱动自动发现主节点并在故障转移期间重试（可重试写 retryWrites=true）</text>
</svg>
<figcaption>图 1：复制集：主节点写入并产生 oplog，从节点拉取重放</figcaption>
</figure>

| 角色 | 说明 |
| --- | --- |
| Primary | 唯一接收写入（默认也接收读） |
| Secondary | 复制数据；可读；可成为主 |
| **Hidden** | 对客户端不可见、不参与读，参与投票；用于**备份、报表、分析** |
| **Delayed** | 延迟固定时间重放（如 1 小时），**防误删的“后悔药”**（须同时 hidden，priority 0） |
| Arbiter | 仅投票，不存数据 |
| priority / votes | 控制选举偏好、跨机房时设置某机房节点不当主 |

### 2. 选举与回滚

- 选举基于**类 Raft 的协议**（term、投票、多数派）；只有拥有**最新 oplog**的节点才可能当选；
- **回滚（rollback）**：旧主在网络分区期间接受了写入但**未复制到多数**，新主选出后，旧主恢复并发现自己有“未被多数确认”的操作，就必须**回滚这些写入**（回滚数据写入 rollback 目录，需人工处理）。**这就是 `w:1` 可能丢数据的原因**；
- 避免回滚：**`w:"majority"`** 写关注——写入被多数节点确认后才返回，之后选举出的新主一定包含该写入。

### 3. 写关注、读关注、读偏好

| 旋钮 | 取值 | 含义 |
| --- | --- | --- |
| **writeConcern** `w` | `1`（仅主确认，默认视版本）、**`"majority"`**（多数节点确认）、数字 N | 写入确认的节点数 |
| writeConcern `j` | `true` | 等待 journal 落盘后确认（主节点宕机重启也不丢） |
| writeConcern `wtimeout` | 毫秒 | 等待确认超时（超时不代表写失败，只是确认不足） |
| **readConcern** | `local`（默认，可能读到之后会回滚的数据）、**`majority`**（只读已被多数确认的数据）、`linearizable`（线性一致读，仅主节点，较慢）、`snapshot`（事务内快照） | 读到的数据可见性/持久性 |
| **readPreference** | `primary`（默认）、`primaryPreferred`、`secondary`、`secondaryPreferred`、`nearest` | 读哪个节点 |

<figure class="fig">
<svg viewBox="0 0 800 270" class="dg" role="img" aria-label="一致性组合：重要数据使用写关注 majority 加读关注 majority 加读偏好 primary，保证不丢不回滚；读写分离读从节点可能读到旧数据；因果一致性会话可保证先写后读可见；仅写关注 1 在主节点故障时可能出现回滚丢失">
<rect class="b2" x="20" y="20" width="370" height="110" rx="12"/>
<text class="th" x="36" y="44">强持久（重要数据）</text>
<text class="ts" x="36" y="68">writeConcern: { w: "majority", j: true }</text>
<text class="ts" x="36" y="88">readConcern: "majority"，readPreference: primary</text>
<text class="ts" x="36" y="108">已确认的写不会因故障转移而丢失；延迟略高</text>
<rect class="b4" x="410" y="20" width="370" height="110" rx="12"/>
<text class="th" x="426" y="44">高吞吐（可容忍丢失）</text>
<text class="ts" x="426" y="68">writeConcern: { w: 1 }（或 w: 0 即发即忘）</text>
<text class="ts" x="426" y="88">适合日志、埋点、可重放数据</text>
<text class="ts" x="426" y="108">主节点故障时尚未复制的写可能被回滚</text>
<rect class="b5" x="20" y="150" width="370" height="110" rx="12"/>
<text class="th" x="36" y="174">读写分离（读从节点）</text>
<text class="ts" x="36" y="198">readPreference: secondaryPreferred</text>
<text class="ts" x="36" y="218">可能读到延迟的旧数据，“写后读”会读不到</text>
<text class="ts" x="36" y="238">仅用于报表/可容忍旧数据的查询</text>
<rect class="b3" x="410" y="150" width="370" height="110" rx="12"/>
<text class="th" x="426" y="174">因果一致性会话</text>
<text class="ts" x="426" y="198">startSession({ causalConsistency: true })</text>
<text class="ts" x="426" y="218">配合 majority 读写，保证“读自己的写”、单调读</text>
<text class="ts" x="426" y="238">即使读从节点也不会倒退看到旧数据</text>
</svg>
<figcaption>图 2：写关注、读关注、读偏好的常见组合</figcaption>
</figure>

最佳实践：**重要业务写用 `w:"majority"`，读用 `majority` 或主节点**；需要“写后立刻读”不要读从节点，或使用因果一致性会话；读写分离只用于可容忍延迟的查询，监控**复制延迟**（`rs.printSecondaryReplicationInfo()`、Exporter 指标）。

### 4. 运维要点

| 事项 | 说明 |
| --- | --- |
| **oplog 大小** | 决定**可容忍的从节点离线时长**（oplog 窗口）；写入量大时调大 `oplogSizeMB`，窗口应覆盖维护/故障恢复时间 |
| **初始同步** | 新节点全量同步数据，耗时长且占用主节点资源；离线太久（超出 oplog 窗口）也需重新同步 |
| **滚动升级/维护** | 先从节点、最后 `rs.stepDown()` 主节点切换后升级，逐个进行 |
| **备份** | `mongodump`（小数据）、**文件系统快照/物理备份**（大数据）、Percona Backup、云厂商快照；**延迟节点**防误删；定期**演练恢复** |
| **监控** | 复制延迟、oplog 窗口、连接数、`opcounters`、WiredTiger 缓存命中/脏页、慢查询、队列（`globalLock.currentQueue`）、磁盘；见 [指标监控](#/infra/obs-metrics) |

## 二、多文档事务

- **单文档操作本身是原子的**（包括内嵌文档与数组的更新）——合理建模能避免绝大多数事务需求；
- 多文档事务（`session.startTransaction()`）提供 **ACID 与快照隔离**，4.0 起支持复制集，4.2 起支持分片集群（跨分片两阶段提交）。

```java
try (ClientSession session = client.startSession()) {
    session.withTransaction(() -> {
        accounts.updateOne(session, eq("_id", from), inc("balance", -amt));
        accounts.updateOne(session, eq("_id", to),   inc("balance",  amt));
        return null;
    }, TransactionOptions.builder()
         .writeConcern(WriteConcern.MAJORITY).readConcern(ReadConcern.SNAPSHOT).build());   // 自动处理瞬时错误重试
}
```

| 限制与代价 | 说明 |
| --- | --- |
| **性能代价** | 额外的锁/快照开销；事务越长、涉及文档越多越慢 |
| **默认 60 秒超时** | `transactionLifetimeLimitSeconds`；长事务会阻止 WiredTiger 清理旧版本，占用缓存 |
| **写冲突** | 同一文档被其他事务修改会触发 `WriteConflict`，需**重试**（`withTransaction` 的回调可能被多次执行，必须幂等） |
| 操作限制 | 事务内不能创建集合/索引（新版本部分放宽）、单事务的 oplog 条目有大小限制（16MB 量级，新版本放宽） |
| 分片事务更慢 | 跨分片需协调者与两阶段提交 |

经验：**事务是后备方案**，不是常规手段；转账、库存+订单这类强一致需求可用事务，但高并发场景优先**单文档原子操作 + 条件更新 + 幂等**。分布式事务通用方案见 [分布式事务](#/distributed/transaction)。

## 三、分片集群

### 1. 架构

<figure class="fig">
<svg viewBox="0 0 800 360" class="dg" role="img" aria-label="分片集群架构：应用连接多个 mongos 路由器；mongos 从配置服务器复制集读取分片元数据和 chunk 分布并缓存；根据分片键把请求路由到对应分片；每个分片是一个复制集；均衡器在后台在分片之间迁移 chunk 保持数据均衡；包含分片键的查询只命中一个或少数分片，不含分片键的查询广播到所有分片">
<rect class="b1" x="20" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="55" text-anchor="middle" dominant-baseline="middle">应用 / 驱动</text>
<rect class="b3" x="210" y="20" width="150" height="70" rx="10"/>
<text class="tb" x="285" y="44" text-anchor="middle" dominant-baseline="middle">mongos（多个）</text>
<text class="ts" x="285" y="66" text-anchor="middle">无状态路由，缓存元数据</text>
<line class="l" x1="150" y1="55" x2="210" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="430" y="20" width="200" height="70" rx="10"/>
<text class="tb" x="530" y="44" text-anchor="middle" dominant-baseline="middle">配置服务器 CSRS</text>
<text class="ts" x="530" y="66" text-anchor="middle">复制集：chunk 映射、分片列表</text>
<line class="l" x1="360" y1="55" x2="430" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="140" width="220" height="110" rx="12"/>
<text class="th" x="36" y="164">分片 1（复制集）</text>
<text class="ts" x="36" y="186">chunk [min, 300)</text>
<text class="ts" x="36" y="206">chunk [300, 600)</text>
<text class="ts" x="36" y="226">P + S + S</text>
<rect class="b2" x="270" y="140" width="220" height="110" rx="12"/>
<text class="th" x="286" y="164">分片 2（复制集）</text>
<text class="ts" x="286" y="186">chunk [600, 900)</text>
<text class="ts" x="286" y="206">chunk [900, 1200)</text>
<text class="ts" x="286" y="226">P + S + S</text>
<rect class="b2" x="520" y="140" width="220" height="110" rx="12"/>
<text class="th" x="536" y="164">分片 3（复制集）</text>
<text class="ts" x="536" y="186">chunk [1200, max)</text>
<text class="ts" x="536" y="206">…</text>
<text class="ts" x="536" y="226">P + S + S</text>
<line class="l" x1="260" y1="90" x2="130" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="285" y1="90" x2="380" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="90" x2="630" y2="140" marker-end="url(#arr)"/>
<text class="ts" x="140" y="120" text-anchor="start">带分片键 → 定向</text>
<rect class="bg" x="20" y="270" width="760" height="76" rx="10"/>
<text class="ts" x="36" y="294">• 数据按分片键切成 chunk（默认约 128MB），均衡器在分片间迁移 chunk，使数据与负载均衡；迁移期间仍可读写</text>
<text class="ts" x="36" y="314">• 查询带分片键 → mongos 定向到一个/少数分片（targeted）；不带 → 广播所有分片再合并（scatter-gather，随分片数增加变慢）</text>
<text class="ts" x="36" y="334">• 未分片的集合放在“主分片”；分片键选定后设计查询与索引都要围绕它（见下文）</text>
</svg>
<figcaption>图 3：分片集群：mongos、配置服务器与多个分片复制集</figcaption>
</figure>

### 2. 什么时候需要分片

- **单机容量**：数据与索引超出单个复制集的磁盘/内存可承载；
- **写吞吐**：单主写入成为瓶颈（复制集只能纵向扩展写）；
- **工作集**超出内存且无法靠加内存解决；
- 地理分布/数据主权（Zone 分片）。

**先优化再分片**：优化索引与模型、读写分离、冷热分离、归档（TTL）、升级硬件。分片会显著增加运维复杂度，且**分片键一旦选错很难纠正**（5.0+ 支持 resharding，但代价大）。

### 3. 分片键选择（最关键）

**好的分片键满足三点**：

| 要求 | 说明 |
| --- | --- |
| **高基数（Cardinality）** | 取值足够多，chunk 才能不断拆分；低基数（如性别、状态）会让数据无法均匀分布（jumbo chunk） |
| **写入分布均匀（低频率）** | 避免单调递增（如自增 ID、时间戳、ObjectId），否则所有新写入都落在最后一个 chunk/分片 → **写热点** |
| **查询隔离（Targeting）** | 常用查询条件包含分片键，使请求只命中少数分片 |

| 分片策略 | 做法 | 优点 / 缺点 |
| --- | --- | --- |
| **范围分片（Ranged）** | 按分片键值范围切 chunk | ✓ 范围查询高效、相邻数据同分片；✗ 单调递增键造成写热点 |
| **哈希分片（Hashed）** | 对分片键哈希后分片 | ✓ 写入非常均匀，**解决单调键热点**；✗ 范围查询变成广播 |
| **复合分片键** | 如 `{ tenantId: 1, orderTime: 1 }` | ✓ 兼顾隔离与范围查询、避免热点（高基数前缀 + 递增后缀）；✗ 设计要谨慎 |

示例：

```javascript
sh.enableSharding("shop")
// 多租户 SaaS：租户 ID 做前缀，租户内按时间；同租户数据集中、不同租户分散
sh.shardCollection("shop.orders", { tenantId: 1, createdAt: 1 })
// 日志/事件，只需均匀写入：哈希分片
sh.shardCollection("log.events", { deviceId: "hashed" })
```

**反例**：`{ _id: 1 }`（ObjectId 单调递增 → 范围分片写热点）；`{ status: 1 }`（低基数）；`{ createdAt: 1 }`（单调）。**预分片（pre-split）**/ 哈希分片 + `numInitialChunks` 可在空集合上预先分布，避免初期集中。

### 4. chunk 与均衡器

- **chunk** 是分片键范围的逻辑块，超过大小阈值（默认约 128MB）自动**分裂**；**均衡器**发现分片间 chunk 数量差异过大时在后台**迁移**；
- **Jumbo chunk**：同一个分片键值对应的数据过多，无法再分裂也无法迁移 → 低基数键或热点键所致；需调整分片键或细化；
- 迁移有 IO/网络开销，可设置**均衡窗口**避开业务高峰；批量导入大量数据前先预分片；
- **跨分片唯一性**：唯一索引必须包含分片键（否则无法保证全局唯一）；全局唯一业务键需另设计（如把分片键纳入、或单独的发号/校验集合）。

### 5. 查询与限制

| 场景 | 说明 |
| --- | --- |
| 带分片键的等值查询 | 定向到单个分片，最快 |
| 带分片键前缀的范围查询 | 少数分片 |
| 不带分片键 | **scatter-gather**：所有分片执行，mongos 合并；排序与 `skip/limit` 在合并节点处理，**分片多时延迟高、资源放大** |
| 聚合 | 能下推的阶段在分片并行；`$group`、`$lookup` 可能需要合并节点处理，跨分片 `$lookup` 有限制 |
| 事务 | 跨分片事务代价高 |
| `count` | 使用 `countDocuments`（准确）或元数据估算 `estimatedDocumentCount`（快） |

设计原则：**让绝大多数查询包含分片键**；跨分片频繁的聚合改走离线/OLAP（见 [CDC 与实时数仓](#/bigdata/cdc)）。

## 四、与 MySQL 分库分表的对比

| | MongoDB 分片 | MySQL 分库分表（见 [分库分表](#/mysql/sharding)） |
| --- | --- | --- |
| 路由 | **内置**（mongos + 配置服务器） | 中间件（ShardingSphere）或应用自实现 |
| 数据均衡与扩容 | **自动**（chunk 迁移、均衡器） | 通常需要**数据迁移方案**，较复杂 |
| 跨分片查询 | scatter-gather，原生支持 | 中间件合并，限制多 |
| 事务 | 支持跨分片事务（代价高） | 依赖分布式事务方案 |
| 分片键更改 | resharding（5.0+）有成本 | 重新分片代价极高 |
| 模型 | 文档，反范式 | 关系，范式 |

## 五、安全与运维清单

| 项 | 做法 |
| --- | --- |
| **认证与授权** | 启用 `--auth`/Keyfile 或 x.509；按角色最小权限（RBAC）；**绝不能把无认证的 27017 暴露公网**（这是历史上大量勒索事件的原因，见 [Web 安全](#/security/web)） |
| **传输加密** | TLS；集群内部认证 |
| **静态加密** | 加密存储引擎/磁盘加密 + KMS（见 [加密与密钥管理](#/security/crypto)） |
| **审计** | 企业版审计或代理层审计 |
| **网络** | 内网访问、安全组/防火墙、Bind IP |
| **容量** | 监控磁盘（`dbPath` 使用率）、工作集、连接数；磁盘写满会导致节点宕机 |
| **Linux 参数** | 关闭 THP、`ulimit -n` 调大、`vm.swappiness` 低、XFS 文件系统、使用 SSD、NTP 同步（见 [进程与调度](#/cs/os-process)、[虚拟内存](#/cs/os-memory)） |
| **版本与补丁** | 及时升级小版本，关注 EOL |

## 六、常见坑

| 坑 | 对策 |
| --- | --- |
| `w:1` 下主节点故障，已“成功”的写被回滚 | 重要数据 `w:"majority"` + `j:true` |
| 读从节点“写后读不到” | 因果一致性会话，或该读走主节点 |
| 单调递增分片键 → 写热点、单分片打满 | 哈希分片/复合键；预分片 |
| 低基数分片键 → jumbo chunk | 选高基数字段或复合键 |
| 查询不带分片键，广播所有分片 | 查询设计围绕分片键；二级访问用冗余/异构索引 |
| 仲裁节点 + 两个数据节点，多数派写入脆弱 | 生产使用 3 个数据节点 |
| oplog 窗口太小，从节点离线后需全量重同步 | 调大 oplog，监控窗口 |
| 事务当常规手段，性能下降、写冲突多 | 模型设计避免事务，事务保持短小并幂等重试 |
| 迁移期间均衡器影响业务 | 均衡窗口；错峰；监控迁移速度 |
| 未设置驱动超时/重试，故障转移期间报错 | `retryWrites`、`serverSelectionTimeoutMS`，多节点连接串 |
| 公网暴露、无认证 | 认证 + 内网 + TLS |
| 备份从未演练 | 定期恢复演练；延迟节点防误删 |

## 面试追问

> [!QUESTION] MongoDB 复制集如何实现高可用？故障转移怎么发生？
> 主节点写入数据并记录 oplog，从节点持续拉取并重放，节点间互发心跳。主节点失联超过选举超时，从节点发起类 Raft 的选举，拥有最新数据并获得多数票的成为新主，驱动自动发现并重试写入。生产至少三个投票节点保证多数派。

> [!QUESTION] 为什么 w:1 可能丢数据？如何避免？
> 写入只被主节点确认，若主节点随后故障且该写入还没复制到多数节点，新主选出后旧主恢复会回滚这些写入。使用 writeConcern w 为 majority 并配合 j 为 true，写入被多数节点确认后才返回，之后选出的新主必然包含该写入，读侧用 majority 读关注避免读到会回滚的数据。

> [!QUESTION] writeConcern、readConcern、readPreference 分别是什么？
> 写关注决定写入需要多少节点确认以及是否等 journal；读关注决定读到什么级别的数据，如 local、majority、linearizable、snapshot；读偏好决定读主节点还是从节点。三者组合决定一致性与延迟的取舍，读从节点可能读到旧数据，可用因果一致性会话保证读自己的写。

> [!QUESTION] 如何选择分片键？
> 要高基数、写入分布均匀、常用查询包含分片键。避免自增 ID、时间戳或 ObjectId 这类单调递增的键作范围分片造成写热点，可用哈希分片或高基数前缀加递增后缀的复合键；低基数字段会产生无法分裂的 jumbo chunk。分片键选错代价极大，需要提前按查询模式设计。

> [!QUESTION] 范围分片和哈希分片的区别？
> 范围分片按键值范围切分，范围查询只命中相邻分片，但单调键会导致写热点；哈希分片对键哈希后分布，写入均匀，但范围查询要广播到所有分片。需要兼顾时用复合分片键。

> [!QUESTION] MongoDB 支持事务吗？使用时有什么注意点？
> 4.0 起复制集支持多文档事务，4.2 起分片集群支持，提供快照隔离和 ACID。但有性能代价，默认 60 秒超时，写冲突要重试且回调必须幂等，跨分片更慢。最佳实践是通过文档模型和单文档原子操作避免事务，事务保持短小。

> [!QUESTION] 不带分片键的查询在分片集群中会怎样？
> mongos 无法定向，会把查询广播到所有分片再合并结果，即 scatter-gather，分片越多延迟和资源消耗越大。应让常用查询包含分片键，或为二级查询维护冗余/异构索引，跨分片的重聚合放到离线分析系统。
