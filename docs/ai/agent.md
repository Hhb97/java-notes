---
level: 深入
tags: [Agent, Function Calling, ReAct, MCP, 工作流, 多智能体, 记忆, 规划]
summary: 讲清 Agent 的本质与基本循环，工具调用协议和设计规范，工作流与自主 Agent 的区别，记忆与规划，多智能体协作，Model Context Protocol（MCP）的架构，以及可靠性与安全控制。
---

# Agent、工具调用与 MCP

> [!ABSTRACT] 核心要点
> - **Agent = LLM + 工具 + 循环**：模型根据目标**自主决定下一步动作**（调用工具或给出答案），工具结果回灌给模型，如此循环直到完成；与“固定流程调用模型”的**工作流（Workflow）** 的区别在于**控制流由谁决定**。
> - **能用工作流就别用 Agent**：流程确定、步骤固定的任务用工作流（可预测、便宜、易测试）；只有**步数不确定、需要动态决策**的任务才用 Agent。
> - **工具设计决定上限**：名称与描述清晰、参数 Schema 严格、返回精简可读、错误信息可指导模型修正；**危险工具必须在代码层鉴权与确认**。
> - **MCP（Model Context Protocol）** 是连接 LLM 应用与外部工具/数据的**开放协议**：Host/Client/Server 架构、基于 JSON-RPC，暴露 **Tools / Resources / Prompts**，让工具“一次实现，多处使用”。
> - Agent 的最大风险是**不确定性与副作用**：必须设**最大步数、超时、预算、幂等、人工确认、审计日志与沙箱**，并通过评测集持续验证。

> [!NOTE] 技术演进很快
> Agent 框架、MCP 规范与厂商 API 迭代频繁。本页聚焦稳定的**概念与设计原则**，具体 API、协议版本与传输方式**请以官方文档为准**。

## 什么是 Agent

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Agent 基本循环：模型思考，决定调用工具，执行工具，观察结果，循环直到给出最终答案">
<rect class="b1" x="20" y="120" width="110" height="60" rx="8"/>
<text class="tb" x="75" y="144" text-anchor="middle" dominant-baseline="middle">用户目标</text>
<text class="ts" x="75" y="164" text-anchor="middle">“帮我退掉订单”</text>
<rect class="b3" x="200" y="60" width="200" height="180" rx="12"/>
<text class="th" x="300" y="86" text-anchor="middle">大模型（决策者）</text>
<text class="ts" x="300" y="112" text-anchor="middle">上下文 = 目标 + 历史</text>
<text class="ts" x="300" y="132" text-anchor="middle">+ 工具说明 + 已有观察</text>
<text class="tb" x="300" y="170" text-anchor="middle">选择：</text>
<text class="ts" x="300" y="192" text-anchor="middle">① 调用某个工具（带参数）</text>
<text class="ts" x="300" y="212" text-anchor="middle">② 给出最终回答</text>
<rect class="b2" x="500" y="60" width="240" height="180" rx="12"/>
<text class="th" x="620" y="86" text-anchor="middle">工具集（你的代码）</text>
<text class="ts" x="620" y="116" text-anchor="middle">queryOrder(orderNo)</text>
<text class="ts" x="620" y="138" text-anchor="middle">cancelOrder(orderNo)</text>
<text class="ts" x="620" y="160" text-anchor="middle">searchKnowledge(query)</text>
<text class="ts" x="620" y="182" text-anchor="middle">sendEmail(...)</text>
<text class="ts" x="620" y="210" text-anchor="middle">鉴权 · 校验 · 限流 · 审计</text>
<line class="l" x1="130" y1="150" x2="200" y2="150" marker-end="url(#arr)"/>
<line class="la" x1="400" y1="110" x2="500" y2="110" marker-end="url(#arr-a)"/>
<text class="ta" x="450" y="100" text-anchor="middle">tool_call</text>
<line class="l" x1="500" y1="190" x2="400" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="450" y="208" text-anchor="middle">观察结果</text>
<line class="l" x1="300" y1="240" x2="300" y2="276"/>
<text class="tb" x="300" y="296" text-anchor="middle">最终回答 → 用户</text>
<text class="ts" x="380" y="320" text-anchor="middle">循环直到：模型给出最终答案 / 达到最大步数 / 超时 / 需要人工确认</text>
</svg>
<figcaption>图 1：Agent 循环：决策 → 调用工具 → 观察 → 再决策</figcaption>
</figure>

