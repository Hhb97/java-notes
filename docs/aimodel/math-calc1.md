---
level: 基础
tags: [微积分, 导数, 极限, 偏导数, 梯度, 链式法则, 积分, 入门]
summary: 零基础讲微积分在 AI 里最关键的部分：导数是“变化的快慢”，偏导数是“只动一个旋钮”，梯度是“上升最快的方向”，链式法则是“一环扣一环”；并简要说明积分与概率的联系。
---

# 微积分 1：导数、偏导与链式法则

> [!ABSTRACT] 一句话版本
> - **导数** = 函数在某一点**变化得有多快**（切线的斜率）。
> - **偏导数** = 函数有很多个输入（很多旋钮）时，**只拧其中一个**，输出变化多快。
> - **梯度** = 把所有偏导数排成一个向量，它**指向函数上升最快的方向**。
> - **链式法则** = 一环扣一环的变化可以**逐环相乘**；它是**反向传播**的数学基础。
> - 积分 = 累加、求面积，在 AI 里主要出现在**概率**（概率密度下的面积）。
> - 学会这一页，你就知道神经网络“怎么知道每个参数该往哪调”。

## 一、为什么 AI 需要微积分

训练一个模型，本质是**调参数，让“错误”变小**：

```text
错误（损失）= 模型预测 与 正确答案 的差距
目标：找到一组参数，让损失最小
```

调参数时有个关键问题：**把某个参数调大一点，损失是变大还是变小？变多少？**
——这正是**导数**回答的问题。微积分给了我们“指南针”，告诉每个参数该往哪个方向、走多大步。

## 二、导数：变化有多快

### 1. 从“速度”理解

你开车，里程表读数随时间增加。**速度 = 位置变化 ÷ 时间变化**。如果速度时快时慢，那么“**某一个瞬间的速度**”就是位置对时间的**导数**。

> 导数 = **瞬时变化率** = 函数曲线在该点的**切线斜率**。

### 2. 从“割线”到“切线”

取曲线 `f(x) = x²` 上的点 `x = 1`。再取一个邻居点 `x = 1 + h`：

```text
割线斜率 = [ f(1+h) − f(1) ] ÷ h = [ (1+h)² − 1 ] ÷ h = (2h + h²) ÷ h = 2 + h
```

邻居点越靠近（h 越小），割线斜率越接近 **2**。**当 h → 0 时，斜率就是 2**——这就是 `f(x)=x²` 在 x=1 处的**导数**。

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="抛物线 y=x² 上，割线随着第二个点靠近而逐渐变成切线，切线斜率就是导数">
<line class="l" x1="50" y1="280" x2="420" y2="280" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="280" x2="50" y2="20" marker-end="url(#arr)"/>
<path class="l" d="M50 280 Q 150 280 250 160 T 400 30"/>
<path class="b1 nf" d="M70 273 Q 150 262 230 178 Q 290 110 340 55"/>
<circle class="bf" cx="190" cy="215" r="5"/>
<text class="ts" x="196" y="236" text-anchor="start">x = 1</text>
<circle class="b3" cx="270" cy="150" r="5"/>
<text class="ts" x="276" y="172" text-anchor="start">x = 1+h</text>
<line class="ld" x1="150" y1="245" x2="310" y2="105"/>
<text class="ts" x="316" y="100" text-anchor="start">割线（斜率 2+h）</text>
<line class="la" x1="130" y1="262" x2="260" y2="168" marker-end="url(#arr-a)"/>
<text class="ta" x="266" y="164" text-anchor="start">切线（斜率 = 导数 = 2）</text>
<rect class="bg" x="460" y="40" width="260" height="240" rx="12"/>
<text class="th" x="476" y="64">h 越小，割线越像切线</text>
<text class="tm" x="476" y="96">h = 1    → 斜率 3</text>
<text class="tm" x="476" y="120">h = 0.1  → 斜率 2.1</text>
<text class="tm" x="476" y="144">h = 0.01 → 斜率 2.01</text>
<text class="tm" x="476" y="168">h → 0    → 斜率 2</text>
<text class="ta" x="476" y="204">所以 (x²)′ = 2x</text>
<text class="ts" x="476" y="228">x = 1 时导数为 2；x = 3 时为 6</text>
<text class="ts" x="476" y="252">离原点越远，曲线越陡</text>
</svg>
<figcaption>图 1：割线 → 切线：导数就是切线的斜率</figcaption>
</figure>

