---
level: 深入
tags: [Redis, redisObject, SDS, dict, listpack, quicklist, skiplist, intset]
summary: 从 redisObject 到 SDS、dict、quicklist、listpack、intset、skiplist，讲清每种类型在什么条件下用什么编码，以及 7.0 用 listpack 全面取代 ziplist 的原因
---

# 数据结构与底层编码

> [!ABSTRACT] 核心要点
> - Redis 的 5 种基础类型（String/List/Hash/Set/ZSet）只是「对外类型」，每种都有 2～3 种底层编码，**小数据用紧凑编码省内存，超过阈值自动转换为高性能编码且不会转回**。
> - 7.0 起 listpack 全面取代 ziplist（Hash/ZSet/List 节点），配置名从 `*-ziplist-*` 改成 `*-listpack-*`（旧名仍可用作别名）；7.2 起小 Set 和小 List 也可用 listpack 编码。
> - SDS 解决了 C 字符串 O(N) 求长度、非二进制安全、易溢出和频繁 realloc 的问题；dict 用**两张哈希表 + 渐进式 rehash**避免扩容时阻塞。
> - ZSet = dict（member→score，O(1) 查分）+ skiplist（按 score 有序，O(logN) 范围查询）；选跳表是因为范围查询简单、实现与调试容易、内存可调，B+ 树的优势在磁盘场景。
> - Bitmap、HyperLogLog 底层都是 String；GEO 底层是 ZSet（score 为 52 位 GeoHash）；Stream 是 Radix Tree + listpack。

## redisObject

所有 value（以及 key 之外的绝大多数对象）都包装成一个 `redisObject`：

```c
// Redis 7.x server.h（节选）
typedef struct redisObject {
    unsigned type:4;      // 对外类型：OBJ_STRING / LIST / SET / ZSET / HASH / MODULE / STREAM
    unsigned encoding:4;  // 底层编码：OBJ_ENCODING_INT / EMBSTR / RAW / LISTPACK / QUICKLIST ...
    unsigned lru:24;      // LRU 模式：最后访问时间（秒级时钟）；LFU 模式：高 16 位分钟时间 + 低 8 位对数计数
    int refcount;         // 引用计数；共享整数对象 0～9999 的 refcount 为 INT_MAX
    void *ptr;            // 指向真正的数据结构；INT 编码时直接存整数值
} robj;                   // 共 16 字节
```

