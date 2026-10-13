---
level: 深入
tags: [案例, 在线协作, OT, 操作转换, CRDT, 实时协同, WebSocket, 光标同步, 离线编辑, 版本历史, 权限, 协同文档]
summary: 在线协作文档（多人实时编辑）设计详解：协同的难点与一致性目标、OT（操作转换）的原理与中心服务器架构、CRDT（序列 CRDT、Yjs/Automerge）的原理与取舍、实时通道与房间路由、协同服务的状态与分片、离线编辑与重连同步、光标与在线状态（Awareness）、版本历史与快照/操作日志压缩、权限与评论/建议模式、富文本与表格的模型、容量与可靠性。
---

# 案例：在线协作文档（OT 与 CRDT）设计详解

> [!ABSTRACT] 核心要点
> - 协同编辑的核心难题：**多个用户同时修改同一份文档，网络有延迟，操作到达顺序不同，如何让所有人最终看到完全一致的结果，且不丢失任何人的意图**。需要同时满足**收敛性（Convergence）**、**意图保持（Intention Preservation）**、**因果保序（Causality）**。
> - 两大技术路线：**OT（Operational Transformation，操作转换）**——把并发操作**相互转换**后再应用（Google Docs 的方案），需要**中心服务器排序**，算法与证明复杂；**CRDT（无冲突复制数据类型）**——为每个字符/元素分配**全局唯一且可排序的标识**，操作**天然可交换**，**无需中心排序**，天然支持**离线与 P2P**，代价是**元数据膨胀**（墓碑）和实现复杂的**垃圾回收**。主流开源实现：**Yjs、Automerge**（CRDT），**ShareDB（OT）**。
> - **工程上更重要的是系统架构**：**实时通道（WebSocket）**、**文档房间到服务器的路由与单文档串行化**、**操作日志 + 定期快照**、**重连与断点续传**、**离线缓冲与合并**、**光标/选区/在线状态（Awareness，不进文档历史）**、**权限与审计**、**版本历史与回放**、**大文档与冷热分层**。
> - **关键设计取舍**：**“服务器是权威”（OT 与带中心的 CRDT）vs “客户端对等”（纯 CRDT）**；**操作粒度**（字符级 vs 块级）；**一致性 vs 延迟**（本地先应用、乐观更新）；**文档大小与历史增长**（日志压缩）。
> - **本地优先（Local-first）**：客户端**立即应用本地操作**（零延迟手感），再异步同步；与服务器的冲突由算法自动解决，**用户无感知**。

## 1. 背景与目标

### 场景与功能

| 功能 | 说明 |
| --- | --- |
| **多人实时编辑** | 同一文档数十人同时编辑，秒内（理想 <200ms）互相可见 |
| **富文本/表格/幻灯片** | 文本（段落、样式、列表、嵌入）、表格（行列/单元格）、画板等多种数据结构 |
| **光标与选区** | 显示他人光标位置、选区、昵称颜色 |
| **评论与建议（修订）模式** | 评论锚定到文本范围；建议模式保留“插入/删除”标记待审阅 |
| **版本历史** | 查看、对比、回滚到历史版本；命名版本 |
| **离线编辑** | 断网继续编辑，恢复后自动合并 |
| **权限与分享** | 查看/评论/编辑，链接分享，组织内权限 |
| **导入导出** | Word/PDF/Markdown |

### 非功能指标（示例）

| 指标 | 目标 |
| --- | --- |
| 本地输入延迟 | **立即响应**（不等待网络） |
| 远端可见延迟 | P95 < 200~500ms（同地域） |
| 单文档并发编辑人数 | 数十到数百（大多数文档 < 10 人） |
| 文档规模 | 数十万字符；大表格/幻灯片更大 |
| 一致性 | **最终所有副本完全一致（强最终一致性）** |
| 持久性 | 已确认的操作**不丢**；崩溃后可恢复 |
| 可用性 | 99.95%+；断网可编辑 |

## 2. 协同的挑战：为什么不能“直接覆盖”

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="并发编辑的冲突示例：文档初始内容是 ABC，用户 A 在位置 1 插入 X，用户 B 同时删除位置 2 的字符 C；如果各自直接应用对方的原始操作，会得到不一致或错误的结果；需要对操作做转换或使用唯一标识的 CRDT 来保证收敛并保持各自意图">
<rect class="b3" x="20" y="14" width="720" height="50" rx="8"/>
<text class="tb" x="380" y="32" text-anchor="middle" dominant-baseline="middle">初始文档：ABC （索引 0,1,2）</text>
<text class="ts" x="380" y="52" text-anchor="middle">用户 A 与用户 B 同时编辑，操作经网络交叉传递</text>
<rect class="b5" x="20" y="80" width="350" height="110" rx="10"/>
<text class="tb" x="195" y="100" text-anchor="middle" dominant-baseline="middle">用户 A：在位置 1 插入 X</text>
<text class="ts" x="195" y="126" text-anchor="middle">本地：A X B C → "AXBC"</text>
<text class="ts" x="195" y="148" text-anchor="middle">收到 B 的原始操作“删除位置 2”</text>
<text class="ts" x="195" y="170" text-anchor="middle">直接应用 → 删掉了 B（本应删 C）→ "AXC"</text>
<rect class="b1" x="390" y="80" width="350" height="110" rx="10"/>
<text class="tb" x="565" y="100" text-anchor="middle" dominant-baseline="middle">用户 B：删除位置 2（字符 C）</text>
<text class="ts" x="565" y="126" text-anchor="middle">本地：A B → "AB"</text>
<text class="ts" x="565" y="148" text-anchor="middle">收到 A 的原始操作“位置 1 插入 X”</text>
<text class="ts" x="565" y="170" text-anchor="middle">直接应用 → "AXB"</text>
<rect class="b4" x="20" y="206" width="350" height="116" rx="8"/>
<text class="th" x="32" y="226">结果：A = "AXC"，B = "AXB"，分叉且都不符合意图</text>
<text class="ts" x="195" y="252" text-anchor="middle">正确结果应是 "AXB"（插入 X，删除 C）</text>
<text class="ts" x="195" y="274" text-anchor="middle">问题：位置索引在并发操作后失效，</text>
<text class="ts" x="195" y="294" text-anchor="middle">“位置 2”指向的字符已经变了</text>
<rect class="b2" x="390" y="206" width="350" height="116" rx="8"/>
<text class="th" x="402" y="226">两条出路</text>
<text class="ts" x="565" y="252" text-anchor="middle">OT：把“删除位置 2”针对“位置 1 插入”转换成“删除位置 3”</text>
<text class="ts" x="565" y="274" text-anchor="middle">CRDT：每个字符有唯一 ID，操作是“删除 ID=c”，不依赖位置</text>
<text class="ts" x="565" y="296" text-anchor="middle">两者都保证所有副本收敛到 "AXB"</text>
</svg>
<figcaption>图 1：并发操作下位置索引失效，直接应用会分叉</figcaption>
</figure>

