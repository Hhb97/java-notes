---
level: 深入
tags: [Elasticsearch, Lucene, 倒排索引, FST, 分片, translog, refresh, BM25]
summary: 从 Lucene 倒排索引、分词、集群与分片路由，到写入的 refresh/flush/merge、查询的 query then fetch 与 BM25 相关性，讲清 ES 8.x 的核心原理与边界
---

# Elasticsearch 原理

> [!ABSTRACT] 核心要点
> - ES 是构建在 **Lucene** 之上的分布式搜索引擎：索引被切成**主分片 + 副本**，每个分片就是一个独立的 Lucene 索引，由多个**不可变的 segment** 组成。
> - 倒排索引 = **Term Index（FST，内存）→ Term Dictionary（有序词典，磁盘）→ Posting List（文档 ID 列表，压缩）**；排序和聚合则依赖列式的 **doc values**。
> - 写入先进**内存 buffer + translog**，每隔 `refresh_interval`（默认 1s）生成新 segment 后才可搜索，所以 ES 是**近实时**；flush 做 Lucene commit 落盘并截断 translog；后台 merge 合并小段并物理删除文档。
> - 文档路由 `shard = hash(_routing) % 主分片数`，所以**主分片数创建后不能直接修改**；搜索分 **query 阶段**（各分片返回 Top N 的 ID 和分数）和 **fetch 阶段**（取回文档）。
> - 默认相关性算法是 **BM25**；ES 没有事务、刷新有延迟、mapping 不能随意修改，**不适合做主存储**，应作为数据库的搜索副本。

## 核心概念

| ES 概念 | 类比 MySQL | 说明 |
| --- | --- | --- |
| Index | 表 | 7.x 起一个索引只有一个 type（`_doc`），8.x 的 API 中彻底移除 type |
| Document | 行 | JSON 文档，原文存在 `_source` |
| Field | 列 | 每个字段可以有不同的索引方式（倒排 / doc values / 不索引） |
| Mapping | 表结构 | 字段类型和分词器，已有字段的类型不能修改 |
| Shard | 分表 | 主分片（primary）+ 副本（replica） |
| Segment | — | Lucene 的最小不可变存储单元，一个分片由多个 segment 组成 |

> [!NOTE]
> **8.x 的主要变化**：默认开启安全（TLS + 认证），首次启动自动生成证书和 `elastic` 用户密码；移除 type；JVM 堆默认按机器内存自动设置；向量检索（`dense_vector` + HNSW 近似 kNN）成为一等公民；默认使用 Java 17+ 自带的 JDK。

