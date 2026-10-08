---
level: 进阶
tags: [Java 17, Java 21, 虚拟线程, 模式匹配, sealed, record, 升级迁移]
summary: 按 LTS 版本梳理 Java 8 到 21 对日常开发影响最大的特性，重点讲清虚拟线程的调度模型与适用边界，并给出从 8 升级到 17/21 的迁移清单。
---

# Java 8–21 新特性

> [!ABSTRACT] 核心要点
> - 现实中的升级路径是 **8 → 11 → 17 → 21**（只用 LTS）；新项目直接 **17 或 21**，Spring Boot 3 要求 JDK 17+。
> - 语言层面：`var`、文本块、`switch` 表达式、`record`、`sealed`、**模式匹配**（instanceof / switch / 记录模式）——代码更少、更安全，配合 sealed 可获得穷尽性检查。
> - 运行时层面：G1 成为默认、ZGC/Shenandoah 成熟、**虚拟线程**让阻塞式代码也能高并发。
> - 虚拟线程适合**高并发 IO 密集**，不适合 CPU 密集；不要池化；注意 `synchronized` pinning 与 ThreadLocal 使用。
> - 升级的主要坑：**JDK 内部 API 强封装**、`javax.*` → `jakarta.*`、被移除的模块与参数、依赖版本。

## 版本脉络

| 版本 | 类型 | 对开发影响大的特性 |
| --- | --- | --- |
| 8 | LTS | Lambda、Stream、Optional、`java.time`、默认方法 |
| 9 | | 模块系统（JPMS）、`List.of/Map.of`、`private` 接口方法、G1 成为默认 GC |
| 10 | | `var` 局部变量类型推断 |
| 11 | **LTS** | `HttpClient`、`String` 新方法（`isBlank/strip/repeat/lines`）、单文件运行、`var` 用于 lambda 参数 |
| 12–14 | | `switch` 表达式（14 正式）、友好的 NPE 信息（14） |
| 15 | | **文本块** `"""`、ZGC 转正 |
| 16 | | **`record`**、`instanceof` 模式匹配、`Stream.toList()` |
| 17 | **LTS** | **`sealed` 类**、强封装 JDK 内部 API、新随机数 API、`switch` 模式匹配（预览） |
| 18 | | 默认字符集 UTF-8 |
| 19–20 | | 虚拟线程、结构化并发（预览） |
| 21 | **LTS** | **虚拟线程正式**、`switch` 模式匹配与记录模式正式、`SequencedCollection`、分代 ZGC |

## 语法增强

### record 与 sealed

```java
public record Point(int x, int y) {
    public Point {                                  // 紧凑构造器：校验
        if (x < 0 || y < 0) throw new IllegalArgumentException();
    }
}

public sealed interface Shape permits Circle, Rect, Triangle {}
public record Circle(double r) implements Shape {}
public record Rect(double w, double h) implements Shape {}
public record Triangle(double b, double h) implements Shape {}
```

