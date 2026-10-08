---
level: 深入
tags: [binlog, 主从复制, 半同步, GTID, 并行复制, MGR, 高可用]
summary: 从 binlog 复制线程模型出发，讲清异步/半同步/MGR 的一致性差异、GTID 与并行复制，以及主从延迟和故障切换的工程处理。
---

# 主从复制与高可用

> [!ABSTRACT] 核心要点
> - 复制本质是**把主库 binlog 在从库重放**：主库 Dump 线程推送 → 从库 IO 线程写 relay log → SQL 线程（或多个 worker）回放。
> - 默认**异步复制**，主库提交不等从库，主库宕机可能丢数据；**半同步**（推荐 `AFTER_SYNC`）至少一个从库收到 binlog 才返回；**MGR** 基于 Paxos 变体实现多数派提交。
> - **GTID** 给每个事务全局唯一编号，使 failover 时不再需要手工找 binlog 位点。
> - 从库延迟的主因是**单线程回放**与大事务；并行复制从“按库”演进到 **WRITESET**（基于行冲突），延迟可降一个数量级。
> - 读写分离必须处理**读自己的写**：关键读走主库、延迟感知路由、或等待 GTID 追平。

## 复制的基本流程

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="MySQL 主从复制：binlog、Dump 线程、IO 线程、relay log、SQL 线程">
<rect class="bg" x="20" y="20" width="300" height="260" rx="12"/>
<text class="th" x="40" y="46">Master</text>
<rect class="b1" x="40" y="66" width="120" height="44" rx="8"/>
<text class="tb" x="100" y="88" text-anchor="middle" dominant-baseline="middle">事务提交</text>
<rect class="b3" x="40" y="150" width="120" height="44" rx="8"/>
<text class="tb" x="100" y="172" text-anchor="middle" dominant-baseline="middle">binlog 文件</text>
<rect class="b2" x="190" y="150" width="110" height="44" rx="8"/>
<text class="tb" x="245" y="172" text-anchor="middle" dominant-baseline="middle">Dump 线程</text>
<line class="l" x1="100" y1="110" x2="100" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="160" y1="172" x2="190" y2="172" marker-end="url(#arr)"/>
<text class="ts" x="40" y="236">每个从库一个 Dump 线程</text>
<text class="ts" x="40" y="254">binlog 更新时被通知并推送事件</text>
<rect class="bg" x="420" y="20" width="300" height="260" rx="12"/>
<text class="th" x="440" y="46">Slave</text>
<rect class="b2" x="440" y="66" width="110" height="44" rx="8"/>
<text class="tb" x="495" y="88" text-anchor="middle" dominant-baseline="middle">IO 线程</text>
<rect class="b3" x="440" y="150" width="110" height="44" rx="8"/>
<text class="tb" x="495" y="172" text-anchor="middle" dominant-baseline="middle">relay log</text>
<rect class="b2" x="590" y="150" width="110" height="44" rx="8"/>
<text class="tb" x="645" y="172" text-anchor="middle" dominant-baseline="middle">SQL 线程</text>
<rect class="b5" x="590" y="66" width="110" height="44" rx="8"/>
<text class="tb" x="645" y="88" text-anchor="middle" dominant-baseline="middle">从库数据</text>
<line class="l" x1="495" y1="110" x2="495" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="172" x2="590" y2="172" marker-end="url(#arr)"/>
<line class="l" x1="645" y1="150" x2="645" y2="110" marker-end="url(#arr)"/>
<line class="la" x1="300" y1="172" x2="400" y2="172"/>
<line class="la" x1="400" y1="172" x2="400" y2="88"/>
<line class="la" x1="400" y1="88" x2="440" y2="88" marker-end="url(#arr-a)"/>
<text class="ta" x="372" y="204" text-anchor="middle">① 网络传输</text>
<text class="ts" x="440" y="236">② 写入 relay log</text>
<text class="ts" x="440" y="254">③ 回放并更新从库数据</text>
</svg>
<figcaption>图 1：主从复制的线程与日志流向</figcaption>
</figure>

