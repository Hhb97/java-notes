---
level: 基础
tags: [enum, EnumSet, EnumMap, 枚举单例, record, 序列化]
summary: 枚举与 record 编译后的真实结构，EnumSet 位向量与 EnumMap 实现，枚举单例为何能防反射和反序列化，以及持久化、跨服务传输中的坑
---

# 枚举与记录类

> [!ABSTRACT] 核心要点
> - `enum` 编译后是继承 `java.lang.Enum` 的类：每个常量是一个 `public static final` 字段，在 `<clinit>` 中构造；`values()` 每次返回 `$VALUES` 的克隆。
> - `EnumSet` 用位向量实现（≤64 个常量时就是一个 `long`），`EnumMap` 用以 ordinal 为下标的数组实现，性能远超 `HashSet/HashMap`。
> - 枚举单例天然防反射（`Constructor.newInstance` 对枚举直接抛异常）和防反序列化（序列化只写名字，读取时用 `valueOf` 找回原常量）。
> - 不要持久化 `ordinal()`（JPA `@Enumerated` 默认就是 ORDINAL）；不要用枚举的 `hashCode()` 做跨 JVM 的分片/分区键。
> - `record` 编译为 `final` 类继承 `java.lang.Record`，`equals/hashCode/toString` 通过 `invokedynamic ObjectMethods.bootstrap` 生成；它是**浅不可变**的数据载体，不适合做 JPA 实体。

## 枚举的编译产物

```java
public enum Color {
    RED("r") { @Override String label() { return "红"; } },   // 带方法体的常量
    GREEN("g");
    private final String code;
    Color(String code) { this.code = code; }
    String label() { return code; }
}
```

<figure class="fig">
<svg viewBox="0 0 720 260" class="dg" role="img" aria-label="枚举编译后是继承 java.lang.Enum 的类，常量为静态 final 字段，私有构造器额外接收 name 和 ordinal">
<rect class="b1" x="20" y="20" width="400" height="200" rx="10"/>
<text class="tb" x="36" y="44">class Color extends Enum&lt;Color&gt;</text>
<text class="tm" x="36" y="74">public static final Color RED, GREEN;</text>
<text class="tm" x="36" y="98">private static final Color[] $VALUES;</text>
<text class="tm" x="36" y="122">private Color(String name, int ord, String code)</text>
<text class="tm" x="36" y="146">public static Color[] values()</text>
<text class="tm" x="36" y="170">public static Color valueOf(String)</text>
<text class="tm" x="36" y="194">static { RED = new Color$1("RED", 0, "r"); … }</text>
<line class="l" x1="420" y1="86" x2="480" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="450" y="78" text-anchor="middle">extends</text>
<rect class="b2" x="480" y="20" width="220" height="132" rx="10"/>
<text class="tb" x="496" y="44">java.lang.Enum&lt;E&gt;</text>
<text class="tm" x="496" y="72">final String name</text>
<text class="tm" x="496" y="94">final int ordinal</text>
<text class="tm" x="496" y="116">final compareTo(E)</text>
<text class="tm" x="496" y="138">final clone() 抛异常</text>
<text class="ts" x="480" y="180">values() 每次 clone $VALUES</text>
<text class="ts" x="480" y="198">valueOf → 名称到常量的映射表</text>
<text class="ts" x="480" y="216">常量带方法体 → 匿名子类 Color$1</text>
<text class="ts" x="480" y="234">此时 Color 不再是 final 类</text>
<text class="ts" x="20" y="246">构造器参数 name/ordinal 由编译器追加；没有常量带方法体时 Color 为 final</text>
</svg>
<figcaption>图 1：枚举类编译后的结构（javap -p 可验证）</figcaption>
</figure>

几个由此推出的事实：

