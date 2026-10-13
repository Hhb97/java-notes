---
level: 进阶
tags: [Redis, Cache Aside, 缓存一致性, 穿透, 击穿, 雪崩, 热 Key, 大 Key, 多级缓存, Caffeine]
summary: Cache Aside 的正确读写顺序与各种顺序的并发反例、延迟双删与 binlog 异步删除、穿透/击穿/雪崩、热 Key 与大 Key 治理、多级缓存与预热降级
---

# 缓存设计与一致性

> [!ABSTRACT] 核心要点
> - 默认用 **Cache Aside**：读时未命中查库回填，写时**先更新数据库，再删除缓存**。删除而不是更新缓存，是为了避免并发写乱序覆盖和无效计算。
> - 「先更新库再删缓存」也有极端并发反例，但需要「读库 + 回填」恰好包住「写库 + 删缓存」，概率很低；再配合 TTL 兜底、删除失败重试（binlog + MQ）即可达到工程上可接受的最终一致。
> - 缓存与数据库之间做不到低成本的强一致；要强一致只能加分布式锁串行化读写，或干脆不用缓存。
> - 三大问题：**穿透**（数据不存在）→ 布隆过滤器 / 缓存空值；**击穿**（热点 key 过期）→ 互斥锁 / 逻辑过期；**雪崩**（大量 key 同时失效或 Redis 宕机）→ 随机 TTL / 多级缓存 / 熔断降级。
> - 热 Key 用本地缓存（Caffeine）或 key 打散扛；大 Key 要拆分，并用 `UNLINK` / 分批删除。

## Cache Aside 读写流程

<figure class="fig">
<svg viewBox="0 0 720 270" class="dg" role="img" aria-label="Cache Aside：读路径先查缓存，未命中查数据库并回填；写路径先更新数据库再删除缓存">
<rect class="bg" x="20" y="30" width="330" height="210" rx="10"/>
<text class="ts" x="36" y="48">读路径</text>
<rect class="b" x="40" y="60" width="90" height="40" rx="8"/>
<text class="tb" x="85" y="80" text-anchor="middle" dominant-baseline="middle">App</text>
<rect class="b3" x="230" y="60" width="100" height="40" rx="8"/>
<text class="tb" x="280" y="80" text-anchor="middle" dominant-baseline="middle">Redis</text>
<rect class="b1" x="230" y="170" width="100" height="40" rx="8"/>
<text class="tb" x="280" y="190" text-anchor="middle" dominant-baseline="middle">DB</text>
<line class="l" x1="130" y1="72" x2="228" y2="72" marker-end="url(#arr)"/>
<text class="ts" x="180" y="66" text-anchor="middle">① GET</text>
<line class="l" x1="230" y1="90" x2="132" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="180" y="106" text-anchor="middle">② 命中返回</text>
<line class="l" x1="85" y1="100" x2="85" y2="190"/>
<line class="l" x1="85" y1="190" x2="228" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="95" y="160">③ 未命中查库</text>
<line class="la" x1="280" y1="170" x2="280" y2="102" marker-end="url(#arr-a)"/>
<text class="ta" x="272" y="140" text-anchor="end">④ 回填+TTL</text>
<rect class="bg" x="370" y="30" width="330" height="210" rx="10"/>
<text class="ts" x="386" y="48">写路径</text>
<rect class="b" x="390" y="60" width="90" height="40" rx="8"/>
<text class="tb" x="435" y="80" text-anchor="middle" dominant-baseline="middle">App</text>
<rect class="b1" x="580" y="60" width="100" height="40" rx="8"/>
<text class="tb" x="630" y="80" text-anchor="middle" dominant-baseline="middle">DB</text>
<rect class="b3" x="580" y="170" width="100" height="40" rx="8"/>
<text class="tb" x="630" y="190" text-anchor="middle" dominant-baseline="middle">Redis</text>
<line class="l" x1="480" y1="80" x2="578" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="529" y="72" text-anchor="middle">① 更新数据库</text>
<line class="la" x1="435" y1="100" x2="435" y2="190"/>
<line class="la" x1="435" y1="190" x2="578" y2="190" marker-end="url(#arr-a)"/>
<text class="ta" x="445" y="160">② 删除缓存</text>
<text class="ts" x="20" y="262">删除而不是更新缓存：避免并发写乱序覆盖，也避免为不会被读到的数据做无用计算（懒加载）</text>
</svg>
<figcaption>图 1：Cache Aside 的读路径与写路径</figcaption>
</figure>

