---
level: 进阶
tags: [认证, 授权, Session, JWT, OAuth2, OIDC, SSO, Spring Security, RBAC, PKCE]
summary: 把“登录与权限”讲透：认证与授权的区别、Session 与 JWT 的取舍和 JWT 的撤销难题、OAuth2 授权码 + PKCE 与 OIDC 的完整流程、单点登录，以及 Spring Security 的过滤器链、认证流程、资源服务器与微服务统一认证架构、权限模型（RBAC/ABAC）和常见坑。
---

# 认证授权：Session、JWT、OAuth2 与 Spring Security

> [!ABSTRACT] 核心要点
> - **认证（Authentication）= 你是谁**，**授权（Authorization）= 你能做什么**。先认证再授权，两件事要分开设计。
> - **Session** 状态在服务端，易撤销、扩展需共享存储；**JWT** 状态在令牌里，无状态易扩展，但**一旦签发难以撤销**——所以用**短期 Access Token + 可轮换的 Refresh Token**，并保留黑名单/版本号等应急手段。
> - **OAuth2** 解决的是“**第三方应用在不拿到用户密码的情况下，获得有限权限**”；浏览器/移动端必须用 **授权码模式 + PKCE**；**OIDC** 在 OAuth2 之上增加**身份层（ID Token）**，是做**单点登录（SSO）**的标准。
> - **Spring Security** 的本质是一条 **Servlet 过滤器链**：认证由 `AuthenticationManager → AuthenticationProvider` 完成，授权由 `AuthorizationManager`（URL 级）与方法安全（`@PreAuthorize`）完成。
> - 微服务里推荐：**网关/边缘统一验证令牌 + 各服务（资源服务器）自己再校验并做细粒度授权**，不要信任“只要进了内网就是可信的”。

> [!NOTE] 版本
> 示例基于 **Spring Boot 3 / Spring Security 6**（`SecurityFilterChain` Bean + Lambda DSL，已不再使用 `WebSecurityConfigurerAdapter`）。版本差异请以官方文档为准。

## 一、认证与授权：两个不同的问题

| | 认证 Authentication | 授权 Authorization |
| --- | --- | --- |
| 问题 | 你是谁？ | 你能做什么？ |
| 手段 | 密码、验证码、指纹、证书、令牌 | 角色、权限、策略、数据范围 |
| 失败响应 | **401 Unauthorized** | **403 Forbidden** |
| 发生时机 | 登录时 / 每次请求验证凭证 | 每次访问资源时 |

常见错误：**把“已登录”当成“有权限”**，导致任何登录用户都能访问任何资源（越权）。授权要**在每个资源、每一层**做。

## 二、Session 与 Token（JWT）

### 1. Cookie + Session

<figure class="fig">
<svg viewBox="0 0 760 280" class="dg" role="img" aria-label="Session 登录流程：用户提交账号密码，服务器验证后创建 Session 并通过 Cookie 返回 SessionID，之后每次请求浏览器自动带上 Cookie，服务器据此从 Session 存储中取出用户信息">
<rect class="b1" x="20" y="30" width="110" height="34" rx="6"/>
<text class="tb" x="75" y="47" text-anchor="middle" dominant-baseline="middle">浏览器</text>
<rect class="b3" x="310" y="30" width="130" height="34" rx="6"/>
<text class="tb" x="375" y="47" text-anchor="middle" dominant-baseline="middle">应用服务器</text>
<rect class="b5" x="620" y="30" width="120" height="34" rx="6"/>
<text class="tb" x="680" y="47" text-anchor="middle" dominant-baseline="middle">Session 存储</text>
<line class="ld" x1="75" y1="64" x2="75" y2="260"/>
<line class="ld" x1="375" y1="64" x2="375" y2="260"/>
<line class="ld" x1="680" y1="64" x2="680" y2="260"/>
<line class="l" x1="75" y1="92" x2="375" y2="92" marker-end="url(#arr)"/>
<text class="ts" x="225" y="84" text-anchor="middle">① POST /login 账号+密码</text>
<line class="l" x1="375" y1="120" x2="680" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="528" y="112" text-anchor="middle">② 验证通过，保存 session（sid → 用户信息）</text>
<line class="la" x1="375" y1="148" x2="75" y2="148" marker-end="url(#arr-a)"/>
<text class="ta" x="225" y="140" text-anchor="middle">③ Set-Cookie: SESSION=sid（HttpOnly; Secure; SameSite）</text>
<line class="l" x1="75" y1="190" x2="375" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="225" y="182" text-anchor="middle">④ 后续请求自动带 Cookie</text>
<line class="l" x1="375" y1="218" x2="680" y2="218" marker-end="url(#arr)"/>
<text class="ts" x="528" y="210" text-anchor="middle">⑤ 按 sid 取出用户，完成认证</text>
<text class="ts" x="380" y="252" text-anchor="middle">多实例部署必须共享 Session（Redis / Spring Session）或做会话粘滞；服务端删除 session 即可立刻“踢人下线”</text>
</svg>
<figcaption>图 1：Cookie + Session 的认证流程</figcaption>
</figure>

