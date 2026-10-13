---
level: 深入
tags: [Redis, 过期删除, maxmemory-policy, LRU, LFU, 内存碎片]
summary: 过期 key 是怎么被删掉的、内存满了按什么规则淘汰、近似 LRU 与 LFU 的实现细节、主从下的过期语义，以及内存碎片与内存分析手段
---

# 过期策略与内存淘汰

> [!ABSTRACT] 核心要点
> - 过期删除 = **惰性删除**（访问时检查）+ **定期删除**（`activeExpireCycle` 抽样，过期比例高就继续，受时间片限制）。两者都不保证 key 一到期就消失，所以「过期 key 仍占内存」是常态。
> - 淘汰是另一回事：内存超过 `maxmemory` 时，**执行写命令前**按 `maxmemory-policy` 腾出空间。默认 `noeviction`（写入报 OOM 错误），缓存场景通常用 `allkeys-lru` 或 `allkeys-lfu`。
> - LRU 是近似的：随机采样 `maxmemory-samples`（默认 5）个 key 放入 16 槽的淘汰池，淘汰空闲最久的；LFU 把 24 位 lru 字段拆成「16 位分钟时间 + 8 位对数计数器」，计数按概率递增、按时间衰减。
> - 从库不主动删除过期 key，只等主库同步 `DEL`；3.2 起从库读到逻辑过期的 key 会返回空。主库挂掉、从库被提升前，从库内存里可能堆积大量过期 key。
> - `mem_fragmentation_ratio` > 1.5 说明碎片严重，可开启 `activedefrag`；< 1 说明发生了 swap，比碎片更危险。

## 过期 key 的存储

每个 db 有两个字典：`dict`（key → value）和 `expires`（key → 过期时间戳，毫秒）。`EXPIRE`/`PEXPIRE`/`EXPIREAT` 最终都转换为绝对毫秒时间戳写入 `expires`，所以 AOF 和复制里传播的是 `PEXPIREAT`，不会因传输延迟改变过期时刻。

几个容易忽略的语义：

- `SET k v` 不带 `EX`/`KEEPTTL` 会**清除原 TTL**（`KEEPTTL` 是 6.0 新增）；`INCR`、`LPUSH`、`HSET` 等修改值的命令不影响 TTL；
- `RENAME` 会把 TTL 一并带到新 key；
- `PERSIST` 移除 TTL；`TTL` 返回 -1 表示永不过期，-2 表示不存在；
- 7.0 起 `EXPIRE` 支持 `NX | XX | GT | LT` 选项；7.4 起 Hash 支持**字段级过期**（`HEXPIRE`/`HTTL` 等）。

## 过期删除策略

### 惰性删除

所有读写 key 的命令都会先调用 `expireIfNeeded()`：

- 主库：发现过期 → 删除（是否异步取决于 `lazyfree-lazy-expire`）→ 向 AOF 和从库传播 `DEL`/`UNLINK` → 当作 key 不存在处理；
- 从库：不删除，只返回「不存在」（见下文主从部分）。

只靠惰性删除，冷数据过期后永远不会被访问，就会一直占内存，所以需要定期删除兜底。

