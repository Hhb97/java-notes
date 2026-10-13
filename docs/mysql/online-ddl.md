---
level: 深入
tags: [MySQL, 在线DDL, Online DDL, INSTANT, INPLACE, COPY, MDL, gh-ost, pt-osc, 大表变更, 原子DDL, 元数据锁]
summary: MySQL 在线 DDL 与大表治理：DDL 的三种算法（INSTANT/INPLACE/COPY）与锁级别、Online DDL 的 row log 与三阶段、元数据锁（MDL）排队阻塞的雪崩机制、各类变更（加列/加索引/改类型/改字符集）的代价矩阵、gh-ost 与 pt-osc 的原理差异与选型、主从延迟与回滚预案、8.0 原子 DDL，以及大表归档与变更的发布流程。
---

# MySQL 在线 DDL 与大表治理

> [!ABSTRACT] 核心要点
> - DDL 的真正风险不在“拷贝数据慢”，而在 **MDL（元数据锁）排队**：一个长事务/慢查询持有表的 MDL 读锁，`ALTER` 申请 MDL 写锁被阻塞，**后续所有读写都排在 ALTER 后面等待**，几秒内连接打满，**线上雪崩**。
> - **三种算法**：`INSTANT`（只改数据字典，秒级，8.0.12+ 支持加列等）、`INPLACE`（原地重建/不拷贝到新表，多数**允许并发 DML**）、`COPY`（建临时表全量拷贝，**阻塞写**）。能 INSTANT 就 INSTANT，显式写 `ALGORITHM=..., LOCK=NONE` 让不满足条件时**直接报错而不是悄悄退化**。
> - **Online DDL 的并发 DML 靠 row log**：变更期间的 DML 记录到 online log，结尾阶段回放；**row log 有上限（`innodb_online_alter_log_max_size`，默认 128MB）**，写入很猛时可能溢出导致 DDL 失败回滚。
> - **大表变更**不要直接 `ALTER`：用 **gh-ost / pt-online-schema-change** 影子表方案，**可限速、可暂停、可中止、对主从延迟敏感**；代价是需要额外空间、对触发器/外键/特殊表有限制。
> - **变更必须“可回滚”**：先在从库/影子环境验证，评估**磁盘空间**（变更中最多是表大小的 2~3 倍含 undo/redo）与**主从延迟**；灰度窗口低峰执行，并设置 **`lock_wait_timeout` 短超时**，宁可失败重试也别排队阻塞。

## 为什么 DDL 危险：MDL

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="MDL 排队雪崩：长事务持有表的元数据读锁，ALTER 申请元数据写锁被阻塞，之后到来的所有读写请求因为要获取读锁而排在 ALTER 之后一起等待，连接数迅速打满导致业务不可用">
<rect class="b4" x="20" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">① 长事务/慢查询</text>
<text class="ts" x="105" y="74" text-anchor="middle">持有 MDL 读锁不释放</text>
<rect class="b3" x="295" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="380" y="52" text-anchor="middle" dominant-baseline="middle">② ALTER TABLE</text>
<text class="ts" x="380" y="74" text-anchor="middle">申请 MDL 写锁：等待</text>
<rect class="b1" x="570" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="655" y="52" text-anchor="middle" dominant-baseline="middle">③ 新来的 SELECT/DML</text>
<text class="ts" x="655" y="74" text-anchor="middle">要读锁，排在写锁请求之后</text>
<line class="l" x1="190" y1="62" x2="295" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="465" y1="62" x2="570" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="720" height="190" rx="8"/>
<text class="th" x="32" y="142">后果与预防</text>
<text class="ts" x="380" y="170" text-anchor="middle">MDL 等待队列按申请顺序：写锁请求挡住其后所有读锁请求</text>
<text class="ts" x="380" y="194" text-anchor="middle">该表所有访问堆积，线程/连接暴涨，连接池耗尽，业务整体超时</text>
<text class="ts" x="380" y="224" text-anchor="middle">预防 1：执行前查 information_schema.innodb_trx 与 performance_schema.metadata_locks 是否有长事务</text>
<text class="ts" x="380" y="248" text-anchor="middle">预防 2：SET lock_wait_timeout = 5，ALTER 等不到就失败，业务可重试</text>
<text class="ts" x="380" y="272" text-anchor="middle">预防 3：低峰执行；杀掉长事务；用 gh-ost 的 cut-over 短暂加锁策略</text>
<text class="ts" x="380" y="296" text-anchor="middle">注意：未提交的“空闲事务”也持有 MDL，应用 bug 常见</text>
</svg>
<figcaption>图 1：MDL 排队引发的雪崩</figcaption>
</figure>

