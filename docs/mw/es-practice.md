---
level: 进阶
tags: [Elasticsearch, Mapping, 深分页, 聚合, 调优, ILM, Canal, 数据同步]
summary: Elasticsearch 的建模、查询、写入调优与容量规划，以及 MySQL 到 ES 的数据同步方案和线上问题排查。
---

# ES 实战与数据同步

> [!ABSTRACT] 核心要点
> - **Mapping 先设计后写入**：字段类型一旦确定不能改；字符串明确用 `keyword`（精确/聚合/排序）还是 `text`（全文检索），关闭不必要的 `dynamic`。
> - **深分页**：`from+size` 受 `max_result_window`（默认 1 万）限制且代价线性放大，改用 **`search_after` + PIT**；`scroll` 仅用于导出。
> - 写入调优：**bulk 批量**（5~15MB/批）、增大 `refresh_interval`、导入期副本置 0；查询调优：`filter` 优先、避免前导通配符与深层嵌套。
> - 分片规划：单分片建议 **10~50GB**，分片数过多会拖垮集群元数据；时序数据用 **索引模板 + ILM** 做冷热分层。
> - **ES 不是主存储**：MySQL 为准，通过 MQ / Canal 异步同步，并设计补偿与全量重建能力。

## Mapping 设计

```json
PUT /product
{
  "settings": { "number_of_shards": 3, "number_of_replicas": 1, "refresh_interval": "5s" },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "id":        { "type": "long" },
      "title":     { "type": "text", "analyzer": "ik_max_word", "search_analyzer": "ik_smart",
                     "fields": { "raw": { "type": "keyword", "ignore_above": 256 } } },
      "brand":     { "type": "keyword" },
      "price":     { "type": "scaled_float", "scaling_factor": 100 },
      "tags":      { "type": "keyword" },
      "status":    { "type": "byte" },
      "created":   { "type": "date", "format": "epoch_millis" },
      "desc":      { "type": "text", "index": false }
    }
  }
}
```

| 决策 | 建议 |
| --- | --- |
| text vs keyword | 需要分词检索用 `text`；等值过滤、聚合、排序用 `keyword`；两者都要用 **multi-fields** |
| 数字类型 | ID、状态码若不做范围查询，用 `keyword` 反而更快；范围查询才用数值类型 |
| `dynamic` | 生产设为 `strict`，防止脏数据产生**字段爆炸**（`index.mapping.total_fields.limit` 默认 1000）|
| 不检索的字段 | `"index": false`，大文本字段甚至不进 `_source`（`_source.excludes`）以节省存储 |
| 日期 | 统一用毫秒时间戳或 ISO 格式，避免多格式混用 |

### nested、object 与 join

- **object**：数组里的对象被打平，`[{a:1,b:2},{a:3,b:4}]` 会变成 `a:[1,3], b:[2,4]`，**丢失对象内字段关联**；
- **nested**：每个子对象作为独立隐藏文档，保持关联，查询需用 `nested` 语法，**代价高**（写入与查询都变慢）；
- 父子 `join`：更新子文档不用重写父文档，但查询慢、必须同分片；
- **优先方案是反范式（数据冗余）**：把关联数据在写入时拍平成一个文档，ES 不擅长 JOIN。

## 查询与调优

### 查询上下文

```json
GET /product/_search
{
  "query": {
    "bool": {
      "must":   [ { "match": { "title": "无线耳机" } } ],              // 打分
      "filter": [ { "term":  { "brand": "sony" } },                    // 不打分，可缓存
                  { "range": { "price": { "gte": 100, "lte": 500 } } } ]
    }
  },
  "sort": [ { "_score": "desc" }, { "id": "asc" } ],
  "_source": [ "id", "title", "price" ],
  "size": 20
}
```

- **能放 `filter` 的不放 `must`**：filter 不计算相关性，结果可被缓存；
- 避免 `wildcard` 前导通配（`*abc`）、`regexp`、脚本打分；模糊匹配用 `ngram` 或 `match_phrase_prefix`；
- 限制返回字段，大文档不要全取 `_source`；
- 聚合只对 `keyword`/数值/日期字段（有 `doc_values`），对 `text` 字段聚合需开启 fielddata（**吃堆内存，禁止**）。

