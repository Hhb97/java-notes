---
level: 深入
tags: [JVM, 类加载, 双亲委派, SPI, Tomcat, Spring Boot]
summary: 从加载、链接到初始化的完整过程，双亲委派的源码与 JDK 9 模块化后的变化，SPI/Tomcat/Spring Boot 为何以及如何打破委派，类卸载条件与常见类加载异常的排查
---

# 类加载与双亲委派

> [!ABSTRACT] 核心要点
> - 类生命周期：加载 → 链接（验证、准备、解析）→ 初始化 → 使用 → 卸载。**准备**阶段给静态变量赋零值，**初始化**阶段执行 `<clinit>` 才赋程序值；`<clinit>` 由 JVM 加锁保证只执行一次。
> - 双亲委派的实现就是 `ClassLoader#loadClass`：查缓存 → 委派父加载器 → 父找不到才调用自己的 `findClass`。类的唯一性由「加载器 + 全限定名」共同决定。
> - JDK 9 起扩展类加载器变为**平台类加载器**，内置加载器不再是 `URLClassLoader`，且会按「包所属模块」直接委派给对应加载器。
> - 打破委派的典型场景：SPI（父加载器通过**线程上下文类加载器**反向加载实现类）、Tomcat（Web 应用类优先、应用间隔离）、热部署（丢弃整个类加载器）。
> - `ClassNotFoundException` 是按名字主动加载找不到；`NoClassDefFoundError` 是编译时存在、运行时链接找不到，或类之前**初始化失败**。

## 类的生命周期

<figure class="fig">
<svg viewBox="0 0 760 200" class="dg" role="img" aria-label="类的生命周期：加载、验证、准备、解析、初始化、使用、卸载">
<text class="ts" x="20" y="24">加载、验证、准备、初始化、卸载的开始顺序固定；解析可以推迟到初始化之后（支持运行期绑定）</text>
<rect class="b1" x="20" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="65" y="95" text-anchor="middle" dominant-baseline="middle">加载</text>
<rect class="bg" x="126" y="40" width="334" height="100" rx="12"/>
<text class="ts" x="293" y="58" text-anchor="middle">链接 Linking</text>
<rect class="b2" x="140" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="185" y="95" text-anchor="middle" dominant-baseline="middle">验证</text>
<rect class="b2" x="248" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="293" y="95" text-anchor="middle" dominant-baseline="middle">准备</text>
<rect class="b2" x="356" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="401" y="95" text-anchor="middle" dominant-baseline="middle">解析</text>
<rect class="b3" x="476" y="70" width="90" height="50" rx="8"/>
<text class="tb" x="521" y="95" text-anchor="middle" dominant-baseline="middle">初始化</text>
<rect class="b" x="582" y="70" width="70" height="50" rx="8"/>
<text class="tb" x="617" y="95" text-anchor="middle" dominant-baseline="middle">使用</text>
<rect class="b4" x="668" y="70" width="72" height="50" rx="8"/>
<text class="tb" x="704" y="95" text-anchor="middle" dominant-baseline="middle">卸载</text>
<line class="l" x1="110" y1="95" x2="138" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="230" y1="95" x2="246" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="338" y1="95" x2="354" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="95" x2="474" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="566" y1="95" x2="580" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="652" y1="95" x2="666" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="65" y="162" text-anchor="middle">字节流→Class</text>
<text class="ts" x="185" y="162" text-anchor="middle">格式/语义/字节码</text>
<text class="ts" x="293" y="162" text-anchor="middle">静态变量赋零值</text>
<text class="ts" x="401" y="162" text-anchor="middle">符号→直接引用</text>
<text class="ts" x="521" y="162" text-anchor="middle">执行 &lt;clinit&gt;</text>
<text class="ts" x="704" y="162" text-anchor="middle">加载器回收后</text>
<text class="ts" x="401" y="182" text-anchor="middle">可延迟到使用时</text>
</svg>
<figcaption>图 1：类的生命周期</figcaption>
</figure>

### 加载

1. 通过全限定名获取二进制字节流——来源不限：jar/目录、网络、运行时生成（动态代理、CGLIB）、JSP 编译、加密文件解密等，这正是自定义类加载器的切入点；
2. 将字节流解析为方法区（元空间）中的运行时数据结构（`InstanceKlass`）；
3. 在堆中生成 `java.lang.Class` 对象作为访问入口。

