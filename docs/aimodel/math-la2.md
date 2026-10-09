---
level: 基础
tags: [线性代数, 特征值, 特征向量, SVD, PCA, 降维, 低秩, 入门]
summary: 用“拉伸方向”的直觉理解特征值与特征向量，用“旋转-拉伸-旋转”理解奇异值分解（SVD），并说明 PCA 降维、图片压缩、推荐系统与大模型 LoRA 里的低秩思想。
---

# 线性代数 2：特征值、SVD 与 PCA

> [!ABSTRACT] 一句话版本
> - 矩阵对空间做变换，大多数方向都会被“拧歪”；但**总有几个特殊方向，变换后只被拉长/缩短、不转向**——这些方向叫**特征向量**，拉伸倍数叫**特征值**。
> - **SVD（奇异值分解）**：任何矩阵都可以拆成“**旋转 → 拉伸 → 再旋转**”三步；拉伸的大小（奇异值）告诉你**哪些方向信息多、哪些可以丢掉**。
> - **PCA（主成分分析）**：找出数据**最分散的方向**，把高维数据压到低维，尽量少丢信息。
> - 共同思想：**很多数据其实“没有看起来那么复杂”**，用少数几个主要方向就能近似——这就是**低秩**，大模型微调方法 LoRA 就用了它。