## 倒排索引

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="倒排索引结构：文档分词后得到有序的 Term Dictionary，每个词项指向 Posting List；内存中的 FST 作为 Term Index 定位词典块">
<rect class="bg" x="20" y="30" width="200" height="140" rx="12"/>
<text class="ts" x="32" y="50">原始文档</text>
<text class="tm" x="36" y="84">1: kafka is fast</text>
<text class="tm" x="36" y="112">2: es index is fast</text>
<text class="tm" x="36" y="140">3: kafka index</text>
<line class="l" x1="220" y1="100" x2="300" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="260" y="90" text-anchor="middle">分词归一</text>
<text class="tb" x="360" y="20" text-anchor="middle" dominant-baseline="middle">Term Dictionary</text>
<rect class="b3" x="300" y="34" width="120" height="26" rx="4"/>
<text class="tm" x="360" y="47" text-anchor="middle" dominant-baseline="middle">es</text>
<rect class="b3" x="300" y="64" width="120" height="26" rx="4"/>
<text class="tm" x="360" y="77" text-anchor="middle" dominant-baseline="middle">fast</text>
<rect class="b3" x="300" y="94" width="120" height="26" rx="4"/>
<text class="tm" x="360" y="107" text-anchor="middle" dominant-baseline="middle">index</text>
<rect class="b3" x="300" y="124" width="120" height="26" rx="4"/>
<text class="tm" x="360" y="137" text-anchor="middle" dominant-baseline="middle">is</text>
<rect class="b3" x="300" y="154" width="120" height="26" rx="4"/>
<text class="tm" x="360" y="167" text-anchor="middle" dominant-baseline="middle">kafka</text>
<text class="tb" x="605" y="20" text-anchor="middle" dominant-baseline="middle">Posting List</text>
<line class="l" x1="420" y1="47" x2="470" y2="47" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="34" width="270" height="26" rx="4"/>
<text class="tm" x="486" y="47" dominant-baseline="middle">[2]</text>
<line class="l" x1="420" y1="77" x2="470" y2="77" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="64" width="270" height="26" rx="4"/>
<text class="tm" x="486" y="77" dominant-baseline="middle">[1, 2]</text>
<line class="l" x1="420" y1="107" x2="470" y2="107" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="94" width="270" height="26" rx="4"/>
<text class="tm" x="486" y="107" dominant-baseline="middle">[2, 3]</text>
<line class="l" x1="420" y1="137" x2="470" y2="137" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="124" width="270" height="26" rx="4"/>
<text class="tm" x="486" y="137" dominant-baseline="middle">[1, 2]</text>
<line class="l" x1="420" y1="167" x2="470" y2="167" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="154" width="270" height="26" rx="4"/>
<text class="tm" x="486" y="167" dominant-baseline="middle">[1, 3]</text>
<line class="la" x1="360" y1="220" x2="360" y2="180" marker-end="url(#arr-a)"/>
<text class="ts" x="372" y="204">前缀 → 词典块位置</text>
<rect class="b5" x="300" y="220" width="120" height="60" rx="8"/>
<text class="tb" x="360" y="240" text-anchor="middle" dominant-baseline="middle">Term Index</text>
<text class="ts" x="360" y="262" text-anchor="middle">FST 前缀自动机</text>
<text class="ts" x="20" y="214">查询 kafka AND fast：</text>
<text class="tm" x="20" y="238">kafka → [1, 3]</text>
<text class="tm" x="20" y="260">fast  → [1, 2]</text>
<text class="tm ta" x="20" y="282">交集  → [1]</text>
<text class="ts" x="470" y="214">Posting List：差值编码 + 位压缩（FOR）</text>
<text class="ts" x="470" y="238">还可存词频、位置、偏移（短语查询、高亮）</text>
<text class="ts" x="470" y="262">filter 结果缓存用 Roaring Bitmap</text>
</svg>
<figcaption>图 1：Lucene 倒排索引的三层结构</figcaption>
</figure>

- **Term Dictionary**：所有词项排序后分块存储在磁盘（`.tim`），有序是为了二分和前缀查找，也让范围查询、前缀查询可行。
- **Term Index**：词典太大放不进内存，于是为词典块建立一个前缀索引（`.tip`），用 **FST（有限状态转换器）** 实现：共享前缀和后缀，体积远小于词典本身，查找复杂度与词长相关而非词典大小。较新的 Lucene 版本中 FST 通过 mmap 加载（堆外），不再大量占用 JVM 堆。
- **Posting List**：每个词项对应的文档 ID 列表，文档 ID 递增有序，存储「差值」再按块位压缩（Frame Of Reference）；多个条件求交集时用**跳表**快速跳过。filter 的缓存结果用 Roaring Bitmap 表示，稠密和稀疏场景都节省空间。
- **doc values**：倒排索引擅长「词 → 文档」，但排序、聚合、脚本需要「文档 → 值」，所以 ES 默认为 keyword、数值、日期等字段额外存储**列式**的 doc values（磁盘 + PageCache）。`text` 字段没有 doc values，要对它聚合只能开启 `fielddata`（加载到堆内，极耗内存，不推荐）。
- 其它结构：`_source`（原文，`.fdt` 存储字段）、norms（字段长度，用于打分）、点数据结构 BKD 树（数值、日期、地理位置的范围查询）。

> [!TIP]
> 用不到的能力就关掉：不需要全文检索的字段用 `keyword`；不需要打分的字段关 `norms`；不需要聚合排序的字段关 `doc_values`；不需要被搜索的字段设 `"index": false`。每关掉一项都在减少磁盘、内存和写入开销。

## 分词与中文分词

分析器（Analyzer）= **字符过滤器**（如去 HTML 标签）→ **分词器**（切词）→ **词项过滤器**（小写、同义词、停用词）。索引时和查询时都会分词，两者的分词结果要能对上，否则搜不到。

```json
POST _analyze
{
  "analyzer": "ik_max_word",
  "text": "中华人民共和国国歌"
}
```

