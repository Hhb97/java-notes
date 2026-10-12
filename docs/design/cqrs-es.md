---
level: 高级
tags: [CQRS, 事件溯源, Event Sourcing, 读模型, 投影, 快照, Axon, 最终一致]
summary: CQRS（命令查询职责分离）与事件溯源（Event Sourcing）：为什么读写模型要分离、三个演进层次、读模型投影与最终一致的处理、事件溯源的存储/重放/快照/事件版本升级、与 Outbox 和 Kafka 的结合、适用场景与代价，附 Java 代码与账户示例。
---

# CQRS 与事件溯源

> [!ABSTRACT] 核心要点
> - **CQRS**：把**写（命令）**与**读（查询）**拆成两套模型。写侧专注**业务规则与一致性**（聚合），读侧专注**查询性能与展现**（为每种查询定制的读模型/视图）。
> - CQRS 是一个**光谱**：从“同库不同类”到“读写分库 + 异步投影”，**按需升级，不必一步到位**。
> - **事件溯源（ES）**：不存“当前状态”，而是存**导致状态变化的所有事件**；当前状态 = **按序重放事件**。天然有完整审计、可时间旅行、可重建任意读模型。
> - CQRS 与 ES **是两个独立概念**，可以单用 CQRS，也可以组合；ES 几乎总是配合 CQRS（事件存储不好查询，需要读模型）。
> - 代价很高：**最终一致、复杂度、事件版本演进、重放成本**。**只在确有收益时使用**，不要作为默认架构。

