---
level: 进阶
tags: [可观测性, Prometheus, PromQL, Micrometer, Grafana, Alertmanager, RED, USE, 基数]
summary: 可观测性三支柱与指标监控体系：黄金信号/RED/USE 方法、Prometheus 拉取模型与数据模型、四种指标类型、PromQL 常用查询、Spring Boot Micrometer 埋点、Grafana 看板、Alertmanager 告警设计、高基数陷阱与容量规划。
---

# 指标监控：Prometheus、Micrometer 与 Grafana

> [!ABSTRACT] 核心要点
> - **可观测性 = 指标（Metrics）+ 日志（Logs）+ 链路（Traces）**：指标回答“**有没有问题、多严重**”，链路回答“**慢在哪**”，日志回答“**具体发生了什么**”。排障顺序通常是 **指标发现 → 链路定位 → 日志取证**。
> - 设计监控别从“能采什么”出发，而从“**用户是否受影响**”出发：**四个黄金信号**（延迟、流量、错误、饱和度），服务用 **RED**（Rate/Errors/Duration），资源用 **USE**（Utilization/Saturation/Errors）。
> - **Prometheus** 是**拉取（pull）**模型的时序数据库，数据模型是 `指标名 + 标签集 → 时间序列`；类型有 Counter、Gauge、Histogram、Summary；**标签基数**是它最大的性能杀手。
> - Java 侧用 **Micrometer**（指标门面）+ Spring Boot Actuator 暴露 `/actuator/prometheus`。
> - 告警要“**少而准、可行动**”：基于症状与 SLO（见 [链路追踪、日志与告警](#/infra/obs-trace)），而不是盯着 CPU 超过 80% 就响。

## 一、三支柱与监控方法论

<figure class="fig">
<svg viewBox="0 0 780 300" class="dg" role="img" aria-label="可观测性三支柱：指标用于发现问题和趋势，链路用于定位慢在哪个服务，日志用于查看具体细节；排障顺序为指标告警、链路定位、日志取证，三者通过 traceId 和标签互相关联">
<rect class="b1" x="30" y="30" width="210" height="100" rx="12"/>
<text class="th" x="46" y="56">指标 Metrics</text>
<text class="ts" x="46" y="80">数值型、可聚合、体积小</text>
<text class="ts" x="46" y="98">看趋势 / 告警 / 容量</text>
<text class="ts" x="46" y="116">Prometheus · Micrometer</text>
<rect class="b3" x="285" y="30" width="210" height="100" rx="12"/>
<text class="th" x="301" y="56">链路 Traces</text>
<text class="ts" x="301" y="80">一次请求跨服务的调用树</text>
<text class="ts" x="301" y="98">定位慢在哪一跳</text>
<text class="ts" x="301" y="116">OpenTelemetry · SkyWalking</text>
<rect class="b5" x="540" y="30" width="210" height="100" rx="12"/>
<text class="th" x="556" y="56">日志 Logs</text>
<text class="ts" x="556" y="80">事件细节、堆栈、上下文</text>
<text class="ts" x="556" y="98">取证 / 审计</text>
<text class="ts" x="556" y="116">ELK · Loki</text>
<line class="l" x1="240" y1="80" x2="285" y2="80" marker-end="url(#arr)"/>
<line class="l" x1="495" y1="80" x2="540" y2="80" marker-end="url(#arr)"/>
<rect class="bg" x="30" y="160" width="720" height="110" rx="12"/>
<text class="th" x="46" y="186">三者的关联</text>
<text class="ts" x="46" y="210">• 指标上挂 Exemplar（样本里带 traceId）→ 从尖刺直接跳到那条慢链路</text>
<text class="ts" x="46" y="230">• 日志里打印 traceId/spanId（MDC）→ 从链路一键查到对应日志</text>
<text class="ts" x="46" y="250">• 统一资源标签：service.name、env、version、instance，便于在三种数据间切换</text>
</svg>
<figcaption>图 1：三支柱与排障顺序：指标 → 链路 → 日志</figcaption>
</figure>

### 1. 该监控什么：黄金信号、RED、USE

| 方法 | 适用 | 指标 |
| --- | --- | --- |
| **四个黄金信号**（Google SRE） | 任何面向用户的系统 | **延迟 Latency**（区分成功/失败请求）、**流量 Traffic**、**错误 Errors**、**饱和度 Saturation**（资源还剩多少余量） |
| **RED** | **服务/接口** | **R**ate 每秒请求数、**E**rrors 错误率、**D**uration 耗时分布 |
| **USE** | **资源**（CPU、内存、磁盘、网卡、连接池、线程池） | **U**tilization 利用率、**S**aturation 饱和度（排队/等待）、**E**rrors 错误数 |

Java 应用的典型饱和度信号：**线程池队列长度/活跃线程**、**数据库连接池等待数**、**JVM GC 停顿**、**堆使用率**、Kafka **消费滞后（lag）**。见 [线程池](#/java/concurrency/pool)、[JVM 调优](#/java/jvm/tuning)。

### 2. 分层监控

| 层 | 内容 | 来源 |
| --- | --- | --- |
| 基础设施 | CPU/内存/磁盘/网络、节点状态 | node_exporter、云监控 |
| 容器/K8s | Pod 重启、OOMKilled、资源限额 | cAdvisor、kube-state-metrics（见 [Kubernetes](#/infra/k8s)） |
| 中间件 | MySQL、Redis、Kafka、ES | 各类 exporter（mysqld/redis/kafka exporter） |
| 应用 | JVM、HTTP 接口、线程池、连接池 | Micrometer |
| **业务** | 下单量、支付成功率、库存不足次数 | 自定义指标（**最贴近用户，常被忽略**） |
| 外部探测 | 域名/接口可用性与延迟 | Blackbox exporter、拨测 |

## 二、Prometheus 核心

<figure class="fig">
<svg viewBox="0 0 800 340" class="dg" role="img" aria-label="Prometheus 架构：Prometheus Server 通过服务发现获取目标，周期性拉取应用的指标端点与各类 exporter，存入本地时序库；PromQL 查询供 Grafana 展示，告警规则触发后交给 Alertmanager 去重分组并通知；短任务通过 Pushgateway 推送">
<rect class="b3" x="290" y="110" width="200" height="110" rx="12"/>
<text class="th" x="306" y="136">Prometheus Server</text>
<text class="ts" x="306" y="160">Retrieval 抓取</text>
<text class="ts" x="306" y="178">TSDB 本地时序存储</text>
<text class="ts" x="306" y="196">规则引擎 · PromQL</text>
<rect class="b1" x="20" y="30" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="52" text-anchor="middle" dominant-baseline="middle">Java 应用 /metrics</text>
<rect class="b1" x="20" y="96" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="118" text-anchor="middle" dominant-baseline="middle">Exporter（MySQL/Redis）</text>
<rect class="b1" x="20" y="162" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="184" text-anchor="middle" dominant-baseline="middle">node_exporter</text>
<rect class="b5" x="20" y="228" width="170" height="44" rx="8"/>
<text class="tb" x="105" y="250" text-anchor="middle" dominant-baseline="middle">Pushgateway（短任务）</text>
<rect class="b4" x="20" y="294" width="170" height="36" rx="8"/>
<text class="ts" x="105" y="312" text-anchor="middle" dominant-baseline="middle">服务发现：K8s / Consul / 静态</text>
<line class="la" x1="290" y1="165" x2="190" y2="52" marker-end="url(#arr-a)"/>
<line class="la" x1="290" y1="165" x2="190" y2="118" marker-end="url(#arr-a)"/>
<line class="la" x1="290" y1="165" x2="190" y2="184" marker-end="url(#arr-a)"/>
<line class="la" x1="290" y1="175" x2="190" y2="250" marker-end="url(#arr-a)"/>
<text class="ta" x="200" y="288" text-anchor="start">拉取 pull（默认每 15~60s）</text>
<rect class="b2" x="590" y="40" width="190" height="56" rx="8"/>
<text class="tb" x="685" y="62" text-anchor="middle" dominant-baseline="middle">Grafana</text>
<text class="ts" x="685" y="82" text-anchor="middle">看板 / 探索</text>
<rect class="b4" x="590" y="150" width="190" height="56" rx="8"/>
<text class="tb" x="685" y="172" text-anchor="middle" dominant-baseline="middle">Alertmanager</text>
<text class="ts" x="685" y="192" text-anchor="middle">分组 · 抑制 · 静默</text>
<rect class="b5" x="590" y="250" width="190" height="56" rx="8"/>
<text class="tb" x="685" y="272" text-anchor="middle" dominant-baseline="middle">通知</text>
<text class="ts" x="685" y="292" text-anchor="middle">钉钉/飞书/电话/邮件</text>
<line class="l" x1="490" y1="140" x2="590" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="498" y="100" text-anchor="start">PromQL</text>
<line class="l" x1="490" y1="178" x2="590" y2="178" marker-end="url(#arr)"/>
<text class="ts" x="500" y="170" text-anchor="start">告警</text>
<line class="l" x1="685" y1="206" x2="685" y2="250" marker-end="url(#arr)"/>
</svg>
<figcaption>图 2：Prometheus 生态架构</figcaption>
</figure>

### 1. 拉取模型的特点

- **Server 主动抓取** `/metrics`：目标是否存活本身就是一个指标（`up`），易于发现“采不到”的故障；目标无需知道监控系统地址；
- 短生命周期任务（批处理）来不及被抓取，用 **Pushgateway**（仅限此类场景，别拿来当通用推送）；
- 数据本地存储（TSDB，2 小时块 + WAL，压缩好），**单机**；长期存储/高可用/多集群聚合用 **Thanos、Cortex/Mimir、VictoriaMetrics** 或远程写；
- 规模大时：分片按 job 切分，或联邦/远程读写。

### 2. 数据模型

一条时间序列由 **指标名 + 一组标签（label）** 唯一确定：

```text
http_server_requests_seconds_count{application="order", method="POST", uri="/orders", status="200"}  1873
                                    └────────────────── 标签：维度 ──────────────────────────┘      └ 当前值（带时间戳）
```

**每一种不同的标签组合就是一条独立的时间序列**——这就是“基数”问题的来源（见下文）。

### 3. 四种指标类型

| 类型 | 语义 | 例子 | 怎么用 |
| --- | --- | --- | --- |
| **Counter** | 只增不减的累计值（重启归零） | 请求总数、错误总数 | 一定配合 `rate()` / `increase()` 看速率 |
| **Gauge** | 可增可减的瞬时值 | 当前线程数、队列长度、内存使用 | 直接看或 `avg_over_time` |
| **Histogram** | 把观测值落入**可配置的桶**，并给出 `_sum`、`_count` | 请求耗时分布 | 服务端聚合，**用 `histogram_quantile` 算分位数**，可跨实例聚合 |
| **Summary** | 客户端直接算好的分位数 | 同上 | **分位数不能跨实例聚合**，不推荐新用 |

**分位数为什么必须用 Histogram**：平均值会掩盖长尾（99% 的请求 10ms、1% 的请求 5s，均值很好看）。**P95/P99** 才反映用户体验；而**不同实例的 P99 取平均是错误的**，必须先聚合桶再算分位数。

## 三、PromQL 常用查询

```promql
# 1) 每秒请求数（QPS）：按服务汇总 5 分钟速率
sum by (application) (rate(http_server_requests_seconds_count[5m]))

# 2) 错误率：5xx 占比
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
  /
sum(rate(http_server_requests_seconds_count[5m]))

# 3) P99 延迟（先按 le 聚合桶，再算分位数）
histogram_quantile(0.99,
  sum by (le, uri) (rate(http_server_requests_seconds_bucket[5m])))

# 4) 平均延迟
rate(http_server_requests_seconds_sum[5m]) / rate(http_server_requests_seconds_count[5m])

# 5) JVM 堆使用率
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"}

# 6) 线程池/连接池饱和：HikariCP 等待连接的线程数
hikaricp_connections_pending > 0

# 7) 容器 CPU 被限流比例（K8s 常见隐形瓶颈）
rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])

# 8) 预测磁盘 4 小时后是否写满
predict_linear(node_filesystem_avail_bytes[1h], 4*3600) < 0

# 9) Kafka 消费滞后（见 Kafka 笔记）
sum by (consumergroup, topic) (kafka_consumergroup_lag)
```

要点：

- `rate()` 的范围窗口要**至少是抓取间隔的 4 倍**（15s 抓取用 `[1m]` 起）；
- `rate` 用于 Counter，**不要对 Gauge 用**；对 Counter 求和要**先 rate 再 sum**（`sum(rate(x))`，而不是 `rate(sum(x))`，否则重启会出错）；
- **记录规则（recording rule）**把复杂或高频查询预先计算成新指标，加速看板与告警。

## 四、Java 应用：Micrometer 与 Actuator

**Micrometer** 是指标的“SLF4J”：代码里写一次，可输出到 Prometheus、Datadog、InfluxDB 等。Spring Boot 内置。

```xml
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
<dependency><groupId>io.micrometer</groupId><artifactId>micrometer-registry-prometheus</artifactId></dependency>
```

```yaml
management:
  endpoints.web.exposure.include: health,info,prometheus     # 只暴露需要的，并限制内网访问
  metrics:
    tags:
      application: ${spring.application.name}                # 统一公共标签
      env: ${ENV:dev}
    distribution:
      percentiles-histogram:
        http.server.requests: true                            # 为接口耗时发布直方图桶，用于服务端算分位数
      slo:
        http.server.requests: 50ms,100ms,200ms,500ms,1s,2s    # 按业务 SLO 自定义桶边界
```

开箱即用的指标：`jvm_*`（堆/GC/线程/类加载）、`process_cpu_*`、`http_server_requests_*`、`hikaricp_*`、`tomcat_*`、`lettuce_*`/`jedis`、`kafka_*`、`logback_events_total` 等。

### 自定义业务指标

```java
@Service
public class PayService {
    private final Counter paySuccess;
    private final Counter payFail;
    private final Timer payTimer;
    private final AtomicInteger inFlight = new AtomicInteger();

    public PayService(MeterRegistry registry) {
        this.paySuccess = Counter.builder("pay.requests").tag("result", "success").tag("channel", "alipay").register(registry);
        this.payFail    = Counter.builder("pay.requests").tag("result", "fail").tag("channel", "alipay").register(registry);
        this.payTimer   = Timer.builder("pay.latency").publishPercentileHistogram().register(registry);
        Gauge.builder("pay.inflight", inFlight, AtomicInteger::get).register(registry);   // Gauge：当前进行中
    }

    public void pay(PayReq req) {
        inFlight.incrementAndGet();
        try {
            payTimer.record(() -> doPay(req));
            paySuccess.increment();
        } catch (Exception e) {
            payFail.increment();
            throw e;
        } finally {
            inFlight.decrementAndGet();
        }
    }
}
```

也可以用 `@Timed` / `@Observed`（Micrometer Observation API，一次埋点同时产生指标与链路，见 [链路追踪、日志与告警](#/infra/obs-trace)）。

### 命名与标签规范

- 指标名用小写+下划线，带**单位后缀**（`_seconds`、`_bytes`、`_total`）；业务指标加前缀；
- **标签放“有限且有分析价值”的维度**：渠道、结果、接口模板（`/orders/{id}`）；
- **绝不能放无界值**：`userId`、`orderId`、`traceId`、完整 URL（带参数）、异常消息。

## 五、基数爆炸：最大的坑

**时间序列数 = 各标签取值数的乘积**。例如 `uri`(500) × `method`(5) × `status`(10) × `instance`(100) = 250 万条序列。每条序列在内存里要占用约数 KB，**高基数会拖垮 Prometheus（OOM、查询变慢）**。

| 常见来源 | 对策 |
| --- | --- |
| 把 `userId`/`orderId`/`requestId` 做标签 | 移到日志/链路，指标只放聚合维度 |
| URL 带路径变量（`/orders/12345`） | 使用路由模板 `/orders/{id}`（Spring MVC 默认如此，自定义拦截要注意） |
| 异常信息、SQL 做标签 | 用有限的异常类名或错误码 |
| 容器频繁重建，`pod`/`instance` 标签累积 | 控制保留期，用 `relabel` 丢弃无用标签 |
| 大量 Histogram 桶 × 高维度 | 桶数量精简；只对关键指标开直方图 |

排查：`topk(10, count by (__name__)({__name__=~".+"}))` 看哪个指标序列最多；`/api/v1/status/tsdb`；用 `metric_relabel_configs` 在抓取时丢弃；`sample_limit` 给每个 target 设上限做保护。

## 六、Grafana 看板

好看板的原则：**一屏回答一个问题**，从概览逐层下钻。

| 看板 | 内容 |
| --- | --- |
| **服务总览（RED）** | QPS、错误率、P50/P95/P99，按服务/接口切换（用变量） |
| **JVM** | 堆/非堆、GC 次数与停顿、线程数（运行/阻塞）、类加载 |
| **依赖** | 数据库连接池、慢 SQL 数、Redis 命中率与延迟、MQ 堆积 |
| **业务** | 下单/支付成功率、转化漏斗、关键业务异常 |
| **基础设施** | 节点与 Pod 的 CPU/内存/网络/磁盘、重启次数 |

实践：用**模板变量**（环境、服务、实例）复用同一看板；看板放进 **Git 管理（JSON / Grafonnet / Terraform）**；**阈值线**画出 SLO；点击图表联动 **Exemplar → Tempo/Jaeger** 跳到链路；注释（Annotation）标记发布与变更事件，方便把“指标变化”与“发布”对上号。

## 七、告警设计

### 1. Alertmanager 职责

规则在 Prometheus 里评估，触发后交给 **Alertmanager**：

- **分组（group）**：把同一服务的一批告警合成一条通知，避免告警风暴；
- **抑制（inhibit）**：节点宕机时抑制该节点上所有应用的告警；
- **静默（silence）**：发布/维护期间临时屏蔽；
- **路由**：按标签分发给不同团队/渠道（P0 打电话，P2 发群）。

```yaml
groups:
- name: order-service
  rules:
  - alert: HighErrorRate
    expr: |
      sum(rate(http_server_requests_seconds_count{application="order",status=~"5.."}[5m]))
        / sum(rate(http_server_requests_seconds_count{application="order"}[5m])) > 0.02
    for: 5m                          # 持续 5 分钟才告警，过滤抖动
    labels: { severity: critical, team: trade }
    annotations:
      summary: "订单服务 5xx 错误率 > 2%（当前 {{ $value | humanizePercentage }}）"
      runbook: "https://wiki.example.com/runbook/order-5xx"   # 告警必须带处置手册
```

### 2. 告警原则

| 原则 | 说明 |
| --- | --- |
| **基于症状而非原因** | 告警“用户受影响”（错误率、延迟、成功率下降），而不是“CPU 80%”。原因类指标放看板，用于诊断 |
| **每条告警都要可行动** | 看到后知道该做什么，附 Runbook；没有动作的告警就是噪音 |
| **分级** | P0 立即响应（电话）、P1 工作时间内处理、P2 工单/日报 |
| **`for` 持续时间 + 多窗口** | 抗抖动；配合 SLO 燃烧率（见下一篇） |
| **失联也要告警** | `up == 0`、指标消失 `absent()`，避免“监控自己挂了没人知道”（再加一条永远触发的“Watchdog/死人开关”检测告警链路） |
| **治理告警** | 定期复盘误报漏报，删除从没人处理的告警 |

**业务告警示例**：支付成功率 5 分钟内低于 95%；订单创建 QPS 较上周同期下降 50%（用 `offset 1w` 对比）；MQ 堆积超过阈值持续增长；对账差异出现。

## 八、容量与成本

- 存储估算：`序列数 × 每秒抓取样本数 × 每样本字节（约 1~2 B 压缩后）× 保留秒数`。例如 100 万序列、15s 抓取、保留 15 天 ≈ 100 万 × (1/15) × 1.5 B × 1.3M s ≈ 数 GB 量级到十几 GB（**以实测为准**）；
- 内存主要由**活跃序列数**决定，**约每条序列几 KB**；
- 降本：缩短保留期、降采样、丢弃无用指标与标签、长期数据放 Thanos/Mimir/对象存储、按重要度分层抓取间隔。

## 九、常见坑

| 坑 | 说明 |
| --- | --- |
| 对 Gauge 用 `rate`、对 Counter 直接看原值 | 类型用错，图形没意义；Counter 看 `rate/increase` |
| `rate(sum())` 写反 | 先 rate 再 sum |
| 平均值掩盖长尾 | 看 P95/P99；用 Histogram |
| 分位数跨实例取平均 | 用桶聚合后再 `histogram_quantile` |
| 抓取间隔 vs rate 窗口 | 窗口 < 2 倍抓取间隔会出现空洞 |
| `/actuator` 暴露公网 | 泄露敏感信息；只开 `prometheus/health`，限制内网（见 [Web 安全](#/security/web)） |
| 高基数标签 | OOM；规范标签、设 `sample_limit` |
| 只有技术指标，没有业务指标 | 无法回答“用户是否受影响” |
| 告警太多，被忽略 | 精简、分级、抑制 |
| 容器 CPU 限流不监控 | 延迟毛刺的隐形原因 |

## 相关阅读

- [微服务可观测：Micrometer、链路追踪与排障](#/spring/cloud-observability)：Spring Cloud 中的指标与探针

## 面试追问

> [!QUESTION] 监控系统应该监控哪些指标？RED 和 USE 方法是什么？
> 从用户感知出发看四个黄金信号：延迟、流量、错误、饱和度。服务维度用 RED，即请求速率、错误率、耗时分布；资源维度用 USE，即利用率、饱和度、错误数。再配合业务指标，才能同时回答技术健康和用户是否受影响。

> [!QUESTION] Prometheus 为什么用拉取模式？有什么优缺点？
> 拉取使 Server 掌握抓取节奏，目标是否存活用 up 指标即可判断，目标不需要知道监控地址，也便于调试。缺点是短任务来不及被抓取需要 Pushgateway，跨网络或防火墙场景需要额外处理，单机存储需要 Thanos、Mimir 等做高可用和长期存储。

> [!QUESTION] Counter、Gauge、Histogram、Summary 的区别？为什么算分位数用 Histogram？
> Counter 只增累计需配合 rate，Gauge 是瞬时值，Histogram 把观测值落入桶并保存 sum 和 count，Summary 在客户端算好分位数。Histogram 的桶可以跨实例聚合后再用 histogram_quantile 计算全局分位数，而 Summary 的分位数无法聚合，对各实例 P99 取平均在数学上也是错的。

> [!QUESTION] 什么是高基数问题？如何避免？
> 时间序列数等于各标签取值数的乘积，把 userId、订单号、完整 URL 当标签会产生海量序列，导致 Prometheus 内存暴涨和查询变慢。避免方法是标签只放有限且有分析价值的维度，用路由模板代替具体 URL，把高基数信息放到日志或链路，并用 sample_limit 和 relabel 做保护。

> [!QUESTION] 如何设计一套不扰民又不漏报的告警？
> 基于用户可感知的症状告警，如错误率、延迟、成功率，原因类指标放看板；每条告警要可行动并附 Runbook；设置 for 持续时间和分级，用 Alertmanager 做分组抑制静默；监控自身存活并加死人开关；定期复盘清理噪音告警，并结合 SLO 燃烧率做多窗口告警。

> [!QUESTION] 线上接口 P99 变高，你怎么用监控体系排查？
> 先看 RED 看板确认范围，是全部接口还是个别接口、全部实例还是单实例，是否与发布时间吻合；再看依赖和饱和度指标，如数据库连接池等待、慢 SQL、Redis 延迟、线程池队列、GC 停顿、容器 CPU 限流；通过 Exemplar 或链路找到慢 span 所在服务，最后用该 traceId 查日志取证。
