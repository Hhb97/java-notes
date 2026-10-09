---
level: 进阶
tags: [Spring AI, LangChain4j, ChatClient, VectorStore, Tool Calling, MCP, 流式, 对话记忆]
summary: 用 Java 生态落地大模型应用：Spring AI 的 ChatClient、Advisor、VectorStore、工具调用与 MCP，LangChain4j 的 AiServices 声明式接口，两者对比，以及一个完整的企业知识库问答服务示例。
---

# Java 实战：Spring AI 与 LangChain4j

> [!ABSTRACT] 核心要点
> - **Spring AI**：Spring 官方项目，沿用 Spring Boot 风格（starter、自动配置、`application.yml`），提供 **ChatClient、EmbeddingModel、VectorStore、工具调用、对话记忆、Advisor（拦截器）、MCP** 等统一抽象，屏蔽不同模型厂商差异。
> - **LangChain4j**：社区主导的 Java LLM 库，核心是 **`AiServices` 声明式接口**（写一个 Java 接口 + 注解，框架生成实现），也有 Spring Boot 集成，**不依赖 Spring**。
> - 选型：已是 Spring 技术栈、希望与 Boot 生态一致 → **Spring AI**；偏好接口式 AI 服务、需要在非 Spring 环境使用 → **LangChain4j**。两者能力高度重叠，**核心抽象相同**：模型、提示词、记忆、检索、工具。
> - 框架帮你省去样板代码，但**检索质量、提示词、评测、护栏**仍然要自己负责，见 [RAG 原理与完整流水线](#/ai/rag)。
> - 先用**最小可用**（ChatClient + 向量库 + 工具）打通链路，再按评测结果增量引入重排、查询改写等。

> [!NOTE] 版本与 API 变化
> 这两个框架迭代很快，**类名、包名、配置项在版本间有调整**（例如 LangChain4j 的模型接口命名、Spring AI 的 Advisor/记忆相关 API）。本页示例以**概念与典型写法**为主，落地时请以所用版本的官方文档为准。

## 总体对照

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Java 大模型应用的分层：业务接口、框架抽象、模型与向量库适配">
<rect class="b1" x="20" y="20" width="720" height="62" rx="10"/>
<text class="th" x="380" y="42" text-anchor="middle">业务层：Controller / Service（REST、SSE 流式接口）</text>
<text class="ts" x="380" y="64" text-anchor="middle">鉴权 · 会话管理 · 限流 · 审计 · 业务规则</text>
<rect class="b3" x="20" y="102" width="350" height="120" rx="10"/>
<text class="th" x="195" y="126" text-anchor="middle">Spring AI</text>
<text class="ts" x="195" y="152" text-anchor="middle">ChatClient · Advisor（记忆/RAG/日志）</text>
<text class="ts" x="195" y="172" text-anchor="middle">VectorStore · EmbeddingModel</text>
<text class="ts" x="195" y="192" text-anchor="middle">@Tool 工具 · MCP Client/Server</text>
<text class="ts" x="195" y="212" text-anchor="middle">Observation 可观测</text>
<rect class="b5" x="390" y="102" width="350" height="120" rx="10"/>
<text class="th" x="565" y="126" text-anchor="middle">LangChain4j</text>
<text class="ts" x="565" y="152" text-anchor="middle">AiServices 声明式接口</text>
<text class="ts" x="565" y="172" text-anchor="middle">ChatMemory · ContentRetriever</text>
<text class="ts" x="565" y="192" text-anchor="middle">EmbeddingStore · RetrievalAugmentor</text>
<text class="ts" x="565" y="212" text-anchor="middle">@Tool 工具 · 结构化输出</text>
<rect class="b2" x="20" y="242" width="350" height="70" rx="10"/>
<text class="tb" x="195" y="264" text-anchor="middle" dominant-baseline="middle">模型适配</text>
<text class="ts" x="195" y="286" text-anchor="middle">OpenAI 兼容 · Anthropic · 国内模型 · Ollama（本地）</text>
<rect class="b2" x="390" y="242" width="350" height="70" rx="10"/>
<text class="tb" x="565" y="264" text-anchor="middle" dominant-baseline="middle">存储适配</text>
<text class="ts" x="565" y="286" text-anchor="middle">pgvector · Milvus · Redis · ES · Qdrant …</text>
<line class="l" x1="195" y1="82" x2="195" y2="102" marker-end="url(#arr)"/>
<line class="l" x1="565" y1="82" x2="565" y2="102" marker-end="url(#arr)"/>
<line class="l" x1="195" y1="222" x2="195" y2="242" marker-end="url(#arr)"/>
<line class="l" x1="565" y1="222" x2="565" y2="242" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：框架提供统一抽象，屏蔽模型与向量库的差异</figcaption>
</figure>

| 对比项 | Spring AI | LangChain4j |
| --- | --- | --- |
| 风格 | Spring 惯用：Bean、自动配置、Fluent API | 接口 + 注解（AiServices），也可编程式 |
| 依赖 | Spring Boot/Framework | 独立库（有 Spring Boot starter） |
| 对话记忆 | ChatMemory + Advisor | `ChatMemory`（如消息窗口）+ 按用户/会话 ID 管理 |
| RAG | `QuestionAnswerAdvisor`、检索增强 Advisor、`VectorStore` | `ContentRetriever`、`RetrievalAugmentor`、`EmbeddingStore` |
| 工具 | `@Tool` / `ToolCallback`，通过 `ChatClient.tools(...)` | `@Tool`，AiServices 构建时 `.tools(...)` |
| MCP | 提供 MCP Client/Server starter | 提供 MCP 客户端支持（以版本为准） |
| 可观测 | 与 Micrometer 观测集成 | 监听器/可观测集成（以版本为准） |
| 生态 | Spring 官方，企业采用度高 | 社区活跃，文档示例丰富 |

## Spring AI 实战

### 依赖与配置

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.ai</groupId>
      <artifactId>spring-ai-bom</artifactId>
      <version>${spring-ai.version}</version>   <!-- 与 Spring Boot 版本匹配，见官方对照 -->
      <type>pom</type><scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency><groupId>org.springframework.ai</groupId><artifactId>spring-ai-starter-model-openai</artifactId></dependency>
  <dependency><groupId>org.springframework.ai</groupId><artifactId>spring-ai-starter-vector-store-pgvector</artifactId></dependency>
</dependencies>
```

```yaml
spring:
  ai:
    openai:
      base-url: ${LLM_BASE_URL}            # OpenAI 兼容协议即可对接多数国内模型
      api-key: ${LLM_API_KEY}              # 密钥走环境变量/配置中心
      chat:
        options: { model: ${LLM_MODEL}, temperature: 0.2, max-tokens: 800 }
      embedding:
        options: { model: ${EMBED_MODEL} }
    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: COSINE_DISTANCE
        dimensions: 1024
        initialize-schema: true
```

（starter 名称与配置键随版本调整，以官方文档为准。）

### ChatClient：基本调用、流式与结构化输出

```java
@Configuration
class AiConfig {
    @Bean
    ChatClient chatClient(ChatClient.Builder builder) {
        return builder
                .defaultSystem("你是企业内部助手，回答简洁，使用中文。不确定时说不知道。")
                .build();
    }
}

@RestController
@RequiredArgsConstructor
class ChatController {
    private final ChatClient chatClient;

    @GetMapping("/ask")
    String ask(@RequestParam String q) {
        return chatClient.prompt().user(q).call().content();                 // 同步
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    Flux<String> stream(@RequestParam String q) {
        return chatClient.prompt().user(q).stream().content();               // 流式（SSE）
    }

    record OrderIntent(String orderNo, String action) {}
    @GetMapping("/intent")
    OrderIntent intent(@RequestParam String q) {
        return chatClient.prompt().user(q).call().entity(OrderIntent.class); // 结构化输出：自动生成 Schema 并反序列化
    }
}
```

### Advisor：对话记忆与 RAG 的拦截器

**Advisor** 类似 AOP 拦截器：在请求发送前后修改提示词、注入上下文、记录日志。典型用途：

```java
@Bean
ChatClient ragClient(ChatClient.Builder builder, VectorStore vectorStore, ChatMemory memory) {
    return builder
        .defaultAdvisors(
            MessageChatMemoryAdvisor.builder(memory).build(),                 // ① 多轮对话记忆（按会话 ID 取历史）
            QuestionAnswerAdvisor.builder(vectorStore)                        // ② RAG：检索相关片段并注入提示词
                .searchRequest(SearchRequest.builder().topK(6).similarityThreshold(0.6).build())
                .build(),
            new SimpleLoggerAdvisor())                                         // ③ 日志（调试）
        .build();
}

String answer = ragClient.prompt()
        .user(question)
        .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))        // 会话隔离
        .call().content();
