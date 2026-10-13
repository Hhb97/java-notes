---
level: 深入
tags: [Nacos, 注册中心, 配置中心, 服务发现, 健康检查, 临时实例, 保护阈值, 灰度配置, Eureka, Consul, Spring Cloud]
summary: 微服务的注册中心与配置中心：服务注册发现的完整链路（注册、心跳、健康检查、订阅推送、客户端缓存与容灾）、Nacos 的临时/持久实例与 AP/CP 模式、保护阈值、命名空间与分组、配置中心的发布、灰度、回滚与安全、故障场景与降级、与 Eureka/Consul/K8s Service 的对比。
---

# Nacos 与服务注册发现、配置中心

> [!ABSTRACT] 核心要点
> - 注册中心解决“**服务实例是动态的，调用方怎么找到它们**”：提供者**注册**并**保活**，消费者**订阅**并在本地缓存实例列表，实例变化通过**推送**通知。配置中心解决“**配置与代码分离、运行时动态变更、可灰度可回滚**”。
> - **注册中心的可用性优先于一致性**：实例列表短暂不一致可以接受（客户端有重试与熔断），**但注册中心整体不可用不能让调用方全部失败**。所以关键设计是**客户端本地缓存 + 注册中心宕机仍能调用**。
> - **Nacos** 同时提供注册发现与配置管理：服务实例分**临时实例（心跳保活，AP 倾向）** 与**持久实例（服务端主动探测，CP 倾向）**；命名空间/分组/集群提供环境、业务、机房隔离；**保护阈值**防止大量实例异常时“雪崩式摘除”。
> - **配置中心的危险点是“一次变更影响所有实例”**：必须有**版本、审计、灰度发布、一键回滚、权限审批、配置校验**，敏感配置要加密，客户端要有**本地快照**降级。
> - 常见事故：**注册中心被心跳/推送压垮**、**实例下线延迟导致调用已下线节点**、**优雅上下线缺失**、**配置误改全量生效**、**客户端缓存与拉取机制不了解导致“改了没生效”**。
> - 在 Kubernetes 中，服务发现常由 **Service/DNS** 承担，是否还需要独立注册中心要看团队的治理与多集群需求。

## 服务注册发现的基本链路

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="服务注册发现流程：提供者启动后注册实例到注册中心并周期心跳；注册中心做健康检查并维护实例列表；消费者订阅服务，获取实例列表并缓存到本地，变更时注册中心推送；消费者通过负载均衡选择实例调用；注册中心宕机时消费者使用本地缓存继续调用">
<rect class="b3" x="20" y="40" width="150" height="90" rx="10"/>
<text class="tb" x="95" y="60" text-anchor="middle" dominant-baseline="middle">服务提供者</text>
<text class="ts" x="95" y="84" text-anchor="middle">① 启动注册</text>
<text class="ts" x="95" y="102" text-anchor="middle">② 周期心跳</text>
<text class="ts" x="95" y="120" text-anchor="middle">③ 优雅下线注销</text>
<rect class="b1" x="300" y="14" width="190" height="140" rx="10"/>
<text class="tb" x="395" y="34" text-anchor="middle" dominant-baseline="middle">注册中心集群</text>
<text class="ts" x="395" y="62" text-anchor="middle">实例列表（服务→实例）</text>
<text class="ts" x="395" y="82" text-anchor="middle">健康检查·剔除不健康</text>
<text class="ts" x="395" y="102" text-anchor="middle">变更推送/拉取接口</text>
<text class="ts" x="395" y="122" text-anchor="middle">命名空间·分组隔离</text>
<text class="ts" x="395" y="142" text-anchor="middle">多节点同步数据</text>
<rect class="b5" x="620" y="40" width="120" height="90" rx="10"/>
<text class="tb" x="680" y="60" text-anchor="middle" dominant-baseline="middle">服务消费者</text>
<text class="ts" x="680" y="84" text-anchor="middle">④ 订阅服务</text>
<text class="ts" x="680" y="102" text-anchor="middle">⑤ 本地缓存</text>
<text class="ts" x="680" y="120" text-anchor="middle">⑥ 负载均衡调用</text>
<line class="l" x1="170" y1="70" x2="300" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="70" x2="620" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="680" y1="130" x2="680" y2="190" marker-end="url(#arr)"/>
<line class="la" x1="620" y1="215" x2="170" y2="130" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="196" text-anchor="middle">⑥ 直接调用提供者（不经过注册中心）</text>
<rect class="b2" x="560" y="190" width="180" height="50" rx="8"/>
<text class="tb" x="650" y="210" text-anchor="middle" dominant-baseline="middle">本地实例缓存/快照</text>
<text class="ts" x="650" y="230" text-anchor="middle">注册中心宕机仍可用</text>
<rect class="bg" x="20" y="256" width="720" height="72" rx="8"/>
<text class="ts" x="380" y="278" text-anchor="middle">摘除时机：优雅下线主动注销（秒级）；异常宕机靠心跳超时或探测失败（数秒~数十秒）；调用方再靠重试+熔断兜底这段窗口</text>
<text class="ts" x="380" y="298" text-anchor="middle">调用方不应每次都问注册中心：列表在本地，注册中心只在变更时推送，降低对注册中心的依赖与压力</text>
<text class="ts" x="380" y="318" text-anchor="middle">可用性设计的核心：注册中心可以“不新鲜”，不能“不可用就让业务全挂”</text>
</svg>
<figcaption>图 1：服务注册发现的链路与本地缓存</figcaption>
</figure>

