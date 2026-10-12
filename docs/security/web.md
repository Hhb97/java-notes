---
level: 进阶
tags: [安全, OWASP, SQL注入, XSS, CSRF, SSRF, IDOR, 反序列化, Log4Shell, CSP]
summary: 按 OWASP Top 10 的思路梳理后端最常遇到的漏洞：访问控制失效（越权/IDOR）、注入、XSS、CSRF、SSRF、反序列化与 Log4Shell、文件上传、安全响应头与依赖供应链，每类给出原理、Java 里的典型错误写法与可落地的防护。
---

# Web 安全：OWASP 常见漏洞与防护

> [!ABSTRACT] 核心要点
> - 安全的底层原则只有两条：**永远不信任输入**（校验、编码、参数化）和**默认拒绝**（最小权限、白名单）。
> - 现实里最高发的是**访问控制失效**（越权、IDOR）和**注入**（SQL/命令/表达式）；**SSRF、不安全的反序列化、供应链（依赖漏洞）**在云与微服务时代越来越重要。
> - 防护要**分层**：输入校验 → 输出编码 → 框架默认安全能力 → 网关/WAF → 安全响应头 → 监控审计。任何单层都会被绕过。
> - 漏洞修复的关键不是“过滤关键字”（黑名单总能绕），而是**从机制上消除**：参数化查询、上下文相关的输出编码、白名单、禁用危险功能。

