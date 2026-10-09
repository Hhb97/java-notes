---
level: 基础
tags: [神经网络, MLP, 神经元, 激活函数, 前向传播, 反向传播, 全连接, XOR]
summary: 从一个神经元开始，讲清多层感知机（MLP）：加权求和与激活函数、为什么需要非线性（XOR 例子）、前向传播的完整手算、反向传播如何用链式法则求出每个参数的梯度并更新，以及参数量怎么数。
---

# MLP：神经元、多层感知机与反向传播

> [!ABSTRACT] 一句话版本
> - **神经元** = 输入做**加权求和**（点积 + 偏置），再过一个**激活函数**。
> - **MLP（多层感知机）** = 很多神经元排成**一层一层**，每层和下一层**全连接**。它是最基础的神经网络，也是大模型里 FFN 模块的原型。
> - **激活函数（非线性）是灵魂**：没有它，网络叠多少层都等于一层线性函数，学不会曲线、更学不会 XOR。
> - **前向传播**：从输入一层层算到输出；**反向传播**：用链式法则从输出把“错误”一层层传回，算出每个参数的梯度，再**梯度下降**更新。
> - 本页会用一个小网络把前向和反向**完整手算一遍**，让你彻底看懂“神经网络是怎么学习的”。

> [!NOTE] 先决条件
> 建议先读 [线性代数 1：向量与矩阵](#/aimodel/math-la1)、[微积分 1：导数、偏导与链式法则](#/aimodel/math-calc1)、[微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)。

## 一、一个神经元

灵感来自大脑的神经细胞：**接收多个信号，加权汇总，超过一定程度就“兴奋”输出**。

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="一个神经元：多个输入分别乘以权重后求和并加上偏置，再经过激活函数得到输出">
<circle class="b1" cx="60" cy="60" r="22"/>
<text class="tb" x="60" y="60" text-anchor="middle" dominant-baseline="middle">x₁</text>
<circle class="b1" cx="60" cy="140" r="22"/>
<text class="tb" x="60" y="140" text-anchor="middle" dominant-baseline="middle">x₂</text>
<circle class="b1" cx="60" cy="220" r="22"/>
<text class="tb" x="60" y="220" text-anchor="middle" dominant-baseline="middle">x₃</text>
<line class="l" x1="82" y1="64" x2="248" y2="132" marker-end="url(#arr)"/>
<line class="l" x1="82" y1="140" x2="248" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="82" y1="216" x2="248" y2="148" marker-end="url(#arr)"/>
<text class="ta" x="150" y="86" text-anchor="middle">w₁</text>
<text class="ta" x="150" y="132" text-anchor="middle">w₂</text>
<text class="ta" x="150" y="196" text-anchor="middle">w₃</text>
<circle class="b3" cx="280" cy="140" r="32"/>
<text class="tb" x="280" y="134" text-anchor="middle" dominant-baseline="middle">Σ + b</text>
<text class="ts" x="280" y="154" text-anchor="middle">加权求和</text>
<line class="l" x1="312" y1="140" x2="370" y2="140" marker-end="url(#arr)"/>
<text class="tm" x="340" y="130" text-anchor="middle">z</text>
<rect class="b5" x="372" y="116" width="86" height="48" rx="8"/>
<text class="tb" x="415" y="140" text-anchor="middle" dominant-baseline="middle">激活 f(z)</text>
<line class="l" x1="458" y1="140" x2="520" y2="140" marker-end="url(#arr)"/>
<circle class="b2" cx="550" cy="140" r="24"/>
<text class="tb" x="550" y="140" text-anchor="middle" dominant-baseline="middle">a</text>
<rect class="bg" x="30" y="248" width="680" height="24" rx="6"/>
<text class="tm" x="370" y="260" text-anchor="middle" dominant-baseline="middle">z = w₁x₁ + w₂x₂ + w₃x₃ + b = w·x + b        a = f(z)</text>
<text class="ts" x="640" y="110" text-anchor="middle">权重 w：学出来的“重要性”</text>
<text class="ts" x="640" y="170" text-anchor="middle">偏置 b：整体“门槛”</text>
</svg>
<figcaption>图 1：神经元 = 点积 + 偏置 + 激活函数</figcaption>
</figure>

**用生活例子理解**：决定“今晚要不要出门看电影”。

```text
x₁ = 天气好不好 (1/0)   x₂ = 有没有人陪 (1/0)   x₃ = 票价贵不贵 (1/0)
权重：天气 w₁=2（很在意）  有人陪 w₂=3（最在意）  票贵 w₃=−1（不喜欢贵）
偏置 b = −3（门槛：总得分要超过 3 才出门）
z = 2×1 + 3×1 + (−1)×1 − 3 = 1   > 0 → 出门
```

**学习 = 自动找出合适的 w 和 b**，而不是人去定。

## 二、激活函数：为什么必须有“非线性”

### 1. 没有激活函数会怎样

神经元如果只有 `z = w·x + b`，那么两层叠起来：

```text
第一层：h = W₁x + b₁
第二层：y = W₂h + b₂ = W₂(W₁x + b₁) + b₂ = (W₂W₁)x + (W₂b₁ + b₂)
                                         ↑ 还是一个线性函数！
```

**无论叠多少层，合起来都只是一个线性函数**，只能画直线/平面，学不会曲线。

### 2. 常用激活函数

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="三种激活函数的形状：sigmoid 为平滑的 S 形，tanh 为居中的 S 形，ReLU 为小于零输出零大于零输出自身的折线">
<line class="l" x1="20" y1="120" x2="230" y2="120"/>
<line class="l" x1="125" y1="30" x2="125" y2="200"/>
<path class="la nf" d="M25 112 C 70 110 90 108 105 96 C 120 84 128 70 140 54 C 152 40 170 38 225 38"/>
<line class="ld" x1="20" y1="38" x2="230" y2="38"/>
<text class="tb" x="125" y="222" text-anchor="middle">Sigmoid</text>
<text class="ts" x="125" y="236" text-anchor="middle">压到 0~1</text>
<line class="l" x1="270" y1="120" x2="480" y2="120"/>
<line class="l" x1="375" y1="30" x2="375" y2="200"/>
<path class="la nf" d="M275 190 C 320 186 345 170 360 145 C 370 128 380 112 390 95 C 405 70 430 56 475 52"/>
<text class="tb" x="375" y="222" text-anchor="middle">tanh</text>
<text class="ts" x="375" y="236" text-anchor="middle">压到 −1~1，以 0 为中心</text>
<line class="l" x1="520" y1="120" x2="730" y2="120"/>
<line class="l" x1="625" y1="30" x2="625" y2="200"/>
<polyline class="la nf" points="525,120 625,120 725,40"/>
<text class="tb" x="625" y="222" text-anchor="middle">ReLU</text>
<text class="ts" x="625" y="236" text-anchor="middle">负的变 0，正的原样</text>
</svg>
<figcaption>图 2：三种经典激活函数</figcaption>
</figure>

| 激活函数 | 公式 | 特点 | 常用位置 |
| --- | --- | --- | --- |
| **Sigmoid** | `1/(1+e⁻ᶻ)` | 输出 0~1，像概率；两端变平（容易梯度消失） | 二分类输出层 |
| **tanh** | `(eᶻ−e⁻ᶻ)/(eᶻ+e⁻ᶻ)` | 输出 −1~1，以 0 为中心 | RNN/LSTM 内部 |
| **ReLU** | `max(0, z)` | **极简单、极快**，正数区梯度为 1，缓解梯度消失 | **隐藏层默认首选** |
| Leaky ReLU | 负数时给一个很小斜率 | 避免“神经元死掉” | |
| **GELU / SwiGLU** | 平滑版 ReLU/门控 | 效果更好 | **Transformer / 大模型** |
| **Softmax** | `eᶻᵢ/Σeᶻ` | 把一组分数变概率 | **多分类输出层**，见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob) |

