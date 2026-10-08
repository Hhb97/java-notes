# 泛型

泛型让类型成为参数，把类型错误从运行时提前到**编译期**，并省去强制转换。

## 基本用法

```java
public class Box<T> {
    private T value;
    public void set(T v) { this.value = v; }
    public T get() { return value; }
}

public static <T extends Comparable<T>> T max(List<T> list) {   // 泛型方法 + 上界
    T best = list.get(0);
    for (T t : list) if (t.compareTo(best) > 0) best = t;
    return best;
}
```

菱形语法：`Map<String, List<Integer>> m = new HashMap<>();`

## 类型擦除

泛型只存在于编译期，编译后 `T` 被替换为上界（默认 `Object`），并在需要处插入强转。由此带来的限制：

```java
// 以下都不合法
new T();                       // 无法实例化类型参数
new T[10];                     // 无法创建泛型数组
obj instanceof List<String>;   // 无法对参数化类型 instanceof
static T field;                // 静态成员不能用类的类型参数
class MyEx<T> extends Exception {}  // 泛型类不能继承 Throwable
```

- `List<String>` 与 `List<Integer>` 运行时是同一个 `List` 类。
- 基本类型不能作类型参数，只能用 `Integer` 等包装类。

## 通配符与 PECS

泛型**不具备协变**：`List<Integer>` 不是 `List<Number>` 的子类型。需要通配符：

| 写法 | 含义 | 能做什么 |
| --- | --- | --- |
| `List<?>` | 未知类型 | 只读（取出为 `Object`） |
| `List<? extends Number>` | 上界，Number 及子类 | **读**（取出为 Number），不能写 |
| `List<? super Integer>` | 下界，Integer 及父类 | **写**（可放 Integer），读出为 Object |

**PECS 口诀：Producer Extends, Consumer Super。** 集合向外提供数据用 `extends`，接收数据用 `super`。

```java
public static <T> void copy(List<? super T> dest, List<? extends T> src) {
    for (T t : src) dest.add(t);
}
```

## 实用建议

- 不要使用原始类型（`List` 不带参数），会丢失类型检查。
- 方法参数优先写成 `Collection<? extends T>`，提高通用性。
- 需要保留类型信息（如 JSON 反序列化）时使用「超类型令牌」：`new TypeReference<List<User>>() {}`，原理是匿名子类会把泛型签名记录在 class 元数据里。
