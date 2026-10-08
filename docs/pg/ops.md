---
level: 进阶
tags: [PostgreSQL, 流复制, 逻辑复制, Patroni, PITR, 分区表, PgBouncer, JSONB, 扩展]
summary: PostgreSQL 的物理与逻辑复制、同步级别与复制槽、Patroni 高可用与故障切换、备份与 PITR、声明式分区、常用扩展（pg_stat_statements、PostGIS、pgvector、TimescaleDB），以及 Java 应用的使用建议。
---

# 复制、高可用与实战

> [!ABSTRACT] 核心要点
> - **物理流复制**：备库持续接收并重放主库 **WAL**，字节级一致，用于高可用与读扩展；**逻辑复制**按表/行变更复制（发布-订阅），可跨大版本、选表、异构同步。
> - **同步复制**通过 `synchronous_commit` 与 `synchronous_standby_names` 控制，选择 `remote_write/on/remote_apply` 在**一致性与延迟**间折中；复制槽防止 WAL 过早被清理，但**滞后的槽会撑爆主库磁盘并阻止 VACUUM**。
> - 高可用靠 **Patroni（etcd/Consul/ZooKeeper 做 DCS 选主）+ HAProxy/VIP**，不要自己手写故障切换脚本；PG 本身只提供 `pg_promote` 等原语。
> - 备份：**逻辑备份（pg_dump）** 和 **物理备份 + WAL 归档（PITR）**；生产必须有**可验证的恢复演练**。
> - **声明式分区**（range/list/hash）+ 分区裁剪是单库管理海量数据的第一选择，先于分库分表。

## 物理流复制

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="PostgreSQL 流复制：主库 WAL sender 将 WAL 发送到备库 WAL receiver，备库 startup 进程重放">
<rect class="bg" x="20" y="20" width="320" height="240" rx="12"/>
<text class="th" x="40" y="46">Primary 主库</text>
<rect class="b1" x="40" y="62" width="130" height="44" rx="8"/>
<text class="tb" x="105" y="84" text-anchor="middle" dominant-baseline="middle">Backend 写入</text>
<rect class="b3" x="40" y="130" width="130" height="44" rx="8"/>
<text class="tb" x="105" y="152" text-anchor="middle" dominant-baseline="middle">WAL 文件 pg_wal</text>
<rect class="b2" x="190" y="130" width="130" height="44" rx="8"/>
<text class="tb" x="255" y="152" text-anchor="middle" dominant-baseline="middle">walsender</text>
<line class="l" x1="105" y1="106" x2="105" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="152" x2="190" y2="152" marker-end="url(#arr)"/>
<text class="ts" x="40" y="206">replication slot 记录备库已消费位置</text>
<text class="ts" x="40" y="226">保证未消费的 WAL 不被回收</text>
<rect class="bg" x="400" y="20" width="320" height="240" rx="12"/>
<text class="th" x="420" y="46">Standby 备库（hot_standby 可读）</text>
<rect class="b2" x="420" y="130" width="130" height="44" rx="8"/>
<text class="tb" x="485" y="152" text-anchor="middle" dominant-baseline="middle">walreceiver</text>
<rect class="b3" x="580" y="130" width="120" height="44" rx="8"/>
<text class="tb" x="640" y="152" text-anchor="middle" dominant-baseline="middle">本地 WAL</text>
<rect class="b5" x="580" y="62" width="120" height="44" rx="8"/>
<text class="tb" x="640" y="84" text-anchor="middle" dominant-baseline="middle">startup 重放</text>
<rect class="b5" x="420" y="62" width="130" height="44" rx="8"/>
<text class="tb" x="485" y="84" text-anchor="middle" dominant-baseline="middle">只读查询</text>
<line class="la" x1="320" y1="152" x2="420" y2="152" marker-end="url(#arr-a)"/>
<text class="ta" x="370" y="142" text-anchor="middle">TCP 流式</text>
<line class="l" x1="550" y1="152" x2="580" y2="152" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="130" x2="640" y2="106" marker-end="url(#arr)"/>
<line class="ld" x1="580" y1="84" x2="550" y2="84"/>
<text class="ts" x="420" y="206">应用：读写分离的只读流量</text>
<text class="ts" x="420" y="226">重放与查询冲突 → 查询可能被取消</text>
</svg>
<figcaption>图 1：物理流复制：主库 walsender → 备库 walreceiver，startup 进程重放</figcaption>
</figure>