**MDL 要点**：

- 任何 DML/查询在**事务内**对表加 **MDL 读锁（SHARED_READ/SHARED_WRITE）**，**事务结束才释放**；DDL 需要 **MDL 写锁（EXCLUSIVE）**，且**升级阶段**（Online DDL 的开始与提交阶段）都需要短暂独占；
- **只读的长事务、未提交的空闲事务、慢查询、`SELECT ... FOR UPDATE`、被遗忘的 `BEGIN`** 都会持有 MDL；
- 诊断：

```sql
-- 谁持有/等待元数据锁（需开启 performance-schema-instrument='wait/lock/metadata/sql/mdl=ON'，8.0 默认开）
SELECT object_schema, object_name, lock_type, lock_status, owner_thread_id
FROM performance_schema.metadata_locks WHERE object_name = 't_order';
-- 长事务
SELECT trx_id, trx_started, trx_mysql_thread_id, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS secs
FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 10;
-- sys 视图直接给出 阻塞者与被阻塞者
SELECT * FROM sys.schema_table_lock_waits;
```

- 处理：`KILL` 阻塞者的连接（先评估业务影响）；**ALTER 本身不要无限等**，用 `SET SESSION lock_wait_timeout = 5;`（单位秒）。

## DDL 的算法与锁

```sql
ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INSTANT;           -- 不满足则报错
ALTER TABLE t ADD INDEX idx_a(a), ALGORITHM=INPLACE, LOCK=NONE;
```

| 算法 | 做法 | 并发 DML | 典型操作 |
| --- | --- | --- | --- |
| **INSTANT**（8.0.12+） | **只改数据字典**，不碰数据；新增列的默认值记录在元数据里，读取旧行时现场补 | 全程允许 | 加列（8.0.29 起可放任意位置）、删列（8.0.29+）、改列默认值、重命名列/表、修改枚举尾部追加值 |
| **INPLACE** | 不创建临时表文件，在 InnoDB 内部变更；有的**需要重建表**（rebuild），有的**只改索引**（不重建） | 多数允许（`LOCK=NONE`），**开始/结束瞬间短暂独占** | 加/删二级索引、改列类型长度（部分）、OPTIMIZE、重建表 |
| **COPY** | 建新表→拷贝所有行→交换，**拷贝期间阻塞写** | 只允许读 | 改列类型、改字符集、改主键（部分）；`ALGORITHM=COPY` 或旧版本 |

`LOCK` 取值：`NONE`（读写都允许）、`SHARED`（只读）、`EXCLUSIVE`（独占）、`DEFAULT`。

### Online DDL（INPLACE）的三阶段

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="Online DDL 三阶段：准备阶段短暂持有独占元数据锁并创建 row log，执行阶段降级为共享锁允许并发 DML，DML 变更写入 row log，同时扫描聚簇索引构建新索引或新表，提交阶段再次升级独占锁，回放 row log 剩余部分并交换">
<rect class="b3" x="20" y="30" width="215" height="110" rx="10"/>
<text class="tb" x="127" y="52" text-anchor="middle" dominant-baseline="middle">① 准备（Prepare）</text>
<text class="ts" x="127" y="78" text-anchor="middle">短暂持有独占 MDL</text>
<text class="ts" x="127" y="98" text-anchor="middle">检查、分配 row log</text>
<text class="ts" x="127" y="118" text-anchor="middle">然后降级为共享 MDL</text>
<rect class="b5" x="272" y="30" width="215" height="110" rx="10"/>
<text class="tb" x="380" y="52" text-anchor="middle" dominant-baseline="middle">② 执行（Execute）</text>
<text class="ts" x="380" y="78" text-anchor="middle">扫描聚簇索引，构建新结构</text>
<text class="ts" x="380" y="98" text-anchor="middle">并发 DML 同时写入 row log</text>
<text class="ts" x="380" y="118" text-anchor="middle">耗时主体，不阻塞读写</text>
<rect class="b4" x="525" y="30" width="215" height="110" rx="10"/>
<text class="tb" x="632" y="52" text-anchor="middle" dominant-baseline="middle">③ 提交（Commit）</text>
<text class="ts" x="632" y="78" text-anchor="middle">再升级独占 MDL</text>
<text class="ts" x="632" y="98" text-anchor="middle">回放 row log 剩余增量</text>
<text class="ts" x="632" y="118" text-anchor="middle">交换表/索引，提交元数据</text>
<line class="l" x1="235" y1="85" x2="272" y2="85" marker-end="url(#arr)"/>
<line class="l" x1="487" y1="85" x2="525" y2="85" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="165" width="720" height="85" rx="8"/>
<text class="ts" x="380" y="190" text-anchor="middle">风险点：准备和提交阶段都要独占 MDL，遇到长事务就会排队（见图 1）</text>
<text class="ts" x="380" y="212" text-anchor="middle">row log 超过 innodb_online_alter_log_max_size 则 DDL 失败回滚（大表+高写入）</text>
<text class="ts" x="380" y="234" text-anchor="middle">重建表的 INPLACE 仍要一次完整拷贝，耗 I/O、磁盘与主从延迟</text>
</svg>
<figcaption>图 2：Online DDL 三阶段</figcaption>
</figure>

