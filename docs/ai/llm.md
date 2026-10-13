---
level: 进阶
tags: [LLM, Token, 上下文窗口, Prompt, 结构化输出, 流式, Function Calling, Embedding]
summary: 面向 Java 后端工程师的大模型应用基础：Transformer 推理的工程视角、Token 与上下文窗口、采样参数、提示词与结构化输出、流式调用与 SSE、工具调用协议，以及成本与延迟的构成。
---

# 大模型应用基础与 API 调用

> [!ABSTRACT] 核心要点
> - 把大模型当作一个**无状态、概率性、按 Token 计费的远程函数**：输入是上下文（提示词+历史+检索内容），输出是逐 Token 生成的文本；**每次调用都要把全部历史重新发送**。
> - **Token ≠ 字**：中文通常 1 个汉字约 1~2 个 Token（因分词器而异）；上下文窗口 = **输入 + 输出**的 Token 总上限，超出必须截断、摘要或检索。
> - 应用工程师能掌控的手段：**提示词设计、结构化输出（JSON Schema）、工具调用、检索增强（RAG）、少样本示例、缓存与路由**；模型本身（预训练）不可控。
> - **幻觉不可根除**：只能通过提供依据（RAG）、约束输出格式、要求引用来源、后置校验来降低；关键业务必须有**校验与人工兜底**。
> - 工程上最先要解决的是**延迟（首 Token 时间 TTFT + 生成速度）、成本、稳定性（限流/超时/重试）和安全**，而不是“模型多聪明”。

> [!NOTE] 关于具体数字
> 模型名称、价格、上下文长度、参数默认值**更新很快**，本页只讲不易过时的原理和工程方法；具体数值请以所用厂商的官方文档为准。

## 从工程视角看大模型

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="大模型推理过程：分词、预填充、逐 Token 解码、采样，并使用 KV Cache">
<rect class="b" x="20" y="120" width="110" height="56" rx="8"/>
<text class="tb" x="75" y="140" text-anchor="middle" dominant-baseline="middle">输入文本</text>
<text class="ts" x="75" y="160" text-anchor="middle">提示词 + 历史</text>
<rect class="b1" x="170" y="120" width="100" height="56" rx="8"/>
<text class="tb" x="220" y="140" text-anchor="middle" dominant-baseline="middle">分词</text>
<text class="ts" x="220" y="160" text-anchor="middle">→ Token ID</text>
<rect class="b3" x="310" y="90" width="170" height="116" rx="10"/>
<text class="tb" x="395" y="112" text-anchor="middle" dominant-baseline="middle">Prefill 预填充</text>
<text class="ts" x="395" y="134" text-anchor="middle">并行处理全部输入 Token</text>
<text class="ts" x="395" y="154" text-anchor="middle">计算密集；决定首 Token 延迟</text>
<text class="ts" x="395" y="180" text-anchor="middle">写入 KV Cache</text>
<rect class="b5" x="520" y="90" width="220" height="116" rx="10"/>
<text class="tb" x="630" y="112" text-anchor="middle" dominant-baseline="middle">Decode 解码（循环）</text>
<text class="ts" x="630" y="134" text-anchor="middle">每步产出 1 个 Token</text>
<text class="ts" x="630" y="154" text-anchor="middle">访存密集；决定输出速度</text>
<text class="ts" x="630" y="180" text-anchor="middle">复用 KV Cache，不重复算前文</text>
<line class="l" x1="130" y1="148" x2="170" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="148" x2="310" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="148" x2="520" y2="148" marker-end="url(#arr)"/>
<path class="la" d="M630 206 L630 250 L630 250"/>
<rect class="b2" x="520" y="250" width="220" height="56" rx="8"/>
<text class="tb" x="630" y="270" text-anchor="middle" dominant-baseline="middle">采样：从概率分布选下一个</text>
<text class="ts" x="630" y="290" text-anchor="middle">temperature / top_p / top_k</text>
<line class="la" x1="630" y1="206" x2="630" y2="250" marker-end="url(#arr-a)"/>
<path class="ld" d="M520 278 L440 278 L440 230 L560 230 L560 206"/>
<text class="ts" x="300" y="270" text-anchor="start">新 Token 追加到序列，进入下一轮解码</text>
<text class="ts" x="20" y="320" text-anchor="start">遇到结束标记或达到 max_tokens 停止；输出按 Token 流式返回</text>
</svg>
<figcaption>图 1：推理分两阶段：Prefill 并行处理输入，Decode 逐 Token 生成</figcaption>
</figure>

