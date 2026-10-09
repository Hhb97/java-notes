---
level: 基础
tags: [模型选型, 模型对比, 学习路线, 术语表, 树模型, CNN, Transformer, LLM, 可解释性]
summary: 给每类 AI 模型画一张“性格画像”——它擅长什么、不擅长什么、胃口多大（数据与算力）、好不好解释；再给出一张选模型的决策流程图、一份从零到大模型的学习路线，以及一张初学者必备的术语速查表。
---

# AI 模型的“性格画像”：怎么选模型

> [!ABSTRACT] 一句话版本
> 每类模型都有自己的“性格”：有的**稳重好懂**（线性模型、树），有的**天赋异禀但挑食、费电**（深度网络、大模型）。**选模型 = 把任务的需求，和模型的性格做匹配**。
> - 数据少、要可解释 → **简单模型 / 树模型**；
> - 数据是图像/文本/语音、数据量大 → **深度学习**；
> - 要“通用、能对话、能生成” → **LLM**，但要面对**成本、延迟、幻觉**；
> - **永远先从最简单的基线开始**，再逐步加复杂度，用数据说话。

> [!NOTE] 这一页怎么用
> 前面的文章分别讲了各个模型的原理。这一页把它们**放在一起比较**，并给出**选型与学习建议**，适合作为“全局回顾”。

## 一、六个维度看“性格”

| 维度 | 问什么 |
| --- | --- |
| **擅长的数据** | 表格？图像？文本？序列？图？ |
| **数据胃口** | 要多少数据才能训练好？ |
| **算力胃口** | 训练/推理需要多少算力（CPU 够吗？要 GPU 吗？） |
| **可解释性** | 能说清“为什么这样预测”吗？ |
| **训练难度** | 调参、稳定性、工程复杂度 |
| **典型短板** | 它最容易在哪儿栽跟头？ |

## 二、各模型的性格画像

### 1. 线性/逻辑回归：朴实的“老实人”

- **特点**：简单、快、**极易解释**（每个特征的权重一目了然）；
- **擅长**：特征和目标大致线性关系的任务；做**基线**；
- **短板**：学不会复杂的非线性关系；
- **适合**：风控评分卡、简单预测、需要向监管解释的场景。

### 2. 决策树 / 随机森林 / XGBoost：表格数据的“全能选手”

- **特点**：对表格数据**效果很强**，不需要太多预处理，训练快，能处理缺失值和混合类型；
- **擅长**：金融、电商、风控、点击率预估等结构化数据；
- **短板**：不擅长图像/文本/语音；很难外推到训练范围之外；
- **可解释性**：单棵树很好解释；森林/提升树可用特征重要性、SHAP 等方法解释。

### 3. MLP（全连接网络）：基础的“万能拟合器”

- **特点**：结构最简单的神经网络，理论上能拟合任何函数；
- **擅长**：中等规模的结构化数据、作为其它大模型里的**组件（FFN）**；
- **短板**：直接看图像/文本效率低，参数多；
- **可解释性**：弱（黑盒）。

### 4. CNN：图像界的“火眼金睛”

- **特点**：利用**局部性和平移不变性**，参数共享，**看图又快又准**；
- **擅长**：图像分类、检测、分割、医学影像、OCR；
- **短板**：对**全局长距离关系**不如 Transformer；对旋转/缩放需靠数据增强；
- **数据胃口**：需要较多标注图像；常用**迁移学习**缓解。

### 5. RNN / LSTM：会记事但健忘的“老书生”

- **特点**：逐步处理序列，**内存恒定**，适合流式；
- **擅长**：小规模时间序列、简单序列任务、资源受限设备；
- **短板**：串行慢、长依赖吃力；基本被 Transformer 取代；
- **可解释性**：弱。

### 6. Transformer：并行的“全局信息处理者”

- **特点**：**自注意力**让任意两处直接交互，**可并行训练、可大规模扩展**；
- **擅长**：文本、代码、语音、图像（ViT）、多模态……几乎无所不包；
- **短板**：**数据与算力胃口极大**；注意力 O(n²)，**长上下文昂贵**；
- **可解释性**：注意力图能提供线索，但整体仍是黑盒。

### 7. LLM（大语言模型）：博学的“通才”