### 3. 导数的符号告诉你方向

| 导数 | 含义 | 想让函数变小，该怎么走 |
| --- | --- | --- |
| **> 0** | 函数在上升 | **向左**走（减小 x） |
| **< 0** | 函数在下降 | **向右**走（增大 x） |
| **= 0** | 平的（可能是谷底、山顶或平台） | 到了“驻点” |

这就是梯度下降的核心：**沿着导数的反方向走，函数就会变小**。详见 [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)。

### 4. 常用求导公式（记住这几个就够用）

| 函数 | 导数 | 说明 |
| --- | --- | --- |
| 常数 `c` | `0` | 不变化 |
| `x` | `1` | 斜率恒为 1 |
| `xⁿ` | `n·xⁿ⁻¹` | `x²→2x`，`x³→3x²` |
| `eˣ` | `eˣ` | 导数是它自己 |
| `ln x` | `1/x` | |
| `sin x` | `cos x` | |
| **sigmoid** `σ(x)=1/(1+e⁻ˣ)` | `σ(x)·(1−σ(x))` | 神经网络常用 |
| **ReLU** `max(0,x)` | x>0 时为 1，x<0 时为 0 | 神经网络最常用的激活函数 |

**三条运算规则**：

| 规则 | 公式 | 例子 |
| --- | --- | --- |
| 和 | `(f+g)′ = f′ + g′` | `(x²+3x)′ = 2x+3` |
| 常数倍 | `(c·f)′ = c·f′` | `(5x²)′ = 10x` |
| 乘积 | `(f·g)′ = f′g + fg′` | `(x·eˣ)′ = eˣ + x·eˣ` |

## 三、偏导数：只拧一个旋钮

现实中的函数往往有**很多输入**。比如“房价”取决于面积 x 和房龄 y：

```text
f(x, y) = x² + 3xy
```

想知道“**只改变 x（y 保持不动）**，f 变化多快”——把 y 当成常数，对 x 求导：

```text
∂f/∂x = 2x + 3y          （y 当常数，3xy 对 x 求导得 3y）
∂f/∂y = 3x               （x 当常数，x² 看成常数，导数为 0；3xy 对 y 求导得 3x）
```

符号 `∂`（读作“偏”）表示**偏导数**。在点 `(x=1, y=2)`：

```text
∂f/∂x = 2×1 + 3×2 = 8      → x 稍微增大，f 增大约 8 倍
∂f/∂y = 3×1 = 3            → y 稍微增大，f 增大约 3 倍
```

> [!TIP] 神经网络有几亿个旋钮
> 一个模型的损失函数 L 取决于**几亿个参数**。**对每一个参数求一个偏导数**，就知道“这个参数调一点，损失怎么变”。这些偏导数合起来，就是下面的梯度。

## 四、梯度：把所有偏导数打包

把所有偏导数**按顺序排成一个向量**，就是**梯度**，记作 `∇f`（读作“nabla f”）：

```text
f(x, y) = x² + 3xy
∇f = ( ∂f/∂x ,  ∂f/∂y ) = ( 2x + 3y ,  3x )
在 (1, 2) 处：∇f = (8, 3)
```

**梯度的两个关键性质**：

1. **方向**：指向函数**上升最快**的方向；
2. **长度**：越长，说明那里越“陡”。

