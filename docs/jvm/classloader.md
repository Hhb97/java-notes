# 类加载机制

## 生命周期

```text
加载 Loading → 验证 → 准备 → 解析 → 初始化 Initialization → 使用 → 卸载
               └────── 链接 Linking ──────┘
```

| 阶段 | 做什么 |
| --- | --- |
| 加载 | 通过全限定名获取二进制字节流，在方法区生成类元数据，在堆中生成 `Class` 对象 |
| 验证 | 文件格式、字节码语义、符号引用是否合法，保证不危害 JVM |
| 准备 | 为**静态变量**分配内存并赋**默认值**（`static int a = 5` 此时 a = 0；`static final` 常量直接赋值） |
| 解析 | 符号引用 → 直接引用 |
| 初始化 | 执行 `<clinit>`：静态变量赋初值 + 静态代码块，按书写顺序；JVM 保证线程安全 |

## 何时触发初始化

主动使用才会初始化：

- `new`、读写静态字段（非常量）、调用静态方法；
- 反射 `Class.forName("...")`；
- 初始化子类前先初始化父类；
- 启动类（含 `main` 的类）。

**不会**触发：通过子类引用父类的静态字段（只初始化父类）、定义类的数组、引用 `static final` 编译期常量。

## 类加载器与双亲委派

```text
Bootstrap ClassLoader      加载 java.base 等核心模块（C++ 实现，getClassLoader() 返回 null）
   ↑
Platform ClassLoader       （JDK 9+，原 Extension）加载平台模块
   ↑
Application ClassLoader    加载 classpath 下的应用类
   ↑
自定义 ClassLoader
```

**双亲委派**：收到加载请求时，先**委托父加载器**，父加载器无法完成时子加载器才自己加载。

```java
protected Class<?> loadClass(String name, boolean resolve) {
    Class<?> c = findLoadedClass(name);
    if (c == null) {
        try { c = parent.loadClass(name, false); }   // 先问父亲
        catch (ClassNotFoundException e) { c = findClass(name); }  // 父亲不行再自己来
    }
    return c;
}
```

好处：
1. **安全**：用户自己写的 `java.lang.String` 不会替换核心类；
2. **避免重复加载**：同一个类只被加载一次。

> 一个类的唯一性由「**类加载器 + 全限定名**」共同决定。

## 打破双亲委派的场景

| 场景 | 做法 |
| --- | --- |
| JDBC / SPI | 核心库（Bootstrap）需要加载应用的实现类，用**线程上下文类加载器** |
| Tomcat | 每个 Web 应用一个 `WebAppClassLoader`，优先加载自己的类，实现应用隔离 |
| 热部署 / OSGi | 丢弃旧的加载器，创建新的重新加载 |

## 自定义类加载器

继承 `ClassLoader`，**重写 `findClass`**（保持双亲委派）：

```java
public class MyLoader extends ClassLoader {
    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        byte[] data = readBytes(name);           // 从文件 / 网络 / 加密文件读取
        return defineClass(name, data, 0, data.length);
    }
}
```

## 常见错误

- `ClassNotFoundException`：加载时找不到类（`Class.forName`），checked 异常；
- `NoClassDefFoundError`：编译期有、运行时没有（依赖缺失或静态初始化失败），Error；
- `ExceptionInInitializerError`：静态初始化块抛异常。
