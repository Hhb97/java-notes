---
level: 进阶
tags: [设计模式, 代理, 装饰器, 适配器, 策略, 模板方法, 观察者, 责任链, SOLID]
summary: 结构型与行为型模式结合 JDK、Spring、MyBatis、Netty 的真实源码来讲：代理与装饰器的区别、策略与模板方法如何消灭分支、责任链在 Filter/Interceptor/Pipeline 中的形态。
---

# 结构型与行为型模式

> [!ABSTRACT] 核心要点
> - **SOLID** 是判断设计好坏的标尺：单一职责、开闭、里氏替换、接口隔离、依赖倒置；模式是满足这些原则的常见做法。
> - **代理 vs 装饰器**：代理**控制访问**（权限、延迟、事务、远程），客户端通常不知道真实对象；装饰器**增强功能**，由客户端层层包装。Spring AOP、MyBatis Mapper、RPC 客户端都是动态代理。
> - **策略 / 模板方法 / 责任链**是业务代码里最实用的三个：分别解决“分支算法可替换”“流程固定、细节可变”“请求经过多个处理节点”。
> - 框架里随处可见：Servlet Filter 与 Spring Interceptor 是**责任链**，Spring 事件是**观察者**，`JdbcTemplate` 是**模板方法**，`InputStreamReader` 是**适配器**。
> - 不要为了套模式而套模式：出现**重复且可预期的变化点**时再引入。

## 设计原则（SOLID）

| 原则 | 含义 | 违反的征兆 |
| --- | --- | --- |
| **S** 单一职责 | 一个类只有一个变化的原因 | 类里既有业务又有 IO 又有格式化，改一处牵动全部 |
| **O** 开闭原则 | 对扩展开放，对修改关闭 | 每加一种类型就改一堆 `if/switch` |
| **L** 里氏替换 | 子类可替换父类而不破坏程序正确性 | 子类重写后抛出“不支持”异常或改变前置条件 |
| **I** 接口隔离 | 接口小而专，不强迫依赖用不到的方法 | 实现类里大量空方法 |
| **D** 依赖倒置 | 高层不依赖低层细节，都依赖抽象 | 业务层 `new` 具体的 DAO / 客户端 |

另外两条常用原则：**迪米特法则**（只与直接朋友交谈，减少耦合）、**组合优于继承**。

---

## 结构型模式

关注**类与对象如何组合**成更大的结构。

### 代理模式

<figure class="fig">
<svg viewBox="0 0 740 220" class="dg" role="img" aria-label="代理模式：客户端通过代理访问真实对象，代理在前后加入横切逻辑">
<rect class="b" x="20" y="80" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="105" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b1" x="210" y="40" width="200" height="130" rx="10"/>
<text class="tb" x="310" y="62" text-anchor="middle" dominant-baseline="middle">代理 Proxy（同一接口）</text>
<rect class="b3" x="230" y="80" width="160" height="26" rx="5"/>
<text class="ts" x="310" y="93" text-anchor="middle" dominant-baseline="middle">前置：鉴权 / 开启事务 / 计时</text>
<rect class="b3" x="230" y="130" width="160" height="26" rx="5"/>
<text class="ts" x="310" y="143" text-anchor="middle" dominant-baseline="middle">后置：提交 / 日志 / 缓存</text>
<rect class="b2" x="520" y="80" width="150" height="50" rx="8"/>
<text class="tb" x="595" y="105" text-anchor="middle" dominant-baseline="middle">真实对象 Target</text>
<line class="l" x1="130" y1="105" x2="210" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="105" x2="520" y2="105" marker-end="url(#arr)"/>
<text class="ts" x="465" y="96" text-anchor="middle">委托调用</text>
<text class="ts" x="370" y="200" text-anchor="middle">静态代理：手写代理类；动态代理：运行时生成（JDK Proxy 基于接口，CGLIB / ByteBuddy 基于子类）</text>
</svg>
<figcaption>图 1：代理在不改动目标对象的前提下增强或控制其调用</figcaption>
</figure>

```java
// JDK 动态代理：基于接口，运行时生成代理类
UserService proxy = (UserService) Proxy.newProxyInstance(
        UserService.class.getClassLoader(),
        new Class<?>[]{UserService.class},
        (p, method, args) -> {
            long t = System.nanoTime();
            try {
                return method.invoke(target, args);
            } finally {
                log.info("{} 耗时 {}us", method.getName(), (System.nanoTime() - t) / 1000);
            }
        });
```