数组类不由类加载器创建，而是 JVM 直接构造；其「定义加载器」是元素类型的加载器（基本类型数组归启动类加载器）。

### 链接

- **验证**：文件格式（魔数 `0xCAFEBABE`、版本号）、元数据（是否继承了 final 类）、字节码（基于 `StackMapTable` 的类型检查，确保不会出现操作数栈类型错乱）、符号引用（解析时检查访问权限）。`-Xverify:none` / `-XX:-BytecodeVerificationRemote` 可关闭部分验证，JDK 13 起 `-Xverify:none` 已被废弃。
- **准备**：为静态变量分配内存并赋**零值**。`public static int v = 123;` 准备后 `v == 0`，赋 123 的 `putstatic` 在 `<clinit>` 中；但 `public static final int V = 123;` 这种编译期常量有 `ConstantValue` 属性，准备阶段直接赋值。
- **解析**：把常量池中的符号引用（类、字段、方法、接口方法、方法类型、方法句柄、调用点限定符）替换为直接引用。HotSpot 采用**惰性解析**，第一次执行到相关指令时才解析，结果缓存在 ConstantPoolCache 中。

### 初始化

执行编译器自动生成的 `<clinit>`：按源码顺序收集静态变量赋值语句和 `static {}` 块。几条规则：

- 父类 `<clinit>` 先于子类执行；接口初始化不要求父接口先初始化。
- 静态块只能访问定义在它之前的静态变量，对后面的变量可以赋值但不能读取（非法前向引用）。
- 没有静态变量赋值和静态块的类，不生成 `<clinit>`。

## 初始化触发时机与 `<clinit>` 线程安全

《JVM 规范》严格规定**有且仅有**以下情况会触发初始化（主动引用）：

| 场景 | 例子 |
| --- | --- |
| 执行 `new`、`getstatic`、`putstatic`、`invokestatic` | `new A()`、读写非常量静态字段、调用静态方法 |
| 反射调用 | `Class.forName("A")`（默认 initialize=true）、`Method.invoke` 静态方法 |
| 初始化子类时父类未初始化 | — |
| 虚拟机启动时的主类 | 含 `main` 的类 |
| 方法句柄解析结果为 `REF_getStatic`/`REF_putStatic`/`REF_invokeStatic`/`REF_newInvokeSpecial` | `MethodHandles.lookup().findStatic(...)` 被调用时 |
| 接口定义了 default 方法，其实现类初始化时 | JDK 8+ |

被动引用不会触发初始化：

```java
class Parent { static int value = 1; static { System.out.println("Parent init"); } }
class Child extends Parent { static { System.out.println("Child init"); } }
class Const { static final String NAME = "x"; static { System.out.println("Const init"); } }

System.out.println(Child.value);      // 只输出 Parent init：通过子类引用父类静态字段，子类不初始化
Child[] arr = new Child[10];          // 什么都不输出：newarray 创建的是 [LChild; 数组类
System.out.println(Const.NAME);       // 不输出：编译期常量已被内联进调用方常量池
ClassLoader.getSystemClassLoader().loadClass("Child"); // 只加载不初始化
```

> [!TIP] Class.forName 与 ClassLoader.loadClass 的区别
> `Class.forName(name)` 使用调用者的类加载器并**执行初始化**（JDBC 4 之前靠它触发驱动的静态块注册到 `DriverManager`）；`loadClass(name)` 只加载、不链接不初始化。Spring 等框架扫描类时用后者，避免触发不必要的静态块。

**`<clinit>` 的线程安全**：JVM 在初始化前为每个类获取一把初始化锁，多线程同时触发时只有一个线程执行 `<clinit>`，其他线程阻塞等待，执行完毕后其他线程不会再执行。静态内部类单例（Holder 模式）正是利用了这点。若 `<clinit>` 抛出异常，类被标记为初始化失败（erroneous），首次调用方得到 `ExceptionInInitializerError`，**之后所有使用者得到 `NoClassDefFoundError: Could not initialize class X`**。

