---
level: 进阶
tags: [Spring MVC, DispatcherServlet, 拦截器, 异常处理, Tomcat 调优]
summary: 沿着一个 HTTP 请求从 Tomcat 线程进入 DispatcherServlet，到参数解析、消息转换、异常处理与线程模型调优
---

# Spring MVC 请求链路

> [!ABSTRACT] 核心要点
> - 所有请求进入唯一的前端控制器 `DispatcherServlet#doDispatch`：`HandlerMapping` 找处理器和拦截器链 → `HandlerAdapter` 执行 → 处理返回值 / 异常 → 完成回调。
> - `@RequestBody`/`@ResponseBody` 由 `RequestResponseBodyMethodProcessor` 处理，背后是 `HttpMessageConverter`（JSON 默认 Jackson）；普通参数靠一组 `HandlerMethodArgumentResolver`。
> - 执行顺序从外到内：**Filter（Servlet 规范）→ DispatcherServlet → Interceptor（MVC）→ AOP（方法代理）→ Controller**；越往内能拿到的信息越具体，越往外覆盖范围越广。
> - `@ControllerAdvice` 只能处理 DispatcherServlet 内部抛出的异常，Filter 中的异常要自己处理或交给 Boot 的 `/error`。
> - 吞吐瓶颈常在 Tomcat 工作线程：默认 `threads.max=200`、`max-connections=8192`、`accept-count=100`；阻塞 IO 多的服务可考虑异步请求或 Boot 3.2+ 的虚拟线程。

## 组件全景

`DispatcherServlet` 在初始化（`onRefresh` → `initStrategies`）时从容器中查找九大组件，找不到就用 `DispatcherServlet.properties` 中的默认实现：

| 组件 | 主要实现 | 作用 |
| --- | --- | --- |
| `HandlerMapping` | `RequestMappingHandlerMapping`、`RouterFunctionMapping`、`SimpleUrlHandlerMapping` | 请求 → `HandlerExecutionChain`（handler + 拦截器） |
| `HandlerAdapter` | `RequestMappingHandlerAdapter`、`HandlerFunctionAdapter`、`HttpRequestHandlerAdapter` | 以统一方式调用不同类型的 handler |
| `HandlerExceptionResolver` | `ExceptionHandlerExceptionResolver`、`ResponseStatusExceptionResolver`、`DefaultHandlerExceptionResolver` | 异常 → 响应 |
| `ViewResolver` | `ThymeleafViewResolver`、`InternalResourceViewResolver` | 视图名 → View（前后端分离后基本不用） |
| `LocaleResolver`、`ThemeResolver`、`MultipartResolver`、`FlashMapManager`、`RequestToViewNameTranslator` | — | 国际化、主题、文件上传等 |

`RequestMappingHandlerMapping` 在启动时（`afterPropertiesSet` → `initHandlerMethods`）遍历所有带 `@Controller` 的 Bean，把每个 `@RequestMapping` 方法注册进 `MappingRegistry`。请求到来时先按路径直接匹配，再做模式匹配，最后按 HTTP 方法、`params`、`headers`、`consumes`、`produces` 条件挑出最佳匹配。

> [!NOTE] Spring 6 / Boot 3 的路径匹配变化
> - 默认使用 `PathPatternParser`（预解析的路径模式，比 `AntPathMatcher` 更快），`**` 只能出现在模式末尾。
> - **默认不再匹配末尾斜杠**：`/users/` 不再匹配 `@GetMapping("/users")`，升级时常见 404。
> - 后缀模式匹配（`/users.json`）在 5.3 已默认关闭。

## DispatcherServlet#doDispatch

