---
level: 深入
tags: [Transformer, 注意力, KV Cache, vLLM, PagedAttention, 连续批处理, 量化, LoRA, 推理服务, 显存估算]
summary: 从应用工程师需要的深度讲清大模型内部：Transformer 与注意力的计算与复杂度、KV Cache 的显存账、推理服务（连续批处理、PagedAttention、前缀缓存、投机解码）、量化与微调（LoRA），并给出显存、吞吐、成本的估算方法。
---

# 大模型原理与推理服务（KV Cache、vLLM、量化、微调）

> [!ABSTRACT] 核心要点
> - 解码器型大模型就是**一个反复调用的“下一个 Token 预测器”**：Prefill 并行处理输入，Decode 逐 Token 生成；**Decode 阶段受显存带宽限制（memory-bound）**，Prefill 阶段受算力限制（compute-bound）。
> - **KV Cache** 用显存换计算：缓存每层每个历史 Token 的 K、V，避免重复计算，但占用 **`2 × 层数 × KV头数 × 头维度 × 序列长度 × 字节数`** 的显存，**并发请求数 × 上下文长度**是显存的主要消耗者。
> - 推理服务的核心优化：**连续批处理（Continuous Batching）**、**PagedAttention**（分页管理 KV Cache，消除碎片）、**前缀缓存**、**投机解码**、**量化**；vLLM 等引擎把这些做成了开箱即用。
> - **量化**（INT8/INT4/FP8）降低权重显存与带宽，吞吐提升明显，精度略降，需要用评测集验证；**微调优先用 LoRA/QLoRA**（只训练少量低秩参数），知识类需求仍优先 RAG。
> - 做容量规划的方法：**显存 = 权重 + KV Cache（并发 × 上下文）+ 激活与框架开销**；吞吐 ≈ 受带宽/批大小约束，**以压测为准**。

> [!NOTE] 关于数字
> 本页的公式与量级用于**估算与建立直觉**；具体模型结构、硬件规格、框架版本差异很大，落地以实测为准。

## Transformer 解码器结构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="解码器型 Transformer：词嵌入、多层 Transformer Block（注意力与前馈网络）、最终线性层与 softmax 得到下一个 Token 概率">
<rect class="b" x="20" y="150" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="172" text-anchor="middle" dominant-baseline="middle">Token ID 序列</text>
<text class="ts" x="75" y="192" text-anchor="middle">[t1, t2, … tn]</text>
<rect class="b1" x="160" y="150" width="110" height="60" rx="8"/>
<text class="tb" x="215" y="172" text-anchor="middle" dominant-baseline="middle">Embedding</text>
<text class="ts" x="215" y="192" text-anchor="middle">+ 位置编码(RoPE)</text>
<line class="l" x1="130" y1="180" x2="160" y2="180" marker-end="url(#arr)"/>
<rect class="bg" x="300" y="20" width="300" height="320" rx="12"/>
<text class="th" x="450" y="44" text-anchor="middle">Transformer Block × N 层（如 32/80）</text>
<rect class="b3" x="324" y="62" width="252" height="76" rx="8"/>
<text class="tb" x="450" y="82" text-anchor="middle" dominant-baseline="middle">自注意力 Self-Attention</text>
<text class="ts" x="450" y="104" text-anchor="middle">每个 Token 看之前所有 Token</text>
<text class="ts" x="450" y="122" text-anchor="middle">Q·Kᵀ → softmax → ×V；多头并行</text>
<rect class="b5" x="324" y="158" width="252" height="76" rx="8"/>
<text class="tb" x="450" y="178" text-anchor="middle" dominant-baseline="middle">前馈网络 FFN（MLP）</text>
<text class="ts" x="450" y="200" text-anchor="middle">逐 Token 非线性变换，占大部分参数</text>
<text class="ts" x="450" y="218" text-anchor="middle">MoE 模型在此处按专家路由</text>
<rect class="b" x="324" y="254" width="252" height="66" rx="8"/>
<text class="tb" x="450" y="274" text-anchor="middle" dominant-baseline="middle">残差连接 + 归一化（RMSNorm）</text>
<text class="ts" x="450" y="296" text-anchor="middle">每个子层前后，稳定深层训练</text>
<line class="l" x1="450" y1="138" x2="450" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="234" x2="450" y2="254" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="180" x2="300" y2="180" marker-end="url(#arr)"/>
<rect class="b2" x="630" y="110" width="110" height="60" rx="8"/>
<text class="tb" x="685" y="132" text-anchor="middle" dominant-baseline="middle">LM Head</text>
<text class="ts" x="685" y="152" text-anchor="middle">→ 词表概率分布</text>
<rect class="b4" x="630" y="200" width="110" height="60" rx="8"/>
<text class="tb" x="685" y="222" text-anchor="middle" dominant-baseline="middle">采样</text>
<text class="ts" x="685" y="242" text-anchor="middle">选出下一个 Token</text>
<line class="l" x1="600" y1="180" x2="630" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="685" y1="170" x2="685" y2="200" marker-end="url(#arr)"/>
<text class="ts" x="685" y="296" text-anchor="middle">追加到序列，重复</text>
</svg>
<figcaption>图 1：解码器型 Transformer 的数据流</figcaption>
</figure>

