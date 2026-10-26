---
level: 基础
tags: [线性代数, 向量, 范数, 点积, 余弦相似度, 张成空间, 入门]
summary: 从“向量是一列数，也是一支箭头”讲起，慢慢推出加减、线性组合、长度、点积与夹角，手算余弦相似度，并说明它们在词向量、嵌入检索和注意力里分别干什么。
---

# 向量：长度、点积、夹角与相似度

> [!ABSTRACT] 一句话版本
> - **向量**是一列有序的数：既是一个对象的“特征清单”，也是空间里的一支箭头。AI 把文字、图片、用户都变成向量，再用几何去比较它们。
> - **线性组合**（先缩放再相加）是向量的基本玩法；两个方向不同的向量就能拼出整个平面，这叫**张成空间（span）**。
> - **范数**回答“这支箭头有多长”，**点积**回答“两支箭头有多同向”：`a·b = ‖a‖‖b‖cosθ`。
> - **余弦相似度** = 归一化之后的点积，只看方向、不看长度。把它想成“两个人说话的口吻像不像”，而不是“嗓门大不大”。
> - 高维空间里随机向量几乎互相垂直，“近”和“远”变得很难区分，所以检索要靠精心训练出来的嵌入，而不是随便一个向量。

## 先抛一个问题

你有两句话：“今天天气真好”和“今天阳光明媚”。人一眼就知道意思接近，那计算机怎么判断？做法是：先让模型把每句话变成一串数（比如 768 个），再问“这两串数像不像”。“像不像”需要一个数学定义，这就是本页要搭建的东西：**向量、长度、夹角、点积**。它们是后面矩阵、投影、PCA、注意力的地基，所以我们慢慢走。

## 一、向量：一行数据，也是一支箭头

### 1. 两种看法

**数据视角**：向量就是按顺序排好的一组数，每个位置有固定含义。
**几何视角**：n 个数就是 n 维空间里的一个点，或者从原点指向这个点的箭头。二维向量 `(3, 2)` 就是“向右 3 格、向上 2 格”。

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="同一个向量 (3, 2) 的两种看法：一行数据，或者从原点出发向右 3 格向上 2 格的箭头">
<line class="l" x1="60" y1="240" x2="330" y2="240" marker-end="url(#arr)"/>
<line class="l" x1="60" y1="240" x2="60" y2="30" marker-end="url(#arr)"/>
<text class="ts" x="336" y="244" text-anchor="start">x</text>
<text class="ts" x="54" y="26" text-anchor="end">y</text>
<text class="ts" x="110" y="258" text-anchor="middle">1</text>
<text class="ts" x="160" y="258" text-anchor="middle">2</text>
<text class="ts" x="210" y="258" text-anchor="middle">3</text>
<text class="ts" x="260" y="258" text-anchor="middle">4</text>
<text class="ts" x="310" y="258" text-anchor="middle">5</text>
<text class="ts" x="48" y="194" text-anchor="end">1</text>
<text class="ts" x="48" y="144" text-anchor="end">2</text>
<text class="ts" x="48" y="94" text-anchor="end">3</text>
<line class="ld" x1="210" y1="240" x2="210" y2="140"/>
<line class="ld" x1="60" y1="140" x2="210" y2="140"/>
<line class="la" x1="60" y1="240" x2="210" y2="140" marker-end="url(#arr-a)"/>
<text class="ta" x="220" y="134" text-anchor="start">a = (3, 2)</text>
<text class="ts" x="210" y="276" text-anchor="middle">向右 3 格</text>
<text class="ts" x="150" y="132" text-anchor="middle">向上 2 格</text>
<rect class="bg" x="400" y="40" width="300" height="220" rx="12"/>
<text class="th" x="416" y="66" text-anchor="start">数据视角：一行特征</text>
<text class="t" x="416" y="96" text-anchor="start">小明 = (25, 175, 12000)</text>
<text class="ts" x="416" y="116" text-anchor="start">年龄 25 岁，身高 175 cm，月薪 12000</text>
<text class="t" x="416" y="146" text-anchor="start">小红 = (30, 165, 15000)</text>
<text class="ts" x="416" y="172" text-anchor="start">每个位置是一个“特征”，3 个数 = 3 维向量</text>
<text class="ta" x="416" y="206" text-anchor="start">同一套规则：</text>
<text class="ts" x="416" y="228" text-anchor="start">768 个数的词嵌入 = 768 维向量，</text>
<text class="ts" x="416" y="248" text-anchor="start">画不出来，但运算规则和 2 维一样</text>
</svg>
<figcaption>图 1：向量既是一行数据，也是空间里的一支箭头（图中是 2 维）</figcaption>
</figure>

