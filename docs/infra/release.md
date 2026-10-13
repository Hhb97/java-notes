---
level: 高级
tags: [发布, 灰度, 金丝雀, 蓝绿, 滚动更新, 特性开关, 回滚, 数据库迁移, 扩展收缩, Flyway]
summary: 降低发布风险的方法：发布与上线解耦、滚动/蓝绿/金丝雀/影子流量的原理与取舍、特性开关与渐进式放量、自动化验证与回滚、数据库变更的扩展-收缩（expand/contract）模式与 Flyway、接口与消息的向后兼容、发布期间的优雅停机与预热，以及一套发布检查清单。
---

# 发布策略：灰度、蓝绿、特性开关与数据库变更

> [!ABSTRACT] 核心要点
> - 发布的目标不是“把代码放上去”，而是**让变更对用户的风险可控**：**小范围先试 → 用指标验证 → 逐步放大 → 异常快速回退**。
> - 区分**部署（Deploy，二进制到环境）**与**发布（Release，让用户用上功能）**：用**特性开关**把两者解耦，代码可以早部署、晚开启。
> - 四类策略：**滚动**（逐批替换，K8s 默认）、**蓝绿**（两套环境瞬间切换，回滚最快）、**金丝雀/灰度**（按比例或人群渐进放量）、**影子流量**（复制线上流量验证，不影响用户）。
> - **难点不在应用而在数据与兼容**：数据库变更必须**向后兼容**，用**扩展-收缩（expand/contract）**分多次发布；接口、消息、缓存格式也要保证**新旧版本并存**。
> - **可回滚**是发布的底线：应用回滚、配置回滚、开关关闭要比“发修复版”快得多；**数据库变更往往不可逆**，所以要把它与应用发布拆开。

