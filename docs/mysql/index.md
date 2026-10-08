---
level: 深入
tags: [InnoDB, B+树, 聚簇索引, 联合索引, 索引下推, 页分裂]
summary: 讲清 InnoDB 为什么用 B+ 树、聚簇与二级索引如何协作、联合索引的排序本质，以及索引失效、主键选型与 8.0 新索引特性等生产问题。
---

# B+ 树索引原理

> [!ABSTRACT] 核心要点
> - InnoDB 是**索引组织表**：主键索引（聚簇索引）叶子存整行，二级索引叶子存“索引列 + 主键值”，用二级索引查非索引列需要**回表**。
> - B+ 树非叶子节点只存键和指针，扇出可达上千，**3 层约可容纳两千万行**（按 1KB/行估算），等值查询 I/O 稳定在 1～3 次。
> - 联合索引 `(a,b,c)` 按 a→b→c 字典序排列，**最左前缀**本质是“只有前面的列相等时后面的列才有序”。
> - 覆盖索引避免回表；索引下推（ICP，5.6+）把过滤下推到引擎层减少回表；MRR 把随机回表变成按主键顺序。
> - 主键首选单调递增的整型（自增或趋势递增的分布式 ID），随机 UUID 会导致频繁页分裂、索引膨胀、缓存命中率下降。

## 为什么是 B+ 树

数据库索引的核心约束是**磁盘 I/O**：内存访问是纳秒级，一次随机磁盘读是毫秒（HDD）或百微秒（SSD）级。索引结构要做的是**用最少的页读取次数定位数据**，并且支持范围查询和排序。

| 结构 | 等值查询 | 范围 / 排序 | 磁盘友好度 | 问题 |
| --- | --- | --- | --- | --- |
| 哈希表 | O(1) | 不支持 | 一般 | 无法范围查询、无法利用前缀、哈希冲突；Memory 引擎和 InnoDB 自适应哈希在用 |
| 二叉搜索树 | O(log₂n) | 支持 | 差 | 可能退化成链表；每个节点一次 I/O，树太高 |
| AVL / 红黑树 | O(log₂n) | 支持 | 差 | 平衡了，但每个节点只有 2 个分叉，千万行需要二十多层 |
| B 树 | O(logₘn) | 支持但需中序遍历 | 好 | 非叶子节点也存数据，扇出降低；范围扫描要在层间来回跳 |
| **B+ 树** | O(logₘn) | **叶子链表顺序扫描** | 最好 | 写入有页分裂代价 |

B+ 树相对 B 树的三个优势：

1. **非叶子节点不存数据**，一页能放更多键，扇出更大，树更矮。
2. **所有数据在叶子层**，任何查询都要走到叶子，查询代价稳定。
3. **叶子页之间是双向链表**，范围查询定位到起点后顺序扫描即可，`ORDER BY` 也能直接利用。

### 3 层 B+ 树能存多少行

以主键 `BIGINT` 为例：

- 非叶子节点每个目录项 = 主键 8 字节 + 页号指针 6 字节 = 14 字节，16KB 页约能放 16384 / 14 ≈ **1170** 个目录项。
- 叶子节点存整行，假设一行 1KB，一页约放 **16** 行。
- 3 层：1170 × 1170 × 16 ≈ **2190 万行**；4 层约 256 亿行。

> [!NOTE] 这个数字只是数量级估算
> 页内还有页头、页目录等开销，且页通常不是 100% 填满；行越宽，叶子页能放的行越少。“单表两千万行就要分表”不是硬限制，真正决定性能的是树高、热点数据能否放进 Buffer Pool 以及业务查询模式。根页和第二层通常常驻内存，所以 3 层树的等值查询往往只有 1 次物理读。

## 聚簇索引与二级索引

