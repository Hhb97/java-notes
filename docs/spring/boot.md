---
level: 深入
tags: [Spring Boot, 自动配置, SpringApplication, Starter, Actuator, fat jar]
summary: 拆解 SpringApplication.run 启动流程、自动配置加载与条件装配、外部化配置优先级、fat jar 启动原理，以及 Boot 3.x 的关键变化
---

# Spring Boot 自动配置与启动

> [!ABSTRACT] 核心要点
> - `SpringApplication.run` = 准备环境（读配置）→ 创建对应类型的 `ApplicationContext` → `refresh()`（自动配置解析、单例创建、启动内嵌 WebServer）→ 执行 Runner → 发布 `ApplicationReadyEvent`，各阶段都有对应事件。
> - 自动配置本质是 `@Import(AutoConfigurationImportSelector)`：3.x 从 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 读取候选类（2.x 用 `spring.factories`），再由 `@Conditional` 家族按 classpath、已有 Bean、配置项决定是否生效。
> - 它是 `DeferredImportSelector`，在用户配置类之后处理，所以 `@ConditionalOnMissingBean` 能让**用户定义的 Bean 优先**。
> - fat jar 把依赖原样嵌套在 `BOOT-INF/lib`，由 `JarLauncher` + 自定义类加载器读取嵌套 jar，再反射调用 `Start-Class#main`。
> - Boot 3.x：JDK 17 基线、`javax` → `jakarta`、AOT/GraalVM native、Micrometer Observation/Tracing、3.2 起支持虚拟线程（`spring.threads.virtual.enabled`）。

## @SpringBootApplication 拆解

```java
@SpringBootConfiguration            // = @Configuration，标记主配置类（测试时用于定位）
@EnableAutoConfiguration            // = @AutoConfigurationPackage + @Import(AutoConfigurationImportSelector.class)
@ComponentScan(excludeFilters = {
    @Filter(type = FilterType.CUSTOM, classes = TypeExcludeFilter.class),
    @Filter(type = FilterType.CUSTOM, classes = AutoConfigurationExcludeFilter.class) })
public @interface SpringBootApplication { ... }
```

| 组成 | 作用 |
| --- | --- |
| `@ComponentScan` | 默认扫描**主类所在包及子包**；`AutoConfigurationExcludeFilter` 防止自动配置类被当普通组件扫进来 |
| `@AutoConfigurationPackage` | 把主类包名注册为 `AutoConfigurationPackages`，供 JPA 实体扫描、MyBatis `@Mapper` 扫描等使用 |
| `AutoConfigurationImportSelector` | 加载、过滤、排序自动配置类 |

> [!WARNING] 主类放错包
> 主类放在 `com.example.app`，而业务代码在 `com.example.order`，Controller、Mapper 全部扫描不到，表现为 404 或 *No qualifying bean*。主类应放在根包。

## SpringApplication.run 启动流程

构造阶段 `new SpringApplication(primarySources)`：

1. `WebApplicationType.deduceFromClasspath()`：有 `DispatcherServlet` 等 Servlet 类为 `SERVLET`，只有 `DispatcherHandler` 为 `REACTIVE`，否则 `NONE`；
2. 从 `spring.factories` 加载 `BootstrapRegistryInitializer`、`ApplicationContextInitializer`、`ApplicationListener`（这几类扩展点仍使用 `spring.factories`）；
3. 通过栈信息推断 `mainApplicationClass`。

