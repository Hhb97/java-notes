---
level: 深入
tags: [MySQL, 备份, 恢复, mysqldump, XtraBackup, Clone, binlog, PITR, 热备, 备份校验, 容量规划, 巡检, 参数基线]
summary: MySQL 备份恢复与运维：逻辑备份与物理备份的原理与取舍（mysqldump/mydumper/XtraBackup/Clone）、XtraBackup 如何做到一致性热备（redo 拷贝与 LSN）、binlog 时间点恢复（PITR）完整流程与误删场景、备份校验与恢复演练、延迟从库与闪回、容量与碎片、参数基线与巡检、常见运维故障（磁盘满/连接满/大事务/复制中断）的处置。
---

# MySQL 备份恢复与日常运维

> [!ABSTRACT] 核心要点
> - **高可用不是备份**：主从/MGR 会把**误删、误更新、坏数据同步到所有副本**。备份解决的是“**逻辑错误与灾难**”，HA 解决的是“**节点故障**”。
> - **逻辑备份**（mysqldump/mydumper）导出 SQL/文本，可读、跨版本、可选择性恢复，但**大库恢复慢**（要重放 SQL、重建索引）；**物理备份**（XtraBackup/Clone/快照）拷贝数据文件，**备份与恢复速度快、适合 TB 级**，但依赖版本与配置。
> - **XtraBackup 的一致性靠“拷贝数据文件的同时持续拷贝 redo log”**：备份结束后用 **prepare** 阶段重放 redo，使数据文件回到备份结束时刻的一致点，并记录对应的 **binlog 位点/GTID**。
> - **PITR（时间点恢复）= 最近全量备份 + 之后的 binlog 重放到目标点**：**binlog 必须持续归档**，且要**保留到覆盖最老备份**；误操作的恢复要**重放到误操作之前**（按位点/GTID 跳过）。
> - **备份没演练过就等于没有**：定期**恢复验证**（能起库、数据可校验、耗时是否满足 RTO）；备份**异地、加密、监控、保留策略**缺一不可。
> - **运维的本质是容量与基线**：磁盘/连接/IOPS/复制延迟的**趋势监控**，参数基线统一，变更可回滚，这些比临时救火更重要。

## 备份类型与取舍

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="MySQL 备份方案对比：逻辑备份导出 SQL，可读可跨版本可选择性恢复，但恢复慢；物理备份拷贝数据文件，速度快适合大库，依赖版本和配置；快照备份依赖存储或云盘一致性快照，速度最快；binlog 备份保存增量日志，配合全量实现时间点恢复">
<rect class="b3" x="20" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">逻辑备份</text>
<text class="ts" x="195" y="60" text-anchor="middle">mysqldump / mydumper / MySQL Shell dump</text>
<text class="ts" x="195" y="82" text-anchor="middle">可读、跨版本、可按表/库恢复</text>
<text class="ts" x="195" y="104" text-anchor="middle">备份占用读负载，大库恢复很慢</text>
<text class="ts" x="195" y="126" text-anchor="middle">适合：中小库、迁移、结构备份</text>
<rect class="b5" x="390" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">物理备份</text>
<text class="ts" x="565" y="60" text-anchor="middle">XtraBackup / MySQL Enterprise Backup / Clone</text>
<text class="ts" x="565" y="82" text-anchor="middle">拷贝数据文件，备份恢复速度快</text>
<text class="ts" x="565" y="104" text-anchor="middle">版本/配置强相关，难以只恢复一张表</text>
<text class="ts" x="565" y="126" text-anchor="middle">适合：TB 级库的主力方案</text>
<rect class="b1" x="20" y="170" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="190" text-anchor="middle" dominant-baseline="middle">快照备份</text>
<text class="ts" x="195" y="216" text-anchor="middle">云盘快照 / LVM / ZFS 快照</text>
<text class="ts" x="195" y="238" text-anchor="middle">秒级创建，恢复快</text>
<text class="ts" x="195" y="260" text-anchor="middle">需保证一致性（FLUSH+锁 或 崩溃恢复可接受）</text>
<text class="ts" x="195" y="282" text-anchor="middle">要验证快照包含数据+redo+binlog</text>
<rect class="b2" x="390" y="170" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="190" text-anchor="middle" dominant-baseline="middle">binlog 增量备份</text>
<text class="ts" x="565" y="216" text-anchor="middle">持续归档 binlog 到远端存储</text>
<text class="ts" x="565" y="238" text-anchor="middle">全量 + 增量实现任意时间点恢复</text>
<text class="ts" x="565" y="260" text-anchor="middle">工具：mysqlbinlog --read-from-remote-server</text>
<text class="ts" x="565" y="282" text-anchor="middle">RPO 取决于归档的实时性</text>
</svg>
<figcaption>图 1：备份方案对比</figcaption>
</figure>

