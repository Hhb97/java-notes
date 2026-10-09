---
level: 基础
tags: [CNN, 卷积, 池化, 感受野, 特征图, ResNet, 图像分类, 目标检测, 迁移学习]
summary: 用“放大镜扫描图片”的比喻讲清卷积神经网络：为什么 MLP 看图不行，卷积核如何滑动提取特征（带完整手算），权重共享、步长与填充、池化，经典网络（LeNet、VGG、ResNet）的演进，以及检测、分割和迁移学习的用法。
---

# CNN：卷积神经网络如何“看图”

> [!ABSTRACT] 一句话版本
> - 图片在计算机里就是一张**数字表格**（像素亮度）。用 MLP 看图，要把它拉成一长条，**既参数爆炸，又丢掉了“相邻像素有关系”的信息**。
> - **卷积**：用一个**小窗口（卷积核）**在图上滑动，每到一处就做一次“加权求和”，得到一张新的“特征图”。**同一个卷积核处处共享**，参数很少。
> - 浅层卷积核学到**边缘、颜色**，深层组合成**纹理、形状、物体部件**，最后识别整个物体——这是一个**由简入繁的层级**。
> - **池化**把图缩小、保留最强的信号；**ResNet** 的残差连接让网络能堆到上百层。
> - CNN 是图像领域的基石（分类、检测、分割），近年也与 **Vision Transformer** 并存。

