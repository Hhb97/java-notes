---
level: 深入
tags: [分库分表, ShardingSphere, 分片键, 路由, 扩容, 数据迁移]
summary: 讲清何时该分库分表、分片键与路由策略、ShardingSphere 的两种形态、跨分片查询的代价，以及不停机扩容迁移的完整流程。
---

# 分库分表实践

> [!ABSTRACT] 核心要点
> - 分库分表是**最后手段**：先做缓存、读写分离、索引与 SQL 优化、归档冷数据；单表过亿且写入或存储成为瓶颈时再拆。
> - **分片键**决定一切：选择高频查询条件且分布均匀的列（如 `user_id`），其余维度查询靠**冗余表 / 搜索引擎**。
> - 路由策略：取模（均匀、扩容难）、范围（易扩容、有热点）、**一致性哈希 / 预分片 + 映射**（扩容友好）。
> - 拆分后失去：跨库 JOIN、跨库事务、全局唯一自增、跨分片排序分页；这些都要付出额外设计成本。
> - **不停机扩容**：双写 → 全量迁移 → 增量追平 → 校验 → 切读 → 切写 → 清理。

## 先问：真的需要分吗

| 手段 | 解决什么 | 优先级 |
| --- | --- | --- |
| 索引与 SQL 优化 | 单次查询慢 | 1 |
| 缓存（Redis） | 读压力 | 2 |
| 读写分离 | 读压力、读扩展 | 3 |
| 冷热数据归档 | 单表膨胀（历史数据占大头） | 4 |
| 垂直拆分 | 业务耦合、不同表访问模式差异大 | 5 |
| **水平拆分（分库分表）** | 写压力、单表/单库容量上限 | 6 |
| NewSQL（TiDB 等） | 想要水平扩展又不想改业务 | 替代方案 |

经验阈值（仅供参考，取决于行宽与硬件）：单表 **千万级起要关注、数千万到亿级考虑拆**；单库 QPS/容量触及上限再拆库。B+ 树高度从 3 层增到 4 层并不会让性能“断崖”，真正的瓶颈往往是 Buffer Pool 放不下热点数据与 DDL 耗时。

## 拆分方式

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="垂直拆分与水平拆分的对比">
<text class="th" x="170" y="24" text-anchor="middle">垂直拆分</text>
<rect class="b" x="20" y="44" width="300" height="60" rx="8"/>
<text class="tm" x="170" y="68" text-anchor="middle">DB: shop（用户/订单/商品/库存…）</text>
<line class="l" x1="170" y1="104" x2="170" y2="130" marker-end="url(#arr)"/>
<rect class="b1" x="20" y="136" width="90" height="60" rx="8"/>
<text class="tb" x="65" y="166" text-anchor="middle" dominant-baseline="middle">user_db</text>
<rect class="b2" x="125" y="136" width="90" height="60" rx="8"/>
<text class="tb" x="170" y="166" text-anchor="middle" dominant-baseline="middle">order_db</text>
<rect class="b3" x="230" y="136" width="90" height="60" rx="8"/>
<text class="tb" x="275" y="166" text-anchor="middle" dominant-baseline="middle">goods_db</text>
<text class="ts" x="170" y="226" text-anchor="middle">按业务拆：与微服务划分一致</text>
<text class="ts" x="170" y="244" text-anchor="middle">解决：耦合、不同业务资源争抢</text>
<text class="th" x="560" y="24" text-anchor="middle">水平拆分</text>
<rect class="b" x="410" y="44" width="300" height="60" rx="8"/>
<text class="tm" x="560" y="68" text-anchor="middle">order（10 亿行）按 user_id % 4</text>
<line class="l" x1="560" y1="104" x2="560" y2="130" marker-end="url(#arr)"/>
<rect class="b5" x="410" y="136" width="66" height="60" rx="8"/>
<text class="tm" x="443" y="166" text-anchor="middle">order_0</text>
<rect class="b5" x="486" y="136" width="66" height="60" rx="8"/>
<text class="tm" x="519" y="166" text-anchor="middle">order_1</text>
<rect class="b5" x="562" y="136" width="66" height="60" rx="8"/>
<text class="tm" x="595" y="166" text-anchor="middle">order_2</text>
<rect class="b5" x="638" y="136" width="66" height="60" rx="8"/>
<text class="tm" x="671" y="166" text-anchor="middle">order_3</text>
<text class="ts" x="560" y="226" text-anchor="middle">按数据行拆：结构相同、数据不同</text>
<text class="ts" x="560" y="244" text-anchor="middle">解决：单表/单库的容量与写入上限</text>
</svg>
<figcaption>图 1：垂直拆分按业务，水平拆分按数据行</figcaption>
</figure>

