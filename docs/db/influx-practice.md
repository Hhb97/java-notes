---
level: 高级
tags: [InfluxDB, 时序数据库, Telegraf, 降采样, 基数, Java, 批量写入, 选型, TimescaleDB, TDengine, Prometheus]
summary: InfluxDB 落地实战：整体链路（Telegraf/Kafka → Influx → Grafana）、Java 批量写入与查询（influxdb-client-java）、写入调优（批量、压缩、乱序、背压）、降采样与长期保留（Tasks / Continuous Query）、基数排查与治理、最新值与删除、备份高可用与监控，以及与 Prometheus、TimescaleDB、TDengine、ClickHouse 的选型对比。
---

# InfluxDB 实战：基数、降采样、Java 写入与选型

> [!ABSTRACT] 核心要点
> - 典型链路：**采集（Telegraf / 设备 / 应用）→（可选 Kafka 缓冲）→ InfluxDB → Grafana 展示与告警**。写入侧的关键是**批量 + 压缩 + 背压 + 幂等**，不要一点一写。
> - **降采样（Downsampling）+ 分级保留**是控制成本的核心：原始高频数据保留几天到几周，分钟/小时聚合保留数月到数年，由 **Tasks（v2）/ Continuous Query（v1）/ 外部作业**自动完成。
> - **基数治理**是 InfluxDB（v1/v2）运维的第一课：先规划 tag，上线后监控 `series cardinality`，发现暴涨立刻定位是哪个 tag 引入。
> - **“最新一条”与“明细大查询”是时序库的弱项**：最新值放 Redis/设备影子/专用表；大范围分析下沉到 OLAP。
> - 选型不要神话专用 TSDB：**监控指标用 Prometheus 体系、需要 SQL+关系联查用 TimescaleDB、超大规模 IoT 用 TDengine/IoTDB、重分析用 ClickHouse**；InfluxDB 的优势是**生态成熟（Telegraf 采集 + Grafana）、写入与时间窗口聚合便利**。