### 自注意力：为什么重要，代价是什么

对每个 Token，模型计算三个向量 **Q（查询）、K（键）、V（值）**：

```text
Attention(Q, K, V) = softmax( Q·Kᵀ / √d ) · V
```

- Q·Kᵀ 得到“当前 Token 与每个历史 Token 的相关度”，softmax 归一化后对 V 加权求和；
- **因果掩码**：生成时每个位置只能看到自己之前的 Token；
- **多头（Multi-Head）**：并行多组 Q/K/V，各关注不同关系；
- **计算复杂度与序列长度 n 的平方成正比（O(n²)）**，这是长上下文昂贵的根本原因；
- **GQA / MQA**（分组查询/多查询注意力）：多个 Q 头共享一组 K、V 头，**大幅缩小 KV Cache** 与带宽需求，现代模型普遍采用；
- **FlashAttention**：IO 感知的精确注意力实现，通过分块在片上缓存计算、避免把 n×n 矩阵写回显存，降低显存占用并加速，是训练与推理的标配。

### 位置编码与长上下文

注意力本身不感知顺序，需要**位置编码**：现代模型主要用 **RoPE（旋转位置编码）**。扩展上下文长度常用**位置插值/NTK 缩放**等方法再做少量训练；**声称的上下文窗口 ≠ 在整个窗口内效果一致**，长上下文的检索准确率常随位置下降（“lost in the middle”），要用自己的评测集验证。

### 参数量与权重显存

```text
权重显存 ≈ 参数量 × 每参数字节数
  7B  模型：FP16/BF16 ≈ 14 GB；INT8 ≈ 7 GB；INT4 ≈ 3.5~4 GB
  70B 模型：FP16 ≈ 140 GB（需多卡）；INT4 ≈ 35~40 GB
```

**MoE（混合专家）**：总参数大，但每个 Token 只激活部分专家（如激活参数仅总量的几分之一），**计算量小，但权重仍要全部加载**（显存占用按总参数算），且多卡间路由通信是新瓶颈。

