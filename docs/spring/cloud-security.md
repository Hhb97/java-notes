---
level: 深入
tags: [微服务安全, 网关鉴权, JWT, OAuth2, Resource Server, 令牌传递, 服务间认证, mTLS, 零信任, 内部令牌, 权限模型]
summary: 微服务体系下的安全设计：外部与内部的信任边界、网关统一认证与服务内授权的分工、JWT 与不透明令牌的取舍、令牌中继与内部调用令牌、服务间认证（mTLS、服务身份）、用户上下文的可信传递、授权模型（RBAC/ABAC/资源级）、常见漏洞与治理清单。
---

# 微服务安全：网关鉴权、服务间认证与令牌传递

> [!ABSTRACT] 核心要点
> - 单体里“登录一次，进程内都信任”；微服务里**调用要跨网络、跨团队**，每个服务都必须回答：**这个请求是谁发的（认证）？他/它能做什么（授权）？消息有没有被篡改或重放？**——不能因为“在内网”就默认可信（**零信任**思路）。
> - 分工：**网关做“外部身份认证 + 粗粒度授权 + 入口防护”**，**服务做“资源级授权 + 业务规则校验”**。**网关校验过 ≠ 服务可以不校验**：内部网络可能被绕过、服务可能被误调用。
> - **令牌**要想清楚：**JWT（自包含，验签即可，难以即时撤销）** vs **不透明令牌（需向认证中心内省，可即时撤销，有网络开销）**。常见组合：对外短期访问令牌 + 刷新令牌；网关验签后把**精简的用户上下文**传给内部，或换成**内部令牌**。
> - **用户身份的传递必须可信**：用户 ID 头不是“传来就信”，**只信来自网关/认证中心且经过签名或来自受信任通道（mTLS）**的上下文；外部请求带的内部头必须在入口清除。
> - **服务间调用也要认证**：用**服务身份**（mTLS 证书、服务账号令牌）证明“谁在调”，再由被调用方根据策略决定是否允许，**防止任意内部服务被横向利用**。
> - **授权要到资源级**：最常见的越权漏洞是**水平越权（IDOR）**——有登录态就能改别人的订单。必须在服务内校验“当前用户是否拥有该资源”。

