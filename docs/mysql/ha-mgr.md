---
level: 深入
tags: [MySQL, 高可用, MGR, Group Replication, InnoDB Cluster, MySQL Router, Orchestrator, ProxySQL, 脑裂, 故障切换, 半同步, 多数派]
summary: MySQL 高可用深入：高可用的目标（RPO/RTO）与架构分层、半同步 AFTER_SYNC/AFTER_COMMIT 的数据安全差异、MGR 的认证与冲突检测、Paxos 变体与流控、单主/多主、成员视图与脑裂防护、InnoDB Cluster 与 MySQL Router、Orchestrator 拓扑管理、ProxySQL 读写分离与故障路由、切换（Switchover/Failover）的标准步骤与演练、跨机房与云 RDS 的取舍。
---

# MySQL 高可用：半同步、MGR 与切换实战

> [!ABSTRACT] 核心要点
> - 高可用要先定目标：**RPO**（最多丢多少数据）与 **RTO**（多久恢复）。**异步复制 RPO>0**；**半同步（AFTER_SYNC，无损）RPO≈0 但依赖至少一个从库存活，超时会降级回异步**；**MGR（Paxos 变体）多数派确认，RPO=0 且自动选主**，代价是写延迟、网络要求与对大事务的敏感。
> - **MGR 的提交路径**：本地事务执行 → 提交前进入组通信（Paxos 变体）广播 **write set** → **多数派接受** → **每个节点各自做认证（冲突检测）** → 通过则应用提交，失败则回滚。**认证是确定性的**，所有节点结论一致。
> - **MGR 不是“强一致读”**：默认**最终一致**，从节点可能读到旧数据；需要强一致读用 **`group_replication_consistency`**（`BEFORE`/`AFTER`/`BEFORE_AND_AFTER`），代价是延迟。
> - **脑裂防护靠“多数派”**：网络分区时**少数派自动进入 ERROR/只读**，不再接受写；**最少 3 个节点**，奇数更合理。外部切换方案（MHA/Orchestrator）要自己处理**隔离旧主（fencing）**。
> - **流量入口同样要高可用**：MySQL Router / ProxySQL / VIP / 服务发现，**客户端连接重试与幂等**才是业务感知 RTO 的决定因素。
> - **演练胜于设计**：定期做 switchover（计划切换）与 failover（故障切换）演练，验证**数据一致、应用重连、监控告警**。

## 高可用目标与分层

