---
level: 深入
tags: [MCP, 工具协议, JSON-RPC, stdio, Streamable HTTP, OAuth, 工具设计, 安全, A2A, Spring AI]
summary: MCP（Model Context Protocol）深入：协议的角色与能力协商、三类原语（工具、资源、提示）和客户端能力（采样、根、征询）、传输方式与鉴权、Java 服务端开发思路、工具设计准则、安全威胁（工具投毒、混淆代理、令牌透传）与治理，以及与 A2A 等 Agent 协议的关系。
---

# MCP 深入：协议、服务端开发与安全

> [!ABSTRACT] 核心要点
> - MCP 把“**模型应用如何接入外部工具与数据**”标准化：以前每个应用×每个系统都要写一套适配（N×M），现在系统只需实现一次 **MCP Server**，任何支持 MCP 的客户端都能用（N+M）。
> - 架构是 **Host（应用）→ Client（连接器）→ Server（能力提供方）**，底层是 **JSON-RPC 2.0**，连接建立时做**能力协商**；传输常用 **stdio（本地子进程）** 与 **Streamable HTTP（远程服务）**。
> - 服务端暴露三类原语：**Tools（模型调用的动作）、Resources（应用/模型读取的上下文数据）、Prompts（用户触发的模板）**；客户端还可提供 **采样（Sampling）、根（Roots）、征询（Elicitation）** 等能力。
> - **工具设计比协议本身更决定效果**：粒度、命名、描述、参数 Schema、错误信息、返回体大小，都是给“模型”看的接口文档。
> - **安全是 MCP 的重点风险面**：工具描述投毒、提示注入经工具结果进入、混淆代理、令牌透传、过度授权、不可信第三方服务器。落地要**最小权限、可信来源、人在回路、审计、网关治理**。
> - 协议仍在演进，**具体版本、字段、鉴权细则请以官方规范为准**，本文讲的是稳定的设计思想与工程做法。

## 为什么需要 MCP