先垂直、再水平：垂直拆分代价小且和微服务边界一致；水平拆分会让所有访问该表的代码都感知分片规则。

## 分片键与路由策略

**分片键选择原则**

1. 出现在**绝大多数查询**的 WHERE 条件中，避免“广播查询”；
2. 取值**分布均匀**，避免数据倾斜与热点；
3. 尽量让**关联数据落在同一分片**（订单与订单明细同用 `user_id`），支持本地 JOIN 与本地事务；
4. 不可变（不会被 UPDATE），否则要跨分片迁移。

| 策略 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 取模 / Hash | `hash(key) % N` | 数据均匀 | 扩容要迁移大量数据 |
| 范围 | 按 ID / 时间段 | 扩容简单、范围查询友好 | 新数据集中在最新分片，热点 |
| 预分片 + 映射表 | 先划 1024 个逻辑分片，再映射到物理库 | **扩容只改映射、按分片搬迁** | 需要维护映射 |
| 一致性哈希 | 哈希环 + 虚拟节点 | 扩容只影响相邻节点 | 实现复杂 |
| 基因法 | 把分片键信息嵌入其他 ID | 用订单号也能路由到分片 | ID 生成需配合 |

> [!TIP] 推荐：逻辑分片 + 预留
> 一开始就拆成 **32/64/128 个逻辑表**，分布在较少的物理库上。后期扩容只是把某些逻辑库整体迁到新实例，无需改路由算法、无需重新哈希数据。

### 多维度查询怎么办

订单按 `user_id` 分片后，商家要按 `merchant_id` 查订单：