- **枚举常量是在 `<clinit>` 中创建的**，所以枚举实例天然单例且线程安全；但在枚举构造器里访问本枚举的其他静态字段会读到 null（此时还没初始化到）。
- **`values()` 每次克隆数组**（防止调用方篡改内部数组）。在高频路径里 `for (Color c : Color.values())` 会持续产生垃圾，可以缓存到 `private static final List<Color> ALL = List.of(values())`。
- `valueOf(String)` 内部走 `Class#enumConstantDirectory()`（懒构建的名称 → 常量 Map），找不到抛 `IllegalArgumentException` 而不是返回 null。
- 枚举的 `equals` 是 `==`，`hashCode` 是 `Object` 的身份哈希，`compareTo` 比较 ordinal，都是 `final`。

## EnumSet 与 EnumMap

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="RegularEnumSet 用一个 long 的各个比特表示集合中是否包含对应 ordinal 的常量">
<text class="ts" x="20" y="30">EnumSet.of(MON, WED, FRI) → RegularEnumSet（常量数 ≤ 64）</text>
<text class="tm" x="20" y="88">long elements</text>
<rect class="b" x="200" y="64" width="60" height="40"/>
<text class="tm" x="230" y="84" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b" x="260" y="64" width="60" height="40"/>
<text class="tm" x="290" y="84" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b2" x="320" y="64" width="60" height="40"/>
<text class="tm" x="350" y="84" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b" x="380" y="64" width="60" height="40"/>
<text class="tm" x="410" y="84" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b2" x="440" y="64" width="60" height="40"/>
<text class="tm" x="470" y="84" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b" x="500" y="64" width="60" height="40"/>
<text class="tm" x="530" y="84" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b2" x="560" y="64" width="60" height="40"/>
<text class="tm" x="590" y="84" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="636" y="88">= 21</text>
<text class="ts" x="230" y="124" text-anchor="middle">SUN</text>
<text class="ts" x="290" y="124" text-anchor="middle">SAT</text>
<text class="ts" x="350" y="124" text-anchor="middle">FRI</text>
<text class="ts" x="410" y="124" text-anchor="middle">THU</text>
<text class="ts" x="470" y="124" text-anchor="middle">WED</text>
<text class="ts" x="530" y="124" text-anchor="middle">TUE</text>
<text class="ts" x="590" y="124" text-anchor="middle">MON</text>
<text class="ts" x="230" y="142" text-anchor="middle">bit 6</text>
<text class="ts" x="590" y="142" text-anchor="middle">bit 0</text>
<text class="tm" x="20" y="172">add: elements |= 1L &lt;&lt; e.ordinal()    contains: (elements &amp; bit) != 0</text>
<text class="ts" x="20" y="192">超过 64 个常量时使用 JumboEnumSet（long[] 位向量）；交并差就是位运算，size() 是 Long.bitCount</text>
</svg>
<figcaption>图 2：RegularEnumSet 的位向量表示</figcaption>
</figure>

```java
// JDK 17 EnumSet.noneOf（节选）
public static <E extends Enum<E>> EnumSet<E> noneOf(Class<E> elementType) {
    Enum<?>[] universe = getUniverse(elementType);   // 共享的 values() 数组
    if (universe.length <= 64)
        return new RegularEnumSet<>(elementType, universe);
    else
        return new JumboEnumSet<>(elementType, universe);
}
```

`EnumMap` 内部是 `Object[] vals`，以 `key.ordinal()` 为下标，`null` 值用一个内部哨兵对象 `NULL` 包装以区分「不存在」。没有哈希计算、没有冲突、没有 Entry 对象，迭代顺序就是枚举声明顺序。

| 容器 | 实现 | 迭代顺序 | 适用 |
| --- | --- | --- | --- |
| `EnumSet` | `long` / `long[]` 位向量 | 声明顺序 | 权限位、状态集合、替代 int 位标志 |
| `EnumMap` | ordinal 下标数组 | 声明顺序 | 状态 → 处理器、按枚举分组计数 |
| `HashMap<Enum, V>` | 哈希表 | 不保证，且依赖身份哈希 | 无理由使用 |

