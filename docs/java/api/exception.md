---
level: 进阶
tags: [异常, 字节码, finally, try-with-resources, 错误码, 全局异常处理]
summary: 从字节码异常表看 finally 与 try-with-resources 的实现，分析异常创建开销与 OmitStackTraceInFastThrow 坑，并给出业务异常与全局异常处理的分层设计
---

# 异常体系与最佳实践

> [!ABSTRACT] 核心要点
> - `Throwable` 分 `Error`（JVM/系统级，通常不该捕获）和 `Exception`；`RuntimeException` 及其子类是**非受检**异常，其余 `Exception` 是**受检**异常，编译器强制处理。
> - JVM 用方法的 **Exception table**（from / to / target / type）实现 catch；`finally` 没有专门指令，javac 把它的代码**复制**到 try 正常出口、每个 catch 出口以及一个 `any` 兜底处理器中。
> - try-with-resources 脱糖为「主异常 + `addSuppressed`」，资源按声明的逆序关闭，close 抛出的异常不会覆盖主异常。
> - 异常的主要开销在构造时的 `fillInStackTrace`（与栈深度成正比）；热点代码频繁抛出的隐式异常会被 C2 替换成**无栈预分配异常**（`OmitStackTraceInFastThrow`），日志里只剩一行 `java.lang.NullPointerException`。
> - 业务异常 = 非受检异常 + 错误码枚举；Controller 不写 try/catch，由 `@RestControllerAdvice` 统一转换；「要么记录、要么抛出」，不要两者都做。

## 异常体系

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Java 异常体系：Throwable 分为 Error 和 Exception，Exception 下分受检异常和 RuntimeException">
<rect class="b" x="320" y="20" width="120" height="36" rx="6"/>
<text class="tb" x="380" y="38" text-anchor="middle" dominant-baseline="middle">Throwable</text>
<line class="l" x1="380" y1="56" x2="170" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="56" x2="570" y2="90" marker-end="url(#arr)"/>
<rect class="b4" x="110" y="90" width="120" height="36" rx="6"/>
<text class="tb" x="170" y="108" text-anchor="middle" dominant-baseline="middle">Error</text>
<rect class="b" x="500" y="90" width="140" height="36" rx="6"/>
<text class="tb" x="570" y="108" text-anchor="middle" dominant-baseline="middle">Exception</text>
<line class="l" x1="120" y1="126" x2="120" y2="235"/>
<line class="l" x1="120" y1="155" x2="132" y2="155"/>
<line class="l" x1="120" y1="195" x2="132" y2="195"/>
<line class="l" x1="120" y1="235" x2="132" y2="235"/>
<rect class="b4" x="132" y="140" width="190" height="30" rx="6"/>
<text class="tm" x="227" y="155" text-anchor="middle" dominant-baseline="middle">OutOfMemoryError</text>
<rect class="b4" x="132" y="180" width="190" height="30" rx="6"/>
<text class="tm" x="227" y="195" text-anchor="middle" dominant-baseline="middle">StackOverflowError</text>
<rect class="b4" x="132" y="220" width="190" height="30" rx="6"/>
<text class="tm" x="227" y="235" text-anchor="middle" dominant-baseline="middle">NoClassDefFoundError</text>
<line class="l" x1="570" y1="126" x2="465" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="126" x2="670" y2="160" marker-end="url(#arr)"/>
<rect class="b2" x="380" y="160" width="170" height="34" rx="6"/>
<text class="tb" x="465" y="177" text-anchor="middle" dominant-baseline="middle">RuntimeException</text>
<line class="l" x1="390" y1="194" x2="390" y2="289"/>
<line class="l" x1="390" y1="219" x2="402" y2="219"/>
<line class="l" x1="390" y1="254" x2="402" y2="254"/>
<line class="l" x1="390" y1="289" x2="402" y2="289"/>
<rect class="b2" x="402" y="205" width="168" height="28" rx="6"/>
<text class="tm" x="486" y="219" text-anchor="middle" dominant-baseline="middle">NullPointerException</text>
<rect class="b2" x="402" y="240" width="168" height="28" rx="6"/>
<text class="tm" x="486" y="254" text-anchor="middle" dominant-baseline="middle">IllegalStateException</text>
<rect class="b2" x="402" y="275" width="168" height="28" rx="6"/>
<text class="tm" x="486" y="289" text-anchor="middle" dominant-baseline="middle">ClassCastException</text>
<rect class="b3" x="590" y="160" width="160" height="34" rx="6"/>
<text class="tb" x="670" y="177" text-anchor="middle" dominant-baseline="middle">其它子类（受检）</text>
<line class="l" x1="600" y1="194" x2="600" y2="289"/>
<line class="l" x1="600" y1="219" x2="612" y2="219"/>
<line class="l" x1="600" y1="254" x2="612" y2="254"/>
<line class="l" x1="600" y1="289" x2="612" y2="289"/>
<rect class="b3" x="612" y="205" width="138" height="28" rx="6"/>
<text class="tm" x="681" y="219" text-anchor="middle" dominant-baseline="middle">IOException</text>
<rect class="b3" x="612" y="240" width="138" height="28" rx="6"/>
<text class="tm" x="681" y="254" text-anchor="middle" dominant-baseline="middle">SQLException</text>
<rect class="b3" x="612" y="275" width="138" height="28" rx="6"/>
<text class="tm" x="681" y="289" text-anchor="middle" dominant-baseline="middle">TimeoutException</text>
<text class="ts" x="20" y="280">红：Error，通常无法恢复</text>
<text class="ts" x="20" y="298">绿：非受检，编译器不强制</text>
<text class="ts" x="20" y="316">琥珀：受检，必须 catch 或 throws</text>
</svg>
<figcaption>图 1：Throwable 体系（受检 / 非受检由编译器区分，JVM 层面没有差别）</figcaption>
</figure>