<figure class="fig">
<svg viewBox="0 0 760 430" class="dg" role="img" aria-label="DispatcherServlet doDispatch 的处理步骤以及与 HandlerMapping、HandlerAdapter 等组件的协作">
<rect class="b" x="20" y="16" width="90" height="40" rx="8"/>
<text class="tb" x="65" y="36" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b1" x="140" y="16" width="130" height="40" rx="8"/>
<text class="tb" x="205" y="36" text-anchor="middle" dominant-baseline="middle">Filter 链</text>
<rect class="bf" x="300" y="16" width="260" height="40" rx="8"/>
<text class="tw" x="430" y="36" text-anchor="middle" dominant-baseline="middle">DispatcherServlet#doDispatch</text>
<line class="l" x1="110" y1="36" x2="140" y2="36" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="36" x2="300" y2="36" marker-end="url(#arr)"/>
<rect class="b" x="300" y="80" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="98" text-anchor="middle" dominant-baseline="middle">① getHandler()</text>
<text class="ts" x="285" y="102" text-anchor="end">匹配得到 HandlerExecutionChain</text>
<rect class="b" x="300" y="130" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="148" text-anchor="middle" dominant-baseline="middle">② getHandlerAdapter()</text>
<text class="ts" x="285" y="152" text-anchor="end">找到支持该 handler 的适配器</text>
<rect class="b3" x="300" y="180" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="198" text-anchor="middle" dominant-baseline="middle">③ applyPreHandle()</text>
<text class="ts" x="285" y="202" text-anchor="end">拦截器 preHandle 正序，false 即终止</text>
<rect class="b2" x="300" y="230" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="248" text-anchor="middle" dominant-baseline="middle">④ ha.handle()</text>
<text class="ts" x="285" y="252" text-anchor="end">参数解析 → 调用 → 返回值处理</text>
<rect class="b3" x="300" y="280" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="298" text-anchor="middle" dominant-baseline="middle">⑤ applyPostHandle()</text>
<text class="ts" x="285" y="302" text-anchor="end">postHandle 倒序，有异常则跳过</text>
<rect class="b" x="300" y="330" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="348" text-anchor="middle" dominant-baseline="middle">⑥ processDispatchResult()</text>
<text class="ts" x="285" y="344" text-anchor="end">异常 → HandlerExceptionResolver</text>
<text class="ts" x="285" y="360" text-anchor="end">有视图 → ViewResolver 渲染</text>
<rect class="b3" x="300" y="380" width="260" height="36" rx="6"/>
<text class="tm" x="430" y="398" text-anchor="middle" dominant-baseline="middle">⑦ triggerAfterCompletion()</text>
<text class="ts" x="285" y="402" text-anchor="end">afterCompletion 倒序，用于清理</text>
<line class="l" x1="430" y1="56" x2="430" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="116" x2="430" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="166" x2="430" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="216" x2="430" y2="230" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="266" x2="430" y2="280" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="316" x2="430" y2="330" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="366" x2="430" y2="380" marker-end="url(#arr)"/>
<rect class="b1" x="590" y="80" width="160" height="36" rx="6"/>
<text class="tm" x="670" y="98" text-anchor="middle" dominant-baseline="middle">HandlerMapping</text>
<rect class="b1" x="590" y="130" width="160" height="36" rx="6"/>
<text class="tm" x="670" y="148" text-anchor="middle" dominant-baseline="middle">HandlerAdapter</text>
<line class="ld" x1="560" y1="98" x2="590" y2="98" marker-end="url(#arr)"/>
<line class="ld" x1="560" y1="148" x2="590" y2="148" marker-end="url(#arr)"/>
<rect class="bg" x="580" y="180" width="170" height="236" rx="10"/>
<text class="ts" x="592" y="198">handle() 内部</text>
<rect class="b2" x="592" y="208" width="146" height="34" rx="6"/>
<text class="tm" x="665" y="225" text-anchor="middle" dominant-baseline="middle">ArgumentResolver</text>
<rect class="b2" x="592" y="260" width="146" height="34" rx="6"/>
<text class="t" x="665" y="277" text-anchor="middle" dominant-baseline="middle">反射调用 Controller</text>
<rect class="b2" x="592" y="312" width="146" height="34" rx="6"/>
<text class="tm" x="665" y="329" text-anchor="middle" dominant-baseline="middle">ReturnValueHandler</text>
<rect class="b2" x="592" y="364" width="146" height="34" rx="6"/>
<text class="tm" x="665" y="381" text-anchor="middle" dominant-baseline="middle">MessageConverter</text>
<line class="l" x1="665" y1="242" x2="665" y2="260" marker-end="url(#arr)"/>
<line class="l" x1="665" y1="294" x2="665" y2="312" marker-end="url(#arr)"/>
<line class="l" x1="665" y1="346" x2="665" y2="364" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="248" x2="580" y2="248" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：doDispatch 主流程；琥珀色为拦截器回调点，右侧为 handle() 内部协作的组件</figcaption>
</figure>

