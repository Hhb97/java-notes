---
level: 深入
tags: [分层架构, 六边形架构, 整洁架构, 端口与适配器, 依赖倒置, 模块化单体, ArchUnit, 绞杀者模式, 防腐层, 遗留系统演进, Spring Modulith]
summary: 应用内部架构的组织方法：分层架构的问题与依赖方向、六边形架构（端口与适配器）、整洁架构的依赖规则、Java 工程的包与模块结构（按层/按业务/混合）、模块化单体与微服务的关系、用 ArchUnit 守护架构、遗留系统的绞杀者演进与防腐层、反模式与取舍。
---

# 分层、六边形与整洁架构：应用内部的边界

> [!ABSTRACT] 核心要点
> - 微服务拆分解决的是**服务之间的边界**；这页讲**一个服务/应用内部如何组织代码**，使其**可理解、可测试、可演进**。目标不是“好看”，而是让**业务规则不依赖框架、数据库、Web、消息中间件这些易变细节**，让变化的代价局限在边缘。
> - **经典分层（Controller → Service → DAO）** 的常见问题：**依赖方向从上到下，业务逻辑最终依赖数据库**；Service 变成“事务脚本”，领域逻辑散落，贫血模型；换存储/换框架牵一发动全身；单元测试要起 Spring 与数据库。
> - **六边形架构（端口与适配器）/整洁架构** 的核心一句话：**依赖只能指向内层（业务）**。业务核心定义**端口（接口）**，外部技术（Web、数据库、MQ、第三方）作为**适配器**去实现/调用端口，业务核心**不知道**自己在被 HTTP 调用还是 MQ 触发、数据存在 MySQL 还是内存里——这就是**依赖倒置原则（DIP）**。
> - 落地的关键不是目录名，而是**可检查的依赖规则**：用**包/模块结构 + ArchUnit 等架构测试**把规则变成**会失败的构建检查**，防止架构腐化。
> - **按业务（垂直切片）划分模块，再在模块内部做分层**，通常优于“全局按技术层划分”；**模块化单体**是微服务的前置形态——**模块边界清晰了，拆服务只是部署问题**。
> - 对**遗留系统**，用**绞杀者（Strangler Fig）**逐步替换，**防腐层（ACL）**隔离新旧模型，**并行运行/影子比对**降低风险，而不是“推倒重写”。
> - **别过度设计**：简单 CRUD 用不着六边形全套；**架构的复杂度要与业务的复杂度匹配**。

## 经典分层及其问题

### 三层与四层