- **聚簇索引**：按主键组织的 B+ 树，叶子页存完整行。一张表只有一个。没有显式主键时，InnoDB 选第一个非空唯一索引；再没有就用隐藏的 6 字节 `DB_ROW_ID`（全局共享的计数器，会成为并发插入的竞争点）。
- **二级索引**：叶子存“索引列值 + 主键值”。选择存主键而非物理地址，是因为行在页分裂时会移动，存主键则二级索引不需要随之更新。

<figure class="fig">
<svg viewBox="0 0 760 325" class="dg" role="img" aria-label="聚簇索引叶子存整行，二级索引叶子存索引列和主键，通过主键回表">
<text class="ts" x="20" y="18">聚簇索引（主键 id）：叶子页存整行</text>
<text class="ts" x="400" y="18">二级索引 idx_name：叶子页存 (name, id)</text>
<rect class="b1" x="110" y="40" width="150" height="36" rx="6"/>
<text class="tm" x="185" y="58" text-anchor="middle" dominant-baseline="middle">1 | 20 | 40</text>
<line class="l" x1="150" y1="76" x2="72" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="185" y1="76" x2="184" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="220" y1="76" x2="296" y2="148" marker-end="url(#arr)"/>
<rect class="b2" x="20" y="150" width="105" height="100" rx="6"/>
<text class="tm" x="72" y="175" text-anchor="middle" dominant-baseline="middle">1 Ann 18</text>
<text class="tm" x="72" y="200" text-anchor="middle" dominant-baseline="middle">7 Bob 25</text>
<text class="tm" x="72" y="225" text-anchor="middle" dominant-baseline="middle">15 Cat 30</text>
<rect class="b2" x="132" y="150" width="105" height="100" rx="6"/>
<text class="ta" x="184" y="175" text-anchor="middle" dominant-baseline="middle">20 Eve 22</text>
<text class="tm" x="184" y="200" text-anchor="middle" dominant-baseline="middle">25 Kim 19</text>
<text class="tm" x="184" y="225" text-anchor="middle" dominant-baseline="middle">33 Leo 27</text>
<rect class="b2" x="244" y="150" width="105" height="100" rx="6"/>
<text class="tm" x="296" y="175" text-anchor="middle" dominant-baseline="middle">40 Dan 31</text>
<text class="tm" x="296" y="200" text-anchor="middle" dominant-baseline="middle">52 Fay 24</text>
<rect class="b1" x="490" y="40" width="150" height="36" rx="6"/>
<text class="tm" x="565" y="58" text-anchor="middle" dominant-baseline="middle">Ann | Dan | Kim</text>
<line class="l" x1="530" y1="76" x2="452" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="565" y1="76" x2="564" y2="148" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="76" x2="676" y2="148" marker-end="url(#arr)"/>
<rect class="b3" x="400" y="150" width="105" height="100" rx="6"/>
<text class="tm" x="452" y="175" text-anchor="middle" dominant-baseline="middle">Ann 1</text>
<text class="tm" x="452" y="200" text-anchor="middle" dominant-baseline="middle">Bob 7</text>
<text class="tm" x="452" y="225" text-anchor="middle" dominant-baseline="middle">Cat 15</text>
<rect class="b3" x="512" y="150" width="105" height="100" rx="6"/>
<text class="tm" x="564" y="175" text-anchor="middle" dominant-baseline="middle">Dan 40</text>
<text class="ta" x="564" y="200" text-anchor="middle" dominant-baseline="middle">Eve 20</text>
<text class="tm" x="564" y="225" text-anchor="middle" dominant-baseline="middle">Fay 52</text>
<rect class="b3" x="624" y="150" width="105" height="100" rx="6"/>
<text class="tm" x="676" y="175" text-anchor="middle" dominant-baseline="middle">Kim 25</text>
<text class="tm" x="676" y="200" text-anchor="middle" dominant-baseline="middle">Leo 33</text>
<line class="la" x1="564" y1="250" x2="564" y2="292"/>
<line class="la" x1="564" y1="292" x2="184" y2="292"/>
<line class="la" x1="184" y1="292" x2="184" y2="253" marker-end="url(#arr-a)"/>
<text class="ta" x="374" y="312" text-anchor="middle" dominant-baseline="middle">name='Eve'：idx_name 得 id=20，再回聚簇索引取整行（回表）</text>
</svg>
<figcaption>图 1：二级索引叶子按 (name, id) 有序，只存主键；查询需要其他列时按主键回到聚簇索引再查一次</figcaption>
</figure>

