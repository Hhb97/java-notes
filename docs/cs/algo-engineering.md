---
level: 高级
tags: [算法, 布隆过滤器, 一致性哈希, 限流算法, 令牌桶, 滑动窗口, Top K, HyperLogLog, 时间轮, 雪花算法, Trie, 海量数据]
summary: 后端系统里真正会用到的算法：布隆过滤器与缓存穿透、一致性哈希与虚拟节点、四种限流算法（固定/滑动窗口、漏桶、令牌桶）、时间轮、海量数据 Top K 与去重（Count-Min Sketch、HyperLogLog、位图）、字符串匹配与敏感词、红包/抽奖等随机算法、雪花 ID，每个给出原理、参数估算与 Java 实现。
---

# 工程中的算法：布隆、一致性哈希、限流与 Top K

> [!ABSTRACT] 核心要点
> - 工程算法的共同特征：**用少量空间/精度换巨大的时间或空间收益**——布隆过滤器（允许误判）、HyperLogLog（近似基数）、Count-Min Sketch（近似频次）都是“概率型数据结构”。
> - **布隆过滤器**：判断“一定不存在 / 可能存在”，**没有假阴性，有可控假阳性**，不能删除（Counting 版本除外）。典型用途：**缓存穿透防护**、爬虫 URL 判重、推荐去重。
> - **一致性哈希**：节点增减时只迁移 K/N 的数据（普通取模会几乎全量重分布）；**虚拟节点**解决倾斜；Redis Cluster 用的是**哈希槽**（16384）而不是严格的一致性哈希。
> - **限流**：固定窗口有临界突刺，滑动窗口更平滑，**漏桶**整形匀速，**令牌桶**允许突发（Guava RateLimiter、Sentinel、Nginx limit_req 都用到）。
> - **海量数据**问题的套路：**分治（哈希分片）+ 局部统计 + 合并**；单机统计用**堆 / 位图 / 概率结构**。

