---
level: 深入
tags: [评测, 数据集, LLM-as-Judge, 回归门禁, RAG 评估, 检索指标, 忠实度, A/B, 线上反馈, 统计显著性]
summary: LLM 应用评测的工程化：评测的分层与闭环、评测集的来源与构建与版本化、检索/生成/任务/安全各类指标、程序判定与 LLM 评审（偏差与校准）、非确定性下的统计处理、CI 回归门禁、线上评测与数据飞轮、常见坑。
---

# 评测体系实战：数据集、LLM 评审与回归门禁

> [!ABSTRACT] 核心要点
> - 评测是 AI 应用的**测试体系**：没有它，提示词、检索参数、模型版本的每次改动都是赌博。目标不是追求“一个完美分数”，而是**让每次改动都能被量化、可回归、可归因**。
> - 评测要**分层**：组件级（检索、重排、生成、工具调用）定位问题；端到端衡量用户价值；线上衡量真实效果并回流数据，形成**闭环**。
> - 评测集是核心资产：来自**真实线上问题**，按场景**分层覆盖**（常见、边界、无答案、多轮、攻击），有**版本管理**，与训练/调参数据**隔离**；30~50 条即可起步，再持续增长。
> - 判分手段优先级：**程序判定 > 参考答案比对 > LLM 评审 > 人工**；LLM 评审要用**细则（rubric）**、避免偏差，并用**人工标注校准一致性**。
> - 模型输出有随机性：看**多次运行的分布**，用足够样本和置信区间判断“变好还是噪声”；关心**最差的那批样例**，不只看平均分。
> - 工程落地：**CI 回归门禁**（核心指标不得下降）、灰度/A-B 对比、线上反馈回流评测集。

## 评测的分层与闭环

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="评测闭环：组件级评测定位问题，端到端评测衡量任务成功，CI 回归门禁阻止退化，灰度与线上评测观察真实效果，失败案例回流到评测集形成数据飞轮">
<rect class="b3" x="20" y="30" width="150" height="76" rx="10"/>
<text class="tb" x="95" y="52" text-anchor="middle" dominant-baseline="middle">组件级评测</text>
<text class="ts" x="95" y="74" text-anchor="middle">检索·重排·生成·工具</text>
<text class="ts" x="95" y="92" text-anchor="middle">快、可定位根因</text>
<rect class="b5" x="190" y="30" width="150" height="76" rx="10"/>
<text class="tb" x="265" y="52" text-anchor="middle" dominant-baseline="middle">端到端评测</text>
<text class="ts" x="265" y="74" text-anchor="middle">任务成功率·答案质量</text>
<text class="ts" x="265" y="92" text-anchor="middle">贴近用户价值</text>
<rect class="b1" x="360" y="30" width="150" height="76" rx="10"/>
<text class="tb" x="435" y="52" text-anchor="middle" dominant-baseline="middle">CI 回归门禁</text>
<text class="ts" x="435" y="74" text-anchor="middle">核心指标不得退化</text>
<text class="ts" x="435" y="92" text-anchor="middle">失败阻止合并/发布</text>
<rect class="b2" x="530" y="30" width="210" height="76" rx="10"/>
<text class="tb" x="635" y="52" text-anchor="middle" dominant-baseline="middle">灰度 / A-B / 线上评测</text>
<text class="ts" x="635" y="74" text-anchor="middle">用户反馈·隐式信号·抽检</text>
<text class="ts" x="635" y="92" text-anchor="middle">真实分布下的效果</text>
<line class="l" x1="170" y1="68" x2="190" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="68" x2="360" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="68" x2="530" y2="68" marker-end="url(#arr)"/>
<rect class="b4" x="190" y="170" width="320" height="64" rx="10"/>
<text class="tb" x="350" y="192" text-anchor="middle" dominant-baseline="middle">评测集（版本化资产）</text>
<text class="ts" x="350" y="214" text-anchor="middle">常见·边界·无答案·多轮·攻击；持续增补</text>
<path class="la" d="M635 106 L635 200 L510 200" marker-end="url(#arr-a)"/>
<text class="ta" x="640" y="160" text-anchor="start">失败案例回流</text>
<line class="l" x1="350" y1="170" x2="350" y2="130"/>
<path class="la" d="M350 170 L350 140 L95 140 L95 106" marker-end="url(#arr-a)"/>
<path class="la" d="M350 140 L265 140 L265 106" marker-end="url(#arr-a)"/>
<rect class="bg" x="20" y="256" width="720" height="62" rx="8"/>
<text class="ts" x="380" y="278" text-anchor="middle">数据飞轮：线上差评/转人工/纠错 → 人工修正标准答案 → 入评测集 → 下次改动必须不再犯同样的错</text>
<text class="ts" x="380" y="298" text-anchor="middle">评测与提示词、检索参数、模型版本一样要版本化；每份评测报告记录被测版本、评测集版本、时间与指标</text>
</svg>
<figcaption>图 1：评测的分层与数据飞轮</figcaption>
</figure>