**不要被“Online”误导**：

- **是否重建表**决定代价：加二级索引**只扫描聚簇索引建新索引树**，不重建表；**改列类型/改主键/加全文索引首次**等需**重建整张表**，耗时与表大小成正比；
- 变更期间产生的**大量 redo/undo/临时排序文件**（`innodb_tmpdir` 可指定临时目录）：大表加索引需要**临时磁盘空间**，磁盘不足会失败；
- **从库复制**：DDL 在主库执行时间 T，**从库也要 T 的执行时间（单线程 DDL 回放）**，期间**从库延迟≈T**，且从库 DDL 回放时**阻塞该库后续回放**。Online DDL 在从库同样是 online，但**延迟仍存在**；这是大表变更选影子表方案的另一个原因。

### 变更类型代价矩阵（8.0 参考，具体以所用小版本的官方文档为准）

| 操作 | 算法 | 是否重建表 | 并发 DML | 说明 |
| --- | --- | --- | --- | --- |
| 加列（末尾，8.0.12+） | **INSTANT** | 否 | 是 | 首选；8.0.29 前只能加在末尾，之后任意位置。**instant 列的行版本数有上限**，超过后需重建表（`INSTANT_COLS` 次数限制 64 次） |
| 删列 | INSTANT（8.0.29+）/ INPLACE 重建 | 视版本 | 是 | 5.7 重建表 |
| 加/删二级索引 | INPLACE | 否（建索引） | 是 | 耗时看表大小；占用临时空间 |
| 改列类型（如 INT→BIGINT） | **COPY** | 是 | **否** | 大表禁用，改用影子表工具 |
| 增大 VARCHAR 长度 | INPLACE | **看长度字节边界**（255 → 超过 255 字节需 2 字节长度前缀，重建；不跨界可原地） | 是 | 注意 utf8mb4 下字节数=字符数×4 |
| 改列允许 NULL / 默认值 | INPLACE / INSTANT（默认值） | NULL↔NOT NULL 重建 | 是 | NOT NULL 需检查已有数据 |
| 修改字符集 | COPY | 是 | 否 | 同时影响索引、连接比较；大表用影子表 |
| 修改主键 | INPLACE（重建，**需 `LOCK=NONE` 支持**）/ COPY | 是 | 视情况 | 极重操作 |
| 加外键 | INPLACE（需 `foreign_key_checks=0`） | 否 | 是 | 一般不建议用外键 |
| 加分区 / 重组分区 | INPLACE / COPY | 视情况 | 视情况 | 见分区治理 |
| OPTIMIZE TABLE / `ALTER TABLE t ENGINE=InnoDB` | INPLACE 重建 | 是 | 是 | 回收碎片，耗 I/O |

> [!WARNING] 版本差异
> 具体哪个版本支持哪些 INSTANT/INPLACE 操作、行版本数限制、MDL 行为在 5.7/8.0.x 小版本间有差异，**务必查你所用版本官方的 “Online DDL Operations” 表**，并在**同版本的测试库验证 `ALGORITHM=... , LOCK=...` 是否被接受**。

## 影子表方案：gh-ost 与 pt-osc

