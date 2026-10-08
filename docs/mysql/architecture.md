---
level: 进阶
tags: [MySQL, InnoDB, 执行流程, 两阶段提交, 连接池]
summary: 从 Server 层与存储引擎的分层出发，走通一条 SELECT 与一条 UPDATE 在 MySQL 内部的完整路径，并给出连接管理与连接池的生产配置。
---

# 架构与 SQL 执行流程

> [!ABSTRACT] 核心要点
> - MySQL 分为 **Server 层**（连接器、解析器、优化器、执行器、binlog、内置函数）与**插件式存储引擎层**（InnoDB 为默认），两层通过 Handler API 交互。
> - 查询路径：连接器 → 解析器 → 优化器 → 执行器 → 引擎；**8.0 已彻底移除查询缓存**（5.7.20 起标记废弃）。
> - 一条 UPDATE 的关键顺序：Buffer Pool 读页 → 写 undo → 改内存页（脏页）→ redo **prepare** → 写 **binlog** → redo **commit**，即「两阶段提交」，保证 redo 与 binlog 一致。
> - 数据页**不在提交时刷盘**，由后台线程异步刷脏；崩溃安全靠 redo（WAL）。
> - 生产上 Java 连接池的 `maxLifetime` 必须小于 MySQL `wait_timeout` 以及中间网络设备的空闲超时，否则会拿到“已被服务端关闭”的连接。

## 整体架构：Server 层与存储引擎层

MySQL 的设计是“一个 SQL 层 + 多个可插拔存储引擎”。SQL 的解析、优化、权限、复制日志（binlog）等与存储无关的功能都在 Server 层；数据如何组织、如何加锁、如何崩溃恢复由存储引擎负责。

<figure class="fig">
<svg viewBox="0 0 720 400" class="dg" role="img" aria-label="MySQL Server 层与存储引擎层的分层架构">
<rect class="b" x="40" y="10" width="160" height="36" rx="8"/>
<text class="tb" x="120" y="28" text-anchor="middle" dominant-baseline="middle">客户端 / 连接池</text>
<line class="l" x1="105" y1="46" x2="105" y2="98" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="66" width="680" height="206" rx="12"/>
<text class="ts" x="684" y="86" text-anchor="end">Server 层</text>
<rect class="b1" x="40" y="100" width="130" height="60" rx="8"/>
<text class="tb" x="105" y="122" text-anchor="middle" dominant-baseline="middle">连接器</text>
<text class="ts" x="105" y="144" text-anchor="middle" dominant-baseline="middle">认证 / 权限 / 线程</text>
<line class="l" x1="170" y1="130" x2="198" y2="130" marker-end="url(#arr)"/>
<rect class="b1" x="200" y="100" width="130" height="60" rx="8"/>
<text class="tb" x="265" y="122" text-anchor="middle" dominant-baseline="middle">解析器</text>
<text class="ts" x="265" y="144" text-anchor="middle" dominant-baseline="middle">词法 / 语法 / 解析树</text>
<line class="l" x1="330" y1="130" x2="358" y2="130" marker-end="url(#arr)"/>
<rect class="b1" x="360" y="100" width="130" height="60" rx="8"/>
<text class="tb" x="425" y="122" text-anchor="middle" dominant-baseline="middle">优化器</text>
<text class="ts" x="425" y="144" text-anchor="middle" dominant-baseline="middle">改写 / 代价 / 选索引</text>
<line class="l" x1="490" y1="130" x2="518" y2="130" marker-end="url(#arr)"/>
<rect class="b1" x="520" y="100" width="160" height="60" rx="8"/>
<text class="tb" x="600" y="122" text-anchor="middle" dominant-baseline="middle">执行器</text>
<text class="ts" x="600" y="144" text-anchor="middle" dominant-baseline="middle">按计划调用引擎接口</text>
<rect class="b" x="40" y="190" width="140" height="60" rx="8"/>
<text class="tb" x="110" y="212" text-anchor="middle" dominant-baseline="middle">内置函数</text>
<text class="ts" x="110" y="234" text-anchor="middle" dominant-baseline="middle">视图 / 存储过程</text>
<rect class="b" x="195" y="190" width="140" height="60" rx="8"/>
<text class="tb" x="265" y="212" text-anchor="middle" dominant-baseline="middle">binlog</text>
<text class="ts" x="265" y="234" text-anchor="middle" dominant-baseline="middle">复制 / 时间点恢复</text>
<rect class="b" x="350" y="190" width="140" height="60" rx="8"/>
<text class="tb" x="420" y="212" text-anchor="middle" dominant-baseline="middle">查询缓存</text>
<text class="ts" x="420" y="234" text-anchor="middle" dominant-baseline="middle">8.0 已移除</text>
<line class="l" x1="600" y1="160" x2="600" y2="298" marker-end="url(#arr)"/>
<text class="ts" x="612" y="286">Handler API</text>
<rect class="bg" x="20" y="300" width="680" height="90" rx="12"/>
<text class="ts" x="36" y="318">存储引擎层（插件式，按表指定）</text>
<rect class="b3" x="40" y="328" width="200" height="50" rx="8"/>
<text class="tb" x="140" y="345" text-anchor="middle" dominant-baseline="middle">InnoDB（默认）</text>
<text class="ts" x="140" y="365" text-anchor="middle" dominant-baseline="middle">事务 / 行锁 / MVCC / redo</text>
<rect class="b" x="260" y="328" width="150" height="50" rx="8"/>
<text class="tb" x="335" y="345" text-anchor="middle" dominant-baseline="middle">MyISAM</text>
<text class="ts" x="335" y="365" text-anchor="middle" dominant-baseline="middle">表锁 / 无事务</text>
<rect class="b" x="430" y="328" width="120" height="50" rx="8"/>
<text class="tb" x="490" y="353" text-anchor="middle" dominant-baseline="middle">Memory</text>
<rect class="b" x="570" y="328" width="110" height="50" rx="8"/>
<text class="tb" x="625" y="353" text-anchor="middle" dominant-baseline="middle">CSV / …</text>
</svg>
<figcaption>图 1：Server 层负责“怎么查”，存储引擎负责“数据怎么存、怎么锁、怎么恢复”</figcaption>
</figure>

