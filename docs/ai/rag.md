---
level: 进阶
tags: [RAG, Embedding, 向量检索, 文档切分, Chunk, 混合检索, 重排, 知识库]
summary: 讲清 RAG（检索增强生成）的完整流水线：为什么需要 RAG、数据入库（解析、切分、向量化、索引）、查询链路（改写、检索、重排、提示词拼装、生成与引用），以及各环节常见的质量问题。
---

# RAG 原理与完整流水线

> [!ABSTRACT] 核心要点
> - **RAG = 检索 + 生成**：先从**你的知识库**检索出与问题相关的片段，再把片段连同问题一起交给大模型，让它**依据资料回答并给出引用**。它解决模型**知识过时、不懂私域数据、幻觉**的问题，且**无需训练模型、数据可随时更新、可做权限隔离**。
> - 两条链路：**离线入库**（解析 → 清洗 → **切分** → 向量化 → 写入索引）和**在线问答**（查询理解 → **检索** → 重排 → 拼装提示词 → 生成 → 引用与校验）。
> - RAG 的质量上限由**检索**决定：模型再强，检索不到正确片段也答不对。**调 RAG 先看检索，而不是先换模型**。
> - 切分（chunking）是最影响效果又最容易被忽视的环节：块太小丢上下文，块太大噪声多且稀释语义，要**按文档结构切分并保留元数据**。
> - 选型原则：**RAG 管知识，微调管风格与行为**；知识频繁变化、需要溯源和权限控制，首选 RAG。

## 为什么需要 RAG

