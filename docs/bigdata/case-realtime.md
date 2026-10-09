---
level: 深入
tags: [架构案例, 实时数仓, Flink CDC, Paimon, Doris, 指标口径, 对账, 容量规划, 大促]
summary: 一个完整的大数据架构设计案例：电商实时数据平台。从需求与 SLO、分层与组件选型、订单宽表拼接、指标口径与累计窗口、作业拆分与容量、Exactly-Once 链路、Doris 服务层、回溯与对账、故障演练，到成本与落地路线，逐项给出设计细节。
---

# 案例：电商实时数据平台设计详解（CDC → Flink → 湖仓 → Doris）

> [!ABSTRACT] 本页怎么读
> 这是一份可对照落地的**设计文档示例**。数字均为**列明的假设**，用来演示如何从需求推导容量与配置；你的业务需要用真实数据与压测替换。主线与结论：
> - **按“延迟目标 + 状态大小 + 一致性要求”拆作业**，而不是一个巨型作业：大屏聚合（小状态、秒级）、埋点去重（大状态、容忍至少一次）、订单宽表（多流拼接、要可更新）各用最合适的方案。
> - **订单宽表交给 Paimon 的 partial-update 拼接**，而不是在 Flink 里做多流 Join 状态：状态在湖表里，Flink 作业无大状态、易恢复。
> - **指标口径是设计核心**：大屏用**流水口径**（当前时间段发生的支付/退款），财务用**归属口径**（按下单日归属，T+1 离线）；**两者天然不同，要在产品上讲清并通过对账约束误差**。
> - **“累计窗口（CUMULATE）+ Upsert 写 Doris”** 实现“当日累计 GMV 每 5 秒刷新”，端到端延迟由 **窗口步长 + Watermark 延迟 + Checkpoint 间隔**三项相加决定。
> - **回溯能力靠湖仓**：Kafka 只留 3 天，**Paimon ODS 保存全量变更**，任何作业都可从湖表重放；对账与修正有专门的闭环。