> [!CAUTION] 类初始化死锁
> 线程 1 初始化 A，A 的静态块里用到 B；线程 2 同时初始化 B，B 的静态块里用到 A——两线程互相等待对方的初始化锁。这种死锁**不会**被 jstack 的死锁检测报告，线程状态常显示为 `RUNNABLE` 或 `in Object.wait()`，栈顶停在 `<clinit>`。避免在静态块中做跨类的复杂初始化，尤其是相互引用的类。

## 双亲委派模型

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="双亲委派：类加载请求先向上委派给父加载器，父加载器无法加载时才由子加载器自行查找">
<rect class="b5" x="200" y="30" width="260" height="56" rx="8"/>
<text class="tb" x="330" y="50" text-anchor="middle" dominant-baseline="middle">启动类加载器 Bootstrap</text>
<text class="ts" x="330" y="72" text-anchor="middle" dominant-baseline="middle">C++ 实现 · java.base 等核心模块</text>
<rect class="b1" x="200" y="110" width="260" height="56" rx="8"/>
<text class="tb" x="330" y="130" text-anchor="middle" dominant-baseline="middle">平台类加载器 Platform</text>
<text class="ts" x="330" y="152" text-anchor="middle" dominant-baseline="middle">JDK 8 为扩展类加载器 Ext</text>
<rect class="b1" x="200" y="190" width="260" height="56" rx="8"/>
<text class="tb" x="330" y="210" text-anchor="middle" dominant-baseline="middle">应用类加载器 App</text>
<text class="ts" x="330" y="232" text-anchor="middle" dominant-baseline="middle">classpath / module path</text>
<rect class="b2" x="200" y="270" width="260" height="56" rx="8"/>
<text class="tb" x="330" y="290" text-anchor="middle" dominant-baseline="middle">自定义类加载器</text>
<text class="ts" x="330" y="312" text-anchor="middle" dominant-baseline="middle">继承 ClassLoader，重写 findClass</text>
<line class="la" x1="290" y1="270" x2="290" y2="248" marker-end="url(#arr-a)"/>
<line class="la" x1="290" y1="190" x2="290" y2="168" marker-end="url(#arr-a)"/>
<line class="la" x1="290" y1="110" x2="290" y2="88" marker-end="url(#arr-a)"/>
<line class="l" x1="370" y1="86" x2="370" y2="108" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="166" x2="370" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="246" x2="370" y2="268" marker-end="url(#arr)"/>
<text class="ta" x="282" y="262" text-anchor="end">① 先委派父加载器</text>
<text class="ts" x="380" y="182">② 父加载失败，自己找</text>
<rect class="bg" x="500" y="30" width="240" height="296" rx="12"/>
<text class="tb" x="516" y="54">loadClass(name) 流程</text>
<text class="t" x="516" y="82">1. findLoadedClass 查缓存</text>
<text class="t" x="516" y="106">2. parent.loadClass 委派</text>
<text class="t" x="516" y="130">   parent 为 null → Bootstrap</text>
<text class="t" x="516" y="154">3. 父抛出 CNFE / 返回 null</text>
<text class="t" x="516" y="178">   → findClass 自己加载</text>
<text class="t" x="516" y="202">4. resolve 时 resolveClass</text>
<text class="ts" x="516" y="238">全程持有 getClassLoadingLock(name)</text>
<text class="ts" x="516" y="258">并行加载器按类名细粒度加锁</text>
<text class="ts" x="516" y="292">类的唯一性 = 定义加载器 + 全限定名</text>
</svg>
<figcaption>图 2：双亲委派模型（父子是组合关系而非继承）</figcaption>
</figure>

```java
// JDK 17 java.lang.ClassLoader#loadClass（节选）
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {       // 并行加载器：每个类名一把锁；否则锁 this
        Class<?> c = findLoadedClass(name);           // 1. 该加载器是否已加载过
        if (c == null) {
            try {
                if (parent != null) {
                    c = parent.loadClass(name, false); // 2. 委派父加载器
                } else {
                    c = findBootstrapClassOrNull(name); // 父为 null 代表启动类加载器
                }
            } catch (ClassNotFoundException e) {
                // 父加载器找不到，吞掉异常，交给自己
            }
            if (c == null) {
                c = findClass(name);                   // 3. 自己找（子类重写这里）
            }
        }
        if (resolve) {
            resolveClass(c);
        }
        return c;
    }
}
```

**为什么需要双亲委派**：

