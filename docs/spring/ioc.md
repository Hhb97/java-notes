---
level: 深入
tags: [Spring, IoC, BeanDefinition, Bean 生命周期, 循环依赖, 三级缓存]
summary: 从 BeanDefinition 注册、refresh() 十二步到 Bean 生命周期与三级缓存，讲清 Spring 容器到底在启动时做了什么
---

# IoC 容器与 Bean 生命周期

> [!ABSTRACT] 核心要点
> - 容器启动 = **先收集 BeanDefinition（配方），再按配方创建 Bean**；前者由 `BeanFactoryPostProcessor`（核心是 `ConfigurationClassPostProcessor`）完成，后者由 `BeanPostProcessor` 在生命周期各节点插手。
> - `AbstractApplicationContext#refresh()` 中最关键的两步：`invokeBeanFactoryPostProcessors`（解析 `@Configuration/@ComponentScan/@Import`，自动配置也在这里）与 `finishBeanFactoryInitialization`（实例化所有非懒加载单例）。
> - Bean 生命周期主干：实例化 → 属性填充 → Aware → `postProcessBeforeInitialization`（含 `@PostConstruct`）→ 初始化方法 → `postProcessAfterInitialization`（**AOP 代理在此生成**）→ 销毁。
> - 三级缓存只能解决**单例 + 字段/Setter 注入**的循环依赖；第三级缓存存的是 `ObjectFactory`，作用是**按需提前生成 AOP 代理**，保证注入方拿到的是最终代理对象。构造器循环依赖无解，Boot 2.6 起默认直接禁止循环依赖。
> - `@Configuration` 默认被 CGLIB 增强（`proxyBeanMethods=true`），保证 `@Bean` 方法互相调用时返回容器单例；Boot 自动配置统一用 `proxyBeanMethods=false` 换取启动速度。

## BeanFactory 与 ApplicationContext

| 维度 | `BeanFactory` | `ApplicationContext` |
| --- | --- | --- |
| 定位 | 最底层的 IoC 接口：`getBean`、类型匹配、作用域 | 面向应用的门面，**组合**一个 `DefaultListableBeanFactory` |
| 单例创建时机 | 懒加载，第一次 `getBean` 才创建 | `refresh()` 末尾**预实例化所有非懒加载单例**，启动即暴露配置错误 |
| 后处理器 | 需手动 `addBeanPostProcessor` | 自动探测并注册 BFPP / BPP |
| 附加能力 | 无 | 事件发布、国际化 `MessageSource`、`Environment`/Profile、`ResourceLoader` |
| 常见实现 | `DefaultListableBeanFactory` | `AnnotationConfigApplicationContext`、Boot 的 `AnnotationConfigServletWebServerApplicationContext` |

真正干活的几乎都是 `DefaultListableBeanFactory`：它同时是 `BeanDefinitionRegistry`（存配方）和 `DefaultSingletonBeanRegistry`（存单例与三级缓存）。

> [!NOTE] FactoryBean ≠ BeanFactory
> `FactoryBean<T>` 是一个"生产 Bean 的 Bean"，`getBean("x")` 返回的是 `getObject()` 的产物，`getBean("&x")` 才是工厂本身。MyBatis 的 `MapperFactoryBean`、`SqlSessionFactoryBean`、Feign 的 `FeignClientFactoryBean` 都靠它把复杂对象接入容器。

## BeanDefinition：Bean 的配方

容器不会直接扫描到类就 `new`，而是先把每个 Bean 描述成 `BeanDefinition` 注册进 `beanDefinitionMap`：

```java
// Spring 6 DefaultListableBeanFactory（节选）
private final Map<String, BeanDefinition> beanDefinitionMap = new ConcurrentHashMap<>(256);
private volatile List<String> beanDefinitionNames = new ArrayList<>(256);   // 保持注册顺序

public void registerBeanDefinition(String beanName, BeanDefinition bd) {
    BeanDefinition existing = this.beanDefinitionMap.get(beanName);
    if (existing != null) {
        if (!isBeanDefinitionOverridable(beanName)) {     // Boot 2.1+ 默认不允许覆盖
            throw new BeanDefinitionOverrideException(beanName, bd, existing);
        }
        ...
    }
    this.beanDefinitionMap.put(beanName, bd);
    ...
}
```

| 关键属性 | 含义 |
| --- | --- |
| `beanClassName` / `factoryBeanName + factoryMethodName` | 构造方式：直接反射构造，或调用 `@Bean` 工厂方法 |
| `scope`、`lazyInit`、`dependsOn`、`primary` | 作用域、是否懒加载、显式依赖、多候选时优先 |
| `constructorArgumentValues` / `propertyValues` | 构造参数与属性值（XML 时代常用） |
| `initMethodName` / `destroyMethodName` | 初始化 / 销毁回调 |
| `role` | `ROLE_INFRASTRUCTURE` 表示框架内部 Bean |

