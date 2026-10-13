---
level: 高级
tags: [架构案例, 高并发写, 热点, 计数器, 点赞, 库存扣减, 抢红包, 热点行, 分段计数, 合并写, 削峰, 对账]
summary: 针对“大量并发写同一份数据”的热点写问题，给出通用方法论与三个典型场景的完整设计：计数类（点赞/浏览/关注数）的 Redis 计数 + 异步落库 + 去重与对账；库存扣减的条件更新、分段库存与排队合并；抢红包的预拆分、Lua 原子领取、领取与入账解耦与账户热点处理。并总结数据库与 Redis 的写优化手段、一致性与幂等、压测与监控、常见坑。
---

# 案例：高并发写入与热点治理（计数、库存、红包）

> [!ABSTRACT] 核心要点
> - 高并发**读**可以靠缓存和副本横向扩展，**高并发写同一份数据**则不行：**写必须串行化到同一个“权威位置”**，吞吐受**热点行锁/单 Key 单线程/单分片**限制。治理热点写的总思路是：**“把一次写变成多次分散的写，或把多次写合并成一次写”**。
> - **六把武器**：① **拆分**（分段计数/分段库存/子账户，把热点拆成 N 个）；② **合并**（内存聚合、批量刷盘、Group Commit）；③ **异步**（MQ 削峰，先接受后处理）；④ **预分配**（红包预拆分、库存预热，运行时只做轻量领取）；⑤ **串行化**（按 Key 路由到单线程/单分区，消除锁竞争）；⑥ **降级与限流**（保护核心，丢弃可丢的）。
> - **计数类**：Redis `INCR` 抗热点 + **异步批量落库** + **去重（Set/Bitmap/HLL）** + 定期对账；允许**短暂不精确**。
> - **库存类**：数据库用**条件更新**防超卖；热点 SKU 用**分段库存**、**Redis 预扣 + 异步落库**、**排队合并**；以账为准、定期对账。
> - **红包类**：**预拆分金额存 Redis List + Lua 原子领取 + 防重复**；**“抢到”与“到账”解耦**（先流水后汇总）；**热点账户（商家/主播）拆子账户或批量入账**。
> - **一致性靠幂等 + 对账**：所有异步环节都必须可重试、幂等；最终以数据库/账务为准，定期校验修正。