| 维度 | 逻辑备份 | 物理备份 | 快照 |
| --- | --- | --- | --- |
| 备份速度 | 慢（读全表、序列化） | 快（拷文件） | 极快 |
| 恢复速度 | **很慢**（重放 INSERT、重建索引） | 快（拷回、prepare、启动） | 快 |
| 粒度 | 库/表/甚至条件 | 实例级（可部分表，有限制） | 实例/卷级 |
| 跨版本 | 容易 | 受限（同大版本） | 受限 |
| 一致性 | `--single-transaction`（InnoDB） | redo + LSN | 需验证 |
| 对线上影响 | 读压力、长事务（undo 膨胀） | I/O 压力，拷贝线程 | 低 |
| 典型用途 | 小库、迁移、结构备份 | 生产大库全量/增量 | 云上快速备份 |

## 逻辑备份

```bash
# mysqldump：InnoDB 一致性快照备份（不锁表），同时记录 binlog 位点
mysqldump --single-transaction --source-data=2 --routines --triggers --events \
  --set-gtid-purged=ON --hex-blob --default-character-set=utf8mb4 \
  -h <host> -u <backup_user> -p <db> | gzip > db_$(date +%F).sql.gz
```

- **`--single-transaction`**：开启一个**一致性读事务（RR 快照）**，期间不锁表；**只对 InnoDB 一致**，MyISAM 表需要 `--lock-tables`；
- **`--source-data=2`**（旧参数 `--master-data=2`）：在备份里写入当时的 binlog 位点注释，用于**搭建从库/PITR 起点**；
- **长事务副作用**：备份期间的一致性读事务**阻止 purge undo**，对**写入繁忙库会导致 undo 膨胀**与历史链变长，**建议在从库上备份**；
- **`mydumper/myloader`**：**多线程并行导出/导入**，大库明显更快；**MySQL Shell `util.dumpInstance/loadDump`**（8.0）并行 + 压缩 + 分块，是官方推荐的新方案；
- **恢复慢的根因**：逐条 INSERT、二级索引边插边维护、binlog/redo 同步落盘；**加速**：关闭/降低 `sync_binlog`、`innodb_flush_log_at_trx_commit`（仅恢复期间）、先导数据后建索引、并行导入、`LOAD DATA`/`--tab` 导出；
- **注意**：权限、触发器、存储过程、事件、字符集要一起备份；**`mysql` 系统库**（账号权限）单独处理。

## 物理备份：XtraBackup 原理