1. **安全**：用户自己写一个 `java.lang.String` 也无法替换核心类——请求最终委派到启动类加载器，加载的始终是 JDK 的版本；而且 `defineClass` 会拒绝定义 `java.*` 包下的类（`SecurityException: Prohibited package name`）。
2. **避免重复加载**：同一个类在上层加载一次，下层共享，保证 `Object` 在整个 JVM 中是同一个类型。

**类的唯一性**：两个类「相等」（`equals`、`isInstance`、`instanceof`、类型转换）要求**定义加载器相同**且全限定名相同。同一个 class 文件被两个加载器加载会得到两个不兼容的类型，于是出现 `ClassCastException: com.a.User cannot be cast to com.a.User`——热部署框架和 Spring DevTools 中很常见。

> [!TIP] 重写 findClass，而不是 loadClass
> 只想从新的来源加载类（加密 class、数据库、网络），应继承 `ClassLoader` 并重写 `findClass`，委派逻辑保持不变。重写 `loadClass` 意味着主动打破双亲委派，需要自己处理好核心类的委派，否则会出现类型冲突。

```java
public class DecryptClassLoader extends ClassLoader {
    static { registerAsParallelCapable(); }   // 声明为并行加载器，按类名加锁
    private final Path root;

    public DecryptClassLoader(Path root, ClassLoader parent) {
        super(parent);
        this.root = root;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        Path file = root.resolve(name.replace('.', '/') + ".class.enc");
        try {
            byte[] bytes = decrypt(Files.readAllBytes(file));
            return defineClass(name, bytes, 0, bytes.length);
        } catch (IOException e) {
            throw new ClassNotFoundException(name, e);
        }
    }

    private byte[] decrypt(byte[] data) { /* 解密逻辑 */ return data; }
}
```

## JDK 9 模块化后的变化

| 对比项 | JDK 8 | JDK 9+ |
| --- | --- | --- |
| 中间层加载器 | 扩展类加载器 `ExtClassLoader`，加载 `jre/lib/ext` | 平台类加载器 `PlatformClassLoader`，加载部分 JDK 模块（如 `java.sql`、`java.xml.crypto`） |
| 内置加载器的类型 | `URLClassLoader` 子类 | `jdk.internal.loader.BuiltinClassLoader` 子类，**不再是 `URLClassLoader`** |
| 核心类来源 | `rt.jar` | 模块镜像 `lib/modules`（jimage） |
| 委派规则 | 严格父优先 | 先看包属于哪个命名模块，**直接委派给定义该模块的加载器**；未命名模块（classpath）才走父优先 |
| 扩展机制 | `-Djava.ext.dirs`、endorsed 目录 | 已移除，改用 module path / classpath |

```java
// JDK 17 jdk.internal.loader.BuiltinClassLoader#loadClassOrNull（节选）
protected Class<?> loadClassOrNull(String cn, boolean resolve) {
    synchronized (getClassLoadingLock(cn)) {
        Class<?> c = findLoadedClass(cn);
        if (c == null) {
            LoadedModule loadedModule = findLoadedModule(cn);   // 按包名找所属模块
            if (loadedModule != null) {
                BuiltinClassLoader loader = loadedModule.loader();
                if (loader == this) {
                    c = findClassInModuleOrNull(loadedModule, cn);
                } else {
                    c = loader.loadClassOrNull(cn);              // 直接交给该模块的加载器
                }
            } else {
                if (parent != null) {
                    c = parent.loadClassOrNull(cn);              // 不在命名模块中：父优先
                }
                if (c == null && hasClassPath()) {
                    c = findClassOnClassPathOrNull(cn);
                }
            }
        }
        if (resolve && c != null) resolveClass(c);
        return c;
    }
}
```

> [!WARNING] 升级 JDK 11/17 的经典报错
> 老代码 `(URLClassLoader) ClassLoader.getSystemClassLoader()` 然后反射调用 `addURL` 动态加 jar，在 JDK 9+ 直接抛 `ClassCastException`。替代方案：自建 `URLClassLoader`、使用 `Instrumentation.appendToSystemClassLoaderSearch`，或启动时就把 jar 放上 classpath。

## 打破双亲委派

### SPI 与线程上下文类加载器