| 方案 | 做法 | 适用 | 局限 |
| --- | --- | --- | --- |
| 直接问模型 | 依赖预训练知识 | 通用知识 | 知识过期、不懂私域、会幻觉 |
| 长上下文全塞 | 把整篇文档放进提示词 | 少量文档 | 成本高、延迟大、长文中段召回差，数据量一大就放不下 |
| **RAG** | 检索相关片段后再生成 | **企业知识库、客服、文档问答** | 依赖检索质量；多跳推理较弱 |
| 微调（Fine-tuning） | 用数据训练模型 | 固定风格、格式、领域术语、行为 | 知识更新慢、成本高、**不适合记忆事实**、难溯源与权限控制 |
| 工具调用 | 查询实时系统 | 结构化实时数据（订单、库存） | 需要接口与鉴权，见 [Agent、工具调用与 MCP](#/ai/agent) |

实际系统常**组合**使用：RAG 提供文档知识，工具调用查业务数据，微调（可选）统一输出风格。

## 整体架构

<figure class="fig">
<svg viewBox="0 0 760 420" class="dg" role="img" aria-label="RAG 整体架构：离线入库流水线与在线问答流水线">
<rect class="bg" x="20" y="14" width="720" height="150" rx="12"/>
<text class="th" x="36" y="38">离线：知识入库（Indexing）</text>
<rect class="b" x="36" y="58" width="100" height="56" rx="8"/>
<text class="tb" x="86" y="80" text-anchor="middle" dominant-baseline="middle">数据源</text>
<text class="ts" x="86" y="100" text-anchor="middle">PDF/Word/网页/库</text>
<rect class="b1" x="156" y="58" width="100" height="56" rx="8"/>
<text class="tb" x="206" y="80" text-anchor="middle" dominant-baseline="middle">解析清洗</text>
<text class="ts" x="206" y="100" text-anchor="middle">去噪/表格/OCR</text>
<rect class="b1" x="276" y="58" width="100" height="56" rx="8"/>
<text class="tb" x="326" y="80" text-anchor="middle" dominant-baseline="middle">切分 Chunk</text>
<text class="ts" x="326" y="100" text-anchor="middle">+ 元数据</text>
<rect class="b3" x="396" y="58" width="110" height="56" rx="8"/>
<text class="tb" x="451" y="80" text-anchor="middle" dominant-baseline="middle">Embedding</text>
<text class="ts" x="451" y="100" text-anchor="middle">文本 → 向量</text>
<rect class="b5" x="526" y="58" width="196" height="56" rx="8"/>
<text class="tb" x="624" y="80" text-anchor="middle" dominant-baseline="middle">索引存储</text>
<text class="ts" x="624" y="100" text-anchor="middle">向量库 + 关键词索引 + 元数据</text>
<line class="l" x1="136" y1="86" x2="156" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="256" y1="86" x2="276" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="376" y1="86" x2="396" y2="86" marker-end="url(#arr)"/>
<line class="l" x1="506" y1="86" x2="526" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="380" y="146" text-anchor="middle">增量更新：文档变更 → 重新切分 → 对比 hash → 只更新变化的块；删除要同步删除向量</text>
<rect class="bg" x="20" y="180" width="720" height="226" rx="12"/>
<text class="th" x="36" y="204">在线：问答（Retrieval + Generation）</text>
<rect class="b" x="36" y="222" width="96" height="56" rx="8"/>
<text class="tb" x="84" y="244" text-anchor="middle" dominant-baseline="middle">用户问题</text>
<text class="ts" x="84" y="264" text-anchor="middle">+ 历史</text>
<rect class="b1" x="152" y="222" width="110" height="56" rx="8"/>
<text class="tb" x="207" y="244" text-anchor="middle" dominant-baseline="middle">查询理解</text>
<text class="ts" x="207" y="264" text-anchor="middle">改写/拆分/权限</text>
<rect class="b3" x="282" y="222" width="110" height="56" rx="8"/>
<text class="tb" x="337" y="244" text-anchor="middle" dominant-baseline="middle">召回</text>
<text class="ts" x="337" y="264" text-anchor="middle">向量 + 关键词</text>
<rect class="b3" x="412" y="222" width="110" height="56" rx="8"/>
<text class="tb" x="467" y="244" text-anchor="middle" dominant-baseline="middle">重排 Rerank</text>
<text class="ts" x="467" y="264" text-anchor="middle">精排取 Top-N</text>
<rect class="b5" x="542" y="222" width="110" height="56" rx="8"/>
<text class="tb" x="597" y="244" text-anchor="middle" dominant-baseline="middle">提示词拼装</text>
<text class="ts" x="597" y="264" text-anchor="middle">规则 + 资料 + 问题</text>
<rect class="b2" x="672" y="222" width="56" height="56" rx="8"/>
<text class="tb" x="700" y="244" text-anchor="middle" dominant-baseline="middle">LLM</text>
<text class="ts" x="700" y="264" text-anchor="middle">生成</text>
<line class="l" x1="132" y1="250" x2="152" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="262" y1="250" x2="282" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="392" y1="250" x2="412" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="522" y1="250" x2="542" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="652" y1="250" x2="672" y2="250" marker-end="url(#arr)"/>
<line class="la" x1="624" y1="114" x2="360" y2="222" marker-end="url(#arr-a)"/>
<text class="ta" x="500" y="176" text-anchor="middle">检索索引</text>
<rect class="b4" x="152" y="322" width="500" height="64" rx="8"/>
<text class="tb" x="402" y="344" text-anchor="middle" dominant-baseline="middle">答案后处理</text>
<text class="ts" x="402" y="366" text-anchor="middle">引用来源 · 事实校验 · 敏感信息过滤 · 无依据时拒答 · 记录日志用于评测</text>
<line class="l" x1="700" y1="278" x2="700" y2="304"/>
<line class="l" x1="700" y1="304" x2="652" y2="304"/>
<line class="l" x1="652" y1="304" x2="652" y2="322" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：RAG 的离线入库链路与在线问答链路</figcaption>
</figure>

## 入库：从文档到可检索的知识

### 1. 解析与清洗

数据质量决定上限，常见来源与难点：

| 来源 | 难点 | 建议 |
| --- | --- | --- |
| Markdown/HTML/纯文本 | 导航、页脚等噪声 | 去掉模板内容，保留标题层级 |
| **PDF** | 版面混乱、多栏、页眉页脚、表格、扫描件 | 版面分析工具；**扫描件先 OCR**；表格单独处理（转 Markdown/结构化） |
| Word/PPT | 样式嵌套、图表 | 保留标题层级，图片用多模态模型描述 |
| 数据库/接口数据 | 结构化 | 转成“自然语言描述 + 元数据”，或直接用结构化查询（工具） |
| 图片/图表 | 信息在图里 | 多模态模型生成描述文本再入库 |

清洗要点：**去重**、去掉页码/水印、规范化空白、保留**文档标题、章节路径、来源 URL、更新时间、权限标签**等元数据——它们在**过滤、引用、更新**时都用得上。

### 2. 切分（Chunking）

目标：每个块**语义相对完整、长度适中**，能独立回答某类问题。

<figure class="fig">
<svg viewBox="0 0 740 270" class="dg" role="img" aria-label="三种切分方式：固定长度、按结构切分、带重叠与父子块">
<text class="th" x="20" y="24">① 固定长度切分</text>
<rect class="b" x="20" y="36" width="150" height="40" rx="4"/>
<text class="ts" x="95" y="56" text-anchor="middle" dominant-baseline="middle">……退款政策规定</text>
<rect class="b4" x="170" y="36" width="150" height="40" rx="4"/>
<text class="ts" x="245" y="56" text-anchor="middle" dominant-baseline="middle">七天内可申|请退款……</text>
<rect class="b" x="320" y="36" width="150" height="40" rx="4"/>
<text class="ts" x="395" y="56" text-anchor="middle" dominant-baseline="middle">……下一条规则</text>
<text class="ts" x="500" y="56" text-anchor="start">简单，但会在句子中间截断，语义被切碎</text>
<text class="th" x="20" y="112">② 按文档结构切分（标题/段落/语义）</text>
<rect class="b2" x="20" y="124" width="220" height="40" rx="4"/>
<text class="ts" x="130" y="144" text-anchor="middle" dominant-baseline="middle">【3.1 退款条件】完整一节</text>
<rect class="b2" x="250" y="124" width="220" height="40" rx="4"/>
<text class="ts" x="360" y="144" text-anchor="middle" dominant-baseline="middle">【3.2 退款流程】完整一节</text>
<text class="ts" x="500" y="144" text-anchor="start">块带上“章节路径”元数据，效果通常最好</text>
<text class="th" x="20" y="200">③ 父子块（Small-to-Big）：用小块检索，用大块生成</text>
<rect class="b3" x="20" y="212" width="300" height="44" rx="4"/>
<text class="ts" x="170" y="226" text-anchor="middle" dominant-baseline="middle">父块（整节，供 LLM 阅读）</text>
<rect class="b1" x="30" y="236" width="80" height="16" rx="2"/>
<rect class="b1" x="120" y="236" width="80" height="16" rx="2"/>
<rect class="b1" x="210" y="236" width="80" height="16" rx="2"/>
<text class="ts" x="340" y="236" text-anchor="start">子块（小句）用于向量匹配，命中后返回其父块，兼顾检索精度与上下文完整</text>
</svg>
<figcaption>图 2：切分策略：固定长度、结构化、父子块</figcaption>
</figure>

| 策略 | 做法 | 优缺点 |
| --- | --- | --- |
| 固定长度 + 重叠 | 每 N 个 Token 切一块，相邻块重叠 10%~20% | 简单通用；易切断语义 |
| **递归字符切分** | 按 `段落 → 句子 → 词` 的优先级递归切到目标长度 | 常用默认方案 |
| **结构化切分** | 按标题层级、列表、代码块、表格边界切分，把章节路径写入块 | **首选**，Markdown/HTML/Word 效果好 |
| 语义切分 | 用相邻句子 embedding 相似度突变处断开 | 质量好，成本高 |
| **父子块 / 窗口检索** | 小块检索，扩展到父块或前后窗口再喂给模型 | 兼顾精度与上下文 |
| 摘要/问题索引 | 为每块生成摘要或“可能被问到的问题”一并索引 | 提高召回，增加入库成本 |

经验参数（需用评测集校准）：中文问答块长常在 **300~800 字**，重叠约 10%~20%；表格、代码、FAQ 单独处理，**FAQ 以“一问一答”为一块**。

> [!WARNING] 切分会丢失“指代”和“上下文”
> “该规定自下月起执行”被单独切出来，就失去了“哪个规定”。对策：块头部**拼上文档标题与章节路径**；使用父子块；对含代词的块用 LLM 补全上下文（Contextual Retrieval 思路：为每块生成一句“它在文档中的位置/背景”再索引）。

### 3. 向量化与索引

- 用 **Embedding 模型**把每个块转成向量，与**原文、元数据**一起存入向量库；
- 索引结构：小数据量用**暴力检索**，大数据量用 **ANN 近似最近邻**（HNSW、IVF 等），详见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced)；
- **同时建关键词索引（BM25）**用于混合检索：向量擅长语义匹配，关键词擅长**精确词、编号、专有名词**；
- 元数据（部门、权限、版本、时间、文档类型）要可**过滤**，用于权限隔离和范围限定。

