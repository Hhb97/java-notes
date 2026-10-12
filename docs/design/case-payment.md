---
level: 高级
tags: [架构案例, 支付, 订单, 对账, 状态机, 幂等, 分布式事务, 记账]
summary: 以电商为背景，完整拆解订单、支付与对账系统：订单与支付单分离、状态机、幂等与重复支付防护、回调与主动查询补偿、超时关单、本地消息表保证最终一致、复式记账与 T+1 渠道对账（长款/短款处理），含数据模型、容量估算、降级与上线方案。
---

# 案例：订单、支付与对账系统设计详解

> [!ABSTRACT] 核心要点
> - 支付系统的第一原则是**“钱不能错”**：宁可慢、宁可失败，也不能多扣、少扣、丢单。所以设计围绕 **状态机、幂等、补偿、对账** 四件事展开。
> - **订单（业务）与支付单（资金）分离**：一个订单可对应多次支付尝试；订单状态由支付结果**驱动**，但两者各自维护状态机与幂等。
> - 与渠道（微信/支付宝/银行）交互**天然不可靠**：请求会超时、回调会丢失/重复/乱序。因此必须 **回调验签 + 幂等落库 + 主动查询补偿 + 定时对账** 四重保险。
> - 跨服务一致性用**最终一致**：**本地消息表 / 事务消息 + 消费端幂等**，而不是在支付链路上强行 2PC，见 [分布式事务](#/distributed/transaction)。
> - **对账**是最后一道防线：与渠道 T+1 账单逐笔核对，发现**长款**（我们有、渠道无）与**短款**（渠道有、我们无）并自动/人工处理。
> - 金额一律**整数分（long / DECIMAL）**，绝不用 `float/double`。

> [!NOTE] 说明
> 容量数字均为**用于推演的假设**，实际按业务数据调整；渠道接口细节以各渠道官方文档为准，本文关注通用的架构与可靠性设计。

## 一、需求与约束

### 1. 功能范围

下单 → 支付（多渠道：微信、支付宝、银行卡、余额/优惠券组合）→ 支付结果通知 → 订单状态流转 → 退款 → 对账与差错处理 → 财务记账。

### 2. 非功能目标（假设）

| 维度 | 目标 |
| --- | --- |
| 正确性 | **资金零差错**；任何时刻可追溯；与渠道日对账平衡 |
| 可用性 | 支付核心链路 99.99%；渠道故障时可路由切换/降级 |
| 性能 | 创建支付 P99 < 300ms（不含用户端支付耗时）；回调处理 P99 < 100ms |
| 吞吐 | 日常 500 TPS，大促峰值 5000 TPS（订单），支付约为订单的 60~80% |
| 一致性 | 订单、支付单、账务**最终一致**，延迟 < 秒级；对账周期 T+1，关键渠道可日内多次 |
| 安全合规 | 全链路签名、敏感信息加密脱敏、操作审计、权限隔离（见 [加密、签名与密钥](#/security/crypto)） |

### 3. 容量估算（假设）

- 日订单 500 万，支付成功约 400 万笔，日均 ≈ 60 笔/秒，大促峰值按 **平均的 10~20 倍**估算 ≈ 1000~2000 笔/秒，留余量到 5000 TPS；
- 支付单记录：约 600 万/天（含失败与重试）× 1KB ≈ 6 GB/天，一年约 2 TB（含索引翻倍）→ **需要分库分表与冷热分离**（见 [分库分表](#/mysql/sharding)）；
- 回调：每笔支付至少 1 次回调，渠道可能重发，**峰值回调 QPS 与支付 QPS 同级**，必须异步化快速返回。

## 二、核心设计决策（ADR）

| 决策点 | 方案 | 理由 / 取舍 |
| --- | --- | --- |
| 订单与支付关系 | **订单单 + 支付单分离**，一对多 | 用户可换渠道重试、部分支付、拆单；资金状态不污染业务状态 |
| 状态管理 | **显式状态机 + 乐观锁/条件更新** | 防止状态倒退与并发乱序（如“已成功”被“失败回调”覆盖） |
| 幂等 | 业务幂等号（商户订单号/支付单号）+ 唯一索引 | 重试与重复回调安全，见 [分布式 ID](#/distributed/id) |
| 渠道交互 | **同步下单 + 异步回调 + 主动查询补偿** | 回调不可靠，不能只靠回调 |
| 跨服务一致性 | **本地消息表 / RocketMQ 事务消息，最终一致** | 避免分布式强一致带来的性能与可用性代价 |
| 超时关单 | **延迟消息**（RocketMQ 延迟/Delay Queue）+ 兜底扫描 | 精确释放库存/优惠券；兜底防止消息丢失 |
| 账务 | **复式记账、只追加不修改** | 可审计、可对账、可冲正 |
| 金额 | **整数分 + 币种** | 避免浮点误差 |
| 对账 | **T+1 渠道账单对账 + 内部三方对账** | 发现一切漏单与错账 |
| 渠道故障 | 多渠道路由 + 熔断降级 | 见 [限流、熔断与降级](#/distributed/governance) |

## 三、总体架构

<figure class="fig">
<svg viewBox="0 0 820 440" class="dg" role="img" aria-label="订单支付系统总体架构：客户端经网关到订单服务和支付服务，支付服务通过渠道适配层对接微信支付宝银行，回调网关接收渠道异步通知并验签后落库，消息队列驱动订单状态更新、库存释放和通知，账务服务记账，对账服务拉取渠道账单与内部流水比对并生成差错单">
<rect class="b" x="20" y="30" width="100" height="44" rx="8"/>
<text class="tb" x="70" y="52" text-anchor="middle" dominant-baseline="middle">App / Web</text>
<rect class="b1" x="150" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="205" y="52" text-anchor="middle" dominant-baseline="middle">API 网关</text>
<line class="l" x1="120" y1="52" x2="150" y2="52" marker-end="url(#arr)"/>
<rect class="b3" x="30" y="120" width="170" height="70" rx="10"/>
<text class="tb" x="115" y="144" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<text class="ts" x="115" y="166" text-anchor="middle">订单状态机 · 库存/券锁定</text>
<rect class="b3" x="250" y="120" width="170" height="70" rx="10"/>
<text class="tb" x="335" y="144" text-anchor="middle" dominant-baseline="middle">支付服务</text>
<text class="ts" x="335" y="166" text-anchor="middle">支付单状态机 · 路由 · 幂等</text>
<line class="l" x1="190" y1="74" x2="130" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="225" y1="74" x2="320" y2="120" marker-end="url(#arr)"/>
<rect class="b5" x="470" y="120" width="170" height="70" rx="10"/>
<text class="tb" x="555" y="144" text-anchor="middle" dominant-baseline="middle">渠道适配层</text>
<text class="ts" x="555" y="166" text-anchor="middle">签名 · 协议 · 重试 · 熔断</text>
<line class="l" x1="420" y1="155" x2="470" y2="155" marker-end="url(#arr)"/>
<rect class="b4" x="690" y="90" width="120" height="30" rx="6"/>
<text class="ts" x="750" y="105" text-anchor="middle" dominant-baseline="middle">微信支付</text>
<rect class="b4" x="690" y="130" width="120" height="30" rx="6"/>
<text class="ts" x="750" y="145" text-anchor="middle" dominant-baseline="middle">支付宝</text>
<rect class="b4" x="690" y="170" width="120" height="30" rx="6"/>
<text class="ts" x="750" y="185" text-anchor="middle" dominant-baseline="middle">银行 / 网银</text>
<line class="l" x1="640" y1="145" x2="690" y2="145" marker-end="url(#arr)"/>
<rect class="b4" x="470" y="230" width="170" height="56" rx="10"/>
<text class="tb" x="555" y="250" text-anchor="middle" dominant-baseline="middle">回调网关</text>
<text class="ts" x="555" y="270" text-anchor="middle">验签 · 落库 · 秒回成功</text>
<line class="la" x1="750" y1="200" x2="640" y2="250" marker-end="url(#arr-a)"/>
<text class="ta" x="730" y="236" text-anchor="start">异步通知</text>
<rect class="b2" x="250" y="230" width="170" height="56" rx="10"/>
<text class="tb" x="335" y="250" text-anchor="middle" dominant-baseline="middle">消息队列</text>
<text class="ts" x="335" y="270" text-anchor="middle">支付结果 · 关单 · 通知</text>
<line class="l" x1="470" y1="258" x2="420" y2="258" marker-end="url(#arr)"/>
<line class="l" x1="335" y1="230" x2="335" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="230" x2="150" y2="190" marker-end="url(#arr)"/>
<rect class="b5" x="30" y="230" width="170" height="56" rx="10"/>
<text class="tb" x="115" y="250" text-anchor="middle" dominant-baseline="middle">库存 / 营销 / 通知</text>
<text class="ts" x="115" y="270" text-anchor="middle">释放·核销·推送</text>
<rect class="b1" x="30" y="330" width="170" height="70" rx="10"/>
<text class="tb" x="115" y="354" text-anchor="middle" dominant-baseline="middle">账务服务</text>
<text class="ts" x="115" y="376" text-anchor="middle">复式记账 · 只追加</text>
<rect class="b1" x="250" y="330" width="170" height="70" rx="10"/>
<text class="tb" x="335" y="354" text-anchor="middle" dominant-baseline="middle">对账服务</text>
<text class="ts" x="335" y="376" text-anchor="middle">T+1 账单 · 差错单</text>
<rect class="b" x="470" y="330" width="170" height="70" rx="10"/>
<text class="tb" x="555" y="354" text-anchor="middle" dominant-baseline="middle">渠道账单</text>
<text class="ts" x="555" y="376" text-anchor="middle">SFTP/API 下载</text>
<line class="l" x1="470" y1="365" x2="420" y2="365" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="365" x2="200" y2="365" marker-end="url(#arr)"/>
<text class="ts" x="520" y="426" text-anchor="middle">存储：MySQL（分库分表）· Redis（幂等/限流）· 对象存储（账单文件）</text>
</svg>
<figcaption>图 1：订单支付系统总体架构</figcaption>
</figure>

分层职责：

| 组件 | 职责 | 关键点 |
| --- | --- | --- |
| 订单服务 | 订单创建、状态流转、库存/券锁定与释放 | 订单状态仅由“支付成功/关单/退款”事件驱动 |
| 支付服务 | 创建支付单、渠道路由、支付结果处理、退款 | 支付单状态机、幂等、乐观锁 |
| 渠道适配层 | 屏蔽各渠道差异：签名、报文、超时、重试 | 每个渠道独立线程池/熔断，**互不拖累**（舱壁） |
| 回调网关 | 接收异步通知 | **验签 → 落库 → 立即返回成功**，后续异步处理 |
| 账务服务 | 复式分录、账户余额 | 只追加，冲正代替修改 |
| 对账服务 | 渠道账单 vs 内部流水 | 差错分类与处理流程 |

## 四、订单与支付状态机

### 1. 为什么要“订单单”和“支付单”分离

- 一个订单可能**多次支付**（第一次失败换渠道、超时后重新发起、组合支付）；
- **订单是业务事实**（买了什么），**支付单是资金事实**（一次支付尝试），生命周期不同；
- 渠道侧的“商户订单号”应当用**支付单号**（每次尝试唯一），防止同一订单号被渠道拒绝或重复。

### 2. 状态机

<figure class="fig">
<svg viewBox="0 0 800 360" class="dg" role="img" aria-label="订单状态机从待支付到已支付、已发货、已完成，待支付可超时关闭，已支付可退款；支付单状态机从初始化到支付中，再到成功、失败或关闭，成功后可退款，关闭前需主动查询渠道确认">
<text class="th" x="20" y="24">订单状态机</text>
<rect class="b1" x="20" y="40" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="60" text-anchor="middle" dominant-baseline="middle">待支付</text>
<rect class="b2" x="180" y="40" width="110" height="40" rx="8"/>
<text class="tb" x="235" y="60" text-anchor="middle" dominant-baseline="middle">已支付</text>
<rect class="b3" x="340" y="40" width="110" height="40" rx="8"/>
<text class="tb" x="395" y="60" text-anchor="middle" dominant-baseline="middle">已发货</text>
<rect class="b3" x="500" y="40" width="110" height="40" rx="8"/>
<text class="tb" x="555" y="60" text-anchor="middle" dominant-baseline="middle">已完成</text>
<rect class="b4" x="20" y="120" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="140" text-anchor="middle" dominant-baseline="middle">已关闭</text>
<rect class="b4" x="180" y="120" width="110" height="40" rx="8"/>
<text class="tb" x="235" y="140" text-anchor="middle" dominant-baseline="middle">退款中/已退款</text>
<line class="l" x1="130" y1="60" x2="180" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="60" x2="340" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="60" x2="500" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="75" y1="80" x2="75" y2="120" marker-end="url(#arr)"/>
<line class="l" x1="235" y1="80" x2="235" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="85" y="104" text-anchor="start">超时/取消</text>
<text class="ts" x="245" y="104" text-anchor="start">退款</text>
<text class="ts" x="155" y="52" text-anchor="middle">支付成功</text>
<text class="th" x="20" y="200">支付单状态机</text>
<rect class="b" x="20" y="216" width="100" height="40" rx="8"/>
<text class="tb" x="70" y="236" text-anchor="middle" dominant-baseline="middle">INIT</text>
<rect class="b5" x="160" y="216" width="110" height="40" rx="8"/>
<text class="tb" x="215" y="236" text-anchor="middle" dominant-baseline="middle">PAYING</text>
<rect class="b2" x="330" y="216" width="110" height="40" rx="8"/>
<text class="tb" x="385" y="236" text-anchor="middle" dominant-baseline="middle">SUCCESS</text>
<rect class="b4" x="330" y="290" width="110" height="40" rx="8"/>
<text class="tb" x="385" y="310" text-anchor="middle" dominant-baseline="middle">FAILED</text>
<rect class="b4" x="500" y="290" width="110" height="40" rx="8"/>
<text class="tb" x="555" y="310" text-anchor="middle" dominant-baseline="middle">CLOSED</text>
<rect class="b3" x="500" y="216" width="130" height="40" rx="8"/>
<text class="tb" x="565" y="236" text-anchor="middle" dominant-baseline="middle">REFUNDED</text>
<line class="l" x1="120" y1="236" x2="160" y2="236" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="236" x2="330" y2="236" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="256" x2="340" y2="290" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="236" x2="500" y2="236" marker-end="url(#arr)"/>
<line class="l" x1="270" y1="250" x2="500" y2="298" marker-end="url(#arr)"/>
<text class="ts" x="300" y="228" text-anchor="middle">渠道确认成功</text>
<text class="ts" x="470" y="228" text-anchor="middle">退款</text>
<text class="ts" x="620" y="292" text-anchor="start">关闭前须先查渠道，确认未支付</text>
<rect class="bg" x="660" y="40" width="130" height="120" rx="8"/>
<text class="ts" x="670" y="62" text-anchor="start">规则：</text>
<text class="ts" x="670" y="82" text-anchor="start">状态只能前进</text>
<text class="ts" x="670" y="100" text-anchor="start">SUCCESS 是终态</text>
<text class="ts" x="670" y="118" text-anchor="start">不被失败覆盖</text>
<text class="ts" x="670" y="136" text-anchor="start">更新带旧状态</text>
<text class="ts" x="670" y="152" text-anchor="start">做条件更新</text>
</svg>
<figcaption>图 2：订单状态机与支付单状态机</figcaption>
</figure>

**用条件更新实现状态机（乐观并发控制）**，这是防乱序与重复处理的核心：

```sql
-- 只有当前状态是 PAYING 才能变成 SUCCESS；影响行数为 0 表示已被处理（幂等）或状态非法
UPDATE pay_order
   SET status = 'SUCCESS', channel_trade_no = ?, paid_time = ?, version = version + 1
 WHERE pay_no = ? AND status IN ('INIT','PAYING');
```

```java
@Transactional
public void onPaySuccess(String payNo, String channelTradeNo, long amountFen) {
    PayOrder p = payOrderMapper.selectByPayNo(payNo);
    if (p.getAmountFen() != amountFen) throw new AmountMismatchException(payNo);          // 金额必须与下单一致
    int n = payOrderMapper.markSuccess(payNo, channelTradeNo);                              // 条件更新
    if (n == 0) return;                                                                     // 已处理：幂等返回
    outbox.save(new OutboxMsg("PAY_SUCCESS", payNo, p.getOrderNo()));                       // 同一事务写本地消息表
}
```

**终态保护**：`SUCCESS` 不会被迟到的 `FAILED/CLOSED` 回调覆盖；若出现“已关闭的支付单后来收到成功通知”，说明**用户实际付了钱**，必须走**异常入账 + 订单恢复或自动退款**流程，不能忽略。

## 五、支付主流程与可靠性

### 1. 创建支付

<figure class="fig">
<svg viewBox="0 0 800 400" class="dg" role="img" aria-label="支付主流程时序：用户提交支付，订单服务校验订单状态，支付服务以幂等键创建支付单并调用渠道下单，返回支付参数给客户端拉起支付；渠道异步回调到回调网关，验签后落库并快速返回，消息队列驱动支付服务更新状态，通过本地消息表通知订单服务，订单变为已支付；若回调丢失由定时任务主动查询渠道补偿">
<rect class="b" x="20" y="20" width="90" height="32" rx="6"/>
<text class="tb" x="65" y="36" text-anchor="middle" dominant-baseline="middle">用户端</text>
<rect class="b3" x="170" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="220" y="36" text-anchor="middle" dominant-baseline="middle">支付服务</text>
<rect class="b5" x="340" y="20" width="90" height="32" rx="6"/>
<text class="tb" x="385" y="36" text-anchor="middle" dominant-baseline="middle">渠道</text>
<rect class="b4" x="490" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="540" y="36" text-anchor="middle" dominant-baseline="middle">回调网关</text>
<rect class="b2" x="660" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="710" y="36" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<line class="ld" x1="65" y1="52" x2="65" y2="388"/>
<line class="ld" x1="220" y1="52" x2="220" y2="388"/>
<line class="ld" x1="385" y1="52" x2="385" y2="388"/>
<line class="ld" x1="540" y1="52" x2="540" y2="388"/>
<line class="ld" x1="710" y1="52" x2="710" y2="388"/>
<line class="l" x1="65" y1="80" x2="220" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="142" y="72" text-anchor="middle">① 去支付（幂等键）</text>
<text class="ts" x="230" y="104" text-anchor="start">② 校验订单待支付；创建支付单 INIT</text>
<line class="l" x1="220" y1="128" x2="385" y2="128" marker-end="url(#arr)"/>
<text class="ts" x="302" y="120" text-anchor="middle">③ 统一下单（支付单号）</text>
<line class="la" x1="385" y1="154" x2="220" y2="154" marker-end="url(#arr-a)"/>
<text class="ta" x="302" y="172" text-anchor="middle">④ 预支付参数；置 PAYING</text>
<line class="la" x1="220" y1="198" x2="65" y2="198" marker-end="url(#arr-a)"/>
<text class="ta" x="142" y="190" text-anchor="middle">⑤ 拉起支付</text>
<line class="l" x1="385" y1="236" x2="540" y2="236" marker-end="url(#arr)"/>
<text class="ts" x="462" y="228" text-anchor="middle">⑥ 异步通知（可能重复/延迟）</text>
<text class="ts" x="550" y="260" text-anchor="start">⑦ 验签 → 落库 → 秒回 SUCCESS</text>
<line class="l" x1="540" y1="280" x2="220" y2="280" marker-end="url(#arr)"/>
<text class="ts" x="380" y="272" text-anchor="middle">⑧ MQ：支付结果</text>
<text class="ts" x="230" y="304" text-anchor="start">⑨ 条件更新 SUCCESS + 写本地消息表</text>
<line class="l" x1="220" y1="326" x2="710" y2="326" marker-end="url(#arr)"/>
<text class="ts" x="465" y="318" text-anchor="middle">⑩ 事件：订单置“已支付”（幂等消费）</text>
<line class="l" x1="220" y1="360" x2="385" y2="360" marker-end="url(#arr)"/>
<text class="ta" x="302" y="352" text-anchor="middle">兜底：定时主动查询渠道</text>
</svg>
<figcaption>图 3：创建支付与异步回调主流程，并带主动查询兜底</figcaption>
</figure>

### 2. 幂等与重复支付防护

| 风险 | 场景 | 防护 |
| --- | --- | --- |
| **重复创建支付** | 用户连点、网络重试 | 请求带**幂等键**（订单号 + 渠道 + 有效期内尝试号）；`pay_order` 对 `(order_no, status in 未终态)` 约束或 Redis `SET NX` + DB 唯一索引双保险 |
| **重复回调** | 渠道多次通知同一笔 | 条件更新（影响 0 行直接成功返回）；记录回调流水表，按 `(channel, channel_trade_no)` 唯一 |
| **重复支付（同订单付两次）** | 两个支付单都成功 | 支付成功时检查订单是否已支付，**多付的自动退款**并记入差错单；渠道侧尽量复用同一商户单号 |
| **重复扣款/退款** | 退款接口超时重试 | 退款单独立幂等号（`refund_no`），渠道侧以此幂等；状态机管控 |

幂等设计细节见 [分布式 ID 与幂等](#/distributed/id)、[Redis 分布式锁](#/redis/lock)（锁只作辅助，**最终以数据库唯一约束与条件更新为准**）。

### 3. 回调处理：验签、落库、异步

渠道要求在几秒内返回成功，否则会反复重发。所以回调网关**只做轻量动作**：

```java
@PostMapping("/notify/{channel}")
public String notify(@PathVariable String channel, @RequestBody String raw, @RequestHeader Map<String,String> headers) {
    // 1) 验签：用渠道公钥验证，失败直接拒绝并告警（可能是伪造回调）
    if (!channelVerifier.verify(channel, headers, raw)) return "FAIL";
    // 2) 解析并校验关键字段：商户单号、金额、币种、商户号必须与我方支付单一致
    // 3) 先落库：回调原文 + 解析结果，状态 RECEIVED；唯一键 (channel, channel_trade_no) 去重
    notifyLogMapper.insertIgnore(log);
    // 4) 发 MQ 异步处理（或本地消息表）；处理失败可重试，不影响应答
    mq.send("pay-notify", log.getId());
    // 5) 立刻返回渠道约定的成功标识
    return "SUCCESS";
}
```

关键原则：**先持久化，再应答**。这样即使后续处理失败，数据也不丢，可重放；**不要在回调线程里调用订单、库存等其他服务**。

### 4. 主动查询补偿（回调靠不住）

| 场景 | 做法 |
| --- | --- |
| 支付单长时间 `PAYING` | 定时任务按退避间隔（如 30s、1m、5m、15m、30m…）**主动查询渠道**订单状态，结果为成功则走成功处理，**与回调共用同一幂等逻辑** |
| 请求渠道超时（结果未知） | 状态保持 `PAYING`，**绝不能当成失败**；用查询确认。这是最容易造成“用户付了款订单未支付”的坑 |
| 关单前 | **先查渠道，若已支付则不关单而走成功流程**；渠道支持“关闭订单接口”的，调用关闭并确认结果 |
| 查询也失败 | 进入人工待处理队列并告警 |

### 5. 超时关单

下单后 30 分钟未支付需关单并释放库存与优惠券：

- **延迟消息**：下单时发延迟消息，到期消费者检查订单状态（**幂等**），未支付则关闭；RocketMQ 支持任意精度延迟（5.x）或固定等级（见 [RocketMQ](#/mw/rocketmq)）；
- **兜底扫描**：定时任务扫描“超过 N 分钟仍待支付”的订单（走 `status + create_time` 索引，分批 + 限速），防止消息丢失；
- **关单前必须确认支付单状态**（见上），以及处理“关单瞬间用户刚好支付成功”的竞态：以**条件更新**决定谁赢——`UPDATE ... SET status='CLOSED' WHERE status='UNPAID'` 与 `UPDATE ... SET status='PAID' WHERE status='UNPAID'` 只有一个能成功；若订单已关但钱已收，走**自动退款或订单恢复**。

## 六、跨服务一致性：本地消息表

支付成功要同时：更新支付单、更新订单、扣减/核销库存与券、记账、通知用户。不在支付线程里同步串联调用，而采用**“本地事务 + 可靠事件”**：

<figure class="fig">
<svg viewBox="0 0 780 260" class="dg" role="img" aria-label="本地消息表模式：支付服务在同一个本地事务里更新支付单状态并写入消息表，后台中继任务读取未发送的消息投递到消息队列，下游订单服务、账务服务、通知服务幂等消费，处理失败重试，多次失败进入死信队列人工处理">
<rect class="b3" x="20" y="40" width="220" height="110" rx="10"/>
<text class="th" x="36" y="66">支付服务（一个本地事务）</text>
<rect class="b" x="36" y="80" width="188" height="28" rx="6"/>
<text class="ts" x="130" y="94" text-anchor="middle" dominant-baseline="middle">UPDATE pay_order → SUCCESS</text>
<rect class="b" x="36" y="114" width="188" height="28" rx="6"/>
<text class="ts" x="130" y="128" text-anchor="middle" dominant-baseline="middle">INSERT outbox（待发送）</text>
<rect class="b5" x="290" y="60" width="130" height="70" rx="10"/>
<text class="tb" x="355" y="84" text-anchor="middle" dominant-baseline="middle">中继任务</text>
<text class="ts" x="355" y="106" text-anchor="middle">扫表 / 订阅 binlog</text>
<rect class="b2" x="470" y="60" width="110" height="70" rx="10"/>
<text class="tb" x="525" y="84" text-anchor="middle" dominant-baseline="middle">MQ</text>
<text class="ts" x="525" y="106" text-anchor="middle">至少一次</text>
<line class="l" x1="240" y1="95" x2="290" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="95" x2="470" y2="95" marker-end="url(#arr)"/>
<rect class="b1" x="630" y="30" width="130" height="36" rx="6"/>
<text class="tb" x="695" y="48" text-anchor="middle" dominant-baseline="middle">订单服务</text>
<rect class="b1" x="630" y="76" width="130" height="36" rx="6"/>
<text class="tb" x="695" y="94" text-anchor="middle" dominant-baseline="middle">账务服务</text>
<rect class="b1" x="630" y="122" width="130" height="36" rx="6"/>
<text class="tb" x="695" y="140" text-anchor="middle" dominant-baseline="middle">通知 / 营销</text>
<line class="l" x1="580" y1="85" x2="630" y2="48" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="95" x2="630" y2="94" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="105" x2="630" y2="140" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="180" width="740" height="64" rx="10"/>
<text class="ts" x="36" y="204" text-anchor="start">• 业务状态与消息在同一事务，要么都成功要么都失败 → 不丢事件　• 发送失败由中继重试（至少一次）</text>
<text class="ts" x="36" y="224" text-anchor="start">• 消费端必须幂等（按事件 ID / 业务唯一键去重）　• 多次失败进入死信队列并告警，人工介入；消息有序性按支付单号分区</text>
</svg>
<figcaption>图 4：本地消息表 + 幂等消费，实现最终一致</figcaption>
</figure>

对比：**TCC / Saga / 事务消息** 各有适用场景（见 [分布式事务](#/distributed/transaction)）；支付主链路选择“本地消息表/事务消息 + 补偿”，性能与可用性更好。MQ 选型与可靠投递见 [消息队列通用问题](#/mw/mq)、[Kafka](#/mw/kafka)。

## 七、账务与对账

### 1. 复式记账

每笔资金变动**至少两条分录，借贷相等**，且**只追加不修改**，错误通过**冲正分录**更正，保证可审计。

| 业务 | 借 | 贷 |
| --- | --- | --- |
| 用户支付 100 元（渠道收款） | 渠道待结算账户 100 | 平台应付/商户待结算 100 |
| 平台抽成 2 元 | 商户待结算 2 | 平台收入 2 |
| 用户退款 30 元 | 商户待结算 30 | 渠道待结算（应退）30 |

**每张凭证“借方合计 = 贷方合计”**，作为系统自检；账户余额由流水累加得出（或定期快照 + 增量），不直接“改余额”。并发更新账户余额用**行锁/乐观锁**或按账户分片串行。

### 2. 对账：最后一道防线

即使回调、查询都做了，仍会有漏网（渠道故障、网络分区、代码 bug）。**对账是发现一切差异的兜底机制**。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="对账流程：每日定时下载渠道账单并解析入库，与内部支付流水按渠道交易号逐笔匹配，分为平账、长款、短款和金额不符四类，差错分别进入自动补单、自动退款或人工审核处理，结果更新差错单并最终出对账报表">
<rect class="b5" x="20" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">渠道账单 T+1</text>
<text class="ts" x="95" y="70" text-anchor="middle">下载·校验文件·入库</text>
<rect class="b3" x="20" y="120" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="140" text-anchor="middle" dominant-baseline="middle">内部支付流水</text>
<text class="ts" x="95" y="160" text-anchor="middle">按对账日与口径截取</text>
<rect class="b1" x="230" y="70" width="150" height="76" rx="10"/>
<text class="tb" x="305" y="96" text-anchor="middle" dominant-baseline="middle">逐笔匹配</text>
<text class="ts" x="305" y="116" text-anchor="middle">key=渠道交易号</text>
<text class="ts" x="305" y="132" text-anchor="middle">金额/状态/手续费</text>
<line class="l" x1="170" y1="58" x2="230" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="148" x2="230" y2="122" marker-end="url(#arr)"/>
<rect class="b2" x="450" y="20" width="150" height="40" rx="8"/>
<text class="tb" x="525" y="40" text-anchor="middle" dominant-baseline="middle">平账（两边一致）</text>
<rect class="b4" x="450" y="70" width="150" height="40" rx="8"/>
<text class="tb" x="525" y="90" text-anchor="middle" dominant-baseline="middle">长款（我有渠道无）</text>
<rect class="b4" x="450" y="120" width="150" height="40" rx="8"/>
<text class="tb" x="525" y="140" text-anchor="middle" dominant-baseline="middle">短款（渠道有我无）</text>
<rect class="b4" x="450" y="170" width="150" height="40" rx="8"/>
<text class="tb" x="525" y="190" text-anchor="middle" dominant-baseline="middle">金额/状态不符</text>
<line class="l" x1="380" y1="95" x2="450" y2="40" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="104" x2="450" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="112" x2="450" y2="140" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="120" x2="450" y2="190" marker-end="url(#arr)"/>
<rect class="bg" x="640" y="20" width="145" height="190" rx="8"/>
<text class="th" x="652" y="42">处理策略</text>
<text class="ts" x="652" y="64">长款：查渠道，</text>
<text class="ts" x="652" y="80">确认未付→关单</text>
<text class="ts" x="652" y="102">短款：用户已付</text>
<text class="ts" x="652" y="118">我方没记→补单</text>
<text class="ts" x="652" y="134">或自动退款</text>
<text class="ts" x="652" y="156">金额不符：人工</text>
<text class="ts" x="652" y="172">复核，查手续费</text>
<text class="ts" x="652" y="188">/优惠/汇率</text>
<rect class="bg" x="20" y="240" width="765" height="70" rx="8"/>
<text class="ts" x="36" y="264" text-anchor="start">• 每个差异生成差错单（状态：待处理→处理中→已解决），有责任人、SLA 与审计；自动化处理的要二次校验再动账</text>
<text class="ts" x="36" y="284" text-anchor="start">• 关注截止时间口径：渠道与我方按各自时区/“支付成功时间”切日，跨日交易要按规则统一</text>
<text class="ts" x="36" y="300" text-anchor="start">• 结果指标：日对账平账率、差错单数量与处理时长，纳入监控告警（见 指标监控）</text>
</svg>
<figcaption>图 5：T+1 渠道账单对账与差错处理</figcaption>
</figure>

**长款/短款的方向定义要明确约定**，下面是常见含义（团队内要统一术语）：

| 类型 | 含义 | 典型原因 | 处理 |
| --- | --- | --- | --- |
| **平账** | 双方一致 | — | 标记完成 |
| **我方有、渠道无**（我方多记） | 我方记为成功，渠道没有 | 渠道回调伪造/我方误判成功、渠道失败但我方错置成功 | 先查渠道确认；确属我方错误则**冲正并通知订单回滚**，涉及发货需追回 |
| **渠道有、我方无**（我方漏记） | 渠道扣了用户钱，我方未成功 | 回调丢失且补偿未命中、用户支付瞬间订单关闭 | **补单成功**或**自动原路退款**；必须有处理时限 |
| **金额不符** | 都有但金额/手续费不同 | 优惠分摊、手续费口径、汇率 | 核对规则，人工复核，必要时调整分录 |
| **状态不符** | 一方成功一方退款/关闭 | 退款回调丢失、状态机漏洞 | 以渠道为准修正，并复盘 bug |

**内部三方对账**：订单、支付单、账务流水三者之间也要对账（订单“已支付”数 = 支付成功数 = 分录凭证数），发现服务间事件丢失。

## 八、数据模型（精简）

```sql
-- 订单（按 user_id 或 order_no 分片）
CREATE TABLE t_order (
  order_no     BIGINT PRIMARY KEY,                -- 雪花 ID，嵌入分片基因
  user_id      BIGINT NOT NULL,
  amount_fen   BIGINT NOT NULL,                   -- 订单金额，单位分
  status       TINYINT NOT NULL,                  -- 待支付/已支付/已发货/已关闭...
  expire_time  DATETIME NOT NULL,
  version      INT NOT NULL DEFAULT 0,
  created_at   DATETIME(3) NOT NULL,
  KEY idx_user (user_id, created_at),
  KEY idx_status_expire (status, expire_time)     -- 兜底关单扫描
);

-- 支付单（资金事实）
CREATE TABLE t_pay_order (
  pay_no            BIGINT PRIMARY KEY,           -- 发给渠道的商户订单号
  order_no          BIGINT NOT NULL,
  channel           VARCHAR(16) NOT NULL,
  amount_fen        BIGINT NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'CNY',
  status            VARCHAR(16) NOT NULL,         -- INIT/PAYING/SUCCESS/FAILED/CLOSED
  channel_trade_no  VARCHAR(64),
  idem_key          VARCHAR(64) NOT NULL,
  paid_time         DATETIME(3),
  version           INT NOT NULL DEFAULT 0,
  created_at        DATETIME(3) NOT NULL,
  UNIQUE KEY uk_idem (idem_key),                  -- 幂等
  UNIQUE KEY uk_channel_trade (channel, channel_trade_no),
  KEY idx_order (order_no),
  KEY idx_status_time (status, created_at)        -- 主动查询补偿
);

-- 回调流水（先落库）
CREATE TABLE t_pay_notify (
  id BIGINT PRIMARY KEY, channel VARCHAR(16), channel_trade_no VARCHAR(64),
  pay_no BIGINT, raw_body MEDIUMTEXT, verify_ok TINYINT, handle_status TINYINT, created_at DATETIME(3),
  UNIQUE KEY uk_notify (channel, channel_trade_no, handle_status)
);

-- 本地消息表（Outbox）
CREATE TABLE t_outbox (
  id BIGINT PRIMARY KEY, biz_key VARCHAR(64), topic VARCHAR(64), payload JSON,
  status TINYINT NOT NULL, retry INT NOT NULL DEFAULT 0, next_retry_at DATETIME, created_at DATETIME(3),
  KEY idx_pending (status, next_retry_at)
);

-- 账务分录（只追加）
CREATE TABLE t_ledger_entry (
  id BIGINT PRIMARY KEY, voucher_no BIGINT NOT NULL, account_id BIGINT NOT NULL,
  direction TINYINT NOT NULL,                     -- 1 借 2 贷
  amount_fen BIGINT NOT NULL, biz_type VARCHAR(16), biz_no VARCHAR(64), created_at DATETIME(3),
  UNIQUE KEY uk_biz (biz_type, biz_no, account_id, direction),   -- 记账幂等
  KEY idx_voucher (voucher_no)
);
```

分库分表：订单与支付单按 `order_no` 取模/一致性哈希，并把**分片基因**编码进 `pay_no`，使“通过 pay_no 或 order_no 都能路由到同一分片”；跨分片查询（按用户）用异构索引表或 ES，见 [分库分表](#/mysql/sharding)。冷数据归档（如 90 天以上）到历史库。

## 九、高可用、降级与安全

| 风险 | 对策 |
| --- | --- |
| 渠道超时/故障 | 每渠道独立线程池与熔断（舱壁）；**多渠道路由**，按成功率动态切换；展示层隐藏故障渠道 |
| 回调洪峰 | 回调网关无状态横向扩容，只做验签落库；MQ 削峰 |
| 数据库压力 | 分库分表、读写分离、热点账户拆分（商户余额“子账户”随机分摊再汇总） |
| 重复请求/刷单 | 网关限流 + 风控（频率、设备、金额）；见 [限流、熔断与降级](#/distributed/governance) |
| 大促 | 压测、容量预留、非核心功能降级（积分、推荐）、写库排队；**支付链路最小化依赖** |
| 数据安全 | 卡号等敏感数据不落库或加密存储（遵循合规）；日志脱敏；密钥放 KMS 并轮换（见 [加密、签名与密钥](#/security/crypto)） |
| 回调伪造 | 严格验签 + 校验金额与商户号 + 主动查询复核关键订单（**不信任回调内容，以渠道查询结果为准**） |
| 内部越权 | 退款、差错处理等敏感操作**双人复核 + 审计日志**（见 [认证授权](#/security/auth)） |

## 十、监控与告警

| 指标 | 告警条件示例 |
| --- | --- |
| **支付成功率**（按渠道） | 5 分钟成功率较基线下降 5 个百分点 |
| 创建支付 / 回调 P99 | 超过目标持续 5 分钟 |
| `PAYING` 超时积压数 | 超过 N 笔或最老的 > 30 分钟 |
| 回调验签失败数 | 突增（可能攻击或密钥变更） |
| Outbox 积压/死信数 | > 0 且持续增长 |
| 对账差错单数量与未处理时长 | 出现长款/短款即告警，超时升级 |
| 订单已支付数 ≠ 支付成功数 | 三方对账不平立即告警 |

指标体系见 [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)，**资金类告警按 P0 对待**；全链路通过 `traceId` + 支付单号关联日志（见 [链路追踪、日志与告警](#/infra/obs-trace)）。

## 十一、上线与演进

1. **灰度与双写校验**：新渠道/新逻辑先小流量，并与旧链路**影子对比**；
2. **演练**：渠道超时、回调丢失、重复回调、MQ 积压、数据库切换的故障演练；
3. **资金安全开关**：支持一键关闭某渠道、暂停自动退款；
4. **演进方向**：支付中台化（多业务线复用）、聚合支付路由与成本优化、账户体系与资金池、实时对账（流式比对，见 [Flink](#/bigdata/flink-core)）、跨境多币种与汇率。

## 十二、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 强一致 vs 最终一致 | 最终一致 + 对账兜底 | 状态短暂不一致，需补偿机制 |
| 同步 vs 异步回调处理 | 先落库再异步 | 系统更复杂，需幂等 |
| 信任回调 vs 以查询为准 | 关键订单**主动查询复核** | 多一次渠道调用 |
| 一个库 vs 分库分表 | 分片 + 分片基因 | 跨分片查询需异构索引 |
| 自动处理 vs 人工 | 低风险自动、高风险人工复核 | 人力成本 |

## 面试追问

> [!QUESTION] 为什么订单和支付单要分开？
> 订单是业务事实，支付单是一次资金尝试，一个订单可能多次支付、换渠道或组合支付，生命周期和状态不同。分开后资金状态不污染业务状态，渠道侧商户单号可用每次唯一的支付单号，也方便对账与追溯。

> [!QUESTION] 如何保证支付回调不丢、不重、不乱？
> 不丢靠先验签落库再应答，加上主动查询补偿和对账兜底；不重靠回调流水唯一键与条件更新的幂等处理；不乱靠状态机只能前进、终态保护和条件更新，迟到的失败回调不能覆盖成功状态。关键订单以渠道查询结果为准而不是只信回调。

> [!QUESTION] 请求渠道超时了，该把支付单置为失败吗？
> 不能。超时意味着结果未知，渠道可能已扣款，保持 PAYING 并用主动查询或回调确认最终状态，直接置失败会导致用户已付款但订单未支付，关单前也必须先查询渠道。

> [!QUESTION] 订单关闭的瞬间用户刚好支付成功，怎么处理？
> 用条件更新决定胜负，关单和置已支付都基于订单当前状态做条件更新，只有一个成功。若订单已关闭但收到支付成功，说明钱已收，需要走自动退款或订单恢复的补偿流程并生成差错单，不能直接忽略。

> [!QUESTION] 如何保证订单、支付、账务多个服务的数据一致？
> 采用本地消息表或事务消息：支付服务在同一本地事务中更新支付单并写消息表，中继任务投递到 MQ，下游订单、账务、通知幂等消费，失败重试并进死信人工处理，最终一致，再用内部三方对账发现事件丢失，而不在主链路用 2PC 强一致。

> [!QUESTION] 对账怎么做？长款短款是什么？
> 每天下载渠道账单与内部流水按渠道交易号逐笔匹配，分为平账、一方有另一方无、金额或状态不符。我方多记要查证后冲正，渠道有我方无说明用户已付款但我方漏记，需补单或自动退款，金额不符人工复核，所有差异生成差错单、有责任人和时限，并监控平账率。

> [!QUESTION] 金额为什么不能用 double？怎么存？
> 二进制浮点无法精确表示很多十进制小数，会累积误差。应使用整数分存储并在计算中使用 long 或 BigDecimal，数据库用 BIGINT 或 DECIMAL，带币种字段，涉及比例分摊要规定舍入规则并保证分摊后总额不变。
