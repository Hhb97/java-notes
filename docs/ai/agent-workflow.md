---
level: 深入
tags: [工作流, Agent, 编排模式, 提示链, 路由, 并行, 编排者-执行者, 评估-优化, 状态图, 检查点, 选型]
summary: 工作流与 Agent 的选型与编排：五种常用编排模式（提示链、路由、并行、编排者-执行者、评估-优化）、状态图运行时的关键机制（状态、条件边、检查点、中断恢复）、框架与自研对比、Java 里的实现骨架、可靠性与测试要点。
---

# 工作流与 Agent 选型：编排模式与状态图

> [!ABSTRACT] 核心要点
> - **工作流（Workflow）**：流程由**代码预先定义**，模型只在节点里干活；**Agent**：由**模型动态决定**下一步做什么。前者可预测、便宜、好测；后者灵活、但更慢、更贵、更难保证。**能写成工作流就写成工作流。**
> - 五种常用编排模式几乎覆盖大多数需求：**提示链**（串行拆解）、**路由**（分类分流）、**并行**（分片/投票）、**编排者-执行者**（动态拆任务）、**评估-优化**（生成+评审循环）。它们可以嵌套组合。
> - 复杂编排的运行时本质是**状态图**：共享状态 + 节点 + 边（含条件边）+ **检查点**（崩溃恢复、人工中断后恢复）。
> - 选框架看四点：**状态与持久化、人工介入、可观测、与现有技术栈的融合**；简单场景用几十行代码的自研状态机比引入重框架更稳。
> - 无论哪种模式，都要有**最大步数、超时、预算、重复检测、降级兜底**，并对**每个节点单独做评测**。

## 工作流与 Agent 的取舍

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="工作流与 Agent 对比：工作流由代码定义固定路径，模型只在节点内工作；Agent 由模型循环决定下一步，路径不固定；二者在可预测性、成本、灵活性上的差别，以及混合方案">
<rect class="b3" x="20" y="14" width="350" height="150" rx="10"/>
<text class="th" x="195" y="36" text-anchor="middle">工作流：路径由代码决定</text>
<rect class="b" x="40" y="54" width="70" height="40" rx="6"/>
<text class="ts" x="75" y="74" text-anchor="middle" dominant-baseline="middle">节点 A</text>
<rect class="b" x="140" y="54" width="70" height="40" rx="6"/>
<text class="ts" x="175" y="74" text-anchor="middle" dominant-baseline="middle">节点 B</text>
<rect class="b" x="240" y="54" width="70" height="40" rx="6"/>
<text class="ts" x="275" y="74" text-anchor="middle" dominant-baseline="middle">节点 C</text>
<line class="l" x1="110" y1="74" x2="140" y2="74" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="74" x2="240" y2="74" marker-end="url(#arr)"/>
<text class="ts" x="195" y="122" text-anchor="middle">可预测·便宜·好测·好排错</text>
<text class="ts" x="195" y="142" text-anchor="middle">步骤固定的业务流程首选</text>
<rect class="b1" x="390" y="14" width="350" height="150" rx="10"/>
<text class="th" x="565" y="36" text-anchor="middle">Agent：路径由模型决定</text>
<rect class="b" x="410" y="54" width="90" height="40" rx="6"/>
<text class="ts" x="455" y="74" text-anchor="middle" dominant-baseline="middle">LLM 决策</text>
<rect class="b" x="540" y="54" width="90" height="40" rx="6"/>
<text class="ts" x="585" y="74" text-anchor="middle" dominant-baseline="middle">调用工具</text>
<line class="l" x1="500" y1="68" x2="540" y2="68" marker-end="url(#arr)"/>
<path class="la" d="M585 94 L585 112 L455 112 L455 94" marker-end="url(#arr-a)"/>
<text class="ta" x="520" y="108" text-anchor="middle">循环直到完成</text>
<text class="ts" x="565" y="134" text-anchor="middle">灵活·能处理开放问题</text>
<text class="ts" x="565" y="152" text-anchor="middle">更慢更贵·结果方差大</text>
<rect class="bg" x="20" y="184" width="720" height="72" rx="8"/>
<text class="tb" x="380" y="204" text-anchor="middle" dominant-baseline="middle">混合：工作流为骨架，局部节点内放 Agent</text>
<text class="ts" x="380" y="226" text-anchor="middle">例：客服流程（识别意图→鉴权→处理→回访）是工作流；“处理”节点中的故障诊断允许 Agent 自主查多个系统</text>
<text class="ts" x="380" y="244" text-anchor="middle">自主性被限制在有预算、有权限边界的节点里，整体仍可审计和回放</text>
</svg>
<figcaption>图 1：工作流与 Agent 的本质区别与混合用法</figcaption>
</figure>

