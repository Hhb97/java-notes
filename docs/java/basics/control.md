---
level: 基础
tags: [运算符, switch, tableswitch, lookupswitch, 模式匹配]
summary: 从字节码看运算符与流程控制：i++ 陷阱、移位规则、switch 的两种跳转表、String/enum switch 脱糖与 JDK 21 模式匹配 switch
---

# 运算符与流程控制

> [!ABSTRACT] 核心要点
> - `i = i++` 结果不变，是因为字节码先把旧值压栈、再对局部变量 `iinc`、最后用栈上的旧值覆盖回去。
> - 移位距离会被截断：int 只取低 5 位、long 取低 6 位，`1 << 32 == 1`；无符号右移用 `>>>`。
> - `switch` 编译成 `tableswitch`（连续 key，O(1) 下标跳转）或 `lookupswitch`（稀疏 key，有序对查找），由 javac 按空间/时间代价自动选择。
> - String switch = `hashCode()` 分桶 + `equals()` 确认 + 第二次 `tableswitch`；enum switch 依赖合成类里的 `$SwitchMap$` 数组，所以 `switch(null)` 会 NPE。
> - JDK 21 模式匹配 switch 编译为 `invokedynamic SwitchBootstraps.typeSwitch`，配合 sealed 类实现穷举检查。

## 运算符：几个必须从字节码理解的点

### 自增与 `i = i++`

```java
int i = 0;
i = i++;      // i 仍为 0
```

```text
iconst_0
istore_0        // i = 0
iload_0         // ① 把 i 的旧值 0 压入操作数栈
iinc 0, 1       // ② 直接把局部变量槽 0 加 1（i = 1），不经过栈
istore_0        // ③ 把栈顶的旧值 0 写回 i，覆盖了 ②
```

`iinc` 是唯一直接修改局部变量而不经过操作数栈的指令。理解了这个，`j = i++ + ++i` 这类题都能按「压栈顺序 + iinc 时机」推出来——但生产代码里永远不要这样写。另外 `i++` 对字段并不是原子操作（`getfield → iadd → putfield`），并发计数用 `AtomicInteger` / `LongAdder`。

### 移位、除法与取模

```java
1 << 32;          // 1：int 移位距离 & 31，32 & 31 = 0
1L << 64;         // 1：long 移位距离 & 63
-8 >> 1;          // -4：算术右移，补符号位
-8 >>> 1;         // 2147483644：逻辑右移，补 0
-7 / 2;           // -3：向零取整
-7 % 2;           // -1：余数符号跟随被除数
Math.floorMod(-7, 2);  // 1：数学意义上的模，做分片路由时用它
1 / 0;            // ArithmeticException
1.0 / 0;          // Infinity，浮点除零不抛异常
```