### 一致性目标（CCI 模型）

| 目标 | 含义 |
| --- | --- |
| **收敛（Convergence）** | 所有副本在应用完全部操作后**状态相同** |
| **因果保序（Causality）** | 如果操作 a 因果先于 b（b 看过 a 的效果），所有副本上 a 先于 b 应用 |
| **意图保持（Intention Preservation）** | 转换后的操作效果**符合发起者的原始意图**（如“在 B 之后插入 X”在并发变化后仍在 B 之后） |

## 3. 关键设计决策（ADR 摘要）

| 决策 | 选择 | 理由 | 代价 |
| --- | --- | --- | --- |
| **协同算法** | **OT（中心服务器）** 或 **CRDT（Yjs 等）** | OT：成熟，服务器权威易做权限/审计、数据小；CRDT：离线友好、无需中心排序、实现库成熟 | OT：算法难、需要中心；CRDT：元数据多、历史/权限控制要额外设计 |
| **架构** | **客户端本地先应用 + 服务器中转广播 + 持久化** | 零延迟手感，最终一致 | 需要处理回滚/重放与重连 |
| **传输** | **WebSocket 长连接**（回退长轮询） | 双向低延迟 | 长连接管理，见 [案例：实时消息推送系统设计详解](#/design/case-push) |
| **文档路由** | **同一文档的所有连接路由到同一协同服务实例（房间/分片）** | 单文档内操作串行化，简化一致性 | 热点文档单点，需要分片与迁移能力 |
| **持久化** | **操作日志（append）+ 定期快照** | 不丢操作、可回放、可恢复 | 日志增长需要压缩 |
| **在线状态** | **Awareness 与文档内容分离**（不持久化） | 光标高频、临时 | 需要超时清理 |
| **权限** | **服务器端校验每个操作** | 客户端不可信 | CRDT 对等传播时更难强制，需要中心授权 |

## 4. OT：操作转换

### 4.1 基本思想

**操作（Operation）** 是对文档的原子修改，如 `insert(pos, text)`、`delete(pos, len)`、`retain(n)`（保留 n 个字符，用于富文本的 delta 表示）。当两个用户**基于同一文档版本**并发产生操作 `a` 与 `b`，需要定义**转换函数** `transform(a, b) → (a', b')`，使得：

```text
doc ∘ a ∘ b'  ==  doc ∘ b ∘ a'      （TP1 性质：转换后无论先应用哪个，结果相同）
```

- `a'` 是“**考虑了 b 已发生后**的 a”，`b'` 是“考虑了 a 已发生后”的 b；
- 例（图 1）：`a = insert(1,'X')`，`b = delete(2)`。`transform(b, a)`：因为 a 在 b 的位置之前插入了一个字符，b 的位置要后移：`b' = delete(3)`。

### 4.2 中心服务器 OT 架构（Jupiter 风格）

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="中心服务器 OT 架构：每个客户端维护本地文档、已发送未确认的操作缓冲和对服务器版本的认知；客户端本地操作立即应用，同时发送给服务器；服务器按到达顺序给操作定序，对每个客户端基于旧版本的操作与之后服务器已应用的操作做转换后应用并广播；客户端收到服务器广播时，若与自己未确认的操作并发，需要与本地待确认操作转换后再应用；服务器是权威顺序的唯一来源">
<rect class="b3" x="20" y="30" width="170" height="96" rx="10"/>
<text class="tb" x="105" y="50" text-anchor="middle" dominant-baseline="middle">客户端 A</text>
<text class="ts" x="105" y="74" text-anchor="middle">本地文档（乐观更新）</text>
<text class="ts" x="105" y="94" text-anchor="middle">待确认操作队列</text>
<text class="ts" x="105" y="114" text-anchor="middle">已知服务器版本 n</text>
<rect class="b5" x="295" y="14" width="170" height="128" rx="10"/>
<text class="tb" x="380" y="34" text-anchor="middle" dominant-baseline="middle">协同服务器（权威）</text>
<text class="ts" x="380" y="58" text-anchor="middle">1) 按到达顺序定序</text>
<text class="ts" x="380" y="78" text-anchor="middle">2) 转换操作（对齐版本）</text>
<text class="ts" x="380" y="98" text-anchor="middle">3) 应用并追加日志</text>
<text class="ts" x="380" y="118" text-anchor="middle">4) 广播给其他客户端</text>
<rect class="b1" x="570" y="30" width="170" height="96" rx="10"/>
<text class="tb" x="655" y="50" text-anchor="middle" dominant-baseline="middle">客户端 B</text>
<text class="ts" x="655" y="74" text-anchor="middle">本地文档（乐观更新）</text>
<text class="ts" x="655" y="94" text-anchor="middle">待确认操作队列</text>
<text class="ts" x="655" y="114" text-anchor="middle">已知服务器版本 m</text>
<line class="l" x1="190" y1="70" x2="295" y2="70" marker-end="url(#arr)"/>
<line class="la" x1="295" y1="100" x2="190" y2="100" marker-end="url(#arr-a)"/>
<line class="l" x1="465" y1="70" x2="570" y2="70" marker-end="url(#arr)"/>
<line class="la" x1="570" y1="100" x2="465" y2="100" marker-end="url(#arr-a)"/>
<rect class="bg" x="20" y="160" width="720" height="190" rx="8"/>
<text class="th" x="32" y="180">要点</text>
<text class="ts" x="380" y="206" text-anchor="middle">客户端每次只有一个“已发送未确认”的操作在途（其余缓冲并合并），简化服务器转换：转换只在两方（客户端与服务器）之间发生</text>
<text class="ts" x="380" y="228" text-anchor="middle">发送操作带“基于的服务器版本号”；服务器把它与该版本之后已应用的所有操作依次转换，再应用，版本号 +1，广播（带新版本）</text>
<text class="ts" x="380" y="250" text-anchor="middle">发起者收到自己操作的 ACK 后，从待确认队列移除；收到他人操作时，与本地待确认操作转换后应用到本地文档</text>
<text class="ts" x="380" y="272" text-anchor="middle">所有副本经历同一个服务器顺序，因此只需保证两方转换满足 TP1（比 P2P 的 TP2 简单得多）——这就是“中心服务器 OT”的实用价值</text>
<text class="ts" x="380" y="294" text-anchor="middle">文档类型：纯文本用 insert/delete；富文本用 retain/insert/delete 的 delta；树形（表格、块结构）需要更复杂的操作与转换函数</text>
<text class="ta" x="380" y="320" text-anchor="middle">难点：为每种数据结构设计并证明转换函数的正确性；富文本/表格的组合操作转换大量边界情况</text>
<text class="ta" x="380" y="340" text-anchor="middle">可借用成熟库（如 ShareDB、Quill Delta、Slate 的 operations、ProseMirror collab 模块）而非自研</text>
</svg>
<figcaption>图 2：中心服务器 OT 的客户端、服务器与转换流程</figcaption>
</figure>

