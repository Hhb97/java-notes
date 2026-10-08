---
level: 深入
tags: [EMQX, Mosquitto, MQTT Broker, 集群, 共享订阅, 规则引擎, 百万连接, 重连风暴]
summary: 对比主流 MQTT Broker，剖析 EMQX 的 Erlang 架构、订阅路由与集群模型、规则引擎与数据集成、认证授权，以及百万连接的容量规划、内核调优与高可用部署。
---

# Broker 架构与集群（EMQX）

> [!ABSTRACT] 核心要点
> - 选型：**Mosquitto**（轻量单机、边缘/测试）、**EMQX**（大规模集群、规则引擎、数据集成，开源+企业版）、**HiveMQ**（企业级 Java）、**VerneMQ**；云上有托管服务（阿里云 IoT、AWS IoT Core 等）。
> - EMQX 基于 **Erlang/OTP**：**每个连接一个轻量 Erlang 进程**，天然适合海量并发连接与软实时；5.x 采用 **Core / Replicant** 节点与 **Mria** 数据库架构，实现更大规模的集群。
> - 集群里 **订阅信息（路由表）在节点间复制**，会话与连接**在设备连接的那个节点**；消息按路由表在节点间转发；**共享订阅**让后端水平扩展消费。
> - 百万连接的瓶颈主要是**内存、文件描述符、内核参数、网络带宽与连接风暴**，而不是 CPU；要做**容量规划与限速保护**。
> - 接入层必须有**负载均衡（四层 LB + TLS 卸载或透传）**，并设计**重连风暴、慢消费者、消息积压**的保护。

> [!NOTE] 版本与数据
> 本页以 **EMQX 5.x** 的通用机制为主，具体配置项和默认值**以所用版本官方文档为准**（5.x 配置采用 HOCON 格式，与 4.x 的 `emqx.conf` 差异较大）。文中容量数字为经验量级，不是承诺指标，需自行压测。

## Broker 选型

| | Mosquitto | **EMQX** | HiveMQ | VerneMQ |
| --- | --- | --- | --- | --- |
| 实现 | C，单进程事件循环 | **Erlang/OTP** | Java | Erlang |
| 集群 | 不支持原生集群（桥接） | **分布式集群** | 集群（企业） | 集群 |
| 规模 | 单机数万连接 | **集群百万~千万级连接** | 大规模 | 大规模 |
| 规则引擎/数据集成 | 无 | **内置规则引擎 + 连接器（Kafka/DB/HTTP…）** | 扩展（企业） | 插件 |
| MQTT 5.0 | 支持 | 支持 | 支持 | 支持 |
| 适用 | 边缘网关、开发测试、小规模 | 大规模平台、云端 Broker | 企业商用 | 开源集群 |

选择要点：**小规模或边缘用 Mosquitto；大规模云端用 EMQX 或托管服务**。边缘侧常用 Mosquitto/EMQX Edge 做**本地 Broker**，再通过**桥接**上云（断网时本地缓存，恢复后补传）。

## EMQX 内部架构

