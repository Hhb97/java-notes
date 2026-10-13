---
level: 进阶
tags: [Lambda, invokedynamic, LambdaMetafactory, Stream, Sink, 并行流, ForkJoinPool]
summary: Lambda 如何通过 invokedynamic + LambdaMetafactory 在运行时生成实现类，Stream 流水线的 Stage/Sink 结构、惰性与短路，以及并行流和公共池的生产坑
---

# Lambda 与 Stream

> [!ABSTRACT] 核心要点
> - lambda 体被编译成当前类的私有方法 `lambda$方法名$N`，调用点是一条 `invokedynamic`；首次执行时引导方法 `LambdaMetafactory.metafactory` 在运行时生成一个实现函数式接口的隐藏类，之后调用点被永久链接。
> - **非捕获** lambda 每次求值返回同一个实例；**捕获**变量的 lambda 每次求值都 new 一个对象（捕获值存为字段），捕获 `this` 还会延长外部对象的生命周期。
> - Stream 由一串 Stage 组成的双向链表，中间操作只是「搭积木」；终端操作从后往前把每个 Stage 包装成 `Sink` 链，再让元素**逐个**穿过整条链（垂直执行，而非一个操作做完再做下一个）。
> - `sorted`/`distinct` 是有状态屏障；`findFirst`/`anyMatch`/`limit` 通过 `cancellationRequested()` 短路。
> - 并行流默认使用 JVM 全局共享的 `ForkJoinPool.commonPool()`，在其中做阻塞 IO 会拖垮所有并行流和默认的 `CompletableFuture` 异步任务。

## Lambda 是怎么实现的

### 编译产物

```java
public class L {
    int base = 1;
    Supplier<Integer> a()            { return () -> 42; }          // 非捕获
    Function<Integer,Integer> b(int k) { return x -> x + k; }      // 捕获局部变量
    Function<Integer,Integer> c()    { return x -> x + base; }     // 捕获 this
    Function<String,Integer> d()     { return String::length; }    // 方法引用
}
```

```text
$ javap -p -c L（节选）
  private static Integer lambda$a$0();                 // 非捕获 → 静态方法
  private static Integer lambda$b$1(int, Integer);     // 捕获的 k 变成前置参数
  private Integer lambda$c$2(Integer);                 // 用到 this → 实例方法
  a(): invokedynamic #0:get:()Ljava/util/function/Supplier;
  b(): iload_1
       invokedynamic #1:apply:(I)Ljava/util/function/Function;     // 捕获值作为 indy 参数
  c(): aload_0
       invokedynamic #2:apply:(LL;)Ljava/util/function/Function;   // 捕获 this
  d(): invokedynamic #3:apply:()Ljava/util/function/Function;      // 方法引用不生成 lambda$ 方法
BootstrapMethods:
  LambdaMetafactory.metafactory(Lookup, String, MethodType, MethodType samType,
                                MethodHandle implMethod, MethodType instantiatedType)
```

### 运行时链接

