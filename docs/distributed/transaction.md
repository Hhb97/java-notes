---
level: 深入
tags: [2PC, XA, TCC, Saga, 本地消息表, 事务消息, Seata]
summary: 从 2PC/XA 的强一致到 TCC、Saga、本地消息表、事务消息的最终一致，讲清 Seata AT 原理与各方案的选型取舍
---

# 分布式事务

> [!ABSTRACT] 核心要点
> - 一个业务操作跨多个数据库或多个服务时，本地事务的 ACID 管不到，需要分布式事务。方案分两大类：**刚性事务**（2PC / XA，强一致、持锁、性能差）和**柔性事务**（TCC、Saga、本地消息表、事务消息、最大努力通知，最终一致）。
> - 2PC 的硬伤：同步阻塞（准备后持锁等待）、协调者单点（宕机后参与者不知道该提交还是回滚）、第二阶段部分失败导致不一致。
> - TCC 把「锁」从数据库搬到业务层（冻结/预留资源），必须处理**幂等、空回滚、悬挂**三个问题，用事务控制表统一解决。
> - 互联网主流是「**可靠消息 + 最终一致**」：本地消息表或 RocketMQ 事务消息保证「本地事务成功 ⇔ 消息一定发出」，下游幂等消费，配合对账兜底。
> - Seata AT 是对业务无侵入的 2PC 变种：一阶段直接提交本地事务并记录 undo_log，靠**全局锁**做写隔离；二阶段提交只删 undo_log，回滚用前镜像补偿。默认全局读未提交。

## 从本地事务到分布式事务