### 3. 经典例子：XOR（异或）——只有非线性才能解

XOR：两个输入**相同输出 0，不同输出 1**。

```text
(0,0)→0   (0,1)→1   (1,0)→1   (1,1)→0
```

在平面上，没有任何**一条直线**能把 (0,1)、(1,0) 与 (0,0)、(1,1) 分开——**线性模型永远学不会**。但加一个隐藏层 + ReLU 就行：

```text
h₁ = ReLU(x₁ + x₂)          h₂ = ReLU(x₁ + x₂ − 1)          y = h₁ − 2·h₂

(0,0): h₁=0, h₂=0 → y=0   ✓
(1,0): h₁=1, h₂=0 → y=1   ✓
(0,1): h₁=1, h₂=0 → y=1   ✓
(1,1): h₁=2, h₂=1 → y=2−2=0   ✓
```

这个著名例子是 20 世纪 60 年代神经网络第一次“寒冬”的导火索（单层感知机不会 XOR），后来多层网络 + 反向传播解决了它。

### 4. 通用近似：为什么叠起来这么强

直觉：**一个 ReLU 是“一个折角”，很多折角叠加就能拼出任意形状的曲线**（折线逼近曲线）。理论上（通用近似定理），**只要隐藏层足够宽，一个隐藏层的 MLP 就能以任意精度近似任何连续函数**。实践中，**多层且适度宽度**比“一层特别宽”更高效。