### 深分页

| 方式 | 机制 | 适用 |
| --- | --- | --- |
| `from + size` | 每个分片取 `from+size` 条，协调节点归并再丢弃前 `from` 条；`max_result_window` 默认 10000 | 浅分页 |
| `scroll` | 保存快照游标，批量拉取 | **数据导出**，不适合实时翻页（占资源） |
| **`search_after` + PIT** | 用上一页最后一条的排序值定位下一页，无状态；PIT 保证翻页期间视图一致 | **实时翻页、无限滚动**（只能“下一页”） |

```json
POST /product/_pit?keep_alive=1m             // 得到 pit id
GET /_search
{
  "size": 20,
  "pit": { "id": "<pit-id>", "keep_alive": "1m" },
  "sort": [ { "created": "desc" }, { "_shard_doc": "asc" } ],
  "search_after": [ 1700000000000, 4 ]
}
```

### 聚合的坑

- `terms` 聚合在多分片下是**近似的**：每个分片先取 `shard_size`（默认 `size*1.5+10`）个桶再合并，Top N 可能不精确，`doc_count_error_upper_bound` 给出误差上限，必要时调大 `shard_size`；
- `cardinality` 基于 HyperLogLog++，是近似去重；
- 高基数 terms 聚合 + 多层嵌套容易 OOM，设置 `search.max_buckets`，必要时用 `composite` 聚合分页。

## 写入调优

| 手段 | 说明 |
| --- | --- |
| **Bulk 批量** | 每批 5~15MB（约 1000~5000 条），多线程并发，观察 429（`es_rejected_execution`）退避 |
| 延长 `refresh_interval` | 默认 1s 太频繁；日志场景 30s，大批量导入时设为 `-1` 导入完再恢复 |
| 导入期副本置 0 | `number_of_replicas: 0`，导入完成再恢复，避免双写 |
| 使用自动生成 `_id` | 省去“检查 ID 是否存在”的开销 |
| 增大 translog 间隔 | `index.translog.durability: async` 换吞吐（牺牲少量可靠性） |
| 合理分片 | 写入吞吐与主分片数大致成正比，但不要过多 |

## 分片与容量规划

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="ES 冷热分层与 ILM 生命周期">
<rect class="b4" x="20" y="60" width="150" height="90" rx="10"/>
<text class="tb" x="95" y="84" text-anchor="middle" dominant-baseline="middle">Hot</text>
<text class="ts" x="95" y="104" text-anchor="middle">SSD · 持续写入</text>
<text class="ts" x="95" y="122" text-anchor="middle">rollover：50GB / 7d</text>
<rect class="b3" x="210" y="60" width="150" height="90" rx="10"/>
<text class="tb" x="285" y="84" text-anchor="middle" dominant-baseline="middle">Warm</text>
<text class="ts" x="285" y="104" text-anchor="middle">只读 · forcemerge</text>
<text class="ts" x="285" y="122" text-anchor="middle">shrink 分片 · 减副本</text>
<rect class="b1" x="400" y="60" width="150" height="90" rx="10"/>
<text class="tb" x="475" y="84" text-anchor="middle" dominant-baseline="middle">Cold</text>
<text class="ts" x="475" y="104" text-anchor="middle">HDD · 低频查询</text>
<text class="ts" x="475" y="122" text-anchor="middle">可冻结 / 可搜索快照</text>
<rect class="b" x="590" y="60" width="130" height="90" rx="10"/>
<text class="tb" x="655" y="84" text-anchor="middle" dominant-baseline="middle">Delete</text>
<text class="ts" x="655" y="104" text-anchor="middle">超过保留期</text>
<text class="ts" x="655" y="122" text-anchor="middle">自动删除索引</text>
<line class="l" x1="170" y1="105" x2="210" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="105" x2="400" y2="105" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="105" x2="590" y2="105" marker-end="url(#arr)"/>
<text class="ts" x="190" y="190" text-anchor="middle">7 天</text>
<text class="ts" x="380" y="190" text-anchor="middle">30 天</text>
<text class="ts" x="570" y="190" text-anchor="middle">90 天</text>
<text class="ts" x="370" y="226" text-anchor="middle">日志类索引：索引模板 + ILM 策略 + 别名 / Data Stream，自动滚动与降级</text>
</svg>
<figcaption>图 1：ILM 生命周期：热、温、冷、删除</figcaption>
</figure>