<figure class="fig">
<svg viewBox="0 0 760 512" class="dg" role="img" aria-label="SpringApplication.run 的启动步骤与各阶段发布的事件">
<rect class="b" x="20" y="20" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="38" dominant-baseline="middle">new SpringApplication()</text>
<text class="ts" x="388" y="42" text-anchor="end">推断 Web 类型、加载扩展点</text>
<rect class="b" x="20" y="66" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="84" dominant-baseline="middle">listeners.starting()</text>
<text class="ts" x="388" y="88" text-anchor="end">创建 BootstrapContext</text>
<rect class="b" x="20" y="112" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="130" dominant-baseline="middle">prepareEnvironment()</text>
<text class="ts" x="388" y="134" text-anchor="end">读取配置、激活 profile</text>
<rect class="b" x="20" y="158" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="176" dominant-baseline="middle">createApplicationContext()</text>
<text class="ts" x="388" y="180" text-anchor="end">按 Web 类型选容器</text>
<rect class="b" x="20" y="204" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="222" dominant-baseline="middle">prepareContext()</text>
<text class="ts" x="388" y="226" text-anchor="end">执行 Initializer、注册主类</text>
<rect class="b3" x="20" y="250" width="380" height="58" rx="6"/>
<text class="tm" x="32" y="272">refreshContext() → refresh()</text>
<text class="ts" x="32" y="294">解析自动配置 → 实例化单例 → onRefresh 创建 WebServer</text>
<rect class="b" x="20" y="324" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="342" dominant-baseline="middle">afterRefresh()</text>
<text class="ts" x="388" y="346" text-anchor="end">空方法，留给子类</text>
<rect class="b" x="20" y="370" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="388" dominant-baseline="middle">listeners.started()</text>
<rect class="b2" x="20" y="416" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="434" dominant-baseline="middle">callRunners()</text>
<text class="ts" x="388" y="438" text-anchor="end">ApplicationRunner / CommandLineRunner</text>
<rect class="b" x="20" y="462" width="380" height="36" rx="6"/>
<text class="tm" x="32" y="480" dominant-baseline="middle">listeners.ready()</text>
<line class="l" x1="210" y1="56" x2="210" y2="66" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="102" x2="210" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="148" x2="210" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="194" x2="210" y2="204" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="240" x2="210" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="308" x2="210" y2="324" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="360" x2="210" y2="370" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="406" x2="210" y2="416" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="452" x2="210" y2="462" marker-end="url(#arr)"/>
<rect class="b3" x="460" y="69" width="280" height="30" rx="6"/>
<text class="tm" x="600" y="84" text-anchor="middle" dominant-baseline="middle">ApplicationStartingEvent</text>
<rect class="b3" x="460" y="115" width="280" height="30" rx="6"/>
<text class="tm" x="600" y="130" text-anchor="middle" dominant-baseline="middle">ApplicationEnvironmentPreparedEvent</text>
<rect class="b3" x="460" y="200" width="280" height="44" rx="6"/>
<text class="tm" x="600" y="215" text-anchor="middle" dominant-baseline="middle">ApplicationContextInitializedEvent</text>
<text class="tm" x="600" y="233" text-anchor="middle" dominant-baseline="middle">ApplicationPreparedEvent</text>
<rect class="b3" x="460" y="264" width="280" height="30" rx="6"/>
<text class="tm" x="600" y="279" text-anchor="middle" dominant-baseline="middle">ContextRefreshedEvent</text>
<rect class="b3" x="460" y="373" width="280" height="30" rx="6"/>
<text class="tm" x="600" y="388" text-anchor="middle" dominant-baseline="middle">ApplicationStartedEvent</text>
<rect class="b3" x="460" y="465" width="280" height="30" rx="6"/>
<text class="tm" x="600" y="480" text-anchor="middle" dominant-baseline="middle">ApplicationReadyEvent</text>
<line class="ld" x1="400" y1="84" x2="460" y2="84" marker-end="url(#arr)"/>
<line class="ld" x1="400" y1="130" x2="460" y2="130" marker-end="url(#arr)"/>
<line class="ld" x1="400" y1="222" x2="460" y2="222" marker-end="url(#arr)"/>
<line class="ld" x1="400" y1="279" x2="460" y2="279" marker-end="url(#arr)"/>
<line class="ld" x1="400" y1="388" x2="460" y2="388" marker-end="url(#arr)"/>
<line class="ld" x1="400" y1="480" x2="460" y2="480" marker-end="url(#arr)"/>
<text class="ts" x="460" y="440">任一步异常 → ApplicationFailedEvent</text>
</svg>
<figcaption>图 1：SpringApplication.run 的主要步骤（左）与对应发布的事件（右）</figcaption>
</figure>