| 维度 | 工作流 | Agent |
| --- | --- | --- |
| 控制权 | 代码 | 模型 |
| 可预测性 | 高，路径有限可枚举 | 低，每次路径可能不同 |
| 延迟与成本 | 低，调用次数确定 | 高，且有长尾 |
| 测试 | 按节点单测 + 路径覆盖 | 需轨迹评测、统计意义上的通过率 |
| 合规与审计 | 容易（流程即文档） | 难，需要完整轨迹留存 |
| 适合 | 步骤明确、规则清晰、有 SLA 的业务流 | 开放探索（调研、排障、写代码）、路径依赖中间结果 |

决策问题：**“如果我是人，能不能提前把步骤写在流程图上？”** 能，就用工作流；不能，才考虑 Agent，并且给它一个**窄范围、少工具、有预算**的环境。

## 五种编排模式

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="五种编排模式：提示链、路由、并行（分片与投票）、编排者-执行者、评估-优化循环">
<text class="th" x="20" y="22">① 提示链</text>
<rect class="b3" x="20" y="32" width="70" height="36" rx="6"/>
<text class="ts" x="55" y="50" text-anchor="middle" dominant-baseline="middle">提取</text>
<rect class="b3" x="110" y="32" width="70" height="36" rx="6"/>
<text class="ts" x="145" y="50" text-anchor="middle" dominant-baseline="middle">校验</text>
<rect class="b3" x="200" y="32" width="70" height="36" rx="6"/>
<text class="ts" x="235" y="50" text-anchor="middle" dominant-baseline="middle">生成</text>
<line class="l" x1="90" y1="50" x2="110" y2="50" marker-end="url(#arr)"/>
<line class="l" x1="180" y1="50" x2="200" y2="50" marker-end="url(#arr)"/>
<text class="ts" x="145" y="88" text-anchor="middle">每步更简单，可在步间加规则校验</text>
<text class="th" x="300" y="22">② 路由</text>
<rect class="b5" x="300" y="44" width="70" height="36" rx="6"/>
<text class="ts" x="335" y="62" text-anchor="middle" dominant-baseline="middle">分类</text>
<rect class="b" x="410" y="30" width="90" height="24" rx="6"/>
<text class="ts" x="455" y="42" text-anchor="middle" dominant-baseline="middle">退款流程</text>
<rect class="b" x="410" y="58" width="90" height="24" rx="6"/>
<text class="ts" x="455" y="70" text-anchor="middle" dominant-baseline="middle">技术支持</text>
<line class="l" x1="370" y1="56" x2="410" y2="42" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="68" x2="410" y2="70" marker-end="url(#arr)"/>
<text class="ts" x="400" y="102" text-anchor="middle">按类型走专用提示词/模型/小模型</text>
<text class="th" x="540" y="22">③ 并行</text>
<rect class="b2" x="540" y="30" width="80" height="24" rx="6"/>
<text class="ts" x="580" y="42" text-anchor="middle" dominant-baseline="middle">子任务 1</text>
<rect class="b2" x="540" y="58" width="80" height="24" rx="6"/>
<text class="ts" x="580" y="70" text-anchor="middle" dominant-baseline="middle">子任务 2</text>
<rect class="b" x="650" y="40" width="90" height="30" rx="6"/>
<text class="ts" x="695" y="55" text-anchor="middle" dominant-baseline="middle">聚合/投票</text>
<line class="l" x1="620" y1="42" x2="650" y2="50" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="70" x2="650" y2="60" marker-end="url(#arr)"/>
<text class="ts" x="640" y="102" text-anchor="middle">分片提速，或多次采样投票</text>
<text class="th" x="20" y="138">④ 编排者-执行者</text>
<rect class="b1" x="20" y="150" width="90" height="40" rx="6"/>
<text class="ts" x="65" y="170" text-anchor="middle" dominant-baseline="middle">编排者 LLM</text>
<rect class="b" x="160" y="146" width="90" height="24" rx="6"/>
<text class="ts" x="205" y="158" text-anchor="middle" dominant-baseline="middle">执行者 1</text>
<rect class="b" x="160" y="174" width="90" height="24" rx="6"/>
<text class="ts" x="205" y="186" text-anchor="middle" dominant-baseline="middle">执行者 N</text>
<rect class="b" x="290" y="158" width="80" height="30" rx="6"/>
<text class="ts" x="330" y="173" text-anchor="middle" dominant-baseline="middle">汇总</text>
<line class="l" x1="110" y1="165" x2="160" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="175" x2="160" y2="186" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="158" x2="290" y2="168" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="186" x2="290" y2="178" marker-end="url(#arr)"/>
<text class="ts" x="195" y="216" text-anchor="middle">子任务数量与内容运行时才知道</text>
<text class="th" x="420" y="138">⑤ 评估-优化</text>
<rect class="b3" x="420" y="150" width="90" height="40" rx="6"/>
<text class="ts" x="465" y="170" text-anchor="middle" dominant-baseline="middle">生成</text>
<rect class="b4" x="560" y="150" width="90" height="40" rx="6"/>
<text class="ts" x="605" y="170" text-anchor="middle" dominant-baseline="middle">评审</text>
<line class="l" x1="510" y1="165" x2="560" y2="165" marker-end="url(#arr)"/>
<path class="la" d="M605 190 L605 208 L465 208 L465 190" marker-end="url(#arr-a)"/>
<text class="ta" x="535" y="224" text-anchor="middle">不达标 → 带反馈重写</text>
<text class="ts" x="690" y="170" text-anchor="middle">达标退出</text>
<rect class="bg" x="20" y="246" width="720" height="100" rx="8"/>
<text class="tb" x="380" y="266" text-anchor="middle" dominant-baseline="middle">组合使用的例子：研究报告助手</text>
<text class="ts" x="380" y="290" text-anchor="middle">路由（判断是综述还是对比）→ 编排者拆出 N 个子问题 → 并行检索与摘要（执行者）</text>
<text class="ts" x="380" y="310" text-anchor="middle">→ 汇总成稿 → 评估-优化（检查引用、覆盖度、事实一致性）→ 人工确认后输出</text>
<text class="ts" x="380" y="330" text-anchor="middle">每种模式都有对应的失败方式与预算上限，组合后要为整体设置步数与费用硬限制</text>
</svg>
<figcaption>图 2：五种常用编排模式及其组合</figcaption>
</figure>