规划要点：

- 单个分片 **10~50GB**（日志类可到 50GB）、每 GB 堆内存对应分片数建议不超过约 20 个；
- 分片过多 → 集群状态膨胀、选举与恢复变慢；过少 → 单分片过大恢复慢、无法并行；
- 堆内存设为物理内存一半且 **不超过 31GB**（压缩指针边界），剩余内存留给**文件系统缓存**（Lucene 段依赖 page cache）；
- 副本数 ≥ 1 以获得高可用与读扩展；
- 变更 Mapping 或分片数需要**重建索引**：新建索引 → `_reindex` → 别名原子切换。

```json
POST /_aliases
{ "actions": [ { "remove": { "index": "product_v1", "alias": "product" } },
               { "add":    { "index": "product_v2", "alias": "product" } } ] }
```

业务只访问别名，**上线新 Mapping 零停机**。

## MySQL → ES 数据同步

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="三种 MySQL 到 Elasticsearch 的同步方案">
<rect class="b1" x="20" y="30" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="50" text-anchor="middle" dominant-baseline="middle">应用写入</text>
<rect class="b5" x="20" y="130" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="150" text-anchor="middle" dominant-baseline="middle">MySQL</text>
<text class="th" x="190" y="24">① 同步双写</text>
<line class="l" x1="130" y1="50" x2="260" y2="50" marker-end="url(#arr)"/>
<rect class="b2" x="260" y="30" width="100" height="40" rx="8"/>
<text class="tb" x="310" y="50" text-anchor="middle" dominant-baseline="middle">ES</text>
<line class="l" x1="75" y1="70" x2="75" y2="130" marker-end="url(#arr)"/>
<text class="ts" x="400" y="50">耦合、不一致无补偿、拖慢主流程</text>
<text class="th" x="190" y="214">② MQ 异步</text>
<rect class="b1" x="20" y="226" width="110" height="40" rx="8"/>
<text class="tb" x="75" y="246" text-anchor="middle" dominant-baseline="middle">应用写入</text>
<line class="l" x1="130" y1="246" x2="200" y2="246" marker-end="url(#arr)"/>
<rect class="b3" x="200" y="226" width="80" height="40" rx="8"/>
<text class="tb" x="240" y="246" text-anchor="middle" dominant-baseline="middle">MQ</text>
<line class="l" x1="280" y1="246" x2="340" y2="246" marker-end="url(#arr)"/>
<rect class="b2" x="340" y="226" width="80" height="40" rx="8"/>
<text class="tb" x="380" y="246" text-anchor="middle" dominant-baseline="middle">ES</text>
<text class="ts" x="440" y="246">仍需业务发消息，漏发需要补偿</text>
<text class="th" x="190" y="104">③ Canal 订阅 binlog（推荐）</text>
<line class="l" x1="130" y1="150" x2="180" y2="150" marker-end="url(#arr)"/>
<text class="ts" x="155" y="140" text-anchor="middle">binlog</text>
<rect class="b3" x="180" y="130" width="80" height="40" rx="8"/>
<text class="tb" x="220" y="150" text-anchor="middle" dominant-baseline="middle">Canal</text>
<line class="l" x1="260" y1="150" x2="300" y2="150" marker-end="url(#arr)"/>
<rect class="b3" x="300" y="130" width="70" height="40" rx="8"/>
<text class="tb" x="335" y="150" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<line class="l" x1="370" y1="150" x2="410" y2="150" marker-end="url(#arr)"/>
<rect class="b2" x="410" y="130" width="110" height="40" rx="8"/>
<text class="tb" x="465" y="150" text-anchor="middle" dominant-baseline="middle">同步服务→ES</text>
<text class="ts" x="540" y="150">业务无侵入、不漏数据、顺序有保证</text>
<text class="ts" x="370" y="310" text-anchor="middle">任何方案都要配套：全量重建（离线 reindex）、对账、幂等写入（外部版本号）</text>
</svg>
<figcaption>图 2：三种同步方案对比</figcaption>
</figure>

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 同步双写 | 实现简单 | 强耦合；ES 故障拖垮主流程；两边不一致无法补偿 |
| 应用发 MQ | 解耦、可异步 | 业务要显式发消息，**事务提交与发消息不原子**会丢（需本地消息表） |
| **Canal / Debezium 订阅 binlog** | 无侵入、与事务提交一致、可回放 | 要部署维护组件；字段变更需同步映射 |

