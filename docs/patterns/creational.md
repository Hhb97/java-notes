# 创建型模式

关注**对象如何被创建**，把创建与使用解耦。

## 单例模式

保证一个类只有一个实例，并提供全局访问点。

```java
// 推荐 1：静态内部类（懒加载 + 线程安全，由类加载机制保证）
public class Singleton {
    private Singleton() {}
    private static class Holder { static final Singleton INSTANCE = new Singleton(); }
    public static Singleton getInstance() { return Holder.INSTANCE; }
}

// 推荐 2：枚举（天然防反射 / 反序列化破坏，《Effective Java》首推）
public enum Config { INSTANCE; public String get(String k) { return ""; } }
```

双重检查锁（需要 `volatile`）见 [synchronized 与 volatile](#/concurrency/sync)。Spring 的 Bean 默认就是容器级单例，业务代码里通常不必手写。

## 工厂模式

### 简单工厂 / 工厂方法

```java
interface Payment { void pay(long cents); }

class PaymentFactory {
    static Payment create(String type) {
        return switch (type) {
            case "wx"  -> new WxPay();
            case "ali" -> new AliPay();
            default    -> throw new IllegalArgumentException(type);
        };
    }
}
```

调用方只依赖接口，新增支付方式不改调用代码。分支多时，可把「type → 实现」做成 `Map<String, Payment>` 由 Spring 注入，消灭 `switch`。

### 抽象工厂

创建**一族**相关对象（如「按钮 + 输入框」的 Windows 风格 / Mac 风格），保证同族对象搭配使用。

## 建造者模式

参数多、可选项多时，避免「伸缩构造器」：

```java
User u = User.builder()
        .name("Tom")
        .age(20)
        .email("t@x.com")
        .build();
```

```java
public class User {
    private final String name; private final int age; private final String email;
    private User(Builder b) { name = b.name; age = b.age; email = b.email; }

    public static Builder builder() { return new Builder(); }
    public static class Builder {
        private String name; private int age; private String email;
        public Builder name(String n) { this.name = n; return this; }
        public Builder age(int a)     { this.age = a;  return this; }
        public Builder email(String e){ this.email = e; return this; }
        public User build() { return new User(this); }
    }
}
```

Lombok 的 `@Builder` 可自动生成。

## 原型模式

通过**拷贝已有对象**创建新对象（`Cloneable` / 拷贝构造器）。注意**浅拷贝**只复制引用；需要独立副本时做**深拷贝**（递归复制，或序列化后反序列化）。

## 选用建议

| 场景 | 模式 |
| --- | --- |
| 全局唯一资源 | 单例（优先交给 Spring 管理） |
| 根据条件返回不同实现 | 工厂 |
| 对象构造参数多、有可选项 | 建造者 |
| 创建开销大、需要复制 | 原型 |
