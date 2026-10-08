# 异常处理

## 体系

```text
Throwable
├── Error                    严重问题，不应捕获：OutOfMemoryError、StackOverflowError
└── Exception
    ├── RuntimeException     非受检（unchecked）：NullPointerException、IllegalArgumentException、IndexOutOfBounds…
    └── 其他 Exception        受检（checked）：IOException、SQLException…，必须处理或声明
```

- **受检异常**：编译器强制 `try/catch` 或 `throws`，表示「调用方可以恢复」的情况。
- **非受检异常**：编程错误，通常应修复代码而不是捕获。

## try / catch / finally

```java
try {
    risky();
} catch (FileNotFoundException | SQLException e) {   // 多重捕获
    log.error("失败", e);
    throw new BizException("处理失败", e);             // 包装并保留原因链
} finally {
    cleanup();                                         // 无论如何都会执行
}
```

> **坑：** `finally` 里不要 `return`，会吞掉 `try` 中抛出的异常和返回值。

## try-with-resources

实现 `AutoCloseable` 的资源自动关闭，**取代手写 finally 关闭**：

```java
try (var in = Files.newInputStream(path);
     var out = Files.newOutputStream(target)) {
    in.transferTo(out);
}   // 逆序自动 close()；close 抛出的异常作为 suppressed 附加到主异常上
```

## 自定义异常

```java
public class BizException extends RuntimeException {
    private final int code;
    public BizException(int code, String msg) { super(msg); this.code = code; }
    public BizException(String msg, Throwable cause) { super(msg, cause); this.code = 500; }
    public int getCode() { return code; }
}
```

现代工程里业务异常通常继承 `RuntimeException`，由框架统一处理（如 Spring 的 `@ControllerAdvice`）。

## 最佳实践

1. **不要吞异常**：空 `catch` 是最糟糕的写法，至少记录日志。
2. **捕获具体异常**，避免 `catch (Exception e)` 一把抓。
3. **记录一次，抛出或处理二选一**：同一异常反复打日志会让排查变得混乱。
4. 抛出时保留 `cause`，方便看完整堆栈。
5. 不要用异常做流程控制；异常创建（填充堆栈）开销较大。
6. 参数校验尽早失败：`Objects.requireNonNull(x, "x must not be null")`。

## 常见异常速查

| 异常 | 常见原因 |
| --- | --- |
| `NullPointerException` | 对 null 调用方法 / 拆箱；14+ 提示信息更精确 |
| `ClassCastException` | 错误的向下转型，先 `instanceof` |
| `ConcurrentModificationException` | 遍历时修改集合 |
| `NumberFormatException` | `Integer.parseInt("abc")` |
| `StackOverflowError` | 无限递归 |
| `OutOfMemoryError` | 堆 / 元空间 / 直接内存耗尽，见 [调优与问题排查](#/jvm/tuning) |
