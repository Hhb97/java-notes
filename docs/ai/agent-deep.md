---
level: 深入
tags: [Agent, 上下文工程, 记忆, 规划, 多智能体, 持久化执行, 人在回路, 评测, 状态机]
summary: Agent 的进阶设计：把 Agent 建模成可恢复的状态机与工作流引擎，上下文工程（压缩、检索、隔离）、记忆体系与写入策略、规划与反思、多智能体拓扑与通信、长任务的持久化执行、人在回路，以及轨迹级评测与线上治理。
---

# Agent 进阶：上下文工程、记忆与多智能体

> [!ABSTRACT] 核心要点
> - 生产级 Agent 的本质是“**LLM 决策 + 确定性工程**”：LLM 负责理解与决策，**状态管理、重试、超时、权限、持久化、审计都由代码/引擎负责**。把 Agent 建模成**显式状态机/图**，比一个无限循环更可控、可测、可恢复。
> - **上下文工程（Context Engineering）** 是 Agent 效果的第一杠杆：决定每一步**放进上下文什么、什么时候放、放多少**——系统规则、工具、检索结果、历史、记忆都在争夺有限的窗口。核心手段：**压缩、按需检索（Just-in-Time）、隔离、结构化笔记**。
> - **记忆**分短期（会话上下文）、长期（用户偏好/事实）、情景（过往经验）；写入要**有策略**（什么值得记、如何去重与更新、如何遗忘），否则越记越乱。
> - **多智能体**用于**上下文隔离、并行与专业分工**，不是为了“看起来高级”；典型是**编排者-执行者**，子 Agent 返回**精简的结构化结果**。
> - 长任务必须**持久化执行**（检查点、可恢复、幂等、超时与补偿），**写操作必须人在回路**；评测要看**轨迹**，而不仅是最终答案。

## 把 Agent 当作状态机来设计

“while 循环调用模型”适合 Demo；生产要的是**可中断、可恢复、可观测**的执行结构。

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Agent 作为状态图：接收任务、规划、调用工具、观察、评估、需要确认时暂停等待人工、完成或失败，每一步持久化状态">
<rect class="b1" x="20" y="140" width="100" height="56" rx="10"/>
<text class="tb" x="70" y="162" text-anchor="middle" dominant-baseline="middle">接收任务</text>
<text class="ts" x="70" y="182" text-anchor="middle">鉴权·预算</text>
<rect class="b3" x="160" y="140" width="110" height="56" rx="10"/>
<text class="tb" x="215" y="162" text-anchor="middle" dominant-baseline="middle">规划/决策</text>
<text class="ts" x="215" y="182" text-anchor="middle">LLM 一次调用</text>
<rect class="b5" x="310" y="60" width="120" height="56" rx="10"/>
<text class="tb" x="370" y="82" text-anchor="middle" dominant-baseline="middle">执行工具</text>
<text class="ts" x="370" y="102" text-anchor="middle">校验·鉴权·超时</text>
<rect class="b4" x="310" y="220" width="120" height="56" rx="10"/>
<text class="tb" x="370" y="242" text-anchor="middle" dominant-baseline="middle">等待人工确认</text>
<text class="ts" x="370" y="262" text-anchor="middle">高风险写操作</text>
<rect class="b3" x="470" y="140" width="110" height="56" rx="10"/>
<text class="tb" x="525" y="162" text-anchor="middle" dominant-baseline="middle">观察/评估</text>
<text class="ts" x="525" y="182" text-anchor="middle">结果是否达标</text>
<rect class="b2" x="630" y="60" width="110" height="56" rx="10"/>
<text class="tb" x="685" y="82" text-anchor="middle" dominant-baseline="middle">完成</text>
<text class="ts" x="685" y="102" text-anchor="middle">输出+引用</text>
<rect class="b4" x="630" y="220" width="110" height="56" rx="10"/>
<text class="tb" x="685" y="242" text-anchor="middle" dominant-baseline="middle">失败/降级</text>
<text class="ts" x="685" y="262" text-anchor="middle">兜底·转人工</text>
<line class="l" x1="120" y1="168" x2="160" y2="168" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="160" x2="310" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="176" x2="310" y2="236" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="95" x2="475" y2="145" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="248" x2="475" y2="195" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="150" x2="630" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="186" x2="630" y2="236" marker-end="url(#arr)"/>
<path class="la" d="M525 140 L525 20 L215 20 L215 140" marker-end="url(#arr-a)"/>
<text class="ta" x="370" y="14" text-anchor="middle">未达标 → 回到决策（受最大步数/预算约束）</text>
<rect class="bg" x="20" y="300" width="720" height="48" rx="10"/>
<text class="ts" x="380" y="320" text-anchor="middle">每个节点转移后把“状态快照”持久化（任务 ID、步骤、消息、工具结果、预算消耗）：崩溃可从最近检查点恢复</text>
<text class="ts" x="380" y="338" text-anchor="middle">“等待人工”节点释放线程与连接，状态存库；人工确认后由事件唤醒继续——长耗时/不确定时长的步骤不占资源</text>
</svg>
<figcaption>图 1：Agent 建模为带检查点的状态图，高风险节点可暂停等待人工</figcaption>
</figure>