> [!NOTE] 关联
> 流水线与 GitOps 见 [CI/CD 流水线与 GitOps](#/infra/cicd)；K8s 滚动更新与探针见 [Kubernetes](#/infra/k8s)；发布后的监控验证见 [指标监控](#/infra/obs-metrics)。

## 一、为什么发布最容易出事

**大多数线上事故与变更有关。** 常见诱因：一次改动太大、没有渐进放量、缺少快速回滚手段、数据库变更不兼容、依赖方未同步、发布时间选在高峰、监控没盯、配置/开关与代码不一致。

对策是一套组合：**小批量 + 渐进放量 + 自动验证 + 一键回滚 + 兼容性设计**。

## 二、四种发布策略

### 1. 滚动更新（Rolling Update）

逐批用新版本实例替换旧版本实例，**始终有一部分实例在服务**。K8s Deployment 默认策略：

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 25%          # 最多额外多起多少个新 Pod
    maxUnavailable: 0      # 保证不降低可用容量（配合 readinessProbe）
```

| 优点 | 缺点 |
| --- | --- |
| 简单、资源开销小、无需额外环境 | **新旧版本同时在线**（需要兼容），回滚是再滚一遍，较慢；出问题时已影响一部分用户 |

关键配合：**readinessProbe**（新实例就绪才接流量）、**preStop + 优雅停机**（旧实例处理完在途请求）、**预热**（避免冷启动即承压）、`minReadySeconds`、`progressDeadlineSeconds`。见 [Kubernetes](#/infra/k8s)。

### 2. 蓝绿发布（Blue-Green）

<figure class="fig">
<svg viewBox="0 0 800 280" class="dg" role="img" aria-label="蓝绿发布：蓝环境运行当前版本接收全部流量，绿环境部署新版本并完成验证；通过负载均衡或路由开关一次性切换流量到绿环境；出问题时再切回蓝环境实现秒级回滚；切换后蓝环境保留一段时间再回收；注意数据库需同时兼容两个版本">
<rect class="b1" x="20" y="110" width="110" height="50" rx="8"/>
<text class="tb" x="75" y="135" text-anchor="middle" dominant-baseline="middle">用户流量</text>
<rect class="b5" x="180" y="110" width="130" height="50" rx="8"/>
<text class="tb" x="245" y="135" text-anchor="middle" dominant-baseline="middle">LB / 网关路由</text>
<line class="l" x1="130" y1="135" x2="180" y2="135" marker-end="url(#arr)"/>
<rect class="b3" x="400" y="30" width="190" height="80" rx="12"/>
<text class="th" x="416" y="56">蓝环境（v1，当前）</text>
<text class="ts" x="416" y="80">全部在线流量</text>
<text class="ts" x="416" y="98">保留，随时可切回</text>
<rect class="b2" x="400" y="150" width="190" height="80" rx="12"/>
<text class="th" x="416" y="176">绿环境（v2，新版本）</text>
<text class="ts" x="416" y="200">已部署并通过冒烟/压测</text>
<text class="ts" x="416" y="218">先无流量，验证后再切</text>
<line class="l" x1="310" y1="125" x2="400" y2="75" marker-end="url(#arr)"/>
<line class="la" x1="310" y1="145" x2="400" y2="190" marker-end="url(#arr-a)"/>
<text class="ta" x="330" y="180" text-anchor="start">切换（原子）</text>
<rect class="b2" x="640" y="60" width="140" height="140" rx="12"/>
<text class="th" x="654" y="84">数据库</text>
<text class="ts" x="654" y="108">两版共用</text>
<text class="ts" x="654" y="128">必须同时兼容</text>
<text class="ts" x="654" y="148">v1 与 v2（见</text>
<text class="ts" x="654" y="168">扩展-收缩）</text>
<line class="l" x1="590" y1="70" x2="640" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="190" x2="640" y2="160" marker-end="url(#arr)"/>
<text class="ts" x="400" y="264" text-anchor="middle">✓ 切换与回滚都是秒级　✗ 需要双倍资源；有状态/长连接/会话需要处理；数据库是共享的</text>
</svg>
<figcaption>图 1：蓝绿发布：新版本先验证再整体切流，回滚即切回</figcaption>
</figure>

适用：对回滚速度要求高、资源允许、版本间兼容容易保证的系统；K8s 里可用两个 Deployment + Service selector 切换，或 Ingress/网关权重。

### 3. 金丝雀 / 灰度发布（Canary）

先把**少量流量**导给新版本，观察指标，**逐步放大（1% → 5% → 25% → 50% → 100%）**，任一阶段异常则回退。

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="金丝雀发布：新版本先接收小比例流量，系统持续比较新旧版本的错误率、延迟和业务指标；指标正常则按步长增加流量直至全量；指标超过阈值则自动回滚；流量切分可以按比例、按用户、按地域或按请求头">
<rect class="b1" x="20" y="100" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="125" text-anchor="middle" dominant-baseline="middle">流量</text>
<rect class="b5" x="160" y="100" width="150" height="50" rx="8"/>
<text class="tb" x="235" y="118" text-anchor="middle" dominant-baseline="middle">网关 / Mesh</text>
<text class="ts" x="235" y="138" text-anchor="middle">按权重/规则分流</text>
<line class="l" x1="120" y1="125" x2="160" y2="125" marker-end="url(#arr)"/>
<rect class="b3" x="380" y="40" width="170" height="56" rx="8"/>
<text class="tb" x="465" y="62" text-anchor="middle" dominant-baseline="middle">稳定版 v1</text>
<text class="ts" x="465" y="82" text-anchor="middle">95% 流量</text>
<rect class="b2" x="380" y="150" width="170" height="56" rx="8"/>
<text class="tb" x="465" y="172" text-anchor="middle" dominant-baseline="middle">金丝雀 v2</text>
<text class="ts" x="465" y="192" text-anchor="middle">5% 流量</text>
<line class="l" x1="310" y1="115" x2="380" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="310" y1="135" x2="380" y2="178" marker-end="url(#arr)"/>
<rect class="b4" x="610" y="80" width="170" height="100" rx="10"/>
<text class="th" x="624" y="104">自动分析</text>
<text class="ts" x="624" y="126">对比 v2 与 v1：</text>
<text class="ts" x="624" y="144">错误率 · P99 · 业务指标</text>
<text class="ts" x="624" y="164">正常→放量；异常→回滚</text>
<line class="l" x1="550" y1="178" x2="610" y2="150" marker-end="url(#arr)"/>
<line class="l" x1="550" y1="70" x2="610" y2="105" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="225" width="760" height="62" rx="10"/>
<text class="ts" x="36" y="248">分流维度：按比例 / 内部员工 / 白名单用户 / 地域 / 请求头(cookie) / 用户哈希（保证同一用户始终落在同一版本，避免体验来回跳）</text>
<text class="ts" x="36" y="268">✓ 影响面小、真实流量验证　✗ 需要流量治理能力与完善监控；两个版本并存，数据与接口要兼容；放量周期较长</text>
</svg>
<figcaption>图 2：金丝雀发布：渐进放量 + 指标对比 + 自动回滚</figcaption>
</figure>

**实现方式**：

| 方式 | 说明 |
| --- | --- |
| K8s 两个 Deployment + 副本比例 | 最简单，但粒度受副本数限制 |
| **Nginx/Ingress 权重或 Header 规则** | `nginx.ingress.kubernetes.io/canary: "true"` + `canary-weight` / `canary-by-header` |
| **服务网格**（Istio VirtualService 权重） | 精细分流、与指标联动 |
| **Argo Rollouts / Flagger** | 声明放量步骤（setWeight、pause、analysis），**自动对比指标并回滚** |
| 微服务层面：标签路由（Dubbo/Spring Cloud 灰度） | 请求带灰度标，沿调用链路由到灰度实例（全链路灰度需要标记透传，见 [Spring Cloud](#/spring/cloud)、[Dubbo 治理](#/mw/dubbo-practice)） |

```yaml
# Argo Rollouts 金丝雀示例（节选）
strategy:
  canary:
    steps:
      - setWeight: 5
      - pause: { duration: 5m }
      - analysis: { templates: [ { templateName: success-rate } ] }   # 查询 Prometheus：错误率/延迟，不达标自动回滚
      - setWeight: 25
      - pause: { duration: 10m }
      - setWeight: 50
      - pause: { duration: 10m }
```

**验证指标**：错误率（5xx）、P95/P99 延迟、**业务指标**（下单成功率、支付成功率）、JVM（GC、内存）、依赖（数据库/缓存延迟）、日志中新出现的异常。**要拿“金丝雀 vs 基线”同时间段对比**，而不是与历史对比（避免流量波动误判）。

### 4. 影子流量（Shadow / 流量镜像）

把线上请求**复制一份**发给新版本，**响应丢弃**，不影响用户。用于验证新版本在真实流量下的性能与正确性（尤其重构、迁移、替换存储）。

- 工具：Nginx `mirror`、Istio mirror、GoReplay、自研；
- **注意副作用**：影子请求不能写真实数据、不能发短信/扣款——需要**写入隔离（影子库/打标过滤/ mock 外部）**；
- 常用于：新旧系统**对比验证（diff）**、数据库/缓存/搜索引擎迁移、性能压测。

### 5. 对比与选型

| | 滚动 | 蓝绿 | 金丝雀 | 影子 |
| --- | --- | --- | --- | --- |
| 用户暴露 | 逐批全员 | 切换后全员 | **小比例** | 无 |
| 回滚速度 | 慢（再滚） | **最快** | 快（切回） | — |
| 额外资源 | 少 | 双倍 | 少~中 | 中 |
| 版本并存 | 有 | 基本无（切换瞬间） | 有（较长） | 有 |
| 风险控制 | 中 | 中（切换后全量） | **高** | 最高（无用户影响） |
| 适用 | 常规无状态服务 | 高要求快回滚 | **核心/高风险变更** | 重大重构/迁移验证 |

**经验**：日常变更滚动 + 就绪探针 + 监控；核心链路（交易、支付）用**金丝雀 + 自动分析**；大改造用**影子流量**先验证；任何方案都配**特性开关**。

## 三、特性开关（Feature Flag）

把“**代码上线**”与“**功能对用户生效**”分开：新功能代码带着开关一起部署，默认关闭，之后在线上按比例/人群逐步开启，**出问题时关闭开关就是回滚，无需重新发布**。

```java
if (flags.isEnabled("new-pricing-engine", user)) {      // 按用户/比例/租户/环境判断
    return newPricing.calculate(order);
} else {
    return oldPricing.calculate(order);
}
```

| 开关类型 | 生命周期 | 说明 |
| --- | --- | --- |
| **发布开关** | 短（功能全量后删除） | 控制未完成/高风险功能 |
| **实验开关**（A/B） | 中 | 比较不同方案的业务指标 |
| **运维开关**（熔断/降级） | 长期保留 | 大促时关闭非核心功能、紧急降级（见 [限流、熔断与降级](#/distributed/governance)） |
| **权限开关** | 长期 | 按套餐/租户开放功能 |

最佳实践与坑：

- 开关**必须有负责人和清理时间**，全量后及时删除分支代码，否则代码里会堆积大量“僵尸开关”，组合爆炸难以测试；
- **默认值要安全**（配置中心不可用时回落到关闭/旧逻辑），开关读取要有**本地缓存**避免每次请求都远程调用；
- 开关变更要**审计、可回滚、分环境**，并与发布事件一同出现在监控注解里；
- 工具：Unleash、Flagsmith、LaunchDarkly、Apollo/Nacos 配置中心自建、OpenFeature（标准 API）；
- 测试两种状态都要覆盖；**不要把开关嵌套过深**。

## 四、数据库变更：最难回滚的部分

应用回滚很快，**数据库结构和数据变更往往不可逆**，并且**新旧版本应用会同时访问同一个库**（滚动/灰度期间）。所以必须满足：**任何时刻，数据库结构同时兼容“上一个版本”和“下一个版本”的应用**。

### 1. 扩展-收缩（Expand / Contract）模式

以“把 `user.name` 拆成 `first_name` + `last_name`”为例，**分多次独立发布**：

<figure class="fig">
<svg viewBox="0 0 800 330" class="dg" role="img" aria-label="扩展收缩模式：第一步扩展数据库添加新列新旧代码都兼容；第二步发布新代码双写新旧列；第三步后台迁移历史数据；第四步发布新代码只读新列；第五步收缩，确认无人使用后删除旧列；每一步都可单独回滚">
<rect class="b3" x="20" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="90" y="54" text-anchor="middle" dominant-baseline="middle">① 扩展</text>
<text class="ts" x="90" y="76" text-anchor="middle">加新列（可空）</text>
<text class="ts" x="90" y="94" text-anchor="middle">旧代码不受影响</text>
<rect class="b5" x="175" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="245" y="54" text-anchor="middle" dominant-baseline="middle">② 双写</text>
<text class="ts" x="245" y="76" text-anchor="middle">新代码同时写</text>
<text class="ts" x="245" y="94" text-anchor="middle">旧列 + 新列，读旧列</text>
<rect class="b2" x="330" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="400" y="54" text-anchor="middle" dominant-baseline="middle">③ 回填</text>
<text class="ts" x="400" y="76" text-anchor="middle">分批迁移历史数据</text>
<text class="ts" x="400" y="94" text-anchor="middle">限速、可重入、校验</text>
<rect class="b1" x="485" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="555" y="54" text-anchor="middle" dominant-baseline="middle">④ 切读</text>
<text class="ts" x="555" y="76" text-anchor="middle">新代码读新列</text>
<text class="ts" x="555" y="94" text-anchor="middle">仍写两列（可回退）</text>
<rect class="b4" x="640" y="30" width="140" height="80" rx="10"/>
<text class="tb" x="710" y="54" text-anchor="middle" dominant-baseline="middle">⑤ 收缩</text>
<text class="ts" x="710" y="76" text-anchor="middle">停写旧列，观察后</text>
<text class="ts" x="710" y="94" text-anchor="middle">删除旧列</text>
<line class="l" x1="160" y1="70" x2="175" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="315" y1="70" x2="330" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="70" x2="485" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="625" y1="70" x2="640" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="140" width="760" height="170" rx="10"/>
<text class="th" x="36" y="164">规则</text>
<text class="ts" x="36" y="188">• 每一步都是独立发布，任何一步都能安全回滚到上一步（因为结构始终兼容新旧代码）</text>
<text class="ts" x="36" y="210">• 删除/重命名/改类型这类“破坏性变更”，永远放在最后一步，且要等旧版本代码完全下线并观察一段时间</text>
<text class="ts" x="36" y="232">• 不要把“改库结构 + 改代码”放在同一次发布里（滚动期间新旧代码并存会炸）</text>
<text class="ts" x="36" y="254">• 重命名 = 加新列 + 迁移 + 删旧列；不要直接 RENAME COLUMN</text>
<text class="ts" x="36" y="276">• 新增 NOT NULL 列：先加可空/带默认值 → 回填 → 再加约束</text>
<text class="ts" x="36" y="298">• 回填用小批量、限速、避开高峰，监控主从延迟与锁等待</text>
</svg>
<figcaption>图 3：扩展-收缩：把一次破坏性变更拆成多次兼容发布</figcaption>
</figure>

### 2. 大表 DDL 的风险

| 风险 | 说明 / 对策 |
| --- | --- |
| **长时间锁表** | MySQL 5.6+ 支持 Online DDL，但仍可能短暂持有元数据锁（MDL）；**长事务会阻塞 DDL，DDL 又阻塞后续所有查询**，引发雪崩。变更前检查长事务，设置 `lock_wait_timeout` |
| **主从延迟** | 大表改结构在从库重放耗时长；用 **gh-ost / pt-online-schema-change** 做影子表复制 + 切换，可限速、可暂停 |
| 加索引 | 大表加索引用 Online DDL 或工具，选低峰，监控 IO 与延迟（见 [SQL 调优与索引](#/mysql/optimize)） |
| **PostgreSQL** | `CREATE INDEX CONCURRENTLY`；加默认值列在新版本较轻量；注意 `ALTER` 的锁级别（见 [PostgreSQL](#/pg/ops)） |
| 数据订正脚本 | 分批（按主键范围）、每批小事务、可重入、有回滚方案、先在预发验证、**先备份** |

### 3. 数据库版本管理

用 **Flyway / Liquibase** 把变更脚本版本化、纳入 Git 与流水线，应用启动或独立 Job 执行：

```sql
-- db/migration/V2026_10_12_01__add_user_first_last_name.sql
ALTER TABLE `user` ADD COLUMN first_name VARCHAR(64) NULL, ADD COLUMN last_name VARCHAR(64) NULL, ALGORITHM=INPLACE, LOCK=NONE;
```

```yaml
spring.flyway:
  enabled: true
  locations: classpath:db/migration
  baseline-on-migrate: true
  out-of-order: false
```

要点：**已发布的迁移脚本绝不修改**（校验和会失败），只能新增版本；生产环境建议**迁移作为独立步骤/Job 先执行**，而不是多个实例启动时抢着迁移；Flyway 的多实例并发由元数据表加锁保证只执行一次，但长迁移会拖慢启动并让探针超时。

## 五、其他兼容性

| 对象 | 兼容规则 |
| --- | --- |
| **HTTP/RPC 接口** | 只**新增**字段/接口，不删除、不改语义、不改必填；废弃的先标记 deprecated，观察调用方清零后再下线；请求/响应反序列化要**忽略未知字段**（Jackson `FAIL_ON_UNKNOWN_PROPERTIES=false`）。Protobuf 的字段编号规则见 [gRPC](#/mw/grpc) |
| **消息/事件** | 同接口：新增可选字段；订阅方先于发布方升级（能处理新格式）；Schema 版本化（见 [事件驱动架构](#/design/event-driven)） |
| **缓存数据** | 序列化格式、key 结构变化时，新旧版本读到对方写入的缓存会出错 → 带版本前缀（`v2:user:1`），或发布期间双写/先清理 |
| **配置** | 新版本读新配置项时要有默认值；配置变更与代码发布的先后顺序要明确 |
| **依赖服务** | 先发布被依赖方（提供者），再发布调用方（消费者）；强依赖变更要有版本协商 |
| **会话/序列化类** | Java 原生序列化的 `serialVersionUID`、Session 中存的对象结构变化会导致反序列化失败，滚动期间尤其危险 |

**发布顺序口诀**：**先数据库扩展 → 再被依赖服务 → 再依赖方 → 最后清理**。

## 六、发布过程的工程细节

### 1. 优雅停机与预热

- **旧实例下线**：先从注册中心/Service 摘除流量 → 等待在途请求处理完 → 再关闭（K8s：`preStop` sleep + `terminationGracePeriodSeconds`；Spring Boot `server.shutdown=graceful`；注意 PID 1 信号问题，见 [进程与调度](#/cs/os-process)）；
- **新实例预热**：JIT 冷启动、连接池/缓存未建立，直接接满流量会 P99 飙升；做法：就绪探针等预热完成再接流量、注册中心**小权重逐步放量**（Dubbo 预热 `warmup`）、启动时加载热点缓存、必要时 CDS/AppCDS 或 GraalVM Native 加速启动；
- **探针要准确**：readiness 检查依赖是否真正可用（但不要因下游短暂抖动让所有实例一起不就绪）；启动慢的应用用 `startupProbe`。

### 2. 定时任务与消息消费

- 发布期间**定时任务不要重复执行/漏执行**（分布式调度单点执行、幂等）；
- 消费者滚动重启会触发**消费组重平衡**，导致短暂暂停与重复消费 → 消费幂等、使用 cooperative-sticky 分区分配策略（见 [Kafka](#/mw/kafka)）；
- 长耗时任务要**可中断/可恢复**。

### 3. 发布时间与流程

- **避开高峰与大促**；设立变更窗口与冻结期；
- **变更评审与审批**（核心系统）、发布通知（群/看板）、**值班人员盯监控**；
- 变更**打注解**到监控大盘（Grafana Annotation），事故排查时第一眼对照“发布时间点”（见 [指标监控](#/infra/obs-metrics)）。

## 七、回滚

| 层面 | 回滚方式 | 速度 |
| --- | --- | --- |
| 特性开关 | 关闭开关 | **秒级** |
| 流量切换（蓝绿/金丝雀） | 切回旧版本/权重归零 | 秒~分钟 |
| 应用版本 | `kubectl rollout undo` / ArgoCD 回退提交 / 重新部署上一镜像 | 分钟 |
| 配置 | 配置中心回退版本 | 秒~分钟 |
| 数据库 | **通常无法回滚**；靠扩展-收缩、备份、前向修复（发 hotfix） | 慢/不可 |

原则：

- **回滚方案在发布前就准备好并演练**，而不是出事后现想；
- 判断**“回滚还是前向修复”**：能回滚就先回滚止血（再排查）；数据已被新版本写入、回滚会丢数据时，评估前向修复；
- **回滚后要确认**：指标恢复、数据一致、消息与缓存无残留的新格式数据；
- **自动回滚**：金丝雀分析不达标自动终止并回退，缩短“发现→止血”时间（MTTR）。

## 八、发布检查清单

| 阶段 | 检查项 |
| --- | --- |
| **发布前** | ☐ 变更范围与风险评估　☐ 数据库变更向后兼容并已在预发验证　☐ 接口/消息/缓存兼容　☐ 特性开关默认关闭　☐ 回滚方案与负责人　☐ 监控与告警覆盖新功能（指标、日志、链路）　☐ 容量评估/压测（高风险变更）　☐ 依赖方已就绪（先后顺序）　☐ 非高峰时间、值班就位 |
| **发布中** | ☐ 先灰度小流量　☐ 对比新旧版本指标（错误率、延迟、业务指标）　☐ 观察日志新异常　☐ 逐步放量，每步停留足够观察　☐ 异常立即回滚/关开关 |
| **发布后** | ☐ 全量后继续观察一个业务周期　☐ 清理旧版本/旧开关/旧列（收缩）　☐ 复盘（若有问题）、更新文档与 Runbook　☐ 发布记录与变更日志 |

## 九、常见坑

| 坑 | 对策 |
| --- | --- |
| 同一次发布里改表结构+代码，滚动期间新旧并存报错 | 扩展-收缩，分多次发布 |
| 直接 `RENAME COLUMN`/删列，回滚时旧代码崩溃 | 加新列迁移，最后才删旧列 |
| 大表 DDL 阻塞线上（MDL 锁堆积） | 检查长事务、gh-ost/pt-osc、设置锁超时、低峰执行 |
| 灰度只看技术指标，不看业务指标 | 把成功率/转化率纳入自动分析 |
| 灰度用户来回跳版本 | 按用户 ID 哈希/粘性分流 |
| 特性开关越积越多，无人清理 | 开关登记负责人与过期时间，定期清理 |
| 缓存/序列化格式不兼容导致滚动期间报错 | key 带版本；兼容读取；先清缓存 |
| 优雅停机失效，发布时 5xx 抖动 | 摘流量 + preStop + 优雅关闭 + 超时设置，PID 1 信号转发 |
| 新实例未预热直接承压 | readiness + 小权重预热 |
| 发布完无人盯监控，问题晚发现 | 发布事件打注解 + 自动分析 + 值班 |
| 回滚方案没演练，真到用时失败 | 定期演练、回滚脚本化 |
| Fork 出来的长期灰度版本，两套逻辑长期并存 | 设灰度时限，达到结论后收口 |

## 相关阅读

- [配置管理与全链路灰度](#/spring/cloud-config-gray)：微服务全链路灰度与配置变更治理

## 面试追问

> [!QUESTION] 滚动、蓝绿、金丝雀发布的区别和适用场景？
> 滚动逐批替换实例，简单省资源但新旧版本并存且回滚较慢；蓝绿维护两套环境，验证后整体切流，回滚是秒级切回但需要双倍资源；金丝雀先放小比例流量并对比指标逐步放大，影响面最小，适合核心高风险变更。常规服务用滚动加探针，核心链路用金丝雀加自动分析。

> [!QUESTION] 灰度发布怎么做？如何保证同一个用户体验一致？
> 通过网关、服务网格或标签路由按比例、用户白名单、地域或请求头把一部分流量导向新版本，同时对比新旧版本的错误率、延迟和业务指标，正常再逐步放量，异常自动回滚。按用户 ID 哈希做粘性分流可以避免同一用户在版本间来回跳，全链路灰度需要把灰度标记在调用链中透传。

> [!QUESTION] 特性开关解决什么问题？有什么风险？
> 它把代码部署与功能发布解耦，新功能带开关上线默认关闭，可按人群渐进开启，出问题关开关即回滚，也用于 A/B 实验和大促降级。风险是僵尸开关堆积、组合爆炸难测试、配置中心故障时默认值不安全，需要登记负责人和过期时间、本地缓存和安全默认值。

> [!QUESTION] 数据库变更如何做到可以安全发布和回滚？
> 采用扩展-收缩模式，把破坏性变更拆成多次兼容发布：先加新列，再双写，回填历史数据，切读，最后确认无人使用后删除旧列，任何时刻库结构都兼容新旧两个版本的应用，每一步可单独回滚。大表 DDL 用 Online DDL 或 gh-ost，避开长事务，变更脚本用 Flyway 版本化。

> [!QUESTION] 滚动发布期间接口或消息格式怎么保证兼容？
> 只新增可选字段，不删除或改语义，消费方忽略未知字段；先升级被依赖方再升级调用方，订阅方先于发布方升级；缓存 key 或序列化格式变化时带版本前缀；废弃接口先标记并观察调用清零再下线。

> [!QUESTION] 发布时怎么避免请求失败和性能抖动？
> 旧实例先摘流量，等在途请求处理完再优雅关闭，配合 preStop 与优雅停机并注意 PID 1 信号；新实例通过就绪探针和预热后再接流量，小权重逐步放量，避免 JIT 和缓存冷启动导致 P99 飙升；消费者重启要处理重平衡与幂等。

> [!QUESTION] 出了线上问题，回滚还是前向修复？
> 能快速回滚就先回滚止血再排查，优先关特性开关、切流量、回退版本；若新版本已写入不兼容数据或数据库变更不可逆，回滚会丢数据或失败，则评估前向修复。因此要在发布前准备并演练回滚方案，并让数据库变更向后兼容。