## 推理的两个阶段

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Prefill 阶段并行处理整个提示词，计算密集；Decode 阶段每步生成一个 Token，反复读取全部权重和 KV Cache，带宽受限">
<rect class="b3" x="20" y="30" width="330" height="170" rx="12"/>
<text class="th" x="185" y="54" text-anchor="middle">Prefill（预填充）</text>
<text class="ts" x="185" y="80" text-anchor="middle">一次处理全部 n 个输入 Token</text>
<text class="ts" x="185" y="100" text-anchor="middle">矩阵×矩阵，GPU 算力吃满</text>
<text class="ts" x="185" y="120" text-anchor="middle">→ 计算密集（compute-bound）</text>
<text class="ts" x="185" y="146" text-anchor="middle">产出：首个输出 Token + 填满 KV Cache</text>
<text class="ta" x="185" y="176" text-anchor="middle">决定 TTFT（首 Token 延迟），随输入长度增长</text>
<rect class="b5" x="390" y="30" width="330" height="170" rx="12"/>
<text class="th" x="555" y="54" text-anchor="middle">Decode（解码）</text>
<text class="ts" x="555" y="80" text-anchor="middle">每步只处理 1 个新 Token（每请求）</text>
<text class="ts" x="555" y="100" text-anchor="middle">每步要读取全部权重 + 该请求的 KV Cache</text>
<text class="ts" x="555" y="120" text-anchor="middle">→ 显存带宽受限（memory-bound）</text>
<text class="ts" x="555" y="146" text-anchor="middle">批越大，单次读权重被更多请求均摊</text>
<text class="ta" x="555" y="176" text-anchor="middle">决定输出速度（TPOT，每 Token 耗时）</text>
<text class="ts" x="370" y="236" text-anchor="middle">单请求 Decode 速度的粗略上界 ≈ 显存带宽 ÷ 每步读取的字节数（权重 + KV）</text>
<text class="ts" x="370" y="258" text-anchor="middle">例：带宽 2 TB/s、7B FP16 权重 14 GB → 约 140 token/s（batch=1 理论上界）；批处理可成倍提升总吞吐</text>
</svg>
<figcaption>图 2：Prefill 计算密集，Decode 带宽受限</figcaption>
</figure>

应对：

| 瓶颈 | 手段 |
| --- | --- |
| Decode 带宽受限 | **增大批大小**（连续批处理）、**量化权重**（读得少）、GQA（KV 小）、**投机解码**（一次验证多个 Token） |
| Prefill 算力受限且长提示词 | **前缀缓存**复用、分块预填充（Chunked Prefill）避免阻塞其他请求、张量并行 |
| 两阶段互相干扰 | **Prefill/Decode 分离（PD 分离）**：用不同实例分别处理，各自优化 |

## KV Cache：显存账

生成第 t+1 个 Token 时，需要前 t 个 Token 在**每一层**的 K、V。重复计算代价是 O(n²)，所以把它们**缓存**起来，每步只算新 Token 的 K、V 并追加。

```text
每 Token 的 KV Cache 字节数 = 2（K 和 V）× 层数 × KV 头数 × 头维度 × 每元素字节数

示例（7B 级、MHA：32 层、32 个 KV 头、头维度 128、FP16 即 2 字节）：
  2 × 32 × 32 × 128 × 2 = 524,288 字节 ≈ 0.5 MB / Token
  一个 4K 上下文的请求 ≈ 2 GB；32 个并发 ≈ 64 GB —— 远超权重本身！

GQA（例如 KV 头数从 32 降到 8）：KV Cache 缩小为 1/4 ≈ 0.125 MB / Token
```

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="单张 GPU 显存的构成：权重、KV Cache、激活与框架开销，KV Cache 决定可支持的并发数">
<rect class="b" x="20" y="60" width="700" height="60" rx="0"/>
<rect class="b1" x="20" y="60" width="200" height="60" rx="0"/>
<text class="tb" x="120" y="86" text-anchor="middle" dominant-baseline="middle">模型权重</text>
<text class="ts" x="120" y="106" text-anchor="middle">固定，如 14 GB</text>
<rect class="b4" x="220" y="60" width="60" height="60" rx="0"/>
<text class="ts" x="250" y="86" text-anchor="middle" dominant-baseline="middle">激活</text>
<text class="ts" x="250" y="106" text-anchor="middle">+开销</text>
<rect class="b2" x="280" y="60" width="440" height="60" rx="0"/>
<text class="tb" x="500" y="86" text-anchor="middle" dominant-baseline="middle">KV Cache 池（剩余显存，如 80 GB 卡约 55 GB）</text>
<text class="ts" x="500" y="106" text-anchor="middle">可容纳的 Token 总数 = KV 池 ÷ 每 Token 字节数</text>
<text class="th" x="20" y="162">并发能力估算</text>
<text class="tm" x="20" y="188">最大并发请求数 ≈ KV 池显存 ÷ (平均序列长度 × 每 Token KV 字节数)</text>
<text class="tm" x="20" y="212">例：55 GB ÷ (2000 Token × 0.125 MB) ≈ 220 并发（GQA）；MHA(0.5MB/Token) 仅约 55 并发</text>
<text class="ts" x="20" y="244">要提升并发：量化 KV Cache（FP8/INT8）、GQA 模型、缩短上下文、前缀共享、PagedAttention 减少碎片浪费</text>
<text class="ts" x="20" y="266">上下文越长、并发越高，KV Cache 越是显存主角；这也是长上下文请求“又贵又挤占别人”的根本原因</text>
</svg>
<figcaption>图 3：显存的构成与并发能力的估算</figcaption>
</figure>

