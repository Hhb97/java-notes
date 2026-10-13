---
level: 深入
tags: [限流, 令牌桶, Sentinel, 熔断, Resilience4j, 重试, 舱壁, 负载均衡]
summary: 服务治理的稳定性工具箱：四种限流算法与 Guava/Sentinel/Redis 实现、熔断状态机、降级、超时与重试、舱壁隔离、负载均衡与一致性哈希
---

# 限流、熔断与降级

> [!ABSTRACT] 核心要点
> - 限流保护**自己**不被打垮，熔断保护**自己**不被下游拖垮，降级是二者触发后的「备用方案」。三者都是为了让系统在过载和故障时**有损服务**而不是雪崩。
> - 四种限流算法：固定窗口（边界突刺）、滑动窗口（更平滑）、漏桶（匀速输出、不允许突发）、令牌桶（平均速率受控、允许突发）。Guava 是单机令牌桶，Sentinel 用滑动窗口统计 + 多种流控效果，分布式限流用 Redis + Lua 或网关。
> - 熔断器三态：Closed →（失败率/慢调用率超阈值）→ Open →（冷却期满）→ Half-Open →（探测成功）→ Closed。
> - 超时要按下游 P99 设置并沿调用链逐层递减；重试只对幂等操作、配合**指数退避 + 抖动 + 重试预算**，否则重试本身会放大故障。
> - 舱壁隔离让故障只沉一个舱：线程池隔离彻底但有切换开销，信号量隔离轻量但无法中断慢调用。

## 为什么需要服务治理

一个典型的雪崩过程：下游 D 变慢 → 调用方 C 的线程全部阻塞在等待 D → C 的线程池耗尽、对上游超时 → 上游 B 重试，流量翻倍 → 整条链路崩溃。治理手段对应地切断每个环节：

| 环节 | 手段 |
| --- | --- |
| 入口流量超过容量 | 限流、排队、削峰 |
| 下游变慢 | 超时、熔断 |
| 慢调用占满资源 | 舱壁隔离（线程池/信号量） |
| 失败后放大流量 | 重试退避、重试预算 |
| 核心功能需要保住 | 降级（返回兜底数据、关闭非核心功能） |

## 限流算法

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="四种限流算法对比：固定窗口在边界处可能放过两倍流量，滑动窗口按小格滑动，漏桶匀速流出，令牌桶匀速放令牌并允许突发">
<rect class="bg" x="10" y="10" width="170" height="280" rx="10"/>
<text class="tb" x="95" y="32" text-anchor="middle" dominant-baseline="middle">固定窗口</text>
<line class="l" x1="25" y1="200" x2="170" y2="200" marker-end="url(#arr)"/>
<line class="ld" x1="97" y1="60" x2="97" y2="200"/>
<rect class="b4" x="80" y="120" width="14" height="80"/>
<rect class="b4" x="100" y="120" width="14" height="80"/>
<text class="ta" x="97" y="100" text-anchor="middle">边界 1s 内 200 次</text>
<text class="ts" x="61" y="218" text-anchor="middle">0~1s</text>
<text class="ts" x="133" y="218" text-anchor="middle">1~2s</text>
<text class="ts" x="95" y="248" text-anchor="middle">每窗口计数，到点清零</text>
<text class="ts" x="95" y="266" text-anchor="middle">阈值 100 时边界可过 2 倍</text>
<rect class="bg" x="200" y="10" width="170" height="280" rx="10"/>
<text class="tb" x="285" y="32" text-anchor="middle" dominant-baseline="middle">滑动窗口</text>
<line class="l" x1="215" y1="200" x2="360" y2="200" marker-end="url(#arr)"/>
<rect class="b" x="225" y="160" width="20" height="40"/>
<rect class="b1" x="245" y="160" width="20" height="40"/>
<rect class="b1" x="265" y="160" width="20" height="40"/>
<rect class="b1" x="285" y="160" width="20" height="40"/>
<rect class="b1" x="305" y="160" width="20" height="40"/>
<rect class="b1" x="325" y="160" width="20" height="40"/>
<line class="la" x1="245" y1="145" x2="345" y2="145"/>
<text class="ts" x="295" y="132" text-anchor="middle">当前窗口 = 最近 5 格</text>
<text class="ts" x="235" y="218" text-anchor="middle">过期</text>
<text class="ts" x="285" y="248" text-anchor="middle">窗口切成 N 个小格</text>
<text class="ts" x="285" y="266" text-anchor="middle">按格滑动，格越多越平滑</text>
<rect class="bg" x="390" y="10" width="170" height="280" rx="10"/>
<text class="tb" x="475" y="32" text-anchor="middle" dominant-baseline="middle">漏桶</text>
<line class="ld" x1="475" y1="50" x2="475" y2="88" marker-end="url(#arr)"/>
<text class="ts" x="485" y="66">突发流入</text>
<rect class="b1" x="430" y="90" width="90" height="90" rx="4"/>
<text class="t" x="475" y="135" text-anchor="middle" dominant-baseline="middle">请求队列</text>
<line class="la" x1="475" y1="180" x2="475" y2="214" marker-end="url(#arr-a)"/>
<text class="ts" x="485" y="204">恒定速率流出</text>
<text class="ts" x="475" y="248" text-anchor="middle">请求排队，匀速处理</text>
<text class="ts" x="475" y="266" text-anchor="middle">桶满即丢，不允许突发</text>
<rect class="bg" x="580" y="10" width="170" height="280" rx="10"/>
<text class="tb" x="665" y="32" text-anchor="middle" dominant-baseline="middle">令牌桶</text>
<line class="ld" x1="665" y1="50" x2="665" y2="88" marker-end="url(#arr)"/>
<text class="ts" x="675" y="66">匀速放令牌</text>
<rect class="b2" x="620" y="90" width="90" height="90" rx="4"/>
<text class="t" x="665" y="135" text-anchor="middle" dominant-baseline="middle">令牌 ≤ 容量</text>
<line class="la" x1="665" y1="180" x2="665" y2="214" marker-end="url(#arr-a)"/>
<text class="ts" x="675" y="204">取到即放行</text>
<text class="ts" x="665" y="248" text-anchor="middle">桶满则丢弃新令牌</text>
<text class="ts" x="665" y="266" text-anchor="middle">积攒的令牌允许突发</text>
</svg>
<figcaption>图 1：四种限流算法对比</figcaption>
</figure>

