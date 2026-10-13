---
level: 深入
tags: [物联网平台, 设备管理, 设备影子, 物模型, OTA, 时序数据库, 边缘计算, Modbus, 安全]
summary: 从零设计一个 IoT 平台：整体分层架构、设备认证与生命周期、物模型与设备影子、指令下发与 OTA、时序数据存储与规则告警，以及边缘网关、工业协议接入和安全治理。
---

# IoT 平台架构与设备管理

> [!ABSTRACT] 核心要点
> - IoT 平台分四层：**设备/边缘层 → 接入层（Broker/网关）→ 平台服务层（设备管理、规则引擎、数据处理）→ 应用层**；核心是**海量连接 + 海量时序数据 + 双向通信**。
> - **物模型**（属性/事件/服务）把不同厂商设备抽象成统一模型；**设备影子（Device Shadow）** 让云端在设备离线时仍可“读状态、写期望值”，设备上线后同步。
> - 数据是**追加写、按时间查**的**时序数据**：热数据进时序库（TimescaleDB/InfluxDB/TDengine），冷数据归档到对象存储/列存；**降采样与保留策略**控制成本。
> - 设备安全是底线：**每设备唯一凭证、双向 TLS、最小权限 ACL、固件签名、安全启动、密钥不入固件明文**。
> - 边缘侧要有**本地自治**：断网时本地缓存、规则本地执行、恢复后补传，工业现场再通过 **Modbus/OPC UA 网关**接入。

## 平台整体架构

<figure class="fig">
<svg viewBox="0 0 760 420" class="dg" role="img" aria-label="IoT 平台分层架构：设备边缘层、接入层、平台服务层、数据存储、应用层">
<rect class="bg" x="20" y="14" width="720" height="70" rx="10"/>
<text class="th" x="36" y="36">设备与边缘层</text>
<rect class="b" x="40" y="46" width="110" height="28" rx="6"/>
<text class="ts" x="95" y="60" text-anchor="middle" dominant-baseline="middle">传感器/MCU</text>
<rect class="b" x="160" y="46" width="130" height="28" rx="6"/>
<text class="ts" x="225" y="60" text-anchor="middle" dominant-baseline="middle">智能终端/车载</text>
<rect class="b" x="300" y="46" width="170" height="28" rx="6"/>
<text class="ts" x="385" y="60" text-anchor="middle" dominant-baseline="middle">边缘网关（Modbus/OPC UA）</text>
<rect class="b" x="480" y="46" width="240" height="28" rx="6"/>
<text class="ts" x="600" y="60" text-anchor="middle" dominant-baseline="middle">LoRa / NB-IoT / 4G / WiFi 接入</text>
<rect class="bg" x="20" y="98" width="720" height="62" rx="10"/>
<text class="th" x="36" y="120">接入层</text>
<rect class="b3" x="40" y="128" width="190" height="24" rx="6"/>
<text class="ts" x="135" y="140" text-anchor="middle" dominant-baseline="middle">MQTT Broker 集群（EMQX）</text>
<rect class="b3" x="240" y="128" width="200" height="24" rx="6"/>
<text class="ts" x="340" y="140" text-anchor="middle" dominant-baseline="middle">私有协议网关（Netty）</text>
<rect class="b3" x="450" y="128" width="130" height="24" rx="6"/>
<text class="ts" x="515" y="140" text-anchor="middle" dominant-baseline="middle">HTTP / CoAP 网关</text>
<rect class="b3" x="590" y="128" width="130" height="24" rx="6"/>
<text class="ts" x="655" y="140" text-anchor="middle" dominant-baseline="middle">认证 / ACL</text>
<rect class="b4" x="20" y="174" width="720" height="40" rx="10"/>
<text class="tb" x="380" y="194" text-anchor="middle" dominant-baseline="middle">消息总线 Kafka：上行数据 · 事件 · 指令 · 解耦与削峰</text>
<rect class="bg" x="20" y="228" width="720" height="86" rx="10"/>
<text class="th" x="36" y="250">平台服务层</text>
<rect class="b2" x="40" y="260" width="120" height="44" rx="6"/>
<text class="tb" x="100" y="282" text-anchor="middle" dominant-baseline="middle">设备管理</text>
<rect class="b2" x="170" y="260" width="120" height="44" rx="6"/>
<text class="tb" x="230" y="282" text-anchor="middle" dominant-baseline="middle">物模型/影子</text>
<rect class="b2" x="300" y="260" width="120" height="44" rx="6"/>
<text class="tb" x="360" y="282" text-anchor="middle" dominant-baseline="middle">规则/告警</text>
<rect class="b2" x="430" y="260" width="120" height="44" rx="6"/>
<text class="tb" x="490" y="282" text-anchor="middle" dominant-baseline="middle">指令/OTA</text>
<rect class="b2" x="560" y="260" width="160" height="44" rx="6"/>
<text class="tb" x="640" y="282" text-anchor="middle" dominant-baseline="middle">数据处理(Flink)</text>
<rect class="bg" x="20" y="328" width="440" height="80" rx="10"/>
<text class="th" x="36" y="350">存储</text>
<text class="ts" x="36" y="374">时序库 TimescaleDB/InfluxDB/TDengine · 关系库 PG/MySQL</text>
<text class="ts" x="36" y="394">Redis（在线状态、影子缓存）· 对象存储（固件、归档）</text>
<rect class="bg" x="480" y="328" width="260" height="80" rx="10"/>
<text class="th" x="496" y="350">应用层</text>
<text class="ts" x="496" y="374">控制台 · 开放 API · 大屏 · 小程序</text>
<text class="ts" x="496" y="394">数据分析 · 报表 · 第三方集成</text>
<line class="l" x1="380" y1="84" x2="380" y2="98" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="160" x2="380" y2="174" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="214" x2="380" y2="228" marker-end="url(#arr)"/>
<line class="l" x1="240" y1="314" x2="240" y2="328" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="314" x2="610" y2="328" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：IoT 平台的分层架构</figcaption>
</figure>