- 从库 `CHANGE REPLICATION SOURCE TO ... SOURCE_AUTO_POSITION=1`（8.0.23 前叫 `CHANGE MASTER TO`）指定主库地址和起点；
- IO 线程与 SQL 线程**解耦**：网络慢不影响回放，回放慢也不会阻塞接收，但 relay log 会堆积；
- 从库默认**不会记录回放事务的 binlog**，级联复制需要 `log_replica_updates=ON`（8.0 默认开启）。

## binlog 格式与复制

| 格式 | 内容 | 问题 |
| --- | --- | --- |
| STATEMENT | SQL 语句原文 | `NOW()`、`UUID()`、`LIMIT` 无序等非确定函数导致主从不一致 |
| ROW | 每行修改前后镜像 | 体积大，但**确定性强**，是生产标准；`binlog_row_image=FULL/MINIMAL` |
| MIXED | 自动选择 | 行为不直观，不推荐 |

## 三种复制模式

### 异步复制

主库写完 binlog 就返回客户端，**不关心从库是否收到**。性能最好，但主库宕机时，尚未传到从库的事务丢失，切换后新主库“缺数据”。

### 半同步复制

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="半同步 AFTER_SYNC 与 AFTER_COMMIT 的时序差异">
<text class="th" x="190" y="26" text-anchor="middle">AFTER_SYNC（无损，默认）</text>
<text class="th" x="550" y="26" text-anchor="middle">AFTER_COMMIT（旧）</text>
<rect class="b1" x="30" y="44" width="70" height="30" rx="6"/>
<text class="tb" x="65" y="59" text-anchor="middle" dominant-baseline="middle">Master</text>
<rect class="b2" x="270" y="44" width="70" height="30" rx="6"/>
<text class="tb" x="305" y="59" text-anchor="middle" dominant-baseline="middle">Slave</text>
<line class="ld" x1="65" y1="74" x2="65" y2="310"/>
<line class="ld" x1="305" y1="74" x2="305" y2="310"/>
<text class="ts" x="20" y="100" text-anchor="start">1</text>
<text class="t" x="75" y="100">写 binlog 并 fsync</text>
<line class="l" x1="65" y1="124" x2="305" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="185" y="116" text-anchor="middle">2 发送 binlog</text>
<line class="l" x1="305" y1="164" x2="65" y2="164" marker-end="url(#arr)"/>
<text class="ts" x="185" y="156" text-anchor="middle">3 ACK（写入 relay log）</text>
<text class="ts" x="20" y="204">4</text>
<text class="ta" x="75" y="204">存储引擎提交（事务此时才对外可见）</text>
<text class="ts" x="20" y="244">5</text>
<text class="t" x="75" y="244">返回客户端成功</text>
<rect class="b5" x="30" y="268" width="310" height="44" rx="8"/>
<text class="ts" x="185" y="290" text-anchor="middle">主库此时宕机：已被他人读到的数据，从库必有</text>
<rect class="b1" x="390" y="44" width="70" height="30" rx="6"/>
<text class="tb" x="425" y="59" text-anchor="middle" dominant-baseline="middle">Master</text>
<rect class="b2" x="630" y="44" width="70" height="30" rx="6"/>
<text class="tb" x="665" y="59" text-anchor="middle" dominant-baseline="middle">Slave</text>
<line class="ld" x1="425" y1="74" x2="425" y2="310"/>
<line class="ld" x1="665" y1="74" x2="665" y2="310"/>
<text class="t" x="435" y="100">写 binlog + 引擎提交</text>
<line class="l" x1="425" y1="124" x2="665" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="545" y="116" text-anchor="middle">发送 binlog</text>
<line class="l" x1="665" y1="164" x2="425" y2="164" marker-end="url(#arr)"/>
<text class="ts" x="545" y="156" text-anchor="middle">ACK</text>
<text class="t" x="435" y="204">返回客户端成功</text>
<rect class="b4" x="390" y="268" width="310" height="44" rx="8"/>
<text class="ts" x="545" y="290" text-anchor="middle">等 ACK 期间已提交可见：宕机会出现“幻读式”丢失</text>
</svg>
<figcaption>图 2：半同步复制两种时序，AFTER_SYNC 先等从库 ACK 再提交引擎</figcaption>
</figure>