| 模式 | 解决什么 | 要点 | 常见坑 |
| --- | --- | --- | --- |
| **提示链** | 任务可拆成顺序步骤，一步做不好 | 步间加**程序化校验（门）**，不合格直接重试或终止；每步输出结构化 | 上游错误向下放大；链太长延迟高 |
| **路由** | 输入类型多样，需要不同处理 | 分类器可用小模型/规则/向量相似度；**未命中类别要有默认路径** | 分类错误导致整条链走偏；类别边界模糊 |
| **并行（分片）** | 子任务相互独立，想降延迟 | 控制并发数与限流；设置**部分失败策略**（全需/部分可） | 成本成倍；结果合并时冲突 |
| **并行（投票）** | 关键判断需要更高可靠性 | 多次独立采样或多模型，多数表决；注意相关性 | 相同提示词采样的错误高度相关，收益有限 |
| **编排者-执行者** | 子任务无法预先枚举 | 编排者只做**拆解与汇总**；执行者接口窄、输出结构化；限制递归深度 | 拆得过碎；汇总时丢信息 |
| **评估-优化** | 有明确评判标准、迭代能显著提升 | 评审标准要具体；**限制轮数**；评审可用**程序验证**（测试、校验器）优先于模型打分 | 评审与生成同一模型易“自我感觉良好”；无限修改 |