| 算法 | 原理 | 优点 | 缺点 | 典型实现 |
| --- | --- | --- | --- | --- |
| 固定窗口 | 每个时间窗口一个计数器 | 实现最简单 | 窗口边界可放过近 2 倍阈值 | Redis `INCR + EXPIRE` |
| 滑动窗口 | 窗口分成多个小格，统计最近 N 格之和 | 平滑、精度可调 | 格数多则内存与计算增加 | Sentinel LeapArray、Redis ZSET |
| 漏桶 | 请求进队列，固定速率出队 | 输出绝对平滑，保护下游 | 无法应对合理突发，排队增加延迟 | Nginx `limit_req`、Sentinel 匀速排队 |
| 令牌桶 | 固定速率生成令牌，请求取令牌 | 限制平均速率又允许突发 | 突发量受桶容量影响，需调参 | Guava RateLimiter、Spring Cloud Gateway |

### Java 实现

```java
// 1. 固定窗口：AtomicLong + 窗口起点
public class FixedWindowLimiter {
    private final long limit, windowMs;
    private volatile long windowStart = System.currentTimeMillis();
    private final AtomicLong counter = new AtomicLong();

    public boolean tryAcquire() {
        long now = System.currentTimeMillis();
        if (now - windowStart >= windowMs) {
            synchronized (this) {                       // 双检，只让一个线程重置
                if (now - windowStart >= windowMs) {
                    windowStart = now;
                    counter.set(0);
                }
            }
        }
        return counter.incrementAndGet() <= limit;
    }
}

// 2. 滑动窗口：环形数组，每格记录起始时间与计数
public class SlidingWindowLimiter {
    private final int buckets; private final long bucketMs; private final long limit;
    private final long[] starts; private final AtomicLongArray counts;

    public SlidingWindowLimiter(long limit, long windowMs, int buckets) {
        this.limit = limit; this.buckets = buckets; this.bucketMs = windowMs / buckets;
        this.starts = new long[buckets]; this.counts = new AtomicLongArray(buckets);
    }

    public synchronized boolean tryAcquire() {
        long now = System.currentTimeMillis();
        int idx = (int) ((now / bucketMs) % buckets);
        long start = now - now % bucketMs;
        if (starts[idx] != start) {                     // 该格已过期，复用
            starts[idx] = start;
            counts.set(idx, 0);
        }
        long sum = 0;
        for (int i = 0; i < buckets; i++) {
            if (now - starts[i] < bucketMs * buckets) sum += counts.get(i);
        }
        if (sum >= limit) return false;
        counts.incrementAndGet(idx);
        return true;
    }
}

// 3. 令牌桶：按时间差惰性补充令牌，不需要后台线程
public class TokenBucketLimiter {
    private final double capacity, permitsPerNano;
    private double tokens;
    private long last = System.nanoTime();

    public TokenBucketLimiter(double permitsPerSecond, double capacity) {
        this.capacity = capacity;
        this.permitsPerNano = permitsPerSecond / 1e9;
        this.tokens = capacity;
    }

    public synchronized boolean tryAcquire() {
        long now = System.nanoTime();
        tokens = Math.min(capacity, tokens + (now - last) * permitsPerNano);
        last = now;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    }
}
```

