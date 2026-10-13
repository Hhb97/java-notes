---
level: 基础
tags: [基本类型, IEEE 754, 自动装箱, IntegerCache, BigDecimal]
summary: 从 JVM 槽位、IEEE 754 位布局与装箱字节码理解 Java 类型系统，并梳理包装类缓存与 BigDecimal 的线上坑
---

# 数据类型与变量

> [!ABSTRACT] 核心要点
> - 8 种基本类型在 JVM 层只有 int / long / float / double / reference 几种「计算类型」：`byte/short/char/boolean` 在操作数栈上都按 int 处理，`long/double` 占两个槽位。
> - 浮点数是 IEEE 754 二进制科学计数法，`0.1` 无法精确表示；金额用 `BigDecimal`（字符串构造）或「以分为单位的 long」。
> - 自动装箱就是编译器插入 `Integer.valueOf()`，拆箱是 `intValue()`；`valueOf` 对 [-128, 127] 走缓存，所以包装类用 `==` 比较是定时炸弹。
> - `BigDecimal.equals` 比较值**和 scale**（`2.0` ≠ `2.00`），判断数值相等用 `compareTo`；除法不给精度遇到无限小数直接抛异常。
> - Long 型 ID 传给前端会因 JS 的 2^53 精度上限被截断，雪花 ID 一律序列化为字符串。

## 基本类型与 JVM 表示

| 类型 | 字节 | 默认值 | JVM 计算类型 | 槽位 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `byte` | 1 | 0 | int | 1 | 数组用 `baload/bastore` |
| `short` | 2 | 0 | int | 1 | |
| `char` | 2 | `'\u0000'` | int | 1 | UTF-16 码元，无符号 |
| `int` | 4 | 0 | int | 1 | |
| `long` | 8 | 0L | long | 2 | 非 volatile 时读写可不保证原子性（JLS 17.7） |
| `float` | 4 | 0.0f | float | 1 | |
| `double` | 8 | 0.0d | double | 2 | 同 long |
| `boolean` | 未规定 | false | int | 1 | 单个变量按 int；`boolean[]` 在 HotSpot 中每元素 1 字节 |

几个由此衍生的结论：

