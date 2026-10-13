---
level: 深入
tags: [Redis, 大 key, 热 key, bigkey, hotkey, UNLINK, lazyfree, 数据分片, 本地缓存, 内存分析, 慢查询, 数据倾斜]
summary: Redis 大 key 与热 key 的完整治理：危害与判定标准、发现方法（扫描、采样、RDB 离线分析、监控与代理侧统计）、安全删除与迁移（UNLINK、渐进删除）、拆分方案（Hash 分桶、List/ZSet 分段、按时间分片、冷热分离、压缩与精简）、热 key 的发现与应对（本地缓存、副本读、key 分散、限流）、与集群倾斜的关系、预防机制与治理流程。
---

# Redis 大 key 与热 key 治理

> [!ABSTRACT] 核心要点
> - **大 key**：单个 key 的 value 过大（String 超过约 10KB~1MB 量级就要警惕）或集合元素过多（Hash/List/Set/ZSet 达到数万到数十万元素）。**热 key**：单个 key 的访问量远高于其他 key，把某个分片的 CPU/带宽打满。两者**常常同时出现，且都是“平均指标正常、个别节点崩溃”**的典型。
> - 危害来自 **Redis 的单线程命令执行**：大 key 的读/写/删除/过期/序列化会**长时间占住主线程**，使所有请求排队，触发超时与主从切换；还会造成**网络带宽打满、内存倾斜、迁移与复制困难、持久化 fork 与复制缓冲压力**。
> - **发现靠组合拳**：线上用 `SCAN` + `MEMORY USAGE`/类型专用命令**限速采样**、`redis-cli --bigkeys/--memkeys`，离线分析 **RDB 文件**（对线上零影响），配合**慢日志、延迟监控、客户端或代理侧的访问统计**；**不要在线上用 `KEYS *` 或不限速全量扫描**。
> - **治理原则**：**预防优于治疗**——设计阶段就限制集合大小与 value 大小；存量大 key 用**拆分（分桶/分段/分片）、精简（字段裁剪、压缩）、冷热分离、改用更合适的存储**；**删除一律异步（`UNLINK`）或渐进删除**，不要 `DEL` 一个大 key。
> - **热 key 的核心手段**：**多级缓存（本地缓存兜住热点）→ key 打散（加随机后缀多副本读）→ 副本读写分离 → 限流与降级**，并在监控里**按 key 维度**识别热点而不是只看节点。
> - 要建立**长效机制**：容量与大小的**写入前校验**（SDK/代理拦截）、定期扫描报告、负责人通知与整改闭环，而不是出了事故才处理。

## 判定标准与危害

### 什么算大 key

没有官方统一阈值，常见的**经验判定线**（需结合业务与实例规格调整）：

| 类型 | 预警线（经验） | 说明 |
| --- | --- | --- |
| **String** | value > 10KB 预警；> 100KB~1MB 视为大 key | 缓存 JSON/序列化对象最容易膨胀 |
| **Hash / Set / ZSet / List** | 元素数 > 5000 预警；> 1 万~10 万 视为大 key | 同时看**总字节数**（元素本身可能很大） |
| **Stream** | 长度无限增长不裁剪 | 要 `MAXLEN`/`MINID` 控制 |
| **任何类型** | 单 key 占用内存 > 数 MB~10MB | 以 `MEMORY USAGE` 为准 |

> [!NOTE] 阈值是风险提示，不是对错线
> 评估要看**访问方式**：一个 10 万元素的 Hash 如果只做 `HGET` 单字段读写，风险远小于对它做 `HGETALL`；一个很少访问、从不删除的 50MB 数据未必出事，但迁移/过期/主从同步时就可能“爆雷”。

