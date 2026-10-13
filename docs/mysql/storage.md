---
level: 深入
tags: [InnoDB, 数据页, 行格式, Buffer Pool, Change Buffer, Doublewrite]
summary: 从表空间到行记录逐层拆解 InnoDB 的磁盘结构，再讲 Buffer Pool 的链表管理、Change Buffer、自适应哈希、Doublewrite 与刷脏，解释“数据库为什么时不时抖一下”。
---

# InnoDB 存储结构与 Buffer Pool

> [!ABSTRACT] 核心要点
> - 磁盘结构层级：**表空间 → 段 → 区（1MB，64 页）→ 页（默认 16KB）→ 行**；页是磁盘与内存交换的最小单位。
> - 数据页内记录按主键组成**单向链表**，Page Directory 把记录分组并记录每组最大记录的位置（槽），页内查找 = **槽上二分 + 组内顺序遍历**。
> - 默认行格式 **DYNAMIC**（5.7.9+）：大字段溢出时页内只留 20 字节指针；COMPACT 还会在页内保留 768 字节前缀。
> - Buffer Pool 用 **Free / LRU / Flush** 三条链表管理页；LRU 分 young/old 两区，配合 `innodb_old_blocks_time` 防止全表扫描冲掉热点。
> - 写放大与抖动的来源：Change Buffer 合并、Doublewrite、刷脏（redo 空间不足或空闲页不足时的同步刷脏最致命）。