| 层次 | 回答的问题 | 典型指标 | 频率 |
| --- | --- | --- | --- |
| **组件级** | 哪个环节出问题？ | 检索召回率、重排命中、分类准确率、工具选择正确率、格式合规率 | 每次改动，分钟级 |
| **端到端** | 整体答得对不对、任务完没完成？ | 正确率、忠实度、完整性、任务成功率、拒答正确率 | 每次改动、发布前 |
| **线上** | 真实用户是否满意？ | 点赞率、追问率、转人工率、复制/采纳率、成本、延迟 | 持续 |

## 评测集构建

### 来源

| 来源 | 价值 | 注意 |
| --- | --- | --- |
| **真实线上问题**（脱敏） | 分布最真实，是基础 | 注意隐私与合规；去重；抽样时保留长尾 |
| **专家编写** | 覆盖关键与刁钻场景，质量高 | 成本高，适合种子集与“金标准” |
| **大模型合成** | 快速扩量、覆盖变形问法 | 必须人工抽检；避免合成题与被测模型同源导致偏高 |
| **失败案例** | 针对性强，防回归 | 修正标准答案后入集，是最有价值的来源 |
| **对抗/攻击样例** | 提示注入、越权、诱导泄露 | 与安全团队共建 |

### 分层覆盖

构建时按**场景维度**打标签，保证每类都有样例，而不是只有简单问题：

| 维度 | 举例 |
| --- | --- |
| 难度 | 单跳事实、多跳推理、需要计算、需要综合多个文档 |
| 意图 | 咨询、操作办理、投诉、闲聊、越界请求 |
| 知识状态 | 有明确答案、**资料没有答案（应拒答）**、资料矛盾、资料过期 |
| 表达形态 | 口语、错别字、缩写、多轮指代（“那它呢？”）、超长输入 |
| 风险 | 权限边界、敏感信息、提示注入 |

### 标注内容

不只是“标准答案”，针对不同任务准备不同的**标注**：

- 问答：参考答案要点（**要点清单**比整段答案更易判分）、应命中的文档/片段 ID、是否应拒答；
- 工具调用：期望调用的工具、关键参数、最终环境状态；
- 抽取/分类：结构化标准结果；
- 多轮：每轮的期望行为与最终目标。

### 规模与维护

- **起步**：30~50 条高质量样例就能发现大部分明显回归；稳定后扩到几百条，覆盖面比数量更重要；
- **划分**：保留一份**盲测集（holdout）** 不参与调参，防止对评测集过拟合；
- **版本化**：评测集放版本库，变更有记录；评测报告注明用的是哪一版；
- **防污染**：评测样例不能出现在微调数据、提示词示例、检索知识库的“标准答案”里；
- **保鲜**：知识更新、业务变化后同步更新标准答案；定期清理过期样例。

## 指标与判分方法