<figure class="fig">
<svg viewBox="0 0 720 250" class="dg" role="img" aria-label="invokedynamic 首次执行调用 LambdaMetafactory 生成隐藏类并返回 ConstantCallSite，之后调用点直接返回函数对象">
<text class="ts" x="345" y="28" text-anchor="middle">首次执行：调用引导方法</text>
<rect class="b1" x="20" y="40" width="170" height="48" rx="8"/>
<text class="tm" x="105" y="64" text-anchor="middle" dominant-baseline="middle">invokedynamic apply</text>
<line class="l" x1="190" y1="64" x2="230" y2="64" marker-end="url(#arr)"/>
<rect class="b3" x="230" y="40" width="230" height="48" rx="8"/>
<text class="tm" x="345" y="64" text-anchor="middle" dominant-baseline="middle">LambdaMetafactory.metafactory</text>
<line class="l" x1="460" y1="64" x2="500" y2="64" marker-end="url(#arr)"/>
<rect class="b2" x="500" y="40" width="200" height="48" rx="8"/>
<text class="tb" x="600" y="64" text-anchor="middle" dominant-baseline="middle">生成隐藏类 L$$Lambda</text>
<text class="ts" x="600" y="106" text-anchor="middle">apply() 内调用 lambda$b$1</text>
<text class="ts" x="600" y="124" text-anchor="middle">JDK 15+ 为 Hidden Class</text>
<line class="l" x1="600" y1="132" x2="600" y2="150" marker-end="url(#arr)"/>
<rect class="b5" x="500" y="150" width="200" height="48" rx="8"/>
<text class="tm" x="600" y="174" text-anchor="middle" dominant-baseline="middle">ConstantCallSite</text>
<line class="l" x1="500" y1="174" x2="460" y2="174" marker-end="url(#arr)"/>
<rect class="b" x="230" y="150" width="230" height="48" rx="8"/>
<text class="tb" x="345" y="174" text-anchor="middle" dominant-baseline="middle">永久链接到该 indy 指令</text>
<text class="ts" x="345" y="216" text-anchor="middle">后续执行不再走引导方法</text>
<line class="la" x1="230" y1="174" x2="190" y2="174" marker-end="url(#arr-a)"/>
<rect class="b4" x="20" y="150" width="170" height="48" rx="8"/>
<text class="tb" x="105" y="174" text-anchor="middle" dominant-baseline="middle">返回函数对象</text>
<text class="ts" x="105" y="216" text-anchor="middle">非捕获：始终同一实例</text>
<text class="ts" x="105" y="234" text-anchor="middle">捕获：每次 new，字段存捕获值</text>
</svg>
<figcaption>图 1：lambda 调用点的引导与链接过程</figcaption>
</figure>

为什么不像匿名内部类那样在编译期生成 class 文件？

1. **把实现策略推迟到运行时**：字节码里只记录「要一个 Function，实现是 `lambda$b$1`」，至于是生成内部类、用 MethodHandle 还是将来的值类型，由 JDK 决定，旧字节码自动受益。
2. **按需生成**：没执行到的 lambda 不产生任何类，jar 中也不会有成百上千个 `$1.class`。
3. **非捕获 lambda 零分配**：CallSite 直接绑定一个常量实例。

代价是**首次调用有引导开销**：应用中第一个 lambda 要初始化整个 `java.lang.invoke` 基础设施（启动阶段可观测到数十毫秒级），每个调用点首次执行也要生成一个类。对启动敏感的场景（CLI、Serverless）可以用 AppCDS 归档 lambda 类，或 JDK 24+ 的 AOT 缓存。

### 捕获与非捕获

| 类型 | 例子 | 每次求值 | 注意 |
| --- | --- | --- | --- |
| 非捕获 | `() -> 42`、`String::length` | 同一个实例 | 不要依赖这个行为做 `==` 判断 |
| 捕获局部变量 | `x -> x + k` | 新对象，`k` 存为字段 | 变量须 effectively final（值被复制） |
| 捕获 `this` | `x -> x + base` | 新对象，持有外部实例 | 注册到长生命周期对象上会导致泄漏 |
| 绑定接收者的方法引用 | `obj::method` | 新对象，并且**立即**对 `obj` 判空 | `null::m` 在创建时就 NPE，而 lambda 是调用时才 NPE |