- 8.0 默认 `rpl_semi_sync_source_wait_point=AFTER_SYNC`（无损半同步）；
- `rpl_semi_sync_source_timeout`（默认 10s）超时会**退化为异步**，需要监控 `Rpl_semi_sync_source_status`；
- 半同步只保证**收到**，不保证**回放完**，所以仍有延迟；
- 8.0.26+ 可用 `rpl_semi_sync_source_wait_for_replica_count` 要求多个从库 ACK。

### MGR（MySQL Group Replication）

基于 Paxos 变体（XCom）的多数派提交：事务提交前广播给组内成员，经**认证（certification）**检测写集冲突，多数派确认后才提交。

- 单主模式（推荐）自动选主，多主模式有冲突回滚代价；
- 要求：InnoDB、主键、`binlog_format=ROW`、GTID；
- 成员数建议 3、5、7（奇数），**失去多数派后停写**；
- InnoDB Cluster = MGR + MySQL Router + MySQL Shell，开箱即用的高可用方案。

## GTID

格式 `source_uuid:transaction_id`，如 `3E11FA47-71CA-11E1-9E33-C80AA9429562:23`。

- 从库自动以 GTID 集合协商起点，**切主不再需要找 file/pos**；
- 回放幂等：已执行过的 GTID 自动跳过；
- 限制：不能在事务内混用事务表与非事务表、`CREATE TABLE ... SELECT` 在老版本受限；
- 跳过出错事务：`SET GTID_NEXT='uuid:n'; BEGIN; COMMIT; SET GTID_NEXT='AUTOMATIC';` 注入空事务占位。

## 并行复制：为什么延迟，如何降低

回放是单线程时，主库 N 个并发事务在从库串行执行，吞吐必然落后。

| 版本 | 策略（`replica_parallel_type`） | 可并行条件 |
| --- | --- | --- |
| 5.6 | DATABASE | 不同库的事务 |
| 5.7 | LOGICAL_CLOCK | 同一组提交（同一 `last_committed`）的事务 |
| 8.0 | LOGICAL_CLOCK + `binlog_transaction_dependency_tracking=WRITESET` | **写集不冲突**的事务（行级），即使不在同一组提交 |

建议配置：`replica_parallel_workers=8~16`、`replica_preserve_commit_order=ON`（保证从库提交顺序与主库一致，读不会看到“乱序”状态）。

## 主从延迟治理

| 原因 | 现象 | 对策 |
| --- | --- | --- |
| 大事务 | 一个事务回放 N 秒，延迟阶梯上升 | 拆成小批（每批 1000~5000 行）；禁止应用层长事务 |
| 单线程回放 | `Seconds_Behind_Source` 持续增加 | 并行复制 + WRITESET |
| 从库规格差/IO 争用 | 从库 CPU/IO 打满 | 从库配置不低于主库；避免从库跑重报表 |
| 无主键表 | ROW 格式下每行全表扫描定位 | **所有表必须有主键** |
| DDL | 回放 DDL 期间阻塞后续事务 | 在线 DDL 工具（gh-ost、pt-osc）|

延迟监控不要只看 `Seconds_Behind_Source`（精度低，IO 线程断连时为 NULL），更可靠的是**心跳表**：主库定时写时间戳，从库读出来与当前时间对比（pt-heartbeat）。

## 读写分离与读一致性

主库写完立刻读从库，可能读到旧数据。方案：

