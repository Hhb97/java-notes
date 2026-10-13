---
level: 进阶
tags: [MyBatis, Executor, MapperProxy, 插件, 缓存, SQL 注入]
summary: 从 Mapper 接口代理到 Executor/StatementHandler 四大对象，讲透缓存、插件、批量写入与 Spring 整合中的线程安全问题
---

# MyBatis 原理与实践

> [!ABSTRACT] 核心要点
> - Mapper 接口没有实现类：`MapperProxy`（JDK 动态代理）把"接口全限定名 + 方法名"作为 statement id，转成 `SqlSession` 调用。
> - 一条 SQL 的执行链：`SqlSession` → `Executor`（缓存、批处理）→ `StatementHandler`（创建 Statement）→ `ParameterHandler`（设参数）→ JDBC → `ResultSetHandler`（映射结果）。插件就是对这**四大对象**做 JDK 代理。
> - 一级缓存是 SqlSession 级，**在 Spring 中只有同一事务内才生效**；二级缓存是 namespace 级，多表关联和多实例部署下极易读到脏数据，生产一般关闭。
> - `#{}` 预编译占位符，`${}` 字符串拼接有 SQL 注入风险；排序字段等只能用 `${}` 的场景必须白名单校验。
> - 大批量写入优先 `ExecutorType.BATCH` + MySQL `rewriteBatchedStatements=true`，或分批的 `foreach` 多值插入；`SqlSessionTemplate` 是线程安全的，原生 `DefaultSqlSession` 不是。

## 分层架构

<figure class="fig">
<svg viewBox="0 0 760 380" class="dg" role="img" aria-label="MyBatis 接口层、核心处理层与基础支撑层的组件关系">
<rect class="bg" x="10" y="10" width="740" height="70" rx="10"/>
<text class="ts" x="22" y="32">接口层</text>
<rect class="b1" x="150" y="28" width="150" height="36" rx="6"/>
<text class="t" x="225" y="46" text-anchor="middle" dominant-baseline="middle">Mapper 接口</text>
<rect class="b1" x="340" y="28" width="220" height="36" rx="6"/>
<text class="tm" x="450" y="46" text-anchor="middle" dominant-baseline="middle">MapperProxy / MapperMethod</text>
<rect class="b1" x="600" y="28" width="140" height="36" rx="6"/>
<text class="tm" x="670" y="46" text-anchor="middle" dominant-baseline="middle">SqlSession</text>
<line class="l" x1="300" y1="46" x2="340" y2="46" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="46" x2="600" y2="46" marker-end="url(#arr)"/>
<rect class="bg" x="10" y="96" width="740" height="190" rx="10"/>
<text class="ts" x="22" y="118">核心处理层</text>
<rect class="b3" x="600" y="124" width="140" height="36" rx="6"/>
<text class="tm" x="670" y="142" text-anchor="middle" dominant-baseline="middle">Executor</text>
<rect class="b3" x="360" y="124" width="200" height="36" rx="6"/>
<text class="tm" x="460" y="142" text-anchor="middle" dominant-baseline="middle">StatementHandler</text>
<rect class="b" x="150" y="124" width="170" height="36" rx="6"/>
<text class="tm" x="235" y="142" text-anchor="middle" dominant-baseline="middle">JDBC Statement</text>
<rect class="b3" x="360" y="186" width="200" height="36" rx="6"/>
<text class="tm" x="460" y="204" text-anchor="middle" dominant-baseline="middle">ParameterHandler</text>
<rect class="b3" x="150" y="186" width="170" height="36" rx="6"/>
<text class="tm" x="235" y="204" text-anchor="middle" dominant-baseline="middle">ResultSetHandler</text>
<text class="ts" x="604" y="200">CachingExecutor 装饰</text>
<text class="ts" x="604" y="216">Simple/Reuse/Batch</text>
<rect class="b2" x="150" y="240" width="170" height="36" rx="6"/>
<text class="tm" x="235" y="258" text-anchor="middle" dominant-baseline="middle">Configuration</text>
<rect class="b2" x="360" y="240" width="200" height="36" rx="6"/>
<text class="tm" x="460" y="258" text-anchor="middle" dominant-baseline="middle">MappedStatement</text>
<rect class="b2" x="600" y="240" width="140" height="36" rx="6"/>
<text class="tm" x="670" y="258" text-anchor="middle" dominant-baseline="middle">BoundSql</text>
<line class="l" x1="670" y1="64" x2="670" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="142" x2="560" y2="142" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="142" x2="320" y2="142" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="160" x2="460" y2="186" marker-end="url(#arr)"/>
<line class="l" x1="235" y1="160" x2="235" y2="186" marker-end="url(#arr)"/>
<rect class="bg" x="10" y="300" width="740" height="66" rx="10"/>
<text class="ts" x="22" y="322">基础支撑层</text>
<rect class="b" x="150" y="316" width="110" height="36" rx="6"/>
<text class="t" x="205" y="334" text-anchor="middle" dominant-baseline="middle">数据源/连接池</text>
<rect class="b" x="270" y="316" width="110" height="36" rx="6"/>
<text class="t" x="325" y="334" text-anchor="middle" dominant-baseline="middle">事务管理</text>
<rect class="b" x="390" y="316" width="110" height="36" rx="6"/>
<text class="t" x="445" y="334" text-anchor="middle" dominant-baseline="middle">一/二级缓存</text>
<rect class="b" x="510" y="316" width="110" height="36" rx="6"/>
<text class="t" x="565" y="334" text-anchor="middle" dominant-baseline="middle">TypeHandler</text>
<rect class="b" x="630" y="316" width="110" height="36" rx="6"/>
<text class="t" x="685" y="334" text-anchor="middle" dominant-baseline="middle">反射/日志</text>
</svg>
<figcaption>图 1：MyBatis 分层架构；琥珀色是可被插件拦截的四大对象，绿色是启动期解析出的配置元数据</figcaption>
</figure>