- 「受检」只是 **javac 的规则**，JVM 和字节码层面对所有 Throwable 一视同仁。Kotlin、Scala 没有受检异常；Lombok `@SneakyThrows` 也是利用了这一点（通过泛型擦除骗过编译器抛出受检异常）。
- 受检异常与 Lambda 冲突：`Function` 不声明 throws，Stream 中调用抛 `IOException` 的方法必须包一层，常用 `UncheckedIOException`（JDK 8）。
- `Error` 中也有可以处理的：`StackOverflowError` 只是当前线程栈溢出，捕获后线程可以继续；但 `OutOfMemoryError` 发生后堆状态可能已经不一致，正确做法是 `-XX:+HeapDumpOnOutOfMemoryError` 留现场后尽快重启（或 `-XX:+ExitOnOutOfMemoryError`）。
- `NoClassDefFoundError` 与 `ClassNotFoundException` 的区别：前者是编译时存在、运行时链接失败（常见于**静态初始化块抛异常**后再次使用该类：第一次是 `ExceptionInInitializerError`，之后都是 `NoClassDefFoundError: Could not initialize class X`），后者是 `Class.forName` 等显式加载找不到类。

## 字节码：Exception table 与 finally

```java
public int inc() {
    int x;
    try {
        x = 1;
        return x;
    } catch (Exception e) {
        x = 2;
        return x;
    } finally {
        x = 3;
    }
}
```

