---
level: 深入
tags: [API 设计, REST, gRPC, GraphQL, 版本管理, 向后兼容, 分页, 错误模型, 幂等, Webhook, 开放平台, 签名, OpenAPI, 弃用]
summary: API 设计与演进实践：风格选型（REST/gRPC/GraphQL/事件）、REST 资源建模与方法语义、分页过滤排序、批量与异步长任务、并发控制（ETag）、统一错误模型、版本与兼容性规则、弃用流程、认证与限流、幂等、开放平台的签名与 Webhook、文档与契约测试、性能与缓存，以及常见反模式。
---

# API 设计与演进：REST、兼容性与开放平台

> [!ABSTRACT] 核心要点
> - **API 是系统最难改的部分**：一旦被客户端依赖，**改动代价与客户端数量成正比**。所以好的 API 设计优先考虑的是**稳定、可演进、可预测**，其次才是“优雅”。**对外 API 近似是永久承诺**。
> - **按场景选风格**：**对外/开放平台、浏览器/移动端 → REST/HTTP+JSON**（通用、生态完善）；**内部高频服务间调用 → gRPC/Protobuf**（强类型、性能好、流式）；**前端聚合与灵活字段 → GraphQL（需承担复杂度）**；**异步通知 → Webhook/事件**。不要一种风格走天下。
> - **REST 设计的要点**：用**名词资源**建模，用 **HTTP 方法与状态码**表达语义（并遵守**幂等性与安全性**）；**分页用游标**而不是大 offset；**错误有统一结构**；**长任务异步化（202 + 状态资源）**；**并发更新用 ETag/版本号**；**所有写操作支持幂等键**。
> - **兼容性是第一原则**：**只增不改不删**（新增可选字段、新增接口、放宽约束）是兼容的；**删字段、改类型/语义、收紧约束、改默认值**是破坏性的。**客户端要“宽容地读”（忽略未知字段）**，服务端要“保守地发”。破坏性变更走**新版本 + 弃用期 + 迁移指南**。
> - **开放平台**需要额外的：**身份与签名（防篡改/防重放）、限流配额、Webhook（重试/签名/幂等）、SDK、沙箱环境、文档与变更通知**。
> - **契约先行 + 自动化**：用 **OpenAPI/Protobuf** 描述契约，**契约测试**与**兼容性检查进 CI**；文档与代码同源，避免“文档说一套，实际一套”。

## 风格选型

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="API 风格对比：REST 基于 HTTP 与 JSON，资源导向，通用易缓存，适合对外开放和浏览器；gRPC 基于 HTTP/2 与 Protobuf，强类型高性能支持流式，适合内部服务间；GraphQL 由客户端指定所需字段，适合多端聚合与灵活查询，但缓存与复杂度挑战大；Webhook 与事件用于异步通知；各自适用场景与取舍">
<rect class="b3" x="20" y="14" width="170" height="190" rx="10"/>
<text class="tb" x="105" y="34" text-anchor="middle" dominant-baseline="middle">REST（HTTP+JSON）</text>
<text class="ts" x="105" y="62" text-anchor="middle">资源导向，通用</text>
<text class="ts" x="105" y="82" text-anchor="middle">易调试、可缓存</text>
<text class="ts" x="105" y="102" text-anchor="middle">浏览器/移动原生支持</text>
<text class="ts" x="105" y="130" text-anchor="middle">－ 过取/欠取字段</text>
<text class="ts" x="105" y="150" text-anchor="middle">－ 多请求聚合</text>
<text class="ts" x="105" y="182" text-anchor="middle">对外开放、通用首选</text>
<rect class="b5" x="200" y="14" width="170" height="190" rx="10"/>
<text class="tb" x="285" y="34" text-anchor="middle" dominant-baseline="middle">gRPC（Protobuf）</text>
<text class="ts" x="285" y="62" text-anchor="middle">强类型，代码生成</text>
<text class="ts" x="285" y="82" text-anchor="middle">二进制，性能高</text>
<text class="ts" x="285" y="102" text-anchor="middle">四种流式调用</text>
<text class="ts" x="285" y="130" text-anchor="middle">－ 浏览器需 gRPC-Web</text>
<text class="ts" x="285" y="150" text-anchor="middle">－ 调试与可读性较差</text>
<text class="ts" x="285" y="182" text-anchor="middle">内部服务间、低延迟</text>
<rect class="b1" x="380" y="14" width="170" height="190" rx="10"/>
<text class="tb" x="465" y="34" text-anchor="middle" dominant-baseline="middle">GraphQL</text>
<text class="ts" x="465" y="62" text-anchor="middle">客户端按需取字段</text>
<text class="ts" x="465" y="82" text-anchor="middle">一次请求聚合多资源</text>
<text class="ts" x="465" y="102" text-anchor="middle">强类型 Schema</text>
<text class="ts" x="465" y="130" text-anchor="middle">－ 缓存/限流/鉴权复杂</text>
<text class="ts" x="465" y="150" text-anchor="middle">－ N+1 与查询成本控制</text>
<text class="ts" x="465" y="182" text-anchor="middle">多端聚合、BFF 层</text>
<rect class="b4" x="560" y="14" width="180" height="190" rx="10"/>
<text class="tb" x="650" y="34" text-anchor="middle" dominant-baseline="middle">Webhook / 事件</text>
<text class="ts" x="650" y="62" text-anchor="middle">服务端主动推送通知</text>
<text class="ts" x="650" y="82" text-anchor="middle">解耦、实时</text>
<text class="ts" x="650" y="102" text-anchor="middle">至少一次，需幂等</text>
<text class="ts" x="650" y="130" text-anchor="middle">－ 重试/顺序/签名</text>
<text class="ts" x="650" y="150" text-anchor="middle">－ 接收方可用性</text>
<text class="ts" x="650" y="182" text-anchor="middle">异步通知、集成</text>
<rect class="bg" x="20" y="222" width="720" height="98" rx="8"/>
<text class="ts" x="380" y="244" text-anchor="middle">常见组合：对外 REST（经网关）+ 内部 gRPC + 前端 BFF（可用 GraphQL）+ Webhook/事件通知；实时双向用 WebSocket/SSE</text>
<text class="ts" x="380" y="266" text-anchor="middle">选择依据：消费者是谁（外部开发者/内部服务/自家前端）、性能与类型安全要求、团队技能、生态与工具、缓存与可观测需求</text>
<text class="ts" x="380" y="288" text-anchor="middle">gRPC 与事件设计另有专文</text>
<text class="ts" x="380" y="308" text-anchor="middle">内部与外部 API 应区别对待：内部可更快演进，对外必须长期兼容</text>
</svg>
<figcaption>图 1：API 风格的适用场景与取舍</figcaption>
</figure>