## 逻辑存储层级

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="InnoDB 表空间、段、区、页、行的层级关系">
<rect class="b1" x="20" y="20" width="150" height="260" rx="10"/>
<text class="tb" x="95" y="42" text-anchor="middle" dominant-baseline="middle">表空间</text>
<text class="ts" x="95" y="62" text-anchor="middle" dominant-baseline="middle">如 t.ibd</text>
<rect class="b" x="32" y="80" width="126" height="40" rx="6"/>
<text class="t" x="95" y="100" text-anchor="middle" dominant-baseline="middle">叶子节点段</text>
<rect class="b" x="32" y="132" width="126" height="40" rx="6"/>
<text class="t" x="95" y="152" text-anchor="middle" dominant-baseline="middle">非叶子节点段</text>
<rect class="b" x="32" y="184" width="126" height="40" rx="6"/>
<text class="t" x="95" y="204" text-anchor="middle" dominant-baseline="middle">回滚段等</text>
<text class="ts" x="95" y="250" text-anchor="middle" dominant-baseline="middle">每个索引两个段</text>
<line class="l" x1="170" y1="150" x2="208" y2="150" marker-end="url(#arr)"/>
<rect class="b2" x="210" y="20" width="160" height="260" rx="10"/>
<text class="tb" x="290" y="42" text-anchor="middle" dominant-baseline="middle">区 Extent</text>
<text class="ts" x="290" y="62" text-anchor="middle" dominant-baseline="middle">连续 64 页 = 1MB</text>
<rect class="b" x="230" y="84" width="24" height="24" rx="3"/>
<rect class="b" x="262" y="84" width="24" height="24" rx="3"/>
<rect class="b" x="294" y="84" width="24" height="24" rx="3"/>
<rect class="b" x="326" y="84" width="24" height="24" rx="3"/>
<rect class="b" x="230" y="116" width="24" height="24" rx="3"/>
<rect class="b" x="262" y="116" width="24" height="24" rx="3"/>
<rect class="b" x="294" y="116" width="24" height="24" rx="3"/>
<rect class="b" x="326" y="116" width="24" height="24" rx="3"/>
<rect class="b" x="230" y="148" width="24" height="24" rx="3"/>
<rect class="b" x="262" y="148" width="24" height="24" rx="3"/>
<rect class="b" x="294" y="148" width="24" height="24" rx="3"/>
<rect class="b" x="326" y="148" width="24" height="24" rx="3"/>
<rect class="b" x="230" y="180" width="24" height="24" rx="3"/>
<rect class="b" x="262" y="180" width="24" height="24" rx="3"/>
<rect class="b" x="294" y="180" width="24" height="24" rx="3"/>
<rect class="b" x="326" y="180" width="24" height="24" rx="3"/>
<text class="ts" x="290" y="232" text-anchor="middle" dominant-baseline="middle">按区分配空间，保证</text>
<text class="ts" x="290" y="250" text-anchor="middle" dominant-baseline="middle">范围扫描的顺序 I/O</text>
<line class="l" x1="370" y1="150" x2="408" y2="150" marker-end="url(#arr)"/>
<rect class="b3" x="410" y="20" width="150" height="260" rx="10"/>
<text class="tb" x="485" y="42" text-anchor="middle" dominant-baseline="middle">页 Page</text>
<text class="ts" x="485" y="62" text-anchor="middle" dominant-baseline="middle">16KB，I/O 最小单位</text>
<rect class="b" x="425" y="84" width="120" height="30" rx="6"/>
<text class="t" x="485" y="99" text-anchor="middle" dominant-baseline="middle">记录 1</text>
<rect class="b" x="425" y="122" width="120" height="30" rx="6"/>
<text class="t" x="485" y="137" text-anchor="middle" dominant-baseline="middle">记录 2</text>
<rect class="b" x="425" y="160" width="120" height="30" rx="6"/>
<text class="t" x="485" y="175" text-anchor="middle" dominant-baseline="middle">记录 3</text>
<text class="ts" x="485" y="210" text-anchor="middle" dominant-baseline="middle">……</text>
<text class="ts" x="485" y="250" text-anchor="middle" dominant-baseline="middle">页内记录按主键有序</text>
<line class="l" x1="560" y1="150" x2="588" y2="150" marker-end="url(#arr)"/>
<rect class="b5" x="590" y="20" width="140" height="260" rx="10"/>
<text class="tb" x="660" y="42" text-anchor="middle" dominant-baseline="middle">行（COMPACT）</text>
<text class="ts" x="660" y="72" text-anchor="middle" dominant-baseline="middle">变长字段长度列表</text>
<text class="ts" x="660" y="100" text-anchor="middle" dominant-baseline="middle">NULL 值列表</text>
<text class="ts" x="660" y="128" text-anchor="middle" dominant-baseline="middle">记录头 5 字节</text>
<text class="tm" x="660" y="156" text-anchor="middle" dominant-baseline="middle">DB_ROW_ID 6B</text>
<text class="tm" x="660" y="184" text-anchor="middle" dominant-baseline="middle">DB_TRX_ID 6B</text>
<text class="tm" x="660" y="212" text-anchor="middle" dominant-baseline="middle">DB_ROLL_PTR 7B</text>
<text class="ts" x="660" y="240" text-anchor="middle" dominant-baseline="middle">列 1 … 列 N</text>
</svg>
<figcaption>图 1：表空间 → 段 → 区 → 页 → 行。DB_ROW_ID 仅在表没有主键且没有非空唯一键时生成</figcaption>
</figure>

### 表空间

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 系统表空间 | `ibdata1` | 5.7 存放数据字典、doublewrite、Change Buffer、undo（未独立时）；8.0 数据字典移入 `mysql.ibd`，doublewrite 8.0.20+ 移到独立文件 |
| 独立表空间 | `表名.ibd` | `innodb_file_per_table=ON`（5.6.6 起默认），每张表的数据与索引一个文件，`DROP`/`TRUNCATE` 能真正释放磁盘 |
| undo 表空间 | `undo_001`、`undo_002` | 8.0 默认两个独立 undo 表空间，可在线 truncate 回收空间 |
| 临时表空间 | `ibtmp1`、`#innodb_temp` | 8.0.16+ 用户临时表使用会话级临时表空间，会话结束即回收 |
| 通用表空间 | `CREATE TABLESPACE` | 多表共享，较少使用 |

### 段与区

