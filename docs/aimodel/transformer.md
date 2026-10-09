---
level: 基础
tags: [Transformer, 注意力, 自注意力, Q K V, 多头注意力, 位置编码, 残差, LayerNorm, BERT, GPT]
summary: 用“查字典”的比喻讲清注意力机制：Q、K、V 是什么，自注意力的完整手算，多头、位置编码、因果掩码的作用，Transformer 一个块的组成（注意力 + 前馈 + 残差 + 归一化），以及 BERT 与 GPT 的区别和为什么它能扩展成大模型。
---

# 注意力与 Transformer：大模型的骨架

> [!ABSTRACT] 一句话版本
> - **注意力**：处理一个词时，**让它“看一遍”句子里所有词，并按“相关程度”决定各看多少**，再把信息加权汇总。
> - 实现方式：每个词变成三个向量 **Q（我要找什么）、K（我是什么）、V（我的内容）**；用 **Q·K 点积**算相关度，**softmax** 变成权重，再对 **V** 加权求和。
> - **Transformer** = 注意力 + 前馈网络(MLP) + 残差 + LayerNorm，**堆叠几十层**。它**不依赖顺序处理**，整句**并行计算**，所以能在海量数据上扩展——这是 **ChatGPT、BERT** 等所有现代大模型的骨架。
> - 注意力本身“不懂顺序”，要额外加**位置编码**；做生成时要加**因果掩码**，防止“偷看未来”。
> - 代价：注意力的计算量与**句子长度的平方**成正比，所以长上下文很贵。

