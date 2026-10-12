---
level: 高级
tags: [TiDB, 热点, AUTO_RANDOM, 数据迁移, DM, TiCDC, 选型, 慢查询, 大事务, Java]
summary: TiDB 落地实战：写入热点成因与 AUTO_RANDOM/SHARD_ROW_ID_BITS/预切分、从 MySQL 迁移（评估、DM 全量增量、校验、切换与回退）、Java 应用适配（连接串、事务重试、大批量分批）、大事务与批量写、慢查询与执行计划调优、TiFlash 使用、监控与容量规划，以及“该不该用 TiDB”的选型决策。
---

# TiDB 实战：热点、迁移、选型与调优

> [!ABSTRACT] 核心要点
> - **TiDB 自动分片不等于没有热点**：**连续递增的主键/索引（自增 ID、时间戳）会让新写入集中到最后一个 Region**，单个 TiKV 成为瓶颈。对策：`AUTO_RANDOM`（或 `SHARD_ROW_ID_BITS` + `PRE_SPLIT_REGIONS`）、避免单调索引、读热点用 Follower Read/缓存。
> - **从 MySQL 迁移的关键**：兼容性评估 → **DM 全量 + 增量同步** → 数据校验（sync-diff-inspector）→ 灰度读 → 切写 → 保留**反向同步**以便回退；业务侧要处理**隔离级别差异、大事务、自增 ID 语义、乐观冲突重试**。
> - **大事务是头号杀手**：单事务过大会失败或拖垮集群，批量写要**分批（如每批几千行）**，删除/更新历史数据用**分批 + 限速**或非事务 DML。
> - **性能调优思路与 MySQL 类似**：`EXPLAIN ANALYZE` 看**估算与实际行数偏差**、统计信息是否过期、索引是否合适、算子是否下推；再结合 Dashboard 的 **Top SQL / 慢查询 / 热点图（Key Visualizer）**。
> - **选型**：数据量大（单机放不下或分库分表已痛苦）、需要在线扩缩容与高可用、需要 HTAP 时值得上；**小规模、延迟极敏感、团队无运维能力**时，单机 MySQL/PG 更合适。

