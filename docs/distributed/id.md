---
level: 进阶
tags: [Snowflake, Leaf, 号段, UUID, 时钟回拨, workerId]
summary: 分布式 ID 的需求与各方案原理：UUID、数据库自增、号段双 buffer、Snowflake 位布局与时钟回拨、workerId 分配、Leaf 与 UidGenerator
---

# 分布式 ID 生成

> [!ABSTRACT] 核心要点
> - 好的分布式 ID 要满足：全局唯一、趋势递增（对 B+ 树友好）、高可用、低延迟高吞吐，必要时**不暴露业务量**。
> - UUID 无序且长，做 InnoDB 主键会导致频繁页分裂和随机 IO；需要用 UUID 时优先 UUIDv7（时间有序）。
> - 号段模式：一次从数据库取一段（如 1000 个）放内存发放，DB 压力降为原来的 1/step；美团 Leaf-segment 用**双 buffer** 在当前号段消耗到一定比例时异步预取下一段，消除取号毛刺。
> - Snowflake：`1 符号 + 41 毫秒时间戳 + 10 机器 + 12 序列`，单机每毫秒 4096 个，纯内存生成。两个核心风险：**时钟回拨**和 **workerId 重复**。
> - 时钟回拨：小幅回拨等待追平，大幅回拨拒绝服务并摘除节点；workerId 用 ZK / DB / Redis 租约分配，且要在本地持久化以便注册中心不可用时也能启动。

## 需求分析

| 需求 | 说明 | 反例 |
| --- | --- | --- |
| 全局唯一 | 跨库、跨服务不重复 | 分库后各自自增 |
| 趋势递增 | 作为 InnoDB 主键时顺序插入，避免页分裂；也便于按 ID 范围分页、排序 | UUIDv4 |
| 单调递增 | 某些场景（如消息序号、增量同步游标）要求严格递增 | 多节点 Snowflake 只能保证趋势递增 |
| 高可用 | ID 服务不能成为单点，DB 宕机时仍能发号一段时间 | 单库自增 |
| 高性能 | 单机万级到百万级 QPS，P99 延迟低 | 每次取号都访问 DB |
| 信息安全 | 订单号连续会暴露日单量，被爬虫按序遍历 | 自增订单号 |
| 长度合适 | 64 位 `long` 存储和索引效率远高于 128 位或字符串 | 36 字符 UUID |

「趋势递增」与「信息安全」是冲突的：完全不可预测的 ID 无法有序。常见折中是**内部主键用有序 ID，对外暴露的单号做混淆或另行生成**。

## UUID

| 版本 | 生成方式 | 问题 |
| --- | --- | --- |
| v1 | 时间戳 + 时钟序列 + MAC 地址 | 暴露 MAC；时间字段高低位颠倒，字典序并不随时间递增 |
| v4 | 122 位随机 | 完全无序 |
| v7（RFC 9562，2024） | 48 位 Unix 毫秒时间戳 + 随机 | 时间有序，适合做数据库主键；JDK 尚无内置实现，需引入库 |

UUID 的问题集中在作为 MySQL 主键时：

