---
level: 进阶
tags: [JUnit 5, Mockito, Spring Boot Test, Testcontainers, JaCoCo, 测试金字塔]
summary: 讲清 JUnit 5 的架构与扩展模型、Mockito 的实现原理与正确用法、Spring Boot 切片测试和 Testcontainers 集成测试，以及测试策略与覆盖率。
---

# 单元测试：JUnit 5 与 Mockito

> [!ABSTRACT] 核心要点
> - **测试金字塔**：大量快速的单元测试、适量的集成测试、少量端到端测试；越往上越慢越脆弱。
> - **JUnit 5 = Platform + Jupiter + Vintage**：Platform 负责发现与执行，Jupiter 是新编程与扩展模型，Vintage 兼容 JUnit 3/4；通过 `@ExtendWith` 扩展。
> - **Mockito** 用 ByteBuddy 在运行时生成子类（或 inline 方式改写字节码）来替换依赖；原则是 **mock 外部协作者，不 mock 被测对象和值对象**。
> - Spring Boot 测试优先用**切片测试**（`@WebMvcTest`、`@DataJpaTest`）而不是每次 `@SpringBootTest`；上下文会被缓存，注意 `@MockBean/@MockitoBean` 会破坏缓存。
> - 集成测试用 **Testcontainers** 启动真实 MySQL/Redis/Kafka，比内存数据库（H2）更接近生产。

## 测试金字塔与原则

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="测试金字塔：单元测试、集成测试、端到端测试的比例与特征">
<path class="b2" d="M110 250 L630 250 L520 170 L220 170 Z"/>
<text class="tb" x="370" y="206" text-anchor="middle" dominant-baseline="middle">单元测试（数量最多）</text>
<text class="ts" x="370" y="230" text-anchor="middle">毫秒级 · 隔离依赖 · 每次提交都跑</text>
<path class="b3" d="M220 170 L520 170 L440 100 L300 100 Z"/>
<text class="tb" x="370" y="128" text-anchor="middle" dominant-baseline="middle">集成测试</text>
<text class="ts" x="370" y="150" text-anchor="middle">真实 DB / MQ · 秒级</text>
<path class="b4" d="M300 100 L440 100 L370 30 Z"/>
<text class="tb" x="370" y="80" text-anchor="middle" dominant-baseline="middle">E2E</text>
<text class="ts" x="680" y="60" text-anchor="end">慢、脆弱、成本高</text>
<text class="ts" x="680" y="140" text-anchor="end">验证模块协作与配置</text>
<text class="ts" x="680" y="220" text-anchor="end">验证业务逻辑与边界</text>
<line class="ld" x1="560" y1="60" x2="610" y2="60"/>
<line class="ld" x1="540" y1="140" x2="590" y2="140"/>
<line class="ld" x1="560" y1="220" x2="610" y2="220"/>
</svg>
<figcaption>图 1：测试金字塔</figcaption>
</figure>

好的单元测试遵循 **FIRST**：Fast、Independent、Repeatable、Self-validating、Timely；结构用 **Given-When-Then**（准备 → 执行 → 断言）。测试的是**行为**而不是实现细节，否则重构时测试大量失败。

## JUnit 5

### 架构

| 模块 | 职责 |
| --- | --- |
| **JUnit Platform** | 在 JVM 上启动测试框架的基础，定义 `TestEngine` SPI，IDE / Maven / Gradle 通过它运行测试 |
| **JUnit Jupiter** | 新的编程模型（`@Test`、`@ExtendWith`）与对应的 TestEngine |
| **JUnit Vintage** | 运行 JUnit 3/4 测试的引擎 |

### 常用注解与生命周期

