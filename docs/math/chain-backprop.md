---
level: 基础
tags: [链式法则, 反向传播, 计算图, 自动微分, 梯度消失, 梯度爆炸, autograd, 入门]
summary: 从“齿轮相乘”的链式法则讲到计算图与反向传播：完整手算单个神经元和 2-2-1 网络的每个梯度，推出 δ 逐层递推的矩阵形式，解释梯度消失与爆炸，并说明自动微分为什么用反向模式、怎么用 PyTorch 与梯度检验验证。
---

# 链式法则与反向传播：从复合函数到计算图

> [!ABSTRACT] 一句话版本
> - **链式法则**：一环扣一环的变化，倍率**逐环相乘**。踏板转 1 圈，飞轮转 2 圈，后轮再多转 3 倍，后轮就转 2×3=6 圈。
> - **多条路径**：一个变量通过几条路影响结果时，**每条路径先连乘，再把各路径相加**。
> - **计算图**：把公式拆成最小的一步步运算。**前向**从左到右算值，**反向**从右到左，每个节点只需要自己的“局部导数”，乘上游传来的梯度就行。
> - **反向传播 = 链式法则 + 把中间结果记下来复用**，让几亿个参数的梯度**一次反向扫描**就算完。
> - 连乘有代价：每层乘 0.25 的话 10 层就只剩百万分之一（**梯度消失**），每层乘 1.5 则暴涨 58 倍（**梯度爆炸**）。

