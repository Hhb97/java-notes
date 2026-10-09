---
level: 基础
tags: [RNN, LSTM, GRU, 序列模型, 隐藏状态, 梯度消失, seq2seq, 时间序列]
summary: 用“边读边记笔记”的比喻讲清循环神经网络：为什么需要处理序列、隐藏状态如何传递记忆、展开后的计算（带手算）、长距离依赖与梯度消失，LSTM/GRU 的门控机制，以及 RNN 的局限与被 Transformer 取代的原因。
---

# RNN 与 LSTM：会“记事”的网络

> [!ABSTRACT] 一句话版本
> - 有些数据**有先后顺序**：一句话、一段语音、股票价格、传感器读数。理解它们要**联系上下文**。
> - **RNN（循环神经网络）**：一边读，一边把“到目前为止的记忆”（**隐藏状态**）带到下一步。**同一组参数在每个时间步重复使用**。
> - 问题：记忆会随步数增加而**逐渐淡忘**（梯度消失）——读到句尾，早就忘了句首。
> - **LSTM / GRU** 用“**门**”来决定**记住什么、忘记什么、输出什么**，能记住更长的信息。
> - 但 RNN 家族有两个硬伤：**必须一个词一个词串行处理（慢）**、**很长的依赖仍然吃力**——这催生了 **Transformer**，它如今是大模型的主流。

> [!NOTE] 为什么还要学 RNN
> 现在大模型主要用 Transformer，但 RNN/LSTM 帮你理解“**序列建模的核心难题**”（记忆、长依赖、梯度消失），而且在**小型/流式/时间序列/嵌入式**场景仍有应用；近年的 **Mamba、RWKV** 等新架构也在重新借鉴“循环”的思想。

## 一、为什么需要序列模型

| 任务 | 输入 | 输出 |
| --- | --- | --- |
| 情感分析 | 一句评论 | 正面/负面 |
| 机器翻译 | 一句中文 | 一句英文 |
| 语音识别 | 一段声音 | 文字 |
| 文本生成 | 前面的字 | 下一个字 |
| 时间序列预测 | 过去 30 天销量 | 明天销量 |

**MLP/CNN 的局限**：

- 输入长度必须固定，而句子有长有短；
- 不理解“顺序”：`我爱你` 和 `你爱我` 用同样的词，意思相反。

需要一个模型：**能处理任意长度的序列，并且记得前面看过什么。**

## 二、RNN：带“记忆”的神经元

### 1. 核心想法

读一句话时，你不是每个词都重新理解，而是**脑子里带着前面的内容**。RNN 也一样：

```text
在每一个时间步 t：
  新记忆 h_t = 激活( W_h · 旧记忆 h_{t−1}  +  W_x · 当前输入 x_t  +  b )
```

- **h**（隐藏状态）= 记忆；
- 每一步把**旧记忆**和**新输入**混合，得到**新记忆**；
- **同一组权重 W_h、W_x、b 在所有时间步重复使用**（所以能处理任意长度，参数也不会随长度增加）。

### 2. 展开图

把循环“摊开”成一条链，就是一个很深的前馈网络（每个时间步一层，但权重共享）：

