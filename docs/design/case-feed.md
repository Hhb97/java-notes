---
level: 高级
tags: [架构案例, Feed流, 信息流, 推拉模式, 写扩散, 读扩散, 大V, 排行榜, Redis ZSET, 热度排序]
summary: 以关注关系的内容社区为例拆解 Feed 流：推模式（写扩散）、拉模式（读扩散）与混合策略的取舍，收件箱的存储与容量、游标分页、关注/取关/删帖的一致性处理、冷用户重建、算法排序的接入点；并给出排行榜的设计：Redis ZSET 实时榜、时间衰减的热度分、周期榜、大榜分片与归并、分数相同的稳定排序与榜单一致性。
---

# 案例：Feed 流与排行榜设计详解

> [!ABSTRACT] 核心要点
> - Feed 流的本质是“**一个人发内容，N 个人在自己的时间线上看到**”，核心矛盾是 **写放大 vs 读放大**：**推模式（写扩散）**发布时写入每个粉丝的收件箱，读快写重；**拉模式（读扩散）**发布只写一份，读时聚合关注者的内容，写轻读重；**混合模式**是工程标准答案——**普通用户推、大 V 拉、活跃粉丝才推**。
> - 收件箱只存**内容 ID + 时间/分数**（轻量），内容详情另取（批量 `mget`）；**只保留最近 N 条（如 1000）**，更老的内容走拉取，容量可控。
> - **分页用游标（上一页最后一条的 ID/分数）而不是页码**，避免新内容插入造成重复/漏看；**取关、删帖、拉黑**要有一致性方案（**读时过滤**比写时回删更可靠）。
> - 排序从“时间倒序”升级到“算法推荐”时，**架构不变**：召回（收件箱/关注/热门）→ 排序 → 重排（打散/去重），Feed 服务只是召回之一。
> - **排行榜**用 **Redis ZSET**：实时榜 `ZINCRBY`，热度榜用**带时间衰减的分数**，周期榜（日/周）按周期 key 滚动；**大榜要分片再归并**，**同分按 ID 稳定排序**，榜单展示容忍最终一致。