## 信任边界与分层

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="微服务信任边界：外部客户端经 WAF 和网关进入，网关做令牌校验与粗粒度授权，生成可信内部上下文；内部服务之间用服务身份和 mTLS 互相认证，每个服务做资源级授权；认证中心签发令牌，密钥管理系统保存签名密钥；内部网络不应默认可信">
<rect class="b" x="20" y="14" width="140" height="300" rx="10"/>
<text class="th" x="90" y="34" text-anchor="middle">外部（不可信）</text>
<rect class="b3" x="34" y="56" width="112" height="46" rx="6"/>
<text class="ts" x="90" y="79" text-anchor="middle" dominant-baseline="middle">浏览器/App</text>
<rect class="b3" x="34" y="112" width="112" height="46" rx="6"/>
<text class="ts" x="90" y="135" text-anchor="middle" dominant-baseline="middle">第三方系统</text>
<text class="ts" x="90" y="190" text-anchor="middle">令牌/签名/API Key</text>
<text class="ts" x="90" y="210" text-anchor="middle">全部需验证</text>
<rect class="b4" x="180" y="14" width="160" height="300" rx="10"/>
<text class="th" x="260" y="34" text-anchor="middle">入口层（边界）</text>
<rect class="b5" x="194" y="56" width="132" height="46" rx="6"/>
<text class="ts" x="260" y="79" text-anchor="middle" dominant-baseline="middle">WAF·限流·TLS</text>
<rect class="b1" x="194" y="112" width="132" height="64" rx="6"/>
<text class="tb" x="260" y="130" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="260" y="152" text-anchor="middle">验令牌·粗授权</text>
<text class="ts" x="260" y="170" text-anchor="middle">清洗·生成上下文</text>
<rect class="b2" x="194" y="190" width="132" height="46" rx="6"/>
<text class="ts" x="260" y="206" text-anchor="middle" dominant-baseline="middle">认证中心</text>
<text class="ts" x="260" y="224" text-anchor="middle">登录·签发·轮换</text>
<rect class="b" x="370" y="14" width="370" height="300" rx="10"/>
<text class="th" x="555" y="34" text-anchor="middle">内部服务（零信任：每跳都验证）</text>
<rect class="b3" x="390" y="56" width="150" height="56" rx="8"/>
<text class="tb" x="465" y="76" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<text class="ts" x="465" y="96" text-anchor="middle">资源级授权</text>
<rect class="b3" x="570" y="56" width="150" height="56" rx="8"/>
<text class="tb" x="645" y="76" text-anchor="middle" dominant-baseline="middle">库存服务</text>
<text class="ts" x="645" y="96" text-anchor="middle">资源级授权</text>
<line class="l" x1="540" y1="84" x2="570" y2="84" marker-end="url(#arr)"/>
<text class="ta" x="555" y="128" text-anchor="middle">服务身份 + mTLS / 内部令牌</text>
<rect class="bg" x="390" y="150" width="330" height="150" rx="8"/>
<text class="th" x="402" y="170">服务内必须做的事</text>
<text class="ts" x="555" y="196" text-anchor="middle">校验调用方身份（是谁在调我）</text>
<text class="ts" x="555" y="216" text-anchor="middle">校验用户上下文来源可信（不信伪造头）</text>
<text class="ts" x="555" y="236" text-anchor="middle">资源级授权（这个用户能否操作这条数据）</text>
<text class="ts" x="555" y="256" text-anchor="middle">参数与业务规则校验；审计日志</text>
<text class="ts" x="555" y="282" text-anchor="middle">网关挡掉大多数外部攻击，但不能当唯一防线</text>
<line class="l" x1="146" y1="80" x2="194" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="326" y1="144" x2="390" y2="84" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：外部不可信、入口做边界防护、内部零信任的分层</figcaption>
</figure>

### 网关与服务的职责划分