### 热备如何保证一致

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="XtraBackup 热备流程：备份开始时记录起始 LSN，启动线程持续拷贝 redo log，同时多线程拷贝 InnoDB 数据文件，这些文件可能是不一致的因为拷贝期间有写入，拷完数据文件后短暂加锁获取 binlog 位点并拷贝非 InnoDB 文件，最后停止 redo 拷贝；prepare 阶段重放 redo 把数据文件推进到一致点，得到可直接启动的备份">
<rect class="b3" x="20" y="24" width="160" height="70" rx="8"/>
<text class="tb" x="100" y="46" text-anchor="middle" dominant-baseline="middle">① 记录起始 LSN</text>
<text class="ts" x="100" y="68" text-anchor="middle">启动 redo 拷贝线程</text>
<rect class="b5" x="200" y="24" width="170" height="70" rx="8"/>
<text class="tb" x="285" y="46" text-anchor="middle" dominant-baseline="middle">② 拷贝数据文件</text>
<text class="ts" x="285" y="68" text-anchor="middle">多线程，页可能不一致</text>
<rect class="b1" x="390" y="24" width="170" height="70" rx="8"/>
<text class="tb" x="475" y="46" text-anchor="middle" dominant-baseline="middle">③ 短暂锁定</text>
<text class="ts" x="475" y="68" text-anchor="middle">拷非 InnoDB，取 binlog 位点</text>
<rect class="b2" x="580" y="24" width="160" height="70" rx="8"/>
<text class="tb" x="660" y="46" text-anchor="middle" dominant-baseline="middle">④ 停止 redo 拷贝</text>
<text class="ts" x="660" y="68" text-anchor="middle">记录结束 LSN</text>
<line class="l" x1="180" y1="59" x2="200" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="59" x2="390" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="59" x2="580" y2="59" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="350" height="200" rx="8"/>
<text class="th" x="32" y="142">为什么数据文件不一致也能用</text>
<text class="ts" x="195" y="170" text-anchor="middle">拷贝期间页被修改，文件是“模糊”的</text>
<text class="ts" x="195" y="192" text-anchor="middle">但从起始 LSN 开始的 redo 全部被拷走</text>
<text class="ts" x="195" y="214" text-anchor="middle">重放 redo 能把任何页推进到结束 LSN</text>
<text class="ts" x="195" y="236" text-anchor="middle">这与崩溃恢复同一套机制</text>
<text class="ts" x="195" y="266" text-anchor="middle">风险：redo 被覆盖写（循环）来不及拷</text>
<text class="ts" x="195" y="288" text-anchor="middle">→ 备份失败，需调大 redo 或限速</text>
<rect class="bg" x="390" y="120" width="350" height="200" rx="8"/>
<text class="th" x="402" y="142">⑤ prepare 与恢复</text>
<text class="ts" x="565" y="170" text-anchor="middle">xtrabackup --prepare：重放 redo</text>
<text class="ts" x="565" y="192" text-anchor="middle">回滚未提交事务，得到一致数据文件</text>
<text class="ts" x="565" y="214" text-anchor="middle">xtrabackup --copy-back 拷回数据目录</text>
<text class="ts" x="565" y="236" text-anchor="middle">修正属主权限，启动实例</text>
<text class="ts" x="565" y="266" text-anchor="middle">xtrabackup_binlog_info 记录位点/GTID</text>
<text class="ts" x="565" y="288" text-anchor="middle">用于建从库或 PITR 起点</text>
</svg>
<figcaption>图 2：XtraBackup 热备的一致性机制</figcaption>
</figure>

```bash
# 全量备份（建议在从库执行），带压缩、并行
xtrabackup --backup --target-dir=/backup/full --parallel=4 --compress --compress-threads=4 \
  --host=<host> --user=<backup_user> --password=<从安全渠道读取>
# 增量备份（基于上一次的 LSN）
xtrabackup --backup --target-dir=/backup/inc1 --incremental-basedir=/backup/full
# 准备：先 apply-log-only 依次合并增量，最后一次完整 prepare
xtrabackup --prepare --apply-log-only --target-dir=/backup/full
xtrabackup --prepare --apply-log-only --target-dir=/backup/full --incremental-dir=/backup/inc1
xtrabackup --prepare --target-dir=/backup/full
# 恢复：停库，清空数据目录，拷回，改属主，启动
xtrabackup --copy-back --target-dir=/backup/full
chown -R mysql:mysql /var/lib/mysql
```

要点：