- 每个索引（B+ 树）对应两个段：**叶子节点段**和**非叶子节点段**。把叶子页集中在同一批区里，范围扫描时就是相对顺序的 I/O。
- **区**是 64 个连续的页（16KB 页时为 1MB）。段增长时按区申请空间；但一个段刚创建时先从“碎片区”零散分配最多 32 个页，避免小表一上来就占用整区。
- 这就是“为什么一张只有几行的表 `.ibd` 文件也有 96KB/112KB 起步”——表空间头部有若干管理页（FSP header、IBUF bitmap、INODE 页等）。

## 16KB 数据页结构

<figure class="fig">
<svg viewBox="0 0 740 370" class="dg" role="img" aria-label="InnoDB 数据页的七个组成部分以及 Page Directory 槽与记录分组的对应关系">
<rect class="b1" x="20" y="20" width="330" height="34"/>
<text class="tb" x="36" y="37" dominant-baseline="middle">File Header</text>
<text class="ts" x="338" y="37" text-anchor="end" dominant-baseline="middle">38B：页号、前后页指针、校验和</text>
<rect class="b1" x="20" y="54" width="330" height="34"/>
<text class="tb" x="36" y="71" dominant-baseline="middle">Page Header</text>
<text class="ts" x="338" y="71" text-anchor="end" dominant-baseline="middle">56B：槽数、记录数、页层级</text>
<rect class="b2" x="20" y="88" width="330" height="34"/>
<text class="tb" x="36" y="105" dominant-baseline="middle">Infimum + Supremum</text>
<text class="ts" x="338" y="105" text-anchor="end" dominant-baseline="middle">26B：虚拟最小/最大记录</text>
<rect class="b3" x="20" y="122" width="330" height="100"/>
<text class="tb" x="36" y="152" dominant-baseline="middle">User Records</text>
<text class="ts" x="36" y="176" dominant-baseline="middle">按主键顺序用 next_record 串成单向链表</text>
<text class="ts" x="36" y="198" dominant-baseline="middle">物理上按插入顺序堆放（heap_no）</text>
<rect class="b" x="20" y="222" width="330" height="50"/>
<text class="tb" x="36" y="247" dominant-baseline="middle">Free Space</text>
<text class="ts" x="338" y="247" text-anchor="end" dominant-baseline="middle">未使用空间，两头向中间生长</text>
<rect class="b5" x="20" y="272" width="330" height="40"/>
<text class="tb" x="36" y="292" dominant-baseline="middle">Page Directory</text>
<text class="ts" x="338" y="292" text-anchor="end" dominant-baseline="middle">槽：每组最大记录的偏移</text>
<rect class="b1" x="20" y="312" width="330" height="34"/>
<text class="tb" x="36" y="329" dominant-baseline="middle">File Trailer</text>
<text class="ts" x="338" y="329" text-anchor="end" dominant-baseline="middle">8B：校验和 + LSN 低 4 字节</text>
<text class="ts" x="475" y="16" text-anchor="middle" dominant-baseline="middle">User Records（单向链表）</text>
<text class="ts" x="675" y="16" text-anchor="middle" dominant-baseline="middle">Page Directory</text>
<rect class="b2" x="400" y="30" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="43" text-anchor="middle" dominant-baseline="middle">Infimum n_owned=1</text>
<line class="l" x1="475" y1="56" x2="475" y2="67" marker-end="url(#arr)"/>
<rect class="b" x="400" y="68" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="81" text-anchor="middle" dominant-baseline="middle">id=1</text>
<line class="l" x1="475" y1="94" x2="475" y2="105" marker-end="url(#arr)"/>
<rect class="b" x="400" y="106" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="119" text-anchor="middle" dominant-baseline="middle">id=3</text>
<line class="l" x1="475" y1="132" x2="475" y2="143" marker-end="url(#arr)"/>
<rect class="b" x="400" y="144" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="157" text-anchor="middle" dominant-baseline="middle">id=5</text>
<line class="l" x1="475" y1="170" x2="475" y2="181" marker-end="url(#arr)"/>
<rect class="b3" x="400" y="182" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="195" text-anchor="middle" dominant-baseline="middle">id=7 n_owned=4</text>
<line class="l" x1="475" y1="208" x2="475" y2="219" marker-end="url(#arr)"/>
<rect class="b" x="400" y="220" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="233" text-anchor="middle" dominant-baseline="middle">id=9</text>
<line class="l" x1="475" y1="246" x2="475" y2="257" marker-end="url(#arr)"/>
<rect class="b" x="400" y="258" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="271" text-anchor="middle" dominant-baseline="middle">id=11</text>
<line class="l" x1="475" y1="284" x2="475" y2="295" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="296" width="150" height="26" rx="5"/>
<text class="tm" x="475" y="309" text-anchor="middle" dominant-baseline="middle">Supremum n_owned=3</text>
<rect class="b5" x="630" y="30" width="90" height="26" rx="5"/>
<text class="tb" x="675" y="43" text-anchor="middle" dominant-baseline="middle">槽 0</text>
<line class="l" x1="630" y1="43" x2="552" y2="43" marker-end="url(#arr)"/>
<rect class="b5" x="630" y="182" width="90" height="26" rx="5"/>
<text class="tb" x="675" y="195" text-anchor="middle" dominant-baseline="middle">槽 1</text>
<line class="l" x1="630" y1="195" x2="552" y2="195" marker-end="url(#arr)"/>
<rect class="b5" x="630" y="296" width="90" height="26" rx="5"/>
<text class="tb" x="675" y="309" text-anchor="middle" dominant-baseline="middle">槽 2</text>
<line class="l" x1="630" y1="309" x2="552" y2="309" marker-end="url(#arr)"/>
<text class="ts" x="560" y="350" text-anchor="middle" dominant-baseline="middle">每个槽指向一组记录中的最大者，n_owned 记录该组条数</text>
</svg>
<figcaption>图 2：左为数据页七个部分；右为槽与分组。查 id=9：在槽上二分得到“7 &lt; 9 ≤ Supremum”，从槽 1 指向的 id=7 往后遍历即可</figcaption>
</figure>

