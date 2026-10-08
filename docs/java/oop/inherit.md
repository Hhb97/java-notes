---
level: 基础
tags: [继承, 多态, 动态分派, vtable, invokevirtual, 内联缓存, 桥方法]
summary: 从 invoke 指令、虚方法表和 JIT 内联缓存理解多态的实现，以及重载/重写的边界、桥方法和继承带来的设计问题
---

# 继承与多态

> [!ABSTRACT] 核心要点
> - **重载是静态分派**（编译期按参数的静态类型选定方法签名），**重写是动态分派**（运行期按接收者的实际类型选实现）。
> - 5 条调用指令：`invokestatic`、`invokespecial`（构造器、super 调用）、`invokevirtual`、`invokeinterface`、`invokedynamic`；只有后三者可能需要运行期分派。
> - HotSpot 用**虚方法表 vtable** 实现 `invokevirtual`：子类继承父类的表，重写的方法在**同一下标**替换实现，新方法追加在末尾，调用只需「取 klass → 按下标取方法」。
> - JIT 通过类层次分析（CHA）和**内联缓存**把单态/双态调用点内联掉；超过两种接收者类型的「超多态」调用点无法内联，是热点路径的隐形性能杀手。
> - 字段和静态方法没有多态；优先组合而非继承，`final` 方法在 Spring CGLIB 代理下不会被拦截。

## 重载与重写：两种分派

```java
class Animal { void speak() { System.out.println("..."); } }
class Dog extends Animal { @Override void speak() { System.out.println("汪"); } }

class Printer {
    void print(Animal a) { System.out.println("animal"); }
    void print(Dog d)    { System.out.println("dog"); }
}

Animal a = new Dog();
a.speak();                    // 汪：重写，运行期按实际类型 Dog
new Printer().print(a);       // animal：重载，编译期按静态类型 Animal 选定 print(Animal)
```

| 维度 | 重载 Overload | 重写 Override |
| --- | --- | --- |
| 决定时机 | 编译期（静态分派） | 运行期（动态分派） |
| 依据 | 方法名 + 参数的**静态类型** | 接收者的**实际类型** |
| 字节码体现 | 常量池中方法描述符已确定 | 同一个描述符，运行时选择实现 |
| 返回值 | 不参与区分 | 可协变（子类型），编译器生成桥方法 |
| 异常 | 无约束 | 不能抛出更宽的受检异常 |
| 访问权限 | 无约束 | 不能更严格 |

重载解析的优先级：精确匹配 → 基本类型拓宽 → 自动装箱/拆箱 → 可变参数。所以 `print(null)` 在上面会选 `print(Dog)`（更具体的类型），而如果再加一个 `print(String)` 就会因二义性编译失败。

> [!WARNING] 字段和静态方法没有多态
> `Animal a = new Dog(); a.name` 访问的是 `Animal` 中声明的字段（字段按静态类型解析，`getfield Animal.name`）；子类同名字段只是「隐藏」。静态方法同理，`a.staticMethod()` 实际编译为 `invokestatic Animal.staticMethod`。

## 调用指令

| 指令 | 用途 | 分派 |
| --- | --- | --- |
| `invokestatic` | 静态方法 | 无，链接时确定 |
| `invokespecial` | 构造器 `<init>`、`super.xxx()`、（JDK 11 前）private 方法 | 无 |
| `invokevirtual` | 类中的实例方法；JDK 11 起 javac 对 private 方法也用它 | vtable；final/private 方法不需查表 |
| `invokeinterface` | 通过接口类型调用 | itable 查找 |
| `invokedynamic` | Lambda、字符串拼接、模式匹配 switch、record 的 toString 等 | 由引导方法返回的 CallSite 决定 |

`super.speak()` 之所以必须用 `invokespecial`：如果用 `invokevirtual`，会再次分派到当前对象的实际类型（子类自己），造成无限递归。

## 虚方法表

