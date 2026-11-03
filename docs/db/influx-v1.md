---
level: 深入
tags: [InfluxDB, 1.x, TSM, WAL, Cache, Compaction, TSI, Shard, Retention Policy, 删除, tombstone, 企业版集群, SELECT INTO]
summary: InfluxDB 1.x 内部原理：点的唯一性与基数、磁盘布局、写入链路（WAL / Cache / 快照）、TSM 文件格式与压缩编码、Compaction 层级、读取链路与内存模型、inmem 与 tsi1 索引、Shard / Retention Policy、五种删除方式的代价、企业版集群，以及用这些原理推导存储降本方案。
---

# InfluxDB 1.x 原理详解：TSM、读写链路、索引、Shard 与删除机制

> [!ABSTRACT] 核心要点
> - 一个点由 **series key + 时间戳**唯一确定：同一 field 重复写入会**覆盖**，不同 field 分次写入会**合并成一行**。**series 基数**是 1.x 性能的头号杀手。
> - 写入链路：**校验 → 路由到 shard → 写索引 → 写 WAL（持久）→ 写 Cache（内存）→ 返回 204**；Cache 达阈值后**异步快照**成不可变的 TSM 文件。
> - **TSM 是列式、不可变、按类型专用编码**：时间戳用 Delta+RLE、浮点用 Gorilla XOR、整数用 ZigZag+Simple8b，**string 只能用通用的 Snappy，压缩最差**。
> - **删除的代价差别极大**：删整个目录（`DROP SHARD`、保留期过期）几乎免费；`DELETE` 要写 tombstone 并让 compaction **重写整个 shard**，磁盘还会先涨后降。设计数据布局时就要让“将来要删的数据”按时间或 RP 物理隔离。
> - **索引类型决定大规模删除的风险**：`inmem` 全在内存、启动慢、删 series 时持全局锁；`tsi1` 在磁盘 + mmap、按 shard 独立，代价低。生产上**建议用 tsi1**。
> - 查询的**内存峰值 ∝ 同时打开的迭代器数**（series 数 × field 数），**总解压量 ∝ field 数 × 时间范围**。拆分查询降的是峰值，不是总量。

