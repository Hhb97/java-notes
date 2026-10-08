---
level: 深入
tags: [泛型, 类型擦除, 桥方法, PECS, TypeToken, 堆污染]
summary: 从字节码层面理解类型擦除与桥方法，搞清 Signature 属性为何让 TypeReference 能拿到泛型，以及 PECS、通配符捕获、堆污染和泛型数组的边界
---

# 泛型与类型擦除

> [!ABSTRACT] 核心要点
> - Java 泛型是**编译期**机制：javac 做类型检查后把类型参数擦除到其**第一个上界**（无界即 `Object`），并在使用处插入 `checkcast`；运行时 `List<String>` 和 `List<Integer>` 是同一个 `Class`。
> - 子类重写泛型父类方法时，擦除会导致签名不一致，javac 自动生成带 `ACC_BRIDGE | ACC_SYNTHETIC` 的**桥方法**来维持多态。
> - 擦除的是「运行时对象的类型实参」，**类、字段、方法声明上的泛型信息保存在 class 文件的 `Signature` 属性中**，可通过反射读出；`TypeReference`/`TypeToken` 正是利用匿名子类把类型实参固化到父类签名里。
> - PECS：只读（生产者）用 `? extends T`，只写（消费者）用 `? super T`；`List<?>` 不能写入是因为编译器无法证明类型安全，可用私有泛型方法「捕获」通配符。
> - 泛型可变参数会创建擦除后的数组，引发**堆污染**；只有在方法既不往数组里写、也不把数组引用泄露出去时才能加 `@SafeVarargs`。

## 类型擦除

### 擦除规则

| 源码 | 擦除后 |
| --- | --- |
| `class Box<T> { T v; }` | `class Box { Object v; }` |
| `<T extends Comparable<T>> T max(T a, T b)` | `Comparable max(Comparable a, Comparable b)` |
| `<T extends Number & Comparable<T>>` | 擦除为第一个上界 `Number` |
| `List<String>` | `List`（原始类型） |
| `String s = box.get();` | `String s = (String) box.get();`（插入 `checkcast`） |

「擦除到第一个上界」会影响二进制兼容性。`Collections.max` 的签名是一个经典案例：

```java
// JDK Collections
public static <T extends Object & Comparable<? super T>> T max(Collection<? extends T> coll)
```

为什么要写一个看似多余的 `Object &`？因为在 JDK 5 之前它的签名是 `Object max(Collection)`。如果写成 `<T extends Comparable<? super T>>`，擦除后返回类型会变成 `Comparable`，方法描述符变化导致旧的已编译代码 `NoSuchMethodError`。把 `Object` 放在第一个上界，擦除结果仍是 `Object`。

### 擦除带来的限制

```java
class Box<T> {
    T t = new T();                     // ✘ 不知道 T 是什么，也不知道有无无参构造
    T[] arr = new T[10];               // ✘ 数组需要运行时组件类型
    static T shared;                   // ✘ 静态成员属于类，所有参数化共享一份
    boolean b = obj instanceof T;      // ✘
    boolean c = obj instanceof List<String>;   // ✘ unchecked（JDK 16 起仅当转换可被检查时允许，如 Collection<String> 判 List<String>）
    boolean d = obj instanceof List<?>;        // ✔
}
void f(List<String> l) {}
void f(List<Integer> l) {}             // ✘ name clash：擦除后签名相同
class MyEx<T> extends Exception {}     // ✘ 泛型类不能继承 Throwable（catch 无法区分）
List<int> li;                          // ✘ 基本类型不能做类型实参（等待 Valhalla）
```

常见解法：传 `Class<T>`（类型令牌）用于 `clazz.getDeclaredConstructor().newInstance()` / `Array.newInstance(clazz, n)`；或传 `Supplier<T>`、`IntFunction<T[]>`。

> [!NOTE] 为什么 Java 选择擦除？
> 为了**迁移兼容性**：JDK 5 引入泛型时，要求已有的非泛型类库与客户端代码不重新编译也能继续运行，泛型版本的 `ArrayList` 必须与原来的二进制完全兼容。C# 选择了运行时具化（reified generics），代价是新旧集合 API 两套并存。