漏桶在「拒绝模式」下与令牌桶容量为 1 时等价；在「排队模式」下要计算每个请求的预计执行时间并让它等待，Sentinel 的匀速排队就是这种实现。

### Guava RateLimiter

Guava 的 `RateLimiter` 是令牌桶的变种，核心字段：`storedPermits`（存量令牌）、`maxPermits`、`stableIntervalMicros`（生成一个令牌的间隔）、`nextFreeTicketMicros`（下一次可以无等待获取的时间点）。

它有一个独特设计——**预支**：`acquire(n)` 即使令牌不够也立即返回，把 `nextFreeTicketMicros` 往后推，**由下一个请求承担等待**。这样一次大请求不会让自己等待过久，但紧随其后的请求会等更久。

| 实现 | 创建方式 | 特点 |
| --- | --- | --- |
| SmoothBursty | `RateLimiter.create(qps)` | 空闲时最多积攒 1 秒（`maxBurstSeconds = 1.0`）的令牌，允许突发 |
| SmoothWarmingUp | `RateLimiter.create(qps, warmup, unit)` | 冷启动时发放速率较低（冷却因子固定为 3），在预热期内逐步升到稳定速率，适合需要预热缓存/连接/JIT 的服务 |

```java
RateLimiter limiter = RateLimiter.create(200);                     // 每秒 200 个
if (!limiter.tryAcquire(20, TimeUnit.MILLISECONDS)) {              // 最多等 20ms
    throw new TooManyRequestsException();
}
RateLimiter warm = RateLimiter.create(200, 10, TimeUnit.SECONDS);  // 10 秒预热
```

> [!WARNING] Guava 是单机限流
> 集群总阈值 = 单机阈值 × 实例数，扩缩容时总量随之变化；实例间流量不均时也不准。需要严格总量控制（如调用第三方接口的配额）请用分布式限流。

## Sentinel

### 滑动窗口 LeapArray

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="Sentinel LeapArray：长度为 2 的环形数组，每个桶 500 毫秒，当前时间 1300 毫秒映射到下标 0，过期桶被重置复用">
<text class="ts" x="20" y="24">LeapArray（sampleCount = 2，intervalInMs = 1000，每桶 500ms）</text>
<rect class="b3" x="160" y="40" width="200" height="60" rx="8"/>
<text class="tb" x="260" y="60" text-anchor="middle" dominant-baseline="middle">array[0]</text>
<text class="tm" x="260" y="82" text-anchor="middle" dominant-baseline="middle">start=1000 pass=120</text>
<rect class="b1" x="380" y="40" width="200" height="60" rx="8"/>
<text class="tb" x="480" y="60" text-anchor="middle" dominant-baseline="middle">array[1]</text>
<text class="tm" x="480" y="82" text-anchor="middle" dominant-baseline="middle">start=500 pass=95</text>
<rect class="b1" x="210" y="160" width="150" height="20"/>
<text class="tm" x="285" y="170" text-anchor="middle" dominant-baseline="middle">array[1]</text>
<rect class="b3" x="360" y="160" width="150" height="20"/>
<text class="tm" x="435" y="170" text-anchor="middle" dominant-baseline="middle">array[0]</text>
<line class="l" x1="60" y1="180" x2="680" y2="180" marker-end="url(#arr)"/>
<text class="ts" x="60" y="198" text-anchor="middle">0</text>
<text class="ts" x="210" y="198" text-anchor="middle">500</text>
<text class="ts" x="360" y="198" text-anchor="middle">1000</text>
<text class="ts" x="510" y="198" text-anchor="middle">1500</text>
<text class="ts" x="660" y="198" text-anchor="middle">2000 ms</text>
<line class="la" x1="450" y1="122" x2="450" y2="158" marker-end="url(#arr-a)"/>
<text class="ta" x="460" y="136">now = 1300ms</text>
<text class="ts" x="360" y="222" text-anchor="middle">idx = (now / 500) % 2 = 0；windowStart = now − now % 500 = 1000；桶的 start 过期则重置复用</text>
</svg>
<figcaption>图 2：Sentinel 用环形数组实现的滑动窗口</figcaption>
</figure>