```

> [!TIP] 内置 Advisor 只是起点
> 默认的 `QuestionAnswerAdvisor` 是“向量检索 → 拼提示词”的简单实现。要做**混合检索、重排、查询改写、权限过滤、引用返回**，需要自定义检索环节（实现检索增强的组件或自定义 Advisor）。设计原则见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced)。

### VectorStore：入库与检索

```java
@Service
@RequiredArgsConstructor
class KnowledgeService {
    private final VectorStore vectorStore;

    void ingest(Resource file, String docId, List<String> acl) {
        var reader = new TikaDocumentReader(file);                            // 解析 PDF/Word 等
        var splitter = new TokenTextSplitter(500, 150, 5, 10000, true);       // 切分（参数以版本为准）
        List<Document> chunks = splitter.apply(reader.get());
        chunks.forEach(d -> d.getMetadata().putAll(Map.of("docId", docId, "acl", acl)));
        vectorStore.delete(new FilterExpressionBuilder().eq("docId", docId).build());   // 幂等：先删旧版本
        vectorStore.add(chunks);                                              // 内部调用 EmbeddingModel 批量向量化
    }

    List<Document> search(String q, List<String> userGroups) {
        var filter = new FilterExpressionBuilder().in("acl", userGroups.toArray()).build();   // 权限预过滤
        return vectorStore.similaritySearch(
                SearchRequest.builder().query(q).topK(20).filterExpression(filter).build());
    }
}
```

### 工具调用

```java
@Component
class OrderTools {
    @Tool(description = "查询当前用户的订单状态与物流。订单号形如 A1001。")
    OrderView queryOrder(@ToolParam(description = "订单号") String orderNo) {
        long uid = SecurityUtils.currentUserId();                              // 身份来自会话，不来自模型
        return orderService.findByUser(uid, orderNo);
    }

