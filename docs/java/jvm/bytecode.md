---
level: 深入
tags: [JVM, 字节码, javap, invokedynamic, JIT, 分层编译, CDS]
summary: 读懂 class 文件与 javap 输出，理解基于操作数栈的执行模型、五种 invoke 指令与虚方法分派，以及解释器 + C1/C2 分层编译、内联、OSR、去优化、CDS 与 Native Image 如何影响启动与峰值性能
---

# 字节码与执行引擎

> [!ABSTRACT] 核心要点
> - class 文件是紧凑的二进制结构：魔数 → 版本 → 常量池 → 访问标志 → 类/父类/接口 → 字段 → 方法（Code 属性里是字节码）→ 属性。`javap -v` 是阅读它的第一工具。
> - JVM 是**基于栈**的指令集：几乎所有运算都经由操作数栈，`i = i++` 结果为 0 正是因为 `iinc` 改局部变量、`istore` 又用栈中旧值覆盖回去。
> - 五种调用指令：`invokestatic`、`invokespecial`（非虚）、`invokevirtual`、`invokeinterface`（虚分派，查 vtable/itable）、`invokedynamic`（由引导方法在运行期绑定，Lambda 与字符串拼接都靠它）。
> - HotSpot = 解释器 + C1 + C2，**分层编译**常规路径是 0 → 3 → 4；JIT 的核心收益来自**内联**，其它优化（逃逸分析、锁消除、去虚化）都以内联为前提。
> - JIT 的激进优化基于假设，假设失效就**去优化**回解释器；启动慢可用 CDS/AppCDS（及 JDK 24+ 的 AOT 缓存）缓解，极致启动与内存则用 GraalVM Native Image，代价是封闭世界约束。

## Class 文件结构

```text
ClassFile {
    u4             magic;                 // 0xCAFEBABE
    u2             minor_version;
    u2             major_version;         // 52=Java 8, 55=11, 61=17, 65=21
    u2             constant_pool_count;   // 常量池项数 + 1（索引从 1 开始，0 保留表示「不引用」）
    cp_info        constant_pool[constant_pool_count-1];
    u2             access_flags;          // ACC_PUBLIC / ACC_FINAL / ACC_INTERFACE / ACC_ABSTRACT / ACC_ENUM ...
    u2             this_class;            // 指向常量池中的 CONSTANT_Class
    u2             super_class;
    u2             interfaces_count;
    u2             interfaces[interfaces_count];
    u2             fields_count;
    field_info     fields[fields_count];
    u2             methods_count;
    method_info    methods[methods_count];
    u2             attributes_count;
    attribute_info attributes[attributes_count];   // SourceFile、InnerClasses、BootstrapMethods、NestMembers ...
}
```

用十六进制查看任何 class 文件的前 8 个字节：

```bash
$ xxd -l 8 Calc.class
00000000: cafe babe 0000 003d                      ........
# 0x3D = 61，即 JDK 17 编译；低版本 JVM 运行它会报 UnsupportedClassVersionError
```

方法的字节码存放在 `method_info` 的 **Code 属性**中，它包含：`max_stack`（操作数栈最大深度）、`max_locals`（局部变量表 slot 数）、`code[]`（字节码）、`exception_table`（try/catch 的范围与跳转目标）以及子属性 `LineNumberTable`、`LocalVariableTable`（`-g` 编译才有）、`StackMapTable`（验证用的类型快照）。

> [!WARNING] 两个 65535 限制
> - 单个方法字节码不能超过 65535 字节，否则编译报 `code too large`。常见于代码生成器生成的巨大 `static {}` 或超长 `switch`。
> - 常量池中单个 `CONSTANT_Utf8` 最多 65535 字节，超长字符串字面量（例如把一个大 JSON 写成常量）会报 `constant string too long`。

## javap -v 解读

```java
public class Calc {
    private int base = 10;

    public int add(int x) {
        return base + x;
    }
}
```