两种看法是同一件事，你随时可以切换：做运算时当箭头，存数据时当一行数。记号上，一个向量的第 i 个分量写 `xᵢ`（x 下标 i），整个 n 维向量写成 `x = (x₁, x₂, …, xₙ)`。本分类里向量用小写字母、矩阵用大写字母，不加粗，文中会说明哪个是向量。

> [!NOTE] “维度”是分量的个数
> `(25, 175, 12000)` 是 3 维；一个词嵌入若有 768 个数就是 768 维。维度高只意味着“箭头在更大的空间里”，加减、长度、点积的规则**一个字都不变**。

## 二、向量的运算：加、减、数乘

规则都是“逐个分量来”：

```text
a = (2, 1)，b = (1, 2)
a + b = (2+1, 1+2) = (3, 3)          加法：对应分量相加
a − b = (2−1, 1−2) = (1, −1)         减法：对应分量相减
2a    = (2×2, 2×1) = (4, 2)          数乘：每个分量乘同一个数
−a    = (−2, −1)                      乘 −1：方向反过来
```

几何意义才是重点：

- **加法 = 首尾相接**：先沿 a 走，再沿 b 走，总位移就是 `a + b`。把 a、b 当两条边，`a + b` 是平行四边形的对角线。
- **数乘 = 拉伸/压缩**：乘 2 拉长一倍，乘 0.5 缩短一半，乘负数掉头。
- **减法 = 指向**：`a − b` 是“从 b 的箭头尖指向 a 的箭头尖”的那支箭头。后面算距离、算残差都靠它。

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="向量加法的平行四边形，以及数乘与减法的几何意义">
<text class="th" x="20" y="24" text-anchor="start">加法：先走 a，再走 b</text>
<line class="l" x1="50" y1="260" x2="300" y2="260" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="260" x2="50" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="260" x2="130" y2="220" marker-end="url(#arr)"/>
<text class="tb" x="136" y="234" text-anchor="start">a = (2, 1)</text>
<line class="l" x1="50" y1="260" x2="90" y2="180" marker-end="url(#arr)"/>
<text class="tb" x="82" y="174" text-anchor="end">b = (1, 2)</text>
<line class="ld" x1="130" y1="220" x2="170" y2="140"/>
<line class="ld" x1="90" y1="180" x2="170" y2="140"/>
<line class="la" x1="50" y1="260" x2="170" y2="140" marker-end="url(#arr-a)"/>
<text class="ta" x="178" y="138" text-anchor="start">a + b = (3, 3)</text>
<text class="ts" x="50" y="288" text-anchor="start">虚线：平移 b 或平移 a，落点相同</text>
<text class="th" x="380" y="24" text-anchor="start">数乘与减法</text>
<line class="l" x1="390" y1="170" x2="700" y2="170" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="290" x2="500" y2="40" marker-end="url(#arr)"/>
<line class="la" x1="500" y1="170" x2="644" y2="98" marker-end="url(#arr-a)"/>
<text class="ta" x="640" y="90" text-anchor="end">2a = (4, 2)</text>
<line class="l" x1="500" y1="170" x2="572" y2="134" marker-end="url(#arr)"/>
<text class="tb" x="568" y="150" text-anchor="end">a</text>
<line class="l" x1="500" y1="170" x2="428" y2="206" marker-end="url(#arr)"/>
<text class="ts" x="422" y="218" text-anchor="end">−a = (−2, −1)</text>
<line class="l" x1="500" y1="170" x2="536" y2="98" marker-end="url(#arr)"/>
<text class="tb" x="528" y="92" text-anchor="end">b</text>
<line class="la" x1="536" y1="98" x2="572" y2="134" marker-end="url(#arr-a)"/>
<text class="ta" x="582" y="160" text-anchor="start">a − b = (1, −1)</text>
<text class="ts" x="390" y="288" text-anchor="start">a − b 是“从 b 的尖指向 a 的尖”的箭头</text>
</svg>
<figcaption>图 2：加法是首尾相接；数乘是拉伸（负数则反向）；a − b 指向 a 的方向</figcaption>
</figure>