```java
// 入库伪代码
for (Document doc : sources.pull(sinceLastSync)) {
    List<Chunk> chunks = splitter.split(parser.parse(doc));              // 结构化切分
    for (Chunk c : chunks) {
        c.metadata().put("docId", doc.id()).put("title", doc.title())
                    .put("acl", doc.aclGroups()).put("updatedAt", doc.updatedAt());
    }
    List<float[]> vectors = embeddingModel.embedAll(chunks.stream().map(Chunk::text).toList());   // 批量调用
    vectorStore.upsert(chunks, vectors);                                  // 先删旧版本再写入，保证幂等
}
```

## 问答：检索与生成

### 1. 查询理解

用户的问题往往**不适合直接拿去检索**：

| 问题 | 处理 |
| --- | --- |
| 多轮对话里的指代（“那它的价格呢？”） | 结合历史**改写成独立问题**（Query Rewrite） |
| 问题太口语/太短 | 扩写、同义改写，或生成多个检索查询（Multi-Query） |
| 复合问题 | **拆成子问题**分别检索再汇总 |
| 需要限定范围 | 抽取过滤条件（部门、时间、产品线），转成元数据过滤 |
| 意图不是问答 | **路由**：闲聊、查订单（走工具）、查文档（走 RAG） |
| 权限 | 带上用户身份，**在检索阶段做 ACL 过滤**（而不是检索后再过滤） |

