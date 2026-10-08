# 数组与字符串

## 数组

```java
int[] a = new int[5];              // 默认值全 0
int[] b = {1, 2, 3};
int[][] grid = new int[3][4];      // 二维数组：数组的数组

System.out.println(b.length);      // 3，注意 length 是字段不是方法
System.out.println(Arrays.toString(b));
Arrays.sort(b);
int idx = Arrays.binarySearch(b, 2);   // 要求已排序
int[] copy = Arrays.copyOf(b, 6);      // 扩容拷贝
```

- 数组长度固定，越界抛 `ArrayIndexOutOfBoundsException`。
- 需要可变长度请用 `ArrayList`，见 [集合总览](#/api/collections)。

## String 的不可变性

`String` 底层是 `final` 的字节数组（JDK 9+ 为 `byte[]`，紧凑字符串），一经创建不可修改。好处：线程安全、可缓存 `hashCode`、可放入字符串常量池。

```java
String s1 = "java";
String s2 = "java";
String s3 = new String("java");
System.out.println(s1 == s2);          // true  —— 常量池同一对象
System.out.println(s1 == s3);          // false —— 堆上新对象
System.out.println(s1 == s3.intern()); // true
System.out.println(s1.equals(s3));     // true  —— 比较内容
```

## 三兄弟：String / StringBuilder / StringBuffer

| 类 | 可变 | 线程安全 | 场景 |
| --- | --- | --- | --- |
| `String` | 否 | 是（不可变） | 少量拼接、常量 |
| `StringBuilder` | 是 | 否 | 循环里大量拼接（首选） |
| `StringBuffer` | 是 | 是（方法同步） | 极少使用 |

```java
StringBuilder sb = new StringBuilder();
for (int i = 0; i < 1000; i++) sb.append(i).append(',');
String result = sb.toString();
```

> 循环内使用 `+=` 会每轮创建新对象，应改用 `StringBuilder`。单条表达式里的 `+` 编译器会自动优化，不必手动改。

## 常用方法

```java
String s = "  Hello, Java  ";
s.trim();                     // 去首尾空白；11+ 推荐 strip()
s.isBlank();                  // 11+，空或全空白
s.substring(2, 7);            // [2,7)
s.indexOf("Java");
s.replace("Java", "World");
s.split(",");
String.join("-", "a", "b");   // a-b
"ab".repeat(3);               // 11+，ababab
String.format("%s 已 %d 岁，%.2f", "Tom", 20, 1.5);
```

## 文本块（15+）

```java
String json = """
    {
      "name": "Tom",
      "age": 20
    }
    """;
```

## 字符编码

- Java 内部用 UTF-16；与外界交换数据时**显式指定字符集**：

```java
byte[] bytes = "你好".getBytes(StandardCharsets.UTF_8);
String back = new String(bytes, StandardCharsets.UTF_8);
```

JDK 18 起默认字符集统一为 UTF-8，但显式声明仍是好习惯。