JIT 的逃逸分析常能把热点路径上的捕获 lambda 分配消除掉，但在超多态调用点（见 [继承与多态](#/java/oop/inherit)）这一优化会失效。

## Stream 流水线

### Stage 链与 Sink 链

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Stream 中间操作构建 Stage 双向链表，终端操作从后往前包装出 Sink 链，元素逐个从 Spliterator 推入 Sink 链">
<text class="ts" x="20" y="24">构建阶段：每个中间操作 new 一个 Stage（previousStage / nextStage），此时什么都不执行</text>
<rect class="b" x="20" y="40" width="124" height="56" rx="8"/>
<text class="tb" x="82" y="60" text-anchor="middle" dominant-baseline="middle">source</text>
<text class="ts" x="82" y="82" text-anchor="middle">Head</text>
<line class="l" x1="144" y1="68" x2="164" y2="68" marker-end="url(#arr)"/>
<rect class="b1" x="164" y="40" width="124" height="56" rx="8"/>
<text class="tb" x="226" y="60" text-anchor="middle" dominant-baseline="middle">filter</text>
<text class="ts" x="226" y="82" text-anchor="middle">StatelessOp</text>
<line class="l" x1="288" y1="68" x2="308" y2="68" marker-end="url(#arr)"/>
<rect class="b1" x="308" y="40" width="124" height="56" rx="8"/>
<text class="tb" x="370" y="60" text-anchor="middle" dominant-baseline="middle">map</text>
<text class="ts" x="370" y="82" text-anchor="middle">StatelessOp</text>
<line class="l" x1="432" y1="68" x2="452" y2="68" marker-end="url(#arr)"/>
<rect class="b3" x="452" y="40" width="124" height="56" rx="8"/>
<text class="tb" x="514" y="60" text-anchor="middle" dominant-baseline="middle">sorted</text>
<text class="ts" x="514" y="82" text-anchor="middle">StatefulOp</text>
<line class="l" x1="576" y1="68" x2="596" y2="68" marker-end="url(#arr)"/>
<rect class="b4" x="596" y="40" width="124" height="56" rx="8"/>
<text class="tb" x="658" y="60" text-anchor="middle" dominant-baseline="middle">collect</text>
<text class="ts" x="658" y="82" text-anchor="middle">终端操作</text>
<text class="ts" x="20" y="130">终端操作触发 wrapSink：从最后一个 Stage 往前，每个 Stage 用 opWrapSink 把下游 Sink 包一层</text>
<rect class="b" x="20" y="150" width="124" height="50" rx="8"/>
<text class="tb" x="82" y="175" text-anchor="middle" dominant-baseline="middle">Spliterator</text>
<line class="la" x1="144" y1="175" x2="164" y2="175" marker-end="url(#arr-a)"/>
<rect class="b1" x="164" y="150" width="124" height="50" rx="8"/>
<text class="tb" x="226" y="175" text-anchor="middle" dominant-baseline="middle">filter Sink</text>
<line class="la" x1="288" y1="175" x2="308" y2="175" marker-end="url(#arr-a)"/>
<rect class="b1" x="308" y="150" width="124" height="50" rx="8"/>
<text class="tb" x="370" y="175" text-anchor="middle" dominant-baseline="middle">map Sink</text>
<line class="la" x1="432" y1="175" x2="452" y2="175" marker-end="url(#arr-a)"/>
<rect class="b3" x="452" y="150" width="124" height="50" rx="8"/>
<text class="tb" x="514" y="175" text-anchor="middle" dominant-baseline="middle">SortedOps Sink</text>
<line class="la" x1="576" y1="175" x2="596" y2="175" marker-end="url(#arr-a)"/>
<rect class="b4" x="596" y="150" width="124" height="50" rx="8"/>
<text class="tb" x="658" y="175" text-anchor="middle" dominant-baseline="middle">ReducingSink</text>
<text class="ts" x="82" y="220" text-anchor="middle">forEachRemaining</text>
<text class="ts" x="226" y="220" text-anchor="middle">不满足则不调下游</text>
<text class="ts" x="370" y="220" text-anchor="middle">accept(f(t))</text>
<text class="ts" x="514" y="220" text-anchor="middle">先缓冲，end() 时</text>
<text class="ts" x="514" y="238" text-anchor="middle">排序后再逐个下推</text>
<text class="ts" x="658" y="220" text-anchor="middle">累加到容器</text>
<text class="ts" x="20" y="268">短路操作：copyIntoWithCancel 在推送每个元素前检查 sink.cancellationRequested()</text>
</svg>
<figcaption>图 2：Stream 的 Stage 链（构建期）与 Sink 链（执行期）</figcaption>
</figure>

```java
// JDK 17 AbstractPipeline（节选）
final <P_IN> Sink<P_IN> wrapSink(Sink<E_OUT> sink) {
    for (AbstractPipeline p = this; p.depth > 0; p = p.previousStage) {
        sink = p.opWrapSink(p.previousStage.combinedFlags, sink);   // 从后往前一层层包装
    }
    return (Sink<P_IN>) sink;
}

final <P_IN> void copyInto(Sink<P_IN> wrappedSink, Spliterator<P_IN> spliterator) {
    if (!StreamOpFlag.SHORT_CIRCUIT.isKnown(getStreamAndOpFlags())) {
        wrappedSink.begin(spliterator.getExactSizeIfKnown());
        spliterator.forEachRemaining(wrappedSink);                  // 每个元素穿过整条 Sink 链
        wrappedSink.end();
    } else {
        copyIntoWithCancel(wrappedSink, spliterator);               // 每个元素前检查是否可以停止
    }
}

// filter 的 opWrapSink：不满足条件就不调用 downstream
return new Sink.ChainedReference<P_OUT, P_OUT>(sink) {
    public void accept(P_OUT u) { if (predicate.test(u)) downstream.accept(u); }
};
```

### 惰性与执行顺序

```java
Stream.of("a", "bb", "ccc")
      .filter(s -> { System.out.println("filter " + s); return s.length() > 1; })
      .map(s -> { System.out.println("map " + s); return s.toUpperCase(); })
      .findFirst();
// 输出：filter a / filter bb / map bb —— 逐元素垂直执行，找到第一个后立即停止，"ccc" 根本没被处理
```

- 没有终端操作，中间操作一行都不执行。`peek` 用来调试可以，用来做业务副作用很危险：JDK 9 起 `count()` 在能直接算出大小时会跳过整个流水线，`peek` 不会被调用。
- 一个 Stream 只能消费一次，重复使用抛 `IllegalStateException: stream has already been operated upon or closed`。
- Stream 还会利用标志位优化：源是 `SORTED` 时 `sorted()` 变成空操作，源是 `DISTINCT`（如 `Set`）时 `distinct()` 被跳过。

### 常用 Collector 的坑

```java
// 1. toMap 遇到重复 key 直接抛 IllegalStateException: Duplicate key
Map<Long, User> m = users.stream().collect(Collectors.toMap(User::getId, u -> u));
// 正确：提供合并函数，并按需指定 Map 实现
Map<Long, User> m2 = users.stream()
        .collect(Collectors.toMap(User::getId, u -> u, (a, b) -> b, LinkedHashMap::new));

// 2. toMap 的 value 为 null 时 NPE（内部用 HashMap.merge，merge 不允许 null 值）
Map<Long, String> names = users.stream().collect(Collectors.toMap(User::getId, User::getNickname)); // nickname 为 null 即 NPE

// 3. groupingBy 默认 HashMap + ArrayList，需要有序/并发时显式指定
Map<Status, Long> cnt = orders.stream()
        .collect(Collectors.groupingBy(Order::getStatus, () -> new EnumMap<>(Status.class), Collectors.counting()));
```

## 并行流

<figure class="fig">
<svg viewBox="0 0 720 240" class="dg" role="img" aria-label="所有并行流和默认的 CompletableFuture 异步任务共享 ForkJoinPool 公共池，阻塞任务会占满 worker 导致其他任务排队">
<rect class="b1" x="20" y="30" width="210" height="40" rx="8"/>
<text class="tm" x="125" y="50" text-anchor="middle" dominant-baseline="middle">接口 A：parallelStream</text>
<rect class="b1" x="20" y="90" width="210" height="40" rx="8"/>
<text class="tm" x="125" y="110" text-anchor="middle" dominant-baseline="middle">接口 B：parallelStream</text>
<rect class="b1" x="20" y="150" width="210" height="40" rx="8"/>
<text class="tm" x="125" y="170" text-anchor="middle" dominant-baseline="middle">CF.supplyAsync(task)</text>
<line class="l" x1="230" y1="50" x2="290" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="230" y1="110" x2="290" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="230" y1="170" x2="290" y2="140" marker-end="url(#arr)"/>
<rect class="b3" x="290" y="30" width="200" height="160" rx="10"/>
<text class="tb" x="390" y="52" text-anchor="middle" dominant-baseline="middle">ForkJoinPool</text>
<text class="tm" x="390" y="74" text-anchor="middle" dominant-baseline="middle">commonPool()</text>
<text class="ts" x="390" y="96" text-anchor="middle">并行度 = CPU 数 - 1</text>
<rect class="b4" x="306" y="120" width="52" height="34" rx="4"/>
<text class="tm" x="332" y="137" text-anchor="middle" dominant-baseline="middle">W1</text>
<rect class="b4" x="364" y="120" width="52" height="34" rx="4"/>
<text class="tm" x="390" y="137" text-anchor="middle" dominant-baseline="middle">W2</text>
<rect class="b4" x="422" y="120" width="52" height="34" rx="4"/>
<text class="tm" x="448" y="137" text-anchor="middle" dominant-baseline="middle">W3</text>
<text class="ts" x="390" y="176" text-anchor="middle">调用线程也参与执行</text>
<line class="la" x1="490" y1="110" x2="530" y2="110" marker-end="url(#arr-a)"/>
<rect class="b4" x="530" y="50" width="170" height="120" rx="10"/>
<text class="tb" x="615" y="72" text-anchor="middle" dominant-baseline="middle">全局共享的后果</text>
<text class="ts" x="615" y="98" text-anchor="middle">接口 A 做阻塞 IO</text>
<text class="ts" x="615" y="118" text-anchor="middle">占满全部 worker</text>
<text class="ts" x="615" y="138" text-anchor="middle">B 与异步任务排队</text>
<text class="ts" x="615" y="158" text-anchor="middle">RT 雪崩</text>
<text class="ts" x="20" y="216">并行度 ≤ 1 时（容器只分配 1～2 核），CompletableFuture 默认执行器退化为每个任务新建线程</text>
<text class="ts" x="20" y="234">调整：-Djava.util.concurrent.ForkJoinPool.common.parallelism=N，或为业务显式传入独立线程池</text>
</svg>
<figcaption>图 3：并行流与公共 ForkJoinPool 的共享关系</figcaption>
</figure>

并行流 = `Spliterator.trySplit()` 递归拆分数据源 + ForkJoin 任务并行执行 + 合并结果。是否值得并行取决于：

| 因素 | 适合并行 | 不适合并行 |
| --- | --- | --- |
| 数据源可拆分性 | `ArrayList`、数组、`IntStream.range`（均匀二分） | `LinkedList`、`Stream.iterate`、`BufferedReader.lines()`（拆分代价高或不均） |
| 单元素计算量 | CPU 密集、计算量大（N × Q 足够大） | 简单映射、数据量小（几千以内通常更慢） |
| 操作特性 | 无状态、可结合的归约 | `sorted`、`limit`、`findFirst` 等依赖顺序的操作；`forEachOrdered` |
| 副作用 | 无 | 往共享的 `ArrayList`/`HashMap` 里 add（线程不安全，丢数据或抛异常） |
| 执行环境 | 离线批处理、独占 CPU 的计算任务 | Web 请求线程、容器 CPU 配额很小 |

## 性能取舍

| 写法 | 特点 |
| --- | --- |
| 普通 for 循环 | 无额外分配，JIT 最容易优化（循环展开、向量化），最可预测 |
| 顺序 Stream | 有 Stage/Sink 对象与 lambda 调用开销，小集合上可能慢数倍；热点路径中 Sink 调用点容易超多态；大集合 + 复杂操作时差距缩小 |
| `IntStream`/`LongStream` | 避免装箱，数值计算务必使用（`mapToInt(...).sum()` 而不是 `map(...).reduce(0, Integer::sum)`） |
| 并行 Stream | 只有数据量大、CPU 密集且独占线程池时才有收益 |

结论：Stream 的价值在**可读性和声明式表达**，不是性能。业务代码放心用；底层库、每秒百万次调用的热点循环用普通循环。用 JMH 测量而不是凭感觉。

## 关键参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `java.util.concurrent.ForkJoinPool.common.parallelism` | CPU 数 - 1（最小 1） | 公共池并行度 |
| `-XX:ActiveProcessorCount` | 自动探测 | 影响 `availableProcessors()`，从而影响公共池并行度 |
| `-Djdk.internal.lambda.dumpProxyClasses=<dir>` | 关闭 | 导出 lambda 生成的类用于排查（新版本 JDK 属性名有调整，以对应版本文档为准） |

## 生产实践与踩坑

### 并行流里调用远程服务

现象：某接口为了加速，用 `ids.parallelStream().map(rpc::query)` 并发查询，压测时整个应用其他使用并行流/`CompletableFuture.supplyAsync()` 的接口全部变慢。原因见图 3。修复：IO 并发使用独立线程池 + `CompletableFuture.supplyAsync(task, ioExecutor)`，或 JDK 21 虚拟线程；并行流只用于纯 CPU 计算。

> [!TIP] 用自定义 ForkJoinPool 执行并行流
> `customPool.submit(() -> list.parallelStream().map(...).toList()).get()` 能让并行流的任务在 `customPool` 中执行——这依赖「ForkJoin 任务在当前 worker 所属池中 fork」的实现细节，并非规范保证，只能作为过渡手段。

### 异常栈难以阅读

lambda 中抛出的异常栈里是 `lambda$process$3` 和大量 `ReferencePipeline$3$1.accept` 帧，定位困难。复杂逻辑抽成具名私有方法再用方法引用，异常栈里就能看到有意义的方法名；同时也便于单元测试。

### 受检异常与 lambda

`Function.apply` 没有声明受检异常，lambda 内调用 `Files.readString` 必须 try-catch。不要用「偷偷抛出（sneaky throw）」把受检异常藏起来，调用方根本不知道要处理。推荐在边界包装为业务运行时异常并保留 cause。

### `Optional` 的常见误用

- `orElse(createDefault())` 无论是否为空都会执行 `createDefault()`，有副作用或开销大时用 `orElseGet`。
- `Optional` 设计用于返回值，不要用作字段、方法参数或集合元素（不可序列化，增加分配）。
- `Optional.of(null)` 直接 NPE，可能为 null 时用 `ofNullable`。

## 相关阅读

- [Java 8–21 新特性](#/java/modern/features)：Java 8–21 新特性
- [集合体系总览](#/java/api/collections)：集合与 Stream
- [并发工具与 CompletableFuture](#/java/concurrency/juc)：CompletableFuture 与并行流

## 面试追问

> [!QUESTION] Lambda 和匿名内部类在实现上有什么区别？
> 匿名内部类编译期生成 `Outer$1.class`，每次求值 new 对象，总是持有外部实例；lambda 编译为私有方法 + `invokedynamic`，运行时由 `LambdaMetafactory` 生成隐藏类，非捕获 lambda 是单例，只有用到实例成员时才捕获 `this`。另外 lambda 中的 `this` 指外部类实例，不引入新的变量作用域。

> [!QUESTION] 为什么 lambda 引用的局部变量必须是 effectively final？
> 捕获是值拷贝：变量值作为 indy 参数传入并存为生成类的字段。若允许修改，lambda 内外两份拷贝会不一致，并且局部变量在栈上、生命周期短于 lambda，无法共享同一存储。

> [!QUESTION] Stream 的中间操作为什么是惰性的？元素是如何流动的？
> 中间操作只创建 Stage 节点；终端操作调用 `wrapSink` 从后往前把各 Stage 包成 Sink 链，再由 Spliterator 把元素逐个推入链首，每个元素依次穿过所有操作。这样可以融合多个操作为一次遍历，并支持短路。

> [!QUESTION] `sorted()` 在流水线中有什么特殊之处？
> 它是有状态的屏障操作：其 Sink 在 `accept` 中只缓冲元素，在 `end()` 时排序后才逐个推给下游，因此会打断逐元素的垂直执行，也使后续短路操作无法减少上游的工作量。

> [!QUESTION] 并行流有哪些坑？
> 共享公共 ForkJoinPool，阻塞任务会影响全局；数据源拆分不均（LinkedList、iterate）收益为负；有序操作代价高；对共享可变状态的副作用线程不安全；容器 CPU 识别不准时并行度可能只有 1。
