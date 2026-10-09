---
level: 基础
tags: [训练, 损失函数, 优化器, 正则化, Dropout, 归一化, 梯度消失, 残差, 学习率, 过拟合]
summary: 把神经网络训得好的实用知识：损失函数怎么选，batch/epoch 怎么理解，初始化与归一化，学习率预热与衰减，过拟合的各种对策（权重衰减、Dropout、早停、数据增强），梯度消失/爆炸与残差连接，以及看训练曲线诊断问题的方法。
---

# 训练神经网络：优化器、正则化与常见坑

> [!ABSTRACT] 一句话版本
> 会搭网络只是开始，**让它“训好”**才是手艺。核心就是几件事：
> - **选对损失**（回归用 MSE，分类用交叉熵）和**优化器**（默认先试 **AdamW**）；
> - **学习率**最重要：先预热再衰减；
> - **防过拟合**：数据增强、权重衰减、**Dropout**、**早停**；
> - **让深层网络能训练**：合适的初始化、**归一化**（BatchNorm/LayerNorm）、**残差连接**，避免梯度消失/爆炸；
> - **看曲线**：训练损失和验证损失的走势会告诉你问题出在哪。

> [!NOTE] 先决条件
> 建议先读 [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp) 和 [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)。

## 一、训练里的几个基本词

| 术语 | 含义 | 例子 |
| --- | --- | --- |
| **样本** | 一条数据 | 一张图 + 它的标签 |
| **Batch（批）** | 一次喂给模型的一小批样本 | batch size = 64 |
| **Iteration / Step** | 处理一个 batch、更新一次参数 | |
| **Epoch** | 把**全部训练数据**完整看一遍 | 6 万张图、batch 64 → 每个 epoch 约 938 步 |
| **超参数** | 人定的、不是学出来的设置 | 学习率、batch size、层数、Dropout 概率 |
| **参数** | 训练学出来的 | 权重 W、偏置 b |

**batch size 怎么选**：

| | 小 batch（如 16~32） | 大 batch（如 512+） |
| --- | --- | --- |
| 梯度 | 噪声大，路线抖，但有“正则化”效果 | 平滑准确 |
| 速度 | 每步快、步数多 | 并行效率高，需要更大显存 |
| 学习率 | 小一点 | 通常可以**按比例增大学习率** |

## 二、损失函数怎么选

| 任务 | 常用损失 | 说明 |
| --- | --- | --- |
| **回归**（预测数值） | **MSE** 均方误差；**MAE/Huber**（对异常值更稳） | 输出层不加激活（或视范围而定） |
| **二分类** | **二元交叉熵**（BCE） | 输出层 sigmoid |
| **多分类** | **交叉熵**（CrossEntropy） | 输出层 softmax（框架里常合并在损失里） |
| **语言模型** | 交叉熵（逐 token） | 见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob) |
| 相似度/检索 | **对比损失、三元组损失** | 让相似的向量更近、不相似的更远 |
| 目标检测/分割 | 分类损失 + 框回归损失/Dice 等 | 多项损失加权 |

> [!TIP] 损失 ≠ 你真正关心的指标
> 训练用的损失要**可求导**；而业务关心的指标（准确率、F1）往往不可导。要同时监控两者：损失用来训练，指标用来评判。

## 三、优化器怎么选

| 优化器 | 特点 | 建议 |
| --- | --- | --- |
| SGD（+ 动量） | 简单，泛化好，但学习率敏感 | CNN 经典训练（动量 0.9） |
| **Adam / AdamW** | 自适应步长，收敛快，**默认首选** | **Transformer、LLM、多数新项目** |
| RMSprop | 自适应，常用于 RNN | 少用 |
| Lion、Adafactor 等 | 省显存/新方法 | 大模型场景 |

**AdamW vs Adam**：AdamW 把**权重衰减**与梯度更新“解耦”，正则效果更正确，现在更常用。常见起点：`lr = 1e-3`（小模型）、`1e-4 ~ 3e-4`（Transformer 训练更小），`weight_decay = 0.01`。

## 四、学习率调度：先预热，再衰减

