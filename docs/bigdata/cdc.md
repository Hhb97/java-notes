---
level: 深入
tags: [CDC, Flink CDC, Debezium, 实时数仓, Lambda, Kappa, 分层建模, 流批一体]
summary: 讲清 CDC 的原理与实现方式、Flink CDC 的全量+增量一致性读取（增量快照算法）、与 Debezium/Canal 的对比，以及实时数仓的分层架构、Lambda 与 Kappa 的取舍、维度关联、数据质量与对账。
---

# CDC 与实时数仓架构

> [!ABSTRACT] 核心要点
> - **CDC（Change Data Capture）** 捕获数据库的**变更**（增删改）并实时传递：主流方式是**读取数据库日志**（MySQL binlog、PG WAL、Oracle redo），**无侵入、低延迟、不漏数据**，优于“定时全量/按时间戳增量查询”。
> - **Flink CDC** 提供**全量快照 + 增量日志读取**的一体化 Source，并通过**增量快照算法**实现**无锁、并行、可断点续传**的一致性读取。
> - 实时数仓采用**分层**：`ODS（原始）→ DWD（明细）→ DWS（汇总）→ ADS（应用）`，层间通过 **Kafka 或湖仓**衔接；关键难题是**维度关联、乱序、更新回撤、数据对账**。
> - **Lambda**（批流两套）一致性差、维护双份逻辑；**Kappa**（只保留流）简单但重放成本高；现代方案倾向**流批一体 + 数据湖（Paimon/Iceberg）**。
> - 衡量实时数仓：**端到端延迟、数据正确性（与离线对账）、稳定性与成本**，而不仅是“能出数”。

## 为什么需要 CDC

把业务库数据同步到分析/搜索/缓存/数仓，常见做法对比：

| 方式 | 原理 | 问题 |
| --- | --- | --- |
| 定时全量导出 | 每天/小时 `SELECT *` | 压力大、延迟高、不能实时 |
| 基于时间戳/自增 ID 增量 | `WHERE update_time > ?` | 依赖字段可靠；**捕获不到删除**；同一时间戳漏数；对业务库有查询压力 |
| 触发器 | 表触发器写变更表 | 侵入业务库、影响性能，维护复杂 |
| 应用双写 | 业务代码同时写多处 | 耦合、不一致、漏写 |
| **日志 CDC** | **解析数据库日志（binlog/WAL）** | 无侵入、实时、**包含删除与历史顺序**；需要数据库权限与日志保留 |

## CDC 原理

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="日志型 CDC：数据库写入产生 binlog，CDC 组件读取并解析为变更事件，写入消息队列或直接被 Flink 消费">
<rect class="b5" x="20" y="110" width="140" height="90" rx="10"/>
<text class="tb" x="90" y="136" text-anchor="middle" dominant-baseline="middle">MySQL 业务库</text>
<text class="ts" x="90" y="158" text-anchor="middle">事务提交 → binlog</text>
<text class="ts" x="90" y="178" text-anchor="middle">（ROW 格式）</text>
<rect class="b3" x="220" y="110" width="170" height="90" rx="10"/>
<text class="tb" x="305" y="132" text-anchor="middle" dominant-baseline="middle">CDC 组件</text>
<text class="ts" x="305" y="154" text-anchor="middle">伪装成从库拉取 binlog</text>
<text class="ts" x="305" y="174" text-anchor="middle">Debezium / Canal / Flink CDC</text>
<rect class="b1" x="450" y="40" width="150" height="70" rx="10"/>
<text class="tb" x="525" y="62" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<text class="ts" x="525" y="84" text-anchor="middle">按主键分区，保序</text>
<rect class="b2" x="450" y="210" width="150" height="70" rx="10"/>
<text class="tb" x="525" y="232" text-anchor="middle" dominant-baseline="middle">Flink（直接消费）</text>
<text class="ts" x="525" y="254" text-anchor="middle">Flink CDC Source</text>
<rect class="b4" x="640" y="110" width="100" height="90" rx="10"/>
<text class="tb" x="690" y="140" text-anchor="middle" dominant-baseline="middle">下游</text>
<text class="ts" x="690" y="162" text-anchor="middle">数仓 / ES</text>
<text class="ts" x="690" y="180" text-anchor="middle">缓存 / 湖</text>
<line class="l" x1="160" y1="155" x2="220" y2="155" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="130" x2="450" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="180" x2="450" y2="235" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="80" x2="640" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="240" x2="640" y2="175" marker-end="url(#arr)"/>
<text class="ts" x="380" y="318" text-anchor="middle">变更事件包含：操作类型（c/u/d）· 变更前镜像 before · 变更后镜像 after · 表信息 · 时间 · binlog 位点</text>
</svg>
<figcaption>图 1：日志型 CDC：读取 binlog，转换为变更事件流</figcaption>
</figure>