```text
$ javac Calc.java && javap -v -p Calc
  minor version: 0
  major version: 61
  flags: (0x0021) ACC_PUBLIC, ACC_SUPER
  this_class: #8                          // Calc
  super_class: #2                         // java/lang/Object
Constant pool:
   #1 = Methodref          #2.#3          // java/lang/Object."<init>":()V
   #2 = Class              #4             // java/lang/Object
   #3 = NameAndType        #5:#6          // "<init>":()V
   #4 = Utf8               java/lang/Object
   #5 = Utf8               <init>
   #6 = Utf8               ()V
   #7 = Fieldref           #8.#9          // Calc.base:I
   #8 = Class              #10            // Calc
   #9 = NameAndType        #11:#12        // base:I
  #10 = Utf8               Calc
  #11 = Utf8               base
  #12 = Utf8               I
  ...
{
  public Calc();
    descriptor: ()V
    flags: (0x0001) ACC_PUBLIC
    Code:
      stack=2, locals=1, args_size=1
         0: aload_0
         1: invokespecial #1              // Method java/lang/Object."<init>":()V
         4: aload_0
         5: bipush        10
         7: putfield      #7              // Field base:I   ← 字段初始化语句被编进了构造器
        10: return

  public int add(int);
    descriptor: (I)I
    flags: (0x0001) ACC_PUBLIC
    Code:
      stack=2, locals=2, args_size=2      // args_size 含隐式的 this
         0: aload_0                       // 压入 this
         1: getfield      #7              // 弹出 this，压入 this.base
         4: iload_1                       // 压入参数 x
         5: iadd                          // 弹出两个 int，压入和
         6: ireturn
}
```

（常量池编号随编译器版本可能不同，以实际输出为准。）读 javap 的几个要点：

