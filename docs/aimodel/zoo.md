---
level: 基础
tags: [模型家族, Embedding, Word2Vec, 自编码器, VAE, GAN, 扩散模型, GNN, 强化学习, 决策树, K-Means, CLIP]
summary: 一张“AI 模型地图”：按数据类型与任务梳理主要模型家族，并用通俗的比喻讲清 Embedding、自编码器/VAE、GAN、扩散模型、图神经网络、强化学习、树模型与聚类各自的思想、擅长什么、典型应用。
---

# 模型家族地图：Embedding、VAE、GAN、扩散、GNN、强化学习

> [!ABSTRACT] 一句话版本
> AI 模型像不同的工具：**没有“最强”的模型，只有“最合适”的模型**。选择取决于**你的数据长什么样（表格？图像？文本？图？）以及要做什么（预测？生成？决策？）**。
> - 表格数据：**树模型（XGBoost）** 常是首选；
> - 图像：**CNN / ViT**；文本与大多数序列：**Transformer**；
> - 生成图片：**扩散模型**（也有 GAN/VAE）；
> - 关系网络（社交、分子）：**图神经网络**；
> - 要“做决策、与环境互动”：**强化学习**；
> - 把任何东西变成向量用于检索与比较：**Embedding**。

> [!NOTE] 阅读方式
> 前面已经详细讲了 MLP、CNN、RNN、Transformer、LLM。本页帮你把**其它重要家族**放进同一张地图，每个只讲“思想 + 擅长什么 + 例子”，不做数学推导。

## 一、总地图：按数据类型选模型

<figure class="fig">
<svg viewBox="0 0 780 420" class="dg" role="img" aria-label="按数据类型的模型地图：表格数据用树模型和 MLP，图像用 CNN、ViT 与扩散，文本用 Transformer 与 LLM，序列用 RNN 与 Transformer，图结构用 GNN，决策用强化学习，任意数据可用 Embedding 与自编码器做表示">
<rect class="b1" x="20" y="20" width="360" height="70" rx="10"/>
<text class="th" x="36" y="44">表格数据（Excel 式行列）</text>
<text class="ts" x="36" y="68">树模型 XGBoost/LightGBM · 线性/逻辑回归 · MLP</text>
<rect class="b3" x="400" y="20" width="360" height="70" rx="10"/>
<text class="th" x="416" y="44">图像 / 视频</text>
<text class="ts" x="416" y="68">CNN · Vision Transformer · 目标检测 YOLO · 扩散模型（生成）</text>
<rect class="b5" x="20" y="110" width="360" height="70" rx="10"/>
<text class="th" x="36" y="134">文本 / 代码</text>
<text class="ts" x="36" y="158">Transformer · 大语言模型 LLM · BERT 嵌入</text>
<rect class="b2" x="400" y="110" width="360" height="70" rx="10"/>
<text class="th" x="416" y="134">序列 / 时间序列 / 音频</text>
<text class="ts" x="416" y="158">Transformer · LSTM/GRU · 一维 CNN · 状态空间模型（Mamba）</text>
<rect class="b4" x="20" y="200" width="360" height="70" rx="10"/>
<text class="th" x="36" y="224">图结构（社交网络、分子、知识图谱）</text>
<text class="ts" x="36" y="248">图神经网络 GNN · 知识图谱嵌入</text>
<rect class="bg" x="400" y="200" width="360" height="70" rx="10"/>
<text class="th" x="416" y="224">需要“做决策”的任务</text>
<text class="ts" x="416" y="248">强化学习（游戏、机器人、推荐策略、LLM 对齐）</text>
<rect class="b1" x="20" y="290" width="740" height="110" rx="12"/>
<text class="th" x="36" y="314">横向的“通用能力”</text>
<text class="ts" x="36" y="340">• 表示学习：Embedding、自编码器/VAE —— 把数据压成有意义的向量，用于检索、聚类、推荐、降维</text>
<text class="ts" x="36" y="362">• 生成模型：LLM（文字）、扩散/GAN/VAE（图像等）—— 学会“数据的分布”，能创造新样本</text>
<text class="ts" x="36" y="384">• 多模态：CLIP、GPT-4V 类 —— 把图文等放进同一个向量空间一起理解</text>
</svg>
<figcaption>图 1：按数据类型与任务选模型的大致地图</figcaption>
</figure>

模型也可按“任务性质”分：