- **特点**：基于 Transformer 的超大模型，**能对话、写作、编程、推理、使用工具**，只需提示词就能适配很多任务；
- **擅长**：开放式语言任务、知识问答、代码、总结、翻译、Agent 的“大脑”；
- **短板**：**会幻觉**、成本高、延迟较大、输出不确定、知识有截止、难以解释和保证正确；
- **使用方式**：提示词 → RAG → 工具/Agent → 微调（按需递进）。

### 8. 扩散 / GAN / VAE：创作型的“艺术家”

- **特点**：**生成**图像/音频/视频；扩散模型稳定、质量高；
- **擅长**：创意设计、素材生成、数据增强、图像编辑；
- **短板**：生成慢（扩散）、可控性与版权/安全问题；
- **算力**：训练和推理都吃 GPU。

### 9. GNN：关系世界的“社交达人”

- **特点**：擅长**关系结构**；
- **擅长**：社交网络、分子、知识图谱、反欺诈团伙发现；
- **短板**：大图的扩展性、工程复杂；
- **适合**：数据天然是图的场景。

### 10. 强化学习：边玩边学的“实战派”

- **特点**：通过试错和奖励学习**决策策略**；
- **擅长**：游戏、机器人控制、序贯决策、LLM 对齐；
- **短板**：**样本效率低、训练不稳定、奖励设计难**，需要可模拟的环境。

## 三、一张表对比

| 模型 | 擅长的数据 | 数据胃口 | 算力胃口 | 可解释性 | 训练难度 |
| --- | --- | --- | --- | --- | --- |
| 线性/逻辑回归 | 表格 | 小 | 极低（CPU） | ★★★★★ | 极低 |
| **XGBoost 等树模型** | **表格** | 小~中 | 低（CPU 足够） | ★★★~★★★★ | 低 |
| MLP | 表格/嵌入 | 中 | 中 | ★ | 中 |
| **CNN** | **图像** | 中~大 | 中~高（GPU） | ★★ | 中 |
| RNN / LSTM | 序列 | 中 | 中 | ★ | 中（梯度问题） |
| **Transformer** | **文本/多模态** | **大~极大** | **高** | ★~★★ | 高 |
| **LLM** | **语言/通用** | **极大**（用现成的几乎不用数据） | **极高**（调 API 则不用关心） | ★ | 极高（预训练）/ 低（用现成） |
| 扩散模型 | 图像/音视频生成 | 大 | 高 | ★ | 高 |
| GNN | 图 | 中 | 中 | ★~★★ | 中高 |
| 强化学习 | 环境交互 | 极大（交互样本） | 高 | ★ | 极高 |

（星级是粗略的相对感受，用于建立直觉，不是严格指标。）

## 四、选模型决策流程