<figure class="fig">
<svg viewBox="0 0 780 280" class="dg" role="img" aria-label="RNN 沿时间展开：每个时间步接收输入并结合上一步的隐藏状态产生新的隐藏状态和输出，所有时间步共享同一组权重">
<text class="th" x="20" y="24">折叠：一个带环的单元</text>
<rect class="b3" x="30" y="60" width="90" height="60" rx="10"/>
<text class="tb" x="75" y="90" text-anchor="middle" dominant-baseline="middle">RNN</text>
<path class="la nf" d="M120 80 C 160 60 160 120 120 100" marker-end="url(#arr-a)"/>
<text class="ts" x="170" y="96" text-anchor="start">自己连自己</text>
<text class="th" x="20" y="164">展开：按时间排开（共享同一组权重）</text>
<rect class="b1" x="30" y="200" width="60" height="36" rx="6"/>
<text class="tm" x="60" y="218" text-anchor="middle" dominant-baseline="middle">x₁ 我</text>
<rect class="b1" x="190" y="200" width="60" height="36" rx="6"/>
<text class="tm" x="220" y="218" text-anchor="middle" dominant-baseline="middle">x₂ 爱</text>
<rect class="b1" x="350" y="200" width="60" height="36" rx="6"/>
<text class="tm" x="380" y="218" text-anchor="middle" dominant-baseline="middle">x₃ 学</text>
<rect class="b1" x="510" y="200" width="60" height="36" rx="6"/>
<text class="tm" x="540" y="218" text-anchor="middle" dominant-baseline="middle">x₄ 习</text>
<rect class="b3" x="30" y="150" width="60" height="36" rx="6"/>
<text class="tm" x="60" y="168" text-anchor="middle" dominant-baseline="middle">h₁</text>
<rect class="b3" x="190" y="150" width="60" height="36" rx="6"/>
<text class="tm" x="220" y="168" text-anchor="middle" dominant-baseline="middle">h₂</text>
<rect class="b3" x="350" y="150" width="60" height="36" rx="6"/>
<text class="tm" x="380" y="168" text-anchor="middle" dominant-baseline="middle">h₃</text>
<rect class="b3" x="510" y="150" width="60" height="36" rx="6"/>
<text class="tm" x="540" y="168" text-anchor="middle" dominant-baseline="middle">h₄</text>
<line class="l" x1="60" y1="200" x2="60" y2="186" marker-end="url(#arr)"/>
<line class="l" x1="220" y1="200" x2="220" y2="186" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="200" x2="380" y2="186" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="200" x2="540" y2="186" marker-end="url(#arr)"/>
<line class="la" x1="90" y1="168" x2="190" y2="168" marker-end="url(#arr-a)"/>
<line class="la" x1="250" y1="168" x2="350" y2="168" marker-end="url(#arr-a)"/>
<line class="la" x1="410" y1="168" x2="510" y2="168" marker-end="url(#arr-a)"/>
<text class="ta" x="140" y="158" text-anchor="middle">记忆</text>
<text class="ta" x="300" y="158" text-anchor="middle">记忆</text>
<text class="ta" x="460" y="158" text-anchor="middle">记忆</text>
<rect class="b2" x="520" y="96" width="50" height="34" rx="6"/>
<text class="tm" x="545" y="113" text-anchor="middle" dominant-baseline="middle">输出</text>
<line class="l" x1="540" y1="150" x2="545" y2="130" marker-end="url(#arr)"/>
<rect class="bg" x="600" y="140" width="170" height="110" rx="10"/>
<text class="ts" x="612" y="164">每一步的 h 都包含了</text>
<text class="ts" x="612" y="184">“从头到现在”的信息；</text>
<text class="ts" x="612" y="212">最后一步的 h₄ 可以当作</text>
<text class="ts" x="612" y="232">整句话的“摘要”</text>
</svg>
<figcaption>图 1：RNN 沿时间展开：记忆（隐藏状态）一步步传递</figcaption>
</figure>

### 3. 一个最小的手算例子

用最简单的**标量 RNN**（只有一个数的记忆）：`h_t = tanh(0.5 · h_{t−1} + 1.0 · x_t)`，初始 `h₀=0`。输入序列：**`x = [1, 0, 0]`**（只有第一步有“重要信息”，后面都是 0）。

```text
t=1：h₁ = tanh(0.5×0     + 1×1) = tanh(1)     = 0.762      ← 记住了第一步的信息
t=2：h₂ = tanh(0.5×0.762 + 1×0) = tanh(0.381) = 0.364      ← 衰减了一半
t=3：h₃ = tanh(0.5×0.364 + 1×0) = tanh(0.182) = 0.180      ← 继续衰减
```