### 关键问题

| 问题 | 说明与对策 |
| --- | --- |
| **保活方式** | **客户端心跳**（定期上报，超时剔除，简单、注册中心压力与实例数成正比）或**服务端主动探测**（TCP/HTTP/应用层检查，适合持久实例，能发现“进程活着但不可服务”） |
| **剔除延迟** | 异常退出要等心跳超时才摘除；窗口内调用方可能调到已死节点 → **客户端失败重试 + 熔断 + 负载均衡剔除** |
| **优雅上下线** | 发布时先**主动注销并等待调用方刷新缓存**，再停止接收流量，最后关进程；K8s 里配合 preStop 与就绪探针 |
| **启动预热** | 刚注册的实例（JIT/缓存未热）立即承接满流量会抖动；用**权重预热**/延迟注册，直到就绪检查通过再注册 |
| **健康检查与就绪** | 注册应当在应用**真正可服务**后（依赖连通、缓存预热完成）；否则会“注册了但不可用” |
| **推送与拉取** | 推送实时性好，但注册中心要维护长连接；拉取简单但有延迟。主流实现是**推拉结合**：推送变更 + 客户端定时全量拉取兜底 |
| **脏数据与自我保护** | 网络分区时大量实例心跳丢失，若全部剔除会让调用方无实例可用 → **自我保护/保护阈值**：健康实例比例低于阈值时不再剔除，宁可保留可能已死的实例（调用方靠重试） |
| **多机房/多集群** | 优先**同机房调用**，机房故障再跨机房；注册信息带机房/区域标签，客户端做亲和路由 |
| **版本与元数据** | 实例带版本、权重、标签，支持灰度与路由规则（按版本/标签路由），与 [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release) 配合 |

## Nacos

### 数据模型与隔离

| 概念 | 说明 |
| --- | --- |
| **命名空间（Namespace）** | **最高层隔离**（环境、租户），如 dev/test/prod；不同命名空间的服务和配置完全隔离 |
| **分组（Group）** | 命名空间内的二级分组（如业务线、项目），默认 `DEFAULT_GROUP` |
| **服务（Service）** | 由 命名空间 + 分组 + 服务名 唯一标识 |
| **集群（Cluster）** | 服务下的**机房/可用区**划分，用于同机房优先调用 |
| **实例（Instance）** | IP、端口、权重、健康状态、元数据、是否临时 |
| **配置（Data ID）** | 命名空间 + 分组 + Data ID 唯一标识一份配置 |

建议：**不同环境用命名空间隔离，不要靠服务名后缀**；生产命名空间权限单独管控。

### 临时实例与持久实例

