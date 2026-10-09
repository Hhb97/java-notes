---
level: 深入
tags: [架构案例, 智能客服, RAG, Agent, 容量规划, 延迟预算, 降级, 评测, 成本模型]
summary: 一个完整的企业级 AI 架构设计案例：以电商智能客服为例，从需求与 SLO、关键决策、总体架构、知识入库、检索、路由、工具与确认流程、上下文预算、安全，到容量/成本估算、降级、评测灰度与落地路线，逐项给出设计细节与取舍。
---

# 案例：企业智能客服与知识库（RAG + Agent）设计详解

> [!ABSTRACT] 本页怎么读
> 这是一份**可直接对照落地的设计文档**示例，不是概念介绍。所有**数字都是明确列出的假设**，用于演示“如何从需求推导设计”；你的业务要替换成自己的数据并用压测校准。
> 设计主线：**先路由、再按需检索/调工具、写操作必确认、全程可观测可降级**。核心结论：
> - **不是所有知识都进向量库**：商品属性、订单这类**结构化数据走工具/SQL**，向量库只放**非结构化文本**（政策、帮助、长描述、历史优质问答），规模从“千万级”降到“百万级”，pgvector 即可。
> - **分层模型**：小模型做路由/改写/分类，大模型只处理复杂回答；**FAQ 缓存与规则命中**拦掉约 1/4 流量。
> - **瓶颈在 LLM 配额与延迟**，而不是向量检索：大促峰值需要**数十 M TPM** 量级，必须多厂商 + 自建兜底 + 降级阶梯。
> - **写操作两阶段**：模型只“提议”，用户确认后由**确定性代码**用幂等键执行。