**第一步的信息在记忆里一路“缩水”：0.762 → 0.364 → 0.180**——每过一步就乘上约 0.5。过了二三十步，这点信息就几乎消失了。**这就是 RNN 难以记住长距离信息的原因。**

## 三、长依赖与梯度消失

### 1. 例子

> “我在**法国**长大……（此处省略 50 个词）……所以我会说流利的**___**。”

要填“法语”，需要**记住 50 个词之前出现的“法国”**。

### 2. 数学原因

反向传播要**沿着时间回传**，每往回一步就**乘一次 W_h 和 tanh 的导数**（见 [微积分 1：导数、偏导与链式法则](#/aimodel/math-calc1)）：

```text
回传 50 步 ≈ (W_h × 导数)⁵⁰
如果 |W_h × 导数| < 1，比如 0.5：0.5⁵⁰ ≈ 9×10⁻¹⁶  → 梯度几乎为 0（消失），早期输入学不到
如果 > 1，比如 1.5：  1.5⁵⁰ ≈ 6×10⁸       → 梯度爆炸，训练发散
```

回忆 [线性代数 2：特征值、SVD 与 PCA](#/aimodel/math-la2)：**反复乘同一个矩阵，由它的特征值决定放大还是缩小**。

| 问题 | 对策 |
| --- | --- |
| 梯度爆炸 | **梯度裁剪**（限制梯度大小） |
| 梯度消失 | **换更好的结构：LSTM / GRU**（下节） |

## 四、LSTM：给记忆装上“门”

**LSTM（长短期记忆网络）**引入一条专门的“**记忆传送带**”——**细胞状态 cₜ**，信息在上面可以几乎**原样地一直传下去**，同时用三个“**门**”控制信息的进出。**门**就是一个输出 0~1 的 sigmoid：0 = 全部关闭，1 = 全部打开，像一个“音量旋钮”。

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="LSTM 单元：细胞状态沿顶部传送带传递；遗忘门决定丢弃多少旧记忆，输入门决定写入多少新信息，输出门决定输出多少记忆到隐藏状态">
<rect class="bg" x="40" y="30" width="700" height="290" rx="14"/>
<text class="th" x="56" y="52">LSTM 单元（一个时间步）</text>
<line class="la" x1="20" y1="90" x2="760" y2="90" marker-end="url(#arr-a)"/>
<text class="ta" x="60" y="80" text-anchor="start">细胞状态 c（记忆传送带）</text>
<circle class="b3" cx="200" cy="90" r="16"/>
<text class="tb" x="200" y="90" text-anchor="middle" dominant-baseline="middle">×</text>
<circle class="b3" cx="400" cy="90" r="16"/>
<text class="tb" x="400" y="90" text-anchor="middle" dominant-baseline="middle">＋</text>
<rect class="b4" x="170" y="190" width="60" height="40" rx="6"/>
<text class="tb" x="200" y="210" text-anchor="middle" dominant-baseline="middle">σ</text>
<text class="ts" x="200" y="252" text-anchor="middle">遗忘门 f</text>
<text class="ts" x="200" y="270" text-anchor="middle">丢掉多少旧记忆</text>
<line class="l" x1="200" y1="190" x2="200" y2="106" marker-end="url(#arr)"/>
<rect class="b2" x="290" y="190" width="60" height="40" rx="6"/>
<text class="tb" x="320" y="210" text-anchor="middle" dominant-baseline="middle">σ</text>
<text class="ts" x="320" y="252" text-anchor="middle">输入门 i</text>
<text class="ts" x="320" y="270" text-anchor="middle">写入多少新信息</text>
<rect class="b1" x="370" y="190" width="60" height="40" rx="6"/>
<text class="tb" x="400" y="210" text-anchor="middle" dominant-baseline="middle">tanh</text>
<text class="ts" x="400" y="252" text-anchor="middle">候选新信息 c̃</text>
<circle class="b3" cx="400" cy="150" r="14"/>
<text class="tb" x="400" y="150" text-anchor="middle" dominant-baseline="middle">×</text>
<line class="l" x1="320" y1="190" x2="388" y2="156" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="190" x2="400" y2="164" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="136" x2="400" y2="106" marker-end="url(#arr)"/>
<rect class="b5" x="530" y="190" width="60" height="40" rx="6"/>
<text class="tb" x="560" y="210" text-anchor="middle" dominant-baseline="middle">σ</text>
<text class="ts" x="560" y="252" text-anchor="middle">输出门 o</text>
<text class="ts" x="560" y="270" text-anchor="middle">输出多少记忆</text>
<rect class="b1" x="490" y="120" width="60" height="30" rx="6"/>
<text class="tb" x="520" y="135" text-anchor="middle" dominant-baseline="middle">tanh</text>
<circle class="b3" cx="560" cy="135" r="14"/>
<text class="tb" x="560" y="135" text-anchor="middle" dominant-baseline="middle">×</text>
<line class="l" x1="520" y1="90" x2="520" y2="120"/>
<line class="l" x1="550" y1="135" x2="546" y2="135"/>
<line class="l" x1="560" y1="190" x2="560" y2="149" marker-end="url(#arr)"/>
<line class="l" x1="574" y1="135" x2="650" y2="135" marker-end="url(#arr)"/>
<text class="tb" x="690" y="139" text-anchor="middle">h（新输出）</text>
<text class="ts" x="400" y="306" text-anchor="middle">三个门的输入都是“上一步输出 h_{t−1} 与当前输入 x_t”；门的开合是学出来的</text>
</svg>
<figcaption>图 2：LSTM：细胞状态是传送带，三个门控制“忘、记、出”</figcaption>
</figure>

四步理解：

| 步骤 | 门 | 作用 | 类比 |
| --- | --- | --- | --- |
| ① | **遗忘门 f** | 对旧记忆 c 的每一维，决定**保留多少**（0=全忘，1=全留） | 擦掉黑板上过时的内容 |
| ② | **输入门 i** + 候选 c̃ | 决定**写入多少**新信息 | 把新的要点记上去 |
| ③ | 更新 | `c_t = f ⊙ c_{t−1} + i ⊙ c̃` | 黑板 = 保留的旧 + 新写的 |
| ④ | **输出门 o** | 决定从记忆里**输出什么**给 h | 这一刻要说出口的内容 |

```text
遗忘门：f = σ(W_f·[h_{t−1}, x_t] + b_f)
输入门：i = σ(W_i·[h_{t−1}, x_t] + b_i)       候选：c̃ = tanh(W_c·[h_{t−1}, x_t] + b_c)
细胞状态：c_t = f ⊙ c_{t−1} + i ⊙ c̃
输出门：o = σ(W_o·[h_{t−1}, x_t] + b_o)       隐藏状态：h_t = o ⊙ tanh(c_t)
```

**为什么能缓解梯度消失**：细胞状态更新是 `c_t = f·c_{t−1} + …`，是**加法为主**的结构。当遗忘门 f≈1 时，梯度沿着 c 几乎**原样回传**，像残差连接（见 [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)）一样畅通，所以能记住几十到几百步以前的信息。

### GRU：精简版 LSTM

**GRU** 把门合并为两个（**更新门、重置门**），去掉了单独的细胞状态，参数更少、训练更快，效果常与 LSTM 相当。

| | RNN | LSTM | GRU |
| --- | --- | --- | --- |
| 门的数量 | 0 | 3 | 2 |
| 记忆能力 | 弱（几步~十几步） | 强 | 较强 |
| 参数量 | 少 | 多 | 中 |
| 速度 | 快 | 慢 | 较快 |

## 五、RNN 的各种“形状”

<figure class="fig">
<svg viewBox="0 0 780 260" class="dg" role="img" aria-label="序列任务的四种输入输出形态：一对一、多对一、一对多、多对多（同步与异步）">
<text class="tb" x="70" y="24" text-anchor="middle">多对一</text>
<rect class="b1" x="20" y="150" width="30" height="24" rx="4"/>
<rect class="b1" x="60" y="150" width="30" height="24" rx="4"/>
<rect class="b1" x="100" y="150" width="30" height="24" rx="4"/>
<rect class="b3" x="20" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="60" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="100" y="100" width="30" height="24" rx="4"/>
<rect class="b2" x="100" y="50" width="30" height="24" rx="4"/>
<line class="l" x1="50" y1="112" x2="60" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="90" y1="112" x2="100" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="115" y1="100" x2="115" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="70" y="206" text-anchor="middle">情感分析</text>
<text class="ts" x="70" y="224" text-anchor="middle">一句话 → 一个标签</text>
<text class="tb" x="250" y="24" text-anchor="middle">一对多</text>
<rect class="b1" x="200" y="150" width="30" height="24" rx="4"/>
<rect class="b3" x="200" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="240" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="280" y="100" width="30" height="24" rx="4"/>
<rect class="b2" x="200" y="50" width="30" height="24" rx="4"/>
<rect class="b2" x="240" y="50" width="30" height="24" rx="4"/>
<rect class="b2" x="280" y="50" width="30" height="24" rx="4"/>
<line class="l" x1="230" y1="112" x2="240" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="112" x2="280" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="215" y1="150" x2="215" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="215" y1="100" x2="215" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="100" x2="255" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="295" y1="100" x2="295" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="250" y="206" text-anchor="middle">看图写话</text>
<text class="ts" x="250" y="224" text-anchor="middle">一张图 → 一句话</text>
<text class="tb" x="470" y="24" text-anchor="middle">多对多（同步）</text>
<rect class="b1" x="420" y="150" width="30" height="24" rx="4"/>
<rect class="b1" x="460" y="150" width="30" height="24" rx="4"/>
<rect class="b1" x="500" y="150" width="30" height="24" rx="4"/>
<rect class="b3" x="420" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="460" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="500" y="100" width="30" height="24" rx="4"/>
<rect class="b2" x="420" y="50" width="30" height="24" rx="4"/>
<rect class="b2" x="460" y="50" width="30" height="24" rx="4"/>
<rect class="b2" x="500" y="50" width="30" height="24" rx="4"/>
<line class="l" x1="450" y1="112" x2="460" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="112" x2="500" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="435" y1="150" x2="435" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="475" y1="150" x2="475" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="150" x2="515" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="435" y1="100" x2="435" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="475" y1="100" x2="475" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="100" x2="515" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="470" y="206" text-anchor="middle">词性标注、每帧识别</text>
<text class="ts" x="470" y="224" text-anchor="middle">每个输入都有输出</text>
<text class="tb" x="680" y="24" text-anchor="middle">多对多（编码-解码）</text>
<rect class="b1" x="620" y="150" width="30" height="24" rx="4"/>
<rect class="b1" x="660" y="150" width="30" height="24" rx="4"/>
<rect class="b3" x="620" y="100" width="30" height="24" rx="4"/>
<rect class="b3" x="660" y="100" width="30" height="24" rx="4"/>
<rect class="b5" x="700" y="100" width="30" height="24" rx="4"/>
<rect class="b5" x="740" y="100" width="30" height="24" rx="4"/>
<rect class="b2" x="700" y="50" width="30" height="24" rx="4"/>
<rect class="b2" x="740" y="50" width="30" height="24" rx="4"/>
<line class="l" x1="650" y1="112" x2="660" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="690" y1="112" x2="700" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="730" y1="112" x2="740" y2="112" marker-end="url(#arr)"/>
<line class="l" x1="635" y1="150" x2="635" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="675" y1="150" x2="675" y2="124" marker-end="url(#arr)"/>
<line class="l" x1="715" y1="100" x2="715" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="755" y1="100" x2="755" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="690" y="206" text-anchor="middle">机器翻译（seq2seq）</text>
<text class="ts" x="690" y="224" text-anchor="middle">先读完整句，再逐词输出</text>
</svg>
<figcaption>图 3：序列模型的几种输入输出形态</figcaption>
</figure>

**seq2seq（编码器-解码器）** 是翻译的经典架构：**编码器 RNN** 读完整句话，把整句压缩成一个**固定长度向量**；**解码器 RNN** 从这个向量出发，逐词生成译文。**瓶颈**：无论句子多长，都要塞进同一个向量，信息丢失严重。于是 2014 年提出了**注意力机制**（让解码器在每一步“回头看”编码器的全部状态），而 2017 年的 **Transformer 完全抛弃了循环，只保留注意力**，见 [注意力与 Transformer：大模型的骨架](#/aimodel/transformer)。

## 六、RNN 家族的局限

| 局限 | 说明 |
| --- | --- |
| **必须串行** | 第 t 步要等第 t−1 步算完，**无法并行**，GPU 利用率低，训练慢 |
| 超长依赖仍难 | LSTM 缓解但没根治，几百~上千步的依赖依然吃力 |
| 信息瓶颈 | 隐藏状态大小固定，要压缩所有历史 |
| 训练不稳定 | 梯度爆炸/消失仍需小心 |

> [!TIP] 今天什么时候还用 RNN/LSTM
> - **小模型、资源受限**（设备端的关键词唤醒、简单传感器时间序列）；
> - **流式处理**，每来一个数据就更新一次状态，内存恒定；
> - 作为**经典教学**模型理解序列建模；
> - 新架构（**Mamba / 状态空间模型 SSM、RWKV**）在兼顾“线性复杂度 + 可并行训练”上重新回到“循环”思路。

## 七、动手

```python
import numpy as np

# 标量 RNN：验证上面的手算
wh, wx = 0.5, 1.0
h = 0.0
for x in [1, 0, 0]:
    h = np.tanh(wh * h + wx * x)
    print(round(h, 3))            # 0.762  0.364  0.18  ——记忆在衰减

# PyTorch 的 LSTM
import torch, torch.nn as nn
lstm = nn.LSTM(input_size=8, hidden_size=16, num_layers=1, batch_first=True)
x = torch.randn(4, 20, 8)                 # (批 4, 序列长 20, 每步特征 8)
out, (h_n, c_n) = lstm(x)
print(out.shape)                          # (4, 20, 16)  每个时间步的输出
print(h_n.shape, c_n.shape)               # (1, 4, 16)   最后一步的隐藏状态与细胞状态
```

## 自测：你真的懂了吗？

> [!QUESTION] RNN 的“循环”指什么？为什么它能处理不同长度的序列？
> 每个时间步用同一组权重，把上一步的隐藏状态和当前输入结合得到新的隐藏状态，这个“自己输入给自己”的结构就是循环。因为权重共享，不论序列多长都是重复同一个单元，参数量不随长度增加。

> [!QUESTION] 为什么普通 RNN 记不住长距离的信息？
> 反向传播要沿时间一步步连乘权重与激活函数导数，若乘积小于 1 会指数衰减（梯度消失），早期输入就学不到；大于 1 则爆炸。前向时早期信息也在每一步被不断冲淡。

> [!QUESTION] LSTM 的三个门分别做什么？
> 遗忘门决定保留多少旧记忆，输入门决定写入多少新信息，输出门决定从记忆中输出多少到隐藏状态。细胞状态以加法为主更新，让梯度可沿着它几乎无损地回传。

> [!QUESTION] 为什么 Transformer 取代了 RNN 成为主流？
> RNN 必须逐步串行计算，难以并行，长依赖仍吃力、有信息瓶颈；Transformer 用自注意力让任意两个位置直接交互，整句可并行计算，更易扩展到海量数据和参数。

> [!QUESTION] 标量 RNN 例子里，第一步的信息为什么会逐步缩小？
> 每一步隐藏状态被乘上 0.5 左右再进入 tanh，后面输入为 0，没有新信息补充，所以 0.762→0.364→0.180 持续衰减，体现了普通 RNN 的遗忘。