> [!NOTE] 前置
> 聚合与领域事件见 [DDD 战术设计](#/design/ddd-tactical)；事件可靠发布与消费见 [事件驱动架构](#/design/event-driven)。

## 一、为什么要分离读写

同一个模型同时满足“强规则写入”和“灵活高效查询”，会互相拖累：

| 写侧诉求 | 读侧诉求 |
| --- | --- |
| 聚合小而内聚，守护不变量 | 联表、聚合、排序、分页、搜索、报表 |
| 范式化、事务、强一致 | **反范式、宽表、缓存、搜索引擎** |
| 低并发、高正确性 | 高并发、低延迟，规模常比写高 1~2 个数量级 |
| 模型围绕“业务行为” | 模型围绕“页面/接口需要的数据” |

典型痛点：为了列表页的各种查询，把聚合设计得越来越“宽”或到处加 `@Transactional(readOnly)` 的联表 SQL，又反过来破坏了领域模型。**CQRS 的做法就是承认两者不同，各用各的模型。**

## 二、CQRS 的三个层次

<figure class="fig">
<svg viewBox="0 0 800 380" class="dg" role="img" aria-label="CQRS 三个层次：第一层同一数据库内命令用聚合、查询用独立的轻量查询服务直接 SQL 投影；第二层读写分库，写库发布事件，异步投影到读库如 Elasticsearch 或 Redis；第三层加上事件溯源，写侧存事件流，投影器生成多个读模型">
<rect class="b3" x="20" y="20" width="760" height="100" rx="12"/>
<text class="th" x="36" y="44">层次 1：同库分模型（最小成本，推荐起点）</text>
<rect class="b2" x="40" y="58" width="150" height="40" rx="6"/>
<text class="ts" x="115" y="78" text-anchor="middle" dominant-baseline="middle">命令 → 应用服务 + 聚合</text>
<rect class="b5" x="230" y="58" width="150" height="40" rx="6"/>
<text class="ts" x="305" y="78" text-anchor="middle" dominant-baseline="middle">查询 → 查询服务 SQL→DTO</text>
<rect class="b" x="520" y="58" width="240" height="40" rx="6"/>
<text class="ts" x="640" y="78" text-anchor="middle" dominant-baseline="middle">同一个数据库，强一致，无同步问题</text>
<line class="l" x1="190" y1="78" x2="230" y2="78" stroke-dasharray="3 3"/>
<rect class="b5" x="20" y="140" width="760" height="110" rx="12"/>
<text class="th" x="36" y="164">层次 2：读写分库 + 事件投影（读写规模不对称时）</text>
<rect class="b2" x="40" y="180" width="130" height="50" rx="6"/>
<text class="ts" x="105" y="205" text-anchor="middle" dominant-baseline="middle">写库（聚合）</text>
<rect class="b4" x="230" y="180" width="130" height="50" rx="6"/>
<text class="ts" x="295" y="205" text-anchor="middle" dominant-baseline="middle">事件（Outbox/CDC）</text>
<rect class="b1" x="420" y="180" width="130" height="50" rx="6"/>
<text class="ts" x="485" y="205" text-anchor="middle" dominant-baseline="middle">投影器</text>
<rect class="b3" x="610" y="170" width="150" height="30" rx="6"/>
<text class="ts" x="685" y="185" text-anchor="middle" dominant-baseline="middle">ES 搜索 / 列表视图</text>
<rect class="b3" x="610" y="206" width="150" height="30" rx="6"/>
<text class="ts" x="685" y="221" text-anchor="middle" dominant-baseline="middle">Redis / 报表库</text>
<line class="l" x1="170" y1="205" x2="230" y2="205" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="205" x2="420" y2="205" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="200" x2="610" y2="185" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="210" x2="610" y2="221" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="270" width="760" height="100" rx="12"/>
<text class="th" x="36" y="294">层次 3：CQRS + 事件溯源（审计/时间旅行/多读模型的强需求）</text>
<rect class="b2" x="40" y="310" width="170" height="44" rx="6"/>
<text class="ts" x="125" y="332" text-anchor="middle" dominant-baseline="middle">事件存储（追加写，事实来源）</text>
<rect class="b1" x="290" y="310" width="140" height="44" rx="6"/>
<text class="ts" x="360" y="332" text-anchor="middle" dominant-baseline="middle">订阅 + 投影</text>
<rect class="b3" x="520" y="310" width="240" height="44" rx="6"/>
<text class="ts" x="640" y="332" text-anchor="middle" dominant-baseline="middle">多个读模型，可随时重建</text>
<line class="l" x1="210" y1="332" x2="290" y2="332" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="332" x2="520" y2="332" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：CQRS 的三个演进层次</figcaption>
</figure>

### 层次 1：同库分模型（强烈推荐先做这一步）

```java
// 命令侧：聚合 + 应用服务（见 DDD 战术设计）
@Transactional
public void pay(PayOrderCmd cmd) { Order o = repo.findById(cmd.id()).orElseThrow(); o.pay(cmd.paymentId(), cmd.amount()); repo.save(o); }

// 查询侧：绕过聚合，直接 SQL 投影到 DTO（可多表联查、分页、排序）
@Mapper
public interface OrderQueryMapper {
    @Select("""
        SELECT o.order_no, o.status, o.total_fen, c.nick_name, COUNT(l.id) AS line_count
          FROM t_order o JOIN t_customer c ON c.id = o.customer_id
          LEFT JOIN t_order_line l ON l.order_no = o.order_no
         WHERE o.customer_id = #{cid} ORDER BY o.created_at DESC LIMIT #{size} OFFSET #{offset}""")
    List<OrderListItem> listByCustomer(...);
}
```

这一步**零基础设施成本**，却解决了“为了查询扭曲聚合”的大部分问题。

### 层次 2：读写分库 + 异步投影

当读流量远超写、或需要搜索引擎/缓存/列式库作为读模型时：写库的变更通过**事件**（Outbox/CDC）异步投影到读模型。

```java
// 投影器：订阅事件，更新读模型（幂等！）
@KafkaListener(topics = "order.events", groupId = "order-list-projection")
public void on(OrderEvent e) {
    switch (e) {
        case OrderPlaced p -> readRepo.upsert(OrderView.from(p));                    // 幂等 upsert
        case OrderPaid pd  -> readRepo.updateIfNewer(pd.orderId(), "PAID", pd.version());   // 版本比较防乱序
        case OrderCancelled c -> readRepo.updateIfNewer(c.orderId(), "CANCELLED", c.version());
        default -> {}
    }
}
```

读模型可以是：**Elasticsearch**（搜索与多维过滤，见 [ES](#/mw/es)）、**Redis**（热点详情）、**ClickHouse/Doris**（报表，见 [OLAP](#/bigdata/olap)）、MySQL 宽表。**同一份事件可以投影出多个读模型**，各自为场景优化。

## 三、最终一致带来的问题与对策

读模型滞后于写模型（通常毫秒~秒级，积压时更长），典型问题：**“我刚提交了订单，列表里看不到”**。

| 对策 | 说明 |
| --- | --- |
| **写后读定向走写库** | 命令返回后，详情页立即查询写侧/主库（如按 ID 查聚合），列表则异步 |
| **乐观更新（前端）** | 前端提交成功后在本地列表直接插入/更新，后台再校正 |
| **带版本等待** | 命令返回 `version`，查询带 `minVersion`，读模型版本不足则短暂等待或回源 |
| **读自己的写** | 把当前用户最近写过的资源标记，短时间内读请求路由到写库/强一致源 |
| **明确告知** | 产品上接受“处理中”状态与短暂延迟 |
| **监控投影延迟** | 事件时间 vs 投影完成时间的 lag 作为 SLI（见 [指标监控](#/infra/obs-metrics)） |

投影器必须**幂等 + 容忍乱序**，并支持**重建**（清空读模型，从事件/快照重新投影）——这是 CQRS 的重要运维能力。

## 四、事件溯源（Event Sourcing）

### 1. 思想

传统：账户表存 `balance=700`，历史被覆盖。事件溯源：**存发生过的所有事件**，余额是计算出来的。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="事件溯源：账户的状态由按序重放事件得到：开户、存入 1000、取出 300，得到余额 700；写入时通过追加事件并用聚合版本做乐观并发；读取时加载快照再重放其后的事件；投影器订阅事件构建读模型">
<text class="th" x="20" y="26">事件流（追加写，不可变）：Account-A1</text>
<rect class="b2" x="20" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="90" y="60" text-anchor="middle" dominant-baseline="middle">v1 AccountOpened</text>
<text class="ts" x="90" y="80" text-anchor="middle">owner=Tom</text>
<rect class="b2" x="180" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="250" y="60" text-anchor="middle" dominant-baseline="middle">v2 Deposited</text>
<text class="ts" x="250" y="80" text-anchor="middle">+1000</text>
<rect class="b2" x="340" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="410" y="60" text-anchor="middle" dominant-baseline="middle">v3 Withdrawn</text>
<text class="ts" x="410" y="80" text-anchor="middle">−300</text>
<rect class="b5" x="500" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="570" y="60" text-anchor="middle" dominant-baseline="middle">v4 …</text>
<text class="ts" x="570" y="80" text-anchor="middle">新事件追加</text>
<line class="l" x1="160" y1="68" x2="180" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="68" x2="340" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="68" x2="500" y2="68" marker-end="url(#arr)"/>
<rect class="b3" x="20" y="130" width="360" height="80" rx="10"/>
<text class="th" x="36" y="154">读取聚合 = 重放</text>
<text class="ts" x="36" y="176">state = fold(apply, 初始状态, 事件流)</text>
<text class="ts" x="36" y="196">balance = 0 + 1000 − 300 = 700</text>
<rect class="b1" x="420" y="130" width="360" height="80" rx="10"/>
<text class="th" x="436" y="154">写入 = 追加</text>
<text class="ts" x="436" y="176">校验业务规则 → 产生新事件 → 追加(expectedVersion=3)</text>
<text class="ts" x="436" y="196">版本冲突 → 乐观并发失败，重试</text>
<rect class="bg" x="20" y="230" width="760" height="86" rx="10"/>
<text class="th" x="36" y="254">加速与扩展</text>
<text class="ts" x="36" y="276">• 快照 Snapshot：每 N 个事件保存一次聚合状态，读取 = 最近快照 + 其后的事件</text>
<text class="ts" x="36" y="296">• 投影：订阅事件构建读模型（余额视图、对账报表、风控特征），可随时重建</text>
</svg>
<figcaption>图 2：事件溯源：事件是事实来源，状态由重放得出</figcaption>
</figure>

### 2. Java 示例：事件溯源的聚合

```java
public class Account {
    private AccountId id; private long balanceFen; private boolean open; private long version;
    private final List<DomainEvent> uncommitted = new ArrayList<>();

    // 命令：校验规则 → 产生事件（不直接改状态）
    public void withdraw(long amountFen) {
        if (!open) throw new DomainException("账户未开通");
        if (amountFen > balanceFen) throw new DomainException("余额不足");
        raise(new Withdrawn(id, amountFen));
    }
    private void raise(DomainEvent e) { apply(e); uncommitted.add(e); }

    // 事件应用：只改状态，不做校验，必须是纯函数（重放时反复执行）
    private void apply(DomainEvent e) {
        switch (e) {
            case AccountOpened o -> { id = o.id(); open = true; }
            case Deposited d     -> balanceFen += d.amountFen();
            case Withdrawn w     -> balanceFen -= w.amountFen();
            default -> throw new IllegalStateException();
        }
        version++;
    }
    public static Account rehydrate(List<DomainEvent> history) {             // 重放
        Account a = new Account(); history.forEach(a::apply); return a;
    }
}
```

```sql
-- 事件存储：追加写，(stream_id, version) 唯一索引实现乐观并发
CREATE TABLE event_store (
  stream_id   VARCHAR(64) NOT NULL,        -- 聚合标识
  version     BIGINT NOT NULL,             -- 聚合内序号
  event_type  VARCHAR(64) NOT NULL,
  schema_ver  INT NOT NULL,
  payload     JSON NOT NULL,
  metadata    JSON,                         -- 操作人、traceId、因果ID
  created_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (stream_id, version)         -- 并发写同一版本会冲突 → 乐观锁
);
```

保存：`INSERT` 新事件，`version = 已加载版本 + 1`；主键冲突说明期间有并发修改，重新加载重试。**同一事务**里把事件也写入 Outbox（或让投影器直接读事件存储/CDC）以发布给下游。

### 3. 价值与适用

| 价值 | 说明 |
| --- | --- |
| **天然完整审计** | 每次状态变化都有记录：谁、何时、为何（金融、合规、账务） |
| **时间旅行** | 重放到任意时间点，**“回答过去某刻的状态是什么”** |
| **可重建读模型** | 新需求（新报表、新特征）→ 从头重放事件生成新视图 |
| **调试与排障** | 复现 bug：重放导致问题的事件序列 |
| **与事件驱动天然契合** | 事件既是存储又是集成 |

适合：**账务/账户流水、订单状态流转、库存变动、协同编辑、审计要求高、需要“为什么变成这样”的领域**。账本本来就是事件溯源（复式记账只追加，见 [订单、支付与对账系统设计](#/design/case-payment)）。

### 4. 事件溯源的难点

| 难点 | 对策 |
| --- | --- |
| **事件结构演进** | 事件永久保存，旧事件**不能改**。用**上转换（Upcasting）**在读取时把旧版本事件转成新版本；新增可选字段保持兼容；必要时“复制-转换”迁移事件流；事件类型尽量设计得稳定 |
| **重放性能** | 快照（每 N 个事件）、聚合保持小（事件流不要无限长）、读走读模型而不是重放 |
| **查询困难** | 事件存储不适合按属性查询 → **必须配合读模型**（CQRS） |
| **最终一致与复杂度** | 团队学习成本、调试成本高；需要好的工具与可观测性 |
| **事件应用必须无副作用** | `apply` 是纯函数；外部调用（发邮件、调第三方）只能在**命令处理或订阅者**里，**重放时绝不能再次执行** |
| **删除/隐私（GDPR、个人信息保护）** | 事件不可变与“被遗忘权”冲突 → **加密个人数据并为每个主体单独管密钥，删除密钥即“加密擦除”**（Crypto-shredding，见 [加密与密钥管理](#/security/crypto)）；或把个人信息放在事件外只存引用 |
| **事件粒度** | 事件要表达业务意图（`AddressChanged` 优于 `UserUpdated`）；避免“CRUD 事件” |
| **并发冲突** | 乐观并发 + 重试；热点聚合需拆分 |

### 5. 工具与选型

- 专用事件库/存储：**EventStoreDB**、**Axon Framework（Java，含 Axon Server）**；
- 通用存储自建：MySQL/PostgreSQL 表（如上）、Kafka（作为事件日志与分发，但**做聚合的事实来源要谨慎**：按聚合读取与乐观并发不是它的强项）；
- 最现实的路径：**不全面采用事件溯源，只在少数适合的聚合（账务、审计关键）使用**，其他仍用普通状态存储 + 领域事件发布。

## 五、与其他模式的关系

| | 状态存储 + 领域事件 + Outbox | 事件溯源 | CQRS |
| --- | --- | --- | --- |
| 事实来源 | 当前状态表 | **事件流** | —（读写模型分离） |
| 事件作用 | 通知下游（派生物） | **就是数据本身** | 用于投影读模型 |
| 复杂度 | 低~中 | **高** | 低（层次 1）~高（层次 3） |
| 审计 | 需额外记录 | 天然 | — |

**决策建议**：

1. 先把聚合、领域事件、Outbox 做好（[事件驱动架构](#/design/event-driven)）；
2. 查询压力/复杂度上来 → CQRS 层次 1，再按需升到层次 2；
3. 确有“完整历史/审计/时间旅行”硬需求的**特定聚合**才考虑事件溯源。

## 六、一个例子：商品库存

- **命令侧**：库存聚合 `StockItem`，不变量“可用量 ≥ 0”，命令 `Reserve/Release/Adjust`；
- **事件**：`StockReserved`、`StockReleased`、`StockAdjusted`（带原因、操作人、关联订单）；
- **读模型**：①商品详情页的“是否有货”（Redis，容忍秒级延迟）；②运营后台库存流水查询（ES）；③库存日报表（ClickHouse）；
- **价值**：当库存对不上时，可沿事件流精确定位是哪次操作引起；对账（见 [订单、支付与对账系统设计](#/design/case-payment)）、审计和复盘都有据可查。

## 七、常见坑

| 坑 | 对策 |
| --- | --- |
| 为 CRUD 系统强上 CQRS/ES | 过度设计；从层次 1 开始，有收益再升级 |
| 读模型更新非幂等，重复事件导致数据错乱 | upsert + 版本比较 |
| 用户“刷新看不到刚提交的数据” | 写后读策略（见上） |
| 事件里放“状态快照字段”随意堆叠 | 事件表达业务意图，保持小而稳定 |
| 修改历史事件 | 禁止；用补偿事件与上转换 |
| 重放时重复触发外部副作用 | apply 纯函数；副作用只在命令/订阅侧并幂等 |
| 无限增长的事件流 | 快照 + 聚合边界设计；按生命周期开新流（如按月账期） |
| 读模型无法重建 | 保留事件/快照；设计重建流程与演练 |
| 忽略投影延迟监控 | 以 lag 为 SLI 告警 |

## 面试追问

> [!QUESTION] CQRS 是什么？为什么要用？
> 把命令和查询分成两套模型：写侧用聚合守护业务规则和一致性，读侧用为查询定制的读模型提高性能和灵活性。因为读写诉求冲突，为了复杂查询扭曲聚合会破坏领域模型；分离后各自优化，读可以独立扩展，用 ES、Redis 等适合的存储。

> [!QUESTION] CQRS 一定要读写分库、用消息队列吗？
> 不一定，它是一个光谱。最小形态是同一数据库里命令走聚合、查询走独立的查询服务直接 SQL 投影，没有同步问题；读写规模严重不对称或需要搜索引擎等不同存储时，才升级到写库发事件、异步投影到读库，代价是最终一致。

> [!QUESTION] 读模型是异步更新的，用户刚提交就看不到怎么办？
> 可用写后读走写库或强一致源、前端乐观更新、命令返回版本号让查询带最低版本等待或回源、产品上提示处理中，并监控投影延迟。投影器要幂等且能容忍乱序，并支持重建。

> [!QUESTION] 什么是事件溯源？优缺点？
> 不存当前状态而存所有导致状态变化的事件，状态由按序重放得到。优点是完整审计、可时间旅行、可重建读模型、便于排障；缺点是复杂度高、事件结构演进难、查询必须依赖读模型、重放有成本、个人信息删除与不可变冲突。适合账务、审计要求高的特定领域。

> [!QUESTION] 事件溯源中事件结构变了怎么办？
> 历史事件不可修改，通过上转换在读取时把旧版本事件转换成新版本，新增可选字段保持兼容，必要时复制转换迁移事件流，并在事件中记录 schema 版本。事件设计成表达业务意图并保持稳定可以减少变更。

> [!QUESTION] 事件溯源如何处理并发和重放性能？
> 并发用乐观锁：追加事件时带期望版本，stream 与 version 的唯一约束冲突则重新加载重试。性能用快照，读取时加载最近快照再重放之后的事件，并保持聚合事件流不过长，查询走读模型而不是重放。

> [!QUESTION] 什么时候该用事件溯源？
> 有完整历史、强审计、时间旅行或需要从事件重建多种读模型的硬需求的特定聚合，如账务、库存流水。多数业务用状态存储加领域事件和 Outbox 就够，不应把事件溯源作为默认架构。