### 定期删除（activeExpireCycle）

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="定期删除流程：遍历数据库，每次抽取 20 个带过期时间的 key，删除已过期的，过期比例超过阈值且未超时就继续">
<rect class="b1" x="20" y="30" width="200" height="40" rx="8"/>
<text class="tm" x="120" y="50" text-anchor="middle" dominant-baseline="middle">serverCron / beforeSleep</text>
<line class="l" x1="220" y1="50" x2="258" y2="50" marker-end="url(#arr)"/>
<rect class="b" x="260" y="30" width="200" height="40" rx="8"/>
<text class="t" x="360" y="50" text-anchor="middle" dominant-baseline="middle">逐个 db 处理（≤ 16 个）</text>
<line class="l" x1="460" y1="50" x2="498" y2="50" marker-end="url(#arr)"/>
<rect class="b" x="500" y="30" width="200" height="40" rx="8"/>
<text class="t" x="600" y="50" text-anchor="middle" dominant-baseline="middle">抽取 20 个带 TTL 的 key</text>
<line class="l" x1="600" y1="70" x2="600" y2="108" marker-end="url(#arr)"/>
<rect class="b3" x="500" y="110" width="200" height="40" rx="8"/>
<text class="t" x="600" y="130" text-anchor="middle" dominant-baseline="middle">删除其中已过期的 key</text>
<line class="l" x1="600" y1="150" x2="600" y2="188" marker-end="url(#arr)"/>
<rect class="b4" x="500" y="190" width="200" height="44" rx="8"/>
<text class="t" x="600" y="212" text-anchor="middle" dominant-baseline="middle">过期比例 > 10% 且未超时？</text>
<line class="la" x1="500" y1="212" x2="480" y2="212"/>
<line class="la" x1="480" y1="212" x2="480" y2="60"/>
<line class="la" x1="480" y1="60" x2="498" y2="60" marker-end="url(#arr-a)"/>
<text class="ta" x="470" y="140" text-anchor="end">是：继续抽样本 db</text>
<line class="l" x1="600" y1="234" x2="600" y2="256" marker-end="url(#arr)"/>
<text class="ts" x="612" y="249">否</text>
<rect class="b2" x="500" y="258" width="200" height="32" rx="8"/>
<text class="t" x="600" y="274" text-anchor="middle" dominant-baseline="middle">处理下一个 db</text>
<text class="ts" x="20" y="110">慢周期：serverCron 中执行</text>
<text class="ts" x="20" y="128">  时间上限 = 25% × (1000ms / hz)</text>
<text class="ts" x="20" y="152">快周期：beforeSleep 中执行</text>
<text class="ts" x="20" y="170">  每次最多约 1ms，两次间隔 ≥ 2ms</text>
<text class="ts" x="20" y="194">每 16 次迭代检查一次是否超时</text>
<text class="ts" x="20" y="218">active-expire-effort（1～10，默认 1）</text>
<text class="ts" x="20" y="236">  调高 → 每批多抽、阈值更低、更耗 CPU</text>
</svg>
<figcaption>图 1：定期删除 activeExpireCycle 的抽样循环（6.0+）</figcaption>
</figure>

要点：