要点：

| 设计点 | 做法 |
| --- | --- |
| **状态显式化** | 把对话、计划、已执行步骤、工具结果、预算、待确认事项存为**结构化状态**（JSON/表），而不是只存在内存或提示词里 |
| **检查点（Checkpoint）** | 每步后保存；失败后**从检查点恢复**而不是重跑；工具调用要**幂等**（带调用 ID），避免恢复时重复执行 |
| 终止条件 | 最大步数、总超时、Token/费用预算、**重复动作检测**（同样的工具+参数连续出现）、无进展检测 |
| 超时与重试 | 每个工具独立超时；区分可重试与不可重试错误；LLM 调用失败可降级模型 |
| **确定性路由** | 能用规则/分类决定的分支，**不要让模型“自由发挥”**；Agent 只负责真正需要判断的部分 |
| 可观测 | 每步一个 span：输入上下文摘要、模型输出、工具调用、耗时、Token；支持**回放** |

框架层面：**LangGraph**（图 + 检查点）、**Spring AI + 自建编排**、**Temporal/工作流引擎**（持久化执行，与 LLM 无关但非常适合长任务）都能实现这个模式。核心是理念，而非某个框架。

## 上下文工程

Agent 每一步都要“**把什么放进模型眼前**”。上下文窗口有限，且**越长越贵、越慢、越容易分心**（信息被稀释、“中间遗忘”）。上下文工程就是对这一资源做**预算与策略**。

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="上下文窗口的构成与预算：系统规则、工具定义、长期记忆与检索、对话历史、当前任务与观察结果，各占用一定 Token 并通过压缩与按需加载控制">
<rect class="b" x="20" y="30" width="700" height="56" rx="0"/>
<rect class="b3" x="20" y="30" width="110" height="56" rx="0"/>
<text class="ts" x="75" y="52" text-anchor="middle" dominant-baseline="middle">系统规则</text>
<text class="ts" x="75" y="70" text-anchor="middle">~1K，稳定</text>
<rect class="b5" x="130" y="30" width="150" height="56" rx="0"/>
<text class="ts" x="205" y="52" text-anchor="middle" dominant-baseline="middle">工具定义</text>
<text class="ts" x="205" y="70" text-anchor="middle">按场景精选</text>
<rect class="b1" x="280" y="30" width="130" height="56" rx="0"/>
<text class="ts" x="345" y="52" text-anchor="middle" dominant-baseline="middle">长期记忆</text>
<text class="ts" x="345" y="70" text-anchor="middle">检索注入</text>
<rect class="b2" x="410" y="30" width="150" height="56" rx="0"/>
<text class="ts" x="485" y="52" text-anchor="middle" dominant-baseline="middle">检索资料</text>
<text class="ts" x="485" y="70" text-anchor="middle">RAG 片段</text>
<rect class="b4" x="560" y="30" width="160" height="56" rx="0"/>
<text class="ts" x="640" y="52" text-anchor="middle" dominant-baseline="middle">对话历史+观察</text>
<text class="ts" x="640" y="70" text-anchor="middle">最易膨胀</text>
<text class="th" x="20" y="124">四类手段</text>
<rect class="b3" x="20" y="136" width="165" height="86" rx="8"/>
<text class="tb" x="102" y="156" text-anchor="middle" dominant-baseline="middle">① 压缩 Compaction</text>
<text class="ts" x="102" y="178" text-anchor="middle">历史摘要、丢弃冗余</text>
<text class="ts" x="102" y="196" text-anchor="middle">工具结果只留关键字段</text>
<rect class="b1" x="200" y="136" width="165" height="86" rx="8"/>
<text class="tb" x="282" y="156" text-anchor="middle" dominant-baseline="middle">② 按需加载 JIT</text>
<text class="ts" x="282" y="178" text-anchor="middle">只放“指针”（ID/路径）</text>
<text class="ts" x="282" y="196" text-anchor="middle">需要时再用工具读取</text>
<rect class="b5" x="380" y="136" width="165" height="86" rx="8"/>
<text class="tb" x="462" y="156" text-anchor="middle" dominant-baseline="middle">③ 外部笔记 Notes</text>
<text class="ts" x="462" y="178" text-anchor="middle">把计划/中间结论</text>
<text class="ts" x="462" y="196" text-anchor="middle">写到外部文件/状态</text>
<rect class="b2" x="560" y="136" width="160" height="86" rx="8"/>
<text class="tb" x="640" y="156" text-anchor="middle" dominant-baseline="middle">④ 隔离 Isolation</text>
<text class="ts" x="640" y="178" text-anchor="middle">子 Agent 独立上下文</text>
<text class="ts" x="640" y="196" text-anchor="middle">只回传精简结果</text>
<text class="ts" x="370" y="260" text-anchor="middle">目标：用最少的 Token 提供“完成当前这一步所需的最高信息密度”——不是塞得越多越好</text>
<text class="ts" x="370" y="282" text-anchor="middle">固定内容放前（利于前缀缓存），易变内容放后；工具与资料多时用检索选出相关子集</text>
</svg>
<figcaption>图 2：上下文是有预算的资源：压缩、按需加载、笔记、隔离</figcaption>
</figure>