### 4.3 OT 的优缺点

| 优点 | 缺点 |
| --- | --- |
| **服务器权威**：天然便于**权限校验、审计、版本管理、内容安全** | 需要**中心服务器排序**，**离线编辑与 P2P 较困难**（长时间离线后转换链很长） |
| 操作小，文档状态不含额外元数据，**存储紧凑** | **算法设计与证明难**（TP1/TP2 的各种边界），历史上多个实现存在 bug |
| 成熟（Google Docs 等多年生产验证） | 每种新数据结构都要重新设计转换函数 |
| 意图保持较好（位置语义直观） | 服务端单点串行化，热点文档的吞吐受限 |

## 5. CRDT：无冲突复制数据类型

### 5.1 序列 CRDT 的核心思想

不用“位置”，而是**给每个字符分配全局唯一且全序可比较的标识（ID）**，插入操作表示为“**在 ID=x 的字符之后插入新字符 ID=y**”，删除表示为“**标记 ID=z 已删除（墓碑）**”。因为**引用的是不变的 ID 而非变化的位置**，操作**天然可交换**，各副本以任意顺序应用都得到相同结果（只要因果有序传输）。

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="序列 CRDT 的原理：文档是带唯一标识的字符序列，每个字符有 ID，插入操作引用左邻居的 ID；并发在同一位置插入时用 ID 的全序比较决定先后；删除标记墓碑而不物理删除；各副本收敛到相同序列；典型实现 RGA、YATA（Yjs）、Logoot、LSEQ">
<text class="th" x="20" y="22">文档：每个字符是一个带 ID 的节点（客户端号, 序号）</text>
<rect class="b3" x="20" y="34" width="110" height="46" rx="6"/>
<text class="ts" x="75" y="52" text-anchor="middle" dominant-baseline="middle">A (c1,1)</text>
<text class="ts" x="75" y="68" text-anchor="middle" dominant-baseline="middle">字符 'A'</text>
<rect class="b3" x="150" y="34" width="110" height="46" rx="6"/>
<text class="ts" x="205" y="52" text-anchor="middle" dominant-baseline="middle">B (c1,2)</text>
<text class="ts" x="205" y="68" text-anchor="middle" dominant-baseline="middle">字符 'B'</text>
<rect class="b4" x="280" y="34" width="110" height="46" rx="6"/>
<text class="ts" x="335" y="52" text-anchor="middle" dominant-baseline="middle">C (c1,3)</text>
<text class="ts" x="335" y="68" text-anchor="middle" dominant-baseline="middle">已删除（墓碑）</text>
<line class="l" x1="130" y1="57" x2="150" y2="57" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="57" x2="280" y2="57" marker-end="url(#arr)"/>
<rect class="bg" x="420" y="34" width="320" height="46" rx="6"/>
<text class="ts" x="580" y="52" text-anchor="middle">插入 = “在 ID=(c1,1) 之后插入 (c2,1)=X”</text>
<text class="ts" x="580" y="70" text-anchor="middle">删除 = “标记 ID=(c1,3) 为已删除”</text>
<rect class="b5" x="20" y="100" width="350" height="130" rx="10"/>
<text class="tb" x="195" y="120" text-anchor="middle" dominant-baseline="middle">并发插入同一位置</text>
<text class="ts" x="195" y="146" text-anchor="middle">A 和 B 都在 'A' 之后插入（X 与 Y）</text>
<text class="ts" x="195" y="168" text-anchor="middle">两条操作都引用 “左邻居 = (c1,1)”</text>
<text class="ts" x="195" y="190" text-anchor="middle">用确定性的规则（如 ID 比较 / YATA 的</text>
<text class="ts" x="195" y="210" text-anchor="middle">来源/起点规则）决定 X、Y 的先后，所有副本一致</text>
<rect class="b1" x="390" y="100" width="350" height="130" rx="10"/>
<text class="tb" x="565" y="120" text-anchor="middle" dominant-baseline="middle">删除与墓碑</text>
<text class="ts" x="565" y="146" text-anchor="middle">被删字符保留为墓碑（不再显示）</text>
<text class="ts" x="565" y="168" text-anchor="middle">因为后续操作可能仍引用它做“左邻居”</text>
<text class="ts" x="565" y="190" text-anchor="middle">墓碑与每字符的 ID 是 CRDT 的元数据开销</text>
<text class="ts" x="565" y="210" text-anchor="middle">需要垃圾回收（确认所有副本都已见到后清理）</text>
<rect class="bg" x="20" y="246" width="720" height="84" rx="8"/>
<text class="ts" x="380" y="268" text-anchor="middle">常见算法：RGA、YATA（Yjs）、Logoot/LSEQ、Fugue 等，各有交错与元数据取舍</text>
<text class="ts" x="380" y="290" text-anchor="middle">因果传递要求：操作需按因果序交付（带向量时钟/依赖信息），或缓存等待依赖到达</text>
<text class="ts" x="380" y="312" text-anchor="middle">工程上直接采用成熟库（Yjs、Automerge），它们已优化为批量编码、块合并（连续插入合并成一个“块”以降低元数据）</text>
</svg>
<figcaption>图 3：序列 CRDT：唯一 ID、引用左邻居与墓碑</figcaption>
</figure>

