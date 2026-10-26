---
level: 基础
tags: [线性代数, SVD, 奇异值, 低秩近似, 矩阵分解, 伪逆, 条件数, LoRA, 推荐系统, 图像压缩]
summary: 讲清 SVD 的“旋转-拉伸-旋转”几何与 2×2 手算，用 Eckart–Young 解释低秩近似为什么能压缩，并落到 PCA、推荐系统、LoRA、嵌入降维，最后补上伪逆与条件数。
---

# 奇异值分解（SVD）与低秩：压缩、推荐与 LoRA

> [!ABSTRACT] 一句话版本
> - **SVD**：**任何**矩阵（不必是方阵）都能写成 `A = UΣVᵀ`：先旋转、再沿坐标轴拉伸、再旋转。拉伸的倍数 `σ`（小写 sigma，奇异值）就是“单位圆被 A 变成的椭圆”的半轴长。
> - **和特征值的关系**：`σ²` 就是 `AᵀA` 的特征值。算 SVD，本质上是对对称矩阵 `AᵀA` 做上一页的特征分解。
> - **低秩近似**：只保留最大的 k 个奇异值，得到的是所有“秩 ≤ k 矩阵”里**离 A 最近**的一个（Eckart–Young 定理）。存储量从 `mn` 降到 `k(m+n+1)`。
> - **用途**：图像压缩、PCA、推荐系统的隐向量、**LoRA**（`ΔW = BA`）、嵌入降维。
> - **顺带**：伪逆 `A⁺ = VΣ⁺Uᵀ` 解最小二乘；条件数 `σmax/σmin` 衡量一个线性问题“有多敏感”。