设计原则：

1. **接入与业务解耦**：接入层只做连接、认证、协议处理与分发，业务通过 Kafka 异步处理；
2. **上行与下行分离**：上行追求吞吐，下行追求可靠与到达确认；
3. **多租户与隔离**：产品/租户维度的 ACL、限流、配额、数据隔离；
4. **可观测**：连接数、消息速率、丢弃、延迟、设备在线率作为一等指标；
5. **水平扩展**：接入层（按连接数）、处理层（按吞吐）、存储层（按分区/分片）分别扩展。

## 设备身份与生命周期

### 三元组与认证方式

| 方式 | 说明 | 适用 |
| --- | --- | --- |
| **ProductKey + DeviceName + DeviceSecret（三元组）** | 平台生成，每设备唯一；连接时用 HMAC 签名生成密码 | 通用，云厂商常见 |
| **X.509 设备证书（mTLS）** | 私有 CA 签发，双向认证，可吊销 | **高安全**场景（车联网、工业） |
| 一型一密（动态注册） | 同型号共享 ProductSecret，设备首次用其注册换取自己的 DeviceSecret | 量产烧录简化 |
| Token / JWT | 短期令牌，由网关/注册服务颁发 | 手机、网关代理 |

```text
MQTT CONNECT：
  clientId  = {deviceName}|securemode=2,signmethod=hmacsha256,timestamp=1700000000|
  username  = {deviceName}&{productKey}
  password  = hmacsha256(deviceSecret, "clientId{id}deviceName{name}productKey{pk}timestamp{ts}")
```

（该格式为典型示意，具体以所用平台协议为准。）关键点：**密码是带时间戳的签名，不直接传输 DeviceSecret**，服务端用同样算法验证；防重放需校验时间戳窗口。

### 生命周期

<figure class="fig">
<svg viewBox="0 0 740 200" class="dg" role="img" aria-label="设备生命周期状态：未激活、已激活在线、离线、禁用、注销">
<rect class="b" x="20" y="70" width="100" height="50" rx="8"/>
<text class="tb" x="70" y="90" text-anchor="middle" dominant-baseline="middle">已注册</text>
<text class="ts" x="70" y="108" text-anchor="middle">未激活</text>
<rect class="b2" x="170" y="70" width="110" height="50" rx="8"/>
<text class="tb" x="225" y="90" text-anchor="middle" dominant-baseline="middle">在线</text>
<text class="ts" x="225" y="108" text-anchor="middle">首次连接即激活</text>
<rect class="b3" x="340" y="70" width="110" height="50" rx="8"/>
<text class="tb" x="395" y="90" text-anchor="middle" dominant-baseline="middle">离线</text>
<text class="ts" x="395" y="108" text-anchor="middle">心跳超时 / 遗嘱</text>
<rect class="b4" x="510" y="70" width="100" height="50" rx="8"/>
<text class="tb" x="560" y="90" text-anchor="middle" dominant-baseline="middle">已禁用</text>
<text class="ts" x="560" y="108" text-anchor="middle">拒绝连接</text>
<rect class="b" x="650" y="70" width="80" height="50" rx="8"/>
<text class="tb" x="690" y="90" text-anchor="middle" dominant-baseline="middle">已注销</text>
<line class="l" x1="120" y1="95" x2="170" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="85" x2="340" y2="85" marker-end="url(#arr)"/>
<line class="l" x1="340" y1="106" x2="280" y2="106" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="95" x2="510" y2="95" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="95" x2="650" y2="95" marker-end="url(#arr)"/>
<text class="ts" x="310" y="76" text-anchor="middle">断线</text>
<text class="ts" x="310" y="124" text-anchor="middle">重连</text>
<text class="ts" x="380" y="170" text-anchor="middle">在线状态由 Broker 的连接/断开事件驱动写入 Redis，设备管理服务据此更新；任何状态都可以被管理员禁用</text>
</svg>
<figcaption>图 2：设备生命周期与在线状态</figcaption>
</figure>