```java
// Spring 6 DispatcherServlet#doDispatch（节选）
HandlerExecutionChain mappedHandler = null;
try {
    ModelAndView mv = null;
    Exception dispatchException = null;
    try {
        processedRequest = checkMultipart(request);
        mappedHandler = getHandler(processedRequest);           // ① 遍历 HandlerMapping
        if (mappedHandler == null) { noHandlerFound(processedRequest, response); return; }
        HandlerAdapter ha = getHandlerAdapter(mappedHandler.getHandler()); // ②
        if (!mappedHandler.applyPreHandle(processedRequest, response)) {  // ③
            return;                                             // 内部已触发 afterCompletion
        }
        mv = ha.handle(processedRequest, response, mappedHandler.getHandler()); // ④
        if (asyncManager.isConcurrentHandlingStarted()) { return; }       // 异步请求：先释放线程
        applyDefaultViewName(processedRequest, mv);
        mappedHandler.applyPostHandle(processedRequest, response, mv);    // ⑤
    } catch (Exception ex) {
        dispatchException = ex;
    } catch (Throwable err) {
        dispatchException = new ServletException("Handler dispatch failed: " + err, err);
    }
    processDispatchResult(processedRequest, response, mappedHandler, mv, dispatchException); // ⑥
} catch (Exception ex) {
    triggerAfterCompletion(processedRequest, response, mappedHandler, ex);  // ⑦
}
```

注意拦截器的"对称性"：只有 `preHandle` 返回 true 的拦截器才会执行 `afterCompletion`（`HandlerExecutionChain` 记录了 `interceptorIndex`），所以在 `preHandle` 中设置的 `ThreadLocal` 应在 `afterCompletion` 中清理。

## 参数解析与返回值处理

`RequestMappingHandlerAdapter#invokeHandlerMethod` 把 `HandlerMethod` 包装成 `ServletInvocableHandlerMethod`：

```java
// ServletInvocableHandlerMethod#invokeAndHandle（节选）
Object returnValue = invokeForRequest(webRequest, mavContainer, providedArgs);
//   └─ getMethodArgumentValues：对每个参数遍历 HandlerMethodArgumentResolverComposite
//      supportsParameter() 命中后 resolveArgument()，结果按 MethodParameter 缓存
//   └─ doInvoke：method.invoke(bean, args)  —— bean 可能是 AOP 代理
this.returnValueHandlers.handleReturnValue(returnValue, getReturnValueType(returnValue), mavContainer, webRequest);
```

| 注解 / 类型 | 参数解析器 | 数据来源 |
| --- | --- | --- |
| `@RequestParam`、简单类型无注解 | `RequestParamMethodArgumentResolver` | query string / 表单 |
| `@PathVariable` | `PathVariableMethodArgumentResolver` | URI 模板变量 |
| `@RequestBody` | `RequestResponseBodyMethodProcessor` | 请求体 → `HttpMessageConverter` 反序列化 |
| `@RequestHeader`、`@CookieValue` | 对应 Resolver | 请求头 / Cookie |
| POJO 无注解 | `ServletModelAttributeMethodProcessor` | 按属性名从参数绑定（`WebDataBinder`） |
| `HttpServletRequest`、`Principal` 等 | `ServletRequestMethodArgumentResolver` | Servlet API |