| 层 | 要解决的问题 | 常见手段 |
| --- | --- | --- |
| **数据复制层** | 数据不丢、有副本 | 异步/半同步/MGR、binlog、备份 |
| **故障检测与决策层** | 谁挂了、选谁做新主、防脑裂 | MGR 自带、Orchestrator、MHA、云 HA 控制面 |
| **流量路由层** | 应用如何找到新主 | MySQL Router、ProxySQL、VIP、DNS、服务发现、SDK 感知 |
| **应用层** | 重连、重试、幂等、读一致 | 连接池校验、重试策略、事务幂等，见 [分布式幂等](#/distributed/idempotent) |

RPO/RTO 的取舍：**金融核心要 RPO=0**（MGR/半同步无损/同步型云存储）；**普通业务可接受秒级 RPO**，用异步 + 快速恢复；**跨机房**往往 RPO 与延迟矛盾，见 [多活架构](#/design/arch-multi-active)。

## 半同步复制的细节

主从复制基础见 [主从复制与高可用](#/mysql/replication)。这里关注**数据安全的差异**：

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="半同步的两种等待点：AFTER_COMMIT 先在引擎提交再等从库确认，主库提交后宕机客户端未收到成功但其他会话已能读到该数据，故障切换后可能丢失；AFTER_SYNC 先写 binlog 并发送从库，等待确认后再引擎提交，保证已提交数据都在从库，实现无损">
<rect class="b4" x="20" y="14" width="350" height="170" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">AFTER_COMMIT（5.5/5.6 默认）</text>
<text class="ts" x="195" y="62" text-anchor="middle">写 binlog → 引擎提交</text>
<text class="ts" x="195" y="84" text-anchor="middle">→ 等从库 ACK → 返回客户端</text>
<text class="ts" x="195" y="112" text-anchor="middle">提交后、ACK 前主库宕机：</text>
<text class="ts" x="195" y="134" text-anchor="middle">其他会话已读到，从库可能没有</text>
<text class="ts" x="195" y="156" text-anchor="middle">切换后数据回退，出现幻读</text>
<rect class="b2" x="390" y="14" width="350" height="170" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">AFTER_SYNC（5.7+ 默认，无损）</text>
<text class="ts" x="565" y="62" text-anchor="middle">写 binlog → 发送从库</text>
<text class="ts" x="565" y="84" text-anchor="middle">→ 等从库 ACK → 引擎提交</text>
<text class="ts" x="565" y="112" text-anchor="middle">未收到 ACK 前其他会话读不到</text>
<text class="ts" x="565" y="134" text-anchor="middle">已提交的事务必定在至少一个从库</text>
<text class="ts" x="565" y="156" text-anchor="middle">故障切换不丢已确认数据</text>
<rect class="bg" x="20" y="204" width="720" height="100" rx="8"/>
<text class="ts" x="380" y="230" text-anchor="middle">rpl_semi_sync_master_wait_for_slave_count：需要多少从库确认（默认 1）</text>
<text class="ts" x="380" y="252" text-anchor="middle">rpl_semi_sync_master_timeout：超时后降级为异步（默认 10 秒），此时 RPO>0</text>
<text class="ts" x="380" y="274" text-anchor="middle">注意：超时降级会让无损保证悄悄失效，需监控降级事件与状态变量</text>
<text class="ts" x="380" y="296" text-anchor="middle">8.0.26+ 参数改名为 source/replica，语义不变</text>
</svg>
<figcaption>图 1：半同步的两种等待点</figcaption>
</figure>

要点：

- 半同步要求**至少一个从库在超时时间内确认**；**从库全挂或网络慢就会让主库写入卡到超时，之后降级为异步**。要在“**不降级（宁可阻塞）**”与“**降级（保可用）**”之间做业务选择：把超时设很大近似“强同步”，但从库故障会拖垮主库写；
- 监控 `Rpl_semi_sync_master_status`（ON/OFF 是否降级）、`Rpl_semi_sync_master_no_tx`（未得到确认的提交数）、`Rpl_semi_sync_master_net_avg_wait_time`；
- **AFTER_SYNC 的边界**：主库在收到 ACK 之后、引擎提交之前宕机，重启恢复时依据 binlog 提交该事务，与从库一致；真正的风险是**半同步已降级为异步期间**产生的事务，旧主 binlog 里有而从库没有。旧主重新加入前必须用 GTID 对比，有多余事务就**重建**，不要直接挂为从库；
- 半同步降低了丢数据概率，但**不等同于多数派一致性**：它没有自动选主与成员管理，需要外部组件。

## MGR（MySQL Group Replication）原理

### 提交流程：广播、认证、应用

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="MGR 事务提交流程：节点本地执行事务，提交时把 write set 与事务数据通过组通信系统（Paxos 变体）广播给所有成员并获得全局顺序，多数派接受后，每个节点按全局顺序独立执行认证，检查该事务的 write set 与已认证但尚未被其应用的并发事务是否冲突，无冲突则本节点提交，其他节点写入 relay log 并应用；有冲突则按先到先得回滚后到的事务">
<rect class="b3" x="20" y="24" width="140" height="70" rx="8"/>
<text class="tb" x="90" y="46" text-anchor="middle" dominant-baseline="middle">本地执行</text>
<text class="ts" x="90" y="68" text-anchor="middle">乐观执行，不加全局锁</text>
<rect class="b5" x="190" y="24" width="160" height="70" rx="8"/>
<text class="tb" x="270" y="46" text-anchor="middle" dominant-baseline="middle">组通信广播</text>
<text class="ts" x="270" y="68" text-anchor="middle">Paxos 变体：全局有序</text>
<rect class="b1" x="380" y="24" width="160" height="70" rx="8"/>
<text class="tb" x="460" y="46" text-anchor="middle" dominant-baseline="middle">多数派接受</text>
<text class="ts" x="460" y="68" text-anchor="middle">事务获得全局序号</text>
<rect class="b2" x="570" y="24" width="170" height="70" rx="8"/>
<text class="tb" x="655" y="46" text-anchor="middle" dominant-baseline="middle">各节点认证</text>
<text class="ts" x="655" y="68" text-anchor="middle">确定性冲突检测</text>
<line class="l" x1="160" y1="59" x2="190" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="59" x2="380" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="59" x2="570" y2="59" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="118" width="350" height="222" rx="8"/>
<text class="th" x="32" y="140">认证（Certification）</text>
<text class="ts" x="195" y="168" text-anchor="middle">每个事务携带 snapshot version</text>
<text class="ts" x="195" y="190" text-anchor="middle">与其后已认证事务的 write set 比对</text>
<text class="ts" x="195" y="212" text-anchor="middle">write set = 行的主键/唯一键哈希集合</text>
<text class="ts" x="195" y="234" text-anchor="middle">有交集 = 并发修改同一行 = 冲突</text>
<text class="ts" x="195" y="256" text-anchor="middle">先认证者胜，后者回滚（先提交者赢）</text>
<text class="ts" x="195" y="288" text-anchor="middle">要求：表必须有主键，隔离级别 RR/RC，InnoDB</text>
<text class="ts" x="195" y="310" text-anchor="middle">大事务 write set 大：广播与认证开销高</text>
<rect class="bg" x="390" y="118" width="350" height="222" rx="8"/>
<text class="th" x="402" y="140">应用与流控</text>
<text class="ts" x="565" y="168" text-anchor="middle">通过认证：本节点直接提交</text>
<text class="ts" x="565" y="190" text-anchor="middle">其他节点：写 relay log，并行应用</text>
<text class="ts" x="565" y="212" text-anchor="middle">落后节点积压达阈值：触发流控</text>
<text class="ts" x="565" y="234" text-anchor="middle">flow control 让写入方放慢，保护慢节点</text>
<text class="ts" x="565" y="256" text-anchor="middle">所以一个慢节点会拖慢整组写入</text>
<text class="ts" x="565" y="288" text-anchor="middle">监控：performance_schema.</text>
<text class="ts" x="565" y="310" text-anchor="middle">replication_group_member_stats</text>
</svg>
<figcaption>图 2：MGR 的提交与认证</figcaption>
</figure>

**关键点**：

- **乐观并发**：事务先在本节点执行（持本地锁），提交时才全局认证。**多主写同一行会冲突回滚**（应用要重试），所以**推荐单主模式**（写入集中在一个节点，几乎没有认证冲突）；
- **认证基于 write set**：每个事务提取被修改行的**主键/唯一键哈希**，**不是行级锁**；这也是 MGR **要求所有表有主键**的原因；
- **“多数派接受”≠“多数派已应用”**：事务提交返回给客户端时，**多数派已持久化接受了该事务（保证不丢）**，但**其他节点可能还没应用**，所以**读从节点可能读到旧数据**；
- **WRITESET 并行应用**：MGR 复制天然使用基于 write set 的并行应用，所以主从延迟通常小于传统异步复制；
- **流控（Flow Control）**：某节点的认证队列或应用队列超过阈值（`group_replication_flow_control_applier_threshold` / `certifier_threshold`，默认 25000），**所有写入节点被限速**，**一个慢节点拖慢整个组**，是 MGR 的典型运维痛点；
- **大事务**：write set 与事务数据都要广播，**有大小上限 `group_replication_transaction_size_limit`**（默认约 150MB），超大事务会被拒绝；而且大事务会阻塞认证，**要拆小**；
- **约束**：InnoDB、主键、`binlog_format=ROW`、GTID 开启、不支持某些 DDL 并发场景（多主下 DDL 与 DML 并发冲突）、表锁/`LOCK TABLES` 在多主下不适用、外键级联在多主下有限制。

### 一致性级别

默认 `group_replication_consistency=EVENTUAL`：写入返回后，**从节点读可能读到旧值**。

| 级别 | 行为 | 代价 |
| --- | --- | --- |
| `EVENTUAL`（默认） | 事务不等待先前事务应用 | 最低延迟，读可能旧 |
| `BEFORE` | **读/写事务开始前**等待本节点应用完所有已提交事务 | 读延迟增加，**保证读到最新** |
| `AFTER` | 写事务提交后，**等待所有成员应用**才返回 | 写延迟上升，保证随后任何节点读到 |
| `BEFORE_AND_AFTER` | 两者兼有 | 最强也最慢 |

读写分离的“读自己的写”问题，可选**会话级 BEFORE**（只对需要强一致的会话开启），其他读保持 EVENTUAL，见 [主从复制与高可用](#/mysql/replication) 的读一致性部分。

### 成员管理、选主与脑裂

- **成员视图（View）**：组成员集合，由组通信层通过**故障检测（心跳、`group_replication_member_expel_timeout`）**维护；节点失联会被**怀疑（UNREACHABLE）** → 超时后被**驱逐（expel）**；
- **多数派与脑裂**：成员视图变更**必须由多数派同意**。网络分区时：**多数派一侧继续服务，少数派一侧无法达成多数而阻塞/进入只读 ERROR 状态**（`group_replication_unreachable_majority_timeout` 可让少数派超时后退出）。**这就是脑裂防护**，无需外部 fencing；
- **3 节点容忍 1 个故障，5 节点容忍 2 个**；偶数节点没有收益（如 4 节点仍只容忍 1 个）；
- **单主模式选主**：按**成员权重 `group_replication_member_weight`** 与 **server_uuid** 顺序选举新主，新主**先应用完 backlog 再开放写**（`group_replication_...` 相关保护），避免读到旧数据；
- **节点加入/恢复**：新节点通过**分布式恢复**：先从捐赠者（donor）**同步 binlog 增量**，增量太大或 binlog 已清理时用 **Clone 插件（8.0.17+）** 全量克隆，再追赶，最后加入；
- **节点被驱逐后**重新加入需重新分布式恢复，数据不一致（有本地独有事务）会拒绝加入，需重建。

## InnoDB Cluster 与 MySQL Router

**InnoDB Cluster = MGR（数据层）+ MySQL Shell（运维 AdminAPI）+ MySQL Router（路由层）**：

```javascript
// MySQL Shell (JS) 示意
\c admin@db1:3306
dba.checkInstanceConfiguration()
var cluster = dba.createCluster('prod')
cluster.addInstance('admin@db2:3306')      // 默认使用 Clone 或增量恢复
cluster.addInstance('admin@db3:3306')
cluster.status()
```

```bash
# Router 引导：自动从集群元数据获知拓扑
mysqlrouter --bootstrap admin@db1:3306 --directory /etc/mysqlrouter --user=mysqlrouter
# 默认端口：6446 读写（路由到主）、6447 只读（轮询从）
```

- **Router 无状态，读取集群元数据**，主节点切换后**自动路由到新主**；通常**与应用同机部署（每个应用实例一个 Router）**，避免成为单点；
- Router 是**四层 TCP 路由**（8.x 增加基于连接而非语句的路由），**没有 SQL 解析**，不做读写分离到语句级；需要按语句分流用 ProxySQL 或应用层；
- **ClusterSet**（8.0.27+）支持**跨集群的异步复制容灾**，主集群故障可手动/半自动切换到副集群；
- **踩坑**：Router 的元数据缓存 TTL、连接**不会在切换时自动迁移**，应用需**重连**；长连接池要**校验连接 + 失败重试**。

## 外部 HA 方案：Orchestrator 与 MHA

对已经运行**异步/半同步主从**的存量集群，常用 **Orchestrator**（MySQL 拓扑发现与故障恢复工具）：

| 能力 | 说明 |
| --- | --- |
| **拓扑发现** | 通过 `SHOW REPLICA STATUS` 递归发现主从关系，可视化，支持多层复制 |
| **故障检测** | **不只靠自己探测**：同时询问**主库的从库**，若主库不可达**且所有从库的复制线程都报告主库失联**，才判定主库故障——**用从库视角降低误判** |
| **自动恢复** | 选择最合适的从库（GTID 最全、延迟最小、权重）提升为新主，其余从库重新指向；支持**恢复前/后 Hook**（VIP、DNS、通知、Proxy 配置） |
| **计划切换** | `graceful-master-takeover`：只读主库、等从库追平、提升新主，**无数据丢失** |
| **高可用本身** | Orchestrator 自身用 Raft 或后端 MySQL 部署多实例 |

**自己实现/使用 MHA 的关键责任**（这是 MGR 自带而外部方案必须补齐的）：

1. **fencing（隔离旧主）**：旧主可能只是网络隔离，仍可能被部分客户端写入。必须先 `super_read_only=ON`、摘除 VIP/路由、必要时通过管理口断电（STONITH）；
2. **数据补齐**：新主可能缺最后几个事务（异步下），**尽量从旧主的 binlog 或半同步从库补齐**；无法补齐则**接受丢失并记录**；
3. **旧主回归**：恢复后用 GTID 检查是否有**多余事务**，有则**重建**而不是直接挂为从库；
4. **防抖与限频**：避免“切换风暴”（短时间内多次切换），Orchestrator 有恢复间隔（`RecoveryPeriodBlockSeconds`）；
5. **防止误切换**：网络抖动导致检测误判是最大风险，所以**宁可晚几秒确认**。

## 流量入口：ProxySQL 与 VIP

### ProxySQL（语句级路由）

```sql
-- 主机组：10 = 写，20 = 读
INSERT INTO mysql_servers(hostgroup_id, hostname, port, weight) VALUES
 (10,'db-primary',3306,1),(20,'db-replica1',3306,1),(20,'db-replica2',3306,1);
-- 读写分离规则：SELECT FOR UPDATE 走写组，普通 SELECT 走读组，其余默认写组
INSERT INTO mysql_query_rules(rule_id, active, match_digest, destination_hostgroup, apply) VALUES
 (1,1,'^SELECT .* FOR UPDATE',10,1),(2,1,'^SELECT',20,1);
LOAD MYSQL SERVERS TO RUNTIME; SAVE MYSQL SERVERS TO DISK;
LOAD MYSQL QUERY RULES TO RUNTIME; SAVE MYSQL QUERY RULES TO DISK;
```

- **能力**：连接多路复用、**读写分离**、查询缓存/重写、**慢查询统计**、故障时**自动把读写组切换**（配合 MGR 的 `mysql_group_replication_hostgroups` 表或 `read_only` 监控）、**限流/熔断**；
- **注意**：事务内的语句**必须路由到同一后端**（`transaction_persistent`）；**读后写一致**需要规则或会话级提示；**多路复用对会话变量/临时表/`LAST_INSERT_ID` 要小心**；
- ProxySQL 自身需要**多实例部署**（Keepalived/云 LB 前置、或每应用 sidecar），**否则成为新的单点**。

### 其他入口

| 方式 | 优点 | 缺点 |
| --- | --- | --- |
| **VIP（keepalived）** | 应用无感知、简单 | 同网段限制、**VIP 漂移需联动 fencing**，不跨机房 |
| **DNS/服务发现** | 灵活，跨环境 | **DNS 缓存 TTL**、JVM 默认缓存，需应用配合（`networkaddress.cache.ttl`） |
| **配置中心 + 应用侧数据源切换** | 精准控制 | 侵入应用，需灰度 |
| **云厂商读写分离/代理地址** | 托管省心 | 厂商绑定，细节不可控 |
| **JDBC 多主机** | 驱动自带 failover（`jdbc:mysql:replication://`、`loadbalance`） | 语义有限，要验证行为 |

### 应用层配合（决定业务感知 RTO）

- 连接池**校验与淘汰失效连接**（`testOnBorrow`/`validationQuery`、HikariCP `keepaliveTime`/`maxLifetime` 小于网络层空闲回收）；
- **失败重试 + 幂等**：切换瞬间的失败写要能安全重试，见 [分布式幂等](#/distributed/idempotent)；
- **区分“只读错误”**：切换后旧连接可能连到只读节点，`The MySQL server is running with the --read-only option` 要触发**重连重试**；
- **超时分层**：连接超时、读超时、事务超时要小于上层 SLA，避免线程被堵死。

## 切换：Switchover 与 Failover

| | Switchover（计划切换） | Failover（故障切换） |
| --- | --- | --- |
| 场景 | 升级、维护、机房迁移 | 主库宕机/不可达 |
| 数据 | **不丢**：先把旧主置只读，等从库追平 | 可能丢（异步）或不丢（半同步 AFTER_SYNC/MGR） |
| 流程 | 旧主 `super_read_only` → 等 GTID 追平 → 提升新主 → 切流量 → 旧主降为从库 | 检测 → 确认 → fencing → 选新主 → 补数据 → 切流量 → 重建旧主 |
| 风险 | 低，可回滚 | 误判、脑裂、数据丢失 |

**标准 Switchover 步骤**（异步/半同步 + GTID）：

1. 确认从库健康、延迟接近 0、GTID 一致性；
2. `SET GLOBAL super_read_only=ON` 于旧主（**先停止写**）；
3. `SELECT WAIT_FOR_EXECUTED_GTID_SET('旧主 gtid_executed', 30)` 在候选新主上等待追平；
4. 候选新主 `STOP REPLICA; RESET REPLICA ALL; SET GLOBAL read_only=OFF`；
5. 其他从库 `CHANGE REPLICATION SOURCE TO SOURCE_HOST='新主', SOURCE_AUTO_POSITION=1`；
6. 切流量（Router/VIP/DNS/配置）；
7. 旧主 `CHANGE REPLICATION SOURCE ...` 作为从库加入；
8. 验证写入、复制、监控；**记录耗时作为 RTO 依据**。

**演练清单**：定期做**主库 kill -9 / 断网 / 磁盘满 / 从库延迟**四类故障注入，验证：自动切换是否触发、耗时、数据是否一致、应用是否自动恢复、告警是否到位。

## 方案选型

| 方案 | RPO | RTO | 复杂度 | 适用 |
| --- | --- | --- | --- | --- |
| 异步主从 + 手动切换 | >0 | 分钟~小时 | 低 | 非核心、可接受丢数据 |
| 异步/半同步 + Orchestrator/MHA | 异步>0；半同步≈0 | 十几秒~分钟 | 中 | **存量主从集群**升级 HA |
| **MGR / InnoDB Cluster** | **0（多数派）** | 秒级~十几秒 | 中高（对网络/大事务/运维要求） | **新建核心库**、同城三机房 |
| 云厂商 RDS HA | 通常≈0（半同步/存储复制） | 秒级~分钟 | 低（托管） | 云上业务，接受厂商绑定 |
| 跨地域灾备（异步） | >0（秒~分钟） | 分钟~小时 | 高 | 容灾，配合 ClusterSet |

**选型原则**：

- **网络条件**：MGR 对**网络延迟/抖动敏感**（同城低延迟可用，**跨地域不适合**做同步多数派）；
- **写入特征**：大事务、热点行多主冲突多的业务，MGR 吃力；
- **团队能力**：MGR 的流控、成员驱逐、恢复要有运维经验；**存量主从 + Orchestrator** 往往更易落地；
- **不要只迷信“自动切换”**：自动切换的收益是 RTO，风险是误切换和数据问题，要有**防抖、降级为手动、告警**机制。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| MGR 写入突然变慢 | 某节点落后触发流控 | 查 `replication_group_member_stats` 的队列；排查慢节点（磁盘、网络、大事务） |
| 节点被驱逐（ERROR 状态） | 网络抖动超过 expel timeout，或节点卡死 | 调整 `member_expel_timeout`；修复后重新加入；排查网络与资源 |
| 多主模式事务频繁回滚 | 认证冲突 | 改单主；应用层路由同一数据到同一节点；重试 |
| 大事务被拒绝 | 超过 `transaction_size_limit` | 拆事务；调整限制（谨慎） |
| 切换后应用报 read-only 错误 | 旧连接连到旧主/从库 | 连接池校验、重连、DNS TTL |
| 半同步悄悄降级为异步 | 从库超时/故障 | 监控状态变量；告警；评估超时设置 |
| 旧主恢复后无法加入 | 本地有多余事务（GTID 不一致） | 重建（克隆）而非强行加入 |
| 切换风暴 | 网络抖动导致反复误判 | 恢复间隔、防抖、多源检测 |

## 高可用清单

- [ ] 是否明确了 RPO/RTO，并据此选择复制与 HA 方案？
- [ ] 半同步是否使用 AFTER_SYNC 并监控降级？
- [ ] MGR 节点数是否 ≥ 3 奇数，是否采用单主，大事务是否受控？
- [ ] 是否监控流控、成员状态、延迟、队列积压？
- [ ] 外部切换方案是否有 fencing、GTID 补齐、旧主回归检查、防抖？
- [ ] 流量入口（Router/ProxySQL/VIP）自身是否高可用？
- [ ] 应用是否具备连接校验、重试与幂等？
- [ ] 是否定期做 switchover/failover 演练并记录 RTO？

## 相关阅读

- [主从复制与高可用](#/mysql/replication)：binlog、GTID、并行复制、读写分离
- [redo / undo / binlog](#/mysql/log)：两阶段提交与崩溃恢复
- [备份恢复与运维](#/mysql/backup-ops)：HA 不能替代备份
- [分布式共识 Paxos 与 Raft](#/distributed/paxos)：MGR 多数派的理论基础
- [数据复制与一致性模型](#/distributed/replication)：同步/异步复制取舍
- [高可用架构](#/design/arch-availability)：RPO/RTO 与故障域

## 面试追问

> [!QUESTION] 半同步复制的 AFTER_SYNC 和 AFTER_COMMIT 有什么区别？
> AFTER_COMMIT 是先在引擎提交再等从库确认，提交后主库宕机时其他会话可能已读到的数据从库并没有，切换后数据回退；AFTER_SYNC 是先写 binlog 并发送到从库，等到确认后才引擎提交，未确认前别的会话读不到，已提交的数据必在至少一个从库，即无损。注意超时会降级为异步，要监控降级状态。

> [!QUESTION] MGR 的事务提交流程是什么？怎么保证一致？
> 事务在本节点乐观执行，提交时把 write set 和事务数据通过 Paxos 变体的组通信广播，多数派接受后获得全局序号，每个节点按全局顺序独立做确定性的认证，比对 write set 与并发事务是否修改了同一行，无冲突则提交，冲突则先认证者胜、后者回滚。认证确定性使所有节点结论一致。

> [!QUESTION] MGR 是强一致吗？从节点能读到最新数据吗？
> 默认不是：多数派接受后事务就返回，其他节点可能还没应用，读从节点可能读到旧数据。需要强一致读可以设置 group_replication_consistency 为 BEFORE、AFTER 或 BEFORE_AND_AFTER，代价是读或写延迟增加，建议只对需要的会话开启。

> [!QUESTION] MGR 怎么防止脑裂？为什么至少三个节点？
> 成员视图变更需要多数派同意，网络分区时多数派一侧继续服务，少数派无法达成多数而阻塞或进入只读错误状态，所以不会出现两个主同时写。三节点容忍一个故障，五节点容忍两个，偶数节点没有额外容错收益。

> [!QUESTION] 为什么推荐 MGR 单主模式而不是多主？
> 多主下事务乐观执行、提交时认证，不同节点并发修改同一行会冲突导致后者回滚，需要应用重试；DDL 与 DML 并发、外键级联等也有限制。单主模式写入集中在一个节点，几乎没有认证冲突，行为更接近传统主从，更易运维。

> [!QUESTION] MGR 有什么运维痛点？
> 流控：一个慢节点的应用或认证队列积压达到阈值会让整组写入被限速；节点因网络抖动被驱逐后需要重新分布式恢复；大事务的 write set 广播与认证开销大且有大小上限；对网络延迟敏感，不适合跨地域同步；还要求所有表有主键。

> [!QUESTION] 外部 HA 方案（MHA/Orchestrator）要自己解决什么问题？
> MGR 自带选主和多数派脑裂防护，外部方案要自己补齐：隔离旧主防脑裂（只读、摘 VIP、必要时断电）、新主缺失事务的补齐或接受丢失、旧主恢复后通过 GTID 检查多余事务并重建、避免误判和切换风暴，以及流量入口切换。Orchestrator 通过询问从库视角降低误判。

> [!QUESTION] 主库故障后应用层要做什么才能快速恢复？
> 连接池校验并淘汰失效连接，设置合理的连接、读、事务超时；对切换瞬间的失败请求做重试，并保证幂等；识别只读错误触发重连；DNS 方式要注意 JVM 缓存 TTL；Router 或 ProxySQL 自身要高可用。业务感知的 RTO 往往取决于这些而不是数据库切换本身。
