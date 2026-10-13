---
level: 基础
tags: [数组, String, Compact Strings, 字符串常量池, intern, StringBuilder, invokedynamic]
summary: 数组的内存与协变陷阱、String 的 JDK 9 紧凑布局、常量池与 intern 语义、+ 拼接的字节码演进和 StringBuilder 扩容
---

# 数组与字符串

> [!ABSTRACT] 核心要点
> - 数组是带 `length` 字段的对象，Java 数组**协变**（`String[]` 是 `Object[]`），写入时由 `aastore` 做运行期类型检查，失败抛 `ArrayStoreException`。
> - JDK 9 Compact Strings：`String` 内部从 `char[]` 改为 `byte[] value + byte coder`，纯 Latin-1 文本每字符 1 字节，典型业务堆可省 10%～30%。
> - 字符串常量池（StringTable）是 JVM 本地哈希表，**只存引用**；JDK 7 起字符串对象本身在堆上，`intern()` 在池中没有时直接登记当前堆对象的引用。
> - `+` 拼接在 JDK 8 编译为 `StringBuilder` 链，JDK 9 起（JEP 280）编译为 `invokedynamic StringConcatFactory.makeConcatWithConstants`；但循环内拼接仍应手动用 `StringBuilder`。
> - `StringBuilder` 默认容量 16，扩容约为「旧容量 × 2 + 2」，大字符串预估容量可省掉多次复制。

## 数组

### 内存布局与协变

数组对象 = 对象头（mark word 8B + 压缩类指针 4B）+ `length`（4B）+ 元素，再按 8 字节对齐。所以 `new int[0]` 也占 16 字节，`new byte[1]` 占 24 字节。

```java
Object[] objs = new String[2];      // 协变：编译通过
objs[0] = 1;                        // 运行期 aastore 检查元素类型 → ArrayStoreException

List<Object> list = new ArrayList<String>();   // 泛型不变：编译不通过
```