<figure class="fig">
<svg viewBox="0 0 760 270" class="dg" role="img" aria-label="Nacos 临时实例与持久实例：临时实例由客户端心跳保活，心跳超时被摘除，注册信息不持久化，注册同步偏 AP；持久实例由服务端主动探测健康，不健康只标记不删除，信息持久化，一致性偏 CP，适合需要稳定记录的基础组件">
<rect class="b1" x="20" y="20" width="350" height="150" rx="10"/>
<text class="tb" x="195" y="40" text-anchor="middle" dominant-baseline="middle">临时实例（默认，微服务主流）</text>
<text class="ts" x="195" y="68" text-anchor="middle">客户端定时发送心跳保活</text>
<text class="ts" x="195" y="88" text-anchor="middle">心跳超时 → 标记不健康 → 一段时间后剔除</text>
<text class="ts" x="195" y="108" text-anchor="middle">不持久化，节点间用 AP 倾向的协议同步</text>
<text class="ts" x="195" y="128" text-anchor="middle">高可用优先：分区时两侧仍可注册发现</text>
<text class="ts" x="195" y="148" text-anchor="middle">实例宕机自动消失，适合弹性扩缩容</text>
<rect class="b5" x="390" y="20" width="350" height="150" rx="10"/>
<text class="tb" x="565" y="40" text-anchor="middle" dominant-baseline="middle">持久实例</text>
<text class="ts" x="565" y="68" text-anchor="middle">服务端主动探测（TCP/HTTP/MySQL 等）</text>
<text class="ts" x="565" y="88" text-anchor="middle">不健康只标记，不删除，等待恢复</text>
<text class="ts" x="565" y="108" text-anchor="middle">持久化存储，一致性偏 CP（基于 Raft）</text>
<text class="ts" x="565" y="128" text-anchor="middle">适合固定节点：数据库、网关、基础设施</text>
<text class="ts" x="565" y="148" text-anchor="middle">需要显式删除，注册信息稳定可审计</text>
<rect class="bg" x="20" y="190" width="720" height="68" rx="8"/>
<text class="ts" x="380" y="212" text-anchor="middle">选择原则：弹性伸缩的业务服务用临时实例；需要稳定登记且由外部探测的固定节点用持久实例</text>
<text class="ts" x="380" y="232" text-anchor="middle">具体的内部协议、模式切换与 2.x 版本 gRPC 长连接机制随版本变化，升级与调优前请以官方文档为准</text>
<text class="ts" x="380" y="250" text-anchor="middle">注意：同一个服务下混用两种实例要先理解其管理方式，避免出现“删除不掉”或“被误删”</text>
</svg>
<figcaption>图 2：Nacos 的临时实例与持久实例</figcaption>
</figure>

### 保护阈值

- 给服务设置一个 0~1 的**保护阈值**；当该服务的**健康实例比例 ≤ 阈值**时，Nacos 会把**不健康实例也返回给调用方**，防止所有流量压到少数健康实例造成雪崩；
- 代价：调用方可能拿到已死实例，需要客户端**重试 + 熔断**兜底；
- 适用：大规模网络抖动、批量心跳丢失、部署发布瞬间等场景；阈值要结合实例数量与容量评估，**不是越大越好**。

### 客户端行为

| 行为 | 说明 |
| --- | --- |
| **订阅与推送** | 消费者订阅服务，变更由服务端推送（较新版本用 gRPC 长连接，早期用 UDP 推送 + 定时拉取），客户端同时有定时拉取兜底 |
| **本地缓存与容灾** | 客户端把实例列表缓存在内存并落盘快照；**注册中心不可用时使用本地缓存**，启动时若注册中心不可达也可读取快照（需开启并确认路径） |
| **负载均衡** | 通常配合 Spring Cloud LoadBalancer、Dubbo 内建负载均衡；Nacos 提供权重与健康过滤 |
| **元数据路由** | 通过实例元数据（version、env、灰度标）实现灰度路由 |
| **注册参数** | IP 选择（多网卡容易注册错 IP）、端口、权重、元数据；K8s 里要使用 Pod IP 并处理 IP 复用 |

> [!WARNING] 多网卡与容器环境的“注册了不可达地址”
> 实例注册的是自己选出的 IP；在多网卡、Docker 桥接网络下可能注册成内部不可达地址，表现为“注册中心里有，调用不通”。需要显式指定网卡/IP，或在容器网络里使用 Pod 网络地址。

### Spring Cloud 使用要点

```yaml
spring:
  application:
    name: order-service
  cloud:
    nacos:
      discovery:
        server-addr: nacos1:8848,nacos2:8848,nacos3:8848
        namespace: prod            # 环境隔离
        group: ORDER_BIZ
        cluster-name: SH-A         # 机房/可用区，用于同机房优先
        weight: 1                  # 预热期可调低
        ephemeral: true
        metadata:
          version: v2.3
          gray: "false"
      config:
        server-addr: nacos1:8848,nacos2:8848,nacos3:8848
        namespace: prod
        group: ORDER_BIZ
        file-extension: yaml
```