- 秒级统计默认 2 个桶（每桶 500ms），分钟级统计 60 个桶；QPS = 窗口内**未过期**桶的计数之和；
- 获取当前桶时：桶不存在则 CAS 创建；桶的 `windowStart` 相同直接用；桶已过期则加锁重置后复用——不需要后台清理线程；
- 桶内计数用 `LongAdder`，高并发写入无锁竞争。

### 处理链与规则

每个资源对应一条 **ProcessorSlotChain**：`NodeSelectorSlot`（构建调用树）→ `ClusterBuilderSlot` → `StatisticSlot`（实时统计）→ `AuthoritySlot`（黑白名单）→ `SystemSlot`（系统保护）→ `FlowSlot`（流控）→ `DegradeSlot`（熔断）等，热点参数限流由 `ParamFlowSlot` 完成。前面的 Slot 负责统计，后面的 Slot 根据统计做判断，被拦截抛 `BlockException`。

| 规则 | 关键配置 | 说明 |
| --- | --- | --- |
| 流控 FlowRule | 阈值类型 QPS / 线程数；流控模式 直接 / 关联 / 链路；效果 快速失败 / Warm Up / 匀速排队 | Warm Up 默认冷却因子 3，从阈值的 1/3 开始在预热时长内升至阈值；匀速排队即漏桶，适合削峰填谷 |
| 熔断 DegradeRule | 慢调用比例 / 异常比例 / 异常数；`minRequestAmount`（默认 5）、`statIntervalMs`、`timeWindow` 熔断时长 | 1.8 起支持半开状态，熔断时长结束后放行一个探测请求 |
| 系统自适应 SystemRule | Load、CPU 使用率、平均 RT、入口 QPS、并发线程数 | Load 模式借鉴 TCP BBR：系统负载超阈值时，以「最大 QPS × 最小 RT」估算的容量判断是否放行，只对入口流量生效 |
| 热点参数 ParamFlowRule | 参数下标、单值阈值、例外项 | 按参数值（如商品 ID）分别统计，用 LRU 缓存热点值，适合秒杀商品维度限流 |
| 授权 AuthorityRule | 来源黑白名单 | 基于 `origin` |

```java
// 规则通常由控制台推送到 Nacos 等配置中心持久化，这里演示代码方式
FlowRule rule = new FlowRule("createOrder");
rule.setGrade(RuleConstant.FLOW_GRADE_QPS);
rule.setCount(1000);
rule.setControlBehavior(RuleConstant.CONTROL_BEHAVIOR_WARM_UP);
rule.setWarmUpPeriodSec(10);
FlowRuleManager.loadRules(List.of(rule));

try (Entry entry = SphU.entry("createOrder")) {
    return orderService.create(req);
} catch (BlockException e) {                  // 被限流或熔断
    return Result.fail("系统繁忙，请稍后再试");
}
```

> [!TIP]
> 控制台推送的规则默认只在客户端内存中，重启即丢。生产必须改造为「控制台 → 配置中心（Nacos/Apollo）→ 客户端监听」的 push 模式，并保证控制台修改能写回配置中心。

### 集群流控

Sentinel 集群流控由 Token Server 统一发放令牌：客户端每次请求向 Token Server 申请，Token Server 不可用时**退化为单机限流**（`fallbackToLocalWhenFail`）。Token Server 可独立部署或嵌入某个应用实例。

## 分布式限流

### Redis + Lua 令牌桶

```lua
-- KEYS[1] 令牌数 key，KEYS[2] 上次刷新时间 key
-- ARGV[1] 每秒速率，ARGV[2] 桶容量，ARGV[3] 当前时间（秒，可带小数），ARGV[4] 本次申请令牌数
local rate      = tonumber(ARGV[1])
local capacity  = tonumber(ARGV[2])
local now       = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = math.max(1, math.floor(capacity / rate * 2))   -- 两倍填满时间后自动过期

local tokens = tonumber(redis.call('GET', KEYS[1]) or capacity)
local last   = tonumber(redis.call('GET', KEYS[2]) or 0)
tokens = math.min(capacity, tokens + math.max(0, now - last) * rate)

local allowed = tokens >= requested
if allowed then
  tokens = tokens - requested
end
redis.call('SETEX', KEYS[1], ttl, tokens)
redis.call('SETEX', KEYS[2], ttl, now)
return allowed and 1 or 0
```

要点：

- Lua 脚本在 Redis 中原子执行，避免「读-计算-写」的竞态；
- Cluster 模式下多个 key 必须在同一 slot，用 hash tag：`{rl:api:order}:tokens`、`{rl:api:order}:ts`；
- 当前时间由调用方传入时，各应用实例时钟要同步；也可以在脚本里用 `redis.call('TIME')`（Redis 5 起默认按效果复制，脚本中可以使用非确定性命令）；
- 单个限流 key 是热点，QPS 极高时可以**本地预取**：每个实例一次取一批令牌在本地消耗；
- 滑动窗口日志的另一种实现：ZSET 以时间戳为 score，`ZREMRANGEBYSCORE` 清理窗口外记录后 `ZCARD` 计数，精确但每个请求占一个成员，只适合低阈值场景。

