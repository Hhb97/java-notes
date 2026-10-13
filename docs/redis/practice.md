---
level: 进阶
tags: [限流, 排行榜, 延迟队列, Stream, Bitmap, HyperLogLog, GEO, Lua, 规范]
summary: 汇总 Redis 在 Java 后端最常用的场景实现：限流、排行榜、延迟队列、消息队列、统计与扣库存，并给出生产使用规范。
---

# 高频场景实战

> [!ABSTRACT] 核心要点
> - **限流**：固定窗口 `INCR`（有临界突刺）、滑动窗口 `ZSET`（精确但占内存）、令牌桶 **Lua**（允许突发、平滑）。
> - **排行榜**：`ZSET` 的 `ZADD/ZINCRBY/ZREVRANGE`；同分按时间排序时把时间编码进 score。
> - **延迟队列**：`ZSET`（score=到期时间）+ 轮询 Lua 抢占；生产更推荐 MQ 延迟消息或 Redisson `RDelayedQueue`。
> - **消息队列**：List（简单、无 ACK）、Pub/Sub（不持久）、**Stream**（消费组 + ACK + 持久化）。
> - **库存扣减必须原子**：Lua 里判断并扣减，避免“先查后改”超卖。
> - 生产规范：key 带业务前缀与 TTL、禁止 `KEYS`/大 key/热 key，使用 `SCAN` 与 `UNLINK`。

## 限流

### 固定窗口

```java
String key = "rate:" + userId + ":" + (System.currentTimeMillis() / 1000);   // 每秒一个 key
Long n = redis.opsForValue().increment(key);
if (n == 1) redis.expire(key, Duration.ofSeconds(2));
if (n > LIMIT) throw new TooManyRequestsException();
```

缺点：**窗口边界突刺**——前一秒最后 100ms 和后一秒前 100ms 各打满，实际 200ms 内通过两倍流量。

### 滑动窗口（ZSET）

```lua
-- KEYS[1]=限流key  ARGV: now(ms)  window(ms)  limit  member(唯一)
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])   -- 移除窗口外
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
    redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1
end
return 0
```

精确，但每个请求一条成员，**高 QPS 下内存与 CPU 开销大**，适合限制较小的场景（如短信、登录）。

### 令牌桶（Lua）

<figure class="fig">
<svg viewBox="0 0 740 230" class="dg" role="img" aria-label="令牌桶：按速率补充令牌，请求取走令牌">
<rect class="b3" x="40" y="40" width="130" height="50" rx="8"/>
<text class="tb" x="105" y="58" text-anchor="middle" dominant-baseline="middle">令牌生成</text>
<text class="ts" x="105" y="76" text-anchor="middle">rate = 10 个/秒</text>
<line class="l" x1="170" y1="65" x2="260" y2="65" marker-end="url(#arr)"/>
<rect class="b1" x="260" y="30" width="180" height="140" rx="10"/>
<text class="tb" x="350" y="54" text-anchor="middle" dominant-baseline="middle">令牌桶（容量 capacity）</text>
<circle class="b3" cx="305" cy="100" r="12"/>
<circle class="b3" cx="350" cy="100" r="12"/>
<circle class="b3" cx="395" cy="100" r="12"/>
<circle class="b3" cx="327" cy="138" r="12"/>
<circle class="b3" cx="373" cy="138" r="12"/>
<text class="ts" x="350" y="186" text-anchor="middle">桶满则丢弃新令牌，允许突发</text>
<line class="l" x1="440" y1="100" x2="520" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="480" y="90" text-anchor="middle">取 1 个</text>
<rect class="b2" x="520" y="76" width="120" height="48" rx="8"/>
<text class="tb" x="580" y="100" text-anchor="middle" dominant-baseline="middle">放行请求</text>
<line class="l" x1="350" y1="170" x2="350" y2="210"/>
<line class="l" x1="350" y1="210" x2="580" y2="210"/>
<line class="l" x1="580" y1="210" x2="580" y2="126" marker-end="url(#arr)"/>
<text class="ts" x="465" y="204" text-anchor="middle">无令牌 → 拒绝 / 排队</text>
</svg>
<figcaption>图 1：令牌桶限流</figcaption>
</figure>