学习率不是一个固定值，通常**随训练进程变化**：

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="学习率调度曲线：开始阶段线性预热上升，达到峰值后按余弦曲线逐渐衰减到很小的值">
<line class="l" x1="50" y1="220" x2="700" y2="220" marker-end="url(#arr)"/>
<line class="l" x1="50" y1="220" x2="50" y2="30" marker-end="url(#arr)"/>
<text class="ts" x="700" y="240" text-anchor="end">训练步数 →</text>
<text class="ts" x="44" y="26" text-anchor="end">学习率</text>
<polyline class="la nf" points="50,214 110,70"/>
<path class="la nf" d="M110 70 C 250 72 330 100 400 140 C 470 180 560 205 690 214"/>
<line class="ld" x1="110" y1="70" x2="110" y2="220"/>
<text class="ta" x="80" y="244" text-anchor="middle">预热</text>
<text class="ts" x="400" y="244" text-anchor="middle">余弦衰减</text>
<text class="ts" x="116" y="62" text-anchor="start">峰值 lr</text>
<rect class="bg" x="440" y="40" width="260" height="90" rx="10"/>
<text class="ts" x="456" y="64">预热：一开始参数是随机的，梯度不靠谱，</text>
<text class="ts" x="456" y="84">用很小的学习率“热身”，避免一上来就炸</text>
<text class="ts" x="456" y="108">衰减：后期步子变小，细致地收敛到谷底</text>
</svg>
<figcaption>图 1：预热 + 余弦衰减：现代训练（尤其是 Transformer）的标配</figcaption>
</figure>

常见调度：**阶梯衰减**（每隔几轮乘 0.1）、**余弦退火**、**线性衰减**、**OneCycle**。训练大模型几乎一定要用**预热**。

## 五、让深层网络能训练起来

### 1. 梯度消失 / 爆炸

反向传播要**连乘**很多层的导数。如果每层导数都小于 1，乘起来趋近 0（**消失**）；大于 1 则趋近无穷（**爆炸**）。

```text
sigmoid 的导数最大只有 0.25。10 层之后：0.25¹⁰ ≈ 0.00000095
→ 前面几层几乎收不到梯度，学不动
```

| 问题 | 现象 | 对策 |
| --- | --- | --- |
| **梯度消失** | 浅层几乎不更新，损失不降 | **ReLU/GELU**、**残差连接**、归一化、LSTM 门控、合适初始化 |
| **梯度爆炸** | 损失突然变 NaN/无穷 | **梯度裁剪**（限制梯度范数）、减小学习率、归一化 |

### 2. 参数初始化

不能全设成 0（所有神经元一模一样，永远学不出差异），也不能随便大：

| 方法 | 适用 | 思路 |
| --- | --- | --- |
| **Xavier/Glorot** | sigmoid、tanh | 方差 ≈ 2/(n入+n出)，让信号在层间不放大不缩小 |
| **He 初始化** | **ReLU** | 方差 ≈ 2/n入，补偿 ReLU 把一半置零 |

框架默认初始化通常已经合理，**不要用全 0 或很大的随机数**。

### 3. 归一化：让数据“规整”

**输入特征**要先**标准化**（减均值、除标准差），否则大小不一的特征会让损失面变成狭长山谷（梯度下降之字形，见 [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)）。**网络内部**也一样：

| 方法 | 在哪个维度归一化 | 常用于 |
| --- | --- | --- |
| **BatchNorm** | 对**同一个特征**，在一个 **batch 内**求均值方差 | CNN；依赖 batch size（太小不稳） |
| **LayerNorm** | 对**同一个样本**的所有特征求均值方差 | **Transformer / LLM / RNN**，不依赖 batch |
| RMSNorm | LayerNorm 的简化版（只除均方根） | 现代大模型 |
| GroupNorm | 分组 | 小 batch 的视觉任务 |

好处：训练更稳定、可以用更大的学习率、对初始化不敏感，还有轻微正则效果。

### 4. 残差连接：给梯度一条“高速公路”

```text
普通层：  y = F(x)
残差层：  y = x + F(x)        ← 把输入直接加到输出上（“跳跃连接”）
```

反向传播时，梯度可以**沿着“加号”那条直通路径**无损地传回去，所以能训练**几十层、上百层**的网络（ResNet 的核心思想）。**Transformer 的每一层也都有残差连接**。

## 六、对付过拟合