## REST 设计

### 资源建模与 URL

| 原则 | 示例 | 反例 |
| --- | --- | --- |
| **用名词复数表示资源集合** | `GET /orders`、`GET /orders/{id}` | `/getOrderList`、`/queryOrder` |
| **层级表达从属，不超过两三层** | `/orders/{id}/items` | `/users/1/orders/2/items/3/skus/4`（过深，改为 `/items/{id}` 或带过滤） |
| **用查询参数做过滤/排序/分页/字段选择** | `GET /orders?status=PAID&sort=-created_at&limit=20` | 把过滤条件放路径里 |
| **不在 URL 中放动词**，**无法资源化的操作**用子资源或自定义动作 | `POST /orders/{id}/cancel`、`POST /payments/{id}:refund` | `/cancelOrder?id=` |
| **一致的命名与风格** | 全部小写 + 连字符/或蛇形；字段统一驼峰或蛇形，**全站一致** | 混用 |
| **标识符不透明且稳定** | 对外 ID 用不可猜测的字符串（ULID/加密 ID），不暴露自增主键 | 暴露自增 ID（可枚举、暴露规模） |

### HTTP 方法语义与幂等

| 方法 | 语义 | 安全 | 幂等 | 典型用法 |
| --- | --- | --- | --- | --- |
| **GET** | 读取 | ✅ | ✅ | 查询，**不应有副作用** |
| **POST** | 创建/执行动作 | ❌ | ❌（需幂等键） | 创建资源、触发操作 |
| **PUT** | **全量替换** | ❌ | ✅ | 整体更新（客户端提供完整资源） |
| **PATCH** | **部分更新** | ❌ | 视实现（用“设为某值”则幂等） | 更新部分字段（JSON Merge Patch / JSON Patch） |
| **DELETE** | 删除 | ❌ | ✅ | 删除资源（重复删除返回 204/404 均可，约定一致） |