### 覆盖索引

查询需要的列全部在二级索引中（索引列 + 主键），就不必回表，`EXPLAIN` 的 Extra 显示 `Using index`。

```sql
-- idx_name(name)
SELECT id, name FROM user WHERE name = 'Eve';          -- 覆盖索引，无回表
SELECT id, name, age FROM user WHERE name = 'Eve';     -- 需要回表取 age
-- 高频查询可把 age 加入索引：idx_name_age(name, age)
```

### 索引下推（ICP）

5.6 引入。对于 `idx(name, age)`，查询 `WHERE name LIKE 'A%' AND age = 20`：

- **无 ICP**：引擎按 `name LIKE 'A%'` 范围找到每条索引记录就回表，把整行交给 Server 层再判断 `age = 20`。
- **有 ICP**：引擎在二级索引上直接判断 `age = 20`（age 在索引里），不满足的不回表。Extra 显示 `Using index condition`。

ICP 只用于二级索引（聚簇索引已经是整行，没有回表可省），条件必须只涉及索引中的列。

### MRR（Multi-Range Read）

二级索引上取出的主键是无序的，逐条回表就是随机 I/O。MRR 先把一批主键放进 `read_rnd_buffer` 排序，再按主键顺序回表，近似顺序 I/O。Extra 显示 `Using MRR`。由于 `mrr_cost_based=on`，优化器默认很少选择它；SSD 上收益有限。

## 联合索引与最左前缀

联合索引 `idx(a, b, c)` 只是一棵 B+ 树，叶子按 `(a, b, c)` 的字典序排列：先比较 a，a 相同再比较 b，以此类推。