> [!NOTE] 说明
> 容量数字均为**用于推演的假设**。IM 的扩散模型与本文同源，可对照阅读 [IM 案例：读扩散与写扩散](#/design/case-im)。

## 一、需求与约束

### 1. 功能

- 发布内容（图文/视频，带媒体地址）、删除；
- **关注/取关**；
- **关注流（Following Feed）**：看我关注的人的内容，时间倒序（后续可叠加推荐）；
- 点赞/评论计数展示（见下，与 Feed 解耦）；
- **排行榜**：热门内容榜、创作者榜（实时/日/周）。

### 2. 非功能与容量估算（假设）

| 维度 | 假设 |
| --- | --- |
| 用户 | DAU 5000 万，日均刷新 Feed 10 次 → **5 亿次/天 ≈ 5800 QPS 平均**，峰值 3~5 倍 ≈ **3 万 QPS** |
| 发布 | 日发布 2000 万条 ≈ 230 条/秒，峰值 1000+/秒 |
| 关注关系 | 平均每人关注 200 人、粉丝 200 人；**长尾**：少数大 V 粉丝数百万~千万 |
| 延迟 | 刷新 Feed P99 < 200ms；发布到粉丝可见：普通 < 5s，大 V 允许十几秒 |
| 存储（收件箱） | 活跃用户 5000 万 × 1000 条 × 16 B（ID + 分数）≈ **800 GB**（Redis 分片集群可承载，需控制活跃用户范围） |

**推扩散的写放大**：一条普通内容推给 200 粉丝 = 200 次写入；一个 1000 万粉丝的大 V 发一条 = **1000 万次写入**，这是不可接受的，必须区别对待。

## 二、推、拉与混合

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="Feed 三种模式：推模式在作者发布时把内容 ID 写入每个粉丝的收件箱，读取只查自己的收件箱，读快但大 V 写放大严重；拉模式发布只写作者自己的发件箱，读取时查询所有关注者的发件箱并归并，写轻读重；混合模式普通作者推到活跃粉丝的收件箱，大 V 只写发件箱，读取时把收件箱与关注的大 V 发件箱归并">
<rect class="b3" x="20" y="20" width="250" height="150" rx="12"/>
<text class="th" x="36" y="44">推（写扩散）</text>
<text class="ts" x="36" y="68">发布 → 写入每个粉丝收件箱</text>
<text class="ts" x="36" y="88">读：只读自己的收件箱</text>
<text class="ts" x="36" y="112">✓ 读极快、实现简单</text>
<text class="ts" x="36" y="132">✗ 大 V 写放大（千万次写）</text>
<text class="ts" x="36" y="152">✗ 浪费：写给了不活跃用户</text>
<rect class="b5" x="290" y="20" width="250" height="150" rx="12"/>
<text class="th" x="306" y="44">拉（读扩散）</text>
<text class="ts" x="306" y="68">发布 → 只写自己的发件箱</text>
<text class="ts" x="306" y="88">读：拉取所有关注者的发件箱归并</text>
<text class="ts" x="306" y="112">✓ 写轻、无写放大</text>
<text class="ts" x="306" y="132">✗ 读放大（关注 N 人 = N 次查）</text>
<text class="ts" x="306" y="152">✗ 读延迟高、热点作者被反复读</text>
<rect class="b2" x="560" y="20" width="220" height="150" rx="12"/>
<text class="th" x="576" y="44">混合（工程标准）</text>
<text class="ts" x="576" y="68">普通作者：推给活跃粉丝</text>
<text class="ts" x="576" y="88">大 V：只写发件箱，读时拉</text>
<text class="ts" x="576" y="112">读：收件箱 + 关注的大 V 归并</text>
<text class="ts" x="576" y="132">✓ 兼顾读写，成本可控</text>
<text class="ts" x="576" y="152">✗ 实现与一致性更复杂</text>
<rect class="bg" x="20" y="190" width="760" height="136" rx="10"/>
<text class="th" x="36" y="214">混合策略的关键决策</text>
<text class="ts" x="36" y="238">• 大 V 阈值：按粉丝数（如 > 10 万）或发布频率动态判定，可配置；阈值附近的作者可“推活跃粉丝子集”</text>
<text class="ts" x="36" y="258">• 只推给活跃粉丝（近 7 天登录），不活跃用户上线时再“按需重建”收件箱，节省大量无效写入</text>
<text class="ts" x="36" y="278">• 读时合并：用户收件箱（按分数排序）与“我关注的大 V 的最近发件箱”做多路归并，再取前 N 条</text>
<text class="ts" x="36" y="298">• 推送异步化：发布后写 MQ，由扩散 Worker 分批写收件箱（大作者分片并行），保证发布接口快速返回</text>
<text class="ts" x="36" y="318">• 与 IM 群聊的“小群写扩散、大群读扩散”是同一类思想</text>
</svg>
<figcaption>图 1：推、拉与混合模式</figcaption>
</figure>

## 三、总体架构

<figure class="fig">
<svg viewBox="0 0 820 400" class="dg" role="img" aria-label="Feed 总体架构：发布服务写内容库并发布发布事件到 MQ；扩散 Worker 消费事件，查询关注关系服务获得粉丝列表，对活跃粉丝写 Redis 收件箱，大 V 只写发件箱；读取时 Feed 服务读收件箱和大 V 发件箱归并，批量查询内容服务获得详情，经过过滤与排序后返回；关注关系、内容、计数分别独立存储">
<rect class="b1" x="20" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b3" x="170" y="20" width="150" height="64" rx="10"/>
<text class="tb" x="245" y="42" text-anchor="middle" dominant-baseline="middle">发布服务</text>
<text class="ts" x="245" y="64" text-anchor="middle">写内容 · 审核 · 发事件</text>
<rect class="b5" x="360" y="20" width="110" height="64" rx="10"/>
<text class="tb" x="415" y="42" text-anchor="middle" dominant-baseline="middle">MQ</text>
<text class="ts" x="415" y="64" text-anchor="middle">发布事件</text>
<rect class="b2" x="510" y="20" width="160" height="64" rx="10"/>
<text class="tb" x="590" y="42" text-anchor="middle" dominant-baseline="middle">扩散 Worker</text>
<text class="ts" x="590" y="64" text-anchor="middle">分批推送收件箱</text>
<line class="l" x1="130" y1="52" x2="170" y2="52" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="52" x2="360" y2="52" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="52" x2="510" y2="52" marker-end="url(#arr)"/>
<rect class="b4" x="700" y="20" width="100" height="64" rx="10"/>
<text class="tb" x="750" y="42" text-anchor="middle" dominant-baseline="middle">关系服务</text>
<text class="ts" x="750" y="64" text-anchor="middle">粉丝/关注</text>
<line class="l" x1="670" y1="52" x2="700" y2="52" marker-end="url(#arr)"/>
<rect class="b3" x="170" y="120" width="150" height="64" rx="10"/>
<text class="tb" x="245" y="142" text-anchor="middle" dominant-baseline="middle">Feed 服务（读）</text>
<text class="ts" x="245" y="164" text-anchor="middle">归并 · 过滤 · 分页</text>
<line class="l" x1="75" y1="74" x2="200" y2="120" marker-end="url(#arr)"/>
<rect class="b5" x="360" y="120" width="150" height="64" rx="10"/>
<text class="tb" x="435" y="142" text-anchor="middle" dominant-baseline="middle">Redis 收件箱</text>
<text class="ts" x="435" y="164" text-anchor="middle">ZSET：ID + 时间</text>
<rect class="b5" x="550" y="120" width="150" height="64" rx="10"/>
<text class="tb" x="625" y="142" text-anchor="middle" dominant-baseline="middle">大 V 发件箱</text>
<text class="ts" x="625" y="164" text-anchor="middle">ZSET / 内容库索引</text>
<line class="l" x1="320" y1="152" x2="360" y2="152" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="152" x2="550" y2="152" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="84" x2="450" y2="120" marker-end="url(#arr)"/>
<rect class="b2" x="170" y="220" width="150" height="50" rx="8"/>
<text class="tb" x="245" y="245" text-anchor="middle" dominant-baseline="middle">内容服务 mget</text>
<rect class="b2" x="360" y="220" width="150" height="50" rx="8"/>
<text class="tb" x="435" y="245" text-anchor="middle" dominant-baseline="middle">计数服务</text>
<rect class="b2" x="550" y="220" width="150" height="50" rx="8"/>
<text class="tb" x="625" y="245" text-anchor="middle" dominant-baseline="middle">用户信息缓存</text>
<line class="l" x1="245" y1="184" x2="245" y2="220" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="290" width="780" height="92" rx="10"/>
<text class="ts" x="36" y="314">• 读路径：取收件箱一页 ID → 与大 V 发件箱归并 → 批量取内容/计数/作者信息 → 过滤（已删除、已拉黑、不可见）→ 返回</text>
<text class="ts" x="36" y="334">• 内容、关系、计数、收件箱独立存储与扩缩容；Feed 服务无状态；列表只带 ID，详情走各自缓存（多级缓存同短链案例）</text>
<text class="ts" x="36" y="354">• 推荐接入：召回（收件箱/热门/兴趣）→ 粗排 → 精排 → 重排（打散、去重、保量），Feed 服务只是召回源之一</text>
<text class="ts" x="36" y="372">• 点赞/评论数独立计数服务（Redis + 异步落库），不要塞进收件箱，避免写放大</text>
</svg>
<figcaption>图 2：Feed 流总体架构</figcaption>
</figure>

## 四、核心设计

### 1. 数据模型

```sql
-- 内容主表（按 author_id 或 post_id 分片）
CREATE TABLE post (
  post_id BIGINT PRIMARY KEY,           -- 雪花 ID，趋势递增，天然可按时间排序
  author_id BIGINT NOT NULL, content TEXT, media JSON, status TINYINT, created_at DATETIME(3),
  KEY idx_author_time (author_id, post_id DESC)         -- 发件箱：作者的内容按时间倒序
);
-- 关注关系（双向各存一份，便于查关注与查粉丝）
CREATE TABLE follow   (user_id BIGINT, target_id BIGINT, created_at DATETIME, PRIMARY KEY (user_id, target_id));
CREATE TABLE follower (target_id BIGINT, user_id BIGINT, created_at DATETIME, PRIMARY KEY (target_id, user_id));
```

**收件箱（Redis ZSET）**：`inbox:{userId}` → member = `postId`，score = `postId` 或时间戳（雪花 ID 本身随时间递增，可直接作分数）：

```text
ZADD    inbox:10086 <score> <postId>          -- 扩散 Worker 写入
ZREMRANGEBYRANK inbox:10086 0 -1001           -- 只保留最近 1000 条（按分数从低到高，删除最老的）
ZREVRANGEBYSCORE inbox:10086 (<cursor> -inf LIMIT 0 20   -- 游标分页：取比游标更老的 20 条
```

### 2. 游标分页（不用页码）

- 客户端请求带上**上一页最后一条的 score（或 postId）**作为游标；服务端取“比它更老”的 N 条；
- **页码分页的问题**：翻页期间有新内容插入，第二页会出现第一页末尾的重复项；
- 首次/下拉刷新：取**最新**（`ZREVRANGE 0 N-1`）或“比客户端已有最新游标更新”的增量（用于“有 N 条新内容”提示）。

### 3. 扩散 Worker

```java
@KafkaListener(topics = "post.published", groupId = "feed-fanout")
public void onPublished(PostPublished e) {
    if (relation.followerCount(e.authorId()) > BIG_V_THRESHOLD) return;        // 大 V：只写发件箱（内容库索引），不推
    long cursor = 0;
    while (true) {
        List<Long> fans = relation.activeFollowers(e.authorId(), cursor, 500);   // 分批取（仅近期活跃的粉丝）
        if (fans.isEmpty()) break;
        redis.executePipelined(pipe -> fans.forEach(f -> {                       // pipeline 批量写，降低 RTT
            pipe.zAdd("inbox:" + f, e.postId(), String.valueOf(e.postId()));
            pipe.zRemRangeByRank("inbox:" + f, 0, -1001);
        }));
        cursor = fans.get(fans.size() - 1);
    }
}
```

- **分批 + pipeline + 并行**；大作者（如 5 万粉丝以上但未到大 V）分片给多个 Worker；
- **幂等**：`ZADD` 同 member 重复写是幂等的；消息重复消费无副作用；
- **失败重试**：按批重试，Worker 崩溃后从游标恢复（扩散进度可持久化）；
- **限速**：避免一次大作者发布把 Redis 打满，按集群容量限速。

### 4. 读取与归并

```java
public FeedPage feed(long userId, Long cursor, int size) {
    List<Long> inbox = redis.zRevRangeByScoreIds("inbox:" + userId, cursor, size + 10);       // 多取一点，补偿过滤
    List<Long> bigV  = relation.followedBigVs(userId);                                         // 缓存的“我关注的大 V 列表”
    List<Long> fromBigV = outboxService.latestOf(bigV, cursor, size);                          // 每个大 V 取最近若干条（带本地缓存）
    List<Long> merged = mergeByIdDesc(inbox, fromBigV, size + 10);                             // 多路归并
    List<Post> posts = contentService.mget(merged);                                            // 批量取详情
    posts.removeIf(p -> !visible(userId, p));                                                  // 读时过滤：已删除、拉黑、隐私
    return page(posts, size);                                                                  // 取前 size，生成下一页游标
}
```

### 5. 取关、删帖、拉黑：读时过滤优于写时回删

| 场景 | 写时处理（回删收件箱） | 读时过滤（推荐） |
| --- | --- | --- |
| **取关** | 要从收件箱里删除该作者全部内容：需要扫描，成本高且易漏 | 读取时检查“作者是否仍在我的关注里”（关注列表缓存）→ 过滤 |
| **删帖** | 要从所有粉丝收件箱删除：写放大同样巨大 | 读取详情时 `status` 已删除即过滤；收件箱里残留的 ID 自然被淘汰 |
| **拉黑/隐私变更** | 难以全量更新 | 读时按最新规则过滤 |

代价：读时多一步判断 + 可能不足一页（所以多取一些候选再补齐）；收益：**简单、可靠、写路径不放大**。

### 6. 冷用户与收件箱重建

- 不活跃用户不被推送；其收件箱可能为空或过期；
- **登录/刷新时发现收件箱缺失**：从“关注列表 → 每个关注者的发件箱最近内容”**拉取重建**（限制关注数与条数、异步重建，先返回已有部分）；
- 收件箱设置 TTL（如 30 天未访问自动过期，节省内存）。

### 7. 一致性与可用性

- **发布 → 粉丝可见**允许秒级延迟（最终一致）；作者本人立即可见自己的内容（读自己的写：作者查看时合并自己的发件箱）；
- Redis 故障：**降级为拉模式**（直接读关系与发件箱，延迟升高但可用），同时限流；收件箱可由发件箱重建，所以**收件箱视为可丢失的缓存**，数据以内容库为准；
- 热点作者发件箱缓存、内容详情多级缓存（见 [缓存设计](#/redis/cache)）。

## 五、从时间线到推荐

纯时间倒序在内容丰富后体验差。常见演进：

1. **召回**：关注流（收件箱 + 大 V）、兴趣/热门/同城等多路召回，各产出几百候选；
2. **排序**：粗排（轻量模型）→ 精排（点击率、停留、互动预估），特征来自用户画像与内容特征；
3. **重排**：多样性打散（同作者/同类型不连续）、去重（已读过滤）、置顶/运营位、**保量**（新作者冷启动曝光）；
4. **已读过滤**：布隆过滤器或已读集合，避免重复推荐；
5. **反馈闭环**：曝光/点击/停留日志 → 近线特征与模型更新；A/B 实验评估。

架构上 Feed 服务从“读收件箱”变成“**召回编排 + 调用排序服务**”，收件箱仍是关注流召回的一路。

## 六、排行榜设计

### 1. 基本：Redis ZSET

```text
ZINCRBY rank:post:hot  1  post:123          -- 事件发生时累加分数
ZREVRANGE rank:post:hot 0 9 WITHSCORES      -- Top 10
ZREVRANK rank:post:hot post:123             -- 某内容当前排名（0 起）
ZSCORE   rank:post:hot post:123             -- 分数
```

ZSET 底层是**跳表 + 哈希表**：按分数范围/排名查询 O(log n + m)，更新 O(log n)，见 [复杂度与核心数据结构](#/cs/algo-ds)、[Redis 数据结构](#/redis/types)。

### 2. 常见榜单类型

| 类型 | 做法 |
| --- | --- |
| **累计榜**（总销量、总粉丝数） | 单个 key 持续 `ZINCRBY` |
| **周期榜**（日榜/周榜/月榜） | **按周期拆 key**：`rank:post:20261012`；过期时间设为周期 + 保留期；周榜/月榜可由日榜 `ZUNIONSTORE` 合并（带权重） |
| **热度榜**（时间衰减） | 分数 = f(互动, 时间)：见下 |
| **实时榜** | 事件流（Flink）聚合后批量写入 ZSET，或消费者直接 `ZINCRBY` |
| **用户维度榜**（我的好友榜） | 好友范围小：拉取好友分数后内存排序，或为每个用户维护好友榜（小规模） |

### 3. 热度分与时间衰减

让“新内容被互动”比“旧内容很久前的高赞”权重更大：

- **Hacker News 式**：`score = (points - 1) / (age_hours + 2)^gravity`（gravity 约 1.5~1.8）——随时间平滑衰减；
- **指数衰减累计（推荐用于实时榜）**：存储 `score = log2(weight) + ts / halfLife` 的形式，**新事件的增量天然比旧事件大**，写入时只需 `ZADD`/`ZINCRBY` 一个数，**不需要后台任务给所有元素重新衰减**（实现要点：把“当前时间的权重基准”折算进分数，读取时按相同基准比较）；
- 互动加权：`分数 = 点赞×1 + 评论×3 + 分享×5 + 完播…`，权重由业务与实验决定；
- **防刷**：同用户对同内容限一次、异常账号/设备降权、IP 频控，刷榜是榜单的天然对手。

### 4. 大榜与分片

- 单个 ZSET 过大（千万成员）会有**大 Key 问题**（阻塞、迁移困难，见 [Redis 数据结构：大 Key](#/redis/types)）；
- **分片榜 + 归并**：按 `hash(id) % N` 分成 N 个 ZSET，各分片取 Top K，**再在应用层归并**得到全局 Top K（K 小，通常只展示前 100）；
- **只维护 Top N**：写入后若成员数超过阈值，`ZREMRANGEBYRANK` 剪掉尾部（长尾内容不关心排名）；
- 全量精确排名（“你排第 123456 名”）用分段近似或离线计算，实时场景提供“前 1000 精确 + 其余区间”。

### 5. 稳定排序与分页

- **同分如何排序**：分数相同时 ZSET 按 member 字典序，结果依赖 ID 格式，不直观——应把**时间或 ID 编码进分数的小数部分**（如 `score = 热度 + 1 - postId/1e18`）保证稳定、可复现；
- **分页**：榜单分页基于排名区间 `ZREVRANGE start stop`；翻页期间榜单变化会导致重复/漏项，榜单类场景通常**接受**，或对“当前榜单快照”做 TTL 缓存（如 1 分钟）保证翻页一致；
- **榜单快照**：定时（如每分钟）把 Top N 落一份快照，用于详情展示、对账与历史回看。

### 6. 数据一致性与持久化

- 榜单是**派生数据**，真值在明细/事件（Kafka、ClickHouse、业务库）。Redis 丢失可由事件**重放重建**，所以榜单**不要求强一致**；
- 重要榜单（奖励结算）用**离线精确计算**为准，实时榜只用于展示；
- 避免“先读榜再根据榜发奖”的竞态：结算在统一的周期截止点，用快照。

## 七、点赞、评论等计数

与 Feed 解耦，单独的**计数服务**：

- 热点内容的点赞数短时间内极高写入：**Redis `INCR` + 定时批量异步落库**（合并写，保留最近若干秒的内存聚合）；
- 点赞关系（谁赞了谁）用于判断“我是否已点赞”：存 MySQL（`like(user_id, post_id)` 唯一键防重复），热点内容用 Redis Set/Bitmap 加速；
- 计数展示容忍短暂不一致，定时对账修正；
- 防止“重复点赞/取消”并发：以关系表为准（`INSERT` 唯一键冲突即已点赞），计数由事件驱动更新。

## 八、容量、可用性与监控

| 维度 | 要点 |
| --- | --- |
| **容量** | 收件箱按活跃用户数 × 条数估算内存；大作者扩散的瞬时写峰；Redis 分片数与带宽；内容库分片 |
| **降级** | Redis 故障降级拉模式；扩散积压时优先保证活跃用户与关注强度高的粉丝；推荐服务故障回退时间线 |
| **扩散延迟** | 监控“发布 → 收件箱可见”P99、MQ 积压；大 V 发布的专门通道 |
| **缓存命中率** | 收件箱命中率、内容/用户详情缓存命中率；冷启动预热 |
| **一致性对账** | 抽样比较发件箱与收件箱；点赞计数对账 |
| **指标** | Feed 刷新 QPS/P99、归并耗时、过滤后不足页的比例、Worker 吞吐、Redis 内存与大 Key；见 [指标监控](#/infra/obs-metrics) |
| **压测** | 大 V 发布瞬间扩散、热点内容读取、收件箱缺失重建，见 [压测与容量规划](#/design/eng-loadtest) |

## 九、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 推 vs 拉 | 混合：普通推、大 V 拉、仅推活跃 | 实现复杂；阈值需要运营调优 |
| 写时回删 vs 读时过滤 | 读时过滤 | 读多一步；可能不足一页需补齐 |
| 收件箱存全文 vs 存 ID | 存 ID | 读时要批量取详情（缓存化） |
| 强一致 vs 最终一致 | 最终一致；作者读自己的写 | 粉丝可见有秒级延迟 |
| 页码 vs 游标 | 游标 | 不能随意跳页（Feed 场景无需） |
| 榜单精确 vs 近似 | Top N 精确，长尾近似；展示榜容忍最终一致 | 个别排名有延迟 |

## 相关阅读

- [案例：LBS 附近的人与打车派单设计详解](#/design/case-lbs)：空间索引与附近查询

## 面试追问

> [!QUESTION] Feed 流用推模式还是拉模式？为什么要混合？
> 推模式发布时写每个粉丝收件箱，读快但大 V 发一条要写千万次，写放大不可接受，也浪费在不活跃用户上；拉模式写轻但读时要聚合所有关注者，读放大和延迟高。混合策略普通作者推给活跃粉丝，大 V 只写发件箱，读取时把用户收件箱与其关注的大 V 发件箱归并，不活跃用户上线时再重建收件箱。

> [!QUESTION] 取关或删帖后，已经推到收件箱的内容怎么处理？
> 采用读时过滤而不是写时回删：读取时按最新的关注关系、内容状态和拉黑规则过滤，收件箱里残留的 ID 自然被淘汰。回删需要扫描所有粉丝的收件箱，写放大巨大且容易遗漏。代价是读时多一步判断，多取一些候选以补足页面。

> [!QUESTION] Feed 为什么用游标分页而不是页码？
> 翻页期间有新内容插入，页码分页会让下一页出现上一页末尾的重复项。游标分页用上一页最后一条的分数或 ID 作为起点取更老的数据，不受新增影响，并且基于 ZSET 范围查询效率稳定。

> [!QUESTION] 收件箱用什么存？怎么控制容量？
> 用 Redis ZSET 存内容 ID 和分数，分数用雪花 ID 或时间戳，只保留最近约一千条，写入时用 ZREMRANGEBYRANK 裁剪，更老的内容走拉取；不活跃用户设置过期，登录时从关注者发件箱重建；收件箱视为可丢失的缓存，真值在内容库。

> [!QUESTION] 设计一个热门排行榜，要考虑什么？
> 用 Redis ZSET，实时事件 ZINCRBY；热度要带时间衰减，可用指数衰减的分数形式避免后台重算；周期榜按周期拆 key 并用 ZUNIONSTORE 合并；大榜分片后各取 Top K 再归并，只维护 Top N；同分用时间或 ID 编码进小数位保证稳定；防刷；榜单是派生数据，可由事件重建，不要求强一致，结算类用离线精确计算。

> [!QUESTION] 点赞数怎么设计才能扛住热点？
> 计数独立于 Feed，用 Redis INCR 做内存聚合，定时批量异步落库；点赞关系用唯一键保证幂等；展示容忍短暂不一致并定期对账；热点内容可做本地合并写，避免单 key 过热。
