# 结构型与行为型

## 设计原则（SOLID）

| 原则 | 含义 |
| --- | --- |
| **S** 单一职责 | 一个类只有一个变化的原因 |
| **O** 开闭原则 | 对扩展开放，对修改关闭 |
| **L** 里氏替换 | 子类可以替换父类而不破坏程序 |
| **I** 接口隔离 | 接口小而专，不强迫依赖用不到的方法 |
| **D** 依赖倒置 | 依赖抽象，而不是具体实现 |

---

## 结构型模式

关注**类与对象如何组合**成更大的结构。

### 代理模式

为对象提供一个替身，控制对它的访问（权限、缓存、日志、延迟加载、事务）。

```java
interface UserService { User find(long id); }

class UserServiceImpl implements UserService { public User find(long id) { ... } }

// JDK 动态代理：运行时生成代理类，无需为每个接口手写
UserService proxy = (UserService) Proxy.newProxyInstance(
    UserService.class.getClassLoader(),
    new Class<?>[]{UserService.class},
    (p, method, args) -> {
        long t = System.nanoTime();
        Object r = method.invoke(target, args);
        System.out.println(method.getName() + " 耗时 " + (System.nanoTime() - t));
        return r;
    });
```

Spring AOP 就是基于动态代理，见 [Spring IoC 与 AOP](#/eng/spring)。

### 装饰器模式

**不改变原类**，动态给对象增加功能；与被装饰对象实现同一接口。典型：Java IO 流 `new BufferedReader(new InputStreamReader(...))`。

### 适配器模式

把一个接口转换成调用方期望的另一个接口，用于整合不兼容的旧代码或第三方库（如 `InputStreamReader` 把字节流适配为字符流）。

### 外观模式

为复杂子系统提供**统一的简单入口**。Service 层聚合多个 DAO / 远程调用，对 Controller 暴露一个方法，就是外观。

---

## 行为型模式

关注**对象之间的职责分配与通信**。

### 策略模式

把一族算法封装成可互换的对象，**消灭大量 if-else**。

```java
interface DiscountStrategy { long apply(long price); }

Map<String, DiscountStrategy> strategies = Map.of(
    "VIP",    p -> (long) (p * 0.8),
    "NORMAL", p -> p,
    "NEW",    p -> p - 500
);
long finalPrice = strategies.getOrDefault(level, p -> p).apply(price);
```

在 Spring 里常见做法：多个实现类注入到 `Map<String, Strategy>`，key 是 Bean 名称。

### 模板方法模式

父类定义**算法骨架**，把可变步骤延迟到子类，见 [接口与抽象类](#/oop/interface) 的 `Report` 示例。Spring 的 `JdbcTemplate`、`RestTemplate` 也是此思想。

### 观察者模式

对象状态变化时，**自动通知**所有订阅者。

```java
// Spring 事件机制
applicationContext.publishEvent(new OrderCreatedEvent(order));

@EventListener
public void onCreated(OrderCreatedEvent e) { sendSms(e.getOrder()); }
```

发布者与监听者解耦，新增通知渠道不改下单代码。

### 责任链模式

把请求沿着处理者链条传递，每个节点决定处理或继续往下传。典型：Servlet `Filter` 链、Spring `Interceptor`、审批流程。

### 迭代器模式

统一遍历集合的方式而不暴露内部结构：`Iterator` / `Iterable` / 增强 for。

---

## 模式速选表

| 问题 | 考虑 |
| --- | --- |
| if-else / switch 太多，分支算法可替换 | 策略 |
| 流程固定，步骤细节不同 | 模板方法 |
| 要给对象动态加功能 | 装饰器 / 代理 |
| 接口对不上 | 适配器 |
| 状态变化要通知多方 | 观察者 |
| 多个处理节点依次处理请求 | 责任链 |
| 要简化复杂系统的调用 | 外观 |

> 不要为了用模式而用模式。先写清晰的代码，当出现**重复变化的点**时再引入对应的模式。