> [!NOTE] 说明
> 容量数字均为用于推演的**假设**。秒杀的完整链路见 [秒杀系统设计](#/design/seckill)，本文提炼其中的**热点写通用方法**并扩展到更多场景；订单/账务一致性见 [订单支付案例](#/design/case-payment)；削峰与幂等见 [事件驱动架构](#/design/event-driven)。

## 一、为什么“热点写”这么难

### 1. 物理瓶颈

| 层 | 为什么串行 | 典型上限 |
| --- | --- | --- |
| **MySQL InnoDB 行锁** | 同一行的更新必须互斥，事务持锁到提交；后来的事务排队等锁，**锁持有时间 = 事务时长（含网络往返）** | 单行热点 TPS 常只有数百~一两千（取决于事务长度与 RTT） |
| **Redis 单 Key** | 单线程命令执行，单 Key 只在一个分片上；大 Value 或慢命令阻塞 | 单 Key 约 10 万量级 OPS（简单命令），受网络与实例限制，见 [Redis 线程模型](#/redis/overview) |
| **单个分区/Leader** | Kafka 同分区单消费者、Raft 组单 Leader、ES 单分片写入 | 受分区/分片内串行限制 |
| **单文件/单日志** | 顺序写日志的 `fsync` | 组提交可摊薄 |

**行锁的“锁持有时间”公式**：同一行最大吞吐 ≈ `1 / 单事务持锁时间`。若事务里包含 1 次 RTT（0.5ms）+ 数据库执行（0.3ms）+ 提交刷盘（0.5ms）≈ 1.3ms，则单行上限 ≈ **700 TPS**。**缩短事务、减少持锁时间、合并更新**都是在抬高这条上限。

### 2. 典型热点场景

| 场景 | 热点对象 | 特征 |
| --- | --- | --- |
| 点赞/浏览/播放数 | 某条爆款内容的计数 | 写极高、**允许近似/延迟** |
| 热门商品库存 | 单个 SKU 的库存行 | 写高、**必须精确不超卖** |
| 抢红包/抽奖 | 同一个红包的剩余额度 | 写极高、**强一致领取 + 金额正确** |
| 商家/主播账户余额 | 收款账户的余额行 | 持续高写、**资金必须准确** |
| 排行榜分数 | 热榜的 ZSET 成员 | 写高、允许近似 |
| 秒杀/抢票 | 库存 + 已购标记 | 瞬时洪峰 |
| 日志/埋点/时序 | 无热点但吞吐极大 | 批量与顺序写 |

## 二、通用方法论

<figure class="fig">
<svg viewBox="0 0 820 400" class="dg" role="img" aria-label="热点写治理六种手段：拆分把一个热点拆成多个分片分散写入；合并在内存聚合后批量写一次；异步用消息队列削峰先接受后处理；预分配提前准备好资源运行时只做轻量领取；串行化按键路由到单线程避免锁竞争；限流降级保护核心丢弃可丢弃的请求；这些手段常组合使用并以幂等和对账保证最终正确">
<rect class="b3" x="20" y="30" width="250" height="110" rx="12"/>
<text class="th" x="36" y="54">① 拆分（Sharding the hot key）</text>
<text class="ts" x="36" y="78">热点 → N 个子 Key / 子行 / 子账户</text>
<text class="ts" x="36" y="98">写时随机或哈希选一个，读时汇总</text>
<text class="ts" x="36" y="118">✓ 并行度 ×N　✗ 读汇总、均衡难</text>
<rect class="b5" x="290" y="30" width="250" height="110" rx="12"/>
<text class="th" x="306" y="54">② 合并（Batch / Coalesce）</text>
<text class="ts" x="306" y="78">内存聚合 N 次 → 1 次落库</text>
<text class="ts" x="306" y="98">Group Commit、定时 flush</text>
<text class="ts" x="306" y="118">✓ 大幅降写压力　✗ 宕机丢聚合</text>
<rect class="b2" x="560" y="30" width="240" height="110" rx="12"/>
<text class="th" x="576" y="54">③ 异步（Queue / 削峰）</text>
<text class="ts" x="576" y="78">先接受入队，后台匀速处理</text>
<text class="ts" x="576" y="98">把尖峰抹平成平均</text>
<text class="ts" x="576" y="118">✓ 抗尖峰　✗ 结果延迟、幂等</text>
<rect class="b1" x="20" y="160" width="250" height="110" rx="12"/>
<text class="th" x="36" y="184">④ 预分配（Pre-allocate）</text>
<text class="ts" x="36" y="208">红包预拆分、库存预热、ID 号段</text>
<text class="ts" x="36" y="228">运行时只做原子“领取”</text>
<text class="ts" x="36" y="248">✓ 热路径极轻　✗ 前置准备与回收</text>
<rect class="b4" x="290" y="160" width="250" height="110" rx="12"/>
<text class="th" x="306" y="184">⑤ 串行化（Single writer）</text>
<text class="ts" x="306" y="208">按 Key 路由到同一线程/分区</text>
<text class="ts" x="306" y="228">无锁、无事务冲突</text>
<text class="ts" x="306" y="248">✓ 简单正确　✗ 单点吞吐上限</text>
<rect class="b3" x="560" y="160" width="240" height="110" rx="12"/>
<text class="th" x="576" y="184">⑥ 限流 / 降级</text>
<text class="ts" x="576" y="208">超容量直接拒绝、排队</text>
<text class="ts" x="576" y="228">非核心写直接丢弃或采样</text>
<text class="ts" x="576" y="248">✓ 保核心　✗ 部分用户受影响</text>
<rect class="bg" x="20" y="290" width="780" height="96" rx="10"/>
<text class="th" x="36" y="314">选择顺序（经验）</text>
<text class="ts" x="36" y="338">• 先问：能不能不精确？能 → 合并 + 异步（计数）；必须精确 → 拆分/预分配/串行化（库存、红包、金额）</text>
<text class="ts" x="36" y="358">• 再问：是否有读写分离的余地？写入侧用最便宜的权威（Redis/内存/日志），落库侧做批量与异步</text>
<text class="ts" x="36" y="378">• 无论哪种：幂等 + 对账是底线；压测验证拐点（见 压测与容量规划），并准备降级开关</text>
</svg>
<figcaption>图 1：热点写治理的六种手段</figcaption>
</figure>

## 三、场景一：计数（点赞 / 浏览 / 关注数）

### 1. 需求与估算（假设）

- 全站日均 20 亿次点赞事件，峰值 **20 万 QPS**；单条爆款内容瞬时 **2 万 QPS** 点赞；
- 展示点赞数允许秒级延迟，**短暂不精确可接受**；但**不能重复点赞**、**取消点赞要扣减**、最终数据要准确。

### 2. 架构

<figure class="fig">
<svg viewBox="0 0 820 340" class="dg" role="img" aria-label="点赞计数架构：用户点赞请求先经去重判断，使用 Redis Set 或 Bitmap 或数据库唯一键确认是否已赞；通过后对 Redis 计数器 INCR 并立即返回，同时写入消息队列；消费者批量聚合同一内容的增量后更新数据库计数；点赞关系表有唯一键保证幂等；定时对账用关系表重算计数修正 Redis 与数据库；读取计数优先读 Redis，未命中回源">
<rect class="b1" x="20" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="55" text-anchor="middle" dominant-baseline="middle">点赞请求</text>
<rect class="b3" x="160" y="20" width="150" height="70" rx="10"/>
<text class="tb" x="235" y="42" text-anchor="middle" dominant-baseline="middle">去重判断</text>
<text class="ts" x="235" y="64" text-anchor="middle">Set / Bitmap / 唯一键</text>
<line class="l" x1="130" y1="55" x2="160" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="340" y="20" width="150" height="70" rx="10"/>
<text class="tb" x="415" y="42" text-anchor="middle" dominant-baseline="middle">Redis 计数</text>
<text class="ts" x="415" y="64" text-anchor="middle">INCR（可分段）</text>
<line class="l" x1="310" y1="55" x2="340" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="520" y="20" width="130" height="70" rx="10"/>
<text class="tb" x="585" y="42" text-anchor="middle" dominant-baseline="middle">MQ 事件</text>
<text class="ts" x="585" y="64" text-anchor="middle">点赞/取消</text>
<line class="l" x1="490" y1="55" x2="520" y2="55" marker-end="url(#arr)"/>
<rect class="b4" x="680" y="20" width="120" height="70" rx="10"/>
<text class="tb" x="740" y="42" text-anchor="middle" dominant-baseline="middle">聚合消费者</text>
<text class="ts" x="740" y="64" text-anchor="middle">按内容合并</text>
<line class="l" x1="650" y1="55" x2="680" y2="55" marker-end="url(#arr)"/>
<rect class="b2" x="520" y="120" width="130" height="56" rx="8"/>
<text class="tb" x="585" y="142" text-anchor="middle" dominant-baseline="middle">关系表</text>
<text class="ts" x="585" y="162" text-anchor="middle">(user,item) 唯一</text>
<rect class="b3" x="680" y="120" width="120" height="56" rx="8"/>
<text class="tb" x="740" y="142" text-anchor="middle" dominant-baseline="middle">计数表</text>
<text class="ts" x="740" y="162" text-anchor="middle">批量 +N</text>
<line class="l" x1="740" y1="90" x2="740" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="90" x2="585" y2="120" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="196" width="780" height="128" rx="10"/>
<text class="th" x="36" y="220">要点</text>
<text class="ts" x="36" y="244">• 写路径：去重 → Redis 原子 INCR → 发事件即返回；用户先看到数字变化（乐观展示）</text>
<text class="ts" x="36" y="264">• 落库：消费者按内容聚合一个时间窗（如 1 秒）内的增量，一条 UPDATE count=count+N，写压力降低数百倍</text>
<text class="ts" x="36" y="284">• 关系表（谁赞了什么）由唯一键 (user_id,item_id) 保证幂等，是计数的“事实来源”</text>
<text class="ts" x="36" y="304">• 对账：定时按关系表重算（或抽样校验），修正 Redis 与数据库计数的漂移</text>
</svg>
<figcaption>图 2：点赞计数：去重、Redis 计数、异步聚合落库、对账</figcaption>
</figure>

### 3. 关键设计

**① 去重（防重复点赞）**

| 方案 | 说明 | 适用 |
| --- | --- | --- |
| **数据库唯一键** | `INSERT ... (user_id, item_id)` 唯一冲突即已赞 | 最可靠，作为事实来源；热点内容的关系表写入也很高 → 分库分表（按 item 或 user） |
| **Redis Set** | `SADD like:{item} userId`，返回 0 表示已存在 | 单内容点赞者很多时 Set 巨大（大 Key），需分片或改用 Bitmap |
| **Redis Bitmap** | 用户 ID 连续整数时，`SETBIT like:{item} uid 1`，`BITCOUNT` 得计数 | 极省内存；ID 稀疏则浪费（见 [工程中的算法：位图](#/cs/algo-engineering)） |
| **布隆过滤器** | 有极小误判（把“没赞过”判为“已赞过”，误拒） | 仅适合“宁可漏赞不可重复”的场景，一般不用于点赞 |
| **HyperLogLog** | 只统计 **UV 去重数**，不能判断某用户是否已赞 | 浏览 UV，不用于点赞去重 |

**② 计数原子与幂等**：

```text
-- Lua：用户 uid 对内容 item 点赞（原子：判断+记录+计数）
if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then        -- KEYS[1]=like:{item}，ARGV[1]=uid
  redis.call('INCR', KEYS[2])                             -- KEYS[2]=like_cnt:{item}
  return 1                                                -- 新增成功
end
return 0                                                  -- 已赞过
```

取消点赞对称：`SREM` 成功才 `DECR`。**所有写 Redis 的同时发 MQ 事件**，由消费者落关系表与计数表（事件携带 `eventId` 保证消费幂等）。

**③ 热点 Key 的计数拆分（分段计数）**

单个爆款内容的计数 Key 成为 Redis 单 Key 热点：

```text
INCR like_cnt:{item}:{rand(0..N-1)}                       -- 写：随机落到 N 个子计数器之一（如 N=16）
GET  like_cnt:{item}:0 … :15  再求和                       -- 读：汇总（可缓存汇总结果几秒）
```

分段后写并行度 ×N，读多 N 次（`MGET` 一次）；N 按热度**动态调整**（普通内容 1 段，爆款自动升到 16 段）。

**④ 本地聚合（应用层合并）**

应用实例内存里按 `itemId` 聚合 `+1`，每 200ms 批量 `INCRBY` 一次 Redis——Redis 写压力降到 `实例数 × 5` 次/秒/内容。**风险**：实例宕机丢失未刷出的增量（≤200ms 的数据）；对点赞类通常可接受，需要精确时落 MQ。

**⑤ 读取**：读 Redis 计数（未命中回源数据库并回填）；**列表页批量 `MGET`**；展示时可做“**近似显示**”（>1 万显示“1.2 万”）减少精确读的压力。

### 4. 落库与对账

- **聚合消费者**：按 `itemId` 分区（Kafka key = itemId，同内容事件进同一分区、同一消费者），内存中聚合一个窗口的增量，`UPDATE item_stat SET like_cnt = like_cnt + ? WHERE id = ?`；
- **幂等**：用 `eventId` 去重（去重表/`processed_event`，见 [事件驱动：幂等消费](#/design/event-driven)），或设计成可重算（增量事件 + 对账修正）；
- **对账**：定时用关系表 `COUNT(*)` 校验热点与抽样内容，差异大的修正 Redis 与数据库（**以关系表为准**）；Redis 重启/数据丢失可由关系表重建；
- **降级**：Redis 故障时，写路径降级为“只写关系表（异步消息）+ 展示旧计数”；MQ 积压时丢弃“纯展示类”增量（浏览数）而保留“业务类”（点赞关系）。

### 5. 其他计数的差异

| 计数 | 去重需求 | 精度 | 方案 |
| --- | --- | --- | --- |
| **点赞/收藏** | 必须（用户级） | 最终精确 | 关系表 + Redis Set/Bitmap + 异步聚合 |
| **浏览数（PV）** | 不去重 | 近似即可 | 本地聚合 + 批量 INCRBY；采样 |
| **UV** | 去重 | 近似（±1%） | **HyperLogLog**（`PFADD`/`PFCOUNT`）；精确用 Bitmap |
| **关注数/粉丝数** | 必须 | 精确（重要） | 关系表 + 计数缓存；大 V 粉丝数拆分、异步更新 |
| **库存/余额** | — | **精确** | 见下文，不能用近似手段 |
| **实时在线人数** | 去重（用户/设备） | 近似 | 心跳上报 + HLL/分片计数（见 [直播案例](#/design/case-live)） |

## 四、场景二：库存扣减

### 1. 基础：数据库条件更新

```sql
-- 单条原子 SQL，既扣减又防超卖：影响行数为 0 表示库存不足
UPDATE sku_stock SET qty = qty - #{n}, version = version + 1
 WHERE sku_id = #{sku} AND qty >= #{n};
```

- 比 `SELECT` 后再 `UPDATE` 安全（避免并发读到相同库存），不需要显式锁；
- 配合**幂等**：扣减记录表 `(order_no, sku)` 唯一键，重试不重复扣；
- **事务要短**：库存扣减 + 订单插入尽量放在同一本地事务但**不要夹杂远程调用**（持锁时间 = 事务时长，见上文行锁公式）。

### 2. 热点 SKU 的演进路径

| 阶段 | 方案 | 吞吐 | 说明 |
| --- | --- | --- | --- |
| **L1** | 数据库条件更新 | 单行数百~上千 TPS | 普通商品足够 |
| **L2** | **分段库存**：把一个 SKU 的库存拆成 N 行（`sku_stock_0..N`，每行 qty/N），扣减时按用户/随机选一行，**该行不足则尝试其他行** | ×N | 并行度提升；**尾部库存碎片**（剩余几件分散在各段，要有“合并/重新均衡”逻辑）；N 个子库存总和 = 真实库存 |
| **L3** | **Redis 预扣 + 异步落库** | Redis 数万~十万 OPS | Lua 原子 `DECRBY`（不足不扣），成功后异步落库；以 Redis 为运行时权威，数据库为最终权威 + 对账（秒杀方案，见 [秒杀系统](#/design/seckill)） |
| **L4** | **排队/合并（Group Commit）**：同一 SKU 的扣减请求在应用层/数据库中间件**排队，一批合并成一次 UPDATE**（`qty = qty - 批总数`，再按顺序分配成败） | 可达数万 | 如 InnoDB 热点行优化（排队更新）思路；实现复杂，需要精确的成功/失败分配 |
| **L5** | **库存服务单线程化（Actor / 按 SKU 分区串行）** | 内存级 | 同一 SKU 的请求路由到同一实例单线程处理，内存扣减 + 日志（WAL）持久化；类似交易撮合系统 |

### 3. Redis 预扣的完整语义

```lua
-- KEYS[1]=stock:{sku}  KEYS[2]=bought:{sku}（已购用户集合）  ARGV[1]=uid  ARGV[2]=n
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return -2 end      -- 重复购买（限购）
local s = tonumber(redis.call('GET', KEYS[1]) or '0')
if s < tonumber(ARGV[2]) then return -1 end                               -- 库存不足
redis.call('DECRBY', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
```

- 返回成功后：**发 MQ 创建订单（异步落库）**；订单失败/超时取消 → **回补**（`INCRBY` + 移除已购标记），回补必须**幂等**（按订单号去重）；
- **库存预热**：活动前把库存加载到 Redis；**Redis 与数据库的对账**（定时比对“Redis 剩余 + 已创建订单占用 = 总库存”）；
- **Redis 故障**：不可用时降级为数据库条件更新 + 限流（容量下降），不能放开超卖；持久化（AOF）与主从切换丢数据风险要由对账兜底（见 [Redis 分布式锁：主从丢失](#/redis/lock)）。

### 4. 库存的其他要点

- **不要用分布式锁串行扣减**：吞吐受锁限制，且锁本身是新的故障点（见 [Redis 分布式锁](#/redis/lock)）；
- **预占与确认**：下单“预占库存”，支付成功“确认扣减”，超时未支付“释放”——对应订单状态机（见 [订单支付案例](#/design/case-payment)）；
- **超卖 vs 少卖**：宁可少卖（保守）也不能超卖；对账发现的差异以数据库为准修正。

## 五、场景三：抢红包

### 1. 需求与约束（假设）

- 一个群红包：总金额 200 元，100 个份额，**瞬时数万人抢**；
- **每人最多抢一次**；**金额分配公平且总和精确**；**不超发**（总额不多于红包金额）；
- 抢到后**立即告知**，资金入账允许稍后（秒级）完成；过期未领完的**退回**发红包者。

### 2. 架构

<figure class="fig">
<svg viewBox="0 0 820 360" class="dg" role="img" aria-label="抢红包流程：发红包时扣减发送者余额并生成红包记录，预先按二倍均值法拆分出所有份额金额并写入 Redis List；用户抢红包请求执行 Lua 脚本，原子地判断是否已领取并从 List 弹出一个份额，记录领取并返回金额；成功后发送领取事件到 MQ；异步消费者写领取流水并为用户入账，入账通过流水表加批量汇总方式处理热点账户；红包过期后定时任务退回未领完的金额；全程幂等并对账">
<rect class="b1" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">① 发红包</text>
<text class="ts" x="85" y="74" text-anchor="middle">扣款 + 预拆分</text>
<rect class="b3" x="170" y="30" width="160" height="64" rx="8"/>
<text class="tb" x="250" y="52" text-anchor="middle" dominant-baseline="middle">Redis 红包池</text>
<text class="ts" x="250" y="74" text-anchor="middle">List: 各份额金额</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<rect class="b5" x="350" y="30" width="160" height="64" rx="8"/>
<text class="tb" x="430" y="52" text-anchor="middle" dominant-baseline="middle">② 抢（Lua 原子）</text>
<text class="ts" x="430" y="74" text-anchor="middle">防重复 + 弹出份额</text>
<line class="l" x1="330" y1="62" x2="350" y2="62" marker-end="url(#arr)"/>
<rect class="b2" x="530" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="595" y="52" text-anchor="middle" dominant-baseline="middle">③ 领取事件</text>
<text class="ts" x="595" y="74" text-anchor="middle">MQ（幂等键）</text>
<line class="l" x1="510" y1="62" x2="530" y2="62" marker-end="url(#arr)"/>
<rect class="b4" x="680" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="740" y="52" text-anchor="middle" dominant-baseline="middle">④ 异步入账</text>
<text class="ts" x="740" y="74" text-anchor="middle">流水·汇总</text>
<line class="l" x1="660" y1="62" x2="680" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="780" height="224" rx="10"/>
<text class="th" x="36" y="144">要点</text>
<text class="ts" x="36" y="168">• 预拆分：发红包时就用“二倍均值法”算出每份金额（见 工程中的算法：红包），运行时只“弹出一份”，无需计算</text>
<text class="ts" x="36" y="188">• Lua 原子领取：已领集合判重 → LPOP 份额 → 记录领取（HSET 用户→金额）→ 返回金额；全程一个原子操作</text>
<text class="ts" x="36" y="208">• 抢到与到账解耦：用户立即看到金额（Redis 为领取权威），入账走 MQ 异步，失败可重试（幂等键 = 红包ID + 用户ID）</text>
<text class="ts" x="36" y="228">• 红包池持久化：Redis 数据可能丢失 → 发红包时红包与份额也落库（红包表 + 份额表），Redis 丢失可由库重建剩余份额</text>
<text class="ts" x="36" y="248">• 过期退回：定时任务扫描过期红包，剩余金额原路退回发送者（幂等、先标记状态再入账）</text>
<text class="ts" x="36" y="268">• 热点：同一红包的 Key 高并发 → 大红包可拆多个子池（按人数分段），或按群路由到不同 Redis 分片</text>
<text class="ts" x="36" y="288">• 对账：红包总额 = 已领取金额之和 + 退回金额；领取记录与入账流水逐笔核对</text>
<text class="ts" x="36" y="308">• 风控：同一设备/账号频率限制、黑产识别（脚本抢红包）、验证码触发、风险账户不入账或延迟</text>
<text class="ts" x="36" y="328">• 展示：已领列表/手气最佳在领取完成后由库查询（不影响抢的热路径）</text>
</svg>
<figcaption>图 3：抢红包：预拆分、Lua 原子领取、异步入账</figcaption>
</figure>

### 3. Lua 领取脚本

```lua
-- KEYS[1]=rp:pool:{id}(List 份额金额，分)  KEYS[2]=rp:got:{id}(Hash 用户→金额)  ARGV[1]=uid
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return -1                                         -- 已领取过（幂等返回，同时可返回已领金额）
end
local amt = redis.call('LPOP', KEYS[1])
if not amt then return 0 end                        -- 已抢完
redis.call('HSET', KEYS[2], ARGV[1], amt)
return tonumber(amt)                                -- 成功：返回金额（分）
```

- **金额用整数“分”**，避免浮点；总和在拆分时已保证精确（最后一份取剩余）；
- Redis 单线程执行脚本，天然原子，**无需分布式锁**；脚本要短、只含必要操作；
- 返回后**立即发领取事件**（带幂等键），而不是在脚本里写数据库。

### 4. 入账与热点账户

红包金额入用户钱包是**金额变动**，要走账务（流水 + 余额）。热点出现在：

- **发红包者账户**（扣款一次，不热）；**商家/主播收款账户**（持续被大量入账，热点行）；
- 用户钱包本身通常不热（每人入账次数少）。

**热点账户的处理**：

| 方案 | 说明 |
| --- | --- |
| **流水先行、批量汇总** | 每笔入账先**追加流水**（只插入，不更新余额，无热点行冲突），余额由**定时/批量汇总**更新（`balance = balance + Σ流水`）；查余额 = 已汇总余额 + 未汇总流水（或接受秒级延迟） |
| **子账户拆分** | 热点账户拆成 N 个子账户（`acct_0..N`），入账随机选一个，总余额 = 子账户之和；提现/结算时归集 |
| **缓冲记账（内存聚合）** | 同一账户的入账在内存/队列聚合后一次更新（Group Commit） |
| **异步 + 对账** | 入账事件异步消费，**幂等键 `(红包ID, 用户ID)`**，并与账务对账（见 [订单支付案例：复式记账](#/design/case-payment)） |

### 5. 抽奖/抽盲盒（相近场景）

- 奖池库存（每种奖品剩余数）→ Redis 原子扣减或预分配，**中奖概率**用加权随机（前缀和 + 二分，见 [工程中的算法：随机](#/cs/algo-engineering)）；
- **预生成中奖结果**（按概率提前生成序列放入队列，用户抽取时只弹出）可避免运行时并发算概率，也易于控制总量；
- 防刷（风控）、限次、幂等（同一次抽奖请求不重复扣次数）。

## 六、数据库与 Redis 的写优化手段

### 1. MySQL / 关系库

| 手段 | 说明 |
| --- | --- |
| **缩短事务** | 事务内不做远程调用、不做耗时计算；**热点更新放在事务最后**（尽量晚加锁、早提交，减少持锁时间） |
| **批量写** | `INSERT ... VALUES (...), (...)`、`rewriteBatchedStatements=true`；批量大小适中（几百~几千） |
| **顺序主键/减少二级索引** | 追加写、页分裂少；每个索引都放大写成本（见 [B+ 树索引](#/mysql/index)） |
| **组提交与刷盘参数** | `innodb_flush_log_at_trx_commit`、`sync_binlog` 的权衡（见 [redo/undo/binlog](#/mysql/log)）；多个事务共享一次 `fsync` |
| **减少锁冲突** | 避免范围锁/间隙锁（RR 下谨慎，见 [InnoDB 锁](#/mysql/lock)）；固定加锁顺序；唯一键冲突的插入尽量用 `INSERT ... ON DUPLICATE KEY` |
| **分库分表** | 把写分散到多个库（见 [分库分表](#/mysql/sharding)），热点单行仍需拆分 |
| **读写分离/CQRS** | 写走主库，读走缓存/从库/读模型（见 [CQRS](#/design/cqrs-es)） |
| **异步落库** | 写先进队列/日志，后台匀速写库（削峰） |
| **避免大事务与长事务** | 分批提交；长事务阻塞 purge、放大锁等待 |

### 2. Redis

| 手段 | 说明 |
| --- | --- |
| **拆 Key** | 热点 Key → `key#0..N-1`，写随机选、读汇总；Cluster 下确保子 Key 落在不同槽/分片（避免 hashtag 把它们聚到同一槽） |
| **本地缓存/本地聚合** | 减少对 Redis 的请求次数 |
| **Pipeline / 批量命令** | 降低 RTT 开销（`MGET/MSET/Pipeline`） |
| **Lua 合并多步操作** | 保证原子性并减少往返；脚本保持短小 |
| **避免大 Key 与慢命令** | 大 Set/List/ZSET 阻塞单线程（见 [Redis 数据结构：大 Key](#/redis/types)） |
| **读写分离不适用于热点写** | 副本分担的是读；写仍在主分片 |

### 3. 消息队列

- **按业务键分区**（同一内容/同一红包进同一分区）保证局部有序并便于聚合；
- 批量发送与消费、幂等消费、积压监控、死信（见 [Kafka](#/mw/kafka)、[事件驱动：可靠消费](#/design/event-driven)）。

## 七、一致性、幂等与对账

高并发写的实现里**几乎必然引入“多个存储 + 异步”**，所以正确性靠三件事：

1. **幂等**：每个异步环节有**幂等键**（`eventId`、`orderNo`、`(红包ID,用户ID)`），重复处理无副作用；
2. **事实来源明确**：计数以**关系表**为准，库存以**数据库库存行 + 订单**为准，红包以**红包表/份额表/领取流水**为准，金额以**账务流水**为准；Redis 是加速层/运行时权威，**可由事实来源重建**；
3. **对账与修复**：定时（分钟/小时/日）校验“缓存 vs 数据库”“库存 vs 订单占用”“红包总额 vs 领取+退回”，自动修正或告警人工处理（见 [订单支付案例：对账](#/design/case-payment)）。

**故障场景的处理原则**：

| 故障 | 处理 |
| --- | --- |
| Redis 丢数据/主从切换 | 以数据库事实来源重建；热点期间降级（限流、只读、排队） |
| MQ 积压/消费失败 | 扩容消费；重试 + 死信；纯展示类可丢弃采样 |
| 应用崩溃（内存聚合丢失） | 接受有界丢失（展示类）；关键金额类不用内存聚合或配合 WAL |
| 数据库不可用 | 降级为暂存队列（有界）+ 限流；恢复后重放；资金类宁可拒绝也不能丢 |
| 重复请求 | 幂等键去重；前端防抖 + 服务端幂等 |

## 八、压测、容量与监控

- **压测**：针对**单热点 Key/单行**做专项压测，找到拐点（见 [压测与容量规划](#/design/eng-loadtest)）；验证拆分后的线性度、异步积压的恢复速度、降级是否生效；
- **监控**：热点 Key 识别（Redis `--hotkeys`、代理层统计、客户端采样）、数据库行锁等待（`innodb_row_lock_waits`、`SHOW ENGINE INNODB STATUS`）、MQ 积压与消费延迟、缓存 vs 库的差异率（对账指标）、失败重试与死信数；见 [指标监控](#/infra/obs-metrics)；
- **容量**：按**峰值单热点 QPS**而非平均值规划；活动前预热与预扩容；
- **限流与降级预案**：热点写入口限流（按内容/红包/SKU 维度），超限返回“稍后再试”或排队；非核心写（浏览数、埋点）优先丢弃（见 [限流算法](#/cs/algo-engineering)、[稳定性工程](#/design/eng-chaos)）。

## 九、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 精确 vs 近似 | 展示类近似 + 对账；金额库存精确 | 近似类短期不一致 |
| 同步落库 vs 异步落库 | 异步削峰 | 延迟、幂等、对账复杂 |
| 内存聚合 vs 可靠性 | 展示类内存聚合；关键类走 MQ/WAL | 宕机丢有界增量 |
| 拆分并行度 vs 读汇总成本 | 拆 N 份 | 读多 N 次、尾部碎片、动态调整 |
| Redis 运行时权威 vs 数据库唯一权威 | Redis 抗热点 + 数据库兜底对账 | 两套状态、回补与对账 |
| 分布式锁 vs 原子脚本/条件更新 | 原子脚本/条件更新 | Lua 复杂度、脚本需严格评审 |
| 公平 vs 性能（抢红包/抢购排队） | 允许先到先得 | 极端情况下的体验差异 |

## 十、常见坑

| 坑 | 对策 |
| --- | --- |
| 热点行直接 `UPDATE` 计数，行锁排队拖垮数据库 | Redis 计数 + 异步聚合落库；分段计数 |
| 先 `SELECT` 库存再 `UPDATE`，并发超卖 | 条件更新 `qty >= n` 或 Lua 原子扣减 |
| 事务里夹杂远程调用，持锁时间被放大 | 缩短事务；远程调用放事务外 |
| 用分布式锁串行库存/红包，吞吐低且锁成故障点 | 原子脚本/条件更新/预分配 |
| Redis Key 热点未拆分，单分片打满 | 分段 Key、本地聚合、跨分片分布 |
| 异步消费没有幂等，重复入账/重复计数 | 幂等键 + 去重表；设计成可重算 |
| 内存聚合用于金额类，宕机丢钱 | 金额类不用内存聚合，用 MQ/WAL 或同步写 |
| 红包金额用浮点、总和对不上 | 整数分 + 最后一份取剩余 |
| 红包池只放 Redis，宕机丢失 | 红包与份额落库，Redis 可重建 |
| 抢到即入账同步完成，入账成为瓶颈 | 抢到与到账解耦，流水先行 + 批量汇总 |
| 热点账户余额行成为瓶颈 | 子账户拆分、流水汇总、批量入账 |
| 没有对账，漂移长期累积 | 定时对账与自动修复，Redis 可由事实来源重建 |
| 压测只测平均不测单热点 | 单 Key/单行专项压测，找拐点 |
| 降级方案没演练，故障时失效 | 降级开关定期演练 |

## 面试追问

> [!QUESTION] 为什么高并发写同一行数据很难扩展？怎么优化？
> 同一行的更新必须互斥，事务持锁到提交，后来的事务排队，单行吞吐约等于一除以持锁时间，几百到一两千 TPS。优化思路是拆分热点（分段计数、分段库存、子账户）、合并写（内存聚合批量落库、组提交）、异步削峰、预分配、按 Key 串行化，以及限流降级，同时缩短事务并保证幂等与对账。

> [!QUESTION] 点赞数怎么设计才能扛住爆款内容的高并发？
> 用关系表的唯一键保证用户不重复点赞并作为事实来源，写路径先做去重再对 Redis 计数器原子 INCR 并发 MQ 事件后立即返回；消费者按内容聚合一个时间窗的增量批量更新数据库；爆款内容的计数 Key 拆成多个分段，读时汇总；定期用关系表对账修正，允许短暂不精确。

> [!QUESTION] 库存扣减怎么防超卖？热点商品怎么提升吞吐？
> 基础做法是数据库条件更新 qty 大于等于扣减数，影响行数为零即库存不足，并配合幂等记录。热点 SKU 可以分段库存、Redis 预扣加异步落库、同一 SKU 请求排队合并成一次更新或按 SKU 单线程串行；预占支付确认超时释放，Redis 与数据库定期对账，宁可少卖不可超卖。

> [!QUESTION] 抢红包系统怎么设计？如何保证不超发、不重复？
> 发红包时扣款并用二倍均值法预拆分各份额金额存入 Redis List，同时落库；抢的时候用 Lua 脚本原子地判断是否已领取并弹出一个份额记录领取，天然无需分布式锁；金额用整数分，最后一份取剩余保证总和精确。领取成功立即返回，入账通过 MQ 异步完成，幂等键为红包 ID 加用户 ID，过期未领完的由定时任务退回，并做总额对账。

> [!QUESTION] 热点账户（如主播收款）余额怎么处理高并发入账？
> 每笔入账先追加流水，不直接更新余额行，避免行锁冲突，再由定时或批量任务汇总更新余额；或者把热点账户拆成多个子账户随机入账、结算时归集；入账事件异步消费并用幂等键去重，最终与账务对账。

> [!QUESTION] Redis 单 Key 成为热点怎么办？
> 把一个 Key 拆成多个子 Key，写时随机选择、读时汇总，并确保子 Key 分布在不同分片；应用层本地聚合批量 INCRBY 降低请求量；使用 Pipeline 和 Lua 减少往返；避免大 Key；副本只能分担读，不能分担写，所以热点写必须靠拆分和合并。

> [!QUESTION] 异步化之后如何保证最终一致？
> 每个异步环节都设计幂等键，事实来源明确，如计数以关系表为准、库存以数据库和订单为准、金额以账务流水为准，Redis 只是可重建的加速层；失败通过重试和死信处理，并定时对账修复漂移；关键金额类不使用易丢的内存聚合。