### 各部分要点

- **File Header**：`FIL_PAGE_OFFSET`（页号）、`FIL_PAGE_PREV/NEXT`（同层前后页，B+ 树叶子页的**双向链表**就是靠它）、`FIL_PAGE_LSN`（最后修改的 LSN）、`FIL_PAGE_TYPE`（数据页、undo 页、系统页……）。
- **Page Header**：`PAGE_N_DIR_SLOTS`、`PAGE_N_RECS`、`PAGE_LEVEL`（0 表示叶子）、`PAGE_DIRECTION`/`PAGE_N_DIRECTION`（最近插入方向，页分裂时用来判断是不是顺序插入）、`PAGE_MAX_TRX_ID`（二级索引页上修改过它的最大事务 ID，MVCC 用来快速判断是否需要回表检查可见性）。
- **记录头（5 字节）**：`delete_mask`（删除标记，删除只是打标记，由 purge 线程真正移除）、`n_owned`、`heap_no`（页内堆位置，行锁的锁位图就是按 heap_no 编号的）、`record_type`、`next_record`（下一条记录的相对偏移）。
- **File Trailer**：与 File Header 中的校验和和 LSN 对照，检测页是否**写了一半**（torn page）。

### 页内查找：槽上二分 + 组内遍历

分组规则：Infimum 所在组只有 1 条；Supremum 所在组 1～8 条；其他组 4～8 条。插入使某组超过 8 条时拆成两组、新增一个槽。

查找某个主键时，先在 Page Directory 的槽数组上做**二分查找**，定位到目标所在的组，再从前一个槽指向的记录出发沿 `next_record` 顺序走最多 8 步。这样页内查找是 O(log n) + 常数，而不需要遍历整页几百条记录。

> [!NOTE] B+ 树查找的完整路径
> 根页 → 逐层用“槽二分 + 组内遍历”找到下一层页号 → 叶子页再做一次页内查找。根页通常常驻 Buffer Pool，所以一次主键等值查询的磁盘 I/O 往往只有 0～1 次。

## 行格式

