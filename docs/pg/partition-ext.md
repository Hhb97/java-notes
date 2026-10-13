---
level: 深入
tags: [PostgreSQL, 分区表, 分区裁剪, 分区维护, pg_partman, 扩展, pgvector, PostGIS, TimescaleDB, Citus, FDW, pg_stat_statements, pg_trgm]
summary: PostgreSQL 声明式分区与扩展生态深入：分区方式与选型、分区键与唯一约束限制、计划期与执行期分区裁剪、分区索引与分区间连接/聚合、在线维护（ATTACH/DETACH CONCURRENTLY、默认分区、自动建分区 pg_partman）、历史数据治理；扩展机制与常用扩展（pg_stat_statements、auto_explain、pg_trgm、pgvector 向量检索、PostGIS、TimescaleDB、Citus、FDW、pg_cron），选型与升级风险。
---

# PostgreSQL 分区与扩展生态：分区治理、向量检索与时序

> [!ABSTRACT] 核心要点
> - **分区表的价值不在“查询变快”，而在“可管理性”**：**批量删除/归档历史数据（`DROP/DETACH` 分区秒级完成，无 DELETE 的膨胀与 WAL）**、**把大表的 VACUUM/索引/备份拆小**、**冷热数据分层存储**。查询受益主要来自**分区裁剪**（只扫相关分区），且前提是**查询条件直接作用于分区键**。
> - **声明式分区**（PG10+）支持 **RANGE / LIST / HASH**；多级分区可组合。**限制要牢记**：**主键/唯一约束必须包含分区键**（无全局唯一索引）、**外键引用分区表受限（PG12+ 支持分区表作被引用方，但需包含分区键）**、**没有跨分区的全局索引**、**分区过多会增加规划时间与锁开销**（几百~一两千通常可接受，上万要小心）。
> - **分区裁剪分两类**：**计划期**（条件为常量，规划时就排除分区）与**执行期**（参数化查询、子查询、嵌套循环的值，运行时排除，EXPLAIN 显示 `Subplans Removed`）。**对分区键套函数/类型不一致会让裁剪失效**，是最常见的“分区了却没变快”原因。
> - **在线维护靠这几个操作**：新建分区**先建独立表并加匹配的 CHECK 约束，再 `ATTACH PARTITION`**（可跳过全表校验）；`DETACH PARTITION CONCURRENTLY`（PG14+）不阻塞；**默认分区（DEFAULT）**兜底未覆盖的数据，但会拖慢 ATTACH 与带来“误落入”风险。**自动化**（预建未来分区、清理过期分区）用 **pg_partman** 或自研任务，并监控“缺分区导致写入失败”。
> - **扩展（Extension）是 PG 的杀手锏**：**`pg_stat_statements`（SQL 统计）、`auto_explain`、`pg_trgm`（模糊/相似搜索）、`pgvector`（向量检索，AI 应用）、`PostGIS`（地理空间）、`TimescaleDB`（时序）、`Citus`（分布式）、`postgres_fdw`（联邦查询）、`pg_cron`（定时任务）**。选型要评估：**成熟度、许可证、云厂商支持、升级兼容、对高可用/备份的影响**。

## 声明式分区

### 分区方式与选型

| 方式 | 定义 | 典型场景 | 注意 |
| --- | --- | --- | --- |
| **RANGE** | 按范围（时间、ID 区间）：`FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')` | **时间序列/日志/订单按月**：滚动删除旧分区 | 区间不重叠；最新分区是写入热点；预建未来分区 |
| **LIST** | 按离散值：`FOR VALUES IN ('CN','US')` | 按地区/租户/类型 | 值要预先枚举；DEFAULT 分区兜底 |
| **HASH** | `FOR VALUES WITH (MODULUS 8, REMAINDER 0)` | 无自然范围、想把数据/锁/维护均匀打散 | 无法按范围裁剪（只能等值裁剪）；增减分区数要重新分布（需要数据搬迁） |
| **多级分区** | 子分区再分区（如先按月 RANGE，再按租户 HASH） | 超大表，多维度管理 | 复杂度与分区数相乘，谨慎 |