| 职责 | 网关 | 业务服务 |
| --- | --- | --- |
| **身份认证（令牌有效？）** | ✅ 统一做（验签/内省、过期、吊销） | 通常信任网关，但**需验证上下文来源可信** |
| **粗粒度授权** | ✅ 路径/方法级（角色能否访问该 API 组） | — |
| **资源级授权** | ❌ 不知道业务数据归属 | ✅ **必须做**：该订单是否属于当前用户 |
| **业务规则校验** | ❌ | ✅ |
| **限流/黑名单/防刷** | ✅ | 补充（如热点、业务维度限流） |
| **输入校验（防注入）** | 基础（大小、格式） | ✅ **必须做**，见 [Web 安全](#/security/web) |
| **上下文生成** | ✅ 清洗外部头，生成可信的用户/租户/追踪上下文 | 消费并向下透传 |
| **审计** | 访问日志 | 业务操作日志（谁在何时对什么做了什么） |

> [!WARNING] “网关已校验”不是理由
> 内部服务可能被：其他内部服务误调、被攻陷的服务横向调用、绕过网关直连（如通过内网地址、错误的网络策略）。**服务对外暴露的每个端点都要有鉴权与授权**，并通过网络策略限制谁能直连。

## 令牌：JWT 与不透明令牌

| 维度 | JWT（自包含） | 不透明令牌（Reference Token） |
| --- | --- | --- |
| 内容 | 令牌本身包含声明（用户、权限、过期时间），带签名 | 随机字符串，信息存在认证中心 |
| 校验 | **本地验签**（用公钥/JWKS），无需网络调用 | 需向认证中心**内省（introspect）**或查缓存 |
| 性能 | 好，无集中瓶颈 | 取决于内省与缓存，认证中心压力大 |
| **撤销** | **难**：未过期前一直有效，需靠短有效期 + 黑名单 | **易**：认证中心删除即失效 |
| 信息泄露 | 内容可被解码（Base64），不要放敏感信息 | 无信息泄露 |
| 令牌体积 | 可能很大（权限多时） | 小 |
| 适合 | 服务多、性能敏感、可接受短期有效 | 对即时撤销要求高、令牌需严格保密 |

常见实践：

- **访问令牌短期（几分钟~几十分钟）**，配合**刷新令牌**（较长有效期、可撤销、安全存储）；
- JWT 里只放**必要的、非敏感的**声明（用户 ID、租户、角色/权限范围、过期时间、签发者、受众）；
- **验证要完整**：签名与算法白名单（拒绝 `none` 与算法混淆）、`exp`/`nbf`、**`iss`（签发者）、`aud`（受众）**、密钥轮换（通过 JWKS 与 `kid`）；
- **撤销与登出**：短有效期 + 黑名单（响应式缓存）+ 关键操作二次验证；用户改密、封禁时让相关令牌失效（版本号/令牌族）；
- **存放与传输**：浏览器端避免把令牌存放到易被 XSS 窃取的位置（权衡 Cookie 的 HttpOnly+SameSite 与 CSRF 防护）；只通过 HTTPS 传输；
- **不要在 URL 参数里放令牌**（会进入日志与 Referer）。

OAuth2/OIDC 的授权码流程、PKCE、刷新令牌与 JWT 细节见 [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)。

## 令牌传递与用户上下文

### 三种常见模式

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="三种令牌与上下文传递模式：模式一令牌中继，网关把用户原始令牌透传给内部服务，各服务自己验签；模式二网关验签后向内部传递可信的用户上下文头，依赖内网与 mTLS 信任网关；模式三令牌交换，网关把外部令牌换成短期的内部令牌，内部令牌包含用户和调用链信息，服务间继续用内部令牌">
<rect class="b3" x="20" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">① 令牌中继（Token Relay）</text>
<text class="ts" x="135" y="62" text-anchor="middle">网关把用户令牌原样转发</text>
<text class="ts" x="135" y="84" text-anchor="middle">每个服务自行验签并解析</text>
<text class="ts" x="135" y="116" text-anchor="middle">＋ 实现直接，服务独立可验</text>
<text class="ts" x="135" y="138" text-anchor="middle">－ 用户令牌在内网广泛流动</text>
<text class="ts" x="135" y="160" text-anchor="middle">－ 每跳重复验签，泄露面大</text>
<text class="ts" x="135" y="182" text-anchor="middle">－ 令牌权限过宽，易被滥用</text>
<rect class="b5" x="270" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">② 网关验签 + 上下文头</text>
<text class="ts" x="385" y="62" text-anchor="middle">网关验证后写入 X-User-Id 等头</text>
<text class="ts" x="385" y="84" text-anchor="middle">内部服务信任这些头</text>
<text class="ts" x="385" y="116" text-anchor="middle">＋ 简单、内部无需处理令牌</text>
<text class="ts" x="385" y="138" text-anchor="middle">－ 头可被伪造，必须保证</text>
<text class="ts" x="385" y="160" text-anchor="middle">　只有网关能访问服务（mTLS）</text>
<text class="ts" x="385" y="182" text-anchor="middle">－ 绕过网关则身份无保障</text>
<rect class="b2" x="520" y="14" width="220" height="200" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">③ 令牌交换（推荐）</text>
<text class="ts" x="630" y="62" text-anchor="middle">网关把外部令牌换成</text>
<text class="ts" x="630" y="84" text-anchor="middle">短期、窄范围的内部令牌</text>
<text class="ts" x="630" y="116" text-anchor="middle">＋ 内外令牌隔离，范围最小</text>
<text class="ts" x="630" y="138" text-anchor="middle">＋ 可携带调用方与链路信息</text>
<text class="ts" x="630" y="160" text-anchor="middle">＋ 内部可签名验证来源</text>
<text class="ts" x="630" y="182" text-anchor="middle">－ 需要签发/交换组件</text>
<rect class="bg" x="20" y="232" width="720" height="86" rx="8"/>
<text class="ts" x="380" y="254" text-anchor="middle">选择：小规模、网络受控 → ②（务必 mTLS + 清除外部头）；多团队、合规要求高 → ③ 或在 ② 基础上给上下文加签名</text>
<text class="ts" x="380" y="276" text-anchor="middle">无论哪种：内部调用要同时带“用户上下文”（代表谁）和“服务身份”（谁在调），二者缺一不可</text>
<text class="ts" x="380" y="298" text-anchor="middle">异步与消息场景：用户上下文写入消息头；消费者处理时代表“系统”还是“原用户”，权限要明确</text>
</svg>
<figcaption>图 2：三种令牌与用户上下文的传递方式</figcaption>
</figure>

### 内部上下文头的可信性

| 风险 | 对策 |
| --- | --- |
| **外部伪造 `X-User-Id`** | 网关**无条件删除**外部传入的所有内部头，再用验证后的结果重新写入 |
| **绕过网关直连服务** | 网络策略（只允许网关/受信服务访问）、**mTLS**、服务端校验调用方身份 |
| **上下文被中间服务篡改** | 对上下文加**签名（如 JWT 形式的内部令牌）**，下游验签；或限制只有受信组件能写 |
| **权限随链路放大** | 传递“用户权限范围”而不是“服务全部权限”；服务调用其他服务时使用最小权限 |
| **异步丢上下文** | 消息头携带上下文并在消费端恢复；明确异步处理的主体 |

### 服务代表用户 vs 代表自己

| 场景 | 身份 |
| --- | --- |
| 用户请求触发的链路 | **代表用户**（传递用户上下文，下游按用户权限授权） |
| 定时任务、系统间同步、消息消费的后台处理 | **代表服务自身**（使用服务身份；权限独立配置，通常更窄且审计到服务账号） |
| 特权操作（管理后台） | 单独的管理面、更强认证（MFA）、审批与审计 |

## 服务间认证

### 身份与加密

| 方式 | 说明 | 适用 |
| --- | --- | --- |
| **mTLS（双向 TLS）** | 双方用证书互相认证并加密；证书标识服务身份（如 SPIFFE ID） | 零信任网络、服务网格自动签发与轮换 |
| **服务账号令牌** | 每个服务有自己的凭证（短期令牌，如 Kubernetes ServiceAccount 令牌、OAuth2 客户端凭证模式） | 调用方-被调用方的身份证明 |
| **内部签名令牌** | 网关/认证中心签发包含调用链的内部令牌 | 需要把“用户 + 调用方”打包验证 |
| **API Key / 共享密钥** | 简单但难轮换、易泄露、无细粒度 | 仅用于低风险或过渡 |
| **网络隔离** | 命名空间、网络策略（只允许特定服务互访） | 作为**纵深防御**的一层，不能替代认证 |

要点：

- **证书与密钥自动轮换**：手工管理证书必然过期出事故；使用服务网格（Istio/Linkerd 等）或证书管理工具（如 cert-manager、内部 CA）自动签发与轮换；
- **授权策略**：认证后还要有“**谁可以调用谁、调用哪些接口**”的策略（服务网格的授权策略，或服务内的调用方白名单）；
- **OAuth2 客户端凭证模式**：服务用自己的 client_id/secret 换短期令牌，访问受保护的内部 API，令牌带 scope；密钥存放在密钥管理系统中，见 [加密与密钥管理](#/security/crypto)；
- **最小权限**：每个服务只有它需要的调用权限；一个服务被攻陷时，横向移动范围受限。

### 服务网格在安全上的作用

把 mTLS、证书轮换、服务间授权策略下沉到 sidecar/数据面，应用无需关心：

| 优点 | 代价 |
| --- | --- |
| 统一的 mTLS 与身份，自动轮换 | 运维复杂度、资源开销与排障难度 |
| 策略集中管理（谁能调用谁） | 对多语言团队友好，但纯 Java 单栈团队未必需要 |
| 与应用解耦 | 仍需应用层做**用户级授权**，网格只管服务级身份 |

是否引入服务网格取决于规模与团队能力，不是微服务安全的前提。

## 授权模型

| 模型 | 说明 | 适用 |
| --- | --- | --- |
| **RBAC**（基于角色） | 用户→角色→权限；管理简单 | 管理后台、权限层次清晰的系统 |
| **ABAC / 策略**（基于属性） | 按用户属性、资源属性、环境（时间、IP）评估策略 | 复杂规则：“只能查看本部门、且金额 < X 的订单” |
| **资源所有权（ReBAC）** | 按关系判断（创建者、协作者、团队成员） | 协作类产品、文档、项目 |
| **多租户隔离** | 所有数据访问强制带租户条件 | SaaS，见下 |

### 资源级授权与越权

**水平越权（IDOR）**：用户 A 修改 URL 中的订单号就能看到用户 B 的订单；**垂直越权**：普通用户调用管理员接口。对策：

```java
// 反例：只校验了“已登录”，没有校验资源归属
@GetMapping("/orders/{id}")
public Order get(@PathVariable Long id) { return orderService.findById(id); }

// 正例：服务层以“当前用户”为条件查询，不存在或不属于则按“不存在”处理
@GetMapping("/orders/{id}")
public Order get(@PathVariable Long id, @AuthenticationPrincipal UserContext user) {
    return orderService.findByIdAndOwner(id, user.userId(), user.tenantId())
            .orElseThrow(() -> new NotFoundException("order not found"));  // 避免泄露“存在但无权”
}
```

要点：

- **默认拒绝**，显式授权；
- **所有数据访问带上主体与租户条件**（持久层统一拦截器注入租户过滤，减少遗漏）；
- **接口方法级注解**（如方法安全）做声明式权限，复杂规则在服务层集中校验，不要散落在 Controller；
- **返回信息克制**：无权访问返回 404/统一错误，不暴露资源是否存在；
- **批量接口、导出接口、搜索接口、聚合接口**最容易漏掉权限，要单独审查；
- **权限变更的时效**：令牌里缓存的权限在变更后短期内仍有效，高敏感操作实时查询权限或缩短有效期。

### 多租户安全

- 租户 ID 来自**可信的令牌/上下文**，**不能信任请求参数里的租户 ID**；
- 持久层**强制租户过滤**（SQL 拦截器/行级安全），缓存 Key、消息、文件路径都带租户前缀；
- 租户级限流与配额，防止一个租户拖垮全局；
- 日志与追踪标注租户，审计可分租户导出；
- 测试覆盖“跨租户访问”的负面用例。

## 内部接口与管理面

| 风险 | 对策 |
| --- | --- |
| **Actuator/管理端点暴露** | 只开必要端点，独立管理端口、鉴权、内网访问；不暴露 `env`、`heapdump` 等敏感端点 |
| **内部接口被外部访问** | 路由层不暴露 `/internal/**`；网关白名单路由；服务端对内部接口要求服务身份 |
| **调试/测试接口遗留** | 构建时剔除或按环境关闭，CI 扫描 |
| **Swagger/API 文档** | 生产关闭或鉴权保护 |
| **配置中心/注册中心/控制台** | 强制鉴权、内网、最小权限；它们是“控制面”，被攻陷后果严重，见 [Nacos 与服务注册发现、配置中心](#/mw/registry) |
| **消息队列/数据库/缓存** | 独立账号与最小权限、网络隔离、TLS |

## 数据与链路安全

- **传输加密**：外部 HTTPS；内部关键链路（含敏感数据）同样加密（mTLS 或网格）；
- **敏感数据**：日志、追踪、指标中**不记录令牌、密码、证件号**；字段级脱敏与加密；见 [加密与密钥管理](#/security/crypto)；
- **请求防重放与签名**（对外开放 API）：时间戳 + nonce + 签名，服务端限制时间窗口并去重；
- **幂等**：防止重复提交造成业务重复（与安全相关的重放）；
- **输入校验与输出编码**：防注入与 XSS，见 [Web 安全：OWASP 常见漏洞与防护](#/security/web)；
- **依赖安全**：第三方库漏洞扫描、镜像扫描、SBOM；
- **审计**：认证失败、权限拒绝、敏感操作留痕，且日志不可篡改、集中存储。

## Spring Security 在微服务中的使用

| 角色 | 做法 |
| --- | --- |
| **资源服务器（Resource Server）** | 引入 OAuth2 Resource Server，配置 JWT 的 `issuer-uri`/`jwk-set-uri`，框架自动验签与校验 `exp/iss`；补充 `aud` 校验与权限映射（把 scope/角色映射成 GrantedAuthority） |
| **授权服务器** | 自建可用 Spring Authorization Server，或使用成熟的身份提供商（IdP，如 Keycloak 等）；通常不要自己从零写认证中心 |
| **网关（响应式）** | 网关使用响应式的安全配置（WebFlux 安全链），非阻塞验签；JWKS 要缓存 |
| **方法级授权** | 开启方法安全，`@PreAuthorize("hasAuthority('order:write')")` 与自定义表达式做资源级校验 |
| **服务间调用** | Feign/RestClient/WebClient 拦截器携带令牌（用户令牌中继或客户端凭证令牌），见 [OpenFeign 深入](#/spring/cloud-feign) |
| **CSRF/CORS** | 纯 API + 令牌的无状态服务一般关闭 CSRF（基于 Cookie 的会话则必须开启）；CORS 统一在网关配置 |
| **会话** | 无状态（令牌）为主；需要会话时外置到 Redis |

```java
@Configuration
@EnableMethodSecurity
public class ResourceServerConfig {
    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health/**").permitAll()
                .requestMatchers("/internal/**").hasAuthority("SCOPE_internal")   // 内部接口要求内部范围
                .anyRequest().authenticated())                                     // 默认需要认证
            .oauth2ResourceServer(o -> o.jwt(j -> j.jwtAuthenticationConverter(authConverter())))
            .csrf(c -> c.disable())                                                // 无状态令牌 API
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

> [!NOTE] 版本与写法
> Spring Security 的配置 API 随版本变化较大（组件式配置、Lambda DSL 等），以所用版本文档为准；上述代码仅示意结构。

## 常见漏洞与检查清单

| 漏洞/问题 | 典型成因 | 对策 |
| --- | --- | --- |
| **水平越权（IDOR）** | 只校验登录，不校验资源归属 | 数据访问带主体/租户条件，统一拦截 |
| **垂直越权** | 管理接口仅靠前端隐藏 | 服务端校验角色与权限，默认拒绝 |
| **绕过网关访问内部服务** | 内部服务对内网无鉴权 | mTLS/服务身份 + 网络策略 |
| **伪造内部头** | 信任了外部传入的 `X-User-Id` | 网关清除并重新生成，内部验签或限制来源 |
| **JWT 校验不完整** | 不校验 `aud`/`iss`、接受 `none` 算法、密钥硬编码 | 完整验证、算法白名单、密钥管理与轮换 |
| **令牌泄露与长期有效** | 日志打印令牌、有效期过长、无法撤销 | 短期令牌、黑名单、脱敏日志 |
| **服务账号权限过大** | 一个超级账号走天下 | 最小权限、分服务凭证、定期审计 |
| **管理端点暴露** | Actuator/控制台/文档公开 | 隔离端口、鉴权、内网 |
| **敏感信息泄露** | 日志、错误堆栈、响应里带内部信息 | 统一错误处理，脱敏，生产关闭详细错误 |
| **缺少审计** | 出事无法追溯 | 认证、授权、敏感操作审计集中存储 |
| **租户隔离缺失** | 缓存 Key/查询无租户条件 | 强制租户过滤与测试 |

治理清单：

- [ ] 外部入口是否统一经过网关与 WAF，内部服务是否有网络策略限制直连？
- [ ] 网关是否清除外部传入的内部头，并重新生成可信上下文？
- [ ] 令牌是否短期、校验完整（签名、过期、签发者、受众），密钥是否轮换？
- [ ] 内部服务调用是否有服务身份认证（mTLS/服务令牌），并有“谁能调谁”的策略？
- [ ] 每个服务是否做了资源级授权与租户隔离，并有越权测试用例？
- [ ] 管理端点、控制台、文档是否关闭或受保护？
- [ ] 敏感数据是否脱敏与加密，日志中无令牌与密钥？
- [ ] 异步与消息场景的身份主体是否明确？
- [ ] 是否有审计日志与告警（认证失败激增、越权尝试）？

## 相关阅读

- [认证与授权：OAuth2、OIDC 与 JWT](#/security/auth)：协议与令牌细节
- [Web 安全：OWASP 常见漏洞与防护](#/security/web)：越权、注入等漏洞
- [加密与密钥管理](#/security/crypto)：密钥、证书与轮换
- [Spring Cloud Gateway 深入](#/spring/cloud-gateway)：网关鉴权过滤器实现
- [案例：API 网关设计详解](#/design/case-gateway)：网关的整体安全设计

## 面试追问

> [!QUESTION] 微服务里认证授权应该怎么分工？
> 网关做外部身份认证（验令牌）、粗粒度授权与入口防护，并清洗外部头、生成可信上下文；业务服务做资源级授权和业务规则校验，不能因为网关已校验就放弃。内部服务间还要有服务身份认证，防止绕过网关或被攻陷的服务横向调用。

> [!QUESTION] JWT 和不透明令牌怎么选？JWT 怎么撤销？
> JWT 自包含，可本地验签、性能好，但未过期前难以撤销；不透明令牌需向认证中心内省，可即时撤销但有网络开销。实践中用短期访问令牌加可撤销的刷新令牌，JWT 撤销靠短有效期、黑名单、令牌版本号，并完整校验签名、算法白名单、过期、签发者与受众。

> [!QUESTION] 内部服务怎么知道“当前用户是谁”？怎么防止伪造？
> 网关验证令牌后，写入用户和租户上下文头或换成内部令牌，同时清除外部传入的同名头。内部服务只信来自受信通道的上下文：用 mTLS 保证只有网关或受信服务能访问，或让内部令牌带签名由下游验签，并配合网络策略防止绕过网关。

> [!QUESTION] 什么是水平越权？怎么在微服务里系统性防护？
> 登录用户通过修改资源 ID 访问或修改他人数据。要在服务内以当前用户和租户为条件访问数据，默认拒绝，持久层统一注入租户和归属过滤，无权时返回不存在以免泄露，重点审查批量、导出、搜索类接口，并写越权负面测试。

> [!QUESTION] 服务间调用如何认证？要不要上服务网格？
> 用 mTLS 双向认证并以证书标识服务身份，或服务账号令牌（如客户端凭证模式），再配合“谁能调用谁”的授权策略和最小权限。证书需自动签发轮换。服务网格能统一提供 mTLS 与策略，但带来运维成本，纯 Java 单栈小团队未必需要，且仍需应用层做用户级授权。

> [!QUESTION] 令牌中继、网关传上下文头、令牌交换三种方式有什么区别？
> 令牌中继把用户令牌透传，各服务自己验签，但令牌在内网广泛流动、权限过宽；网关验签后传可信上下文头，简单但依赖内部网络和 mTLS 保证头不被伪造；令牌交换把外部令牌换成短期、窄范围的内部令牌，隔离内外并可携带调用链信息，更安全但需要签发组件。