<figure class="fig">
<svg viewBox="0 0 720 280" class="dg" role="img" aria-label="Dog 继承 Animal 的虚方法表，重写的 speak 在相同下标被替换，新方法 fetch 追加在末尾；调用时通过对象头的 Klass 指针找到 vtable">
<rect class="b" x="20" y="36" width="140" height="90" rx="8"/>
<text class="tb" x="90" y="56" text-anchor="middle" dominant-baseline="middle">Dog 实例</text>
<text class="tm" x="90" y="84" text-anchor="middle" dominant-baseline="middle">Mark Word</text>
<text class="tm" x="90" y="108" text-anchor="middle" dominant-baseline="middle">Klass*</text>
<line class="la" x1="160" y1="108" x2="220" y2="52" marker-end="url(#arr-a)"/>
<text class="tm" x="20" y="152">Animal a = new Dog()</text>
<rect class="b1" x="220" y="36" width="210" height="28" rx="4"/>
<text class="tb" x="325" y="50" text-anchor="middle" dominant-baseline="middle">Dog 的 vtable</text>
<rect class="b" x="220" y="64" width="210" height="34"/>
<text class="tm" x="232" y="81" dominant-baseline="middle">[0-4] Object 的方法</text>
<rect class="b" x="220" y="98" width="210" height="34"/>
<text class="tm" x="232" y="115" dominant-baseline="middle">[5] Animal.eat</text>
<rect class="b4" x="220" y="132" width="210" height="34"/>
<text class="tm" x="232" y="149" dominant-baseline="middle">[6] Dog.speak</text>
<rect class="b2" x="220" y="166" width="210" height="34"/>
<text class="tm" x="232" y="183" dominant-baseline="middle">[7] Dog.fetch</text>
<text class="ts" x="325" y="220" text-anchor="middle">新方法追加在末尾</text>
<rect class="b1" x="480" y="36" width="210" height="28" rx="4"/>
<text class="tb" x="585" y="50" text-anchor="middle" dominant-baseline="middle">Animal 的 vtable</text>
<rect class="b" x="480" y="64" width="210" height="34"/>
<text class="tm" x="492" y="81" dominant-baseline="middle">[0-4] Object 的方法</text>
<rect class="b" x="480" y="98" width="210" height="34"/>
<text class="tm" x="492" y="115" dominant-baseline="middle">[5] Animal.eat</text>
<rect class="b" x="480" y="132" width="210" height="34"/>
<text class="tm" x="492" y="149" dominant-baseline="middle">[6] Animal.speak</text>
<line class="ld" x1="430" y1="149" x2="480" y2="149"/>
<text class="ts" x="585" y="190" text-anchor="middle">speak 在父子表中下标相同</text>
<text class="ts" x="585" y="208" text-anchor="middle">重写 = 替换该槽位的实现</text>
<text class="tm" x="20" y="250">a.speak() → invokevirtual Animal.speak:()V → 链接时解析为 vtable 下标 6</text>
<text class="tm" x="20" y="270">运行时：obj → Klass* → vtable[6] → Dog.speak()</text>
</svg>
<figcaption>图 1：虚方法表的继承与覆盖</figcaption>
</figure>

- vtable 只包含可被重写的方法：`private`、`static`、构造器不进 vtable；`final` 方法如果没有覆盖父类方法，也不需要新槽位。
- 接口方法没法用固定下标（一个类可以实现任意多个接口，不同类中同一接口方法的位置不同），所以 `invokeinterface` 要先在 **itable** 中找到对应接口的方法表段再取方法，比 vtable 多一步查找。
- 这只是**解释执行**和未优化时的路径，热点代码的真实开销取决于 JIT。