## 枚举的典型用法

```java
// 1. 状态机：把转换规则内聚在枚举中
public enum OrderStatus {
    CREATED { Set<OrderStatus> next() { return EnumSet.of(PAID, CANCELLED); } },
    PAID    { Set<OrderStatus> next() { return EnumSet.of(SHIPPED, REFUNDING); } },
    SHIPPED { Set<OrderStatus> next() { return EnumSet.of(DONE); } },
    REFUNDING, CANCELLED, DONE;
    Set<OrderStatus> next() { return EnumSet.noneOf(OrderStatus.class); }
    public boolean canTransitTo(OrderStatus target) { return next().contains(target); }
}

// 2. 策略：每个常量一个实现（常量特定方法），配合 EnumMap/valueOf 做分派
// 3. 单例：见下文
```

用 code 查枚举时不要每次 `for` 遍历 `values()`，应构建 `Map<String, X>` 索引。注意不能在枚举**构造器**里把自己注册进这个静态 Map——枚举常量的构造先于其他静态字段初始化，此时 Map 还是 null，会抛 NPE。应在静态块中遍历 `values()` 构建，或把 Map 放进静态嵌套类。

## 枚举单例为什么最安全

```java
public enum IdGenerator {
    INSTANCE;
    private final AtomicLong seq = new AtomicLong();
    public long next() { return seq.incrementAndGet(); }
}
```

| 攻击方式 | 普通单例 | 枚举单例 |
| --- | --- | --- |
| 反射调用私有构造器 | 能创建第二个实例（需在构造器内手动防御） | `Constructor.newInstance` 检查 `ENUM` 修饰符，抛 `IllegalArgumentException: Cannot reflectively create enum objects` |
| 序列化/反序列化 | 反序列化创建新对象，需写 `readResolve` | 序列化只写入类名和常量名（`TC_ENUM`），反序列化调用 `Enum.valueOf` 返回已有常量；枚举的 `readObject` 等自定义方法被忽略 |
| clone | 需要不实现 `Cloneable` | `Enum.clone()` 是 final 且直接抛 `CloneNotSupportedException` |

局限：枚举单例无法懒加载（类初始化即创建）、不能继承其他类；需要依赖注入的组件仍然交给 Spring 容器管理更合适。

## record：透明的数据载体

```java
public record Money(long cents, String currency) {
    public Money {                                   // 紧凑构造器：校验/规范化参数
        if (cents < 0) throw new IllegalArgumentException("negative");
        currency = currency.toUpperCase();          // 赋值给参数，最后统一赋给字段
    }
    public Money plus(Money o) { return new Money(cents + o.cents, currency); }
}
```

```text
$ javap -p Money
final class Money extends java.lang.Record {
  private final long cents;
  private final java.lang.String currency;
  Money(long, java.lang.String);                  // 规范构造器
  public final java.lang.String toString();       // invokedynamic ObjectMethods.bootstrap
  public final int hashCode();                    // 同上
  public final boolean equals(java.lang.Object);  // 同上
  public long cents();                            // 访问器，不带 get 前缀
  public java.lang.String currency();
}
```

`toString/equals/hashCode` 不在编译期生成具体代码，而是 `invokedynamic` 到 `java.lang.runtime.ObjectMethods.bootstrap`，运行时根据 class 文件中的 `Record` 属性（分量列表）生成实现——与字符串拼接一样，把策略推迟到运行时，以后 JDK 改进实现无需重新编译。

### record 的限制