> [!NOTE] 先决条件
> 需要懂点积（相似度）和 softmax：[线性代数 1：向量与矩阵](#/aimodel/math-la1)、[概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)；最好也读过 [RNN 与 LSTM：会“记事”的网络](#/aimodel/rnn) 以了解动机。

## 一、为什么需要注意力

回顾 RNN 的痛点：串行、记不住远处、信息瓶颈。看这个句子：

> “**小明**把书给了**小红**，因为**她**忘了带。”

“她”指谁？要**回头看**前面的“小红”。人读句子时会**有选择地关注**相关的词，而不是平均对待每个词。

**注意力机制**就是让模型学会这个能力：**处理每个词时，动态地决定“该关注句子里的哪些词、关注多少”**。

## 二、Q、K、V：用“查字典/搜索”来理解

想象一个**软查询的字典**：

| 角色 | 含义 | 类比 |
| --- | --- | --- |
| **Query（Q，查询）** | 当前这个词“想要找什么信息” | 你在搜索框输入的关键词 |
| **Key（K，键）** | 每个词“自己能提供什么”的标签 | 每篇文章的标题/关键词 |
| **Value（V，值）** | 每个词“真正携带的内容” | 文章正文 |

流程：

1. 把**我的 Q** 和**每个词的 K** 比较（点积）→ 得到“相关度”；
2. 把相关度用 softmax 变成**权重**（和为 1）；
3. 用权重对所有词的 **V** 加权求和 → 得到**融合了上下文的新表示**。

```text
Attention(Q, K, V) = softmax( Q·Kᵀ / √d ) · V
```

- 为什么除以 √d：向量维度 d 大时点积数值会很大，softmax 会变得极端（几乎 one-hot），除一下让它更“温和”、梯度更稳定。

### Q、K、V 从哪来

每个词的向量 x，分别乘三个**学出来的矩阵**得到：

```text
Q = x · W_Q        K = x · W_K        V = x · W_V
```

模型通过训练学会：**什么样的词该产生什么样的 Q、K、V**，使“该关注的词”点积大。

## 三、自注意力：完整手算

句子只有 **2 个词**，每个词用 2 维向量表示（为了好算，直接给 Q、K、V）：

```text
词 1 的 Q₁ = (1, 0)        K₁ = (1, 0)      V₁ = (2, 0)
词 2 的 Q₂ = (0, 1)        K₂ = (0, 1)      V₂ = (0, 2)
d = 2，所以 √d ≈ 1.414
```

**以词 1 为例**（词 1 想知道该关注谁）：

```text
① 相关度（Q₁ 与每个 K 点积）：
   Q₁·K₁ = 1×1 + 0×0 = 1         Q₁·K₂ = 1×0 + 0×1 = 0
② 缩放（÷√2）：          (0.707,  0)
③ softmax：e^0.707 = 2.028，e^0 = 1，和 = 3.028
   权重 = (0.670,  0.330)           ← 词 1 把 67% 的注意力给自己，33% 给词 2
④ 对 V 加权求和：
   输出₁ = 0.670×(2, 0) + 0.330×(0, 2) = (1.34, 0.66)
```

<figure class="fig">
<svg viewBox="0 0 780 320" class="dg" role="img" aria-label="自注意力计算流程：词 1 的 Q 与所有词的 K 做点积得到分数，缩放后 softmax 得到注意力权重，再用权重对所有 V 加权求和得到输出">
<rect class="b1" x="20" y="40" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="58" text-anchor="middle" dominant-baseline="middle">Q₁ = (1,0)</text>
<text class="ts" x="70" y="78" text-anchor="middle">词 1 在“提问”</text>
<rect class="b3" x="20" y="120" width="100" height="40" rx="8"/>
<text class="tb" x="70" y="140" text-anchor="middle" dominant-baseline="middle">K₁ = (1,0)</text>
<rect class="b3" x="20" y="170" width="100" height="40" rx="8"/>
<text class="tb" x="70" y="190" text-anchor="middle" dominant-baseline="middle">K₂ = (0,1)</text>
<line class="l" x1="120" y1="65" x2="170" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="120" y1="140" x2="170" y2="145" marker-end="url(#arr)"/>
<line class="l" x1="120" y1="190" x2="170" y2="160" marker-end="url(#arr)"/>
<rect class="b5" x="170" y="120" width="110" height="60" rx="8"/>
<text class="tb" x="225" y="142" text-anchor="middle" dominant-baseline="middle">点积 Q·K</text>
<text class="tm" x="225" y="164" text-anchor="middle" dominant-baseline="middle">(1, 0)</text>
<rect class="b5" x="320" y="120" width="100" height="60" rx="8"/>
<text class="tb" x="370" y="142" text-anchor="middle" dominant-baseline="middle">÷ √d</text>
<text class="tm" x="370" y="164" text-anchor="middle" dominant-baseline="middle">(0.71, 0)</text>
<rect class="b4" x="460" y="120" width="110" height="60" rx="8"/>
<text class="tb" x="515" y="142" text-anchor="middle" dominant-baseline="middle">softmax</text>
<text class="tm" x="515" y="164" text-anchor="middle" dominant-baseline="middle">(0.67, 0.33)</text>
<line class="l" x1="280" y1="150" x2="320" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="150" x2="460" y2="150" marker-end="url(#arr)"/>
<rect class="b2" x="460" y="220" width="110" height="40" rx="8"/>
<text class="tb" x="515" y="240" text-anchor="middle" dominant-baseline="middle">V₁ V₂</text>
<text class="ts" x="515" y="278" text-anchor="middle">V₁=(2,0)  V₂=(0,2)</text>
<line class="l" x1="515" y1="180" x2="515" y2="220" marker-end="url(#arr)"/>
<text class="ts" x="528" y="204" text-anchor="start">权重×V</text>
<rect class="b2" x="620" y="150" width="130" height="60" rx="8"/>
<text class="tb" x="685" y="172" text-anchor="middle" dominant-baseline="middle">输出₁</text>
<text class="tm" x="685" y="196" text-anchor="middle" dominant-baseline="middle">(1.34, 0.66)</text>
<line class="l" x1="570" y1="240" x2="685" y2="210" marker-end="url(#arr)"/>
<text class="ts" x="380" y="304" text-anchor="middle">输出是“加权融合了所有词内容”的新向量：对词 1 来说，既保留了自己（67%），也吸收了词 2 的信息（33%）</text>
</svg>
<figcaption>图 1：自注意力：Q 与 K 比相关度，softmax 变权重，对 V 加权求和</figcaption>
</figure>

**“自”注意力**的意思：Q、K、V **都来自同一个句子**，句子里每个词都在“看”其他词（包括自己）。**每个词都会算一遍**，所以一次得到整句所有词的新表示。

### 矩阵形式（为什么能高速并行）

把所有词的 Q、K、V 各堆成矩阵（行 = 词）：

```text
        词数 × 词数                  词数 × d
Attention = softmax( Q·Kᵀ / √d ) · V
              ↑ 注意力分数矩阵：第 i 行第 j 列 = 词 i 对词 j 的关注度
```

这就是**几次矩阵乘法**，GPU 并行得飞快——相比 RNN 的逐词串行是质的飞跃。但注意**分数矩阵是 词数×词数**，所以**计算量和显存随句子长度的平方增长**（长上下文昂贵的根本原因，见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)）。