> [!NOTE] 版本说明
> 参数、默认值和语法（如 `AUTO_RANDOM`、非事务 DML、资源管控）随版本演进，本文以通用做法为主，请以所用版本的官方文档为准。原理见 [TiDB 架构](#/db/tidb-arch)。

## 一、写入热点

### 1. 为什么会有热点

TiDB 按 **Key 的范围**切 Region。若主键或索引**单调递增**（`AUTO_INCREMENT`、时间戳、雪花 ID 的高位时间），**新数据永远追加到 Key 空间的末尾，落在同一个 Region（的同一个 Raft Leader）上**——这个 TiKV 节点成为写入瓶颈，其他节点闲置，集群水平扩展失效。

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="写入热点：左侧自增主键导致所有写入集中在最后一个 Region 所在的节点，该节点 CPU 与磁盘被打满；右侧使用 AUTO_RANDOM 后主键高位被随机打散，写入均匀分散到多个 Region 和多个 TiKV 节点">
<rect class="b4" x="20" y="20" width="370" height="170" rx="12"/>
<text class="th" x="36" y="44">✗ 自增主键：写入集中在最后一个 Region</text>
<rect class="b" x="40" y="62" width="60" height="34" rx="4"/>
<rect class="b" x="106" y="62" width="60" height="34" rx="4"/>
<rect class="b" x="172" y="62" width="60" height="34" rx="4"/>
<rect class="b4" x="238" y="62" width="130" height="34" rx="4"/>
<text class="ts" x="303" y="79" text-anchor="middle" dominant-baseline="middle">最后一个 Region ← 全部写入</text>
<text class="ts" x="40" y="124" text-anchor="start">id: 1,2,3 … 9999, 10000, 10001（持续递增）</text>
<text class="ts" x="40" y="146" text-anchor="start">→ 单个 TiKV 的 CPU / 磁盘被打满</text>
<text class="ts" x="40" y="166" text-anchor="start">→ 其余节点空闲，加机器也没用（Region 分裂后仍追着尾部）</text>
<rect class="b2" x="410" y="20" width="370" height="170" rx="12"/>
<text class="th" x="426" y="44">✓ AUTO_RANDOM：主键高位随机，写入打散</text>
<rect class="b3" x="430" y="62" width="76" height="34" rx="4"/>
<rect class="b3" x="512" y="62" width="76" height="34" rx="4"/>
<rect class="b3" x="594" y="62" width="76" height="34" rx="4"/>
<rect class="b3" x="676" y="62" width="76" height="34" rx="4"/>
<text class="ts" x="468" y="79" text-anchor="middle" dominant-baseline="middle">写入</text>
<text class="ts" x="550" y="79" text-anchor="middle" dominant-baseline="middle">写入</text>
<text class="ts" x="632" y="79" text-anchor="middle" dominant-baseline="middle">写入</text>
<text class="ts" x="714" y="79" text-anchor="middle" dominant-baseline="middle">写入</text>
<text class="ts" x="430" y="124" text-anchor="start">id = 分片位(随机) + 自增位(唯一)</text>
<text class="ts" x="430" y="146" text-anchor="start">→ 多个 Region/多个 TiKV 并行写，线性扩展</text>
<text class="ts" x="430" y="166" text-anchor="start">注意：ID 不再严格递增（不能依赖主键排序当时间序）</text>
<rect class="bg" x="20" y="210" width="760" height="76" rx="10"/>
<text class="ts" x="36" y="234">发现热点：Dashboard → Key Visualizer（热力图：亮线=热点 Key 范围）、Top SQL、PD 的热点 Region 监控、单个 TiKV 节点 CPU 明显高于其他</text>
<text class="ts" x="36" y="254">缓解：PD 会自动对热点 Region 做 load-based split 与 Leader 迁移，但对“连续追加”的模式效果有限，必须从表设计上消除</text>
<text class="ts" x="36" y="274">读热点（某些 Key 被高频读）：用 Follower Read 分担、加缓存（Redis，见 Redis 缓存）、小表可设为缓存表 CACHED TABLE</text>
</svg>
<figcaption>图 1：写入热点与 AUTO_RANDOM</figcaption>
</figure>

### 2. 解决方案

| 方案 | 做法 | 说明 |
| --- | --- | --- |
| **`AUTO_RANDOM`**（推荐） | `id BIGINT PRIMARY KEY AUTO_RANDOM` | 主键高位为随机分片位、低位自增，**全局唯一且写入打散**；只能用于 BIGINT 主键（聚簇） |
| `SHARD_ROW_ID_BITS` + `PRE_SPLIT_REGIONS` | 无整数主键（使用隐藏 `_tidb_rowid`）的表：`SHARD_ROW_ID_BITS=4`，建表时预切分 Region | 把隐式 rowid 打散并预先分布，适合大批量初始导入 |
| 避免单调二级索引 | 如 `INDEX(create_time)`：写入集中在索引尾部 | 可与高基数前缀组合 `(tenant_id, create_time)`；或接受索引热点并预估压力 |
| 应用层生成分散 ID | 雪花 ID **时间在高位**仍是单调的 → 把机器位/随机位放到高位，或使用 UUID（但 UUID 作聚簇主键写放大、索引更大） | 需评估 |
| 预切分 Region | `SPLIT TABLE t BETWEEN (0) AND (...) REGIONS 128` | 大批量导入前预先把 Key 空间分散 |

```sql
CREATE TABLE orders (
  id          BIGINT PRIMARY KEY AUTO_RANDOM(5),        -- 5 位分片位 → 32 个分片区间
  order_no    VARCHAR(32) NOT NULL,
  user_id     BIGINT NOT NULL,
  status      TINYINT NOT NULL,
  amount_fen  BIGINT NOT NULL,
  created_at  DATETIME(3) NOT NULL,
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_user_time (user_id, created_at)               -- 以用户为前缀，写入分散
) ;
```

**业务影响**：用 `AUTO_RANDOM` 后 `id` 不再是时间序，**“按主键排序分页/取最新”要改用 `created_at` 索引**；对外暴露的订单号继续用业务生成的全局 ID（见 [分布式 ID](#/distributed/id)）。

## 二、从 MySQL 迁移

### 1. 迁移路径

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="MySQL 迁移到 TiDB：先做兼容性评估和表结构调整；使用 DM 做全量导出导入并持续增量同步 binlog；用 sync-diff-inspector 校验数据一致；灰度把读流量切到 TiDB；业务低峰切换写流量；上线后用反向同步把数据回流到 MySQL 以便回退；稳定后下线 MySQL">
<rect class="b3" x="20" y="30" width="120" height="70" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">① 评估</text>
<text class="ts" x="80" y="74" text-anchor="middle">兼容性/SQL/大事务</text>
<text class="ts" x="80" y="90" text-anchor="middle">热点与主键设计</text>
<rect class="b5" x="160" y="30" width="130" height="70" rx="8"/>
<text class="tb" x="225" y="52" text-anchor="middle" dominant-baseline="middle">② DM 全量+增量</text>
<text class="ts" x="225" y="74" text-anchor="middle">导出导入 + 回放</text>
<text class="ts" x="225" y="90" text-anchor="middle">binlog 持续同步</text>
<rect class="b2" x="310" y="30" width="120" height="70" rx="8"/>
<text class="tb" x="370" y="52" text-anchor="middle" dominant-baseline="middle">③ 数据校验</text>
<text class="ts" x="370" y="74" text-anchor="middle">sync-diff-inspector</text>
<text class="ts" x="370" y="90" text-anchor="middle">抽样 + 全量</text>
<rect class="b1" x="450" y="30" width="120" height="70" rx="8"/>
<text class="tb" x="510" y="52" text-anchor="middle" dominant-baseline="middle">④ 灰度读</text>
<text class="ts" x="510" y="74" text-anchor="middle">影子/比例读</text>
<text class="ts" x="510" y="90" text-anchor="middle">对比结果与性能</text>
<rect class="b4" x="590" y="30" width="190" height="70" rx="8"/>
<text class="tb" x="685" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 切写 + 反向同步</text>
<text class="ts" x="685" y="74" text-anchor="middle">停写窗口/低峰切换</text>
<text class="ts" x="685" y="90" text-anchor="middle">TiDB→MySQL 回流，可回退</text>
<line class="l" x1="140" y1="65" x2="160" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="65" x2="310" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="65" x2="450" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="65" x2="590" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="760" height="190" rx="10"/>
<text class="th" x="36" y="148">评估与改造清单</text>
<text class="ts" x="36" y="172">• 兼容性：存储过程/触发器/事件/部分函数、外键约束（新版本支持程度不同）、字符集与排序规则、SQL 模式、自增列语义</text>
<text class="ts" x="36" y="192">• 主键与索引：自增主键改 AUTO_RANDOM；评估单调二级索引的热点；缺少主键的表要补（聚簇索引影响）</text>
<text class="ts" x="36" y="212">• 事务：隔离级别（无间隙锁，快照隔离）、大事务拆批、乐观冲突/死锁重试、依赖 gap lock 的唯一性逻辑要改</text>
<text class="ts" x="36" y="232">• SQL：用 EXPLAIN 验证核心 SQL 计划；依赖 MySQL 特有 hint 的要调整；大表 count(*)/深分页走索引</text>
<text class="ts" x="36" y="252">• 分库分表迁入：DM 支持多源合并到一张表（Shard Merge），迁移后用 TiDB 的单表代替分片逻辑，去掉中间件</text>
<text class="ts" x="36" y="272">• 回退预案：反向同步到 MySQL（TiCDC 输出到 MySQL），保留旧库一段时间；切换前演练</text>
<text class="ts" x="36" y="292">• 容量：TiDB 数据副本数×3，存储成本、网络与 TiKV 数量要规划（见下文）</text>
</svg>
<figcaption>图 2：MySQL 迁移到 TiDB 的路径</figcaption>
</figure>

### 2. 工具

| 工具 | 用途 |
| --- | --- |
| **TiDB Data Migration（DM）** | 从 MySQL/MariaDB 做**全量 + 增量**同步；支持分库分表合并、表/库路由与过滤 |
| **Dumpling + TiDB Lightning** | 大数据量**全量导出与高速导入**（物理导入模式绕过 SQL 层直接写 SST，速度快，导入期间集群不应承接线上写入） |
| **TiCDC** | 从 TiDB 捕获变更输出到 Kafka/MySQL/下游（用于**反向回流、数据同步、实时数仓**，见 [CDC 与实时数仓](#/bigdata/cdc)） |
| **sync-diff-inspector** | 上下游数据校验与修复 SQL 生成 |
| **BR（Backup & Restore）** | 分布式快照备份与 PITR（时间点恢复），备份到对象存储 |

## 三、Java 应用适配

### 1. 连接与驱动

TiDB 兼容 MySQL 协议，**直接使用 MySQL Connector/J**（不需要专用驱动），多个 TiDB Server 前面放 LB（HAProxy/LVS/K8s Service/云 LB），或客户端配置多个地址：

```yaml
spring:
  datasource:
    url: jdbc:mysql://tidb-lb:4000/shop?useServerPrepStmts=true&cachePrepStmts=true&prepStmtCacheSize=256&prepStmtCacheSqlLimit=2048&rewriteBatchedStatements=true&useConfigs=maxPerformance&connectTimeout=3000&socketTimeout=30000
    hikari:
      maximum-pool-size: 50          # 连接数 ≠ 越大越好：TiDB 是分布式事务，过多并发会放大冲突与排队
      max-lifetime: 1800000
      connection-timeout: 3000
```

- 开启**服务端预编译 + 缓存**（`useServerPrepStmts` + `cachePrepStmts`）降低解析开销，TiDB 有 Plan Cache；
- **批量写**用 `rewriteBatchedStatements=true`，把多条 INSERT 合并；
- 连接池大小结合 TiDB 节点数与并发，**避免连接数爆炸**；长连接经 LB 时注意 LB 空闲超时（HAProxy `timeout client`）与 `max-lifetime`；
- 端口默认 **4000**（MySQL 是 3306）。

### 2. 事务与重试

悲观事务下与 MySQL 行为接近，但仍要处理这些**可重试错误**：

| 错误 | 含义 | 应用处理 |
| --- | --- | --- |
| `Write conflict`（9007，乐观事务提交冲突） | 两个事务改同一行 | 重试整个事务 |
| `Deadlock found`（1213） | 悲观锁死锁 | 重试 |
| `TiKV server timeout` / `Region is unavailable` / 8027 `Information schema is changed` | Leader 切换/Region 调度/DDL 期间 | 幂等地重试（指数退避） |
| `Transaction too large`（8004） | 事务过大 | 拆批，**不是重试能解决的** |

```java
// Spring：对可重试异常做有限次数重试（事务方法要幂等，见 事件驱动/支付案例中的幂等设计）
@Retryable(retryFor = { CannotAcquireLockException.class, TransientDataAccessException.class },
           maxAttempts = 3, backoff = @Backoff(delay = 50, multiplier = 2))
@Transactional
public void pay(String orderNo) { ... }
```

### 3. 批量写与大事务

**避免一个事务处理几十万/几百万行**：

```java
// ✗ 一个事务更新千万行：Transaction too large / 长时间持锁 / 拖慢 GC
// ✓ 分批：按主键范围或 LIMIT 循环，每批数千行，批间 sleep 限速，可断点续跑
long lastId = 0; int batch = 2000;
while (true) {
    List<Long> ids = jdbc.queryForList("SELECT id FROM t_log WHERE id > ? AND created_at < ? ORDER BY id LIMIT ?", Long.class, lastId, cutoff, batch);
    if (ids.isEmpty()) break;
    jdbc.update("DELETE FROM t_log WHERE id IN (" + placeholders(ids.size()) + ")", ids.toArray());   // 每批独立小事务
    lastId = ids.get(ids.size() - 1);
    Thread.sleep(50);                                                                             // 限速，避免压垮 TiKV
}
```

- 新版本支持**非事务 DML**（`BATCH ON ... LIMIT n DELETE/UPDATE ...`）简化大批量删除/更新（注意其**非原子**语义）；
- 大批量导入用 Lightning/导入工具而非逐条 INSERT；
- 历史数据清理优先**按时间分区表 + DROP PARTITION**（元数据操作，瞬间完成），而不是大 DELETE；
- 与 MySQL 的大批量处理经验相通，见 [SQL 调优](#/mysql/optimize)。

## 四、SQL 调优

### 1. 执行计划与统计信息

```sql
EXPLAIN ANALYZE SELECT o.user_id, SUM(o.amount_fen) FROM orders o WHERE o.created_at >= '2026-10-01' GROUP BY o.user_id;
```

| 关注点 | 说明 |
| --- | --- |
| **`estRows` vs `actRows`** | 差距大（数量级）说明**统计信息过期/不准** → `ANALYZE TABLE t`；或数据倾斜 |
| 算子位置：`root` / `cop[tikv]` / `mpp[tiflash]` | 过滤和聚合应在 `cop[tikv]` 下推；大量数据回传到 `root` 再处理会慢且耗内存 |
| 扫描方式：`TableFullScan` / `IndexRangeScan` / `IndexLookUp` | 全表扫描要警惕；`IndexLookUp`（回表）行数大时考虑覆盖索引/复合索引 |
| `scan_detail`/`total_keys`/`processed_keys` | 扫描 Key 数远大于返回行数 → 缺索引或存在大量旧版本/墓碑（GC 问题） |
| Join 类型 | 小表驱动大表；大表 Join 可用 TiFlash MPP |

### 2. 常见手段

- **补/改索引**：与 MySQL 类似的最左前缀、覆盖索引；用 **Dashboard 索引建议**与 `INFORMATION_SCHEMA.TIDB_INDEX_USAGE`（版本相关）找无用索引；
- **更新统计信息**：大批量写入/导入后手动 `ANALYZE`；自动 analyze 有触发条件与时间窗口配置；
- **SQL Hint / 执行计划绑定**：`/*+ USE_INDEX(t, idx) */`、`/*+ READ_FROM_STORAGE(TIFLASH[t]) */`；`CREATE GLOBAL BINDING` 固定计划，避免计划抖动；
- **避免深分页**：`LIMIT 1000000, 20` 要扫描并丢弃前 100 万 → 改键集分页；
- **减少回传**：只 `SELECT` 需要的列；大 `IN` 列表分批；
- **并行度与内存**：`tidb_distsql_scan_concurrency`、`tidb_mem_quota_query`、`tidb_enable_tmp_storage_on_oom`（超内存落盘）；资源管控（Resource Control）隔离不同业务（版本相关）。

### 3. 慢查询与排障入口

- **TiDB Dashboard**：慢查询、Top SQL（按 CPU 归因到 SQL）、**Key Visualizer（热点图）**、集群诊断报告；
- `INFORMATION_SCHEMA.SLOW_QUERY`、`CLUSTER_STATEMENTS_SUMMARY`（语句统计）、`tidb.log` 慢日志（`tidb_slow_log_threshold`）；
- Grafana/Prometheus 监控面板（TiDB/TiKV/PD 各自的 Overview），指标接入统一监控（见 [指标监控](#/infra/obs-metrics)）。

## 五、TiFlash 使用

```sql
ALTER TABLE orders SET TIFLASH REPLICA 1;                      -- 创建列存副本（后台同步，查进度见 information_schema.tiflash_replica）
SELECT /*+ READ_FROM_STORAGE(TIFLASH[o]) */ channel, COUNT(*), SUM(amount_fen)
  FROM orders o WHERE created_at >= '2026-10-01' GROUP BY channel;   -- 强制走列存；一般让优化器按代价选
```

- **TiFlash 独立节点部署**，与 TiKV 资源隔离，避免分析查询影响交易；
- 适合：大范围扫描+聚合、报表、对实时性要求高的看板；**不适合点查**；
- 需要的副本数与存储（列存压缩率好，但仍是额外一份数据）要计入成本；
- 若分析规模、复杂度已远超“在线交易库附带分析”，仍应考虑专用 OLAP（见 [OLAP](#/bigdata/olap)）。

## 六、部署、监控与容量

| 项 | 建议 |
| --- | --- |
| **最小生产拓扑** | ≥3 个 TiKV、≥3 个 PD、≥2 个 TiDB（前置 LB），按需 TiFlash；PD 与 TiKV 分机部署，PD/TiKV 使用 **SSD/NVMe** |
| **部署方式** | TiUP（物理机/虚机）、**TiDB Operator（Kubernetes）**、云上托管（TiDB Cloud/云厂商托管版） |
| **副本与容灾** | 默认 3 副本；跨机架/可用区用 label 约束放置；跨机房需评估 RTT 对写延迟的影响（多数派写） |
| **容量规划** | 存储 ≈ 原始数据 × 副本数 ×（索引膨胀系数）÷ 压缩；TiKV 单节点磁盘建议留足余量（通常使用率不超过 60~70%）；Region 数过多时调整大小 |
| **监控告警** | 单 TiKV CPU/IO/磁盘、PD 的 TSO 延迟与 Leader、Region 健康、Raft 提交延迟、GC safepoint 滞后、慢查询、事务冲突率、store 下线；PD 抖动会影响全部事务 |
| **备份** | BR 全量 + 日志备份（PITR）到对象存储；定期演练恢复；备份不是副本（多副本 ≠ 备份） |
| **升级** | 使用 TiUP/Operator 滚动升级；先在预发验证；关注优化器与默认行为变化 |
| **安全** | TLS、账号权限最小化、审计、数据加密（见 [加密与密钥管理](#/security/crypto)） |
| **参数** | 不要随意调优，先看监控；官方有各业务场景的参数建议 |

## 七、选型：该不该用 TiDB

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="选型决策：数据量小且单机能承载且延迟敏感时选 MySQL 或 PostgreSQL 单机主从；读多写少可用主从加缓存；写入量或数据量大到单机放不下，且分库分表已造成强烈痛苦，需要在线扩缩容、强一致分布式事务、HTAP 时选 TiDB；文档型灵活模式的场景选 MongoDB；纯分析场景选 OLAP 数据库">
<rect class="b2" x="20" y="30" width="240" height="120" rx="12"/>
<text class="th" x="36" y="54">单机 MySQL / PG（+主从、缓存）</text>
<text class="ts" x="36" y="78">数据 < 几 TB，写入单机可承载</text>
<text class="ts" x="36" y="98">延迟极敏感，团队运维能力有限</text>
<text class="ts" x="36" y="118">✓ 最简单、最便宜、延迟最低</text>
<text class="ts" x="36" y="138">先把索引/SQL/缓存/读写分离做好</text>
<rect class="b3" x="280" y="30" width="240" height="120" rx="12"/>
<text class="th" x="296" y="54">分库分表（ShardingSphere 等）</text>
<text class="ts" x="296" y="78">规模大但分片键清晰稳定</text>
<text class="ts" x="296" y="98">跨分片查询/事务少、可控</text>
<text class="ts" x="296" y="118">✓ 沿用 MySQL 生态，成本可控</text>
<text class="ts" x="296" y="138">✗ 扩容迁移与运维复杂，侵入业务</text>
<rect class="b5" x="540" y="30" width="240" height="120" rx="12"/>
<text class="th" x="556" y="54">TiDB</text>
<text class="ts" x="556" y="78">TB~PB 级，写入需水平扩展</text>
<text class="ts" x="556" y="98">需要强一致分布式事务 + SQL</text>
<text class="ts" x="556" y="118">要在线扩缩容、高可用、HTAP</text>
<text class="ts" x="556" y="138">✓ 去掉分片逻辑；✗ 延迟更高、成本更高</text>
<rect class="b1" x="20" y="170" width="240" height="70" rx="12"/>
<text class="th" x="36" y="194">MongoDB</text>
<text class="ts" x="36" y="216">模式灵活、嵌套文档、非强事务</text>
<rect class="b4" x="280" y="170" width="240" height="70" rx="12"/>
<text class="th" x="296" y="194">OLAP（ClickHouse/Doris）</text>
<text class="ts" x="296" y="216">纯分析、海量明细、聚合查询</text>
<rect class="b" x="540" y="170" width="240" height="70" rx="12"/>
<text class="th" x="556" y="194">Redis</text>
<text class="ts" x="556" y="216">缓存、计数、排行榜（非主存储）</text>
<rect class="bg" x="20" y="256" width="760" height="62" rx="10"/>
<text class="ts" x="36" y="280">经验法则：能用单机方案解决就不要分布式；“数据量大 + 写入大 + 不想改业务做分片 + 要事务”是 TiDB 的最佳区间</text>
<text class="ts" x="36" y="300">决策前用真实业务做 PoC：压测核心 SQL 的延迟与吞吐、热点情况、故障演练（杀节点）、扩缩容与备份恢复</text>
</svg>
<figcaption>图 3：存储选型：别为“分布式”而分布式</figcaption>
</figure>

**TiDB 的典型落地场景**：

- 分库分表后**运维和跨分片问题严重**，希望合并为一个逻辑库（订单、账单、交易流水）；
- **数据量持续增长**，单机容量/写入吞吐触顶，希望在线弹性扩容；
- **对高可用要求高**（RPO≈0，自动故障转移），多副本强一致；
- 需要**实时分析**同一份交易数据（HTAP），降低 ETL 链路复杂度；
- **多业务/多租户汇聚**到统一平台。

**不推荐**：数据量小、QPS 不高、延迟极敏感（亚毫秒）、对 MySQL 特性依赖深（存储过程/触发器）、缺乏分布式数据库运维能力的团队。

## 八、常见坑

| 坑 | 对策 |
| --- | --- |
| 自增主键导致写热点，加机器无效 | `AUTO_RANDOM` / `SHARD_ROW_ID_BITS` + 预切分；Key Visualizer 排查 |
| 一次事务改几十万行（`Transaction too large`、慢、锁多） | 分批、非事务 DML、分区表 DROP |
| 统计信息过期，优化器选错索引/Join | 导入后 `ANALYZE`，绑定关键 SQL 计划 |
| 沿用 MySQL 习惯：依赖 gap lock 防重复插入 | 用唯一索引或显式 `FOR UPDATE`；评估隔离差异 |
| 连接数过大、乐观事务冲突重试风暴 | 控制并发与池大小；悲观事务；退避重试；热点行拆分 |
| 长事务/长快照读阻止 GC，空间与扫描变慢 | 限制事务时长；监控 GC safepoint；关注大量删除后的 Compaction |
| 大量小表/过多 Region 导致元数据压力 | 控制表/分区数量；调整 Region 大小；合并 Region |
| 只部署 3 节点且 PD 与 TiKV 混部，互相抢资源 | 分离部署、SSD、独立 PD |
| 把 TiFlash 与 TiKV 混在同一机器，分析拖垮交易 | TiFlash 独立节点 + 资源隔离 |
| 以为多副本就不用备份 | BR 备份 + PITR + 演练 |
| 迁移后没有回退方案 | TiCDC 反向同步到 MySQL，保留旧库观察期 |
| 盲目调参 | 先用 Dashboard/监控定位瓶颈，参照官方推荐 |

## 面试追问

> [!QUESTION] TiDB 会有热点问题吗？怎么解决？
> 会。数据按 Key 范围分 Region，连续递增的主键或索引会让新写入集中到最后一个 Region，使单个 TiKV 成为瓶颈。方案是用 AUTO_RANDOM 让主键高位随机，或对无整数主键的表用 SHARD_ROW_ID_BITS 加预切分，避免单调的二级索引，并用 Key Visualizer 定位热点；读热点可用 Follower Read 或缓存。

> [!QUESTION] 从 MySQL 迁移到 TiDB 要做哪些工作？怎么保证平滑和可回退？
> 先评估兼容性、SQL、大事务和主键热点；用 DM 做全量加增量同步，Lightning 导入大数据；用 sync-diff-inspector 校验；先灰度读再切写；切换后用 TiCDC 反向回流到 MySQL，保留旧库观察期以便回退。应用侧适配隔离级别差异、大事务拆批、冲突和死锁重试以及自增 ID 语义。

> [!QUESTION] TiDB 里大批量删除或更新怎么做？
> 避免单个大事务，会触发 Transaction too large 或长时间持锁。应按主键范围分批、每批数千行、批间限速并可断点续跑，新版本可用非事务 DML；历史数据优先按时间分区并 DROP PARTITION，大批量导入使用 Lightning。

> [!QUESTION] TiDB 慢 SQL 怎么排查？
> 用 Dashboard 的慢查询和 Top SQL 找到语句，EXPLAIN ANALYZE 对比 estRows 与 actRows 判断统计信息是否过期，查看算子是否下推到 TiKV、是否全表扫描或大量回表，以及扫描 Key 数是否远大于返回行数，再通过补索引、ANALYZE、Hint 或计划绑定、改写深分页等手段优化。

> [!QUESTION] 什么情况下该选 TiDB，什么情况下不该？
> 数据量到 TB 级以上、写入需要水平扩展、分库分表带来巨大运维和跨分片问题、需要强一致事务、在线扩缩容和高可用甚至 HTAP 时适合。数据量小、延迟极敏感、重度依赖 MySQL 特有特性或缺乏分布式数据库运维能力时，应使用单机 MySQL 或 PG 加主从和缓存，并通过真实业务 PoC 验证。

> [!QUESTION] TiDB 的乐观事务和悲观事务怎么选？
> 悲观事务在执行 DML 时就加锁，冲突表现为等待和死锁，与 MySQL 行为接近，适合冲突多和从 MySQL 迁移的业务，也是新版本默认；乐观事务在提交时才检测冲突，冲突少时吞吐高，但冲突会提交失败需要应用重试。