搭建要点：

```bash
# 主库 postgresql.conf
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
hot_standby = on
# 主库创建复制用户并在 pg_hba.conf 放行，然后在备库：
pg_basebackup -h primary -U repl -D /var/lib/postgresql/data -R -X stream -C -S standby1_slot
# -R 自动生成 standby.signal 与 primary_conninfo；-C -S 创建复制槽
```

### 同步级别

| `synchronous_commit` | 含义 | 风险 |
| --- | --- | --- |
| `off` | 不等本地 WAL 刷盘 | 崩溃丢最近数百毫秒事务（数据不损坏） |
| `local` | 等本地 WAL 刷盘 | 异步复制，主库故障可能丢未传到备库的事务 |
| `remote_write` | 备库**收到并写入 OS 缓存** | 备库同时崩溃可能丢 |
| `on`（默认） | 配置了同步备库时，**备库 WAL 刷盘** | 备库已持久化 |
| `remote_apply` | 备库**已重放可见** | 延迟最高，备库读到最新数据 |

```text
synchronous_standby_names = 'ANY 1 (s1, s2)'     # 基于仲裁：任意 1 个备库确认即可（推荐，避免单个备库故障阻塞写）
synchronous_standby_names = 'FIRST 1 (s1, s2)'   # 优先级：按顺序
```

没有可用的同步备库时，**写事务会一直等待**（与 MySQL 半同步“超时退化”不同，PG 默认**阻塞**以保证不丢），需要监控与自动降级策略（Patroni 可配置 `synchronous_mode`）。

### 复制延迟与冲突

