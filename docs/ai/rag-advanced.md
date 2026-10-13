---
level: 深入
tags: [RAG, 向量数据库, HNSW, pgvector, Milvus, 混合检索, RRF, Rerank, 评估, GraphRAG]
summary: RAG 的进阶部分：向量检索算法（HNSW/IVF）与向量库选型、混合检索与 RRF 融合、查询改写与重排、权限过滤，以及用 Recall/MRR/忠实度等指标建立评测闭环，并介绍 Agentic RAG 与 GraphRAG。
---

# RAG 检索优化、向量库与评估

> [!ABSTRACT] 核心要点
> - 向量检索是**近似最近邻（ANN）**：用少量精度换取高速度。**HNSW**（图索引，召回高、内存大）是默认首选，**IVF**（聚类分桶，省内存）适合超大规模；关键参数是**召回率与延迟的平衡**。
> - **混合检索**（向量 + BM25）经 **RRF（倒数排名融合）** 合并，再用 **Cross-Encoder 重排**，是提升召回与精度最稳的组合。
> - 向量库选型：**已有 PostgreSQL → pgvector**（简单、事务与元数据一体）；**海量向量/高并发 → Milvus 等专用库**；已有 ES 可用其向量能力做混合检索。
> - **权限过滤必须在检索阶段**完成（带 ACL 元数据的预过滤），不能检索后再丢。
> - 没有评测就没有优化：建立**评测集**，分别度量**检索（Recall@K、MRR、nDCG）**与**生成（忠实度、相关性、正确率）**，每次改动都回归。

## 向量检索原理

### 为什么要近似

精确检索要计算查询向量与**每个**文档向量的距离，复杂度 O(N·d)；千万级、1024 维下单次查询要上百亿次浮点运算，不可接受。**ANN 索引**通过组织数据结构，只检查一小部分候选，换来数量级的加速，代价是**可能漏掉真正的最近邻**（召回率 < 100%）。

### HNSW（Hierarchical Navigable Small World）

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="HNSW 分层图索引：上层稀疏用于快速定位，下层稠密用于精细搜索">
<text class="th" x="20" y="24">高层（稀疏，长跳）</text>
<circle class="b3" cx="120" cy="60" r="12"/>
<circle class="b3" cx="360" cy="60" r="12"/>
<circle class="b3" cx="620" cy="60" r="12"/>
<line class="l" x1="132" y1="60" x2="348" y2="60"/>
<line class="l" x1="372" y1="60" x2="608" y2="60"/>
<text class="ts" x="130" y="90" text-anchor="start">入口节点从最高层开始，贪心走向离查询最近的节点</text>
<text class="th" x="20" y="124">中层</text>
<circle class="b1" cx="120" cy="156" r="10"/>
<circle class="b1" cx="240" cy="156" r="10"/>
<circle class="b1" cx="360" cy="156" r="10"/>
<circle class="b1" cx="490" cy="156" r="10"/>
<circle class="b1" cx="620" cy="156" r="10"/>
<line class="l" x1="130" y1="156" x2="230" y2="156"/>
<line class="l" x1="250" y1="156" x2="350" y2="156"/>
<line class="l" x1="370" y1="156" x2="480" y2="156"/>
<line class="l" x1="500" y1="156" x2="610" y2="156"/>
<line class="ld" x1="120" y1="72" x2="120" y2="146"/>
<line class="ld" x1="360" y1="72" x2="360" y2="146"/>
<line class="ld" x1="620" y1="72" x2="620" y2="146"/>
<text class="th" x="20" y="212">第 0 层（全部节点，稠密）</text>
<circle class="b2" cx="80" cy="256" r="8"/>
<circle class="b2" cx="160" cy="256" r="8"/>
<circle class="b2" cx="240" cy="256" r="8"/>
<circle class="b2" cx="300" cy="256" r="8"/>
<circle class="b2" cx="360" cy="256" r="8"/>
<circle class="b4" cx="420" cy="256" r="8"/>
<circle class="b2" cx="490" cy="256" r="8"/>
<circle class="b2" cx="560" cy="256" r="8"/>
<circle class="b2" cx="620" cy="256" r="8"/>
<circle class="b2" cx="690" cy="256" r="8"/>
<line class="l" x1="88" y1="256" x2="152" y2="256"/>
<line class="l" x1="168" y1="256" x2="232" y2="256"/>
<line class="l" x1="248" y1="256" x2="292" y2="256"/>
<line class="l" x1="308" y1="256" x2="352" y2="256"/>
<line class="l" x1="368" y1="256" x2="412" y2="256"/>
<line class="l" x1="428" y1="256" x2="482" y2="256"/>
<line class="l" x1="498" y1="256" x2="552" y2="256"/>
<line class="l" x1="568" y1="256" x2="612" y2="256"/>
<line class="l" x1="628" y1="256" x2="682" y2="256"/>
<line class="ld" x1="360" y1="166" x2="360" y2="248"/>
<line class="ld" x1="490" y1="166" x2="490" y2="248"/>
<text class="ta" x="420" y="296" text-anchor="middle">▲ 最终在底层以 efSearch 个候选做精细搜索，返回最近的 K 个</text>
<text class="ts" x="420" y="318" text-anchor="middle">逐层下降：上层用少量长跳快速逼近，底层精确定位（类似跳表）</text>
</svg>
<figcaption>图 1：HNSW 的多层邻近图：自顶向下贪心搜索</figcaption>
</figure>

