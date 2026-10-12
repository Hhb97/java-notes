---
level: 高级
tags: [架构案例, IM, 即时通讯, 长连接, WebSocket, 消息可靠性, 群聊, 扩散, Netty]
summary: 以千万级 DAU 的即时通讯为背景，拆解接入层长连接、路由、消息可靠投递（ACK、会话内序号、去重、离线拉取）、单聊与群聊的读写扩散、存储分层与分片、多端同步、在线状态、离线推送、大群优化、撤回与审核，含容量估算、数据模型与故障降级。
---

# 案例：即时通讯（IM）系统设计详解

> [!ABSTRACT] 核心要点
> - IM 的难点不在“发一条消息”，而在 **千万级长连接 + 消息不丢不重不乱序 + 多端同步 + 大群扩散**。
> - **接入层有状态，业务层无状态**：长连接节点（Netty/WebSocket）保存连接，业务逻辑拆到无状态服务；用 **路由表（用户 → 接入节点）** 把消息送到正确连接。
> - **可靠性三件套**：**ACK + 重传**（至少一次）、**会话内单调递增序号 seq**（保证有序、发现空洞）、**消息 ID 去重**（保证幂等）→ 实现“**至少一次投递 + 幂等 = 效果上恰好一次**”。
> - **“先存储后投递”**：消息先持久化再推送；推送失败/离线靠**客户端按 seq 拉取**补齐，**推是优化，拉才是可靠的兜底**。
> - **群聊扩散**：小群**写扩散**（每人一份收件箱），大群**读扩散**（一份消息 + 每人记录已读位点），混合策略应对万人群。
> - 存储按**热冷分层 + 分片**（会话 ID 或用户 ID），读写模式是**追加写 + 范围读**，适合 **LSM 类存储 / 分库分表 MySQL / 宽列库**。

