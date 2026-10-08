# Java 9–21 新特性

按版本梳理对日常开发影响最大的特性。

## 版本一览

| 版本 | 类型 | 值得关注 |
| --- | --- | --- |
| 8 | LTS | Lambda、Stream、Optional、新日期时间 API |
| 9 | | 模块系统 JPMS、`List.of`、G1 成为默认 GC |
| 10 | | `var` 局部变量推断 |
| 11 | **LTS** | `String` 新方法、`HttpClient`、单文件运行 |
| 14 | | switch 表达式 |
| 15 | | 文本块 `"""` |
| 16 | | `record`、`instanceof` 模式匹配 |
| 17 | **LTS** | 密封类 `sealed`、强封装 JDK 内部 API |
| 21 | **LTS** | **虚拟线程**、switch 模式匹配、记录模式、序列集合 |

## 语法增强

### 模式匹配 instanceof（16）

```java
if (obj instanceof String s && s.length() > 3) {
    System.out.println(s.toUpperCase());
}
```

### switch 模式匹配（21）

```java
static String describe(Object o) {
    return switch (o) {
        case null            -> "空";
        case Integer i when i > 100 -> "大整数 " + i;
        case Integer i       -> "整数 " + i;
        case String s        -> "字符串 " + s;
        case int[] arr       -> "数组长度 " + arr.length;
        default              -> "其他";
    };
}
```

### 记录模式（21）

```java
record Point(int x, int y) {}
if (o instanceof Point(int x, int y)) {     // 直接解构
    System.out.println(x + y);
}
```

与 `sealed` 接口结合，`switch` 不写 `default` 编译器也能检查穷尽性，增删子类型时会立刻报错。

### 其他

- **文本块**（15）、**`var`**（10）、**`record`**、**`sealed`**（见 [枚举与记录类](#/oop/enum)、[接口与抽象类](#/oop/interface)）。
- **更友好的 NPE**（14）：`Cannot invoke "String.length()" because "user.name" is null`。

## 标准库

```java
List<Integer> l = List.of(1, 2, 3);                  // 9：不可变集合工厂
Map<String,Integer> m = Map.of("a", 1, "b", 2);

var client = HttpClient.newHttpClient();             // 11：标准 HTTP 客户端
var req = HttpRequest.newBuilder(URI.create("https://example.com")).build();
String body = client.send(req, HttpResponse.BodyHandlers.ofString()).body();

List<Integer> r = stream.toList();                   // 16：Stream.toList()
list.getFirst(); list.getLast(); list.reversed();    // 21：序列集合 SequencedCollection
```

## 虚拟线程（21，Project Loom）

由 JVM 调度的**轻量级线程**，数百万个也没问题；阻塞时自动让出底层「载体线程」。

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 10_000; i++) {
        executor.submit(() -> {
            Thread.sleep(Duration.ofSeconds(1));   // 阻塞不占用平台线程
            return fetch();
        });
    }
}   // close() 会等待全部任务完成
```

- 适合：**高并发 IO 密集**（HTTP 调用、数据库访问）。
- 不适合：CPU 密集；
- 不要池化虚拟线程；用 `Semaphore` 限制对下游的并发而不是限制线程数；
- Spring Boot 3.2+：配置 `spring.threads.virtual.enabled=true` 即可启用。

## 迁移建议

1. 从 8 升到 17 时，注意 JDK 内部 API 被强封装（`--add-opens`）、`javax.*` 的移除（如 JAXB）。
2. 先升级到 **17**，再视情况上 **21**；LTS 之间的非 LTS 版本不建议生产使用。
3. 借升级机会打开 `-Xlog:gc*`，对比新旧 GC 行为。