### 2. 召回与重排

1. **召回**：向量检索取 Top-K（如 20~50），同时关键词检索取 Top-K，**融合**（如 RRF）；
2. **重排（Rerank）**：用**交叉编码器（cross-encoder）模型**对“问题—候选片段”逐对打分，精排出 Top-N（如 3~8）；召回追求**覆盖（Recall）**，重排追求**精准（Precision）**；
3. **去重与多样性**：合并重复/近重复块，必要时用 MMR 降低冗余。

### 3. 提示词拼装与生成

```text
<system>
你是企业知识库助手。只能依据 <docs> 回答；资料不足时说“知识库中没有相关信息”，不要猜测。
回答后用 [编号] 标注引用。
</system>
<docs>
[1] 来源：《报销制度》第 3 章 差旅… （更新于 2026-03）
    …片段内容…
[2] 来源：…
</docs>
<question>出差住宿一天可以报多少？</question>
```

要点：

- 资料用**编号 + 来源标题**，要求模型**引用编号**，回答可追溯；
- 片段**数量与总长度要受控**（预算内），相关性高的放**开头或结尾**；
- 明确“**资料中没有就拒答**”，这是降低幻觉最有效的规则之一；
- 把用户问题和资料用标签**隔离**，降低文档内容注入指令的风险（见 [LLM 应用工程化、安全与评测](#/ai/llmops)）。

### 4. 后处理

- 解析引用编号，渲染成可点击的来源链接；
- 校验：答案中的关键事实/数字是否出现在资料中（可用另一个小模型做“依据校验”）；
- 无检索结果或最高相关度低于阈值时，**直接走兜底话术**，不调用大模型自由发挥；
- 全链路日志：问题、改写后查询、召回结果、重排分、最终提示词、答案、耗时、用户反馈——这是**评测与优化的数据基础**。

## 常见问题与排查

| 症状 | 可能原因 | 排查方向 |
| --- | --- | --- |
| 答非所问、没引用到正确资料 | **没检索到**正确片段 | 看召回结果，按 Recall@K 评估；改切分、加混合检索、查询改写 |
| 资料里有，却说没有 | 块被切断；Top-N 太小；重排误杀；相似度阈值过严 | 打印每一步候选；调 K/N/阈值 |
| 编造细节 | 提示词没限制只用资料；资料不足仍强答 | 加拒答规则、引用要求、答案校验 |
| 专有名词、编号检索不到 | 纯向量对精确匹配弱 | 加 BM25 / 关键词过滤 |
| 新文档不生效、旧文档仍在 | 增量更新/删除不完整 | 入库幂等、按 docId 删旧块、版本号 |
| 表格、数字类问题答错 | 表格被拍平成乱序文本 | 表格单独解析为结构化文本；数值类问题走 SQL/工具 |
| 跨文档、多跳问题答不好 | 单次检索只取到一部分 | 子问题拆分、迭代检索（Agentic RAG）、知识图谱（GraphRAG） |
| 延迟高 | 多次 LLM 调用（改写+生成+校验）、重排慢 | 并行化、缓存、小模型做改写与路由 |
| 越权看到不该看的内容 | 检索后才过滤或根本没过滤 | **检索时带 ACL 元数据过滤** |

## 相关阅读

- [RAG 向量检索逻辑：从文本到 Top-K（嵌入、相似度、ANN、过滤与调优）](#/ai/rag-vector)：一次向量检索的完整逻辑：嵌入、相似度、ANN 搜索、过滤与调优
- [文档解析与多模态 RAG（PDF、表格、OCR、图片）](#/ai/rag-parsing)：入库的第一环：解析、表格与图片
- [评测体系实战：数据集、LLM 评审与回归门禁](#/ai/eval)：检索与生成的评测方法

## 面试追问

> [!QUESTION] RAG 的完整流程是什么？
> 离线：文档解析清洗、切分、向量化、写入向量库与关键词索引并保留元数据；在线：问题改写与路由、向量与关键词混合召回、重排取 Top-N、拼装带引用的提示词让模型依据资料生成，并做引用、校验与兜底。

> [!QUESTION] RAG 和微调怎么选？
> RAG 适合引入会变化的外部知识，支持溯源、权限控制，更新成本低；微调适合改变输出风格、格式或让模型掌握特定任务行为，不适合记忆事实。很多系统是 RAG 管知识，微调（或提示词）管行为。

> [!QUESTION] 文档切分有哪些策略？块大小怎么定？
> 固定长度加重叠、递归字符切分、按标题和段落的结构化切分、语义切分、父子块。块大小要兼顾检索精度与上下文完整，中文通常几百字，用评测集的召回率和答案质量来校准，并为每块附加标题路径等元数据。

> [!QUESTION] 为什么需要混合检索和重排？
> 向量检索擅长语义但对编号、专有名词的精确匹配弱，BM25 反之，二者融合提高召回；召回的候选再用交叉编码器重排，精确判断问题与片段的相关性，提高送给模型的资料质量。

> [!QUESTION] RAG 回答不准，你怎么系统地排查？
> 先看检索：记录每一步候选并评估 Recall@K，判断是没召回、召回了排不上来，还是资料被切碎；再看提示词与生成：是否限制只用资料、是否拒答；最后看数据与更新问题。建立评测集后逐项改动并回归，而不是一上来换模型。