### 2. JWT：把状态放进令牌

**JWT（JSON Web Token）** 由三段 Base64URL 编码组成：`Header.Payload.Signature`。

```text
Header    {"alg":"RS256","typ":"JWT","kid":"2026-01"}
Payload   {"sub":"10086","iss":"https://auth.example.com","aud":"order-api",
           "exp":1760000000,"iat":1759996400,"jti":"a1b2...","scope":"order:read","roles":["USER"]}
Signature 用私钥(或共享密钥)对 Header.Payload 签名，防篡改
```

- **签名而非加密**：Payload 只是 Base64 编码，**任何人都能读**，**不要放密码、身份证等敏感信息**；
- **签名算法**：`HS256`（对称，服务双方共享密钥，适合单体）、`RS256/ES256`（非对称，**认证服务用私钥签、资源服务用公钥验**，微服务首选，公钥通过 **JWKS** 端点分发并支持轮换）；
- **必须校验的声明**：签名、`exp`（过期）、`iss`（签发者）、`aud`（受众）、`nbf`；
- **经典漏洞**：接受 `alg: none`、把 RS256 公钥当 HS256 密钥验证（算法混淆）——**服务端要固定允许的算法**，不要信任令牌头里的 `alg`。

### 3. Session 与 JWT 对比

| | Session | JWT |
| --- | --- | --- |
| 状态 | 服务端保存 | **令牌自包含，服务端无状态** |
| 扩展 | 需共享存储（Redis） | 天然适合多实例/微服务/跨域 |
| 撤销/踢人 | **容易**（删 session） | **难**（签发后到期前一直有效） |
| 体积 | Cookie 里只有 sid（很小） | 较大，每次请求都带 |
| 敏感信息 | 在服务端 | 在令牌里（可读） |
| 典型场景 | 传统 Web、需要强控制 | **移动端、前后端分离、微服务、开放 API** |

### 4. 解决 JWT 难以撤销

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="Access Token 与 Refresh Token 机制：短期访问令牌过期后用长期刷新令牌换取新的访问令牌，刷新令牌每次使用即轮换，检测到重用则吊销整个令牌家族">
<rect class="b2" x="20" y="40" width="220" height="70" rx="10"/>
<text class="tb" x="130" y="64" text-anchor="middle" dominant-baseline="middle">Access Token（JWT）</text>
<text class="ts" x="130" y="86" text-anchor="middle">有效期短：5~30 分钟</text>
<text class="ts" x="130" y="102" text-anchor="middle">每次请求携带，无状态校验</text>
<rect class="b3" x="270" y="40" width="220" height="70" rx="10"/>
<text class="tb" x="380" y="64" text-anchor="middle" dominant-baseline="middle">Refresh Token</text>
<text class="ts" x="380" y="86" text-anchor="middle">有效期长：数天~数周</text>
<text class="ts" x="380" y="102" text-anchor="middle">只发给认证服务，服务端可存储/可吊销</text>
<rect class="b5" x="520" y="40" width="220" height="70" rx="10"/>
<text class="tb" x="630" y="64" text-anchor="middle" dominant-baseline="middle">应急手段</text>
<text class="ts" x="630" y="86" text-anchor="middle">黑名单（jti）· 用户 token 版本号</text>
<text class="ts" x="630" y="102" text-anchor="middle">密钥轮换 · 强制下线</text>
<line class="l" x1="130" y1="110" x2="130" y2="150"/>
<text class="ts" x="140" y="136" text-anchor="start">过期（401）</text>
<line class="la" x1="130" y1="150" x2="380" y2="150"/>
<line class="la" x1="380" y1="150" x2="380" y2="170" marker-end="url(#arr-a)"/>
<text class="ta" x="260" y="144" text-anchor="middle">用 Refresh Token 换新</text>
<rect class="bg" x="20" y="180" width="720" height="100" rx="10"/>
<text class="th" x="36" y="204">Refresh Token 的安全做法</text>
<text class="ts" x="36" y="228">• 轮换（Rotation）：每次刷新都签发新的 refresh token，旧的立即作废</text>
<text class="ts" x="36" y="248">• 重用检测：已作废的 refresh token 再次出现 → 判定被盗，吊销该用户这一“令牌家族”的全部令牌</text>
<text class="ts" x="36" y="268">• 存放：浏览器用 HttpOnly + Secure + SameSite Cookie；App 用系统安全存储；不要放 localStorage</text>
</svg>
<figcaption>图 2：短期 Access Token + 可轮换的 Refresh Token</figcaption>
</figure>

