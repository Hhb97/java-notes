---
level: 基础
tags: [LLM, 大语言模型, 预训练, 分词, 下一个词预测, 指令微调, RLHF, 规模定律, 幻觉, 上下文学习]
summary: 把大语言模型讲明白：它本质是在做“下一个词预测”，文字如何被切成 token，三阶段训练（预训练、指令微调、偏好对齐）各自做什么，规模定律与“涌现”，为什么会有幻觉，以及提示词、RAG、Agent 如何建立在它之上。
---

# LLM：从预训练到对话助手

> [!ABSTRACT] 一句话版本
> - **大语言模型（LLM）= 一个超大号的 Transformer，用海量文本训练它做一件事：根据前文预测下一个词（token）**。
> - 这个看似简单的任务，逼着模型学会了**语法、事实、推理、代码**——因为要预测准，就得“理解”。
> - 训练分三步：**预训练**（读万亿级文字，学会“续写”）→ **指令微调 SFT**（学会“按指令回答”）→ **偏好对齐 RLHF/DPO**（学会“回答得符合人类喜好”）。
> - 模型**不是数据库**，它输出的是“概率上最可能的下一个词”，所以会**一本正经地胡说**（幻觉）；要靠 **RAG、工具、校验**来补足。
> - 理解了它，你就理解了 ChatGPT、Claude、Gemini、DeepSeek、通义千问们的共同原理。