所以：**想让函数下降最快，就朝着梯度的相反方向（−∇f）走**。

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="等高线图上的梯度：梯度垂直于等高线、指向数值升高最快的方向，负梯度指向下山最快的方向">
<ellipse class="b1 nf" cx="240" cy="160" rx="190" ry="120"/>
<ellipse class="b2 nf" cx="240" cy="160" rx="140" ry="88"/>
<ellipse class="b3 nf" cx="240" cy="160" rx="90" ry="56"/>
<ellipse class="b4 nf" cx="240" cy="160" rx="40" ry="25"/>
<circle class="bf" cx="240" cy="160" r="4"/>
<text class="ts" x="248" y="156" text-anchor="start">谷底（最小值）</text>
<circle class="b" cx="340" cy="100" r="5"/>
<text class="ts" x="348" y="96" text-anchor="start">当前位置</text>
<line class="la" x1="340" y1="100" x2="378" y2="62" marker-end="url(#arr-a)"/>
<text class="ta" x="384" y="58" text-anchor="start">梯度 ∇f（上坡最快）</text>
<line class="l" x1="340" y1="100" x2="300" y2="138" marker-end="url(#arr)"/>
<text class="tb" x="228" y="206" text-anchor="start">−∇f：下山最快</text>
<rect class="bg" x="470" y="40" width="250" height="240" rx="12"/>
<text class="th" x="486" y="64">把它想成下山</text>
<text class="ts" x="486" y="92">等高线：同一圈上高度相同</text>
<text class="ts" x="486" y="114">梯度：这一点“最陡的上坡方向”</text>
<text class="ts" x="486" y="136">垂直于所在的等高线</text>
<text class="ts" x="486" y="168">雾很大看不见全貌时，</text>
<text class="ts" x="486" y="188">你只能感觉脚下哪边更陡，</text>
<text class="ts" x="486" y="208">然后朝“最陡的下坡”迈一步。</text>
<text class="ta" x="486" y="240">这正是机器学习的训练方式。</text>
</svg>
<figcaption>图 2：梯度垂直于等高线，指向上坡；沿负梯度走就是最快下山</figcaption>
</figure>

## 五、链式法则：一环扣一环

### 1. 直觉

自行车：脚踏转 1 圈 → 齿轮转 2 圈 → 后轮转 3 圈。那么脚踏转 1 圈，后轮转多少圈？**逐环相乘：2 × 3 = 6**。

数学上：如果 `y` 依赖 `u`，`u` 依赖 `x`，那么

```text
dy/dx = (dy/du) × (du/dx)
```

### 2. 例子

求 `y = (3x + 1)²` 的导数。拆成两环：`u = 3x + 1`，`y = u²`：

```text
dy/du = 2u          du/dx = 3
dy/dx = 2u × 3 = 6u = 6(3x + 1)
```

当 `x = 1`：`u = 4`，导数 `= 6 × 4 = 24`。

### 3. 神经网络就是“很长的链”

一个简单网络：输入 x → 乘权重 w → 加偏置 → 激活 → 得到预测 → 和真实值比较得到损失 L。想知道 **L 对 w 的导数**，就**沿着这条链反向逐环相乘**：

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="计算图：x 经过乘以权重 w、加偏置、激活得到预测，再与目标比较得到损失；反向传播时沿链逐环相乘求导数">
<rect class="b1" x="20" y="70" width="80" height="50" rx="8"/>
<text class="tb" x="60" y="95" text-anchor="middle" dominant-baseline="middle">x</text>
<rect class="b3" x="140" y="70" width="110" height="50" rx="8"/>
<text class="tb" x="195" y="88" text-anchor="middle" dominant-baseline="middle">z = w·x + b</text>
<text class="ts" x="195" y="108" text-anchor="middle">线性</text>
<rect class="b3" x="290" y="70" width="110" height="50" rx="8"/>
<text class="tb" x="345" y="88" text-anchor="middle" dominant-baseline="middle">a = σ(z)</text>
<text class="ts" x="345" y="108" text-anchor="middle">激活</text>
<rect class="b4" x="440" y="70" width="130" height="50" rx="8"/>
<text class="tb" x="505" y="88" text-anchor="middle" dominant-baseline="middle">L = (a − t)²</text>
<text class="ts" x="505" y="108" text-anchor="middle">损失（t 是答案）</text>
<line class="l" x1="100" y1="95" x2="140" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="95" x2="290" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="95" x2="440" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="620" y="86" text-anchor="start">← 前向：算出损失</text>
<line class="la" x1="440" y1="150" x2="140" y2="150" marker-end="url(#arr-a)"/>
<text class="ta" x="290" y="174" text-anchor="middle">反向：逐环求导再相乘</text>
<text class="tm" x="40" y="206" text-anchor="start">∂L/∂w = (∂L/∂a) × (∂a/∂z) × (∂z/∂w) = 2(a−t) × σ′(z) × x</text>
<text class="ts" x="40" y="228" text-anchor="start">每一环的导数都很简单，乘起来就得到“w 该怎么调”——这就是反向传播</text>
</svg>
<figcaption>图 3：链式法则：沿着计算链反向逐环相乘，得到每个参数的梯度</figcaption>
</figure>

具体数字：设 `x=1, w=0.5, b=0, t=1`，激活用 sigmoid：