## 桥方法

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="类型擦除后 javac 为 MyNode 生成 setData(Object) 桥方法，转发到 setData(Integer)">
<rect class="bg" x="10" y="10" width="290" height="230" rx="12"/>
<text class="ts" x="24" y="32">源码（编译前）</text>
<rect class="b1" x="25" y="45" width="260" height="60" rx="8"/>
<text class="tb" x="155" y="64" text-anchor="middle" dominant-baseline="middle">class Node&lt;T&gt;</text>
<text class="tm" x="155" y="88" text-anchor="middle" dominant-baseline="middle">void setData(T data)</text>
<line class="l" x1="155" y1="150" x2="155" y2="105" marker-end="url(#arr)"/>
<text class="ts" x="163" y="132">extends</text>
<rect class="b2" x="25" y="150" width="260" height="60" rx="8"/>
<text class="tb" x="155" y="169" text-anchor="middle" dominant-baseline="middle">MyNode extends Node&lt;Integer&gt;</text>
<text class="tm" x="155" y="193" text-anchor="middle" dominant-baseline="middle">void setData(Integer data)</text>
<line class="la" x1="300" y1="128" x2="340" y2="128" marker-end="url(#arr-a)"/>
<text class="ts" x="320" y="120" text-anchor="middle">javac</text>
<rect class="bg" x="340" y="10" width="410" height="230" rx="12"/>
<text class="ts" x="354" y="32">擦除后（javap 视角）</text>
<rect class="b1" x="355" y="45" width="380" height="60" rx="8"/>
<text class="tb" x="545" y="64" text-anchor="middle" dominant-baseline="middle">class Node</text>
<text class="tm" x="545" y="88" text-anchor="middle" dominant-baseline="middle">void setData(Object)    // T 擦除为 Object</text>
<line class="l" x1="545" y1="130" x2="545" y2="105" marker-end="url(#arr)"/>
<rect class="b2" x="355" y="130" width="380" height="100" rx="8"/>
<text class="tb" x="545" y="148" text-anchor="middle" dominant-baseline="middle">class MyNode extends Node</text>
<text class="tm" x="370" y="172" dominant-baseline="middle">void setData(Integer)      // 开发者写的</text>
<text class="tm" x="370" y="194" dominant-baseline="middle">void setData(Object)  ACC_BRIDGE|SYNTHETIC</text>
<text class="ts" x="370" y="216" dominant-baseline="middle">桥方法体：checkcast Integer → invokevirtual setData(Integer)</text>
</svg>
<figcaption>图 1：擦除后父类方法是 setData(Object)，子类方法 setData(Integer) 无法构成重写，需要桥方法</figcaption>
</figure>

```java
class Node<T> {
    T data;
    void setData(T data) { this.data = data; }
}
class MyNode extends Node<Integer> {
    @Override
    void setData(Integer data) { super.setData(data); }
}
```

```text
$ javap -c -v MyNode      （JDK 17，常量池编号省略）
void setData(java.lang.Integer);
  descriptor: (Ljava/lang/Integer;)V
  Code:
     0: aload_0
     1: aload_1
     2: invokespecial  // Method Node.setData:(Ljava/lang/Object;)V
     5: return

void setData(java.lang.Object);
  descriptor: (Ljava/lang/Object;)V
  flags: (0x1040) ACC_BRIDGE, ACC_SYNTHETIC
  Code:
     0: aload_0
     1: aload_1
     2: checkcast      // class java/lang/Integer
     5: invokevirtual  // Method setData:(Ljava/lang/Integer;)V
     8: return
```