    @Tool(description = "取消未发货订单。这是写操作，调用前必须已向用户确认。")
    String cancelOrder(@ToolParam(description = "订单号") String orderNo) { ... }
}

String reply = chatClient.prompt()
        .user("帮我看下 A1001 到哪了")
        .tools(orderTools)                                                      // 注册工具
        .call().content();                                                      // 框架自动完成“模型请求工具 → 执行 → 回灌”的循环
```

注意：框架默认会**自动执行**模型请求的工具，因此**权限、参数校验、幂等、确认**必须写在工具里；写操作建议采用“先返回待确认信息，由用户确认后再执行”的两阶段设计。更多原则见 [Agent、工具调用与 MCP](#/ai/agent)。

### MCP 集成

- **MCP Client**：引入 MCP client starter，在配置里声明要连接的 MCP Server（stdio 命令或远程 URL），框架把其工具暴露给 `ChatClient`；
- **MCP Server**：引入 MCP server starter（WebMVC/WebFlux），把 `@Tool` 方法暴露为 MCP 工具，供其他 AI 应用/IDE 调用；
- 对外暴露业务能力时，MCP Server 需要接入**认证授权与审计**；
- 具体 starter 与配置项以所用版本官方文档为准。

## LangChain4j 实战

### AiServices：声明式 AI 接口

```java
interface SupportAssistant {

    @SystemMessage("你是电商客服助手。只能依据提供的资料和工具结果回答，不确定就说不知道。")
    @UserMessage("用户问题：{{question}}")
    String answer(@MemoryId String sessionId, @V("question") String question);   // sessionId 隔离对话记忆

    Flux<String> stream(@MemoryId String sessionId, @UserMessage String question);  // 流式（需要流式模型与响应式依赖）

    record Intent(String orderNo, String action) {}
    Intent extract(String text);                                                  // 结构化输出：返回类型即 Schema
}
```

```java
SupportAssistant assistant = AiServices.builder(SupportAssistant.class)
        .chatModel(chatModel)                                                     // 模型（旧版本为 chatLanguageModel）
        .chatMemoryProvider(id -> MessageWindowChatMemory.withMaxMessages(20))    // 每个会话一份滑动窗口记忆
        .contentRetriever(contentRetriever)                                       // RAG：检索增强
        .tools(new OrderTools())                                                   // 工具
        .build();

String reply = assistant.answer("user-42", "我的订单怎么还没发货？");
```

要点：**一个 Java 接口 = 一个 AI 服务**，框架生成动态代理实现：拼装提示词、维护记忆、调用工具、解析输出。

### RAG 组件

```java
EmbeddingStore<TextSegment> store = PgVectorEmbeddingStore.builder()...build();   // 或 Milvus/Redis/ES 等

// 入库
EmbeddingStoreIngestor.builder()
        .documentSplitter(DocumentSplitters.recursive(500, 80))
        .embeddingModel(embeddingModel)
        .embeddingStore(store)
        .build().ingest(documents);