### 注意力权重可视化

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="一个注意力权重矩阵的热力图示意：句子中每个词对其他词的关注程度，代词她对小红的权重最高">
<text class="th" x="20" y="24">句子：小明 把 书 给了 小红 因为 她 忘了</text>
<text class="ts" x="30" y="60" text-anchor="start">被关注 →</text>
<text class="ts" x="150" y="56" text-anchor="middle">小明</text>
<text class="ts" x="200" y="56" text-anchor="middle">书</text>
<text class="ts" x="250" y="56" text-anchor="middle">小红</text>
<text class="ts" x="300" y="56" text-anchor="middle">因为</text>
<text class="ts" x="350" y="56" text-anchor="middle">她</text>
<text class="ts" x="30" y="100" text-anchor="start">提问的词 ↓</text>
<text class="ts" x="130" y="100" text-anchor="end">她</text>
<rect class="b" x="125" y="80" width="50" height="30" rx="0"/>
<rect class="b3" x="175" y="80" width="50" height="30" rx="0"/>
<rect class="b4" x="225" y="80" width="50" height="30" rx="0"/>
<rect class="b" x="275" y="80" width="50" height="30" rx="0"/>
<rect class="b3" x="325" y="80" width="50" height="30" rx="0"/>
<text class="tm" x="150" y="95" text-anchor="middle" dominant-baseline="middle">0.08</text>
<text class="tm" x="200" y="95" text-anchor="middle" dominant-baseline="middle">0.12</text>
<text class="tb" x="250" y="95" text-anchor="middle" dominant-baseline="middle">0.55</text>
<text class="tm" x="300" y="95" text-anchor="middle" dominant-baseline="middle">0.05</text>
<text class="tm" x="350" y="95" text-anchor="middle" dominant-baseline="middle">0.20</text>
<text class="ts" x="130" y="140" text-anchor="end">书</text>
<rect class="b" x="125" y="120" width="50" height="30" rx="0"/>
<rect class="b4" x="175" y="120" width="50" height="30" rx="0"/>
<rect class="b" x="225" y="120" width="50" height="30" rx="0"/>
<rect class="b" x="275" y="120" width="50" height="30" rx="0"/>
<rect class="b" x="325" y="120" width="50" height="30" rx="0"/>
<text class="tm" x="150" y="135" text-anchor="middle" dominant-baseline="middle">0.20</text>
<text class="tb" x="200" y="135" text-anchor="middle" dominant-baseline="middle">0.45</text>
<text class="tm" x="250" y="135" text-anchor="middle" dominant-baseline="middle">0.15</text>
<text class="tm" x="300" y="135" text-anchor="middle" dominant-baseline="middle">0.10</text>
<text class="tm" x="350" y="135" text-anchor="middle" dominant-baseline="middle">0.10</text>
<rect class="bg" x="420" y="60" width="320" height="200" rx="12"/>
<text class="th" x="436" y="84">怎么读</text>
<text class="ts" x="436" y="110">每一行的数字加起来 = 1（softmax 的结果）</text>
<text class="ts" x="436" y="134">“她”那一行：最关注“小红”（0.55）</text>
<text class="ts" x="436" y="154">→ 模型借此把“她”理解为小红</text>
<text class="ts" x="436" y="184">真实模型里每层、每个“头”都有这样一张</text>
<text class="ts" x="436" y="204">矩阵，不同的头关注不同关系：</text>
<text class="ts" x="436" y="224">语法、指代、相邻词、主谓宾……</text>
<text class="ts" x="436" y="246">（上面的数值是为了说明而编的示意）</text>
</svg>
<figcaption>图 2：注意力权重示意：代词“她”主要关注“小红”</figcaption>
</figure>