在 [Agent、工具调用与 MCP](#/ai/agent) 中介绍了工具调用（Function Calling）：应用把函数定义交给模型，模型决定调用，应用执行。问题在于：**每个应用都要自己写工具、自己对接各家系统**。

| 对比 | 自写工具调用 | MCP |
| --- | --- | --- |
| 复用 | 工具绑定在某个应用里 | 一个 Server 可被多个客户端（IDE、桌面助手、企业 Agent 平台）复用 |
| 接入成本 | 每个应用×每个系统都要适配 | 系统方实现一次，应用方实现一次客户端 |
| 发现 | 工具列表写死在代码 | 运行时**动态发现**（list）并可收到变更通知 |
| 生态 | 各自为政 | 开源/商业 Server 可直接接入 |
| 边界 | 工具与应用同进程、同权限 | Server 是独立进程/服务，可单独做鉴权、限流、审计 |

MCP 不替代工具调用：模型层面依然是工具调用，MCP 规定的是**应用与工具提供方之间**怎么对话。

## 架构与连接

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="MCP 架构：Host 应用内含多个 MCP Client，每个 Client 与一个 MCP Server 建立一对一连接，Server 访问本地文件、数据库、业务 API 等外部系统，连接上使用 JSON-RPC 并做能力协商">
<rect class="bg" x="20" y="20" width="300" height="260" rx="12"/>
<text class="th" x="170" y="42" text-anchor="middle">Host（AI 应用/IDE/Agent 平台）</text>
<rect class="b3" x="40" y="60" width="260" height="46" rx="8"/>
<text class="tb" x="170" y="83" text-anchor="middle" dominant-baseline="middle">LLM 与编排逻辑</text>
<rect class="b5" x="40" y="130" width="120" height="44" rx="8"/>
<text class="ts" x="100" y="152" text-anchor="middle" dominant-baseline="middle">MCP Client A</text>
<rect class="b5" x="180" y="130" width="120" height="44" rx="8"/>
<text class="ts" x="240" y="152" text-anchor="middle" dominant-baseline="middle">MCP Client B</text>
<rect class="b5" x="40" y="196" width="120" height="44" rx="8"/>
<text class="ts" x="100" y="218" text-anchor="middle" dominant-baseline="middle">MCP Client C</text>
<text class="ts" x="240" y="218" text-anchor="middle">每个 Client 对应</text>
<text class="ts" x="240" y="236" text-anchor="middle">一个 Server 连接</text>
<rect class="b1" x="440" y="30" width="170" height="70" rx="10"/>
<text class="tb" x="525" y="52" text-anchor="middle" dominant-baseline="middle">Server A（本地）</text>
<text class="ts" x="525" y="74" text-anchor="middle">stdio 子进程</text>
<text class="ts" x="525" y="90" text-anchor="middle">文件系统·Git</text>
<rect class="b1" x="440" y="120" width="170" height="70" rx="10"/>
<text class="tb" x="525" y="142" text-anchor="middle" dominant-baseline="middle">Server B（远程）</text>
<text class="ts" x="525" y="164" text-anchor="middle">Streamable HTTP</text>
<text class="ts" x="525" y="180" text-anchor="middle">工单·CRM</text>
<rect class="b1" x="440" y="210" width="170" height="70" rx="10"/>
<text class="tb" x="525" y="232" text-anchor="middle" dominant-baseline="middle">Server C（远程）</text>
<text class="ts" x="525" y="254" text-anchor="middle">Streamable HTTP</text>
<text class="ts" x="525" y="270" text-anchor="middle">数据库·内部 API</text>
<rect class="b2" x="650" y="30" width="90" height="250" rx="10"/>
<text class="tb" x="695" y="140" text-anchor="middle" dominant-baseline="middle">外部系统</text>
<text class="ts" x="695" y="162" text-anchor="middle">文件</text>
<text class="ts" x="695" y="180" text-anchor="middle">数据库</text>
<text class="ts" x="695" y="198" text-anchor="middle">业务服务</text>
<line class="l" x1="160" y1="152" x2="440" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="152" x2="440" y2="155" marker-end="url(#arr)"/>
<line class="l" x1="160" y1="218" x2="440" y2="245" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="65" x2="650" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="155" x2="650" y2="155" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="245" x2="650" y2="245" marker-end="url(#arr)"/>
<text class="ta" x="372" y="120" text-anchor="middle">JSON-RPC 2.0</text>
</svg>
<figcaption>图 1：MCP 的 Host / Client / Server 结构</figcaption>
</figure>

### 连接生命周期

1. **初始化**：客户端发 `initialize`，声明协议版本与自身能力（如是否支持采样、征询）；服务端回复版本与自身能力（是否提供 tools/resources/prompts、是否支持变更通知）；双方**取交集**后确认；
2. **正常交互**：请求/响应（带 id）与通知（无 id），如 `tools/list`、`tools/call`、`resources/read`；
3. **变更通知**：服务端工具列表变化时发 `list_changed` 通知，客户端重新拉取；
4. **关闭**：断开连接、清理会话。

能力协商的意义：**不同版本、不同实现可以共存**，不支持的能力会被优雅地忽略，而不是整体失败。

### 传输方式

| 传输 | 形态 | 适用 | 注意 |
| --- | --- | --- | --- |
| **stdio** | 客户端启动 Server 子进程，通过标准输入输出交换消息 | 本地工具（文件、Git、本机命令） | Server 日志**不能写到标准输出**（会污染协议流），应写标准错误；进程随客户端生命周期；以**本机用户权限**运行 |
| **Streamable HTTP** | Server 是 HTTP 服务，一个端点处理 POST 请求，可选用 SSE 流式返回/推送 | 远程、多租户、企业服务 | 需要**鉴权、TLS、Origin 校验**；有状态会话要考虑多实例路由；早期的“HTTP+SSE 双端点”方案已被其取代，旧客户端需兼容 |

## 三类服务端原语

| 原语 | 谁来决定使用 | 含义 | 例子 |
| --- | --- | --- | --- |
| **Tools** | **模型**自主决定调用 | 可执行的动作，可有副作用 | 查询订单、创建工单、执行 SQL（只读）、发送通知 |
| **Resources** | **应用/用户**选择加入上下文（也可被模型读取） | 以 URI 标识的**只读数据** | 文件内容、数据库表结构、日志片段、文档 |
| **Prompts** | **用户**显式触发 | 预置的提示词模板（可带参数） | “代码评审”“生成周报”这类斜杠命令 |

选择时的经验：**会产生动作或需要参数计算的做成 Tool**；**稳定的参考资料做成 Resource**（支持订阅变更）；**固定工作流的入口做成 Prompt**。很多实现里为了兼容，会把只读资料也包装成 Tool——客户端对 Resources 的支持参差不齐。

### 客户端提供的能力

| 能力 | 作用 | 风险与要求 |
| --- | --- | --- |
| **采样 Sampling** | Server 请求客户端用**用户的模型**做一次补全（Server 自己不需要模型密钥） | 必须由用户/客户端**审批**，限制内容与次数，防止 Server 借你的额度或诱导模型 |
| **根 Roots** | 客户端告诉 Server 可访问的**目录/资源范围** | 只是“建议边界”，真正的访问控制要在 Server 端实施 |
| **征询 Elicitation** | Server 在执行中向**用户**索取缺失信息或确认 | 不应用于索要密码、密钥等敏感信息；UI 要让用户看清是谁在问什么 |

## 用 Java 开发 MCP Server

Java 生态有官方的 **MCP Java SDK**，Spring AI 提供了基于它的 **MCP Server/Client Starter**，用注解声明工具即可。下面是思路性示例（具体依赖名、配置项与注解以所用版本文档为准）：

```java
@Service
public class OrderTools {

    private final OrderService orderService;

    // 只读工具：描述要写清楚“什么时候该用、返回什么”
    @Tool(description = "按订单号查询订单状态、金额与物流摘要。"
            + "仅当用户提供了订单号时使用；订单号格式为 O 开头的 12 位数字。")
    public OrderBrief queryOrder(
            @ToolParam(description = "订单号，例如 O202401150001") String orderNo) {
        // 1. 从请求上下文取当前用户身份（而不是模型传来的参数）
        // 2. 校验该用户是否有权查看该订单
        return orderService.findBrief(currentUser(), orderNo);
    }

    // 写操作：不要直接执行，先生成“待确认动作”，由人在客户端确认后再提交
    @Tool(description = "为订单发起退款申请（不会立即退款，需用户确认）。")
    public PendingAction requestRefund(String orderNo, String reason) {
        return refundService.createPending(currentUser(), orderNo, reason);
    }
}
```

要点：

- **身份来自连接/令牌，不来自模型参数**：用户 ID、租户 ID 由服务端从鉴权信息得到；模型传的“用户 ID”不可信；
- **工具内部再次鉴权**：每次调用都检查当前用户对目标资源的权限，不依赖客户端已经过滤；
- **输入校验**：Schema 之外还要校验业务约束（格式、范围、白名单），拒绝路径穿越与注入（SQL、命令行）；
- **输出裁剪**：返回结构化的精简字段，大结果分页或摘要，避免把整个表塞进模型上下文；
- **无状态优先**：Server 尽量无状态，便于水平扩展与网关路由；
- **幂等与超时**：写类工具支持幂等键；设置超时与并发限制，防止模型循环调用拖垮后端。

### 从已有服务生成 MCP Server

不必重写业务：给已有的 REST/gRPC 服务加一层**适配**——把“稳定、语义清晰”的少数接口包装成工具，而不是把几百个接口原样暴露。直接全量暴露 OpenAPI 往往效果很差：工具太多、命名面向开发者而非任务、参数过于底层。

## 工具设计准则

模型看到的是**名字 + 描述 + 参数 Schema**，这就是它的全部“文档”。

| 准则 | 说明 |
| --- | --- |
| **面向任务而非接口** | `查询订单并汇总物流` 优于拆成 `getOrder`、`getShipment`、`getTrack` 三个；一个工具完成一个有意义的用户意图，减少往返 |
| **粒度适中** | 太细→模型要多步编排、易出错；太粗→参数复杂、难以复用、权限难控制 |
| **命名清晰** | 动词开头、语义明确、互不重叠；名字相近的工具会让模型选错 |
| **描述写“何时用/何时不用”** | 写适用场景、前置条件、返回内容与相近工具的区别；这是影响调用准确率的第一要素 |
| **参数简单、有约束** | 用枚举、范围、格式说明；少用自由文本；给**示例值**；必选与可选清晰 |
| **控制工具数量** | 一次暴露的工具越多，选择越难、上下文越大；按场景/角色**动态启用子集**，或做工具检索（先检索再加载工具定义） |
| **错误可行动** | 失败时返回**告诉模型下一步怎么做**的信息：“订单号格式错误，应为 O 开头 12 位”，而不是“500 Internal Error” |
| **结果精简** | 只返回回答需要的字段，剔除内部 ID、冗长元数据；大结果给摘要+“如需更多请调用 xxx” |
| **副作用显式** | 读/写/危险操作在名称与描述里体现；写操作建议“预览→确认→执行”两阶段 |
| **可测试** | 为每个工具准备评测样例（输入意图→应调用的工具与参数），见 [评测体系实战](#/ai/eval) |

## 安全与治理

MCP 把“能做事的接口”交到模型手里，也扩大了攻击面。

<figure class="fig">
<svg viewBox="0 0 760 310" class="dg" role="img" aria-label="MCP 主要威胁与对策：工具描述投毒、工具结果中的提示注入、混淆代理与令牌透传、过度授权、不可信或被替换的服务器、本地服务器的命令执行；对应对策包括最小权限、人在回路、来源签名与审核、网关治理、沙箱和审计">
<rect class="b4" x="20" y="14" width="350" height="52" rx="8"/>
<text class="tb" x="195" y="32" text-anchor="middle" dominant-baseline="middle">工具描述投毒 / “地毯式更换”</text>
<text class="ts" x="195" y="52" text-anchor="middle">恶意描述诱导模型泄露数据；服务器上线后偷偷改描述</text>
<rect class="b2" x="390" y="14" width="350" height="52" rx="8"/>
<text class="tb" x="565" y="32" text-anchor="middle" dominant-baseline="middle">对策：固定版本·变更审核·描述哈希校验</text>
<text class="ts" x="565" y="52" text-anchor="middle">只接入可信来源；工具列表变化需重新审批</text>
<rect class="b4" x="20" y="76" width="350" height="52" rx="8"/>
<text class="tb" x="195" y="94" text-anchor="middle" dominant-baseline="middle">工具结果中的提示注入</text>
<text class="ts" x="195" y="114" text-anchor="middle">网页/工单/邮件里的“指令”劫持 Agent 调用其他工具</text>
<rect class="b2" x="390" y="76" width="350" height="52" rx="8"/>
<text class="tb" x="565" y="94" text-anchor="middle" dominant-baseline="middle">对策：结果当数据·最小权限·写操作确认</text>
<text class="ts" x="565" y="114" text-anchor="middle">读外部内容与写敏感系统的工具不同时开放（致命三要素）</text>
<rect class="b4" x="20" y="138" width="350" height="52" rx="8"/>
<text class="tb" x="195" y="156" text-anchor="middle" dominant-baseline="middle">混淆代理 / 令牌透传</text>
<text class="ts" x="195" y="176" text-anchor="middle">Server 用高权限代用户操作，或把用户令牌转给下游</text>
<rect class="b2" x="390" y="138" width="350" height="52" rx="8"/>
<text class="tb" x="565" y="156" text-anchor="middle" dominant-baseline="middle">对策：校验令牌受众·下游单独换令牌</text>
<text class="ts" x="565" y="176" text-anchor="middle">按用户身份授权，禁止把收到的令牌原样转发</text>
<rect class="b4" x="20" y="200" width="350" height="52" rx="8"/>
<text class="tb" x="195" y="218" text-anchor="middle" dominant-baseline="middle">过度授权 / 范围膨胀</text>
<text class="ts" x="195" y="238" text-anchor="middle">一次授予全部权限；工具能读写远超需要的数据</text>
<rect class="b2" x="390" y="200" width="350" height="52" rx="8"/>
<text class="tb" x="565" y="218" text-anchor="middle" dominant-baseline="middle">对策：细粒度 scope·按需授权·短期令牌</text>
<text class="ts" x="565" y="238" text-anchor="middle">只读与读写工具分开，敏感工具单独审批</text>
<rect class="bg" x="20" y="262" width="720" height="38" rx="8"/>
<text class="ts" x="380" y="286" text-anchor="middle">本地 stdio Server 等于在用户机器上执行代码：只运行可信来源、最小文件权限、沙箱/容器隔离，禁止一键安装未知命令</text>
</svg>
<figcaption>图 2：MCP 的主要威胁面与对策</figcaption>
</figure>

### 远程 Server 的鉴权

- 远程 MCP 通常采用 **OAuth 2.x** 体系：客户端引导用户登录授权，获得**访问令牌**调用 Server；Server 作为资源服务器**校验令牌的受众（audience）与 scope**；规范对授权发现、动态客户端注册等有具体要求，请以当前版本为准；
- **令牌要短期、最小范围、可撤销**；绝不在日志或工具结果里回显令牌；
- 区分**用户身份**与**服务身份**：访问用户数据用用户委托令牌；访问公共数据用服务账号；不要用一个超级账号代所有人操作；
- 多租户场景在 Server 里做**租户隔离**，令牌里的租户信息在服务端校验，不信任模型传参。

### 治理：MCP 网关与注册中心

企业场景里不应让每个员工、每个 Agent 随意连接任意 Server。常见做法是在中间加一层**MCP 网关**，思路与 [API 网关](#/design/case-gateway) 一致：

| 能力 | 说明 |
| --- | --- |
| **注册与准入** | 只有审核过的 Server（版本、描述哈希、负责人）才能在目录里出现 |
| **统一鉴权** | 对接公司 SSO，按用户/角色决定可见和可调的工具 |
| **策略** | 工具白名单、参数校验、敏感操作强制确认、速率与并发限制、预算 |
| **审计** | 记录谁在何时通过哪个 Agent 调用了哪个工具、参数摘要与结果状态，满足合规追溯 |
| **数据防泄露** | 对入参出参做敏感信息检测与脱敏 |
| **可观测** | 延迟、错误率、调用量、Token 占用；与链路追踪串联，见 [链路追踪、日志与告警](#/infra/obs-trace) |
| **版本与灰度** | 工具版本管理、灰度上线与回滚 |

## 与其他协议和机制的关系

| 名称 | 关注点 | 与 MCP 的关系 |
| --- | --- | --- |
| **Function Calling / Tool Use** | 模型 API 层面的工具调用格式 | MCP 的工具最终也会转成它交给模型 |
| **MCP** | **应用 ↔ 工具/数据**的接入标准 | 垂直方向：Agent 如何使用工具 |
| **A2A（Agent2Agent）等** | **Agent ↔ Agent** 的协作与任务委托（发现 Agent 能力卡片、任务生命周期、消息与产物） | 水平方向：Agent 之间如何协作；与 MCP 互补而非替代 |
| **Agent Skills 一类的技能包** | 把“指令 + 脚本 + 资源”按需加载给 Agent，渐进披露 | 偏**知识与流程的打包**；需要访问外部系统时仍可调用 MCP 工具 |
| **OpenAPI** | 给开发者看的 HTTP 接口描述 | 可作为生成 MCP 工具的原料，但**不能原样当作任务级工具** |

经验：**先把内部能力做成少量任务级的 MCP 工具**，再考虑多 Agent 之间的协议；协议很多，但真正决定效果的仍是工具质量、权限设计与评测。

## 排障与运行要点

| 现象 | 可能原因 | 排查 |
| --- | --- | --- |
| 模型不调用该工具 | 描述不清、与其他工具重叠、工具数量过多 | 看工具选择轨迹，优化描述，减少暴露数量 |
| 总是传错参数 | Schema 太自由、缺示例、字段名晦涩 | 加枚举与示例、简化参数、返回可行动的错误 |
| stdio Server 启动后客户端连接失败 | 日志写到了 stdout、依赖缺失、环境变量不同 | 日志改写 stderr；检查客户端启动命令与环境 |
| 远程 Server 偶发超时 | 冷启动、下游慢、网关超时不匹配 | 逐跳超时对齐，长任务改异步（返回任务 ID，用另一个工具查进度） |
| 工具列表更新后客户端没变化 | 未发送/未处理 list_changed | 检查能力协商与通知处理，必要时重连 |
| 多实例下会话丢失 | 有状态会话落在不同实例 | 会话粘性或外置会话状态，或改为无状态 |
| 返回结果撑爆上下文 | 工具返回过大 | 分页、摘要、字段裁剪、返回资源链接而非内容 |

## 相关阅读

- [Agent、工具调用与 MCP](#/ai/agent)：Agent 基础与工具调用
- [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep)：工具数量与上下文预算
- [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai)：MCP Client/Server 的 Java 集成
- [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)：令牌、授权码流程与 scope 设计

## 面试追问

> [!QUESTION] MCP 解决了什么问题？和 Function Calling 的区别？
> 解决工具与数据接入的碎片化：系统方实现一次 Server，任何支持 MCP 的客户端都能复用，并支持动态发现与变更通知。Function Calling 是模型 API 层面“模型如何表达要调用函数”，MCP 规定应用与工具提供方之间的通信标准，两者互补，MCP 的工具最终仍会转成工具调用交给模型。

> [!QUESTION] MCP 的三类原语分别是什么，怎么选？
> Tools 是模型自主调用的动作，Resources 是由应用或用户选择放入上下文的只读数据，Prompts 是用户显式触发的模板。有副作用或需要计算的做成 Tool，稳定参考资料做成 Resource，固定工作流入口做成 Prompt；实际常因客户端对 Resources 支持不一而把只读数据也包成 Tool。

> [!QUESTION] stdio 和 Streamable HTTP 传输怎么选？
> 本地工具用 stdio：客户端起子进程、延迟低、天然随用户权限，但日志不能写标准输出。远程、多用户、企业服务用 Streamable HTTP，需要 TLS、鉴权、Origin 校验，并考虑多实例下的会话处理，最好做成无状态。

> [!QUESTION] 怎么设计好的 MCP 工具？
> 面向任务而不是接口，粒度适中，命名清晰互不重叠；描述写明何时用与何时不用；参数简单带枚举和示例；控制同时暴露的工具数量；错误信息可行动；返回精简；副作用显式，写操作预览确认；每个工具有评测样例验证调用准确率。

> [!QUESTION] MCP 有哪些安全风险？怎么防？
> 工具描述投毒与上线后偷换、工具结果里的提示注入、混淆代理与令牌透传、过度授权、不可信或本地 Server 执行恶意代码。对策是只接入可信并固定版本的来源，描述变更重新审批；外部内容当数据，读外部内容与写敏感系统的能力不同时开放；校验令牌受众、下游单独换令牌；细粒度短期授权；高风险操作人工确认；通过网关做准入、策略与审计。

> [!QUESTION] MCP 与 A2A 有什么区别？
> MCP 解决 Agent 如何使用工具和数据，是应用到能力提供方的垂直接入；A2A 一类协议解决 Agent 之间如何发现、委托任务与协作，是水平方向。两者互补，实际落地应先把内部能力做成少量高质量的任务级工具，再考虑 Agent 间协作。
