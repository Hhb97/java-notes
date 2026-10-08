# 接口与抽象类

## 接口

接口描述**能力契约**，一个类可以实现多个接口。

```java
public interface Payment {
    int TIMEOUT = 30;                    // 常量：public static final
    void pay(long cents);                // 抽象方法：public abstract

    default void log(String msg) {       // 8+：默认方法，可被覆盖
        System.out.println("[pay] " + msg);
    }
    static Payment of(String type) {     // 8+：静态方法
        return "wx".equals(type) ? new WxPay() : new AliPay();
    }
    private void helper() { }            // 9+：私有方法，复用默认方法的代码
}
```

## 抽象类

```java
public abstract class Report {
    public final void generate() {   // 模板方法：固定流程
        load();
        render();
    }
    protected abstract void load();
    protected abstract void render();
}
```

## 如何选择

| | 接口 | 抽象类 |
| --- | --- | --- |
| 继承数量 | 可实现多个 | 只能继承一个 |
| 成员变量 | 只能是常量 | 任意 |
| 构造器 | 无 | 有 |
| 设计含义 | **can-do**（能力） | **is-a**（本质） |
| 方法 | 抽象 + default + static | 抽象 + 普通 |

经验：先考虑接口；需要共享状态或模板流程时再用抽象类。

## 函数式接口

只有一个抽象方法的接口，可用 Lambda 实现，用 `@FunctionalInterface` 标注：

```java
@FunctionalInterface
interface Calculator { int calc(int a, int b); }

Calculator add = (a, b) -> a + b;
```

内置函数式接口：`Function<T,R>`、`Predicate<T>`、`Consumer<T>`、`Supplier<T>`，见 [Lambda 与 Stream](#/modern/lambda)。

## 密封类（17+）

限制谁能继承 / 实现：

```java
public sealed interface Shape permits Circle, Rect {}
public record Circle(double r) implements Shape {}
public record Rect(double w, double h) implements Shape {}
```

配合 `switch` 模式匹配，编译器可检查分支是否穷尽。
