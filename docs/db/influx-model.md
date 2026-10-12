---
level: 进阶
tags: [InfluxDB, 时序数据库, TSDB, Line Protocol, Tag, Field, Series, TSM, TSI, Retention, InfluxQL, Flux, SQL]
summary: InfluxDB 的数据模型与存储原理：时序数据的特点、measurement/tag/field/timestamp 与 series 的概念、Line Protocol 写入格式、v1/v2/v3 三代架构差异、TSM 引擎（WAL、Cache、TSM 文件、Compaction、TSI 索引）、分片与保留策略、InfluxQL/Flux/SQL 查询、tag 与 field 的取舍。
---

# InfluxDB 数据模型与存储引擎

> [!ABSTRACT] 核心要点
> - 时序数据的特点：**按时间追加写入、几乎不更新、按时间范围 + 维度（设备/主机）查询、冷热分明、需要降采样与过期**。InfluxDB 是专为此设计的时序数据库（TSDB）。
> - **数据模型**：`measurement`（类似表）+ `tag`（**带索引**的字符串维度）+ `field`（**不带索引**的数值/字符串等测量值）+ `timestamp`（纳秒精度）。**相同 measurement + tag 集合 = 一条 series（时间线）**，series 数量就是**基数（cardinality）**。
> - **tag 与 field 的选择是建模的核心**：要用来过滤/分组的低基数维度放 **tag**；数值型的测量值和高基数值放 **field**；**绝不能把 userId、requestId、URL 全路径这类高基数值当 tag**（v1/v2 下会造成基数爆炸）。
> - **三代架构**：v1/v2 基于 **TSM 引擎（LSM 思想）+ TSI 索引**；**v3（IOx）完全重写**：Rust + Apache Arrow/DataFusion + Parquet + 对象存储，**支持 SQL、缓解基数限制**，但**不再支持 Flux**。选型与升级要先确认版本。
> - 写入用 **Line Protocol + 批量 + 压缩**；保留策略（Retention）自动过期；降采样把高频原始数据汇总成低频长期数据。

