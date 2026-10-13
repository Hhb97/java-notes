---
level: 深入
tags: [幂等, 幂等键, 去重表, 唯一索引, 乐观锁, 状态机, Idempotency-Key, 消息幂等, 重试, 超时未知, 对账, 支付]
summary: 幂等设计与重试实战：幂等的定义与自然幂等操作、幂等键的生成与作用域、六类实现方案（唯一约束去重表、条件更新/状态机、令牌机制、Redis 去重、请求结果缓存、下游幂等调用）的适用与陷阱、处理中状态与并发同键请求、HTTP Idempotency-Key、MQ 消费幂等、超时未知结果的三态处理与对账、Java 落地与常见坑。
---

# 幂等设计与重试：幂等键、去重表与超时未知

> [!ABSTRACT] 核心要点
> - **幂等（Idempotent）**：同一个操作**执行一次与执行多次，系统状态与对外效果相同**。在分布式系统里，**网络超时、消息重投、客户端重试、故障转移都会让“同一请求被执行多次”变成常态**，所以**“能安全重试”是接口与消息处理的基本要求**，不是可选项。
> - **自然幂等**：`SET x = 5`、按主键删除、`PUT` 全量覆盖、状态流转到终态（`status = PAID`）；**非幂等**：`x = x + 1`、`INSERT` 无唯一约束、下单扣款、发短信。**把非幂等操作改造成幂等**，核心手段是**“用唯一标识记录这次操作是否已处理”**。
> - 实现的根基是**幂等键（Idempotency Key）**：由**客户端/上游生成、同一业务操作的所有重试保持不变**；服务端以它做**去重**。幂等键要有明确的**作用域**（用户/租户/接口）与**生存时间**，并**校验“相同键 + 不同参数”的冲突**。
> - 最可靠的实现是**把去重与业务写入放在同一个本地事务里**（**唯一约束**或**幂等表 + 业务表同事务**）；Redis 去重性能高但要接受**窗口与故障时的不确定性**，不适合金额类强约束。
> - **“处理中”是最容易漏掉的状态**：同一幂等键的**并发请求**要有明确行为（返回 409/202、等待结果、或阻塞），**不能出现两个同时执行**。
> - **超时 ≠ 失败**：调用方超时后，对方可能已经成功。必须用**三态模型（成功/失败/未知）**处理“未知”：**查询确认、同幂等键重试、对账补偿**，不能想当然地当作失败而重复扣款，也不能当作成功而漏处理。

## 为什么必须幂等