### 指标地图（以 RAG 问答为例）

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="RAG 评估指标地图：检索环节看召回率、精确率、MRR 与 nDCG；生成环节看忠实度（是否有依据）、答案相关性、正确性与完整性、引用准确性；整体看拒答正确率、延迟与成本">
<rect class="b3" x="20" y="30" width="230" height="140" rx="10"/>
<text class="tb" x="135" y="50" text-anchor="middle" dominant-baseline="middle">检索环节</text>
<text class="ts" x="135" y="78" text-anchor="middle">Recall@k：该召回的召回了吗</text>
<text class="ts" x="135" y="100" text-anchor="middle">Precision@k：召回的有多少有用</text>
<text class="ts" x="135" y="122" text-anchor="middle">MRR / nDCG：排得靠不靠前</text>
<text class="ts" x="135" y="150" text-anchor="middle">需要标注“应命中的片段”</text>
<rect class="b1" x="270" y="30" width="250" height="140" rx="10"/>
<text class="tb" x="395" y="50" text-anchor="middle" dominant-baseline="middle">生成环节</text>
<text class="ts" x="395" y="78" text-anchor="middle">忠实度：每句话有资料依据吗</text>
<text class="ts" x="395" y="100" text-anchor="middle">相关性：是否回答了所问</text>
<text class="ts" x="395" y="122" text-anchor="middle">正确性/完整性：要点覆盖多少</text>
<text class="ts" x="395" y="150" text-anchor="middle">引用准确：引用的片段支持结论吗</text>
<rect class="b2" x="540" y="30" width="200" height="140" rx="10"/>
<text class="tb" x="640" y="50" text-anchor="middle" dominant-baseline="middle">整体与运营</text>
<text class="ts" x="640" y="78" text-anchor="middle">拒答正确率（该拒才拒）</text>
<text class="ts" x="640" y="100" text-anchor="middle">格式合规率</text>
<text class="ts" x="640" y="122" text-anchor="middle">P95 延迟·单次成本</text>
<text class="ts" x="640" y="150" text-anchor="middle">安全：越权/泄露次数</text>
<rect class="bg" x="20" y="190" width="720" height="68" rx="8"/>
<text class="ts" x="380" y="212" text-anchor="middle">诊断逻辑：答错时先看召回有没有命中 → 没命中是检索问题；命中但答错是生成问题（上下文被淹没/模型不遵循）</text>
<text class="ts" x="380" y="232" text-anchor="middle">命中且答对但无引用/引用错 → 引用问题；该拒答却硬答 → 提示词与拒答策略问题</text>
<text class="ts" x="380" y="250" text-anchor="middle">把一个“正确率”拆成多个指标，才能知道下一步该改哪里</text>
</svg>
<figcaption>图 2：RAG 评估指标地图与诊断逻辑</figcaption>
</figure>

| 任务类型 | 常用指标与判分 |
| --- | --- |
| **检索** | Recall@k、Precision@k、MRR、nDCG（需标注相关片段，可程序计算） |
| **问答** | 正确率（要点覆盖）、忠实度/幻觉率、相关性、拒答正确率、引用准确率 |
| **结构化输出** | JSON/Schema 合规率、字段准确率（精确匹配或归一化比较）、业务校验通过率 |
| **分类/抽取** | 准确率、精确率/召回率/F1（按类别看，不平衡时别只看整体准确率） |
| **工具调用/Agent** | 工具选择正确率、参数正确率、**最终环境状态是否达成目标**、步数、多余调用、危险调用 |
| **代码/SQL** | 运行测试是否通过、SQL 执行结果与标准结果是否一致（执行准确率）|
| **摘要/改写** | 事实一致性、覆盖要点、风格符合度（多靠 LLM 评审 + 人工） |
| **安全** | 攻击成功率、泄露次数、越权调用、拒绝合规 |
| **运营** | 延迟分位数、Token、成本、错误率、降级触发率 |

### 判分手段的优先级

| 手段 | 适用 | 优点 | 局限 |
| --- | --- | --- | --- |
| **程序判定** | 格式、字段、SQL/代码执行、检索命中、状态检查 | 确定、便宜、可重复 | 只能判定可形式化的部分 |
| **参考答案比对**（规则、要点匹配、嵌入相似度） | 有标准答案的事实类 | 较便宜 | 表述多样时误判；相似度高不等于正确 |
| **LLM 评审（LLM-as-Judge）** | 开放式质量、忠实度、风格 | 可扩展、接近人类判断 | 有偏差，需校准，有成本 |
| **人工评审** | 关键场景、校准基准、争议样例 | 最可靠 | 慢、贵、不一致，需统一标准 |