```text
$ javap -c Demo   （javac 编译；不同版本偏移可能略有差异）
 0: iconst_1
 1: istore_1          // x = 1
 2: iload_1
 3: istore_2          // 把返回值 1 暂存到局部变量 slot 2
 4: iconst_3
 5: istore_1          // finally 副本①：x = 3
 6: iload_2
 7: ireturn           // 返回暂存值 1，而非 x 的当前值 3
 8: astore_2          // catch (Exception e) 入口：异常对象存入 slot 2
 9: iconst_2
10: istore_1          // x = 2
11: iload_1
12: istore_3          // 暂存返回值 2
13: iconst_3
14: istore_1          // finally 副本②
15: iload_3
16: ireturn
17: astore 4          // any 处理器：try 或 catch 中抛出的其它异常
19: iconst_3
20: istore_1          // finally 副本③
21: aload 4
23: athrow            // 重新抛出
Exception table:
   from    to  target type
       0     4     8   Class java/lang/Exception
       0     4    17   any
       8    13    17   any
```

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="finally 代码被 javac 复制到 try 正常出口、catch 出口和 any 处理器三条路径">
<rect class="b1" x="20" y="40" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="62" text-anchor="middle" dominant-baseline="middle">try 体 [0, 4)</text>
<line class="l" x1="190" y1="62" x2="230" y2="62" marker-end="url(#arr)"/>
<rect class="b3" x="230" y="40" width="150" height="44" rx="8"/>
<text class="t" x="305" y="62" text-anchor="middle" dominant-baseline="middle">finally 副本 ①</text>
<line class="l" x1="380" y1="62" x2="420" y2="62" marker-end="url(#arr)"/>
<rect class="b" x="420" y="40" width="110" height="44" rx="8"/>
<text class="tm" x="475" y="62" text-anchor="middle" dominant-baseline="middle">ireturn</text>
<rect class="b2" x="20" y="110" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="132" text-anchor="middle" dominant-baseline="middle">catch 体 [8, 13)</text>
<line class="l" x1="190" y1="132" x2="230" y2="132" marker-end="url(#arr)"/>
<rect class="b3" x="230" y="110" width="150" height="44" rx="8"/>
<text class="t" x="305" y="132" text-anchor="middle" dominant-baseline="middle">finally 副本 ②</text>
<line class="l" x1="380" y1="132" x2="420" y2="132" marker-end="url(#arr)"/>
<rect class="b" x="420" y="110" width="110" height="44" rx="8"/>
<text class="tm" x="475" y="132" text-anchor="middle" dominant-baseline="middle">ireturn</text>
<rect class="b4" x="20" y="180" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="202" text-anchor="middle" dominant-baseline="middle">any 处理器 @17</text>
<line class="l" x1="190" y1="202" x2="230" y2="202" marker-end="url(#arr)"/>
<rect class="b3" x="230" y="180" width="150" height="44" rx="8"/>
<text class="t" x="305" y="202" text-anchor="middle" dominant-baseline="middle">finally 副本 ③</text>
<line class="l" x1="380" y1="202" x2="420" y2="202" marker-end="url(#arr)"/>
<rect class="b" x="420" y="180" width="110" height="44" rx="8"/>
<text class="tm" x="475" y="202" text-anchor="middle" dominant-baseline="middle">athrow</text>
<line class="ld" x1="105" y1="84" x2="105" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="113" y="101">抛 Exception</text>
<line class="ld" x1="80" y1="154" x2="80" y2="180" marker-end="url(#arr)"/>
<text class="ts" x="88" y="171">抛其它异常</text>
<rect class="bg" x="560" y="40" width="185" height="184" rx="10"/>
<text class="tb" x="652" y="64" text-anchor="middle">Exception table</text>
<text class="tm" x="575" y="96">[0,4)  → 8   Exception</text>
<text class="tm" x="575" y="124">[0,4)  → 17  any</text>
<text class="tm" x="575" y="152">[8,13) → 17  any</text>
<text class="ts" x="575" y="186">按顺序匹配第一条</text>
<text class="ts" x="575" y="206">to 为开区间</text>
<text class="ts" x="20" y="256">finally 不是被「调用」的子程序：javac 把它内联复制到每条出口路径末尾，所以 finally 越长，字节码膨胀越多</text>
</svg>
<figcaption>图 2：一个 try-catch-finally 对应三份 finally 代码和三条异常表项</figcaption>
</figure>

从字节码能直接回答几道经典题：