- 构建：每个新向量随机分配一个**最高层数**（指数衰减），在各层与其近邻建立最多 `M` 条边；
- 查询：从最高层入口开始贪心找最近邻，下降一层继续；到第 0 层以 `ef_search` 为候选队列大小做广度搜索；
- **优点**：召回高、延迟低、支持增量插入；**缺点**：**内存占用大**（图结构常驻内存，约为原始向量的 1.x~数倍），构建慢，删除/更新会让图质量下降。

| 参数 | 含义 | 影响 |
| --- | --- | --- |
| `M` | 每个节点的最大邻居数 | 越大召回越高、内存越大、构建越慢（常用 16~64） |
| `ef_construction` | 建图时的候选队列大小 | 越大图质量越高、构建越慢 |
| `ef_search` | 查询时的候选队列大小 | **查询时调节召回与延迟的主要旋钮**，必须大于 K |

### IVF（倒排文件）与量化

- **IVF**：先用 K-means 把向量聚成 `nlist` 个簇；查询时只搜索最近的 `nprobe` 个簇。内存更省、构建快，但召回依赖 `nprobe`，**需要先训练聚类中心**，数据分布变化大时要重训；
- **量化**：**PQ（乘积量化）/ SQ（标量量化）** 压缩向量（如 float32 → int8 或更低），大幅减少内存和带宽，召回略降；常见组合 `IVF_PQ`、`HNSW + SQ`；
- **DiskANN** 等磁盘友好索引：向量放 SSD、图索引部分缓存，适合十亿级、内存受限场景。

| 索引 | 召回 | 内存 | 构建 | 更新 | 适合 |
| --- | --- | --- | --- | --- | --- |
| Flat（暴力） | 100% | 原始大小 | 无 | 简单 | 小于约十万级、或需要精确 |
| **HNSW** | 高 | **高** | 慢 | 较好（删除需重建/标记） | 通用首选，百万~亿级 |
| IVF_FLAT / IVF_PQ | 中高（依赖 nprobe） | 中/低 | 需训练 | 一般 | 超大规模、省内存 |
| DiskANN | 高 | 低（盘+部分内存） | 慢 | 一般 | 十亿级 |

### 距离度量

`cosine`（最常用）、`inner product`、`L2`。**向量建议归一化**，这样余弦与内积排序一致；索引创建时的度量必须与查询一致。

## 向量库选型