### 危害链

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="大 key 的危害：读取或写入大 key 占用主线程导致其他请求排队；大 key 的网络传输占满带宽；删除或过期大 key 同步释放内存阻塞；集群迁移与主从全量同步时阻塞、复制缓冲增大；内存倾斜使某个分片先满；持久化 fork 与 AOF 重写时 COW 放大；客户端和代理缓冲区溢出被断开">
<rect class="b4" x="20" y="14" width="720" height="60" rx="10"/>
<text class="tb" x="380" y="34" text-anchor="middle" dominant-baseline="middle">根因：Redis 命令在单线程中串行执行，大 key 的一次操作耗时 = 毫秒到秒级</text>
<text class="ts" x="380" y="58" text-anchor="middle">其间所有请求排队，客户端超时重试，负载进一步放大</text>
<rect class="b3" x="20" y="92" width="170" height="100" rx="8"/>
<text class="tb" x="105" y="112" text-anchor="middle" dominant-baseline="middle">请求阻塞</text>
<text class="ts" x="105" y="136" text-anchor="middle">HGETALL/SMEMBERS</text>
<text class="ts" x="105" y="154" text-anchor="middle">LRANGE 0 -1</text>
<text class="ts" x="105" y="172" text-anchor="middle">大 value 序列化</text>
<rect class="b5" x="200" y="92" width="170" height="100" rx="8"/>
<text class="tb" x="285" y="112" text-anchor="middle" dominant-baseline="middle">网络与带宽</text>
<text class="ts" x="285" y="136" text-anchor="middle">高频读大 value</text>
<text class="ts" x="285" y="154" text-anchor="middle">网卡被打满</text>
<text class="ts" x="285" y="172" text-anchor="middle">客户端读超时</text>
<rect class="b1" x="380" y="92" width="170" height="100" rx="8"/>
<text class="tb" x="465" y="112" text-anchor="middle" dominant-baseline="middle">删除与过期</text>
<text class="ts" x="465" y="136" text-anchor="middle">DEL 大 key 同步释放</text>
<text class="ts" x="465" y="154" text-anchor="middle">到期被动/主动删除</text>
<text class="ts" x="465" y="172" text-anchor="middle">造成延迟尖刺</text>
<rect class="b2" x="560" y="92" width="180" height="100" rx="8"/>
<text class="tb" x="650" y="112" text-anchor="middle" dominant-baseline="middle">集群与复制</text>
<text class="ts" x="650" y="136" text-anchor="middle">MIGRATE 长时间阻塞</text>
<text class="ts" x="650" y="154" text-anchor="middle">全量同步/复制缓冲膨胀</text>
<text class="ts" x="650" y="172" text-anchor="middle">被误判故障触发切换</text>
<rect class="b3" x="20" y="208" width="350" height="106" rx="8"/>
<text class="tb" x="195" y="228" text-anchor="middle" dominant-baseline="middle">内存倾斜</text>
<text class="ts" x="195" y="252" text-anchor="middle">大 key 集中的分片先达到 maxmemory</text>
<text class="ts" x="195" y="272" text-anchor="middle">触发淘汰或拒绝写；扩容也无法解决（key 不可拆）</text>
<text class="ts" x="195" y="294" text-anchor="middle">持久化 fork/COW 与 AOF 重写时放大内存与耗时</text>
<rect class="b5" x="390" y="208" width="350" height="106" rx="8"/>
<text class="tb" x="565" y="228" text-anchor="middle" dominant-baseline="middle">缓冲区与可用性</text>
<text class="ts" x="565" y="252" text-anchor="middle">客户端输出缓冲超限被断开</text>
<text class="ts" x="565" y="272" text-anchor="middle">代理/中间件对大包限制导致失败</text>
<text class="ts" x="565" y="294" text-anchor="middle">一个大 key 事故可波及整个分片上的所有业务</text>
</svg>
<figcaption>图 1：大 key 的危害链</figcaption>
</figure>

## 大 key 的发现

### 方法对比