### 与普通 LLM 调用、工作流的区别

| | 单次 LLM 调用 | **工作流（Workflow）** | **Agent** |
| --- | --- | --- | --- |
| 控制流 | 无 | **代码预先写死**步骤，LLM 只在节点内工作 | **模型自己决定**步骤与次数 |
| 可预测性 | 高 | 高 | 低 |
| 成本/延迟 | 低 | 中 | 高且不稳定 |
| 适用 | 问答、改写、抽取 | 流程固定的业务（审批、报表生成） | 开放式、步数不定（调研、排障、复杂客服） |
| 测试难度 | 低 | 中 | 高 |

**常见的工作流模式**（能满足需求就不要上 Agent）：

| 模式 | 说明 | 例子 |
| --- | --- | --- |
| 提示链（Prompt Chaining） | 串行拆分任务，每步输出作为下一步输入，可插入校验 | 先提取要点 → 再写文案 → 再翻译 |
| 路由（Routing） | 先分类，再分派到不同处理分支/模型 | 客服问题分流到退款/物流/技术 |
| 并行化（Parallelization） | 子任务并行，或多次投票取共识 | 多维度同时评审；多模型投票 |
| 编排-执行（Orchestrator-Workers） | 一个模型动态拆分任务，分派给多个 worker 再汇总 | 修改多文件的代码任务 |
| 评估-优化（Evaluator-Optimizer） | 一个生成，一个评估并给反馈，迭代 | 翻译润色、代码审查后修改 |

## 工具调用（Function Calling）

### 协议流程

1. 请求里携带**工具定义**（名称、描述、参数的 JSON Schema）；
2. 模型返回 **tool_call**（工具名 + JSON 参数），可能**一次多个（并行调用）**；
3. 你的代码**校验并执行**，把结果以 `tool` 角色消息追加到对话；
4. 再次调用模型，直到它不再请求工具、返回最终回答。

```json
// 工具定义
{
  "name": "cancel_order",
  "description": "取消用户的未发货订单。仅当订单状态为“待发货”时可用；已发货订单请改用 create_return。",
  "parameters": {
    "type": "object",
    "properties": {
      "order_no": { "type": "string", "description": "订单号，形如 A1001" },
      "reason":   { "type": "string", "enum": ["不想要了", "拍错了", "其他"] }
    },
    "required": ["order_no", "reason"]
  }
}
```

### 工具设计原则

| 原则 | 说明 |
| --- | --- |
| **名称与描述写给模型看** | 说清**做什么、何时用、何时不用**、副作用；描述质量直接决定调用准确率 |
| 参数 Schema 严格 | 类型、枚举、必填、示例；能用枚举就别用自由文本 |
| **少而精** | 工具太多（几十个）会让模型选择困难；按场景动态提供工具子集，或用路由 |
| 粒度适中 | 一个工具完成一个有意义的动作，避免过细（调用次数暴增）或过粗（参数复杂） |
| 返回**精简且可读** | 只返回模型需要的字段；大结果分页/摘要；带**明确的错误信息和下一步建议** |
| **幂等** | 允许重试、重复调用不产生重复副作用（带业务唯一键） |
| **权限在代码层** | 工具执行时用**当前用户身份**鉴权，不信任模型传来的用户 ID |
| 区分读与写 | 读工具可自动执行；写工具/高风险工具需**确认**（人在回路） |
| 错误可自修复 | 参数校验失败时返回“字段 X 格式应为……”，模型可据此重试 |

```java
@Tool(description = "查询订单状态与物流。仅能查询当前登录用户自己的订单。")
public OrderView queryOrder(@ToolParam(description = "订单号，如 A1001") String orderNo) {
    long uid = SecurityContext.currentUserId();              // 身份来自会话，不是模型参数
    return orderService.findByUser(uid, orderNo)
            .map(OrderView::from)                           // 只返回必要字段
            .orElseThrow(() -> new ToolError("未找到订单 " + orderNo + "，请核对订单号"));
}
```

## ReAct 与推理模式

**ReAct（Reason + Act）**：模型交替输出**思考（Thought）**与**行动（Action）**，根据**观察（Observation）**调整后续行动：

