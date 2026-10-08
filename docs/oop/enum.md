# 枚举与记录类

## 枚举 enum

枚举是**一组固定实例**的类，天然单例、线程安全、可用于 `switch`。

```java
public enum Status {
    PENDING(0, "待处理"),
    DONE(1, "已完成");

    private final int code;
    private final String label;

    Status(int code, String label) { this.code = code; this.label = label; }

    public int getCode() { return code; }

    public static Status of(int code) {
        for (Status s : values()) if (s.code == code) return s;
        throw new IllegalArgumentException("未知状态: " + code);
    }
}
```

常用 API：`values()`、`valueOf(String)`、`name()`、`ordinal()`、`compareTo()`。

- 不要依赖 `ordinal()` 存库，枚举调整顺序后数据会错乱；存 `code` 或 `name()`。
- 集合场景用 `EnumMap` / `EnumSet`，性能更好。
- 枚举可以实现接口，每个常量还可以有自己的方法体（常量特定行为）。

## 记录类 record（16+）

用来声明**不可变的数据载体**，编译器自动生成构造器、访问器、`equals`、`hashCode`、`toString`。

```java
public record Point(int x, int y) {
    public Point {                       // 紧凑构造器：校验参数
        if (x < 0 || y < 0) throw new IllegalArgumentException();
    }
    public double distance() { return Math.hypot(x, y); }
}

var p = new Point(3, 4);
System.out.println(p.x());     // 访问器不带 get
System.out.println(p);         // Point[x=3, y=4]
```

限制：不能继承其他类（隐式 `final`，继承自 `Record`）、不能声明实例字段；可以实现接口、声明静态成员。

## 适用场景

| 需求 | 推荐 |
| --- | --- |
| 固定的有限取值（状态、类型、方向） | `enum` |
| DTO / 值对象 / 方法多返回值 | `record` |
| 需要可变状态 / 继承体系 | 普通类 |