当 INPLACE 仍不可接受（需要重建大表、要求可控限速、要求随时中止、改类型/字符集）时，用**外部在线变更工具**：创建**影子表**，应用变更，**把原表数据分批拷到影子表，同时同步期间的增量**，最后**原子切换表名**。

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="gh-ost 与 pt-online-schema-change 对比：pt-osc 在原表上建立触发器同步增量，触发器在事务内执行，与业务事务耦合；gh-ost 不用触发器，伪装为从库读取 binlog 异步回放增量到影子表，对主库影响小、可暂停与限速，两者都分批拷贝存量数据，最后原子交换表名">
<rect class="b3" x="20" y="14" width="350" height="190" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">pt-online-schema-change</text>
<text class="ts" x="195" y="62" text-anchor="middle">建影子表 _t_new，执行 ALTER</text>
<text class="ts" x="195" y="84" text-anchor="middle">在原表建 3 个触发器（I/U/D）</text>
<text class="ts" x="195" y="106" text-anchor="middle">触发器把业务写同步到影子表</text>
<text class="ts" x="195" y="128" text-anchor="middle">分批 INSERT…SELECT 拷存量</text>
<text class="ts" x="195" y="150" text-anchor="middle">RENAME 原子交换</text>
<text class="ts" x="195" y="178" text-anchor="middle">触发器在业务事务内：增加写延迟与锁竞争</text>
<rect class="b5" x="390" y="14" width="350" height="190" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">gh-ost（GitHub）</text>
<text class="ts" x="565" y="62" text-anchor="middle">建影子表 _t_gho，执行 ALTER</text>
<text class="ts" x="565" y="84" text-anchor="middle">伪装从库读 binlog（无触发器）</text>
<text class="ts" x="565" y="106" text-anchor="middle">异步回放增量到影子表</text>
<text class="ts" x="565" y="128" text-anchor="middle">分批拷存量，可暂停/限速/中止</text>
<text class="ts" x="565" y="150" text-anchor="middle">cut-over：短暂锁表后原子交换</text>
<text class="ts" x="565" y="178" text-anchor="middle">对主库写路径零侵入，更可控</text>
<rect class="bg" x="20" y="224" width="720" height="106" rx="8"/>
<text class="ts" x="380" y="250" text-anchor="middle">共同点：额外占用约一份表空间；变更时间长；需要表有主键或唯一键</text>
<text class="ts" x="380" y="272" text-anchor="middle">限制：外键、触发器、无主键表、gh-ost 要求 binlog 为 ROW 格式</text>
<text class="ts" x="380" y="294" text-anchor="middle">限速依据：主从延迟（--max-lag-millis）、线程运行数（--max-load）</text>
<text class="ts" x="380" y="316" text-anchor="middle">灰度：先在从库/测试环境用 --test-on-replica 演练</text>
</svg>
<figcaption>图 3：影子表方案对比</figcaption>
</figure>

| 维度 | gh-ost | pt-osc | 原生 Online DDL |
| --- | --- | --- | --- |
| 增量同步 | **读 binlog**（异步） | **触发器**（同步，在业务事务内） | row log（引擎内） |
| 对业务写影响 | 小（可限速、无触发器开销） | 大（每次写多执行触发器） | 小到中（大 DDL 期间 I/O 增加） |
| 可暂停/限速 | **强**（交互式命令/socket 控制） | 有限（`--max-load` 等） | 基本不可 |
| 主从延迟 | 感知并限速 | 感知（`--max-lag`） | 从库回放时长 = 主库时长，**不可控** |
| 对外键/触发器表 | 不支持 | 部分支持 | 支持 |
| 切换的风险 | cut-over 瞬时锁，需处理 MDL 排队 | RENAME 需要 MDL，同理 | 提交阶段 MDL |
| 适用 | **大表、高写入、需可控** | 中小表、已使用触发器环境 | **INSTANT/小 INPLACE** |

### 变更流程（gh-ost 示意）

```bash
gh-ost \
  --host=<副本或主库> --database=<库> --table=t_order \
  --alter="ADD COLUMN channel VARCHAR(32) NOT NULL DEFAULT ''" \
  --chunk-size=1000 --max-lag-millis=1500 --max-load=Threads_running=30 \
  --critical-load=Threads_running=100 \
  --initially-drop-ghost-table --cut-over=default \
  --exact-rowcount --concurrent-rowcount \
  --postpone-cut-over-flag-file=/tmp/ghost.postpone.flag \
  --execute
```

