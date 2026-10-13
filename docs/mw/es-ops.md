---
level: 深入
tags: [Elasticsearch, 运维, ILM, 冷热分层, 数据流, 集群状态, 分片分配, 断路器, 慢日志, 快照, 滚动升级, 日志场景]
summary: Elasticsearch 集群运维：节点角色与资源规划、冷热分层与索引生命周期（ILM、数据流、Rollover）、集群健康排查（红黄状态、Unassigned 分片、磁盘水位、线程池拒绝、断路器、GC）、慢查询与热点线程定位、快照备份与恢复、滚动升级、日志/可观测场景的架构与成本优化。
---

# ES 集群运维：生命周期、故障排查与日志场景

> [!ABSTRACT] 核心要点
> - 原理见 [Elasticsearch 原理](#/mw/es)，建模/查询/分片容量规划见 [ES 实战与数据同步](#/mw/es-practice)。本页回答“**集群怎么长期稳定跑、坏了怎么查、日志类大数据怎么控成本**”。
> - **运维的主线是三件事：生命周期（数据从热到冷到删）、容量水位（磁盘、堆、分片数）、可观测（健康、拒绝、慢请求）**。大多数事故来自**分片过多/过大、磁盘水位触发只读、堆内存与断路器、深分页与大聚合**。
> - **日志、指标、监控类**数据用**数据流 + ILM + 冷热分层**：按时间滚动索引（Rollover），热节点写入、温/冷节点存历史，到期删除或转快照，是**成本最关键的手段**；业务搜索数据则以稳定的别名与重建索引为主。
> - **“集群变红/黄”有固定的排查路径**：看 `_cluster/health` → `_cat/shards` 找出未分配分片 → `_cluster/allocation/explain` 看原因（磁盘水位、分配过滤、副本无处可放、分片损坏）。
> - **变更要像发布一样谨慎**：滚动重启暂停分片分配、先在预发验证、快照先行、先升级再改配置；索引模板与映射用代码管理。
> - **备份是 ES 的底线**：ES 不是主存储，但丢了需要重建成本很高；定期**快照**到对象存储并演练恢复。

## 节点角色与资源规划

<figure class="fig">
<svg viewBox="0 0 760 320" class="dg" role="img" aria-label="ES 集群节点角色与冷热分层：专用主节点负责集群元数据，协调节点负责请求分发和聚合，热节点用高性能磁盘承接写入与近期查询，温节点和冷节点存放历史数据并降低成本，冻结层使用可搜索快照放在对象存储；数据按生命周期依次迁移">
<rect class="b3" x="20" y="14" width="200" height="86" rx="10"/>
<text class="tb" x="120" y="34" text-anchor="middle" dominant-baseline="middle">专用主节点（3 个）</text>
<text class="ts" x="120" y="58" text-anchor="middle">集群状态·选主·分片分配</text>
<text class="ts" x="120" y="78" text-anchor="middle">不存数据，保证稳定</text>
<rect class="b5" x="240" y="14" width="200" height="86" rx="10"/>
<text class="tb" x="340" y="34" text-anchor="middle" dominant-baseline="middle">协调节点（可选）</text>
<text class="ts" x="340" y="58" text-anchor="middle">请求路由·结果聚合</text>
<text class="ts" x="340" y="78" text-anchor="middle">大聚合查询隔离业务节点</text>
<rect class="b4" x="460" y="14" width="280" height="86" rx="10"/>
<text class="tb" x="600" y="34" text-anchor="middle" dominant-baseline="middle">摄入节点 / 机器学习等（按需）</text>
<text class="ts" x="600" y="58" text-anchor="middle">预处理管道、异常检测等</text>
<text class="ts" x="600" y="78" text-anchor="middle">避免占用数据节点资源</text>
<rect class="b1" x="20" y="124" width="170" height="110" rx="10"/>
<text class="tb" x="105" y="144" text-anchor="middle" dominant-baseline="middle">热层 Hot</text>
<text class="ts" x="105" y="168" text-anchor="middle">SSD/NVMe·高 CPU</text>
<text class="ts" x="105" y="188" text-anchor="middle">写入 + 近期高频查询</text>
<text class="ts" x="105" y="208" text-anchor="middle">副本 1，段合并</text>
<rect class="b2" x="210" y="124" width="170" height="110" rx="10"/>
<text class="tb" x="295" y="144" text-anchor="middle" dominant-baseline="middle">温层 Warm</text>
<text class="ts" x="295" y="168" text-anchor="middle">大容量盘·较低配置</text>
<text class="ts" x="295" y="188" text-anchor="middle">只读，强制合并</text>
<text class="ts" x="295" y="208" text-anchor="middle">收缩分片·降副本</text>
<rect class="b3" x="400" y="124" width="170" height="110" rx="10"/>
<text class="tb" x="485" y="144" text-anchor="middle" dominant-baseline="middle">冷层 Cold</text>
<text class="ts" x="485" y="168" text-anchor="middle">更便宜的存储</text>
<text class="ts" x="485" y="188" text-anchor="middle">很少查询</text>
<text class="ts" x="485" y="208" text-anchor="middle">可搜索快照可减副本</text>
<rect class="b5" x="590" y="124" width="150" height="110" rx="10"/>
<text class="tb" x="665" y="144" text-anchor="middle" dominant-baseline="middle">冻结 / 删除</text>
<text class="ts" x="665" y="168" text-anchor="middle">对象存储快照</text>
<text class="ts" x="665" y="188" text-anchor="middle">按需挂载查询</text>
<text class="ts" x="665" y="208" text-anchor="middle">到期删除</text>
<line class="l" x1="190" y1="179" x2="210" y2="179" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="179" x2="400" y2="179" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="179" x2="590" y2="179" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="252" width="720" height="58" rx="8"/>
<text class="ts" x="380" y="274" text-anchor="middle">按数据年龄由 ILM 自动迁移，写入集中在热层，历史数据成本逐级下降；具体层名称与功能（如冻结层、可搜索快照）受版本与许可证影响</text>
<text class="ts" x="380" y="294" text-anchor="middle">小集群可以不拆专用角色，但主节点与数据节点混部时，大查询/GC 可能拖垮选主，规模上来后应拆分</text>
</svg>
<figcaption>图 1：节点角色与冷热分层</figcaption>
</figure>

### 资源规划要点

| 资源 | 经验与注意 |
| --- | --- |
| **堆内存** | 设为物理内存的**约一半，且不超过约 30GB**（超过会失去压缩指针优势）；其余留给**操作系统文件缓存**（Lucene 段文件依赖它）；不要关闭 swap 之外的内存争用，**禁用 swap**（或锁内存）避免 GC 与换页叠加 |
| **磁盘** | SSD 对写入与随机读友好；单节点磁盘使用率保持在**水位线以下**（默认高水位约 85%、洪水位约 95%，以所用版本为准）；规划容量 = 原始数据 × (1 + 副本数) × 膨胀系数（索引+_source，常 1.1~1.5，取决于映射） |
| **CPU** | 写入与聚合吃 CPU；热节点多核；线程池大小默认按核数 |
| **网络** | 分片恢复与重平衡占带宽；节点间低延迟；跨可用区部署要考虑副本同步成本与分片分配感知（allocation awareness） |
| **分片数** | 分片是**资源单位**：每个分片占堆内存、文件句柄与线程；**避免海量小分片**（常见：每个分片 10~50GB 为宜，日志场景单分片更大；每 GB 堆承载的分片数有上限量级），经验值请以压测为准，见 [ES 实战与数据同步](#/mw/es-practice) 的分片规划 |
| **主节点** | 3 个专用主节点（奇数）；磁盘需求小，但要稳定、低延迟；集群状态大（索引/分片多）时主节点内存需足够 |
| **JVM/GC** | 现代版本默认 G1；监控 GC 暂停与老年代使用；长时间 Full GC 会让节点被踢出集群 |

## 索引生命周期：数据流、Rollover 与 ILM

时间序列数据（日志、指标、事件）**只追加、按时间查询、过期删除**，适合**按时间切分索引**，而不是一个无限增长的大索引。

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="数据流与 ILM：写入始终指向当前写索引，达到大小、文档数或时间条件后 Rollover 创建新的后备索引；ILM 按阶段处理旧索引：热阶段滚动，温阶段缩分片和强制合并，冷阶段迁移节点或可搜索快照，删除阶段到期删除；索引模板定义映射和设置">
<rect class="b3" x="20" y="30" width="150" height="70" rx="8"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">写入</text>
<text class="ts" x="95" y="72" text-anchor="middle">指向数据流名称</text>
<text class="ts" x="95" y="88" text-anchor="middle">logs-app-prod</text>
<rect class="b1" x="200" y="14" width="240" height="102" rx="8"/>
<text class="th" x="320" y="32" text-anchor="middle">后备索引（自动管理）</text>
<rect class="b2" x="214" y="42" width="64" height="30" rx="6"/>
<text class="ts" x="246" y="57" text-anchor="middle" dominant-baseline="middle">-000001</text>
<rect class="b2" x="286" y="42" width="64" height="30" rx="6"/>
<text class="ts" x="318" y="57" text-anchor="middle" dominant-baseline="middle">-000002</text>
<rect class="b4" x="358" y="42" width="72" height="30" rx="6"/>
<text class="ts" x="394" y="57" text-anchor="middle" dominant-baseline="middle">-000003 写</text>
<text class="ts" x="320" y="98" text-anchor="middle">只有最新一个接收写入，其余只读</text>
<rect class="bg" x="470" y="14" width="270" height="102" rx="8"/>
<text class="th" x="605" y="32" text-anchor="middle">Rollover 触发条件（任一满足）</text>
<text class="ts" x="605" y="56" text-anchor="middle">主分片大小达到上限（如 30~50GB）</text>
<text class="ts" x="605" y="76" text-anchor="middle">文档数 / 索引年龄达到上限</text>
<text class="ts" x="605" y="96" text-anchor="middle">保证分片大小均匀，避免巨型分片</text>
<line class="l" x1="170" y1="65" x2="200" y2="65" marker-end="url(#arr)"/>
<rect class="b" x="20" y="136" width="720" height="154" rx="8"/>
<text class="th" x="32" y="156">ILM 策略（按索引年龄推进阶段）</text>
<text class="ts" x="380" y="182" text-anchor="middle">Hot：持续写入 → 触发 Rollover；设置较高优先级恢复</text>
<text class="ts" x="380" y="204" text-anchor="middle">Warm：停止写入后，缩小分片数（shrink）、强制合并段（forcemerge）、降低副本、迁移到温节点</text>
<text class="ts" x="380" y="226" text-anchor="middle">Cold：迁移到冷节点，或转为可搜索快照（数据放对象存储，本地仅缓存）</text>
<text class="ts" x="380" y="248" text-anchor="middle">Delete：超过保留期（如 30/90 天）自动删除，释放磁盘与分片数量</text>
<text class="ts" x="380" y="272" text-anchor="middle">配套：索引模板（映射、分片数、副本、ILM 策略名）统一用代码/CI 管理，变更先在预发验证</text>
</svg>
<figcaption>图 2：数据流、Rollover 与 ILM 阶段</figcaption>
</figure>

要点：

- **数据流（Data Stream）**：为时间序列设计的抽象，写入入口是数据流名，背后是自动维护的一组后备索引；只允许追加（更新/删除需针对具体后备索引）；
- **Rollover 按“分片大小”而非仅按天**：流量波动时按天切会得到忽大忽小的分片；
- **索引模板**统一定义映射（关键字段类型、`dynamic` 策略）、分片/副本数、ILM 策略；映射爆炸（字段无限增长）要用 `dynamic: strict`/`false` 或字段数限制防止；
- **业务搜索索引（非时序）**用**别名**对外：重建索引（reindex）到新索引后原子切换别名，旧索引保留一段时间用于回滚；
- **ILM 注意**：策略变更对已有索引的影响、阶段推进依赖集群健康（红色时可能卡住）、ILM 出错状态要监控（`_ilm/explain`）；
- **删除用 ILM/按索引删除**，而不是 `delete_by_query` 大批量删除文档（产生大量删除标记、段合并压力大）。

## 集群健康与故障排查

### 状态含义

| 状态 | 含义 | 影响 |
| --- | --- | --- |
| **green** | 所有主分片与副本分片都已分配 | 正常 |
| **yellow** | 所有主分片可用，但**部分副本未分配** | 可读写，冗余度下降，节点再故障可能丢数据 |
| **red** | **有主分片未分配** | 对应索引部分数据不可用，写入这些分片会失败 |

### 排查路径

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="集群变红或变黄的排查路径：先看集群健康与节点数，再列出未分配分片，使用分配解释接口查原因；常见原因包括节点离线、磁盘水位触发、分配过滤或标签不匹配、副本数大于可用节点、分片数据损坏、达到每节点分片上限；对应处置包括恢复节点、清理磁盘、调整分配设置、降副本、从快照恢复">
<rect class="b3" x="20" y="20" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="42" text-anchor="middle" dominant-baseline="middle">① 集群健康</text>
<text class="ts" x="95" y="62" text-anchor="middle">状态·节点数·待处理任务</text>
<rect class="b5" x="190" y="20" width="150" height="56" rx="8"/>
<text class="tb" x="265" y="42" text-anchor="middle" dominant-baseline="middle">② 未分配分片</text>
<text class="ts" x="265" y="62" text-anchor="middle">_cat/shards 过滤</text>
<rect class="b1" x="360" y="20" width="160" height="56" rx="8"/>
<text class="tb" x="440" y="42" text-anchor="middle" dominant-baseline="middle">③ 分配解释</text>
<text class="ts" x="440" y="62" text-anchor="middle">allocation/explain</text>
<rect class="b2" x="540" y="20" width="200" height="56" rx="8"/>
<text class="tb" x="640" y="42" text-anchor="middle" dominant-baseline="middle">④ 对症处理</text>
<text class="ts" x="640" y="62" text-anchor="middle">修复根因，再让其自动重分配</text>
<line class="l" x1="170" y1="48" x2="190" y2="48" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="48" x2="360" y2="48" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="48" x2="540" y2="48" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="96" width="720" height="218" rx="8"/>
<text class="th" x="32" y="116">常见根因与处理</text>
<text class="ts" x="380" y="142" text-anchor="middle">节点离线（宕机、OOM、被踢出）→ 恢复节点；超时前集群会延迟分配（delayed allocation），避免短暂重启引发大量搬数据</text>
<text class="ts" x="380" y="166" text-anchor="middle">磁盘水位：超低水位不再分配，超高水位开始迁出，超洪水位索引置只读 → 清理/扩容后解除只读</text>
<text class="ts" x="380" y="190" text-anchor="middle">分配过滤/感知不满足：include/exclude/require 标签、机架感知、冷热 tier 偏好没有可用节点 → 修正设置或加节点</text>
<text class="ts" x="380" y="214" text-anchor="middle">副本数大于可放置节点数（同节点不放同分片的主与副本）→ 降低副本或增加节点</text>
<text class="ts" x="380" y="238" text-anchor="middle">达到每节点分片上限/重试次数耗尽 → 处理根因后触发 reroute（retry_failed）</text>
<text class="ts" x="380" y="262" text-anchor="middle">分片数据损坏/主分片所有副本丢失 → 优先从快照恢复；无快照才考虑接受丢数据的强制分配（极危险，最后手段）</text>
<text class="ts" x="380" y="288" text-anchor="middle">原则：先弄清原因再动手；不要在原因不明时反复 reroute 或删除索引；操作前先做快照</text>
<text class="ta" x="380" y="306" text-anchor="middle">重启/升级前后用 _cluster/health 与 _cat/recovery 观察分片恢复进度</text>
</svg>
<figcaption>图 3：集群变红/黄的排查路径与常见根因</figcaption>
</figure>

### 其他高频问题

| 现象 | 常见根因 | 排查与处理 |
| --- | --- | --- |
| **写入被拒绝（429 / rejected）** | 写线程池队列满：写入过猛、分片过少/热点、段合并慢、磁盘慢 | 看 `_cat/thread_pool` 的 rejected；客户端**批量+限速+退避重试**；扩容热节点；降低刷新频率（`refresh_interval`） |
| **查询变慢、超时** | 深分页、高基数聚合、通配符/正则查询、未命中缓存、分片过多、GC | 开启**慢日志**（search/index slowlog）；分析 `profile`；用 `search_after` 替代深分页；限制聚合大小；见 [ES 实战与数据同步](#/mw/es-practice) |
| **断路器触发（Circuit Breaker）** | 单个请求/聚合/字段数据占用堆过多 | 优化查询（减小 size、避免对 text 字段聚合、控制 terms 聚合基数）；检查 `fielddata`；不要简单调高断路器阈值 |
| **节点反复掉线** | 长时间 GC、堆压力、磁盘/网络抖动、内存被 OS 回收 | 看 GC 日志与堆使用；降低分片/聚合压力；检查 swap 与容器内存限制 |
| **CPU 打满** | 热点分片、重聚合、段合并、频繁刷新 | 用 **hot threads** 接口定位线程在做什么；优化查询/摄入 |
| **集群状态更新慢 / pending tasks 堆积** | 索引/分片/映射过多，主节点压力大 | 减少分片与索引数、控制动态映射字段数、拆分专用主节点并加内存 |
| **映射爆炸** | 动态字段无限增长（如把用户输入当字段名） | 关闭动态映射或用 flattened 类型，限制 `index.mapping.total_fields.limit` |
| **磁盘使用不均** | 分片大小不均、新节点刚加入 | 检查 shard 均衡与分配设置，必要时迁移；避免巨型分片 |
| **段数量过多 / 查询变慢** | 写入后大量小段，合并跟不上 | 调整刷新间隔与合并策略；对只读索引强制合并 |
| **版本冲突/更新慢** | 高频更新同文档（实质是删除+插入） | 业务合并更新、改用追加模型或外部去重 |

### 常用诊断接口（概念）

| 目的 | 接口/工具 |
| --- | --- |
| 集群整体 | `_cluster/health`、`_cluster/stats`、`_cluster/pending_tasks` |
| 节点与资源 | `_cat/nodes?v`、`_nodes/stats`（JVM、线程池、断路器、文件系统） |
| 分片与恢复 | `_cat/shards`、`_cat/recovery`、`_cluster/allocation/explain` |
| 线程池 | `_cat/thread_pool?v`（关注 rejected） |
| 热点线程 | `_nodes/hot_threads` |
| 慢请求 | 索引设置里的 slowlog 阈值 + 日志分析 |
| ILM | `_ilm/explain`、`_ilm/policy` |
| 监控 | 内置监控/采集器 + Prometheus 导出器，见 [指标监控](#/infra/obs-metrics) |

## 备份与恢复

| 要点 | 说明 |
| --- | --- |
| **快照仓库** | 注册对象存储（S3 兼容等）或共享文件系统作为仓库；快照是**增量**的（只存新增段） |
| **快照策略** | 用**快照生命周期管理（SLM）**定时创建、定期清理；关键索引更高频；保留策略明确 |
| **一致性** | 快照基于段，是集群状态+索引数据的**时间点**视图（不是严格事务一致）；若需要业务一致，要与数据源对账 |
| **恢复演练** | 备份不演练等于没有备份：定期把快照恢复到测试集群，校验数据与耗时（RTO） |
| **恢复细节** | 恢复时可重命名索引避免覆盖；恢复速度受限速设置影响；恢复后重建别名、校验映射 |
| **与源数据重建的取舍** | 如果数据源（MySQL/Kafka）完整，重建索引可能比快照更灵活；日志类数据则靠快照与保留策略；见 [ES 实战与数据同步](#/mw/es-practice) 的全量+增量同步 |
| **跨集群** | 跨集群复制（CCR，部分功能受许可证限制）做异地容灾；或双写+各自保留 |

## 滚动重启与升级

1. **阅读发行说明与迁移指南**：破坏性变更（映射、API、插件、JVM 版本要求）；先升级弃用检查提示的问题；
2. **先快照**，并在**预发**用相同数据量级演练；
3. **滚动升级流程**：暂停分片分配（`cluster.routing.allocation.enable: primaries`）→ 可选 `flush`/同步 → 停一个节点升级重启 → 等节点加入 → 恢复分片分配 → 等集群回到 green → 下一台；
4. **顺序**：一般先升级非主节点（数据节点、协调节点），最后升级当前主节点所在的节点；严格以官方对应版本的升级顺序为准；
5. **客户端兼容**：高低版本客户端与服务端的兼容规则（尤其 Java 客户端更换）；先升级服务端再升客户端（以官方说明为准）；
6. **重启时间窗口**：延迟分配超时设置要覆盖单节点重启时间，避免节点一离线就开始大规模搬数据；
7. **回滚**：多数版本升级**不可降级**（数据格式不向后兼容），回滚依赖快照恢复，因此快照必须先做。

配置变更（JVM 参数、线程池、水位线）同样滚动生效并观察；动态设置分为**持久（persistent）与临时（transient）**，推荐使用 persistent 并记录到配置库，避免“重启后失效”。

## 日志与可观测场景架构

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="日志场景架构：应用与主机日志由采集器收集，经 Kafka 缓冲削峰，由 Logstash 或摄入管道解析清洗，写入 ES 数据流并冷热分层，Kibana 查询展示，同时落到对象存储做长期归档；告警基于查询或指标规则触发">
<rect class="b3" x="20" y="40" width="110" height="70" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">应用/主机</text>
<text class="ts" x="75" y="84" text-anchor="middle">结构化日志</text>
<rect class="b5" x="150" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">采集器</text>
<text class="ts" x="200" y="84" text-anchor="middle">轻量·背压</text>
<rect class="b1" x="270" y="40" width="100" height="70" rx="8"/>
<text class="tb" x="320" y="62" text-anchor="middle" dominant-baseline="middle">Kafka</text>
<text class="ts" x="320" y="84" text-anchor="middle">削峰·解耦</text>
<rect class="b4" x="390" y="40" width="110" height="70" rx="8"/>
<text class="tb" x="445" y="62" text-anchor="middle" dominant-baseline="middle">解析清洗</text>
<text class="ts" x="445" y="84" text-anchor="middle">Logstash/管道</text>
<rect class="b2" x="520" y="40" width="120" height="70" rx="8"/>
<text class="tb" x="580" y="62" text-anchor="middle" dominant-baseline="middle">ES 数据流</text>
<text class="ts" x="580" y="84" text-anchor="middle">ILM 冷热分层</text>
<rect class="b3" x="660" y="40" width="80" height="70" rx="8"/>
<text class="tb" x="700" y="62" text-anchor="middle" dominant-baseline="middle">Kibana</text>
<text class="ts" x="700" y="84" text-anchor="middle">查询告警</text>
<line class="l" x1="130" y1="75" x2="150" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="250" y1="75" x2="270" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="75" x2="390" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="500" y1="75" x2="520" y2="75" marker-end="url(#arr)"/>
<line class="l" x1="640" y1="75" x2="660" y2="75" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="136" width="720" height="140" rx="8"/>
<text class="th" x="32" y="156">成本与稳定性要点</text>
<text class="ts" x="380" y="180" text-anchor="middle">Kafka 做缓冲：ES 故障或重启时日志不丢，摄入速率可控，避免日志洪峰直接冲击集群</text>
<text class="ts" x="380" y="202" text-anchor="middle">字段治理：统一日志格式、限制字段数与名称，禁止把变量当字段名；大文本字段不分词或不索引；必要时用 flattened</text>
<text class="ts" x="380" y="224" text-anchor="middle">降成本：压缩编码（best_compression）、减少副本、强制合并、冷热分层、可搜索快照、缩短热数据保留，长期归档放对象存储</text>
<text class="ts" x="380" y="246" text-anchor="middle">按需采样/分级：DEBUG 日志短保留或不入库，错误与审计日志长保留；高频健康检查日志在采集端过滤</text>
<text class="ts" x="380" y="268" text-anchor="middle">多租户隔离：按业务/环境分数据流与权限，防止一个业务的日志风暴拖垮整个集群</text>
</svg>
<figcaption>图 4：日志场景的采集、缓冲、存储与成本控制</figcaption>
</figure>

日志检索体系的整体设计见 [链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO](#/infra/obs-trace)。**ES 并不是所有日志场景的最优解**：纯日志、超大规模、低成本需求下，也存在基于对象存储的日志系统（如 Loki 一类）或列式分析库（如 ClickHouse）可作为替代，见 [ClickHouse 存储与执行](#/bigdata/ck-engine)，选型取决于全文检索需求、查询灵活度和成本。

## 安全与治理

| 方面 | 做法 |
| --- | --- |
| **访问控制** | 开启安全功能：TLS（节点间与 HTTP）、认证、基于角色的访问控制；**绝不要把无认证的 9200 暴露到公网**（历史上大量数据泄露事故的根源） |
| **字段/文档级安全** | 多租户日志按角色限制索引、字段与文档范围 |
| **审计** | 记录认证失败、权限变更、敏感操作 |
| **危险操作限制** | 禁止通配符删除索引（`action.destructive_requires_name: true`）；限制 `_all`、通配符查询的使用 |
| **敏感数据** | 入库前脱敏；设置保留期，满足合规的删除要求（见 [加密与密钥管理](#/security/crypto)） |
| **变更管理** | 索引模板、ILM 策略、角色用代码管理并走评审，不要靠人在控制台改 |
| **容量与成本看板** | 每个数据流的写入量、存储、保留期、成本归属，推动业务自行治理 |

## 运维检查清单

- [ ] 主节点是否 3 个且稳定，是否与重负载隔离？
- [ ] 堆设置是否不超过约 30GB，是否禁用 swap，是否留足文件缓存？
- [ ] 分片大小与数量是否合理，是否有海量小分片/巨型分片？
- [ ] 时序数据是否用数据流 + ILM，是否有 Rollover 与保留期？
- [ ] 磁盘水位是否有告警（早于高水位），是否有容量预测？
- [ ] 慢日志、线程池 rejected、断路器、GC、pending tasks 是否被监控并告警？
- [ ] 索引模板与映射是否受控，是否防止映射爆炸？
- [ ] 是否有定期快照与**恢复演练**？
- [ ] 滚动升级流程是否文档化并演练，是否先快照？
- [ ] 是否开启认证与 TLS，是否禁止公网暴露？

## 相关阅读

- [Elasticsearch 原理](#/mw/es)：倒排索引、分片、写入与段合并
- [ES 实战与数据同步](#/mw/es-practice)：映射、查询调优、分片规划与同步
- [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem)：日志与数据的管道
- [链路追踪、日志与告警](#/infra/obs-trace)：日志体系整体设计
- [案例：搜索系统设计详解](#/design/case-search)：业务搜索场景的完整设计

## 面试追问

> [!QUESTION] ES 集群 yellow 和 red 分别是什么？怎么排查？
> yellow 表示主分片都可用但有副本未分配，red 表示有主分片未分配。先看集群健康和节点数，用 `_cat/shards` 找出未分配分片，再用 allocation explain 查具体原因：节点离线、磁盘水位、分配过滤或标签不匹配、副本数超过可用节点、分片损坏等，修复根因后让其自动分配，必要时从快照恢复，原因不明时不要乱 reroute 或删索引。

> [!QUESTION] 日志类数据在 ES 里怎么设计才能控制成本？
> 用数据流加 ILM，按分片大小 Rollover，热节点承接写入与近期查询，温冷节点放历史数据并做缩分片、强制合并、降副本，冷数据可用可搜索快照放对象存储，到期自动删除；前面用 Kafka 缓冲，字段做治理防映射爆炸，用压缩编码与分级保留降低成本。

> [!QUESTION] 写入出现 429 拒绝怎么处理？
> 写线程池队列满，原因是写入过猛、分片过少或热点、段合并慢、磁盘慢。客户端用批量写入、限速和退避重试；服务端扩容热节点、增加分片并打散热点、调大刷新间隔、检查磁盘；通过 `_cat/thread_pool` 观察 rejected，而不是单纯调大队列掩盖问题。

> [!QUESTION] ES 的堆内存为什么建议不超过 30GB 左右、且只给一半物理内存？
> 堆超过约 32GB 会失去指针压缩，实际可用对象数反而下降且 GC 压力更大；另一半内存要留给操作系统文件缓存，Lucene 的段文件读取依赖它，缓存不足会导致磁盘读增加、查询变慢。同时应禁用 swap。

> [!QUESTION] 怎么做 ES 的滚动升级？
> 先读迁移指南并做快照，在预发演练；暂停分片分配，逐个节点停机升级重启，等待节点加入后恢复分配，待集群回到 green 再处理下一台，一般最后升级主节点；延迟分配超时要覆盖重启时间；多数版本不可降级，所以回滚依赖快照。

> [!QUESTION] ES 能当主存储吗？数据怎么保证不丢？
> 不建议作主存储：它是近实时搜索引擎，事务与一致性弱于数据库。数据应以 MySQL 等为事实来源，ES 作为可重建的索引；同时定期快照到对象存储并演练恢复，数据源完整时也可通过全量加增量同步重建索引，两种手段互补。