| 分词器 | 行为 | 适用 |
| --- | --- | --- |
| `standard`（默认） | 英文按词切分；中文**逐字切分** | 英文；中文效果差 |
| `ik_max_word` | 最细粒度，穷尽各种组合 | **索引时**，提高召回 |
| `ik_smart` | 最粗粒度，智能切分 | **查询时**，提高精确度 |
| `keyword` | 不分词，整体作为一个词项 | 精确匹配字段 |
| `ngram` / `edge_ngram` | 按字符片段切分 | 联想补全、模糊匹配（索引体积膨胀） |

```json
"title": {
  "type": "text",
  "analyzer": "ik_max_word",
  "search_analyzer": "ik_smart"
}
```

> [!WARNING]
> - IK 是第三方插件，版本必须与 ES 版本**严格一致**，升级 ES 时要同步升级插件。
> - 自定义词典和停用词支持远程热更新（插件定时检查 HTTP 头的 `Last-Modified` / `ETag`），但**只对新写入的文档生效**，存量文档要重建索引才能按新词典切分。
> - 修改索引的分词器需要重建索引（reindex），所以上线前就要确定好。

## 集群与节点角色

| 角色（8.x `node.roles`） | 职责 | 建议 |
| --- | --- | --- |
| `master` | 维护集群状态（索引、mapping、分片分配），参与选主 | 生产独立部署 **3 个**专用主节点，轻量配置 |
| `data` / `data_hot` / `data_warm` / `data_cold` / `data_frozen` | 存储分片，执行读写与聚合 | 按冷热分层；吃 CPU、内存、磁盘 |
| `ingest` | 执行 ingest pipeline 预处理 | 有大量预处理时独立部署 |
| 协调节点（`node.roles: []`） | 接收请求、分发、汇总结果 | 大量聚合 / 深分页时独立部署，保护数据节点 |
| `ml` / `transform` / `remote_cluster_client` | 机器学习、转换、跨集群 | 按需 |
| `voting_only` | 只参与投票、不当选主节点 | 用于凑够奇数投票节点 |

**选主**：7.x 起使用全新的集群协调层（不再有 `discovery.zen.minimum_master_nodes`），选举需要投票配置中**多数派**同意，从根本上避免脑裂。首次启动集群必须配置 `cluster.initial_master_nodes`，集群形成后应删除该配置。

> [!CAUTION]
> 不要用 `cluster.initial_master_nodes` 去「修复」已有集群：在已经形成过的集群节点上重新引导，可能产生两个独立集群，数据分叉。

## 索引、分片、副本与路由

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="文档按 routing 哈希对主分片数取模定位到分片 1，3 个主分片和副本分散在 3 个节点上，主副本不在同一节点">
<rect class="b1" x="20" y="110" width="150" height="56" rx="8"/>
<text class="tm" x="95" y="130" text-anchor="middle" dominant-baseline="middle">_id = 1001</text>
<text class="ts" x="95" y="152" text-anchor="middle">routing 默认取 _id</text>
<line class="l" x1="170" y1="138" x2="220" y2="138" marker-end="url(#arr)"/>
<rect class="b3" x="220" y="100" width="200" height="76" rx="8"/>
<text class="tm" x="320" y="124" text-anchor="middle" dominant-baseline="middle">murmur3(_routing)</text>
<text class="t" x="320" y="150" text-anchor="middle" dominant-baseline="middle">% 主分片数(3) = 1</text>
<line class="la" x1="420" y1="138" x2="490" y2="147" marker-end="url(#arr-a)"/>
<rect class="bg" x="470" y="8" width="270" height="272" rx="12"/>
<text class="ts" x="482" y="24">索引 orders：3 主分片 × 1 副本</text>
<rect class="b" x="490" y="34" width="230" height="66" rx="8"/>
<text class="tb" x="506" y="67" dominant-baseline="middle">Node 1</text>
<rect class="b1" x="580" y="54" width="60" height="26" rx="4"/>
<text class="tm" x="610" y="67" text-anchor="middle" dominant-baseline="middle">P0</text>
<rect class="b" x="648" y="54" width="60" height="26" rx="4"/>
<text class="tm" x="678" y="67" text-anchor="middle" dominant-baseline="middle">R2</text>
<rect class="b" x="490" y="114" width="230" height="66" rx="8"/>
<text class="tb" x="506" y="147" dominant-baseline="middle">Node 2</text>
<rect class="b2" x="580" y="134" width="60" height="26" rx="4"/>
<text class="tm" x="610" y="147" text-anchor="middle" dominant-baseline="middle">P1</text>
<rect class="b" x="648" y="134" width="60" height="26" rx="4"/>
<text class="tm" x="678" y="147" text-anchor="middle" dominant-baseline="middle">R0</text>
<rect class="b" x="490" y="194" width="230" height="66" rx="8"/>
<text class="tb" x="506" y="227" dominant-baseline="middle">Node 3</text>
<rect class="b1" x="580" y="214" width="60" height="26" rx="4"/>
<text class="tm" x="610" y="227" text-anchor="middle" dominant-baseline="middle">P2</text>
<rect class="b" x="648" y="214" width="60" height="26" rx="4"/>
<text class="tm" x="678" y="227" text-anchor="middle" dominant-baseline="middle">R1</text>
<text class="ts" x="20" y="222">主分片数创建后不可直接修改（_split / _shrink / reindex）</text>
<text class="ts" x="20" y="246">副本永远不会与它的主分片分配在同一节点</text>
<text class="ts" x="20" y="270">自定义 routing 可让查询只命中一个分片</text>
</svg>
<figcaption>图 2：文档路由与分片分布</figcaption>
</figure>