非幂等的 `POST` 要支持**幂等键**（`Idempotency-Key`），详见 [幂等设计与重试](#/distributed/idempotent)。**GET 不要修改数据**（爬虫、预取、重试都会触发）。

### 状态码

| 范围 | 常用 | 说明 |
| --- | --- | --- |
| **2xx** | 200 OK、201 Created（带 `Location`）、202 Accepted（异步受理）、204 No Content | 成功；创建返回 201 与新资源地址 |
| **3xx** | 301/302、304 Not Modified（缓存） | 重定向与条件请求 |
| **4xx** | 400 参数错误、401 未认证、403 无权限、404 不存在、405 方法不允许、409 冲突（状态/版本冲突、幂等键处理中）、410 已永久删除、412 前置条件失败（ETag 不匹配）、415、422 语义错误（校验失败）、**429 限流** | **客户端的问题**，不应重试（429/409 例外） |
| **5xx** | 500、502、503（带 `Retry-After`）、504 | 服务端问题，客户端可按幂等性重试 |

**不要所有错误都返回 200 + 业务码**（这样监控、网关、重试、缓存都失效）；**业务错误用 4xx + 错误体里的业务码**。

### 分页、过滤与排序

| 方式 | 做法 | 优缺点 |
| --- | --- | --- |
| **Offset/Limit**（`?page=3&size=20`） | 跳过前 N 条 | 简单、可跳页；**深分页慢**（数据库扫描 offset 行），**翻页期间数据变动会重复/遗漏** |
| **游标（Cursor/Keyset）**（`?after=<cursor>&limit=20`） | 以上一页最后一条的**排序键**为起点继续取：`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20` | **性能稳定**（走索引）、**一致性好**；不能随意跳页；游标是**不透明字符串**（Base64 编码排序键，客户端不解析） |
| **时间窗口/ID 范围** | `?since_id=`、`?updated_after=` | 增量同步场景 |

响应示例（游标）：

```json
{
  "data": [ { "id": "ord_01H...", "status": "PAID" } ],
  "page": { "next_cursor": "eyJ0IjoxNzAwMDAwMDAwLCJpIjoxMjN9", "has_more": true }
}
```

要点：

- **排序要稳定且唯一**：排序键必须加唯一字段（如 id）作兜底，否则分页重复/遗漏；
- **限制最大 `limit`**（如 100），防止大查询；
- **总数 `total` 谨慎提供**（`COUNT(*)` 在大表上很贵），或提供近似值/按需；
- **过滤字段白名单**，避免任意字段过滤造成慢查询；
- **字段选择**（`?fields=id,status`）减少传输；关联资源展开（`?expand=items`）要限制深度，防止 N+1 与响应膨胀。

### 批量与异步长任务

- **批量操作**：`POST /orders:batchGet`、`POST /orders:batchCreate`；明确**部分失败语义**（每项独立返回状态，或全成功/全失败事务）；限制批量大小；幂等；
- **长任务**（导出、批处理、转码）**不要同步阻塞**：`POST /exports` → **202 Accepted** + `Location: /exports/{id}`；客户端轮询 `GET /exports/{id}`（状态：pending/running/succeeded/failed，含进度与结果链接）或通过 **Webhook/回调**通知；结果文件用**预签名 URL**下载，见 [对象存储与文件服务](#/design/case-objectstore)；任务也要**可取消、可幂等、有过期清理**。

### 并发更新与条件请求

- **乐观并发控制**：资源带 **ETag/版本号**；更新必须带 `If-Match: <etag>`，版本不匹配返回 **412 Precondition Failed**（或 409），防止**丢失更新**（两个客户端基于旧版本覆盖彼此）；
- **缓存**：`ETag` + `If-None-Match` → **304**；`Cache-Control`、`Last-Modified` 合理设置，CDN/浏览器缓存可减负；
- **幂等 PUT**：整体替换的重复请求结果一致。

### 统一错误模型

采用统一的错误结构（可遵循 **RFC 7807 Problem Details**）：

```json
{
  "type": "https://api.example.com/errors/insufficient-balance",
  "title": "Insufficient balance",
  "status": 422,
  "code": "ORDER.INSUFFICIENT_BALANCE",
  "detail": "账户余额不足，需要 100.00，当前 20.00",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [ { "field": "amount", "message": "must be <= balance" } ]
}
```

| 要点 | 说明 |
| --- | --- |
| **机器可读的错误码**（`code`） | 稳定、有文档；客户端据此分支处理，**不要让客户端解析 message 文本** |
| **人类可读的消息** | 国际化；不泄露内部细节（堆栈、SQL、内部地址） |
| **`trace_id`** | 客户端报错时携带，便于服务端用链路追踪定位，见 [微服务可观测](#/spring/cloud-observability) |
| **字段级校验错误** | 一次返回所有字段错误，减少往返 |
| **可重试标记** | 是否可重试、`Retry-After` |
| **与状态码一致** | 400/422 客户端错；5xx 服务端错 |

## 版本管理与兼容性

### 兼容与不兼容的变更

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="兼容性规则：向后兼容的变更包括新增接口、新增可选请求字段、新增响应字段、放宽校验、新增枚举值（要求客户端宽容）；破坏性变更包括删除或重命名字段、改变字段类型或语义、收紧校验、改变默认值、改变错误码含义、改变幂等性或副作用；客户端应忽略未知字段和未知枚举值，服务端新增必填请求字段属于破坏性变更">
<rect class="b2" x="20" y="14" width="350" height="190" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">向后兼容（可直接发布）</text>
<text class="ts" x="195" y="62" text-anchor="middle">新增接口/资源</text>
<text class="ts" x="195" y="84" text-anchor="middle">请求新增可选字段（有默认值）</text>
<text class="ts" x="195" y="106" text-anchor="middle">响应新增字段（客户端须忽略未知字段）</text>
<text class="ts" x="195" y="128" text-anchor="middle">放宽校验、放宽长度/取值范围</text>
<text class="ts" x="195" y="150" text-anchor="middle">新增错误码细分（保持原大类）</text>
<text class="ts" x="195" y="172" text-anchor="middle">新增枚举值（风险：客户端须兜底处理）</text>
<text class="ts" x="195" y="194" text-anchor="middle">性能优化、修复缺陷（不改变契约）</text>
<rect class="b4" x="390" y="14" width="350" height="190" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">破坏性（需要新版本）</text>
<text class="ts" x="565" y="62" text-anchor="middle">删除/重命名字段或接口</text>
<text class="ts" x="565" y="84" text-anchor="middle">改字段类型、单位、含义、格式</text>
<text class="ts" x="565" y="106" text-anchor="middle">请求新增必填字段</text>
<text class="ts" x="565" y="128" text-anchor="middle">收紧校验、缩小取值范围</text>
<text class="ts" x="565" y="150" text-anchor="middle">改默认值、改排序/分页行为</text>
<text class="ts" x="565" y="172" text-anchor="middle">改变幂等性/副作用/权限要求</text>
<text class="ts" x="565" y="194" text-anchor="middle">改变错误码含义或状态码</text>
<rect class="bg" x="20" y="220" width="720" height="100" rx="8"/>
<text class="ts" x="380" y="242" text-anchor="middle">宽容读原则（Postel）：客户端忽略未知字段与未知枚举值（给出合理默认），服务端不依赖客户端传递“无关”字段</text>
<text class="ts" x="380" y="264" text-anchor="middle">字段命名与类型一旦发布就不改：金额用最小单位整数（分）或字符串 decimal，不用浮点；时间用 ISO 8601（含时区）或时间戳统一</text>
<text class="ts" x="380" y="286" text-anchor="middle">枚举新增要在文档中声明“可能新增”，客户端必须有 default 分支；布尔值尽量避免后续要扩展成多态的场景</text>
<text class="ts" x="380" y="308" text-anchor="middle">Protobuf/gRPC 的兼容规则（字段编号不可复用等）、事件 Schema 的兼容</text>
</svg>
<figcaption>图 2：向后兼容与破坏性变更</figcaption>
</figure>

### 版本方案

| 方式 | 示例 | 评价 |
| --- | --- | --- |
| **URL 路径** | `/v1/orders` | **最直观、易路由/缓存/文档化**，对外最常用；版本升级时整套接口并存 |
| **请求头** | `Accept: application/vnd.example.v2+json` 或 `X-API-Version: 2` | URL 更干净；调试不如路径直观，缓存要 `Vary` |
| **查询参数** | `?version=2` | 简单但不优雅，不推荐 |
| **日期版本（按时间滚动）** | `Stripe-Version: 2024-06-20` | 客户端固定在某日期版本，平台长期维护兼容层；工程量大 |
| **“无版本 + 持续兼容”** | 永不破坏，只加不改 | 理想但需要强约束，适合小范围/内部 |

建议：**对外 API 用主版本号放路径（v1、v2），主版本内只做兼容变更**；破坏性变更才发新主版本，且**新旧并存一个弃用期**。**主版本数量要克制**（维护成本随版本数增长）。

### 弃用与下线流程

<figure class="fig">
<svg viewBox="0 0 760 280" class="dg" role="img" aria-label="API 弃用流程：公告新版本与迁移指南，标记旧版本为弃用并在响应头加 Deprecation 和 Sunset 日期，监控旧版本调用方并主动联系，提供迁移工具和兼容层，到下线日期前多次提醒，先灰度限流再关闭，保留回退窗口，最终下线">
<rect class="b3" x="20" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">① 发布新版</text>
<text class="ts" x="75" y="84" text-anchor="middle">迁移指南</text>
<rect class="b5" x="145" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">② 标记弃用</text>
<text class="ts" x="200" y="84" text-anchor="middle">Deprecation 头</text>
<rect class="b1" x="270" y="40" width="120" height="64" rx="8"/>
<text class="tb" x="330" y="62" text-anchor="middle" dominant-baseline="middle">③ 监控调用方</text>
<text class="ts" x="330" y="84" text-anchor="middle">谁还在用旧版</text>
<rect class="b4" x="405" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="460" y="62" text-anchor="middle" dominant-baseline="middle">④ 主动联系</text>
<text class="ts" x="460" y="84" text-anchor="middle">通知·协助迁移</text>
<rect class="b2" x="530" y="40" width="100" height="64" rx="8"/>
<text class="tb" x="580" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 灰度关闭</text>
<text class="ts" x="580" y="84" text-anchor="middle">限流→关闭</text>
<rect class="b3" x="645" y="40" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="62" text-anchor="middle" dominant-baseline="middle">⑥ 下线</text>
<text class="ts" x="692" y="84" text-anchor="middle">保留回退窗口</text>
<line class="l" x1="130" y1="72" x2="145" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="72" x2="270" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="72" x2="405" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="515" y1="72" x2="530" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="72" x2="645" y2="72" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="720" height="146" rx="8"/>
<text class="th" x="32" y="144">要点</text>
<text class="ts" x="380" y="170" text-anchor="middle">弃用期要足够长（对外通常 6~12 个月以上，视客户类型），在文档、邮件、控制台、响应头（Deprecation、Sunset、Link）多渠道告知</text>
<text class="ts" x="380" y="192" text-anchor="middle">用访问日志按调用方（API Key/应用）统计旧版本流量，定位还没迁移的客户，针对性联系；内部 API 可直接在代码仓库搜索依赖</text>
<text class="ts" x="380" y="214" text-anchor="middle">提供迁移工具/兼容层/对照表；下线前先“渐进限流 + 返回明确错误提示”，而不是悄悄关闭</text>
<text class="ts" x="380" y="236" text-anchor="middle">下线要可回退（保留短期开关）；记录决策与时间线</text>
<text class="ts" x="380" y="258" text-anchor="middle">内部服务间接口：用契约测试与兼容性检查让提供方知道谁依赖了什么</text>
</svg>
<figcaption>图 3：API 弃用与下线的流程</figcaption>
</figure>

## 认证、授权与限流

| 方面 | 做法 |
| --- | --- |
| **认证** | 对外开放：**OAuth 2.0**（授权码 + PKCE 给用户级访问；客户端凭证给服务端访问）；简单场景 **API Key**（只用于标识与限额，敏感操作配合签名）；内部：JWT/mTLS，见 [认证与授权](#/security/auth)、[微服务安全](#/spring/cloud-security) |
| **授权（Scope）** | 令牌带 **scope**（`orders:read`、`orders:write`），按最小权限；资源级授权在服务内校验，防 IDOR |
| **限流与配额** | 多层：全局/应用/用户/接口；返回 **429** 与 `Retry-After`、`X-RateLimit-Limit/Remaining/Reset` 头，让客户端自我调节，见 [限流、熔断与降级](#/distributed/governance) |
| **传输安全** | 强制 HTTPS/TLS；HSTS |
| **输入校验** | 严格校验类型、长度、范围、枚举；防注入；请求体大小限制，见 [Web 安全](#/security/web) |
| **敏感信息** | 不在 URL/日志放令牌与敏感字段；响应脱敏 |
| **CORS** | 白名单；与网关统一，见 [Spring Cloud Gateway 深入](#/spring/cloud-gateway) |

## 开放平台：签名、Webhook 与 SDK

### 请求签名（防篡改与重放）

适用于**服务端到服务端**的开放 API（如支付、物流、开放平台），在 HTTPS 之上再加**应用层签名**：

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="开放平台请求签名流程：调用方用 AppSecret 对规范化后的请求（方法、路径、排序后的参数、请求体摘要、时间戳、随机串）计算 HMAC 签名，放入请求头；服务端按 AppKey 取出密钥，校验时间戳在窗口内、随机串未使用过（防重放）、重新计算签名并比对；通过后再做授权与限流；密钥不通过网络传输">
<rect class="b3" x="20" y="30" width="150" height="80" rx="8"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">调用方</text>
<text class="ts" x="95" y="74" text-anchor="middle">持有 AppKey + Secret</text>
<text class="ts" x="95" y="92" text-anchor="middle">规范化请求并签名</text>
<rect class="b5" x="200" y="30" width="170" height="80" rx="8"/>
<text class="tb" x="285" y="50" text-anchor="middle" dominant-baseline="middle">请求头携带</text>
<text class="ts" x="285" y="74" text-anchor="middle">AppKey · Timestamp</text>
<text class="ts" x="285" y="92" text-anchor="middle">Nonce · Signature</text>
<rect class="b1" x="400" y="30" width="170" height="80" rx="8"/>
<text class="tb" x="485" y="50" text-anchor="middle" dominant-baseline="middle">服务端校验</text>
<text class="ts" x="485" y="74" text-anchor="middle">时间窗口 ±5 分钟</text>
<text class="ts" x="485" y="92" text-anchor="middle">Nonce 去重 + 验签</text>
<rect class="b2" x="600" y="30" width="140" height="80" rx="8"/>
<text class="tb" x="670" y="50" text-anchor="middle" dominant-baseline="middle">通过后</text>
<text class="ts" x="670" y="74" text-anchor="middle">授权·限流·处理</text>
<line class="l" x1="170" y1="70" x2="200" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="70" x2="400" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="70" x2="600" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="720" height="190" rx="8"/>
<text class="th" x="32" y="150">签名设计要点</text>
<text class="ts" x="380" y="176" text-anchor="middle">规范化：对方法、路径、排序后的查询参数、请求体摘要（SHA-256）、时间戳、Nonce 拼接成待签名串，格式严格统一，避免歧义</text>
<text class="ts" x="380" y="198" text-anchor="middle">算法：HMAC-SHA256（对称密钥）或 RSA/ECDSA 非对称签名（密钥不在服务端共享，适合高安全）；Secret 绝不通过网络传输</text>
<text class="ts" x="380" y="220" text-anchor="middle">防重放：时间戳窗口 + Nonce 在窗口内缓存去重（Redis SETNX + TTL）；敏感写操作再配合业务幂等键</text>
<text class="ts" x="380" y="242" text-anchor="middle">防篡改：请求体参与签名；比对签名用恒定时间比较，防时序攻击；失败统一返回，不泄露原因细节</text>
<text class="ts" x="380" y="264" text-anchor="middle">密钥管理：每应用独立密钥，支持轮换（新旧并存过渡）、吊销、IP 白名单；密钥存储用 KMS</text>
<text class="ts" x="380" y="286" text-anchor="middle">时钟：双方时间偏差要容忍；服务端时间窗口不要过窄，也不要过宽</text>
<text class="ta" x="380" y="310" text-anchor="middle">签名只证明“请求来自持有密钥者且未被篡改”，不替代授权（仍要校验该应用能否访问该资源）</text>
</svg>
<figcaption>图 4：开放平台的请求签名与校验</figcaption>
</figure>

### Webhook（服务端回调）

平台主动通知第三方（支付结果、订单状态变化、审核完成）：

| 设计点 | 说明 |
| --- | --- |
| **事件模型** | 稳定的事件类型与载荷（含事件 ID、类型、时间、资源快照或资源引用）；载荷版本化 |
| **签名** | 每个订阅用独立密钥对载荷签名（`X-Signature` + 时间戳），接收方验证，防伪造与重放 |
| **投递语义** | **至少一次**；接收方必须**幂等**（按事件 ID 去重）；**不保证顺序**（需要时载荷带资源版本号/序号，接收方丢弃过时事件，或让接收方回查最新状态） |
| **重试** | 非 2xx 或超时则**指数退避重试**（如 数分钟到数天，有限次数）；超过上限标记失败，提供**手动重放**与失败列表 |
| **快速响应** | 接收方应**先落库再返回 2xx**，异步处理；平台设置较短超时（几秒）；不要等业务处理完才响应 |
| **安全** | HTTPS；校验目标地址防 **SSRF**（禁止内网/元数据地址）；可选 IP 白名单；回调地址验证（握手） |
| **可观测** | 投递日志（请求/响应/耗时）对订阅方可见，便于自助排障；失败告警 |
| **订阅管理** | 事件类型订阅、启停、密钥轮换、租户级配额，见 [多租户 SaaS 架构](#/design/arch-multitenant) |
| **备选方案** | 提供**事件查询/拉取 API**（游标）作为 Webhook 的补偿，应对接收方宕机期间错过的事件 |

### SDK、文档与沙箱

- **OpenAPI 描述契约**，自动生成**文档站点**与**多语言 SDK**；SDK 封装签名、重试（只对幂等请求）、分页迭代器、错误类型、超时默认值；
- **沙箱环境**：与生产隔离的测试环境，提供测试数据与模拟回调；
- **变更日志与通知**：版本变更、弃用公告、状态页；
- **示例与最佳实践**：幂等键使用、分页、错误处理、Webhook 验签代码样例；
- **开发者门户**：应用管理、密钥、用量与配额、日志。

## 性能与缓存

| 手段 | 说明 |
| --- | --- |
| **分页与字段裁剪** | 游标分页、`fields` 选择、避免返回大对象 |
| **条件请求与缓存头** | ETag/If-None-Match、Cache-Control、CDN 缓存公共只读资源 |
| **压缩** | gzip/br，对大 JSON 有效 |
| **批量接口与聚合** | 减少往返，避免 N+1；BFF 聚合 |
| **异步化** | 长任务 202；Webhook 通知 |
| **HTTP/2 与连接复用** | 多路复用降低延迟 |
| **限制查询复杂度** | 深度、数量、时间范围上限；GraphQL 要做查询成本分析与深度限制 |
| **幂等与重试友好** | 超时重试安全，见 [幂等设计与重试](#/distributed/idempotent) |
| **Early/快速失败** | 参数校验前置，失败不占用后端资源 |

## GraphQL 的取舍

| 优点 | 代价 |
| --- | --- |
| 客户端按需取字段，减少过取/欠取与多次往返 | **缓存困难**（所有请求是 POST 到同一端点，难用 HTTP 缓存/CDN） |
| 强类型 Schema，自描述，工具链好 | **查询成本不可预测**：深度/复杂查询可能压垮后端，需深度限制、复杂度分析、持久化查询 |
| 前端迭代快，字段演进友好（弃用字段） | **N+1 查询**需要 DataLoader 批处理 |
| 适合聚合多个后端/多端 | **鉴权与限流更细**（字段级权限）、可观测更复杂、错误模型（部分成功） |

适用：**自家前端聚合层（BFF）**；**不推荐**直接对外开放通用 GraphQL 给不可控第三方（滥用风险），除非有严格的成本控制与配额。

## 文档、契约与测试

- **契约先行**：先写 OpenAPI/Protobuf 评审，再实现；**代码生成**或从注解生成，**保证契约与实现同源**；
- **契约测试**：消费者驱动（Pact 类）或基于 OpenAPI 的校验，防止“提供方改了字段，调用方线上挂了”；
- **兼容性检查进 CI**：对比新旧 OpenAPI/Proto，**检测破坏性变更**（删除字段、改类型、新增必填）并阻断或要求显式审批；
- **端到端与回归测试**：覆盖错误路径、分页边界、幂等、并发更新；
- **API 评审（Design Review）**：命名、语义、错误码、分页、权限、兼容性、性能与安全清单；
- **文档**：每个接口的语义、参数约束、错误码、示例、限流、幂等性、**变更历史**；
- **API 目录与负责人**：每个 API 有 owner、状态（稳定/实验/弃用）、SLA。

## 常见反模式

| 反模式 | 后果 | 改进 |
| --- | --- | --- |
| **所有请求 POST，所有响应 200** | 缓存、重试、监控、网关失效 | 遵循 HTTP 语义与状态码 |
| **动词式 URL、风格不一致** | 难以学习与记忆 | 资源化，统一规范 |
| **offset 深分页** | 慢且重复/遗漏 | 游标分页 |
| **暴露自增主键/内部结构** | 可枚举、泄露规模；内部模型变更波及外部 | 不透明 ID；API 模型与内部模型解耦 |
| **返回 DB 实体/暴露所有字段** | 泄露敏感字段、与存储耦合 | DTO 与白名单字段 |
| **用浮点表示金额** | 精度问题 | 整数最小单位或字符串 decimal |
| **时间格式混乱（时区、精度）** | 解析歧义 | ISO 8601 + 时区，或统一毫秒时间戳 |
| **错误信息不统一、靠 message 判断** | 客户端脆弱 | 稳定错误码 + 统一结构 |
| **悄悄改变行为不升版本** | 破坏客户端 | 兼容性规则 + 版本 + 弃用流程 |
| **没有幂等设计的 POST** | 重试造成重复 | 幂等键 |
| **同步长任务** | 超时、占线程 | 202 + 任务资源 / Webhook |
| **Webhook 无签名、无重试、不幂等** | 伪造、丢失、重复 | 签名 + 退避重试 + 事件 ID 幂等 |
| **文档与实现脱节** | 联调成本高 | OpenAPI 同源 + 契约测试 |
| **一个接口干太多事（万能接口）** | 难演进、难授权、难缓存 | 单一职责，明确语义 |
| **内部接口直接暴露为外部 API** | 无法演进、安全风险 | 对外 API 经网关、独立契约与权限 |

## API 评审清单

- [ ] 资源建模与 URL 是否清晰一致？方法与状态码是否符合语义？GET 是否无副作用？
- [ ] 写接口是否支持幂等（幂等键），并发更新是否有 ETag/版本控制？
- [ ] 列表接口是否游标分页、有最大 limit、排序稳定、过滤字段白名单？
- [ ] 长任务是否异步（202 + 状态资源或回调）？批量接口的部分失败语义是否明确？
- [ ] 错误模型是否统一，错误码稳定，含 trace_id？是否泄露内部细节？
- [ ] 是否遵循兼容性规则？变更是否经过兼容性检查？版本与弃用策略是否明确？
- [ ] 认证、scope 授权、资源级授权、限流与配额是否齐备？
- [ ] 开放平台：签名与重放防护、Webhook 签名/重试/幂等、SDK、沙箱、文档是否具备？
- [ ] 金额、时间、ID、枚举等类型约定是否稳定（整数分、ISO 8601、不透明 ID、枚举可扩展）？
- [ ] 是否有 OpenAPI/Proto 契约、契约测试、CI 中的破坏性变更检测？

## 相关阅读

- [gRPC 与 Protobuf：协议、流式调用与治理](#/mw/grpc)：内部 RPC 的契约与兼容
- [幂等设计与重试：幂等键、去重表与超时未知](#/distributed/idempotent)：写接口的幂等
- [案例：API 网关设计详解](#/design/case-gateway)：认证、限流、路由与协议转换
- [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)：开放 API 的认证授权
- [OpenFeign 深入：调用链、超时重试与上下文透传](#/spring/cloud-feign)：客户端调用与契约演进
- [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)：事件 Schema 的兼容性
- [多租户 SaaS 架构：隔离、治理与运营](#/design/arch-multitenant)：租户级配额与开放平台

## 面试追问

> [!QUESTION] RESTful API 设计有哪些关键原则？
> 用名词资源建模，用 HTTP 方法与状态码表达语义，遵守安全性与幂等性：GET 无副作用，PUT 全量替换与 DELETE 幂等，POST 创建需幂等键；列表用游标分页与白名单过滤，错误用统一结构与稳定错误码，长任务返回 202 加状态资源，并发更新用 ETag 防丢失更新；业务错误不要都返回 200。

> [!QUESTION] 分页用 offset 还是游标？为什么？
> offset 简单可跳页，但深分页要扫描并丢弃大量行，翻页期间数据变动还会重复或遗漏。游标分页以上一页最后一条的排序键为起点，走索引性能稳定、一致性好，但不能随意跳页；排序键必须加唯一字段兜底，游标对客户端不透明，并限制最大 limit。

> [!QUESTION] API 怎么做到向后兼容？破坏性变更怎么发布？
> 只增不改不删：新增接口、可选字段、响应字段、放宽校验是兼容的，客户端要忽略未知字段与未知枚举值；删除或重命名字段、改类型含义、收紧校验、新增必填字段、改默认值都是破坏性的。破坏性变更发新主版本，新旧并存一个弃用期，用 Deprecation 与 Sunset 头、监控旧版本调用方、主动通知并提供迁移指南，灰度关闭后下线，并在 CI 里做契约兼容检查。

> [!QUESTION] 开放平台的请求签名怎么设计？
> 调用方用 AppSecret 对规范化后的方法、路径、排序参数、请求体摘要、时间戳和随机串做 HMAC，放入请求头；服务端按 AppKey 取密钥，校验时间戳在窗口内、随机串未使用过防重放、重算签名并用恒定时间比较，通过后再做授权与限流。密钥不通过网络传输，支持轮换与吊销，签名不替代授权。

> [!QUESTION] Webhook 要注意什么？
> 至少一次投递所以接收方要按事件 ID 幂等，不保证顺序所以载荷带版本号或让接收方回查；失败用指数退避重试并提供手动重放；每个订阅独立密钥签名防伪造与重放；接收方先落库再快速返回 2xx；平台要防 SSRF、提供投递日志，并提供事件拉取 API 作为补偿。

> [!QUESTION] REST、gRPC、GraphQL 怎么选？
> 对外开放和浏览器移动端用 REST，通用、易缓存和调试；内部服务间高频低延迟用 gRPC，强类型、性能好并支持流式；自家多端聚合可在 BFF 层用 GraphQL，但要承担缓存、查询成本控制和 N+1 的复杂度，不建议直接向不可控第三方开放；异步通知用 Webhook 或事件。常见是组合使用。