启动期：`SqlSessionFactoryBuilder` 用 `XMLConfigBuilder`/`XMLMapperBuilder` 把全局配置和 Mapper XML（以及注解）解析进唯一的 `Configuration`。每条 SQL 解析为一个 `MappedStatement`（id、`SqlSource`、`ResultMap`、缓存配置等），以 `namespace.id` 为 key 存在 `mappedStatements` 中。

## 核心对象与执行流程

| 对象 | 生命周期 | 职责 |
| --- | --- | --- |
| `SqlSessionFactory` | 应用级单例 | 持有 `Configuration`，创建 SqlSession |
| `SqlSession`（`DefaultSqlSession`） | 一次请求/事务，**非线程安全** | 对外 API：`selectOne/insert/commit` |
| `Executor` | 随 SqlSession | 一级缓存、事务提交、批处理 |
| `StatementHandler` | 每次执行 | 创建 `Statement`、设置超时与 fetchSize、执行 |
| `ParameterHandler` | 每次执行 | 用 `TypeHandler` 给 `?` 赋值 |
| `ResultSetHandler` | 每次执行 | `ResultSet` → 对象，处理 `resultMap`、嵌套映射、延迟加载 |

```java
// MyBatis 3.5 Configuration#newExecutor（节选）
public Executor newExecutor(Transaction transaction, ExecutorType executorType) {
    Executor executor;
    if (ExecutorType.BATCH == executorType) {
        executor = new BatchExecutor(this, transaction);
    } else if (ExecutorType.REUSE == executorType) {
        executor = new ReuseExecutor(this, transaction);
    } else {
        executor = new SimpleExecutor(this, transaction);
    }
    if (cacheEnabled) {                          // 全局二级缓存开关，默认 true
        executor = new CachingExecutor(executor);    // 装饰器模式
    }
    return (Executor) interceptorChain.pluginAll(executor);   // 插件包装
}
```

| Executor | 行为 | 场景 |
| --- | --- | --- |
| `SimpleExecutor`（默认） | 每次执行新建 `PreparedStatement`，用完关闭 | 通用 |
| `ReuseExecutor` | 以 SQL 为 key 缓存 Statement，同一 SqlSession 内复用 | 同一会话重复执行相同 SQL |
| `BatchExecutor` | `addBatch()` 累积，`flushStatements`/commit 时 `executeBatch()`；连续相同 SQL 才合并 | 批量写 |
| `CachingExecutor` | 先查二级缓存，再委托给被装饰的 Executor | 开启 `<cache/>` 的 namespace |

