---
level: 基础
tags: [线性代数, 正交, 投影, 最小二乘, 线性回归, 正规方程, 岭回归, QR, 入门]
summary: 从“点到直线的最近点是垂足”讲起，推出向量与子空间上的投影，用“残差垂直于列空间”导出最小二乘的正规方程，手算四点直线拟合，并联系梯度下降、岭回归和 Gram-Schmidt/QR。
---

# 正交与投影：最小二乘与线性回归

> [!ABSTRACT] 一句话版本
> - **正交**就是点积为 0，也就是互相垂直。一组互相垂直的单位向量（标准正交基）让“求坐标”只需要做点积。
> - **投影**：把向量垂直“压”到直线或平面上，得到那里离它**最近**的点；剩下的**残差**必然垂直于那条线或平面。
> - **最小二乘**：当 `Ax = b` 无解（数据有噪声，方程多于未知数）时，退而求其次，找离 b 最近的 `Ax`，也就是把 b 投影到 A 的列空间上。
> - 残差垂直于列空间，直接推出**正规方程** `AᵀAx = Aᵀb`。**线性回归就是最小二乘**，梯度下降和正规方程是走向同一个答案的两条路。
> - **岭回归**给 `AᵀA` 加上 `λI`，让病态问题变稳；**QR 分解**用正交化避开 `AᵀA`，数值上更可靠。

## 先抛一个问题

上一页说过：样本比权重多时，`Xw = y` 一般**无解**（数据有噪声，不可能每个点都落在一条直线上）。可是我们照样每天都在拟合直线。无解的方程，凭什么还能求出“最好的 w”？

回答只需要一个几何事实：**从一个点到一条直线，最近的位置是垂足**。把“点”换成“数据向量 b”、把“直线”换成“A 的列能拼出的全部结果”，这就是最小二乘。

## 一、正交与标准正交基

两个向量点积为 0，就说它们**正交**（orthogonal），几何上就是垂直。一组向量两两正交、而且每个长度都是 1，叫**标准正交基**（orthonormal basis）。比如 `q₁ = (0.6, 0.8)`、`q₂ = (−0.8, 0.6)`：

```text
q₁·q₂ = 0.6×(−0.8) + 0.8×0.6 = 0          垂直
‖q₁‖ = √(0.36+0.64) = 1，‖q₂‖ = 1          长度为 1
```

**好处：求坐标不用解方程，做点积就行。** 想知道 `x = (2, 1)` 在这组基下的坐标：

```text
c₁ = q₁·x = 0.6×2 + 0.8×1 = 2.0
c₂ = q₂·x = (−0.8)×2 + 0.6×1 = −1.0
验证：2·q₁ − 1·q₂ = (1.2+0.8, 1.6−0.6) = (2, 1) ✓
```

原因：因为基向量两两垂直，`qᵢ·qⱼ = 0`（`i ≠ j`），把 `x = c₁q₁ + c₂q₂` 两边点乘 `q₁`，只剩 `c₁ = q₁·x`。如果基不正交，就得解一个方程组。这是后面 QR、PCA、SVD 都喜欢标准正交基的原因。

## 二、向量在向量上的投影

问题：已知 a 和 b，要在 b 所在的直线上找一个点 p，使它离 a 最近。结论是**垂足**，并且

```text
p = (a·b ÷ b·b) × b            误差 e = a − p，并且 e ⊥ b
```

推导很短：p 在 b 的直线上，所以 `p = c·b`（c 是某个数）。要求 `e = a − c·b` 垂直于 b，即 `(a − c·b)·b = 0`，得 `a·b − c·b·b = 0`，`c = a·b ÷ b·b`。

**手算**：`a = (2, 2)`，`b = (3, 1)`：

