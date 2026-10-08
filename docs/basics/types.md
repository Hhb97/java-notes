# 数据类型与变量

## 八种基本类型

| 类型 | 大小 | 范围 / 说明 | 包装类 |
| --- | --- | --- | --- |
| `byte` | 1 字节 | -128 ~ 127 | `Byte` |
| `short` | 2 字节 | -32768 ~ 32767 | `Short` |
| `int` | 4 字节 | 约 ±21 亿 | `Integer` |
| `long` | 8 字节 | 约 ±9.2×10¹⁸，字面量加 `L` | `Long` |
| `float` | 4 字节 | 单精度，字面量加 `f` | `Float` |
| `double` | 8 字节 | 双精度，浮点默认类型 | `Double` |
| `char` | 2 字节 | UTF-16 码元，0 ~ 65535 | `Character` |
| `boolean` | JVM 实现相关 | `true` / `false` | `Boolean` |

除此之外都是**引用类型**（类、接口、数组、枚举），变量保存的是对象的引用。

## 类型转换

```java
int i = 100;
long l = i;          // 自动（隐式）转换：小 → 大
int j = (int) 3.99;  // 强制转换：截断小数，得到 3
byte b = (byte) 200; // 溢出，得到 -56
```

> **坑：** `int` 运算溢出不会报错。`Integer.MAX_VALUE + 1` 得到 `-2147483648`。需要检测时用 `Math.addExact()`。

## 浮点数精度

```java
System.out.println(0.1 + 0.2);                       // 0.30000000000000004
System.out.println(new BigDecimal("0.1")
        .add(new BigDecimal("0.2")));                // 0.3
```

涉及金额一律使用 `BigDecimal`，并且用**字符串**构造，不要用 `new BigDecimal(0.1)`。

## 装箱与拆箱

```java
Integer a = 127, b = 127;
Integer c = 128, d = 128;
System.out.println(a == b);   // true  —— 命中 Integer 缓存 [-128, 127]
System.out.println(c == d);   // false —— 不同对象
System.out.println(c.equals(d)); // true
```

- 包装类比较**一律用 `equals`**。
- 自动拆箱遇到 `null` 会抛 `NullPointerException`。

## 变量作用域与 var

```java
var list = new ArrayList<String>();   // JDK 10+ 局部变量类型推断
final int MAX = 10;                   // final：只能赋值一次
```

- 局部变量必须先赋值再使用，成员变量有默认值（`0` / `false` / `null`）。
- `var` 只能用于局部变量，不能用于字段、方法参数与返回值。