| 任务类型 | 含义 | 代表模型 |
| --- | --- | --- |
| **判别式（Discriminative）** | 给定输入，**判断/预测**（是什么？多少？） | 逻辑回归、CNN 分类、BERT 分类 |
| **生成式（Generative）** | **学习数据分布并创造新样本** | LLM、扩散模型、GAN、VAE |
| **表示学习** | 学出好的**向量表示** | Embedding、自编码器、对比学习 |
| **决策/控制** | 在环境中**选择动作**以最大化回报 | 强化学习 |

## 二、Embedding（嵌入）：把一切变成向量

### 思想

把**文字、图片、商品、用户**等“离散的东西”映射成一个**稠密向量**，使得**含义相近的东西，向量也相近**。**点积/余弦相似度**（见 [线性代数 1：向量与矩阵](#/aimodel/math-la1)）就是“相似度尺子”。

### 经典：Word2Vec

让模型根据上下文预测词（或根据词预测上下文），**训练的副产品就是词向量**。它们竟然出现了神奇的代数关系：

```text
向量(国王) − 向量(男人) + 向量(女人)  ≈  向量(女王)
向量(巴黎) − 向量(法国) + 向量(意大利) ≈  向量(罗马)
```

### 现代：句子/文档嵌入、多模态嵌入

- **文本嵌入模型**（BERT 类、专用 embedding 模型）把整段话压成一个向量，用于**语义搜索、RAG、聚类、去重、推荐**，见 [RAG 原理与完整流水线](#/ai/rag)；
- **CLIP**：同时训练**图像编码器和文本编码器**，让“一张猫的图片”和“一只猫的照片”的向量靠近——于是可以**用文字搜图片**、零样本分类；
- 推荐系统里的**用户/物品嵌入**：向量越近，越可能喜欢。

**向量检索**：把海量向量存进向量数据库，查询时找**最近邻**，见 [RAG 检索优化、向量库与评估](#/ai/rag-advanced)。

## 三、自编码器与 VAE：学会“压缩与还原”

### 自编码器（Autoencoder）

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="自编码器：编码器把输入压缩成低维的潜在向量，解码器再把它还原，训练目标是让还原结果尽量接近输入">
<rect class="b1" x="20" y="60" width="90" height="110" rx="8"/>
<text class="tb" x="65" y="108" text-anchor="middle" dominant-baseline="middle">输入</text>
<text class="ts" x="65" y="130" text-anchor="middle">如 784 维</text>
<polygon class="b3" points="150,50 150,180 260,100 260,130"/>
<text class="tb" x="195" y="118" text-anchor="middle" dominant-baseline="middle">编码器</text>
<rect class="b5" x="290" y="95" width="70" height="40" rx="6"/>
<text class="tb" x="325" y="115" text-anchor="middle" dominant-baseline="middle">z</text>
<text class="ts" x="325" y="154" text-anchor="middle">潜在向量(如 16 维)</text>
<polygon class="b3" points="390,100 390,130 500,50 500,180"/>
<text class="tb" x="445" y="118" text-anchor="middle" dominant-baseline="middle">解码器</text>
<rect class="b2" x="540" y="60" width="90" height="110" rx="8"/>
<text class="tb" x="585" y="108" text-anchor="middle" dominant-baseline="middle">重建</text>
<text class="ts" x="585" y="130" text-anchor="middle">应接近输入</text>
<line class="l" x1="110" y1="115" x2="150" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="115" x2="290" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="115" x2="390" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="115" x2="540" y2="115" marker-end="url(#arr)"/>
<text class="ts" x="380" y="206" text-anchor="middle">训练：让“重建”≈“输入”（损失 = 两者的差）。中间的瓶颈 z 被迫只保留最重要的信息</text>
<text class="ts" x="380" y="226" text-anchor="middle">用途：降维、去噪、异常检测（重建误差大 = 不正常）、特征学习</text>
<text class="ts" x="690" y="115" text-anchor="middle">无需标签</text>
</svg>
<figcaption>图 2：自编码器：压缩成瓶颈再还原</figcaption>
</figure>

### VAE（变分自编码器）

普通自编码器只会还原。**VAE 让潜在空间变得“规整、连续”**：编码器不输出一个点，而是输出一个**概率分布**（均值和方差），并用 **KL 散度**（见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)）约束它接近标准正态分布。这样就可以**在潜在空间里随机取点，解码出全新的、合理的样本**——它是一个**生成模型**。

## 四、GAN：造假者与鉴定师的对抗

**生成对抗网络（GAN）**：两个网络互相博弈，像**造假币的人 vs 验钞的警察**。

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="GAN：生成器从随机噪声生成假图片，判别器同时看到真图片和假图片并判断真假，两者在对抗中共同进步">
<rect class="b" x="20" y="30" width="110" height="46" rx="8"/>
<text class="tb" x="75" y="53" text-anchor="middle" dominant-baseline="middle">随机噪声</text>
<rect class="b3" x="170" y="30" width="130" height="46" rx="8"/>
<text class="tb" x="235" y="53" text-anchor="middle" dominant-baseline="middle">生成器 G（造假）</text>
<rect class="b4" x="340" y="30" width="90" height="46" rx="8"/>
<text class="tb" x="385" y="53" text-anchor="middle" dominant-baseline="middle">假图片</text>
<rect class="b2" x="340" y="130" width="90" height="46" rx="8"/>
<text class="tb" x="385" y="153" text-anchor="middle" dominant-baseline="middle">真图片</text>
<rect class="b5" x="480" y="70" width="140" height="66" rx="8"/>
<text class="tb" x="550" y="94" text-anchor="middle" dominant-baseline="middle">判别器 D（鉴定）</text>
<text class="ts" x="550" y="116" text-anchor="middle">判断：真 还是 假？</text>
<line class="l" x1="130" y1="53" x2="170" y2="53" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="53" x2="340" y2="53" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="53" x2="480" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="153" x2="480" y2="118" marker-end="url(#arr)"/>
<rect class="bg" x="650" y="30" width="100" height="160" rx="10"/>
<text class="ts" x="700" y="54" text-anchor="middle">D 想：</text>
<text class="ts" x="700" y="72" text-anchor="middle">分清真假</text>
<text class="ts" x="700" y="102" text-anchor="middle">G 想：</text>
<text class="ts" x="700" y="120" text-anchor="middle">骗过 D</text>
<text class="ts" x="700" y="150" text-anchor="middle">双方互相</text>
<text class="ts" x="700" y="168" text-anchor="middle">推高水平</text>
<text class="ts" x="380" y="216" text-anchor="middle">最终 G 能生成以假乱真的图片。缺点：训练不稳定、容易模式崩溃（只会生成少数几种样子）</text>
</svg>
<figcaption>图 3：GAN：生成器与判别器对抗式训练</figcaption>
</figure>

早期（2014~2020）GAN 是图像生成主力（人脸生成、风格迁移），现在基本被**扩散模型**取代，但思想（对抗训练）仍有影响。

## 五、扩散模型：从噪声里“雕刻”出图像

**Stable Diffusion、Midjourney、DALL·E** 背后就是扩散模型。思想非常直观：

<figure class="fig">
<svg viewBox="0 0 780 260" class="dg" role="img" aria-label="扩散模型：前向过程逐步给图片加噪声直到变成纯噪声；反向过程由神经网络逐步去噪，从纯噪声还原出清晰图像，生成时可用文字条件引导">
<text class="th" x="20" y="24">前向（训练用）：一步步加噪，直到变成纯噪声</text>
<rect class="b2" x="20" y="40" width="80" height="60" rx="4"/>
<text class="ts" x="60" y="70" text-anchor="middle" dominant-baseline="middle">清晰图</text>
<rect class="b3" x="150" y="40" width="80" height="60" rx="4"/>
<text class="ts" x="190" y="70" text-anchor="middle" dominant-baseline="middle">有点糊</text>
<rect class="b5" x="280" y="40" width="80" height="60" rx="4"/>
<text class="ts" x="320" y="70" text-anchor="middle" dominant-baseline="middle">很多噪点</text>
<rect class="bg" x="410" y="40" width="80" height="60" rx="4"/>
<text class="ts" x="450" y="70" text-anchor="middle" dominant-baseline="middle">纯噪声</text>
<line class="l" x1="100" y1="70" x2="150" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="230" y1="70" x2="280" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="70" x2="410" y2="70" marker-end="url(#arr)"/>
<text class="th" x="20" y="146">反向（生成用）：神经网络学会一步步去噪</text>
<rect class="bg" x="20" y="162" width="80" height="60" rx="4"/>
<text class="ts" x="60" y="192" text-anchor="middle" dominant-baseline="middle">纯噪声</text>
<rect class="b5" x="150" y="162" width="80" height="60" rx="4"/>
<text class="ts" x="190" y="192" text-anchor="middle" dominant-baseline="middle">隐约成形</text>
<rect class="b3" x="280" y="162" width="80" height="60" rx="4"/>
<text class="ts" x="320" y="192" text-anchor="middle" dominant-baseline="middle">轮廓清晰</text>
<rect class="b2" x="410" y="162" width="80" height="60" rx="4"/>
<text class="ts" x="450" y="192" text-anchor="middle" dominant-baseline="middle">细节完整</text>
<line class="la" x1="100" y1="192" x2="150" y2="192" marker-end="url(#arr-a)"/>
<line class="la" x1="230" y1="192" x2="280" y2="192" marker-end="url(#arr-a)"/>
<line class="la" x1="360" y1="192" x2="410" y2="192" marker-end="url(#arr-a)"/>
<rect class="bg" x="530" y="40" width="230" height="190" rx="12"/>
<text class="th" x="546" y="64">要点</text>
<text class="ts" x="546" y="90">• 训练目标：给一张加了噪的图，</text>
<text class="ts" x="546" y="108">  预测“加了什么噪声”（再减掉）</text>
<text class="ts" x="546" y="136">• 生成：从纯噪声出发，反复去噪</text>
<text class="ts" x="546" y="164">• 文字条件：把文字嵌入作为条件，</text>
<text class="ts" x="546" y="182">  引导“雕刻”成符合描述的图</text>
<text class="ta" x="546" y="210">稳定、质量高，现已成为主流</text>
</svg>
<figcaption>图 4：扩散模型：学会“去噪”，就能从噪声生成图像</figcaption>
</figure>

| | GAN | 扩散模型 |
| --- | --- | --- |
| 训练 | 对抗，**不稳定** | 回归“预测噪声”，**稳定** |
| 质量与多样性 | 质量高但易模式崩溃 | **质量与多样性都好** |
| 生成速度 | **一步出图，快** | 需要多步迭代（有加速方法） |
| 现状 | 逐渐少用 | **图像/视频/音频生成主流** |

## 六、图神经网络（GNN）：处理“关系”

很多数据是**图**：社交网络（人—关注—人）、分子（原子—化学键—原子）、交通网络、知识图谱。普通 CNN/Transformer 处理不了“任意连接结构”。

**GNN 的核心思想**：**每个节点不断地从邻居那里收集信息，更新自己的向量**（“消息传递”），多轮之后，每个节点的向量就融合了它周围一圈的结构信息。

```text
第 k 轮：节点 v 的新表示 = f( v 自己的旧表示, 汇总（邻居的旧表示） )
```

| 应用 | 说明 |
| --- | --- |
| 推荐系统 | 用户—商品二部图 |
| 欺诈/风控 | 账户转账网络中发现团伙 |
| 药物/材料 | 分子图预测性质 |
| 知识图谱补全 | 预测缺失的关系 |
| 路径与交通预测 | 路网 |

## 七、强化学习：在试错中学会决策

**监督学习有标准答案；强化学习没有，只有“奖励”。** 智能体（Agent）在环境里**行动 → 得到奖励/惩罚 → 调整策略**，目标是**长期累计奖励最大**。类比：**训练小狗**——做对了给零食，做错了没有。

<figure class="fig">
<svg viewBox="0 0 740 240" class="dg" role="img" aria-label="强化学习循环：智能体观察环境状态，选择动作，环境返回奖励和新状态，智能体据此更新策略">
<rect class="b3" x="80" y="80" width="170" height="80" rx="12"/>
<text class="th" x="165" y="108" text-anchor="middle">智能体 Agent</text>
<text class="ts" x="165" y="132" text-anchor="middle">策略：状态 → 动作</text>
<rect class="b2" x="490" y="80" width="170" height="80" rx="12"/>
<text class="th" x="575" y="108" text-anchor="middle">环境 Environment</text>
<text class="ts" x="575" y="132" text-anchor="middle">游戏 / 机器人 / 用户</text>
<path class="la nf" d="M250 100 C 330 50 410 50 490 100" marker-end="url(#arr-a)"/>
<text class="ta" x="370" y="52" text-anchor="middle">动作 a（做什么）</text>
<path class="l nf" d="M490 140 C 410 195 330 195 250 140" marker-end="url(#arr)"/>
<text class="ts" x="370" y="206" text-anchor="middle">新状态 s′ + 奖励 r（好不好）</text>
<text class="ts" x="370" y="232" text-anchor="middle">智能体根据奖励不断调整策略，使长期总奖励最大</text>
</svg>
<figcaption>图 5：强化学习：动作 → 奖励 → 改进策略</figcaption>
</figure>

- **代表**：AlphaGo（围棋）、机器人行走、自动驾驶决策、游戏 AI、**广告/推荐的长期收益优化**；
- **和 LLM 的关系**：**RLHF 用强化学习让大模型符合人类偏好**；近年**推理模型**通过“答对给奖励”的强化学习提升数学与代码能力，见 [LLM：从预训练到对话助手](#/aimodel/llm)；
- 难点：**奖励稀疏、探索与利用的权衡、训练不稳定、样本效率低**。

## 八、经典机器学习：别忽略“老将”

### 决策树与集成：表格数据的王者

**决策树**像玩“二十个问题”：一连串“如果…就…”做判断，直观、可解释。

```text
是否已婚？ ── 是 ── 年收入 > 20 万？ ── 是 → 批准贷款
          └─ 否 ── ……                └─ 否 → 拒绝
```

单棵树容易过拟合，所以把**很多棵树**组合起来：

| 方法 | 思想 |
| --- | --- |
| **随机森林** | 很多棵树**独立训练**、**投票**（并行，降方差） |
| **梯度提升树（XGBoost / LightGBM / CatBoost）** | 树**一棵接一棵**，每棵专门**修正前面所有树的错误**（串行，降偏差） |

> [!TIP] 一个重要的现实
> 对**表格数据**（金融风控、销量预测、点击率预估），**梯度提升树往往比深度学习更准、更快、更省事**。深度学习的优势在图像、文本、语音这类**非结构化**数据。

### 聚类：无监督的“分堆”

**K-Means**：随机选 k 个中心 → 每个点归到最近的中心 → 重新计算中心 → 重复直到稳定。用于**用户分群、图像压缩、异常检测**。

### SVM、KNN（了解）

- **SVM**：找一个**间隔最大**的分界面，小数据集上很强；
- **KNN**：“物以类聚”，看**离你最近的 k 个邻居**多数是哪一类。

## 九、自监督与基础模型：“先通识，后专精”

**自监督学习**：**数据自己造标签**，无需人工标注，因此能用上互联网的海量数据：

| 数据 | 自监督任务 |
| --- | --- |
| 文本 | 预测下一个词（GPT）/ 猜被遮住的词（BERT） |
| 图像 | 遮住一部分让模型还原（MAE）；对比学习（同一图的两种增强应靠近，不同图应远离） |
| 音频/视频 | 预测被遮的片段 |

用海量数据自监督训练出的**大模型**称为**基础模型（Foundation Model）**，再通过**微调、提示、RAG** 适配到各种下游任务——这是当下 AI 的主流范式，也是为什么“一个大模型能做很多事”。

## 十、动手：5 行代码感受几个模型

```python
# 1) 表格数据：梯度提升树（几行就能拿到很强的基线）
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import cross_val_score
X, y = load_breast_cancer(return_X_y=True)
print(cross_val_score(HistGradientBoostingClassifier(), X, y, cv=5).mean())

# 2) 聚类：K-Means
from sklearn.cluster import KMeans
import numpy as np
pts = np.vstack([np.random.randn(50, 2) + c for c in ([0, 0], [6, 6], [0, 6])])
print(KMeans(n_clusters=3, n_init=10).fit(pts).cluster_centers_.round(1))

# 3) 文本嵌入与相似度（sentence-transformers）
# from sentence_transformers import SentenceTransformer
# m = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")
# a, b = m.encode(["我喜欢猫", "我爱小猫咪"]); print(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
```

## 自测：你真的懂了吗？

> [!QUESTION] 判别式模型和生成式模型的区别？各举一例。
> 判别式模型根据输入判断或预测（如逻辑回归、图像分类 CNN）；生成式模型学习数据的分布并创造新样本（如 LLM、扩散模型）。

> [!QUESTION] Embedding 的核心思想是什么？有什么用？
> 把文字、图像、商品等映射成稠密向量，使含义相近的对象向量也相近，用余弦相似度等度量相似性。用于语义检索、RAG、推荐、聚类、去重等。

> [!QUESTION] 扩散模型为什么逐渐取代了 GAN？
> GAN 对抗训练不稳定且容易模式崩溃；扩散模型把任务变成“预测并去除噪声”，训练稳定，生成质量和多样性更好，虽然需要多步迭代，但已有加速方法，因而成为图像、视频、音频生成的主流。

> [!QUESTION] 强化学习与监督学习的区别是什么？
> 监督学习有每个样本的标准答案；强化学习没有，只有执行动作后环境给的奖励信号，智能体通过试错学习使长期累计奖励最大。

> [!QUESTION] 为什么表格数据常常用 XGBoost 而不是深度学习？
> 表格数据特征异质、样本量常不大，梯度提升树对这类数据拟合好、训练快、需要的调参和预处理少、可解释性较好，往往效果不输甚至优于深度学习；深度学习的优势在图像、文本、语音等非结构化数据。

## 相关阅读

- [注意力与 Transformer：大模型的骨架](#/aimodel/transformer)：Transformer
- [CNN：卷积神经网络如何“看图”](#/aimodel/cnn)：CNN
- [大模型应用基础与 API 调用](#/ai/llm)：LLM 应用开发基础