不需要后台线程补令牌：**每次请求时按时间差计算应补多少**。

```lua
-- KEYS[1]=桶key  ARGV: rate(个/秒) capacity now(ms) requested
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or tonumber(ARGV[2])
local ts     = tonumber(data[2]) or tonumber(ARGV[3])
local delta  = math.max(0, tonumber(ARGV[3]) - ts)
tokens = math.min(tonumber(ARGV[2]), tokens + delta / 1000 * tonumber(ARGV[1]))
local allowed = tokens >= tonumber(ARGV[4])
if allowed then tokens = tokens - tonumber(ARGV[4]) end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[3])
redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(ARGV[2]) / tonumber(ARGV[1]) * 1000) * 2)
return allowed and 1 or 0
```

> [!NOTE] Redis Cluster 与 Lua
> Lua 脚本里访问的所有 key 必须在同一个槽，用 `{}` hash tag 保证；时间用客户端传入（Redis 5 起脚本默认复制效果而非命令，`TIME` 才不会破坏复制，但传参更稳妥）。

更多限流算法对比见 [限流、熔断与降级](#/distributed/governance)。

## 排行榜

```java
redis.opsForZSet().incrementScore("rank:daily:20260101", userId, 10);           // 加分
Set<ZSetOperations.TypedTuple<String>> top =
    redis.opsForZSet().reverseRangeWithScores("rank:daily:20260101", 0, 9);       // Top10
Long rank = redis.opsForZSet().reverseRank("rank:daily:20260101", userId);        // 我的名次(0 起)
```

- **同分按先到先得**：score 编码为 `分数 * 2^N + (MAX_TS - 时间戳)`，或用 `分数.(1 - 时间戳/1e13)` 的小数部分（注意双精度 53 位有效位）；
- 数据量巨大：按天/周分 key + 过期；只保留 Top N（`ZREMRANGEBYRANK key 0 -(N+1)`）；
- 底层是跳表，`ZRANK` O(logN)，见 [数据结构与底层编码](#/redis/types)。

## 延迟队列

场景：订单 30 分钟未支付自动取消。

```text
下单：      ZADD delay:order <到期时间戳> <orderId>
消费者轮询： ZRANGEBYSCORE delay:order 0 <now> LIMIT 0 100
           → 对每个 id 用 ZREM 抢占（返回 1 的才有权处理，保证只被一个消费者处理）
```

```lua
-- 原子地取出到期任务并移除，避免多消费者重复处理
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, ARGV[2])
if #ids > 0 then redis.call('ZREM', KEYS[1], unpack(ids)) end
return ids
```

隐患：取出后消费者崩溃，任务丢失（需要“处理中”队列与重试）。**生产推荐**：RocketMQ 定时消息 / Kafka 时间轮 / Redisson `RDelayedQueue`；Redis 的 key 过期事件**不可靠**（不保证准时、不持久），不要用来做延迟任务。

## 消息队列选项

| 方案 | 特点 | 局限 |
| --- | --- | --- |
| List（`LPUSH` + `BRPOP`） | 简单，阻塞消费 | 无 ACK，取出后崩溃即丢；无消费组 |
| Pub/Sub | 广播，实时 | **不持久**，订阅者离线就丢 |
| **Stream** | 持久化、消费组、ACK、可回溯 | 功能不及 Kafka，内存存储 |

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="Redis Stream 消费组：多个消费者分摊消息，Pending 列表保存未 ACK 的消息">
<rect class="b1" x="20" y="90" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="112" text-anchor="middle" dominant-baseline="middle">生产者</text>
<line class="l" x1="130" y1="112" x2="200" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="165" y="102" text-anchor="middle">XADD</text>
<rect class="b3" x="200" y="60" width="230" height="104" rx="10"/>
<text class="tb" x="315" y="82" text-anchor="middle" dominant-baseline="middle">Stream: orders</text>
<rect class="b" x="214" y="100" width="46" height="30" rx="4"/>
<text class="tm" x="237" y="115" text-anchor="middle" dominant-baseline="middle">1-0</text>
<rect class="b" x="268" y="100" width="46" height="30" rx="4"/>
<text class="tm" x="291" y="115" text-anchor="middle" dominant-baseline="middle">2-0</text>
<rect class="b" x="322" y="100" width="46" height="30" rx="4"/>
<text class="tm" x="345" y="115" text-anchor="middle" dominant-baseline="middle">3-0</text>
<rect class="b" x="376" y="100" width="46" height="30" rx="4"/>
<text class="tm" x="399" y="115" text-anchor="middle" dominant-baseline="middle">4-0</text>
<text class="ts" x="315" y="150" text-anchor="middle">消息追加写，ID 递增</text>
<rect class="bg" x="490" y="30" width="230" height="190" rx="10"/>
<text class="th" x="510" y="54">Consumer Group: g1</text>
<rect class="b2" x="510" y="72" width="190" height="34" rx="6"/>
<text class="t" x="605" y="89" text-anchor="middle" dominant-baseline="middle">consumer-A 处理 1-0, 3-0</text>
<rect class="b2" x="510" y="116" width="190" height="34" rx="6"/>
<text class="t" x="605" y="133" text-anchor="middle" dominant-baseline="middle">consumer-B 处理 2-0</text>
<rect class="b4" x="510" y="164" width="190" height="42" rx="6"/>
<text class="tb" x="605" y="178" text-anchor="middle" dominant-baseline="middle">PEL：已投递未 ACK</text>
<text class="ts" x="605" y="195" text-anchor="middle">崩溃后用 XAUTOCLAIM 转移</text>
<line class="l" x1="430" y1="112" x2="490" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="460" y="102" text-anchor="middle">XREADGROUP</text>
</svg>
<figcaption>图 2：Redis Stream 消费组与 Pending Entries List</figcaption>
</figure>

```text
XGROUP CREATE orders g1 $ MKSTREAM
XADD orders MAXLEN ~ 100000 * orderId 1001 amount 99      # 限制长度，防止无限增长
XREADGROUP GROUP g1 consumer-A COUNT 10 BLOCK 5000 STREAMS orders >
XACK orders g1 1700000000000-0                             # 处理成功后确认
XAUTOCLAIM orders g1 consumer-B 60000 0-0                  # 6.2+：认领空闲 60s 的 pending 消息
```

对可靠性要求高、吞吐大的场景仍应使用 [Kafka](#/mw/kafka) / RocketMQ。

## 统计类数据结构

| 需求 | 结构 | 说明 |
| --- | --- | --- |
| 用户签到、活跃标记 | **Bitmap** | `SETBIT sign:202601:uid 日期偏移 1`，一个月 4 字节；`BITCOUNT` 统计天数；`BITFIELD` 查连续签到 |
| UV（去重计数） | **HyperLogLog** | `PFADD uv:20260101 userId`，约 12KB 固定内存，误差约 0.81%；`PFMERGE` 合并多天 |
| 附近的人 / 门店 | **GEO** | `GEOADD` / `GEOSEARCH key FROMLONLAT 116.4 39.9 BYRADIUS 5 km`，底层 ZSET + GeoHash |
| 去重判重（海量） | Bloom Filter（RedisBloom 或 Redisson） | 允许误判，不漏判，防缓存穿透 |
| 点赞 / 关注 | Set | `SADD`、`SISMEMBER`、`SINTER` 求共同关注 |

## 库存扣减（防超卖）

先查后改在并发下一定超卖：

```lua
-- KEYS[1]=库存key  ARGV[1]=扣减数量
local stock = tonumber(redis.call('GET', KEYS[1]) or '-1')
if stock < 0 then return -1 end                 -- 商品未预热
if stock < tonumber(ARGV[1]) then return 0 end  -- 库存不足
redis.call('DECRBY', KEYS[1], ARGV[1])
return 1
```

- 同一个用户限购可在 Lua 里一并校验（`SISMEMBER` 已购集合）；
- Redis 库存与数据库库存是最终一致，需要**异步落库 + 对账**，完整方案见 [秒杀系统设计](#/design/seckill)；
- 扣减成功后下游失败要**回补库存**（并保证回补幂等）。

## 分布式 Session

Spring Session + Redis：Session 序列化为 Hash 存储，`spring:session:sessions:{id}`，TTL = 失效时间。注意：

- 序列化用 JSON 而非 JDK 序列化（跨版本兼容、可读）；
- 登录态频繁读，可加本地短缓存；
- 使用 token（JWT）可免于服务端存储，但要处理注销与续期。

## 生产使用规范

| 规范 | 要求 |
| --- | --- |
| key 命名 | `业务:模块:标识`，如 `order:detail:1001`；长度适中（<128 字节） |
| 过期时间 | **缓存类 key 必须设 TTL**，并加随机抖动；禁止永不过期的垃圾数据堆积 |
| 大 key | String < 10KB；集合类元素数 < 5000；超出要拆分（按 hash 取模分桶）|
| 热 key | 本地缓存（Caffeine）+ 多副本打散（`key#随机后缀`），见 [缓存设计与一致性](#/redis/cache) |
| 危险命令 | 禁止 `KEYS *`、`FLUSHALL`、`HGETALL` 大 hash、`SMEMBERS` 大集合；用 `SCAN` / `HSCAN` / `SSCAN` |
| 删除 | 大 key 用 `UNLINK`（异步释放内存）；`lazyfree-lazy-user-del yes` |
| 批量 | 用 Pipeline / `MGET`，单批 100~500；Cluster 下按槽分组 |
| 连接池 | Lettuce 默认单连接多路复用，阻塞命令用独立连接；Jedis 池大小 ≈ 并发线程数；设置合理的命令超时（通常 1~3s） |
| 观测 | `SLOWLOG`、`INFO commandstats`、`--bigkeys`、内存与命中率、连接数、`latency doctor` |

## 相关阅读

- [案例：高并发写入与热点治理](#/design/case-highwrite)：分段计数、Lua 红包、预扣库存
- [Redis 使用规范与平台化治理](#/redis/governance)：使用规范与统一封装
- [Redis 内存优化与容量治理](#/redis/memory)：Bitmap/HLL 等省内存结构

## 面试追问

> [!QUESTION] 固定窗口、滑动窗口、令牌桶分别有什么问题？
> 固定窗口有边界突刺；滑动窗口精确但每个请求一条记录，内存和 CPU 开销大；令牌桶允许一定突发并平滑限流，用 Lua 在 Redis 中原子实现，是实际使用较多的方案。

> [!QUESTION] 如何用 Redis 实现延迟队列？有什么缺点？
> ZSET 以到期时间为 score，轮询到期成员并用 ZREM 抢占。缺点：轮询开销、消费者取出后崩溃会丢任务、无重试机制；生产更倾向 MQ 延迟消息；不能依赖 key 过期事件。

> [!QUESTION] Redis Stream 相比 List、Pub/Sub 有什么优势？
> 持久化、支持消费组与 ACK、可回溯、PEL 可恢复未确认消息；List 无 ACK 容易丢，Pub/Sub 不持久且订阅者离线即丢。

> [!QUESTION] 为什么库存扣减要用 Lua？
> “读库存—判断—扣减”不是原子的，并发下会超卖；Lua 脚本在 Redis 中单线程原子执行，把判断与扣减合并成一步。

> [!QUESTION] 统计 UV 用 Set 还是 HyperLogLog？
> 千万级用户用 Set 内存巨大；HyperLogLog 固定约 12KB，误差约 0.81%，适合对精度不敏感的 UV 统计；需要精确去重再用 Set 或 Bitmap（用户 ID 连续时）。