单库事务靠 InnoDB 的 redo/undo log 与锁保证 ACID（见 [事务隔离与 MVCC](#/mysql/transaction)、[声明式事务原理](#/spring/tx)）。下面两类场景本地事务失效：

1. **单服务多数据源**：分库分表后一次下单写订单库和库存库；
2. **跨服务调用**：订单服务 RPC 调用库存服务和账户服务，每个服务有自己的库。

```java
@Transactional
public void createOrder(OrderDTO dto) {
    orderMapper.insert(order);               // 本地事务
    inventoryClient.deduct(dto.getSkuId());  // RPC：对方已提交，本地回滚管不到它
    accountClient.debit(dto.getUserId());    // 抛异常 → 订单回滚了，库存却已扣减
}
```

更隐蔽的是**超时**：`deduct` 超时抛异常，订单回滚了，但库存服务其实扣成功了。分布式事务要解决的就是这类「部分成功」与「结果未知」。

## 2PC 与 3PC

### 两阶段提交

<figure class="fig">
<svg viewBox="0 0 720 336" class="dg" role="img" aria-label="两阶段提交时序：协调者先发 prepare 收集投票，再发 commit，参与者在两阶段之间持有资源锁">
<rect class="b5" x="130" y="16" width="140" height="40" rx="8"/>
<text class="tb" x="200" y="36" text-anchor="middle" dominant-baseline="middle">TM 协调者</text>
<rect class="b1" x="370" y="16" width="140" height="40" rx="8"/>
<text class="tb" x="440" y="36" text-anchor="middle" dominant-baseline="middle">RM1 订单库</text>
<rect class="b1" x="570" y="16" width="140" height="40" rx="8"/>
<text class="tb" x="640" y="36" text-anchor="middle" dominant-baseline="middle">RM2 库存库</text>
<line class="ld" x1="200" y1="56" x2="200" y2="310"/>
<line class="ld" x1="440" y1="56" x2="440" y2="310"/>
<line class="ld" x1="640" y1="56" x2="640" y2="310"/>
<text class="ts" x="20" y="90">阶段一</text>
<text class="ts" x="20" y="106">准备 / 投票</text>
<text class="ts" x="20" y="230">阶段二</text>
<text class="ts" x="20" y="246">提交 / 回滚</text>
<rect class="b3" x="432" y="90" width="16" height="146"/>
<rect class="b3" x="632" y="110" width="16" height="146"/>
<line class="l" x1="200" y1="90" x2="430" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="315" y="82" text-anchor="middle">① prepare</text>
<line class="l" x1="200" y1="110" x2="630" y2="110" marker-end="url(#arr)"/>
<text class="ts" x="540" y="102" text-anchor="middle">① prepare</text>
<line class="l" x1="432" y1="150" x2="202" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="315" y="142" text-anchor="middle">② yes（已写 redo/undo）</text>
<line class="l" x1="632" y1="170" x2="202" y2="170" marker-end="url(#arr)"/>
<text class="ts" x="540" y="162" text-anchor="middle">② yes</text>
<text class="ts" x="540" y="205" text-anchor="middle">资源锁定（阻塞期）</text>
<text class="ts" x="210" y="196">TM 记录决策日志</text>
<line class="la" x1="200" y1="234" x2="430" y2="234" marker-end="url(#arr-a)"/>
<text class="ts" x="315" y="226" text-anchor="middle">③ commit</text>
<line class="la" x1="200" y1="254" x2="630" y2="254" marker-end="url(#arr-a)"/>
<text class="ts" x="540" y="246" text-anchor="middle">③ commit</text>
<line class="l" x1="440" y1="280" x2="202" y2="280" marker-end="url(#arr)"/>
<text class="ts" x="315" y="272" text-anchor="middle">④ ack</text>
<line class="l" x1="640" y1="300" x2="202" y2="300" marker-end="url(#arr)"/>
<text class="ts" x="540" y="292" text-anchor="middle">④ ack</text>
<text class="ta" x="360" y="328" text-anchor="middle">若 TM 在 ③ 之前宕机：已投 yes 的 RM 无权自行决定，只能持锁等待</text>
</svg>
<figcaption>图 1：2PC 时序与阻塞窗口</figcaption>
</figure>

- **阶段一（Prepare）**：协调者询问所有参与者能否提交；参与者执行事务、写 redo/undo、**不提交、持有锁**，回复 yes/no。
- **阶段二（Commit/Rollback）**：全部 yes 则发 commit，任一 no 或超时则发 rollback。

三大问题：

| 问题 | 表现 |
| --- | --- |
| 同步阻塞 | 从 prepare 到收到 commit，参与者一直持锁，吞吐受最慢参与者和网络 RTT 限制 |
| 协调者单点 | 协调者在发出决策前宕机，已投 yes 的参与者既不能提交也不能回滚（别人可能投了 no），只能等协调者恢复 |
| 数据不一致 | 阶段二 commit 只送达部分参与者后协调者宕机或网络分区，一部分提交了，一部分还在等待 |

### 3PC

把阶段一拆成 **CanCommit**（只询问、不锁资源）和 **PreCommit**（执行并锁资源），再 **DoCommit**；并给**参与者也加超时**：进入 PreCommit 后等不到 DoCommit，默认**提交**（因为能走到 PreCommit 说明所有人都同意过）。

它缓解了阻塞，但没有解决一致性：网络分区时，一部分参与者收到了协调者的 abort，另一部分超时后默认 commit，数据就不一致了。加上多一轮 RTT，工程上几乎没人用。

### XA 与 JTA

**XA** 是 X/Open DTP 模型定义的 2PC 接口规范：AP（应用）、TM（事务管理器）、RM（资源管理器，如数据库、MQ）。MySQL InnoDB 支持 XA：

```sql
XA START 'gtx-1001';
UPDATE stock SET num = num - 1 WHERE sku_id = 1;
XA END 'gtx-1001';
XA PREPARE 'gtx-1001';    -- 阶段一
XA COMMIT 'gtx-1001';     -- 阶段二（或 XA ROLLBACK）
XA RECOVER;               -- 查看处于 PREPARED 状态的悬挂事务
```

**JTA** 是 Java 对 XA 的 API 抽象（`UserTransaction`、`TransactionManager`、`XAResource`），实现有 Atomikos、Narayana，Spring Boot 可通过 `spring-boot-starter-jta-atomikos` 集成（Boot 3 起该 starter 已移除，需自行集成）。

> [!WARNING]
> MySQL 5.7 之前，处于 PREPARED 状态的 XA 事务在客户端断开或主库重启时存在丢失或主从不一致的问题，5.7 起修复。即便如此，XA 事务持锁时间长、隔离级别受限，**高并发链路不建议使用**，多用于金融等低并发强一致场景，或单服务多数据源的内部场景。

## TCC

### Try / Confirm / Cancel

TCC 把一个业务操作拆成三个接口，由业务方实现：

| 阶段 | 语义 | 以「扣款 100」为例 |
| --- | --- | --- |
| Try | 检查并**预留**资源 | 余额 ≥ 100，`balance -= 100, frozen += 100` |
| Confirm | 使用预留资源，**不再做检查**，必须能成功（失败则重试） | `frozen -= 100` |
| Cancel | 释放预留资源 | `balance += 100, frozen -= 100` |

TCC 的隔离性靠业务层的「冻结」字段实现：Try 之后其他事务看不到这 100 元，因此不需要数据库长时间持锁，Try 本地事务一提交锁就释放了。代价是**业务侵入大**：每个参与者要写三个接口和冻结字段。

### 空回滚、悬挂与幂等

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="TCC 异常时序：Try 请求在网络中滞留，TM 超时发起 Cancel 先到达形成空回滚，之后迟到的 Try 被拒绝以防悬挂">
<rect class="b5" x="90" y="16" width="140" height="40" rx="8"/>
<text class="tb" x="160" y="36" text-anchor="middle" dominant-baseline="middle">TM 发起方</text>
<rect class="b1" x="450" y="16" width="140" height="40" rx="8"/>
<text class="tb" x="520" y="36" text-anchor="middle" dominant-baseline="middle">账户服务 RM</text>
<line class="ld" x1="160" y1="56" x2="160" y2="276"/>
<line class="ld" x1="520" y1="56" x2="520" y2="276"/>
<line class="ld" x1="160" y1="80" x2="516" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="250" y="96" text-anchor="middle">① Try（网络拥堵，迟到）</text>
<text class="ts" x="150" y="140" text-anchor="end">Try 超时，决议回滚</text>
<line class="la" x1="160" y1="170" x2="516" y2="170" marker-end="url(#arr-a)"/>
<text class="ts" x="420" y="162" text-anchor="middle">② Cancel</text>
<text class="ta" x="530" y="170" dominant-baseline="middle">无 Try 记录 → 空回滚</text>
<text class="ts" x="530" y="190" dominant-baseline="middle">写入 CANCELED 控制记录</text>
<text class="ts" x="530" y="240" dominant-baseline="middle">已存在 CANCELED 记录</text>
<text class="ta" x="530" y="260" dominant-baseline="middle">→ 拒绝执行 Try，防悬挂</text>
<text class="ts" x="360" y="292" text-anchor="middle">另外 Confirm / Cancel 可能被重复调用，都要先查控制表保证幂等</text>
</svg>
<figcaption>图 2：TCC 的空回滚与悬挂</figcaption>
</figure>

- **空回滚**：Try 没执行（或没到达），Cancel 却被调用。Cancel 不能报错也不能真的去「解冻」，应识别出来直接返回成功。
- **悬挂**：Cancel 先执行完，迟到的 Try 又到了，冻结了资源却再也没有 Confirm/Cancel 来处理它，资源永远被冻结。Try 执行前要检查该事务是否已回滚。
- **幂等**：TM 重试会让 Confirm/Cancel 被调用多次。

三个问题统一用一张**事务控制表**（`xid` + `branch_id` 唯一）解决：

```java
@Transactional
public boolean tryDebit(String xid, long userId, BigDecimal amount) {
    // 插入 TRIED 记录；若已存在（说明已被 Cancel 过）则唯一键冲突 → 拒绝，防悬挂
    if (!txControlMapper.insertIfAbsent(xid, Status.TRIED)) {
        return false;
    }
    return accountMapper.freeze(userId, amount) == 1;   // balance >= amount 才更新
}

@Transactional
public boolean cancel(String xid, long userId, BigDecimal amount) {
    TxControl ctl = txControlMapper.selectForUpdate(xid);
    if (ctl == null) {                                   // 空回滚：Try 未执行
        txControlMapper.insert(xid, Status.CANCELED);    // 占位，供迟到的 Try 识别
        return true;
    }
    if (ctl.getStatus() == Status.CANCELED) {            // 幂等
        return true;
    }
    accountMapper.unfreeze(userId, amount);
    txControlMapper.updateStatus(xid, Status.CANCELED);
    return true;
}
```

> [!TIP]
> Seata 1.5.1 起的 TCC 模式提供 `@TwoPhaseBusinessAction(useTCCFence = true)`，框架用 `tcc_fence_log` 表自动处理幂等、空回滚和悬挂，不必手写控制表。

## Saga

Saga（1987 年 Garcia-Molina 提出）把长事务拆成一串本地事务 T1…Tn，每个 Ti 都有补偿 Ci。全部成功即完成；Tk 失败则逆序执行 Ck-1…C1（**向后恢复**），或者重试 Tk 直到成功（**向前恢复**）。

| 方式 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 协同式（Choreography） | 各服务监听上一步的事件，自己决定下一步/补偿 | 去中心化、简单场景开发快 | 流程散落在各服务，难以追踪，易形成循环依赖 |
| 编排式（Orchestration） | 中心编排器（状态机）按定义调用各步骤与补偿 | 流程可视、易监控、易改 | 编排器成为核心组件，需要高可用 |

Saga **没有隔离性**：T1 已提交、对外可见，后续步骤失败才补偿，期间别人可能读到或基于它做了操作（比如已经给用户发了「下单成功」短信）。缓解手段：

- **语义锁**：状态字段标记 `PENDING`，其他操作看到 PENDING 就等待或拒绝；
- **可交换的更新**：设计成加减操作而非覆盖，补偿顺序不敏感；
- **调整步骤顺序**：把可能失败的、不可补偿的步骤（如发短信、调用外部支付）放到最后，称为「关键点之后只向前」。

补偿操作本身要**幂等且最终必须成功**（失败就重试 + 告警人工介入）。Seata Saga 模式基于状态机 JSON 定义编排流程。

## 本地消息表

eBay 提出的经典方案：把「发消息」变成本地事务的一部分。

<figure class="fig">
<svg viewBox="0 0 720 270" class="dg" role="img" aria-label="本地消息表：业务数据与消息记录同一本地事务写入，定时任务扫描发送到 MQ，成功后标记已发送，下游幂等消费">
<rect class="bg" x="20" y="20" width="300" height="130" rx="12"/>
<text class="ts" x="36" y="40">① 订单服务：同一个本地事务</text>
<rect class="b1" x="40" y="56" width="120" height="48" rx="8"/>
<text class="tb" x="100" y="80" text-anchor="middle" dominant-baseline="middle">订单表</text>
<rect class="b1" x="180" y="56" width="120" height="48" rx="8"/>
<text class="tb" x="240" y="80" text-anchor="middle" dominant-baseline="middle">消息表</text>
<text class="tm" x="170" y="130" text-anchor="middle">INSERT order + msg(NEW)</text>
<line class="l" x1="240" y1="104" x2="240" y2="178" marker-end="url(#arr)"/>
<text class="ts" x="250" y="168">② 扫描</text>
<rect class="b3" x="40" y="180" width="260" height="48" rx="8"/>
<text class="tb" x="170" y="204" text-anchor="middle" dominant-baseline="middle">定时任务：捞 NEW / 发送超时消息</text>
<line class="l" x1="300" y1="204" x2="378" y2="204" marker-end="url(#arr)"/>
<text class="ts" x="340" y="196" text-anchor="middle">③ 投递</text>
<rect class="b5" x="380" y="180" width="120" height="48" rx="8"/>
<text class="tb" x="440" y="204" text-anchor="middle" dominant-baseline="middle">MQ</text>
<line class="l" x1="500" y1="204" x2="558" y2="204" marker-end="url(#arr)"/>
<rect class="b2" x="560" y="180" width="140" height="48" rx="8"/>
<text class="tb" x="630" y="204" text-anchor="middle" dominant-baseline="middle">库存服务</text>
<text class="ts" x="630" y="250" text-anchor="middle">⑤ 幂等消费，失败重试</text>
<line class="ld" x1="440" y1="180" x2="440" y2="80"/>
<line class="ld" x1="440" y1="80" x2="302" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="450" y="120">④ 发送成功：status = SENT</text>
</svg>
<figcaption>图 3：本地消息表的可靠投递流程</figcaption>
</figure>

要点：

- 业务数据与消息记录在**同一个本地事务**里提交，保证「业务成功 ⇔ 消息记录存在」；
- 投递是**至少一次**：发送成功但更新 SENT 失败会重发，所以下游必须幂等；
- 可以事务提交后立即异步发送一次（`TransactionSynchronization.afterCommit`），定时任务只做兜底，降低延迟；
- 消息表要有 `next_retry_time`、`retry_count`，超过次数告警；定期归档已发送记录，避免表膨胀。

缺点是消息表与业务库耦合，每个服务都要建表、写扫描任务。

## 事务消息

RocketMQ 把本地消息表的能力内置到 MQ：先发**半消息**（对消费者不可见）→ 执行本地事务 → 根据结果 commit / rollback 半消息；若 Producer 宕机未告知结果，Broker 定期**回查**本地事务状态。这样业务方不用自建消息表，但需要实现回查接口。原理详见 [RocketMQ 原理与事务消息](#/mw/rocketmq)。

> [!NOTE]
> Kafka 的「事务」解决的是**多分区原子写 + Exactly-Once 流处理**，与数据库本地事务无关，不能直接替代 RocketMQ 事务消息。用 Kafka 时通常还是本地消息表或 CDC（如 Debezium 读 binlog，即 Outbox 模式）。

## 最大努力通知

适用于跨企业、对方系统不可控的场景，典型是**支付结果回调**：

1. 支付平台按递增间隔多次回调商户的通知地址，直到对方返回约定的成功响应或达到最大次数；
2. 商户必须幂等处理回调，并验签；
3. 平台提供**查询接口**，商户收不到通知时主动查询；
4. 每日**对账文件**兜底。

它不保证一定送达，「最大努力 + 主动查询 + 对账」组合起来达到最终一致。

## Seata AT 模式

Seata 的角色：**TC**（事务协调者，独立部署的 Seata Server，维护全局事务和全局锁）、**TM**（`@GlobalTransactional` 所在的发起方，开启/提交/回滚全局事务）、**RM**（各服务内的数据源代理，注册分支、执行分支提交回滚）。全局事务 ID 为 **XID**，通过 RPC 上下文在服务间传递。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="Seata AT 模式：一阶段记录前后镜像与 undo_log 并获取全局锁后本地提交；二阶段提交时异步删除 undo_log，回滚时校验后镜像并用前镜像补偿">
<rect class="bg" x="20" y="16" width="360" height="274" rx="12"/>
<text class="ts" x="36" y="36">一阶段：RM 在业务本地事务中完成</text>
<rect class="b1" x="40" y="48" width="320" height="32" rx="6"/>
<text class="t" x="200" y="64" text-anchor="middle" dominant-baseline="middle">解析 SQL，查询 before image</text>
<line class="l" x1="200" y1="80" x2="200" y2="90" marker-end="url(#arr)"/>
<rect class="b1" x="40" y="90" width="320" height="32" rx="6"/>
<text class="t" x="200" y="106" text-anchor="middle" dominant-baseline="middle">执行业务 SQL</text>
<line class="l" x1="200" y1="122" x2="200" y2="132" marker-end="url(#arr)"/>
<rect class="b1" x="40" y="132" width="320" height="32" rx="6"/>
<text class="t" x="200" y="148" text-anchor="middle" dominant-baseline="middle">查询 after image，生成 undo_log</text>
<line class="l" x1="200" y1="164" x2="200" y2="174" marker-end="url(#arr)"/>
<rect class="b3" x="40" y="174" width="320" height="32" rx="6"/>
<text class="t" x="200" y="190" text-anchor="middle" dominant-baseline="middle">向 TC 注册分支并申请全局锁</text>
<line class="l" x1="200" y1="206" x2="200" y2="216" marker-end="url(#arr)"/>
<rect class="b1" x="40" y="216" width="320" height="32" rx="6"/>
<text class="t" x="200" y="232" text-anchor="middle" dominant-baseline="middle">业务数据 + undo_log 一起本地提交</text>
<text class="ts" x="200" y="272" text-anchor="middle">本地锁随即释放，全局锁保持到二阶段结束</text>
<rect class="bg" x="400" y="16" width="340" height="274" rx="12"/>
<text class="ts" x="416" y="36">二阶段：TC 根据 TM 决议驱动各 RM</text>
<line class="la" x1="360" y1="232" x2="418" y2="96" marker-end="url(#arr-a)"/>
<line class="la" x1="360" y1="232" x2="418" y2="214" marker-end="url(#arr-a)"/>
<rect class="b2" x="420" y="56" width="300" height="80" rx="8"/>
<text class="tb" x="570" y="76" text-anchor="middle" dominant-baseline="middle">全局提交</text>
<text class="ts" x="570" y="98" text-anchor="middle" dominant-baseline="middle">数据早已提交，只需异步批量删 undo_log</text>
<text class="ts" x="570" y="118" text-anchor="middle" dominant-baseline="middle">释放全局锁，开销很小</text>
<rect class="b4" x="420" y="156" width="300" height="118" rx="8"/>
<text class="tb" x="570" y="176" text-anchor="middle" dominant-baseline="middle">全局回滚</text>
<text class="ts" x="570" y="198" text-anchor="middle" dominant-baseline="middle">比对 after image 与当前数据</text>
<text class="ts" x="570" y="218" text-anchor="middle" dominant-baseline="middle">一致：用 before image 生成反向 SQL 补偿</text>
<text class="ts" x="570" y="238" text-anchor="middle" dominant-baseline="middle">不一致：数据被绕过 Seata 修改，需人工处理</text>
<text class="ts" x="570" y="258" text-anchor="middle" dominant-baseline="middle">删除 undo_log，释放全局锁</text>
</svg>
<figcaption>图 4：Seata AT 模式两阶段原理</figcaption>
</figure>

### 写隔离：全局锁

一阶段本地提交后数据库行锁已经释放，如果别的全局事务紧接着改同一行，回滚就会覆盖别人的修改。所以：

- 本地提交**之前**必须拿到该行的**全局锁**（TC 中按 `表名:主键` 记录），拿不到就重试（`lock.retryInterval`、`lock.retryTimes`），超时则回滚本地事务、释放本地锁；
- 二阶段结束才释放全局锁。

注意这里存在两把锁的配合：事务 A 持全局锁、在二阶段回滚时需要该行的**本地锁**；若事务 B 持该行本地锁在等全局锁，A 的回滚会等待 B，B 拿全局锁重试超时后放弃本地锁，A 才能完成回滚——不会死锁，但会有等待。

### 读隔离

Seata AT 默认全局隔离级别是**读未提交**：一阶段已提交的数据别人可以直接读到，哪怕全局事务后续回滚。需要读已提交时，对查询使用 `SELECT ... FOR UPDATE`，Seata 代理会检查全局锁，被锁则等待。普通查询不受影响，性能才有保证。

### 使用方式

```java
@GlobalTransactional(name = "create-order", rollbackFor = Exception.class, timeoutMills = 60000)
public void createOrder(OrderDTO dto) {
    orderMapper.insert(toOrder(dto));        // 本服务分支
    inventoryClient.deduct(dto.getSkuId());  // XID 通过 RPC 上下文传播，远端 RM 自动加入
    accountClient.debit(dto.getUserId(), dto.getAmount());
}
```

每个参与库需要建 `undo_log` 表（字段含 `branch_id`、`xid`、`rollback_info`、`log_status` 等）。Seata 还提供 TCC、Saga、XA 三种模式，可以在同一系统按场景混用。

> [!CAUTION] 绕过 Seata 修改数据导致回滚失败
> 运维脚本、其他未接入 Seata 的服务直接改了参与全局事务的行，回滚时 after image 校验不一致，Seata 不敢覆盖，分支会一直重试回滚，同时**全局锁不释放**，后续涉及这些行的全局事务全部拿锁超时。对这类写入要么接入 Seata，要么在本地事务上加 `@GlobalLock` 让它也检查全局锁。

## 方案选型对比

| 方案 | 一致性 | 性能 | 业务侵入 | 适用场景 |
| --- | --- | --- | --- | --- |
| 2PC / XA | 强一致 | 低（全程持锁） | 低 | 低并发、强一致，单应用多数据源 |
| Seata AT | 最终一致（默认读未提交） | 中 | 很低（注解 + undo_log 表） | 内部服务、关系库、并发中等 |
| TCC | 最终一致，隔离性好 | 高 | 高（三个接口 + 冻结字段） | 资金、库存等核心资源，需要业务级隔离 |
| Saga | 最终一致，无隔离 | 高 | 中（正向 + 补偿） | 长流程、跨多个服务或外部系统 |
| 本地消息表 | 最终一致 | 高 | 中（消息表 + 扫描） | 异步解耦、对实时性要求不高 |
| 事务消息 | 最终一致 | 高 | 低～中（回查接口） | 使用 RocketMQ 的异步场景 |
| 最大努力通知 | 弱最终一致 | 高 | 低 | 跨企业通知、支付回调 |

> [!TIP] 选型思路
> 1. 先问能不能**避免**分布式事务：把强相关数据放到同一个库（按用户 ID 分片使同一用户数据同库），或调整业务流程（先扣库存后建单 + 超时释放）。
> 2. 上游需要同步拿到结果且资源敏感：TCC；内部服务追求开发效率：Seata AT。
> 3. 下游可异步：本地消息表 / 事务消息 + 幂等消费，这是大多数互联网系统的默认选择。
> 4. 无论哪种，都要有**对账**与人工补偿通道。

## 生产实践与踩坑

- **把 RPC 超时当失败回滚**：前文例子中，库存服务实际扣减成功。所有柔性事务都要求下游提供「查询状态」或幂等的「补偿」接口，超时时进入「未知」状态由补偿流程确认。
- **`@Transactional` 中发 MQ**：消息发出后事务回滚，下游收到了「不存在的订单」。消息要么走本地消息表，要么在 `afterCommit` 回调中发送（仍可能丢，需兜底扫描）。
- **TCC Confirm 失败**：Confirm 不应包含业务检查，只做「把冻结变成已用」；失败就由 TC 重试，最终仍失败要告警人工处理。不要在 Confirm 中调用外部不稳定服务。
- **Seata 全局锁热点**：大量全局事务更新同一行（如活动总库存），拿全局锁串行化，RT 暴涨甚至大面积回滚。热点资源不要放进 AT 事务，改用 Redis 预扣 + 异步落库，或拆分库存（见 [秒杀系统设计](#/design/seckill)）。
- **undo_log 膨胀 / 未清理**：TC 宕机或二阶段异步删除积压，undo_log 表变大。定期监控其行数和 `log_created` 最早时间。
- **XA 悬挂事务**：应用宕机留下 PREPARED 状态的 XA 事务，一直持锁。用 `XA RECOVER` 找出后根据 TM 日志手动 `XA COMMIT/ROLLBACK`。

## 相关阅读

- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：Saga 与 Outbox 的工程化
- [案例：订单、支付与对账系统设计详解](#/design/case-payment)：支付场景的最终一致
- [TiDB 架构：TiKV、PD、Raft 与分布式事务](#/db/tidb-arch)：Percolator 分布式事务
- [幂等设计与重试：幂等键、去重表与超时未知](#/distributed/idempotent)：补偿与确认的幂等要求
- [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)：双写、对账与修复

## 面试追问

> [!QUESTION] 2PC 有什么问题？3PC 解决了吗？
> 2PC 同步阻塞、协调者单点、阶段二部分提交导致不一致。3PC 增加 CanCommit 并为参与者引入超时默认提交，减少阻塞，但网络分区时部分节点收到 abort、部分超时提交，仍不一致，且多一轮通信，实际很少使用。

> [!QUESTION] TCC 的空回滚和悬挂是怎么产生的？如何解决？
> Try 因网络拥堵未到达，TM 超时发起 Cancel，Cancel 找不到 Try 记录就是空回滚，应直接成功并记录 CANCELED；之后迟到的 Try 若执行就会冻结资源却无人处理，即悬挂，Try 前检查控制表中已有 CANCELED 则拒绝。两者与幂等一起用 xid 唯一的事务控制表解决。

> [!QUESTION] Seata AT 与 XA 的区别？
> XA 一阶段 prepare 不提交、持数据库锁直到二阶段，隔离性由数据库保证；AT 一阶段直接提交并释放数据库锁，用 undo_log 实现回滚、用 TC 的全局锁实现写隔离，吞吐更高但默认读未提交，且回滚可能因脏写失败。

> [!QUESTION] 本地消息表如何保证消息不丢、不重？
> 不丢：消息与业务数据同一本地事务写入，定时任务扫描未发送记录持续重试直到成功；不重做不到，投递是至少一次，必须由消费方用唯一业务键做幂等。

> [!QUESTION] 下单、扣库存、扣余额，你会如何选型？
> 库存和余额是核心资源，需要隔离（防止超卖/透支）：可用 TCC 冻结；若追求开发效率且并发中等可用 Seata AT。积分、通知、物流等非核心后续动作用事务消息异步完成。热点库存不进分布式事务，走 Redis 预扣 + MQ 异步落库，再用对账保证一致。