- 每批抽样 `ACTIVE_EXPIRE_CYCLE_KEYS_PER_LOOP = 20` 个 key；6.0 之前是随机抽取，6.0 起改为**按哈希桶游标顺序扫描** `expires`（类似 SCAN），保证每个 key 最终都会被检查到；
- 继续条件：本批过期比例大于可接受的「陈旧比例」（6.0+ 默认约 10%，effort 越高越低；6.0 之前固定为 25%）；
- 快周期在两次事件循环之间运行，处理「刚刚有大量 key 过期」的情况；慢周期是兜底；
- **大量 key 同时过期**会让每轮都触发「比例 > 阈值 → 继续」，主动过期一直吃满时间片，表现为延迟周期性抖动。这也是缓存过期时间要加随机值的原因之一，另一个原因是缓存雪崩，见 [缓存设计与一致性](#/redis/cache)。

### 持久化与过期

| 场景 | 处理 |
| --- | --- |
| 生成 RDB | 已过期的 key 不写入 |
| 主库加载 RDB | 跳过已过期的 key |
| 从库加载 RDB | 全部加载，等主库后续同步 DEL |
| AOF | key 过期被删除时追加 `DEL`；AOF 重写不写已过期的 key |

## 内存淘汰策略

### 触发时机

`processCommand` 中，若设置了 `maxmemory` 且命令可能增加内存（带 `denyoom` 标志），先调用 `performEvictions()`。淘汰到内存降回阈值以下才执行命令；淘汰不动（如 `noeviction` 或 volatile 策略下没有带 TTL 的 key）就返回 `OOM command not allowed`。

> [!NOTE]
> 计算是否超限时，会**扣除复制缓冲区和 AOF 缓冲区**的内存（`freeMemoryGetNotCountedMemory`），避免从库输出缓冲变大 → 触发淘汰 → 产生 DEL 传播 → 缓冲更大的死循环。6.2 起淘汰也是分批进行的（`maxmemory-eviction-tenacity`，默认 10），单次不会无限阻塞。

### 8 种策略

| 策略 | 候选范围 | 规则 | 适用 |
| --- | --- | --- | --- |
| `noeviction`（默认） | — | 不淘汰，写命令报错，读和删除正常 | Redis 当数据库用、数据不允许丢 |
| `allkeys-lru` | 所有 key | 近似最久未访问 | 通用缓存的首选 |
| `allkeys-lfu`（4.0+） | 所有 key | 近似最少访问频率 | 有明显热点、访问分布长期稳定 |
| `allkeys-random` | 所有 key | 随机 | 访问均匀（很少见） |
| `volatile-lru` | 带 TTL 的 key | 近似 LRU | 缓存与持久数据混存同一实例 |
| `volatile-lfu`（4.0+） | 带 TTL 的 key | 近似 LFU | 同上 |
| `volatile-random` | 带 TTL 的 key | 随机 | — |
| `volatile-ttl` | 带 TTL 的 key | 剩余 TTL 最短优先 | 业务能用 TTL 表达优先级 |

> [!WARNING]
> volatile-* 策略下，如果实例里都是不带 TTL 的 key，效果等同 `noeviction`，写入直接报 OOM。缓存实例和持久数据最好**物理隔离**，不要指望 volatile 策略帮你区分。

## 近似 LRU

真正的 LRU 需要维护一个全局双向链表，每次访问都移动节点，既费内存（每个 key 两个指针）又费 CPU。Redis 的做法：

- 每个对象的 `lru` 字段（24 位）记录最后访问时的**全局 LRU 时钟**（秒级精度，约 194 天回绕一次）；
- 淘汰时**随机采样** `maxmemory-samples` 个 key，计算空闲时间，放入一个大小为 16 的**淘汰池**（`EvictionPoolLRU`，按空闲时间升序），淘汰池跨多次淘汰保留候选；
- 从池尾取空闲时间最大、且仍然存在的 key 删除。

<figure class="fig">
<svg viewBox="0 0 720 280" class="dg" role="img" aria-label="近似 LRU：每次随机采样若干 key，按空闲时间插入 16 槽淘汰池，从池尾淘汰空闲最久的 key">
<rect class="bg" x="20" y="36" width="200" height="190" rx="10"/>
<text class="ts" x="36" y="54">随机采样 5 个 key</text>
<rect class="b" x="36" y="64" width="168" height="26" rx="4"/>
<text class="tm" x="120" y="77" text-anchor="middle" dominant-baseline="middle">k1  idle=5s</text>
<rect class="b" x="36" y="94" width="168" height="26" rx="4"/>
<text class="tm" x="120" y="107" text-anchor="middle" dominant-baseline="middle">k7  idle=120s</text>
<rect class="b" x="36" y="124" width="168" height="26" rx="4"/>
<text class="tm" x="120" y="137" text-anchor="middle" dominant-baseline="middle">k3  idle=30s</text>
<rect class="b" x="36" y="154" width="168" height="26" rx="4"/>
<text class="tm" x="120" y="167" text-anchor="middle" dominant-baseline="middle">k9  idle=600s</text>
<rect class="b" x="36" y="184" width="168" height="26" rx="4"/>
<text class="tm" x="120" y="197" text-anchor="middle" dominant-baseline="middle">k5  idle=2s</text>
<line class="l" x1="220" y1="130" x2="288" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="254" y="120" text-anchor="middle">按 idle 插入</text>
<text class="ts" x="290" y="34">淘汰池（16 槽，idle 升序，跨轮保留）</text>
<rect class="b1" x="290" y="44" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="57" text-anchor="middle" dominant-baseline="middle">k5  idle=2s</text>
<rect class="b1" x="290" y="74" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="87" text-anchor="middle" dominant-baseline="middle">k1  idle=5s</text>
<rect class="b1" x="290" y="104" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="117" text-anchor="middle" dominant-baseline="middle">k3  idle=30s</text>
<rect class="b1" x="290" y="134" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="147" text-anchor="middle" dominant-baseline="middle">k7  idle=120s</text>
<rect class="b1" x="290" y="164" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="177" text-anchor="middle" dominant-baseline="middle">k2  idle=300s（上一轮留下）</text>
<rect class="b4" x="290" y="194" width="230" height="26" rx="4"/>
<text class="tm" x="405" y="207" text-anchor="middle" dominant-baseline="middle">k9  idle=600s</text>
<line class="la" x1="520" y1="207" x2="568" y2="207" marker-end="url(#arr-a)"/>
<text class="ts" x="545" y="198" text-anchor="middle">取池尾</text>
<rect class="b4" x="570" y="188" width="130" height="38" rx="8"/>
<text class="tb" x="635" y="207" text-anchor="middle" dominant-baseline="middle">淘汰 k9</text>
<text class="ts" x="20" y="252">LFU 模式下 idle 换成 255 − 访问频率；volatile-ttl 换成「越早过期越优先」</text>
<text class="ts" x="20" y="270">samples=10 时效果已非常接近真实 LRU，代价是每次淘汰多一些 CPU</text>
</svg>
<figcaption>图 2：近似 LRU 的采样与淘汰池</figcaption>
</figure>

LRU 的固有问题是**偶发的批量扫描会污染缓存**：一次全表遍历把大量冷 key 的 lru 刷新成「刚访问」，真正的热 key 反而被淘汰。LFU 就是为此引入的。

## LFU

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="LFU 模式下 24 位 lru 字段拆为 16 位分钟时间 ldt 和 8 位对数计数器 logc，访问时概率递增，空闲时按分钟衰减">
<text class="ts" x="60" y="30">robj.lru（24 bit）在 LFU 模式下的含义</text>
<rect class="b1" x="60" y="40" width="400" height="44" rx="4"/>
<text class="t" x="260" y="62" text-anchor="middle" dominant-baseline="middle">ldt：上次递减时间（分钟精度，高 16 位）</text>
<rect class="b3" x="460" y="40" width="200" height="44" rx="4"/>
<text class="t" x="560" y="62" text-anchor="middle" dominant-baseline="middle">logc：对数计数（低 8 位）</text>
<line class="l" x1="260" y1="84" x2="205" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="84" x2="515" y2="118" marker-end="url(#arr)"/>
<rect class="b2" x="60" y="120" width="290" height="72" rx="8"/>
<text class="tb" x="205" y="138" text-anchor="middle" dominant-baseline="middle">访问时：先衰减，再按概率 +1</text>
<text class="tm" x="205" y="160" text-anchor="middle" dominant-baseline="middle">p = 1 / ((c − 5) × factor + 1)</text>
<text class="ts" x="205" y="180" text-anchor="middle" dominant-baseline="middle">新 key 初始 c = 5，最大 255</text>
<rect class="b5" x="370" y="120" width="290" height="72" rx="8"/>
<text class="tb" x="515" y="138" text-anchor="middle" dominant-baseline="middle">衰减：按空闲时长递减</text>
<text class="tm" x="515" y="160" text-anchor="middle" dominant-baseline="middle">c −= 空闲分钟数 / decay-time</text>
<text class="ts" x="515" y="180" text-anchor="middle" dominant-baseline="middle">lfu-decay-time 默认 1 分钟</text>
<text class="ts" x="60" y="218">lfu-log-factor 默认 10：约 100 次访问 c≈10，约 100 万次访问 c 才接近 255</text>
</svg>
<figcaption>图 3：LFU 的对数计数器与时间衰减</figcaption>
</figure>

- **为什么是对数计数**：8 位只能表示 0～255，线性计数很快饱和。概率递增让计数近似 `log(访问次数)`，`lfu-log-factor` 越大，区分高频 key 的能力越强、饱和越慢；
- **为什么初始值是 5**：新 key 计数为 0 会被立刻淘汰，给 5 是「新手保护期」；
- **为什么要衰减**：否则曾经很热、现在不访问的 key 永远不会被淘汰。衰减是**惰性**的，访问或被采样时才根据 ldt 计算；
- `OBJECT FREQ key` 可看计数值；`redis-cli --hotkeys` 依赖 LFU 策略，基于这个计数找热 key。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `maxmemory` | 0（64 位不限） | 生产必须设置，一般为物理内存的 60%～75%，给 fork COW 和碎片留余量 |
| `maxmemory-policy` | `noeviction` | 缓存通常改为 `allkeys-lru` / `allkeys-lfu` |
| `maxmemory-samples` | 5 | 调到 10 更精确，CPU 略增 |
| `maxmemory-eviction-tenacity` | 10 | 6.2+，单次淘汰的努力程度（0～100） |
| `lfu-log-factor` | 10 | 越大计数增长越慢 |
| `lfu-decay-time` | 1 | 分钟；0 表示不衰减 |

## 主从与过期

- **从库不主动删除过期 key**（无论惰性还是定期），只等待主库传播的 `DEL`。这样保证主从数据一致：从库自己删可能和主库时钟不一致。
- 3.2 之前：从库读到「逻辑已过期但主库还没发 DEL」的 key，会**返回旧值**，读写分离时会读到过期数据。3.2 起从库会根据 TTL 判断，过期的返回空（但仍不删除）。
- 从库时钟偏差会影响这个判断：从库时间比主库快，会提前认为 key 过期。
- 可写从库（`replica-read-only no`）上写入的带 TTL 的 key，4.0 起由从库自己跟踪并删除。
- 故障转移后：新主开始执行主动过期，如果之前积累了大量过期 key，切换后的短时间内 CPU 和延迟会升高。

> [!CAUTION]
> 读写分离读从库时，`EXPIRE` 刚设置的 key 在从库上可能还没生效（复制延迟），`TTL` 返回值也可能不同。对过期语义敏感的逻辑（如分布式锁、限流）必须读主库。

## 内存碎片与 activedefrag

`INFO memory` 关键指标：

| 指标 | 含义 |
| --- | --- |
| `used_memory` | Redis 通过分配器申请的内存总量 |
| `used_memory_rss` | 操作系统看到的进程常驻内存 |
| `mem_fragmentation_ratio` | `rss / used_memory`。1.0～1.5 正常；> 1.5 碎片严重；< 1 说明部分内存被 swap |
| `allocator_frag_ratio` | 分配器层面的碎片，比上面的比值更能反映可整理的碎片 |
| `used_memory_peak` | 历史峰值，大量删除后 rss 往往停在峰值附近 |

碎片来源：jemalloc 按固定 size class 分配（如申请 33 字节给 48 字节），以及频繁修改不同大小的 value、大量删除后空洞无法归还操作系统。

处理方式：

1. **activedefrag**（4.0+，需 jemalloc）：后台扫描 key，把碎片页中的对象复制到新地址再释放旧的，增量进行。
2. 重启实例（从 RDB/AOF 加载时内存紧凑），或主从切换后重建旧主。
3. `MEMORY PURGE` 让 jemalloc 归还空闲页（效果有限）。

| 参数 | 默认（7.x） | 说明 |
| --- | --- | --- |
| `activedefrag` | no | 开启后满足下面条件才运行 |
| `active-defrag-ignore-bytes` | 100mb | 碎片量小于此值不整理 |
| `active-defrag-threshold-lower` | 10 | 碎片率超过 10% 开始整理 |
| `active-defrag-threshold-upper` | 100 | 超过 100% 时用最大力度 |
| `active-defrag-cycle-min` / `max` | 1 / 25 | 占主线程 CPU 的百分比范围（7.0 之前默认 5 / 75） |

> [!WARNING]
> 碎片整理在主线程执行，会占用 CPU 并拉高延迟。建议在低峰期开启，并把 `cycle-max` 控制在 25 以内观察延迟。

## 内存分析

```bash
redis-cli -h 10.0.0.1 --bigkeys -i 0.1        # 按类型找元素最多的 key，-i 控制每 100 个 SCAN 后休眠
redis-cli -h 10.0.0.1 --memkeys               # 6.0+，按实际内存占用找大 key
redis-cli -h 10.0.0.1 --hotkeys               # 需要 maxmemory-policy 为 *-lfu
redis-cli MEMORY USAGE user:1001 SAMPLES 0    # 单 key 内存；集合类默认只采样 5 个元素估算，0 表示全量
redis-cli MEMORY STATS                        # 内存构成：数据、缓冲区、复制积压、Lua 等
redis-cli MEMORY DOCTOR                       # 给出诊断建议
```

`--bigkeys` 只看元素个数，一个 1000 元素但每个 1MB 的 List 不会排前面，所以要结合 `--memkeys`。离线全量分析可以用 `rdb-tools`/`redis-rdb-cli` 解析 RDB 文件，不影响线上实例。

## 生产实践与踩坑

- **内存持续上涨但 key 数没变**：常见原因是客户端输出缓冲（`client-output-buffer-limit`，Pub/Sub 慢消费者、`MONITOR`）、复制积压、Lua 脚本缓存、碎片。先看 `MEMORY STATS` 的分项。
- **设置了 maxmemory 依然 OOM 被系统杀**：`maxmemory` 不包括 fork 时的 COW 内存和碎片。物理内存 16GB 的机器 `maxmemory` 设 14GB，BGSAVE 时大量写入就可能触发 OOM Killer。
- **淘汰导致的抖动**：写入速度远高于淘汰速度时，每条写命令都要先淘汰，延迟上升；`INFO stats` 的 `evicted_keys` 增速和 `LATENCY` 里的 `eviction-cycle` 能看出来。
- **过期 key 堆积**：`INFO keyspace` 里的 `expires` 很大且内存居高不下，可以临时调高 `hz`（如 20～50）或 `active-expire-effort`，或者用 `SCAN` 主动触发惰性删除。
- **noeviction 当缓存用**：内存满后所有写入报错，业务大面积失败。缓存实例一定要显式改策略。

## 相关阅读

- [虚拟内存、分页与内存管理](#/cs/os-memory)：页面置换与 LRU/LFU 的同源思想
- [复杂度与核心数据结构](#/cs/algo-ds)：手写 LRU

## 面试追问

> [!QUESTION] 一个 key 过期后，Redis 一定会立即删除它吗？
> 不会。只有被访问（惰性）或被定期删除抽样到才会删除。定期删除每次只抽 20 个、受时间片限制，大量过期 key 可能存活一段时间。从库更是只等主库的 DEL。

> [!QUESTION] Redis 的 LRU 为什么是近似的？准确度如何？
> 精确 LRU 要维护全局链表，每次访问移动节点，内存和 CPU 开销大。Redis 用 24 位时钟记录访问时间，淘汰时随机采样并配合 16 槽淘汰池，samples=10 时效果已接近精确 LRU。

> [!QUESTION] LFU 怎么在 8 位里表示访问频率？如何避免「历史热点」一直不被淘汰？
> 用对数概率计数：计数越大，再次 +1 的概率越小，`lfu-log-factor=10` 时约百万次访问才到 255。同时高 16 位记录分钟级时间戳，按空闲分钟数 / `lfu-decay-time` 衰减计数，历史热点会逐渐冷却。

> [!QUESTION] 读写分离时，为什么从库可能读到过期数据？
> 从库不主动删除过期 key。3.2 之前从库直接返回旧值；3.2 起会按 TTL 判断返回空，但仍受复制延迟（`EXPIRE` 命令还没到从库）和时钟偏差影响。过期语义敏感的读必须走主库。

> [!QUESTION] mem_fragmentation_ratio 小于 1 意味着什么？
> rss 小于 Redis 申请的内存，说明部分内存被换出到 swap，访问这些数据会触发磁盘 IO，延迟急剧升高。应该检查宿主机内存、关闭或限制 swap（`vm.swappiness`）、降低 maxmemory。