### 5.2 CRDT 的优缺点

| 优点 | 缺点 |
| --- | --- |
| **无需中心排序**：操作可交换，**离线编辑、P2P、跨设备合并**天然支持 | **元数据膨胀**：每字符 ID + 墓碑，文档体积可能是纯文本的数倍；需要块合并与垃圾回收 |
| **算法由库提供**，正确性经过形式化验证，开发者只需使用数据类型（Map/Array/Text/XML） | **权限与审计更难**：对等传播时服务器要对每个更新做合法性校验；撤销历史、永久删除（合规）较困难 |
| 服务器可以很简单（只做中转与持久化：存储与广播更新） | **意图保持有时不如 OT 直观**（并发插入的交错、移动语义） |
| 多种数据类型组合（文本、表格、JSON） | 历史回放需要保留足够的更新日志；GC 与历史保留有冲突 |
| 与本地优先（Local-first）理念契合 | 内存占用高（大文档加载时需要完整 CRDT 结构） |

### 5.3 Yjs 的使用示意

```java
// 概念示意（Yjs 是 JS 库，服务端有 Java/Rust 等绑定或自研中转；下面描述数据流而非具体 API）
// 客户端：本地修改 Y.Text → 产生二进制 update → 通过 WebSocket 发给服务器
// 服务器：不解析语义（或仅做校验）→ 持久化 update（append）→ 广播给同房间其他客户端
// 新客户端加入：服务器发送“文档当前状态向量对应的差量更新”（state vector diff），避免全量传输
//
// 同步协议三步（Yjs 的 y-protocols）：
//   1) SyncStep1：发送方告知“我已有哪些更新”（State Vector）
//   2) SyncStep2：对方返回“你缺少的那部分更新”
//   3) 之后增量更新实时推送
// Awareness：光标/用户信息走独立通道，不进入文档历史，超时自动清理
```

## 6. 总体架构