JDBC 的 `DriverManager` 位于 JDK 内部（JDK 8 由启动类加载器加载，JDK 9+ 在 `java.sql` 模块中由平台类加载器加载），而 MySQL 驱动在应用 classpath 上。按双亲委派，父加载器看不见子加载器加载的类，`DriverManager` 无法直接加载 `com.mysql.cj.jdbc.Driver`。

解决办法是**线程上下文类加载器（TCCL）**：父加载器加载的代码通过当前线程「借」一个子加载器来加载实现类，形成逆向委派。

```java
// JDK 17 java.util.ServiceLoader（节选）
public static <S> ServiceLoader<S> load(Class<S> service) {
    ClassLoader cl = Thread.currentThread().getContextClassLoader();   // 取 TCCL，默认是 App 加载器
    return new ServiceLoader<>(Reflection.getCallerClass(), service, cl);
}
// DriverManager 初始化驱动时：
ServiceLoader<Driver> loadedDrivers = ServiceLoader.load(Driver.class);
// 读取 META-INF/services/java.sql.Driver，用 TCCL 加载其中列出的实现类
```

TCCL 默认继承自创建它的父线程，主线程为应用类加载器。JNDI、JAXP、JCE、SLF4J 1.x 之前的 commons-logging 等都用类似机制。

> [!WARNING] TCCL 不对导致的「找不到实现」
> - **ForkJoinPool 公共池**：`parallelStream()`、`CompletableFuture.supplyAsync()`（未指定线程池）运行在公共池线程上，其 TCCL 是系统类加载器。在 Spring Boot fat jar 里，这些线程中调用 `ServiceLoader` 或 JAXB 等会找不到 `BOOT-INF/lib` 中的类。
> - **框架自建线程**：在 Tomcat/OSGi 中由第三方库创建的线程可能继承了错误的 TCCL。
> - 修复：在任务开始时显式 `Thread.currentThread().setContextClassLoader(App.class.getClassLoader())`，结束后恢复；或给异步任务指定自定义线程池。

### Tomcat 的类加载器结构

Web 容器需要：多个应用的同名类互相隔离（应用 A 用 Spring 5，应用 B 用 Spring 6）；容器自身的类不被应用看到；应用可以共享部分库；JSP 修改后能热替换。

<figure class="fig">
<svg viewBox="0 0 760 395" class="dg" role="img" aria-label="Tomcat 类加载器层级：Bootstrap、System、Common，其下为 Catalina 与 Shared，Shared 下为各个 WebApp 类加载器和 Jasper 加载器">
<rect class="b5" x="260" y="20" width="240" height="40" rx="8"/>
<text class="tb" x="380" y="40" text-anchor="middle" dominant-baseline="middle">Bootstrap / Platform</text>
<text class="ts" x="512" y="44">JDK 核心类</text>
<rect class="b1" x="260" y="84" width="240" height="40" rx="8"/>
<text class="tb" x="380" y="104" text-anchor="middle" dominant-baseline="middle">System（App）</text>
<text class="ts" x="512" y="108">bootstrap.jar、tomcat-juli.jar</text>
<rect class="b1" x="260" y="148" width="240" height="40" rx="8"/>
<text class="tb" x="380" y="168" text-anchor="middle" dominant-baseline="middle">Common</text>
<text class="ts" x="512" y="172">$CATALINA_HOME/lib，容器与应用共享</text>
<line class="l" x1="380" y1="60" x2="380" y2="84"/>
<line class="l" x1="380" y1="124" x2="380" y2="148"/>
<rect class="b" x="60" y="212" width="200" height="40" rx="8"/>
<text class="tb" x="160" y="232" text-anchor="middle" dominant-baseline="middle">Catalina（Server）</text>
<rect class="b" x="500" y="212" width="200" height="40" rx="8"/>
<text class="tb" x="600" y="232" text-anchor="middle" dominant-baseline="middle">Shared</text>
<line class="l" x1="380" y1="188" x2="160" y2="212"/>
<line class="l" x1="380" y1="188" x2="600" y2="212"/>
<text class="ts" x="160" y="268" text-anchor="middle">Tomcat 自身实现，对应用不可见</text>
<rect class="b2" x="420" y="276" width="150" height="40" rx="8"/>
<text class="tb" x="495" y="296" text-anchor="middle" dominant-baseline="middle">WebApp 1</text>
<rect class="b2" x="590" y="276" width="150" height="40" rx="8"/>
<text class="tb" x="665" y="296" text-anchor="middle" dominant-baseline="middle">WebApp 2</text>
<line class="l" x1="600" y1="252" x2="495" y2="276"/>
<line class="l" x1="600" y1="252" x2="665" y2="276"/>
<rect class="b3" x="420" y="340" width="150" height="40" rx="8"/>
<text class="tb" x="495" y="360" text-anchor="middle" dominant-baseline="middle">Jasper</text>
<line class="l" x1="495" y1="316" x2="495" y2="340"/>
<text class="ts" x="582" y="364">每个 JSP 一个，可热替换</text>
<rect class="bg" x="20" y="282" width="380" height="104" rx="10"/>
<text class="tb" x="32" y="302">WebappClassLoader 加载顺序</text>
<text class="t" x="32" y="324">① 本地缓存 → JVM 已加载缓存</text>
<text class="t" x="32" y="344">② JavaSE 加载器（防止覆盖 JDK 核心类）</text>
<text class="t" x="32" y="364">③ WEB-INF/classes、WEB-INF/lib（应用优先）</text>
<text class="t" x="32" y="382">④ 最后才委派父加载器（Common）</text>
</svg>
<figcaption>图 3：Tomcat 类加载器结构（Tomcat 6+ 默认不配置 server/shared.loader，Catalina 与 Shared 退化为 Common）</figcaption>
</figure>