| 行格式 | 版本 | 溢出处理 | 说明 |
| --- | --- | --- | --- |
| REDUNDANT | 5.0 以前 | 页内保留 768 字节前缀 | 历史格式 |
| COMPACT | 5.0+ | 页内保留 768 字节前缀 + 20 字节指针 | 引入变长列表与 NULL 位图 |
| DYNAMIC | 5.7.9+ 默认 | 页内只留 20 字节指针 | 支持最长 3072 字节的索引前缀 |
| COMPRESSED | — | 同 DYNAMIC，页面压缩 | CPU 换空间，写多场景慎用 |

COMPACT/DYNAMIC 的行结构：

- **变长字段长度列表**：逆序存放每个非 NULL 变长列的实际长度，每列 1 或 2 字节。
- **NULL 值列表**：可为 NULL 的列每列 1 bit，向上补齐到整字节。全部列 `NOT NULL` 时不存在。
- **记录头 5 字节**，随后是隐藏列：`DB_ROW_ID`（6B，仅无主键且无非空唯一键时）、`DB_TRX_ID`（6B，最近修改它的事务）、`DB_ROLL_PTR`（7B，指向 undo 中的旧版本）。

### 行溢出与 65535 限制

- MySQL Server 层规定一行所有列（不含 TEXT/BLOB 的实际内容）的定义长度合计不超过 **65535 字节**，其中包括变长列的长度字节和 NULL 标记。utf8mb4 下 `VARCHAR(n)` 最多占 4n 字节，所以单列 `VARCHAR(16383)` 已是极限。
- InnoDB 还要求**一页至少能放两行**，因此一行在页内的部分大约不能超过 8KB（16KB 页）。超出时把最长的变长列移到**溢出页**（BLOB 页），DYNAMIC 格式在原行只保留 20 字节指针。
- 影响：`SELECT *` 读大字段时要额外读溢出页，随机 I/O 增加。大字段建议拆到扩展表，或者查询时只取需要的列。

## Buffer Pool

InnoDB 所有读写都经过 Buffer Pool：读时先查缓冲池，没有再从磁盘读入；写时只改缓冲池中的页，由后台刷回。

每个缓存页都有一个**控制块**（记录表空间号、页号、所在链表节点、锁、LSN 等），页的定位靠一张以 `(space_id, page_no)` 为 key 的哈希表。

### 三条链表

| 链表 | 内容 | 作用 |
| --- | --- | --- |
| Free 链表 | 空闲的缓存页 | 读入新页时从这里取 |
| LRU 链表 | 所有已使用的缓存页（干净 + 脏） | 决定空闲页不足时淘汰谁 |
| Flush 链表 | 脏页，按 `oldest_modification`（第一次被修改时的 LSN）排序 | 决定刷脏顺序与 checkpoint 能推进到哪里 |

脏页同时在 LRU 链表和 Flush 链表上。

### young / old 分区的 LRU

