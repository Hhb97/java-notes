---
level: 进阶
tags: [加密, 哈希, HMAC, AES-GCM, RSA, 签名, bcrypt, TLS, mTLS, KMS, 密钥管理]
summary: 后端工程师用得到的密码学：哈希、HMAC、对称与非对称加密、数字签名、密码存储（bcrypt/Argon2）、TLS 握手与 PKI/mTLS、信封加密与 KMS、接口签名防重放，以及哪些写法一定不能用。
---

# 加密、签名、HTTPS 与密钥管理

> [!ABSTRACT] 核心要点
> - 先分清目的：**哈希**（完整性/指纹，不可逆）、**HMAC**（带密钥的完整性与认证）、**对称加密**（保密，快）、**非对称加密**（密钥分发）、**数字签名**（不可抵赖与防篡改）。
> - **不要自己发明加密方案**：用成熟库与**经过审查的默认参数**（AES-GCM、ChaCha20-Poly1305、SHA-256、Ed25519/ECDSA/RSA-PSS）。
> - **密码存储用慢哈希**（bcrypt / scrypt / Argon2，带随机盐），**绝不能用 MD5/SHA-1/不加盐的 SHA-256**，更不能可逆加密。
> - **HTTPS = 非对称协商密钥 + 对称加密传输 + 证书验证身份**；内部服务间可用 **mTLS** 做双向认证。
> - **密钥管理比算法更重要**：不入库、分层（信封加密）、可轮换、最小权限、有审计，交给 **KMS/HSM/Vault**。

## 一、基础概念速览

| 原语 | 输入 → 输出 | 密钥 | 能做什么 | 典型算法 |
| --- | --- | --- | --- | --- |
| **哈希** | 任意数据 → 固定长度摘要 | 无 | 完整性校验、指纹、去重 | SHA-256/512、SHA-3 |
| **HMAC** | 数据 + 密钥 → 摘要 | 共享密钥 | 防篡改 + 验证来源（持有密钥） | HMAC-SHA256 |
| **对称加密** | 明文 + 密钥 → 密文 | 同一个密钥 | 保密（快，适合大数据） | AES-GCM、ChaCha20-Poly1305 |
| **非对称加密** | 公钥加密、私钥解密 | 公钥/私钥 | 密钥交换、少量数据加密 | RSA-OAEP、ECDH |
| **数字签名** | 私钥签名、公钥验证 | 公钥/私钥 | 防篡改 + 身份 + 不可抵赖 | Ed25519、ECDSA、RSA-PSS |

关键区别：**编码（Base64）不是加密**；**哈希不是加密**（不可逆）；**签名不保密**（内容可见，只保证没被改、是谁签的）。

## 二、哈希与 HMAC

```java
// SHA-256 摘要：文件校验、去重指纹
MessageDigest md = MessageDigest.getInstance("SHA-256");
byte[] digest = md.digest(data);

// HMAC-SHA256：验证“来自持有密钥的一方”且“未被篡改”（Webhook 签名、接口签名）
Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(secret, "HmacSHA256"));
byte[] tag = mac.doFinal(payload);
// 比较时使用常量时间比较，防时序攻击：MessageDigest.isEqual(tag, received)
```

注意：

- **MD5、SHA-1 已被攻破碰撞**，不可用于安全场景（仅可作非安全校验）；
- **普通哈希不能直接用来存密码**（太快，易暴力破解/彩虹表）；
- 比较摘要/签名用**常量时间比较**，不要用 `equals`。

## 三、密码存储

<figure class="fig">
<svg viewBox="0 0 780 260" class="dg" role="img" aria-label="密码存储方案对比：明文和可逆加密最差，MD5 与无盐哈希可被彩虹表快速破解，加盐哈希略好，慢哈希 bcrypt scrypt Argon2 带随机盐和可调成本因子是推荐做法">
<rect class="b4" x="20" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="90" y="52" text-anchor="middle" dominant-baseline="middle">明文 / 可逆加密</text>
<text class="ts" x="90" y="74" text-anchor="middle">泄露即全部暴露</text>
<rect class="b4" x="180" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="250" y="52" text-anchor="middle" dominant-baseline="middle">MD5 / SHA 无盐</text>
<text class="ts" x="250" y="74" text-anchor="middle">彩虹表秒破</text>
<rect class="b5" x="340" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="410" y="52" text-anchor="middle" dominant-baseline="middle">SHA + 盐</text>
<text class="ts" x="410" y="74" text-anchor="middle">GPU 仍可高速暴破</text>
<rect class="b2" x="500" y="30" width="260" height="64" rx="8"/>
<text class="tb" x="630" y="52" text-anchor="middle" dominant-baseline="middle">bcrypt / scrypt / Argon2id</text>
<text class="ts" x="630" y="74" text-anchor="middle">随机盐 + 可调成本（故意慢、耗内存）</text>
<line class="l" x1="90" y1="110" x2="630" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="90" y="130" text-anchor="start">安全性 ↑</text>
<rect class="bg" x="20" y="150" width="740" height="92" rx="10"/>
<text class="th" x="36" y="172">要点</text>
<text class="ts" x="36" y="194">• 每个用户独立随机盐（库已内置，存入同一字符串）；成本因子随硬件增长定期上调（bcrypt cost ≥ 10~12）</text>
<text class="ts" x="36" y="212">• 登录校验：重新计算并常量时间比较；升级算法时在用户下次登录时“透明迁移”</text>
<text class="ts" x="36" y="230">• 额外：全局 pepper（存在 KMS，不与数据库放一起）、登录限流与验证码、泄露口令库检查</text>
</svg>
<figcaption>图 1：密码存储方案的安全层级</figcaption>
</figure>