在线状态维护：订阅 Broker 的 `client.connected/disconnected` 事件（或规则引擎事件源）→ 写 **Redis**（`SET online:{deviceId} {nodeId:connSeq} EX 心跳超时`）+ 异步落库；判断以**最新连接序号/时间戳**为准，防止旧连接的断开事件覆盖新连接的在线状态。

## 物模型与设备影子

### 物模型（TSL）

用统一的**属性（Property）/ 事件（Event）/ 服务（Service）**描述一类设备：

```json
{
  "productKey": "thermo-v2",
  "properties": [
    { "id": "temperature", "name": "温度", "type": "float", "unit": "℃", "access": "r",  "range": [-40, 125] },
    { "id": "targetTemp",  "name": "目标温度", "type": "float", "access": "rw", "range": [5, 35] }
  ],
  "events": [
    { "id": "overheat", "name": "过热告警", "level": "critical", "params": [{ "id": "temp", "type": "float" }] }
  ],
  "services": [
    { "id": "reboot", "name": "重启", "input": [], "output": [{ "id": "code", "type": "int" }] }
  ]
}
```

价值：**屏蔽设备差异**，平台能校验数据合法性、生成界面、做统一规则与分析；设备端上报 `{"temperature": 26.5}` 按物模型解析与入库。

### 设备影子（Device Shadow / Twin）

设备经常**离线或休眠**，应用不能依赖“此刻设备在线”。影子是云端保存的**设备状态 JSON 镜像**：

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="设备影子：应用写入期望状态，设备上线后同步并上报实际状态，云端计算差异">
<rect class="b1" x="20" y="100" width="100" height="56" rx="8"/>
<text class="tb" x="70" y="128" text-anchor="middle" dominant-baseline="middle">应用 / API</text>
<rect class="b3" x="240" y="30" width="260" height="210" rx="12"/>
<text class="th" x="370" y="54" text-anchor="middle">设备影子（云端）</text>
<text class="tm" x="260" y="86" text-anchor="start">desired : { "targetTemp": 22 }</text>
<text class="tm" x="260" y="112" text-anchor="start">reported: { "targetTemp": 20,</text>
<text class="tm" x="260" y="136" text-anchor="start">            "temperature": 25.1 }</text>
<text class="tm" x="260" y="162" text-anchor="start">delta   : { "targetTemp": 22 }</text>
<text class="ts" x="260" y="192" text-anchor="start">version 递增，防止旧写覆盖</text>
<text class="ts" x="260" y="214" text-anchor="start">delta = desired 与 reported 的差异</text>
<rect class="b2" x="620" y="100" width="100" height="56" rx="8"/>
<text class="tb" x="670" y="128" text-anchor="middle" dominant-baseline="middle">设备</text>
<line class="l" x1="120" y1="128" x2="240" y2="128" marker-end="url(#arr)"/>
<text class="ts" x="180" y="118" text-anchor="middle">① 写 desired</text>
<line class="la" x1="500" y1="110" x2="620" y2="110" marker-end="url(#arr-a)"/>
<text class="ta" x="560" y="100" text-anchor="middle">② 上线后收到 delta</text>
<line class="l" x1="620" y1="146" x2="500" y2="146" marker-end="url(#arr)"/>
<text class="ts" x="560" y="164" text-anchor="middle">③ 执行后上报 reported</text>
<text class="ts" x="370" y="272" text-anchor="middle">应用读影子即得“最后已知状态”，写 desired 即“最终要达到的状态”，设备离线也不丢意图</text>
</svg>
<figcaption>图 3：设备影子的 desired / reported / delta 机制</figcaption>
</figure>

