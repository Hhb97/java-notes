---
level: 进阶
tags: [设计模式, 单例, 工厂, 建造者, 原型, 依赖注入]
summary: 创建型模式在 JDK 与框架中的真实形态：单例的各种写法与破坏方式、简单工厂到抽象工厂的取舍、Builder 的使用场景，以及它们与 Spring 容器的关系。
---

# 创建型模式

> [!ABSTRACT] 核心要点
> - 创建型模式关注**对象怎么被创建**，把“使用”与“创建”解耦，使调用方依赖抽象。
> - **单例**：最稳妥的是**枚举**或**静态内部类**；DCL 必须 `volatile`；业务代码里单例通常交给 **Spring 容器**管理，而不是手写。
> - **工厂**：根据条件返回不同实现，让新增实现不改调用方；用 Spring 的 `Map<String, Bean>` 注入可消灭 `if/switch`。
> - **建造者**：参数多、可选项多、需要不可变对象与校验时使用；Lombok `@Builder` 自动生成。
> - 创建型模式的“上位替代”是 **依赖注入（DI）**：对象由容器创建并装配，见 [IoC 容器与 Bean 生命周期](#/spring/ioc)。

## 单例模式

保证一个类只有一个实例，并提供全局访问点。

### 写法对比

```java
// 1. 饿汉式：类加载时创建。简单、线程安全；缺点是不管用不用都创建
public class Eager {
    private static final Eager INSTANCE = new Eager();
    private Eager() {}
    public static Eager getInstance() { return INSTANCE; }
}

// 2. 双重检查锁（DCL）：懒加载 + 低锁开销。必须 volatile
public class Dcl {
    private static volatile Dcl instance;
    private Dcl() {}
    public static Dcl getInstance() {
        if (instance == null) {                       // 第一次检查：避免每次加锁
            synchronized (Dcl.class) {
                if (instance == null) {               // 第二次检查：避免重复创建
                    instance = new Dcl();
                }
            }
        }
        return instance;
    }
}

// 3. 静态内部类：懒加载 + 线程安全，由类加载机制保证，推荐
public class Holder {
    private Holder() {}
    private static class Inner { static final Holder INSTANCE = new Holder(); }
    public static Holder getInstance() { return Inner.INSTANCE; }
}

// 4. 枚举：防反射、防反序列化破坏（《Effective Java》首推）
public enum Config {
    INSTANCE;
    public String get(String key) { return System.getProperty(key); }
}
```

### 为什么 DCL 必须 volatile

`instance = new Dcl()` 实际三步：① 分配内存 → ② 初始化对象 → ③ 把引用赋给 `instance`。没有 `volatile` 时 ②③ 可能**重排序**，另一个线程在第一次检查时看到 `instance != null`，拿到一个**尚未初始化完成**的对象。`volatile` 禁止这种重排序，原理见 [Java 内存模型与 volatile](#/java/concurrency/jmm)。

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="DCL 缺少 volatile 时指令重排导致线程 B 看到未初始化对象的时序">
<rect class="b1" x="60" y="20" width="150" height="34" rx="6"/>
<text class="tb" x="135" y="37" text-anchor="middle" dominant-baseline="middle">线程 A（创建）</text>
<rect class="b3" x="500" y="20" width="150" height="34" rx="6"/>
<text class="tb" x="575" y="37" text-anchor="middle" dominant-baseline="middle">线程 B（读取）</text>
<line class="ld" x1="135" y1="54" x2="135" y2="240"/>
<line class="ld" x1="575" y1="54" x2="575" y2="240"/>
<text class="t" x="150" y="84" text-anchor="start">① 分配内存</text>
<text class="ta" x="150" y="118" text-anchor="start">③ instance = 内存地址（先执行）</text>
<text class="ts" x="150" y="136" text-anchor="start">此时对象尚未初始化！</text>
<line class="l" x1="575" y1="150" x2="575" y2="150"/>
<text class="t" x="590" y="168" text-anchor="start">instance != null</text>
<text class="ts" x="590" y="186" text-anchor="start">直接返回并使用</text>
<text class="ts" x="590" y="204" text-anchor="start">读到默认值 / 半初始化状态</text>
<text class="t" x="150" y="190" text-anchor="start">② 调用构造方法初始化（后执行）</text>
<line class="la" x1="400" y1="118" x2="560" y2="160" marker-end="url(#arr-a)"/>
<text class="ts" x="370" y="236" text-anchor="middle">② ③ 被重排序后，B 在 A 完成初始化之前就看到了非空引用；volatile 禁止该重排序</text>
</svg>
<figcaption>图 1：没有 volatile 时，DCL 可能暴露未初始化完成的对象</figcaption>
</figure>

### 如何破坏单例，怎么防

| 破坏方式 | 防护 |
| --- | --- |
| **反射**调用私有构造器 | 构造器内检查实例已存在则抛异常；**枚举**天然防止（反射不能创建枚举实例） |
| **反序列化**生成新对象 | 实现 `readResolve()` 返回单例；枚举由 JVM 保证 |
| `clone()` | 不实现 `Cloneable`，或重写抛异常 |
| **多个类加载器** | 每个类加载器各一份；容器（Tomcat）场景需注意，见 [类加载与双亲委派](#/java/jvm/classloader) |

### 框架里的单例

- JDK：`Runtime.getRuntime()`（饿汉）；
- **Spring Bean 默认单例**：是“**每个容器内、每个 Bean 定义一个实例**”，而不是 JVM 全局唯一；由 `DefaultSingletonBeanRegistry` 的 `singletonObjects` 缓存。**Spring 单例 Bean 要无状态**，否则并发下线程不安全。

## 工厂模式

### 简单工厂

```java
public interface Payment { void pay(long cents); }

public class PaymentFactory {
    public static Payment create(String type) {
        return switch (type) {
            case "WX"  -> new WxPay();
            case "ALI" -> new AliPay();
            default    -> throw new IllegalArgumentException("unknown " + type);
        };
    }
}
```

新增支付方式需要修改工厂（违反开闭原则），但足够简单。

### 工厂方法

```java
public interface PaymentFactory { Payment create(); }
public class WxPayFactory implements PaymentFactory { public Payment create() { return new WxPay(); } }
```

把“创建哪个实现”的决定下放给子类/具体工厂，新增实现只需新增工厂类。

### 抽象工厂

创建**一族**相关对象，保证它们搭配使用，例如“不同数据库的一套 Connection + Statement + ResultSet”（JDBC 的 `Driver` 就是）。

### Spring 中的最佳实践：注册表 + 注入

```java
public interface PayStrategy { String type(); void pay(long cents); }

@Component public class WxPay  implements PayStrategy { public String type() { return "WX"; }  ... }
@Component public class AliPay implements PayStrategy { public String type() { return "ALI"; } ... }

@Service
public class PayService {
    private final Map<String, PayStrategy> strategies;

    public PayService(List<PayStrategy> list) {                      // 容器注入所有实现
        this.strategies = list.stream().collect(Collectors.toMap(PayStrategy::type, Function.identity()));
    }
    public void pay(String type, long cents) {
        Optional.ofNullable(strategies.get(type))
                .orElseThrow(() -> new BizException("不支持的支付方式 " + type))
                .pay(cents);
    }
}
```

新增实现只需新增一个 `@Component`，**不修改任何已有代码**，满足开闭原则。

### 框架中的工厂

| 位置 | 说明 |
| --- | --- |
| `BeanFactory` / `FactoryBean` | Spring 容器本身就是工厂；`FactoryBean` 用于创建复杂对象（MyBatis 的 `SqlSessionFactoryBean`、Mapper 代理）|
| `Calendar.getInstance()`、`NumberFormat.getInstance()` | 静态工厂方法 |
| `List.of()`、`Optional.of()`、`Integer.valueOf()` | 静态工厂（可缓存、可返回子类型）|
| `SqlSessionFactory.openSession()` | MyBatis |

静态工厂方法相对构造器的优势：**有名字**、**可以缓存/复用实例**、**可返回子类型**、可隐藏实现类。

## 建造者模式

### 解决什么问题

构造器参数很多且大多可选时，伸缩构造器（telescoping）难读，JavaBean 的 setter 又让对象在构造期间处于**不一致状态**且无法做成不可变。

```java
public class HttpRequest {
    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final int timeoutMs;

    private HttpRequest(Builder b) {
        this.url = b.url; this.method = b.method; this.headers = Map.copyOf(b.headers); this.timeoutMs = b.timeoutMs;
    }
    public static Builder builder(String url) { return new Builder(url); }

    public static class Builder {
        private final String url;
        private String method = "GET";
        private final Map<String, String> headers = new HashMap<>();
        private int timeoutMs = 3000;

        private Builder(String url) { this.url = Objects.requireNonNull(url); }       // 必填参数放构造器
        public Builder method(String m)          { this.method = m; return this; }
        public Builder header(String k, String v){ headers.put(k, v); return this; }
        public Builder timeout(int ms)           { this.timeoutMs = ms; return this; }
        public HttpRequest build() {
            if (timeoutMs <= 0) throw new IllegalStateException("timeout must be positive");   // 统一校验
            return new HttpRequest(this);
        }
    }
}

HttpRequest r = HttpRequest.builder("https://a.com").method("POST").header("X-Id", "1").timeout(1000).build();
```

### 在 JDK / 框架中

`StringBuilder`、`Stream.Builder`、`HttpClient.newBuilder()`、`HttpRequest.newBuilder()`、Spring 的 `UriComponentsBuilder`、`ResponseEntity.ok().header(...).body(...)`、Lombok `@Builder`。

> [!TIP] 何时使用
> 超过 4 个参数、存在可选参数、希望对象**不可变**并在构建时统一校验。简单数据载体优先使用 `record`（见 [枚举与记录类](#/java/oop/enum)）；字段多时 record + Builder 也很常见。

## 原型模式

通过**拷贝已有对象**创建新对象，避免重复的昂贵初始化。

```java
// 浅拷贝：只复制引用，两个对象共享内部可变对象
Order copy = (Order) order.clone();

// 深拷贝：递归复制引用对象。常用做法：拷贝构造器 / 序列化再反序列化 / 手工复制
public Order(Order other) {
    this.id = other.id;
    this.items = other.items.stream().map(Item::new).toList();   // 复制每个元素
}
```

- `Cloneable` + `Object.clone()` 设计有缺陷（受保护方法、浅拷贝、绕过构造器），**更推荐拷贝构造器或工厂方法**；
- Spring 中 `scope="prototype"` 的 Bean 每次获取都创建新实例，是“原型”语义，但并不是通过 clone；
- `BeanUtils.copyProperties`、MapStruct 做的是对象属性映射，默认也是**浅拷贝**。

## 依赖注入：创建型模式的现代形态

手写的单例 / 工厂 / 建造者越来越少，因为 DI 容器接管了“创建 + 装配 + 生命周期”：

| 传统模式 | 容器中的对应 |
| --- | --- |
| 单例 | `@Scope("singleton")`（默认） |
| 原型 | `@Scope("prototype")` |
| 工厂 | `@Bean` 方法、`FactoryBean`、`ObjectProvider` |
| 抽象工厂 / 策略选择 | `Map<String, Bean>` / `List<Bean>` 注入 |
| 服务定位器 | `ApplicationContext.getBean()`（**不推荐**，隐藏依赖、难测试）|

## 选用建议

| 场景 | 模式 |
| --- | --- |
| 全局共享的无状态服务 | 交给 Spring，默认单例 |
| 自己写工具类里需要延迟初始化的单例 | 静态内部类 / 枚举 |
| 根据类型/条件选择不同实现 | 工厂（Spring 里用注册表） |
| 复杂对象构造、参数多可选 | 建造者 |
| 复制已有对象 | 拷贝构造器 / 原型 |

## 面试追问

> [!QUESTION] 单例有哪些写法？推荐哪种？为什么？
> 饿汉、DCL、静态内部类、枚举。推荐静态内部类（懒加载、无锁、安全）或枚举（还能防反射和反序列化）；DCL 需要 volatile；业务中优先用 Spring 管理。

> [!QUESTION] DCL 中 volatile 的作用？
> 防止对象创建的三步（分配、初始化、赋值）发生重排序，避免其他线程拿到未初始化完成的实例；同时保证可见性。

> [!QUESTION] Spring 的单例 Bean 和单例模式有什么不同？
> 单例模式保证 JVM（类加载器）范围内只有一个实例；Spring 单例是容器范围内每个 Bean 定义一个实例，同一个类可以定义多个不同名字的单例 Bean。Spring 的单例 Bean 通常无状态，因此是线程安全的前提。

> [!QUESTION] 简单工厂、工厂方法、抽象工厂的区别？
> 简单工厂用一个工厂类按参数创建产品，新增产品要改工厂；工厂方法把创建延迟到子工厂，一个工厂对应一种产品；抽象工厂创建一族相关产品。实际项目中常用 Spring 注册表模式代替它们。

> [!QUESTION] 为什么用建造者而不是 setter？
> setter 创建对象期间处于不完整状态，且无法做成不可变和统一校验；建造者在 `build()` 时一次性校验并创建不可变对象，参数含义清晰，可选参数灵活。