- JVM 的方法重写按「名称 + 描述符」匹配。擦除后父类是 `setData(Object)`，子类的 `setData(Integer)` 只是重载。通过父类引用调用 `node.setData(x)` 编译成 `invokevirtual Node.setData(Object)`，如果没有桥方法就会调到父类实现，多态失效。
- 桥方法中的 `checkcast` 也是一道运行时防线：`Node raw = new MyNode(); raw.setData("hello");` 会在桥方法里抛 `ClassCastException`，而不是把 String 存进去。
- **协变返回类型**同样靠桥方法：子类重写 `Object clone()` 为 `MyNode clone()` 时，javac 生成一个返回 `Object` 的桥方法。JVM 层面允许同名同参数、仅返回类型不同的方法共存，Java 语言层面不允许。
- 反射时注意：`getDeclaredMethods()` 会返回桥方法，用 `Method.isBridge()` 过滤；Spring 的 `BridgeMethodResolver` 专门用于从桥方法找到真实方法以读取注解——桥方法上**不一定带有**原方法的注解（较新的 javac 会把方法注解复制到桥方法，老版本不会，不要依赖）。

## Signature 属性与 TypeReference 原理

擦除并非把泛型信息全部丢弃。class 文件中**类声明、字段、方法**的泛型签名保存在 `Signature` 属性里（局部变量的只在调试信息 `LocalVariableTypeTable` 里），反射 API 通过它返回 `ParameterizedType`、`TypeVariable`、`WildcardType`、`GenericArrayType`：

```java
class UserRepo extends BaseRepo<User, Long> {
    private Map<String, List<Integer>> index;
}

// 运行时可以拿到
ParameterizedType sup = (ParameterizedType) UserRepo.class.getGenericSuperclass();
sup.getActualTypeArguments();   // [class User, class java.lang.Long]

Field f = UserRepo.class.getDeclaredField("index");
f.getGenericType();             // java.util.Map<java.lang.String, java.util.List<java.lang.Integer>>

// 但拿不到某个「对象实例」的类型实参
List<String> list = new ArrayList<>();
list.getClass().getTypeParameters();   // [E] —— 只是声明处的类型变量
```

```text
$ javap -v UserRepo
Signature: #12   // LBaseRepo<LUser;Ljava/lang/Long;>;
...
private java.util.Map<java.lang.String, java.util.List<java.lang.Integer>> index;
  descriptor: Ljava/util/Map;
  Signature: #15   // Ljava/util/Map<Ljava/lang/String;Ljava/util/List<Ljava/lang/Integer;>;>;
```

**TypeReference / TypeToken** 的核心就是「让调用方创建一个匿名子类」，把类型实参写进子类的父类签名：

```java
// Jackson TypeReference / Gson TypeToken / Spring ParameterizedTypeReference 的共同原理
public abstract class TypeReference<T> {
    protected final Type type;
    protected TypeReference() {
        Type sup = getClass().getGenericSuperclass();      // 匿名子类的父类签名
        this.type = ((ParameterizedType) sup).getActualTypeArguments()[0];
    }
    public Type getType() { return type; }
}

// 注意末尾的 {}：创建了匿名子类 Xxx$1 extends TypeReference<List<User>>
List<User> users = mapper.readValue(json, new TypeReference<List<User>>() {});
```

> [!WARNING] 在泛型方法里包装 TypeReference 是无效的
> ```java
> <T> List<T> parseList(String json) {
>     return mapper.readValue(json, new TypeReference<List<T>>() {});
> }
> ```
> 匿名子类的签名里记录的是**类型变量 `T`**，不是具体类型。Jackson 无法解析 T，只能退化为 `Object`，结果列表里装的是 `LinkedHashMap`，直到业务代码取元素时才抛 `ClassCastException`。正确做法是让调用方传入 `Class<T>`，用 `mapper.getTypeFactory().constructCollectionType(List.class, clazz)` 构造 `JavaType`。

Spring 中对应的工具是 `ResolvableType`（能沿继承链解析类型变量），`RestTemplate.exchange(..., new ParameterizedTypeReference<List<User>>() {})` 是同一套原理。

## 通配符与 PECS