朴素 LRU 有两个问题：**预读**读入的页可能根本用不到；**全表扫描**一次性读入大量只用一次的页，会把真正的热点挤出去。InnoDB 的解法是把 LRU 链表切成两段：

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Buffer Pool 的 LRU 链表分为 young 区与 old 区，以及新页插入与晋升规则">
<line class="la" x1="600" y1="60" x2="600" y2="30"/>
<line class="la" x1="600" y1="30" x2="40" y2="30"/>
<line class="la" x1="40" y1="30" x2="40" y2="58" marker-end="url(#arr-a)"/>
<text class="ts" x="320" y="20" text-anchor="middle">② 在 old 区停留超过 innodb_old_blocks_time 后再被访问 → 移到 young 头部</text>
<rect class="b2" x="20" y="60" width="437" height="50"/>
<text class="tb" x="238" y="85" text-anchor="middle" dominant-baseline="middle">young 区（热点页，约 5/8）</text>
<rect class="b3" x="457" y="60" width="263" height="50"/>
<text class="tb" x="588" y="85" text-anchor="middle" dominant-baseline="middle">old 区（约 3/8）</text>
<text class="ts" x="20" y="128">LRU 头</text>
<text class="ts" x="450" y="128" text-anchor="end">midpoint（innodb_old_blocks_pct=37）</text>
<text class="ts" x="720" y="128" text-anchor="end">LRU 尾 → 淘汰</text>
<rect class="b" x="20" y="160" width="200" height="54" rx="8"/>
<text class="tb" x="120" y="178" text-anchor="middle" dominant-baseline="middle">Free 链表</text>
<text class="ts" x="120" y="198" text-anchor="middle" dominant-baseline="middle">空闲页，读盘时先从这里取</text>
<rect class="b" x="240" y="160" width="220" height="54" rx="8"/>
<text class="tb" x="350" y="178" text-anchor="middle" dominant-baseline="middle">Flush 链表</text>
<text class="ts" x="350" y="198" text-anchor="middle" dominant-baseline="middle">脏页，按最早修改 LSN 排序</text>
<rect class="b1" x="500" y="160" width="220" height="54" rx="8"/>
<text class="tb" x="610" y="178" text-anchor="middle" dominant-baseline="middle">① 从磁盘读入的新页</text>
<text class="ts" x="610" y="198" text-anchor="middle" dominant-baseline="middle">插入 old 区头部（midpoint）</text>
<line class="l" x1="560" y1="160" x2="474" y2="113" marker-end="url(#arr)"/>
<text class="ts" x="20" y="242">③ 全表扫描读入的页在 1 秒内反复访问也不晋升，只在 old 区流转并很快从尾部淘汰，热点不被冲掉</text>
<text class="ts" x="20" y="264">young 区前 1/4 的页被访问时不移动位置，减少频繁调整链表带来的锁竞争</text>
</svg>
<figcaption>图 3：midpoint 插入策略。新页先进 old 区，只有“隔了一段时间还被访问”的页才被视为热点</figcaption>
</figure>

### 关键参数

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `innodb_buffer_pool_size` | 128MB | 专用数据库服务器通常设为物理内存的 50%～75%；5.7.5+ 支持在线调整（按 chunk 增减） |
| `innodb_buffer_pool_instances` | 8（池小于 1GB 时为 1） | 多实例降低链表互斥锁竞争 |
| `innodb_buffer_pool_chunk_size` | 128MB | 在线扩缩容的粒度 |
| `innodb_old_blocks_pct` | 37 | old 区占比 |
| `innodb_old_blocks_time` | 1000 ms | old 区页晋升前的最短停留时间 |
| `innodb_read_ahead_threshold` | 56 | 线性预读：一个区内顺序访问页数达到阈值时预读下一个区 |
| `innodb_buffer_pool_dump_at_shutdown` / `load_at_startup` | ON / ON | 重启时保存与恢复热点页列表（默认 25%），避免重启后长时间冷启动 |

命中率观测：

```sql
-- 逻辑读请求与真正的物理读
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_read%';
-- 命中率 ≈ 1 - Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests，OLTP 一般应高于 99%
-- 有线程在等空闲页（刷脏跟不上）
SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_wait_free';
```

## Change Buffer

更新**非唯一二级索引**时，如果目标页不在 Buffer Pool，InnoDB 不去磁盘读页，而是把变更记录在 Change Buffer 中，等这个页之后被读入时再合并（merge）。省掉的是一次随机读。

- **唯一索引不能用**：必须读出页来判断是否冲突。
- 合并时机：该页被读入 Buffer Pool；后台线程定期合并；Change Buffer 空间不足；正常关闭（取决于 `innodb_fast_shutdown`）。
- Change Buffer 在内存中占用 Buffer Pool 空间（`innodb_change_buffer_max_size`，默认 25%），持久化在系统表空间，变更同样受 redo 保护。
- 适合**写多读少**、写入后不会马上读的场景（日志、流水）；写完立即读的场景反而多了维护开销。

> [!NOTE] 版本差异
> 8.0 中 `innodb_change_buffering` 默认 `all`；8.4 LTS 起默认改为 `none`（同时 `innodb_adaptive_hash_index` 默认改为 OFF）。原因是 SSD 普及后随机读代价下降，而 Change Buffer 带来的合并开销与复杂度依然存在。