```java
// Spring Security 提供的 DelegatingPasswordEncoder：存储格式 {bcrypt}$2a$10$...，便于以后无缝换算法
PasswordEncoder enc = PasswordEncoderFactories.createDelegatingPasswordEncoder();
String stored = enc.encode(rawPassword);
boolean ok = enc.matches(rawPassword, stored);
if (ok && enc.upgradeEncoding(stored)) { /* 登录成功后用新算法/新成本重新哈希并更新 */ }
```

> [!WARNING] bcrypt 只处理前 72 字节
> 超长密码会被截断，且慢哈希会被“超大密码输入”拖成 DoS。限制密码长度（如 8~64），必要时先做一次 SHA-256 预处理（注意不要引入空字节问题）。

## 四、对称加密：AES-GCM

对称加密要选**带认证的模式（AEAD）**：不仅保密，还能检测密文被篡改。**AES-GCM** 最常用。

```java
byte[] iv = new byte[12];                         // GCM 推荐 12 字节随机 IV（nonce）
SecureRandom.getInstanceStrong().nextBytes(iv);   // 同一密钥下 IV 绝不能重复！否则 GCM 安全性崩溃
Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
c.updateAAD(header);                              // 可选：绑定上下文（如用户ID、版本），不被加密但被认证
byte[] ct = c.doFinal(plaintext);                 // 输出 = 密文 + 16 字节认证标签
// 存储/传输：version | iv | ct；解密时验证失败会抛 AEADBadTagException
```

禁忌：

| 错误做法 | 原因 |
| --- | --- |
| **ECB 模式**（`AES` 默认或 `AES/ECB/...`） | 相同明文块产生相同密文，泄露模式（经典的企鹅图） |
| **CBC 无认证 + PKCS5 padding** | 易受填充预言攻击（Padding Oracle）、可被篡改 |
| **固定/可预测 IV**，GCM 重复 nonce | 破坏机密性甚至泄露密钥相关信息 |
| **用口令直接当密钥**、硬编码密钥 | 口令熵低；密钥写进代码等于公开 |
| 自己拼装“加密+校验” | 顺序错误易出漏洞；用 AEAD |
| `Random` 生成密钥/IV | 必须用 `SecureRandom` |

## 五、非对称加密与数字签名

- **RSA**：密钥 ≥ 2048 位（建议 3072）；**加密用 OAEP**，不要用 PKCS#1 v1.5；**签名用 PSS** 或 `SHA256withRSA`；
- **ECC**：更短的密钥相同安全度。**Ed25519**（签名）/ **X25519**（密钥交换）简单安全快速；ECDSA（P-256）广泛支持；
- 非对称加密**慢且只能加密小数据**，所以实际做法是 **“用非对称协商/保护一个对称密钥，再用对称加密数据”**（混合加密，TLS 与信封加密都是如此）。

```java
// 签名与验证（Ed25519，JDK 15+）
KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
Signature s = Signature.getInstance("Ed25519");
s.initSign(kp.getPrivate()); s.update(data); byte[] sig = s.sign();
s.initVerify(kp.getPublic()); s.update(data); boolean ok = s.verify(sig);
```