## 三、MLP：一层一层堆起来

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="一个多层感知机：输入层 3 个节点，两个隐藏层各 4 个节点，输出层 2 个节点，相邻层之间全连接">
<text class="th" x="70" y="24" text-anchor="middle">输入层</text>
<text class="th" x="250" y="24" text-anchor="middle">隐藏层 1</text>
<text class="th" x="440" y="24" text-anchor="middle">隐藏层 2</text>
<text class="th" x="630" y="24" text-anchor="middle">输出层</text>
<circle class="b1" cx="70" cy="90" r="18"/>
<circle class="b1" cx="70" cy="165" r="18"/>
<circle class="b1" cx="70" cy="240" r="18"/>
<circle class="b3" cx="250" cy="60" r="18"/>
<circle class="b3" cx="250" cy="130" r="18"/>
<circle class="b3" cx="250" cy="200" r="18"/>
<circle class="b3" cx="250" cy="270" r="18"/>
<circle class="b3" cx="440" cy="60" r="18"/>
<circle class="b3" cx="440" cy="130" r="18"/>
<circle class="b3" cx="440" cy="200" r="18"/>
<circle class="b3" cx="440" cy="270" r="18"/>
<circle class="b2" cx="630" cy="120" r="18"/>
<circle class="b2" cx="630" cy="210" r="18"/>
<line class="ld" x1="88" y1="90" x2="232" y2="60"/>
<line class="ld" x1="88" y1="90" x2="232" y2="130"/>
<line class="ld" x1="88" y1="90" x2="232" y2="200"/>
<line class="ld" x1="88" y1="90" x2="232" y2="270"/>
<line class="ld" x1="88" y1="165" x2="232" y2="60"/>
<line class="ld" x1="88" y1="165" x2="232" y2="130"/>
<line class="ld" x1="88" y1="165" x2="232" y2="200"/>
<line class="ld" x1="88" y1="165" x2="232" y2="270"/>
<line class="ld" x1="88" y1="240" x2="232" y2="60"/>
<line class="ld" x1="88" y1="240" x2="232" y2="130"/>
<line class="ld" x1="88" y1="240" x2="232" y2="200"/>
<line class="ld" x1="88" y1="240" x2="232" y2="270"/>
<line class="ld" x1="268" y1="60" x2="422" y2="60"/>
<line class="ld" x1="268" y1="60" x2="422" y2="130"/>
<line class="ld" x1="268" y1="60" x2="422" y2="200"/>
<line class="ld" x1="268" y1="60" x2="422" y2="270"/>
<line class="ld" x1="268" y1="130" x2="422" y2="60"/>
<line class="ld" x1="268" y1="130" x2="422" y2="130"/>
<line class="ld" x1="268" y1="130" x2="422" y2="200"/>
<line class="ld" x1="268" y1="130" x2="422" y2="270"/>
<line class="ld" x1="268" y1="200" x2="422" y2="60"/>
<line class="ld" x1="268" y1="200" x2="422" y2="130"/>
<line class="ld" x1="268" y1="200" x2="422" y2="200"/>
<line class="ld" x1="268" y1="200" x2="422" y2="270"/>
<line class="ld" x1="268" y1="270" x2="422" y2="60"/>
<line class="ld" x1="268" y1="270" x2="422" y2="130"/>
<line class="ld" x1="268" y1="270" x2="422" y2="200"/>
<line class="ld" x1="268" y1="270" x2="422" y2="270"/>
<line class="ld" x1="458" y1="60" x2="612" y2="120"/>
<line class="ld" x1="458" y1="60" x2="612" y2="210"/>
<line class="ld" x1="458" y1="130" x2="612" y2="120"/>
<line class="ld" x1="458" y1="130" x2="612" y2="210"/>
<line class="ld" x1="458" y1="200" x2="612" y2="120"/>
<line class="ld" x1="458" y1="200" x2="612" y2="210"/>
<line class="ld" x1="458" y1="270" x2="612" y2="120"/>
<line class="ld" x1="458" y1="270" x2="612" y2="210"/>
<text class="ts" x="70" y="296" text-anchor="middle">3 个输入特征</text>
<text class="ts" x="345" y="312" text-anchor="middle">每个节点 = 一个神经元；相邻层“全连接”（所以也叫全连接网络 / 稠密网络）</text>
<text class="ts" x="630" y="256" text-anchor="middle">2 个输出（如 2 类）</text>
</svg>
<figcaption>图 3：一个 3-4-4-2 的 MLP：层与层之间每对神经元都有连接</figcaption>
</figure>

