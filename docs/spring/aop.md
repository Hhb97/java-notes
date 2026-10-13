---
level: 深入
tags: [Spring, AOP, 动态代理, CGLIB, 拦截器链]
summary: 从自动代理创建器、JDK/CGLIB 代理选择到 ReflectiveMethodInvocation 责任链，解释切面为什么生效、为什么失效
---

# AOP 与代理机制

> [!ABSTRACT] 核心要点
> - Spring AOP 是**运行时代理**：`AnnotationAwareAspectJAutoProxyCreator` 作为 BeanPostProcessor，在 `postProcessAfterInitialization` 中为匹配到 Advisor 的 Bean 创建代理，容器里最终放的是代理对象。
> - 有接口且 `proxyTargetClass=false` 用 JDK 动态代理，否则用 CGLIB；**Spring Boot 2.0 起默认 `proxyTargetClass=true`**，即一律 CGLIB。
> - 所有通知被适配成 `MethodInterceptor`，由 `ReflectiveMethodInvocation#proceed` 按下标递归推进，形成"洋葱"式责任链。
> - 5.2.7 起同一切面内通知顺序为 `@Around` → `@Before` → `@After` → `@AfterReturning` → `@AfterThrowing`，`@After` 在 `@AfterReturning/@AfterThrowing` **之后**执行；多个切面用类上的 `@Order` 排序，值小的在外层。
> - **自调用（`this.xxx()`）、`final`/`private`/`static` 方法、非容器对象**都不会被增强，这是 `@Transactional`、`@Async`、`@Cacheable` 失效的共同根因。

## 核心概念

| 概念 | Spring 中的类型 | 说明 |
| --- | --- | --- |
| Join point 连接点 | `MethodInvocation` | Spring AOP 只支持**方法执行**这一种连接点 |
| Pointcut 切点 | `Pointcut` = `ClassFilter` + `MethodMatcher` | 决定哪些类的哪些方法被拦截，如 `AspectJExpressionPointcut` |
| Advice 通知 | `MethodInterceptor`、`MethodBeforeAdvice`… | 拦截后执行的逻辑 |
| Advisor | `PointcutAdvisor` | 切点 + 通知的最小组合，**Spring 内部真正流转的单位** |
| Aspect 切面 | `@Aspect` 类 | 一个切面会被解析成多个 Advisor（每个通知方法一个） |
| Weaving 织入 | `ProxyFactory` | Spring 在运行时织入；AspectJ 可在编译期 / 类加载期织入 |

`@Transactional`、`@Async`、`@Cacheable`、`@Validated` 方法校验都不是 `@Aspect`，而是框架直接注册的 Advisor（如 `BeanFactoryTransactionAttributeSourceAdvisor`），走的是同一套代理机制。

```java
@Aspect
@Component
@Order(10)
public class TimingAspect {
    @Pointcut("@annotation(com.example.Timed) || execution(* com.example..service.*Service.*(..))")
    void timed() {}

    @Around("timed()")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        try {
            return pjp.proceed();
        } finally {
            log.info("{} took {}ms", pjp.getSignature().toShortString(),
                     (System.nanoTime() - start) / 1_000_000);
        }
    }
}
```

常用切点指示符：`execution`（方法签名）、`within`（类型范围）、`@annotation`（方法注解）、`@within`（类注解）、`args`、`bean(beanName)`（Spring 扩展）。`@annotation` 只匹配方法上的注解，想同时匹配类上的注解要 `@within(X) || @annotation(X)`。

## JDK 动态代理 vs CGLIB

