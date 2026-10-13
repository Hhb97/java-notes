---
level: 基础
tags: [接口, 抽象类, default 方法, 函数式接口, sealed, 框架设计]
summary: default 方法的冲突解析规则与字节码实现、函数式接口与 sealed 层次，以及接口和抽象类在框架设计中的取舍
---

# 接口与抽象类

> [!ABSTRACT] 核心要点
> - 接口的演进：JDK 8 加入 `default`/`static` 方法，JDK 9 加入 `private` 方法，JDK 17 `sealed` 正式版；接口仍然**不能有实例状态**。
> - default 方法冲突三原则：**类优先** → **更具体的子接口优先** → 仍冲突则必须显式重写，可用 `X.super.m()` 指定。
> - 函数式接口 = 恰好一个抽象方法（`Object` 的公共方法不计），是 lambda 的目标类型；`java.util.function` 中的原始类型特化（`IntFunction` 等）用来避免装箱。
> - `sealed` 让「子类型集合」成为编译期已知的封闭集合，配合 record 与模式匹配 switch 得到代数数据类型和穷举检查。
> - 框架设计的主流做法是「接口定义契约 + 抽象类提供骨架实现」；JDK 8 后很多 `XxxAdapter` 抽象类被接口 default 方法取代。

## 接口能写什么

```java
public interface PaymentChannel {
    int TIMEOUT_MS = 3000;                     // 隐式 public static final

    PayResult pay(PayRequest req);             // 隐式 public abstract

    default PayResult payWithRetry(PayRequest req) {   // JDK 8：default 方法
        for (int i = 0; i < 3; i++) {
            PayResult r = pay(req);
            if (r.success()) return r;
            log(i, r);
        }
        return PayResult.fail();
    }

    static PaymentChannel noop() { return req -> PayResult.ok(); }   // JDK 8：静态方法，不被继承

    private void log(int attempt, PayResult r) { /* ... */ }        // JDK 9：私有方法，复用 default 逻辑
}
```

字节码层面：接口仍是带 `ACC_INTERFACE` 的 class 文件；default 方法就是接口里一个有 `Code` 属性的非抽象实例方法。实现类的 vtable 中会为它分配槽位（默认指向接口中的实现），通过接口类型调用走 `invokeinterface`，通过实现类类型调用走 `invokevirtual`。接口静态方法调用是 `invokestatic` + `InterfaceMethodref`，只能用 `接口名.方法()` 调用，实现类和实例都调不到。

## default 方法冲突解析