```java
public Product getProduct(long id) {
    String key = "product:" + id;
    String json = redis.opsForValue().get(key);
    if (json != null) {
        return "".equals(json) ? null : JSON.parseObject(json, Product.class); // "" 为空值占位
    }
    Product p = productMapper.selectById(id);
    // 基础 TTL + 随机抖动，防止同一批 key 同时过期
    long ttl = 1800 + ThreadLocalRandom.current().nextInt(300);
    redis.opsForValue().set(key, p == null ? "" : JSON.toJSONString(p),
            p == null ? 60 : ttl, TimeUnit.SECONDS);
    return p;
}

@Transactional
public void updateProduct(Product p) {
    productMapper.updateById(p);
    // 事务提交后再删缓存，否则删完缓存、事务还没提交，别的线程会把旧值读回缓存
    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
        @Override public void afterCommit() { redis.delete("product:" + p.getId()); }
    });
}
```

> [!WARNING]
> 在 `@Transactional` 方法里直接删除缓存是最常见的错误：删除发生在提交之前，并发读线程会读到未提交前的旧值并回填。必须放到 `afterCommit`，或通过 binlog 异步删除。

### 其他缓存模式

| 模式 | 做法 | 特点 |
| --- | --- | --- |
| Cache Aside | 应用自己管理缓存和数据库 | 最常用，灵活 |
| Read/Write Through | 应用只和缓存层交互，由缓存组件同步读写数据库 | 需要缓存组件支持（如 Caffeine `LoadingCache` 只有 Read Through） |
| Write Behind | 只写缓存，异步批量刷库 | 写性能高，宕机丢数据，适合计数、点赞等 |

## 为什么是「先更新数据库，再删除缓存」

四种组合逐个分析（A、B 表示两个并发线程）：

| 顺序 | 并发问题 | 结论 |
| --- | --- | --- |
| 先更新缓存，再更新数据库 | 数据库更新失败则缓存是脏数据；两个写线程交错会让缓存与数据库分别是不同线程的值 | 不可用 |
| 先更新数据库，再更新缓存 | A 写库 v1、B 写库 v2、B 写缓存 v2、A 写缓存 v1 → 缓存旧值。且每次写都要算缓存，浪费 | 不推荐 |
| 先删除缓存，再更新数据库 | 删除后、写库前，读线程未命中，把旧值读回缓存（见图 2）。**窗口是一次写库的耗时，很容易发生** | 不推荐 |
| 先更新数据库，再删除缓存 | 只有极端时序才出问题（见图 3） | **推荐** |

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="先删缓存再更新数据库的反例：写线程删除缓存后，读线程未命中，读到旧值回填，写线程随后才更新数据库，缓存长期为旧值">
<rect class="b4" x="30" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="90" y="38" text-anchor="middle" dominant-baseline="middle">线程 A（写）</text>
<rect class="b1" x="190" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="250" y="38" text-anchor="middle" dominant-baseline="middle">线程 B（读）</text>
<rect class="b3" x="370" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="430" y="38" text-anchor="middle" dominant-baseline="middle">Redis</text>
<rect class="b2" x="550" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="610" y="38" text-anchor="middle" dominant-baseline="middle">MySQL</text>
<line class="ld" x1="90" y1="56" x2="90" y2="250"/>
<line class="ld" x1="250" y1="56" x2="250" y2="250"/>
<line class="ld" x1="430" y1="56" x2="430" y2="250"/>
<line class="ld" x1="610" y1="56" x2="610" y2="250"/>
<text class="ts" x="14" y="90">①</text>
<line class="l" x1="90" y1="90" x2="428" y2="90" marker-end="url(#arr)"/>
<text class="tm" x="330" y="82" text-anchor="middle">DEL k</text>
<text class="ts" x="14" y="125">②</text>
<line class="l" x1="250" y1="125" x2="428" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="340" y="117" text-anchor="middle">GET 未命中</text>
<text class="ts" x="14" y="160">③</text>
<line class="l" x1="250" y1="160" x2="608" y2="160" marker-end="url(#arr)"/>
<text class="ts" x="520" y="152" text-anchor="middle">读到旧值 v1</text>
<text class="ts" x="14" y="195">④</text>
<line class="la" x1="250" y1="195" x2="428" y2="195" marker-end="url(#arr-a)"/>
<text class="ta" x="340" y="187" text-anchor="middle">SET k v1（旧值）</text>
<text class="ts" x="14" y="230">⑤</text>
<line class="l" x1="90" y1="230" x2="608" y2="230" marker-end="url(#arr)"/>
<text class="tm" x="520" y="222" text-anchor="middle">UPDATE k = v2</text>
<text class="ta" x="30" y="282">结果：DB = v2，缓存 = v1，直到 TTL 过期前所有读请求都拿到旧值</text>
</svg>
<figcaption>图 2：先删缓存再更新数据库的并发反例</figcaption>
</figure>