> [!NOTE] 范围
> 本页聚焦后端开发者必须掌握的部分，不替代专业渗透测试。涉及认证授权机制见 [认证授权：Session、JWT、OAuth2 与 Spring Security](#/security/auth)，加密与密钥见 [加密、签名、HTTPS 与密钥管理](#/security/crypto)。

## 一、全景：OWASP Top 10 怎么记

<figure class="fig">
<svg viewBox="0 0 780 330" class="dg" role="img" aria-label="Web 安全纵深防御：请求自外向内依次经过网络与 WAF、网关与限流、认证授权、输入校验、业务逻辑与数据访问、日志审计，每一层都拦截一类攻击">
<rect class="bg" x="20" y="20" width="740" height="290" rx="14"/>
<text class="th" x="36" y="44">纵深防御：每层拦一类问题</text>
<rect class="b1" x="40" y="60" width="160" height="56" rx="8"/>
<text class="tb" x="120" y="80" text-anchor="middle" dominant-baseline="middle">边缘 / WAF</text>
<text class="ts" x="120" y="100" text-anchor="middle">DDoS · 扫描 · 已知攻击特征</text>
<rect class="b3" x="220" y="60" width="160" height="56" rx="8"/>
<text class="tb" x="300" y="80" text-anchor="middle" dominant-baseline="middle">网关</text>
<text class="ts" x="300" y="100" text-anchor="middle">限流 · 验令牌 · 协议校验</text>
<rect class="b4" x="400" y="60" width="160" height="56" rx="8"/>
<text class="tb" x="480" y="80" text-anchor="middle" dominant-baseline="middle">认证 / 授权</text>
<text class="ts" x="480" y="100" text-anchor="middle">越权 · IDOR · 会话</text>
<rect class="b5" x="580" y="60" width="160" height="56" rx="8"/>
<text class="tb" x="660" y="80" text-anchor="middle" dominant-baseline="middle">输入校验</text>
<text class="ts" x="660" y="100" text-anchor="middle">类型 · 长度 · 白名单</text>
<rect class="b2" x="130" y="160" width="190" height="56" rx="8"/>
<text class="tb" x="225" y="180" text-anchor="middle" dominant-baseline="middle">业务 / 数据访问</text>
<text class="ts" x="225" y="200" text-anchor="middle">参数化 SQL · 最小权限账号</text>
<rect class="b2" x="340" y="160" width="190" height="56" rx="8"/>
<text class="tb" x="435" y="180" text-anchor="middle" dominant-baseline="middle">输出</text>
<text class="ts" x="435" y="200" text-anchor="middle">上下文编码 · 安全响应头 · CSP</text>
<rect class="b3" x="550" y="160" width="190" height="56" rx="8"/>
<text class="tb" x="645" y="180" text-anchor="middle" dominant-baseline="middle">审计 / 监控</text>
<text class="ts" x="645" y="200" text-anchor="middle">敏感操作日志 · 异常告警</text>
<line class="l" x1="200" y1="88" x2="220" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="88" x2="400" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="88" x2="580" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="188" x2="340" y2="188" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="188" x2="550" y2="188" marker-end="url(#arr)"/>
<text class="ts" x="380" y="256" text-anchor="middle">黑名单过滤易被绕过 → 优先用“机制上不可能”的方案：参数化、编码、白名单、禁用危险特性</text>
<text class="ts" x="380" y="280" text-anchor="middle">依赖与镜像层面：SCA 扫描（依赖漏洞）· 镜像扫描 · 密钥不入库 · 最小权限运行</text>
</svg>
<figcaption>图 1：分层防御，而不是单点过滤</figcaption>
</figure>

| 风险类别（OWASP 思路） | 本页对应 | 一句话 |
| --- | --- | --- |
| 访问控制失效 | 二 | 越权访问别人的数据/功能 |
| 注入 | 三 | 输入被当成代码执行 |
| 跨站脚本 XSS | 四 | 恶意脚本在用户浏览器运行 |
| CSRF | 五 | 借用户登录态发起非本意请求 |
| SSRF | 六 | 让服务器替攻击者访问内网 |
| 不安全反序列化 / 组件漏洞 | 七 | 数据变代码、依赖有洞 |
| 文件上传 | 八 | 上传可执行文件、路径穿越 |
| 配置错误 / 响应头 | 九 | 默认配置、信息泄露 |

## 二、访问控制失效：越权与 IDOR

最常见、危害最大、**自动化扫描最难发现**的一类，必须靠设计与评审。

- **水平越权（IDOR）**：改 URL 中的 id 就能看别人的数据。
- **垂直越权**：普通用户调用管理员接口。
- **功能级缺失**：前端隐藏按钮，但后端没校验。
- **批量赋值（Mass Assignment）**：请求体里多带 `role=ADMIN`、`balance=999` 被框架直接绑定到实体。

```java
// ✗ 只校验“已登录”，不校验归属：改 orderId 就能看别人订单
@GetMapping("/orders/{id}")
public Order get(@PathVariable long id) { return orderRepo.findById(id).orElseThrow(); }

// ✓ 把当前用户作为查询条件，从数据访问层面保证归属
@GetMapping("/orders/{id}")
public Order get(@PathVariable long id, @AuthenticationPrincipal LoginUser u) {
    return orderRepo.findByIdAndUserId(id, u.getId()).orElseThrow(NotFoundException::new);   // 无权与不存在统一返回 404，避免探测
}

// ✗ 直接把请求体绑定到实体，攻击者可传 {"role":"ADMIN"}
public void update(@RequestBody User user) { userRepo.save(user); }
// ✓ 使用专用 DTO，只暴露允许修改的字段
public record UpdateProfileReq(@Size(max = 50) String nickname, @Email String email) {}
```

防护清单：**默认拒绝**、**每次访问校验归属**、**DTO 白名单绑定**、**敏感操作二次校验**、多租户在**数据访问层强制**租户条件、为越权写**自动化测试**（用 A 的令牌访问 B 的资源应得 403/404）。

## 三、注入

### 1. SQL 注入

```java
// ✗ 字符串拼接：name = "x' OR '1'='1" 即可拖库；"x'; DROP TABLE..." 等
String sql = "SELECT * FROM user WHERE name = '" + name + "'";

// ✓ 参数化（预编译）：参数永远只是“值”，不会被解析为 SQL
jdbc.query("SELECT * FROM user WHERE name = ?", mapper, name);
```

MyBatis 里 **`#{}` 是参数化，`${}` 是字符串拼接**：

```xml
<!-- ✓ 安全 -->  where name = #{name}
<!-- ✗ 危险 -->  where name = '${name}'
<!-- 必须用 ${} 的场景：动态列名/表名/排序方向 → 只能走白名单映射，不能直接拼用户输入 -->
order by ${orderBy}   <!-- 先把 orderBy 映射到白名单：{"price","create_time"} -->
```

`IN` 列表用 `<foreach>` 生成多个 `#{}`；`LIKE` 用 `concat('%', #{kw}, '%')` 并转义 `%`、`_`。**数据库账号用最小权限**（应用账号不给 DROP/FILE 等权限），即使被注入影响面也小。

### 2. 其他注入

| 类型 | 典型原因 | 防护 |
| --- | --- | --- |
| **命令注入** | `Runtime.exec("ping " + host)` | 避免调 shell；必须调用时用参数数组 + 白名单校验，不经过 `sh -c` |
| **表达式注入** | 用户输入进入 SpEL/OGNL/EL/模板引擎 | 不要把用户输入当表达式求值；`SimpleEvaluationContext` 限制 SpEL |
| **LDAP / NoSQL 注入** | 拼接过滤条件、把请求体直接当 Mongo 查询 | 参数化 API、转义、校验类型 |
| **日志注入** | 用户输入含换行伪造日志 | 日志参数化、过滤换行，结构化日志 |
| **模板注入（SSTI）** | 模板内容可被用户控制 | 模板与数据分离，沙箱 |

## 四、XSS：跨站脚本

攻击者让恶意脚本在**受害者浏览器、受信站点的上下文**里执行：偷 Cookie/令牌、冒充用户操作、钓鱼。

| 类型 | 说明 |
| --- | --- |
| 存储型 | 恶意内容存入数据库（评论、昵称），所有查看者中招，危害最大 |
| 反射型 | 恶意内容在 URL 参数里，服务端原样回显 |
| DOM 型 | 前端 JS 把不可信数据写入 `innerHTML` / `document.write` / `eval` |

**核心防护：输出时按上下文编码**（HTML 正文、属性、JS、URL 的编码规则各不同）。

```java
// 模板引擎默认转义（Thymeleaf th:text、Vue {{ }}、React JSX 默认转义），不要绕过它：
//   ✗ th:utext / v-html / dangerouslySetInnerHTML：只对“可信或已净化”的内容使用
// 必须允许富文本时：服务端用白名单净化库（如 OWASP Java HTML Sanitizer / jsoup Safelist）
PolicyFactory policy = Sanitizers.FORMATTING.and(Sanitizers.LINKS);
String safe = policy.sanitize(userHtml);
```

纵深防御：

- **CSP（内容安全策略）**：`Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'`，禁止内联脚本和外域脚本，即使有注入点也难利用；
- Cookie 设 **`HttpOnly`**（脚本读不到）、`Secure`、`SameSite`；
- 前端避免 `innerHTML`，用 `textContent`；
- **“输入过滤”不是 XSS 的主要手段**，真正解决靠“输出编码 + CSP”。

## 五、CSRF：跨站请求伪造

用户已登录 A 站（浏览器自动带 Cookie），访问恶意站 B，B 让浏览器向 A 发起一个转账/改密请求——**浏览器会带上 A 的 Cookie**，服务器误以为是用户本意。

<figure class="fig">
<svg viewBox="0 0 780 250" class="dg" role="img" aria-label="CSRF 攻击与防护：用户已登录银行站点，访问恶意网站后恶意页面向银行发起转账请求，浏览器自动携带银行 Cookie；防护手段为 SameSite Cookie、CSRF Token 和校验 Origin">
<rect class="b1" x="20" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="85" y="55" text-anchor="middle" dominant-baseline="middle">用户浏览器</text>
<rect class="b4" x="330" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="395" y="55" text-anchor="middle" dominant-baseline="middle">恶意站点 B</text>
<rect class="b3" x="630" y="30" width="130" height="50" rx="8"/>
<text class="tb" x="695" y="55" text-anchor="middle" dominant-baseline="middle">银行站点 A</text>
<line class="l" x1="150" y1="55" x2="330" y2="55" marker-end="url(#arr)"/>
<text class="ts" x="240" y="46" text-anchor="middle">① 用户访问 B</text>
<path class="la nf" d="M395 80 L395 120 L85 120 L85 80" marker-end="url(#arr-a)"/>
<text class="ta" x="240" y="112" text-anchor="middle">② B 的页面让浏览器自动发请求</text>
<line class="l" x1="85" y1="150" x2="695" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="390" y="142" text-anchor="middle">③ POST A/transfer?to=攻击者 （浏览器自动附带 A 的 Cookie）</text>
<rect class="bg" x="20" y="170" width="740" height="66" rx="10"/>
<text class="th" x="36" y="192">防护</text>
<text class="ts" x="36" y="214">① SameSite=Lax/Strict：跨站请求不带 Cookie　② CSRF Token：请求必须带随机令牌（攻击者拿不到）</text>
<text class="ts" x="36" y="230">③ 校验 Origin/Referer　④ 敏感操作二次验证（密码/短信）　⑤ 不用 GET 做修改操作；Bearer Token 放 Header 天然免疫</text>
</svg>
<figcaption>图 2：CSRF 的攻击链与防护</figcaption>
</figure>

要点：

- **只有“浏览器自动携带凭证”（Cookie、HTTP Basic）的方案需要防 CSRF**；用 `Authorization: Bearer` 头、由 JS 显式附加的方案，天然不受 CSRF 影响（但要防 XSS 偷令牌）；
- Spring Security **默认开启 CSRF 防护**，不要在使用 Cookie 会话的站点上随手 `csrf.disable()`；
- 现代浏览器默认 `SameSite=Lax`，但不要只依赖它（旧浏览器、同站子域、GET 修改操作仍有风险）。

## 六、SSRF：服务端请求伪造

功能如“根据 URL 抓取图片/网页预览/Webhook 回调/导入”，如果**服务端直接请求用户提供的 URL**，攻击者可让它访问**内网服务、云元数据（如 `169.254.169.254`）、本机端口**，拿到凭证或打内网。

```java
// ✗ 直接请求用户给的 URL
byte[] img = http.get(req.getUrl());

// ✓ 多重限制：
URI u = URI.create(req.getUrl());
if (!Set.of("http", "https").contains(u.getScheme())) throw new BadRequest();
if (!ALLOWED_HOSTS.contains(u.getHost())) throw new BadRequest();        // 优先白名单域名
InetAddress ip = InetAddress.getByName(u.getHost());                      // 解析后检查是否内网/回环/链路本地
if (ip.isAnyLocalAddress() || ip.isLoopbackAddress() || ip.isSiteLocalAddress() || ip.isLinkLocalAddress())
    throw new BadRequest();
// 连接时必须使用已校验的 IP（防 DNS 重绑定：校验时是公网、请求时解析到内网）；禁止自动跟随重定向到内网
```

防护要点：**协议与域名白名单**、**解析后拒绝内网 IP**、**防 DNS 重绑定与重定向绕过**、**出网流量走受控代理/网络策略限制**、云上开启 **IMDSv2** 并限制元数据访问、不要把响应原文返回给用户（防信息泄露与端口探测）。

## 七、反序列化与依赖漏洞

### 1. 不安全的 Java 反序列化

`ObjectInputStream.readObject()` 在还原对象时会执行类中的方法，攻击者构造“**利用链（gadget chain）**”，让依赖里已有的类被串起来，**最终执行任意命令**（如历史上的 Commons Collections 漏洞）。同类问题：**Fastjson 的 autoType**、**Jackson 的 `enableDefaultTyping`**、XStream、Hessian 等。

防护：

- **不要反序列化不可信数据**；对外接口用 JSON + 明确的 DTO 类型，**关闭多态/autoType**；
- 必须使用 Java 序列化时，设**类白名单过滤器**（`ObjectInputFilter`，JEP 290）；
- 及时升级库；用 **RASP/WAF** 辅助，但不要依赖。

### 2. Log4Shell 的教训（CVE-2021-44228）

Log4j2 对日志内容中的 `${jndi:ldap://...}` 做**查找替换**，导致只要“某个用户输入被打印到日志”就可能远程加载并执行代码。教训：

- **日志输入也是不可信输入**；
- **依赖就是你的攻击面**：必须知道自己用了哪些库（含**传递依赖**）及版本；
- 应急能力：能**快速定位受影响服务**（SBOM 软件物料清单）、**快速升级发布**。

### 3. 依赖与供应链

| 措施 | 工具 / 做法 |
| --- | --- |
| 依赖漏洞扫描（SCA） | OWASP Dependency-Check、Snyk、Dependabot/Renovate、GitHub 安全告警；集成到 CI，高危阻断 |
| 镜像扫描 | Trivy、Grype；基础镜像用精简发行版、定期重建 |
| 锁定版本与校验 | 锁文件、校验和；私有仓库代理；谨慎引入小众依赖（防投毒/抢注） |
| SBOM | CycloneDX / SPDX 生成物料清单，便于事件响应 |
| 最小权限运行 | 容器非 root、只读文件系统、去除不必要的能力 |

参见 [Maven 依赖管理](#/java/eng/maven)、[Docker 与镜像](#/infra/docker)。

## 八、文件上传与路径穿越

```java
// ✗ 直接用原始文件名、不限类型，保存到 Web 可访问目录
file.transferTo(new File("/var/www/uploads/" + file.getOriginalFilename()));   // ../../ 路径穿越；上传 .jsp/.html 被执行
```

安全做法：

- **服务端重新生成文件名**（UUID），不使用用户文件名构造路径；若必须用，规范化后校验仍在目标目录内（`path.normalize().startsWith(base)`）；
- **白名单校验类型**：看**文件内容魔数**，不只信 `Content-Type`/后缀；限制大小；
- 上传文件**不放在可执行/可解析的目录**，用对象存储（OSS/S3）+ **独立域名** + `Content-Disposition: attachment`，避免同源脚本执行（XSS）；
- 图片可二次渲染（重新编码）去掉嵌入内容；对用户上传的压缩包防 **Zip Slip**（解压时条目含 `../`）与**压缩炸弹**；
- 必要时病毒扫描。

## 九、安全响应头与配置

| 响应头 | 作用 |
| --- | --- |
| `Strict-Transport-Security`（HSTS） | 强制浏览器后续只走 HTTPS，防降级与中间人 |
| `Content-Security-Policy` | 限制脚本/资源来源，缓解 XSS |
| `X-Content-Type-Options: nosniff` | 禁止浏览器猜测 MIME 类型 |
| `X-Frame-Options` / CSP `frame-ancestors` | 防点击劫持 |
| `Referrer-Policy` | 控制 Referer 泄露 |
| `Permissions-Policy` | 限制摄像头、定位等能力 |
| Cookie：`HttpOnly; Secure; SameSite` | 保护会话 Cookie |

配置类问题：

- **生产关闭调试与详细错误**：不要向客户端返回堆栈、SQL、内部路径；统一异常处理只返回错误码与追踪 ID；
- **暴露管理端点**：Spring Boot Actuator 的 `/env`、`/heapdump`、`/threaddump` 不得对公网开放；只暴露 `health`，其余加认证与内网限制（见 [Spring Boot](#/spring/boot)）；
- **默认账号/弱口令**、对象存储 Bucket 公开读、数据库/Redis 暴露公网且无密码；
- **跨域 CORS**：不要 `Access-Control-Allow-Origin: *` 同时允许携带凭证，来源用白名单；
- **密钥与口令不进代码仓库**，进了也要视为已泄露并轮换（见 [加密、签名、HTTPS 与密钥管理](#/security/crypto)）；
- **接口防刷**：登录、短信、找回密码做限流与验证码，见 [限流、熔断与降级](#/distributed/governance)。

## 十、安全开发流程

| 阶段 | 实践 |
| --- | --- |
| 设计 | 威胁建模（STRIDE）：数据流、信任边界、最坏情况 |
| 编码 | 安全编码规范、代码评审检查清单、静态扫描（SAST：SonarQube、Semgrep、SpotBugs+FindSecBugs） |
| 构建 | 依赖扫描（SCA）、密钥泄露扫描（gitleaks）、镜像扫描 |
| 测试 | 越权用例、DAST/渗透测试、模糊测试 |
| 运行 | WAF、审计日志、异常告警、定期补丁、应急预案 |

## 面试追问

> [!QUESTION] 如何彻底防止 SQL 注入？MyBatis 中 #{} 和 ${} 的区别？
> 根本做法是参数化查询，让用户输入永远只是值而不是 SQL 片段。MyBatis 的 #{} 走预编译占位符是安全的，${} 是字符串直接拼接会被注入；必须动态列名、排序时用白名单映射。同时数据库账号用最小权限。

> [!QUESTION] XSS 有哪几种？如何防护？
> 存储型、反射型和 DOM 型。主要靠输出时按上下文编码，模板引擎默认转义不要绕过，必须富文本时用白名单净化库；再加 CSP 限制脚本来源，Cookie 设 HttpOnly，前端避免 innerHTML。输入过滤不是主要手段。

> [!QUESTION] CSRF 的原理和防护？使用 JWT 放在 Header 还需要防 CSRF 吗？
> 浏览器自动携带 Cookie，恶意站点可借用户登录态发起请求。防护用 SameSite、CSRF Token、校验 Origin。令牌放 Authorization 头由前端显式附加，浏览器不会自动携带，天然不受 CSRF 影响，但要防 XSS 偷令牌。

> [!QUESTION] 什么是 SSRF？怎么防？
> 服务端按用户提供的 URL 发请求，被利用访问内网和云元数据。防护用协议和域名白名单，解析后拒绝内网、回环和链路本地地址，并用解析出的 IP 连接防 DNS 重绑定，禁止重定向到内网，出网走受控代理，云上启用 IMDSv2。

> [!QUESTION] 越权怎么防？IDOR 是什么？
> IDOR 是通过改动资源 ID 访问他人数据。URL 角色授权不够，要在每次数据访问时把当前用户作为查询条件校验归属，请求体用 DTO 白名单绑定防批量赋值，多租户在数据访问层强制，并写越权自动化测试。

> [!QUESTION] Java 反序列化漏洞原理？Log4Shell 给我们什么启示？
> 反序列化会执行类的方法，攻击者串联依赖中已有类形成利用链实现任意代码执行，防护是不反序列化不可信数据、关闭 autoType、用类白名单过滤器。Log4Shell 说明日志输入也不可信，依赖及传递依赖是攻击面，要有 SBOM 和快速定位与升级的应急能力。
