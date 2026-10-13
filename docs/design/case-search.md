---
level: 高级
tags: [架构案例, 搜索, Elasticsearch, 倒排索引, 分词, 相关性, BM25, 召回排序, 联想词, 数据同步, 零停机重建]
summary: 以电商/内容站点的商品搜索为例拆解搜索系统：搜索的整体链路（查询理解→召回→粗排→精排→重排）、索引设计（分词、多字段、同义词/拼音）、数据同步与零停机重建索引、相关性与业务排序、搜索联想与纠错、筛选聚合（Facet）、深分页、分片与容量规划、缓存与降级，以及如何评估搜索质量。
---

# 案例：搜索系统设计详解

> [!ABSTRACT] 核心要点
> - 搜索系统分**两半**：**离线/近线的“建索引”**（数据同步、分词、索引构建）和**在线的“查索引”**（查询理解 → **召回** → 粗排 → 精排 → 重排 → 返回）。Elasticsearch 解决了“召回 + 基础相关性”，**业务效果的差异主要来自查询理解、排序与数据质量**。
> - **索引设计决定上限**：字段拆分（文本检索字段 vs 过滤/排序字段）、**分词器与同义词/拼音**、`keyword` 与 `text` 的区分、**避免动态映射**；变更映射需要**重建索引**，所以要用**别名 + 零停机切换**。
> - **数据同步是第一难题**：数据库是真值，搜索是**派生视图**。优先 **CDC（订阅 binlog）→ MQ → 写入 ES**，保证**最终一致 + 幂等 + 可对账重建**；不要在业务代码里“双写”。
> - **相关性 ≠ 只看文本匹配**：BM25 文本分 + 业务信号（销量、转化、库存、价格、个性化）融合，常用 `function_score` 或 **LTR（学习排序）**；用**线下指标 + 线上 A/B**评估，而不是凭感觉调权重。
> - **常见体验功能**：联想词（Completion Suggester / 前缀索引）、拼写纠错、同义词、拼音搜索、筛选聚合（Facet）、高亮、**零结果兜底**。
> - **工程注意**：**深分页用 `search_after`**、慢查询治理、分片数规划、冷热分层、缓存热门查询、降级到简化查询。

