---
level: 深入
tags: [Redis, 内存优化, 容量规划, 编码, listpack, 内存碎片, 压缩, TTL, 淘汰策略, 成本, 数据结构选型]
summary: Redis 内存优化与容量治理：内存都花在哪（数据、元数据、缓冲、碎片、复制与持久化开销）、内存分析方法、数据结构与编码选型（小对象合并、紧凑编码阈值）、key 与 value 的瘦身、序列化与压缩、TTL 与淘汰策略、碎片整理、容量模型与预警、成本核算与分层，以及优化的收益评估与风险。
---

# Redis 内存优化与容量治理

> [!ABSTRACT] 核心要点
> - Redis 是**内存数据库，内存是最贵的资源**。优化的顺序是：**先搞清楚内存花在哪（度量）→ 治理“不该存”的（TTL、无用数据）→ 选对数据结构与编码 → 瘦身 key/value → 序列化压缩 → 容量模型与预警**。没有度量就优化，往往收益有限且引入风险。
> - 一个 key 的内存 = **数据本身 + 元数据开销（dictEntry、redisObject、SDS 头、过期字典等）+ 分配器的对齐与碎片**。**海量小 key 时，元数据开销可能超过数据本身**——这是“1 亿个小 key 占几十 GB”的根因。
> - 最有效的几招：**设置并规范 TTL**（防止无限增长）、**小对象合并为 Hash（利用紧凑编码）**、**精简字段与更紧凑的序列化**、**压缩大 value**、**用合适的结构**（Bitmap/HyperLogLog/整数集合/Stream 替代 String 堆砌）、**限制集合规模**。
> - **碎片与 RSS**：`used_memory` 不等于进程占用的物理内存；**碎片率（`mem_fragmentation_ratio`）** 异常、删除后内存不回落、副本与主节点内存差异大，都要理解**分配器行为**；可用**主动碎片整理**与**重启/切换**缓解。
> - 容量规划要覆盖**主节点峰值 + fork COW + 复制缓冲 + 客户端缓冲 + 增长**；用**按业务前缀的内存画像**驱动成本分摊与整改，并设置**水位线预警**（60%/70%/80%）。
> - 缓存场景优先考虑**命中率与成本**：淘汰策略与 TTL 决定了“该留什么”；存储场景要谨慎，`noeviction` + 容量告警 + 持久化。

