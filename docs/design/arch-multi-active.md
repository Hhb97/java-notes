---
level: 深入
tags: [异地多活, 同城双活, 单元化, 分区路由, 数据同步, 流量调度, 容灾切换, 全局数据, 一致性, 单元封闭, LDC]
summary: 同城双活到异地多活的架构演进与设计：目标与代价、单元化（逻辑数据中心 LDC）的核心思想、流量接入与路由（分区键、全局路由层）、数据分类（分区数据/全局数据/只读复制数据）与同步方案、跨单元调用的约束、故障切换与回切、一致性与冲突、数据库与中间件的多活方案、验证演练与落地路线。
---

# 异地多活与单元化架构

> [!ABSTRACT] 核心要点
> - **多活的目的**：让**多个机房/地域同时对外服务**，任一机房整体故障时，**流量快速切到其他机房**，业务**基本不中断（RTO 秒~分钟）、数据基本不丢（RPO 极小）**；同时也可以**就近接入降低延迟**。它是**最高等级的容灾**，也是**最昂贵、最复杂**的架构。
> - 难点不在“把应用部署两份”，而在**数据**：跨地域延迟（北京-上海约 30ms，跨洲 100~200ms）使得**同步复制代价极高**，而**异步复制必然存在窗口与冲突**。因此多活的核心思路是：**让每份数据“有主”**——通过**单元化（Cell/Unit）**，把用户**按某个分区键（如用户 ID）划分到不同单元**，**一个用户的读写在其归属单元内闭环**，跨单元只做**异步备份/只读同步**，从而**避免多地同时写同一份数据的冲突**。
> - **单元（Unit/LDC）的特征：自包含（应用 + 数据 + 缓存 + 消息都在单元内）、单元封闭（调用尽量不跨单元）、可独立运行（单元故障被隔离）、可迁移（流量可整体切到另一个单元）**。**爆炸半径**也随之缩小到“一个单元的用户”。
> - 数据分三类：**分区数据**（按分区键归属某单元，如用户/订单，主要是写）、**全局数据**（所有单元都要读且很少变，如商品、配置，单点写 + 复制到各单元只读）、**需要全局唯一/强一致的数据**（如全局库存、全局唯一约束，需要特殊处理：集中到一个单元并接受跨单元调用，或预分配额度）。
> - **切换能力是多活的价值所在**：必须有**统一的流量路由层（DNS/全局网关）**、**单元级的健康探测与自动/半自动切换**、**数据同步的位点管控与切换时的数据对齐**，以及**回切方案**。**没有演练过的多活不可信**。
> - 现实建议：**先把同城双活/多可用区做好，再按业务价值与成本评估异地多活**；很多业务通过“**异地冷/热备 + 核心链路局部多活**”就足够。

## 容灾等级与多活的位置

| 方案 | 说明 | RTO | RPO | 复杂度 |
| --- | --- | --- | --- | --- |
| **同城多可用区** | 同一城市多个机房（AZ）同时服务，延迟低（<2ms~几 ms），可同步复制 | 秒~分钟 | ≈0 | 中 |
| **异地冷/热备** | 主地域服务，备地域持续异步同步，故障时切 | 分钟~小时 | 秒~分钟 | 中 |
| **异地双活/多活** | 多个地域**同时**承载生产流量 | 秒~分钟 | 取决于同步，业务设计 | **高** |