| 方法 | 特点 | 风险与注意 |
| --- | --- | --- |
| **`redis-cli --bigkeys`** | 内部用 SCAN 遍历，按类型报告最大的 key（以元素数/长度衡量） | 会对线上产生扫描压力；对每个类型只报最大的，**不够全面**；建议在副本上执行并加 `-i` 限速 |
| **`redis-cli --memkeys`**（版本相关） | 以内存占用衡量 | 同上，需 `MEMORY USAGE`，较耗资源 |
| **`SCAN` + `MEMORY USAGE key [SAMPLES n]`** | 自己写扫描器，**限速、可中断、可采样**，结果可入库 | `MEMORY USAGE` 对大集合有成本（SAMPLES 可降低开销）；使用 SCAN 要处理重复与不保证一次性完整；**在副本上跑** |
| **类型专用长度命令**（`STRLEN`、`HLEN`、`LLEN`、`SCARD`、`ZCARD`、`XLEN`） | O(1) 获取元素数 | 先用它们筛选，再对可疑 key 精确测量 |
| **离线分析 RDB** | 解析 RDB 文件得到每个 key 的大小、类型、过期时间，**对线上零影响**，可全量精确 | RDB 有时间点滞后；需要工具（社区的 RDB 分析工具），大 RDB 分析耗时；可在备份副本上定期做 |
| **慢日志 / 延迟监控** | 大 key 操作常出现在 `SLOWLOG` 与 `LATENCY` 里 | 事后线索，不是全量；结合命令与 key 定位 |
| **客户端/代理统计** | SDK 或代理在读写时记录 value 大小与集合操作规模，**可以实时发现并拦截** | 需要接入；是**预防**的最佳位置 |
| **云厂商诊断功能** | 一键大 key 分析与告警 | 依赖平台 |

> [!WARNING] 禁用与慎用
> **不要在线上执行 `KEYS *`**（O(N) 阻塞）；`--bigkeys` 与自写扫描默认也要**限速、选副本、低峰**；不要在主节点上对大 key 执行 `DEBUG OBJECT`（版本相关）或 `HGETALL` 来“看看多大”。

### 扫描器的写法要点

```java
// 示意：在副本上、限速、采样地扫描大 key（Lettuce/Jedis 均可，思路相同）
long cursor = 0; int scanned = 0;
do {
    ScanResult r = replica.scan(cursor, ScanArgs.Builder.limit(200));   // 每次一小批
    for (String key : r.getKeys()) {
        String type = replica.type(key);
        long size = switch (type) {
            case "string" -> replica.strlen(key);
            case "hash"   -> replica.hlen(key);
            case "list"   -> replica.llen(key);
            case "set"    -> replica.scard(key);
            case "zset"   -> replica.zcard(key);
            default       -> 0;
        };
        if (isSuspicious(type, size)) {
            long mem = replica.memoryUsage(key, 5);                        // 采样估算内存，避免大开销
            report(key, type, size, mem, replica.ttl(key));
        }
    }
    cursor = r.getCursor();
    Thread.sleep(10);                                                       // 限速，避免影响副本复制与读
} while (cursor != 0 && ++scanned < MAX_BATCHES);
```

扫描结果应**入库并告警**：key 前缀（归一化后）、类型、大小、TTL、所属业务、负责人；按前缀聚合比逐个看 key 更容易推动整改。

## 大 key 的治理方案

