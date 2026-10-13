---
level: 高级
tags: [DDD, 领域驱动, 限界上下文, 通用语言, 上下文映射, 事件风暴, 微服务拆分, 防腐层]
summary: DDD 战略设计：为什么需要 DDD、通用语言、子域划分（核心/支撑/通用）、限界上下文与微服务边界、上下文映射的集成模式（共享内核、客户-供应商、防腐层、开放主机）、事件风暴工作坊，以及何时不该用 DDD。
---

# DDD 战略设计：限界上下文与上下文映射

> [!ABSTRACT] 核心要点
> - DDD（领域驱动设计）解决的不是“代码怎么写”，而是**复杂业务如何被拆分、建模并与代码保持一致**。**战略设计**决定边界（做什么、拆多大），**战术设计**决定边界内的模型（见 [DDD 战术设计](#/design/ddd-tactical)）。
> - **通用语言（Ubiquitous Language）**：业务与研发使用同一套术语，并**直接体现在代码、文档与对话中**。同一个词在不同上下文可以含义不同（“商品”在目录与库存里不是一回事）——这正是需要**限界上下文**的原因。
> - **限界上下文（Bounded Context）**：一个模型适用的显式边界，边界内术语无歧义。**它是微服务边界的最佳候选**，而不是按“表”或“技术层”拆。
> - 子域分**核心域**（竞争力所在，投入最好的人和最多设计）、**支撑域**、**通用域**（买/用现成）。
> - 上下文之间用**上下文映射**描述关系；与老系统或外部系统集成用**防腐层（ACL）**，避免别人的模型污染自己。
> - DDD 有成本：**简单 CRUD 不要用**，复杂业务规则、多团队协作的系统才值得。

## 一、为什么需要 DDD

典型症状：

| 症状 | 原因 |
| --- | --- |
| 一个 `OrderService` 几千行，所有逻辑都在里面（**贫血模型**） | 实体只有 getter/setter，规则散落在各 Service，改一处牵动全局 |
| 业务说“下单”，代码里是 `insertOrderTx` | 模型与业务语言脱节，沟通靠翻译，翻译就会失真 |
| 微服务拆完调用关系像蜘蛛网，一个需求改五个服务 | 按技术或表拆，边界没对准业务变化的方向 |
| 所有系统共用一个“用户”大表/大对象 | 不同场景的“用户”关注点完全不同，却被强行合并 |

DDD 的核心主张：**以业务领域为中心建模，让软件结构映射业务结构**，使变化被局限在一个边界内。

## 二、通用语言与模型

- **通用语言**来自业务专家与开发的共同讨论，而不是开发单方面命名。统一术语表要沉淀并随认知演进；
- 术语直接进入**类名、方法名、事件名**：`Order.place()`、`Shipment.dispatch()`、`PaymentCaptured`，而不是 `OrderManager.process()`；
- 业务说不通的地方，往往就是模型错的地方——**用语言驱动模型重构**。

> [!NOTE] 同词不同义
> “客户”在销售上下文是“潜在成交对象（有跟进阶段）”，在客服上下文是“有工单历史的人”，在计费上下文是“有账户和账单的主体”。强行建一个全公司统一的 `Customer`，只会得到一个谁都不满意、字段越来越多的“上帝对象”。

## 三、子域：先分重点，再分边界

**问题空间**（业务本身）划分为子域；**解决方案空间**划分为限界上下文。

| 子域类型 | 特征 | 策略 | 例（电商） |
| --- | --- | --- | --- |
| **核心域** | 业务差异化、竞争力来源，变化频繁、规则复杂 | **自研、投入最优秀的人、精细建模** | 定价与促销、交易履约 |
| **支撑域** | 必需但不构成竞争力，业务相对定制 | 可简单实现，或外包/低代码 | 商品运营后台、内容管理 |
| **通用域** | 行业通用问题，已有成熟方案 | **购买/开源，不要自研** | 认证授权（见 [认证授权](#/security/auth)）、支付渠道、短信邮件、搜索 |

意义：**把有限的建模精力集中在核心域**。很多团队把大量精力花在通用域（自己写权限、自己写工作流）上，核心域反而是一堆贫血代码。

## 四、限界上下文

### 1. 定义

限界上下文是**模型的适用边界**：边界内，通用语言一致、模型自洽；跨边界，则需要**显式的翻译与集成**。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="电商的限界上下文示例：订单上下文、库存上下文、支付上下文、商品目录上下文、营销上下文、物流上下文；同一个商品概念在不同上下文中字段不同，通过事件和接口集成">
<rect class="b3" x="20" y="30" width="230" height="130" rx="14"/>
<text class="th" x="36" y="56">商品目录上下文</text>
<text class="ts" x="36" y="80">商品 Product：标题、详情、</text>
<text class="ts" x="36" y="98">类目、属性、图片、SPU/SKU</text>
<text class="ts" x="36" y="122">关注：展示与搜索</text>
<rect class="b2" x="290" y="30" width="230" height="130" rx="14"/>
<text class="th" x="306" y="56">订单上下文（核心域）</text>
<text class="ts" x="306" y="80">订单项 OrderLine：skuId、</text>
<text class="ts" x="306" y="98">下单时价格快照、数量</text>
<text class="ts" x="306" y="122">关注：交易规则与状态</text>
<rect class="b5" x="560" y="30" width="220" height="130" rx="14"/>
<text class="th" x="576" y="56">库存上下文</text>
<text class="ts" x="576" y="80">库存项 StockItem：skuId、</text>
<text class="ts" x="576" y="98">可用量、锁定量、仓库</text>
<text class="ts" x="576" y="122">关注：扣减一致性</text>
<rect class="b1" x="20" y="190" width="230" height="110" rx="14"/>
<text class="th" x="36" y="216">营销上下文（核心域）</text>
<text class="ts" x="36" y="240">促销规则、优惠券、满减</text>
<text class="ts" x="36" y="262">关注：价格计算与叠加规则</text>
<rect class="b4" x="290" y="190" width="230" height="110" rx="14"/>
<text class="th" x="306" y="216">支付上下文</text>
<text class="ts" x="306" y="240">支付单、渠道、流水</text>
<text class="ts" x="306" y="262">关注：资金正确与对账</text>
<rect class="b" x="560" y="190" width="220" height="110" rx="14"/>
<text class="th" x="576" y="216">履约/物流上下文</text>
<text class="ts" x="576" y="240">发货单、运单、轨迹</text>
<text class="ts" x="576" y="262">关注：仓配协同</text>
<line class="l" x1="250" y1="95" x2="290" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="95" x2="560" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="405" y1="160" x2="405" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="245" x2="560" y2="245" marker-end="url(#arr)"/>
<line class="l" x1="135" y1="190" x2="135" y2="160" marker-end="url(#arr)"/>
<text class="ts" x="400" y="320" text-anchor="middle">同一个“商品”在各上下文中只保留自己关心的字段；跨上下文只传 ID 与必要快照，通过事件/接口集成</text>
</svg>
<figcaption>图 1：电商领域的限界上下文划分示例</figcaption>
</figure>

### 2. 如何划分

没有公式，但有可靠的判断线索：

| 线索 | 说明 |
| --- | --- |
| **语言变化** | 同一词语含义开始不同的地方就是边界 |
| **业务能力 / 流程** | 一个相对独立的业务能力（定价、履约、结算）构成一个上下文 |
| **变化原因与速度** | 变化原因不同、变更节奏不同的东西应分开（单一职责的放大版） |
| **团队与组织** | 康威定律：系统结构会映射组织沟通结构；一个上下文最好由**一个团队**全权负责 |
| **一致性要求** | 需要**强一致、同事务**的概念应在同一个边界内（聚合/上下文）；允许最终一致的可以分开 |
| **数据所有权** | 每份数据只有一个上下文是“权威来源”，其余只保存引用或快照 |

### 3. 限界上下文与微服务

- **上下文 ≈ 微服务的边界候选**，但**不必一一对应**：早期可以一个上下文先放在一个模块化单体里，**模块边界清晰后再按需拆服务**（见 [Spring Cloud 微服务全景](#/spring/cloud)）；
- 一个服务内可以有多个上下文？通常**反对**——边界会被侵蚀；
- 拆分的先后：**先逻辑边界（包/模块、独立 Schema），再物理边界（独立部署、独立数据库）**。过早拆分带来分布式事务、网络调用与运维的成本（见 [分布式事务](#/distributed/transaction)）。

**反模式**：按技术层拆（用户服务、DAO 服务）、按表拆、“一个实体一个服务”、共享数据库让多个服务直接读写同一张表（等于没有边界）。

## 五、上下文映射：上下文之间的关系

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="上下文映射关系：上游发布开放主机服务和发布语言，下游通过防腐层翻译模型；共享内核表示两个上下文共同拥有一小块模型；客户供应商表示下游需求影响上游计划；遵奉者表示下游直接接受上游模型；各自独立表示无集成">
<rect class="b3" x="30" y="40" width="150" height="56" rx="10"/>
<text class="tb" x="105" y="68" text-anchor="middle" dominant-baseline="middle">上游 Upstream</text>
<rect class="b1" x="360" y="40" width="150" height="56" rx="10"/>
<text class="tb" x="435" y="68" text-anchor="middle" dominant-baseline="middle">防腐层 ACL</text>
<rect class="b2" x="640" y="40" width="130" height="56" rx="10"/>
<text class="tb" x="705" y="68" text-anchor="middle" dominant-baseline="middle">下游 Downstream</text>
<line class="l" x1="180" y1="68" x2="360" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="270" y="60" text-anchor="middle">上游模型 / 接口</text>
<line class="l" x1="510" y1="68" x2="640" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="575" y="60" text-anchor="middle">翻译成自己的模型</text>
<rect class="bg" x="20" y="130" width="760" height="190" rx="12"/>
<text class="th" x="36" y="154">常见集成模式</text>
<text class="ts" x="36" y="180"><tspan class="tb">开放主机服务 OHS + 发布语言 PL</tspan>：上游提供稳定、文档化的公共接口与统一协议（REST/gRPC/事件 Schema），服务多个下游</text>
<text class="ts" x="36" y="204"><tspan class="tb">防腐层 ACL</tspan>：下游用适配层把上游/老系统模型翻译成自己的模型，隔离变化与“脏概念”</text>
<text class="ts" x="36" y="228"><tspan class="tb">客户-供应商</tspan>：上下游团队协商，下游需求纳入上游计划，有明确的交付契约与评审</text>
<text class="ts" x="36" y="252"><tspan class="tb">遵奉者 Conformist</tspan>：下游无话语权，被迫直接采用上游模型（如对接大型第三方平台）</text>
<text class="ts" x="36" y="276"><tspan class="tb">共享内核 Shared Kernel</tspan>：两个上下文共同维护一小块模型/代码，耦合紧，需严格协调，慎用</text>
<text class="ts" x="36" y="300"><tspan class="tb">各行其道 Separate Ways</tspan>：无需集成，各自实现；<tspan class="tb">合作伙伴 Partnership</tspan>：两团队共同成败，联合规划</text>
</svg>
<figcaption>图 2：上下文映射的主要关系模式</figcaption>
</figure>

### 防腐层（ACL）：最实用的一个模式

对接老系统、第三方、被迫采用的外部模型时：

```java
// 订单上下文自己的“库存能力”抽象（领域层定义的接口，使用自己的语言）
public interface StockReservation {
    ReservationResult reserve(OrderId orderId, List<SkuQuantity> items);
}

// 基础设施层的防腐层实现：把库存系统（外部模型/协议）翻译成上面的接口
@Component
class StockServiceAdapter implements StockReservation {
    private final StockClient client;                                    // 外部 Feign/RPC 客户端
    public ReservationResult reserve(OrderId id, List<SkuQuantity> items) {
        var req = new LockStockReq(id.value(), items.stream()
                .map(i -> new LockItem(i.sku().code(), i.qty())).toList());   // 我方模型 → 外部模型
        var resp = client.lock(req);
        return resp.getCode() == 0                                           // 外部错误码 → 我方领域结果
                ? ReservationResult.success()
                : ReservationResult.failed(mapReason(resp.getCode()));
    }
}
```

价值：外部接口字段/错误码/协议变化时，只改适配层；领域模型保持干净。**事件订阅同理**：消费上游事件后先翻译成本地命令/事件再进入领域。

## 六、事件风暴（Event Storming）：发现边界的工作坊

把业务专家与研发拉到一面墙前，用便利贴快速建模：

<figure class="fig">
<svg viewBox="0 0 800 250" class="dg" role="img" aria-label="事件风暴流程：先按时间顺序写出领域事件橙色便利贴，再补充触发事件的命令蓝色，执行命令的角色，产生事件的聚合黄色，策略与外部系统，最后用事件流的聚类圈出限界上下文">
<rect class="b4" x="20" y="30" width="130" height="44" rx="6"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">领域事件</text>
<rect class="b1" x="180" y="30" width="130" height="44" rx="6"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">命令</text>
<rect class="b5" x="340" y="30" width="130" height="44" rx="6"/>
<text class="tb" x="405" y="52" text-anchor="middle" dominant-baseline="middle">聚合</text>
<rect class="b3" x="500" y="30" width="130" height="44" rx="6"/>
<text class="tb" x="565" y="52" text-anchor="middle" dominant-baseline="middle">策略 / 外部系统</text>
<rect class="b2" x="660" y="30" width="120" height="44" rx="6"/>
<text class="tb" x="720" y="52" text-anchor="middle" dominant-baseline="middle">限界上下文</text>
<line class="l" x1="150" y1="52" x2="180" y2="52" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="52" x2="340" y2="52" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="52" x2="500" y2="52" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="52" x2="660" y2="52" marker-end="url(#arr)"/>
<text class="ts" x="85" y="94" text-anchor="middle">“订单已创建”</text>
<text class="ts" x="245" y="94" text-anchor="middle">“提交订单”</text>
<text class="ts" x="405" y="94" text-anchor="middle">Order</text>
<text class="ts" x="565" y="94" text-anchor="middle">“支付成功则发货”</text>
<text class="ts" x="720" y="94" text-anchor="middle">按事件聚类</text>
<rect class="bg" x="20" y="120" width="760" height="110" rx="10"/>
<text class="th" x="36" y="144">步骤</text>
<text class="ts" x="36" y="166">① 按时间顺序贴出“过去式”的领域事件（OrderPlaced、PaymentCaptured…），暴露流程与分歧</text>
<text class="ts" x="36" y="186">② 补充触发它们的命令、执行者、读模型；找出“谁来保证这条规则”→ 候选聚合</text>
<text class="ts" x="36" y="206">③ 观察语言变化与事件聚集处，圈出限界上下文；标记热点（争议/风险）与外部系统，指导后续拆分</text>
</svg>
<figcaption>图 3：事件风暴：从事件出发发现聚合与限界上下文</figcaption>
</figure>

事件风暴的价值：**让业务与技术在同一张图上达成共识**；并自然得到领域事件清单——正是后面[事件驱动架构](#/design/event-driven)的输入。

## 七、落地路径与代码结构

### 1. 渐进式落地

1. **统一语言**：整理术语表，评审时用业务语言；
2. **事件风暴 → 子域/上下文划分**，识别核心域；
3. 先在**模块化单体**内按上下文建立模块边界（包 + 编译依赖约束，如 Maven 多模块、ArchUnit 校验）；
4. 核心域用战术模式精细建模；通用域直接用现成方案；
5. 当团队、规模或部署需求需要时，再把上下文拆成独立服务，用事件和 API 集成。

### 2. 四层架构（以及依赖方向）

```text
interfaces   接口层     Controller / MQ 监听 / 定时任务（适配外部输入）
application  应用层     用例编排、事务边界、权限；很薄，不含业务规则
domain       领域层     实体、值对象、聚合、领域服务、领域事件、仓储接口（纯业务，不依赖框架）
infrastructure 基础设施  仓储实现（MyBatis/JPA）、MQ、外部适配（ACL）、缓存
依赖方向：interfaces → application → domain ← infrastructure   （依赖倒置：领域层定义接口，基础设施实现）
```

模块结构示例：`order-context/{interfaces, application, domain, infrastructure}`；用 **ArchUnit** 写测试断言“domain 不得依赖 infrastructure / Spring”。更多战术细节见 [DDD 战术设计](#/design/ddd-tactical)。

## 八、DDD 的代价与适用边界

| 适合 | 不适合 |
| --- | --- |
| 业务规则复杂、长期演进、多团队协作 | 简单 CRUD、后台管理、数据搬运 |
| 核心域有竞争力的复杂逻辑（定价、风控、交易） | 通用域、一次性项目、原型验证 |
| 团队愿意与业务深度沟通 | 业务专家无法参与 |

常见失败模式：

- **只学战术、不做战略**：到处是“聚合”“仓储”的名字，边界却是错的；
- **过度设计**：对每个表都建聚合、值对象、工厂，代码量翻倍而收益为零；
- **一上来拆微服务**：边界没想清楚就物理拆分，成了分布式大泥球；
- **共享库当共享内核**：公共 `common-model` 模块变成所有人都改的瓶颈；
- **没有业务参与**：研发闭门建模，得到的是技术视角的“伪领域模型”。

## 相关阅读

- [微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍](#/spring/cloud-evolution)：微服务反模式与治理成熟度

## 面试追问

> [!QUESTION] DDD 战略设计和战术设计分别解决什么问题？
> 战略设计解决边界问题：用通用语言、子域划分、限界上下文和上下文映射决定系统拆成哪些部分以及它们如何协作；战术设计解决边界内的建模问题：用实体、值对象、聚合、领域服务、仓储和领域事件把业务规则放进领域模型。战略对了，战术才有意义。

> [!QUESTION] 什么是限界上下文？它和微服务是什么关系？
> 限界上下文是一个模型适用的显式边界，边界内术语无歧义，跨边界需要翻译。它是微服务边界的最佳候选，但不必一一对应，可先在模块化单体中保持清晰的逻辑边界，需要时再拆为独立服务；按表或技术层拆服务是典型反模式。

> [!QUESTION] 如何划分限界上下文？
> 看语言变化处、独立的业务能力、变化原因与节奏、团队归属、一致性要求和数据所有权。需要强一致的概念放同一边界，允许最终一致的可以拆开，一个上下文最好由一个团队负责，并用事件风暴辅助发现边界。

> [!QUESTION] 防腐层是什么？什么时候用？
> 防腐层是在自己的领域模型与外部或遗留系统之间的翻译适配层，领域层定义自己需要的接口，基础设施层实现并转换外部模型和错误码。对接老系统、第三方平台或模型差异大的上游时用，避免外部变化和概念污染核心模型。

> [!QUESTION] 核心域、支撑域、通用域怎么区别对待？
> 核心域是竞争力所在，应自研并投入最好的人精细建模；支撑域必需但不构成差异，可简单实现；通用域有成熟方案，应购买或使用开源，如认证、支付渠道、短信。资源应优先集中在核心域。

> [!QUESTION] 什么情况下不应该使用 DDD？
> 简单 CRUD、后台管理、数据搬运和原型项目不值得，因为 DDD 需要与业务深入建模并带来额外代码和学习成本。常见失败是只学战术不做战略、过度设计和过早拆分微服务。