回顾：训练集很好、验证集差 = 过拟合，见 [机器学习是什么：回归、分类与过拟合](#/aimodel/ml-intro)。

| 方法 | 做法 | 直觉 |
| --- | --- | --- |
| **更多数据 / 数据增强** | 图片翻转、裁剪、颜色抖动；文本回译、同义替换 | 让模型见多识广，“记不住”每一个样本 |
| **权重衰减 / L2 正则** | 损失里加 `λ·‖W‖²` | 惩罚过大的权重，偏好“简单”的模型 |
| **Dropout** | 训练时随机把一部分神经元输出置 0（如 50%） | 不让神经元“互相依赖”，像训练一大群不同的小网络再集成 |
| **早停（Early Stopping）** | 验证损失不再下降就停止训练 | 在开始过拟合之前停下 |
| **简化模型** | 减少层数/宽度 | 容量小了就记不住噪声 |
| **交叉验证、集成** | 多个模型投票 | 平均掉各自的过拟合 |

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="Dropout：训练时随机丢弃部分神经元，使每次训练的网络结构不同；推理时使用全部神经元">
<text class="th" x="20" y="24">训练时：随机“关掉”一些神经元</text>
<circle class="b3" cx="60" cy="70" r="16"/>
<circle class="b3" cx="60" cy="130" r="16"/>
<circle class="b3" cx="60" cy="190" r="16"/>
<circle class="b1" cx="190" cy="50" r="16"/>
<circle class="bg" cx="190" cy="110" r="16"/>
<circle class="b1" cx="190" cy="170" r="16"/>
<circle class="bg" cx="190" cy="230" r="16"/>
<circle class="b2" cx="320" cy="100" r="16"/>
<circle class="b2" cx="320" cy="160" r="16"/>
<line class="ld" x1="76" y1="70" x2="174" y2="50"/>
<line class="ld" x1="76" y1="130" x2="174" y2="50"/>
<line class="ld" x1="76" y1="190" x2="174" y2="50"/>
<line class="ld" x1="76" y1="70" x2="174" y2="170"/>
<line class="ld" x1="76" y1="130" x2="174" y2="170"/>
<line class="ld" x1="76" y1="190" x2="174" y2="170"/>
<line class="ld" x1="206" y1="50" x2="304" y2="100"/>
<line class="ld" x1="206" y1="50" x2="304" y2="160"/>
<line class="ld" x1="206" y1="170" x2="304" y2="100"/>
<line class="ld" x1="206" y1="170" x2="304" y2="160"/>
<text class="ts" x="190" y="86" text-anchor="middle">✕</text>
<text class="ts" x="190" y="246" text-anchor="middle">✕</text>
<rect class="bg" x="390" y="40" width="330" height="190" rx="12"/>
<text class="th" x="406" y="64">Dropout 要点</text>
<text class="ts" x="406" y="92">• 每次迭代随机丢弃的神经元都不同，</text>
<text class="ts" x="406" y="112">  相当于同时训练很多不同的“子网络”</text>
<text class="ts" x="406" y="140">• 逼迫每个神经元独立有用，不能“抱团”</text>
<text class="ts" x="406" y="168">• 只在训练时开；推理时全部启用</text>
<text class="ts" x="406" y="188">  （框架会自动缩放，保证期望一致）</text>
<text class="ta" x="406" y="216">典型丢弃率 0.1 ~ 0.5；model.eval() 会关闭它</text>
</svg>
<figcaption>图 2：Dropout：训练时随机丢弃神经元</figcaption>
</figure>

## 七、看训练曲线诊断问题

每个 epoch 记录 **训练损失** 和 **验证损失**，画出来：

<figure class="fig">
<svg viewBox="0 0 760 280" class="dg" role="img" aria-label="四种典型训练曲线：正常收敛、过拟合、欠拟合/学习率太小、学习率太大震荡发散">
<line class="l" x1="20" y1="170" x2="170" y2="170"/>
<path class="b2 nf" d="M25 40 C 60 100 100 135 165 150"/>
<path class="b3 nf" d="M25 48 C 60 108 105 140 165 152"/>
<text class="tb" x="95" y="192" text-anchor="middle">正常</text>
<text class="ts" x="95" y="210" text-anchor="middle">两条一起下降并贴近</text>
<line class="l" x1="205" y1="170" x2="355" y2="170"/>
<path class="b2 nf" d="M210 40 C 245 100 285 140 350 158"/>
<path class="b4 nf" d="M210 48 C 245 100 270 112 290 108 C 310 104 330 90 350 70"/>
<text class="tb" x="280" y="192" text-anchor="middle">过拟合</text>
<text class="ts" x="280" y="210" text-anchor="middle">训练降、验证先降后升</text>
<line class="l" x1="390" y1="170" x2="540" y2="170"/>
<path class="b3 nf" d="M395 60 C 440 62 490 66 535 70"/>
<path class="b2 nf" d="M395 64 C 440 66 490 70 535 74"/>
<text class="tb" x="465" y="192" text-anchor="middle">降不下去</text>
<text class="ts" x="465" y="210" text-anchor="middle">欠拟合/学习率太小</text>
<line class="l" x1="575" y1="170" x2="725" y2="170"/>
<polyline class="b4 nf" points="580,100 600,50 620,120 640,40 660,110 680,30 700,100 720,25"/>
<text class="tb" x="650" y="192" text-anchor="middle">剧烈震荡</text>
<text class="ts" x="650" y="210" text-anchor="middle">学习率太大/梯度爆炸</text>
<text class="ts" x="380" y="250" text-anchor="middle">横轴：epoch；纵轴：损失。蓝/绿=训练损失，红=验证损失（示意）</text>
</svg>
<figcaption>图 3：四种典型训练曲线与对应问题</figcaption>
</figure>

| 现象 | 可能原因 | 对策 |
| --- | --- | --- |
| 损失一开始就是 NaN | 学习率太大、数据有异常值、除零/log(0) | 降学习率、检查数据、梯度裁剪 |
| 训练损失不降 | 学习率不合适、模型太小、代码 bug、标签错位 | 调学习率；**先在一小批数据上能否过拟合**（见下） |
| 验证损失先降后升 | 过拟合 | 正则、早停、更多数据 |
| 训练好验证差，且差距巨大 | 数据泄漏/分布不同/过拟合 | 检查划分与预处理 |
| 损失下降到某值后卡住 | 学习率太大/需要衰减、局部平原 | 学习率衰减、换优化器 |

### 一条黄金调试技巧

> [!TIP] 先让模型“过拟合一小批数据”
> 取 10~100 条样本，**关掉正则**，看模型能不能把训练损失降到接近 0。**如果连这个都做不到**，说明代码、损失、学习率或模型结构有 bug；做得到，再放开训练全部数据。这能帮你快速排除一大类低级错误。

## 八、训练一个模型的“检查清单”

```text
□ 数据：标签对不对？打乱了吗？划分有无泄漏？输入标准化了吗？
□ 模型：输出层维度、激活、损失函数是否匹配任务？（多分类别在输出层又 softmax 一次再交给 CrossEntropy）
□ 先跑通：小批量过拟合测试；打印前几步损失（分类初始损失应约等于 ln(类别数)）
□ 优化：AdamW + 合适学习率 + 预热/衰减；必要时梯度裁剪
□ 正则：数据增强、权重衰减、Dropout、早停
□ 监控：训练/验证损失、关键指标、学习率、梯度范数；保存检查点（checkpoint）
□ 复现：固定随机种子，记录超参数与代码版本
□ 工程：混合精度（FP16/BF16）省显存提速；多卡并行；数据加载别成为瓶颈
```

## 九、完整训练循环示例（PyTorch）

```python
import torch, torch.nn as nn
from torch.optim.lr_scheduler import CosineAnnealingLR

model = nn.Sequential(nn.Linear(20, 64), nn.ReLU(), nn.Dropout(0.2), nn.Linear(64, 2))
loss_fn = nn.CrossEntropyLoss()
opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
sched = CosineAnnealingLR(opt, T_max=50)

best, patience = 1e9, 0
for epoch in range(50):
    model.train()                                   # 开启 Dropout
    for X, y in train_loader:
        loss = loss_fn(model(X), y)
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)   # 梯度裁剪
        opt.step()
    sched.step()

    model.eval()                                    # 关闭 Dropout
    with torch.no_grad():
        val = sum(loss_fn(model(X), y).item() for X, y in val_loader) / len(val_loader)
    if val < best: best, patience = val, 0; torch.save(model.state_dict(), "best.pt")
    else:
        patience += 1
        if patience >= 5: break                     # 早停
```

## 自测：你真的懂了吗？

> [!QUESTION] 为什么训练大模型要用学习率预热？
> 训练初期参数是随机的，梯度估计很不可靠，直接用大学习率容易让训练发散或不稳定。先用很小的学习率逐步增大到峰值，再衰减，训练更稳定。

> [!QUESTION] Dropout 是怎么减轻过拟合的？推理时还用吗？
> 训练时随机丢弃一部分神经元，迫使网络不依赖某些特定神经元，相当于训练许多不同子网络的集成。推理时不丢弃，使用完整网络（框架会做缩放保证一致）。

> [!QUESTION] 什么是梯度消失？残差连接怎么帮忙？
> 深层网络反向传播时梯度要逐层连乘，每层导数小于 1 就会趋近 0，浅层收不到有效梯度。残差连接 y=x+F(x) 提供一条直通路径，梯度可以绕过 F 直接传回，所以能训练很深的网络。

> [!QUESTION] BatchNorm 和 LayerNorm 的区别？为什么 Transformer 用 LayerNorm？
> BatchNorm 在 batch 维度上对同一特征归一化，依赖 batch 大小，序列任务里长度不一、batch 小时不稳；LayerNorm 对单个样本的所有特征归一化，不依赖 batch，适合变长序列，所以 Transformer 用它。

> [!QUESTION] 训练损失一直不降，你第一步怎么排查？
> 先取很小的一批数据、关闭正则，看能否把训练损失降到接近 0（过拟合小批量）。做不到说明有代码、标签、损失函数、学习率或模型结构上的 bug；能做到再检查数据与超参数。