泛型是**不变**的：`List<Integer>` 不是 `List<Number>` 的子类型（否则可以往里放 Double）。通配符提供了受限的协变与逆变：

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="PECS：extends 通配符只读得到上界类型，super 通配符可写入下界类型">
<rect class="b" x="320" y="20" width="120" height="36" rx="6"/>
<text class="tm" x="380" y="38" text-anchor="middle" dominant-baseline="middle">Object</text>
<rect class="b" x="320" y="90" width="120" height="36" rx="6"/>
<text class="tm" x="380" y="108" text-anchor="middle" dominant-baseline="middle">Number</text>
<rect class="b" x="320" y="160" width="120" height="36" rx="6"/>
<text class="tm" x="380" y="178" text-anchor="middle" dominant-baseline="middle">Integer</text>
<line class="l" x1="380" y1="160" x2="380" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="90" x2="380" y2="56" marker-end="url(#arr)"/>
<rect class="b2" x="15" y="80" width="250" height="80" rx="8"/>
<text class="tb" x="140" y="102" text-anchor="middle" dominant-baseline="middle">List&lt;? extends Number&gt;</text>
<text class="ts" x="140" y="126" text-anchor="middle" dominant-baseline="middle">实参：Number / Integer / Double…</text>
<text class="ts" x="140" y="148" text-anchor="middle" dominant-baseline="middle">get() 得 Number ✔   add(x) ✘</text>
<line class="ld" x1="265" y1="108" x2="320" y2="108"/>
<text class="ts" x="292" y="100" text-anchor="middle">上界</text>
<rect class="b3" x="495" y="80" width="250" height="80" rx="8"/>
<text class="tb" x="620" y="102" text-anchor="middle" dominant-baseline="middle">List&lt;? super Integer&gt;</text>
<text class="ts" x="620" y="126" text-anchor="middle" dominant-baseline="middle">实参：Integer / Number / Object</text>
<text class="ts" x="620" y="148" text-anchor="middle" dominant-baseline="middle">add(Integer) ✔   get() 只得 Object</text>
<line class="ld" x1="495" y1="150" x2="440" y2="178"/>
<text class="ts" x="478" y="182" text-anchor="middle">下界</text>
<text class="ts" x="15" y="224">Producer-Extends：从结构中「取」数据 → ? extends T；Consumer-Super：往结构中「放」数据 → ? super T</text>
<text class="ts" x="15" y="242">典型签名：Collections.copy(List&lt;? super T&gt; dest, List&lt;? extends T&gt; src)</text>
</svg>
<figcaption>图 2：extends 给出读的上界保证，super 给出写的下界保证</figcaption>
</figure>

```java
// JDK 中的 PECS
public static <T> void copy(List<? super T> dest, List<? extends T> src)
default void forEach(Consumer<? super T> action)               // Consumer 消费 T
<R> Stream<R> map(Function<? super T, ? extends R> mapper)     // 入参消费、出参生产
public static <T extends Comparable<? super T>> void sort(List<T> list)
```

最后一个 `Comparable<? super T>` 很关键：`class Apple extends Fruit`，`Fruit implements Comparable<Fruit>`。如果签名是 `T extends Comparable<T>`，`List<Apple>` 不满足（Apple 实现的是 `Comparable<Fruit>`），加上 `? super` 后就可以排序。

实用规则：

- 返回值**不要**用通配符，它会把麻烦转嫁给调用方。
- 既读又写的参数用确切类型 `List<T>`。
- `List<?>` ≈ `List<? extends Object>`：只读、元素按 `Object` 处理；与原始类型 `List` 不同，原始类型会关闭泛型检查，可以写入任何东西。

### 通配符捕获

```java
static void swap(List<?> list, int i, int j) {
    list.set(i, list.get(j));
    // ✘ 编译错误：incompatible types: Object cannot be converted to capture#1 of ?
}
```

编译器为每次出现的 `?` 生成一个新的匿名类型 `capture#1 of ?`。`get` 返回 `capture#1`（可以赋给 Object），但 `set` 要求参数是 `capture#1`，而编译器不知道 Object 是不是它。解决办法是写一个私有泛型方法，让类型推断把 `?` **捕获**成具名类型变量：

```java
public static void swap(List<?> list, int i, int j) {
    swapHelper(list, i, j);                       // T 被推断为 capture#1
}
private static <T> void swapHelper(List<T> list, int i, int j) {
    list.set(i, list.set(j, list.get(i)));
}
// 冷知识：JDK 的 Collections.swap 直接用原始类型 `final List l = list;` 绕过检查
```