- **路由公式**：精确地说是 `shard = (hash(_routing) % num_routing_shards) / routing_factor`，其中 `num_routing_shards` 是为将来 `_split` 预留的「虚拟分片数」；不做 split 时等价于 `hash(_routing) % 主分片数`。主分片数一变，所有文档的落点都变了，所以主分片数不能直接修改。
- **副本的作用**：高可用（主分片所在节点宕机，副本提升为主）+ 分担查询。副本数可以随时动态调整。
- **7.0 起默认 1 主分片 1 副本**（之前是 5 主 1 副本）。
- **自定义 routing**：如按 `userId` 路由，同一用户的数据集中在一个分片，查询时指定 routing 只查一个分片；代价是数据倾斜风险，并且 `_id` 的唯一性只在同一 routing 下保证。

## 写入流程

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="写入流程：协调节点路由到主分片，主分片写入内存 buffer 和 translog 后并行复制到副本；refresh 生成可搜索的 segment，flush 落盘，merge 合并段">
<rect class="b" x="20" y="30" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="55" text-anchor="middle" dominant-baseline="middle">Client</text>
<line class="l" x1="120" y1="55" x2="160" y2="55" marker-end="url(#arr)"/>
<rect class="b" x="160" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="230" y="48" text-anchor="middle" dominant-baseline="middle">协调节点</text>
<text class="ts" x="230" y="68" text-anchor="middle">按 routing 转发</text>
<line class="l" x1="300" y1="55" x2="340" y2="55" marker-end="url(#arr)"/>
<rect class="b1" x="340" y="30" width="140" height="50" rx="8"/>
<text class="tb" x="410" y="55" text-anchor="middle" dominant-baseline="middle">主分片</text>
<line class="l" x1="480" y1="46" x2="560" y2="46" marker-end="url(#arr)"/>
<text class="ts" x="520" y="38" text-anchor="middle">② 并行复制</text>
<line class="ld" x1="560" y1="66" x2="480" y2="66" marker-end="url(#arr)"/>
<text class="ts" x="520" y="84" text-anchor="middle">③ 确认</text>
<rect class="b" x="560" y="30" width="160" height="50" rx="8"/>
<text class="tb" x="640" y="55" text-anchor="middle" dominant-baseline="middle">副本分片 × N</text>
<text class="ts" x="230" y="100" text-anchor="middle">④ 全部 in-sync 副本成功后应答</text>
<line class="l" x1="410" y1="80" x2="410" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="420" y="106">① 写 buffer + translog</text>
<rect class="bg" x="20" y="124" width="720" height="196" rx="12"/>
<text class="ts" x="32" y="142">分片内部（一个分片 = 一个 Lucene 索引）</text>
<rect class="b3" x="40" y="166" width="150" height="50" rx="8"/>
<text class="tb" x="115" y="191" text-anchor="middle" dominant-baseline="middle">内存 Buffer</text>
<text class="ts" x="115" y="234" text-anchor="middle">不可搜索</text>
<line class="la" x1="190" y1="191" x2="270" y2="191" marker-end="url(#arr-a)"/>
<text class="ts" x="230" y="158" text-anchor="middle">refresh（默认 1s）</text>
<rect class="b2" x="270" y="166" width="170" height="50" rx="8"/>
<text class="tb" x="355" y="191" text-anchor="middle" dominant-baseline="middle">新 Segment（OS Cache）</text>
<text class="ts" x="355" y="234" text-anchor="middle">可搜索，尚未 fsync</text>
<line class="la" x1="440" y1="191" x2="520" y2="191" marker-end="url(#arr-a)"/>
<text class="ts" x="480" y="158" text-anchor="middle">flush（Lucene commit）</text>
<rect class="b" x="520" y="166" width="200" height="50" rx="8"/>
<text class="tb" x="620" y="191" text-anchor="middle" dominant-baseline="middle">Segment 持久化到磁盘</text>
<text class="ts" x="620" y="234" text-anchor="middle">之后截断旧 translog</text>
<rect class="b4" x="40" y="256" width="150" height="44" rx="8"/>
<text class="tb" x="115" y="278" text-anchor="middle" dominant-baseline="middle">Translog</text>
<text class="ts" x="202" y="276">默认每个请求 fsync 后才应答</text>
<text class="ts" x="202" y="294">宕机后重放未 commit 的操作</text>
<text class="ts" x="620" y="276" text-anchor="middle">后台 merge：小段合并为大段</text>
<text class="ts" x="620" y="294" text-anchor="middle">并物理删除已标记删除的文档</text>
</svg>
<figcaption>图 3：一次写入在集群和分片内部的流转</figcaption>
</figure>