原则：**能程序判定的绝不用 LLM**；用 LLM 评审时，把答案拆成**可核对的要点**判断，比整体打分更稳定。

## LLM 评审（LLM-as-Judge）

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="LLM 评审流程与校准：输入问题、参考要点、被评答案与评分细则，评审模型先给理由再给分，与人工标注对比计算一致性，发现偏差后调整细则和提示词，并采用位置互换等方式减少偏差">
<rect class="b3" x="20" y="30" width="200" height="100" rx="10"/>
<text class="tb" x="120" y="50" text-anchor="middle" dominant-baseline="middle">评审输入</text>
<text class="ts" x="120" y="74" text-anchor="middle">问题 · 参考要点 · 资料</text>
<text class="ts" x="120" y="94" text-anchor="middle">被评答案 · 评分细则</text>
<text class="ts" x="120" y="114" text-anchor="middle">（细则含打分示例）</text>
<rect class="b1" x="250" y="30" width="230" height="100" rx="10"/>
<text class="tb" x="365" y="50" text-anchor="middle" dominant-baseline="middle">评审模型</text>
<text class="ts" x="365" y="74" text-anchor="middle">先逐条核对要点并给理由</text>
<text class="ts" x="365" y="94" text-anchor="middle">再输出结构化分数</text>
<text class="ts" x="365" y="114" text-anchor="middle">温度低·必要时多次取中位数</text>
<rect class="b2" x="510" y="30" width="230" height="100" rx="10"/>
<text class="tb" x="625" y="50" text-anchor="middle" dominant-baseline="middle">输出</text>
<text class="ts" x="625" y="74" text-anchor="middle">各维度分 + 理由</text>
<text class="ts" x="625" y="94" text-anchor="middle">通过/不通过</text>
<text class="ts" x="625" y="114" text-anchor="middle">聚合成报告</text>
<line class="l" x1="220" y1="80" x2="250" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="80" x2="510" y2="80" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="160" width="350" height="110" rx="10"/>
<text class="tb" x="195" y="180" text-anchor="middle" dominant-baseline="middle">常见偏差</text>
<text class="ts" x="195" y="204" text-anchor="middle">位置偏差：成对比较偏向先出现的</text>
<text class="ts" x="195" y="222" text-anchor="middle">长度偏差：偏爱更长的回答</text>
<text class="ts" x="195" y="240" text-anchor="middle">自我偏好：偏爱同系模型的输出</text>
<text class="ts" x="195" y="258" text-anchor="middle">分数膨胀：普遍给高分，区分度低</text>
<rect class="b5" x="390" y="160" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="180" text-anchor="middle" dominant-baseline="middle">校准与缓解</text>
<text class="ts" x="565" y="204" text-anchor="middle">抽 50~100 条人工标注，算与评审的一致率</text>
<text class="ts" x="565" y="222" text-anchor="middle">成对比较时交换顺序各评一次</text>
<text class="ts" x="565" y="240" text-anchor="middle">评审模型与被测模型尽量不同源</text>
<text class="ts" x="565" y="258" text-anchor="middle">按二元/少档位打分，细则带正反例</text>
</svg>
<figcaption>图 3：LLM 评审的流程、常见偏差与校准</figcaption>
</figure>

评审提示词的写法（示意）：

```text
你是严格的评审员。根据【资料】判断【答案】是否忠实。
步骤：1) 把答案拆成独立的事实陈述；2) 逐条判断是否能在资料中找到明确依据；
3) 统计有依据的比例。只输出 JSON：
{"claims":[{"text":"...","supported":true|false,"evidence":"资料片段编号或空"}],
 "faithfulness": 0~1, "verdict": "pass"|"fail"}
评分细则：资料没有提及但常识正确的内容，也算“无依据”。
```

实践要点：