<figure class="fig">
<svg viewBox="0 0 720 260" class="dg" role="img" aria-label="default 方法冲突解析三条规则：类优先、更具体的子接口优先、无法判定时必须显式重写">
<rect class="bg" x="20" y="14" width="210" height="232" rx="10"/>
<text class="tb" x="125" y="34" text-anchor="middle">① 类优先</text>
<rect class="b1" x="30" y="50" width="90" height="44" rx="6"/>
<text class="tb" x="75" y="66" text-anchor="middle" dominant-baseline="middle">接口 I</text>
<text class="ts" x="75" y="84" text-anchor="middle">default m()</text>
<rect class="b2" x="130" y="50" width="90" height="44" rx="6"/>
<text class="tb" x="175" y="66" text-anchor="middle" dominant-baseline="middle">类 B</text>
<text class="ts" x="175" y="84" text-anchor="middle">m() 具体实现</text>
<rect class="b" x="70" y="150" width="110" height="44" rx="6"/>
<text class="tb" x="125" y="166" text-anchor="middle" dominant-baseline="middle">类 C</text>
<text class="ts" x="125" y="184" text-anchor="middle">extends B impl I</text>
<line class="ld" x1="105" y1="150" x2="80" y2="94" marker-end="url(#arr)"/>
<line class="la" x1="145" y1="150" x2="170" y2="94" marker-end="url(#arr-a)"/>
<text class="ts" x="125" y="228" text-anchor="middle">C.m() 调用 B.m()</text>
<rect class="bg" x="250" y="14" width="220" height="232" rx="10"/>
<text class="tb" x="360" y="34" text-anchor="middle">② 子接口优先</text>
<rect class="b1" x="260" y="50" width="90" height="44" rx="6"/>
<text class="tb" x="305" y="66" text-anchor="middle" dominant-baseline="middle">接口 I</text>
<text class="ts" x="305" y="84" text-anchor="middle">default m()</text>
<rect class="b1" x="362" y="96" width="102" height="44" rx="6"/>
<text class="tb" x="413" y="112" text-anchor="middle" dominant-baseline="middle">J extends I</text>
<text class="ts" x="413" y="130" text-anchor="middle">覆盖 m()</text>
<rect class="b" x="260" y="160" width="110" height="44" rx="6"/>
<text class="tb" x="315" y="176" text-anchor="middle" dominant-baseline="middle">类 C</text>
<text class="ts" x="315" y="194" text-anchor="middle">implements I, J</text>
<line class="ld" x1="362" y1="108" x2="350" y2="92" marker-end="url(#arr)"/>
<line class="ld" x1="300" y1="160" x2="300" y2="94" marker-end="url(#arr)"/>
<line class="la" x1="350" y1="160" x2="400" y2="140" marker-end="url(#arr-a)"/>
<text class="ts" x="360" y="228" text-anchor="middle">C.m() 调用 J.m()</text>
<rect class="bg" x="490" y="14" width="210" height="232" rx="10"/>
<text class="tb" x="595" y="34" text-anchor="middle">③ 必须显式重写</text>
<rect class="b1" x="500" y="50" width="90" height="44" rx="6"/>
<text class="tb" x="545" y="66" text-anchor="middle" dominant-baseline="middle">接口 I</text>
<text class="ts" x="545" y="84" text-anchor="middle">default m()</text>
<rect class="b1" x="604" y="50" width="90" height="44" rx="6"/>
<text class="tb" x="649" y="66" text-anchor="middle" dominant-baseline="middle">接口 K</text>
<text class="ts" x="649" y="84" text-anchor="middle">default m()</text>
<rect class="b4" x="545" y="150" width="110" height="44" rx="6"/>
<text class="tb" x="600" y="166" text-anchor="middle" dominant-baseline="middle">类 C</text>
<text class="ts" x="600" y="184" text-anchor="middle">implements I, K</text>
<line class="ld" x1="580" y1="150" x2="550" y2="94" marker-end="url(#arr)"/>
<line class="ld" x1="620" y1="150" x2="645" y2="94" marker-end="url(#arr)"/>
<text class="ts" x="595" y="218" text-anchor="middle">不重写则编译错误</text>
<text class="ts" x="595" y="236" text-anchor="middle">可调用 I.super.m()</text>
</svg>
<figcaption>图 1：default 方法的三条冲突解析规则</figcaption>
</figure>

```java
interface I { default String m() { return "I"; } }
interface K { default String m() { return "K"; } }
class C implements I, K {
    @Override public String m() { return I.super.m() + K.super.m(); }   // 显式选择/组合
}
```

规则 ① 保证了**向后兼容**：接口新增一个 default 方法时，已有实现类中同签名的方法自动胜出，行为不变。但兼容性并非绝对：

> [!WARNING] 新增 default 方法也可能破坏兼容
> 如果一个类同时实现了两个接口，而两个接口在新版本中各自新增了同签名、但返回类型不兼容或语义不同的 default 方法，用户代码会编译失败。JDK 21 引入 `SequencedCollection.reversed()` 时，就有同时实现 `List` 和 `Deque` 的第三方集合类需要修改源码。设计公共 API 时，default 方法名要避免过于通用。

## 函数式接口

```java
@FunctionalInterface
public interface Comparator<T> {
    int compare(T o1, T o2);          // 唯一的抽象方法
    boolean equals(Object obj);       // Object 的公共方法，不计入
    default Comparator<T> reversed() { return Collections.reverseOrder(this); }
}
```