<figure class="fig">
<svg viewBox="0 0 720 310" class="dg" role="img" aria-label="先更新数据库再删缓存的极端反例：读线程在缓存过期后读到旧值，写线程更新数据库并删除缓存，读线程随后才回填旧值">
<rect class="b1" x="30" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="90" y="38" text-anchor="middle" dominant-baseline="middle">线程 A（读）</text>
<rect class="b4" x="190" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="250" y="38" text-anchor="middle" dominant-baseline="middle">线程 B（写）</text>
<rect class="b3" x="370" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="430" y="38" text-anchor="middle" dominant-baseline="middle">Redis</text>
<rect class="b2" x="550" y="20" width="120" height="36" rx="8"/>
<text class="tb" x="610" y="38" text-anchor="middle" dominant-baseline="middle">MySQL</text>
<line class="ld" x1="90" y1="56" x2="90" y2="250"/>
<line class="ld" x1="250" y1="56" x2="250" y2="250"/>
<line class="ld" x1="430" y1="56" x2="430" y2="250"/>
<line class="ld" x1="610" y1="56" x2="610" y2="250"/>
<text class="ts" x="14" y="90">①</text>
<line class="l" x1="90" y1="90" x2="428" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="330" y="82" text-anchor="middle">GET 未命中（恰好过期）</text>
<text class="ts" x="14" y="125">②</text>
<line class="l" x1="90" y1="125" x2="608" y2="125" marker-end="url(#arr)"/>
<text class="ts" x="520" y="117" text-anchor="middle">读到旧值 v1</text>
<text class="ts" x="14" y="160">③</text>
<line class="l" x1="250" y1="160" x2="608" y2="160" marker-end="url(#arr)"/>
<text class="tm" x="520" y="152" text-anchor="middle">UPDATE k = v2</text>
<text class="ts" x="14" y="195">④</text>
<line class="l" x1="250" y1="195" x2="428" y2="195" marker-end="url(#arr)"/>
<text class="tm" x="340" y="187" text-anchor="middle">DEL k</text>
<text class="ts" x="14" y="230">⑤</text>
<line class="la" x1="90" y1="230" x2="428" y2="230" marker-end="url(#arr-a)"/>
<text class="ta" x="330" y="222" text-anchor="middle">SET k v1（旧值）</text>
<text class="ts" x="30" y="276">条件：③④（写库 + 删缓存）必须整体落在 ②⑤（读库 + 回填）之间</text>
<text class="ts" x="30" y="296">而写库通常比读库慢得多（加锁、写 redo/binlog），所以概率极低；TTL 是最后兜底</text>
</svg>
<figcaption>图 3：先更新数据库再删缓存的极端反例</figcaption>
</figure>

需要注意的是**读写分离**会显著放大图 3 的概率：B 写主库、删缓存后，A 去从库读，因复制延迟读到旧值并回填。这种情况读请求的回源应走主库，或使用延迟双删 / binlog 删除。

### 延迟双删