几个容易答错的归属问题：

| 功能 | 所在层 | 说明 |
| --- | --- | --- |
| binlog | Server 层 | 所有引擎共享，逻辑日志，用于复制和按时间点恢复 |
| redo log / undo log | InnoDB | 物理（redo）与逻辑（undo）日志，引擎私有 |
| MDL 元数据锁、表锁 | Server 层 | `LOCK TABLES`、DDL 与 DML 的并发控制 |
| 行锁、间隙锁、MVCC | InnoDB | MyISAM 没有 |
| 数据字典 | 8.0：InnoDB 系统表 | 5.7 用 `.frm` 文件 + MyISAM 系统表；8.0 改为事务型数据字典，支持原子 DDL |

## 一条 SELECT 的执行路径

### 连接器

客户端完成 TCP 三次握手后，连接器做身份认证（8.0 默认认证插件 `caching_sha2_password`，5.7 为 `mysql_native_password`，老驱动连 8.0 报 “Public Key Retrieval is not allowed” 多半是这个原因），然后**读取该用户此刻的权限**缓存在连接上——所以改完权限，已有连接不受影响，新连接才生效。

社区版默认“一连接一线程”（`thread_handling=one-thread-per-connection`），线程可通过 `thread_cache_size` 复用。连接空闲超过 `wait_timeout`（默认 28800 秒即 8 小时）由服务端主动断开，客户端下次使用会收到 `Communications link failure` / `The last packet successfully received from the server was xxx milliseconds ago`。

### 查询缓存（已移除）

5.7 及之前存在以 SQL 文本为 key 的查询缓存，但**表上任何一次更新都会清空该表的全部缓存**，在写多的业务里命中率极低，还存在全局锁竞争。5.7.20 起废弃，**8.0 完全删除**，`query_cache_*` 参数也一并移除。需要缓存请在应用层用 Redis。

### 解析器

- **词法分析**：把 SQL 字符串切成 token，识别关键字、表名、列名。
- **语法分析**：按语法规则生成解析树，语法错误在此报 `You have an error in your SQL syntax`。
- **语义检查**（8.0 中称为 resolve/prepare 阶段）：表和列是否存在、`*` 展开、名字解析。`Unknown column 'x' in 'where clause'` 在这里报出，而不是在执行阶段。

### 优化器