- **长**：字符串 36 字节（`BINARY(16)` 可压到 16 字节），二级索引的叶子都存主键，索引整体膨胀；
- **无序（v4）**：新记录随机插入 B+ 树任意页，导致页分裂、页填充率低、Buffer Pool 命中率下降、随机写 IO。详见 [B+ 树索引原理](#/mysql/index)。

适用场景：不入库或不做主键的标识，如 traceId、请求幂等键、文件名。

## 数据库自增

### 单库自增

`AUTO_INCREMENT` 简单、严格递增，但有单点和性能瓶颈（每个 ID 一次写入），且暴露业务量。MySQL 8.0 之前自增值保存在内存，重启后按 `MAX(id)+1` 恢复，删除尾部记录后重启会**复用 ID**；8.0 起持久化到 redo log 解决了这个问题。

### 多主 + 步长

N 台数据库分别设置 `auto_increment_increment = N`、`auto_increment_offset = 1..N`，第 i 台生成 `i, i+N, i+2N…`。

- 优点：消除单点；
- 缺点：**扩容困难**（加机器要改步长并保证新旧不冲突，通常需要停机或预留大偏移）；ID 只是各自递增，全局无序；每次取号仍然写库。

## 号段模式

思路：把「每次取一个」改成「每次取一段」。

```sql
CREATE TABLE leaf_alloc (
  biz_tag     VARCHAR(128) NOT NULL PRIMARY KEY,   -- 业务标识，不同业务互不影响
  max_id      BIGINT       NOT NULL DEFAULT 1,     -- 当前已分配出去的最大 ID
  step        INT          NOT NULL,               -- 号段长度
  description VARCHAR(256),
  update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 取一个号段（同一事务内）：可用区间为 (max_id - step, max_id]
BEGIN;
UPDATE leaf_alloc SET max_id = max_id + step WHERE biz_tag = 'order';
SELECT max_id, step FROM leaf_alloc WHERE biz_tag = 'order';
COMMIT;
```

`UPDATE` 依靠行锁保证多个 ID 服务实例拿到的区间互不重叠。DB 写入频率降为 `QPS / step`，DB 宕机时内存中剩余的号段还能撑一会儿。

### Leaf-segment 双 buffer

单 buffer 的问题：号段用完的那一刻才去 DB 取，这次请求要等一个 DB 往返，而且若恰好 DB 抖动，发号就会阻塞——表现为 P999 毛刺。

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="Leaf-segment 双 buffer：当前号段消耗到 10% 时异步从数据库加载下一号段，当前号段用完后切换">
<rect class="b" x="20" y="96" width="170" height="80" rx="8"/>
<text class="tb" x="105" y="116" text-anchor="middle" dominant-baseline="middle">leaf_alloc 表</text>
<text class="tm" x="105" y="138" text-anchor="middle" dominant-baseline="middle">biz_tag = order</text>
<text class="tm" x="105" y="158" text-anchor="middle" dominant-baseline="middle">max_id=4000 step=1000</text>
<text class="tm" x="105" y="200" text-anchor="middle">UPDATE max_id+step</text>
<text class="ts" x="105" y="218" text-anchor="middle">再 SELECT 取回新区间</text>
<rect class="bg" x="230" y="16" width="490" height="200" rx="12"/>
<text class="ts" x="246" y="36">Leaf 服务内存：SegmentBuffer</text>
<text class="ts" x="260" y="54">segments[0]：current</text>
<rect class="b" x="260" y="60" width="420" height="40" rx="6"/>
<rect class="b2" x="260" y="60" width="130" height="40" rx="6"/>
<text class="t" x="325" y="80" text-anchor="middle" dominant-baseline="middle">已发放</text>
<text class="tb" x="535" y="80" text-anchor="middle" dominant-baseline="middle">当前号段 [2001, 3000]</text>
<line class="la" x1="302" y1="56" x2="302" y2="106"/>
<text class="ta" x="296" y="122">消耗超过 10% → 异步加载下一段</text>
<text class="ts" x="260" y="144">segments[1]：next</text>
<rect class="b1" x="260" y="150" width="420" height="40" rx="6"/>
<text class="tb" x="470" y="170" text-anchor="middle" dominant-baseline="middle">下一号段 [3001, 4000]（已就绪）</text>
<line class="la" x1="190" y1="150" x2="258" y2="170" marker-end="url(#arr-a)"/>
<text class="ts" x="480" y="244" text-anchor="middle">当前段用完时切换 current 指针，发号全程在内存，DB 短暂抖动对调用方无感</text>
</svg>
<figcaption>图 1：Leaf-segment 双 buffer 预加载</figcaption>
</figure>

- 每个 `biz_tag` 一个 SegmentBuffer，含两个 Segment；
- 当前号段消耗超过 10%（且下一段未就绪）时，由线程池异步加载下一段；
- 当前段用完，若下一段已就绪直接切换；
- **动态 step**：根据上一次号段的消耗时长调整，消耗太快（Leaf 中以 15 分钟为界）就把 step 翻倍，太慢则减半，在 DB 压力与重启浪费之间自适应；
- DB 主从 + 半同步复制保证 DB 可用性；服务重启会丢弃内存中未用完的号段，ID 不连续但不重复。

> [!NOTE]
> 号段模式 ID 是严格递增的**数字**，同样会暴露业务量，不适合直接作为对外订单号。

## Snowflake

### 位布局

<figure class="fig">
<svg viewBox="0 0 720 200" class="dg" role="img" aria-label="Snowflake 64 位布局：1 位符号位、41 位毫秒时间戳、10 位工作机器 ID、12 位序列号">
<text class="ts" x="45" y="40" text-anchor="middle">1 bit</text>
<text class="ts" x="235" y="40" text-anchor="middle">41 bit</text>
<text class="ts" x="480" y="40" text-anchor="middle">10 bit</text>
<text class="ts" x="630" y="40" text-anchor="middle">12 bit</text>
<rect class="b" x="20" y="50" width="50" height="50"/>
<text class="tm" x="45" y="75" text-anchor="middle" dominant-baseline="middle">0</text>
<rect class="b1" x="70" y="50" width="330" height="50"/>
<text class="tb" x="235" y="75" text-anchor="middle" dominant-baseline="middle">时间戳：当前毫秒 − 自定义纪元</text>
<rect class="b5" x="400" y="50" width="80" height="50"/>
<text class="tb" x="440" y="75" text-anchor="middle" dominant-baseline="middle">机房</text>
<rect class="b5" x="480" y="50" width="80" height="50"/>
<text class="tb" x="520" y="75" text-anchor="middle" dominant-baseline="middle">机器</text>
<rect class="b2" x="560" y="50" width="140" height="50"/>
<text class="tb" x="630" y="75" text-anchor="middle" dominant-baseline="middle">序列号</text>
<text class="ts" x="45" y="120" text-anchor="middle">符号位</text>
<text class="ts" x="45" y="138" text-anchor="middle">恒为 0</text>
<text class="ts" x="235" y="120" text-anchor="middle">2^41 ms ≈ 69.7 年</text>
<text class="ts" x="235" y="138" text-anchor="middle">纪元越近，可用年限越长</text>
<text class="ts" x="480" y="120" text-anchor="middle">5 + 5 位，共 1024 个节点</text>
<text class="ts" x="480" y="138" text-anchor="middle">可按需重新划分</text>
<text class="ts" x="630" y="120" text-anchor="middle">每节点每毫秒 4096 个</text>
<text class="ts" x="630" y="138" text-anchor="middle">约 409.6 万 / 秒</text>
<text class="tm" x="360" y="180" text-anchor="middle">id = (ts - epoch) &lt;&lt; 22 | workerId &lt;&lt; 12 | sequence</text>
</svg>
<figcaption>图 2：Snowflake 64 位 ID 的位布局</figcaption>
</figure>

优点：本地生成、无网络开销、趋势递增、`long` 存储。位数可以按业务改：机器少就压缩 workerId 位、加长序列号；需要更久就加长时间戳位或改用秒级时间戳（如 UidGenerator）。

### 关键实现

```java
// 简化版 Snowflake：单实例内线程安全
public final class SnowflakeIdGenerator {
    private static final long EPOCH = 1704067200000L;          // 2024-01-01T00:00:00Z，上线后不可修改
    private static final long WORKER_BITS = 10L;
    private static final long SEQ_BITS = 12L;
    private static final long MAX_WORKER_ID = ~(-1L << WORKER_BITS);   // 1023
    private static final long SEQ_MASK = ~(-1L << SEQ_BITS);           // 4095
    private static final long TS_SHIFT = WORKER_BITS + SEQ_BITS;       // 22
    private static final long MAX_BACKWARD_MS = 5;

    private final long workerId;
    private long lastTs = -1L;
    private long sequence = 0L;

    public SnowflakeIdGenerator(long workerId) {
        if (workerId < 0 || workerId > MAX_WORKER_ID) {
            throw new IllegalArgumentException("workerId out of range: " + workerId);
        }
        this.workerId = workerId;
    }

    public synchronized long nextId() {
        long now = System.currentTimeMillis();
        if (now < lastTs) {                                   // 时钟回拨
            long offset = lastTs - now;
            if (offset > MAX_BACKWARD_MS) {
                throw new IllegalStateException("clock moved backwards " + offset + "ms");
            }
            sleepQuietly(offset << 1);                         // 小幅回拨：等待追平
            now = System.currentTimeMillis();
            if (now < lastTs) {
                throw new IllegalStateException("clock still behind after waiting");
            }
        }
        if (now == lastTs) {
            sequence = (sequence + 1) & SEQ_MASK;
            if (sequence == 0) {                              // 本毫秒序列号耗尽，自旋到下一毫秒
                while ((now = System.currentTimeMillis()) <= lastTs) {
                    Thread.onSpinWait();
                }
            }
        } else {
            // 新毫秒的起始序列号取小随机数，避免低并发时 ID 末位总是 0 导致取模分片倾斜
            sequence = ThreadLocalRandom.current().nextLong(100);
        }
        lastTs = now;
        return ((now - EPOCH) << TS_SHIFT) | (workerId << SEQ_BITS) | sequence;
    }

    private static void sleepQuietly(long ms) {
        try { TimeUnit.MILLISECONDS.sleep(ms); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
```

### 时钟回拨

原因：NTP 同步校正（step 模式直接跳时间）、人工改时间、虚拟机迁移、闰秒。回拨后生成的时间戳可能与之前重复，配合相同的序列号就会产生**重复 ID**。

| 策略 | 做法 | 代价 |
| --- | --- | --- |
| 等待 | 回拨幅度小（如 ≤ 5ms）时 sleep 到追平 | 短暂增加延迟 |
| 拒绝服务 | 回拨幅度大时抛异常，节点从注册中心摘除，告警人工处理 | 该节点暂时不可用，由其他节点承接 |
| 逻辑时钟 | 不再读系统时钟，`lastTs` 用完序列号后自增（「借用未来时间」） | 与真实时间偏离，重启后需持久化 lastTs 防回退 |
| 备用 workerId | 回拨时切换到预留的备用 workerId 继续发号 | 消耗 workerId 空间 |
| 运维层规避 | ntpd 用 slew 模式（`-x`）逐步调整、禁止人工改时间 | 不能根除 |

还有一种更隐蔽的情况：**进程重启期间**发生回拨，内存中的 `lastTs` 已丢失，代码无法检测。所以 Leaf-snowflake 会在启动时校验：本机时间不能小于自己上次上报到 ZK 的时间，且与其他节点的平均时间偏差在阈值内，否则启动失败。

### workerId 分配

| 方式 | 做法 | 注意点 |
| --- | --- | --- |
| 配置文件 | 每台机器手工配置 | 容器化、弹性扩缩容下不可行 |
| ZooKeeper | 以 `ip:port` 创建持久顺序节点，序号即 workerId，同一实例重启复用原节点 | 启动强依赖 ZK，需本地缓存 workerId 作降级 |
| 数据库 | 启动时插入一行 `(host, port, start_time)`，用自增主键取模或直接作 workerId | 不复用则 workerId 很快耗尽；复用需判断旧实例确已下线 |
| Redis | `INCR` 取号或 `SET NX EX` 抢占 0～1023 的槽位并定期续期 | 续期失败要立即停止发号，防止被别人抢走后重复 |
| K8s StatefulSet | 用 Pod 序号作为 workerId | 只适用于有状态部署 |

## 主流开源实现

### 美团 Leaf

- **Leaf-segment**：号段 + 双 buffer，见上文；
- **Leaf-snowflake**：workerId 来自 ZK 持久顺序节点（`ip:port` 唯一），并缓存到本地文件，ZK 不可用时用本地缓存启动；节点定期（约每 3 秒）上报自身时间到 ZK，用于启动时的时钟校验；运行期回拨 ≤ 5ms 时等待两倍时长，否则报错。

### 百度 UidGenerator

- 位布局默认：1 符号 + **28 位秒级时间差** + **22 位 workerId** + **13 位序列**，每节点每秒 8192 个；时间差 28 位约可用 8.5 年，位数可配置；
- workerId 由数据库分配：**每次启动**插入 WORKER_NODE 表取自增 ID，用后即弃，22 位支持约 420 万次启动；
- `CachedUidGenerator`：用 **RingBuffer** 预先批量生成 ID 缓存起来，消费时直接从环中取；用缓存行填充避免伪共享；序列号用完时「借用未来时间」继续生成，因此不依赖实时系统时钟，天然规避运行期回拨。

### Redis INCR

`INCR order:id:20261008` 原子自增，可拼接日期前缀生成「日期 + 序号」的单号。性能高，但：

- 持久化不完美：RDB 或 AOF everysec 宕机都可能丢失最近的自增，恢复后**发出重复 ID**；
- 主从异步复制，故障切换后从库值落后，同样重复；
- 可用 `INCRBY` 一次取一段降低压力，或在恢复时把值调大一个安全余量。

### 其他

MongoDB ObjectId：12 字节 = 4 字节秒级时间戳 + 5 字节随机值 + 3 字节计数器；Seata 和 MyBatis-Plus（`IdType.ASSIGN_ID`）都内置了 Snowflake 变种。

## 选型对比

| 方案 | 有序性 | 性能 | 可用性 | 依赖 | 暴露业务量 | 适用 |
| --- | --- | --- | --- | --- | --- | --- |
| UUIDv4 | 无序 | 极高（本地） | 极高 | 无 | 否 | traceId、非主键标识 |
| UUIDv7 | 趋势递增 | 极高（本地） | 极高 | 无 | 暴露时间 | 需要 128 位且入库的场景 |
| DB 自增 | 严格递增 | 低 | 单点 | DB | 是 | 小系统、单库 |
| 号段 / Leaf-segment | 趋势递增 | 高 | 高（有缓冲） | DB | 是 | 内部主键、需数字连续性的场景 |
| Snowflake / Leaf-snowflake | 趋势递增 | 极高 | 高 | 时钟、workerId 分配 | 暴露时间与机器 | 订单、消息等海量主键 |
| UidGenerator | 趋势递增 | 极高 | 高 | DB（仅启动时） | 暴露时间 | 超高吞吐 |
| Redis INCR | 严格递增 | 高 | 依赖 Redis | Redis | 是 | 带日期前缀的流水号 |

## 生产实践与踩坑

- **前端 JS 精度丢失**：JavaScript `Number` 只能精确表示 2^53 以内的整数，Snowflake ID 超出后末几位被截断，前端回传的 ID 查不到数据。后端序列化时把 `Long` 转字符串（Jackson `ToStringSerializer` 或全局 `SimpleModule` 配置）。
- **低并发下按 ID 取模分片倾斜**：每毫秒只有一两个请求时序列号总是 0，`id % 2` 永远落到同一个分片。起始序列号随机化，或分片键改用业务字段的哈希。
- **容器扩容 workerId 冲突**：多个 Pod 用了相同的 workerId（例如都从同一个配置读取），短时间生成大量重复主键，表现为插入时 `Duplicate entry`。workerId 必须动态分配且唯一，并在启动日志中打印以便排查。
- **修改纪元或位布局**：上线后修改 epoch 或位分配会让新 ID 小于旧 ID，甚至重复，必须视为不可变配置。
- **号段服务重启造成 ID 跳跃**：重启丢弃内存中剩余号段，ID 出现大跳跃，属于正常现象，不要依赖 ID 连续性做业务判断（如用 ID 差计算数量）。
- **对外订单号**：直接暴露 Snowflake ID 会泄露生成时间和机器数量。可以使用「日期 + 业务码 + 混淆后的序号 + 校验位」的单号，内部仍用 long 主键。

## 面试追问

> [!QUESTION] 为什么不推荐 UUID 做 MySQL 主键？
> v4 完全随机，插入落在 B+ 树任意页，频繁页分裂、页利用率低、随机 IO 多；字符串存储占 36 字节，所有二级索引都要存主键，索引膨胀。必须用时选 UUIDv7 并用 `BINARY(16)` 存储。

> [!QUESTION] Snowflake 时钟回拨怎么处理？
> 运行期检测 `now < lastTs`：小幅回拨等待追平；大幅回拨拒绝发号并摘除节点、告警；也可以切换备用 workerId 或改用逻辑时钟借用未来时间。重启期间的回拨要靠持久化上次时间（如上报到 ZK）在启动时校验。运维上 NTP 使用 slew 模式。

> [!QUESTION] Leaf-segment 的双 buffer 解决了什么问题？
> 单 buffer 在号段耗尽时才同步去 DB 取号，造成请求毛刺且 DB 抖动直接影响发号。双 buffer 在当前段消耗到 10% 时就异步加载下一段，切换只是指针交换，取号全程在内存完成；配合动态 step 适应流量变化。

> [!QUESTION] Snowflake 的 workerId 怎么分配才安全？
> 动态分配保证唯一：ZK 持久顺序节点（按 ip:port 复用）、DB 插入取自增 ID、Redis 抢占槽位并续期。要处理注册中心不可用（本地缓存降级）和租约丢失（续期失败立即停止发号）两种情况。

> [!QUESTION] Snowflake 生成的 ID 是严格递增的吗？
> 同一节点内是单调递增（不回拨的前提下）；多节点之间只是趋势递增——同一毫秒内不同 workerId 的 ID 大小由 workerId 决定，与实际请求先后无关。需要全局严格递增（如增量同步游标）应使用单点发号或数据库序列。