```java
public void update(Product p) {
    redis.delete(key(p.getId()));     // 第一次删（可选）
    productMapper.updateById(p);
    redis.delete(key(p.getId()));     // 第二次删
    // 延迟一段时间再删一次，清理「并发读在窗口内回填的旧值」
    scheduler.schedule(() -> redis.delete(key(p.getId())), 500, TimeUnit.MILLISECONDS);
}
```

延迟时间要大于「一次读库 + 回填」的耗时（含主从延迟），通常几百毫秒到 1 秒。问题：延迟值靠经验、增加写路径复杂度，进程重启会丢失延迟任务。更可靠的做法是把删除交给消息队列。

### 订阅 binlog 异步删除

```text
MySQL ──binlog──▶ Canal / Debezium ──▶ MQ（Kafka / RocketMQ）──▶ 缓存删除服务 ──DEL──▶ Redis
                                                                  └─ 失败重试 / 死信告警
```

- 业务代码只管写库，不关心缓存，解耦彻底；
- 删除失败可以依靠 MQ 重试，保证「最终一定会删掉」；
- 天然覆盖所有写入来源（包括后台脚本、DBA 手工修复数据）；
- binlog 在事务提交后才产生，不存在「删早了」的问题；对于主从延迟，可以在消费端延迟一小段时间再删，或订阅从库的 binlog。
- 代价：多了一条链路，有秒级以内的延迟；需要维护 Canal 高可用。

### 强一致的代价

真正的强一致需要读写互斥：写时加分布式写锁（或 Redisson `RReadWriteLock`），读时加读锁，相当于把缓存访问串行化，吞吐大幅下降，而且锁本身也有可用性问题。一般结论是：

