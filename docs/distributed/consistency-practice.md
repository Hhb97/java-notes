---
level: 深入
tags: [数据一致性, 双写, 单一写入源, Outbox, CDC, 对账, 数据校验, 数据修复, 最终一致, 冲正, 迁移校验, 一致性监控]
summary: 数据一致性的工程实践：为什么双写不可靠与“单一写入源 + 派生数据”原则、各类场景（数据库与缓存/搜索/跨库/跨服务/外部系统）的手段选择、对账体系（实时、日终、维度与差异分类）、数据校验（抽样、分块 checksum）、修复流水线（幂等、限速、审计、dry-run）、迁移期双写校验、一致性指标与 SLA，以及用户体验与常见坑。
---

# 数据一致性实战：双写、对账与修复

> [!ABSTRACT] 核心要点
> - 现实中的数据一致性问题几乎都来自一个模式：**同一份业务事实要写到多个地方**（数据库 + 缓存 + 搜索 + 消息 + 下游服务 + 外部系统）。**只要是多处写入，就会有不一致的窗口和概率**，工程的目标不是“消灭不一致”，而是**让不一致可检测、可收敛、可修复**。
> - 首选原则：**单一写入源（Single Source of Truth）+ 派生数据**：业务事实只写一个权威存储（通常是数据库），**其余副本都由它派生**（通过 Outbox/CDC/事务消息异步同步），而不是应用同时双写多处。
> - **双写不可靠**：写入顺序、部分失败、并发交错、重试都会产生不一致，且**无法靠“代码写得仔细”避免**；必须用**事务（同库）**、**可靠事件（Outbox/CDC）** 或 **补偿 + 对账**。
> - **对账（Reconciliation）是最终兜底**：定期/实时对比两侧数据，分类差异（缺失、多余、不一致），**自动修复可确定的，人工处理有风险的**。涉及资金的系统**必须有对账**，见 [案例：订单、支付与对账系统设计详解](#/design/case-payment)。
> - **修复工具本身也是高风险操作**：必须**幂等、限速、可 dry-run、有审计、可回滚**，以“**权威源为准**”的方向明确，避免“修复引发新的不一致”。
> - 把一致性当成**可度量的服务指标**：**收敛时间（P99 延迟）、差异率、未收敛数量、对账覆盖率**，并在产品层面设计“**处理中**”等中间状态，让用户理解最终一致。

## 为什么会不一致

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="双写的失败模式：应用先写数据库再写缓存，数据库成功缓存失败导致缓存旧；两个并发请求交错写入导致缓存与数据库最终值相反；应用写完数据库后进程崩溃，消息未发出导致下游缺失；先发消息后写数据库导致消息已发但事务回滚；同时写多个存储没有统一事务，部分成功">
<rect class="b3" x="20" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">① 部分失败</text>
<text class="ts" x="195" y="62" text-anchor="middle">写 DB 成功 → 写缓存/ES/下游失败</text>
<text class="ts" x="195" y="84" text-anchor="middle">或 DB 事务回滚但消息已发出</text>
<text class="ts" x="195" y="106" text-anchor="middle">结果：多处状态不一致</text>
<text class="ts" x="195" y="134" text-anchor="middle">重试可能重复、不重试则缺失</text>
<rect class="b5" x="390" y="14" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">② 并发交错（顺序问题）</text>
<text class="ts" x="565" y="62" text-anchor="middle">请求 A、B 同时更新同一行：</text>
<text class="ts" x="565" y="84" text-anchor="middle">DB 顺序 A→B，缓存/ES 写入顺序 B→A</text>
<text class="ts" x="565" y="106" text-anchor="middle">结果：DB 是 B，缓存是 A，且不会自愈</text>
<text class="ts" x="565" y="134" text-anchor="middle">没有全局顺序保证</text>
<rect class="b1" x="20" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="200" text-anchor="middle" dominant-baseline="middle">③ 崩溃窗口</text>
<text class="ts" x="195" y="228" text-anchor="middle">提交事务后、发消息前进程崩溃</text>
<text class="ts" x="195" y="250" text-anchor="middle">→ 下游永远收不到变更</text>
<text class="ts" x="195" y="272" text-anchor="middle">任何“先 A 后 B”的两步操作，</text>
<text class="ts" x="195" y="292" text-anchor="middle">在中间崩溃都会留下半截状态</text>
<rect class="b4" x="390" y="180" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="200" text-anchor="middle" dominant-baseline="middle">④ 外部不可控</text>
<text class="ts" x="565" y="228" text-anchor="middle">调用外部系统超时：结果未知</text>
<text class="ts" x="565" y="250" text-anchor="middle">外部系统自身变更（人工、对方 bug）</text>
<text class="ts" x="565" y="272" text-anchor="middle">数据人工修改、脚本误操作</text>
<text class="ts" x="565" y="292" text-anchor="middle">必须靠对账发现</text>
</svg>
<figcaption>图 1：多处写入产生不一致的四类原因</figcaption>
</figure>

结论：**无法在应用代码里“小心地写多处”来保证一致**。需要**结构性手段**。

## 单一写入源 + 派生数据

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="单一写入源与派生数据：应用只写权威数据库，在同一事务内写入业务表和 Outbox 表；变更通过 CDC 或 Outbox 中继发布到消息队列；缓存、搜索索引、数仓、下游服务等派生数据由消费者幂等地更新；派生数据丢失或损坏时可以由权威源重建；对账与修复服务比较权威源与派生数据">
<rect class="b3" x="20" y="30" width="150" height="80" rx="10"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">应用</text>
<text class="ts" x="95" y="74" text-anchor="middle">只写权威库</text>
<text class="ts" x="95" y="92" text-anchor="middle">同事务写 Outbox</text>
<rect class="b5" x="200" y="30" width="150" height="80" rx="10"/>
<text class="tb" x="275" y="50" text-anchor="middle" dominant-baseline="middle">权威数据库</text>
<text class="ts" x="275" y="74" text-anchor="middle">事实来源（SoT）</text>
<text class="ts" x="275" y="92" text-anchor="middle">事务保证一致</text>
<rect class="b1" x="380" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="450" y="50" text-anchor="middle" dominant-baseline="middle">变更发布</text>
<text class="ts" x="450" y="74" text-anchor="middle">Outbox 中继 / CDC</text>
<text class="ts" x="450" y="92" text-anchor="middle">→ 消息队列</text>
<rect class="b4" x="550" y="14" width="190" height="34" rx="6"/>
<text class="ts" x="645" y="31" text-anchor="middle" dominant-baseline="middle">缓存（Redis）</text>
<rect class="b4" x="550" y="54" width="190" height="34" rx="6"/>
<text class="ts" x="645" y="71" text-anchor="middle" dominant-baseline="middle">搜索索引（ES）</text>
<rect class="b4" x="550" y="94" width="190" height="34" rx="6"/>
<text class="ts" x="645" y="111" text-anchor="middle" dominant-baseline="middle">数仓 / 下游服务</text>
<line class="l" x1="170" y1="70" x2="200" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="70" x2="380" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="60" x2="550" y2="31" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="70" x2="550" y2="71" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="80" x2="550" y2="111" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="150" width="720" height="170" rx="8"/>
<text class="th" x="32" y="170">原则与收益</text>
<text class="ts" x="380" y="196" text-anchor="middle">① 业务事实只写一处：事务保证权威数据内部一致；② 变更事件可靠发布（Outbox/CDC）：不丢、可重放</text>
<text class="ts" x="380" y="218" text-anchor="middle">③ 派生数据由消费者幂等更新，可乱序容忍（带版本号，旧事件丢弃）；④ 派生数据可随时由权威源全量重建</text>
<text class="ts" x="380" y="240" text-anchor="middle">⑤ 权威源与派生数据之间的差异由对账发现并修复；⑥ 收敛时间可度量（事件延迟），不一致窗口有上界</text>
<text class="ts" x="380" y="266" text-anchor="middle">代价：派生数据最终一致，存在读到旧值的窗口；需要建设事件管道、幂等消费与对账</text>
<text class="ta" x="380" y="296" text-anchor="middle">对于“读自己的写”的体验，用会话粘性、读主、写后本地更新缓存等手段补足</text>
</svg>
<figcaption>图 2：单一写入源与派生数据的架构</figcaption>
</figure>

## 按场景选择手段

| 场景 | 推荐手段 | 说明 |
| --- | --- | --- |
| **同库多表** | **本地事务** | 最简单；能同库就同库（强一致首选） |
| **数据库 → 缓存** | **Cache Aside：先更新库再删缓存** + 订阅 binlog 异步删除/延迟双删兜底 + TTL | 见 [缓存设计与一致性](#/redis/cache)；TTL 是最终兜底 |
| **数据库 → 搜索（ES）** | **CDC/Outbox → MQ → 幂等 upsert**，带版本号（以业务版本或更新时间作 ES 外部版本）；定期全量/增量对账 | 见 [ES 实战与数据同步](#/mw/es-practice) |
| **数据库 → 数仓/分析** | CDC 实时 + 离线校验 | 见 [CDC 与实时数仓架构](#/bigdata/cdc) |
| **服务 A → 服务 B（跨服务业务）** | **Outbox/事务消息 + 消费者幂等**；需要补偿的用 **Saga**；强一致短事务可 **TCC** | 见 [分布式事务](#/distributed/transaction)、[事件驱动架构](#/design/event-driven) |
| **跨库（分库分表）** | 尽量让事务落同一分片；跨分片用 Saga/消息 + 对账 | 见 [分片、一致性哈希与再平衡](#/distributed/partitioning) |
| **调用外部系统（支付、物流）** | **本地状态机 + 幂等键 + 查询确认 + 异步回调 + 对账** | 见 [幂等设计与重试](#/distributed/idempotent) |
| **跨系统资金/库存** | **流水（不可变）为准** + 余额由流水派生 + 对账 | 见 [案例：订单、支付与对账系统设计详解](#/design/case-payment) |
| **主备/多活数据同步** | 复制 + 冲突策略 + 校验 | 见 [复制与一致性](#/distributed/replication)、[异地多活与单元化架构](#/design/arch-multi-active) |

### 事件管道的一致性要点

- **Outbox 同事务写入**：业务变更与“待发布事件”同一个数据库事务，**事务提交 ⇒ 事件必然存在**；中继程序读取 Outbox 发布到 MQ，成功后标记/删除；
- **CDC 抓取 binlog/WAL**：无需改业务代码，**以数据库变更为事实**，但要处理表结构变更、事务边界、顺序（同一主键按序）；
- **事件至少一次 ⇒ 消费者幂等**；**同一实体的事件按键保序**（同键进同分区）；
- **事件携带版本号/更新时间**，消费者丢弃**过时事件**（版本 ≤ 已处理版本），避免乱序覆盖；
- **全量快照 + 增量**：建立新派生视图时，先快照再追增量，增量与快照的衔接点要精确（位点对齐）。

## 对账

### 为什么需要

即使有可靠事件，仍会因为：**程序 bug、事件丢失/积压、人工改库、外部系统变更、历史遗留脏数据、迁移遗漏**而不一致。**对账 = 用独立的核对通道发现一切你没预料到的问题**，是对设计假设的“审计”。

### 对账的分类

| 类型 | 说明 | 例子 |
| --- | --- | --- |
| **内部对账** | 同一系统内多处数据比对 | 订单表 vs 支付表 vs 库存流水；DB vs ES vs 缓存 |
| **外部对账** | 与外部系统（渠道、银行、供应商）的账单/状态比对 | 支付渠道对账单、物流状态 |
| **实时对账** | 事件触发或近实时校验关键不变式 | 每笔交易后校验借贷平衡；消息处理后校验状态 |
| **准实时/定时对账** | 每小时/每天对一个时间窗口全量比对 | 日终对账、T+1 账单核对 |
| **抽样对账** | 对大表随机/分层抽样 | 搜索索引与库的一致性抽检 |
| **不变式校验** | 校验“永远应成立”的规则 | 余额 = 期初 + 入账 − 出账；库存 ≥ 0；订单金额 = 明细合计 |

### 对账流程

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="对账流程：取两侧数据的同一时间窗口快照（或导出对账文件），按业务主键关联比对，生成差异清单并分类（单边缺失长款短款、金额不一致、状态不一致、重复），自动修复可确定的差异，高风险差异人工审核，修复后复核并统计指标，持续改进根因">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 取数</text>
<text class="ts" x="75" y="74" text-anchor="middle">同窗口快照</text>
<rect class="b5" x="145" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="52" text-anchor="middle" dominant-baseline="middle">② 关联比对</text>
<text class="ts" x="200" y="74" text-anchor="middle">业务主键 join</text>
<rect class="b1" x="270" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="52" text-anchor="middle" dominant-baseline="middle">③ 差异分类</text>
<text class="ts" x="325" y="74" text-anchor="middle">缺失·不一致</text>
<rect class="b4" x="395" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="455" y="52" text-anchor="middle" dominant-baseline="middle">④ 修复</text>
<text class="ts" x="455" y="74" text-anchor="middle">自动/人工</text>
<rect class="b2" x="530" y="30" width="100" height="64" rx="8"/>
<text class="tb" x="580" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 复核</text>
<text class="ts" x="580" y="74" text-anchor="middle">差异归零</text>
<rect class="b3" x="645" y="30" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 根因</text>
<text class="ts" x="692" y="74" text-anchor="middle">改进闭环</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="62" x2="270" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="62" x2="395" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="62" x2="530" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="62" x2="645" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="720" height="204" rx="8"/>
<text class="th" x="32" y="136">要点</text>
<text class="ts" x="380" y="162" text-anchor="middle">时间窗口对齐：比对“截止某一时刻已完成的数据”，窗口边界上的在途交易要排除或延后一个周期再核（避免误报）</text>
<text class="ts" x="380" y="184" text-anchor="middle">按业务主键比对（订单号、流水号），而不是 ID 或行号；金额以最小单位（分）整数比较</text>
<text class="ts" x="380" y="206" text-anchor="middle">差异类型：单边缺失（A 有 B 无 / B 有 A 无）、金额不一致、状态不一致、重复记录、时间超限未终态</text>
<text class="ts" x="380" y="228" text-anchor="middle">差异处理分级：可确定方向的（权威源明确）自动修复；涉及资金、跨主体或原因不明的人工审核，保留证据</text>
<text class="ts" x="380" y="250" text-anchor="middle">对账结果可观测：差异率、未处理数量与账龄、修复耗时、按根因分类的 Top 问题，持续推动源头修复</text>
<text class="ts" x="380" y="272" text-anchor="middle">大数据量对账：按分区/哈希桶分片并行；先比总数与摘要（checksum），不一致的桶再下钻到明细</text>
<text class="ta" x="380" y="302" text-anchor="middle">“长款/短款”：我方多记（长）或少记（短）资金，是支付对账的常用术语</text>
</svg>
<figcaption>图 3：对账的标准流程与要点</figcaption>
</figure>

### 数据校验技术

| 技术 | 适用 | 做法 |
| --- | --- | --- |
| **总量/摘要比对** | 快速发现问题 | `COUNT`、`SUM(金额)`、`MAX(更新时间)` 按分区/日期比对；不一致再细查 |
| **分块 checksum** | 大表主从/迁移校验 | 把表按主键范围分块，每块计算哈希（如 CRC/MD5 聚合），比对各块；不一致的块逐行比较（`pt-table-checksum` 等工具思路） |
| **Merkle 树** | 副本间差异定位 | 分层哈希快速定位差异范围，见 [复制与一致性](#/distributed/replication) |
| **抽样比对** | 超大规模、低风险数据 | 随机/分层抽样，估计差异率 |
| **双读比对（影子读）** | 迁移/重构期 | 生产请求同时读新旧两路，比较结果并记录差异，但只返回旧路结果 |
| **不变式扫描** | 关键业务规则 | 定期扫描违反规则的数据（负库存、孤儿记录、状态停留超时） |

## 修复

### 修复的原则

| 原则 | 说明 |
| --- | --- |
| **明确权威方向** | 修复必须规定**以谁为准**（通常是权威库/外部账单）；方向不明确的不自动修复 |
| **幂等** | 修复脚本可重复执行不产生副作用；基于业务键与条件更新 |
| **限速** | 控制批量修复对线上库/下游的压力，分批、可暂停 |
| **dry-run** | 先输出“将要做什么”，评审后再执行 |
| **审计** | 记录谁、何时、修复了什么、修复前后值；资金类需双人复核 |
| **可回滚** | 保留修复前快照/反向操作 |
| **走业务通道而非直接改库** | 尽量通过业务接口/事件重放修复，**触发正常的下游联动与校验**；直接改库会绕过缓存失效、事件、审计，造成新的不一致 |
| **修完要复核** | 重新对账确认差异消除 |

### 常见修复手段

| 手段 | 适用 | 说明 |
| --- | --- | --- |
| **重放事件/重新同步** | 派生数据缺失或落后 | 从权威源重新发布变更事件，或触发单条/批量“重同步”任务 |
| **重建派生数据** | 派生数据损坏范围大 | 缓存直接删除重建；ES/数仓按时间窗口或全量重建（新索引 + 别名切换），见 [ES 集群运维](#/mw/es-ops) |
| **补偿/冲正** | 已发生的资金/库存错误 | **新增一笔反向流水**（冲正/红冲），而不是修改历史记录；保持账务不可篡改 |
| **以权威源覆盖** | 派生/副本数据不一致 | 以源数据覆盖目标，带版本条件 |
| **状态推进/回退** | 卡在中间状态的流程 | 按状态机允许的路径推进（如“处理中”超时后查询外部结果再置终态） |
| **人工审核修复** | 原因不明、跨主体、金额大 | 工单化，保留证据，审批后执行 |

> [!WARNING] 不要“直接 UPDATE 修数据”
> 紧急情况下手写 SQL 修库最容易**引发二次事故**：绕过业务校验、不触发缓存失效与下游事件、没有审计、WHERE 写错影响范围。应当把常见修复沉淀为**受控工具/接口**（带权限、审批、dry-run、限速、审计），手工 SQL 仅限无替代时并经双人复核。

## 迁移期的一致性（双写 + 校验）

数据库迁移、分库分表改造、系统重构常用**“双写 + 校验 + 切读 + 切写”**：

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="迁移期一致性流程：阶段一全量迁移存量数据并开启增量同步；阶段二应用双写新旧两处，旧库为准；阶段三影子读比对新旧结果并修复差异；阶段四逐步切读到新库，仍双写；阶段五切写到新库为准，旧库降级为备份；阶段六观察稳定后下线旧库；每阶段可回退">
<rect class="b3" x="20" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">① 全量+增量</text>
<text class="ts" x="75" y="84" text-anchor="middle">存量迁移</text>
<rect class="b5" x="145" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">② 双写</text>
<text class="ts" x="200" y="84" text-anchor="middle">旧库为准</text>
<rect class="b1" x="270" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="62" text-anchor="middle" dominant-baseline="middle">③ 校验</text>
<text class="ts" x="325" y="84" text-anchor="middle">影子读+对账</text>
<rect class="b4" x="395" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="450" y="62" text-anchor="middle" dominant-baseline="middle">④ 灰度切读</text>
<text class="ts" x="450" y="84" text-anchor="middle">仍双写</text>
<rect class="b2" x="520" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="575" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 切写</text>
<text class="ts" x="575" y="84" text-anchor="middle">新库为准</text>
<rect class="b3" x="645" y="40" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="62" text-anchor="middle" dominant-baseline="middle">⑥ 下线旧库</text>
<text class="ts" x="692" y="84" text-anchor="middle">观察后</text>
<line class="l" x1="130" y1="72" x2="145" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="72" x2="270" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="72" x2="395" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="505" y1="72" x2="520" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="72" x2="645" y2="72" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="126" width="720" height="150" rx="8"/>
<text class="th" x="32" y="146">双写迁移的要点</text>
<text class="ts" x="380" y="172" text-anchor="middle">明确“以谁为准”：任一阶段只有一个权威方；另一路写失败不应影响主路，但要记录并补偿（异步重试/对账）</text>
<text class="ts" x="380" y="194" text-anchor="middle">双写顺序与失败：先写权威，后写非权威；非权威写失败入补偿队列；不要在同一事务假装“原子”</text>
<text class="ts" x="380" y="216" text-anchor="middle">差异要归零才推进：影子读差异率持续为 0（或低于阈值并逐条解释）后才灰度切读，每阶段保留回退路径</text>
<text class="ts" x="380" y="238" text-anchor="middle">注意主键/自增/ID、时间精度、字符集、NULL/空串、浮点与 decimal、时区这类“看起来一致其实不同”的差异</text>
<text class="ts" x="380" y="260" text-anchor="middle">对 ID 生成、唯一约束、触发器、级联等行为差异提前评估</text>
</svg>
<figcaption>图 4：双写迁移的阶段与校验</figcaption>
</figure>

## 一致性的度量与 SLA

| 指标 | 含义 | 用途 |
| --- | --- | --- |
| **收敛延迟（Replication/Event Lag）** | 从权威源变更到派生数据可见的时间（P50/P99） | **最终一致的“最终”有多快**，设为 SLO（如 99% < 5 秒） |
| **差异率** | 对账发现的不一致记录 / 比对总数 | 数据质量趋势；按业务/表拆分 |
| **未收敛存量与账龄** | 尚未修复的差异数量与最老差异的存在时间 | 防止问题堆积 |
| **对账覆盖率与及时性** | 参与对账的表/业务占比，对账是否按时完成 | 防止“没对账的就没问题”的错觉 |
| **事件积压/死信量** | 管道健康度 | 与 [消息队列平台化与治理](#/mw/mq-governance) 联动告警 |
| **修复成功率与人工占比** | 自动修复比例 | 衡量自动化程度 |

**不同数据的一致性等级**要明确分级：

| 等级 | 例子 | 要求 |
| --- | --- | --- |
| **强一致** | 账户余额、库存扣减、订单状态 | 同库事务/共识；对账 + 实时不变式 |
| **准实时最终一致** | 订单列表、搜索、推荐 | 收敛秒级；对账日级 |
| **最终一致（可容忍小时级）** | 报表、统计、用户画像 | 日级对账与重算 |
| **可丢弃/可重建** | 缓存、会话 | TTL + 回源 |

## 用户体验与产品设计

最终一致需要**产品层面配合**，否则技术上一致、体验上“出 Bug”：

- **展示中间状态**：“支付处理中”“同步中，稍后刷新”，而不是让用户看到一个与现实不符的终态；
- **读自己的写**：提交后页面直接用服务端返回的结果渲染，或刷新时读主/带版本等待，见 [复制与一致性](#/distributed/replication)；
- **不可逆操作二次确认**，防止在不一致窗口里重复提交（配合幂等，见 [幂等设计与重试](#/distributed/idempotent)）；
- **异常态可恢复**：长时间处理中提供“查询/重试”入口，客服后台能看到全链路状态与手动触发同步；
- **通知与补偿**：发现不一致并修复后，必要时通知用户。

## 常见坑

| 坑 | 说明与对策 |
| --- | --- |
| **应用层双写“靠 try-catch 保证”** | 异常捕获后无法保证补偿成功；改用 Outbox/CDC + 对账 |
| **先写缓存/ES，后写库** | 库失败时脏数据；以权威库为准，先库后派生 |
| **事件乱序覆盖新数据** | 事件带版本号，消费者丢弃旧版本 |
| **对账窗口边界误报** | 在途数据被当成差异；窗口对齐、延后一个周期再确认 |
| **对账只对“总数”** | 抵消性错误（一多一少）发现不了；加金额、明细、关键字段比对 |
| **自动修复方向错误** | 用错误一侧覆盖了正确数据；明确权威源，先 dry-run、小批量验证 |
| **直接改库绕过业务逻辑** | 缓存/事件/审计未联动；走受控修复工具 |
| **修复非幂等** | 重复执行导致重复冲正；基于业务键与条件更新 |
| **修复压垮线上** | 全量修复无限速；分批限速，低峰执行 |
| **派生数据无法重建** | 没有全量重建能力；设计之初就保证可由权威源重建 |
| **没有收敛延迟监控** | “最终”不知道是多久；建立延迟指标与告警 |
| **迁移双写不记录失败** | 非权威路径失败无人知；失败入补偿队列并告警 |
| **时区/精度/字符集差异** | 迁移后“值不同”；校验规则里归一化比较，提前处理差异 |
| **对账只做一次** | 问题随时产生；对账必须持续、自动化、有告警 |

## 检查清单

- [ ] 每类业务事实是否有明确的**权威源**，其他副本是否为**派生数据且可重建**？
- [ ] 变更是否通过 **Outbox/CDC/事务消息** 可靠发布，消费者是否幂等并处理乱序（版本号）？
- [ ] 跨服务/外部调用是否有状态机、幂等键、查询确认与**对账兜底**？
- [ ] 是否有**内部与外部对账**（实时不变式 + 定时全量/抽样），差异是否分类、分级处理？
- [ ] 修复是否走**受控工具**（幂等、限速、dry-run、审计、可回滚），方向是否明确？
- [ ] 迁移/重构是否采用**双写 + 影子读校验 + 灰度切换**，每步可回退？
- [ ] 是否监控**收敛延迟、差异率、未收敛存量、对账覆盖率**并告警？
- [ ] 产品层是否设计了中间状态、读自己的写与可恢复入口？

## 相关阅读

- [分布式事务](#/distributed/transaction)：2PC、TCC、Saga 与本地消息表
- [幂等设计与重试](#/distributed/idempotent)：重复与未知结果的处理
- [复制与一致性：主从、多主与无主](#/distributed/replication)：复制延迟与冲突解决
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：可靠事件管道
- [缓存设计与一致性](#/redis/cache)：数据库与缓存的一致性
- [案例：订单、支付与对账系统设计详解](#/design/case-payment)：资金对账的完整设计

## 面试追问

> [!QUESTION] 为什么应用层双写不可靠？怎么保证多处数据一致？
> 多处写入会遇到部分失败、并发交错顺序不一致、中间崩溃留下半截状态、外部超时结果未知，靠代码小心无法消除。应采用单一写入源加派生数据：业务事实只写权威库，同事务写 Outbox 或用 CDC 可靠发布变更，缓存、搜索、下游由消费者幂等更新并带版本号处理乱序，再用对账发现并修复残留差异。

> [!QUESTION] 对账是怎么做的？有什么要点？
> 取两侧同一时间窗口的数据，按业务主键关联比对，生成差异并分类为单边缺失、金额不一致、状态不一致、重复等；可确定方向的自动修复，涉及资金或原因不明的人工审核；修复后复核。要点是窗口对齐排除在途数据、金额用最小单位、比对明细而非只比总数、大数据按分区并行并先比摘要再下钻，同时监控差异率与账龄。

> [!QUESTION] 数据修复要注意什么？
> 先明确以谁为准，修复要幂等、限速、可 dry-run、有审计、可回滚；尽量走业务通道或受控工具，让缓存失效、事件、审计联动，避免直接 UPDATE 改库；资金类用新增反向流水冲正而不是修改历史；修复后重新对账确认差异归零。

> [!QUESTION] 数据库迁移时怎么保证一致？
> 采用全量加增量同步、应用双写、影子读比对、灰度切读、切写、最后下线旧库的流程。任何阶段只有一个权威方，非权威路径写失败入补偿队列，影子读差异归零再推进，每阶段保留回退；还要提前评估主键、精度、字符集、时区等隐性差异。

> [!QUESTION] 怎么衡量“最终一致”？
> 把最终的快慢量化：收敛延迟 P99 作为 SLO，差异率、未收敛存量与最老差异账龄、对账覆盖率与及时性、事件积压与死信量。并按数据重要性分级，账户余额等强一致，订单搜索准实时最终一致，报表可小时级。

> [!QUESTION] 用户体验上怎么配合最终一致？
> 展示处理中等中间状态而不是错误终态，提交后用服务端返回结果渲染或读主保证读到自己的写，不可逆操作二次确认并配合幂等，长时间未收敛提供查询和重试入口，客服后台能看到全链路状态，修复后必要时通知用户。
