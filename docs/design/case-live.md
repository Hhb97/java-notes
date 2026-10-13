---
level: 高级
tags: [架构案例, 直播, 推流, 转码, CDN, RTMP, HLS, WebRTC, 低延迟, 弹幕, 礼物, 连麦, 首屏秒开]
summary: 以百万并发观众的直播系统为例，拆解端到端链路（采集编码→推流→接入→转码→CDN 分发→播放）、协议选型（RTMP/HTTP-FLV/HLS/LL-HLS/WebRTC 的延迟与成本）、首屏秒开与卡顿治理、推拉流鉴权与调度容灾、转码与多码率、直播间服务（状态、进房、在线人数）、弹幕/聊天室的大房间扇出与降采样、礼物打赏的强一致链路、连麦与混流、录制回放与审核、成本与带宽优化、监控指标，以及自建与云服务的选型。
---

# 案例：直播系统设计详解

> [!ABSTRACT] 核心要点
> - 直播是**两套系统的叠加**：**音视频媒体链路**（采集编码 → 推流 → 转码 → CDN 分发 → 播放，追求**低延迟、流畅、低成本**）+ **互动业务系统**（直播间、弹幕、礼物、连麦、榜单，追求**高并发、实时、一致**）。两者**解耦**：媒体走 CDN/流媒体服务器，互动走长连接与业务服务。
> - **协议决定延迟与成本**：**RTMP/HTTP-FLV（1~3 秒）**是主流；**HLS（5~30 秒）**兼容性最好但延迟高；**LL-HLS（2~5 秒）**折中；**WebRTC（< 1 秒）**用于连麦和超低延迟，但**成本与复杂度高**（SFU 集群、UDP）。**绝大多数观众走 CDN 的 FLV/HLS，主播连麦互动走 WebRTC。**
> - **带宽是最大的成本项**：观众数 × 码率，例如 500 万观众 × 2 Mbps ≈ **10 Tbps**，只能靠 **CDN 多级缓存**承载；源站只承受**每路流一份**。因此**优化码率（H.265/窄带高清）、多 CDN 调度、按需转码、P2P 辅助分发**是降本关键。
> - **用户体验指标**：**首屏时间（秒开）、卡顿率、端到端延迟、推流成功率**。秒开靠**边缘缓存最近一个 GOP（含关键帧）**与播放器预连接；抗卡顿靠**自适应码率（ABR）**与缓冲策略。
> - **互动的难点是大房间扇出**：一个房间百万在线，弹幕每秒上万条，**不可能把每条弹幕发给每个人**——要**限频、合并批量、降采样、分层/分片广播**，并接受“**弹幕不保证每人看到全部**”。
> - **礼物/打赏是交易**，必须**强一致 + 幂等 + 对账**（扣款、账务、主播收益），特效广播则是尽力而为；**直播必须有内容审核与合规能力**（截图/语音识别 + 人工 + 熔断）。

