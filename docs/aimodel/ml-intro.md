---
level: 基础
tags: [机器学习, 监督学习, 线性回归, 逻辑回归, 过拟合, 偏差方差, 评价指标, 训练集验证集测试集]
summary: 从“让机器从例子里找规律”出发，讲清机器学习的基本流程（数据—模型—损失—训练—评估）、线性回归与逻辑回归、过拟合与欠拟合、训练/验证/测试集的划分，以及准确率、精确率、召回率、F1 的含义。
---

# 机器学习是什么：回归、分类与过拟合

> [!ABSTRACT] 一句话版本
> **传统编程**：人写规则，机器执行。**机器学习**：人给**大量例子（数据）**，机器**自己总结出规则（模型）**。
> - 做法：定义一个有**可调参数**的模型 → 用**损失函数**衡量错误 → 用**梯度下降**调参数（见 [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)）。
> - 两大任务：**回归**（预测一个数，如房价）和**分类**（预测类别，如垃圾邮件）。
> - 最大的敌人是**过拟合**：模型把训练数据“死记硬背”了，遇到新数据反而表现差。所以要把数据分成**训练集、验证集、测试集**。
> - 看效果要用对指标：**准确率不是万能的**，类别不均衡时要看精确率、召回率、F1。

## 一、从“写规则”到“学规则”

### 传统编程 vs 机器学习

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="传统编程：规则加数据得到答案；机器学习：数据加答案得到规则（模型）">
<text class="th" x="20" y="24">传统编程</text>
<rect class="b1" x="20" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="90" y="68" text-anchor="middle" dominant-baseline="middle">规则（人写）</text>
<rect class="b3" x="20" y="108" width="140" height="56" rx="8"/>
<text class="tb" x="90" y="136" text-anchor="middle" dominant-baseline="middle">数据</text>
<rect class="b2" x="260" y="74" width="120" height="56" rx="8"/>
<text class="tb" x="320" y="102" text-anchor="middle" dominant-baseline="middle">答案</text>
<line class="l" x1="160" y1="68" x2="260" y2="94" marker-end="url(#arr)"/>
<line class="l" x1="160" y1="136" x2="260" y2="112" marker-end="url(#arr)"/>
<text class="th" x="420" y="24">机器学习</text>
<rect class="b3" x="420" y="40" width="140" height="56" rx="8"/>
<text class="tb" x="490" y="68" text-anchor="middle" dominant-baseline="middle">数据</text>
<rect class="b2" x="420" y="108" width="140" height="56" rx="8"/>
<text class="tb" x="490" y="136" text-anchor="middle" dominant-baseline="middle">答案（标签）</text>
<rect class="b1" x="640" y="74" width="80" height="56" rx="8"/>
<text class="tb" x="680" y="102" text-anchor="middle" dominant-baseline="middle">规则/模型</text>
<line class="l" x1="560" y1="68" x2="640" y2="94" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="136" x2="640" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="370" y="206" text-anchor="middle">例：识别垃圾邮件。传统做法要人去总结“含有‘中奖’就是垃圾邮件”，永远写不完；</text>
<text class="ts" x="370" y="228" text-anchor="middle">机器学习给它几万封“标好是否垃圾”的邮件，让它自己找出规律。</text>
</svg>
<figcaption>图 1：传统编程是“规则 + 数据 → 答案”，机器学习是“数据 + 答案 → 规则”</figcaption>
</figure>

### 三大类学习方式

| 类型 | 给机器什么 | 例子 |
| --- | --- | --- |
| **监督学习** | 数据 + **标准答案（标签）** | 邮件→是否垃圾；房屋信息→价格；图片→猫/狗 |
| **无监督学习** | 只有数据，没有答案 | 把用户自动分成几类；发现异常 |
| **强化学习** | 通过**试错和奖励**学习 | 下围棋、机器人走路、让大模型更符合人类偏好 |
| 自监督学习 | 从数据**自己造标签** | **大语言模型**：预测下一个词（答案就在原文里） |

本页主要讲**监督学习**，它是最基础、最常用的。