- **二元或少档位**（通过/不通过、1~5 分且每档有定义）比 0~100 连续分稳定；
- **先理由后分数**（让模型逐条核对再给结论），并要求**引用证据**，便于人工复查；
- **成对比较**用于“哪个版本更好”时更稳：随机打乱顺序、交换位置各评一次，不一致则记平局；
- **校准**：抽样与人工结果对比，计算一致率（如 Cohen's κ），一致率不足就修改细则，直到可接受；评审提示词本身也要版本化；
- **成本**：评审调用占评测成本大头，分级使用：先程序判定，再对不确定的样例调用强模型评审；
- **不要让评审模型看到被测模型的身份**，也避免用评测集训练评审。

## 非确定性与统计

模型输出每次不同，评测结果会有噪声。

| 问题 | 做法 |
| --- | --- |
| **同一版本两次分数不同** | 评测时降低温度；对关键样例**重复运行多次**取均值与方差 |
| **提升是真的还是噪声** | 样本越多越可靠：用**置信区间**或配对检验（同一批样例的新旧对比用配对检验/自助法）；小幅波动不要当成结论 |
| **只看平均分** | 同时看**最差分位**与**失败样例清单**：平均 +1% 但关键场景退化，不能发布 |
| **样例太少** | 100 条上的 2% 差异多半是噪声；要么增加样例，要么只关注显著差异 |
| **pass@k 与稳定性** | Agent 类任务关注“重复 N 次的成功率”与方差，而不是跑一次 |
| **指标冲突** | 质量、成本、延迟需综合：事先定好**可接受的权衡**（如质量提升必须 ≥X 才允许成本上升 Y%） |

## 工程化：回归门禁与线上评测

### CI 回归门禁

```java
// 评测门禁示意（JUnit 中运行；评测集与基线版本化存放）
@Test
void ragRegressionGate() {
    EvalReport cur = runner.run(evalSet("v12"), candidatePipeline);
    EvalReport base = baselineStore.latest("main");

    // 绝对门槛
    assertThat(cur.metric("faithfulness")).isGreaterThanOrEqualTo(0.90);
    assertThat(cur.metric("refuseCorrect")).isGreaterThanOrEqualTo(0.95);
    // 相对基线：核心指标不得显著下降（留出噪声容忍）
    assertThat(cur.metric("recall@5")).isGreaterThanOrEqualTo(base.metric("recall@5") - 0.01);
    // 关键样例不得回归
    assertThat(cur.failedMustPassCases()).isEmpty();
    // 成本与延迟
    assertThat(cur.p95LatencyMs()).isLessThan(8000);
    // 报告随构建产物保存，便于对比与追溯
}
```

做法要点：

- **分级**：每次提交跑**小集（分钟级，程序判定为主）**；发布前跑**全集 + LLM 评审**；
- **必过用例（must-pass）**：曾造成事故的样例，任何变更都不能失败；
- **基线管理**：主分支最新的评测结果作为基线，**更新基线需要评审**，避免“慢慢滑坡”；
- **报告可读**：输出失败样例、前后对比、按场景分组的指标，开发者能直接定位；
- **环境固定**：固定被测模型版本、温度、检索索引快照，评测才可重复；模型厂商升级默认版本时重新评测。

### 线上评测

| 信号 | 说明 |
| --- | --- |
| **显式反馈** | 点赞/点踩、原因标签、纠错；比例低但价值高，入口要方便 |
| **隐式信号** | 追问或重复提问、改写问题、转人工、复制/采纳答案、会话放弃 |
| **抽样复核** | 对低评分、高风险、新场景按比例人工审阅，给出标准答案后入评测集 |
| **影子流量** | 新方案并行处理线上请求但不返回，离线对比与线上方案的差异 |
| **灰度 / A-B** | 按用户分流，对比满意度、解决率、转人工率、成本；注意样本量与周期效应 |
| **漂移监控** | 问题分布变化、拒答率、检索命中率、Token 异常，提示知识库或提示词需要更新 |

> [!WARNING] 隐私与合规
> 线上日志用于评测前要脱敏，按合规要求控制访问范围与保留期；用户反馈中的个人信息不要直接进入评测集和训练集。

### 工具

社区有 Ragas、DeepEval、promptfoo、各类 LLMOps 平台的评测模块等，提供指标实现、评测运行与报告；选型看：能否接入自己的流水线、评审提示词是否可自定义与版本化、是否支持数据集管理与回归对比。**工具只是脚手架**，评测集与细则才是核心，且常常要为自己的场景定制。