- 应用**写 `desired`**，设备**上线或订阅到变更**时拉取 delta、执行，完成后**写 `reported`**；
- 影子带**版本号**，写入用乐观并发（带 version 的 CAS），防止并发覆盖；
- 存储：**Redis 缓存 + PG/MySQL（JSONB）持久化**；高频读用缓存，写走异步落库；
- 与“指令”的区别：指令偏**一次性动作**（重启、拍照，需要应答与超时），影子偏**状态收敛**（目标温度、开关）。

## 指令下发与 OTA

### 指令（见 [MQTT 协议详解](#/iot/mqtt)）

| 模式 | 说明 | 适用 |
| --- | --- | --- |
| 在线指令（同步语义） | 下发后等待设备应答，超时失败 | 控制类（开关、重启） |
| 离线指令（异步） | 设备离线时由持久会话或平台缓存，上线后下发；**设置有效期** | 配置类 |
| 影子（期望状态） | 写 desired，设备上线收敛 | 状态类 |

流程要点：`msgId` 全局唯一 → 状态机（待下发 → 已下发 → 已应答/超时/失败）→ 超时与重试上限 → 设备端按 `msgId` 去重 → 全程审计。

### OTA 固件升级

<figure class="fig">
<svg viewBox="0 0 740 240" class="dg" role="img" aria-label="OTA 升级流程：平台通知、设备下载固件、校验、升级与结果上报">
<rect class="b1" x="20" y="60" width="120" height="60" rx="8"/>
<text class="tb" x="80" y="82" text-anchor="middle" dominant-baseline="middle">1 创建升级任务</text>
<text class="ts" x="80" y="104" text-anchor="middle">灰度范围 / 签名</text>
<rect class="b3" x="170" y="60" width="120" height="60" rx="8"/>
<text class="tb" x="230" y="82" text-anchor="middle" dominant-baseline="middle">2 MQTT 通知</text>
<text class="ts" x="230" y="104" text-anchor="middle">版本 · URL · MD5/SHA</text>
<rect class="b3" x="320" y="60" width="120" height="60" rx="8"/>
<text class="tb" x="380" y="82" text-anchor="middle" dominant-baseline="middle">3 HTTPS 下载</text>
<text class="ts" x="380" y="104" text-anchor="middle">断点续传 · CDN</text>
<rect class="b5" x="470" y="60" width="120" height="60" rx="8"/>
<text class="tb" x="530" y="82" text-anchor="middle" dominant-baseline="middle">4 校验与刷写</text>
<text class="ts" x="530" y="104" text-anchor="middle">验签 · A/B 分区</text>
<rect class="b2" x="620" y="60" width="100" height="60" rx="8"/>
<text class="tb" x="670" y="82" text-anchor="middle" dominant-baseline="middle">5 上报结果</text>
<text class="ts" x="670" y="104" text-anchor="middle">成功/回滚</text>
<line class="l" x1="140" y1="90" x2="170" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="290" y1="90" x2="320" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="440" y1="90" x2="470" y2="90" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="90" x2="620" y2="90" marker-end="url(#arr)"/>
<text class="ts" x="370" y="170" text-anchor="middle">大文件不走 MQTT：MQTT 只下发通知，固件走 HTTPS/CDN；全量用 A/B 双分区，失败自动回滚</text>
<text class="ts" x="370" y="192" text-anchor="middle">灰度：按比例/分组逐步放量，监控升级成功率与异常率，异常即暂停</text>
</svg>
<figcaption>图 4：OTA 升级流程</figcaption>
</figure>

要点：**固件签名**与设备端**验签**（防篡改）、**断点续传**、**A/B 分区 + 回滚**、**灰度与暂停**、低电量/网络条件检查、升级窗口、结果上报与审计；差分升级节省流量。

## 数据存储：时序数据

### 特点与选型

IoT 数据特征：**高写入、追加为主、按时间范围与设备维度查询、很少更新、冷热分明**。

| 方案 | 特点 | 适用 |
| --- | --- | --- |
| **TimescaleDB**（PostgreSQL 扩展） | 保留 SQL 与 PG 生态；hypertable 自动按时间分区、压缩、连续聚合 | 已使用 PG、需要关系与时序联合查询 |
| **InfluxDB** | 专用 TSDB，写入快，InfluxQL/Flux | 纯监控类指标 |
| **TDengine** | 国产专用 TSDB，一设备一表（超级表）、高压缩 | 大规模设备遥测 |
| ClickHouse | 列存分析型，聚合极快，适合明细分析 | 离线分析、报表 |
| 普通 MySQL/PG（分区表） | 小规模可用，需分区与归档 | 设备数少、写入量不大 |