### 保证一致性的细节

1. **幂等写入 + 版本控制**：以主键为 `_id`，用 `version_type=external` 配合数据库 `update_time` / 版本号作为外部版本，**乱序到达的旧消息会被拒绝**；
2. **按主键分区保证单行有序**：同一行的变更落同一 Kafka 分区，消费者顺序处理；
3. **以 ES 文档整体覆盖为主**：消费端收到变更后反查 MySQL 最新数据再写 ES（读最新值），避免依赖消息体的中间状态；
4. **全量对账与重建**：定期用主键范围扫描对比 MySQL 与 ES，修复差异；平时保持**离线全量构建**能力（新索引 + 别名切换）；
5. **失败处理**：重试 + 死信队列 + 告警；ES 写入失败不要丢弃（429、版本冲突分别处理）。

## 常见线上问题

| 现象 | 常见原因与处理 |
| --- | --- |
| 集群 **red** | 有主分片未分配：`GET _cluster/allocation/explain` 看原因（磁盘水位 85%/90%/95%、节点离线、分配被禁用）|
| 集群 **yellow** | 副本未分配（单节点集群或节点不足），确认是否可接受 |
| 查询慢 | 开 `profile`、查慢日志；检查是否前导通配符、深分页、聚合高基数、大量分片（每个分片一个线程任务）|
| 429 / 写入拒绝 | `write` 线程池队列满：降低 bulk 并发、增大批大小、扩容 |
| 堆 OOM / 频繁 Full GC | fielddata 打开、聚合桶过多、分片过多、超大 `size` |
| 磁盘打满进入只读 | 触发 flood-stage 水位，索引被设为只读：清理数据后 `index.blocks.read_only_allow_delete: null` |
| 脑裂 | 7.x+ 使用新的选举与 `cluster.initial_master_nodes`，确保 **≥3 个主节点候选**且多数派存在 |

## 相关阅读

- [Elasticsearch 原理](#/mw/es)：Elasticsearch 原理
- [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)：日志平台：ELK 与 Loki 的取舍
- [CDC 与实时数仓架构](#/bigdata/cdc)：CDC 同步到 ES
- [虚拟内存、分页与内存管理](#/cs/os-memory)：堆与页缓存的内存分配
- [ES 集群运维：生命周期、故障排查与日志场景](#/mw/es-ops)：集群运维与日志场景

## 面试追问

> [!QUESTION] ES 的深分页问题是什么？怎么解决？
> `from+size` 需要每个分片取 from+size 条并在协调节点归并，成本随页数线性增长，默认限制 1 万。实时翻页用 `search_after` + PIT；导出全量用 `scroll` 或 `slice`；产品层面也要限制可翻页数。

> [!QUESTION] text 和 keyword 有什么区别？
> text 会分词、建倒排索引，用于全文检索，不适合聚合排序；keyword 不分词，整体作为一个 term，适合精确匹配、聚合、排序。常用 multi-fields 同时提供两种。

> [!QUESTION] MySQL 数据如何同步到 ES 并保证一致？
> 推荐 Canal/Debezium 订阅 binlog 写入 MQ，再由同步服务幂等写入 ES；用主键做 `_id`、外部版本号拒绝乱序旧数据；同一主键同分区保证有序；配合定期对账和可随时执行的全量重建。

> [!QUESTION] 如何做到修改 Mapping 不停机？
> 创建新索引并设置新 Mapping，用 `_reindex`（或同步服务双写）导入数据，最后通过别名原子切换，业务始终访问别名。

> [!QUESTION] 分片数怎么定？过多会怎样？
> 单分片 10~50GB 为宜，按数据总量和增长预估主分片数；分片过多会增大集群状态和内存开销、拖慢查询与恢复，每个节点分片数应受堆内存约束。