返回值同理：`@ResponseBody`（`@RestController` 隐含）由同一个 `RequestResponseBodyMethodProcessor` 处理，根据请求 `Accept` 与 converter 支持的媒体类型做**内容协商**，选中 `MappingJackson2HttpMessageConverter` 写出 JSON，并把 `mavContainer.setRequestHandled(true)`——后续不再走视图解析。

> [!TIP] 扩展点选择
> 自定义参数注入（如 `@CurrentUser User user`）实现 `HandlerMethodArgumentResolver` 并在 `WebMvcConfigurer#addArgumentResolvers` 注册；统一响应包装用 `ResponseBodyAdvice`；全局 JSON 配置优先改 `spring.jackson.*` 或定义 `Jackson2ObjectMapperBuilderCustomizer`，**不要自己 new 一个 `ObjectMapper` Bean 覆盖**，否则会丢掉 Boot 的默认模块配置（如 JavaTimeModule）。

## Filter、Interceptor 与 AOP

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="Filter、DispatcherServlet、Interceptor、AOP 代理与 Controller 的嵌套执行层次">
<rect class="bg" x="10" y="10" width="700" height="280" rx="12"/>
<text class="ts" x="24" y="30">Tomcat 工作线程（Servlet 容器）</text>
<rect class="b1" x="30" y="40" width="660" height="240" rx="10"/>
<text class="tb" x="44" y="60">Filter：Servlet 规范，拿到原始请求/响应，可包装 body、改编码、鉴权</text>
<rect class="b2" x="50" y="72" width="620" height="196" rx="10"/>
<text class="tb" x="64" y="92">DispatcherServlet：Spring MVC 唯一入口，异常处理从这里开始生效</text>
<rect class="b3" x="70" y="104" width="580" height="152" rx="10"/>
<text class="tb" x="84" y="124">HandlerInterceptor：知道目标 HandlerMethod，拿不到解析后的参数</text>
<rect class="b5" x="90" y="136" width="540" height="108" rx="10"/>
<text class="tb" x="104" y="156">AOP 代理：@Around / @Transactional，拿到方法入参与返回值</text>
<rect class="b" x="110" y="168" width="500" height="64" rx="8"/>
<text class="tb" x="360" y="190" text-anchor="middle" dominant-baseline="middle">Controller 方法</text>
<text class="ts" x="360" y="214" text-anchor="middle">参数已由 ArgumentResolver 绑定、校验</text>
</svg>
<figcaption>图 2：从外到内的执行层次；请求逐层进入，响应逐层退出</figcaption>
</figure>

| 维度 | Filter | HandlerInterceptor | AOP |
| --- | --- | --- | --- |
| 规范 | Servlet（`jakarta.servlet.Filter`） | Spring MVC | Spring AOP |
| 作用范围 | 所有进入容器的请求（含静态资源、`/error`） | 被 DispatcherServlet 映射到 handler 的请求 | 任意 Spring Bean 的方法 |
| 能拿到 | `ServletRequest/Response` | request、response、`HandlerMethod`、`ModelAndView` | 方法参数、返回值、异常 |
| 能否改请求体 | 能（`HttpServletRequestWrapper` 缓存 body） | 不方便 | 改的是对象，不是报文 |
| 异常能否被 `@ControllerAdvice` 处理 | **不能** | 能 | 能 |
| 典型场景 | 跨域、编码、TraceId 注入、XSS 过滤、请求日志 | 登录态校验、权限、接口限流 | 事务、审计日志、方法耗时 |

> [!WARNING] 读取请求体的坑
> `request.getInputStream()` 只能读一次。在 Filter 中打印 body 必须用 `ContentCachingRequestWrapper`（注意它是在**下游读取时**才缓存，Filter 中要在 `chain.doFilter` 之后再取）或自定义 Wrapper 先缓存再重放。

Boot 中注册 Filter：`@Component` 的 Filter 会自动注册并拦截 `/*`；需要指定 URL 或顺序用 `FilterRegistrationBean`。继承 `OncePerRequestFilter` 可避免在 forward/error 分发时重复执行。