**签名的典型用途**：JWT（RS256/ES256，见 [认证授权](#/security/auth)）、软件包/镜像签名、电子合同、**支付回调/开放平台的请求签名**（见下文）。

## 六、HTTPS / TLS

### 1. TLS 1.3 握手（简化）

<figure class="fig">
<svg viewBox="0 0 780 360" class="dg" role="img" aria-label="TLS 1.3 握手：客户端发送 ClientHello 带支持算法和密钥共享，服务端返回 ServerHello 密钥共享、证书与签名，双方推导出会话密钥后用对称加密传输应用数据，客户端验证证书链与域名">
<rect class="b1" x="40" y="20" width="140" height="34" rx="6"/>
<text class="tb" x="110" y="37" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b3" x="600" y="20" width="140" height="34" rx="6"/>
<text class="tb" x="670" y="37" text-anchor="middle" dominant-baseline="middle">服务端</text>
<line class="ld" x1="110" y1="54" x2="110" y2="344"/>
<line class="ld" x1="670" y1="54" x2="670" y2="344"/>
<line class="l" x1="110" y1="86" x2="670" y2="86" marker-end="url(#arr)"/>
<text class="ts" x="390" y="78" text-anchor="middle">① ClientHello：支持的套件 + 随机数 + 密钥共享（ECDHE 公钥）+ SNI</text>
<line class="la" x1="670" y1="132" x2="110" y2="132" marker-end="url(#arr-a)"/>
<text class="ta" x="390" y="112" text-anchor="middle">② ServerHello：选定套件 + 密钥共享（ECDHE 公钥）</text>
<text class="ta" x="390" y="126" text-anchor="middle">双方各自算出相同的共享密钥 → 之后消息都已加密</text>
<line class="la" x1="670" y1="176" x2="110" y2="176" marker-end="url(#arr-a)"/>
<text class="ta" x="390" y="168" text-anchor="middle">③ 证书链 + CertificateVerify（用私钥签名）+ Finished</text>
<text class="ts" x="120" y="206" text-anchor="start">客户端校验：证书链到受信根 CA、域名匹配、未过期、未吊销</text>
<line class="l" x1="110" y1="236" x2="670" y2="236" marker-end="url(#arr)"/>
<text class="ts" x="390" y="228" text-anchor="middle">④ Finished（握手完整性确认）</text>
<line class="l" x1="110" y1="280" x2="670" y2="280" marker-end="url(#arr)"/>
<line class="la" x1="670" y1="304" x2="110" y2="304" marker-end="url(#arr-a)"/>
<text class="ts" x="390" y="272" text-anchor="middle">⑤ 应用数据：AES-GCM / ChaCha20 对称加密传输</text>
<text class="ts" x="390" y="332" text-anchor="middle">TLS 1.3 只需 1-RTT（恢复会话可 0-RTT，但有重放风险）；前向保密：长期私钥泄露也解不开历史流量</text>
</svg>
<figcaption>图 2：TLS 1.3 握手：非对称做认证与密钥协商，对称做数据传输</figcaption>
</figure>

要点：

- **ECDHE 临时密钥** 带来**前向保密（PFS）**：每个连接独立会话密钥，即使服务器私钥以后泄露，历史流量也无法解密；
- **证书**证明“这个公钥属于该域名”，由 **CA 签发**，客户端沿**证书链**验到系统受信根；
- 服务端配置：只启用 **TLS 1.2/1.3**，禁用 SSLv3/TLS1.0/1.1 及弱套件；开启 HSTS；证书到期监控（自动续期：ACME/Let's Encrypt）；
- **TLS 终止位置**：通常在网关/LB（Nginx）终止，内部再用 mTLS 或内网隔离，见 [Nginx](#/infra/nginx)、[TCP 与 HTTP](#/infra/network)。

### 2. PKI 与 mTLS

| 概念 | 说明 |
| --- | --- |
| **根 CA / 中间 CA** | 信任锚；中间 CA 签发叶子证书，根离线保存 |
| **自签/私有 CA** | 企业内部服务使用，需把私有根分发到信任库 |
| **mTLS（双向 TLS）** | 服务端也验证**客户端证书**，用于服务间零信任、IoT 设备认证（见 [MQTT](#/iot/mqtt)） |
| 服务网格 | Istio/Linkerd 自动签发与轮换工作负载证书，透明 mTLS |

Java 里常见坑：

- **关闭证书校验**（自定义 `TrustManager` 信任所有、`HostnameVerifier` 恒真）——这等于没有 HTTPS，必须禁止；
- 私有 CA 证书导入 **truststore**（`keytool -importcert`），而不是关校验；
- 证书过期导致线上故障——**到期监控与自动续期**。

## 七、密钥管理

### 1. 信封加密（Envelope Encryption）

直接用主密钥加密大量数据既慢又难轮换。做法：**用数据密钥（DEK）加密数据，用主密钥（KEK/CMK）加密 DEK**，主密钥只在 KMS/HSM 内，永不出来。

<figure class="fig">
<svg viewBox="0 0 780 290" class="dg" role="img" aria-label="信封加密：应用向 KMS 请求生成数据密钥，KMS 返回明文数据密钥和被主密钥加密的数据密钥，应用用明文数据密钥加密数据后丢弃明文密钥，把密文数据与加密后的数据密钥一起存储，解密时先让 KMS 解开数据密钥">
<rect class="b1" x="20" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="58" text-anchor="middle" dominant-baseline="middle">应用服务</text>
<rect class="b3" x="320" y="30" width="170" height="56" rx="8"/>
<text class="tb" x="405" y="50" text-anchor="middle" dominant-baseline="middle">KMS / HSM</text>
<text class="ts" x="405" y="70" text-anchor="middle">主密钥 KEK 不出库</text>
<rect class="b2" x="620" y="30" width="140" height="56" rx="8"/>
<text class="tb" x="690" y="50" text-anchor="middle" dominant-baseline="middle">存储</text>
<text class="ts" x="690" y="70" text-anchor="middle">DB / 对象存储</text>
<line class="l" x1="170" y1="46" x2="320" y2="46" marker-end="url(#arr)"/>
<text class="ts" x="245" y="38" text-anchor="middle">① GenerateDataKey</text>
<line class="la" x1="320" y1="72" x2="170" y2="72" marker-end="url(#arr-a)"/>
<text class="ta" x="245" y="94" text-anchor="middle">② 明文 DEK + 密文 DEK</text>
<text class="ts" x="30" y="128" text-anchor="start">③ 用明文 DEK（AES-GCM）加密数据，随后立即清除内存中的明文 DEK</text>
<line class="l" x1="95" y1="150" x2="690" y2="150"/>
<line class="l" x1="690" y1="150" x2="690" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="390" y="142" text-anchor="middle">④ 存：密文数据 + 密文 DEK（+ 密钥版本）</text>
<rect class="bg" x="20" y="176" width="740" height="94" rx="10"/>
<text class="th" x="36" y="198">好处</text>
<text class="ts" x="36" y="220">• 主密钥轮换只需重新加密 DEK（几十字节），不用重加密全部数据　• 每条/每批数据独立 DEK，泄露面小</text>
<text class="ts" x="36" y="240">• 解密：把密文 DEK 交给 KMS 解开（需要 IAM 授权并留审计）→ 在内存中解密数据</text>
<text class="ts" x="36" y="260">• 云上 KMS（AWS KMS / 阿里云 KMS）、自建 HashiCorp Vault / Transit、硬件 HSM；本地缓存 DEK 减少调用并设 TTL</text>
</svg>
<figcaption>图 3：信封加密：主密钥不出 KMS，数据密钥随数据存放</figcaption>
</figure>

### 2. 密钥生命周期与实践

| 环节 | 实践 |
| --- | --- |
| 生成 | 用 KMS/`SecureRandom`，足够长度；不使用口令直接作密钥（需要时用 PBKDF2/Argon2 派生） |
| 存放 | **不进代码、不进 Git、不放普通配置**；用 KMS、Vault、K8s Secret（配合加密/外部密钥管理）、云厂商 Secret Manager |
| 分发 | 运行时注入（环境变量/挂载/Sidecar），日志与监控不得打印 |
| 权限 | 最小权限，不同服务/环境不同密钥；生产与测试隔离 |
| 轮换 | 定期 + 泄露即换；数据里带 **密钥版本号**，支持新旧并存解密（`kid`） |
| 审计 | 记录谁在何时用了哪个密钥；异常调用告警 |
| 销毁 | 数据下线时可通过销毁密钥实现“加密删除” |

> [!WARNING] 密钥一旦进过 Git 历史，就视为已泄露
> 删除提交不够，必须**立刻轮换**。在 CI 里加 gitleaks/trufflehog 扫描，并开启平台的 secret scanning。

敏感数据（手机号、身份证、银行卡）的落库建议：**加密存储 + 查询用“盲索引”**（对明文做 HMAC 得到可等值检索的列），**展示脱敏**，**日志脱敏**，**最小化收集与留存**，并满足合规要求（如个人信息保护法、PCI DSS 对卡号的要求）。

## 八、接口签名与防重放

开放平台、支付回调、跨系统调用常用：**用共享密钥对请求签名**，服务端验证。

```text
签名串 = HTTP方法 \n 路径 \n 规范化后的排序参数 \n 时间戳 \n 随机数 nonce \n body 的 SHA-256
signature = HMAC-SHA256(secret, 签名串)   // 或使用私钥做 RSA/ECDSA 签名（对方持公钥验证，便于多方）
请求头：X-App-Id, X-Timestamp, X-Nonce, X-Signature
```

服务端验证步骤：

1. 按 `appId` 取出密钥（或公钥）；
2. **时间戳在容忍窗口内**（如 ±5 分钟），防止过期请求被长期重放；
3. **nonce 去重**：Redis `SET nonce NX EX 600`，已存在则拒绝（窗口内同一请求不可重放）；
4. 重新计算签名并**常量时间比较**；
5. **签名必须覆盖所有影响语义的内容**：方法、路径、参数、body（否则可被篡改未签部分）。

对比：**HMAC（对称）**简单，但双方都知道密钥，无法证明是谁签的；**非对称签名**只有一方持私钥，可抵赖性更弱，适合多方/开放场景（支付宝、微信支付均用 RSA/国密）。参考支付回调场景：[订单、支付与对账系统设计详解](#/design/case-payment)，幂等见 [分布式 ID 与幂等](#/distributed/id)。

## 九、国密与合规（了解）

国内合规场景要求使用 **SM2（非对称）、SM3（哈希）、SM4（对称）**，TLS 有对应国密套件。Java 中可用 BouncyCastle 提供；对接政务/金融/支付常见。选型以合规要求为准，**接口保持算法可替换**（带 `alg`/版本号字段）。

## 十、速查：该用什么

| 需求 | 推荐 | 避免 |
| --- | --- | --- |
| 存用户密码 | bcrypt / Argon2id | MD5、SHA-1、无盐 SHA-256、可逆加密 |
| 数据保密（字段/文件） | AES-256-GCM + KMS 信封加密 | ECB、固定 IV、硬编码密钥 |
| 防篡改 + 验来源（双方共享密钥） | HMAC-SHA256 | 普通哈希、自创拼接 |
| 防篡改 + 验身份（多方） | Ed25519 / ECDSA / RSA-PSS 签名 | RSA 1024、MD5withRSA |
| 传输安全 | TLS 1.2/1.3（+ HSTS，必要时 mTLS） | 关闭证书校验、过时协议 |
| 随机数（令牌、盐、IV、密钥） | `SecureRandom` | `Random`、`Math.random()`、时间戳 |
| 密钥保管 | KMS/Vault/Secret Manager + 轮换 | 代码/配置文件/Git |

## 面试追问

> [!QUESTION] 对称加密和非对称加密的区别？HTTPS 是怎么结合两者的？
> 对称加密同一密钥加解密，速度快适合大数据，难点是密钥分发；非对称用公私钥，慢但解决密钥交换与身份认证。HTTPS 握手时用 ECDHE 非对称协商出共享密钥，并用证书和签名验证服务端身份，之后数据用 AES-GCM 等对称加密传输。

> [!QUESTION] 用户密码应该怎么存储？为什么不能用 MD5 或加盐 SHA-256？
> 用 bcrypt、scrypt 或 Argon2 这类带随机盐、成本可调的慢哈希。MD5 和普通 SHA 计算极快，GPU 可每秒尝试数十亿次，彩虹表和暴力破解很容易，慢哈希刻意消耗时间和内存提高破解成本，成本因子还可随硬件升级。

> [!QUESTION] HTTPS 握手过程？什么是前向保密？
> 客户端发送支持的套件和密钥共享，服务端返回选定套件、密钥共享、证书和签名，客户端校验证书链和域名后双方推导会话密钥，再用对称加密传输。前向保密指每个连接用临时 ECDHE 密钥，即使服务器长期私钥日后泄露也无法解密历史流量。

> [!QUESTION] 什么是信封加密？为什么要这样做？
> 用数据密钥加密数据，再用 KMS 中的主密钥加密数据密钥，密文数据和密文数据密钥一起存储。主密钥永不出 KMS，轮换时只需重新加密数据密钥而不用重加密全部数据，每份数据可有独立密钥，解密需要 KMS 授权并留审计。

> [!QUESTION] 如何设计一个防篡改、防重放的开放接口签名？
> 用 HMAC 或非对称签名覆盖方法、路径、排序后的参数、时间戳、nonce 和 body 摘要；服务端校验时间戳在窗口内、用 Redis 对 nonce 做去重、重新计算签名并常量时间比较；签名必须覆盖所有影响语义的字段，密钥可轮换并带版本号。

> [!QUESTION] AES-GCM 使用中最容易犯的错误是什么？
> 在同一密钥下重复使用 nonce，会破坏机密性和认证性；其次是硬编码密钥、不校验认证标签失败、用不安全随机数生成 IV，以及误用 ECB 或无认证的 CBC 模式。