| 重复来源 | 说明 |
| --- | --- |
| **客户端重试/用户重复提交** | 点击两次、前端超时自动重发、弱网重试 |
| **网络超时后的重试** | 请求已处理但响应丢失，调用方不知道，重发 |
| **RPC/HTTP 框架重试** | 自动重试配置（见 [OpenFeign 深入](#/spring/cloud-feign)） |
| **消息至少一次投递** | MQ 重投、消费者位点提交失败后重新消费、Rebalance，见 [消息队列核心问题](#/mw/mq) |
| **故障转移** | 主从切换、实例重启后重放未确认的请求或日志 |
| **定时/补偿任务重复触发** | 调度器 at-least-once，见 [案例：分布式任务调度平台](#/design/case-scheduler) |
| **分布式事务补偿/重试** | Saga/TCC 的确认、取消需要幂等，见 [分布式事务](#/distributed/transaction) |
| **人工重放/数据修复** | 运维补数据、重跑任务 |

结论：**凡是可能被重复调用的入口（HTTP 接口、RPC、消息消费、定时任务、补偿动作）都要设计幂等**；只有无副作用的纯查询可以不考虑。

## 哪些操作天然幂等，哪些需要改造

| 操作 | 是否幂等 | 说明与改造 |
| --- | --- | --- |
| **查询（GET）** | ✅ | 无副作用 |
| **全量覆盖（PUT、`SET x = v`、`UPDATE ... SET status='PAID'`）** | ✅ | 重复执行结果相同（但要注意并发乱序覆盖，见版本号） |
| **按主键删除** | ✅ | 重复删除结果相同（响应码可能不同） |
| **增量更新（`x = x + 1`、扣库存、加余额）** | ❌ | 改为**带幂等键的流水 + 条件更新**，或把“增量”变成“基于版本的绝对值” |
| **插入（POST 创建）** | ❌ | 加**唯一约束**（业务唯一键/幂等键），重复插入冲突即视为已处理 |
| **发送通知/调用外部系统** | ❌ | 外部接口支持幂等键则传入；否则本地记录发送状态防重 |
| **状态流转** | 视情况 | 定义**状态机**：只允许合法迁移，重复到达同一目标状态视为成功 |
| **顺序依赖的操作** | ⚠️ | 乱序到达会导致覆盖，需要**版本号/序号**判断“是否过时” |

## 幂等键

### 生成与传递

| 要点 | 说明 |
| --- | --- |
| **谁生成** | **发起方生成**，在**同一次业务意图的所有重试中保持不变**；服务端不要“收到请求才生成”（那样每次重试都是新键） |
| **形式** | UUID/ULID（通用）；或**业务天然唯一键**（订单号、支付流水号、消息 ID、`用户ID + 业务类型 + 业务单号`）；避免用时间戳+随机数的弱键 |
| **传递** | HTTP：`Idempotency-Key` 请求头（业界常见做法，如支付类 API）；RPC：放在请求元数据；消息：放在消息头/消息体的 `messageId/eventId` |
| **粒度** | 一次业务意图一个键，**不要把多个独立操作共用一个键** |
| **作用域** | 键的唯一范围：**(租户/用户, 接口, 键)**，避免不同用户碰撞，也避免被他人猜测使用 |
| **有效期（TTL）** | 去重记录保留多久：覆盖**最大重试窗口 + 消息最大延迟 + 对账周期**（常见 24 小时~数天；资金类更长或永久保留业务流水） |
| **参数一致性校验** | 记录请求参数摘要，**相同键但参数不同**直接拒绝（说明客户端 bug 或攻击），防止“同键不同参数”造成错误复用结果 |

### 对外 API 的约定（参考通行做法）

- 非幂等的 `POST` 支持 `Idempotency-Key`：第一次请求正常处理并**保存响应**；同键重试**返回第一次的响应**（同状态码与响应体），并可在响应头标明“这是重放”；
- 同键请求**正在处理中**：返回 `409 Conflict`（或 `425`/`202 Accepted` 附带状态查询地址），由客户端稍后重试；
- 同键不同参数：返回 `422/400` 并提示键被复用；
- 键过期后：当作新请求处理（要在文档中说明有效期）。

## 实现方案

### 方案一：数据库唯一约束（去重表 / 业务唯一键）

**原理**：把幂等键作为唯一索引的一部分；**插入成功 = 首次处理，唯一冲突 = 重复**。

```sql
-- 幂等记录表（也可以直接在业务表上建唯一索引，如 payment(order_no, pay_channel_trade_no) 唯一）
CREATE TABLE idempotent_record (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  scope        VARCHAR(64)  NOT NULL,            -- 作用域：租户/接口
  idem_key     VARCHAR(128) NOT NULL,            -- 幂等键
  request_hash CHAR(32)     NOT NULL,            -- 请求参数摘要，校验“同键不同参”
  status       TINYINT      NOT NULL,            -- 0 处理中 1 成功 2 失败（可重试）
  response     TEXT,                              -- 成功时保存响应，便于重放
  expire_at    DATETIME     NOT NULL,
  created_at   DATETIME     NOT NULL,
  updated_at   DATETIME     NOT NULL,
  UNIQUE KEY uk_scope_key (scope, idem_key),
  KEY idx_expire (expire_at)
);
```

```java
@Transactional
public Result<Order> createOrder(String idemKey, CreateOrderReq req) {
    String hash = digest(req);
    try {
        // 1. 抢占：插入“处理中”记录。唯一冲突说明这个键已被处理或正在处理
        recordMapper.insert(new IdempotentRecord(SCOPE, idemKey, hash, PROCESSING));
    } catch (DuplicateKeyException e) {
        IdempotentRecord r = recordMapper.get(SCOPE, idemKey);
        if (!r.getRequestHash().equals(hash)) throw new IdempotencyConflictException("同一幂等键参数不一致");
        if (r.getStatus() == SUCCESS)  return JSON.parse(r.getResponse());     // 重放第一次的结果
        if (r.getStatus() == PROCESSING) throw new InProgressException();        // 并发中：让客户端稍后重试
        // FAILED：允许重试（见下文状态设计）
    }
    // 2. 业务处理与幂等记录更新在同一个本地事务里
    Order order = orderService.doCreate(req);
    recordMapper.markSuccess(SCOPE, idemKey, JSON.toJSON(Result.ok(order)));
    return Result.ok(order);
}
```

要点：

- **去重与业务在同一事务**：业务回滚，幂等记录也回滚，不会出现“记录说成功但业务没做”；
- **并发安全由唯一索引保证**，不需要额外的分布式锁；
- **数据库在分片环境下**：幂等键要与分片键一致（或在统一的幂等库），否则同一个键落在不同分片就失去唯一性，见 [分片、一致性哈希与再平衡](#/distributed/partitioning)；
- 直接利用**业务表的天然唯一键**最简洁（如 `UNIQUE(order_no)`、支付流水号），不必另建表；
- 清理：按 `expire_at` 定期归档/删除，避免无限增长；
- 局限：**只覆盖本库内的副作用**；调用外部系统（HTTP/MQ）不在事务内，需配合其他手段（见下文“下游调用”）。

### 方案二：条件更新与状态机

**原理**：用**当前状态/版本作为前置条件**，状态已变化则更新 0 行，视为重复。

```sql
-- 支付回调：只允许 待支付 → 已支付，重复回调更新 0 行（但视为成功）
UPDATE orders SET status = 'PAID', paid_at = NOW()
WHERE order_no = ? AND status = 'UNPAID';

-- 库存扣减：流水唯一 + 条件扣减，重复流水不会重复扣
INSERT INTO stock_flow(biz_no, sku_id, qty) VALUES (?, ?, -1);   -- biz_no 唯一，冲突即已处理
UPDATE stock SET available = available - 1 WHERE sku_id = ? AND available >= 1;
```

- **状态机**：定义合法迁移（`UNPAID → PAID → REFUNDED`），**到达已处于目标状态的重复请求直接返回成功**；非法迁移返回错误；
- **乐观锁（version）**：`UPDATE ... SET x=?, version=version+1 WHERE id=? AND version=?`，同时解决**重复**与**并发覆盖**；
- 适合：状态流转类业务（订单、支付、审批、工单）；
- 注意：**更新行数为 0 不等于失败**——要区分“已经是目标状态（幂等成功）”与“状态不允许（真失败）”，需再查询确认。

### 方案三：令牌（Token）机制

**原理**：**先申请令牌，提交时携带并消耗**；一个令牌只能用一次。

1. 客户端进入页面时请求服务端签发 **token**（存 Redis，带 TTL）；
2. 提交请求带上 token；服务端**原子地检查并删除** token（Redis `DEL` 返回 1 才继续 / Lua 脚本）；
3. 删除成功 → 首次，继续处理；失败 → 重复提交，拒绝。

适合**防止表单重复提交**（前端点击多次、网络重发）；缺点：**多一次获取令牌的往返**；Redis 故障与令牌消耗后业务失败的**悲观问题**（令牌已删但业务失败，用户要重新获取令牌）。业务关键性强的写操作仍需配合数据库层的唯一约束。

### 方案四：Redis 去重（SETNX + 状态）

```java
// 以幂等键抢占：SET key value NX EX ttl，成功才处理
Boolean first = redis.opsForValue().setIfAbsent("idem:" + scope + ":" + key, "PROCESSING", Duration.ofMinutes(10));
if (Boolean.FALSE.equals(first)) {
    String state = redis.opsForValue().get("idem:" + scope + ":" + key);
    // DONE：返回缓存的结果；PROCESSING：提示处理中
}
try {
    Result r = doBusiness();
    redis.opsForValue().set("idem:" + scope + ":" + key, "DONE:" + JSON.toJSON(r), Duration.ofHours(24));
    return r;
} catch (Exception e) {
    redis.delete("idem:" + scope + ":" + key);   // 失败释放，允许重试（见陷阱）
    throw e;
}
```

适用：**高并发、容忍极小概率重复的场景**（防刷、通知类、点赞）。陷阱：

- **“业务成功但写 DONE 失败/进程崩溃”**：键停留在 PROCESSING 直到过期，期间重试被误判为“处理中”，过期后又**重复执行**；
- **“PROCESSING 的 TTL”必须大于业务最长执行时间**，否则超时后第二个请求进入，**并发重复**；
- **Redis 主从切换/持久化丢失**，去重记录丢失导致重复，见 [主从、哨兵与 Cluster](#/redis/cluster) 的脑裂与丢写；
- 与业务写入**不在同一事务**，存在不一致窗口；
- 因此：**金额、库存等强约束的业务，Redis 去重只能作第一道快速过滤，最终仍靠数据库唯一约束/条件更新兜底**。

### 方案五：请求结果缓存（重放响应）

在去重基础上**保存第一次的完整响应**，重复请求直接返回同样的响应——客户端对“重试”无感知，行为符合 HTTP 幂等语义。注意：

- 响应里不应包含**不可重放的信息**（临时令牌、时间戳敏感内容）；
- 结果存储与业务写入的原子性（与方案一同事务）；
- 存储成本：响应体大时只存引用或摘要，再按业务键查询重建。

### 方案六：下游调用的幂等

调用**不在本地事务内**的外部系统（支付渠道、短信、第三方 API、另一个微服务）时：

| 情况 | 做法 |
| --- | --- |
| **下游支持幂等键** | 把**本次业务的稳定键**（如支付单号）作为下游的幂等键/商户订单号传入；重试用同一个键 |
| **下游不支持幂等** | 本地先落库**“待发送/发送中”记录**（状态机 + 唯一键），发送后更新状态；超时未知时**先查询下游结果**再决定重发，不盲目重试 |
| **异步回调** | 回调同样要幂等（按下游流水号去重 + 状态机），并**验签、金额校验** |
| **需要强一致** | Outbox/事务消息/本地消息表保证“本地写入 + 对外动作”的可靠，见 [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven) |

### 方案选择

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="幂等方案选择：如果操作天然是状态流转，用状态机与条件更新；如果是创建类，用业务唯一键或去重表唯一约束；如果是表单重复提交防护，用令牌机制；如果高并发低风险可用 Redis 去重但需数据库兜底；如果调用外部系统，使用下游幂等键加本地状态记录；如果是消息消费，使用消息 ID 与业务幂等；强约束类业务必须落在数据库同一事务内">
<rect class="b3" x="20" y="14" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">状态流转类（支付回调、审批）</text>
<text class="ts" x="195" y="58" text-anchor="middle">→ 状态机 + 条件更新（乐观锁）</text>
<rect class="b5" x="390" y="14" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">创建类（下单、转账流水）</text>
<text class="ts" x="565" y="58" text-anchor="middle">→ 唯一约束 / 去重表（同事务）</text>
<rect class="b1" x="20" y="96" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="116" text-anchor="middle" dominant-baseline="middle">表单重复点击、前端连点</text>
<text class="ts" x="195" y="140" text-anchor="middle">→ 令牌（一次性）+ 数据库兜底</text>
<rect class="b4" x="390" y="96" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="116" text-anchor="middle" dominant-baseline="middle">高并发、低风险（点赞、防刷）</text>
<text class="ts" x="565" y="140" text-anchor="middle">→ Redis SETNX 去重（容忍极小概率重复）</text>
<rect class="b2" x="20" y="178" width="350" height="70" rx="8"/>
<text class="tb" x="195" y="198" text-anchor="middle" dominant-baseline="middle">调用外部系统（支付、短信）</text>
<text class="ts" x="195" y="222" text-anchor="middle">→ 下游幂等键 + 本地状态 + 查询/对账</text>
<rect class="b3" x="390" y="178" width="350" height="70" rx="8"/>
<text class="tb" x="565" y="198" text-anchor="middle" dominant-baseline="middle">消息消费（MQ）</text>
<text class="ts" x="565" y="222" text-anchor="middle">→ messageId/业务键去重，处理与去重同事务</text>
<rect class="bg" x="20" y="262" width="720" height="58" rx="8"/>
<text class="ts" x="380" y="284" text-anchor="middle">原则：强约束（金额、库存）→ 最终落在数据库唯一约束/条件更新；Redis 只做加速；外部副作用 → 状态机 + 查询确认 + 对账</text>
<text class="ts" x="380" y="304" text-anchor="middle">多种手段可叠加：网关令牌防连点 → 服务层幂等键 → 数据库唯一约束兜底</text>
</svg>
<figcaption>图 1：按场景选择幂等方案</figcaption>
</figure>

## “处理中”与并发同键请求

幂等记录的**状态**设计决定了并发与失败重试的行为：

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="幂等记录的状态机：请求到达，尝试插入处理中记录；成功则进入业务处理，处理成功更新为成功并保存响应，处理失败按错误类型更新为失败可重试或删除记录；插入冲突则读取已有记录：状态为成功则返回保存的响应，状态为处理中则返回处理中提示或等待，状态为失败则允许重试并抢占；处理中记录需要超时回收，防止进程崩溃后永久卡住">
<rect class="b3" x="20" y="30" width="120" height="56" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">请求到达</text>
<text class="ts" x="80" y="72" text-anchor="middle">带幂等键</text>
<rect class="b5" x="170" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">尝试插入记录</text>
<text class="ts" x="245" y="72" text-anchor="middle">状态=处理中</text>
<rect class="b2" x="360" y="14" width="150" height="40" rx="8"/>
<text class="ts" x="435" y="34" text-anchor="middle" dominant-baseline="middle">插入成功：执行业务</text>
<rect class="b4" x="360" y="66" width="150" height="40" rx="8"/>
<text class="ts" x="435" y="86" text-anchor="middle" dominant-baseline="middle">唯一冲突：读记录</text>
<line class="l" x1="140" y1="58" x2="170" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="50" x2="360" y2="34" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="66" x2="360" y2="86" marker-end="url(#arr)"/>
<rect class="b2" x="540" y="14" width="200" height="40" rx="8"/>
<text class="ts" x="640" y="34" text-anchor="middle" dominant-baseline="middle">成功→记录=成功+响应</text>
<line class="l" x1="510" y1="34" x2="540" y2="34" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="720" height="180" rx="8"/>
<text class="th" x="32" y="150">冲突后的分支（按已有记录的状态）</text>
<text class="ts" x="380" y="176" text-anchor="middle">成功：直接返回保存的响应（重放），客户端无感知；先校验 request_hash 是否一致</text>
<text class="ts" x="380" y="198" text-anchor="middle">处理中：另一个请求正在执行 → 返回 409/“处理中”让客户端稍后重试，或在短时间内轮询等待结果，绝不并行执行第二份</text>
<text class="ts" x="380" y="220" text-anchor="middle">失败（可重试类）：允许重新抢占（CAS：状态 失败→处理中），再次执行；不可重试的业务失败可保存失败结果直接返回</text>
<text class="ts" x="380" y="242" text-anchor="middle">处理中超时回收：进程崩溃会使记录永久“处理中”，需带 lease 过期时间；超时后允许接管，接管前先确认业务是否已完成（查业务表）</text>
<text class="ts" x="380" y="264" text-anchor="middle">业务异常的分类：参数错误等“确定失败”可记录并快速失败；超时/系统异常为“未知”，不要记为失败，而要保持处理中或回查</text>
<text class="ta" x="380" y="292" text-anchor="middle">同事务写入（方案一）时，业务回滚则记录一起回滚，状态问题大幅简化；跨系统时才需要完整状态机</text>
</svg>
<figcaption>图 2：幂等记录的处理中/成功/失败状态与并发行为</figcaption>
</figure>

## 消息消费的幂等

MQ 至少一次投递，**消费端必须幂等**，见 [消息队列核心问题](#/mw/mq)：

| 方案 | 做法 | 注意 |
| --- | --- | --- |
| **业务唯一键** | 消息体含业务唯一标识（订单号+事件类型），消费时利用**业务表唯一约束**或**状态机** | 最稳；要求事件设计时就包含稳定键，见 [事件驱动架构](#/design/event-driven) |
| **消息 ID 去重表** | 在**与业务处理同一事务**里插入 `message_id`（唯一），冲突即重复 | 去重表保留时间要覆盖最大重投窗口；清理策略 |
| **Redis 去重** | `SET msgId NX EX` | 窗口与故障丢失问题，强约束仍要数据库兜底 |
| **自然幂等的操作** | “把状态设为 X”“覆盖写” | 乱序时要版本号判断是否过时 |
| **有序与乱序** | 同一实体的事件要有序号/版本，**旧版本的消息丢弃** | 避免“旧事件覆盖新状态” |

要点：

- **消息 ID 由生产者生成并保持不变**（不要用 Broker 分配的 offset 作为业务幂等键，重新投递到不同分区/Topic 会变）；
- **去重和业务处理要原子**：先处理后记录去重会在两步之间崩溃造成重复；先记录后处理会在处理失败时误丢；同事务最安全；
- 批量消费要对**每条消息**幂等；
- 重试与死信：重试次数有限，毒消息进死信，见 [RabbitMQ](#/mw/rabbitmq)、[Kafka 生产运维](#/mw/kafka-ops)。

## 超时未知结果：三态模型

调用方发出请求后**超时**，处理结果有三种可能：成功、失败、未知。**把“未知”当作失败重发，可能重复；当作成功，可能漏处理。**

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="超时未知结果的处理：调用方发起请求并带幂等键，若超时则进入未知状态；处理方式包括使用同一幂等键重试，因为幂等所以安全；先调用查询接口确认结果再决定；记录未知状态交给对账任务补偿；多次重试仍未知则人工介入或进入补偿流程；最终必须有对账兜底">
<rect class="b3" x="20" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">发起调用</text>
<text class="ts" x="85" y="72" text-anchor="middle">带稳定幂等键</text>
<rect class="b4" x="180" y="30" width="130" height="60" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">超时/连接断开</text>
<text class="ts" x="245" y="72" text-anchor="middle">结果未知</text>
<rect class="b2" x="360" y="14" width="200" height="40" rx="8"/>
<text class="ts" x="460" y="34" text-anchor="middle" dominant-baseline="middle">成功响应 → 完成</text>
<rect class="b5" x="360" y="66" width="200" height="40" rx="8"/>
<text class="ts" x="460" y="86" text-anchor="middle" dominant-baseline="middle">明确失败 → 按错误类型处理</text>
<line class="l" x1="150" y1="60" x2="180" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="50" x2="360" y2="34" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="70" x2="360" y2="86" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="720" height="190" rx="8"/>
<text class="th" x="32" y="150">“未知”的处理顺序</text>
<text class="ts" x="380" y="176" text-anchor="middle">① 用同一个幂等键重试（有限次数，指数退避）：下游幂等则安全，结果会与第一次一致</text>
<text class="ts" x="380" y="198" text-anchor="middle">② 下游不支持幂等：先调用“查询接口”（按业务单号/流水号）确认实际结果，再决定补发或视为成功</text>
<text class="ts" x="380" y="220" text-anchor="middle">③ 仍无法确认：本地记录“未知/待确认”状态，交给定时对账任务补偿（与下游账单/状态核对）</text>
<text class="ts" x="380" y="242" text-anchor="middle">④ 对用户展示“处理中”而不是“失败”，避免用户重复下单；必要时人工介入或退款/冲正补偿</text>
<text class="ts" x="380" y="264" text-anchor="middle">⑤ 对账是最终兜底：每日/实时与下游核对，发现“单边账”后自动或人工修复</text>
<text class="ta" x="380" y="296" text-anchor="middle">永远不要在“未知”时直接重试一个非幂等的新请求，也不要直接当作成功/失败更新业务状态</text>
</svg>
<figcaption>图 3：超时未知结果的处理流程</figcaption>
</figure>

支付场景示例：用户付款请求超时 → 订单置为“支付处理中” → 用**同一商户订单号**向渠道**查询**支付结果（或等待异步回调）→ 查到成功则推进订单，查到失败/未发起则按规则重发或关闭 → 定时对账捕获遗漏。详见 [案例：订单、支付与对账系统设计详解](#/design/case-payment)。

## Java 落地

### 通用能力：注解 + 拦截

```java
@Target(METHOD) @Retention(RUNTIME)
public @interface Idempotent {
    String key() default "";                 // SpEL：#req.orderNo 或从请求头取 Idempotency-Key
    String scope() default "";               // 业务作用域
    long ttlSeconds() default 86400;
    boolean replay() default true;           // 是否缓存并重放响应
}

@Aspect @Component
public class IdempotentAspect {
    @Around("@annotation(anno)")
    public Object around(ProceedingJoinPoint pjp, Idempotent anno) throws Throwable {
        String key = resolveKey(pjp, anno);                  // 缺失键：对要求幂等的接口直接 400
        String hash = digestArgs(pjp.getArgs());
        // 使用幂等表的“抢占 → 执行 → 完成/回收”流程（见方案一），
        // 在业务方法同一事务内完成去重记录；纯 Redis 版本仅用于低风险接口
        return idempotentExecutor.execute(anno.scope(), key, hash, anno, pjp::proceed);
    }
}
```

要点：

- **缺少幂等键**的写接口应当**拒绝或自动按业务单号推导**，而不是悄悄放行；
- 拦截器适合**通用化**，但**强业务约束（金额）仍要有业务层的唯一约束/状态机**，不要只依赖切面；
- 注意**事务边界**：切面的去重记录要和业务在同一事务（切面顺序在事务之内，或业务服务内部实现）；
- **异常分类**：`BusinessException`（确定失败）与系统异常（未知）区别处理；
- **日志与指标**：记录幂等命中次数、冲突、处理中冲突、参数不一致，便于发现客户端重试风暴与异常。

### 与重试、熔断的关系

- **客户端重试 ⇒ 服务端必须幂等**：任何自动重试（Feign、Spring Retry、网关、SDK）都以幂等为前提；
- 重试配置与退避，见 [OpenFeign 深入](#/spring/cloud-feign) 与 [故障模型、故障检测与脑裂](#/distributed/fault)；
- 熔断打开后的“快速失败”是**确定失败**，不会产生重复。

## 常见坑

| 坑 | 说明与对策 |
| --- | --- |
| **每次重试都生成新的幂等键** | 幂等形同虚设；键必须由发起方在一次业务意图内保持不变 |
| **服务端“收到时才生成”键** | 同上；键要来自客户端或业务稳定字段 |
| **只做“先查后写”** | `if (!exists(key)) insert(...)` 存在竞态，并发时两个都通过；必须靠**唯一约束/原子操作** |
| **去重与业务不在同一事务** | 崩溃后产生“记录有、业务无”或“业务有、记录无” |
| **“处理中”TTL 小于业务耗时** | 第二个请求进入并发重复；TTL > 最大耗时，并加 lease 续期/超时接管 |
| **幂等键 TTL 小于重试/消息延迟窗口** | 过期后重试被当作新请求；窗口要覆盖最大延迟与对账周期 |
| **同键不同参数未校验** | 返回了错误请求的缓存结果；记录并校验请求摘要 |
| **更新条数为 0 当失败** | 幂等重复也是 0 行；要区分“已是目标状态”与“状态非法” |
| **失败也被永久记录** | 暂时性失败（超时、下游不可用）被记为失败后无法重试；仅记录“确定失败”，或允许失败状态重新抢占 |
| **Redis 去重用于金额类** | 丢键/切换导致重复扣款；以数据库为准 |
| **非幂等的“补偿”** | 回滚/取消也要幂等（重复取消不应再次退款），见 [分布式事务](#/distributed/transaction) |
| **只在入口幂等，下游调用不幂等** | 重试时下游被重复调用；向下游透传稳定的幂等键 |
| **消息乱序导致旧状态覆盖新状态** | 加版本号/事件序号，旧的丢弃 |
| **去重表无限增长** | 索引膨胀；TTL 清理/分区表/归档 |
| **接口本身不幂等却被网关/SDK 自动重试** | 对非幂等接口关闭自动重试，或补幂等键 |

## 设计检查清单

- [ ] 每个会被重复调用的入口（接口、RPC、消息、任务、补偿）是否明确了幂等策略？
- [ ] 幂等键是否由发起方生成并在重试中保持不变，作用域与有效期是否明确？
- [ ] 是否有数据库唯一约束或条件更新兜底，去重与业务写入是否在同一事务？
- [ ] 是否处理了“处理中”并发、同键不同参、失败重试与处理中超时回收？
- [ ] 对外调用是否传递下游幂等键，超时未知时是否有“查询确认 + 对账”？
- [ ] 消息消费是否基于业务唯一键或消息 ID 去重，并处理乱序（版本号）？
- [ ] 重试是否有上限、退避，非幂等接口是否关闭了自动重试？
- [ ] 是否有指标与对账发现重复/遗漏？

## 相关阅读

- [CAP、BASE 与一致性模型](#/distributed/theory)：幂等性的基础概念
- [分布式事务](#/distributed/transaction)：补偿、TCC、Saga 中的幂等要求
- [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)：对账与修复
- [消息队列核心问题](#/mw/mq)：重复消费与幂等消费
- [案例：订单、支付与对账系统设计详解](#/design/case-payment)：支付幂等与未知结果处理
- [故障模型、故障检测与脑裂](#/distributed/fault)：重试与超时的故障语义

## 面试追问

> [!QUESTION] 什么是幂等？为什么分布式系统必须关注？
> 同一操作执行一次和多次的效果相同。网络超时重试、消息至少一次投递、故障转移重放、调度重复触发都会让同一请求被执行多次，所以任何可能被重复调用的入口都要能安全重试，否则会出现重复扣款、重复下单等问题。

> [!QUESTION] 怎么实现接口幂等？
> 发起方生成稳定的幂等键并在重试中保持不变，服务端用数据库唯一约束或幂等表在与业务同一事务内去重，重复请求返回第一次的结果；状态流转类用状态机和条件更新；表单防连点用一次性令牌；Redis 去重只作快速过滤，强约束仍由数据库兜底。要处理处理中并发、同键不同参数和键的有效期。

> [!QUESTION] 为什么“先查再写”不能保证幂等？
> 先查是否存在再插入存在竞态，并发请求可能同时查到不存在并都插入。必须依靠唯一约束、原子的条件更新或 SETNX 这类原子操作，由数据库或存储层保证只有一个成功。

> [!QUESTION] 同一个幂等键的并发请求怎么处理？
> 用唯一索引让只有一个请求抢占成功并执行，其他请求读取记录：已成功则返回保存的响应，处理中则返回处理中提示或等待，不能并行执行第二份；处理中记录要有超时回收，防止进程崩溃后永久卡住，接管前先确认业务是否已完成。

> [!QUESTION] 调用第三方支付超时了怎么办？
> 超时不等于失败，结果是未知。订单置为处理中，先用同一商户订单号向渠道查询结果或等待异步回调，用同一幂等键重试，仍未知就记录待确认状态交给对账任务补偿，用户界面展示处理中。不能直接重发新的支付请求，也不能直接当作成功或失败。

> [!QUESTION] 消息消费怎么保证幂等？
> 优先用业务唯一键与状态机，利用业务表唯一约束；或在与业务处理同一事务里插入消息 ID 去重记录；消息 ID 由生产者生成保持稳定，不用 offset；同一实体的事件带版本号，旧版本丢弃，避免乱序覆盖；去重窗口要覆盖最大重投时间。

> [!QUESTION] Redis 做幂等有什么风险？
> 业务成功但写完成标记失败或进程崩溃，会卡在处理中直到过期后重复执行；处理中 TTL 小于业务耗时会并发重复；Redis 主从切换或丢数据会丢失去重记录；与业务写入不在同一事务有不一致窗口。所以金额库存类强约束要以数据库唯一约束或条件更新为准，Redis 只作加速。