- **冗余一份按 merchant_id 分片的订单表**，通过 MQ / Canal 异步同步（最终一致）；
- 或把查询条件全部导入 [Elasticsearch](#/mw/es)，由 ES 承担多维检索；
- 基因法：订单号中嵌入 `user_id` 的后几位，用订单号查询时可直接路由。

## ShardingSphere

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="ShardingSphere-JDBC 与 ShardingSphere-Proxy 两种部署形态">
<text class="th" x="190" y="24" text-anchor="middle">JDBC：客户端分片</text>
<rect class="bg" x="30" y="40" width="320" height="130" rx="10"/>
<rect class="b1" x="50" y="60" width="280" height="30" rx="6"/>
<text class="t" x="190" y="75" text-anchor="middle" dominant-baseline="middle">应用（Java）</text>
<rect class="b3" x="50" y="104" width="280" height="50" rx="6"/>
<text class="tb" x="190" y="122" text-anchor="middle" dominant-baseline="middle">ShardingSphere-JDBC</text>
<text class="ts" x="190" y="140" text-anchor="middle">解析 → 路由 → 改写 → 执行 → 归并</text>
<line class="l" x1="110" y1="170" x2="90" y2="210" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="170" x2="290" y2="210" marker-end="url(#arr)"/>
<rect class="b5" x="40" y="212" width="100" height="32" rx="6"/>
<text class="t" x="90" y="228" text-anchor="middle" dominant-baseline="middle">MySQL 0</text>
<rect class="b5" x="240" y="212" width="100" height="32" rx="6"/>
<text class="t" x="290" y="228" text-anchor="middle" dominant-baseline="middle">MySQL 1</text>
<text class="th" x="550" y="24" text-anchor="middle">Proxy：独立代理</text>
<rect class="bg" x="400" y="40" width="320" height="130" rx="10"/>
<rect class="b1" x="420" y="60" width="130" height="30" rx="6"/>
<text class="t" x="485" y="75" text-anchor="middle" dominant-baseline="middle">Java 应用</text>
<rect class="b1" x="570" y="60" width="130" height="30" rx="6"/>
<text class="t" x="635" y="75" text-anchor="middle" dominant-baseline="middle">Python / 运维</text>
<rect class="b3" x="420" y="104" width="280" height="50" rx="6"/>
<text class="tb" x="560" y="122" text-anchor="middle" dominant-baseline="middle">ShardingSphere-Proxy（MySQL 协议）</text>
<text class="ts" x="560" y="140" text-anchor="middle">对应用表现为一个普通 MySQL</text>
<line class="l" x1="480" y1="170" x2="460" y2="210" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="170" x2="660" y2="210" marker-end="url(#arr)"/>
<rect class="b5" x="410" y="212" width="100" height="32" rx="6"/>
<text class="t" x="460" y="228" text-anchor="middle" dominant-baseline="middle">MySQL 0</text>
<rect class="b5" x="610" y="212" width="100" height="32" rx="6"/>
<text class="t" x="660" y="228" text-anchor="middle" dominant-baseline="middle">MySQL 1</text>
</svg>
<figcaption>图 2：ShardingSphere 的两种形态</figcaption>
</figure>

| | JDBC | Proxy |
| --- | --- | --- |
| 性能 | 无额外网络跳，**更快** | 多一跳，Proxy 是瓶颈与单点（需集群） |
| 语言 | 仅 Java | 任何能连 MySQL 的客户端 |
| 运维 | 配置随应用发布 | 集中治理、DBA 友好 |
| 连接数 | 每应用实例持有所有库连接，**连接数乘积爆炸** | Proxy 统一管理连接池 |

执行流水线：**SQL 解析 → 路由（根据分片键定位库表）→ SQL 改写（逻辑表名换物理表名、补充排序列等）→ 并行执行 → 结果归并**。

```yaml
# ShardingSphere-JDBC 5.x：t_order 按 user_id 分 4 库 × 4 表（示意）
rules:
- !SHARDING
  tables:
    t_order:
      actualDataNodes: ds_${0..3}.t_order_${0..3}
      databaseStrategy:
        standard: { shardingColumn: user_id, shardingAlgorithmName: db_mod }
      tableStrategy:
        standard: { shardingColumn: order_id, shardingAlgorithmName: tbl_mod }
      keyGenerateStrategy:
        column: order_id
        keyGeneratorName: snowflake
  shardingAlgorithms:
    db_mod:  { type: MOD, props: { sharding-count: 4 } }
    tbl_mod: { type: MOD, props: { sharding-count: 4 } }
  keyGenerators:
    snowflake: { type: SNOWFLAKE }
```

## 拆分后的典型问题

| 问题 | 方案 |
| --- | --- |
| 全局唯一 ID | 雪花 / 号段，见 [分布式 ID 生成](#/distributed/id) |
| 跨库事务 | 尽量避免；必须时用 [分布式事务](#/distributed/transaction)（Seata、TCC、本地消息表） |
| 跨库 JOIN | 冗余字段、小表广播（字典表每库一份）、应用层组装、ES |
| 跨分片分页排序 | 每个分片取前 `offset+limit` 条再归并——**深分页成本随分片数线性放大**，禁止大 offset，改用游标（上一页最大 ID）|
| 聚合 `count/sum/group by` | 各分片并行算后归并；`avg` 需拆成 sum 与 count |
| 无分片键的查询 | 广播所有分片，性能随分片数下降，应避免或走冗余表 / ES |
| DDL | 每个物理表都要执行，用工具批量灰度 |

## 不停机扩容 / 数据迁移

<figure class="fig">
<svg viewBox="0 0 740 190" class="dg" role="img" aria-label="不停机数据迁移的步骤时间线">
<rect class="b1" x="14" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="62" y="72" text-anchor="middle" dominant-baseline="middle">① 双写</text>
<text class="ts" x="62" y="92" text-anchor="middle">新旧库同时写</text>
<rect class="b1" x="132" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="180" y="72" text-anchor="middle" dominant-baseline="middle">② 全量迁移</text>
<text class="ts" x="180" y="92" text-anchor="middle">按主键批量拷贝</text>
<rect class="b1" x="250" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="298" y="72" text-anchor="middle" dominant-baseline="middle">③ 增量追平</text>
<text class="ts" x="298" y="92" text-anchor="middle">binlog 订阅</text>
<rect class="b3" x="368" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="416" y="72" text-anchor="middle" dominant-baseline="middle">④ 数据校验</text>
<text class="ts" x="416" y="92" text-anchor="middle">抽样 / 全量比对</text>
<rect class="b2" x="486" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="534" y="72" text-anchor="middle" dominant-baseline="middle">⑤ 切读</text>
<text class="ts" x="534" y="92" text-anchor="middle">灰度比例放量</text>
<rect class="b2" x="604" y="50" width="96" height="60" rx="8"/>
<text class="tb" x="652" y="72" text-anchor="middle" dominant-baseline="middle">⑥ 切写</text>
<text class="ts" x="652" y="92" text-anchor="middle">停双写，下线旧库</text>
<line class="l" x1="110" y1="80" x2="132" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="228" y1="80" x2="250" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="346" y1="80" x2="368" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="464" y1="80" x2="486" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="582" y1="80" x2="604" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="357" y="150" text-anchor="middle">任意一步发现问题均可回滚到旧库；旧库保留至少一个业务周期再下线</text>
</svg>
<figcaption>图 3：不停机迁移的六个阶段</figcaption>
</figure>

要点：

- **双写以旧库为准**：写旧库成功即成功，新库失败只记录告警/补偿，避免新库故障拖垮线上；
- 全量迁移与增量同步可用 DTS、Canal、ShardingSphere-Scaling 等；增量**必须幂等**（按主键 upsert）；
- 校验：行数、按主键范围的 checksum、业务关键字段抽样；
- 切读用灰度（1% → 10% → 50% → 100%），并保留回滚开关。

## 冷热分离与替代方案

- 订单等业务有明显时间属性：近 3 个月热表保留在线库，历史数据归档到低成本库或 ClickHouse，比无限拆分更划算；
- 如果团队不想承担分库分表的复杂度：评估 **TiDB / OceanBase** 等分布式数据库，代价是运维成本、MySQL 兼容性差异和延迟特性。

## 相关阅读

- [TiDB 实战：热点、迁移、选型与调优](#/db/tidb-practice)：TiDB：免分片的替代方案与选型
- [MongoDB 复制集、分片与事务](#/db/mongo-cluster)：MongoDB 分片键与热点
- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：一致性哈希与虚拟节点

## 面试追问

> [!QUESTION] 什么时候该分库分表？怎么判断？
> 先穷尽索引优化、缓存、读写分离、归档；当单表数据量过大导致查询/DDL/备份困难，或单库写入、容量、连接数到达瓶颈时再拆。先垂直后水平；评估代价：跨库事务、JOIN、分页、扩容。

> [!QUESTION] 分片键怎么选？选错了怎么办？
> 选高频查询条件、取值均匀、不可变、能让关联数据同分片的列。选错后常表现为广播查询多、数据倾斜，补救靠冗余表 / ES 支撑其他维度，严重时只能按新分片键做数据迁移。

> [!QUESTION] 取模分片如何扩容？
> 取模扩容要重新哈希，数据迁移量大。预先拆成较多逻辑分片（如 64），扩容时整体搬迁逻辑分片到新实例即可；或用一致性哈希减少迁移。

> [!QUESTION] 跨分片分页为什么慢？怎么优化？
> 每个分片都要取前 offset+limit 条再归并，成本随分片数和 offset 增长。优化：禁止深分页，改“游标式”翻页（带上一页最后的排序键）；或把检索放进 ES。

> [!QUESTION] 不停机迁移的流程？
> 双写（旧库为准）→ 全量拷贝 → 增量追平 → 校验 → 灰度切读 → 切写 → 观察后下线旧库，全程保留回滚开关。