<figure class="fig">
<svg viewBox="0 0 760 380" class="dg" role="img" aria-label="协同文档总体架构：客户端编辑器通过 WebSocket 连接接入网关；网关根据文档 ID 一致性路由到协同服务实例；协同服务维护文档房间的内存状态，处理操作转换或 CRDT 更新，广播给房间内连接；操作日志追加写入存储并定期生成快照；Awareness 通过房间内存广播；权限服务校验；评论、版本历史、导出等周边服务；元数据在数据库；热点文档迁移与分片">
<rect class="b3" x="20" y="14" width="160" height="56" rx="8"/>
<text class="tb" x="100" y="34" text-anchor="middle" dominant-baseline="middle">编辑器客户端</text>
<text class="ts" x="100" y="54" text-anchor="middle">本地文档·离线缓冲</text>
<rect class="b5" x="210" y="14" width="150" height="56" rx="8"/>
<text class="tb" x="285" y="34" text-anchor="middle" dominant-baseline="middle">接入网关</text>
<text class="ts" x="285" y="54" text-anchor="middle">WS·鉴权·按文档路由</text>
<rect class="b1" x="390" y="14" width="200" height="56" rx="8"/>
<text class="tb" x="490" y="34" text-anchor="middle" dominant-baseline="middle">协同服务（按文档分片）</text>
<text class="ts" x="490" y="54" text-anchor="middle">房间·定序/合并·广播</text>
<rect class="b2" x="620" y="14" width="120" height="56" rx="8"/>
<text class="tb" x="680" y="34" text-anchor="middle" dominant-baseline="middle">权限服务</text>
<text class="ts" x="680" y="54" text-anchor="middle">操作级校验</text>
<line class="l" x1="180" y1="42" x2="210" y2="42" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="42" x2="390" y2="42" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="42" x2="620" y2="42" marker-end="url(#arr)"/>
<rect class="b4" x="20" y="100" width="170" height="56" rx="8"/>
<text class="tb" x="105" y="120" text-anchor="middle" dominant-baseline="middle">操作/更新日志</text>
<text class="ts" x="105" y="140" text-anchor="middle">追加写，高吞吐</text>
<rect class="b3" x="210" y="100" width="150" height="56" rx="8"/>
<text class="tb" x="285" y="120" text-anchor="middle" dominant-baseline="middle">快照存储</text>
<text class="ts" x="285" y="140" text-anchor="middle">定期合并·对象存储</text>
<rect class="b5" x="390" y="100" width="170" height="56" rx="8"/>
<text class="tb" x="475" y="120" text-anchor="middle" dominant-baseline="middle">元数据库</text>
<text class="ts" x="475" y="140" text-anchor="middle">文档·权限·版本索引</text>
<rect class="b1" x="580" y="100" width="160" height="56" rx="8"/>
<text class="tb" x="660" y="120" text-anchor="middle" dominant-baseline="middle">周边服务</text>
<text class="ts" x="660" y="140" text-anchor="middle">评论·搜索·导出</text>
<line class="l" x1="490" y1="70" x2="105" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="70" x2="285" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="490" y1="70" x2="475" y2="100" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="176" width="720" height="194" rx="8"/>
<text class="th" x="32" y="196">核心流程与设计点</text>
<text class="ts" x="380" y="222" text-anchor="middle">① 打开文档：加载最近快照 + 其后的增量日志重建文档，发给客户端；客户端建立 WebSocket 加入“文档房间”</text>
<text class="ts" x="380" y="244" text-anchor="middle">② 编辑：客户端本地立即应用 → 发送操作/更新 → 服务器校验权限 → 转换/合并 → 追加日志（持久化成功后才确认）→ 广播</text>
<text class="ts" x="380" y="266" text-anchor="middle">③ 路由：同一文档的所有连接路由到同一实例（一致性哈希 + 路由表），实例内单线程/单队列串行处理该文档的操作</text>
<text class="ts" x="380" y="288" text-anchor="middle">④ 快照：按操作数/时间/空闲触发合并日志生成快照，加速加载，截断旧日志（保留历史需要的部分用于版本回放）</text>
<text class="ts" x="380" y="310" text-anchor="middle">⑤ 光标与在线：Awareness 在房间内存中广播，不落盘；心跳超时清理</text>
<text class="ts" x="380" y="332" text-anchor="middle">⑥ 扩缩容与故障：实例故障时文档房间迁移到其他实例，从日志+快照恢复；客户端自动重连并差量同步</text>
<text class="ts" x="380" y="354" text-anchor="middle">⑦ 冷热分层：长期未访问的文档只存快照与元数据，访问时再加载；热门文档常驻内存</text>
</svg>
<figcaption>图 4：协同文档的总体架构</figcaption>
</figure>

### 文档房间与路由