相关原理见 [RAG 原理与完整流水线](#/ai/rag)、[RAG 检索优化、向量库与评估](#/ai/rag-advanced)、[Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep)、[LLM 应用工程化、安全与评测](#/ai/llmops)。

## 1. 背景、范围与目标

**业务**：某电商平台（自营 + 商家入驻），现有人工客服成本高、高峰排队长。目标：用 AI 客服承接**售前咨询**与**售后常见问题**，复杂问题无缝转人工。

### 功能范围

| 场景 | 示例问题 | 数据/能力来源 |
| --- | --- | --- |
| 政策与规则咨询 | “七天无理由怎么退？”“运费谁承担？” | **知识库**（政策、帮助中心、商家规则） |
| 商品咨询 | “这款手机支持无线充电吗？”“和 B 款比有什么区别？” | **商品库工具**（结构化属性）+ 商品详情文本（RAG） |
| 订单/物流查询 | “我的订单到哪了？”“什么时候发货？” | **订单/物流工具** |
| 售后办理 | “我要退这个订单”“申请换货” | **售后工具**（两阶段确认） |
| 闲聊/无关 | “你好”“你是机器人吗” | 模板/小模型 |
| 转人工 | “我要投诉”“转人工” | 规则触发 + 会话交接 |

**明确不做**：改价/发券/赔付等资金类操作（交给人工）、法律/医疗建议、跨用户数据查询。

### 非功能目标（SLO，设计的约束条件）

| 指标 | 目标 |
| --- | --- |
| 首 Token 延迟（TTFT） | P95 ≤ **1.5 s**；整轮完成 P95 ≤ 8 s |
| 可用性 | 99.9%（含降级后可用） |
| 事实类回答忠实度（答案可被资料支持） | ≥ **95%** |
| 问题解决率（无需转人工） | 上线后 3 个月达到 **60%**（上线前约 0%） |
| 转人工 | 触发后 **3 秒内**完成交接，带完整上下文 |
| 单会话成本 | ≤ **¥0.03**（见成本模型） |
| 数据安全 | 订单/个人信息**严格按登录用户隔离**，不外泄；日志脱敏 |

### 流量假设（演示用）

```text
日均会话          30 万，平均 5 轮 → 150 万轮/天（日均 17 轮/s）
常态峰值（晚高峰） ≈ 150 轮/s     大促峰值 ≈ 400 轮/s
每轮路由占比（预估，需要上线后校准）：
  FAQ/规则/缓存直接命中      25%    （不调用大模型）
  知识问答（RAG）            45%
  订单/售后（工具）          20%
  闲聊/其它                   5%
  直接转人工                  5%
```

## 2. 关键设计决策（ADR 摘要）

| # | 决策 | 备选 | 选择与理由 |
| --- | --- | --- | --- |
| 1 | 知识接入方式 | 微调 / 长上下文 / RAG | **RAG**：政策频繁变更、需要引用溯源、需要按商家/品类控制可见性；微调不擅长记忆事实且更新慢 |
| 2 | 哪些数据进向量库 | 全部入库 / 仅非结构化 | **仅非结构化文本**。商品属性、价格、库存、订单是**精确数据**，向量检索不可靠且会过期，走**工具查询**；向量规模由约 1,100 万降到约 150 万 chunk（见 §8） |
| 3 | Agent 形态 | 多 Agent / 单 Agent / 路由 + 工作流 | **“路由 + 工作流 + 受限 Agent”**：意图分类后进入固定流程；仅订单/售后用有限步数的工具调用 Agent。避免多 Agent 的成本与不确定性，见 [Agent、工具调用与 MCP](#/ai/agent) |
| 4 | 模型分层 | 单一大模型 / 分层 | **分层**：规则 + 小模型做路由、改写、分类；大模型做最终回答与工具决策；对话中 70% 的“简单 RAG”可用中等模型 |
| 5 | 向量库 | pgvector / Milvus / ES | **pgvector（HNSW）+ ES（BM25）**：规模 ~150 万，已有 PG 与 ES 运维能力，元数据过滤与事务一体；**不引入新组件**。数据超过 5,000 万或 QPS 数千再迁 Milvus |
| 6 | 写操作 | 模型直接执行 / 两阶段 | **两阶段确认**：模型生成“预览”，用户点击确认，后端用**幂等键**执行 |
| 7 | 输出形式 | 纯文本 / 富卡片 | 文本流式 + **结构化卡片**（订单、物流、退款预览），关键数据由工具结果直接渲染，**不经模型改写**（防止数字被写错） |
| 8 | 模型接入 | 直连厂商 / 网关 | **模型网关**：多厂商路由、配额、降级、缓存、审计，见 [LLM 应用工程化、安全与评测](#/ai/llmops) |

## 3. 总体架构

<figure class="fig">
<svg viewBox="0 0 780 470" class="dg" role="img" aria-label="智能客服总体架构：接入层、会话与编排服务、路由、知识问答、工具服务、模型网关、数据层、离线管道、观测评测">
<rect class="b" x="20" y="20" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="42" text-anchor="middle" dominant-baseline="middle">App / H5 / 小程序</text>
<text class="ts" x="85" y="62" text-anchor="middle">SSE 流式</text>
<rect class="b1" x="190" y="20" width="150" height="56" rx="8"/>
<text class="tb" x="265" y="42" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="265" y="62" text-anchor="middle">鉴权 · 限流 · 灰度分流</text>
<line class="l" x1="150" y1="48" x2="190" y2="48" marker-end="url(#arr)"/>
<rect class="b3" x="380" y="20" width="380" height="140" rx="12"/>
<text class="th" x="570" y="44" text-anchor="middle">对话编排服务（无状态，Java / Spring Boot）</text>
<rect class="b" x="396" y="58" width="108" height="46" rx="6"/>
<text class="ts" x="450" y="76" text-anchor="middle" dominant-baseline="middle">会话/上下文</text>
<text class="ts" x="450" y="92" text-anchor="middle">预算管理</text>
<rect class="b" x="512" y="58" width="108" height="46" rx="6"/>
<text class="ts" x="566" y="76" text-anchor="middle" dominant-baseline="middle">意图路由</text>
<text class="ts" x="566" y="92" text-anchor="middle">规则+小模型</text>
<rect class="b" x="628" y="58" width="116" height="46" rx="6"/>
<text class="ts" x="686" y="76" text-anchor="middle" dominant-baseline="middle">流程执行器</text>
<text class="ts" x="686" y="92" text-anchor="middle">RAG/工具/确认</text>
<rect class="b" x="396" y="112" width="348" height="36" rx="6"/>
<text class="ts" x="570" y="130" text-anchor="middle" dominant-baseline="middle">护栏：输入脱敏/注入检测 → 输出校验/审核/引用检查 → 降级控制器</text>
<line class="l" x1="340" y1="48" x2="380" y2="48" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="200" width="220" height="100" rx="10"/>
<text class="th" x="130" y="224" text-anchor="middle">知识检索服务</text>
<text class="ts" x="130" y="248" text-anchor="middle">混合检索（向量+BM25）</text>
<text class="ts" x="130" y="268" text-anchor="middle">元数据过滤 · 重排 · 阈值</text>
<text class="ts" x="130" y="288" text-anchor="middle">pgvector + Elasticsearch</text>
<rect class="b5" x="260" y="200" width="220" height="100" rx="10"/>
<text class="th" x="370" y="224" text-anchor="middle">业务工具服务</text>
<text class="ts" x="370" y="248" text-anchor="middle">商品 · 订单 · 物流 · 售后</text>
<text class="ts" x="370" y="268" text-anchor="middle">用户身份透传 · 鉴权 · 幂等</text>
<text class="ts" x="370" y="288" text-anchor="middle">（内部 RPC，经 MCP/网关封装）</text>
<rect class="b4" x="500" y="200" width="260" height="100" rx="10"/>
<text class="th" x="630" y="224" text-anchor="middle">模型网关</text>
<text class="ts" x="630" y="248" text-anchor="middle">多厂商路由 · 配额 · 重试降级</text>
<text class="ts" x="630" y="268" text-anchor="middle">提示词缓存 · 结果缓存 · 计费审计</text>
<text class="ts" x="630" y="288" text-anchor="middle">大模型 / 中模型 / 自建小模型</text>
<line class="l" x1="450" y1="160" x2="130" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="160" x2="370" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="160" x2="630" y2="200" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="330" width="460" height="120" rx="12"/>
<text class="th" x="36" y="354">数据层</text>
<text class="ts" x="36" y="378">PostgreSQL：知识块+向量、会话与消息、工具调用日志、评测集</text>
<text class="ts" x="36" y="398">Elasticsearch：BM25、FAQ、商品检索    Redis：会话状态、缓存、限流</text>
<text class="ts" x="36" y="418">Kafka：对话事件、反馈、审计流    对象存储：原始文档、归档</text>
<text class="ts" x="36" y="438">订单/商品/物流：既有业务库（只通过工具服务访问）</text>
<rect class="bg" x="500" y="330" width="260" height="120" rx="12"/>
<text class="th" x="516" y="354">离线与观测</text>
<text class="ts" x="516" y="378">知识入库管道（解析→切分→向量化）</text>
<text class="ts" x="516" y="398">评测平台（回归门禁）</text>
<text class="ts" x="516" y="418">观测：链路追踪 · Token 成本 · 质量看板</text>
<text class="ts" x="516" y="438">反馈闭环：点踩/转人工 → 评测集</text>
<line class="ld" x1="130" y1="300" x2="130" y2="330"/>
<line class="ld" x1="370" y1="300" x2="370" y2="330"/>
<line class="ld" x1="630" y1="300" x2="630" y2="330"/>
</svg>
<figcaption>图 1：智能客服总体架构：编排服务无状态，检索/工具/模型三类依赖各自隔离、可降级</figcaption>
</figure>

**分层原则**：

1. 编排服务**无状态**（状态在 Redis/PG），水平扩展，滚动发布不丢会话；
2. **检索、工具、模型三类依赖相互隔离**（独立线程池/连接池/熔断），任何一个变慢都不拖垮整体，见 [限流、熔断与降级](#/distributed/governance)；
3. **订单等业务数据只通过工具服务访问**，工具服务负责鉴权（使用**会话中的登录用户 ID**，不是模型传来的参数）；
4. 技术栈沿用团队熟悉的 Java：Spring Boot + WebFlux/虚拟线程 + Spring AI（见 [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)）。

## 4. 一次请求的处理流程与延迟预算

<figure class="fig">
<svg viewBox="0 0 780 400" class="dg" role="img" aria-label="一轮对话的处理流程：鉴权、加载会话、路由，分为 FAQ、RAG、工具三条路径，生成与校验后流式返回，并标注各阶段延迟预算">
<rect class="b" x="20" y="20" width="110" height="46" rx="8"/>
<text class="tb" x="75" y="38" text-anchor="middle" dominant-baseline="middle">用户消息</text>
<text class="ts" x="75" y="56" text-anchor="middle">鉴权 20ms</text>
<rect class="b1" x="160" y="20" width="120" height="46" rx="8"/>
<text class="tb" x="220" y="38" text-anchor="middle" dominant-baseline="middle">加载会话</text>
<text class="ts" x="220" y="56" text-anchor="middle">Redis ≈5ms</text>
<rect class="b3" x="310" y="20" width="150" height="46" rx="8"/>
<text class="tb" x="385" y="38" text-anchor="middle" dominant-baseline="middle">输入护栏 + 路由</text>
<text class="ts" x="385" y="56" text-anchor="middle">规则/小模型 ≈150ms</text>
<line class="l" x1="130" y1="43" x2="160" y2="43" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="43" x2="310" y2="43" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="130" width="200" height="86" rx="10"/>
<text class="th" x="120" y="152" text-anchor="middle">路径 A：FAQ / 规则</text>
<text class="ts" x="120" y="176" text-anchor="middle">ES 精确/相似命中 + 缓存</text>
<text class="ts" x="120" y="196" text-anchor="middle">直接返回标准答案 ≈50ms</text>
<rect class="b5" x="250" y="130" width="270" height="86" rx="10"/>
<text class="th" x="385" y="152" text-anchor="middle">路径 B：知识问答（RAG）</text>
<text class="ts" x="385" y="176" text-anchor="middle">改写(多轮) 150ms → 混合检索 60ms</text>
<text class="ts" x="385" y="196" text-anchor="middle">→ 重排 100ms → 拼装 → LLM 流式</text>
<rect class="b4" x="550" y="130" width="210" height="86" rx="10"/>
<text class="th" x="655" y="152" text-anchor="middle">路径 C：订单/售后工具</text>
<text class="ts" x="655" y="176" text-anchor="middle">LLM 决策调用 → 工具执行</text>
<text class="ts" x="655" y="196" text-anchor="middle">→ 卡片渲染 / 确认流程</text>
<line class="l" x1="340" y1="66" x2="120" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="66" x2="385" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="66" x2="655" y2="130" marker-end="url(#arr)"/>
<rect class="b3" x="150" y="250" width="480" height="46" rx="8"/>
<text class="tb" x="390" y="268" text-anchor="middle" dominant-baseline="middle">输出护栏：引用校验 · 敏感信息/违规审核 · 数字与工具结果一致性</text>
<text class="ts" x="390" y="286" text-anchor="middle">流式输出前先过“前缀安全检查”，结束后再做完整校验</text>
<line class="l" x1="120" y1="216" x2="260" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="216" x2="385" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="655" y1="216" x2="520" y2="250" marker-end="url(#arr)"/>
<rect class="b2" x="150" y="326" width="480" height="50" rx="8"/>
<text class="tb" x="390" y="346" text-anchor="middle" dominant-baseline="middle">SSE 流式返回 + 异步落库（消息、检索证据、Token、耗时、用户反馈）</text>
<text class="ts" x="390" y="364" text-anchor="middle">事件进入 Kafka，用于审计、评测与成本分析</text>
<line class="l" x1="390" y1="296" x2="390" y2="326" marker-end="url(#arr)"/>
</svg>
<figcaption>图 2：三条处理路径与输出护栏，延迟预算见下表</figcaption>
</figure>

### RAG 路径的延迟预算（目标 TTFT P95 ≤ 1.5s）

| 阶段 | 预算 | 手段 |
| --- | --- | --- |
| 网关鉴权 + 限流 | 20 ms | 本地缓存 token 校验 |
| 会话加载 | 5 ms | Redis Hash，一次往返 |
| 输入护栏 + 路由 | 150 ms | 规则优先（关键词/正则命中直接路由），不确定再用**小模型分类**（输出 1 个标签，`max_tokens=5`） |
| 查询改写（仅多轮指代） | 150 ms | **小模型**，且仅在检测到代词/省略时触发（约 30% 的轮次），与路由**并行**执行 |
| 混合检索 | 60 ms | 向量与 BM25 **并行**，各取 Top-30 |
| 重排 | 100 ms | 交叉编码器对 Top-30 精排取 Top-5；超时则直接用 RRF 结果 |
| 提示词拼装 | 10 ms | 预算管理 |
| LLM 首 Token | ≈700 ms | **前缀缓存**（固定的系统规则放前面）；选用低延迟档模型 |
| **合计** | **≈1.2 s** | 留 0.3 s 余量给网络抖动 |

**要点**：每一步都设**独立超时与降级路径**（重排超时跳过、改写超时用原问题、检索超时回答“暂时无法查询”并转人工），并通过**并行化**（路由‖改写，向量‖BM25）压缩关键路径。

## 5. 知识入库管道

### 5.1 数据源与处理策略

| 来源 | 规模（假设） | 处理 | 去向 |
| --- | --- | --- | --- |
| 帮助中心/平台政策（HTML、Word、PDF） | 约 5 万篇 → 20 万 chunk | 结构化切分（按标题层级），保留章节路径与生效时间 | 向量 + BM25 |
| FAQ（人工整理） | 约 2 万条 | **一问一答为一块**；同义问法扩展 | **ES（精确/相似）**为主，同时入向量 |
| 商家自定义规则（运费、售后政策） | 约 30 万 chunk | 按商家隔离（`merchant_id`） | 向量 + BM25，**检索时按商家过滤** |
| 商品详情长文描述（热销前 30 万 SKU） | 约 50 万 chunk | 去除营销噪声，按“卖点/参数/使用说明”切分 | 向量 + BM25 |
| 历史优质客服问答（人工审核通过） | 约 50 万 chunk | 脱敏、去个人信息、提炼“问题-标准答案” | 向量（作为 few-shot 与知识） |
| **商品结构化属性**（300 万 SKU） | — | **不入向量库** | **商品工具**（SQL/ES 精确查询） |
| **订单/物流/售后单** | — | **绝不入向量库** | **订单工具**（实时、带鉴权） |

> [!TIP] 把“精确数据”和“语义知识”分开
> “这款手机电池多大？”应由商品属性接口返回**精确值**，再让模型组织成句；让向量检索去“猜”参数既不准也会因商品更新而过期。

### 5.2 管道与质量门禁

<figure class="fig">
<svg viewBox="0 0 780 330" class="dg" role="img" aria-label="知识入库管道：变更捕获、解析清洗、切分、质量检查、向量化、写入影子索引、评测、切换别名">
<rect class="b" x="20" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">变更捕获</text>
<text class="ts" x="75" y="82" text-anchor="middle">CDC/定时拉取</text>
<rect class="b1" x="150" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="205" y="62" text-anchor="middle" dominant-baseline="middle">解析清洗</text>
<text class="ts" x="205" y="82" text-anchor="middle">去噪·OCR·表格</text>
<rect class="b1" x="280" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="335" y="62" text-anchor="middle" dominant-baseline="middle">切分+元数据</text>
<text class="ts" x="335" y="82" text-anchor="middle">章节·商家·生效期</text>
<rect class="b4" x="410" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="465" y="62" text-anchor="middle" dominant-baseline="middle">质量门禁</text>
<text class="ts" x="465" y="82" text-anchor="middle">长度·重复·敏感</text>
<rect class="b3" x="540" y="40" width="110" height="60" rx="8"/>
<text class="tb" x="595" y="62" text-anchor="middle" dominant-baseline="middle">向量化</text>
<text class="ts" x="595" y="82" text-anchor="middle">批量·限速·重试</text>
<rect class="b5" x="670" y="40" width="90" height="60" rx="8"/>
<text class="tb" x="715" y="62" text-anchor="middle" dominant-baseline="middle">写入索引</text>
<text class="ts" x="715" y="82" text-anchor="middle">pg + ES</text>
<line class="l" x1="130" y1="70" x2="150" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="70" x2="280" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="70" x2="410" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="70" x2="540" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="70" x2="670" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="140" width="740" height="174" rx="12"/>
<text class="th" x="36" y="164">关键设计</text>
<text class="ts" x="36" y="190">① 幂等与增量：以 doc_id + 内容 hash 判断变化；先删旧版本块再写新块（同一事务）；失败可重试；保留 version 便于回滚</text>
<text class="ts" x="36" y="212">② 生效时间：块带 effective_from / effective_to，检索时过滤“当前有效”的政策，避免引用过期规则</text>
<text class="ts" x="36" y="234">③ 影子索引：换切分策略/Embedding 模型时，先构建新索引（影子），跑评测集对比 Recall@K 通过后，用别名/配置原子切换</text>
<text class="ts" x="36" y="256">④ 质量门禁：块长度范围、重复率、乱码比例、敏感信息扫描（手机号/身份证），不合格进隔离区人工处理</text>
<text class="ts" x="36" y="278">⑤ 删除同步：文档下线必须同步删除向量与 BM25 文档，防止“幽灵知识”被引用；每日对账（源文档数 vs 索引文档数）</text>
<text class="ts" x="36" y="300">⑥ Embedding 限速与成本：批量调用、并发上限、失败重试；全量重建按分钟级配额分批，避免挤占线上检索的模型配额</text>
</svg>
<figcaption>图 3：知识入库管道与关键设计点</figcaption>
</figure>

### 5.3 数据模型（PostgreSQL）

```sql
-- 知识文档
CREATE TABLE kb_document (
  doc_id        bigint PRIMARY KEY,
  source        text NOT NULL,               -- help / policy / merchant / product / qa
  merchant_id   bigint,                      -- NULL = 平台通用
  title         text NOT NULL,
  version       int  NOT NULL,
  content_hash  text NOT NULL,
  effective_from timestamptz, effective_to timestamptz,
  status        text NOT NULL DEFAULT 'ONLINE',   -- ONLINE / OFFLINE
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 知识块（含向量）
CREATE TABLE kb_chunk (
  chunk_id     bigserial PRIMARY KEY,
  doc_id       bigint NOT NULL REFERENCES kb_document(doc_id),
  merchant_id  bigint,                       -- 冗余，便于过滤
  category_id  int,
  path         text,                         -- 章节路径："售后政策 > 退款 > 七天无理由"
  content      text NOT NULL,
  token_count  int,
  effective_from timestamptz, effective_to timestamptz,
  embedding    halfvec(1024) NOT NULL        -- 半精度存储，内存减半（视 pgvector 版本支持）
);
CREATE INDEX ON kb_chunk USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 128);
CREATE INDEX ON kb_chunk (merchant_id, category_id);

-- 会话与消息（审计与评测的数据基础）
CREATE TABLE conversation (conv_id bigint PRIMARY KEY, user_id bigint, channel text, started_at timestamptz, handoff boolean DEFAULT false);
CREATE TABLE message (
  msg_id bigint PRIMARY KEY, conv_id bigint, role text, content text,
  route text,                   -- FAQ / RAG / TOOL / CHAT / HANDOFF
  evidence jsonb,               -- 命中的 chunk_id 与分数
  model text, prompt_tokens int, completion_tokens int, ttft_ms int, total_ms int,
  feedback smallint,            -- 1 赞 / -1 踩
  created_at timestamptz DEFAULT now()
) PARTITION BY RANGE (created_at);        -- 按月分区，过期归档，见 PostgreSQL 分区实践

-- 工具调用日志（幂等与审计）
CREATE TABLE tool_call_log (
  call_id text PRIMARY KEY,     -- 幂等键：conv_id + turn + tool + 参数哈希
  conv_id bigint, user_id bigint, tool text, args jsonb, result jsonb, status text, created_at timestamptz DEFAULT now()
);
```

表设计关联 [索引类型与查询优化](#/pg/index)、[复制、高可用与实战](#/pg/ops)。向量规模与内存估算见 §8。

## 6. 检索设计

### 6.1 混合检索与过滤

```sql
-- 向量检索（含元数据与时效过滤）；:q_vec 为问题向量，:mid 为商家 ID
SELECT chunk_id, path, content, 1 - (embedding <=> :q_vec) AS score
FROM kb_chunk
WHERE (merchant_id = :mid OR merchant_id IS NULL)
  AND (effective_from IS NULL OR effective_from <= now())
  AND (effective_to   IS NULL OR effective_to   >  now())
ORDER BY embedding <=> :q_vec
LIMIT 30;                                   -- hnsw.ef_search = 80，兼顾召回与延迟
```

- **BM25（ES）** 并行检索同样的过滤条件，取 Top-30；
- 用 **RRF** 融合（k=60）得到 Top-30 候选，再**交叉编码器重排**取 Top-5；
- **相关度阈值**：重排最高分低于阈值（如 0.35，用评测集标定）→ 判定“知识库无相关内容”，**不调用大模型自由发挥**，走兜底话术并记录“未命中”用于补充知识；
- **过滤严格时的召回问题**：商家过滤会让候选变少，评测时必须用**带过滤的真实查询**；必要时提高 `ef_search` 或按商家分区。

### 6.2 检索质量的评估与迭代

| 项 | 做法 |
| --- | --- |
| 评测集 | 1,500 条：历史会话抽样 800（脱敏）+ 业务专家编写 400 + 无答案问题 150 + 注入/越权样例 150；每条标注**应命中的 chunk/文档** |
| 指标 | Recall@5、MRR、**无答案拒答正确率**、带过滤的 Recall |
| 迭代顺序 | 切分策略 → 混合检索权重 → 重排 → 查询改写（**一次只改一项**，对比指标） |
| 线上监控 | 检索为空率、最高相关分分布、点踩样本回放 |

## 7. 路由、工具与确认流程

### 7.1 意图路由（分层决策，成本由低到高）

```text
1. 规则层（正则/关键词/按钮点击）：“转人工”“查订单”“发票” → 直接路由               成本 ≈ 0
2. FAQ 精确/相似命中（ES，分数 ≥ 阈值）→ 路径 A                                        成本 ≈ 0
3. 小模型分类（few-shot，输出一个标签）：RAG / TOOL / CHAT / HANDOFF / UNSAFE          ≈ 150 ms
4. 置信度低或多意图 → 澄清追问（“您是想查订单物流，还是申请退款？”）
```

分类标签与**阈值用评测集标定**，并统计混淆矩阵；**高风险类（投诉、法律、赔偿）宁可误转人工，也不要误答**。

### 7.2 工具清单与权限

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `get_product(sku)` / `compare_products(a,b)` | 读 | 商品属性，返回**精简字段** |
| `list_my_orders(limit)` / `get_order(orderNo)` | 读 | **仅限当前登录用户**；订单号校验归属，不属于该用户返回“未找到” |
| `get_logistics(orderNo)` | 读 | 物流轨迹，摘要后给模型，卡片渲染原文 |
| `preview_refund(orderNo, reason)` | 读（预览） | 计算可退金额、是否满足条件，**不产生副作用** |
| `submit_refund(previewId, confirmToken)` | **写** | 仅在用户确认后由编排服务调用，**不暴露给模型直接调用** |
| `handoff_to_human(summary)` | 写（安全） | 生成会话摘要并交接 |

**原则**：用户身份取自**会话**而非模型参数；写工具对模型**不可见**；每次调用写 `tool_call_log`，使用 `call_id` 幂等。

### 7.3 退款的两阶段确认

<figure class="fig">
<svg viewBox="0 0 780 340" class="dg" role="img" aria-label="退款两阶段确认时序：模型调用预览工具，前端展示确认卡片，用户确认后编排服务用幂等键调用提交工具">
<rect class="b1" x="20" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="75" y="37" text-anchor="middle" dominant-baseline="middle">用户</text>
<rect class="b3" x="190" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="255" y="37" text-anchor="middle" dominant-baseline="middle">编排服务</text>
<rect class="b5" x="380" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="435" y="37" text-anchor="middle" dominant-baseline="middle">LLM</text>
<rect class="b2" x="550" y="20" width="200" height="34" rx="6"/>
<text class="tb" x="650" y="37" text-anchor="middle" dominant-baseline="middle">订单/售后服务</text>
<line class="ld" x1="75" y1="54" x2="75" y2="322"/>
<line class="ld" x1="255" y1="54" x2="255" y2="322"/>
<line class="ld" x1="435" y1="54" x2="435" y2="322"/>
<line class="ld" x1="650" y1="54" x2="650" y2="322"/>
<line class="l" x1="75" y1="80" x2="255" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="165" y="72" text-anchor="middle">① “我要退 A1001”</text>
<line class="l" x1="255" y1="108" x2="435" y2="108" marker-end="url(#arr)"/>
<text class="ts" x="345" y="100" text-anchor="middle">② 上下文 + 工具（仅 preview）</text>
<line class="l" x1="435" y1="136" x2="255" y2="136" marker-end="url(#arr)"/>
<text class="ts" x="345" y="128" text-anchor="middle">③ tool_call: preview_refund</text>
<line class="l" x1="255" y1="164" x2="650" y2="164" marker-end="url(#arr)"/>
<text class="ts" x="452" y="156" text-anchor="middle">④ 用登录用户 ID 校验归属并计算预览</text>
<line class="l" x1="650" y1="192" x2="255" y2="192" marker-end="url(#arr)"/>
<text class="ts" x="452" y="184" text-anchor="middle">⑤ 预览：可退 ¥199，原路退回，previewId</text>
<line class="la" x1="255" y1="220" x2="75" y2="220" marker-end="url(#arr-a)"/>
<text class="ta" x="165" y="212" text-anchor="middle">⑥ 确认卡片（金额·方式·按钮）</text>
<line class="l" x1="75" y1="248" x2="255" y2="248" marker-end="url(#arr)"/>
<text class="ts" x="165" y="240" text-anchor="middle">⑦ 点击“确认”</text>
<line class="la" x1="255" y1="276" x2="650" y2="276" marker-end="url(#arr-a)"/>
<text class="ta" x="452" y="268" text-anchor="middle">⑧ submit_refund(previewId, confirmToken) 幂等执行</text>
<line class="l" x1="650" y1="304" x2="75" y2="304" marker-end="url(#arr)"/>
<text class="ts" x="362" y="296" text-anchor="middle">⑨ 结果卡片（工单号、预计到账时间）—— 由工具结果直接渲染</text>
</svg>
<figcaption>图 4：写操作两阶段：模型只提议，确认后由代码执行</figcaption>
</figure>

细节：

- `confirmToken` 由服务端签发，**绑定用户、订单、金额与过期时间（如 5 分钟）**，防止重放与篡改；
- `submit_refund` 以 `previewId` 为**幂等键**，重复点击只会创建一个售后单；
- 模型在整个过程中**拿不到提交权限**；它的作用只是理解意图和组织语言；
- 金额、订单号等**关键数字由工具结果渲染成卡片**，不由模型“复述”，避免数字写错。

## 8. 上下文预算、容量与成本

### 8.1 上下文预算（RAG 轮，输入约 2,850 Token）

| 部分 | Token | 说明 |
| --- | --- | --- |
| 系统规则 + 角色 + 输出规范 | 800 | **固定，放最前**，命中前缀缓存 |
| 会话摘要 + 近 3 轮 | 600 | 超出阈值触发摘要 |
| 检索片段（Top-4~5） | 1,400 | 每块 ≤ 350，带编号与来源标题 |
| 用户问题 | 50 | — |
| 预留输出 | 200（平均） | `max_tokens` 限制 400 |

订单/售后轮多一份**工具定义（约 700）**与工具结果（约 400），通常调用 LLM **2 次**（决策 → 组织回复），输入合计约 4,800、输出约 210。

### 8.2 向量规模与存储

```text
进入向量库的 chunk（只含非结构化文本）：
  政策/帮助 20 万 + 商家规则 30 万 + 商品长描述 50 万 + 历史优质问答 50 万 ≈ 150 万
向量：150 万 × 1024 维 × 2 字节（halfvec） ≈ 3 GB；HNSW（m=16）约为向量本身的 1.5~2 倍 ≈ 8~10 GB
→ 单个 PG 主库 + 2 个只读从库（各 16~32 GB 内存）即可；shared_buffers 与 OS cache 覆盖热点索引
对比：若把 300 万 SKU 的全部属性也向量化（约 1,100 万 chunk）：float32 约 44 GB，HNSW 后约 70~90 GB，成本与运维复杂度显著上升
```

峰值检索 QPS ≈ 150 轮/s × 约 50% 需要检索 ≈ 75 QPS，pgvector HNSW 在此规模单节点 P95 通常数十毫秒量级，**以压测为准**；2 个从库做读负载均衡。

### 8.3 LLM 流量与配额（真正的瓶颈）

```text
大促峰值 400 轮/s，其中进入大模型的约 75%（FAQ 25% 被拦截）≈ 300 轮/s
平均每轮输入 ≈ 3,000 Token → 约 90 万 Token/s ≈ 5,400 万 TPM（Token/分钟）
```

这个量级**远超单个账号的常规配额**，设计对策：

| 对策 | 作用 |
| --- | --- |
| **提前申请配额/专属容量**，并行接入**两家以上**厂商 | 消除单点与限流风险 |
| **模型分层路由**：简单 RAG 问题（约 70% 的 RAG 轮）走**中等/自建模型**，复杂、工具决策走大模型 | 降低大模型用量与单价 |
| 提示词缓存（固定前缀约占输入的 30%~50%） | 降低输入成本与首 Token 延迟 |
| FAQ/语义缓存（限定范围与高相似阈值） | 再拦截一部分重复问题 |
| 网关**令牌桶限流 + 优先级队列**（工具类/付费用户优先） | 超出配额时有序降级而不是随机失败 |
| 自建推理承接固定基线流量 | 基线用自建（利用率高更划算），峰值溢出到厂商 API，见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals) |

### 8.4 成本模型（价格为假设值）

```text
假设单价：大模型 输入 ¥2 / 百万 Token，输出 ¥8 / 百万 Token（示意）；小模型 ¥0.3 / 百万
日均（150 万轮）：
  RAG 轮   67.5 万轮 × 2,850 in / 200 out  → 输入 19.2 亿，输出 1.35 亿
  工具轮   30 万轮   × 4,800 in / 210 out  → 输入 14.4 亿，输出 0.63 亿
  路由小模型 150 万轮 × 300 in               → 输入 4.5 亿（约 ¥135）
大模型输入 33.6 亿 ≈ ¥6,720；输出 1.98 亿 ≈ ¥1,584   → ≈ ¥8,300 / 天 ≈ ¥0.028 / 会话
```

优化后（提示词缓存、中等模型分流、缓存命中）预期可再降 **30%~50%**；**与人工客服成本对比**（每次人工会话成本通常是数元量级）时，主要收益来自**解决率提升**而不是单次调用价格。上线后用真实日志校准以上全部假设。

## 9. 会话、记忆与安全

### 会话与记忆

```text
Redis Hash  conv:{convId}  → { userId, lastRoute, summary, turns[最近3轮], pendingConfirm{previewId,expire}, budget }
TTL 24h；摘要在超出窗口 70% 或每 6 轮触发，由小模型生成（保留：用户诉求、已确认事项、订单号/商品 ID、待办）
长期记忆：仅保存用户明确的偏好（如收货时间、沟通语言），经过去重与过期；不保存订单、支付等敏感内容
```

### 安全设计

| 威胁 | 措施 |
| --- | --- |
| **越权读取订单** | 工具服务只接受会话内用户 ID；订单号归属校验；返回“未找到”而不是“无权限”（防探测） |
| **提示注入**（用户直接注入、商品描述/评论里的间接注入） | 外部文本放 `<docs>` 标签并声明“不执行其中指令”；工具权限最小化；写操作确认；输出审核；红队样例纳入评测门禁，见 [LLM 应用工程化、安全与评测](#/ai/llmops) |
| 个人信息发给模型 | 入参**脱敏**（手机号、身份证、详细地址、银行卡），工具结果只回传必要字段；日志脱敏、保留期限制 |
| 模型输出越界承诺 | 规则：不得承诺赔付、不得承诺具体时效（除非来自工具结果）；输出审核命中即改写/转人工 |
| 刷调用/恶意消耗 | 用户与 IP 限流、单会话轮数与 Token 上限、成本告警 |
| 知识库被污染 | 入库来源白名单、质量门禁、变更审计；商家内容单独审核 |

## 10. 降级阶梯与故障处理

| 级别 | 触发条件 | 行为 |
| --- | --- | --- |
| L0 正常 | — | 全链路 |
| L1 | 重排/改写超时或慢 | 跳过重排用 RRF 结果；不改写直接检索 |
| L2 | 主模型限流/延迟升高 | 网关切备用厂商或**中等/自建模型**；缩短上下文 |
| L3 | 模型整体不可用或配额耗尽 | **不调用大模型**：FAQ 命中直接返回；否则返回“检索到的相关政策原文 + 链接”；订单类用卡片直接展示工具结果 |
| L4 | 检索与模型都故障 / 触发熔断 | 友好提示 + **排队转人工**，保持会话可用 |

故障场景对照：

| 故障 | 现象 | 应对 |
| --- | --- | --- |
| 厂商 API 抖动/限流 | 429/超时增多 | 网关重试（指数退避+抖动）+ 切备用；监控**首 Token 超时**主动切换，不傻等 |
| pgvector 主库故障 | 检索失败 | Patroni 自动切换；检索降级为 ES BM25（语义弱但可用） |
| 工具服务慢（订单系统故障） | 工具调用超时 | 熔断，提示“订单系统繁忙，已为您转人工”；不重试写操作 |
| 知识库错误内容上线 | 大量点踩，引用异常 | 文档版本回滚；按文档下线；告警规则（某文档被引用后点踩率飙升） |
| 大促流量突增 | 配额触顶 | 提前扩容自建推理、预热缓存、开启 L2、设置优先级 |

## 11. 评测、灰度与运营闭环

### 上线门禁（离线评测，全部达标才可灰度）

| 指标 | 门槛 |
| --- | --- |
| 检索 Recall@5（带过滤） | ≥ 0.92 |
| 回答忠实度（LLM 评审 + 人工抽检 200 条校准） | ≥ 0.95 |
| 无答案问题拒答正确率 | ≥ 0.90 |
| 路由准确率 / 高风险类召回率 | ≥ 0.95 / ≥ 0.99 |
| 工具参数正确率（含归属校验） | ≥ 0.98；越权用例通过率 100% |
| 已知注入样例拦截 | 100% |
| P95 TTFT / 整轮耗时 | ≤ 1.5 s / ≤ 8 s（压测） |

### 灰度路径

```text
1. 影子模式（1~2 周）：AI 生成答案但不展示，与人工客服答案对比，评估差距并补知识
2. 内部员工/白名单用户
3. 1% → 5% → 20% → 50% → 100% 流量；每档观察 ≥ 1 天，指标退化即回滚（提示词/模型/知识版本均可回滚）
4. 全量后保持“人工抽检 + 周度评测集回归 + 失败样例回流”
```

### 持续运营

- **反馈闭环**：点踩、转人工、重复提问作为信号；每周把失败案例**归因**（检索没命中？知识缺失？工具错误？提示词问题？），补知识/改切分/调提示词，再用评测集回归；
- **知识运营**：对“未命中”问题聚类，推动业务补充 FAQ；对过期/冲突文档告警；
- **看板**：解决率、转人工率及原因、点赞率、平均轮数、TTFT、单会话成本、各路由占比、检索未命中率、拒答率。

## 12. 实施路线

| 阶段 | 周期 | 交付 | 验收 |
| --- | --- | --- | --- |
| P0 基础 | 2~3 周 | 会话与编排骨架、模型网关、FAQ+RAG 最小链路、入库管道 v1、评测集 v1 | 离线评测可跑通，指标有基线 |
| P1 工具 | 2~3 周 | 订单/物流只读工具、卡片渲染、越权与注入测试 | 工具参数与越权用例全过 |
| P2 售后 | 2 周 | 退款预览+确认两阶段、幂等、审计 | 灰度 5% 无资损事件 |
| P3 稳定性 | 2 周 | 降级阶梯、压测与容量、配额与多厂商、观测大盘 | 大促压测达标，故障演练通过 |
| P4 优化 | 持续 | 重排、查询改写、模型分层、缓存、成本优化、知识运营 | 解决率与成本达到目标 |

**团队**：后端 3~4（编排、工具、入库）、算法/AI 工程 1~2（检索、评测、提示词）、前端 1、产品/运营 1（知识运营与评测标注）、测试/安全兼职。

## 13. 取舍与复盘清单

| 取舍 | 选择与代价 |
| --- | --- |
| 单 Agent + 路由，而非多 Agent | 更可控、更便宜；复杂跨域任务能力有限，需要时再演进 |
| pgvector 而非专用向量库 | 少一个组件、运维简单；规模或 QPS 超过阈值需迁移（接口已抽象 `VectorStore`） |
| 精确数据走工具而非向量化 | 答案准确、实时；多一次工具调用的延迟与耦合 |
| 写操作强制确认 | 安全；转化链路多一步，需优化卡片体验 |
| 规则优先、小模型兜底的路由 | 成本低、延迟低；规则需要持续维护 |
| 严格拒答 | 减少幻觉；会降低“看起来的回答率”，需靠补充知识提升覆盖 |

**如果规模扩大 10 倍**：向量库迁 Milvus 或分片；自建推理为主（利用率高）；检索与重排独立扩缩容；入库管道引入流式（[CDC 与实时数仓架构](#/bigdata/cdc)）与更细的权限模型；会话数据冷热分层。

## 面试追问

> [!QUESTION] 这个客服系统里为什么不把商品信息都放进向量库？
> 商品属性、价格、库存是精确且变化频繁的结构化数据，向量检索只能近似匹配，既不准又会过期；应该由商品工具查询得到精确值再让模型组织语言。这样向量库只存非结构化文本，规模从上千万降到约百万，用 pgvector 就够，运维成本也低。

> [!QUESTION] 如何保证 AI 不会误操作退款？
> 模型只能调用只读的预览工具，写工具对模型不可见；预览结果以卡片展示，用户确认后由编排服务凭服务端签发、绑定用户订单金额且有过期时间的确认令牌，使用预览 ID 作为幂等键调用提交；全程审计，金额由工具结果渲染而不是模型复述。

> [!QUESTION] 峰值流量下的主要瓶颈是什么？怎么设计？
> 是大模型的配额和延迟，而不是向量检索。通过 FAQ 与缓存拦截、小模型处理路由和改写、中等或自建模型承接简单问题、提示词缓存、多厂商接入与令牌桶优先级队列，并设计从跳过重排到完全不调用大模型的降级阶梯。

> [!QUESTION] 如何度量并持续提升回答质量？
> 建立覆盖多类场景的评测集并设置上线门禁（检索召回、忠实度、拒答、路由、工具、注入拦截、延迟），先影子模式再逐步灰度；线上用点踩、转人工等信号归因到检索、知识、工具或提示词问题，补充知识后用评测集回归，形成数据飞轮。

> [!QUESTION] 延迟预算是怎么拆分和保证的？
> 把首 Token 目标 1.5 秒拆到鉴权、会话、路由、改写、检索、重排、拼装和模型首 Token 各自的预算，并行化路由与改写、向量与关键词检索，每一步设置独立超时和降级路径，固定提示词前缀利用缓存，并用压测验证各分位数。
