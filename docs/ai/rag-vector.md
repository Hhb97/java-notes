---
level: 深入
tags: [RAG, Embedding, 向量检索, 对比学习, 余弦相似度, ANN, HNSW, IVF-PQ, 过滤检索, MMR, pgvector]
summary: 从第一性原理讲清 RAG 里“向量检索”的完整逻辑：嵌入模型怎么把文本变成向量、相似度与分数的含义、为什么必须近似以及 ANN 怎么搜、带条件过滤为什么会漏召回、Top-K 之后的阈值/去重/重排，以及如何度量并调优召回。
---

# RAG 向量检索逻辑：从文本到 Top-K（嵌入、相似度、ANN、过滤与调优）

> [!ABSTRACT] 核心要点
> - 向量检索的本质：**离线把每个片段编码成向量存好，在线只编码一次查询，再在向量空间里找离它最近的 K 个**。能这么快，前提是**双塔（Bi-Encoder）**结构：文档向量可以提前算好，不需要每次把问题和文档一起过模型。
> - 向量空间的“近”是**训练数据定义的相关**（对比学习拉近问答对），不是通用语义。领域黑话、编号、否定、数字这类信息天然弱，所以要**混合检索 + 重排**兜底。
> - 向量**归一化**后，余弦、内积、L2 三种度量的**排序完全一致**；相似度分数**不是概率**，不同模型的分布差异很大，**阈值必须在自己的数据上校准**。
> - 精确检索是 O(N·d)，必须用 **ANN**：HNSW 靠“贪心走图 + `ef_search` 个候选”，IVF-PQ 靠“先选桶再查表”。**召回率、延迟、内存**三者不可兼得，旋钮就是 `ef_search` / `nprobe` 与量化位数。
> - **条件过滤会破坏 ANN 的召回**（先近邻后过滤，候选被过滤光）。要按**条件命中比例**选后过滤、预过滤或图内过滤，权限与租户隔离尽量用**分区**。
> - Top-K 不是终点：还要**阈值、去重（MMR）、相邻块合并、重排**。调优先拿**精确检索当基准**量出 ANN 召回，再看端到端 Recall，不要靠感觉调参数。

## 一次检索到底发生了什么

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="向量检索链路：问题经前缀、嵌入、归一化得到查询向量，再经 ANN 索引取候选、原向量精排、过滤阈值，得到 Top-K">
<text class="ts" x="20" y="18">查询侧：问题 → 向量</text>
<rect class="b1" x="20" y="30" width="130" height="58" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle">用户问题</text>
<text class="ts" x="85" y="74" text-anchor="middle">年假怎么算？</text>
<rect class="b1" x="210" y="30" width="130" height="58" rx="8"/>
<text class="tb" x="275" y="52" text-anchor="middle">加任务前缀</text>
<text class="ts" x="275" y="74" text-anchor="middle">query: / 检索指令</text>
<rect class="b1" x="400" y="30" width="130" height="58" rx="8"/>
<text class="tb" x="465" y="52" text-anchor="middle">嵌入模型</text>
<text class="ts" x="465" y="74" text-anchor="middle">分词→编码→池化</text>
<rect class="b1" x="590" y="30" width="130" height="58" rx="8"/>
<text class="tb" x="655" y="52" text-anchor="middle">归一化</text>
<text class="ts" x="655" y="74" text-anchor="middle">得到单位向量 q</text>
<line class="l" x1="150" y1="59" x2="208" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="59" x2="398" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="59" x2="588" y2="59" marker-end="url(#arr)"/>
<line class="l" x1="655" y1="88" x2="655" y2="110"/>
<line class="l" x1="655" y1="110" x2="85" y2="110"/>
<line class="l" x1="85" y1="110" x2="85" y2="128" marker-end="url(#arr)"/>
<text class="ts" x="370" y="104" text-anchor="middle">q 交给索引</text>
<rect class="b2" x="20" y="130" width="130" height="58" rx="8"/>
<text class="tb" x="85" y="152" text-anchor="middle">ANN 索引</text>
<text class="ts" x="85" y="174" text-anchor="middle">取 ef_search 个候选</text>
<rect class="b2" x="210" y="130" width="130" height="58" rx="8"/>
<text class="tb" x="275" y="152" text-anchor="middle">精排距离</text>
<text class="ts" x="275" y="174" text-anchor="middle">候选用原向量重算</text>
<rect class="b3" x="400" y="130" width="130" height="58" rx="8"/>
<text class="tb" x="465" y="152" text-anchor="middle">过滤与阈值</text>
<text class="ts" x="465" y="174" text-anchor="middle">ACL、分数、去重</text>
<rect class="b3" x="590" y="130" width="130" height="58" rx="8"/>
<text class="tb" x="655" y="152" text-anchor="middle">Top-K 片段</text>
<text class="ts" x="655" y="174" text-anchor="middle">交给重排与提示词</text>
<line class="l" x1="150" y1="159" x2="208" y2="159" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="159" x2="398" y2="159" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="159" x2="588" y2="159" marker-end="url(#arr)"/>
<text class="ts" x="20" y="208">索引侧：向量 → 候选 → Top-K（文档向量早已离线算好并建好索引）</text>
<text class="ts" x="370" y="236" text-anchor="middle">耗时量级：嵌入 10~100 ms（远程 API 含网络）· ANN 1~10 ms · 精排与过滤通常不到 1 ms · 重排 50~300 ms</text>
</svg>
<figcaption>图 1：一次向量检索的完整链路（量级为经验值，随模型与硬件变化）</figcaption>
</figure>

