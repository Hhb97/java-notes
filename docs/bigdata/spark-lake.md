---
level: 深入
tags: [Spark, Hadoop, HDFS, Hive, 数据湖, Iceberg, Paimon, Hudi, 湖仓一体, 离线数仓]
summary: 讲清 Hadoop/Spark 离线大数据体系的执行模型（RDD/DAG/Shuffle、Catalyst、AQE、数据倾斜），离线数仓建模与调度，以及数据湖表格式 Iceberg/Paimon/Hudi 的元数据结构、事务与更新机制和湖仓一体的选型。
---

# Spark 与数据湖（Iceberg / Paimon）

> [!ABSTRACT] 核心要点
> - **离线批处理**主力是 **Spark**（内存迭代、DAG 调度），数据存放在 **HDFS/对象存储**，元数据由 **Hive Metastore** 管理，调度用 **Airflow/DolphinScheduler**；性能核心是**减少 Shuffle、处理数据倾斜、合理分区与文件大小**。
> - Spark 执行模型：**Transformation 惰性构建 DAG → Action 触发 Job → 按 Shuffle（宽依赖）切分 Stage → Stage 内多个 Task 并行**；**Catalyst** 优化 SQL，**AQE** 在运行时动态调整（合并小分区、转换 Join、拆分倾斜）。
> - **数据湖表格式（Iceberg / Hudi / Delta / Paimon）** 在对象存储上提供**事务（ACID）、快照隔离、Schema 演进、时间旅行、行级更新删除**，解决了“Hive 表不能更新、小文件多、读写互相影响”的老问题。
> - **Iceberg**：元数据三层树（metadata.json → manifest list → manifest → 数据文件），**引擎中立**、隐藏分区，适合通用湖仓；**Paimon**：基于 **LSM** 的**流式湖仓**，擅长**高频更新（CDC）与流读**；**Hudi**：COW/MOR，增量拉取成熟。
> - 趋势：**湖仓一体**——统一存储在湖上，Flink 流写入、Spark/Trino/Doris 批读与交互查询，减少数据副本与双链路，见 [CDC 与实时数仓架构](#/bigdata/cdc)。

## Hadoop 生态速览

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="离线大数据体系：存储 HDFS 或对象存储、资源调度 YARN 或 Kubernetes、计算引擎 Spark 和 Hive、元数据 Hive Metastore、调度 Airflow">
<rect class="b" x="20" y="20" width="720" height="50" rx="10"/>
<text class="tb" x="380" y="45" text-anchor="middle" dominant-baseline="middle">应用层：BI 报表 · 数据服务 · 机器学习 · 数据产品</text>
<rect class="b1" x="20" y="90" width="230" height="70" rx="10"/>
<text class="tb" x="135" y="112" text-anchor="middle" dominant-baseline="middle">计算引擎</text>
<text class="ts" x="135" y="134" text-anchor="middle">Spark · Hive · Flink（批）· Trino</text>
<rect class="b3" x="270" y="90" width="230" height="70" rx="10"/>
<text class="tb" x="385" y="112" text-anchor="middle" dominant-baseline="middle">元数据与治理</text>
<text class="ts" x="385" y="134" text-anchor="middle">Hive Metastore · 数据血缘 · 权限</text>
<rect class="b5" x="520" y="90" width="220" height="70" rx="10"/>
<text class="tb" x="630" y="112" text-anchor="middle" dominant-baseline="middle">调度与编排</text>
<text class="ts" x="630" y="134" text-anchor="middle">Airflow · DolphinScheduler</text>
<rect class="b2" x="20" y="180" width="350" height="60" rx="10"/>
<text class="tb" x="195" y="202" text-anchor="middle" dominant-baseline="middle">资源管理</text>
<text class="ts" x="195" y="222" text-anchor="middle">YARN（传统） · Kubernetes（云原生）</text>
<rect class="b4" x="390" y="180" width="350" height="60" rx="10"/>
<text class="tb" x="565" y="202" text-anchor="middle" dominant-baseline="middle">存储</text>
<text class="ts" x="565" y="222" text-anchor="middle">HDFS（NameNode + DataNode）· 对象存储 S3/OSS</text>
<rect class="bg" x="20" y="260" width="720" height="56" rx="10"/>
<text class="ts" x="380" y="282" text-anchor="middle">文件格式：Parquet / ORC（列存、压缩、谓词下推）· 表格式：Hive 分区表 → Iceberg / Paimon / Hudi（事务与更新）</text>
<text class="ts" x="380" y="302" text-anchor="middle">趋势：存算分离（计算弹性伸缩，数据放对象存储）、湖仓一体</text>
</svg>
<figcaption>图 1：离线大数据平台的分层</figcaption>
</figure>

- **HDFS**：NameNode 管理文件元数据（单点需 HA），DataNode 存数据块（默认 128MB，三副本）；**不适合海量小文件**（元数据撑爆 NameNode 内存）；
- **YARN**：资源管理与调度（ResourceManager + NodeManager）；云原生趋势是 **Kubernetes** 与**对象存储**（存算分离，计算按需起停）；
- **Hive**：SQL on Hadoop，**Hive Metastore（HMS）** 保存库表元数据，已成为各引擎共用的元数据事实标准；Hive 引擎本身（MapReduce/Tez）逐渐被 Spark 取代；
- **文件格式**：**Parquet / ORC** 列存，支持压缩与**谓词下推、列裁剪**，优于文本/CSV/JSON。

## Spark 核心

### 执行模型

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Spark 作业执行：Transformation 构成 DAG，遇到宽依赖划分 Stage，每个 Stage 并行执行多个 Task">
<rect class="b1" x="20" y="30" width="170" height="60" rx="8"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">Stage 0</text>
<text class="ts" x="105" y="72" text-anchor="middle">read → filter → map</text>
<rect class="b1" x="20" y="110" width="170" height="60" rx="8"/>
<text class="tb" x="105" y="132" text-anchor="middle" dominant-baseline="middle">Stage 1</text>
<text class="ts" x="105" y="152" text-anchor="middle">read → map</text>
<rect class="b3" x="290" y="60" width="180" height="80" rx="8"/>
<text class="tb" x="380" y="82" text-anchor="middle" dominant-baseline="middle">Stage 2</text>
<text class="ts" x="380" y="104" text-anchor="middle">join / groupBy 聚合</text>
<text class="ts" x="380" y="122" text-anchor="middle">（读上游 Shuffle 数据）</text>
<rect class="b2" x="570" y="60" width="170" height="80" rx="8"/>
<text class="tb" x="655" y="82" text-anchor="middle" dominant-baseline="middle">Stage 3</text>
<text class="ts" x="655" y="104" text-anchor="middle">sort → write</text>
<line class="la" x1="190" y1="60" x2="290" y2="85" marker-end="url(#arr-a)"/>
<line class="la" x1="190" y1="140" x2="290" y2="115" marker-end="url(#arr-a)"/>
<line class="la" x1="470" y1="100" x2="570" y2="100" marker-end="url(#arr-a)"/>
<text class="ta" x="240" y="170" text-anchor="middle">Shuffle</text>
<text class="ta" x="520" y="124" text-anchor="middle">Shuffle</text>
<rect class="bg" x="20" y="200" width="720" height="110" rx="10"/>
<text class="th" x="36" y="224">层次关系</text>
<text class="ts" x="36" y="248">Application → Job（每个 Action 一个）→ Stage（按宽依赖/Shuffle 切分）→ Task（一个分区一个，是调度的最小单位）</text>
<text class="ts" x="36" y="270">窄依赖（map/filter）：分区间一对一，管道化在同一 Stage 内；宽依赖（groupBy/join/repartition）：需要 Shuffle，产生 Stage 边界</text>
<text class="ts" x="36" y="292">Shuffle = 上游 Stage 把数据按 key 写到本地磁盘（Map 端），下游 Stage 通过网络拉取（Reduce 端）——磁盘 + 网络，是最大性能开销</text>
</svg>
<figcaption>图 2：宽依赖（Shuffle）把作业切分成多个 Stage</figcaption>
</figure>

| 概念 | 说明 |
| --- | --- |
| **RDD** | 弹性分布式数据集：不可变、分区、有血统（Lineage）可重算；底层抽象 |
| **DataFrame / Dataset** | 带 Schema 的结构化数据，**经 Catalyst 优化**，现代开发首选 |
| **Transformation** | 惰性：`map/filter/join/groupBy`，只构建执行计划 |
| **Action** | 触发执行：`count/collect/write/show` |
| **Driver / Executor** | Driver 负责调度与协调；Executor 进程执行 Task、缓存数据 |
| 部署 | Standalone / YARN / **Kubernetes**；`spark-submit` 提交 |

### Catalyst 与 Tungsten

- **Catalyst** 优化器：逻辑计划 → 规则优化（**谓词下推、列裁剪、常量折叠、Join 重排**）→ 物理计划（选择 Join 策略）→ 代码生成；
- **Tungsten**：堆外内存管理、缓存友好的二进制格式、**全阶段代码生成（Whole-Stage CodeGen）**，减少虚函数与对象开销；
- **AQE（Adaptive Query Execution，Spark 3.x）**：根据**运行时统计**动态调整：
  - **合并小分区**（Shuffle 后分区过碎）；
  - **动态切换 Join 策略**（发现一侧很小时转为 Broadcast Join）；
  - **动态处理倾斜 Join**（把倾斜分区拆成多个 Task）。

### Join 策略

| 策略 | 条件 | 说明 |
| --- | --- | --- |
| **Broadcast Hash Join** | 一侧足够小（`autoBroadcastJoinThreshold`，默认 10MB） | 小表广播到所有 Executor，**无 Shuffle**，最快 |
| **Shuffle Hash Join** | 一侧较小，但不可广播 | 双方按 key Shuffle，小侧建哈希表 |
| **Sort Merge Join** | 大表对大表（默认） | 双方 Shuffle + 排序后归并，稳定但开销大 |
| Broadcast Nested Loop / Cartesian | 非等值 Join | 代价高，谨慎 |

提示：`/*+ BROADCAST(dim) */` 强制广播；`/*+ SHUFFLE_HASH(...) */`、`MERGE`。

### 数据倾斜与调优

**识别**：Spark UI 的 Stage 页面，Task 耗时/Shuffle 读量**极不均衡**（少数 Task 远大于中位数），或个别 Task OOM。

| 问题 | 对策 |
| --- | --- |
| **Join 倾斜（热点 key）** | AQE 倾斜处理；**加盐扩容**（大表热点 key 加随机后缀，小表对应复制扩容）；热点 key 单独处理再 union；广播小表 |
| **聚合倾斜** | 两阶段聚合（加盐局部聚合 + 去盐全局聚合）；`COUNT DISTINCT` 拆分 |
| **空值/默认值 key** | 过滤或打散（`NULL` 会全部落到同一分区） |
| **分区数不合理** | `spark.sql.shuffle.partitions`（默认 200）按数据量调整，或交给 AQE 自动合并；目标每个 Task 处理约 **100~200MB** |
| **小文件过多** | 写入前 `coalesce/repartition`；AQE 合并；定期 compaction（湖表自带） |
| **内存不足** | 增大 Executor 内存/堆外；减少单分区数据；避免 `collect` 大数据到 Driver；谨慎缓存 |
| **序列化** | 使用 **Kryo**（`spark.serializer`）；DataFrame 优于 RDD |
| 缓存 | 重复使用的中间结果 `cache()/persist()`，用完 `unpersist()` |
| 并行度与资源 | `executor-cores`（3~5 较均衡）、`executor-memory`、`num-executors` / 动态资源分配 |

```scala
// 示例：AQE 与倾斜相关配置
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
```

```java
// Java 使用 Spark SQL
SparkSession spark = SparkSession.builder().appName("dws-order").enableHiveSupport().getOrCreate();
Dataset<Row> daily = spark.sql("""
    SELECT shop_id, to_date(pay_time) AS dt, SUM(amount) AS gmv, COUNT(*) AS cnt
    FROM dwd.order_detail WHERE dt = '2026-01-01' GROUP BY shop_id, to_date(pay_time)""");
daily.write().mode(SaveMode.Overwrite).format("parquet").insertInto("dws.shop_gmv_daily");   // 幂等：覆盖分区
```

## 离线数仓建模与调度

| 主题 | 要点 |
| --- | --- |
| **分层** | ODS → DWD → DWS → ADS（同实时数仓），按**主题域**组织 |
| **维度建模** | **事实表**（订单、支付，粒度明确）+ **维度表**（用户、商品、时间）；**星型模型**为主 |
| 事实表类型 | 事务事实表、周期快照、累积快照 |
| **缓慢变化维（SCD）** | Type 1 覆盖；**Type 2 拉链表**（保留历史，`start_date/end_date`）；Type 3 增列 |
| 增量与全量 | 按分区增量加载；**CDC 日志合并成最新快照**（用主键 + 版本取最新） |
| **幂等与可重跑** | 每个任务按**分区覆盖写（`INSERT OVERWRITE`）**，同一天重跑结果一致 |
| 依赖调度 | DAG 编排，上游完成触发下游；失败重试、告警、补数据（backfill） |
| 数据质量 | 行数波动、主键唯一、非空、枚举合法、对账；**质量不通过则阻断下游** |
| 指标口径 | 统一在指标层定义，避免各报表自行计算 |

```text
# Airflow DAG 示意
ods_order_sync  →  dwd_order_detail  →  dws_shop_gmv_daily  →  ads_dashboard
                          ↘ dim_user_zipper ↗                      ↘ 对账任务 → 告警
```

## 为什么需要数据湖表格式

传统 **Hive 分区表**（Parquet 文件 + 目录约定）的局限：

| 问题 | 表现 |
| --- | --- |
| 没有事务 | 写入过程中失败留下半成品文件；读写并发时读到不一致数据 |
| 不支持行级更新/删除 | 只能整分区覆盖；CDC 同步要“读全分区、合并、回写” |
| 元数据靠目录与 HMS 同步 | **列举大量文件很慢**（对象存储 list 开销大）；分区过多压垮 HMS |
| Schema 变更困难 | 改列需要重写数据，易出错 |
| 小文件问题 | 流式写入产生海量小文件，查询慢 |
| 无历史版本 | 无法回溯、无法审计 |

**表格式**用一层**元数据 + 快照**解决：把“表 = 哪些文件的集合”这件事**显式记录在元数据**中，通过**原子提交元数据**实现事务。

## Iceberg

### 元数据结构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Iceberg 元数据层次：catalog 指向 metadata.json，metadata.json 指向快照对应的 manifest list，manifest list 指向 manifest 文件，manifest 指向数据文件">
<rect class="b" x="20" y="20" width="120" height="50" rx="8"/>
<text class="tb" x="80" y="45" text-anchor="middle" dominant-baseline="middle">Catalog</text>
<text class="ts" x="80" y="82" text-anchor="middle">HMS/REST/Glue</text>
<rect class="b3" x="190" y="20" width="170" height="50" rx="8"/>
<text class="tb" x="275" y="38" text-anchor="middle" dominant-baseline="middle">metadata.json</text>
<text class="ts" x="275" y="58" text-anchor="middle">Schema·分区·快照列表</text>
<line class="l" x1="140" y1="45" x2="190" y2="45" marker-end="url(#arr)"/>
<text class="ts" x="165" y="36" text-anchor="middle">指针</text>
<rect class="b1" x="190" y="120" width="170" height="50" rx="8"/>
<text class="tb" x="275" y="138" text-anchor="middle" dominant-baseline="middle">Manifest List</text>
<text class="ts" x="275" y="158" text-anchor="middle">某个快照的 manifest 清单</text>
<line class="l" x1="275" y1="70" x2="275" y2="120" marker-end="url(#arr)"/>
<rect class="b1" x="90" y="220" width="140" height="50" rx="8"/>
<text class="tb" x="160" y="238" text-anchor="middle" dominant-baseline="middle">Manifest 1</text>
<text class="ts" x="160" y="258" text-anchor="middle">文件路径+列统计</text>
<rect class="b1" x="250" y="220" width="140" height="50" rx="8"/>
<text class="tb" x="320" y="238" text-anchor="middle" dominant-baseline="middle">Manifest 2</text>
<text class="ts" x="320" y="258" text-anchor="middle">文件路径+列统计</text>
<line class="l" x1="250" y1="170" x2="160" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="170" x2="320" y2="220" marker-end="url(#arr)"/>
<rect class="b2" x="60" y="310" width="90" height="36" rx="6"/>
<text class="tm" x="105" y="328" text-anchor="middle" dominant-baseline="middle">data-1.parquet</text>
<rect class="b2" x="160" y="310" width="90" height="36" rx="6"/>
<text class="tm" x="205" y="328" text-anchor="middle" dominant-baseline="middle">data-2.parquet</text>
<rect class="b2" x="260" y="310" width="90" height="36" rx="6"/>
<text class="tm" x="305" y="328" text-anchor="middle" dominant-baseline="middle">data-3.parquet</text>
<line class="l" x1="130" y1="270" x2="105" y2="310" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="270" x2="205" y2="310" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="270" x2="305" y2="310" marker-end="url(#arr)"/>
<rect class="bg" x="430" y="20" width="310" height="326" rx="12"/>
<text class="th" x="446" y="44">提交与读取</text>
<text class="ts" x="446" y="72">写入：生成新数据文件 → 新 manifest →</text>
<text class="ts" x="446" y="92">新 manifest list → 新 metadata.json</text>
<text class="ts" x="446" y="112">→ <tspan class="ta">原子替换 catalog 中的指针</tspan>（乐观并发 CAS）</text>
<text class="ts" x="446" y="144">读取：从指针读 metadata.json → 取当前快照</text>
<text class="ts" x="446" y="164">→ 读 manifest，用<tspan class="ta">列统计（min/max）裁剪文件</tspan></text>
<text class="ts" x="446" y="184">→ 只读需要的数据文件（不需要 list 目录）</text>
<text class="ts" x="446" y="216">快照隔离：读者始终基于一个完整快照，</text>
<text class="ts" x="446" y="236">写入提交前对读者不可见；冲突时重试</text>
<text class="ts" x="446" y="268">时间旅行：按快照 ID/时间读取历史版本</text>
<text class="ts" x="446" y="288">回滚：把指针指回旧快照</text>
<text class="ts" x="446" y="320">更新/删除：写 delete 文件（位置/等值删除）</text>
<text class="ts" x="446" y="338">或重写数据文件（COW）</text>
</svg>
<figcaption>图 3：Iceberg 的元数据树与原子提交</figcaption>
</figure>

特性：

- **ACID + 快照隔离**：通过**原子切换元数据指针**实现，对象存储上无需分布式锁（依赖 catalog 的原子操作）；
- **隐藏分区**：用户按原始列（如 `ts`）查询，Iceberg 自动按 `days(ts)` 等**转换函数**裁剪分区，不需要在 SQL 里写分区列；**分区演进**不需重写旧数据；
- **Schema 演进**：增/删/改名/调序列，列按 **ID** 追踪，安全；
- **时间旅行/回滚**：`SELECT * FROM t FOR TIMESTAMP AS OF '...'`；
- **行级更新**：Merge-on-Read（写 delete 文件，读时合并）与 Copy-on-Write（重写文件）两种策略；
- **引擎中立**：Spark、Flink、Trino、Hive、Doris/StarRocks 均可读写，**避免厂商绑定**；
- 维护：**合并小文件（rewrite_data_files）、过期快照（expire_snapshots）、清理孤儿文件**，否则元数据与小文件持续膨胀。

```sql
-- Spark SQL on Iceberg
CREATE TABLE lake.dwd.order_detail (
  order_id BIGINT, shop_id INT, amount DECIMAL(12,2), pay_time TIMESTAMP
) USING iceberg
PARTITIONED BY (days(pay_time), bucket(16, shop_id));             -- 隐藏分区 + 分桶

MERGE INTO lake.dwd.order_detail t USING updates s ON t.order_id = s.order_id
WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *;    -- 行级更新

CALL lake.system.rewrite_data_files(table => 'dwd.order_detail');  -- 合并小文件
CALL lake.system.expire_snapshots('dwd.order_detail', TIMESTAMP '2026-01-01 00:00:00');
```

## Paimon：流式湖仓

**Apache Paimon**（源自 Flink Table Store）为**流式更新**设计，基于 **LSM-Tree** 组织数据文件：

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Paimon 基于 LSM：Flink 流写入先写内存缓冲再刷出为 Level 0 文件，后台 compaction 合并到更高层，读取时按主键合并各层得到最新值">
<rect class="b2" x="20" y="100" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="122" text-anchor="middle" dominant-baseline="middle">Flink 流写入</text>
<text class="ts" x="75" y="142" text-anchor="middle">+I -U +U -D</text>
<rect class="b3" x="170" y="100" width="130" height="60" rx="8"/>
<text class="tb" x="235" y="122" text-anchor="middle" dominant-baseline="middle">内存缓冲</text>
<text class="ts" x="235" y="142" text-anchor="middle">按主键排序</text>
<rect class="b1" x="340" y="30" width="170" height="44" rx="6"/>
<text class="tb" x="425" y="52" text-anchor="middle" dominant-baseline="middle">Level 0（小文件，可重叠）</text>
<rect class="b1" x="340" y="104" width="170" height="44" rx="6"/>
<text class="tb" x="425" y="126" text-anchor="middle" dominant-baseline="middle">Level 1…（有序合并）</text>
<rect class="b1" x="340" y="178" width="170" height="44" rx="6"/>
<text class="tb" x="425" y="200" text-anchor="middle" dominant-baseline="middle">最高层（大文件）</text>
<line class="l" x1="130" y1="130" x2="170" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="120" x2="340" y2="56" marker-end="url(#arr)"/>
<line class="la" x1="425" y1="74" x2="425" y2="104" marker-end="url(#arr-a)"/>
<line class="la" x1="425" y1="148" x2="425" y2="178" marker-end="url(#arr-a)"/>
<text class="ta" x="440" y="94" text-anchor="start">Compaction</text>
<rect class="bg" x="550" y="30" width="170" height="192" rx="10"/>
<text class="th" x="635" y="54" text-anchor="middle">读取</text>
<text class="ts" x="635" y="80" text-anchor="middle">按主键合并各层数据</text>
<text class="ts" x="635" y="100" text-anchor="middle">（merge engine：</text>
<text class="ts" x="635" y="120" text-anchor="middle">deduplicate / partial-update</text>
<text class="ts" x="635" y="140" text-anchor="middle">/ aggregation）</text>
<text class="ts" x="635" y="170" text-anchor="middle">得到每个主键的最新值</text>
<text class="ts" x="635" y="198" text-anchor="middle">流读：产出 Changelog</text>
<text class="ts" x="370" y="258" text-anchor="middle">擅长：高频 CDC 更新、主键 upsert、部分列更新、流式读取下游（把湖表当成“带存储的消息队列”）</text>
</svg>
<figcaption>图 4：Paimon 的 LSM 结构：流式写入 + 后台合并 + 主键合并读取</figcaption>
</figure>

- **主键表**：数据按主键 + bucket 组织，**写入吞吐高**（顺序写小文件，后台 compaction）；
- **Merge Engine**：相同主键如何合并——`deduplicate`（保留最新）、`partial-update`（**多流拼宽表，各自更新部分列**）、`aggregation`（聚合）、`first-row`；
- **Changelog Producer**：生成 `+I/-U/+U/-D` 变更日志（`input`、`lookup`、`full-compaction`），供**下游流式消费**，使湖表可以像 Kafka 一样被 Flink 增量读取，**减少对 Kafka 的依赖**；
- 与 Flink 深度集成（Checkpoint 提交快照，Exactly-Once），也可被 Spark/Hive/Trino/StarRocks 查询；
- **同样有快照、时间旅行、Schema 演进**。

```sql
-- Flink SQL：创建 Paimon 主键表并写入 CDC 数据
CREATE TABLE paimon.dw.orders (
  id BIGINT, user_id BIGINT, amount DECIMAL(12,2), status STRING, update_time TIMESTAMP(3),
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'bucket' = '8', 'merge-engine' = 'deduplicate',
  'changelog-producer' = 'lookup',                   -- 产生变更日志，供下游流读
  'snapshot.time-retained' = '1 d'
);
INSERT INTO paimon.dw.orders SELECT * FROM mysql_cdc_orders;      -- Flink CDC 入湖

-- 下游流式读取增量变更，继续加工为 DWS
SELECT shop_id, SUM(amount) FROM paimon.dw.orders /*+ OPTIONS('scan.mode'='latest') */ GROUP BY shop_id;
```

（表选项名随版本调整，以 Paimon 文档为准。）

## Hudi 与 Delta Lake

| | Iceberg | **Paimon** | Hudi | Delta Lake |
| --- | --- | --- | --- | --- |
| 设计重心 | 通用大表、引擎中立、元数据可扩展 | **流式更新、LSM、Flink 原生** | **增量处理**、upsert、CDC 摄入 | Spark 生态、事务日志 |
| 更新策略 | COW / MOR（delete files） | LSM + compaction | **COW / MOR** | COW + deletion vectors |
| 元数据 | metadata.json + manifest 树 | snapshot + manifest + LSM 层 | 时间线（Timeline）+ 元数据表 | `_delta_log` JSON/Parquet 日志 |
| 引擎支持 | **最广**（Spark/Flink/Trino/Hive/Doris/StarRocks…） | Flink 最佳，Spark/Trino/Hive 等 | Spark 最佳，Flink/Presto 等 | Spark 最佳（开放度逐步提升） |
| 擅长 | 批为主的湖仓、多引擎共享 | **高频更新的实时湖仓** | 增量 ETL、近实时 upsert | Databricks / Spark 栈 |

选型建议：

- **多引擎共享、以批和交互查询为主** → **Iceberg**；
- **Flink 为核心、CDC 高频更新、流批一体实时数仓** → **Paimon**（亦可 Iceberg + Flink）；
- **Spark 为核心、近实时增量 upsert** → Hudi；Databricks 体系 → Delta；
- 需要**避免绑定**时优先 Iceberg（生态最广）；无论选哪个，都要**把表维护（合并、过期、清理）纳入运维**。

## 湖仓一体架构

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="湖仓一体：数据源经 Flink CDC 入湖，统一存储在对象存储上的湖表，Spark 批处理、Flink 流处理、Trino 与 OLAP 引擎共同使用">
<rect class="b" x="20" y="30" width="130" height="80" rx="10"/>
<text class="tb" x="85" y="54" text-anchor="middle" dominant-baseline="middle">数据源</text>
<text class="ts" x="85" y="76" text-anchor="middle">业务库 · 日志</text>
<text class="ts" x="85" y="94" text-anchor="middle">埋点 · IoT</text>
<rect class="b2" x="190" y="30" width="150" height="80" rx="10"/>
<text class="tb" x="265" y="54" text-anchor="middle" dominant-baseline="middle">Flink CDC / 流写入</text>
<text class="ts" x="265" y="76" text-anchor="middle">全量+增量</text>
<text class="ts" x="265" y="94" text-anchor="middle">Exactly-Once 提交</text>
<line class="l" x1="150" y1="70" x2="190" y2="70" marker-end="url(#arr)"/>
<rect class="b5" x="380" y="20" width="360" height="150" rx="12"/>
<text class="th" x="560" y="44" text-anchor="middle">数据湖（对象存储 + 湖表格式）</text>
<rect class="b1" x="400" y="58" width="100" height="40" rx="6"/>
<text class="tb" x="450" y="78" text-anchor="middle" dominant-baseline="middle">ODS</text>
<rect class="b1" x="510" y="58" width="100" height="40" rx="6"/>
<text class="tb" x="560" y="78" text-anchor="middle" dominant-baseline="middle">DWD</text>
<rect class="b1" x="620" y="58" width="100" height="40" rx="6"/>
<text class="tb" x="670" y="78" text-anchor="middle" dominant-baseline="middle">DWS</text>
<text class="ts" x="560" y="124" text-anchor="middle">一份数据：事务 · 快照 · 时间旅行 · Schema 演进</text>
<text class="ts" x="560" y="146" text-anchor="middle">存储成本低、可无限扩展、与计算解耦</text>
<line class="l" x1="340" y1="70" x2="380" y2="70" marker-end="url(#arr)"/>
<rect class="b3" x="20" y="200" width="160" height="70" rx="10"/>
<text class="tb" x="100" y="224" text-anchor="middle" dominant-baseline="middle">Spark 批处理</text>
<text class="ts" x="100" y="246" text-anchor="middle">离线加工 · 修数 · 回溯</text>
<rect class="b3" x="200" y="200" width="160" height="70" rx="10"/>
<text class="tb" x="280" y="224" text-anchor="middle" dominant-baseline="middle">Flink 流处理</text>
<text class="ts" x="280" y="246" text-anchor="middle">增量读 · 实时加工</text>
<rect class="b3" x="380" y="200" width="160" height="70" rx="10"/>
<text class="tb" x="460" y="224" text-anchor="middle" dominant-baseline="middle">Trino 交互查询</text>
<text class="ts" x="460" y="246" text-anchor="middle">跨源联邦分析</text>
<rect class="b3" x="560" y="200" width="180" height="70" rx="10"/>
<text class="tb" x="650" y="224" text-anchor="middle" dominant-baseline="middle">Doris / StarRocks</text>
<text class="ts" x="650" y="246" text-anchor="middle">湖表加速查询 · 报表</text>
<line class="l" x1="450" y1="170" x2="100" y2="200"/>
<line class="l" x1="500" y1="170" x2="280" y2="200"/>
<line class="l" x1="560" y1="170" x2="460" y2="200"/>
<line class="l" x1="640" y1="170" x2="650" y2="200"/>
<text class="ts" x="380" y="304" text-anchor="middle">元数据：Hive Metastore / Iceberg REST / Paimon Catalog 统一管理；权限、血缘、数据质量在治理层统一</text>
</svg>
<figcaption>图 5：湖仓一体：统一存储，多引擎共享</figcaption>
</figure>

好处：**一份数据**、减少 Lambda 双链路与数据搬运；**存算分离**，计算弹性；**事务与更新**能力使数据湖也能做数仓分层；成本低。

挑战：

- **表维护**（compaction、快照过期、孤儿文件清理）要自动化；
- **小文件与元数据膨胀**：高频流写入需合理的 checkpoint 间隔与 compaction；
- **查询性能**：与专用 OLAP 引擎仍有差距，需要**缓存/物化/湖上加速**；
- 治理、权限、数据质量在多引擎下的统一；
- 对象存储的**一致性/延迟**特性（现代对象存储已强一致，但 list/rename 语义仍与 HDFS 不同）。

## 选型小结

| 需求 | 方案 |
| --- | --- |
| 离线批处理、SQL 加工 | **Spark SQL** + Hive Metastore + 调度系统 |
| 湖上可更新、事务、多引擎 | **Iceberg** |
| Flink CDC 高频更新、实时湖仓 | **Paimon**（或 Iceberg） |
| 实时分析报表、高并发查询 | 湖/仓同步到 **Doris/StarRocks**，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |
| 跨源即席查询 | Trino/Presto 查询湖表 |
| 交互式探索 + 小数据 | DuckDB / PG |

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| Spark 作业某个 Task 极慢或 OOM | 数据倾斜 → AQE、加盐、广播、过滤空 key |
| Shuffle 分区数不合适 | 默认 200 过大或过小 → 按数据量设置或依赖 AQE |
| 写出大量小文件 | 分区过细、并行度高 → `coalesce`、AQE、湖表 compaction |
| 读取湖表越来越慢 | 小文件与快照过多 → compaction、过期快照、清理孤儿文件 |
| 并发写同一湖表冲突 | 乐观并发提交冲突重试 → 按分区拆分写入、控制并发 |
| 离线任务重跑数据重复 | 非幂等写入 → `INSERT OVERWRITE` 分区覆盖或主键 upsert |
| HMS 压力大/分区过多 | 分区粒度过细 → 合理分区、用 Iceberg 隐藏分区与元数据层裁剪 |
| 小表 Join 仍很慢 | 没有触发广播 → 提高阈值或 hint |

## 面试追问

> [!QUESTION] Spark 的执行流程是怎样的？什么是宽依赖和窄依赖？
> Transformation 惰性构建 DAG，Action 触发 Job；DAG 按宽依赖（需要 Shuffle 的操作）切分成 Stage，每个 Stage 按分区拆成并行 Task。窄依赖分区间一对一，可管道化在同一 Stage；宽依赖需要跨分区重分发，是主要开销。

> [!QUESTION] Spark 数据倾斜怎么处理？
> 先在 Spark UI 找到耗时极不均的 Task。Join 倾斜可用 AQE 自动拆分、热点 key 加盐扩容、广播小表、单独处理热点；聚合倾斜用两阶段聚合；空值 key 过滤或打散；同时调整 Shuffle 分区数与资源。

> [!QUESTION] 数据湖表格式解决了什么问题？Iceberg 的原理？
> 解决 Hive 表无事务、不支持行级更新、元数据靠目录列举、Schema 演进困难、小文件与无历史版本等问题。Iceberg 用元数据树（metadata.json、manifest list、manifest、数据文件）记录表由哪些文件组成，提交时原子切换元数据指针实现快照隔离，并用列统计裁剪文件。

> [!QUESTION] Iceberg、Paimon、Hudi 怎么选？
> Iceberg 引擎生态最广、适合多引擎共享和批为主；Paimon 基于 LSM、与 Flink 深度集成、擅长高频 CDC 更新和流式读取；Hudi 偏近实时增量 upsert，Spark 生态成熟。Flink 实时湖仓优先 Paimon，需要避免绑定优先 Iceberg。

> [!QUESTION] 湖仓一体相比 Lambda 的好处和挑战？
> 好处是一份数据、一套逻辑跑流批，减少数据搬运和口径不一致，存算分离降低成本；挑战是表维护（合并小文件、过期快照）、查询性能与专用 OLAP 的差距，以及多引擎下的治理与权限统一。