不同来源对应不同实现：`@ComponentScan` 扫出来的是 `ScannedGenericBeanDefinition`，`@Bean` 方法是 `ConfigurationClassBeanDefinition`，创建前统一合并为 `RootBeanDefinition`（处理父子定义继承）。

## refresh()：容器启动的十二步

<figure class="fig">
<svg viewBox="0 0 720 412" class="dg" role="img" aria-label="AbstractApplicationContext refresh 方法的十二个步骤">
<text class="th" x="20" y="26">AbstractApplicationContext#refresh()</text>
<rect class="b" x="20" y="44" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="62">1 prepareRefresh</text>
<text class="ts" x="32" y="80">记录启动时间、校验必需属性</text>
<rect class="b" x="20" y="100" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="118">2 obtainFreshBeanFactory</text>
<text class="ts" x="32" y="136">拿到 DefaultListableBeanFactory</text>
<rect class="b" x="20" y="156" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="174">3 prepareBeanFactory</text>
<text class="ts" x="32" y="192">类加载器、SpEL、注册 Aware 处理器</text>
<rect class="b" x="20" y="212" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="230">4 postProcessBeanFactory</text>
<text class="ts" x="32" y="248">子类扩展点（Web 容器注册 scope）</text>
<rect class="b3" x="20" y="268" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="286">5 invokeBeanFactoryPostProcessors</text>
<text class="ts" x="32" y="304">解析配置类，注册全部 BeanDefinition</text>
<rect class="b" x="20" y="324" width="320" height="46" rx="8"/>
<text class="tm" x="32" y="342">6 registerBeanPostProcessors</text>
<text class="ts" x="32" y="360">按 PriorityOrdered/Ordered 排序注册 BPP</text>
<rect class="b" x="380" y="44" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="62">7 initMessageSource</text>
<text class="ts" x="392" y="80">国际化</text>
<rect class="b" x="380" y="100" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="118">8 initApplicationEventMulticaster</text>
<text class="ts" x="392" y="136">事件广播器</text>
<rect class="b2" x="380" y="156" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="174">9 onRefresh</text>
<text class="ts" x="392" y="192">Boot 在此创建内嵌 WebServer</text>
<rect class="b" x="380" y="212" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="230">10 registerListeners</text>
<text class="ts" x="392" y="248">注册监听器，派发早期事件</text>
<rect class="b3" x="380" y="268" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="286">11 finishBeanFactoryInitialization</text>
<text class="ts" x="392" y="304">实例化所有非懒加载单例</text>
<rect class="b" x="380" y="324" width="320" height="46" rx="8"/>
<text class="tm" x="392" y="342">12 finishRefresh</text>
<text class="ts" x="392" y="360">Lifecycle#start、发布 ContextRefreshedEvent</text>
<line class="l" x1="180" y1="90" x2="180" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="146" x2="180" y2="156" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="202" x2="180" y2="212" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="258" x2="180" y2="268" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="314" x2="180" y2="324" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="90" x2="540" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="146" x2="540" y2="156" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="202" x2="540" y2="212" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="258" x2="540" y2="268" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="314" x2="540" y2="324" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="347" x2="360" y2="347"/>
<line class="l" x1="360" y1="347" x2="360" y2="67"/>
<line class="l" x1="360" y1="67" x2="380" y2="67" marker-end="url(#arr)"/>
<text class="ts" x="20" y="396">琥珀色：最关键的两步；绿色：Spring Boot 内嵌容器的创建入口</text>
</svg>
<figcaption>图 1：refresh() 的十二个步骤，前半段处理"配方"，后半段创建 Bean</figcaption>
</figure>

```java
// Spring 6 AbstractApplicationContext#refresh（节选，省略 StartupStep 埋点）
public void refresh() throws BeansException, IllegalStateException {
    this.startupShutdownLock.lock();          // 6.1 起由 synchronized 改为 ReentrantLock
    try {
        prepareRefresh();
        ConfigurableListableBeanFactory beanFactory = obtainFreshBeanFactory();
        prepareBeanFactory(beanFactory);
        try {
            postProcessBeanFactory(beanFactory);
            invokeBeanFactoryPostProcessors(beanFactory);   // ★ 配置类解析
            registerBeanPostProcessors(beanFactory);
            initMessageSource();
            initApplicationEventMulticaster();
            onRefresh();                                    // Boot: createWebServer()
            registerListeners();
            finishBeanFactoryInitialization(beanFactory);   // ★ preInstantiateSingletons()
            finishRefresh();
        } catch (BeansException ex) {
            destroyBeans();                                 // 失败则销毁已创建的单例
            cancelRefresh(ex);
            throw ex;
        }
    } finally {
        this.startupShutdownLock.unlock();
    }
}
```

