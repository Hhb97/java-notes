---
level: 深入
tags: [反射, MethodHandle, 注解, APT, 动态代理, CGLIB, JPMS]
summary: 剖析反射调用的实现演进（inflation 到 JEP 416）、MethodHandle/VarHandle、注解的运行时本质与编译期处理、三种动态代理的生成类结构，以及 JDK 17 强封装带来的兼容问题
---

# 反射、注解与动态代理

> [!ABSTRACT] 核心要点
> - `Class` 对象是堆中的「镜像」，真正的类元数据（Klass）在 Metaspace；反射 API 返回的 `Method/Field` 每次都是**拷贝**，并且有访问检查开销，热点路径应缓存。
> - `Method.invoke` 在 JDK 8～17：前 15 次走 JNI 的 `NativeMethodAccessorImpl`，之后（inflation）生成 `GeneratedMethodAccessorN` 字节码类；JDK 18 起（JEP 416）改为基于 `MethodHandle` 实现。
> - 运行时注解是一个**JDK 动态代理对象**，`AnnotationInvocationHandler` 持有「属性名 → 值」的 Map；编译期注解由 JSR 269 注解处理器（APT）处理，Lombok 则是越过公开 API 直接修改 javac 的 AST。
> - JDK 动态代理生成 `$ProxyN extends Proxy implements 接口`，方法统一转发到 `InvocationHandler`；CGLIB / ByteBuddy 生成**子类**覆盖非 final 方法，因此能代理类但不能代理 final 方法。
> - JDK 16 起默认强封装、JDK 17 移除 `--illegal-access`：反射 `setAccessible(true)` 访问 JDK 内部私有成员会抛 `InaccessibleObjectException`，需 `--add-opens`。

## Class 与反射元数据