<figure class="fig">
<svg viewBox="0 0 760 380" class="dg" role="img" aria-label="EMQX 单节点内部架构：监听器、连接进程、会话、订阅路由、规则引擎与数据集成">
<rect class="b" x="20" y="150" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="178" text-anchor="middle" dominant-baseline="middle">设备 / 网关</text>
<line class="l" x1="120" y1="178" x2="160" y2="178" marker-end="url(#arr)"/>
<rect class="bg" x="160" y="20" width="580" height="340" rx="14"/>
<text class="th" x="180" y="46">EMQX 节点（Erlang VM / BEAM）</text>
<rect class="b3" x="180" y="64" width="120" height="260" rx="10"/>
<text class="tb" x="240" y="86" text-anchor="middle" dominant-baseline="middle">监听器</text>
<text class="ts" x="240" y="112" text-anchor="middle">tcp 1883</text>
<text class="ts" x="240" y="132" text-anchor="middle">ssl 8883</text>
<text class="ts" x="240" y="152" text-anchor="middle">ws 8083</text>
<text class="ts" x="240" y="172" text-anchor="middle">wss 8084</text>
<text class="ts" x="240" y="192" text-anchor="middle">quic 14567</text>
<text class="ts" x="240" y="226" text-anchor="middle">限速 · 最大连接</text>
<text class="ts" x="240" y="246" text-anchor="middle">黑名单 · 防护</text>
<rect class="b1" x="320" y="64" width="130" height="120" rx="10"/>
<text class="tb" x="385" y="86" text-anchor="middle" dominant-baseline="middle">每连接一个</text>
<text class="tb" x="385" y="104" text-anchor="middle" dominant-baseline="middle">Erlang 进程</text>
<text class="ts" x="385" y="130" text-anchor="middle">协议解析 · 认证</text>
<text class="ts" x="385" y="150" text-anchor="middle">授权 · 保活</text>
<text class="ts" x="385" y="170" text-anchor="middle">会话状态</text>
<rect class="b5" x="320" y="204" width="130" height="120" rx="10"/>
<text class="tb" x="385" y="226" text-anchor="middle" dominant-baseline="middle">订阅与路由</text>
<text class="ts" x="385" y="252" text-anchor="middle">主题 Trie 匹配</text>
<text class="ts" x="385" y="272" text-anchor="middle">集群路由表复制</text>
<text class="ts" x="385" y="292" text-anchor="middle">共享订阅调度</text>
<rect class="b2" x="470" y="64" width="250" height="120" rx="10"/>
<text class="tb" x="595" y="86" text-anchor="middle" dominant-baseline="middle">规则引擎</text>
<text class="tm" x="595" y="112" text-anchor="middle">SELECT payload.temp AS t,</text>
<text class="tm" x="595" y="130" text-anchor="middle">clientid FROM "t/#"</text>
<text class="tm" x="595" y="148" text-anchor="middle">WHERE t &gt; 80</text>
<text class="ts" x="595" y="172" text-anchor="middle">→ 动作：转发 Kafka / HTTP / DB</text>
<rect class="b4" x="470" y="204" width="250" height="120" rx="10"/>
<text class="tb" x="595" y="226" text-anchor="middle" dominant-baseline="middle">数据集成 / 连接器</text>
<text class="ts" x="595" y="252" text-anchor="middle">Kafka · RocketMQ · MySQL · PG</text>
<text class="ts" x="595" y="272" text-anchor="middle">Redis · InfluxDB · HTTP Webhook</text>
<text class="ts" x="595" y="292" text-anchor="middle">失败缓冲与重试</text>
<line class="l" x1="300" y1="140" x2="320" y2="130" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="184" x2="385" y2="204" marker-end="url(#arr)"/>
<line class="la" x1="450" y1="264" x2="470" y2="150" marker-end="url(#arr-a)"/>
<line class="la" x1="595" y1="184" x2="595" y2="204" marker-end="url(#arr-a)"/>
<text class="ts" x="450" y="350" text-anchor="middle">认证/授权后端：内置库 · PostgreSQL/MySQL/Redis · HTTP · JWT · LDAP</text>
</svg>
<figcaption>图 1：EMQX 节点内部：监听 → 连接进程 → 路由 → 规则/集成</figcaption>
</figure>

### 为什么用 Erlang

- **轻量进程**：每个进程几 KB 内存，由 BEAM 虚拟机调度，**一个节点可承载百万级连接进程**；
- **消息传递 + 隔离**：进程间不共享内存，一个连接崩溃不会影响他人（**let it crash** + supervisor 监督树）；
- **软实时抢占调度**：公平调度、每进程独立 GC，不会出现 JVM 式的全局 STW 停顿；
- 分布式能力内建（节点间通信）。

代价：生态相对小、定制需 Erlang 技能；自定义扩展多用**规则引擎、Webhook、插件、Extended Authn/Authz**。

## 认证、授权与安全

| 环节 | 机制 | 说明 |
| --- | --- | --- |
| 连接认证 | 内置数据库、密码+盐哈希、**JWT**、HTTP 回调、PostgreSQL/MySQL/Redis/MongoDB、LDAP、X.509 证书 | 链式认证，依次尝试；设备量大时用 **JWT/证书** 避免每次查库 |
| 授权（ACL） | 基于用户名/ClientID/IP 的**发布/订阅权限** | 规则如“只允许发布 `acme/${clientid}/up/#`、订阅 `acme/${clientid}/down/#`” |
| 传输安全 | **TLS 1.2/1.3**，双向认证（mTLS） | 设备证书由私有 CA 签发，吊销（CRL/OCSP） |
| 防护 | 连接速率限制、`max_connections`、黑名单、发布速率限制、**客户端 ID 封禁** | 防止异常设备或攻击 |