## 四、多头注意力：从多个角度看

一组 Q/K/V 只能学一种“关系”。**多头注意力**把表示切成 h 份（如 8 个头、32 个头），**每个头独立做一套注意力**，各自关注不同的东西，最后**拼接起来**再变换一次：

```text
头 1：关注语法结构     头 2：关注指代关系     头 3：关注相邻词     …
        ↓ 各自得到输出 ↓
      拼接 (concat) → 乘一个输出矩阵 W_O → 输出
```

类比：**一个专家组会诊**，每位专家从自己的专业角度看同一份病历，最后汇总意见。每个头的维度更小（d/h），所以总计算量与单头相当。

## 五、位置编码：告诉模型“顺序”

自注意力把句子当成一个**集合**：`我爱你` 和 `你爱我` 的词一样，注意力计算里**没有顺序信息**。必须**显式加入位置**：

| 方法 | 做法 |
| --- | --- |
| 正弦位置编码（原版） | 给第 pos 个位置加一个由 sin/cos 构成的固定向量 |
| 可学习位置嵌入 | 每个位置有一个可训练的向量（GPT-2、BERT） |
| **RoPE（旋转位置编码）** | 把位置信息通过**旋转** Q、K 注入，让点积自然包含**相对距离**（LLaMA 等主流模型） |
| ALiBi 等 | 在注意力分数上直接按距离加偏置 |

位置编码使“第 3 个词”和“第 30 个词”有了不同的表示，模型才能理解语序。

## 六、因果掩码：生成时不许偷看未来

**GPT 这类“预测下一个词”的模型**，在位置 i 预测下一词时，**只能看到 1…i**，不能看到 i+1 之后（否则训练时直接抄答案）。做法：把注意力分数矩阵的**右上角三角**置为 −∞，softmax 后权重变成 0。

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="因果掩码：注意力矩阵的上三角被屏蔽，每个位置只能关注自己及之前的位置">
<text class="th" x="20" y="24">注意力权重矩阵（行=提问的词，列=被关注的词）</text>
<rect class="b2" x="60" y="50" width="40" height="40" rx="0"/>
<rect class="bg" x="100" y="50" width="40" height="40" rx="0"/>
<rect class="bg" x="140" y="50" width="40" height="40" rx="0"/>
<rect class="bg" x="180" y="50" width="40" height="40" rx="0"/>
<rect class="b2" x="60" y="90" width="40" height="40" rx="0"/>
<rect class="b2" x="100" y="90" width="40" height="40" rx="0"/>
<rect class="bg" x="140" y="90" width="40" height="40" rx="0"/>
<rect class="bg" x="180" y="90" width="40" height="40" rx="0"/>
<rect class="b2" x="60" y="130" width="40" height="40" rx="0"/>
<rect class="b2" x="100" y="130" width="40" height="40" rx="0"/>
<rect class="b2" x="140" y="130" width="40" height="40" rx="0"/>
<rect class="bg" x="180" y="130" width="40" height="40" rx="0"/>
<rect class="b2" x="60" y="170" width="40" height="40" rx="0"/>
<rect class="b2" x="100" y="170" width="40" height="40" rx="0"/>
<rect class="b2" x="140" y="170" width="40" height="40" rx="0"/>
<rect class="b2" x="180" y="170" width="40" height="40" rx="0"/>
<text class="ts" x="80" y="224" text-anchor="middle">我</text>
<text class="ts" x="120" y="224" text-anchor="middle">爱</text>
<text class="ts" x="160" y="224" text-anchor="middle">学</text>
<text class="ts" x="200" y="224" text-anchor="middle">习</text>
<text class="ts" x="50" y="74" text-anchor="end">我</text>
<text class="ts" x="50" y="114" text-anchor="end">爱</text>
<text class="ts" x="50" y="154" text-anchor="end">学</text>
<text class="ts" x="50" y="194" text-anchor="end">习</text>
<rect class="bg" x="270" y="50" width="450" height="190" rx="12"/>
<text class="th" x="286" y="76">看懂这张图</text>
<text class="ts" x="286" y="104">• 绿色格子：允许关注（自己和之前的词）</text>
<text class="ts" x="286" y="126">• 灰色格子：被屏蔽（未来的词），权重强制为 0</text>
<text class="ts" x="286" y="154">• “爱”只能看见“我、爱”，看不到“学习”</text>
<text class="ts" x="286" y="176">• 这样训练时一次就能并行算出所有位置的“下一个词”预测，</text>
<text class="ts" x="286" y="196">  而每个位置又都看不到答案</text>
<text class="ta" x="286" y="224">做“理解”任务的编码器（BERT）不需要掩码，可双向看全句</text>
</svg>
<figcaption>图 3：因果掩码：每个位置只能看到自己和之前</figcaption>
</figure>