<figure class="fig">
<svg viewBox="0 0 780 420" class="dg" role="img" aria-label="选模型的决策流程：先看数据类型，表格数据用树模型，图像用 CNN 或 ViT，文本或通用语言任务用 LLM 并按需 RAG 或微调，图数据用 GNN，需要决策用强化学习；始终先做简单基线">
<rect class="b3" x="290" y="14" width="200" height="46" rx="10"/>
<text class="tb" x="390" y="37" text-anchor="middle" dominant-baseline="middle">你的数据是什么？</text>
<rect class="b1" x="20" y="120" width="130" height="56" rx="8"/>
<text class="tb" x="85" y="140" text-anchor="middle" dominant-baseline="middle">表格（行列）</text>
<text class="ts" x="85" y="160" text-anchor="middle">特征是数字/类别</text>
<rect class="b1" x="170" y="120" width="130" height="56" rx="8"/>
<text class="tb" x="235" y="140" text-anchor="middle" dominant-baseline="middle">图像 / 视频</text>
<rect class="b1" x="320" y="120" width="130" height="56" rx="8"/>
<text class="tb" x="385" y="140" text-anchor="middle" dominant-baseline="middle">文本 / 代码</text>
<rect class="b1" x="470" y="120" width="130" height="56" rx="8"/>
<text class="tb" x="535" y="140" text-anchor="middle" dominant-baseline="middle">图 / 关系网络</text>
<rect class="b1" x="620" y="120" width="140" height="56" rx="8"/>
<text class="tb" x="690" y="140" text-anchor="middle" dominant-baseline="middle">需要连续决策</text>
<text class="ts" x="690" y="160" text-anchor="middle">有环境与奖励</text>
<line class="l" x1="340" y1="60" x2="85" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="60" x2="235" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="60" x2="385" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="60" x2="535" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="60" x2="690" y2="120" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="220" width="130" height="76" rx="8"/>
<text class="tb" x="85" y="242" text-anchor="middle" dominant-baseline="middle">先试线性回归</text>
<text class="ts" x="85" y="262" text-anchor="middle">再试 XGBoost /</text>
<text class="ts" x="85" y="280" text-anchor="middle">LightGBM</text>
<rect class="b2" x="170" y="220" width="130" height="76" rx="8"/>
<text class="tb" x="235" y="242" text-anchor="middle" dominant-baseline="middle">预训练 CNN/ViT</text>
<text class="ts" x="235" y="262" text-anchor="middle">+ 迁移学习</text>
<text class="ts" x="235" y="280" text-anchor="middle">生成用扩散模型</text>
<rect class="b2" x="320" y="220" width="130" height="76" rx="8"/>
<text class="tb" x="385" y="242" text-anchor="middle" dominant-baseline="middle">先用现成 LLM</text>
<text class="ts" x="385" y="262" text-anchor="middle">提示词 → RAG →</text>
<text class="ts" x="385" y="280" text-anchor="middle">工具 → 微调</text>
<rect class="b2" x="470" y="220" width="130" height="76" rx="8"/>
<text class="tb" x="535" y="242" text-anchor="middle" dominant-baseline="middle">图神经网络 GNN</text>
<text class="ts" x="535" y="262" text-anchor="middle">或先把关系做成</text>
<text class="ts" x="535" y="280" text-anchor="middle">特征交给树模型</text>
<rect class="b2" x="620" y="220" width="140" height="76" rx="8"/>
<text class="tb" x="690" y="242" text-anchor="middle" dominant-baseline="middle">强化学习</text>
<text class="ts" x="690" y="262" text-anchor="middle">先考虑规则/运筹</text>
<text class="ts" x="690" y="280" text-anchor="middle">能否解决</text>
<line class="l" x1="85" y1="176" x2="85" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="235" y1="176" x2="235" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="176" x2="385" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="535" y1="176" x2="535" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="690" y1="176" x2="690" y2="220" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="320" width="740" height="84" rx="10"/>
<text class="th" x="36" y="344">无论哪条路，都要遵守的铁律</text>
<text class="ts" x="36" y="366">① 先做最简单的基线，再加复杂度，每次改动都用验证集/评测集对比</text>
<text class="ts" x="36" y="386">② 数据质量 &gt; 模型花样；先把数据、标签、划分、指标搞对（见《机器学习是什么》）</text>
</svg>
<figcaption>图 1：按数据类型选模型的决策流程</figcaption>
</figure>

### 五个常见的选型问题

