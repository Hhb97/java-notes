# Spring IoC 与 AOP

## IoC：控制反转 / DI：依赖注入

传统写法由对象自己 `new` 依赖；IoC 把**对象的创建与装配交给容器**，代码只声明需要什么，降低耦合、便于测试替换。

```java
@Service
public class OrderService {
    private final OrderRepository repo;

    public OrderService(OrderRepository repo) {   // 构造器注入（推荐）
        this.repo = repo;
    }
}
```

### 三种注入方式

| 方式 | 说明 |
| --- | --- |
| **构造器注入** | 推荐：依赖不可变（`final`）、不会漏注入、便于单元测试 |
| Setter 注入 | 可选依赖 |
| 字段注入 `@Autowired` | 简洁但难以测试、隐藏依赖，不推荐 |

### 常用注解

| 注解 | 作用 |
| --- | --- |
| `@Component` / `@Service` / `@Repository` / `@Controller` | 声明 Bean（后三者是语义化的 `@Component`） |
| `@Configuration` + `@Bean` | Java 配置，定义第三方类的 Bean |
| `@Autowired` / `@Resource` | 依赖注入（按类型 / 按名称） |
| `@Qualifier` / `@Primary` | 同类型多个 Bean 时指定选择 |
| `@Value("${key}")` | 注入配置值 |
| `@Scope` | 作用域：`singleton`（默认）、`prototype`、`request`、`session` |

## Bean 生命周期

```text
实例化 → 属性填充(依赖注入) → Aware 回调 → BeanPostProcessor.before
       → @PostConstruct / InitializingBean / init-method → BeanPostProcessor.after（AOP 代理在此生成）
       → 使用 → @PreDestroy / DisposableBean → 销毁
```

## 循环依赖

A 依赖 B，B 又依赖 A。Spring 对**单例 + setter / 字段注入**通过**三级缓存**提前暴露半成品对象来解决；**构造器注入的循环依赖无法解决**，会启动失败（Spring Boot 2.6+ 默认连字段注入的循环依赖也禁止）。根本做法是重新设计依赖关系。

## AOP：面向切面编程

把日志、事务、权限、监控等**横切关注点**从业务代码中抽离。

```java
@Aspect
@Component
public class TimeAspect {

    @Around("execution(* com.example.service..*.*(..))")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        try {
            return pjp.proceed();                       // 执行目标方法
        } finally {
            log.info("{} 耗时 {}ms", pjp.getSignature(), System.currentTimeMillis() - start);
        }
    }
}
```

| 概念 | 含义 |
| --- | --- |
| Pointcut | 切点：匹配哪些方法 |
| Advice | 通知：`@Before` `@After` `@AfterReturning` `@AfterThrowing` `@Around` |
| Aspect | 切面 = 切点 + 通知 |
| Weaving | 织入：运行时通过**动态代理**实现 |

### 动态代理

- 目标类有接口 → **JDK 动态代理**（基于接口）；
- 没有接口 → **CGLIB**（生成子类，所以类和方法不能是 `final`）；
- Spring Boot 默认全部使用 CGLIB。

## 声明式事务

```java
@Transactional(rollbackFor = Exception.class)
public void createOrder() { ... }
```

事务由 AOP 代理实现，因此以下情况**会失效**：

1. **同一个类内部调用**（`this.method()` 绕过了代理）；
2. 方法不是 `public`，或类 / 方法是 `final`；
3. 异常被 `catch` 吞掉；
4. 抛出的是受检异常却没配置 `rollbackFor`（默认只回滚 `RuntimeException` 与 `Error`）；
5. 对象不是 Spring 容器管理的 Bean；
6. 数据库引擎不支持事务（如 MyISAM）。

## 传播行为（常用）

| 行为 | 说明 |
| --- | --- |
| `REQUIRED`（默认） | 有事务就加入，没有就新建 |
| `REQUIRES_NEW` | 总是新建事务，挂起外层事务 |
| `NESTED` | 嵌套事务（保存点） |
| `SUPPORTS` | 有就用，没有就非事务执行 |