每一步都藏着一个会影响召回的决定：

| 步骤 | 做什么 | 常见的坑 |
| --- | --- | --- |
| 加前缀 | 有些模型要求查询与文档使用**不同前缀**（如 E5 的 `query: ` / `passage: `，BGE 对查询加检索指令） | 前缀写错或入库、查询不一致，召回明显下降且**不报错** |
| 嵌入 | 分词 → Transformer 编码 → 池化（取 `[CLS]` 或 token 向量均值）成**一个**固定维度向量 | 超过最大长度被**静默截断**；整块被“平均”成一个点，长块语义发糊 |
| 归一化 | 把向量缩放到长度 1 | 入库归一化、查询没归一化，用内积索引时排序错乱 |
| ANN 取候选 | 在索引里找近似最近邻 | 召回率不是 100%，可能漏掉真正的最近邻 |
| 精排 | 候选用**原始向量**重算精确距离并排序（量化索引尤其需要） | 只用量化后的距离排序，Top-K 内部顺序不准 |
| 过滤与阈值 | ACL、时间、类型等条件，分数阈值，去重 | 过滤放在 ANN **之后**，结果可能不足（见后文） |

## 向量是怎么来的：嵌入模型

### 双塔结构与对比学习

检索用的嵌入模型几乎都是**双塔（Bi-Encoder）**：问题和文档**各自独立**过编码器，得到向量，再算相似度。它和交叉编码器（Cross-Encoder，把问题和文档拼在一起过一次模型打分）的取舍是：

| | 双塔（嵌入模型） | 交叉编码器（重排模型） |
| --- | --- | --- |
| 文档向量 | **可离线预算并建索引** | 无，必须每对现算 |
| 在线代价 | 编码一次查询 + 索引查找 | 每个候选都要过一次模型 |
| 精度 | 较低（信息被压成一个向量） | 更高（问题与文档 token 间做交互注意力） |
| 用途 | **召回**（百万级里找几十个） | **重排**（几十个里挑几个） |

训练目标是**对比学习**：拉近（问题，相关段落），推远其他样本。典型的 InfoNCE 损失：

```text
L = -log(  exp(s(q, d+) / τ)  /  ( exp(s(q, d+) / τ) + Σ exp(s(q, d-) / τ) )  )

s     ：相似度，通常是余弦
d+    ：与 q 相关的正例段落
d-    ：负例：同一批次里别人的正例（in-batch negatives）＋专门挖掘的难负例（长得像但不相关）
τ     ：温度，常见取值在 0.01~0.05，越小越强调“把正例和最像的负例拉开”
```

这解释了很多现象：