```text
a·b = 6 + 2 = 8，  b·b = 9 + 1 = 10，  c = 0.8
p = 0.8 × (3, 1) = (2.4, 0.8)
e = a − p = (−0.4, 1.2)，  e·b = −0.4×3 + 1.2×1 = 0   ✓ 垂直
```

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="把 a 垂直投影到 b 所在的直线上，落点 p 是这条直线上离 a 最近的点，误差 e 与 b 垂直">
<line class="l" x1="50" y1="260" x2="330" y2="260" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="260" x2="50" y2="30" marker-end="url(#arr)"/>
<line class="ld" x1="50" y1="260" x2="326" y2="168"/>
<line class="l" x1="50" y1="260" x2="230" y2="200" marker-end="url(#arr)"/>
<text class="tb" x="238" y="214" text-anchor="start">b = (3, 1)</text>
<line class="l" x1="50" y1="260" x2="170" y2="140" marker-end="url(#arr)"/>
<text class="tb" x="162" y="134" text-anchor="end">a = (2, 2)</text>
<line class="la" x1="50" y1="260" x2="194" y2="212" marker-end="url(#arr-a)"/>
<text class="ta" x="198" y="236" text-anchor="start">p = (2.4, 0.8)</text>
<line class="ld" x1="170" y1="140" x2="194" y2="212"/>
<line class="l" x1="202.5" y1="209.2" x2="199.7" y2="200.6"/>
<line class="l" x1="199.7" y1="200.6" x2="191.2" y2="203.5"/>
<text class="ts" x="164" y="182" text-anchor="end">e = a − p</text>
<rect class="bg" x="400" y="36" width="300" height="232" rx="12"/>
<text class="th" x="416" y="62" text-anchor="start">用数字走一遍</text>
<text class="t" x="416" y="90" text-anchor="start">a·b = 2×3 + 2×1 = 8，b·b = 9 + 1 = 10</text>
<text class="t" x="416" y="118" text-anchor="start">系数 = a·b ÷ b·b = 0.8</text>
<text class="t" x="416" y="146" text-anchor="start">p = 0.8 × (3, 1) = (2.4, 0.8)</text>
<text class="t" x="416" y="174" text-anchor="start">e = a − p = (−0.4, 1.2)</text>
<text class="ta" x="416" y="206" text-anchor="start">e·b = −0.4×3 + 1.2×1 = 0</text>
<text class="ts" x="416" y="230" text-anchor="start">误差与 b 垂直，这正是“最近”的标志</text>
<text class="ts" x="416" y="252" text-anchor="start">公式：p = (a·b ÷ b·b) b = (bbᵀ ÷ bᵀb) a</text>
</svg>
<figcaption>图 1：向量投影：p 是 b 所在直线上离 a 最近的点；a 被分成“沿 b 的部分 p”与“垂直于 b 的部分 e”</figcaption>
</figure>

向量页里“点积 = 投影长度 × ‖b‖”说的是同一件事：`a·b ÷ ‖b‖` 是投影的长度，`a·b ÷ b·b` 是投影占 b 的几分之几。

> [!NOTE] 投影矩阵（一维情形）
> `p = (b bᵀ ÷ bᵀb) a`，其中 `b bᵀ` 是 `n×n` 的矩阵，叫外积。例：投影到方向 `(1, 1)` 的矩阵是 `P = [[0.5, 0.5], [0.5, 0.5]]`，对 `(3, 1)`：`P(3,1) = (2, 2)`，残差 `(1, −1)` 垂直于 `(1,1)`。再投影一次不变：`P·P = P`。

## 三、向子空间（平面）投影与投影矩阵

现在把“直线”升级成“平面”：A 有两列 `a₁, a₂`，它们的所有线性组合（列空间）是三维空间里的一个平面。给定平面外的向量 b，求平面上离它最近的点 `p = Ax̂`（`x̂` 读“x 帽”，表示“最优的配方”）。