对外暴露 `List<?>` 的简洁签名、内部用 helper 保证类型安全，是 API 设计中的常见手法。

## 堆污染与 @SafeVarargs

**堆污染（heap pollution）**：一个参数化类型的变量引用了不是该类型的对象。泛型可变参数是最常见的来源，因为 `T...` 本质是数组，而 javac 只能创建擦除后的数组：

```java
static <T> T[] toArray(T... args) { return args; }   // 编译器警告：possible heap pollution

static <T> T[] pickTwo(T a, T b) {
    return toArray(a, b);         // 这里 T 未知，javac 创建的是 new Object[]{a, b}
}

String[] s = pickTwo("x", "y");   // ClassCastException: Object[] cannot be cast to String[]
                                  // 异常出现在调用方的隐式 checkcast，远离真正的问题代码
```

另一种污染：把数组向上转型后写入其他类型。

```java
static void dangerous(List<String>... lists) {
    Object[] arr = lists;
    arr[0] = List.of(42);          // 数组的运行时类型是 List[]，ArrayStoreException 也拦不住
    String s = lists[0].get(0);    // ClassCastException
}
```

`@SafeVarargs`（JDK 7）用于向调用方承诺「此方法对 varargs 数组是安全的」，以消除调用处的 unchecked 警告。安全的条件：

1. 方法**不向**这个数组写入任何元素；
2. 方法**不把**数组引用暴露给不受信任的代码（不返回它，也不传给其他可变参数方法）。

它只能标注在不能被重写的方法上：`static`、`final` 实例方法、构造器，以及 JDK 9 起的 `private` 方法。`List.of(E... elements)`、`Arrays.asList`、`Stream.of` 都带有该注解。

## 泛型数组

数组与泛型的根本冲突：

| | 数组 | 泛型 |
| --- | --- | --- |
| 型变 | **协变**：`String[]` 是 `Object[]` 的子类型 | **不变**：`List<String>` 不是 `List<Object>` 的子类型 |
| 运行时类型 | **具化**：知道元素类型，写入错误类型抛 `ArrayStoreException` | **擦除**：运行时不知道类型实参 |

所以 `new List<String>[10]` 和 `new T[n]` 都被禁止：如果允许，就能通过 `Object[]` 视图塞进 `List<Integer>` 而数组的运行时检查也无法发现。（`new List<?>[10]` 是合法的，因为无界通配符是可具化类型。）

```java
// 方案一：内部用 Object[]，对外泛型（ArrayList 的做法）
class Stack<E> {
    private Object[] elements = new Object[16];
    @SuppressWarnings("unchecked")
    E pop() { return (E) elements[--size]; }        // 只在读出时 unchecked 转换
}

// 方案二：(E[]) new Object[n] —— 只要这个数组永不暴露给外部就是安全的
@SuppressWarnings("unchecked")
E[] arr = (E[]) new Object[n];    // 如果把 arr 返回给调用方赋给 String[]，立刻 CCE

// 方案三：需要真正类型的数组时，传入类型信息
<T> T[] newArray(Class<T> type, int n) { return (T[]) Array.newInstance(type, n); }
String[] a = list.toArray(String[]::new);           // JDK 11 Collection#toArray(IntFunction)
```

> [!TIP] Effective Java 的建议
> 优先使用 `List<E>` 而不是 `E[]`；不得不用数组时，把 unchecked 转换限制在最小作用域，并在 `@SuppressWarnings("unchecked")` 旁注释为什么安全。

## 其它进阶话题