基于代价（CBO）生成执行计划，主要工作：

1. **逻辑改写**：常量传播、条件化简、外连接转内连接、子查询转半连接（semi-join）、派生表合并等。
2. **访问路径选择**：每张表用哪个索引（全表扫描、ref、range、index merge……），依据是统计信息估算的扫描行数与 I/O / CPU 代价。
3. **连接顺序**：多表 JOIN 时决定驱动表与被驱动表。

可以用 `EXPLAIN` 看结果、用 `optimizer_trace` 看决策过程（详见 [EXPLAIN 与 SQL 调优](#/mysql/optimize)）。

### 执行器

执行器先做表级权限校验，再按计划**逐行**调用引擎接口。以 `SELECT * FROM t WHERE c = 10`（c 无索引）为例：

```text
1. 调用引擎“取第一行”接口（全表扫描从聚簇索引第一条记录开始）
2. 判断 c 是否等于 10，不是则跳过，是则放入结果集
3. 调用“取下一行”接口，重复直到最后一行
4. 把结果集返回客户端（边产生边发送，不是全部攒好再发）
```

慢查询日志里的 `Rows_examined` 就是执行器调用引擎取行的累计次数。注意它和引擎实际扫描的行数不一定相等——有索引条件下推时，部分过滤在引擎层就完成了。

> [!NOTE] 结果集是“边读边发”的
> Server 端把行写入 `net_buffer`（大小由 `net_buffer_length` 控制），写满就发给客户端。客户端如果不读（例如 JDBC 没开流式读取却查了几百万行），服务端会阻塞在发送上，`SHOW PROCESSLIST` 里状态为 `Sending to client`。

## 一条 UPDATE 的完整执行流程

`UPDATE t SET c = c + 1 WHERE id = 2` 前面的连接、解析、优化与 SELECT 一样，差异在执行阶段：涉及 Buffer Pool、undo log、redo log 和 binlog 四个组件。

<figure class="fig">
<svg viewBox="0 0 720 470" class="dg" role="img" aria-label="一条 UPDATE 语句在 Server 层与 InnoDB 中的执行步骤及两阶段提交">
<text class="ts" x="40" y="40" text-anchor="middle" dominant-baseline="middle">①</text>
<rect class="b1" x="60" y="20" width="440" height="40" rx="8"/>
<text class="t" x="280" y="40" text-anchor="middle" dominant-baseline="middle">执行器：调用引擎接口读取 id=2 的行</text>
<line class="l" x1="280" y1="60" x2="280" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="40" y="96" text-anchor="middle" dominant-baseline="middle">②</text>
<rect class="b2" x="60" y="76" width="440" height="40" rx="8"/>
<text class="t" x="280" y="96" text-anchor="middle" dominant-baseline="middle">InnoDB：页在 Buffer Pool 直接返回，否则从磁盘读入</text>
<line class="l" x1="280" y1="116" x2="280" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="40" y="152" text-anchor="middle" dominant-baseline="middle">③</text>
<rect class="b1" x="60" y="132" width="440" height="40" rx="8"/>
<text class="t" x="280" y="152" text-anchor="middle" dominant-baseline="middle">执行器：计算新值 c=c+1，调用引擎更新接口</text>
<line class="l" x1="280" y1="172" x2="280" y2="186" marker-end="url(#arr)"/>
<text class="ts" x="40" y="208" text-anchor="middle" dominant-baseline="middle">④</text>
<rect class="b2" x="60" y="188" width="440" height="40" rx="8"/>
<text class="t" x="280" y="208" text-anchor="middle" dominant-baseline="middle">InnoDB：写 undo log（旧值，用于回滚与 MVCC）</text>
<line class="l" x1="280" y1="228" x2="280" y2="242" marker-end="url(#arr)"/>
<text class="ts" x="40" y="264" text-anchor="middle" dominant-baseline="middle">⑤</text>
<rect class="b2" x="60" y="244" width="440" height="40" rx="8"/>
<text class="t" x="280" y="264" text-anchor="middle" dominant-baseline="middle">InnoDB：修改 Buffer Pool 中的页，成为脏页</text>
<line class="l" x1="280" y1="284" x2="280" y2="298" marker-end="url(#arr)"/>
<text class="ts" x="40" y="320" text-anchor="middle" dominant-baseline="middle">⑥</text>
<rect class="b3" x="60" y="300" width="440" height="40" rx="8"/>
<text class="t" x="280" y="320" text-anchor="middle" dominant-baseline="middle">写 redo log，状态 prepare（按刷盘策略落盘）</text>
<line class="l" x1="280" y1="340" x2="280" y2="354" marker-end="url(#arr)"/>
<text class="ts" x="40" y="376" text-anchor="middle" dominant-baseline="middle">⑦</text>
<rect class="b1" x="60" y="356" width="440" height="40" rx="8"/>
<text class="t" x="280" y="376" text-anchor="middle" dominant-baseline="middle">执行器：写 binlog（按 sync_binlog 落盘）</text>
<line class="l" x1="280" y1="396" x2="280" y2="410" marker-end="url(#arr)"/>
<text class="ts" x="40" y="432" text-anchor="middle" dominant-baseline="middle">⑧</text>
<rect class="b3" x="60" y="412" width="440" height="40" rx="8"/>
<text class="t" x="280" y="432" text-anchor="middle" dominant-baseline="middle">redo log 写 commit 标记，事务提交完成</text>
<line class="ld" x1="500" y1="264" x2="538" y2="264" marker-end="url(#arr)"/>
<rect class="b" x="540" y="236" width="160" height="56" rx="8"/>
<text class="tb" x="620" y="256" text-anchor="middle" dominant-baseline="middle">Page Cleaner 线程</text>
<text class="ts" x="620" y="276" text-anchor="middle" dominant-baseline="middle">脏页异步刷回磁盘</text>
<line class="la" x1="520" y1="304" x2="520" y2="448"/>
<line class="la" x1="508" y1="304" x2="520" y2="304"/>
<line class="la" x1="508" y1="448" x2="520" y2="448"/>
<text class="th" x="540" y="364">两阶段提交</text>
<text class="ts" x="540" y="388">prepare → binlog → commit</text>
<text class="ts" x="540" y="408">崩溃恢复据此判定提交或回滚</text>
<text class="ts" x="540" y="190">undo 页的修改本身</text>
<text class="ts" x="540" y="208">也会产生 redo</text>
</svg>
<figcaption>图 2：UPDATE 执行流程。蓝色为 Server 层，绿色为 InnoDB 内存操作，琥珀色为 redo 两阶段提交</figcaption>
</figure>

要点逐条说明：

1. **先读后写**：InnoDB 更新必须先把目标页读入 Buffer Pool，再在内存里改。若被修改的是**非唯一二级索引**且页不在内存，可以先写入 Change Buffer，避免随机读（见 [InnoDB 存储结构与 Buffer Pool](#/mysql/storage)）。
2. **加锁**：在定位 id=2 这一行时，InnoDB 对其加 X 型记录锁（当前读），锁持有到事务结束。
3. **undo 先于数据修改**：旧值写入 undo 页，行上的 `DB_ROLL_PTR` 指向它，构成版本链（见 [事务隔离与 MVCC](#/mysql/transaction)）。
4. **WAL**：数据页本身不立即刷盘，只要 redo 落盘即可保证持久性。
5. **两阶段提交**：redo prepare → binlog 落盘 → redo commit。如果不这样做，redo 和 binlog 一个有一个没有，就会出现“主库有这条数据、从库没有”或“备份恢复出的库与原库不一致”（详见 [redo / undo / binlog](#/mysql/log)）。
6. **“值没变”的 UPDATE**：InnoDB 发现新旧值相同时不会真的修改数据页，但仍然会加锁；binlog 是否记录取决于格式（ROW 格式下不产生行事件）。

> [!TIP] 提交时到底刷了几次盘
> 在“双 1”（`innodb_flush_log_at_trx_commit=1`、`sync_binlog=1`）下，理论上每次提交要 fsync redo prepare 与 binlog 两次。实际通过**组提交**（group commit）把多个并发事务的 fsync 合并，所以 TPS 并不会被单次 fsync 延迟线性限制。

## InnoDB vs MyISAM

| 维度 | InnoDB | MyISAM |
| --- | --- | --- |
| 事务 | 支持，ACID | 不支持 |
| 锁粒度 | 行锁 + 间隙锁，MVCC 读不加锁 | 表锁，读写互斥 |
| 崩溃恢复 | redo + doublewrite，崩溃安全 | 不保证，崩溃后可能需要 `REPAIR TABLE` |
| 索引组织 | 聚簇索引，数据即主键 B+ 树叶子 | 堆表，索引叶子存数据文件偏移量 |
| 外键 | 支持 | 不支持 |
| `COUNT(*)` 无条件 | 需扫描索引（MVCC 下每个事务看到的行数不同） | 直接读元数据中的行数，O(1) |
| 文件 | `.ibd`（8.0 无 `.frm`） | `.MYD` 数据 + `.MYI` 索引 |
| 适用 | 几乎所有 OLTP 场景 | 历史遗留；8.0 系统表已全部换成 InnoDB |

结论：新项目没有理由选 MyISAM。面试问“为什么 MyISAM 的 `COUNT(*)` 快”，关键是 InnoDB 有 MVCC，同一时刻不同事务看到的行数可能不同，不能简单缓存一个总数。

## 连接管理与连接池

### 服务端参数

| 参数 | 默认值 | 说明与建议 |
| --- | --- | --- |
| `max_connections` | 151 | 最大连接数，超出报 `Too many connections`；按“应用实例数 × 每实例池大小”估算并留余量 |
| `wait_timeout` | 28800 秒 | 非交互连接空闲超时；JDBC 连接属于非交互连接 |
| `interactive_timeout` | 28800 秒 | mysql 命令行等交互式客户端的空闲超时 |
| `max_allowed_packet` | 64MB（8.0） | 单个包上限，大批量插入或大字段超出会报错断连；5.7 默认 4MB |
| `thread_cache_size` | 自动计算 | 缓存断开连接的线程，降低短连接场景创建线程开销 |
| `back_log` | 自动计算 | 监听队列长度，突发建连高峰时调大 |

> [!WARNING] 长连接内存膨胀
> 连接执行过程中申请的部分内存挂在连接对象上，直到连接断开才释放。长期复用的连接可能越涨越大，极端情况下 MySQL 被 OOM Killer 杀掉。处理方式：连接池设置 `maxLifetime` 定期重建连接；或在 5.7+ 用 `mysql_reset_connection` 重置连接状态（不重连、不重新鉴权）。

### HikariCP 关键配置

Spring Boot 默认连接池是 HikariCP。下面是与 MySQL 交互最相关的参数：

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `maximumPoolSize` | 10 | 不是越大越好；官方经验公式 `核数 × 2 + 有效磁盘数` 是起点，再结合压测调整 |
| `minimumIdle` | 等于 `maximumPoolSize` | 推荐保持默认（固定大小池），避免突发流量时临时建连 |
| `connectionTimeout` | 30000 ms | 从池中取连接的等待时间，线上可调到 1～3 秒快速失败，避免线程堆积 |
| `maxLifetime` | 1800000 ms | **必须比 `wait_timeout` 和 LB/防火墙空闲超时短**，至少少几十秒 |
| `idleTimeout` | 600000 ms | 仅当 `minimumIdle < maximumPoolSize` 时生效 |
| `keepaliveTime` | 版本相关 | 定期对空闲连接做保活探测，需小于 `maxLifetime`；穿过会回收空闲连接的网络设备时务必开启 |
| `leakDetectionThreshold` | 0（关闭） | 连接借出超过该时间打印堆栈，排查连接泄漏 |

```yaml
spring:
  datasource:
    url: jdbc:mysql://db:3306/app?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&rewriteBatchedStatements=true
    hikari:
      maximum-pool-size: 20
      minimum-idle: 20
      connection-timeout: 2000
      max-lifetime: 1500000      # 25 分钟，小于 wait_timeout 与网络设备超时
      keepalive-time: 120000
      leak-detection-threshold: 30000
```

几个 JDBC URL 参数值得关注：

- `rewriteBatchedStatements=true`：让 `addBatch()` 的 INSERT 被改写成多值 INSERT，批量写入性能可提升一个数量级。
- `useCursorFetch=true` + `fetchSize`，或 `fetchSize=Integer.MIN_VALUE`：流式读取大结果集，避免客户端 OOM。
- `socketTimeout`：网络层读超时，防止 SQL 卡死时线程无限等待（应大于最慢合法 SQL 的耗时）。

### 连接池大小为什么不能太大

数据库能真正并行处理的请求数受 CPU 核数和磁盘并发限制。连接数远大于这个值时，多出来的连接只是在 MySQL 内部排队、切换上下文、争抢锁（InnoDB 的 `innodb_thread_concurrency` 默认 0 不限制），吞吐不升反降。多个应用实例共享一个库时，**总连接数 = 实例数 × 池大小**，扩容应用时容易把数据库连接打满。

## 生产实践与踩坑

**1. 凌晨第一次请求报 `Communications link failure`**

现象：系统低峰期过后第一批请求失败，随后恢复。原因：连接在池中空闲超过了 MySQL `wait_timeout` 或云厂商 SLB/NAT 的空闲超时（有些设备只有几分钟），被对端悄悄关闭。修复：`maxLifetime` 小于所有链路上的最短空闲超时，并开启 `keepaliveTime`；不要依赖 `autoReconnect=true`（官方不推荐，会破坏事务语义）。

**2. `Too many connections` 导致整站不可用**

排查：`SHOW PROCESSLIST` 或 `SELECT * FROM information_schema.processlist` 看是否大量 `Sleep`（连接泄漏或池太大）还是大量执行中（慢 SQL 堆积）。MySQL 为拥有 `CONNECTION_ADMIN`（5.7 为 `SUPER`）权限的用户额外保留一个连接，用于紧急登录处理；8.0.14+ 还可配置独立的管理端口 `admin_address`/`admin_port`。

**3. 应用线程池全部卡在 `getConnection`**

根因通常是慢 SQL 或长事务占住连接。`connectionTimeout` 默认 30 秒太长，会导致 Tomcat 线程全部阻塞，故障扩散到上游。建议缩短获取超时 + 对慢 SQL 设置 `MAX_EXECUTION_TIME` 提示（仅对 SELECT 生效）。

**4. 修改用户权限后不生效**

权限在连接建立时读取，已有长连接继续使用旧权限，需要连接重建（重启应用或等待 `maxLifetime` 轮换）。

## 面试追问

> [!QUESTION] 一条 SQL 的执行经过哪些组件？哪些错误在哪个阶段报出？
> 连接器（认证、权限）→ 解析器（语法错误、未知列）→ 优化器（选索引、JOIN 顺序）→ 执行器（表权限校验，逐行调引擎接口）→ 存储引擎。8.0 没有查询缓存。“Unknown column” 在解析/语义检查阶段报，而不是执行阶段。

> [!QUESTION] 为什么 8.0 删除了查询缓存？
> 缓存以 SQL 文本为 key，表任何一次写入都会使该表全部缓存失效，写多场景命中率极低；维护缓存需要全局互斥，高并发下反而成为瓶颈。应用层缓存（Redis）更灵活、可控。

> [!QUESTION] UPDATE 时为什么要两阶段提交？去掉会怎样？
> redo 属于 InnoDB，binlog 属于 Server 层，两者需要原子地一起成功。先写 redo 后写 binlog：binlog 写前崩溃，主库恢复出数据但从库没有；先写 binlog 后写 redo：主库丢数据但从库有。两阶段提交让 binlog 成为提交与否的“仲裁者”：prepare 状态的事务重启后去 binlog 查 XID，存在且完整就提交，否则回滚。

> [!QUESTION] 更新语句执行完数据页刷盘了吗？宕机会丢数据吗？
> 没有刷盘，只改了 Buffer Pool 中的页。持久性靠 redo log：只要提交时 redo 落盘（`innodb_flush_log_at_trx_commit=1`），宕机后可以通过 redo 重放恢复脏页内容，不会丢已提交的数据。

> [!QUESTION] 连接池的 maxLifetime 应该怎么设？
> 小于 MySQL `wait_timeout`、以及代理 / LB / NAT 的空闲超时中的最小值，留出几十秒余量；同时配置保活探测。设置太短会导致频繁重建连接，太长会拿到已被对端关闭的连接。

> [!QUESTION] InnoDB 的 COUNT(*) 为什么不能像 MyISAM 一样 O(1)？
> MVCC 下每个事务基于自己的 ReadView 判断可见性，同一时刻不同事务看到的行数可能不同，没法维护一个全局准确的行数。优化器会选择最小的二级索引来扫描以减少 I/O。