```text
z = 0.5×1 + 0 = 0.5
a = σ(0.5) ≈ 0.622                       （预测 0.622，目标 1，差得有点远）
L = (0.622 − 1)² ≈ 0.143
∂L/∂a = 2(0.622 − 1) = −0.756
∂a/∂z = a(1−a) = 0.622×0.378 ≈ 0.235
∂z/∂w = x = 1
∂L/∂w = (−0.756) × 0.235 × 1 ≈ −0.178      ← 负数：w 增大一点，损失会下降！
```

结论：**应该把 w 调大**。梯度告诉了我们方向。完整的反向传播见 [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)。

## 六、积分：累加与面积（够用版）

**积分**是导数的“逆运算”，也是“把很多很小的量加起来”：

- 速度对时间积分 = 走过的**距离**；
- 曲线下方的**面积** = 积分。

```text
∫₀¹ x² dx = 1/3        （曲线 y=x² 在 0 到 1 之间与 x 轴围成的面积）
```

**在 AI 里它主要出现在概率**：连续变量（如身高）的概率用**概率密度曲线下的面积**表示，整条曲线下的总面积为 1；**期望**也是积分。初学阶段只需理解“积分 = 累加 = 面积”，详见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)。

## 七、泰勒展开：为什么“沿梯度走”有效（选读）

在一个点附近，**任何光滑函数都像一条直线**（想象放大地图，弯曲的路看起来是直的）：

```text
f(x + Δ) ≈ f(x) + f′(x)·Δ        （用切线近似）
```

所以当步子 Δ 很小，且取 `Δ = −η·f′(x)`（η 是小步长）时：

```text
f(x + Δ) ≈ f(x) − η·[f′(x)]²  ≤  f(x)         （平方非负，所以一定变小）
```

这就是**梯度下降能让损失下降**的数学保证；**步子不能太大**，否则“像直线”的近似不再成立，反而会越走越糟。

## 八、动手：数值验证导数

```python
import numpy as np

f = lambda x: x**2
x, h = 1.0, 1e-6
print((f(x + h) - f(x)) / h)           # ≈ 2.0000，数值导数

sigmoid = lambda z: 1 / (1 + np.exp(-z))
w, x, b, t = 0.5, 1.0, 0.0, 1.0
L = lambda w: (sigmoid(w * x + b) - t) ** 2
print((L(w + h) - L(w)) / h)           # ≈ -0.178，和上面手算的 ∂L/∂w 一致！

# 用 PyTorch 自动求导（现代框架帮你做链式法则）
import torch
w = torch.tensor(0.5, requires_grad=True)
loss = (torch.sigmoid(w * 1.0) - 1.0) ** 2
loss.backward()
print(w.grad)                           # tensor(-0.1778)
```

## 九、小结表

| 概念 | 一句话 | 在 AI 里 |
| --- | --- | --- |
| 导数 | 变化快慢 / 切线斜率 | 判断参数调大还是调小 |
| 偏导数 | 只动一个变量 | 每个参数各自的影响 |
| 梯度 | 所有偏导数组成的向量，指向上坡 | 梯度下降的“指南针” |
| 链式法则 | 逐环相乘 | **反向传播** |
| 积分 | 累加 / 面积 | 概率、期望 |
| 泰勒展开 | 局部像直线 | 解释为什么小步下降有效 |

## 自测：你真的懂了吗？

> [!QUESTION] 函数 f(x)=x² 在 x=3 处的导数是多少？它说明了什么？
> 导数是 2x = 6。说明在 x=3 处曲线斜率为 6，x 稍微增大一点，f 会增大约 6 倍那么多；想让 f 变小，应该往左（减小 x）。

> [!QUESTION] f(x,y)=x²+3xy，在 (1,2) 处的梯度是多少？
> ∂f/∂x = 2x+3y = 8，∂f/∂y = 3x = 3，所以梯度是 (8, 3)。它指向 f 上升最快的方向，下降最快的方向是 (−8, −3)。

> [!QUESTION] 为什么说链式法则是反向传播的基础？
> 神经网络的损失是由许多层函数一层套一层得到的。要求损失对某个参数的导数，需要把每一层的局部导数从后往前逐个相乘，这正是链式法则；反向传播就是高效地把这个过程对所有参数一次算完。

> [!QUESTION] 求 y=(3x+1)² 的导数，并说出你用了哪条规则。
> 用链式法则：令 u=3x+1，则 dy/du=2u，du/dx=3，所以 dy/dx=6(3x+1)。