## 二、机器学习的标准流程

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="机器学习流程：收集数据、清洗与特征处理、划分数据集、选择模型、训练、评估、部署与监控，评估不满意就返回改进">
<rect class="b1" x="20" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="67" y="88" text-anchor="middle" dominant-baseline="middle">①收集数据</text>
<rect class="b1" x="130" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="177" y="88" text-anchor="middle" dominant-baseline="middle">②清洗特征</text>
<rect class="b3" x="240" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="287" y="88" text-anchor="middle" dominant-baseline="middle">③划分数据集</text>
<rect class="b3" x="350" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="397" y="88" text-anchor="middle" dominant-baseline="middle">④选模型</text>
<rect class="b5" x="460" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="507" y="88" text-anchor="middle" dominant-baseline="middle">⑤训练</text>
<rect class="b4" x="570" y="60" width="95" height="56" rx="8"/>
<text class="tb" x="617" y="88" text-anchor="middle" dominant-baseline="middle">⑥评估</text>
<rect class="b2" x="680" y="60" width="60" height="56" rx="8"/>
<text class="tb" x="710" y="88" text-anchor="middle" dominant-baseline="middle">⑦上线</text>
<line class="l" x1="115" y1="88" x2="130" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="225" y1="88" x2="240" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="335" y1="88" x2="350" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="445" y1="88" x2="460" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="555" y1="88" x2="570" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="665" y1="88" x2="680" y2="88" marker-end="url(#arr)"/>
<path class="la nf" d="M617 116 L617 170 L177 170 L177 116" marker-end="url(#arr-a)"/>
<text class="ta" x="397" y="194" text-anchor="middle">效果不好 → 回去补数据/换特征/换模型/调参数（循环迭代）</text>
<text class="ts" x="397" y="222" text-anchor="middle">现实中，“数据”那两步往往占一大半时间，模型本身反而是最容易的部分</text>
</svg>
<figcaption>图 2：机器学习项目的典型流程</figcaption>
</figure>

## 三、线性回归：用直线预测一个数

### 场景

根据房子**面积**预测**价格**。有一些历史数据（面积 → 价格），想画一条“最合适的直线”。

```text
模型：  ŷ = w · x + b          x 是面积，ŷ 是预测价格
        w（斜率）、b（截距）是要学习的参数
损失：  L = 平均( (ŷ − 真实价格)² )        均方误差（MSE）
训练：  梯度下降，反复调 w 和 b 让 L 变小
```