### 网关层限流

| 网关 | 方式 |
| --- | --- |
| Nginx | `limit_req_zone` 漏桶（`burst` 允许排队数量，`nodelay` 不延迟处理突发），`limit_conn` 限并发连接，见 [Nginx 与负载均衡](#/infra/nginx) |
| Spring Cloud Gateway | `RequestRateLimiter` 过滤器，基于 Redis 令牌桶：`replenishRate`、`burstCapacity`、`requestedTokens`，按 `KeyResolver`（用户/IP/接口）限流 |
| Sentinel 网关适配 | 按路由或 API 分组限流，支持参数（Header、IP、URL 参数）维度 |

分层限流的原则：**越靠前越粗**（网关按 IP/用户/接口总量限流挡住恶意和超量流量），**越靠后越细**（服务内按资源、热点参数限流保护具体接口），DB 前还要有连接池上限兜底。

## 熔断

### 熔断器状态机

<figure class="fig">
<svg viewBox="0 0 720 240" class="dg" role="img" aria-label="熔断器状态机：Closed 在失败率超阈值后转为 Open，冷却期满转 Half-Open，探测成功回到 Closed，探测失败重新 Open">
<text class="ts" x="115" y="72" text-anchor="middle">滑动窗口统计调用结果</text>
<rect class="b2" x="40" y="90" width="150" height="56" rx="8"/>
<text class="tb" x="115" y="110" text-anchor="middle" dominant-baseline="middle">Closed</text>
<text class="ts" x="115" y="130" text-anchor="middle" dominant-baseline="middle">正常放行</text>
<text class="ts" x="605" y="72" text-anchor="middle">直接快速失败 / 走降级</text>
<rect class="b4" x="530" y="90" width="150" height="56" rx="8"/>
<text class="tb" x="605" y="110" text-anchor="middle" dominant-baseline="middle">Open</text>
<text class="ts" x="605" y="130" text-anchor="middle" dominant-baseline="middle">全部拒绝</text>
<rect class="b3" x="285" y="170" width="150" height="56" rx="8"/>
<text class="tb" x="360" y="190" text-anchor="middle" dominant-baseline="middle">Half-Open</text>
<text class="ts" x="360" y="210" text-anchor="middle" dominant-baseline="middle">只放行 N 个探测请求</text>
<line class="la" x1="190" y1="106" x2="528" y2="106" marker-end="url(#arr-a)"/>
<text class="ts" x="360" y="96" text-anchor="middle">失败率或慢调用率 ≥ 阈值（且调用数 ≥ 最小调用数）</text>
<line class="l" x1="560" y1="146" x2="437" y2="184" marker-end="url(#arr)"/>
<text class="ts" x="470" y="150" text-anchor="end">冷却期满后半开</text>
<line class="l" x1="285" y1="198" x2="152" y2="148" marker-end="url(#arr)"/>
<text class="ts" x="110" y="200" text-anchor="middle">探测成功率达标</text>
<line class="l" x1="435" y1="212" x2="640" y2="212"/>
<line class="l" x1="640" y1="212" x2="640" y2="148" marker-end="url(#arr)"/>
<text class="ts" x="540" y="230" text-anchor="middle">探测失败，重新打开</text>
</svg>
<figcaption>图 3：熔断器三态转换</figcaption>
</figure>

熔断的价值：下游已经不可用时，继续调用只会占用线程、拖长响应，还会让下游更难恢复。Open 状态快速失败，给下游留出恢复时间；Half-Open 用少量请求试探，避免恢复瞬间被流量再次打垮。

### Resilience4j

Hystrix 自 2018 年起进入维护模式，Spring Cloud 新版本推荐 Resilience4j（Spring Cloud CircuitBreaker 抽象）或 Sentinel。

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `slidingWindowType` | COUNT_BASED | 流量稳定用计数窗口；流量波动大用 TIME_BASED |
| `slidingWindowSize` | 100 | 计数窗口为最近 N 次调用；时间窗口为最近 N 秒 |
| `minimumNumberOfCalls` | 100 | 低于该调用数不计算失败率，低流量接口要调小，否则永远不熔断 |
| `failureRateThreshold` | 50（%） | 按业务容忍度 |
| `slowCallDurationThreshold` | 60000ms | 默认值过大，应按下游 P99 设置 |
| `slowCallRateThreshold` | 100（%） | 通常调到 50～80 |
| `waitDurationInOpenState` | 60000ms | 一般 5～30s |
| `permittedNumberOfCallsInHalfOpenState` | 10 | 探测请求数 |
| `automaticTransitionFromOpenToHalfOpenEnabled` | false | false 时要等到有新请求才转半开 |

```yaml
resilience4j:
  circuitbreaker:
    instances:
      inventory:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 50
        minimum-number-of-calls: 20
        failure-rate-threshold: 50
        slow-call-duration-threshold: 800ms
        slow-call-rate-threshold: 60
        wait-duration-in-open-state: 10s
        permitted-number-of-calls-in-half-open-state: 5
        record-exceptions:
          - java.io.IOException
          - java.util.concurrent.TimeoutException
        ignore-exceptions:
          - com.example.BizException        # 业务异常不应计入失败率
```

```java
@CircuitBreaker(name = "inventory", fallbackMethod = "stockFallback")
@Bulkhead(name = "inventory")
@Retry(name = "inventory")
public StockDTO queryStock(Long skuId) {
    return inventoryClient.query(skuId);
}

private StockDTO stockFallback(Long skuId, Throwable t) {
    return StockDTO.unknown(skuId);          // 降级：展示「库存紧张」而不是报错
}
```

> [!NOTE] 注解的执行顺序
> Resilience4j 注解默认的切面顺序为 `Retry ( CircuitBreaker ( RateLimiter ( TimeLimiter ( Bulkhead ( 方法 ) ) ) ) )`，即重试在最外层，每次重试都要经过熔断器判断；熔断打开后重试拿到的是 `CallNotPermittedException`，应配置为不重试。

## 降级

降级是「有损但可用」的预案，按触发方式分：

| 类型 | 做法 | 例子 |
| --- | --- | --- |
| 自动降级 | 熔断、限流、超时后执行 fallback | 推荐服务超时返回热门榜单缓存 |
| 开关降级 | 配置中心开关，人工或预案平台一键切换 | 大促时关闭评论、积分、个性化推荐 |
| 读降级 | 读缓存/静态数据/默认值，不访问 DB 或下游 | 商品详情读本地缓存兜底 |
| 写降级 | 同步写改为异步写（MQ、日志），稍后补偿 | 积分发放改为异步 |
| 功能降级 | 关闭非核心功能、简化页面 | 隐藏「猜你喜欢」 |

> [!WARNING]
> 降级逻辑平时很少执行，最容易在关键时刻失效：fallback 中调用了另一个同样故障的服务、返回了 null 导致上游 NPE、开关推送失败。**降级预案必须在压测和演练中实际触发过**。

## 超时与重试

### 超时设置原则

- **必须设置**：任何网络调用（HTTP、RPC、DB、Redis、MQ）都不能用无限超时；JDK `HttpURLConnection`、部分 HTTP 客户端默认无超时或超时极长。
- **按下游 P99/P999 设置**：略大于下游正常耗时的 P99，再加少量余量；设得太大等于没设，太小会误杀。
- **连接超时与读超时分开**：连接超时短（通常 1s 左右，同机房建连只需毫秒级），读超时按接口区分。
- **沿调用链递减**：上游超时应大于下游超时 × 重试次数之和，否则上游已放弃、下游还在干活；更好的做法是**传递截止时间（deadline）**，每一跳用剩余时间作为超时（gRPC deadline 传播）。
- **线程池排队时间也算**：请求在业务线程池队列里等了 2 秒，即使执行很快，调用方也早已超时。

### 重试

```java
// 指数退避 + Full Jitter：sleep = random(0, min(cap, base * 2^attempt))
public <T> T callWithRetry(Supplier<T> call, int maxAttempts) {
    long baseMs = 50, capMs = 2000;
    for (int attempt = 0; ; attempt++) {
        try {
            return call.get();
        } catch (RetryableException e) {           // 只重试可重试的错误：超时、连接失败、503
            if (attempt + 1 >= maxAttempts || !retryBudget.tryAcquire()) {
                throw e;
            }
            long backoff = Math.min(capMs, baseMs << attempt);
            sleep(ThreadLocalRandom.current().nextLong(backoff + 1));
        }
    }
}
```

- **只重试幂等操作**，并且只对可重试错误重试（超时、连接拒绝、限流 429/503），业务错误（参数错误、余额不足）不重试；
- **指数退避 + 抖动**：纯指数退避下，同时失败的客户端会在同一时刻集体重试，抖动把它们打散；
- **重试风暴**：调用链 4 层，每层重试 3 次，最底层的请求放大到 3^4 = 81 倍。原则是**只在一层重试**（通常靠近出错处或最外层），其他层快速失败；
- **重试预算**：限制重试请求占总请求的比例（如 10%），超过则不再重试；或者采用「熔断开启时不重试」；
- **对冲请求（Hedged Request）**：对长尾延迟敏感的只读请求，在 P95 时间仍未返回时向另一副本再发一次，取先到的结果——用少量额外负载换取尾延迟。

## 舱壁隔离

把资源按下游或业务划分成独立的「舱」，一个下游变慢只会耗尽自己的舱：

| 维度 | 线程池隔离 | 信号量隔离 |
| --- | --- | --- |
| 原理 | 每个下游独立线程池，调用在池中执行 | 计数器限制并发数，在调用线程上执行 |
| 超时控制 | 可以：调用线程 `future.get(timeout)` 后放弃 | 不能主动中断，只能依赖下游客户端超时 |
| 开销 | 线程切换、上下文传递（ThreadLocal、TraceId 需显式传递） | 几乎为零 |
| 适用 | 依赖不可信的外部调用、需要异步 | 内部高 QPS、低延迟调用，网关 |
| 实现 | Hystrix 默认（每组默认 10 个线程）、Resilience4j `ThreadPoolBulkhead` | Sentinel 线程数限流、Resilience4j `SemaphoreBulkhead`（默认最大并发 25） |

线程池配置细节见 [线程池原理与调优](#/java/concurrency/pool)。

## 负载均衡

| 算法 | 原理 | 适用 |
| --- | --- | --- |
| 轮询 | 依次分配 | 节点同构 |
| 加权轮询 | 按权重分配；Nginx 用**平滑加权轮询**避免同一节点连续命中 | 节点配置不同 |
| 随机 / 加权随机 | 按权重随机，请求量大时趋近权重比例 | Dubbo 默认 |
| 最少连接 / 最少活跃数 | 选当前在途请求最少的节点，慢节点自然少分 | 请求耗时差异大 |
| P2C（Power of Two Choices） | 随机选两个，取负载较低者 | 大规模集群，避免全局最小值引起的羊群效应 |
| 源地址/参数哈希 | 相同 key 落到同一节点 | 会话保持、本地缓存命中 |
| 一致性哈希 | 哈希环 + 虚拟节点 | 缓存集群、有状态路由 |

平滑加权轮询：每轮每个节点 `current += weight`，选 `current` 最大者，然后被选中者 `current -= totalWeight`。权重 `{a:5, b:1, c:1}` 产生序列 `a a b a c a a`，b、c 被打散在中间，而不是 `a a a a a b c`。

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="一致性哈希环：三个物理节点各映射两个虚拟节点交错分布在环上，key 顺时针找到第一个节点">
<circle class="b" cx="200" cy="150" r="110"/>
<circle class="b1" cx="200" cy="40" r="9"/>
<text class="tb" x="200" y="18" text-anchor="middle" dominant-baseline="middle">A</text>
<circle class="b2" cx="295" cy="95" r="9"/>
<text class="tb" x="318" y="82" dominant-baseline="middle">B#1</text>
<circle class="b3" cx="295" cy="205" r="9"/>
<text class="tb" x="318" y="220" dominant-baseline="middle">C</text>
<circle class="b1" cx="200" cy="260" r="9"/>
<text class="tb" x="200" y="284" text-anchor="middle" dominant-baseline="middle">A#1</text>
<circle class="b2" cx="105" cy="205" r="9"/>
<text class="tb" x="82" y="220" text-anchor="end" dominant-baseline="middle">B</text>
<circle class="b3" cx="105" cy="95" r="9"/>
<text class="tb" x="82" y="82" text-anchor="end" dominant-baseline="middle">C#1</text>
<circle class="bf" cx="255" cy="55" r="5"/>
<text class="ta" x="266" y="44">k1</text>
<text class="ts" x="200" y="150" text-anchor="middle" dominant-baseline="middle">0 ~ 2^32−1 首尾相连</text>
<text class="th" x="390" y="40">一致性哈希 + 虚拟节点</text>
<text class="t" x="390" y="76">节点按 hash(ip#i) 映射到环上</text>
<text class="t" x="390" y="102">key 沿顺时针找到第一个节点</text>
<text class="ta" x="390" y="128">k1 位于 A 与 B#1 之间 → 由 B 处理</text>
<text class="t" x="390" y="154">增删节点只影响环上相邻一段</text>
<text class="t" x="390" y="180">虚拟节点：每台物理机映射多个点</text>
<text class="t" x="390" y="206">分布更均匀，节点下线时</text>
<text class="t" x="390" y="232">压力分散给多台而不是一台</text>
</svg>
<figcaption>图 4：一致性哈希与虚拟节点</figcaption>
</figure>

普通取模哈希 `hash(key) % N` 在 N 变化时几乎所有 key 都要迁移；一致性哈希只迁移 `1/N` 左右。节点少时环上分布不均，需要**虚拟节点**（Dubbo 一致性哈希默认每个节点 160 个虚拟节点），实现上常用 `TreeMap.ceilingEntry(hash)` 查找顺时针第一个节点。

## 生产实践与踩坑

- **限流阈值拍脑袋**：阈值应来自压测得到的单机容量（如 CPU 60% 时的 QPS）× 安全系数，而不是经验值；扩容后记得同步调整单机阈值或使用集群限流。
- **熔断统计包含业务异常**：参数校验失败、余额不足等业务异常被计入失败率，误触发熔断。用 `ignore-exceptions` 排除，或业务错误用返回码而不是异常表达。
- **低流量接口永远不熔断**：`minimumNumberOfCalls` 默认 100，某接口每分钟只有几十次调用，下游已经全挂也不熔断。按接口流量调小该值，或改用时间窗口。
- **Feign / Ribbon 双重超时与重试**：Feign、负载均衡器、Hystrix/Resilience4j 都有各自的超时和重试，叠加后实际重试次数和超时远超预期。统一在一处配置，并实际验证一次失败调用的总耗时与次数。
- **重试导致重复下单**：网关对 POST 接口自动重试，下游已执行成功但响应超时。写接口禁止框架重试，必须重试时携带幂等键。
- **线程池隔离丢失上下文**：调用转到隔离线程池后 TraceId、用户信息、事务都丢了。使用 TransmittableThreadLocal 或框架提供的上下文传播装饰器。
- **一致性哈希热点 key**：哈希只能保证 key 均匀，不能保证流量均匀，单个热点 key 仍会打爆一个节点，需要本地缓存或热点 key 拆分（见 [缓存设计与一致性](#/redis/cache)）。

## 相关阅读

- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：限流算法：令牌桶与滑动窗口
- [gRPC 与 Protobuf：协议、流式调用与治理](#/mw/grpc)：Deadline 与重试预算
- [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release)：灰度、降级与回滚
- [Nacos 与服务注册发现、配置中心](#/mw/registry)：注册中心的剔除窗口与保护阈值
- [熔断限流实战：Sentinel 与 Resilience4j](#/spring/cloud-resilience)：框架中的落地与规则持久化
- [故障模型、故障检测与脑裂](#/distributed/fault)：重试风暴与亚稳态
- [高可用架构设计：可用性计算、故障域与容灾](#/design/arch-availability)：体系化的高可用设计

## 面试追问

> [!QUESTION] 令牌桶和漏桶的区别？各适合什么场景？
> 漏桶以固定速率处理请求，输出绝对平滑，突发会排队或被丢弃，适合保护处理能力固定的下游（如第三方接口的严格 QPS 配额）；令牌桶以固定速率生成令牌，积攒的令牌允许短时突发，平均速率仍受控，适合大多数需要容忍合理突发的接口限流。

> [!QUESTION] Guava RateLimiter 的「预支」是什么意思？
> `acquire` 时令牌不足不会让当前请求等到令牌够，而是立即放行并把下次可获取时间 `nextFreeTicketMicros` 往后推，由后续请求偿还等待时间。这样大请求不会被不合理地阻塞，整体速率仍然受控。

> [!QUESTION] Sentinel 的滑动窗口是怎么实现的？
> LeapArray 是固定长度的环形数组，每个元素是一个时间桶（默认 1 秒 2 个桶）。根据当前时间计算下标和桶起始时间，桶过期就重置复用，计数用 LongAdder；统计 QPS 时累加未过期桶的值。不需要额外清理线程，内存固定。

> [!QUESTION] 熔断器的半开状态有什么作用？
> Open 状态下无法得知下游是否恢复；冷却期满后进入半开，只放行少量探测请求：成功率达标就关闭熔断，失败就重新打开。避免直接全部放行导致刚恢复的下游再次被打垮。

> [!QUESTION] 如何避免重试风暴？
> 只在调用链的一层重试；只重试幂等操作和可重试错误；指数退避加随机抖动；设置重试预算（重试量不超过正常请求的一定比例）；熔断开启时不重试；服务端过载时返回明确的「不要重试」信号。

> [!QUESTION] 线程池隔离和信号量隔离怎么选？
> 线程池隔离能真正做超时控制和异步，故障完全隔离，但有线程切换和上下文传递成本，适合不可信或耗时长的外部依赖；信号量隔离只限制并发数，开销极小但无法中断慢调用，适合内部高 QPS 调用和网关场景。
