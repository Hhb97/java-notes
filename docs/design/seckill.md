---
level: 深入
tags: [秒杀, 高并发, 库存扣减, 限流, 削峰, Redis Lua, 消息队列]
summary: 以秒杀为例完整演练高并发系统设计：流量漏斗分层拦截、Redis 预扣库存、MQ 异步下单、防超卖与防刷、订单超时取消，以及压测与应急预案。
---

# 秒杀系统设计

> [!ABSTRACT] 核心要点
> - 秒杀的本质：**瞬时极高并发读 + 极少量写**。设计原则是**层层拦截，把请求挡在离数据库最远的地方**，最终落库的流量只有库存数那么多。
> - 读靠**静态化 + CDN + 本地缓存**；写靠**限流 → Redis 预扣库存（Lua 原子）→ MQ 异步下单 → 数据库**。
> - 防超卖：库存扣减必须原子；数据库层再加 `stock > 0` 条件兜底。防少卖：失败要**回补库存**，并有对账。
> - 防刷：验证码/答题削峰、令牌、限购、风控；热点商品**隔离部署**，不影响其他业务。
> - 全链路压测与降级预案是上线前提：**能扛住**与**扛不住时怎么优雅失败**同样重要。

## 业务特点与难点

| 特点 | 带来的问题 |
| --- | --- |
| 瞬时流量是平时的几十至上百倍 | 带宽、网关、应用线程池、数据库连接全部被打满 |
| 读多写少（看的人远多于抢到的人） | 绝大多数请求最终都会失败，应尽早返回 |
| 热点数据集中在一个商品 | 单 key/单行热点：Redis 单 key QPS 上限、数据库行锁争用 |
| 库存有限，不允许超卖 | 并发扣减的一致性 |
| 恶意流量（脚本抢购） | 正常用户被挤占 |

## 请求漏斗：层层拦截

<figure class="fig">
<svg viewBox="0 0 760 420" class="dg" role="img" aria-label="秒杀请求逐层衰减的漏斗：CDN、网关、秒杀服务、MQ、数据库">
<rect class="b" x="30" y="20" width="700" height="52" rx="8"/>
<text class="tb" x="60" y="40" text-anchor="start" dominant-baseline="middle">① 浏览器 / CDN</text>
<text class="ts" x="60" y="58" text-anchor="start">页面静态化、按钮置灰至开抢、验证码削峰、同一用户前端防重复点击</text>
<text class="ta" x="710" y="46" text-anchor="end">1000 万 req</text>
<rect class="b1" x="70" y="96" width="620" height="52" rx="8"/>
<text class="tb" x="100" y="116" text-anchor="start" dominant-baseline="middle">② 网关层</text>
<text class="ts" x="100" y="134" text-anchor="start">限流（总量 + 单用户 + 单 IP）、黑名单、校验秒杀令牌与时间窗口</text>
<text class="ta" x="670" y="122" text-anchor="end">100 万 req</text>
<rect class="b3" x="110" y="172" width="540" height="52" rx="8"/>
<text class="tb" x="140" y="192" text-anchor="start" dominant-baseline="middle">③ 秒杀服务（独立集群）</text>
<text class="ts" x="140" y="210" text-anchor="start">本地缓存判断是否已售罄、Redis Lua 预扣库存 + 限购校验</text>
<text class="ta" x="630" y="198" text-anchor="end">≈ 库存数 ×N</text>
<rect class="b5" x="150" y="248" width="460" height="52" rx="8"/>
<text class="tb" x="180" y="268" text-anchor="start" dominant-baseline="middle">④ 消息队列</text>
<text class="ts" x="180" y="286" text-anchor="start">抢到资格的请求入队，削峰填谷，订单服务按能力消费</text>
<text class="ta" x="590" y="274" text-anchor="end">= 库存数</text>
<rect class="b2" x="190" y="324" width="380" height="52" rx="8"/>
<text class="tb" x="220" y="344" text-anchor="start" dominant-baseline="middle">⑤ 订单服务 + 数据库</text>
<text class="ts" x="220" y="362" text-anchor="start">乐观扣减 + 唯一约束，最终一致落库</text>
<text class="ta" x="550" y="350" text-anchor="end">= 库存数</text>
<text class="ts" x="380" y="404" text-anchor="middle">越往下流量越少：绝大多数请求在上层就被返回“已抢完 / 请稍后”</text>
</svg>
<figcaption>图 1：秒杀请求漏斗，数字为示意量级</figcaption>
</figure>