用矩阵写出来，**每一层就是一次矩阵乘法 + 激活**：

```text
h₁ = f(W₁ · x  + b₁)        W₁ 形状 (4×3)
h₂ = f(W₂ · h₁ + b₂)        W₂ 形状 (4×4)
y  =   W₃ · h₂ + b₃          W₃ 形状 (2×4)   （输出层通常再接 softmax 或 sigmoid）
```

### 参数量怎么数

一层的参数 = **权重数（输入数 × 输出数） + 偏置数（输出数）**。

```text
上图：  (3×4+4) + (4×4+4) + (4×2+2) = 16 + 20 + 10 = 46 个参数

识别手写数字的经典网络：784 → 128 → 10
  (784×128 + 128) + (128×10 + 10) = 100,480 + 1,290 = 101,770 个参数
```

大模型的“**几百亿、几千亿参数**”，就是这样的权重矩阵堆出来的。

## 四、前向传播：完整手算一遍

我们用一个**很小的网络**：2 个输入 → 2 个隐藏神经元（ReLU）→ 1 个输出。

**参数**（假装是随机初始化的）：

```text
W₁ = | 1   −1  |     b₁ = (0, 1)          第一层
     | 2   0.5 |
W₂ = (0.5, 0.25)      b₂ = 0.1             第二层
```

**训练样本**：输入 `x = (1, 2)`，正确答案 `t = 1`。

### 前向计算

```text
第一层（线性）：
  z₁ = 1×1 + (−1)×2 + 0     = −1
  z₂ = 2×1 + 0.5×2  + 1     =  4
第一层（ReLU）：
  h₁ = max(0, −1) = 0
  h₂ = max(0,  4) = 4
输出层：
  y = 0.5×0 + 0.25×4 + 0.1 = 1.1
损失（平方误差）：
  L = (y − t)² = (1.1 − 1)² = 0.01
```

<figure class="fig">
<svg viewBox="0 0 780 300" class="dg" role="img" aria-label="手算例子的前向传播与反向传播：前向依次计算 z、h、y、L；反向依次求出 dL/dy、dL/dh、dL/dz 以及各权重的梯度">
<rect class="b1" x="20" y="100" width="100" height="70" rx="8"/>
<text class="tb" x="70" y="122" text-anchor="middle" dominant-baseline="middle">输入 x</text>
<text class="tm" x="70" y="148" text-anchor="middle" dominant-baseline="middle">(1, 2)</text>
<rect class="b3" x="170" y="100" width="130" height="70" rx="8"/>
<text class="tb" x="235" y="122" text-anchor="middle" dominant-baseline="middle">z = W₁x + b₁</text>
<text class="tm" x="235" y="148" text-anchor="middle" dominant-baseline="middle">(−1, 4)</text>
<rect class="b3" x="350" y="100" width="130" height="70" rx="8"/>
<text class="tb" x="415" y="122" text-anchor="middle" dominant-baseline="middle">h = ReLU(z)</text>
<text class="tm" x="415" y="148" text-anchor="middle" dominant-baseline="middle">(0, 4)</text>
<rect class="b5" x="530" y="100" width="100" height="70" rx="8"/>
<text class="tb" x="580" y="122" text-anchor="middle" dominant-baseline="middle">y = W₂h+b₂</text>
<text class="tm" x="580" y="148" text-anchor="middle" dominant-baseline="middle">1.1</text>
<rect class="b4" x="670" y="100" width="90" height="70" rx="8"/>
<text class="tb" x="715" y="122" text-anchor="middle" dominant-baseline="middle">L=(y−t)²</text>
<text class="tm" x="715" y="148" text-anchor="middle" dominant-baseline="middle">0.01</text>
<line class="l" x1="120" y1="135" x2="170" y2="135" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="135" x2="350" y2="135" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="135" x2="530" y2="135" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="135" x2="670" y2="135" marker-end="url(#arr)"/>
<text class="ts" x="390" y="70" text-anchor="middle">前向传播 →（从输入算到损失）</text>
<line class="la" x1="715" y1="180" x2="715" y2="200"/>
<line class="la" x1="715" y1="200" x2="70" y2="200" marker-end="url(#arr-a)"/>
<text class="ta" x="390" y="224" text-anchor="middle">← 反向传播（从损失把“责任”一层层传回去）</text>
<text class="tm" x="720" y="250" text-anchor="end">dL/dy = 2(y−t) = 0.2</text>
<text class="tm" x="720" y="272" text-anchor="end">dW₂ = 0.2·h = (0, 0.8)   dh = 0.2·W₂ = (0.1, 0.05)</text>
<text class="tm" x="720" y="294" text-anchor="end">dz = dh ⊙ ReLU′(z) = (0, 0.05)   dW₁ 只有第 2 行非零</text>
</svg>
<figcaption>图 4：前向算出损失，反向用链式法则得到各参数的梯度</figcaption>
</figure>