## JIT 视角：CHA 与内联缓存

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="内联缓存三种状态：单态直接内联，双态内联两份，超多态退化为查表间接调用">
<text class="ts" x="20" y="28">C2 根据调用点 profile 中收集到的接收者类型数量决定如何优化</text>
<rect class="b2" x="20" y="56" width="200" height="80" rx="8"/>
<text class="tb" x="120" y="78" text-anchor="middle" dominant-baseline="middle">单态 Monomorphic</text>
<text class="ts" x="120" y="102" text-anchor="middle">一次类型比较</text>
<text class="ts" x="120" y="120" text-anchor="middle">命中则执行内联代码</text>
<line class="l" x1="220" y1="96" x2="260" y2="96" marker-end="url(#arr)"/>
<text class="ts" x="240" y="150" text-anchor="middle">第 2 种类型</text>
<rect class="b3" x="260" y="56" width="200" height="80" rx="8"/>
<text class="tb" x="360" y="78" text-anchor="middle" dominant-baseline="middle">双态 Bimorphic</text>
<text class="ts" x="360" y="102" text-anchor="middle">两次类型比较</text>
<text class="ts" x="360" y="120" text-anchor="middle">两份实现都可内联</text>
<line class="la" x1="460" y1="96" x2="500" y2="96" marker-end="url(#arr-a)"/>
<text class="ts" x="480" y="150" text-anchor="middle">第 3 种类型</text>
<rect class="b4" x="500" y="56" width="200" height="80" rx="8"/>
<text class="tb" x="600" y="78" text-anchor="middle" dominant-baseline="middle">超多态 Megamorphic</text>
<text class="ts" x="600" y="102" text-anchor="middle">vtable / itable 间接调用</text>
<text class="ts" x="600" y="120" text-anchor="middle">无法内联</text>
<text class="ts" x="360" y="182" text-anchor="middle">类型假设被新加载的子类打破时触发去优化，回到解释执行重新收集 profile</text>
</svg>
<figcaption>图 2：调用点的内联缓存状态</figcaption>
</figure>

- **CHA（类层次分析）**：如果加载的类中 `Animal.speak()` 只有一个实现，JIT 直接把调用当成静态调用内联，并登记依赖；一旦加载了新的子类重写它，依赖失效，相关编译代码被去优化。所以「给方法加 `final` 提升性能」在现代 JVM 上基本是迷信。
- **内联是所有优化之母**：内联后才能做逃逸分析、标量替换、锁消除、常量传播。超多态调用点阻断内联，连带这些优化一起失效。
- 典型超多态场景：通用框架的拦截器链、`Stream` 中被多种 lambda 共享的 `Sink.accept`、序列化框架里对 `Object` 字段的处理。

## 协变返回类型与桥方法

```java
class A { A get() { return this; } }
class B extends A { @Override B get() { return this; } }   // 协变返回
```

```text
$ javap -p B
class B extends A {
  B get();      // 你写的方法
  A get();      // 编译器生成的桥方法：ACC_BRIDGE | ACC_SYNTHETIC，内部调用 B get()
}
```