- **`--test-on-replica`**：先在从库完整演练（会在结束时不切换，可校验）；
- **`--postpone-cut-over-flag-file`**：先拷完数据、**保持同步等待**，选业务低峰再删除标志文件触发切换；
- **监控**：进度、延迟、`Threads_running`；**异常即中止**，原表不受影响（这是影子表方案最大的优势：**失败代价低**）；
- **切换后**保留旧表（`_t_del`）一段时间，**确认无误再删除**；删除大表本身也要谨慎（见下文）。

## 大表治理

### 变更发布流程

1. **评估**：表大小、行数、是否需重建；磁盘剩余空间（≥ 表大小 × 2~3）；主从延迟水位；是否有大事务/长事务；
2. **选方案**：INSTANT > 小 INPLACE > gh-ost；**COPY 在线上大表一律不用**；
3. **预演**：从库/测试环境用同数据量验证耗时、锁行为；
4. **执行**：低峰；`lock_wait_timeout` 短；监控 MDL 等待、延迟、I/O、Threads_running；有**中止预案**（gh-ost 中止、kill ALTER）；
5. **验证**：结构、索引、数据抽样、业务回归；
6. **善后**：观察一段时间后清理旧表；同步更新 ORM/迁移脚本。

### 大表删除与归档

- **`DROP TABLE` 大表**：InnoDB 要清理 Buffer Pool 中该表的页、释放文件，**可能持有锁并造成 I/O 抖动**（5.x 时代尤其严重，8.0 好很多）；安全做法：先 **truncate/逐步缩小**（或用硬链接到数据文件后再 drop，让 `rm` 在后台限速执行，需要运维手段），低峰执行；
- **大批量 `DELETE`**：单条巨大事务产生海量 undo/binlog、导致主从延迟、长时间锁与回滚段膨胀。**分批**（每批几千行、按主键范围、批间 sleep）；归档表按**时间分区**，**`DROP PARTITION` 是秒级元数据操作**（但 DROP PARTITION 要 MDL 写锁，同样要避免长事务）；
- **冷热分离**：历史数据迁移到归档库/列存/对象存储，见 [分库分表实践](#/mysql/sharding) 的冷热分离部分；
- **碎片回收**：大量删除后表文件不会缩小，`OPTIMIZE TABLE`（重建，在线）或 gh-ost 重建回收空间；需空间与时间评估。

### 其他重要点

- **原子 DDL（8.0）**：数据字典变为事务型，`DROP TABLE a, b`、`CREATE/ALTER` 要么完全成功要么完全回滚，**崩溃后不会留下半成品**；`DDL log` 保证；
- **加索引也会触发统计变化**：变更后 `ANALYZE TABLE` 并观察关键 SQL 计划，见 [MySQL 优化器原理](#/mysql/optimizer)；
- **应用兼容发布**（expand/contract）：先加列（可空/有默认）→ 发布兼容新旧结构的代码 → 数据回填 → 再收紧约束/删旧列，**避免“代码与结构同时变”的强耦合**，参见 [发布策略与数据库变更](#/infra/release) 的相关内容；
- **自增主键耗尽**：`INT` 自增上限约 21 亿，大表要提前监控，**`INT→BIGINT` 是最痛的变更之一**，设计阶段就用 BIGINT 或分布式 ID；
- **变更审计**：DDL 走平台审批与自动审核（索引/类型/大表检查），**禁止直接连生产执行**。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| ALTER 一执行业务全面超时 | MDL 排队雪崩 | 提前清长事务；短 `lock_wait_timeout`；低峰；用 gh-ost |
| Online DDL 报 “Creating index ... on table ... failed / row log” 错误 | 并发写太多，row log 超限 | 调大 `innodb_online_alter_log_max_size`；低峰；改影子表 |
| 变更期间主从延迟飙升 | 从库回放 DDL 同样耗时且阻塞回放 | 影子表+限速；避免在主库直接大 DDL |
| 磁盘被打满 | 重建表需额外空间，临时文件 | 变更前预估；`innodb_tmpdir`；清理 |
| `INSTANT` 报错 | 操作不支持或行版本数已达上限 | 用 INPLACE 重建，或查看具体原因 |
| gh-ost 切换卡住/失败 | cut-over 遇长事务 MDL | 清理长事务，重试 `cut-over`；使用 postpone 标志低峰触发 |
| 变更后查询突然变慢 | 统计信息变化、索引选择改变 | ANALYZE；对比计划，见 [MySQL 优化器原理](#/mysql/optimizer) |
| 改字符集后 JOIN/索引失效 | 两侧排序规则不一致 | 统一排序规则；检查连接字段 |

## 变更清单

- [ ] 是否确认没有长事务/空闲事务持有目标表 MDL？
- [ ] ALTER 是否显式指定 `ALGORITHM` 与 `LOCK`，并设置短 `lock_wait_timeout`？
- [ ] 变更是否需要重建表？磁盘空间与主从延迟是否评估？
- [ ] 大表是否选择了 gh-ost/pt-osc，并在从库演练？
- [ ] 是否有中止与回滚预案，旧表是否保留观察期？
- [ ] 应用发布是否按 expand/contract 兼容新旧结构？
- [ ] 变更后是否 ANALYZE 并检查关键 SQL 计划？
- [ ] 大批量删除/归档是否分批或使用分区丢弃？

## 相关阅读

- [锁机制与死锁分析](#/mysql/lock)：MDL 与行锁、间隙锁
- [主从复制与高可用](#/mysql/replication)：DDL 对复制延迟的影响
- [分库分表实践](#/mysql/sharding)：冷热分离、数据迁移
- [MySQL 优化器原理](#/mysql/optimizer)：变更后统计与计划变化
- [PG 锁与并发控制](#/pg/concurrency)：PG 中 DDL 锁队列的对照

## 面试追问

> [!QUESTION] 线上执行 ALTER TABLE 为什么会导致业务整体卡死？怎么避免？
> 因为 MDL：长事务或慢查询持有表的元数据读锁，ALTER 申请写锁被阻塞，之后所有对该表的读写都要申请读锁，排在写锁请求之后一起等待，连接被占满。避免：执行前检查并清理长事务和空闲事务，ALTER 前设置很短的 lock_wait_timeout 让它宁可失败也别排队，选低峰，大表用 gh-ost 这类可控工具。

> [!QUESTION] INSTANT、INPLACE、COPY 三种 DDL 算法有什么区别？
> INSTANT 只修改数据字典，不触碰数据，秒级完成，如加列、改默认值；INPLACE 在引擎内原地变更，多数允许并发 DML，有的操作需要重建表有的只建索引；COPY 创建临时表拷贝全部数据，期间阻塞写。生产上显式指定 ALGORITHM 和 LOCK，不满足就报错而不是悄悄退化为 COPY。

> [!QUESTION] Online DDL 是怎么做到并发 DML 的？有什么限制？
> 分准备、执行、提交三阶段：准备和提交阶段短暂持有独占 MDL，执行阶段降为共享锁，并发 DML 记录到 row log，提交阶段回放剩余增量后交换。限制包括 row log 有大小上限、写入太猛会失败，重建表的操作仍要完整拷贝耗 I/O 和磁盘，从库回放同样耗时导致延迟。

> [!QUESTION] gh-ost 和 pt-osc 有什么区别？为什么大表倾向 gh-ost？
> pt-osc 用触发器同步增量，触发器在业务事务内执行，增加写延迟和锁竞争，与外键、已有触发器有冲突；gh-ost 伪装成从库读 binlog 异步回放增量，不侵入主库写路径，可暂停、限速、感知延迟、随时中止且失败代价低。代价是需要 ROW 格式 binlog，对外键和触发器表不支持。

> [!QUESTION] 给一个 10 亿行的大表加字段，你怎么做？
> 先看版本能否 INSTANT 加列，能则秒级完成并设置 lock_wait_timeout 和低峰；不行再评估是否需要重建表，评估磁盘空间和主从延迟，用 gh-ost 在从库演练，限速并监控延迟与负载，用 postpone 标志位低峰切换，旧表保留观察期，应用侧按先加列、再发版兼容、再回填、再收紧的顺序发布。

> [!QUESTION] 怎么安全地清理大表历史数据？
> 不要一条大 DELETE：会产生巨大事务、undo 和 binlog，造成主从延迟和长时间锁；应按主键范围分批删除并在批间休眠，更好的是一开始就按时间分区，用 DROP PARTITION 秒级丢弃，并把历史数据冷热分离到归档存储，删除后用 OPTIMIZE 或影子表重建回收空间。
