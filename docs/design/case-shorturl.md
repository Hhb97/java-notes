---
level: 高级
tags: [架构案例, 短链接, 发号器, Base62, 301/302, 缓存, 布隆过滤器, 点击统计, 防刷]
summary: 以千万级日活的短链接服务为例，完整拆解需求与容量估算、短码生成方案（号段发号器 + Base62 对比哈希与随机）、避免可枚举、301/302 的取舍与统计、读多写少的缓存架构（本地缓存 + Redis + 布隆过滤器）、存储与分片、点击统计链路、过期与回收、安全与防刷、故障降级与上线方案。
---

# 案例：短链接服务设计详解

> [!ABSTRACT] 核心要点
> - 短链接服务是**典型的读多写少 + 极简数据模型**：核心只有一个映射 `短码 → 长链接`。难点不在存储，而在**短码怎么生成（唯一、不可枚举、可扩展）**、**读路径如何做到毫秒级且扛住热点**、**统计与安全**。
> - **短码生成首选“号段发号器 + Base62 + 可逆混淆”**：保证**绝不冲突**、写入无需判重、可水平扩展；哈希截断需要处理冲突，纯随机需要判重。自增 ID 直接转 Base62 会**可被枚举**，要做混淆。
> - **读路径是 99% 流量**：**本地缓存（Caffeine）→ Redis → 数据库**三级，加**布隆过滤器**挡住不存在的短码，**热点短码**用本地缓存 + 随机过期时间防击穿。
> - **301（永久）与 302（临时）**：302 每次都经过服务端，**便于统计与封禁**；301 被浏览器缓存，**省流量但丢失统计和管控能力**，通常选 302（或 307）。
> - 点击统计走**异步**：重定向路径只写一条事件到 Kafka，**不能在主路径里同步写库**；离线/实时聚合进 ClickHouse（见 [ClickHouse 行为分析](#/bigdata/ck-analytics)）。
> - 作为公共入口必须考虑**恶意链接、钓鱼与防刷**：创建限流、域名黑名单、内容审核、过期与举报下线。

> [!NOTE] 说明
> 容量数字均为**用于推演的假设**，请按实际业务替换。通用方法见 [高并发系统设计方法论](#/design/method)。

## 一、需求与约束

### 1. 功能

- **生成**：输入长链接，返回短链接（`https://s.example.com/aZ3k9Q`）；可选**自定义短码**、**有效期**；
- **跳转**：访问短链接，重定向到长链接；
- **统计**：访问量、来源、地域、设备等（可延迟分钟级）；
- **管理**：失效/下线/修改目标；用户维度管理自己的短链。

### 2. 非功能目标（假设）

| 维度 | 目标 |
| --- | --- |
| 跳转延迟 | P99 < 20ms（服务端处理），可用性 99.99% |
| 一致性 | 生成后立即可访问（读自己的写）；统计最终一致 |
| 不可预测 | 外部不能通过遍历短码枚举出所有链接 |
| 规模 | 新增 1 亿条/月，读写比约 100:1，保留期按业务（默认长期 / 可设置过期） |

### 3. 容量估算（假设，写出推导）

- **写入**：1 亿 ÷ (30 × 86400 秒) ≈ **40 条/秒**，峰值按 5 倍 ≈ 200 条/秒（很低）；
- **读取**：读写比 100:1 → 平均 **约 4000 次/秒**，峰值（营销活动、热点）按 10 倍 ≈ **4 万次/秒**；热点单链接可能 **数万 QPS**；
- **存储**：每条记录约 500 字节（短码 + 长链接 + 元数据，长链接均 200 字节），5 年 60 亿条 ≈ **3 TB**（含索引翻倍），需要分库分表（见 [分库分表](#/mysql/sharding)）；
- **短码长度**：Base62（0-9a-zA-Z）：6 位 ≈ **568 亿**（62⁶），7 位 ≈ **3.5 万亿**（62⁷）。60 亿条用 **7 位**足够并有大量余量；
- **缓存**：按 80/20 原则，热点约占 20%：1 亿条热点 × 500 B ≈ **50 GB**，Redis 集群可承载；本地缓存仅放最热的几十万条。

## 二、核心设计决策（ADR）

| 决策点 | 方案 | 理由 / 取舍 |
| --- | --- | --- |
| 短码生成 | **号段发号器 + Base62 + 可逆混淆** | 绝不冲突、无需判重、可扩展；混淆防枚举 |
| 重定向码 | **302/307** | 保留统计与管控；301 会被浏览器长期缓存 |
| 存储 | MySQL 分库分表（按短码哈希）+ 后续可迁 KV | 数据模型简单、事务需求少；成熟可控 |
| 读路径 | 本地缓存 + Redis + 布隆过滤器 | 99% 读流量，必须缓存；防穿透 |
| 统计 | 重定向时异步发事件 → Kafka → 流/批聚合 | 主路径零阻塞 |
| 同一长链是否复用 | 可选：按 `hash(long_url)` 去重 | 节省存储，但不同用户统计会混；多数场景**不复用**（每次生成新码） |
| 防滥用 | 创建限流 + 黑名单 + 审核 + 过期 | 公共入口易被利用 |

## 三、总体架构

<figure class="fig">
<svg viewBox="0 0 800 360" class="dg" role="img" aria-label="短链接服务架构：生成请求经网关到生成服务，向发号器申请号段内的自增 ID，混淆并转 Base62 得到短码，写入 MySQL 并预热缓存；跳转请求经 CDN 或网关到跳转服务，依次查本地缓存、布隆过滤器、Redis、MySQL，命中后返回 302 重定向，同时异步把点击事件写入 Kafka 供统计">
<rect class="b1" x="20" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">用户 / 浏览器</text>
<rect class="b3" x="170" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="225" y="52" text-anchor="middle" dominant-baseline="middle">网关 / CDN</text>
<line class="l" x1="130" y1="52" x2="170" y2="52" marker-end="url(#arr)"/>
<rect class="b5" x="330" y="20" width="170" height="64" rx="10"/>
<text class="tb" x="415" y="42" text-anchor="middle" dominant-baseline="middle">生成服务（写）</text>
<text class="ts" x="415" y="64" text-anchor="middle">校验 · 限流 · 发号 · 落库</text>
<rect class="b2" x="330" y="110" width="170" height="64" rx="10"/>
<text class="tb" x="415" y="132" text-anchor="middle" dominant-baseline="middle">跳转服务（读）</text>
<text class="ts" x="415" y="154" text-anchor="middle">多级缓存 · 302 · 打点</text>
<line class="l" x1="280" y1="46" x2="330" y2="46" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="60" x2="330" y2="132" marker-end="url(#arr)"/>
<rect class="b4" x="560" y="20" width="210" height="64" rx="10"/>
<text class="tb" x="665" y="42" text-anchor="middle" dominant-baseline="middle">发号器（号段模式）</text>
<text class="ts" x="665" y="64" text-anchor="middle">每次取 1000~10000 个号</text>
<line class="l" x1="500" y1="52" x2="560" y2="52" marker-end="url(#arr)"/>
<rect class="b3" x="560" y="110" width="100" height="64" rx="10"/>
<text class="tb" x="610" y="132" text-anchor="middle" dominant-baseline="middle">Redis</text>
<text class="ts" x="610" y="154" text-anchor="middle">短码→长链</text>
<rect class="b2" x="670" y="110" width="100" height="64" rx="10"/>
<text class="tb" x="720" y="132" text-anchor="middle" dominant-baseline="middle">MySQL 分片</text>
<text class="ts" x="720" y="154" text-anchor="middle">全量映射</text>
<line class="l" x1="500" y1="142" x2="560" y2="142" marker-end="url(#arr)"/>
<line class="l" x1="660" y1="142" x2="670" y2="142" marker-end="url(#arr)"/>
<rect class="b5" x="330" y="210" width="170" height="50" rx="8"/>
<text class="tb" x="415" y="235" text-anchor="middle" dominant-baseline="middle">Kafka 点击事件</text>
<line class="l" x1="415" y1="174" x2="415" y2="210" marker-end="url(#arr)"/>
<rect class="b1" x="560" y="210" width="210" height="50" rx="8"/>
<text class="tb" x="665" y="235" text-anchor="middle" dominant-baseline="middle">ClickHouse 统计</text>
<line class="l" x1="500" y1="235" x2="560" y2="235" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="280" width="760" height="64" rx="10"/>
<text class="ts" x="36" y="304">• 读写分离部署：跳转服务无状态、可大规模扩容，生成服务低并发；两者独立限流与降级</text>
<text class="ts" x="36" y="324">• 跳转路径只做：查映射 → 返回 302 → 异步打点；任何统计、审核都不在这条路径上同步执行</text>
</svg>
<figcaption>图 1：短链接服务总体架构</figcaption>
</figure>

## 四、短码生成

### 1. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **号段发号器 + Base62（推荐）** | 中心服务按号段批量下发自增 ID，本地逐个使用，转 Base62 | **绝不冲突**、写入无需判重、本地发号极快、可扩展 | 自增码可枚举（需混淆）；号段浪费（可接受） |
| 哈希截断（MD5/Murmur 取前 N 位 → Base62） | 对长链接哈希 | 同链接可复用（天然去重） | **会冲突**：需判重+重试加盐；截断越短冲突越多 |
| 纯随机码 | 随机 N 位 Base62 | 不可枚举 | 需判重（`INSERT` 唯一键冲突重试）；空间利用率高后冲突率升高 |
| 雪花 ID → Base62 | 64 位 ID | 无中心、趋势递增 | 码太长（约 11 位），不“短” |
| 预生成码池 | 离线批量生成随机码入库，使用时领取 | 不可枚举 + 无冲突 | 需要管理码池与领取（可结合号段） |

### 2. 推荐：号段 + 混淆 + Base62

1. **发号器**：数据库表记录 `max_id`，每个生成服务实例一次领取一个号段（如 `[100001, 110000]`，`UPDATE ... SET max_id = max_id + 10000 WHERE biz='shorturl'` 原子推进），号段内本地原子自增，用完再领。详见 [分布式 ID](#/distributed/id)；
2. **可逆混淆**：把自增 ID 通过**双射**（一一对应）变换成看似随机的数，常见：与固定密钥异或、**Feistel 网络**、乘以与 2^k 互质的大数再取模（模 2^k 的乘法逆元可还原）；
3. **Base62 编码**：用 `0-9a-zA-Z` 转换；固定补齐到 7 位，去掉易混淆字符（`0/O/1/l/I`）可选。

```java
public final class ShortCode {
    private static final char[] ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".toCharArray();
    private static final long MOD = 1L << 40;                       // 2^40 ≈ 1.1 万亿，< 62^7，可编码为 7 位
    private static final long MUL = 0x9E3779B97F4A7C15L | 1;        // 奇数 → 与 2^40 互质，乘法在模 2^40 下是双射
    private static final long ADD = 0x5DEECE66DL;                    // 偏移（密钥的一部分，不对外公开）

    /** 自增 ID → 混淆后的数（双射，不会冲突） */
    static long scramble(long id) { return ((id * MUL) + ADD) & (MOD - 1); }

    static String encode(long n) {                                   // Base62，固定 7 位
        char[] buf = new char[7];
        for (int i = 6; i >= 0; i--) { buf[i] = ALPHABET[(int) (n % 62)]; n /= 62; }
        return new String(buf);
    }
    public static String fromId(long id) { return encode(scramble(id)); }
}
```

> [!WARNING] 混淆不是加密
> 上面的线性变换只能防“顺手枚举”，不能抵抗有意者逆向。如果短码的保密性有强要求（如私密分享链接），应使用**足够长的随机码（≥ 10 位）+ 访问鉴权/有效期**，而不是依赖混淆。密钥与偏移量要放在配置/密钥管理中（见 [加密与密钥管理](#/security/crypto)）。

### 3. 自定义短码与冲突

- 自定义码走**唯一索引**插入，冲突返回“已占用”；
- 自定义码与系统生成码**要隔离命名空间**（如系统码固定 7 位，自定义要求 4~6 位或带前缀），避免系统生成的码恰好撞上用户自定义；
- 保留词黑名单（`admin`、`api`、`login` 等）。

## 五、数据模型与存储

```sql
CREATE TABLE short_link (
  id           BIGINT PRIMARY KEY,               -- 发号器 ID（也用于分片）
  code         CHAR(7) NOT NULL,                 -- 短码
  long_url     VARCHAR(2048) NOT NULL,
  url_hash     CHAR(32) NOT NULL,                -- long_url 的 MD5，用于可选的去重/反查
  owner_id     BIGINT NOT NULL DEFAULT 0,
  status       TINYINT NOT NULL DEFAULT 1,       -- 1 正常 2 已下线 3 审核中
  expire_at    DATETIME NULL,
  created_at   DATETIME NOT NULL,
  UNIQUE KEY uk_code (code),
  KEY idx_owner (owner_id, created_at),
  KEY idx_url_hash (url_hash)
);
```

**分库分表**：

- 跳转读取的键是 `code`，所以**分片键用 code 的哈希**（`hash(code) % N`）；若分片键用 id，则按 code 查必须先反解出 id——因为混淆是**可逆**的，也可以从 code 解出 id 再按 id 路由，不需要额外的 code→id 映射表（这是可逆混淆的另一个好处）；
- 扩容：采用逻辑分片（如 1024 个逻辑库表，映射到少量物理库），扩容时迁移逻辑分片，见 [分库分表](#/mysql/sharding)；
- `long_url` 过长可单独存放，列表页与主表分离；
- **冷热分离**：长期无访问且已过期的数据归档到冷存储。

## 六、读路径：缓存架构

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="跳转读路径：请求先查本地缓存 Caffeine，命中直接返回 302；未命中查布隆过滤器，不存在直接返回 404；存在则查 Redis，命中回填本地缓存；Redis 未命中再查 MySQL，并回填 Redis 和本地缓存；热点保护包括本地缓存随机过期、单飞合并回源、空值短缓存">
<rect class="b1" x="20" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="65" text-anchor="middle" dominant-baseline="middle">GET /aZ3k9Q</text>
<rect class="b3" x="170" y="40" width="120" height="50" rx="8"/>
<text class="tb" x="230" y="58" text-anchor="middle" dominant-baseline="middle">本地缓存</text>
<text class="ts" x="230" y="78" text-anchor="middle">Caffeine</text>
<rect class="b5" x="330" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="385" y="58" text-anchor="middle" dominant-baseline="middle">布隆过滤器</text>
<text class="ts" x="385" y="78" text-anchor="middle">挡不存在的码</text>
<rect class="b2" x="480" y="40" width="110" height="50" rx="8"/>
<text class="tb" x="535" y="65" text-anchor="middle" dominant-baseline="middle">Redis</text>
<rect class="b4" x="630" y="40" width="140" height="50" rx="8"/>
<text class="tb" x="700" y="65" text-anchor="middle" dominant-baseline="middle">MySQL 分片</text>
<line class="l" x1="130" y1="65" x2="170" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="65" x2="330" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="65" x2="480" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="65" x2="630" y2="65" marker-end="url(#arr)"/>
<text class="ts" x="310" y="34" text-anchor="middle">未命中</text>
<text class="ts" x="460" y="34" text-anchor="middle">可能存在</text>
<text class="ts" x="610" y="34" text-anchor="middle">未命中</text>
<text class="ta" x="230" y="112" text-anchor="middle">命中→302</text>
<text class="ta" x="385" y="112" text-anchor="middle">不存在→404</text>
<text class="ta" x="535" y="112" text-anchor="middle">命中→回填本地</text>
<rect class="bg" x="20" y="130" width="750" height="186" rx="10"/>
<text class="th" x="36" y="154">热点与稳定性保护</text>
<text class="ts" x="36" y="178">• 本地缓存放最热的一批（几十万条），TTL 加随机抖动，避免同时过期</text>
<text class="ts" x="36" y="198">• 单飞（singleflight）：同一短码并发 miss 时只回源一次，其他请求等待结果，防击穿</text>
<text class="ts" x="36" y="218">• 布隆过滤器装载全部有效短码（约 10 bit/条 ≈ 1% 误判），防止恶意遍历打穿到数据库</text>
<text class="ts" x="36" y="238">• 空值短缓存：确认不存在的码在 Redis 里缓存 30~60s，防穿透（与布隆过滤器二选一或组合）</text>
<text class="ts" x="36" y="258">• 失效与下线：修改/下线时先更新库，再删 Redis，并通过消息广播让各实例清除本地缓存</text>
<text class="ts" x="36" y="278">• 超热点：营销短链数万 QPS，可在 CDN/网关层按路径缓存 302 响应几秒，进一步卸载</text>
<text class="ts" x="36" y="298">• 缓存一致性取舍见 缓存设计，短链映射几乎不变，最终一致即可</text>
</svg>
<figcaption>图 2：跳转读路径的多级缓存与保护</figcaption>
</figure>

要点：

- **短链映射几乎不变**，是最适合缓存的数据；更新很少，缓存一致性要求低（见 [缓存设计与一致性](#/redis/cache)）；
- 布隆过滤器原理与参数估算见 [工程中的算法](#/cs/algo-engineering)：1 亿条约 120MB（1% 误判），生成短码时同步加入（多实例用 Redisson/RedisBloom 共享，或定期重建）；
- **过期短链**：读到 `expire_at` 已过则返回 410/404 并短缓存。

## 七、重定向：301、302 与统计

| | 301 Moved Permanently | 302 Found（临时） | 307 Temporary Redirect |
| --- | --- | --- | --- |
| 浏览器缓存 | **长期缓存**，后续直接跳转，不再请求服务端 | 不缓存（或按响应头） | 不缓存，且**保持原请求方法** |
| 统计/管控 | ✗ 缓存后统计丢失、无法下线 | ✓ 每次都经过服务端 | ✓ |
| 服务端压力 | 低 | 高 | 高 |
| 适用 | 永久不变的链接、不需统计 | **短链服务默认选择** | 需要保持 POST 的场景 |

响应头建议：`Cache-Control: private, max-age=0`（或很短），避免中间缓存产生统计偏差；需要 SEO 权重传递的场景才考虑 301。

## 八、点击统计

主路径只做一件事：**把点击事件异步丢出去**。

```java
@GetMapping("/{code}")
public ResponseEntity<Void> redirect(@PathVariable String code, HttpServletRequest req) {
    LinkInfo link = resolver.resolve(code);                       // 多级缓存查询
    if (link == null) return ResponseEntity.notFound().build();
    eventPublisher.publishAsync(new ClickEvent(code, Instant.now(), ip(req), req.getHeader("User-Agent"), req.getHeader("Referer")));   // 异步，有界队列，满则丢弃采样
    return ResponseEntity.status(HttpStatus.FOUND).header("Location", link.longUrl()).header("Cache-Control", "private, max-age=0").build();
}
```

- 事件写入**有界内存队列 + 批量发送 Kafka**，Kafka 异常时**丢弃/降采样**，**不能影响跳转**；
- 统计：Flink 或批任务聚合到 ClickHouse（PV/UV、地域、设备、来源、小时/天级），UV 用 HyperLogLog/`uniq`（见 [行为分析](#/bigdata/ck-analytics)）；
- **防刷统计**：同 IP/UA 短时间多次点击去重，爬虫（`bot` UA、已知 IP 段）过滤；
- 实时看板：Redis 计数器 `INCR` 近似实时（最终以 ClickHouse 为准）。

## 九、安全与防滥用

| 风险 | 对策 |
| --- | --- |
| **钓鱼/恶意站点被短链隐藏** | 创建时校验域名黑名单（安全浏览服务、自建名单）、内容扫描；用户举报通道；**对跳转目标做异步复检**，命中即下线 |
| **开放重定向被滥用** | 限制可创建者（登录/配额）；匿名创建严格限流；敏感目标二次确认页（“即将离开本站”） |
| **批量刷创建**（占码、撑爆存储） | 按 IP/用户/AppKey 限流（令牌桶，见 [工程中的算法](#/cs/algo-engineering)）、验证码、配额 |
| **枚举遍历** | 短码混淆 + 布隆过滤器 + 对 404 比例异常的 IP 限流/封禁 |
| **SSRF（服务端会抓取长链接标题时）** | 抓取标题要走受控代理，禁止内网地址（见 [Web 安全：SSRF](#/security/web)） |
| **协议滥用** | 只允许 `http/https`，拒绝 `javascript:`、`file:` 等 |
| **隐私** | 统计中的 IP 脱敏/哈希，遵循保留期与合规 |

## 十、过期、回收与容量治理

- **过期**：`expire_at` 在读取时判断；后台定时任务**批量标记/归档**已过期数据（分页、限速，避免大事务，见 [发布策略：批量操作](#/infra/release)）；
- **回收短码**：号段发号器按自增使用，**不回收**（空间足够）；若要复用，需保证旧链接确认下线且缓存已失效；
- **冷数据**：长期无访问的映射迁移到低成本存储，访问时回源并回填；
- **监控**：容量（行数/磁盘）、号段使用率、缓存命中率、404 比例、创建失败率。

## 十一、可用性与降级

| 故障 | 影响 | 对策 |
| --- | --- | --- |
| Redis 故障 | 读流量打到数据库 | 本地缓存兜底；限流保护数据库；Redis 集群+多副本；回源时单飞合并 |
| MySQL 分片故障 | 部分短码不可解析 | 主从自动切换；Redis/本地缓存可撑一段时间；热点数据预热 |
| 发号器故障 | 无法创建新短链 | 各实例本地号段可继续用完；号段库主备；读不受影响 |
| Kafka 故障 | 统计丢失 | 跳转不受影响；本地降采样与落盘重发 |
| 机房故障 | 整体不可用 | 多机房部署，DNS/GSLB 切换；映射数据跨机房复制 |
| 流量洪峰 | 缓存与数据库压力 | CDN 缓存 302、限流、扩容无状态跳转服务 |

## 十二、监控指标与上线

- **指标**：跳转 QPS/P99、各级缓存命中率（本地/Redis）、布隆误判拦截数、MySQL 慢查询、创建 QPS、404/410 比例、Kafka 积压；见 [指标监控](#/infra/obs-metrics)；
- **压测**：重点压跳转热点（单码极高 QPS）与缓存失效瞬间，见 [压测与容量规划](#/design/eng-loadtest)；
- **灰度**：先小流量验证新短码规则，旧码规则必须永久兼容（已发出的短链不能失效）；
- **演进**：自定义域名、二维码、A/B 跳转（按规则跳不同目标）、深度链接（App 唤起）、统计下钻。

## 十三、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 哈希 vs 发号器 | 发号器 + 混淆 | 依赖号段服务；混淆非强安全 |
| 301 vs 302 | 302 | 服务端压力大，需要缓存扛住 |
| 同链复用 vs 每次新码 | 默认每次新码 | 存储略多，但统计与权限清晰 |
| 强一致统计 vs 最终一致 | 异步最终一致 | 看板有分钟级延迟，极端时丢少量点击 |
| 自建存储 vs KV | 先 MySQL 分片，必要时迁 KV | 初期简单，后期迁移成本 |

## 面试追问

> [!QUESTION] 短链接的短码怎么生成？怎么保证不冲突？
> 推荐号段发号器加 Base62：中心服务批量下发自增号段，实例本地原子自增，转成 Base62，因为 ID 全局唯一所以天然不冲突，无需判重。哈希截断会冲突需要判重重试，纯随机需要唯一键判重。直接用自增码可被枚举，要通过可逆的双射混淆，或使用更长的随机码并配合鉴权。

> [!QUESTION] 6 位和 7 位 Base62 能表示多少条？怎么估算该用几位？
> 62 的 6 次方约 568 亿，7 次方约 3.5 万亿。按每月新增一亿条、保留五年约 60 亿条估算，7 位有很大余量，并考虑自定义码和预留空间；位数要结合总量和不可枚举的要求决定。

> [!QUESTION] 301 和 302 怎么选？
> 301 是永久重定向会被浏览器长期缓存，后续不再请求服务端，导致统计丢失且无法下线或修改目标；302 每次都经过服务端，便于统计、风控和管控，所以短链服务通常用 302 或 307，用多级缓存扛住由此增加的服务端压力。

> [!QUESTION] 读多写少、热点极端的场景怎么设计缓存？
> 本地缓存加 Redis 加数据库三级，布隆过滤器挡住不存在的短码防穿透，本地缓存过期加随机抖动，并发回源用单飞合并防击穿，空值短缓存，超热点还可在 CDN 或网关缓存 302 响应几秒。短链映射几乎不变，最终一致即可，修改或下线时先写库再删缓存并广播清本地缓存。

> [!QUESTION] 点击统计怎么做才不影响跳转性能？
> 跳转路径只异步发送一个点击事件到有界队列再批量写 Kafka，队列满或 Kafka 故障时丢弃或降采样，绝不同步写库；后端用 Flink 或批任务聚合到 ClickHouse，UV 用近似去重，并过滤爬虫和重复点击。

> [!QUESTION] 短链接服务有哪些安全风险？
> 被用来隐藏钓鱼和恶意站点、批量创建占用资源、枚举遍历短码、开放重定向滥用和服务端抓取标题引发 SSRF。对策包括域名黑名单与内容审核、跳转目标异步复检和举报下线、创建限流与配额、短码混淆加布隆过滤器与异常 IP 封禁、只允许 http 和 https，抓取走受控代理。