PostgreSQL 上做时序，参见 [复制、高可用与实战](#/pg/ops) 的分区表与扩展、[索引类型与查询优化](#/pg/index) 的 BRIN。

### 表设计示例（TimescaleDB）

```sql
CREATE TABLE telemetry (
  ts        timestamptz NOT NULL,
  device_id bigint      NOT NULL,
  metric    text        NOT NULL,
  value     double precision,
  PRIMARY KEY (device_id, metric, ts)               -- 同时作为去重键
);
SELECT create_hypertable('telemetry', 'ts', chunk_time_interval => interval '1 day');

ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id, metric');
SELECT add_compression_policy('telemetry', interval '7 days');          -- 7 天后自动压缩（常见 10x 以上）
SELECT add_retention_policy('telemetry', interval '180 days');           -- 保留 180 天

-- 连续聚合：自动维护分钟/小时降采样
CREATE MATERIALIZED VIEW telemetry_1h WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket, device_id, metric, avg(value) AS avg, max(value) AS max
FROM telemetry GROUP BY bucket, device_id, metric;
```

### 成本与查询优化

- **写入**：批量写（攒批 500~5000 条）、`COPY`/多值 INSERT、异步入库（Kafka 消费者批量提交）；
- **降采样**：原始高频数据保留短期，长期保留分钟/小时聚合；
- **宽表 vs 窄表**：窄表（metric, value）灵活但行多；宽表（一行多指标）更省空间，物模型稳定时可用；
- **查询**：始终带**时间范围 + 设备**条件；大范围查询走聚合表；
- **最新值**：不要扫时序表取“最近一条”，用 **Redis/影子** 或“最新值表”（每设备一行 upsert）。

## 规则与告警

```text
规则：当 temperature > 80 持续 3 个周期  → 触发告警 overheat → 通知（短信/钉钉/webhook）
```

| 能力 | 做法 |
| --- | --- |
| 简单阈值/边沿 | Broker 规则引擎或服务内表达式（Aviator/SpEL） |
| 持续时间/窗口 | **Flink**（滚动/滑动窗口、`CEP`）、Kafka Streams |
| 去抖与降噪 | 持续 N 次才触发、告警静默期、同类聚合、**恢复事件**（告警→恢复闭环） |
| 告警状态 | 状态机（触发 → 确认 → 恢复）落库，避免每条数据都发通知 |
| 通知风暴控制 | 限频、分级、值班与升级 |

## 边缘计算与工业协议接入

### 边缘网关职责

- **协议转换**：Modbus RTU/TCP、OPC UA、CAN、BACnet、西门子 S7 等 → MQTT/JSON；
- **本地缓存与断点续传**：断网时落本地（SQLite/文件），恢复后按时间顺序补传（带原始时间戳，**以设备时间而非接收时间为准**）；
- **本地规则与控制**：低延迟闭环（如温度超限本地关闭阀门），不依赖云；
- **数据预处理**：过滤、去噪、死区（变化小于阈值不上报）、聚合上报，降低流量与云端压力；
- **安全**：网关承担设备代理，向云端做统一认证；子设备拓扑管理（子设备经网关接入）。

### 常见协议对比

| 协议 | 层次 | 特点 | 场景 |
| --- | --- | --- | --- |
| **Modbus** | 应用（串口/TCP） | 简单、主从轮询、寄存器模型，无安全 | 传统工业仪表、PLC |
| **OPC UA** | 应用 | 面向对象信息模型、安全、跨平台 | 工业 4.0、MES 对接 |
| **MQTT** | 应用 | 发布订阅、轻量 | 设备到云 |
| **CoAP** | 应用（UDP） | 极轻、REST 风格 | 受限设备 |
| **LoRaWAN / NB-IoT** | 网络 | 低功耗广域，数据量极小 | 抄表、环境监测 |

Java 侧读 Modbus 可用 **j2mod / Eclipse Milo（OPC UA）/ Apache PLC4X**；网关常用 Java/Go/Python，资源受限设备用 C。

## 安全体系

| 层面 | 措施 |
| --- | --- |
| 设备身份 | 每设备唯一证书/密钥；出厂烧录安全芯片（SE/TPM）存私钥；一型一密需限制注册次数 |
| 传输 | **全程 TLS 1.2+**；双向认证；证书轮换与吊销 |
| 授权 | ACL 最小权限：只能访问 `{product}/{clientid}/...`；平台 API 做租户鉴权 |
| 固件 | **签名校验**、安全启动、防回滚（版本单调递增）；禁用调试接口 |
| 数据 | 敏感字段加密；日志脱敏；保留与删除策略（合规，如个人信息保护要求） |
| 防护 | 连接/发布限速、异常行为检测（突然大量上报、非法主题）、设备封禁、DDoS 防护 |
| 供应链与运维 | 密钥管理（KMS/HSM）、审计日志、变更管控、漏洞响应与批量升级能力 |

> [!WARNING] 常见反模式
> 1. 所有设备共用一个账号密码；2. 密钥写死在固件明文且各设备相同；3. 允许设备订阅 `#`；4. 明文 MQTT 暴露公网；5. 没有设备封禁和凭证吊销能力；6. 固件不验签。其中任何一个都可能导致**一台设备被攻破即全网泄露**。

## 容量估算示例

假设 **100 万设备**，每设备 **每分钟上报 1 条**，单条 **约 200 字节**：

```text
消息速率  = 1,000,000 / 60 ≈ 16,700 msg/s（峰值常按 3~5 倍估算 → 5~8 万 msg/s）
上行带宽  ≈ 16,700 × 200B ≈ 3.3 MB/s（加协议头约 5~6 MB/s）
日数据量  = 1,000,000 × 1440 = 14.4 亿条/天 ≈ 288 GB/天（原始；时序库压缩后常见可降到约 1/10 量级）
连接内存  ≈ 100 万 × 数十 KB（Broker）= 数十 GB
```

据此决定：Broker 集群节点数、Kafka 分区数、消费组并发、时序库分片与压缩、保留周期；**用压测验证**，并为重连风暴预留余量（见 [Broker 架构与集群（EMQX）](#/iot/broker)）。

## 相关阅读

- [InfluxDB 数据模型与存储引擎](#/db/influx-model)：InfluxDB 数据模型
- [ClickHouse 行为分析：漏斗、留存与近似计算](#/bigdata/ck-analytics)：用 ClickHouse 做设备数据分析
- [加密、签名、HTTPS 与密钥管理](#/security/crypto)：设备认证与 mTLS
- [弱网、可靠性、安全与排障：MQTT 工程实践](#/iot/mqtt-practice)：指令可靠性与上行补传
- [MQTT 协议生态与选型：MQTT-SN、CoAP、Sparkplug B 与 QUIC](#/iot/mqtt-ecosystem)：边缘网关与协议选型
- [QoS、会话与 Broker 语义：状态机、离线队列与共享订阅](#/iot/mqtt-qos-session)：在线状态与遗嘱语义

## 面试追问

> [!QUESTION] 如何设计一个支持百万设备的 IoT 平台？
> 分层：设备/边缘 → 接入层（EMQX 集群 + 私有协议网关，四层 LB）→ Kafka 缓冲 → 处理服务（设备管理、规则、数据处理）→ 存储（Redis、关系库、时序库）→ 应用层。关注连接容量、重连风暴、上下行分离、时序存储的压缩与保留、设备认证与 ACL、可观测性。

> [!QUESTION] 设备影子解决什么问题？
> 设备常离线，应用无法直接控制和读取实时状态。影子在云端保存 desired 与 reported 状态，应用读写影子即可，设备上线后同步差异；带版本号防并发覆盖，实现离线状态下的最终一致控制。

> [!QUESTION] 时序数据为什么不直接用 MySQL 存？
> 写入量大且追加为主，查询按时间与设备范围，数据量增长快；普通 B+ 树索引的写放大和存储开销大，需要自行分区与归档。时序库提供按时间自动分区、高压缩、降采样与保留策略，写入和范围查询更高效。

> [!QUESTION] 如何保证 OTA 升级安全可靠？
> 固件签名与设备验签、HTTPS 传输、校验摘要、A/B 分区失败回滚、断点续传、灰度发布与成功率监控、防回滚版本检查，以及升级结果审计。

> [!QUESTION] 边缘网关的价值是什么？
> 协议转换（Modbus/OPC UA 到 MQTT），断网时本地缓存并补传，本地规则实现低延迟控制，数据预处理降低上云流量，并作为子设备的统一安全代理。