```java
// Spring Boot 3.x SpringApplication#run（节选）
public ConfigurableApplicationContext run(String... args) {
    Startup startup = Startup.create();
    DefaultBootstrapContext bootstrapContext = createBootstrapContext();
    ConfigurableApplicationContext context = null;
    configureHeadlessProperty();
    SpringApplicationRunListeners listeners = getRunListeners(args);   // EventPublishingRunListener
    listeners.starting(bootstrapContext, this.mainApplicationClass);
    try {
        ApplicationArguments applicationArguments = new DefaultApplicationArguments(args);
        ConfigurableEnvironment environment = prepareEnvironment(listeners, bootstrapContext, applicationArguments);
        Banner printedBanner = printBanner(environment);
        context = createApplicationContext();          // SERVLET → AnnotationConfigServletWebServerApplicationContext
        context.setApplicationStartup(this.applicationStartup);
        prepareContext(bootstrapContext, context, environment, listeners, applicationArguments, printedBanner);
        refreshContext(context);                       // → AbstractApplicationContext#refresh，并注册 shutdown hook
        afterRefresh(context, applicationArguments);
        startup.started();
        listeners.started(context, startup.timeTakenToStarted());
        callRunners(context, applicationArguments);
    } catch (Throwable ex) {
        throw handleRunFailure(context, ex, listeners);   // 发布 ApplicationFailedEvent
    }
    listeners.ready(context, startup.ready());
    return context;
}
```