> [!NOTE] 版本说明
> 本文针对 **InfluxDB 1.x**（开源版与企业版集群）。默认值取自 1.8 前后的配置，**以所用版本的官方文档为准**。2.x / 3.x 的架构差异见 [InfluxDB 数据模型与存储引擎](#/db/influx-model)，落地实战（Java 写入、降采样、选型）见 [InfluxDB 实战](#/db/influx-practice)。

## 一、数据模型的几个细节

数据模型的基本概念（measurement / tag / field / timestamp）见 [数据模型与存储引擎](#/db/influx-model)，这里只补充对后面原理有影响的几条。

```text
Database
 └── Retention Policy（RP）：保留多久、几个副本、shard 切分周期
      └── Measurement（类似“表”）
           └── Series = measurement + tag set
                └── Point = series + field set + timestamp

Line Protocol:
  measurement,tag1=v1,tag2=v2 field1=1.0,field2=2i 1730505600000000000
  └────────── series key ────┘ └───── field set ────┘ └───── timestamp ────┘
```

| 概念 | 是否索引 | 说明 |
| --- | --- | --- |
| Tag | **是** | 字符串，用于过滤和分组 |
| Field | **否** | float / int / uint / bool / string，实际测量值 |
| Series Key | 是 | measurement + 全部 tag 键值对，**索引的键** |

### 点的唯一性

一个点由 **series key + timestamp** 唯一确定：

- 同一 series、同一时间戳、**同一 field** 再写入 → **覆盖旧值**（last write wins）；
- 同一 series、同一时间戳、**不同 field** 分多次写入 → **合并为一行**。

所以**按列分批迁移数据，结果与 `SELECT *` 完全一致**；设备重传数据也天然幂等（前提是时间戳取自采集时间）。

### Series 基数

```text
基数 ≈ 各 tag 取值数量的乘积（实际为真正出现过的组合数）

例：2 万台设备 × 1 个 measurement           → 约 2 万 series
    如果再把 param_name 做成 tag（每台 150 个参数）→ 约 300 万 series
```

基数越高，索引越大、内存越高、查询越慢。**取值无限增长的值（UUID、时间、数值）不要放在 tag 里**。

## 二、整体架构与磁盘布局

```text
InfluxDB 进程
├── HTTP API / 查询引擎
├── Meta Store（元数据：库、RP、shard group、用户、CQ）
└── TSDB Store
     └── Database
          └── Retention Policy
               └── Shard Group（按时间段划分）
                    └── Shard（真正的存储单元，每个都是独立的 TSM 引擎）
                         ├── WAL（预写日志）
                         ├── Cache（内存写缓存）
                         ├── TSM Files（不可变的压缩列存文件）
                         ├── Tombstone Files（删除标记）
                         └── Index（tsi1 时每个 shard 独立的索引）
```

```text
/var/lib/influxdb/
├── meta/meta.db                          # 元数据快照
├── data/mydb/                            # database
│   ├── _series/                          # 【tsi1】数据库级 series file
│   └── autogen/                          # retention policy
│       └── 101/                          # shard id
│           ├── 000000001-000000004.tsm   # generation-sequence
│           ├── 000000005-000000002.tsm
│           ├── 000000005-000000002.tombstone
│           ├── fields.idx
│           └── index/                    # 【tsi1】shard 级索引，8 个 partition
└── wal/mydb/autogen/101/
    ├── _00001.wal
    └── _00002.wal
```

**TSM（Time-Structured Merge Tree）** 参考 LSM 并针对时序做了改造：

| LSM 通用设计 | TSM 的时序优化 |
| --- | --- |
| 按 key 排序 | 按 **series key + field** 组织，每列独立存储 |
| 通用压缩 | 时间戳、浮点、整数各用**专用编码**，压缩率极高 |
| 随机更新 | 时序数据几乎只追加，更新和删除很少 |
| 按 key 范围删除 | 按**时间分片**，过期时整块删除文件 |

## 三、写入链路

<figure class="fig">
<svg viewBox="0 0 740 330" class="dg" role="img" aria-label="InfluxDB 1.x 写入链路：解析校验、路由到 shard、写入索引、写 WAL、写 Cache、返回 204；后台 Cache 达到阈值后快照成 Level 1 TSM 文件并删除对应 WAL 段">
<rect class="b1" x="20" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="120" y="52" text-anchor="middle">① 解析与校验</text>
<text class="ts" x="120" y="74" text-anchor="middle">类型冲突、超出保留期 → 拒绝</text>
<rect class="b1" x="270" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="370" y="52" text-anchor="middle">② 路由到 shard</text>
<text class="ts" x="370" y="74" text-anchor="middle">按时间定 group，按哈希定 shard</text>
<rect class="b1" x="520" y="30" width="200" height="60" rx="8"/>
<text class="tb" x="620" y="52" text-anchor="middle">③ 写入索引</text>
<text class="ts" x="620" y="74" text-anchor="middle">新 series 写入 series file</text>
<line class="l" x1="220" y1="60" x2="268" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="60" x2="518" y2="60" marker-end="url(#arr)"/>
<line class="l" x1="620" y1="90" x2="620" y2="112"/>
<line class="l" x1="620" y1="112" x2="120" y2="112"/>
<line class="l" x1="120" y1="112" x2="120" y2="128" marker-end="url(#arr)"/>
<text class="ts" x="370" y="106" text-anchor="middle">校验通过后，先持久化（WAL）再进内存（Cache）</text>
<rect class="b5" x="20" y="130" width="200" height="60" rx="8"/>
<text class="tb" x="120" y="152" text-anchor="middle">④ 写 WAL</text>
<text class="ts" x="120" y="174" text-anchor="middle">顺序追加、snappy、fsync</text>
<rect class="b3" x="270" y="130" width="200" height="60" rx="8"/>
<text class="tb" x="370" y="152" text-anchor="middle">⑤ 写 Cache</text>
<text class="ts" x="370" y="174" text-anchor="middle">内存：key+field → 值数组</text>
<rect class="b2" x="520" y="130" width="200" height="60" rx="8"/>
<text class="tb" x="620" y="152" text-anchor="middle">⑥ 返回 204</text>
<text class="ts" x="620" y="174" text-anchor="middle">写入成功，数据立即可查</text>
<line class="l" x1="220" y1="160" x2="268" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="470" y1="160" x2="518" y2="160" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="214" width="700" height="100" rx="10"/>
<text class="ts" x="36" y="232">后台异步（不在写请求的路径上）</text>
<line class="ld" x1="370" y1="190" x2="370" y2="214" marker-end="url(#arr)"/>
<rect class="b3" x="36" y="244" width="140" height="56" rx="8"/>
<text class="tb" x="106" y="264" text-anchor="middle">Cache 达阈值</text>
<text class="ts" x="106" y="284" text-anchor="middle">≥25MB 或 10m 无写入</text>
<rect class="b3" x="212" y="244" width="140" height="56" rx="8"/>
<text class="tb" x="282" y="264" text-anchor="middle">Snapshot</text>
<text class="ts" x="282" y="284" text-anchor="middle">冻结 Cache 并落盘</text>
<rect class="b2" x="388" y="244" width="140" height="56" rx="8"/>
<text class="tb" x="458" y="264" text-anchor="middle">Level 1 TSM</text>
<text class="ts" x="458" y="284" text-anchor="middle">不可变的小文件</text>
<rect class="b5" x="564" y="244" width="140" height="56" rx="8"/>
<text class="tb" x="634" y="264" text-anchor="middle">删除 WAL 段</text>
<text class="ts" x="634" y="284" text-anchor="middle">对应数据已持久化</text>
<line class="l" x1="176" y1="272" x2="210" y2="272" marker-end="url(#arr)"/>
<line class="l" x1="352" y1="272" x2="386" y2="272" marker-end="url(#arr)"/>
<line class="l" x1="528" y1="272" x2="562" y2="272" marker-end="url(#arr)"/>
</svg>
<figcaption>图 1：InfluxDB 1.x 写入链路：同步部分先 WAL 后 Cache，TSM 落盘在后台完成</figcaption>
</figure>

### WAL 与 Cache

- **WAL**：顺序追加，每个段文件约 10MB，写满滚动；每条记录 snappy 压缩。作用是**进程崩溃后重放 WAL 恢复 Cache**。Cache 刷成 TSM 后，对应的 WAL 段被删除。
- **Cache**：`map[series key + field] → 按时间排序的值数组`。**查询会同时读 Cache 和 TSM** 并合并结果。
- 刷盘（snapshot）触发条件：`cache-snapshot-memory-size`（默认 25MB）达到，或 `cache-snapshot-write-cold-duration`（默认 10m）内该 shard 没有新写入。
- 保护阈值：`cache-max-memory-size`（默认 1GB），超过后**拒绝写入**（`cache-max-memory-size exceeded`）。

### 写入旧时间戳的影响

写入一个很旧的时间戳会**创建或唤醒对应的冷 shard**：它有自己的 WAL 和 Cache，刷盘后还可能触发该冷 shard 的 compaction。所以用 `SELECT INTO` 往旧时间段回写数据，会在多个冷 shard 上产生额外的写入与 compaction 开销（回填策略见 [InfluxDB 实战：历史回填](#/db/influx-practice)）。

## 四、TSM 文件格式与压缩编码

<figure class="fig">
<svg viewBox="0 0 740 290" class="dg" role="img" aria-label="TSM 文件由 Header、数据块、Index、Footer 组成；读取一个 key 先读 Footer 得到 Index 偏移，在 Index 中二分查找并按时间过滤，再读数据块校验 CRC 并解压；块内时间戳与值分别用专用编码">
<rect class="b" x="20" y="30" width="90" height="56" rx="6"/>
<text class="tb" x="65" y="52" text-anchor="middle">Header</text>
<text class="ts" x="65" y="72" text-anchor="middle">5 字节</text>
<rect class="b2" x="116" y="30" width="330" height="56" rx="6"/>
<text class="tb" x="281" y="52" text-anchor="middle">Blocks：N 个压缩数据块</text>
<text class="ts" x="281" y="72" text-anchor="middle">CRC32 + 类型 + 时间戳段 + 值段，每块最多 1000 点</text>
<rect class="b1" x="452" y="30" width="170" height="56" rx="6"/>
<text class="tb" x="537" y="52" text-anchor="middle">Index</text>
<text class="ts" x="537" y="72" text-anchor="middle">key → 时间范围 + 偏移</text>
<rect class="b3" x="628" y="30" width="92" height="56" rx="6"/>
<text class="tb" x="674" y="52" text-anchor="middle">Footer</text>
<text class="ts" x="674" y="72" text-anchor="middle">8 字节</text>
<text class="ts" x="674" y="104" text-anchor="middle">① 最先读</text>
<text class="ts" x="537" y="104" text-anchor="middle">②③ 二分查 key，按时间过滤</text>
<text class="ts" x="281" y="104" text-anchor="middle">④ 按偏移读块 → 校验 CRC → 解压</text>
<text class="ts" x="20" y="150">块内是列式编码：时间戳与值各自独立压缩，所以只查一列就只读这一列的块</text>
<rect class="b4" x="20" y="164" width="220" height="56" rx="8"/>
<text class="tb" x="130" y="186" text-anchor="middle">时间戳</text>
<text class="ts" x="130" y="206" text-anchor="middle">Delta + RLE / Simple8b</text>
<rect class="b3" x="260" y="164" width="220" height="56" rx="8"/>
<text class="tb" x="370" y="186" text-anchor="middle">浮点数</text>
<text class="ts" x="370" y="206" text-anchor="middle">Gorilla XOR</text>
<rect class="b5" x="500" y="164" width="220" height="56" rx="8"/>
<text class="tb" x="610" y="186" text-anchor="middle">整数 / 布尔 / 字符串</text>
<text class="ts" x="610" y="206" text-anchor="middle">ZigZag+Simple8b / 位打包 / Snappy</text>
<text class="ts" x="20" y="250">打开文件时只把 Index 通过 mmap 加载，数据块按需读取和解压；文件不可变，单个约 2GB 封顶</text>
<text class="ts" x="20" y="270">字符串是通用压缩，效果最差：能用数值或布尔表示的状态，尽量不要存成 string</text>
</svg>
<figcaption>图 2：TSM 文件布局、读取一个 key 的步骤与块内的列式压缩编码</figcaption>
</figure>

| 部分 | 内容 |
| --- | --- |
| Header | Magic Number（4B）+ Version（1B） |
| Blocks | 每块：CRC32（4B）+ 数据（类型、时间戳段、值段） |
| Index | 按 key（series key + field）排序，每个 key 对应若干条目：MinTime、MaxTime、Offset、Size |
| Footer | Index 的起始偏移量（8B） |

**读取一个 key 的过程**：读 Footer 得到 Index 偏移 → 在 Index 里二分查找目标 key → 用 MinTime / MaxTime 过滤出与查询时间范围相交的块 → 按 Offset / Size 读出块、校验 CRC、解压。

### 压缩编码：为什么压缩率这么高

| 数据类型 | 编码 | 原理 |
| --- | --- | --- |
| **Timestamp** | Delta + RLE / Simple8b | 先算相邻时间戳的差值，再用最大公约数（10 的幂）缩放；**所有 delta 相同时用 RLE**，几乎不占空间 |
| **Float** | Gorilla XOR | 当前值与前一个值 XOR；值变化小时前导零、尾随零多，只需存中间少量有效位 |
| **Integer** | ZigZag + Simple8b / RLE | ZigZag 把负数映射为正数；Simple8b 把多个小整数打包进一个 64 位字 |
| Unsigned | Simple8b / RLE | 同上 |
| **Boolean** | Bit Packing | 1 bit 一个值 |
| **String** | Snappy | 通用压缩，效果最差 |

放到典型 IoT 场景里：

- 设备按固定间隔上报（如每 5 分钟）→ **时间戳走 RLE，几乎零成本**；
- 温度、电压这类变化平缓的数值 → **Gorilla XOR** 压缩效果很好；
- **string 类型的 field 压缩最差**，能用 int / bool 表示的状态不要存字符串；
- 降采样到 1 小时后，时间戳仍然是固定间隔，压缩效率不变，所以**存储量大致按点数等比例下降**。

## 五、Compaction

**为什么需要**：每次 Cache 刷盘都生成一个小的 Level 1 文件，文件越多，查询要合并的文件越多；删除只写 tombstone，要靠 compaction 才真正去掉数据；小块合并成大块，压缩率也更高。

```text
Cache Snapshot ──► Level 1（小文件）
                      │ 同层文件数达到阈值
                      ▼
                   Level 2 ──► Level 3
                                 │ shard 变冷 / 文件过多
                                 ▼
              Full Compaction / Optimize（最终形态：块最大、压缩最优）
```

| 类型 | 触发条件 | 说明 |
| --- | --- | --- |
| Snapshot | Cache 达阈值，或写入变冷 | Cache 刷成 L1 |
| Level Compaction | 同一层文件数达到阈值 | L1 → L2 → L3 逐级合并 |
| Full Compaction | shard 在 `compact-full-write-cold-duration`（默认 4h）内没有写入 | 整个 shard 合并成最优形态 |
| Optimize | 文件数多但已经比较大 | 重新整理块，减少文件数 |

**成本**：读旧文件 → 解压 → 合并 → 重新编码 → 写新文件 → 删旧文件。**新旧文件同时存在，磁盘会临时上涨**；消耗 CPU 和磁盘 IO，并发受 `max-concurrent-compactions` 限制（默认 0，即 CPU 核数的 50%）。

> [!WARNING] 冷 shard 上的 DELETE 很重
> 冷 shard 一般已完成 full compaction，处于“最终形态”。对它执行 `DELETE` 会迫使**整个 shard 重写**，这就是 DELETE 重的根本原因（见第九节）。

## 六、读取链路与内存模型

```text
InfluxQL 查询
 ① 解析与规划：按 WHERE time 确定涉及哪些 shard group / shard（时间裁剪）
 ② 索引查询：按 measurement 和 tag 条件找出匹配的 series 列表
 ③ 创建迭代器：每个 series × 每个 field 一个迭代器；同时读 Cache 和多个 TSM 文件，
                按时间排序合并、去重（同一时间戳以最新写入为准），跳过 tombstone 标记的数据
 ④ 解压数据块 → 聚合计算（mean / last / sum ...）
 ⑤ 合并各 shard 的结果；集群模式下再合并各节点的结果，返回
```

**内存消耗模型**：

```text
单次查询的内存峰值 ≈ 匹配的 series 数 × 选择的 field 数 × 每个迭代器的缓冲（解压后的块） + 结果集
```

| 查询方式 | 迭代器数 | 内存峰值 |
| --- | --- | --- |
| `SELECT * ... GROUP BY *`（150 个 field、1 万个 series） | 150 万 | **非常高** |
| `SELECT f1 ...`（1 万个 series） | 1 万 | 低 |
| `SELECT f1..f15 ...`（1 万个 series） | 15 万 | 中，可控 |

- **总解压量**与查询的 field 数和时间范围成正比，拆分查询**不会**减少总量；
- **内存峰值**与单次同时打开的迭代器数成正比，拆分查询能**显著降低峰值**；
- 把集群拉挂的往往是**峰值**，所以要从**时间、租户、列组**三个维度切片；
- **冷数据读取**要走磁盘 IO（不在页缓存里），大量读冷数据会占满磁盘带宽，影响热 shard 的写入和 compaction。

## 七、索引：inmem 与 tsi1

| 维度 | inmem | tsi1 |
| --- | --- | --- |
| 存储位置 | **全部在 Go 堆内存中** | 磁盘文件 + mmap，热点数据被缓存 |
| 作用范围 | 全局共享 | 每个 shard 独立，series file 为数据库级 |
| 启动速度 | 慢：启动要扫描所有 TSM 文件重建索引 | 快 |
| 基数上限 | 受内存限制，百万级就吃力 | 可支撑千万级以上 |
| 删除 series | 要改全局内存结构，**期间持锁，会阻塞读写** | 随 shard 目录一起删除，代价低 |
| 配置 | `index-version = "inmem"` | `index-version = "tsi1"` |

```text
data/mydb/
├── _series/                  # Series File：数据库级，series key ↔ series id 的映射（8 个 partition）
└── autogen/101/index/        # 每个 shard 一份
    └── 0 ~ 7/                # 8 个 partition
         ├── L0-00000001.tsl  # Log File：新 series 先追加到这里（类似 WAL）
         └── L1-00000002.tsi  # Index File：不可变，log 压缩后生成：
                              #   measurement 块、tag 块（tag key → value → series id 集合）、
                              #   哈希索引、基数估算用的 HyperLogLog sketch
```

确认索引类型：看配置文件 `[data] index-version`，或 `SHOW DIAGNOSTICS`。**托管集群一定要向官方确认索引类型**，它直接决定大规模 DROP / DELETE 的风险。`influx_inspect buildtsi` 可以把 inmem 索引转换为 tsi1（需要停机）。

## 八、Shard、Shard Group 与 Retention Policy

<figure class="fig">
<svg viewBox="0 0 740 312" class="dg" role="img" aria-label="Retention Policy 下按时间切分的 Shard Group 与 Shard；过期的 shard group 通过删除目录回收，而 DELETE 需要写 tombstone 并由 compaction 重写整个 shard">
<text class="th" x="20" y="24">按时间切分：Retention Policy → Shard Group → Shard</text>
<rect class="b4" x="20" y="40" width="160" height="60" rx="8"/>
<text class="tb" x="100" y="62" text-anchor="middle">Shard Group 1</text>
<text class="ts" x="100" y="84" text-anchor="middle">[01-03, 01-10)</text>
<rect class="b4" x="200" y="40" width="160" height="60" rx="8"/>
<text class="tb" x="280" y="62" text-anchor="middle">Shard Group 2</text>
<text class="ts" x="280" y="84" text-anchor="middle">[01-10, 01-17)</text>
<rect class="b2" x="380" y="40" width="160" height="60" rx="8"/>
<text class="tb" x="460" y="62" text-anchor="middle">Shard Group 3</text>
<text class="ts" x="460" y="84" text-anchor="middle">[01-17, 01-24)</text>
<rect class="b3" x="560" y="40" width="160" height="60" rx="8"/>
<text class="tb" x="640" y="62" text-anchor="middle">Shard Group 4</text>
<text class="ts" x="640" y="84" text-anchor="middle">[01-24, 01-31)</text>
<text class="ts" x="190" y="120" text-anchor="middle">end &lt; now − duration：整组到期</text>
<text class="ts" x="460" y="120" text-anchor="middle">保留中</text>
<text class="ts" x="640" y="120" text-anchor="middle">当前写入</text>
<rect class="b" x="380" y="134" width="76" height="34" rx="6"/>
<text class="tb" x="418" y="151" text-anchor="middle" dominant-baseline="middle">Shard 101</text>
<rect class="b" x="464" y="134" width="76" height="34" rx="6"/>
<text class="tb" x="502" y="151" text-anchor="middle" dominant-baseline="middle">Shard 102</text>
<text class="ts" x="460" y="186" text-anchor="middle">集群中按 series 哈希分布到多个 shard</text>
<rect class="b2" x="20" y="196" width="700" height="46" rx="8"/>
<text class="tb" x="370" y="214" text-anchor="middle">保留期过期 / DROP SHARD：关闭 shard、删除整个目录</text>
<text class="ts" x="370" y="232" text-anchor="middle">不解压、不重写、不产生 tombstone，代价极低</text>
<rect class="b4" x="20" y="252" width="700" height="46" rx="8"/>
<text class="tb" x="370" y="270" text-anchor="middle">DELETE：写 tombstone → compaction 重写整个 shard → 空间先涨后降</text>
<text class="ts" x="370" y="288" text-anchor="middle">冷 shard 被迫整体重写，代价最高</text>
</svg>
<figcaption>图 3：时间分片与两种回收方式：删目录几乎免费，DELETE 要重写文件</figcaption>
</figure>

- **Shard Group**：一个时间范围的逻辑容器；
- **Shard**：实际存储单元。集群中一个 shard group 内有多个 shard，按 series key 哈希分布；
- **Retention Policy**：决定保留多久（DURATION）、几个副本（REPLICATION）、每个 shard group 覆盖多长时间（SHARD DURATION）。

### Shard Duration 的默认值与取舍

| RP 的 DURATION | 默认 SHARD DURATION |
| --- | --- |
| < 2 天 | 1 小时 |
| 2 天 ~ 6 个月 | 1 天 |
| > 6 个月（含 INF） | 7 天 |

| 太小 | 太大 |
| --- | --- |
| shard 数量多，元数据和文件句柄开销大 | 单个 shard 太大，compaction 很重 |
| 每个 shard 的 compaction 轻 | 过期删除的粒度粗 |
| 适合保留期短的 RP | 适合长期存储 |

### 保留期是怎么执行的

```text
保留期检查服务每隔 check-interval（默认 30 分钟）执行一次：
  for 每个 RP:
    for 每个 shard group:
      if shard_group.end_time < now() - RP.duration:
          在元数据中标记该 shard group 为已删除
          各节点关闭对应的 shard，并删除整个目录
```

1. 删除粒度是**整个 shard group**，所以实际保留时长 ≈ DURATION + SHARD DURATION；
2. 只是**删文件**，不解压、不重写、不产生 tombstone，**代价极低**；
3. **不可逆**：即使再把 RP 改回 INF，数据也不会恢复；
4. 修改 SHARD DURATION **只影响之后新建的 shard group**。

### ALTER RETENTION POLICY 的生效方式

```sql
ALTER RETENTION POLICY "autogen" ON "mydb" DURATION 156w SHARD DURATION 30d
```

| 可修改项 | 生效方式 |
| --- | --- |
| DURATION | 下一次保留期检查时生效，**过期数据立即被删除** |
| SHARD DURATION | 只对新建的 shard group 生效 |
| REPLICATION | 只对新建的 shard group 生效 |
| DEFAULT | 立即生效；**不指定 RP 的读写都会转向新的默认 RP** |
| 名称 | **不支持修改** |

## 九、删除机制

| 方式 | 语法 | 粒度 | 原理 | 代价 |
| --- | --- | --- | --- | --- |
| **DROP SHARD** | `DROP SHARD 101` | 整个 shard | 删除目录 | **极低** |
| **RP 过期** | ALTER DURATION | 整个 shard group | 删除目录 | **极低** |
| DROP MEASUREMENT | `DROP MEASUREMENT m` | 整个 measurement，所有时间 | 写 tombstone + 清理索引 | 高 |
| DROP SERIES | `DROP SERIES FROM m WHERE tag='x'` | 指定 series，**所有时间** | 写 tombstone + 清理索引 | 高 |
| **DELETE** | `DELETE FROM m WHERE tag='x' AND time < '...'` | series × 时间范围 | 写 tombstone，再由 compaction 重写文件 | **最高** |

**DELETE 的完整过程**：

```text
1. 找出时间范围内的所有 shard
2. 在每个 shard 的索引中找出匹配的 series
3. 为每个受影响的 TSM 文件写 .tombstone 文件（记录 key + 时间范围）
4. 查询时跳过被 tombstone 标记的数据（此时磁盘空间没有释放）
5. compaction 读取 TSM 和 tombstone，重写不含被删数据的新文件
6. 新文件写完后删除旧文件和 tombstone → 磁盘空间才真正释放
```

- 冷 shard 本来是“最终形态”，DELETE 迫使它**整体重写**；
- 第 5 步期间新旧文件同时存在，**磁盘先涨后降**；
- 某个 series 在 shard 中的数据被全部删除时还要清理索引（inmem 下要持全局锁）。

> [!TIP] 选择建议
> **能用 `DROP SHARD` 或 RP 过期解决的，就不要用 `DELETE`。** 设计数据布局时就考虑：将来要删的数据（过期租户、合规删除），最好按时间或 RP **物理隔离**。

## 十、Enterprise 集群架构

```text
┌────────────────────────────────────────────┐
│ Meta Nodes（通常 3 个，基于 Raft 共识）        │
│  库、RP、shard group、shard 归属、用户、CQ     │
└────────────────────────────────────────────┘
                    ▲ 元数据同步
┌────────────────────────────────────────────┐
│ Data Nodes（N 个）                           │
│  存储 shard（TSM 引擎）、处理写入和查询、      │
│  节点之间转发请求                             │
└────────────────────────────────────────────┘
```

**写入时的数据分布**：point → 按 timestamp 找到 shard group → `hash(series key) % shard 数` 找到目标 shard → 该 shard 有 REPLICATION 个副本 → 并行写入各 owner 节点。

| 写一致性级别 | 何时返回成功 |
| --- | --- |
| any | 任意节点接收即可（包括写入 hinted handoff 队列） |
| one | 至少 1 个副本写入成功 |
| quorum | 多数副本写入成功 |
| all | 全部副本写入成功 |

- **Hinted Handoff（HH）**：目标节点不可用时，数据暂存在本地 HH 队列，节点恢复后重放；如果对应的 shard 已被删除，队列中的数据会被丢弃。
- **Anti-Entropy（AE）**：后台比较各副本 shard 的摘要，发现不一致后自动修复。大量删除或迁移之后，AE 可能产生额外 IO。

## 十一、SELECT INTO 与 Continuous Query

```sql
SELECT mean("voltage") AS "voltage", last("energy") AS "energy"
INTO "mydb"."rp_10y".:MEASUREMENT
FROM "mydb"."autogen"./.*/
WHERE time >= '2022-01-01' AND time < '2022-01-02'
GROUP BY time(1h), *
```

| 陷阱 | 后果 | 规避 |
| --- | --- | --- |
| **不加 `GROUP BY *`** | **所有 tag 都变成 field**，数据结构被破坏 | 必须加 `GROUP BY *` |
| 查询范围太大 | 超时、OOM，或只完成一部分 | 按天 × 租户 × 列组切片 |
| field 名与 tag 名相同 | field 被自动重命名为 `xxx_1` | 迁移前检查 schema |
| 同一 field 在不同 shard 中类型不同 | 写入报类型冲突 | `SHOW FIELD KEYS` 排查 |
| 降采样用错聚合函数 | 累计量（电能、累计流量）用了 mean，数据失真 | 累计量用 `last()`，瞬时量用 `mean()` |
| 不检查返回值 | 只完成一部分而不自知 | 检查 `written` 数量，并比对条数 |

**Continuous Query（CQ）**按固定间隔自动执行，只处理**最近**的时间窗口：

```sql
CREATE CONTINUOUS QUERY "cq_1h" ON "mydb"
RESAMPLE EVERY 1h FOR 2h
BEGIN
  SELECT mean(*) INTO "rp_10y".:MEASUREMENT FROM "autogen"./.*/ GROUP BY time(1h), *
END
```

CQ **不适合处理很久以前的历史数据**。“把满 3 年的数据降采样”这类任务应该用外部调度任务（如 XXL-JOB）配合 `SELECT INTO`。降采样的整体设计见 [InfluxDB 实战：降采样与分级保留](#/db/influx-practice)。

## 十二、关键配置参数

**存储引擎 `[data]`**

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `index-version` | inmem | 索引类型，**建议用 tsi1** |
| `cache-max-memory-size` | 1g | Cache 上限，超过后拒绝写入 |
| `cache-snapshot-memory-size` | 25m | Cache 达到该大小时刷盘 |
| `cache-snapshot-write-cold-duration` | 10m | 多久没有写入时刷盘 |
| `compact-full-write-cold-duration` | 4h | 多久没有写入时做 full compaction |
| `max-concurrent-compactions` | 0（核数的 50%） | compaction 并发数 |
| `max-series-per-database` | 1000000 | 每个库的 series 上限 |
| `max-values-per-tag` | 100000 | 每个 tag 的取值上限 |

**查询保护 `[coordinator]`**

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `max-concurrent-queries` | 0（不限） | 最大并发查询数 |
| `query-timeout` | 0（不限） | 单个查询超时 |
| `max-select-point` | 0（不限） | 单次查询最多扫描的点数 |
| `max-select-series` | 0（不限） | 单次查询最多涉及的 series 数 |
| `max-select-buckets` | 0（不限） | 单次查询最多的 GROUP BY time 桶数 |

**保留期 `[retention]`**：`enabled`（默认 true）、`check-interval`（默认 30m）。

> [!TIP] 迁移和降采样之前先设保护参数
> 设置合理的查询保护参数，让超大查询**直接报错**，而不是把节点拖垮。

## 十三、案例：用原理推导“存储降本”方案

**场景（示意）**：托管的 InfluxDB 1.x 企业版集群，压缩后存量数 TB、每月新增数十 GB。少数付费租户要求数据永久保存，多数免费租户只需保留一段时间（如 15 个月）。目标：把 3 年以前的原始数据降采样成小时级后长期保留，其余过期删除。

**方案**：

```text
① 新建 rp_10y（建议 DURATION INF），存放降采样后的历史数据
② 向服务商申请 3 年前（多留约 3 个月余量）的 portable 备份
③ 在旁路实例上恢复备份并降采样，限速写回 rp_10y，然后校验
④ 原始备份归档到对象存储（冷归档），作为兜底
⑤ 分批 DROP SHARD 删除旧 shard，最后执行 ALTER autogen DURATION 156w
⑥ 定时任务：每月把即将满 3 年的数据降采样到 rp_10y
⑦ 查询层：免费租户只能查最近 N 个月
```

**每一步依据的原理**：

| 决策 | 依据 |
| --- | --- |
| 用 RP 过期或 DROP SHARD 删数据，而不是 DELETE | 第八、九节：删目录极低代价；DELETE 要 tombstone 加 compaction 重写整个 shard |
| 在旁路实例上降采样 | 第六节：大量读冷数据要解压大量块并占满磁盘 IO |
| 按天 × 租户 × 列组切片 | 第六节：内存峰值取决于同时打开的迭代器数；第四节：列式存储，只查部分列就只读这些列的块 |
| 按列分批写入，结果与 `SELECT *` 一致 | 第一节：同一时间戳的不同 field 自动合并 |
| 降采样后存储量约等比例下降 | 第四节：固定间隔时间戳用 RLE，降采样后压缩效率不变 |
| 导出范围多留余量 | 第八节：保留期检查一直在跑，迁移期间会有新数据跨过 3 年线 |
| 先分批 DROP，最后再 ALTER | 第八、七节：一次删大量 shard，在 inmem 索引下有锁竞争风险 |
| 必须确认索引类型 | 第七节：inmem 与 tsi1 在删除时的代价差别巨大 |
| SHARD DURATION 改为 30d | 第八节：长期存储减少 shard 数量，按月处理边界更清晰 |
| 降采样时累计量用 `last` | 第十一节：用 mean 会使累计量失真 |

**风险检查清单**：

- [ ] 向服务商确认索引类型（tsi1 / inmem）
- [ ] 确认可以提供 portable 备份，并允许执行 ALTER 和 DROP SHARD
- [ ] 数据合规：备份离开托管环境时加密，用完后销毁
- [ ] 用一个 shard 试恢复，验证版本兼容
- [ ] 降采样规则（各参数用什么聚合函数）已由产品确认
- [ ] 降采样结果校验通过（按租户、按天比对条数，并抽查关键字段）
- [ ] 原始备份已归档
- [ ] 执行 ALTER 前，确认 rp_10y 覆盖到“当天往前推 3 年”
- [ ] 每月降采样任务已上线，并配置失败告警
- [ ] 报表、导出等功能对 3 年以前数据的依赖已排查

## 十四、常用运维命令

```sql
-- 保留策略
SHOW RETENTION POLICIES ON "mydb"
CREATE RETENTION POLICY "rp_10y" ON "mydb" DURATION 520w REPLICATION 1 SHARD DURATION 30d
ALTER RETENTION POLICY "autogen" ON "mydb" DURATION 156w SHARD DURATION 30d

-- 分片
SHOW SHARDS
SHOW SHARD GROUPS
DROP SHARD 101

-- Schema
SHOW MEASUREMENTS ON "mydb"
SHOW TAG KEYS FROM "telemetry"
SHOW FIELD KEYS FROM "telemetry"          -- 查看 field 类型，排查类型冲突

-- 基数
SHOW SERIES CARDINALITY ON "mydb"
SHOW SERIES EXACT CARDINALITY ON "mydb"
SHOW TAG VALUES CARDINALITY ON "mydb" WITH KEY = "tenant_id"

-- 运行状态
SHOW DIAGNOSTICS
SHOW STATS
SHOW QUERIES                              -- 正在执行的查询
KILL QUERY <qid>                          -- 终止慢查询
```

```bash
# 备份与恢复（OSS 1.x，portable 格式）
influxd backup -portable -db mydb -rp autogen -start 2021-01-01T00:00:00Z -end 2023-11-01T00:00:00Z /backup/old
influxd restore -portable -db mydb /backup/old

# 把 TSM 文件导出为 line protocol（gzip 压缩）
influx_inspect export -datadir /var/lib/influxdb/data -waldir /var/lib/influxdb/wal \
  -database mydb -retention autogen -start 2021-01-01T00:00:00Z -end 2021-02-01T00:00:00Z \
  -compress -out /export/2021-01.lp.gz

# 查看单个 TSM 文件的信息
influx_inspect dumptsm -index /var/lib/influxdb/data/mydb/autogen/101/000000001-000000004.tsm

# 把 inmem 索引转换为 tsi1（需要停机）
influx_inspect buildtsi -datadir /var/lib/influxdb/data -waldir /var/lib/influxdb/wal
```

> [!NOTE] 企业版与托管
> Enterprise 集群使用 `influxd-ctl backup` / `influxd-ctl restore`；托管服务的备份、ALTER、DROP SHARD 往往需要由服务商执行。

## 相关阅读

- [InfluxDB 数据模型与存储引擎](#/db/influx-model)：数据模型、v1/v2/v3 架构演进、查询语言
- [InfluxDB 实战：基数、降采样、Java 写入与选型](#/db/influx-practice)：写入调优、降采样、基数治理、选型对比
- [文件系统、页缓存与零拷贝](#/cs/os-io)：WAL、顺序写等底层机制
- [ClickHouse 存储与执行](#/bigdata/ck-engine)：同为列式存储，对比 MergeTree 的分区与合并

## 面试追问

> [!QUESTION] 执行 DELETE 后磁盘为什么没有变小？
> DELETE 只写 tombstone，数据还在 TSM 文件里；要等 compaction 读取 TSM 和 tombstone、重写不含被删数据的新文件后，空间才会释放。重写期间新旧文件同时存在，磁盘还会先涨后降，冷 shard 还会因此被整体重写。能用 DROP SHARD 或保留期过期就不要用 DELETE。

> [!QUESTION] 把 RP 的 DURATION 改短，会不会把集群拉挂？
> 保留期删除只是删目录，不解压不重写，代价很低。主要风险在 inmem 索引下清理大量 series 时持全局锁，会阻塞读写；tsi1 下索引随 shard 一起删，风险很低。稳妥做法是先分批 DROP SHARD，最后再 ALTER，并先向服务商确认索引类型。

> [!QUESTION] SELECT * 和只查几列，解压的数据量一样吗？
> 总解压量与 field 数和时间范围成正比，拆分查询不会减少总量。但 TSM 是列式存储，每个 series + field 单独成块，单次查询的内存峰值取决于同时打开的迭代器数（series 数 × field 数），拆开查就能显著降低峰值。把集群拉挂的通常是峰值，所以要按时间、租户、列组切片。

> [!QUESTION] 为什么 string 类型的 field 很占空间？
> 时间戳和数值各有专用编码（Delta+RLE、Gorilla XOR、ZigZag+Simple8b、位打包），压缩率很高；string 只能用 Snappy 通用压缩，效果差得多。能用 int 或 bool 表示的状态尽量不用 string。

> [!QUESTION] 新建一个默认 RP 后，为什么历史数据“消失”了？
> 不指定 RP 的查询只查默认 RP，旧数据仍在原来的 RP 里，并没有丢。查询时要写全 `"mydb"."autogen"."measurement"`；改 DEFAULT 会让不指定 RP 的读写都转向新的默认 RP，要提前评估对应用的影响。

> [!QUESTION] Continuous Query 能用来处理历史数据吗？SELECT INTO 有哪些坑？
> 不适合：CQ 只处理最近的时间窗口，历史数据应该用调度任务配合 SELECT INTO。SELECT INTO 必须加 GROUP BY *，否则所有 tag 变成 field；范围太大要按天、租户、列组切片；累计量用 last、瞬时量用 mean；还要检查返回的 written 数量并比对条数。