<figure class="fig">
<svg viewBox="0 0 740 295" class="dg" role="img" aria-label="联合索引 (a,b,c) 叶子记录的排序方式：a 全局有序，b 仅在 a 相等时有序">
<line class="l" x1="84" y1="48" x2="304" y2="48"/>
<text class="ts" x="194" y="38" text-anchor="middle">a=1</text>
<line class="l" x1="312" y1="48" x2="456" y2="48"/>
<text class="ts" x="384" y="38" text-anchor="middle">a=2</text>
<line class="l" x1="464" y1="48" x2="684" y2="48"/>
<text class="ts" x="574" y="38" text-anchor="middle">a=3</text>
<text class="tb" x="40" y="78" text-anchor="middle" dominant-baseline="middle">a</text>
<text class="tb" x="40" y="114" text-anchor="middle" dominant-baseline="middle">b</text>
<text class="tb" x="40" y="150" text-anchor="middle" dominant-baseline="middle">c</text>
<text class="tb" x="40" y="186" text-anchor="middle" dominant-baseline="middle">id</text>
<rect class="b1" x="80" y="60" width="76" height="36"/>
<rect class="b1" x="156" y="60" width="76" height="36"/>
<rect class="b1" x="232" y="60" width="76" height="36"/>
<rect class="b1" x="308" y="60" width="76" height="36"/>
<rect class="b1" x="384" y="60" width="76" height="36"/>
<rect class="b1" x="460" y="60" width="76" height="36"/>
<rect class="b1" x="536" y="60" width="76" height="36"/>
<rect class="b1" x="612" y="60" width="76" height="36"/>
<text class="tm" x="118" y="78" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="194" y="78" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="270" y="78" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="346" y="78" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="422" y="78" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="498" y="78" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="574" y="78" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="650" y="78" text-anchor="middle" dominant-baseline="middle">3</text>
<rect class="b2" x="80" y="96" width="76" height="36"/>
<rect class="b2" x="156" y="96" width="76" height="36"/>
<rect class="b2" x="232" y="96" width="76" height="36"/>
<rect class="b2" x="308" y="96" width="76" height="36"/>
<rect class="b2" x="384" y="96" width="76" height="36"/>
<rect class="b2" x="460" y="96" width="76" height="36"/>
<rect class="b2" x="536" y="96" width="76" height="36"/>
<rect class="b2" x="612" y="96" width="76" height="36"/>
<text class="tm" x="118" y="114" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="194" y="114" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="270" y="114" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="346" y="114" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="422" y="114" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="498" y="114" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="574" y="114" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="650" y="114" text-anchor="middle" dominant-baseline="middle">4</text>
<rect class="b3" x="80" y="132" width="76" height="36"/>
<rect class="b3" x="156" y="132" width="76" height="36"/>
<rect class="b3" x="232" y="132" width="76" height="36"/>
<rect class="b3" x="308" y="132" width="76" height="36"/>
<rect class="b3" x="384" y="132" width="76" height="36"/>
<rect class="b3" x="460" y="132" width="76" height="36"/>
<rect class="b3" x="536" y="132" width="76" height="36"/>
<rect class="b3" x="612" y="132" width="76" height="36"/>
<text class="tm" x="118" y="150" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="194" y="150" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="270" y="150" text-anchor="middle" dominant-baseline="middle">5</text>
<text class="tm" x="346" y="150" text-anchor="middle" dominant-baseline="middle">4</text>
<text class="tm" x="422" y="150" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="498" y="150" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="574" y="150" text-anchor="middle" dominant-baseline="middle">8</text>
<text class="tm" x="650" y="150" text-anchor="middle" dominant-baseline="middle">2</text>
<rect class="b" x="80" y="168" width="76" height="36"/>
<rect class="b" x="156" y="168" width="76" height="36"/>
<rect class="b" x="232" y="168" width="76" height="36"/>
<rect class="b" x="308" y="168" width="76" height="36"/>
<rect class="b" x="384" y="168" width="76" height="36"/>
<rect class="b" x="460" y="168" width="76" height="36"/>
<rect class="b" x="536" y="168" width="76" height="36"/>
<rect class="b" x="612" y="168" width="76" height="36"/>
<text class="tm" x="118" y="186" text-anchor="middle" dominant-baseline="middle">9</text>
<text class="tm" x="194" y="186" text-anchor="middle" dominant-baseline="middle">4</text>
<text class="tm" x="270" y="186" text-anchor="middle" dominant-baseline="middle">2</text>
<text class="tm" x="346" y="186" text-anchor="middle" dominant-baseline="middle">7</text>
<text class="tm" x="422" y="186" text-anchor="middle" dominant-baseline="middle">1</text>
<text class="tm" x="498" y="186" text-anchor="middle" dominant-baseline="middle">6</text>
<text class="tm" x="574" y="186" text-anchor="middle" dominant-baseline="middle">3</text>
<text class="tm" x="650" y="186" text-anchor="middle" dominant-baseline="middle">5</text>
<line class="la" x1="160" y1="214" x2="304" y2="214"/>
<line class="la" x1="160" y1="207" x2="160" y2="214"/>
<line class="la" x1="304" y1="207" x2="304" y2="214"/>
<text class="ta" x="232" y="232" text-anchor="middle" dominant-baseline="middle">a=1 AND b=2：连续区间</text>
<text class="ts" x="20" y="262">a 全局有序；b 只在 a 相同时有序，c 只在 (a,b) 相同时有序 → 跳过 a 直接查 b 无法二分定位</text>
<text class="ts" x="20" y="282">a&gt;1 AND b=1：只能用 a 做范围定位，b 只能在扫描时逐条过滤（可借助 ICP 在引擎层完成）</text>
</svg>
<figcaption>图 2：联合索引 (a,b,c) 的叶子记录（同一页内示意）。最左前缀的本质是“后一列的有序性依赖前一列相等”</figcaption>
</figure>

由此可以推出各种查询能否用上索引：