**黑名单与版本号**：

```java
// 登出 / 改密 / 被封禁：让该用户此前签发的令牌全部失效
redis.opsForValue().set("auth:ver:" + userId, String.valueOf(System.currentTimeMillis()));
// 校验令牌时：令牌里的 iat 必须晚于 auth:ver:{userId} 中的时间，否则拒绝
// 单个令牌吊销：把 jti 放入 Redis（TTL = 令牌剩余有效期），校验时先查黑名单
```

> [!WARNING] “无状态 JWT”要为撤销付代价
> 一旦为了踢人/封号而在每次请求都查 Redis 黑名单，就失去了无状态的好处。折中：Access Token 足够短 + 只对 Refresh Token 做服务端控制；对高风险操作再实时校验账号状态。

## 三、OAuth2：授权，不是登录

### 1. 解决什么问题

你想让某个**第三方应用**（如一款云打印服务）访问你在**微信/Google**上的照片，但**不想把密码给它**。OAuth2 让第三方拿到一个**有限范围、有时效、可撤销**的**令牌**，而不是密码。

### 2. 四个角色

| 角色 | 含义 | 例子 |
| --- | --- | --- |
| **资源拥有者** | 用户 | 你 |
| **客户端** | 想访问资源的应用 | 第三方应用 / 你自己的前端 |
| **授权服务器** | 认证用户并签发令牌 | Keycloak、Spring Authorization Server、Auth0、企业 IdP |
| **资源服务器** | 持有资源、校验令牌的 API | 订单服务、用户服务 |

### 3. 授权码模式 + PKCE（现在的标准做法）

<figure class="fig">
<svg viewBox="0 0 780 400" class="dg" role="img" aria-label="授权码加 PKCE 流程：客户端生成 code_verifier 与 challenge，跳转授权服务器登录并授权，授权服务器回调返回授权码，客户端携带 code 和 code_verifier 换取令牌，再用访问令牌调用资源服务器">
<rect class="b1" x="20" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="75" y="37" text-anchor="middle" dominant-baseline="middle">用户 + 客户端</text>
<rect class="b3" x="300" y="20" width="150" height="34" rx="6"/>
<text class="tb" x="375" y="37" text-anchor="middle" dominant-baseline="middle">授权服务器</text>
<rect class="b2" x="640" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="695" y="37" text-anchor="middle" dominant-baseline="middle">资源服务器</text>
<line class="ld" x1="75" y1="54" x2="75" y2="384"/>
<line class="ld" x1="375" y1="54" x2="375" y2="384"/>
<line class="ld" x1="695" y1="54" x2="695" y2="384"/>
<text class="ts" x="85" y="82" text-anchor="start">客户端生成 code_verifier（随机串），</text>
<text class="ts" x="85" y="98" text-anchor="start">code_challenge = SHA256(code_verifier)</text>
<line class="l" x1="75" y1="118" x2="375" y2="118" marker-end="url(#arr)"/>
<text class="ts" x="225" y="110" text-anchor="middle">① 跳转 /authorize?client_id&amp;redirect_uri&amp;scope&amp;state&amp;code_challenge</text>
<text class="ts" x="385" y="146" text-anchor="start">② 用户登录并同意授权范围</text>
<line class="la" x1="375" y1="172" x2="75" y2="172" marker-end="url(#arr-a)"/>
<text class="ta" x="225" y="164" text-anchor="middle">③ 重定向回 redirect_uri?code=一次性授权码&amp;state</text>
<text class="ts" x="85" y="200" text-anchor="start">校验 state（防 CSRF）</text>
<line class="l" x1="75" y1="226" x2="375" y2="226" marker-end="url(#arr)"/>
<text class="ts" x="225" y="218" text-anchor="middle">④ POST /token：code + code_verifier + client_id</text>
<text class="ts" x="385" y="254" text-anchor="start">⑤ 验证 SHA256(verifier)==challenge，授权码一次性</text>
<line class="la" x1="375" y1="278" x2="75" y2="278" marker-end="url(#arr-a)"/>
<text class="ta" x="225" y="270" text-anchor="middle">⑥ access_token（+ refresh_token + id_token）</text>
<line class="l" x1="75" y1="318" x2="695" y2="318" marker-end="url(#arr)"/>
<text class="ts" x="385" y="310" text-anchor="middle">⑦ GET /api/orders   Authorization: Bearer access_token</text>
<line class="l" x1="695" y1="352" x2="75" y2="352" marker-end="url(#arr)"/>
<text class="ts" x="385" y="344" text-anchor="middle">⑧ 校验令牌（签名、exp、aud、scope）后返回数据</text>
</svg>
<figcaption>图 3：授权码 + PKCE：授权码不是令牌，且被偷走也无法换令牌</figcaption>
</figure>