1. 请求到达任意节点（协调节点），按路由公式找到主分片所在节点并转发。
2. 主分片校验并执行写入：写入**内存 indexing buffer**，同时追加 **translog**。
3. 主分片把操作**并行**转发给所有 **in-sync 副本**（集群状态中维护的 in-sync allocation id 集合）；某个副本失败时，主分片请求 master 将其移出 in-sync 集合，而不是让写入失败。
4. 所有 in-sync 副本成功后应答客户端。`wait_for_active_shards`（默认 1，即只要求主分片）只是写入**前**的活跃分片数检查，不改变「写入要复制到所有 in-sync 副本」的语义。

分片内部的三个动作：

| 动作 | 做什么 | 触发 | 结果 |
| --- | --- | --- | --- |
| **refresh** | 把 buffer 中的文档写成一个新 segment（在 OS Cache 中），打开新的 searcher | 每 `refresh_interval`（默认 1s）；或手动 `_refresh`；或写入时 `?refresh=wait_for` | **可被搜索**，但未 fsync |
| **flush** | 执行 Lucene commit：fsync 所有 segment，写 commit point，开启新的 translog 代 | translog 大小达到阈值（`index.translog.flush_threshold_size`）、定期、或手动 `_flush` | 数据持久化，旧 translog 可清理 |
| **merge** | 后台把多个小 segment 合并为大 segment | `TieredMergePolicy` 自动调度 | 减少段数量，提高查询性能，真正删除被标记删除的文档 |

- **为什么是近实时**：Lucene 的 segment 只有被 searcher 打开后才可见，而生成 segment（refresh）有开销，不可能每条写入都做，于是默认每秒一次。
- **为什么不怕 refresh 后的数据丢失**：refresh 生成的 segment 只在 OS Cache 中，但 translog 默认 `index.translog.durability=request`——**每个写请求在应答前都 fsync translog**，宕机重启后重放 translog 即可恢复。设为 `async` 时每 `sync_interval`（默认 5s）fsync 一次，性能更高但可能丢失最多这段时间的数据。
- **更新与删除**：segment 不可变，删除只是在 `.liv` 文件中标记，查询时过滤；更新 = 标记删除旧文档 + 写入新文档。大量更新会产生大量「已删除文档」，直到 merge 时才回收空间。
- **并发控制**：每个文档有 `_seq_no` 和 `_primary_term`，用 `if_seq_no` + `if_primary_term` 做乐观锁（旧版本的 `version` 参数内部控制已被替代）。

> [!NOTE]
> 7.0 起有「搜索空闲」优化：如果没有显式设置 `refresh_interval`，分片在 `index.search.idle.after`（默认 30s）内没有收到搜索请求，就暂停定时 refresh，下一次搜索到来时先触发 refresh 并等待它完成。这能大幅提升纯写入场景的吞吐，但会让「长时间无查询后的第一次查询」变慢。

## 读流程

**按 ID 读取（GET）**：根据路由定位分片，在主分片和副本之间轮询（实际使用自适应副本选择，优先响应快的副本）。GET 默认是**实时**的：即使文档尚未 refresh 也能读到（内部会从 translog 读取或触发刷新，具体实现随版本变化）。