| 条件 | 能用到的索引列 | 说明 |
| --- | --- | --- |
| `a=1` | a | |
| `a=1 AND b=2` | a, b | 顺序无关，优化器会重排 `b=2 AND a=1` |
| `a=1 AND b=2 AND c>3` | a, b, c | 最后一列可以是范围 |
| `a=1 AND b>2 AND c=3` | a, b | b 是范围，之后的 c 在区间内无序，只能过滤（ICP） |
| `a=1 AND c=3` | a | c 用 ICP 过滤 |
| `b=2` / `b=2 AND c=3` | 通常无 | 8.0.13+ 在 a 基数很低时可能走 **Index Skip Scan**（`Using index for skip scan`） |
| `a=1 ORDER BY b` | a + 利用 b 的有序性 | 无 filesort |
| `a>1 ORDER BY b` | a | 需要 filesort |
| `a IN (1,2) AND b=2` | a, b | IN 是多个等值，区间仍可用到 b；但 `ORDER BY` 后续列会需要排序 |

> [!TIP] `LIKE 'abc%'` 是范围查询
> 前缀匹配会被转换成 `>= 'abc' AND < 'abd'` 这样的范围，所以 `idx(name, age)` 上 `name LIKE 'abc%' AND age = 20` 中 age 不能用于定位，只能 ICP 过滤。

## 页分裂与主键选择

### 页分裂

插入记录时，如果目标叶子页已满：

- **顺序插入**（新键大于页内所有键）：InnoDB 通过 Page Header 的 `PAGE_DIRECTION` 识别出递增插入模式，直接申请新页放新记录，老页保持接近填满（会预留约 1/16 空间供后续更新使用）。
- **随机插入**：把原页约一半记录移到新页，两个页都只填一半左右；同时父节点要插入新的目录项，可能级联分裂。

页分裂的代价：数据移动、更多的页（空间利用率约 50%～70%）、更多的 redo、父节点加锁。删除导致页利用率低于 `MERGE_THRESHOLD`（默认 50%）时会尝试与相邻页合并。

### 自增主键 vs UUID vs 雪花 ID