- 向量空间里的“近”，是**训练数据里定义的相关**：训练数据以通用问答、网页检索为主，所以对法条编号、设备型号、内部缩写、代码标识符这类**分布外**内容效果差。对策是**混合检索（BM25）**或用自己的（问题，段落）对**微调嵌入模型**，见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced) 与 [微调实战](#/ai/finetune)。
- **查询与文档不对称**：问题短、文档长，说法也不同（“年假怎么算” 对 “职工累计工作满一年不满十年的，年休假五天”）。模型为此学了前缀与指令；工程上还可以**让 LLM 给每个片段预生成几个“它能回答的问题”一起入库**（假设性问题索引），把“问题对段落”的匹配变成“问题对问题”，通常能明显提升召回。
- 向量是**整块文本的一个点**：块越长越像“平均语义”，块越短越缺上下文。切分策略直接决定向量质量，见 [RAG 原理与完整流水线](#/ai/rag)。

### 维度、截断与模型即坐标系

- **维度**：常见 384、768、1024、1536、3072 等。维度越高，存储与计算越大，效果不一定同比提升。部分模型用 **Matryoshka（套娃）训练**，允许**截取前 d' 维再重新归一化**使用（如 1024 截到 256，存储缩小 4 倍，召回略降；仅限训练时支持该特性的模型，如 OpenAI `text-embedding-3` 的 `dimensions` 参数）。
- **最大输入长度**：常见 512 或 8192 token（如 BGE-M3 支持 8192）。超出部分被丢弃，切分块要**小于**它。
- **模型就是坐标系**：不同模型、版本、维度、前缀产生的向量**不在同一空间**，**不能混用**。换模型意味着**全量重新向量化并重建索引**。工程上在元数据里记录 `embedding_model` 版本，用**蓝绿索引**（新索引建好、回放验证后切换别名）平滑迁移，而不是原地覆盖。

## 相似度：数学与分数的含义

```text
余弦    cos(a, b) = a·b / (‖a‖ ‖b‖)                  只看方向，不看长度
内积    a·b = Σ aᵢbᵢ                                  计算最省，没有除法和开方
欧氏    ‖a − b‖² = ‖a‖² + ‖b‖² − 2 a·b
当 ‖a‖ = ‖b‖ = 1 时：   ‖a − b‖² = 2 − 2·cos(a, b)    三者排序完全一致
```

一个手算例子（二维，已归一化）：查询 `q = (0.6, 0.8)`

| 文档向量 | cos = a·b | L2² = 2 − 2cos | 排名 |
| --- | --- | --- | --- |
| d1 = (0.8, 0.6) | 0.96 | 0.08 | 1 |
| d2 = (0, 1) | 0.80 | 0.40 | 2 |
| d3 = (−0.6, 0.8) | 0.28 | 1.44 | 3 |

所以**入库时把向量归一化**，之后用**内积**（最省）或余弦都行；索引创建时的度量必须和查询使用的度量**一致**，否则要么不走索引，要么排序错。pgvector 的对应关系：

| 度量 | 查询运算符 | 索引 opclass |
| --- | --- | --- |
| 余弦距离（1 − cos） | `<=>` | `vector_cosine_ops` |
| 负内积 | `<#>` | `vector_ip_ops` |
| 欧氏距离 | `<->` | `vector_l2_ops` |

> [!WARNING] 相似度分数不是概率，也不能跨模型比较
> - 余弦 0.7 在某个模型里可能是“高度相关”，在另一个模型里只是“噪声”。很多模型存在**各向异性**：无关文本的余弦也常常偏高（如 0.6 以上），区分度挤在一个很窄的区间里。
> - 所以**固定阈值（如 0.75）不能照抄**：要在自己的评测集上，分别画出“相关 / 不相关”样本的分数分布，再选阈值；**换模型后必须重新校准**。
> - 高维空间里还有**距离集中**现象：最近与最远邻居的距离差很小，Top-1 与 Top-50 的分数可能只差零点几。分数差很小时，Top-K 内部排序不可信，应交给重排模型。

## 为什么必须近似，ANN 又怎么搜

### 精确检索的成本

精确检索（Flat）要对**每个**文档向量算一次距离，复杂度 **O(N·d)**。100 万条 × 1024 维 ≈ 每次查询 10⁹ 次乘加，单核大致在百毫秒到秒的量级；高并发下根本不可行。内存同样是硬约束：

| 存储方式 | 每向量字节（d=1024） | 1000 万向量 | 说明 |
| --- | --- | --- | --- |
| float32 | 4096 | 约 41 GB | 原始精度 |
| float16 | 2048 | 约 20 GB | 召回几乎无损 |
| int8（SQ8） | 1024 | 约 10 GB | 标量量化，召回略降 |
| PQ（64 段 × 8 bit） | 64 | 约 0.64 GB | 乘积量化，压缩 64 倍，召回下降较明显，需**精排修正** |
| 二值（1 bit/维） | 128 | 约 1.3 GB | 汉明距离极快，通常配合**原向量重排** |

HNSW 的图（每点底层最多 `2·M` 条边，`M=16` 时约 128 B/向量）通常只占向量本身的几个百分点到一成，**大头仍是向量**；向量被量化后，图的占比才会明显上升。

### 三类思路

| 思路 | 代表 | 怎么缩小搜索范围 | 取舍 |
| --- | --- | --- | --- |
| 图 | **HNSW**、DiskANN（Vamana） | 沿邻近图贪心走向查询点 | 召回高、延迟低，内存大，构建慢 |
| 聚类分桶 | **IVF**（IVF_FLAT / IVF_PQ） | 先找最近的 `nprobe` 个簇，只扫这些簇 | 省内存、构建快，要训练质心，召回依赖 `nprobe` |
| 压缩 | **SQ / PQ / 二值** | 不减少候选，而是让**每次距离计算更便宜**、向量更小 | 有量化误差，常与前两类组合 |

HNSW 的分层结构与参数含义见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced)，这里只讲**查询时的搜索逻辑**，这是理解 `ef_search` 的关键。

### HNSW 第 0 层：best-first 搜索

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="HNSW 底层搜索：从入口节点贪心走向查询点附近，用结果集和候选队列扩展邻居直到无法改进">
<text class="th" x="20" y="24">第 0 层：容量为 ef_search 的 best-first 搜索</text>
<circle class="bg nf" cx="440" cy="150" r="72"/>
<line class="l" x1="50" y1="235" x2="130" y2="190"/>
<line class="l" x1="50" y1="235" x2="225" y2="205"/>
<line class="l" x1="130" y1="190" x2="215" y2="120"/>
<line class="l" x1="130" y1="190" x2="225" y2="205"/>
<line class="l" x1="215" y1="120" x2="305" y2="80"/>
<line class="l" x1="215" y1="120" x2="315" y2="160"/>
<line class="l" x1="225" y1="205" x2="315" y2="160"/>
<line class="l" x1="225" y1="205" x2="310" y2="250"/>
<line class="l" x1="315" y1="160" x2="310" y2="250"/>
<line class="l" x1="315" y1="160" x2="400" y2="105"/>
<line class="l" x1="315" y1="160" x2="405" y2="205"/>
<line class="l" x1="305" y1="80" x2="400" y2="105"/>
<line class="l" x1="310" y1="250" x2="405" y2="205"/>
<line class="l" x1="400" y1="105" x2="485" y2="185"/>
<line class="l" x1="405" y1="205" x2="485" y2="185"/>
<line class="la" x1="60.5" y1="229.1" x2="119.5" y2="195.9" marker-end="url(#arr-a)"/>
<line class="la" x1="141.8" y1="191.9" x2="213.2" y2="203.1" marker-end="url(#arr-a)"/>
<line class="la" x1="235.7" y1="199.6" x2="304.3" y2="165.4" marker-end="url(#arr-a)"/>
<line class="la" x1="325.1" y1="153.5" x2="389.9" y2="111.5" marker-end="url(#arr-a)"/>
<line class="la" x1="325.7" y1="165.4" x2="394.3" y2="199.6" marker-end="url(#arr-a)"/>
<circle class="b3" cx="50" cy="235" r="10"/>
<circle class="b1" cx="130" cy="190" r="10"/>
<circle class="b1" cx="215" cy="120" r="10"/>
<circle class="b1" cx="225" cy="205" r="10"/>
<circle class="b1" cx="305" cy="80" r="10"/>
<circle class="b2" cx="315" cy="160" r="10"/>
<circle class="b1" cx="310" cy="250" r="10"/>
<circle class="b2" cx="400" cy="105" r="10"/>
<circle class="b2" cx="405" cy="205" r="10"/>
<circle class="b2" cx="485" cy="185" r="10"/>
<circle class="b4" cx="440" cy="150" r="12"/>
<text class="tb" x="440" y="150" text-anchor="middle" dominant-baseline="middle">q</text>
<text class="ts" x="50" y="262" text-anchor="middle">入口</text>
<text class="ts" x="440" y="236" text-anchor="middle">q 的近邻区域</text>
<rect class="bg" x="530" y="20" width="190" height="265" rx="10"/>
<text class="tb" x="545" y="46">结果集 W（容量 ef）</text>
<text class="ts" x="545" y="66">当前找到的最近 ef 个点</text>
<text class="tb" x="545" y="98">候选队列 C（小顶堆）</text>
<text class="ts" x="545" y="118">按距离排，取最近未展开点</text>
<text class="tb" x="545" y="150">循环</text>
<text class="ts" x="545" y="170">① 取 C 中最近的点 c</text>
<text class="ts" x="545" y="188">② 看 c 的全部邻居</text>
<text class="ts" x="545" y="206">③ 够近的同时放进 W、C</text>
<text class="tb" x="545" y="238">停止条件</text>
<text class="ts" x="545" y="258">c 比 W 里最远的点还远</text>
<circle class="b3" cx="28" cy="287" r="5"/>
<text class="ts" x="38" y="291">入口</text>
<circle class="b1" cx="88" cy="287" r="5"/>
<text class="ts" x="98" y="291">已访问</text>
<circle class="b2" cx="168" cy="287" r="5"/>
<text class="ts" x="178" y="291">在结果集 W 中</text>
<circle class="b4" cx="278" cy="287" r="5"/>
<text class="ts" x="288" y="291">查询 q</text>
</svg>
<figcaption>图 2：沿邻近图贪心逼近 q，再在 q 附近用 ef_search 大小的结果集扩展邻居，直到不能再改进</figcaption>
</figure>

```java
// HNSW 第 0 层搜索（示意，对应 hnswlib 的 searchBaseLayerST；上层只负责挑一个好入口）
List<Node> searchLayer0(float[] q, Node entry, int ef) {
    PriorityQueue<Cand> candidates = new PriorityQueue<>(byDistAsc);   // 待展开：最近的在堆顶
    PriorityQueue<Cand> results    = new PriorityQueue<>(byDistDesc);  // 结果集 W：最远的在堆顶，容量 ef
    Set<Node> visited = new HashSet<>(List.of(entry));
    Cand e = new Cand(entry, dist(q, entry));
    candidates.add(e);
    results.add(e);

    while (!candidates.isEmpty()) {
        Cand c = candidates.poll();                                    // 当前最近的未展开点
        if (c.dist > results.peek().dist && results.size() >= ef) {
            break;                                                      // 最近的候选都比结果集里最远的还远：无法改进，停止
        }
        for (Node nb : c.node.neighbors(0)) {
            if (!visited.add(nb)) continue;                             // 每个点只算一次距离
            double d = dist(q, nb);
            if (results.size() < ef || d < results.peek().dist) {
                candidates.add(new Cand(nb, d));
                results.add(new Cand(nb, d));
                if (results.size() > ef) results.poll();                // 超过容量，踢掉最远的
            }
        }
    }
    return results.stream().sorted(byDistAsc).map(Cand::node).toList(); // 取前 K 个即为 Top-K
}
```

由此可以推出几个**调参直觉**：

- **`ef_search` 必须 ≥ K**：结果集容量就是 `ef`，容量比 K 小就根本凑不够 K 条；常见做法是 `ef_search` 取 K 的 2~10 倍。
- **`ef_search` 越大，探索越充分、召回越高，但距离计算次数近似线性增加**，延迟随之上升，且召回的边际收益递减（如从 100 提到 200，召回只多零点几个百分点）。
- 每访问一个点就算一次距离，访问点数大致与 `ef × M` 同量级，所以**延迟主要由 `ef_search`、`M`、维度共同决定**；量化让“一次距离”更便宜。
- **构建参数 `M` / `ef_construction` 决定图的质量上限**：图建得差，查询时再加大 `ef_search` 也救不回来，所以大规模导入前要先调好再建。

### IVF-PQ：先选桶，再查表

1. 训练：K-means 把数据聚成 `nlist` 个簇；PQ 把向量切成 `m` 段，每段再聚成 256 个中心，一段只存 1 字节编码（共 `m` 字节）。
2. 查询：先与 `nlist` 个质心比距离，选最近的 **`nprobe`** 个桶；
3. 桶内用 **ADC（非对称距离计算）**：先算好“查询的每一段到该段 256 个中心”的距离表（`m × 256`），桶内每个向量的距离就是 `m` 次**查表求和**，**不需要还原向量**，速度极快；
4. 量化有误差，所以常用 **PQ 粗排取 Top-(K×几倍)，再用原向量精排（rescore）** 修正顺序。

召回的短板是**簇边界**：查询点恰好落在两个簇交界处，真正的近邻可能在没选中的桶里，只能靠增大 `nprobe` 弥补；数据分布漂移后质心过期，也需要**重训**。

### 关键参数（以 pgvector 为例，默认值以所用版本为准）

| 参数 | 作用 | 默认 / 建议 |
| --- | --- | --- |
| `m`（HNSW） | 每点邻居数，决定图质量与内存 | 默认 16；召回不够再加到 32~64 |
| `ef_construction` | 建图候选队列，决定图质量与构建时间 | 默认 64；追求召回可到 128~200 |
| `hnsw.ef_search` | 查询候选队列，**召回/延迟的主旋钮** | 默认 40；通常要调大并配合评测 |
| `lists`（IVFFlat） | 簇数 | 百万行以内约 `rows / 1000`，更大约 `sqrt(rows)` |
| `ivfflat.probes` | 查询时扫描的簇数 | 默认 1，**通常太小**；可从 `sqrt(lists)` 起步 |
| 维度上限 | 索引对向量维度有上限 | `vector` 索引约 2000 维、`halfvec` 约 4000 维，超出要降维或换类型，见所用版本文档 |

## 带条件的检索：为什么会漏召回

RAG 里几乎每次检索都带条件：**权限（ACL）、租户、文档类型、时间范围**。ANN 索引是按**距离**组织的，对**标量条件**一无所知，两者叠加就出问题。

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="三种带过滤的向量检索策略：后过滤、预过滤、图内过滤，以及各自适合的条件命中比例">
<rect class="bg" x="20" y="14" width="220" height="276" rx="10"/>
<text class="tb" x="130" y="40" text-anchor="middle">后过滤 Post-filter</text>
<rect class="b1" x="35" y="58" width="190" height="42" rx="8"/>
<text class="tb" x="130" y="79" text-anchor="middle" dominant-baseline="middle">ANN 先取 Top-K'</text>
<rect class="b1" x="35" y="128" width="190" height="42" rx="8"/>
<text class="tb" x="130" y="149" text-anchor="middle" dominant-baseline="middle">再按条件过滤</text>
<rect class="b1" x="35" y="198" width="190" height="42" rx="8"/>
<text class="tb" x="130" y="219" text-anchor="middle" dominant-baseline="middle">剩余可能不足 K 条</text>
<line class="l" x1="130" y1="100" x2="130" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="170" x2="130" y2="196" marker-end="url(#arr)"/>
<text class="ta" x="130" y="262" text-anchor="middle">条件越严格越易返回不足</text>
<text class="ts" x="130" y="280" text-anchor="middle">命中比例高时最简单、最快</text>
<rect class="bg" x="260" y="14" width="220" height="276" rx="10"/>
<text class="tb" x="370" y="40" text-anchor="middle">预过滤 Pre-filter</text>
<rect class="b2" x="275" y="58" width="190" height="42" rx="8"/>
<text class="tb" x="370" y="79" text-anchor="middle" dominant-baseline="middle">标量索引选出 ID 集</text>
<rect class="b2" x="275" y="128" width="190" height="42" rx="8"/>
<text class="tb" x="370" y="149" text-anchor="middle" dominant-baseline="middle">在集合内精确计算</text>
<rect class="b2" x="275" y="198" width="190" height="42" rx="8"/>
<text class="tb" x="370" y="219" text-anchor="middle" dominant-baseline="middle">排序取 Top-K</text>
<line class="l" x1="370" y1="100" x2="370" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="170" x2="370" y2="196" marker-end="url(#arr)"/>
<text class="ta" x="370" y="262" text-anchor="middle">结果精确，不会漏</text>
<text class="ts" x="370" y="280" text-anchor="middle">集合很大时扫描变慢</text>
<rect class="bg" x="500" y="14" width="220" height="276" rx="10"/>
<text class="tb" x="610" y="40" text-anchor="middle">图内过滤 Filtered ANN</text>
<rect class="b3" x="515" y="58" width="190" height="42" rx="8"/>
<text class="tb" x="610" y="79" text-anchor="middle" dominant-baseline="middle">照常沿图路由</text>
<rect class="b3" x="515" y="128" width="190" height="42" rx="8"/>
<text class="tb" x="610" y="149" text-anchor="middle" dominant-baseline="middle">不满足条件不入结果</text>
<rect class="b3" x="515" y="198" width="190" height="42" rx="8"/>
<text class="tb" x="610" y="219" text-anchor="middle" dominant-baseline="middle">直到凑满 ef / K 条</text>
<line class="l" x1="610" y1="100" x2="610" y2="126" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="170" x2="610" y2="196" marker-end="url(#arr)"/>
<text class="ta" x="610" y="262" text-anchor="middle">中等命中比例最合适</text>
<text class="ts" x="610" y="280" text-anchor="middle">极严格时仍要回退预过滤</text>
</svg>
<figcaption>图 3：三种过滤策略：后过滤易漏召回，预过滤精确但可能慢，图内过滤折中</figcaption>
</figure>

- **后过滤最危险**：假设某用户只有 1% 的文档有权限，ANN 取 Top-100 后平均只剩 1 条，甚至 0 条，而真正有权限的相关片段排在 101 名之外，被**永远漏掉**。症状是“有权限的用户偶尔搜不到明明存在的文档”。
- **预过滤**先用标量索引（B-Tree、GIN）圈出符合条件的集合，**集合小就直接精确扫描**，既准又快；集合很大时扫描慢，才该走向量索引。
- **图内过滤**（Filtered ANN）：遍历时照常用所有点做路由，但**只把满足条件的点放进结果**，结果集凑够为止。主流向量库与较新的 pgvector 都提供：pgvector 0.8 起有 `hnsw.iterative_scan`（索引扫描后结果被过滤光时自动继续扫描，配合 `hnsw.max_scan_tuples` 限界），具体以所用版本文档为准。
- 经验上：**命中比例很低**（如 1% 以下）时，用预过滤加精确扫描往往最稳；**中等**时用图内过滤；**很高**时后过滤即可。让优化器按统计信息选路径，并**用带过滤条件的真实查询评估召回**。
- **权限与租户隔离，最好用分区（表分区或 Collection 隔离）解决**，而不是靠过滤：每个分区的索引只含该租户的数据，既没有漏召回，也避免跨租户泄露，见 [PostgreSQL 分区与扩展生态](#/pg/partition-ext)。

## Top-K 之后的逻辑

检索返回的只是“按相似度排的前 K 个”，到能放进提示词，还有几步：

**1. 阈值与“没有答案”**：设相似度下限，低于它的丢弃；Top-1 都低于阈值时，应走**拒答或澄清**，而不是硬把最不相关的片段塞给模型。阈值按上文的分数分布校准。

**2. 去重与多样性（MMR）**：Top-K 里常有大量**近重复**的片段（相邻块、多版本文档），塞满提示词却没增加信息。**MMR（Maximal Marginal Relevance）**每轮选“与查询相关、同时与已选的不太像”的片段：

```text
MMR = argmax_{d ∈ 候选 \ 已选}  [ λ · sim(d, q)  −  (1 − λ) · max_{p ∈ 已选} sim(d, p) ]
λ 越大越看重相关性，越小越看重多样性；常用 0.5~0.8
```

```java
// MMR：候选向量均已归一化，sim 用内积
static List<Chunk> mmr(float[] q, List<Chunk> candidates, int k, double lambda) {
    List<Chunk> picked = new ArrayList<>();
    List<Chunk> pool = new ArrayList<>(candidates);
    while (picked.size() < k && !pool.isEmpty()) {
        Chunk best = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (Chunk c : pool) {
            double relevance = dot(q, c.vector());
            double redundancy = picked.stream().mapToDouble(p -> dot(c.vector(), p.vector())).max().orElse(0);
            double score = lambda * relevance - (1 - lambda) * redundancy;
            if (score > bestScore) { bestScore = score; best = c; }
        }
        picked.add(best);
        pool.remove(best);
    }
    return picked;
}
```

**3. 邻近块合并与父子块**：用小块检索（精度高），命中后**取它所在的父块或前后相邻块**送给模型（上下文完整），即 small-to-big；同一文档的多个命中块要按原文顺序合并。

**4. 漏斗：召回宽、重排窄**：

| 阶段 | 数量级 | 目的 |
| --- | --- | --- |
| 向量 / BM25 召回 | 各 50~100 | 尽量**不漏**（看 Recall@K） |
| RRF 融合 | 合并去重 | 多路结果合一，见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced) |
| 交叉编码器重排 | 取 5~10 | 把**最相关**的排到前面（看 MRR、nDCG） |
| 拼装提示词 | 按相关度排布 | 最相关的放**首尾**，避免“中间遗忘” |

## 稠密、稀疏与多向量

一个“向量”并不是唯一选择。很多生产系统同时用几种表示：

| 表示 | 例子 | 擅长 | 短板 |
| --- | --- | --- | --- |
| 稠密向量 | 常规嵌入模型 | 语义、改写、跨语言 | 精确词、编号、专有名词弱 |
| 稀疏（词项） | BM25；学习型稀疏如 SPLADE | 精确词匹配、可解释 | 同义改写弱（BM25）；学习型稀疏索引更大 |
| 多向量（迟交互） | **ColBERT**：每个 token 一个向量，相似度取**每个查询 token 对文档 token 的最大相似度之和（MaxSim）** | 细粒度匹配，效果常优于单向量 | 存储与计算成倍增加，需要专门的索引 |

有的模型（如 BGE-M3）一次同时输出稠密、稀疏、多向量三种表示。实践中最稳的组合仍是**稠密 + BM25 混合检索再重排**；多向量适合对效果要求极高、规模可控的场景。

## 怎么度量并调优召回

检索有**两种**“召回”，要分开看：

- **ANN 召回率**：近似索引的 Top-K，和**精确检索**的 Top-K 重合多少。它只衡量“**索引丢了多少**”，调 `ef_search` / `nprobe` / 量化就是为了抬它；
- **端到端检索 Recall@K**：Top-K 里有没有**人工标注的相关片段**。它衡量**整个检索链路**（切分、嵌入、混合、过滤）的好坏。

即使 ANN 召回 100%，嵌入模型本身不理解你的问题，端到端 Recall 依然低；反过来，先把 ANN 召回调到 95% 以上，才能排除“索引丢数据”这个干扰项。测 ANN 召回用精确检索当基准：

```sql
-- 1) 精确结果：关闭索引扫描，强制顺序扫描逐行计算（作为基准）
BEGIN;
SET LOCAL enable_indexscan = off;
SELECT id FROM kb_chunk ORDER BY embedding <=> $1 LIMIT 10;
COMMIT;

-- 2) 近似结果：走 HNSW
SET hnsw.ef_search = 100;
SELECT id FROM kb_chunk ORDER BY embedding <=> $1 LIMIT 10;

-- 抽 500~1000 个真实查询，ANN 召回@10 = 平均 |近似 ∩ 精确| / 10；逐步调大 ef_search 直到收益变小
```

```java
// 通过 Spring AI 的 VectorStore 检索：Top-K、阈值与过滤条件都在 SearchRequest 里（详见 Spring AI 一页）
List<Document> hits = vectorStore.similaritySearch(SearchRequest.builder()
        .query(question)
        .topK(50)                                   // 召回宽一点，后面重排
        .similarityThreshold(0.55)                  // 阈值要按自己的模型和数据校准
        .filterExpression("tenant == 'acme' && year >= 2023")
        .build());
```

调优顺序建议：

1. 先确认**入库与查询的前缀、归一化、模型版本一致**；
2. 量出 **ANN 召回**，不到 95% 先调 `ef_search` / `nprobe`；
3. 再用评测集看**端到端 Recall@K**，不够就看切分、混合检索、查询改写、嵌入模型（是否需要微调）；
4. 最后调阈值、K、重排，见 [评测体系实战](#/ai/eval)。

## 生产实践与踩坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 换了嵌入模型后召回崩了 | 新旧向量不在同一空间，混在一个索引里 | 元数据记录模型版本；**全量重建并蓝绿切换** |
| 查询明明有答案却搜不到 | 前缀/指令用错，或查询端没有加前缀 | 入库与查询统一封装，**单元测试固定前缀** |
| 同一查询结果顺序抖动 | 量化后只用近似距离排序；分数差极小 | 候选用**原向量精排**，Top-K 内部交给重排模型 |
| 加了 ACL 后结果经常少于 K 条 | 后过滤把候选过滤光 | 开启迭代扫描/图内过滤，或**按租户分区** |
| 索引建好却没走索引，慢 | 度量与 opclass 不一致，或数据量很小优化器选顺序扫描 | `EXPLAIN` 确认；小于约万级数据**不必建 ANN 索引** |
| 删除/更新大量数据后召回下降 | HNSW 删除是标记，图质量退化；IVF 质心过期 | 定期**重建索引**（`REINDEX` / 新建后切换）；IVF 重训质心 |
| 批量导入极慢 | 边写边维护图索引 | **先导入数据，再建索引**；提高 `maintenance_work_mem`，建索引并行 |
| 长文档后半部分搜不到 | 超出模型最大输入被静默截断 | 切分块长度 **小于模型上限**，入库时校验 token 数 |
| 型号、编号、人名搜不到 | 稠密向量对精确词弱 | **混合检索 + BM25**，或给片段加关键词字段 |
| 召回内存暴涨、OOM | 向量与图常驻内存，估算不足 | 按上面的表**先估算**；用 float16/SQ8/PQ 压缩，或换磁盘友好索引 |
| 换了分数阈值后线上拒答激增 | 不同模型/版本分数分布不同 | 阈值与模型版本绑定，改模型必须重新校准 |

## 相关阅读

- [RAG 原理与完整流水线](#/ai/rag)：入库与问答的整体流程，切分对向量质量的影响
- [RAG 检索优化、向量库与评估](#/ai/rag-advanced)：HNSW 结构、向量库选型、混合检索与 RRF、重排
- [文档解析与多模态 RAG（PDF、表格、OCR、图片）](#/ai/rag-parsing)：向量化之前的解析与切分
- [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)：`VectorStore` 与检索代码
- [PostgreSQL 分区与扩展生态](#/pg/partition-ext)：pgvector 与分区隔离

## 面试追问

> [!QUESTION] 向量检索为什么快？它和重排模型有什么区别？
> 嵌入模型是双塔：文档向量离线预算并建索引，在线只编码一次查询，再在索引里找近邻，所以能在百万级数据上毫秒级返回；但文档信息被压成一个向量，精度有限。重排用的交叉编码器把问题和文档拼在一起过模型，能做 token 级交互，精度更高，却要对每个候选现算一次，只能用在几十个候选上。所以是“向量召回宽，重排精”的漏斗。

> [!QUESTION] 余弦相似度、内积、欧氏距离怎么选？
> 向量归一化后三者排序完全一致，因为 ‖a−b‖² = 2 − 2cos(a,b)。所以入库时归一化，用内积最省（没有除法和开方）。关键是索引的度量与查询的度量必须一致，否则索引用不上或排序错。不归一化时，内积会偏向模长大的向量，通常不是想要的结果。

> [!QUESTION] 相似度阈值怎么定？为什么不能直接用 0.8？
> 相似度分数不是概率，不同模型的分布差别很大，有的模型无关文本的余弦也有 0.6 以上。要在自己的评测集上分别统计相关与不相关样本的分数分布，选能兼顾召回和精度的阈值，并且阈值要和模型版本绑定，换模型后重新校准。

> [!QUESTION] HNSW 的 ef_search 是怎么影响召回和延迟的？
> 查询在底层用大小为 ef 的结果集做 best-first 搜索：反复取最近的候选，展开它的邻居，够近的就放进结果集，直到最近的候选已经比结果集里最远的还远。ef 越大探索越充分、召回越高，但访问的点数近似线性增加，延迟上升，收益递减。ef 必须不小于 K。图本身的质量由 M 和 ef_construction 决定，建差了查询时调大 ef 也救不回来。

> [!QUESTION] 带权限过滤的向量检索为什么会漏结果？怎么解决？
> ANN 索引按距离组织，不认识标量条件。先取近邻再过滤，如果条件命中比例很低，候选基本被过滤光，真正有权限的相关片段可能排在候选之外，永远搜不到。解决方式按命中比例选：很低用预过滤加精确扫描，中等用图内过滤（遍历时只把满足条件的放进结果）或迭代扫描，很高才用后过滤；多租户、权限边界清晰时直接用分区隔离，既不漏召回也更安全。

> [!QUESTION] 怎么判断 RAG 检索差是索引的问题还是模型的问题？
> 先量 ANN 召回：用精确检索（顺序扫描）作基准，看近似索引的 Top-K 重合度，不到 95% 就先调 ef_search、nprobe 或量化。ANN 召回正常而端到端 Recall@K 仍低，说明问题在检索链路本身：切分是否合理、嵌入模型是否适合领域、是否需要混合检索、查询是否要改写、是否需要微调嵌入模型。把两个指标分开，才不会在错误的地方调参数。

> [!QUESTION] 换嵌入模型要注意什么？
> 新旧向量不在同一空间，不能混用，必须全量重新向量化并重建索引。做法是元数据里记录模型版本，新建索引并回放验证（离线评测集对比 Recall/MRR），通过别名或开关切换，保留旧索引一段时间以便回滚。同时要重新校准分数阈值，核对前缀、最大长度和维度是否变化。