```java
class OrderServiceTest {

    @BeforeAll static void initAll() { }          // 类内所有测试之前，一次（static）
    @BeforeEach void setUp() { }                  // 每个测试之前（每个测试方法会创建新的测试类实例）
    @AfterEach void tearDown() { }
    @AfterAll static void tearDownAll() { }

    @Test
    @DisplayName("库存不足时抛出异常")
    void shouldThrowWhenStockNotEnough() {
        var ex = assertThrows(BizException.class, () -> service.create(order));
        assertEquals("库存不足", ex.getMessage());
    }

    @ParameterizedTest
    @CsvSource({ "0,0", "1,1", "5,120" })
    void factorial(int n, long expected) {
        assertEquals(expected, MathUtil.factorial(n));
    }

    @ParameterizedTest
    @MethodSource("invalidOrders")
    void rejectInvalid(Order o) { assertThrows(IllegalArgumentException.class, () -> service.create(o)); }

    @Test @Timeout(2) void fast() { }
    @Test @Disabled("等待 #123 修复") void ignored() { }

    @Nested class WhenVip {                       // 嵌套测试：按场景组织
        @Test void discount() { }
    }
}
```

断言推荐 **AssertJ**，可读性更强：

```java
assertThat(users).hasSize(2).extracting(User::getName).containsExactly("a", "b");
assertThat(result).usingRecursiveComparison().isEqualTo(expected);
```

### 扩展模型（Extension）

JUnit 5 用统一的扩展点取代 4 的 `Runner/Rule`：`BeforeEachCallback`、`ParameterResolver`、`TestExecutionExceptionHandler`、`TestInstancePostProcessor`……

```java
class TimingExtension implements BeforeEachCallback, AfterEachCallback {
    @Override public void beforeEach(ExtensionContext ctx) { ctx.getStore(NS).put("t", System.nanoTime()); }
    @Override public void afterEach(ExtensionContext ctx)  { /* 计算并打印耗时 */ }
}

@ExtendWith(TimingExtension.class)
class SlowTest { }
```

`@ExtendWith(MockitoExtension.class)`、`@ExtendWith(SpringExtension.class)`（`@SpringBootTest` 已包含）都是通过它实现的。

## Mockito

### 原理

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="Mockito 生成 mock 并记录调用与桩的流程">
<rect class="b1" x="20" y="40" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="65" text-anchor="middle" dominant-baseline="middle">测试代码</text>
<rect class="b3" x="210" y="20" width="180" height="90" rx="10"/>
<text class="tb" x="300" y="44" text-anchor="middle" dominant-baseline="middle">mock(PayClient)</text>
<text class="ts" x="300" y="68" text-anchor="middle">ByteBuddy 生成子类 / inline</text>
<text class="ts" x="300" y="86" text-anchor="middle">拦截所有方法调用</text>
<rect class="b5" x="450" y="20" width="130" height="90" rx="10"/>
<text class="tb" x="515" y="44" text-anchor="middle" dominant-baseline="middle">MockHandler</text>
<text class="ts" x="515" y="68" text-anchor="middle">① 记录调用（供 verify）</text>
<text class="ts" x="515" y="86" text-anchor="middle">② 匹配桩 when/thenReturn</text>
<line class="l" x1="150" y1="65" x2="210" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="65" x2="450" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="150" width="700" height="80" rx="10"/>
<text class="tb" x="40" y="174">when(client.pay(any())).thenReturn(ok)  →  先“调用”记录最后一次调用，再为它登记返回值</text>
<text class="tb" x="40" y="198">verify(client).pay(any())              →  在调用记录中查找匹配次数</text>
<text class="ts" x="40" y="218">mockito-core 5+ 默认使用 inline mock maker，可 mock final 类/静态方法（mockStatic）</text>
</svg>
<figcaption>图 2：Mockito 的代理拦截、调用记录与桩</figcaption>
</figure>

- 默认（Mockito 5 起）使用 **inline mock maker**（Java Agent 方式改写字节码），可以 mock `final` 类、`final` 方法；早期版本基于 ByteBuddy 生成子类，不能 mock final；
- `mockStatic` 可 mock 静态方法，必须放在 try-with-resources 内限定作用域；
- JDK 21+ 动态加载 Agent 会有警告，需要在构建里显式配置 `-javaagent`（见 Mockito 文档）。

