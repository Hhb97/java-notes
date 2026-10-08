---
level: 基础
tags: [JDK, JVM, 字节码, JIT, 分层编译]
summary: 从 javac 到 JIT 的完整执行链路、class 文件版本、JDK 发行版与容器环境下的启动要点
---

# 语言概览与环境

> [!ABSTRACT] 核心要点
> - Java 是「先编译成字节码、运行时再编译成机器码」的语言：`javac` 只做语法/语义检查与少量脱糖，真正的性能优化发生在 JVM 的 JIT（C1/C2）里。
> - class 文件头的 major version 决定能在哪个 JVM 上运行：52=8、55=11、61=17、65=21、69=25；高版本编译、低版本运行就是 `UnsupportedClassVersionError`。
> - 交叉编译用 `--release N`，而不是 `-source/-target`——后者不会限制你调用高版本才有的 API。
> - 生产上「刚发布 CPU 飙高、RT 抖动」多半是 JIT 预热；CodeCache 打满会让 JIT 停摆，性能断崖式下降。
> - LTS：8、11、17、21、25（自 17 起每两年一个 LTS）；新项目首选 21 / 25，JDK 11 起不再单独提供 JRE，用 `jlink` 裁剪运行时。

## 从源码到机器码

### 一条完整的执行链路

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="Java 源码经 javac 编译为字节码，再由 JVM 类加载、解释执行并经 JIT 编译为本地机器码">
<rect class="b1" x="20" y="40" width="110" height="48" rx="8"/>
<text class="tb" x="75" y="64" text-anchor="middle" dominant-baseline="middle">Hello.java</text>
<line class="l" x1="130" y1="64" x2="170" y2="64" marker-end="url(#arr)"/>
<text class="ts" x="150" y="32" text-anchor="middle">javac</text>
<rect class="b2" x="170" y="40" width="120" height="48" rx="8"/>
<text class="tb" x="230" y="64" text-anchor="middle" dominant-baseline="middle">Hello.class</text>
<text class="ts" x="230" y="106" text-anchor="middle">CAFEBABE + 版本号</text>
<text class="ts" x="230" y="122" text-anchor="middle">常量池 / 方法字节码</text>
<line class="l" x1="290" y1="64" x2="350" y2="64" marker-end="url(#arr)"/>
<text class="ts" x="320" y="54" text-anchor="middle">加载</text>
<rect class="bg" x="335" y="16" width="405" height="228" rx="12"/>
<text class="ts" x="350" y="32">JVM 进程</text>
<rect class="b" x="350" y="40" width="160" height="48" rx="8"/>
<text class="tb" x="430" y="64" text-anchor="middle" dominant-baseline="middle">类加载子系统</text>
<line class="l" x1="510" y1="64" x2="550" y2="64" marker-end="url(#arr)"/>
<rect class="b" x="550" y="40" width="170" height="48" rx="8"/>
<text class="tb" x="635" y="64" text-anchor="middle" dominant-baseline="middle">运行时数据区</text>
<text class="ts" x="635" y="104" text-anchor="middle">堆 / 栈 / 元空间 / CodeCache</text>
<text class="ts" x="350" y="140">执行引擎</text>
<rect class="b3" x="350" y="150" width="110" height="48" rx="8"/>
<text class="tb" x="405" y="174" text-anchor="middle" dominant-baseline="middle">解释器</text>
<line class="la" x1="460" y1="174" x2="480" y2="174" marker-end="url(#arr-a)"/>
<rect class="b3" x="480" y="150" width="110" height="48" rx="8"/>
<text class="tb" x="535" y="174" text-anchor="middle" dominant-baseline="middle">C1 编译器</text>
<line class="la" x1="590" y1="174" x2="610" y2="174" marker-end="url(#arr-a)"/>
<rect class="b4" x="610" y="150" width="110" height="48" rx="8"/>
<text class="tb" x="665" y="174" text-anchor="middle" dominant-baseline="middle">C2 编译器</text>
<text class="ts" x="535" y="222" text-anchor="middle">方法调用 / 循环回边计数达到阈值即升级</text>
<rect class="b5" x="20" y="150" width="150" height="48" rx="8"/>
<text class="tb" x="95" y="174" text-anchor="middle" dominant-baseline="middle">本地机器码</text>
<line class="l" x1="350" y1="190" x2="170" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="260" y="182" text-anchor="middle">热点代码编译后</text>
<text class="ts" x="260" y="210" text-anchor="middle">存入 CodeCache 直接执行</text>
</svg>
<figcaption>图 1：Java 程序从源码到机器码的执行链路</figcaption>
</figure>

几个经常被说错的点：