## 内存都花在哪

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="Redis 进程内存构成：键值数据（key、value 本身）、元数据开销（字典项、对象头、SDS 头、过期字典）、各类缓冲（客户端输入输出缓冲、复制积压缓冲、AOF 缓冲）、持久化 fork 的写时复制额外内存、内存分配器的碎片与对齐、Lua 与脚本缓存、模块；used_memory 反映 Redis 申请量，RSS 反映操作系统实际占用">
<rect class="b3" x="20" y="30" width="720" height="60" rx="0"/>
<rect class="b5" x="20" y="30" width="300" height="60" rx="0"/>
<text class="tb" x="170" y="52" text-anchor="middle" dominant-baseline="middle">键值数据本身</text>
<text class="ts" x="170" y="72" text-anchor="middle">key 字节 + value 字节</text>
<rect class="b1" x="320" y="30" width="150" height="60" rx="0"/>
<text class="tb" x="395" y="52" text-anchor="middle" dominant-baseline="middle">元数据开销</text>
<text class="ts" x="395" y="72" text-anchor="middle">字典项·对象头·SDS 头</text>
<rect class="b4" x="470" y="30" width="120" height="60" rx="0"/>
<text class="tb" x="530" y="52" text-anchor="middle" dominant-baseline="middle">各类缓冲</text>
<text class="ts" x="530" y="72" text-anchor="middle">客户端·复制·AOF</text>
<rect class="b2" x="590" y="30" width="150" height="60" rx="0"/>
<text class="tb" x="665" y="52" text-anchor="middle" dominant-baseline="middle">其他</text>
<text class="ts" x="665" y="72" text-anchor="middle">Lua·模块·过期字典</text>
<text class="ta" x="380" y="22" text-anchor="middle">used_memory：Redis 向分配器申请的总量</text>
<rect class="bg" x="20" y="110" width="720" height="50" rx="8"/>
<text class="ts" x="380" y="128" text-anchor="middle">+ 分配器碎片与对齐（RSS 通常大于 used_memory）  + fork 期间 COW 的额外页  ⇒ 进程实际 RSS（操作系统看到的占用）</text>
<text class="ts" x="380" y="148" text-anchor="middle">mem_fragmentation_ratio ≈ RSS / used_memory：明显 >1.5 说明碎片多；<1 可能发生了 swap（危险）</text>
<rect class="b" x="20" y="176" width="350" height="144" rx="8"/>
<text class="th" x="32" y="196">每个 key 的固定开销（量级示意）</text>
<text class="ts" x="195" y="222" text-anchor="middle">字典桶指针 + dictEntry（key/value/next）</text>
<text class="ts" x="195" y="242" text-anchor="middle">redisObject 头（类型/编码/LRU/引用）</text>
<text class="ts" x="195" y="262" text-anchor="middle">key 的 SDS 头 + 过期字典项（有 TTL 时）</text>
<text class="ts" x="195" y="286" text-anchor="middle">合计每个 key 约几十到上百字节的额外开销</text>
<text class="ts" x="195" y="306" text-anchor="middle">具体取决于版本、编码与分配器大小类</text>
<rect class="b4" x="390" y="176" width="350" height="144" rx="8"/>
<text class="th" x="402" y="196">由此得到的直觉</text>
<text class="ts" x="565" y="222" text-anchor="middle">大量“小 key + 小 value”时，开销占比极高</text>
<text class="ts" x="565" y="242" text-anchor="middle">→ 合并为 Hash 等紧凑结构收益最大</text>
<text class="ts" x="565" y="266" text-anchor="middle">少量“大 value”时，数据本身占主要</text>
<text class="ts" x="565" y="286" text-anchor="middle">→ 精简字段、压缩、拆分、冷热分离</text>
<text class="ts" x="565" y="306" text-anchor="middle">必须用 MEMORY USAGE / RDB 分析验证，而不是估算</text>
</svg>
<figcaption>图 1：Redis 内存的构成与每个 key 的固定开销</figcaption>
</figure>