查询主线：`BaseExecutor#query` 先算 `CacheKey`（statementId + offset + limit + SQL + 参数值 + 环境 id）查一级缓存 `localCache`，未命中走 `queryFromDatabase` → `SimpleExecutor#doQuery` → `configuration.newStatementHandler`（同样会被 `pluginAll`）→ `prepare` → `parameterize` → `query` → `resultSetHandler.handleResultSets`。

## Mapper 接口动态代理

```java
// MyBatis 3.5 MapperProxyFactory / MapperProxy（节选）
protected T newInstance(MapperProxy<T> mapperProxy) {
    return (T) Proxy.newProxyInstance(mapperInterface.getClassLoader(),
                                      new Class[] { mapperInterface }, mapperProxy);
}

public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
    if (Object.class.equals(method.getDeclaringClass())) {
        return method.invoke(this, args);          // toString/hashCode 等
    }
    return cachedInvoker(method).invoke(proxy, method, args, sqlSession);
    // 默认方法用 MethodHandle 调用；普通方法 → PlainMethodInvoker → MapperMethod#execute
}

// MapperMethod#execute：按 SqlCommandType 分派
switch (command.getType()) {
    case INSERT -> result = rowCountResult(sqlSession.insert(command.getName(), param));
    case SELECT -> {
        if (method.returnsMany())   result = executeForMany(sqlSession, args);   // selectList
        else if (method.returnsMap()) result = executeForMap(sqlSession, args);
        else if (method.returnsCursor()) result = executeForCursor(sqlSession, args);
        else result = sqlSession.selectOne(command.getName(), param);
    }
    ...
}
```

推论：

- statement id = 接口全限定名 + "." + 方法名，所以 **Mapper 方法不支持重载**；XML 的 `namespace` 必须等于接口全名。
- 多参数时 `ParamNameResolver` 生成 `param1/param2` 与 `@Param` 名，编译时加 `-parameters` 才能直接用参数名。
- `selectOne` 返回多条抛 `TooManyResultsException`；返回基本类型 `int` 而查不到时抛 `BindingException`（null 无法拆箱），返回值用包装类型。

## 缓存

### 一级缓存

- 作用域 `SqlSession`（`localCacheScope=SESSION`，可改为 `STATEMENT` 实际禁用），底层是 `PerpetualCache`（一个 HashMap）。
- 任何 `update/insert/delete`、`commit`、`rollback`、`close` 都会清空；`<select flushCache="true">` 每次清空。

> [!WARNING] Spring 下一级缓存的两个反直觉现象
> 1. **非事务方法中一级缓存不生效**：`SqlSessionTemplate` 每次调用都新建并关闭 SqlSession，连续两次相同查询都会打到数据库。
> 2. **事务内读不到最新值**：同一事务里先查一次，另一个线程/服务修改了数据，再查仍然返回缓存的旧对象（且是**同一个对象引用**，修改返回的对象会污染缓存）。循环轮询状态时尤其要注意，可对该语句设 `flushCache="true"` 或 `localCacheScope=STATEMENT`。

### 二级缓存

- 作用域 namespace，需全局 `cacheEnabled=true`（默认）且在 Mapper 中声明 `<cache/>` 或 `@CacheNamespace`。
- 由 `CachingExecutor` + `TransactionalCacheManager` 实现：查询结果先放在事务暂存区，**SqlSession 提交后才真正写入**，避免读到未提交数据。
- 缓存对象需可序列化（默认 `readOnly=false` 会序列化拷贝）。

| 问题 | 原因 |
| --- | --- |
| 多表查询读到脏数据 | `OrderMapper` 的 join 查询缓存了用户名，`UserMapper` 更新只清自己 namespace 的缓存 |
| 多实例不一致 | 默认缓存在本地 JVM，A 实例更新不会清 B 实例的缓存 |
| 粒度粗 | namespace 内任意写操作清空整个 namespace 缓存，命中率低 |