> [!NOTE] 先决条件
> 本页建立在 [特征值与特征向量：PCA 与谱的直觉](#/math/eigen)（特征分解、对称矩阵）和 [矩阵：线性变换与矩阵乘法](#/math/matrices) 之上。速成版见 [线性代数 2：特征值、SVD 与 PCA](#/aimodel/math-la2)。

## 一、为什么需要 SVD

上一页的特征分解有三个限制：只对**方阵**成立；有些矩阵（比如旋转）没有实特征向量；矩阵不对称时，特征向量还不垂直。可是 AI 里的矩阵大多是**长方形**的：用户×电影的评分表是 5×4，一张图片是 100×100（刚好方），一批词向量是 10000×768。

**SVD 对任何形状的矩阵都成立**，而且永远给出实数、互相垂直的方向。你可以把它当成特征分解的“全能版”。

### 1. 旋转 → 拉伸 → 旋转

```text
A  =  U  ·  Σ  ·  Vᵀ
     旋转②  拉伸   旋转①
```

下面用本页要手算的矩阵 `A = [[2, 2], [−2, 1]]`（它的奇异值是 3 和 2）。看单位圆被 A 作用的过程，**所有坐标都是用 Python 算的**：

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="奇异值分解的三步：单位圆先被 V 转置旋转，再沿坐标轴拉伸成 3 和 2 的椭圆，最后被 U 旋转，得到 A 作用后的椭圆">
<text class="th" x="80" y="40" text-anchor="middle">① 单位圆</text>
<text class="th" x="250" y="40" text-anchor="middle">② Vᵀ：旋转</text>
<text class="th" x="430" y="40" text-anchor="middle">③ Σ：拉伸</text>
<text class="th" x="625" y="40" text-anchor="middle">④ U：再旋转</text>
<circle class="b1" cx="80" cy="135" r="26"/>
<circle class="b1" cx="250" cy="135" r="26"/>
<line class="la" x1="80" y1="135" x2="103.3" y2="123.4" marker-end="url(#arr-a)"/>
<line class="l" x1="80" y1="135" x2="68.4" y2="111.7" marker-end="url(#arr)"/>
<line class="la" x1="250" y1="135" x2="276" y2="135" marker-end="url(#arr-a)"/>
<line class="l" x1="250" y1="135" x2="250" y2="109" marker-end="url(#arr)"/>
<line class="l" x1="508" y1="135" x2="507" y2="126.9"/>
<line class="l" x1="507" y1="126.9" x2="504.2" y2="118.9"/>
<line class="l" x1="504.2" y1="118.9" x2="499.5" y2="111.4"/>
<line class="l" x1="499.5" y1="111.4" x2="493.1" y2="104.4"/>
<line class="l" x1="493.1" y1="104.4" x2="485.2" y2="98.2"/>
<line class="l" x1="485.2" y1="98.2" x2="475.8" y2="92.9"/>
<line class="l" x1="475.8" y1="92.9" x2="465.4" y2="88.7"/>
<line class="l" x1="465.4" y1="88.7" x2="454.1" y2="85.5"/>
<line class="l" x1="454.1" y1="85.5" x2="442.2" y2="83.6"/>
<line class="l" x1="442.2" y1="83.6" x2="430" y2="83"/>
<line class="l" x1="430" y1="83" x2="417.8" y2="83.6"/>
<line class="l" x1="417.8" y1="83.6" x2="405.9" y2="85.5"/>
<line class="l" x1="405.9" y1="85.5" x2="394.6" y2="88.7"/>
<line class="l" x1="394.6" y1="88.7" x2="384.2" y2="92.9"/>
<line class="l" x1="384.2" y1="92.9" x2="374.8" y2="98.2"/>
<line class="l" x1="374.8" y1="98.2" x2="366.9" y2="104.4"/>
<line class="l" x1="366.9" y1="104.4" x2="360.5" y2="111.4"/>
<line class="l" x1="360.5" y1="111.4" x2="355.8" y2="118.9"/>
<line class="l" x1="355.8" y1="118.9" x2="353" y2="126.9"/>
<line class="l" x1="353" y1="126.9" x2="352" y2="135"/>
<line class="l" x1="352" y1="135" x2="353" y2="143.1"/>
<line class="l" x1="353" y1="143.1" x2="355.8" y2="151.1"/>
<line class="l" x1="355.8" y1="151.1" x2="360.5" y2="158.6"/>
<line class="l" x1="360.5" y1="158.6" x2="366.9" y2="165.6"/>
<line class="l" x1="366.9" y1="165.6" x2="374.8" y2="171.8"/>
<line class="l" x1="374.8" y1="171.8" x2="384.2" y2="177.1"/>
<line class="l" x1="384.2" y1="177.1" x2="394.6" y2="181.3"/>
<line class="l" x1="394.6" y1="181.3" x2="405.9" y2="184.5"/>
<line class="l" x1="405.9" y1="184.5" x2="417.8" y2="186.4"/>
<line class="l" x1="417.8" y1="186.4" x2="430" y2="187"/>
<line class="l" x1="430" y1="187" x2="442.2" y2="186.4"/>
<line class="l" x1="442.2" y1="186.4" x2="454.1" y2="184.5"/>
<line class="l" x1="454.1" y1="184.5" x2="465.4" y2="181.3"/>
<line class="l" x1="465.4" y1="181.3" x2="475.8" y2="177.1"/>
<line class="l" x1="475.8" y1="177.1" x2="485.2" y2="171.8"/>
<line class="l" x1="485.2" y1="171.8" x2="493.1" y2="165.6"/>
<line class="l" x1="493.1" y1="165.6" x2="499.5" y2="158.6"/>
<line class="l" x1="499.5" y1="158.6" x2="504.2" y2="151.1"/>
<line class="l" x1="504.2" y1="151.1" x2="507" y2="143.1"/>
<line class="l" x1="507" y1="143.1" x2="508" y2="135"/>
<line class="la" x1="430" y1="135" x2="508" y2="135" marker-end="url(#arr-a)"/>
<line class="l" x1="430" y1="135" x2="430" y2="83" marker-end="url(#arr)"/>
<line class="l" x1="677" y1="187" x2="684.5" y2="182.3"/>
<line class="l" x1="684.5" y1="182.3" x2="690.5" y2="176.4"/>
<line class="l" x1="690.5" y1="176.4" x2="694.9" y2="169.5"/>
<line class="l" x1="694.9" y1="169.5" x2="697.6" y2="161.8"/>
<line class="l" x1="697.6" y1="161.8" x2="698.5" y2="153.4"/>
<line class="l" x1="698.5" y1="153.4" x2="697.6" y2="144.5"/>
<line class="l" x1="697.6" y1="144.5" x2="694.9" y2="135.4"/>
<line class="l" x1="694.9" y1="135.4" x2="690.5" y2="126.3"/>
<line class="l" x1="690.5" y1="126.3" x2="684.5" y2="117.5"/>
<line class="l" x1="684.5" y1="117.5" x2="677" y2="109"/>
<line class="l" x1="677" y1="109" x2="668.2" y2="101.2"/>
<line class="l" x1="668.2" y1="101.2" x2="658.4" y2="94.2"/>
<line class="l" x1="658.4" y1="94.2" x2="647.7" y2="88.2"/>
<line class="l" x1="647.7" y1="88.2" x2="636.5" y2="83.4"/>
<line class="l" x1="636.5" y1="83.4" x2="625" y2="79.8"/>
<line class="l" x1="625" y1="79.8" x2="613.5" y2="77.6"/>
<line class="l" x1="613.5" y1="77.6" x2="602.3" y2="76.9"/>
<line class="l" x1="602.3" y1="76.9" x2="591.6" y2="77.5"/>
<line class="l" x1="591.6" y1="77.5" x2="581.8" y2="79.6"/>
<line class="l" x1="581.8" y1="79.6" x2="573" y2="83"/>
<line class="l" x1="573" y1="83" x2="565.5" y2="87.7"/>
<line class="l" x1="565.5" y1="87.7" x2="559.5" y2="93.6"/>
<line class="l" x1="559.5" y1="93.6" x2="555.1" y2="100.5"/>
<line class="l" x1="555.1" y1="100.5" x2="552.4" y2="108.2"/>
<line class="l" x1="552.4" y1="108.2" x2="551.5" y2="116.6"/>
<line class="l" x1="551.5" y1="116.6" x2="552.4" y2="125.5"/>
<line class="l" x1="552.4" y1="125.5" x2="555.1" y2="134.6"/>
<line class="l" x1="555.1" y1="134.6" x2="559.5" y2="143.7"/>
<line class="l" x1="559.5" y1="143.7" x2="565.5" y2="152.5"/>
<line class="l" x1="565.5" y1="152.5" x2="573" y2="161"/>
<line class="l" x1="573" y1="161" x2="581.8" y2="168.8"/>
<line class="l" x1="581.8" y1="168.8" x2="591.6" y2="175.8"/>
<line class="l" x1="591.6" y1="175.8" x2="602.3" y2="181.8"/>
<line class="l" x1="602.3" y1="181.8" x2="613.5" y2="186.6"/>
<line class="l" x1="613.5" y1="186.6" x2="625" y2="190.2"/>
<line class="l" x1="625" y1="190.2" x2="636.5" y2="192.4"/>
<line class="l" x1="636.5" y1="192.4" x2="647.7" y2="193.1"/>
<line class="l" x1="647.7" y1="193.1" x2="658.4" y2="192.5"/>
<line class="l" x1="658.4" y1="192.5" x2="668.2" y2="190.4"/>
<line class="l" x1="668.2" y1="190.4" x2="677" y2="187"/>
<line class="la" x1="625" y1="135" x2="694.8" y2="169.9" marker-end="url(#arr-a)"/>
<line class="l" x1="625" y1="135" x2="648.3" y2="88.5" marker-end="url(#arr)"/>
<text class="tb" x="108.3" y="120.4">v₁</text>
<text class="tb" x="65.4" y="105.7" text-anchor="end">v₂</text>
<text class="tb" x="280" y="153">Vᵀv₁</text>
<text class="tb" x="255" y="105">Vᵀv₂</text>
<text class="tb" x="494" y="155" text-anchor="middle">σ₁ = 3</text>
<text class="tb" x="436" y="78">σ₂ = 2</text>
<text class="tb" x="694.8" y="187.9" text-anchor="middle">σ₁u₁</text>
<text class="tb" x="653.3" y="84.5">σ₂u₂</text>
<line class="la" x1="114" y1="135" x2="214" y2="135" marker-end="url(#arr-a)"/>
<text class="ta" x="164" y="127" text-anchor="middle">Vᵀ</text>
<line class="la" x1="286" y1="135" x2="346" y2="135" marker-end="url(#arr-a)"/>
<text class="ta" x="316" y="127" text-anchor="middle">Σ</text>
<line class="la" x1="518" y1="135" x2="543" y2="135" marker-end="url(#arr-a)"/>
<text class="ta" x="531" y="127" text-anchor="middle">U</text>
<text class="ts" x="80" y="226" text-anchor="middle">单位圆和两个特殊方向</text>
<text class="ts" x="250" y="226" text-anchor="middle">旋转：v₁ v₂ 落到坐标轴</text>
<text class="ts" x="430" y="226" text-anchor="middle">拉伸：横向 ×3，纵向 ×2</text>
<text class="ts" x="625" y="226" text-anchor="middle">再旋转：得到 A 的椭圆</text>
<text class="ta" x="360" y="258" text-anchor="middle">奇异值 σ₁ = 3、σ₂ = 2，就是最后这个椭圆的两个半轴长</text>
<text class="ts" x="360" y="282" text-anchor="middle">A = U Σ Vᵀ：图从左往右看，对应公式从右往左乘（先 Vᵀ，再 Σ，最后 U）</text>
</svg>
<figcaption>图 1：A = UΣVᵀ：旋转 → 拉伸 → 旋转，奇异值是椭圆的半轴长</figcaption>
</figure>

- **`Vᵀ`**：旋转（或翻转）。它把圆上的两个特殊方向 `v₁、v₂` 转到坐标轴上；圆转了还是圆；
- **`Σ`**：对角矩阵，沿坐标轴拉伸，横向 ×3、纵向 ×2。圆变成了正放的椭圆；
- **`U`**：再旋转一次，椭圆转到最终位置。

符号表：

| 符号 | 形状（A 是 m×n） | 叫法 | 性质 |
| --- | --- | --- | --- |
| `U` | m×m（“瘦版”m×r） | 左奇异向量 | 列互相垂直、长度为 1（`UᵀU = I`） |
| `Σ`（大写 sigma） | m×n（“瘦版”r×r） | 奇异值矩阵 | 只有对角线非零，`σ₁ ≥ σ₂ ≥ … ≥ 0` |
| `V` | n×n（“瘦版”n×r） | 右奇异向量 | 列互相垂直、长度为 1 |

“瘦版”里 `r = min(m, n)`（或矩阵的秩），实际计算几乎都用它，省内存。奇异值**永远是非负数**，并且习惯从大到小排。垂直、长度为 1 的矩阵（`QᵀQ = I`）只会旋转或翻转，**不改变长度和夹角**，所以“拉伸”全部由 Σ 负责。

### 2. 展开成“薄片之和”

把 `A = UΣVᵀ` 按列展开：

```text
A = σ₁·u₁v₁ᵀ + σ₂·u₂v₂ᵀ + … + σᵣ·uᵣvᵣᵀ
```

`u vᵀ`（一个列向量乘一个行向量，叫**外积**）是一个 m×n 的矩阵，而且**秩为 1**：每一行都是同一个行向量的倍数。例如：

```text
(1, 2, 3)ᵀ · (1, 0, 2, 1) = | 1  0  2  1 |
                            | 2  0  4  2 |      ← 第 2 行 = 2×第 1 行，第 3 行 = 3×第 1 行
                            | 3  0  6  3 |
```

12 个数只需要存 `3 + 4 = 7` 个数。SVD 就是把矩阵拆成按“重要程度”（σ）排序的秩 1 薄片，**第一片最重要**；和上一页谱分解 `S = Σ λ u uᵀ` 是同一个想法，只是这里适用于任何矩阵。

## 二、手算一个 2×2 的 SVD

对 `A = [[2, 2], [−2, 1]]`，目标是找到 `σ、u、v`。思路：**先用 `AᵀA` 找出 v 和 σ，再用 `u = Av/σ` 找出 u**。

**为什么是 AᵀA？** 把 `A = UΣVᵀ` 代进去（`UᵀU = I`）：

```text
AᵀA = (VΣUᵀ)(UΣVᵀ) = V Σ² Vᵀ
```

这正是对称矩阵 `AᵀA` 的谱分解：**特征向量是 V 的列，特征值是 `σ²`**。

**第 1 步：算 AᵀA**

```text
Aᵀ = |  2  −2 |        AᵀA = |  2  −2 |·| 2  2 | = | 4+4   4−2 | = | 8  2 |
     |  2   1 |              |  2   1 | |−2  1 |   | 4−2   4+1 |   | 2  5 |
```

**第 2 步：对 AᵀA 求特征值和特征向量**（上一页的方法）

```text
det = (8−λ)(5−λ) − 4 = λ² − 13λ + 36 = (λ − 9)(λ − 4)      → λ = 9, 4
σ₁ = √9 = 3，  σ₂ = √4 = 2                                  （核对：σ₁σ₂ = 6 = |det A| = |2×1 − 2×(−2)|）

λ = 9：(AᵀA − 9I) = [[−1, 2], [2, −4]] → x = 2y   → v₁ = (2, 1)/√5
λ = 4：(AᵀA − 4I) = [[ 4, 2], [2,  1]] → y = −2x  → v₂ = (−1, 2)/√5
```

**第 3 步：`u = Av/σ`**。理由：`A v₁ = σ₁ u₁`，即圆上的 v₁ 被送到椭圆的轴端点，长度恰好是 σ₁。

```text
A v₁ = (2×2+2×1, −2×2+1×1)/√5 = (6, −3)/√5   →  u₁ = (6, −3)/(3√5) = (2, −1)/√5
A v₂ = (2×(−1)+2×2, −2×(−1)+1×2)/√5 = (2, 4)/√5  →  u₂ = (2, 4)/(2√5) = (1, 2)/√5
```

**第 4 步：核对**，把两片加起来应该还原 A：

```text
3·u₁v₁ᵀ = 3·(1/5)·| 4   2 | = | 12/5   6/5 |      2·u₂v₂ᵀ = 2·(1/5)·| −1  2 | = | −2/5   4/5 |
                   | −2 −1 |   | −6/5  −3/5 |                         | −2  4 |   | −4/5   8/5 |

和 = | 10/5  10/5 | = |  2  2 | = A  ✓
     | −10/5  5/5 |   | −2  1 |
```

```python
import numpy as np

A = np.array([[2., 2.], [-2., 1.]])
U, S, Vt = np.linalg.svd(A)                  # 注意：返回的是 Vt（V 的转置），不是 V
print(S)                                     # [3. 2.]
print(np.allclose(U @ np.diag(S) @ Vt, A))   # True
print(np.linalg.eigvalsh(A.T @ A))           # [4. 9.]   开方就是奇异值 2、3
print(U.round(3)); print(Vt.round(3))
# [[-0.894  0.447]      u₁ = (−0.894, 0.447)，和手算的 (2,−1)/√5 差一个负号
#  [ 0.447  0.894]]     v₁、u₁ 同时取负号，乘出来的 A 不变
# [[-0.894 -0.447]
#  [-0.447  0.894]]
```

> [!WARNING] 三个常见坑
> - `np.linalg.svd` 返回的第三项是 **`Vt`（已经转置）**，不要再转一次；`Vt` 的**每一行**才是一个右奇异向量。
> - 每一对 `(uᵢ, vᵢ)` 可以**同时变号**而 A 不变，所以不同软件给出的正负号可能不同，不是错误。
> - 奇异值和特征值不是一回事：对一般方阵，`σ ≠ |λ|`（本例 A 的特征值是复数 `1.5 ± 1.94i`，但奇异值是 3 和 2）。只有对称半正定矩阵，两者才相等。

## 三、低秩近似：只留“大头”

### 1. Eckart–Young：留前 k 项就是最好的

把薄片之和**只保留前 k 项**：

```text
A_k = σ₁·u₁v₁ᵀ + … + σₖ·uₖvₖᵀ          （秩 ≤ k 的矩阵）
```

**Eckart–Young 定理**（认识即可，不证明）：在**所有秩不超过 k 的矩阵**里，`A_k` 离 A 最近，而且误差恰好由被丢掉的奇异值决定：

```text
‖A − A_k‖（Frobenius 范数）² = σ_{k+1}² + σ_{k+2}² + …        其中 ‖M‖ 是把所有元素平方求和再开方
```

手算验证：对 `A = [[2,2],[−2,1]]` 取 `k = 1`：

```text
A₁ = 3·u₁v₁ᵀ = | 12/5   6/5 | = |  2.4   1.2 |
               | −6/5  −3/5 |   | −1.2  −0.6 |

A − A₁ = | −0.4   0.8 |   平方和 = 0.16 + 0.64 + 0.64 + 2.56 = 4.0   →  ‖A − A₁‖ = 2 = σ₂ ✓
         | −0.8   1.6 |
```

也就是说，任何一个秩 1 的 2×2 矩阵，和 A 的距离都**不可能小于 2**。上面 Python 里的最后两行就是这个验证（输出 `[[ 2.4  1.2] [-1.2 -0.6]]` 和 `2.0`）。

> [!NOTE] “信息量”怎么量
> 常把 `σᵢ²` 当成第 i 个方向携带的“能量”。保留的能量占比 = `(σ₁² + … + σₖ²) / (σ₁² + … + σᵣ²)`，相对误差² = 1 − 能量占比。这和上一页 PCA 里“特征值占总方差的比例”是一回事：PCA 的特征值就是 `σ²/(n−1)`。

### 2. 压缩：存储量算一笔账

A 是 m×n，直接存要 `m×n` 个数。只存前 k 片（`k` 个 σ，`k` 个长 m 的 u，`k` 个长 n 的 v）：

```text
存储：k + k·m + k·n = k(m + n + 1)

1000×1000 的图，k = 50：  mn = 1,000,000     k(m+n+1) = 50 × 2001 = 100,050     ≈ 10%
```

取一张 100×100 的合成灰度图（一个平滑光斑 + 斜纹 + 软边，完全用公式生成），看看不同 k 的效果：

<figure class="fig">
<svg viewBox="0 0 720 304" class="dg" role="img" aria-label="左：合成图的奇异值，前三个很大后面迅速衰减；右：保留前 k 个奇异值所占的能量比例，k=3 时已达 98.8%">
<text class="th" x="40" y="28">奇异值 σᵢ（100×100 合成灰度图）</text>
<line class="l" x1="40" y1="240" x2="350" y2="240"/>
<rect class="b1" x="52" y="87.3" width="22" height="152.7"/>
<text class="ts" x="63" y="256" text-anchor="middle">1</text>
<text class="ts" x="63" y="81.3" text-anchor="middle">63.6</text>
<rect class="b1" x="82" y="203.6" width="22" height="36.4"/>
<text class="ts" x="93" y="256" text-anchor="middle">2</text>
<text class="ts" x="93" y="197.6" text-anchor="middle">15.2</text>
<rect class="b1" x="112" y="204.3" width="22" height="35.7"/>
<text class="ts" x="123" y="256" text-anchor="middle">3</text>
<text class="ts" x="123" y="198.3" text-anchor="middle">14.9</text>
<rect class="b1" x="142" y="226.2" width="22" height="13.8"/>
<text class="ts" x="153" y="256" text-anchor="middle">4</text>
<text class="ts" x="153" y="220.2" text-anchor="middle">5.8</text>
<rect class="b1" x="172" y="230.8" width="22" height="9.2"/>
<text class="ts" x="183" y="256" text-anchor="middle">5</text>
<text class="ts" x="183" y="224.8" text-anchor="middle">3.8</text>
<rect class="b1" x="202" y="234.8" width="22" height="5.2"/>
<text class="ts" x="213" y="256" text-anchor="middle">6</text>
<rect class="b1" x="232" y="236.8" width="22" height="3.2"/>
<text class="ts" x="243" y="256" text-anchor="middle">7</text>
<rect class="b1" x="262" y="238.3" width="22" height="1.7"/>
<text class="ts" x="273" y="256" text-anchor="middle">8</text>
<rect class="b1" x="292" y="239" width="22" height="1"/>
<text class="ts" x="303" y="256" text-anchor="middle">9</text>
<rect class="b1" x="322" y="239.6" width="22" height="0.4"/>
<text class="ts" x="333" y="256" text-anchor="middle">10</text>
<text class="ts" x="345" y="272" text-anchor="end">i</text>
<text class="ts" x="40" y="290" text-anchor="start">头 3 个奇异值撑起了几乎全部内容，其余迅速衰减</text>
<text class="th" x="400" y="28">前 k 项保留的“能量”占比 Σσᵢ² / 总和</text>
<line class="l" x1="420" y1="240" x2="706" y2="240"/>
<line class="l" x1="420" y1="240" x2="420" y2="58"/>
<line class="ld" x1="420" y1="70" x2="706" y2="70"/>
<text class="ts" x="414" y="74" text-anchor="end">100%</text>
<text class="ts" x="414" y="244" text-anchor="end">0</text>
<line class="la" x1="420" y1="240" x2="446" y2="88.9"/>
<line class="la" x1="446" y1="88.9" x2="472" y2="80.3"/>
<line class="la" x1="472" y1="80.3" x2="498" y2="72.1"/>
<line class="la" x1="498" y1="72.1" x2="524" y2="70.8"/>
<line class="la" x1="524" y1="70.8" x2="550" y2="70.3"/>
<line class="la" x1="550" y1="70.3" x2="576" y2="70.1"/>
<line class="la" x1="576" y1="70.1" x2="602" y2="70"/>
<line class="la" x1="602" y1="70" x2="628" y2="70"/>
<line class="la" x1="628" y1="70" x2="654" y2="70"/>
<line class="la" x1="654" y1="70" x2="680" y2="70"/>
<circle class="b3" cx="420" cy="240" r="3.5"/>
<circle class="b3" cx="446" cy="88.9" r="3.5"/>
<circle class="b3" cx="472" cy="80.3" r="3.5"/>
<circle class="b3" cx="498" cy="72.1" r="3.5"/>
<circle class="b3" cx="524" cy="70.8" r="3.5"/>
<circle class="b3" cx="550" cy="70.3" r="3.5"/>
<circle class="b3" cx="576" cy="70.1" r="3.5"/>
<circle class="b3" cx="602" cy="70" r="3.5"/>
<circle class="b3" cx="628" cy="70" r="3.5"/>
<circle class="b3" cx="654" cy="70" r="3.5"/>
<circle class="b3" cx="680" cy="70" r="3.5"/>
<text class="ts" x="420" y="256" text-anchor="middle">0</text>
<text class="ts" x="472" y="256" text-anchor="middle">2</text>
<text class="ts" x="524" y="256" text-anchor="middle">4</text>
<text class="ts" x="576" y="256" text-anchor="middle">6</text>
<text class="ts" x="628" y="256" text-anchor="middle">8</text>
<text class="ts" x="680" y="256" text-anchor="middle">10</text>
<text class="ts" x="706" y="272" text-anchor="end">k</text>
<text class="tb" x="456" y="114.9">k=1：88.9%</text>
<text class="tb" x="504" y="144.1">k=3：98.8%</text>
<text class="ts" x="400" y="290" text-anchor="start">误差² = 1 − 能量占比：k = 3 时相对误差 √0.012 ≈ 11%</text>
</svg>
<figcaption>图 2：奇异值衰减得越快，低秩近似越划算</figcaption>
</figure>

```python
import numpy as np

x = np.linspace(0, 1, 100)
X, Y = np.meshgrid(x, x)
M = np.exp(-((X-.5)**2 + (Y-.5)**2)/.1) + .5/(1+np.exp(-15*(X-Y))) + .3*np.sin(8*np.pi*(X+Y))
U, S, Vt = np.linalg.svd(M, full_matrices=False)
print(S[:5].round(2))                        # [63.61 15.18 14.85  5.77  3.83]
for k in [1, 2, 3, 5, 10, 20]:
    Mk = (U[:, :k] * S[:k]) @ Vt[:k]         # 前 k 片之和
    err = np.linalg.norm(M - Mk) / np.linalg.norm(M)
    print(k, k*(100+100+1), f"{err:.4%}")
# 1 201 33.3423%    存 201 个数（原来 10000 个），相对误差 33%
# 2 402 24.6137%
# 3 603 11.0039%
# 5 1005 3.9785%    存 10%，误差 4%
# 10 2010 0.0717%   存 20%，几乎无损
# 20 4020 0.0002%
```

> [!WARNING] 不是所有矩阵都能压
> 压缩得动，是因为**奇异值衰减得快**，这张图很“平滑”。随机噪声矩阵的奇异值几乎一样大：把 100×100 的随机正态矩阵压到 k=10，相对误差仍有 `0.83`，几乎没压缩。真实照片有锐利的边缘和纹理，需要的 k 也比这里大得多。

## 四、SVD 在 AI 里的五个身影

### 1. PCA 的 SVD 实现

对去均值后的数据矩阵 `Xc = UΣVᵀ`，协方差 `XcᵀXc/(n−1) = V·(Σ²/(n−1))·Vᵀ`。所以：**V 的列就是主成分方向，`σ²/(n−1)` 就是方差，`UΣ` 就是投影得分**。用上一页那 5 个点验证：`Xc` 的奇异值是 `(4.690, 1.414)`，`σ²/(n−1) = (22/4, 2/4) = (5.5, 0.5)`，和手算的特征值一致；`UΣ` 的第一列是 `(−2.236, −1.789, −0.447, 0.894, 3.578)`，正是 PC1 的得分。许多实现（如 scikit-learn 的 PCA）用 SVD 而不是显式算 `XcᵀXc`，因为后者把条件数平方了，精度更差。

### 2. 推荐系统：隐向量

一张 5 个用户×4 部电影的评分表（前两部科幻、后两部爱情）：

```python
import numpy as np
R = np.array([[5, 5, 1, 1], [4, 5, 1, 2], [1, 1, 5, 4], [2, 1, 4, 5], [3, 3, 3, 3.]])
U, S, Vt = np.linalg.svd(R)
print(S.round(2))                  # [13.21  6.83  1.15  0.73]   两个大，两个小
print((U[:, :2] * S[:2]).round(2)) # 每个用户的 2 维“隐向量”
# [[-6.14  3.74]      用户 1（爱看科幻）
#  [-6.13  2.85]      用户 2（爱看科幻）
#  [-5.34 -3.73]      用户 3（爱看爱情）
#  [-5.9  -3.24]      用户 4（爱看爱情）
#  [-5.99 -0.23]]     用户 5（都一般）
print(Vt[:2].round(2))             # 每部电影的 2 维隐向量
# [[-0.52 -0.52 -0.46 -0.5 ]      第 1 维：整体打分高低
#  [ 0.41  0.54 -0.55 -0.48]]     第 2 维：科幻(+) ↔ 爱情(−)
```

只有两个奇异值显著，说明评分表背后只有**两个“口味因子”**：第 1 维是整体打分习惯，第 2 维是“科幻 ↔ 爱情”轴，用户在第 2 维的坐标一目了然。**用户向量·电影向量 ≈ 预测评分**，这就是推荐系统“矩阵分解”的核心。

> [!NOTE] 真实推荐系统多一步
> 真实评分表绝大部分是空的，普通 SVD 无法处理“缺失值”。实际做法是只对**已知评分**最小化误差来学这两组隐向量（ALS、SGD 等，也叫矩阵分解），思想和 SVD 一致：用低秩去解释评分。

### 3. 潜在语义分析（LSA）

“词 × 文档”的计数矩阵做 SVD，保留前 k 个奇异值，得到每个词、每篇文档的 k 维向量。“汽车”和“轿车”不一定同时出现，但常和同一批词一起出现，在低秩空间里就会靠得很近。这是词向量、嵌入的早期原型，认识即可。

### 4. LoRA：用低秩去“微调”大模型

大模型里一个权重矩阵 `W` 是 `d×d`（如 d = 4096）。全量微调要更新全部 `d²` 个参数；LoRA 的假设是：**微调带来的变化 ΔW 近似是低秩的**，所以不直接学 ΔW，而是学两个又瘦又扁的矩阵：

```text
ΔW = B · A       B 是 d×r，A 是 r×d，r 很小（如 8）
前向：h = W x + B (A x)        W 冻结，只训练 A 和 B
```

<figure class="fig">
<svg viewBox="0 0 720 292" class="dg" role="img" aria-label="LoRA 的结构：输入同时走冻结的大矩阵 W 和由 A、B 两个小矩阵组成的低秩旁路，两路输出相加">
<text class="th" x="20" y="28">LoRA：冻结 W，旁边加一条低秩支路（d = 4096，r = 8）</text>
<rect class="b1" x="20" y="120" width="70" height="44" rx="8"/>
<text class="tb" x="55" y="142" text-anchor="middle" dominant-baseline="middle">x</text>
<rect class="b" x="170" y="58" width="220" height="56" rx="8"/>
<text class="tb" x="280" y="76" text-anchor="middle" dominant-baseline="middle">W（冻结，不训练）</text>
<text class="ts" x="280" y="98" text-anchor="middle" dominant-baseline="middle">d×d = 16,777,216 个参数</text>
<rect class="b3" x="170" y="180" width="96" height="56" rx="8"/>
<text class="tb" x="218" y="198" text-anchor="middle" dominant-baseline="middle">A（r×d）</text>
<text class="ts" x="218" y="220" text-anchor="middle" dominant-baseline="middle">8×4096，可训练</text>
<rect class="b3" x="304" y="180" width="96" height="56" rx="8"/>
<text class="tb" x="352" y="198" text-anchor="middle" dominant-baseline="middle">B（d×r）</text>
<text class="ts" x="352" y="220" text-anchor="middle" dominant-baseline="middle">4096×8，可训练</text>
<line class="l" x1="90" y1="138" x2="170" y2="94" marker-end="url(#arr)"/>
<line class="l" x1="90" y1="148" x2="170" y2="206" marker-end="url(#arr)"/>
<line class="l" x1="266" y1="208" x2="304" y2="208" marker-end="url(#arr)"/>
<text class="ts" x="285" y="174" text-anchor="middle">r=8 维</text>
<circle class="b5" cx="480" cy="142" r="14"/>
<text class="tb" x="480" y="142" text-anchor="middle" dominant-baseline="middle">＋</text>
<line class="l" x1="390" y1="90" x2="470" y2="134" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="208" x2="472" y2="152" marker-end="url(#arr)"/>
<line class="l" x1="494" y1="142" x2="560" y2="142" marker-end="url(#arr)"/>
<rect class="b2" x="562" y="120" width="140" height="44" rx="8"/>
<text class="tb" x="632" y="142" text-anchor="middle" dominant-baseline="middle">h = Wx + B(Ax)</text>
<rect class="bg" x="440" y="196" width="262" height="76" rx="10"/>
<text class="ts" x="454" y="218">可训练：A + B = 2×4096×8 = 65,536</text>
<text class="ts" x="454" y="238">只有 W 的 65,536/16,777,216 = 1/256</text>
<text class="ta" x="454" y="260">B 初始化为 0：训练一开始 ΔW = 0</text>
<text class="ts" x="20" y="268" text-anchor="start">ΔW = B·A 的秩 ≤ 8（图中方块大小不按比例）</text>
</svg>
<figcaption>图 3：LoRA：用 ΔW = BA 代替 d×d 的更新，可训练参数只有 1/256</figcaption>
</figure>

手算参数量（d = 4096，r = 8）：

```text
全量更新一个矩阵：4096 × 4096        = 16,777,216
LoRA：            2 × 4096 × 8        =     65,536       → 16,777,216 ÷ 65,536 = 256 倍
一个 32 层模型，每层给 Wq、Wv 两个矩阵加 LoRA：  2 × 32 × 65,536 = 4,194,304 ≈ 420 万
同样两个矩阵全量更新：                           2 × 32 × 16,777,216 ≈ 10.7 亿
```

```python
import numpy as np
d, r = 4096, 8
print(d*d, 2*d*r, d*d // (2*d*r))          # 16777216 65536 256
rng = np.random.default_rng(0)
W = rng.standard_normal((d, d)).astype(np.float32) * 0.02
A = rng.standard_normal((r, d)).astype(np.float32) * 0.01
B = np.zeros((d, r), np.float32)           # B 初始为 0：训练开始时 ΔW = 0，模型行为和原来完全一样
x = rng.standard_normal(d).astype(np.float32)
h = W @ x + B @ (A @ x)                    # 先把 x 压成 r 维，再放大回 d 维
print(np.allclose(h, W @ x))               # True
```

计算上也更省：`B(Ax)` 只要 `2·d·r` 次乘加，而不是 `d²`。注意这是一个**经验假设**，不是定理：任务很复杂时 r 太小会学不会，所以 r 是要调的超参数，详见 [微调实战：数据、LoRA/QLoRA、偏好对齐与评估](#/ai/finetune) 和 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)。

### 5. 嵌入压缩

向量库里 1000 万条 1024 维 float32 向量：`10,000,000 × 1024 × 4 字节 ≈ 41 GB`。想省空间有三条路：① 用 PCA/SVD 降到 256 维，约 10 GB（对库和查询用**同一个**投影矩阵 `V_k`，它本身只有 1024×256）；② 训练时就支持截断的 Matryoshka 嵌入，直接取前 256 维；③ 量化（SQ8、PQ）降低每个数的字节数。三者可以叠加，代价都是召回略降，细节见 [RAG 向量检索逻辑](#/ai/rag-vector)。

## 五、伪逆与条件数

### 1. 伪逆：不可逆矩阵也有“最接近的逆”

可逆方阵的逆是 `A⁻¹ = VΣ⁻¹Uᵀ`（把拉伸倒过来，旋转转回去）。如果有奇异值是 0（矩阵压扁了、不可逆），就把 Σ 里**非零**的 σ 取倒数，零的仍然留 0，得到**伪逆**：

```text
A⁺ = V Σ⁺ Uᵀ
```

手算 `B = [[1, 1], [1, 1]]`（秩 1）：它的奇异值是 `σ₁ = 2`、`σ₂ = 0`，`u₁ = v₁ = (1, 1)/√2`。

```text
B⁺ = (1/σ₁)·v₁u₁ᵀ = (1/2) · (1/2)·| 1 1 | = | 0.25  0.25 |
                                    | 1 1 |   | 0.25  0.25 |
```

用它解方程 `B x = b`（`b = (2, 4)`，没有精确解，因为两个方程互相矛盾）：`x = B⁺b = 0.25 × 6 × (1, 1) = (1.5, 1.5)`。`B x = (3, 3)`，正是 b 在 B 的列空间上的**投影**（见 [正交与投影：最小二乘与线性回归](#/math/projection)）；而且在所有“同样好”的解 `(a, b)`（满足 `a + b = 3`）里，它是**长度最小**的一个。所以 **`x = A⁺b` 给出最小二乘解（多解时取最短的）**，`np.linalg.lstsq` 内部就是这个思路。

### 2. 条件数：解方程有多“抖”

```text
条件数 κ = σmax / σmin
```

σmin 很小，意味着有个方向几乎被压扁，反过来解方程时要把这个方向放大很多倍，**输入里一点点误差就会被放大成输出的大误差**。例：

```python
import numpy as np
C = np.array([[1., 1.], [1., 1.0001]])
print(np.linalg.cond(C).round(0))                          # 40002.0
print(np.linalg.solve(C, [2, 2.0001]).round(3),            # [1. 1.]
      np.linalg.solve(C, [2, 2.0002]).round(3))            # [0. 2.]
```

右边的 b 只改了万分之一，解却从 `(1, 1)` 跳成了 `(0, 2)`。粗略规则：**条件数约 10ᵏ，结果会损失 k 位有效数字**。神经网络里同样的道理：权重矩阵或 Hessian 的条件数很大，训练就慢而且不稳（上一页的 `λmax/λmin` 是它的对称矩阵版本），这也是归一化、预条件、谨慎使用 `np.linalg.inv` 的原因。

## 六、动手：一套完整的 NumPy 流程

```python
import numpy as np

M = np.random.default_rng(1).standard_normal((50, 30))
U, S, Vt = np.linalg.svd(M, full_matrices=False)      # 瘦版：U (50,30)  S (30,)  Vt (30,30)
print(U.shape, S.shape, Vt.shape)                    # (50, 30) (30,) (30, 30)

k = 5
Mk = (U[:, :k] * S[:k]) @ Vt[:k]                      # 秩 k 近似（U[:, :k] * S[:k] 就是 U_k·Σ_k）
print(np.linalg.matrix_rank(Mk))                      # 5
print(np.isclose(np.linalg.norm(M - Mk), np.sqrt((S[k:] ** 2).sum())))   # True：Eckart–Young 的误差公式
print(np.linalg.cond(M).round(2), (S[0] / S[-1]).round(2))               # 5.75 5.75：条件数 = σmax/σmin
print(np.allclose(np.linalg.pinv(M), Vt.T @ np.diag(1 / S) @ U.T))       # True：伪逆 = VΣ⁺Uᵀ
```

## 七、对照表

| 概念 | 一句话 | AI 里的身影 |
| --- | --- | --- |
| `A = UΣVᵀ` | 旋转→拉伸→旋转，对任意矩阵都成立 | 一切矩阵分析的基础工具 |
| 奇异值 σ | 椭圆的半轴；`σ²` = `AᵀA` 的特征值 | 方向的“信息量”、权重谱的诊断 |
| 低秩近似 `A_k` | 保留前 k 片，最好的秩 k 近似 | 图像压缩、模型压缩、嵌入降维 |
| 存储 `k(m+n+1)` | 用 k 片代替 mn 个数 | LoRA：`2dr` vs `d²` |
| `UΣ`、`V` | 得分 / 主成分方向 | PCA、潜在语义分析 |
| 隐向量 | 用户、物品各一个 k 维向量，点积 ≈ 评分 | 推荐系统矩阵分解 |
| 伪逆 `A⁺` | 不可逆矩阵的“最接近的逆” | 最小二乘、线性回归的数值解 |
| 条件数 `σmax/σmin` | 问题对误差的放大倍数 | 数值稳定性、优化难度 |

## 自测：你真的懂了吗？

> [!QUESTION] 矩阵 `A = [[3, 0], [0, 2]]` 的奇异值和特征值分别是多少？对 `[[0, 3], [0, 0]]` 呢？
> 第一个是对角矩阵：奇异值和特征值都是 3、2。第二个 `AᵀA = [[0,0],[0,9]]`，特征值 `0, 9`，所以奇异值是 `3, 0`；但它的特征值是 `0, 0`（上三角矩阵，对角线是 0）。可见一般矩阵的奇异值和特征值**不相等**。

> [!QUESTION] 一张 2000×3000 的灰度图做 SVD，保留 k = 100，存储量是多少？压缩到原来的几分之几？
> 原来 `2000×3000 = 6,000,000`；现在 `100×(2000+3000+1) = 500,100`，约为原来的 `8.3%`（约 1/12）。

> [!QUESTION] 为什么 LoRA 的 `B` 要初始化成全 0，而 `A` 用随机小数？
> `ΔW = BA`。B = 0 使训练开始时 `ΔW = 0`，模型输出和原始预训练模型完全一样，不会一上来就被破坏。A 不能也是 0，否则 B 和 A 的梯度都是 0（B 的梯度依赖 A，A 的梯度依赖 B），永远学不动；A 随机后，B 一旦有了梯度就能开始更新。

> [!QUESTION] 对一个 `d×d` 的权重做 `r = 16` 的 LoRA，`d = 4096`，可训练参数是多少？占原矩阵的多少？
> `2×4096×16 = 131,072`，占 `131,072 / 16,777,216 = 1/128 ≈ 0.78%`。r 翻倍，参数和比例也翻倍。

> [!QUESTION] 矩阵的奇异值是 `10, 5, 0.1, 0.01`，条件数是多少？留前 2 个奇异值，相对误差大约多少？
> 条件数 `10/0.01 = 1000`。误差² = `(0.1² + 0.01²)/(10² + 5² + 0.1² + 0.01²) = 0.0101/125.0101 ≈ 8.1×10⁻⁵`，相对误差 ≈ `0.9%`。

> [!QUESTION] 用一句话讲清 PCA 和 SVD 的关系。
> 对去均值数据矩阵 Xc 做 SVD：右奇异向量 V 的列就是主成分方向，`σ²/(n−1)` 是各主成分的方差，`UΣ` 是投影得分；PCA 本质上就是对去均值数据做 SVD。

## 相关阅读

- 上一页：[特征值与特征向量：PCA 与谱的直觉](#/math/eigen)
- 下一页：[张量、广播与 einsum：把数学写成代码](#/math/tensors)
- 速成版：[线性代数 2：特征值、SVD 与 PCA](#/aimodel/math-la2)
- LoRA 实战：[微调实战：数据、LoRA/QLoRA、偏好对齐与评估](#/ai/finetune)
- 嵌入与量化：[RAG 向量检索逻辑](#/ai/rag-vector)
- 综合练习：[数学到 AI 的对照地图与综合练习](#/math/ai-map)