| 方案 | 特点 | 适合 | 注意 |
| --- | --- | --- | --- |
| **pgvector**（PostgreSQL 扩展） | 支持 HNSW/IVFFlat；与业务数据**同库、有事务、SQL 过滤与 JOIN** | **中小规模（百万~千万）**、已有 PG | 超大规模、超高 QPS 时单机能力有限；见 [复制、高可用与实战](#/pg/ops) |
| **Milvus** | 分布式、多种索引、云原生、存算分离 | 亿级以上、高并发、专业向量检索 | 组件多、运维复杂 |
| Elasticsearch / OpenSearch | 向量 + 倒排**混合检索一体**，已有 ES 可复用 | 已有 ES、重视关键词与过滤，见 [Elasticsearch 原理](#/mw/es) | 向量性能与成本需评估 |
| Qdrant / Weaviate | 轻量易用、过滤能力好 | 中等规模、快速上线 | 生态与运维体系需评估 |
| Redis（向量检索） | 内存级低延迟 | 小规模、需要极低延迟的缓存式检索 | 内存成本 |
| 云托管向量服务 | 免运维 | 不想运维 | 数据合规与成本 |

选型建议：**先用 pgvector 或已有的 ES 起步**（少引入组件），数据量和 QPS 上来后再评估专用向量库；向量库只是检索层，**数据的“真相源”仍应在业务库/对象存储**，向量可随时重建。

### pgvector 示例

```sql
CREATE EXTENSION vector;
CREATE TABLE kb_chunk (
  id        bigserial PRIMARY KEY,
  doc_id    bigint NOT NULL,
  content   text   NOT NULL,
  acl       text[] NOT NULL,                 -- 权限标签
  updated   timestamptz NOT NULL DEFAULT now(),
  embedding vector(1024) NOT NULL
);
CREATE INDEX ON kb_chunk USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

SET hnsw.ef_search = 100;                    -- 调节召回/延迟
SELECT id, content, 1 - (embedding <=> $1) AS score
FROM kb_chunk
WHERE acl && ARRAY['dept:finance','public']  -- 元数据预过滤
ORDER BY embedding <=> $1 LIMIT 20;
```

> [!WARNING] 过滤与 ANN 的相互作用
> ANN 索引先取近邻再做过滤，**过滤条件很严格时可能返回结果不足**（候选被过滤光）。对策：增大 `ef_search`；使用支持“过滤感知”的索引/版本（如 pgvector 较新版本的迭代扫描、Milvus 的标量过滤）；**按租户/权限分区或分表**；或用较大的 K 再过滤。务必用**带过滤条件的真实查询**评估召回。

## 混合检索与融合

向量检索与关键词检索（BM25）各有所长：

| | 向量（语义） | BM25（词匹配） |
| --- | --- | --- |
| 擅长 | 同义、改写、模糊表达 | **精确词、编号、专有名词、缩写** |
| 弱点 | 编号/型号/罕见词 | 同义词、语义相近但用词不同 |

**RRF（Reciprocal Rank Fusion，倒数排名融合）**：不依赖分数（不同检索器分数不可比），只看**名次**：

```text
score(d) = Σ  1 / (k + rank_i(d))        k 通常取 60；rank_i 是文档 d 在第 i 个检索结果中的名次
```

```java
Map<String, Double> fused = new HashMap<>();
for (List<Hit> list : List.of(vectorHits, bm25Hits)) {
    for (int rank = 0; rank < list.size(); rank++) {
        fused.merge(list.get(rank).id(), 1.0 / (60 + rank + 1), Double::sum);
    }
}
List<String> candidates = fused.entrySet().stream()
        .sorted(Map.Entry.<String, Double>comparingByValue().reversed()).limit(30).map(Map.Entry::getKey).toList();
```

也可对分数归一化后加权求和（需要调权重，不如 RRF 稳健）。

## 重排（Rerank）

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="两阶段检索：召回阶段用双塔向量快速取大量候选，重排阶段用交叉编码器精排">
<rect class="b3" x="20" y="60" width="200" height="90" rx="10"/>
<text class="tb" x="120" y="84" text-anchor="middle" dominant-baseline="middle">第一阶段：召回</text>
<text class="ts" x="120" y="106" text-anchor="middle">双塔：问题与文档各自编码</text>
<text class="ts" x="120" y="126" text-anchor="middle">向量索引，毫秒级，Top-50</text>
<rect class="b5" x="280" y="60" width="200" height="90" rx="10"/>
<text class="tb" x="380" y="84" text-anchor="middle" dominant-baseline="middle">第二阶段：重排</text>
<text class="ts" x="380" y="106" text-anchor="middle">交叉编码器：问题+文档一起输入</text>
<text class="ts" x="380" y="126" text-anchor="middle">逐对打分，较慢但更准</text>
<rect class="b2" x="540" y="60" width="180" height="90" rx="10"/>
<text class="tb" x="630" y="84" text-anchor="middle" dominant-baseline="middle">送入大模型</text>
<text class="ts" x="630" y="106" text-anchor="middle">Top-3 ~ 8</text>
<text class="ts" x="630" y="126" text-anchor="middle">相关度低于阈值则拒答</text>
<line class="l" x1="220" y1="105" x2="280" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="105" x2="540" y2="105" marker-end="url(#arr)"/>
<text class="ts" x="370" y="190" text-anchor="middle">召回要“宽”（高 Recall），重排要“准”（高 Precision）；重排成本随候选数线性增长，通常只对 20~50 个候选精排</text>
</svg>
<figcaption>图 2：召回 + 重排的两阶段检索</figcaption>
</figure>

- **双塔（Bi-Encoder）**：问题和文档各自编码为向量，可**离线预计算文档向量**，检索快，但无法捕捉问题与文档的细粒度交互；
- **交叉编码器（Cross-Encoder）**：把“问题 + 文档”拼在一起输入模型直接输出相关分，**更准但慢**，只能用于小候选集；
- 重排模型可选开源（如 bge-reranker 系列）或厂商 API；也可用 LLM 做重排（贵且慢）；
- 设置**相关度阈值**：低于阈值的片段不送入提示词，全部低于阈值则走拒答，**避免“硬凑资料”导致幻觉**。

## 查询优化

| 技术 | 做法 | 适用 |
| --- | --- | --- |
| **查询改写** | 结合对话历史改写为独立、完整的检索问题 | 多轮对话必备 |
| **Multi-Query** | LLM 生成 3~5 个不同表述，分别检索后合并去重 | 用户问法模糊 |
| **HyDE** | 先让 LLM 写一个“假设答案”，用它的向量去检索 | 问题短而抽象，与文档表述差异大 |
| **子问题拆解** | 把复合问题拆成多个独立问题，分别检索 | “对比 A 和 B 的区别” |
| **Step-back** | 先问更概括的问题获取背景知识 | 需要原理性背景 |
| **元数据过滤抽取** | 从问题中抽取时间、部门、产品等，转成过滤条件 | 范围明确的问题 |
| **路由** | 判断走 RAG、走工具/SQL、还是直接回答 | 多数据源 |

每种技术都会增加一次 LLM 调用（延迟与成本），要用评测集证明**确实带来增益**再上线。

## 生成阶段优化

- 上下文排序：相关度最高的放**首尾**，减轻“中间遗忘”；
- **上下文压缩**：对每个片段抽取与问题相关的句子（用小模型或规则），减少噪声与 Token；
- **引用与溯源**：片段带编号，答案要求标注，前端展示来源并可点击核对；
- **拒答与追问**：资料不足时说明缺什么、反问用户补充条件，而不是猜；
- 长答案使用**分步生成 + 校验**（先列要点再扩写）。

## Agentic RAG 与 GraphRAG

- **Agentic RAG**：把检索作为**工具**交给 Agent，由模型自己决定**是否检索、检索什么、检索几次、是否还需要补充**，适合多跳问题（“A 公司的供应商所在城市的天气？”）；代价是更多调用、不确定性更高，见 [Agent、工具调用与 MCP](#/ai/agent)；
- **GraphRAG**：从文档中抽取**实体与关系**构建知识图谱（常配合社区摘要），问答时结合图遍历与向量检索，擅长**全局性、关联性问题**（“这批合同里有哪些共同风险？”）；代价是**构建成本高**、图维护复杂，适合关系密集的领域（合规、供应链、医药）；
- 两者都是在基础 RAG 效果瓶颈明确后再引入的**增强手段**，不要一开始就上。

## 评估：建立度量闭环

### 评测集

收集或构造 **100~500 条**有代表性的问题，每条包含：**问题、标准答案、应命中的文档/片段 ID**。来源：真实用户日志（脱敏）、业务专家编写、用 LLM 基于文档生成再人工校验；要覆盖**常见问题、边界问题、无答案问题、多跳问题、权限问题**。

### 检索指标

| 指标 | 含义 |
| --- | --- |
| **Recall@K** | 前 K 个结果中包含正确片段的比例（最关键） |
| **Precision@K** | 前 K 个结果中相关的比例 |
| **MRR** | 第一个正确结果名次的倒数平均，反映“排得靠不靠前” |
| **nDCG@K** | 考虑相关度等级与位置的综合排序质量 |
| 命中率（Hit Rate） | 至少命中一个正确片段的问题占比 |

### 生成指标（可用 LLM-as-Judge 辅助，需抽样人工校准）

| 指标 | 含义 |
| --- | --- |
| **忠实度（Faithfulness）** | 答案中的陈述是否都能在检索资料中找到依据（衡量幻觉） |
| **答案相关性** | 答案是否回答了问题 |
| **上下文精确度/召回** | 送入模型的资料中有用部分的占比 / 是否覆盖了答题所需信息 |
| **答案正确率** | 与标准答案对比 |
| 拒答正确率 | 无答案问题是否正确拒答 |

开源工具如 **RAGAS**、TruLens、DeepEval 提供上述指标的实现。

### 优化流程

```text
1. 固定评测集与指标基线
2. 先优化检索：切分 → 混合检索 → 重排 → 查询改写（每次只改一项，对比 Recall@K / MRR）
3. 再优化生成：提示词、上下文排序、拒答规则（对比忠实度/正确率）
4. 线上：收集“点踩”和失败样例 → 回流进评测集 → 持续回归
```

> [!TIP] LLM-as-Judge 的使用要点
> 让强模型按明确评分标准给回答打分，可大规模自动化，但存在**偏好冗长、偏向自己风格**等偏差；用**人工标注的小样本校准**一致性，评分提示词也要版本化管理。

## 工程实践补充

- **增量更新与幂等**：以 `docId + 内容 hash` 判断变化，先删旧块再写新块；失败可重试；保留**版本号**便于回滚；
- **向量与文档解耦**：向量库只存检索所需字段，正文可回源；换 Embedding 模型时**双写新索引 → 对比评测 → 切换**；
- **多租户/权限**：检索时带租户与 ACL 过滤；**不同敏感级别分库**更稳妥；
- **缓存**：对高频问题缓存“问题 → 答案/检索结果”（语义缓存需要设置高相似度阈值并限定权限范围，防止错答和越权）；
- **监控**：召回为空率、拒答率、平均相关分、用户点赞/点踩、各阶段耗时、Token 成本；
- **容量**：HNSW 内存估算 ≈ `N × (d × 4 字节 + M × 2 × 4 字节左右)`，千万 × 1024 维约数十 GB，注意量化与分片。

## 相关阅读

- [文档解析与多模态 RAG（PDF、表格、OCR、图片）](#/ai/rag-parsing)：解析与结构感知切分
- [评测体系实战：数据集、LLM 评审与回归门禁](#/ai/eval)：评测集构建与回归门禁
- [案例：Text-to-SQL 数据分析助手设计详解](#/ai/case-text2sql)：结构化数据问答的另一条路线

## 面试追问

> [!QUESTION] HNSW 的原理是什么？有什么优缺点？
> 构建多层邻近图，上层稀疏用于快速逼近，底层稠密用于精细搜索，查询时自顶向下贪心跳转并用 ef_search 控制底层候选数。优点是召回高、延迟低、可增量插入；缺点是内存占用大、构建慢、删除更新会降低图质量。

> [!QUESTION] 为什么要做混合检索？RRF 是怎么融合的？
> 向量检索擅长语义但对编号、专有名词弱，BM25 擅长精确匹配，二者互补。RRF 只使用各检索结果的名次，按 1/(k+rank) 累加，避免不同检索器分数不可比的问题，简单稳健。

> [!QUESTION] 召回之后为什么还要重排？
> 召回用双塔向量快速取回候选，精度有限；重排用交叉编码器把问题和片段一起打分，更准但较慢，只对少量候选精排，提高送入大模型的资料质量并支持相关度阈值拒答。

> [!QUESTION] 如何评估一个 RAG 系统的效果？
> 先构建评测集（问题、标准答案、应命中片段），检索用 Recall@K、MRR、nDCG，生成用忠实度、答案相关性、正确率与拒答正确率，可用 LLM 辅助评分并抽样人工校准；每次改动只改一处并回归，线上失败样例回流到评测集。

> [!QUESTION] pgvector 与 Milvus 怎么选？
> 数据量在百万到千万级、已有 PostgreSQL、希望事务与元数据过滤一体时用 pgvector，运维简单；亿级以上、高并发、需要分布式与多种索引时用 Milvus 等专用库。向量可随时重建，业务库仍是数据真相源。