- **单文档串行化**：同一文档的所有写操作由**一个协同服务实例**的**单线程（或有序队列）**处理 —— 这保证 OT 的权威顺序，也简化 CRDT 的持久化顺序与广播；
- **路由**：网关用**文档 ID 一致性哈希**或**路由表（文档 → 实例）**把连接路由到持有该房间的实例；路由变更（扩缩容、故障）时**迁移房间**：旧实例停止接收 → 持久化最终状态 → 新实例加载 → 客户端重连；见 [分片、一致性哈希与再平衡](#/distributed/partitioning)；
- **多实例同房间**？一般避免。若必须（超级热点文档），CRDT 可以多实例**互相同步更新**（对等广播），OT 则需要选主；
- **长连接数**：单实例承载的连接数与文档数有限，容量规划按“活跃文档数 × 每文档连接数”估算，见 [案例：实时消息推送系统设计详解](#/design/case-push)。

### 客户端同步协议（以 OT/版本为例）

| 消息 | 说明 |
| --- | --- |
| **hello/join** | 客户端告知文档 ID、已知版本（或 State Vector），服务器返回缺失的操作/更新或全量快照 |
| **op（操作）** | 客户端发送：基于版本 n 的操作；服务器返回 **ack（新版本）**；乱序/重复通过**序号与版本**去重 |
| **broadcast** | 服务器广播他人操作及其版本 |
| **resync** | 版本不连续、校验和不一致时，客户端请求重新同步（拉取快照） |
| **awareness** | 光标/选区/用户信息，轻量、可丢、不持久 |
| **心跳** | 检测连接，服务端驱逐死连接 |

**可靠性要点**：每个操作带 **客户端 ID + 序号**，服务器按 `(clientId, seq)` **去重（幂等）**；断线重连后**重发未确认的操作**；服务器**先持久化再确认**，保证“已确认不丢”，见 [幂等设计与重试](#/distributed/idempotent)。

## 7. 离线编辑与重连

- **客户端本地存储**（IndexedDB）保存文档状态与待发送的操作队列；
- **重连**：带上已知版本/State Vector，服务器返回差量；本地待发送操作与服务器的并发操作**通过 OT 转换或 CRDT 合并**得到一致结果；
- **长时间离线**：OT 的转换链很长（需要大量服务器操作转换），可能退化为“拉取最新快照 + 把本地离线改动作为一次合并/冲突提示”；CRDT 对此更友好，但离线期间文档增长导致的合并体积要控制；
- **冲突体验**：自动合并通常可行；但**结构性冲突**（如一人删除整段，另一人在该段中编辑）需要产品策略（保留编辑内容/提示用户/生成建议）；
- **断网期间的权限变化**：恢复后服务器按最新权限校验离线操作，被拒绝的操作需要反馈给用户（避免“离线时写了很久，恢复后被丢弃”的糟糕体验——提前限制或提示）。

## 8. 光标、选区与在线状态（Awareness）

- **不属于文档内容**：光标位置、选区、用户颜色、正在输入——**高频、临时、可丢失**，**不进入操作日志与版本历史**；
- **位置表示**：光标要随文档变化“**粘附**”到字符：OT 用位置并随转换更新；CRDT 用**相对位置（引用字符 ID + 偏移）**，对并发修改稳健；
- **传输**：走同一 WebSocket 的独立消息类型，**节流（如 50~100ms）与合并**，只发送变化；服务器只在房间内存中转发，不落盘；
- **清理**：心跳超时即视为离开；断线重连重新注册；
- **隐私**：显示昵称/头像受权限控制；匿名访客标识；
- **规模**：大房间（数百人）时只下发**视口附近/最近活跃**用户的光标，降低广播量。

## 9. 版本历史、快照与日志压缩

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="操作日志与快照：所有操作按顺序追加到日志；定期把某个版本之前的状态合并为快照；打开文档时加载最近快照加上之后的日志；日志可压缩合并小操作；历史版本通过保留关键快照与日志实现回放和对比；删除旧日志前确认快照已持久化；为支持精确的历史回放可保留完整日志于冷存储">
<rect class="b3" x="20" y="40" width="720" height="54" rx="8"/>
<text class="tb" x="380" y="56" text-anchor="middle" dominant-baseline="middle">操作/更新日志（追加写）：op1 · op2 · op3 · … · op10000 · …</text>
<text class="ts" x="380" y="78" text-anchor="middle">每条带：文档 ID、版本号、客户端 ID、序号、用户、时间、负载</text>
<rect class="b5" x="20" y="112" width="170" height="56" rx="8"/>
<text class="tb" x="105" y="132" text-anchor="middle" dominant-baseline="middle">快照 S@v5000</text>
<text class="ts" x="105" y="152" text-anchor="middle">合并后的完整状态</text>
<rect class="b5" x="210" y="112" width="170" height="56" rx="8"/>
<text class="tb" x="295" y="132" text-anchor="middle" dominant-baseline="middle">快照 S@v10000</text>
<text class="ts" x="295" y="152" text-anchor="middle">定期/空闲时生成</text>
<rect class="b2" x="400" y="112" width="340" height="56" rx="8"/>
<text class="tb" x="570" y="132" text-anchor="middle" dominant-baseline="middle">打开文档 = 最近快照 + 其后日志</text>
<text class="ts" x="570" y="152" text-anchor="middle">例：S@v10000 + op10001…op10230</text>
<rect class="bg" x="20" y="184" width="720" height="106" rx="8"/>
<text class="th" x="32" y="204">要点</text>
<text class="ts" x="380" y="228" text-anchor="middle">快照触发：操作数阈值、时间间隔、文档空闲；生成在后台，不阻塞编辑；快照后可截断早于快照的日志（保留策略按需）</text>
<text class="ts" x="380" y="250" text-anchor="middle">版本历史：保留关键快照（如每 N 分钟/手动命名）与日志，支持查看、对比（diff）、恢复（恢复本身也是一次新操作）</text>
<text class="ts" x="380" y="272" text-anchor="middle">日志压缩：合并连续的单字符插入为块；CRDT 做垃圾回收；冷数据归档到对象存储</text>
</svg>
<figcaption>图 5：操作日志、快照与版本历史</figcaption>
</figure>

| 议题 | 说明 |
| --- | --- |
| **持久化顺序** | 先追加日志（持久化成功）再 ACK/广播；日志存储需要**高写吞吐、有序、可按文档读取**（Kafka/专用日志存储/数据库追加表） |
| **恢复** | 实例崩溃后从“最近快照 + 日志”恢复房间状态，客户端重连差量同步 |
| **版本粒度** | 自动版本（按时间/编辑会话聚合）+ 手动命名版本；展示“谁在何时改了什么” |
| **回滚** | 恢复到历史版本 = 产生一条“还原为 vX”的新操作（保持日志只增），不要改写历史 |
| **对比** | 基于文档模型做结构化 diff（段落/样式/表格） |
| **合规删除** | 永久删除敏感内容时，**历史日志/快照/CRDT 墓碑**中的内容也要处理（重写快照、清除日志），这是 CRDT/事件溯源的难点 |
| **导出与备份** | 定期导出快照到备份存储，见 [高可用架构设计](#/design/arch-availability) |

## 10. 数据模型：富文本、表格与结构化内容

| 内容类型 | 模型 | 协同要点 |
| --- | --- | --- |
| **纯文本** | 字符序列 | insert/delete，OT/CRDT 最成熟 |
| **富文本** | 文本 + 属性（加粗、链接）；常用 **Delta**（`retain/insert/delete` + attributes）或 ProseMirror/Slate 的树模型 | 样式变化是对“范围”的操作（retain with attributes），并发的样式冲突按最后写入/合并规则 |
| **块结构文档（Notion 式）** | 块的树/列表，块内是文本 | 块的插入/移动/删除用**有序列表 CRDT/OT**，块内文本独立协同；**“移动”**是难点（并发移动与删除） |
| **表格/电子表格** | 二维网格；行列的插入删除会改变坐标 | 行/列用有序序列 CRDT 标识，单元格以（行 ID, 列 ID）定位，避免因插入行列导致坐标失效；公式依赖重算 |
| **JSON/结构化数据** | Map/Array 嵌套 | Yjs/Automerge 提供 Map、Array 类型 |
| **图片/附件** | 引用对象存储中的资源 ID | 文档内只存引用，上传另走存储通道 |
| **评论/批注** | 锚定到文本范围（起止位置） | 锚点要**随文本变化漂移**：OT 随转换更新；CRDT 用字符 ID 作为锚点 |

## 11. 权限、安全与审计

| 方面 | 说明 |
| --- | --- |
| **操作级权限** | 服务器校验每个操作：只读/评论者不能提交编辑操作（评论者只能提交评论类操作）；**不信任客户端** |
| **CRDT 下的授权** | 更新是二进制的、对等传播，服务器需要**解析/校验更新来源与类型**（或为不同权限分通道），防止恶意客户端伪造他人 ID 的操作或注入巨量墓碑（DoS）；限制更新大小与速率 |
| **分享与链接权限** | 链接分享的角色、有效期、密码；组织内目录与成员权限，见 [微服务安全](#/spring/cloud-security) |
| **内容安全** | 富文本输入防 XSS（白名单标签与属性）、粘贴内容清洗；上传文件安全扫描，见 [Web 安全：OWASP 常见漏洞与防护](#/security/web) |
| **审计** | 记录谁在何时编辑/分享/导出；敏感操作留痕；水印与防泄露（企业场景） |
| **加密** | 传输 TLS；静态加密；企业级可用租户密钥，见 [多租户 SaaS 架构](#/design/arch-multitenant)、[加密与密钥管理](#/security/crypto) |
| **滥用防护** | 限制单文档大小、操作速率、并发连接数；垃圾内容/批量操作检测 |

## 12. 性能、容量与可靠性

### 容量估算（示例）

```text
活跃文档 100 万，其中同时在线编辑 ≈ 10 万；每文档平均 3 个在线用户 → 30 万长连接
每活跃编辑者约每秒 2~5 个按键 → 操作 QPS ≈ 30 万 × 3 ≈ 约 100 万/秒（批量合并后降低），广播扇出 ×(用户数-1)
单文档串行处理的操作吞吐远低于全站总量，瓶颈在：长连接数、广播扇出、日志写吞吐
（按真实数据校准，推演仅示意量级）
```

### 优化手段

| 手段 | 说明 |
| --- | --- |
| **客户端合并与节流** | 连续输入合并成一个操作发送（如 50~100ms 窗口）；Awareness 节流 |
| **服务端批处理** | 同一文档短窗口内多个操作批量转换/落盘/广播 |
| **差量同步** | 新加入/重连用 State Vector 或版本号拉取差量，而非全量 |
| **二进制编码** | Protobuf/二进制更新，压缩 |
| **日志存储** | 追加写顺序 IO；按文档分区；冷数据下沉对象存储 |
| **内存管理** | 空闲房间卸载（保存快照后移出内存）；大文档分块加载（虚拟滚动/按需） |
| **限流与保护** | 单连接、单文档、单租户限流；超大文档降级为只读/分页编辑 |
| **读多写少的“阅读者”** | 只读用户不参与协同写路径，使用只读订阅或定时刷新，降低负载 |

### 可靠性与故障处理

| 场景 | 处理 |
| --- | --- |
| **协同实例宕机** | 房间迁移到其他实例，从日志+快照恢复；客户端自动重连，未确认的操作重发（幂等去重） |
| **日志写失败** | 不 ACK、不广播（保证“已确认即持久”）；客户端重试；存储告警 |
| **网络分区/弱网** | 客户端本地缓冲继续编辑，恢复后合并；长时间失联提示 |
| **数据损坏/不一致** | 客户端与服务器定期校验文档哈希，不一致触发 resync；服务端有修复/回滚工具与快照备份 |
| **恶意/异常客户端** | 限速、大小限制、协议校验，断开并封禁 |
| **版本升级** | 协议与文档格式版本化，向后兼容；客户端与服务端不同版本共存期，见 [API 设计与演进](#/design/arch-api) |
| **容灾** | 日志与快照跨可用区复制，见 [高可用架构设计](#/design/arch-availability) |

### 监控指标

| 层 | 指标 |
| --- | --- |
| **实时性** | 操作从发出到他人可见的延迟（P50/P99）、ACK 延迟 |
| **连接** | 在线连接数、重连率、心跳超时、每实例房间数与连接数 |
| **协同质量** | 操作转换/合并错误数、resync 次数、文档校验不一致数 |
| **存储** | 日志写延迟、快照耗时、日志大小与增长、冷热分布 |
| **资源** | 房间内存占用、热点文档 TopN、广播扇出量 |
| **产品** | 协同冲突率、离线合并成功率、版本恢复使用情况 |

## 13. OT 与 CRDT 的选型

| 维度 | OT（中心服务器） | CRDT（如 Yjs/Automerge） |
| --- | --- | --- |
| **架构** | 必须中心服务器定序 | 可无中心（也常配中心做持久化与权限） |
| **离线/P2P** | 较弱（长离线转换链长） | **强**，天然支持 |
| **元数据** | 小，文档紧凑 | 较大（ID 与墓碑），需要块合并与 GC |
| **服务端复杂度** | 高（转换逻辑、版本管理） | 低（中转与存储更新），但**权限校验与合规删除更难** |
| **客户端复杂度** | 中等 | 库已封装，使用简单 |
| **成熟度与生态** | Google Docs 等经典，富文本库（Quill/ShareDB 等） | Yjs/Automerge 生态繁荣，编辑器绑定丰富（ProseMirror、Monaco 等） |
| **意图保持** | 语义直观，可精细定制 | 取决于算法（并发插入交错等有细节差异） |
| **适合** | 在线为主、强权限与审计、已有 OT 技术栈 | 离线优先、多端同步、快速构建协同能力、本地优先 |

**实践建议**：新建系统通常**优先考虑成熟 CRDT 库（Yjs）+ 中心化的持久化/权限/广播服务**，快速获得协同能力；对**强审计/合规与精细服务端控制**的企业场景，OT 或 “CRDT + 服务端校验” 并重。**不要自己发明协同算法**。

## 14. 取舍与复盘清单

- [ ] 是否明确了协同的**一致性目标**（收敛、因果、意图保持），并选择了成熟算法/库（OT 或 CRDT）而非自研？
- [ ] 是否**本地先应用、乐观更新**，网络延迟不影响输入手感？
- [ ] 同一文档的操作是否**路由到同一实例串行处理**，房间迁移/故障恢复是否可靠？
- [ ] 持久化是否“**先落日志再确认**”，操作是否带客户端 ID+序号**幂等去重**？
- [ ] 是否有**快照 + 日志压缩**，打开文档的加载时间可控？版本历史/回滚如何保证日志只增？
- [ ] **离线与重连**：差量同步、待发送操作合并、长时间离线的降级策略？
- [ ] **光标/在线状态**是否与文档分离，节流与超时清理？
- [ ] **权限与安全**：服务器是否校验每个操作（含 CRDT 更新）、大小与速率限制、内容清洗与审计？
- [ ] **合规删除**：历史、快照、墓碑中的敏感内容能否被清除？
- [ ] 容量：长连接数、广播扇出、日志写吞吐，热点文档的上限与保护？

## 相关阅读

- [复制与一致性：主从、多主与无主](#/distributed/replication)：CRDT 与冲突解决概述
- [分布式时钟](#/distributed/clock)：逻辑时钟、向量时钟与因果序
- [案例：实时消息推送系统设计详解](#/design/case-push)：长连接网关与广播
- [案例：即时通讯（IM）系统设计详解](#/design/case-im)：消息可靠投递与在线状态
- [分片、一致性哈希与再平衡](#/distributed/partitioning)：文档路由与房间迁移
- [CQRS 与事件溯源](#/design/cqrs-es)：操作日志、快照与回放的思想

## 面试追问

> [!QUESTION] 协同编辑为什么不能直接把操作按位置应用？
> 并发操作下位置索引会失效：用户 A 在位置 1 插入字符，同时用户 B 删除位置 2 的字符，如果各自直接应用对方的原始操作，位置已经偏移，会删错字符并导致副本分叉。需要用 OT 转换操作的位置，或用 CRDT 给每个字符分配唯一 ID，让操作引用 ID 而不是位置，才能保证收敛并保持意图。

> [!QUESTION] OT 的基本原理和中心服务器架构是什么？
> 对基于同一版本产生的并发操作做转换，使转换后无论先后应用结果一致。中心服务器架构里，客户端本地立即应用并发送带基础版本号的操作，服务器按到达顺序定序，把它与之后已应用的操作转换后应用、追加日志并广播；客户端收到他人操作时与本地待确认操作转换后再应用。所有副本经历同一个服务器顺序，只需保证两方转换正确，比 P2P 的 OT 简单。

> [!QUESTION] CRDT 如何实现协同文本？有什么代价？
> 序列 CRDT 给每个字符分配全局唯一且可全序比较的 ID，插入操作表示在某个 ID 之后插入，删除表示给该 ID 打墓碑，因为引用的是不变的 ID，操作天然可交换，任意顺序应用结果相同，也天然支持离线。代价是每字符的 ID 和墓碑带来元数据膨胀，需要块合并和垃圾回收，权限校验、合规删除和历史管理更难。

> [!QUESTION] OT 和 CRDT 怎么选？
> OT 需要中心服务器定序，服务端权威、便于权限审计、文档紧凑，但算法与证明复杂，离线较弱；CRDT 无需中心排序，离线和多端合并天然支持，库成熟如 Yjs，服务端简单，但元数据大、权限与合规删除更难。新建系统常用成熟 CRDT 库加中心化的持久化权限广播服务，强审计合规场景可选 OT 或在 CRDT 上做服务端校验，都不要自研算法。

> [!QUESTION] 光标位置怎么同步？为什么不放进文档历史？
> 光标与选区高频、临时、可丢失，不属于文档内容，走独立的 Awareness 通道，节流后在房间内存广播，不落盘不进版本历史，心跳超时清理。位置要随文档变化粘附，OT 随转换更新，CRDT 用字符 ID 加偏移的相对位置，大房间只下发视口附近用户的光标。

> [!QUESTION] 协同文档的存储怎么设计？
> 操作或更新追加到日志，先持久化成功再确认和广播，保证已确认不丢；定期把状态合并成快照，打开文档加载最近快照加之后的日志；日志合并压缩并把冷数据下沉对象存储；版本历史保留关键快照与日志，回滚是追加一条还原操作而不是改写历史；敏感内容的合规删除要同时处理日志、快照和 CRDT 墓碑。

> [!QUESTION] 离线编辑后重连怎么合并？
> 客户端本地缓存文档和待发送操作，重连时携带已知版本或状态向量，服务器返回差量，本地操作与服务器的并发操作通过 OT 转换或 CRDT 合并得到一致结果。长时间离线时 OT 转换链很长，可能退化为拉取最新快照再合并，CRDT 对此更友好；结构性冲突需要产品策略，恢复后还要按最新权限校验离线操作。