| 限制 | 原因 / 影响 |
| --- | --- |
| 隐式 `final`，不能 `extends` | 已经继承 `Record`；可以实现接口（常与 sealed 接口搭配） |
| 不能声明额外实例字段 | 状态必须完全由分量描述，可以有静态字段 |
| 字段 final，但只是**浅不可变** | `record R(List<String> xs)` 的 list 仍可被修改，需在紧凑构造器中 `xs = List.copyOf(xs)` |
| 访问器名为 `x()` 而不是 `getX()` | 老版本 Jackson（< 2.12）、BeanUtils、部分模板引擎识别不了 |
| 不适合 JPA 实体 | 实体需要无参构造、可变字段、可被代理继承；record 适合做 DTO 和查询投影 |

> [!NOTE] 序列化更安全
> record 的反序列化**一定经过规范构造器**，紧凑构造器中的校验会生效；普通类的 Java 反序列化绕过构造器，是很多反序列化漏洞的根源。

## 生产实践与踩坑

### 持久化 ordinal

JPA `@Enumerated` 默认是 `EnumType.ORDINAL`。某次在枚举中间插入一个新状态，所有历史数据的含义整体错位，且不会报错。规范：数据库存**显式的 code**（自定义字段 + `AttributeConverter` / MyBatis `TypeHandler`），或至少 `EnumType.STRING`；任何场景都不要依赖 `ordinal()` 的稳定性。

### 跨服务新增枚举值

上游给枚举加了新常量，下游还没升级：Jackson 反序列化 `InvalidFormatException`，RPC（如 Dubbo Hessian）反序列化也可能报错或得到 null，导致整个请求失败。对策：

- 下游开启 `DeserializationFeature.READ_UNKNOWN_ENUM_VALUES_AS_NULL` 或用 `@JsonEnumDefaultValue` 标注 `UNKNOWN` 常量并开启 `READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE` 兜底；
- 对外接口中的「可扩展取值」用 String/int code 传输，在边界处转换为枚举；
- 发布顺序：先升级消费方（能识别新值），再升级生产方。

### 用枚举的 hashCode 做分区

枚举的 `hashCode()` 是对象身份哈希，**每个 JVM 进程都不同**。用它做 Kafka 分区键、分库路由、Spark/Flink 的 `keyBy`，会导致同一个值在不同实例上被路由到不同分区，结果错乱。应使用 `name().hashCode()` 或 `ordinal()`（仅在进程内）。

### 枚举中的可变状态

枚举是全局单例，给枚举加非 final 的可变字段（如缓存、计数器）等于引入全局可变状态，多线程下需要同步，单元测试之间也会互相污染。

## 面试追问

> [!QUESTION] 枚举的本质是什么？`values()` 方法是哪里来的？
> 编译器生成的继承 `java.lang.Enum` 的类，常量是在 `<clinit>` 中创建的静态 final 实例；`values()` 和 `valueOf(String)` 是编译器合成的静态方法，前者返回 `$VALUES.clone()`。

> [!QUESTION] 为什么说枚举是实现单例的最佳方式？
> JVM 保证类初始化的线程安全，常量只创建一次；反射创建枚举实例被 `Constructor.newInstance` 明确禁止；序列化只记录名字，反序列化用 `valueOf` 找回同一个实例；`clone` 被禁止。

> [!QUESTION] EnumSet 为什么高效？
> 底层是位向量：≤64 个常量时就是一个 long，增删查是一次位运算，集合运算是按位与/或，`size` 是 `bitCount`；无哈希、无装箱、无节点对象。

> [!QUESTION] record 和 Lombok `@Value` 有什么区别？
> record 是语言特性：编译器保证结构、`Record` 属性可被反射和模式匹配解构，反序列化走规范构造器，`equals` 等由运行时引导方法生成；`@Value` 是注解处理器生成的普通 final 类，可以有 getter 命名、继承控制等更多自定义，但没有解构模式等语言级支持。

> [!QUESTION] 为什么 JPA 实体不能用 record？
> 实体需要无参构造器供框架实例化、可变字段供脏检查和懒加载回填、可被继承以生成代理；record 字段 final、不可继承、只有规范构造器。record 适合作为查询投影和 DTO。