## 五、反向传播：把“错误”传回去

预测 1.1，目标 1，**偏大 0.1**。我们要知道：**每个参数该怎么调才能让 L 变小？** 用链式法则从后往前算（符号 ⊙ 表示对应位置相乘）。

### 第 1 步：损失对输出

```text
dL/dy = 2(y − t) = 2 × 0.1 = 0.2          （y 偏大，增大 y 会让 L 变大）
```

### 第 2 步：输出层的参数

```text
y = W₂·h + b₂
dL/dW₂ = dL/dy × h = 0.2 × (0, 4) = (0, 0.8)
dL/db₂ = dL/dy × 1 = 0.2
```

### 第 3 步：传到隐藏层输出 h

```text
dL/dh = dL/dy × W₂ = 0.2 × (0.5, 0.25) = (0.1, 0.05)
```

### 第 4 步：穿过 ReLU

ReLU 的导数：z>0 时为 1，z≤0 时为 0。这里 z=(−1, 4)，导数 = (0, 1)：

```text
dL/dz = dL/dh ⊙ ReLU′(z) = (0.1, 0.05) ⊙ (0, 1) = (0, 0.05)
```

> [!NOTE] ReLU “挡住”了第一个神经元
> 第一个神经元的 z=−1 被 ReLU 压成 0，**它这次对输出毫无贡献，所以也收不到梯度**（梯度为 0）。这就是“死 ReLU”现象的来源。

### 第 5 步：第一层的参数

```text
dL/dW₁ = dL/dz × xᵀ = | 0×1     0×2    |  =  | 0     0   |
                       | 0.05×1  0.05×2 |     | 0.05  0.1 |
dL/db₁ = dL/dz = (0, 0.05)
```

### 第 6 步：梯度下降更新（学习率 η = 0.02）

```text
W₂ ← (0.5, 0.25) − 0.02×(0, 0.8) = (0.5, 0.234)
b₂ ← 0.1 − 0.02×0.2 = 0.096
W₁ 第 2 行 ← (2, 0.5) − 0.02×(0.05, 0.1) = (1.999, 0.498)
b₁ 第 2 项 ← 1 − 0.02×0.05 = 0.999
```

### 验证：再算一次前向

```text
z₂ = 1.999×1 + 0.498×2 + 0.999 = 3.994       h₂ = 3.994
y  = 0.234×3.994 + 0.096 ≈ 1.031
损失 L = (1.031 − 1)² ≈ 0.00094              （比之前的 0.01 小了很多！）
```

**预测从 1.1 变成了 1.031，更接近目标 1 了**——一次“前向 → 反向 → 更新”就让网络“学”到了一点。重复几万次、用很多不同样本，网络就能学会复杂的规律。

> [!TIP] 反向传播的精髓
> 它不是什么神秘的东西，就是**链式法则 + 动态规划**：把前向时算好的中间值保存下来，然后**从后往前一次扫描**，高效地得到**所有参数的梯度**（代价和一次前向差不多）。现代框架（PyTorch、TensorFlow）会**自动**完成这件事（自动微分），你只需要写前向。