```java
// Tomcat 9 WebappClassLoaderBase#loadClass（节选，删去安全检查、日志与 try/catch，父加载失败时实际是捕获 CNFE 后继续）
public Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        Class<?> clazz = findLoadedClass0(name);          // (0) Tomcat 自己的缓存
        if (clazz != null) return clazz;
        clazz = findLoadedClass(name);                    // (0.1) JVM 层缓存
        if (clazz != null) return clazz;
        ClassLoader javaseLoader = getJavaseClassLoader(); // (0.2) 先尝试 JDK 核心类，防止被应用覆盖
        if (tryLoadingFromJavaseLoader(name)) {
            clazz = javaseLoader.loadClass(name);
            if (clazz != null) return clazz;
        }
        boolean delegateLoad = delegate || filter(name, true); // javax.servlet 等容器 API 强制父优先
        if (delegateLoad) {
            clazz = Class.forName(name, false, parent);   // (1) 父优先模式
            if (clazz != null) return clazz;
        }
        clazz = findClass(name);                          // (2) WEB-INF/classes、WEB-INF/lib
        if (clazz != null) return clazz;
        if (!delegateLoad) {
            clazz = Class.forName(name, false, parent);   // (3) 自己找不到再委派父加载器
            if (clazz != null) return clazz;
        }
    }
    throw new ClassNotFoundException(name);
}
```

注意 Tomcat 并非完全不委派：JDK 核心类和 Servlet API 依然由上层加载，保证 `HttpServletRequest` 在容器与应用之间是同一个类型——如果应用 `WEB-INF/lib` 里也打包了 `servlet-api.jar`，会被过滤掉，这也是 Maven 里 servlet 依赖要设为 `provided` 的原因。

### Spring Boot fat jar 与 LaunchedURLClassLoader

标准 JDK 的 `URLClassLoader` 无法加载「jar 中的 jar」。Spring Boot 的可执行 jar 结构：

```text
app.jar
├── META-INF/MANIFEST.MF
│     Main-Class: org.springframework.boot.loader.launch.JarLauncher   # Boot 3.2+；之前为 org.springframework.boot.loader.JarLauncher
│     Start-Class: com.example.App                                     # 真正的业务 main
├── org/springframework/boot/loader/...                                # 启动器自身的类，直接放在根目录
└── BOOT-INF/
    ├── classes/                                                       # 业务代码
    ├── lib/*.jar                                                      # 依赖，以 STORED（不压缩）方式存放
    └── classpath.idx                                                  # 依赖顺序
```

启动流程：