- **备份账号最小权限**：`BACKUP_ADMIN`、`RELOAD`、`PROCESS`、`LOCK TABLES`、`REPLICATION CLIENT` 等，**不要用 root**；**密码不要写在命令行**（会出现在进程列表与历史），用选项文件或安全凭据注入；
- **增量备份基于 LSN**：只拷贝自上次备份后**变更的页**（需要扫描页头，大库仍要读全部页头，或用 changed page tracking 加速）；**增量链越长恢复越慢且依赖链完整**，常见策略：**每周全量 + 每日增量 + 持续 binlog**；
- **备份压力**：并行线程、I/O 限速（`--throttle`）；**在从库备份**避免影响主库；
- **MDL 与 FTWRL**：为取得一致的 binlog 位点与非 InnoDB 数据，会短暂 `FLUSH TABLES WITH READ LOCK` 或使用 **backup locks**（Percona 的轻量备份锁，8.0 `LOCK INSTANCE FOR BACKUP`），**如果此时有长事务/慢查询，FTWRL 会被阻塞并引发类似 MDL 雪崩**，参见 [在线 DDL 与大表治理](#/mysql/online-ddl)；
- **加密与压缩**：备份文件含全部业务数据，**传输与落盘加密**；加密密钥与备份**分开保管**；
- **版本匹配**：XtraBackup 版本需与 MySQL 大版本匹配（8.0 用 8.0 版）。

### Clone 插件（8.0.17+）

```sql
INSTALL PLUGIN clone SONAME 'mysql_clone.so';
CLONE INSTANCE FROM 'clone_user'@'donor-host':3306 IDENTIFIED BY '<从安全渠道读取>';  -- 在接收端执行
```

- **物理级快照拷贝**（页拷贝 + redo 追赶），**远程克隆一个实例**，常用于**快速建从库/加入 MGR**；
- **不能替代备份策略**：它是实例间克隆，不含 binlog 归档与保留管理；备份文件形式有限；
- 限制：版本一致、参数需一致、克隆期间 DDL 被阻塞（`clone` 与 DDL 互斥）。

## binlog 与时间点恢复（PITR）

### 前提

- **`log_bin` 开启、格式 ROW**、GTID 建议开启；
- **binlog 持续归档到远端**（定时拷贝已轮转的，或用 `mysqlbinlog --read-from-remote-server --raw --stop-never` 实时拉取）；**本机 binlog 保留期（`binlog_expire_logs_seconds`）要覆盖“全量备份间隔 + 排障时间”**；
- 备份时记录**binlog 起始位点/GTID**。

### 流程

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="时间点恢复流程：选择误操作之前最近的全量备份，在隔离的恢复实例上恢复并应用增量，然后用 mysqlbinlog 从备份位点重放 binlog 到误操作之前，用 stop-position 或排除误操作事务的 GTID，校验数据后将需要的数据导出回生产库或切换业务">
<rect class="b3" x="20" y="30" width="165" height="76" rx="8"/>
<text class="tb" x="102" y="52" text-anchor="middle" dominant-baseline="middle">① 选备份</text>
<text class="ts" x="102" y="76" text-anchor="middle">误操作前最近全量</text>
<rect class="b5" x="205" y="30" width="165" height="76" rx="8"/>
<text class="tb" x="287" y="52" text-anchor="middle" dominant-baseline="middle">② 隔离恢复</text>
<text class="ts" x="287" y="76" text-anchor="middle">独立实例，不碰生产</text>
<rect class="b1" x="390" y="30" width="165" height="76" rx="8"/>
<text class="tb" x="472" y="52" text-anchor="middle" dominant-baseline="middle">③ 重放 binlog</text>
<text class="ts" x="472" y="76" text-anchor="middle">到误操作之前一刻</text>
<rect class="b2" x="575" y="30" width="165" height="76" rx="8"/>
<text class="tb" x="657" y="52" text-anchor="middle" dominant-baseline="middle">④ 校验与回填</text>
<text class="ts" x="657" y="76" text-anchor="middle">导出差异数据回生产</text>
<line class="l" x1="185" y1="68" x2="205" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="68" x2="390" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="555" y1="68" x2="575" y2="68" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="720" height="150" rx="8"/>
<text class="th" x="32" y="152">重放要点</text>
<text class="ts" x="380" y="180" text-anchor="middle">按位点：mysqlbinlog --start-position=备份位点 --stop-position=误操作前位点 | mysql</text>
<text class="ts" x="380" y="204" text-anchor="middle">按时间：--start-datetime / --stop-datetime（时间精度到秒，不如位点精确）</text>
<text class="ts" x="380" y="228" text-anchor="middle">按 GTID：--exclude-gtids 跳过误操作事务，保留之后的事务（避免丢后续数据）</text>
<text class="ts" x="380" y="252" text-anchor="middle">多个 binlog 文件要一次性管道给 mysql 重放，避免 tmp 状态丢失</text>
<text class="ts" x="380" y="272" text-anchor="middle">原则：不直接在生产库上重放，先在隔离实例验证</text>
</svg>
<figcaption>图 3：时间点恢复（PITR）流程</figcaption>
</figure>

```bash
# 在恢复实例上：从备份位点重放到误操作位点之前
mysqlbinlog --start-position=<备份位点> --stop-position=<误操作位点> \
  binlog.000123 binlog.000124 | mysql -u<user> -p
# GTID 场景：跳过误操作事务，保留之后的
mysqlbinlog --exclude-gtids='<uuid>:<误操作事务号>' binlog.000123 binlog.000124 | mysql ...
```

**定位误操作位点**：`mysqlbinlog -vv --base64-output=decode-rows binlog.000123 | grep -n -B5 -A20 "DELETE FROM t"`，或用 `SHOW BINLOG EVENTS IN '...' FROM ...`。

### 误删/误更新的处置策略

| 场景 | 方案 |
| --- | --- |
| **误 DELETE/UPDATE 少量行** | **闪回**：解析 binlog 生成反向 SQL（`binlog2sql`、MyFlash 等开源工具，需 ROW 格式且 `binlog_row_image=FULL`），在**确认后**执行；风险：之后又被改过的行需要人工判断 |
| **误 DROP/TRUNCATE 表** | DDL 不可闪回（binlog 只记录语句）：**备份 + binlog 重放**到隔离实例，导出该表再导入生产 |
| **误改线上大量数据** | **延迟从库**（`SOURCE_DELAY`）在延迟窗口内停止复制，从延迟从库取回数据 |
| **整库损坏/勒索** | 全量物理备份 + binlog PITR，异地不可变备份（对象存储 WORM/版本控制） |
| **应用 Bug 写坏数据** | PITR 到隔离实例，取出正确数据**对比修复**，而不是回滚整个库（会丢后续合法写入） |

**预防措施**：生产权限收敛（开发无直接 DDL/DML 权限）、变更走审批平台、`sql_safe_updates` 防无 WHERE、高危操作二次确认与自动备份、逻辑删除/回收站设计。

## 备份体系建设

### 策略与指标

- **RPO**：由 binlog 归档的实时性决定（实时拉取 ≈ 秒级）；**RTO**：由**最慢环节**决定——**下载备份 + 解压 + prepare + 重放 binlog + 校验**，**实测才可信**；
- **保留策略**：全量按周/月，增量按天，binlog 与最老备份对齐；**异地一份（跨可用区/地域）**，**重要备份不可变（防误删/勒索）**；
- **备份位置**：**不要放在同一台机器/同一存储**；备份在**从库**执行，避免影响主库；
- **监控**：备份任务是否成功、大小趋势（突然变小=异常）、耗时趋势、binlog 归档延迟、备份文件校验。

### 恢复演练与校验

- **定期（至少每月/季）**把最新备份**恢复到独立环境**：能起库、`CHECK TABLE` 或业务校验 SQL 通过、行数/校验和抽样对比、**计时**得出真实 RTO；
- **自动化**：恢复后自动跑**校验脚本**（关键表行数、最大主键、业务指标），失败告警；
- **校验主从一致**：`pt-table-checksum` 校验主从数据一致性，`pt-table-sync` 修复（谨慎）；
- **备份即数据副本**：可用于**搭建测试环境（脱敏后）**，同时检验备份可用性。

## 日常运维

### 容量与碎片

| 项 | 要点 |
| --- | --- |
| **磁盘** | 数据 + undo + redo + binlog + 临时文件 + **备份/DDL 所需的 2~3 倍空间**；**使用率告警 70%/85%**，趋势预测增长；**磁盘写满会导致 MySQL 挂起或崩溃** |
| **binlog** | `binlog_expire_logs_seconds` 合理设置；**大事务/批量变更会让 binlog 暴涨**；注意备份归档后才允许清理 |
| **临时空间** | 排序/临时表/DDL 使用 `tmpdir`、`innodb_tmpdir`，要有独立空间 |
| **表空间碎片** | 大量 DELETE/UPDATE 后页内空洞，`DATA_FREE` 大；回收见 [在线 DDL 与大表治理](#/mysql/online-ddl)；注意**页分裂**由随机主键造成 |
| **undo 膨胀** | 长事务阻止 purge，**History list length** 持续增长，监控 `trx_rseg_history_len`，**杀掉长事务** |

### 参数基线（需结合业务与硬件验证，下列为常见起点而非定值）

| 参数 | 常见建议 | 说明 |
| --- | --- | --- |
| `innodb_buffer_pool_size` | 物理内存 50%~75%（专用库） | 最关键，命中率与脏页管理见 [InnoDB 存储结构与 Buffer Pool](#/mysql/storage) |
| `innodb_log_file_size`/`innodb_redo_log_capacity` | 足够容纳约 1 小时写入 | 太小频繁刷脏，太大恢复久 |
| `innodb_flush_log_at_trx_commit` / `sync_binlog` | 核心库 `1/1`（双 1） | 见 [redo / undo / binlog](#/mysql/log) |
| `innodb_io_capacity(_max)` | 按磁盘 IOPS 设置 | SSD 通常需调高，默认偏低 |
| `max_connections` | 按业务+池大小规划 | **连接数 × 每连接内存**要在内存预算内 |
| `binlog_format` | ROW | 复制与闪回的基础 |
| `gtid_mode` / `enforce_gtid_consistency` | ON | 简化切换 |
| `transaction_isolation` | RC 或 RR（按业务） | 与锁行为相关 |
| `slow_query_log` / `long_query_time` | 开 / 0.5~1s | 配合 pt-query-digest |
| `lock_wait_timeout` / `innodb_lock_wait_timeout` | 短超时 | 避免无限排队 |
| `skip_name_resolve` | ON | 避免 DNS 反查拖慢连接 |
| `sql_mode` | 严格模式 | 避免静默截断 |
| `super_read_only`（从库） | ON | 防止误写 |

参数基线**配置化管理**（版本库+变更审批），**所有实例一致**，差异需有理由。

### 日常巡检

- **复制**：延迟、线程状态、错误；
- **连接**：`Threads_connected`/`Threads_running`、`Aborted_connects`、连接数水位；
- **慢查询**：Top N、新增慢 SQL；
- **锁**：`innodb_trx` 长事务、`data_lock_waits`、死锁日志（`innodb_print_all_deadlocks`）；
- **空间**：库/表大小增长、碎片率、自增列使用率（INT 耗尽预警）；
- **备份**：最近成功时间、校验结果；
- **账号**：弱口令、过宽权限、长期未使用账号；
- **版本与补丁**：安全补丁、EOL 计划。

### 常见故障处置

| 故障 | 现象 | 处置 |
| --- | --- | --- |
| **连接数打满**（Too many connections） | 新连接被拒 | 保留一个 `SUPER`/`CONNECTION_ADMIN` 连接；找出占用方（`processlist` 聚合）；杀掉堆积的慢/睡眠连接；限流；排查根因（慢 SQL、MDL 阻塞、连接池泄漏）；**不要一味调大 `max_connections`** |
| **磁盘满** | 写入失败/实例挂起 | 先清理可删的（旧 binlog 需确认已归档、临时文件、慢日志）；扩容；找出暴涨原因（大事务、binlog、临时表、备份）；**不要直接删数据文件** |
| **复制中断** | `Last_Error` | 看错误类型：主键冲突/行不存在 → 判断数据是否被改写；GTID 下用**注入空事务**跳过（需确认数据一致性）；**不要盲目跳错**，优先重建或 `pt-table-sync` |
| **主从延迟突增** | 秒数持续升高 | 查大事务、DDL、从库资源（I/O、CPU）、并行复制配置、网络；见 [主从复制与高可用](#/mysql/replication) |
| **大事务/长事务** | undo 膨胀、延迟、锁等待 | 找出并 kill；拆分事务；`innodb_trx` 监控 |
| **OOM 被杀** | mysqld 重启 | 检查 buffer pool、连接数×会话缓冲、临时表；加 swap 保护不是长期方案；调整参数 |
| **实例崩溃重启慢** | 崩溃恢复卡很久 | 看 redo 大小与脏页量；`innodb_force_recovery` 仅用于抢救数据（**只读导出后重建**） |
| **表损坏**（页校验失败） | 报 corruption | 从备份/从库恢复；`innodb_force_recovery` 抢救；**不要在原库反复重试** |

> [!WARNING] 危险操作清单
> `innodb_force_recovery`、`RESET MASTER/RESET BINARY LOGS`、`SET GLOBAL sql_slave_skip_counter`、`kill -9 mysqld`、直接删除 `ib_logfile`/binlog 文件、`DROP`/`TRUNCATE`、批量 `UPDATE/DELETE` 无 WHERE，都应**有审批、有备份、有回滚预案**。

## 备份与运维清单

- [ ] 是否同时具备全量备份与 binlog 持续归档，并满足 RPO？
- [ ] 备份是否在从库执行、异地保存、加密、不可变保留？
- [ ] 是否定期做恢复演练并实测 RTO，校验数据一致？
- [ ] 备份账号是否最小权限，密码是否不出现在命令行？
- [ ] 是否有误操作恢复预案（闪回/延迟从库/PITR）并演练过？
- [ ] 磁盘、binlog、undo、连接数、复制延迟是否有趋势告警？
- [ ] 参数基线是否配置化管理，从库是否 `super_read_only`？
- [ ] 危险操作是否有审批与备份前置？

## 相关阅读

- [redo / undo / binlog](#/mysql/log)：redo 与崩溃恢复、binlog 格式
- [主从复制与高可用](#/mysql/replication)：延迟从库、GTID、读写分离
- [MySQL 高可用：半同步、MGR 与切换实战](#/mysql/ha-mgr)：HA 与备份互补
- [在线 DDL 与大表治理](#/mysql/online-ddl)：变更空间、碎片回收与 MDL
- [InnoDB 存储结构与 Buffer Pool](#/mysql/storage)：刷脏、Checkpoint 与容量
- [PG 备份与 PITR](#/pg/wal-replication)：PG 的 WAL 归档与时间点恢复对照

## 面试追问

> [!QUESTION] 有了主从复制/MGR 为什么还要备份？
> 复制会把误删、误更新、坏数据实时同步到所有副本，HA 只解决节点故障；备份（全量加 binlog）才能恢复到误操作之前的时间点，还能抵御机房级灾难和勒索。两者目标不同，互补而非替代。

> [!QUESTION] 逻辑备份和物理备份有什么区别？怎么选？
> 逻辑备份导出 SQL，可读、跨版本、可按表恢复，但大库恢复很慢，因为要重放 SQL 并重建索引；物理备份拷贝数据文件，备份恢复速度快，适合 TB 级，但依赖版本和配置、难以只恢复单表。小库、迁移、结构备份用逻辑，大库主力用物理，加 binlog 做增量。

> [!QUESTION] XtraBackup 为什么能在不锁表的情况下做到一致性备份？
> 备份开始记录起始 LSN，并启动线程持续拷贝 redo log，同时拷贝数据文件，此时文件页可能是模糊的；因为从起始 LSN 起的 redo 都被保存，prepare 阶段重放 redo 并回滚未提交事务，就能把所有页推进到一致点，原理与崩溃恢复相同。最后短暂加备份锁取 binlog 位点和非 InnoDB 文件。

> [!QUESTION] 怎么做时间点恢复？误删了一张表怎么办？
> 选误操作之前最近的全量备份在隔离实例恢复，再用 mysqlbinlog 从备份记录的位点重放 binlog 到误操作之前，可按位点、时间或用 GTID 排除误操作事务，校验后把该表导出导入生产，不直接在生产库重放。前提是 binlog 持续归档并覆盖最老备份。

> [!QUESTION] 备份验证怎么做？为什么重要？
> 定期把最新备份恢复到独立环境，验证能启动、跑校验 SQL、对比行数或校验和、记录完整耗时得到真实 RTO，并自动化告警。没有恢复演练的备份可能因为版本不匹配、文件损坏、binlog 缺失而在真正需要时不可用。

> [!QUESTION] 线上连接数被打满了怎么处理？
> 先用预留的高权限连接登录，聚合 processlist 找出占用方，杀掉堆积的慢查询或睡眠连接，限流保护；再排查根因，常见是慢 SQL、MDL 阻塞、连接池泄漏或下游故障。不要只是调大 max_connections，那会放大内存压力。

> [!QUESTION] 复制报错中断了能直接跳过吗？
> 不要盲目跳过：先看错误类型，判断是主键冲突还是行不存在，确认主从数据是否已不一致。GTID 模式下可以注入空事务跳过单个事务，但必须评估一致性，更稳妥的是用 pt-table-checksum 校验后用 pt-table-sync 修复，或重建从库。