对应用开发者的启示：

| 现象 | 原因 | 应对 |
| --- | --- | --- |
| 输入越长，**首 Token 越慢** | Prefill 计算量随输入长度增长 | 精简上下文；**提示词缓存（Prompt Caching）** 复用固定前缀 |
| 输出越长越慢，且按输出 Token 计费 | Decode 逐 Token 串行 | 限制 `max_tokens`；要求简洁；流式输出改善体感 |
| 同一问题多次回答不同 | 采样是随机的 | 需要稳定性就降低 temperature，结构化任务设为 0 附近 |
| 长对话后遗忘早期内容、变慢变贵 | 每次请求重传全部历史，且窗口有限 | 历史摘要、滑动窗口、检索式记忆 |
| 模型“知道”但答错 | 参数化知识有截止日期、会幻觉 | 提供外部依据（RAG）、联网检索、工具查询 |

## Token 与上下文窗口

- **Token** 是分词器切分出的子词单位（BPE 等），英文约 4 个字符 ≈ 1 Token，中文每字约 1~2 Token；不同模型分词器不同，**精确计数要用对应的 tokenizer**（如 `tiktoken` 或厂商的计数接口），不要用字符数粗估后卡在上限；
- **上下文窗口**：一次请求中输入+输出的总上限；窗口大 ≠ 都能用好：长上下文里**中间部分的信息召回率常常下降**（“lost in the middle”），重要信息放开头或结尾；
- **费用 = 输入 Token × 单价 + 输出 Token × 单价**（输出通常更贵），多轮对话成本随轮数**近似二次增长**（每轮都重发历史）。

```java
// 粗略估算与硬限制（生产应使用模型对应的分词器计数）
int budget = contextWindow - maxOutputTokens - safetyMargin;
List<Message> trimmed = trimToBudget(history, budget);       // 优先保留：系统提示 + 最近 N 轮 + 关键信息
```

## 调用方式与关键参数

主流厂商（OpenAI、Anthropic、国内大模型）都提供 **HTTP + JSON** 的聊天接口，很多国内模型**兼容 OpenAI 协议**，可用同一套客户端切换：

```json
POST /v1/chat/completions
{
  "model": "xxx",
  "messages": [
    { "role": "system", "content": "你是订单系统的客服助手，只能依据给定资料回答。" },
    { "role": "user",   "content": "我的订单为什么还没发货？订单号 A1001" }
  ],
  "temperature": 0.2,
  "max_tokens": 800,
  "stream": true
}
```