- `@FunctionalInterface` 只是让编译器校验，不加也可以作为 lambda 目标类型。
- `java.util.function` 四大类：`Function<T,R>`、`Consumer<T>`、`Supplier<T>`、`Predicate<T>`，以及 `Bi*`、`*Operator` 和大量原始类型特化（`IntPredicate`、`ToLongFunction`、`IntBinaryOperator` …）。热点代码里用 `Function<Integer, Integer>` 会产生装箱，应选用特化版本。
- 函数式接口的抽象方法没有声明受检异常时，lambda 体内无法直接抛出受检异常，常见做法是自定义 `ThrowingFunction` 或在 lambda 内包装为非受检异常。

lambda 的实现机制见 [Lambda 与 Stream](#/java/modern/lambda)。

## sealed：封闭的类型层次

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="sealed 接口 Shape 只允许 Circle、Square、Polygon 三个子类型，其中 Polygon 为 non-sealed 可继续被任意扩展">
<rect class="b5" x="240" y="16" width="240" height="54" rx="8"/>
<text class="tb" x="360" y="36" text-anchor="middle" dominant-baseline="middle">sealed interface Shape</text>
<text class="ts" x="360" y="58" text-anchor="middle">permits Circle, Square, Polygon</text>
<line class="l" x1="360" y1="70" x2="125" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="70" x2="360" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="70" x2="600" y2="120" marker-end="url(#arr)"/>
<rect class="b2" x="40" y="120" width="170" height="50" rx="8"/>
<text class="tb" x="125" y="138" text-anchor="middle" dominant-baseline="middle">record Circle</text>
<text class="ts" x="125" y="158" text-anchor="middle">record 隐式 final</text>
<rect class="b2" x="275" y="120" width="170" height="50" rx="8"/>
<text class="tb" x="360" y="138" text-anchor="middle" dominant-baseline="middle">final class Square</text>
<text class="ts" x="360" y="158" text-anchor="middle">不可再被继承</text>
<rect class="b3" x="500" y="120" width="200" height="50" rx="8"/>
<text class="tb" x="600" y="138" text-anchor="middle" dominant-baseline="middle">non-sealed Polygon</text>
<text class="ts" x="600" y="158" text-anchor="middle">重新向任意子类开放</text>
<line class="ld" x1="600" y1="170" x2="600" y2="190" marker-end="url(#arr)"/>
<rect class="bg" x="520" y="190" width="160" height="30" rx="6"/>
<text class="ts" x="600" y="205" text-anchor="middle" dominant-baseline="middle">Triangle / … 任意扩展</text>
<text class="ts" x="40" y="200">class 文件属性 PermittedSubclasses 记录许可列表</text>
<text class="ts" x="40" y="218">JVM 加载子类时校验；反射 Class#getPermittedSubclasses()</text>
</svg>
<figcaption>图 2：sealed 层次与三种子类修饰</figcaption>
</figure>

规则：

- 子类必须是 `final`、`sealed`、`non-sealed` 之一（record 和 enum 隐式 final）；
- 子类必须与父类在同一个模块（未命名模块时须在同一个包）；子类都在同一文件时可省略 `permits`。
- 价值不在「禁止继承」，而在**让编译器知道全部子类型**：`switch (shape)` 可以不写 default 并获得穷举检查，新增子类型时所有未覆盖的 switch 编译报错——这是比 visitor 模式更轻量的「对封闭类型集合做操作」的手段。

## 接口 vs 抽象类

| 维度 | 接口 | 抽象类 |
| --- | --- | --- |
| 状态 | 只有常量 | 可有实例字段 |
| 构造器 | 无 | 有，可强制子类传参 |
| 多继承 | 一个类可实现多个 | 单继承 |
| 方法访问修饰 | public / private | 任意 |
| 演进 | default 方法可加行为，但不能加状态 | 可随意加字段和方法，但子类被绑死在一棵继承树上 |
| 语义 | 「能做什么」（能力、契约） | 「是什么」+ 共享实现（骨架） |
| 动态代理 | JDK Proxy 只能代理接口 | 只能用 CGLIB/ByteBuddy 生成子类 |

### 框架中的典型取舍

| 例子 | 做法 | 说明 |
| --- | --- | --- |
| `List` + `AbstractList` | 接口 + 骨架实现 | 实现者只需写 `get` 和 `size`，用户面向接口编程 |
| `AbstractQueuedSynchronizer` | 抽象类 + 模板方法 | 内部有大量状态（队列、state），只能是抽象类，子类重写 `tryAcquire` 等钩子 |
| `HttpServlet` | 抽象类模板方法 | `service()` 按 HTTP 方法分派到 `doGet/doPost` |
| `WebMvcConfigurer` | 接口 + 全部 default 方法 | Spring 5 起取代已废弃的 `WebMvcConfigurerAdapter` |
| `HandlerInterceptor` | 接口 + default 方法 | Spring 5.3 废弃 `HandlerInterceptorAdapter` |
| `AbstractApplicationContext.refresh()` | 抽象类模板方法 | 固定启动流程，子类重写 `refreshBeanFactory` 等步骤 |

经验法则：**对外暴露的扩展点优先用接口**（便于代理、组合、多实现）；需要共享状态或固定流程骨架时，提供一个可选的抽象基类。

## 生产实践与踩坑

### 接口加抽象方法导致 `AbstractMethodError`

公共库给接口新增抽象方法后发布，依赖方未重新编译的实现类在运行时被调用到该方法时抛 `AbstractMethodError`。SPI 扩展接口（JDBC 驱动、日志门面、RPC Filter）尤其常见。规范：已发布接口新增方法一律用 default 方法并给出合理默认实现。

### 常量接口反模式

把常量放进接口然后让类 `implements` 它以省略前缀，会把实现细节泄漏到类的公共 API 中，且编译期常量被内联到所有使用方，修改后依赖方不重新编译仍是旧值。用 `final class` + 私有构造器，或 enum。

### JDK 动态代理与 default 方法

JDK `Proxy` 会把 default 方法调用也转给 `InvocationHandler`。在 handler 里想「直接执行接口的默认实现」时，JDK 16 之前需要借助 `MethodHandles.privateLookupIn` 等反射黑魔法，JDK 16 起可用 `InvocationHandler.invokeDefault(proxy, method, args)`。MyBatis 的 `MapperProxy` 就专门区分了 default 方法：直接执行接口默认实现，而不是当作 SQL 映射方法。

### 函数式接口与序列化

lambda 默认不可序列化；把 lambda 存进需要序列化的对象（分布式缓存、Spark/Flink 算子）时要让目标类型同时实现 `Serializable`（如 `(Runnable & Serializable) () -> ...`），并注意捕获的变量也必须可序列化。

## 相关阅读

- [继承与多态](#/java/oop/inherit)：继承与多态
- [创建型模式](#/java/patterns/creational)：设计模式
- [DDD 战术设计：聚合、实体与领域事件（Java 落地）](#/design/ddd-tactical)：仓储接口与依赖倒置

## 面试追问

> [!QUESTION] JDK 8 为什么要给接口加 default 方法？
> 为了在不破坏已有实现类的前提下演进接口，最直接的动机是给 `Collection` 加 `stream()`、`removeIf`，给 `Iterable` 加 `forEach`。否则所有第三方集合实现都要修改。

> [!QUESTION] 一个类实现的两个接口有同名 default 方法，会怎样？
> 若二者无继承关系，编译失败，必须在类中重写并可用 `I.super.m()` 选择；若一个接口继承了另一个并覆盖了该方法，子接口的版本优先；若父类有同签名具体方法，父类优先。

> [!QUESTION] 接口和抽象类怎么选？
> 契约、能力、需要多实现或动态代理时用接口；需要共享状态、构造参数、固定流程骨架（模板方法）时用抽象类。框架中常组合使用：接口作为 API，抽象类作为可选的骨架实现。

> [!QUESTION] sealed 类解决什么问题？和 final 有什么不同？
> final 完全禁止继承，sealed 精确列出允许的子类型。它让类型层次成为封闭集合，编译器据此对模式匹配 switch 做穷举检查，同时库作者可以控制扩展点而不必把整棵层次暴露给外部。

> [!QUESTION] 函数式接口中可以有多个方法吗？
> 可以有任意多个 default、static、private 方法以及 `Object` 公共方法的重新声明，但抽象方法只能有一个。