结论：生产中通常**关闭二级缓存**，用 Redis 在业务层做缓存，失效策略可控（见 [缓存设计与一致性](#/redis/cache)）。

## #{} 与 ${}

| | `#{}` | `${}` |
| --- | --- | --- |
| 处理方式 | 解析为 `?`，由 `PreparedStatement` 设参 | 解析阶段直接**字符串替换** |
| SQL 注入 | 安全 | 有风险 |
| 类型处理 | 走 `TypeHandler`，可指定 `jdbcType` | 无 |
| 能用于 | 值 | 表名、列名、排序方向、`IN` 以外的 SQL 片段 |

```xml
<!-- 动态排序必须用 ${}，务必白名单 -->
<select id="list" resultType="Order">
  SELECT id, amount, created_at FROM t_order
  <where>
    <if test="status != null">AND status = #{status}</if>
    <if test="ids != null and ids.size() > 0">
      AND id IN
      <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
    </if>
  </where>
  ORDER BY ${sortColumn} ${sortDir}   <!-- sortColumn 只能取 Java 端枚举映射后的值 -->
</select>
```

> [!CAUTION] LIKE 查询
> 不要写 `LIKE '%${keyword}%'`。用 `LIKE CONCAT('%', #{keyword}, '%')` 或 `<bind name="kw" value="'%' + keyword + '%'"/>` 再 `LIKE #{kw}`；同时注意转义用户输入中的 `%` 和 `_`，否则会被当通配符。

## 动态 SQL

动态 SQL 在启动时解析为 `SqlNode` 树（`IfSqlNode`、`ForEachSqlNode`、`TrimSqlNode`…），包含 `${}` 或动态标签的语句是 `DynamicSqlSource`，每次执行用 OGNL 计算条件、拼出 `BoundSql`；纯静态语句是 `RawSqlSource`，启动时就生成好。

常用标签：`<if>`、`<choose>/<when>/<otherwise>`、`<where>`（去掉多余 AND/OR）、`<set>`（去掉末尾逗号）、`<trim>`、`<foreach>`、`<bind>`、`<sql>/<include>`。

> [!WARNING] OGNL 的数字与空字符串比较
> `<if test="status != null and status != ''">`，当 `status` 是 `Integer 0` 时，OGNL 会把 `''` 当作 0 比较，`0 != ''` 结果为 **false**，条件被跳过，查询结果变多。数字类型只判断 `!= null`。

`<where>` 全部条件都为空时会生成无条件 SQL——更新/删除语句一旦如此就是全表操作，必须在 Java 侧校验或使用 MyBatis-Plus 的防全表更新插件。

## 插件机制

```java
@Intercepts({@Signature(type = StatementHandler.class, method = "prepare",
                        args = {Connection.class, Integer.class})})
public class SlowSqlInterceptor implements Interceptor {
    public Object intercept(Invocation inv) throws Throwable {
        long start = System.nanoTime();
        try {
            return inv.proceed();                    // 调用下一层（另一个插件代理或原始对象）
        } finally {
            StatementHandler sh = (StatementHandler) inv.getTarget();
            long ms = (System.nanoTime() - start) / 1_000_000;
            if (ms > 500) log.warn("slow sql {}ms: {}", ms, sh.getBoundSql().getSql());
        }
    }
}
```

| 可拦截对象 | 可拦截方法 |
| --- | --- |
| `Executor` | `update`、`query`、`flushStatements`、`commit`、`rollback`、`getTransaction`、`close`、`isClosed` |
| `StatementHandler` | `prepare`、`parameterize`、`batch`、`update`、`query` |
| `ParameterHandler` | `getParameterObject`、`setParameters` |
| `ResultSetHandler` | `handleResultSets`、`handleOutputParameters` |

```java
// MyBatis 3.5 InterceptorChain#pluginAll + Plugin#wrap（节选）
public Object pluginAll(Object target) {
    for (Interceptor interceptor : interceptors) {
        target = interceptor.plugin(target);       // 默认实现即 Plugin.wrap(target, this)
    }
    return target;
}
public static Object wrap(Object target, Interceptor interceptor) {
    Map<Class<?>, Set<Method>> signatureMap = getSignatureMap(interceptor);
    Class<?>[] interfaces = getAllInterfaces(target.getClass(), signatureMap);
    if (interfaces.length > 0) {                   // 只有声明拦截的接口才生成代理
        return Proxy.newProxyInstance(type.getClassLoader(), interfaces,
                                      new Plugin(target, interceptor, signatureMap));
    }
    return target;
}
```

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="多个插件层层包裹 Executor 形成代理链，以及 PageHelper 的分页拦截流程">
<text class="ts" x="20" y="24">pluginAll(target)：每个拦截器包一层 JDK 代理</text>
<rect class="b1" x="20" y="40" width="400" height="230" rx="10"/>
<text class="t" x="34" y="62">Plugin → InterceptorC（最后注册，最先执行）</text>
<rect class="b2" x="40" y="76" width="360" height="178" rx="10"/>
<text class="t" x="54" y="98">Plugin → InterceptorB</text>
<rect class="b3" x="60" y="112" width="320" height="126" rx="10"/>
<text class="t" x="74" y="134">Plugin → InterceptorA（最先注册）</text>
<rect class="b" x="80" y="150" width="280" height="68" rx="8"/>
<text class="tb" x="220" y="176" text-anchor="middle" dominant-baseline="middle">原始 Executor</text>
<text class="ts" x="220" y="198" text-anchor="middle">CachingExecutor → SimpleExecutor</text>
<rect class="bg" x="460" y="10" width="280" height="276" rx="10"/>
<text class="tb" x="472" y="32">PageHelper（PageInterceptor）</text>
<rect class="b5" x="472" y="46" width="256" height="46" rx="6"/>
<text class="tm" x="484" y="64">PageHelper.startPage(1, 20)</text>
<text class="ts" x="484" y="82">分页参数存入 ThreadLocal</text>
<rect class="b5" x="472" y="104" width="256" height="46" rx="6"/>
<text class="tm" x="484" y="122">intercept(Executor.query)</text>
<text class="ts" x="484" y="140">取出分页参数，存在才分页</text>
<rect class="b5" x="472" y="162" width="256" height="46" rx="6"/>
<text class="tm" x="484" y="180">count SQL + LIMIT 改写</text>
<text class="ts" x="484" y="198">先查总数，再按方言拼分页 SQL</text>
<rect class="b4" x="472" y="220" width="256" height="46" rx="6"/>
<text class="tm" x="484" y="238">finally: clearPage()</text>
<text class="ts" x="484" y="256">清理 ThreadLocal，防止污染下次查询</text>
<line class="l" x1="600" y1="92" x2="600" y2="104" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="150" x2="600" y2="162" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="208" x2="600" y2="220" marker-end="url(#arr)"/>
</svg>
<figcaption>图 2：插件以 JDK 代理层层包裹目标对象，后注册的在外层；右侧为 PageHelper 的工作方式</figcaption>
</figure>

> [!WARNING] PageHelper 的 ThreadLocal 陷阱
> `startPage()` 之后**紧跟的第一条查询**才会被分页。如果中间有分支导致没有执行查询，分页参数会留在 ThreadLocal 里，被该线程（Tomcat 线程复用）的下一个无关查询"捡到"，出现莫名其妙的分页或 count 查询。保证 `startPage` 与查询之间没有条件分支，或使用 `PageHelper.startPage(...).doSelectPage(() -> mapper.list())` 的 lambda 形式。

## 批量插入

| 方式 | 原理 | 性能 | 注意 |
| --- | --- | --- | --- |
| 循环单条 insert | 每条一次网络往返 + 一次（自动）提交 | 最慢 | 至少放进一个事务，减少提交次数 |
| `foreach` 多值 `INSERT ... VALUES (...),(...)` | 一条大 SQL | 快 | 受 `max_allowed_packet` 限制；SQL 过长时解析耗时、占位符过多（MySQL 预编译占位符上限 65535），建议每批 500～1000 行 |
| `ExecutorType.BATCH` | JDBC `addBatch/executeBatch` | 配合 `rewriteBatchedStatements=true` 时最快 | 不加该参数时 MySQL 驱动仍逐条发送；`update` 返回值不是真实影响行数 |
| MyBatis-Plus `saveBatch` | 内部即 BATCH 模式，默认每 1000 条 flush | 同上 | 同样需要 `rewriteBatchedStatements=true` |

```java
// BATCH 模式（Spring 环境下用 SqlSessionTemplate 的 BATCH 版本或手动 openSession）
try (SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH)) {
    OrderMapper mapper = session.getMapper(OrderMapper.class);
    for (int i = 0; i < orders.size(); i++) {
        mapper.insert(orders.get(i));
        if ((i + 1) % 1000 == 0) session.flushStatements();   // 分批发送，控制内存
    }
    session.commit();
}
```

> [!NOTE] Spring 事务中切换 ExecutorType
> 同一事务中已经用 SIMPLE 类型创建了 SqlSession 后，再请求 BATCH 类型会抛 *Cannot change the ExecutorType when there is an existing transaction*。批处理逻辑最好放到单独的事务方法中。

## 与 Spring 整合

| 组件 | 作用 |
| --- | --- |
| `SqlSessionFactoryBean` | `FactoryBean`，用 Spring 的 DataSource 构建 `SqlSessionFactory`，事务工厂替换为 `SpringManagedTransactionFactory` |
| `SqlSessionTemplate` | **线程安全**的 SqlSession 实现，所有 Mapper 共享 |
| `MapperFactoryBean` | 每个 Mapper 接口一个，`getObject()` 返回 `sqlSessionTemplate.getMapper()` |
| `MapperScannerConfigurer` | `BeanDefinitionRegistryPostProcessor`，扫描包下接口注册为 `MapperFactoryBean` 类型的 BeanDefinition |
| `@MapperScan` | `MapperScannerRegistrar`（`ImportBeanDefinitionRegistrar`）注册上面的 Configurer |
| Boot starter | `MybatisAutoConfiguration` 自动创建前两者；未写 `@MapperScan` 时扫描自动配置包下带 `@Mapper` 的接口 |

`SqlSessionTemplate` 线程安全的原因：它内部持有一个 `SqlSession` 的 JDK 代理 `sqlSessionProxy`，每次调用由 `SqlSessionInterceptor` 处理：

```java
// mybatis-spring SqlSessionTemplate.SqlSessionInterceptor#invoke（节选）
SqlSession sqlSession = SqlSessionUtils.getSqlSession(sqlSessionFactory, executorType, exceptionTranslator);
// ↑ 有 Spring 事务同步时：从 TransactionSynchronizationManager 取当前事务绑定的 SqlSessionHolder，没有则新建并绑定
//   无事务时：每次新建
try {
    Object result = method.invoke(sqlSession, args);
    if (!SqlSessionUtils.isSqlSessionTransactional(sqlSession, sqlSessionFactory)) {
        sqlSession.commit(true);                 // 非事务：立即提交
    }
    return result;
} finally {
    SqlSessionUtils.closeSqlSession(sqlSession, sqlSessionFactory);  // 事务中只减引用计数
}
```

即：真正的 `DefaultSqlSession` 要么与**当前线程的事务**绑定，要么用完即关，从不跨线程共享。连接则通过 `SpringManagedTransaction` → `DataSourceUtils` 取得，与 `@Transactional` 是同一个，见 [声明式事务原理](#/spring/tx)。

## MyBatis-Plus 简述

- `BaseMapper<T>` 提供通用 CRUD：启动时由 `ISqlInjector` 为每个 Mapper 动态生成 `MappedStatement`，不需要写 XML。
- `LambdaQueryWrapper` 条件构造器避免硬编码列名；`IService`/`ServiceImpl` 提供 `saveBatch`、`page` 等。
- 插件统一到 `MybatisPlusInterceptor`，内置 `PaginationInnerInterceptor`（分页）、`OptimisticLockerInnerInterceptor`（乐观锁）、`BlockAttackInnerInterceptor`（阻止全表更新删除）。
- 逻辑删除、自动填充（创建/更新时间）、多租户。

> [!WARNING] MyBatis-Plus 常见坑
> - `updateById` 默认**忽略 null 字段**（字段策略 `NOT_NULL`），想把字段更新为 null 需要 `UpdateWrapper.set("col", null)` 或修改字段策略。
> - 逻辑删除下唯一索引冲突：已删除记录仍占着唯一键，通常把删除标记设为 id 或删除时间并纳入联合唯一索引。
> - 分页插件需要正确设置数据库类型，否则方言识别错误；`count` 查询在复杂 SQL 上可能很慢，可关闭优化或自定义 count。

## N+1 问题

```xml
<resultMap id="orderWithItems" type="Order">
  <id property="id" column="id"/>
  <!-- 嵌套查询：每条订单再执行一次 selectItemsByOrderId → 1 + N 次查询 -->
  <collection property="items" column="id" select="selectItemsByOrderId"/>
</resultMap>
```

| 解法 | 说明 |
| --- | --- |
| 嵌套结果映射（join） | 一条 `LEFT JOIN` 查出，`<collection>` 内用 `resultMap` 映射；注意一对多分页会被 join 放大，需先分页主表 |
| 应用层批量查询 | 先查订单列表，收集 id，再一次 `IN` 查询明细并在内存中组装（最常用、最可控） |
| 延迟加载 | `lazyLoadingEnabled=true`，用到才查；只是推迟问题，列表遍历时仍是 N+1，还会在序列化时意外触发 |

## 生产实践与踩坑

- **大结果集 OOM**：一次查几十万行进 `List`。用 `Cursor<T>`（需在事务/SqlSession 未关闭期间遍历）或 `ResultHandler` 流式处理；MySQL 驱动需 `fetchSize=Integer.MIN_VALUE` 或 `useCursorFetch=true` 才真正流式。
- **`resultType` 与下划线**：没开 `mapUnderscoreToCamelCase` 时 `created_at` 映射不到 `createdAt`，字段全为 null。
- **`<foreach>` 空集合**：`IN ()` 语法错误，调用前判空。
- **日志打印完整 SQL**：MyBatis 日志打印的是带 `?` 的 SQL 与参数，排查时可用 p6spy 或插件拼接，但**生产勿开**全量 SQL 日志。
- **超时**：`defaultStatementTimeout` 或语句级 `timeout`，防止慢 SQL 长期占用连接；Spring 事务的 `timeout` 也会传递给 MyBatis。

## 相关阅读

- [Web 安全：OWASP 常见漏洞与防护](#/security/web)：SQL 注入与 #{} / ${}
- [EXPLAIN 与 SQL 调优](#/mysql/optimize)：SQL 调优

## 面试追问

> [!QUESTION] Mapper 接口没有实现类，为什么能调用？
> `MapperFactoryBean#getObject` 返回 `MapperProxyFactory` 创建的 JDK 动态代理，`MapperProxy#invoke` 用"接口全限定名.方法名"找到 `MappedStatement`，根据 SQL 类型和返回值类型调用 `SqlSession` 的 `insert/selectList/selectOne` 等方法。

> [!QUESTION] MyBatis 插件的原理？能拦截哪些对象？
> `InterceptorChain#pluginAll` 在创建 `Executor`、`StatementHandler`、`ParameterHandler`、`ResultSetHandler` 时，用 `Plugin.wrap` 对目标对象做 JDK 代理，只有 `@Signature` 声明的方法才进入 `intercept`。多个插件层层包裹，后注册的在外层先执行。PageHelper 拦截 `Executor#query`，从 ThreadLocal 取分页参数，改写 SQL 并执行 count。

> [!QUESTION] 一级缓存和二级缓存的区别？为什么生产不建议用二级缓存？
> 一级缓存 SqlSession 级、默认开启；二级缓存 namespace 级、需要显式配置，由 `CachingExecutor` 实现，提交后才写入。二级缓存在关联查询时无法感知其他 namespace 的更新，多实例部署下各自缓存不一致，且粒度粗，因此一般关闭，改用业务层分布式缓存。

> [!QUESTION] SqlSessionTemplate 为什么是线程安全的？
> 它本身不持有连接和 SqlSession，每次方法调用通过代理拦截，从 `TransactionSynchronizationManager` 获取当前线程事务绑定的 SqlSession，没有就新建并在调用后关闭。不同线程拿到的是不同的 `DefaultSqlSession`。

> [!QUESTION] 批量插入 10 万条数据，怎么做最快？
> 分批（每批 500～1000）+ `ExecutorType.BATCH` + JDBC URL 加 `rewriteBatchedStatements=true`，让驱动改写为多值 insert；或分批的 `foreach` 多值插入。放在事务中减少提交次数，关注 `max_allowed_packet` 与 undo/binlog 体积，必要时分多个事务提交避免大事务。
