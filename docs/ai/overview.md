---
level: 入门
tags: [AI 应用, 全景, 学习路线, 技术选型, 提示词, RAG, Agent, 微调, 评测]
summary: 面向后端工程师的 AI 应用全景：分层架构（模型、知识、编排、工程、产品）、从提示词到 RAG、工作流、Agent、微调的手段升级阶梯、选型决策、学习路线与每个阶段对应的站内文章。
---

# AI 应用全景与学习路线（工程师视角）

> [!ABSTRACT] 核心要点
> - 做 AI 应用的难点已经不在“调通模型”，而在**把一个概率性的组件做成可靠的系统**：知识从哪来、怎么控制输出、出错怎么兜底、效果怎么度量、成本怎么压。
> - 一个 AI 应用可以拆成五层：**模型层、知识与数据层、编排层、工程保障层（横切）、产品交互层**。多数问题能定位到某一层，对症处理比“换个更大的模型”有效得多。
> - 手段有**升级阶梯**：提示词 → RAG → 工具与工作流 → Agent → 微调。**能用低一级解决就不要上高一级**，每升一级成本、复杂度和风险都明显增加。
> - **评测是总开关**：没有评测集，就没有办法说清“改了提示词是变好还是变坏”。先有评测，再谈优化。
> - 本分类的文章按这条主线组织，下文给出**学习路线**与**每个问题该看哪篇**。

## 分层全景

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="AI 应用分层：产品交互层、编排层、知识与数据层、模型层，右侧为横切的工程保障：评测、网关、安全、可观测、成本">
<rect class="b" x="20" y="14" width="560" height="62" rx="10"/>
<text class="th" x="32" y="32">产品交互层</text>
<rect class="b3" x="130" y="22" width="100" height="46" rx="8"/>
<text class="ts" x="180" y="45" text-anchor="middle" dominant-baseline="middle">对话/问答</text>
<rect class="b3" x="240" y="22" width="100" height="46" rx="8"/>
<text class="ts" x="290" y="45" text-anchor="middle" dominant-baseline="middle">搜索/助手</text>
<rect class="b3" x="350" y="22" width="100" height="46" rx="8"/>
<text class="ts" x="400" y="45" text-anchor="middle" dominant-baseline="middle">流程自动化</text>
<rect class="b3" x="460" y="22" width="110" height="46" rx="8"/>
<text class="ts" x="515" y="45" text-anchor="middle" dominant-baseline="middle">流式·反馈入口</text>
<rect class="b" x="20" y="88" width="560" height="62" rx="10"/>
<text class="th" x="32" y="106">编排层</text>
<rect class="b5" x="130" y="96" width="100" height="46" rx="8"/>
<text class="ts" x="180" y="119" text-anchor="middle" dominant-baseline="middle">提示词管理</text>
<rect class="b5" x="240" y="96" width="100" height="46" rx="8"/>
<text class="ts" x="290" y="119" text-anchor="middle" dominant-baseline="middle">工作流/路由</text>
<rect class="b5" x="350" y="96" width="100" height="46" rx="8"/>
<text class="ts" x="400" y="119" text-anchor="middle" dominant-baseline="middle">Agent·多Agent</text>
<rect class="b5" x="460" y="96" width="110" height="46" rx="8"/>
<text class="ts" x="515" y="119" text-anchor="middle" dominant-baseline="middle">工具·MCP</text>
<rect class="b" x="20" y="162" width="560" height="62" rx="10"/>
<text class="th" x="32" y="180">知识与数据层</text>
<rect class="b2" x="130" y="170" width="100" height="46" rx="8"/>
<text class="ts" x="180" y="193" text-anchor="middle" dominant-baseline="middle">文档解析</text>
<rect class="b2" x="240" y="170" width="100" height="46" rx="8"/>
<text class="ts" x="290" y="193" text-anchor="middle" dominant-baseline="middle">向量/全文检索</text>
<rect class="b2" x="350" y="170" width="100" height="46" rx="8"/>
<text class="ts" x="400" y="193" text-anchor="middle" dominant-baseline="middle">记忆存储</text>
<rect class="b2" x="460" y="170" width="110" height="46" rx="8"/>
<text class="ts" x="515" y="193" text-anchor="middle" dominant-baseline="middle">业务库·API</text>
<rect class="b" x="20" y="236" width="560" height="62" rx="10"/>
<text class="th" x="32" y="254">模型层</text>
<rect class="b4" x="130" y="244" width="100" height="46" rx="8"/>
<text class="ts" x="180" y="267" text-anchor="middle" dominant-baseline="middle">闭源 API</text>
<rect class="b4" x="240" y="244" width="100" height="46" rx="8"/>
<text class="ts" x="290" y="267" text-anchor="middle" dominant-baseline="middle">开源自部署</text>
<rect class="b4" x="350" y="244" width="100" height="46" rx="8"/>
<text class="ts" x="400" y="267" text-anchor="middle" dominant-baseline="middle">微调模型</text>
<rect class="b4" x="460" y="244" width="110" height="46" rx="8"/>
<text class="ts" x="515" y="267" text-anchor="middle" dominant-baseline="middle">Embedding·重排</text>
<rect class="bg" x="600" y="14" width="140" height="284" rx="10"/>
<text class="th" x="670" y="36" text-anchor="middle">横切：工程保障</text>
<text class="ts" x="670" y="80" text-anchor="middle">评测集·回归门禁</text>
<text class="ts" x="670" y="116" text-anchor="middle">模型网关·路由</text>
<text class="ts" x="670" y="152" text-anchor="middle">安全·权限·脱敏</text>
<text class="ts" x="670" y="188" text-anchor="middle">可观测·轨迹</text>
<text class="ts" x="670" y="224" text-anchor="middle">缓存·成本预算</text>
<text class="ts" x="670" y="260" text-anchor="middle">降级·容灾·限流</text>
</svg>
<figcaption>图 1：AI 应用的五层结构，工程保障横切所有层</figcaption>
</figure>