- 延迟监控：`pg_stat_replication`（主库，`write_lag/flush_lag/replay_lag`）、备库 `pg_last_wal_replay_lsn()`、`now() - pg_last_xact_replay_timestamp()`；
- **备库查询与重放冲突**：主库 VACUUM 清掉了备库长查询还需要的旧版本，重放会等待或取消查询（`max_standby_streaming_delay`，默认 30s，超时取消查询，报 `canceling statement due to conflict with recovery`）。缓解：`hot_standby_feedback = on`（但会让主库**无法回收**，造成膨胀）、拆分报表备库、调大延迟；
- 读写分离的**读一致性**：读自己的写要走主库，或 `remote_apply`，或应用侧等待 LSN。思路同 [主从复制与高可用](#/mysql/replication)。

### 复制槽的风险

```sql
SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal FROM pg_replication_slots;
```

槽保证备库没拿走的 WAL 不被删除；**备库长时间掉线时 WAL 会无限堆积把主库磁盘写满**，必须监控并设置 `max_slot_wal_keep_size`（13+，超限则作废槽）。废弃的槽要及时 `pg_drop_replication_slot`。

## 逻辑复制

基于 WAL 解码为**行级逻辑变更**（INSERT/UPDATE/DELETE）：

```sql
-- 发布端（wal_level = logical）
CREATE PUBLICATION pub_orders FOR TABLE orders, order_items;
-- 订阅端
CREATE SUBSCRIPTION sub_orders CONNECTION 'host=src dbname=app user=repl' PUBLICATION pub_orders;
```

| 场景 | 说明 |
| --- | --- |
| **跨大版本升级** | 新版本库订阅旧版本，数据追平后切换，近似零停机 |
| 选表/选列复制 | 只同步需要的表（15+ 支持列过滤、行过滤） |
| 数据汇聚/分发 | 多源汇总、报表库 |
| **CDC 到下游** | Debezium 通过 pgoutput/wal2json 读取逻辑复制槽，写入 Kafka 再同步到 ES 等 |

限制：**不复制 DDL 与序列值**（序列需手工同步）、大对象；表需要有主键或设置 `REPLICA IDENTITY`；冲突不自动解决。对应 MySQL 的 binlog + Canal 方案见 [ES 实战与数据同步](#/mw/es-practice)。

## 高可用：Patroni

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Patroni 高可用架构：每个 PG 节点运行 Patroni，通过 etcd 选主，HAProxy 路由读写流量">
<rect class="b" x="260" y="20" width="240" height="46" rx="10"/>
<text class="tb" x="380" y="43" text-anchor="middle" dominant-baseline="middle">应用（JDBC / 连接池）</text>
<rect class="b3" x="260" y="96" width="240" height="46" rx="10"/>
<text class="tb" x="380" y="112" text-anchor="middle" dominant-baseline="middle">HAProxy / VIP / PgBouncer</text>
<text class="ts" x="380" y="130" text-anchor="middle">按 Patroni REST /primary /replica 健康检查路由</text>
<line class="l" x1="380" y1="66" x2="380" y2="96" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="190" width="200" height="110" rx="12"/>
<text class="th" x="120" y="214" text-anchor="middle">节点 1：Leader</text>
<text class="ts" x="120" y="240" text-anchor="middle">Patroni + PostgreSQL 主库</text>
<text class="ts" x="120" y="260" text-anchor="middle">持有 etcd 中的 leader key</text>
<text class="ts" x="120" y="280" text-anchor="middle">定期续租（ttl 30s）</text>
<rect class="b1" x="280" y="190" width="200" height="110" rx="12"/>
<text class="th" x="380" y="214" text-anchor="middle">节点 2：Replica</text>
<text class="ts" x="380" y="240" text-anchor="middle">Patroni + PG 备库（流复制）</text>
<text class="ts" x="380" y="260" text-anchor="middle">监视 leader key</text>
<text class="ts" x="380" y="280" text-anchor="middle">失效时参与选主</text>
<rect class="b1" x="540" y="190" width="200" height="110" rx="12"/>
<text class="th" x="640" y="214" text-anchor="middle">节点 3：Replica</text>
<text class="ts" x="640" y="240" text-anchor="middle">Patroni + PG 备库</text>
<text class="ts" x="640" y="260" text-anchor="middle">可设 nofailover 仅作报表</text>
<line class="l" x1="320" y1="142" x2="120" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="142" x2="380" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="236" y="172" text-anchor="middle">写</text>
<text class="ts" x="394" y="172" text-anchor="start">读</text>
<line class="la" x1="220" y1="245" x2="280" y2="245" marker-end="url(#arr-a)"/>
<line class="la" x1="480" y1="245" x2="540" y2="245" marker-end="url(#arr-a)"/>
<rect class="b5" x="560" y="30" width="180" height="76" rx="10"/>
<text class="tb" x="650" y="52" text-anchor="middle" dominant-baseline="middle">DCS：etcd 集群</text>
<text class="ts" x="650" y="74" text-anchor="middle">存放 leader key 与集群状态</text>
<text class="ts" x="650" y="92" text-anchor="middle">（Consul / ZooKeeper 亦可）</text>
<line class="ld" x1="640" y1="190" x2="650" y2="106"/>
</svg>
<figcaption>图 2：Patroni 以分布式配置存储（DCS）保证只有一个 Leader</figcaption>
</figure>

工作机制：

1. 每个节点运行 Patroni 守护进程管理本机 PG；Leader 持续**续租** etcd 中的 leader key；
2. Leader 失败（进程崩溃/网络隔离）→ key 过期 → 备库竞争，**WAL 最新者优先**（受 `maximum_lag_on_failover` 限制）成为新主，其余备库重新跟随；
3. 旧主恢复后自动 **pg_rewind** 回退到分叉点，作为备库重新加入；
4. **脑裂防护**：Leader 若**无法续租** key 会自降级为只读（依赖 DCS 多数派，奇数节点 etcd），不会出现双主；
5. 应用通过 HAProxy/VIP/**多主机 JDBC 连接串**接入。

```text
# JDBC 多主机故障转移（驱动自动探测主库）
jdbc:postgresql://pg1:5432,pg2:5432,pg3:5432/app?targetServerType=primary&loadBalanceHosts=false
# 读流量：targetServerType=preferSecondary
```

其他方案：**repmgr**（轻量）、**云厂商 RDS**（托管 HA）、**Citus**（分布式 PG）。Kubernetes 上常用 **CloudNativePG / Zalando Postgres Operator**（底层也是 Patroni 思路）。

## 备份与 PITR

| 方式 | 工具 | 特点 |
| --- | --- | --- |
| 逻辑备份 | `pg_dump/pg_dumpall` | 可选表/跨版本，**恢复慢**，适合中小库与迁移 |
| 物理全量 | `pg_basebackup`、**pgBackRest**、Barman | 快，恢复快；支持增量/差异、并行、压缩、校验 |
| **WAL 归档 + PITR** | `archive_command` + `recovery_target_time` | 恢复到**任意时间点**（误删数据前一秒） |

PITR 流程：恢复最近一次全量基础备份 → 配置 `restore_command` 取归档 WAL → 指定 `recovery_target_time = '2026-01-01 10:00:00'` → 启动重放到该点 → `pg_promote`。

> [!WARNING] 没有演练过的备份不算备份
> 定期把备份恢复到测试环境并校验数据，记录恢复耗时（RTO）与可接受丢失量（RPO）。备份要**异地、加密、监控归档是否连续**（归档断档会导致 PITR 失败）。

## 声明式分区

```sql
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  device_id bigint NOT NULL,
  ts timestamptz NOT NULL,
  payload jsonb,
  PRIMARY KEY (id, ts)                            -- 主键/唯一键必须包含分区键
) PARTITION BY RANGE (ts);

CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_default PARTITION OF events DEFAULT;       -- 兜底分区（避免插入失败）
```

| 类型 | 适用 |
| --- | --- |
| RANGE | 时间序列、日志（按月/日） |
| LIST | 按租户、地区、状态 |
| HASH | 无天然范围，均匀打散 |

好处与要点：

- **分区裁剪（partition pruning）**：查询带分区键条件时只扫描相关分区（EXPLAIN 中看到被裁剪）；
- **清理历史数据极快**：`DROP/DETACH PARTITION` 取代大批量 `DELETE`（后者产生海量死元组与 WAL）；
- 每个分区可单独 VACUUM、建索引、放不同表空间；
- 分区数不宜过多（通常几百个以内），否则规划时间增加；
- 自动化创建未来分区：`pg_partman` 扩展或定时任务。

优先用分区解决“单表过大”，再考虑分库分表（见 [分库分表实践](#/mysql/sharding)，思路相通）。

## 常用扩展

| 扩展 | 用途 |
| --- | --- |
| **pg_stat_statements** | SQL 统计，慢查询定位（必装） |
| **pg_repack** | 在线重整膨胀的表/索引 |
| **pg_partman** | 分区自动管理 |
| **PostGIS** | 地理空间，行业标准 |
| **pgvector** | 向量类型与相似度检索（HNSW/IVFFlat 索引），用于 AI 向量检索 |
| **TimescaleDB** | 时序数据：自动分区（hypertable）、压缩、连续聚合，适合 [IoT 物联网](#/iot/platform) 遥测 |
| **pg_trgm / btree_gin / btree_gist** | 模糊匹配与组合索引能力 |
| **postgres_fdw** | 外部表，跨库查询 |
| **pgcrypto** | 加密函数 |

## JSONB：关系型 + 文档型

```sql
CREATE TABLE device (
  id bigint PRIMARY KEY,
  model text NOT NULL,
  attrs jsonb NOT NULL DEFAULT '{}'
);
SELECT attrs->'firmware'->>'version' FROM device WHERE attrs @> '{"online": true}';
UPDATE device SET attrs = jsonb_set(attrs, '{firmware,version}', '"2.1.0"') WHERE id = 1;
```

适合“核心字段列化、扩展属性放 JSONB”的混合模型（设备属性、配置、动态表单）。注意：JSONB 更新是**整个值重写**（大 JSONB 频繁小改写放大严重），不要把应该规范化的数据都塞进 JSONB；需要查询/约束的字段仍应提升为普通列（可用生成列）。

## Java 应用实践

- **驱动**：`org.postgresql:postgresql`，配合 HikariCP；`jdbc:postgresql://...?reWriteBatchedInserts=true`；
- **MyBatis / JPA**：
  - 主键自增用 `GENERATED ... AS IDENTITY`，MyBatis `useGeneratedKeys` 通过 `RETURNING` 实现；
  - 分页 `LIMIT ? OFFSET ?`，大偏移改键集分页，见 [索引类型与查询优化](#/pg/index)；
  - `jsonb` 类型需要 TypeHandler（或 `PGobject`）；数组类型用 `Array`/`TypeHandler`；
  - 批量 upsert：`INSERT ... ON CONFLICT (key) DO UPDATE SET ...`（对应 MySQL 的 `ON DUPLICATE KEY UPDATE`）；
- **事务**：出错后事务处于 aborted 状态，必须回滚或使用 `SAVEPOINT`；
- **监控指标**：连接数/等待事件、复制延迟、死元组与 autovacuum、XID age、缓存命中率（`pg_stat_database`）、WAL 生成速率、慢 SQL、锁等待；
- **常用排查 SQL**：

```sql
SELECT pid, state, wait_event_type, wait_event, now()-query_start AS dur, left(query,100)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;          -- 当前活跃与等待
SELECT pg_cancel_backend(pid);       -- 取消查询（温和）
SELECT pg_terminate_backend(pid);    -- 终止连接
SELECT datname, round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2) AS cache_hit FROM pg_stat_database;
```

## 面试追问

> [!QUESTION] PostgreSQL 的流复制原理？同步和异步怎么选？
> 主库 walsender 把 WAL 流式发送给备库 walreceiver，备库 startup 进程重放。异步性能好但主库故障可能丢数据；同步（`synchronous_commit` + `synchronous_standby_names`）保证已提交事务在备库持久化，代价是延迟和备库故障时写入阻塞，常用 `ANY n` 仲裁并配合自动降级。

> [!QUESTION] 复制槽有什么作用与风险？
> 槽记录备库消费位置，保证未被消费的 WAL 不被主库回收；风险是备库长期落后会让 WAL 堆积撑满主库磁盘，并且槽的 xmin 会阻止 VACUUM；需监控并设置 `max_slot_wal_keep_size`。

> [!QUESTION] 如何实现 PostgreSQL 高可用？如何避免脑裂？
> 用 Patroni + etcd：leader key 租约保证单主；Leader 无法续租则自降级；备库选举 WAL 最新的节点；旧主用 pg_rewind 回归；前端用 HAProxy/VIP/多主机 JDBC 路由。依赖 DCS 多数派避免双主。

> [!QUESTION] 逻辑复制与物理复制的区别和用途？
> 物理复制重放 WAL，整库字节级一致，用于 HA 与读扩展；逻辑复制传输行变更，可选表、跨大版本、异构，用于升级迁移与 CDC，但不复制 DDL 和序列。

> [!QUESTION] 为什么推荐分区表？有什么注意？
> 分区裁剪减少扫描，历史数据通过 DROP/DETACH 分区快速清理而不产生死元组；注意主键须包含分区键、分区数量不宜过多、需要自动创建分区、跨分区查询要带分区键条件。