**为什么要有“授权码”这一步**：令牌如果直接通过浏览器地址栏（前端通道）返回，容易泄露；授权码只是个一次性凭证，**由客户端通过后端通道（或带 PKCE 校验）去换令牌**。**PKCE** 让公开客户端（SPA、App）也能安全使用：即使授权码被截获，没有 `code_verifier` 也换不到令牌。

### 4. 其他授权类型

| 类型 | 用途 | 现状 |
| --- | --- | --- |
| **授权码 + PKCE** | 有用户参与的 Web/SPA/移动端 | **首选** |
| **客户端凭证（Client Credentials）** | **服务对服务**（无用户） | 微服务间调用、定时任务 |
| 设备码 | 智能电视、命令行等无浏览器设备 | 使用 |
| 刷新令牌 | 换新的 access token | 使用 |
| 密码模式（Password） | 用户直接把密码给客户端 | **已被弃用，不推荐** |
| 隐式模式（Implicit） | 令牌直接回前端 | **已被弃用** |

### 5. OIDC：在 OAuth2 之上做“登录”

OAuth2 只说“**这个令牌能访问什么**”，**不告诉你“用户是谁”**。**OpenID Connect（OIDC）** 补上了身份层：

- 多返回一个 **ID Token**（一个 JWT，含 `sub`、`name`、`email`、`iss`、`aud`、`nonce` 等，**给客户端看用户身份**）；
- 标准的 **`/userinfo`** 端点、**Discovery**（`/.well-known/openid-configuration`）、**JWKS**（公钥集）；
- scope 里带 `openid` 即启用 OIDC。

**用法区分**：`ID Token` → 客户端确认“谁登录了”；`Access Token` → 调用资源服务器 API；**不要拿 ID Token 去调 API**。

## 四、单点登录（SSO）

目标：用户在一个入口登录一次，访问公司内**多个系统**都无需再登录。