- **`javac` 几乎不做优化**。它只做常量折叠（`"a" + "b"` → `"ab"`、`static final int` 内联）和语法糖脱糖（泛型擦除、自动装箱、增强 for、内部类、`switch` on String 等）。循环展开、内联、逃逸分析、锁消除全部是 JIT 的事。所以「看字节码判断性能」只能看个大概。
- **解释器并不慢到不可用**，它是模板解释器（Template Interpreter），每条字节码对应一段预生成的机器码模板；但它没有跨字节码的优化，热点代码必须交给 JIT。
- **JIT 的结果是基于 profiling 的乐观假设**，比如「这个虚方法调用点只出现过一种实现类」，于是直接内联。假设被打破（加载了新的子类）时会**去优化（deoptimization）**回到解释执行。

### 分层编译（Tiered Compilation）

JDK 8 起默认开启分层编译，把执行分成 5 个层级：

<figure class="fig">
<svg viewBox="0 0 720 220" class="dg" role="img" aria-label="分层编译：Level 0 解释执行，Level 3 C1 带完整 profiling，Level 4 C2 编译，假设失效时去优化回 Level 0">
<text class="ts" x="20" y="24">Level 1/2：C1 无/有限 profiling，用于 trivial 方法或 C2 队列积压时</text>
<rect class="b" x="20" y="80" width="130" height="56" rx="8"/>
<text class="tm" x="85" y="100" text-anchor="middle" dominant-baseline="middle">Level 0</text>
<text class="t" x="85" y="120" text-anchor="middle" dominant-baseline="middle">解释器</text>
<line class="l" x1="150" y1="108" x2="210" y2="108" marker-end="url(#arr)"/>
<text class="ts" x="180" y="66" text-anchor="middle">计数达阈值</text>
<rect class="b3" x="210" y="80" width="180" height="56" rx="8"/>
<text class="tm" x="300" y="100" text-anchor="middle" dominant-baseline="middle">Level 3</text>
<text class="t" x="300" y="120" text-anchor="middle" dominant-baseline="middle">C1 + 完整 profiling</text>
<line class="la" x1="390" y1="108" x2="460" y2="108" marker-end="url(#arr-a)"/>
<text class="ts" x="425" y="66" text-anchor="middle">更热</text>
<rect class="b4" x="460" y="80" width="170" height="56" rx="8"/>
<text class="tm" x="545" y="100" text-anchor="middle" dominant-baseline="middle">Level 4</text>
<text class="t" x="545" y="120" text-anchor="middle" dominant-baseline="middle">C2 激进优化</text>
<line class="ld" x1="545" y1="136" x2="545" y2="180"/>
<line class="ld" x1="545" y1="180" x2="85" y2="180"/>
<line class="ld" x1="85" y1="180" x2="85" y2="136" marker-end="url(#arr)"/>
<text class="ts" x="315" y="200" text-anchor="middle">去优化：内联/类型假设失效（如加载了新子类）→ 回到解释执行再重新收集 profile</text>
</svg>
<figcaption>图 2：分层编译的典型升级路径 0 → 3 → 4 与去优化</figcaption>
</figure>

C1 编译快、优化浅；C2 编译慢、优化深（内联、逃逸分析、循环优化、向量化）。分层的意义是：**先用 C1 让代码尽快跑成本地码，同时收集 profile，再用 C2 根据 profile 做激进优化**。

## class 文件与版本

### 文件结构速览

```text
ClassFile {
    u4 magic;               // 0xCAFEBABE
    u2 minor_version;
    u2 major_version;       // 52=8 55=11 61=17 65=21 69=25
    u2 constant_pool_count;
    cp_info constant_pool[]; // 字面量、类/方法/字段的符号引用
    u2 access_flags;
    u2 this_class; u2 super_class;
    u2 interfaces_count; ...
    fields[]; methods[];    // 方法体在 Code 属性里
    attributes[];
}
```