### 总体思路

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="大 key 治理决策：先判断是否必须存在；能删除则清理过期数据并设置 TTL；需要保留则按数据特征拆分——String 压缩或拆块，Hash 分桶，List 和 ZSet 分段或按时间分片；读多写少的大对象放本地缓存或对象存储；无限增长的集合用裁剪；最终改造读写逻辑，并用双写灰度迁移后异步删除旧 key">
<rect class="b3" x="20" y="30" width="140" height="70" rx="8"/>
<text class="tb" x="90" y="52" text-anchor="middle" dominant-baseline="middle">① 必须存在吗</text>
<text class="ts" x="90" y="74" text-anchor="middle">清理垃圾·设 TTL</text>
<rect class="b5" x="180" y="30" width="140" height="70" rx="8"/>
<text class="tb" x="250" y="52" text-anchor="middle" dominant-baseline="middle">② 能变小吗</text>
<text class="ts" x="250" y="74" text-anchor="middle">精简字段·压缩</text>
<rect class="b1" x="340" y="30" width="140" height="70" rx="8"/>
<text class="tb" x="410" y="52" text-anchor="middle" dominant-baseline="middle">③ 能拆开吗</text>
<text class="ts" x="410" y="74" text-anchor="middle">分桶·分段·分片</text>
<rect class="b4" x="500" y="30" width="110" height="70" rx="8"/>
<text class="tb" x="555" y="52" text-anchor="middle" dominant-baseline="middle">④ 换存储</text>
<text class="ts" x="555" y="74" text-anchor="middle">DB/对象存储</text>
<rect class="b2" x="630" y="30" width="110" height="70" rx="8"/>
<text class="tb" x="685" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 迁移删除</text>
<text class="ts" x="685" y="74" text-anchor="middle">双写·UNLINK</text>
<line class="l" x1="160" y1="65" x2="180" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="65" x2="340" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="65" x2="500" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="65" x2="630" y2="65" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="720" height="186" rx="8"/>
<text class="th" x="32" y="144">各类型常用拆分方式</text>
<text class="ts" x="380" y="170" text-anchor="middle">String 大 value：裁剪字段、紧凑序列化、压缩；仍很大就拆块或放对象存储，只存引用</text>
<text class="ts" x="380" y="192" text-anchor="middle">Hash 大集合：按字段哈希分桶（user:{id}:{hash(field)%N}），每桶控制在几百到几千个字段；读写时计算桶号</text>
<text class="ts" x="380" y="214" text-anchor="middle">List/ZSet/Stream：按时间或序号分段（按天/按小时一个 key），旧段设 TTL 或归档；对榜单只保留 TopN 并裁剪</text>
<text class="ts" x="380" y="236" text-anchor="middle">Set 大集合（如关注/去重）：按成员哈希分片；超大去重改用布隆过滤器/HyperLogLog（近似）</text>
<text class="ts" x="380" y="258" text-anchor="middle">无限增长：写入时 LTRIM/ZREMRANGEBYRANK/XTRIM 裁剪，或强制 TTL；业务上限由代码保证</text>
<text class="ts" x="380" y="280" text-anchor="middle">冷热分离：热数据留 Redis（近期、TopN），冷数据落数据库/对象存储，按需回源；缓存不是全量存储</text>
<text class="ta" x="380" y="302" text-anchor="middle">任何拆分都要同时改“读、写、删除、过期”四处逻辑，并考虑跨桶聚合查询的成本</text>
</svg>
<figcaption>图 2：大 key 治理的决策路径与拆分方式</figcaption>
</figure>

### 拆分模式

**Hash 分桶**：把一个大 Hash 拆成 N 个小 Hash。

```java
// 原：HSET user:1001:attrs field value   （字段可能达到几十万）
// 改：按字段哈希分桶，桶数固定（如 64/256），上线后不能随意改桶数（会导致 key 映射变化）
String bucketKey(long userId, String field) {
    int b = Math.floorMod(field.hashCode(), BUCKETS);   // 稳定的哈希，不要用依赖 JVM 的不稳定哈希
    return "user:" + userId + ":attrs:" + b;
}
redis.hset(bucketKey(uid, f), f, v);
// 读全部：遍历所有桶（成本 = BUCKETS 次请求，可 pipeline）；通常业务只需读单字段
```

要点：桶数据量要均匀；**桶数一旦确定就应固定**，需要变更时做数据迁移；整体读取变成多次请求，要评估是否可接受；集群环境下各桶会分散到不同槽，**不要依赖跨桶原子操作**（或用 hash tag 绑定但会重新集中，需要权衡）。

**按时间分段**（List/ZSet/Stream/计数）：

- `feed:{uid}:{yyyyMMdd}`，近期几天的 key 热，老的 key 设 TTL 或归档到数据库；
- 查询跨段时合并多个 key 的结果；
- 单个段的大小要有上限，超大活跃用户再叠加分桶。

**榜单/ZSet**：只保留 TopN（`ZREMRANGEBYRANK` 裁剪），长尾数据放数据库；超大榜单按分区（地区/类目）拆多个榜单，汇总榜用异步合并生成。

**String 大 value**：