> [!WARNING] 生产环境的几条底线
> 1. 禁止匿名接入（`allow_anonymous=false`）；2. 设备**只能访问自己的主题**（ACL 变量 `${clientid}`/`${username}`）；3. 全程 TLS；4. 设备凭证**每设备唯一**，不要所有设备共用一组账号；5. 管理 API/Dashboard **不暴露公网**。

## 集群原理

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="EMQX 集群：订阅路由表在核心节点复制，设备连接到各节点，消息经路由转发到订阅者所在节点">
<rect class="b1" x="20" y="20" width="220" height="130" rx="12"/>
<text class="th" x="130" y="44" text-anchor="middle">节点 A</text>
<text class="ts" x="130" y="68" text-anchor="middle">连接：publisher P</text>
<text class="ts" x="130" y="88" text-anchor="middle">本地：无订阅者匹配</text>
<text class="ts" x="130" y="112" text-anchor="middle">路由表（全局复制）：</text>
<text class="tm" x="130" y="132" text-anchor="middle">t/# → [节点B, 节点C]</text>
<rect class="b2" x="270" y="20" width="220" height="130" rx="12"/>
<text class="th" x="380" y="44" text-anchor="middle">节点 B</text>
<text class="ts" x="380" y="68" text-anchor="middle">连接：订阅者 S1</text>
<text class="ts" x="380" y="88" text-anchor="middle">订阅 t/#（本节点会话）</text>
<text class="ts" x="380" y="112" text-anchor="middle">路由表（全局复制）：</text>
<text class="tm" x="380" y="132" text-anchor="middle">t/# → [节点B, 节点C]</text>
<rect class="b3" x="520" y="20" width="220" height="130" rx="12"/>
<text class="th" x="630" y="44" text-anchor="middle">节点 C</text>
<text class="ts" x="630" y="68" text-anchor="middle">连接：订阅者 S2</text>
<text class="ts" x="630" y="88" text-anchor="middle">订阅 t/#（本节点会话）</text>
<text class="ts" x="630" y="112" text-anchor="middle">路由表（全局复制）：</text>
<text class="tm" x="630" y="132" text-anchor="middle">t/# → [节点B, 节点C]</text>
<line class="la" x1="240" y1="85" x2="270" y2="85" marker-end="url(#arr-a)"/>
<path class="la" d="M130 150 L130 200 L630 200 L630 150" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="192" text-anchor="middle">① P 发布 t/1：节点 A 查路由表，转发给 B、C（节点间 RPC）</text>
<text class="ts" x="380" y="228" text-anchor="middle">② 节点 B、C 各自在本地投递给订阅者 S1、S2</text>
<rect class="bg" x="20" y="256" width="720" height="86" rx="12"/>
<text class="th" x="40" y="280">集群状态存储</text>
<text class="ts" x="40" y="302">订阅/路由/会话注册等元数据：核心节点（Core）上的 Mnesia/RLOG 事务复制，副本节点（Replicant）从 Core 同步</text>
<text class="ts" x="40" y="322">设备连接会话数据：驻留在连接所在节点内存；跨节点“会话接管”由会话注册表定位并迁移</text>
</svg>
<figcaption>图 2：路由表全局复制，消息按路由转发到订阅者所在节点</figcaption>
</figure>

要点：

- **路由表复制**：`主题过滤器 → 订阅它的节点列表` 在集群内全局可见，发布时只查路由表，向有订阅者的节点转发，**不会广播给所有节点**；
- **Core / Replicant（5.x）**：Core 节点负责数据库写入和事务（建议 2~3 个，奇数更好），Replicant 节点**无状态地**承载大量客户端连接，读本地副本；扩容主要靠增加 Replicant，**避免大集群里所有节点都参与分布式事务**导致的瓶颈；
- **会话接管**：设备重连到另一个节点时，EMQX 通过会话注册表找到旧会话，**迁移订阅与排队消息**，因此重连到不同节点不丢持久会话（但要求设备使用同一 ClientID 并仍在会话有效期内）；
- **共享订阅**在集群内分发策略：`random`、`round_robin`、`sticky`、`hash_clientid`、`local`（优先本节点）等，可调；
- **脑裂**：集群网络分区时两侧各自继续服务，恢复后需要数据一致性处理；EMQX 提供自动愈合（autoheal）策略，大规模部署要规划好网络与分区应对；
- **负载均衡**：设备通过**四层负载均衡**（LVS/Nginx stream/HAProxy/云 NLB）接入集群；TLS 在 LB 卸载或在 EMQX 终结；需要**源地址透传**（Proxy Protocol）才能在 EMQX 里拿到真实客户端 IP。