- **允许短暂不一致**的场景（商品详情、用户资料）：Cache Aside + 删除重试 + TTL；
- **不允许不一致**的场景（库存、余额）：直接读写数据库，或以 Redis 为准（库存扣减在 Redis 里做原子操作，再异步落库），见 [高频场景实战](#/redis/practice)。

## 缓存穿透、击穿、雪崩

| 问题 | 现象 | 原因 | 方案 |
| --- | --- | --- | --- |
| 穿透 | 查询不存在的数据，每次都打到数据库 | 恶意请求、业务 bug | 参数校验、布隆过滤器、缓存空值 |
| 击穿 | 一个热点 key 过期瞬间，大量并发同时回源 | 热点 + 过期 | 互斥锁重建、逻辑过期、热点不过期 |
| 雪崩 | 大量 key 同时失效或 Redis 整体不可用，数据库被压垮 | 统一 TTL、Redis 故障 | 随机 TTL、高可用、多级缓存、限流熔断降级 |

### 穿透：布隆过滤器与空值

```java
// Redisson 布隆过滤器：预计 1 亿元素、误判率 1%，约占 114MB（基于 Bitmap，存在 Redis 中）
RBloomFilter<Long> bloom = redisson.getBloomFilter("bf:product");
bloom.tryInit(100_000_000L, 0.01);
bloom.add(productId);                 // 新增商品时同步加入

if (!bloom.contains(id)) return null; // 一定不存在，直接返回
```

- 布隆过滤器：判断「不存在」是准确的，「存在」有误判；**不支持删除**（删除的数据会一直被判为存在，需定期重建或改用 Cuckoo Filter）。也可以用 RedisBloom 模块的 `BF.ADD`/`BF.EXISTS`（Redis 8 起已集成在 Redis Open Source 中）。
- 缓存空值：实现简单，但大量随机 key 会塞满缓存，空值 TTL 要短（如 30～60 秒），且新增数据时要删除对应的空值。

### 击穿：互斥锁 与 逻辑过期

**互斥锁**：只让一个线程回源，其他线程等待或返回旧值。

```java
public Product getWithMutex(long id) throws InterruptedException {
    String key = "product:" + id, lockKey = "lock:" + key;
    for (int i = 0; i < 50; i++) {
        String json = redis.opsForValue().get(key);
        if (json != null) return parse(json);
        String token = UUID.randomUUID().toString();
        Boolean ok = redis.opsForValue().setIfAbsent(lockKey, token, 10, TimeUnit.SECONDS);
        if (Boolean.TRUE.equals(ok)) {
            try {
                // 双重检查：拿到锁时可能别人刚重建完
                json = redis.opsForValue().get(key);
                if (json != null) return parse(json);
                Product p = productMapper.selectById(id);
                redis.opsForValue().set(key, toJson(p), randomTtl(), TimeUnit.SECONDS);
                return p;
            } finally {
                releaseLock(lockKey, token);   // Lua 比较后删除，见「分布式锁」
            }
        }
        Thread.sleep(50);
    }
    throw new IllegalStateException("cache rebuild timeout");
}
```

**逻辑过期**：key 不设 TTL，value 里带一个 `expireAt` 字段。读到已逻辑过期的数据时，抢锁成功的线程**异步**重建，所有线程（包括自己）先返回旧值。

| 方案 | 一致性 | 可用性 | 适用 |
| --- | --- | --- | --- |
| 互斥锁 | 好，读到的是新数据 | 等待线程 RT 上升，锁服务异常时有风险 | 一致性要求较高 |
| 逻辑过期 | 短时间返回旧数据 | 不阻塞 | 高并发、可容忍旧数据（首页、活动页） |
| 热点永不过期 + 主动刷新 | 依赖刷新机制 | 好 | 已知热点、配置类数据 |

单机层面也可以用 Caffeine 的 `LoadingCache`（同一 key 并发加载只执行一次）或 Guava 的 `refreshAfterWrite` 达到同样效果。

### 雪崩

- **TTL 加随机值**：`baseTtl + random(0, baseTtl × 10%~20%)`；
- **Redis 高可用**：哨兵 / Cluster，避免整体不可用；
- **多级缓存**：Redis 不可用时本地缓存仍能挡住大部分热点；
- **限流熔断降级**：数据库前加限流（Sentinel / Resilience4j），Redis 访问异常时熔断，返回默认值或兜底数据，见 [限流、熔断与降级](#/distributed/governance)；
- **预热**：大促前提前加载热点，避免冷启动瞬间全部回源。

## 热 Key

### 发现

| 方式 | 说明 |
| --- | --- |
| `redis-cli --hotkeys` | 需要 LFU 淘汰策略，基于 SCAN + `OBJECT FREQ`，有扫描开销 |
| `MONITOR` | 短时抓取，影响性能，不适合常态 |
| 客户端埋点 | 在 RedisTemplate / Lettuce 外层统计 key 访问次数，滑动窗口上报，最准确 |
| 代理层统计 | 有代理（Codis、Twemproxy、云厂商 Proxy）时在代理统计 |
| 业务预判 | 大促商品、热搜、明星事件提前识别 |

京东开源的 hotkey 框架思路：客户端上报访问 → 计算集群实时探测热点 → 推送给所有应用实例 → 实例把该 key 放入本地缓存。

### 治理

1. **本地缓存**：热 key 放 JVM 本地，扛住绝大部分读：

```java
Cache<String, Product> local = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofSeconds(5))   // 短 TTL，容忍几秒不一致
        .recordStats()
        .build();

Product p = local.get(key, k -> loadFromRedisOrDb(k));
```

2. **key 打散**：写入 `hot:{k}:0`～`hot:{k}:N-1` 多个副本，读时随机选一个，把压力分摊到多个节点（注意副本不能都落在同一个槽，所以不要给它们加相同的 hash tag）；
3. **读写分离**：热点读打到从库（接受复制延迟）；
4. **Redis 6 客户端缓存（Client-side caching）**：服务端 `CLIENT TRACKING` 在 key 变更时推送失效通知，Lettuce 6 提供 `ClientSideCaching` 支持，但生态成熟度一般，使用前要充分验证。

## 大 Key

| 判定（经验值） | 危害 |
| --- | --- |
| String > 10KB（严重 > 1MB）；集合元素 > 5000 或总大小 > 10MB | 读写阻塞主线程、网卡打满、删除阻塞、Cluster 数据和流量倾斜、迁移时 `MIGRATE` 超时、主从同步与 RDB 加载变慢 |

治理：

- **拆分**：大 Hash 按 field 哈希分到多个 key（`user:fav:{uid}:0..15`）；大 List 按时间或序号分段；大 String 按字段拆或压缩（Snappy/LZ4、Protobuf 代替 JSON）；
- **只取需要的部分**：`HMGET` 代替 `HGETALL`，`ZRANGE` 分页，`HSCAN` 增量遍历；
- **删除**：`UNLINK`，或 `HSCAN` + `HDEL` 每批几百个慢慢删；同时开启 `lazyfree-lazy-expire` 等参数，避免过期时同步释放；
- **发现**：`redis-cli --bigkeys`、`--memkeys`、离线分析 RDB。

## 多级缓存架构

<figure class="fig">
<svg viewBox="0 0 760 260" class="dg" role="img" aria-label="多级缓存：CDN、Nginx 共享字典、应用本地 Caffeine、Redis、MySQL，数据变更通过 binlog、Canal、MQ 删除 Redis 并广播失效本地缓存">
<rect class="b" x="20" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="60" text-anchor="middle" dominant-baseline="middle">CDN / 浏览器</text>
<text class="ts" x="80" y="82" text-anchor="middle" dominant-baseline="middle">静态资源、页面</text>
<line class="l" x1="140" y1="70" x2="170" y2="70" marker-end="url(#arr)"/>
<rect class="b" x="172" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="232" y="60" text-anchor="middle" dominant-baseline="middle">Nginx</text>
<text class="ts" x="232" y="82" text-anchor="middle" dominant-baseline="middle">共享字典缓存</text>
<line class="l" x1="292" y1="70" x2="322" y2="70" marker-end="url(#arr)"/>
<rect class="b1" x="324" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="384" y="60" text-anchor="middle" dominant-baseline="middle">应用本地缓存</text>
<text class="ts" x="384" y="82" text-anchor="middle" dominant-baseline="middle">Caffeine（L1）</text>
<line class="l" x1="444" y1="70" x2="474" y2="70" marker-end="url(#arr)"/>
<rect class="b3" x="476" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="536" y="60" text-anchor="middle" dominant-baseline="middle">Redis（L2）</text>
<text class="ts" x="536" y="82" text-anchor="middle" dominant-baseline="middle">分布式共享缓存</text>
<line class="l" x1="596" y1="70" x2="626" y2="70" marker-end="url(#arr)"/>
<rect class="b2" x="628" y="40" width="120" height="60" rx="8"/>
<text class="tb" x="688" y="60" text-anchor="middle" dominant-baseline="middle">MySQL</text>
<text class="ts" x="688" y="82" text-anchor="middle" dominant-baseline="middle">最终数据源</text>
<line class="l" x1="688" y1="100" x2="688" y2="158" marker-end="url(#arr)"/>
<text class="ts" x="696" y="134">binlog</text>
<rect class="b5" x="628" y="160" width="120" height="44" rx="8"/>
<text class="tb" x="688" y="182" text-anchor="middle" dominant-baseline="middle">Canal</text>
<line class="l" x1="628" y1="182" x2="598" y2="182" marker-end="url(#arr)"/>
<rect class="b5" x="476" y="160" width="120" height="44" rx="8"/>
<text class="tb" x="536" y="182" text-anchor="middle" dominant-baseline="middle">MQ</text>
<line class="la" x1="536" y1="160" x2="536" y2="102" marker-end="url(#arr-a)"/>
<text class="ta" x="544" y="134">DEL</text>
<line class="la" x1="476" y1="182" x2="384" y2="182"/>
<line class="la" x1="384" y1="182" x2="384" y2="102" marker-end="url(#arr-a)"/>
<text class="ta" x="392" y="134">广播失效</text>
<text class="ts" x="20" y="236">越靠前命中率越低但成本越低；本地缓存容量小、TTL 短，用于扛热点；失效通知可走 MQ 广播或 Redis Pub/Sub</text>
</svg>
<figcaption>图 4：多级缓存与失效链路</figcaption>
</figure>

多级缓存的关键问题：

- **一致性窗口变长**：本地缓存不能实时感知变更，靠「短 TTL + 广播失效」控制在秒级；
- **内存与 GC**：本地缓存放在堆上，容量要限制（`maximumSize` / `maximumWeight`），大对象会增加 GC 压力；
- **Spring Cache 组合**：可以自定义 `CacheManager` 先查 Caffeine 再查 Redis，或使用 JetCache 这类二级缓存框架（自带本地 + 远程、失效广播、自动刷新）。

## 缓存预热与降级

- **预热**：上线或大促前，通过离线任务把热点数据（根据历史访问日志、运营圈选的商品）提前写入 Redis；应用启动时加载本地缓存。预热要限速，避免把数据库打满。
- **降级**：Redis 超时或熔断时的兜底——返回本地缓存旧数据、返回默认值、关闭非核心功能（推荐、评论）；核心链路要有「Redis 完全不可用」的预案，并定期演练。
- **超时设置**：Redis 命令超时一般设几十到几百毫秒，宁可快速失败走降级，也不要让线程长时间挂在 Redis 上拖垮整个服务。

## 生产实践与踩坑

- **缓存与数据库双写的事务问题**：删缓存放在事务提交后（`afterCommit` / `@TransactionalEventListener(phase = AFTER_COMMIT)`）。
- **序列化不兼容**：`RedisTemplate` 默认 JDK 序列化，key 里带二进制前缀、无法跨语言、类结构变更就反序列化失败。统一用 `StringRedisSerializer` + JSON（注意 Jackson 的 `@class` 类型信息带来的安全与兼容问题）。
- **空值缓存与新增冲突**：新增数据后要删除对应 key，否则空值会在 TTL 内一直生效。
- **批量失效**：一次活动结束清理缓存时用 `KEYS pattern` + `DEL`，把 Redis 卡死。应 `SCAN` + 分批 `UNLINK`，或在设计时把同批 key 放进一个 Set 便于管理。
- **缓存命中率监控**：`INFO stats` 的 `keyspace_hits`/`keyspace_misses`，以及业务层面按 key 前缀统计。命中率突降往往是雪崩的前兆。

## 相关阅读

- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：布隆过滤器防穿透、限流算法
- [DNS 与 CDN：解析流程、缓存与线上坑](#/cs/net-dns)：CDN 与多级缓存
- [MongoDB 数据模型、索引与聚合](#/db/mongo-model)：文档数据库作为二级存储的取舍

## 面试追问

> [!QUESTION] 为什么是删除缓存，而不是更新缓存？
> 更新缓存在并发写时会因执行顺序不同把旧值写进缓存；而且很多写入后的数据未必会被读取，每次写都更新缓存（尤其需要复杂计算时）是浪费。删除后由下一次读懒加载，逻辑简单、出错面小。

> [!QUESTION] 先更新数据库再删缓存，删缓存失败怎么办？
> 重试：同步重试几次后投递到 MQ 异步重试；更彻底的做法是订阅 binlog（Canal）统一删除，由 MQ 保证至少一次投递；同时给所有缓存设置 TTL 作为最后兜底。

> [!QUESTION] 延迟双删的延迟时间怎么定？它能保证强一致吗？
> 大于一次「读库 + 写缓存」的耗时，并考虑主从延迟，一般几百毫秒到 1 秒。它只能缩小不一致的概率，不能保证强一致：延迟任务可能丢失，极端情况下读请求比延迟还慢。

> [!QUESTION] 布隆过滤器有什么缺点？数据删除后怎么办？
> 有误判（只会把不存在判为存在，不会反过来）、不能删除、容量需预估（超出后误判率上升）。删除的数据会被继续放行到缓存/数据库层，一般配合缓存空值兜底，并定期重建布隆过滤器，或者使用支持删除的 Cuckoo Filter / 计数布隆过滤器。

> [!QUESTION] 热点 key 突然过期，瞬间几万 QPS 打到数据库，你会怎么设计？
> 事前：识别热点、热点不设物理过期（逻辑过期 + 异步刷新）、本地缓存兜底；事中：互斥锁保证只有一个线程回源，其余返回旧值或短暂等待；数据库前加限流，超出直接降级。

> [!QUESTION] 本地缓存 + Redis 两级缓存，如何保证各实例本地缓存一致？
> 做不到实时一致，只能缩短窗口：本地缓存设短 TTL（秒级），数据变更时通过 MQ 广播或 Redis Pub/Sub 通知所有实例删除本地 key；关键数据不进本地缓存。