<figure class="fig">
<svg viewBox="0 0 760 280" class="dg" role="img" aria-label="单点登录：用户访问应用 A 被重定向到统一认证中心登录，认证中心种下自己域的登录态，再访问应用 B 时被重定向到认证中心，认证中心发现已登录直接签发凭证，无需再输入密码">
<rect class="b3" x="270" y="20" width="220" height="60" rx="10"/>
<text class="tb" x="380" y="44" text-anchor="middle" dominant-baseline="middle">统一认证中心（IdP / SSO）</text>
<text class="ts" x="380" y="64" text-anchor="middle">持有“全局登录态”（自己域的 Cookie）</text>
<rect class="b1" x="20" y="150" width="170" height="60" rx="10"/>
<text class="tb" x="105" y="174" text-anchor="middle" dominant-baseline="middle">应用 A</text>
<text class="ts" x="105" y="194" text-anchor="middle">局部会话</text>
<rect class="b1" x="570" y="150" width="170" height="60" rx="10"/>
<text class="tb" x="655" y="174" text-anchor="middle" dominant-baseline="middle">应用 B</text>
<text class="ts" x="655" y="194" text-anchor="middle">局部会话</text>
<line class="l" x1="105" y1="150" x2="290" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="140" y="108" text-anchor="start">① 访问 A，未登录 → 重定向认证中心</text>
<line class="la" x1="320" y1="80" x2="150" y2="150" marker-end="url(#arr-a)"/>
<text class="ta" x="238" y="132" text-anchor="start">② 登录后带票据/授权码返回 A</text>
<line class="l" x1="655" y1="150" x2="470" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="560" y="108" text-anchor="start">③ 访问 B，重定向认证中心</text>
<line class="la" x1="440" y1="80" x2="610" y2="150" marker-end="url(#arr-a)"/>
<text class="ta" x="460" y="132" text-anchor="start">④ 已登录，直接发票据，免输密码</text>
<text class="ts" x="380" y="248" text-anchor="middle">常见协议：OIDC / OAuth2（现代首选）· SAML 2.0（企业传统）· CAS（高校/国内老系统）</text>
<text class="ts" x="380" y="268" text-anchor="middle">难点：单点登出（通知各应用销毁局部会话：前/后通道登出）、跨域、会话超时策略、多终端</text>
</svg>
<figcaption>图 4：SSO：认证中心持有全局登录态，各应用持有局部会话</figcaption>
</figure>

自建建议：用成熟的 **Keycloak、Spring Authorization Server、Authing/企业 IdP** 等，不要手写 OAuth2/OIDC 服务端——细节多且安全敏感。

## 五、Spring Security 核心机制

### 1. 过滤器链

Spring Security 在 Servlet 容器里的入口是**一个过滤器**，再由它调度一串内部过滤器：

<figure class="fig">
<svg viewBox="0 0 780 320" class="dg" role="img" aria-label="Spring Security 过滤器链：请求先经过 DelegatingFilterProxy 进入 FilterChainProxy，再依次通过安全过滤器链中的各个过滤器完成认证与授权，最后到达 DispatcherServlet 和 Controller">
<rect class="b" x="20" y="130" width="80" height="50" rx="8"/>
<text class="tb" x="60" y="155" text-anchor="middle" dominant-baseline="middle">请求</text>
<rect class="b1" x="130" y="130" width="130" height="50" rx="8"/>
<text class="tb" x="195" y="148" text-anchor="middle" dominant-baseline="middle">DelegatingFilter</text>
<text class="tb" x="195" y="164" text-anchor="middle" dominant-baseline="middle">Proxy</text>
<rect class="b3" x="290" y="130" width="130" height="50" rx="8"/>
<text class="tb" x="355" y="148" text-anchor="middle" dominant-baseline="middle">FilterChain</text>
<text class="tb" x="355" y="164" text-anchor="middle" dominant-baseline="middle">Proxy</text>
<line class="l" x1="100" y1="155" x2="130" y2="155" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="155" x2="290" y2="155" marker-end="url(#arr)"/>
<rect class="bg" x="450" y="20" width="310" height="280" rx="12"/>
<text class="th" x="466" y="44">SecurityFilterChain（按顺序执行）</text>
<rect class="b5" x="470" y="58" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="73" text-anchor="middle" dominant-baseline="middle">SecurityContextHolderFilter（加载上下文）</text>
<rect class="b5" x="470" y="94" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="109" text-anchor="middle" dominant-baseline="middle">CsrfFilter / CorsFilter / HeaderWriterFilter</text>
<rect class="b3" x="470" y="130" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="145" text-anchor="middle" dominant-baseline="middle">认证过滤器：UsernamePassword… / BearerToken…</text>
<rect class="b3" x="470" y="166" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="181" text-anchor="middle" dominant-baseline="middle">自定义过滤器（如验证码、JWT 过滤）</text>
<rect class="b4" x="470" y="202" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="217" text-anchor="middle" dominant-baseline="middle">ExceptionTranslationFilter（401/403 处理）</text>
<rect class="b4" x="470" y="238" width="270" height="30" rx="6"/>
<text class="ts" x="605" y="253" text-anchor="middle" dominant-baseline="middle">AuthorizationFilter（URL 授权）</text>
<line class="l" x1="420" y1="155" x2="450" y2="155" marker-end="url(#arr)"/>
<text class="ts" x="30" y="260" text-anchor="start">通过后到达 DispatcherServlet → Controller；之后方法安全（@PreAuthorize）由 AOP 再做一次授权</text>
</svg>
<figcaption>图 5：Spring Security 的过滤器链</figcaption>
</figure>

