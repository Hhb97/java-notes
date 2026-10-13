---
level: 深入
tags: [Spring, 事务, Transactional, 传播行为, TransactionSynchronizationManager]
summary: 拆解 @Transactional 从代理拦截到 ThreadLocal 绑定连接的完整链路，覆盖传播行为、回滚规则、全部失效场景和大事务治理
---

# 声明式事务原理

> [!ABSTRACT] 核心要点
> - `@Transactional` = AOP 代理 + `TransactionInterceptor` + `PlatformTransactionManager`。事务管理器开启事务时把 `Connection` 放进 `TransactionSynchronizationManager` 的 **ThreadLocal**，MyBatis/JdbcTemplate 通过 `DataSourceUtils` 取到**同一个连接**，这就是"同一线程内共享事务"的本质。
> - 默认只对 `RuntimeException` 和 `Error` 回滚，受检异常照样提交；生产统一写 `rollbackFor = Exception.class`。
> - `REQUIRED` 内层异常会把整个事务标记为 rollback-only，外层即使 catch 了也提交不了（`UnexpectedRollbackException`）；`REQUIRES_NEW` 是挂起外层、新开连接；`NESTED` 是同一连接上的保存点。
> - 失效的根因只有几类：**没走代理**（自调用、非 public、final、非 Bean）、**异常没传到拦截器**（被吞、类型不匹配）、**不在同一线程/连接**（多线程、多数据源）。
> - 发 MQ、删缓存、调外部接口要放在**事务提交之后**（`TransactionSynchronization#afterCommit` / `@TransactionalEventListener`），并避免大事务。

## 整体架构

| 角色 | 类 | 职责 |
| --- | --- | --- |
| 开关 | `@EnableTransactionManagement`（Boot 的 `TransactionAutoConfiguration` 自动开启） | 导入 `ProxyTransactionManagementConfiguration` |
| Advisor | `BeanFactoryTransactionAttributeSourceAdvisor` | 切点：方法或类上有 `@Transactional` |
| 属性解析 | `AnnotationTransactionAttributeSource` | 把注解解析成 `RuleBasedTransactionAttribute`，按方法缓存 |
| 拦截器 | `TransactionInterceptor` → `TransactionAspectSupport` | 模板方法：开启、提交、回滚、清理 |
| 事务管理器 | `PlatformTransactionManager` | JDBC/MyBatis 用 `DataSourceTransactionManager`（Boot 3.x 自动配置的是其子类 `JdbcTransactionManager`），JPA 用 `JpaTransactionManager`，分布式用 JTA |
| 资源绑定 | `TransactionSynchronizationManager` | 一组 `static ThreadLocal`，保存连接、同步回调、事务属性 |