// 检索
ContentRetriever retriever = EmbeddingStoreContentRetriever.builder()
        .embeddingStore(store).embeddingModel(embeddingModel)
        .maxResults(6).minScore(0.6)
        .filter(MetadataFilterBuilder.metadataKey("acl").isIn(userGroups))        // 元数据过滤
        .build();
```

进阶（查询改写、路由、重排）通过 `RetrievalAugmentor` 组合 `QueryTransformer`、`QueryRouter`、`ContentAggregator`（含重排）等组件。

## 完整示例：企业知识库问答服务

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="知识库问答服务的调用链路：网关鉴权、会话、检索、重排、生成、流式返回与日志评测">
<rect class="b" x="20" y="130" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="158" text-anchor="middle" dominant-baseline="middle">前端 / App</text>
<rect class="b1" x="150" y="130" width="120" height="56" rx="8"/>
<text class="tb" x="210" y="150" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="210" y="170" text-anchor="middle">鉴权 · 限流</text>
<rect class="b3" x="300" y="100" width="170" height="116" rx="10"/>
<text class="th" x="385" y="124" text-anchor="middle">问答服务</text>
<text class="ts" x="385" y="148" text-anchor="middle">1 取会话历史 / 改写问题</text>
<text class="ts" x="385" y="168" text-anchor="middle">2 带 ACL 检索 + 重排</text>
<text class="ts" x="385" y="188" text-anchor="middle">3 拼提示词 + 调用模型</text>
<text class="ts" x="385" y="208" text-anchor="middle">4 引用 / 校验 / 流式输出</text>
<rect class="b5" x="510" y="40" width="130" height="50" rx="8"/>
<text class="tb" x="575" y="65" text-anchor="middle" dominant-baseline="middle">向量库 + ES</text>
<rect class="b5" x="510" y="110" width="130" height="50" rx="8"/>
<text class="tb" x="575" y="135" text-anchor="middle" dominant-baseline="middle">Redis 会话记忆</text>
<rect class="b2" x="510" y="180" width="130" height="50" rx="8"/>
<text class="tb" x="575" y="205" text-anchor="middle" dominant-baseline="middle">LLM 网关/模型</text>
<rect class="b4" x="300" y="258" width="340" height="56" rx="8"/>
<text class="tb" x="470" y="278" text-anchor="middle" dominant-baseline="middle">可观测与评测</text>
<text class="ts" x="470" y="298" text-anchor="middle">调用日志 · Token 成本 · 用户反馈 → 评测集</text>
<line class="l" x1="120" y1="158" x2="150" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="158" x2="300" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="125" x2="510" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="150" x2="510" y2="135" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="185" x2="510" y2="205" marker-end="url(#arr)"/>
<line class="ld" x1="385" y1="216" x2="385" y2="258"/>
<text class="ts" x="670" y="70" text-anchor="start">检索</text>
<text class="ts" x="670" y="205" text-anchor="start">生成</text>
</svg>
<figcaption>图 2：知识库问答服务的典型部署链路</figcaption>
</figure>

```java
@Service
@RequiredArgsConstructor
class KbQaService {
    private final ChatClient chatClient;
    private final VectorStore vectorStore;
    private final Reranker reranker;                       // 自己封装的重排客户端
    private final QueryRewriter rewriter;                  // 基于历史改写问题（小模型）