## 推理服务引擎

### 为什么不能用“一请求一批”

传统静态批处理要等一批请求**全部生成完**才能放入下一批：短请求被长请求拖累，GPU 空等。大模型输出长度**不可预知**，这个问题尤其严重。

### 连续批处理（Continuous / In-flight Batching）

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="静态批处理与连续批处理对比：连续批处理在每个解码步结束后立即插入新请求、移除已完成请求">
<text class="th" x="20" y="24">静态批处理：整批等最长的</text>
<rect class="b2" x="20" y="36" width="330" height="22" rx="2"/>
<text class="ts" x="185" y="47" text-anchor="middle" dominant-baseline="middle">请求 A（长）</text>
<rect class="b3" x="20" y="62" width="120" height="22" rx="2"/>
<rect class="bg" x="140" y="62" width="210" height="22" rx="2"/>
<text class="ts" x="80" y="73" text-anchor="middle" dominant-baseline="middle">B（短）</text>
<text class="ts" x="245" y="73" text-anchor="middle" dominant-baseline="middle">空等…浪费</text>
<rect class="b5" x="20" y="88" width="200" height="22" rx="2"/>
<rect class="bg" x="220" y="88" width="130" height="22" rx="2"/>
<text class="ts" x="120" y="99" text-anchor="middle" dominant-baseline="middle">C</text>
<text class="ts" x="285" y="99" text-anchor="middle" dominant-baseline="middle">空等</text>
<text class="th" x="390" y="24">连续批处理：每步动态调整</text>
<rect class="b2" x="390" y="36" width="330" height="22" rx="2"/>
<text class="ts" x="555" y="47" text-anchor="middle" dominant-baseline="middle">请求 A（长）</text>
<rect class="b3" x="390" y="62" width="120" height="22" rx="2"/>
<rect class="b4" x="510" y="62" width="210" height="22" rx="2"/>
<text class="ts" x="450" y="73" text-anchor="middle" dominant-baseline="middle">B</text>
<text class="ts" x="615" y="73" text-anchor="middle" dominant-baseline="middle">D 立即补入</text>
<rect class="b5" x="390" y="88" width="200" height="22" rx="2"/>
<rect class="b1" x="590" y="88" width="130" height="22" rx="2"/>
<text class="ts" x="490" y="99" text-anchor="middle" dominant-baseline="middle">C</text>
<text class="ts" x="655" y="99" text-anchor="middle" dominant-baseline="middle">E 补入</text>
<rect class="bg" x="20" y="140" width="700" height="140" rx="10"/>
<text class="th" x="36" y="164">调度要点</text>
<text class="ts" x="36" y="188">• 以“解码步（iteration）”为调度粒度：每生成一个 Token 后检查，完成的请求立刻退出，等待队列的请求立刻加入</text>
<text class="ts" x="36" y="208">• 新请求的 Prefill 与已有请求的 Decode 混合调度（分块预填充，避免长提示词独占一个步长造成其他请求卡顿）</text>
<text class="ts" x="36" y="228">• 受 KV Cache 显存限制：显存不足时排队，或把低优先级请求抢占（换出/重算）</text>
<text class="ts" x="36" y="248">• GPU 利用率与吞吐显著提高（常见数倍），延迟分布更均匀</text>
<text class="ts" x="36" y="268">• 并发太高会推高每请求的 Decode 耗时（TPOT）——吞吐与延迟的权衡，需要按 SLO 设置最大并发/批大小</text>
</svg>
<figcaption>图 4：连续批处理消除“等最长请求”的浪费</figcaption>
</figure>