数组协变是 Java 1.0 为了让 `Arrays.sort(Object[])` 等方法通用而做的妥协，代价是每次引用数组写入都要做类型检查。泛型为此选择了不变 + 通配符，见 [泛型与类型擦除](#/java/api/generics)。

### 常用 API 的实现与坑

| API | 实现要点 | 坑 |
| --- | --- | --- |
| `Arrays.sort(int[])` | 双轴快排 DualPivotQuicksort | 不稳定（对基本类型无影响） |
| `Arrays.sort(T[], cmp)` | TimSort，稳定 | 比较器违反自反/传递/对称性时抛 `Comparison method violates its general contract!` |
| `Arrays.asList(arr)` | 返回 `Arrays$ArrayList`，直接包装原数组 | 定长，`add/remove` 抛 `UnsupportedOperationException`；修改会写穿原数组；传 `int[]` 得到 `List<int[]>` |
| `System.arraycopy` | JIT intrinsic，按块内存复制 | 浅拷贝；`clone()` 同样是浅拷贝 |
| `List.of(...)` | 不可变集合 | 不允许 null 元素，`contains(null)` 也会 NPE |

> [!WARNING] 比较器用减法
> `(a, b) -> a.getScore() - b.getScore()` 在分数跨度大时会溢出，导致比较结果不满足传递性，TimSort 在数据量较大时抛上面的异常。一律用 `Integer.compare` 或 `Comparator.comparingInt`。

## String 的内存布局

<figure class="fig">
<svg viewBox="0 0 720 260" class="dg" role="img" aria-label="JDK 8 的 String 使用 char 数组每字符两字节，JDK 9 起使用 byte 数组加 coder 字段，Latin-1 文本每字符一字节">
<rect class="bg" x="20" y="20" width="330" height="220" rx="12"/>
<text class="th" x="36" y="46">JDK 8</text>
<rect class="b1" x="36" y="60" width="150" height="100" rx="8"/>
<text class="tm" x="48" y="84">对象头</text>
<text class="tm" x="48" y="108">char[] value</text>
<text class="tm" x="48" y="132">int hash</text>
<line class="l" x1="186" y1="104" x2="210" y2="104" marker-end="url(#arr)"/>
<rect class="b2" x="210" y="60" width="125" height="100" rx="8"/>
<text class="tm" x="222" y="84">char[] 头+len</text>
<rect class="b" x="218" y="100" width="28" height="30"/>
<text class="tm" x="232" y="115" text-anchor="middle" dominant-baseline="middle">J</text>
<rect class="b" x="246" y="100" width="28" height="30"/>
<text class="tm" x="260" y="115" text-anchor="middle" dominant-baseline="middle">a</text>
<rect class="b" x="274" y="100" width="28" height="30"/>
<text class="tm" x="288" y="115" text-anchor="middle" dominant-baseline="middle">v</text>
<rect class="b" x="302" y="100" width="28" height="30"/>
<text class="tm" x="316" y="115" text-anchor="middle" dominant-baseline="middle">a</text>
<text class="ts" x="222" y="150">2 字节/字符</text>
<text class="ts" x="36" y="190">"Java" 的字符数据占 8 字节</text>
<text class="ts" x="36" y="214">英文、数字为主的业务数据浪费近一半</text>
<rect class="bg" x="370" y="20" width="330" height="220" rx="12"/>
<text class="th" x="386" y="46">JDK 9+（Compact Strings）</text>
<rect class="b1" x="386" y="60" width="160" height="124" rx="8"/>
<text class="tm" x="398" y="82">对象头</text>
<text class="tm" x="398" y="104">byte[] value</text>
<text class="tm" x="398" y="126">byte coder</text>
<text class="tm" x="398" y="148">int hash</text>
<text class="tm" x="398" y="170">boolean hashIsZero</text>
<line class="l" x1="546" y1="104" x2="566" y2="104" marker-end="url(#arr)"/>
<rect class="b2" x="566" y="60" width="124" height="100" rx="8"/>
<text class="tm" x="576" y="84">byte[] 头+len</text>
<rect class="b" x="574" y="100" width="26" height="30"/>
<text class="tm" x="587" y="115" text-anchor="middle" dominant-baseline="middle">J</text>
<rect class="b" x="600" y="100" width="26" height="30"/>
<text class="tm" x="613" y="115" text-anchor="middle" dominant-baseline="middle">a</text>
<rect class="b" x="626" y="100" width="26" height="30"/>
<text class="tm" x="639" y="115" text-anchor="middle" dominant-baseline="middle">v</text>
<rect class="b" x="652" y="100" width="26" height="30"/>
<text class="tm" x="665" y="115" text-anchor="middle" dominant-baseline="middle">a</text>
<text class="ts" x="576" y="150">1 字节/字符</text>
<text class="ts" x="386" y="208">coder = 0：LATIN1，1 字节/字符</text>
<text class="ts" x="386" y="228">含非 Latin-1 字符 → coder = 1：UTF16</text>
</svg>
<figcaption>图 1：JDK 8 与 JDK 9+ 的 String 对象布局</figcaption>
</figure>

- `coder` 是**整串粒度**的：只要出现一个中文字符，整个字符串就按 UTF16 存储，每字符 2 字节。中文为主的系统收益有限。
- `hashIsZero`（JDK 13+）用于区分「哈希还没算」和「哈希恰好算出来是 0」，避免哈希为 0 的字符串每次都重算。
- 几乎所有 `String` 方法都分成 `StringLatin1` / `StringUTF16` 两套实现，按 `coder` 分派；JIT 对其中很多方法有 intrinsic（向量化比较、查找）。
- 可用 `-XX:-CompactStrings` 关闭，一般没有理由这么做。

### 为什么 String 设计成不可变

1. **哈希可缓存**：`hash` 字段懒计算一次即可，`String` 作为 `HashMap` key 极其高效。
2. **常量池共享**：同一字面量全 JVM 共享一个对象，可变就无法共享。
3. **安全**：类名、文件路径、URL、数据库连接串都用 String 传递，校验之后不能被篡改。
4. **天然线程安全**：`final` 字段保证安全发布，无需同步。

`hashCode` 的算法是 `s[0]*31^(n-1) + ... + s[n-1]`。选 31 是因为它是奇素数，并且 `31 * i == (i << 5) - i` 可被 JIT 优化为移位减法。

## 字符串常量池与 intern

<figure class="fig">
<svg viewBox="0 0 720 270" class="dg" role="img" aria-label="字面量通过 ldc 经 StringTable 解析到堆中的 String 对象，new String 在堆上创建新对象共享 value 数组，intern 返回表中登记的引用">
<rect class="bg" x="20" y="30" width="150" height="200" rx="10"/>
<text class="ts" x="32" y="46">局部变量</text>
<rect class="b1" x="35" y="54" width="120" height="34" rx="6"/>
<text class="tm" x="95" y="71" text-anchor="middle" dominant-baseline="middle">s1 = "ab"</text>
<rect class="b1" x="35" y="110" width="120" height="34" rx="6"/>
<text class="tm" x="95" y="127" text-anchor="middle" dominant-baseline="middle">s3（intern）</text>
<rect class="b1" x="35" y="166" width="120" height="34" rx="6"/>
<text class="tm" x="95" y="183" text-anchor="middle" dominant-baseline="middle">s2（new）</text>
<rect class="b3" x="220" y="40" width="170" height="60" rx="8"/>
<text class="tb" x="305" y="60" text-anchor="middle" dominant-baseline="middle">StringTable</text>
<text class="tm" x="305" y="82" text-anchor="middle" dominant-baseline="middle">"ab" → 对象 A</text>
<text class="ts" x="305" y="122" text-anchor="middle">JVM 本地哈希表，只存引用</text>
<line class="ld" x1="155" y1="71" x2="220" y2="71" marker-end="url(#arr)"/>
<text class="ts" x="188" y="62" text-anchor="middle">ldc</text>
<line class="ld" x1="155" y1="127" x2="260" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="200" y="136" text-anchor="middle">查表</text>
<rect class="bg" x="430" y="30" width="270" height="200" rx="10"/>
<text class="ts" x="444" y="46">Java 堆（JDK 7+ 池中对象也在这里）</text>
<rect class="b2" x="450" y="66" width="110" height="44" rx="8"/>
<text class="tb" x="505" y="88" text-anchor="middle" dominant-baseline="middle">String A</text>
<rect class="b2" x="450" y="150" width="110" height="44" rx="8"/>
<text class="tb" x="505" y="172" text-anchor="middle" dominant-baseline="middle">String B</text>
<rect class="b" x="596" y="108" width="94" height="44" rx="8"/>
<text class="tm" x="643" y="130" text-anchor="middle" dominant-baseline="middle">byte[] ab</text>
<line class="l" x1="390" y1="70" x2="450" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="155" y1="183" x2="450" y2="172" marker-end="url(#arr)"/>
<text class="ts" x="300" y="170" text-anchor="middle">new</text>
<line class="l" x1="560" y1="96" x2="596" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="164" x2="596" y2="142" marker-end="url(#arr)"/>
<text class="ts" x="643" y="176" text-anchor="middle">共享 value</text>
<text class="ts" x="20" y="256">s1 == s3 为 true，s1 == s2 为 false；JDK 6 的 intern 会把字符串复制进永久代，JDK 7+ 只登记堆对象引用</text>
</svg>
<figcaption>图 2：字面量、new String 与 intern 的引用关系</figcaption>
</figure>

### 字面量什么时候进池

字面量在编译后存在 class 常量池（`CONSTANT_String`）中，第一次执行对应的 `ldc` 指令时才**懒解析**：去 StringTable 查，有则返回，没有则在堆上创建 String 并登记。所以「类加载时就把所有字面量放进池」的说法不准确。

```java
// 经典题：JDK 7+ 下的结果
String s = new String("a") + new String("b");  // 堆上的 "ab"，池里还没有 "ab"
s.intern();                                     // 池中无 → 登记 s 自身的引用
System.out.println(s == "ab");                  // true（JDK 6 为 false：池里是复制到永久代的另一个对象）

String t = new String("cd");                    // 字面量 "cd" 已在 ldc 时入池，t 是另一个对象
t.intern();                                     // 池中已有 → 返回池里的引用，t 本身不变
System.out.println(t == "cd");                  // false

final String p = "a";
System.out.println((p + "b") == "ab");          // true：编译期常量折叠成字面量 "ab"
```

`new String("ab")` 创建几个对象？——如果 `"ab"` 此前没被解析过，则是 2 个（池中字面量对象 + new 出来的对象，二者共享 `byte[]`）；否则 1 个。

### intern 的正确与错误用法

`intern()` 的价值在于**大量重复的字符串去重**（如从数据库/消息里反序列化出的城市名、状态码）。JDK 8 的 StringTable 是固定桶数的哈希表（`-XX:StringTableSize`），对高基数数据（订单号、UUID）调用 intern 会让链表变长、查询变慢；JDK 11+ 改为可自动扩容的并发哈希表，查询退化问题缓解，但高基数 intern 依然零收益，还会让表膨胀、增加 GC 清理 StringTable 的开销。

| 方案 | 去重对象 | 代价 | 适用 |
| --- | --- | --- | --- |
| `String#intern` | String 对象本身 | 哈希表查找、需要手动调用 | 低基数、长期存活的字符串 |
| G1 `-XX:+UseStringDeduplication` | 只去重底层 `byte[]` | 后台线程 CPU，仅对存活若干次 GC 的对象 | 无法改代码时的全局优化；JDK 18 起其他 GC 也支持 |
| 自建 `ConcurrentHashMap` 池 / Guava `Interner` | String 对象 | 可控、可用弱引用 | 需要精确控制池生命周期 |

## `+` 拼接的编译演进

```java
static String f(String a, int b) { return "id=" + a + ",n=" + b; }
```

```text
// JDK 8 编译结果：StringBuilder 链
new StringBuilder → dup → invokespecial <init>
ldc "id=" → append → aload_0 → append → ldc ",n=" → append → iload_1 → append(I)
invokevirtual toString

// JDK 9+ 编译结果（JEP 280）
aload_0
iload_1
invokedynamic makeConcatWithConstants:(Ljava/lang/String;I)Ljava/lang/String;
// 引导方法：StringConcatFactory.makeConcatWithConstants
// recipe 静态参数："id=\u0001,n=\u0001"（\u0001 是参数占位符）
```

JDK 9+ 的好处：拼接策略由**运行时**决定而非写死在字节码中。默认策略会先算出各参数的总长度和 coder，**一次性分配精确大小的 `byte[]`** 再填充，避免了 `StringBuilder` 的扩容与最终 `toString` 的那次复制。且以后 JDK 改进策略，旧字节码无需重新编译就能受益。

> [!WARNING] 循环拼接仍然要用 StringBuilder
> `for (...) s += x;` 每次迭代都是一次独立的 indy 调用，都会新建一个字符串并复制之前的全部内容，复杂度 O(n²)。JIT 不会把它合并成一个 builder。

### StringBuilder 扩容

```java
// JDK 17 AbstractStringBuilder（节选）
private int newCapacity(int minCapacity) {
    int oldLength = value.length;                 // value 是 byte[]
    int newLength = minCapacity << coder;         // UTF16 时字节数翻倍
    int growth = newLength - oldLength;
    // 至少增长到所需大小，通常增长 oldLength + 2（按字节，再按 coder 换算）
    int length = ArraysSupport.newLength(oldLength, growth, oldLength + (2 << coder));
    if (length == Integer.MAX_VALUE) throw new OutOfMemoryError("Required length exceeds implementation limit");
    return length >> coder;
}
```

- 默认容量 16 个字符，扩容大约「×2 + 2」，每次扩容都是一次 `Arrays.copyOf`。
- 先 append 纯 ASCII 内容（LATIN1），一旦 append 中文会触发 **inflate**：整个缓冲区转换为 UTF16，内存翻倍。
- `StringBuffer` 每个方法都 `synchronized`，单线程场景无意义，且 `toString` 还有 `toStringCache`；新代码一律用 `StringBuilder`。

## 关键参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-XX:+CompactStrings` | 开启（JDK 9+） | Latin-1 字符串单字节存储 |
| `-XX:StringTableSize` | 65536（JDK 11+），JDK 8 为 60013 | 常量池初始桶数；JDK 8 大量 intern 时需调大，JDK 11+ 表可自动扩容 |
| `-XX:+UseStringDeduplication` | 关闭 | G1（JDK 18+ 其他 GC 也支持）后台去重 `byte[]` |
| `-Dfile.encoding` | JDK 18+ 默认 UTF-8（JEP 400） | 影响无参 `getBytes()`、`new String(bytes)` 等 |

## 生产实践与踩坑

### 默认字符集导致乱码

JDK 17 及以前，`"中文".getBytes()` 使用平台默认编码：Linux 通常是 UTF-8，Windows 中文环境是 GBK。同一份代码在开发机和服务器上结果不同，文件、签名、MD5 都可能对不上。**所有 `getBytes` / `new String(bytes)` / `InputStreamReader` 显式传 `StandardCharsets.UTF_8`**。JDK 18 起默认 UTF-8，但 `System.out` 的编码另有 `stdout.encoding` 属性控制。

### 日志与大字符串

- `log.debug("result: " + bigObject)` 即使 debug 未开启也会执行拼接和 `toString`，用占位符 `log.debug("result: {}", obj)`。
- 一次性拼出几十 MB 的 JSON/报表字符串：在 G1 下 `byte[]` 超过 Region 一半就是 Humongous 对象，直接进老年代且可能引发 Full GC；再叠加 UTF16 inflate 内存翻倍。大数据量输出改为流式写入（`Writer` / Jackson `JsonGenerator`）。

### `split` 与正则

`String.split` 对单个非正则特殊字符有快速路径，但 `split("|")`、`split(".")` 会被当成正则，结果完全错误；高频路径上复杂正则每次都编译 `Pattern`。应写 `split("\\|")` 或预编译 `Pattern` 静态常量。

### substring 不再共享数组

JDK 7u6 之前 `substring` 与原串共享 `char[]`，从一个大字符串里截取一小段并长期持有会导致整个大数组无法回收（经典内存泄漏）。之后改为复制，泄漏消失但 substring 变成 O(n)。阅读老代码中的 `new String(s.substring(...))` 就是当年的规避写法。

## 相关阅读

- [运行时数据区与对象模型](#/java/jvm/memory)：字符串常量池所在的内存区域
- [Web 安全：OWASP 常见漏洞与防护](#/security/web)：字符串拼接与注入类漏洞

## 面试追问

> [!QUESTION] `String s = new String("abc")` 创建了几个对象？
> 若 "abc" 字面量尚未解析，`ldc` 会在堆上创建一个并登记到 StringTable，`new` 再创建一个共享同一 `byte[]` 的 String，共 2 个（不算数组）；若已解析则只创建 1 个。

> [!QUESTION] JDK 6 与 JDK 7+ 的 intern 有什么不同？为什么要把常量池移到堆上？
> JDK 6 池在永久代，intern 会复制一份字符串进去；JDK 7+ 池对象在堆中，intern 只登记引用。移到堆上是因为永久代大小固定、回收困难，大量 intern 容易 `OutOfMemoryError: PermGen space`；在堆上可以被普通 GC 回收。

> [!QUESTION] JDK 9 之后字符串 `+` 拼接还会生成 StringBuilder 吗？
> 不会。编译为 `invokedynamic`，引导方法 `StringConcatFactory.makeConcatWithConstants` 在运行时生成拼接逻辑，默认策略精确计算长度一次分配。可通过 `javac -XDstringConcat=inline` 退回旧行为。

> [!QUESTION] Compact Strings 对中文系统有效吗？带来了什么代价？
> 只对整串都是 Latin-1 的字符串有效，含中文的串仍是 2 字节/字符。代价是方法需按 coder 分派、混合拼接时可能 inflate，但 JIT intrinsic 抵消了大部分开销，整体通常是正收益。

> [!QUESTION] 为什么 String 的 hashCode 用 31 做乘子？
> 奇素数让分布更均匀、乘法溢出时信息损失少；`31 * i` 可被优化为 `(i << 5) - i`。在常见英文单词集合上冲突率也足够低。