## 自适应哈希索引（AHI）

InnoDB 监控对索引页的访问模式，若某些页总是以相同的前缀条件被等值访问，就自动在内存中为其建立哈希索引，跳过 B+ 树逐层查找。

- 完全自动，不能手工指定；`innodb_adaptive_hash_index` 控制开关，8.0 下分区为 `innodb_adaptive_hash_index_parts=8` 个分区以减少锁竞争。
- 观察 `SHOW ENGINE INNODB STATUS` 中 `INSERT BUFFER AND ADAPTIVE HASH INDEX` 段的 `hash searches/s` 与 `non-hash searches/s`。
- 在高并发写、大量 `DROP TABLE`/`TRUNCATE`、LIKE/JOIN 复杂查询的负载下，AHI 的维护锁可能成为瓶颈（信号量等待集中在 `btr0sea`），此时关闭反而更快。

## Doublewrite Buffer

**问题**：InnoDB 页 16KB，而文件系统/磁盘的原子写单位通常是 4KB。刷一个页写到一半掉电，会留下一个“前半新、后半旧”的残页。redo 记录的是“对某页某偏移做了什么修改”，必须基于一个完整的页才能重放，所以 redo 救不了残页。

**做法**：刷脏时先把脏页顺序写入 doublewrite 区并 fsync，再写到各自的真实位置。崩溃恢复时如果发现某数据页校验和错误，就从 doublewrite 中取回完整副本覆盖，再应用 redo。

- 5.7：doublewrite 区位于系统表空间（2MB，128 页）；**8.0.20+** 移到独立的 `#ib_*.dblwr` 文件，可放在不同磁盘（`innodb_doublewrite_dir`）。
- 8.0.30 起 `innodb_doublewrite` 可设为 `DETECT_ONLY`（只写元数据，只检测不修复）等取值。
- 只有在文件系统或硬件保证 16KB 原子写（如 ZFS、部分支持原子写的存储）时才能关闭。

## 刷脏：时机与 innodb_io_capacity

脏页什么时候刷回磁盘？

1. **redo 空间不足**：checkpoint 只能推进到 Flush 链表上最老脏页对应的 LSN。redo 快写满时必须先刷脏推进 checkpoint，写满时**所有更新都会被阻塞**——这是最严重的抖动。
2. **空闲页不足**：LRU 尾部要淘汰的页如果是脏页，要先刷盘才能释放；page cleaner 会按 `innodb_lru_scan_depth`（默认 1024）预先在 LRU 尾部扫描并刷脏，保证有空闲页。
3. **脏页比例过高**：超过 `innodb_max_dirty_pages_pct_lwm` 开始预刷，接近 `innodb_max_dirty_pages_pct` 时加速。
4. **系统空闲**、**正常关闭**时。

| 参数 | 默认值（8.0） | 说明 |
| --- | --- | --- |
| `innodb_io_capacity` | 200 | 告诉 InnoDB 磁盘的 IOPS 能力，后台刷脏与合并以此为基准；SSD 建议设到实际可用 IOPS 的合理比例（如数千） |
| `innodb_io_capacity_max` | 2000 | 刷脏压力大时的上限 |
| `innodb_max_dirty_pages_pct` | 90（5.7 为 75） | 脏页比例上限 |
| `innodb_max_dirty_pages_pct_lwm` | 10（5.7 为 0） | 开始预刷的低水位 |
| `innodb_flush_neighbors` | 0（5.7 为 1） | 刷脏时是否连带刷同一区内相邻的脏页，机械盘有用，SSD 应关闭 |
| `innodb_adaptive_flushing` | ON | 根据 redo 生成速度自适应调整刷脏速率 |
| `innodb_page_cleaners` | 4 | page cleaner 线程数，不超过 Buffer Pool 实例数 |

> [!WARNING] io_capacity 设得太低是抖动的常见根因
> SSD 上仍用默认 200，InnoDB 以为磁盘很慢，平时刷得少，redo 很快接近写满，然后被迫进入激进刷脏，表现为 TPS 周期性跌落、`SHOW ENGINE INNODB STATUS` 中 checkpoint age 逼近上限。反过来设得远超磁盘能力，又会让刷脏 I/O 挤占前台读。