> [!NOTE] 先决条件
> 需要先读 [线性代数 1：向量与矩阵](#/aimodel/math-la1)，了解向量、矩阵乘法、“矩阵是一种变换”。

## 一、特征向量与特征值：矩阵的“不转向方向”

### 1. 直觉

想象把一块橡皮膜按某种规则拉伸。膜上大多数点都会**移动并改变方向**，但有那么几条线：**沿着这条线的点，只是沿线被拉长或缩短，线本身方向没变**。这些线的方向就是**特征向量**，拉伸的倍数就是**特征值**。

写成公式：

```text
A · v = λ · v
          ↑ 特征值（一个数）
```

读法：**矩阵 A 作用在向量 v 上，效果等同于把 v 乘上一个数 λ**——只缩放、不转向。

### 2. 一个手算例子

取矩阵 `A = [[2, 1], [1, 2]]`。

```text
试试 v₁ = (1, 1)：   A·v₁ = (2×1+1×1, 1×1+2×1) = (3, 3) = 3 × (1, 1)   ✓  特征值 λ₁ = 3
试试 v₂ = (1, −1)：  A·v₂ = (2×1+1×(−1), 1×1+2×(−1)) = (1, −1) = 1 × (1, −1)   ✓  特征值 λ₂ = 1
```

也就是说：沿对角线方向 `(1,1)` 被**拉长 3 倍**，沿反对角方向 `(1,−1)` **不变**（拉长 1 倍）。

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="单位圆经过矩阵变换后变成椭圆，椭圆的长轴沿特征向量方向，长度由特征值决定">
<line class="l" x1="40" y1="160" x2="330" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="185" y1="290" x2="185" y2="30" marker-end="url(#arr)"/>
<circle class="b1" cx="185" cy="160" r="42"/>
<text class="ts" x="185" y="250" text-anchor="middle">变换前：单位圆</text>
<line class="la" x1="350" y1="160" x2="410" y2="160" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="148" text-anchor="middle">A</text>
<line class="l" x1="430" y1="160" x2="720" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="575" y1="290" x2="575" y2="30" marker-end="url(#arr)"/>
<ellipse class="b2" cx="575" cy="160" rx="127" ry="42" transform="rotate(-45 575 160)"/>
<line class="la" x1="575" y1="160" x2="665" y2="70" marker-end="url(#arr-a)"/>
<text class="ta" x="660" y="56" text-anchor="end">v₁，被拉长 3 倍</text>
<line class="l" x1="575" y1="160" x2="605" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="612" y="200" text-anchor="start">v₂，长度不变（×1）</text>
<text class="ts" x="575" y="268" text-anchor="middle">变换后：椭圆，长轴沿特征向量 v₁</text>
</svg>
<figcaption>图 1：圆被矩阵“拉”成椭圆，椭圆的两条轴就是特征向量方向</figcaption>
</figure>

### 3. 特征值有什么用

| 场景 | 作用 |
| --- | --- |
| **看变换的“主要方向”** | 特征值大的方向，变化最剧烈 |
| **稳定性分析** | 反复乘同一个矩阵（如循环网络），特征值 > 1 → 数值会爆炸；< 1 → 会衰减消失（这就是“梯度爆炸/消失”的数学根源，见 [RNN 与 LSTM：会“记事”的网络](#/aimodel/rnn)） |
| **PageRank（谷歌早期搜索）** | 网页重要性 = 链接矩阵的主特征向量 |
| **PCA** | 数据协方差矩阵的特征向量 = 数据最分散的方向（下文） |

> [!NOTE] 手算方法（了解即可）
> 特征值满足 `det(A − λI) = 0`。对上例：`(2−λ)² − 1 = 0`，解得 `λ = 1` 或 `3`。实际工作中都用 `numpy.linalg.eig` 计算。

## 二、SVD：任何矩阵 = 旋转 + 拉伸 + 旋转

特征值只适用于“方阵”，而且需要一些条件。**SVD（奇异值分解）适用于任何矩阵**，是线性代数里最实用的工具之一。

```text
A  =  U  ·  Σ  ·  Vᵀ
      ↑     ↑     ↑
   旋转②  拉伸①  旋转①
```

<figure class="fig">
<svg viewBox="0 0 740 220" class="dg" role="img" aria-label="SVD 把变换分成三步：先用 Vᵀ 旋转，再用 Σ 沿坐标轴拉伸，最后用 U 再旋转">
<circle class="b1" cx="90" cy="100" r="46"/>
<text class="ts" x="90" y="180" text-anchor="middle">起点：单位圆</text>
<line class="la" x1="150" y1="100" x2="195" y2="100" marker-end="url(#arr-a)"/>
<text class="ta" x="172" y="88" text-anchor="middle">Vᵀ</text>
<circle class="b3" cx="270" cy="100" r="46"/>
<line class="l" x1="270" y1="100" x2="300" y2="70"/>
<text class="ts" x="270" y="180" text-anchor="middle">① 旋转（圆还是圆）</text>
<line class="la" x1="330" y1="100" x2="375" y2="100" marker-end="url(#arr-a)"/>
<text class="ta" x="352" y="88" text-anchor="middle">Σ</text>
<ellipse class="b5" cx="470" cy="100" rx="80" ry="26"/>
<text class="ts" x="470" y="180" text-anchor="middle">② 沿坐标轴拉伸（σ₁=大, σ₂=小）</text>
<line class="la" x1="565" y1="100" x2="610" y2="100" marker-end="url(#arr-a)"/>
<text class="ta" x="588" y="88" text-anchor="middle">U</text>
<ellipse class="b2" cx="670" cy="100" rx="60" ry="22" transform="rotate(-35 670 100)"/>
<text class="ts" x="670" y="180" text-anchor="middle">③ 再旋转</text>
</svg>
<figcaption>图 2：SVD 把任意变换拆成“旋转 → 拉伸 → 旋转”</figcaption>
</figure>

- **Σ（西格玛）** 是对角矩阵，对角线上的数叫**奇异值**，按从大到小排列：`σ₁ ≥ σ₂ ≥ …`；
- 奇异值**越大，说明这个方向上的“信息量”越大**；很小的奇异值对应的方向几乎没贡献。

### 低秩近似：只留“大头”

把 Σ 里**最小的那些奇异值丢掉**，得到一个更简单的矩阵 `A'`，它**仍然非常接近 A**：

```text
A  ≈  σ₁·u₁v₁ᵀ  +  σ₂·u₂v₂ᵀ  +  …  +  σₖ·uₖvₖᵀ      （只保留前 k 项）
```

**例子：图片压缩**

一张 1000×1000 的灰度图是一个 1000×1000 的矩阵，共 100 万个数。如果只保留前 k=50 个奇异值：

```text
需要存：50 个奇异值 + 50 个 u（各 1000 维）+ 50 个 v（各 1000 维）
      = 50 + 50×1000 + 50×1000 ≈ 10 万个数        （压缩到约原来的 1/10，画面仍清晰）
```

**例子：推荐系统**

“用户 × 电影”评分表很大但很稀疏。SVD/矩阵分解发现它其实由少数几个“口味因子”（喜欢科幻？喜欢爱情？）决定，用这几个因子就能**预测你没看过的电影的评分**。

### 例子：大模型的 LoRA

大模型的一个权重矩阵 W 有几千×几千个参数，微调时全部更新太贵。**LoRA** 的想法：**更新量 ΔW 很可能是低秩的**，所以不直接学 ΔW，而是学两个**又瘦又高**的小矩阵 `B (d×r)` 和 `A (r×d)`，令 `ΔW = B·A`（r 很小，如 8、16）：

```text
W' = W + B·A
d=4096, r=8：  全量参数 4096×4096 ≈ 1678 万   vs   LoRA 参数 2×4096×8 ≈ 6.6 万   （约 1/250）
```

这是“低秩”思想的现代实战，更多见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)。

## 三、PCA：找数据“最分散”的方向

### 1. 问题

你有一份数据，每个样本有 100 个特征（100 维）。很多特征是**重复或高度相关的**（比如“身高（cm）”和“身高（英寸）”）。能不能压缩到 2~3 维，**既方便画图看，又尽量不丢信息**？

### 2. 直觉

想象一团数据点像一个**被拉长的椭圆云**，斜着躺在平面上。

- 沿着**长轴**方向，点分得最开（**方差最大**），携带的信息最多；
- 沿着**短轴**方向，点挤在一起，信息很少。

如果必须只保留一个方向，当然选**长轴**——这就是**第一主成分**。

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="PCA：散点形成一个斜着的椭圆云，第一主成分沿长轴，第二主成分垂直于它，把点投影到第一主成分上就完成了降维">
<line class="l" x1="40" y1="280" x2="400" y2="280" marker-end="url(#arr)"/>
<line class="l" x1="40" y1="280" x2="40" y2="30" marker-end="url(#arr)"/>
<ellipse class="bg" cx="220" cy="155" rx="150" ry="48" transform="rotate(-30 220 155)"/>
<circle class="b1" cx="120" cy="215" r="5"/>
<circle class="b1" cx="150" cy="205" r="5"/>
<circle class="b1" cx="170" cy="185" r="5"/>
<circle class="b1" cx="200" cy="175" r="5"/>
<circle class="b1" cx="215" cy="150" r="5"/>
<circle class="b1" cx="245" cy="140" r="5"/>
<circle class="b1" cx="270" cy="120" r="5"/>
<circle class="b1" cx="300" cy="105" r="5"/>
<circle class="b1" cx="190" cy="145" r="5"/>
<circle class="b1" cx="255" cy="165" r="5"/>
<line class="la" x1="220" y1="155" x2="330" y2="92" marker-end="url(#arr-a)"/>
<text class="ta" x="336" y="90" text-anchor="start">PC1（方差最大）</text>
<line class="l" x1="220" y1="155" x2="250" y2="205" marker-end="url(#arr)"/>
<text class="ts" x="256" y="214" text-anchor="start">PC2（垂直）</text>
<rect class="bg" x="440" y="40" width="280" height="240" rx="12"/>
<text class="th" x="456" y="64">PCA 的四步</text>
<text class="ts" x="456" y="92">1. 把每个特征“去均值”（让数据以原点为中心）</text>
<text class="ts" x="456" y="116">2. 计算协方差矩阵（特征两两怎么一起变化）</text>
<text class="ts" x="456" y="140">3. 求它的特征向量和特征值</text>
<text class="ts" x="456" y="164">4. 取特征值最大的前 k 个特征向量，</text>
<text class="ts" x="456" y="184">   把数据投影上去 → 降到 k 维</text>
<text class="ta" x="456" y="216">特征值 = 该方向上的“方差” = 信息量</text>
<text class="ts" x="456" y="240">累计占比达到 90%~95% 就够用了</text>
<text class="ts" x="456" y="262">（PCA 其实就是对去均值数据做 SVD）</text>
</svg>
<figcaption>图 3：PCA：找到数据云的长轴，把数据压到最重要的方向上</figcaption>
</figure>

### 3. 一个小例子

100 个特征降到 2 维：

```text
原始：每个样本 100 个数            →  PCA  →  每个样本 2 个数（PC1, PC2）
保留的信息：前两个特征值占总和的 78%     ← 可以画成二维散点图，看数据有没有“分簇”
```

### 4. 用在哪

| 用途 | 说明 |
| --- | --- |
| **可视化** | 把高维数据压到 2D/3D 画出来看 |
| **去噪、去冗余** | 丢掉小方差的方向（多半是噪声） |
| **加速训练** | 特征少了，模型更快 |
| **向量检索** | 压缩 embedding 的维度，省存储 |
| **预处理** | 去除特征间的相关性 |

> [!WARNING] PCA 的局限
> 它只看**线性**关系，且“方差大 ≠ 对任务有用”（有时重要信息恰恰在小方差方向）。非线性降维有 t-SNE、UMAP 等（常用来画 embedding 的可视化图）。

## 四、动手：NumPy 一把梭

```python
import numpy as np

A = np.array([[2, 1], [1, 2]])
vals, vecs = np.linalg.eig(A)
print(vals)        # [3. 1.]      特征值
print(vecs)        # 每一列是一个特征向量（已归一化），方向 (1,1) 与 (1,-1)

# SVD 与低秩近似
M = np.random.rand(100, 80)
U, S, Vt = np.linalg.svd(M, full_matrices=False)
k = 10
M_k = (U[:, :k] * S[:k]) @ Vt[:k]                    # 只保留前 10 个奇异值
print(np.linalg.norm(M - M_k) / np.linalg.norm(M))   # 近似误差

# PCA（用 scikit-learn）
from sklearn.decomposition import PCA
X = np.random.rand(500, 100)
pca = PCA(n_components=2).fit(X)
print(pca.explained_variance_ratio_)                 # 两个主成分各自解释的方差占比
```

## 五、和 AI 的联系一览

| 概念 | 在 AI 里的身影 |
| --- | --- |
| 特征值 > 1 / < 1 | 反复相乘导致的**梯度爆炸 / 消失** |
| SVD / 低秩 | **LoRA** 微调、模型压缩、推荐系统矩阵分解 |
| PCA | embedding 可视化、特征降维、去噪 |
| 协方差矩阵 | 数据“怎么一起变化”，也用于归一化和高斯模型 |

## 自测：你真的懂了吗？

> [!QUESTION] 特征向量是什么？用一句话讲给朋友听。
> 矩阵对空间变换时，大多数方向都会被拧歪，但有些特殊方向只会被拉长或缩短、不会转向，这些方向就是特征向量，拉伸的倍数就是特征值。

> [!QUESTION] 矩阵 A 的某个特征值是 0.5，反复乘 A 很多次，沿该方向的向量会怎样？
> 每次长度都乘 0.5，越来越小，趋近于 0（衰减/消失）。如果特征值是 2，则每次翻倍，数值会爆炸。

> [!QUESTION] SVD 为什么能用来压缩数据？
> 奇异值按大小排序，大的奇异值对应信息量大的方向，小的对应噪声或冗余。只保留前 k 个奇异值及对应的向量，就能用少得多的数字近似原矩阵。

> [!QUESTION] PCA 降维时，选前 k 个主成分的依据是什么？
> 看每个主成分对应的特征值（方差）占总方差的比例，累计到足够高（如 90%~95%）就够了；或根据可视化/加速的需要直接取 2~3 个。

> [!QUESTION] LoRA 为什么能省这么多参数？
> 它假设微调时权重的变化量是低秩的，用两个又瘦又高的小矩阵 B 和 A 相乘来表示 ΔW，参数量从 d×d 变成 2×d×r，r 远小于 d，所以训练的参数只有原来的几百分之一。
