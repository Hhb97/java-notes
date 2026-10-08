---
level: 基础
tags: [对象创建, clinit, init, 初始化顺序, equals, hashCode, 内部类]
summary: 从 new 指令到 <clinit>/<init> 讲清对象创建与初始化顺序，以及类初始化死锁、equals/hashCode 契约、内部类泄漏等生产问题
---

# 类与对象

> [!ABSTRACT] 核心要点
> - `new Foo()` 编译为 `new → dup → invokespecial <init>`：JVM 先分配并清零内存、设置对象头，再执行 `<init>`；所以字段在构造器运行前就已有零值。
> - 类初始化 `<clinit>` 只执行一次、由 JVM 加锁保证线程安全（静态内部类单例的基础），但也因此可能**类初始化死锁**，且失败后该类永久不可用（`NoClassDefFoundError: Could not initialize class`）。
> - 初始化顺序：父类 `<clinit>` → 子类 `<clinit>` → 父类字段初始化/实例块/构造体 → 子类字段初始化/实例块/构造体；父构造器中调用可被重写的方法会看到子类字段的零值。
> - `equals` 相等则 `hashCode` 必须相等；作为 HashMap key 的对象，参与哈希的字段不可变。
> - 非静态内部类、匿名类隐式持有外部类引用 `this$0`，是长生命周期回调造成内存泄漏的常见根源。

## 对象是怎么被创建出来的

### new 指令的执行步骤

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="new 指令执行的五个步骤：类加载检查、分配内存、零值初始化、设置对象头、执行构造方法">
<text class="tm" x="20" y="30">new #2 → dup → invokespecial Foo.&lt;init&gt; → astore_1</text>
<rect class="b1" x="20" y="60" width="124" height="52" rx="8"/>
<text class="tb" x="82" y="86" text-anchor="middle" dominant-baseline="middle">① 类加载检查</text>
<line class="l" x1="144" y1="86" x2="164" y2="86" marker-end="url(#arr)"/>
<rect class="b2" x="164" y="60" width="124" height="52" rx="8"/>
<text class="tb" x="226" y="86" text-anchor="middle" dominant-baseline="middle">② 分配内存</text>
<line class="l" x1="288" y1="86" x2="308" y2="86" marker-end="url(#arr)"/>
<rect class="b3" x="308" y="60" width="124" height="52" rx="8"/>
<text class="tb" x="370" y="86" text-anchor="middle" dominant-baseline="middle">③ 零值初始化</text>
<line class="l" x1="432" y1="86" x2="452" y2="86" marker-end="url(#arr)"/>
<rect class="b3" x="452" y="60" width="124" height="52" rx="8"/>
<text class="tb" x="514" y="86" text-anchor="middle" dominant-baseline="middle">④ 设置对象头</text>
<line class="la" x1="576" y1="86" x2="596" y2="86" marker-end="url(#arr-a)"/>
<rect class="b4" x="596" y="60" width="124" height="52" rx="8"/>
<text class="tb" x="658" y="86" text-anchor="middle" dominant-baseline="middle">⑤ 执行 &lt;init&gt;</text>
<text class="ts" x="82" y="134" text-anchor="middle">常量池符号引用</text>
<text class="ts" x="82" y="152" text-anchor="middle">未加载则先加载、</text>
<text class="ts" x="82" y="170" text-anchor="middle">链接、初始化</text>
<text class="ts" x="226" y="134" text-anchor="middle">优先 TLAB 指针碰撞</text>
<text class="ts" x="226" y="152" text-anchor="middle">TLAB 不够再 CAS</text>
<text class="ts" x="226" y="170" text-anchor="middle">分配到 Eden</text>
<text class="ts" x="370" y="134" text-anchor="middle">实例字段全部清零</text>
<text class="ts" x="370" y="152" text-anchor="middle">字段默认值的由来</text>
<text class="ts" x="514" y="134" text-anchor="middle">Mark Word：哈希、</text>
<text class="ts" x="514" y="152" text-anchor="middle">锁、GC 年龄</text>
<text class="ts" x="514" y="170" text-anchor="middle">Klass 指针</text>
<text class="ts" x="658" y="134" text-anchor="middle">super() → 字段初始化</text>
<text class="ts" x="658" y="152" text-anchor="middle">→ 实例块 → 构造体</text>
<rect class="bg" x="20" y="190" width="556" height="30" rx="6"/>
<text class="ts" x="298" y="205" text-anchor="middle" dominant-baseline="middle">①～④ 由 JVM 完成，此时对象已「存在」但尚未初始化，引用若逃逸就是半初始化对象</text>
</svg>
<figcaption>图 1：new 指令背后的对象创建流程</figcaption>
</figure>