> [!NOTE] 说明
> 容量数字为推演用的**假设**，实际需结合业务实测；本文聚焦通用架构设计。接入层的网络与 Netty 原理见 [Netty 核心原理](#/infra/netty-core)、[Netty 实战](#/infra/netty-practice)，设备协议对比可参考 [MQTT](#/iot/mqtt)。

## 一、需求与约束

### 1. 功能范围

单聊、群聊（含大群）、文本/图片/语音/文件/表情等消息类型、已读回执、在线状态、多端登录同步（手机 + PC + Web）、离线消息与推送、消息撤回、历史消息漫游、敏感内容审核、消息搜索（后续）。

### 2. 非功能目标（假设）

| 维度 | 目标 |
| --- | --- |
| 实时性 | 在线用户端到端 P99 < 500 ms（同地域） |
| 可靠性 | **不丢**（已确认发送成功的消息）、**不重**（用户侧去重）、**会话内有序** |
| 规模 | DAU 2000 万，峰值同时在线 200 万~300 万 |
| 可用性 | 99.99%；单机房故障可切换；节点宕机用户自动重连 |
| 多端 | 同账号多端在线并保持消息与已读状态同步 |
| 安全 | 传输加密（TLS）、鉴权、反垃圾/审核；可选端到端加密（影响审核与多端设计） |

### 3. 容量估算（假设，写出推导）

- 日消息量：DAU 2000 万 × 人均发送 30 条 ≈ **6 亿条/天** ≈ 平均 **7000 条/秒**，峰值按 3~5 倍 ≈ **2~3.5 万条/秒**（发送）；
- 接收侧放大：单聊 1 倍，群聊扩散（平均群 50 人）→ 投递量可达发送量的数倍，峰值投递约 **10 万条/秒**量级；
- 长连接：同时在线 200 万，单台接入机承载约 **10 万连接**（调优后，内存与 fd 为主要约束，见 [Linux 排查](#/infra/linux)）→ 至少 **20 台**，考虑冗余与单机故障时重连风暴，按 **40~60 台**规划；
- 存储：6 亿条/天 × 平均 0.5 KB（含元数据）≈ **300 GB/天**，一年 ≈ 100 TB 量级（单副本、未含索引与副本）→ **热数据保留 3~6 个月，冷数据归档对象存储**；
- 心跳：200 万连接，每 30 秒一次 ≈ **6.7 万心跳/秒**，需要轻量处理（只刷新 TTL，不做数据库操作）。

## 二、核心设计决策（ADR）

| 决策点 | 方案 | 理由 / 取舍 |
| --- | --- | --- |
| 接入协议 | **WebSocket（Web/PC）+ 自定义 TCP 协议或 MQTT（App）**，Protobuf 编码 | 全双工、低延迟；二进制协议省流量 |
| 接入层 | Netty，无业务逻辑，仅做**连接管理、编解码、心跳、转发** | 有状态层尽量薄，便于水平扩展与快速重启 |
| 路由 | **Redis：user → {device → 接入节点}**；节点间通过 **MQ/RPC** 转发 | 任意接入节点都能找到目标用户所在节点 |
| 可靠性 | **ACK + 会话内 seq + 消息 ID 去重 + 离线拉取** | 至少一次 + 幂等；拉取兜底 |
| 消息流程 | **先落库/落 MQ，再投递**；发送方收到“服务端已接收 ACK”才认为发送成功 | 避免“推了没存”导致丢失 |
| 单聊存储 | 每个会话一条**有序消息流**；按会话 ID 分片 | 追加写、按 seq 范围读 |
| 群聊扩散 | **小群写扩散 + 大群读扩散**（混合） | 写扩散读快写放大；读扩散写省读重 |
| 存储引擎 | 热：分库分表 MySQL / 宽列库（Cassandra/HBase/TableStore）；冷：对象存储 | 追加写、时序范围读、海量数据 |
| 多端同步 | 每端记录 **last_seq**，断线重连后按 seq 增量拉取 | 简单可靠 |
| 离线推送 | APNs / FCM / 厂商通道（小米/华为/OPPO/vivo） | 应用不在线时唤醒 |

## 三、总体架构

<figure class="fig">
<svg viewBox="0 0 820 460" class="dg" role="img" aria-label="IM 总体架构：客户端经负载均衡连接到接入层，接入层通过路由服务查询用户所在节点，消息服务处理发送、校验审核、分配序号并写入消息存储和 MQ，推送服务根据路由把消息投递到目标接入节点，离线用户通过离线推送通道提醒，群组服务管理成员关系，在线状态服务维护在线信息，存储层包含 Redis 路由与会话序号、消息库与冷存储">
<rect class="b" x="20" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">客户端 A/B/C…</text>
<rect class="b1" x="170" y="30" width="110" height="44" rx="8"/>
<text class="tb" x="225" y="52" text-anchor="middle" dominant-baseline="middle">四层 LB</text>
<line class="l" x1="130" y1="52" x2="170" y2="52" marker-end="url(#arr)"/>
<rect class="b3" x="320" y="20" width="230" height="64" rx="10"/>
<text class="tb" x="435" y="42" text-anchor="middle" dominant-baseline="middle">接入层 Gateway（Netty，有状态）</text>
<text class="ts" x="435" y="64" text-anchor="middle">连接管理 · 心跳 · 编解码 · 鉴权</text>
<line class="l" x1="280" y1="52" x2="320" y2="52" marker-end="url(#arr)"/>
<rect class="b5" x="30" y="150" width="170" height="64" rx="10"/>
<text class="tb" x="115" y="172" text-anchor="middle" dominant-baseline="middle">路由服务</text>
<text class="ts" x="115" y="194" text-anchor="middle">user → 接入节点 / 设备</text>
<rect class="b2" x="260" y="150" width="190" height="64" rx="10"/>
<text class="tb" x="355" y="172" text-anchor="middle" dominant-baseline="middle">消息服务（无状态）</text>
<text class="ts" x="355" y="194" text-anchor="middle">校验 · 审核 · 分配 seq · 持久化</text>
<rect class="b4" x="510" y="150" width="170" height="64" rx="10"/>
<text class="tb" x="595" y="172" text-anchor="middle" dominant-baseline="middle">推送/投递服务</text>
<text class="ts" x="595" y="194" text-anchor="middle">在线推送 · 离线通道</text>
<line class="l" x1="435" y1="84" x2="355" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="182" x2="510" y2="182" marker-end="url(#arr)"/>
<line class="l" x1="595" y1="150" x2="480" y2="84" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="182" x2="200" y2="182" marker-end="url(#arr)"/>
<rect class="b" x="710" y="150" width="100" height="64" rx="10"/>
<text class="tb" x="760" y="172" text-anchor="middle" dominant-baseline="middle">APNs/FCM</text>
<text class="ts" x="760" y="194" text-anchor="middle">厂商推送</text>
<line class="l" x1="680" y1="182" x2="710" y2="182" marker-end="url(#arr)"/>
<rect class="b1" x="30" y="260" width="140" height="56" rx="8"/>
<text class="tb" x="100" y="280" text-anchor="middle" dominant-baseline="middle">群组服务</text>
<text class="ts" x="100" y="300" text-anchor="middle">成员 · 权限 · 公告</text>
<rect class="b1" x="190" y="260" width="140" height="56" rx="8"/>
<text class="tb" x="260" y="280" text-anchor="middle" dominant-baseline="middle">在线状态服务</text>
<text class="ts" x="260" y="300" text-anchor="middle">Presence</text>
<rect class="b1" x="350" y="260" width="140" height="56" rx="8"/>
<text class="tb" x="420" y="280" text-anchor="middle" dominant-baseline="middle">审核/风控</text>
<text class="ts" x="420" y="300" text-anchor="middle">敏感词 · 频控</text>
<rect class="b1" x="510" y="260" width="140" height="56" rx="8"/>
<text class="tb" x="580" y="280" text-anchor="middle" dominant-baseline="middle">文件/媒体服务</text>
<text class="ts" x="580" y="300" text-anchor="middle">对象存储 + CDN</text>
<rect class="b2" x="670" y="260" width="140" height="56" rx="8"/>
<text class="tb" x="740" y="280" text-anchor="middle" dominant-baseline="middle">MQ（Kafka）</text>
<text class="ts" x="740" y="300" text-anchor="middle">解耦 · 削峰 · 扩散</text>
<rect class="bg" x="30" y="350" width="780" height="90" rx="10"/>
<text class="th" x="46" y="374">存储层</text>
<text class="ts" x="46" y="398">• Redis：路由表、在线状态、会话 seq 计数、未读数、热点缓存</text>
<text class="ts" x="46" y="418">• 消息库：热数据分库分表 MySQL / 宽列库（按会话/用户分片），冷数据归档到对象存储</text>
<text class="ts" x="46" y="434">• 会话/关系库：用户、好友、群、成员；搜索：Elasticsearch（可选）</text>
</svg>
<figcaption>图 1：IM 总体架构：接入层有状态，业务层无状态</figcaption>
</figure>

| 组件 | 职责 | 设计要点 |
| --- | --- | --- |
| **接入层** | 维护 TCP/WebSocket 长连接、心跳、鉴权、协议编解码、把上行消息转交业务、把下行消息写到连接 | **不放业务逻辑**；单机 10 万连接；优雅下线（通知客户端迁移重连）；**连接元数据**注册到路由 |
| **路由服务** | 回答“用户 X 的哪些设备连在哪个接入节点” | Redis Hash：`route:{uid}` → `{deviceId: nodeId}`，带 TTL 并随心跳续期 |
| **消息服务** | 校验、审核、分配会话 seq、持久化、触发投递 | 无状态可扩缩；**幂等**（按 client_msg_id 去重） |
| **推送服务** | 查路由，把消息推给在线端；不在线则走离线推送 | 跨节点转发用 MQ 或内部 RPC；批量化 |
| **群组服务** | 成员列表、权限、禁言 | 成员列表强缓存（大群分页/分片） |

接入层调优与连接管理（epoll、`SO_REUSEPORT`、内存池、心跳 `IdleStateHandler`、背压、水位线）参考 [Netty 实战](#/infra/netty-practice)。

## 四、长连接接入

### 1. 连接建立与保活

1. 客户端通过 **DNS/调度服务**拿到就近、负载较低的接入节点地址（避免“一个超大 LB 被连接数打爆”，也便于灰度与迁移）；
2. 建立 TLS + WebSocket/TCP，**携带令牌鉴权**（见 [认证授权](#/security/auth)），成功后接入层向路由表登记 `uid/device → node`；
3. **应用层心跳**（如 30 秒）：NAT/运营商会回收空闲连接，**TCP keepalive 不够**，需应用层心跳 + 自适应间隔（移动端省电）；服务端连续 N 次无心跳则判断离线并清理路由；
4. **断线重连**：指数退避 + 抖动，避免服务端重启后“惊群重连”；重连后上报各会话的 **last_seq** 进行增量同步。

### 2. 连接层的工程要点

| 问题 | 对策 |
| --- | --- |
| 单机 fd/内存瓶颈 | 调大 `ulimit -n`、内核参数；Netty 使用池化直接内存，控制每连接缓冲；每连接对象尽量小 |
| 慢消费者拖垮节点 | 写缓冲高低水位线；`isWritable()` 为 false 时暂停推送并走离线拉取；超限断开 |
| 重连风暴 | 客户端退避抖动；服务端限流连接建立速率；多机房与灰度发布分批滚动 |
| 节点宕机 | 路由 TTL 到期自动清理；客户端检测断开后重连到其他节点，并按 seq 拉取空洞 |
| 弱网 | 消息重传、合并小包、压缩（zstd/gzip）、协议精简 |
| 安全 | TLS、令牌短期有效并可续期、连接级与用户级限流、防刷与恶意大包 |

## 五、消息可靠性：不丢、不重、有序

### 1. 单聊发送与投递流程

<figure class="fig">
<svg viewBox="0 0 820 430" class="dg" role="img" aria-label="单聊消息时序：发送方发送带 client_msg_id 的消息给接入节点 A，转发消息服务；消息服务幂等去重、分配会话 seq、写入消息存储和收件箱后向发送方回服务端 ACK；随后查询路由，若接收方在线则经接入节点 B 推送，接收方收到后回送达 ACK；若离线则触发离线推送，用户上线后按 last_seq 拉取">
<rect class="b" x="20" y="20" width="90" height="32" rx="6"/>
<text class="tb" x="65" y="36" text-anchor="middle" dominant-baseline="middle">发送方 A</text>
<rect class="b3" x="170" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="220" y="36" text-anchor="middle" dominant-baseline="middle">接入节点</text>
<rect class="b2" x="340" y="20" width="110" height="32" rx="6"/>
<text class="tb" x="395" y="36" text-anchor="middle" dominant-baseline="middle">消息服务</text>
<rect class="b5" x="520" y="20" width="110" height="32" rx="6"/>
<text class="tb" x="575" y="36" text-anchor="middle" dominant-baseline="middle">推送/路由</text>
<rect class="b" x="700" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="750" y="36" text-anchor="middle" dominant-baseline="middle">接收方 B</text>
<line class="ld" x1="65" y1="52" x2="65" y2="418"/>
<line class="ld" x1="220" y1="52" x2="220" y2="418"/>
<line class="ld" x1="395" y1="52" x2="395" y2="418"/>
<line class="ld" x1="575" y1="52" x2="575" y2="418"/>
<line class="ld" x1="750" y1="52" x2="750" y2="418"/>
<line class="l" x1="65" y1="80" x2="395" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="230" y="72" text-anchor="middle">① SEND(client_msg_id, conv, 内容)</text>
<text class="ts" x="405" y="104" text-anchor="start">② 去重(client_msg_id) · 审核 · 分配 seq</text>
<text class="ts" x="405" y="122" text-anchor="start">③ 持久化消息 + 写 B 的收件箱/索引</text>
<line class="la" x1="395" y1="146" x2="65" y2="146" marker-end="url(#arr-a)"/>
<text class="ta" x="230" y="164" text-anchor="middle">④ 服务端 ACK(msg_id, seq) → A 显示“已发送”</text>
<line class="l" x1="395" y1="198" x2="575" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="485" y="190" text-anchor="middle">⑤ 投递事件</text>
<text class="ts" x="585" y="222" text-anchor="start">⑥ 查路由：B 在线？</text>
<line class="l" x1="575" y1="246" x2="750" y2="246" marker-end="url(#arr)"/>
<text class="ts" x="662" y="238" text-anchor="middle">⑦ 推送(seq)</text>
<line class="la" x1="750" y1="276" x2="395" y2="276" marker-end="url(#arr-a)"/>
<text class="ta" x="572" y="294" text-anchor="middle">⑧ 送达 ACK(seq) → 通知 A “已送达”</text>
<text class="ts" x="405" y="322" text-anchor="start">⑨ 超时未 ACK：重推；B 离线：走离线推送通道</text>
<line class="l" x1="750" y1="360" x2="395" y2="360" marker-end="url(#arr)"/>
<text class="ts" x="572" y="352" text-anchor="middle">⑩ 上线后 PULL(conv, last_seq) 增量拉取</text>
<text class="ts" x="405" y="396" text-anchor="start">兜底：发现 seq 不连续（空洞）→ 主动拉取补齐</text>
</svg>
<figcaption>图 2：单聊：服务端 ACK、送达 ACK 与离线拉取</figcaption>
</figure>

### 2. 三个保证怎么实现

| 保证 | 机制 | 说明 |
| --- | --- | --- |
| **不丢** | **先持久化再 ACK**；发送方未收到服务端 ACK 就**超时重发**；投递靠 **送达 ACK + 重推**；最终靠**客户端按 seq 拉取** | 已向发送方确认的消息必须已落盘（多副本）；客户端本地也保存待发队列，重启后继续重发 |
| **不重** | 发送方生成 **client_msg_id**（UUID/雪花），服务端据此**幂等去重**；接收方按 **msg_id/seq** 去重 | 至少一次传输 + 幂等处理，效果等同恰好一次（见 [消息队列通用问题](#/mw/mq)） |
| **有序** | **会话内单调递增 seq**，由服务端分配；客户端按 seq 排序展示；发现 seq 空洞则补拉 | 只保证**同一会话内**有序，不需要全局有序（全局有序代价极高） |

**为什么需要两种 ACK**：服务端 ACK 表示“**服务端已接管，不会丢**”（发送方可停止重发）；送达 ACK 表示“**对方设备已收到**”（用于“已送达”标识与重推判断）；另有“已读”回执表示用户已查看。

### 3. 会话内 seq 的分配

每个会话维护一个计数器。常见方案：

| 方案 | 做法 | 优缺点 |
| --- | --- | --- |
| **Redis `INCR conv:{id}:seq`** | 每条消息原子自增 | 简单高性能；需防 Redis 故障后回退（持久化 + 故障时从库中 max(seq) 恢复并**跳号**） |
| **按会话分片的单写者** | 同一会话的消息被路由到同一个消息服务分区**串行处理**（Kafka 按会话 key 分区） | 无需分布式锁，天然有序；热点会话需要特殊处理 |
| 数据库自增/号段 | 每会话一行或号段预分配 | 可靠但吞吐受限，号段思想见 [分布式 ID](#/distributed/id) |

**允许 seq 不连续（跳号）但不允许倒退**：客户端把“缺失”与“跳号”区分开——服务端维护“该会话有效 seq 范围”，客户端遇到空洞先补拉，拉不到则视为跳号忽略。

### 4. 离线与多端：拉取模型

**“推”只负责快，“拉”才是可靠的底线。** 客户端为每个会话记录 `last_seq`：

```text
上线/重连：对每个会话（或通过“会话摘要”批量接口）
   PULL(conv_id, from_seq = last_seq + 1, limit = 100)   → 服务端返回增量消息
客户端对 seq 去重、排序、更新 last_seq，并上报“已同步到 seq”（可兼作已读/送达回执）
```

- **会话列表同步**：服务端返回“各会话最新 seq 与最新一条摘要”，客户端对比本地决定拉哪些会话，避免上线后对所有会话逐一拉取；
- **多端**：每个设备独立维护各会话的 last_seq；一端读了，通过已读事件同步到其他端；**同账号多端都会收到新消息**（路由里是设备级）；
- 超出保留期（如 90 天）的历史消息走历史漫游接口，从冷存储读取。

## 六、群聊：读扩散与写扩散

核心问题：一个人发一条消息，**N 个成员都要看到**。

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="群聊两种扩散方式：写扩散在发消息时为每个成员的收件箱各写一份，读取快但写放大严重；读扩散只存一份群消息，每个成员记录自己读到的位点，拉取时读群消息流，写入省但读取时需要合并多个会话；混合策略为小群写扩散、大群读扩散">
<rect class="b3" x="20" y="30" width="360" height="190" rx="12"/>
<text class="th" x="36" y="56">写扩散（Push / Fan-out on write）</text>
<rect class="b" x="40" y="74" width="90" height="34" rx="6"/>
<text class="ts" x="85" y="91" text-anchor="middle" dominant-baseline="middle">发送 1 条</text>
<rect class="b2" x="210" y="70" width="150" height="26" rx="5"/>
<text class="ts" x="285" y="83" text-anchor="middle" dominant-baseline="middle">成员 1 收件箱 +1</text>
<rect class="b2" x="210" y="102" width="150" height="26" rx="5"/>
<text class="ts" x="285" y="115" text-anchor="middle" dominant-baseline="middle">成员 2 收件箱 +1</text>
<rect class="b2" x="210" y="134" width="150" height="26" rx="5"/>
<text class="ts" x="285" y="147" text-anchor="middle" dominant-baseline="middle">… 成员 N 收件箱 +1</text>
<line class="l" x1="130" y1="91" x2="210" y2="83" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="91" x2="210" y2="115" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="91" x2="210" y2="147" marker-end="url(#arr)"/>
<text class="ts" x="36" y="184" text-anchor="start">✓ 读取简单：每人只读自己的收件箱，未读数好算</text>
<text class="ts" x="36" y="204" text-anchor="start">✗ 写放大 N 倍：万人群每条消息写万次</text>
<rect class="b5" x="420" y="30" width="360" height="190" rx="12"/>
<text class="th" x="436" y="56">读扩散（Pull / Fan-out on read）</text>
<rect class="b" x="440" y="74" width="90" height="34" rx="6"/>
<text class="ts" x="485" y="91" text-anchor="middle" dominant-baseline="middle">发送 1 条</text>
<rect class="b4" x="600" y="84" width="160" height="34" rx="6"/>
<text class="ts" x="680" y="101" text-anchor="middle" dominant-baseline="middle">群消息流（仅 1 份）</text>
<line class="l" x1="530" y1="91" x2="600" y2="101" marker-end="url(#arr)"/>
<text class="ts" x="440" y="146" text-anchor="start">成员各自保存：已读位点 read_seq</text>
<text class="ts" x="440" y="164" text-anchor="start">拉取 = 读群流 (read_seq, latest]</text>
<text class="ts" x="436" y="184" text-anchor="start">✓ 写入只 1 次，大群友好</text>
<text class="ts" x="436" y="204" text-anchor="start">✗ 每个会话一次读取，会话多时读放大；未读数要差值计算</text>
<rect class="bg" x="20" y="240" width="760" height="76" rx="10"/>
<text class="th" x="36" y="264">混合策略（工程实践）</text>
<text class="ts" x="36" y="286">• 小群（≤ 约 500 人）写扩散，体验好；大群/超大群（数千至数十万）读扩散，只写一份群消息</text>
<text class="ts" x="36" y="304">• 在线推送始终是“按在线成员遍历推送”，但落库按上面策略；万人群推送做分批 + 按节点聚合，避免瞬时打爆</text>
</svg>
<figcaption>图 3：群聊扩散：写扩散与读扩散的取舍</figcaption>
</figure>

### 大群的在线推送优化

- **按接入节点聚合**：先按成员的路由分组，每个接入节点只收到**一条群消息 + 成员列表**，由节点本地分发给本机连接，把跨节点流量从 O(成员数) 降到 O(节点数)；
- **分批、限速与优先级**：万人群消息分批扇出；活跃发言者/@我的消息优先；
- **合并与限频**：高频群聊可对推送合并（如 200ms 窗口），客户端批量渲染；
- **@ 与重要消息**：单独通道保证到达；普通消息允许“只提示有新消息”，客户端打开群时再拉；
- **成员数据**：成员列表放 Redis（大群分页/分片存储），成员变更通过事件失效缓存；
- **未读数**：写扩散时对每个收件箱计数；读扩散时 `未读 = 群最新 seq − 我的 read_seq`，**不为每个成员维护计数**。

## 七、存储设计

### 1. 数据特征

**追加写为主、按会话与 seq 范围读、冷热明显、海量**。查询模式：①按会话拉取最近 N 条；②按 seq 区间增量同步；③按 msg_id 点查（撤回、引用）；④搜索（单独走 ES）。

### 2. 表设计（精简，MySQL 风格；宽列库同理）

```sql
-- 消息主表：按 conv_id 分片（同一会话落同一分片，范围读高效、seq 分配串行）
CREATE TABLE im_message (
  conv_id     BIGINT NOT NULL,            -- 会话ID：单聊 = hash(min(uidA,uidB),max(...))；群聊 = group_id
  seq         BIGINT NOT NULL,            -- 会话内单调递增序号
  msg_id      BIGINT NOT NULL,            -- 全局唯一ID（雪花），用于点查与去重
  client_msg_id VARCHAR(40) NOT NULL,     -- 客户端生成，发送幂等
  sender_id   BIGINT NOT NULL,
  msg_type    TINYINT NOT NULL,
  content     VARBINARY(4096) NOT NULL,   -- 文本/元数据（Protobuf）；大文件只存对象存储地址
  status      TINYINT NOT NULL DEFAULT 0, -- 0 正常 1 已撤回 2 已删除
  send_time   DATETIME(3) NOT NULL,
  PRIMARY KEY (conv_id, seq),
  UNIQUE KEY uk_dedup (conv_id, client_msg_id),   -- 发送幂等
  KEY idx_msgid (msg_id)
);

-- 用户会话表（会话列表、未读、同步位点）
CREATE TABLE im_user_conv (
  user_id BIGINT NOT NULL, conv_id BIGINT NOT NULL,
  last_msg_seq BIGINT, read_seq BIGINT NOT NULL DEFAULT 0,   -- 已读位点（读扩散未读 = last_msg_seq - read_seq）
  pinned TINYINT, muted TINYINT, updated_at DATETIME(3),
  PRIMARY KEY (user_id, conv_id), KEY idx_updated (user_id, updated_at)
);

-- 写扩散收件箱（小群/单聊可选，用于更快的个人时间线）
CREATE TABLE im_inbox (
  user_id BIGINT NOT NULL, inbox_seq BIGINT NOT NULL, conv_id BIGINT, msg_seq BIGINT,
  PRIMARY KEY (user_id, inbox_seq)
);
```

两种“同步模型”的选择：**按会话同步**（每个会话独立 seq，客户端对每个会话拉取，上面已采用）；或**按用户同步**（每个用户一个全局递增的 inbox_seq，上线只需一次 `PULL(inbox_seq > last)`，对“会话很多”的用户更友好，但需写扩散）。微信类大规模实践倾向按用户维度的同步序列，实现简单；选型取决于群规模与会话数。

### 3. 分片与冷热分层

| 手段 | 说明 |
| --- | --- |
| **分片键 = conv_id** | 会话内顺序读写集中在一个分片；热点大群单独分片或拆分 |
| 按时间分表/分区 | `im_message_202610` 之类，过期整表归档/删除，避免大表 DELETE |
| **热/冷分层** | 近 3~6 个月放 SSD 热库；更早归档到对象存储（Parquet/压缩块），按需异步读取 |
| 缓存 | 每会话最近 N 条放 Redis（List/ZSet，按 seq），覆盖大部分“打开会话”读取 |
| 搜索 | 异步消费消息流写入 Elasticsearch，按用户可见范围做权限过滤（见 [Elasticsearch](#/mw/es)） |

详细的分片方案与扩容迁移见 [分库分表](#/mysql/sharding)。

### 4. 消息队列的角色

Kafka 在 IM 中用于：**异步解耦**（落库、审核、搜索索引、统计、推送各自消费）、**削峰**、**群扩散任务**。**按 conv_id 分区**保证会话内顺序；消费者幂等。**但“发送成功”的判定不依赖下游 MQ 消费完成**——只要消息已持久化即可（持久化与 MQ 的一致性可用事务消息或本地消息表，见 [分布式事务](#/distributed/transaction)）。详见 [Kafka](#/mw/kafka)。

## 八、在线状态、多端与已读

### 1. 在线状态（Presence）

- 状态来源：**连接登记 + 心跳续期**。Redis `SET online:{uid}:{device} nodeId EX 90`，心跳刷新 TTL；
- **订阅扩散代价**：用户状态变化要通知好友/群成员，**状态通知量 = 变更数 × 关注者数**，规模大时会成为风暴。优化：只对**当前打开的会话/可见的好友**订阅（客户端按需订阅）；大群不推送成员在线状态；状态变更**节流合并**（抖动的上下线延迟几秒再广播）；
- “最近在线时间”不必实时，查询时读取。

### 2. 多端同步

- 路由里按设备记录，**发送给 B 的消息要投递到 B 的所有在线设备**；A 的其他设备也要收到 A 自己发的消息（“自己发的消息同步”）；
- 已读状态跨端同步：设备 X 上报 `read_seq`，服务端更新后向该用户其他设备发 **已读同步事件**，并清理推送角标/通知；
- **踢下线策略**：按产品规则限制同类设备数量（如手机仅一台在线），新登录挤旧连接，旧端收到“被踢”事件。

### 3. 已读回执

- 单聊：接收方上报 `read_seq`，服务端转发给对方，对方 UI 对 `seq ≤ read_seq` 的消息显示“已读”；
- 群聊：**“N 人已读”成本很高**，一般只对小群提供，且**批量上报、节流**；大群不提供或仅提供“已读人数的近似值”。

## 九、离线推送与通知

用户不在线（或应用在后台被系统回收连接）时，通过**系统级推送通道**唤醒：

| 平台 | 通道 | 注意 |
| --- | --- | --- |
| iOS | APNs | 令牌随应用/系统更新变化，需维护 deviceToken；静默推送有频率限制 |
| Android（海外） | FCM | 依赖 Google 服务 |
| Android（国内） | 厂商通道：小米、华为、OPPO、vivo、荣耀…（或统一推送联盟） | 各厂商限额、分类（通讯类优先级高）与角标规则不同；**自建保活不可靠且耗电** |

设计要点：

- **推送内容最小化**：只带“有新消息”提示与会话/消息 ID，**不带敏感原文**（或客户端本地解密）；点击后拉取完整内容；
- **折叠与去重**：同一会话连续消息合并为一条通知，使用 collapse key；
- **免打扰、勿扰时段、会话静音**在服务端过滤，减少无效推送；
- 推送是**尽力而为**，**可靠性仍靠拉取**；
- 失败与令牌失效处理（APNs 410 → 删除令牌）。

## 十、撤回、删除与审核

| 功能 | 设计 |
| --- | --- |
| **撤回** | 不物理删除，**把原消息 status 置为“已撤回”并发一条撤回事件**（带 msg_id/seq）；各端收到后替换展示；离线用户通过拉取得到已撤回状态。限制时限（如 2 分钟）与权限（本人/群管理员）；撤回事件本身也需可靠投递 |
| **删除（仅自己）** | 记录用户维度的删除标记，不影响他人 |
| **内容审核** | 发送链路中**同步轻量校验**（敏感词 DFA/AC 自动机、频控、黑名单）+ **异步深度审核**（图像/语音/文本模型）；命中违规后撤回并追责；审核不应拖慢主链路，失败时有降级策略 |
| **反垃圾** | 发送频率、陌生人消息限制、举报与封禁；见 [Web 安全](#/security/web) 中的防刷与限流思路 |
| **端到端加密（可选）** | 服务端无法看内容，审核/搜索/多端同步/历史漫游都受影响，需整体设计（Signal 协议类方案） |

## 十一、可用性、降级与容灾

| 风险 | 对策 |
| --- | --- |
| 接入节点宕机 | 客户端自动重连到其他节点；路由 TTL 清理；**重连后按 seq 增量拉取**，不丢消息 |
| 消息服务/存储不可用 | 发送侧返回失败（**不能给假 ACK**），客户端重试并保留本地队列；存储多副本、跨机房 |
| 单机房故障 | 多机房部署，**用户就近接入、单元化**；跨机房消息经专线/MQ 转发；DNS/调度切流 |
| 群消息洪峰（热点大群） | 分批扇出、合并推送、降级为“仅提示 + 拉取”；对热点群限流与单独分片 |
| 重连风暴（发布/故障后） | 分批滚动发布、客户端退避抖动、服务端限制新建连接速率 |
| Redis 路由丢失 | 路由是可重建的软状态：连接节点定期**全量上报**或心跳补登；路由缺失时按“离线”处理并走拉取兜底 |
| 消息积压 | 按优先级分队列（单聊 > 群聊 > 系统通知）；消费者扩容；非核心（搜索、统计）可延后 |
| 灰度与回滚 | 协议版本号与兼容；分批灰度；关键开关（关闭已读回执、在线状态推送）可一键降级 |

## 十二、监控与演进

**核心指标**：在线连接数、建连成功率与耗时、心跳超时数、端到端消息延迟（发送→送达 ACK P99）、**消息丢失率/重复率（对账指标）**、ACK 超时重传率、离线拉取量、推送到达率、各队列积压、接入节点内存与 fd。指标与告警设计见 [指标监控：Prometheus、Micrometer 与 Grafana](#/infra/obs-metrics)；一条消息的全链路用 `msg_id` + `traceId` 串联（见 [链路追踪、日志与告警](#/infra/obs-trace)），可用**探针账号定期互发消息**做主动拨测，端到端验证。

**演进方向**：音视频通话（WebRTC + 信令）、消息搜索、朋友圈/动态（读写扩散的另一应用）、频道/超级群、端到端加密、AI 助手接入（与 [RAG 与 Agent](#/ai/agent) 结合）、多语言实时翻译。

## 十三、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 推 vs 拉 | **推为主、拉兜底** | 客户端需要实现 seq 管理与补洞逻辑 |
| 全局有序 vs 会话内有序 | 会话内有序 | 跨会话不保证顺序，符合产品语义 |
| 写扩散 vs 读扩散 | 混合 | 两套逻辑，复杂度更高 |
| 强一致 vs 最终一致 | 消息持久化强保证，状态类（已读、在线）最终一致 | 展示可能短暂不一致 |
| 实时已读/在线精确 vs 节流 | 节流合并 | 精度换成本 |
| 长连接自建 vs 使用现成 MQTT/第三方 IM | 视团队规模与业务定制度 | 自建成本与运维复杂度高，见 [MQTT](#/iot/mqtt) |

## 面试追问

> [!QUESTION] IM 如何保证消息不丢、不重、有序？
> 不丢靠先持久化再回服务端 ACK、发送方超时重发、送达 ACK 加重推、客户端按 seq 增量拉取兜底；不重靠发送方 client_msg_id 做服务端幂等去重、接收方按 msg_id 和 seq 去重；有序靠服务端分配的会话内单调递增 seq，客户端按 seq 排序并发现空洞补拉。至少一次加幂等，等效恰好一次。

> [!QUESTION] 为什么需要“服务端 ACK”和“送达 ACK”两种？
> 服务端 ACK 表示消息已被服务端持久化接管，发送方可停止重发并显示已发送；送达 ACK 表示对方设备已收到，用于已送达状态和服务端判断是否需要重推。已读回执则是用户查看后的另一层确认。

> [!QUESTION] 单个用户断线重连后如何补齐消息？
> 客户端为每个会话记录 last_seq，重连后上报，服务端返回之后的增量消息；也可先拉取会话摘要对比最新 seq 再决定拉哪些会话。拉取依赖服务端持久化的消息，所以即使推送丢了也能补齐，推送只负责快，拉取负责可靠。

> [!QUESTION] 群聊用读扩散还是写扩散？万人大群怎么办？
> 小群用写扩散，每个成员有独立收件箱，读取简单、未读数好算，但写放大；大群用读扩散，群消息只存一份，成员记录已读位点，读取时按位点拉取，未读数用最新 seq 减已读位点。在线推送按接入节点聚合成员，分批限速、合并推送，高峰降级为仅提示后拉取。

> [!QUESTION] 千万级长连接如何设计接入层？
> 接入层只做连接管理、心跳、编解码和转发，业务拆到无状态服务；单机用 Netty 加 epoll，调大 fd 和内核参数，控制每连接内存并设置写缓冲水位线应对慢消费者；路由表记录用户到节点映射，应用层心跳续期；通过调度服务分配节点，重连指数退避加抖动避免风暴，发布时分批滚动。

> [!QUESTION] 如何分配会话内递增的 seq？Redis 故障后怎么办？
> 可用 Redis INCR 按会话自增，或按会话 key 把消息路由到同一分区串行处理分配。Redis 故障恢复时从数据库取该会话最大 seq 并跳号避免倒退，客户端允许 seq 不连续但不允许回退，遇到空洞先补拉，拉不到就视为跳号。

> [!QUESTION] 消息撤回怎么实现？离线用户怎么办？
> 不物理删除，把原消息状态置为已撤回并发出携带 msg_id 的撤回事件，各在线端替换展示；离线用户重连拉取消息时拿到的已是撤回状态，因此天然一致。撤回有时限和权限校验，撤回事件同样要可靠投递，并同步清理推送通知和搜索索引。