> [!NOTE] 说明
> 容量数字为用于推演的**假设**。音视频编解码、CDN 与具体云厂商能力细节较多，本文聚焦后端架构；协议、延迟与限制以所用产品官方文档与实测为准。长连接/广播的基础见 [IM 案例](#/design/case-im)、[推送案例](#/design/case-push)，高并发写见 [高并发写入案例](#/design/case-highwrite)。

## 一、需求与约束

### 1. 功能

- **开播/推流**：主播用 App/OBS 推流；开播通知；多码率、美颜/滤镜（端侧）；
- **观看**：观众拉流播放，秒开、流畅、可切换清晰度；
- **互动**：弹幕/聊天、点赞、礼物打赏、红包、连麦/PK、榜单、在线人数；
- **回放/录制**：直播录制，结束后点播回放；截图封面；
- **治理**：内容审核（画面+语音+文字）、封禁/断流、版权与合规、防刷。

### 2. 容量与指标（假设）

| 维度 | 假设 |
| --- | --- |
| 规模 | 同时开播 **1 万路**，同时在线观众 **500 万**；头部房间 **100 万在线**；峰值（大型活动）观众翻 3~5 倍 |
| 码率 | 主播推流 **2~4 Mbps（1080p/720p）**；观众拉流平均 **1.5 Mbps**（多码率档位分布） |
| 带宽 | 500 万 × 1.5 Mbps ≈ **7.5 Tbps**（CDN 承载）；源站回源 = 开播路数 × 码率 × 转码档位 ≈ 1 万 × 3 Mbps × 3 档 ≈ **90 Gbps**（量级） |
| 延迟 | 普通直播 **2~5 秒**；低延迟直播 **< 1~2 秒**；连麦 **< 400ms** |
| 体验 | 首屏 < 1 秒（P90）；卡顿率 < 1%；推流成功率 > 99.9% |
| 互动 | 头部房间弹幕峰值 1 万条/秒；礼物 TPS 数千；进房峰值（开播瞬间）数十万/分钟 |

## 二、媒体链路与协议

### 1. 端到端链路

<figure class="fig">
<svg viewBox="0 0 840 400" class="dg" role="img" aria-label="直播媒体链路：主播端采集音视频并编码为 H.264 和 AAC，通过 RTMP 或 SRT 或 WebRTC 推流到最近的边缘接入节点；边缘转发到源站流媒体集群；转码集群生成多档位码率，并生成截图与录制与审核旁路；CDN 多级缓存分发，观众通过 HTTP-FLV 或 HLS 或 WebRTC 拉流；控制面包含推拉流鉴权、调度、直播间服务和回调">
<rect class="b1" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">主播端</text>
<text class="ts" x="85" y="74" text-anchor="middle">采集·美颜·编码</text>
<rect class="b3" x="180" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">边缘接入</text>
<text class="ts" x="245" y="74" text-anchor="middle">RTMP/SRT/WebRTC</text>
<rect class="b5" x="340" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="410" y="52" text-anchor="middle" dominant-baseline="middle">源站流媒体</text>
<text class="ts" x="410" y="74" text-anchor="middle">汇聚·转封装·鉴权</text>
<rect class="b2" x="510" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="585" y="52" text-anchor="middle" dominant-baseline="middle">CDN 多级分发</text>
<text class="ts" x="585" y="74" text-anchor="middle">边缘缓存·就近</text>
<rect class="b1" x="690" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="755" y="52" text-anchor="middle" dominant-baseline="middle">观众播放器</text>
<text class="ts" x="755" y="74" text-anchor="middle">FLV/HLS/WebRTC</text>
<line class="l" x1="150" y1="62" x2="180" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="62" x2="340" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="62" x2="510" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="660" y1="62" x2="690" y2="62" marker-end="url(#arr)"/>
<rect class="b4" x="340" y="124" width="140" height="64" rx="8"/>
<text class="tb" x="410" y="146" text-anchor="middle" dominant-baseline="middle">转码集群</text>
<text class="ts" x="410" y="168" text-anchor="middle">多码率·水印·GPU</text>
<line class="l" x1="410" y1="94" x2="410" y2="124" marker-end="url(#arr)"/>
<rect class="b3" x="510" y="124" width="150" height="64" rx="8"/>
<text class="tb" x="585" y="146" text-anchor="middle" dominant-baseline="middle">旁路处理</text>
<text class="ts" x="585" y="168" text-anchor="middle">录制·截图·审核</text>
<line class="l" x1="480" y1="156" x2="510" y2="156" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="140" x2="585" y2="94"/>
<rect class="bg" x="20" y="210" width="800" height="176" rx="12"/>
<text class="th" x="36" y="234">控制面与互动面（与媒体面解耦）</text>
<rect class="b2" x="36" y="248" width="170" height="50" rx="6"/>
<text class="ts" x="121" y="268" text-anchor="middle" dominant-baseline="middle">推/拉流鉴权·调度</text>
<text class="ts" x="121" y="286" text-anchor="middle" dominant-baseline="middle">签名 URL · GSLB</text>
<rect class="b5" x="216" y="248" width="170" height="50" rx="6"/>
<text class="ts" x="301" y="268" text-anchor="middle" dominant-baseline="middle">直播间服务</text>
<text class="ts" x="301" y="286" text-anchor="middle" dominant-baseline="middle">状态机·进房·人数</text>
<rect class="b3" x="396" y="248" width="190" height="50" rx="6"/>
<text class="ts" x="491" y="268" text-anchor="middle" dominant-baseline="middle">互动长连接网关</text>
<text class="ts" x="491" y="286" text-anchor="middle" dominant-baseline="middle">弹幕·礼物特效广播</text>
<rect class="b4" x="596" y="248" width="210" height="50" rx="6"/>
<text class="ts" x="701" y="268" text-anchor="middle" dominant-baseline="middle">交易/账务</text>
<text class="ts" x="701" y="286" text-anchor="middle" dominant-baseline="middle">礼物·充值·收益结算</text>
<text class="ts" x="36" y="326" text-anchor="start">• 流媒体服务器通过回调通知业务：推流开始/断开、录制完成、转码状态 → 驱动直播间状态机</text>
<text class="ts" x="36" y="348" text-anchor="start">• 观众的“看”走 CDN（带宽大、无状态），“互动”走长连接与业务服务（并发大、有状态）</text>
<text class="ts" x="36" y="370" text-anchor="start">• 任何互动系统故障（弹幕/礼物）都不应影响画面播放：降级关闭互动，保视频</text>
</svg>
<figcaption>图 1：直播的媒体链路与控制/互动面</figcaption>
</figure>

### 2. 协议对比与选型

| 协议 | 典型用途 | 延迟 | 特点 | 局限 |
| --- | --- | --- | --- | --- |
| **RTMP** | **推流**（OBS/SDK → 服务端） | 1~3 秒 | 基于 TCP，成熟，推流事实标准 | 浏览器不能直接播放（Flash 淘汰），不适合大规模直接分发 |
| **SRT** | 推流（弱网/公网专线） | 数百毫秒~1 秒 | 基于 UDP，抗丢包好（ARQ/FEC） | 生态相对新 |
| **HTTP-FLV** | **播放**（移动端/PC 主流） | 1~3 秒 | HTTP 长连接流式传输，边缘缓存 GOP 秒开，延迟低 | 浏览器端依赖 MSE 播放器（flv.js 等） |
| **HLS** | 播放（兼容、点播/回放） | 常规 5~30 秒 | 切片 + m3u8 清单，纯 HTTP，**CDN 友好、兼容性最好**（iOS Safari 原生） | 切片时长导致高延迟 |
| **LL-HLS / LL-DASH** | 低延迟播放 | 2~5 秒 | 部分切片（Part）+ 预加载提示，延迟显著降低 | 实现与 CDN 支持要求较高 |
| **WebRTC** | **连麦、超低延迟观看** | **< 1 秒（常 200~500ms）** | UDP，自适应拥塞控制，端到端实时 | 需要 SFU 集群与信令，大规模分发成本高、CDN 支持弱 |

**选型建议**：

- 推流：**RTMP**（兼容）+ 弱网/专业场景 **SRT**；国内移动端 SDK 多用 RTMP 或自研 UDP 协议；
- **普通观看（99% 流量）**：**HTTP-FLV**（移动/PC）+ **HLS**（兼容兜底、回放）；
- **低延迟场景**（电商带货互动、拍卖、答题）：**LL-HLS / WebRTC 低延迟观看**；
- **连麦/PK/语音聊天室**：**WebRTC**（SFU），主播间走 WebRTC，**混流后输出为 RTMP/FLV 推给 CDN** 供大量观众观看（把“互动小圈子”与“大规模观众”分开）。

### 3. 视频基础（后端必须懂的几点）

| 概念 | 要点 |
| --- | --- |
| **编码** | 视频 H.264（兼容最好）/H.265（同画质省约 30~50% 码率，兼容与专利成本）/AV1；音频 AAC/Opus |
| **码率/分辨率/帧率** | 码率决定带宽与画质；1080p30 约 3~6 Mbps，720p 约 1.5~3 Mbps（视编码器而定） |
| **GOP 与关键帧（I 帧）** | 视频分组，每组以关键帧开头；播放器**必须从关键帧开始解码**。GOP 越长压缩越好但**首屏越慢、切换/随机访问越慢**（常设 1~2 秒一个关键帧） |
| **首屏秒开的关键** | **边缘/源站缓存最近一个 GOP**：新观众连接时先下发缓存的 GOP（从关键帧开始），无需等待下一个关键帧 |
| **音视频同步** | 以时间戳（PTS/DTS）对齐；推流端时间戳需单调，断流重连要处理时间戳回退 |
| **自适应码率（ABR）** | 同一内容多档位（如 1080p/720p/480p/360p），播放器按网络带宽/缓冲区自动切换（HLS/DASH 原生支持；FLV 多档位需业务切换） |
| **容器与封装** | FLV（直播）、TS/fMP4（HLS 切片）、MP4（点播） |

## 三、关键技术设计

### 1. 推流与拉流：鉴权、调度与容灾

**推/拉流鉴权**（防盗推、盗链）：

```text
推流 URL：rtmp://push.example.com/live/{streamId}?auth_key={timestamp}-{rand}-{uid}-{md5(path-timestamp-rand-uid-secret)}
服务端校验：时间戳未过期、签名正确 → 允许推流（回调业务系统校验该主播当前允许开播）
拉流 URL：同样带过期时间与签名（CDN 边缘校验），或 Token 鉴权（私有/付费直播）
```

- **签名 + 短有效期**（HMAC/MD5，密钥在服务端，见 [加密与签名](#/security/crypto)）；
- **推流唯一性**：同一 streamId 只允许一个推流者，新推流**顶掉**旧推流（防止主播 App 崩溃重连冲突）；
- 回调校验：边缘接入收到推流请求→**回调业务服务**确认（主播身份、是否封禁、直播间状态）。

**调度（GSLB）**：

- **推流调度**：根据主播地理/运营商/节点负载/质量，返回**最优接入节点**；支持**主备线路**，主线路质量差自动切换并**断线重连**；
- **拉流调度**：按观众位置/运营商/CDN 质量/成本分配 CDN 与节点，**多 CDN 容灾**（见 [DNS 与 CDN：智能解析](#/cs/net-dns)）；
- **容灾**：推流支持**多路并推**（双线路到不同机房/厂商）；某 CDN 故障或质量下降时，把观众调度到备用 CDN（调度配置热更新，见 [API 网关案例：热更新](#/design/case-gateway)）。

### 2. 转码与多码率

| 要点 | 说明 |
| --- | --- |
| **为什么转码** | 统一编码格式/码率、多档位适配不同网络与设备、加水印/混流、适配不同协议封装 |
| **转码成本** | CPU 软编码（x264）昂贵；**GPU 硬编码（NVENC）/专用芯片**吞吐高；是**计算成本的主要来源** |
| **按需转码** | 只对**热门直播间**（观众多）生成多档位，冷门直播间只保留原画，节省大量转码资源；观众量增长时动态触发 |
| **转码模板** | 档位（1080p/720p/480p/360p）+ 码率 + 编码参数，按业务配置；**窄带高清**（内容自适应编码）降码率不降画质 |
| **转封装（不转码）** | RTMP → FLV/HLS 只改容器、不重新编码，开销小，用于原画分发 |
| **延迟影响** | 转码引入额外延迟（几百毫秒~数秒），低延迟场景尽量少转码或用快速档位 |
| **调度** | 转码任务调度到有空闲 GPU 的节点；失败自动重试/迁移；**断流重连后转码续接** |

### 3. 首屏秒开与卡顿治理

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="首屏与卡顿优化：观众点击进入直播间，播放器并行做 DNS 与调度预解析、预连接；边缘节点命中缓存时直接下发最近一个 GOP 从关键帧开始，实现秒开；播放期间根据缓冲区与网速自适应切换码率；卡顿时降码率、追帧或加大缓冲；源站断流时边缘缓存继续并提示主播卡顿">
<rect class="b1" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">点击进房</text>
<text class="ts" x="85" y="74" text-anchor="middle">并行：调度·预连接</text>
<rect class="b3" x="170" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">边缘节点命中</text>
<text class="ts" x="245" y="74" text-anchor="middle">缓存最近 GOP</text>
<rect class="b5" x="340" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="415" y="52" text-anchor="middle" dominant-baseline="middle">从关键帧下发</text>
<text class="ts" x="415" y="74" text-anchor="middle">立即解码出画面</text>
<rect class="b2" x="510" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="575" y="52" text-anchor="middle" dominant-baseline="middle">首帧渲染</text>
<text class="ts" x="575" y="74" text-anchor="middle">目标 &lt; 1 秒</text>
<rect class="b4" x="660" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="720" y="52" text-anchor="middle" dominant-baseline="middle">持续播放</text>
<text class="ts" x="720" y="74" text-anchor="middle">ABR·缓冲控制</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="62" x2="340" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="62" x2="510" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="62" x2="660" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="760" height="164" rx="10"/>
<text class="th" x="36" y="144">秒开与抗卡顿手段</text>
<text class="ts" x="36" y="168">• 服务端：缓存 GOP；GOP 设 1~2 秒；热门流预热到边缘；调度到近且空闲的节点</text>
<text class="ts" x="36" y="188">• 播放器：预解析 DNS 与预连接；不等音频完整即渲染首帧；首个包到来后快速起播</text>
<text class="ts" x="36" y="208">• ABR：按带宽与缓冲区水位切换码率；弱网优先保流畅（降清晰度）；网络恢复再升档</text>
<text class="ts" x="36" y="228">• 延迟与卡顿的权衡：缓冲越大越不卡但延迟越高；低延迟模式用小缓冲 + 追帧（加速播放追赶直播点）</text>
<text class="ts" x="36" y="248">• 主播侧：弱网自适应编码码率、丢帧策略、断线自动重连续推；上行带宽探测</text>
<text class="ts" x="36" y="268">• 度量：首帧耗时、卡顿次数与时长占比、端到端延迟、起播失败率，播放器 SDK 上报并按维度分析</text>
</svg>
<figcaption>图 2：首屏秒开与抗卡顿</figcaption>
</figure>

## 四、直播间服务

### 1. 直播间状态机

```text
CREATED(已创建) → PREPARING(推流中，未对外) → LIVE(直播中) → PAUSED(主播断流，保留一段时间) → ENDED(已结束) → REPLAY(回放可用)
                                      └─ BANNED(被封禁/断流)
```

- 状态由**推流回调**（开始/断开）+ 业务操作驱动，**条件更新**保证状态单向流转（见 [订单支付案例：状态机](#/design/case-payment)）；
- **断流容忍**：主播网络抖动断流，**保留 30~60 秒**（PAUSED），期间重连续推则无缝恢复，观众端显示“主播暂离”而不是直接结束；
- 开播/下播事件发 MQ（通知粉丝、更新榜单、触发录制转存、结算统计），见 [事件驱动架构](#/design/event-driven)。

### 2. 进房与在线人数

**进房**（开播瞬间可能数十万人在同一分钟涌入）：

- 请求：鉴权 → 获取直播间信息（缓存）→ 拉流地址（调度）→ 建立互动长连接（加入房间）；
- **直播间信息、主播资料、拉流地址模板**全部**多级缓存**（本地 + Redis），进房路径**不查数据库**；
- **限流与排队**：大型活动进房限流（令牌桶），超限返回“人太多，稍后重试”并**客户端随机退避**（防惊群，见 [推送案例：惊群](#/design/case-push)）；
- **同房间连接分片**：互动长连接按 `roomId` 与连接数分片到多个网关节点（见弹幕一节）。

**在线人数统计**：

| 方式 | 说明 |
| --- | --- |
| **长连接计数** | 各网关节点统计本节点该房间连接数，**定期（如 1~3 秒）上报聚合**（Redis 按节点分片 `HSET room:{id}:online nodeId count`，读时求和） |
| **心跳上报 + HLL** | 每个观众周期性心跳，`PFADD room:{id}:uv:{minute} uid` 估算**窗口内去重在线人数**（误差约 1%，见 [工程中的算法：HyperLogLog](#/cs/algo-engineering)） |
| **展示策略** | 在线人数是展示指标，允许秒级延迟与近似；超大房间用“1.2 万”之类近似显示，减少精确读压力 |
| **累计观看数（PV/UV）** | 本地聚合 + 批量 `INCRBY`（见 [高并发写：计数](#/design/case-highwrite)） |

## 五、弹幕与聊天室（互动长连接）

### 1. 问题：大房间的消息扇出

头部直播间：**100 万在线**，弹幕峰值 **1 万条/秒**。若每条弹幕发给每个人 = **100 亿条/秒**的下行推送——物理上不可能，也无意义（人眼一秒读不了几十条）。

<figure class="fig">
<svg viewBox="0 0 820 340" class="dg" role="img" aria-label="大房间弹幕治理：发送端限频与审核后写入房间消息总线；服务端按房间做采样降频与合并，把一秒内的多条弹幕打包成一批；房间被分片到多个网关节点，每个节点只负责一部分观众的连接，广播时按节点分发批量消息；客户端按速率渲染，超过则丢弃或合并；重要消息如礼物与系统公告走高优先级不降采样">
<rect class="b1" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">发送弹幕</text>
<text class="ts" x="85" y="74" text-anchor="middle">限频·审核·去重</text>
<rect class="b3" x="170" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">房间消息总线</text>
<text class="ts" x="245" y="74" text-anchor="middle">Kafka / Redis Stream</text>
<rect class="b5" x="340" y="30" width="160" height="64" rx="8"/>
<text class="tb" x="420" y="52" text-anchor="middle" dominant-baseline="middle">房间聚合器</text>
<text class="ts" x="420" y="74" text-anchor="middle">降采样·合并·分级</text>
<rect class="b2" x="520" y="30" width="160" height="64" rx="8"/>
<text class="tb" x="600" y="52" text-anchor="middle" dominant-baseline="middle">批量打包 100ms</text>
<text class="ts" x="600" y="74" text-anchor="middle">一包多条</text>
<rect class="b4" x="700" y="30" width="100" height="64" rx="8"/>
<text class="tb" x="750" y="52" text-anchor="middle" dominant-baseline="middle">按节点</text>
<text class="ts" x="750" y="74" text-anchor="middle">广播</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="62" x2="340" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="62" x2="520" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="680" y1="62" x2="700" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="780" height="204" rx="10"/>
<text class="th" x="36" y="144">治理手段</text>
<text class="ts" x="36" y="168">• 发送端限频：单用户每秒/每分钟条数、重复内容、新用户/低等级冷却；敏感词与 AI 审核在入口前置</text>
<text class="ts" x="36" y="188">• 降采样：房间入口 QPS 超阈值时按概率/权重丢弃部分弹幕（大会员/主播/管理员/高等级优先保留），保证每秒下发条数有上限（如 20~50 条）</text>
<text class="ts" x="36" y="208">• 合并与批量：100ms~200ms 打一包，一包多条，减少连接上的小包与系统调用；相同内容合并为“×N”</text>
<text class="ts" x="36" y="228">• 房间分片：一个房间的连接分布到多个网关节点；聚合器把批量消息按节点发布，节点本地遍历连接下发（同推送案例的广播）</text>
<text class="ts" x="36" y="248">• 优先级：系统公告/礼物/主播消息高优先级，不被降采样；普通弹幕可丢；队列有界，满则丢弃低优先级</text>
<text class="ts" x="36" y="268">• 客户端侧：渲染限速与轨道管理，超出屏幕容量直接丢弃；弱网只收少量或关闭弹幕</text>
<text class="ts" x="36" y="288">• 不要求“每人看到全部、顺序一致”：弹幕是氛围，不是可靠消息；与 IM 群聊的“不丢不重不乱序”目标不同</text>
<text class="ts" x="36" y="308">• 持久化：弹幕按需异步落库/落日志（审核、回放时间轴），不在实时路径同步写库</text>
</svg>
<figcaption>图 3：大房间弹幕的限频、降采样与批量广播</figcaption>
</figure>

### 2. 长连接网关

- 接入层同 [IM 案例](#/design/case-im)/[推送案例](#/design/case-push)：Netty + WebSocket，**百万连接 / 约 10 万每节点**，心跳保活（见 [TCP 深入：保活](#/cs/net-tcp)）；
- **房间成员关系**：节点本地维护 `roomId → 本节点连接集合`，**不在 Redis 里逐用户存房间成员**（百万级成员读写不可承受）；用户进房时只在本节点登记，节点向房间聚合器订阅房间消息；
- **房间路由**：`roomId` 的消息通过 Redis Pub/Sub、Kafka 或内部 RPC 扇出到**订阅了该房间的节点集合**；
- **热点房间动态扩缩**：头部房间的连接自动分配到更多节点；开播前预热；
- **断线重连与补偿**：重连后**不补发历史弹幕**（只拉近期少量或礼物等重要事件），避免重连风暴放大。

## 六、礼物与打赏（交易链路）

与弹幕本质不同：**礼物是资金交易，必须强一致、幂等、可对账**。

<figure class="fig">
<svg viewBox="0 0 820 320" class="dg" role="img" aria-label="送礼流程：用户发起送礼请求，礼物服务生成幂等订单号；调用账务服务扣减用户余额并记账，成功后订单置为已支付；然后发布礼物事件到消息队列；下游消费者分别做特效广播、主播收益累计、榜单更新和任务活动统计；收益结算异步批量汇总以避免热点账户；失败重试和对账保证最终一致">
<rect class="b1" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">① 送礼请求</text>
<text class="ts" x="85" y="74" text-anchor="middle">幂等 giftOrderNo</text>
<rect class="b3" x="170" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="245" y="52" text-anchor="middle" dominant-baseline="middle">② 账务扣款</text>
<text class="ts" x="245" y="74" text-anchor="middle">余额 − 礼物价值</text>
<rect class="b5" x="340" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="410" y="52" text-anchor="middle" dominant-baseline="middle">③ 订单成功</text>
<text class="ts" x="410" y="74" text-anchor="middle">状态机条件更新</text>
<rect class="b2" x="500" y="30" width="140" height="64" rx="8"/>
<text class="tb" x="570" y="52" text-anchor="middle" dominant-baseline="middle">④ 礼物事件</text>
<text class="ts" x="570" y="74" text-anchor="middle">Outbox → MQ</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="62" x2="340" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="480" y1="62" x2="500" y2="62" marker-end="url(#arr)"/>
<rect class="b4" x="660" y="14" width="140" height="30" rx="6"/>
<text class="ts" x="730" y="29" text-anchor="middle" dominant-baseline="middle">特效广播（尽力）</text>
<rect class="b4" x="660" y="50" width="140" height="30" rx="6"/>
<text class="ts" x="730" y="65" text-anchor="middle" dominant-baseline="middle">主播收益（汇总）</text>
<rect class="b4" x="660" y="86" width="140" height="30" rx="6"/>
<text class="ts" x="730" y="101" text-anchor="middle" dominant-baseline="middle">榜单 / 活动统计</text>
<line class="l" x1="640" y1="62" x2="660" y2="30" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="62" x2="660" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="62" x2="660" y2="100" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="140" width="780" height="164" rx="10"/>
<text class="th" x="36" y="164">要点</text>
<text class="ts" x="36" y="188">• 扣款是强一致的核心：同步完成并幂等（giftOrderNo 唯一），失败直接返回失败，不展示特效（先扣款后展示）</text>
<text class="ts" x="36" y="208">• 特效广播、榜单、活动统计是派生事件：异步、可重试、可丢（特效）；以账务和订单为事实来源（见 订单支付案例）</text>
<text class="ts" x="36" y="228">• 主播收益（热点账户）：流水先行 + 批量汇总，或子账户拆分，避免行锁热点（见 高并发写：红包入账）</text>
<text class="ts" x="36" y="248">• 连击合并：用户连续送同一礼物，客户端合并展示“×99”，服务端可合并为一次批量扣款或限频，降低交易 TPS</text>
<text class="ts" x="36" y="268">• 榜单：Redis ZSET 实时榜（主播榜、贡献榜），见 Feed 流与排行榜；防刷（刷礼物洗钱/套现）需风控</text>
<text class="ts" x="36" y="288">• 对账：礼物订单 ⇄ 账务流水 ⇄ 主播收益逐笔核对；分成（平台/公会/主播）按规则结算，日终批量</text>
</svg>
<figcaption>图 4：礼物打赏：强一致扣款 + 异步派生</figcaption>
</figure>

## 七、连麦与混流

**场景**：主播与主播 PK、主播与观众连麦。需要**低延迟双向互动**（< 400ms），而大量观众只需要看到合成后的画面。

| 模式 | 做法 | 取舍 |
| --- | --- | --- |
| **WebRTC SFU 转发 + 观众端混合渲染** | 连麦各方推流到 SFU，SFU 转发给其他参与者；观众订阅多路流自行布局 | 观众端复杂度高，带宽翻倍 |
| **服务端混流（MCU/合流）** | 把多路画面和声音在服务端合成**一路流**，再以 RTMP 推到 CDN 供大量观众观看 | **主流方案**：观众侧简单、CDN 友好；代价是合流的计算资源与额外延迟 |
| **混合** | 参与者之间用 WebRTC 互通（超低延迟），同时服务端合流输出到 CDN | 兼顾互动与大规模观众 |

要点：

- **信令**（加入/离开/静音/布局）走业务长连接，**媒体**走 WebRTC（STUN/TURN/ICE 穿透 NAT，UDP 被封时 TURN 中继）；
- SFU 集群的容量规划：每路上行 × 订阅人数；跨机房中继；
- 连麦的**音频策略**：回声消除、降噪、音量归一（端侧 + 服务端）；
- 观众观看连麦画面有“合流延迟”，业务上要接受互动者与观众的体验差异。

## 八、录制、回放与审核

### 1. 录制与回放

- **旁路录制**：从转码/源站流旁路录制成 **HLS 切片（TS/fMP4）或 MP4 分段**，写入对象存储（见 [分布式对象存储案例](#/design/case-objectstore)）；直播结束后合并生成**点播回放**（m3u8 清单），走 CDN 分发；
- **断流续录**：主播断流重连后在同一回放时间轴上续接，或生成多段后拼接；
- **时间轴数据**：弹幕/礼物/在线人数按时间戳存储，回放时同步展示；
- **精彩片段/剪辑**：基于关键事件（高峰弹幕、礼物）自动打点；
- **存储成本**：录制数据量大（1 万路 × 3Mbps ≈ 3.75 TB/小时），要做**生命周期**（热点回放保留，冷门转低频/删除，见对象存储案例）。

### 2. 内容审核（直播的生命线）

| 维度 | 做法 |
| --- | --- |
| **画面** | **旁路截图/抽帧**（如每 2~5 秒一张）送 AI 审核（涉黄涉暴涉政、违禁品），疑似→人工复核；高风险**自动断流/打码** |
| **音频** | 语音转文字（ASR）+ 文本审核；关键词与声纹 |
| **文字** | 弹幕、昵称、标题、评论：敏感词/AI 审核（入口前置，见上） |
| **主播准入** | 实名认证、风险评级、保证金/等级；高风险主播更密集抽检 |
| **处置** | 警告、禁言、断流、封号；**审核通道独立于主链路**（不能影响直播延迟），延迟审核（有数秒~十几秒窗口）→ 风险与成本平衡，重点直播间加人工值守 |
| **合规** | 直播资质/备案、未成年人保护（限时限额/防沉迷）、版权（音乐/赛事转播）、留存日志，**以适用法规为准** |

## 九、成本与带宽优化

**直播的成本结构：CDN 带宽 ≫ 转码计算 > 存储 > 其他**。

| 手段 | 说明 |
| --- | --- |
| **提升编码效率** | H.265/AV1（兼容性与专利成本权衡）、窄带高清/内容自适应编码、合适的码率阶梯（避免过高码率） |
| **多 CDN 与调度** | 按价格、质量、覆盖动态分配流量；闲时/忙时策略；自建边缘节点承接头部流量 |
| **按需转码** | 冷门直播间不做多档位，热门才转码；观众端按网络选择档位 |
| **P2P 辅助分发** | 观众之间共享分片（WebRTC DataChannel），分担 CDN 带宽（对低延迟 FLV 难度大，HLS 点播/回放更成熟）；要考虑上行带宽与流量成本、用户隐私与耗电 |
| **缓存命中率** | 热门流在边缘充分缓存；回源合并（同一流多个边缘节点回源时合并），降低源站出口 |
| **降低闲置** | 无人观看的直播间自动降级（暂停转码/降码率）；观众少时不开多档位 |
| **回放存储治理** | 生命周期、去重、压缩转码为更省的格式 |
| **成本监控** | 按业务线/主播/直播间维度的带宽、转码、存储成本核算，识别异常（盗链盗刷） |

## 十、高可用、安全与监控

### 1. 高可用与降级

| 风险 | 对策 |
| --- | --- |
| 主播推流断线/弱网 | 自动重连续推、码率自适应、双线路并推、保留直播间状态窗口 |
| 接入/源站节点故障 | 多节点冗余，调度剔除故障节点；流在多节点备份（热备流）或快速切换 |
| 某 CDN 质量下降/故障 | 多 CDN 调度自动切换；监控卡顿率与首帧；观众端失败重试换线路 |
| 转码集群故障/过载 | 降级为原画直出（转封装）、降低档位数、排队；弹性扩容 GPU |
| 互动系统故障（弹幕/礼物） | **保视频**：关闭互动或降级为只读；礼物暂时不可用时友好提示，不影响观看 |
| 进房洪峰 | 缓存 + 限流 + 客户端退避 + 预热；开播前预扩容 |
| 热点房间 | 连接分片、广播按节点、降采样；礼物/榜单热点写治理（见 [高并发写](#/design/case-highwrite)） |
| 误操作/违规直播 | 一键断流/封禁；审核熔断；运营后台权限与审计 |

### 2. 安全与防刷

- **推拉流防盗**：签名 URL + 短有效期 + Referer/IP/设备限制，防止盗推（冒充主播）与盗链（盗刷流量）；
- **DDoS/CC**：高防 CDN/WAF、边缘限流；
- **机器人观众与刷人气**：设备指纹、行为风控、异常在线曲线检测；在线人数展示的真实性合规；
- **礼物刷单/洗钱**：风控规则（异常充值-送礼-提现链路）、限额与延迟结算；
- **隐私**：观众 IP/位置脱敏，聊天内容存储合规，见 [加密与密钥管理](#/security/crypto)。

### 3. 监控指标

| 层 | 指标 |
| --- | --- |
| **推流** | 推流成功率、推流码率/帧率稳定性、断流次数与时长、各接入节点负载、推流延迟 |
| **播放（体验）** | **首帧耗时（P50/P90/P99）、卡顿率（卡顿时长/播放时长）、起播失败率、端到端延迟、清晰度分布**（播放器 SDK 上报） |
| **CDN** | 各 CDN 带宽、命中率、错误码（4xx/5xx）、回源带宽 |
| **转码** | 转码成功率、转码延迟、GPU 利用率、排队长度 |
| **互动** | 长连接数、弹幕发送/下发速率、丢弃比例、礼物 TPS 与成功率、房间人数分布 |
| **业务/成本** | 同时开播数、观众数、人均观看时长、带宽成本、转码成本 |

指标体系与告警见 [指标监控](#/infra/obs-metrics)、[链路追踪与 SLO](#/infra/obs-trace)（直播的 SLO 以**首帧与卡顿率**为核心用户体验指标）。

## 十一、选型：自建 vs 云

| | **云直播服务**（阿里云/腾讯云/华为云直播、声网/即构 RTC 等） | **开源自建**（SRS / ZLMediaKit / Nginx-RTMP / MediaMTX；WebRTC：LiveKit/mediasoup/Janus） |
| --- | --- | --- |
| 成本 | 按流量与时长计费，规模小时最省；规模大时带宽成本高 | 自建需要机器、带宽、研发与运维；大规模下单位成本可更低 |
| 速度 | 快速上线，SDK 完善（推拉流、美颜、连麦） | 周期长，需要流媒体与音视频专业能力 |
| 能力 | CDN 覆盖、转码、审核、录制一应俱全 | 灵活可定制，但 CDN/全球加速需另采购 |
| 适合 | **绝大多数业务**（首选）；初创与中型 | 超大规模、强定制、私有化/合规 |

**建议**：**优先云直播 + 自研业务层**（直播间、互动、礼物、账务、风控）；超大规模再通过**多云 CDN + 自建部分边缘/源站/转码**优化成本；WebRTC 连麦用成熟的 RTC 服务或开源 SFU（LiveKit 等），不要从零写。

> [!WARNING] 选型提醒
> 各云厂商与开源项目的功能、协议支持、计费与限制差异较大且持续变化，请以官方文档与实测（尤其延迟、首屏、卡顿率）为准。

## 十二、常见坑

| 坑 | 对策 |
| --- | --- |
| 把弹幕当可靠消息，逐条发给全部观众 | 限频、降采样、批量打包、按节点广播；允许丢弃 |
| 互动系统故障拖垮视频播放 | 媒体面与互动面解耦；互动降级，保视频 |
| 首屏慢（等下一个关键帧） | 边缘缓存 GOP；GOP 1~2 秒；播放器预连接 |
| 只用单一 CDN，质量波动无法应对 | 多 CDN + 质量监控 + 自动调度 |
| 所有直播间都转多档位，转码成本爆炸 | 按需转码：热门才多档位 |
| 进房时同步查数据库/多个 RPC，开播瞬间被打垮 | 进房信息全缓存、限流、客户端退避 |
| 推流无鉴权或签名永不过期，被盗推盗链 | 签名 + 短有效期 + 回调校验 + 顶掉旧推流 |
| 主播断流直接结束直播间 | 状态机保留窗口，重连续推 |
| 礼物扣款与展示不一致（先展示后扣款失败） | 先扣款成功再展示；幂等订单、对账 |
| 热点主播账户行锁排队 | 流水先行批量汇总、子账户拆分 |
| 把直播延迟当唯一目标，过度追求 WebRTC | 按场景选协议：大部分用 FLV/HLS，互动小圈子用 WebRTC |
| 回放录制直接存原始大文件无生命周期 | 对象存储分片 + 生命周期 + 冷热分层 |
| 审核滞后，违规内容扩散 | 旁路截图 + AI + 人工值守 + 自动断流熔断 |
| 在线人数用精确计数，热点房间拖垮 Redis | 分片计数/HLL，近似展示 |
| 没有端侧体验指标，不知道观众实际卡不卡 | 播放器 SDK 上报首帧/卡顿，建立体验大盘 |

## 面试追问

> [!QUESTION] 直播系统的整体架构是什么？
> 媒体链路是主播端采集编码，通过 RTMP 等协议推流到边缘接入，汇聚到源站，转码生成多码率，经 CDN 多级缓存分发，观众用 HTTP-FLV 或 HLS 拉流播放；旁路做录制、截图和审核。控制面包括推拉流鉴权、调度和直播间服务，互动面由长连接网关承载弹幕和礼物特效，账务系统处理礼物交易，媒体和互动解耦，互动故障不影响视频。

> [!QUESTION] RTMP、HLS、HTTP-FLV、WebRTC 怎么选？
> RTMP 是推流标准，延迟一到三秒；HTTP-FLV 播放延迟低、支持边缘缓存秒开，是移动和 PC 主流；HLS 切片导致延迟五到三十秒但兼容性最好、CDN 友好，用于兜底和回放；LL-HLS 把延迟降到二到五秒；WebRTC 延迟低于一秒但需要 SFU 且大规模分发成本高，用于连麦。常见组合是推流 RTMP、观看 FLV 加 HLS、连麦用 WebRTC 再混流成一路推给 CDN。

> [!QUESTION] 直播首屏怎么做到秒开？卡顿怎么治理？
> 边缘节点缓存最近一个 GOP，新观众连接时直接从关键帧开始下发，GOP 设置一到两秒；播放器并行做调度、预连接并快速起播；播放中用自适应码率根据带宽和缓冲水位切换档位，低延迟场景用小缓冲加追帧；主播端弱网降码率、双线路并推、断线续推；通过播放器 SDK 上报首帧和卡顿指标持续优化。

> [!QUESTION] 百万人在线的房间，弹幕怎么设计？
> 不可能把每条弹幕发给每个人。入口做用户限频和审核，房间聚合器按秒做降采样，高优先级用户和系统消息不降，相同内容合并，把一百毫秒内的弹幕批量打包，房间连接分片到多个网关节点，消息按节点广播由节点本地遍历连接下发，客户端限速渲染并可丢弃；弹幕不保证每人收到全部和顺序一致，与 IM 的可靠性目标不同。

> [!QUESTION] 礼物打赏和弹幕在架构上有什么区别？
> 礼物是资金交易，必须强一致、幂等、可对账：先用幂等订单号同步扣款成功，再发事件异步触发特效广播、主播收益、榜单和活动统计，特效可以尽力而为，收益和账务以流水为准；主播收益是热点账户，用流水先行批量汇总或子账户拆分；弹幕是氛围消息，可丢可降采样。

> [!QUESTION] 直播的带宽成本怎么优化？
> 带宽是最大成本项，观众数乘以码率。可以用 H.265 或窄带高清降码率，多 CDN 按质量和价格调度，按需转码只对热门直播间生成多档位，提升边缘缓存命中和回源合并，观众侧 P2P 辅助分发，闲置直播间降级，并按业务线和直播间核算成本识别盗链盗刷。

> [!QUESTION] 连麦是怎么实现的？
> 连麦双方需要亚秒级延迟，走 WebRTC 经 SFU 转发，信令通过业务长连接，NAT 穿透靠 STUN 和 TURN；大量观众不适合都用 WebRTC，主流做法是服务端把多路画面混流合成一路，以 RTMP 推给 CDN 供观众用 FLV 或 HLS 观看，既保证互动低延迟又控制成本，代价是合流计算和观众侧稍高的延迟。

> [!QUESTION] 直播内容审核怎么做？
> 旁路抽帧截图交给 AI 审核画面，语音转文字后审核文本，弹幕和昵称在入口前置敏感词和 AI 检测，疑似内容人工复核，高风险自动断流或打码；主播实名和分级决定抽检密度；审核通道独立于主链路避免影响延迟，并遵守直播资质、未成年人保护和版权等合规要求。