- **描述符**：`I`=int、`J`=long、`Z`=boolean、`B`=byte、`C`=char、`S`=short、`F`=float、`D`=double、`V`=void、`Lpkg/Name;`=引用类型、`[`=数组。`(I)I` 即「接收 int 返回 int」。方法重载靠描述符区分，这也是**返回值不同不能构成重载**在 Java 语言层面的限制（JVM 层面其实允许）。
- **实例字段初始化与实例代码块**会被编译进**每个**构造器（在调用父构造器之后）；静态的则编进 `<clinit>`。
- `stack=2, locals=2` 就是 `max_stack` 和 `max_locals`，栈帧大小在编译期已经确定（见 [运行时数据区与对象模型](#/java/jvm/memory)）。

## 常量池

常量池存两类东西：**字面量**（字符串、final 常量值）和**符号引用**（类和接口的全限定名、字段/方法的名称与描述符、方法句柄、方法类型、动态调用点）。截至 JDK 11 共 17 种常量类型，较新的有 `CONSTANT_MethodHandle`/`MethodType`/`InvokeDynamic`（JDK 7）、`Module`/`Package`（JDK 9）、`CONSTANT_Dynamic`（JDK 11，JEP 309）。

- 符号引用通过层层索引组合：`Fieldref → Class + NameAndType → Utf8`。这种设计让 class 文件之间完全通过名字耦合，直到运行期才解析为内存地址——这就是 Java「动态链接」的基础。
- 类加载后，常量池变为**运行时常量池**；HotSpot 额外建立 ConstantPoolCache，记录已解析的字段偏移、方法入口等，后续执行直接命中缓存。
- 字符串字面量在 `ldc` 首次执行时才解析，此时才在 StringTable 中驻留对应的 String 对象。

## 基于栈的执行：i++ 与 ++i

```java
int i = 0;      // iconst_0, istore_1
i = i++;        // iload_1, iinc 1 1, istore_1   → i == 0
i = ++i;        // iinc 1 1, iload_1, istore_1   → i == 1
```

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="逐步演示 i = i++ 与 i = ++i 的字节码执行时局部变量表与操作数栈的变化">
<text class="tm" x="20" y="85">i = i++</text>
<rect class="bg" x="110" y="30" width="200" height="110" rx="10"/>
<text class="tm" x="210" y="48" text-anchor="middle" dominant-baseline="middle">① iload_1</text>
<rect class="b1" x="122" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="164" y="80" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="tb" x="164" y="104" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b3" x="214" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="256" y="80" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="tb" x="256" y="104" text-anchor="middle" dominant-baseline="middle">0</text>
<line class="l" x1="310" y1="85" x2="328" y2="85" marker-end="url(#arr)"/>
<rect class="bg" x="330" y="30" width="200" height="110" rx="10"/>
<text class="tm" x="430" y="48" text-anchor="middle" dominant-baseline="middle">② iinc 1, 1</text>
<rect class="b1" x="342" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="384" y="80" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="ta" x="384" y="104" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="434" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="476" y="80" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="tb" x="476" y="104" text-anchor="middle" dominant-baseline="middle">0</text>
<line class="l" x1="530" y1="85" x2="548" y2="85" marker-end="url(#arr)"/>
<rect class="bg" x="550" y="30" width="200" height="110" rx="10"/>
<text class="tm" x="650" y="48" text-anchor="middle" dominant-baseline="middle">③ istore_1</text>
<rect class="b1" x="562" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="604" y="80" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="ta" x="604" y="104" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b3" x="654" y="64" width="84" height="60" rx="6"/>
<text class="ts" x="696" y="80" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="ts" x="696" y="104" text-anchor="middle" dominant-baseline="middle">空</text>
<text class="ts" x="110" y="160">iinc 直接修改局部变量表；istore_1 再把栈中保存的旧值 0 写回 → 结果 i = 0</text>
<text class="tm" x="20" y="240">i = ++i</text>
<rect class="bg" x="110" y="185" width="200" height="110" rx="10"/>
<text class="tm" x="210" y="203" text-anchor="middle" dominant-baseline="middle">① iinc 1, 1</text>
<rect class="b1" x="122" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="164" y="235" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="ta" x="164" y="259" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="214" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="256" y="235" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="ts" x="256" y="259" text-anchor="middle" dominant-baseline="middle">空</text>
<line class="l" x1="310" y1="240" x2="328" y2="240" marker-end="url(#arr)"/>
<rect class="bg" x="330" y="185" width="200" height="110" rx="10"/>
<text class="tm" x="430" y="203" text-anchor="middle" dominant-baseline="middle">② iload_1</text>
<rect class="b1" x="342" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="384" y="235" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="tb" x="384" y="259" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="434" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="476" y="235" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="tb" x="476" y="259" text-anchor="middle" dominant-baseline="middle">1</text>
<line class="l" x1="530" y1="240" x2="548" y2="240" marker-end="url(#arr)"/>
<rect class="bg" x="550" y="185" width="200" height="110" rx="10"/>
<text class="tm" x="650" y="203" text-anchor="middle" dominant-baseline="middle">③ istore_1</text>
<rect class="b1" x="562" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="604" y="235" text-anchor="middle" dominant-baseline="middle">局部变量 i</text>
<text class="ta" x="604" y="259" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="654" y="219" width="84" height="60" rx="6"/>
<text class="ts" x="696" y="235" text-anchor="middle" dominant-baseline="middle">操作数栈</text>
<text class="ts" x="696" y="259" text-anchor="middle" dominant-baseline="middle">空</text>
<text class="ts" x="110" y="315">先自增再把新值压栈，写回的也是新值 → 结果 i = 1</text>
</svg>
<figcaption>图 1：i = i++ 与 i = ++i 的逐步执行（初始 iconst_0 / istore_1 已执行，i 位于 slot 1）</figcaption>
</figure>

局部变量的自增有专门的 `iinc` 指令，不经过操作数栈；而**字段**的自增要经过「读-改-写」三步，这就是 `count++` 不是原子操作的字节码层面原因：

```text
// this.count++ 对应的字节码
aload_0
dup                    // 复制 this，一份给 getfield，一份给 putfield
getfield  #7           // 读：count 压栈
iconst_1
iadd                   // 改：栈顶 +1
putfield  #7           // 写：回写字段 —— 三步之间可能被其他线程插入
```

多线程下需要 `AtomicInteger`/`LongAdder` 或加锁，参见 [并发工具与 CompletableFuture](#/java/concurrency/juc)。

> [!NOTE] 基于栈 vs 基于寄存器
> 栈式指令不依赖具体硬件寄存器，指令短、可移植性好、编译器实现简单，代价是完成同样的计算需要更多指令和内存访问。这只是**解释执行**层面的特征；JIT 编译后操作数栈会被寄存器分配消掉，最终机器码与 C++ 生成的并无本质差别。Android 的 Dalvik/ART 则选择了寄存器式字节码。

## 方法调用：五种 invoke 指令

| 指令 | 调用目标 | 分派方式 |
| --- | --- | --- |
| `invokestatic` | 静态方法 | 解析期确定，非虚 |
| `invokespecial` | 构造器 `<init>`、`super.xxx()`、（JDK 11 之前的）私有方法 | 解析期确定，非虚 |
| `invokevirtual` | 普通实例方法（含 `final` 方法） | 运行期按接收者实际类型查 vtable；`final` 方法虽用此指令但无需分派 |
| `invokeinterface` | 通过接口类型调用的方法 | 运行期查 itable |
| `invokedynamic` | 由引导方法决定 | 首次执行时调用 BSM 得到 `CallSite`，之后直接调用绑定的 `MethodHandle` |

「非虚方法」= 静态方法、私有方法、构造器、父类方法、final 方法，它们在类加载的解析阶段就能确定唯一版本。JDK 11 引入嵌套访问控制（JEP 181）后，内部类与外部类之间互调私有成员不再需要编译器生成 `access$000` 桥接方法，javac 对嵌套成员的私有方法调用也改用 `invokevirtual`/`invokeinterface`。

### invokedynamic

`invokedynamic` 把「调用哪个方法」的决定权交给 Java 代码：每个 indy 调用点关联 `BootstrapMethods` 属性中的一个**引导方法**（BSM），首次执行时 JVM 调用 BSM，返回一个 `CallSite`，其中的 `MethodHandle` 就是真正的调用目标，之后的调用直接走链接好的目标，JIT 也能把它内联。

```java
Runnable r = () -> System.out.println("hi");
String s = "id=" + id;
```

```text
0: invokedynamic #7,  0      // InvokeDynamic #0:run:()Ljava/lang/Runnable;
...
9: invokedynamic #13,  0     // InvokeDynamic #1:makeConcatWithConstants:(I)Ljava/lang/String;

BootstrapMethods:
  0: #29 REF_invokeStatic java/lang/invoke/LambdaMetafactory.metafactory:(...)Ljava/lang/invoke/CallSite;
    Method arguments:
      #36 ()V
      #37 REF_invokeStatic Demo.lambda$main$0:()V      // Lambda 体被编译成私有静态方法
      #36 ()V
  1: #40 REF_invokeStatic java/lang/invoke/StringConcatFactory.makeConcatWithConstants:(...)Ljava/lang/invoke/CallSite;
    Method arguments:
      #46 id=\u0001                                     // \u0001 是参数占位符
```

| 用途 | 引导方法 | 版本 |
| --- | --- | --- |
| Lambda / 方法引用 | `LambdaMetafactory.metafactory`，运行期生成实现函数式接口的类（JDK 15+ 为隐藏类） | JDK 8 |
| 字符串拼接 | `StringConcatFactory.makeConcatWithConstants`（JEP 280），替代 `StringBuilder` 链 | JDK 9 |
| record 的 `toString/equals/hashCode` | `ObjectMethods.bootstrap` | JDK 16 |
| `switch` 模式匹配 | `SwitchBootstraps.typeSwitch` | JDK 21 |

> [!TIP] Lambda 不是匿名内部类的语法糖
> 匿名内部类在编译期生成 `Outer$1.class`；Lambda 在**首次执行**时才通过 `LambdaMetafactory` 动态生成类，不捕获变量的 Lambda 会被缓存为单例。所以大量 Lambda 会让首次调用稍慢，但不会增加 jar 中的 class 文件数。

## 分派与虚方法表

**静态分派（重载）**：编译期根据参数的**静态类型**选择方法版本，写进字节码的符号引用里。

```java
static void say(Object o) { System.out.println("Object"); }
static void say(String s) { System.out.println("String"); }

Object o = "hi";
say(o);          // 输出 Object：编译期只看到 o 的静态类型是 Object
say((String) o); // 输出 String
say(null);       // 输出 String：选择「最具体」的重载
```

**动态分派（重写）**：`invokevirtual` 在运行期根据**接收者实际类型**选择方法。为避免每次调用都沿继承链搜索，HotSpot 在每个 `Klass` 中维护**虚方法表（vtable）**：

- 子类 vtable 先复制父类的全部条目，**同一方法在父子类中的索引相同**；
- 子类重写的方法替换对应索引的入口，新增的方法追加到末尾；
- 调用时只需「取接收者 Klass → 按编译期确定的索引取 vtable 项 → 跳转」。

接口方法因为同一接口在不同类中位置不固定，使用 **itable**（接口表）：先查找接口在该类 itable 中的偏移，再取方法入口，比 vtable 多一步。

JIT 进一步优化虚调用：

1. **类层次分析（CHA）**：若某虚方法当前只有一个实现（没有被加载的子类重写），直接当作非虚调用并内联；一旦加载了新的子类破坏假设，就去优化。
2. **内联缓存（Inline Cache）**：根据运行期类型剖析，单态（monomorphic）调用点直接内联 + 类型守卫；双态（bimorphic）内联两个版本；超过两种类型的**多态（megamorphic）**调用点退化为查 vtable，且无法内联——这在热点代码中会造成显著性能差异。

## 解释器与 JIT：分层编译

HotSpot 启动时由**模板解释器**逐条执行字节码，同时收集调用次数、分支和类型剖析信息；热点代码交给 **C1**（编译快、优化少）或 **C2**（编译慢、激进优化）编译成本地代码。JDK 8 起默认开启分层编译（`-XX:+TieredCompilation`），共 5 个级别：

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="HotSpot 分层编译的五个级别及常见转换路径，包括 C2 积压时的路径与去优化回退">
<rect class="b" x="20" y="140" width="150" height="60" rx="8"/>
<text class="tb" x="95" y="160" text-anchor="middle" dominant-baseline="middle">Level 0</text>
<text class="ts" x="95" y="182" text-anchor="middle" dominant-baseline="middle">解释器 + 计数</text>
<rect class="b2" x="300" y="50" width="180" height="60" rx="8"/>
<text class="tb" x="390" y="70" text-anchor="middle" dominant-baseline="middle">Level 3</text>
<text class="ts" x="390" y="92" text-anchor="middle" dominant-baseline="middle">C1 + 完全 profiling</text>
<rect class="b2" x="300" y="230" width="180" height="60" rx="8"/>
<text class="tb" x="390" y="250" text-anchor="middle" dominant-baseline="middle">Level 2</text>
<text class="ts" x="390" y="272" text-anchor="middle" dominant-baseline="middle">C1 + 调用/回边计数</text>
<rect class="b5" x="590" y="50" width="150" height="60" rx="8"/>
<text class="tb" x="665" y="70" text-anchor="middle" dominant-baseline="middle">Level 4</text>
<text class="ts" x="665" y="92" text-anchor="middle" dominant-baseline="middle">C2 激进优化</text>
<rect class="b2" x="590" y="230" width="150" height="60" rx="8"/>
<text class="tb" x="665" y="250" text-anchor="middle" dominant-baseline="middle">Level 1</text>
<text class="ts" x="665" y="272" text-anchor="middle" dominant-baseline="middle">C1 无 profiling</text>
<line class="la" x1="170" y1="155" x2="298" y2="91" marker-end="url(#arr-a)"/>
<text class="ta" x="210" y="112" text-anchor="middle">常规路径</text>
<line class="la" x1="480" y1="80" x2="588" y2="80" marker-end="url(#arr-a)"/>
<text class="ts" x="534" y="70" text-anchor="middle">profile 充足</text>
<line class="l" x1="170" y1="185" x2="298" y2="250" marker-end="url(#arr)"/>
<text class="ts" x="215" y="236" text-anchor="middle">C2 队列积压</text>
<line class="l" x1="390" y1="230" x2="390" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="398" y="170">积压缓解后</text>
<line class="l" x1="480" y1="100" x2="588" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="560" y="158">平凡方法</text>
<text class="ts" x="560" y="176">或 C2 编译失败</text>
<line class="ld" x1="665" y1="50" x2="665" y2="30"/>
<line class="ld" x1="665" y1="30" x2="95" y2="30"/>
<line class="ld" x1="95" y1="30" x2="95" y2="138" marker-end="url(#arr)"/>
<text class="ts" x="230" y="48" text-anchor="middle">去优化（假设失效）</text>
</svg>
<figcaption>图 2：分层编译的级别与转换路径（0 → 3 → 4 为最常见路径）</figcaption>
</figure>

| 级别 | 执行者 | profiling | 说明 |
| --- | --- | --- | --- |
| 0 | 解释器 | 调用计数 + 回边计数 + 类型剖析 | 启动时所有方法都在这里 |
| 1 | C1 | 无 | getter 之类的平凡方法，C2 也优化不出更多，直接停在这里 |
| 2 | C1 | 仅计数器 | C2 编译队列过长时的过渡，避免 Level 3 的 profiling 开销 |
| 3 | C1 | 完全（含分支、类型剖析） | 为 C2 收集数据，比 Level 2 慢约 30% |
| 4 | C2 | 无 | 基于剖析数据的激进优化，峰值性能 |

**热点探测**：方法调用计数器和回边计数器（循环跳回的次数）。JDK 17 默认阈值大致为：调用次数超过 `Tier3InvocationThreshold`（200），或调用 + 回边总数超过 `Tier3CompileThreshold`（2000）时提交 Level 3 编译；Level 3 代码继续计数，超过 `Tier4InvocationThreshold`（5000）/ `Tier4CompileThreshold`（15000）时提交 C2。阈值会根据编译队列长度动态放大。关闭分层编译时（`-XX:-TieredCompilation`），C2 的阈值为 `CompileThreshold`（10000）。

编译在后台线程异步进行，编译期间方法继续解释执行；编译产物放在 **Code Cache** 中（分层编译下 `ReservedCodeCacheSize` 默认 240MB，JDK 9 起按「非方法 / 带 profiling / 不带 profiling」分段，JEP 197）。

> [!CAUTION] Code Cache 写满
> 日志出现 `CodeCache is full. Compiler has been disabled.` 后，新的热点方法不再被编译，只能解释执行，CPU 飙升、RT 成倍上涨，而且**不会自动恢复**到正常水平。大量动态生成类（Groovy、规则引擎）、超大应用容易触发。用 `jcmd <pid> Compiler.codecache` 查看使用率，必要时调大 `-XX:ReservedCodeCacheSize`。

## 方法内联与 PrintCompilation

内联把被调方法的代码复制到调用处，消除调用开销，更重要的是让优化的作用域跨越方法边界——逃逸分析、常量折叠、冗余检查消除都依赖它。

| 参数 | 默认值（x86_64） | 含义 |
| --- | --- | --- |
| `MaxInlineSize` | 35 字节 | 非热点方法，字节码小于此值才内联 |
| `FreqInlineSize` | 325 字节 | 热点方法的内联上限 |
| `MaxInlineLevel` | 15（JDK 14 前为 9） | 最大内联深度 |
| `InlineSmallCode` | 平台相关 | 被调方法若**已被编译**且机器码超过此值则不内联 |

```bash
java -XX:+PrintCompilation -jar app.jar
java -XX:+UnlockDiagnosticVMOptions -XX:+PrintInlining -XX:+PrintCompilation -jar app.jar
```

```text
    112   45       3       java.lang.String::hashCode (60 bytes)
    118   52   !   3       java.io.BufferedReader::readLine (304 bytes)
    205   61 %     4       com.example.Demo::main @ 12 (78 bytes)
    230   70       4       java.lang.String::hashCode (60 bytes)
    231   45       3       java.lang.String::hashCode (60 bytes)   made not entrant
                              @ 1   java.lang.String::isLatin1 (19 bytes)   inline (hot)
                              @ 20  com.example.Rule::eval (480 bytes)   hot method too big
```

| 列 | 含义 |
| --- | --- |
| 112 | JVM 启动后的毫秒数 |
| 45 | 编译任务 ID |
| 标志 | `%` OSR 编译，`s` synchronized，`!` 含异常处理器，`b` 阻塞式编译，`n` native 包装 |
| 3 / 4 | 分层编译级别 |
| `@ 12` | OSR 的入口字节码偏移（循环头位置） |
| `made not entrant` | 该版本已作废（被更高级别替换，或去优化），新调用不再进入 |

`PrintInlining` 中的 `hot method too big`、`too big` 提示内联失败，热点路径上出现它往往意味着可以拆分方法。

## OSR：栈上替换

方法只被调用一次，但里面有一个跑上亿次的循环（典型是 `main` 中的循环或基准测试代码），方法调用计数器永远到不了阈值。**回边计数器**超过阈值后，JIT 会以循环头为入口编译一个特殊版本，在循环执行中途把解释器栈帧替换成编译后的栈帧，这就是 OSR（On-Stack Replacement），PrintCompilation 中带 `%` 标志。

> [!WARNING] 微基准测试陷阱
> 在 `main` 里写 for 循环计时，测到的多半是 OSR 版本（优化程度不如正常编译），还可能遇到死代码消除、常量折叠导致的「零耗时」。性能对比请使用 JMH：它负责预热、防止死代码消除（`Blackhole`）、多次 fork 取统计结果。

## 逃逸分析

C2 在内联之后对对象做逃逸分析，结论用于**标量替换**（不分配对象，字段变局部变量）与**锁消除**（去掉不逃逸对象上的 `synchronized`）。HotSpot 并没有实现整对象的栈上分配。详细的逃逸状态、示例与局限见 [运行时数据区与对象模型](#/java/jvm/memory)。从字节码角度的启示：保持热点方法短小、减少多态调用点，让 JIT 能内联，逃逸分析才能生效。

## 去优化 Deoptimization

C2 的很多优化建立在**乐观假设**上，编译后的代码中保留一个「陷阱」（uncommon trap），假设被打破时触发去优化：丢弃编译代码（`made not entrant`），把当前栈帧还原为解释器栈帧继续执行，之后可能重新收集剖析信息再编译。

| 假设 | 失效场景 |
| --- | --- |
| CHA：某方法只有一个实现 | 运行中加载了一个重写该方法的新子类 |
| 类型剖析：调用点只见过类型 A | 突然传入类型 B（`class_check`） |
| 分支剖析：某分支从未走过 | 该分支首次被执行（`unstable_if`） |
| 从未出现 null | 首次出现 null（`null_check`） |

> [!WARNING] 去优化风暴
> 应用启动后流量模式切换（例如预热只用了一种消息类型，正式流量混入多种类型），大量方法反复「编译 → 去优化 → 重新编译」，表现为 CPU 高但业务吞吐低，火焰图中 `Interpreter` 与 `C2 CompilerThread` 占比高。排查可以加 `-XX:+UnlockDiagnosticVMOptions -XX:+LogCompilation` 输出编译日志，用 JITWatch 可视化分析。预热流量应尽量覆盖真实的类型分布。

## CDS / AppCDS 与 AOT 缓存

类加载、解析、验证在启动期占用大量时间。**CDS（Class Data Sharing）** 把解析好的类元数据转储为归档文件，下次启动直接 mmap 映射，多个 JVM 进程还能共享这部分内存。

| 版本 | 能力 |
| --- | --- |
| JDK 5 | CDS，仅支持启动类加载器加载的 JDK 类 |
| JDK 10（JEP 310） | AppCDS 开源，支持应用类 |
| JDK 12（JEP 341） | JDK 自带默认 CDS 归档，默认开启 |
| JDK 13（JEP 350） | 动态归档：`-XX:ArchiveClassesAtExit` 在进程退出时自动转储 |
| JDK 19 | `-XX:+AutoCreateSharedArchive` 自动创建/更新归档 |
| JDK 24（JEP 483） | AOT 类加载与链接（Project Leyden），在归档中保存已加载并链接的类 |

```bash
# 动态 AppCDS（JDK 13+）：先训练一次，再用归档启动
java -XX:ArchiveClassesAtExit=app.jsa -jar app.jar        # 跑一遍典型流程后正常退出
java -XX:SharedArchiveFile=app.jsa -jar app.jar

# JDK 24+ AOT 缓存（JEP 483）
java -XX:AOTMode=record -XX:AOTConfiguration=app.aotconf -jar app.jar
java -XX:AOTMode=create -XX:AOTConfiguration=app.aotconf -XX:AOTCache=app.aot -jar app.jar
java -XX:AOTCache=app.aot -jar app.jar
```

Spring Boot 应用使用 CDS 时要先把 fat jar 解包成普通 jar + lib 目录（嵌套 jar 无法归档），Spring Boot 3.3 起提供了相应的解包工具支持。启动时间通常能缩短 30% 左右，具体收益视应用而定。

## GraalVM Native Image 简述

Native Image 在构建期对应用做**静态可达性分析**，把可达的类、方法以及构建期初始化好的堆对象一起 AOT 编译成本地可执行文件。

| 维度 | HotSpot JIT | JIT + CDS/AOT 缓存 | Native Image |
| --- | --- | --- | --- |
| 启动时间 | 秒级 | 明显缩短 | 毫秒级 |
| 内存占用 | 高（JIT、元数据、Code Cache） | 略降 | 低 |
| 峰值吞吐 | 最高（基于运行期剖析） | 同 JIT | 通常较低（Oracle GraalVM 的 PGO 可缩小差距） |
| 动态特性 | 完整 | 完整 | **封闭世界**：反射、动态代理、资源、JNI 需提前配置 |
| 构建成本 | 低 | 低（多一次训练运行） | 高（分钟级、内存消耗大） |
| GC | 全部 | 全部 | 默认 Serial；G1 仅部分平台/发行版可用 |

- 反射等动态用法需要 reachability metadata，可用 `-agentlib:native-image-agent` 跑一遍应用自动生成；Spring Boot 3 的 AOT 引擎会在构建期生成大部分配置（`mvn -Pnative native:compile`）。
- 适合 Serverless、CLI、需要快速扩缩容的小服务；长期运行、追求峰值吞吐的大型服务仍以 HotSpot 为主。

## 生产实践与踩坑

1. **刚发布时 RT 高、CPU 高**：大量方法还在解释执行和 C1 阶段，C2 编译线程也在占 CPU。做好预热（摘流量启动 → 回放流量 → 再接入），或在 K8s 中配合 readiness 探针 + 预热脚本。
2. **Code Cache 满导致 JIT 停止**：见上文，监控 `CodeCache` 内存池使用率。
3. **多态调用点拖慢热点路径**：接口实现从 2 个增长到 5 个后某核心方法变慢，原因是调用点变为 megamorphic，无法内联。可以对热点路径做类型特化，或用 `switch` 分派代替。
4. **Lambda 首次调用延迟**：大量 Lambda 在冷启动时逐个引导，配合 CDS/AOT 缓存可缓解。
5. **`i = i++` 类代码**：静态检查工具（SpotBugs、Sonar）能检测出「自赋值」问题，建议纳入 CI。

## 面试追问

> [!QUESTION] `i = i++` 为什么结果是 0？从字节码层面解释。
> 字节码为 `iload_1; iinc 1 1; istore_1`：先把 i 的旧值 0 压入操作数栈，`iinc` 直接把局部变量表中的 i 改为 1，最后 `istore_1` 把栈顶的 0 写回局部变量 i，覆盖了自增结果。`++i` 的顺序是先 `iinc` 再 `iload`，所以得到 1。

> [!QUESTION] invokevirtual 和 invokeinterface 有什么区别？为什么接口调用可能更慢？
> 二者都是运行期按接收者类型分派。`invokevirtual` 可以用编译期确定的固定 vtable 索引直接取方法；接口方法在不同实现类中位置不固定，需要先在 itable 中查找接口再取方法。不过 JIT 在单态/双态调用点会通过内联缓存直接内联，实际差别主要出现在 megamorphic 调用点。

> [!QUESTION] Lambda 是如何实现的？与匿名内部类有何区别？
> Lambda 体被编译为当前类的私有静态（或实例）方法，调用点是 `invokedynamic`，引导方法 `LambdaMetafactory.metafactory` 在首次执行时生成实现函数式接口的类（JDK 15+ 为隐藏类）并返回 `CallSite`。匿名内部类在编译期就生成独立 class 文件，每次创建都 new 一个对象，并且总是持有外部类 this；不捕获变量的 Lambda 实例可被复用。

> [!QUESTION] 分层编译有哪几层？为什么需要 Level 2？
> 0 解释器、1 C1 无剖析、2 C1 只带计数器、3 C1 完全剖析、4 C2。常规路径 0→3→4。Level 3 剖析开销大，当 C2 编译队列积压时，方法先编译到 Level 2 以较低开销运行，等 C2 空闲后再升到 Level 3 收集剖析，最终到 Level 4。

> [!QUESTION] 什么是去优化？什么情况会触发？
> JIT 基于剖析数据做乐观假设（只有一个实现类、某分支从不执行、从不为 null 等）。假设被违反时触发 uncommon trap，丢弃编译代码，把栈帧还原为解释器帧继续执行，必要时重新编译。加载新子类破坏 CHA、出现新的接收者类型、走到从未执行的分支都会触发。

> [!QUESTION] CDS 和 Native Image 分别解决什么问题？怎么选？
> CDS/AppCDS（以及 JDK 24+ 的 AOT 缓存）在保留完整 JVM 动态能力和 JIT 峰值性能的前提下，减少类加载与链接时间，改造成本几乎为零。Native Image 通过封闭世界 AOT 编译把启动降到毫秒级、内存大幅降低，但牺牲了动态特性和部分峰值吞吐，且构建复杂。常规微服务先上 CDS，Serverless/CLI 等对冷启动极敏感的场景再考虑 Native Image。