### PagedAttention

传统做法为每个请求**预留一块连续的最大长度显存**存放 KV Cache，导致**内部碎片**（预留但没用）和**外部碎片**；很大比例的显存被浪费。

**PagedAttention（vLLM）**借鉴操作系统分页：

- 把 KV Cache 切成固定大小的**块（block，如 16 个 Token）**，**按需分配**，逻辑上连续、物理上不连续，用**块表（block table）**映射；
- 几乎消除碎片，使同样显存可容纳更多并发；
- **前缀共享/写时复制**：多个请求共享相同前缀（如系统提示词、同一文档）的 KV 块，只在发生分叉时复制——实现 **Prefix Caching** 与 **parallel sampling/beam search** 的高效共享；
- 可把块换出到 CPU 内存（swap）。

### 前缀缓存与应用设计

**相同的前缀 = 相同的 KV Cache，无需重复 Prefill**。这直接决定了提示词的写法：

```text
[ 固定的系统规则 + 工具定义 + 长文档 ]   ← 放前面，可被缓存复用（厂商 API 的 Prompt Caching 同理）
[ 本轮变化的内容：检索片段 / 用户问题 ]   ← 放后面
```

- 缓存按**前缀精确匹配**：前面任何一个 Token 变了，后面全部失效；**不要把时间戳、请求 ID 等易变内容放进提示词开头**；
- 适合：多轮对话、长系统提示、同一文档的多次问答、Agent 反复携带的工具定义；
- 云厂商的提示词缓存（命中部分按折扣价、降低首 Token 延迟）与自建引擎的前缀缓存是同一原理，见 [大模型应用基础与 API 调用](#/ai/llm)。

### 投机解码（Speculative Decoding）

Decode 受带宽限制，**一次验证多个 Token 与验证一个的代价相近**。做法：用一个**小的草稿模型**（或模型自带的多 Token 预测头）先快速猜出接下来的 k 个 Token，再让**大模型一次并行验证**，接受正确的前缀、从第一个错误处纠正。**输出分布与原模型一致**（无损），加速比取决于草稿的命中率（常见 1.5~3 倍）。适合**低并发、延迟敏感**场景；高并发时批处理已使算力饱和，收益下降。

### 并行与规模化

| 并行方式 | 说明 | 场景 |
| --- | --- | --- |
| **张量并行（TP）** | 把每层的矩阵切到多张卡，层内通信（NVLink 带宽重要） | 单卡放不下的模型、降低延迟 |
| **流水线并行（PP）** | 把不同层放在不同卡 | 超大模型跨节点 |
| 专家并行（EP） | MoE 的不同专家放不同卡 | MoE 模型 |
| 数据并行/多副本 | 多份完整模型副本，负载均衡 | **提升吞吐、高可用**（最常用的扩展方式） |
| PD 分离 | Prefill 与 Decode 用不同实例/硬件 | 大规模服务，分别满足 TTFT 与 TPOT |

### 主流推理引擎

| 引擎 | 特点 |
| --- | --- |
| **vLLM** | PagedAttention、连续批处理、前缀缓存、OpenAI 兼容接口，开源生产最常用 |
| **SGLang** | 前缀缓存（RadixAttention）与结构化输出/程序化调用优化 |
| TensorRT-LLM | NVIDIA 官方，极致性能，部署复杂度较高 |
| llama.cpp / Ollama | CPU/消费级 GPU/边缘端，量化模型本地运行 |
| TGI 等 | HuggingFace 生态 |

## 量化

目标：**用更低精度存储权重（和 KV Cache）**，降低显存与带宽，提升吞吐。

| 方法 | 说明 | 注意 |
| --- | --- | --- |
| **FP16 / BF16** | 基线 | BF16 动态范围更大，训练常用 |
| **FP8** | 新一代 GPU 原生支持，精度损失小，权重和 KV 都可用 | 需要硬件支持 |
| **INT8** | 权重（及激活）8 位 | 精度损失小 |
| **INT4（GPTQ / AWQ）** | 权重 4 位，**仅权重量化**，显存约 1/4 | AWQ 保护“重要权重通道”，通常更稳；对长文本、数学、代码任务可能更敏感 |
| KV Cache 量化 | FP8/INT8 存 KV，**直接提升并发** | 对长上下文精度的影响需评估 |
| GGUF（llama.cpp） | 多种量化档位（Q4_K_M 等）用于本地推理 | 面向边缘/本地 |

原则：**量化是用精度换成本，必须在你的评测集上验证**（不能只看通用榜单）；先 INT8/FP8，再评估 INT4；关键任务（金融数字、代码）保持更高精度。

## 微调

### 什么时候该微调

| 需求 | 推荐 |
| --- | --- |
| 引入**会变化的事实知识** | **RAG**（见 [RAG 原理与完整流水线](#/ai/rag)） |
| 统一**输出风格/格式/话术**、遵循复杂指令 | 提示词 + 少样本；不够再 **SFT 微调** |
| 学习**特定领域术语与任务模式**（工单分类、专业抽取） | SFT（LoRA）微调小模型，常能“小模型达到大模型效果”并降低成本 |
| 让模型**偏好某类回答**（安全、有用性） | 偏好对齐（DPO/RLHF），门槛高 |
| **蒸馏**：用大模型数据训练小模型 | 降本，常与 SFT 结合 |

### LoRA / QLoRA

全量微调要更新所有参数，**显存和成本很高**。**LoRA** 冻结原权重 W，只训练两个**低秩矩阵** A、B，使用 `W' = W + B·A`（秩 r 通常 8~64）：

- 可训练参数只有原来的 **0.1%~几%**，显存大降；
- 训练出的是**小的适配器（adapter）文件**，可在推理时**动态加载/切换**（一个基座模型服务多个租户/任务，vLLM 支持多 LoRA 服务）；
- **QLoRA**：基座权重用 4 位量化加载，再训练 LoRA，**单张消费级/中端 GPU 即可微调较大模型**。

### 微调数据与流程

```text
1. 明确目标与评测集（先有评测，再谈微调）
2. 准备数据：高质量 > 大量；指令-回答对，覆盖边界与反例；来源可来自人工、业务日志（脱敏）、大模型生成后人工审核
3. 切分训练/验证集，避免泄漏评测集
4. 训练（LoRA）：学习率、秩、epoch（小数据易过拟合，常 1~3 个 epoch）
5. 评测：对比基座+提示词 / RAG 的效果、成本、延迟；检查是否出现“灾难性遗忘”（通用能力下降）
6. 部署：合并权重或动态加载 adapter；灰度；持续收集线上失败样例迭代
```

> [!WARNING] 常见误区
> “微调让模型记住公司文档”——效果差且更新慢，应该用 RAG；“数据越多越好”——脏数据会让效果更差；“微调后就不用评测”——必须对比基线并监控通用能力退化。

## 容量规划与成本估算

### 一个估算示例

目标：自建 7B 级模型（INT8/FP8）提供客服对话，峰值 **100 个并发会话**，平均上下文 3K Token（输入）+ 300 Token（输出）。

```text
权重（INT8 7B）            ≈ 7 GB
KV Cache（GQA，每 Token 约 0.125MB，FP16）
  每会话 3.3K Token × 0.125MB ≈ 0.41 GB
  100 并发 ≈ 41 GB
激活与框架开销（预留）      ≈ 10 GB
合计                        ≈ 58 GB   → 单张 80GB 卡可承载（并留 PagedAttention 余量）
延迟估算：Decode 每 Token 数十毫秒量级（受批大小影响）；300 Token 输出约数秒；首 Token 受 Prefill（3K Token）影响，常见数百毫秒
高可用：至少 2 个副本 + 负载均衡；按峰值 QPS 与 TPOT 目标做压测确定每卡最大并发
```

### 自建 vs 调用厂商 API

| 维度 | 厂商 API | 自建推理 |
| --- | --- | --- |
| 前期投入 | 无 | GPU 采购/租赁、部署运维 |
| 成本结构 | 按 Token 计费，随用量线性增长 | 固定成本（GPU）+ 利用率；**利用率高才划算** |
| 模型能力 | 最强的闭源模型 | 开源模型（能力与领域适配、微调自由） |
| 数据 | 需评估数据出境与合规 | 数据不出域 |
| 稳定性 | 依赖厂商限流与可用性 | 自己负责容灾与扩缩容 |
| 适合 | 起步、波动大、追求最强效果 | 高并发稳定负载、数据敏感、可用小模型满足 |

常见做法是**混合**：通用/复杂任务走厂商 API，敏感或高频简单任务走自建小模型，通过**模型网关路由**，见 [LLM 应用工程化、安全与评测](#/ai/llmops)。

### 推理服务监控

| 指标 | 说明 |
| --- | --- |
| **TTFT / TPOT / 端到端延迟** | 用户体验的核心，按分位数（P95/P99）监控 |
| 吞吐（tokens/s）、请求并发、排队长度 | 容量与扩缩容依据 |
| **GPU 利用率、显存、KV Cache 使用率** | KV 使用率接近 100% 会触发排队/抢占，应提前扩容 |
| 前缀缓存命中率 | 评估提示词结构是否利于缓存 |
| 错误率、超时、被抢占次数 | 稳定性 |
| 成本：每千 Token 成本、GPU 利用率 | 判断自建是否划算 |

部署在 Kubernetes 时需要 GPU 调度、模型加载（冷启动慢，需预热与镜像/模型缓存）、弹性伸缩（按排队长度或 KV 使用率），参考 [Kubernetes 核心概念](#/infra/k8s)。

## 面试追问

> [!QUESTION] 什么是 KV Cache？它为什么占显存？
> 自注意力需要历史所有 Token 在每层的 K、V，缓存它们避免重复计算。显存占用等于 2 × 层数 × KV 头数 × 头维度 × 序列长度 × 字节数，随上下文长度和并发数线性增长，高并发长上下文时远超权重，是推理的主要显存消耗者。GQA 与 KV 量化可以显著减少它。

> [!QUESTION] 为什么说 Decode 阶段是带宽受限的？如何提高吞吐？
> 每步只生成一个 Token，却要读取全部权重和 KV Cache，计算量小、访存量大，受显存带宽限制。通过连续批处理让更多请求共享一次权重读取，量化权重减少读取量，GQA 缩小 KV，投机解码一次验证多个 Token。

> [!QUESTION] vLLM 的 PagedAttention 解决了什么问题？
> 传统为每个请求预留连续的最大长度 KV 显存，产生严重碎片和浪费。PagedAttention 把 KV Cache 分成固定大小的块、按需分配并用块表映射，几乎消除碎片，并支持多请求共享前缀块和写时复制，从而提高并发和前缀缓存效率。

> [!QUESTION] 连续批处理与静态批处理有什么区别？
> 静态批处理要整批请求都完成才开始下一批，短请求被长请求拖累；连续批处理以解码步为粒度，每步后完成的请求退出、新请求加入，GPU 利用率和吞吐显著更高，延迟更均匀。

> [!QUESTION] 什么时候该微调，什么时候用 RAG？LoRA 的原理？
> 需要引入会变化的事实知识用 RAG；需要统一风格、格式或让小模型学会特定任务时微调。LoRA 冻结原权重，只训练低秩矩阵 B·A 并叠加到原权重，可训练参数很少、显存低、可动态切换适配器，QLoRA 进一步用 4 位量化基座降低门槛。

> [!QUESTION] 如何估算部署一个模型需要多少显存？
> 权重显存等于参数量乘以每参数字节数，再加上 KV Cache（并发数 × 平均序列长度 × 每 Token KV 字节数）以及激活和框架开销；用这个估算确定单卡并发上限，再通过压测校准，并按 TTFT、TPOT 的目标确定副本数。