> [!NOTE] 关联
> 基础数据结构与解题套路见 [复杂度与核心数据结构](#/cs/algo-ds)、[解题套路](#/cs/algo-patterns)。限流熔断的系统层面见 [限流、熔断与降级](#/distributed/governance)。

## 一、布隆过滤器（Bloom Filter）

### 1. 原理

一个长度为 m 的**位数组** + k 个**独立哈希函数**。

- **添加**：用 k 个哈希函数算出 k 个位置，全部置 1；
- **查询**：k 个位置**全为 1 → “可能存在”**（可能被其他元素置位，产生**假阳性**）；**任一为 0 → “一定不存在”**。

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="布隆过滤器：位数组长度 m，元素经过 k 个哈希函数映射到 k 个位置并置 1；查询时若所有位置都是 1 则可能存在，任一位置为 0 则一定不存在；不同元素的位置可能重叠，造成假阳性；用于缓存穿透防护，先查布隆过滤器，不存在直接返回不查数据库">
<text class="th" x="20" y="24">位数组（m 位，初始全 0）</text>
<rect class="b" x="40" y="40" width="24" height="30" rx="2"/><rect class="b3" x="68" y="40" width="24" height="30" rx="2"/><rect class="b" x="96" y="40" width="24" height="30" rx="2"/><rect class="b3" x="124" y="40" width="24" height="30" rx="2"/><rect class="b" x="152" y="40" width="24" height="30" rx="2"/><rect class="b3" x="180" y="40" width="24" height="30" rx="2"/><rect class="b" x="208" y="40" width="24" height="30" rx="2"/><rect class="b" x="236" y="40" width="24" height="30" rx="2"/><rect class="b3" x="264" y="40" width="24" height="30" rx="2"/><rect class="b" x="292" y="40" width="24" height="30" rx="2"/><rect class="b3" x="320" y="40" width="24" height="30" rx="2"/><rect class="b" x="348" y="40" width="24" height="30" rx="2"/>
<text class="ts" x="80" y="92" text-anchor="middle">1</text><text class="ts" x="136" y="92" text-anchor="middle">1</text><text class="ts" x="192" y="92" text-anchor="middle">1</text><text class="ts" x="276" y="92" text-anchor="middle">1</text><text class="ts" x="332" y="92" text-anchor="middle">1</text>
<text class="ts" x="400" y="52" text-anchor="start">添加 "x"：k=3 个哈希 → 置位 1、3、5（示意）</text>
<text class="ts" x="400" y="72" text-anchor="start">添加 "y"：置位 3、8、10（与 x 共用第 3 位）</text>
<text class="ta" x="400" y="98" text-anchor="start">查 "z"：位 1、5、8 恰好都是 1 → 误判“可能存在”（假阳性）</text>
<rect class="bg" x="20" y="124" width="760" height="140" rx="10"/>
<text class="th" x="36" y="148">应用：缓存穿透防护</text>
<text class="ts" x="36" y="170">请求 → 布隆过滤器（装载全部合法 ID）→「一定不存在」直接返回 → 不打缓存/数据库；「可能存在」才走 Redis → MySQL</text>
<text class="ts" x="36" y="192">• 没有假阴性：合法 ID 不会被误拦；假阳性只是少量恶意/不存在的 ID 漏过，数据库压力可控</text>
<text class="ts" x="36" y="212">• 局限：不支持删除（置 0 会影响其他元素）→ 定期重建，或用 Counting Bloom / Cuckoo Filter</text>
<text class="ts" x="36" y="232">• 实现：Guava BloomFilter（单机）、Redisson RBloomFilter、RedisBloom 模块（分布式共享）</text>
<text class="ts" x="36" y="252">• 数据增长要预估容量：元素远超设计容量，误判率会急剧上升</text>
</svg>
<figcaption>图 1：布隆过滤器与缓存穿透防护</figcaption>
</figure>

### 2. 参数估算

设预期元素数 n、目标误判率 p：

- 位数组大小 **m = −n·ln p / (ln 2)² ≈ 9.6n（p=1%）/ 14.4n（p=0.1%）位**；
- 哈希函数个数 **k = (m/n)·ln 2 ≈ 0.7·m/n**（p=1% 约 7 个，p=0.1% 约 10 个）。

例：1 亿个 ID，p=1% → m ≈ 9.6 亿位 ≈ **约 115 MB**；而用 HashSet 存 1 亿个 Long 需要数 GB。

```java
// Guava：预期 1000 万元素，误判率 1%
BloomFilter<Long> bf = BloomFilter.create(Funnels.longFunnel(), 10_000_000, 0.01);
bf.put(10086L);
boolean maybe = bf.mightContain(10086L);        // true = 可能存在；false = 一定不存在

// 缓存穿透防护使用方式
Product get(long id) {
    if (!bf.mightContain(id)) return null;       // 一定不存在，直接返回
    Product p = cache.get(id);                   // Redis
    return p != null ? p : loadFromDbAndCache(id);
}
```

对比**缓存空值**方案（不存在也缓存短 TTL 的空对象）：简单，但海量不同的恶意 key 会撑爆缓存，布隆过滤器更省空间；两者可以结合（见 [缓存穿透/击穿/雪崩](#/redis/cache)）。

## 二、一致性哈希

### 1. 问题

N 个缓存节点，按 `hash(key) % N` 路由。节点增减时 N 变化，**几乎所有 key 的映射都变** → 缓存大面积失效（雪崩），回源压垮数据库。

### 2. 哈希环 + 虚拟节点

<figure class="fig">
<svg viewBox="0 0 800 320" class="dg" role="img" aria-label="一致性哈希环：节点和 key 都映射到 0 到 2 的 32 次方减 1 的环上，key 顺时针找到的第一个节点负责存储；新增节点只影响它到前一个节点之间的 key；每个物理节点映射多个虚拟节点使分布更均匀">
<circle class="b3 nf" cx="200" cy="160" r="110"/>
<circle class="b2" cx="200" cy="50" r="14"/>
<text class="ts" x="200" y="54" text-anchor="middle" dominant-baseline="middle">A</text>
<circle class="b2" cx="310" cy="190" r="14"/>
<text class="ts" x="310" y="194" text-anchor="middle" dominant-baseline="middle">B</text>
<circle class="b2" cx="120" cy="240" r="14"/>
<text class="ts" x="120" y="244" text-anchor="middle" dominant-baseline="middle">C</text>
<circle class="b5" cx="285" cy="100" r="8"/>
<text class="ts" x="300" y="94" text-anchor="start">key1 → 顺时针 → B</text>
<circle class="b5" cx="140" cy="80" r="8"/>
<text class="ts" x="60" y="70" text-anchor="start">key2 → A</text>
<circle class="b4" cx="215" cy="268" r="14"/>
<text class="ts" x="215" y="272" text-anchor="middle" dominant-baseline="middle">D</text>
<text class="ta" x="40" y="300" text-anchor="start">新增节点 D：只接管 B~D 之间的 key，其余不动</text>
<text class="ts" x="200" y="165" text-anchor="middle">哈希环</text>
<text class="ts" x="200" y="183" text-anchor="middle">0 ~ 2³²-1</text>
<rect class="bg" x="400" y="30" width="380" height="270" rx="12"/>
<text class="th" x="416" y="56">要点</text>
<text class="ts" x="416" y="82">• 节点与 key 用同一哈希函数映射到环上</text>
<text class="ts" x="416" y="104">• key 顺时针找到的第一个节点负责它</text>
<text class="ts" x="416" y="126">• 增删节点只影响相邻区间：迁移约 K/N 数据</text>
<text class="ts" x="416" y="156">问题：节点少时分布不均、一个节点宕机</text>
<text class="ts" x="416" y="176">压力全落在顺时针下一个节点上（雪崩）</text>
<text class="th" x="416" y="206">虚拟节点</text>
<text class="ts" x="416" y="228">• 每个物理节点映射 100~200 个虚拟节点散布在环上</text>
<text class="ts" x="416" y="248">• 负载更均匀；宕机时压力分摊给多个节点</text>
<text class="ts" x="416" y="268">• 可按机器性能分配不同数量虚拟节点（加权）</text>
<text class="ts" x="416" y="288">应用：Memcached 客户端、Nginx、Dubbo 负载均衡</text>
</svg>
<figcaption>图 2：一致性哈希环与虚拟节点</figcaption>
</figure>

```java
class ConsistentHash<T> {
    private final TreeMap<Long, T> ring = new TreeMap<>();     // 红黑树：找“顺时针第一个”用 ceilingEntry，O(log n)
    private final int vnodes;
    ConsistentHash(Collection<T> nodes, int vnodes) { this.vnodes = vnodes; nodes.forEach(this::add); }

    void add(T node) { for (int i = 0; i < vnodes; i++) ring.put(hash(node + "#" + i), node); }
    void remove(T node) { for (int i = 0; i < vnodes; i++) ring.remove(hash(node + "#" + i)); }

    T route(String key) {
        if (ring.isEmpty()) return null;
        Map.Entry<Long, T> e = ring.ceilingEntry(hash(key));   // 顺时针第一个 >= hash 的虚拟节点
        return (e != null ? e : ring.firstEntry()).getValue(); // 越过末尾则回到环首
    }
    private long hash(String s) {                              // 用分布均匀的哈希（MurmurHash/FNV），不要用 String.hashCode
        return com.google.common.hash.Hashing.murmur3_128().hashUnencodedChars(s).asLong();
    }
}
```

**与 Redis Cluster 的区别**：Redis 把空间分成固定的 **16384 个哈希槽**，槽分配给节点，迁移以槽为单位，管理更显式（见 [Redis 集群](#/redis/cluster)）。分库分表的路由与扩容见 [分库分表](#/mysql/sharding)。

## 三、限流算法

### 1. 四种算法对比

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="四种限流算法对比：固定窗口计数简单但窗口边界可能放过两倍突发；滑动窗口把窗口切成小格平滑统计；漏桶以恒定速率流出，对突发进行整形排队；令牌桶按固定速率生成令牌，桶里有令牌就放行，允许一定突发">
<rect class="b4" x="20" y="20" width="370" height="140" rx="12"/>
<text class="th" x="36" y="44">固定窗口计数</text>
<text class="ts" x="36" y="68">每个时间窗口（如 1s）计数，超阈值拒绝</text>
<text class="ts" x="36" y="90">✓ 最简单、O(1)</text>
<text class="ts" x="36" y="110">✗ 临界突刺：0.9s 与 1.1s 各来 N 个，</text>
<text class="ts" x="36" y="128">　 0.2s 内通过 2N，超出限制</text>
<rect class="b2" x="410" y="20" width="370" height="140" rx="12"/>
<text class="th" x="426" y="44">滑动窗口</text>
<text class="ts" x="426" y="68">窗口切成多格（如 10 格 × 100ms），随时间滑动汇总</text>
<text class="ts" x="426" y="90">✓ 平滑，消除临界问题</text>
<text class="ts" x="426" y="110">✗ 格子越多越准，内存/计算越大</text>
<text class="ts" x="426" y="128">Sentinel、Resilience4j 的统计基础；Redis ZSET 实现</text>
<rect class="b3" x="20" y="180" width="370" height="150" rx="12"/>
<text class="th" x="36" y="204">漏桶 Leaky Bucket</text>
<text class="ts" x="36" y="228">请求进桶，以恒定速率漏出处理；桶满则丢弃</text>
<text class="ts" x="36" y="250">✓ 输出速率恒定，保护下游（整形）</text>
<text class="ts" x="36" y="270">✗ 不允许突发，即使系统空闲也不能超过速率</text>
<text class="ts" x="36" y="290">Nginx limit_req（可配 burst + nodelay）</text>
<rect class="b5" x="410" y="180" width="370" height="150" rx="12"/>
<text class="th" x="426" y="204">令牌桶 Token Bucket</text>
<text class="ts" x="426" y="228">按速率 r 往桶里放令牌，桶容量 b；请求取令牌</text>
<text class="ts" x="426" y="250">✓ 平均速率受限，同时允许 b 的突发，最常用</text>
<text class="ts" x="426" y="270">✗ 突发时下游短时压力更大，需结合其他保护</text>
<text class="ts" x="426" y="290">Guava RateLimiter、Spring Cloud Gateway、Bucket4j</text>
</svg>
<figcaption>图 3：四种限流算法的特点</figcaption>
</figure>

### 2. 令牌桶的“惰性填充”实现

不需要定时线程往桶里塞令牌，**每次请求时按流逝的时间折算令牌**：

```java
class TokenBucket {
    private final double ratePerSec;      // 令牌生成速率
    private final double capacity;        // 桶容量（允许的最大突发）
    private double tokens;
    private long lastNanos;

    TokenBucket(double ratePerSec, double capacity) {
        this.ratePerSec = ratePerSec; this.capacity = capacity;
        this.tokens = capacity; this.lastNanos = System.nanoTime();
    }
    synchronized boolean tryAcquire(int permits) {
        long now = System.nanoTime();
        tokens = Math.min(capacity, tokens + (now - lastNanos) / 1e9 * ratePerSec);   // 按时间补充
        lastNanos = now;
        if (tokens >= permits) { tokens -= permits; return true; }
        return false;
    }
}
```

### 3. 分布式限流：Redis + Lua

单机限流只能限制单实例；全局限流把状态放 Redis，用 **Lua 脚本保证原子**：

```lua
-- 滑动窗口（ZSET）：KEYS[1]=限流 key；ARGV: 当前毫秒, 窗口毫秒, 阈值, 唯一成员
local now, win, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)           -- 清理窗口外的记录
if redis.call('ZCARD', KEYS[1]) < limit then
    redis.call('ZADD', KEYS[1], now, ARGV[4])
    redis.call('PEXPIRE', KEYS[1], win)
    return 1                                                      -- 放行
end
return 0                                                          -- 拒绝
```

选型：**网关层按 IP/用户/接口限流**（Nginx、Gateway）、**服务内按资源并发数限流**（Sentinel、Semaphore 舱壁）、**热点参数限流**、**自适应限流**（根据 RT/负载动态调整）。限流之后的降级、熔断见 [限流、熔断与降级](#/distributed/governance)；Redis 数据结构见 [Redis 数据结构](#/redis/types)。

## 四、时间轮（Timing Wheel）

**问题**：海量定时任务（连接超时、延迟消息、心跳、重试）。用堆（`DelayQueue`）插入/删除 O(log n)，任务量大时开销明显。

**时间轮**：一个环形数组，每个槽对应一个 tick（如 1ms/100ms），指针每个 tick 前进一格，**执行当前槽里到期的任务**；添加任务只需算出 `(到期时间 / tick) % 槽数` 放入对应槽，**O(1)**。

- 任务延迟超过一圈时：记录“剩余圈数”（Netty 的 `HashedWheelTimer`），或使用**层级时间轮**（秒轮 → 分轮 → 时轮，Kafka 的 `TimingWheel`、Linux 内核定时器）；
- 适用：**精度要求不高（毫秒~秒）、数量巨大**的定时任务；Netty 心跳超时检测、Kafka 延迟操作（延迟生产/拉取）、Dubbo 超时与重试、RocketMQ 5.x 定时消息；
- 局限：精度受 tick 限制；任务回调不能阻塞，否则影响后续（需要放入业务线程池）。

## 五、海量数据问题

**通用套路**：**分治**——按 `hash(key) % N` 把大文件拆成 N 个小文件（同一 key 一定落同一个小文件），分别在内存中统计，再合并。

### 1. Top K / 高频词

| 场景 | 做法 |
| --- | --- |
| 精确 Top K 词频（数据可分片） | 哈希分片 → 每片用 HashMap 计数 → 每片维护大小 K 的最小堆 → 合并各片堆 |
| 流式、内存很小、可接受近似 | **Count-Min Sketch**（频次近似，只会高估）+ 小顶堆；或 **Space-Saving / Misra-Gries** |
| 第 K 大（单机） | 快速选择平均 O(n)，或大小为 K 的堆 O(n log K) |
| 中位数/分位数 | 对顶堆（流式）、T-Digest/分桶计数（海量近似） |

**Count-Min Sketch**：d 行 × w 列的计数器矩阵，每行一个哈希函数。更新时每行对应位置 +1，查询取 d 个位置的**最小值**（哈希冲突只会让值偏大，取最小值最接近真实）。误差与 `1/w`、概率与 `e^-d` 有关。

### 2. 去重与基数统计

| 目标 | 方法 | 空间 | 精度 |
| --- | --- | --- | --- |
| 判断是否出现过 | HashSet | O(n) 大 | 精确 |
| 同上，海量 | **布隆过滤器** | 约 1 字节/元素 | 有假阳性 |
| 整数集合（范围有限，如 40 亿 QQ 号） | **位图 Bitmap** | 40 亿 bit ≈ **500MB**；稀疏用 **Roaring Bitmap** 压缩 | 精确 |
| **统计不重复元素个数（UV）** | **HyperLogLog** | **固定约 12KB**（Redis `PFADD/PFCOUNT`），可统计亿级 | 标准误差约 0.81% |
| 精确去重 UV | Bitmap（用户 ID 连续）/ Flink 状态 + 去重 | 视规模 | 精确 |

**HyperLogLog 原理直觉**：对元素哈希，观察哈希值**前导零的最大个数**（连续出现 k 个零的概率是 2⁻ᵏ，所以观测到最大 k 大约意味着见过 2ᵏ 个不同元素）；用分桶 + 调和平均降低方差。**可合并**（并集），适合分布式统计。

```java
// Redis：UV 统计（每天一个 key，亿级也只占 12KB），见 Redis 场景实战
// PFADD uv:20261012 user1 user2 ...    PFCOUNT uv:20261012    PFMERGE uv:week uv:20261012 uv:20261013
// Bitmap：连续用户的签到/活跃：SETBIT sign:2026-10 userId 1 / BITCOUNT / BITOP AND 求连续活跃
```

### 3. 经典海量题速解

| 问题 | 思路 |
| --- | --- |
| 40 亿个整数，找出现一次的/判断某数是否存在，内存 1~2GB | **位图**（2 bit 表示 0/1/多次）；或按数值范围分段多轮扫描 |
| 两个各 50 亿 URL 的大文件，找共同 URL，内存 4GB | **哈希分片**成 1000 个小文件，相同 URL 必落同号文件，逐对在内存里求交集（或布隆过滤器近似） |
| 100 亿搜索词，找最热 100 个 | 哈希分片 → 各片 HashMap 计数 + 堆取 Top 100 → 合并 |
| 海量日志中统计每个 IP 访问次数 | 同上；或 Flink/Spark 分布式聚合（见 [Flink](#/bigdata/flink-core)） |
| 实时榜单 | Redis ZSET（`ZINCRBY` + `ZREVRANGE`）；超大规模分片 + 定时合并 |

## 六、字符串与匹配

| 问题 | 算法 | 说明 |
| --- | --- | --- |
| 单模式匹配 | **KMP**（O(n+m)，利用 next 数组避免回溯）、BM（Boyer-Moore，实际更快） | `String.indexOf` 朴素/优化实现；grep、编辑器查找 |
| **多模式匹配（敏感词过滤）** | **Trie**（前缀树）→ **AC 自动机**（Trie + 失败指针，一次扫描匹配全部词） | 内容审核、关键词过滤，词库万级仍线性于文本长度 |
| 前缀搜索/自动补全 | Trie / 有序集合 / ES completion suggester | 搜索框联想 |
| 相似/去重 | **SimHash / MinHash + LSH** | 文本去重、近似重复检测 |
| 模糊/编辑距离 | DP（见 [解题套路](#/cs/algo-patterns)）、BK 树 | 纠错 |

```java
// 简易 Trie 敏感词（只示意：生产用 AC 自动机，并处理标点/大小写/变形字符）
class Trie {
    private final Trie[] next = new Trie[26]; boolean end;
    void insert(String w) { Trie t = this; for (char c : w.toCharArray()) { int i = c - 'a'; if (t.next[i] == null) t.next[i] = new Trie(); t = t.next[i]; } t.end = true; }
    boolean startsWith(String p) { Trie t = this; for (char c : p.toCharArray()) { t = t.next[c - 'a']; if (t == null) return false; } return true; }
}
```

## 七、随机与分配算法

### 1. 红包：二倍均值法

要把 M 元（以分计）随机分给 N 人，每人至少 1 分，**保证公平的期望且不会剩余/不足**：每次领取时，在 `[1, 剩余金额/剩余人数 × 2 − 1]` 内随机，**期望值恒等于平均值**；最后一个人拿剩余。

```java
int[] splitRedPacket(int totalFen, int n) {
    int[] res = new int[n]; int remain = totalFen;
    ThreadLocalRandom r = ThreadLocalRandom.current();
    for (int i = 0; i < n - 1; i++) {
        int max = remain / (n - i) * 2 - 1;                  // 二倍均值上限
        res[i] = 1 + r.nextInt(Math.max(1, max));            // 至少 1 分
        remain -= res[i];
    }
    res[n - 1] = remain;
    return res;
}
// 分布式场景：预先拆好存入 Redis List，领取用 LPOP / Lua 原子操作，避免超发（与秒杀同理，见 秒杀系统设计）
```

### 2. 抽奖与加权随机

按概率抽奖：**前缀和 + 二分**（权重累加，随机数落在哪个区间）；权重频繁变化/大量奖品用 **Alias 方法**（O(1) 采样）。**库存扣减必须原子**（Redis Lua / DB 条件更新），防止超发。

### 3. 洗牌与蓄水池抽样

- **Fisher-Yates 洗牌**：从后往前，与前面随机位置交换，O(n)，每种排列概率相等；
- **蓄水池抽样**：数据流长度未知，**等概率**随机取 K 个：前 K 个入池，第 i 个（i>K）以 K/i 概率替换池中随机一个。

## 八、分布式 ID 与雪花算法

雪花（Snowflake）64 位：`1 位符号 | 41 位毫秒时间戳 | 10 位机器 ID | 12 位序列号`；每毫秒每机最多 4096 个，**趋势递增、本地生成无依赖**。主要问题：**时钟回拨**（拒绝/等待/借用备用位）、机器 ID 分配与回收、时间戳溢出（约 69 年）。展开见 [分布式 ID 与幂等](#/distributed/id)。

## 九、选型速查

| 需求 | 算法/结构 | 注意 |
| --- | --- | --- |
| 防缓存穿透 | 布隆过滤器 | 不可删除、需预估容量、定期重建 |
| 缓存/分片路由，节点动态增减 | 一致性哈希（虚拟节点）/ 哈希槽 | 节点少时要虚拟节点 |
| 接口限流 | 令牌桶（允许突发）/ 滑动窗口 | 分布式用 Redis+Lua；多层限流 |
| 海量定时任务 | 时间轮 | 精度有限、回调别阻塞 |
| UV 统计 | HyperLogLog（近似）/ Bitmap（精确） | HLL 误差约 0.8% |
| Top K 流式 | 堆 + Count-Min Sketch | CMS 只会高估 |
| 敏感词 | AC 自动机 | 预处理文本、热更新词库 |
| 排行榜 | Redis ZSET（跳表） | 大榜分片 |
| 唯一 ID | 雪花/号段/UUIDv7 | 时钟回拨、可排序性 |

## 面试追问

> [!QUESTION] 布隆过滤器的原理？为什么有假阳性没有假阴性？如何防缓存穿透？
> 位数组加多个哈希函数，添加时把对应位置 1，查询时全为 1 才判定可能存在。不同元素的位会重叠所以可能误判存在，但已添加元素的位一定为 1，所以不会漏判。把全部合法 ID 放入过滤器，请求先过滤，一定不存在的直接返回，从而避免穿透到数据库；缺点是不能删除，需预估容量并定期重建。

> [!QUESTION] 为什么用一致性哈希？虚拟节点的作用？
> 取模路由在节点数变化时几乎所有 key 重新映射造成缓存雪崩，一致性哈希把节点和 key 映射到环上，增删节点只影响相邻区间，迁移约 K/N 的数据。节点少时分布不均且宕机压力集中到下一个节点，虚拟节点让每个物理节点分散在环上多处，负载更均匀并分摊故障压力。

> [!QUESTION] 令牌桶和漏桶的区别？固定窗口有什么问题？
> 漏桶以恒定速率处理，输出平滑但不允许突发；令牌桶按固定速率生成令牌，桶内有令牌即可放行，允许不超过桶容量的突发，更灵活。固定窗口在窗口边界会出现前后窗口各放满，短时间内通过两倍流量，滑动窗口通过细分时间格平滑解决。

> [!QUESTION] 如何实现分布式限流？
> 把计数或令牌状态放在 Redis，用 Lua 脚本保证原子性，滑动窗口可用 ZSET，令牌桶存令牌数与上次时间；高并发下可采用本地令牌批量预取减少 Redis 压力。同时在网关、服务入口、资源并发数多层限流，并配合降级熔断。

> [!QUESTION] 统计网站每天的 UV，有哪些方案？
> 精确可用 Set 或 Bitmap，用户量大且 ID 连续用 Bitmap 或 Roaring Bitmap；允许约百分之一的误差时用 HyperLogLog，每个 key 固定约 12KB 即可统计亿级基数，且可合并多天数据；也可用 Flink 状态去重做实时统计。

> [!QUESTION] 有一个 10GB 的日志文件，内存只有 1GB，求访问次数最多的 100 个 IP？
> 按 IP 哈希取模拆成多个小文件，保证同一 IP 在同一文件，逐个文件用 HashMap 计数并用大小为 100 的最小堆保留局部 Top，再把各文件的候选合并取全局 Top 100；也可用分布式计算引擎或近似算法。

> [!QUESTION] 时间轮解决什么问题？和 DelayQueue 相比有什么优劣？
> 解决海量定时任务的高效调度，任务放入对应槽位 O(1)，指针转动时执行到期任务，层级时间轮可覆盖长延迟。DelayQueue 基于堆插入删除 O(log n)，精度更高但任务量大时开销大；时间轮精度受 tick 限制，适合超时检测、延迟消息、心跳等大量但精度要求不高的场景，如 Netty、Kafka。

> [!QUESTION] 二倍均值法发红包为什么公平？
> 每次在一到剩余平均值两倍减一的范围内随机，随机变量的期望恰好等于当前剩余平均值，所以每个人的期望金额相同，并保证每人至少一分且总额不超发；分布式场景要把红包预拆分并用原子操作领取防止超发。