> [!TIP] 词向量里的加减
> 这正是“国王 − 男人 + 女人 ≈ 女王”的含义：词变成向量后，语义关系变成了方向。`国王 − 男人` 大致是“王权”这个方向，再加上 `女人` 就落在女王附近。

## 三、线性组合与张成空间

### 1. 线性组合：先缩放，再相加

给定向量 u 和 v，再取两个普通的数 `c₁, c₂`（念“c 一、c 二”），下面这个式子叫 **u、v 的线性组合**：

```text
c₁·u + c₂·v
```

你可以把它想成**配方**：u 是一勺红色颜料，v 是一勺蓝色颜料，`c₁, c₂` 是各舀几勺，调出来的颜色就是线性组合。

**手算**：`u = (2, 1)`，`v = (−1, 1)`，取 `c₁ = 3, c₂ = 2`：

```text
3u + 2v = (3×2, 3×1) + (2×(−1), 2×1) = (6, 3) + (−2, 2) = (4, 5)
```

反过来问：想拼出 `(4, 5)`，配方是多少？这就是解方程 `c₁·2 + c₂·(−1) = 4`、`c₁·1 + c₂·1 = 5`，两式相加得 `3c₁ = 9`，`c₁ = 3`，再代回 `c₂ = 2`。“已知结果求配方”会在 [线性方程组、逆矩阵与秩](#/math/linear-systems) 里系统地讲。

### 2. 张成空间 span：能拼出哪些点

一组向量的所有线性组合构成的集合，叫它们的**张成空间**（英文 span，念“斯潘”）。图 3 给了两种典型情况：

<figure class="fig">
<svg viewBox="0 0 720 320" class="dg" role="img" aria-label="两个不共线的向量的整数组合铺满整个平面，两个共线的向量只能拼出一条线">
<text class="th" x="20" y="24" text-anchor="start">u = (2, 1)，v = (−1, 1)：方向不同</text>
<line class="l" x1="20" y1="175" x2="360" y2="175" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="290" x2="190" y2="40" marker-end="url(#arr)"/>
<circle class="b1" cx="142" cy="271" r="3"/>
<circle class="b1" cx="118" cy="247" r="3"/>
<circle class="b1" cx="94" cy="223" r="3"/>
<circle class="b1" cx="70" cy="199" r="3"/>
<circle class="b1" cx="46" cy="175" r="3"/>
<circle class="b1" cx="190" cy="247" r="3"/>
<circle class="b1" cx="166" cy="223" r="3"/>
<circle class="b1" cx="142" cy="199" r="3"/>
<circle class="b1" cx="118" cy="175" r="3"/>
<circle class="b1" cx="94" cy="151" r="3"/>
<circle class="b1" cx="238" cy="223" r="3"/>
<circle class="b1" cx="214" cy="199" r="3"/>
<circle class="b1" cx="190" cy="175" r="3"/>
<circle class="b1" cx="166" cy="151" r="3"/>
<circle class="b1" cx="142" cy="127" r="3"/>
<circle class="b1" cx="286" cy="199" r="3"/>
<circle class="b1" cx="262" cy="175" r="3"/>
<circle class="b1" cx="238" cy="151" r="3"/>
<circle class="b1" cx="214" cy="127" r="3"/>
<circle class="b1" cx="190" cy="103" r="3"/>
<circle class="b1" cx="334" cy="175" r="3"/>
<circle class="b1" cx="310" cy="151" r="3"/>
<circle class="b1" cx="286" cy="127" r="3"/>
<circle class="b1" cx="262" cy="103" r="3"/>
<circle class="b1" cx="238" cy="79" r="3"/>
<line class="la" x1="190" y1="175" x2="238" y2="151" marker-end="url(#arr-a)"/>
<text class="ta" x="244" y="165" text-anchor="start">u</text>
<line class="la" x1="190" y1="175" x2="166" y2="151" marker-end="url(#arr-a)"/>
<text class="ta" x="160" y="147" text-anchor="end">v</text>
<circle class="b3" cx="286" cy="55" r="5"/>
<text class="ts" x="296" y="59" text-anchor="start">3u + 2v</text>
<text class="ts" x="20" y="306" text-anchor="start">每个点 = c₁u + c₂v（c₁, c₂ 取 −2…2）；非整数也行，会填满平面</text>
<rect class="bg" x="380" y="40" width="320" height="250" rx="12"/>
<text class="th" x="396" y="24" text-anchor="start">u = (2, 1)，w = (4, 2) = 2u：同一方向</text>
<line class="l" x1="395" y1="175" x2="690" y2="175" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="285" x2="540" y2="60" marker-end="url(#arr)"/>
<line class="ld" x1="405" y1="242.5" x2="675" y2="107.5"/>
<circle class="b1" cx="396" cy="247" r="3"/>
<circle class="b1" cx="432" cy="229" r="3"/>
<circle class="b1" cx="468" cy="211" r="3"/>
<circle class="b1" cx="504" cy="193" r="3"/>
<circle class="b1" cx="540" cy="175" r="3"/>
<circle class="b1" cx="576" cy="157" r="3"/>
<circle class="b1" cx="612" cy="139" r="3"/>
<circle class="b1" cx="648" cy="121" r="3"/>
<circle class="b1" cx="684" cy="103" r="3"/>
<line class="la" x1="540" y1="175" x2="576" y2="157" marker-end="url(#arr-a)"/>
<text class="ta" x="570" y="149" text-anchor="end">u</text>
<text class="ts" x="680" y="95" text-anchor="end">w = 2u</text>
<text class="ts" x="396" y="276" text-anchor="start">所有组合 c₁u + c₂w 都落在这一条线上</text>
</svg>
<figcaption>图 3：线性组合能到达的范围（张成空间 span）：方向不同 → 整个平面；方向相同 → 一条线</figcaption>
</figure>

- `u = (2, 1)` 与 `v = (−1, 1)` **方向不同**：调整 `c₁, c₂` 可以到达平面上的**任何点**，span 是整个平面。
- `u = (2, 1)` 与 `w = (4, 2)` **同方向**（`w = 2u`）：不管怎么调，终点都在同一条线上，span 只是一条直线。w 是“多余”的，没带来新方向。

### 3. 线性无关与基

把上面的观察变成两个术语：

- **线性无关**：一组向量里，没有任何一个能被其余的线性组合拼出来。u、v 无关；u、w 相关（`w = 2u`）。
- **基**：一组线性无关、并且 span 恰好是整个空间的向量。二维空间里的基恰好 2 个向量，三维恰好 3 个。**最常用的基是标准基** `e₁ = (1, 0)`、`e₂ = (0, 1)`。

向量的“坐标”其实就是**用基拼出它的配方**：`(3, 2) = 3·e₁ + 2·e₂`。换一组基（比如 u、v），同一个点的坐标就会变，这是 PCA、SVD 里“换个角度看数据”的数学基础。

> [!WARNING] 常见误区：向量个数不等于“信息量”
> 三个二维向量一定线性相关（平面里没有第三个独立方向）。同理，一个 `1000 × 768` 的嵌入表格虽然有 1000 行，但它张成的空间最多是 768 维。真正独立的方向有几个，叫**秩**，见 [线性方程组、逆矩阵与秩](#/math/linear-systems)。

## 四、长度、范数与距离

### 1. L2 范数：直线长度

二维向量 `(x, y)` 的长度是勾股定理 `√(x² + y²)`；n 维一样：每个分量平方、求和、开方。记作 `‖x‖`（读“x 的范数”，两条竖线）：

```text
‖x‖₂ = √(x₁² + x₂² + … + xₙ²)           例：‖(3, −4)‖₂ = √(9+16) = 5
```

范数是“衡量大小的尺子”，尺子不止一种。常见三把：

| 名称 | 做法 | `(3, −4)` 的结果 | 直觉 |
| --- | --- | --- | --- |
| L1 范数 | 各分量取绝对值再相加 | 3+4 = **7** | 出租车只能沿街区走：横着走几格 + 竖着走几格 |
| L2 范数 | 平方、相加、开方 | **5** | 直线飞过去 |
| L∞ 范数 | 取绝对值最大的那个分量 | **4** | 只看“最糟”的那一维 |

```text
‖x‖₁ = |x₁| + |x₂| + … + |xₙ|          竖线 |·| 是绝对值
‖x‖₂ = √(x₁² + x₂² + … + xₙ²)
‖x‖∞ = max(|x₁|, |x₂|, …, |xₙ|)        max 是“取最大值”
```

不写下标的 `‖x‖` 默认就是 L2。如果把“范数 = 1”的所有点画出来，三把尺子形状不同：

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="L1、L2、L∞ 三种长度下“长度等于 1”的点的集合：菱形、圆、正方形">
<line class="ld" x1="20" y1="130" x2="220" y2="130"/>
<line class="ld" x1="120" y1="30" x2="120" y2="230"/>
<line class="b1 nf" x1="120" y1="52" x2="198" y2="130"/>
<line class="b1 nf" x1="198" y1="130" x2="120" y2="208"/>
<line class="b1 nf" x1="120" y1="208" x2="42" y2="130"/>
<line class="b1 nf" x1="42" y1="130" x2="120" y2="52"/>
<text class="tb" x="120" y="248" text-anchor="middle">L1：菱形</text>
<text class="ts" x="120" y="268" text-anchor="middle">|x| + |y| = 1</text>
<line class="ld" x1="260" y1="130" x2="460" y2="130"/>
<line class="ld" x1="360" y1="30" x2="360" y2="230"/>
<circle class="b2 nf" cx="360" cy="130" r="78"/>
<text class="tb" x="360" y="248" text-anchor="middle">L2：圆</text>
<text class="ts" x="360" y="268" text-anchor="middle">x² + y² = 1</text>
<line class="ld" x1="500" y1="130" x2="700" y2="130"/>
<line class="ld" x1="600" y1="30" x2="600" y2="230"/>
<line class="b3 nf" x1="522" y1="52" x2="678" y2="52"/>
<line class="b3 nf" x1="678" y1="52" x2="678" y2="208"/>
<line class="b3 nf" x1="678" y1="208" x2="522" y2="208"/>
<line class="b3 nf" x1="522" y1="208" x2="522" y2="52"/>
<text class="tb" x="600" y="248" text-anchor="middle">L∞：正方形</text>
<text class="ts" x="600" y="268" text-anchor="middle">max(|x|, |y|) = 1</text>
<text class="ts" x="202" y="126" text-anchor="start">1</text>
</svg>
<figcaption>图 4：同一个“长度 = 1”的要求，三种量法画出三种形状；L2 最贴近日常的直线距离</figcaption>
</figure>

### 2. 距离就是“差向量的长度”

两点 p、q 的距离 = `‖p − q‖`（前面说过，`p − q` 就是连接它们的箭头）。

**手算**：`p = (1, 2)`，`q = (4, 6)`：

```text
p − q = (−3, −4)
L2 距离 = √(9+16) = 5      L1 距离 = 3+4 = 7      L∞ 距离 = 4
```

> [!NOTE] AI 里的 L1 / L2
> 训练中常见的 **L2 正则**（权重衰减）是惩罚权重向量的 `‖w‖₂²`，会让权重整体变小；**L1 正则**惩罚 `‖w‖₁`，菱形的“尖角”落在坐标轴上，倾向于让一些权重**恰好等于 0**（稀疏）。损失里的 MSE 就是预测向量与真实向量差的 L2 距离的平方（取平均）。

## 五、点积：衡量“有多同向”

### 1. 代数算法

对应位置相乘，再全部加起来，结果是**一个数**（不是向量）：

```text
a·b = a₁b₁ + a₂b₂ + … + aₙbₙ = Σ aᵢbᵢ
```

`Σ`念“西格玛”，表示求和。**手算（三维）**：`x = (1, 2, 3)`，`y = (4, −5, 6)`：

```text
x·y = 1×4 + 2×(−5) + 3×6 = 4 − 10 + 18 = 12
```

### 2. 几何含义：投影

只看算法你不知道它在“量”什么。几何上：

```text
a·b = ‖a‖ ‖b‖ cos θ        θ 是两支箭头之间的夹角
```

怎么从投影看出来？把 a 垂直“压”到 b 所在的直线上，落点到原点的长度叫 **a 在 b 方向上的投影长度**，它等于 `‖a‖cosθ`（直角三角形里邻边 = 斜边 × cosθ）。再乘上 b 的长度，就得到点积。所以：

> **点积 = b 的长度 × a 在 b 方向上的投影长度。**

<figure class="fig">
<svg viewBox="0 0 720 330" class="dg" role="img" aria-label="点积的几何意义：a 在 b 方向上的投影长度乘以 b 的长度">
<line class="l" x1="50" y1="290" x2="330" y2="290" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="290" x2="50" y2="40" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="290" x2="290" y2="170" marker-end="url(#arr)"/>
<text class="tb" x="298" y="174" text-anchor="start">b = (4, 2)</text>
<line class="l" x1="50" y1="290" x2="110" y2="110" marker-end="url(#arr)"/>
<text class="tb" x="118" y="108" text-anchor="start">a = (1, 3)</text>
<line class="ld" x1="110" y1="110" x2="170" y2="230"/>
<line class="la" x1="50" y1="290" x2="170" y2="230" marker-end="url(#arr-a)"/>
<text class="ta" x="178" y="250" text-anchor="start">投影 (2, 1)</text>
<line class="l" x1="178" y1="226" x2="174" y2="217.9"/>
<line class="l" x1="174" y1="217.9" x2="166" y2="222"/>
<text class="ts" x="104" y="250" text-anchor="start">θ = 45°</text>
<rect class="bg" x="400" y="40" width="300" height="250" rx="12"/>
<text class="th" x="416" y="66" text-anchor="start">用数字走一遍</text>
<text class="t" x="416" y="96" text-anchor="start">a·b = 1×4 + 3×2 = 10</text>
<text class="t" x="416" y="124" text-anchor="start">‖b‖ = √(16+4) = √20 ≈ 4.47</text>
<text class="t" x="416" y="152" text-anchor="start">投影长度 = a·b ÷ ‖b‖ ≈ 2.24</text>
<text class="t" x="416" y="180" text-anchor="start">投影向量 = (a·b ÷ b·b) × b</text>
<text class="t" x="416" y="202" text-anchor="start">= (10 ÷ 20) × (4, 2) = (2, 1)</text>
<text class="ta" x="416" y="236" text-anchor="start">cos θ = 10 ÷ (√10 × √20) ≈ 0.707</text>
<text class="ts" x="416" y="258" text-anchor="start">所以 θ = 45°；虚线与 b 成直角</text>
</svg>
<figcaption>图 5：把 a 垂直“压”到 b 所在的直线上，落点就是投影；点积 = 投影长度 × ‖b‖</figcaption>
</figure>

**为什么代数算法恰好等于这个几何量？** 用两个公式对比一下。以 a、b 为两边的三角形，第三边是 `a − b`。几何里的**余弦定理**说：

```text
‖a − b‖² = ‖a‖² + ‖b‖² − 2‖a‖‖b‖cosθ
```

另一方面，把 `‖a − b‖²` 按分量展开：

```text
‖a − b‖² = Σ(aᵢ − bᵢ)² = Σaᵢ² + Σbᵢ² − 2Σaᵢbᵢ = ‖a‖² + ‖b‖² − 2 a·b
```

两个式子左边相同，所以 `a·b = ‖a‖‖b‖cosθ`。这就是“逐项相乘再求和”与“夹角”的桥。

### 3. 夹角与正负号

`cosθ` 在 0° 到 180° 之间从 1 降到 −1，所以点积的**正负号直接说出两支箭头的朝向关系**：

| 夹角 θ | cosθ | 点积 | 含义 |
| --- | --- | --- | --- |
| 0°（同向） | 1 | 正，最大 | 方向完全一致 |
| 0° ~ 90° | 0 ~ 1 | 正 | 大体同向 |
| 90° | 0 | **0** | **互相垂直（正交）**，毫无关系 |
| 90° ~ 180° | −1 ~ 0 | 负 | 大体反向 |
| 180°（反向） | −1 | 负，最小 | 方向完全相反 |

**手算夹角**（就是图 5 的例子）：`a = (1, 3)`，`b = (4, 2)`：

```text
a·b = 1×4 + 3×2 = 10
‖a‖ = √10 ≈ 3.162，‖b‖ = √20 ≈ 4.472
cosθ = 10 ÷ (3.162 × 4.472) = 10 ÷ 14.142 ≈ 0.7071   →  θ = 45°
```

**检验“垂直 ⇒ 点积为 0”**：`a = (1, 3)`，`c = (−3, 1)`，`a·c = −3 + 3 = 0`，二者垂直。

> [!WARNING] 点积大 ≠ 夹角小
> 点积同时受**长度**影响：`a·b = ‖a‖‖b‖cosθ`。一个很长的向量，哪怕夹角不小，点积也可能很大。想“只比方向”，要先把长度去掉，这就是下一节的余弦相似度。

## 六、余弦相似度：只看方向

把点积除以两个长度，就把长度的影响抹掉了：

```text
cos(a, b) = a·b ÷ (‖a‖ ‖b‖)        取值在 −1 到 1 之间
```

另一种说法：先把每个向量**归一化**（除以自己的长度，变成长度为 1 的“单位向量”），再做点积，结果就是余弦。

**手算**：三个玩具“词向量”（三个维度可以想成“动物性、宠物性、机械性”），`cat = (0.9, 0.8, 0.1)`，`dog = (0.8, 0.9, 0.2)`，`car = (0.1, 0.2, 0.9)`：

```text
cat·dog = 0.72 + 0.72 + 0.02 = 1.46
‖cat‖ = √1.46 ≈ 1.208，‖dog‖ = √1.49 ≈ 1.221
cos(cat, dog) = 1.46 ÷ (1.208 × 1.221) ≈ 0.990      很像

cat·car = 0.09 + 0.16 + 0.09 = 0.34
‖car‖ = √0.86 ≈ 0.927
cos(cat, car) = 0.34 ÷ (1.208 × 0.927) ≈ 0.303       不太像
```

把 dog 整体放大 3 倍，方向没变，余弦**依旧是 0.990**；但点积从 1.46 变成 4.38。这就是“只看方向”的含义。

### 在 AI 里怎么用

- **嵌入检索 / RAG**：问题和文档片段各变成一个向量，按余弦（或归一化后的内积）排序，取最相近的若干条。向量库里常见的做法是**入库时就归一化**，之后只算点积，省掉除法和开方。分数的含义、阈值怎么定、索引怎么选，见 [RAG 向量检索逻辑](#/ai/rag-vector)。
- **注意力**：Transformer 里每个词的“查询向量”与其他词的“键向量”做点积，点积大 = 更该关注，见 [注意力与 Transformer：大模型的骨架](#/aimodel/transformer)。
- **对比学习**：训练时让“相关”的文本对余弦变大，“不相关”的变小，嵌入模型的向量就是这样练出来的。

> [!NOTE] 余弦与欧氏距离的关系
> 对**长度为 1** 的向量有 `‖a − b‖² = 2 − 2cos(a, b)`（由上一节的展开直接得出，令 `‖a‖ = ‖b‖ = 1`）。所以归一化之后，余弦越大距离越小，两种排序结果一致。

## 七、高维直觉：近和远变得难分

我们的直觉来自二维、三维，但嵌入常常是几百上千维。高维空间有两个反直觉的现象，用 NumPy 一试就看到（代码在第八节）：

| 维度 d | 随机两向量余弦的“波动大小” | 距离的相对差 `(最远−最近)÷最近` |
| --- | --- | --- |
| 2 | 0.713 | 42.41 |
| 10 | 0.315 | 3.04 |
| 100 | 0.098 | 0.41 |
| 1000 | 0.033 | 0.12 |

- **随机向量几乎垂直**：余弦的典型大小约是 `1/√d`，维度越高越接近 0。所以高维里“余弦 0.3”已经是很强的信号，而二维里它几乎说明不了什么。
- **距离集中**：随机取 1000 个点，d=2 时最远的比最近的远 42 倍；d=1000 时只远 12%。最近邻与其他点的差距被压得很小，所以检索要靠**训练过的嵌入**把“相关”的拉得很近，而不是靠随机向量。

> [!NOTE] 一个小联系：注意力为什么要除以 √d
> 若两个向量的分量独立、均值 0、方差 1，则点积的标准差约为 `√d`。维度 d 大时点积数值很大，送进 softmax 会过于“尖锐”。所以注意力把点积除以 `√d`，让数值回到合适的范围。

## 八、动手：NumPy 验证

```python
import numpy as np

a = np.array([1, 3]); b = np.array([4, 2])
print(a + b, a - b, 2 * a)                       # 加、减、数乘
print(a @ b)                                     # 点积
print(np.linalg.norm(b, 1), np.linalg.norm(b), np.linalg.norm(b, np.inf))   # L1, L2, L∞

cos = lambda u, v: u @ v / (np.linalg.norm(u) * np.linalg.norm(v))
print(round(cos(a, b), 4), round(np.degrees(np.arccos(cos(a, b))), 1))      # 余弦与夹角

cat = np.array([0.9, 0.8, 0.1]); dog = np.array([0.8, 0.9, 0.2]); car = np.array([0.1, 0.2, 0.9])
print(round(cos(cat, dog), 3), round(cos(cat, car), 3))
print(round(cos(cat, 3 * dog), 3))               # dog 放大 3 倍，余弦不变

unit = lambda v: v / np.linalg.norm(v)           # 归一化：长度变成 1
print(round(unit(cat) @ unit(dog), 3))           # 归一化后点积 = 余弦

# 高维：随机向量越来越“垂直”，最近与最远的距离越来越接近
rng = np.random.default_rng(0)
for d in [2, 10, 100, 1000]:
    U = rng.standard_normal((2000, d)); V = rng.standard_normal((2000, d))
    c = (U * V).sum(1) / (np.linalg.norm(U, axis=1) * np.linalg.norm(V, axis=1))
    X = rng.random((1000, d)); q = rng.random(d)
    D = np.linalg.norm(X - q, axis=1)
    print(d, round(c.std(), 3), round((D.max() - D.min()) / D.min(), 2))
```

```text
[5 5] [-3  1] [2 6]
10
6.0 4.47213595499958 4.0
0.7071 45.0
0.99 0.303
0.99
0.99
2 0.713 42.41
10 0.315 3.04
100 0.098 0.41
1000 0.033 0.12
```

## 九、和 AI 的对照表

| 数学对象 | 在 AI 里长什么样 |
| --- | --- |
| 向量（特征向量） | 一个样本的一行特征：`(年龄, 身高, 月薪)`，输入给模型 |
| 向量（嵌入） | 一个词/句子/图片的 768~4096 维“含义坐标”，相似的内容彼此靠近 |
| 向量（权重向量） | 一个神经元的一行权重 `w`，与输入做点积再加偏置 |
| 加减 | 词向量类比；残差连接 `x + f(x)`；梯度更新 `w − η∇L` |
| L2 范数 | MSE 损失、L2 正则、梯度裁剪（限制梯度长度） |
| L1 范数 | L1 正则（稀疏）、MAE 损失 |
| 点积 | 神经元加权求和；注意力分数 `q·k` |
| 余弦相似度 | 嵌入检索、语义去重、对比学习 |
| 线性组合 / span | 输出是输入特征的配方；矩阵的列张成的“可达范围”（见矩阵一页） |

## 自测

> [!QUESTION] 向量 `(6, 8)` 的 L1、L2、L∞ 范数分别是多少？
> L1 = 6+8 = 14；L2 = √(36+64) = 10；L∞ = max(6, 8) = 8。注意三者大小关系 `L∞ ≤ L2 ≤ L1`。

> [!QUESTION] `a = (2, −1, 0)` 与 `b = (1, 2, 5)` 的点积是多少？它们垂直吗？
> `2×1 + (−1)×2 + 0×5 = 0`，点积为 0，所以垂直（第三个分量乘 0，对结果没有贡献）。

> [!QUESTION] `a = (1, 1)`，`b = (−1, 1)`，夹角是多少？
> `a·b = −1 + 1 = 0`，所以夹角 90°（一个指向右上，一个指向左上，确实垂直）。

> [!QUESTION] 为什么嵌入检索更常用余弦（或归一化后的内积），而不是直接用点积？
> 点积同时受长度和方向影响，长文本或模型产生的向量长度差异会让排序被“长度”干扰。余弦把长度除掉，只比较方向；若入库时已归一化，余弦就等于内积，算起来最省。

> [!QUESTION] 把向量 `(3, 4)` 与 `(6, 8)` 比较，它们的余弦相似度是多少？说明什么？
> `(6, 8) = 2 × (3, 4)`，方向完全相同，余弦 = 1（点积 `18+32 = 50`，长度 `5×10 = 50`）。长度不同、方向相同，余弦仍是 1。

> [!QUESTION] 高维空间里随机取两个向量，余弦大约是多少？这对“相似度阈值”有什么启示？
> 接近 0（典型大小约 `1/√d`）。所以在 1000 维里余弦 0.3 已经算显著相似，而在 2 维里完全不算。阈值不能凭低维直觉定，要在自己的数据上用评测集校准。

## 相关阅读

- 本页的速成版：[线性代数 1：向量与矩阵](#/aimodel/math-la1)
- 下一页：[矩阵：线性变换与矩阵乘法](#/math/matrices)
- 向量检索中的相似度：[RAG 向量检索逻辑](#/ai/rag-vector)
- 点积在注意力里：[注意力与 Transformer：大模型的骨架](#/aimodel/transformer)
- 点积 = 0 的几何后果：[正交与投影：最小二乘与线性回归](#/math/projection)
