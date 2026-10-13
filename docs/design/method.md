---
level: 进阶
tags: [高并发, 容量评估, 高可用, SLA, 可观测性, 全链路压测, 灰度发布]
summary: 高并发系统设计的手段地图、从 DAU 推算机器数的容量评估算例、架构演进路径、高可用与 SLA、可观测性、压测与发布策略
---

# 高并发系统设计方法论

> [!ABSTRACT] 核心要点
> - 高并发的本质手段只有三类：**扩展**（拆分、集群、分库分表）、**提速**（缓存、池化、异步、CDN）、**保护**（限流、熔断、降级、隔离）。所有架构方案都是它们的组合。
> - 设计前先算账：DAU → 日请求量 → 平均 QPS → 峰值 QPS（二八原则 + 峰值系数）→ 单机压测容量 → 机器数（再乘冗余系数）。没有数字的设计无法评审。
> - 架构演进遵循「够用就好」：单体 → 集群 + 缓存 + 读写分离 → 服务化 → 微服务；每一步都是为解决当前瓶颈付出复杂度代价。
> - 可用性用「几个 9」度量：99.99% 意味着一年只能停 52 分钟，靠冗余、自动故障转移、多活和**快速回滚**达成，而不是靠不出错。
> - 上线前用全链路压测找出真实容量与瓶颈，上线时用灰度 / 金丝雀控制爆炸半径，上线后靠 Metrics、Logging、Tracing 三支柱发现问题。

## 核心手段地图

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="高并发设计手段地图：拆分、缓存、异步、池化、读写分离、分库分表、限流降级、CDN 静态化围绕高并发系统">
<rect class="b1" x="40" y="20" width="170" height="60" rx="8"/>
<text class="tb" x="125" y="42" text-anchor="middle" dominant-baseline="middle">拆分</text>
<text class="ts" x="125" y="64" text-anchor="middle" dominant-baseline="middle">服务化 / 微服务</text>
<rect class="b2" x="295" y="20" width="170" height="60" rx="8"/>
<text class="tb" x="380" y="42" text-anchor="middle" dominant-baseline="middle">缓存</text>
<text class="ts" x="380" y="64" text-anchor="middle" dominant-baseline="middle">本地 + 分布式多级缓存</text>
<rect class="b2" x="550" y="20" width="170" height="60" rx="8"/>
<text class="tb" x="635" y="42" text-anchor="middle" dominant-baseline="middle">异步</text>
<text class="ts" x="635" y="64" text-anchor="middle" dominant-baseline="middle">MQ 削峰、解耦</text>
<rect class="b2" x="40" y="120" width="170" height="60" rx="8"/>
<text class="tb" x="125" y="142" text-anchor="middle" dominant-baseline="middle">池化</text>
<text class="ts" x="125" y="164" text-anchor="middle" dominant-baseline="middle">线程池 / 连接池</text>
<rect class="bf" x="300" y="125" width="160" height="50" rx="10"/>
<text class="tw" x="380" y="150" text-anchor="middle" dominant-baseline="middle">高并发系统</text>
<rect class="b5" x="550" y="120" width="170" height="60" rx="8"/>
<text class="tb" x="635" y="142" text-anchor="middle" dominant-baseline="middle">读写分离</text>
<text class="ts" x="635" y="164" text-anchor="middle" dominant-baseline="middle">主库写、从库读</text>
<rect class="b5" x="40" y="220" width="170" height="60" rx="8"/>
<text class="tb" x="125" y="242" text-anchor="middle" dominant-baseline="middle">分库分表</text>
<text class="ts" x="125" y="264" text-anchor="middle" dominant-baseline="middle">存储水平扩展</text>
<rect class="b4" x="295" y="220" width="170" height="60" rx="8"/>
<text class="tb" x="380" y="242" text-anchor="middle" dominant-baseline="middle">限流降级</text>
<text class="ts" x="380" y="264" text-anchor="middle" dominant-baseline="middle">过载保护、有损服务</text>
<rect class="b2" x="550" y="220" width="170" height="60" rx="8"/>
<text class="tb" x="635" y="242" text-anchor="middle" dominant-baseline="middle">CDN 与静态化</text>
<text class="ts" x="635" y="264" text-anchor="middle" dominant-baseline="middle">流量前移到边缘</text>
<line class="l" x1="350" y1="125" x2="160" y2="82"/>
<line class="l" x1="380" y1="125" x2="380" y2="82"/>
<line class="l" x1="410" y1="125" x2="600" y2="82"/>
<line class="l" x1="300" y1="150" x2="212" y2="150"/>
<line class="l" x1="460" y1="150" x2="548" y2="150"/>
<line class="l" x1="350" y1="175" x2="160" y2="218"/>
<line class="l" x1="380" y1="175" x2="380" y2="218"/>
<line class="l" x1="410" y1="175" x2="600" y2="218"/>
</svg>
<figcaption>图 1：高并发设计手段地图（蓝：扩展计算；绿：提速；紫：扩展存储；红：保护）</figcaption>
</figure>