`HashMap` 的 `(n - 1) & hash` 就是利用「容量为 2 的幂时位与等价于取模」，见 [HashMap 源码剖析](#/java/api/hashmap)。

### 短路与优先级

- `&&` / `||` 会编译成条件跳转（`ifeq` / `ifne`），右侧可能不执行；`&` / `|` 作用于 boolean 时两侧都求值。`if (obj != null && obj.isValid())` 依赖的正是短路。
- 位运算优先级低于比较运算：`if (flags & MASK == 0)` 实际是 `flags & (MASK == 0)`，int 时直接编译错误，boolean 时静默出错。位运算一律加括号。
- 复合赋值隐含强转：`byte b = 10; b += 300;` 能编译且静默溢出。

## 循环

### for-each 的两种脱糖

```java
for (String s : array) { }   // 数组：脱糖为下标循环 for (int i = 0; i < arr.length; i++)
for (String s : list)  { }   // Iterable：脱糖为 Iterator it = list.iterator(); while (it.hasNext()) ...
```

第二种意味着在 for-each 里调用 `list.remove(x)` 会修改 `modCount`，下一次 `it.next()` 检查 `modCount != expectedModCount` 时抛 `ConcurrentModificationException`。正确做法是 `list.removeIf(...)` 或显式 `it.remove()`。

> [!WARNING] 「删倒数第二个元素不报错」
> 在 ArrayList 的 for-each 里删除倒数第二个元素时，`size` 减一后 `hasNext()`（`cursor != size`）直接返回 false，循环提前结束，不抛异常——但最后一个元素也没被遍历到。fail-fast 只是尽力而为，不是正确性保证。

### 带标签的 break / continue

```java
outer:
for (int[] row : matrix) {
    for (int v : row) {
        if (v < 0) continue outer;   // 跳到外层下一次迭代
        if (v == TARGET) break outer;
    }
}
```

标签在字节码里不存在，编译后就是一条 `goto`。它比设置 flag 变量更清晰，但嵌套超过两层时应该抽方法 + `return`。

## switch 的编译：tableswitch 与 lookupswitch

<figure class="fig">
<svg viewBox="0 0 720 250" class="dg" role="img" aria-label="tableswitch 用 key 减 low 作为下标直接跳转，lookupswitch 在有序的 key-offset 对中查找">
<rect class="bg" x="20" y="20" width="330" height="210" rx="12"/>
<text class="th" x="36" y="46">tableswitch</text>
<text class="ts" x="160" y="46">case 1, 2, 3, 10</text>
<text class="tm" x="36" y="80">offset = table[key - low]</text>
<rect class="b1" x="32" y="96" width="50" height="36" rx="4"/>
<text class="tm" x="57" y="114" text-anchor="middle" dominant-baseline="middle">1:L1</text>
<rect class="b1" x="82" y="96" width="50" height="36" rx="4"/>
<text class="tm" x="107" y="114" text-anchor="middle" dominant-baseline="middle">2:L2</text>
<rect class="b1" x="132" y="96" width="50" height="36" rx="4"/>
<text class="tm" x="157" y="114" text-anchor="middle" dominant-baseline="middle">3:L3</text>
<rect class="b" x="182" y="96" width="50" height="36" rx="4"/>
<text class="tm" x="207" y="114" text-anchor="middle" dominant-baseline="middle">4:def</text>
<rect class="b" x="232" y="96" width="50" height="36" rx="4"/>
<text class="tm" x="257" y="114" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b1" x="282" y="96" width="56" height="36" rx="4"/>
<text class="tm" x="310" y="114" text-anchor="middle" dominant-baseline="middle">10:L4</text>
<text class="t" x="36" y="164">O(1)：一次减法 + 边界检查 + 下标跳转</text>
<text class="ts" x="36" y="186">空洞 4～9 填 default，空间 ∝ hi - lo + 1</text>
<text class="ts" x="36" y="210">适合 key 连续或较密集</text>
<rect class="bg" x="370" y="20" width="330" height="210" rx="12"/>
<text class="th" x="386" y="46">lookupswitch</text>
<text class="ts" x="510" y="46">case 1, 2, 3, 100</text>
<text class="tm" x="386" y="80">按 key 升序存 match:offset</text>
<rect class="b2" x="386" y="96" width="70" height="36" rx="4"/>
<text class="tm" x="421" y="114" text-anchor="middle" dominant-baseline="middle">1:L1</text>
<rect class="b2" x="456" y="96" width="70" height="36" rx="4"/>
<text class="tm" x="491" y="114" text-anchor="middle" dominant-baseline="middle">2:L2</text>
<rect class="b2" x="526" y="96" width="70" height="36" rx="4"/>
<text class="tm" x="561" y="114" text-anchor="middle" dominant-baseline="middle">3:L3</text>
<rect class="b2" x="596" y="96" width="90" height="36" rx="4"/>
<text class="tm" x="641" y="114" text-anchor="middle" dominant-baseline="middle">100:L4</text>
<text class="t" x="386" y="164">有序 → 可二分查找，O(log n)</text>
<text class="ts" x="386" y="186">空间 ∝ case 个数，与 key 跨度无关</text>
<text class="ts" x="386" y="210">适合 key 稀疏（如 hashCode）</text>
</svg>
<figcaption>图 1：两种 switch 指令的跳转表结构</figcaption>
</figure>

javac（`Gen.visitSwitch`）用一个简单的代价模型选择指令：

```text
table_space  = 4 + (hi - lo + 1)      table_time  = 3
lookup_space = 3 + 2 * nlabels        lookup_time = nlabels
若 table_space + 3 * table_time <= lookup_space + 3 * lookup_time → tableswitch
```

例如 case `1,2,3,10`：23 ≤ 23，选 tableswitch；case `1,2,3,100`：113 > 23，选 lookupswitch。JIT 编译后两者都可能被进一步改写成跳转表或二分判断树，所以**不需要为了性能手工调整 case 值**，但「switch 比一长串 if-else 快」在 case 多时是成立的。

## String switch 的脱糖

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="String switch 先按 hashCode 做 lookupswitch，再用 equals 确认得到临时下标，最后对下标做 tableswitch">
<text class="ts" x="20" y="24">javac 把 switch(String) 拆成两段 switch：先按哈希分桶，再按临时下标跳转</text>
<rect class="b1" x="20" y="80" width="130" height="48" rx="8"/>
<text class="tm" x="85" y="104" text-anchor="middle" dominant-baseline="middle">s.hashCode()</text>
<text class="ts" x="85" y="146" text-anchor="middle">s 为 null → NPE</text>
<line class="l" x1="150" y1="104" x2="190" y2="104" marker-end="url(#arr)"/>
<rect class="b3" x="190" y="80" width="170" height="48" rx="8"/>
<text class="tm" x="275" y="104" text-anchor="middle" dominant-baseline="middle">lookupswitch(hash)</text>
<text class="ts" x="275" y="68" text-anchor="middle">哈希值稀疏</text>
<line class="l" x1="360" y1="104" x2="400" y2="104" marker-end="url(#arr)"/>
<rect class="b4" x="400" y="80" width="140" height="48" rx="8"/>
<text class="tb" x="470" y="104" text-anchor="middle" dominant-baseline="middle">equals 逐个确认</text>
<text class="ts" x="470" y="68" text-anchor="middle">"Aa" 与 "BB" 哈希都是 2112</text>
<text class="ts" x="470" y="146" text-anchor="middle">命中 tmp = 序号，否则 tmp = -1</text>
<line class="l" x1="540" y1="104" x2="570" y2="104" marker-end="url(#arr)"/>
<rect class="b2" x="570" y="80" width="140" height="48" rx="8"/>
<text class="tm" x="640" y="104" text-anchor="middle" dominant-baseline="middle">tableswitch(tmp)</text>
<text class="ts" x="640" y="68" text-anchor="middle">跳到 case 体</text>
<text class="ts" x="640" y="146" text-anchor="middle">-1 → default</text>
</svg>
<figcaption>图 2：switch on String 的两阶段脱糖</figcaption>
</figure>

```java
// 源码
switch (s) { case "BB" -> a(); case "Aa" -> b(); default -> c(); }

// 等价的脱糖结果（示意）
int tmp = -1;
switch (s.hashCode()) {                 // lookupswitch
    case 2112:                          // "Aa".hashCode() == "BB".hashCode() == 2112
        if (s.equals("BB")) tmp = 0;
        else if (s.equals("Aa")) tmp = 1;
        break;
}
switch (tmp) {                          // tableswitch
    case 0 -> a(); case 1 -> b(); default -> c();
}
```

要点：`hashCode()` 在 String 中有缓存（`hash` 字段），所以重复 switch 同一个字符串很便宜；哈希冲突靠 `equals` 链兜底，正确性不受影响。

## enum switch 与 `$SwitchMap$`

```java
switch (color) { case RED -> ...; case GREEN -> ...; }
```

```text
getstatic     Outer$1.$SwitchMap$pkg$Color:[I     // 合成类中的映射数组
aload_1
invokevirtual Color.ordinal:()I                   // color 为 null 时 NPE
iaload                                            // 映射成编译期固定的序号
lookupswitch / tableswitch
```

为什么不直接 switch `ordinal()`？因为枚举类和使用方可能**分开编译**：如果枚举后来插入了新常量导致 ordinal 变化，直接用 ordinal 会跳错分支。合成类在静态初始化时用 `Color.RED.ordinal()` 运行时填数组（并 catch `NoSuchFieldError`），保证跳转按「名字」而不是按「编译时的 ordinal」。

## switch 表达式与模式匹配

### 演进

| 版本 | 特性 |
| --- | --- |
| JDK 7 | switch 支持 String |
| JDK 14 | switch 表达式正式版：`->` 箭头、`yield`、无 fall-through、对 enum 穷举检查 |
| JDK 16 | `instanceof` 模式匹配正式版：`if (o instanceof String s)` |
| JDK 21 | switch 模式匹配、record 模式正式版；`case null`；`when` 守卫 |

```java
// JDK 21
sealed interface Shape permits Circle, Square, Rect {}
record Circle(double r) implements Shape {}
record Square(double side) implements Shape {}
record Rect(double w, double h) implements Shape {}

static double area(Shape s) {
    return switch (s) {                                   // 无 default：sealed 保证穷举
        case Circle c                -> Math.PI * c.r() * c.r();
        case Square(double side)     -> side * side;      // record 解构模式
        case Rect(double w, double h) when w == h -> w * w;   // 守卫
        case Rect(double w, double h) -> w * h;
    };
}
```

### 编译产物

```text
invokedynamic typeSwitch:(Ljava/lang/Object;I)I    // 引导方法 SwitchBootstraps.typeSwitch
tableswitch { 0: ...; 1: ...; 2: ...; default: ... }
```

- 引导方法根据 case 标签列表生成「对象 → 第一个匹配的 case 下标」的逻辑，返回下标后再走普通 `tableswitch`。
- 第二个 int 参数是「从第几个 case 开始匹配」：`when` 守卫失败时，用 `下标 + 1` 重新调用 typeSwitch 继续往下找。
- 穷举 switch 没有 default 时，编译器会生成一个隐式 default：运行时遇到编译后才新增的子类时抛 `MatchException`（JDK 21）。
- **支配性检查**：`case Object o` 写在 `case String s` 前面会编译报错，因为后者永远不可达。

## 对比与取舍

| 写法 | 适用 | 注意 |
| --- | --- | --- |
| if-else 链 | 条件是区间/复杂布尔表达式 | 分支多时按命中率排序 |
| 传统 switch（`:`） | 需要 fall-through 的少数场景 | 漏写 break 是经典 bug |
| switch 表达式（`->`） | 枚举/常量映射到值 | 枚举加常量时编译器提醒补 case |
| 模式匹配 switch | 按类型分派、处理代数数据类型 | 需要 JDK 21；比多态更适合「对类型集合做操作」，而非替代多态 |
| `Map<K, Handler>` / 策略模式 | case 需要动态注册、跨模块扩展 | 见 [结构型与行为型](#/java/patterns/behavioral) |

## 生产实践与踩坑

- **switch(String/enum) 的 NPE**：外部传入的状态码字段为 null 时，异常栈只指向 switch 那一行，不少人以为是 case 里的代码出错。JDK 21 前先判空；JDK 21 可以写 `case null ->`。
- **依赖库升级后的 `IncompatibleClassChangeError` / `MatchException`**：对另一个 jar 中的 sealed 层次或枚举做穷举 switch，对方新增了子类/常量而你没重新编译，运行时就会落到隐式 default。跨模块的穷举 switch 最好显式写 `default` 抛带上下文的业务异常。
- **for-each 中修改集合**：CME 只是 fail-fast 的「尽力检测」，多线程下更可能表现为数据错乱而不是异常，并发场景直接换并发容器。
- **取模分片出现负数**：`hash % n` 在 hash 为负时结果为负，用 `Math.floorMod`；`Math.abs(Integer.MIN_VALUE)` 仍为负，也不能靠 abs 兜底。

## 相关阅读

- [Java 8–21 新特性](#/java/modern/features)：switch 模式匹配等新语法
- [解题套路：双指针、二分、DP、回溯与图](#/cs/algo-patterns)：用这些语法解算法题

## 面试追问

> [!QUESTION] `int i = 0; i = i++;` 结果是多少？从字节码解释。
> 0。`iload` 先把旧值压栈，`iinc` 直接把局部变量加一，最后 `istore` 用栈顶旧值覆盖局部变量。

> [!QUESTION] switch 为什么能支持 String，却不支持 long？
> String 通过 `hashCode()` 映射成 int 再配合 `equals`，属于编译器脱糖；`tableswitch/lookupswitch` 的 key 只有 int，long 无法无损映射成 int 且 Java 设计上没有为其提供脱糖（JDK 21 模式匹配中也不支持 long 常量标签，后续版本的原始类型模式在推进中）。

> [!QUESTION] tableswitch 和 lookupswitch 有什么区别？谁来决定用哪个？
> 前者是以 `key - low` 为下标的连续跳转表，O(1) 但空间与 key 跨度成正比；后者存有序的 key-offset 对，可二分查找。javac 按「空间 + 3 × 时间」代价模型选择，开发者无需干预。

> [!QUESTION] enum switch 为什么会生成一个 `$1` 合成类？
> 存放 `$SwitchMap$` 数组，在运行时把枚举 ordinal 映射到编译期确定的 case 序号，避免枚举类单独重新编译后 ordinal 变化导致跳错分支。

> [!QUESTION] 模式匹配 switch 是怎么实现的？和 visitor 模式相比如何？
> 编译为 `invokedynamic SwitchBootstraps.typeSwitch` 返回匹配的 case 下标，再走 `tableswitch`，守卫失败时带着重启下标再次调用。配合 sealed 可做编译期穷举检查，比 visitor 少了大量样板代码，适合「类型集合固定、操作经常增加」的场景；类型经常扩展时仍然是多态更合适。