## 异常处理链

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> biz(BizException e) {
        return ResponseEntity.status(e.httpStatus()).body(Result.fail(e.code(), e.getMessage()));
    }
    @ExceptionHandler(MethodArgumentNotValidException.class)          // @RequestBody 校验失败
    public Result<Void> invalid(MethodArgumentNotValidException e) {
        FieldError fe = e.getBindingResult().getFieldError();
        return Result.fail(400, fe == null ? "参数错误" : fe.getField() + " " + fe.getDefaultMessage());
    }
    @ExceptionHandler(Exception.class)
    public Result<Void> unknown(Exception e) {
        log.error("unhandled", e);
        return Result.fail(500, "系统繁忙");
    }
}
```

`processHandlerException` 按顺序询问 `HandlerExceptionResolver`：

1. `ExceptionHandlerExceptionResolver`：先找 Controller 自身的 `@ExceptionHandler`，再按 `@ControllerAdvice` 的 `@Order` 顺序查找；同一个 Advice 内按**异常继承距离最近**匹配。
2. `ResponseStatusExceptionResolver`：处理 `@ResponseStatus` 注解的异常和 `ResponseStatusException`。
3. `DefaultHandlerExceptionResolver`：把框架异常映射为状态码（如 `HttpRequestMethodNotSupportedException` → 405）。
4. 都处理不了：异常抛给 Servlet 容器，Boot 通过错误页转发到 `/error`，由 `BasicErrorController` 输出默认 JSON。

> [!NOTE] Spring 6 的 ProblemDetail
> Spring 6 支持 RFC 7807（后续 RFC 9457）错误响应格式：`ProblemDetail`、`ErrorResponse` 接口，`ResponseEntityExceptionHandler` 可直接继承。Boot 3 中 `spring.mvc.problemdetails.enabled=true` 即可让框架异常输出 `application/problem+json`。

## 参数校验

| 场景 | 写法 | 失败时异常 |
| --- | --- | --- |
| `@RequestBody` 对象 | `@Valid @RequestBody UserDTO dto` | `MethodArgumentNotValidException` |
| 表单/查询参数对象 | `@Valid UserQuery q` | `BindException`（5.3 起 `MethodArgumentNotValidException` 是它的子类） |
| 单个参数 `@NotBlank String name` | 类上加 `@Validated`（走 `MethodValidationPostProcessor` 代理） | `ConstraintViolationException` |
| 6.1+ 内置方法校验 | Controller 方法参数直接带约束注解 | `HandlerMethodValidationException` |
| 分组校验 | `@Validated(Create.class)` | 同上 |
| 嵌套对象 / 集合元素 | 字段上加 `@Valid`，`List<@Valid Item>` | 同上 |

Boot 3 需要引入 `spring-boot-starter-validation`（2.3 起 web starter 不再自带），注解包为 `jakarta.validation.constraints`。

## 异步请求

Servlet 3.0 异步让 Tomcat 工作线程在等待期间释放：

```java
@GetMapping("/orders/{id}/result")
public DeferredResult<Result<Order>> poll(@PathVariable Long id) {
    DeferredResult<Result<Order>> dr = new DeferredResult<>(5000L, Result.fail(504, "timeout"));
    pending.put(id, dr);            // 由 MQ 消费者 / 回调线程 dr.setResult(...) 完成
    dr.onCompletion(() -> pending.remove(id));
    return dr;
}

@GetMapping("/report")
public Callable<byte[]> report() {
    return () -> reportService.generate();   // 在 MVC 的 AsyncTaskExecutor 中执行
}
```

| 类型 | 谁来完成结果 | 适用 |
| --- | --- | --- |
| `Callable` / `WebAsyncTask` | MVC 的 `AsyncTaskExecutor`（Boot 使用自动配置的 `applicationTaskExecutor`） | 耗时计算，避免占用 Tomcat 线程 |
| `DeferredResult` | 任意其他线程 | 长轮询、等待外部事件 |
| `ResponseBodyEmitter` / `SseEmitter` | 任意线程多次推送 | 流式输出、服务端推送（如大模型流式响应） |
| `CompletableFuture` | 异步链 | 编排多个远程调用 |

流程：`handle()` 返回后 `isConcurrentHandlingStarted()` 为 true，`doDispatch` 直接返回、工作线程回池；结果就绪后容器以 `ASYNC` 类型**再次分发**到 DispatcherServlet 完成渲染。拦截器在第一次分发后回调 `AsyncHandlerInterceptor#afterConcurrentHandlingStarted` 而非 `postHandle`。超时用 `spring.mvc.async.request-timeout`。