## 七、一个完整的 Transformer 块

<figure class="fig">
<svg viewBox="0 0 740 380" class="dg" role="img" aria-label="Transformer 块的结构：输入先经过 LayerNorm 和多头自注意力并加残差，再经过 LayerNorm 和前馈网络并加残差，该块重复堆叠 N 次">
<rect class="bg" x="200" y="20" width="340" height="340" rx="14"/>
<text class="th" x="370" y="44" text-anchor="middle">一个 Transformer 块（重复 N 次）</text>
<rect class="b1" x="20" y="180" width="100" height="40" rx="8"/>
<text class="tb" x="70" y="200" text-anchor="middle" dominant-baseline="middle">输入向量</text>
<line class="l" x1="120" y1="200" x2="230" y2="200" marker-end="url(#arr)"/>
<rect class="b" x="240" y="300" width="260" height="30" rx="6"/>
<text class="ts" x="370" y="315" text-anchor="middle" dominant-baseline="middle">LayerNorm</text>
<rect class="b3" x="240" y="250" width="260" height="40" rx="6"/>
<text class="tb" x="370" y="270" text-anchor="middle" dominant-baseline="middle">多头自注意力（词与词交流）</text>
<circle class="b5" cx="370" cy="224" r="12"/>
<text class="tb" x="370" y="224" text-anchor="middle" dominant-baseline="middle">＋</text>
<path class="la nf" d="M230 345 L215 345 L215 224 L358 224" marker-end="url(#arr-a)"/>
<text class="ts" x="150" y="290" text-anchor="end">残差</text>
<line class="l" x1="370" y1="300" x2="370" y2="290" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="250" x2="370" y2="236" marker-end="url(#arr)"/>
<rect class="b" x="240" y="166" width="260" height="26" rx="6"/>
<text class="ts" x="370" y="179" text-anchor="middle" dominant-baseline="middle">LayerNorm</text>
<rect class="b4" x="240" y="120" width="260" height="40" rx="6"/>
<text class="tb" x="370" y="140" text-anchor="middle" dominant-baseline="middle">前馈网络 FFN（每个词独立加工）</text>
<circle class="b5" cx="370" cy="96" r="12"/>
<text class="tb" x="370" y="96" text-anchor="middle" dominant-baseline="middle">＋</text>
<line class="l" x1="370" y1="212" x2="370" y2="192" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="166" x2="370" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="120" x2="370" y2="108" marker-end="url(#arr)"/>
<path class="la nf" d="M358 224 L560 224 L560 96 L382 96" marker-end="url(#arr-a)"/>
<text class="ts" x="570" y="160" text-anchor="start">残差</text>
<line class="l" x1="370" y1="84" x2="370" y2="60"/>
<text class="ts" x="620" y="60" text-anchor="start">↑ 输出，交给下一个块</text>
<rect class="bg" x="580" y="200" width="150" height="150" rx="10"/>
<text class="ts" x="592" y="222">注意力：</text>
<text class="ts" x="592" y="240">词与词之间交换信息</text>
<text class="ts" x="592" y="266">前馈网络：</text>
<text class="ts" x="592" y="284">两层 MLP，对每个词</text>
<text class="ts" x="592" y="302">单独“深加工”</text>
<text class="ts" x="592" y="328">（占大部分参数）</text>
</svg>
<figcaption>图 4：Transformer 块 = 注意力 + 前馈网络，各自带残差和归一化</figcaption>
</figure>

