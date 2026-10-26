---
level: 基础
tags: [张量, shape, 广播, 矩阵乘, einsum, 注意力, 参数量, FLOPs, im2col, 低精度]
summary: 学会读 shape、用广播规则判断形状能不能对上，把 einsum 当“求和还是保留”来读；把注意力公式 softmax(QKᵀ/√dₖ)V 用小数字手算一遍，并估算参数量与 FLOPs、认识 fp16/bf16 的数值陷阱。
---

# 张量、广播与 einsum：把数学写成代码

> [!ABSTRACT] 一句话版本
> - **张量**就是多维数组：标量是 0 阶，向量 1 阶，矩阵 2 阶，再往上都叫张量。**shape** 从外到内读，如 `(batch, seq, dim)` = 一叠 batch 张纸，每张 seq 行 dim 列。
> - **广播**：两个数组形状**右对齐**，逐维比较，相等或其中一个是 1 就能“当作复制”后运算。偏置加到每一行就是它。
> - **einsum**：给每个维度起个字母。**输出里出现的字母 = 保留，没出现的 = 求和**。读懂这一句，所有矩阵乘、点积、注意力都能一行写出来。
> - **注意力**公式 `softmax(QKᵀ/√dₖ)V` 就是“一次批量矩阵乘 → 逐行 softmax → 再一次矩阵乘”；除以 `√dₖ` 是因为点积的标准差随 `√dₖ` 增长。
> - 估算：`m×k` 乘 `k×n` 的矩阵乘约 `2mkn` 次浮点运算，**先写 shape，再写代码**，是调试神经网络的第一技能。

