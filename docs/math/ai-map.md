---
level: 基础
tags: [总结, 对照表, 速查表, 综合练习, MLP, CNN, RNN, Transformer, LLM, 扩散模型, 训练一步]
summary: 用一张图把 MLP、CNN、RNN、Transformer、LLM、RAG 检索、扩散模型各自用到的数学对号入座，完整手算一个神经元训练一步，附公式速查表、常见误区，以及 20 道分基础、进阶、综合三档的练习。
---

# 数学到 AI 的对照地图与综合练习

> [!ABSTRACT] 一句话版本
> - 训练任何模型都是同一个循环：**前向（线性代数）→ 损失（概率与信息论）→ 反向（微积分的链式法则）→ 更新（优化）**。模型千变万化，这四步不变。
> - 本页先给一张“模型 × 数学”的总地图，再用一个神经元把四步**完整手算一遍**，让你看到每门数学在哪一步出场。
> - 后面是**公式速查表**（符号 → 含义 → 在 AI 里的位置）、常见误区合集，和 **20 道练习**。
> - 会做练习的标志：看到一个公式，能说出每个符号是标量、向量还是矩阵、形状是什么、在训练循环的哪一步。

> [!NOTE] 怎么用这一页
> 这是本分类的收官页。如果你是按顺序学过来的，直接从第二节的手算开始，再做练习；如果你是想“查某个概念该读哪页”，用第一节的地图和表。需要速成版的同学，仍可参考 [微积分 1：导数、偏导与链式法则](#/aimodel/math-calc1)、[微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)、[线性代数 1：向量与矩阵](#/aimodel/math-la1)、[线性代数 2：特征值、SVD 与 PCA](#/aimodel/math-la2)。

## 一、总地图：每类模型用到哪些数学

下面这张图把七类常见模型和四类数学对上号。每个格子里只写**最主要的用处**，不求全。

<figure class="fig">
<svg viewBox="0 0 720 406" class="dg" role="img" aria-label="七类模型（MLP、CNN、RNN、Transformer、LLM、RAG 检索、扩散模型）分别用到线性代数、微积分、概率与信息论、优化与数值四类数学中的哪些概念">
<rect class="b1" x="118" y="20" width="148" height="34"/>
<text class="tb" x="192" y="37" text-anchor="middle" dominant-baseline="middle">线性代数</text>
<rect class="b2" x="266" y="20" width="148" height="34"/>
<text class="tb" x="340" y="37" text-anchor="middle" dominant-baseline="middle">微积分</text>
<rect class="b3" x="414" y="20" width="148" height="34"/>
<text class="tb" x="488" y="37" text-anchor="middle" dominant-baseline="middle">概率与信息论</text>
<rect class="b5" x="562" y="20" width="148" height="34"/>
<text class="tb" x="636" y="37" text-anchor="middle" dominant-baseline="middle">优化与数值</text>
<text class="tb" x="20" y="86" dominant-baseline="middle">MLP</text>
<rect class="b1" x="118" y="62" width="148" height="46"/>
<text class="ts" x="192" y="81" text-anchor="middle">y = Wx + b</text>
<text class="ts" x="192" y="98" text-anchor="middle">矩阵乘、形状</text>
<rect class="b2" x="266" y="62" width="148" height="46"/>
<text class="ts" x="340" y="81" text-anchor="middle">链式法则</text>
<text class="ts" x="340" y="98" text-anchor="middle">反向传播</text>
<rect class="b3" x="414" y="62" width="148" height="46"/>
<text class="ts" x="488" y="81" text-anchor="middle">softmax</text>
<text class="ts" x="488" y="98" text-anchor="middle">交叉熵损失</text>
<rect class="b5" x="562" y="62" width="148" height="46"/>
<text class="ts" x="636" y="81" text-anchor="middle">SGD / Adam</text>
<text class="ts" x="636" y="98" text-anchor="middle">学习率调度</text>
<text class="tb" x="20" y="132" dominant-baseline="middle">CNN</text>
<rect class="b1" x="118" y="108" width="148" height="46"/>
<text class="ts" x="192" y="127" text-anchor="middle">卷积 = 滑窗点积</text>
<text class="ts" x="192" y="144" text-anchor="middle">im2col 矩阵乘</text>
<rect class="b2" x="266" y="108" width="148" height="46"/>
<text class="ts" x="340" y="127" text-anchor="middle">共享权重的梯度</text>
<text class="ts" x="340" y="144" text-anchor="middle">要累加</text>
<rect class="b3" x="414" y="108" width="148" height="46"/>
<text class="ts" x="488" y="127" text-anchor="middle">softmax 分类</text>
<text class="ts" x="488" y="144" text-anchor="middle">交叉熵</text>
<rect class="b5" x="562" y="108" width="148" height="46"/>
<text class="ts" x="636" y="127" text-anchor="middle">归一化</text>
<text class="ts" x="636" y="144" text-anchor="middle">权重衰减 L2</text>
<text class="tb" x="20" y="178" dominant-baseline="middle">RNN</text>
<rect class="b1" x="118" y="154" width="148" height="46"/>
<text class="ts" x="192" y="173" text-anchor="middle">h = Wh + Ux</text>
<text class="ts" x="192" y="190" text-anchor="middle">谱半径决定记忆</text>
<rect class="b2" x="266" y="154" width="148" height="46"/>
<text class="ts" x="340" y="173" text-anchor="middle">沿时间展开</text>
<text class="ts" x="340" y="190" text-anchor="middle">连乘→消失/爆炸</text>
<rect class="b3" x="414" y="154" width="148" height="46"/>
<text class="ts" x="488" y="173" text-anchor="middle">序列概率连乘</text>
<text class="ts" x="488" y="190" text-anchor="middle">取对数变连加</text>
<rect class="b5" x="562" y="154" width="148" height="46"/>
<text class="ts" x="636" y="173" text-anchor="middle">梯度裁剪</text>
<text class="ts" x="636" y="190" text-anchor="middle">LSTM / 门控</text>
<text class="tb" x="20" y="224" dominant-baseline="middle">Transformer</text>
<rect class="b1" x="118" y="200" width="148" height="46"/>
<text class="ts" x="192" y="219" text-anchor="middle">QKᵀ、PV</text>
<text class="ts" x="192" y="236" text-anchor="middle">einsum、多头</text>
<rect class="b2" x="266" y="200" width="148" height="46"/>
<text class="ts" x="340" y="219" text-anchor="middle">softmax 的导数</text>
<text class="ts" x="340" y="236" text-anchor="middle">残差让梯度直达</text>
<rect class="b3" x="414" y="200" width="148" height="46"/>
<text class="ts" x="488" y="219" text-anchor="middle">注意力 = 分布</text>
<text class="ts" x="488" y="236" text-anchor="middle">交叉熵</text>
<rect class="b5" x="562" y="200" width="148" height="46"/>
<text class="ts" x="636" y="219" text-anchor="middle">AdamW</text>
<text class="ts" x="636" y="236" text-anchor="middle">warmup、调度</text>
<text class="tb" x="20" y="270" dominant-baseline="middle">LLM</text>
<rect class="b1" x="118" y="246" width="148" height="46"/>
<text class="ts" x="192" y="265" text-anchor="middle">嵌入矩阵、LoRA</text>
<text class="ts" x="192" y="282" text-anchor="middle">低秩更新</text>
<rect class="b2" x="266" y="246" width="148" height="46"/>
<text class="ts" x="340" y="265" text-anchor="middle">反向传播</text>
<text class="ts" x="340" y="282" text-anchor="middle">自动微分</text>
<rect class="b3" x="414" y="246" width="148" height="46"/>
<text class="ts" x="488" y="265" text-anchor="middle">下一词的分布</text>
<text class="ts" x="488" y="282" text-anchor="middle">熵、困惑度</text>
<rect class="b5" x="562" y="246" width="148" height="46"/>
<text class="ts" x="636" y="265" text-anchor="middle">bf16 混合精度</text>
<text class="ts" x="636" y="282" text-anchor="middle">显存与 FLOPs</text>
<text class="tb" x="20" y="316" dominant-baseline="middle">RAG 检索</text>
<rect class="b1" x="118" y="292" width="148" height="46"/>
<text class="ts" x="192" y="311" text-anchor="middle">嵌入向量</text>
<text class="ts" x="192" y="328" text-anchor="middle">余弦、点积</text>
<rect class="b2" x="266" y="292" width="148" height="46"/>
<text class="ts" x="340" y="311" text-anchor="middle">对比学习</text>
<text class="ts" x="340" y="328" text-anchor="middle">训练嵌入时用</text>
<rect class="b3" x="414" y="292" width="148" height="46"/>
<text class="ts" x="488" y="311" text-anchor="middle">分数 → 排序</text>
<text class="ts" x="488" y="328" text-anchor="middle">召回率</text>
<rect class="b5" x="562" y="292" width="148" height="46"/>
<text class="ts" x="636" y="311" text-anchor="middle">降维 PCA/SVD</text>
<text class="ts" x="636" y="328" text-anchor="middle">量化 SQ / PQ</text>
<text class="tb" x="20" y="362" dominant-baseline="middle">扩散模型</text>
<rect class="b1" x="118" y="338" width="148" height="46"/>
<text class="ts" x="192" y="357" text-anchor="middle">张量 (B,C,H,W)</text>
<text class="ts" x="192" y="374" text-anchor="middle">U-Net / 注意力</text>
<rect class="b2" x="266" y="338" width="148" height="46"/>
<text class="ts" x="340" y="357" text-anchor="middle">分数 = ∇ log p</text>
<text class="ts" x="340" y="374" text-anchor="middle">去噪方向</text>
<rect class="b3" x="414" y="338" width="148" height="46"/>
<text class="ts" x="488" y="357" text-anchor="middle">高斯加噪</text>
<text class="ts" x="488" y="374" text-anchor="middle">KL、ELBO</text>
<rect class="b5" x="562" y="338" width="148" height="46"/>
<text class="ts" x="636" y="357" text-anchor="middle">预测噪声的 MSE</text>
<text class="ts" x="636" y="374" text-anchor="middle">Adam + EMA</text>
<text class="ts" x="20" y="400">每一行是一类模型，每一列是一门数学；格子里是这门数学在该模型里最主要的用处</text>
</svg>
<figcaption>图 1：模型 × 数学：每类模型用到哪些数学概念</figcaption>
</figure>

再用一张表告诉你每一行该读本分类的哪几页：

| 模型 | 数学骨架（一句话） | 本分类里该读 | 站内 AI 页 |
| --- | --- | --- | --- |
| **MLP** | 每层 `y = f(Wx + b)`，用链式法则反向传播，Adam 更新 | [矩阵](#/math/matrices)、[导数](#/math/derivative)、[链式法则与反向传播](#/math/chain-backprop)、[极值与优化](#/math/optimization) | [MLP](#/aimodel/mlp) |
| **CNN** | 卷积 = 滑窗点积（可写成矩阵乘），共享权重 | [向量](#/math/vectors)、[张量、广播与 einsum](#/math/tensors)（im2col、参数量与 FLOPs） | [CNN](#/aimodel/cnn) |
| **RNN / LSTM** | 同一个矩阵反复乘；谱半径决定梯度消失/爆炸 | [特征值与特征向量](#/math/eigen)、[链式法则与反向传播](#/math/chain-backprop)（连乘） | [RNN 与 LSTM](#/aimodel/rnn) |
| **Transformer** | `softmax(QKᵀ/√dₖ)V`：点积、批量矩阵乘、einsum | [向量](#/math/vectors)（点积）、[张量、广播与 einsum](#/math/tensors)、[函数、极限与连续](#/math/limit)（softmax 数值稳定） | [Transformer](#/aimodel/transformer) |
| **LLM** | 下一词的概率分布 + 交叉熵；LoRA 低秩微调；bf16 混合精度 | [积分与期望](#/math/integral)、[SVD 与低秩](#/math/svd)、[极值与优化](#/math/optimization) | [LLM](#/aimodel/llm)、[训练神经网络](#/aimodel/training) |
| **RAG 检索** | 嵌入向量 + 余弦/点积；降维、量化省存储 | [向量](#/math/vectors)（余弦）、[SVD 与低秩](#/math/svd)（降维） | [RAG 向量检索逻辑](#/ai/rag-vector) |
| **扩散模型** | 高斯加噪（概率），训练一个网络预测噪声（MSE），分数 = 对数密度的梯度 | [积分与期望](#/math/integral)（高斯）、[偏导数与梯度](#/math/gradient)、[泰勒展开与二阶信息](#/math/taylor) | [模型家族地图](#/aimodel/zoo) |

> [!TIP] 本分类 16 页的分工
> 微积分线：[AI 数学学习地图](#/math/start) → [函数、极限与连续](#/math/limit) → [导数](#/math/derivative) → [偏导数与梯度](#/math/gradient) → [链式法则与反向传播](#/math/chain-backprop) → [极值与优化](#/math/optimization) → [泰勒展开与二阶信息](#/math/taylor) → [积分与期望](#/math/integral)。线性代数线：[向量](#/math/vectors) → [矩阵](#/math/matrices) → [线性方程组、逆矩阵与秩](#/math/linear-systems) → [正交与投影](#/math/projection) → [特征值与特征向量](#/math/eigen) → [SVD 与低秩](#/math/svd) → [张量、广播与 einsum](#/math/tensors)。

## 二、一个神经元训练一步：四个阶段，四门数学

[AI 数学学习地图](#/math/start) 里我们只走到了损失；现在把**学习**也补上。同一个神经元：

```text
输入 x = (2, 1)，标签 y = 1（“通过考试”）
参数 w = (0.8, −0.4)，b = 0.1，学习率 η = 0.5（取大一点，让变化看得清）
```

### 1. 前向：线性代数

```text
z = w·x + b = 0.8×2 + (−0.4)×1 + 0.1 = 1.3          ← 点积（矩阵乘的特例）
ŷ = σ(z) = 1/(1 + e^(−1.3)) = 0.7858                 ← sigmoid，压成 0~1 的概率
```

### 2. 损失：概率与信息论

```text
L = −[ y·ln ŷ + (1−y)·ln(1−ŷ) ] = −ln 0.7858 = 0.2410        （y = 1，所以只剩第一项）
```

这是二分类交叉熵：模型给正确答案的概率越高，损失越小；给 0.1 就会涨到 2.303。

### 3. 反向：微积分的链式法则

目标是 `∂L/∂w` 和 `∂L/∂b`。从 L 一路乘回去，每一段只用一个简单的局部导数：

```text
∂L/∂ŷ = −y/ŷ + (1−y)/(1−ŷ) = −1/0.7858 = −1.2725
∂ŷ/∂z = ŷ(1−ŷ) = 0.7858 × 0.2142 = 0.1683             ← sigmoid 的导数
∂L/∂z = ∂L/∂ŷ × ∂ŷ/∂z = −1.2725 × 0.1683 = −0.2142     ← 恰好等于 ŷ − y = 0.7858 − 1
∂z/∂w = x = (2, 1)，   ∂z/∂b = 1
∂L/∂w = ∂L/∂z × x = −0.2142 × (2, 1) = (−0.4283, −0.2142)
∂L/∂b = ∂L/∂z × 1 = −0.2142
```

<figure class="fig">
<svg viewBox="0 0 720 320" class="dg" role="img" aria-label="一个神经元训练一步：前向依次得到 z、ŷ 和损失 L，反向用三个局部导数连乘得到对 w 和 b 的梯度，再按学习率 0.5 更新参数">
<rect class="b" x="20" y="52" width="110" height="58" rx="8"/>
<text class="tb" x="75" y="72" text-anchor="middle" dominant-baseline="middle">输入 x</text>
<text class="tm" x="75" y="94" text-anchor="middle" dominant-baseline="middle">(2, 1)</text>
<rect class="b1" x="170" y="52" width="150" height="58" rx="8"/>
<text class="tb" x="245" y="72" text-anchor="middle" dominant-baseline="middle">z = w·x + b</text>
<text class="tm" x="245" y="94" text-anchor="middle" dominant-baseline="middle">= 1.3</text>
<rect class="b3" x="360" y="52" width="140" height="58" rx="8"/>
<text class="tb" x="430" y="72" text-anchor="middle" dominant-baseline="middle">ŷ = σ(z)</text>
<text class="tm" x="430" y="94" text-anchor="middle" dominant-baseline="middle">= 0.7858</text>
<rect class="b4" x="540" y="52" width="160" height="58" rx="8"/>
<text class="tb" x="620" y="72" text-anchor="middle" dominant-baseline="middle">L = −ln ŷ</text>
<text class="tm" x="620" y="94" text-anchor="middle" dominant-baseline="middle">= 0.2410</text>
<text class="ts" x="245" y="42" text-anchor="middle">线性代数：前向</text>
<text class="ts" x="430" y="42" text-anchor="middle">非线性函数</text>
<text class="ts" x="620" y="42" text-anchor="middle">概率：损失</text>
<line class="l" x1="130" y1="81" x2="170" y2="81" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="81" x2="360" y2="81" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="81" x2="540" y2="81" marker-end="url(#arr)"/>
<text class="ts" x="150" y="130" text-anchor="middle">∂z/∂w = x</text>
<text class="ts" x="340" y="130" text-anchor="middle">∂ŷ/∂z = 0.168</text>
<text class="ts" x="520" y="130" text-anchor="middle">∂L/∂ŷ = −1.273</text>
<line class="la" x1="690" y1="146" x2="30" y2="146" marker-end="url(#arr-a)"/>
<text class="ta" x="360" y="166" text-anchor="middle">反向：把三个局部导数连乘（链式法则）</text>
<rect class="bg" x="20" y="184" width="680" height="120" rx="10"/>
<text class="tb" x="36" y="208">∂L/∂z = (−1.273) × 0.168 = −0.2142        恰好等于 ŷ − y</text>
<text class="tb" x="36" y="232">∂L/∂w = −0.2142 × (2, 1) = (−0.428, −0.214)，   ∂L/∂b = −0.2142</text>
<text class="ta" x="36" y="260">更新（η = 0.5）：w ← (1.014, −0.293)，b ← 0.207</text>
<text class="ts" x="36" y="284">再前向一次：ŷ = 0.8746，L = 0.1340（原来 0.2410），一步就下降了 44%</text>
</svg>
<figcaption>图 2：一步训练：前向（线代）→ 损失（概率）→ 反向（微积分）→ 更新（优化）</figcaption>
</figure>

两个负号的意思：**w 和 b 调大一点，损失会下降**。注意中间那个“恰好等于 `ŷ − y`”不是巧合：**sigmoid + 二分类交叉熵**（以及 softmax + 交叉熵）的组合，会把乘出来的一大串化简成“预测减答案”，这是它们总是成对出现的原因。

### 4. 更新：优化

```text
w ← w − η·∂L/∂w = (0.8, −0.4) − 0.5 × (−0.4283, −0.2142) = (1.0142, −0.2929)
b ← b − η·∂L/∂b = 0.1 − 0.5 × (−0.2142)                = 0.2071
```

### 5. 验证：再前向一次

```text
z = 1.0142×2 + (−0.2929)×1 + 0.2071 = 1.9425      ŷ = σ(1.9425) = 0.8746      L = −ln 0.8746 = 0.1340
```

预测概率从 0.7858 涨到 0.8746，损失从 0.2410 降到 0.1340。**一次“前向 → 损失 → 反向 → 更新”就让模型变好了一点**；GPT 级别的大模型做的，就是在几千亿个参数上、用不同的数据把这件事重复万亿次。

### 6. Python 核对：手写、自动微分、重复 20 步

```python
import numpy as np
sig = lambda z: 1 / (1 + np.exp(-z))
x = np.array([2., 1.]); w = np.array([0.8, -0.4]); b = 0.1; y = 1.0; eta = 0.5
for step in range(21):
    z = w @ x + b                  # 前向（线性代数）
    yh = sig(z)
    L = -np.log(yh)                # 损失（概率）
    g = yh - y                     # ∂L/∂z（链式法则乘出来再化简的结果）
    if step in (0, 1, 5, 20): print(step, round(L, 4), round(yh, 4))
    w = w - eta * g * x            # 更新（优化）：∂L/∂w = g·x
    b = b - eta * g                #               ∂L/∂b = g
# 0 0.241 0.7858
# 1 0.134 0.8746
# 5 0.05 0.9512
# 20 0.0152 0.9849

import torch                       # 用自动微分核对手算的梯度
w_t = torch.tensor([0.8, -0.4], requires_grad=True); b_t = torch.tensor(0.1, requires_grad=True)
x_t = torch.tensor([2., 1.])
L = -torch.log(torch.sigmoid(w_t @ x_t + b_t)); L.backward()
print(w_t.grad, b_t.grad)          # tensor([-0.4283, -0.2142]) tensor(-0.2142)
```

手算的梯度和 PyTorch 的 `backward()` 完全一致。

<figure class="fig">
<svg viewBox="0 0 720 292" class="dg" role="img" aria-label="同一个神经元用学习率 0.5 训练 20 步，损失从 0.241 逐步下降到 0.015，曲线越来越平">
<line class="l" x1="70" y1="250" x2="391" y2="250" marker-end="url(#arr)"/>
<line class="l" x1="70" y1="250" x2="70" y2="40" marker-end="url(#arr)"/>
<text class="ts" x="62" y="254" text-anchor="end">0.0</text>
<text class="ts" x="62" y="176" text-anchor="end">0.1</text>
<line class="ld" x1="70" y1="172" x2="385" y2="172"/>
<text class="ts" x="62" y="98" text-anchor="end">0.2</text>
<line class="ld" x1="70" y1="94" x2="385" y2="94"/>
<text class="ts" x="70" y="268" text-anchor="middle">0</text>
<text class="ts" x="145" y="268" text-anchor="middle">5</text>
<text class="ts" x="220" y="268" text-anchor="middle">10</text>
<text class="ts" x="295" y="268" text-anchor="middle">15</text>
<text class="ts" x="370" y="268" text-anchor="middle">20</text>
<text class="ts" x="385" y="284" text-anchor="end">训练步数</text>
<text class="ts" x="76" y="34">损失 L</text>
<line class="la" x1="70" y1="62" x2="85" y2="145.5"/>
<line class="la" x1="85" y1="145.5" x2="100" y2="176.8"/>
<line class="la" x1="100" y1="176.8" x2="115" y2="193.4"/>
<line class="la" x1="115" y1="193.4" x2="130" y2="203.8"/>
<line class="la" x1="130" y1="203.8" x2="145" y2="211"/>
<line class="la" x1="145" y1="211" x2="160" y2="216.2"/>
<line class="la" x1="160" y1="216.2" x2="175" y2="220.1"/>
<line class="la" x1="175" y1="220.1" x2="190" y2="223.3"/>
<line class="la" x1="190" y1="223.3" x2="205" y2="225.8"/>
<line class="la" x1="205" y1="225.8" x2="220" y2="227.9"/>
<line class="la" x1="220" y1="227.9" x2="235" y2="229.6"/>
<line class="la" x1="235" y1="229.6" x2="250" y2="231.1"/>
<line class="la" x1="250" y1="231.1" x2="265" y2="232.4"/>
<line class="la" x1="265" y1="232.4" x2="280" y2="233.6"/>
<line class="la" x1="280" y1="233.6" x2="295" y2="234.5"/>
<line class="la" x1="295" y1="234.5" x2="310" y2="235.4"/>
<line class="la" x1="310" y1="235.4" x2="325" y2="236.2"/>
<line class="la" x1="325" y1="236.2" x2="340" y2="236.9"/>
<line class="la" x1="340" y1="236.9" x2="355" y2="237.5"/>
<line class="la" x1="355" y1="237.5" x2="370" y2="238.1"/>
<circle class="b3" cx="70" cy="62" r="3.2"/>
<circle class="b3" cx="85" cy="145.5" r="3.2"/>
<circle class="b3" cx="100" cy="176.8" r="3.2"/>
<circle class="b3" cx="115" cy="193.4" r="3.2"/>
<circle class="b3" cx="130" cy="203.8" r="3.2"/>
<circle class="b3" cx="145" cy="211" r="3.2"/>
<circle class="b3" cx="160" cy="216.2" r="3.2"/>
<circle class="b3" cx="175" cy="220.1" r="3.2"/>
<circle class="b3" cx="190" cy="223.3" r="3.2"/>
<circle class="b3" cx="205" cy="225.8" r="3.2"/>
<circle class="b3" cx="220" cy="227.9" r="3.2"/>
<circle class="b3" cx="235" cy="229.6" r="3.2"/>
<circle class="b3" cx="250" cy="231.1" r="3.2"/>
<circle class="b3" cx="265" cy="232.4" r="3.2"/>
<circle class="b3" cx="280" cy="233.6" r="3.2"/>
<circle class="b3" cx="295" cy="234.5" r="3.2"/>
<circle class="b3" cx="310" cy="235.4" r="3.2"/>
<circle class="b3" cx="325" cy="236.2" r="3.2"/>
<circle class="b3" cx="340" cy="236.9" r="3.2"/>
<circle class="b3" cx="355" cy="237.5" r="3.2"/>
<circle class="b3" cx="370" cy="238.1" r="3.2"/>
<text class="tb" x="80" y="66">第 0 步：0.241</text>
<text class="tb" x="95" y="135.5">第 1 步：0.134（上一节手算的那一步）</text>
<text class="tb" x="153" y="197">第 5 步：0.050</text>
<text class="tb" x="362" y="224.1" text-anchor="end">第 20 步：0.015</text>
<rect class="bg" x="440" y="120" width="260" height="120" rx="10"/>
<text class="tb" x="454" y="144">同一个神经元、同一个样本</text>
<text class="ts" x="454" y="166">每一步都是：前向→损失→反向→更新</text>
<text class="ts" x="454" y="188">梯度 = ŷ − y，预测越接近答案越小，</text>
<text class="ts" x="454" y="208">所以步子自动变小，曲线越来越平</text>
<text class="ts" x="454" y="228">（学习率 η = 0.5 没有变）</text>
</svg>
<figcaption>图 3：重复“一步训练”：损失曲线</figcaption>
</figure>

> [!NOTE] 换成一批样本、一整层，只是形状变了
> 如果一次喂 B 个样本、输出 m 个神经元：`Z = X·Wᵀ + b`（X 是 `(B, in)`，W 是 `(m, in)`），`ŷ = softmax(Z)`，`∂L/∂Z = (ŷ − Y)/B`，`∂L/∂W = (∂L/∂Z)ᵀ·X`，`∂L/∂X = (∂L/∂Z)·W`。形状检查（见 [张量、广播与 einsum](#/math/tensors)）能帮你发现 90% 的写错。

## 三、公式速查表：符号 → 含义 → 在 AI 里的位置

### 1. 微积分与优化

| 符号 / 公式 | 含义 | 在 AI 里的位置 |
| --- | --- | --- |
| `f′(x)`、`df/dx` | 导数：x 变一点点，f 变多少（切线斜率） | 一切梯度的基础，见 [导数](#/math/derivative) |
| `(xⁿ)′ = n·xⁿ⁻¹` | 幂函数求导 | 平方损失 `(ŷ − y)²` 的导数是 `2(ŷ − y)` |
| `(eˣ)′ = eˣ`，`(ln x)′ = 1/x` | 指数、对数求导 | softmax、交叉熵 |
| `σ′(z) = σ(z)(1 − σ(z))` | sigmoid 的导数，最大 0.25 | 二分类输出；连乘导致梯度消失 |
| `tanh′ = 1 − tanh²`，`ReLU′ = 1[z > 0]` | 两个激活函数的导数 | RNN；隐藏层默认选择 |
| `∂L/∂w`（∂ 念“偏”） | 偏导：只拧 w，其他旋钮不动 | 每个参数“该为损失负多少责任” |
| `∇L = (∂L/∂w₁, …, ∂L/∂wₙ)`（∇ 念 nabla） | 梯度：偏导打包成向量，指向最陡的上坡 | 梯度下降，见 [偏导数与梯度](#/math/gradient) |
| `dy/dx = dy/du · du/dx` | 链式法则：路径上的局部导数相乘，多条路径相加 | 反向传播，见 [链式法则与反向传播](#/math/chain-backprop) |
| `θ ← θ − η∇L` | 梯度下降：沿负梯度走一小步 | 训练循环；稳定需要 `η < 2/λmax`，见 [极值与优化](#/math/optimization) |
| `m ← β₁m + (1−β₁)g`，`v ← β₂v + (1−β₂)g²`，`θ ← θ − η·m̂/(√v̂ + ε)` | Adam：动量 + 按坐标自适应步长 | 大模型训练的默认优化器（AdamW） |
| `L(θ+Δ) ≈ L + ∇Lᵀ Δ + ½ ΔᵀHΔ` | 二阶泰勒：H 是 Hessian | 为什么梯度下降只在小步长内有效，见 [泰勒展开与二阶信息](#/math/taylor) |
| `lim`、连续 | 逼近；ReLU 连续、阶跃函数不连续 | 激活函数能不能用；`exp` 溢出，见 [函数、极限与连续](#/math/limit) |

### 2. 线性代数

| 符号 / 公式 | 含义 | 在 AI 里的位置 |
| --- | --- | --- |
| `a·b = Σ aᵢbᵢ = ‖a‖‖b‖cos θ` | 点积 = 对应相乘再求和 | 神经元的加权求和；注意力的相似度，见 [向量](#/math/vectors) |
| `cos θ = a·b / (‖a‖‖b‖)` | 余弦相似度，只看方向 | RAG 检索、嵌入相似度 |
| `(m×n)(n×p) = (m×p)` | 矩阵乘的形状规则 | 查 shape 是第一技能，见 [矩阵](#/math/matrices) |
| `(AB)ᵀ = BᵀAᵀ` | 转置反转乘法顺序 | 反向传播里 `∂L/∂X = (∂L/∂Y)Wᵀ` |
| `Ax = b`，`AᵀAx = Aᵀb` | 方程组；正规方程（最小二乘） | 线性回归，见 [线性方程组、逆矩阵与秩](#/math/linear-systems)、[正交与投影](#/math/projection) |
| `Av = λv` | 特征向量（不被拧歪的方向）与特征值 | PCA、谱半径，见 [特征值与特征向量](#/math/eigen) |
| `A = UΣVᵀ` | SVD：旋转 → 拉伸 → 旋转 | 压缩、推荐、PCA，见 [SVD 与低秩](#/math/svd) |
| `ΔW = BA`，参数 `2dr` 对 `d²` | 低秩更新 | LoRA |
| `einsum('bqd,bkd->bqk')` | 输出里有的保留，没有的求和 | 注意力分数，见 [张量、广播与 einsum](#/math/tensors) |
| 矩阵乘 FLOPs ≈ `2·m·k·n` | 浮点运算次数 | 成本估算：前向每 token ≈ 2 × 参数量 |

### 3. 概率与信息论

| 符号 / 公式 | 含义 | 在 AI 里的位置 |
| --- | --- | --- |
| `softmax(z)ᵢ = e^(zᵢ) / Σⱼ e^(zⱼ)` | 把一组分数变成和为 1 的概率 | 多分类输出、注意力权重 |
| `L = −Σ yᵢ ln ŷᵢ` | 交叉熵：给正确答案的概率越低，损失越大 | 分类、LLM 的下一词预测，见 [概率与信息论入门](#/aimodel/math-prob) |
| `L = ½(ŷ − y)²` | 均方误差 | 回归；扩散模型预测噪声 |
| `∂L/∂z = ŷ − y` | softmax（或 sigmoid）+ 交叉熵的梯度 | 反向传播的起点 |
| `E[X] = Σ x·p(x)` 或 `∫ x·p(x)dx` | 期望：按概率加权的平均 | 损失是对数据分布的期望，见 [积分与期望](#/math/integral) |
| `N(μ, σ²)`：`p(x) = exp(−(x−μ)²/(2σ²)) / √(2πσ²)` | 高斯分布的密度 | 权重初始化、噪声、VAE、扩散 |
| `KL(p‖q) = Σ p·ln(p/q)` | 两个分布的“差距” | VAE、蒸馏、RLHF 里的约束 |
| `PPL = exp(平均交叉熵)` | 困惑度：模型平均“在几个词之间犹豫” | LLM 评估 |
| 蒙特卡洛：`E[f(X)] ≈ (1/N) Σ f(xᵢ)`，误差 ∝ `1/√N` | 用采样估计积分 | mini-batch 梯度、重参数化 |

## 四、常见误区合集

| 误区 | 正解 | 回头看 |
| --- | --- | --- |
| “沿梯度方向走，损失就下降” | 梯度指向**上坡**，要沿**负梯度**走 | [偏导数与梯度](#/math/gradient) |
| “导数为 0 就是最小值” | 也可能是极大值或鞍点；高维里鞍点更常见，要看二阶信息 | [极值与优化](#/math/optimization) |
| “学习率越大收敛越快” | 超过 `2/λmax` 就发散；陡的方向限制了步长 | [极值与优化](#/math/optimization)、[特征值与特征向量](#/math/eigen) |
| “点积大就是相似” | 点积同时受长度影响；只比方向用余弦 | [向量](#/math/vectors) |
| “`AB = BA`” | 矩阵乘法一般不可交换，形状也可能不允许反过来乘 | [矩阵](#/math/matrices) |
| “多叠几层线性层就更强” | 没有非线性，多层线性等于一层线性 | [矩阵](#/math/matrices) |
| “奇异值就是特征值” | 只有对称半正定矩阵两者才相等；一般矩阵不相等 | [SVD 与低秩](#/math/svd) |
| “PCA 保留方差最大的方向，一定对任务最有用” | 方差大不等于有用；PCA 不看标签；先去均值、统一量纲 | [特征值与特征向量](#/math/eigen) |
| “代码形状对得上，结果就对” | 广播会悄悄“对上”但算错，如忘了 `keepdims` | [张量、广播与 einsum](#/math/tensors) |
| “`softmax` 直接 `exp` 就行” | `exp` 容易溢出，先减最大值；损失直接用 logits 的 `log_softmax` | [函数、极限与连续](#/math/limit) |
| “概率密度的值不能超过 1” | 密度是单位长度的概率，可以大于 1；**面积**才是概率 | [积分与期望](#/math/integral) |
| “梯度消失是 bug” | 是连乘的必然结果（局部导数 < 1 反复相乘），靠 ReLU、残差、归一化缓解 | [链式法则与反向传播](#/math/chain-backprop) |
| “LoRA 的低秩是定理” | 是经验假设：任务越复杂，需要的 r 越大 | [SVD 与低秩](#/math/svd) |
| “自动微分 = 数值微分” | 前者是精确的链式法则（反向模式），后者是有限差分近似 | [导数](#/math/derivative) |

## 五、综合练习与自测（20 题）

每题先自己做，再点开答案对照。数字都已用 Python 核对。

### 基础（7 题）

> [!QUESTION] B1 求导与极值：`f(x) = x³ − 3x` 的驻点在哪里？分别是极大还是极小？
> `f′(x) = 3x² − 3 = 0`，驻点 `x = ±1`。二阶导 `f″(x) = 6x`：`f″(−1) = −6 < 0`，是**极大值**（`f = 2`）；`f″(1) = 6 > 0`，是**极小值**（`f = −2`）。这是局部极值，函数在两头无界，没有全局最值。

> [!QUESTION] B2 偏导与梯度下降：`f(x, y) = x²y + y³`，在 `(1, 2)` 处求梯度，并沿负梯度走一步（`η = 0.1`），f 从多少变成多少？
> `∂f/∂x = 2xy = 4`，`∂f/∂y = x² + 3y² = 13`，梯度 `(4, 13)`。新位置 `(1 − 0.4, 2 − 1.3) = (0.6, 0.7)`，`f = 0.36×0.7 + 0.343 = 0.595`，原来 `f(1, 2) = 10`，下降很多。

> [!QUESTION] B3 链式法则：`y = (2x + 1)³`，求 `dy/dx`，并算 `x = 1` 处的值。
> 令 `u = 2x + 1`，`y = u³`，`dy/dx = 3u² × 2 = 6(2x + 1)²`，`x = 1` 时 `6 × 9 = 54`。外层导数乘内层导数，反向传播就是这个想法反复用。

> [!QUESTION] B4 向量：`a = (1, 2, 2)`，`b = (2, 1, 2)`。求两个向量的长度、点积和余弦相似度。
> `‖a‖ = √9 = 3`，`‖b‖ = √9 = 3`，`a·b = 2 + 2 + 4 = 8`，`cos θ = 8/(3×3) = 8/9 ≈ 0.889`（夹角约 27°），方向很接近。

> [!QUESTION] B5 形状与参数：一个全连接层把 `(B, 784)` 的输入变成 `(B, 256)`。权重矩阵的形状（按 `X @ W` 写）和参数量（含偏置）是多少？如果框架把权重存成 `(256, 784)`，前向要怎么写？
> `X @ W` 要求 `W` 是 `(784, 256)`，参数 `784×256 + 256 = 200,960`。存成 `(256, 784)` 就要写 `X @ W.T`，也就是 PyTorch `nn.Linear` 的 `y = x·Wᵀ + b`。

> [!QUESTION] B6 softmax 与交叉熵：分数 `z = (2, 1, 0)`，真实类别是第 1 类（下标 0）。求 softmax 概率、交叉熵损失，以及 `∂L/∂z`。
> `e^z = (7.389, 2.718, 1)`，和 `11.107`，概率 `(0.665, 0.245, 0.090)`。损失 `−ln 0.665 = 0.408`。梯度 `ŷ − y = (0.665 − 1, 0.245, 0.090) = (−0.335, 0.245, 0.090)`，和为 0：正确类被推高，其他类被压低。

> [!QUESTION] B7 广播：`X` 的形状是 `(100, 3)`，要对每一列做标准化 `(X − 均值) / 标准差`，再对**每一行**做除以自己的长度。分别应该怎么写，用到什么形状？
> 列标准化：`(X - X.mean(axis=0)) / X.std(axis=0)`，均值和标准差都是 `(3,)`，右对齐后每一列各用各的。行归一化：`X / np.linalg.norm(X, axis=1, keepdims=True)`，范数是 `(100, 1)`，必须 `keepdims=True` 才是“每一行除以自己的长度”。

### 进阶（7 题）

> [!QUESTION] A1 学习率与稳定性：`f(x) = 5x²`（曲率 `L = 10`），梯度下降 `x ← x − η·f′(x)`。分别取 `η = 0.1、0.15、0.25`，写出 `x ← ? × x`，并说明各自的行为。
> `f′(x) = 10x`，所以 `x ← (1 − 10η)x`。`η = 0.1`：系数 `0`，一步到底；`η = 0.15`：系数 `−0.5`，符号来回翻、幅度减半地震荡收敛；`η = 0.25`：系数 `−1.5`，绝对值大于 1，震荡并发散。稳定范围 `0 < η < 2/10 = 0.2`。

> [!QUESTION] A2 带 ReLU 的反向传播：`h = ReLU(w₁x)`，`y = w₂h`，`L = ½(y − t)²`。取 `x = 1, w₁ = 0.5, w₂ = 2, t = 3`，求 `∂L/∂w₁` 和 `∂L/∂w₂`，并用 `η = 0.1` 更新一步，新损失是多少？
> 前向：`h = 0.5`，`y = 1.0`，`L = 2.0`。反向：`∂L/∂y = y − t = −2`；`∂L/∂w₂ = −2 × h = −1`；`∂L/∂h = −2 × w₂ = −4`；`w₁x = 0.5 > 0`，ReLU 导数为 1，`∂L/∂w₁ = −4 × 1 × x = −4`。更新：`w₂ = 2.1`，`w₁ = 0.9`，`y = 2.1 × 0.9 = 1.89`，`L = ½(1.11)² = 0.616`，从 2.0 下降。

> [!QUESTION] A3 梯度消失：10 层 sigmoid 网络，每层的局部导数最大是 0.25。只看激活函数这一项，梯度传回第一层最多被缩小到多少？换成 ReLU 呢？
> 最多 `0.25¹⁰ ≈ 9.5×10⁻⁷`：近乎 0，浅层几乎学不动。ReLU 在正区间的导数是 1，连乘不会衰减（但负区间为 0，可能“死掉”）。对策：ReLU/GELU、残差连接、归一化、LSTM 门控。

> [!QUESTION] A4 PCA：某数据去均值后的协方差矩阵是 `[[2, 1], [1, 2]]`。求主成分方向和它解释的方差比例。
> 特征方程 `(2 − λ)² − 1 = 0`，`λ = 3, 1`。`λ = 3` 的特征向量满足 `−x + y = 0`，即 `(1, 1)/√2`，这就是第一主成分；解释方差 `3/(3 + 1) = 75%`。

> [!QUESTION] A5 LoRA 参数量：`d = 1024`，`r = 16`，给一个 `d×d` 的矩阵加 LoRA，可训练参数多少？占全量的比例？`r = 64` 呢？
> 全量 `1024² = 1,048,576`；LoRA `2×1024×16 = 32,768`，占 `32,768/1,048,576 = 3.125%`（1/32）。`r = 64`：`131,072`，占 `12.5%`。参数随 r 线性增长。

> [!QUESTION] A6 注意力缩放：`dₖ = 64`，q、k 各分量是均值 0、方差 1 的独立随机数。点积的标准差是多少？如果两个分数恰好差 8，softmax 权重和梯度会怎样？除以 `√dₖ` 后呢？
> 点积是 64 个“方差 1”的数相加，标准差 `√64 = 8`。分数差 8 时 `softmax(8, 0) = (0.99966, 0.00034)`，梯度因子 `p(1−p) ≈ 3.4×10⁻⁴`，几乎为 0，学不动。除以 `√64 = 8` 后分数差 1，`softmax(1, 0) = (0.731, 0.269)`，`p(1−p) ≈ 0.197`，梯度健康。

> [!QUESTION] A7 成本估算：一个 70 亿参数（7B）的模型，权重用 fp16 要占多少显存？前向算一个 token 大约多少 FLOPs？生成 100 个 token 呢？
> 权重 `7×10⁹ × 2 字节 = 14 GB`（不含 KV Cache 和激活）。前向约 `2 × 参数量 = 1.4×10¹⁰ = 14 GFLOPs` 每个 token，100 个 token 约 `1.4 TFLOPs`（忽略随上下文长度增长的注意力项）。

### 综合（6 题）

> [!QUESTION] C1 把第二节的手算写成循环跑 20 步（上面的 Python 代码）：第 20 步的损失和预测概率是多少？为什么损失下降得越来越慢，学习率明明没变？
> 第 20 步 `L = 0.0152`，`ŷ = 0.9849`。梯度 `∂L/∂z = ŷ − y` 正比于“还差多少”，预测越接近答案，梯度越小，步子也越小，所以曲线越来越平。这也是为什么大模型训练后期要靠学习率调度、更多数据，而不是单靠多跑几步。

> [!QUESTION] C2 线性回归三合一：数据 `(1, 2)、(2, 3)、(3, 5)`，拟合 `y = a + b·x`。（1）用正规方程求 `a, b`；（2）验证残差垂直于 `[1, x]` 的两列；（3）在 `(a, b) = (0, 0)` 处，平均平方误差 `L = (1/3)Σ(y − a − bx)²` 的梯度是多少？
> （1）`AᵀA = [[3, 6], [6, 14]]`，`Aᵀy = (10, 23)`，解 `3a + 6b = 10`、`6a + 14b = 23` 得 `b = 1.5`，`a = 1/3`。（2）残差 `(1/6, −1/3, 1/6)`，和为 0，且 `Σ x·残差 = 1/6 − 2/3 + 1/2 = 0`，即残差垂直于两列（见 [正交与投影](#/math/projection)）。（3）`∂L/∂a = −(2/3)Σy = −6.667`，`∂L/∂b = −(2/3)Σxy = −(2/3)×23 = −15.333`。梯度下降最终会走到 `(1/3, 1.5)`，和正规方程的解一致。

> [!QUESTION] C3 形状推导：一个自注意力层，输入 `(B, n, d) = (2, 10, 64)`，`h = 8` 个头。（1）每个头的维度 `dₖ`；（2）Q、K、V 与输出投影共 4 个 `64→64` 的线性层（带偏置）共多少参数；（3）注意力分数张量的形状和元素个数。
> （1）`dₖ = 64/8 = 8`。（2）每个线性层 `64×64 + 64 = 4,160`，共 `4 × 4,160 = 16,640`。（3）切成多头后 Q、K 是 `(2, 8, 10, 8)`，分数 `(2, 8, 10, 10)`，元素 `2×8×10×10 = 1,600`。einsum 写法是 `'bhqd,bhkd->bhqk'`。

> [!QUESTION] C4 条件数与迭代次数：某损失在最优点附近是二次函数，Hessian 的特征值是 `100` 和 `1`。（1）条件数；（2）梯度下降学习率的稳定上界；（3）取最优学习率 `η = 2/(λmax + λmin)`，每步误差收缩多少倍，要降到千分之一大约几步？
> （1）`100/1 = 100`。（2）`η < 2/λmax = 0.02`。（3）`η = 2/101 ≈ 0.0198`，两个方向每步分别乘 `1 − ηλ`，绝对值都是 `(κ−1)/(κ+1) = 99/101 ≈ 0.980`。`ln(0.001)/ln(0.9802) ≈ 345` 步。条件数越大，收敛越慢。

> [!QUESTION] C5 蒙特卡洛：用 10000 个标准正态样本估计 `E[X²]`（真值为 1）。写出估计方法，并估算误差大小。
> `x = np.random.default_rng(0).standard_normal(10000); (x**2).mean()` 得到 `0.9962`。`X²` 的方差是 2，标准误差 `√(2/10000) = 0.0141`，所以结果在 `1 ± 0.014` 内波动。想让误差再小 10 倍，样本要多 100 倍（误差 ∝ `1/√N`）。这就是 mini-batch 梯度也是“带噪声的估计”的原因。

> [!QUESTION] C6 排错：训练时损失一开始就变成 `nan`。从本分类的数学出发，列出至少 4 个可能的原因和检查方法。
> ① `exp` 溢出（softmax 没减最大值、fp16 里 `exp(12)` 就是 `inf`），改用稳定的 `log_softmax`；② `log(0)`：预测概率为 0 时交叉熵无穷，给概率加下限或用 logits 版损失；③ 学习率超过 `2/λmax`，参数发散成 `inf`，减小学习率、加梯度裁剪；④ 除以 0（归一化里的范数或标准差为 0），加 `ε`；⑤ 输入数据本身带 `nan`/`inf`；⑥ 梯度爆炸（RNN、深网络里连乘大于 1），梯度裁剪、检查初始化。先用很小的 batch 跑一步，逐层打印数值范围。

## 六、下一步怎么学

你已经有了“看懂公式、手算小例子”的数学底子。接下来是把它们用在真实模型上：

| 想做什么 | 读哪页 |
| --- | --- |
| 看懂神经网络怎么前向、反向 | [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)（本页第二节的放大版） |
| 理解优化器、正则化、训练中的坑 | [训练神经网络：优化器、正则化与常见坑](#/aimodel/training) |
| 看懂注意力与 Transformer | [注意力与 Transformer：大模型的骨架](#/aimodel/transformer) |
| 从预训练到对话助手 | [LLM：从预训练到对话助手](#/aimodel/llm) |
| 看懂损失函数、概率、信息论 | [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob) |
| 卷积网络 / 循环网络 | [CNN：卷积神经网络如何“看图”](#/aimodel/cnn)、[RNN 与 LSTM：会“记事”的网络](#/aimodel/rnn) |
| 向量检索与 RAG | [RAG 向量检索逻辑](#/ai/rag-vector) |
| LoRA 微调与量化 | [微调实战：数据、LoRA/QLoRA、偏好对齐与评估](#/ai/finetune)、[大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals) |
| 概率与统计想继续深入 | 本分类的 [积分与期望](#/math/integral) 是起点，再补贝叶斯、最大似然、KL 与 ELBO |

**每学一个新模型，做三件事**：①写出前向每一步的 shape；②说出损失是什么、对谁求梯度；③用小数字手算一步，再和代码输出对一对。这三件事练熟，论文里的公式就不再陌生。

## 相关阅读

- 起点：[AI 数学学习地图：符号、函数与怎么学](#/math/start)
- 微积分线：[函数、极限与连续](#/math/limit)、[导数](#/math/derivative)、[偏导数与梯度](#/math/gradient)、[链式法则与反向传播](#/math/chain-backprop)、[极值与优化](#/math/optimization)、[泰勒展开与二阶信息](#/math/taylor)、[积分与期望](#/math/integral)
- 线性代数线：[向量](#/math/vectors)、[矩阵](#/math/matrices)、[线性方程组、逆矩阵与秩](#/math/linear-systems)、[正交与投影](#/math/projection)、[特征值与特征向量](#/math/eigen)、[SVD 与低秩](#/math/svd)、[张量、广播与 einsum](#/math/tensors)
- 站内应用：[MLP](#/aimodel/mlp)、[训练神经网络](#/aimodel/training)、[Transformer](#/aimodel/transformer)、[LLM](#/aimodel/llm)、[概率与信息论入门](#/aimodel/math-prob)