```text
# Nginx stream 示意：TCP 四层转发，设备连接分散到多个 EMQX 节点
stream {
  upstream emqx { least_conn; server emqx1:1883; server emqx2:1883; server emqx3:1883; }
  server { listen 1883; proxy_pass emqx; proxy_protocol on; }   # 配合 EMQX 的 proxy_protocol 监听器
}
```

参考 [Nginx 与负载均衡](#/infra/nginx)。

## 规则引擎与数据集成

规则 = **SQL 风格的事件匹配与转换 + 一个或多个动作**：

```sql
SELECT
  clientid,
  payload.temp  AS temp,
  payload.ts    AS ts,
  topic
FROM "acme/+/up/telemetry"
WHERE payload.temp > 80
```

动作：把结果转发到 **Kafka / RocketMQ**（解耦与削峰）、写入 **PostgreSQL/TimescaleDB / InfluxDB / MySQL**、调用 **HTTP**、重新发布到 MQTT 主题、写 Redis 等。

**架构建议**：Broker 只做**接入与分发**，不要在规则里做复杂业务或同步慢操作。典型链路：

```text
设备 ─MQTT→ EMQX ─规则引擎→ Kafka ─→ 流处理(Flink)/消费服务 ─→ 时序库/业务库/告警
```

- 用 **Kafka 缓冲**抵御下游波动，EMQX 与业务解耦，见 [Kafka 架构与存储](#/mw/kafka)；
- 规则引擎里的动作有**失败重试与缓冲队列（磁盘）**，下游不可用时不阻塞 MQTT 收发；
- 事件源：除消息外，还有**客户端连接/断开、订阅、消息投递/丢弃**等事件，可驱动在线状态、审计。

## 容量规划与内核调优

### 百万连接的资源模型

| 资源 | 说明 |
| --- | --- |
| **内存** | 每个连接 = socket 内核缓冲 + Erlang 进程 + 会话状态 + 订阅；常见量级**每连接几十 KB**（取决于缓冲区、订阅数、飞行窗口）。**100 万连接约需数十 GB 内存**，要留余量并压测 |
| **CPU** | 连接建立（TLS 握手）是 **CPU 峰值**；稳态下消息吞吐与规则/认证决定 CPU |
| **文件描述符** | 一个连接一个 fd，需调大 `ulimit -n` 与 `fs.file-max` |
| **端口** | 服务端监听端口固定，不受限；**压测客户端**才会遇到 65535 源端口限制（需多 IP/多端口） |
| **带宽** | 上行消息总量 + 下行；心跳包在百万设备下也不可忽视 |
| **磁盘** | 持久会话、离线消息、规则动作缓冲、日志 |

Linux 调优要点（节点上）：

```bash
ulimit -n 2097152
sysctl -w fs.file-max=2097152
sysctl -w fs.nr_open=2097152
sysctl -w net.core.somaxconn=32768
sysctl -w net.ipv4.tcp_max_syn_backlog=16384
sysctl -w net.core.rmem_max=16777216; sysctl -w net.core.wmem_max=16777216
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sysctl -w net.netfilter.nf_conntrack_max=2000000     # 若启用 conntrack，需调大，否则大量连接被丢包
```

排查参考 [Linux 线上排查](#/infra/linux)。

### 重连风暴与过载保护

**场景**：Broker 重启/网络抖动后，数十万设备同时重连，CPU 被 TLS 握手与认证打满，导致连接更慢、更多重试，形成**雪崩**。对策：

1. **设备端**：指数退避 + **随机抖动**（见 [Netty 实战：编解码、内存与调优](#/infra/netty-practice)）；固件里不要写“固定 N 秒重连”；
2. **Broker 端限流**：监听器级**连接速率限制**（`max_conn_rate`）、总连接上限、认证/授权请求限速；
3. 接入层 **LB 做排队与限流**，滚动重启节点而不是同时重启；
4. **TLS 会话复用 / 会话票据**，降低握手成本；必要时**硬件/专用节点做 TLS 卸载**；
5. 重启前先**优雅驱逐连接**（分批迁移，EMQX 有 connection rebalance 与 node evacuation 功能），而非直接 kill。

### 慢消费者与消息积压

- 订阅者消费慢（网络差、处理慢）会让 Broker 为其会话排队消息：**飞行窗口**（`max_inflight`）限制未确认数量，**队列长度**（`max_mqueue_len`）限制积压，超出丢弃（记录丢弃指标）；
- QoS 0 的消息在 Broker 默认可以不入队（`mqueue_store_qos0`），避免内存暴涨；
- **后端服务不要直接订阅海量设备主题慢慢处理**：使用**共享订阅或规则转 Kafka**，由 Kafka 消费组承受积压；
- 监控：连接数、会话数、订阅数、消息吞吐（in/out）、**丢弃数（dropped）**、队列长度、延迟、节点 CPU/内存/fd、TLS 握手速率。

## 高可用部署

- **集群 ≥ 3 节点**（Core 奇数个），跨可用区部署；LB 对节点做健康检查；
- **持久会话与保留消息**存储：5.x 默认在内置库，`RocksDB`/Mnesia；企业版支持**持久化到外部存储**以跨节点保存；注意保留消息与离线消息的**存储规模**；
- 滚动升级：先疏散节点连接 → 升级 → 加入集群 → 下一个；
- **边缘—云协同**：边缘 EMQX/Mosquitto 本地服务设备，通过**桥接（Bridge/Cluster Linking）**把数据转发到云端；断网时本地缓存、恢复后补传；
- 跨地域：多地域部署各自接入，通过 **Cluster Linking** 或 Kafka 汇聚，避免跨地域单集群的网络延迟与分区风险。

## 常见问题

| 现象 | 原因 / 对策 |
| --- | --- |
| 新增节点后连接分布不均 | 已有连接不会自动迁移；使用连接重平衡、LB 最少连接策略，或重启时分批 |
| 大量连接被拒绝 | 达到 `max_connections`、fd 不足、`somaxconn`/SYN 队列、conntrack 满；查看节点日志与系统日志 |
| 消息延迟升高 | 节点间网络、规则引擎同步动作阻塞、慢消费者、磁盘 IO（持久化）、Erlang 调度器过载 |
| 订阅数暴涨导致内存上升 | 设备订阅过多主题或使用 `#`；ACL 限制；每连接最大订阅数 `max_subscriptions` |
| 设备“幽灵在线” | 保活设置太长/NAT 超时；缩短 keepalive；依赖 Broker 事件而非设备自述 |
| 数据库认证压力大 | 每次连接查库；改 JWT/证书/本地缓存（认证结果缓存），连接风暴时尤其要注意 |

## 面试追问

> [!QUESTION] 为什么 EMQX 能支撑百万级连接？
> 基于 Erlang/OTP：每个连接是轻量进程，调度公平、进程隔离、每进程独立 GC，无全局 STW；节点内存是主要限制；集群通过路由表复制和 Core/Replicant 架构扩展连接承载量；加上内核参数与接入层调优。

> [!QUESTION] 集群里一条消息是怎么从发布者到达不同节点上的订阅者的？
> 订阅信息以路由表形式在集群中复制；发布者所在节点查询路由表，找到有匹配订阅的节点并转发（节点间通信），再由各节点本地投递给订阅者；不会广播给无订阅者的节点。

> [!QUESTION] 如何设计海量设备数据的后端消费链路？
> Broker 只做接入分发，规则引擎或共享订阅把数据转发到 Kafka，消费组水平扩展并发处理，写入时序库或业务库；Kafka 缓冲削峰，EMQX 与业务解耦；设备数据带唯一标识以便幂等处理。

> [!QUESTION] 什么是重连风暴？怎么防？
> Broker 重启或网络抖动后大量设备同时重连，TLS 握手和认证耗尽 CPU，造成更多失败重试形成雪崩。设备端使用指数退避加随机抖动；Broker 限制连接速率；LB 限流排队；滚动重启并优雅疏散连接。

> [!QUESTION] 设备的认证与授权怎么做才安全？
> 每台设备唯一凭证（证书或 token），全程 TLS；认证用 JWT/证书减少查库；ACL 限定设备只能发布/订阅含自己 ClientID 的主题；禁止匿名；管理端口不对公网开放；支持吊销与封禁。