```text
x ← x + 注意力( LayerNorm(x) )       第 1 步：让词们互相交流（残差保证信息不丢）
x ← x + FFN( LayerNorm(x) )          第 2 步：每个词独立加工（FFN = 两层 MLP + 激活）
重复 N 次（如 12、32、80 层）
```

- **注意力**负责“**信息在词之间流动**”（混合上下文）；
- **FFN（前馈网络）**负责“**对每个词做非线性加工、存储知识**”，其实就是 [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp) 里的两层 MLP，**占模型大部分参数**；
- **残差 + LayerNorm**：让几十层的网络能稳定训练（见 [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)）。

**参数量估算**（粗略）：一个块约 `12 × d²` 个参数（d 是隐藏维度）。`d=4096`、32 层 ≈ 12 × 4096² × 32 ≈ **64 亿**，再加词嵌入等，就是一个“7B 级”模型的规模。

## 八、三种 Transformer：编码器、解码器、两者结合

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="三类 Transformer：仅编码器的 BERT 做理解，仅解码器的 GPT 做生成，编码器解码器结合的 T5 做序列到序列">
<rect class="b3" x="20" y="40" width="220" height="150" rx="12"/>
<text class="th" x="130" y="64" text-anchor="middle">仅编码器</text>
<text class="tb" x="130" y="88" text-anchor="middle">BERT 系列</text>
<text class="ts" x="130" y="112" text-anchor="middle">双向：每个词能看全句</text>
<text class="ts" x="130" y="132" text-anchor="middle">擅长“理解”：</text>
<text class="ts" x="130" y="150" text-anchor="middle">分类、检索、实体识别</text>
<text class="ts" x="130" y="170" text-anchor="middle">Embedding 模型</text>
<rect class="b2" x="270" y="40" width="220" height="150" rx="12"/>
<text class="th" x="380" y="64" text-anchor="middle">仅解码器</text>
<text class="tb" x="380" y="88" text-anchor="middle">GPT / LLaMA / 几乎所有 LLM</text>
<text class="ts" x="380" y="112" text-anchor="middle">单向（因果掩码）</text>
<text class="ts" x="380" y="132" text-anchor="middle">擅长“生成”：</text>
<text class="ts" x="380" y="150" text-anchor="middle">对话、写作、代码、推理</text>
<text class="ta" x="380" y="172" text-anchor="middle">当前大模型主流</text>
<rect class="b5" x="520" y="40" width="220" height="150" rx="12"/>
<text class="th" x="630" y="64" text-anchor="middle">编码器 + 解码器</text>
<text class="tb" x="630" y="88" text-anchor="middle">原版 Transformer / T5</text>
<text class="ts" x="630" y="112" text-anchor="middle">编码器读输入，</text>
<text class="ts" x="630" y="132" text-anchor="middle">解码器通过“交叉注意力”</text>
<text class="ts" x="630" y="150" text-anchor="middle">看编码器输出再生成</text>
<text class="ts" x="630" y="170" text-anchor="middle">翻译、摘要</text>
<text class="ts" x="380" y="230" text-anchor="middle">训练任务：BERT 是“完形填空”（遮住词让它猜）；GPT 是“预测下一个词”</text>
</svg>
<figcaption>图 5：编码器、解码器、编码-解码三种结构</figcaption>
</figure>