要点：

- **`FilterChainProxy`** 是 Spring Security 的总入口，可配置**多条** `SecurityFilterChain`，按请求路径匹配（如 `/api/**` 用 JWT，`/admin/**` 用表单登录）；
- **认证结果保存在 `SecurityContext`**（`SecurityContextHolder`，基于 **ThreadLocal**）；因此**在异步线程里默认拿不到当前用户**，需要传播（`DelegatingSecurityContextExecutor` 等），**虚拟线程/线程池里尤其要注意**；
- 异常翻译：未认证 → `AuthenticationEntryPoint`（返回 401），无权限 → `AccessDeniedHandler`（403）。

### 2. 认证流程

```text
Filter 提取凭证（账号密码 / Bearer 令牌）
   → 构造未认证的 Authentication（如 UsernamePasswordAuthenticationToken）
   → AuthenticationManager（实现：ProviderManager）
        → 遍历 AuthenticationProvider：supports() 为 true 的执行 authenticate()
             DaoAuthenticationProvider：UserDetailsService.loadUserByUsername() 取用户
                                       → PasswordEncoder.matches() 校验密码
   → 成功：返回“已认证”的 Authentication（含 authorities 权限列表）
   → 存入 SecurityContext
```

### 3. 配置示例（Spring Security 6）

```java
@Configuration
@EnableMethodSecurity                                  // 开启 @PreAuthorize 等方法安全
public class SecurityConfig {

    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())              // 纯 Bearer Token 的无状态 API 可关闭；用 Cookie 的站点不要关
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health", "/public/**").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/products/**").hasAuthority("SCOPE_product:read")
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())         // 默认拒绝：未明确放行的都要认证
            .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()));   // 作为资源服务器校验 JWT
        return http.build();
    }

    @Bean PasswordEncoder passwordEncoder() { return new BCryptPasswordEncoder(); }
}
```

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com          # 通过 OIDC Discovery 自动获取 JWKS 公钥并校验签名、iss、exp
```

要点：**默认拒绝**（`anyRequest().authenticated()` 放最后），不要写成“默认放行，列出要拦的”。

### 4. 方法级授权

```java
@PreAuthorize("hasAuthority('order:read') and #userId == authentication.principal.id")   // 水平越权防护
public Order getOrder(@P("userId") long userId, long orderId) { ... }