代理机制本身见 [AOP 与代理机制](#/spring/aop)；数据库层面的隔离级别与 MVCC 见 [事务隔离与 MVCC](#/mysql/transaction)。

## 调用链路

<figure class="fig">
<svg viewBox="0 0 760 444" class="dg" role="img" aria-label="@Transactional 方法调用经过拦截器、事务管理器并把连接绑定到 ThreadLocal 的链路">
<rect class="b5" x="20" y="20" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="38">OrderService$$SpringCGLIB$$0</text>
<text class="ts" x="32" y="56">代理对象拦截方法调用</text>
<rect class="b" x="20" y="80" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="98">TransactionInterceptor#invoke</text>
<text class="ts" x="32" y="116">解析 @Transactional 得到 TransactionAttribute</text>
<rect class="b" x="20" y="140" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="158">invokeWithinTransaction</text>
<text class="ts" x="32" y="176">TransactionAspectSupport 模板方法</text>
<rect class="b3" x="20" y="200" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="218">getTransaction → doBegin</text>
<text class="ts" x="32" y="236">取连接、setAutoCommit(false)、绑定到线程</text>
<rect class="b" x="20" y="260" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="278">invocation.proceedWithInvocation()</text>
<text class="ts" x="32" y="296">执行业务方法：Mapper / JdbcTemplate</text>
<rect class="b2" x="20" y="320" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="338">DataSourceUtils.getConnection</text>
<text class="ts" x="32" y="356">从线程绑定资源取同一个 Connection</text>
<rect class="b3" x="20" y="380" width="360" height="44" rx="8"/>
<text class="tm" x="32" y="398">commit 或 rollback</text>
<text class="ts" x="32" y="416">triggerAfterCommit 回调，最后 cleanup 解绑、归还连接</text>
<line class="l" x1="200" y1="64" x2="200" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="200" y1="124" x2="200" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="200" y1="184" x2="200" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="200" y1="244" x2="200" y2="260" marker-end="url(#arr)"/>
<line class="l" x1="200" y1="304" x2="200" y2="320" marker-end="url(#arr)"/>
<line class="l" x1="200" y1="364" x2="200" y2="380" marker-end="url(#arr)"/>
<rect class="bg" x="470" y="146" width="280" height="226" rx="10"/>
<text class="tb" x="482" y="166">TransactionSynchronizationManager</text>
<text class="ts" x="482" y="183">static ThreadLocal 字段</text>
<rect class="b1" x="484" y="196" width="252" height="28" rx="6"/>
<text class="tm" x="610" y="210" text-anchor="middle" dominant-baseline="middle">resources: DS → ConnectionHolder</text>
<rect class="b" x="484" y="230" width="252" height="28" rx="6"/>
<text class="tm" x="610" y="244" text-anchor="middle" dominant-baseline="middle">synchronizations</text>
<rect class="b" x="484" y="264" width="252" height="28" rx="6"/>
<text class="tm" x="610" y="278" text-anchor="middle" dominant-baseline="middle">currentTransactionName</text>
<rect class="b" x="484" y="298" width="252" height="28" rx="6"/>
<text class="tm" x="610" y="312" text-anchor="middle" dominant-baseline="middle">readOnly / isolationLevel</text>
<rect class="b" x="484" y="332" width="252" height="28" rx="6"/>
<text class="tm" x="610" y="346" text-anchor="middle" dominant-baseline="middle">actualTransactionActive</text>
<line class="la" x1="380" y1="222" x2="484" y2="210" marker-end="url(#arr-a)"/>
<text class="ta" x="432" y="206" text-anchor="middle">bindResource</text>
<line class="ld" x1="380" y1="342" x2="484" y2="215" marker-end="url(#arr)"/>
<text class="ts" x="432" y="304" text-anchor="middle">getResource</text>
</svg>
<figcaption>图 1：事务方法调用链；关键在于开启事务和执行 SQL 通过 ThreadLocal 共享同一个连接</figcaption>
</figure>

```java
// Spring 6 TransactionAspectSupport#invokeWithinTransaction（节选，省略响应式与回调式分支）
TransactionAttributeSource tas = getTransactionAttributeSource();
TransactionAttribute txAttr = tas.getTransactionAttribute(method, targetClass);
PlatformTransactionManager ptm = asPlatformTransactionManager(determineTransactionManager(txAttr));
String joinpoint = methodIdentification(method, targetClass, txAttr);

TransactionInfo txInfo = createTransactionIfNecessary(ptm, txAttr, joinpoint); // → getTransaction
Object retVal;
try {
    retVal = invocation.proceedWithInvocation();        // 继续拦截器链 → 目标方法
} catch (Throwable ex) {
    completeTransactionAfterThrowing(txInfo, ex);       // rollbackOn(ex) ? rollback : commit
    throw ex;
} finally {
    cleanupTransactionInfo(txInfo);                     // 恢复外层 TransactionInfo
}
commitTransactionAfterReturning(txInfo);
return retVal;
```

```java
// Spring 6 DataSourceTransactionManager#doBegin（节选）
Connection newCon = obtainDataSource().getConnection();
txObject.setConnectionHolder(new ConnectionHolder(newCon), true);
Integer previousIsolation = DataSourceUtils.prepareConnectionForTransaction(con, definition); // 只读、隔离级别
if (con.getAutoCommit()) {
    txObject.setMustRestoreAutoCommit(true);
    con.setAutoCommit(false);                           // 真正"开启"事务
}
prepareTransactionalConnection(con, definition);        // enforceReadOnly 时执行 SET TRANSACTION READ ONLY
txObject.getConnectionHolder().setTransactionActive(true);
if (timeout != TransactionDefinition.TIMEOUT_DEFAULT) {
    txObject.getConnectionHolder().setTimeoutInSeconds(timeout);
}
if (txObject.isNewConnectionHolder()) {
    TransactionSynchronizationManager.bindResource(obtainDataSource(), txObject.getConnectionHolder());
}
```

MyBatis 的 `SpringManagedTransaction#getConnection` 内部就是 `DataSourceUtils.getConnection(dataSource)`：先 `TransactionSynchronizationManager.getResource(dataSource)`，有就复用，没有才从连接池取新连接（并以自动提交模式执行）。

## 传播行为

传播行为在 `AbstractPlatformTransactionManager#getTransaction` 中处理：当前线程**已有事务**走 `handleExistingTransaction`，否则按"无事务"分支。

| 传播行为 | 当前有事务 | 当前无事务 | 典型用途 |
| --- | --- | --- | --- |
| `REQUIRED`（默认） | 加入 | 新建 | 绝大多数业务方法 |
| `REQUIRES_NEW` | **挂起**外层，新建（新连接） | 新建 | 记录操作日志、发号，不受外层回滚影响 |
| `NESTED` | 在当前连接创建**保存点** | 新建 | 批量处理中单条失败可局部回滚 |
| `SUPPORTS` | 加入 | 非事务执行 | 查询方法 |
| `NOT_SUPPORTED` | 挂起外层，非事务执行 | 非事务执行 | 长耗时、不需要事务的调用 |
| `MANDATORY` | 加入 | 抛异常 | 强制要求调用方开事务 |
| `NEVER` | 抛异常 | 非事务执行 | 断言不在事务中 |

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="REQUIRED、REQUIRES_NEW、NESTED 三种传播行为下内外层事务关系与回滚结果对比">
<rect class="bg" x="10" y="10" width="236" height="310" rx="10"/>
<rect class="bg" x="262" y="10" width="236" height="310" rx="10"/>
<rect class="bg" x="514" y="10" width="236" height="310" rx="10"/>
<text class="th" x="128" y="34" text-anchor="middle">REQUIRED</text>
<text class="th" x="380" y="34" text-anchor="middle">REQUIRES_NEW</text>
<text class="th" x="632" y="34" text-anchor="middle">NESTED</text>
<rect class="b1" x="24" y="50" width="208" height="120" rx="8"/>
<text class="ts" x="36" y="68">A 开启 T1（conn1）</text>
<rect class="b2" x="44" y="88" width="168" height="62" rx="6"/>
<text class="tb" x="128" y="110" text-anchor="middle">B 加入 T1</text>
<text class="ts" x="128" y="130" text-anchor="middle">同一连接、同一事务</text>
<rect class="b1" x="276" y="50" width="208" height="56" rx="8"/>
<text class="ts" x="288" y="70">A 开启 T1（conn1）</text>
<text class="ts" x="288" y="92">调用 B 时 T1 被挂起</text>
<rect class="b3" x="276" y="114" width="208" height="56" rx="8"/>
<text class="tb" x="380" y="134" text-anchor="middle">B 新建 T2（conn2）</text>
<text class="ts" x="380" y="154" text-anchor="middle">独立提交 / 回滚</text>
<rect class="b1" x="528" y="50" width="208" height="120" rx="8"/>
<text class="ts" x="540" y="68">A 开启 T1（conn1）</text>
<rect class="b5" x="548" y="88" width="168" height="62" rx="6"/>
<text class="tb" x="632" y="110" text-anchor="middle">B：SAVEPOINT sp1</text>
<text class="ts" x="632" y="130" text-anchor="middle">同一连接上的保存点</text>
<text class="ts" x="24" y="198">场景①：B 抛异常，A catch 住</text>
<text class="t" x="24" y="218">整体回滚</text>
<text class="t" x="24" y="238">提交时抛 UnexpectedRollback</text>
<text class="ts" x="24" y="268">场景②：B 成功，A 随后抛异常</text>
<text class="t" x="24" y="288">A、B 一起回滚</text>
<text class="ts" x="276" y="198">场景①：B 抛异常，A catch 住</text>
<text class="t" x="276" y="218">T2 回滚</text>
<text class="t" x="276" y="238">T1 可以正常提交</text>
<text class="ts" x="276" y="268">场景②：B 成功，A 随后抛异常</text>
<text class="t" x="276" y="288">T1 回滚，B 已提交不受影响</text>
<text class="ts" x="528" y="198">场景①：B 抛异常，A catch 住</text>
<text class="t" x="528" y="218">回滚到 sp1</text>
<text class="t" x="528" y="238">T1 可以正常提交</text>
<text class="ts" x="528" y="268">场景②：B 成功，A 随后抛异常</text>
<text class="t" x="528" y="288">A、B 一起回滚</text>
</svg>
<figcaption>图 2：三种常用传播行为对比（A 外层、B 内层，两者在不同 Bean 中）</figcaption>
</figure>

```java
// Spring 6 AbstractPlatformTransactionManager#handleExistingTransaction（节选）
if (definition.getPropagationBehavior() == PROPAGATION_REQUIRES_NEW) {
    SuspendedResourcesHolder suspended = suspend(transaction);   // 解绑 conn1 及同步回调，暂存
    try {
        return startTransaction(definition, transaction, true, debugEnabled, suspended); // 新连接 doBegin
    } catch (RuntimeException | Error ex) {
        resumeAfterBeginException(transaction, suspended, ex);
        throw ex;
    }
}
if (definition.getPropagationBehavior() == PROPAGATION_NESTED) {
    if (useSavepointForNestedTransaction()) {                    // DataSourceTransactionManager 为 true
        DefaultTransactionStatus status = newTransactionStatus(definition, transaction, false, ...);
        status.createAndHoldSavepoint();                         // con.setSavepoint()
        return status;
    }
    ...
}
// REQUIRED / SUPPORTS / MANDATORY：参与当前事务，newTransaction = false
```

> [!WARNING] REQUIRED 下的 "Transaction silently rolled back because it has been marked as rollback-only"
> 内层 B 抛异常时，事务拦截器发现自己**不是事务的发起者**，不能真的回滚，只能 `setRollbackOnly()` 标记全局回滚；外层 A catch 住异常后正常返回，提交时检测到标记，只能回滚并抛出 `UnexpectedRollbackException`。想"内层失败不影响外层"，要么用 `REQUIRES_NEW`/`NESTED`，要么别让异常穿过内层事务边界（在内层方法里 catch，但要清楚数据后果）。

> [!CAUTION] REQUIRES_NEW 的连接池死锁
> `REQUIRES_NEW` 挂起外层时**外层连接并没有归还**，一个请求同时占用两个连接。高并发下所有线程都拿着一个连接等第二个，连接池耗尽后全部卡死（直到获取连接超时）。嵌套越深占用越多。连接池大小要考虑这一点，或减少 `REQUIRES_NEW` 的使用。

## 回滚规则

```java
// DefaultTransactionAttribute#rollbackOn
public boolean rollbackOn(Throwable ex) {
    return (ex instanceof RuntimeException || ex instanceof Error);
}
```

- 配了 `rollbackFor`/`noRollbackFor` 时由 `RuleBasedTransactionAttribute` 处理：沿异常继承链找**最近**（继承深度最小）的匹配规则；都没匹配则退回默认规则。
- 受检异常默认**提交**，这是 EJB 时代的约定（受检异常被视为可预期的业务结果）。阿里规约等普遍要求显式 `rollbackFor = Exception.class`。
- Spring 6.2 起可以在 `@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)` 全局改为所有异常都回滚。
- 手动回滚而不抛异常：`TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()`。

## 失效场景大全

| # | 场景 | 根因 |
| --- | --- | --- |
| 1 | 同类方法自调用 `this.txMethod()` | 没经过代理，见 [AOP 与代理机制](#/spring/aop) |
| 2 | 方法非 public | 5.x 的 `AnnotationTransactionAttributeSource` 只认 public；6.0 起 CGLIB 代理支持 protected/包可见，**接口代理仍只认 public**，private 永远不行 |
| 3 | 方法 `final` / `static` | CGLIB 无法重写 |
| 4 | 类不是 Spring Bean（自己 `new` 的） | 没有代理 |
| 5 | 异常被 catch 吞掉 | 拦截器看不到异常，正常提交 |
| 6 | 抛出受检异常且未配 `rollbackFor` | 默认规则不回滚 |
| 7 | 传播行为设成 `SUPPORTS`/`NOT_SUPPORTED`/`NEVER` | 本身就不开事务 |
| 8 | 方法内开新线程/线程池执行 SQL | 新线程拿不到 ThreadLocal 中的连接，自动提交 |
| 9 | 多数据源，事务管理器与 SQL 用的数据源不一致 | `bindResource` 的 key 是 DataSource，查不到就用新连接 |
| 10 | 在 `@PostConstruct` 中调用 | 代理尚未生成，且是 `this` 调用 |
| 11 | 外层切面 `@Order` 在事务内层并吞了异常 | 异常没传到 `TransactionInterceptor` |
| 12 | 数据库/表不支持事务（MyISAM） | 存储引擎层面无事务 |
| 13 | 动态数据源在事务开启后才切换 | 连接在 `doBegin` 时已固定，后续切换无效 |

> [!TIP] 快速判断事务是否生效
> 在方法里打印 `TransactionSynchronizationManager.isActualTransactionActive()` 与 `getCurrentTransactionName()`；或把 `org.springframework.jdbc`、`org.springframework.transaction` 日志调到 DEBUG，可以看到 *Creating new transaction*、*Participating in existing transaction*、*Initiating transaction rollback* 等关键日志。

## 事务提交后再做副作用

在事务中直接发 MQ / 删缓存 / 调用外部服务会出现两类不一致：**消息发出后事务回滚**（下游处理了不存在的数据）；**消息先于提交被消费**（下游查不到数据）。正确做法是挂到提交之后：

```java
// 方式一：注册同步回调（5.3+ 接口方法均有默认实现，TransactionSynchronizationAdapter 已废弃）
@Transactional(rollbackFor = Exception.class)
public void pay(Long orderId) {
    orderMapper.markPaid(orderId);
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override public void afterCommit() {
            mqTemplate.send("order-paid", orderId);   // 仅在提交成功后执行
            redis.delete("order:" + orderId);
        }
    });
}

// 方式二：事件 + @TransactionalEventListener（默认 phase = AFTER_COMMIT）
@TransactionalEventListener(fallbackExecution = true)  // 无事务时也执行，否则事件被静默丢弃
public void onPaid(OrderPaidEvent e) { ... }
```

> [!WARNING] afterCommit 里的数据库写操作
> `afterCommit` 执行时原事务已提交，但连接资源还绑定在线程上，此时用 `REQUIRED` 执行的写 SQL 会"参与"一个已经结束的事务，**不会被提交**。需要写库请用 `REQUIRES_NEW`。另外 afterCommit 失败无法回滚业务数据，可靠性要求高的消息应使用**本地消息表**或 RocketMQ 事务消息，见 [消息队列核心问题](#/mw/mq) 与 [缓存设计与一致性](#/redis/cache)。

## 大事务问题与拆分

大事务 = 持有数据库连接和行锁的时间过长。危害：

- 连接池被占满，其他请求获取连接超时；
- 行锁持有时间长，锁等待、死锁概率上升（见 [锁机制与死锁分析](#/mysql/lock)）；
- undo log 膨胀、长事务阻碍 purge，主从复制延迟（大事务 binlog 一次性写出）；
- 回滚代价大。

| 治理手段 | 做法 |
| --- | --- |
| 事务里不做远程调用 | RPC、HTTP、发 MQ、上传文件全部移出事务或放到 afterCommit |
| 查询放事务外 | 校验、组装数据先做完，事务里只保留写操作 |
| 缩小事务边界 | 用 `TransactionTemplate` 只包住必须原子的几行，而不是整个方法 |
| 批量操作分批提交 | 10 万条更新分成每批 500～1000 条各自提交，结合断点续跑 |
| 设置超时 | `@Transactional(timeout = 5)`，超时后下一条 SQL 执行前抛 `TransactionTimedOutException` |
| 监控 | `information_schema.innodb_trx` 查长事务；连接池活跃连接数告警 |

```java
@Service
public class OrderAppService {
    private final TransactionTemplate tx;

    public void submit(OrderCmd cmd) {
        Product p = productClient.get(cmd.productId());   // 远程调用：事务外
        Order order = Order.create(cmd, p);                // 计算：事务外
        tx.executeWithoutResult(status -> {                // 只包住写库
            orderMapper.insert(order);
            stockMapper.deduct(cmd.productId(), cmd.count());
        });
        mq.send(new OrderCreated(order.getId()));          // 已提交：事务外
    }
}
```

`TransactionTemplate` 继承 `DefaultTransactionDefinition`，可 `setPropagationBehavior`、`setTimeout`、`setReadOnly`；回调中抛 `RuntimeException` 自动回滚，或调用 `status.setRollbackOnly()`。它不依赖代理，**天然没有自调用问题**。

## 只读事务

`@Transactional(readOnly = true)` 的实际效果取决于实现：

- JDBC：`DataSourceUtils` 调用 `con.setReadOnly(true)`，MySQL Connector/J 据此可把语句标记为只读；开启 `enforceReadOnly` 时会显式执行 `SET TRANSACTION READ ONLY`，InnoDB 对只读事务可省去分配事务 ID 等开销。
- JPA/Hibernate：Session 设置为 `FlushMode.MANUAL`，不做脏检查，大查询明显省内存。
- 读写分离：自定义 `AbstractRoutingDataSource`，在 `determineCurrentLookupKey` 中根据 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()` 路由到从库。注意路由发生在**取连接时**，配合 `LazyConnectionDataSourceProxy` 才能保证在只读标记设置之后才真正取连接。
- 只读事务里执行写操作，MySQL 会报错（`Cannot execute statement in a READ ONLY transaction`）。

## 多数据源事务

- 每个数据源一个事务管理器，用 `@Transactional(transactionManager = "orderTxManager")` 指定；Boot 只自动配置一个，存在多个 `DataSource` 时要自己声明并给默认的加 `@Primary`。
- **单个本地事务无法跨数据源保证原子性**。曾经的 `ChainedTransactionManager`（按顺序提交多个事务管理器）在 Spring Data 中已废弃，它只是"尽力而为"，第二个提交失败时第一个已无法回滚。
- 真正需要跨库原子性：JTA/XA（Atomikos、Narayana，性能代价高）或 Seata AT/TCC，更常见的是用最终一致性（本地消息表、事务消息）。见 [分布式事务](#/distributed/transaction)。

## 关键参数

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `propagation` | `REQUIRED` | 传播行为 |
| `isolation` | `DEFAULT` | 使用数据库默认（MySQL InnoDB 为 REPEATABLE READ）；修改隔离级别只对新开启的事务生效 |
| `timeout` | -1（不限） | 秒；只在执行 SQL 时检查，纯 Java 代码耗时不会被打断 |
| `readOnly` | false | 只读提示 |
| `rollbackFor` / `noRollbackFor` | 空 | 回滚规则 |
| `transactionManager` / `value` | 空 | 多事务管理器时指定 |
| `label` | 空 | 5.3+ 新增，可供自定义事务管理器使用 |

## 生产实践与踩坑

- **事务方法里 `try/catch` 记日志后不抛**：数据部分写入、部分失败却提交了。要么重新抛出，要么 `setRollbackOnly()`。
- **事务 + 分布式锁的顺序**：锁必须包在事务外层（先加锁 → 开事务 → 提交 → 释放锁）。如果在事务内释放锁，提交前另一个线程就可能拿到锁并读到旧数据。
- **事务内 `select` 再 `update` 的并发问题**：RR 下普通 `select` 是快照读，读到的可能不是最新值，扣库存要用 `update ... set stock = stock - ? where stock >= ?` 或 `select ... for update`。
- **事务中调用 `@Async` 方法**：异步线程不在事务中，且可能在事务提交前执行查询读不到数据，应改为提交后再触发。
- **测试中的 `@Transactional`**：`@SpringBootTest` 测试方法上的事务默认回滚，看起来"写进去了又没了"属于正常现象。

## 相关阅读

- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：跨服务一致性：Outbox 与 Saga
- [分布式事务](#/distributed/transaction)：分布式事务方案

## 面试追问

> [!QUESTION] Spring 是如何保证 Service 和 Mapper 用的是同一个数据库连接的？
> 事务管理器 `doBegin` 时从数据源取连接、关闭自动提交，以 DataSource 为 key 绑定到 `TransactionSynchronizationManager` 的 ThreadLocal；MyBatis/JdbcTemplate 通过 `DataSourceUtils.getConnection` 先查 ThreadLocal，有就复用。所以事务的边界是"同一线程 + 同一数据源"。

> [!QUESTION] REQUIRED 内层方法抛异常、外层 catch 了，为什么还会报错回滚？
> 内层不是事务发起者，只能把共享事务标记为 rollback-only；外层提交时检测到标记，执行回滚并抛 `UnexpectedRollbackException`。这是为了避免外层在不知情的情况下提交了一个内层认为应失败的事务。

> [!QUESTION] NESTED 和 REQUIRES_NEW 的区别？
> `REQUIRES_NEW` 挂起外层、使用新连接开启独立事务，内层提交后外层回滚也不影响内层；`NESTED` 使用同一连接的保存点，内层失败只回滚到保存点，但外层回滚会连同内层一起回滚。`NESTED` 需要 JDBC 3.0 保存点支持，JPA 事务管理器默认不支持。

> [!QUESTION] 事务里发 MQ 有什么问题？怎么解决？
> 发送在提交前，事务回滚则消息成为"脏消息"；即使不回滚，消费者也可能在提交前消费而查不到数据。用 `afterCommit` / `@TransactionalEventListener` 保证提交后发送；要求不丢消息则用本地消息表或事务消息，并在消费端做幂等。

> [!QUESTION] @Transactional 加在接口上和实现类上有什么区别？
> Spring 推荐加在实现类（或其方法）上。在接口上的注解，早期版本只对 JDK 接口代理生效，CGLIB 代理可能识别不到；新版本虽然对接口注解的查找做了增强，但为避免代理模式不同导致的行为差异，团队规范仍应统一加在实现类上。

> [!QUESTION] 如何排查线上"事务没回滚"？
> 先确认是否走了代理（日志中有无 *Creating new transaction*、打印 `isActualTransactionActive`）；再确认异常类型与 `rollbackFor`、是否被切面或代码吞掉；再查 SQL 是否在其他线程或其他数据源上执行；最后检查表引擎与连接是否被设置了 autocommit。