> [!NOTE] 先决条件
> 需要懂 [向量：长度、点积、夹角与相似度](#/math/vectors) 和 [矩阵：线性变换与矩阵乘法](#/math/matrices)。本页最后会用到 [注意力与 Transformer：大模型的骨架](#/aimodel/transformer) 里的公式，没读过也能跟着手算。

## 一、张量与 shape：数据长什么样

### 1. 阶与 shape

| 名字 | 阶（ndim） | shape 例子 | 例子 |
| --- | --- | --- | --- |
| 标量 | 0 | `()` | 一个损失值 `L` |
| 向量 | 1 | `(768,)` | 一个词的嵌入 |
| 矩阵 | 2 | `(28, 28)` | 一张灰度图；一层的权重 `W` |
| 3 阶张量 | 3 | `(32, 10, 768)` | 32 句话，每句 10 个词，每词 768 维 |
| 4 阶张量 | 4 | `(32, 3, 224, 224)` | 32 张彩色图（批、通道、高、宽） |

“阶”就是**取出一个数需要几个下标**。shape 是一个元组，每个位置是对应那一维的长度；**`x.size` = 各维长度的乘积**。

<figure class="fig">
<svg viewBox="0 0 720 330" class="dg" role="img" aria-label="一个形状为 (3,4,6) 的三阶张量像一叠 3 张纸，每张纸 4 行 6 列；三个下标分别是第几句话、第几个词、第几个特征">
<rect class="b1" x="148" y="124" width="168" height="96"/>
<rect class="b1" x="124" y="142" width="168" height="96"/>
<rect class="b1" x="100" y="160" width="168" height="96"/>
<line class="ld" x1="128" y1="160" x2="128" y2="256"/>
<line class="ld" x1="156" y1="160" x2="156" y2="256"/>
<line class="ld" x1="184" y1="160" x2="184" y2="256"/>
<line class="ld" x1="212" y1="160" x2="212" y2="256"/>
<line class="ld" x1="240" y1="160" x2="240" y2="256"/>
<line class="ld" x1="100" y1="184" x2="268" y2="184"/>
<line class="ld" x1="100" y1="208" x2="268" y2="208"/>
<line class="ld" x1="100" y1="232" x2="268" y2="232"/>
<rect class="b3" x="156" y="184" width="28" height="24"/>
<text class="ts" x="170" y="200" text-anchor="middle">x</text>
<text class="tb" x="184" y="278" text-anchor="middle">dim = 6（每个词的特征数）</text>
<line class="l" x1="100" y1="264" x2="268" y2="264"/>
<text class="tb" x="90" y="212" text-anchor="end">seq = 4</text>
<text class="ts" x="90" y="228" text-anchor="end">（第几个词）</text>
<text class="tb" x="326" y="134">batch = 3</text>
<text class="ts" x="326" y="152">（第几句话）</text>
<line class="ld" x1="272" y1="162" x2="318" y2="126"/>
<text class="ta" x="180" y="154">x[0, 1, 2]：一个数</text>
<line class="la" x1="170" y1="160" x2="170" y2="184" marker-end="url(#arr-a)"/>
<rect class="bg" x="430" y="40" width="270" height="270" rx="12"/>
<text class="th" x="446" y="66">shape = (3, 4, 6)</text>
<text class="ts" x="446" y="96">从外到内读：最外层 3 个“块”→ batch</text>
<text class="ts" x="446" y="120">每块 4 行 → seq（4 个词）</text>
<text class="ts" x="446" y="142">每行 6 个数 → dim（每个词 6 维）</text>
<text class="tb" x="446" y="172">ndim = 3（阶），size = 72</text>
<text class="ts" x="446" y="202">x[0]       第 1 句话，形状 (4, 6)</text>
<text class="ts" x="446" y="224">x[:, 1]    每句话的第 2 个词，(3, 6)</text>
<text class="ts" x="446" y="246">x[:, :, 0] 每个词的第 1 个特征，(3, 4)</text>
<text class="ta" x="446" y="282">下标个数 = 阶；取一个数要给全 3 个下标</text>
</svg>
<figcaption>图 1：shape 读法：(batch, seq, dim) = 一叠 batch 张纸，每张 seq 行 dim 列</figcaption>
</figure>

用代码看看：

```python
import numpy as np
x = np.zeros((2, 3, 4))
print(x.shape, x.ndim, x.size)                       # (2, 3, 4) 3 24
print(x[0].shape, x[:, 0].shape, x[:, :, 0].shape)   # (3, 4) (2, 4) (2, 3)
print(x[0, 1, 2].shape)                              # ()   给全了下标，得到一个标量
```

规律：**写了具体下标的那一维就消失了，写 `:` 的保留**。

### 2. AI 里常见的 shape

| 数据 | shape | 说明 |
| --- | --- | --- |
| 一批样本的特征 | `(B, d)` | B = batch size（批大小） |
| 一批文本的 token 编号 | `(B, n)` | n = 序列长度 |
| 嵌入后的文本 | `(B, n, d)` | 每个 token 一个 d 维向量 |
| 一批图片（PyTorch） | `(B, C, H, W)` | C = 通道数 |
| 多头注意力的 Q、K、V | `(B, h, n, dₖ)` | h = 头数，`d = h × dₖ` |
| 注意力分数 | `(B, h, n, n)` | 每个头一张 n×n 表 |
| 线性层权重（PyTorch `nn.Linear`） | `(out, in)` | 计算 `y = x·Wᵀ + b` |

> [!WARNING] `axis` 到底是什么意思
> `X.sum(axis=0)` 的意思是“**把第 0 个下标求和掉**”，结果少一维。对 `(3, 4)` 的矩阵：`axis=0` 得到 `(4,)`（每一列的和），`axis=1` 得到 `(3,)`（每一行的和）。记不住“行还是列”就记“**被求和的那个下标消失**”。这和后面 einsum 里“不出现在输出的字母要求和”是同一件事。

## 二、广播：形状不同也能运算

### 1. 一个问题

神经网络里 `Y = X W + b`：X W 是 `(B, m)` 的矩阵，偏置 b 只有 `(m,)` 一个向量。数学上两个形状不同的东西不能相加，可是代码里直接写 `+` 就行——因为**广播**。

### 2. 规则

1. 把两个 shape **右对齐**，短的前面补 1；
2. 逐个维度比较：**相等**，或者**其中一个是 1**，才能运算（长度为 1 的那个被“拉长”）；
3. 结果的每一维取较大的那个；其他情况报错。

<figure class="fig">
<svg viewBox="0 0 720 312" class="dg" role="img" aria-label="广播的三种情形：长度 4 的行向量加到每一行，3×1 的列向量加到每一列，长度 3 的向量因为最后一维对不上而报错">
<text class="th" x="30" y="34">(3,4) + (4,)</text>
<text class="th" x="262" y="34">(3,4) + (3,1)</text>
<text class="th" x="510" y="34">(3,4) + (3,)</text>
<rect class="b3" x="30" y="66" width="36" height="26"/>
<text class="tm" x="48" y="79" text-anchor="middle" dominant-baseline="middle">10</text>
<rect class="b3" x="66" y="66" width="36" height="26"/>
<text class="tm" x="84" y="79" text-anchor="middle" dominant-baseline="middle">20</text>
<rect class="b3" x="102" y="66" width="36" height="26"/>
<text class="tm" x="120" y="79" text-anchor="middle" dominant-baseline="middle">30</text>
<rect class="b3" x="138" y="66" width="36" height="26"/>
<text class="tm" x="156" y="79" text-anchor="middle" dominant-baseline="middle">40</text>
<line class="ld" x1="48" y1="94" x2="48" y2="114" marker-end="url(#arr)"/>
<line class="ld" x1="84" y1="94" x2="84" y2="114" marker-end="url(#arr)"/>
<line class="ld" x1="120" y1="94" x2="120" y2="114" marker-end="url(#arr)"/>
<line class="ld" x1="156" y1="94" x2="156" y2="114" marker-end="url(#arr)"/>
<rect class="b1" x="30" y="118" width="36" height="26"/>
<text class="tm" x="48" y="131" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="66" y="118" width="36" height="26"/>
<text class="tm" x="84" y="131" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b1" x="102" y="118" width="36" height="26"/>
<text class="tm" x="120" y="131" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b1" x="138" y="118" width="36" height="26"/>
<text class="tm" x="156" y="131" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b1" x="30" y="144" width="36" height="26"/>
<text class="tm" x="48" y="157" text-anchor="middle" dominant-baseline="middle">5</text>
<rect class="b1" x="66" y="144" width="36" height="26"/>
<text class="tm" x="84" y="157" text-anchor="middle" dominant-baseline="middle">6</text>
<rect class="b1" x="102" y="144" width="36" height="26"/>
<text class="tm" x="120" y="157" text-anchor="middle" dominant-baseline="middle">7</text>
<rect class="b1" x="138" y="144" width="36" height="26"/>
<text class="tm" x="156" y="157" text-anchor="middle" dominant-baseline="middle">8</text>
<rect class="b1" x="30" y="170" width="36" height="26"/>
<text class="tm" x="48" y="183" text-anchor="middle" dominant-baseline="middle">9</text>
<rect class="b1" x="66" y="170" width="36" height="26"/>
<text class="tm" x="84" y="183" text-anchor="middle" dominant-baseline="middle">10</text>
<rect class="b1" x="102" y="170" width="36" height="26"/>
<text class="tm" x="120" y="183" text-anchor="middle" dominant-baseline="middle">11</text>
<rect class="b1" x="138" y="170" width="36" height="26"/>
<text class="tm" x="156" y="183" text-anchor="middle" dominant-baseline="middle">12</text>
<text class="ts" x="24" y="83" text-anchor="end">b</text>
<text class="ts" x="102" y="222" text-anchor="middle">每一行都加上同一个 b</text>
<text class="ta" x="102" y="244" text-anchor="middle">✓ 偏置的标准用法</text>
<rect class="b3" x="262" y="118" width="36" height="26"/>
<text class="tm" x="280" y="131" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b3" x="262" y="144" width="36" height="26"/>
<text class="tm" x="280" y="157" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b3" x="262" y="170" width="36" height="26"/>
<text class="tm" x="280" y="183" text-anchor="middle" dominant-baseline="middle">3</text>
<line class="ld" x1="300" y1="131" x2="328" y2="131" marker-end="url(#arr)"/>
<line class="ld" x1="300" y1="157" x2="328" y2="157" marker-end="url(#arr)"/>
<line class="ld" x1="300" y1="183" x2="328" y2="183" marker-end="url(#arr)"/>
<rect class="b1" x="332" y="118" width="36" height="26"/>
<text class="tm" x="350" y="131" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="368" y="118" width="36" height="26"/>
<text class="tm" x="386" y="131" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b1" x="404" y="118" width="36" height="26"/>
<text class="tm" x="422" y="131" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b1" x="440" y="118" width="36" height="26"/>
<text class="tm" x="458" y="131" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b1" x="332" y="144" width="36" height="26"/>
<text class="tm" x="350" y="157" text-anchor="middle" dominant-baseline="middle">5</text>
<rect class="b1" x="368" y="144" width="36" height="26"/>
<text class="tm" x="386" y="157" text-anchor="middle" dominant-baseline="middle">6</text>
<rect class="b1" x="404" y="144" width="36" height="26"/>
<text class="tm" x="422" y="157" text-anchor="middle" dominant-baseline="middle">7</text>
<rect class="b1" x="440" y="144" width="36" height="26"/>
<text class="tm" x="458" y="157" text-anchor="middle" dominant-baseline="middle">8</text>
<rect class="b1" x="332" y="170" width="36" height="26"/>
<text class="tm" x="350" y="183" text-anchor="middle" dominant-baseline="middle">9</text>
<rect class="b1" x="368" y="170" width="36" height="26"/>
<text class="tm" x="386" y="183" text-anchor="middle" dominant-baseline="middle">10</text>
<rect class="b1" x="404" y="170" width="36" height="26"/>
<text class="tm" x="422" y="183" text-anchor="middle" dominant-baseline="middle">11</text>
<rect class="b1" x="440" y="170" width="36" height="26"/>
<text class="tm" x="458" y="183" text-anchor="middle" dominant-baseline="middle">12</text>
<text class="ts" x="280" y="110" text-anchor="middle">(3,1)</text>
<text class="ts" x="366" y="222" text-anchor="middle">每一列都加上同一个数</text>
<text class="ta" x="366" y="244" text-anchor="middle">✓ 按行处理的写法</text>
<rect class="b4" x="510" y="66" width="36" height="26"/>
<text class="tm" x="528" y="79" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b4" x="546" y="66" width="36" height="26"/>
<text class="tm" x="564" y="79" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b4" x="582" y="66" width="36" height="26"/>
<text class="tm" x="600" y="79" text-anchor="middle" dominant-baseline="middle">3</text>
<line class="ld" x1="528" y1="94" x2="528" y2="114" marker-end="url(#arr)"/>
<line class="ld" x1="564" y1="94" x2="564" y2="114" marker-end="url(#arr)"/>
<line class="ld" x1="600" y1="94" x2="600" y2="114" marker-end="url(#arr)"/>
<rect class="b1" x="510" y="118" width="36" height="26"/>
<text class="tm" x="528" y="131" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="b1" x="546" y="118" width="36" height="26"/>
<text class="tm" x="564" y="131" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b1" x="582" y="118" width="36" height="26"/>
<text class="tm" x="600" y="131" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b1" x="618" y="118" width="36" height="26"/>
<text class="tm" x="636" y="131" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b1" x="510" y="144" width="36" height="26"/>
<text class="tm" x="528" y="157" text-anchor="middle" dominant-baseline="middle">5</text>
<rect class="b1" x="546" y="144" width="36" height="26"/>
<text class="tm" x="564" y="157" text-anchor="middle" dominant-baseline="middle">6</text>
<rect class="b1" x="582" y="144" width="36" height="26"/>
<text class="tm" x="600" y="157" text-anchor="middle" dominant-baseline="middle">7</text>
<rect class="b1" x="618" y="144" width="36" height="26"/>
<text class="tm" x="636" y="157" text-anchor="middle" dominant-baseline="middle">8</text>
<rect class="b1" x="510" y="170" width="36" height="26"/>
<text class="tm" x="528" y="183" text-anchor="middle" dominant-baseline="middle">9</text>
<rect class="b1" x="546" y="170" width="36" height="26"/>
<text class="tm" x="564" y="183" text-anchor="middle" dominant-baseline="middle">10</text>
<rect class="b1" x="582" y="170" width="36" height="26"/>
<text class="tm" x="600" y="183" text-anchor="middle" dominant-baseline="middle">11</text>
<rect class="b1" x="618" y="170" width="36" height="26"/>
<text class="tm" x="636" y="183" text-anchor="middle" dominant-baseline="middle">12</text>
<text class="tb" x="636" y="83" text-anchor="middle" dominant-baseline="middle">?</text>
<text class="ts" x="582" y="222" text-anchor="middle">最后一维 4 ≠ 3，对不上</text>
<text class="ta" x="582" y="244" text-anchor="middle">✗ ValueError</text>
<text class="ts" x="30" y="278">规则：形状右对齐，逐维比较；相等，或其中一个是 1（或不存在），就能广播；结果取较大的那个。</text>
<text class="ts" x="30" y="298">广播只是“当作复制了”，并不真的占用 3 倍内存。</text>
</svg>
<figcaption>图 2：广播：把小的数组沿缺失/长度为 1 的维度“复制”到大数组的形状</figcaption>
</figure>

```python
import numpy as np
X = np.arange(1, 13).reshape(3, 4)               # [[1..4] [5..8] [9..12]]，shape (3, 4)
b = np.array([10, 20, 30, 40])                   # shape (4,)
print(X + b)                                     # 每一行都加 b
# [[11 22 33 44]
#  [15 26 37 48]
#  [19 30 41 52]]
# X + np.array([1, 2, 3])   →  ValueError: operands could not be broadcast together with shapes (3,4) (3,)
print(X + np.array([1, 2, 3])[:, None])          # 变成 (3,1)：每一行加各自的数
# [[ 2  3  4  5]
#  [ 7  8  9 10]
#  [12 13 14 15]]
print((np.zeros((8, 1, 5)) + np.zeros((1, 6, 5))).shape)   # (8, 6, 5)：两边的 1 各被拉长
```

### 3. 最常见的坑：`keepdims`

“每行除以这一行的和”（softmax、归一化的核心）：

```python
A = np.array([[1., 3.], [2., 6.]])
print(A.sum(axis=1).shape, A.sum(axis=1, keepdims=True).shape)   # (2,) (2, 1)
print(A / A.sum(axis=1))                         # ✗ 形状对得上，但结果是错的！
# [[0.25  0.375]
#  [0.5   0.75 ]]
print(A / A.sum(axis=1, keepdims=True))          # ✓ 每行和为 1
# [[0.25 0.75]
#  [0.25 0.75]]
```

行和是 `(4, 8)`。`(2,)` 右对齐到最后一维，变成“**每一列**除以不同的数”，而不是每一行。**方阵时形状碰巧对得上，不会报错，结果却是错的**，最难发现。`keepdims=True` 保持 `(2, 1)`，右对齐后自然是“每行”。

> [!WARNING] 广播出错的两种样子
> 报错（形状对不上）还算好的；**悄悄算出错误结果**才危险。养成习惯：对每个归约（sum / mean / max）问自己“结果的 shape 是什么，右对齐后和谁配对”。PyTorch 里对应的写法是 `keepdim=True`，`softmax(dim=-1)` 等函数已经帮你处理好了。

## 三、批量矩阵乘与转置

### 1. `@` 的规则

当数组超过 2 维，`@` 把**最后两维**当矩阵相乘，前面的维度当成“批”，一起（广播地）重复：

```text
(…, m, n) @ (…, n, p) → (…, m, p)       中间的 n 必须相等
```

| 表达式 | 形状 | 含义 |
| --- | --- | --- |
| `X @ W`：`(B, n, d) @ (d, m)` | `(B, n, m)` | 对每个词做同一个线性变换（全连接层） |
| `Q @ Kᵀ`：`(B, n, dₖ) @ (B, dₖ, n)` | `(B, n, n)` | 每句话内部，每对词的点积 |
| `P @ V`：`(B, n, n) @ (B, n, dᵥ)` | `(B, n, dᵥ)` | 注意力权重对 V 加权求和 |

### 2. 转置与换轴

`.T` 只对 2 维矩阵有意义。高维要说清楚**交换哪两根轴**：

```python
K = np.zeros((2, 5, 4))                    # (B, n, dₖ)
print(K.transpose(0, 2, 1).shape)          # (2, 4, 5)  ←→  K.swapaxes(-1, -2)
# PyTorch：K.transpose(-1, -2)；任意重排用 K.permute(0, 2, 1)
```

多头注意力里“切成 h 份”要同时用到 `reshape` 和 `transpose`：

```python
B, n, d, h = 2, 5, 512, 8
x = np.random.default_rng(0).standard_normal((B, n, d))
dk = d // h                                              # 每个头 64 维
heads = x.reshape(B, n, h, dk).transpose(0, 2, 1, 3)     # 把最后一维切成 (h, dk)，再把 h 提到前面
print(heads.shape)                                       # (2, 8, 5, 64)
scores = np.einsum('bhqd,bhkd->bhqk', heads, heads) / np.sqrt(dk)
print(scores.shape)                                      # (2, 8, 5, 5)
back = heads.transpose(0, 2, 1, 3).reshape(B, n, d)      # 拼回去
print(np.allclose(back, x))                              # True
```

> [!TIP] reshape 不是 transpose
> `reshape` 只改变“怎么切”，不改变数据在内存里的顺序（按最后一维变化最快的顺序读）；`transpose` 才是真正交换含义。把 `(B, n, h·dₖ)` 直接 reshape 成 `(B, h, n, dₖ)` 会**悄悄把数据搞乱**，必须先 reshape 成 `(B, n, h, dₖ)` 再 transpose。

## 四、einsum：把下标当成“求和还是保留”

### 1. 一句话规则

```text
np.einsum('ij,jk->ik', A, B)
          ↑ 输入的下标   ↑ 输出的下标
```

- 每个字母代表一根轴；**相同的字母 = 这两根轴要对齐（长度必须相等）**；
- **出现在输出里的字母 → 保留；没出现在输出里的字母 → 对它求和**。

`'ij,jk->ik'`：j 没出现在输出里，所以对 j 求和，也就是

```text
out[i, k] = Σⱼ A[i, j] · B[j, k]        ← 这就是矩阵乘法的定义
```

手算一次：`A = [[4,3,2],[1,1,0]]`（2×3），`B = [[0,0],[0,4],[3,4]]`（3×2）：

```text
out[0,0] = 4×0 + 3×0 + 2×3 = 6          out[0,1] = 4×0 + 3×4 + 2×4 = 20
out[1,0] = 1×0 + 1×0 + 0×3 = 0          out[1,1] = 1×0 + 1×4 + 0×4 = 4
```

### 2. 常用写法对照

| einsum | 等价写法 | 求和的轴 | 说明 |
| --- | --- | --- | --- |
| `'i,i->'` | `a @ b` | i | 点积 |
| `'ij->ji'` | `A.T` | 无 | 转置 |
| `'ij->i'` | `A.sum(axis=1)` | j | 行和 |
| `'ij->j'` | `A.sum(axis=0)` | i | 列和 |
| `'ij,j->i'` | `A @ x` | j | 矩阵乘向量 |
| `'ij,jk->ik'` | `A @ B` | j | 矩阵乘矩阵 |
| `'i,j->ij'` | `np.outer(u, v)` | 无 | **外积**（上一页的“薄片” `u vᵀ`） |
| `'bij,bjk->bik'` | `A @ B` | j | 批量矩阵乘 |
| `'bqd,bkd->bqk'` | `Q @ K.transpose(0,2,1)` | d | **注意力分数** `QKᵀ` |
| `'bqk,bkd->bqd'` | `P @ V` | k | 注意力权重 × V |

```python
import numpy as np
A = np.array([[4, 3, 2], [1, 1, 0]]); B = np.array([[0, 0], [0, 4], [3, 4]])
print(np.einsum('ij,jk->ik', A, B))                      # [[ 6 20] [ 0  4]]，和 A @ B 一样
print(np.einsum('ij->i', A), np.einsum('ij->j', A), np.einsum('ij->', A))   # [9 2] [5 4 2] 11
u = np.array([1, 2, 3]); v = np.array([1, 0, 2, 1])
print(np.einsum('i,j->ij', u, v))                        # 外积：3×4，秩为 1
# [[1 0 2 1]
#  [2 0 4 2]
#  [3 0 6 3]]
```

> [!WARNING] einsum 的三个容易错的地方
> - 字母只是“**名字**”，换成别的字母结果不变；真正起作用的是“哪些字母相同”“哪些出现在输出里”。
> - 输出里字母的**顺序决定轴的顺序**：`'ij->ji'` 是转置。
> - 不写 `->` 会启用“隐式模式”（输出按字母表顺序，只出现一次的字母保留），容易看错，建议**总是写出 `->`**。

## 五、注意力的矩阵版：手算一次

### 1. 公式拆成三步

```text
Attention(Q, K, V) = softmax( Q·Kᵀ / √dₖ ) · V
```

设 n 个词，每个词的 Q、K 是 dₖ 维，V 是 dᵥ 维。形状：`Q (n×dₖ)`、`K (n×dₖ)`、`V (n×dᵥ)`。

1. `Q·Kᵀ`：`(n×dₖ)(dₖ×n) = (n×n)`，第 i 行第 j 列 = 词 i 的 Q 与词 j 的 K 的点积（“相关度”）；
2. 除以 `√dₖ`，再对**每一行** softmax：每行变成和为 1 的权重；
3. 乘 V：`(n×n)(n×dᵥ) = (n×dᵥ)`，每行是对所有词的 V 的加权平均。

### 2. 3 个词、dₖ = 2 的完整手算

为了好算，让 `K = Q`，并直接给出：

```text
Q = K = | 1  0 |      V = | 1  0 |        dₖ = 2，√dₖ = 1.414
        | 0  1 |          | 0  2 |
        | 1  1 |          | 2  2 |
```

**第 1 步：分数 `Q·Kᵀ`**（每行与每行做点积）：

```text
Q·Kᵀ = | 1×1+0×0   1×0+0×1   1×1+0×1 |   | 1  0  1 |
       | 0×1+1×0   0×0+1×1   0×1+1×1 | = | 0  1  1 |       再 ÷1.414 → | 0.707  0     0.707 |
       | 1×1+1×0   1×0+1×1   1×1+1×1 |   | 1  1  2 |                   | 0      0.707 0.707 |
                                                                        | 0.707  0.707 1.414 |
```

**第 2 步：每行 softmax**。以第 1 行 `(0.707, 0, 0.707)` 为例：

```text
e^0.707 = 2.028，e^0 = 1，e^0.707 = 2.028，和 = 5.056
权重 = (2.028, 1, 2.028)/5.056 = (0.401, 0.198, 0.401)       和为 1 ✓
第 3 行 (0.707, 0.707, 1.414)：e^ = (2.028, 2.028, 4.113)，和 8.169 → (0.248, 0.248, 0.503)
```

**第 3 步：乘 V**。第 1 行的输出：

```text
0.401×(1, 0) + 0.198×(0, 2) + 0.401×(2, 2) = (0.401 + 0.802,  0.396 + 0.802) = (1.203, 1.198)
```

<figure class="fig">
<svg viewBox="0 0 720 286" class="dg" role="img" aria-label="注意力的矩阵形状流动：Q 乘 K 转置得到分数矩阵，除以根号 dk 后逐行 softmax 得到权重矩阵，再乘 V 得到输出，数字是正文手算的 3 个词的例子">
<text class="ts" x="30" y="50">Q（3×2）</text>
<rect class="b1" x="30" y="58" width="70" height="64" rx="8"/>
<text class="tm" x="65" y="76" text-anchor="middle" dominant-baseline="middle">1  0</text>
<text class="tm" x="65" y="94" text-anchor="middle" dominant-baseline="middle">0  1</text>
<text class="tm" x="65" y="112" text-anchor="middle" dominant-baseline="middle">1  1</text>
<text class="th" x="118" y="94" text-anchor="middle" dominant-baseline="middle">×</text>
<text class="ts" x="136" y="50">Kᵀ（2×3）</text>
<rect class="b3" x="136" y="58" width="90" height="64" rx="8"/>
<text class="tm" x="181" y="85" text-anchor="middle" dominant-baseline="middle">1  0  1</text>
<text class="tm" x="181" y="103" text-anchor="middle" dominant-baseline="middle">0  1  1</text>
<text class="th" x="246" y="94" text-anchor="middle" dominant-baseline="middle">→</text>
<text class="ts" x="262" y="50">Q·Kᵀ ÷ √2（3×3）：分数</text>
<rect class="b5" x="262" y="58" width="150" height="64" rx="8"/>
<text class="tm" x="337" y="76" text-anchor="middle" dominant-baseline="middle">0.71  0.00  0.71</text>
<text class="tm" x="337" y="94" text-anchor="middle" dominant-baseline="middle">0.00  0.71  0.71</text>
<text class="tm" x="337" y="112" text-anchor="middle" dominant-baseline="middle">0.71  0.71  1.41</text>
<rect class="bg" x="440" y="40" width="260" height="94" rx="10"/>
<text class="tb" x="454" y="62">为什么 ÷√dₖ？</text>
<text class="ts" x="454" y="84">点积的大小随维度 dₖ 增长，</text>
<text class="ts" x="454" y="104">除以 √dₖ 把分数拉回合理范围，</text>
<text class="ts" x="454" y="124">免得 softmax 变成近似 one-hot</text>
<line class="la" x1="337" y1="124" x2="337" y2="168" marker-end="url(#arr-a)"/>
<text class="ta" x="347" y="150">softmax：对每一行</text>
<text class="ts" x="262" y="176">P = 注意力权重（3×3）</text>
<rect class="b4" x="262" y="184" width="150" height="64" rx="8"/>
<text class="tm" x="337" y="202" text-anchor="middle" dominant-baseline="middle">0.40  0.20  0.40</text>
<text class="tm" x="337" y="220" text-anchor="middle" dominant-baseline="middle">0.20  0.40  0.40</text>
<text class="tm" x="337" y="238" text-anchor="middle" dominant-baseline="middle">0.25  0.25  0.50</text>
<text class="th" x="432" y="220" text-anchor="middle" dominant-baseline="middle">×</text>
<text class="ts" x="450" y="176">V（3×2）</text>
<rect class="b2" x="450" y="184" width="70" height="64" rx="8"/>
<text class="tm" x="485" y="202" text-anchor="middle" dominant-baseline="middle">1  0</text>
<text class="tm" x="485" y="220" text-anchor="middle" dominant-baseline="middle">0  2</text>
<text class="tm" x="485" y="238" text-anchor="middle" dominant-baseline="middle">2  2</text>
<text class="th" x="540" y="220" text-anchor="middle" dominant-baseline="middle">=</text>
<text class="ts" x="556" y="176">输出（3×2）</text>
<rect class="b2" x="556" y="184" width="110" height="64" rx="8"/>
<text class="tm" x="611" y="202" text-anchor="middle" dominant-baseline="middle">1.20  1.20</text>
<text class="tm" x="611" y="220" text-anchor="middle" dominant-baseline="middle">1.00  1.60</text>
<text class="tm" x="611" y="238" text-anchor="middle" dominant-baseline="middle">1.26  1.50</text>
<rect class="bg" x="30" y="150" width="210" height="118" rx="10"/>
<text class="tb" x="44" y="172">形状怎么流动</text>
<text class="ts" x="44" y="194">(n×dₖ)·(dₖ×n) → (n×n)</text>
<text class="ts" x="44" y="214">(n×n)·(n×dᵥ) → (n×dᵥ)</text>
<text class="ts" x="44" y="238">每一行 P 的和为 1</text>
<text class="ts" x="44" y="256">输出行 = 对 V 各行的加权平均</text>
</svg>
<figcaption>图 3：softmax(QKᵀ/√dₖ)V 的形状与数值（3 个词，dₖ = 2）</figcaption>
</figure>

```python
import numpy as np

def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True))          # 先减最大值，防止指数溢出
    return e / e.sum(-1, keepdims=True)               # keepdims：每一行除以自己的和

Q = K = np.array([[1, 0], [0, 1], [1, 1.]])
V = np.array([[1, 0], [0, 2], [2, 2.]])
S = Q @ K.T / np.sqrt(2)
P = softmax(S)
print(S.round(3))
# [[0.707 0.    0.707]
#  [0.    0.707 0.707]
#  [0.707 0.707 1.414]]
print(P.round(3))
# [[0.401 0.198 0.401]
#  [0.198 0.401 0.401]
#  [0.248 0.248 0.503]]
print((P @ V).round(3))
# [[1.203 1.198]
#  [1.    1.604]
#  [1.255 1.503]]
print(np.einsum('bqd,bkd->bqk', Q[None], K[None])[0])   # 批量写法：[None] 加一个 batch 维
# [[1. 0. 1.]
#  [0. 1. 1.]
#  [1. 1. 2.]]
```

如果是**因果注意力**（GPT 类），在第 2 步之前把分数矩阵的**上三角**（未来的词）设成 `−∞`，softmax 后这些权重就是 0。这个例子里第 1 个词只能看自己，权重是 `(1, 0, 0)`，第 2 个词是 `(0.33, 0.67, 0)`。

### 3. 为什么要除以 √dₖ

设 q、k 的每个分量都是均值 0、方差 1 的独立随机数。点积 `q·k = Σ qᵢkᵢ` 是 dₖ 个“方差为 1”的数相加，方差 = dₖ，**标准差 = √dₖ**。维度越大，分数越“尖”，softmax 越接近 one-hot（几乎把所有权重给一个词，其余梯度接近 0）。除以 `√dₖ` 把标准差拉回 1。数值验证：

```python
import numpy as np
rng = np.random.default_rng(0)

def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)

for d in [4, 64, 512]:
    q = rng.standard_normal((20000, d)); k = rng.standard_normal((20000, d))
    s = (q * k).sum(axis=1)                       # 20000 个 q·k
    print(d, s.std().round(2), (s / np.sqrt(d)).std().round(2))
# 4 2.0 1.0
# 64 8.03 1.0
# 512 22.54 1.0

for d in [4, 64, 512]:                            # 1 个 query 对 10 个 key：最大的那个权重平均多大
    m1, m2 = [], []
    for _ in range(2000):
        q = rng.standard_normal(d); K = rng.standard_normal((10, d)); s = K @ q
        m1.append(softmax(s).max()); m2.append(softmax(s / np.sqrt(d)).max())
    print(d, np.mean(m1).round(3), np.mean(m2).round(3))
# 4 0.497 0.307
# 64 0.862 0.319
# 512 0.95 0.323
```

10 个 key 时，完全均匀是每个 0.1。不除以 √dₖ，d = 512 时最大权重平均 **0.95**（近乎 one-hot）；除以 √dₖ 之后无论 d 多大都稳定在 0.31～0.32 左右，所以**训练不会因为维度变大而变得不稳**。

## 六、全连接与卷积的矩阵视角，参数量与 FLOPs

### 1. 全连接：就是一次矩阵乘

`nn.Linear(in, out)` 对一批样本 `X (B, in)` 计算 `Y = X·Wᵀ + b`，`W` 的形状是 `(out, in)`，输出 `(B, out)`。

- **参数量**：`in × out + out`；
- **FLOPs**（浮点运算次数；一次“乘 + 加”记 2 次）：矩阵乘 `(m×k)(k×n)` 需要 `m·n` 个输出，每个要 k 次乘 + k 次加，所以约 **`2·m·k·n`**。

```text
784 → 128，batch = 64：    参数 = 784×128 + 128 = 100,480
                          FLOPs = 2 × 64 × 784 × 128 = 12,845,056  ≈ 12.8 MFLOPs（前向）
Transformer d=4096：一个 d×d 矩阵对一个 token：2×4096² = 33,554,432 ≈ 33.6 MFLOPs
```

经验公式：一个块约 `12d²` 参数（`d = 4096`、32 层 ≈ 12×4096²×32 = 6,442,450,944 ≈ 64 亿），前向每个 token 约 **`2 × 参数量`** FLOPs ≈ 12.9 GFLOPs，训练（前向 + 反向）约 `6 ×` 参数量（忽略了注意力里随 n² 增长的那一项）。

### 2. 卷积：im2col 把它变成矩阵乘

卷积核在图上滑动，每个位置做“一个窗口和核的点积”。把**每个窗口展开成一行**（im2col），所有窗口叠成一个矩阵，卷积就变成**一次矩阵乘**，GPU 最擅长这个。例：4×4 的图，3×3 的核（竖直边缘检测器），输出 2×2：

```text
图 = | 1 2 0 1 |      核 = | 1 0 −1 |         4 个窗口 → 4 行，每行 9 个数：
     | 0 1 3 1 |           | 1 0 −1 |         [1 2 0 0 1 3 2 1 0]
     | 2 1 0 0 |           | 1 0 −1 |         [2 0 1 1 3 1 1 0 0]
     | 1 0 1 2 |                              [0 1 3 2 1 0 1 0 1]
                                               [1 3 1 1 0 0 0 1 2]
(4×9 的矩阵) @ (核展开成 9×1) = [0, 2, −1, −1] → 重排成 2×2：| 0  2 |
                                                           |−1 −1 |
```

第 1 个窗口：`1×1 + 2×0 + 0×(−1) + 0×1 + 1×0 + 3×(−1) + 2×1 + 1×0 + 0×(−1) = 1 − 3 + 2 = 0` ✓。

```python
import numpy as np
img = np.array([[1, 2, 0, 1], [0, 1, 3, 1], [2, 1, 0, 0], [1, 0, 1, 2]])
ker = np.array([[1, 0, -1], [1, 0, -1], [1, 0, -1]])
cols = np.array([img[i:i+3, j:j+3].ravel() for i in range(2) for j in range(2)])
print(cols @ ker.ravel())                                   # [ 0  2 -1 -1]
print(np.array([[(img[i:i+3, j:j+3] * ker).sum() for j in range(2)] for i in range(2)]))   # 直接卷积
# [[ 0  2]
#  [-1 -1]]
```

卷积层的参数量和 FLOPs：`Conv2d(3, 16, 3×3)`，输入 `(B, 3, 32, 32)`，padding = 1（输出仍是 32×32）：

```text
参数 = C_out × C_in × k × k + C_out = 16×3×3×3 + 16 = 448
FLOPs（每张图）= 2 × (输出元素个数 16×32×32) × (每个输出的乘加 C_in·k·k = 27) = 884,736
```

卷积的参数很少（核被所有位置共享），但 FLOPs 并不少；见 [CNN：卷积神经网络如何“看图”](#/aimodel/cnn)。

## 七、低精度：fp16、bf16（认识）

大模型不会都用 32 位浮点，常见格式：

| 格式 | 位数（符号/指数/尾数） | 最大值 | 精度 `eps`（1 附近的最小间隔） | 7B 模型的权重占用 |
| --- | --- | --- | --- | --- |
| fp32 | 1 / 8 / 23 | 约 3.4×10³⁸ | 1.2×10⁻⁷ | 28 GB |
| fp16 | 1 / 5 / 10 | **65504** | 9.8×10⁻⁴ | 14 GB |
| bf16 | 1 / 8 / 7 | 约 3.4×10³⁸ | 7.8×10⁻³ | 14 GB |

（int8 约 7 GB，4 位量化约 3.5 GB，见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)。）**fp16 范围小、精度较好；bf16 范围和 fp32 一样大、精度更粗**。看三个现象：

```python
import numpy as np, torch
print(np.float16(2048) + np.float16(1))                   # 2048.0   大数吃小数：2048 附近的间隔是 2
s32 = np.float32(0); s16 = np.float16(0)
for _ in range(10000):
    s32 += np.float32(0.1); s16 = np.float16(s16 + np.float16(0.1))
print(s32, s16)                                           # 999.9029 256.0   fp16 累加 10000 个 0.1，卡在 256

for dt in (torch.float32, torch.float16, torch.bfloat16):
    big = torch.tensor(70000., dtype=dt)
    one = torch.tensor(1., dtype=dt) + torch.tensor(0.001, dtype=dt)
    print(dt, big.item(), one.item())
# torch.float32 70000.0 1.0010000467300415
# torch.float16 inf 1.0009765625             ← 70000 超过 65504：溢出成 inf
# torch.bfloat16 70144.0 1.0                 ← 范围够，但 1 + 0.001 被吞掉了
```

- **溢出**：fp16 里 `exp(12) = 162755` 已经超过 65504 变成 `inf`，这就是 softmax 必须**先减最大值**的原因；
- **吞小数**：累加很多小数（求和、梯度累积、LayerNorm 的均值方差）时精度不够会越加越不准；
- **混合精度训练**：矩阵乘用 fp16/bf16（快、省显存），但**累加、softmax、归一化、损失和主权重**用 fp32；fp16 的梯度容易下溢成 0，要配合“损失缩放”，bf16 范围大，通常不需要。

## 八、对照表

| 概念 | 一句话 | 常见写法 / AI 里的身影 |
| --- | --- | --- |
| 张量、阶、shape | 多维数组；取一个数要几个下标；每维长度 | `(B, n, d)` |
| 广播 | 右对齐，相等或为 1 就“复制” | 偏置、减均值、除以范数 |
| `keepdims` | 归约后保留长度为 1 的维度 | softmax、LayerNorm |
| `@` 批量矩阵乘 | 最后两维做矩阵乘，前面当批 | 线性层、`QKᵀ`、`PV` |
| `transpose` / `reshape` | 换轴 / 重新切分 | 多头注意力 |
| einsum | 输出里有的保留，没有的求和 | `'bqd,bkd->bqk'` |
| `√dₖ` | 点积的标准差随 `√dₖ` 增长 | 注意力缩放 |
| `2mkn` | 矩阵乘的 FLOPs | 成本估算（参数 × 2 ≈ 每 token 前向） |
| fp16 / bf16 | 省显存提速，但溢出、吞小数 | 混合精度训练、推理量化 |

## 自测：你真的懂了吗？

> [!QUESTION] `X` 的 shape 是 `(32, 10, 64)`，`W` 是 `(64, 128)`。`X @ W` 的形状？`W` 有多少参数（加上 128 维偏置）？
> 最后两维 `(10, 64) @ (64, 128) = (10, 128)`，前面的 batch 维保留，结果 `(32, 10, 128)`。参数 = `64×128 + 128 = 8,320`。

> [!QUESTION] 多头注意力里 `Q`、`K` 形状都是 `(B, h, n, dₖ)`，分数的形状是什么？用 einsum 写出来。`B=2, h=8, n=100, dₖ=64` 时，分数矩阵有多少个元素，计算 `QKᵀ` 要多少 FLOPs？
> 形状 `(B, h, n, n)`，`np.einsum('bhqd,bhkd->bhqk', Q, K)`（对 d 求和）。元素数 `2×8×100×100 = 160,000`；FLOPs = `2·B·h·n·n·dₖ = 2×2×8×100×100×64 = 20,480,000`。n 翻倍，分数矩阵和这项 FLOPs 都变 4 倍。

> [!QUESTION] 判断下面三个广播的结果形状，或指出为什么报错：`(8,1,5) + (1,6,5)`；`(4,3) + (4,)`；`(4,3) + (4,1)`。
> 第一个：右对齐逐维比较，`8 vs 1`、`1 vs 6`、`5 vs 5` 都可以，结果 `(8, 6, 5)`。第二个：最后一维 `3 vs 4` 不相等且都不是 1，报错。第三个：`(4,3) + (4,1)`，最后一维 `3 vs 1` 可以，第一维 `4 vs 4`，结果 `(4, 3)`，每一行各加一个数。

> [!QUESTION] 想把形状 `(B, n, d)` 的张量里每个词向量除以自己的长度（L2 归一化），应该怎么写？如果漏了 `keepdims=True` 会怎样？
> `x / np.linalg.norm(x, axis=-1, keepdims=True)`，范数的形状是 `(B, n, 1)`，右对齐后每个词除以自己的长度。漏了 `keepdims`，范数形状是 `(B, n)`，右对齐后是拿 `n` 去和 `d` 比：通常直接报错；形状碰巧对上时（如 `n == d`、`B == 1`）则**悄悄算错**。

> [!QUESTION] `np.einsum('ij,kj->ik', A, B)` 等价于什么矩阵运算？`A` 是 `(2,3)`、`B` 是 `(4,3)`，结果形状？
> 对 j 求和，`out[i,k] = Σⱼ A[i,j]·B[k,j]`，等价于 `A @ B.T`，结果 `(2, 4)`。注意力的 `QKᵀ` 就是这种写法。

> [!QUESTION] `Conv2d(in_channels=16, out_channels=32, kernel_size=3, padding=1)`，输入 `(B, 16, 28, 28)`。输出形状？参数量？每张图的 FLOPs？
> 输出 `(B, 32, 28, 28)`（padding=1、核 3×3 保持大小）。参数 `32×16×3×3 + 32 = 4,640`。FLOPs = `2 × (32×28×28) × (16×3×3) = 2 × 25,088 × 144 = 7,225,344`。

> [!QUESTION] 为什么 fp16 做 softmax 之前一定要先减去每行的最大值？
> `exp(x)` 增长很快，fp16 的最大值只有 65504，`exp(12)` 就已经溢出成 `inf`，得到 `inf/inf = nan`。减去最大值后所有指数的输入 ≤ 0，`exp` 落在 `(0, 1]`，不会溢出，而 softmax 的结果不变（分子分母同时乘了同一个常数）。

## 相关阅读

- 上一页：[奇异值分解（SVD）与低秩：压缩、推荐与 LoRA](#/math/svd)（外积、低秩与 einsum 的 `'i,j->ij'`）
- 注意力全貌：[注意力与 Transformer：大模型的骨架](#/aimodel/transformer)
- 全连接与参数量：[MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)
- 卷积：[CNN：卷积神经网络如何“看图”](#/aimodel/cnn)
- 收官：[数学到 AI 的对照地图与综合练习](#/math/ai-map)