为什么字节码里有个 `dup`？`invokespecial <init>` 会消耗栈顶的对象引用（构造方法是 void 实例方法，`this` 作为参数出栈），所以需要先复制一份，留给后续的 `astore` 使用。

步骤 ④ 和 ⑤ 之间、以及 ⑤ 与「把引用赋值给共享变量」之间，在没有同步的情况下可能被重排序，这就是双重检查锁单例必须加 `volatile` 的原因，见 [创建型模式](#/java/patterns/creational) 与 [Java 内存模型与 volatile](#/java/concurrency/jmm)。对象头与字段布局细节见 [运行时数据区与对象模型](#/java/jvm/memory)。

### 创建对象的其他方式

| 方式 | 是否调用构造器 | 说明 |
| --- | --- | --- |
| `new` | 是 | 最常见 |
| `Constructor.newInstance` / `MethodHandle` | 是 | 框架实例化 Bean 的方式 |
| `clone()` | 否 | 按字段浅复制，需实现 `Cloneable` |
| Java 反序列化 | 否（调用第一个非 Serializable 父类的无参构造） | 构造器里的校验逻辑被绕过，安全隐患的来源 |
| `Unsafe.allocateInstance` | 否 | Objenesis（Mockito、Spring CGLIB 代理）用它创建对象 |

## 初始化顺序：`<clinit>` 与 `<init>`

javac 会把**所有静态字段赋值和 static 块**按源码顺序合并成 `<clinit>`；把**实例字段初始化器和实例初始化块**按源码顺序合并后，插入到每个构造器的 `super(...)` 调用之后，形成 `<init>`。

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="父子类初始化顺序：先父类和子类的 clinit，再在每次 new 时依次执行父类 init 和子类 init">
<rect class="bg" x="20" y="20" width="230" height="260" rx="12"/>
<text class="ts" x="34" y="40">类初始化（每个类只一次）</text>
<rect class="b5" x="36" y="60" width="198" height="56" rx="8"/>
<text class="tb" x="135" y="80" text-anchor="middle" dominant-baseline="middle">① Parent.&lt;clinit&gt;</text>
<text class="ts" x="135" y="102" text-anchor="middle">静态字段 + static 块</text>
<line class="l" x1="135" y1="116" x2="135" y2="150" marker-end="url(#arr)"/>
<rect class="b5" x="36" y="150" width="198" height="56" rx="8"/>
<text class="tb" x="135" y="170" text-anchor="middle" dominant-baseline="middle">② Child.&lt;clinit&gt;</text>
<text class="ts" x="135" y="192" text-anchor="middle">按源码顺序执行</text>
<text class="ts" x="135" y="234" text-anchor="middle">首次主动使用时触发</text>
<text class="ts" x="135" y="252" text-anchor="middle">JVM 加锁，线程安全</text>
<line class="la" x1="234" y1="178" x2="290" y2="72" marker-end="url(#arr-a)"/>
<rect class="bg" x="270" y="20" width="430" height="260" rx="12"/>
<text class="ts" x="284" y="40">每次 new Child()</text>
<rect class="b1" x="290" y="50" width="390" height="44" rx="8"/>
<text class="tb" x="485" y="72" text-anchor="middle" dominant-baseline="middle">③ Child.&lt;init&gt; 第一条：invokespecial Parent.&lt;init&gt;</text>
<line class="l" x1="485" y1="94" x2="485" y2="108" marker-end="url(#arr)"/>
<rect class="b3" x="290" y="108" width="390" height="44" rx="8"/>
<text class="tb" x="485" y="130" text-anchor="middle" dominant-baseline="middle">④ Parent：字段初始化器 + 实例块 → 构造体</text>
<line class="l" x1="485" y1="152" x2="485" y2="166" marker-end="url(#arr)"/>
<rect class="b2" x="290" y="166" width="390" height="44" rx="8"/>
<text class="tb" x="485" y="188" text-anchor="middle" dominant-baseline="middle">⑤ Child：字段初始化器 + 实例块（源码顺序）</text>
<line class="l" x1="485" y1="210" x2="485" y2="224" marker-end="url(#arr)"/>
<rect class="b2" x="290" y="224" width="390" height="44" rx="8"/>
<text class="tb" x="485" y="246" text-anchor="middle" dominant-baseline="middle">⑥ Child 构造体中 super() 之后的语句</text>
</svg>
<figcaption>图 2：父子类的类初始化与实例初始化顺序</figcaption>
</figure>

### 父构造器调用可重写方法的陷阱

```java
class Parent {
    Parent() { init(); }             // 在 ④ 阶段执行
    void init() { }
}
class Child extends Parent {
    private final List<String> names = new ArrayList<>();   // ⑤ 阶段才赋值
    private int size = 10;                                    // ⑤ 阶段才赋值
    @Override void init() {
        System.out.println(size + " " + names);   // 输出 "0 null"，names.add() 则 NPE
    }
}
```

`init()` 是虚方法，`Parent` 构造器里调用时已经动态分派到 `Child.init()`，而子类字段还停留在步骤 ③ 的零值。注意 `private final int size = 10;` 会输出 10——因为常量变量在编译期被内联了，这让问题更隐蔽。规则：**构造器中只调用 private / final / static 方法**。

> [!NOTE] JDK 25：灵活的构造器体
> JEP 513 允许在 `super(...)` 之前写不访问 `this` 的语句（参数校验、准备参数），并允许在调用 super 之前给本类字段赋值，从语言层面缓解了上面的问题。

### 什么时候触发类初始化

**主动使用**才会触发 `<clinit>`：`new`、读写非常量静态字段（`getstatic/putstatic`）、调用静态方法、反射 `Class.forName`（默认初始化）、子类初始化时先初始化父类、main 类、首次调用 `MethodHandle` 解析到的静态成员。

不会触发的典型情况：

```java
int x = Config.MAX;          // static final 编译期常量，已被内联到调用方常量池
Config[] arr = new Config[10];   // 只创建数组类 [LConfig;
int y = Child.parentField;   // 通过子类访问父类静态字段，只初始化 Parent
Class<?> c = Config.class;   // 获取 Class 对象不触发
ClassLoader.getSystemClassLoader().loadClass("Config");  // 只加载不初始化
```

第一条有一个生产隐患：修改了某个 jar 中的 `public static final` 常量，**依赖方不重新编译就仍然使用旧值**。跨模块共享的配置常量不要用编译期常量，可改为通过方法返回。类加载过程详见 [类加载与双亲委派](#/java/jvm/classloader)。

## equals 与 hashCode

### 契约

- `equals`：自反、对称、传递、一致、与 null 比较返回 false。
- `hashCode`：`a.equals(b)` ⇒ `a.hashCode() == b.hashCode()`；反之不要求，但冲突越少散列容器越快。
- 重写 `equals` 必须同时重写 `hashCode`，否则 `HashSet` 中会出现两个「相等」的元素。

```java
// 推荐写法（或直接用 record 自动生成）
@Override public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Point p)) return false;     // JDK 16 模式匹配
    return x == p.x && y == p.y;
}
@Override public int hashCode() { return 31 * Integer.hashCode(x) + Integer.hashCode(y); }
```

### `getClass()` 还是 `instanceof`

| 写法 | 优点 | 缺点 |
| --- | --- | --- |
| `getClass() != o.getClass()` | 子类与父类永不相等，对称性有保证 | 遇到代理/子类（Hibernate 懒加载代理、CGLIB 子类）时与原对象不相等 |
| `instanceof` | 兼容代理、子类 | 子类若增加参与比较的字段，会破坏对称性；应把类或 equals 声明为 final |

JPA 实体推荐 `instanceof` + 只比较业务主键（或 ID 非空时比较 ID），并让 `hashCode` 返回常量或基于不可变业务键。

## 内部类的编译产物

```java
public class Outer {
    private int count;
    class Inner { void inc() { count++; } }               // 非静态内部类
    static class Nested { }                                // 静态嵌套类
    Runnable task(int n) { return () -> System.out.println(n); }
    Runnable anon(int n) { return new Runnable() { public void run() { System.out.println(n + count); } }; }
}
```

| 形式 | 编译产物 | 持有外部实例？ |
| --- | --- | --- |
| 非静态内部类 | `Outer$Inner.class`，合成字段 `final Outer this$0` | 是 |
| 静态嵌套类 | `Outer$Nested.class` | 否 |
| 匿名内部类 | `Outer$1.class`，捕获的局部变量复制为 `val$n` 字段 | 是（在实例方法中定义时） |
| Lambda | 无独立 class 文件，运行时生成；不引用 `this` 时不捕获外部实例 | 仅当方法体用到 `this`/实例成员 |

- 局部变量必须 effectively final，是因为它被**复制**进了内部类的字段；如果允许修改，两份拷贝就会不一致。
- JDK 11 之前，内部类访问外部类 `private` 成员需要编译器生成 `access$000` 桥接静态方法；JDK 11 起引入 nestmates（JEP 181），同一嵌套组内可直接访问私有成员。

## 生产实践与踩坑

### `NoClassDefFoundError: Could not initialize class`

现象：服务启动后某接口第一次报 `ExceptionInInitializerError`，之后每次都报 `NoClassDefFoundError: Could not initialize class com.xx.XxxUtil`，看起来像是类找不到。真相：该类 `<clinit>` 第一次执行抛了异常（静态块里读取配置失败、静态字段初始化 NPE），JVM 将其标记为**初始化失败的错误状态，永不重试**。排查时一定要往前翻日志找第一次的 `ExceptionInInitializerError` 及其 cause。修复：静态初始化中不要做 IO/远程调用等可能失败的操作，改为懒加载并处理异常。

### 类初始化死锁

```java
class A { static final B B_REF = new B(); }   // A 的 <clinit> 需要初始化 B
class B { static final A A_REF = new A(); }   // B 的 <clinit> 需要初始化 A
// 线程 1 首次访问 A、线程 2 同时首次访问 B → 互相等待对方的初始化锁
```

`jstack` 中两个线程都处于 `RUNNABLE`（不是 BLOCKED！），栈顶停在 `<clinit>`，且 JDK 较新版本会标注 `waiting on the Class initialization monitor`。这类死锁在启动并发预热、多个线程同时加载插件时最常见。修复：消除静态初始化中的循环依赖。

### Lombok `@Data` 用在实体上

`@Data` 会生成基于所有字段的 `equals/hashCode/toString`：实体之间双向关联时 `toString`/`hashCode` 相互递归导致 `StackOverflowError`；懒加载集合被 `toString` 触发查询（N+1）；实体放进 `HashSet` 后修改字段，`hashCode` 变了再也 `remove` 不掉。实体类用 `@Getter/@Setter` + 手写或 `@EqualsAndHashCode(onlyExplicitlyIncluded = true)`。

### 匿名内部类导致内存泄漏

把匿名内部类/非静态内部类实例注册到生命周期更长的对象上（全局事件总线、静态缓存、线程池中长期运行的任务），会通过 `this$0` 把整个外部对象（可能持有大量数据）一起钉在内存里。堆 dump 中看 GC Root 引用链出现 `this$0` 即可定位。改为静态嵌套类 + 显式传入需要的字段，或使用弱引用。

## 面试追问

> [!QUESTION] 一个对象的创建过程是怎样的？
> 类加载检查 → 分配内存（TLAB 指针碰撞或 CAS，空闲列表取决于 GC）→ 内存清零 → 设置对象头（Mark Word、Klass 指针）→ 执行 `<init>`（super 构造、字段初始化器、实例块、构造体）。前四步由 JVM 完成，第五步是 Java 代码。

> [!QUESTION] 静态内部类单例为什么是线程安全且懒加载的？
> `Holder` 类只在首次调用 `getInstance()` 读其静态字段时才初始化；JVM 规范保证 `<clinit>` 在多线程下只执行一次并对其他线程可见（初始化锁 + happens-before），无需 volatile 和 synchronized。

> [!QUESTION] 为什么不能在构造器中调用可重写的方法？
> 虚方法会动态分派到子类实现，而此时子类的字段初始化器还没执行，子类看到的是零值，常导致 NPE 或错误状态；同理也不要在构造器中把 `this` 发布给其他线程。

> [!QUESTION] 只重写 equals 不重写 hashCode 会怎样？
> 两个相等对象哈希不同，会落入 HashMap 的不同桶，`put` 两次得到两个条目、`get` 用另一个相等对象查不到，`HashSet` 去重失效。

> [!QUESTION] 线上报 `NoClassDefFoundError`，但 jar 包里明明有这个类，可能是什么原因？
> 除了真缺类/类加载器隔离问题外，最常见是 `Could not initialize class`：类的静态初始化曾经失败过，JVM 不再重试。需要找到首次出现的 `ExceptionInInitializerError` 根因。