> [!NOTE] 版本说明
> 示例以 v2（`bucket/org/token`）与 Java 客户端为主，v1/v3 的差异处会指出。请以所用版本的官方文档为准。数据模型与存储原理见 [InfluxDB 数据模型](#/db/influx-model)。

## 一、整体架构与采集

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="InfluxDB 典型链路：设备和主机通过 Telegraf 或 MQTT 或应用埋点采集数据，经 Kafka 缓冲削峰，由消费者批量写入 InfluxDB；InfluxDB 内部有原始数据桶和降采样后的长期桶；Grafana 查询展示并告警；最新值同时写入 Redis；明细按需归档到对象存储或数仓">
<rect class="b1" x="20" y="30" width="150" height="40" rx="8"/>
<text class="tb" x="95" y="50" text-anchor="middle" dominant-baseline="middle">主机 / 容器（Telegraf）</text>
<rect class="b1" x="20" y="84" width="150" height="40" rx="8"/>
<text class="tb" x="95" y="104" text-anchor="middle" dominant-baseline="middle">IoT 设备（MQTT）</text>
<rect class="b1" x="20" y="138" width="150" height="40" rx="8"/>
<text class="tb" x="95" y="158" text-anchor="middle" dominant-baseline="middle">应用埋点（客户端）</text>
<rect class="b5" x="220" y="70" width="130" height="70" rx="10"/>
<text class="tb" x="285" y="94" text-anchor="middle" dominant-baseline="middle">Kafka（可选）</text>
<text class="ts" x="285" y="116" text-anchor="middle">削峰 · 解耦 · 重放</text>
<line class="l" x1="170" y1="50" x2="220" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="104" x2="220" y2="104" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="158" x2="220" y2="124" marker-end="url(#arr)"/>
<rect class="b3" x="390" y="70" width="110" height="70" rx="10"/>
<text class="tb" x="445" y="94" text-anchor="middle" dominant-baseline="middle">写入消费者</text>
<text class="ts" x="445" y="116" text-anchor="middle">批量 · 重试</text>
<line class="l" x1="350" y1="105" x2="390" y2="105" marker-end="url(#arr)"/>
<rect class="b2" x="540" y="20" width="240" height="150" rx="12"/>
<text class="th" x="556" y="44">InfluxDB</text>
<rect class="b" x="556" y="56" width="208" height="40" rx="6"/>
<text class="ts" x="660" y="72" text-anchor="middle" dominant-baseline="middle">bucket raw（保留 14 天）</text>
<text class="ts" x="660" y="88" text-anchor="middle" dominant-baseline="middle">高频原始数据</text>
<rect class="b" x="556" y="104" width="208" height="52" rx="6"/>
<text class="ts" x="660" y="122" text-anchor="middle" dominant-baseline="middle">bucket 1h / 1d（保留 1~3 年）</text>
<text class="ts" x="660" y="140" text-anchor="middle" dominant-baseline="middle">降采样后的长期数据</text>
<line class="l" x1="500" y1="105" x2="540" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="660" y1="96" x2="660" y2="104" marker-end="url(#arr)"/>
<rect class="b4" x="540" y="200" width="110" height="50" rx="8"/>
<text class="tb" x="595" y="225" text-anchor="middle" dominant-baseline="middle">Grafana</text>
<rect class="b5" x="670" y="200" width="110" height="50" rx="8"/>
<text class="tb" x="725" y="218" text-anchor="middle" dominant-baseline="middle">Redis 最新值</text>
<text class="ts" x="725" y="238" text-anchor="middle">/ 设备影子</text>
<line class="l" x1="640" y1="170" x2="610" y2="200" marker-end="url(#arr)"/>
<line class="l" x1="445" y1="140" x2="725" y2="200" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="270" width="760" height="48" rx="10"/>
<text class="ts" x="36" y="292">• 明细长期归档：导出到对象存储/数仓（Parquet），分析走 ClickHouse/Doris；告警可由 Grafana 或 Influx Checks 触发</text>
<text class="ts" x="36" y="310">• IoT 场景：设备 → MQTT Broker → 规则/消费者 → 入库（见 IoT 平台与 MQTT 笔记）</text>
</svg>
<figcaption>图 1：InfluxDB 典型数据链路</figcaption>
</figure>

### Telegraf：采集代理

**Telegraf** 是 InfluxData 的插件化采集器，输入插件几百种（system、docker、mysql、redis、kafka、snmp、MQTT 消费、Prometheus 抓取…），输出到 InfluxDB/Kafka 等：

```toml
[agent]
  interval = "10s"
  flush_interval = "10s"
  metric_batch_size = 5000            # 批量写
  metric_buffer_limit = 100000        # 缓冲，输出端不可用时暂存（有上限，超出会丢）

[[inputs.cpu]]
  percpu = false
  totalcpu = true
[[inputs.mem]]
[[inputs.docker]]
  endpoint = "unix:///var/run/docker.sock"

[[outputs.influxdb_v2]]
  urls = ["http://influxdb:8086"]
  token = "${INFLUX_TOKEN}"          # 令牌用环境变量/密钥管理，不要写进配置文件
  organization = "ops"
  bucket = "raw"
```

## 二、Java 写入与查询

### 1. 依赖与批量写入

```xml
<dependency>
  <groupId>com.influxdb</groupId>
  <artifactId>influxdb-client-java</artifactId>      <!-- v2 API；v3 使用 influxdb3-java -->
  <version>${influx.client.version}</version>
</dependency>
```

```java
@Configuration
public class InfluxConfig {
    @Bean(destroyMethod = "close")
    InfluxDBClient influxClient(@Value("${influx.url}") String url, @Value("${influx.token}") String token,
                                @Value("${influx.org}") String org, @Value("${influx.bucket}") String bucket) {
        return InfluxDBClientFactory.create(url, token.toCharArray(), org, bucket);    // 全局单例，线程安全
    }
    @Bean(destroyMethod = "close")
    WriteApi writeApi(InfluxDBClient client) {
        WriteApi api = client.makeWriteApi(WriteOptions.builder()
                .batchSize(5000)              // 每批点数（官方建议数千量级）
                .flushInterval(1000)          // 最长攒批时间（ms）
                .bufferLimit(100_000)         // 内存缓冲上限，防止 OOM
                .jitterInterval(500)          // 抖动，避免多实例同时 flush
                .retryInterval(5000).maxRetries(5).maxRetryDelay(30_000).exponentialBase(2)
                .build());
        api.listenEvents(WriteErrorEvent.class, e -> log.error("influx write failed", e.getThrowable()));   // 必须监听错误
        return api;
    }
}

@Service
public class TelemetryWriter {
    private final WriteApi writeApi;
    public void write(String deviceId, String model, double temp, long humidity, Instant collectedAt) {
        Point p = Point.measurement("telemetry")
                .addTag("device_type", model)                 // 低基数维度：tag
                .addTag("region", "cn-east")
                .addField("temperature", temp)                // 数值：field
                .addField("humidity", humidity)
                .addField("device_id", deviceId)              // 高基数标识：放 field（若需按设备查询，评估 v3 或另建模）
                .time(collectedAt, WritePrecision.MS);        // 使用采集时间，保证重传幂等
        writeApi.writePoint(p);                               // 异步入缓冲，由后台线程批量发送
    }
}
```

> [!WARNING] 设备 ID 要不要做 tag？
> 如果设备数不大（几千~几十万）且**经常按设备查询**，把 `device_id` 作 tag 是合理的（基数 = 设备数 × 其他 tag 组合）；**设备数到千万级时**就会触发基数问题，应改用对高基数友好的方案（v3、TDengine 超级表/子表、ClickHouse 等）。要点是**先算基数再决定**，而不是教条化。

也可用 POJO 注解映射：

```java
@Measurement(name = "temperature")
public class TemperaturePoint {
    @Column(tag = true) String deviceType;
    @Column String value;                      // 或 Double
    @Column(timestamp = true) Instant time;
}
writeApi.writeMeasurement(WritePrecision.MS, point);
```

### 2. 查询（Flux 示例）

```java
String flux = """
    from(bucket: "raw")
      |> range(start: -1h)
      |> filter(fn: (r) => r._measurement == "telemetry" and r._field == "temperature" and r.region == "cn-east")
      |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
    """;
List<FluxTable> tables = client.getQueryApi().query(flux);
for (FluxTable t : tables) for (FluxRecord r : t.getRecords()) {
    System.out.println(r.getTime() + " " + r.getValue());
}
```

要点：**查询必须带 `range`**；结果集大时用流式/回调 API 避免 OOM；参数拼接 Flux/InfluxQL 要**防注入**（用参数化接口或严格校验输入，见 [Web 安全](#/security/web)）；设置查询超时与并发限制，防止慢查询拖垮实例。

### 3. 客户端注意事项

| 项 | 说明 |
| --- | --- |
| `WriteApi`（异步批量） vs `WriteApiBlocking` | 高吞吐用前者（后台批量+重试）；需要立即得知结果用后者（逐批阻塞） |
| **背压与丢数据** | 缓冲满（`bufferLimit`）或重试用尽会丢点；监听 `WriteErrorEvent`，必要时落本地队列/重投 Kafka |
| 退出时 flush | 关闭前调用 `writeApi.flush()`/`close()`，否则缓冲数据丢失 |
| 时间戳 | 使用采集时间；精度选 `MS`/`S`，能少存则少存 |
| 令牌 | 最小权限（只写某 bucket），放配置中心/密钥管理，见 [认证授权](#/security/auth)、[密钥管理](#/security/crypto) |
| 连接 | 客户端单例复用，TLS 在公网必开；超时参数显式设置 |

## 三、写入调优

| 手段 | 说明 |
| --- | --- |
| **批量** | 每次请求数千点（官方常建议 5,000 行量级起步，视点大小调整），并发多个写入连接；避免“一点一请求” |
| **压缩** | HTTP 写入启用 gzip（客户端 `GzipInterceptor`/Telegraf 默认可配），减少带宽 |
| **按时间排序** | 同一批内按 tag 与时间有序写入，减少索引与 compaction 开销；**避免乱序与大量历史回填**同时发生在线上 |
| **精度** | 使用 `s`/`ms` 精度，时间戳压缩更好 |
| **控制 field 与 tag 数量** | 一次采集的多指标合并为同一点的多个 field；不要为每个指标写一行 |
| **削峰** | 前置 Kafka：突发流量先入队，消费者按固定速率批量写入；InfluxDB 不可用时数据不丢（见 [Kafka](#/mw/kafka)） |
| **幂等** | 消费者可能重复投递：同 series 同时间戳覆盖写，天然幂等（时间戳取采集时间） |
| **硬件** | SSD/NVMe；足够内存给索引和缓存；v1/v2 单机写入吞吐有上限，超出需分片到多个实例或使用集群/v3 |
| **监控** | 写入延迟、写入失败率、WAL/Cache 大小、compaction 积压、series 基数、磁盘使用率、查询耗时（见 [指标监控](#/infra/obs-metrics)） |

压测与容量：用真实 tag 组合与采样频率压测；估算 `设备数 × 指标数 ÷ 采集间隔 = 点/秒`，如 10 万设备 × 5 指标 ÷ 10 秒 = 5 万点/秒。

## 四、降采样与分级保留

### 1. 为什么要降采样

原始 10 秒精度的数据保留一年成本极高，且长周期趋势分析并不需要这么细的粒度。**分级存储**：

| 级别 | 精度 | 保留 | 用途 |
| --- | --- | --- | --- |
| raw | 10s | 7~30 天 | 近期排障、实时看板 |
| 1m / 5m | 1~5 分钟聚合 | 3~6 个月 | 周期趋势 |
| 1h / 1d | 小时/天聚合（保留 mean/min/max/count） | 1~3 年 | 长期容量/报表 |

**聚合时要同时保留 `min/max/mean/count`**（只留 mean 会丢失峰值信息，告警类需求尤为重要）。

### 2. 实现方式

```flux
// v2：Task，每小时把 raw 降采样到 metrics_1h（在 UI 或 API 创建）
option task = { name: "downsample_telemetry_1h", every: 1h, offset: 5m }    // offset：等待迟到数据

from(bucket: "raw")
  |> range(start: -task.every)
  |> filter(fn: (r) => r._measurement == "telemetry" and r._field == "temperature")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
  |> to(bucket: "metrics_1h", org: "ops")
```

```sql
-- v1：Continuous Query（持续查询）+ 目标保留策略
CREATE CONTINUOUS QUERY cq_telemetry_1h ON metrics BEGIN
  SELECT mean("temperature") AS temperature_mean, max("temperature") AS temperature_max, count("temperature") AS n
  INTO metrics.rp_1y.telemetry_1h FROM metrics.rp_14d.telemetry GROUP BY time(1h), *
END
```

注意：

- 任务要**幂等、可重跑**（目标按时间窗口覆盖写）；处理**迟到数据**（offset 或重算最近窗口）；
- 任务失败要告警，否则长期数据出现空洞；
- v3 或外部方案：用定时作业（Flink/Spark/SQL）读 raw 写聚合表，或用查询引擎做物化；
- **在查询层自动选择精度**：看板按时间跨度选 raw / 1h / 1d bucket（Grafana 变量或查询代理），避免大范围查 raw。

## 五、基数治理

### 1. 监控与定位

```sql
-- InfluxQL：基数概览
SHOW SERIES CARDINALITY ON metrics
SHOW MEASUREMENT CARDINALITY ON metrics
SHOW TAG VALUES CARDINALITY ON metrics WITH KEY = "host"      -- 逐个 tag key 看取值数，找出膨胀的 tag
```

```flux
import "influxdata/influxdb"
influxdb.cardinality(bucket: "raw", start: -30d)               // v2：series 基数
```

### 2. 常见成因与治理

| 成因 | 治理 |
| --- | --- |
| 把 ID/URL/时间戳/随机串作为 tag | 改为 field，或聚合后再入库；**上线前评审 tag 设计** |
| 容器/Pod 名、临时实例 ID 作为 tag，频繁变化 | 保留稳定维度（服务、节点池）；Pod 名可丢弃；设置保留期让旧 series 过期 |
| 动态生成的 tag 键（`metric_<id>`） | 固定 key，值放 value/tag |
| 采集端误配置导致 tag 爆炸 | Telegraf 用 `tagexclude/taginclude`，写入前过滤；服务端限制（v1 `max-series-per-database`、`max-values-per-tag` 等保护参数，按版本） |
| 旧 series 不再写入但仍占索引 | 保留期到期后随 shard 删除；必要时删除无用 measurement/series（删除要谨慎，见下） |

治理流程：**上线前基数估算 → 灰度观察 → 持续监控告警 → 超限预案（限流/丢弃高基数 tag）**。

## 六、最新值、删除与回填

### 1. “最新一条”不要靠扫时序库

- `SELECT LAST(...)`/Flux `last()` 在 **series 很多**时需要逐 series 取，延迟高；
- 方案：写入时**同时更新 Redis（`HSET device:latest ...`）或设备影子**（见 [IoT 平台：设备影子](#/iot/platform)、[Redis 数据结构](#/redis/types)）；看板的“当前值”读缓存，趋势图读 Influx。

### 2. 删除

- 时序库擅长**按保留期整体过期**，不擅长**精确删除单点**；
- `DELETE` 按时间范围 + 谓词（tag）删除是**墓碑 + compaction 回收**，大范围删除开销大；
- 合规删除（如用户数据）需要提前设计：把可删除维度做成可识别的 tag，或单独 bucket，便于整体删除/过期。

### 3. 历史回填

- 回填大量旧时间戳数据会写入旧 shard，触发其 compaction，可能影响线上；**限速、分批、在低峰、独立实例/bucket 回填后再合并**；
- 先确认写入的时间戳精度与时区（统一 UTC）。

## 七、备份、高可用与安全

| 项 | v1/v2 开源单机 | 企业版/云/v3 |
| --- | --- | --- |
| **高可用** | 开源版**单节点无内置高可用**：靠双写（应用/Telegraf 同时写两个实例）、Kafka 重放、快照与快速恢复 | 企业版集群（数据节点副本）、云服务托管；v3 利用对象存储持久化与多节点形态 |
| **备份** | `influx backup`（v2）/ `influxd backup`（v1）定期全量/增量；备份到对象存储并**演练恢复** | 云/企业版提供备份能力或对象存储天然持久 |
| **容灾** | 异地双写或 Kafka 多消费者写入第二集群 | 跨区域复制（视产品） |
| **安全** | 开启认证与 TLS；**令牌最小权限**（按 bucket 只读/只写）；不要把 8086 暴露公网；审计 | 同上，加企业 SSO/RBAC |
| **资源保护** | 查询超时、并发限制、`max-series` 等保护参数；大查询隔离 | 资源配额 |

对于**监控类**数据，丢失少量历史数据通常可接受，可降低复杂度；**业务/合规数据**则需要双写或可靠消息 + 备份。

## 八、选型对比

| | **InfluxDB** | **Prometheus** | **TimescaleDB** | **TDengine / IoTDB** | **ClickHouse** |
| --- | --- | --- | --- | --- | --- |
| 定位 | 通用时序库（监控/IoT/业务指标） | **监控指标**（拉取模型 + 告警生态） | PostgreSQL 时序扩展 | **IoT 海量设备遥测** | **列式分析** |
| 查询 | InfluxQL / Flux / SQL(v3) | PromQL | **标准 SQL**（+ 时序函数） | SQL（扩展） | SQL |
| 写入模型 | 推（Line Protocol） | **拉**（也可 remote write） | SQL INSERT/COPY | 推（多协议） | 批量 INSERT |
| 高基数 | v1/v2 敏感，**v3 友好** | 敏感（基数爆炸） | **较好**（普通表，按设备分段压缩） | **好**（一设备一子表） | **好**（列存） |
| 关系/联表 | 弱 | 无 | **强**（与业务表 JOIN） | 弱~中 | 中 |
| 生态 | Telegraf、Grafana、Kapacitor | Alertmanager、exporter 生态最大 | PG 生态 | 国产 IoT 生态、工业协议 | 数仓生态 |
| 长期存储/规模 | 需降采样/集群/v3 | 本地存储短期，长期用 Thanos/Mimir/VictoriaMetrics | 压缩与连续聚合成熟 | 高压缩、集群 | 极强 |
| 适用 | 基础设施/应用监控、边缘与中小规模 IoT | **云原生监控与告警** | 已用 PG、需 SQL/联查 | 工业/车联网/海量设备 | 明细分析与报表 |

选型建议：

- **云原生/K8s 监控告警**：优先 **Prometheus + Grafana**（生态与标准），Influx 并非必须（见 [指标监控](#/infra/obs-metrics)）；
- **已有 PostgreSQL、需要时序与业务表联查、SQL 统一**：**TimescaleDB**（见 [IoT 平台：TimescaleDB 示例](#/iot/platform)、[PostgreSQL](#/pg/architecture)）；
- **千万级设备/海量遥测、成本敏感、国产化**：**TDengine / Apache IoTDB**；
- **以分析为主（多维下钻、报表、用户行为）**：**ClickHouse/Doris**（见 [OLAP](#/bigdata/olap)）；
- **采集多样（大量现成插件）、中小规模、团队熟悉 Influx 生态**：InfluxDB（关注版本路线，新项目评估 v3）；
- **实时流处理再入库**：Flink 处理后写 Influx/其他（见 [Flink](#/bigdata/flink-core)）。

## 九、常见坑

| 坑 | 对策 |
| --- | --- |
| 高基数 tag（ID/URL）导致内存与性能崩溃 | 上线前评审 tag；监控基数；改 field 或选 v3/其他库 |
| 一点一请求，写入吞吐极低 | 批量（数千点）+ gzip + 异步 WriteApi |
| 应用退出未 flush，丢最后一批 | `close()/flush()`；优雅停机 |
| 缓冲满或重试耗尽静默丢点 | 监听写入错误事件；Kafka 缓冲 + 重投 |
| 时间戳用写入时间，重传造成重复/乱序 | 使用采集时间；幂等覆盖写 |
| field 类型冲突（先写 int 后写 float） | 统一类型（Line Protocol 整数加 `i`）；写入前校验 |
| 查询不带时间范围，扫描全库 | 强制 range；看板默认时间窗口；查询超时 |
| 大范围查询直接读 raw，慢且占资源 | 按范围选降采样 bucket |
| 降采样只留 mean，丢失峰值 | 同时保留 min/max/count |
| 降采样任务失败无人知 | 任务告警；可重跑；处理迟到数据 |
| 8086 暴露公网、令牌权限过大 | 内网+TLS+最小权限令牌 |
| 开源单机当作高可用方案 | 双写/Kafka 重放/定期备份演练，或选企业/云/v3 |
| 把 InfluxDB 当关系库做 JOIN/事务 | 时序库不擅长；关联维度表放 MySQL/PG，查询层合并 |
| 按“最新值”扫全库 | Redis/设备影子存最新值 |
| 迁移 v3 时直接沿用 Flux | v3 不支持 Flux，需重写为 SQL/InfluxQL |

## 面试追问

> [!QUESTION] 为什么高基数 tag 会拖垮 InfluxDB？如何避免？
> 每个唯一 tag 组合是一条 series，都需要在索引中维护，基数增长会让索引膨胀、内存占用和写入查询变慢。避免方法是只把有限稳定的维度做 tag，用户 ID、请求 ID、完整 URL 等高基数值放 field 或不入库，上线前估算基数并持续监控，必要时选用对高基数友好的 v3 或其他时序库。

> [!QUESTION] 如何设计一个 IoT 遥测数据写入 InfluxDB 的方案？
> 设备数据经 MQTT 或 Kafka 到消费者，批量攒批数千点用 gzip 通过 WriteApi 写入，时间戳使用采集时间保证重传幂等；设备类型、区域等低基数维度做 tag，指标做 field；原始桶保留短期，用任务降采样成小时和天级聚合长期保留；最新值写 Redis 或设备影子；监控基数、写入失败和积压，Kafka 提供缓冲和重放。

> [!QUESTION] 降采样怎么做？要注意什么？
> 用 v2 的 Task 或 v1 的 Continuous Query 定时把高频原始数据聚合写入长期 bucket，同时保留 min、max、mean、count，避免丢峰值。任务要幂等可重跑，通过 offset 处理迟到数据，失败要告警，查询层按时间跨度选择对应精度的 bucket。

> [!QUESTION] 为什么不适合用 InfluxDB 查询每个设备的最新一条？怎么办？
> series 很多时 last 需要逐个 series 取值，延迟高、开销大。应在写入时同步更新 Redis 或设备影子保存最新值，当前值直接读缓存，趋势图再查时序库。

> [!QUESTION] InfluxDB、Prometheus、TimescaleDB 怎么选？
> 云原生监控告警首选 Prometheus 及其生态；已有 PostgreSQL 且需要 SQL 与业务表联查选 TimescaleDB；海量设备遥测、高基数场景可选 TDengine 或 IoTDB；以分析为主用 ClickHouse；采集插件丰富、中小规模并熟悉 Influx 生态时选 InfluxDB，同时关注版本路线与 v3 的 SQL 能力。

> [!QUESTION] InfluxDB 开源单机版如何保证数据不丢和高可用？
> 开源单机没有内置高可用，通常用 Kafka 缓冲并支持重放、双写到两个实例或异地集群、定期备份到对象存储并演练恢复；对可靠性要求高时选企业版集群、云托管或 v3 基于对象存储的形态。监控类数据可容忍少量丢失，业务和合规数据则需要更严格的双写与备份。