JVM 层面方法签名包含返回类型，`B get()` 与 `A get()` 是两个方法，不生成桥方法就无法覆盖父类 vtable 中 `A get()` 的槽位。泛型擦除后的重写同理（`compareTo(Object)` 桥接到 `compareTo(T)`），见 [泛型与类型擦除](#/java/api/generics)。反射遍历方法时用 `Method.isBridge()` 过滤，Spring 的 `BridgeMethodResolver` 就是在处理这个问题——否则注解可能读不到。

## 继承 vs 组合

继承打破了封装：子类依赖父类的**实现细节**，而不仅是接口。经典例子（《Effective Java》）：

```java
class CountingSet<E> extends HashSet<E> {
    int added = 0;
    @Override public boolean add(E e) { added++; return super.add(e); }
    @Override public boolean addAll(Collection<? extends E> c) { added += c.size(); return super.addAll(c); }
}
// addAll 3 个元素后 added == 6：HashSet.addAll 内部调用了 add（自用性）
```

| 维度 | 继承 | 组合 / 委托 |
| --- | --- | --- |
| 复用方式 | 白盒，依赖父类实现 | 黑盒，只依赖公开接口 |
| 灵活性 | 编译期固定 | 运行时可替换（策略、装饰器） |
| 风险 | 脆弱基类：父类改动悄悄破坏子类 | 需要写转发代码 |
| 适用 | 真正的 is-a、框架提供的模板方法扩展点 | 绝大多数业务复用 |

设计为可继承的类要在文档里写清「自用性」（哪些方法调用了哪些可重写方法），否则就声明为 `final` 或用 `sealed` 限定子类，见 [接口与抽象类](#/java/oop/interface)。

## 生产实践与踩坑

### final 方法与 Spring CGLIB 代理

Spring 对没有接口的 Bean（或 Spring Boot 默认 `proxyTargetClass=true`）用 CGLIB 生成**子类**代理。`final` 方法无法被重写，于是：

- `@Transactional` / `@Cacheable` 标注在 `final` 方法上**静默失效**；
- 更隐蔽的是：代理对象是通过 Objenesis 创建的，不调用构造器，其字段全为 null。调用 `final` 方法时直接执行在代理对象上（而不是目标对象），方法里访问注入的字段就 NPE。

Kotlin 类默认 final，需要 `kotlin-spring`（all-open）插件。详见 [AOP 与代理机制](#/spring/aop)。

### 父类新增方法与子类「意外重写」

依赖库升级后父类新增了一个与子类已有方法同签名的方法，子类方法就变成了重写，行为被悄悄改变；反之如果子类方法签名不同（返回类型不兼容），会导致编译失败或 `AbstractMethodError`/`IncompatibleClassChangeError`（不重新编译时）。始终加 `@Override` 能让编译器帮你发现第一类问题。

### 热点路径的超多态调用

压测发现某个通用处理器 CPU 占比很高、火焰图里有大量 `itable stub` / `vtable stub`。原因是一个调用点有多种实现轮流出现。优化手段：按类型拆分调用点（让每个调用点保持单态）、减少中间抽象层、对最常见的类型做 `instanceof` 快速路径。用 `-XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining` 可以看到 `virtual call` / `megamorphic` 的内联失败原因。

## 面试追问

> [!QUESTION] 重载和重写分别在什么时候确定调用哪个方法？
> 重载在编译期按参数静态类型选定方法描述符，写入常量池；重写在运行期由 `invokevirtual/invokeinterface` 按接收者实际类型分派。所以 `print(animalRefPointingToDog)` 仍选 `print(Animal)`。

> [!QUESTION] JVM 是如何实现动态分派的？
> 每个类有 vtable，子类复制父类的表、在相同下标替换重写的方法、追加新方法；`invokevirtual` 链接时解析为下标，运行时通过对象头 Klass 指针取表中对应项。接口调用用 itable。JIT 进一步用 CHA 和内联缓存把大部分调用变成直接调用甚至内联。

> [!QUESTION] 为什么 `super.method()` 用 invokespecial 而不是 invokevirtual？
> 需要调用的是父类中的那个具体实现；用 invokevirtual 会按实际类型再次分派回子类自身，造成递归。

> [!QUESTION] 给方法加 final 能提高性能吗？
> 在现代 HotSpot 上几乎不能：CHA 已能把只有一个实现的虚方法当作单态内联，单态/双态调用点也能通过内联缓存内联。final 的价值在于设计意图（禁止重写），而在 Spring CGLIB 代理场景下反而会造成增强失效。

> [!QUESTION] 什么是桥方法？什么时候会产生？
> 协变返回类型、泛型擦除后的重写会使子类方法与父类方法在 JVM 签名上不一致，编译器生成带 `ACC_BRIDGE` 的合成方法覆盖父类签名并转调实际方法。反射/AOP 框架需要识别并跳过桥方法。