- **递归类型界**：`Enum<E extends Enum<E>>`、`Comparable<T>` 的 `<T extends Comparable<T>>`、Builder 模式里的 `abstract class Builder<B extends Builder<B>> { abstract B self(); }`，让父类方法返回子类类型以支持链式调用。
- **类型推断演进**：JDK 7 菱形 `new HashMap<>()`；JDK 8 目标类型推断（`Collections.emptyList()` 作为参数时能推断）；JDK 9 匿名内部类可用菱形；JDK 10 `var`（`var list = new ArrayList<>()` 会推断成 `ArrayList<Object>`，注意）。
- **原始类型的传染性**：只要表达式涉及原始类型，整个调用的泛型检查都会被关闭，甚至成员方法的返回值也会被擦除。例如 `rawList.stream()` 返回原始 `Stream`，链式 `map(...)` 后得到的都是 Object。
- **未来**：Project Valhalla 计划让值类型（value class）与泛型更好地协作，减少 `List<Integer>` 的装箱开销，目前仍在演进中。

## 生产实践与踩坑

1. **Jackson / Gson 反序列化泛型得到 LinkedHashMap**：直接传 `List.class` 或在泛型方法里构造 TypeReference。修复见上文。
2. **原始类型混用导致的「延迟爆炸」**：老代码返回 `List`，新代码赋给 `List<Long>`，实际装的是 `Integer`（如 MyBatis 结果映射、JSON 数字），在某处 `long x = list.get(0)` 才抛 CCE，堆栈完全指不到源头。排查时打开 `-Xlint:unchecked` 并消灭 unchecked 警告。
3. **重载因擦除冲突**：`void handle(List<Order>)` 与 `void handle(List<Refund>)` 编译不过，改名或改用不同参数类型。
4. **反射调用拿到桥方法**：基于 `getDeclaredMethods()` 的注解扫描、AOP 切点匹配可能重复匹配或漏掉注解，记得过滤 `isBridge()`。
5. **泛型 DAO 基类通过 `getGenericSuperclass()` 推断实体类型**：被 CGLIB 代理后 `getClass()` 是代理子类，父类签名里没有类型实参，需要先用 `ClassUtils.getUserClass` 拿原始类，或改用 `ResolvableType`。

## 面试追问

> [!QUESTION] 既然类型被擦除了，为什么 Jackson 还能通过 TypeReference 拿到 List&lt;User&gt;？
> 擦除的是运行时对象上的类型实参；类声明、字段、方法签名中的泛型信息保存在 class 文件的 `Signature` 属性中。`new TypeReference<List<User>>(){}` 创建了匿名子类，其父类签名记录了 `List<User>`，通过 `getGenericSuperclass()` 读出 `ParameterizedType`。

> [!QUESTION] 什么是桥方法？什么时候会生成？
> 擦除后子类的 `setData(Integer)` 与父类的 `setData(Object)` 描述符不同，无法构成 JVM 层面的重写。javac 在子类生成 `ACC_BRIDGE | ACC_SYNTHETIC` 的 `setData(Object)`，`checkcast` 后转调 `setData(Integer)`。泛型重写和协变返回类型都会生成。

> [!QUESTION] 为什么 List&lt;? extends Number&gt; 不能 add？
> 编译器只知道元素是「某个 Number 的子类型」，可能是 `List<Integer>` 也可能是 `List<Double>`，写入任何具体类型都无法保证安全（null 除外）。读取时能保证得到 Number。反之 `? super Integer` 能写 Integer，读出只能当 Object。

> [!QUESTION] 为什么不能创建泛型数组？ArrayList 内部是怎么做的？
> 数组协变且运行时具化，泛型不变且擦除；若允许 `new List<String>[]`，可以经 `Object[]` 视图放入 `List<Integer>` 而不被 ArrayStoreException 拦截。ArrayList 内部用 `Object[] elementData`，读出时 `(E)` unchecked 转换，数组不对外暴露。

> [!QUESTION] @SafeVarargs 能用在什么地方？什么情况下加它是安全的？
> 只能用于不可重写的方法：static、final、构造器、private（JDK 9+）。安全条件是方法不往 varargs 数组里写元素、也不把数组引用泄露出去（返回或传递给其他代码）。

> [!QUESTION] `<T extends Object & Comparable<? super T>>` 里的 Object 有什么用？
> 擦除取第一个上界。加上 `Object` 后 `Collections.max` 擦除后返回类型仍是 `Object`，与 JDK 5 之前的二进制签名一致，保证已编译的老代码不会 `NoSuchMethodError`。
