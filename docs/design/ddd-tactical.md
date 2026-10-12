---
level: 高级
tags: [DDD, 聚合, 实体, 值对象, 仓储, 领域服务, 领域事件, 充血模型, Spring, JPA]
summary: DDD 战术设计与 Java 落地：实体与值对象、聚合与聚合根的设计规则（小聚合、只引用 ID、聚合内强一致）、领域服务、仓储、工厂、领域事件、应用服务与事务边界，充血模型对比贫血模型，附订单聚合完整代码、与 MyBatis/JPA 的持久化映射和常见反模式。
---

# DDD 战术设计：聚合、实体与领域事件（Java 落地）

> [!ABSTRACT] 核心要点
> - **实体（Entity）**有唯一标识、有生命周期；**值对象（Value Object）**无标识、**不可变**、按值相等，用来表达“金额、地址、时间段”等概念，**能用值对象就不用实体**。
> - **聚合（Aggregate）**是**一致性边界**：一组需要**同时满足业务不变量**的对象，由**聚合根**统一对外；**外部只能引用聚合根**，一个事务只修改一个聚合。
> - 聚合设计口诀：**小聚合、只引用 ID、边界内强一致、边界外最终一致（用领域事件）**。
> - **领域逻辑写进领域对象（充血模型）**，应用服务只做编排、事务与权限；对比“Service 里堆 if-else 的贫血模型”。
> - **仓储（Repository）**按聚合存取，接口在领域层、实现在基础设施层；**领域事件**表达“已经发生的事”，用于解耦聚合与上下文（见 [事件驱动架构](#/design/event-driven)）。

> [!NOTE] 先读战略设计
> 战术模式应在已经确定的限界上下文内使用，见 [DDD 战略设计](#/design/ddd-strategic)。

## 一、构建块一览

<figure class="fig">
<svg viewBox="0 0 800 360" class="dg" role="img" aria-label="DDD 战术构建块：应用服务编排用例并管理事务，调用聚合根执行业务规则；聚合内包含聚合根实体、内部实体与值对象；领域服务处理跨聚合的领域逻辑；仓储负责聚合的持久化；聚合产生领域事件发布给其他上下文">
<rect class="b3" x="20" y="30" width="200" height="60" rx="10"/>
<text class="tb" x="120" y="54" text-anchor="middle" dominant-baseline="middle">应用服务</text>
<text class="ts" x="120" y="74" text-anchor="middle">用例编排 · 事务 · 权限</text>
<rect class="bg" x="270" y="20" width="300" height="200" rx="14"/>
<text class="th" x="286" y="44">聚合（一致性边界）</text>
<rect class="b2" x="290" y="58" width="260" height="46" rx="8"/>
<text class="tb" x="420" y="76" text-anchor="middle" dominant-baseline="middle">聚合根 Order（实体）</text>
<text class="ts" x="420" y="94" text-anchor="middle">对外唯一入口 · 守护不变量</text>
<rect class="b5" x="290" y="116" width="120" height="44" rx="8"/>
<text class="ts" x="350" y="138" text-anchor="middle" dominant-baseline="middle">OrderLine（内部实体）</text>
<rect class="b1" x="430" y="116" width="120" height="44" rx="8"/>
<text class="ts" x="490" y="138" text-anchor="middle" dominant-baseline="middle">Money / Address</text>
<text class="ts" x="420" y="190" text-anchor="middle">值对象不可变 · 外部不能直接改内部对象</text>
<line class="l" x1="220" y1="60" x2="270" y2="76" marker-end="url(#arr)"/>
<rect class="b4" x="620" y="30" width="160" height="60" rx="10"/>
<text class="tb" x="700" y="54" text-anchor="middle" dominant-baseline="middle">领域事件</text>
<text class="ts" x="700" y="74" text-anchor="middle">OrderPlaced…</text>
<line class="l" x1="570" y1="76" x2="620" y2="60" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="130" width="200" height="60" rx="10"/>
<text class="tb" x="120" y="154" text-anchor="middle" dominant-baseline="middle">仓储 Repository</text>
<text class="ts" x="120" y="174" text-anchor="middle">按聚合根存取</text>
<line class="l" x1="270" y1="160" x2="220" y2="160" marker-end="url(#arr)"/>
<rect class="b5" x="620" y="130" width="160" height="60" rx="10"/>
<text class="tb" x="700" y="154" text-anchor="middle" dominant-baseline="middle">领域服务</text>
<text class="ts" x="700" y="174" text-anchor="middle">跨聚合的领域规则</text>
<rect class="bg" x="20" y="250" width="760" height="94" rx="10"/>
<text class="th" x="36" y="274">依赖方向</text>
<text class="ts" x="36" y="296">接口层 → 应用服务 → 领域层（聚合/领域服务/仓储接口）；基础设施层实现仓储接口（依赖倒置）</text>
<text class="ts" x="36" y="316">领域层不依赖 Spring、MyBatis、JPA 注解可达成最纯粹的模型；务实做法是允许少量 JPA 注解，但不让它主导模型</text>
<text class="ts" x="36" y="334">工厂 Factory：封装复杂聚合的创建与初始不变量校验</text>
</svg>
<figcaption>图 1：战术构建块与依赖关系</figcaption>
</figure>

## 二、实体与值对象

### 1. 实体

靠**标识**区分，属性可变，**业务行为放在实体里**：

```java
public class Order {                                  // 聚合根：实体
    private final OrderId id;                         // 唯一标识（业务含义明确的类型，不用裸 Long）
    private OrderStatus status;
    private final List<OrderLine> lines = new ArrayList<>();
    private Money total = Money.zero();
    private final List<DomainEvent> events = new ArrayList<>();

    // 工厂方法：创建即满足不变量；构造器私有，防止出现“非法状态”的订单
    public static Order place(OrderId id, CustomerId customer, List<OrderLineDraft> items) {
        if (items.isEmpty()) throw new DomainException("订单至少包含一个商品");
        Order o = new Order(id, customer);
        items.forEach(o::addLine);
        o.status = OrderStatus.UNPAID;
        o.events.add(new OrderPlaced(id, o.total, Instant.now()));    // 记录领域事件
        return o;
    }
    ...
}
```

### 2. 值对象

**没有标识，不可变，按值比较，自带校验与行为**，让概念显式化并消除“基本类型偏执”：

```java
public record Money(long amountFen, String currency) {           // Java 16+ record 天然契合
    public Money {
        if (amountFen < 0) throw new IllegalArgumentException("金额不能为负");
        Objects.requireNonNull(currency);
    }
    public static Money zero() { return new Money(0, "CNY"); }
    public Money add(Money o) { requireSameCurrency(o); return new Money(amountFen + o.amountFen, currency); }
    public Money multiply(int qty) { return new Money(Math.multiplyExact(amountFen, (long) qty), currency); }
    private void requireSameCurrency(Money o) { if (!currency.equals(o.currency)) throw new IllegalArgumentException("币种不一致"); }
}
```

| | 实体 | 值对象 |
| --- | --- | --- |
| 标识 | 有（ID 决定“是谁”） | 无 |
| 可变性 | 状态可变 | **不可变**，变化 = 替换成新对象 |
| 相等性 | 按 ID | 按全部属性值 |
| 例 | 订单、用户、账户 | 金额、地址、手机号、时间段、坐标 |

好处：金额不会和数量混用、手机号带校验、“修改”变成产生新值而无副作用。落库时值对象可**拍平为多列**或存 JSON。

## 三、聚合：最重要也最难的部分

### 1. 什么是聚合

**聚合是一组被当作整体来修改的对象，对外只暴露聚合根，内部维护一组必须始终成立的业务规则（不变量）。**

例如订单：“**订单总额 = 各行金额之和**”、“**已支付的订单不能再加商品**”、“**一个订单最多 50 行**”。这些规则涉及订单与订单行，必须**在同一个事务里一致地修改**，所以它们属于同一个聚合。

### 2. 设计规则

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="聚合设计规则：聚合内通过聚合根访问，保持强一致；聚合之间只通过 ID 引用，通过领域事件实现最终一致；左侧大而全的订单聚合包含客户商品库存是错误示例，右侧小聚合按 ID 引用是正确做法">
<rect class="b4" x="20" y="30" width="360" height="190" rx="12"/>
<text class="th" x="36" y="56">✗ 大聚合（常见错误）</text>
<rect class="b" x="40" y="72" width="320" height="130" rx="10"/>
<text class="ts" x="56" y="94">Order 直接持有 Customer 对象、</text>
<text class="ts" x="56" y="112">Product 对象列表、Stock 对象、Payment 对象…</text>
<text class="ts" x="56" y="140">→ 加载一个订单拉出一大片对象图（性能差）</text>
<text class="ts" x="56" y="158">→ 并发冲突概率高（锁粒度大）</text>
<text class="ts" x="56" y="176">→ 难以拆分为独立服务/分库分表</text>
<rect class="b2" x="420" y="30" width="360" height="190" rx="12"/>
<text class="th" x="436" y="56">✓ 小聚合 + 只引用 ID</text>
<rect class="b3" x="440" y="74" width="150" height="50" rx="8"/>
<text class="ts" x="515" y="92" text-anchor="middle" dominant-baseline="middle">Order（含 OrderLine）</text>
<text class="ts" x="515" y="110" text-anchor="middle" dominant-baseline="middle">customerId · skuId</text>
<rect class="b5" x="630" y="74" width="130" height="50" rx="8"/>
<text class="ts" x="695" y="99" text-anchor="middle" dominant-baseline="middle">Customer</text>
<rect class="b5" x="440" y="150" width="150" height="50" rx="8"/>
<text class="ts" x="515" y="175" text-anchor="middle" dominant-baseline="middle">Stock</text>
<rect class="b5" x="630" y="150" width="130" height="50" rx="8"/>
<text class="ts" x="695" y="175" text-anchor="middle" dominant-baseline="middle">Payment</text>
<line class="ld" x1="590" y1="99" x2="630" y2="99"/>
<line class="ld" x1="515" y1="124" x2="515" y2="150"/>
<line class="ld" x1="590" y1="125" x2="650" y2="150"/>
<text class="ts" x="400" y="248" text-anchor="middle">聚合内：强一致，一个事务只改一个聚合　　聚合间：只引用 ID，通过领域事件最终一致</text>
<text class="ts" x="400" y="272" text-anchor="middle">问自己：“如果这两个对象不在同一个事务里改，业务会出现不可接受的不一致吗？”——不会，就拆开</text>
</svg>
<figcaption>图 2：聚合边界：小聚合、按 ID 引用</figcaption>
</figure>

| 规则 | 说明 |
| --- | --- |
| **保护真正的不变量** | 聚合边界由“必须同事务一致的规则”决定，而不是“数据库里有外键” |
| **小聚合** | 大多数聚合只有聚合根 + 少量内部对象；越大并发冲突越多、加载越慢 |
| **只通过聚合根访问内部** | 外部不能拿到 `OrderLine` 直接修改；通过 `order.changeQuantity(lineId, n)` |
| **聚合间只引用 ID** | `Order` 持有 `CustomerId`，不持有 `Customer` 对象；需要时通过仓储或查询服务获取 |
| **一个事务修改一个聚合** | 跨聚合的变更用**领域事件 + 最终一致**完成（订单创建 → 事件 → 库存扣减） |
| **用乐观锁控制并发** | 聚合根带 `version`，更新时 `WHERE version = ?`，冲突则重试 |
| **聚合是缓存/分片/迁移的天然单位** | 与分库分表键、微服务边界对齐，见 [分库分表](#/mysql/sharding) |

### 3. 聚合根的行为：把规则写进去

```java
public class Order {
    ...
    public void addLine(OrderLineDraft d) {
        requireStatus(OrderStatus.UNPAID);                              // 不变量：只有未支付才能改
        if (lines.size() >= 50) throw new DomainException("订单行数超限");
        lines.add(new OrderLine(d.skuId(), d.qty(), d.unitPrice()));
        recalcTotal();                                                   // 不变量：总额始终等于行金额之和
    }
    public void pay(PaymentId paymentId, Money paid) {
        requireStatus(OrderStatus.UNPAID);
        if (!paid.equals(total)) throw new DomainException("支付金额与订单金额不一致");
        this.status = OrderStatus.PAID;
        events.add(new OrderPaid(id, paymentId, paid));
    }
    public void cancel(String reason) {
        if (status == OrderStatus.SHIPPED) throw new DomainException("已发货订单不能取消");
        this.status = OrderStatus.CANCELLED;
        events.add(new OrderCancelled(id, reason));
    }
    public List<DomainEvent> pullEvents() { var e = List.copyOf(events); events.clear(); return e; }
    private void recalcTotal() { total = lines.stream().map(OrderLine::subtotal).reduce(Money.zero(), Money::add); }
}
```

注意：**状态转移与校验都在聚合内部**；Service 不再 `order.setStatus(PAID)`。

### 4. 充血模型 vs 贫血模型

```java
// ✗ 贫血模型：实体只是数据袋，规则散在 Service 中，重复且易遗漏
@Service class OrderService {
    void pay(Long id, BigDecimal amount) {
        Order o = repo.find(id);
        if (o.getStatus() != 0) throw ...;           // 规则 A
        if (amount.compareTo(o.getTotal()) != 0) throw ...;   // 规则 B
        o.setStatus(1);                               // 任何地方都能直接 setStatus，规则可被绕过
        repo.save(o);
    }
}
// ✓ 充血模型：规则内聚在聚合中，任何调用路径都不可能绕过
order.pay(paymentId, paid);
```

务实提醒：**简单场景贫血没问题**；当规则复杂、被多处复用、需要保证“永远合法”时，才值得充血。

## 四、领域服务与应用服务

| | 领域服务 | 应用服务 |
| --- | --- | --- |
| 位置 | 领域层 | 应用层 |
| 职责 | **不属于某个实体/值对象的领域逻辑**，常涉及**多个聚合**：运费计算、折扣计算、转账（A 账户 → B 账户） | **用例编排**：加载聚合 → 调用领域方法 → 保存 → 发布事件；管理**事务边界、权限、幂等** |
| 业务规则 | **有** | **没有**（很薄） |
| 状态 | 无状态 | 无状态 |

```java
@Service
public class OrderAppService {
    private final OrderRepository orders;
    private final PricingService pricing;               // 领域服务
    private final EventPublisher publisher;

    @Transactional                                       // 事务边界在应用层；一个事务只改一个聚合
    public OrderId place(PlaceOrderCmd cmd) {
        var drafts = pricing.priceItems(cmd.items());                // 领域服务：计价（可能调用营销上下文的防腐层）
        Order order = Order.place(orders.nextId(), cmd.customerId(), drafts);
        orders.save(order);
        publisher.publish(order.pullEvents());                       // 见下文：通过 Outbox 可靠发布
        return order.id();
    }

    @Transactional
    public void onPaid(OrderId id, PaymentId pid, Money paid) {     // 幂等：已支付则直接返回
        Order o = orders.findById(id).orElseThrow();
        o.pay(pid, paid);
        orders.save(o);
        publisher.publish(o.pullEvents());
    }
}
```

## 五、仓储与持久化

**仓储是“聚合的集合”抽象**：按聚合根存取，整个聚合一起加载/保存，接口在领域层，隐藏持久化细节。

```java
public interface OrderRepository {                       // 领域层接口：面向聚合、用领域语言
    OrderId nextId();
    Optional<Order> findById(OrderId id);
    void save(Order order);                              // 保存整个聚合（含乐观锁）
}
```

### 实现与映射（MyBatis / JPA）

| 方式 | 做法 | 提醒 |
| --- | --- | --- |
| **JPA/Hibernate** | 聚合根 `@Entity`，内部实体 `@OneToMany(cascade=ALL, orphanRemoval=true)`，值对象 `@Embeddable`；`@Version` 乐观锁 | 方便，但注解侵入领域模型；注意懒加载与 N+1；不要让别的聚合直接 `@ManyToOne` 引用 |
| **MyBatis** | **持久化对象 PO** 与领域对象分离：Repository 实现里 `PO ↔ 领域对象` 转换（MapStruct） | 模型最干净，映射代码多；复杂聚合保存要处理增删改行的差异（见 [MyBatis](#/spring/mybatis)） |

```java
@Repository
class OrderRepositoryImpl implements OrderRepository {
    public void save(Order o) {
        OrderPO po = OrderConverter.toPO(o);
        int n = orderMapper.updateWithVersion(po);       // UPDATE ... WHERE id=? AND version=?
        if (n == 0) throw new OptimisticLockException(o.id());   // 并发冲突：上层决定重试
        lineMapper.replaceAll(po.getId(), OrderConverter.toLinePOs(o));   // 简化：整体替换内部行
    }
}
```

**查询另当别论**：聚合是为**写入与不变量**设计的，**列表/报表/多表联查**不应该通过加载聚合来做——用专门的**查询服务/读模型**直接 SQL 投影到 DTO（这就是 [CQRS](#/design/cqrs-es) 的思想），避免为了查询而扭曲聚合设计。

## 六、领域事件

**领域事件表示“业务上已经发生的、有意义的事”**，用**过去式**命名：`OrderPlaced`、`OrderPaid`、`StockReserved`。

```java
public record OrderPaid(String eventId, OrderId orderId, PaymentId paymentId, Money amount, Instant occurredAt)
        implements DomainEvent {}
```

作用：

- **跨聚合/跨上下文解耦**：订单支付后，库存、积分、通知各自响应，不让订单聚合认识它们；
- **实现最终一致**：替代“一个事务改多个聚合”；
- **审计与集成**：事件即业务事实的流水。

发布方式：

| 方式 | 说明 |
| --- | --- |
| **进程内事件**（Spring `ApplicationEventPublisher` + `@TransactionalEventListener(phase = AFTER_COMMIT)`） | 同一服务内聚合间解耦；注意**提交后才触发**，否则回滚了事件已发出 |
| **跨服务事件** | 经 MQ（Kafka/RocketMQ）；必须保证“**业务变更与事件发布**原子性”→ **Outbox 模式**，见 [事件驱动架构](#/design/event-driven) |

聚合只**记录**事件（`events.add(...)`），由应用层在保存成功后**拉取并发布**，聚合本身不依赖消息设施。

## 七、综合：一个下单的完整流转

1. 接口层收到请求，转成命令 `PlaceOrderCmd`；
2. 应用服务调用**领域服务**算价，并通过**防腐层**向营销/商品上下文取数据；
3. `Order.place(...)` 创建聚合（构造即满足不变量），记录 `OrderPlaced`；
4. 仓储保存聚合；**同一事务**把事件写入 Outbox 表；
5. 中继投递到 MQ；库存上下文消费并预留库存（自身聚合的事务），成功/失败再发事件；
6. 订单上下文消费库存结果，推进状态（失败则取消订单，即**补偿**）。

## 八、测试优势

聚合是**纯 Java 对象**，不依赖 Spring 与数据库，单元测试飞快：

```java
@Test void 已支付订单不能再添加商品() {
    Order o = Order.place(id, customer, drafts);
    o.pay(pid, o.total());
    assertThrows(DomainException.class, () -> o.addLine(draft));
}
```

用测试覆盖**所有不变量**，是 DDD 带来的最大工程收益之一。

## 九、常见反模式

| 反模式 | 后果 / 对策 |
| --- | --- |
| **贫血模型**，所有逻辑在 Service | 规则散落、被绕过；把状态转移与校验收回聚合 |
| **上帝聚合**（订单带一切） | 性能与并发差；按不变量拆小，按 ID 引用 |
| 聚合里直接持有其他聚合对象 | 对象图膨胀、边界模糊；改为 ID |
| **一个事务改多个聚合** | 锁与失败范围大，难拆分；改用领域事件最终一致 |
| 聚合暴露 `setXxx`、内部集合 | 不变量被外部破坏；返回不可变视图，提供业务方法 |
| 用聚合做列表/报表查询 | 慢且扭曲模型；用读模型/投影查询 |
| 值对象可变、用基本类型表示金额 | 引入隐蔽 bug；record + 校验 |
| 仓储暴露任意 SQL/分页条件 | 退化为 DAO；聚合仓储只做按 ID/少量业务键的存取 |
| 领域层依赖框架（Spring、MyBatis 注解） | 难以测试与演进；依赖倒置，适配放基础设施 |
| 把领域事件当命令用 | 事件是“已发生的事实”，不是“请你去做”；命令有明确接收者 |

## 面试追问

> [!QUESTION] 实体和值对象的区别？为什么推荐多用值对象？
> 实体有唯一标识且状态可变，按 ID 判断相等；值对象无标识、不可变、按属性值相等，如金额、地址。值对象让概念显式化、自带校验、无副作用且易测试，避免用基本类型表达业务概念导致的混用错误，所以能用值对象就不用实体。

> [!QUESTION] 什么是聚合？如何设计聚合边界？
> 聚合是需要同时满足业务不变量、在同一事务中一致修改的一组对象，外部只能通过聚合根访问。边界由必须强一致的规则决定，原则是小聚合、聚合间只引用 ID、一个事务只改一个聚合，跨聚合用领域事件做最终一致，并用乐观锁控制并发。

> [!QUESTION] 为什么聚合之间只引用 ID，而不直接持有对象？
> 直接持有会拉出庞大的对象图，加载慢、并发冲突多、边界模糊，也难以拆分到不同服务或分库分表。只引用 ID 保持聚合小而独立，需要数据时通过仓储或查询服务获取。

> [!QUESTION] 贫血模型和充血模型的区别？各自适用场景？
> 贫血模型实体只有数据，规则在 Service 里，规则易分散和被绕过；充血模型把状态转移与不变量校验放进聚合内部，任何调用路径都不能破坏规则。简单 CRUD 用贫血足够，规则复杂且需要保证始终合法时用充血。

> [!QUESTION] 领域服务和应用服务有什么区别？
> 领域服务承载不属于单个实体的领域规则，通常涉及多个聚合，如计价和转账，包含业务逻辑；应用服务只做用例编排、事务边界、权限和幂等，不含业务规则，很薄。

> [!QUESTION] 聚合怎么发布领域事件并保证不丢？
> 聚合在状态变更时记录事件，应用层保存聚合成功后拉取并发布。进程内用提交后事件监听，跨服务时为保证业务变更与事件发布的原子性，使用 Outbox 本地消息表，在同一事务写入事件并由中继投递到 MQ，消费方幂等处理。

> [!QUESTION] 聚合要做复杂列表查询怎么办？
> 不应该通过加载聚合来做查询。聚合为写入和不变量设计，列表、报表、联查应使用专门的查询服务或读模型，直接 SQL 投影成 DTO，这也是 CQRS 的思想。