动态代理的底层原理见 [反射、注解与动态代理](#/java/api/reflect)，这里只看 Spring 的选择逻辑：

```java
// Spring 6 DefaultAopProxyFactory#createAopProxy（节选）
public AopProxy createAopProxy(AdvisedSupport config) {
    if (config.isOptimize() || config.isProxyTargetClass() || !config.hasUserSuppliedInterfaces()) {
        Class<?> targetClass = config.getTargetClass();
        if (targetClass.isInterface() || Proxy.isProxyClass(targetClass) || ClassUtils.isLambdaClass(targetClass)) {
            return new JdkDynamicAopProxy(config);
        }
        return new ObjenesisCglibAopProxy(config);
    }
    return new JdkDynamicAopProxy(config);
}
```

| 维度 | JDK 动态代理 | CGLIB |
| --- | --- | --- |
| 原理 | `Proxy.newProxyInstance` 生成实现接口的 `$Proxy` 类，回调 `InvocationHandler` | 字节码生成**目标类的子类**，重写方法回调 `MethodInterceptor` |
| 前提 | 目标必须实现接口，只能代理接口方法 | 类不能是 `final`；`final/private/static` 方法无法拦截 |
| 注入类型 | 只能按接口注入，按实现类注入报 `BeanNotOfRequiredTypeException` | 接口、实现类都能注入 |
| Spring 中的实现 | `JdkDynamicAopProxy` | `ObjenesisCglibAopProxy`（用 Objenesis 创建实例，**不调用构造器**） |
| 类名特征 | `jdk.proxy2.$Proxy123` | 6.x：`OrderService$$SpringCGLIB$$0`；5.x：`$$EnhancerBySpringCGLIB$$xxxx` |

> [!NOTE] 默认值在 Framework 和 Boot 中不同
> Spring Framework 的 `@EnableAspectJAutoProxy(proxyTargetClass = false)` 默认优先 JDK 代理；Spring Boot 2.0 起 `spring.aop.proxy-target-class=true`，统一 CGLIB，避免"按实现类注入失败"这类问题。Spring 6 把 CGLIB 重新打包进 `spring-core`（`org.springframework.cglib`），无需额外依赖；JDK 17+ 强封装下也已适配。

性能方面，现代 JVM 上两者调用开销差别很小，选型主要看功能约束，不必纠结性能。

## 代理是何时、如何创建的

`@EnableAspectJAutoProxy`（Boot 由 `AopAutoConfiguration` 自动开启）通过 `AspectJAutoProxyRegistrar` 注册 `AnnotationAwareAspectJAutoProxyCreator`。它的继承链顶端是 `AbstractAutoProxyCreator`，实现了 `SmartInstantiationAwareBeanPostProcessor`。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="自动代理创建器在 Bean 初始化后筛选 Advisor 并选择 JDK 或 CGLIB 创建代理">
<rect class="b5" x="20" y="30" width="240" height="46" rx="8"/>
<text class="tm" x="140" y="47" text-anchor="middle" dominant-baseline="middle">postProcessAfterInitialization</text>
<text class="ts" x="140" y="66" text-anchor="middle">Bean 初始化完成后回调</text>
<rect class="b" x="300" y="30" width="180" height="46" rx="8"/>
<text class="tm" x="390" y="47" text-anchor="middle" dominant-baseline="middle">wrapIfNecessary</text>
<text class="ts" x="390" y="66" text-anchor="middle">跳过基础设施类、已提前代理</text>
<rect class="b" x="520" y="30" width="220" height="46" rx="8"/>
<text class="tm" x="630" y="47" text-anchor="middle" dominant-baseline="middle">findEligibleAdvisors</text>
<text class="ts" x="630" y="66" text-anchor="middle">候选 Advisor → 切点匹配 → 排序</text>
<rect class="b3" x="520" y="130" width="220" height="46" rx="8"/>
<text class="tb" x="630" y="153" text-anchor="middle" dominant-baseline="middle">有匹配的 Advisor？</text>
<rect class="b" x="300" y="130" width="180" height="46" rx="8"/>
<text class="tm" x="390" y="147" text-anchor="middle" dominant-baseline="middle">ProxyFactory</text>
<text class="ts" x="390" y="166" text-anchor="middle">createProxy()</text>
<rect class="b" x="20" y="130" width="240" height="46" rx="8"/>
<text class="tm" x="140" y="147" text-anchor="middle" dominant-baseline="middle">DefaultAopProxyFactory</text>
<text class="ts" x="140" y="166" text-anchor="middle">createAopProxy()</text>
<rect class="b1" x="20" y="230" width="210" height="50" rx="8"/>
<text class="tm" x="125" y="248" text-anchor="middle" dominant-baseline="middle">JdkDynamicAopProxy</text>
<text class="ts" x="125" y="268" text-anchor="middle">有接口且未强制 CGLIB</text>
<rect class="b2" x="250" y="230" width="240" height="50" rx="8"/>
<text class="tm" x="370" y="248" text-anchor="middle" dominant-baseline="middle">ObjenesisCglibAopProxy</text>
<text class="ts" x="370" y="268" text-anchor="middle">proxyTargetClass=true 或无接口</text>
<rect class="b" x="520" y="230" width="220" height="50" rx="8"/>
<text class="tb" x="630" y="255" text-anchor="middle" dominant-baseline="middle">返回原始 Bean</text>
<line class="l" x1="260" y1="53" x2="300" y2="53" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="53" x2="520" y2="53" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="76" x2="630" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="153" x2="480" y2="153" marker-end="url(#arr)"/>
<text class="ts" x="500" y="145" text-anchor="middle">是</text>
<line class="l" x1="630" y1="176" x2="630" y2="230" marker-end="url(#arr)"/>
<text class="ts" x="642" y="208">否</text>
<line class="l" x1="300" y1="153" x2="260" y2="153" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="176" x2="120" y2="230" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="176" x2="350" y2="230" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：自动代理的创建流程，循环依赖时同样的逻辑会提前在 getEarlyBeanReference 中执行</figcaption>
</figure>

```java
// Spring 6 AbstractAutoProxyCreator（节选）
public Object postProcessAfterInitialization(@Nullable Object bean, String beanName) {
    if (bean != null) {
        Object cacheKey = getCacheKey(bean.getClass(), beanName);
        if (this.earlyProxyReferences.remove(cacheKey) != bean) {   // 循环依赖时已提前代理过
            return wrapIfNecessary(bean, beanName, cacheKey);
        }
    }
    return bean;
}

protected Object wrapIfNecessary(Object bean, String beanName, Object cacheKey) {
    if (isInfrastructureClass(bean.getClass()) || shouldSkip(bean.getClass(), beanName)) {
        return bean;                       // Advice/Advisor/切面类自身不代理
    }
    Object[] specificInterceptors = getAdvicesAndAdvisorsForBean(bean.getClass(), beanName, null);
    if (specificInterceptors != DO_NOT_PROXY) {
        return createProxy(bean.getClass(), beanName, specificInterceptors, new SingletonTargetSource(bean));
    }
    return bean;
}
```

`findEligibleAdvisors` 的三步：

1. **findCandidateAdvisors**：容器中所有 `Advisor` 类型的 Bean（事务、缓存等）+ `BeanFactoryAspectJAdvisorsBuilder` 把 `@Aspect` 类的每个通知方法解析成 `InstantiationModelAwarePointcutAdvisorImpl`（结果缓存，只解析一次）。
2. **findAdvisorsThatCanApply**：用 `ClassFilter` 粗筛类，再用 `MethodMatcher` 逐个检查类中方法，任一方法匹配即可。
3. **extendAdvisors + sortAdvisors**：在链头加入 `ExposeInvocationInterceptor`（把当前 `MethodInvocation` 放进 ThreadLocal），再按 `@Order` / `Ordered` 排序。

> [!NOTE] 多个自动代理创建器的"升级"
> 只开 `@EnableTransactionManagement` 时注册的是 `InfrastructureAdvisorAutoProxyCreator`（只认基础设施 Advisor）；开了 AspectJ 支持后 `AopConfigUtils` 会把同名 BeanDefinition 升级为优先级最高的 `AnnotationAwareAspectJAutoProxyCreator`。容器里始终只有一个自动代理创建器，所以事务和自定义切面共享**同一个代理对象**，不会代理套代理。

## 拦截器链：ReflectiveMethodInvocation

调用代理方法时，CGLIB 代理进入 `DynamicAdvisedInterceptor#intercept`，JDK 代理进入 `JdkDynamicAopProxy#invoke`，二者做的事情一样：

1. `advised.getInterceptorsAndDynamicInterceptionAdvice(method, targetClass)` 取出匹配该方法的拦截器列表（**按方法缓存**），各类 Advice 被 `AdvisorAdapterRegistry` 适配为 `MethodInterceptor`；
2. 链为空：直接反射调用目标方法；
3. 否则 `new CglibMethodInvocation(...).proceed()`（它继承 `ReflectiveMethodInvocation`）。

```java
// Spring 6 ReflectiveMethodInvocation#proceed（节选）
public Object proceed() throws Throwable {
    // 所有拦截器都已执行：调用目标方法
    if (this.currentInterceptorIndex == this.interceptorsAndDynamicMethodMatchers.size() - 1) {
        return invokeJoinpoint();
    }
    Object advice = this.interceptorsAndDynamicMethodMatchers.get(++this.currentInterceptorIndex);
    if (advice instanceof InterceptorAndDynamicMethodMatcher dm) {
        // 动态切点（如 args()）：运行时再匹配一次参数，不匹配就跳过
        return dm.matcher().matches(this.method, targetClass, this.arguments)
                ? dm.interceptor().invoke(this) : proceed();
    }
    return ((MethodInterceptor) advice).invoke(this);   // 拦截器内部再调 mi.proceed()，形成递归
}
```

<figure class="fig">
<svg viewBox="0 0 760 400" class="dg" role="img" aria-label="ReflectiveMethodInvocation 递归调用拦截器链直至目标方法再逐层返回">
<text class="ts" x="150" y="24">chain = getInterceptorsAndDynamicInterceptionAdvice(method)，下标递增</text>
<rect class="b" x="150" y="40" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="57" text-anchor="middle" dominant-baseline="middle">ExposeInvocationInterceptor</text>
<text class="ts" x="450" y="61">把 MethodInvocation 放入 ThreadLocal</text>
<rect class="b1" x="150" y="90" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="107" text-anchor="middle" dominant-baseline="middle">AspectJAroundAdvice</text>
<text class="ts" x="450" y="111">@Around 前半段，pjp.proceed() 继续</text>
<rect class="b1" x="150" y="140" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="157" text-anchor="middle" dominant-baseline="middle">MethodBeforeAdviceInterceptor</text>
<text class="ts" x="450" y="161">先执行 @Before，再 proceed()</text>
<rect class="b1" x="150" y="190" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="207" text-anchor="middle" dominant-baseline="middle">AspectJAfterAdvice</text>
<text class="ts" x="450" y="211">try { proceed() } finally { @After }</text>
<rect class="b1" x="150" y="240" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="257" text-anchor="middle" dominant-baseline="middle">AfterReturningAdviceInterceptor</text>
<text class="ts" x="450" y="261">proceed() 正常返回后 @AfterReturning</text>
<rect class="b1" x="150" y="290" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="307" text-anchor="middle" dominant-baseline="middle">AspectJAfterThrowingAdvice</text>
<text class="ts" x="450" y="311">catch 到异常：@AfterThrowing 后重抛</text>
<rect class="b2" x="150" y="340" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="357" text-anchor="middle" dominant-baseline="middle">invokeJoinpoint()</text>
<text class="ts" x="450" y="361">反射调用目标对象方法（不是代理）</text>
<line class="l" x1="290" y1="74" x2="290" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="124" x2="290" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="174" x2="290" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="224" x2="290" y2="240" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="274" x2="290" y2="290" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="324" x2="290" y2="340" marker-end="url(#arr)"/>
<line class="la" x1="130" y1="357" x2="130" y2="57" marker-end="url(#arr-a)"/>
<text class="ta" x="118" y="200" text-anchor="end">返回值 / 异常</text>
<text class="ts" x="118" y="218" text-anchor="end">逐层回溯</text>
</svg>
<figcaption>图 2：同一切面内的拦截器链（5.2.7+ 排序），每个拦截器调用 proceed() 进入下一层</figcaption>
</figure>

## 通知执行顺序

### 同一切面内

| 版本 | 正常返回时的执行顺序 |
| --- | --- |
| 5.2.7 及以后（Boot 2.3+） | Around 前 → Before → **目标方法** → AfterReturning → After → Around 后 |
| 5.2.6 及以前 | Around 前 → Before → **目标方法** → Around 后 → After → AfterReturning |

新顺序与 AspectJ 语义一致：`@After` 相当于 `finally`，包在 `@AfterReturning/@AfterThrowing` 外层。异常时：Around 前 → Before → 目标抛异常 → AfterThrowing → After → 异常传到 Around（若 Around 未 catch 则继续上抛）。

> [!WARNING] 同一切面里两个同类型通知的顺序不可控
> 同一个 `@Aspect` 中两个 `@Before`，其顺序按方法反射顺序，不同 JVM 不保证。需要确定顺序就拆到两个切面类里，用 `@Order` 排序。

### 多个切面

- 在**切面类**上加 `@Order` 或实现 `Ordered`，值越小优先级越高，处在洋葱外层：**前置逻辑先执行，后置逻辑后执行**。加在通知方法上无效。
- 事务的 Advisor 默认 `Ordered.LOWEST_PRECEDENCE`，在大多数自定义切面的**内层**。如果你写了一个"捕获异常转成错误码"的切面，并且优先级低于事务（在事务里面），异常在到达事务拦截器前被吞掉，**事务就不会回滚**。
- 想让切面运行在事务之外（例如分布式锁要在事务提交后才释放），切面 `@Order` 要比事务更小，或调整 `@EnableTransactionManagement(order = ...)`。

## 自调用失效

```java
@Service
public class OrderService {
    public void create() {
        this.saveWithTx();          // this 是目标对象，不是代理，事务不生效
    }
    @Transactional
    public void saveWithTx() { ... }
}
```

代理对象持有目标对象，拦截后通过 `invokeJoinpoint()` 在**目标对象上**反射调用 `create()`；`create()` 内部的 `this` 指向目标对象，再调用 `saveWithTx()` 就绕过了代理。

| 解法 | 做法 | 评价 |
| --- | --- | --- |
| 拆到另一个 Bean | 把 `saveWithTx` 移到 `OrderTxService` | 最推荐，职责也更清晰 |
| 注入自己 | `@Lazy @Autowired private OrderService self;` 然后 `self.saveWithTx()` | 简单，但属于自我循环依赖，Boot 2.6+ 需 `@Lazy` 才能启动 |
| `AopContext.currentProxy()` | `@EnableAspectJAutoProxy(exposeProxy = true)` 后 `((OrderService) AopContext.currentProxy()).saveWithTx()` | 侵入代码；异步线程中取不到（ThreadLocal） |
| 编程式事务 | `TransactionTemplate` | 对事务场景最直接 |
| AspectJ 织入 | 编译期 / 加载期织入，`@EnableTransactionManagement(mode = ASPECTJ)` | 彻底解决，但构建复杂，很少用 |

## 无法增强的方法

| 方法类型 | JDK 代理 | CGLIB | 原因 |
| --- | --- | --- | --- |
| 接口外的 public 方法 | 否 | 是 | JDK 只代理接口方法 |
| `final` 方法 | — | 否 | 子类无法重写 |
| `private` 方法 | 否 | 否 | 不可重写 |
| `static` 方法 | 否 | 否 | 不属于实例 |
| protected / 包可见 | 否 | 可以拦截 | 但 `@Transactional` 在 5.x 只认 public，6.0 起类代理也支持 protected/包可见 |
| `final` 类 | — | 启动报错 | Kotlin 类默认 final，需 `kotlin-spring` 插件 |

> [!CAUTION] final 方法 + CGLIB = 字段为 null 的 NPE
> CGLIB 代理实例由 Objenesis 创建，**不执行构造器、也不做依赖注入**，代理对象自己的字段全是 null。`final` 方法无法被重写，调用时直接在代理实例上执行，访问 `this.repository` 得到 null。现象是"同一个 Bean，有的方法正常，有的方法报 NPE"。检查是否给方法加了 `final`（某些代码规范插件会自动加）。

## 生产实践与踩坑

- **切点写得太宽**：`execution(* com.example..*.*(..))` 会匹配到配置类、过滤器甚至切面自身依赖的 Bean，轻则启动变慢，重则因提前实例化导致其他 BPP 未生效。尽量用注解切点精确圈定。
- **切面里吞异常**：`@Around` 中 `catch (Throwable)` 后返回默认值，会让外层事务、重试、熔断都感知不到失败。必须吞时明确记录并评估对事务的影响。
- **`@Around` 忘记 return**：写成 `pjp.proceed();` 而不是 `return pjp.proceed();`，被拦截方法统统返回 null，基本类型返回值时报 `AopInvocationException`。
- **按实现类注入失败**：关闭了 `proxyTargetClass` 又按实现类注入，报 *Bean named 'x' is expected to be of type 'XServiceImpl' but was actually of type 'jdk.proxy2.$Proxy..'*。
- **获取目标类**：日志、注解解析时用 `AopUtils.getTargetClass(bean)` / `AopProxyUtils.ultimateTargetClass`，不要直接 `bean.getClass()`（拿到的是代理类，类上的注解可能读不到）。
- **ThreadLocal 型上下文**：切面里依赖 `RequestContextHolder` 或 MDC，遇到 `@Async`/线程池时上下文丢失，需要 `TaskDecorator` 传递。

## 相关阅读

- [反射、注解与动态代理](#/java/api/reflect)：动态代理与反射
- [声明式事务原理](#/spring/tx)：事务是如何基于 AOP 实现的
- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：用 AOP/Agent 做无侵入埋点

## 面试追问

> [!QUESTION] Spring AOP 和 AspectJ 有什么区别？
> Spring AOP 运行时动态代理，只支持方法执行连接点，只作用于容器 Bean，自调用失效；AspectJ 通过 ajc 编译期或 LTW 加载期修改字节码，支持字段、构造器、静态方法等连接点，没有自调用问题。Spring 只是借用了 AspectJ 的注解和切点表达式解析。

> [!QUESTION] 代理对象是在 Bean 生命周期哪一步创建的？有例外吗？
> 正常在 `postProcessAfterInitialization`，由 `AbstractAutoProxyCreator#wrapIfNecessary` 创建。例外有两个：发生循环依赖时在 `getEarlyBeanReference` 中提前创建；配置了自定义 `TargetSource` 时在 `postProcessBeforeInstantiation` 直接短路返回代理。

> [!QUESTION] 多个通知是怎么串起来执行的？
> 所有 Advice 适配为 `MethodInterceptor` 组成列表，`ReflectiveMethodInvocation` 持有当前下标，`proceed()` 取下一个拦截器调用其 `invoke(this)`，拦截器内部再调用 `proceed()`，下标到末尾时反射调用目标方法，然后沿调用栈逐层返回，形成责任链 + 递归的洋葱模型。

> [!QUESTION] @Transactional 和自定义切面谁先执行？会有什么问题？
> 取决于 `@Order`，事务 Advisor 默认最低优先级，处于内层。若自定义切面在外层吞了异常问题不大（事务已回滚）；若在内层（`@Order` 值更大）吞了异常，事务拦截器看不到异常就会提交。需要明确设置顺序。

> [!QUESTION] 为什么 Spring Boot 默认用 CGLIB？
> 避免 JDK 代理只能按接口注入导致的类型错误，以及"有的类有接口、有的没有"导致代理行为不一致；CGLIB 对接口方法和类方法都能代理。代价是不能代理 final 类/方法，且 CGLIB 类生成稍慢，但对运行时性能影响可以忽略。