@PostAuthorize("returnObject.ownerId == authentication.principal.id")                       // 返回后再校验归属
public Order find(long id) { ... }
```

**URL 级授权只管“能不能进这个接口”，数据权限（这条订单是不是你的）必须在业务/方法层校验**——这是最常见的越权漏洞来源，见 [Web 安全：OWASP 常见漏洞与防护](#/security/web)。

### 5. 自定义 JWT 过滤（不使用 resource-server 时）

```java
public class JwtFilter extends OncePerRequestFilter {
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String h = req.getHeader("Authorization");
        if (h != null && h.startsWith("Bearer ")) {
            try {
                Claims c = jwtService.verify(h.substring(7));                 // 验签 + exp + iss + aud
                var auth = new UsernamePasswordAuthenticationToken(c.getSubject(), null, toAuthorities(c));
                SecurityContextHolder.getContext().setAuthentication(auth);
            } catch (JwtException e) {
                SecurityContextHolder.clearContext();                         // 令牌无效：清除上下文，交给后续返回 401
            }
        }
        chain.doFilter(req, res);
    }
}
```

## 六、微服务统一认证架构

<figure class="fig">
<svg viewBox="0 0 780 340" class="dg" role="img" aria-label="微服务认证架构：客户端通过授权服务器获取令牌，网关校验令牌并转发，各业务服务作为资源服务器再次校验并做细粒度授权，服务间调用使用客户端凭证或透传令牌，公钥通过 JWKS 分发">
<rect class="b" x="20" y="130" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="158" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b3" x="20" y="20" width="200" height="60" rx="10"/>
<text class="tb" x="120" y="44" text-anchor="middle" dominant-baseline="middle">授权服务器（IdP）</text>
<text class="ts" x="120" y="64" text-anchor="middle">登录 · 签发令牌 · JWKS</text>
<line class="l" x1="70" y1="130" x2="100" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="34" y="104" text-anchor="start">① 登录取令牌</text>
<rect class="b1" x="190" y="130" width="140" height="56" rx="8"/>
<text class="tb" x="260" y="150" text-anchor="middle" dominant-baseline="middle">API 网关</text>
<text class="ts" x="260" y="170" text-anchor="middle">验签·限流·黑名单</text>
<line class="l" x1="120" y1="158" x2="190" y2="158" marker-end="url(#arr)"/>
<text class="ts" x="155" y="150" text-anchor="middle">② +令牌</text>
<rect class="b2" x="390" y="40" width="160" height="60" rx="8"/>
<text class="tb" x="470" y="64" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<text class="ts" x="470" y="84" text-anchor="middle">资源服务器：再验令牌</text>
<rect class="b2" x="390" y="130" width="160" height="60" rx="8"/>
<text class="tb" x="470" y="154" text-anchor="middle" dominant-baseline="middle">用户服务</text>
<text class="ts" x="470" y="174" text-anchor="middle">资源服务器：再验令牌</text>
<rect class="b2" x="390" y="220" width="160" height="60" rx="8"/>
<text class="tb" x="470" y="244" text-anchor="middle" dominant-baseline="middle">库存服务</text>
<text class="ts" x="470" y="264" text-anchor="middle">资源服务器：再验令牌</text>
<line class="l" x1="330" y1="150" x2="390" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="330" y1="158" x2="390" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="330" y1="166" x2="390" y2="245" marker-end="url(#arr)"/>
<path class="ld nf" d="M470 100 L470 130"/>
<text class="ts" x="480" y="120" text-anchor="start">③ 服务间调用</text>
<rect class="bg" x="590" y="40" width="170" height="240" rx="10"/>
<text class="th" x="606" y="64">设计要点</text>
<text class="ts" x="606" y="88">• 公钥经 JWKS</text>
<text class="ts" x="606" y="106">  各服务本地验签</text>
<text class="ts" x="606" y="128">• 零信任：不因“在</text>
<text class="ts" x="606" y="146">  内网”就免校验</text>
<text class="ts" x="606" y="168">• 服务间：透传用户</text>
<text class="ts" x="606" y="186">  令牌 或 用客户端</text>
<text class="ts" x="606" y="204">  凭证换“机器令牌”</text>
<text class="ts" x="606" y="226">• 最小 scope，按</text>
<text class="ts" x="606" y="244">  接口检查权限</text>
<text class="ts" x="606" y="266">• mTLS 加固内网</text>
</svg>
<figcaption>图 6：网关 + 资源服务器的双层校验</figcaption>
</figure>

**常见做法与取舍**：

| 做法 | 优点 | 风险 |
| --- | --- | --- |
| 仅网关验令牌，下游信任内部头（如 `X-User-Id`） | 简单、下游轻量 | **内网任一服务被攻破或绕过网关即可伪造身份**；需要网络隔离与签名内部头 |
| **网关验 + 每个服务再验（推荐）** | 零信任、纵深防御 | 每个服务多一次本地验签（很快） |
| 服务间调用 | 透传用户令牌（保留用户上下文） 或 **Client Credentials** 获取机器令牌（后台任务） | 透传要注意令牌受众（`aud`）与 scope 缩小 |

参考 [Spring Cloud 微服务全景](#/spring/cloud)、[限流、熔断与降级](#/distributed/governance)（网关层限流与防爆破）。

## 七、权限模型

| 模型 | 思想 | 适用 |
| --- | --- | --- |
| **ACL** | 对**每个资源**列出谁能做什么 | 文件系统、小系统 |
| **RBAC**（基于角色） | 用户 → 角色 → 权限，**最常用** | 后台管理、企业应用 |
| **ABAC**（基于属性） | 根据用户/资源/环境的**属性**用策略判断（“部门=财务 且 金额<1万 且 工作时间”） | 细粒度、动态策略（OPA、Casbin） |
| **ReBAC**（基于关系） | 按“关系图”授权（“是文档所有者的同事”） | 协作类产品（Google Zanzibar 思想） |

**RBAC 数据模型**：`user`、`role`、`permission`、`user_role`、`role_permission`，菜单/按钮/接口权限都是 permission 的不同类型。进阶需求：**角色继承、数据权限（行级：本部门/本人/全部）、多租户隔离、权限变更的缓存与即时生效**。

数据权限的两种做法：**SQL 层自动追加条件**（MyBatis 拦截器按用户范围追加 `AND dept_id IN (...)`，要谨慎处理漏改与复杂查询）、**业务层显式过滤**。**租户隔离优先在数据访问层强制，不依赖开发者每处手写**。

## 八、常见坑与最佳实践

| 坑 | 对策 |
| --- | --- |
| JWT 存 `localStorage`，被 XSS 偷走 | 浏览器优先用 **HttpOnly + Secure + SameSite Cookie**；令牌短期；严格 CSP |
| Cookie 方案被 CSRF | **SameSite=Lax/Strict** + CSRF Token（见 [Web 安全：OWASP 常见漏洞与防护](#/security/web)） |
| 签名密钥写死/泄露 | 放 KMS/配置中心；**轮换密钥**，`kid` 区分；非对称签名，私钥只在认证服务 |
| 不校验 `aud`/`iss` | 令牌被拿到别的服务重用（令牌混淆）；严格校验受众与签发者 |
| 把 JWT 当加密 | Payload 可读，别放敏感信息 |
| 越权（IDOR） | **每个接口校验资源归属**；ID 不可预测只是辅助，不是授权 |
| 登录接口被爆破/撞库 | 限流、验证码、账号锁定/延迟、异常登录告警、MFA |
| 密码存储 | **bcrypt / Argon2** 加盐慢哈希，见 [加密、签名、HTTPS 与密钥管理](#/security/crypto) |
| 忘记登出/改密后令牌仍有效 | token 版本号/黑名单；Refresh Token 吊销 |
| `SecurityContext` 在异步中丢失 | 用安全上下文传播的执行器；虚拟线程注意作用域 |
| 前端做权限控制当作安全 | 前端隐藏按钮只是体验，**后端必须校验** |
| 开放重定向 | `redirect_uri` 必须**精确匹配白名单** |
| 日志打印令牌/密码 | 日志脱敏，见 [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace) |

## 面试追问

> [!QUESTION] Session 和 JWT 有什么区别？各自适用什么场景？JWT 如何实现登出？
> Session 状态在服务端，易撤销但多实例需共享存储；JWT 自包含无状态，易扩展但签发后难撤销。传统 Web 用 Session，前后端分离、移动端、微服务用 JWT。JWT 登出靠短期 Access Token 加可轮换的 Refresh Token，并用 jti 黑名单或用户令牌版本号让旧令牌失效。

> [!QUESTION] OAuth2 授权码模式的流程？为什么需要 PKCE？
> 客户端把用户重定向到授权服务器登录并授权，授权服务器回调返回一次性授权码，客户端再用授权码（加 code_verifier）向令牌端点换取令牌，最后用访问令牌调用资源服务器。授权码经前端通道传递可能被截获，PKCE 让没有 code_verifier 的攻击者换不到令牌，使公开客户端也安全。

> [!QUESTION] OAuth2 和 OIDC 的区别？ID Token 和 Access Token 各用于什么？
> OAuth2 解决授权，说明令牌能访问什么资源；OIDC 在其上增加身份层，用 ID Token 告诉客户端用户是谁。ID Token 给客户端识别登录用户，Access Token 用来调用资源服务器 API，不能混用。

> [!QUESTION] Spring Security 的认证流程是怎样的？
> 请求经过过滤器链，认证过滤器提取凭证构造未认证的 Authentication，交给 ProviderManager 遍历 AuthenticationProvider，DaoAuthenticationProvider 通过 UserDetailsService 取用户并用 PasswordEncoder 校验，成功后返回带权限的已认证对象并存入 SecurityContext，授权阶段由 AuthorizationFilter 或方法安全校验。

> [!QUESTION] 微服务里怎么设计统一认证？
> 独立授权服务器签发 JWT 并通过 JWKS 分发公钥；网关统一验令牌并做限流；每个业务服务作为资源服务器再本地验签并做细粒度和数据权限校验，服务间调用透传用户令牌或使用客户端凭证，遵循零信任，不因为在内网就免校验。

> [!QUESTION] 如何防止水平越权？
> URL 级角色授权不够，必须在业务或方法层校验资源归属，例如查询订单时带上当前登录用户 ID 作为条件，或用 @PostAuthorize 校验返回对象的所有者；资源 ID 不可预测只是辅助手段，不能代替授权。