> [!NOTE] 关联
> ES 的存储与查询原理见 [Elasticsearch 原理](#/mw/es)，数据同步与深分页实践见 [ES 实战与数据同步](#/mw/es-practice)，CDC 见 [CDC 与实时数仓](#/bigdata/cdc)。容量数字均为用于推演的**假设**。

## 一、需求与约束

### 1. 功能

- **关键词搜索**商品（标题、品牌、类目、属性），支持多词、模糊、同义；
- **筛选与排序**：类目、品牌、价格区间、销量、评分；综合/销量/价格排序；
- **联想词**（输入时下拉提示）、**拼写纠错**、**历史与热搜**；
- 结果**高亮**；
- 商品**上下架、价格、库存变化**要尽快反映在搜索里。

### 2. 非功能与容量估算（假设）

| 维度 | 假设 |
| --- | --- |
| 数据量 | 商品 2000 万条，单条索引文档约 2KB → 原始约 **40GB**，含倒排与副本（1 副本）约 **200~300GB** |
| 查询量 | 日均 2 亿次搜索，平均 2300 QPS，峰值（大促）5~10 倍 ≈ **2 万 QPS** |
| 延迟 | 搜索 P99 < 200ms；联想词 P99 < 50ms（按键即时） |
| 更新 | 价格/库存/上下架秒级内可见；全量重建可在小时级完成 |
| 可用性 | 99.95%；单节点故障无感；搜索不可用时降级（见下） |

**分片数估算**：单分片建议 **10~50GB**，2000 万商品总数据约 100~150GB（主分片）→ **5~10 个主分片**起步；每个主分片 1 副本；**并发读 QPS 靠副本和节点数扩展**。（原则与参数见 [ES 实战](#/mw/es-practice)。）

## 二、整体链路

<figure class="fig">
<svg viewBox="0 0 820 400" class="dg" role="img" aria-label="搜索系统整体架构：离线与近线部分，商品库通过 CDC 进入 MQ，索引构建服务做清洗、拼接、分词和打标后写入 Elasticsearch，全量重建走新索引加别名切换；在线部分，查询请求进入搜索网关，经过查询理解（分词、纠错、同义词、意图识别），向 Elasticsearch 召回候选，粗排后再由精排服务结合业务信号和个性化排序，最后重排和过滤后返回；缓存与降级贯穿">
<text class="th" x="20" y="22">离线 / 近线：建索引</text>
<rect class="b1" x="20" y="36" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="61" text-anchor="middle" dominant-baseline="middle">商品库 MySQL</text>
<rect class="b5" x="160" y="36" width="100" height="50" rx="8"/>
<text class="tb" x="210" y="61" text-anchor="middle" dominant-baseline="middle">CDC → MQ</text>
<rect class="b3" x="290" y="36" width="170" height="50" rx="8"/>
<text class="tb" x="375" y="54" text-anchor="middle" dominant-baseline="middle">索引构建服务</text>
<text class="ts" x="375" y="74" text-anchor="middle">清洗·拼接·分词·打标</text>
<rect class="b2" x="490" y="36" width="150" height="50" rx="8"/>
<text class="tb" x="565" y="54" text-anchor="middle" dominant-baseline="middle">Elasticsearch</text>
<text class="ts" x="565" y="74" text-anchor="middle">索引别名 products</text>
<rect class="b4" x="670" y="36" width="130" height="50" rx="8"/>
<text class="tb" x="735" y="54" text-anchor="middle" dominant-baseline="middle">全量重建</text>
<text class="ts" x="735" y="74" text-anchor="middle">新索引 + 别名切换</text>
<line class="l" x1="130" y1="61" x2="160" y2="61" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="61" x2="290" y2="61" marker-end="url(#arr)"/>
<line class="l" x1="460" y1="61" x2="490" y2="61" marker-end="url(#arr)"/>
<line class="la" x1="670" y1="61" x2="640" y2="61" marker-end="url(#arr-a)"/>
<text class="th" x="20" y="124">在线：查索引</text>
<rect class="b1" x="20" y="138" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="163" text-anchor="middle" dominant-baseline="middle">用户查询</text>
<rect class="b3" x="150" y="138" width="130" height="50" rx="8"/>
<text class="tb" x="215" y="156" text-anchor="middle" dominant-baseline="middle">查询理解</text>
<text class="ts" x="215" y="176" text-anchor="middle">分词·纠错·同义·意图</text>
<rect class="b2" x="310" y="138" width="110" height="50" rx="8"/>
<text class="tb" x="365" y="156" text-anchor="middle" dominant-baseline="middle">召回</text>
<text class="ts" x="365" y="176" text-anchor="middle">ES 取候选 N 千</text>
<rect class="b5" x="450" y="138" width="110" height="50" rx="8"/>
<text class="tb" x="505" y="156" text-anchor="middle" dominant-baseline="middle">粗排</text>
<text class="ts" x="505" y="176" text-anchor="middle">取 Top 几百</text>
<rect class="b4" x="590" y="138" width="110" height="50" rx="8"/>
<text class="tb" x="645" y="156" text-anchor="middle" dominant-baseline="middle">精排</text>
<text class="ts" x="645" y="176" text-anchor="middle">LTR/个性化</text>
<rect class="b3" x="730" y="138" width="70" height="50" rx="8"/>
<text class="tb" x="765" y="156" text-anchor="middle" dominant-baseline="middle">重排</text>
<text class="ts" x="765" y="176" text-anchor="middle">打散·过滤</text>
<line class="l" x1="120" y1="163" x2="150" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="163" x2="310" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="420" y1="163" x2="450" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="560" y1="163" x2="590" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="700" y1="163" x2="730" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="565" y1="86" x2="380" y2="138" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="210" width="780" height="172" rx="10"/>
<text class="th" x="36" y="234">要点</text>
<text class="ts" x="36" y="258">• 召回追求“不漏”（宽、快），排序追求“排准”（精、可较慢）：漏斗式，每层候选量递减、模型复杂度递增</text>
<text class="ts" x="36" y="278">• ES 默认的 BM25 + function_score 可以覆盖粗排；精排用 LTR/深度模型（独立服务）对 Top 几百条打分</text>
<text class="ts" x="36" y="298">• 搜索网关：参数校验、限流、缓存、降级、AB 实验分流、日志埋点（曝光/点击/加购/下单）</text>
<text class="ts" x="36" y="318">• 全量重建：新建索引 products_v2，导入完成并校验后原子切换别名，回滚就是切回旧别名</text>
<text class="ts" x="36" y="338">• 搜索日志是最重要的数据资产：驱动热搜、纠错、同义词挖掘、排序模型训练与效果评估</text>
<text class="ts" x="36" y="358">• 数据权限/可见性（地区、渠道、上下架）尽量作为索引内的过滤字段，在召回阶段完成</text>
</svg>
<figcaption>图 1：搜索系统的离线建索引与在线查询链路</figcaption>
</figure>

## 三、索引设计

### 1. 字段规划：搜索字段 vs 过滤字段

| 用途 | 类型 | 例 |
| --- | --- | --- |
| **全文检索** | `text` + 分词器 | 标题、副标题、品牌名、类目名、属性文本 |
| **精确过滤/聚合/排序** | `keyword` / 数值 / 日期（`doc_values`） | 类目 ID、品牌 ID、价格、销量、上架状态、店铺 ID |
| **不需要检索** | 不入索引（`index: false`）或不存 | 大字段详情；详情走商品服务取 |
| **多字段（multi-fields）** | 同一字段多种索引方式 | `title`（IK 分词）、`title.pinyin`（拼音）、`title.keyword`（精确）、`title.suggest`（联想） |

```json
PUT products_v1
{
  "settings": {
    "number_of_shards": 8, "number_of_replicas": 1, "refresh_interval": "5s",
    "analysis": {
      "analyzer": {
        "ik_index":  { "type": "custom", "tokenizer": "ik_max_word",   "filter": ["lowercase", "synonym_idx"] },
        "ik_search": { "type": "custom", "tokenizer": "ik_smart",      "filter": ["lowercase", "synonym_search"] }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "spu_id":   { "type": "long" },
      "title":    { "type": "text", "analyzer": "ik_index", "search_analyzer": "ik_search",
                    "fields": { "pinyin": { "type": "text", "analyzer": "pinyin_analyzer" }, "suggest": { "type": "completion" } } },
      "brand_id": { "type": "integer" }, "category_path": { "type": "keyword" },
      "price":    { "type": "scaled_float", "scaling_factor": 100 },
      "sales_30d":{ "type": "integer" }, "score": { "type": "float" },
      "on_sale":  { "type": "boolean" }, "updated_at": { "type": "date" }
    }
  }
}
```

要点：

- **`dynamic: strict`**：禁止未知字段自动建映射，防止“映射爆炸”与类型漂移；
- **索引分词与搜索分词可不同**：索引用 `ik_max_word`（细粒度，召回高），搜索用 `ik_smart`（粗粒度，精确度高）；
- **映射一旦确定，字段类型不能改**：改分词器/类型必须**重建索引**（见下）；
- **文档设计**：把**搜索需要的全部信息拼成一个宽文档**（商品 + 品牌名 + 类目名 + 关键属性），**不要在查询时 join**（ES 的 join 很弱）；更新来源多（价格库、库存库）则用**部分更新**或把易变字段（库存、价格）以较低频率同步；
- **嵌套属性**（规格）用 `nested` 或扁平化 `attrs: ["颜色:红","尺码:XL"]` 的 keyword 数组，减少复杂度。

### 2. 分词、同义词与拼音

| 能力 | 做法 | 注意 |
| --- | --- | --- |
| **中文分词** | IK（`ik_max_word` / `ik_smart`）、结巴/Hanlp 插件 | 词典要持续运营：品牌词、新词、型号（“iPhone15 Pro”），支持热更新词典 |
| **同义词** | 同义词过滤器（`手机,移动电话`），索引时或搜索时展开（**推荐搜索时展开**，改词无需重建索引） | 同义词库要审核，防止语义漂移；多词同义要注意位置 |
| **拼音/首字母** | pinyin 分词插件做 `title.pinyin` 子字段 | 增加索引体积；与中文字段一起 `multi_match` 召回 |
| **英文** | 词干提取、大小写、n-gram（型号模糊） | 型号搜索常用 edge n-gram 或前缀 |
| **纠错** | 基于搜索日志的词频纠错、编辑距离（`fuzziness`）+ 业务词典 | ES 的 `fuzziness` 有性能代价；热搜纠错可离线挖掘 |

### 3. 数据量与索引体积控制

- 不需要评分的字段 `norms: false`；不需要短语匹配的 `index_options: freqs`；
- `_source` 只保留必需字段，或用 `source filtering`；
- 副本数按读流量与可用性定；冷商品可放**冷索引**（低配节点）。

## 四、数据同步与零停机重建

### 1. 同步方案

| 方案 | 说明 | 评价 |
| --- | --- | --- |
| 业务代码双写（写库 + 写 ES） | 一致性难保证（任一失败即不一致）、侵入业务 | ✗ 不推荐 |
| **CDC（Canal/Debezium/Flink CDC）→ MQ → 索引构建 → ES**（推荐） | 订阅 binlog，业务无侵入；构建服务**拼接多表数据**、幂等写入 | ✓ 最终一致、可重放、可对账 |
| 定时增量扫描（`updated_at`） | 简单，有分钟级延迟；删除难感知 | 辅助/兜底 |
| 全量重建 | 离线导出 → 批量写入新索引 | 用于改映射/修复/灾备 |

**索引构建服务的关键点**：

- **以商品 ID 为键，幂等 upsert**（同一事件重复处理无副作用）；
- **版本控制**：使用 `version_type=external`，以数据库的更新时间/版本号作为 ES 版本，**旧事件不覆盖新数据**（解决乱序，见 [事件驱动：乱序与版本](#/design/event-driven)）；
- **多表拼接**：商品、价格、库存、销量分属不同表/服务，任一变化都触发该商品的重建文档（从各源取最新值再写入），而不是依赖事件携带全部字段；
- **删除/下架**：删除文档或置 `on_sale=false` 并过滤；
- **重试与死信**：写 ES 失败（429/超时）退避重试，超限入死信并告警；
- **批量写入**：`_bulk` 一次数百到数千条，控制并发与反压；
- **对账**：定期按 ID 区间抽样比对库与索引（数量、版本、关键字段），差异自动修复（重新同步）。

### 2. 零停机重建（别名切换）

```text
1. 创建新索引 products_v2（新映射/分词器），refresh_interval=-1、replicas=0 加速导入
2. 全量导入 + 同步期间的增量（先记录起始位点，导入完成后追增量，或双写两个索引一段时间）
3. 恢复 refresh_interval / replicas，校验（数量、抽样、核心查询对比）
4. 原子切换别名：POST /_aliases { "actions": [ {"remove": {"index":"products_v1","alias":"products"}}, {"add": {"index":"products_v2","alias":"products"}} ] }
5. 观察；稳定后保留旧索引一段时间再删除（回滚就是切回别名）
```

业务只访问别名 `products`，不感知底层索引名。**时间序列/日志类索引**用 ILM 滚动，与此类“商品索引”重建模式不同。

## 五、查询与相关性

### 1. 查询理解

对用户查询先做处理再去 ES：

1. **规范化**：全半角、大小写、去标点、繁简；
2. **分词 + 实体识别**：识别品牌、类目、型号、数量单位、颜色（“红色 nike 跑鞋 42 码” → 颜色=红、品牌=nike、类目=跑鞋、尺码=42）；
3. **意图识别**：商品词/品牌词/类目词/店铺词/导航词；可据此给不同字段加权或直接走类目页；
4. **纠错与改写**：拼写纠错、同义词扩展、**查询放宽**（零结果时去掉最不重要的词重试）；
5. **个性化特征**：用户性别、偏好品牌、历史点击（用于精排）。

### 2. 召回查询（bool 查询）

```json
POST products/_search
{
  "query": {
    "function_score": {
      "query": { "bool": {
        "must":   [ { "multi_match": { "query": "红色 跑鞋", "type": "best_fields", "operator": "and",
                       "fields": ["title^3", "brand_name^2", "category_name", "attrs_text"] } } ],
        "filter": [ { "term": { "on_sale": true } }, { "range": { "price": { "gte": 100, "lte": 500 } } },
                    { "terms": { "category_id": [1201, 1203] } } ]       // 过滤放 filter：可缓存、不参与评分
      } },
      "functions": [
        { "field_value_factor": { "field": "sales_30d", "modifier": "log1p", "factor": 0.3 } },   // 销量信号，取对数平滑
        { "field_value_factor": { "field": "score", "modifier": "none", "missing": 3 }, "weight": 1 }
      ],
      "score_mode": "sum", "boost_mode": "sum"
    }
  },
  "sort": [ "_score", { "spu_id": "desc" } ],      // 同分按 ID 稳定排序
  "search_after": [ 12.5, 1001234 ], "size": 20,
  "highlight": { "fields": { "title": {} } },
  "aggs": { "brand": { "terms": { "field": "brand_id", "size": 10 } }, "price_range": { "range": { "field": "price", "ranges": [ {"to":100}, {"from":100,"to":500}, {"from":500} ] } } }
}
```

要点：

- **`filter` 与 `must` 的区别**：filter 不算分、可缓存，**所有精确过滤都放 filter**；
- **`operator: and` vs `or`**：and 精确但易零结果，or 召回高但噪声大——常用 **`minimum_should_match`（如 75%）**折中，零结果再放宽；
- **`multi_match` 的 type**：`best_fields`（取最高字段分，适合标题）、`cross_fields`（跨字段当作一个大字段，适合姓名/地址）；
- **字段权重 boost** 要以评测为依据；
- `function_score` 里**销量/评分用 log/饱和函数**，避免热销品永远垄断；

### 3. 相关性与排序

- **BM25**（ES 默认）：词频饱和 + 文档长度归一 + 逆文档频率；**短字段（标题）命中比长字段更可信**；
- **综合排序 = 文本相关性 × 业务质量 × 个性化 × 运营干预**：
  - 业务信号：销量、转化率、点击率、评分、库存、价格带、上新、退货率；
  - **惩罚项**：缺货下沉、低质/违规降权、作弊店铺降权；
  - 个性化：用户偏好品牌/价格带（精排阶段使用）；
- **LTR（Learning to Rank）**：用点击/购买日志训练排序模型（GBDT/深度模型），在**精排**阶段对 Top 几百条打分（ES 有 LTR 插件，或独立服务）；
- **多样性**：重排阶段做同店铺/同品牌打散，避免首页全是同一家。

### 4. 联想词与纠错

| 功能 | 方案 |
| --- | --- |
| **联想（Suggest）** | ES **Completion Suggester**（内存 FST，前缀匹配极快）；或预计算“热搜词 + 商品词”入独立小索引（edge n-gram）；按**搜索热度/转化**排序；拼音联想 |
| **拼写纠错** | “您是不是想找…”：基于日志的纠错词典、编辑距离；或 Term/Phrase Suggester |
| **热搜/历史** | 热搜用实时榜（Redis ZSET，见 [Feed 与排行榜](#/design/case-feed)）+ 人工运营干预；历史存用户维度（最近 N 条） |
| **零结果兜底** | 放宽查询、纠错重试、相似词推荐、热门推荐，**不返回空白页** |

联想词的延迟要求极高（按键即时），**独立服务 + 独立索引 + 本地缓存**，不要与主搜索共用资源。

### 5. 筛选与聚合（Facet）

- 筛选项（品牌、价格区间、属性）来自 **`aggs`**，注意**高基数字段聚合开销大**（如店铺 ID）：限制 `size`、用 `global_ordinals`、预计算或缓存常用类目的聚合；
- **“选了某个筛选项后，其他筛选项的计数是否变化”**：用 `post_filter` + 分层聚合实现多选 facet；
- 聚合与排序都依赖 `doc_values`（列存），确保字段开启。

### 6. 深分页

- `from + size` 要在每个分片取 `from+size` 条再合并，**越深越慢且占内存**（默认 `index.max_result_window=10000` 限制）；
- **`search_after` + 稳定排序字段（如 `_score` + 唯一 ID）**：翻下一页；需要一致性快照时配合 **PIT（Point In Time）**；
- 业务上**限制翻页深度**（搜索结果超过几十页几乎无人看；“看更多”依赖推荐而不是翻页）；
- 导出/全量遍历用 `scroll` 或 PIT + `search_after`，不要走在线接口。

## 六、性能、容量与稳定性

### 1. 性能优化

| 方向 | 手段 |
| --- | --- |
| **查询** | filter 缓存；避免通配符前缀（`*abc`）、脚本评分、大范围 `terms`；限制 `size`；只返回必要字段（`_source` includes）；避免 `nested` 过深 |
| **分片与副本** | 查询并发 ≈ 副本数 × 分片并行；增加副本提升读吞吐；**分片数过多反而变慢**（每个查询触达所有分片） |
| **缓存** | 热门查询结果缓存（按规范化后的 query + 过滤 + 页码 key，TTL 几十秒~几分钟）；热搜词预热；本地缓存 + Redis；注意个性化结果的缓存键 |
| **索引写入与刷新** | `refresh_interval` 调到 5~30s（近实时够用），批量写入；大批量导入时先关闭刷新与副本 |
| **冷热分层** | 近期活跃商品放热节点（SSD），长尾放温/冷节点；不同类目可拆索引（按需） |
| **JVM/内存** | 堆不超过物理内存一半且 ≤ 约 30GB；其余给页缓存（见 [虚拟内存与内存管理](#/cs/os-memory)、[ES 原理](#/mw/es)） |
| **慢查询治理** | 开启慢日志，定位大聚合/深分页/通配符；对应改写或限流 |

### 2. 稳定性与降级

| 风险 | 对策 |
| --- | --- |
| ES 集群抖动/GC 停顿 | 搜索网关超时（几百 ms）+ 熔断；降级到**缓存的热门结果/类目页/简化查询** |
| 突发大流量（大促） | 扩副本/节点、热门查询缓存、限流（见 [限流算法](#/cs/algo-engineering)）、降级个性化/聚合 |
| 单个查询过重（恶意或误用） | 查询复杂度限制：长度、词数、聚合 size、`timeout`、`terminate_after` |
| 索引损坏/误删 | 快照（对象存储）定期备份；别名机制可快速回滚；全量重建能力常态化演练 |
| 数据不一致（搜到已下架商品） | 点击进入详情时以商品库为准；搜索返回前再做一次**可售性校验**（批量查库存/状态）；监控不一致率 |
| 同步积压 | 监控 CDC/MQ 积压，关键变更（价格、库存）走高优先级通道 |

## 七、评估搜索质量

**没有评估就没有优化。**

| 层面 | 指标 / 方法 |
| --- | --- |
| **线上行为指标** | 搜索点击率（CTR）、**无结果率**、**搜索后下单转化率（CVR）**、首屏点击位置（MRR）、“换词重搜”比例、人均搜索次数 |
| **线下相关性** | 标注测试集（query → 期望结果/相关度等级），计算 **NDCG@K、Precision@K、Recall@K**；回归测试：改词典、改权重后跑一遍 |
| **A/B 实验** | 流量分桶，对比新旧排序策略的转化与收入；注意样本量与显著性 |
| **问题发现** | 零结果词 Top、低点击词 Top、高跳出词；人工抽检；badcase 池驱动词典与规则修复 |
| **监控** | 搜索 QPS/P99、ES 慢查询、索引延迟（库→索引的 P99）、缓存命中率、各降级开关状态（见 [指标监控](#/infra/obs-metrics)） |

## 八、与推荐系统的关系

| | 搜索 | 推荐 |
| --- | --- | --- |
| 用户意图 | **主动、明确**（有 query） | 被动、探索（无 query） |
| 召回依据 | 查询词与文档匹配（倒排） | 用户/物品向量、协同过滤、热门、兴趣 |
| 排序目标 | 相关性优先 + 业务信号 | 点击/转化/停留的预估 |
| 基础设施 | ES 倒排索引 | 向量检索（ANN）、特征平台、在线模型服务 |
| 共性 | 都是“召回 → 排序 → 重排”漏斗，都依赖日志闭环与 A/B | 与 [Feed 流](#/design/case-feed) 的排序接入点相同 |

**语义检索**：向量搜索（Embedding + ANN，HNSW）与关键词搜索做**混合检索**（hybrid）：BM25 召回 + 向量召回 → 融合（RRF）→ 重排。思路与 [RAG 检索优化](#/ai/rag-advanced) 一致，用于长尾语义查询与“以文搜图/以图搜图”。

## 九、取舍总结

| 取舍 | 选择 | 代价 |
| --- | --- | --- |
| 双写 vs CDC | CDC + 幂等版本写入 | 链路多一层，需运维 CDC 与 MQ |
| 索引时展开同义词 vs 搜索时展开 | 搜索时展开 | 查询稍重，但改词无需重建 |
| 召回宽 vs 精 | 召回宽、排序精 | 精排服务与模型成本 |
| 实时可见 vs 写入吞吐 | refresh 5s | 秒级延迟，写入压力小 |
| 深分页支持 vs 成本 | 限制深度 + search_after | 不支持随意跳页 |
| 自建 ES vs 云搜索服务 | 视团队运维能力 | 自建灵活但运维重 |

## 相关阅读

- [案例：LBS 附近的人与打车派单设计详解](#/design/case-lbs)：LBS 的空间索引与位置搜索

## 面试追问

> [!QUESTION] 搜索系统的整体链路是什么？ES 在其中承担什么？
> 离线侧：商品库通过 CDC 进入 MQ，索引构建服务做清洗、多表拼接和分词后写入 ES，全量重建用新索引加别名切换。在线侧：查询理解（分词、纠错、同义词、意图）→ 召回 → 粗排 → 精排 → 重排。ES 承担召回和基础相关性，业务效果的差异主要在查询理解、排序和数据质量。

> [!QUESTION] MySQL 的数据怎么同步到 ES？怎么保证一致？
> 推荐 CDC 订阅 binlog 到 MQ，索引构建服务幂等地 upsert，并用外部版本号避免旧事件覆盖新数据，写入失败退避重试再入死信；多表数据在构建时拼接最新值；定期按 ID 区间对账并自动修复，保留全量重建能力。不要在业务代码里双写，因为任一侧失败都会不一致。

> [!QUESTION] 修改了分词器或字段类型怎么办？
> 映射中字段类型和分词器不能原地修改，需要新建索引，全量导入并追赶增量，校验后用别名原子切换，业务始终访问别名；回滚就是切回旧别名，稳定后再删旧索引。

> [!QUESTION] 搜索结果怎么排序？相关性怎么调？
> BM25 文本相关性加业务信号，如销量、转化率、评分、库存、价格，用 function_score 并对销量做对数平滑，缺货和低质下沉；精排阶段用 LTR 或模型融合个性化；重排做打散。调参要靠线下标注集的 NDCG 和线上 A/B 的点击与转化，而不是凭感觉。

> [!QUESTION] ES 深分页为什么慢？怎么解决？
> from 加 size 每个分片都要取前 from+size 条再合并，越深越耗内存和时间，并受 max_result_window 限制。改用 search_after 加稳定排序字段，需要一致快照配合 PIT；业务上限制翻页深度，导出走 scroll 或 PIT。

> [!QUESTION] 搜索联想词怎么做？
> 单独的联想服务和小索引，用 Completion Suggester 的内存 FST 做前缀匹配或 edge n-gram，按搜索热度和转化排序，支持拼音，配合本地缓存，延迟控制在几十毫秒，与主搜索资源隔离；热搜词用实时榜加运营干预。

> [!QUESTION] 如何评估搜索质量并持续优化？
> 线上看点击率、无结果率、搜索转化率和换词重搜比例，线下用标注测试集计算 NDCG、Precision 和 Recall 做回归，所有改动通过 A/B 实验验证，并持续从零结果词、低点击词里挖掘 badcase，修复词典、同义词和规则。