> [!NOTE] 版本说明
> InfluxDB 1.x、2.x、3.x 在架构、查询语言和运维方式上差异很大，社区资料容易混用。本文标注各版本差异；具体功能、限制与默认值请以所用版本官方文档为准。实战与选型见 [InfluxDB 实战](#/db/influx-practice)。

## 一、时序数据的特点

| 特点 | 对存储的含义 |
| --- | --- |
| **写多读少、追加为主** | 顺序写（WAL + 批量刷盘）、LSM 类结构，见 [文件系统与页缓存](#/cs/os-io) |
| **几乎不更新/删除单点** | 不需要复杂的行级事务与随机更新；按时间块整体过期更高效 |
| **查询带时间范围与维度** | 数据按时间分片（shard），按 series 组织，便于只读相关块 |
| **冷热分明** | 近期数据高频读，历史数据降采样/压缩/归档 |
| **同一序列数值相近** | 时间戳增量编码、浮点 XOR/Gorilla 压缩、字典编码，压缩比可达数倍到十倍以上 |
| **数据量巨大** | 需要保留策略（TTL）、降采样、分层存储 |

典型场景：**基础设施与应用监控、IoT 传感器遥测、工业设备数据、金融行情/指标、业务埋点指标**（IoT 平台时序存储整体选型见 [IoT 平台架构](#/iot/platform)，监控体系见 [指标监控](#/infra/obs-metrics)）。

## 二、数据模型

### 1. 四个要素

```text
cpu,host=server01,region=cn-east usage_idle=92.5,usage_user=4.1 1760250000000000000
└┬┘ └────────────┬────────────┘ └─────────────┬───────────────┘ └──────────┬──────────┘
 measurement      tag set（索引，字符串）       field set（测量值，不索引）      timestamp（ns）
```

| 要素 | 说明 | 注意 |
| --- | --- | --- |
| **measurement** | 一类指标的名字，类似“表” | 如 `cpu`、`temperature`、`http_requests` |
| **tag** | **键值都是字符串、被索引**的元数据维度 | 用于过滤（`WHERE host='a'`）和分组（`GROUP BY region`）；**基数要低** |
| **field** | **实际的测量值**，类型：float、integer、unsigned、string、boolean | **不被索引**；按 field 过滤需要扫描；**同一 series 的同一 field 类型不能变** |
| **timestamp** | 默认纳秒精度的 Unix 时间 | 不提供则用服务端写入时间；**同 series + 同时间戳 的写入会覆盖/合并字段**（天然去重键） |

### 2. Series 与基数

**Series = measurement + 完整的 tag 集合**（每个唯一组合对应一条时间线）。

```text
cpu,host=a,region=east   → series 1
cpu,host=b,region=east   → series 2
cpu,host=a,region=west   → series 3        （tag 组合不同就是不同 series）
```

**基数 = 不同 series 的总数**。它决定了**索引内存占用与查询、写入的开销**：

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="基数计算：一个 measurement 的 series 数等于各 tag 取值数的乘积；例如主机 1000 个乘以接口 20 个乘以区域 5 个等于 10 万条 series；若把请求 ID 之类高基数值当作 tag，series 数会无限增长，导致索引膨胀、内存暴涨和写入变慢，应改为 field 或不入库">
<rect class="b3" x="20" y="30" width="360" height="110" rx="12"/>
<text class="th" x="36" y="54">基数 ≈ 各 tag 取值数的乘积（上限）</text>
<text class="ts" x="36" y="78">host（1000）× interface（20）× region（5）</text>
<text class="ts" x="36" y="98">= 100,000 条 series（可接受）</text>
<text class="ts" x="36" y="122">实际基数取决于真实出现过的组合，不一定达到乘积</text>
<rect class="b4" x="410" y="30" width="370" height="110" rx="12"/>
<text class="th" x="426" y="54">✗ 高基数 tag：基数爆炸</text>
<text class="ts" x="426" y="78">把 user_id / request_id / trace_id / 完整 URL / 时间戳</text>
<text class="ts" x="426" y="98">当作 tag → series 数随业务量无限增长</text>
<text class="ts" x="426" y="122">索引内存暴涨、写入与查询变慢，甚至 OOM</text>
<rect class="bg" x="20" y="160" width="760" height="106" rx="10"/>
<text class="th" x="36" y="184">经验</text>
<text class="ts" x="36" y="206">• tag：有限且稳定的维度（主机、区域、设备型号、状态码分类、服务名）；field：数值与高变化的值（温度、延迟、请求 ID 如需保留）</text>
<text class="ts" x="36" y="226">• 单 measurement 与整库的 series 数要预估与监控；超过版本推荐范围就要重新建模，或选用 v3（基数限制大幅放宽）</text>
<text class="ts" x="36" y="246">• 与 Prometheus 同样：标签基数是时序系统最大的杀手（见 指标监控 的“基数爆炸”）</text>
</svg>
<figcaption>图 1：series 基数与高基数 tag 的危害</figcaption>
</figure>

### 3. Tag 还是 Field

| 问题 | 放 tag | 放 field |
| --- | --- | --- |
| 要用来 `WHERE` 过滤或 `GROUP BY` 吗？ | ✅ | ❌（可过滤但要扫描，且不能 GROUP BY） |
| 取值是**有限的类别**吗？ | ✅ | |
| 取值是**连续数值**（温度、延迟）？ | | ✅ |
| 取值**无界/高基数**（ID、URL）？ | ❌ **不要** | ✅（或不入库） |
| 需要做聚合计算（均值、最大值）？ | | ✅（tag 是字符串，不能数值聚合） |
| 存储成本 | tag 值要建索引，开销更大 | field 更省 |

经验口诀：**“能分组的放 tag，能计算的放 field”**。

### 4. 命名与建模建议

- measurement 名简洁稳定，**不要把维度编码进名字**（如 `cpu_server01`）——维度用 tag；
- 一次采集的多个相关指标可放**同一条记录的多个 field**（同一时间戳、同一 tag 集合），节省空间与写入量（宽表）；
- tag key/field key 命名统一（小写下划线），避免随意新增 key 导致模式膨胀；
- **同一 field 的类型要稳定**：第一次写入决定类型，之后写入不同类型会失败（`field type conflict`）；
- 时间戳精度要匹配采集（毫秒/秒），写入时指定 `precision` 减少存储与处理开销。

## 三、Line Protocol

写入的文本格式（HTTP 写入端点、客户端、Telegraf 都用它）：

```text
<measurement>[,<tag_key>=<tag_value>...] <field_key>=<field_value>[,<field_key2>=<field_value2>...] [<timestamp>]

temperature,device=d-1001,model=th20 value=23.5,humidity=61i 1760250000000000000
http_requests,service=order,code_class=2xx count=152i,latency_ms=12.3 1760250001000000000
```

| 规则 | 说明 |
| --- | --- |
| 字符串 field 加双引号：`msg="ok"`；整数加后缀 `i`：`61i`；无后缀默认 float | 类型写错会产生类型冲突 |
| tag 值不加引号；含空格/逗号/等号要转义 | 注意转义，否则解析错误 |
| 一行一个点，批量写入用换行分隔 | 推荐批量 |
| 时间戳省略则用服务端当前时间 | 需要幂等/去重时**显式提供** |

**幂等与去重**：同一 series、同一时间戳重复写入会**覆盖同名 field**（合并语义取决于版本）。设备重传数据时依赖这一点天然去重，但要保证**时间戳取自采集时间而不是写入时间**。

## 四、版本与架构演进

| | **v1.x** | **v2.x** | **v3.x（IOx）** |
| --- | --- | --- | --- |
| 存储引擎 | TSM + TSI | TSM + TSI（沿用） | **Apache Arrow + Parquet + 对象存储**，Rust 重写 |
| 组织方式 | database + retention policy | **organization + bucket**（bucket = database + RP） | database / table |
| 查询语言 | **InfluxQL**（类 SQL） | **Flux**（函数式脚本）+ InfluxQL 兼容 | **SQL（DataFusion）+ InfluxQL**，**不支持 Flux** |
| 基数 | series 基数是关键限制 | 同上 | **基数限制大幅放宽**（列存 + 不依赖倒排索引常驻内存） |
| 内置能力 | Continuous Query、Kapacitor 告警 | 内置 UI、Tasks、Tokens 鉴权、Checks/Notifications | 数据与计算分离、对象存储、嵌入式处理引擎（版本相关） |
| 部署形态 | 单机开源 / 企业版集群 | 单机开源 / 云版 | Core（开源）、Enterprise、Cloud（Serverless/Dedicated/Clustered） |
| 典型客户端 | influxdb-java（v1） | influxdb-client-java（v2 API） | influxdb3-java（Flight SQL） |

选型提示：**新项目先确认官方当前推荐版本与许可/形态**；已有大量 v1/v2 与 Flux 脚本的系统，迁移到 v3 需要重写查询与任务；从监控角度也可与 Prometheus 体系对比选择（见 [InfluxDB 实战：选型](#/db/influx-practice)）。本文后续的**存储引擎细节以 v1/v2 的 TSM 为主**（最广泛的资料基础），v3 单独说明。

## 五、TSM 存储引擎（v1/v2）

**TSM（Time-Structured Merge Tree）** 是 InfluxDB 为时序数据定制的 LSM 类引擎：写入先进内存与 WAL，再批量刷成不可变的列式文件，后台合并。

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="TSM 写入与读取路径：写请求同时追加到 WAL 预写日志并写入内存 Cache；Cache 达到阈值后快照刷成不可变的 TSM 文件，按 series 与时间块列式存储并压缩；后台 compaction 合并小文件并优化压缩；TSI 索引记录 measurement、tag 到 series 的映射，用于快速定位 series；查询先用索引找到 series，再读取对应时间范围的 TSM 块，并合并内存 Cache 中的最新数据">
<rect class="b1" x="20" y="30" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="55" text-anchor="middle" dominant-baseline="middle">写入（批量）</text>
<rect class="b5" x="190" y="20" width="150" height="34" rx="6"/>
<text class="tb" x="265" y="37" text-anchor="middle" dominant-baseline="middle">WAL（顺序追加）</text>
<rect class="b3" x="190" y="64" width="150" height="34" rx="6"/>
<text class="tb" x="265" y="81" text-anchor="middle" dominant-baseline="middle">Cache（内存）</text>
<line class="l" x1="130" y1="48" x2="190" y2="37" marker-end="url(#arr)"/>
<line class="l" x1="130" y1="62" x2="190" y2="81" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="40" width="170" height="60" rx="10"/>
<text class="tb" x="485" y="62" text-anchor="middle" dominant-baseline="middle">TSM 文件（不可变）</text>
<text class="ts" x="485" y="82" text-anchor="middle">列式 · 按 series 与时间块</text>
<line class="l" x1="340" y1="81" x2="400" y2="70" marker-end="url(#arr)"/>
<text class="ts" x="344" y="108" text-anchor="start">Cache 达阈值/定时 → 快照落盘</text>
<rect class="b4" x="630" y="40" width="150" height="60" rx="10"/>
<text class="tb" x="705" y="62" text-anchor="middle" dominant-baseline="middle">Compaction</text>
<text class="ts" x="705" y="82" text-anchor="middle">合并 · 去重 · 重压缩</text>
<line class="l" x1="570" y1="70" x2="630" y2="70" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="150" width="170" height="56" rx="8"/>
<text class="tb" x="485" y="172" text-anchor="middle" dominant-baseline="middle">TSI 索引</text>
<text class="ts" x="485" y="192" text-anchor="middle">tag → series ID（磁盘 + mmap）</text>
<rect class="bg" x="20" y="130" width="360" height="96" rx="10"/>
<text class="th" x="36" y="154">读取路径</text>
<text class="ts" x="36" y="176">① 用 TSI 按 measurement/tag 找到相关 series</text>
<text class="ts" x="36" y="196">② 按时间范围定位 shard 与 TSM 块，解压读取</text>
<text class="ts" x="36" y="216">③ 合并 Cache 中尚未落盘的最新点</text>
<rect class="bg" x="20" y="246" width="760" height="82" rx="10"/>
<text class="ts" x="36" y="270">• 压缩：时间戳用增量+RLE/simple8b；浮点用类似 Gorilla 的 XOR；整数/布尔/字符串各有编码，再叠加 snappy 等；常见压缩比数倍至十倍以上</text>
<text class="ts" x="36" y="290">• 崩溃恢复：重放 WAL 重建 Cache；TSM 文件不可变，写入安全，删除通过墓碑标记再由 compaction 清理</text>
<text class="ts" x="36" y="310">• 乱序/历史补写：写入旧时间戳会进入对应旧 shard，可能触发旧数据 compaction，需避免大批量回填影响线上</text>
<text class="ts" x="36" y="324">• 与 LSM-Tree、WAL 的通用原理对比见 文件系统与页缓存、MySQL redo/binlog</text>
</svg>
<figcaption>图 2：TSM 引擎：WAL + Cache + TSM 文件 + Compaction + TSI 索引</figcaption>
</figure>

### 1. 分片（Shard）与保留策略

数据按**时间切成 shard group**，每个 shard 是独立的存储单元（包含自己的 WAL、Cache、TSM 文件与索引）：

- **shard 时长**（shard group duration）由保留时长自动推导（保留期越长 shard 越大，如 7 天保留 → 1 天 shard，更长 → 7 天或更长），也可手工设置；
- **过期删除（Retention）**：到期的 **shard 整体删除**（O(1) 的文件删除，而不是逐点 DELETE）——这是时序库管理数据生命周期的高效手段；
- 查询只触及时间范围覆盖的 shard，天然实现**时间剪枝**；
- **选择合适的保留时长与 shard 大小**：shard 过小 → 文件与索引碎片多；过大 → 删除粒度粗、热点 shard 过大。

```sql
-- v1：保留策略
CREATE DATABASE metrics WITH DURATION 30d REPLICATION 1 SHARD DURATION 1d NAME rp_30d
-- v2：创建 bucket 时设置保留期（influx CLI）：influx bucket create -n metrics -r 30d
```

### 2. 内存与索引

- TSI（Time Series Index）把 series 索引放到**磁盘 + mmap**，缓解 v1 早期“全内存索引”造成的内存问题，但**series 基数仍然直接影响索引大小、写入和查询延迟**；
- 配置与容量规划要看：**series 数、写入点/秒、查询并发、保留期、压缩比、磁盘 IOPS**；SSD 强烈推荐。

## 六、v3 架构（IOx）要点

v3 把存储从自研 TSM 转向开放的列式生态：

- **Rust + Apache Arrow（内存列式）+ DataFusion（SQL 引擎）+ Parquet（持久化列式文件）**；
- 数据落到**对象存储**（S3/GCS/本地），计算与存储可分离，成本更低，历史数据可被其他引擎（Spark、DuckDB、ClickHouse 等）直接读取 Parquet；
- **基数限制显著放宽**：列式存储下 tag 只是普通列，不需要把全部 series 的倒排索引放内存，**适合高基数场景**（如按设备 ID、用户 ID 分析）；
- 查询用 **SQL 与 InfluxQL**，通过 **Flight SQL（gRPC）** 返回 Arrow 数据，与数据分析生态互通；
- **不支持 Flux**；v2 的 Tasks、Checks 等部分能力形态不同；
- 形态：开源 Core（近期数据，面向轻量/边缘）、企业版（集群、压缩、长期历史等）、云上 Serverless/Dedicated/Clustered。

> [!WARNING] 迁移成本
> 从 v1/v2 升级到 v3 不是简单“升级包”：写入协议（Line Protocol）基本延续，**但查询语言、客户端、任务/告警、运维体系都需要重新验证**。已有 Flux 脚本要重写。

## 七、查询语言

### 1. InfluxQL（v1/v2 兼容、v3 仍支持）

```sql
-- 最近 1 小时，每 5 分钟平均 CPU 空闲，按主机分组
SELECT MEAN("usage_idle") FROM "cpu"
 WHERE time > now() - 1h AND "region" = 'cn-east'
 GROUP BY time(5m), "host" fill(null)

-- 最新值
SELECT LAST("value") FROM "temperature" WHERE "device" = 'd-1001'
-- 查看 series 基数（排查基数问题）
SHOW SERIES CARDINALITY ON metrics
```

### 2. Flux（v2 的函数式查询）

```flux
from(bucket: "metrics")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "cpu" and r._field == "usage_idle" and r.region == "cn-east")
  |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
  |> group(columns: ["host"])
```

Flux 灵活（可做 join、变换、调用外部数据源）但**学习曲线陡、性能与可维护性取决于写法**；官方对其后续演进重心已转向 SQL/InfluxQL（v3），新项目要谨慎评估。

### 3. SQL（v3）

```sql
SELECT date_bin(INTERVAL '5 minutes', time) AS bucket, host, AVG(usage_idle) AS idle
FROM cpu
WHERE time >= now() - INTERVAL '1 hour' AND region = 'cn-east'
GROUP BY bucket, host
ORDER BY bucket;
```

**所有语言的共同要点**：**必须带时间范围**（否则全表扫描）；先用 tag 缩小范围；聚合用窗口（`GROUP BY time()` / `aggregateWindow` / `date_bin`）；最新值查询要谨慎，**海量 series 时 `LAST` 很慢**（见实战页的最新值方案）。

## 八、常见概念对照

| InfluxDB | 关系库 / 其他 |
| --- | --- |
| measurement | 表 |
| tag | 带索引的维度列（字符串） |
| field | 普通指标列 |
| series | 一组维度取值对应的时间线 |
| shard / retention | 按时间分区 + 自动过期 |
| bucket（v2） | 数据库 + 保留策略 |
| Telegraf | 采集代理（插件体系，输出到 Influx/Kafka 等） |
| Continuous Query / Task | 定时降采样与预聚合 |

## 面试追问

> [!QUESTION] InfluxDB 的数据模型是什么？tag 和 field 有什么区别？
> 由 measurement、tag、field 和纳秒时间戳组成。tag 是带索引的字符串维度，用于过滤和分组，基数要低；field 是不带索引的测量值，可以是数值、字符串或布尔，用于聚合计算。相同 measurement 加相同 tag 集合构成一条 series，口诀是能分组的放 tag，能计算的放 field。

> [!QUESTION] 什么是 series 基数？为什么高基数是问题？
> 基数是不同 series 的总数，是各 tag 取值组合的数量。每个 series 都要在索引中维护，高基数会让索引膨胀、内存占用上升、写入和查询变慢甚至 OOM。把用户 ID、请求 ID、完整 URL 当 tag 是典型错误，应改放 field 或不入库，或选用对高基数友好的 v3。

> [!QUESTION] TSM 引擎的写入和读取流程？
> 写入先追加到 WAL 并写入内存 Cache，Cache 达到阈值后快照成不可变的列式压缩 TSM 文件，后台 compaction 合并优化。读取时用 TSI 索引按 tag 定位 series，再按时间范围读取对应 shard 的 TSM 块并合并 Cache 里的最新数据。崩溃后通过重放 WAL 恢复。

> [!QUESTION] 保留策略和 shard 是怎么配合实现过期的？
> 数据按时间切成 shard，保留期到后整个过期 shard 直接删除文件，是 O(1) 操作，比逐点 DELETE 高效得多，查询也只访问覆盖时间范围的 shard 实现时间剪枝。shard 时长要与保留期匹配，太小碎片多，太大删除粒度粗。

> [!QUESTION] InfluxDB v1、v2、v3 的主要区别？
> v1 使用 TSM 引擎与 InfluxQL，按数据库加保留策略组织；v2 沿用 TSM，引入组织与 bucket、Flux、内置 UI、任务与令牌；v3 用 Rust、Arrow、DataFusion 和 Parquet 重写，数据放对象存储，支持 SQL 与 InfluxQL，放宽基数限制但不再支持 Flux。升级需要重写查询和任务并验证客户端。

> [!QUESTION] 写入重复或补传的数据会怎样？
> 同一 series 同一时间戳的写入会覆盖同名 field，所以设备重传天然去重，前提是时间戳取自采集时间而不是写入时间；另外 field 类型一旦确定，之后写入不同类型会报类型冲突。