1. **关键路径强制读主**：下单后 N 秒内、用户刚改了资料的请求读主库；
2. **延迟感知路由**：中间件检测从库延迟，超阈值摘除；
3. **GTID 等待**：写返回 GTID，读从库前 `SELECT WAIT_FOR_EXECUTED_GTID_SET('gtid', 1)`；
4. 缓存兜底：写后更新缓存，读先读缓存（见 [缓存设计与一致性](#/redis/cache)）。

## 高可用与故障切换

<figure class="fig">
<svg viewBox="0 0 740 240" class="dg" role="img" aria-label="主库故障切换的步骤流程">
<rect class="b4" x="20" y="90" width="110" height="52" rx="8"/>
<text class="tb" x="75" y="110" text-anchor="middle" dominant-baseline="middle">检测故障</text>
<text class="ts" x="75" y="128" text-anchor="middle">多次探活 + 多节点投票</text>
<rect class="b3" x="170" y="90" width="110" height="52" rx="8"/>
<text class="tb" x="225" y="110" text-anchor="middle" dominant-baseline="middle">隔离旧主</text>
<text class="ts" x="225" y="128" text-anchor="middle">VIP 下线 / read_only</text>
<rect class="b3" x="320" y="90" width="110" height="52" rx="8"/>
<text class="tb" x="375" y="110" text-anchor="middle" dominant-baseline="middle">选新主</text>
<text class="ts" x="375" y="128" text-anchor="middle">GTID 最全 + 延迟最小</text>
<rect class="b3" x="470" y="90" width="110" height="52" rx="8"/>
<text class="tb" x="525" y="110" text-anchor="middle" dominant-baseline="middle">追平并提升</text>
<text class="ts" x="525" y="128" text-anchor="middle">回放完 relay log</text>
<rect class="b2" x="620" y="90" width="100" height="52" rx="8"/>
<text class="tb" x="670" y="110" text-anchor="middle" dominant-baseline="middle">切流量</text>
<text class="ts" x="670" y="128" text-anchor="middle">VIP / 配置中心</text>
<line class="l" x1="130" y1="116" x2="170" y2="116" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="116" x2="320" y2="116" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="116" x2="470" y2="116" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="116" x2="620" y2="116" marker-end="url(#arr)"/>
<text class="ts" x="370" y="190" text-anchor="middle">其余从库 CHANGE SOURCE 指向新主；旧主恢复后以从库身份加入，必要时先重建</text>
</svg>
<figcaption>图 3：故障切换的标准步骤</figcaption>
</figure>

| 方案 | 特点 |
| --- | --- |
| MHA / Orchestrator | 外部程序探测并切换，成熟，需自行处理脑裂与 VIP |
| MGR + Router | 数据层自带选主，Router 自动路由 |
| 云厂商 RDS | 托管 HA，通常基于半同步或存储层复制 |

> [!WARNING] 脑裂
> 旧主只是网络分区而非真的宕机，恢复后可能同时接受写入。切换前必须**确保旧主被隔离**（`super_read_only=ON`、摘除 VIP、必要时 STONITH），否则两个“主库”各自写入后数据无法合并。

## 面试追问

> [!QUESTION] 主从复制的数据流是怎样的？
> 主库提交事务写 binlog；Dump 线程把事件推送给从库 IO 线程；IO 线程写入 relay log；SQL 线程（或并行 worker）读取 relay log 并回放。两个从库线程解耦，网络与回放互不阻塞。

> [!QUESTION] 异步、半同步、MGR 的差别？
> 异步不等从库，主库宕机会丢数据；半同步（AFTER_SYNC）要求至少一个从库收到 binlog 才提交，宕机不丢已确认事务，但可能超时退化为异步；MGR 基于 Paxos 多数派，提交需多数成员认证通过，失去多数派停写，一致性最强、延迟也更高。

> [!QUESTION] AFTER_SYNC 为什么比 AFTER_COMMIT 更安全？
> AFTER_COMMIT 先提交引擎再等 ACK，等待期间事务已对其他会话可见，此时主库宕机而从库没收到，故障切换后已被读到的数据“消失”。AFTER_SYNC 先等 ACK 再提交，保证可见的数据从库必有。

> [!QUESTION] 主从延迟怎么排查和解决？
> 先看是大事务、单线程回放、从库资源不足还是无主键表；对症处理：拆大事务、开 WRITESET 并行复制、升级从库规格、保证所有表有主键；用心跳表监控真实延迟；业务上关键读强制走主库。

> [!QUESTION] GTID 解决了什么问题？
> 把事务位置从“binlog 文件+偏移”变成全局唯一编号，从库自动协商起点，故障切换不需要手工找位点；同时回放幂等，便于重建复制关系。