> [!WARNING] 异步不等于更快
> 异步只是把等待从 Tomcat 线程转移到别的线程或事件上，总处理能力取决于下游。`Callable` 使用的执行器如果是无界线程/队列，会把压力从 Tomcat 转成 OOM。

## 内嵌 Tomcat 线程模型与调优

Tomcat NIO Connector（Boot 默认 `Http11NioProtocol`）：

- **Acceptor** 线程：`accept()` 新连接，连接数达到 `max-connections` 后停止接收，新连接留在操作系统 TCP 全连接队列（长度约为 `accept-count`），队列也满则客户端连接超时或被拒；
- **Poller** 线程：用 Selector 监听已建立连接的读事件，数据就绪后把任务交给 Executor；
- **Executor 工作线程**：执行 Filter → Servlet → 业务代码，**阻塞 IO 期间线程被占用**。

| 配置 | 默认值 | 含义与建议 |
| --- | --- | --- |
| `server.tomcat.threads.max` | 200 | 工作线程上限。CPU 密集型接近核数×(1~2)，IO 密集型可提高到数百，需压测确定 |
| `server.tomcat.threads.min-spare` | 10 | 常驻线程数 |
| `server.tomcat.max-connections` | 8192 | NIO 同时保持的连接数（含 keep-alive 空闲连接） |
| `server.tomcat.accept-count` | 100 | 连接数满后的排队长度（backlog，还受内核 `somaxconn` 限制） |
| `server.tomcat.connection-timeout` | 未设置时取 Tomcat 默认 | 建连后等待请求数据的超时 |
| `server.tomcat.keep-alive-timeout` / `max-keep-alive-requests` | 同 connection-timeout / 100 | 长连接空闲超时与复用次数 |
| `server.tomcat.max-swallow-size`、`max-http-form-post-size` | 2MB | 请求体大小限制 |
| `spring.threads.virtual.enabled` | false | Boot 3.2+、JDK 21：Tomcat 使用虚拟线程执行请求 |