### 基本用法

```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock PayClient payClient;
    @Mock StockRepository stockRepo;
    @InjectMocks OrderService service;                 // 构造器注入被测对象
    @Captor ArgumentCaptor<PayRequest> captor;

    @Test
    void create_success() {
        given(stockRepo.deduct(1L, 2)).willReturn(true);          // stub
        given(payClient.pay(any())).willReturn(PayResult.ok());

        service.create(new Order(1L, 2));

        then(payClient).should().pay(captor.capture());           // verify + 捕获参数
        assertThat(captor.getValue().amount()).isEqualTo(200);
        then(stockRepo).should(times(1)).deduct(1L, 2);
        then(stockRepo).shouldHaveNoMoreInteractions();
    }

    @Test
    void create_whenPayFails_shouldRollbackStock() {
        given(stockRepo.deduct(anyLong(), anyInt())).willReturn(true);
        given(payClient.pay(any())).willThrow(new PayException("timeout"));

        assertThrows(BizException.class, () -> service.create(new Order(1L, 2)));
        then(stockRepo).should().restore(1L, 2);                  // 验证补偿
    }
}
```

| API | 说明 |
| --- | --- |
| `mock` vs `spy` | `spy` 包装真实对象，默认调用真实方法；用于部分 mock，优先少用 |
| `when(...).thenReturn` vs `doReturn(...).when(spy)...` | 对 spy 打桩要用 `doReturn`，否则会真的调用一次 |
| 参数匹配器 | `any()`、`eq()`、`argThat()`；**一旦用了匹配器，所有参数都必须用匹配器** |
| 严格桩 | `MockitoExtension` 默认严格：**未使用的桩**会报 `UnnecessaryStubbingException`，帮你清理冗余测试 |
| `verify` 滥用 | 验证实现细节会让测试脆弱，只验证有业务意义的交互 |

### mock 什么、不 mock 什么

- ✅ mock：**外部协作者**——远程调用、仓储、时钟、消息发送；
- ❌ 不 mock：被测对象本身、值对象 / DTO、简单工具类；
- 与时间相关用 `Clock` 注入，随机数、UUID 同理，保证可重复。

## Spring Boot 测试

### 切片测试（推荐）

| 注解 | 加载的内容 | 用途 |
| --- | --- | --- |
| `@WebMvcTest(OrderController.class)` | 仅 MVC 层（Controller、Filter、Advice），其余依赖需 mock | 测路由、参数校验、序列化、异常处理 |
| `@DataJpaTest` / `@MybatisTest` | 仅持久层与内嵌/容器数据库 | 测 SQL 与映射 |
| `@JsonTest` | JSON 序列化 | 测 DTO 的 Jackson 配置 |
| `@SpringBootTest` | 完整应用上下文 | 端到端集成，**最慢**，尽量少用 |

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
    @Autowired MockMvc mvc;
    @MockitoBean OrderService service;              // Spring Boot 3.4+；之前用 @MockBean

    @Test
    void getOrder() throws Exception {
        given(service.find(1L)).willReturn(new OrderVO(1L, "NEW"));
        mvc.perform(get("/api/orders/1"))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.status").value("NEW"));
    }

    @Test
    void create_invalid() throws Exception {
        mvc.perform(post("/api/orders").contentType(APPLICATION_JSON).content("{}"))
           .andExpect(status().isBadRequest());
    }
}
```

> [!WARNING] 上下文缓存
> Spring 会按**配置的组合**缓存测试 ApplicationContext，复用能显著加快整个测试套件。每种不同的 `@MockBean/@MockitoBean`、`@ActiveProfiles`、`@TestPropertySource` 组合都会产生一个新上下文。把 mock 声明提取到公共基类，或减少组合，可明显缩短构建时间；`@DirtiesContext` 会强制丢弃上下文，慎用。

### Testcontainers

用 Docker 启动真实依赖，替代 H2（方言、锁、JSON、窗口函数等行为与 MySQL 不同，H2 通过的测试不代表生产没问题）：

```java
@SpringBootTest
@Testcontainers
class OrderRepositoryIT {