```sql
CREATE TABLE orders (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    user_id     bigint NOT NULL,
    status      text   NOT NULL,
    created_at  timestamptz NOT NULL,
    amount      numeric(12,2),
    PRIMARY KEY (id, created_at)          -- 主键必须包含分区键
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2024_01 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE orders_2024_02 PARTITION OF orders
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE orders_default PARTITION OF orders DEFAULT;      -- 兜底（谨慎使用）

CREATE INDEX ON orders (user_id, created_at);                 -- 在父表上建索引 → 自动在每个分区创建
```

### 什么时候该分区、什么时候不该

| 适合 | 不适合 |
| --- | --- |
| 表**非常大**（数十 GB~TB 级），且**有明确的时间/范围维度**；需要**滚动删除/归档** | 表不大（几个 GB），单表+合适索引已足够——分区只增加复杂度 |
| 大多数查询**带分区键条件**（可裁剪） | 查询多数**不带分区键**（要扫全部分区，更慢） |
| 需要把 **VACUUM/备份/索引重建**拆小以降低运维风险 | 需要**全局唯一约束**但唯一键不含分区键 |
| 写入有清晰的**热分区**与**冷分区** | 想靠分区“提升单条点查速度”（索引已经解决） |

> [!TIP] 分区数的量级
> 单表分区数**几十~几百**最舒适；**上千**时规划时间、元数据缓存与锁（每个被访问的分区都要加锁，`max_locks_per_transaction` 要调大）开销明显；**上万**需要慎重评估或改为多级/改变粒度。按**天分区的 10 年数据 = 3650 个分区**，通常不如按**月分区**。

### 分区的限制

| 限制 | 说明与对策 |
| --- | --- |
| **唯一约束/主键必须包含分区键** | 无法在非分区键上做全局唯一；若业务需要（如全局订单号唯一），用**含分区键的复合键**、或应用/单独的“唯一性登记表”（非分区）保证 |
| **没有全局索引** | 每个分区各自有索引；按非分区键的查询需要**探测每个分区的索引**（分区多时代价线性增长） |
| **外键** | 分区表可以有指向普通表的外键；**被其他表引用**（PG12+ 可以）要求引用列包含分区键；外键校验成本随分区数变化 |
| **跨分区更新分区键** | 更新分区键会**移动行**（实质是删除+插入），可能触发并发问题；尽量不更新分区键 |
| **约束与触发器** | 行级触发器可建在父表；部分特性按分区单独管理 |
| **逻辑复制** | PG13+ 可发布分区表；订阅端分区结构与处理要一致 |
| **创建索引** | 父表上建索引会在所有分区建；**大分区同时建索引耗时锁表**：用 `CREATE INDEX ON ONLY` 父表 + 逐分区 `CREATE INDEX CONCURRENTLY` + `ATTACH INDEX` 的方式 |

## 分区裁剪

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="分区裁剪：查询条件作用于分区键时，计划期若条件是常量则直接排除不相关分区；执行期裁剪用于参数化或子查询得出的值，运行时排除；常见失效原因是对分区键使用函数或类型不匹配、条件放在 OR 中、使用不稳定函数、没有分区键条件；EXPLAIN 中只出现相关分区，Subplans Removed 表示执行期裁剪">
<rect class="b3" x="20" y="14" width="350" height="110" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">计划期裁剪（Plan-time）</text>
<text class="ts" x="195" y="60" text-anchor="middle">created_at ∈ [2024-02-01, 2024-03-01)</text>
<text class="ts" x="195" y="82" text-anchor="middle">条件是常量 → 规划时只保留 orders_2024_02</text>
<text class="ts" x="195" y="104" text-anchor="middle">EXPLAIN 中只出现被保留的分区</text>
<rect class="b5" x="390" y="14" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">执行期裁剪（Run-time）</text>
<text class="ts" x="565" y="60" text-anchor="middle">预编译参数 / 子查询 / 嵌套循环内层的值</text>
<text class="ts" x="565" y="82" text-anchor="middle">规划时值未知，执行时按实际值排除</text>
<text class="ts" x="565" y="104" text-anchor="middle">EXPLAIN 显示 Subplans Removed: N</text>
<rect class="b4" x="20" y="140" width="720" height="182" rx="10"/>
<text class="th" x="32" y="160">裁剪失效的常见原因</text>
<text class="ts" x="380" y="186" text-anchor="middle">① 对分区键套函数：WHERE date_trunc('month', created_at) = '2024-02-01' → 无法裁剪（改为范围条件）</text>
<text class="ts" x="380" y="208" text-anchor="middle">② 类型不一致/隐式转换：分区键 timestamptz 而条件是 text 或 date 被转换 → 检查 EXPLAIN 中是否有 ::cast</text>
<text class="ts" x="380" y="230" text-anchor="middle">③ 条件里没有分区键（只有 user_id 等）→ 扫描所有分区的相应索引（分区多时放大）</text>
<text class="ts" x="380" y="252" text-anchor="middle">④ OR 把分区键条件与其他条件混在一起，或使用不稳定函数（now() 在计划期不能裁剪，执行期可以）</text>
<text class="ts" x="380" y="274" text-anchor="middle">⑤ enable_partition_pruning 被关闭；使用了老式继承分区且没有 CHECK 约束/constraint_exclusion</text>
<text class="ts" x="380" y="296" text-anchor="middle">⑥ JOIN 条件通过连接传递分区键值：需要 partition-wise 或执行期裁剪，规划器未必能推导</text>
<text class="ta" x="380" y="316" text-anchor="middle">验证习惯：对每条核心 SQL 做 EXPLAIN，确认只扫描预期的分区数</text>
</svg>
<figcaption>图 1：分区裁剪的两种时机与失效原因</figcaption>
</figure>