> [!NOTE] 先决条件
> 需要知道导数是“变化率”（[导数](#/math/derivative)）、偏导数和梯度是什么（[偏导数与梯度](#/math/gradient)）。速成版见 [微积分 1](#/aimodel/math-calc1)，本页把它**拆得更细**。

训练一个网络要回答：**几亿个参数里，每一个调大一点，损失 L 会怎么变？** 这就是 `∂L/∂θ`（θ 代表任意一个参数）。网络是“很多函数一层套一层”，所以要先学会对**套娃一样的函数**求导，这就是链式法则。

## 一、复合函数与链式法则（单变量）

### 1. 套娃函数

`y = f(u)`，而 `u = g(x)`，那么 `y` 间接依赖 `x`，写成 `y = f(g(x))`，叫**复合函数**。你可以把它想成**流水线**：x 进第一道工序得到 u，u 再进第二道工序得到 y。

**生活类比 1（汇率）**：1 元人民币 ≈ 0.14 美元，1 美元 ≈ 150 日元。1 元能换多少日元？0.14 × 150 = 21。**每一环有自己的“兑换倍率”，整条链的倍率是各环相乘。**

**生活类比 2（齿轮）**：

```text
踏板 x ──×2──▶ 飞轮 u ──×3──▶ 后轮 y
踏板转 1 圈 → 飞轮转 2 圈 → 后轮转 6 圈        dy/dx = 3 × 2 = 6
```

### 2. 公式

```text
dy/dx = (dy/du) × (du/dx)
```

`d` 读“d”，`dy/dx` 读“dy dx”，意思是“y 对 x 的导数”。为什么成立？把导数理解为“放大倍率”：x 动一点点 Δx，u 约动 `g′(x)·Δx`；u 动这么多，y 又约动 `f′(u)` 倍，所以 `Δy ≈ f′(u)·g′(x)·Δx`，倍率就是两个导数相乘。

> [!WARNING] 外层导数要在“内层的输出”处取值
> `f′` 求的是**在 u = g(x) 这一点**的导数，不是在 x 处。比如 `y = sin(x²)`，外层 `sin′(u) = cos u` 里的 u 要代入 `x²`，写成 `cos(x²)`，不能写成 `cos x`。

### 3. 手算：两环和三环

**例 1**：`y = sin(x²)`，令 `u = x²`，`y = sin u`：

```text
dy/du = cos u        du/dx = 2x
dy/dx = cos(x²) × 2x
x = 1 时：cos(1) × 2 = 0.5403 × 2 = 1.0806
```

**例 2（三环）**：`y = ln(1 + e^(2x))`（这是神经网络里常见的 softplus 函数）。拆成 `u = 2x`、`v = eᵘ`、`y = ln(1 + v)`：

```text
du/dx = 2        dv/du = eᵘ        dy/dv = 1/(1+v)
dy/dx = 2 × eᵘ × 1/(1+v) = 2·e^(2x) / (1 + e^(2x))
x = 0 时：u = 0，v = 1，dy/dx = 2 × 1 × 1/2 = 1
```

链再长也是一样：**每一环只算自己的局部导数，最后全部乘起来。**

## 二、多变量链式法则：多条路径相加

### 1. 一个变量走了两条路

如果 `x` 同时影响 `v1` 和 `v2`，而结果 `f` 由两者共同决定呢？想象一个水源接出两条水管，最后汇进同一个水池：**池水的增量 = 两条水管各自带来的增量之和**。

```text
f = F(v1, v2)，其中 v1 = v1(x)，v2 = v2(x)：

df/dx = (∂F/∂v1)·(dv1/dx) + (∂F/∂v2)·(dv2/dx)
          路径 ①                路径 ②
```

`∂`（读“偏”）表示偏导数：别的量先不动，只看这一个。**口诀：沿着每条路径把局部导数连乘，不同路径的结果相加。**

### 2. 手算

`f(x, y) = x·y + sin x`，求在 `(x, y) = (2, 3)` 处对 x 的导数。令 `v1 = x·y`，`v2 = sin x`，`f = v1 + v2`：

```text
x = 2，y = 3：   v1 = x·y = 6，   v2 = sin x = 0.909，   f = v1 + v2 = 6.909
路径 ① x → v1 → f：  (∂v1/∂x)·(∂f/∂v1) = y × 1        = 3 × 1        = 3
路径 ② x → v2 → f：  (∂v2/∂x)·(∂f/∂v2) = cos x × 1    = (−0.416) × 1 = −0.416
两条路径相加：∂f/∂x = 3 + (−0.416) = 2.584
```

直接对 `x·y + sin x` 求导得 `y + cos x = 3 + cos 2 = 2.5839`，与上面一致。

### 3. AI 里的“多条路径”

- **残差连接** `y = x + F(x)`：x 走两条路，一条直通（导数 1），一条穿过 F。`dy/dx = 1 + F′(x)`，那个“1”让梯度**永远有一条不衰减的通路**。
- **共享权重**（RNN 每个时间步用同一个 W、CNN 的卷积核）：同一个参数在图里被用了很多次，它的梯度是**各处贡献之和**。
- **一个隐藏神经元连着下一层的很多神经元**：它收到的误差是下一层每个神经元传回来的**总和**（下文矩阵里的 `Wᵀδ` 就是这个求和）。

## 三、计算图：把公式拆成最小的一步

**计算图**里，每个**节点**是一步最小运算（加、乘、σ……），**边**是数据流向。有了图，求梯度变成机械操作：

1. **前向**：从输入开始，一个节点一个节点地算出值，**并把中间值留着**（反向要用）。
2. **反向**：从损失 L 出发，令 `∂L/∂L = 1`，往回走。到达一个节点时，已知“**上游梯度**”= L 对该节点输出的偏导，则对它的每个输入：**输入的梯度 = 上游梯度 × 这个节点对该输入的局部导数**。
3. 一个值被用了多次（分叉）时，**把各条路径回来的梯度相加**。

三种最常见节点的“局部导数”只有这么几条：

| 节点 | 前向 | 反向（上游梯度记作 g） |
| --- | --- | --- |
| 加法 | `c = a + b` | 两个输入各得 `g`（梯度原样**复制**） |
| 乘法 | `c = a·b` | `a` 得 `g·b`，`b` 得 `g·a`（乘**另一个**输入） |
| 激活 | `a = σ(z)` | `z` 得 `g·σ′(z)` |

## 四、完整手算 1：单个神经元

### 1. 设定

```text
x = 2（输入）  w = 0.5（权重）  b = −0.5（偏置）  t = 1（正确答案）
z = w·x + b        a = σ(z) = 1/(1+e⁻ᶻ)        L = (a − t)²
```

### 2. 前向（把中间值记下来）

```text
p = w·x = 0.5×2 = 1.0
z = p + b = 1.0 − 0.5 = 0.5
a = σ(0.5) = 0.6225
L = (0.6225 − 1)² = 0.1425
```

### 3. 反向（对着图 1 走）

<figure class="fig">
<svg viewBox="0 0 720 330" class="dg" role="img" aria-label="单个神经元的计算图：上方是前向算出的数值，下方是反向逐节点乘局部导数得到的梯度">
<rect class="b1" x="20" y="48" width="80" height="40" rx="8"/>
<text class="tb" x="60" y="68" text-anchor="middle" dominant-baseline="middle">w = 0.5</text>
<rect class="b1" x="20" y="128" width="80" height="40" rx="8"/>
<text class="tb" x="60" y="148" text-anchor="middle" dominant-baseline="middle">x = 2</text>
<rect class="b3" x="145" y="90" width="110" height="50" rx="8"/>
<text class="tb" x="200" y="108" text-anchor="middle" dominant-baseline="middle">p = w·x</text>
<text class="tm" x="200" y="128" text-anchor="middle" dominant-baseline="middle">1.0</text>
<rect class="b1" x="300" y="18" width="80" height="34" rx="8"/>
<text class="tb" x="340" y="35" text-anchor="middle" dominant-baseline="middle">b = −0.5</text>
<rect class="b3" x="285" y="90" width="110" height="50" rx="8"/>
<text class="tb" x="340" y="108" text-anchor="middle" dominant-baseline="middle">z = p + b</text>
<text class="tm" x="340" y="128" text-anchor="middle" dominant-baseline="middle">0.5</text>
<rect class="b3" x="425" y="90" width="110" height="50" rx="8"/>
<text class="tb" x="480" y="108" text-anchor="middle" dominant-baseline="middle">a = σ(z)</text>
<text class="tm" x="480" y="128" text-anchor="middle" dominant-baseline="middle">0.6225</text>
<rect class="b4" x="570" y="90" width="130" height="50" rx="8"/>
<text class="tb" x="635" y="108" text-anchor="middle" dominant-baseline="middle">L = (a−t)²</text>
<text class="tm" x="635" y="128" text-anchor="middle" dominant-baseline="middle">0.1425</text>
<line class="l" x1="100" y1="72" x2="145" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="100" y1="148" x2="145" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="115" x2="285" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="52" x2="340" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="395" y1="115" x2="425" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="535" y1="115" x2="570" y2="115" marker-end="url(#arr)"/>
<text class="ts" x="640" y="70" text-anchor="middle">前向 →</text>
<text class="ts" x="640" y="86" text-anchor="middle">（t = 1 是答案）</text>
<rect class="b4" x="577" y="192" width="116" height="36" rx="8"/>
<text class="tm" x="635" y="210" text-anchor="middle" dominant-baseline="middle">∂L/∂L = 1</text>
<rect class="b4" x="422" y="192" width="116" height="36" rx="8"/>
<text class="tm" x="480" y="210" text-anchor="middle" dominant-baseline="middle">∂L/∂a=−0.7551</text>
<rect class="b4" x="282" y="192" width="116" height="36" rx="8"/>
<text class="tm" x="340" y="210" text-anchor="middle" dominant-baseline="middle">∂L/∂z=−0.1774</text>
<rect class="b4" x="142" y="192" width="116" height="36" rx="8"/>
<text class="tm" x="200" y="210" text-anchor="middle" dominant-baseline="middle">∂L/∂p=−0.1774</text>
<rect class="b4" x="2" y="192" width="116" height="36" rx="8"/>
<text class="tm" x="60" y="210" text-anchor="middle" dominant-baseline="middle">∂L/∂w=−0.3549</text>
<rect class="b4" x="2" y="256" width="116" height="36" rx="8"/>
<text class="tm" x="60" y="274" text-anchor="middle" dominant-baseline="middle">∂L/∂x=−0.0887</text>
<rect class="b4" x="282" y="256" width="116" height="36" rx="8"/>
<text class="tm" x="340" y="274" text-anchor="middle" dominant-baseline="middle">∂L/∂b=−0.1774</text>
<line class="la" x1="577" y1="210" x2="538" y2="210" marker-end="url(#arr-a)"/>
<text class="ta" x="558" y="184" text-anchor="middle">×2(a−t)</text>
<line class="la" x1="422" y1="210" x2="398" y2="210" marker-end="url(#arr-a)"/>
<text class="ta" x="410" y="184" text-anchor="middle">×σ′(z)</text>
<line class="la" x1="282" y1="210" x2="258" y2="210" marker-end="url(#arr-a)"/>
<text class="ta" x="270" y="184" text-anchor="middle">×1</text>
<line class="la" x1="142" y1="210" x2="118" y2="210" marker-end="url(#arr-a)"/>
<text class="ta" x="130" y="184" text-anchor="middle">×x</text>
<line class="la" x1="340" y1="228" x2="340" y2="256" marker-end="url(#arr-a)"/>
<text class="ta" x="352" y="246" text-anchor="start">×1</text>
<line class="la" x1="170" y1="228" x2="118" y2="264" marker-end="url(#arr-a)"/>
<text class="ta" x="118" y="244" text-anchor="end">×w</text>
<text class="ts" x="420" y="286" text-anchor="start">← 反向：从 L 出发，每过一个节点乘一次局部导数</text>
</svg>
<figcaption>图 1：计算图：前向算值（上），反向乘局部导数传梯度（下）</figcaption>
</figure>

先把每个节点的**局部导数**写出来：

```text
L = (a−t)²   → ∂L/∂a = 2(a − t) = 2×(0.6225 − 1) = −0.7551
a = σ(z)     → ∂a/∂z = a(1 − a) = 0.6225×0.3775 = 0.2350        （σ′ = σ(1−σ)）
z = p + b    → ∂z/∂p = 1，  ∂z/∂b = 1
p = w·x      → ∂p/∂w = x = 2，  ∂p/∂x = w = 0.5
```

再从右往左乘：

```text
∂L/∂z = ∂L/∂a × ∂a/∂z = −0.7551 × 0.2350 = −0.1774
∂L/∂b = ∂L/∂z × 1 = −0.1774
∂L/∂p = ∂L/∂z × 1 = −0.1774
∂L/∂w = ∂L/∂p × x = −0.1774 × 2 = −0.3549
∂L/∂x = ∂L/∂p × w = −0.1774 × 0.5 = −0.0887
```

两个负数说明：**w 和 b 调大一点，损失会下降**。试走一步（η = 0.5）：`w = 0.5 + 0.5×0.3549 = 0.6774`，`b = −0.5 + 0.5×0.1774 = −0.4113`，新的损失 L = 0.0785，确实比 0.1425 小。

> [!NOTE] 观察
> ∂L/∂w 是 ∂L/∂b 的 **x 倍**（−0.3549 = 2 × −0.1774），因为 z 对 w 的局部导数是 x，对 b 是 1。**输入越大的权重，梯度越大**；这也是输入要标准化的原因之一。

## 五、完整手算 2：2-2-1 网络与 δ 逐层递推

### 1. 设定

2 个输入、2 个 sigmoid 隐藏神经元、1 个线性输出，偏置都取 0 方便手算：

```text
x = (1, 2)       W₁ = | 0.2   0.1 |      W₂ = (0.5, −0.4)      t = 1
                      | −0.1  0.3 |
```

前向：

```text
z = W₁x = (0.2×1 + 0.1×2,  −0.1×1 + 0.3×2) = (0.4, 0.5)
h = σ(z) = (0.5987, 0.6225)
y = 0.5×0.5987 − 0.4×0.6225 = 0.0504
L = (y − 1)² = 0.9018
```

### 2. 反向：先定义 δ

**δ（读“delta”）= L 对某一层“激活前的值 z”的偏导**，可以理解为“这个神经元该为误差负多少责”。反向传播就是算出每一层的 δ，再由 δ 得到参数的梯度。

<figure class="fig">
<svg viewBox="0 0 540 310" class="dg" role="img" aria-label="2-2-1 小网络：每个节点标出前向的数值和反向的误差信号 δ">
<circle class="b1" cx="70" cy="100" r="22"/>
<text class="tb" x="70" y="100" text-anchor="middle" dominant-baseline="middle">x₁</text>
<circle class="b1" cx="70" cy="200" r="22"/>
<text class="tb" x="70" y="200" text-anchor="middle" dominant-baseline="middle">x₂</text>
<circle class="b3" cx="250" cy="100" r="22"/>
<text class="tb" x="250" y="100" text-anchor="middle" dominant-baseline="middle">h₁</text>
<circle class="b3" cx="250" cy="200" r="22"/>
<text class="tb" x="250" y="200" text-anchor="middle" dominant-baseline="middle">h₂</text>
<circle class="b4" cx="410" cy="150" r="22"/>
<text class="tb" x="410" y="150" text-anchor="middle" dominant-baseline="middle">y</text>
<line class="ld" x1="92" y1="100" x2="228" y2="100"/>
<line class="ld" x1="89.2" y1="110.7" x2="230.8" y2="189.3"/>
<line class="ld" x1="89.2" y1="189.3" x2="230.8" y2="110.7"/>
<line class="ld" x1="92" y1="200" x2="228" y2="200"/>
<line class="ld" x1="271" y1="106.6" x2="389" y2="143.4"/>
<line class="ld" x1="271" y1="193.4" x2="389" y2="156.6"/>
<text class="ts" x="330" y="112" text-anchor="middle">0.5</text>
<text class="ts" x="330" y="206" text-anchor="middle">−0.4</text>
<text class="ts" x="70" y="136" text-anchor="middle">x₁ = 1</text>
<text class="ts" x="70" y="236" text-anchor="middle">x₂ = 2</text>
<text class="ts" x="250" y="136" text-anchor="middle">h₁ = 0.5987</text>
<text class="ta" x="250" y="154" text-anchor="middle">δ₁ = −0.2282</text>
<text class="ts" x="250" y="236" text-anchor="middle">h₂ = 0.6225</text>
<text class="ta" x="250" y="254" text-anchor="middle">δ₂ = 0.1785</text>
<text class="ts" x="410" y="186" text-anchor="middle">y = 0.0504</text>
<text class="ta" x="410" y="204" text-anchor="middle">δ_y = −1.899</text>
<text class="th" x="20" y="30" text-anchor="start">2-2-1 网络：蓝/琥珀/红分别是输入/隐藏/输出</text>
<text class="ts" x="20" y="290" text-anchor="start">δ = L 对该节点（激活前）的偏导，每层只用后一层的 δ 算出来</text>
</svg>
<figcaption>图 2：2-2-1 网络：前向算出 h、y、L，反向从 δ_y 递推到隐藏层的 δ</figcaption>
</figure>

```text
① 输出层：  δ_y = ∂L/∂y = 2(y − 1) = −1.8993                       （线性输出，没有激活导数）
② 输出权重：∂L/∂W₂ = δ_y × h = (−1.8993×0.5987, −1.8993×0.6225) = (−1.137, −1.182)
③ 传给隐藏：∂L/∂h = δ_y × W₂ = (−1.8993×0.5, −1.8993×(−0.4)) = (−0.9496, 0.7597)
④ 过 sigmoid：σ′(z) = h(1−h) = (0.2403, 0.2350)
             δ = ∂L/∂z = ∂L/∂h ⊙ σ′(z) = (−0.2282, 0.1785)             （⊙ 读“逐元素相乘”）
⑤ 第一层权重：∂L/∂W₁ = δ × xᵀ = | −0.2282×1  −0.2282×2 | = | −0.2282  −0.4563 |
                                  |  0.1785×1   0.1785×2 |   |  0.1785   0.3571 |
```

数值上 h₁ 的 δ 为负、h₂ 的 δ 为正：因为 W₂ 里 h₁ 的权重是正的、h₂ 是负的，而 y 偏小（0.05 比 1），所以要增大 y——应当增大 h₁、减小 h₂。

### 3. 写成矩阵：δ 逐层递推

设网络有若干层，第 l 层：`z_l = W_l a_{l-1} + b_l`，`a_l = f(z_l)`，`a_0 = x`（输入）。反向传播的全部内容就是这四行：

```text
最后一层：  δ_L = ∂L/∂a_L ⊙ f′(z_L)
往前递推：  δ_l = ( W_{l+1}ᵀ δ_{l+1} ) ⊙ f′(z_l)
权重梯度：  ∂L/∂W_l = δ_l · a_{l-1}ᵀ
偏置梯度：  ∂L/∂b_l = δ_l
```

对着上面的例子：`W₂ᵀδ_y` 就是第 ③ 步的 `(−0.9496, 0.7597)`，`⊙ σ′` 是第 ④ 步，`δ·xᵀ` 是第 ⑤ 步。**为什么是转置？** 前向时 `W` 把输入按权重混合成输出；反向时要把“每个输出的责任”沿着**同样的连线**分回每个输入并求和（这正是上一节“多条路径相加”），写成矩阵就是 `Wᵀ`。形状上也只有这样才对得上：`W` 是 (输出数×输入数)，`Wᵀδ` 才是 (输入数) 个数。

> [!TIP] 反向传播的两个事实
> 1. **一层的 δ 只依赖下一层的 δ**，所以一次从后往前扫描就够了，不必对每个参数各算一遍；
> 2. 反向的计算量和前向**同一个量级**（都是矩阵乘法），所以训练只比推理贵几倍，而不是贵“参数个数”倍。

## 六、梯度消失与爆炸：连乘的代价

从最后一层传到第一层，要连乘很多个因子（每层一个 `Wᵀ` 和一个 `f′`）。**连乘有个特点：因子稍微小于 1，乘多了就趋近 0；稍微大于 1，乘多了就爆炸。**

sigmoid 的导数 `σ′(z) = σ(1−σ)` 在 `z = 0` 处最大，只有 **0.25**。设每一层只乘这个最大值：

| 层数 n | 0.25ⁿ（消失） | 1.5ⁿ（爆炸） |
| --- | --- | --- |
| 1 | 0.25 | 1.5 |
| 3 | 0.0156 | 3.38 |
| 5 | 9.8e-4 | 7.6 |
| 10 | **9.5e-7 ≈ 1e-6** | **57.7** |
| 20 | 9.1e-13 | 3325 |

<figure class="fig">
<svg viewBox="0 0 720 310" class="dg" role="img" aria-label="柱状图：sigmoid 导数最大值 0.25 连乘，1 到 10 层后梯度按对数坐标线性下降，10 层只剩约 1e-6">
<line class="ld" x1="70" y1="40" x2="430" y2="40"/>
<text class="ts" x="62" y="44" text-anchor="end">1</text>
<line class="ld" x1="70" y1="100" x2="430" y2="100"/>
<text class="ts" x="62" y="104" text-anchor="end">1e-2</text>
<line class="ld" x1="70" y1="160" x2="430" y2="160"/>
<text class="ts" x="62" y="164" text-anchor="end">1e-4</text>
<line class="ld" x1="70" y1="220" x2="430" y2="220"/>
<text class="ts" x="62" y="224" text-anchor="end">1e-6</text>
<line class="l" x1="70" y1="250" x2="430" y2="250"/>
<rect class="b3" x="78" y="58.1" width="24" height="191.9" rx="3"/>
<text class="ts" x="90" y="266" text-anchor="middle">1</text>
<rect class="b3" x="111" y="76.1" width="24" height="173.9" rx="3"/>
<text class="ts" x="123" y="266" text-anchor="middle">2</text>
<rect class="b3" x="144" y="94.2" width="24" height="155.8" rx="3"/>
<text class="ts" x="156" y="266" text-anchor="middle">3</text>
<rect class="b3" x="177" y="112.2" width="24" height="137.8" rx="3"/>
<text class="ts" x="189" y="266" text-anchor="middle">4</text>
<rect class="b3" x="210" y="130.3" width="24" height="119.7" rx="3"/>
<text class="ts" x="222" y="266" text-anchor="middle">5</text>
<rect class="b3" x="243" y="148.4" width="24" height="101.6" rx="3"/>
<text class="ts" x="255" y="266" text-anchor="middle">6</text>
<rect class="b3" x="276" y="166.4" width="24" height="83.6" rx="3"/>
<text class="ts" x="288" y="266" text-anchor="middle">7</text>
<rect class="b3" x="309" y="184.5" width="24" height="65.5" rx="3"/>
<text class="ts" x="321" y="266" text-anchor="middle">8</text>
<rect class="b3" x="342" y="202.6" width="24" height="47.4" rx="3"/>
<text class="ts" x="354" y="266" text-anchor="middle">9</text>
<rect class="b4" x="375" y="220.6" width="24" height="29.4" rx="3"/>
<text class="ts" x="387" y="266" text-anchor="middle">10</text>
<text class="ts" x="90" y="52.1" text-anchor="middle">0.25</text>
<text class="ts" x="156" y="88.2" text-anchor="middle">0.0156</text>
<text class="ts" x="222" y="124.3" text-anchor="middle">9.8e-4</text>
<text class="ts" x="387" y="214.6" text-anchor="middle">9.5e-7</text>
<text class="ts" x="250" y="286" text-anchor="middle">层数 n（每层乘一次 σ′ 的最大值 0.25）</text>
<rect class="bg" x="460" y="50" width="250" height="170" rx="12"/>
<text class="tb" x="476" y="74" text-anchor="start">纵轴是对数坐标</text>
<text class="ts" x="476" y="100" text-anchor="start">每过一层，梯度乘 ≤ 0.25</text>
<text class="ts" x="476" y="122" text-anchor="start">10 层后只剩 0.25¹⁰ ≈ 1e-6</text>
<text class="ts" x="476" y="144" text-anchor="start">相当于缩小到百万分之一</text>
<text class="ts" x="476" y="188" text-anchor="start">浅层几乎收不到梯度：</text>
<text class="ts" x="476" y="210" text-anchor="start">权重更新量 = η × 梯度 ≈ 0</text>
</svg>
<figcaption>图 3：梯度消失：0.25 的连乘，10 层只剩百万分之一</figcaption>
</figure>

用真实网络验证：10 层、每层 16 个 sigmoid 神经元（PyTorch 默认初始化），看每层权重的梯度范数：

```python
import torch
torch.manual_seed(0)
layers = [torch.nn.Linear(16, 16) for _ in range(10)]
h = torch.randn(8, 16)
for layer in layers:
    h = torch.sigmoid(layer(h))
h.sum().backward()
for i, layer in enumerate(layers, 1):
    print(f"layer {i:2d}  grad norm {layer.weight.grad.norm().item():.2e}")
# layer  1  grad norm 1.72e-07      ← 最靠近输入
# layer  2  grad norm 1.90e-06
# layer  3  grad norm 1.23e-05
# ...
# layer  9  grad norm 2.24e+00
# layer 10  grad norm 1.57e+01      ← 最靠近输出
```

第 1 层的梯度比第 10 层小了**近 1 亿倍**：靠近输入的层几乎收不到梯度，更新量 `η×梯度 ≈ 0`，学不动。对策见 [训练神经网络](#/aimodel/training)：用 **ReLU/GELU**（正区间导数恰好是 1）、**残差连接**（上面那个 `1 + F′`）、归一化、合适的初始化；爆炸则用**梯度裁剪**。

> [!WARNING] 不是“导数小”就一定消失
> 真正的因子是 `Wᵀ·f′(z)`，**权重的大小也在乘**。0.25 只是 σ′ 的上限；权重很大时也会爆炸。看到训练中损失变成 NaN，先怀疑爆炸。

## 七、自动微分：前向模式与反向模式

求导有三种办法：**手推公式**（易错、换个模型就重来）、**数值差分**（`(f(θ+h)−f(θ))/h`，每个参数要多跑一次前向，几亿个参数不可能）、**自动微分**（框架把计算拆成基本运算，**机械地套链式法则**，结果精确）。

自动微分有两种扫描方向，区别在于链式法则的乘法**从哪头开始乘**：

| | 前向模式 | 反向模式（反向传播） |
| --- | --- | --- |
| 方向 | 随着前向计算，同时算“每个值对**某一个输入**的导数” | 先前向，再从输出往回，算“**某一个输出**对每个值的导数” |
| 一次扫描得到 | 所有输出对**一个**输入的导数 | **一个**输出对所有输入的导数 |
| 适合 | 输入少、输出多 | 输入多、输出少 |

神经网络训练恰好是**一个标量损失 L、几亿个参数**，所以必须用**反向模式**：一次前向加一次反向，就得到全部梯度；前向模式则要跑“参数个数”次。

继续用 `f(x, y) = x·y + sin x`，在 `(2, 3)` 手算对比：

```text
前向模式（只追踪 x）：种子 dx = 1，dy = 0
  v1 = x·y     = 6            dv1 = dx·y + x·dy = 3
  v2 = sin x   = 0.9093       dv2 = cos x · dx   = −0.4161
  f  = v1 + v2 = 6.9093       df  = dv1 + dv2    = 2.5839      ← 只得到 ∂f/∂x，∂f/∂y 要再跑一遍

反向模式：g 表示“f 对该量的偏导”，先令 gf = ∂f/∂f = 1
  g1 = gf = 1，g2 = gf = 1
  gy = x · g1 = 2                                              ← ∂f/∂y
  gx = y · g1 + cos x · g2 = 3 − 0.4161 = 2.5839               ← ∂f/∂x，两条路径相加
  一次扫描，x 和 y 的导数同时得到
```

代价是**反向模式需要前向的中间值**，所以训练时要把每层的激活缓存下来，这就是训练比推理**更吃显存**的主要原因之一；显存不够时用“梯度检查点”（只存一部分、需要时重算）换空间。

## 八、动手：PyTorch autograd 与梯度检验

PyTorch 在你做前向运算时**悄悄记录计算图**，`backward()` 时按反向模式把梯度传回，存进每个参数的 `.grad`。验证第四节的神经元：

```python
import torch

x, t = torch.tensor(2.0), torch.tensor(1.0)
w = torch.tensor(0.5, requires_grad=True)     # requires_grad：这个值要被求导
b = torch.tensor(-0.5, requires_grad=True)

a = torch.sigmoid(w * x + b)                  # 前向
L = (a - t) ** 2
L.backward()                                  # 反向
print(L.item(), w.grad.item(), b.grad.item())
# 0.1425369381904602 -0.3548938035964966 -0.1774469017982483   ← 与手算 −0.3549、−0.1774 一致
```

**梯度检验**（gradient check）：用数值差分检查自己写的反向传播对不对。把每个参数 ±h，用**中心差分** `(L(θ+h) − L(θ−h)) / 2h` 估计梯度，和自动微分的结果比较。检验时要用双精度（float64），否则舍入误差会让检验失败：

```python
import torch
torch.set_default_dtype(torch.float64)

x = torch.tensor([1., 2.])
W1 = torch.tensor([[0.2, 0.1], [-0.1, 0.3]], requires_grad=True)
W2 = torch.tensor([0.5, -0.4], requires_grad=True)

def loss():
    return (W2 @ torch.sigmoid(W1 @ x) - 1.0) ** 2

loss().backward()                             # 自动微分
num, h = torch.zeros_like(W1), 1e-6
with torch.no_grad():                         # 数值微分：逐个参数 ±h
    for i in range(2):
        for j in range(2):
            W1[i, j] += h;     lp = loss().item()
            W1[i, j] -= 2 * h; lm = loss().item()
            W1[i, j] += h
            num[i, j] = (lp - lm) / (2 * h)
print(W1.grad)       # tensor([[-0.2282, -0.4563], [ 0.1785,  0.3571]])
print(num)           # 同上：与第五节手算的 ∂L/∂W₁ 一致
print((W1.grad - num).abs().max().item() < 1e-8)   # True
```

> [!WARNING] autograd 的三个常见坑
> 1. **梯度默认累加**：每次 `backward()` 都会把梯度加到 `.grad` 上，训练循环里每步前要 `optimizer.zero_grad()`；
> 2. `backward()` 只能从**标量**（或指定了上游梯度）出发，计算图用完默认被释放；
> 3. 不想求导的地方（推理、评估）用 `with torch.no_grad():`，省显存也更快。

## 九、对照表：数学对象与神经网络

| 数学概念 | 神经网络里 |
| --- | --- |
| 复合函数 `f(g(x))` | 一层套一层的前向计算 |
| 局部导数 | 每个算子（加、乘、σ、ReLU、softmax）自带的反向规则 |
| 链式法则 | 反向传播的核心：上游梯度 × 局部导数 |
| 多路径相加 | 残差连接、权重共享、一个神经元连多个下游 |
| δ_l = (W_{l+1}ᵀ δ_{l+1}) ⊙ f′(z_l) | 反向传播逐层递推 |
| 连乘因子 < 1 / > 1 | 梯度消失 / 爆炸；ReLU、残差、归一化、裁剪是对策 |
| 反向模式自动微分 | `loss.backward()`，一个标量损失对全部参数 |
| 数值差分 | 梯度检验，只用来调试 |

## 自测：你真的懂了吗？

> [!QUESTION] 用链式法则求 `y = (2x − 1)³` 在 x = 1 处的导数。
> 令 `u = 2x − 1`，`y = u³`：`dy/du = 3u²`，`du/dx = 2`，所以 `dy/dx = 6u²`。x = 1 时 u = 1，导数 = 6。注意外层 `3u²` 要在 u（而不是 x）处取值。

> [!QUESTION] 单神经元例子里，如果把 x 从 2 改成 4（其余不变），∂L/∂w 会变成多少？提示：先重算 z。
> z = 0.5×4 − 0.5 = 1.5，a = σ(1.5) = 0.8176，∂L/∂a = 2(0.8176−1) = −0.3648，σ′ = 0.8176×0.1824 = 0.1491，∂L/∂z = −0.0544，∂L/∂w = x×∂L/∂z = 4×(−0.0544) = −0.2176。注意 x 变大会使 z、a 一起变，不能只把旧结果乘 2。

> [!QUESTION] 为什么训练神经网络用反向模式自动微分，而不用前向模式？
> 训练只有 **1 个标量损失**，但有 **n 个参数（可达几十亿）**。反向模式一次反向扫描得到所有参数的梯度，前向模式每次只能得到对一个输入的导数，需要扫描 n 次。代价是反向模式要缓存前向的中间值，占显存。

> [!QUESTION] 10 层 sigmoid 网络里，若每层只乘 σ′ 的最大值 0.25，传到第 1 层的梯度约缩小多少倍？换成 ReLU（正区间导数为 1）会怎样？
> 0.25¹⁰ ≈ 9.5×10⁻⁷，约缩小到百万分之一。ReLU 在激活的神经元上导数是 1，这一项不再缩小（但权重和被置 0 的神经元仍会影响，所以还需要合适的初始化和归一化）。

> [!QUESTION] 为什么反向传播的递推里出现的是 `Wᵀ`，而不是 `W`？
> 前向时 W 把“输入”混合成“输出”。反向要把“每个输出的误差”沿着同样的连线分回每个输入，并对同一输入连向的多个输出求和（多路径相加），这等价于乘 `Wᵀ`；形状上，只有 `Wᵀ` 才能把输出维度的 δ 变回输入维度。

> [!QUESTION] 为什么每次 `loss.backward()` 之前要先清零梯度？
> PyTorch 的 `.grad` 是**累加**的（共享权重、梯度累积等场景需要这个性质）。如果不清零，这一步的梯度会叠在上一步上，参数会被错误地更新。

## 相关阅读

- [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)：同一套反向传播，ReLU 版本的手算
- [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)：梯度消失/爆炸、初始化、残差与梯度裁剪的工程对策
- [偏导数与梯度：多个旋钮的世界](#/math/gradient)：本页里“偏导数”和“梯度向量”的细讲
- [极值与优化：从梯度下降到 Adam，再到约束优化](#/math/optimization)：拿到梯度之后怎么更新参数