> [!NOTE] 先决条件
> 建议先读 [注意力与 Transformer：大模型的骨架](#/aimodel/transformer) 和 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)。

## 一、LLM 到底在做什么：玩“文字接龙”

你手机输入法会猜你下一个字。**LLM 就是一个强大得多的“超级输入法”**：

```text
输入：   “今天天气真”
模型输出的概率分布（词表里每个词都有一个概率）：
        好     0.52
        不错   0.21
        热     0.08
        糟     0.05
        ……
```

选出一个词（比如“好”），**把它接到输入后面，再预测下一个**，如此循环，一个字一个字“接”出整段话——这叫**自回归生成**。

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="自回归生成：模型根据已有文字预测下一个词的概率分布，采样一个词接到后面，再继续预测，循环直到结束">
<rect class="b1" x="20" y="30" width="190" height="46" rx="8"/>
<text class="tb" x="115" y="53" text-anchor="middle" dominant-baseline="middle">今天 天气 真</text>
<rect class="b3" x="250" y="20" width="140" height="66" rx="10"/>
<text class="tb" x="320" y="46" text-anchor="middle" dominant-baseline="middle">LLM</text>
<text class="ts" x="320" y="66" text-anchor="middle">(Transformer)</text>
<line class="l" x1="210" y1="53" x2="250" y2="53" marker-end="url(#arr)"/>
<rect class="b" x="430" y="20" width="170" height="130" rx="8"/>
<text class="th" x="515" y="42" text-anchor="middle">下一个词的概率</text>
<rect class="b2" x="440" y="52" width="104" height="14" rx="2"/>
<text class="ts" x="450" y="63" text-anchor="start">好 0.52</text>
<rect class="b2" x="440" y="72" width="42" height="14" rx="2"/>
<text class="ts" x="450" y="83" text-anchor="start">不错 0.21</text>
<rect class="b3" x="440" y="92" width="16" height="14" rx="2"/>
<text class="ts" x="462" y="103" text-anchor="start">热 0.08</text>
<rect class="b3" x="440" y="112" width="10" height="14" rx="2"/>
<text class="ts" x="456" y="123" text-anchor="start">糟 0.05 …</text>
<line class="l" x1="390" y1="53" x2="430" y2="53" marker-end="url(#arr)"/>
<rect class="b4" x="630" y="46" width="110" height="46" rx="8"/>
<text class="tb" x="685" y="62" text-anchor="middle" dominant-baseline="middle">采样一个词</text>
<text class="ts" x="685" y="80" text-anchor="middle">选中“好”</text>
<line class="l" x1="600" y1="68" x2="630" y2="68" marker-end="url(#arr)"/>
<path class="la nf" d="M685 92 L685 190 L115 190 L115 76" marker-end="url(#arr-a)"/>
<text class="ta" x="400" y="184" text-anchor="middle">把“好”接到末尾，得到“今天天气真好”，再预测下一个……</text>
<text class="ts" x="400" y="222" text-anchor="middle">一直循环，直到模型输出“结束符”。这就是对话、写作、写代码的统一机制</text>
</svg>
<figcaption>图 1：自回归生成：预测、选词、接上、再预测</figcaption>
</figure>

### 为什么“接龙”能学会这么多

要把“**爱因斯坦提出了相对论，他出生在____**”接对（德国），模型必须**记住事实**；要接对“**25 + 37 =**”，需要**学会计算**；要接对一段代码，需要**理解语法和逻辑**。**为了把预测的误差降到最低，模型被迫在内部形成对世界的“压缩理解”**。这就是“预测下一个词”这个简单目标为何如此强大。

## 二、第一步：把文字变成数字（Token 与 Embedding）

### 1. 分词（Tokenization）

模型不认识“字”，认识的是 **token（词元）**——介于字和词之间的片段，用 **BPE** 等算法统计出来：常见的词是一个 token，生僻词会被拆成几块。

```text
"unbelievable"  → ["un", "believ", "able"]        3 个 token
"今天天气真好"   → ["今天", "天气", "真", "好"]     约 4 个 token（因分词器而异）
```

每个 token 对应词表中的一个**编号**（词表大小通常几万到十几万）。**中文一个汉字常约 1~2 个 token**，所以同样意思的文本，中文可能比英文消耗更多 token。（计费、上下文长度都按 token 算，见 [大模型应用基础与 API 调用](#/ai/llm)。）

### 2. 词嵌入（Embedding）

每个 token 编号会被查表换成一个**向量**（几百到几千维），这个向量是**学出来的**，使“意思相近的 token 向量相近”。之后 Transformer 在这些向量上做所有计算。

```text
文字 → token 编号 → 嵌入向量 → [Transformer × N 层] → 预测下一个 token 的概率
```

## 三、第二步：训练的三个阶段

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="LLM 训练的三阶段：预训练得到会续写的基座模型，指令微调得到会按指令回答的模型，偏好对齐得到更符合人类期望的对话助手">
<rect class="b3" x="20" y="40" width="220" height="200" rx="12"/>
<text class="th" x="130" y="64" text-anchor="middle">① 预训练 Pre-training</text>
<text class="ts" x="130" y="92" text-anchor="middle">数据：万亿级 token 的</text>
<text class="ts" x="130" y="110" text-anchor="middle">网页、书籍、代码、论文</text>
<text class="ts" x="130" y="138" text-anchor="middle">任务：预测下一个词</text>
<text class="ts" x="130" y="156" text-anchor="middle">（自监督，无需人工标注）</text>
<text class="ts" x="130" y="184" text-anchor="middle">成本：最贵，数千~万张 GPU</text>
<text class="ts" x="130" y="202" text-anchor="middle">训练数周到数月</text>
<text class="ta" x="130" y="228" text-anchor="middle">产出：基座模型（会续写）</text>
<rect class="b5" x="280" y="40" width="220" height="200" rx="12"/>
<text class="th" x="390" y="64" text-anchor="middle">② 指令微调 SFT</text>
<text class="ts" x="390" y="92" text-anchor="middle">数据：几万~几十万条</text>
<text class="ts" x="390" y="110" text-anchor="middle">高质量“指令—回答”示例</text>
<text class="ts" x="390" y="138" text-anchor="middle">任务：学会按指令回答，</text>
<text class="ts" x="390" y="156" text-anchor="middle">而不是只会续写</text>
<text class="ts" x="390" y="184" text-anchor="middle">成本：比预训练小得多</text>
<text class="ta" x="390" y="228" text-anchor="middle">产出：能听懂指令的模型</text>
<rect class="b2" x="540" y="40" width="220" height="200" rx="12"/>
<text class="th" x="650" y="64" text-anchor="middle">③ 偏好对齐 RLHF / DPO</text>
<text class="ts" x="650" y="92" text-anchor="middle">数据：人类对多个回答的</text>
<text class="ts" x="650" y="110" text-anchor="middle">“哪个更好”的偏好排序</text>
<text class="ts" x="650" y="138" text-anchor="middle">任务：让回答更有用、</text>
<text class="ts" x="650" y="156" text-anchor="middle">更诚实、更无害</text>
<text class="ts" x="650" y="184" text-anchor="middle">方法：奖励模型 + 强化学习，</text>
<text class="ts" x="650" y="202" text-anchor="middle">或直接偏好优化（DPO）</text>
<text class="ta" x="650" y="228" text-anchor="middle">产出：对话助手（如 ChatGPT）</text>
<line class="l" x1="240" y1="140" x2="280" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="140" x2="540" y2="140" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="260" width="740" height="80" rx="10"/>
<text class="ts" x="380" y="284" text-anchor="middle">类比：预训练 = 读遍图书馆，博学但不知道怎么和人交流；SFT = 学习怎么回答问题、按格式做事；</text>
<text class="ts" x="380" y="306" text-anchor="middle">对齐 = 通过人类反馈学会“说话得体”（有用、诚实、安全）。此外还有近年的“推理强化学习”，让模型学会长链条思考</text>
<text class="ts" x="380" y="328" text-anchor="middle">企业日常很少做预训练，多是直接使用现成基座，再做 SFT / LoRA 微调或搭配 RAG</text>
</svg>
<figcaption>图 2：LLM 的三阶段训练：预训练 → 指令微调 → 偏好对齐</figcaption>
</figure>

### 阶段一：预训练（最贵、最基础）

- **数据**：来自互联网网页、书籍、百科、论文、代码等，要经过**去重、清洗、过滤低质量与有害内容**，数据质量非常关键；
- **目标**：对每个位置做“下一个词”预测，损失就是**交叉熵**（见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)）；
- **规模**：模型几十亿到数千亿参数，训练数据万亿级 token，需要成千上万块 GPU 并行（数据并行、张量并行、流水线并行），训练耗时数周到数月、成本极高；
- **产出**：**基座模型（Base Model）**，它知识丰富，但只会“续写”：你问“法国首都是哪里？”，它可能接着写“德国首都是哪里？意大利首都……”（因为网上常有这类列表）。

### 阶段二：指令微调（SFT）

用**人工写好的“指令—理想回答”配对数据**继续训练，让模型学会**对话格式**和**遵循指令**。数据量不大（几万~几十万条），但**质量远比数量重要**。

```text
指令：用一句话解释光合作用。
回答：光合作用是植物利用阳光，把二氧化碳和水转化为糖类并释放氧气的过程。
```

### 阶段三：偏好对齐（RLHF / DPO）

SFT 之后，模型的回答可能有用但不够好（啰嗦、胡说、不安全）。让**人类比较多个回答哪个更好**，再让模型朝“更受偏好”的方向改进：

| 方法 | 思路 |
| --- | --- |
| **RLHF** | ① 用人类偏好训练一个**奖励模型**（给回答打分）；② 用**强化学习**（如 PPO）让模型生成高分回答，同时用 **KL 散度**约束它别偏离原模型太远 |
| **DPO** | 直接用“好回答 vs 差回答”的偏好对优化，**省掉奖励模型和强化学习**，更简单稳定 |
| 基于规则/AI 反馈（RLAIF） | 用模型或规则代替部分人类标注 |
| **推理强化学习** | 对数学/代码等有**可验证答案**的任务，用对错作为奖励，激发长链条思考（“思考型”模型） |

## 四、规模定律与“涌现”

### 规模定律（Scaling Laws）

研究发现：模型的**测试损失**随着**参数量 N、数据量 D、计算量 C** 的增加，呈**平滑的幂律下降**。大致意思：**同样的方法，投入更多的参数、数据和算力，效果就稳定地变好**。这解释了为什么各家都在“做大”，也说明**数据量和模型大小需要匹配**（只加参数不加数据会浪费）。

> [!NOTE] 趋势在演变
> 近年重点也转向：**更高质量的数据、更高效的架构（MoE 混合专家）、推理时的算力投入（让模型“多想一会儿”）、小而精的模型**。单纯堆参数的收益在放缓，但规模仍是重要因素。

### 涌现能力

当模型规模跨过某些门槛，**一些能力似乎“突然”出现**：多步算术、代码生成、思维链推理、**上下文学习**。学界对“涌现”到底是真实的相变还是评测指标造成的错觉仍有争论；但实践中确实观察到**大模型具备小模型没有的能力**。

## 五、模型如何“接受指令”：上下文学习与提示词

**上下文学习（In-Context Learning）**：不修改模型参数，**只在输入里给几个例子**，模型就能“照着做”：

```text
把句子翻译成英文：
苹果 → apple
香蕉 → banana
西瓜 →
```

模型续写出 `watermelon`。**提示词**（prompt）就是在“引导续写的方向”。要点：

- 说清**角色、任务、格式、约束**；给**示例**效果更好；
- 复杂问题让它“**一步一步想**”（思维链），准确率常明显提升；
- 详见 [大模型应用基础与 API 调用](#/ai/llm) 与 [LLM 应用工程化、安全与评测](#/ai/llmops)。

## 六、生成时的“旋钮”

模型每一步输出的是**概率分布**，怎么选下一个词由**解码策略**决定：

| 参数/策略 | 含义 | 效果 |
| --- | --- | --- |
| **贪心** | 永远选概率最大的 | 稳定但死板、容易重复 |
| **temperature（温度）** | 调整概率分布的“尖锐度”（见 [概率与信息论入门：损失函数从哪来](#/aimodel/math-prob)） | 低 → 保守确定；高 → 更有创意但易出错 |
| **top-k** | 只在概率最高的 k 个词里选 | 限制胡乱选词 |
| **top-p（核采样）** | 只在累计概率达到 p 的最小词集合里选 | 自适应，最常用 |
| 重复惩罚 | 降低已出现词的概率 | 避免车轱辘话 |

事实性任务（抽取、问答）用**低温度**；创作用**较高温度**。

## 七、为什么会“一本正经地胡说”（幻觉）

| 原因 | 说明 |
| --- | --- |
| **目标是“像”，不是“对”** | 模型被训练成生成**最可能**的文字，而不是**最真实**的文字；没见过的事实它也会“编一个听起来合理的” |
| 知识有截止日期 | 训练数据到某个时间为止，不知道之后的事 |
| 长尾知识记不住 | 冷门事实在数据中出现很少，记忆模糊 |
| 对话压力 | 对齐训练倾向“给出回答”，不善于说“我不知道” |
| 上下文被带偏 | 提示里有错误信息，它会顺着错下去 |

**怎么缓解**：

- **RAG**：先检索可靠资料再让模型依据回答（[RAG 原理与完整流水线](#/ai/rag)）；
- **工具调用**：计算用计算器、查询用数据库（[Agent、工具调用与 MCP](#/ai/agent)）；
- 要求**给出引用**、允许回答“不知道”；
- 低温度、结构化输出、**事后校验**；关键场景必须**人工复核**。

## 八、LLM 不是什么

| 常见误解 | 事实 |
| --- | --- |
| “它像搜索引擎一样查资料” | 它**没有联网**（除非接了工具），回答来自参数里压缩的知识 |
| “它像数据库，存了准确事实” | 它是**概率生成器**，不保证准确 |
| “它有记忆，记得上次聊天” | 默认**每次请求无状态**；“记忆”是应用把历史重新塞进输入 |
| “它真的理解/有意识” | 它表现出强大的理解和推理能力，但本质仍是对序列的统计建模；是否“真正理解”是哲学与科学争论 |
| “更大就一定更好” | 数据质量、对齐、推理方式、专精程度同样关键；小模型+微调常能满足特定任务 |

## 九、LLM 家族与相关技术

| 类别 | 说明 |
| --- | --- |
| **闭源 API 模型** | GPT、Claude、Gemini 等；能力强、易用、按 token 付费 |
| **开源权重模型** | LLaMA、Qwen（通义千问）、DeepSeek、Mistral、GLM 等；可私有化部署、可微调 |
| **MoE（混合专家）** | 总参数很大但每个 token 只激活一部分专家，**降低计算量**（见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)） |
| **多模态** | 同时理解图像、音频、视频、文本（把图像也切成 token 喂入） |
| **推理/思考模型** | 通过强化学习学会长链条推理，在数学、代码上更强，推理更耗时 |
| **嵌入模型** | 把文本变成向量，用于检索 / RAG（BERT 类） |
| **小模型 / 端侧模型** | 几亿~几十亿参数，经量化可在手机/笔记本运行 |

## 十、你现在可以怎么用 LLM 做事

| 目标 | 做法 | 去哪学 |
| --- | --- | --- |
| 直接聊天、写作、编程辅助 | 使用对话产品，学好提示词 | [大模型应用基础与 API 调用](#/ai/llm) |
| 让它回答公司私有知识 | **RAG** | [RAG 原理与完整流水线](#/ai/rag) |
| 让它自动完成多步任务 | **Agent + 工具** | [Agent、工具调用与 MCP](#/ai/agent) |
| 在 Java 项目里集成 | Spring AI / LangChain4j | [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai) |
| 降低成本/私有部署 | 量化、vLLM、小模型 | [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals) |
| 做出自己的垂直模型 | LoRA 微调 | 同上 |

## 十一、一个极简“语言模型”：感受一下原理

下面用**二元统计**（只看前一个词）做最简单的“接龙”，让你体会“根据前文预测下一个词 + 采样”：

```python
import random
from collections import defaultdict, Counter

corpus = "我 爱 学习 。 我 爱 编程 。 你 爱 学习 。".split()
bigram = defaultdict(Counter)
for a, b in zip(corpus, corpus[1:]):
    bigram[a][b] += 1                      # 统计：a 后面出现 b 的次数

def next_word(w):
    words, counts = zip(*bigram[w].items())
    return random.choices(words, weights=counts)[0]   # 按频率采样（相当于 temperature=1）

w, out = "我", ["我"]
for _ in range(6):
    w = next_word(w); out.append(w)
    if w == "。": break
print(" ".join(out))                       # 例如：我 爱 编程 。
```

LLM 做的事**本质一样**，只不过：它看的不是前 1 个词而是**成千上万个词的上下文**；统计规律不是查表，而是由**几百亿参数的 Transformer** 通过训练学到的。

## 自测：你真的懂了吗？

> [!QUESTION] 用一句话说明 LLM 的训练目标和生成方式。
> 训练目标是根据前文预测下一个 token（自监督，用交叉熵损失）；生成时反复预测下一个 token 的概率分布，采样一个接到后面，循环直到结束，这叫自回归生成。

> [!QUESTION] 预训练、指令微调、偏好对齐各解决什么问题？
> 预训练让模型从海量文本学到语言和世界知识（会续写）；指令微调用“指令—回答”示例让它学会按指令回答；偏好对齐利用人类偏好让回答更有用、诚实、安全。

> [!QUESTION] 为什么 LLM 会产生幻觉？怎么缓解？
> 它被训练成生成最可能的文字而非保证真实，缺少的知识也会被编造得很像；加上知识截止、长尾知识记不牢。缓解方法有 RAG 提供依据、调用工具查询计算、要求引用、低温度、结构化输出和事后校验，关键场景人工复核。

> [!QUESTION] temperature 参数调大调小分别会怎样？
> 调小使概率分布更尖锐，输出更确定保守，适合事实类任务；调大使分布更平坦，输出更随机有创意，但更容易出错。

> [!QUESTION] LLM 有记忆吗？ChatGPT 为什么看起来记得前面的对话？
> 模型本身每次请求无状态，没有内置记忆。对话产品把历史消息一并放进每次的输入上下文，所以看起来有记忆；历史太长会超出上下文窗口，需要截断或摘要。