## 整体架构

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="秒杀系统整体架构：网关、秒杀服务、Redis、MQ、订单服务、MySQL">
<rect class="b" x="20" y="130" width="90" height="46" rx="8"/>
<text class="tb" x="65" y="153" text-anchor="middle" dominant-baseline="middle">用户</text>
<rect class="b1" x="150" y="130" width="100" height="46" rx="8"/>
<text class="tb" x="200" y="153" text-anchor="middle" dominant-baseline="middle">CDN / 网关</text>
<rect class="b3" x="290" y="130" width="110" height="46" rx="8"/>
<text class="tb" x="345" y="153" text-anchor="middle" dominant-baseline="middle">秒杀服务</text>
<rect class="b4" x="290" y="30" width="110" height="46" rx="8"/>
<text class="tb" x="345" y="53" text-anchor="middle" dominant-baseline="middle">Redis 集群</text>
<text class="ts" x="410" y="46" text-anchor="start">库存 · 已购用户集合</text>
<rect class="b5" x="450" y="130" width="90" height="46" rx="8"/>
<text class="tb" x="495" y="153" text-anchor="middle" dominant-baseline="middle">MQ</text>
<rect class="b2" x="580" y="130" width="120" height="46" rx="8"/>
<text class="tb" x="640" y="153" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<rect class="b5" x="580" y="240" width="120" height="46" rx="8"/>
<text class="tb" x="640" y="263" text-anchor="middle" dominant-baseline="middle">MySQL</text>
<line class="l" x1="110" y1="153" x2="150" y2="153" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="153" x2="290" y2="153" marker-end="url(#arr)"/>
<line class="la" x1="345" y1="130" x2="345" y2="76" marker-end="url(#arr-a)"/>
<text class="ts" x="335" y="108" text-anchor="end">Lua 扣库存</text>
<line class="l" x1="400" y1="153" x2="450" y2="153" marker-end="url(#arr)"/>
<line class="l" x1="540" y1="153" x2="580" y2="153" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="176" x2="640" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="652" y="214" text-anchor="start">落库</text>
<rect class="bg" x="20" y="240" width="520" height="70" rx="10"/>
<text class="th" x="36" y="262">支撑能力</text>
<text class="ts" x="36" y="284">轮询 / WebSocket 查询抢购结果 · 延迟消息：未支付订单超时取消并回补库存</text>
<text class="ts" x="36" y="302">监控大盘 · 降级开关 · 限流规则动态下发（Nacos / Sentinel 控制台）</text>
</svg>
<figcaption>图 2：秒杀系统整体架构</figcaption>
</figure>

## 逐层设计

### 1. 前端与 CDN：把读流量挡在系统外

- 商品详情页**静态化**（HTML/JS/CSS/图片全部走 CDN），动态部分（库存、倒计时）用独立接口；
- 倒计时以**服务器时间**为准（定时校准），按钮在开抢前置灰；
- 点击后按钮置灰 + 前端防抖，避免用户重复点击；
- **验证码 / 答题**：既削峰（把请求在时间上拉开），又过滤脚本。

### 2. 网关：限流与鉴权

- 总量限流（令牌桶）、单用户限流（如 1 次/秒）、单 IP 限流；
- 秒杀前不暴露真实下单接口地址：先请求**获取秒杀令牌**接口（校验用户资格、风控、验证码），返回带签名与时效的令牌，下单时必须携带；
- 超出限流直接返回“请稍后再试”，不进入业务线程。

### 3. 秒杀服务：预热 + 本地标记 + Redis 原子扣减

- **库存预热**：开抢前把库存写入 Redis（`seckill:stock:{skuId}`）；
- **售罄标记**：库存归零后在本地内存（或 Redis 标记）里设置“已售罄”，后续请求不再访问 Redis，直接返回；
- **原子扣减 + 限购**用 Lua 脚本一次完成：

```lua
-- KEYS[1]=库存key  KEYS[2]=已购用户集合key
-- ARGV[1]=userId   ARGV[2]=购买数量(此处为 1)
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return -2                                  -- 已购买过，限购
end
local stock = tonumber(redis.call('GET', KEYS[1]) or '-1')
if stock < 0 then return -3 end                -- 活动未预热
if stock < tonumber(ARGV[2]) then return 0 end -- 已售罄
redis.call('DECRBY', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
return 1                                       -- 抢购成功
```