> [!NOTE] 先决条件
> 需要知道矩阵是什么、神经网络怎么训练，见 [线性代数 1：向量与矩阵](#/aimodel/math-la1)、[MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)。

## 一、计算机怎么“看”图

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="灰度图是由像素亮度构成的矩阵，彩色图有红绿蓝三个通道，形状是高乘宽乘通道">
<rect class="b" x="20" y="40" width="140" height="140" rx="0"/>
<rect class="bg" x="20" y="40" width="35" height="35" rx="0"/>
<rect class="b1" x="55" y="40" width="35" height="35" rx="0"/>
<rect class="b3" x="90" y="40" width="35" height="35" rx="0"/>
<rect class="b3" x="125" y="40" width="35" height="35" rx="0"/>
<text class="ts" x="90" y="200" text-anchor="middle">灰度图 28×28</text>
<text class="tm" x="190" y="100" text-anchor="start">0 = 黑</text>
<text class="tm" x="190" y="120" text-anchor="start">255 = 白</text>
<text class="ts" x="190" y="142" text-anchor="start">每个格子一个数</text>
<rect class="b4" x="400" y="60" width="120" height="120" rx="0"/>
<rect class="b2" x="420" y="48" width="120" height="120" rx="0"/>
<rect class="b1" x="440" y="36" width="120" height="120" rx="0"/>
<text class="tb" x="500" y="100" text-anchor="middle" dominant-baseline="middle">R G B</text>
<text class="ts" x="500" y="200" text-anchor="middle">彩色图：3 个通道叠起来</text>
<text class="tm" x="590" y="96" text-anchor="start">形状：</text>
<text class="tm" x="590" y="118" text-anchor="start">高 × 宽 × 3</text>
<text class="ts" x="590" y="142" text-anchor="start">224×224×3 ≈ 15 万个数</text>
</svg>
<figcaption>图 1：图片就是数字矩阵（彩色图有三层）</figcaption>
</figure>

## 二、为什么不用 MLP 看图

假设一张 **224×224 的彩色图**，输入有 224×224×3 = **150,528** 个数。接一个 1000 个神经元的全连接层：

```text
参数 = 150,528 × 1000 ≈ 1.5 亿个   —— 仅仅第一层！
```

问题：

1. **参数爆炸**：太大、训练慢、容易过拟合；
2. **丢失空间结构**：把图拉成一长串后，“相邻像素”和“相距很远的像素”被一视同仁；
3. **位置敏感**：同一只猫出现在左上角和右下角，MLP 会当作完全不同的输入重新学。

图像有两个关键特点，CNN 正是利用了它们：

| 特点 | CNN 的设计 |
| --- | --- |
| **局部性**：识别边缘只需看一小块邻近像素 | 小窗口（卷积核）只看局部 |
| **平移不变性**：猫在哪儿都是猫 | **同一个卷积核在整张图上滑动（权重共享）** |

## 三、卷积：滑动的小窗口

### 1. 做什么

**卷积核（滤波器）**是一个很小的数字矩阵（如 3×3）。把它**贴在图片的一个小区域上，对应位置相乘再相加**，得到**一个数**；然后向右滑一格，重复；滑完整张图，得到一张新的小图——**特征图**。

### 2. 完整手算

输入 3×3 图像，卷积核 2×2（步长 1，不填充）：

```text
输入图像                  卷积核
| 1  2  0 |               | 1   0 |
| 0  1  3 |               | 0  −1 |
| 2  1  0 |
```

每个位置：**窗口内 4 个数与卷积核对应相乘，再求和**：

```text
位置 (0,0)： 窗口 | 1 2 |   →  1×1 + 2×0 + 0×0 + 1×(−1) =  0
                | 0 1 |
位置 (0,1)： 窗口 | 2 0 |   →  2×1 + 0×0 + 1×0 + 3×(−1) = −1
                | 1 3 |
位置 (1,0)： 窗口 | 0 1 |   →  0×1 + 1×0 + 2×0 + 1×(−1) = −1
                | 2 1 |
位置 (1,1)： 窗口 | 1 3 |   →  1×1 + 3×0 + 1×0 + 0×(−1) =  1
                | 1 0 |
输出特征图：| 0  −1 |
            | −1  1 |
```

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="卷积核 2×2 在 3×3 输入上滑动，在每个位置对应元素相乘再求和，得到 2×2 的输出特征图">
<text class="th" x="20" y="24">输入 3×3</text>
<rect class="b" x="20" y="40" width="40" height="40" rx="0"/>
<rect class="b" x="60" y="40" width="40" height="40" rx="0"/>
<rect class="b" x="100" y="40" width="40" height="40" rx="0"/>
<rect class="b" x="20" y="80" width="40" height="40" rx="0"/>
<rect class="b" x="60" y="80" width="40" height="40" rx="0"/>
<rect class="b" x="100" y="80" width="40" height="40" rx="0"/>
<rect class="b" x="20" y="120" width="40" height="40" rx="0"/>
<rect class="b" x="60" y="120" width="40" height="40" rx="0"/>
<rect class="b" x="100" y="120" width="40" height="40" rx="0"/>
<text class="tm" x="40" y="60" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="80" y="60" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="120" y="60" text-anchor="middle" dominant-baseline="middle">0</text>
<text class="tm" x="40" y="100" text-anchor="middle" dominant-baseline="middle">0</text>
<text class="tm" x="80" y="100" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="120" y="100" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="40" y="140" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="80" y="140" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="120" y="140" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b3 nf" x="20" y="40" width="80" height="80" rx="0"/>
<text class="ta" x="60" y="184" text-anchor="middle">当前窗口 (0,0)</text>
<text class="th" x="210" y="24">卷积核 2×2</text>
<rect class="b1" x="210" y="60" width="40" height="40" rx="0"/>
<rect class="b1" x="250" y="60" width="40" height="40" rx="0"/>
<rect class="b1" x="210" y="100" width="40" height="40" rx="0"/>
<rect class="b1" x="250" y="100" width="40" height="40" rx="0"/>
<text class="tm" x="230" y="80" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="270" y="80" text-anchor="middle" dominant-baseline="middle">0</text>
<text class="tm" x="230" y="120" text-anchor="middle" dominant-baseline="middle">0</text>
<text class="tm" x="270" y="120" text-anchor="middle" dominant-baseline="middle">−1</text>
<text class="th" x="150" y="108" text-anchor="middle">⊛</text>
<text class="th" x="320" y="108" text-anchor="middle">=</text>
<text class="th" x="360" y="24">输出特征图 2×2</text>
<rect class="b2" x="360" y="60" width="50" height="50" rx="0"/>
<rect class="b2" x="410" y="60" width="50" height="50" rx="0"/>
<rect class="b2" x="360" y="110" width="50" height="50" rx="0"/>
<rect class="b2" x="410" y="110" width="50" height="50" rx="0"/>
<text class="tm" x="385" y="85" text-anchor="middle" dominant-baseline="middle">0</text>
<text class="tm" x="435" y="85" text-anchor="middle" dominant-baseline="middle">−1</text>
<text class="tm" x="385" y="135" text-anchor="middle" dominant-baseline="middle">−1</text>
<text class="tm" x="435" y="135" text-anchor="middle" dominant-baseline="middle">1</text>
<rect class="bg" x="500" y="40" width="240" height="220" rx="12"/>
<text class="th" x="516" y="64">每个格子怎么来</text>
<text class="ts" x="516" y="90">窗口 (0,0)：1·1+2·0+0·0+1·(−1)=0</text>
<text class="ts" x="516" y="112">窗口 (0,1)：2·1+0·0+1·0+3·(−1)=−1</text>
<text class="ts" x="516" y="134">窗口 (1,0)：0·1+1·0+2·0+1·(−1)=−1</text>
<text class="ts" x="516" y="156">窗口 (1,1)：1·1+3·0+1·0+0·(−1)=1</text>
<text class="ta" x="516" y="190">滑动、相乘、求和，重复即可</text>
<text class="ts" x="516" y="214">卷积核里的数字是“学”出来的</text>
<text class="ts" x="516" y="236">不同的核提取不同的特征</text>
<text class="ts" x="30" y="236" text-anchor="start">滑动步长 stride = 1，窗口每次右移/下移一格</text>
</svg>
<figcaption>图 2：卷积 = 窗口滑动 + 对应相乘求和</figcaption>
</figure>

### 3. 卷积核学到了什么

一个能检测**竖直边缘**的经典卷积核：

```text
| −1  0  1 |         在亮度突然变化（边缘）的地方，输出的值很大
| −2  0  2 |         在平坦的地方，左右抵消，输出接近 0
| −1  0  1 |
```

**CNN 训练的神奇之处**：这些卷积核里的数字**不需要人设计**，而是通过反向传播**自己学出来**。一个卷积层通常有几十~几百个不同的卷积核，每个提取一种特征，产生多张特征图（叠成多个“通道”）。

### 4. 步长、填充与输出大小

| 概念 | 含义 | 作用 |
| --- | --- | --- |
| **步长 Stride** | 窗口每次移动几格 | 步长 2 → 输出尺寸约缩小一半 |
| **填充 Padding** | 在图像四周补 0 | 保持尺寸不变、让边缘也被充分利用 |
| 卷积核大小 | 常见 3×3、5×5、7×7、1×1 | 越大看得越“宽” |

**输出尺寸公式**：

```text
输出边长 = ⌊(输入边长 − 核边长 + 2×填充) ÷ 步长⌋ + 1

224 输入，3×3 核，填充 1，步长 1  →  (224 − 3 + 2)/1 + 1 = 224   （尺寸不变）
224 输入，3×3 核，填充 1，步长 2  →  (224 − 3 + 2)/2 + 1 = 112   （缩小一半）
```

### 5. 参数有多省

```text
一个 3×3 卷积核，处理单通道输入：只有 9 个权重 + 1 个偏置 = 10 个参数
32 个这样的卷积核：320 个参数
（对比：784→128 的全连接层有 10 万个参数）
```

**多通道输入**时，卷积核也是三维的：`核高 × 核宽 × 输入通道数`。一层的参数 = `核高×核宽×输入通道×输出通道 + 输出通道`。例如输入 64 通道、输出 128 通道、3×3 核：`3×3×64×128 + 128 = 73,856`。

## 四、池化：缩小并保留重点

**最大池化（Max Pooling）**：把图分成小块（如 2×2），**每块只取最大值**。

```text
| 1  3  2  0 |       2×2 最大池化       | 4  2 |
| 4  2  1  1 |      ───────────────▶    | 6  8 |
| 0  6  8  3 |
| 2  1  4  5 |      每个 2×2 块取最大：
                    块1: max(1,3,4,2)=4   块2: max(2,0,1,1)=2
                    块3: max(0,6,2,1)=6   块4: max(8,3,4,5)=8
```

作用：

- **缩小尺寸**，减少后续计算量；
- **增强“平移不变”**：特征在块内稍微移动，结果不变；
- 没有参数；也有**平均池化**、**全局平均池化**（最后把整张特征图平均成一个数，常代替全连接层）。

## 五、完整的 CNN 长什么样

<figure class="fig">
<svg viewBox="0 0 780 300" class="dg" role="img" aria-label="典型 CNN 结构：输入图像，经过多组卷积加 ReLU 加池化，特征图越来越小、通道越来越多，最后展平接全连接层和 softmax 输出类别概率">
<rect class="b1" x="20" y="80" width="80" height="100" rx="4"/>
<text class="tb" x="60" y="124" text-anchor="middle" dominant-baseline="middle">输入</text>
<text class="ts" x="60" y="200" text-anchor="middle">224×224×3</text>
<rect class="b3" x="130" y="70" width="60" height="120" rx="4"/>
<text class="ts" x="160" y="124" text-anchor="middle" dominant-baseline="middle">卷积</text>
<text class="ts" x="160" y="140" text-anchor="middle">+ReLU</text>
<text class="ts" x="160" y="212" text-anchor="middle">224×224×64</text>
<rect class="b5" x="215" y="90" width="40" height="80" rx="4"/>
<text class="ts" x="235" y="130" text-anchor="middle" dominant-baseline="middle">池化</text>
<text class="ts" x="235" y="196" text-anchor="middle">112×112</text>
<rect class="b3" x="280" y="100" width="55" height="60" rx="4"/>
<text class="ts" x="307" y="126" text-anchor="middle" dominant-baseline="middle">卷积</text>
<text class="ts" x="307" y="142" text-anchor="middle">+ReLU</text>
<text class="ts" x="307" y="182" text-anchor="middle">×128 通道</text>
<rect class="b5" x="360" y="108" width="35" height="44" rx="4"/>
<text class="ts" x="377" y="132" text-anchor="middle" dominant-baseline="middle">池化</text>
<text class="ts" x="377" y="172" text-anchor="middle">56×56</text>
<text class="th" x="430" y="132" text-anchor="middle">…</text>
<rect class="b3" x="470" y="114" width="45" height="36" rx="4"/>
<text class="ts" x="492" y="132" text-anchor="middle" dominant-baseline="middle">卷积</text>
<text class="ts" x="492" y="168" text-anchor="middle">7×7×512</text>
<rect class="b4" x="540" y="104" width="50" height="56" rx="4"/>
<text class="ts" x="565" y="128" text-anchor="middle" dominant-baseline="middle">展平/</text>
<text class="ts" x="565" y="144" text-anchor="middle">全局池化</text>
<rect class="b4" x="615" y="104" width="60" height="56" rx="4"/>
<text class="ts" x="645" y="128" text-anchor="middle" dominant-baseline="middle">全连接</text>
<text class="ts" x="645" y="144" text-anchor="middle">层</text>
<rect class="b2" x="700" y="104" width="60" height="56" rx="4"/>
<text class="ts" x="730" y="128" text-anchor="middle" dominant-baseline="middle">softmax</text>
<text class="ts" x="730" y="144" text-anchor="middle">猫 0.93</text>
<line class="l" x1="100" y1="130" x2="130" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="190" y1="130" x2="215" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="130" x2="280" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="335" y1="130" x2="360" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="395" y1="130" x2="415" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="445" y1="130" x2="470" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="130" x2="540" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="130" x2="615" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="675" y1="130" x2="700" y2="130" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="240" width="740" height="50" rx="10"/>
<text class="ts" x="380" y="262" text-anchor="middle">规律：越往后，图越小（空间尺寸缩小）、通道越多（特征越丰富）；浅层看边缘颜色，深层看部件与整体</text>
<text class="ts" x="380" y="280" text-anchor="middle">最后把“特征”交给全连接层做分类，再用 softmax 变成概率</text>
</svg>
<figcaption>图 3：卷积 → ReLU → 池化 的重复堆叠，最后接分类器</figcaption>
</figure>

### 从边缘到物体：层级特征

| 层 | 学到的特征 | 例子 |
| --- | --- | --- |
| 浅层 | 边缘、线条、颜色块 | 横线、竖线、斜线 |
| 中层 | 纹理、角、简单形状 | 毛发纹理、圆形、眼睛的轮廓 |
| 深层 | 物体的部件、整体 | 猫耳朵、车轮、人脸 |

**感受野**：深层的一个神经元“看到”原图的区域（越深越大）。多个 3×3 卷积叠起来，等效于一个更大的窗口，而且参数更少、非线性更多——这就是 VGG 反复使用 3×3 的原因。

## 六、经典网络的演进

| 年份 | 网络 | 亮点 |
| --- | --- | --- |
| 1998 | **LeNet-5** | 最早的实用 CNN，识别手写数字 |
| 2012 | **AlexNet** | 在 ImageNet 大赛一鸣惊人，开启深度学习热潮；用 ReLU、Dropout、GPU |
| 2014 | **VGG** | 全部用 3×3 卷积堆深（16/19 层），结构简洁 |
| 2014 | GoogLeNet / Inception | 多尺度并行卷积、1×1 卷积降维 |
| 2015 | **ResNet** | **残差连接**，训练 50~152 层甚至更深；至今仍是常用骨干 |
| 2017+ | MobileNet / EfficientNet | 轻量化（深度可分离卷积）、复合缩放，适合手机/边缘 |
| 2020+ | **ViT**（Vision Transformer）、ConvNeXt | 把图切成小块用 Transformer；或把 CNN 现代化 |

### 残差块（ResNet 的核心）

<figure class="fig">
<svg viewBox="0 0 740 240" class="dg" role="img" aria-label="残差块：输入经过两层卷积得到 F(x)，同时输入通过跳跃连接直接加到输出上，得到 F(x)+x">
<rect class="b1" x="30" y="90" width="80" height="50" rx="8"/>
<text class="tb" x="70" y="115" text-anchor="middle" dominant-baseline="middle">输入 x</text>
<rect class="b3" x="170" y="90" width="110" height="50" rx="8"/>
<text class="tb" x="225" y="108" text-anchor="middle" dominant-baseline="middle">卷积+BN+ReLU</text>
<text class="ts" x="225" y="128" text-anchor="middle">F 的第一层</text>
<rect class="b3" x="330" y="90" width="110" height="50" rx="8"/>
<text class="tb" x="385" y="108" text-anchor="middle" dominant-baseline="middle">卷积+BN</text>
<text class="ts" x="385" y="128" text-anchor="middle">F 的第二层</text>
<circle class="b5" cx="500" cy="115" r="20"/>
<text class="th" x="500" y="115" text-anchor="middle" dominant-baseline="middle">＋</text>
<rect class="b2" x="560" y="90" width="90" height="50" rx="8"/>
<text class="tb" x="605" y="115" text-anchor="middle" dominant-baseline="middle">ReLU</text>
<line class="l" x1="110" y1="115" x2="170" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="115" x2="330" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="115" x2="480" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="115" x2="560" y2="115" marker-end="url(#arr)"/>
<path class="la nf" d="M70 90 L70 40 L500 40 L500 95" marker-end="url(#arr-a)"/>
<text class="ta" x="285" y="32" text-anchor="middle">跳跃连接（捷径）：直接把 x 加过来</text>
<text class="ts" x="370" y="190" text-anchor="middle">输出 = F(x) + x：网络只需学“在输入基础上的修正量”，而不是从头学整个映射</text>
<text class="ts" x="370" y="212" text-anchor="middle">反向传播时梯度可沿捷径直通 → 解决深层网络的梯度消失，网络可堆到上百层</text>
</svg>
<figcaption>图 4：残差块：输出 = 变换结果 + 原输入</figcaption>
</figure>

## 七、CNN 能做什么

| 任务 | 说明 | 代表 |
| --- | --- | --- |
| **图像分类** | 整张图是什么 | ResNet、EfficientNet |
| **目标检测** | 图里有什么、**在哪里**（框出来） | YOLO、Faster R-CNN |
| **语义/实例分割** | **每个像素**属于哪类 | U-Net、Mask R-CNN |
| 人脸识别、OCR、医学影像、自动驾驶感知 | | |
| 一维/文本/音频 | 一维卷积也能处理序列、频谱 | TextCNN、音频分类 |

### 迁移学习：站在巨人的肩膀上

你没有几百万张标注图片？没关系：

1. 取一个在 **ImageNet（上百万图）上预训练**好的 ResNet；
2. **冻结**前面的层（它们已学会通用的边缘、纹理）；
3. **只替换并训练最后的分类层**（或再微调少量深层），用你自己的几百~几千张图。

这是工业上**最常用**的做法，小数据也能得到很好的效果。

## 八、用代码看一眼

```python
import torch, torch.nn as nn

cnn = nn.Sequential(
    nn.Conv2d(1, 32, kernel_size=3, padding=1), nn.ReLU(), nn.MaxPool2d(2),   # 28x28 → 14x14
    nn.Conv2d(32, 64, kernel_size=3, padding=1), nn.ReLU(), nn.MaxPool2d(2),  # 14x14 → 7x7
    nn.Flatten(),
    nn.Linear(64 * 7 * 7, 128), nn.ReLU(),
    nn.Linear(128, 10)                                                        # 10 类（如手写数字）
)
x = torch.randn(8, 1, 28, 28)           # 一批 8 张灰度图，形状 (批, 通道, 高, 宽)
print(cnn(x).shape)                     # torch.Size([8, 10])
print(sum(p.numel() for p in cnn.parameters()))   # 参数总量，远少于同等能力的全连接网络

# 迁移学习：使用预训练 ResNet，只训练最后一层
from torchvision import models
m = models.resnet18(weights="IMAGENET1K_V1")
for p in m.parameters(): p.requires_grad = False          # 冻结
m.fc = nn.Linear(m.fc.in_features, 5)                      # 换成自己的 5 类分类头（只训练它）
```

## 九、小结表

| 概念 | 一句话 |
| --- | --- |
| 卷积 | 小窗口滑动，对应相乘求和，提取局部特征 |
| 权重共享 | 同一卷积核处处使用 → 参数少、平移不变 |
| 通道 | 一个卷积核产生一张特征图，多个核 = 多通道 |
| 池化 | 缩小尺寸，保留最强响应 |
| 感受野 | 一个神经元能“看到”的原图范围，越深越大 |
| 残差 | 输出 = 变换 + 输入，让网络更深更好训练 |
| 迁移学习 | 用预训练模型做特征提取，只训小头 |

## 自测：你真的懂了吗？

> [!QUESTION] 卷积神经网络为什么比全连接网络更适合图像？
> 图像有局部性和平移不变性：识别一个特征只需看局部，且同一特征可出现在任何位置。卷积用小窗口并共享权重，参数少得多，既减少过拟合又保留了空间结构；全连接把图拉成一维，参数爆炸且丢失邻近关系。

> [!QUESTION] 输入 32×32，3×3 卷积核，填充 1，步长 1，输出尺寸是多少？步长改成 2 呢？
> 公式 (32−3+2×1)/1+1 = 32；步长 2 时 ⌊(32−3+2)/2⌋+1 = 16。

> [!QUESTION] 池化层有参数吗？它起什么作用？
> 没有可学习参数。它对局部区域取最大值或平均值，缩小特征图尺寸、减少计算，并带来一定的平移不变性。

> [!QUESTION] ResNet 的残差连接解决了什么问题？
> 网络很深时梯度消失、训练退化。残差连接让输出等于变换加输入，梯度可沿捷径直接传回浅层，网络只需学习输入的修正量，因此能训练上百层。

> [!QUESTION] 数据很少时怎么用 CNN 做图像分类？
> 用在大数据集上预训练好的模型做迁移学习：冻结大部分层，只替换并训练最后的分类层，或微调少量深层，配合数据增强。