- 注册地址使用**多节点或域名/VIP**，不要只写单节点；
- 开启访问**鉴权**，生产禁止匿名访问控制台与接口；
- 生产环境**用外置数据库（高可用）存放配置与元数据**，不要使用内嵌单机存储，并做备份；
- 版本升级要关注客户端与服务端的协议兼容（新旧版本的长连接、推送机制变化）。

## 配置中心

### 为什么需要

配置散落在代码、镜像、环境变量中，会带来：改配置需发版、环境不一致、无法审计、无法动态调整（限流阈值、开关、降级策略）。配置中心提供集中管理、**动态下发**与**变更治理**。

### 配置分层与加载

| 层次 | 内容 |
| --- | --- |
| **公共配置** | 所有服务共享（日志格式、通用开关） |
| **应用配置** | 单个服务的配置 |
| **环境配置** | 同一份配置在 dev/test/prod 的差异（通过命名空间或 profile） |
| **实例级/灰度配置** | 个别实例或灰度批次的覆盖值 |
| **本地兜底** | 打在包内的默认值，配置中心不可用时使用 |

优先级与覆盖关系要事先约定并文档化；**同一个配置项只在一处定义**，避免“到处覆盖不知道谁生效”。

### 动态刷新

- 客户端**长轮询/长连接**监听配置变更，变更后回调刷新；Spring Cloud 下通过 `@RefreshScope` / `@ConfigurationProperties` 重新绑定；
- **哪些可以动态改**：限流阈值、开关、白名单、日志级别、降级策略、超时参数；
- **哪些不要动态改**：数据源连接串、线程池核心参数、Bean 结构（要重启或重建资源）；动态变更线程池/连接池参数要有专门的“热更新”设计，否则会出现半新半旧；
- **刷新的原子性**：多个配置项一起变化时，客户端可能先看到部分变更；强相关配置合并成**一份配置**（一个 Data ID）；
- **监听回调要幂等、要捕获异常**，一个监听器异常不能影响其他配置；
- 变更日志：谁、何时、改了什么、从什么值到什么值，用于审计与排查。

### 变更治理：配置发布的“事故防线”

配置错误的爆炸半径常常**大于代码发布**（秒级全量生效、无需发版）。需要和代码发布同等级的流程：

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="配置发布流程：编辑配置，格式与规则校验，审批，灰度发布给少量实例或指定 IP，观察指标，全量发布，出现异常一键回滚到历史版本，所有操作留审计日志">
<rect class="b3" x="20" y="40" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="62" text-anchor="middle" dominant-baseline="middle">编辑</text>
<text class="ts" x="70" y="82" text-anchor="middle">差异预览</text>
<rect class="b5" x="135" y="40" width="100" height="56" rx="8"/>
<text class="tb" x="185" y="62" text-anchor="middle" dominant-baseline="middle">校验</text>
<text class="ts" x="185" y="82" text-anchor="middle">格式·取值范围</text>
<rect class="b4" x="250" y="40" width="100" height="56" rx="8"/>
<text class="tb" x="300" y="62" text-anchor="middle" dominant-baseline="middle">审批</text>
<text class="ts" x="300" y="82" text-anchor="middle">生产必须</text>
<rect class="b1" x="365" y="40" width="120" height="56" rx="8"/>
<text class="tb" x="425" y="62" text-anchor="middle" dominant-baseline="middle">灰度发布</text>
<text class="ts" x="425" y="82" text-anchor="middle">指定实例/IP 先生效</text>
<rect class="b3" x="500" y="40" width="100" height="56" rx="8"/>
<text class="tb" x="550" y="62" text-anchor="middle" dominant-baseline="middle">观察</text>
<text class="ts" x="550" y="82" text-anchor="middle">错误率·延迟</text>
<rect class="b2" x="615" y="40" width="125" height="56" rx="8"/>
<text class="tb" x="677" y="62" text-anchor="middle" dominant-baseline="middle">全量发布</text>
<text class="ts" x="677" y="82" text-anchor="middle">分批·有间隔</text>
<line class="l" x1="120" y1="68" x2="135" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="235" y1="68" x2="250" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="68" x2="365" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="485" y1="68" x2="500" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="68" x2="615" y2="68" marker-end="url(#arr)"/>
<path class="la" d="M550 96 L550 126 L185 126 L185 100" marker-end="url(#arr-a)"/>
<text class="ta" x="370" y="120" text-anchor="middle">异常：一键回滚到上一版本</text>
<rect class="bg" x="20" y="148" width="720" height="90" rx="8"/>
<text class="ts" x="380" y="170" text-anchor="middle">版本历史与回滚：每次发布生成版本，保留历史，回滚本身也是一次受控发布</text>
<text class="ts" x="380" y="190" text-anchor="middle">审计：操作人、时间、变更内容、审批人；与告警联动，变更事件标注到监控曲线上方便归因</text>
<text class="ts" x="380" y="210" text-anchor="middle">权限：按命名空间/分组/应用授权，生产只读为主，写权限与审批分离</text>
<text class="ts" x="380" y="228" text-anchor="middle">变更窗口与冻结：大促期间冻结生产配置变更，紧急变更走特批</text>
</svg>
<figcaption>图 3：配置发布的校验、灰度、观察与回滚流程</figcaption>
</figure>