```java
@PostMapping("/seckill/{skuId}")
public Result<String> seckill(@PathVariable long skuId, @RequestHeader("X-User") long userId,
                              @RequestParam String token) {
    if (!tokenService.verify(userId, skuId, token)) return Result.fail("非法请求");
    if (soldOutLocal.contains(skuId)) return Result.fail("已抢完");

    Long r = redis.execute(SECKILL_SCRIPT,
            List.of("seckill:stock:" + skuId, "seckill:bought:" + skuId), String.valueOf(userId), "1");
    if (r == null || r != 1) {
        if (r != null && r == 0) soldOutLocal.add(skuId);
        return Result.fail(r != null && r == -2 ? "您已参与过" : "已抢完");
    }
    String orderNo = idGen.nextId();                       // 提前生成订单号，便于前端轮询
    mq.send("seckill-order", new SeckillOrderMsg(orderNo, userId, skuId));   // 异步下单
    return Result.ok(orderNo);                             // 返回“排队中”，前端轮询结果
}
```

**热点 key 问题**：单个商品的库存 key 在一个 Redis 分片上，QPS 可能超过单节点上限。方案：**分段库存**——把 1000 件拆成 10 个 key（各 100 件），请求随机/按用户哈希选一段扣减，段内售罄再尝试其他段；代价是售罄判断更复杂。

### 4. MQ：削峰填谷与异步落库