### 手段详解

**1. 压缩（Compaction）**

- **工具结果裁剪**：工具返回的大 JSON/网页/日志，进入上下文前**提取关键字段或摘要**，原文存外部，需要时再取；
- **历史摘要**：对话超过阈值（如窗口的 70%）时，用模型把早期历史**摘要成要点**（保留决策、约束、未完成事项、关键事实/ID），再继续；
- **清理已完成的子任务细节**：保留结论，丢弃过程；
- 风险：摘要会**丢信息**或引入错误——摘要提示词要强调保留“用户偏好、已确认事项、待办、标识符”，并在关键处允许回查原始记录。

**2. 按需加载（Just-in-Time）**

不一次性把所有资料塞进去，而是只保留**轻量引用**（文件路径、文档 ID、URL、查询语句），让 Agent 通过工具**需要时再读取**。这样上下文始终精简，Agent 像人一样“先看目录，再翻具体章节”。结合 [RAG 检索优化、向量库与评估](#/ai/rag-advanced) 的检索，可以先检索得到候选，再按需展开。

**3. 外部笔记（Structured Note-taking）**

长任务中让 Agent 把**计划、进度、中间结论、待办**写入外部存储（文件、数据库、状态对象），上下文里只保留指向它的指针或简要摘要；上下文被压缩/重置后，Agent 读取笔记即可恢复工作（类似人类的待办清单）。

**4. 隔离（子 Agent）**

把**范围明确、上下文庞大**的子任务（如“检索并总结 20 篇文档”）交给**独立上下文的子 Agent**，它内部可以用上万 Token 探索，只向主 Agent 返回**几百 Token 的结论**。主 Agent 的上下文因此保持干净。

### 工具定义也是上下文

- 工具太多会让模型选择困难并吞噬 Token：按场景**动态选择工具子集**（先用路由/检索选出相关工具）；
- 工具描述要精确，工具返回要**精简且指导下一步**；
- 稳定的系统规则与工具定义放在提示词**前部**，便于前缀缓存，见 [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals)。

### 上下文的预算管理

```java
// 上下文拼装：按优先级与预算填充（示意）
ContextBudget b = new ContextBudget(maxTokens - reservedForOutput);
b.add("system", systemRules, Priority.MUST);                 // 必须
b.add("tools", selectTools(task), Priority.MUST);
b.add("memory", retrieveMemory(user, task, topK = 5), Priority.HIGH);
b.add("docs", retrieved, Priority.MEDIUM);                   // 超预算时优先裁剪低优先级
b.add("history", compact(history), Priority.MEDIUM);
b.add("scratch", latestObservations, Priority.HIGH);
String prompt = b.assemble();                                // 超出则压缩/裁剪低优先级项，并记录裁剪日志
```

## 记忆体系

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="Agent 记忆体系：工作记忆在上下文中，会话摘要与长期记忆存储于外部，情景记忆与知识库按需检索，写入时经过提取、去重、更新">
<rect class="b3" x="20" y="20" width="320" height="86" rx="10"/>
<text class="th" x="180" y="44" text-anchor="middle">工作记忆（上下文窗口）</text>
<text class="ts" x="180" y="68" text-anchor="middle">当前任务、近期消息、工具结果</text>
<text class="ts" x="180" y="88" text-anchor="middle">容量有限，易被压缩</text>
<rect class="b1" x="380" y="20" width="340" height="86" rx="10"/>
<text class="th" x="550" y="44" text-anchor="middle">会话摘要 / 状态</text>
<text class="ts" x="550" y="68" text-anchor="middle">本次会话的要点与进度（Redis/DB）</text>
<text class="ts" x="550" y="88" text-anchor="middle">会话结束后可沉淀到长期记忆</text>
<rect class="b5" x="20" y="130" width="220" height="100" rx="10"/>
<text class="th" x="130" y="154" text-anchor="middle">长期记忆</text>
<text class="ts" x="130" y="178" text-anchor="middle">用户偏好、画像、事实</text>
<text class="ts" x="130" y="198" text-anchor="middle">向量库 + 结构化存储</text>
<text class="ts" x="130" y="218" text-anchor="middle">检索后注入</text>
<rect class="b2" x="260" y="130" width="220" height="100" rx="10"/>
<text class="th" x="370" y="154" text-anchor="middle">情景记忆</text>
<text class="ts" x="370" y="178" text-anchor="middle">过往任务的执行轨迹与结果</text>
<text class="ts" x="370" y="198" text-anchor="middle">相似任务检索，作为示例/经验</text>
<rect class="b4" x="500" y="130" width="220" height="100" rx="10"/>
<text class="th" x="610" y="154" text-anchor="middle">语义知识（RAG）</text>
<text class="ts" x="610" y="178" text-anchor="middle">企业文档、制度、产品资料</text>
<text class="ts" x="610" y="198" text-anchor="middle">只读、有权限控制</text>
<rect class="bg" x="20" y="250" width="700" height="66" rx="10"/>
<text class="tb" x="370" y="272" text-anchor="middle" dominant-baseline="middle">写入管道：提取（什么值得记）→ 规范化 → 与已有记忆去重/冲突检测 → 更新或新增 → 设置重要性与过期</text>
<text class="ts" x="370" y="296" text-anchor="middle">检索排序 = 相关度 × 时间衰减 × 重要性；必须有删除/纠错机制，并按用户隔离</text>
</svg>
<figcaption>图 3：记忆分层与写入管道</figcaption>
</figure>

### 写入策略（最容易做坏的部分）

| 问题 | 对策 |
| --- | --- |
| 什么值得记 | 提示词明确“长期有价值的事实/偏好/约束”（如“用户对海鲜过敏”），**不记**一次性信息、推测、敏感信息（除非业务需要并合规） |
| 重复与矛盾 | 写入前**检索相近记忆**：相同则更新时间/合并，冲突则以最新为准并保留来源与时间 |
| 越记越多、检索噪声 | **重要性评分 + 衰减 + 过期**；定期整合（合并同类、摘要） |
| 记错了 | 记忆条目带**来源与时间**，支持用户查看/修改/删除；错误记忆影响长期，应有“纠错”入口 |
| **记忆投毒** | 不可信内容（网页、第三方消息）不得直接写入长期记忆；写入需来源校验 |
| 隐私与合规 | 按用户隔离、加密、可删除（“被遗忘权”）、最小化收集 |

### 记忆的读取

在每轮开始，根据**当前问题**检索相关记忆（向量 + 元数据过滤），**少量（3~8 条）注入上下文**，而不是整个记忆库；对“用户画像类”稳定信息可放入系统提示的固定段落。

## 规划与反思

| 模式 | 说明 | 适用 |
| --- | --- | --- |
| **直接执行（ReAct）** | 边想边做，每步决策 | 步骤少、环境不确定 |
| **先规划后执行（Plan-and-Execute）** | 先生成完整计划，逐步执行，必要时**重规划** | 步骤多、目标清晰；计划可展示、审批 |
| **分层规划** | 高层目标 → 子目标 → 具体动作 | 复杂长任务 |
| **搜索式（ToT / MCTS 类）** | 生成多个候选方案并评估、回溯 | 推理密集、开销大 |
| **反思（Reflexion）** | 失败后总结原因，写入记忆，下次避免 | 可多次尝试的任务 |
| **评估-优化** | 一个 Agent 生成，另一个评审并给出修改意见 | 写作、代码、翻译质量提升 |

实践建议：

- **计划作为一等公民**：存为结构化列表（步骤、状态、依赖），每步完成更新；便于**展示给用户确认**、便于恢复与审计；
- **重规划触发**：步骤失败、观察与预期不符、出现新信息；限制重规划次数；
- **验证器（Verifier）**：对关键产出用**独立的检查**（规则、测试、另一个模型）验证，而不是让同一个模型自评；代码类任务用**单元测试/编译器**作为客观反馈；
- 简单任务别过度规划，**规划本身消耗 Token 并引入错误**。

## 多智能体拓扑

<figure class="fig">
<svg viewBox="0 0 740 320" class="dg" role="img" aria-label="多智能体架构：编排者分解任务并分派给多个专业子 Agent，子 Agent 并行工作并返回精简结果，由编排者汇总，共享状态存储与消息总线">
<rect class="b3" x="270" y="20" width="200" height="70" rx="10"/>
<text class="tb" x="370" y="42" text-anchor="middle" dominant-baseline="middle">编排者 Orchestrator</text>
<text class="ts" x="370" y="64" text-anchor="middle">分解任务 · 分派 · 汇总 · 终止判断</text>
<rect class="b1" x="20" y="150" width="150" height="70" rx="10"/>
<text class="tb" x="95" y="172" text-anchor="middle" dominant-baseline="middle">检索 Agent</text>
<text class="ts" x="95" y="194" text-anchor="middle">RAG / 搜索</text>
<rect class="b2" x="200" y="150" width="150" height="70" rx="10"/>
<text class="tb" x="275" y="172" text-anchor="middle" dominant-baseline="middle">数据分析 Agent</text>
<text class="ts" x="275" y="194" text-anchor="middle">SQL / 代码沙箱</text>
<rect class="b5" x="380" y="150" width="150" height="70" rx="10"/>
<text class="tb" x="455" y="172" text-anchor="middle" dominant-baseline="middle">业务操作 Agent</text>
<text class="ts" x="455" y="194" text-anchor="middle">订单/工单工具</text>
<rect class="b4" x="560" y="150" width="160" height="70" rx="10"/>
<text class="tb" x="640" y="172" text-anchor="middle" dominant-baseline="middle">评审 Agent</text>
<text class="ts" x="640" y="194" text-anchor="middle">校验·合规·质量</text>
<line class="l" x1="320" y1="90" x2="95" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="90" x2="275" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="90" x2="455" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="90" x2="640" y2="150" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="250" width="700" height="56" rx="10"/>
<text class="ts" x="370" y="272" text-anchor="middle">共享：任务状态存储（黑板）· 事件/消息总线 · 工具与权限网关（MCP）· 追踪（同一 traceId 贯穿所有子 Agent）</text>
<text class="ts" x="370" y="292" text-anchor="middle">子 Agent 各有独立上下文与工具集（最小权限）；只向编排者回传精简、结构化的结果（含置信度与来源）</text>
</svg>
<figcaption>图 4：编排者-执行者的多智能体拓扑</figcaption>
</figure>

| 模式 | 通信 | 优点 | 风险 |
| --- | --- | --- | --- |
| **编排者-执行者** | 星形，经编排者 | 清晰、可控、易追踪 | 编排者成为瓶颈与单点；上下文需汇总 |
| 流水线 | 链式传递 | 简单，本质是工作流 | 上游错误向下放大 |
| 对等协作/群聊 | 共享消息空间 | 灵活 | 容易发散、成本高、难以终止 |
| 辩论/投票 | 多个 Agent 独立给出答案再汇总 | 提高关键判断可靠性 | 成本成倍增加 |

### 设计原则

1. **有明确的拆分理由**：并行（独立子任务）、上下文隔离（避免主上下文被撑爆）、权限隔离（不同 Agent 不同工具）、专业化（不同提示词/模型）；
2. **子 Agent 的接口要窄**：输入是**明确的任务描述 + 必要上下文**，输出是**结构化结果**（结论、证据、置信度、未完成项），不要回传完整对话；
3. **并行要谨慎**：子任务有依赖或会修改共享资源时并行会产生冲突；写操作集中由单一执行者完成；
4. **终止与预算**：整体预算分配给子 Agent，防止“Agent 套娃”无限递归；
5. **一致性**：多个 Agent 对同一事实可能给出不同结论——需要**仲裁规则**（以工具/数据源的结果为准，而非模型间的辩论）；
6. **成本意识**：多 Agent 的 Token 消耗常是单 Agent 的数倍，要用评测证明收益；
7. **能用工作流就用工作流**：固定拓扑的多步骤任务，用代码编排比“自主协作”更稳。

## 长任务：持久化执行与人在回路

### 持久化执行

长任务（几分钟到几天）会遇到：进程重启、模型/工具超时、等待人工、外部系统延迟。要点：

- **任务与状态入库**：任务表（状态、当前步骤、状态快照、重试次数、预算、创建/更新时间）；
- **异步化**：提交任务立即返回任务 ID，后台 worker 执行；前端通过**轮询/SSE/WebSocket**获取进度；
- **恢复**：worker 崩溃后，任务由其他 worker 根据**租约（lease）超时**重新认领并从检查点继续；
- **幂等工具与去重键**：`task_id + step_id` 作为幂等键，防止恢复时重复执行写操作；
- **补偿（Saga）**：多个写操作中途失败，要有**逆操作**回滚已完成的副作用；
- 可借助 **Temporal / Camunda / 自研状态机 + MQ** 实现，思路类似 [分布式事务](#/distributed/transaction)。

### 人在回路（Human-in-the-loop）

| 触发条件 | 处理 |
| --- | --- |
| **写操作/高风险**（转账、删除、对外发送、改权限） | 暂停，展示**将要执行的完整动作与影响**，等待用户确认/修改 |
| 模型置信度低、多个方案难以取舍 | 向用户提问，给出选项，不要猜 |
| 规则要求审批（合规） | 创建审批单，走审批流，审批结果唤醒任务 |
| 连续失败/异常 | 升级给人工，带上完整轨迹便于接手 |

实现关键：确认请求**绑定具体动作与参数的哈希**（防止确认后参数被改）、有**超时与默认拒绝**、全程审计。

## 评测：看轨迹，不只看答案

Agent 的失败往往发生在中间步骤。评测维度：

| 维度 | 指标 | 方法 |
| --- | --- | --- |
| **任务完成** | 成功率（pass@1 / pass@k） | 可程序判定的任务用**环境状态检查**（订单状态是否确实变更）；开放任务用评分细则 + LLM 评审 + 人工抽检 |
| **轨迹质量** | 工具选择正确率、参数正确率、**步数/多余调用**、有无危险调用 | 对比参考轨迹或用规则/评审模型打分 |
| **鲁棒性** | 对扰动输入、工具失败、超时的恢复情况 | **故障注入**：让工具随机报错/变慢 |
| **安全** | 注入攻击下的越权/泄露次数 | 红队样例集，见 [LLM 应用工程化、安全与评测](#/ai/llmops) |
| **成本与延迟** | 平均 Token/任务、P95 时延 | 线上统计 |
| 稳定性 | 同一任务多次运行的方差 | 重复运行并统计一致性 |

方法：构造**模拟环境（Mock 工具 + 可重置的状态）**使评测可重复；用**固定评测集 + 回归门禁**；线上对失败轨迹聚类分析根因（工具描述不清？上下文被撑爆？规划偏差？），再针对性修复。

## 常见失败模式与对策

| 失败模式 | 表现 | 对策 |
| --- | --- | --- |
| 上下文膨胀 | 越到后面越慢、越“糊涂”，开始遗忘早期约束 | 压缩、按需加载、笔记、子 Agent 隔离 |
| 工具选错/参数错 | 调用不相关工具、字段格式错误 | 优化工具描述与 Schema、减少工具数、示例、校验与自修复提示 |
| 无限循环/空转 | 反复调用同一工具 | 重复检测、最大步数、强制总结或求助 |
| 过早宣布完成 | 没满足所有要求就结束 | 验证器/检查清单，对照需求逐项确认 |
| 幻觉的工具结果 | 编造工具返回的内容 | 结构化解析工具结果，答案必须引用工具输出；对数值做校验 |
| 副作用不可逆 | 误操作造成损失 | 人在回路、dry-run、幂等、补偿、灰度权限 |
| 提示注入 | 外部内容劫持 Agent | 最小权限、隔离、确认，见 [LLM 应用工程化、安全与评测](#/ai/llmops) |
| 成本失控 | 单任务消耗大量 Token | 预算硬限制、早停、小模型处理简单步骤 |

## 面试追问

> [!QUESTION] 为什么生产级 Agent 要建模成状态机或图，而不是一个循环？
> 状态机让每一步的状态显式化并可持久化，支持检查点恢复、人工确认时暂停、确定性路由、重复与无进展检测，以及逐步的追踪和回放；无限循环难以中断、恢复和测试，故障后只能重来。

> [!QUESTION] 什么是上下文工程？有哪些手段？
> 对上下文窗口这一有限资源做预算与策略：压缩（摘要历史、裁剪工具结果）、按需加载（只放引用，用工具读取）、外部笔记（把计划和中间结论存外部）、隔离（子 Agent 独立上下文只回传精简结果），同时精选工具并把固定内容放前以利用前缀缓存。

> [!QUESTION] Agent 的记忆怎么设计？有哪些坑？
> 分工作记忆、会话摘要、长期记忆、情景记忆和知识库。写入要有提取、去重、冲突更新、重要性和过期策略，读取按当前问题检索少量注入。坑包括记忆越积越乱、记错无法纠正、记忆投毒、隐私合规，需要来源时间、可删除和用户隔离。

> [!QUESTION] 什么时候该用多智能体？
> 当有明确收益时：独立子任务并行、用子 Agent 隔离庞大上下文、权限隔离或专业分工。多 Agent 增加成本和调试难度，常用编排者-执行者结构，子 Agent 回传精简的结构化结果；流程固定时用工作流代替自主协作。

> [!QUESTION] 长时间运行的 Agent 任务怎么保证可靠？
> 任务与状态持久化，异步执行并提供进度；检查点后可由其他 worker 凭租约认领恢复；工具使用 task+step 幂等键；多写操作用补偿；高风险步骤暂停等待人工确认，确认绑定具体动作参数；所有步骤审计追踪。

> [!QUESTION] 如何评测 Agent？
> 不只看最终答案，还要看任务是否真正完成（检查环境状态）、轨迹质量（工具与参数是否正确、有无多余或危险调用）、鲁棒性（工具故障注入）、安全性（注入与越权）、成本延迟与稳定性；用可重置的模拟环境和固定评测集做回归，线上聚类分析失败轨迹。