<figure class="fig">
<svg viewBox="0 0 720 320" class="dg" role="img" aria-label="向平面投影：b 在三维空间，列空间是一个平面，p 是平面上离 b 最近的点，e 垂直于整个平面">
<line class="b1 nf" x1="32.2" y1="281" x2="209" y2="281"/>
<line class="b1 nf" x1="209" y1="281" x2="351" y2="222.2"/>
<line class="b1 nf" x1="351" y1="222.2" x2="174.2" y2="222.2"/>
<line class="b1 nf" x1="174.2" y1="222.2" x2="32.2" y2="281"/>
<text class="ts" x="351" y="214.2" text-anchor="end">列空间（平面）</text>
<line class="l" x1="90" y1="270" x2="194" y2="270" marker-end="url(#arr)"/>
<text class="tb" x="202" y="284" text-anchor="start">a₁</text>
<line class="l" x1="90" y1="270" x2="178.8" y2="233.2" marker-end="url(#arr)"/>
<text class="tb" x="170.8" y="227.2" text-anchor="end">a₂</text>
<line class="ld" x1="90" y1="270" x2="233.8" y2="240.6"/>
<line class="la" x1="233.8" y1="240.6" x2="233.8" y2="136.6" marker-end="url(#arr-a)"/>
<circle class="b3" cx="233.8" cy="136.6" r="4"/>
<circle class="b2" cx="233.8" cy="240.6" r="4"/>
<text class="tb" x="243.8" y="140.6" text-anchor="start">b</text>
<text class="tb" x="243.8" y="256.6" text-anchor="start">p = Pb</text>
<text class="ta" x="243.8" y="188.6" text-anchor="start">e = b − p</text>
<line class="l" x1="242.8" y1="240.6" x2="242.8" y2="231.6"/>
<line class="l" x1="242.8" y1="231.6" x2="233.8" y2="231.6"/>
<rect class="bg" x="420" y="40" width="280" height="250" rx="12"/>
<text class="th" x="436" y="66" text-anchor="start">为什么 e 垂直于平面</text>
<text class="ts" x="436" y="92" text-anchor="start">p 是平面里离 b 最近的点，所以</text>
<text class="ts" x="436" y="112" text-anchor="start">e 不能有任何“沿平面”的分量</text>
<text class="t" x="436" y="142" text-anchor="start">e ⊥ a₁   即  a₁·e = 0</text>
<text class="t" x="436" y="166" text-anchor="start">e ⊥ a₂   即  a₂·e = 0</text>
<text class="ts" x="436" y="192" text-anchor="start">把两条写成一条（A 的列是 a₁, a₂）：</text>
<text class="ta" x="436" y="218" text-anchor="start">Aᵀ(b − Ax̂) = 0</text>
<text class="ts" x="436" y="246" text-anchor="start">即正规方程 AᵀA x̂ = Aᵀb，p = A x̂</text>
<text class="ts" x="436" y="270" text-anchor="start">（图中平面取水平面，只为画图方便）</text>
</svg>
<figcaption>图 2：向列空间投影：残差 e 同时垂直于 A 的每一列，由此得到正规方程</figcaption>
</figure>

关键一步：最近的点 p 满足 **残差 `e = b − Ax̂` 垂直于整个平面**，也就是同时垂直于每一列：

```text
a₁·(b − Ax̂) = 0
a₂·(b − Ax̂) = 0        ⇒  把两条叠在一起写成矩阵：  Aᵀ(b − Ax̂) = 0
```

整理得到**正规方程**（normal equations）：

```text
AᵀA x̂ = Aᵀb            ⇒   x̂ = (AᵀA)⁻¹ Aᵀb        （AᵀA 可逆，即 A 的列线性无关时）
p = A x̂ = A(AᵀA)⁻¹Aᵀ b = P b      其中  P = A(AᵀA)⁻¹Aᵀ 叫投影矩阵
```

P 有两条好性质：`Pᵀ = P`（对称），`P² = P`（投影两次等于一次：已经在平面上的点，再投影不会动）。当 A 只有一列 b 时，上式就变成上一节的公式。

## 四、最小二乘：无解时找“最近的”

方程 `Ax = b` 在 b 不在列空间里时无解。这时我们退一步：不求 `Ax = b`，而是**让误差向量最短**：