- 先**减肥**：去掉冗余字段、短字段名、避免存整个对象只存需要的字段；
- **压缩**：文本/JSON 压缩比可观，CPU 换内存与带宽；解压成本在客户端；注意压缩后的二进制要用二进制安全的序列化；
- **分块**：按固定大小切成多个 key（`doc:{id}:chunk:0..n`），读写时拼装；需要维护元数据；
- **放对象存储**：Redis 只存元数据与引用，见 [对象存储与文件服务](#/design/case-objectstore)。

### 无限增长的集合

大 key 常常不是设计成大的，而是**无上限地增长**（只 `LPUSH`/`SADD`/`HSET` 不清理）：

- 写入时**同步裁剪**（`LPUSH` 后 `LTRIM`；`XADD ... MAXLEN ~ N`）；
- 强制设置 **TTL**，且避免大量 key 同一时刻过期（加随机抖动），见 [过期策略与内存淘汰](#/redis/expire)；
- 业务层限制每个用户/租户的上限（如“最多关注 5000 人”）；
- 定期清理任务：后台限速清理无效数据，而不是等集合膨胀。

## 安全地删除与迁移

### 删除

| 方式 | 说明 |
| --- | --- |
| **`DEL`** | 同步释放内存，大 key 会长时间阻塞（O(元素数)）；**不要对大 key 使用** |
| **`UNLINK`**（4.0+） | **先摘除键空间引用，在后台线程异步释放内存**，主线程耗时 O(1) 量级；大 key 删除的首选 |
| **lazyfree 配置**（`lazyfree-lazy-expire/eviction/server-del/user-del` 等） | 让过期、淘汰、覆盖、`DEL` 都改用异步释放；建议在 4.0+ 的生产环境开启，详见 [线程模型与高性能原理](#/redis/overview) 的后台线程与 lazyfree |
| **渐进删除** | 超大集合（极端情况或旧版本）分批删除：`HSCAN` + `HDEL` 每批几百个、`SSCAN` + `SREM`、`LTRIM` 逐步截断、`ZREMRANGEBYRANK` 分批；批间休眠限速 |
| **过期删除** | 大 key 到期时若同步释放也会阻塞，开启 `lazyfree-lazy-expire`；避免大量大 key 集中过期 |
| **覆盖写** | 对大 key 重新 `SET` 覆盖同样会释放旧值，开启 `lazyfree-lazy-server-del` |

> [!TIP] 异步释放不是免费的
> `UNLINK` 把耗时的释放工作交给后台线程，**不再阻塞命令执行**，但释放过程仍消耗 CPU 与内存分配器资源，且**内存不会立即回落**（碎片、归还给 OS 的时机）。批量删除大 key 时仍要限速，并观察内存与延迟。

### 迁移与改造的步骤

1. **新逻辑兼容旧数据**：读时先读新结构，缺失则回源旧 key 并**写入新结构**（懒迁移）；
2. **双写**：写同时写新旧结构（短期），保证回退能力；
3. **灰度**：按业务/租户/流量比例逐步切到新结构读写；
4. **回填存量**：后台任务限速把旧 key 数据搬到新结构（在副本上读，主节点写入分批）；
5. **校验**：抽样对比新旧结构数据，监控命中率与错误；
6. **下线旧 key**：确认无读写后，用 `UNLINK`（或渐进删除）清理，分批进行；
7. **清理双写与兼容代码**。

## 热 key

### 现象与定位

热 key：某个 key 的 QPS 远高于其他（秒杀商品、爆款内容、全局配置、热门主播）。现象：**某个分片 CPU 接近 100%、网卡出带宽打满、延迟上升，其他分片空闲**；扩容分片无效（热 key 仍在某一个槽）。

| 发现手段 | 说明 |
| --- | --- |
| **`redis-cli --hotkeys`** | 需要 `maxmemory-policy` 为 LFU 系列，基于访问频率统计；会遍历键空间，线上慎用，在副本执行 |
| **`MONITOR`** | 实时打印所有命令，**严重影响性能，只能短时间在副本/低流量实例上使用**，不要在生产主节点长时间开启 |
| **客户端侧统计** | SDK 内按 key 前缀/key 统计访问次数（滑动窗口、Top-K 算法如 Count-Min Sketch），实时发现并上报，**成本最低、最推荐** |
| **代理层统计** | Redis 代理/网关统计热点 key；云厂商提供热 key 诊断 |
| **网络抓包采样** | 在网卡层采样分析 Redis 协议，对 Redis 无侵入，适合排障 |
| **业务预知** | 秒杀、大促、热点事件的 key 可以提前预判并预置治理 |

### 治理手段

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="热 key 的多层治理：客户端本地缓存兜住大部分读请求；把热 key 复制为多个带随机后缀的副本分散到不同槽；读写分离让副本分担读；写热点用分段计数和异步合并；最外层有限流降级保护；同时对热点做提前预热和监控告警">
<rect class="b3" x="20" y="14" width="720" height="62" rx="8"/>
<text class="tb" x="380" y="34" text-anchor="middle" dominant-baseline="middle">① 本地缓存（进程内）：热点读在应用内命中，请求根本不到 Redis</text>
<text class="ts" x="380" y="58" text-anchor="middle">Caffeine 等，短 TTL（秒级）+ 容量上限；一致性弱，适合可容忍短暂旧数据的读</text>
<rect class="b5" x="20" y="86" width="720" height="62" rx="8"/>
<text class="tb" x="380" y="106" text-anchor="middle" dominant-baseline="middle">② key 打散：热 key 复制 N 份（hot:{id}#0..N-1），读时随机选一份，写时更新所有副本</text>
<text class="ts" x="380" y="130" text-anchor="middle">副本分布在不同槽/不同分片，把单点压力分摊 N 倍；代价是写放大与副本间短暂不一致</text>
<rect class="b1" x="20" y="158" width="720" height="62" rx="8"/>
<text class="tb" x="380" y="178" text-anchor="middle" dominant-baseline="middle">③ 读写分离：热点读走副本节点，主节点只承担写；副本数可横向扩</text>
<text class="ts" x="380" y="202" text-anchor="middle">注意复制延迟带来的旧读；副本也要监控，避免热点转移到副本</text>
<rect class="b4" x="20" y="230" width="350" height="82" rx="8"/>
<text class="tb" x="195" y="250" text-anchor="middle" dominant-baseline="middle">④ 写热点：分段 + 异步合并</text>
<text class="ts" x="195" y="274" text-anchor="middle">计数/库存拆成多个分段 key，最终合并</text>
<text class="ts" x="195" y="294" text-anchor="middle">见高并发写入案例</text>
<rect class="b2" x="390" y="230" width="350" height="82" rx="8"/>
<text class="tb" x="565" y="250" text-anchor="middle" dominant-baseline="middle">⑤ 保护与预案</text>
<text class="ts" x="565" y="274" text-anchor="middle">限流降级（热点接口）、提前预热、大促前压测</text>
<text class="ts" x="565" y="294" text-anchor="middle">监控 Top-K key 访问量并告警</text>
</svg>
<figcaption>图 3：热 key 的分层治理手段</figcaption>
</figure>

| 手段 | 要点与坑 |
| --- | --- |
| **本地缓存** | 最有效且成本最低；用 Caffeine 等，设置**容量上限与短过期**；多实例各自缓存会产生**短暂不一致**，需要变更通知（订阅失效消息）时要避免“失效风暴”；热点自动识别后再启用本地缓存（避免所有 key 都缓存导致内存浪费） |
| **key 打散多副本** | 副本数 N 要与热点量级匹配；**写放大**（更新要写 N 份）、**删除要删 N 份**；确保副本 key 带一致的 TTL 与更新顺序；随机后缀要在 N 范围内均匀 |
| **读写分离** | 业务容忍复制延迟时可行；集群模式下客户端需支持读副本；热点转移到单个副本时仍会过载 |
| **多级缓存架构** | 浏览器/CDN → 网关/进程缓存 → Redis → 数据库，逐级拦截，见 [缓存设计与一致性](#/redis/cache) 的多级缓存 |
| **热点预热** | 活动前主动加载并复制热点数据，避免冷启动时缓存击穿到数据库 |
| **限流与降级** | 对热点接口按 key/用户限流，超出返回降级内容；防止 Redis 被打爆后拖垮数据库 |
| **业务层削峰** | 排队、请求合并（同一时刻对同一 key 的并发读合并成一次回源，`singleflight` 思想）、异步化 |
| **热点分散到多个实例** | 极端热点（如全站配置）用独立的 Redis 实例/只读副本池专门承载 |

热点不止读，**写热点**（计数、库存、点赞）更难处理，方法是拆分、合并、异步，见 [案例：高并发写入与热点治理（计数、库存、红包）](#/design/case-highwrite)。

### 集群里的热 key 与倾斜

- 热 key 与大 key 在集群中**共同造成数据倾斜**：看到“某分片异常”，先查该分片上的 Top 大 key 与 Top 热 key；
- hash tag 把一批 key 绑到同一槽，会把热点与大数据**人为集中**，见 [Redis Cluster 生产运维](#/redis/cluster-ops) 的数据倾斜章节；
- 扩分片只能分摊“多个 key”的负载，**单个热 key 的 QPS 不会因扩分片而下降**，必须针对 key 本身治理。

## 预防机制与长效治理

### 写入前拦截（最重要）

| 位置 | 做法 |
| --- | --- |
| **SDK/封装层** | 写入时检查 value 大小（超阈值拒绝或告警）、对集合类操作限制批量大小（`HGETALL` 改为分页）、禁止危险命令；统一 key 命名与 TTL 必填 |
| **代理/网关层** | 在 Redis 代理层限制命令与大小，统计热点与大 key，并支持动态封禁 |
| **ACL/命令禁用** | 禁用 `KEYS`、`FLUSHALL`、`FLUSHDB`、`DEBUG` 等；对 `HGETALL`、`SMEMBERS`、`LRANGE 0 -1` 做审查或限制 |
| **代码规范与评审** | 新增 key 的设计评审：预估大小、增长方式、过期策略、访问模式、负责人 |
| **CI 检查** | 静态扫描危险 API（无 TTL 的写入、无界集合操作） |

### 定期巡检与整改闭环

1. **周期扫描**：每天/每周在副本或离线 RDB 上跑大 key 与过期策略检查，按业务前缀聚合；
2. **报告与告警**：超阈值的 key 生成工单，通知负责人，定出整改期限；
3. **度量**：大 key 数量、最大 key 大小、占内存比例、整改完成率；
4. **事故复盘**：每次因大 key/热 key 导致的事故沉淀为规范与检查项，见 [事故复盘与改进](#/design/eng-postmortem)；
5. **容量模型**：用占用内存 Top 前缀预测增长，提前规划分片，见 [Redis 内存优化与容量治理](#/redis/memory)。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 偶发整个分片延迟尖刺、慢日志里是 `HGETALL`/`SMEMBERS` | 对大集合做全量读取 | 改分页/按需取字段（`HMGET`、`HSCAN`）；拆分大 key |
| 删除某个 key 后整个实例卡顿，甚至触发主从切换 | `DEL` 大 key 同步释放内存 | 使用 `UNLINK`，开启 lazyfree；渐进删除 |
| 一批 key 同时过期后延迟抖动 | 大 key/海量 key 集中过期，后台删除压力 | TTL 加随机抖动；开启 lazyfree-lazy-expire；拆分 |
| 扩容迁移中超时、切换 | 槽内有大 key，MIGRATE 阻塞 | 迁移前拆大 key，小批量低峰迁移 |
| 全量同步时主节点内存暴涨 | 大 key + 写入活跃，复制缓冲与 COW 放大 | 调整 backlog、预留内存、拆大 key |
| 单个分片带宽打满 | 热 key 的大 value 被高频读取 | 本地缓存、压缩、拆分、副本读 |
| 加了本地缓存后数据不一致 | 多实例缓存不同步 | 短 TTL + 失效广播；容忍度明确 |
| 打散多副本后出现脏读 | 写入未同时更新所有副本 | 写入路径统一封装；先更新后删除或带版本号 |
| 分桶后读取变慢 | 全量读取需要遍历所有桶 | 设计上避免全量读，或维护汇总结构；pipeline 并发读取 |
| 大 key 扫描影响了线上 | 在主节点全速扫描 | 副本执行、限速、低峰、采样 |

## 治理检查清单

- [ ] 是否有 SDK/代理层的 value 大小与集合规模拦截？
- [ ] 所有 key 是否设置了合理 TTL（带随机抖动），集合是否有长度上限与裁剪？
- [ ] 删除大 key 是否使用 `UNLINK`，是否开启了 lazyfree 相关配置？
- [ ] 是否有定期（副本/离线 RDB）的大 key 巡检、按业务聚合的报告和整改闭环？
- [ ] 是否有热 key 的实时发现（客户端统计/代理）与本地缓存、打散等预案？
- [ ] 监控是否区分分片/节点，能发现倾斜？
- [ ] 扩容、迁移、升级前是否先治理大 key？
- [ ] 危险命令是否被禁用或限制，`HGETALL`/`SMEMBERS` 等是否有分页替代？

## 相关阅读

- [缓存设计与一致性](#/redis/cache)：热 key、大 key 简述与多级缓存
- [Redis Cluster 生产运维](#/redis/cluster-ops)：迁移与数据倾斜
- [线程模型与高性能原理](#/redis/overview)：单线程模型、lazyfree 与慢命令后果
- [过期策略与内存淘汰](#/redis/expire)：过期删除与内存分析
- [案例：高并发写入与热点治理（计数、库存、红包）](#/design/case-highwrite)：写热点的拆分与合并

## 面试追问

> [!QUESTION] 什么是大 key？有什么危害？
> 单个 key 的 value 很大，或集合元素非常多，常见经验线是 String 超过十几 KB 到 1MB、集合元素过万。因为命令单线程执行，大 key 的读写、删除、过期、序列化会长时间占住主线程，导致请求排队超时甚至被误判故障切换；还造成带宽打满、内存倾斜、集群迁移阻塞、复制与持久化压力。

> [!QUESTION] 怎么发现线上的大 key？
> 在副本上限速用 SCAN 配合 MEMORY USAGE 或类型长度命令采样，也可用 redis-cli 的 bigkeys/memkeys；更全面且零影响的是离线解析 RDB；再结合慢日志、延迟监控，以及 SDK 或代理层的实时统计与拦截。不能在线上用 KEYS 或不限速全量扫描。

> [!QUESTION] 大 key 怎么治理？怎么安全删除？
> 先看能否清理或设 TTL，再精简压缩，然后拆分：Hash 分桶、List/ZSet 按时间或序号分段、集合分片，读多写少的放本地缓存或对象存储，无限增长的加裁剪与上限。迁移用双写灰度、回填、校验后再下线旧 key。删除用 UNLINK 异步释放，开启 lazyfree，极端情况分批渐进删除并限速。

> [!QUESTION] 热 key 怎么发现和处理？
> 用客户端或代理侧的 Top-K 统计实时发现，hotkeys 需 LFU 且线上慎用，MONITOR 只能短时使用。处理上多层兜底：本地缓存兜住热点读，key 复制多份加随机后缀分散到不同槽，读写分离让副本分担，写热点做分段与异步合并，再加限流降级和提前预热。扩分片对单个热 key 无效。

> [!QUESTION] 为什么说“扩容集群不能解决热 key”？
> 一个 key 只属于一个槽、只在一个分片上，访问量全部落在这个节点，增加分片只能分摊其他 key，对该热 key 的 QPS 没有帮助。必须针对 key 本身治理，如本地缓存、多副本打散、读写分离。

> [!QUESTION] 如何从机制上防止大 key 再次出现？
> 在 SDK 或代理层对 value 大小、集合规模和危险命令做写入前拦截，强制 TTL 与集合上限，key 设计评审，禁用危险命令；定期在副本或离线 RDB 上巡检并按业务聚合出报告、通知负责人整改，度量大 key 数量与整改率，事故后沉淀成规范。