- **finally 修改返回变量不影响返回值**：`return x` 先把 x 的值存进临时槽（`istore_2`），再执行 finally，最后返回临时槽的值。若返回的是引用类型，finally 修改对象**内部状态**是可见的（暂存的是引用）。
- **finally 中 `return` 会吞掉异常**：any 处理器中的副本③如果以 `return` 结束，`athrow` 就永远执行不到，原异常凭空消失。javac 对此会给出 `finally clause cannot complete normally` 警告（`-Xlint:finally`）。
- **`System.exit()`、线程被杀、守护线程随 JVM 退出时 finally 不执行**。
- 历史：早期 javac 用 `jsr/ret` 子程序指令实现 finally，与类型推断验证器冲突；class 文件版本 51（JDK 7）起禁止出现 `jsr/ret`。
- `synchronized` 块也是同样的机制：javac 生成一个 `any` 处理器，保证异常路径上也执行 `monitorexit`。字节码细节见 [字节码与执行引擎](#/java/jvm/bytecode)。

异常分派过程：`athrow` 或隐式异常发生时，JVM 在当前方法的异常表中**按顺序**查找 `from ≤ pc < to` 且类型匹配的第一项，跳到 target；找不到就弹出当前栈帧，在调用者中继续查找，直到线程栈耗尽交给 `UncaughtExceptionHandler`。所以 catch 的书写顺序（子类在前）就是异常表的顺序。

## try-with-resources 脱糖

```java
// 源码（JDK 7+；JDK 9 起可直接写 try (in) 引用 effectively final 变量）
try (InputStream in = open(); OutputStream out = create()) {
    copy(in, out);
}
```

按 JLS 14.20.3 的语义，等价于（单个资源的形态，多个资源逐层嵌套）：

```java
InputStream in = open();
Throwable primary = null;
try {
    use(in);
} catch (Throwable t) {
    primary = t;
    throw t;
} finally {
    if (in != null) {                        // 资源为 null 时不调用 close
        if (primary != null) {
            try {
                in.close();
            } catch (Throwable suppressed) {
                primary.addSuppressed(suppressed);   // close 异常挂到主异常上
            }
        } else {
            in.close();                      // 无主异常：close 的异常正常抛出
        }
    }
}
```

要点：

1. **关闭顺序**：后声明的先关（`out` 先于 `in`），符合「包装流依赖底层流」的直觉。
2. **suppressed 机制**：传统 `try-finally` 中 `close()` 抛异常会覆盖 try 中的真正异常，排查时只能看到「关闭失败」；try-with-resources 保留主异常，close 异常通过 `getSuppressed()` 获取，堆栈打印为 `Suppressed: ...`。
3. **catch / finally 子句在资源关闭之后执行**：`try (Conn c = ...) {...} catch (Exception e) { c 已经关闭 }`。
4. **包装流构造失败导致泄漏**：`try (BufferedReader r = new BufferedReader(new FileReader(f)))` 中，若 `BufferedReader` 构造器抛异常，`FileReader` 没有被声明为资源，不会被关闭。稳妥写法是把底层流单独声明为资源。
5. javac 的实际生成代码随版本优化过（JDK 9～10 曾生成 `$closeResource` 辅助方法，JDK 11 起改为更紧凑的内联形式），语义不变。

## 异常的性能开销

```java
// JDK 17 Throwable（节选）
public Throwable(String message) {
    fillInStackTrace();            // ← 主要开销：遍历当前线程栈，记录 backtrace
    detailMessage = message;
}
public synchronized Throwable fillInStackTrace() {
    if (stackTrace != null || backtrace != null) {
        fillInStackTrace(0);       // native：在 JVM 内部把栈帧（方法 + bci）存进 backtrace
        stackTrace = UNASSIGNED_STACK;
    }
    return this;
}
// getStackTrace()/printStackTrace() 时才把 backtrace 懒转换为 StackTraceElement[]（再一次开销）

protected Throwable(String message, Throwable cause,
                    boolean enableSuppression, boolean writableStackTrace)   // JDK 7
```

- 开销与**栈深度**成正比。Spring Boot + 各种代理、过滤器的调用栈动辄一两百帧，异常频繁时 CPU 火焰图中 `fillInStackTrace`、`java_lang_Throwable::fill_in_stack_trace` 会很显眼。
- `throw` 本身（栈展开）在 JIT 后并不算贵，贵的是创建和打印。日志框架打印堆栈还要格式化字符串、做 IO。
- 优化手段：
  - **预期内的业务失败**（参数不合法、余额不足）用不带栈的异常：调用 4 参构造器传 `writableStackTrace = false`，或重写 `fillInStackTrace()` 返回 `this`；
  - **不要用异常做流程控制**，例如用 `Integer.parseInt` + catch 判断是否数字，在循环里会非常慢；
  - 需要「谁调用了我」的诊断信息时，用 JDK 9 的 `StackWalker` 按需遍历，比 `new Throwable().getStackTrace()` 便宜得多。
- 全局开关 `-XX:-StackTraceInThrowable` 可以关闭所有异常的栈追踪，排查能力损失太大，不推荐。

### OmitStackTraceInFastThrow 的坑

C2 编译器对**隐式异常**（JVM 自己抛的 `NullPointerException`、`ArithmeticException`、`ArrayIndexOutOfBoundsException`、`ArrayStoreException`、`ClassCastException`）有一个优化：同一个抛出点频繁触发后，直接抛出一个**预分配、无栈、无 message** 的异常对象。该优化由 `-XX:+OmitStackTraceInFastThrow` 控制，**默认开启**。

现象：服务刚启动时日志里 NPE 有完整堆栈，过一会儿同样的错误只剩一行：

```text
ERROR c.x.OrderController - 下单失败
java.lang.NullPointerException
```

排查与修复：

1. 往前翻日志，找到该异常**最早**出现的几次，那时还有完整堆栈；
2. 在测试/预发环境加 `-XX:-OmitStackTraceInFastThrow` 复现；生产环境是否关闭需权衡——异常风暴下每次都填充栈可能让 CPU 进一步恶化；
3. JDK 14 引入、JDK 15 默认开启的 Helpful NullPointerExceptions（JEP 358）能输出 `Cannot invoke "String.length()" because "s" is null`，但 fast throw 的预分配异常**连这个 message 也没有**。

## 业务异常与错误码体系

### 设计原则

- 业务异常继承 `RuntimeException`：受检异常会污染每一层的方法签名，且与 Lambda、Spring 事务默认回滚规则（只回滚 RuntimeException 和 Error）不匹配。
- 用**错误码枚举**而非字符串：便于前端/调用方分支处理、文档化、国际化和监控聚合。
- 区分「给用户看的提示」与「给开发看的细节」：message 不应暴露 SQL、堆栈、内部主机名。
- 错误码分段：阿里巴巴 Java 开发手册建议 5 位错误码，首字母表示来源——`A` 用户端错误（参数、权限）、`B` 系统执行错误（超时、bug）、`C` 调用第三方服务错误，`00000` 表示成功。来源区分直接决定了告警策略：A 类通常不告警，B/C 类按比例告警。

```java
public enum ErrorCode {
    OK("00000", "成功", 200),
    PARAM_INVALID("A0400", "请求参数错误", 400),
    UNAUTHORIZED("A0301", "访问未授权", 403),
    ORDER_NOT_FOUND("A0404", "订单不存在", 404),
    STOCK_NOT_ENOUGH("A0510", "库存不足", 409),
    SYSTEM_ERROR("B0001", "系统繁忙，请稍后再试", 500),
    PAY_GATEWAY_TIMEOUT("C0210", "支付服务超时", 504);

    private final String code; private final String msg; private final int httpStatus;
    // 构造器与 getter 省略
}

public class BizException extends RuntimeException {
    private final ErrorCode errorCode;

    public BizException(ErrorCode errorCode, String detail) {
        // 预期内的业务拒绝：不需要栈，关闭 suppression 与栈追踪以降低开销
        super(detail, null, false, false);
        this.errorCode = errorCode;
    }
    public BizException(ErrorCode errorCode, String detail, Throwable cause) {
        super(detail, cause);                // 包装底层异常时保留栈和 cause
        this.errorCode = errorCode;
    }
    public ErrorCode getErrorCode() { return errorCode; }
}
```

> [!TIP] 是否关闭栈追踪要区分场景
> 「库存不足」「订单不存在」这类业务分支，栈没有排查价值，关闭可以显著降低开销；但包装了底层 cause 的异常、或代表「不该发生」的系统错误，必须保留栈。

### 全局异常处理分层

| 层 | 职责 | 做法 |
| --- | --- | --- |
| DAO / 外部调用 | 把技术异常翻译为语义明确的异常 | Spring 已将 `SQLException` 翻译为 `DataAccessException` 体系（如 `DuplicateKeyException`）；HTTP/RPC 客户端统一包装为 `C` 类错误码，**保留 cause** |
| Service | 抛出业务异常，不吞异常 | 校验失败抛 `BizException`；不在此层 catch 后打印再返回 null |
| Controller | 不写 try/catch | 交给全局处理器 |
| 全局处理器 | 统一转换响应、统一记录日志 | `@RestControllerAdvice`；业务异常记 warn（不打堆栈），未知异常记 error（带堆栈与 traceId） |
| Filter / 网关 | ControllerAdvice 覆盖不到 | Filter 中的异常走 Servlet 容器的 `/error`（Spring Boot 的 `BasicErrorController`），需要单独处理 |
| 异步 / MQ / 定时任务 | 没有调用方接收异常 | 线程池 `submit` 的异常被封装进 `Future`，不 `get` 就永远看不到；`@Async void` 方法配置 `AsyncUncaughtExceptionHandler`；MQ 消费者区分可重试与不可重试异常 |

```java
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> handleBiz(BizException e) {
        ErrorCode ec = e.getErrorCode();
        log.warn("biz reject, code={}, detail={}", ec.getCode(), e.getMessage());   // 不打印堆栈
        return ResponseEntity.status(ec.getHttpStatus()).body(Result.fail(ec.getCode(), ec.getMsg()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Result<Void>> handleValid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(f -> f.getField() + " " + f.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return ResponseEntity.badRequest().body(Result.fail(ErrorCode.PARAM_INVALID.getCode(), msg));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Void>> handleUnknown(Exception e, HttpServletRequest req) {
        log.error("unhandled, uri={}", req.getRequestURI(), e);   // 最后一个参数是 Throwable，SLF4J 会打印堆栈
        return ResponseEntity.status(500)
                .body(Result.fail(ErrorCode.SYSTEM_ERROR.getCode(), ErrorCode.SYSTEM_ERROR.getMsg()));
    }
}
```

Spring 6 / Boot 3 内置了 RFC 7807（已被 RFC 9457 取代）的 `ProblemDetail` 响应格式，可以作为对外 API 的标准错误体。

**跨服务边界**：不要把自定义异常类直接抛给 RPC 调用方——调用方 classpath 上可能没有这个类，反序列化失败，或被框架包装（如 Dubbo 的 `ExceptionFilter` 会把接口未声明、且不在同一 jar 中的异常包装为带字符串信息的 `RuntimeException`）。服务间用「错误码 + 消息」的结果对象传递业务失败，系统异常才走异常通道。

## 生产实践与踩坑

1. **吞异常**：`catch (Exception e) {}` 或只 `e.printStackTrace()`（输出到 stdout，不进日志系统、没有 traceId）。至少要记录日志或重新抛出。
2. **既打日志又抛出**：每一层都 `log.error(..., e); throw e;`，同一个异常在日志里出现 N 次，告警被放大 N 倍。原则：**在处理它的地方记录，传播途中不记录**。
3. **丢失 cause**：`throw new BizException("下单失败")` 而不传 `e`，根因堆栈彻底丢失。包装异常一定传 cause。
4. **只记录 `e.getMessage()`**：`log.error("fail: " + e.getMessage())` 没有堆栈、没有 cause，NPE 时 message 甚至是 null。异常对象应作为**最后一个参数**单独传入且不为它写占位符：`log.error("fail, id={}", id, e)`，SLF4J 会识别为 Throwable 并打印完整堆栈。
5. **`@Transactional` 不回滚**：方法抛出受检异常（默认不回滚），或在方法内 catch 了异常没有重新抛出。需要时 `rollbackFor = Exception.class`；内层 `REQUIRED` 方法抛异常、外层 catch 住继续提交，会得到 `UnexpectedRollbackException: Transaction rolled back because it has been marked as rollback-only`。详见 [声明式事务原理](#/spring/tx)。
6. **吞掉 `InterruptedException`**：捕获后不处理会清除中断状态，上层线程池/调用方无法感知取消请求。不能向上抛时，至少 `Thread.currentThread().interrupt()` 恢复中断标志。
7. **`catch (Throwable t)` 捕获 OOM 后继续运行**：堆状态可能已不一致，后续出现各种诡异错误。只在线程最外层兜底时捕获 Throwable，且只做记录。
8. **NPE 只剩一行**：`OmitStackTraceInFastThrow`，见上文。
9. **静态初始化失败**：第一次 `ExceptionInInitializerError`，之后同一个类的所有使用都是 `NoClassDefFoundError: Could not initialize class`。排查时一定要找**第一次**的报错。
10. **线程池任务异常「消失」**：`submit()` 的异常存在 Future 里；`execute()` 的异常会打印到 stderr 并导致工作线程被替换。统一在任务内部 try/catch 记录日志，或包装 Runnable。见 [线程池原理与调优](#/java/concurrency/pool)。

## 面试追问

> [!QUESTION] finally 在字节码层面是怎么实现的？try 里 return 了，finally 里修改返回变量会生效吗？
> javac 把 finally 代码复制到 try 正常出口、每个 catch 出口，以及一个捕获 any 的处理器（执行完后 athrow 重新抛出），异常表记录各段的跳转。`return x` 会先把 x 的值存到临时局部变量再执行 finally，所以修改基本类型变量不影响返回值，修改引用对象的内部状态则可见。

> [!QUESTION] try-with-resources 和 try-finally 关闭资源有什么区别？
> 前者关闭失败时把 close 的异常 `addSuppressed` 到主异常上，主异常不会被覆盖；资源按声明逆序关闭；资源为 null 时跳过。后者 finally 中 close 抛异常会掩盖 try 中的原始异常。

> [!QUESTION] 为什么说异常很「重」？怎么优化？
> 构造时 `fillInStackTrace` 要遍历整个线程栈，打印时还要生成 StackTraceElement 并格式化。优化：不用异常做流程控制；预期内的业务异常使用 `writableStackTrace = false` 或重写 `fillInStackTrace`；需要栈信息时用 StackWalker 按需获取。

> [!QUESTION] 线上日志里 NPE 没有堆栈是什么原因？
> C2 对频繁抛出的隐式异常启用 OmitStackTraceInFastThrow（默认开启），用预分配无栈异常替代。翻日志找最早的完整堆栈，或用 `-XX:-OmitStackTraceInFastThrow` 复现。

> [!QUESTION] 受检异常和非受检异常怎么选？业务异常应该用哪种？
> 受检异常适合调用方「必须且能够」处理的可恢复情况（如文件不存在可提示重选）；业务异常一般用非受检 + 错误码，避免签名污染、适配 Lambda 与 Spring 事务默认回滚，由全局处理器统一转换为响应。

> [!QUESTION] ClassNotFoundException 和 NoClassDefFoundError 有什么区别？
> 前者是受检异常，显式加载（`Class.forName`、`loadClass`）找不到类；后者是 Error，编译期存在而运行期链接失败，常见原因是依赖冲突/缺包，或类的静态初始化曾失败（首次为 ExceptionInInitializerError）。