```text
找 x̂ 使得  ‖b − Ax̂‖²  最小
```

`‖·‖²` 是“各个方程的误差平方再求和”，所以叫**最小二乘**（least squares：误差的“二次方”之和最小）。几何上：`Ax` 能取到的所有点就是列空间，离 b 最近的点是垂足，也就是**把 b 投影到列空间**。所以**最小二乘的解就是正规方程的解**。

### 用微积分再推一遍，两种做法互相印证

把损失写出来并展开：

```text
L(x) = ‖Ax − b‖² = (Ax − b)ᵀ(Ax − b) = xᵀAᵀAx − 2bᵀAx + bᵀb
```

对 x 求梯度（梯度见 [偏导数与梯度：多个旋钮的世界](#/math/gradient)）：

```text
∇L = 2AᵀAx − 2Aᵀb = 2Aᵀ(Ax − b)
令 ∇L = 0   ⇒   AᵀAx = Aᵀb
```

与几何推导得到**完全相同**的方程：几何说“残差垂直于每一列”，微积分说“梯度为 0”，而 `∇L = −2Aᵀe`，两者本是一回事：**梯度为 0 ⇔ 残差与每一列垂直**。

### 完整手算：4 个点拟合一条直线

数据点：`(1, 2), (2, 3), (3, 5), (4, 6)`。想拟合 `y = c + m·x`（c 截距，m 斜率）。每个点是一个方程，4 个方程 2 个未知数：

```text
c + m×1 = 2        A = | 1  1 |     未知 w = (c, m)     b = (2, 3, 5, 6)
c + m×2 = 3            | 1  2 |
c + m×3 = 5            | 1  3 |     第一列全 1（对应截距），第二列是 x
c + m×4 = 6            | 1  4 |
```

第一步，算 `AᵀA` 和 `Aᵀb`（每个元素都是两列的点积）：

```text
AᵀA = | 1+1+1+1      1+2+3+4   |  =  |  4  10 |
      | 1+2+3+4   1+4+9+16     |     | 10  30 |

Aᵀb = | 2+3+5+6      |  =  | 16 |
      | 2+6+15+24    |     | 47 |
```

第二步，解 `AᵀA w = Aᵀb`。用上一页的 2×2 逆矩阵公式：`det = 4×30 − 10×10 = 20`。

```text
w = (1/20) × |  30  −10 | × | 16 |  =  (1/20) × (30×16 − 10×47,  −10×16 + 4×47)
             | −10    4 |   | 47 |
  = (1/20) × (480 − 470,  −160 + 188) = (10/20, 28/20) = (0.5, 1.4)
```

所以直线是 `y = 0.5 + 1.4x`。第三步，检查：

```text
预测 p = A w = (1.9, 3.3, 4.7, 6.1)
残差 e = b − p = (0.1, −0.3, 0.3, −0.1)
Aᵀe：第一列·e = 0.1 − 0.3 + 0.3 − 0.1 = 0
     第二列·e = 1×0.1 + 2×(−0.3) + 3×0.3 + 4×(−0.1) = 0.1 − 0.6 + 0.9 − 0.4 = 0     ✓ 残差垂直于两列
残差平方和 = 0.01 + 0.09 + 0.09 + 0.01 = 0.2
```

`Aᵀe = 0` 在统计上的含义也很直观：第一列全是 1，所以残差之和为 0（直线上下“拉平”）；第二列是 x，所以残差与 x 无关（没有留下可被 x 解释的规律）。

<figure class="fig">
<svg viewBox="0 0 720 310" class="dg" role="img" aria-label="四个数据点、最小二乘拟合直线 y = 0.5 + 1.4x，以及每个点的竖直残差">
<line class="l" x1="60" y1="270" x2="430" y2="270" marker-end="url(#arr)"/>
<line class="l" x1="60" y1="270" x2="60" y2="28" marker-end="url(#arr)"/>
<text class="ts" x="436" y="274" text-anchor="start">x</text>
<text class="ts" x="54" y="26" text-anchor="end">y</text>
<text class="ts" x="130" y="288" text-anchor="middle">1</text>
<text class="ts" x="200" y="288" text-anchor="middle">2</text>
<text class="ts" x="270" y="288" text-anchor="middle">3</text>
<text class="ts" x="340" y="288" text-anchor="middle">4</text>
<text class="ts" x="410" y="288" text-anchor="middle">5</text>
<text class="ts" x="52" y="210" text-anchor="end">2</text>
<text class="ts" x="52" y="146" text-anchor="end">4</text>
<text class="ts" x="52" y="82" text-anchor="end">6</text>
<line class="la" x1="81" y1="240.6" x2="375" y2="52.4"/>
<line class="ld" x1="130" y1="206" x2="130" y2="209.2"/>
<circle class="b3" cx="130" cy="209.2" r="3"/>
<circle class="b1" cx="130" cy="206" r="5"/>
<text class="ts" x="139" y="211.6" text-anchor="start">+0.1</text>
<line class="ld" x1="200" y1="174" x2="200" y2="164.4"/>
<circle class="b3" cx="200" cy="164.4" r="3"/>
<circle class="b1" cx="200" cy="174" r="5"/>
<text class="ts" x="209" y="173.2" text-anchor="start">−0.3</text>
<line class="ld" x1="270" y1="110" x2="270" y2="119.6"/>
<circle class="b3" cx="270" cy="119.6" r="3"/>
<circle class="b1" cx="270" cy="110" r="5"/>
<text class="ts" x="279" y="118.8" text-anchor="start">+0.3</text>
<line class="ld" x1="340" y1="78" x2="340" y2="74.8"/>
<circle class="b3" cx="340" cy="74.8" r="3"/>
<circle class="b1" cx="340" cy="78" r="5"/>
<text class="ts" x="349" y="80.4" text-anchor="start">−0.1</text>
<text class="ta" x="371" y="42.4" text-anchor="end">y = 0.5 + 1.4x</text>
<rect class="bg" x="470" y="36" width="230" height="236" rx="12"/>
<text class="th" x="486" y="62" text-anchor="start">结果</text>
<text class="t" x="486" y="90" text-anchor="start">权重 (截距, 斜率) = (0.5, 1.4)</text>
<text class="t" x="486" y="118" text-anchor="start">预测 p = (1.9, 3.3, 4.7, 6.1)</text>
<text class="t" x="486" y="146" text-anchor="start">残差 e = (0.1, −0.3, 0.3, −0.1)</text>
<text class="t" x="486" y="174" text-anchor="start">残差平方和 = 0.2</text>
<text class="ta" x="486" y="206" text-anchor="start">Aᵀe = (0, 0)：残差与两列都垂直</text>
<text class="ts" x="486" y="232" text-anchor="start">即：残差之和为 0，且与 x 的内积为 0</text>
<text class="ts" x="486" y="254" text-anchor="start">（蓝圈：数据；琥珀点：拟合值）</text>
</svg>
<figcaption>图 3：最小二乘直线使竖直残差的平方和最小；这些残差作为向量，恰好垂直于“全 1 列”和“x 列”</figcaption>
</figure>

> [!WARNING] 常见误区
> 1. 最小二乘最小化的是**竖直方向**（y 方向）的误差平方，不是点到直线的垂直距离。点到直线的垂直距离对应另一种方法（总体最小二乘/PCA）。
> 2. 最小二乘对离群点很敏感：误差是平方，一个很远的点能把直线拉歪。
> 3. 正规方程要求 `AᵀA` 可逆，也就是特征列线性无关；有共线特征时要用岭回归或伪逆。

## 五、线性回归 = 最小二乘，与梯度下降

线性回归的损失（均方误差）就是 `L(w) = (1/N)‖Xw − y‖²`，N 是样本数。它和上面的最小二乘只差一个常数倍，所以最优解相同。求解有两条路：

| 方法 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **正规方程** | 解 `XᵀXw = Xᵀy`（实际用 QR/SVD） | 一步到位，没有学习率 | 要解 d×d 的方程组，约 `d³` 的代价；特征极多时太慢 |
| **梯度下降** | `w ← w − η∇L`，其中 `∇L = (2/N)Xᵀ(Xw − y)` | 每步只要矩阵乘向量，可分批、可 GPU；能推广到没有公式解的模型 | 要选学习率，收敛需要多步 |

两者是**同一个凸函数的同一个最小点**：梯度下降每步沿着 `−Xᵀ(残差)` 走，越走残差越趋于与各列垂直，最后停在 `Xᵀe = 0` 的地方，正是正规方程的解。上面的 4 点例子里，从 `w = (0, 0)` 出发、学习率 0.05、走 2000 步，就收敛到 `(0.5, 1.4)`（代码见第八节）。神经网络没有公式解，所以只能走梯度下降这条路，细节见 [极值与优化：从梯度下降到 Adam，再到约束优化](#/math/optimization)。

## 六、岭回归：给 `AᵀA` 加一点 `λI`

**问题**：两个特征几乎一模一样（共线或近似共线）时，`AᵀA` 接近奇异，条件数巨大（见上一页）。最小二乘会为了拟合噪声，把一个权重放得很大正数、另一个放得很大负数，互相抵消。

**数值例子**：`x₁ = (1,2,3,4)`，`x₂` 与 `x₁` 只差 `±0.001`，目标 `y = (2.1, 3.9, 6.1, 7.9)`（大致是 `x₁ + x₂ ≈ 2x`，真实权重约 `(1, 1)`）：

```text
普通最小二乘：w = (−98, 100)        权重爆炸，预测几乎靠两个大数的“差”
岭回归 λ=0.1：w = (0.993, 0.997)    稳定，接近真实的 (1, 1)
```

**岭回归**（ridge regression）在损失里加入对权重大小的惩罚：

```text
L(w) = ‖Xw − y‖² + λ‖w‖²       ⇒   (XᵀX + λI) w = Xᵀy
```

λ（念“拉姆达”）是惩罚强度，`I` 是单位矩阵。**为什么更稳**：`XᵀX` 的特征值都 ≥ 0，可能很接近 0（共线）；加上 `λI` 相当于每个特征值都加 λ，永远严格大于 0，所以一定可逆，而且条件数大幅下降：上例里 `XᵀX` 的条件数是 `3.1×10⁷`，加上 `0.1I` 后只有 `6.0×10²`。

几何上，岭回归偏爱小权重，不会为了拟合噪声而用大权重互相抵消。λ 越大，权重越小、越“保守”；`λ → 0` 退回普通最小二乘；`λ → ∞` 权重趋近于 0。λ 通常用交叉验证选。神经网络训练里的 **权重衰减（L2 正则）** 就是同一个想法。

## 七、Gram-Schmidt 与 QR：更稳的做法（认识即可）

**Gram-Schmidt 正交化**：把一组线性无关的向量变成标准正交向量。步骤：取第一个向量归一化得 `q₁`；第二个向量**减去它在 q₁ 上的投影**，剩下的部分与 q₁ 垂直，再归一化得 `q₂`；以此类推，后面每个向量都减去它在所有已有 q 上的投影。

**手算**：`a₁ = (1, 1, 0)`，`a₂ = (1, 0, 1)`：

```text
q₁ = a₁ ÷ ‖a₁‖ = (1, 1, 0)/√2 ≈ (0.707, 0.707, 0)
q₁·a₂ = 1/√2 ≈ 0.707
r = a₂ − (q₁·a₂)q₁ = (1, 0, 1) − 0.707×(0.707, 0.707, 0) = (0.5, −0.5, 1)
‖r‖ = √(0.25+0.25+1) = √1.5 ≈ 1.225
q₂ = r ÷ ‖r‖ ≈ (0.408, −0.408, 0.816)
检验：q₁·q₂ = 0.707×0.408 − 0.707×0.408 + 0 = 0 ✓
```

把这个过程写成矩阵就是 **QR 分解**：`A = QR`，Q 的列是标准正交向量（`QᵀQ = I`），R 是上三角矩阵。用它解最小二乘：

```text
AᵀA x = Aᵀb   →   (QR)ᵀ(QR) x = (QR)ᵀ b   →   RᵀQᵀQR x = RᵀQᵀ b   →   R x = Qᵀ b
```

最后的 `Rx = Qᵀb` 是上三角方程组，回代即可。**更稳的原因**：直接算 `AᵀA` 会让条件数**平方**（`cond(AᵀA) = cond(A)²`，上例中 `5570 → 3.1×10⁷`），丢失一半的有效数字；QR 完全不需要构造 `AᵀA`，只在 A 本身的条件数上做运算。所以 `np.linalg.lstsq` 内部用的是 SVD/QR 一类的稳定方法，而不是直接解正规方程。

## 八、动手：NumPy 验证

```python
import numpy as np

x = np.array([1, 2, 3, 4.]); y = np.array([2, 3, 5, 6.])
A = np.column_stack([np.ones(4), x])            # 第一列全 1（截距），第二列是 x
w = np.linalg.solve(A.T @ A, A.T @ y)           # 正规方程 AᵀA w = Aᵀy
print(w, A @ w)
e = y - A @ w
print(np.round(e, 4), np.round(A.T @ e, 10), round(e @ e, 4))   # 残差，Aᵀe ≈ 0，平方和
print(np.linalg.lstsq(A, y, rcond=None)[0])     # 现成的最小二乘函数，结果一致

# 梯度下降：同一个问题，一步一步走到同一个解
w = np.zeros(2)
for _ in range(2000):
    w -= 0.05 * (2 / 4) * A.T @ (A @ w - y)     # ∇L = (2/N) Aᵀ(Aw − y)
print(np.round(w, 4))

# 岭回归：两个几乎一样的特征
x1 = np.array([1, 2, 3, 4.]); x2 = x1 + np.array([0.001, -0.001, 0.001, -0.001])
X = np.column_stack([x1, x2]); yy = np.array([2.1, 3.9, 6.1, 7.9])
print(np.round(np.linalg.lstsq(X, yy, rcond=None)[0], 2))               # 普通最小二乘：权重爆炸
lam = 0.1
print(np.round(np.linalg.solve(X.T @ X + lam * np.eye(2), X.T @ yy), 3))  # 岭回归：稳定
print(f"{np.linalg.cond(X.T @ X):.1e}", f"{np.linalg.cond(X.T @ X + lam * np.eye(2)):.1e}")

# Gram-Schmidt 与 QR
a1 = np.array([1, 1, 0.]); a2 = np.array([1, 0, 1.])
q1 = a1 / np.linalg.norm(a1)
r = a2 - (q1 @ a2) * q1                         # 减去 a2 在 q1 上的投影
q2 = r / np.linalg.norm(r)
print(np.round(q1, 3), np.round(q2, 3), round(q1 @ q2, 6))
A3 = np.column_stack([a1, a2])
Q, R = np.linalg.qr(A3)                          # 现成的 QR 分解
print(np.allclose(Q @ R, A3), np.allclose(Q.T @ Q, np.eye(2)))
print(round(np.linalg.cond(X)), f"{np.linalg.cond(X.T @ X):.1e}")   # cond(AᵀA) ≈ cond(A)²
```

```text
[0.5 1.4] [1.9 3.3 4.7 6.1]
[ 0.1 -0.3  0.3 -0.1] [0. 0.] 0.2
[0.5 1.4]
[0.5 1.4]
[-98. 100.]
[0.993 0.997]
3.1e+07 6.0e+02
[0.707 0.707 0.   ] [ 0.408 -0.408  0.816] 0.0
True True
5570 3.1e+07
```

## 九、和 AI 的对照表

| 概念 | 一句话 | 在 AI 里 |
| --- | --- | --- |
| 正交 / 标准正交基 | 点积为 0 / 再加长度 1 | PCA、SVD 的方向；正交初始化；RoPE 的旋转 |
| 投影 | 离得最近的点 | PCA 把数据投影到主成分方向；LoRA 把权重更新限制在低秩子空间里 |
| 残差垂直于列空间 | 误差里没有可解释的规律 | 线性回归诊断；残差图应像“随机噪声” |
| 正规方程 `AᵀAx = Aᵀb` | 最小二乘的闭式解 | 小规模线性回归；岭回归 |
| 最小二乘 ↔ 梯度下降 | 同一个凸问题的两种解法 | 线性层训练用梯度下降；一般模型只能梯度下降 |
| 岭回归 `AᵀA + λI` | 惩罚大权重，保证可逆 | 权重衰减（L2 正则）、贝叶斯先验 |
| Gram-Schmidt / QR | 逐个减去投影，得到正交基 | 数值线性代数里求解最小二乘、特征值的基础工具 |

## 自测

> [!QUESTION] 把 `a = (4, 3)` 投影到 `b = (1, 0)` 方向，投影 p 与误差 e 各是什么？
> `a·b = 4`，`b·b = 1`，`c = 4`，`p = 4×(1, 0) = (4, 0)`，`e = a − p = (0, 3)`，`e·b = 0`。投影就是“只保留 x 分量”。

> [!QUESTION] 为什么最小二乘的解里，残差一定垂直于 A 的每一列？
> 最优的 `Ax̂` 是列空间里离 b 最近的点，也就是垂足；垂足的定义就是连线 `b − Ax̂` 与整个平面垂直，即与每一列的点积都是 0：`Aᵀ(b − Ax̂) = 0`。

> [!QUESTION] 用正规方程求过三点 `(0, 1), (1, 3), (2, 4)` 的最小二乘直线。
> `A = [[1,0],[1,1],[1,2]]`，`b = (1,3,4)`。`AᵀA = [[3,3],[3,5]]`，`Aᵀb = (8, 11)`（`1+3+4 = 8`，`0+3+8 = 11`）。`det = 15 − 9 = 6`，`w = (1/6)[[5,−3],[−3,3]]·(8,11) = (1/6)(40−33, −24+33) = (7/6, 9/6) ≈ (1.167, 1.5)`，即 `y ≈ 1.167 + 1.5x`。

> [!QUESTION] 岭回归的 `λI` 为什么能保证矩阵可逆？
> `XᵀX` 的特征值都是非负数，可能等于 0（共线时）。加上 `λI` 后每个特征值都变成 `原值 + λ`，严格大于 0，所以矩阵满秩、可逆；而且最小特征值变大，条件数随之下降。

> [!QUESTION] 线性回归既可以用正规方程，也可以用梯度下降，它们的结果为什么一样？
> 均方误差是一个凸的二次函数，只有一个最小点。正规方程直接令梯度为 0 解出它；梯度下降沿着负梯度一步步走向它。梯度为 0 时就是 `Xᵀe = 0`，两者在同一点相遇（差别只在效率与适用范围）。

> [!QUESTION] 为什么说“解正规方程不如 QR / SVD 稳”？
> 构造 `AᵀA` 会让条件数平方，数值误差放大得更厉害（例中 `5570 → 3.1×10⁷`）。QR / SVD 直接对 A 做正交变换，不需要构造 `AᵀA`，丢失的有效数字少得多。

## 相关阅读

- 上一页：[线性方程组、逆矩阵与秩](#/math/linear-systems)
- 梯度下降求解同一个问题：[极值与优化：从梯度下降到 Adam，再到约束优化](#/math/optimization)
- 下一页：[特征值与特征向量：PCA 与谱的直觉](#/math/eigen)
- 本页内容的速成版：[线性代数 1：向量与矩阵](#/aimodel/math-la1)、[微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)
- 点积与夹角的基础：[向量：长度、点积、夹角与相似度](#/math/vectors)