`preInstantiateSingletons()` 遍历 `beanDefinitionNames` 逐个 `getBean`，全部完成后再回调所有 `SmartInitializingSingleton#afterSingletonsInstantiated`（`@EventListener` 方法就是在这里被注册成监听器的）。

## 两类后处理器：改配方 vs 改成品

| | `BeanFactoryPostProcessor` | `BeanPostProcessor` |
| --- | --- | --- |
| 作用对象 | BeanDefinition（Bean 还没创建） | Bean 实例（每个 Bean 创建时都会回调） |
| 执行时机 | refresh 第 5 步，只执行一次 | 第 11 步起，每个 Bean 的生命周期中 |
| 典型实现 | `ConfigurationClassPostProcessor`、`PropertySourcesPlaceholderConfigurer`、MyBatis `MapperScannerConfigurer` | `AutowiredAnnotationBeanPostProcessor`、`CommonAnnotationBeanPostProcessor`、`AnnotationAwareAspectJAutoProxyCreator` |
| 子接口 | `BeanDefinitionRegistryPostProcessor`（可新增 BeanDefinition，先于普通 BFPP 执行） | `InstantiationAwareBPP`、`SmartInstantiationAwareBPP`、`MergedBeanDefinitionPostProcessor`、`DestructionAwareBPP` |

### ConfigurationClassPostProcessor

它是 `BeanDefinitionRegistryPostProcessor` + `PriorityOrdered`，因此在所有 BFPP 中最先执行，负责把注解配置"展开"成 BeanDefinition：

```java
// Spring 6 ConfigurationClassParser#doProcessConfigurationClass（节选，顺序即处理顺序）
processMemberClasses(...);                  // 1. 内部类中的配置类
// 2. @PropertySource → 加入 Environment
// 3. @ComponentScan → ClassPathBeanDefinitionScanner 扫描，扫到的配置类递归 parse
// 4. @Import → 三种情况：
//    - 普通类：当作配置类处理
//    - ImportSelector：返回类名数组；DeferredImportSelector 延迟到所有配置类之后（Boot 自动配置就是它）
//    - ImportBeanDefinitionRegistrar：直接操作 registry（@MapperScan、@EnableFeignClients）
processImports(configClass, sourceClass, getImports(sourceClass), filter, true);
// 5. @ImportResource → XML
// 6. @Bean 方法 → 收集为 BeanMethod，稍后由 ConfigurationClassBeanDefinitionReader 注册
// 7. 接口默认方法上的 @Bean、父类 → 递归
```