    Flux<ServerSentEvent<Object>> ask(String sessionId, String question, UserCtx user) {
        String standalone = rewriter.rewrite(sessionId, question);                   // 多轮指代消解
        List<Document> recall = vectorStore.similaritySearch(SearchRequest.builder()
                .query(standalone).topK(30)
                .filterExpression(aclFilter(user)).build());                           // 检索时权限过滤
        List<Document> top = reranker.rerank(standalone, recall, 6, 0.3);              // 重排 + 阈值

        if (top.isEmpty()) return Flux.just(sse("answer", "知识库中没有找到相关信息，请换个问法或联系管理员。"));

        String context = IntStream.range(0, top.size())
                .mapToObj(i -> "[%d] 《%s》%s".formatted(i + 1, top.get(i).getMetadata().get("title"), top.get(i).getText()))
                .collect(Collectors.joining("\n\n"));

        Flux<String> tokens = chatClient.prompt()
                .system(s -> s.text(SYSTEM_TEMPLATE).param("docs", context))            // 规则 + 资料
                .user(question)
                .advisors(a -> a.param(ChatMemory.CONVERSATION_ID, sessionId))
                .stream().content();

        return Flux.concat(
                tokens.map(t -> sse("token", t)),
                Flux.just(sse("sources", citations(top))))                              // 流结束后附上引用来源
                .doOnError(e -> log.error("ask failed", e))
                .onErrorResume(e -> Flux.just(sse("error", "服务繁忙，请稍后重试")));
    }
}
```

生产化要点（与上面示例的对应关系）：

| 关注点 | 做法 |
| --- | --- |
| 超时与重试 | 模型调用设超时；对 429/5xx 指数退避重试；多模型降级，见 [限流、熔断与降级](#/distributed/governance) |
| 并发与线程 | 流式用 WebFlux 或虚拟线程，避免占满 Tomcat 线程（见 [Java 8–21 新特性](#/java/modern/features)） |
| 会话记忆存储 | Redis（带 TTL），按会话 ID 隔离；限制历史长度并做摘要 |
| 密钥与配置 | 环境变量/配置中心；不同环境不同模型与参数；提示词模板外置、版本化 |
| 观测 | 记录问题、检索结果、提示词、答案、Token、耗时，接入 Micrometer/OpenTelemetry，见 [LLM 应用工程化、安全与评测](#/ai/llmops) |
| 成本 | 缓存、小模型做改写/路由、限制 `max-tokens` 和检索长度 |

## 本地模型与私有化部署

数据不能出域时：

| 方案 | 说明 |
| --- | --- |
| **Ollama** | 本机一键运行开源模型，开发/小规模使用，两个框架都有对接 |
| **vLLM** | 高吞吐推理服务（PagedAttention、连续批处理），提供 OpenAI 兼容接口，生产常用 |
| 其他推理引擎 | llama.cpp、TGI、SGLang 等 |
| 硬件 | 需要 GPU；显存大小限制模型规模与并发（量化可降低显存） |

因为都暴露 **OpenAI 兼容接口**，应用侧只需修改 `base-url` 与模型名，业务代码基本不变。需要评估：模型效果是否满足、GPU 成本、运维复杂度、与云端模型的**混合路由**（敏感数据走本地，通用任务走云端）。

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| 升级版本后编译报错 | 框架 API 变动较快，锁定版本并阅读迁移说明 |
| 流式接口被 Nginx 缓冲成一次性返回 | `proxy_buffering off`；`X-Accel-Buffering: no`；调大超时 |
| 并发上来后线程耗尽 | 同步调用占用线程，改用响应式/虚拟线程，并限流 |
| 向量库写入慢 | 批量 embedding 与批量写入；限制并发；使用异步入库管道 |
| 工具被重复调用 | 工具幂等；检测重复参数；限制单次对话的工具调用次数 |
| 记忆越来越长导致变慢 | 摘要压缩、滑动窗口；按会话设置过期 |
| 结构化输出偶尔解析失败 | 使用厂商结构化输出能力；失败重试并回传错误；定义清晰的 record/枚举 |

## 面试追问

> [!QUESTION] Spring AI 的核心抽象有哪些？Advisor 是做什么的？
> ChatClient（对话调用）、EmbeddingModel、VectorStore、工具调用、ChatMemory 和 MCP 支持。Advisor 类似拦截器，在请求发送前后增强：注入对话记忆、检索增强（RAG）、日志、护栏等，便于把横切关注点从业务代码中拆出。

> [!QUESTION] Spring AI 与 LangChain4j 如何选择？
> 已有 Spring Boot 技术栈、想要自动配置与 Spring 一致体验，选 Spring AI；喜欢用接口加注解声明 AI 服务、需要在非 Spring 环境使用，可选 LangChain4j。二者概念一致，关键是检索质量、提示词和评测。

> [!QUESTION] 在 Java 里如何做好 LLM 流式输出？
> 用 SSE 返回 Flux，Spring MVC/WebFlux 均可；注意反向代理关闭缓冲和超时设置，客户端断开要取消上游请求，使用响应式或虚拟线程避免线程被长连接占满，并在流结束后聚合内容用于日志与计费。

> [!QUESTION] 框架自动执行工具有什么风险？怎么控制？
> 模型可能传入非法或越权参数、重复调用写操作。应在工具内用会话身份鉴权、做参数校验和幂等，写操作采用确认机制，限制工具调用次数与可用工具集，并记录审计日志。

> [!QUESTION] 如何在 Java 服务里接入私有化部署的模型？
> 用 vLLM 或 Ollama 提供 OpenAI 兼容接口，应用侧只改 base-url 和模型名；评估 GPU 资源、并发与延迟，必要时做敏感数据走本地、通用任务走云端的混合路由，并保留回退策略。