## 常见坑

| 坑 | 表现 | 对策 |
| --- | --- | --- |
| **评测集太小太简单** | 分数很高，上线一堆问题 | 按场景分层，补边界、无答案、攻击与线上失败样例 |
| **评测集过期** | 知识更新后标准答案已错 | 与知识库同步维护，定期清理 |
| **数据泄漏/污染** | 分数虚高 | 评测集与训练、示例、知识库严格隔离，留盲测集 |
| **只看平均** | 掩盖关键场景退化 | 按维度分组，看最差样例与 must-pass |
| **评审偏差** | LLM 评审偏爱长答案、偏爱同源模型 | 校准、换序、不同源评审、少档位 |
| **指标与业务脱节** | 指标好看，用户不买账 | 与线上指标对照，定期用人工评审验证相关性 |
| **过度优化评测集** | 对评测集过拟合 | 盲测集、持续引入新样例 |
| **没有基线** | 不知道是否变好 | 每次评测与基线对比，记录版本 |
| **评测不可重复** | 结果波动大 | 固定版本与参数，多次运行，置信区间 |
| **评测成本失控** | 评审调用过多 | 分级评测、缓存、先程序判定 |

## 相关阅读

- [RAG 检索优化、向量库与评估](#/ai/rag-advanced)：检索指标与 RAG 评估闭环
- [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep)：轨迹级评测
- [LLM 应用工程化、安全与评测](#/ai/llmops)：评测在整个工程体系中的位置
- [提示词工程进阶与结构化输出](#/ai/prompt-eng)：提示词的版本与评测
- [压测方法与容量规划](#/design/eng-loadtest)：评测门禁与性能基线的类比

## 面试追问

> [!QUESTION] 为什么要建评测集？怎么从零开始建？
> 没有评测，提示词、检索参数、模型的改动都无法量化，也无法回归。从线上真实问题和专家样例起步，30~50 条覆盖常见、边界、无答案、多轮与攻击场景，标注参考要点和应命中的片段；放版本库，留盲测集，随线上失败案例持续扩充。

> [!QUESTION] RAG 系统怎么评估？指标有哪些？
> 分环节：检索看 Recall@k、Precision@k、MRR、nDCG；生成看忠实度、相关性、正确性与完整性、引用准确；整体看拒答正确率、格式合规、延迟成本、安全。拆成多个指标是为了诊断：没召回是检索问题，召回了但答错是生成问题，该拒答却硬答是提示词与拒答策略问题。

> [!QUESTION] LLM-as-Judge 有什么问题？怎么用得可靠？
> 存在位置偏差、长度偏差、自我偏好和分数膨胀。做法：用带正反例的细则，二元或少档位打分，先逐条核对再给分并引用证据；成对比较交换顺序；评审模型与被测模型尽量不同源；抽样人工标注计算一致率校准；能程序判定的绝不用模型评审。

> [!QUESTION] 模型输出不确定，怎么判断一次改动是真的变好了？
> 降低温度并多次运行取均值与方差，用足够的样本和置信区间或配对检验判断差异是否显著，同时看最差分位和 must-pass 用例，不只看平均分；事先约定质量、成本、延迟的可接受权衡。

> [!QUESTION] 评测怎么接入研发流程？
> CI 里分级运行：每次提交跑小集（程序判定为主），发布前跑全集加 LLM 评审；核心指标低于基线或 must-pass 失败则阻止合并；基线用主分支最新结果，更新需评审；固定模型版本、温度和索引快照以保证可重复；线上通过反馈、抽检、影子流量和 A/B 补充，失败案例回流评测集。

> [!QUESTION] 评测集有哪些常见陷阱？
> 过小过易导致虚高；知识更新后过期；与训练数据或示例泄漏污染；只看平均掩盖关键场景退化；对评测集过拟合；指标与真实用户满意度脱节。对策是分层覆盖、定期维护、严格隔离并留盲测集、按场景分组和 must-pass、持续引入新样例并与线上指标对照。