**搜索（默认 query_then_fetch）**：

1. **Query 阶段**：协调节点把请求发给索引的每个分片（每个分片选一个副本），每个分片在本地执行查询，返回**排序后前 `from + size` 个文档的 ID 和排序值**（不含正文）到协调节点。
2. 协调节点合并所有分片的结果，全局排序，选出真正的 `[from, from + size)`。
3. **Fetch 阶段**：协调节点只向持有这些文档的分片发起 multi-get 取回 `_source`，组装后返回。

> [!WARNING]
> 由此可见深分页的代价：`from=10000, size=10` 时，**每个分片**都要返回 10010 条，协调节点要对 `分片数 × 10010` 条排序，再丢掉绝大部分。这就是 `index.max_result_window` 默认限制为 10000 的原因，深分页方案见 [ES 实战与数据同步](#/mw/es-practice)。

**dfs_query_then_fetch**：BM25 的 IDF 默认在**分片内**计算，数据量小或分布不均时，同一个词在不同分片的 IDF 不同，导致排序不稳定。`search_type=dfs_query_then_fetch` 会先收集各分片的词频统计算出全局 IDF，代价是多一轮请求。数据量足够大时差异可忽略。

## 相关性评分：BM25

ES 5.0 起默认相似度从 TF-IDF 换成 **BM25**：

```text
score(q, d) = Σ IDF(t) × tf × (k1 + 1) / (tf + k1 × (1 - b + b × |d| / avgdl))

IDF(t) = ln(1 + (N - n + 0.5) / (n + 0.5))      N：文档总数，n：包含词 t 的文档数
k1 = 1.2  控制词频饱和速度          b = 0.75  控制字段长度归一化的力度
```

与 TF-IDF 的区别：

- **词频饱和**：TF-IDF 中词频越高分数线性 / 开方增长，关键词堆砌能刷分；BM25 中 tf 增大后分数趋于上限 `k1 + 1`。
- **长度归一化可调**：`b=0` 不考虑长度，`b=1` 完全归一化；短字段（如标题）命中比长字段（正文）更有价值。

用 `"explain": true` 可以看到每个文档的评分明细，调试相关性必备。业务排序常常需要叠加业务因子（销量、时间衰减），用 `function_score` 或 `rank_feature` 字段实现，而不是改 BM25 参数。

## 段合并

- 每次 refresh 都产生一个新 segment，1s 一次意味着段数量迅速增长；每个段都要占用文件句柄、内存，查询时需要逐段搜索后合并结果。
- 后台按 `TieredMergePolicy` 把大小相近的段合并，合并过程中被标记删除的文档被真正清除。合并是 IO 和 CPU 密集操作，ES 会自动限流。
- 对**不再写入**的索引（如按天滚动的历史日志索引），可以执行 `POST /logs-2024.01.01/_forcemerge?max_num_segments=1`，减少段数量、提升查询速度并回收已删除文档空间。

> [!CAUTION]
> 不要对仍在写入的索引执行 force merge：合并出的超大段（可能远超 5GB）不会再参与常规合并，之后的删除和更新标记在这个大段里的文档永远得不到回收，磁盘占用持续膨胀。

## 为什么 ES 不适合做主存储

| 问题 | 说明 |
| --- | --- |
| 无事务 | 单文档操作原子，但没有多文档事务，没有回滚 |
| 近实时 | 写入后默认最长 1s 才能搜到，读己之写需要 `refresh=wait_for` 或 GET |
| Mapping 刚性 | 字段类型、分词器、主分片数改不了，只能 reindex |
| 一致性模型 | 主分片写成功即可见于主分片，副本 refresh 时间不同步，不同副本查询结果可能短暂不一致 |
| 数据可靠性 | 历史上有过脑裂、数据丢失问题（7.x 新协调层已大幅改善），备份依赖快照 |
| 资源开销 | 倒排索引、doc values、`_source` 多份存储，磁盘和内存开销远高于数据库 |
| 关联查询弱 | 没有 join（nested / parent-child 代价高），需要冗余建模 |

正确姿势：**MySQL 等数据库是主存储（source of truth），ES 是可以随时从主存储重建的搜索副本**，同步方案见 [ES 实战与数据同步](#/mw/es-practice)。

## 关键参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `index.number_of_shards` | 1 | 主分片数，创建后不可直接修改 |
| `index.number_of_replicas` | 1 | 副本数，可动态调整 |
| `index.refresh_interval` | 1s | 写多读少调到 30s 或更长，批量导入设 `-1` |
| `index.translog.durability` | request | `async` 提升写入性能，可能丢失最近数秒数据 |
| `index.max_result_window` | 10000 | from + size 的上限 |
| `index.mapping.total_fields.limit` | 1000 | 字段总数上限，防止 mapping 爆炸 |
| JVM 堆 | 8.x 自动 | 不超过物理内存 50%，且不超过约 31GB（保持压缩指针），剩余内存留给 PageCache（Lucene 重度依赖） |
| `cluster.routing.allocation.disk.watermark.*` | 85% / 90% / 95% | 低水位不再分配新分片；高水位迁出分片；洪水位索引只读 |

## 生产实践与踩坑

- **堆不是越大越好**：超过约 32GB 失去压缩指针，有效容量反而下降；Lucene 的段文件靠 OS PageCache 缓存，堆太大会挤压 PageCache，查询变慢。
- **禁用 swap**：`bootstrap.memory_lock: true` 或关闭 swap，一次 swap 就可能导致节点长时间停顿而被踢出集群。
- **mapping 爆炸**：动态 mapping 下把 Map 类型的业务数据（如用户自定义属性）直接写入，key 变成字段名，字段数暴涨，集群状态膨胀，master 压力剧增。用 `flattened` 类型或 `dynamic: false`。
- **text 字段做聚合 / 排序**：报错要求开启 fielddata，开启后堆内存被吃满触发熔断。应该用 `keyword` 子字段。
- **refresh 过于频繁**：业务代码里每次写入都带 `?refresh=true`，大量小段导致 merge 压力和 CPU 飙升。需要读己之写用 `wait_for`，或者干脆在业务上接受 1s 延迟。
- **脚本查询**：`script` 查询无法利用索引，对每个文档执行脚本，数据量大时非常慢；能在写入时预计算的字段就预计算。

## 相关阅读

- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：日志检索场景
- [复杂度与核心数据结构](#/cs/algo-ds)：倒排索引与 Trie/FST 相关结构

## 面试追问

> [!QUESTION] 为什么 ES 是近实时的？写入的数据会丢吗？
> 写入先进入内存 buffer，只有 refresh（默认每 1s）生成新的 segment 并被 searcher 打开后才能搜到，所以是近实时。数据可靠性靠 translog：默认每个写请求在应答前 fsync translog，即使 segment 还在 OS Cache 中未落盘，宕机后也能重放 translog 恢复；flush 时 fsync segment 并截断 translog。translog 改成 async 才可能丢最近几秒的数据。

> [!QUESTION] 倒排索引为什么能快速查询？FST 起什么作用？
> 倒排把「文档 → 词」反转为「词 → 文档列表」，查询词直接定位到文档集合，多条件用跳表做交集。词典很大，Lucene 先用内存里的 FST（共享前缀和后缀的有限状态机）定位到词典块，再在磁盘上的有序块中查找，避免把整个词典放进内存，查找复杂度只与词长有关。

> [!QUESTION] 为什么主分片数不能修改？如果确实需要扩容怎么办？
> 文档落在哪个分片由 `hash(_routing) % 主分片数` 决定，修改分片数会使所有已有文档的路由失效。扩容方式：`_split` 把分片数按倍数拆分（索引需先只读）、`_shrink` 缩小，或者新建索引后 reindex 并通过别名切换；日志类数据通常用 rollover 让新索引使用新的分片数。

> [!QUESTION] ES 的搜索过程是怎样的？为什么深分页慢？
> Query then fetch：协调节点向所有分片广播查询，每个分片返回本地排序后的前 from+size 个文档 ID 和分数，协调节点全局排序后，再到对应分片取回需要的文档。from 越大，每个分片返回和协调节点排序的数据量就越大，内存和 CPU 线性增长，所以默认限制 from+size ≤ 10000。

> [!QUESTION] BM25 相比 TF-IDF 改进了什么？分片对评分有什么影响？
> BM25 引入词频饱和（k1）和可调的长度归一化（b），防止关键词堆砌刷分，对长短字段更公平。IDF 默认在分片内统计，数据量小或分布不均时各分片 IDF 不一致导致排序不稳定，可以用 dfs_query_then_fetch 先计算全局词频，或者在数据量大时忽略这种差异。