更全面的高可用与容灾思路见 [高可用架构设计](#/design/arch-availability)。

### 为什么异地多活难

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="异地多活的核心难题：跨地域网络延迟高（几十到上百毫秒）；同步复制会让每次写入多出一次跨地域往返，吞吐与延迟代价大；异步复制则存在数据丢失窗口，且多地同时写同一数据会产生冲突；所以需要把数据划分为各有归属，避免多点写；此外还有跨地域依赖调用、全局唯一约束和故障切换时数据对齐问题">
<rect class="b3" x="20" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">物理约束：延迟与带宽</text>
<text class="ts" x="195" y="62" text-anchor="middle">同城 &lt;几 ms；异地 30~50ms；跨洲 100~200ms</text>
<text class="ts" x="195" y="84" text-anchor="middle">光速限制，无法优化到同城水平</text>
<text class="ts" x="195" y="106" text-anchor="middle">一次请求若多次跨地域调用，体验崩塌</text>
<text class="ts" x="195" y="130" text-anchor="middle">⇒ 调用必须尽量“单元内闭环”</text>
<rect class="b4" x="390" y="14" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">数据的两难</text>
<text class="ts" x="565" y="62" text-anchor="middle">同步复制：每次写 +1 个跨地域往返，慢</text>
<text class="ts" x="565" y="84" text-anchor="middle">异步复制：故障时有数据丢失窗口（RPO&gt;0）</text>
<text class="ts" x="565" y="106" text-anchor="middle">多点同时写同一数据：冲突，需要解决</text>
<text class="ts" x="565" y="130" text-anchor="middle">⇒ 让每份数据“有主”，避免多点写</text>
<rect class="b5" x="20" y="170" width="350" height="140" rx="10"/>
<text class="tb" x="195" y="190" text-anchor="middle" dominant-baseline="middle">业务约束</text>
<text class="ts" x="195" y="218" text-anchor="middle">全局唯一（用户名、手机号、库存总量）</text>
<text class="ts" x="195" y="240" text-anchor="middle">跨用户操作（转账、社交互动、群聊）</text>
<text class="ts" x="195" y="262" text-anchor="middle">第三方限制（只有一个回调地址/出口 IP）</text>
<text class="ts" x="195" y="288" text-anchor="middle">⇒ 需要逐类设计，无法一刀切</text>
<rect class="b2" x="390" y="170" width="350" height="140" rx="10"/>
<text class="tb" x="565" y="190" text-anchor="middle" dominant-baseline="middle">工程与运维</text>
<text class="ts" x="565" y="218" text-anchor="middle">全栈改造：应用、数据库、缓存、消息、配置</text>
<text class="ts" x="565" y="240" text-anchor="middle">同步链路、路由层、监控、发布体系都要多地</text>
<text class="ts" x="565" y="262" text-anchor="middle">切换/回切流程与演练、数据对账</text>
<text class="ts" x="565" y="288" text-anchor="middle">⇒ 组织与成本投入巨大</text>
</svg>
<figcaption>图 1：异地多活的几类根本约束</figcaption>
</figure>

## 单元化架构（Cell-based / LDC）

### 核心思想

把整个系统切成**若干个对等的单元**，每个单元是一个**功能完整、能独立服务一部分用户的“小系统”**；用户按**分区键**固定映射到某个单元；**一个用户的请求在其所属单元内处理完**。

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="单元化架构：全局流量入口按分区键把用户路由到对应单元；每个单元包含接入网关、应用服务、缓存、数据库、消息队列，自包含；各单元数据通过异步通道向其他单元备份，用于故障时接管；全局组件（全局配置、全局数据、路由规则）单独部署并向各单元同步；单元之间尽量不直接调用">
<rect class="b3" x="20" y="14" width="720" height="46" rx="8"/>
<text class="tb" x="380" y="30" text-anchor="middle" dominant-baseline="middle">全局流量层：DNS / 全局负载均衡 / 统一接入网关</text>
<text class="ts" x="380" y="50" text-anchor="middle">按分区键（用户 ID 哈希/段位）确定单元，查询路由表，可动态调整（切流）</text>
<rect class="b" x="20" y="78" width="230" height="170" rx="10"/>
<text class="th" x="135" y="98" text-anchor="middle">单元 A（地域 1）</text>
<rect class="b5" x="36" y="108" width="198" height="26" rx="6"/>
<text class="ts" x="135" y="121" text-anchor="middle" dominant-baseline="middle">网关 + 应用服务</text>
<rect class="b1" x="36" y="140" width="198" height="26" rx="6"/>
<text class="ts" x="135" y="153" text-anchor="middle" dominant-baseline="middle">缓存 + 消息队列</text>
<rect class="b4" x="36" y="172" width="198" height="26" rx="6"/>
<text class="ts" x="135" y="185" text-anchor="middle" dominant-baseline="middle">数据库（用户 0~49 主）</text>
<text class="ts" x="135" y="226" text-anchor="middle">单元内闭环处理请求</text>
<rect class="b" x="270" y="78" width="230" height="170" rx="10"/>
<text class="th" x="385" y="98" text-anchor="middle">单元 B（地域 2）</text>
<rect class="b5" x="286" y="108" width="198" height="26" rx="6"/>
<text class="ts" x="385" y="121" text-anchor="middle" dominant-baseline="middle">网关 + 应用服务</text>
<rect class="b1" x="286" y="140" width="198" height="26" rx="6"/>
<text class="ts" x="385" y="153" text-anchor="middle" dominant-baseline="middle">缓存 + 消息队列</text>
<rect class="b4" x="286" y="172" width="198" height="26" rx="6"/>
<text class="ts" x="385" y="185" text-anchor="middle" dominant-baseline="middle">数据库（用户 50~99 主）</text>
<text class="ts" x="385" y="226" text-anchor="middle">单元内闭环处理请求</text>
<rect class="b" x="520" y="78" width="220" height="170" rx="10"/>
<text class="th" x="630" y="98" text-anchor="middle">全局/中心服务</text>
<rect class="b2" x="536" y="108" width="188" height="26" rx="6"/>
<text class="ts" x="630" y="121" text-anchor="middle" dominant-baseline="middle">全局数据（商品、配置）</text>
<rect class="b2" x="536" y="140" width="188" height="26" rx="6"/>
<text class="ts" x="630" y="153" text-anchor="middle" dominant-baseline="middle">路由规则与单元元数据</text>
<rect class="b2" x="536" y="172" width="188" height="26" rx="6"/>
<text class="ts" x="630" y="185" text-anchor="middle" dominant-baseline="middle">全局唯一/强一致服务</text>
<text class="ts" x="630" y="226" text-anchor="middle">单点写 → 复制到各单元只读</text>
<line class="l" x1="135" y1="60" x2="135" y2="78" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="60" x2="385" y2="78" marker-end="url(#arr)"/>
<line class="la" x1="250" y1="190" x2="270" y2="190" marker-end="url(#arr-a)"/>
<line class="la" x1="270" y1="196" x2="250" y2="196" marker-end="url(#arr-a)"/>
<text class="ta" x="260" y="214" text-anchor="middle">异步互备</text>
<rect class="bg" x="20" y="266" width="720" height="84" rx="8"/>
<text class="ts" x="380" y="288" text-anchor="middle">单元间数据异步互为备份：单元 A 故障时，其用户路由到单元 B，B 上的备份副本升为主（接受 RPO 窗口）</text>
<text class="ts" x="380" y="308" text-anchor="middle">全局数据只在一处写，异步复制到各单元只读；全局唯一/强一致的操作集中处理，接受额外延迟</text>
<text class="ts" x="380" y="328" text-anchor="middle">原则：用户请求尽量不跨单元；跨单元调用必须有降级与超时，且数量极少</text>
</svg>
<figcaption>图 2：单元化架构的整体结构</figcaption>
</figure>

### 单元化的设计原则

| 原则 | 说明 |
| --- | --- |
| **自包含** | 单元内有完整的应用、数据库、缓存、消息，**不依赖其他单元即可处理其归属用户的核心请求** |
| **单元封闭（Cell Closure）** | 一次请求的所有调用都在单元内；**跨单元调用是异常路径**，要有降级、超时、限流 |
| **分区键选择** | 通常按**用户 ID**（大多数业务以用户为中心），也可按租户、地域、商户；要求**高基数、均匀、不可变**，并且**业务操作主要围绕单个分区键** |
| **均匀与可迁移** | 单元内的用户集合可以**重新划分**（切流/迁移），路由表可动态调整；单元容量均衡 |
| **对等部署** | 各单元规格与代码版本一致（发布按单元灰度），便于接管 |
| **爆炸半径可控** | 一个单元的故障/坏发布只影响其用户，**天然的灰度与隔离边界** |
| **全局组件最小化** | 全局依赖是多活的“阿喀琉斯之踵”，只保留必要的（路由、全局配置、全局唯一），并保证它们的高可用与降级 |

### 分区键与路由

- **路由表**：`分区键 → 单元`，常见做法是**哈希到逻辑分片（如 0~999）→ 逻辑分片映射到单元**；映射表集中管理、版本化，通过配置中心下发到各接入点；
- **路由位置**：接入层（**全局网关/边缘节点**）按请求中的分区键（Token 解析出用户 ID、Cookie、URL 参数）选择单元；**登录前**没有用户 ID 时的路由要特别设计（按手机号/账号哈希，或先到全局认证服务）；
- **跨单元请求的纠正**：请求误入非归属单元时，该单元应**重定向或代理转发**到正确单元（并告警），而不是自行处理（会造成多点写）；
- **服务间调用的路由**：RPC 在单元内**优先选择本单元实例**（按单元标签路由），与 [配置管理与全链路灰度](#/spring/cloud-config-gray) 的标签路由思想一致；
- **路由变更**：切流、扩容、迁移都通过修改路由表实现，**切换前后的数据可见性要对齐**（见“切换”章节）。

## 数据分类与同步

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="多活数据三类处理：分区数据按分区键归属单元，主要写入在归属单元，异步复制到其他单元作为备份；全局数据只在一个地域写，异步复制到各单元只读；需要全局唯一或强一致的数据集中管理或预分配额度，跨单元调用并降级；每类给出典型例子和一致性策略">
<rect class="b3" x="20" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="135" y="34" text-anchor="middle" dominant-baseline="middle">① 分区数据</text>
<text class="ts" x="135" y="60" text-anchor="middle">用户资料、订单、账户、会话</text>
<text class="ts" x="135" y="86" text-anchor="middle">归属单元读写（主）</text>
<text class="ts" x="135" y="106" text-anchor="middle">异步复制到其他单元（备）</text>
<text class="ts" x="135" y="132" text-anchor="middle">一致性：单元内强一致</text>
<text class="ts" x="135" y="152" text-anchor="middle">跨单元：最终一致（有 RPO）</text>
<text class="ts" x="135" y="182" text-anchor="middle">占业务数据的绝大部分</text>
<rect class="b5" x="270" y="14" width="230" height="200" rx="10"/>
<text class="tb" x="385" y="34" text-anchor="middle" dominant-baseline="middle">② 全局数据（读多写少）</text>
<text class="ts" x="385" y="60" text-anchor="middle">商品目录、配置、规则、字典</text>
<text class="ts" x="385" y="86" text-anchor="middle">只在一个地域写（中心）</text>
<text class="ts" x="385" y="106" text-anchor="middle">异步复制到各单元，只读</text>
<text class="ts" x="385" y="132" text-anchor="middle">一致性：最终一致，延迟可接受</text>
<text class="ts" x="385" y="152" text-anchor="middle">变更由中心发布，带版本</text>
<text class="ts" x="385" y="182" text-anchor="middle">中心故障：各单元继续读副本</text>
<rect class="b4" x="520" y="14" width="220" height="200" rx="10"/>
<text class="tb" x="630" y="34" text-anchor="middle" dominant-baseline="middle">③ 全局唯一/强一致</text>
<text class="ts" x="630" y="60" text-anchor="middle">用户名/手机号唯一、</text>
<text class="ts" x="630" y="80" text-anchor="middle">全局库存、全局计数/额度</text>
<text class="ts" x="630" y="106" text-anchor="middle">方案：</text>
<text class="ts" x="630" y="126" text-anchor="middle">集中到一个单元，其他单元跨调</text>
<text class="ts" x="630" y="146" text-anchor="middle">或预分配额度到各单元</text>
<text class="ts" x="630" y="166" text-anchor="middle">或按分区键保证唯一</text>
<text class="ts" x="630" y="192" text-anchor="middle">接受额外延迟与降级策略</text>
<rect class="bg" x="20" y="232" width="720" height="88" rx="8"/>
<text class="ts" x="380" y="254" text-anchor="middle">设计优先级：先看数据能否归到分区数据（最理想）→ 其次全局只读数据 → 最后才是需要强一致的全局数据（越少越好）</text>
<text class="ts" x="380" y="276" text-anchor="middle">业务改造需重设计数据模型：全局库存拆成各单元额度，全局用户名唯一改为按名字哈希归属</text>
<text class="ts" x="380" y="298" text-anchor="middle">无法改造的强一致需求，就让这类请求走“中心单元”，承受跨地域延迟，并把它限定在少数低频操作上</text>
</svg>
<figcaption>图 3：多活下的三类数据与处理策略</figcaption>
</figure>

### 数据同步方案

| 技术 | 做法 | 特点与注意 |
| --- | --- | --- |
| **数据库层复制** | MySQL 主从/组复制跨地域、PostgreSQL 逻辑复制 | 实现简单；跨地域异步复制延迟与丢失窗口；**多主写入冲突**，通常只做单向（主→备）或按分区单向 |
| **CDC 同步** | 订阅 binlog/WAL → 消息队列/同步中间件 → 对端回放 | 灵活（可过滤、转换、双向）；**必须解决循环复制**（给变更打来源标记，不再回传）；见 [CDC 与实时数仓架构](#/bigdata/cdc) |
| **消息队列跨地域复制** | MirrorMaker/集群链接等 | 事件异步传播；见 [Kafka 生产运维](#/mw/kafka-ops) 的跨集群复制 |
| **分布式数据库原生多活** | Spanner/CockroachDB/TiDB（多地域部署）、OceanBase 等 | 数据库层解决一致性（共识/事务），但**跨地域写延迟高**；需要合理的副本放置与就近读，见 [TiDB 架构与存储](#/db/tidb-arch)、[Paxos 与共识算法族](#/distributed/paxos) |
| **应用层同步** | 业务事件双向同步，应用层做冲突处理 | 灵活，复杂，易出错 |
| **缓存** | 通常**不跨单元同步**，各单元独立缓存，数据源头同步后失效/回源 | 避免缓存的跨地域一致性问题 |

关键点：

- **同步链路的位点（checkpoint）管理**：切换时要知道“备端已同步到哪”，才能判断可能丢失的数据范围；
- **幂等与顺序**：对端回放要幂等、同键保序；
- **循环复制与回环抑制**：双向同步时给每条变更带**来源单元标识**，不回传来源；
- **冲突检测**：理论上分区单写不会冲突，但**路由错误/切换窗口/人工改数**会引入冲突，需要检测与报警（版本号/时间戳/哈希校验）；
- **同步延迟监控**：作为一等指标（P99 延迟、积压），延迟过大则**暂缓切换或评估数据缺口**；
- **对账**：跨单元数据的定期校验与修复，见 [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)。

## 流量接入与路由

| 层次 | 做法 |
| --- | --- |
| **DNS / GSLB（全局负载均衡）** | 按地域/线路/健康把用户解析到最近的单元入口；**TTL 影响切换速度**（TTL 短切换快，但 DNS 查询量大、部分运营商不遵守 TTL）；Anycast/HTTPDNS 可加速 |
| **统一接入层（边缘网关）** | 终止 TLS，解析用户标识，查路由表，转发到归属单元；**网关本身多地域部署** |
| **单元内网关** | 校验“请求是否属于本单元”，不属于则重定向/转发 |
| **服务调用路由** | 微服务按单元标签选实例，禁止随意跨单元；跨单元调用经受控的“跨单元代理”并计数告警 |
| **异步/消息路由** | 消息发到归属单元的 Topic；跨单元事件通过受控同步通道 |
| **第三方回调** | 渠道回调只能指向一个地址/域名：回调落到接入层后**按业务单号路由到归属单元**（单号中内嵌单元信息，见 [分布式 ID 生成](#/distributed/id)） |

### 登录与会话

- 会话/令牌**自包含**（JWT 或带单元标识），任何单元可校验；或会话存储在**用户归属单元**，访问时路由到该单元；
- **登录前**无用户标识：账号/手机号哈希路由到归属单元完成认证，之后固定到该单元；
- 单元切换时，用户令牌要在新单元仍有效（共享密钥/公钥、会话数据同步），否则切换等于全员重登。

## 跨单元调用与全局依赖

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="跨单元调用的分类和处理：必须避免的是同步强依赖跨单元读写；允许的包括读取全局只读数据的本地副本、异步事件跨单元传播；少量必须的跨单元调用要经过代理，设置严格超时、熔断、降级与监控；全局依赖如认证中心、配置中心、注册中心自身要多地冗余，且各单元对其有本地缓存兜底">
<rect class="b4" x="20" y="14" width="350" height="110" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">应避免</text>
<text class="ts" x="195" y="60" text-anchor="middle">一次请求里同步多次跨单元调用</text>
<text class="ts" x="195" y="82" text-anchor="middle">跨单元写入同一数据的事务</text>
<text class="ts" x="195" y="104" text-anchor="middle">所有单元都依赖某个中心服务的在线调用</text>
<rect class="b2" x="390" y="14" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">推荐</text>
<text class="ts" x="565" y="60" text-anchor="middle">读全局数据的本地只读副本</text>
<text class="ts" x="565" y="82" text-anchor="middle">跨单元用异步事件，最终一致</text>
<text class="ts" x="565" y="104" text-anchor="middle">全局服务有本地缓存与降级</text>
<rect class="b5" x="20" y="140" width="720" height="150" rx="10"/>
<text class="th" x="32" y="160">不可避免的跨单元调用（如社交互动的双方在不同单元）</text>
<text class="ts" x="380" y="186" text-anchor="middle">走受控的“跨单元代理/服务”：严格超时、熔断、限流；失败有降级（稍后重试、异步化、提示用户）</text>
<text class="ts" x="380" y="208" text-anchor="middle">设计成“归属方负责”：对方单元的数据由对方单元处理，通过消息/接口请求其执行，而不是本单元直接写对方数据</text>
<text class="ts" x="380" y="230" text-anchor="middle">监控跨单元调用占比与延迟；占比上升说明分区键选择或业务设计需要调整</text>
<text class="ts" x="380" y="252" text-anchor="middle">举例：A 单元用户给 B 单元用户转账——在 A 单元扣款成功后，通过可靠消息通知 B 单元入账（Saga/事务消息），而不是跨库事务</text>
<text class="ta" x="380" y="278" text-anchor="middle">用最终一致与补偿代替跨地域强一致</text>
</svg>
<figcaption>图 4：跨单元调用的约束与处理</figcaption>
</figure>

## 故障切换与回切

### 单元故障切换

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="单元故障切换流程：监控探测到单元整体异常，确认故障范围，决策切换，停止向故障单元的写入并摘除流量，检查备端数据同步位点与可能缺口，把该单元用户的路由切到接管单元并提升备库为主，验证业务，发布公告；恢复后回切需要反向数据同步、数据对齐、灰度回切">
<rect class="b3" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 探测</text>
<text class="ts" x="75" y="74" text-anchor="middle">多源确认故障</text>
<rect class="b5" x="145" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="52" text-anchor="middle" dominant-baseline="middle">② 决策</text>
<text class="ts" x="200" y="74" text-anchor="middle">自动/人工审批</text>
<rect class="b1" x="270" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="52" text-anchor="middle" dominant-baseline="middle">③ 隔离</text>
<text class="ts" x="325" y="74" text-anchor="middle">摘流·停写·fencing</text>
<rect class="b4" x="395" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="450" y="52" text-anchor="middle" dominant-baseline="middle">④ 数据对齐</text>
<text class="ts" x="450" y="74" text-anchor="middle">位点·缺口评估</text>
<rect class="b2" x="520" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="575" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 切路由</text>
<text class="ts" x="575" y="74" text-anchor="middle">备库升主</text>
<rect class="b3" x="645" y="30" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 验证</text>
<text class="ts" x="692" y="74" text-anchor="middle">业务巡检</text>
<line class="l" x1="130" y1="62" x2="145" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="62" x2="270" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="62" x2="395" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="505" y1="62" x2="520" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="62" x2="645" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="720" height="204" rx="8"/>
<text class="th" x="32" y="136">要点</text>
<text class="ts" x="380" y="162" text-anchor="middle">故障判定要谨慎：避免因监控抖动/局部网络问题误切整个单元（误切成本很高）；多维度确认 + 人工审批关键切换</text>
<text class="ts" x="380" y="184" text-anchor="middle">隔离先于接管：先确保故障单元不再接受写（摘流、数据库只读、fencing），否则会出现双主写入</text>
<text class="ts" x="380" y="206" text-anchor="middle">数据对齐：备端只同步到某个位点，之后的数据缺口（RPO）要明确并记录；故障单元恢复后，这部分缺口要补偿或人工合并</text>
<text class="ts" x="380" y="228" text-anchor="middle">切换粒度：支持整单元切换，也支持按分区键段位（部分用户）灰度切换，用于演练与单点异常</text>
<text class="ts" x="380" y="250" text-anchor="middle">回切（Failback）：故障单元恢复后要先反向同步追平数据，再灰度切回；常被忽略却最容易出事</text>
<text class="ts" x="380" y="272" text-anchor="middle">切换自动化 + 可演练：手工流程在压力下易错；平台化的“一键切换/一键回切”，带前置检查与回滚</text>
<text class="ta" x="380" y="302" text-anchor="middle">所有切换必须有审计记录，切换后对账（跨单元数据一致性校验）</text>
</svg>
<figcaption>图 5：单元故障切换的步骤与要点</figcaption>
</figure>

### 其他故障场景

| 场景 | 处理 |
| --- | --- |
| **单元内部分故障（某服务/某库）** | 单元内容错与降级优先；必要时只切该分片用户 |
| **跨地域网络中断（分区）** | 各单元**独立运行**（单元封闭的价值）；全局数据读本地副本，写全局数据降级；分区恢复后数据对账 |
| **全局组件故障（路由、配置、全局唯一服务）** | 各单元使用**本地缓存的路由与配置**继续服务；全局唯一类操作降级或排队 |
| **同步链路中断/积压** | 监控告警；评估数据缺口；严重时暂停切换或扩大补偿窗口 |
| **坏发布** | 按单元灰度发布，坏发布只影响一个单元，其他单元不动，自动回滚 |

## 数据库与中间件的多活选择

| 组件 | 多活方案 | 说明 |
| --- | --- | --- |
| **MySQL** | **分区单写 + 跨地域异步复制 + 切换时提升备库**（最常见）；组复制/多主模式限制较多，谨慎 | 冲突与数据丢失窗口需业务接受；使用 GTID/半同步缩小窗口 |
| **PostgreSQL** | 流复制/逻辑复制 + 自动切换工具 | 同上 |
| **分布式 SQL（TiDB、CockroachDB、Spanner、OceanBase）** | 多副本跨地域，共识复制，**强一致**；写延迟包含跨地域往返；通过**副本放置策略**与**就近读（Follower Read）** 优化 | 适合强一致需求，成本与延迟需评估；见 [TiDB 架构与存储](#/db/tidb-arch) |
| **Redis** | 各单元独立缓存，不跨地域同步；必要时用复制工具同步冷启动数据 | 缓存是派生数据，可重建 |
| **Kafka/RocketMQ** | 各单元独立集群；跨单元事件用 MirrorMaker 等异步复制，防环 | 见 [Kafka 生产运维](#/mw/kafka-ops) |
| **Elasticsearch** | 各单元独立索引，由 CDC 同步构建；跨集群复制按需 | 搜索是派生数据 |
| **对象存储** | 跨地域复制 | 见 [分布式文件/对象存储](#/design/case-objectstore) |
| **配置/注册中心** | 各单元独立实例 + 全局配置同步 | 见 [Nacos 与服务注册发现、配置中心](#/mw/registry) |

## 一致性、冲突与业务设计

- **分区单写**使大多数数据不会有写冲突；但**路由错误、切换窗口、人工修改**仍会引入冲突，需要**检测与补偿**；
- **全局唯一约束**：手机号/用户名注册——通过**哈希到归属单元**由该单元保证唯一；或在**中心服务**做唯一性占位（低频）；
- **库存/额度类**：把总量**预分配**到各单元，单元内扣减，不足时向中心**申请调拨**（异步或同步），避免每次都跨地域；
- **用户之间的交互**（关注、转账、聊天）：以“发起方单元扣/写，接收方单元异步入”模式，最终一致 + 补偿，见 [案例：即时通讯（IM）系统设计详解](#/design/case-im)；
- **读己之写**：用户固定在归属单元，天然满足；切换后短时间内可能读不到最新写（RPO 窗口），要有产品提示；
- **时间与 ID**：**ID 生成要带单元信息或使用不冲突的号段**，避免多地生成重复主键，见 [分布式 ID 生成](#/distributed/id)；时间戳受时钟偏差影响，见 [分布式时钟](#/distributed/clock)。

## 验证与演练

多活价值取决于**能否真的切换**：

| 手段 | 做法 |
| --- | --- |
| **日常小流量验证** | 按分区键切出 0.1%~1% 的用户到另一单元，验证业务与数据同步；成为常态化手段 |
| **单元级故障演练** | 定期（如季度）演练：关闭一个单元或阻断其流量，验证切换流程、RTO、数据缺口与回切 |
| **数据同步校验** | 持续对账：同步延迟、差异率、关键业务不变式 |
| **全链路压测** | 验证接管单元的容量（接管后承载翻倍流量），见 [压测与容量规划](#/design/eng-loadtest) |
| **混沌实验** | 注入跨地域网络分区、延迟、全局组件故障，验证单元独立运行，见 [稳定性工程：混沌实验与容灾演练](#/design/eng-chaos) |
| **发布流程** | 按单元灰度发布本身就是日常演练 |

## 落地路线与取舍

1. **评估必要性**：业务能承受的停机时间与损失、监管要求、用户分布；很多场景同城多可用区 + 异地热备足够；
2. **同城多可用区先做好**：无状态服务跨 AZ、数据库同步/半同步复制、自动切换；
3. **异地热备**：数据异步同步、周期演练切换，建立 RTO/RPO 基线；
4. **选择分区键、数据分类、改造“跨单元”依赖**：这是最大工作量，需要逐个业务梳理；
5. **单元化改造**：路由层、单元内闭环、同步链路、发布与监控按单元化；
6. **从核心业务线开始多活**，非核心可保持主备；
7. **持续运营**：切换演练、容量、同步延迟、对账、成本。

**成本与代价**：基础设施成本（≥2 套全栈）、研发改造成本、复杂度与运维成本、RPO>0 的业务容忍、故障切换的认知与流程成本。**不要为多活而多活**——投入产出比不合适时，**强化单地域多 AZ 高可用 + 良好的备份与异地恢复**是更务实的选择。

## 常见坑

| 坑 | 说明与对策 |
| --- | --- |
| **“多地部署”不等于多活** | 数据仍是单点写，切换时数据不齐；必须设计数据归属与同步 |
| **跨单元调用泛滥** | 延迟与可用性被拖垮；监控跨单元占比，重构分区键/依赖 |
| **全局依赖成为单点** | 认证/配置/路由中心故障全站挂；本地缓存、降级、多地冗余 |
| **同步延迟未监控** | 切换时数据缺口过大；同步延迟作为一等告警 |
| **循环复制与重复数据** | 双向同步无来源标记；变更打标、回环抑制 |
| **切换未隔离旧单元** | 双主写入；先停写/fencing 再接管 |
| **从未回切演练** | 回切时数据覆盖或丢失；演练回切，反向同步追平 |
| **登录/会话不可迁移** | 切换后用户全部登出；令牌与会话跨单元可校验 |
| **第三方回调只指向单一地址** | 回调落到错误单元；接入层按单号路由，单号内嵌单元信息 |
| **自增主键/本地唯一约束冲突** | 多地生成重复 ID；分布式 ID，单元号段 |
| **接管单元容量不足** | 接管后过载级联；容量按 N+1 规划，压测验证 |
| **缓存跨地域同步** | 复杂且易错；各单元独立缓存，源头同步后失效/回源 |
| **只做技术没有业务配合** | 全局唯一、跨用户交互无法解决；业务方参与数据模型重新设计 |

## 相关阅读

- [高可用架构设计：可用性计算、故障域与容灾](#/design/arch-availability)：容灾等级与高可用整体
- [复制与一致性：主从、多主与无主](#/distributed/replication)：跨地域复制与冲突
- [分片、一致性哈希与再平衡](#/distributed/partitioning)：分区键与路由
- [故障模型、故障检测与脑裂](#/distributed/fault)：切换时的隔离与脑裂
- [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice)：跨单元数据对账
- [分布式 ID 生成](#/distributed/id)：单元内嵌与全局唯一
- [案例：即时通讯（IM）系统设计详解](#/design/case-im)：跨用户交互的单元化处理

## 面试追问

> [!QUESTION] 异地多活的核心思想是什么？为什么难？
> 让多个地域同时对外服务，任一地域故障时流量快速切走。难在数据：跨地域延迟高，同步复制代价大，异步复制有丢失窗口，多地同时写同一数据会冲突。核心做法是单元化，把用户按分区键划分到不同单元，一个用户的读写在其归属单元闭环，跨单元只做异步备份或只读同步，从而避免多点写冲突。

> [!QUESTION] 什么是单元化架构？有哪些设计原则？
> 把系统切成多个自包含的对等单元，每个单元有完整的应用、数据库、缓存和消息，能独立服务一部分用户。原则包括自包含、单元封闭（调用尽量不跨单元）、按高基数均匀的分区键路由、对等部署、全局组件最小化，并且天然把故障爆炸半径限制在一个单元内。

> [!QUESTION] 多活里的数据怎么分类处理？
> 分区数据按分区键归属单元读写，异步复制到其他单元作备；全局数据读多写少，只在一处写并异步复制到各单元只读；全局唯一或强一致的数据最难，可集中到一个单元并接受跨单元调用，或预分配额度到各单元，或按分区键保证唯一，尽量减少这类数据。

> [!QUESTION] 单元故障时怎么切换？要注意什么？
> 多源确认故障，决策后先隔离故障单元（摘流、停写、fencing）防止双主，评估备端同步位点与数据缺口，再把该单元用户路由切到接管单元并提升备库，验证业务。要注意误切成本高、数据缺口要记录补偿、切换自动化可演练、支持按用户段位灰度切换，以及恢复后的回切要先反向同步追平。

> [!QUESTION] 全局唯一约束、库存这类数据在多活下怎么办？
> 全局唯一如手机号可哈希到归属单元由其保证唯一，或在中心服务做低频占位；库存把总量预分配给各单元，单元内扣减，不足时向中心调拨，避免每次跨地域。无法拆分的强一致操作走中心单元，限定为少数低频请求并设计降级。

> [!QUESTION] 什么时候不该做异地多活？
> 业务对分钟级停机可接受、没有强监管要求、改造成本远高于停机损失时。多活需要两套以上全栈、全业务数据模型和依赖改造以及复杂的运维，投入产出不合适时，做好同城多可用区、异地热备和恢复演练更务实。