数据结构的底层编码（SDS、dict、listpack、skiplist）见 [数据结构与底层编码](#/redis/types)，淘汰与碎片整理基础见 [过期策略与内存淘汰](#/redis/expire)。

## 度量：先看清楚再优化

| 手段 | 作用 |
| --- | --- |
| **`INFO memory`** | `used_memory`、`used_memory_rss`、`used_memory_peak`、`mem_fragmentation_ratio`、`used_memory_overhead`（元数据）、`used_memory_dataset`（数据）、`mem_clients_normal`（客户端缓冲）、`mem_replication_backlog` 等 |
| **`MEMORY STATS` / `MEMORY DOCTOR`** | 分项统计与诊断建议 |
| **`MEMORY USAGE key [SAMPLES n]`** | 单个 key 的实际占用（含开销）；对大集合用 SAMPLES 采样 |
| **`DEBUG OBJECT key`**（慎用） | 查看编码与序列化长度，部分版本不建议线上使用 |
| **`OBJECT ENCODING key`** | 查看底层编码（listpack/hashtable/skiplist/int/embstr 等），判断是否触发紧凑编码 |
| **RDB 离线分析** | 按**前缀、类型、编码、过期**统计内存占比，得到“内存画像”，零线上影响 |
| **扫描采样** | 限速 SCAN + MEMORY USAGE 抽样，估算各前缀的总占用 |
| **按业务前缀的画像** | 每个业务/前缀：key 数量、总内存、平均大小、最大 key、有无 TTL、TTL 分布；**这是容量治理与成本分摊的基础** |

内存画像里重点看四个问题：①**哪些前缀占了大头**（二八定律，通常几个前缀占 80%）；②**有多少 key 没有 TTL**；③**key 数量 vs 平均大小**（决定优化方向）；④**编码**（是否本应紧凑却退化成了 hashtable）。

## 第一步：治理“不该存的”

| 问题 | 治理 |
| --- | --- |
| **没有 TTL 的 key** | 缓存类数据**必须有 TTL**；扫描无 TTL 的 key，按前缀整改；存储类数据要有明确的生命周期与归档策略 |
| **TTL 过长** | 按数据价值定 TTL：短周期热点数据用分钟/小时，越长占用越多；用命中率曲线评估合适的 TTL |
| **过期集中** | TTL 加随机抖动，避免同一时间大量过期造成删除与回源洪峰，见 [缓存设计与一致性](#/redis/cache) |
| **僵尸数据** | 下线业务遗留的 key、测试数据、重复数据；按前缀巡检并清理（`UNLINK` 限速分批） |
| **无界增长** | 集合/Stream/列表必须有上限与裁剪，见 [大 key 与热 key 治理](#/redis/bigkey) |
| **缓存了本不该缓存的** | 低命中率、一次性访问、体积大而收益小的数据；用命中率与访问分布（LFU 统计）判断缓存价值 |
| **冗余存储** | 同一份数据在多个 key/结构里重复；统一数据模型 |
| **副本/测试环境** | 非生产环境与生产同规格浪费；按需缩容 |

## 第二步：数据结构与编码

### 紧凑编码

Redis 对**小规模**的集合类型使用**紧凑的连续内存编码**（Hash/List/Set/ZSet 在元素少且元素小时使用 listpack，Set 的整数使用 intset），内存显著低于通用的哈希表/跳表：

| 类型 | 紧凑编码条件（配置项，版本相关） | 超过后 |
| --- | --- | --- |
| **Hash** | 字段数 ≤ `hash-max-listpack-entries`（默认 128），每个值长度 ≤ `hash-max-listpack-value`（默认 64 字节） | 转为 hashtable |
| **Set** | 全是整数且数量 ≤ `set-max-intset-entries`（默认 512）→ intset；7.2 起小集合也可用 listpack（`set-max-listpack-entries`） | hashtable |
| **ZSet** | 元素数 ≤ `zset-max-listpack-entries`（默认 128），元素长度 ≤ `zset-max-listpack-value`（默认 64） | skiplist + dict |
| **List** | quicklist（listpack 节点），`list-max-listpack-size` 控制节点大小 | — |

> [!NOTE] 版本名称
> 7.0 之前这些配置以 `ziplist` 命名（如 `hash-max-ziplist-entries`），7.0 起改为 `listpack`；默认值与行为以所用版本官方文档为准。

**可调但有代价**：把阈值调大，更多对象保持紧凑编码，**省内存**，但紧凑编码是**连续数组，查找与修改是 O(N)**，元素多时单个命令更慢，且大集合的**修改会更频繁地触发内存重分配/拷贝**。通常保持默认或小幅提高（如 hash 到 256~512），并用压测验证延迟，而不是无脑调高。

### 小对象合并：最有效的省内存手法之一

**问题**：1 亿个形如 `user:{id}:level = 5` 的 String key，每个 key 的固定开销（几十~上百字节）远大于数据（几字节）。

**做法**：把 ID 分桶，合并到 Hash，让每个 Hash 保持在紧凑编码范围内：

```java
// 原：SET user:{id}:level 5          （一亿个 key，开销巨大）
// 改：按 id 分桶，每个桶是一个小 Hash，字段是桶内偏移
String key = "user:level:" + (id / 1000);         // 每桶约 1000 个字段，保持在 listpack 阈值之内需配合调整阈值
String field = String.valueOf(id % 1000);
redis.hset(key, field, "5");
```

要点：

- 桶大小要**落在紧凑编码阈值内**（或有意识地调高阈值），否则退化为 hashtable 失去收益；
- 合并后**不能对单个字段单独设置 TTL**（TTL 是 key 级别）；需要不同 TTL 的数据不适合合并，或按过期时间分桶；
- 整桶的读取/删除成本变大，**要避免对桶做全量操作**；
- 与分布式场景一致：桶数固定，集群下各桶分布在不同槽，天然分散；
- 收益需实测：通常能把小 key 场景的内存降低数倍。

### 选对数据结构

| 场景 | 不佳做法 | 更省内存的做法 |
| --- | --- | --- |
| **布尔/签到/在线状态（按用户 ID）** | 每个用户一个 key | **Bitmap**：1 亿用户约 12MB；稀疏时注意偏移过大导致分配过大 |
| **UV 统计（去重计数）** | Set 存全部用户 ID | **HyperLogLog**：固定约 12KB，误差约 0.81%，不可取出成员 |
| **去重判断（海量）** | Set | **布隆过滤器**（Redis Stack/模块或自实现）：可接受误判 |
| **整数集合** | 字符串形式的 Set | **intset**（元素全为整数且量不大） |
| **对象的多个属性** | 每个属性一个 key | 一个 **Hash** 存多个字段（并且字段数小保持紧凑） |
| **时间序列/事件** | 大 List/ZSet | **Stream** 配合裁剪，或使用时序库 |
| **排行榜** | 全量 ZSet 永久保留 | 只保留 TopN 与近期，历史落库 |
| **地理位置** | 自己拼 | GEO（基于 ZSet 的 geohash） |

Bitmap/HyperLogLog 的使用示例见 [高频场景实战](#/redis/practice)，统计类结构的取舍见同页。

### 字符串编码

String 有三种内部编码：`int`（可表示为整数的值，直接存在对象指针里，最省）、`embstr`（≤44 字节左右的短字符串，对象与数据连续分配）、`raw`（长字符串）。对于**大量整数值**（计数、ID），**存纯数字字符串**能命中 `int` 编码，比存 JSON 或带前缀的字符串省得多；共享整数对象池（0~9999）在一定条件下还可复用。

## 第三步：key 与 value 瘦身

### key 设计

| 做法 | 说明 |
| --- | --- |
| **缩短 key 名** | 每个 key 都带一份名字；`user:profile:detail:{id}` → `u:p:{id}`。在**海量小 key**时有效；代价是可读性，要有**命名规范与字典文档**，不要缩到无法辨认 |
| **层级前缀固定且短** | 便于按前缀统计与治理 |
| **用 Hash 的 field 承载变化部分** | 减少 key 数量 |
| **避免把可推导信息放进 key** | 如重复的环境、业务域信息（用独立实例/库区分环境） |

### value 设计

| 做法 | 说明 |
| --- | --- |
| **只存需要的字段** | 缓存对象只存读路径需要的字段，而不是整个领域对象（包括大文本、审计字段） |
| **字段名缩短或用数组/定长格式** | JSON 里的长字段名在海量对象里是显著开销；改用数组、位置编码或二进制格式 |
| **数值存数值** | 不要用字符串表示的大整数与布尔，必要时位压缩 |
| **去掉冗余/可计算字段** | 读时计算的不存 |
| **引用代替内联** | 大文本/图片存对象存储，Redis 存引用，见 [对象存储与文件服务](#/design/case-objectstore) |
| **共享重复内容** | 大量相同的大对象用同一 key 引用（内容寻址/去重） |

### 序列化与压缩

| 方案 | 特点 |
| --- | --- |
| **JSON** | 可读、兼容性好，但体积大（字段名重复、数字文本化） |
| **Protobuf / Avro / MessagePack 等二进制** | 体积小、解析快，需要 Schema 管理（见 [Kafka 生态](#/mw/kafka-ecosystem) 中的 Schema 演进思路）；跨语言友好 |
| **Java 原生序列化** | 体积大、版本脆弱、有安全风险，**不推荐** |
| **压缩（LZ4/Snappy/ZSTD/GZIP）** | 对文本/JSON 压缩比高；**CPU 换内存与带宽**；压缩阈值（如 > 1KB 才压缩）避免小数据负收益；LZ4/Snappy 速度快，ZSTD 压缩比好 |
| **客户端压缩 vs 服务端** | Redis 本身不压缩 value，压缩要在**客户端**完成；注意读写双方统一的编解码约定与版本标记 |

经验：先**精简字段**，再**换二进制序列化**，最后对**大文本**加压缩；每一步用样本数据测量压缩比与 CPU 开销，不要凭感觉。

## 淘汰策略与容量水位

| 场景 | 策略 | 说明 |
| --- | --- | --- |
| **纯缓存** | `allkeys-lru` / `allkeys-lfu` | 淘汰任意 key；LFU 对“有明显热点”的访问更友好；需确保业务能容忍缓存未命中，并有回源保护 |
| **缓存 + 少量必须保留** | `volatile-lru/lfu/ttl` | 只淘汰有 TTL 的；**没有 TTL 的 key 永不被淘汰**，内存可能被它们占满导致写失败，需要巡检 |
| **存储/数据不可丢** | `noeviction` | 内存满时写入报错；**必须配容量预警与扩容流程**，否则会写失败 |

水位线管理：

- **60%**：预警，开始评估扩容/治理；**70%**：触发扩容流程（预留 COW 与增长）；**80%+**：紧急，可能影响持久化与复制；
- **监控淘汰数 `evicted_keys`**：缓存场景淘汰是正常的，但**突增**说明容量不足或热点变化；命中率同时下降要关注；
- **maxmemory 设置要考虑**：机器总内存、其他进程、fork COW、复制与客户端缓冲；`maxmemory` 不包含部分缓冲区，不能把它设成物理内存的 100%；
- **客户端缓冲**：`client-output-buffer-limit` 防止慢消费者/订阅者撑爆内存，大 key 读取也会放大输出缓冲。

## 碎片与内存回收

### 现象

- `mem_fragmentation_ratio` 持续大于 1.5：RSS 远大于 `used_memory`，分配器存在大量不可用的碎片；
- 删除大量 key 后 RSS 不下降：分配器没有把页还给操作系统（或碎片）；
- 比值 < 1：**内存被换出到 swap**，性能灾难，必须排查并关闭 swap/调整内存。

### 成因与对策

| 成因 | 对策 |
| --- | --- |
| 频繁增删不同大小的对象、大小分布差异大（尤其大量更新变长 value） | 控制 value 大小分布，减少原地变长更新（如不断 APPEND）；用定长或分桶 |
| 大 key 删除后留下空洞 | 拆大 key；升级到对碎片更友好的分配器版本 |
| **主动碎片整理**（`activedefrag yes`，jemalloc 下可用） | 后台搬迁对象整理碎片；有 CPU 开销，设置触发阈值（`active-defrag-ignore-bytes`、`active-defrag-threshold-lower`）与 CPU 占比上下限；观察对延迟的影响，在低峰启用或灰度 |
| 重启/主从切换回收 | 最彻底：通过**副本切换**滚动重启，让新进程以紧凑方式重新加载数据；注意对业务的影响与全量同步成本 |
| THP（透明大页） | 增加碎片和 fork 延迟，**应关闭**，见 [RDB 与 AOF](#/redis/persistence) |
| overcommit 与 swap | 配置 `vm.overcommit_memory=1`，不要使用 swap |

## 容量模型与成本

### 容量估算

```text
单分片所需内存 ≈ (key 数量 × 平均每 key 占用) × (1 + 碎片系数 ~10%~30%)
                + 复制积压缓冲 + 客户端缓冲 + 预期增长
机器内存    ≥ Σ 各实例 maxmemory（数据）× (1 + COW 余量，写入越活跃越大) + 系统与其他进程
增长预测    : 基于历史 key 数量/内存的月增长率外推，提前 2~3 个月扩容
```

- **平均每 key 占用来自实测**（`MEMORY USAGE` + 画像），不是数据本身大小；
- **COW 余量**：持久化 fork 期间，被修改的页会复制；写入越密集、持续时间越长，需要的额外内存越多（极端接近 2 倍，需要压测确认），关闭持久化的纯缓存副本则少很多；
- 不同业务的**峰值与均值**差异要算；促销前提前扩容与预热。

### 成本核算与分摊

| 做法 | 价值 |
| --- | --- |
| **按业务前缀统计内存与 QPS** | 看清谁占资源，推动整改 |
| **成本分摊（内存 GB × 单价）** | 让业务方有成本意识，主动做 TTL、瘦身 |
| **规格与分层** | 热数据高规格内存；温数据可考虑更便宜的存储（如磁盘型兼容产品、数据库缓存、对象存储），根据延迟要求选择 |
| **缓存命中率与成本** | 命中率提升带来的 DB 压力下降 vs 增加的内存成本，做性价比分析 |
| **副本与备份成本** | 每个分片的副本数、跨可用区复制带宽、备份存储 |
| **云上规格选择** | 单节点大内存 vs 多分片小内存：大内存的 fork/恢复慢，小规格的分片数多、管理复杂，按故障恢复时间权衡 |

## 优化的收益评估与风险

| 优化 | 典型收益 | 风险与前提 |
| --- | --- | --- |
| **补全 TTL/清理僵尸数据** | 常为最大收益且几乎无风险 | 要确认数据确实可过期，分批删除 |
| **小 key 合并为 Hash** | 小 key 场景数倍节省 | 改造读写与删除逻辑；不能单独 TTL；双写迁移 |
| **精简字段/二进制序列化** | 数十个百分点 | 兼容性（新旧格式共存）、Schema 管理 |
| **压缩** | 文本类可降数倍 | CPU 开销、延迟增加；小数据负收益 |
| **调大紧凑编码阈值** | 省内存 | 命令延迟上升（O(N)），需压测 |
| **缩短 key 名** | 海量小 key 时可观 | 可读性下降，需字典文档 |
| **主动碎片整理** | 回收碎片 | CPU 与延迟影响，需灰度 |
| **改用更合适的数据结构（Bitmap/HLL）** | 量级级别节省 | 语义变化（HLL 近似、Bitmap 稀疏） |

**优化流程**：度量画像 → 选 Top 占用的前缀 → 评估方案与收益 → 小范围灰度（双写/新旧结构共存）→ 对比内存与延迟 → 全量 → 清理旧数据；每一步都能回退。

## 常见问题

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 数据量不大但内存很高 | 海量小 key 元数据开销、编码退化为 hashtable、碎片 | 画像分析，小 key 合并，调整编码阈值，查碎片 |
| 删除了大量数据内存不降 | 分配器不归还、碎片 | 主动碎片整理，副本切换重启 |
| `used_memory` 低但 RSS 很高 | 碎片率高、COW 残留 | 同上，关闭 THP |
| 比值 < 1（RSS 小于 used_memory） | 发生 swap | 立即排查并避免 swap，扩容或降低负载 |
| 内存使用率长期上升 | 无 TTL 数据累积、无界集合 | 按前缀整改，设上限与 TTL |
| 淘汰数飙升、命中率下降 | 容量不足或热点变化 | 扩容、优化 TTL、瘦身；评估缓存价值 |
| fork 后内存暴涨被 OOM | COW 放大，机器内存预留不足 | 预留余量，限制写入，错峰持久化，使用副本做持久化 |
| 修改紧凑编码阈值后延迟变差 | 紧凑编码的 O(N) 操作 | 回退阈值，改为拆分 |
| 副本比主节点内存更大/更小 | 复制缓冲、碎片差异、重启后重新加载 | 比较编码与碎片，必要时副本重建 |
| 单分片内存倾斜 | 大 key、hash tag | 见 [大 key 与热 key 治理](#/redis/bigkey)、[Redis Cluster 生产运维](#/redis/cluster-ops) |

## 优化检查清单

- [ ] 是否有按业务前缀的内存画像（key 数、总内存、平均大小、TTL 覆盖率）？
- [ ] 缓存类 key 是否都有 TTL（带抖动），存储类是否有归档与清理策略？
- [ ] 海量小 key 是否合并成了紧凑结构，编码是否符合预期（`OBJECT ENCODING`）？
- [ ] value 是否精简、使用二进制序列化，大文本是否压缩？
- [ ] 是否选用了合适的数据结构（Bitmap/HLL/Stream 等）？
- [ ] `maxmemory` 与淘汰策略是否匹配场景，水位线与淘汰数是否有告警？
- [ ] 是否监控碎片率与 RSS，是否关闭 THP，是否避免 swap？
- [ ] 容量规划是否包含 COW、复制缓冲、客户端缓冲与增长预测？
- [ ] 是否有成本分摊与定期整改机制？

## 相关阅读

- [数据结构与底层编码](#/redis/types)：SDS、dict、listpack、skiplist 的内存特征
- [过期策略与内存淘汰](#/redis/expire)：淘汰算法与碎片整理
- [Redis 大 key 与热 key 治理](#/redis/bigkey)：大对象与集合增长治理
- [Redis Cluster 生产运维](#/redis/cluster-ops)：容量规划与扩缩容
- [RDB 与 AOF](#/redis/persistence)：fork、COW 与 THP

## 面试追问

> [!QUESTION] Redis 内存占用比数据量大很多，原因有哪些？
> 每个 key 有固定元数据开销（字典项、redisObject、SDS 头、过期字典），海量小 key 时开销超过数据本身；集合超过紧凑编码阈值后退化成 hashtable 或 skiplist；分配器碎片和对齐使 RSS 大于 used_memory；还有客户端、复制、AOF 缓冲，以及 fork 的写时复制额外内存。

> [!QUESTION] 如何优化 Redis 内存？
> 先用 INFO MEMORY、MEMORY USAGE 和 RDB 离线分析得到按前缀的内存画像；治理没有 TTL 的数据和僵尸 key；小 key 合并成 Hash 利用紧凑编码；精简字段、用二进制序列化、大文本压缩；选对 Bitmap、HyperLogLog 等结构；限制集合规模；合理设置淘汰策略与水位线。每项优化灰度验证内存与延迟。

> [!QUESTION] 为什么把大量小 String 合并成 Hash 能省内存？有什么限制？
> 每个 String key 都有几十到上百字节的固定开销，合并后多个字段共享一个 key 的开销，且小 Hash 使用 listpack 紧凑编码。限制是桶大小要在编码阈值内，不能对单个字段设置 TTL，整桶操作成本高，并要处理迁移与桶数固定的问题。

> [!QUESTION] mem_fragmentation_ratio 异常说明什么？怎么处理？
> 大于 1.5 说明分配器碎片多，RSS 远超 used_memory；小于 1 说明内存被换出到 swap，会造成严重延迟。处理碎片可启用主动碎片整理（有 CPU 开销需灰度）、控制 value 大小分布、关闭 THP，或通过主从切换重启回收；swap 要立刻排查并避免。

> [!QUESTION] 紧凑编码的阈值调大有什么代价？
> 能让更多集合保持紧凑编码省内存，但紧凑编码是连续数组，查找和修改是 O(N)，元素多时命令变慢并增加重分配成本，所以只能小幅调整并用压测验证延迟，不能无脑调高，大集合更应该拆分。

> [!QUESTION] Redis 容量规划要考虑哪些因素？
> 单分片数据量（用实测每 key 占用而非数据大小）、碎片系数、复制积压与客户端缓冲、持久化 fork 的 COW 余量、增长预测，并保持使用率在 60% 到 70% 以下留扩容时间；机器内存要覆盖所有实例的 maxmemory 加 COW 与系统开销，并设置分级水位告警与按业务的成本分摊。