- **局部变量没有默认值**：字段在对象分配时被清零（所以有默认值），而局部变量表槽位不清零，编译器通过「明确赋值」分析强制你先赋值。
- **`short s = 1; s = s + 1;` 编译失败**，因为 `s + 1` 是 int；而 `s += 1` 能编译，复合赋值隐含了强制转换 `(short)(s + 1)`，溢出时静默截断。
- **对象字段会被重排**：HotSpot 默认按 long/double → int/float → short/char → byte/boolean → 引用 的顺序布局以减少填充，声明顺序不等于内存顺序。对象头与对齐见 [运行时数据区与对象模型](#/java/jvm/memory)。

### 整数溢出与类型转换

```java
int max = Integer.MAX_VALUE;
int x = max + 1;                 // -2147483648，静默溢出
Math.addExact(max, 1);           // 抛 ArithmeticException，计费/库存场景必用

float f = 16_777_217;            // 2^24 + 1，float 尾数只有 23+1 位
System.out.println((int) f);     // 16777216，int → float 是「拓宽」但会丢精度

long big = (1L << 53) + 1;
System.out.println((long) (double) big == big);  // false，long → double 同理
byte b = (byte) 200;             // -56，只保留低 8 位
```

`Math.abs(Integer.MIN_VALUE)` 仍是负数——这是很多「取模分片」代码 `Math.abs(hash) % n` 出现负下标的根源，应改用 `Math.floorMod(hash, n)` 或 `(hash & 0x7fffffff) % n`。

## 浮点数：IEEE 754

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="IEEE 754 双精度浮点数位布局：1 位符号、11 位指数、52 位尾数，以及 0.1 的二进制表示">
<text class="ts" x="20" y="30">double（64 位）；float 为 1 + 8 + 23 位、指数偏移 127</text>
<rect class="b4" x="20" y="44" width="70" height="44" rx="6"/>
<text class="tb" x="55" y="66" text-anchor="middle" dominant-baseline="middle">S 1 位</text>
<rect class="b3" x="90" y="44" width="190" height="44" rx="6"/>
<text class="tb" x="185" y="66" text-anchor="middle" dominant-baseline="middle">指数 E 11 位</text>
<rect class="b1" x="280" y="44" width="420" height="44" rx="6"/>
<text class="tb" x="490" y="66" text-anchor="middle" dominant-baseline="middle">尾数 f 52 位（隐含前导 1）</text>
<text class="ts" x="55" y="104" text-anchor="middle">bit 63</text>
<text class="ts" x="185" y="104" text-anchor="middle">bit 62 … 52</text>
<text class="ts" x="490" y="104" text-anchor="middle">bit 51 … 0</text>
<text class="ts" x="20" y="134">0.1 的 double 编码（0x3FB999999999999A）</text>
<rect class="b" x="20" y="144" width="70" height="36" rx="6"/>
<text class="tm" x="55" y="162" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b" x="90" y="144" width="190" height="36" rx="6"/>
<text class="tm" x="185" y="162" text-anchor="middle" dominant-baseline="middle">01111111011</text>
<rect class="b" x="280" y="144" width="420" height="36" rx="6"/>
<text class="tm" x="490" y="162" text-anchor="middle" dominant-baseline="middle">1001 1001 1001 … 1001 1010（末位进位）</text>
<text class="ts" x="20" y="208">值 = (-1)^S × 1.f × 2^(E-1023)；E = 1019 → 0.1 ≈ 1.6 × 2^-4，0.6 的二进制是无限循环小数，只能在第 52 位舍入</text>
</svg>
<figcaption>图 1：double 的位布局与 0.1 的实际编码</figcaption>
</figure>

```java
System.out.println(0.1 + 0.2);            // 0.30000000000000004
System.out.println(0.1f + 0.2f);          // 0.3（float 舍入后恰好打印成 0.3，并不代表精确）
System.out.println(Double.NaN == Double.NaN);       // false
System.out.println(0.0 == -0.0);                    // true
System.out.println(Double.valueOf(0.0).equals(-0.0)); // false：equals 比较的是位模式
System.out.println(Math.round(-2.5));               // -2：floor(x + 0.5)
```

- `NaN` 不等于任何值包括自己，判断用 `Double.isNaN`；排序/比较用 `Double.compare`，它规定 `-0.0 < 0.0`、`NaN` 最大。
- JDK 17 起所有浮点运算都是严格语义（JEP 306），`strictfp` 成为冗余关键字，跨平台结果一致。

## 自动装箱与拆箱

### 编译器做了什么

```java
Integer a = 127;
int b = a;
```

```text
// javap -c 输出（节选）
0: bipush        127
2: invokestatic  java/lang/Integer.valueOf:(I)Ljava/lang/Integer;   // 装箱
5: astore_1
6: aload_1
7: invokevirtual java/lang/Integer.intValue:()I                    // 拆箱，a 为 null 即 NPE
10: istore_2
```

装箱/拆箱是纯粹的语法糖，JVM 完全不知道。这也解释了为什么 `a == b`（一侧是基本类型）会触发拆箱比较数值，而两侧都是 `Integer` 时比较的是引用。

### IntegerCache 源码

```java
// JDK 17 java.lang.Integer（节选）
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high)
        return IntegerCache.cache[i + (-IntegerCache.low)];   // 命中缓存
    return new Integer(i);                                    // 否则每次新建
}

private static class IntegerCache {
    static final int low = -128;
    static final int high;
    static final Integer[] cache;
    static {
        int h = 127;
        // -XX:AutoBoxCacheMax=N 会设置这个系统属性
        String v = VM.getSavedProperty("java.lang.Integer.IntegerCache.high");
        if (v != null) {
            h = Math.max(parseInt(v), 127);                   // 只能调大，不能调小
            h = Math.min(h, Integer.MAX_VALUE - (-low) - 1);
        }
        high = h;
        // ... 填充 cache 数组（并可从 CDS 归档中恢复）
    }
}
```

<figure class="fig">
<svg viewBox="0 0 720 250" class="dg" role="img" aria-label="Integer.valueOf 对 127 返回缓存数组中的同一对象，对 128 每次在堆上新建对象">
<rect class="bg" x="20" y="14" width="420" height="96" rx="10"/>
<text class="ts" x="34" y="32">IntegerCache.cache（静态数组，类初始化时填充）</text>
<rect class="b2" x="40" y="44" width="120" height="40" rx="6"/>
<text class="tm" x="100" y="64" text-anchor="middle" dominant-baseline="middle">[0] -128</text>
<rect class="b2" x="160" y="44" width="120" height="40" rx="6"/>
<text class="tm" x="220" y="64" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b2" x="280" y="44" width="140" height="40" rx="6"/>
<text class="tm" x="350" y="64" text-anchor="middle" dominant-baseline="middle">[255] 127</text>
<text class="ts" x="100" y="100" text-anchor="middle">下标 = i + 128</text>
<rect class="bg" x="480" y="14" width="220" height="96" rx="10"/>
<text class="ts" x="494" y="32">堆上新建的对象</text>
<rect class="b3" x="492" y="44" width="95" height="40" rx="6"/>
<text class="tm" x="539" y="64" text-anchor="middle" dominant-baseline="middle">Integer 128</text>
<rect class="b3" x="600" y="44" width="95" height="40" rx="6"/>
<text class="tm" x="647" y="64" text-anchor="middle" dominant-baseline="middle">Integer 128</text>
<rect class="b" x="20" y="150" width="200" height="70" rx="8"/>
<text class="tm" x="32" y="170">Integer.valueOf(i):</text>
<text class="tm" x="32" y="189">i∈[low,high] → cache</text>
<text class="tm" x="32" y="208">否则 new Integer(i)</text>
<rect class="b1" x="260" y="170" width="80" height="36" rx="6"/>
<text class="tm" x="300" y="188" text-anchor="middle" dominant-baseline="middle">a = 127</text>
<rect class="b1" x="360" y="170" width="80" height="36" rx="6"/>
<text class="tm" x="400" y="188" text-anchor="middle" dominant-baseline="middle">b = 127</text>
<rect class="b1" x="500" y="170" width="80" height="36" rx="6"/>
<text class="tm" x="540" y="188" text-anchor="middle" dominant-baseline="middle">c = 128</text>
<rect class="b1" x="608" y="170" width="80" height="36" rx="6"/>
<text class="tm" x="648" y="188" text-anchor="middle" dominant-baseline="middle">d = 128</text>
<line class="la" x1="300" y1="170" x2="325" y2="84" marker-end="url(#arr-a)"/>
<line class="la" x1="400" y1="170" x2="375" y2="84" marker-end="url(#arr-a)"/>
<line class="l" x1="540" y1="170" x2="540" y2="84" marker-end="url(#arr)"/>
<line class="l" x1="648" y1="170" x2="648" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="350" y="232" text-anchor="middle">a == b → true（同一对象）</text>
<text class="ts" x="594" y="232" text-anchor="middle">c == d → false（两次 new）</text>
</svg>
<figcaption>图 2：Integer 缓存命中与未命中时的引用关系</figcaption>
</figure>

| 包装类 | 缓存范围 | 可调 |
| --- | --- | --- |
| `Integer` | -128 ～ 127 | 上限可用 `-XX:AutoBoxCacheMax` 调大 |
| `Long` / `Short` / `Byte` | -128 ～ 127 | 否 |
| `Character` | 0 ～ 127 | 否 |
| `Boolean` | `TRUE` / `FALSE` 两个常量 | — |
| `Float` / `Double` | 无缓存 | — |

> [!NOTE] 值类型的未来
> JDK 16 起包装类被标记为 value-based class，`new Integer(int)` 构造器已 `@Deprecated(forRemoval = true)`，对包装类 `synchronized` 会得到编译警告。Valhalla 项目落地后，包装类可能变成没有身份（identity）的值对象，`==` 语义会改变——这是不要依赖包装类引用相等的又一个理由。

### 拆箱 NPE 的隐蔽场景

```java
Map<String, Integer> stock = new HashMap<>();
int n = stock.get("sku-1");                    // NPE：intValue() on null

// 三目运算符：一侧是 int，另一侧 Integer 被拆箱，整个表达式类型是 int
Integer r = flag ? 0 : stock.get("sku-1");     // flag=false 时 NPE！
Integer ok = flag ? Integer.valueOf(0) : stock.get("sku-1");  // 两侧都是 Integer 才安全

// 集合 remove 的重载陷阱
List<Integer> list = new ArrayList<>(List.of(10, 20, 30));
list.remove(1);                    // 按下标删除 → [10, 30]
list.remove(Integer.valueOf(10));  // 按对象删除
```

## BigDecimal

### 内部结构

`BigDecimal` = 无标度值（unscaled value）× 10^-scale。HotSpot 中字段大致为：`intCompact`（long，能放下时用它，避免 BigInteger）、`intVal`（BigInteger，放不下时使用）、`scale`（int）、`precision`。

```java
new BigDecimal(0.1);        // 0.1000000000000000055511151231257827021181583404541015625
BigDecimal.valueOf(0.1);    // 0.1：内部走 Double.toString(0.1) → "0.1"
new BigDecimal("0.1");      // 0.1，最推荐

new BigDecimal("2.0").equals(new BigDecimal("2.00"));     // false：scale 1 vs 2
new BigDecimal("2.0").compareTo(new BigDecimal("2.00"));  // 0

BigDecimal.ONE.divide(BigDecimal.valueOf(3));             // ArithmeticException: Non-terminating decimal expansion
BigDecimal.ONE.divide(BigDecimal.valueOf(3), 4, RoundingMode.HALF_UP);  // 0.3333

new BigDecimal("100").stripTrailingZeros().toString();      // "1E+2"
new BigDecimal("100").stripTrailingZeros().toPlainString(); // "100"
```

### 金额方案对比

| 方案 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- |
| `double` | 快 | 精度误差累积 | 科学计算、统计指标，绝不用于金额 |
| `BigDecimal` | 精确、可控舍入 | 对象多、慢一个数量级，API 易误用 | 金融、计费、汇率 |
| `long`（以分/厘为单位） | 快、无对象开销、天然可做 DB 主键/索引 | 需约定最小单位，多币种精度不一 | 支付、订单金额 |

舍入模式要和业务、财务对齐：`HALF_UP` 是「四舍五入」，`HALF_EVEN` 是银行家舍入（统计上偏差更小），`DOWN/FLOOR` 用于「不多扣用户钱」的场景。

## var 局部变量类型推断

`var`（JDK 10）是**纯编译期**特性，字节码里看不到任何痕迹，推断结果就是初始化表达式的静态类型。

```java
var list = new ArrayList<String>();   // ArrayList<String>，不是 List<String>
var x = 1;                            // int
var y = flag ? 1 : "a";               // Serializable & Comparable<...> 交叉类型，可读性很差
```

只能用于有初始化器的局部变量、for 循环变量和 lambda 参数（JDK 11）；不能用于字段、方法参数和返回值。

## 关键参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-XX:AutoBoxCacheMax=N` | 未设置（缓存上限 127） | 调大 Integer 缓存上限，热点路径大量装箱时可减少分配；仅作用于 Integer |
| `-Djava.lang.Integer.IntegerCache.high=N` | — | 与上一项等价的系统属性 |
| `-XX:+EliminateAutoBox` | C2 默认开启 | JIT 消除不逃逸的装箱对象 |

## 生产实践与踩坑

### 包装类 `==`：测试环境正常、生产出 bug

经典事故：`if (order.getUserId() == currentUser.getId())`，两边都是 `Long`。测试库里用户 ID 都很小（命中缓存）一切正常，生产 ID 是几百万，比较永远为 false，导致越权校验失效或业务分支走错。

- 统一用 `Objects.equals(a, b)` 或拆箱后比较。
- 开启 IDE / Sonar / Alibaba P3C 规则「包装类比较必须用 equals」。

### Long 主键传给前端精度丢失

JS 的 Number 是 double，安全整数上限是 2^53-1（约 9×10^15），雪花 ID 约 19 位会被截断，前端拿到的 ID 末几位变成 0，查询时就「找不到记录」。

```java
// 方式一：字段级
@JsonSerialize(using = ToStringSerializer.class)
private Long id;
// 方式二：全局，Spring Boot 中自定义 Jackson2ObjectMapperBuilderCustomizer
builder.serializerByType(Long.class, ToStringSerializer.instance);
```

### BigDecimal 作为 Map key / Set 元素

`HashSet` 依赖 `equals/hashCode`（含 scale），`2.0` 和 `2.00` 会被当成两个元素；`TreeSet/TreeMap` 依赖 `compareTo`，又会当成一个。对账、去重逻辑在这里非常容易出错。入库前统一 `setScale(2, RoundingMode.HALF_UP)`，比较一律 `compareTo`。

### 数据库 DECIMAL 与 Java 类型

MySQL `DECIMAL(10,2)` 读出来的 `BigDecimal` scale 是 2；同一个值从前端 JSON `2` 反序列化后 scale 是 0，两者 `equals` 为 false。另外，MyBatis/JDBC 对 `BIGINT UNSIGNED` 可能映射成 `BigInteger`，对 `TINYINT(1)` 默认映射成 `Boolean`，DTO 类型不匹配会在反射赋值时报错。

## 相关阅读

- [数组与字符串](#/java/basics/string)：字符串
- [案例：订单、支付与对账系统设计详解](#/design/case-payment)：金额为什么用整数分或 BigDecimal

## 面试追问

> [!QUESTION] `Integer a = 128, b = 128; a == b` 为什么是 false？如何让它变成 true？
> 装箱调用 `Integer.valueOf`，只有 [-128, high] 走缓存，128 会 `new` 两个对象，`==` 比引用。用 `-XX:AutoBoxCacheMax=128` 以上可让其为 true，但这只是解释机制，代码中必须用 `equals`。

> [!QUESTION] 为什么 0.1 + 0.2 != 0.3？float 和 double 分别能保证多少位有效数字？
> 0.1 在二进制下是无限循环小数，只能在尾数末位舍入，两个舍入误差相加后不等于 0.3 的舍入值。float 尾数 24 位（约 6～7 位十进制有效数字），double 53 位（约 15～16 位）。

> [!QUESTION] `new BigDecimal(0.1)` 和 `BigDecimal.valueOf(0.1)` 有什么区别？
> 前者精确表示 double 0.1 的二进制值，得到一长串小数；后者先 `Double.toString` 得到最短的十进制表示 "0.1" 再构造。最稳妥是直接用字符串构造。

> [!QUESTION] long 和 double 的读写是原子的吗？
> JLS 允许把非 volatile 的 64 位读写拆成两次 32 位操作，可能读到「半个值」；声明为 volatile 可保证原子性。实际上 64 位 HotSpot 上都是原子的，但不能依赖实现细节。

> [!QUESTION] 三目运算符为什么会引发 NPE？
> 两个分支一个是基本类型、一个是包装类型时，按二元数值提升规则表达式类型是基本类型，包装类分支会被拆箱；若其为 null，`intValue()` 抛 NPE。解决方法是让两个分支类型一致。