1. `java -jar` 由应用类加载器加载 `JarLauncher` 并调用其 `main`；
2. `JarLauncher` 注册能解析嵌套 jar URL 的协议处理器，用自定义 `JarFile` 实现直接按偏移量读取内层 jar（无需解压，这也是内层 jar 必须 STORED 的原因）；
3. 以 `BOOT-INF/classes` 和 `BOOT-INF/lib/*.jar` 为 URL 创建 `LaunchedURLClassLoader`（Boot 3.2 起为 `LaunchedClassLoader`），其父加载器是应用类加载器——**依然是父优先**；
4. 把它设为 TCCL，再反射调用 `Start-Class` 的 `main`。

因此业务类、依赖类的定义加载器都是 `LaunchedURLClassLoader`，而不是应用类加载器——这就解释了前面 ForkJoinPool 公共池里 `ServiceLoader` 找不到实现类的问题。

> [!NOTE] Spring Boot DevTools 的「重启」
> DevTools 使用两个加载器：base 加载器加载不变的第三方 jar，`RestartClassLoader` 加载项目自己的类。代码变化时丢弃 `RestartClassLoader` 重建，比冷启动快得多。副作用：同一个类可能被两个加载器各加载一份，反序列化缓存对象时出现 `ClassCastException`，可通过 `META-INF/spring-devtools.properties` 调整包含规则。

## 热部署与类卸载

HotSpot 中一个类要被卸载，必须**同时**满足：

1. 该类所有实例都已被回收；
2. 加载该类的**类加载器**已被回收；
3. 该类的 `java.lang.Class` 对象没有在任何地方被引用（包括反射缓存、静态集合）。

由于类元数据按加载器整体管理，实际上卸载的粒度是「整个加载器」。启动/平台/应用加载器加载的类在进程生命周期内永远不会卸载，只有自定义加载器加载的类才可能被卸载。类卸载发生在 Full GC 或 G1 的并发周期（Remark 阶段，`ClassUnloadingWithConcurrentMark` 默认开启）中，可用 `-Xlog:class+unload` 观察。

热部署的几种层次：

| 方式 | 原理 | 限制 |
| --- | --- | --- |
| JVMTI `RedefineClasses` / `RetransformClasses` | IDE 调试热替换、Arthas `redefine`/`retransform` | 只能改方法体，不能增删字段/方法、改继承关系 |
| 丢弃类加载器重建 | Tomcat `reloadable`、OSGi、DevTools | 旧加载器必须能被 GC，否则元空间泄漏 |
| 增强版 JVM / Agent | DCEVM + HotswapAgent、JRebel | 依赖特定 JDK 构建或商业工具 |

> [!CAUTION] 类加载器泄漏
> Web 应用重新部署多次后 `Metaspace` OOM，典型原因是旧的 `WebappClassLoader` 被以下对象强引用而无法回收：
> - 应用启动的线程（定时任务、连接池清理线程）未停止，其 TCCL 指向旧加载器；
> - JDBC 驱动注册在 `DriverManager`（由上层加载器加载）中未注销；
> - `ThreadLocal` 的值是应用类的实例，存在于容器线程池的线程里；
> - 日志框架、JMX MBean、`java.beans.Introspector` 缓存等持有应用类。
> Tomcat 停止应用时会打印 `appears to have started a thread named [...] but has failed to stop it` 等警告，就是在提示这些泄漏源。用 MAT 对旧 `WebappClassLoader` 实例执行「Path to GC Roots」即可定位。

## ClassNotFoundException vs NoClassDefFoundError

| 对比项 | `ClassNotFoundException` | `NoClassDefFoundError` |
| --- | --- | --- |
| 类型 | 受检异常（`Exception`） | 错误（`LinkageError` 子类） |
| 触发方式 | 代码**按名字主动加载**：`Class.forName`、`loadClass`、`findSystemClass` | JVM **隐式链接**：执行 `new`、访问字段/方法时解析符号引用失败 |
| 典型原因 | 类名拼错、依赖缺失、类在别的加载器可见范围 | 编译时存在、运行时 jar 缺失；**类初始化失败过**（`Could not initialize class X`）；加载器隔离 |
| 排查 | 确认 classpath、TCCL、打包内容 | 查第一次出现的 `ExceptionInInitializerError`，或用 `-verbose:class` / `-Xlog:class+load` 查加载来源 |

同族的链接错误：