> [!NOTE] 你已经见过它了
> 上一章用梯度下降“拟合 y=2x”就是最简单的线性回归，见 [微积分 2：梯度下降，机器如何“学习”](#/aimodel/math-calc2)。

多个特征（面积、房龄、地段…）时变成多元线性回归，用向量写：`ŷ = w·x + b`（点积，见 [线性代数 1：向量与矩阵](#/aimodel/math-la1)）。**一个神经元就是它再套一个激活函数**。

## 四、逻辑回归：用直线做分类

### 场景

判断一封邮件是否垃圾邮件（只有两类：是 / 否）。

直接用线性回归输出的是任意实数，不是概率。所以套一个 **sigmoid 函数**把它压到 0~1：

```text
z = w·x + b                       线性打分
p = σ(z) = 1 / (1 + e^(−z))       变成概率：p = 垃圾邮件的概率
```

| z | σ(z) | 含义 |
| --- | --- | --- |
| −5 | 0.007 | 几乎肯定不是垃圾 |
| 0 | 0.5 | 五五开 |
| +5 | 0.993 | 几乎肯定是垃圾 |

决策规则：`p > 0.5` 判为垃圾邮件。**z = 0（即 w·x + b = 0）就是决策边界**——二维里是一条直线，把平面分成两部分。

训练用**交叉熵损失**（见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)）。

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="左图：线性回归用一条直线拟合散点；右图：逻辑回归的决策边界把两类点分开，sigmoid 曲线把分数转成概率">
<line class="l" x1="30" y1="240" x2="330" y2="240" marker-end="url(#arr)"/>
<line class="l" x1="30" y1="240" x2="30" y2="30" marker-end="url(#arr)"/>
<circle class="b1" cx="70" cy="200" r="4"/>
<circle class="b1" cx="100" cy="185" r="4"/>
<circle class="b1" cx="130" cy="170" r="4"/>
<circle class="b1" cx="160" cy="150" r="4"/>
<circle class="b1" cx="190" cy="135" r="4"/>
<circle class="b1" cx="220" cy="105" r="4"/>
<circle class="b1" cx="250" cy="95" r="4"/>
<circle class="b1" cx="285" cy="70" r="4"/>
<line class="la" x1="50" y1="212" x2="300" y2="64"/>
<text class="ts" x="180" y="266" text-anchor="middle">线性回归：用直线拟合（预测一个数）</text>
<line class="l" x1="400" y1="240" x2="720" y2="240" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="240" x2="400" y2="30" marker-end="url(#arr)"/>
<circle class="b2" cx="450" cy="190" r="4"/>
<circle class="b2" cx="480" cy="210" r="4"/>
<circle class="b2" cx="510" cy="175" r="4"/>
<circle class="b2" cx="470" cy="150" r="4"/>
<circle class="b2" cx="530" cy="200" r="4"/>
<circle class="b4" cx="600" cy="90" r="4"/>
<circle class="b4" cx="640" cy="120" r="4"/>
<circle class="b4" cx="670" cy="70" r="4"/>
<circle class="b4" cx="620" cy="60" r="4"/>
<circle class="b4" cx="580" cy="130" r="4"/>
<line class="la" x1="520" y1="60" x2="640" y2="220"/>
<text class="ta" x="620" y="236" text-anchor="start">决策边界</text>
<text class="ts" x="560" y="266" text-anchor="middle">逻辑回归：用直线分两类（预测类别）</text>
</svg>
<figcaption>图 3：线性回归预测数值，逻辑回归画出决策边界做分类</figcaption>
</figure>

### 如果数据不能被一条直线分开？

比如两类数据排成“内圈和外圈”，直线怎么画都分不开。办法：

- **特征工程**：加入新特征（如 x²）；
- 换更强的模型：**决策树、神经网络**……

这就引出了**神经网络**：它用**多层“线性 + 非线性”**自动学出复杂的边界，见 [MLP：神经元、多层感知机与反向传播](#/aimodel/mlp)。

## 五、过拟合与欠拟合（最重要的概念）

### 用“备考”类比

- **欠拟合**：复习不够，课本都没掌握，**平时练习和考试都考不好**；
- **刚刚好**：真正理解了规律，**新题也会做**；
- **过拟合**：把历史题**答案死记硬背**，练习题满分，但**考试换了题目就不会**。

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="三张拟合图：欠拟合的直线、拟合良好的平滑曲线、过拟合的穿过每个点的剧烈弯曲线">
<line class="l" x1="20" y1="210" x2="240" y2="210"/>
<circle class="b1" cx="45" cy="170" r="4"/>
<circle class="b1" cx="80" cy="120" r="4"/>
<circle class="b1" cx="115" cy="100" r="4"/>
<circle class="b1" cx="150" cy="130" r="4"/>
<circle class="b1" cx="185" cy="90" r="4"/>
<circle class="b1" cx="220" cy="60" r="4"/>
<line class="la" x1="35" y1="150" x2="235" y2="140"/>
<text class="tb" x="130" y="236" text-anchor="middle">欠拟合</text>
<text class="ts" x="130" y="256" text-anchor="middle">模型太简单，学不会规律</text>
<line class="l" x1="270" y1="210" x2="490" y2="210"/>
<circle class="b1" cx="295" cy="170" r="4"/>
<circle class="b1" cx="330" cy="120" r="4"/>
<circle class="b1" cx="365" cy="100" r="4"/>
<circle class="b1" cx="400" cy="130" r="4"/>
<circle class="b1" cx="435" cy="90" r="4"/>
<circle class="b1" cx="470" cy="60" r="4"/>
<path class="la nf" d="M285 180 C 320 100 350 90 380 115 C 405 135 430 90 480 55"/>
<text class="tb" x="380" y="236" text-anchor="middle">刚刚好</text>
<text class="ts" x="380" y="256" text-anchor="middle">抓住了主要趋势，抗噪声</text>
<line class="l" x1="520" y1="210" x2="740" y2="210"/>
<circle class="b1" cx="545" cy="170" r="4"/>
<circle class="b1" cx="580" cy="120" r="4"/>
<circle class="b1" cx="615" cy="100" r="4"/>
<circle class="b1" cx="650" cy="130" r="4"/>
<circle class="b1" cx="685" cy="90" r="4"/>
<circle class="b1" cx="720" cy="60" r="4"/>
<path class="la nf" d="M535 190 C 550 210 565 60 580 120 C 595 160 600 40 615 100 C 630 150 640 170 650 130 C 665 60 675 130 685 90 C 700 40 710 90 720 60"/>
<text class="tb" x="630" y="236" text-anchor="middle">过拟合</text>
<text class="ts" x="630" y="256" text-anchor="middle">连噪声都记住了</text>
</svg>
<figcaption>图 4：欠拟合、刚刚好、过拟合</figcaption>
</figure>

### 怎么发现

关键是**不能用训练数据来检查效果**（会骗自己）。要留出模型**没见过**的数据来测试。

| 训练集表现 | 新数据表现 | 诊断 |
| --- | --- | --- |
| 差 | 差 | **欠拟合**（太简单/训练不够） |
| 好 | 好 | 正常 ✓ |
| **很好** | **差很多** | **过拟合** |

### 怎么办

| 问题 | 对策 |
| --- | --- |
| 欠拟合 | 用更强的模型（更多层/更多参数）、加特征、训练更久、减少正则 |
| **过拟合** | **更多数据**、数据增强、**正则化**（L2、Dropout，见 [训练神经网络：优化器、正则化与常见坑](#/aimodel/training)）、**早停**、简化模型、交叉验证 |

### 偏差与方差

| | 含义 | 对应 |
| --- | --- | --- |
| **偏差（Bias）** | 模型本身太简单，**系统性地**偏离真相 | 欠拟合 |
| **方差（Variance）** | 模型太敏感，换一批训练数据结果就**大变** | 过拟合 |

**偏差-方差权衡**：模型越复杂，偏差越小、方差越大。目标是找到**总误差最小**的那个平衡点。

## 六、训练集 / 验证集 / 测试集

<figure class="fig">
<svg viewBox="0 0 740 220" class="dg" role="img" aria-label="数据集划分：训练集占大多数用于学习，验证集用于调参和选择模型，测试集只在最后评估一次">
<rect class="b1" x="20" y="50" width="420" height="60" rx="0"/>
<text class="tb" x="230" y="74" text-anchor="middle" dominant-baseline="middle">训练集 Train（约 70%）</text>
<text class="ts" x="230" y="94" text-anchor="middle">用来学习：算梯度、更新参数</text>
<rect class="b3" x="440" y="50" width="140" height="60" rx="0"/>
<text class="tb" x="510" y="74" text-anchor="middle" dominant-baseline="middle">验证集 Val（15%）</text>
<text class="ts" x="510" y="94" text-anchor="middle">调超参数、选模型</text>
<rect class="b4" x="580" y="50" width="140" height="60" rx="0"/>
<text class="tb" x="650" y="74" text-anchor="middle" dominant-baseline="middle">测试集 Test（15%）</text>
<text class="ts" x="650" y="94" text-anchor="middle">最后只评估一次</text>
<text class="ts" x="20" y="150" text-anchor="start">类比：训练集 = 平时作业；验证集 = 模拟考（用来调整复习策略）；测试集 = 高考（只考一次，不能提前看）</text>
<text class="ta" x="20" y="176" text-anchor="start">铁律：测试集绝对不能参与训练或调参，否则成绩“虚高”（数据泄漏）</text>
<text class="ts" x="20" y="200" text-anchor="start">数据少时可用 K 折交叉验证：轮流把每一份当验证集，更充分地利用数据</text>
</svg>
<figcaption>图 5：三份数据各司其职</figcaption>
</figure>

> [!WARNING] 常见的“数据泄漏”
> - 在划分之前就对**全部数据**做了标准化/填充缺失值（让测试集的信息“漏”进训练）；
> - 时间序列数据随机打乱划分（用“未来”预测“过去”）；
> - 同一个用户的数据同时出现在训练集和测试集。
> 这些都会让线下指标很好看、上线后却大幅下滑。

## 七、评价指标：不要只看“准确率”

### 为什么准确率会骗人

某疾病发病率只有 1%。一个“**永远预测没病**”的懒模型，准确率是 **99%**——但它**一个病人都没找出来**，毫无用处。

### 混淆矩阵与四个指标

100 个样本，模型预测“有病”：

| | 实际有病 | 实际没病 |
| --- | --- | --- |
| **预测有病** | TP = 40（找对了） | FP = 10（误报） |
| **预测没病** | FN = 20（漏掉了） | TN = 30（排除对了） |

```text
准确率 Accuracy  = (TP+TN) / 总数 = (40+30)/100 = 0.70        整体对了多少
精确率 Precision = TP / (TP+FP)   = 40/50  = 0.80              说“有病”的里面，真有病的占多少（宁缺毋滥）
召回率 Recall    = TP / (TP+FN)   = 40/60  ≈ 0.667             真有病的里面，被找出来多少（宁可错杀）
F1               = 2·P·R/(P+R)    ≈ 0.727                      精确率与召回率的调和平均
```

| 场景 | 更看重 |
| --- | --- |
| 垃圾邮件过滤（别把重要邮件误判为垃圾） | **精确率** |
| 疾病筛查、风控抓欺诈（别漏掉坏人） | **召回率** |
| 两者都要 | **F1** |

**回归任务**常用：**MAE**（平均绝对误差）、**MSE/RMSE**、**R²**。

### 阈值与 ROC/AUC（了解）

分类模型输出概率，把“多少以上算阳性”的**阈值**调高，精确率上升、召回率下降，反之亦然。**ROC 曲线 / AUC** 衡量模型在**所有阈值下**的综合区分能力，AUC 越接近 1 越好，0.5 等于瞎猜。

## 八、除了神经网络，还有哪些经典模型？

| 模型 | 一句话 | 适合 |
| --- | --- | --- |
| **线性/逻辑回归** | 简单、可解释、快 | 基线模型、特征线性相关 |
| **决策树** | 一连串“如果…就…”的问题 | 可解释、表格数据 |
| **随机森林 / XGBoost / LightGBM** | 很多棵树投票/接力 | **表格数据常常的最强选手**，比深度学习还好用 |
| **KNN（最近邻）** | 看周围最近的 k 个邻居 | 简单直观，数据不大 |
| **SVM** | 找“间隔最大”的分界线 | 中小数据、高维 |
| **K-Means** | 把数据自动分成 k 堆 | 聚类（无监督） |
| **神经网络** | 多层“线性+非线性” | 图像、语音、文本等**非结构化数据**，大模型的基础 |

> [!TIP] 选模型的经验
> 表格数据（Excel 那样的行列数据）→ 先试**梯度提升树（XGBoost/LightGBM）**；图像/文本/语音 → **深度学习**。更多见 [AI 模型的“性格画像”：怎么选模型](#/aimodel/personality)。

## 九、动手：十行代码做一次完整流程

```python
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score

X, y = load_breast_cancer(return_X_y=True)
X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=0, stratify=y)

scaler = StandardScaler().fit(X_tr)                 # 只用训练集拟合标准化，避免数据泄漏！
X_tr, X_te = scaler.transform(X_tr), scaler.transform(X_te)

model = LogisticRegression(max_iter=1000).fit(X_tr, y_tr)
pred = model.predict(X_te)
print("准确率", accuracy_score(y_te, pred))
print("精确率", precision_score(y_te, pred), "召回率", recall_score(y_te, pred), "F1", f1_score(y_te, pred))
```

## 自测：你真的懂了吗？

> [!QUESTION] 机器学习与传统编程的核心区别是什么？
> 传统编程是人写规则，用数据产生答案；机器学习是给数据和答案，让机器自己总结出规则（模型）。

> [!QUESTION] 什么是过拟合？怎么发现和缓解？
> 模型把训练数据（包括噪声）死记硬背，训练集表现很好但新数据表现差。通过留出验证/测试集对比发现；缓解办法有更多数据、数据增强、正则化（L2、Dropout）、早停、简化模型、交叉验证。

> [!QUESTION] 为什么要划分训练集、验证集和测试集？
> 训练集用来学习，验证集用来调超参数和选模型，测试集只在最后评估一次，反映对新数据的真实表现。测试集参与训练或调参会导致成绩虚高。

> [!QUESTION] 发病率 1% 的疾病，模型永远预测“没病”，准确率 99%，为什么没用？应该看什么指标？
> 它没有找出任何病人，召回率为 0。类别不均衡时准确率会骗人，应看精确率、召回率、F1 或 AUC，筛查场景尤其要关注召回率。

> [!QUESTION] 逻辑回归虽然叫“回归”，它做的是什么任务？
> 做分类。它先线性打分，再用 sigmoid 把分数压成 0~1 的概率，按阈值（常用 0.5）判定类别，决策边界是 w·x+b=0。