### 分区间的连接与聚合

- **Partition-wise Join**（`enable_partitionwise_join`，默认 off）：当两张表**按相同方式分区**且连接键包含分区键，可以**分区对分区地连接**，更小的哈希表/更好的并行与缓存；
- **Partition-wise Aggregate**（`enable_partitionwise_aggregate`，默认 off）：按分区键分组时在每个分区先局部聚合；
- 代价：规划时间增加、内存占用上升，所以默认关闭；**确有大表分区连接/聚合**才开启并验证；
- **并行**：分区表可以 **Parallel Append** 并行扫描多个分区，见 [PG 优化器原理](#/pg/optimizer)。

## 分区的在线维护

### 新增分区：ATTACH 而不是直接 CREATE PARTITION OF

直接 `CREATE TABLE ... PARTITION OF` 会在持锁时扫描 DEFAULT 分区确认没有越界数据；对**生产环境推荐**：

```sql
-- 1) 独立建表（LIKE 复制结构），并加与分区范围一致的 CHECK 约束
CREATE TABLE orders_2024_03 (LIKE orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
ALTER TABLE orders_2024_03 ADD CONSTRAINT chk_2024_03
  CHECK (created_at >= '2024-03-01' AND created_at < '2024-04-01');
-- 2)（可选）预先导入数据、建好索引、做 ANALYZE
-- 3) 挂接：因已有匹配的 CHECK 约束，PG 可跳过全表验证，只需短暂持锁
ALTER TABLE orders ATTACH PARTITION orders_2024_03
  FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
ALTER TABLE orders_2024_03 DROP CONSTRAINT chk_2024_03;
```

**预建未来分区**是关键运维动作：**漏建分区会导致写入失败**（找不到分区，报 `no partition of relation found for row`），或落入 DEFAULT 分区造成后续麻烦。需要**监控“未来 N 天/月是否已有分区”**。

### 删除/归档旧分区

| 操作 | 说明 |
| --- | --- |
| **`DROP TABLE orders_2023_01`** | 直接删除分区表，**瞬间完成，无 DELETE 膨胀、无大量 WAL**，是分区的核心收益；需要 ACCESS EXCLUSIVE 锁（父表上短暂的锁，注意 `lock_timeout`） |
| **`ALTER TABLE orders DETACH PARTITION orders_2023_01 CONCURRENTLY`**（PG14+） | **并发分离**：不阻塞对父表的查询/写入（两阶段）；分离后成为独立表，可以**归档**（`pg_dump`/导出到对象存储/转移到冷存储表空间）后再删除 |
| **表空间迁移** | 旧分区 `ALTER TABLE ... SET TABLESPACE` 移到廉价存储（冷数据） |
| **保留策略** | 按业务/合规确定保留期，脚本化 |

> [!WARNING] DEFAULT 分区的陷阱
> DEFAULT 分区**会接收所有未被其他分区覆盖的行**，容易“悄悄”积累数据（比如因漏建分区）；之后想新建覆盖这些数据的分区，必须先把 DEFAULT 中对应范围的行**移走**（否则 `ATTACH` 失败或需要长时间扫描校验）。**要么不建 DEFAULT 让写入明确失败并告警，要么严密监控 DEFAULT 分区行数。**

### 自动化：pg_partman 与自研

- **`pg_partman`** 扩展：**自动创建未来分区、按保留期清理旧分区**、支持时间/ID 分区、模板表（统一索引/属性）、历史数据迁移分区；通过 `pg_cron` 或后台 worker 定期执行维护；
- 自研方案：定时任务（`pg_cron`、调度平台）+ 脚本；注意**幂等**、**并发安全**、**失败告警**；
- **监控**：缺失的未来分区、DEFAULT 分区行数、分区总数、各分区大小倾斜、`pg_stat_user_tables` 各分区的 autovacuum 状态。

### 把现有大表改造成分区表

**无法原地转换**（普通表不能直接变分区表）。在线迁移思路：

1. 创建新的分区表（结构相同，主键含分区键）；
2. 把旧表**作为一个分区挂接**（`ATTACH`，需要匹配的 CHECK 约束，覆盖旧数据范围）——**最快、几乎零拷贝**（适合时间维度，旧表即“历史分区”，新数据进新分区）；
3. 或**触发器/逻辑复制/双写**同步增量到新表，批量回填后切换（改名）；
4. 切换后应用无感；旧表 `RENAME` 保留一段时间后删除；
5. **提前评估**：主键变更、外键、依赖视图/函数、ORM 映射、序列、权限。

## 扩展机制

PG 的扩展以 `CREATE EXTENSION name;` 安装（需要对应的共享库与 SQL 脚本，部分需要 `shared_preload_libraries` 并重启）。

| 方面 | 要点 |
| --- | --- |
| **版本与升级** | 扩展版本与 PG 大版本绑定；**大版本升级前确认扩展已支持目标版本**；`ALTER EXTENSION ... UPDATE` |
| **云厂商支持** | 云数据库只开放其白名单扩展，**迁移/选型前确认**；自建则自行编译与运维 |
| **高可用/备份影响** | 数据放在扩展自定义结构里时，物理复制/备份通常能带上；逻辑复制不一定；`shared_preload_libraries` 的扩展需在所有节点安装一致 |
| **许可证** | 部分扩展（如 TimescaleDB 的部分功能）有特殊许可证，商用前确认 |
| **性能与稳定性** | 扩展代码在数据库进程内运行，**bug 会让整个后端崩溃**；上线前压测与灰度 |

## 常用扩展

### 诊断与运维类

| 扩展 | 作用 | 要点 |
| --- | --- | --- |
| **`pg_stat_statements`** | 聚合统计每类 SQL（归一化后）的调用次数、总/平均/最大耗时、返回行数、命中块数、WAL 量 | **必装**；`shared_preload_libraries`；用它找“总耗时最高/平均最慢/调用最多”的 SQL；定期 `pg_stat_statements_reset()` 或采集后持久化 |
| **`auto_explain`** | 自动记录慢 SQL 的执行计划（可含 ANALYZE、BUFFERS） | 设阈值（如 1s），避免全量开启造成开销 |
| **`pg_stat_kcache`、`pg_wait_sampling`、`pg_buffercache`、`pgstattuple`、`pageinspect`** | 内核级资源统计、等待事件采样、缓冲区内容、膨胀检测、页面检查 | 深度诊断 |
| **`pg_cron`** | 在数据库内按 cron 表达式调度 SQL | 分区维护、统计汇总、清理；注意单点（仅在主库运行）与失败告警 |
| **`hypopg`** | **假设索引**：不真正创建就让优化器评估是否会用 | 索引设计前的验证 |
| **`pg_repack`** | 在线重整表/索引 | 见 [PG MVCC 内部机制深入](#/pg/vacuum-internals) |

### 查询与数据类型类

| 扩展 | 作用 | 要点 |
| --- | --- | --- |
| **`pg_trgm`** | **三元组相似度**：支持 `LIKE '%xx%'`、`ILIKE`、正则、相似度（`%` 运算符、`similarity()`）的**索引加速**（GIN/GiST） | 解决**中缀模糊搜索**慢的问题；中文需要配合分词（如 `zhparser`/`pg_jieba`）或三元组对中文效果有限 |
| **`btree_gin` / `btree_gist`** | 让标量类型支持 GIN/GiST 索引 | 与排他约束、组合索引配合 |
| **`hstore` / JSONB 相关** | 键值/文档 | 见 [PG 复制、高可用与实战](#/pg/ops) 的 JSONB |
| **`uuid-ossp` / `pgcrypto`** | UUID 生成、加密函数 | 新版本内置 `gen_random_uuid()`；加密按需 |
| **`citext`** | 大小写不敏感文本 | 注意排序规则与索引 |
| **`ltree`** | 层级路径（树） | 分类/组织树的祖先后代查询 |

### 向量检索：pgvector

**`pgvector`** 给 PG 增加 **`vector` 类型与近似最近邻（ANN）索引**，让 PG 直接承担 **RAG/语义搜索** 的向量存储，见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced)：

```sql
CREATE EXTENSION vector;
CREATE TABLE docs (id bigserial PRIMARY KEY, content text, embedding vector(768), tenant_id bigint);

-- 近似索引：HNSW（精度与召回更好、内存占用大、建索引慢）或 IVFFlat（先聚类，建索引快，需要有数据后建并调 lists/probes）
CREATE INDEX ON docs USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- 查询：余弦距离 <=>，欧氏 <->，内积 <#>
SET hnsw.ef_search = 100;                       -- 召回与延迟的权衡
SELECT id, content FROM docs
WHERE tenant_id = 42                            -- 过滤 + 向量（要关注过滤后召回下降的问题）
ORDER BY embedding <=> '[0.1,0.2,...]' LIMIT 10;
```

| 要点 | 说明 |
| --- | --- |
| **优势** | **与业务数据同库**：事务、权限、联表、过滤、备份高可用都沿用 PG；规模中小（百万~千万向量）时**架构最简单** |
| **局限** | 亿级向量、高 QPS、极致延迟时，**专用向量库（Milvus 等）**更合适；HNSW 索引**内存占用大**、建索引耗时 |
| **过滤 + ANN** | 带 WHERE 过滤时，ANN 先取候选再过滤，可能**结果不足（召回下降）**；用迭代扫描（新版本）、增大 `ef_search`、分区/部分索引按租户拆分、或预过滤策略 |
| **维度与存储** | 维度越高越大；`halfvec`/量化可降低存储（新版本） |
| **混合检索** | 向量 + 全文（`tsvector`/`pg_trgm`/BM25 类扩展）融合排序（RRF），提升召回 |
| **运维** | 索引构建期占用资源（`maintenance_work_mem`、并行）；更新频繁的向量表要关注索引质量与 VACUUM |

### 地理空间：PostGIS

- 提供 `geometry/geography` 类型、**GiST/SP-GiST 空间索引**、数百个空间函数（距离、包含、相交、缓冲区、最近邻 `<->`）；
- 适用于**LBS、围栏、路径分析、GIS**；与 [案例：LBS 附近的人与打车派单设计详解](#/design/case-lbs) 对比：PostGIS 适合**低频更新、复杂空间查询**，**高频位置更新**用内存网格索引；
- 注意：坐标系（SRID）、`geography`（球面，精确但慢）与 `geometry`（平面，快）的取舍；空间索引对 `ST_DWithin` 有效，而直接 `ST_Distance < x` 不走索引。

### 时序：TimescaleDB

- 在 PG 上提供 **hypertable**（自动按时间分块 chunk，类似自动分区）、**列式压缩**、**连续聚合**（物化的实时汇总）、**保留策略**、时间函数；
- 适用于 IoT/监控的**时序数据且需要 SQL 与关系型关联**的场景，见 [InfluxDB 数据模型与存储引擎](#/db/influx-model)、[IoT 平台架构与设备管理](#/iot/platform) 的 TimescaleDB 表设计；
- 注意**许可证**（部分高级功能为社区/商业许可）、云厂商支持、大版本升级兼容。

### 分布式：Citus 与联邦：FDW

| 方案 | 说明 |
| --- | --- |
| **Citus** | 把 PG 变成**分布式数据库**：按分布键**水平分片**到多个 worker 节点，协调节点路由与并行执行；支持**引用表**（小表全量复制到各节点）、**共定位（co-location）**使关联查询本地化；适合**多租户 SaaS**与**实时分析**；限制：跨分片事务/唯一约束、需要选好分布键，见 [分片、一致性哈希与再平衡](#/distributed/partitioning) |
| **`postgres_fdw` / 其他 FDW** | **外部数据封装器**：把远程 PG（或 MySQL、MongoDB、文件、S3 等）的表映射为本地外部表，可 JOIN；**下推**过滤/聚合/连接以减少传输；适合**跨库查询、数据迁移、联邦分析**；**不适合高并发 OLTP**（网络往返、事务语义弱）；分区表的某些分区可以是外部表（冷数据放别处） |

### 其他常见扩展

- **`pg_hint_plan`**：用注释提示优化器，见 [PG 优化器原理](#/pg/optimizer)；
- **`pglogical`**：早期增强的逻辑复制（内置逻辑复制成熟后使用减少）；
- **`pgaudit`**：细粒度审计日志（合规）；
- **`pg_ivm` / 物化视图**：增量物化视图维护；
- **`orafce`/兼容性扩展**：Oracle 兼容函数，迁移辅助；
- **`age`**（图）、**`pg_search`/ParadeDB 等全文/BM25**：新兴方向，评估成熟度再用。

## 选型建议

| 需求 | 方案 |
| --- | --- |
| 大表按时间滚动清理 | **RANGE 分区 + pg_partman**（或自研预建/清理），按月分区 |
| 多租户大表、租户级运维 | **LIST/HASH 分区**或按租户分区；极大租户独立表；或 Citus 分布式 |
| 日志/监控时序 + SQL | 原生分区够用；规模大/需压缩与连续聚合 → **TimescaleDB** |
| 语义检索 RAG（中小规模） | **pgvector**（与业务数据同库，HNSW） |
| 模糊搜索 | **pg_trgm**；复杂全文/中文分词用 `tsvector` + 分词扩展，或 Elasticsearch（见 [案例：搜索系统设计详解](#/design/case-search)） |
| 地理空间 | **PostGIS** |
| 跨库查询/迁移 | **FDW**、逻辑复制 |
| 水平扩展 | 先分区与读写分离；再 Citus 或应用层分片（见 [分库分表实践](#/mysql/sharding) 的思路） |

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 分区了但查询没变快 | 条件不含分区键/对分区键套函数/类型转换，裁剪失效 | 改写条件，EXPLAIN 验证分区数 |
| 写入报 `no partition of relation "orders" found for row` | 漏建未来分区 | 预建分区与监控；pg_partman 自动化 |
| 数据都落在 DEFAULT 分区 | 漏建分区 | 迁移数据到新分区（需处理）；监控 DEFAULT 行数 |
| 想要全局唯一索引做不了 | 唯一约束必须含分区键 | 复合键/登记表/应用保证 |
| 规划时间变长、锁数量爆炸 | 分区数过多 | 降低分区粒度；调 `max_locks_per_transaction`；Prepared 复用计划 |
| 对父表建索引卡住业务 | 大分区同时建索引 | `ON ONLY` + 逐分区 CONCURRENTLY + ATTACH INDEX |
| 删除旧数据仍然产生大量 WAL/膨胀 | 用 DELETE 而非 DROP 分区 | 改用分区 DROP/DETACH |
| 升级后扩展不可用 | 扩展不支持新大版本/云厂商未支持 | 升级前清单核对；预演 |
| pgvector 过滤后结果变少 | ANN 后过滤造成召回下降 | 增大 ef_search/迭代扫描/按租户分区或部分索引 |
| FDW 查询很慢 | 过滤/连接未下推、网络往返 | 看远程计划；`use_remote_estimate`；物化到本地 |

## 检查清单

- [ ] 分区的目的是否明确（滚动清理/维护拆分/裁剪），分区键是否与主要查询条件一致？
- [ ] 主键/唯一约束是否包含分区键，业务上的全局唯一是否另有保证？
- [ ] 是否验证了核心 SQL 的分区裁剪（EXPLAIN 只扫预期分区），条件无函数/类型不匹配？
- [ ] 分区数量是否在合理范围（按月 vs 按天），是否评估规划时间与锁数量？
- [ ] 是否自动预建未来分区并监控缺失与 DEFAULT 分区行数，旧分区是否按保留期 DETACH/DROP？
- [ ] 新增分区是否采用 ATTACH + CHECK 约束，DDL 是否带 `lock_timeout`？
- [ ] 是否安装 `pg_stat_statements`、`auto_explain` 并纳入监控？
- [ ] 使用的扩展是否核对了云厂商支持、许可证、大版本升级兼容与高可用影响？
- [ ] 向量检索是否评估了规模、过滤召回、索引内存与更新模式？

## 相关阅读

- [架构、WAL 与存储结构（PG）](#/pg/architecture)：分区与存储结构基础
- [PG 复制、高可用与实战](#/pg/ops)：声明式分区入门与常用扩展、JSONB
- [PG 优化器原理](#/pg/optimizer)：分区裁剪、并行 Append 与 partition-wise
- [PG MVCC 内部机制深入](#/pg/vacuum-internals)：用分区治理膨胀与历史数据
- [PG 锁、隔离级别与连接池](#/pg/concurrency)：分区 DDL 的锁与安全变更
- [RAG 检索优化、向量库与评估](#/ai/rag-advanced)：向量检索与向量库选型

## 面试追问

> [!QUESTION] PostgreSQL 分区表有什么好处？有哪些限制？
> 主要好处是可管理性：历史分区可直接 DROP 或 DETACH 秒级删除，不产生 DELETE 的膨胀和 WAL，也能把 VACUUM、索引和备份拆小，查询在条件含分区键时通过裁剪只扫相关分区。限制是主键和唯一约束必须包含分区键，没有跨分区的全局索引，分区过多增加规划时间和锁开销，更新分区键会移动行。

> [!QUESTION] 分区裁剪什么时候会失效？
> 条件没有分区键、对分区键套函数、类型不一致引起隐式转换、OR 混合条件，或把 enable_partition_pruning 关了都会失效。计划期裁剪针对常量条件，执行期裁剪针对参数和子查询的值，EXPLAIN 里会看到 Subplans Removed。要对核心 SQL 用 EXPLAIN 验证只扫预期分区。

> [!QUESTION] 生产环境怎么在线新增和删除分区？
> 新增时先建独立表并加与分区范围一致的 CHECK 约束，数据和索引准备好后 ATTACH PARTITION，可跳过全表校验只短暂持锁，并要预建未来分区避免写入失败。删除用 DETACH PARTITION CONCURRENTLY 并发分离后归档或 DROP。DDL 前设置 lock_timeout，用 pg_partman 或定时任务自动化并监控缺失分区与 DEFAULT 分区。

> [!QUESTION] 为什么说 DEFAULT 分区要慎用？
> 它会接收所有未被覆盖的行，漏建分区时数据会悄悄堆在里面；之后新建覆盖这些范围的分区必须先把相关行移走，否则 ATTACH 失败或要长时间扫描校验。可以不建 DEFAULT 让写入明确失败并告警，或者严格监控其行数。

> [!QUESTION] pgvector 适合什么场景？有什么局限？
> 适合中小规模的向量检索如百万到千万向量的 RAG，与业务数据同库，事务、权限、联表过滤、备份高可用都沿用 PG，架构简单。局限是亿级向量或高 QPS 极致延迟时专用向量库更合适，HNSW 索引占内存大、建索引慢，带过滤条件时 ANN 后过滤可能让结果变少，需要增大 ef_search、迭代扫描或按租户拆分。

> [!QUESTION] 选用 PostgreSQL 扩展要注意什么？
> 扩展与大版本绑定，升级前要确认支持；云厂商只开放白名单扩展；扩展在数据库进程内运行，缺陷可能让后端崩溃，要压测灰度；部分扩展有许可证限制；还要评估对高可用、备份和逻辑复制的影响，以及 shared_preload_libraries 需要重启。
