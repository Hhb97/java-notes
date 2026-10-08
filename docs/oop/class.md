# 类与对象

## 类的组成

```java
public class User {
    private static int count = 0;      // 静态变量：属于类，所有实例共享
    private final long id;             // 实例变量
    private String name;

    static { /* 静态代码块：类加载时执行一次 */ }
    { /* 实例代码块：每次 new 都在构造器之前执行 */ }

    public User(long id, String name) { // 构造器
        this.id = id;
        this.name = name;
        count++;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}
```

**封装**：字段设为 `private`，通过 getter / setter 暴露，可在里面做校验。

## 访问修饰符

| 修饰符 | 本类 | 同包 | 子类 | 其他 |
| --- | :-: | :-: | :-: | :-: |
| `private` | ✔ | | | |
| 默认（无） | ✔ | ✔ | | |
| `protected` | ✔ | ✔ | ✔ | |
| `public` | ✔ | ✔ | ✔ | ✔ |

## 对象创建与初始化顺序

`new User()` 时的执行顺序：

1. 类首次使用 → 加载并初始化：**父类静态** → **子类静态**（静态变量与静态块按书写顺序）
2. 分配内存，字段设默认值
3. **父类**实例变量 / 实例块 → **父类构造器**
4. **子类**实例变量 / 实例块 → **子类构造器**

## equals 与 hashCode

重写 `equals` 就必须重写 `hashCode`，保证：**equals 相等 ⇒ hashCode 相等**，否则放进 `HashMap` / `HashSet` 会出错。

```java
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof User u)) return false;   // 16+ 模式匹配
    return id == u.id;
}

@Override
public int hashCode() { return Long.hashCode(id); }
```

## static 与 final

- `static` 方法不能访问实例成员，也不能被重写（只能隐藏）。
- `final` 类不可继承（如 `String`），`final` 方法不可重写，`final` 变量不可重新赋值（引用不变，对象内容可变）。

## 不可变对象

字段全 `final`、不提供 setter、构造时防御性拷贝可变入参。不可变对象天然线程安全，推荐优先使用，见 [枚举与记录类](#/oop/enum) 中的 `record`。