- `prepareEnvironment` 发布 `ApplicationEnvironmentPreparedEvent`，`EnvironmentPostProcessorApplicationListener` 调用各 `EnvironmentPostProcessor`，其中 `ConfigDataEnvironmentPostProcessor` 负责加载 `application.yml` 和 `spring.config.import`（Nacos 配置中心即在此接入）。
- `refresh()` 的细节见 [IoC 容器与 Bean 生命周期](#/spring/ioc)：自动配置在第 5 步解析；`ServletWebServerApplicationContext#onRefresh` 创建 Tomcat；`finishRefresh` 中由 `WebServerStartStopLifecycle` 真正开始监听端口。
- `ApplicationStartedEvent` 后发布 `LivenessState.CORRECT`，`ApplicationReadyEvent` 后发布 `ReadinessState.ACCEPTING_TRAFFIC`，与 K8s 探针对应。

> [!TIP] 启动后执行逻辑放在哪里
> 预热缓存、注册服务等放 `ApplicationRunner` 或监听 `ApplicationReadyEvent`（此时 Bean 全部就绪、事务代理已生效）。不要放在 `@PostConstruct` 中做远程调用：它阻塞启动，且执行时代理可能还没生成。注意 Runner 抛异常会导致启动失败。

## 自动配置加载

```java
// Spring Boot 3.x AutoConfigurationImportSelector#getAutoConfigurationEntry（节选）
protected AutoConfigurationEntry getAutoConfigurationEntry(AnnotationMetadata annotationMetadata) {
    if (!isEnabled(annotationMetadata)) return EMPTY_ENTRY;    // spring.boot.enableautoconfiguration
    AnnotationAttributes attributes = getAttributes(annotationMetadata);
    // 读取 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
    List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);
    configurations = removeDuplicates(configurations);
    Set<String> exclusions = getExclusions(annotationMetadata, attributes);   // exclude + spring.autoconfigure.exclude
    checkExcludedClasses(configurations, exclusions);
    configurations.removeAll(exclusions);
    configurations = getConfigurationClassFilter().filter(configurations);   // 快速预过滤
    fireAutoConfigurationImportEvents(configurations, exclusions);
    return new AutoConfigurationEntry(configurations, exclusions);
}
```

| 版本 | 注册文件 | 写法 |
| --- | --- | --- |
| 2.x（≤ 2.6） | `META-INF/spring.factories` | `org.springframework.boot.autoconfigure.EnableAutoConfiguration=a.XAutoConfiguration,\` |
| 2.7 | 两者都支持，推荐新文件 | 新增 `@AutoConfiguration` 注解 |
| 3.x | 只认 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` | 每行一个全限定类名 |

**快速预过滤**：`spring-boot-autoconfigure` 构建时生成 `META-INF/spring-autoconfigure-metadata.properties`，记录每个自动配置类的 `ConditionalOnClass` 等信息。`AutoConfigurationImportFilter`（`OnClassCondition`、`OnBeanCondition`、`OnWebApplicationCondition`）据此在**不加载类**的情况下先剔除大部分候选，显著减少启动时的类加载。

**顺序**：`@AutoConfiguration(before = ..., after = ...)`、`@AutoConfigureOrder` 只影响自动配置类之间的顺序，与用户配置类无关（用户配置类总是先处理）。

### @Conditional 家族

| 注解 | 条件 |
| --- | --- |
| `@ConditionalOnClass` / `OnMissingClass` | classpath 中存在 / 不存在某类（用字符串或类引用，后者靠 ASM 读注解不会触发加载） |
| `@ConditionalOnBean` / `OnMissingBean` | 容器中已有 / 没有某类型或名称的 Bean |
| `@ConditionalOnSingleCandidate` | 只有一个候选，或有一个 `@Primary` |
| `@ConditionalOnProperty` | 配置项满足，如 `prefix="x", name="enabled", havingValue="true", matchIfMissing=true` |
| `@ConditionalOnWebApplication` / `OnNotWebApplication` | 应用类型 |
| `@ConditionalOnResource`、`OnExpression`、`OnJava`、`OnCloudPlatform` | 资源、SpEL、JDK 版本、云平台（如 Kubernetes） |
| `@ConditionalOnThreading` | 3.2+，按是否启用虚拟线程装配 |

> [!WARNING] 在普通配置类中使用 @ConditionalOnBean
> 条件在解析 BeanDefinition 时求值，结果依赖**已注册的 BeanDefinition**。用户配置类之间的处理顺序不确定，`@ConditionalOnBean` 可能因为目标 Bean 尚未注册而判定失败。它只在自动配置类中才可靠（因为自动配置一定在用户配置之后）。

排查：启动加 `--debug` 或 `debug=true` 输出 *CONDITIONS EVALUATION REPORT*（Positive/Negative matches 与原因）；运行时看 `/actuator/conditions`。

## 自定义 Starter

```text
acme-sms-spring-boot-autoconfigure   # 自动配置 + 属性类
acme-sms-spring-boot-starter         # 空壳，只聚合依赖（autoconfigure + SDK）
```

```java
@ConfigurationProperties(prefix = "acme.sms")
public record SmsProperties(String endpoint, String accessKey,
                            @DefaultValue("3s") Duration timeout) {}   // 3.x 单构造器无需 @ConstructorBinding

@AutoConfiguration
@ConditionalOnClass(SmsClient.class)
@ConditionalOnProperty(prefix = "acme.sms", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(SmsProperties.class)
public class SmsAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean                  // 允许使用方覆盖
    public SmsClient smsClient(SmsProperties props) {
        return new SmsClient(props.endpoint(), props.accessKey(), props.timeout());
    }
}
```

```text
# src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.acme.sms.autoconfigure.SmsAutoConfiguration
```

要点：

1. 命名：官方为 `spring-boot-starter-*`，第三方为 `*-spring-boot-starter`；
2. 加 `spring-boot-configuration-processor`（optional）生成 `spring-configuration-metadata.json`，IDE 才有配置提示；
3. 自动配置类不要被组件扫描到（放在独立包），Bean 都加 `@ConditionalOnMissingBean`；
4. 用 `ApplicationContextRunner` 编写条件装配的单元测试；
5. 同时兼容 2.x 与 3.x 时，两个注册文件都要写，并注意 `javax`/`jakarta` 差异。

## 外部化配置

优先级从高到低（常用部分）：

| 优先级 | 来源 |
| --- | --- |
| 1 | 命令行参数 `--server.port=9000` |
| 2 | `SPRING_APPLICATION_JSON` |
| 3 | Java 系统属性 `-Dserver.port=9000` |
| 4 | 操作系统环境变量 `SERVER_PORT=9000` |
| 5 | jar 包**外**的 `application-{profile}.yml` |
| 6 | jar 包**外**的 `application.yml` |
| 7 | jar 包**内**的 `application-{profile}.yml` |
| 8 | jar 包**内**的 `application.yml` |
| 9 | `@PropertySource`、`SpringApplication.setDefaultProperties` |

- 位置覆盖顺序：`classpath:/` < `classpath:/config/` < `./` < `./config/` < `./config/*/`，后者覆盖前者；同一位置 `.properties` 优先于 `.yml`。
- 2.4 起配置加载重写为 Config Data API：支持 `spring.config.import`、`spring.config.activate.on-profile`，YAML 多文档用 `---` 分隔；旧的 `spring.profiles` 写法已废弃。
- Spring Cloud 2020.0 起默认不再加载 `bootstrap.yml`，推荐 `spring.config.import=nacos:xxx`，旧方式需引入 `spring-cloud-starter-bootstrap`。

### @ConfigurationProperties 与 @Value

| | `@ConfigurationProperties` | `@Value` |
| --- | --- | --- |
| 绑定方式 | 按前缀批量、类型安全 | 单个属性，SpEL |
| 宽松绑定 | 支持（`max-size`、`maxSize`、`MAX_SIZE` 都能绑定） | 有限 |
| 校验 | 类上加 `@Validated` + JSR-380 | 不支持 |
| 元数据/IDE 提示 | 支持 | 不支持 |
| 类型转换 | `Duration`（`10s`）、`DataSize`（`10MB`）、集合、嵌套对象 | 基础转换 |
| 不可变 | 支持 record / 构造器绑定 | — |

> [!TIP] 环境变量的名称映射
> `spring.datasource.hikari.maximum-pool-size` 对应环境变量 `SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE`（去掉连字符、点换下划线、全大写）。在 K8s 中用环境变量覆盖配置是最常见做法，敏感信息走 Secret，不要写进仓库。

## Fat Jar 与 JarLauncher

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="Spring Boot 可执行 jar 的目录结构与 JarLauncher 启动流程">
<rect class="bg" x="10" y="10" width="360" height="300" rx="10"/>
<text class="tb" x="24" y="32">app.jar（可执行 fat jar）</text>
<text class="tm" x="28" y="58">META-INF/MANIFEST.MF</text>
<text class="tm" x="28" y="82">BOOT-INF/</text>
<text class="tm" x="44" y="104">classes/</text>
<text class="ts" x="200" y="104">业务 class 与配置文件</text>
<text class="tm" x="44" y="126">lib/*.jar</text>
<text class="ts" x="200" y="126">依赖 jar，原样嵌套</text>
<text class="tm" x="44" y="148">classpath.idx</text>
<text class="ts" x="200" y="148">依赖顺序</text>
<text class="tm" x="44" y="170">layers.idx</text>
<text class="ts" x="200" y="170">分层构建镜像用</text>
<text class="tm" x="28" y="194">org/springframework/boot/loader/</text>
<text class="ts" x="44" y="214">Launcher 类直接放在 jar 根下</text>
<rect class="b" x="24" y="234" width="332" height="60" rx="8"/>
<text class="tm" x="36" y="256">Main-Class: …loader.launch.JarLauncher</text>
<text class="tm" x="36" y="278">Start-Class: com.example.App</text>
<rect class="b1" x="420" y="20" width="320" height="44" rx="8"/>
<text class="tm" x="432" y="38">java -jar app.jar</text>
<text class="ts" x="432" y="56">JVM 读取 MANIFEST 的 Main-Class</text>
<rect class="b1" x="420" y="84" width="320" height="44" rx="8"/>
<text class="tm" x="432" y="102">JarLauncher#main</text>
<text class="ts" x="432" y="120">把 classes/ 与 lib/*.jar 解析为 URL 列表</text>
<rect class="b2" x="420" y="148" width="320" height="44" rx="8"/>
<text class="tm" x="432" y="166">LaunchedClassLoader</text>
<text class="ts" x="432" y="184">自定义类加载器，可直接读取嵌套 jar</text>
<rect class="b3" x="420" y="212" width="320" height="44" rx="8"/>
<text class="tm" x="432" y="230">反射调用 Start-Class#main</text>
<text class="ts" x="432" y="248">以线程上下文类加载器进入 SpringApplication.run</text>
<line class="l" x1="580" y1="64" x2="580" y2="84" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="128" x2="580" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="192" x2="580" y2="212" marker-end="url(#arr)"/>
<line class="ld" x1="356" y1="256" x2="420" y2="42" marker-end="url(#arr)"/>
</svg>
<figcaption>图 2：fat jar 结构与启动流程（类名以 Boot 3.2+ 新版 loader 为准）</figcaption>
</figure>

标准 JDK 的 `URLClassLoader` 无法加载"jar 中的 jar"，所以 Boot 自带 loader：

- Boot 3.2 起使用重写的 loader，入口为 `org.springframework.boot.loader.launch.JarLauncher`；2.x ~ 3.1 为 `org.springframework.boot.loader.JarLauncher`，类加载器为 `LaunchedURLClassLoader`。自定义 MANIFEST 或启动脚本写死旧类名的，升级后会启动失败。
- `java -jar` 时用的是 jar 内的 loader；IDE 中直接运行 `main` 则走普通 classpath，**两者类加载行为不同**，"本地正常、打包后找不到资源"的问题多由此产生（例如用 `new File(classpath 路径)` 读取 jar 内资源，应改为 `getResourceAsStream`）。
- 分层（layers）：依赖、loader、快照依赖、应用代码分层，配合 Docker 镜像层缓存，改代码只需重推最后一层。提取命令 2.x/3.2 前为 `java -Djarmode=layertools -jar app.jar extract`，3.3 起推荐 `java -Djarmode=tools -jar app.jar extract --layers`。容器化见 [Docker 容器化](#/infra/docker)，类加载原理见 [类加载与双亲委派](#/java/jvm/classloader)。

## Actuator 与指标

| 端点 | 用途 | 暴露建议 |
| --- | --- | --- |
| `/actuator/health`（含 `/liveness`、`/readiness`） | 健康检查、K8s 探针 | 暴露 |
| `/actuator/info` | 版本、Git 信息 | 可暴露 |
| `/actuator/metrics`、`/actuator/prometheus` | Micrometer 指标（需 `micrometer-registry-prometheus`） | 内网暴露 |
| `/actuator/loggers` | 运行时调整日志级别 | 内网 + 鉴权 |
| `/actuator/threaddump`、`/heapdump` | 线程栈、堆转储 | **严禁公网**，heapdump 含内存中的密码与 token |
| `/actuator/env`、`/configprops` | 配置（敏感值默认脱敏） | 严禁公网 |
| `/actuator/conditions`、`/beans`、`/mappings`、`/startup` | 排查装配、路由、启动耗时 | 按需 |

```yaml
management:
  server:
    port: 9091                       # 管理端口与业务端口分离，网关不转发
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,loggers
  endpoint:
    health:
      probes:
        enabled: true                # 在 K8s 外也开启 liveness/readiness 分组
      show-details: when-authorized
  metrics:
    tags:
      application: ${spring.application.name}
```

> [!CAUTION] Actuator 暴露导致的安全事故
> 历史上大量事故源于 `exposure.include=*` 并暴露在公网：`/heapdump` 泄露数据库密码与密钥、`/env` 配合某些组件可被利用执行代码。2.5 起 Web 默认只暴露 `health`，修改暴露范围时必须同时配置独立端口或 Spring Security 鉴权。

Micrometer 常用指标：`http.server.requests`（按 uri/status 统计 QPS 与耗时分位）、`jvm.memory.used`、`jvm.gc.pause`、`hikaricp.connections.active`、`tomcat.threads.busy`。业务指标用 `Counter`/`Timer`/`Gauge` 自定义，注意 tag 不要用用户 ID、订单号等高基数值，否则会拖垮 Prometheus。

## 优雅停机

```yaml
server:
  shutdown: graceful                       # 2.3+ 支持；3.4 起默认即 graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s        # 默认 30s
```

收到 SIGTERM（`kill -15`，K8s 删除 Pod）后：JVM shutdown hook → `context.close()` → WebServer 停止接收新请求并等待在途请求完成（最长 `timeout-per-shutdown-phase`）→ 销毁 Bean（关闭线程池、连接池、注销注册中心）。

- `kill -9` 不会触发任何 hook。
- K8s 中 Pod 从 Service 摘除与发送 SIGTERM 是**并行**的，可能在摘除前就停止接收请求，常见做法是 `preStop` 中 `sleep` 几秒；注册中心场景还要先主动下线实例，等待消费者刷新本地缓存。见 [Kubernetes 核心概念](#/infra/k8s)。
- 自定义线程池需 `setWaitForTasksToCompleteOnShutdown(true)` 和 `setAwaitTerminationSeconds`，否则停机时队列中的任务丢失。

## Boot 3.x 的主要变化

| 变化 | 说明 |
| --- | --- |
| JDK 17 基线 | 基于 Spring Framework 6 |
| Jakarta EE 9+/10 | `javax.servlet`、`javax.persistence`、`javax.validation` 全部改为 `jakarta.*`；老三方库需对应新版本 |
| 自动配置注册 | 只认 `AutoConfiguration.imports` |
| 配置项改名 | 如 `spring.redis.*` → `spring.data.redis.*`；可引入 `spring-boot-properties-migrator` 在启动日志中提示 |
| 可观测性 | Micrometer Observation API；Spring Cloud Sleuth 被 Micrometer Tracing 取代 |
| AOT 与 GraalVM native | 构建期分析生成 Bean 定义代码与反射元数据，`native:compile` 产出本地可执行文件，启动百毫秒级、内存小；代价是构建慢、反射/动态代理需要提示、运行时条件装配受限 |
| HTTP 客户端 | `@HttpExchange` 声明式接口（6.0）、`RestClient`（6.1 / Boot 3.2）、`JdbcClient`（6.1） |
| 虚拟线程 | Boot 3.2 + JDK 21：`spring.threads.virtual.enabled=true`，Tomcat 请求处理、`@Async`、调度等改用虚拟线程 |
| ProblemDetail | RFC 7807 错误响应 |
| 路径匹配 | 末尾斜杠默认不匹配 |

> [!WARNING] 虚拟线程的注意事项
> 虚拟线程适合大量阻塞 IO 的场景，但：`synchronized` 块内阻塞会钉住（pin）载体线程（JDK 24 起基本解决）；不要再用线程池去"池化"虚拟线程；连接池大小仍是真正的并发上限；`ThreadLocal` 大对象在海量虚拟线程下会放大内存占用。

## 启动优化

| 手段 | 效果与代价 |
| --- | --- |
| 先度量 | `BufferingApplicationStartup` + `/actuator/startup`，找出耗时最长的 Bean |
| 缩小扫描范围、排除无用自动配置 | `exclude`、精简依赖，减少类加载与条件判断 |
| `spring.main.lazy-initialization=true` | 启动显著变快，但错误推迟到首次请求、首请求变慢，生产慎用；可对个别 Bean 用 `@Lazy` |
| 避免启动期远程调用 | `@PostConstruct` 里调远程服务、加载大缓存改为异步预热 |
| Spring 6.2 后台初始化 | `@Bean(bootstrap = BACKGROUND)` 让耗时 Bean 在后台线程初始化 |
| CDS / AppCDS | 3.3 起官方支持，提取 jar 后生成类数据共享归档，启动可明显提速 |
| GraalVM native / CRaC | 启动最快，但约束最多 |

## 生产实践与踩坑

- **依赖冲突**：不同 starter 引入不同版本的 Jackson/Netty，运行时 `NoSuchMethodError`。统一用 `spring-boot-dependencies` BOM 管理版本，用 `mvn dependency:tree` 排查，见 [Maven 构建与依赖管理](#/java/eng/maven)。
- **自动配置"抢"了你的 Bean**：自己定义了 `RedisTemplate<String, Object>`，但注入点写的是 `RedisTemplate<Object, Object>`，拿到的是自动配置的那个，序列化方式不符预期。
- **多数据源后自动配置失效**：定义多个 `DataSource` 后，`DataSourceAutoConfiguration`、事务管理器自动配置因 `@ConditionalOnMissingBean`/`OnSingleCandidate` 退出，需要自己补齐并加 `@Primary`。
- **profile 混用**：`spring.profiles.active` 写在 profile 专属文件里无效（2.4+ 会报错），应通过命令行或环境变量指定。

## 相关阅读

- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：Actuator + Micrometer 指标
- [认证授权：Session、JWT、OAuth2 与 Spring Security](#/security/auth)：Spring Security 6 认证授权
- [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release)：优雅停机、探针与发布

## 面试追问

> [!QUESTION] Spring Boot 自动配置的原理？
> `@EnableAutoConfiguration` 导入 `AutoConfigurationImportSelector`（`DeferredImportSelector`），在用户配置类解析完后读取 `AutoConfiguration.imports`（2.x 为 `spring.factories`）中的候选类，经过排除、元数据快速预过滤后交给 `ConfigurationClassParser`，各配置类再通过 `@ConditionalOnClass`、`@ConditionalOnMissingBean`、`@ConditionalOnProperty` 等决定是否生效。

> [!QUESTION] 为什么用户自定义的 Bean 能覆盖自动配置的 Bean？
> 自动配置由延迟导入选择器在所有用户配置类之后处理，判断 `@ConditionalOnMissingBean` 时用户的 BeanDefinition 已经注册，条件不满足，自动配置的 Bean 就不注册。不是"覆盖"，而是"让位"。

> [!QUESTION] Spring Boot 内嵌 Tomcat 是什么时候启动的？
> `refresh()` 的 `onRefresh` 阶段，`ServletWebServerApplicationContext#createWebServer` 通过 `ServletWebServerFactory` 创建并初始化 Tomcat（此时已注册 DispatcherServlet、Filter），`finishRefresh` 阶段由 `WebServerStartStopLifecycle` 启动 Connector 开始监听端口，所以端口在所有单例创建完成后才对外开放。

> [!QUESTION] java -jar 是怎么运行 fat jar 的？
> MANIFEST 中 `Main-Class` 是 Boot 的 `JarLauncher`，`Start-Class` 是业务主类。JarLauncher 把 `BOOT-INF/classes` 和 `BOOT-INF/lib` 下的嵌套 jar 构造成 URL，创建能读取嵌套 jar 的自定义类加载器，设为线程上下文类加载器后反射调用 `Start-Class` 的 `main`。

> [!QUESTION] 如何设计一个 starter？需要注意什么？
> 拆 autoconfigure 与 starter 两个模块；`@AutoConfiguration` + 条件注解 + `@ConfigurationProperties`；在 `AutoConfiguration.imports` 中注册；所有 Bean 加 `@ConditionalOnMissingBean` 便于覆盖；提供配置元数据；不要被业务组件扫描扫到；用 `ApplicationContextRunner` 测试各种条件组合。