- 类加载后，HotSpot 在 Metaspace 中保存 `InstanceKlass`（字段表、方法表、常量池、vtable 等），在堆中创建对应的 `java.lang.Class` 镜像对象，两者互相引用。静态变量从 JDK 7 起存放在 Class 镜像中（即堆里）。细节见 [运行时数据区与对象模型](#/java/jvm/memory)。
- 获取 Class 的三种方式：`Foo.class`（不触发初始化）、`obj.getClass()`、`Class.forName("x.Foo")`（默认触发静态初始化，可用三参版本关闭）。
- `getDeclaredMethods()` 由 JVM 提供原始数据，`Class` 内部用 `SoftReference<ReflectionData>` 缓存；但**返回给调用方的数组和 Method 对象都是新拷贝**（`copyMethod`），每次调用都有分配开销。
- `getMethods()` 返回 public 方法（含继承），`getDeclaredMethods()` 返回本类声明的所有方法（不含继承，含桥方法和合成方法）。

```java
// 错误示范：每次调用都查找 + 拷贝 + 访问检查
Object v = obj.getClass().getMethod("getName").invoke(obj);

// 正确做法：启动时解析，缓存 Method 并 setAccessible(true) 跳过每次的访问检查
private static final Method GET_NAME;
static {
    try {
        GET_NAME = User.class.getMethod("getName");
        GET_NAME.setAccessible(true);
    } catch (NoSuchMethodException e) { throw new ExceptionInInitializerError(e); }
}
```

## Method.invoke 的实现演进

<figure class="fig">
<svg viewBox="0 0 760 220" class="dg" role="img" aria-label="Method.invoke 在 JDK 8 到 17 使用 Native 和 Generated 两种 accessor，在 JDK 18 起使用 MethodHandle">
<text class="tb" x="20" y="20">JDK 8 ～ 17</text>
<rect class="b" x="20" y="50" width="130" height="36" rx="6"/>
<text class="tm" x="85" y="68" text-anchor="middle" dominant-baseline="middle">Method.invoke</text>
<line class="l" x1="150" y1="68" x2="180" y2="68" marker-end="url(#arr)"/>
<rect class="b1" x="180" y="50" width="200" height="36" rx="6"/>
<text class="tm" x="280" y="68" text-anchor="middle" dominant-baseline="middle">DelegatingMethodAccessor</text>
<line class="l" x1="380" y1="62" x2="410" y2="48" marker-end="url(#arr)"/>
<line class="la" x1="380" y1="74" x2="410" y2="98" marker-end="url(#arr-a)"/>
<rect class="b3" x="410" y="30" width="330" height="36" rx="6"/>
<text class="t" x="575" y="48" text-anchor="middle" dominant-baseline="middle">NativeMethodAccessorImpl（前 15 次）</text>
<rect class="b2" x="410" y="80" width="330" height="36" rx="6"/>
<text class="t" x="575" y="98" text-anchor="middle" dominant-baseline="middle">GeneratedMethodAccessorN：生成的字节码</text>
<text class="ts" x="410" y="132">超过阈值后切换 delegate（inflation），JIT 可以内联生成类</text>
<text class="tb" x="20" y="150">JDK 18+（JEP 416）</text>
<rect class="b" x="20" y="166" width="130" height="36" rx="6"/>
<text class="tm" x="85" y="184" text-anchor="middle" dominant-baseline="middle">Method.invoke</text>
<line class="l" x1="150" y1="184" x2="180" y2="184" marker-end="url(#arr)"/>
<rect class="b1" x="180" y="166" width="230" height="36" rx="6"/>
<text class="tm" x="295" y="184" text-anchor="middle" dominant-baseline="middle">DirectMethodHandleAccessor</text>
<line class="la" x1="410" y1="184" x2="440" y2="184" marker-end="url(#arr-a)"/>
<rect class="b2" x="440" y="166" width="300" height="36" rx="6"/>
<text class="t" x="590" y="184" text-anchor="middle" dominant-baseline="middle">MethodHandle（静态常量时可被 JIT 折叠）</text>
</svg>
<figcaption>图 1：反射调用路径的两代实现</figcaption>
</figure>

### JDK 8～17：inflation 机制

```java
// JDK 8 sun.reflect.NativeMethodAccessorImpl（节选）
public Object invoke(Object obj, Object[] args) throws ... {
    if (++numInvocations > ReflectionFactory.inflationThreshold()      // 默认 15
            && !ReflectUtil.isVMAnonymousClass(method.getDeclaringClass())) {
        MethodAccessorImpl acc = (MethodAccessorImpl)
            new MethodAccessorGenerator().generateMethod(...);         // 用 ASM 风格的生成器拼字节码
        parent.setDelegate(acc);                                       // 替换委托，后续走生成类
    }
    return invoke0(method, obj, args);                                 // native 调用
}
```

- **为什么不一开始就生成字节码**：生成并加载一个类的代价远大于几次 JNI 调用；大量反射只调用一两次（如启动时读配置），生成类不划算。JNI 调用本身较慢且 JIT 无法内联穿透，所以热点调用切换到生成类。
- 参数：`-Dsun.reflect.inflationThreshold=N`；`-Dsun.reflect.noInflation=true` 跳过 native 阶段直接生成。
- **坑**：每个生成的 `GeneratedMethodAccessorN` 由独立的 `DelegatingClassLoader` 加载（方便单独卸载）。大量反射目标（如 JSON 序列化上千个 DTO 的 getter）会生成上千个类，Metaspace 增长；GC 日志里会看到大量 `Unloading class sun.reflect.GeneratedMethodAccessor...`。限制 `MaxMetaspaceSize` 过小时可能导致 Metaspace OOM 或频繁 Full GC。

### JDK 18+：JEP 416 基于 MethodHandle 重写

- `Method`、`Constructor`、`Field` 的核心反射改为使用 `java.lang.invoke` 的方法句柄（`DirectMethodHandleAccessor`、`MethodHandleXxxFieldAccessorImpl`），去掉了 inflation 与字节码生成器，统一了反射与方法句柄两套实现。
- 性能：当 `Method` 对象是 `static final` 常量时，JIT 能把整个调用链折叠内联，显著快于旧实现；非常量的 Method（如放在 Map 里查出来）性能与旧实现大致相当，某些情况下首次调用略慢。
- 兼容开关：JDK 18～21 可用 `-Djdk.reflect.useDirectMethodHandle=false` 回退旧实现，后续版本已移除旧实现。
- 虚拟机启动早期（`java.lang.invoke` 尚未初始化时）仍会使用 native accessor。

## MethodHandle 与 VarHandle

```java
// MethodHandle：访问检查在 lookup 时做一次，调用时不再检查
private static final MethodHandle MH;
static {
    try {
        MH = MethodHandles.lookup()
                .findVirtual(User.class, "getName", MethodType.methodType(String.class));
    } catch (ReflectiveOperationException e) { throw new ExceptionInInitializerError(e); }
}
String name = (String) MH.invokeExact(user);   // 签名必须完全匹配（含返回类型强转），否则 WrongMethodTypeException
```

| 对比 | `Method.invoke` | `MethodHandle` |
| --- | --- | --- |
| 访问检查 | 每次调用（除非 `setAccessible(true)`） | 仅在 `Lookup.findXxx` 时，取决于 Lookup 的来源类权限 |
| 参数 | `Object[]`，基本类型装箱 | 签名多态（`invokeExact` 按调用点的静态类型生成描述符），可避免装箱 |
| JIT | 旧实现难以内联 | `static final` 的句柄可被常量折叠并完全内联 |
| 组合 | 不支持 | `bindTo`、`filterArguments`、`guardWithTest` 等组合子 |
| 应用 | 框架通用反射 | Lambda（`LambdaMetafactory`）、`invokedynamic`、字符串拼接（JDK 9 `StringConcatFactory`） |

`MethodHandles.privateLookupIn(Class, Lookup)`（JDK 9）可以在模块允许（opens）的前提下获取对目标类私有成员的访问能力，是 JDK 9+ 框架替代 `setAccessible` 的推荐方式之一。

**VarHandle**（JDK 9，JEP 193）是变量（字段、数组元素）的强类型引用，提供不同内存语义的访问模式，用来替代 `sun.misc.Unsafe` 的字段 CAS：

```java
class Counter {
    private volatile int count;
    private static final VarHandle COUNT;
    static {
        try {
            COUNT = MethodHandles.lookup().findVarHandle(Counter.class, "count", int.class);
        } catch (ReflectiveOperationException e) { throw new ExceptionInInitializerError(e); }
    }
    void inc() {
        int v;
        do { v = (int) COUNT.getVolatile(this); }
        while (!COUNT.compareAndSet(this, v, v + 1));
    }
}
```

访问模式：`get/set`（plain）、`getOpaque/setOpaque`、`getAcquire/setRelease`、`getVolatile/setVolatile`，以及 `compareAndSet`、`compareAndExchange`、`getAndAdd`、`weakCompareAndSetPlain` 等。JDK 9 起 JUC 中许多类（如 `FutureTask`、`ConcurrentLinkedQueue`、`AtomicReference`）改用 VarHandle 实现。内存语义见 [Java 内存模型与 volatile](#/java/concurrency/jmm)。

## 注解的本质

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface RateLimit {
    int qps() default 100;
    String key() default "";
}
```

1. **编译后**：`@interface` 是一个继承 `java.lang.annotation.Annotation` 的接口，属性是抽象方法，`default` 值存在方法的 `AnnotationDefault` 属性中。
2. **使用处**：注解实例的值写在被注解元素的 `RuntimeVisibleAnnotations` 属性里（`CLASS` 保留策略写在 `RuntimeInvisibleAnnotations`，JVM 加载时忽略；`SOURCE` 不进 class 文件）。
3. **运行时读取**：`method.getAnnotation(RateLimit.class)` 由 `AnnotationParser` 解析属性字节，然后用**JDK 动态代理**创建一个实现 `RateLimit` 接口的对象，`InvocationHandler` 是 `sun.reflect.annotation.AnnotationInvocationHandler`，内部是 `Map<String, Object> memberValues`。

```java
RateLimit r = m.getAnnotation(RateLimit.class);
r.getClass();          // class com.sun.proxy.$Proxy12（JDK 16+ 包名可能是 jdk.proxy1 等）
r.qps();               // → AnnotationInvocationHandler.invoke → memberValues.get("qps")
```

- 解析结果缓存在 `Class` / `Executable` 内部，重复调用开销不大，但返回的数组依然会拷贝。
- `@Inherited` 只对**类上的注解**、且只沿**父类**（不是接口）继承生效，方法注解不会继承。Spring 能在接口方法、元注解（注解上的注解）、`@AliasFor` 属性别名上查找注解，是 `AnnotatedElementUtils` / `MergedAnnotations` 自己实现的递归查找，不是 Java 语义。
- 注解属性只能是基本类型、String、Class、枚举、注解及它们的一维数组，且必须是编译期常量——因为值要写进 class 文件常量池。

## APT 注解处理器与 Lombok 原理

**JSR 269（Pluggable Annotation Processing API，JDK 6）**：javac 在编译过程中按「轮次（round）」调用注解处理器，处理器可以读取源码的元素模型（`Element`、`TypeMirror`），并通过 `Filer` **生成新的源文件或资源文件**，新文件会进入下一轮编译。

```java
@SupportedAnnotationTypes("com.example.AutoMapper")
@SupportedSourceVersion(SourceVersion.RELEASE_17)
public class AutoMapperProcessor extends AbstractProcessor {
    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment env) {
        for (Element e : env.getElementsAnnotatedWith(AutoMapper.class)) {
            // 读取类结构，生成 XxxMapperImpl.java
            JavaFileObject file = processingEnv.getFiler().createSourceFile(e.getSimpleName() + "MapperImpl");
            try (Writer w = file.openWriter()) { w.write("..."); } catch (IOException ex) { ... }
        }
        return true;
    }
}
// 注册：META-INF/services/javax.annotation.processing.Processor（或 Google AutoService 自动生成）
```

- **公开 API 只能「新增」不能「修改」**已有类：MapStruct、AutoValue、Dagger、Hibernate JPA Metamodel、Spring Boot 的 `spring-boot-configuration-processor` 都走这条正规路线，生成新类。
- **Lombok 的做法**：它也注册为注解处理器，但会把 `ProcessingEnvironment` 强转为 javac 内部的 `JavacProcessingEnvironment`，拿到编译器的 AST（`JCTree`），用 `TreeMaker` **直接往已有类的语法树里插入**getter/setter/构造器等节点，之后 javac 按修改后的 AST 生成字节码。这依赖 javac 内部 API，所以：
  - 每次 JDK 大版本升级 Lombok 都需要适配，旧版本 Lombok 在新 JDK 上会直接编译失败（常见报错 `NoSuchFieldError: ... JCTree...` 或 `IllegalAccessError` 访问 `com.sun.tools.javac` 包）；
  - JDK 16+ 强封装后，Lombok 需要 1.18.20 左右及以上版本才能工作；
  - IDE 需要插件才能理解生成的方法。
- 注意：JDK 23 起 javac 默认**不再自动运行**类路径上发现的注解处理器（JDK 21/22 会给出提示），需要用 `-proc:full` 或在 Maven/Gradle 中显式配置 `annotationProcessorPaths`。

## 动态代理：JDK Proxy vs CGLIB vs ByteBuddy

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="JDK 动态代理生成实现接口的 Proxy 子类，CGLIB 生成目标类的子类，调用分别转发到 InvocationHandler 与 MethodInterceptor">
<rect class="bg" x="10" y="10" width="365" height="300" rx="12"/>
<rect class="bg" x="385" y="10" width="365" height="300" rx="12"/>
<text class="th" x="192" y="34" text-anchor="middle">JDK 动态代理（基于接口）</text>
<rect class="b" x="30" y="50" width="150" height="36" rx="6"/>
<text class="tm" x="105" y="68" text-anchor="middle" dominant-baseline="middle">UserService 接口</text>
<rect class="b" x="200" y="50" width="150" height="36" rx="6"/>
<text class="tm" x="275" y="68" text-anchor="middle" dominant-baseline="middle">Proxy（持有 h）</text>
<rect class="b1" x="105" y="125" width="170" height="40" rx="6"/>
<text class="tm" x="190" y="145" text-anchor="middle" dominant-baseline="middle">final $Proxy0</text>
<line class="l" x1="150" y1="125" x2="105" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="230" y1="125" x2="275" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="50" y="112">implements</text>
<text class="ts" x="262" y="112">extends</text>
<line class="l" x1="190" y1="165" x2="190" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="198" y="187">h.invoke(proxy, m3, args)</text>
<rect class="b3" x="105" y="200" width="170" height="36" rx="6"/>
<text class="tm" x="190" y="218" text-anchor="middle" dominant-baseline="middle">InvocationHandler</text>
<line class="l" x1="190" y1="236" x2="190" y2="262" marker-end="url(#arr)"/>
<text class="ts" x="198" y="253">method.invoke(target)</text>
<rect class="b2" x="105" y="262" width="170" height="36" rx="6"/>
<text class="tm" x="190" y="280" text-anchor="middle" dominant-baseline="middle">UserServiceImpl</text>
<text class="th" x="567" y="34" text-anchor="middle">CGLIB（基于继承）</text>
<rect class="b" x="492" y="50" width="150" height="36" rx="6"/>
<text class="tm" x="567" y="68" text-anchor="middle" dominant-baseline="middle">UserServiceImpl</text>
<rect class="b1" x="405" y="125" width="325" height="40" rx="6"/>
<text class="tm" x="567" y="145" text-anchor="middle" dominant-baseline="middle">UserServiceImpl$$EnhancerByCGLIB$$…</text>
<line class="l" x1="567" y1="125" x2="567" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="575" y="110">extends，覆盖非 final 方法</text>
<line class="l" x1="567" y1="165" x2="567" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="575" y="187">interceptor.intercept(...)</text>
<rect class="b3" x="482" y="200" width="170" height="36" rx="6"/>
<text class="tm" x="567" y="218" text-anchor="middle" dominant-baseline="middle">MethodInterceptor</text>
<line class="l" x1="567" y1="236" x2="567" y2="262" marker-end="url(#arr)"/>
<text class="ts" x="575" y="253">methodProxy.invokeSuper</text>
<rect class="b2" x="452" y="262" width="230" height="36" rx="6"/>
<text class="tm" x="567" y="280" text-anchor="middle" dominant-baseline="middle">FastClass → super.save()</text>
</svg>
<figcaption>图 2：两种代理的生成类结构与调用链</figcaption>
</figure>

### JDK 动态代理

```java
UserService proxy = (UserService) Proxy.newProxyInstance(
        loader, new Class<?>[]{UserService.class},
        (p, method, args) -> {
            long t = System.nanoTime();
            try { return method.invoke(target, args); }          // 反射调用目标
            finally { log.info("{} cost {}", method.getName(), System.nanoTime() - t); }
        });
```

反编译生成类（JDK 8 加 `-Dsun.misc.ProxyGenerator.saveGeneratedFiles=true`，JDK 9+ 为 `-Djdk.proxy.ProxyGenerator.saveGeneratedFiles=true`）大致如下：

```java
public final class $Proxy0 extends Proxy implements UserService {
    private static Method m0, m1, m2, m3;    // hashCode / equals / toString / save
    static {
        m3 = Class.forName("com.x.UserService").getMethod("save", User.class);
        ...
    }
    public $Proxy0(InvocationHandler h) { super(h); }
    public final void save(User u) {
        try {
            super.h.invoke(this, m3, new Object[]{u});   // 所有方法统一转发
        } catch (RuntimeException | Error e) { throw e; }
          catch (Throwable t) { throw new UndeclaredThrowableException(t); }
    }
}
```

- 因为生成类已经 `extends Proxy`，Java 单继承决定了它**只能代理接口**。
- `hashCode/equals/toString` 也会被转发给 handler；其它 `Object` 方法（如 `getClass`）不会。
- handler 抛出接口方法未声明的受检异常时，会被包装成 `UndeclaredThrowableException`——AOP 中常见的「异常类型变了」的原因。

### CGLIB

```java
Enhancer en = new Enhancer();
en.setSuperclass(UserServiceImpl.class);
en.setCallback((MethodInterceptor) (obj, method, args, methodProxy) -> {
    // methodProxy.invokeSuper：通过 FastClass 按方法索引 switch 直接调用父类方法，不走反射
    return methodProxy.invokeSuper(obj, args);
});
UserServiceImpl proxy = (UserServiceImpl) en.create();
```

- 生成目标类的**子类**，覆盖所有非 final、非 private 的方法；final 类、final 方法、static 方法无法增强。
- `FastClass` 为目标类和代理类各生成一个辅助类，用 `getIndex(signature)` + `switch(index)` 直接调用，避免反射。
- 代理对象创建时会调用父类构造器（Spring 用 Objenesis 绕过构造器）。
- CGLIB 原项目已停止维护，在新 JDK 上有兼容问题；Spring 在 `spring-core` 中内置并维护了一份分支（`org.springframework.cglib`），Spring 6 中的类名形如 `UserService$$SpringCGLIB$$0`。

### ByteBuddy

现代字节码生成库，提供类型安全的流式 API，可以生成子类、重定义（redefine）或变基（rebase）已有类，并能配合 Java Agent 做运行时插桩。Mockito 2+、Hibernate（5.3 起的默认字节码提供者）、多种 APM Agent 都基于它。

```java
Class<? extends UserServiceImpl> type = new ByteBuddy()
        .subclass(UserServiceImpl.class)
        .method(ElementMatchers.named("save"))
        .intercept(MethodDelegation.to(TimingInterceptor.class))
        .make()
        .load(loader, ClassLoadingStrategy.Default.INJECTION)
        .getLoaded();
```

| 维度 | JDK Proxy | CGLIB | ByteBuddy |
| --- | --- | --- | --- |
| 原理 | 生成实现接口的 `Proxy` 子类 | 生成目标类子类 + FastClass | 生成子类 / 重定义已有类 |
| 要求 | 必须有接口 | 类和方法非 final | 子类模式同 CGLIB；Agent 模式无此限制 |
| 调用目标 | 通常在 handler 中反射调用 | `invokeSuper` 走 FastClass | 委托 / Advice 内联，可接近直接调用 |
| 依赖 | JDK 自带 | 需引入（Spring 已内置） | 需引入 |
| 维护状态 | 持续维护 | 原项目停止维护 | 活跃 |
| 典型使用者 | MyBatis Mapper、Feign、早期 Spring AOP | Spring AOP（类代理）、`@Configuration` 增强 | Mockito、Hibernate、APM Agent |

Spring AOP 的选择规则：Spring Boot 2.x 起默认 `proxyTargetClass = true`（一律 CGLIB），手动设为 false 时有接口才用 JDK 代理。**自调用**（`this.method()`）不经过代理，导致 `@Transactional`、`@Async` 失效，详见 [AOP 与代理机制](#/spring/aop)。

## JPMS 强封装与 --add-opens

| 版本 | 行为 |
| --- | --- |
| JDK 9～15 | `--illegal-access=permit`（默认）：对 JDK 内部的深度反射允许，首次访问打印 `WARNING: Illegal reflective access by ...` |
| JDK 16（JEP 396） | 默认改为 `deny`，仍可用 `--illegal-access=permit` 回退 |
| JDK 17（JEP 403） | 移除 `--illegal-access` 选项，只能通过 `--add-opens` 等参数逐个放开 |

```text
java.lang.reflect.InaccessibleObjectException: Unable to make field private final byte[]
java.lang.String.value accessible: module java.base does not "opens java.lang" to unnamed module @1b6d3586
```

```bash
# 启动参数：把 java.base 的 java.lang 包对类路径上的代码（未命名模块）开放深度反射
java --add-opens java.base/java.lang=ALL-UNNAMED \
     --add-opens java.base/java.util=ALL-UNNAMED \
     -jar app.jar
# 可执行 jar 也可在 MANIFEST.MF 中写：Add-Opens: java.base/java.lang java.base/java.util
```

- `exports` 只开放 public 类型的编译期与运行期访问；`opens` 才开放**深度反射**（访问 private 成员、`setAccessible(true)`）。
- `sun.misc.Unsafe` 位于 `jdk.unsupported` 模块，仍可访问；但 `jdk.internal.misc.Unsafe` 不行。JDK 后续版本已开始逐步弃用 `sun.misc.Unsafe` 的内存访问方法，推荐迁移到 VarHandle 与 FFM API。
- 升级 JDK 17 时，老版本的 Lombok、Groovy、各种序列化库（如旧版 Kryo、XStream、FST）、ASM 基础库和反射修改 `final` 字段的代码最容易出问题；优先升级依赖版本，`--add-opens` 作为过渡。

## 生产实践与踩坑

1. **反射调用热点路径**：每次 `getMethod` + `invoke`，性能比直接调用差一到两个数量级。缓存 `Method`，或用 `MethodHandle` / `LambdaMetafactory` 生成函数式接口实例（接近直接调用）。
2. **GeneratedMethodAccessor 撑爆 Metaspace**：大量反射目标 + 过小的 `MaxMetaspaceSize`，日志中大量 `Unloading class sun.reflect.GeneratedMethodAccessor`。升级 JDK 18+ 或调大 Metaspace。
3. **`InvocationTargetException` 包了一层**：反射调用的目标方法抛出的异常被包装，日志只看外层会以为是反射出错，应取 `getCause()`（或 `getTargetException()`）。
4. **代理后注解读不到**：CGLIB 代理类上 `getClass().getAnnotation()` 读不到原类注解（类注解未标 `@Inherited`，方法注解在覆盖方法上不存在）。使用 `AopUtils.getTargetClass` 或 Spring 的 `AnnotationUtils.findAnnotation`。
5. **JDK 代理强转实现类**：`(UserServiceImpl) ctx.getBean(UserService.class)` 在 JDK 代理下抛 `ClassCastException`，因为代理类只实现接口。
6. **`final` 方法上的切面不生效**：CGLIB 无法覆盖 final 方法，调用直接进入父类实现，且此时代理对象的字段是未初始化的（Objenesis 未调用构造器），可能 NPE。Kotlin 类默认 final，需要 `kotlin-spring` 插件（all-open）。
7. **反射修改 `static final` 字段**：编译期常量会被内联到使用处，改了也不生效；JDK 12 起 `Field.class` 的 `modifiers` 字段被过滤，网上常见的「去掉 final 修饰符」黑魔法失效。

## 面试追问

> [!QUESTION] 反射为什么慢？JDK 做了哪些优化？
> 慢在：方法查找与拷贝、每次调用的访问检查、参数装箱与 `Object[]` 分配、JNI 调用无法内联。JDK 8～17 用 inflation：前 15 次 native，之后生成字节码类；JDK 18 起基于 MethodHandle 重写，`static final` 的 Method 可被 JIT 折叠内联。应用层面：缓存 Method、`setAccessible(true)`、改用 MethodHandle。

> [!QUESTION] 注解本身是怎么在运行时「拿到值」的？
> `@interface` 编译为继承 Annotation 的接口，值存在 class 文件的 `RuntimeVisibleAnnotations` 属性中。`getAnnotation` 解析出「属性名→值」Map，并用 JDK 动态代理创建接口实例，`AnnotationInvocationHandler` 根据方法名从 Map 中返回值。

> [!QUESTION] Lombok 是怎么生成 getter/setter 的？和 MapStruct 有什么区别？
> 两者都是 JSR 269 注解处理器。MapStruct 通过公开的 Filer API 生成新的源文件；Lombok 把处理环境强转为 javac 内部实现，直接修改编译中类的 AST，依赖内部 API，所以 JDK 升级时常需要同步升级 Lombok。

> [!QUESTION] JDK 动态代理和 CGLIB 的区别？为什么 JDK 代理只能代理接口？
> JDK 代理生成 `$Proxy0 extends Proxy implements 接口`，单继承已被 Proxy 占用，只能通过接口扩展；方法统一转发到 InvocationHandler。CGLIB 生成目标类子类，覆盖非 final 方法，通过 MethodInterceptor 与 FastClass 调用父类方法，无法代理 final 类/方法。

> [!QUESTION] MethodHandle 和反射有什么区别？
> MethodHandle 在 lookup 时做访问检查，调用时不再检查；`invokeExact` 签名多态可避免装箱；`static final` 的句柄能被 JIT 完全内联；支持组合变换，是 invokedynamic 与 Lambda 的基础。反射 API 更通用、使用更简单。

> [!QUESTION] 升级到 JDK 17 后出现 InaccessibleObjectException 怎么办？
> JDK 17 强封装 JDK 内部 API，不能再深度反射未 opens 的包。首选升级相关依赖（Lombok、序列化库等）到支持新 JDK 的版本；过渡期用 `--add-opens 模块/包=ALL-UNNAMED` 或 jar 清单中的 `Add-Opens` 放开具体包。
