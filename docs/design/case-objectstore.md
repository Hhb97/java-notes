---
level: 高级
tags: [架构案例, 对象存储, 分布式文件系统, 纠删码, 副本, 分片上传, 预签名URL, 元数据, 小文件合并, 垃圾回收, S3]
summary: 以百亿对象、数十 PB 的分布式对象存储为例，拆解需求与容量估算、接入层/元数据层/数据层/调度修复的分层架构、数据布局（大文件分块与小文件合并）、三副本与纠删码的取舍、写入的可见性与原子提交、元数据分片与列举、分片上传与断点续传、预签名 URL 与权限、秒传与去重的安全风险、下载与 CDN、删除与垃圾回收、静默损坏与修复、跨区域复制，以及业务系统使用对象存储的最佳实践。
---

# 案例：分布式文件/对象存储设计详解

> [!ABSTRACT] 核心要点
> - 对象存储（S3 模型）是**扁平命名空间的 Key→不可变对象**：`PUT/GET/DELETE/LIST`，**没有真正的目录和随机改写**，换来**近乎无限的水平扩展**与很低的单位成本。业务系统应**把文件放对象存储、把 Key 和元信息放数据库**，不要把二进制塞进 MySQL。
> - 架构上**元数据与数据分离**：**元数据层**（Key → 对象的位置、大小、校验和、版本）要**强一致、可有序列举**；**数据层**只管“字节放哪、怎么不丢”。**对象何时“存在”由元数据提交决定**：**先写数据、后提交元数据**，数据没写完对象就不可见。
> - **可靠性**靠**多副本（读快、成本 3x）**或**纠删码 EC（如 RS(6,3)，成本 1.5x，但修复/小文件代价高）**；**副本放置跨机架/可用区**；**校验和 + 后台 scrub** 发现静默损坏；**限速修复**防止修复风暴。
> - **小文件是对象存储的天敌**（元数据与 inode 开销、IOPS）：**合并成大卷（Haystack/needle 思路）**，元数据只记 `(卷, 偏移, 长度)`。
> - **大文件上传**：**分片上传 + 并发 + 断点续传 + 完成时原子合并**；**预签名 URL** 让客户端直传，绕开应用服务带宽。
> - **安全与成本**：签名/策略鉴权、服务端加密（信封加密）、防盗链、**冷热分层与生命周期**、**秒传（内容寻址去重）要防越权探测**。