## 状态图运行时

稍复杂的编排，本质是一张**有向图 + 共享状态**。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="状态图运行时：共享状态在节点间流转，条件边根据状态选择下一节点；每个节点执行后写入检查点；遇到中断节点暂停并释放资源，外部事件到来后从检查点恢复；运行时负责重试、超时和预算">
<rect class="b3" x="20" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="65" text-anchor="middle" dominant-baseline="middle">节点：分类</text>
<rect class="b5" x="170" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="225" y="65" text-anchor="middle" dominant-baseline="middle">节点：检索</text>
<rect class="b1" x="320" y="14" width="110" height="46" rx="8"/>
<text class="tb" x="375" y="37" text-anchor="middle" dominant-baseline="middle">节点：生成</text>
<rect class="b4" x="320" y="76" width="110" height="46" rx="8"/>
<text class="tb" x="375" y="99" text-anchor="middle" dominant-baseline="middle">节点：审批</text>
<rect class="b2" x="480" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="535" y="65" text-anchor="middle" dominant-baseline="middle">节点：执行</text>
<rect class="b" x="630" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="685" y="65" text-anchor="middle" dominant-baseline="middle">结束</text>
<line class="l" x1="130" y1="65" x2="170" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="55" x2="320" y2="38" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="75" x2="320" y2="98" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="38" x2="480" y2="55" marker-end="url(#arr)"/>
<line class="l" x1="430" y1="98" x2="480" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="65" x2="630" y2="65" marker-end="url(#arr)"/>
<text class="ta" x="300" y="12" text-anchor="middle">条件边：依据状态选分支</text>
<rect class="bg" x="20" y="146" width="720" height="60" rx="8"/>
<text class="th" x="32" y="164">共享状态 State（结构化）</text>
<text class="ts" x="380" y="190" text-anchor="middle">task_id · messages · 检索结果 · 中间结论 · 工具结果 · 待审批动作 · 预算已用 · 步数 · 错误信息</text>
<rect class="b" x="20" y="226" width="220" height="62" rx="8"/>
<text class="tb" x="130" y="246" text-anchor="middle" dominant-baseline="middle">检查点存储</text>
<text class="ts" x="130" y="268" text-anchor="middle">每个节点后写入状态快照</text>
<rect class="b" x="270" y="226" width="220" height="62" rx="8"/>
<text class="tb" x="380" y="246" text-anchor="middle" dominant-baseline="middle">中断与恢复</text>
<text class="ts" x="380" y="268" text-anchor="middle">审批节点暂停，事件唤醒继续</text>
<rect class="b" x="520" y="226" width="220" height="62" rx="8"/>
<text class="tb" x="630" y="246" text-anchor="middle" dominant-baseline="middle">运行时治理</text>
<text class="ts" x="630" y="268" text-anchor="middle">重试·超时·预算·并发·追踪</text>
</svg>
<figcaption>图 3：状态图运行时的核心构件</figcaption>
</figure>

核心机制：

| 构件 | 说明 |
| --- | --- |
| **状态（State）** | 所有节点读写同一份结构化状态；用**明确的合并规则**（覆盖、追加、取最大）处理并行节点同时写同一字段的冲突 |
| **节点（Node）** | 一个函数：输入状态，输出状态增量；可以是 LLM 调用、工具调用、纯代码、子图；**节点应尽量幂等** |
| **边与条件边** | 普通边固定走向；条件边根据状态（分类结果、校验是否通过、剩余预算）选择下一节点；**路由逻辑尽量用代码** |
| **检查点（Checkpoint）** | 每个节点完成后持久化状态；崩溃后从最近检查点恢复；还支持“**时间旅行**”：回到某一步改状态重跑，用于调试 |
| **中断（Interrupt）** | 在节点前后暂停，等待人工审批或外部事件；暂停期间**不占线程与连接**，状态存库，事件到达后恢复 |
| **子图** | 把一组节点封装为一个节点复用，如“检索+重排+引用校验” |
| **并行与汇聚** | 扇出多个节点并行执行，汇聚点等待全部/任意完成；注意并发上限 |
| **流式** | 节点执行进度、模型 Token 流式推送给前端，改善等待体验 |