```text
Thought: 用户要退订单 A1001，我先查订单状态
Action: query_order(order_no="A1001")
Observation: {"status":"待发货","amount":199}
Thought: 待发货，可以直接取消。取消属于写操作，需要用户确认
Action: ask_user_confirm("确认取消订单 A1001（¥199）吗？")
...
```

- 现代模型的**原生工具调用 + 内置推理**已覆盖多数 ReAct 场景，不必手写文本协议；
- **规划（Planning）**：复杂任务先让模型生成计划（步骤列表），再逐步执行并允许**重规划**；计划可展示给用户确认；
- **反思（Reflection）**：执行后让模型（或另一个评审模型）检查结果、发现错误并修正；注意循环上限，避免无限自我纠结。

## 记忆

| 类型 | 内容 | 实现 |
| --- | --- | --- |
| **短期记忆**（工作记忆） | 当前会话的消息、工具调用与结果 | 上下文窗口；过长时**摘要/截断/只保留关键步骤** |
| **长期记忆** | 用户偏好、历史事实、过往经验 | **向量库/数据库**存储，需要时**检索**注入上下文（本质是 RAG） |
| **情景记忆** | 过去任务的执行轨迹 | 存档并检索相似案例作为示例 |
| **语义记忆/知识库** | 领域知识 | [RAG](#/ai/rag) |

注意：记忆要有**写入策略（什么值得记）、更新与遗忘策略、隐私与权限隔离**；把不可信内容写入长期记忆会造成**记忆投毒**。

## 多智能体

| 模式 | 说明 | 适用 |
| --- | --- | --- |
| **主管-下属（Supervisor）** | 一个协调 Agent 拆解任务并分派给专业 Agent | 任务可分解、领域多样 |
| 流水线/接力 | Agent 按固定顺序传递结果 | 本质是工作流 |
| 辩论/评审 | 多个 Agent 互相质疑、交叉验证 | 需要提高可靠性的判断 |
| 群聊/协作 | Agent 共享对话空间自由协作 | 探索类任务 |

多智能体**增加成本、延迟和调试难度**：上下文传递、角色冲突、无限循环等问题频出。原则：**先用单 Agent + 好工具，确有职责/上下文隔离需求再拆分**；子 Agent 之间传递**结构化摘要**而非全文。

## MCP（Model Context Protocol）

### 解决什么问题

没有标准时，每个 AI 应用要为每个外部系统（数据库、文档、Git、业务 API）单独写集成代码（M 个应用 × N 个系统）。MCP 定义了统一协议，**工具提供方实现一次 MCP Server，所有支持 MCP 的客户端都能使用**（M + N）。

<figure class="fig">
<svg viewBox="0 0 740 310" class="dg" role="img" aria-label="MCP 架构：Host 内含多个 Client，每个 Client 连接一个 Server，Server 暴露 Tools、Resources、Prompts">
<rect class="bg" x="20" y="20" width="330" height="270" rx="12"/>
<text class="th" x="36" y="44">Host（AI 应用 / IDE / 你的 Agent）</text>
<rect class="b3" x="40" y="62" width="290" height="50" rx="8"/>
<text class="tb" x="185" y="82" text-anchor="middle" dominant-baseline="middle">LLM + Agent 循环</text>
<text class="ts" x="185" y="100" text-anchor="middle">决策何时调用哪个工具</text>
<rect class="b1" x="40" y="132" width="130" height="44" rx="8"/>
<text class="tb" x="105" y="154" text-anchor="middle" dominant-baseline="middle">MCP Client A</text>
<rect class="b1" x="200" y="132" width="130" height="44" rx="8"/>
<text class="tb" x="265" y="154" text-anchor="middle" dominant-baseline="middle">MCP Client B</text>
<rect class="b1" x="40" y="196" width="130" height="44" rx="8"/>
<text class="tb" x="105" y="218" text-anchor="middle" dominant-baseline="middle">MCP Client C</text>
<line class="l" x1="105" y1="112" x2="105" y2="132" marker-end="url(#arr)"/>
<line class="l" x1="265" y1="112" x2="265" y2="132" marker-end="url(#arr)"/>
<line class="l" x1="185" y1="112" x2="105" y2="196" marker-end="url(#arr)"/>
<text class="ts" x="185" y="266" text-anchor="middle">每个 Client 与一个 Server 保持 1:1 连接</text>
<rect class="b2" x="420" y="20" width="300" height="80" rx="10"/>
<text class="th" x="570" y="42" text-anchor="middle">MCP Server：文件系统（本地）</text>
<text class="ts" x="570" y="66" text-anchor="middle">Tools: read_file / write_file</text>
<text class="ts" x="570" y="86" text-anchor="middle">Resources: 文件内容</text>
<rect class="b2" x="420" y="115" width="300" height="80" rx="10"/>
<text class="th" x="570" y="137" text-anchor="middle">MCP Server：业务系统（远程）</text>
<text class="ts" x="570" y="161" text-anchor="middle">Tools: query_order / cancel_order</text>
<text class="ts" x="570" y="181" text-anchor="middle">Prompts: 客服话术模板</text>
<rect class="b2" x="420" y="210" width="300" height="80" rx="10"/>
<text class="th" x="570" y="232" text-anchor="middle">MCP Server：数据库 / 知识库</text>
<text class="ts" x="570" y="256" text-anchor="middle">Tools: run_sql(只读) / search_docs</text>
<text class="ts" x="570" y="276" text-anchor="middle">Resources: 表结构</text>
<line class="la" x1="170" y1="154" x2="420" y2="60" marker-end="url(#arr-a)"/>
<line class="la" x1="330" y1="154" x2="420" y2="155" marker-end="url(#arr-a)"/>
<line class="la" x1="170" y1="218" x2="420" y2="250" marker-end="url(#arr-a)"/>
<text class="ta" x="372" y="116" text-anchor="middle">JSON-RPC 2.0</text>
</svg>
<figcaption>图 2：MCP 的 Host / Client / Server 架构，基于 JSON-RPC 2.0</figcaption>
</figure>

### 核心概念

| 概念 | 说明 | 谁控制 |
| --- | --- | --- |
| **Tools** | 可被模型调用的**函数**（有副作用或计算） | 模型决定调用（客户端可要求用户确认） |
| **Resources** | 可读取的**数据/上下文**（文件、数据库记录、文档），以 URI 标识 | 应用控制 |
| **Prompts** | 预置的**提示词模板**，带参数，供用户选用 | 用户控制 |
| Sampling 等 | 服务端请求客户端的模型调用能力等扩展 | 以规范为准 |

- 协议基于 **JSON-RPC 2.0**，生命周期：**初始化握手（协商版本与能力）→ 工具/资源发现（`tools/list`）→ 调用（`tools/call`）→ 通知**；
- **传输方式**：本地进程用 **stdio**（客户端启动子进程，经标准输入输出通信）；远程服务用 **HTTP**（规范演进中，早期为 HTTP + SSE，后推出 Streamable HTTP），**具体以所用规范版本为准**；
- 远程 MCP Server 的**认证授权**采用 **OAuth 2.x** 体系（规范持续演进）。

```json
// 客户端 → 服务端：列出工具
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
// 服务端 → 客户端
{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [
    { "name": "query_order", "description": "按订单号查询订单",
      "inputSchema": { "type": "object", "properties": { "orderNo": { "type": "string" } }, "required": ["orderNo"] } } ] } }
// 调用
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "query_order", "arguments": { "orderNo": "A1001" } } }
```

### 什么时候用 MCP

| 场景 | 建议 |
| --- | --- |
| 自己的单个应用调用自己的少量工具 | 直接用框架的 function calling 即可，不必引入 MCP |
| 需要让**多个 AI 应用/IDE/Agent**复用同一能力 | **实现 MCP Server**，一处开发多处使用 |
| 接入社区已有的工具生态（文件、Git、数据库、各类 SaaS） | 使用现成 MCP Server |
| 企业内部把业务系统开放给 AI | 在业务系统前包一层 **MCP Server（网关）**，统一**鉴权、审计、限流** |

### MCP 的安全注意

- **最小权限**：只读工具与写工具分开，限制可访问的目录/表/接口；数据库 MCP 默认**只读账号**；
- **用户确认**：高风险调用在客户端弹窗确认；
- **不可信服务**：第三方 MCP Server 的**工具描述本身可能含恶意指令（工具投毒）**，只接入可信来源，审查工具描述；
- **凭证管理**：密钥不进提示词、不让模型接触；远程授权用 OAuth，范围最小化；
- **审计**：记录每次工具调用的用户、参数、结果。

## 可靠性与安全控制

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Agent 的多层护栏：输入、规划、工具执行、输出各层的控制措施">
<rect class="b1" x="20" y="50" width="160" height="150" rx="10"/>
<text class="th" x="100" y="74" text-anchor="middle">输入层</text>
<text class="ts" x="100" y="100" text-anchor="middle">身份认证</text>
<text class="ts" x="100" y="120" text-anchor="middle">输入审核/注入检测</text>
<text class="ts" x="100" y="140" text-anchor="middle">限流与配额</text>
<text class="ts" x="100" y="160" text-anchor="middle">敏感信息脱敏</text>
<rect class="b3" x="200" y="50" width="160" height="150" rx="10"/>
<text class="th" x="280" y="74" text-anchor="middle">推理层</text>
<text class="ts" x="280" y="100" text-anchor="middle">最大步数 / 超时</text>
<text class="ts" x="280" y="120" text-anchor="middle">Token / 费用预算</text>
<text class="ts" x="280" y="140" text-anchor="middle">循环与重复检测</text>
<text class="ts" x="280" y="160" text-anchor="middle">计划可视化与确认</text>
<rect class="b4" x="380" y="50" width="180" height="150" rx="10"/>
<text class="th" x="470" y="74" text-anchor="middle">工具执行层（关键）</text>
<text class="ts" x="470" y="100" text-anchor="middle">代码层鉴权（用户身份）</text>
<text class="ts" x="470" y="120" text-anchor="middle">参数校验与白名单</text>
<text class="ts" x="470" y="140" text-anchor="middle">高风险操作人工确认</text>
<text class="ts" x="470" y="160" text-anchor="middle">幂等 · 沙箱 · 超时 · 审计</text>
<rect class="b2" x="580" y="50" width="140" height="150" rx="10"/>
<text class="th" x="650" y="74" text-anchor="middle">输出层</text>
<text class="ts" x="650" y="100" text-anchor="middle">内容审核</text>
<text class="ts" x="650" y="120" text-anchor="middle">事实/引用校验</text>
<text class="ts" x="650" y="140" text-anchor="middle">敏感信息过滤</text>
<text class="ts" x="650" y="160" text-anchor="middle">兜底话术</text>
<line class="l" x1="180" y1="125" x2="200" y2="125" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="125" x2="380" y2="125" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="125" x2="580" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="370" y="236" text-anchor="middle">所有层都要有日志与追踪（每一步的思考、工具、参数、结果、耗时、Token），用于排查与评测</text>
<text class="ts" x="370" y="258" text-anchor="middle">原则：模型只提“建议”，真正的权限与副作用由确定性的代码把关</text>
</svg>
<figcaption>图 3：Agent 的多层控制：输入、推理、工具执行、输出</figcaption>
</figure>

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 无限循环/成本失控 | 反复调用同一工具、不收敛 | **最大步数、超时、Token 预算**；检测重复调用；失败重试上限 |
| 幻觉调用 | 编造不存在的工具/参数 | 严格校验工具名与 Schema；未知工具直接报错 |
| 越权与数据泄露 | 模型被诱导访问他人数据 | **工具内用会话身份鉴权**；数据范围在代码层限制 |
| **间接提示注入** | 网页/文档/邮件内容里夹带指令，Agent 照做 | 外部内容视为**不可信数据**；隔离；对写操作二次确认；限制工具组合（读外部数据后不得直接发邮件/转账） |
| 不可逆操作 | 误删、误转账、群发 | 人在回路确认；可撤销设计；演练与灰度；dry-run 模式 |
| 不稳定 | 同样输入结果不同 | 评测集回归、降低 temperature、关键步骤用代码而不是模型决策 |
| 上下文污染/膨胀 | 历史越来越长、变慢变贵 | 摘要压缩、只保留关键观察、子任务隔离上下文 |

> [!CAUTION] “致命三要素”
> 当一个 Agent **同时**拥有：① 访问私有数据，② 接触不可信内容（网页、邮件、文档），③ 对外通信或执行动作的能力时，攻击者就可能通过注入内容让它**把私有数据发送出去**。设计时至少拆掉其中一个要素，或对出口动作强制人工确认。

## 评测 Agent

Agent 的评测比 RAG 更难（过程不确定、结果依赖环境）：

- **任务成功率**：端到端是否完成目标（可程序化判定的最好，如“订单状态变为已取消”）；
- **轨迹质量**：工具选择是否正确、步数是否合理、有无多余或危险调用；
- **成本与延迟**：平均步数、Token、耗时；
- **安全性**：注入测试集、越权测试集、拒绝不当请求；
- 用**可重复的模拟环境**（Mock 工具）+ 固定评测集回归；线上抽样人工复核；
- 更多见 [LLM 应用工程化、安全与评测](#/ai/llmops)。

## Java 实现提示

```java
// 一个最小的 Agent 循环（示意；实际建议使用 Spring AI / LangChain4j）
List<Message> msgs = new ArrayList<>(List.of(system(RULES), user(goal)));
for (int step = 0; step < MAX_STEPS; step++) {                          // 最大步数护栏
    ChatResponse r = llm.chat(msgs, tools);
    msgs.add(r.message());
    if (r.toolCalls().isEmpty()) return r.text();                        // 模型给出最终答案
    for (ToolCall call : r.toolCalls()) {
        Object result;
        try {
            Tool tool = registry.get(call.name());                       // 白名单：未知工具直接拒绝
            policy.check(user, tool, call.args());                        // 鉴权 / 风险分级 / 是否需要确认
            result = tool.invoke(call.args());
        } catch (ToolException e) {
            result = Map.of("error", e.getMessage());                    // 可自修复的错误回传给模型
        }
        msgs.add(toolResult(call.id(), json(result)));
    }
    budget.checkOrThrow();                                               // Token / 费用 / 时间预算
}
throw new AgentLimitException("超过最大步数");
```

框架层的实现见 [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)。

## 相关阅读

- [MCP 深入：协议、服务端开发与安全](#/ai/mcp-deep)：协议原语、传输、鉴权与治理
- [工作流与 Agent 选型：编排模式与状态图](#/ai/agent-workflow)：何时用工作流、何时用 Agent
- [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep)：状态机、记忆与评测

## 面试追问

> [!QUESTION] 什么是 Agent？与工作流有什么区别？
> Agent 是由大模型根据目标自主决定调用哪些工具、调用几次的循环系统；工作流的步骤由代码预先编排，模型只在节点内工作。工作流可预测、便宜、易测试，Agent 灵活但不确定、成本高，应优先工作流，只在步骤不确定的开放任务里用 Agent。

> [!QUESTION] 函数调用的完整流程是怎样的？
> 请求携带工具定义，模型返回要调用的工具名和参数，应用侧校验并执行，把结果以 tool 消息追加到上下文，再次调用模型直到不再请求工具。模型只产生调用意图，真正执行与鉴权在你的代码里。

> [!QUESTION] 如何设计好一个供 Agent 使用的工具？
> 名称和描述清晰说明用途与边界，参数 Schema 严格并使用枚举，返回精简可读，错误信息能指导模型自修复；写操作幂等并需要确认，权限用会话身份在代码层校验，工具数量要精简。

> [!QUESTION] MCP 是什么？解决了什么问题？
> MCP 是连接 AI 应用与外部工具、数据的开放协议，采用 Host/Client/Server 架构和 JSON-RPC，服务端暴露 Tools、Resources、Prompts。它把 M×N 的集成变成 M+N：工具方实现一次 Server，各个支持 MCP 的应用都能使用。

> [!QUESTION] Agent 有哪些主要风险？怎么控制？
> 无限循环与成本失控、幻觉调用、越权、间接提示注入和不可逆操作。控制措施：最大步数与预算、严格校验工具与参数、工具内按用户身份鉴权、高风险操作人工确认、对外部内容视为不可信、沙箱与幂等设计、全程审计与评测回归。

> [!QUESTION] 单 Agent 与多 Agent 怎么选？
> 优先单 Agent 加高质量工具；当任务需要明显的职责或上下文隔离、并行处理或专业分工时再引入多 Agent。多 Agent 会增加成本、延迟和调试难度，需要结构化的信息传递和明确的终止条件。