遇到问题时先**定位在哪一层**：

| 现象 | 多半出在 | 先看 |
| --- | --- | --- |
| 回答格式乱、不听话 | 编排层（提示词、输出约束） | [提示词工程进阶](#/ai/prompt-eng) |
| 答非所问、引用错误、漏答 | 知识层（解析、切分、检索） | [RAG 检索优化](#/ai/rag-advanced)、[文档解析](#/ai/rag-parsing) |
| 要查数据、调接口、多步骤 | 编排层（工具、工作流、Agent） | [Agent](#/ai/agent)、[工作流与 Agent 选型](#/ai/agent-workflow) |
| 风格/领域术语不对、小模型不够用 | 模型层（微调） | [微调实战](#/ai/finetune) |
| 越改越不知道好坏 | 工程层（评测） | [评测体系实战](#/ai/eval) |
| 贵、慢、不稳 | 工程层（网关、缓存、降级） | [LLM 应用工程化](#/ai/llmops) |

## 手段升级阶梯

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="手段升级阶梯：提示词、RAG、工具与工作流、Agent、微调，成本与复杂度逐级递增，各自的适用时机">
<rect class="b3" x="20" y="30" width="130" height="120" rx="10"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">① 提示词</text>
<text class="ts" x="85" y="80" text-anchor="middle">角色·规则·示例</text>
<text class="ts" x="85" y="100" text-anchor="middle">输出格式约束</text>
<text class="ts" x="85" y="124" text-anchor="middle">几乎零成本</text>
<rect class="b2" x="160" y="30" width="130" height="120" rx="10"/>
<text class="tb" x="225" y="52" text-anchor="middle" dominant-baseline="middle">② RAG</text>
<text class="ts" x="225" y="80" text-anchor="middle">缺私有/最新知识</text>
<text class="ts" x="225" y="100" text-anchor="middle">要求可引用溯源</text>
<text class="ts" x="225" y="124" text-anchor="middle">知识可热更新</text>
<rect class="b5" x="300" y="30" width="130" height="120" rx="10"/>
<text class="tb" x="365" y="52" text-anchor="middle" dominant-baseline="middle">③ 工具/工作流</text>
<text class="ts" x="365" y="80" text-anchor="middle">要查数据·执行动作</text>
<text class="ts" x="365" y="100" text-anchor="middle">步骤固定可编排</text>
<text class="ts" x="365" y="124" text-anchor="middle">确定性强</text>
<rect class="b1" x="440" y="30" width="130" height="120" rx="10"/>
<text class="tb" x="505" y="52" text-anchor="middle" dominant-baseline="middle">④ Agent</text>
<text class="ts" x="505" y="80" text-anchor="middle">路径无法预先写死</text>
<text class="ts" x="505" y="100" text-anchor="middle">需自主规划探索</text>
<text class="ts" x="505" y="124" text-anchor="middle">灵活但不稳定</text>
<rect class="b4" x="580" y="30" width="130" height="120" rx="10"/>
<text class="tb" x="645" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 微调</text>
<text class="ts" x="645" y="80" text-anchor="middle">风格/格式/领域</text>
<text class="ts" x="645" y="100" text-anchor="middle">降本替换大模型</text>
<text class="ts" x="645" y="124" text-anchor="middle">需数据与评测</text>
<line class="l" x1="20" y1="180" x2="720" y2="180" marker-end="url(#arr)"/>
<text class="ta" x="370" y="172" text-anchor="middle">成本、复杂度、风险、维护负担逐级递增</text>
<rect class="bg" x="20" y="198" width="720" height="40" rx="8"/>
<text class="ts" x="380" y="222" text-anchor="middle">原则：先用评测证明“低一级不够”，再升级；微调解决“怎么说”，RAG 解决“知道什么”，二者并不互斥</text>
</svg>
<figcaption>图 2：从提示词到微调的手段升级阶梯</figcaption>
</figure>

几个常见误区：

- **“模型不知道公司知识 → 微调”**：微调不擅长注入大量**会变化的事实**，更新慢、难溯源、易幻觉；这种需求用 RAG。微调更适合改**输出风格、格式遵循、特定任务的稳定性**。
- **“上 Agent 就能解决一切”**：多数业务流程步骤是固定的，**写成工作流更稳、更便宜、更好测**；Agent 只用于确实无法预先规划的部分。
- **“效果不好换更大的模型”**：先查是不是检索没召回、提示词有歧义、上下文被噪声淹没；换模型是最后手段（同时也是最贵的）。
- **“没有评测先上线再说”**：之后每次改动都只能凭感觉，线上问题无法回归，**应该最先投入的反而是 30~50 条的小评测集**。

## 选型决策

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="选型决策流程：先判断是否需要大模型，再依次判断是否缺知识、是否需要动作、路径是否固定、是否风格或成本问题，得到对应的手段">
<rect class="b3" x="20" y="100" width="120" height="60" rx="10"/>
<text class="tb" x="80" y="122" text-anchor="middle" dominant-baseline="middle">明确任务</text>
<text class="ts" x="80" y="142" text-anchor="middle">成功标准+评测集</text>
<rect class="b1" x="170" y="100" width="120" height="60" rx="10"/>
<text class="tb" x="230" y="122" text-anchor="middle" dominant-baseline="middle">提示词基线</text>
<text class="ts" x="230" y="142" text-anchor="middle">先跑出基线</text>
<line class="l" x1="140" y1="130" x2="170" y2="130" marker-end="url(#arr)"/>
<rect class="b" x="320" y="14" width="190" height="44" rx="8"/>
<text class="ts" x="415" y="36" text-anchor="middle" dominant-baseline="middle">缺私有/新知识？ → 加 RAG</text>
<rect class="b" x="320" y="70" width="190" height="44" rx="8"/>
<text class="ts" x="415" y="92" text-anchor="middle" dominant-baseline="middle">要查数据/执行动作？ → 工具</text>
<rect class="b" x="320" y="126" width="190" height="44" rx="8"/>
<text class="ts" x="415" y="148" text-anchor="middle" dominant-baseline="middle">步骤固定？ → 工作流编排</text>
<rect class="b" x="320" y="182" width="190" height="44" rx="8"/>
<text class="ts" x="415" y="204" text-anchor="middle" dominant-baseline="middle">路径不可预知？ → Agent</text>
<rect class="b" x="320" y="238" width="190" height="24" rx="8"/>
<text class="ts" x="415" y="251" text-anchor="middle" dominant-baseline="middle">风格/成本问题？ → 微调</text>
<line class="l" x1="290" y1="125" x2="320" y2="36" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="128" x2="320" y2="92" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="132" x2="320" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="136" x2="320" y2="204" marker-end="url(#arr)"/>
<rect class="b2" x="560" y="100" width="180" height="60" rx="10"/>
<text class="tb" x="650" y="122" text-anchor="middle" dominant-baseline="middle">评测对比</text>
<text class="ts" x="650" y="142" text-anchor="middle">指标提升才保留</text>
<line class="l" x1="510" y1="36" x2="560" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="92" x2="560" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="148" x2="560" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="204" x2="560" y2="146" marker-end="url(#arr)"/>
</svg>
<figcaption>图 3：从基线出发，按问题类型逐项叠加手段，并用评测验证</figcaption>
</figure>

一些实用判断：

| 问题 | 倾向 |
| --- | --- |
| 数据敏感、不能出境/出域 | 私有化开源模型 + 本地向量库；见 [Spring AI 与 LangChain4j](#/ai/spring-ai) 的本地部署章节 |
| 并发高、延迟敏感 | 小模型 + 缓存 + 流式输出；大模型只处理难例（路由） |
| 知识更新频繁 | RAG（增量入库），不是微调 |
| 输出必须是严格结构 | 结构化输出/约束解码 + 校验重试，见 [提示词工程进阶](#/ai/prompt-eng) |
| 任务有明确对错、可自动验证 | 适合 Agent 自我检查与重试（如代码、SQL） |
| 有写操作、资金、权限 | 工作流 + 人工确认，不要放任 Agent |

## 学习路线

按“能动手做出东西”的顺序，而不是按概念多少：

| 阶段 | 目标 | 阅读 |
| --- | --- | --- |
| **1. 打基础** | 搞清 Token、上下文、采样参数、API 调用与流式 | [大模型应用基础](#/ai/llm)、[提示词工程进阶](#/ai/prompt-eng) |
| **2. 做问答** | 搭出带引用的 RAG，并知道怎么排查 | [RAG 原理](#/ai/rag)、[RAG 检索优化](#/ai/rag-advanced)、[文档解析](#/ai/rag-parsing) |
| **3. 接工具** | 让模型调接口、查数据库，理解 MCP | [Agent 与 MCP](#/ai/agent)、[MCP 深入](#/ai/mcp-deep) |
| **4. 做流程** | 编排多步骤、状态与人工确认 | [工作流与 Agent 选型](#/ai/agent-workflow)、[Agent 进阶](#/ai/agent-deep) |
| **5. 保质量** | 评测集、LLM 评审、回归门禁 | [评测体系实战](#/ai/eval)、[LLM 应用工程化](#/ai/llmops) |
| **6. 降成本/定制** | 小模型微调、量化、推理服务 | [微调实战](#/ai/finetune)、[大模型原理与推理服务](#/ai/llm-internals) |
| **7. 综合落地** | 完整方案与取舍 | [智能客服知识库](#/ai/case-kb)、[Text-to-SQL 助手](#/ai/case-text2sql)、[代码助手](#/ai/case-codeagent) |

需要补底层原理时，转到 **AI 模型与数学** 分类：[AI 模型“性格画像”](#/aimodel/personality) 帮你选型，[注意力与 Transformer](#/aimodel/transformer) 和 [LLM](#/aimodel/llm) 讲清模型本身。Java 后端工程师重点关注 [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)。

## 落地时的工程清单

做第一个 AI 功能之前，先过一遍：

1. **成功标准**：什么算答对？有没有 30 条以上带标准答案或评分细则的样例？
2. **失败预案**：模型超时、限流、返回乱格式时，用户看到什么？有没有降级路径（缓存答案、规则兜底、转人工）？
3. **数据边界**：哪些数据会发给外部模型？是否需要脱敏、是否有合规要求、日志里会不会存下敏感内容？
4. **权限**：检索与工具调用是否按**当前用户**的权限过滤，而不是服务账号的权限？
5. **成本预算**：单次请求平均 Token、每日上限、超限策略；是否做了缓存与小模型路由？
6. **可观测**：每次请求的提示词版本、检索结果、工具调用、耗时、Token、用户反馈能否串成一条轨迹？
7. **迭代机制**：线上差评如何回流成评测样例？提示词、检索参数、模型版本的变更是否走评测门禁与灰度？

## 相关阅读

- [LLM 应用工程化、安全与评测](#/ai/llmops)：系统全景与上线实践
- [设计方法论：从需求到架构](#/design/method)：通用的架构设计与取舍思路
- [面试速查表](#/design/interview)：含 AI 应用相关追问索引

## 面试追问

> [!QUESTION] 做一个企业知识问答，你会怎么选技术路线？
> 先定义成功标准并准备评测集，用提示词跑出基线；缺私有与最新知识就上 RAG（解析、切分、混合检索、重排、引用），需要查业务数据加工具调用，步骤固定的用工作流编排；每加一层都用评测验证收益。微调不用来灌知识，只有在风格、格式或成本问题明确时才考虑。

> [!QUESTION] RAG 和微调怎么选？
> RAG 解决“知道什么”：知识可热更新、可溯源、可按权限过滤，适合私有和变化的知识；微调解决“怎么说、怎么做”：输出风格、格式遵循、领域任务稳定性，或用小模型替代大模型降本。两者可以组合：微调的模型做生成，RAG 提供知识。

> [!QUESTION] 什么时候该用 Agent，什么时候用工作流？
> 步骤和分支能预先写清楚的用工作流：确定性强、便宜、易测试、好排错。只有路径取决于中间结果、无法预先枚举，才用 Agent 做自主规划，并配最大步数、预算、权限和人工确认。很多系统是“工作流为骨架，局部节点用 Agent”。

> [!QUESTION] 效果不好时，你的排查顺序是什么？
> 先看轨迹定位层次：检索有没有召回对的资料；提示词有没有歧义或冲突；上下文是否被噪声塞满；工具参数和返回是否正确；模型能力是否确实不足。逐层用评测集验证后再动，换更大模型或微调放在最后。

> [!QUESTION] 为什么说评测集应该最先建立？
> 没有评测，任何改动都无法量化是变好还是变坏，也无法做回归、灰度对比和模型升级验证。小而代表性强的集合（几十条真实问题加标准答案或评分细则）就能显著降低盲改风险，之后再随线上失败案例持续扩充。