| | BERT（编码器） | GPT（解码器） |
| --- | --- | --- |
| 注意力 | **双向**，看全句 | **因果/单向**，只看前文 |
| 训练 | 遮住 15% 的词让它猜 | 预测下一个词 |
| 擅长 | 理解、分类、检索向量 | **生成**、对话、通用任务 |
| 今天 | 做文本嵌入/重排/分类 | **大语言模型的基础**，见 [LLM：从预训练到对话助手](#/aimodel/llm) |

**交叉注意力**：Q 来自一边（解码器），K、V 来自另一边（编码器），用于翻译、图文模型里“用文字去查图像特征”。

## 九、为什么 Transformer 能“做大”

| 特性 | 好处 |
| --- | --- |
| **并行计算** | 整句同时算，GPU 吃满，训练快 |
| **任意两词直连** | 长距离依赖不再需要“一步步传”，路径长度是 1 |
| **结构统一、可堆叠** | 加层、加宽就能变大，**效果随规模平滑提升**（规模定律） |
| **通用** | 文本、图像（ViT）、语音、视频、蛋白质、代码……都能用 |

代价：**注意力 O(n²)**——上下文翻倍，计算与显存约 4 倍；所以才有 FlashAttention、滑动窗口、稀疏注意力、KV Cache 等大量工程优化。

## 十、动手：自注意力的 NumPy 实现

```python
import numpy as np

def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True)); return e / e.sum(-1, keepdims=True)

def self_attention(X, Wq, Wk, Wv, causal=False):
    Q, K, V = X @ Wq, X @ Wk, X @ Wv                  # (n, d)
    scores = Q @ K.T / np.sqrt(K.shape[-1])           # (n, n)  注意力分数矩阵
    if causal:                                        # 因果掩码：屏蔽未来
        scores = np.where(np.triu(np.ones_like(scores), 1) == 1, -1e9, scores)
    weights = softmax(scores)                         # 每行和为 1
    return weights @ V, weights

np.random.seed(0)
X = np.random.randn(4, 8)                             # 4 个词，每个 8 维
Wq, Wk, Wv = [np.random.randn(8, 8) for _ in range(3)]
out, w = self_attention(X, Wq, Wk, Wv, causal=True)
print(w.round(2))                                     # 下三角矩阵，每行和为 1

# PyTorch 的现成模块
import torch, torch.nn as nn
layer = nn.TransformerEncoderLayer(d_model=64, nhead=8, dim_feedforward=256, batch_first=True)
print(layer(torch.randn(2, 10, 64)).shape)            # (2, 10, 64)
```

## 自测：你真的懂了吗？

> [!QUESTION] 用你自己的话解释 Q、K、V。
> Q 是当前词要找什么信息，K 是每个词能提供什么的标签，V 是每个词携带的实际内容。用 Q 和各个 K 的点积算相关度，经 softmax 得到权重，再对 V 加权求和，得到融合了上下文的新表示。

> [!QUESTION] 为什么注意力里要除以 √d？
> 维度 d 大时点积的数值会很大，softmax 会变得非常尖锐（接近 one-hot），梯度几乎为 0。除以 √d 把数值缩放到合适范围，使训练更稳定。

> [!QUESTION] 为什么需要位置编码？
> 自注意力对词的排列顺序不敏感，同样的词不同顺序会得到相同的结果。位置编码把顺序信息加入表示，模型才能区分“我爱你”和“你爱我”。

> [!QUESTION] 因果掩码是什么？GPT 为什么需要它？
> 它把注意力矩阵中未来位置的分数设为负无穷，使每个位置只能关注自己和之前的词。GPT 训练目标是预测下一个词，若能看到后面的词就等于抄答案，掩码保证训练与生成时信息一致，并支持并行训练。

> [!QUESTION] BERT 与 GPT 的主要区别？
> BERT 是仅编码器，双向注意力，用遮盖词预测训练，擅长理解和表示；GPT 是仅解码器，因果注意力，预测下一个词，擅长生成，是现代大语言模型的基础。

> [!QUESTION] 为什么说注意力的计算量是 O(n²)？
> 每个词都要与句子里所有词计算相关度，得到 n×n 的分数矩阵，所以计算量和显存与序列长度的平方成正比，这是长上下文昂贵的原因。