`record` 是**不可变数据载体**，编译器生成构造器、访问器、`equals/hashCode/toString`；`sealed` 限定继承体系，二者配合构成 Java 的**代数数据类型**。详见 [枚举与记录类](#/java/oop/enum)、[接口与抽象类](#/java/oop/interface)。

### 模式匹配

```java
// instanceof 模式（16）
if (obj instanceof String s && s.length() > 3) { use(s); }

// switch 模式匹配 + sealed 穷尽性（21）：不写 default，新增子类型时编译报错
static double area(Shape shape) {
    return switch (shape) {
        case Circle c    -> Math.PI * c.r() * c.r();
        case Rect(double w, double h) -> w * h;               // 记录模式：直接解构
        case Triangle t  -> 0.5 * t.b() * t.h();
    };
}

// 带守卫条件
static String grade(Object o) {
    return switch (o) {
        case null                      -> "空";
        case Integer i when i >= 90    -> "优秀";
        case Integer i                 -> "及格线下";
        case String s                  -> "字符串:" + s;
        default                        -> "未知";
    };
}
```

`switch` 的编译实现见 [运算符与流程控制](#/java/basics/control)；模式匹配 switch 通过 `invokedynamic` 的 `typeSwitch` 引导方法分派，分支多时比 if-else 链更优。

### 其他常用

```java
var map = new HashMap<String, List<Integer>>();          // var：右侧类型明显时用
String json = """
        {"name": "%s", "age": %d}
        """.formatted(name, age);                         // 文本块 + formatted
List<Integer> r = stream.toList();                        // 不可变列表，允许 null 元素（与 Collectors.toList 不同）
list.getFirst(); list.getLast(); list.reversed();         // 21：SequencedCollection
```

## 虚拟线程（JDK 21）

### 为什么需要

传统「一个请求一个平台线程」模型：平台线程与 OS 线程 1:1，栈约 1MB，创建和切换成本高，几千个线程就到极限；IO 阻塞时线程白白占着。异步/响应式编程能提升吞吐，但代码复杂、调试困难。**虚拟线程让你继续写同步阻塞代码，却获得接近异步的并发度。**

### 调度模型

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="虚拟线程由 JVM 调度到少量载体线程上，阻塞时卸载">
<rect class="b1" x="30" y="30" width="400" height="124" rx="12"/>
<text class="th" x="46" y="54">虚拟线程（堆上，几十万个）</text>
<rect class="b2" x="50" y="72" width="70" height="34" rx="6"/>
<text class="t" x="85" y="89" text-anchor="middle" dominant-baseline="middle">VT-1</text>
<rect class="b2" x="130" y="72" width="70" height="34" rx="6"/>
<text class="t" x="165" y="89" text-anchor="middle" dominant-baseline="middle">VT-2</text>
<rect class="b2" x="210" y="72" width="70" height="34" rx="6"/>
<text class="t" x="245" y="89" text-anchor="middle" dominant-baseline="middle">VT-3</text>
<rect class="b" x="290" y="72" width="70" height="34" rx="6"/>
<text class="t" x="325" y="89" text-anchor="middle" dominant-baseline="middle">VT-4</text>
<rect class="b" x="370" y="72" width="50" height="34" rx="6"/>
<text class="t" x="395" y="89" text-anchor="middle" dominant-baseline="middle">…</text>
<text class="ts" x="50" y="132" text-anchor="start">栈是堆上的可增长对象（Continuation），初始仅几百字节</text>
<rect class="b3" x="30" y="206" width="400" height="84" rx="12"/>
<text class="th" x="46" y="230">ForkJoinPool 调度器（载体线程 ≈ CPU 核数）</text>
<rect class="b" x="50" y="244" width="110" height="34" rx="6"/>
<text class="tm" x="105" y="261" text-anchor="middle" dominant-baseline="middle">Carrier-1</text>
<rect class="b" x="180" y="244" width="110" height="34" rx="6"/>
<text class="tm" x="235" y="261" text-anchor="middle" dominant-baseline="middle">Carrier-2</text>
<rect class="b" x="310" y="244" width="110" height="34" rx="6"/>
<text class="tm" x="365" y="261" text-anchor="middle" dominant-baseline="middle">Carrier-3</text>
<line class="la" x1="85" y1="154" x2="105" y2="244" marker-end="url(#arr-a)"/>
<line class="la" x1="165" y1="154" x2="235" y2="244" marker-end="url(#arr-a)"/>
<text class="ta" x="260" y="190" text-anchor="start">运行：挂载(mount)到载体</text>
<rect class="b5" x="500" y="206" width="200" height="84" rx="12"/>
<text class="th" x="600" y="230" text-anchor="middle">操作系统线程 / 内核</text>
<text class="ts" x="600" y="256" text-anchor="middle">载体线程 = 平台线程</text>
<text class="ts" x="600" y="274" text-anchor="middle">数量少，切换开销小</text>
<line class="l" x1="420" y1="261" x2="500" y2="261" marker-end="url(#arr)"/>
<rect class="b4" x="500" y="30" width="200" height="124" rx="12"/>
<text class="th" x="600" y="54" text-anchor="middle">阻塞时（如 socket.read）</text>
<text class="ts" x="600" y="80" text-anchor="middle">1. 虚拟线程的栈从载体上卸载</text>
<text class="ts" x="600" y="100" text-anchor="middle">2. 载体线程立刻去运行其他虚拟线程</text>
<text class="ts" x="600" y="120" text-anchor="middle">3. IO 就绪后重新调度回载体继续</text>
<text class="ts" x="600" y="140" text-anchor="middle">同步代码、异步效果</text>
</svg>
<figcaption>图 1：虚拟线程在少量载体线程上 M:N 调度，阻塞时让出载体</figcaption>
</figure>

```java
// 每个任务一个虚拟线程，无需池化
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> futures = urls.stream()
            .map(u -> executor.submit(() -> httpGet(u)))      // 阻塞调用，但不占平台线程
            .toList();
    for (var f : futures) System.out.println(f.get());
}

Thread.ofVirtual().name("vt-", 0).start(() -> doWork());
```

### 使用边界

| 要点 | 说明 |
| --- | --- |
| 适合 | **高并发、IO 密集**（HTTP/RPC/数据库调用等待多） |
| 不适合 | **CPU 密集**：虚拟线程不会增加 CPU 算力，反而增加调度开销 |
| 不要池化 | 虚拟线程廉价，**一个任务一个线程**；限制并发用 `Semaphore`，而不是线程池大小 |
| **pinning** | 在 `synchronized` 块内或 native 方法中阻塞，虚拟线程会**钉住**载体线程无法卸载。JDK 21 中应改用 `ReentrantLock`；JDK 24（JEP 491）起 synchronized 的 pinning 已大幅缓解 |
| ThreadLocal | 仍可用，但百万线程下每个都带副本，内存压力大；考虑 ScopedValue（预览） |
| 连接池 | 下游资源（数据库连接）依然有限，虚拟线程再多也要排队；仍需限流 |
| 诊断 | `jcmd <pid> Thread.dump_to_file -format=json`；`-Djdk.tracePinnedThreads=full` 打印 pinning |

Spring Boot 3.2+：`spring.threads.virtual.enabled=true`，Tomcat 和 `@Async` 等使用虚拟线程。与线程池对比见 [线程池原理与调优](#/java/concurrency/pool)。

## 标准库与运行时

```java
var client = HttpClient.newHttpClient();                                  // 11：标准 HTTP/2 客户端
var req = HttpRequest.newBuilder(URI.create("https://example.com")).build();
String body = client.send(req, HttpResponse.BodyHandlers.ofString()).body();

String s = Files.readString(Path.of("a.txt"));                            // 11
RandomGenerator g = RandomGenerator.of("L64X128MixRandom");               // 17：统一随机数 API
```

- **GC**：G1（9+ 默认）→ ZGC（15 GA，21 分代 ZGC，`-XX:+UseZGC -XX:+ZGenerational`，23 起默认分代）；
- **CDS / AppCDS**：类数据共享，缩短启动时间；
- **JFR** 开源并随 JDK 提供（11+），可低开销常驻；
- **友好 NPE**：`Cannot invoke "String.length()" because "user.name" is null`。

## 从 8 升级到 17 / 21 的迁移清单

1. **JDK 内部 API 强封装**（16 默认、17 强制）：反射访问 `sun.misc.Unsafe` 之外的内部类报 `InaccessibleObjectException`，需 `--add-opens java.base/java.lang=ALL-UNNAMED`，更好的做法是升级依赖（Lombok、Mockito、ByteBuddy、Spring、Netty、Jackson 等的新版本已适配）；
2. **被移除/变化**：Java EE 模块（JAXB、JAX-WS、`javax.annotation`）在 11 移除，需显式引入依赖；`Nashorn` 移除；`-XX:+UseConcMarkSweepGC` 在 14 移除；`Thread.stop` 等；`SecurityManager` 废弃；
3. **`javax.*` → `jakarta.*`**：Spring Boot 3 / Jakarta EE 9+ 起包名变化，涉及 Servlet、JPA、Validation 等，使用 OpenRewrite 迁移脚本批量替换；
4. **GC 参数**：JDK 8 的 `-XX:+PrintGCDetails` 等参数在 9+ 被统一日志替代，旧参数会使 JVM 启动失败；
5. **默认字符集**：18 起 UTF-8，文件读写不要依赖平台默认；
6. **构建工具**：Maven 编译插件设 `<maven.compiler.release>17</maven.compiler.release>`，见 [Maven 构建与依赖管理](#/java/eng/maven)；
7. **容器**：JDK 10+ 原生支持容器感知（8u191 起回移植）；
8. **验证**：先在测试环境用新 JDK 跑完整测试与压测；对比 GC 日志与吞吐；灰度发布。

> [!TIP] 渐进式升级
> 先让项目在 JDK 17 上**编译并运行**（保持语法级别 8），解决依赖与内部 API 问题；稳定后再逐步使用新语法特性。

## 面试追问

> [!QUESTION] 虚拟线程和平台线程的区别？
> 平台线程与 OS 线程一对一，栈固定且较大，数量受限；虚拟线程由 JVM 调度，栈在堆上按需增长，数量可达百万，阻塞时卸载载体线程，使同步阻塞代码获得高并发。

> [!QUESTION] 虚拟线程有什么限制与坑？
> 不适合 CPU 密集；不应池化；`synchronized` 内阻塞会 pin 住载体线程（21 中尤为明显）；ThreadLocal 在大量线程下内存开销；下游资源（连接池）仍是瓶颈，需要限流。

> [!QUESTION] record、sealed 和模式匹配组合有什么价值？
> record 提供不可变数据载体，sealed 限定可能的子类型，switch 模式匹配可解构并由编译器检查穷尽性，形成类似代数数据类型的建模方式，新增子类型漏处理会编译失败。

> [!QUESTION] 8 升级到 17 最常见的坑？
> 内部 API 强封装导致反射失败，需要升级依赖或加 `--add-opens`；Java EE 模块移除需显式引入；JVM 旧参数无效；Spring Boot 3 的 jakarta 包名迁移。

> [!QUESTION] G1 和 ZGC 怎么选？
> 大多数应用用默认 G1；对停顿极度敏感（亚毫秒）、堆很大（几十 GB 以上）考虑 ZGC，代价是吞吐略低和更多内存占用，详见 [G1 与 ZGC 深入](#/java/jvm/collectors)。