## 框架还是自研

| 选择 | 优点 | 缺点 | 适用 |
| --- | --- | --- | --- |
| **LangGraph / 类似的图编排框架** | 状态、检查点、中断、流式开箱即用 | 概念多；与 Java 技术栈融合需额外工作（Python 生态为主，Java 社区有对应实现） | 复杂编排、需要时间旅行调试 |
| **Spring AI / LangChain4j 提供的编排与 Agent 组件** | 与 Spring 生态融合，上手快 | 复杂状态与持久化能力需自行补充 | Java 团队中等复杂度需求 |
| **通用工作流/持久化执行引擎**（如 Temporal、Camunda 等） | 极强的可靠性：重试、定时、补偿、长事务、可视化与审计 | 非 AI 专用，要自己封装 LLM 节点；学习成本 | 长任务、强合规、已有流程引擎的企业 |
| **低代码平台**（Dify、n8n 等） | 非工程人员可搭建，上线快 | 复杂逻辑与版本管理、测试受限 | 内部提效、原型验证 |
| **自研轻量状态机** | 完全可控、依赖少 | 要自己做持久化与可观测 | 流程固定、节点不多的场景 |

选型要问四个问题：状态**能否持久化并恢复**？人工审批**能否暂停恢复**？每个节点**能否观测与回放**？是否**融入现有技术栈与权限体系**？

### Java 里的轻量实现骨架

流程固定时，一个状态机加持久化就够：

```java
public class TicketWorkflow {

    enum Step { CLASSIFY, RETRIEVE, DRAFT, WAIT_APPROVAL, EXECUTE, DONE, FAILED }

    public void run(String taskId) {
        TaskState s = repo.load(taskId);              // 从库中加载，支持恢复
        while (s.step() != Step.DONE && s.step() != Step.FAILED) {
            guard.check(s);                           // 最大步数/总超时/预算/重复检测
            try {
                s = switch (s.step()) {
                    case CLASSIFY      -> classify(s);                 // 小模型/规则
                    case RETRIEVE      -> retrieve(s);                 // RAG
                    case DRAFT         -> draft(s);                    // 生成+结构化校验
                    case WAIT_APPROVAL -> { repo.save(s.pause()); yield null; } // 暂停，释放线程
                    case EXECUTE       -> execute(s);                  // 幂等键 = taskId+step
                    default            -> s;
                };
            } catch (RetryableException e) {
                s = s.retryOrFail(e);                // 指数退避，超过次数进入 FAILED
            }
            if (s == null) return;                   // 等待外部事件（审批）再调用 run
            repo.save(s);                            // 检查点
        }
    }
}
```