**MySQL 侧前提**（详见 [redo / undo / binlog](#/mysql/log)）：

- `log_bin=ON`、**`binlog_format=ROW`**、`binlog_row_image=FULL`（才包含完整前后镜像）；
- 开启 **GTID** 便于主从切换后的位点连续（可选但推荐）；
- binlog **保留时间足够长**（`binlog_expire_logs_seconds`），避免 CDC 停机恢复时位点已被清理；
- 授予复制权限的专用账号（`REPLICATION SLAVE`、`REPLICATION CLIENT`、`SELECT`）；
- **从库读取 binlog**以减轻主库压力（需 `log_replica_updates`）。

PostgreSQL 使用**逻辑复制槽**（`wal_level=logical`，见 [复制、高可用与实战](#/pg/ops)，注意**槽积压撑爆磁盘**）。

## CDC 工具对比

| | **Flink CDC** | Debezium | Canal / Maxwell |
| --- | --- | --- | --- |
| 形态 | Flink Source 连接器（含 YAML 管道 `Flink CDC 3.x`） | 基于 Kafka Connect 的连接器（也有嵌入式） | 独立服务，伪装从库 |
| 全量+增量 | **一体化，无锁并行** | 初始快照 + binlog（快照阶段默认较串行，可能锁表） | 主要是增量，全量需另做 |
| 数据库 | MySQL、PG、Oracle、SQL Server、MongoDB 等 | 覆盖广 | 以 MySQL 为主 |
| 下游 | 直接进入 Flink 计算/写入多种 Sink | 写入 Kafka，再被各系统消费 | 写入 Kafka/RocketMQ/ES 等 |
| 适用 | **以 Flink 为核心的实时数仓/整库同步** | **以 Kafka 为中心的平台化数据同步** | 国内 MySQL 同步历史存量方案 |

选型：**团队主栈是 Flink → Flink CDC**；需要把变更**广播给多个独立消费者**（ES、缓存、数仓、风控）→ **Debezium/Canal → Kafka** 再分发。二者可组合：CDC 进 Kafka，Flink 从 Kafka 消费。

## Flink CDC：全量 + 增量一致读取

### 要解决的问题

要把一张已有数据的大表同步出去：必须**先读存量快照，再无缝衔接增量 binlog**，且**不丢、不重、不长时间锁表**。传统做法（Debezium 早期）对表加**全局读锁**取一致位点再读快照，对线上库有风险。

### 增量快照算法（基于 DBLog 论文思想）

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="Flink CDC 增量快照：表按主键切成 chunk 并行读取，每个 chunk 用低高水位点包裹，快照数据与 binlog 合并后得到一致结果，之后切换为 binlog 读取">
<rect class="b" x="20" y="20" width="720" height="60" rx="10"/>
<text class="th" x="36" y="42">① 把表按主键范围切成多个 Chunk，分配给多个并行 Reader</text>
<rect class="b1" x="40" y="50" width="120" height="22" rx="4"/>
<text class="tm" x="100" y="61" text-anchor="middle" dominant-baseline="middle">id [1, 10000)</text>
<rect class="b1" x="170" y="50" width="130" height="22" rx="4"/>
<text class="tm" x="235" y="61" text-anchor="middle" dominant-baseline="middle">[10000, 20000)</text>
<rect class="b1" x="310" y="50" width="130" height="22" rx="4"/>
<text class="tm" x="375" y="61" text-anchor="middle" dominant-baseline="middle">[20000, 30000)</text>
<rect class="b1" x="450" y="50" width="130" height="22" rx="4"/>
<text class="tm" x="515" y="61" text-anchor="middle" dominant-baseline="middle">[30000, …)</text>
<text class="ts" x="620" y="61" text-anchor="start">各 Chunk 并行读</text>
<text class="th" x="20" y="116">② 单个 Chunk 的读取（无锁）</text>
<line class="l" x1="40" y1="170" x2="720" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="30" y="196" text-anchor="start">binlog 时间线 →</text>
<rect class="b3" x="130" y="144" width="14" height="52" rx="2"/>
<text class="ta" x="137" y="136" text-anchor="middle">低水位 LW</text>
<text class="ts" x="137" y="214" text-anchor="middle">记录当前 binlog 位点</text>
<rect class="b2" x="190" y="152" width="210" height="36" rx="4"/>
<text class="tb" x="295" y="170" text-anchor="middle" dominant-baseline="middle">SELECT 读取该 Chunk 快照数据</text>
<rect class="b3" x="440" y="144" width="14" height="52" rx="2"/>
<text class="ta" x="447" y="136" text-anchor="middle">高水位 HW</text>
<text class="ts" x="447" y="214" text-anchor="middle">再记录 binlog 位点</text>
<rect class="b5" x="130" y="228" width="324" height="34" rx="4"/>
<text class="tb" x="292" y="245" text-anchor="middle" dominant-baseline="middle">读取 [LW, HW] 之间的 binlog，对快照数据做“修正”（合并）</text>
<text class="ts" x="380" y="288" text-anchor="middle">快照读期间发生的变更可能已被读到，也可能没有；用 [LW,HW] 的 binlog 对其按主键更新/删除，得到 HW 时刻的一致结果</text>
<text class="ts" x="380" y="336" text-anchor="middle">③ 全部 Chunk 完成后，从最小 LW 开始读 binlog，并过滤已合并的部分</text>
<text class="ts" x="380" y="318" text-anchor="middle">无需全局锁；Chunk 并行；以 Checkpoint 保存进度，失败从未完成的 Chunk 继续</text>
</svg>
<figcaption>图 2：增量快照：Chunk 并行读取，用 binlog 水位区间修正快照</figcaption>
</figure>

**要点**：

1. **分片（Chunk）**：按主键（或指定分片列）范围切分，多个 Reader **并行**读取，大表快照也很快；
2. **一致性**：每个 Chunk 读取前后记录 binlog 的低/高水位；把区间内的 binlog 变更**应用到该 Chunk 快照**上，得到与某个时间点一致的数据；
3. **无锁**：不需要 `FLUSH TABLES WITH READ LOCK`，不影响线上写入；
4. **断点续传**：Chunk 进度保存在 Flink 状态（Checkpoint），失败后继续；
5. **切换增量**：所有 Chunk 完成后，从最小位点开始读取 binlog，并对已被修正的变更去重；
6. 分片列要求：**有主键/唯一键**、分布均匀；无主键表需指定分片列并接受限制。

### 使用示例（Flink SQL）

```sql
CREATE TABLE orders_src (
  id BIGINT, user_id BIGINT, amount DECIMAL(12,2), status STRING, update_time TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector' = 'mysql-cdc',
  'hostname' = 'mysql', 'port' = '3306', 'username' = 'cdc', 'password' = '******',
  'database-name' = 'shop', 'table-name' = 'orders',
  'server-id' = '5400-5408',                          -- 每个并行 Reader 需要唯一 server-id，范围 ≥ 并行度
  'scan.incremental.snapshot.enabled' = 'true',
  'scan.startup.mode' = 'initial',                    -- initial：全量 + 增量；latest-offset：仅增量；timestamp：指定时间
  'server-time-zone' = 'Asia/Shanghai'
);

-- 同步到数据湖 / OLAP
INSERT INTO paimon_orders SELECT * FROM orders_src;
```

要点：

- **`server-id` 范围**：与并行度匹配，且不能与 MySQL 集群中其他从库冲突；
- **整库同步**：Flink CDC 3.x 的 **YAML Pipeline** 支持整库/多表同步、**Schema 变更自动同步**（DDL 演进）、路由与转换，免写 SQL；
- 位点保存于 Checkpoint：**停机时间不能超过 binlog 保留期**，否则无法续跑只能重做全量；
- **主库切换**：使用 GTID 可在主从切换后继续；否则位点失效；
- **DDL 变更**：加列等 Schema 变化需要作业支持（Pipeline 模式可自动同步，SQL 模式需手动处理）；
- 监控 `currentFetchEventTimeLag`（读取延迟）、binlog 位点与源库差距。

## 实时数仓分层架构

<figure class="fig">
<svg viewBox="0 0 760 420" class="dg" role="img" aria-label="实时数仓分层架构：数据源经 CDC 与日志采集进入 ODS，经 DWD、DWS 加工，最终服务 ADS 与应用，并配套维度、对账和离线批处理">
<rect class="b" x="20" y="20" width="150" height="150" rx="10"/>
<text class="th" x="95" y="44" text-anchor="middle">数据源</text>
<text class="ts" x="95" y="72" text-anchor="middle">业务库 MySQL/PG</text>
<text class="ts" x="95" y="92" text-anchor="middle">→ CDC（binlog）</text>
<text class="ts" x="95" y="116" text-anchor="middle">埋点 / 日志</text>
<text class="ts" x="95" y="136" text-anchor="middle">→ Kafka</text>
<text class="ts" x="95" y="156" text-anchor="middle">IoT / 第三方</text>
<rect class="b3" x="210" y="20" width="110" height="110" rx="10"/>
<text class="th" x="265" y="44" text-anchor="middle">ODS</text>
<text class="ts" x="265" y="68" text-anchor="middle">原始数据层</text>
<text class="ts" x="265" y="88" text-anchor="middle">贴源，不加工</text>
<text class="ts" x="265" y="108" text-anchor="middle">保留变更日志</text>
<rect class="b1" x="350" y="20" width="120" height="110" rx="10"/>
<text class="th" x="410" y="44" text-anchor="middle">DWD</text>
<text class="ts" x="410" y="68" text-anchor="middle">明细层</text>
<text class="ts" x="410" y="88" text-anchor="middle">清洗·去重·规范</text>
<text class="ts" x="410" y="108" text-anchor="middle">维度关联·宽表</text>
<rect class="b2" x="500" y="20" width="120" height="110" rx="10"/>
<text class="th" x="560" y="44" text-anchor="middle">DWS</text>
<text class="ts" x="560" y="68" text-anchor="middle">汇总层</text>
<text class="ts" x="560" y="88" text-anchor="middle">按主题轻度聚合</text>
<text class="ts" x="560" y="108" text-anchor="middle">窗口指标</text>
<rect class="b5" x="650" y="20" width="90" height="110" rx="10"/>
<text class="th" x="695" y="44" text-anchor="middle">ADS</text>
<text class="ts" x="695" y="68" text-anchor="middle">应用层</text>
<text class="ts" x="695" y="88" text-anchor="middle">报表/大屏</text>
<text class="ts" x="695" y="108" text-anchor="middle">指标服务</text>
<line class="l" x1="170" y1="75" x2="210" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="75" x2="350" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="75" x2="500" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="75" x2="650" y2="75" marker-end="url(#arr)"/>
<text class="ts" x="380" y="154" text-anchor="middle">层间载体：Kafka（低延迟、仅最新）或 数据湖 Paimon/Iceberg（可重放、可更新、可 OLAP 查询）；计算引擎：Flink</text>
<rect class="bg" x="20" y="180" width="360" height="110" rx="10"/>
<text class="th" x="36" y="204">维度体系</text>
<text class="ts" x="36" y="228">维表来源：MySQL 维度库 / CDC 同步到 HBase、Redis、Paimon</text>
<text class="ts" x="36" y="248">关联方式：Lookup Join（带缓存）· Temporal Join（版本化）</text>
<text class="ts" x="36" y="268">难点：维度更新晚于事实、缓存一致性、历史维度（拉链）</text>
<rect class="bg" x="400" y="180" width="340" height="110" rx="10"/>
<text class="th" x="416" y="204">离线批处理（校正与回溯）</text>
<text class="ts" x="416" y="228">T+1 的离线批作业重算全天数据</text>
<text class="ts" x="416" y="248">与实时结果对账，差异修正</text>
<text class="ts" x="416" y="268">Spark / Hive / Flink 批，同一份湖仓数据</text>
<rect class="b4" x="20" y="310" width="720" height="90" rx="10"/>
<text class="th" x="36" y="334">质量保障</text>
<text class="ts" x="36" y="358">数据对账（实时 vs 离线）· 延迟监控（Lag/Watermark）· 脏数据与死信 · 血缘与元数据 · 回溯/重跑能力 · 幂等写入</text>
<text class="ts" x="36" y="380">指标口径统一：同一指标只在一处定义（指标中台/语义层），避免实时与离线口径不一致</text>
</svg>
<figcaption>图 3：实时数仓分层：ODS → DWD → DWS → ADS，配套维度与对账</figcaption>
</figure>

| 层 | 职责 | 示例 |
| --- | --- | --- |
| **ODS** | 原样接入，保留变更历史，不做业务加工 | CDC 订单变更流、埋点原始日志 |
| **DWD** | 清洗、去重、规范化、**维度关联成宽表** | 订单明细宽表（关联用户、商品、门店） |
| **DWS** | 按主题**轻度聚合**（分钟/小时粒度） | 各店铺每分钟 GMV、用户当日累计 |
| **ADS** | 面向具体应用的结果（报表、大屏、接口） | 大屏实时指标、风控特征 |
| **DIM** | 维度层（用户、商品、组织、地区） | 维表，缓慢变化 |

### 关键技术难题

**1. 乱序与迟到**：用事件时间 + Watermark + 允许迟到 + 侧输出，见 [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core)。

**2. 更新与回撤**：订单状态会变更（下单→支付→退款），聚合结果需要**回撤并重算**；使用 Flink SQL 的 Changelog 与带主键 Sink（upsert），见 [Flink SQL、反压与性能调优](#/bigdata/flink-ops)。

**3. 维度关联**：

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| Lookup Join 外部库 | 实时查 MySQL/HBase/Redis，缓存 | 简单；对外部库有 QPS 压力；维度变更的**一致性/时效**需设计 |
| **维表也走 CDC 进 Flink 状态** | 维度变更流与事实流 Join | 无外部查询；状态大；一致性好 |
| Temporal Join | 事实时间点对应的维度版本 | 语义精确（历史价格/等级） |
| 广播维表 | 小维表广播到所有 SubTask | 小维表高效 |
| 预关联到事实表 | 上游业务写入时携带 | 依赖业务改造 |

**4. 全量与增量统一**：CDC 初始化快照 + 增量；**历史数据回补**用批作业写湖仓；实时作业从某位点开始。

**5. 结果存储选择**：

| 存储 | 适合 |
| --- | --- |
| Kafka | 层间传递、实时消费，不适合点查和多次聚合分析 |
| **Doris/StarRocks/ClickHouse** | 实时 OLAP 查询，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |
| **Paimon/Iceberg** | 湖仓：可更新、可重放、流批共用，见 [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |
| Redis/HBase | 高并发点查、特征服务、维度 |
| Elasticsearch | 全文与多维检索，见 [Elasticsearch 原理](#/mw/es) |

## Lambda 与 Kappa

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="Lambda 架构的批层与速度层并行，Kappa 架构只保留流处理，湖仓流批一体">
<text class="th" x="20" y="24">Lambda：批 + 流两套</text>
<rect class="b1" x="20" y="38" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="63" text-anchor="middle" dominant-baseline="middle">数据源</text>
<rect class="b3" x="170" y="34" width="130" height="30" rx="6"/>
<text class="ts" x="235" y="49" text-anchor="middle" dominant-baseline="middle">批层：T+1 离线</text>
<rect class="b2" x="170" y="68" width="130" height="30" rx="6"/>
<text class="ts" x="235" y="83" text-anchor="middle" dominant-baseline="middle">速度层：实时流</text>
<rect class="b5" x="340" y="46" width="130" height="40" rx="6"/>
<text class="tb" x="405" y="66" text-anchor="middle" dominant-baseline="middle">服务层合并</text>
<line class="l" x1="130" y1="55" x2="170" y2="49" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="72" x2="170" y2="83" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="49" x2="340" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="83" x2="340" y2="72" marker-end="url(#arr)"/>
<text class="ts" x="490" y="56" text-anchor="start">两套代码、口径易不一致、</text>
<text class="ts" x="490" y="74" text-anchor="start">维护成本高；批层可兜底校正</text>
<text class="th" x="20" y="134">Kappa：只有流（重放 = 重新消费日志）</text>
<rect class="b1" x="20" y="148" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="173" text-anchor="middle" dominant-baseline="middle">Kafka 日志</text>
<rect class="b2" x="170" y="148" width="130" height="50" rx="8"/>
<text class="tb" x="235" y="173" text-anchor="middle" dominant-baseline="middle">流处理（一套）</text>
<rect class="b5" x="340" y="148" width="130" height="50" rx="8"/>
<text class="tb" x="405" y="173" text-anchor="middle" dominant-baseline="middle">服务层</text>
<line class="l" x1="130" y1="173" x2="170" y2="173" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="173" x2="340" y2="173" marker-end="url(#arr)"/>
<text class="ts" x="490" y="166" text-anchor="start">逻辑只有一份；需要重算时重放全量日志，</text>
<text class="ts" x="490" y="184" text-anchor="start">Kafka 保留全量成本高、重放慢</text>
<text class="th" x="20" y="244">流批一体 + 湖仓（现代主流）</text>
<rect class="b1" x="20" y="258" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="283" text-anchor="middle" dominant-baseline="middle">CDC / 日志</text>
<rect class="b2" x="170" y="258" width="130" height="50" rx="8"/>
<text class="tb" x="235" y="276" text-anchor="middle" dominant-baseline="middle">Flink 流批一体</text>
<text class="ts" x="235" y="296" text-anchor="middle">同一 SQL</text>
<rect class="b5" x="340" y="258" width="150" height="50" rx="8"/>
<text class="tb" x="415" y="276" text-anchor="middle" dominant-baseline="middle">数据湖 Paimon</text>
<text class="ts" x="415" y="296" text-anchor="middle">可更新 · 可回溯</text>
<line class="l" x1="130" y1="283" x2="170" y2="283" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="283" x2="340" y2="283" marker-end="url(#arr)"/>
<text class="ts" x="510" y="276" text-anchor="start">存储统一、同一逻辑跑流/批，</text>
<text class="ts" x="510" y="296" text-anchor="start">近实时 + 可重算 + 可 OLAP</text>
</svg>
<figcaption>图 4：Lambda、Kappa 与湖仓一体的对比</figcaption>
</figure>

| | Lambda | Kappa | 流批一体 + 湖仓 |
| --- | --- | --- | --- |
| 代码 | 两套（批、流） | 一套（流） | 一套 SQL，流批共用 |
| 一致性 | 口径易不一致，需对账 | 较好 | 好 |
| 重算 | 批层重算简单 | 重放日志（成本高） | 湖仓上直接批重算 |
| 延迟 | 批慢、流快 | 流 | 分钟级~秒级 |
| 成本 | 高（两套集群、两套维护） | Kafka 长期保留成本 | 中，依赖湖格式成熟度 |
| 适用 | 存量体系、强校正需求 | 日志类、重放需求少 | 新建数仓、需要更新与查询 |

## 实时数仓的落地要点

1. **先明确实时性要求**：秒级？分钟级？很多“实时”需求**分钟级微批**就足够，成本和复杂度低得多；
2. **指标口径统一**：实时与离线用同一**指标定义**，避免“大屏数字和报表对不上”；
3. **对账机制**：实时结果与离线 T+1 结果自动对比，超阈值告警并修正；
4. **幂等与可重跑**：作业可从任意位点重启，Sink 幂等（主键 upsert），见 [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state)；
5. **回溯能力**：保留足够的 CDC/日志（Kafka 保留期、湖仓快照），以便修 Bug 后重算；
6. **Schema 演进**：源表加列、改类型的自动适配；Schema Registry/Pipeline 同步；
7. **监控**：端到端延迟（业务时间 vs 当前）、Checkpoint、Lag、对账差异、数据量突变；
8. **成本**：状态大小、集群资源、湖存储 compaction；按重要度分级保障（核心指标高保障、次要指标降级）。

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| CDC 作业停机后无法恢复 | binlog 已被清理 → 延长保留期；监控位点；必要时重做全量 |
| 全量快照把源库打慢 | 并行度过高、分片过小、读主库 → 限速、降并行、读从库、错峰 |
| 下游数据重复/回撤异常 | Sink 非幂等、缺主键 → upsert 主键、理解 Changelog |
| 删除数据没有同步 | 使用了时间戳增量而非日志 CDC |
| 订单状态更新乱序（旧更新覆盖新） | 多个并行 Sink 乱序写入同主键 → 按主键分区保序、版本号/更新时间比较后写入 |
| 实时与离线结果对不上 | 口径不同、迟到数据处理差异、维度时效差异 → 统一口径、对账与修正 |
| 主从切换后位点失效 | 未使用 GTID → 开启 GTID，或切换后重新定位 |
| 无主键表同步困难 | 需指定分片列或增加主键；无主键意味着下游更新/删除无法定位 |

## 相关阅读

- [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)：Connect 与 CDC 连接器的运维

## 面试追问

> [!QUESTION] CDC 有哪几种实现方式？为什么基于日志的最好？
> 全量/时间戳增量查询、触发器、双写、日志解析。基于 binlog 或 WAL 的方式对业务无侵入、延迟低、能捕获删除、保序且不依赖业务字段，对源库压力小，所以最常用。

> [!QUESTION] Flink CDC 如何保证全量与增量的一致性衔接？
> 使用增量快照算法：按主键把表切成 Chunk 并行读取，每个 Chunk 读前后记录 binlog 低/高水位，用水位区间内的 binlog 修正快照数据得到一致结果，全部 Chunk 完成后切换到 binlog 增量读取，过程无需全局锁，进度保存在 Checkpoint 中可断点续传。

> [!QUESTION] 实时数仓怎么分层？为什么要分层？
> 分 ODS、DWD、DWS、ADS，辅以 DIM。分层使数据职责清晰、复用加工结果、降低重复计算与耦合、便于排查与回溯，也便于对不同层设置不同的存储与保障等级。

> [!QUESTION] Lambda 和 Kappa 架构的区别？现在怎么选？
> Lambda 同时维护批和流两套链路，批层校正但代码与口径重复；Kappa 只保留流，重算靠重放日志，成本和速度受限。现代做法倾向流批一体加数据湖，同一份逻辑与存储既能近实时又能重算。

> [!QUESTION] 实时数仓里的维度关联怎么做？
> 小维表广播；外部维表用 Lookup Join 并加缓存；需要历史版本用 Temporal Join；也可以把维表通过 CDC 引入 Flink 状态做流流关联。要关注缓存一致性、维度更新延迟和外部库压力。