### 敏感配置与安全

- **密码、密钥、令牌不要明文存配置中心**：使用加密存储（配置内容加密，客户端解密）或接入专门的密钥管理系统，配置中心只存引用；
- 控制台与 API **强制鉴权**，按角色最小授权；不同环境账号隔离；
- 配置内容**不要包含个人数据**；日志里不要打印完整配置；
- 防止配置被篡改的**完整性**要求（审计 + 签名）视安全等级而定，参见 [加密与密钥管理](#/security/crypto)。

### 容灾与降级

| 场景 | 行为与设计 |
| --- | --- |
| **配置中心宕机** | 应用**启动失败还是用本地快照/默认值启动**要事先设计；运行中已加载的配置继续有效；客户端保留本地快照 |
| **配置内容错误** | 校验 + 灰度 + 回滚；客户端对**非法配置拒绝应用并保留旧值**（例如解析失败不覆盖） |
| **网络分区** | 客户端用最后一次成功配置；恢复后拉取最新并对账 |
| **刷新风暴** | 全量实例同时刷新、同时重建资源会产生瞬时压力；避免在刷新回调里做重操作，或加随机抖动 |
| **配置漂移** | 实际生效值与中心不一致：暴露“当前生效配置版本/摘要”接口，定期核对 |

## 注册中心 / 配置中心的故障与事故模式

| 现象 | 根因 | 处理与预防 |
| --- | --- | --- |
| 发布后一段时间内仍有请求打到已下线实例 | 剔除延迟 + 调用方缓存 | 优雅下线（先注销、等待缓存刷新、再停进程），调用方重试 + 熔断 |
| 大批实例同时被摘除，业务雪崩 | 网络抖动导致心跳丢失 | 保护阈值/自我保护，缩短抖动影响，降低心跳敏感度，检查网络 |
| 注册中心 CPU/连接数飙升 | 实例规模大 + 心跳间隔短 + 推送风暴，或客户端异常重连 | 适当加大心跳间隔，限流，客户端重连带退避与抖动，纵向/横向扩容 |
| 配置改了没生效 | 客户端未监听/缓存、Data ID 或命名空间写错、优先级被覆盖、Bean 不支持刷新 | 查看客户端生效配置接口，核对命名空间/分组/Data ID，确认刷新范围 |
| 全量实例同时异常 | 错误配置全量生效 | 灰度发布，校验，回滚；严重配置设置“变更熔断” |
| 注册中心不可用后新实例起不来 | 启动强依赖注册中心拉取配置 | 配置本地快照与兜底，启动策略 fail-fast 还是降级需事先决策 |
| 注册了不可达 IP | 多网卡/容器网络 | 显式指定注册 IP/网卡，使用 Pod 网络 |
| 服务名/命名空间错配 | 环境混用 | 约束命名规范，发布流水线检查，环境隔离 |
| 注册中心数据库故障 | 配置存储单点 | 外置高可用数据库，备份与恢复演练 |

## 对比与选型

| 维度 | Nacos | Eureka | Consul | ZooKeeper / etcd | K8s Service + DNS |
| --- | --- | --- | --- | --- | --- |
| 定位 | 注册发现 + 配置中心 | 注册发现（项目已进入维护状态，新项目少用） | 注册发现 + KV + 健康检查 + 多 DC | 通用协调，注册发现需自建配方 | 平台内置服务发现 |
| 一致性 | 临时实例 AP，持久实例 CP | AP | CP（Raft） | CP | 最终一致（Endpoints 同步） |
| 健康检查 | 心跳 + 服务端探测 | 心跳 | 多种检查（HTTP/TCP/脚本） | 会话/租约 | 就绪探针 |
| 配置中心 | **内建**，含灰度、版本、监听 | 无 | KV 简易 | 自行实现 | ConfigMap/Secret（需配合工具） |
| 多数据中心 | 支持有限 | 弱 | **强（原生多 DC）** | 需自行设计 | 多集群需额外方案 |
| 生态 | Spring Cloud Alibaba、Dubbo 国内主流 | Spring Cloud Netflix 旧栈 | 服务网格、HashiCorp 栈 | Hadoop/K8s 等 | 云原生默认 |

选型建议：

- **Java 微服务 + Dubbo/Spring Cloud Alibaba**：Nacos 一体解决注册与配置；
- **已在 Kubernetes 上且服务间调用以集群内为主**：优先 **Service/DNS + 配置用 ConfigMap/配置中心**，减少一套基础设施；跨集群、跨语言、灰度路由复杂时再引入注册中心或服务网格；
- **多数据中心**与异构系统：Consul 更合适；
- **配置治理要求高**（灰度、审计、审批）：即使用 K8s，也往往需要独立的配置中心能力；
- 无论选哪个，**把注册中心当成最关键的基础设施之一**：高可用部署（≥3 节点）、监控、容量评估、故障演练、客户端降级。

与 RPC 框架的结合见 [Dubbo 架构与调用链路](#/mw/dubbo)、[Dubbo 集群容错与服务治理](#/mw/dubbo-practice)；负载均衡、重试与熔断的通用治理见 [限流、熔断与降级](#/distributed/governance)；网关侧的路由发现见 [案例：API 网关设计详解](#/design/case-gateway)。

## 相关阅读

- [分布式协调：ZooKeeper 与 etcd](#/mw/coordination)：协调服务的原理与选主、锁
- [Dubbo 架构与调用链路](#/mw/dubbo)：服务注册与消费的实现
- [限流、熔断与降级](#/distributed/governance)：注册中心延迟窗口内的兜底
- [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release)：配置灰度与优雅上下线
- [Kubernetes 核心概念](#/infra/k8s)：Service、探针与服务发现

## 面试追问

> [!QUESTION] 注册中心为什么要强调可用性？CAP 怎么取舍？
> 实例列表短暂不一致可以由客户端重试和熔断兜底，但注册中心整体不可用会让所有调用失败，所以偏 AP：分区时两侧仍可注册发现，调用方使用本地缓存。Nacos 临时实例走 AP 倾向，持久实例偏 CP；Eureka 是 AP，Consul、ZooKeeper、etcd 偏 CP。

> [!QUESTION] 服务下线后为什么还会有请求打到它？怎么解决？
> 异常宕机靠心跳超时才摘除，调用方还有本地缓存，存在窗口。解决：优雅下线时先注销并等待调用方缓存刷新再停进程，K8s 里配合 preStop 与就绪探针；调用方做失败重试、熔断和负载均衡剔除；适当缩短心跳超时与缓存刷新间隔。

> [!QUESTION] Nacos 的保护阈值是做什么的？
> 当某服务健康实例比例低于阈值时，Nacos 会连不健康实例一起返回，避免所有流量压到少数健康实例造成雪崩，防止网络抖动导致批量心跳丢失时全部被摘除。代价是调用方可能拿到已死实例，需要重试和熔断兜底。

> [!QUESTION] Nacos 临时实例和持久实例有什么区别？
> 临时实例由客户端心跳保活，超时被剔除，不持久化，偏 AP，适合弹性伸缩的微服务；持久实例由服务端主动探测，不健康只标记不删除，信息持久化，偏 CP，适合数据库、网关等固定节点。

> [!QUESTION] 配置中心有哪些风险？怎么治理？
> 配置变更无需发版、秒级全量生效，爆炸半径大。要有校验、审批、灰度发布、观察、一键回滚、版本历史和审计；敏感配置加密或接入密钥系统；客户端保留本地快照并拒绝非法配置；配置中心宕机时已加载的配置继续有效，启动策略要预先设计；大促期间冻结变更。

> [!QUESTION] 在 Kubernetes 里还需要注册中心吗？
> 集群内的调用可以由 Service 和 DNS 承担服务发现，减少一套基础设施。需要跨集群跨语言、复杂的灰度与权重路由、元数据治理，或已有 Dubbo、Spring Cloud 体系时，仍可能需要注册中心或服务网格；配置治理（灰度、审计）也常需要独立的配置中心能力。