- `OBJECT ENCODING key` 查看编码，`OBJECT FREQ key`（LFU 策略下）查看访问频率，`OBJECT IDLETIME key` 查看空闲时间；
- `lru` 字段被 LRU 与 LFU 复用，见 [过期策略与内存淘汰](#/redis/expire)；
- 共享整数：`OBJ_SHARED_INTEGERS = 10000`，值为 0～9999 的字符串直接引用全局共享对象。但开启 `maxmemory` 且淘汰策略为 LRU/LFU 时不使用共享对象（因为每个 key 要有独立的 lru 字段）。

## 类型与编码对照

| 类型 | 编码 | 使用条件（7.x 默认值） |
| --- | --- | --- |
| String | `int` | 值是 long 范围内的整数 |
| | `embstr` | 字符串 ≤ 44 字节：robj 与 SDS 一次分配、内存连续（3.2 之前阈值为 39） |
| | `raw` | 字符串 > 44 字节，或对 embstr 做过修改（embstr 只读，修改后转 raw） |
| List | `listpack` | 7.2+：元素数和大小都很小时（受 `list-max-listpack-size` 控制） |
| | `quicklist` | 其他情况（3.2～7.0 所有 List 都是 quicklist） |
| Hash | `listpack` | 字段数 ≤ `hash-max-listpack-entries`（128）且每个值 ≤ `hash-max-listpack-value`（64 字节） |
| | `hashtable` | 超过任一阈值 |
| Set | `intset` | 全是整数且元素数 ≤ `set-max-intset-entries`（512） |
| | `listpack` | 7.2+：非整数但元素数 ≤ `set-max-listpack-entries`（128）且每个 ≤ `set-max-listpack-value`（64） |
| | `hashtable` | 其他情况 |
| ZSet | `listpack` | 元素数 ≤ `zset-max-listpack-entries`（128）且每个 member ≤ `zset-max-listpack-value`（64） |
| | `skiplist` | 超过任一阈值（实际是 dict + skiplist） |
| Stream | `stream` | Radix Tree + listpack，`stream-node-max-bytes` 4096 / `stream-node-max-entries` 100 |

> [!NOTE] 版本差异
> - ≤ 6.2：Hash/ZSet 小编码是 `ziplist`，参数是 `hash-max-ziplist-entries` 等；List 在 3.2 之前是 `ziplist` / `linkedlist`，3.2 起统一为 `quicklist`（节点为 ziplist）。
> - 7.0：ziplist 全部替换为 listpack，quicklist 的节点也换成 listpack；RDB 格式随之升级，**7.0 的 RDB 不能被 6.x 加载**。
> - 编码转换是单向的：一个 Hash 一旦转为 hashtable，删到只剩 1 个字段也不会转回 listpack。

## SDS：简单动态字符串

<figure class="fig">
<svg viewBox="0 0 720 210" class="dg" role="img" aria-label="sdshdr8 内存布局：len、alloc、flags 头部后紧跟 buf 字节数组，sds 指针指向 buf 起始位置">
<text class="ts" x="40" y="52">header（sdshdr8，3 字节）</text>
<text class="ts" x="320" y="52">buf[]（alloc + 1 字节）</text>
<rect class="b5" x="40" y="62" width="90" height="44" rx="4"/>
<text class="tm" x="85" y="84" text-anchor="middle" dominant-baseline="middle">len=5</text>
<rect class="b5" x="130" y="62" width="90" height="44" rx="4"/>
<text class="tm" x="175" y="84" text-anchor="middle" dominant-baseline="middle">alloc=10</text>
<rect class="b5" x="220" y="62" width="100" height="44" rx="4"/>
<text class="tm" x="270" y="84" text-anchor="middle" dominant-baseline="middle">flags</text>
<rect class="b1" x="320" y="62" width="36" height="44"/>
<text class="tm" x="338" y="84" text-anchor="middle" dominant-baseline="middle">R</text>
<rect class="b1" x="356" y="62" width="36" height="44"/>
<text class="tm" x="374" y="84" text-anchor="middle" dominant-baseline="middle">e</text>
<rect class="b1" x="392" y="62" width="36" height="44"/>
<text class="tm" x="410" y="84" text-anchor="middle" dominant-baseline="middle">d</text>
<rect class="b1" x="428" y="62" width="36" height="44"/>
<text class="tm" x="446" y="84" text-anchor="middle" dominant-baseline="middle">i</text>
<rect class="b1" x="464" y="62" width="36" height="44"/>
<text class="tm" x="482" y="84" text-anchor="middle" dominant-baseline="middle">s</text>
<rect class="b3" x="500" y="62" width="36" height="44"/>
<text class="tm" x="518" y="84" text-anchor="middle" dominant-baseline="middle">\0</text>
<rect class="bg" x="536" y="62" width="150" height="44"/>
<text class="ts" x="611" y="84" text-anchor="middle" dominant-baseline="middle">未使用 5 字节</text>
<line class="la" x1="320" y1="150" x2="320" y2="110" marker-end="url(#arr-a)"/>
<text class="tm" x="320" y="166" text-anchor="middle">sds（char* 指向 buf）</text>
<text class="ts" x="40" y="190">len：已用长度，O(1) 获取；alloc：buf 容量（不含头和结尾 \0）</text>
<text class="ts" x="40" y="206">flags 低 3 位区分 sdshdr5/8/16/32/64，按长度选最小的头，节省小字符串内存</text>
</svg>
<figcaption>图 1：SDS（sdshdr8）内存布局</figcaption>
</figure>

SDS 对外暴露的是 `char *buf`，所以能直接复用 C 字符串函数；通过 `buf[-1]` 读 flags 再定位头部。相比 C 字符串：

| 问题 | C 字符串 | SDS |
| --- | --- | --- |
| 求长度 | O(N) 遍历到 `\0` | O(1) 读 `len` |
| 二进制安全 | 中间不能有 `\0` | 以 `len` 为准，可以存图片、序列化数据 |
| 缓冲区溢出 | `strcat` 不检查容量 | `sdsMakeRoomFor` 先检查并扩容 |
| 内存重分配 | 每次增长都 realloc | **空间预分配**：新长度 < 1MB 时按 2 倍分配，≥ 1MB 时多分配 1MB；**惰性释放**：缩短时不立即回收 |

`embstr` 的 44 字节来源：jemalloc 分配 64 字节块，robj 16 字节 + sdshdr8 头 3 字节 + 结尾 `\0` 1 字节 = 20，剩余 44 字节。

## dict 与渐进式 rehash

Hash（hashtable 编码）、Set（hashtable 编码）、ZSet 的 member→score 映射，以及整个 db 的键空间都是 dict。拉链法解决冲突，新节点**头插**。

```c
// Redis 7.0 dict.h（节选，7.0 起 dictht 被拆进 dict）
struct dict {
    dictType *type;
    dictEntry **ht_table[2];       // 两张哈希表
    unsigned long ht_used[2];      // 各自元素数
    long rehashidx;                // -1 表示未在 rehash；否则为下一个要迁移的桶下标
    int16_t pauserehash;           // >0 时暂停 rehash（如安全迭代器存在时）
    signed char ht_size_exp[2];    // 表大小用 2 的指数表示
};
```

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="渐进式 rehash：ht_table[0] 的前两个桶已迁移到 ht_table[1]，rehashidx 指向第 2 个桶">
<rect class="b5" x="20" y="50" width="150" height="120" rx="8"/>
<text class="tb" x="95" y="70" text-anchor="middle" dominant-baseline="middle">dict</text>
<text class="tm" x="95" y="98" text-anchor="middle" dominant-baseline="middle">ht_table[0]</text>
<text class="tm" x="95" y="124" text-anchor="middle" dominant-baseline="middle">ht_table[1]</text>
<text class="tm" x="95" y="150" text-anchor="middle" dominant-baseline="middle">rehashidx=2</text>
<text class="ts" x="230" y="40">ht_table[0]：size = 4（旧表）</text>
<rect class="b" x="230" y="50" width="60" height="34"/>
<text class="tm" x="260" y="67" text-anchor="middle" dominant-baseline="middle">0: ∅</text>
<rect class="b" x="290" y="50" width="60" height="34"/>
<text class="tm" x="320" y="67" text-anchor="middle" dominant-baseline="middle">1: ∅</text>
<rect class="b3" x="350" y="50" width="60" height="34"/>
<text class="tm" x="380" y="67" text-anchor="middle" dominant-baseline="middle">2: k3</text>
<rect class="b3" x="410" y="50" width="60" height="34"/>
<text class="tm" x="440" y="67" text-anchor="middle" dominant-baseline="middle">3: k4</text>
<line class="la" x1="380" y1="112" x2="380" y2="88" marker-end="url(#arr-a)"/>
<text class="ta" x="380" y="128" text-anchor="middle">rehashidx</text>
<line class="l" x1="170" y1="98" x2="228" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="170" y1="124" x2="228" y2="200" marker-end="url(#arr)"/>
<line class="ld" x1="320" y1="84" x2="317" y2="188" marker-end="url(#arr)"/>
<text class="ts" x="310" y="150" text-anchor="end">已迁移</text>
<text class="ts" x="230" y="180">ht_table[1]：size = 8（新表）</text>
<rect class="b2" x="230" y="190" width="58" height="34"/>
<text class="tm" x="259" y="207" text-anchor="middle" dominant-baseline="middle">0: ∅</text>
<rect class="b2" x="288" y="190" width="58" height="34"/>
<text class="tm" x="317" y="207" text-anchor="middle" dominant-baseline="middle">1: k1</text>
<rect class="b2" x="346" y="190" width="58" height="34"/>
<text class="tm" x="375" y="207" text-anchor="middle" dominant-baseline="middle">2: ∅</text>
<rect class="b2" x="404" y="190" width="58" height="34"/>
<text class="tm" x="433" y="207" text-anchor="middle" dominant-baseline="middle">3: ∅</text>
<rect class="b2" x="462" y="190" width="58" height="34"/>
<text class="tm" x="491" y="207" text-anchor="middle" dominant-baseline="middle">4: ∅</text>
<rect class="b2" x="520" y="190" width="58" height="34"/>
<text class="tm" x="549" y="207" text-anchor="middle" dominant-baseline="middle">5: k2</text>
<rect class="b2" x="578" y="190" width="58" height="34"/>
<text class="tm" x="607" y="207" text-anchor="middle" dominant-baseline="middle">6: ∅</text>
<rect class="b2" x="636" y="190" width="58" height="34"/>
<text class="tm" x="665" y="207" text-anchor="middle" dominant-baseline="middle">7: ∅</text>
<text class="ts" x="20" y="256">每次增删改查顺带迁移 1 个桶（最多跳过 10 个空桶）；serverCron 空闲时每次再迁移约 1ms</text>
<text class="ts" x="20" y="276">rehash 期间：查找/删除要查两张表，新增只写 ht_table[1]；全部迁完后 ht_table[1] 变为 ht_table[0]</text>
</svg>
<figcaption>图 2：渐进式 rehash 进行到一半时的状态</figcaption>
</figure>

**扩容/缩容触发条件**（7.x）：

- 扩容：负载因子 `used/size ≥ 1` 且当前没有 BGSAVE/BGREWRITEAOF 子进程；或者负载因子 ≥ 5（`dict_force_resize_ratio`），不管有没有子进程都强制扩容。新大小为第一个 ≥ `used+1` 的 2 的幂。
- 缩容：负载因子 < 10%（`HASHTABLE_MIN_FILL`），由 `serverCron` 检查。

有子进程时尽量不扩容，是为了**避免 rehash 大量修改内存页触发写时复制**，让 fork 出的子进程少复制页面。

## quicklist 与 listpack

### ziplist 的问题：连锁更新

ziplist 每个 entry 记录 `prevlen`（前一个 entry 的长度），前一个长度 < 254 字节时用 1 字节，否则用 5 字节。当某个 entry 从 253 字节变成 254 字节，后一个 entry 的 `prevlen` 要从 1 字节扩成 5 字节，它自己的长度也可能跨过 254，连锁影响后面所有 entry —— 最坏 O(N²) 次 realloc，这就是**连锁更新（cascade update）**。

### listpack

listpack（5.0 引入用于 Stream，7.0 全面替代 ziplist）的 entry 不再记录前一个 entry 的长度，而是记录**自己的长度**：

```text
listpack:  <total-bytes 4B> <num-elements 2B> <entry> <entry> ... <end 0xFF>
entry:     <encoding+data> <backlen>
           backlen = encoding+data 的总长度，变长 1～5 字节，放在 entry 末尾
```

- 正向遍历：根据 encoding 算出当前 entry 长度跳到下一个；
- 反向遍历：从下一个 entry 起始位置往前读 backlen（逆序变长编码），就能定位上一个 entry 的起点；
- 修改一个 entry 只影响它自己，**彻底消除连锁更新**。

### quicklist

<figure class="fig">
<svg viewBox="0 0 720 230" class="dg" role="img" aria-label="quicklist 是双向链表，每个节点指向一个 listpack，中间节点可被 LZF 压缩">
<rect class="b5" x="20" y="60" width="130" height="80" rx="8"/>
<text class="tb" x="85" y="80" text-anchor="middle" dominant-baseline="middle">quicklist</text>
<text class="tm" x="85" y="102" text-anchor="middle" dominant-baseline="middle">head / tail</text>
<text class="tm" x="85" y="122" text-anchor="middle" dominant-baseline="middle">count / len</text>
<line class="l" x1="150" y1="80" x2="188" y2="60" marker-end="url(#arr)"/>
<rect class="b1" x="190" y="40" width="150" height="44" rx="6"/>
<text class="tb" x="265" y="62" text-anchor="middle" dominant-baseline="middle">quicklistNode</text>
<rect class="b1" x="360" y="40" width="150" height="44" rx="6"/>
<text class="tb" x="435" y="62" text-anchor="middle" dominant-baseline="middle">quicklistNode</text>
<rect class="b1" x="530" y="40" width="150" height="44" rx="6"/>
<text class="tb" x="605" y="62" text-anchor="middle" dominant-baseline="middle">quicklistNode</text>
<line class="l" x1="340" y1="54" x2="358" y2="54" marker-end="url(#arr)"/>
<line class="l" x1="360" y1="72" x2="342" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="510" y1="54" x2="528" y2="54" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="72" x2="512" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="265" y1="84" x2="265" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="435" y1="84" x2="435" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="605" y1="84" x2="605" y2="118" marker-end="url(#arr)"/>
<rect class="b2" x="190" y="120" width="150" height="44" rx="6"/>
<text class="tm" x="265" y="142" text-anchor="middle" dominant-baseline="middle">listpack[e1..e5]</text>
<rect class="b3" x="360" y="120" width="150" height="44" rx="6"/>
<text class="tm" x="435" y="142" text-anchor="middle" dominant-baseline="middle">LZF 压缩数据</text>
<rect class="b2" x="530" y="120" width="150" height="44" rx="6"/>
<text class="tm" x="605" y="142" text-anchor="middle" dominant-baseline="middle">listpack[e9..e12]</text>
<text class="ts" x="20" y="194">list-max-listpack-size 默认 -2：每个节点的 listpack 不超过 8KB（正数表示按元素个数限制）</text>
<text class="ts" x="20" y="214">list-compress-depth=1 时首尾各 1 个节点不压缩，中间节点 LZF 压缩（默认 0 不压缩）</text>
</svg>
<figcaption>图 3：quicklist = 双向链表 + listpack 节点</figcaption>
</figure>

quicklist 是「链表的 O(1) 头尾操作」和「紧凑数组的内存效率」的折中：纯链表每个元素要两个指针加一次 malloc，内存碎片严重；纯 listpack 太大时插入要整体 memmove。`list-max-listpack-size` 取负数 -1～-5 分别代表单节点 4/8/16/32/64KB，默认 -2（8KB）。

### intset

```c
typedef struct intset {
    uint32_t encoding;   // INTSET_ENC_INT16 / INT32 / INT64
    uint32_t length;
    int8_t contents[];   // 有序、无重复，二分查找
} intset;
```

插入一个超出当前编码范围的整数时，整个数组**升级**到更宽的编码（int16→int32→int64），从后往前搬移元素；**不支持降级**。查找 O(logN)、插入 O(N)，所以元素数要限制在 512 以内。

## skiplist 与 ZSet

```c
// Redis 7.x server.h（节选）
typedef struct zskiplistNode {
    sds ele;                            // member
    double score;
    struct zskiplistNode *backward;     // 后退指针，只在第 1 层，用于 ZREVRANGE
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;             // 到 forward 节点跨越的节点数，用于计算排名 ZRANK
    } level[];
} zskiplistNode;

typedef struct zset {
    dict *dict;          // member -> score，ZSCORE O(1)
    zskiplist *zsl;      // 按 (score, member) 排序
} zset;
```

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="跳表结构：header 有 4 层，节点随机层高，查找 score 40 时从高层向低层逐步逼近">
<text class="ts" x="50" y="32" text-anchor="middle">header</text>
<rect class="b5" x="20" y="40" width="60" height="30"/>
<text class="ts" x="50" y="55" text-anchor="middle" dominant-baseline="middle">L4</text>
<rect class="b5" x="20" y="76" width="60" height="30"/>
<text class="ts" x="50" y="91" text-anchor="middle" dominant-baseline="middle">L3</text>
<rect class="b5" x="20" y="112" width="60" height="30"/>
<text class="ts" x="50" y="127" text-anchor="middle" dominant-baseline="middle">L2</text>
<rect class="b5" x="20" y="148" width="60" height="30"/>
<text class="ts" x="50" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b1" x="150" y="112" width="60" height="30"/>
<text class="ts" x="180" y="127" text-anchor="middle" dominant-baseline="middle">L2</text>
<rect class="b1" x="150" y="148" width="60" height="30"/>
<text class="ts" x="180" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b" x="150" y="184" width="60" height="36"/>
<text class="tm" x="180" y="202" text-anchor="middle" dominant-baseline="middle">a:10</text>
<rect class="b1" x="260" y="148" width="60" height="30"/>
<text class="ts" x="290" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b" x="260" y="184" width="60" height="36"/>
<text class="tm" x="290" y="202" text-anchor="middle" dominant-baseline="middle">b:20</text>
<rect class="b1" x="370" y="76" width="60" height="30"/>
<text class="ts" x="400" y="91" text-anchor="middle" dominant-baseline="middle">L3</text>
<rect class="b1" x="370" y="112" width="60" height="30"/>
<text class="ts" x="400" y="127" text-anchor="middle" dominant-baseline="middle">L2</text>
<rect class="b1" x="370" y="148" width="60" height="30"/>
<text class="ts" x="400" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b" x="370" y="184" width="60" height="36"/>
<text class="tm" x="400" y="202" text-anchor="middle" dominant-baseline="middle">c:30</text>
<rect class="b1" x="480" y="148" width="60" height="30"/>
<text class="ts" x="510" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b4" x="480" y="184" width="60" height="36"/>
<text class="tm" x="510" y="202" text-anchor="middle" dominant-baseline="middle">d:40</text>
<rect class="b1" x="590" y="112" width="60" height="30"/>
<text class="ts" x="620" y="127" text-anchor="middle" dominant-baseline="middle">L2</text>
<rect class="b1" x="590" y="148" width="60" height="30"/>
<text class="ts" x="620" y="163" text-anchor="middle" dominant-baseline="middle">L1</text>
<rect class="b" x="590" y="184" width="60" height="36"/>
<text class="tm" x="620" y="202" text-anchor="middle" dominant-baseline="middle">e:50</text>
<line class="ld" x1="80" y1="55" x2="668" y2="55" marker-end="url(#arr)"/>
<line class="la" x1="80" y1="91" x2="368" y2="91" marker-end="url(#arr-a)"/>
<text class="ts" x="225" y="84" text-anchor="middle">span=3</text>
<line class="l" x1="430" y1="91" x2="668" y2="91" marker-end="url(#arr)"/>
<line class="l" x1="80" y1="127" x2="148" y2="127" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="127" x2="368" y2="127" marker-end="url(#arr)"/>
<text class="ts" x="290" y="120" text-anchor="middle">span=2</text>
<line class="l" x1="430" y1="127" x2="588" y2="127" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="127" x2="668" y2="127" marker-end="url(#arr)"/>
<line class="l" x1="80" y1="163" x2="148" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="210" y1="163" x2="258" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="320" y1="163" x2="368" y2="163" marker-end="url(#arr)"/>
<line class="la" x1="430" y1="163" x2="478" y2="163" marker-end="url(#arr-a)"/>
<line class="l" x1="540" y1="163" x2="588" y2="163" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="163" x2="668" y2="163" marker-end="url(#arr)"/>
<text class="tm" x="695" y="55" text-anchor="middle" dominant-baseline="middle">NULL</text>
<text class="tm" x="695" y="91" text-anchor="middle" dominant-baseline="middle">NULL</text>
<text class="tm" x="695" y="127" text-anchor="middle" dominant-baseline="middle">NULL</text>
<text class="tm" x="695" y="163" text-anchor="middle" dominant-baseline="middle">NULL</text>
<text class="ts" x="20" y="252">查找 score=40：L4 直达 NULL → 下降到 L3 跳到 c:30 → L3/L2 的下一个分别是 NULL、e:50 都越界</text>
<text class="ts" x="20" y="272">→ 下降到 L1 前进一步命中 d:40（强调线为实际走过的路径）；排名 = 路径上 span 之和 = 3 + 1 = 4</text>
</svg>
<figcaption>图 4：跳表结构与查找路径（第 1 层另有 backward 指针，图中省略）</figcaption>
</figure>

- 层高随机：每多一层的概率 `ZSKIPLIST_P = 0.25`，最大 32 层（`ZSKIPLIST_MAXLEVEL`，早期版本为 64）。平均每个节点约 1.33 个指针，比平衡树的 2 个指针还省；
- 查找、插入、删除平均 O(logN)；`ZRANGEBYSCORE` 先 O(logN) 找到起点，再沿第 1 层顺序走；
- 同分时按 member 字典序排序，所以排行榜要「同分先到者优先」需要把时间编码进 score。

### 为什么用跳表而不是红黑树 / B+ 树

| 维度 | 跳表 | 红黑树 / AVL | B+ 树 |
| --- | --- | --- | --- |
| 范围查询 | 找到起点后沿底层链表顺序遍历，天然支持 | 需要中序遍历，实现复杂 | 叶子链表，同样方便 |
| 实现复杂度 | 插入删除只改局部指针，几十行代码 | 旋转、变色逻辑复杂 | 节点分裂合并复杂 |
| 内存 | 平均 1.33 个指针/节点，可通过 P 调节 | 固定 2 个子指针 + 颜色 | 为磁盘页设计，内存中优势不明显 |
| 排名（ZRANK） | 加 span 字段即可 O(logN) | 需要维护子树大小 | 需要额外维护 |
| 并发 | 局部修改，易做无锁（Redis 用不上） | 旋转影响面大 | — |

B+ 树的优势是**多路、矮胖、减少磁盘 IO 次数**，Redis 是纯内存结构，这一优势不存在。antirez 本人给出的理由也是：内存占用可控、范围操作友好、实现和调试简单。

## Stream、Bitmap、HyperLogLog、GEO

| 类型 | 底层 | 关键特性 | 典型场景 |
| --- | --- | --- | --- |
| Stream（5.0） | Radix Tree（key 为消息 ID 前缀）+ listpack（存一批消息） | 消息 ID `毫秒时间-序号` 单调递增；消费组、Pending 列表、ACK、`XAUTOCLAIM` | 轻量消息队列，见 [高频场景实战](#/redis/practice) |
| Bitmap | String（最大 512MB，即 2^32 位） | `SETBIT`/`GETBIT`/`BITCOUNT`/`BITOP`/`BITFIELD` | 签到、在线状态、布隆过滤器底座 |
| HyperLogLog | String，16384 个 6 bit 寄存器，dense 编码约 12KB；基数小时用 sparse 编码 | 基数估算，标准误差 0.81%；`PFMERGE` 可合并 | UV 统计 |
| GEO | ZSet，score 是经纬度交叉编码的 52 位 GeoHash | `GEOADD`/`GEOSEARCH`（6.2+，取代 `GEORADIUS`）/`GEODIST` | 附近的人、门店 |

> [!TIP]
> Bitmap 的偏移量决定内存：`SETBIT k 4294967295 1` 会直接分配 512MB。用用户 ID 做偏移时，ID 必须是从 0 开始的紧凑整数，雪花 ID 这类大数会直接撑爆内存。

## 生产实践与踩坑

- **大 Hash 导致编码转换**：一个 Hash 字段数从 128 涨到 129，内存可能翻几倍（listpack → hashtable，每个字段多出 dictEntry 和两个 SDS 头）。存大量小对象时，可以按 ID 分桶（`user:{id/100}` 下存 100 个字段）保持 listpack 编码，这是 Redis 官方推荐的内存优化手段。
- **调大 listpack 阈值要谨慎**：listpack 查找是 O(N)，把 `hash-max-listpack-entries` 调到几千，`HGET` 退化为线性扫描，CPU 飙升。一般不超过 512，value 不超过 64～128 字节。
- **整数存储**：存数字字符串比存 JSON 更省内存（int 编码直接放在 ptr 里，无需额外分配）。
- **ZSet 大 key**：百万级排行榜 `ZRANGE 0 -1` 会阻塞，`ZREMRANGEBYRANK` 删大批量也慢，要分页、定期裁剪。
- **查看真实内存**：`MEMORY USAGE key` 估算单 key 占用，`DEBUG OBJECT key` 能看到 `serializedlength`（是序列化长度，不是内存占用，别被误导）。
- **升级跨大版本**：7.0 生成的 RDB 无法被 6.x 加载，降级回滚要用 `redis-shake` 之类的工具做逻辑迁移。

## 相关阅读

- [复杂度与核心数据结构](#/cs/algo-ds)：跳表、哈希表与渐进式 rehash
- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：HyperLogLog、Bitmap 的原理
- [Redis 内存优化与容量治理](#/redis/memory)：编码阈值与内存优化

## 面试追问

> [!QUESTION] embstr 和 raw 有什么区别，为什么阈值是 44？
> embstr 把 robj 和 SDS 一次分配在连续内存里，少一次 malloc/free、对 CPU cache 更友好，但只读，修改后转为 raw。jemalloc 64 字节的分配块减去 robj 16 字节、sdshdr8 头 3 字节和结尾 `\0` 1 字节，剩下 44 字节。

> [!QUESTION] 渐进式 rehash 期间如何查找、新增？如果一直没有请求会怎样？
> 查找、删除、更新会先查 ht_table[0] 再查 ht_table[1]；新增只写 ht_table[1]，保证 ht_table[0] 只减不增。每次操作顺带迁移一个桶；没有请求时 `serverCron` 会主动以 1ms 为时间片迁移，所以不会永远停在 rehash 中。

> [!QUESTION] listpack 解决了 ziplist 的什么问题？
> ziplist 每个 entry 记录前一个 entry 的长度，长度跨过 254 字节时 prevlen 字段从 1 字节变 5 字节，可能引发连锁更新。listpack 每个 entry 只记录自身长度（放在末尾的 backlen），修改不影响相邻 entry，同时仍能双向遍历。

> [!QUESTION] ZSet 为什么同时用 dict 和 skiplist？
> 跳表负责按 score 排序和范围/排名查询（O(logN)）；dict 负责按 member 取 score（O(1)），否则 `ZSCORE`、`ZADD` 判断成员是否存在都要 O(N)。两者共享 member 的 SDS，额外开销主要是 dictEntry。

> [!QUESTION] 一个 Hash 存了 100 万个字段，有什么问题，怎么优化？
> 是大 key：`HGETALL` 阻塞、删除阻塞、Cluster 下数据倾斜、迁移时 `MIGRATE` 超时。优化：按字段哈希拆成多个小 Hash（如 1000 个桶），每个桶保持在 listpack 阈值内，同时降低内存；读取用 `HSCAN` 分批；删除用 `UNLINK`。