## 生产实践与踩坑

**1. 业务高峰时 SQL 偶发变慢、TPS 周期性下降**

排查：看 `Innodb_buffer_pool_pages_dirty` 占比、redo 的 checkpoint age（`SHOW ENGINE INNODB STATUS` 的 `LOG` 段：`Log sequence number` 与 `Last checkpoint at` 的差值）是否接近 redo 容量。修复：增大 redo 容量（8.0.30+ `innodb_redo_log_capacity`）、按磁盘能力调高 `innodb_io_capacity`、SSD 关闭 `innodb_flush_neighbors`。

**2. 一个报表 SQL 让在线业务全体变慢**

大查询扫描大量冷数据。midpoint 策略能防止一次性扫描冲掉 young 区，但如果报表频繁、持续时间长（超过 `innodb_old_blocks_time`），冷页仍会晋升。根本做法是报表走只读从库。

**3. 重启后很长时间性能差**

Buffer Pool 冷启动。确认 `innodb_buffer_pool_load_at_startup=ON`，并可适当调大 `innodb_buffer_pool_dump_pct`；观察 `Innodb_buffer_pool_load_status`。

**4. 删了大量数据，`.ibd` 文件不缩小**

删除只是打删除标记，purge 后页内空间可复用，但不会归还给文件系统。需要 `ALTER TABLE t ENGINE=InnoDB`（或 `OPTIMIZE TABLE`）重建表，该操作 Online DDL 下允许并发 DML，但大表会消耗大量 I/O 并需要额外的磁盘空间，应在低峰执行或用 gh-ost / pt-online-schema-change。

## 相关阅读

- [B+ 树索引原理](#/mysql/index)：B+ 树索引
- [redo / undo / binlog](#/mysql/log)：redo、undo 与 binlog
- [文件系统、页缓存与零拷贝](#/cs/os-io)：页缓存、Direct IO 与 fsync
- [复杂度与核心数据结构](#/cs/algo-ds)：B+ 树与其他有序结构的对比

## 面试追问

> [!QUESTION] InnoDB 的页为什么是 16KB？一个页里怎么快速找到一条记录？
> 16KB 是 I/O 次数与单次读放大之间的折中，让 B+ 树非叶子节点能放上千个指针、树高很低。页内记录分组，Page Directory 记录每组最大记录的偏移；查找时在槽上二分，再在组内（最多 8 条）顺序遍历。

> [!QUESTION] Buffer Pool 为什么不用普通 LRU？
> 预读和全表扫描会把大量只用一次的页放到链表头，挤掉真正的热点。InnoDB 新页插入 old 区头部，只有在 old 区停留超过 `innodb_old_blocks_time` 后再被访问才移到 young 区。

> [!QUESTION] 有了 redo log 为什么还需要 doublewrite？
> redo 记录的是对页的物理修改，重放前提是磁盘上的页本身完整。16KB 页写到一半掉电会产生残页，redo 无法修复，只能用 doublewrite 中的完整副本先覆盖，再应用 redo。

> [!QUESTION] Change Buffer 为什么只对非唯一二级索引生效？
> 唯一索引插入必须检查是否冲突，必须把页读进内存，既然读了就直接改，缓冲没有意义。主键（聚簇索引）同理。

> [!QUESTION] MySQL 为什么会“抖一下”？
> 典型是刷脏：redo 写满或空闲页不足时，用户线程必须等刷脏完成。排查 checkpoint age、脏页比例、`Innodb_buffer_pool_wait_free`，调整 redo 容量和 `innodb_io_capacity`。

> [!QUESTION] 大字段对性能有什么影响？
> 超出页内限制时被放到溢出页，DYNAMIC 格式只在原行留 20 字节指针。`SELECT *` 会多读溢出页；同时一页能放的行变少，扫描需要更多 I/O。建议大字段拆表或只查需要的列。