- `NoSuchMethodError` / `NoSuchFieldError`：类找到了，但版本不对——**依赖冲突**最常见的表现，用 `mvn dependency:tree -Dverbose` 定位（见 [Maven 构建与依赖管理](#/java/eng/maven)），再用 `-Xlog:class+load` 或 Arthas `sc -d 类名` 查看实际从哪个 jar 加载。
- `LinkageError: loader constraint violation`：同一个类名在两个加载器中各有一份，并在方法签名中「相遇」。
- `ClassCastException: X cannot be cast to X`：同名不同加载器。

## 生产实践与踩坑

1. **静态块里连数据库/读配置失败**：第一次报 `ExceptionInInitializerError`，之后全是 `NoClassDefFoundError`，日志被后者刷屏，真正的根因只在最早那一条，排查时一定要往前翻。
2. **依赖冲突导致的随机性**：classpath 上同时有 guava 19 和 31，加载哪个取决于 jar 顺序，不同机器、不同打包方式表现不一致。Spring Boot 的 `classpath.idx` 固定了顺序，但根治仍需 `dependencyManagement` 统一版本或 `maven-enforcer-plugin` 检查。
3. **动态生成类撑爆元空间**：每次请求 `new GroovyClassLoader().parseClass(script)`，或 CGLIB `Enhancer` 关闭缓存，类数量持续增长。缓存编译结果、复用加载器。
4. **Agent 与类加载器**：Java Agent 的类由应用类加载器加载，而被增强的业务类可能在 `LaunchedURLClassLoader` 或 WebApp 加载器中，增强代码直接引用业务类会 `NoClassDefFoundError`，需通过反射或把桥接类注入到 Bootstrap 搜索路径。
5. **`-verbose:class` 快速定位来源**：输出每个类的加载来源 jar，排查「到底加载了哪个版本」最直接；JDK 9+ 等价于 `-Xlog:class+load=info`。

## 相关阅读

- [字节码与执行引擎](#/java/jvm/bytecode)：字节码与执行引擎
- [Spring Boot 自动配置与启动](#/spring/boot)：Spring Boot 的类加载与启动
- [反射、注解与动态代理](#/java/api/reflect)：反射与动态代理

## 面试追问

> [!QUESTION] 如果我自己写一个 java.lang.String 类，能被加载吗？
> 不能替换核心类。按双亲委派，请求最终到达启动类加载器，加载的是 JDK 自带的 `String`；即使自定义加载器绕过委派直接 `defineClass`，JVM 也会因包名以 `java.` 开头抛出 `SecurityException`。JDK 9+ 中 `java.lang` 属于 `java.base` 模块，在 classpath 上声明同包类还会因包冲突无法生效。

> [!QUESTION] 为什么说 SPI 打破了双亲委派？TCCL 的本质是什么？
> SPI 接口由上层加载器加载，实现类却在下层 classpath，上层加载器按委派规则看不到。TCCL 是挂在线程上的一个加载器引用，让上层代码可以显式拿到下层加载器去加载实现类，相当于逆向委派。它本质是一种「把加载器作为隐式参数传递」的手段，问题是隐式状态容易在线程池中错乱。

> [!QUESTION] Tomcat 为什么要打破双亲委派？它完全不委派吗？
> 为了应用间隔离和应用类优先：不同应用可以使用同名不同版本的库，应用自带的库优先于容器共享库。但它不是完全不委派：JDK 核心类先交给 JavaSE 加载器，Servlet 等容器 API 强制父优先，自己找不到时最后仍委派给 Common。

> [!QUESTION] `<clinit>` 是线程安全的吗？有什么风险？
> 是。JVM 用类初始化锁保证同一时刻只有一个线程执行，其它线程等待，执行一次后不再执行，这是 Holder 单例的基础。风险是：静态块耗时长会阻塞所有使用该类的线程；两个类的静态块互相依赖且被不同线程同时触发会死锁，且 jstack 不会报告；静态块抛异常后该类永久不可用。

> [!QUESTION] 一个类什么时候会被卸载？为什么 Metaspace 会泄漏？
> 需同时满足：实例全部回收、加载它的类加载器被回收、Class 对象无引用。内置加载器加载的类永不卸载。Metaspace 泄漏通常是自定义加载器被线程、ThreadLocal、静态注册表等强引用，或者不断创建新加载器加载动态生成的类且被缓存持有。