要点：**每次转移后保存**、**写操作用幂等键**、**暂停时返回并释放线程**、**重试与终止条件集中在 guard 与异常处理中**。审批通过后由消息或接口调用再次 `run(taskId)`，从检查点继续。长任务的更多机制见 [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep) 与 [事件驱动架构](#/design/event-driven)。

## 可靠性与测试

| 关注点 | 做法 |
| --- | --- |
| **终止保证** | 每个循环（Agent 循环、评估-优化）都有最大轮数；整体总步数、总时间、总费用硬限制 |
| **重复检测** | 连续相同的工具+参数、状态无变化，视为空转，强制跳出或求助 |
| **失败策略** | 节点级重试（区分可重试错误）、模型降级、跳过非关键节点、整体兜底（转人工/返回缓存答案） |
| **结构化中间产物** | 节点间传递结构化数据而不是自然语言，便于校验与单测 |
| **节点级评测** | 分类准确率、检索召回、生成忠实度**分别评测**，定位退化在哪个节点，而不是只看端到端 |
| **端到端评测** | 固定样例跑完整流程，检查最终状态与轨迹；故障注入（某节点超时、返回脏数据） |
| **可观测** | 每个节点一个 span：输入摘要、输出、耗时、Token、重试次数；整个任务一条 trace，可回放 |
| **版本** | 流程定义与提示词有版本；**在途任务按其启动时的版本完成**（或有迁移策略），避免发版后旧任务状态不兼容 |
| **成本** | 简单节点用小模型；并行与投票要评估性价比；缓存确定性节点的结果 |

## 常见错误

| 错误 | 后果 | 改法 |
| --- | --- | --- |
| 一上来就用多 Agent 自主协作 | 成本高、难调试、效果不稳定 | 先用工作流 + 单 Agent 节点，评测证明不足再升级 |
| 让模型做路由和数值判断 | 不稳定、不可测 | 规则/代码能判断的由代码判断 |
| 状态只存在内存或提示词里 | 无法恢复、无法审计 | 结构化状态外置，节点后保存 |
| 流程里没有终止与预算 | 死循环烧钱 | 强制上限，超限转人工 |
| 在节点里直接执行不可逆写操作 | 误操作无法挽回 | 预览 + 审批 + 幂等 + 补偿 |
| 只做端到端评测 | 出问题不知哪个节点退化 | 节点级与端到端并行评测 |
| 发布新流程导致在途任务失败 | 状态结构不兼容 | 流程与状态带版本，兼容或迁移 |

## 相关阅读

- [AI 应用全景与学习路线](#/ai/overview)：手段升级阶梯与选型
- [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep)：Agent 的状态机建模、记忆与评测
- [分布式事务：Saga、TCC 与 Seata](#/distributed/transaction)：补偿与一致性
- [案例：企业智能客服与知识库](#/ai/case-kb)：路由、工具与确认流程的综合应用

## 面试追问

> [!QUESTION] 工作流和 Agent 有什么区别？怎么选？
> 工作流的路径由代码预先定义，模型只在节点里工作，可预测、成本低、好测试；Agent 由模型动态决定下一步，灵活但更慢更贵、方差大。能提前写成流程图的用工作流，路径取决于中间结果的开放问题才用 Agent；常见做法是工作流为骨架，在局部节点放有预算和权限边界的 Agent。

> [!QUESTION] 常见的 LLM 编排模式有哪些？
> 提示链（串行拆解，步间加校验门）、路由（分类后分流到专用处理）、并行（分片提速或投票提高可靠性）、编排者-执行者（运行时动态拆任务再汇总）、评估-优化（生成与评审循环，限制轮数）。实际常组合使用，并为整体设置步数与预算上限。

> [!QUESTION] 状态图运行时需要具备哪些能力？
> 共享的结构化状态及并行写入的合并规则、节点与条件边、每个节点后的检查点持久化与崩溃恢复、人工审批等中断点的暂停与事件唤醒、子图复用、并行扇出汇聚、流式输出，以及重试、超时、预算和追踪等运行时治理。

> [!QUESTION] 为什么说评估-优化模式要优先用程序化验证？
> 模型自评容易自我感觉良好且不稳定；对代码、SQL、结构化数据等能自动验证的结果，用测试、试执行、校验器给出确定性反馈，比让模型打分更可靠，也能提供具体错误信息指导下一轮修改；同时必须限制迭代轮数。

> [!QUESTION] 自研流程还是用现成框架？
> 流程固定、节点不多时，自研“状态机 + 持久化 + 幂等 + 追踪”更轻更可控；需要复杂状态、时间旅行调试或快速迭代用图编排框架；长任务、强合规、已有流程引擎的企业可用 Temporal 等持久化执行引擎封装 LLM 节点；非工程人员搭建内部流程可用低代码平台。关键看持久化、人工介入、可观测与现有栈融合。

> [!QUESTION] 如何评测一个多步骤的 AI 工作流？
> 节点级与端到端同时做：分别评测分类准确率、检索召回、生成忠实度与工具调用正确性，定位退化节点；端到端用固定样例检查最终状态与轨迹，并做故障注入；线上用 trace 回放失败案例，聚类根因后回流为评测样例，流程与提示词变更走回归与灰度。