相关原理见 [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core)、[Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state)、[CDC 与实时数仓架构](#/bigdata/cdc)、[OLAP：ClickHouse 与 Doris](#/bigdata/olap)、[Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake)、[Flink 内部机制：执行图、网络栈、内存与 Key Group](#/bigdata/flink-internals)。

## 1. 背景与需求

**业务**：综合电商平台。现状是 T+1 离线报表，运营和风控需要**实时**看到交易与流量，大促期间尤其依赖。

### 数据规模（假设）

```text
订单：日均 1,000 万单；常态峰值 2,000 单/s；大促峰值 10,000 单/s
订单变更事件：每单平均 6 次状态变更（创建/支付/发货/签收/退款…）→ 6,000 万条 binlog 事件/天
                 大促峰值约 3 万事件/s
埋点：DAU 3,000 万，人均 80 事件 → 24 亿条/天（日均 2.8 万/s）；峰值 ≈ 15 万/s（大促更高）
单条埋点约 1 KB → 峰值 ≈ 150 MB/s
维度：商品 300 万 SKU、店铺 20 万、用户 1.5 亿
```

### 需求与 SLO

| 编号 | 需求 | 指标 |
| --- | --- | --- |
| R1 | **实时大屏**：全站/品类/地区的 GMV、订单量、支付转化、Top 店铺 | 端到端延迟 **P95 ≤ 20 s**；大屏查询 P95 < 1 s |
| R2 | **商家实时看板**：店铺级交易、流量、转化漏斗 | 延迟 P95 ≤ 30 s；并发 500 QPS，P95 < 1 s |
| R3 | **活动漏斗**：曝光→点击→加购→下单→支付 | 分钟级刷新 |
| R4 | **实时特征**：用户近 5 分钟/1 小时行为聚合，供推荐与风控 | 延迟 **P95 ≤ 3 s**，写入 Redis |
| R5 | **数据正确性**：实时指标与离线 T+1 对账 | 偏差 **≤ 0.1%**，超限告警并自动修正 |
| R6 | **可回溯**：修复 Bug 后可重算最近 7 天；明细保留 3 年 | 任意时间点重算 |
| R7 | **稳定性** | 可用性 99.9%；作业故障恢复 RTO ≤ 10 min；大促零数据丢失 |

## 2. 总体架构

<figure class="fig">
<svg viewBox="0 0 780 500" class="dg" role="img" aria-label="电商实时数据平台总体架构：数据源经 Flink CDC 与埋点进入 Kafka，再由 Flink 加工为 Paimon 分层表与 Doris 指标表及 Redis 特征，离线 Spark 校正并对账，观测与治理贯穿全链路">
<rect class="b" x="20" y="20" width="150" height="130" rx="10"/>
<text class="th" x="95" y="42" text-anchor="middle">数据源</text>
<text class="ts" x="95" y="68" text-anchor="middle">订单库 MySQL（分库）</text>
<text class="ts" x="95" y="88" text-anchor="middle">商品/用户库</text>
<text class="ts" x="95" y="108" text-anchor="middle">埋点（App/H5）</text>
<text class="ts" x="95" y="128" text-anchor="middle">物流/支付回调</text>
<rect class="b3" x="210" y="20" width="160" height="130" rx="10"/>
<text class="th" x="290" y="42" text-anchor="middle">采集层</text>
<text class="ts" x="290" y="68" text-anchor="middle">Flink CDC（读从库）</text>
<text class="ts" x="290" y="88" text-anchor="middle">整库同步 + Schema 演进</text>
<text class="ts" x="290" y="112" text-anchor="middle">埋点网关 → Kafka</text>
<text class="ts" x="290" y="132" text-anchor="middle">（格式校验/限流）</text>
<line class="l" x1="170" y1="85" x2="210" y2="85" marker-end="url(#arr)"/>
<rect class="b4" x="410" y="20" width="150" height="130" rx="10"/>
<text class="th" x="485" y="42" text-anchor="middle">Kafka（消息总线）</text>
<text class="ts" x="485" y="68" text-anchor="middle">ods_order_cdc  48 分区</text>
<text class="ts" x="485" y="88" text-anchor="middle">ods_click      96 分区</text>
<text class="ts" x="485" y="108" text-anchor="middle">保留 3 天 · 副本 3</text>
<text class="ts" x="485" y="128" text-anchor="middle">解耦 · 多消费者 · 削峰</text>
<line class="l" x1="370" y1="85" x2="410" y2="85" marker-end="url(#arr)"/>
<rect class="b5" x="600" y="20" width="160" height="130" rx="10"/>
<text class="th" x="680" y="42" text-anchor="middle">Paimon ODS</text>
<text class="ts" x="680" y="68" text-anchor="middle">全量变更归档</text>
<text class="ts" x="680" y="88" text-anchor="middle">（对象存储）</text>
<text class="ts" x="680" y="112" text-anchor="middle">保留 3 年 · 可重放</text>
<text class="ts" x="680" y="132" text-anchor="middle">回溯与回补的“真相源”</text>
<line class="l" x1="560" y1="85" x2="600" y2="85" marker-end="url(#arr)"/>
<rect class="b1" x="20" y="190" width="350" height="130" rx="10"/>
<text class="th" x="195" y="212" text-anchor="middle">加工层（Flink 作业，按特性拆分）</text>
<text class="ts" x="195" y="238" text-anchor="middle">J1 埋点清洗+去重（大状态）→ Kafka dwd_click + Paimon</text>
<text class="ts" x="195" y="258" text-anchor="middle">J2 订单宽表（Paimon partial-update 拼接）</text>
<text class="ts" x="195" y="278" text-anchor="middle">J3 大屏/商家指标（CUMULATE 窗口，小状态，秒级）</text>
<text class="ts" x="195" y="298" text-anchor="middle">J4 实时特征（逐事件，至少一次 + 幂等）→ Redis</text>
<rect class="b2" x="410" y="190" width="350" height="130" rx="10"/>
<text class="th" x="585" y="212" text-anchor="middle">服务层</text>
<text class="ts" x="585" y="238" text-anchor="middle">Doris：指标表（主键模型）· 明细加速 · 即席</text>
<text class="ts" x="585" y="258" text-anchor="middle">Redis：实时特征 · 大屏接口缓存（TTL 5s）</text>
<text class="ts" x="585" y="278" text-anchor="middle">指标服务（Java）：统一口径、鉴权、限流</text>
<text class="ts" x="585" y="298" text-anchor="middle">Paimon DWD/DWS：湖仓分层，供 Spark/Trino 查询</text>
<line class="l" x1="485" y1="150" x2="195" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="680" y1="150" x2="585" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="255" x2="410" y2="255" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="350" width="460" height="130" rx="12"/>
<text class="th" x="36" y="374">离线与校正</text>
<text class="ts" x="36" y="398">Spark 按天批处理（读 Paimon ODS/DWD）→ 财务/归属口径</text>
<text class="ts" x="36" y="418">对账任务：实时 vs 离线（金额、订单数、按维度），误差超 0.1% 告警</text>
<text class="ts" x="36" y="438">修正任务：覆盖写 Doris 昨日分区 / 触发实时作业回补</text>
<text class="ts" x="36" y="458">调度：DolphinScheduler / Airflow</text>
<rect class="bg" x="500" y="350" width="260" height="130" rx="12"/>
<text class="th" x="516" y="374">观测与治理</text>
<text class="ts" x="516" y="398">延迟探针（金丝雀订单）· Lag · Watermark</text>
<text class="ts" x="516" y="418">Checkpoint · 反压 · 状态大小</text>
<text class="ts" x="516" y="438">数据质量规则 · 血缘 · 元数据 · 权限</text>
<text class="ts" x="516" y="458">告警 → On-call</text>
<line class="ld" x1="195" y1="320" x2="195" y2="350"/>
<line class="ld" x1="585" y1="320" x2="585" y2="350"/>
</svg>
<figcaption>图 1：总体架构：Kafka 做实时总线，Paimon 做可回溯的真相源，Doris 做服务层</figcaption>
</figure>

## 3. 关键设计决策（ADR 摘要）

| # | 决策 | 备选 | 选择与理由 |
| --- | --- | --- | --- |
| 1 | CDC 读取位置 | 读主库 / 读专用从库 | **读专用 binlog 从库**（开启 GTID、ROW），避免影响交易；整库同步用 Flink CDC Pipeline，自动同步 Schema 变更 |
| 2 | 消息总线 | CDC 直写湖 / CDC → Kafka → 多消费者 | **CDC → Kafka 总线**：多个下游（宽表、风控、搜索同步）解耦，Kafka 削峰；同时由独立作业**归档到 Paimon ODS** 作为长期真相源 |
| 3 | 订单宽表拼接 | Flink 多流 Join（大状态）/ Paimon partial-update | **Paimon partial-update**：订单主表、支付、物流三类流**各自写同一主键表的不同列**，状态在湖表里，Flink 无大状态，故障恢复快 |
| 4 | 湖表格式 | Iceberg / Paimon | **Paimon**：主键高频更新 + 流读 Changelog + Flink 原生；批查询由 Spark/Doris 读取，见 [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |
| 5 | 服务层 | ClickHouse / Doris | **Doris**：主键模型实时 upsert、多表 Join、500 QPS 看板并发、MySQL 协议便于指标服务接入，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |
| 6 | 大屏窗口 | 滚动窗口 / **CUMULATE 累计窗口** | **CUMULATE**：当日累计值每 5 秒更新一次，满足“当日 GMV”类展示，避免“每分钟才出一个点” |
| 7 | 作业拆分 | 单作业 / 按特性拆 | **按特性拆为 4 类作业**（见 §6），延迟、状态、一致性、资源各自最优 |
| 8 | Sink 一致性 | 全部 2PC / 按需 | **聚合结果 Upsert 幂等写**（主键含窗口）；Doris/Paimon 用 2PC 与 Checkpoint 绑定；Redis 特征至少一次 + 覆盖写 |
| 9 | 指标口径 | 单一口径 | **流水口径（实时）与归属口径（离线）并存**，明确命名，对账只比较**同口径**部分 |
| 10 | 回溯 | 靠 Kafka 重放 / 湖仓 | **湖仓回放**：Kafka 仅 3 天；更久靠 Paimon ODS，批模式回补 |

## 4. 订单宽表：用 partial-update 拼接多流

订单相关数据来自多个来源：订单主表（下单、金额、状态）、**支付回调**（支付状态、渠道、支付时间）、**物流**（发货、签收）、**售后**（退款）。传统做法是 Flink 多流 Join，需要把各流**长期保留在状态**里等对方到达，状态巨大、乱序复杂、回补困难。

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="三类流分别写入同一张 Paimon 主键表的不同列，partial-update 合并引擎按序列号合并各列，形成订单宽表，并产生 changelog 供下游消费">
<rect class="b1" x="20" y="30" width="190" height="56" rx="8"/>
<text class="tb" x="115" y="50" text-anchor="middle" dominant-baseline="middle">订单主流（CDC）</text>
<text class="ts" x="115" y="70" text-anchor="middle">order_id, user_id, amount, status</text>
<rect class="b3" x="20" y="110" width="190" height="56" rx="8"/>
<text class="tb" x="115" y="130" text-anchor="middle" dominant-baseline="middle">支付流（回调/CDC）</text>
<text class="ts" x="115" y="150" text-anchor="middle">order_id, pay_status, pay_time</text>
<rect class="b5" x="20" y="190" width="190" height="56" rx="8"/>
<text class="tb" x="115" y="210" text-anchor="middle" dominant-baseline="middle">物流/售后流</text>
<text class="ts" x="115" y="230" text-anchor="middle">order_id, ship_time, refund_amt</text>
<rect class="b2" x="290" y="60" width="270" height="200" rx="12"/>
<text class="th" x="425" y="84" text-anchor="middle">Paimon 主键表 dwd_order_wide</text>
<text class="tm" x="425" y="108" text-anchor="middle">PRIMARY KEY (order_id)</text>
<text class="ts" x="425" y="132" text-anchor="middle">merge-engine = partial-update</text>
<text class="ts" x="425" y="152" text-anchor="middle">每个来源按自己的“序列号分组”</text>
<text class="ts" x="425" y="172" text-anchor="middle">（如各自的 update_time）更新各自列</text>
<text class="ts" x="425" y="196" text-anchor="middle">非空字段合并；乱序以序列号较大者为准</text>
<text class="ta" x="425" y="226" text-anchor="middle">changelog-producer = lookup</text>
<text class="ts" x="425" y="244" text-anchor="middle">产出完整变更流（-U/+U）</text>
<line class="l" x1="210" y1="58" x2="290" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="138" x2="290" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="218" x2="290" y2="190" marker-end="url(#arr)"/>
<rect class="b4" x="620" y="60" width="140" height="90" rx="10"/>
<text class="tb" x="690" y="84" text-anchor="middle" dominant-baseline="middle">下游流读</text>
<text class="ts" x="690" y="106" text-anchor="middle">Flink 增量读取</text>
<text class="ts" x="690" y="124" text-anchor="middle">Changelog</text>
<rect class="b4" x="620" y="170" width="140" height="90" rx="10"/>
<text class="tb" x="690" y="194" text-anchor="middle" dominant-baseline="middle">批查询</text>
<text class="ts" x="690" y="216" text-anchor="middle">Spark · Doris</text>
<text class="ts" x="690" y="234" text-anchor="middle">离线校正</text>
<line class="l" x1="560" y1="110" x2="620" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="210" x2="620" y2="215" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="290" width="740" height="56" rx="10"/>
<text class="ts" x="390" y="312" text-anchor="middle">对比 Flink 多流 Join：无需在 Flink 状态里长期缓存订单与支付；任一流先到都可先写入自己的列，后到的补全；乱序由序列号处理</text>
<text class="ts" x="390" y="332" text-anchor="middle">代价：Paimon 主键表的写入与 Compaction 资源；晚到的“关键列”导致宽表在一段时间内是“半成品”，下游需要判空或等待完整标记</text>
</svg>
<figcaption>图 2：多流各写自己的列，由 Paimon 的 partial-update 合并成订单宽表</figcaption>
</figure>

```sql
CREATE TABLE paimon.dwd.dwd_order_wide (
  order_id BIGINT, user_id BIGINT, shop_id INT, sku_id BIGINT, amount DECIMAL(12,2),
  order_status STRING, order_time TIMESTAMP(3), order_ver TIMESTAMP(3),         -- 订单流的版本/更新时间
  pay_status STRING, pay_time TIMESTAMP(3), pay_ver TIMESTAMP(3),               -- 支付流的版本
  ship_time TIMESTAMP(3), refund_amount DECIMAL(12,2), after_ver TIMESTAMP(3),  -- 物流/售后流版本
  PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
  'bucket' = '48',
  'merge-engine' = 'partial-update',
  'fields.order_ver.sequence-group' = 'user_id,shop_id,sku_id,amount,order_status,order_time',
  'fields.pay_ver.sequence-group'   = 'pay_status,pay_time',
  'fields.after_ver.sequence-group' = 'ship_time,refund_amount',
  'changelog-producer' = 'lookup',
  'snapshot.time-retained' = '3 d'
);
-- 三个 INSERT 作业分别把订单流、支付流、物流流写入同一张表（各自只填自己的列，其余为 NULL）
```

（`sequence-group` 等选项名以所用 Paimon 版本文档为准。）

**细节与坑**：

- **bucket 数固定**：Paimon 主键表的 bucket 影响写入并行度与后续 Compaction，**建表时按峰值预估**（48 = 与 Kafka 分区/Flink 并行度对齐），后续调整需要重写数据；
- **维度关联**：宽表需要商品类目、店铺信息等**维度**——用 Flink 的 **Lookup Join 关联 Paimon 维表（本地缓存）**写入宽表的维度列，或在下游 DWS 再关联；维度变更晚于事实时，口径上取**下单时刻的维度版本**（时态 Join），避免历史订单被新类目“污染”；
- **删除与退款**：订单被取消不删除行，只更新状态（软状态），**保留审计**；
- **幂等**：Paimon 主键 upsert 天然幂等，重放不会产生重复行。

## 5. 指标口径与累计窗口

### 5.1 两种口径（必须在需求阶段对齐）

| | **流水口径（实时大屏）** | **归属口径（财务/离线）** |
| --- | --- | --- |
| 定义 | **该时段内发生的**支付金额、退款金额 | 订单**按下单日归属**，最终净额（支付 − 退款） |
| 例 | 今天 10:00 支付了昨天的订单：计入今天 10:00 的 GMV | 同一笔仍归属昨天 |
| 退款 | 退款**发生时**计入当时的“退款额”，不回改历史 | 回改订单所属日的净额 |
| 特点 | 实时、**不回撤**，简单稳定 | 精确，但每次变更都可能回改历史 |
| 用途 | 大屏、运营监控 | 财务报表、考核 |

**对账不能直接比较两种口径**：对账比较的是“**同口径的实时值与离线重算值**”（例如离线也计算一份流水口径的 T+1 校验表），并**在大屏上标注口径说明**，否则运营会质疑“大屏与报表对不上”。

### 5.2 CUMULATE 累计窗口：每 5 秒刷新当日累计

<figure class="fig">
<svg viewBox="0 0 780 320" class="dg" role="img" aria-label="CUMULATE 窗口：窗口起点固定为当日零点，每 5 秒输出一次从零点到当前的累计结果，结果以主键 upsert 写入 Doris；端到端延迟由窗口步长、水印延迟与 Checkpoint 间隔叠加">
<line class="l" x1="30" y1="90" x2="750" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="30" y="116" text-anchor="start">00:00 当日零点</text>
<rect class="b1" x="30" y="40" width="130" height="30" rx="4"/>
<text class="tm" x="95" y="55" text-anchor="middle" dominant-baseline="middle">[00:00, 00:00:05)</text>
<rect class="b1" x="30" y="44" width="260" height="22" rx="4"/>
<text class="tm" x="160" y="55" text-anchor="middle" dominant-baseline="middle">[00:00, 00:00:10)</text>
<rect class="b3" x="30" y="48" width="390" height="14" rx="4"/>
<text class="tm" x="225" y="55" text-anchor="middle" dominant-baseline="middle">[00:00, 00:00:15)</text>
<text class="ts" x="450" y="56" text-anchor="start">… 每个步长输出一次“从零点到此刻”的累计结果</text>
<text class="th" x="30" y="150">端到端延迟拆解（目标 P95 ≤ 20 s）</text>
<rect class="b2" x="30" y="164" width="90" height="36" rx="4"/>
<text class="ts" x="75" y="182" text-anchor="middle" dominant-baseline="middle">采集→Kafka</text>
<rect class="b3" x="130" y="164" width="130" height="36" rx="4"/>
<text class="ts" x="195" y="182" text-anchor="middle" dominant-baseline="middle">Watermark 延迟 5s</text>
<rect class="b5" x="270" y="164" width="130" height="36" rx="4"/>
<text class="ts" x="335" y="182" text-anchor="middle" dominant-baseline="middle">窗口步长 5s</text>
<rect class="b4" x="410" y="164" width="150" height="36" rx="4"/>
<text class="ts" x="485" y="182" text-anchor="middle" dominant-baseline="middle">Checkpoint+2PC 5s</text>
<rect class="b2" x="570" y="164" width="90" height="36" rx="4"/>
<text class="ts" x="615" y="182" text-anchor="middle" dominant-baseline="middle">Doris 可见</text>
<rect class="b" x="670" y="164" width="80" height="36" rx="4"/>
<text class="ts" x="710" y="182" text-anchor="middle" dominant-baseline="middle">缓存 5s</text>
<text class="ts" x="30" y="214" text-anchor="start">各项约：~1s + 5s + 5s + 5s + ~1s + 缓存 ≤5s → 合计约 17~22 s</text>
<text class="ts" x="30" y="232" text-anchor="start">Checkpoint 间隔直接决定 Sink 数据可见时间（2PC 在 Checkpoint 完成时提交）</text>
<text class="ts" x="30" y="248" text-anchor="start">降低延迟：减小 Watermark 延迟（需接受更多迟到）、缩短 Checkpoint 间隔（要求状态小、存储快）、缩短缓存 TTL</text>
<text class="ts" x="30" y="274" text-anchor="start">结果主键 = (统计日, 维度…, 窗口结束时间)；用 Upsert 写 Doris 的主键模型，重放与迟到修正都是幂等覆盖</text>
<text class="ts" x="30" y="300" text-anchor="start">迟到数据：allowedLateness 与 Watermark 之外的数据进入侧输出，由对账修正（见 §9）</text>
</svg>
<figcaption>图 3：CUMULATE 窗口与端到端延迟的构成</figcaption>
</figure>

```sql
-- J3：大屏指标（流水口径）：当日累计支付 GMV / 订单数，每 5 秒输出一次
INSERT INTO doris_dws_gmv_realtime
SELECT
  DATE_FORMAT(window_start, 'yyyy-MM-dd')       AS stat_date,
  category_id, province_id,
  window_end                                    AS ts,                -- 作为主键的一部分，重复输出覆盖
  SUM(pay_amount)                               AS gmv,
  COUNT(DISTINCT order_id)                      AS order_cnt
FROM TABLE(CUMULATE(TABLE dwd_pay_event, DESCRIPTOR(pay_time), INTERVAL '5' SECOND, INTERVAL '1' DAY))
GROUP BY window_start, window_end, category_id, province_id;
```

要点：

- **输入是“支付事件流”**（来自宽表 Changelog 中“支付状态变为成功”的事件，而不是订单快照），每笔支付只计一次；
- **`COUNT(DISTINCT order_id)`** 在窗口内状态随时间增长：按（类目×省份）分组后基数可控；全站级去重订单量改用**独立的轻量聚合**或 **HyperLogLog 近似**；
- **热点倾斜**：大促爆款所在类目是热点 → 开启 **Local-Global 两阶段聚合**（见 [Flink SQL、反压与性能调优](#/bigdata/flink-ops)）；
- 如果只要“最近 N 分钟”，用 HOP 滑动窗口；累计值用 CUMULATE，二者不要混用。

## 6. 作业拆分与资源规划

**原则**：按**延迟要求、状态大小、一致性要求**拆分作业，给每类作业最合适的 Checkpoint、状态后端与 Sink 策略。

| 作业 | 职责 | 状态 | Checkpoint | Sink 与一致性 | 并行度（假设） |
| --- | --- | --- | --- | --- | --- |
| **J0 CDC 采集** | Flink CDC 整库同步 → Kafka | 小（位点+快照进度） | 30 s | Kafka 事务（精确一次）；Debezium 格式，按主键分区保序 | 16 |
| **J0b 归档** | Kafka → Paimon ODS | 无 | 60 s | Paimon 提交（精确一次） | 24 |
| **J1 埋点清洗去重** | 解析、过滤爬虫、按 event_id 去重、补充字段 → Kafka `dwd_click` + Paimon | **大**（去重窗口 10 min） | **60 s**，RocksDB 增量 | Kafka 至少一次 + 下游幂等（容忍极少重复）；Paimon 精确一次 | 48 |
| **J2 订单宽表** | 三类流写入 `dwd_order_wide`（partial-update） | **无**（状态在湖表） | 30 s | Paimon 提交 | 48（与 bucket 对齐） |
| **J3 大屏/商家指标** | CUMULATE 窗口聚合 → Doris | **小**（窗口聚合） | **5 s**（状态小，才能短间隔） | **Doris 2PC / 主键 Upsert** | 32 |
| **J4 实时特征** | 逐事件更新用户滑动特征 → Redis | 中（滑动聚合，用状态 TTL） | 30 s | Redis 覆盖写（至少一次 + 幂等） | 48 |
| **J5 漏斗** | 曝光→…→支付的会话级关联（会话窗口） | 中 | 30 s | Doris 主键 Upsert | 24 |

### 为什么这样拆（设计思想）

- **J1 状态大、能容忍极少重复**：Checkpoint 拉长到 60 s，不使用事务 Sink，避免长间隔事务拖慢可见时间；下游用 `event_id` 做幂等；
- **J3 要求秒级延迟、状态小**：Checkpoint 5 s 才可行；**绝不在 J3 里做大状态去重**（否则 5 s Checkpoint 无法完成）；
- **J2 把大状态“外包”给 Paimon**：作业本身几乎无状态，故障恢复秒级；
- **隔离故障面**：任何一个作业失败/反压不影响其他作业；也便于**独立扩缩容与灰度升级**；
- 作业之间通过 Kafka/Paimon 解耦；每个作业都能独立**从 Savepoint 或指定位点重启**。

### 容量估算（演示）

**J1 去重状态**：

```text
峰值 15 万事件/s，去重窗口 10 分钟 → 在窗口内保留约 15万 × 600 = 9,000 万个 key
RocksDB 每 key ≈ key(16B event_id 摘要) + value(1B) + 编码/索引开销 ≈ 60 B → 约 5.4 GB
并行度 48 → 每子任务约 112 MB，增量 Checkpoint 每次只上传变化的 SST —— 小、快
（若去重窗口改为 24 小时：约 130 亿 key ≈ 780 GB，不可行 → 用布隆过滤/缩短窗口/以 Doris 唯一键去重兜底）
```

**吞吐与算力**：

```text
单 Core 处理 JSON 解析 + 轻量转换约 5k~10k 事件/s；J1 含 RocksDB 去重更慢，按 3k~5k 事件/s/核
峰值 15 万/s ÷ 4k ≈ 38 核 → 并行度 48（留 25% 余量）；大促预期 ×2 → 预案：并行度可扩至 96
TM 规格：4 核 / 16 GB，2 个 Slot；托管内存（RocksDB）≈ 5 GB / TM
J1 需要约 24 个 TM（96 核）；J2/J3/J4/J0 合计约 20 个 TM；整体约 45~50 台 4C16G 容器（含冗余）
```

**Kafka**：

```text
峰值 150 MB/s（埋点）+ 订单变更约 30 MB/s → 总写入 ≈ 180 MB/s；副本 3 → 集群内部复制与磁盘写 ≈ 540 MB/s
单 Broker 持续写入按 100 MB/s 计 → 至少 6~8 台 Broker；ods_click 96 分区（≥ Flink 最大并行度 96），ods_order_cdc 48 分区
保留 3 天：180 MB/s × 86400 × 3 ≈ 46 TB（压缩 lz4/zstd 后约 15~20 TB，副本 ×3）
关键配置：acks=all, min.insync.replicas=2, compression=lz4, linger.ms=20, batch.size=128KB
```

分区数与并行度、保序的关系见 [Kafka 架构与存储](#/mw/kafka)，可靠性配置见 [Kafka 副本与可靠性](#/mw/kafka-reliability)。

## 7. Exactly-Once 链路与各环节保障

| 环节 | 机制 | 备注 |
| --- | --- | --- |
| MySQL → Kafka（J0） | Flink CDC 增量快照 + Checkpoint 保存 binlog 位点；Kafka 事务 Sink | 消费者 `read_committed`；GTID 保证主从切换后位点连续 |
| Kafka → Paimon（J0b） | Checkpoint 提交 Paimon 快照 | 快照原子可见，失败回滚 |
| Kafka → Flink → Doris（J3） | Source offset 随 Checkpoint；**Doris Stream Load 两阶段提交（label）** | `sink.enable-2pc=true`；Checkpoint 完成才提交，所以**可见延迟 ≥ Checkpoint 间隔** |
| 聚合结果 | **主键 Upsert**（主键含窗口结束时间） | 迟到更新、重放均覆盖同键，**幂等** |
| Flink → Redis（J4） | 至少一次 + 覆盖写 | 特征是“最新值”语义，重复写无副作用；顺序靠按用户 keyBy 保序 |
| 异常 | 失败重启从 Checkpoint 恢复；**重复输出被主键覆盖** | 无需业务去重 |

**两阶段提交的坑**：Doris/Kafka 事务有**超时时间**，需大于 Checkpoint 间隔 + 最坏恢复时间；Flink 恢复时对“已完成 Checkpoint 的事务”要**重试提交**，因此提交必须幂等；见 [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state)。

## 8. 服务层：Doris 设计

### 表设计

```sql
CREATE TABLE dws_gmv_realtime (
  stat_date    DATE,
  category_id  INT,
  province_id  INT,
  ts           DATETIME,                      -- 窗口结束时间（5 秒粒度）
  gmv          DECIMAL(18,2),
  order_cnt    BIGINT
) UNIQUE KEY (stat_date, category_id, province_id, ts)         -- 主键模型：Upsert
PARTITION BY RANGE (stat_date) ()                              -- 动态分区：保留 7 天 5 秒粒度，历史由小时/天聚合表承接
DISTRIBUTED BY HASH (category_id, province_id) BUCKETS 16
PROPERTIES ("replication_num" = "3", "enable_unique_key_merge_on_write" = "true",
            "dynamic_partition.enable" = "true", "dynamic_partition.time_unit" = "DAY",
            "dynamic_partition.start" = "-7", "dynamic_partition.end" = "2");
```

- **5 秒粒度只保留 7 天**；长期趋势由**小时/天聚合表**（物化视图或定时任务）承接，避免表无限膨胀；
- 主键包含 `ts`，每 5 秒产生一批新主键行：当日累计指标行数 ≈ 17,280（5 秒点/天）× 维度组合（类目 ~300 × 省份 34 ≈ 1 万）= 约 **1.7 亿行/天**；这是**设计时要验证的规模**（可降粒度：对低层级维度用 30 秒步长，或只对大屏所需的 Top 维度做 5 秒）；
- 大屏查询基本是“最新一个 `ts` 的累计值 + 最近 N 分钟曲线”，**命中前缀（stat_date）与分区裁剪**，毫秒级。

### 容量与高可用

```text
集群：3 FE（1 Leader + 2 Follower）+ 6 BE（16 核 / 64 GB / NVMe 2 TB），副本 3
写入：J3 每 5 秒一批 Stream Load，批量大、频率低，避免 “too many versions”
查询：500 QPS 的看板并发 → 前置 指标服务 + Redis 缓存（TTL 5 s）后，Doris 实际 QPS 降到几十
```

- 指标服务（Java）统一提供口径接口、鉴权（商家只能看自己的店铺）、限流，对热点大屏接口使用**缓存与请求合并（single-flight）**，缓存设计见 [缓存设计与一致性](#/redis/cache)；
- 慢查询治理：禁止业务直连 Doris 做大范围明细查询；明细即席分析走 Paimon + Trino/Spark，见 [OLAP：ClickHouse 与 Doris](#/bigdata/olap)。

## 9. 回溯、对账与修正

<figure class="fig">
<svg viewBox="0 0 780 340" class="dg" role="img" aria-label="对账与修正闭环：离线 Spark 读取 Paimon 重算昨日指标，与实时指标对比，超阈值告警并触发覆盖写或回补实时作业，同时保留侧输出迟到数据用于解释差异">
<rect class="b2" x="20" y="40" width="170" height="70" rx="10"/>
<text class="tb" x="105" y="62" text-anchor="middle" dominant-baseline="middle">实时指标（Doris）</text>
<text class="ts" x="105" y="84" text-anchor="middle">流水口径 · 昨日汇总</text>
<rect class="b3" x="240" y="40" width="190" height="70" rx="10"/>
<text class="tb" x="335" y="62" text-anchor="middle" dominant-baseline="middle">离线重算（Spark）</text>
<text class="ts" x="335" y="84" text-anchor="middle">读 Paimon ODS，同口径</text>
<rect class="b4" x="480" y="40" width="130" height="70" rx="10"/>
<text class="tb" x="545" y="62" text-anchor="middle" dominant-baseline="middle">对账比较</text>
<text class="ts" x="545" y="84" text-anchor="middle">按日/维度/金额/单量</text>
<rect class="b5" x="650" y="40" width="110" height="70" rx="10"/>
<text class="tb" x="705" y="62" text-anchor="middle" dominant-baseline="middle">差异判定</text>
<text class="ts" x="705" y="84" text-anchor="middle">阈值 0.1%</text>
<path class="l" d="M105 110 L105 134 L545 134 L545 110" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="75" x2="480" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="75" x2="650" y2="75" marker-end="url(#arr)"/>
<rect class="b1" x="480" y="160" width="140" height="64" rx="10"/>
<text class="tb" x="550" y="182" text-anchor="middle" dominant-baseline="middle">≤ 阈值：通过</text>
<text class="ts" x="550" y="202" text-anchor="middle">记录对账结果</text>
<rect class="b4" x="650" y="160" width="110" height="64" rx="10"/>
<text class="tb" x="705" y="182" text-anchor="middle" dominant-baseline="middle">&gt; 阈值：告警</text>
<text class="ts" x="705" y="202" text-anchor="middle">根因分析</text>
<line class="l" x1="705" y1="110" x2="705" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="110" x2="560" y2="160" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="250" width="740" height="80" rx="10"/>
<text class="th" x="36" y="272">修正路径（按差异类型）</text>
<text class="ts" x="36" y="296">• 迟到数据（侧输出/超出允许迟到）：用离线结果覆盖写 Doris 昨日分区（Upsert，幂等）</text>
<text class="ts" x="36" y="316">• 逻辑 Bug：修复后在测试环境验证，再用 Paimon 批模式回补受影响区间，覆盖写；实时作业从修复版本恢复</text>
</svg>
<figcaption>图 4：实时与离线同口径对账，超阈值触发修正</figcaption>
</figure>

### 对账规则

| 类型 | 规则 | 频率 |
| --- | --- | --- |
| **完整性** | 源表按分钟行数（`COUNT(*)` by `update_time`）vs Paimon ODS 对应行数 | 每 5 分钟 |
| **准确性** | 昨日 GMV/订单数/退款额：Doris 实时汇总 vs Spark 重算（**同口径**），按全站与类目两层 | 每日 T+1 凌晨 |
| **时效性** | **延迟探针**：每分钟向测试店铺注入一笔金丝雀订单，统计其在大屏可见的耗时；Watermark 滞后、Kafka Lag | 持续 |
| **重复/缺失** | 主键唯一性、状态机合法性（不会出现未支付先发货）、金额非负 | 持续 |

### 回溯与回补

- **7 天内重算**：Kafka 3 天内的直接重置位点；更早用 **Paimon ODS 批读**回补；
- **回补流程**：新作业以**批模式**读取 Paimon 指定时间范围 → 计算 → **覆盖写**目标分区；上线前在**影子表**验证，通过后切换；
- **实时作业与回补不冲突**：Doris 主键 Upsert，回补写入的值最终以后写入者为准；需要**保证回补作业写入时间晚于实时作业对该分区的最后写入**（通常回补目标是已“冷却”的昨日及以前分区）；
- **历史明细**保留 3 年在 Paimon（对象存储，压缩后成本低），Doris 只保留热数据。

## 10. 稳定性、故障与大促预案

### 监控与告警

| 层面 | 指标 | 告警条件示例 |
| --- | --- | --- |
| Kafka | 各 Topic Consumer Lag、Broker 磁盘/网络 | Lag 持续增长 > 3 分钟 |
| Flink | **端到端延迟（金丝雀）**、Checkpoint 失败/超时、反压、重启次数、状态大小趋势、Watermark 滞后 | 延迟 P95 > 30 s；Checkpoint 连续失败 3 次 |
| Paimon | Compaction 积压（Level 0 文件数）、快照提交耗时 | L0 文件持续增长 |
| Doris | 导入失败/版本数、查询 P99、BE 负载/磁盘 | `too many versions`、P99 > 2 s |
| 数据质量 | 对账差异、重复率、空值率 | 差异 > 0.1% |

### 故障场景与应对

| 场景 | 影响 | 应对 |
| --- | --- | --- |
| 某个 Flink 作业失败 | 对应指标暂停更新（其他作业不受影响） | 自动按重启策略恢复（指数退避）；J3 状态小，分钟内恢复；超过阈值告警 on-call |
| Kafka Broker 故障 | 分区 Leader 切换，短暂抖动 | 副本 3 + min ISR 2；生产者重试；监控 ISR 收缩 |
| CDC 位点过期/主从切换 | 同步中断 | GTID；binlog 保留 ≥ 7 天；监控位点与源库差距；必要时从快照重做指定表 |
| Doris BE 宕机 | 部分副本不可用 | 副本 3 自动补齐；查询走其他副本；Stream Load 重试 |
| 大批量迟到/乱序 | 窗口结果后续被修正 | allowedLateness + 侧输出；对账修正；产品标注“近 N 分钟数据可能有微调” |
| 上游发布导致 Schema 变更 | 解析失败 | CDC Pipeline 自动同步 Schema；下游使用宽松解析；脏数据入死信 Topic 并告警 |
| 爆款/刷单造成热点 | 个别子任务反压 | 两阶段聚合；热点 key 拆分；风控过滤异常流量 |

### 大促预案

1. **压测**：把**历史峰值流量回放**到压测环境（2× 峰值），验证各作业吞吐、延迟、Checkpoint 与 Doris 写入；
2. **提前扩容**：Flink 并行度/TM 提前调整（从 Savepoint 重启并重分配 Key Group，见 [Flink 内部机制：执行图、网络栈、内存与 Key Group](#/bigdata/flink-internals)）、Kafka 分区预留、Doris BE 扩容；
3. **降级开关**：关闭非核心指标作业（如长尾漏斗）、延长非关键作业 Checkpoint 间隔、降低大屏刷新频率；
4. **冻结变更**：大促前后窗口内禁止发布；
5. **值守与演练**：故障演练（杀 TM、断 Broker、模拟 CDC 位点丢失），验证 RTO；
6. **保护源库**：CDC 读从库并限速，快照阶段错峰。

## 11. 成本与演进

**资源概览（演示量级）**：Flink 约 45~50 台 4C16G 容器；Kafka 6~8 台高吞吐节点（NVMe + 万兆）；Doris 3 FE + 6 BE；Paimon/对象存储明细 3 年（压缩后量级约数百 TB）；Redis 集群若干。主要成本在 **Kafka 与 Flink 的算力**及**对象存储**；优化手段：埋点在采集侧**采样/聚合**（非关键事件）、Kafka 压缩（zstd）、分层存储与冷数据下沉、Flink 弹性伸缩（大促外缩容）。

**演进**：

| 阶段 | 内容 |
| --- | --- |
| 一期（4~6 周） | CDC → Kafka → Paimon ODS；订单宽表；大屏 J3 → Doris；对账雏形 |
| 二期（4 周） | 埋点链路与漏斗；商家看板；实时特征；延迟探针与完善告警 |
| 三期（持续） | 流批一体收敛离线链路（Spark → Flink 批 / Paimon 批）；指标中台（统一口径与语义层）；成本优化；多租户权限 |

## 12. 取舍与复盘清单

| 取舍 | 选择与代价 |
| --- | --- |
| 作业拆成多个 | 隔离与最优配置；运维数量增加，需要统一的作业模板与监控 |
| partial-update 宽表 | 免去 Flink 大状态、回补容易；依赖 Paimon 写入与 Compaction 资源，宽表有“半成品”窗口期 |
| 流水口径 + 归属口径并存 | 实时简单稳定；必须管理预期、产品标注、对账同口径 |
| 5 s Checkpoint | 低延迟；要求作业状态小、存储快，否则频繁超时 |
| CDC → Kafka 再入湖 | 解耦与削峰；多一跳与存储成本 |
| Doris 主键 Upsert 做结果存储 | 幂等、易修正；高基数主键产生行数膨胀，要做粒度分层与保留策略 |
| Kafka 只留 3 天 | 成本低；更久回溯依赖 Paimon，要保证 ODS 完整可信 |

## 面试追问

> [!QUESTION] 为什么不把所有逻辑放在一个 Flink 作业里？
> 不同需求的延迟、状态大小和一致性要求差异很大：秒级大屏需要 5 秒 Checkpoint 和小状态，埋点去重状态大需要长 Checkpoint 间隔，订单宽表适合把状态放在湖表里。拆分后各自选择最合适的配置，故障面和资源相互隔离，也能独立扩缩容和升级。

> [!QUESTION] 订单宽表为什么用 Paimon 的 partial-update 而不是 Flink 多流 Join？
> 多流 Join 要把各流在状态里长期保留等待对方到达，状态巨大、乱序和回补复杂；partial-update 让各流各自写同一主键表的不同列，用序列号处理乱序，状态在湖表中，Flink 作业几乎无状态，恢复快，也便于批量回补。代价是 Paimon 的写入与 Compaction 资源以及宽表短暂的半成品状态。

> [!QUESTION] 实时大屏与离线报表数字对不上，怎么办？
> 先对齐口径：大屏是流水口径（该时段发生的支付与退款），报表是按下单日归属的净额，两者天然不同。设计上让离线也产出一份同口径的校验表用来对账，超过阈值自动告警并用离线结果覆盖修正，同时在大屏标注口径与“近期数据可能微调”。

> [!QUESTION] 这个系统的端到端延迟由哪几部分构成？怎么降低？
> 由采集到 Kafka、Watermark 延迟、窗口步长、Checkpoint 间隔（两阶段提交在 Checkpoint 完成时才提交）、写入可见和缓存几部分相加。可以减小 Watermark 延迟并接受更多迟到、缩短 Checkpoint 间隔（要求状态小）、缩短步长和缓存时间，同时用金丝雀订单持续度量真实延迟。

> [!QUESTION] 如何保证数据不丢不重？
> 链路各环节保证：CDC 用增量快照加 Checkpoint 保存位点、Kafka 事务写入；入湖与写 Doris 通过两阶段提交与 Checkpoint 绑定；聚合结果以含窗口的主键 Upsert，重放和迟到修正都是幂等覆盖；再用同口径的离线对账和修正闭环兜底。

> [!QUESTION] 大促前要做哪些准备？
> 回放历史峰值做 2 倍压测，提前扩容 Flink 并行度、Kafka 分区和 Doris 节点，准备降级开关（关闭非核心作业、拉长 Checkpoint、降低刷新频率），冻结变更，做故障演练验证恢复时间，并保护源库（CDC 读从库、限速快照）。