> [!TIP] 调大线程数前先看线程在干什么
> 线程池打满时 `jstack` 统计 Tomcat `http-nio-*-exec-*` 线程的栈：大量 `WAITING` 在 `HikariPool.getConnection` 说明瓶颈是连接池；`RUNNABLE` 在 `SocketInputStream.read` 是下游慢。此时加线程只会把压力传给下游。Actuator 指标 `tomcat.threads.busy`、`tomcat.threads.config.max` 可做告警。线程池通用原理见 [线程池原理与调优](#/java/concurrency/pool)。

## WebFlux 简述与选型

WebFlux 基于 Reactor（`Mono`/`Flux`）与 Reactor Netty 事件循环，少量线程处理大量并发连接，**全链路必须非阻塞**（R2DBC、WebClient、Reactive Redis）。

| 维度 | Spring MVC | Spring WebFlux |
| --- | --- | --- |
| 编程模型 | 同步阻塞，一请求一线程 | 异步非阻塞，响应式流 |
| 运行时 | Tomcat/Jetty/Undertow | Netty（也可运行在 Servlet 3.1+ 容器） |
| 生态 | JDBC、MyBatis、JPA 全兼容 | 需要 R2DBC 等响应式驱动 |
| 调试 | 栈清晰 | 栈难读，需 `checkpoint()`/Reactor 调试工具 |
| 适合 | 绝大多数 CRUD 业务 | 网关、推送、高并发 IO 聚合（Spring Cloud Gateway 即基于它） |

> [!CAUTION] 在 WebFlux 中阻塞
> 在 event loop 线程中调用 JDBC、`Thread.sleep`、同步 HTTP 客户端，会让少量的 IO 线程全部卡死，整个服务失去响应。不可避免的阻塞调用要 `subscribeOn(Schedulers.boundedElastic())`。JDK 21 虚拟线程普及后，"为了吞吐量改用 WebFlux"的理由已大大减弱。Netty 线程模型见 [IO 模型与 Netty](#/infra/netty)。

## 生产实践与踩坑

- **升级 Boot 3 后 404**：末尾斜杠不再匹配；`javax.servlet` 改为 `jakarta.servlet`，旧的 Filter 依赖不兼容。
- **Long 精度丢失**：雪花 ID 等 Long 超过 JS 安全整数（2^53），前端显示错误。用 `@JsonSerialize(using = ToStringSerializer.class)` 或全局把 Long 序列化成字符串。
- **时间格式**：`LocalDateTime` 返回成数组或时区错误，统一配置 `spring.jackson.date-format`、`time-zone`，或使用 ISO-8601。
- **拦截器里的 ThreadLocal 未清理**：Tomcat 线程复用，下一个请求读到上一个用户的信息，必须在 `afterCompletion` 中 `remove()`。
- **大文件上传**：`spring.servlet.multipart.max-file-size`/`max-request-size` 默认 1MB/10MB，超限异常在进入 Controller 前抛出，需在 Advice 中处理 `MaxUploadSizeExceededException`。
- **`@RequestBody` 用在 GET 上**：部分代理/网关会丢弃 GET 请求体，规范上也不推荐。

## 相关阅读

- [Web 安全：OWASP 常见漏洞与防护](#/security/web)：Web 漏洞：XSS、CSRF、越权
- [认证授权：Session、JWT、OAuth2 与 Spring Security](#/security/auth)：过滤器链与认证授权

## 面试追问

> [!QUESTION] 描述一个请求在 Spring MVC 中的完整处理流程。
> Tomcat 工作线程执行 Filter 链 → `DispatcherServlet#doDispatch`：`HandlerMapping` 得到 handler 和拦截器链 → 找 `HandlerAdapter` → 拦截器 `preHandle` → 参数解析器解析参数并反射调用 Controller（可能经过 AOP 代理）→ 返回值处理器 + 消息转换器写响应 → `postHandle` → 异常处理或视图渲染 → `afterCompletion`。

> [!QUESTION] 为什么需要 HandlerAdapter？
> handler 的形态多样：`@RequestMapping` 方法、`HttpRequestHandler`、函数式 `HandlerFunction`、旧式 `Controller` 接口。适配器模式让 DispatcherServlet 用统一接口调用它们，新增 handler 类型只需新增适配器，符合开闭原则。

> [!QUESTION] Filter 和 Interceptor 的区别？各自适合做什么？
> Filter 属于 Servlet 规范，在 DispatcherServlet 之外，作用于所有请求，能包装请求响应，适合编码、跨域、TraceId、请求日志；Interceptor 属于 MVC，能拿到目标 HandlerMethod，适合登录、权限校验。Filter 抛出的异常不会进入 `@ControllerAdvice`。

> [!QUESTION] Tomcat 最多能同时处理多少请求？超过会怎样？
> 同时执行的请求数受 `threads.max` 限制；同时保持的连接数受 `max-connections` 限制，超出后新连接在内核队列等待（约 `accept-count`），队列满则连接被拒或超时。真正"同时处理"的上限是工作线程数，其余请求在 Executor 队列或连接层排队。

> [!QUESTION] DeferredResult 是如何做到不占用 Tomcat 线程的？
> Controller 返回 `DeferredResult` 后，MVC 调用 `request.startAsync()` 开启 Servlet 异步模式，`doDispatch` 直接返回、线程归还线程池，响应保持打开。其他线程调用 `setResult` 时触发 `AsyncContext.dispatch()`，容器重新分发请求到 DispatcherServlet，用已有结果走返回值处理并写出响应。