用 `javap -v Hello.class | head` 就能看到 `major version`。排查「这个 jar 是用哪个 JDK 编的」时非常好用。字节码指令细节见 [字节码与执行引擎](#/java/jvm/bytecode)，加载过程见 [类加载与双亲委派](#/java/jvm/classloader)。

### `--release` 与 `-source/-target`

```bash
# 错误示范：用 JDK 17 编译、目标 8，但代码里调了 JDK 11 的 String#isBlank
javac -source 8 -target 8 Foo.java     # 编译通过！运行在 JDK 8 上 NoSuchMethodError

# 正确：--release 会用目标版本的 API 签名（ct.sym）做校验
javac --release 8 Foo.java             # 编译期直接报错
```

Maven 中对应 `maven.compiler.release` 属性，见 [Maven 构建与依赖管理](#/java/eng/maven)。

## JDK 组成与发行版

| 概念 | 说明 |
| --- | --- |
| JVM | HotSpot 是事实标准；另有 OpenJ9（内存占用低）、GraalVM（含 Graal JIT 与 Native Image） |
| JRE | JDK 11 起官方不再单独发布，用 `jlink --add-modules ... --output rt` 裁剪出最小运行时 |
| JDK | 编译器 + 工具链：`javac` `javap` `jar` `jlink` `jcmd` `jfr` `jshell` 等 |

| 发行版 | 特点 |
| --- | --- |
| Oracle JDK | 17 起采用 NFTC 许可，LTS 免费期有限制，商用前务必核对许可条款 |
| Eclipse Temurin | 社区构建，最常见的「默认 OpenJDK」选择 |
| Amazon Corretto / Alibaba Dragonwell / Azul Zulu | 厂商长期维护，部分带特性回移（如 Dragonwell 的协程、Wisp） |

> [!NOTE] 版本节奏
> JDK 9 起每 6 个月一个特性版本。LTS 原本每 3 年一个（11、17），从 17 开始改为每 2 年（17 → 21 → 25）。非 LTS 版本只维护到下一个版本发布，生产不要用。

## 关键启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-XX:+UseContainerSupport` | 开启（JDK 10+，8u191+） | 让 JVM 读取 cgroup 的 CPU/内存限制 |
| `-XX:MaxRAMPercentage` | 25.0 | 未指定 `-Xmx` 时最大堆 = 容器内存 × 25%，容器里通常调到 60～75 |
| `-XX:+TieredCompilation` | 开启 | 分层编译，一般不要关 |
| `-XX:ReservedCodeCacheSize` | 分层编译下默认约 240MB | JIT 产物存放区，满了 JIT 会停止 |
| `-XX:ActiveProcessorCount` | 自动探测 | 容器 CPU 识别不准时手动指定，影响 GC 线程数、ForkJoin 并行度 |
| `JAVA_TOOL_OPTIONS` | 环境变量 | 所有 JVM 启动都会读取，适合在镜像里统一注入参数 |

## 生产实践与踩坑

### 发布后 CPU 尖刺与 RT 抖动

现象：新实例接入流量后前几十秒 CPU 打满、P99 飙高，之后自然恢复。原因是大量方法同时达到编译阈值，C1/C2 编译线程抢 CPU，且此时业务代码还在解释执行。

- 发布流程加**预热**：接入流量前用回放流量或脚本调用核心接口，或网关按权重逐步放量。
- 容器只给 1～2 核时，编译线程与业务线程激烈竞争，问题尤其明显；可考虑 CDS/AppCDS 缩短启动、JDK 24+ 的 AOT 缓存（JEP 483）进一步改善。

### CodeCache 打满

日志出现 `CodeCache is full. Compiler has been disabled.` 之后性能断崖式下降（全部回退解释执行）。常见于动态生成大量类的应用（Groovy 脚本、大量 Lambda/代理类）。排查：

```bash
jcmd <pid> Compiler.codecache       # 查看使用量
jcmd <pid> VM.flags | grep CodeCache
```

修复：调大 `ReservedCodeCacheSize`，并排查是否有类/脚本无限生成的泄漏。

### 小容器里默认 GC 变成 Serial

JVM 会判断是否为「server class machine」：可用 CPU < 2 **或** 内存 < 1792MB 时，默认选择 **SerialGC** 而不是 G1。很多人在 1C1G 的 Pod 里看到 GC 日志是 `Copy`/`MarkSweepCompact` 才发现这一点。需要时显式指定 `-XX:+UseG1GC`。更多见 [线上调优与故障排查](#/java/jvm/tuning)。

### `UnsupportedClassVersionError`

```text
class file version 61.0, this version of the Java Runtime only recognizes class file versions up to 55.0
```

翻译：用 17 编译的类跑在 11 上。常见于升级了某个依赖（新版本只发布 17 字节码，如 Spring 6 / Spring Boot 3 要求 17+）。解决：升级运行时，或锁定依赖的旧版本。

## 面试追问

> [!QUESTION] Java 是编译型还是解释型语言？
> 两者都有。`javac` 把源码编译成平台无关的字节码；运行时先由解释器执行，热点代码再由 JIT（C1/C2）编译成本地码。还可以通过 GraalVM Native Image 做 AOT，完全提前编译。

> [!QUESTION] 为什么 JIT 编译后的代码可能比 C++ 静态编译还快？
> JIT 拥有运行期 profile：知道某个虚调用点实际只有一种类型（单态内联）、某个分支从不走（裁剪冷分支）、对象不逃逸（标量替换）。这些乐观假设静态编译器拿不到；代价是假设失效时要去优化。

> [!QUESTION] `-source/-target` 和 `--release` 有什么区别？
> 前两者只控制语法级别和输出的 class 版本，编译时仍用当前 JDK 的类库，可能调用到目标版本不存在的 API；`--release` 会用目标版本的 API 符号表校验，是交叉编译的正确方式。

> [!QUESTION] 服务刚上线时 RT 很高，过一会儿正常，怎么解释和优化？
> JIT 预热 + 类加载 + 连接池/缓存冷启动叠加。优化：发布时预热流量、逐步放量；AppCDS 缓存类元数据；合理设置连接池最小连接数；必要时评估 AOT 缓存或 Native Image。

> [!QUESTION] JDK 11 以后为什么没有 JRE 了？
> JDK 9 模块化后可以用 `jlink` 按需组合模块生成定制运行时，体积更小、攻击面更小，官方便不再单独发布 JRE；容器镜像通常基于 jlink 产物或 `-jre` 精简镜像构建。
