# 继承与多态

## 继承

```java
class Animal {
    protected String name;
    Animal(String name) { this.name = name; }
    void speak() { System.out.println("..."); }
}

class Dog extends Animal {
    Dog(String name) { super(name); }       // 必须先调用父类构造器
    @Override
    void speak() { System.out.println(name + ": 汪"); }
}
```

- Java **单继承**，但可实现多个接口。
- 子类构造器第一行默认隐含 `super()`；父类没有无参构造器时必须显式调用。
- `@Override` 让编译器检查是否真的重写，请始终加上。

## 多态

**同一个引用类型，调用时根据实际对象类型表现不同行为。** 必要条件：继承（或实现）、方法重写、父类引用指向子类对象。

```java
Animal a = new Dog("旺财");
a.speak();                 // 汪 —— 运行时按实际类型 Dog 分派
if (a instanceof Dog d) {  // 向下转型前先判断
    d.fetch();
}
```

### 重写 vs 重载

| | 重写 Override | 重载 Overload |
| --- | --- | --- |
| 发生位置 | 父子类之间 | 同一个类内 |
| 方法签名 | 必须相同 | 参数列表必须不同 |
| 绑定时机 | **运行时**（动态绑定） | **编译时**（静态绑定） |
| 返回值 / 异常 | 协变返回；不能抛更宽的受检异常 | 无限制 |

> **注意：** 字段没有多态。通过父类引用访问同名字段，得到的是父类字段。`static` 与 `private` 方法同样不参与多态。

## 组合优于继承

继承是强耦合：子类依赖父类实现细节，父类修改会波及子类。若只是想复用功能，优先使用**组合**：

```java
class Car {
    private final Engine engine;      // 持有而不是继承
    Car(Engine engine) { this.engine = engine; }
    void start() { engine.ignite(); }
}
```

继承适用于真正的 "is-a" 关系，并遵循**里氏替换原则**：任何用到父类的地方，换成子类都不应出错。

## Object 类

所有类的根。常用方法：`toString()`、`equals()`、`hashCode()`、`getClass()`、`wait()/notify()`。`clone()` 与 `finalize()`（已废弃）一般不要使用。