- 抢到资格的请求只发一条消息即返回，订单服务按数据库能承受的速率消费；
- 消息要**可靠**（同步发送、Broker 刷盘、多副本），消费要**幂等**（订单号/`(userId, skuId)` 唯一索引），见 [消息队列核心问题](#/mw/mq)；
- 发送 MQ 失败：回补 Redis 库存并清除已购标记，返回失败；或把消息落**本地消息表**重试。

### 5. 订单服务与数据库

```sql
-- 条件更新兜底，库存永远不会被减成负数；影响行数为 0 表示已无库存
UPDATE sku_stock SET stock = stock - 1 WHERE sku_id = ? AND stock > 0;

-- 唯一索引防重复下单（消息重复消费、同一用户重复请求）
ALTER TABLE seckill_order ADD UNIQUE KEY uk_user_sku (user_id, sku_id);
```

- 数据库层只需要承载 **“库存数”量级**的写，并且可以限速消费；
- 订单与库存若在不同库，需要本地事务 + 消息或 [分布式事务](#/distributed/transaction)，推荐**订单创建成功后发消息扣减 DB 库存**，保证最终一致；
- 单行热点：`UPDATE` 同一行会产生行锁排队，可用库存分段（多行）或把扣减放在 Redis、DB 只做最终记账。

### 6. 抢购结果与支付

- 前端轮询 `/seckill/result?orderNo=` 或 WebSocket 推送；
- 订单创建后进入**待支付**，设置 15 分钟过期。

## 订单超时取消与库存回补

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="未支付订单通过延迟消息超时取消并回补库存的时序">
<rect class="b2" x="40" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="95" y="37" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<rect class="b5" x="290" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="355" y="37" text-anchor="middle" dominant-baseline="middle">MQ（延迟消息）</text>
<rect class="b4" x="560" y="20" width="130" height="34" rx="6"/>
<text class="tb" x="625" y="37" text-anchor="middle" dominant-baseline="middle">Redis / MySQL</text>
<line class="ld" x1="95" y1="54" x2="95" y2="262"/>
<line class="ld" x1="355" y1="54" x2="355" y2="262"/>
<line class="ld" x1="625" y1="54" x2="625" y2="262"/>
<line class="l" x1="95" y1="84" x2="355" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="225" y="76" text-anchor="middle">① 创建订单后发 15 分钟延迟消息</text>
<text class="ts" x="365" y="114" text-anchor="start">…15 分钟后到期投递…</text>
<line class="l" x1="355" y1="142" x2="95" y2="142" marker-end="url(#arr)"/>
<text class="ts" x="225" y="134" text-anchor="middle">② 到期消息</text>
<text class="t" x="110" y="172" text-anchor="start">③ 查询订单状态：已支付 → 直接丢弃</text>
<line class="la" x1="95" y1="206" x2="625" y2="206" marker-end="url(#arr-a)"/>
<text class="ta" x="360" y="198" text-anchor="middle">④ 仍待支付：关闭订单，回补库存，移除已购标记</text>
<text class="ts" x="360" y="240" text-anchor="middle">关闭订单与回补要**幂等**（以订单状态机 CAS：待支付→已关闭 成功才回补）</text>
</svg>
<figcaption>图 3：延迟消息驱动的超时取消</figcaption>
</figure>

关键点：用订单状态做 CAS（`UPDATE orders SET status='CLOSED' WHERE id=? AND status='PENDING'`），**只有更新成功的那一次才回补库存**，避免重复回补导致超卖。

## 防刷与风控

| 手段 | 说明 |
| --- | --- |
| 验证码 / 答题 | 拉长请求时间窗口，增加脚本成本 |
| 秒杀令牌 | 先通过资格校验换取令牌，才能进入下单接口 |
| 限购 | 每用户每商品限购，Redis Set 或 Lua 校验 |
| 设备 / IP / 账号维度限流 | 滑动窗口计数；新注册账号、异常设备降权 |
| 黑名单 | 风控系统实时下发 |
| 防重放 | 令牌一次性、带时间戳签名 |

## 一致性与对账

- Redis 预扣与 DB 库存是**最终一致**：活动结束后对账（Redis 初始库存 - 已售 = 剩余；订单表数量）；
- 异常订单补偿：MQ 消息丢失 / 消费失败 → 比对 Redis 已购集合与订单表，补建订单或回补库存；
- 所有环节**幂等**：库存回补、订单创建、消息消费。

## 压测、容量与预案

1. **容量评估**：目标 QPS = 预计在线用户 × 点击频率 × 峰值系数；逐层计算需要的机器、Redis 分片、MQ 分区；
2. **全链路压测**：用影子库/影子表压测真实链路，逐层找瓶颈（连接数、线程池、带宽、Redis 热点）；
3. **隔离**：秒杀服务独立部署、独立数据库和 Redis，防止拖垮核心交易；
4. **降级开关**：一键关闭非核心功能（推荐、评价）、一键切换静态“已结束”页；
5. **限流保护下游**：任何一层都要有 [限流与熔断](#/distributed/governance)，宁可拒绝部分用户，也不能被打垮；
6. **预热**：JIT 预热、连接池预热、缓存预热，开抢前几分钟放小流量；
7. **监控告警**：各层 QPS、RT、错误率、Redis 命中与热 key、MQ 积压、库存曲线；
8. **演练**：Redis 故障、MQ 积压、数据库慢等场景的应急预案。

## 常见错误方案

| 方案 | 问题 |
| --- | --- |
| 所有请求直接打数据库 `SELECT 再 UPDATE` | 必然超卖且数据库被打垮 |
| 仅 Redis `GET` 判断再 `DECR` | 非原子，超卖 |
| `synchronized` / JVM 本地锁 | 多实例无效 |
| 数据库悲观锁 `FOR UPDATE` | 行锁排队，TPS 极低 |
| 用 Redis 分布式锁串行化每个请求 | 吞吐受限于锁，而且 Lua 原子扣减更简单 |
| 扣库存与下单同步完成 | 链路长、RT 高，应异步 |

## 面试追问

> [!QUESTION] 秒杀系统的核心设计思路？
> 读写分离处理：读请求用静态化+CDN+本地缓存；写请求逐层限流，用 Redis Lua 原子预扣库存，抢到资格的请求通过 MQ 异步下单，数据库只承载库存数量级的写，并用条件更新和唯一索引兜底；配套防刷、超时取消、对账和降级预案。

> [!QUESTION] 如何防止超卖？
> Redis 层用 Lua 把“判断库存+扣减”做成原子操作；数据库层用 `stock > 0` 条件更新和唯一索引兜底；订单取消回补库存要幂等；最后用对账兜底。

> [!QUESTION] 单个热门商品的 Redis key 成为热点怎么办？
> 库存分段到多个 key，请求按哈希或随机分散；本地缓存售罄标记减少对 Redis 的访问；必要时用多个 Redis 分片或本地库存预分配到每个应用实例。

> [!QUESTION] Redis 扣减成功但下单失败怎么办？
> 发送 MQ 失败则立即回补库存并清理已购标记；MQ 消费失败重试，超过次数进入死信并告警人工/定时补偿；通过对账任务比对已购集合与订单表，修复遗漏订单。

> [!QUESTION] 如何防止机器人和黄牛？
> 验证码/答题、秒杀令牌、单用户/单 IP/设备限流、风控黑名单、限购、实名等手段组合；既拉长请求时间窗，又提高脚本成本。