**真实应用**：Spring AOP / `@Transactional`、MyBatis `MapperProxy`（接口 → SQL 调用）、OpenFeign、Dubbo 消费端、`@Lazy` 懒加载代理、Hibernate 延迟加载。机制详见 [AOP 与代理机制](#/spring/aop)、[反射、注解与动态代理](#/java/api/reflect)。

### 装饰器模式

**不改变原类**，通过**包装**动态增加功能；装饰器与被装饰对象实现**同一接口**，可以层层嵌套。

```java
InputStream in = new BufferedInputStream(          // 增加缓冲
                    new GZIPInputStream(            // 增加解压
                        new FileInputStream("a.gz")));
```

- JDK IO 流是经典装饰器；`Collections.unmodifiableList()`、`synchronizedList()` 也是；
- Spring 的 `HttpServletRequestWrapper`、`BeanWrapper`；Netty 的 `ByteBuf` 装饰（`ReadOnlyByteBuf`、`SwappedByteBuf`）。

> [!NOTE] 代理与装饰器如何区分
> 结构几乎一样，**意图**不同：代理侧重**控制对对象的访问**（客户端不关心被代理对象如何得到，常由框架创建）；装饰器侧重**增强职责**（由使用者自己决定叠加哪些功能）。

### 适配器模式

把一个接口转换成调用方期望的另一个接口，让不兼容的类协同工作。

```java
// 旧系统接口返回 XML，新系统期望 JSON 对象
public class LegacyUserAdapter implements UserProvider {
    private final LegacyUserClient legacy;
    public User find(long id) {
        String xml = legacy.queryXml(id);
        return XmlMapper.parse(xml);              // 转换格式，对调用方透明
    }
}
```

JDK：`InputStreamReader`（字节流 → 字符流）、`Arrays.asList()`（数组 → List）；Spring MVC 的 `HandlerAdapter`（让不同形式的 Handler 能被 `DispatcherServlet` 统一调用，见 [Spring MVC 请求链路](#/spring/mvc)）；防腐层（ACL）是适配器思想在架构层面的应用。

### 外观模式

为复杂子系统提供**统一、简化的入口**：Service 层聚合多个 DAO 与远程调用，对 Controller 暴露一个方法；SLF4J 对各日志实现的统一门面；`JdbcTemplate`。

### 其他

| 模式 | 要点 | 例子 |
| --- | --- | --- |
| 组合 Composite | 树形结构，叶子与容器统一对待 | 菜单树、文件系统、Spring Security 的 `AuthenticationProvider` 管理器 |
| 享元 Flyweight | 共享细粒度对象减少内存 | `Integer.valueOf` 缓存、字符串常量池、线程池 |
| 桥接 Bridge | 抽象与实现分离，各自独立扩展 | JDBC（`Driver` 接口 + 各厂商实现） |

---

## 行为型模式

关注**对象之间的职责分配与通信**。

### 策略模式

把一族算法封装成**可互换**的对象，运行时选择，**消灭大量 if-else**。

```java
public interface DiscountStrategy { String level(); long apply(long price); }

@Component class VipDiscount    implements DiscountStrategy { public String level() { return "VIP"; }    public long apply(long p) { return (long) (p * 0.8); } }
@Component class NewUserDiscount implements DiscountStrategy { public String level() { return "NEW"; }   public long apply(long p) { return Math.max(0, p - 500); } }

@Service class PriceService {
    private final Map<String, DiscountStrategy> map;
    PriceService(List<DiscountStrategy> list) { this.map = list.stream().collect(toMap(DiscountStrategy::level, identity())); }
    long price(String level, long origin) { return map.getOrDefault(level, p -> p).apply(origin); }
}
```

真实例子：`Comparator`、`ThreadPoolExecutor` 的拒绝策略、Spring 的 `Resource` 加载策略、负载均衡算法、`HandlerMethodArgumentResolver`。简单场景下函数式接口 + Lambda 就足够。

### 模板方法模式

父类定义**算法骨架**，把可变步骤延迟到子类。

```java
public abstract class ReportTemplate {
    public final void generate() {          // final：流程不可改
        List<?> data = load();
        validate(data);
        render(data);
    }
    protected abstract List<?> load();
    protected abstract void render(List<?> data);
    protected void validate(List<?> data) { }     // 钩子（hook），可选覆盖
}
```

真实例子：`AbstractApplicationContext#refresh()`（骨架固定，`onRefresh`、`postProcessBeanFactory` 等留给子类）、`JdbcTemplate`/`RestTemplate`（模板 + 回调）、`AbstractQueuedSynchronizer`（子类实现 `tryAcquire`）、`HttpServlet#service`。**模板方法用继承，回调/策略用组合**，后者更灵活。

### 观察者模式

对象状态变化时，**自动通知**所有订阅者，发布者与订阅者解耦。

```java
// Spring 事件
applicationContext.publishEvent(new OrderPaidEvent(orderId));

@Component class SmsListener {
    @TransactionalEventListener(phase = AFTER_COMMIT)          // 事务提交后才发送，避免回滚后误通知
    void on(OrderPaidEvent e) { sms.send(e.orderId()); }
}
```

JDK：`java.util.Observer`（已废弃）、`PropertyChangeListener`；分布式层面的**发布订阅**（MQ）是观察者的放大版。注意：默认**同步**执行，监听者慢或抛异常会影响发布者，必要时 `@Async` 或改用 MQ。

### 责任链模式

<figure class="fig">
<svg viewBox="0 0 740 200" class="dg" role="img" aria-label="责任链：请求依次经过多个处理节点，每个节点可处理或传递">
<rect class="b" x="20" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="65" y="95" text-anchor="middle" dominant-baseline="middle">请求</text>
<rect class="b1" x="170" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="230" y="86" text-anchor="middle" dominant-baseline="middle">认证 Filter</text>
<text class="ts" x="230" y="108" text-anchor="middle">失败则中断</text>
<rect class="b1" x="340" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="400" y="86" text-anchor="middle" dominant-baseline="middle">限流 Filter</text>
<text class="ts" x="400" y="108" text-anchor="middle">超限则拒绝</text>
<rect class="b1" x="510" y="60" width="120" height="70" rx="8"/>
<text class="tb" x="570" y="86" text-anchor="middle" dominant-baseline="middle">日志 Filter</text>
<text class="ts" x="570" y="108" text-anchor="middle">记录后放行</text>
<rect class="b2" x="670" y="70" width="60" height="50" rx="8"/>
<text class="tb" x="700" y="95" text-anchor="middle" dominant-baseline="middle">业务</text>
<line class="l" x1="110" y1="95" x2="170" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="95" x2="340" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="95" x2="510" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="95" x2="670" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="370" y="170" text-anchor="middle">chain.doFilter(request, response) 把请求交给下一个节点；每个节点可在前后做处理，也可终止</text>
</svg>
<figcaption>图 2：责任链：请求沿链传递，节点可处理、转发或中断</figcaption>
</figure>

```java
public interface Handler { void handle(Request req, Chain chain); }

public class Chain {
    private final List<Handler> handlers; private int index = 0;
    public void proceed(Request req) {
        if (index < handlers.size()) handlers.get(index++).handle(req, this);
    }
}
```

真实例子：**Servlet `FilterChain`**、**Spring MVC `HandlerInterceptor` 链**、**Spring AOP 的 `ReflectiveMethodInvocation#proceed`**、Netty 的 **`ChannelPipeline`**、Dubbo / Sentinel 的 Slot Chain、审批流程。

### 迭代器 / 状态 / 命令

| 模式 | 要点 | 例子 |
| --- | --- | --- |
| 迭代器 | 统一遍历接口，不暴露内部结构 | `Iterator` / `Iterable` / 增强 for |
| 状态 | 对象行为随内部状态改变，用状态类代替 if-else | 订单状态机（待支付/已支付/已取消），Spring StateMachine |
| 命令 | 把请求封装成对象，支持排队、撤销、日志 | `Runnable` 提交线程池、Redis 命令、事务日志 |

---

## 模式速选表

| 问题 | 考虑 |
| --- | --- |
| if-else / switch 太多，算法可替换 | **策略** |
| 流程固定、步骤细节不同 | **模板方法** |
| 给对象动态加功能 | **装饰器**；不改原类的横切（事务、日志）用 **代理 / AOP** |
| 接口对不上 | **适配器** |
| 状态变化要通知多方 | **观察者**（跨进程则用 MQ） |
| 多个节点依次处理请求 | **责任链** |
| 简化复杂子系统调用 | **外观** |
| 订单、审批等有明确状态流转 | **状态** |

> [!TIP] 与 Spring 的关系
> 现代 Java 工程里，策略/工厂靠 Bean 注入的 `Map/List` 实现，模板方法常被“模板类 + 回调”替代，代理由 AOP 提供，观察者由事件机制提供。理解模式的价值在于读懂框架源码和做出更好的抽象，而不是手写它们。

## 相关阅读

- [创建型模式](#/java/patterns/creational)：创建型模式
- [DDD 战术设计：聚合、实体与领域事件（Java 落地）](#/design/ddd-tactical)：领域模型中的策略、状态与事件
- [AOP 与代理机制](#/spring/aop)：代理模式在 Spring AOP 中的实现

## 面试追问

> [!QUESTION] 代理模式和装饰器模式的区别？
> 结构相似，意图不同：代理控制对目标的访问（权限、延迟加载、事务、远程调用），目标对象常由代理持有或创建；装饰器是为了给对象动态增加职责，由客户端自由组合、层层包装。

> [!QUESTION] JDK 动态代理和 CGLIB 有什么区别？
> JDK 动态代理基于接口，运行时生成实现该接口的代理类并通过 `InvocationHandler` 转发；CGLIB 通过继承目标类生成子类并重写方法，不要求接口，但不能代理 final 类和方法。Spring Boot 默认使用 CGLIB。

> [!QUESTION] 如何消灭业务代码里的 if-else？
> 用策略模式：为每个分支定义一个策略类并注册到 Map（Spring 注入 `Map<String, Strategy>`），按类型取出执行；流程骨架相同时用模板方法；条件链式判断用责任链。

> [!QUESTION] Spring 中用到了哪些设计模式？
> 工厂（BeanFactory）、单例（Bean 作用域）、代理（AOP）、模板方法（JdbcTemplate、refresh）、观察者（事件机制）、适配器（HandlerAdapter）、策略（Resource 加载、各类 Resolver）、责任链（拦截器链、Filter）、装饰器（各种 Wrapper）。

> [!QUESTION] 模板方法和策略模式有什么不同？
> 模板方法通过继承固定流程骨架，子类重写某些步骤；策略通过组合把整个算法封装成可替换对象，运行时切换。策略更灵活、更易测试，模板方法适合骨架稳定、变化点少的场景。