## 六、用代码表达

### 从零手写（NumPy）

```python
import numpy as np

W1 = np.array([[1., -1.], [2., 0.5]]); b1 = np.array([0., 1.])
W2 = np.array([0.5, 0.25]);            b2 = 0.1
x = np.array([1., 2.]); t = 1.0; lr = 0.02

for step in range(3):
    # 前向
    z = W1 @ x + b1
    h = np.maximum(0, z)
    y = W2 @ h + b2
    loss = (y - t) ** 2
    # 反向
    dy  = 2 * (y - t)
    dW2 = dy * h;          db2 = dy
    dh  = dy * W2
    dz  = dh * (z > 0)                 # ReLU 的导数
    dW1 = np.outer(dz, x); db1 = dz
    # 更新
    W2 -= lr * dW2; b2 -= lr * db2
    W1 -= lr * dW1; b1 -= lr * db1
    print(step, round(float(y), 4), round(float(loss), 5))
```

### 用 PyTorch（现实中的写法）

```python
import torch, torch.nn as nn

model = nn.Sequential(
    nn.Linear(784, 128), nn.ReLU(),        # 隐藏层
    nn.Linear(128, 10)                      # 输出层（10 类），损失函数里自带 softmax
)
loss_fn = nn.CrossEntropyLoss()
opt = torch.optim.Adam(model.parameters(), lr=1e-3)

for X, y in loader:                         # 每次取一个 mini-batch
    loss = loss_fn(model(X), y)             # 前向 + 损失
    opt.zero_grad()
    loss.backward()                         # 反向传播（自动求所有梯度）
    opt.step()                              # 更新参数
```

注意 **`loss.backward()` 一行就完成了上面手算的全部第 1~5 步**。

## 七、MLP 的局限与家族关系

| 问题 | 说明 | 引出的模型 |
| --- | --- | --- |
| 看图参数太多、不懂“空间” | 把图片展平成一长串，丢失了“相邻像素有关系”的信息 | **CNN**，见 [CNN：卷积神经网络如何“看图”](#/aimodel/cnn) |
| 不能处理“顺序/长度不定” | 输入长度固定，不理解前后文 | **RNN / Transformer**，见 [RNN 与 LSTM：会“记事”的网络](#/aimodel/rnn)、[注意力与 Transformer：大模型的骨架](#/aimodel/transformer) |
| 层深了难训练 | 梯度消失/爆炸 | 残差、归一化、更好的初始化，见 [训练神经网络：优化器、正则化与常见坑](#/aimodel/training) |

**但 MLP 并没有过时**：Transformer 里的 **FFN（前馈网络）本质就是两层 MLP**，占据了大模型大部分参数。理解 MLP，就理解了现代模型的“砖块”。

## 自测：你真的懂了吗？

> [!QUESTION] 为什么神经网络必须有激活函数？
> 没有非线性激活函数，多层线性变换合起来仍是一个线性函数，网络只能表示直线或平面，学不会曲线边界（例如 XOR）。激活函数引入非线性，才使多层叠加能表示复杂函数。

> [!QUESTION] 一个 784→128→10 的 MLP 有多少参数？
> (784×128 + 128) + (128×10 + 10) = 100,480 + 1,290 = 101,770。

> [!QUESTION] 用你自己的话说说前向传播和反向传播。
> 前向传播是把输入一层层按“矩阵乘法加激活”算到输出并得到损失；反向传播是从损失出发，用链式法则一层层反向计算损失对每个参数的偏导数（梯度），再由优化器按梯度更新参数。

> [!QUESTION] ReLU 在 z<0 时梯度为 0，会带来什么后果？
> 该神经元这一次对输出没有贡献，也收不到梯度、参数不更新；如果长期输入都使它 z<0，它就“死”了。所以有 Leaky ReLU、GELU 等改进，也要注意初始化和学习率。

> [!QUESTION] 在手算例子里，为什么只有第 2 个隐藏神经元的权重被更新？
> 第 1 个神经元的 z=−1 被 ReLU 截断成 0，ReLU 导数为 0，反向传播时梯度被挡住，所以它的权重梯度为 0；只有 z=4>0 的第 2 个神经元有梯度。