| 参数 | 作用 | 建议 |
| --- | --- | --- |
| `messages`（`system/user/assistant/tool`） | 对话上下文；system 设定角色与规则 | 规则放 system，易变内容放 user |
| `temperature` | 随机性：越低越确定 | 抽取、分类、代码：0~0.3；创作：0.7+ |
| `top_p` / `top_k` | 只在累计概率前 p / 前 k 个候选中采样 | 通常只调 temperature 或 top_p 之一 |
| `max_tokens` | 输出上限 | **必设**，控制成本与延迟 |
| `stop` | 遇到指定字符串停止 | 结构化输出的边界控制 |
| `seed` | 尽量复现（并非绝对） | 测试用 |
| `stream` | 流式返回 | 面向用户的对话必开 |
| `response_format` / JSON Schema | 约束输出结构 | 见下节 |
| `tools` / `tool_choice` | 工具调用 | 见 [Agent、工具调用与 MCP](#/ai/agent) |

## 提示词设计

好的提示词是**清晰的需求文档**，而不是“咒语”：

1. **角色与目标**：你是谁，要完成什么；
2. **约束与边界**：只能依据哪些资料、不确定时怎么办（“不知道就说不知道”）、禁止什么；
3. **输入格式**：用分隔符（XML 标签或 `###`）把指令、资料、用户输入分开，减少混淆与注入；
4. **输出格式**：明确字段与格式，给**1~3 个示例（few-shot）**，效果往往优于长篇说明；
5. **推理引导**：复杂任务让模型先分步分析再给结论（链式思考）；对于有内置推理能力的模型，不必强行要求“一步一步想”；
6. **迭代与评测**：提示词是代码，要**版本管理 + 用评测集回归**，见 [LLM 应用工程化、安全与评测](#/ai/llmops)。

```text
# 示例：带资料的问答提示词
你是公司内部制度问答助手。
<rules>
1. 只能依据 <docs> 中的内容回答；找不到答案时回答“资料中未提及”。
2. 回答末尾用 [编号] 标注引用的资料片段。
3. 不得编造数字、日期与条款。
</rules>
<docs>
[1] 报销制度第 3 条：差旅住宿标准……
[2] ……
</docs>
<question>{{user_question}}</question>
```

> [!WARNING] 提示词不是安全边界
> 在提示词里写“不要泄露系统提示/不要执行危险操作”**挡不住**有针对性的**提示注入**。权限、数据范围和危险动作必须在**代码层**强制校验，见 [LLM 应用工程化、安全与评测](#/ai/llmops)。

## 结构化输出

后端系统要的是**可解析的数据**而不是一段话。三种做法，可靠性递增：

| 方式 | 说明 | 可靠性 |
| --- | --- | --- |
| 提示词要求“输出 JSON” + 解析 | 最简单，偶尔夹杂说明文字或格式错误 | 需要容错与重试 |
| **JSON 模式 / JSON Schema 约束**（`response_format`） | 服务端在解码阶段约束，**保证合法 JSON 并符合 Schema**（支持度因厂商而异） | 高 |
| **工具调用（function calling）作为结构化提取** | 定义一个“提交结果”的函数，其参数 Schema 即输出结构 | 高 |

```java
// 目标：把用户文本抽取成订单查询参数
record OrderQuery(String orderNo, String intent, @Nullable String reason) {}

// 以 Schema 形式约束 → 返回 JSON → 反序列化；任何一步失败都要有兜底
OrderQuery q = llm.chat(prompt).asJson(OrderQuery.class);
if (q.orderNo() == null || !q.orderNo().matches("A\\d{4,}")) throw new NeedClarificationException();   // 代码层再校验
```

要点：**永远不要信任模型输出**——对字段做类型、范围、枚举校验，涉及金额/权限的字段由系统生成或二次确认；校验失败时把错误信息回传模型**重试 1~2 次**（自修复），仍失败走降级。

## 流式输出（SSE）

`stream=true` 时服务端用 **Server-Sent Events** 持续推送增量 Token，首个 Token 到达的时间（TTFT）决定体感，前端边收边显示。

```java
// Spring MVC：把模型的流式响应转发给浏览器（SSE）
@GetMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<String> chat(@RequestParam String q) {
    return chatClient.prompt().user(q).stream().content();     // 返回 Flux<String>，每个元素是一段增量文本
}
```

```text
data: {"choices":[{"delta":{"content":"您"}}]}
data: {"choices":[{"delta":{"content":"的订单"}}]}
...
data: [DONE]
```

工程注意：

- 经过网关/Nginx 时要**关闭响应缓冲**（`proxy_buffering off`，见 [Nginx 与负载均衡](#/infra/nginx)）并调大读超时，否则流被攒成一整块；
- 客户端断开要**及时取消上游请求**（否则继续为你生成并计费）；
- 流式过程中出现错误，要通过事件通知前端，而不是静默中断；
- 内容审核/敏感词过滤若需在输出前拦截，会与流式冲突，需要**分段检查或先缓冲**；
- 记录完整响应（用于日志、评测、计费），需要在流结束后聚合。

## 工具调用（Function Calling）简介

大模型**不能**直接访问你的数据库或接口，但可以**请求你去调用**：你把函数描述（名称、参数 Schema）告诉模型，模型决定“要不要调用、传什么参数”，**由你的代码执行并把结果返回给模型**，模型再据此生成最终回答。

```text
1. 你 → 模型：  问题 + 可用工具 [queryOrder(orderNo)]
2. 模型 → 你：  tool_call: queryOrder({"orderNo":"A1001"})        （模型只产出调用意图）
3. 你：        执行真实函数（鉴权、校验、限流）→ 得到结果
4. 你 → 模型：  tool 消息：{"status":"已发货","logistics":"..."}
5. 模型 → 你：  最终回答：“您的订单已于……发货”
```

这是 **Agent** 的基础机制，完整讨论见 [Agent、工具调用与 MCP](#/ai/agent)。

## Embedding（向量化）

Embedding 模型把文本映射成**固定维度的向量**，**语义相近的文本向量距离更近**，是 [RAG](#/ai/rag)、语义检索、聚类、去重的基础。

- 衡量相似度：**余弦相似度**（最常用）、内积、欧氏距离；向量归一化后余弦等价于内积；
- 维度（如 768、1024、1536、3072）影响存储与检索成本；部分模型支持**降维截断**；
- **查询向量和文档向量要用同一个模型**；换模型要**全量重建向量库**；
- 中文场景选用**中文或多语言表现好的 embedding 模型**；不同模型的相似度分值**不可跨模型比较**；
- 嵌入有**输入长度上限**，长文要先切分。

## 延迟、成本与稳定性

| 维度 | 构成 | 优化手段 |
| --- | --- | --- |
| 延迟 | 网络 + 排队 + **Prefill（随输入长度）** + **Decode（随输出长度）** | 精简上下文、限制输出、流式、选更小更快的模型、就近区域、并行调用独立子任务 |
| 成本 | 输入 Token + 输出 Token（输出更贵） | **提示词缓存**（固定前缀折扣）、历史摘要、**小模型处理简单任务**（路由）、结果缓存、批处理（离线任务用 Batch 接口） |
| 稳定性 | 限流（RPM/TPM）、超时、5xx、内容拒答 | 超时与**指数退避重试**、多模型/多厂商降级、熔断、队列削峰，见 [限流、熔断与降级](#/distributed/governance) |
| 质量 | 模型能力、提示词、上下文质量 | 评测集回归、人工抽检、A/B |

模型选择的务实原则：**先用能力强的模型把效果跑通，再用评测集验证后逐步下沉到更小、更便宜的模型**；对简单分类/抽取任务，小模型往往足够。

## 一次调用的 Java 示例（OpenAI 兼容协议）

```java
HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
String body = """
    {"model":"%s","temperature":0.2,"max_tokens":600,
     "messages":[{"role":"system","content":"%s"},{"role":"user","content":"%s"}]}
    """.formatted(model, escape(system), escape(user));

HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/chat/completions"))
        .timeout(Duration.ofSeconds(60))                          // 读超时要比普通接口长，但必须设置
        .header("Authorization", "Bearer " + apiKey)             // 密钥放配置中心/环境变量，不要入库
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body)).build();

HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
if (resp.statusCode() == 429 || resp.statusCode() >= 500) { /* 指数退避 + 抖动重试，并考虑降级到备用模型 */ }
```

实际项目不必手写 HTTP，使用 **Spring AI / LangChain4j** 等框架，见 [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)。

## 相关阅读

- [AI 应用全景与学习路线（工程师视角）](#/ai/overview)：手段升级阶梯与选型
- [提示词工程进阶与结构化输出](#/ai/prompt-eng)：提示词分层、结构化输出与版本管理

## 面试追问

> [!QUESTION] 大模型的上下文窗口是什么？多轮对话为什么越来越贵？
> 上下文窗口是单次请求可容纳的输入加输出 Token 总量。模型本身无状态，多轮对话每次都要把历史消息重新发送，因此输入 Token 和成本随轮数累积；解决办法是历史摘要、滑动窗口、检索式记忆和提示词缓存。

> [!QUESTION] 如何让大模型稳定输出结构化的 JSON？
> 使用厂商的 JSON Schema / 结构化输出能力或把输出定义成工具调用的参数，在解码阶段约束格式；再在代码层做字段校验，失败时把错误回传让模型重试，最终有降级方案。不要依赖“请输出 JSON”这种纯提示词约束。

> [!QUESTION] 为什么首 Token 延迟和输出速度是两回事？
> 推理分为 Prefill 和 Decode：Prefill 并行处理全部输入，耗时随输入长度增长，决定首 Token 时间；Decode 逐 Token 串行生成，决定输出速度。所以优化首 Token 要缩短输入或缓存前缀，优化总耗时还要限制输出长度。

> [!QUESTION] 如何降低大模型应用的成本？
> 用提示词缓存复用固定前缀；压缩历史和检索内容；按任务难度路由到不同规模的模型；缓存常见问答结果；离线任务使用批处理接口；限制 max_tokens；通过评测集验证后把任务下沉到更小的模型。

> [!QUESTION] 为什么不能依赖提示词来保证安全？
> 提示词只是对模型的软约束，模型可能被注入内容诱导而忽视规则。权限控制、数据范围、危险操作确认和输出校验必须在代码层强制实现，模型只负责理解意图和生成内容。