| 手段 | 解决什么 | 代价 / 新问题 | 详见 |
| --- | --- | --- | --- |
| 拆分 | 单体无法独立扩展、团队协作瓶颈 | 分布式事务、调用链变长、运维复杂 | [Spring Cloud 微服务全景](#/spring/cloud) |
| 缓存 | 读多写少，DB 扛不住读 | 一致性、穿透/击穿/雪崩、热 key | [缓存设计与一致性](#/redis/cache) |
| 异步 | 写高峰、非核心流程拖慢主链路 | 最终一致、消息丢失/重复/乱序 | [消息队列核心问题](#/mw/mq) |
| 池化 | 频繁创建线程/连接的开销 | 池参数不当导致排队或资源耗尽 | [线程池原理与调优](#/java/concurrency/pool) |
| 读写分离 | 读 QPS 超过单库 | 主从延迟，读己之写 | [主从复制与高可用](#/mysql/replication) |
| 分库分表 | 单库写入与数据量瓶颈 | 跨分片查询、分布式事务、全局 ID | [分库分表实践](#/mysql/sharding) |
| 限流降级 | 流量超过容量、依赖故障 | 部分请求失败，需要产品配合兜底体验 | [限流、熔断与降级](#/distributed/governance) |
| CDN / 静态化 | 静态资源与可缓存页面的带宽和 QPS | 缓存刷新、动静分离改造 | [秒杀系统设计](#/design/seckill) |

**分析瓶颈的顺序**：沿请求路径从外到内——DNS / CDN → 负载均衡 → 网关 → 应用（CPU、线程、GC）→ 缓存 → MQ → 数据库（连接数、慢 SQL、锁、IO）。哪一层先饱和，就是当前要解决的问题；一次只优化瓶颈点，否则是浪费。

## 容量评估

### 几个基本公式

- **Little 定律**：系统内并发数 = 吞吐量 × 平均响应时间。`QPS = 并发数 / RT`。例如 200 个工作线程、平均 RT 50ms，理论上限 4000 QPS；RT 变成 500ms，上限掉到 400 QPS——**RT 恶化会直接吃掉吞吐**，这也是慢调用必须熔断的原因。
- **二八原则**：80% 的请求集中在 20% 的时间内。
- **峰值系数**：活动、整点、推送带来的瞬时峰值，通常是日常高峰的 2～3 倍，大促可能更高，需结合历史数据。

### 完整算例

以一个 DAU 1000 万的电商 App 为例（数字为演示用的假设，实际以监控和压测为准）：

| 步骤 | 计算 | 结果 |
| --- | --- | --- |
| 日请求量 | 1000 万 DAU × 人均 30 次接口调用 | 3 亿 / 天 |
| 平均 QPS | 3 亿 ÷ 86400 秒 | ≈ 3,500 |
| 高峰 QPS（二八原则） | 3 亿 × 80% ÷（86400 × 20%） | ≈ 13,900 |
| 设计峰值 | 高峰 × 峰值系数 3 | ≈ 42,000，取 4 万 |
| 单机容量 | 压测：4C8G 实例在 CPU 60%、P99 < 200ms 时 | 1,200 QPS / 台 |
| 基础机器数 | 40,000 ÷ 1,200 | ≈ 34 台 |
| 容灾冗余 | 三机房部署，任一机房故障时剩余两个机房承担全部流量：34 × 3/2 | ≈ 51 台 |
| 写 QPS | 写请求约占 10% | 峰值约 4,000 写 / 秒 |
| 数据量 | 日新增订单 500 万 × 每行 1KB（含索引放大另算） | ≈ 5GB / 天，1.8TB / 年 |
| 出口带宽 | 4 万 QPS × 平均响应 10KB | ≈ 400MB/s ≈ 3.2Gbps |

由这张表能直接推出设计决策：

- 4000 写 / 秒 + 每年 TB 级增量，单库单表扛不住，要**分库分表**，并按 3～5 年数据量规划分片数；
- 读 3.6 万 QPS 需要**缓存**承担大部分读，Redis 单节点可达 10 万级简单命令 QPS，但要警惕热 key；
- 3.2Gbps 出口带宽中的静态资源应交给 **CDN**，接口响应开启压缩；
- 单机容量是**压测出来的**，不是算出来的：同样的 4C8G，纯内存计算接口可能上万 QPS，访问 DB 的接口可能只有几百。

> [!TIP] 水位线
> 机器容量按 CPU 60%～70% 的水位规划，而不是 100%：留出 GC、突发、单机故障转移的余量。容量评估报告至少要包含：预估峰值、单机压测数据、扩容方案、限流阈值、降级预案。

## 架构演进

<figure class="fig">
<svg viewBox="0 0 760 240" class="dg" role="img" aria-label="架构演进四个阶段：单体、集群加缓存、服务化垂直拆分、微服务">
<rect class="bg" x="10" y="30" width="170" height="200" rx="10"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">① 单体</text>
<rect class="b1" x="35" y="70" width="120" height="36" rx="6"/>
<text class="t" x="95" y="88" text-anchor="middle" dominant-baseline="middle">单体应用</text>
<line class="l" x1="95" y1="106" x2="95" y2="138" marker-end="url(#arr)"/>
<rect class="b5" x="35" y="140" width="120" height="36" rx="6"/>
<text class="t" x="95" y="158" text-anchor="middle" dominant-baseline="middle">单库</text>
<text class="ts" x="95" y="212" text-anchor="middle">开发快，整体耦合</text>
<line class="la" x1="180" y1="130" x2="198" y2="130" marker-end="url(#arr-a)"/>
<rect class="bg" x="200" y="30" width="170" height="200" rx="10"/>
<text class="tb" x="285" y="50" text-anchor="middle" dominant-baseline="middle">② 集群 + 缓存</text>
<rect class="b" x="225" y="64" width="120" height="30" rx="6"/>
<text class="t" x="285" y="79" text-anchor="middle" dominant-baseline="middle">Nginx / LB</text>
<line class="l" x1="270" y1="94" x2="247" y2="108" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="94" x2="323" y2="108" marker-end="url(#arr)"/>
<rect class="b1" x="215" y="110" width="64" height="30" rx="6"/>
<text class="t" x="247" y="125" text-anchor="middle" dominant-baseline="middle">App</text>
<rect class="b1" x="291" y="110" width="64" height="30" rx="6"/>
<text class="t" x="323" y="125" text-anchor="middle" dominant-baseline="middle">App</text>
<line class="l" x1="247" y1="140" x2="270" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="323" y1="140" x2="300" y2="158" marker-end="url(#arr)"/>
<rect class="b5" x="225" y="160" width="120" height="30" rx="6"/>
<text class="t" x="285" y="175" text-anchor="middle" dominant-baseline="middle">主从库 + 缓存</text>
<text class="ts" x="285" y="212" text-anchor="middle">水平扩展，库成瓶颈</text>
<line class="la" x1="370" y1="130" x2="388" y2="130" marker-end="url(#arr-a)"/>
<rect class="bg" x="390" y="30" width="170" height="200" rx="10"/>
<text class="tb" x="475" y="50" text-anchor="middle" dominant-baseline="middle">③ 服务化</text>
<rect class="b" x="405" y="64" width="140" height="30" rx="6"/>
<text class="t" x="475" y="79" text-anchor="middle" dominant-baseline="middle">网关</text>
<line class="l" x1="465" y1="94" x2="423" y2="108" marker-end="url(#arr)"/>
<line class="l" x1="475" y1="94" x2="475" y2="108" marker-end="url(#arr)"/>
<line class="l" x1="485" y1="94" x2="527" y2="108" marker-end="url(#arr)"/>
<rect class="b1" x="400" y="110" width="46" height="30" rx="6"/>
<text class="t" x="423" y="125" text-anchor="middle" dominant-baseline="middle">用户</text>
<rect class="b1" x="452" y="110" width="46" height="30" rx="6"/>
<text class="t" x="475" y="125" text-anchor="middle" dominant-baseline="middle">订单</text>
<rect class="b1" x="504" y="110" width="46" height="30" rx="6"/>
<text class="t" x="527" y="125" text-anchor="middle" dominant-baseline="middle">商品</text>
<line class="l" x1="423" y1="140" x2="423" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="475" y1="140" x2="475" y2="158" marker-end="url(#arr)"/>
<line class="l" x1="527" y1="140" x2="527" y2="158" marker-end="url(#arr)"/>
<rect class="b5" x="400" y="160" width="46" height="30" rx="6"/>
<text class="t" x="423" y="175" text-anchor="middle" dominant-baseline="middle">库</text>
<rect class="b5" x="452" y="160" width="46" height="30" rx="6"/>
<text class="t" x="475" y="175" text-anchor="middle" dominant-baseline="middle">库</text>
<rect class="b5" x="504" y="160" width="46" height="30" rx="6"/>
<text class="t" x="527" y="175" text-anchor="middle" dominant-baseline="middle">库</text>
<text class="ts" x="475" y="212" text-anchor="middle">按业务垂直拆分</text>
<line class="la" x1="560" y1="130" x2="578" y2="130" marker-end="url(#arr-a)"/>
<rect class="bg" x="580" y="30" width="170" height="200" rx="10"/>
<text class="tb" x="665" y="50" text-anchor="middle" dominant-baseline="middle">④ 微服务</text>
<rect class="b" x="595" y="64" width="140" height="30" rx="6"/>
<text class="t" x="665" y="79" text-anchor="middle" dominant-baseline="middle">网关 + 注册配置</text>
<rect class="b1" x="595" y="104" width="40" height="26" rx="5"/>
<rect class="b1" x="645" y="104" width="40" height="26" rx="5"/>
<rect class="b1" x="695" y="104" width="40" height="26" rx="5"/>
<rect class="b1" x="595" y="136" width="40" height="26" rx="5"/>
<rect class="b1" x="645" y="136" width="40" height="26" rx="5"/>
<rect class="b1" x="695" y="136" width="40" height="26" rx="5"/>
<rect class="b3" x="595" y="170" width="140" height="26" rx="5"/>
<text class="t" x="665" y="183" text-anchor="middle" dominant-baseline="middle">MQ · 缓存 · 分片</text>
<text class="ts" x="665" y="212" text-anchor="middle">独立部署，治理复杂</text>
</svg>
<figcaption>图 2：典型的架构演进路径</figcaption>
</figure>

| 阶段 | 触发演进的瓶颈 | 主要动作 | 引入的新问题 |
| --- | --- | --- | --- |
| 单体 | 单机 CPU/内存不够、单点 | 应用无状态化（Session 外置），前置负载均衡 | Session 共享、配置管理 |
| 集群 + 缓存 + 读写分离 | DB 读压力 | Redis 缓存、主从读写分离、CDN | 缓存一致性、主从延迟 |
| 服务化 | 代码耦合、发布互相阻塞、单库写瓶颈 | 按业务垂直拆分服务与数据库，引入 RPC | 分布式事务、接口契约 |
| 微服务 | 服务粒度仍大、团队规模增长 | 注册中心、配置中心、网关、链路追踪、容器化 | 治理复杂度、调用链长、排障难 |

> [!WARNING]
> 微服务不是目标。团队只有十个人却拆出几十个服务，会让一次需求改动跨多个仓库、多次联调发布，效率反而下降。拆分粒度应与团队结构（康威定律）和真实的扩展需求匹配。

## 高可用

### 可用性与 SLA

可用性 = 正常服务时间 ÷ 总时间。各级别对应的允许停机时间：

| 可用性 | 每年停机 | 每月（30 天）停机 | 一般要求 |
| --- | --- | --- | --- |
| 99% | 3.65 天 | 7.2 小时 | 内部系统 |
| 99.9% | 8.76 小时 | 43.2 分钟 | 一般业务系统 |
| 99.95% | 4.38 小时 | 21.6 分钟 | 较重要业务 |
| 99.99% | 52.6 分钟 | 4.32 分钟 | 核心交易链路 |
| 99.999% | 5.26 分钟 | 25.9 秒 | 基础设施、电信级 |

注意**串联降低可用性**：一个请求依赖 5 个 99.9% 的服务，整体约为 0.999^5 ≈ 99.5%。所以核心链路要尽量短、弱依赖要能降级。

到 99.99% 意味着一次故障从发现、定位到恢复要在几分钟内完成，这已经不是人工处理能达到的，必须依靠**自动化**：自动故障检测与转移、一键回滚、预案平台。

### 高可用手段

| 手段 | 做法 |
| --- | --- |
| 冗余 | 无状态服务多实例跨可用区部署；有状态服务主从/多副本 |
| 故障检测与转移 | 健康检查 + 注册中心摘除；MySQL MHA / Orchestrator、Redis 哨兵自动切主 |
| 隔离 | 核心与非核心服务分开部署、分开数据库；舱壁、线程池隔离 |
| 过载保护 | 限流、熔断、降级 |
| 多活 | 同城双活（机房间延迟约 1～2ms，可共享数据库）→ 两地三中心 → 异地多活（单元化：按用户 ID 分片，每个单元闭环处理本单元用户的读写） |
| 变更管控 | 绝大多数故障来自变更：灰度发布、可监控、可回滚，封网期 |
| 演练 | 故障注入、混沌工程，验证预案真实有效 |

> [!NOTE] 异地多活的难点
> 异地机房间延迟数十毫秒，不能跨地域同步写数据库。单元化把用户按 ID 路由到固定单元，同一用户的数据只在一个单元写入，再异步复制到其他单元做容灾；全局数据（如库存、账号）需要中心单元或特殊处理。数据同步冲突、单元切换时的数据追平是主要难点。

## 可观测性

三大支柱：

| 支柱 | 回答的问题 | 典型方案 | 关键实践 |
| --- | --- | --- | --- |
| Metrics 指标 | 有没有问题、严重程度、趋势 | Prometheus + Grafana、Micrometer | 服务用 **RED**（Rate、Errors、Duration），资源用 **USE**（Utilization、Saturation、Errors）；看 P99 而不是平均值 |
| Logging 日志 | 具体发生了什么 | ELK / EFK、Loki | 结构化日志（JSON），带 traceId；控制日志量，避免同步刷盘拖垮性能 |
| Tracing 链路追踪 | 慢在哪一跳、错在哪个服务 | SkyWalking、Zipkin、Jaeger、OpenTelemetry | traceId 跨线程池、MQ 传播；采样率按流量调整 |

告警设计要点：

- 基于**症状**告警（错误率、P99 延迟、业务成功率），而不是基于原因（CPU 高不一定影响用户）；
- **业务指标**比技术指标更早发现问题：下单量突降、支付成功率下降往往先于错误日志暴露问题；
- 告警要可行动、分级，避免告警疲劳；
- 基于 SLO 的错误预算（Error Budget）：99.9% 的 SLO 每月有 43 分钟预算，预算耗尽就冻结非紧急发布。

## 压测与全链路压测

| 类型 | 目的 | 方式 |
| --- | --- | --- |
| 单接口基准压测 | 单机容量、性能回归 | JMeter、wrk、Gatling 对单服务压测 |
| 容量压测 | 找出系统拐点与瓶颈 | 阶梯加压，观察 QPS 不再增长、RT 陡增、错误率上升的拐点 |
| 稳定性压测 | 内存泄漏、连接泄漏 | 中等压力持续数小时 |
| 全链路压测 | 真实流量模型下整体容量 | 在生产环境用压测流量覆盖完整链路 |

全链路压测的关键技术：

1. **流量染色**：压测请求带特殊标记（如 Header），通过 RPC、MQ、线程池全链路透传；
2. **数据隔离**：带标记的读写路由到**影子库 / 影子表**、影子 Redis key 前缀、影子 Topic，不污染真实数据；
3. **外部依赖挡板**：支付、短信等第三方调用用 Mock 拦截；
4. **流量模型**：基于历史大促数据构造接口比例和用户行为，而不是只压一个接口；
5. **熔断保护**：压测平台监控生产核心指标，异常时自动停止压测。

## 发布策略

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="金丝雀发布：网关把少量流量分给新版本，对比新旧版本监控指标后逐步放量或回滚">
<rect class="b" x="20" y="70" width="140" height="60" rx="8"/>
<text class="tb" x="90" y="92" text-anchor="middle" dominant-baseline="middle">网关 / LB</text>
<text class="ts" x="90" y="112" text-anchor="middle" dominant-baseline="middle">按规则分流</text>
<rect class="b1" x="300" y="30" width="180" height="50" rx="8"/>
<text class="tb" x="390" y="55" text-anchor="middle" dominant-baseline="middle">v1 稳定版 × 20 台</text>
<rect class="b3" x="300" y="120" width="180" height="50" rx="8"/>
<text class="tb" x="390" y="145" text-anchor="middle" dominant-baseline="middle">v2 金丝雀 × 1 台</text>
<line class="l" x1="160" y1="90" x2="298" y2="56" marker-end="url(#arr)"/>
<text class="ts" x="220" y="62" text-anchor="middle">95%</text>
<line class="la" x1="160" y1="110" x2="298" y2="144" marker-end="url(#arr-a)"/>
<text class="ts" x="220" y="148" text-anchor="middle">5%</text>
<rect class="b2" x="540" y="70" width="160" height="60" rx="8"/>
<text class="tb" x="620" y="92" text-anchor="middle" dominant-baseline="middle">监控对比</text>
<text class="ts" x="620" y="112" text-anchor="middle" dominant-baseline="middle">错误率 / RT / 业务指标</text>
<line class="ld" x1="480" y1="55" x2="538" y2="88" marker-end="url(#arr)"/>
<line class="ld" x1="480" y1="145" x2="538" y2="112" marker-end="url(#arr)"/>
<text class="ts" x="360" y="192" text-anchor="middle">指标正常：5% → 20% → 50% → 100%；指标异常：流量切回 v1</text>
</svg>
<figcaption>图 3：金丝雀发布与逐步放量</figcaption>
</figure>

| 策略 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 滚动发布 | 分批替换实例 | 不需要额外资源 | 新旧版本共存时间长，回滚也要滚动 |
| 蓝绿发布 | 准备一整套新环境，验证后一次性切流 | 切换与回滚都是秒级 | 需要双倍资源；数据库变更要兼容两版本 |
| 金丝雀发布 | 先放少量真实流量到新版本，观察后逐步放量 | 爆炸半径小 | 需要流量调度和指标对比能力 |
| 灰度发布 | 按用户、地域、白名单等规则定向放量（广义上包含金丝雀） | 可以先给内部员工或低风险用户 | 规则与路由一致性需要维护 |

无论哪种策略，有三条底线：**数据库变更向前兼容**（先加字段、再发代码、最后清理旧字段）；**功能开关**与发布解耦，出问题先关开关；**回滚预案**在发布前准备好且验证过。

## 生产实践与踩坑

- **只看平均 RT**：平均 50ms 可能掩盖了 P99 2 秒的长尾，而长尾决定了线程占用和超时。所有性能指标看分位数。
- **压测环境和生产差异大**：测试环境数据量小、缓存全命中、没有其他业务的干扰，得出的容量严重偏乐观。核心链路容量以生产全链路压测为准。
- **扩容不生效**：应用加了机器，瓶颈却在数据库连接数（每台应用连接池 × 实例数超过 MySQL `max_connections`）或下游限流。扩容前确认整条链路的容量。
- **缓存承担 90% 读但没有预案**：缓存集群故障时流量全部打到 DB，DB 立即被打垮（缓存雪崩）。需要多级缓存、限流保护 DB、缓存预热方案。
- **发布引发故障**：变更是故障的头号来源。大促前封网，发布必须灰度，并要求发布后观察核心指标一段时间才继续放量。
- **单机房部署**：所有实例在一个可用区，机房网络故障整体不可用。至少跨两个可用区部署，并验证单可用区故障时剩余容量够用。

## 相关阅读

- [DDD 战略设计：限界上下文与上下文映射](#/design/ddd-strategic)：用 DDD 划分边界
- [事件驱动架构：事件设计、Outbox 与 Saga](#/design/event-driven)：用事件解耦与削峰
- [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)：容量评估与监控
- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：限流、布隆与一致性哈希

## 面试追问

> [!QUESTION] 如何评估一个系统需要多少台机器？
> 从业务指标推算：DAU × 人均请求数得到日请求量，按二八原则算高峰 QPS，再乘峰值系数得到设计峰值；单机容量通过压测在 CPU 60% 左右的水位、满足 RT 要求时测得；机器数 = 峰值 ÷ 单机容量，再按容灾要求（如单机房故障）乘冗余系数。同时检查 DB、缓存、带宽等其他环节是否匹配。

> [!QUESTION] 99.99% 的可用性意味着什么？怎么做到？
> 一年停机不超过约 52 分钟、每月约 4 分钟，人工处理来不及，必须自动化：多实例跨可用区冗余、健康检查与自动故障转移、限流熔断降级防止故障扩散、变更灰度与一键回滚、监控告警分钟级发现，并通过故障演练验证。

> [!QUESTION] 系统 QPS 上不去，你会如何排查？
> 先确认瓶颈在哪一层：看压测机自身是否打满；应用层看 CPU、GC、线程池是否打满、是否有锁竞争（jstack）；看下游 RT 是否升高，DB 连接池是否排队、慢 SQL、行锁等待；缓存命中率与 Redis 延迟；网络带宽与连接数。用 Little 定律检查并发数与 RT 是否匹配，找到第一个饱和的资源再优化。

> [!QUESTION] 蓝绿发布和金丝雀发布的区别？
> 蓝绿是两套完整环境整体切换，回滚快但资源翻倍、切换后全量用户立即使用新版本；金丝雀只让少量流量先使用新版本，对比指标后逐步放量，爆炸半径小但需要流量调度能力。实践中常结合：新环境部署后先金丝雀放量，确认后整体切换。

> [!QUESTION] 全链路压测如何避免污染生产数据？
> 压测流量打标并全链路透传（RPC、MQ、线程池），中间件根据标记把写入路由到影子库表、影子缓存 key、影子 Topic；第三方依赖用挡板 Mock；压测用户和商品是专门构造的数据；同时监控生产指标，异常自动熔断压测。
