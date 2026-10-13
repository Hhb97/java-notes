---
level: 基础
tags: [梯度下降, 学习率, SGD, 动量, Adam, 损失函数, 优化, 入门]
summary: 用“蒙眼下山”的比喻讲清梯度下降：公式与手算例子、学习率的三种命运、局部最小与鞍点、随机梯度与小批量、动量与 Adam；并用线性回归完整演示一次“机器学习”的过程。
---

# 微积分 2：梯度下降，机器如何“学习”

> [!ABSTRACT] 一句话版本
> **机器学习 = 定义一个“错得有多离谱”的函数（损失），然后用梯度下降一步步把它调到最小。**
> - 梯度下降：每一步都算**当前位置的梯度**，然后**朝反方向走一小步**：`参数 ← 参数 − 学习率 × 梯度`。
> - **学习率**就是步子大小：太小走得慢，太大会来回震荡甚至发散。
> - 实际训练用**随机/小批量**梯度下降（每次只用一小批数据估算梯度），再配上**动量、Adam** 等技巧走得又快又稳。
> - 这一页的内容，就是几乎所有神经网络（包括 ChatGPT）训练的核心循环。

> [!NOTE] 先决条件
> 需要了解导数、梯度的含义，见 [微积分 1：导数、偏导与链式法则](#/aimodel/math-calc1)。

## 一、蒙眼下山

想象你被蒙住眼睛放在山坡上，目标是走到**谷底**。你看不到全貌，但可以**用脚感觉地面的倾斜**：

1. 感受脚下哪个方向**下坡最陡**；
2. 朝那个方向**迈一小步**；
3. 重复，直到脚下**变平**（到了谷底）。

对应关系：

| 下山 | 机器学习 |
| --- | --- |
| 你的位置 | 模型的参数（权重） |
| 海拔高度 | **损失**（错误程度） |
| 脚下的坡度 | **梯度** |
| 迈一步 | **更新参数** |
| 步子大小 | **学习率** |
| 谷底 | 损失最小，模型最好 |

## 二、公式与第一个手算例子

```text
新参数  =  旧参数  −  学习率 η  ×  梯度
  w     ←    w     −     η       ×   ∂L/∂w
```

**减号**是关键：梯度指向上坡，我们要下坡，所以**反着走**。

### 例子：找 L(w) = (w − 3)² 的最小值

最小值显然在 w=3（此时 L=0）。让计算机从 **w = 0** 出发，学习率 **η = 0.1**：

```text
梯度：dL/dw = 2(w − 3)

第 0 步：w = 0     梯度 = 2(0−3)   = −6     w ← 0 − 0.1×(−6)   = 0.6
第 1 步：w = 0.6   梯度 = 2(0.6−3) = −4.8   w ← 0.6 + 0.48     = 1.08
第 2 步：w = 1.08  梯度 = −3.84             w ← 1.08 + 0.384   = 1.464
第 3 步：w = 1.464 梯度 = −3.072            w ← 1.464 + 0.307  = 1.771
……
约 20 次更新后：w ≈ 2.97
```

每走一步，**距离最小值越来越近，坡度（梯度）也越来越小，步子自动变小**——这是梯度下降一个很漂亮的性质。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="损失曲线 L=(w-3)^2 的碗形图，参数点从 w=0 开始沿曲线逐步下降靠近最小值 w=3">
<line class="l" x1="50" y1="280" x2="470" y2="280" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="280" x2="50" y2="20" marker-end="url(#arr)"/>
<text class="ts" x="478" y="284" text-anchor="start">w</text>
<text class="ts" x="44" y="22" text-anchor="end">L</text>
<path class="l nf" d="M70 40 Q 200 300 330 280 T 460 40"/>
<path class="b1 nf" d="M70 60 Q 190 270 260 270 Q 330 270 450 60"/>
<circle class="b4" cx="86" cy="105" r="6"/>
<text class="ts" x="94" y="102" text-anchor="start">w=0</text>
<circle class="b3" cx="130" cy="180" r="5"/>
<text class="ts" x="140" y="178" text-anchor="start">0.6</text>
<circle class="b3" cx="170" cy="225" r="5"/>
<text class="ts" x="178" y="228" text-anchor="start">1.08</text>
<circle class="b3" cx="205" cy="252" r="5"/>
<circle class="b3" cx="232" cy="264" r="5"/>
<circle class="b2" cx="262" cy="270" r="6"/>
<text class="ta" x="262" y="296" text-anchor="middle">谷底 w=3</text>
<line class="la" x1="94" y1="118" x2="124" y2="168" marker-end="url(#arr-a)"/>
<rect class="bg" x="500" y="40" width="240" height="240" rx="12"/>
<text class="th" x="516" y="64">每一步</text>
<text class="ts" x="516" y="92">1. 算梯度：2(w−3)</text>
<text class="ts" x="516" y="114">2. 反方向走一小步：</text>
<text class="tm" x="516" y="136">w ← w − 0.1×梯度</text>
<text class="ts" x="516" y="168">越靠近谷底，坡越缓，</text>
<text class="ts" x="516" y="188">步子越小，最后停在谷底</text>
<text class="ta" x="516" y="224">w: 0 → 0.6 → 1.08 → 1.46 → …</text>
<text class="ta" x="516" y="248">→ 3</text>
</svg>
<figcaption>图 1：梯度下降沿着碗形损失曲线逐步走向谷底</figcaption>
</figure>

## 三、学习率：步子大小决定命运

同一个问题 `L(w)=(w−3)²`，不同学习率：

| 学习率 | 过程（从 w=0 出发） | 结果 |
| --- | --- | --- |
| **太小** η=0.01 | 每步只走一点点：0 → 0.06 → 0.12 → 0.18 → … | 收敛，但**极慢** |
| **合适** η=0.1 | 0 → 0.6 → 1.08 → 1.46 → … | **平稳收敛** |
| **偏大** η=0.9 | 0 → 5.4 → 1.08 → 4.54 → …（来回跨过谷底） | **剧烈震荡**，收敛慢 |
| **太大** η=1.1 | 0 → 6.6 → −1.32 → 8.18 → …（越跳越远） | **发散**，损失越来越大 |

为什么？这道题里，每一步“离最优解的距离”都会乘上 `(1 − 2η)`：η=0.1 时乘 0.8（越来越近）；η=1.1 时乘 −1.2，**绝对值大于 1**，距离越来越大。

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="三种学习率对比：太小收敛慢、合适快速收敛、太大来回震荡甚至发散">
<text class="th" x="20" y="22">太小：慢吞吞</text>
<path class="l nf" d="M20 200 Q 70 220 120 200 T 220 200"/>
<circle class="b3" cx="40" cy="120" r="3"/>
<circle class="b3" cx="52" cy="140" r="3"/>
<circle class="b3" cx="63" cy="157" r="3"/>
<circle class="b3" cx="74" cy="172" r="3"/>
<circle class="b3" cx="85" cy="184" r="3"/>
<text class="ts" x="120" y="236" text-anchor="middle">走很久才到</text>
<text class="th" x="270" y="22">合适：稳稳到位</text>
<path class="l nf" d="M270 200 Q 320 220 370 200 T 470 200"/>
<circle class="b2" cx="290" cy="120" r="3"/>
<circle class="b2" cx="320" cy="170" r="3"/>
<circle class="b2" cx="345" cy="198" r="3"/>
<circle class="b2" cx="368" cy="208" r="3"/>
<text class="ts" x="370" y="236" text-anchor="middle">几步就够</text>
<text class="th" x="520" y="22">太大：来回蹦甚至飞走</text>
<path class="l nf" d="M520 200 Q 570 220 620 200 T 720 200"/>
<circle class="b4" cx="535" cy="110" r="3"/>
<circle class="b4" cx="690" cy="95" r="3"/>
<circle class="b4" cx="520" cy="60" r="3"/>
<circle class="b4" cx="715" cy="40" r="3"/>
<line class="ld" x1="535" y1="110" x2="690" y2="95"/>
<line class="ld" x1="690" y1="95" x2="520" y2="60"/>
<line class="ld" x1="520" y1="60" x2="715" y2="40"/>
<text class="ts" x="620" y="236" text-anchor="middle">越跳越高（发散）</text>
</svg>
<figcaption>图 2：学习率太小、合适、太大的三种命运</figcaption>
</figure>

> [!TIP] 实战经验
> 学习率是训练里**最重要的超参数**。常见做法：从小的值试起（如 1e-3、1e-4），观察损失曲线；用**学习率预热 + 衰减**（先小后大再慢慢变小）让训练更稳，见 [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)。

## 四、多个参数、更复杂的地形

真实模型有几亿个参数，“山”是几亿维的，画不出来，但**规则完全一样**：对**每个参数**求偏导（得到梯度向量），**每个参数同时**减去 `η × 自己的偏导`。

```text
θ = (w₁, w₂, …, wₙ)        ∇L = (∂L/∂w₁, ∂L/∂w₂, …, ∂L/∂wₙ)
θ ← θ − η · ∇L
```

### 等高线视角

二维的“山”可以用**等高线**画。沿梯度下降会走出一条曲线。如果山谷是**又窄又长的椭圆形**（不同方向的坡度差很大），路径会**来回“之”字形**震荡：

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="椭圆形等高线上，普通梯度下降走之字形路径，带动量的梯度下降更直接地靠近最小值">
<ellipse class="b1 nf" cx="200" cy="150" rx="170" ry="55"/>
<ellipse class="b2 nf" cx="200" cy="150" rx="120" ry="38"/>
<ellipse class="b3 nf" cx="200" cy="150" rx="70" ry="22"/>
<circle class="bf" cx="200" cy="150" r="4"/>
<polyline class="ld nf" points="50,70 85,215 108,90 135,195 152,115 170,175 182,135 192,160"/>
<text class="ts" x="40" y="60" text-anchor="start">普通梯度下降：之字形，慢</text>
<ellipse class="b1 nf" cx="560" cy="150" rx="170" ry="55"/>
<ellipse class="b2 nf" cx="560" cy="150" rx="120" ry="38"/>
<ellipse class="b3 nf" cx="560" cy="150" rx="70" ry="22"/>
<circle class="bf" cx="560" cy="150" r="4"/>
<polyline class="la nf" points="410,70 450,125 495,148 535,150 556,150"/>
<text class="ta" x="400" y="60" text-anchor="start">带动量：抵消来回，更直接</text>
<text class="ts" x="380" y="280" text-anchor="middle">山谷越“扁长”，普通梯度下降越容易之字形；动量与 Adam 让路线更平滑</text>
</svg>
<figcaption>图 3：椭圆山谷里普通梯度下降会震荡，动量能缓解</figcaption>
</figure>

## 五、实战：用梯度下降拟合一条直线

### 问题

已知三个数据点 `(1,2)`、`(2,4)`、`(3,6)`（实际上就是 y=2x），让模型 `ŷ = w·x` 自己找到 **w**。

### 定义损失（均方误差）

```text
L(w) = 1/3 · Σ (w·xᵢ − yᵢ)²
```

### 梯度

```text
dL/dw = 2/3 · Σ xᵢ·(w·xᵢ − yᵢ)
```

### 手算前两步（η = 0.05，初始 w = 0）

```text
第 1 步：w = 0
  w·x − y：          (0−2, 0−4, 0−6) = (−2, −4, −6)
  x·(w·x − y)：      (−2, −8, −18)，求和 = −28
  dL/dw = 2/3 × (−28) ≈ −18.67
  w ← 0 − 0.05 × (−18.67) = 0.933

第 2 步：w = 0.933
  w·x − y：          (−1.07, −2.13, −3.2)
  x·(w·x − y)：      (−1.07, −4.27, −9.6)，求和 ≈ −14.93
  dL/dw ≈ −9.96
  w ← 0.933 + 0.498 = 1.431
……
继续下去，w 会逐渐逼近 2（损失趋近 0）。
```

**这就是“机器学习”最本质的一幕**：我们没有告诉它 w=2，它只是不断地“看错误→算梯度→改参数”，自己找到了规律。

### 代码

```python
import numpy as np

x = np.array([1., 2., 3.]); y = np.array([2., 4., 6.])
w, lr = 0.0, 0.05
for step in range(100):
    pred = w * x
    loss = np.mean((pred - y) ** 2)
    grad = 2 * np.mean(x * (pred - y))       # dL/dw
    w -= lr * grad                           # 梯度下降更新
    if step % 20 == 0:
        print(f"step {step:3d}  w={w:.4f}  loss={loss:.5f}")
# 最终 w 非常接近 2.0
```

## 六、随机梯度下降（SGD）与小批量

上面每次都用**全部数据**算梯度（“批量梯度下降”）。真实数据有几百万、几亿条，每走一步都要扫一遍全部数据，太慢了。

| 方法 | 每步用多少数据 | 特点 |
| --- | --- | --- |
| **批量 GD** | 全部 | 梯度准确，但每步极慢，且占内存 |
| **随机 GD（SGD）** | **1 条** | 很快，但梯度**噪声大**，路线抖动 |
| **小批量 Mini-batch** | **一小批（如 32/256）** | **折中，最常用**，GPU 并行效率高 |

- 一个**epoch** = 把全部数据完整看一遍；
- 一个 **iteration（步）** = 用一个 mini-batch 更新一次参数；
- 梯度里的“噪声”反而有好处：帮助跳出一些**局部坑**。

## 七、地形的麻烦：局部最小、鞍点与平原

| 地形 | 说明 | 影响 |
| --- | --- | --- |
| **凸函数（碗）** | 只有一个谷底 | 梯度下降一定能到底（线性回归、逻辑回归） |
| **局部最小** | 一个小坑，不是全局最低 | 可能被“困住”；但神经网络里高维空间中真正的坏局部最小**并不常见** |
| **鞍点** | 一个方向是谷底、另一个方向是山顶（像马鞍） | 梯度为 0 但不是最小；高维里很常见；带噪声/动量的方法能逃脱 |
| **平原（平坦区）** | 梯度几乎为 0 | 训练长时间不动；与梯度消失有关 |

> [!NOTE] 神经网络的损失面是“高维崎岖地形”
> 虽然理论上没有“一定到达全局最优”的保证，但实践证明：**用足够大的网络 + 合适的优化器，通常能找到“足够好”的解**。

## 八、更聪明的下山：动量与 Adam

### 1. 动量（Momentum）：像一个滚下山的球

不仅看当前坡度，还**保留之前的速度**：

```text
v ← β·v + 梯度          （β 通常 0.9）
w ← w − η·v
```

- 在一致下坡的方向上，速度越攒越大，**越滚越快**；
- 在来回震荡的方向上，正负**相互抵消**，震荡减弱。

### 2. 自适应学习率：每个参数有自己的步长

有的参数梯度总是很大，有的总是很小，**用同一个学习率不合理**。

- **AdaGrad / RMSProp**：根据历史梯度大小，给每个参数自动**缩放步长**（梯度大的步子缩小，小的放大）；
- **Adam**：**动量 + 自适应学习率**的结合，几乎成了深度学习的默认优化器（Transformer、LLM 训练常用其变体 **AdamW**）。

| 优化器 | 特点 | 常见用途 |
| --- | --- | --- |
| SGD | 简单、泛化好，需要仔细调学习率 | 图像分类（CNN）常用 + 动量 |
| SGD + Momentum | 更快更稳 | 经典 CNN 训练 |
| **Adam / AdamW** | 自适应、省心、收敛快 | **Transformer、大模型、大多数场景** |

## 九、一张图看清训练循环

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="训练循环：取一批数据，前向计算预测，计算损失，反向传播求梯度，优化器更新参数，然后重复">
<rect class="b1" x="20" y="60" width="120" height="70" rx="10"/>
<text class="tb" x="80" y="84" text-anchor="middle" dominant-baseline="middle">① 取一批数据</text>
<text class="ts" x="80" y="106" text-anchor="middle">mini-batch</text>
<rect class="b3" x="170" y="60" width="120" height="70" rx="10"/>
<text class="tb" x="230" y="84" text-anchor="middle" dominant-baseline="middle">② 前向计算</text>
<text class="ts" x="230" y="106" text-anchor="middle">得到预测</text>
<rect class="b4" x="320" y="60" width="120" height="70" rx="10"/>
<text class="tb" x="380" y="84" text-anchor="middle" dominant-baseline="middle">③ 算损失</text>
<text class="ts" x="380" y="106" text-anchor="middle">预测 vs 答案</text>
<rect class="b5" x="470" y="60" width="120" height="70" rx="10"/>
<text class="tb" x="530" y="84" text-anchor="middle" dominant-baseline="middle">④ 反向传播</text>
<text class="ts" x="530" y="106" text-anchor="middle">链式法则求梯度</text>
<rect class="b2" x="620" y="60" width="120" height="70" rx="10"/>
<text class="tb" x="680" y="84" text-anchor="middle" dominant-baseline="middle">⑤ 更新参数</text>
<text class="ts" x="680" y="106" text-anchor="middle">梯度下降/Adam</text>
<line class="l" x1="140" y1="95" x2="170" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="95" x2="320" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="95" x2="470" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="95" x2="620" y2="95" marker-end="url(#arr)"/>
<path class="la nf" d="M680 130 L680 190 L80 190 L80 130" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="212" text-anchor="middle">重复成千上万次，直到损失不再下降（每看完全部数据一遍叫 1 个 epoch）</text>
</svg>
<figcaption>图 4：几乎所有神经网络的训练都是这五步循环</figcaption>
</figure>

**ChatGPT 这类大模型的训练，本质上也是这个循环**，只是模型有几千亿个参数、数据有几万亿个词、跑在成千上万块 GPU 上。

## 自测：你真的懂了吗？

> [!QUESTION] 梯度下降的更新公式为什么是“减去”梯度？
> 梯度指向函数上升最快的方向，而我们要让损失下降，所以要沿着梯度的反方向走，也就是参数减去学习率乘以梯度。

> [!QUESTION] 学习率设得太大会发生什么？太小呢？
> 太大：每一步跨过谷底，来回震荡甚至越来越远（发散）；太小：收敛极慢，训练耗时很久，还可能卡在平坦区域。

> [!QUESTION] 为什么实际训练用小批量而不是全部数据？
> 全部数据每步计算量太大。小批量能用少量数据估计出大致准确的梯度，更新更频繁、速度更快，GPU 并行效率高，且噪声有助于跳出局部坑。

> [!QUESTION] 动量和 Adam 解决了什么问题？
> 动量保留历史速度，加速一致方向、抵消来回震荡；Adam 在动量基础上为每个参数自适应调节步长，不需要为各个参数仔细调学习率，收敛快且省心，是大多数深度学习任务的默认选择。

> [!QUESTION] 用梯度下降拟合 y=2x 的例子中，模型是怎么“学会”w=2 的？
> 它从 w=0 开始，每次根据当前预测与真实值的差距计算梯度，再朝减小误差的方向调整 w。预测偏小时梯度为负，w 就被增大；越接近 2 误差越小、梯度越小，最终稳定在 2 附近。

## 相关阅读

- [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)：训练中的优化器
- [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)：反向传播中的链式法则