| 层 | 职责 |
| --- | --- |
| **表现层（Controller）** | 接收请求、参数校验、转换、返回响应 |
| **业务层（Service）** | 业务逻辑、事务 |
| **数据访问层（DAO/Mapper）** | 持久化 |
| （DDD 的四层）**应用层/领域层/基础设施层/用户接口层** | 应用层编排用例，**领域层承载业务规则**，基础设施提供技术实现，见 [DDD 战术设计](#/design/ddd-tactical) |

### 常见问题

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="经典分层的依赖方向与问题：表现层依赖业务层，业务层依赖数据访问层，数据访问层依赖数据库；业务逻辑实际依赖持久化细节；Service 层充当事务脚本，领域对象只有 getter 和 setter 的贫血模型；业务测试必须启动数据库或大量 Mock；更换存储技术波及业务层">
<rect class="b3" x="20" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="90" y="55" text-anchor="middle" dominant-baseline="middle">Controller</text>
<rect class="b5" x="190" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="260" y="55" text-anchor="middle" dominant-baseline="middle">Service</text>
<rect class="b1" x="360" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="430" y="55" text-anchor="middle" dominant-baseline="middle">DAO / Mapper</text>
<rect class="b4" x="530" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="600" y="55" text-anchor="middle" dominant-baseline="middle">数据库</text>
<line class="l" x1="160" y1="55" x2="190" y2="55" marker-end="url(#arr)"/>
<line class="l" x1="330" y1="55" x2="360" y2="55" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="55" x2="530" y2="55" marker-end="url(#arr)"/>
<text class="ta" x="345" y="22" text-anchor="middle">依赖方向：上层依赖下层，业务最终依赖持久化</text>
<rect class="b4" x="20" y="104" width="350" height="186" rx="10"/>
<text class="th" x="32" y="124">典型症状</text>
<text class="ts" x="195" y="150" text-anchor="middle">Service 里全是 if/else 与 DAO 调用（事务脚本）</text>
<text class="ts" x="195" y="172" text-anchor="middle">实体只有 getter/setter（贫血模型），规则散落各处</text>
<text class="ts" x="195" y="194" text-anchor="middle">业务逻辑直接依赖 ORM 实体、SQL、框架注解</text>
<text class="ts" x="195" y="216" text-anchor="middle">测试要起容器和数据库，慢且脆</text>
<text class="ts" x="195" y="238" text-anchor="middle">换数据库/换 ORM/加缓存 → 业务层大面积改</text>
<text class="ts" x="195" y="260" text-anchor="middle">层与层之间“穿透”：Controller 直接调 DAO</text>
<rect class="b2" x="390" y="104" width="350" height="186" rx="10"/>
<text class="th" x="402" y="124">根因与方向</text>
<text class="ts" x="565" y="150" text-anchor="middle">根因：依赖方向让“稳定的业务”依赖“易变的技术”</text>
<text class="ts" x="565" y="176" text-anchor="middle">方向：依赖倒置 —— 业务定义接口（端口），</text>
<text class="ts" x="565" y="196" text-anchor="middle">技术实现去适配，依赖箭头指向业务内核</text>
<text class="ts" x="565" y="226" text-anchor="middle">效果：业务可脱离框架单元测试，</text>
<text class="ts" x="565" y="246" text-anchor="middle">技术细节可替换，变化被隔离在边缘</text>
</svg>
<figcaption>图 1：经典分层的依赖方向与常见问题</figcaption>
</figure>

并不是说分层“错”，而是**没有约束依赖方向与职责的分层容易退化为大泥球**。分层要配上明确的规则：**上层可以依赖下层，下层绝不依赖上层；领域层不依赖基础设施**。

## 六边形架构（端口与适配器）

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="六边形架构：中心是应用核心（领域模型加用例），核心边缘定义入站端口（用例接口）和出站端口（仓储、消息发布、外部服务接口）；外侧是适配器：入站适配器包括 REST 控制器、消息监听器、定时任务、命令行，调用入站端口；出站适配器包括数据库实现、缓存、消息队列、第三方 API 客户端，实现出站端口；依赖方向全部指向核心">
<polygon class="bg" points="380,24 560,114 560,254 380,344 200,254 200,114"/>
<rect class="b1" x="290" y="140" width="180" height="90" rx="10"/>
<text class="tb" x="380" y="164" text-anchor="middle" dominant-baseline="middle">应用核心</text>
<text class="ts" x="380" y="188" text-anchor="middle">领域模型 + 用例</text>
<text class="ts" x="380" y="208" text-anchor="middle">不依赖任何框架/技术</text>
<rect class="b5" x="222" y="170" width="52" height="30" rx="6"/>
<text class="ts" x="248" y="185" text-anchor="middle" dominant-baseline="middle">入站端口</text>
<rect class="b5" x="486" y="170" width="52" height="30" rx="6"/>
<text class="ts" x="512" y="185" text-anchor="middle" dominant-baseline="middle">出站端口</text>
<rect class="b3" x="20" y="60" width="150" height="40" rx="8"/>
<text class="ts" x="95" y="80" text-anchor="middle" dominant-baseline="middle">REST 控制器</text>
<rect class="b3" x="20" y="116" width="150" height="40" rx="8"/>
<text class="ts" x="95" y="136" text-anchor="middle" dominant-baseline="middle">MQ 消费者</text>
<rect class="b3" x="20" y="172" width="150" height="40" rx="8"/>
<text class="ts" x="95" y="192" text-anchor="middle" dominant-baseline="middle">定时任务/RPC</text>
<rect class="b3" x="20" y="228" width="150" height="40" rx="8"/>
<text class="ts" x="95" y="248" text-anchor="middle" dominant-baseline="middle">命令行/测试</text>
<text class="th" x="20" y="44">入站适配器（驱动方）</text>
<rect class="b4" x="590" y="60" width="150" height="40" rx="8"/>
<text class="ts" x="665" y="80" text-anchor="middle" dominant-baseline="middle">MySQL（JPA/MyBatis）</text>
<rect class="b4" x="590" y="116" width="150" height="40" rx="8"/>
<text class="ts" x="665" y="136" text-anchor="middle" dominant-baseline="middle">Redis 缓存</text>
<rect class="b4" x="590" y="172" width="150" height="40" rx="8"/>
<text class="ts" x="665" y="192" text-anchor="middle" dominant-baseline="middle">Kafka/RabbitMQ</text>
<rect class="b4" x="590" y="228" width="150" height="40" rx="8"/>
<text class="ts" x="665" y="248" text-anchor="middle" dominant-baseline="middle">第三方 API 客户端</text>
<text class="th" x="590" y="44">出站适配器（被驱动方）</text>
<line class="l" x1="170" y1="80" x2="222" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="136" x2="222" y2="184" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="192" x2="222" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="248" x2="222" y2="192" marker-end="url(#arr)"/>
<line class="la" x1="590" y1="80" x2="538" y2="180" marker-end="url(#arr-a)"/>
<line class="la" x1="590" y1="136" x2="538" y2="184" marker-end="url(#arr-a)"/>
<line class="la" x1="590" y1="192" x2="538" y2="188" marker-end="url(#arr-a)"/>
<line class="la" x1="590" y1="248" x2="538" y2="192" marker-end="url(#arr-a)"/>
<text class="ts" x="380" y="290" text-anchor="middle">入站：适配器调用入站端口（用例）</text>
<text class="ts" x="380" y="312" text-anchor="middle">出站：适配器“实现”核心定义的出站端口（依赖倒置）</text>
<text class="ts" x="380" y="334" text-anchor="middle">所有依赖箭头最终都指向核心</text>
</svg>
<figcaption>图 2：六边形架构：核心、端口与适配器</figcaption>
</figure>

| 概念 | 说明 |
| --- | --- |
| **应用核心** | **领域模型（实体、值对象、领域服务）+ 应用服务/用例**，只包含业务规则，**不引用** Spring、JPA、HTTP、MQ 等 |
| **入站端口（Inbound/Driving Port）** | 核心提供的**用例接口**（如 `PlaceOrderUseCase`），表达“系统能做什么” |
| **出站端口（Outbound/Driven Port）** | 核心**需要**的外部能力的接口（如 `OrderRepository`、`PaymentGateway`、`EventPublisher`），由**核心定义** |
| **入站适配器** | 把外部输入转换成对入站端口的调用（REST Controller、MQ Listener、定时任务、gRPC 服务） |
| **出站适配器** | **实现出站端口**，封装技术细节（JPA/MyBatis 仓储、Redis 缓存、Kafka 发布、第三方 SDK） |
| **依赖方向** | 适配器依赖核心；**核心不依赖适配器**（出站通过接口反转） |

收益：**核心可以用纯 Java 单元测试**（出站端口用内存/Mock 实现）；换数据库、加缓存、换消息中间件只影响适配器；同一个用例可被 HTTP、消息、定时任务**复用**。

## 整洁架构（Clean Architecture）

同心圆表达同一思想：**由内到外依次是 实体（企业业务规则）→ 用例（应用业务规则）→ 接口适配器（控制器、网关、表现层转换）→ 框架与驱动（Web、DB、UI、外部）**，**依赖规则：源码依赖只能指向内圈**。内圈对外圈**一无所知**，数据跨边界时用**简单的数据结构（DTO）**，不传递外圈的实体（如 ORM 实体、HTTP 请求对象）。

与六边形、DDD 四层本质一致：

| 说法 | 对应 |
| --- | --- |
| 六边形：核心 / 端口 / 适配器 | 整洁架构：实体+用例 / 接口 / 接口适配器+框架 |
| DDD 战术：领域层 / 应用层 / 基础设施层 / 接口层 | 内圈：领域+应用；外圈：基础设施+接口 |

三者**不必教条地区分**，抓住**依赖规则**与**业务内核隔离技术**两点即可。

## Java 工程中的落地

### 包与模块结构

**按技术层划分**（不推荐作为顶层）：

```text
com.example
├─ controller      ← 所有业务的 Controller
├─ service         ← 所有业务的 Service
├─ dao / mapper
└─ entity          ← 横向切片，业务散落在各层，改一个功能要动多个包
```

**按业务（垂直切片）划分，模块内再分层**（推荐）：

```text
com.example
├─ order                          ← 业务模块（限界上下文）
│  ├─ api                         ← 对外暴露：入站端口（用例接口）、DTO、领域事件
│  ├─ application                 ← 用例实现（应用服务），编排领域对象与出站端口
│  ├─ domain                      ← 实体、值对象、领域服务、仓储接口（出站端口）、领域事件
│  └─ infrastructure              ← 适配器：JPA/MyBatis 仓储实现、消息发布、第三方客户端
│  └─ web                         ← 入站适配器：REST Controller、MQ Listener
├─ payment                        ← 另一个业务模块，结构类似
├─ inventory
└─ shared                         ← 极少量共享内核（无业务逻辑的基础类型）
```

要点：

- **模块之间只通过 `api` 包（及领域事件）交互**，不能直接引用对方的 `domain`/`infrastructure`；
- **领域层不引用 Spring/JPA 注解**（理想）或只引用最小的、不影响测试的注解（务实的折中：允许 JPA 注解，但不让 Service 依赖 Repository 的具体实现）；
- **仓储接口放领域层，实现放基础设施层**；
- **DTO 与领域模型分离**：Controller 的请求/响应 DTO、持久化 PO、领域对象各有各的模型，用转换器（MapStruct 等）映射；小项目可以合并以减少样板，但要意识到耦合代价；
- **事务边界在应用服务**（用例）上，领域层保持无事务注解。

### 一个下单用例的结构示意

```java
// ===== domain（业务内核，无框架依赖）=====
public interface OrderRepository {                  // 出站端口，由领域层定义
    Optional<Order> findById(OrderId id);
    void save(Order order);
}
public interface PaymentGateway {                   // 出站端口
    PaymentResult pay(PaymentRequest req);
}
public class Order {                                 // 聚合根：规则在对象内部，而非 Service 里
    public void place(Inventory inv, Clock clock) {
        if (items.isEmpty()) throw new DomainException("订单不能为空");
        this.status = OrderStatus.PLACED;
        this.placedAt = clock.now();
        registerEvent(new OrderPlaced(id, totalAmount()));
    }
}

// ===== application（用例编排）=====
public interface PlaceOrderUseCase { OrderId place(PlaceOrderCommand cmd); }   // 入站端口

@Service
class PlaceOrderService implements PlaceOrderUseCase {
    private final OrderRepository orders;               // 依赖的是接口
    private final PaymentGateway payments;
    private final EventPublisher events;                 // 出站端口
    @Transactional                                       // 事务边界在应用层
    public OrderId place(PlaceOrderCommand cmd) {
        Order order = Order.create(cmd.customerId(), cmd.items());
        order.place(inventoryView, clock);
        orders.save(order);
        events.publish(order.pullEvents());              // 配合 Outbox，见事件驱动架构
        return order.id();
    }
}

// ===== infrastructure（适配器：实现出站端口）=====
@Repository
class JpaOrderRepository implements OrderRepository { /* JPA/MyBatis 细节、PO↔领域对象转换 */ }

// ===== web（入站适配器）=====
@RestController
class OrderController {
    private final PlaceOrderUseCase placeOrder;          // 依赖入站端口
    @PostMapping("/orders")
    ResponseEntity<OrderVO> create(@RequestBody @Valid PlaceOrderRequest req) {
        return ResponseEntity.ok(OrderVO.of(placeOrder.place(req.toCommand())));
    }
}
```

测试：`Order` 的规则用**纯单元测试**；`PlaceOrderService` 用**内存版 `OrderRepository`/Fake `PaymentGateway`** 测试用例编排；适配器用**集成测试**（Testcontainers）验证与真实数据库/中间件的交互；契约测试覆盖对外接口。

### 用架构测试守护依赖规则

规则不写成**会失败的测试**，一定会腐化。**ArchUnit**（Java）可以把依赖规则写成单元测试：

```java
@AnalyzeClasses(packages = "com.example")
class ArchitectureTest {

    @ArchTest  // 领域层不能依赖基础设施、Web 与 Spring
    static final ArchRule domain_is_pure = noClasses().that().resideInAPackage("..domain..")
        .should().dependOnClassesThat().resideInAnyPackage("..infrastructure..", "..web..", "org.springframework..");

    @ArchTest  // 模块之间只能通过 api 包访问
    static final ArchRule modules_only_via_api = noClasses().that().resideInAPackage("..order..")
        .should().dependOnClassesThat().resideInAnyPackage("..payment.domain..", "..payment.infrastructure..");

    @ArchTest  // 没有循环依赖
    static final ArchRule no_cycles = slices().matching("com.example.(*)..").should().beFreeOfCycles();
}
```

要点：把架构测试放进 CI；规则要**从“宽松”到“严格”逐步收紧**；对存量违规用**冻结规则（FreezingArchRule）**，只阻止新增违规；还有 **Spring Modulith**（模块边界验证、模块间事件、文档生成）等辅助工具。

## 模块化单体与微服务

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="从大泥球到模块化单体再到微服务：大泥球代码互相依赖无边界；模块化单体按业务划分模块，模块间通过 API 和事件交互，共享部署但边界清晰，由架构测试守护；当某模块需要独立伸缩、独立发布或团队独立时，将其抽成独立服务，通信从进程内调用换成网络调用；边界先清晰，再拆分，避免分布式单体">
<rect class="b4" x="20" y="30" width="210" height="130" rx="10"/>
<text class="tb" x="125" y="50" text-anchor="middle" dominant-baseline="middle">大泥球</text>
<text class="ts" x="125" y="78" text-anchor="middle">无边界，互相调用</text>
<text class="ts" x="125" y="98" text-anchor="middle">循环依赖，改一处崩多处</text>
<text class="ts" x="125" y="118" text-anchor="middle">一起发布，难测试</text>
<text class="ts" x="125" y="142" text-anchor="middle">←重构：先划清边界</text>
<rect class="b3" x="270" y="30" width="230" height="130" rx="10"/>
<text class="tb" x="385" y="50" text-anchor="middle" dominant-baseline="middle">模块化单体</text>
<text class="ts" x="385" y="78" text-anchor="middle">按业务分模块，进程内通信</text>
<text class="ts" x="385" y="98" text-anchor="middle">模块间只走 api / 事件</text>
<text class="ts" x="385" y="118" text-anchor="middle">架构测试守护，数据按模块私有</text>
<text class="ts" x="385" y="142" text-anchor="middle">部署简单，开发效率高</text>
<rect class="b2" x="540" y="30" width="200" height="130" rx="10"/>
<text class="tb" x="640" y="50" text-anchor="middle" dominant-baseline="middle">微服务（按需拆）</text>
<text class="ts" x="640" y="78" text-anchor="middle">模块→独立服务</text>
<text class="ts" x="640" y="98" text-anchor="middle">进程内调用→网络调用</text>
<text class="ts" x="640" y="118" text-anchor="middle">独立伸缩/发布/团队</text>
<text class="ts" x="640" y="142" text-anchor="middle">运维与一致性成本上升</text>
<line class="l" x1="230" y1="95" x2="270" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="95" x2="540" y2="95" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="180" width="720" height="130" rx="8"/>
<text class="th" x="32" y="200">经验与取舍</text>
<text class="ts" x="380" y="226" text-anchor="middle">边界不清就拆服务 → 得到分布式单体（同步强依赖 + 一起发布），成本最高；所以“先模块化，再按需拆分”更稳</text>
<text class="ts" x="380" y="248" text-anchor="middle">拆分信号：模块需要独立伸缩（流量差异大）、独立发布节奏、不同技术栈、团队规模导致协作瓶颈、故障隔离需求</text>
<text class="ts" x="380" y="270" text-anchor="middle">小团队/早期产品：模块化单体往往是最佳起点；微服务治理成本较高</text>
<text class="ts" x="380" y="292" text-anchor="middle">模块的数据私有：不跨模块直接查别人的表，通过 API 或事件，才能为将来拆分留余地</text>
</svg>
<figcaption>图 3：从大泥球到模块化单体再到微服务</figcaption>
</figure>

## 遗留系统的演进：绞杀者模式与防腐层

“推倒重写”风险极高（需求持续变化、旧系统隐含大量业务知识、上线即全量风险）。**渐进式替换**更稳。

### 绞杀者（Strangler Fig）

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="绞杀者模式：在遗留系统前放置路由层或代理，起初所有流量走遗留系统；逐个功能在新系统中重建，并通过路由规则把对应流量切到新系统，旧功能被逐步替代；期间可并行运行对比结果；防腐层隔离新旧模型；最终遗留系统无流量后下线">
<rect class="b3" x="20" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b5" x="160" y="40" width="130" height="60" rx="8"/>
<text class="tb" x="225" y="62" text-anchor="middle" dominant-baseline="middle">路由/代理层</text>
<text class="ts" x="225" y="82" text-anchor="middle">按功能分流</text>
<rect class="b4" x="330" y="14" width="170" height="52" rx="8"/>
<text class="tb" x="415" y="34" text-anchor="middle" dominant-baseline="middle">遗留系统</text>
<text class="ts" x="415" y="54" text-anchor="middle">功能逐步减少</text>
<rect class="b2" x="330" y="76" width="170" height="52" rx="8"/>
<text class="tb" x="415" y="96" text-anchor="middle" dominant-baseline="middle">新系统</text>
<text class="ts" x="415" y="116" text-anchor="middle">功能逐步增加</text>
<rect class="b1" x="540" y="40" width="200" height="60" rx="8"/>
<text class="tb" x="640" y="62" text-anchor="middle" dominant-baseline="middle">防腐层（ACL）</text>
<text class="ts" x="640" y="82" text-anchor="middle">新旧模型/协议转换</text>
<line class="l" x1="130" y1="70" x2="160" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="60" x2="330" y2="40" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="80" x2="330" y2="100" marker-end="url(#arr)"/>
<line class="ld" x1="500" y1="40" x2="540" y2="60"/>
<line class="ld" x1="500" y1="100" x2="540" y2="80"/>
<rect class="bg" x="20" y="146" width="720" height="164" rx="8"/>
<text class="th" x="32" y="166">步骤与手段</text>
<text class="ts" x="380" y="192" text-anchor="middle">① 加路由层（网关/代理）：起初 100% 流量走旧系统，不改行为  ② 选择边界清晰、价值高或痛点大的功能先迁移</text>
<text class="ts" x="380" y="214" text-anchor="middle">③ 新系统重建该功能，用防腐层与旧系统交互，保持新模型“干净”  ④ 并行运行/影子流量：新旧同时处理，比对结果，只用旧结果</text>
<text class="ts" x="380" y="236" text-anchor="middle">⑤ 按比例灰度切流量到新系统，观察，回退随时可行  ⑥ 数据迁移：双写/CDC 同步</text>
<text class="ts" x="380" y="258" text-anchor="middle">⑦ 旧功能无流量后下线；循环下一个功能  ⑧ 全部完成后下线遗留系统</text>
<text class="ts" x="380" y="282" text-anchor="middle">另一手段：Branch by Abstraction（在旧代码里先抽象接口，让新旧实现并存，再切换）；特征测试（Characterization Test）固化旧行为</text>
<text class="ta" x="380" y="302" text-anchor="middle">关键：每一步都是小的、可回退的、持续交付价值的，而不是一个“大爆炸”切换</text>
</svg>
<figcaption>图 4：绞杀者模式：路由层、并行运行与防腐层</figcaption>
</figure>

### 防腐层（Anti-Corruption Layer, ACL）

当新系统需要与**模型陈旧/不友好**的旧系统或外部系统交互时，在边界放一层**翻译层**：

- 把外部的**数据结构、术语、协议**转换成**本系统领域模型**，**不让外部模型渗透进核心**；
- 作为出站适配器实现（如 `LegacyCustomerGateway implements CustomerRepository`），内部调用旧接口并映射；
- 外部变化只影响 ACL；将来旧系统下线，**只需替换 ACL 的实现**；
- 与 [DDD 战略设计](#/design/ddd-strategic) 的上下文映射（ACL、开放主机服务、共享内核）相呼应。

## 其他常见的架构模式

| 模式 | 要点 | 适用 |
| --- | --- | --- |
| **BFF（Backend For Frontend）** | 为每类前端（Web/App/小程序）提供专属聚合层，裁剪/组合下游接口 | 多端差异大、减少前端多次调用 |
| **API 组合/聚合服务** | 聚合多个服务的数据返回 | 查询聚合，见 [CQRS 与事件溯源](#/design/cqrs-es) 读模型 |
| **微内核/插件化** | 稳定核心 + 可插拔扩展点（SPI） | 规则引擎、渠道适配、支付通道扩展 |
| **事件驱动模块通信** | 模块间用领域事件解耦 | 模块化单体、微服务，见 [事件驱动架构](#/design/event-driven) |
| **管道-过滤器/责任链** | 处理流程拆成可组合步骤 | 请求处理、风控规则、数据清洗 |
| **CQRS** | 读写模型分离 | 读写差异大、复杂查询，见 [CQRS 与事件溯源](#/design/cqrs-es) |
| **Sidecar / Ambassador** | 横切能力下沉到伴生进程 | 服务网格，见 [微服务体系的演进](#/spring/cloud-evolution) |
| **特性开关** | 运行时控制功能启停 | 灰度、渐进发布，见 [发布策略](#/infra/release) |

## 反模式与取舍

| 反模式 | 表现 | 改进 |
| --- | --- | --- |
| **大泥球（Big Ball of Mud）** | 无结构，随处依赖 | 先划模块边界，加架构测试，逐步重构 |
| **贫血领域模型** | 实体只有数据，逻辑全在 Service | 把规则下沉到聚合/领域服务；适用于有复杂规则的核心域 |
| **过度抽象/为分层而分层** | 简单 CRUD 也三个接口两个实现四层转换 | 复杂度与业务匹配，简单模块可用简化结构 |
| **循环依赖** | 模块/包互相引用 | 抽取接口、事件解耦、依赖倒置，ArchUnit 守护 |
| **领域层依赖框架/ORM** | 无法单元测试 | 仓储接口放领域，实现放基础设施，务实地限制注解 |
| **共享数据库/共享实体** | 模块间通过表耦合 | 数据私有，模块间用 API/事件 |
| **万能的 Util/Common 模块** | 变成新的耦合中心 | 控制共享内核范围，只放无业务的基础类型 |
| **用 DTO/实体贯穿所有层** | 外层模型渗透核心 | 边界处转换，各层有自己的模型 |
| **一开始就微服务** | 分布式单体、成本高 | 先模块化单体，按需拆分 |
| **推倒重写** | 周期长、风险大 | 绞杀者 + 防腐层 + 并行运行 |
| **架构文档与代码脱节** | 没人维护 | 架构测试 + 代码即文档（结构图自动生成）+ [ADR](#/design/eng-adr) 记录决策 |

**取舍的关键**：

- **核心域/复杂业务**：值得投入六边形/DDD，收益（可测试、可演进）大于成本；
- **支撑域/简单 CRUD**：用简化分层（Controller-Service-Repository），避免过度设计；
- **团队共识**比“完美架构”重要：规则要少而清晰、能自动检查；
- **演进式架构**：架构不是一次设计完成，而是通过**适应度函数（Fitness Function，如 ArchUnit 测试、依赖度量、性能阈值）** 持续守护。

## 检查清单

- [ ] 业务规则是否独立于框架/数据库/Web/MQ，核心能否脱离 Spring 单元测试？
- [ ] 依赖方向是否只指向内层？仓储与外部能力是否以接口形式由核心定义？
- [ ] 代码是否按业务模块划分，模块间是否只通过 api/事件交互、数据是否私有？
- [ ] 架构规则是否写成 ArchUnit/Modulith 测试并在 CI 中强制？有无循环依赖检查？
- [ ] DTO、领域对象、持久化对象是否分离，转换是否在边界完成？
- [ ] 事务边界是否在应用服务层？领域层是否无事务与技术注解？
- [ ] 与遗留/外部系统交互是否通过防腐层？演进是否采用绞杀者而非重写？
- [ ] 简单模块是否避免了过度分层？架构决策是否记录（ADR）？

## 相关阅读

- [DDD 战略设计：限界上下文与上下文映射](#/design/ddd-strategic)：模块边界与防腐层
- [DDD 战术设计：聚合、实体与领域事件](#/design/ddd-tactical)：领域模型与分层落地
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：模块间事件通信
- [微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍](#/spring/cloud-evolution)：微服务反模式与治理
- [技术方案与 ADR 写作](#/design/eng-adr)：记录架构决策
- [IoC 容器与 Bean 生命周期](#/spring/ioc)：依赖注入在端口与适配器中的作用

## 面试追问

> [!QUESTION] 经典三层架构有什么问题？六边形架构怎么解决？
> 经典分层的依赖从上到下，业务逻辑最终依赖持久化与框架，容易退化为事务脚本和贫血模型，难以单元测试，换技术波及业务。六边形架构让业务核心定义端口，外部技术作为适配器实现或调用端口，依赖全部指向核心，核心不依赖技术细节，可以脱离框架测试，技术可替换。

> [!QUESTION] 什么是依赖倒置？在 Java 项目里怎么体现？
> 高层业务不依赖低层细节，二者都依赖抽象，且抽象由高层定义。体现为仓储接口、支付网关、事件发布器等出站端口放在领域层，JPA/MyBatis、第三方客户端、Kafka 的实现放在基础设施层，通过依赖注入把实现装配进用例，使领域层不引用任何技术框架。

> [!QUESTION] 怎么保证团队长期遵守架构约束？
> 把规则写成可执行的架构测试，如 ArchUnit 约束领域层不依赖基础设施和 Spring、模块间只能通过 api 包、禁止循环依赖，放入 CI 构建失败即阻断；存量违规用冻结规则只阻止新增；配合 ADR 记录决策和代码评审。

> [!QUESTION] 模块化单体和微服务是什么关系？
> 模块化单体按业务划分模块，模块间通过 api 和事件交互、数据私有，部署在一起；当某个模块需要独立伸缩、发布或团队独立时，再把它抽成服务，进程内调用换成网络调用。边界先清晰再拆分，否则会得到分布式单体，成本更高。

> [!QUESTION] 遗留系统怎么逐步替换而不是重写？
> 用绞杀者模式：在前面加路由层，逐个功能在新系统重建并通过路由灰度切流量，期间并行运行或影子流量比对结果，用防腐层隔离新旧模型，数据用双写或 CDC 迁移，每步可回退，旧功能无流量后下线，直到整个遗留系统被替换。

> [!QUESTION] 什么时候不需要这么复杂的架构？
> 简单 CRUD、规则少、生命周期短的模块用简化分层即可，过度抽象会带来大量样板和转换成本。架构复杂度应与业务复杂度匹配，核心域值得投入六边形与 DDD，支撑域保持简单，并通过适应度函数持续检查而不是一开始过度设计。
