# Lambda 与 Stream

## Lambda 表达式

Lambda 是**函数式接口**的简洁实现：

```java
Runnable r = () -> System.out.println("hi");
Comparator<String> c = (a, b) -> a.length() - b.length();
list.forEach(s -> System.out.println(s));
```

### 方法引用

| 形式 | 示例 | 等价 Lambda |
| --- | --- | --- |
| 静态方法 | `Integer::parseInt` | `s -> Integer.parseInt(s)` |
| 实例方法（特定对象） | `System.out::println` | `x -> System.out.println(x)` |
| 实例方法（任意对象） | `String::length` | `s -> s.length()` |
| 构造器 | `ArrayList::new` | `() -> new ArrayList<>()` |

### 内置函数式接口

| 接口 | 方法 | 含义 |
| --- | --- | --- |
| `Function<T,R>` | `R apply(T)` | 转换 |
| `Predicate<T>` | `boolean test(T)` | 判断 |
| `Consumer<T>` | `void accept(T)` | 消费 |
| `Supplier<T>` | `T get()` | 生产 |
| `BiFunction` / `UnaryOperator` / `BinaryOperator` | | 双参 / 同类型转换 |

> Lambda 中捕获的局部变量必须是 **effectively final**（实际上不再被修改）。

## Stream

Stream 是对集合的**声明式流水线**：`数据源 → 中间操作（惰性）→ 终止操作（触发执行）`。

```java
List<String> names = users.stream()
    .filter(u -> u.getAge() >= 18)              // 中间：过滤
    .sorted(Comparator.comparing(User::getAge).reversed())
    .map(User::getName)                         // 中间：映射
    .distinct()
    .limit(10)
    .collect(Collectors.toList());              // 终止：16+ 可直接 .toList()
```

### 常用操作

| 类型 | 操作 |
| --- | --- |
| 中间 | `filter` `map` `flatMap` `distinct` `sorted` `limit` `skip` `peek` |
| 终止 | `collect` `forEach` `reduce` `count` `min/max` `anyMatch/allMatch/noneMatch` `findFirst` |
| 数值流 | `mapToInt` → `sum` `average` `summaryStatistics`；`IntStream.range(0, n)` |

### Collectors

```java
// 分组
Map<String, List<User>> byCity = users.stream().collect(Collectors.groupingBy(User::getCity));

// 分组计数
Map<String, Long> cnt = users.stream().collect(Collectors.groupingBy(User::getCity, Collectors.counting()));

// 转 Map（key 冲突要提供合并函数，否则抛 IllegalStateException）
Map<Long, User> byId = users.stream().collect(Collectors.toMap(User::getId, u -> u, (a, b) -> a));

// 拼接
String s = names.stream().collect(Collectors.joining(",", "[", "]"));

// 分区
Map<Boolean, List<User>> part = users.stream().collect(Collectors.partitioningBy(u -> u.getAge() > 30));
```

### flatMap：把多层展开

```java
List<String> words = lines.stream()
    .flatMap(l -> Arrays.stream(l.split(" ")))
    .toList();
```

## 注意事项

- Stream **只能消费一次**，重复使用抛 `IllegalStateException`。
- 中间操作不会执行，没有终止操作就什么都不会发生。
- `parallelStream()` 使用公共 ForkJoinPool，**不要在其中做阻塞 IO**；数据量小或操作轻量时反而更慢。
- 流内**不要修改外部状态**（有副作用），保持无状态、无干扰。
- 过长的链式调用可读性反而差，必要时拆成多个有名字的变量。

## Optional

```java
Optional<User> u = repo.findById(id);
String name = u.map(User::getName).orElse("匿名");
u.ifPresent(x -> log(x));
User must = u.orElseThrow(() -> new NotFoundException(id));
```

只用作**方法返回值**，不要用作字段或参数；不要对 `Optional` 调 `get()` 而不判断。