| 问题 | 建议 |
| --- | --- |
| 数据只有几百条，要预测？ | 简单模型 + 正则；或树模型；别上深度网络 |
| 想让系统读懂公司文档并回答？ | **RAG + 现成 LLM**，不要一上来就微调，见 [RAG 原理与完整流水线](#/ai/rag) |
| 要识别产线上的缺陷图片，只有几百张？ | **迁移学习**（预训练 CNN）+ 数据增强，见 [CNN：卷积神经网络如何“看图”](#/aimodel/cnn) |
| 要求结果必须可解释、可审计？ | 线性模型、决策树、可解释提升树，避免黑盒 |
| 延迟要求极低、跑在手机/设备上？ | 小模型 + 量化/蒸馏，或经典模型 |

## 五、模型规模：从“小模型”到“大模型”

| 规模 | 参数量级 | 例子 | 运行在哪 |
| --- | --- | --- | --- |
| 经典 ML | 几十~几万 | 逻辑回归、树 | CPU |
| 小型神经网络 | 十万~百万 | 简单 MLP、LeNet | CPU/小 GPU |
| 中型 | 千万~几亿 | ResNet-50（约 2500 万）、BERT-base（约 1.1 亿） | 单 GPU |
| **大语言模型** | **几十亿~数千亿** | 7B、70B、数百 B | 多 GPU / 云 API |
| 端侧小模型 | 几亿~几十亿（量化后） | 手机上的小型 LLM | 手机/笔记本 |

> [!TIP] “模型越大越好”是误区
> 在**特定任务**上，**小模型 + 好数据 + 微调/蒸馏**常常以十分之一的成本达到相近效果。选型要**看成本、延迟、可控性与效果的整体平衡**。

## 六、从零到大模型：一条学习路线

<figure class="fig">
<svg viewBox="0 0 780 300" class="dg" role="img" aria-label="学习路线：数学基础、Python 与 NumPy、机器学习入门、神经网络与深度学习、CNN 与 Transformer、大语言模型与应用、工程化与深入">
<rect class="b1" x="20" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="70" y="62" text-anchor="middle" dominant-baseline="middle">① 数学基础</text>
<text class="ts" x="70" y="84" text-anchor="middle">线代·微积分·概率</text>
<rect class="b1" x="140" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="190" y="62" text-anchor="middle" dominant-baseline="middle">② Python</text>
<text class="ts" x="190" y="84" text-anchor="middle">NumPy·Pandas</text>
<rect class="b3" x="260" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="310" y="62" text-anchor="middle" dominant-baseline="middle">③ 机器学习</text>
<text class="ts" x="310" y="84" text-anchor="middle">sklearn·指标</text>
<rect class="b3" x="380" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="430" y="62" text-anchor="middle" dominant-baseline="middle">④ 神经网络</text>
<text class="ts" x="430" y="84" text-anchor="middle">PyTorch·训练</text>
<rect class="b5" x="500" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="550" y="62" text-anchor="middle" dominant-baseline="middle">⑤ CNN/Transformer</text>
<text class="ts" x="550" y="84" text-anchor="middle">图像·序列</text>
<rect class="b2" x="620" y="40" width="140" height="70" rx="8"/>
<text class="tb" x="690" y="62" text-anchor="middle" dominant-baseline="middle">⑥ LLM 与应用</text>
<text class="ts" x="690" y="84" text-anchor="middle">RAG·Agent·微调</text>
<line class="l" x1="120" y1="75" x2="140" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="240" y1="75" x2="260" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="75" x2="380" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="75" x2="500" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="75" x2="620" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="140" width="740" height="140" rx="12"/>
<text class="th" x="36" y="164">每一步的“小目标”（动手比看书重要）</text>
<text class="ts" x="36" y="190">① 能手算点积、矩阵乘、求导和梯度下降一步（就是本分类前五篇）</text>
<text class="ts" x="36" y="210">② 用 NumPy 实现线性回归 + 梯度下降；会读 DataFrame</text>
<text class="ts" x="36" y="230">③ 用 sklearn 做一个完整流程：划分、训练、评估；懂过拟合与指标</text>
<text class="ts" x="36" y="250">④ 用 PyTorch 在 MNIST 上训练一个 MLP，并能看懂训练曲线</text>
<text class="ts" x="36" y="270">⑤ 复现一个小 CNN 和一个小 Transformer；⑥ 搭一个 RAG 问答，再做一个简单 Agent</text>
</svg>
<figcaption>图 2：学习路线图</figcaption>
</figure>

**推荐的实践顺序**

1. **手算**一遍本分类里的例子（点积、矩阵乘、求导、梯度下降、前向反向传播），建立直觉；
2. **NumPy 从零实现**线性回归、逻辑回归、小型 MLP（[MLP：神经元、多层感知机与反向传播](#/aimodel/mlp) 里有完整代码）；
3. 学 **PyTorch**，复现 MNIST 手写数字识别（MLP → CNN）；
4. 动手做一个**小 Transformer**或读 minGPT/nanoGPT 之类的精简实现；
5. 转向应用：**调用大模型 API、RAG、Agent**，见 [RAG 原理与完整流水线](#/ai/rag)、[Agent、工具调用与 MCP](#/ai/agent)、[Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)；
6. 做**真实项目**：数据 → 模型 → 评估 → 上线 → 监控，这是学得最快的方式。

## 七、术语速查表（初学者必备）

| 术语 | 一句话解释 |
| --- | --- |
| **特征（Feature）** | 描述一个样本的输入变量 |
| **标签（Label）** | 样本的“正确答案” |
| **模型 / 参数 / 权重** | 学出来的函数 / 可调的数字 / 神经元之间的连接强度 |
| **超参数** | 人为设定的训练配置（学习率、层数、batch size） |
| **损失函数（Loss）** | 衡量预测错得多离谱的数值，训练的目标是让它变小 |
| **梯度** | 损失对每个参数的偏导数，指示“往哪调能让损失变小” |
| **梯度下降** | 沿梯度反方向反复小步更新参数 |
| **反向传播** | 用链式法则高效算出所有参数梯度的方法 |
| **epoch / batch** | 看完全部数据一遍 / 一次喂给模型的一小批 |
| **过拟合 / 欠拟合** | 死记训练数据而不泛化 / 模型太简单学不会 |
| **正则化** | 抑制过拟合的方法（L2、Dropout、早停…） |
| **激活函数** | 给网络引入非线性（ReLU、sigmoid、GELU…） |
| **softmax** | 把一组分数变成和为 1 的概率 |
| **交叉熵** | 分类/语言模型的标准损失 |
| **Embedding** | 把对象变成语义向量 |
| **Token** | 大模型处理文字的基本单位 |
| **注意力** | 动态决定关注输入的哪些部分 |
| **预训练 / 微调** | 在海量通用数据上训练 / 在特定数据上继续训练 |
| **提示词（Prompt）** | 给大模型的指令与上下文 |
| **RAG** | 检索外部知识再让模型回答 |
| **幻觉** | 模型编造不真实的内容 |
| **推理（Inference）** | 用训练好的模型做预测（相对于“训练”） |
| **GPU / 张量** | 擅长并行矩阵运算的硬件 / 多维数组 |
| **迁移学习** | 把在大任务上学到的知识用到小任务 |
| **量化 / 蒸馏 / LoRA** | 降低精度省显存 / 小模型学大模型 / 低秩微调 |

## 八、本分类内容回顾

| 你想复习… | 去这里 |
| --- | --- |
| 向量、矩阵、点积、变换 | [线性代数 1：向量与矩阵](#/aimodel/math-la1) |
| 特征值、SVD、PCA、低秩 | [线性代数 2：特征值、SVD 与 PCA](#/aimodel/math-la2) |
| 导数、梯度、链式法则 | [微积分 1：导数、偏导与链式法则](#/aimodel/math-calc1) |
| 梯度下降与优化器 | [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2) |
| 概率、softmax、交叉熵 | [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob) |
| 回归、分类、过拟合、指标 | [机器学习是什么：回归、分类与过拟合](#/aimodel/ml-intro) |
| 神经元、反向传播 | [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp) |
| 训练技巧 | [训练神经网络：优化器、正则化与常见坑](#/aimodel/training) |
| 图像 | [CNN：卷积神经网络如何“看图”](#/aimodel/cnn) |
| 序列与记忆 | [RNN 与 LSTM：会“记事”的网络](#/aimodel/rnn) |
| 注意力与 Transformer | [注意力与 Transformer：大模型的骨架](#/aimodel/transformer) |
| 大语言模型 | [LLM：从预训练到对话助手](#/aimodel/llm) |
| 其它模型家族 | [模型家族地图：Embedding、VAE、GAN、扩散、GNN、强化学习](#/aimodel/zoo) |

读完这个分类后，建议继续看 **[AI 应用](#/ai/llm)** 分类，学习怎样把大模型真正用到工程里。

## 自测：你真的懂了吗？

> [!QUESTION] 面对一个销量预测的表格数据，你会怎么选模型？为什么？
> 先用线性回归做基线，再试梯度提升树（XGBoost/LightGBM）。表格数据特征异质、样本量通常不大，树模型效果好、训练快、需要的预处理少；深度学习通常没有明显优势。

> [!QUESTION] 什么时候该用大语言模型，什么时候不该用？
> 开放式语言任务（问答、总结、写作、代码、需要理解自然语言指令）适合用；对准确性、可解释性、延迟和成本要求极高且任务固定的场景（如简单分类、数值预测、规则明确的流程）更适合经典模型或规则，LLM 成本高且会幻觉。

> [!QUESTION] 为什么说“先做基线”很重要？
> 简单基线（如逻辑回归）训练快、结果可解释，它给出了一个可对比的下限；如果复杂模型没有明显超过基线，就不值得引入复杂度。同时基线能帮助尽早发现数据、标签和评估方式的问题。

> [!QUESTION] 小公司没有 GPU 和海量数据，想让 AI 回答内部文档问题，该怎么做？
> 调用现成的大模型 API，加上 RAG（检索内部文档再让模型依据回答），必要时再做提示词优化与评测；不需要自己预训练或大规模微调。