> [!NOTE] 说明
> 容量数字为用于推演的**假设**。与 MinIO/Ceph/HDFS 等产品的对比仅是通用认知，选型请以官方文档与自测为准。相关基础：副本与共识见 [Raft 与共识](#/distributed/consensus)，页缓存与零拷贝见 [文件系统与零拷贝](#/cs/os-io)，加密见 [加密与密钥管理](#/security/crypto)。

## 一、需求与约束

### 1. 功能

- **对象 API**：创建桶、`PUT`（含分片上传）、`GET`（含 Range）、`HEAD`、`DELETE`、`LIST`（按前缀/分隔符）、复制、**版本控制**、**生命周期规则**；
- **访问控制**：桶/对象权限、**预签名 URL**、临时凭证、跨账号；
- **可靠与可用**：多副本/纠删码、跨可用区、可选**跨区域复制**；
- **集成**：CDN 回源、事件通知（上传完成触发处理）、图片/视频处理（缩略图、转码）。

### 2. 容量与指标（假设）

| 维度 | 假设 |
| --- | --- |
| 规模 | **100 亿对象，总量 50 PB**（逻辑）；日新增 1 亿对象、约 200 TB |
| 对象大小分布 | 70% 为 < 1MB 小文件（头像、缩略图、附件），25% 为 1MB~100MB（图片原图、文档），5% 为大文件（视频、日志包，最高数十 GB） |
| 吞吐 | 峰值读 **30 万 QPS**、写 **5 万 QPS**；聚合读带宽数百 Gbps（主要由 CDN 吸收） |
| 延迟 | 小对象 GET 首字节 P99 < 50ms（回源）；PUT 小对象 P99 < 200ms |
| 持久性/可用性 | 持久性 **11 个 9** 级目标（靠多副本/EC + 修复）；可用性 99.95%~99.99% |

**估算**：

- 物理容量：三副本 50PB × 3 = **150 PB**；RS(6,3) 纠删码 50PB × 1.5 = **75 PB**（约省一半）；
- **元数据**：100 亿对象 × 约 300 B = **约 3 TB**，必须**分片**（按 Key 哈希或范围），热点元数据缓存；
- **数据节点**：假设每节点 12 × 16TB ≈ 192TB 裸容量，按 70% 水位可用约 134TB → 三副本 150PB 需约 **1100 节点**（EC 方案约 560 节点），再加冗余与扩容缓冲。

## 二、总体架构

<figure class="fig">
<svg viewBox="0 0 840 430" class="dg" role="img" aria-label="对象存储分层架构：客户端经负载均衡进入接入层网关，网关负责鉴权签名校验限流和协议；接入层查询元数据层获得对象位置，元数据层由分片的强一致 KV 集群组成；数据面由大量数据节点组成，对象按块或卷存储，并跨机架放置副本或纠删码分片；控制与调度服务负责节点管理副本修复数据均衡垃圾回收和生命周期；CDN 位于客户端与接入层之间用于下载加速">
<rect class="b1" x="20" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="55" text-anchor="middle" dominant-baseline="middle">客户端 / CDN</text>
<rect class="b3" x="160" y="20" width="210" height="70" rx="10"/>
<text class="tb" x="265" y="42" text-anchor="middle" dominant-baseline="middle">接入层（S3 网关，无状态）</text>
<text class="ts" x="265" y="64" text-anchor="middle">签名校验 · 鉴权 · 限流 · 分片上传</text>
<line class="l" x1="130" y1="55" x2="160" y2="55" marker-end="url(#arr)"/>
<rect class="b5" x="410" y="20" width="200" height="70" rx="10"/>
<text class="tb" x="510" y="42" text-anchor="middle" dominant-baseline="middle">元数据层</text>
<text class="ts" x="510" y="64" text-anchor="middle">强一致分片 KV · 有序列举</text>
<line class="l" x1="370" y1="55" x2="410" y2="55" marker-end="url(#arr)"/>
<rect class="b4" x="650" y="20" width="170" height="70" rx="10"/>
<text class="tb" x="735" y="42" text-anchor="middle" dominant-baseline="middle">控制 / 调度</text>
<text class="ts" x="735" y="64" text-anchor="middle">修复·均衡·GC·生命周期</text>
<line class="ld" x1="610" y1="55" x2="650" y2="55"/>
<rect class="bg" x="20" y="120" width="800" height="190" rx="12"/>
<text class="th" x="36" y="144">数据层：数据节点集群（按机架 / 可用区分布）</text>
<rect class="b2" x="36" y="158" width="150" height="132" rx="8"/>
<text class="ts" x="111" y="178" text-anchor="middle">机架 A / 可用区 1</text>
<rect class="b" x="50" y="188" width="122" height="30" rx="4"/>
<text class="ts" x="111" y="203" text-anchor="middle" dominant-baseline="middle">节点 · 卷 1 副本</text>
<rect class="b" x="50" y="224" width="122" height="30" rx="4"/>
<text class="ts" x="111" y="239" text-anchor="middle" dominant-baseline="middle">节点 · EC 分片</text>
<rect class="b2" x="206" y="158" width="150" height="132" rx="8"/>
<text class="ts" x="281" y="178" text-anchor="middle">机架 B / 可用区 2</text>
<rect class="b" x="220" y="188" width="122" height="30" rx="4"/>
<text class="ts" x="281" y="203" text-anchor="middle" dominant-baseline="middle">节点 · 卷 1 副本</text>
<rect class="b" x="220" y="224" width="122" height="30" rx="4"/>
<text class="ts" x="281" y="239" text-anchor="middle" dominant-baseline="middle">节点 · EC 分片</text>
<rect class="b2" x="376" y="158" width="150" height="132" rx="8"/>
<text class="ts" x="451" y="178" text-anchor="middle">机架 C / 可用区 3</text>
<rect class="b" x="390" y="188" width="122" height="30" rx="4"/>
<text class="ts" x="451" y="203" text-anchor="middle" dominant-baseline="middle">节点 · 卷 1 副本</text>
<rect class="b" x="390" y="224" width="122" height="30" rx="4"/>
<text class="ts" x="451" y="239" text-anchor="middle" dominant-baseline="middle">节点 · EC 分片</text>
<rect class="bg" x="556" y="158" width="250" height="132" rx="8"/>
<text class="ts" x="572" y="182" text-anchor="start">• 数据以“卷/块”为单位组织</text>
<text class="ts" x="572" y="204" text-anchor="start">• 同一份数据的副本/分片</text>
<text class="ts" x="572" y="224" text-anchor="start">  落在不同机架或可用区</text>
<text class="ts" x="572" y="246" text-anchor="start">• 节点上报心跳与磁盘状态</text>
<text class="ts" x="572" y="268" text-anchor="start">• 后台 scrub 校验 + 修复</text>
<line class="l" x1="265" y1="90" x2="265" y2="120" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="330" width="800" height="84" rx="10"/>
<text class="ts" x="36" y="354">• 写入：接入层把数据流式写入多个数据节点，全部（或多数）确认后，再向元数据层原子提交对象记录，之后对象才可见</text>
<text class="ts" x="36" y="374">• 读取：元数据层查位置 → 就近/最优副本读取（EC 需并行读多个分片重建）→ 流式返回；热点由 CDN/缓存吸收</text>
<text class="ts" x="36" y="394">• 接入层与元数据层的节点可扩缩；数据层按容量与 IO 水平扩展，新节点加入后后台均衡数据</text>
</svg>
<figcaption>图 1：对象存储的分层架构</figcaption>
</figure>

## 三、数据布局：大文件分块与小文件合并

### 1. 大对象：分块（Chunk）

- 大对象切成固定大小块（如 **4MB~64MB**），每块独立存放与复制/EC；
- 好处：**并行读写**、**局部修复**（只重建坏块）、**负载均衡**（块分散到多节点）、支持 **Range 读取**（只读涉及的块）；
- 元数据记录对象的**块列表**（块 ID、所在卷/节点）。

### 2. 小对象：合并成大卷（Haystack / needle）

百亿小文件如果每个对象一个文件，会遇到：**文件系统 inode/目录项开销巨大、元数据读取需要多次磁盘 IO、小文件随机 IO 低效**。

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="小文件合并：多个小对象依次追加写入一个大卷文件，每个对象前有头信息包含对象标识大小校验和，元数据只记录对象所在的卷编号偏移量和长度；读取时先查元数据得到卷与偏移，一次磁盘读取即可取回；删除只在索引中标记，等卷压缩时回收空间；卷写满后封存为只读并可做纠删码">
<rect class="b3" x="20" y="30" width="760" height="60" rx="8"/>
<text class="th" x="36" y="54">大卷文件 volume_0042（约 10~100 GB，追加写，写满封存）</text>
<rect class="b2" x="36" y="62" width="90" height="22" rx="3"/>
<text class="ts" x="81" y="73" text-anchor="middle" dominant-baseline="middle">needle A</text>
<rect class="b2" x="130" y="62" width="130" height="22" rx="3"/>
<text class="ts" x="195" y="73" text-anchor="middle" dominant-baseline="middle">needle B</text>
<rect class="b5" x="264" y="62" width="70" height="22" rx="3"/>
<text class="ts" x="299" y="73" text-anchor="middle" dominant-baseline="middle">C(已删)</text>
<rect class="b2" x="338" y="62" width="110" height="22" rx="3"/>
<text class="ts" x="393" y="73" text-anchor="middle" dominant-baseline="middle">needle D</text>
<text class="ts" x="460" y="73" text-anchor="start">… 追加 …</text>
<rect class="b1" x="20" y="110" width="360" height="100" rx="10"/>
<text class="th" x="36" y="134">元数据只存“位置”</text>
<text class="ts" x="36" y="158">key=/img/a.jpg → (volume 42, offset 0, len 90K)</text>
<text class="ts" x="36" y="178">key=/img/b.jpg → (volume 42, offset 90K, len 130K)</text>
<text class="ts" x="36" y="198">读：一次元数据查询 + 一次顺序/定位读</text>
<rect class="b4" x="400" y="110" width="380" height="100" rx="10"/>
<text class="th" x="416" y="134">needle 结构（含校验）</text>
<text class="ts" x="416" y="158">魔数 | 对象 ID | 大小 | 标志(已删) | 数据 | CRC</text>
<text class="ts" x="416" y="178">内存/本地索引：对象 ID → 偏移（每对象仅十几字节）</text>
<text class="ts" x="416" y="198">节点重启靠索引文件或扫描卷快速恢复</text>
<rect class="bg" x="20" y="226" width="760" height="44" rx="10"/>
<text class="ts" x="36" y="246">删除只标记，空间在“卷压缩（compaction）”时回收；封存的只读卷可转纠删码降低成本</text>
<text class="ts" x="36" y="262">思想来源：Facebook Haystack 等；开源中 SeaweedFS 等采用类似卷模型（具体实现以官方为准）</text>
</svg>
<figcaption>图 2：小文件合并为大卷，元数据只记位置</figcaption>
</figure>

| 对比 | 一对象一文件 | 合并到大卷 |
| --- | --- | --- |
| 元数据开销 | 文件系统 inode + 目录项，百亿级不可行 | 每对象十几字节索引，可放内存 |
| 读 IO | 多次元数据读 + 数据读 | **1 次定位 + 1 次读** |
| 写 | 创建文件开销大 | **顺序追加**，吞吐高（见 [文件系统：顺序写](#/cs/os-io)） |
| 删除 | 立即释放 | 标记 + 后台压缩回收 |
| 复杂度 | 简单 | 需实现卷管理、压缩、恢复 |

## 四、可靠性：副本与纠删码

### 1. 对比

| | **多副本（3 副本）** | **纠删码 EC（如 RS(6,3)）** |
| --- | --- | --- |
| 原理 | 同一数据存 3 份在不同机架 | 数据分成 6 个数据块，计算 3 个校验块，共 9 块分散存放；**任意 6 块可还原** |
| 空间开销 | **3x** | **1.5x**（可容忍任意 3 块丢失） |
| 读 | 读任一副本，快 | 正常读数据块（并行）；块缺失需**重建读**（读更多块 + 计算） |
| 写 | 写 3 份 | 编码后写 9 块，CPU 与延迟更高；**小对象不适合**（块太小开销大） |
| 修复 | 拷贝一份副本即可 | **修复需读 6 块重建 1 块（读放大）**，网络与 IO 代价大 |
| 适合 | **热数据、小文件、低延迟** | **温/冷数据、大文件**，追求成本 |

**常见做法（分层）**：新写入的数据先**三副本**（快、简单）→ 数据变“冷”或卷写满封存后**异步转纠删码**（省一半空间）；小文件在卷层面做 EC（卷是大对象）。

### 2. 副本放置与故障域

- **跨故障域放置**：同一份数据的不同副本/分片**分散到不同机架、不同可用区**，避免一个机架/可用区故障导致数据不可用；
- **容量均衡**：新写入优先落到空闲度高的节点，避免热点节点；
- **写确认策略**：**全部副本落盘后 ACK**（最强，延迟取决于最慢副本）或**多数副本落盘即 ACK**（更低延迟，少数副本由后台补齐）；需要与元数据提交配合保证“已确认的写不丢”（见 [Raft 与共识](#/distributed/consensus)、[MongoDB 写关注](#/db/mongo-cluster)）。

### 3. 数据完整性

| 风险 | 对策 |
| --- | --- |
| **静默数据损坏（bit rot）** | 每个块/对象带**校验和（CRC32C/xxHash/SHA-256）**，读取时校验；**后台 scrub** 周期性扫描校验所有数据，发现损坏从其他副本/EC 重建 |
| **磁盘/节点故障** | 心跳检测 → 标记故障 → **调度器在其他节点重建缺失副本**；**限速**修复，避免修复风暴影响线上 IO |
| **多故障叠加** | 故障域分散、快速修复缩短“脆弱窗口”（副本数不足的时间）；监控“数据降级”对象数 |
| **误删/逻辑错误** | **版本控制**、回收站（延迟删除）、对象锁（WORM，合规）、跨区域复制作为额外保护 |
| **上传时数据被篡改** | 客户端提供 `Content-MD5`/校验和，服务端校验；端到端校验 |

## 五、元数据层

### 1. 要解决的问题

- **规模**：百亿对象的 Key 元数据，要**水平分片**；
- **一致性**：对象“创建/删除/覆盖”的可见性需要**强一致**（至少“写后读”一致），否则出现上传成功却读不到；
- **有序列举**：`LIST prefix=/user/123/&delimiter=/` 需要**按 Key 有序**扫描；
- **高吞吐**：元数据读写 QPS 远高于数据节点单次处理，需要缓存与批量。

### 2. 命名空间与分片

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| **扁平命名空间（S3 模型）** | Key 是完整字符串（`a/b/c.jpg` 中的 `/` 只是字符），无目录对象 | 简单，易分片；**“重命名目录”要逐个复制对象**，LIST 靠前缀扫描 |
| **层级目录（POSIX/HDFS 模型）** | 真实的目录树，支持原子重命名 | 目录元数据热点（根目录/大目录）、扩展难；HDFS NameNode 内存曾是瓶颈 |
| **分片方式：哈希分片** | `hash(桶+Key)` 路由到分片 | 负载均匀；**LIST 需要扇出到所有分片再归并** |
| **分片方式：范围分片** | 按 Key 字典序范围切分（如 TiKV/HBase 的 Region） | **前缀 LIST 高效**；单调递增 Key（如时间戳前缀）会**写热点**，需要对 Key 加散列前缀（提示用户）或自动拆分 Region（见 [TiDB：热点](#/db/tidb-practice)） |
| **存储引擎** | 强一致分布式 KV（基于 Raft：TiKV/etcd 类）、分库分表 MySQL、自研 LSM | 选型取决于规模与一致性（见 [TiDB 架构](#/db/tidb-arch)、[分库分表](#/mysql/sharding)） |

### 3. 对象元数据内容（精简）

```text
bucket, key, version_id, size, etag(MD5/校验和), content_type, created_at, storage_class(热/温/冷/归档),
layout: [ {chunk_id, volume_id, offset, len, replicas:[nodeA,nodeB,nodeC] | ec:{k:6,m:3,shards:[…]}} ],
user_meta: {…}, acl/policy_ref, sse: {algo, wrapped_key_id}, delete_marker, lifecycle_state
```

**元数据缓存**：接入层本地缓存热点对象元数据（短 TTL）；对象**不可变**（覆盖写产生新版本）使缓存失效简单。

## 六、写入：可见性与原子提交

<figure class="fig">
<svg viewBox="0 0 820 340" class="dg" role="img" aria-label="PUT 对象流程：客户端发送 PUT 到接入层，接入层校验签名与权限；向元数据层申请分配存储位置；将数据流式写入选定的数据节点并校验；所有必要副本确认后，向元数据层原子提交对象记录；提交成功后对象才可见并返回 200 和 ETag；若中途失败，已写入的数据成为孤儿，由垃圾回收清理，对象不可见">
<rect class="b1" x="20" y="20" width="100" height="32" rx="6"/>
<text class="tb" x="70" y="36" text-anchor="middle" dominant-baseline="middle">客户端</text>
<rect class="b3" x="180" y="20" width="110" height="32" rx="6"/>
<text class="tb" x="235" y="36" text-anchor="middle" dominant-baseline="middle">接入层</text>
<rect class="b5" x="350" y="20" width="110" height="32" rx="6"/>
<text class="tb" x="405" y="36" text-anchor="middle" dominant-baseline="middle">元数据层</text>
<rect class="b2" x="520" y="20" width="120" height="32" rx="6"/>
<text class="tb" x="580" y="36" text-anchor="middle" dominant-baseline="middle">数据节点 ×N</text>
<line class="ld" x1="70" y1="52" x2="70" y2="326"/>
<line class="ld" x1="235" y1="52" x2="235" y2="326"/>
<line class="ld" x1="405" y1="52" x2="405" y2="326"/>
<line class="ld" x1="580" y1="52" x2="580" y2="326"/>
<line class="l" x1="70" y1="80" x2="235" y2="80" marker-end="url(#arr)"/>
<text class="ts" x="152" y="72" text-anchor="middle">① PUT + 签名</text>
<text class="ts" x="245" y="104" text-anchor="start">② 校验签名/权限/配额</text>
<line class="l" x1="235" y1="128" x2="405" y2="128" marker-end="url(#arr)"/>
<text class="ts" x="320" y="120" text-anchor="middle">③ 申请写入位置</text>
<line class="la" x1="405" y1="152" x2="235" y2="152" marker-end="url(#arr-a)"/>
<text class="ta" x="320" y="170" text-anchor="middle">返回目标节点/卷</text>
<line class="l" x1="235" y1="198" x2="580" y2="198" marker-end="url(#arr)"/>
<text class="ts" x="408" y="190" text-anchor="middle">④ 流式写入各副本 / EC 分片（边收边写）</text>
<line class="la" x1="580" y1="222" x2="235" y2="222" marker-end="url(#arr-a)"/>
<text class="ta" x="408" y="240" text-anchor="middle">⑤ 副本确认 + 校验和</text>
<line class="l" x1="235" y1="266" x2="405" y2="266" marker-end="url(#arr)"/>
<text class="ts" x="320" y="258" text-anchor="middle">⑥ 原子提交元数据（提交点）</text>
<line class="la" x1="235" y1="298" x2="70" y2="298" marker-end="url(#arr-a)"/>
<text class="ta" x="152" y="290" text-anchor="middle">⑦ 200 OK + ETag</text>
<text class="ts" x="415" y="318" text-anchor="start">中途失败：未提交元数据则对象不可见，已写数据由 GC 回收</text>
</svg>
<figcaption>图 3：PUT 的流程与提交点</figcaption>
</figure>

要点：

- **提交点是元数据的原子写**：此前对象不存在，此后立即可读（**强一致的写后读**；S3 也已提供强一致读）；
- **流式写入**：接入层不缓冲整个对象，边接收边写数据节点，内存占用小；
- **覆盖与并发写**：同一 Key 并发 PUT，以**元数据提交顺序**（版本号/时间戳）决定最终胜者（last-writer-wins），或开启版本控制保留所有版本；
- **幂等**：客户端重试同一 PUT 安全（对象不可变，最多多一次孤儿数据）；
- **孤儿数据**：数据已写但元数据未提交（接入层崩溃、客户端中断）——靠**GC**按“创建时间超过阈值且无元数据引用”清理。

## 七、大文件上传：分片上传与断点续传

### 1. 流程

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="分片上传：客户端先 Initiate 获得 uploadId；把文件切成多个分片并发上传，每个分片返回 ETag，失败的分片可单独重传；全部上传后调用 Complete 提交分片列表，服务端校验并在元数据中原子合并为一个对象；未完成的上传由生命周期规则定期清理；断点续传通过 ListParts 查询已上传分片">
<rect class="b1" x="20" y="30" width="170" height="64" rx="8"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">① Initiate</text>
<text class="ts" x="105" y="74" text-anchor="middle">返回 uploadId</text>
<rect class="b3" x="210" y="30" width="230" height="64" rx="8"/>
<text class="tb" x="325" y="52" text-anchor="middle" dominant-baseline="middle">② 并发 UploadPart</text>
<text class="ts" x="325" y="74" text-anchor="middle">分片 1..N（各自 ETag，可重传）</text>
<rect class="b5" x="460" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="535" y="52" text-anchor="middle" dominant-baseline="middle">③ Complete</text>
<text class="ts" x="535" y="74" text-anchor="middle">提交分片清单</text>
<rect class="b2" x="630" y="30" width="150" height="64" rx="8"/>
<text class="tb" x="705" y="52" text-anchor="middle" dominant-baseline="middle">④ 合并可见</text>
<text class="ts" x="705" y="74" text-anchor="middle">元数据原子提交</text>
<line class="l" x1="190" y1="62" x2="210" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="62" x2="460" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="62" x2="630" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="760" height="164" rx="10"/>
<text class="th" x="36" y="144">要点</text>
<text class="ts" x="36" y="168">• 分片大小典型 5MB~5GB（单对象分片数有上限，如 1 万）；客户端并发上传多个分片，吞吐接近带宽上限</text>
<text class="ts" x="36" y="188">• 断点续传：中断后用 ListParts 查询已上传分片，只补传缺失分片；客户端本地记录 uploadId 与进度</text>
<text class="ts" x="36" y="208">• 合并不拷贝数据：Complete 只是在元数据里把分片块列表拼成对象的块列表（零拷贝合并）</text>
<text class="ts" x="36" y="228">• 完整性：每个分片带校验和，Complete 时校验分片 ETag；对象 ETag 常为各分片摘要的组合，不等于整体 MD5</text>
<text class="ts" x="36" y="248">• 垃圾：未 Complete/Abort 的上传会占用空间，必须配置生命周期规则（如 7 天后自动清理未完成上传）</text>
<text class="ts" x="36" y="268">• 前端上传：浏览器切片 + 并发 + 重试；超大文件可用 Web Worker 计算哈希（避免卡 UI）</text>
</svg>
<figcaption>图 4：分片上传与断点续传</figcaption>
</figure>

### 2. 预签名 URL：客户端直传直下

让**文件流量不经过业务服务器**（节省带宽与连接）：

```text
业务服务（已鉴权）→ 对象存储 SDK 生成预签名 URL（含：HTTP 方法、桶、Key、过期时间、必要头）
客户端 → 直接 PUT/GET 该 URL → 对象存储校验签名与过期 → 读写对象
```

```java
// 示例：生成 15 分钟有效的上传 URL（AWS SDK v2 风格，其他厂商 SDK 类似）
PutObjectRequest put = PutObjectRequest.builder().bucket("assets").key("avatar/10086/" + uuid + ".jpg")
        .contentType("image/jpeg").build();
PresignedPutObjectRequest r = presigner.presignPutObject(b -> b.signatureDuration(Duration.ofMinutes(15)).putObjectRequest(put));
String url = r.url().toString();     // 返回给前端
```

**签名原理**：服务端用密钥对“请求要素（方法、路径、过期时间、头）”做 **HMAC** 签名，存储服务用相同密钥重新计算比对（见 [加密与签名：HMAC](#/security/crypto)）。

**安全要点**：

- **Key 由服务端生成**（带用户/随机前缀），不要让客户端指定任意 Key（防覆盖他人文件、路径穿越）；
- **限制条件**：过期时间短、限制 `Content-Type`/`Content-Length`（上传策略 Policy）、限制大小；
- **上传完成回调**：对象存储触发事件通知（或客户端回调业务服务）→ 业务服务**校验对象存在**后再更新数据库（不信任客户端“我传好了”的声明）；
- **敏感文件**用**私有桶 + 短期签名下载 URL**，不要公开；
- 防盗链：Referer 白名单、Token 鉴权（CDN 层）。

## 八、下载与 CDN

| 要点 | 做法 |
| --- | --- |
| **Range 请求** | 支持 `Range: bytes=…`，用于断点下载、视频拖动；只读涉及的块 |
| **CDN 回源** | 热点对象由 CDN 缓存，**源站只承受回源**；对象不可变 + 带版本/哈希的 Key，天然适合长期缓存（见 [DNS 与 CDN](#/cs/net-dns)） |
| **带宽与限速** | 按桶/用户/对象限速，防止单对象或单用户占满带宽；大文件下载走专用域名/通道 |
| **热点对象** | 突发热点（爆款图片/视频）：CDN 吸收；接入层本地缓存小热点；副本数临时增加（热点副本） |
| **流式返回** | 边读边发，不缓冲整个对象；零拷贝（`sendfile`，见 [零拷贝](#/cs/os-io)） |
| **鉴权下载** | 私有对象用预签名 URL 或 CDN 鉴权；日志审计 |
| **图片/视频处理** | 在线处理（缩略图、裁剪、水印、转码）：URL 参数触发处理服务，**结果缓存到 CDN**；避免原图直出带来的带宽浪费 |

## 九、秒传与去重

**秒传**：上传前先计算文件内容哈希（如 SHA-256），向服务端查询“是否已存在相同内容”，存在则**只创建元数据引用，不上传数据**（网盘常见）。

- **内容寻址存储（CAS）**：数据块以内容哈希为 Key，天然去重；元数据通过**引用计数**指向同一份数据，删除时引用计数为 0 才真正回收；
- **安全风险（重要）**：
  - **越权探测**：攻击者只要知道某文件的哈希，就能“秒传”并获得该文件（等于读取他人文件）。**对策**：秒传要求**证明持有文件内容**（服务端随机抽取若干字节区间让客户端回传这些区间的哈希/内容，proof of possession），或仅在**同一用户/同一租户范围内**去重；
  - **存在性泄露**：通过秒传是否成功推断某文件是否被他人上传（隐私）；
  - **哈希碰撞**：使用强哈希（SHA-256），并在可疑时二次校验；
- 加密场景（每用户密钥）会让跨用户去重失效，需要在隐私与成本之间取舍。

## 十、删除、版本与垃圾回收

### 1. 删除模型

| 机制 | 说明 |
| --- | --- |
| **同步元数据删除（逻辑删除）** | 立即让对象不可见（元数据标记/删除），返回成功；**物理数据异步回收** |
| **版本控制** | 开启后 `DELETE` 只是添加**删除标记**，历史版本仍可恢复；可按生命周期清理旧版本 |
| **回收站 / 延迟删除** | 保留 N 天后才物理删除，防误删 |
| **对象锁（WORM）** | 合规要求，在保留期内不可删除/覆盖 |

### 2. 垃圾回收（GC）

需要回收的垃圾：**已删除对象的数据**、**被覆盖版本**、**未完成的分片上传**、**写入失败遗留的孤儿数据块**、**卷内被标记删除的 needle**。

| 方式 | 做法 |
| --- | --- |
| **引用计数** | 数据块被对象引用的计数，归零回收（CAS 去重场景）；注意计数更新的并发与幂等 |
| **标记-清除（Mark-Sweep）** | 周期性扫描**元数据中所有被引用的块**作为“存活集合”，节点上不在存活集合且**存在时间超过安全阈值**的块才可回收（安全阈值防止回收“数据已写、元数据尚未提交”的新块） |
| **卷压缩（Compaction）** | 卷内有效数据占比低于阈值时，把存活 needle 拷贝到新卷，回收旧卷（限速、低峰进行） |

> [!WARNING] GC 是数据丢失风险最高的后台作业
> 误回收 = 永久丢数据。必须：**两阶段（先标记待删、延迟一段时间再物理删除）**、**足够的安全时间窗口**、**对账与可恢复期**、灰度发布 GC 逻辑与大量测试。

### 3. 生命周期与存储分层

- **规则**：`30 天后转低频存储`、`90 天后转归档`、`365 天后删除`、`7 天清理未完成上传`、`旧版本保留 N 个`；
- **存储类型**：热（SSD/副本）→ 温（HDD + EC）→ 冷（高密度 HDD/磁带/蓝光）→ 归档（取回需分钟~小时）；**取回费用与延迟**要提前说明；
- 与成本直接相关：冷数据占比越高，单位成本越低（见成本一节）。

## 十一、跨区域复制与容灾

| 项 | 做法 |
| --- | --- |
| **跨区域复制（CRR）** | 对象写入后**异步复制**到另一区域的桶（源端事件/日志驱动），**最终一致**；用于容灾与就近读 |
| **同城多可用区** | 副本/EC 分片本身分散到多可用区，单可用区故障不丢数据、读写继续 |
| **元数据高可用** | Raft 多副本（3/5 副本）、跨可用区；元数据备份与演练恢复 |
| **复制一致性与冲突** | 双向复制要处理冲突（同 Key 两地同时写）→ 以时间戳/版本号决胜或避免双写 |
| **RPO/RTO** | 异步复制有秒~分钟级 RPO；故障切换演练（见 [稳定性工程](#/design/eng-chaos)） |

## 十二、安全与成本

### 1. 安全

| 项 | 做法 |
| --- | --- |
| **认证与签名** | AK/SK 签名（HMAC）、临时凭证（STS）、预签名 URL；最小权限（Policy 按桶/前缀/操作，见 [认证授权](#/security/auth)） |
| **传输加密** | 全程 TLS |
| **静态加密（SSE）** | **信封加密**：每个对象一个数据密钥（DEK）加密数据，DEK 由 KMS 主密钥加密后存元数据（见 [加密与密钥管理：信封加密](#/security/crypto)）；客户端加密可选 |
| **访问控制与审计** | 桶策略、ACL、阻止公开访问、访问日志、操作审计 |
| **防盗链与防刷** | Referer/签名/Token；限流与流量告警（防“盗刷流量”产生巨额账单） |
| **内容安全** | 图片/视频审核、病毒扫描（上传后异步），违规下线（见 [短链接案例：安全](#/design/case-shorturl)） |
| **数据合规** | 数据所在地、保留期、删除权（加密擦除：删除密钥即不可恢复） |

### 2. 成本优化

| 手段 | 说明 |
| --- | --- |
| **纠删码 + 冷热分层** | 温冷数据 EC（1.2~1.5x），生命周期自动降级 |
| **小文件合并/压缩** | 减少元数据与 IOPS；文本类对象压缩存储 |
| **去重** | 内容寻址去重（注意安全与隐私） |
| **请求成本** | 小对象大量请求的成本高于容量成本：合并小对象、批量操作 |
| **带宽成本** | CDN 缓存命中、图片按需处理与格式转换（WebP/AVIF）、避免回源 |
| **容量治理** | 清理孤儿/过期/重复数据；配额与告警 |
| **硬件** | 高密度存储节点、纠删码计算卸载；SSD 做元数据与缓存，HDD 存数据 |

## 十三、业务系统怎么用对象存储

| 实践 | 说明 |
| --- | --- |
| **数据库存 Key，不存二进制** | 表里存 `object_key`、大小、类型、校验和、归属；文件内容在对象存储 |
| **Key 设计** | `业务/用户或租户/年月/随机ID.扩展名`；**不要用原始文件名做 Key**（冲突、特殊字符、注入）；**避免单调递增前缀**造成分片热点（加哈希前缀）；**不可变 Key**（改内容换新 Key，便于 CDN 缓存） |
| **上传链路** | 前端 → 业务服务申请预签名/Policy → 直传对象存储 → 回调/事件通知 → 业务服务校验并落库 |
| **下载链路** | 公开资源走 CDN 域名；私有资源走短期签名 URL |
| **一致性** | 先传文件后落库：失败留下孤儿文件→定期**对账清理**（库里没有引用且超过时长的对象）；先落库后传文件：库里有指向不存在的对象→前端要容错 |
| **删除** | 业务删除=标记软删 + 异步删除对象 + 生命周期兜底；注意被多处引用的对象（引用计数） |
| **大文件/视频** | 分片上传 + 转码服务 + HLS 切片 + CDN |
| **本地开发/测试** | MinIO 等兼容 S3 的本地实现（Testcontainers，见 [CI/CD](#/infra/cicd)） |

## 十四、选型：自建 vs 云

| | **云对象存储（OSS/S3/COS 等）** | **MinIO** | **Ceph（RGW）** | **HDFS** | **FastDFS/SeaweedFS** |
| --- | --- | --- | --- | --- | --- |
| 定位 | 托管，近乎无限，生态完善 | 轻量、S3 兼容、易部署 | 统一存储（对象/块/文件），功能强但运维重 | 大数据批处理的分布式文件系统 | 小文件场景的轻量方案 |
| 运维成本 | **最低** | 低~中 | **高** | 中（NameNode 高可用） | 低~中 |
| 规模 | 超大 | 中大 | 大 | 大（适合大文件顺序读写） | 中 |
| 小文件 | 有最小计费粒度等限制 | 一般 | 一般 | **差**（NameNode 内存压力） | 针对小文件优化 |
| 适合 | **绝大多数业务**（首选） | 私有化、本地/测试、中小规模 | 需要块+对象+文件统一、有专职团队 | Hadoop/Spark 数据湖 | 历史系统、特定小文件场景 |

**建议**：**优先使用云对象存储**（持久性、可用性、成本与生态难以自建匹敌）；有**私有化/合规/成本**需求再考虑 MinIO/Ceph；大数据分析用 HDFS 或直接用对象存储作数据湖（见 [Spark 与数据湖](#/bigdata/spark-lake)）。**自建对象存储是大工程**，需要专职团队与 7×24 运维。

> [!WARNING] 选型提醒
> 上表为通用认知，各产品功能与版本差异较大，请以官方文档与实际压测为准。

## 十五、监控与常见坑

| 监控 | 指标 |
| --- | --- |
| 可用性与性能 | 各 API 的 QPS/错误率/P99、首字节延迟、上传带宽 |
| 容量 | 总量/水位、各节点与磁盘使用率、对象数、增长趋势 |
| 可靠性 | **降级对象数（副本/分片不足）**、修复积压与速率、scrub 发现的损坏数、磁盘故障率 |
| 元数据 | 元数据层延迟、分片热点、LIST 耗时 |
| GC | 待回收量、回收速率、孤儿比例 |
| 成本与安全 | 出口流量、请求量异常（盗刷）、公开桶审计 |

| 坑 | 对策 |
| --- | --- |
| 把二进制文件存进 MySQL | 用对象存储，库存 Key |
| 小文件直接一对象一文件 | 合并大卷；或使用对象存储服务 |
| 元数据成为瓶颈/热点（单调 Key、大目录） | 范围分片 + 自动拆分；Key 加散列前缀；缓存 |
| 先写元数据后写数据，读到不存在的数据 | 先写数据后提交元数据 |
| GC 误删导致丢数据 | 两阶段删除、安全窗口、对账 |
| 修复风暴拖垮线上 | 修复限速、优先级、错峰 |
| EC 用于小对象、热数据 | 小对象副本；EC 用于冷大文件；封存卷后转 EC |
| 分片上传残留占空间 | 生命周期清理未完成上传 |
| 预签名 URL 过期太长/权限过大 | 短过期、限制 Key/大小/类型；服务端生成 Key |
| 公开读桶泄露数据 | 默认私有；阻止公开访问；审计 |
| 秒传被利用读他人文件 | proof of possession、租户内去重 |
| 先传文件后落库失败产生孤儿 | 对账清理、事件驱动校验 |
| 上传后立即读取读不到（最终一致元数据） | 元数据强一致；或在文档中明确语义 |
| 盗刷流量产生巨额账单 | 防盗链、鉴权、限速与告警、CDN |

## 相关阅读

- [案例：直播系统设计详解](#/design/case-live)：录制切片与回放存储

## 面试追问

> [!QUESTION] 对象存储为什么把元数据和数据分开？怎么保证对象“写入成功”的语义？
> 元数据层需要强一致、可有序列举且高 QPS，数据层只负责字节存放和持久性，分开后可独立扩展。写入时先把数据流式写入多个数据节点并校验，所有必要副本确认后再向元数据层原子提交对象记录，提交点之后对象才可见，中途失败则对象不可见，遗留数据由垃圾回收清理。

> [!QUESTION] 三副本和纠删码怎么选？
> 三副本读写快、修复简单但空间成本是三倍，适合热数据和小文件；纠删码如 RS(6,3) 空间只需 1.5 倍且容忍任意三块丢失，但写入编码有 CPU 开销，块缺失读和修复需要读多个分片造成读放大，适合温冷数据和大文件。常见做法是新数据先三副本，变冷或卷封存后异步转纠删码，并把副本分散在不同机架和可用区。

> [!QUESTION] 海量小文件怎么存？
> 一个对象一个文件会带来巨大的 inode 和元数据开销与随机 IO。做法是把多个小对象追加合并到大卷文件中，元数据只记录卷号、偏移和长度，读取一次定位即可，删除只做标记，等卷压缩时回收空间，封存的卷再转纠删码，思想来自 Haystack。

> [!QUESTION] 大文件上传怎么设计？如何断点续传？
> 分片上传：先 Initiate 获得 uploadId，客户端并发上传各分片并拿到各自校验值，失败的分片单独重传，最后 Complete 提交分片清单，服务端校验后在元数据里原子拼接成对象，无需拷贝数据。中断后用 ListParts 查询已上传分片只补传缺失的，并用生命周期规则清理未完成的上传。

> [!QUESTION] 预签名 URL 的原理和安全注意点？
> 业务服务鉴权后用密钥对方法、路径、过期时间等要素做 HMAC 签名生成 URL，客户端直传直下，文件流量不经业务服务器。要由服务端生成 Key、设置较短有效期并限制类型和大小，上传完成后通过事件通知或回调让服务端校验对象存在再落库，敏感文件用私有桶加短期签名。

> [!QUESTION] 秒传是怎么实现的？有什么安全风险？
> 上传前计算内容哈希查询是否已有相同内容，有则只创建指向同一份数据的元数据引用并用引用计数管理回收，本质是内容寻址去重。风险是知道哈希就能秒传读取他人文件和推断文件是否存在，需要要求客户端证明持有内容，比如随机抽取区间回传摘要，或限定在同一用户或租户范围内去重，并使用强哈希。

> [!QUESTION] 对象存储如何处理静默数据损坏和节点故障？
> 每个块带校验和，读取时校验并后台定期 scrub，发现损坏从其他副本或纠删码重建；节点或磁盘故障由心跳检测，调度器在其他节点重建缺失副本并限速避免修复风暴；副本跨机架和可用区放置，并监控降级对象数以缩短脆弱窗口。

> [!QUESTION] 业务系统使用对象存储有哪些最佳实践？
> 数据库只存对象 Key 和元信息，Key 由服务端生成并带散列前缀避免热点，内容不可变便于 CDN 缓存；上传用预签名直传加事件校验落库，下载公开资源走 CDN、私有资源用短期签名；定期对账清理孤儿对象，配置生命周期清理未完成上传和旧版本，默认私有并审计公开桶。