| 方案 | 有序性 | 长度 | 插入表现 | 问题 |
| --- | --- | --- | --- | --- |
| `BIGINT AUTO_INCREMENT` | 严格递增 | 8 字节 | 总在最右叶子追加，页填充率高 | 分库后不唯一；暴露业务量；右侧页热点（一般可接受） |
| UUID v4（`CHAR(36)`） | 随机 | 36 字节（utf8mb4 下索引占用更大） | 随机插入、大量页分裂 | 所有二级索引都存一份主键，索引膨胀；缓存命中率差 |
| UUID 转 `BINARY(16)` + `UUID_TO_BIN(u, 1)` | v1 可趋势递增（8.0） | 16 字节 | 较好 | 可读性差，需函数转换 |
| 雪花 ID（`BIGINT`） | 趋势递增 | 8 字节 | 接近自增 | 依赖时钟，需处理回拨，见 [分布式 ID 生成](#/distributed/id) |

> [!NOTE] 自增值的版本差异
> 5.7 自增计数器只在内存中，重启后取 `MAX(id)+1`，删除最大行再重启会复用 ID；**8.0 把计数器持久化到 redo**，不会回退。`innodb_autoinc_lock_mode` 8.0 默认 2（交错模式，配合 ROW 格式 binlog），5.7 默认 1（连续模式）。

## 索引失效场景清单

“失效”有两种：**不能用**（结构上无法利用有序性）与**不选用**（能用但优化器认为全表扫描更便宜）。

| 场景 | 示例 | 原因 |
| --- | --- | --- |
| 对索引列做函数 / 运算 | `WHERE DATE(create_time) = '2024-01-01'`、`WHERE id + 1 = 10` | 函数结果的顺序与索引顺序无关；改写为范围 `create_time >= ... AND < ...` |
| 隐式类型转换 | `phone` 是 `VARCHAR`，`WHERE phone = 13800000000` | 字符串与数字比较时把列转成数字，相当于对列用函数；反过来 INT 列比较字符串常量不受影响 |
| 隐式字符集转换 | 关联字段一个 `utf8`、一个 `utf8mb4` | 在 utf8 一侧的列上套了 `CONVERT()`，被驱动表索引失效 |
| 前导模糊 | `LIKE '%abc'` | 无法确定范围起点；可用全文索引或反转字段 |
| 违背最左前缀 | `idx(a,b)` 查 `b=?` | 见上表 |
| OR 连接非索引列 | `WHERE a = 1 OR d = 2`（d 无索引） | 一侧需要全表扫描，整体全表；两侧都有索引时可能用 index merge |
| 范围之后的列 | `a > 1 AND b = 2` | b 只能过滤 |
| 区分度低或返回行过多 | `status = 1` 占 80% | 回表代价高于全表扫描，优化器放弃 |
| `!=`、`NOT IN`、`IS NOT NULL` | | 不是一定失效，取决于代价估算 |
| 统计信息不准 | 大批量导入后 | 优化器估算错误，选错索引，见 [EXPLAIN 与 SQL 调优](#/mysql/optimize) |

`IS NULL` 可以走索引（NULL 值在 InnoDB 二级索引中被视为最小值存储）。

## 前缀索引

长字符串（如 email、URL）可以只索引前 N 个字符：

```sql
-- 计算不同前缀长度的区分度，接近完整列区分度即可
SELECT COUNT(DISTINCT LEFT(email, 6))  / COUNT(*) AS s6,
       COUNT(DISTINCT LEFT(email, 10)) / COUNT(*) AS s10,
       COUNT(DISTINCT email)           / COUNT(*) AS s_full
FROM user;

ALTER TABLE user ADD INDEX idx_email (email(10));
```

代价：前缀索引**无法用于覆盖索引**（索引里不是完整值，必须回表核对），也**不能用于 ORDER BY / GROUP BY**。区分度不足时可以存反转字符串或额外的哈希列（如 `CRC32(url)`）再建索引。

## 8.0 新索引特性

### 函数索引（8.0.13+）

```sql
ALTER TABLE orders ADD INDEX idx_day ((DATE(create_time)));
SELECT * FROM orders WHERE DATE(create_time) = '2024-06-01';   -- 能用上 idx_day
```

本质是在隐藏的虚拟列上建索引；查询表达式必须与索引表达式**完全一致**。5.7 可以用“生成列 + 索引”实现同样效果。

### 降序索引（8.0）

5.7 语法上接受 `DESC` 但会忽略，依然按升序存储。8.0 真正支持降序存储，解决**混合排序**问题：

```sql
ALTER TABLE t ADD INDEX idx_a_b (a ASC, b DESC);
SELECT * FROM t ORDER BY a ASC, b DESC LIMIT 10;   -- 8.0 不需要 filesort
```

单列单方向的倒序（`ORDER BY a DESC`）不需要降序索引，反向扫描即可（Extra 显示 `Backward index scan`）。

### 不可见索引（8.0）

```sql
ALTER TABLE t ALTER INDEX idx_old INVISIBLE;   -- 优化器不再使用，但索引仍被维护
-- 观察一段时间无慢 SQL 后再真正删除；有问题立即改回 VISIBLE，秒级生效
```

删除大表索引前的“灰度开关”。可通过 `SET optimizer_switch='use_invisible_indexes=on'` 在会话内验证。主键不能设为不可见。

## 索引设计原则

1. **为查询设计索引**，而不是为列：从高频、慢的 SQL 出发，WHERE、JOIN、ORDER BY、GROUP BY 的列优先。
2. **联合索引列顺序**：等值条件列在前、范围列在后；同为等值时区分度高的在前，但更重要的是能被更多查询复用（`(a,b)` 能服务 `a` 和 `a,b` 两类查询）。
3. 优先考虑**覆盖索引**，尤其是高频的列表查询。
4. **控制数量**：每个索引都会增加写入（含 Change Buffer、redo、页分裂）和空间开销；单表索引一般控制在 5 个左右，删除冗余索引（`idx(a)` 被 `idx(a,b)` 覆盖）。可用 `sys.schema_redundant_indexes`、`sys.schema_unused_indexes` 辅助判断。
5. 字段尽量 `NOT NULL`、类型尽量小；字符串索引考虑前缀。
6. 主键使用短的、单调递增的整型，不要用业务字段（手机号、身份证）做主键。

## 生产实践与踩坑

**1. 加了索引但 SQL 还是全表扫描**

先 `EXPLAIN` 看 `possible_keys` 是否包含该索引：不包含说明结构上用不了（函数、隐式转换、最左前缀）；包含但 `key` 没选，说明代价估算认为不划算或统计信息不准，用 `ANALYZE TABLE` 后再看，必要时 `FORCE INDEX` 临时兜底。

**2. 关联查询突然变慢，`EXPLAIN` 里被驱动表 type=ALL**

经典原因是两表关联字段字符集不同（老表 utf8，新表 utf8mb4）或类型不同（一个 VARCHAR 一个 BIGINT）。统一字段定义即可解决。

**3. 用 UUID 做主键的表写入越来越慢**

随数据量增长，随机插入导致的页分裂和缓存未命中迅速增加，二级索引也被 36 字节主键撑大。修复：改为 `BIGINT` 自增主键，UUID 作为普通唯一键保留（对外暴露）。

**4. 删除“看起来没用”的索引导致故障**

某个月度报表或定时任务依赖该索引，删除后跑出慢 SQL 拖垮数据库。8.0 先 `INVISIBLE` 观察一个完整业务周期；也可以查 `performance_schema.table_io_waits_summary_by_index_usage` 确认使用情况。

## 面试追问

> [!QUESTION] 为什么 InnoDB 用 B+ 树而不是 B 树或红黑树？
> 红黑树是二叉的，千万级数据树高二十多层，每层一次 I/O。B 树非叶子节点存数据导致扇出小，且范围查询需要中序遍历跨层跳转。B+ 树非叶子只存键，扇出上千，3 层能存千万行；叶子链表让范围查询顺序扫描，查询代价稳定。

> [!QUESTION] 二级索引的叶子为什么存主键而不是行的物理地址？
> 聚簇索引中行会因页分裂、页合并而移动位置，如果二级索引存物理地址，每次移动都要更新所有二级索引；存主键则只需维护聚簇索引。代价是回表需要再查一次聚簇索引。

> [!QUESTION] 联合索引 (a,b,c)，查询 `WHERE a=1 AND b>2 AND c=3` 用到了哪些列？怎么看？
> a 和 b 用于定位范围，c 不能用于定位（b 范围内 c 无序），但可以通过 ICP 在引擎层过滤。看 `key_len` 能算出用了几列，Extra 出现 `Using index condition` 表示用了 ICP。

> [!QUESTION] 3 层 B+ 树大概能存多少数据？怎么算的？
> 非叶子目录项约 8 字节主键 + 6 字节指针 = 14 字节，16KB 页约 1170 项；假设行 1KB，叶子页约 16 行；1170 × 1170 × 16 ≈ 2000 万。数字只是数量级，行宽不同差别很大。

> [!QUESTION] 为什么不建议用 UUID 做主键？
> 随机写导致频繁页分裂、页填充率低、写放大；主键 36 字节，所有二级索引都要存一份，索引变大、Buffer Pool 能缓存的数据变少。建议用自增或趋势递增的 `BIGINT`，UUID 作为唯一键保留。

> [!QUESTION] 什么情况下优化器会放弃可用的索引？
> 估算返回行数占比过高时，回表的随机 I/O 代价超过全表顺序扫描；或统计信息不准导致估算错误。可以用覆盖索引消除回表，或 `ANALYZE TABLE` 更新统计信息，必要时用 `FORCE INDEX`。