    @Container @ServiceConnection                          // Boot 3.1+：自动配置连接属性
    static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");

    @Container @ServiceConnection(name = "redis")
    static GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);

    @Autowired OrderRepository repo;

    @Test
    void saveAndFind() {
        repo.save(new Order(...));
        assertThat(repo.findByUserId(1L)).hasSize(1);
    }
}
```

容器可设为 **static 复用**（同一测试类共用），或开启 reuse 以加速本地开发；CI 里需要 Docker 环境。

## 覆盖率与质量

- **JaCoCo** 统计行、分支覆盖率；覆盖率是**手段而非目标**：100% 覆盖不代表没 bug，低覆盖则说明有未验证区域；
- 关注**核心业务逻辑与边界条件**的分支覆盖，而不是 getter/setter；
- **变异测试（PIT）** 通过修改代码检验测试是否真正能发现缺陷，比覆盖率更能衡量测试质量；
- 在 CI 中设门槛（如新增代码行覆盖 ≥ 70%），并让测试**稳定**：杜绝依赖顺序、真实时间、网络、共享可变状态。

```xml
<plugin>
  <groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>0.8.12</version>
  <executions>
    <execution><goals><goal>prepare-agent</goal></goals></execution>
    <execution><id>report</id><phase>verify</phase><goals><goal>report</goal></goals></execution>
  </executions>
</plugin>
```

## 写出好测试的实践

1. 一个测试只验证一个行为，名字描述场景与预期（`shouldRejectWhenStockNotEnough`）；
2. **代码可测试性**依赖设计：构造器注入、依赖抽象、避免静态单例与 `new` 外部依赖；
3. 并发代码的测试避免用 `Thread.sleep`，用 `CountDownLatch`、`Awaitility`；
4. 测试数据用 Builder / Object Mother，避免到处手写大对象；
5. 慢测试（集成）与快测试（单元）分离到不同阶段（surefire / failsafe），见 [Maven 构建与依赖管理](#/java/eng/maven)；
6. 修 bug 先写**复现测试**，再修复，防止回归。

## 面试追问

> [!QUESTION] JUnit 5 的架构是怎样的？和 JUnit 4 有什么区别？
> JUnit 5 由 Platform、Jupiter、Vintage 组成；Platform 提供 TestEngine 抽象，Jupiter 是新的编程与扩展模型，Vintage 兼容旧版。扩展模型用 Extension 取代 Runner/Rule；支持嵌套测试、参数化测试、更灵活的生命周期，且 Java 8+。

> [!QUESTION] Mockito 的原理是什么？能 mock 静态方法和 final 类吗？
> 运行时通过 ByteBuddy 生成子类或用 inline 方式（Java Agent）改写字节码来拦截方法调用，记录调用并匹配桩。Mockito 5 默认 inline，可以 mock final 类和方法，`mockStatic` 可 mock 静态方法。

> [!QUESTION] mock 和 spy 的区别？什么时候用 doReturn？
> mock 是完全替身，未打桩返回默认值；spy 包装真实对象，未打桩调用真实方法。对 spy 用 `when(spy.m())` 会真实调用一次，应使用 `doReturn(x).when(spy).m()`。

> [!QUESTION] 为什么推荐 Testcontainers 而不是 H2？
> H2 与 MySQL 在 SQL 方言、事务隔离、锁、索引与函数上存在差异，H2 通过的测试不能保证生产可用；Testcontainers 用真实版本的 MySQL/Redis/Kafka，更接近生产，代价是需要 Docker 且启动稍慢。

> [!QUESTION] Spring Boot 测试怎么提速？
> 优先切片测试（`@WebMvcTest` 等）；尽量减少 `@SpringBootTest` 与 mock 声明组合以复用缓存的上下文；容器静态复用；并行执行；单元测试不启动 Spring。