> [!TIP] 为什么用户 Bean 能"覆盖"自动配置
> 自动配置由 `DeferredImportSelector` 引入，在所有用户配置类解析完之后才处理，所以 `@ConditionalOnMissingBean` 判断时用户的 BeanDefinition 已经注册好了。详见 [Spring Boot 自动配置与启动](#/spring/boot)。

此外它在 `postProcessBeanFactory` 阶段对 **full 模式** 的 `@Configuration` 类做 CGLIB 增强（见后文）。

## Bean 生命周期全流程

<figure class="fig">
<svg viewBox="0 0 720 584" class="dg" role="img" aria-label="单例 Bean 从实例化、属性填充、初始化到销毁的完整生命周期">
<rect class="bg" x="20" y="36" width="680" height="146" rx="10"/>
<text class="tb" x="34" y="69">实例化</text>
<rect class="bg" x="20" y="194" width="680" height="58" rx="10"/>
<text class="tb" x="34" y="227">属性填充</text>
<rect class="bg" x="20" y="264" width="680" height="190" rx="10"/>
<text class="tb" x="34" y="297">初始化</text>
<text class="ts" x="34" y="315">initializeBean</text>
<rect class="bg" x="20" y="466" width="680" height="102" rx="10"/>
<text class="tb" x="34" y="499">使用与销毁</text>
<text class="ts" x="20" y="22">doGetBean → createBean → doCreateBean（AbstractAutowireCapableBeanFactory）</text>
<rect class="b1" x="150" y="48" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="65" text-anchor="middle" dominant-baseline="middle">createBeanInstance()</text>
<text class="ts" x="446" y="69">构造器推断；BPP 可提前短路返回代理</text>
<rect class="b1" x="150" y="92" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="109" text-anchor="middle" dominant-baseline="middle">MergedBeanDefinitionPostProcessor</text>
<text class="ts" x="446" y="113">预解析 @Autowired/@PostConstruct 元数据</text>
<rect class="b3" x="150" y="136" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="153" text-anchor="middle" dominant-baseline="middle">addSingletonFactory()</text>
<text class="ts" x="446" y="157">放入三级缓存，为循环依赖提前暴露</text>
<rect class="b1" x="150" y="206" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="223" text-anchor="middle" dominant-baseline="middle">populateBean()</text>
<text class="ts" x="446" y="227">@Autowired/@Resource/@Value 注入</text>
<rect class="b2" x="150" y="276" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="293" text-anchor="middle" dominant-baseline="middle">invokeAwareMethods()</text>
<text class="ts" x="446" y="297">BeanNameAware/BeanFactoryAware 等</text>
<rect class="b2" x="150" y="320" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="337" text-anchor="middle" dominant-baseline="middle">BPP#postProcessBeforeInitialization</text>
<text class="ts" x="446" y="341">执行 @PostConstruct 等回调</text>
<rect class="b2" x="150" y="364" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="381" text-anchor="middle" dominant-baseline="middle">invokeInitMethods()</text>
<text class="ts" x="446" y="385">afterPropertiesSet → init-method</text>
<rect class="b5" x="150" y="408" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="425" text-anchor="middle" dominant-baseline="middle">BPP#postProcessAfterInitialization</text>
<text class="ts" x="446" y="429">AOP 代理在此创建，可能替换原对象</text>
<rect class="b" x="150" y="478" width="280" height="34" rx="6"/>
<text class="tb" x="290" y="495" text-anchor="middle" dominant-baseline="middle">放入一级缓存，供使用</text>
<text class="ts" x="446" y="499">addSingleton，清除二、三级缓存</text>
<rect class="b4" x="150" y="522" width="280" height="34" rx="6"/>
<text class="tm" x="290" y="539" text-anchor="middle" dominant-baseline="middle">destroyBean()</text>
<text class="ts" x="446" y="543">容器关闭：@PreDestroy → destroy()</text>
<line class="l" x1="290" y1="82" x2="290" y2="92" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="126" x2="290" y2="136" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="170" x2="290" y2="206" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="240" x2="290" y2="276" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="310" x2="290" y2="320" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="354" x2="290" y2="364" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="398" x2="290" y2="408" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="442" x2="290" y2="478" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="512" x2="290" y2="522" marker-end="url(#arr)"/>
</svg>
<figcaption>图 2：单例 Bean 的生命周期，紫色一步决定了容器里最终放的是原对象还是代理</figcaption>
</figure>

```java
// Spring 6 AbstractAutowireCapableBeanFactory#doCreateBean（节选）
BeanWrapper instanceWrapper = createBeanInstance(beanName, mbd, args);
Object bean = instanceWrapper.getWrappedInstance();
applyMergedBeanDefinitionPostProcessors(mbd, beanType, beanName);
boolean earlySingletonExposure = (mbd.isSingleton() && this.allowCircularReferences
        && isSingletonCurrentlyInCreation(beanName));
if (earlySingletonExposure) {
    // 第三级缓存：存的是 lambda，真正被循环引用时才调用
    addSingletonFactory(beanName, () -> getEarlyBeanReference(beanName, mbd, bean));
}
Object exposedObject = bean;
populateBean(beanName, mbd, instanceWrapper);
exposedObject = initializeBean(beanName, exposedObject, mbd);
if (earlySingletonExposure) {
    Object earlySingletonReference = getSingleton(beanName, false);   // 只查一、二级
    if (earlySingletonReference != null && exposedObject == bean) {
        exposedObject = earlySingletonReference;   // 提前代理过，用代理替换
    }
    // 否则若已有别人注入了"原始版本"，抛 BeanCurrentlyInCreationException
}
registerDisposableBeanIfNecessary(beanName, bean, mbd);
return exposedObject;
```

几个容易混淆的顺序结论：

- `@PostConstruct` 由 `CommonAnnotationBeanPostProcessor`（父类 `InitDestroyAnnotationBeanPostProcessor`）在 **before-init** 中执行，所以早于 `afterPropertiesSet` 和 `init-method`。
- `ApplicationContextAware`、`EnvironmentAware` 不在 `invokeAwareMethods` 里，而是 `ApplicationContextAwareProcessor` 这个 BPP 在 before-init 中回调。
- 销毁顺序与初始化对称：`@PreDestroy` → `DisposableBean#destroy` → `destroy-method`；`@Bean` 默认推断名为 `close`/`shutdown` 的公共方法作为销毁方法。**prototype Bean 容器不负责销毁**。

## 依赖注入原理

### @Autowired：AutowiredAnnotationBeanPostProcessor

它实现了三个扩展点，分别在生命周期不同阶段工作：

1. `determineCandidateConstructors`（`SmartInstantiationAwareBPP`）：推断构造器。**只有一个构造器时无需 `@Autowired`**（4.3 起）。
2. `postProcessMergedBeanDefinition`：反射扫描字段与方法上的 `@Autowired/@Value/@Inject`，构建 `InjectionMetadata` 并缓存。
3. `postProcessProperties`：在 `populateBean` 中调用 `metadata.inject()` 完成注入。

```java
// Spring 6 DefaultListableBeanFactory#doResolveDependency（节选，逻辑顺序）
Object shortcut = descriptor.resolveShortcut(this);          // 已解析过的缓存
Object value = getAutowireCandidateResolver().getSuggestedValue(descriptor); // @Value
if (value != null) { /* 占位符解析 + 类型转换 */ }
Object multipleBeans = resolveMultipleBeans(descriptor, beanName, ...);       // List/Map/数组
Map<String, Object> matchingBeans = findAutowireCandidates(beanName, type, descriptor);
if (matchingBeans.size() > 1) {
    // 多个候选：@Primary → @Priority → 字段/参数名与 beanName 匹配
    autowiredBeanName = determineAutowireCandidate(matchingBeans, descriptor);
    if (autowiredBeanName == null) throw new NoUniqueBeanDefinitionException(...);
}
```

`@Qualifier` 在 `findAutowireCandidates` 阶段由 `QualifierAnnotationAutowireCandidateResolver` 过滤，优先级高于上面的兜底规则。

### @Resource 与 @Autowired

| | `@Autowired` | `@Resource`（Spring 6 为 `jakarta.annotation.Resource`） |
| --- | --- | --- |
| 来源 | Spring | JSR-250 / Jakarta |
| 处理器 | `AutowiredAnnotationBeanPostProcessor` | `CommonAnnotationBeanPostProcessor` |
| 匹配顺序 | **先按类型**，多候选再按 Primary/Priority/名称 | **先按名称**（默认字段名），找不到且未显式指定 name 时退回按类型 |
| 可选依赖 | `required=false`、`Optional<T>`、`ObjectProvider<T>` | 不支持 required |
| 支持位置 | 构造器、字段、方法、参数 | 字段、单参 setter（不支持构造器） |

> [!TIP] 推荐构造器注入
> 依赖可以 `final`、不可能漏注入、单测直接 `new`；并且构造器循环依赖会在启动期直接暴露，倒逼你修正设计。可选依赖用 `ObjectProvider<T>#getIfAvailable()`。

## 循环依赖与三级缓存

`DefaultSingletonBeanRegistry` 里的三个 Map：

| 缓存 | 字段 | 存什么 |
| --- | --- | --- |
| 一级 | `singletonObjects` | 完整初始化好的成品 Bean |
| 二级 | `earlySingletonObjects` | 提前暴露的早期引用（可能已是代理），保证多次循环引用拿到同一个对象 |
| 三级 | `singletonFactories` | `ObjectFactory` lambda：`() -> getEarlyBeanReference(...)` |

```java
// Spring 5.3 / 6.x DefaultSingletonBeanRegistry#getSingleton(String, boolean)（节选）
Object singletonObject = this.singletonObjects.get(beanName);
if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
    singletonObject = this.earlySingletonObjects.get(beanName);
    if (singletonObject == null && allowEarlyReference) {
        synchronized (this.singletonObjects) {            // 双重检查
            ... // 再查一、二级
            ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName);
            if (singletonFactory != null) {
                singletonObject = singletonFactory.getObject();   // 可能触发提前 AOP
                this.earlySingletonObjects.put(beanName, singletonObject);
                this.singletonFactories.remove(beanName);
            }
        }
    }
}
return singletonObject;
```

以 A、B 相互字段注入、且 A 需要被 AOP 代理为例：

<figure class="fig">
<svg viewBox="0 0 760 520" class="dg" role="img" aria-label="A 与 B 循环依赖时三级缓存的交互时序">
<rect class="b1" x="10" y="20" width="120" height="44" rx="8"/>
<text class="tb" x="70" y="36" text-anchor="middle">Bean A</text>
<text class="ts" x="70" y="54" text-anchor="middle">创建流程</text>
<rect class="b2" x="140" y="20" width="120" height="44" rx="8"/>
<text class="tb" x="200" y="36" text-anchor="middle">Bean B</text>
<text class="ts" x="200" y="54" text-anchor="middle">创建流程</text>
<rect class="b3" x="320" y="20" width="120" height="44" rx="8"/>
<text class="tb" x="380" y="36" text-anchor="middle">三级缓存</text>
<text class="ts" x="380" y="54" text-anchor="middle">ObjectFactory</text>
<rect class="b5" x="480" y="20" width="120" height="44" rx="8"/>
<text class="tb" x="540" y="36" text-anchor="middle">二级缓存</text>
<text class="ts" x="540" y="54" text-anchor="middle">早期引用</text>
<rect class="b" x="630" y="20" width="120" height="44" rx="8"/>
<text class="tb" x="690" y="36" text-anchor="middle">一级缓存</text>
<text class="ts" x="690" y="54" text-anchor="middle">成品 Bean</text>
<line class="ld" x1="70" y1="64" x2="70" y2="500"/>
<line class="ld" x1="200" y1="64" x2="200" y2="500"/>
<line class="ld" x1="380" y1="64" x2="380" y2="500"/>
<line class="ld" x1="540" y1="64" x2="540" y2="500"/>
<line class="ld" x1="690" y1="64" x2="690" y2="500"/>
<line class="l" x1="70" y1="100" x2="380" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="290" y="92" text-anchor="middle">① 实例化 A，入三级</text>
<line class="l" x1="70" y1="145" x2="200" y2="145" marker-end="url(#arr)"/>
<text class="ts" x="135" y="137" text-anchor="middle">② getBean(B)</text>
<line class="l" x1="200" y1="190" x2="380" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="290" y="182" text-anchor="middle">③ 实例化 B，入三级</text>
<line class="l" x1="200" y1="235" x2="380" y2="235" marker-end="url(#arr)"/>
<text class="ts" x="290" y="227" text-anchor="middle">④ 注入 A：命中三级</text>
<line class="la" x1="380" y1="280" x2="540" y2="280" marker-end="url(#arr-a)"/>
<text class="ts" x="460" y="272" text-anchor="middle">⑤ getEarlyBeanReference</text>
<text class="ta" x="460" y="300" text-anchor="middle">提前生成 A 的代理</text>
<line class="l" x1="540" y1="330" x2="200" y2="330" marker-end="url(#arr)"/>
<text class="ts" x="290" y="322" text-anchor="middle">⑥ 代理 A 注入 B</text>
<line class="l" x1="200" y1="375" x2="690" y2="375" marker-end="url(#arr)"/>
<text class="ts" x="615" y="367" text-anchor="middle">⑦ B 完成，入一级</text>
<line class="l" x1="200" y1="420" x2="70" y2="420" marker-end="url(#arr)"/>
<text class="ts" x="135" y="412" text-anchor="middle">⑧ B 注入 A</text>
<line class="l" x1="70" y1="465" x2="690" y2="465" marker-end="url(#arr)"/>
<text class="ts" x="615" y="457" text-anchor="middle">⑨ 用二级中的代理</text>
<text class="ts" x="615" y="485" text-anchor="middle">作为最终 A 入一级</text>
</svg>
<figcaption>图 3：循环依赖时序。⑤ 只在真的发生循环引用时才执行，A 完成初始化后不会再被重复代理</figcaption>
</figure>

### 为什么需要第三级缓存

只有两级（成品 + 早期对象）也能解决**无代理**的循环依赖。问题在于 AOP：

- 按设计，代理应在 `postProcessAfterInitialization`（初始化之后）才创建；
- 但 B 在 A 初始化之前就要拿到 A，且必须拿到**最终的代理对象**，否则 B 持有的是原始 A，切面对 B 的调用失效；
- 如果只有二级缓存，就只能在实例化后**立即为所有 Bean 创建代理**放进去，打乱生命周期，也浪费。

第三级缓存存的是一个 lambda，**只有真正被循环引用时**才调用 `SmartInstantiationAwareBeanPostProcessor#getEarlyBeanReference` 提前创建代理。`AbstractAutoProxyCreator` 会把它记到 `earlyProxyReferences`，之后在 after-init 时发现已提前代理就直接返回原对象，再由 `doCreateBean` 末尾用二级缓存中的代理替换（图 3 ⑨）。

### 无法解决的情况

| 场景 | 原因 | 解法 |
| --- | --- | --- |
| 构造器注入互相依赖 | 实例化之前就需要对方，此时连"早期对象"都不存在 | 参数加 `@Lazy`（注入一个懒解析代理）、改用 `ObjectProvider`、重构 |
| prototype 互相依赖 | 原型不进缓存，每次都新建，会无限递归 | 重构 |
| `@Async` 方法所在 Bean 参与循环 | `AsyncAnnotationBeanPostProcessor` 不实现 `getEarlyBeanReference`，提前暴露的是原始对象，after-init 又包了一层代理，二者不一致 | 抛 `BeanCurrentlyInCreationException: ... injected into other beans in its raw version`；用 `@Lazy` 或消除循环 |

> [!WARNING] Spring Boot 2.6 起默认禁止循环依赖
> `spring.main.allow-circular-references` 默认 `false`，启动时报 *The dependencies of some of the beans in the application context form a cycle*。官方态度是：循环依赖是设计问题。临时可以改回 `true`，但应把它当技术债处理——常见拆法是抽取公共逻辑到第三个 Bean，或改为事件驱动。

## 作用域与 Scoped Proxy

| 作用域 | 说明 |
| --- | --- |
| `singleton`（默认） | 每个容器一个实例，注意**线程安全**由你保证 |
| `prototype` | 每次 `getBean` 新建，容器不管销毁 |
| `request` / `session` / `application` | Web 环境，绑定到请求 / 会话 / ServletContext |

**短作用域注入到单例**是典型坑：单例只在创建时注入一次，之后拿到的永远是同一个 prototype 实例；request 作用域甚至会因为启动时没有请求上下文而直接报错。解法：

```java
@Component
@Scope(value = WebApplicationContext.SCOPE_REQUEST, proxyMode = ScopedProxyMode.TARGET_CLASS)
public class RequestContextHolderBean { ... }   // @RequestScope 默认就是 TARGET_CLASS 代理

@Service
public class OrderService {
    private final ObjectProvider<PrototypeTask> taskProvider;  // 或者 @Lookup 方法
    void run() { taskProvider.getObject().execute(); }         // 每次取新实例
}
```

Scoped proxy 注入的是一个 CGLIB 代理，每次方法调用时代理再去对应 Scope 里取真实对象。Spring Cloud 的 `@RefreshScope` 也是同样原理（配置刷新时清掉缓存的实例）。

## @Configuration 的 CGLIB 增强

```java
@Configuration          // 默认 proxyBeanMethods = true（full 模式）
public class DataConfig {
    @Bean public DataSource dataSource() { return new HikariDataSource(); }
    @Bean public JdbcTemplate jdbcTemplate() {
        return new JdbcTemplate(dataSource());   // 调用的是增强子类的方法，返回容器中的单例
    }
}
```

`ConfigurationClassPostProcessor#enhanceConfigurationClasses` 把配置类的 beanClass 替换为 CGLIB 子类，`BeanMethodInterceptor` 拦截 `@Bean` 方法：若该 Bean 已在容器中（或正在创建），直接 `beanFactory.getBean()` 返回，而不是再 `new` 一个。

| 模式 | 条件 | `@Bean` 方法互调 | 代价 |
| --- | --- | --- | --- |
| full | `@Configuration`（默认） | 返回容器单例 | 需要生成子类，类和 `@Bean` 方法不能是 `final`/`private` |
| lite | `@Configuration(proxyBeanMethods = false)`，或 `@Component` 中的 `@Bean` | **每次调用都 new 新对象** | 启动更快、对 GraalVM native 更友好 |

> [!TIP] 实践建议
> Boot 2.2 起所有自动配置类都是 lite 模式。自己写配置类时，如果 `@Bean` 之间不互相调用（改用方法参数注入依赖），也建议 `proxyBeanMethods = false`。返回 `BeanFactoryPostProcessor` 的 `@Bean` 方法应声明为 `static`，否则会导致整个配置类过早实例化、`@Autowired`/`@Value` 失效。

## 事件机制

```java
public record OrderPaidEvent(Long orderId) {}             // 4.2 起任意对象都可作为事件

@Service
public class PayService {
    private final ApplicationEventPublisher publisher;
    public void pay(Long id) { ...; publisher.publishEvent(new OrderPaidEvent(id)); }
}

@Component
public class PointsListener {
    @EventListener                                        // 由 EventListenerMethodProcessor 注册
    @Order(1)
    public void on(OrderPaidEvent e) { ... }
}
```

- 发布走 `SimpleApplicationEventMulticaster#multicastEvent`，**默认同步**、与发布者同线程，监听器抛异常会传播给发布者，也会处在发布者的事务里。
- 异步：监听方法加 `@Async`（需 `@EnableAsync`），或给广播器设置 `taskExecutor`（影响全局，不推荐）。
- 需要"事务提交后再处理"用 `@TransactionalEventListener`，见 [声明式事务原理](#/spring/tx)。
- 容器事件：`ContextRefreshedEvent`（refresh 完成，父子容器场景可能触发多次）、`ContextClosedEvent`；Boot 又补充了 `ApplicationStartingEvent` → `ApplicationReadyEvent` 一系列启动事件。

## 生产实践与踩坑

> [!WARNING] @PostConstruct 中调用本类 @Transactional 方法不生效
> 执行 `@PostConstruct` 时 AOP 代理还没生成（代理在 after-init），而且是 `this` 调用。需要启动后执行的事务逻辑放到 `ApplicationRunner` 或监听 `ApplicationReadyEvent`。

> [!WARNING] BeanPostProcessor 依赖普通 Bean 导致"not eligible for getting processed by all BeanPostProcessors"
> BPP 在 refresh 第 6 步被提前实例化，它依赖的 Bean 也被连带提前创建，此时其他 BPP（如自动代理创建器）还没注册，这些 Bean 就**拿不到 AOP/事务增强**。日志里的 INFO 提示不要忽略。解法：BPP 用 `static @Bean` 声明、依赖用 `ObjectProvider` 懒获取。

- **同类型多个 Bean**：引入第二个 `DataSource`、`ObjectMapper` 后，原来按类型注入的地方报 `NoUniqueBeanDefinitionException`，或自动配置因 `@ConditionalOnSingleCandidate` 失效。给主实例加 `@Primary`。
- **Bean 覆盖**：Boot 2.1+ 默认禁止同名覆盖，两个模块定义同名 Bean 直接启动失败；不要随手开 `spring.main.allow-bean-definition-overriding=true` 掩盖问题。
- **单例中的可变状态**：Controller/Service 默认单例，成员变量保存请求数据会串数据，需要线程隔离的用局部变量或 `ThreadLocal`（注意清理）。
- **启动慢排查**：Boot 提供 `BufferingApplicationStartup` + `/actuator/startup` 输出每个 Bean 的创建耗时，比肉眼看日志准确。

## 相关阅读

- [创建型模式](#/java/patterns/creational)：工厂、单例等模式
- [DDD 战术设计：聚合、实体与领域事件（Java 落地）](#/design/ddd-tactical)：依赖倒置与领域层的无框架化

## 面试追问

> [!QUESTION] Spring 为什么需要三级缓存，两级行不行？
> - 不考虑 AOP，两级足够。
> - 第三级存 `ObjectFactory`，把"是否提前创建代理"推迟到真的发生循环引用时再决定；否则要么注入原始对象（切面失效），要么所有 Bean 实例化后立刻代理（破坏生命周期）。
> - 二级缓存保证多个 Bean 循环引用同一个 A 时拿到的是同一个早期代理。

> [!QUESTION] @Autowired 和 @Resource 有什么区别？同类型两个 Bean 时会怎样？
> `@Autowired` 先按类型再按 `@Primary`/`@Priority`/参数名兜底，无法决断抛 `NoUniqueBeanDefinitionException`；`@Resource` 先按名称（默认字段名），找不到才按类型。处理器分别是 `AutowiredAnnotationBeanPostProcessor` 和 `CommonAnnotationBeanPostProcessor`，都在 `populateBean` 的 `postProcessProperties` 阶段注入。

> [!QUESTION] BeanFactoryPostProcessor 和 BeanPostProcessor 的区别？各举一个框架里的例子。
> 前者在 Bean 创建前修改/新增 BeanDefinition，执行一次，如 `ConfigurationClassPostProcessor` 解析配置类、MyBatis `MapperScannerConfigurer` 注册 Mapper；后者在每个 Bean 初始化前后加工实例，如 `AutowiredAnnotationBeanPostProcessor` 注入、`AnnotationAwareAspectJAutoProxyCreator` 生成代理。

> [!QUESTION] @Configuration 和 @Component 里写 @Bean 有什么区别？
> `@Configuration` 默认 full 模式，类被 CGLIB 增强，`@Bean` 方法互调返回容器单例；`@Component` 或 `proxyBeanMethods=false` 是 lite 模式，互调就是普通 Java 调用，每次 new。Boot 自动配置全部用 lite 模式以加快启动。

> [!QUESTION] 构造器注入的循环依赖为什么解决不了？@Lazy 为什么能解决？
> 三级缓存依赖"先实例化、后注入"把半成品暴露出去，构造器注入在实例化阶段就需要对方，没有可暴露的对象。`@Lazy` 让容器注入一个懒解析代理，构造时不触发对方创建，第一次调用方法时才去容器取真实 Bean。

> [!QUESTION] 单例 Bean 是线程安全的吗？
> 容器只保证单例创建过程线程安全（`singletonObjects` 加锁），不保证 Bean 本身。无状态 Bean 天然安全；有可变成员变量就需要自己处理：改成局部变量、`ThreadLocal`、并发容器，或改 prototype/request 作用域。
