---
level: 深入
tags: [HashMap, 源码, 红黑树, 扩容, 并发问题]
summary: 逐行拆解 JDK 8 HashMap 的 hash、putVal、resize、treeifyBin，并解释 JDK 7 并发扩容死链与生产中的常见坑
---

# HashMap 源码剖析

> [!ABSTRACT] 核心要点
> - JDK 8 结构：`Node<K,V>[] table`（长度恒为 2 的幂）+ 链表 + 红黑树；下标 `(n - 1) & hash`，`hash = h ^ (h >>> 16)` 让高位参与寻址。
> - 表**懒初始化**：第一次 `put` 才 `resize()` 建表；`size > threshold`（容量 × 0.75）时扩容翻倍，链表按 `hash & oldCap` 一次拆成 **lo / hi** 两条，不重新算 hash。
> - 链表追加后长度达到 9（即插入前已有 `TREEIFY_THRESHOLD = 8` 个节点）才尝试树化，且表长 < `MIN_TREEIFY_CAPACITY = 64` 时**优先扩容而不是树化**；扩容拆分后树节点 ≤ 6 退化为链表。
> - JDK 7 头插法在并发扩容时会把链表反转，交错执行可形成**环形链表**，`get` 死循环打满 CPU；JDK 8 改尾插避免了成环，但并发下丢数据、size 不准等问题依旧。
> - 容量预估：`expected / 0.75 + 1`，或 JDK 19+ 的 `HashMap.newHashMap(expected)`；key 必须不可变且正确实现 `equals/hashCode`。

## 核心字段与常量

```java
// JDK 8 HashMap（节选）
static final int DEFAULT_INITIAL_CAPACITY = 1 << 4;   // 16
static final int MAXIMUM_CAPACITY = 1 << 30;
static final float DEFAULT_LOAD_FACTOR = 0.75f;
static final int TREEIFY_THRESHOLD = 8;               // 链表 → 树
static final int UNTREEIFY_THRESHOLD = 6;             // 树 → 链表（仅在 resize 拆分时判断）
static final int MIN_TREEIFY_CAPACITY = 64;           // 表长小于它时，宁可扩容也不树化

transient Node<K,V>[] table;   // 桶数组，首次 put 时才分配
transient int size;            // 键值对数量
transient int modCount;        // 结构性修改次数，供迭代器 fail-fast
int threshold;                 // 下次扩容阈值 = capacity * loadFactor；建表前暂存「初始容量」
final float loadFactor;

static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;            // 缓存的扰动后 hash，扩容时直接复用
    final K key;
    V value;
    Node<K,V> next;
}
// TreeNode extends LinkedHashMap.Entry extends HashMap.Node：
// 树节点同时保留 next/prev，所以树化后的桶仍可按链表顺序遍历
```

| 参数 | 默认值 | 说明与建议 |
| --- | --- | --- |
| `initialCapacity` | 16 | 会被 `tableSizeFor` 向上取整为 2 的幂；按 `预计元素数 / 0.75 + 1` 设置 |
| `loadFactor` | 0.75 | 调小 → 更少碰撞、更多内存；调大 → 省内存、链更长。几乎不需要改 |
| `TREEIFY_THRESHOLD` | 8 | 常量，不可配置 |
| `MIN_TREEIFY_CAPACITY` | 64 | 常量；小表碰撞多半是容量太小，扩容比树化更划算 |

## hash 扰动与 tableSizeFor

```java
// JDK 8 HashMap
static final int hash(Object key) {
    int h;
    // null key 的 hash 固定为 0，总在 table[0]；只允许一个 null key
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

下标是 `(n - 1) & hash`，表长 16 时只用到 hash 的**低 4 位**。如果 key 的 hashCode 差异集中在高位（例如 `Float`、某些以高位区分的自定义 hash），不扰动会全部挤进少数桶。把高 16 位异或到低 16 位，代价只是一次移位一次异或，就让高位信息参与了寻址。JDK 7 的扰动是 4 次移位异或，JDK 8 认为有了树化兜底，简化成一次。

```java
// JDK 8：把 cap 向上取整到 2 的幂
static final int tableSizeFor(int cap) {
    int n = cap - 1;          // 先减 1：cap 本身是 2 的幂时结果不翻倍
    n |= n >>> 1;             // 把最高位的 1 向右「抹平」：
    n |= n >>> 2;             //   0b0100_1000 → 0b0111_1111
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    return (n < 0) ? 1 : (n >= MAXIMUM_CAPACITY) ? MAXIMUM_CAPACITY : n + 1;
}
// JDK 17：int n = -1 >>> Integer.numberOfLeadingZeros(cap - 1);  语义相同，一条指令搞定
```

为什么容量必须是 2 的幂？

1. `(n - 1) & hash` 等价于 `hash % n`，位运算比除法快得多；
2. 扩容翻倍时，节点新下标只取决于 hash 的**一个 bit**（`hash & oldCap`），可以 O(1) 判断去向；
3. 代价是对低位分布敏感，所以需要扰动函数配合。

## putVal：插入主流程

```java
// JDK 8 HashMap#putVal（节选 + 注释）
final V putVal(int hash, K key, V value, boolean onlyIfAbsent, boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;                         // ① 懒初始化
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);            // ② 空桶直接放
    else {
        Node<K,V> e; K k;
        if (p.hash == hash &&
            ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;                                           // ③ 头节点就是目标 key
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);  // ④ 树桶
        else {
            for (int binCount = 0; ; ++binCount) {           // ⑤ 链表桶：遍历
                if ((e = p.next) == null) {
                    p.next = newNode(hash, key, value, null);    // 尾插
                    if (binCount >= TREEIFY_THRESHOLD - 1)       // 插入前已有 8 个节点
                        treeifyBin(tab, hash);
                    break;
                }
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    break;                                   // 找到相同 key
                p = e;
            }
        }
        if (e != null) {                                     // ⑥ key 已存在：覆盖 value
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            afterNodeAccess(e);                              // LinkedHashMap 钩子
            return oldValue;                                 // 覆盖不算结构修改，不 ++modCount
        }
    }
    ++modCount;
    if (++size > threshold)                                  // ⑦ 超过阈值扩容
        resize();
    afterNodeInsertion(evict);                               // LinkedHashMap 淘汰钩子
    return null;
}
```

几个细节：

- **key 比较顺序**：先比 `hash`（int 比较极快，且 hash 不等必不相同），再比引用 `==`，最后才调 `equals`。
- **树化时机的精确表述**：`binCount` 从 0 开始，第 k 轮检查的是第 k+1 个节点的 next；当插入前链表已有 8 个节点时，`binCount = 7` 满足条件，此时链表长度为 9。面试说「链表长度超过 8」更准确。
- `onlyIfAbsent` 对应 `putIfAbsent`；注意 `oldValue == null` 时即使 `onlyIfAbsent` 也会覆盖——存了 null value 的 key 会被 `putIfAbsent` 当作不存在。

## treeifyBin 与树化/退化

```java
// JDK 8 HashMap#treeifyBin（节选）
final void treeifyBin(Node<K,V>[] tab, int hash) {
    int n, index; Node<K,V> e;
    if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY)
        resize();                     // 表太小：扩容就能把链拆短，不树化
    else if ((e = tab[index = (n - 1) & hash]) != null) {
        TreeNode<K,V> hd = null, tl = null;
        do {                          // 先把 Node 换成 TreeNode，串成双向链表
            TreeNode<K,V> p = replacementTreeNode(e, null);
            if (tl == null) hd = p;
            else { p.prev = tl; tl.next = p; }
            tl = p;
        } while ((e = e.next) != null);
        if ((tab[index] = hd) != null)
            hd.treeify(tab);          // 再建红黑树，并把根节点挪到桶首（moveRootToFront）
    }
}
```

- **树节点如何排序**：先比 hash；hash 相等时若 key 实现了 `Comparable` 且类型相同则用 `compareTo`；还分不出就用 `tieBreakOrder`（类名 + `System.identityHashCode`）强行定序。所以 key 不实现 `Comparable` 也能树化，只是查找时可能要左右子树都搜。
- **为什么是 8**：源码注释给出了依据——在负载因子 0.75、hash 分布良好时，桶内节点数近似服从参数约 0.5 的泊松分布，一个桶达到 8 个节点的概率约为 0.00000006。正常情况下根本不会树化，树化是对**劣质 hashCode 或 Hash 碰撞攻击**的兜底。TreeNode 大小约为普通 Node 的两倍，所以不默认用树。
- **为什么退化阈值是 6 而非 8**：留出缓冲，避免在 7、8 之间反复插删导致链表/树来回转换。
- **退化发生在哪**：`UNTREEIFY_THRESHOLD` 只在 `resize` 时 `TreeNode.split` 中判断（拆分后某一侧 ≤ 6 则 `untreeify`）。`remove` 时的退化**不看 6**，而是看树形：根为空或根的左/右子、左孙为空（树已经很小）时才转回链表。

> [!NOTE] 树化对安全的意义
> JDK 7 曾通过 `jdk.map.althashing.threshold` 对 String key 使用替代 hash 来抵御碰撞攻击（大量 hashCode 相同的字符串让单个桶退化成长链表，请求解析时 CPU 打满）。JDK 8 删除了这个机制，改由树化把最坏情况从 O(n) 降到 O(log n)，`String` 实现了 `Comparable`，树化后查找效率有保证。

## resize：扩容与 lo/hi 链拆分

```java
// JDK 8 HashMap#resize（节选）
final Node<K,V>[] resize() {
    Node<K,V>[] oldTab = table;
    int oldCap = (oldTab == null) ? 0 : oldTab.length;
    int oldThr = threshold;
    int newCap, newThr = 0;
    if (oldCap > 0) {
        if (oldCap >= MAXIMUM_CAPACITY) { threshold = Integer.MAX_VALUE; return oldTab; }
        else if ((newCap = oldCap << 1) < MAXIMUM_CAPACITY && oldCap >= DEFAULT_INITIAL_CAPACITY)
            newThr = oldThr << 1;                 // 容量、阈值都翻倍
    }
    else if (oldThr > 0)                          // 带容量构造：threshold 里暂存的就是初始容量
        newCap = oldThr;
    else {                                        // 无参构造：16 / 12
        newCap = DEFAULT_INITIAL_CAPACITY;
        newThr = (int)(DEFAULT_LOAD_FACTOR * DEFAULT_INITIAL_CAPACITY);
    }
    if (newThr == 0) {
        float ft = (float)newCap * loadFactor;
        newThr = (newCap < MAXIMUM_CAPACITY && ft < (float)MAXIMUM_CAPACITY ? (int)ft : Integer.MAX_VALUE);
    }
    threshold = newThr;
    Node<K,V>[] newTab = (Node<K,V>[])new Node[newCap];
    table = newTab;                               // 注意：先发布空的新表，再迁移
    if (oldTab != null) {
        for (int j = 0; j < oldCap; ++j) {
            Node<K,V> e;
            if ((e = oldTab[j]) != null) {
                oldTab[j] = null;
                if (e.next == null)               // 单节点：直接重新定位
                    newTab[e.hash & (newCap - 1)] = e;
                else if (e instanceof TreeNode)   // 树：split，可能退化
                    ((TreeNode<K,V>)e).split(this, newTab, j, oldCap);
                else {                            // 链表：一次遍历拆成 lo / hi 两条
                    Node<K,V> loHead = null, loTail = null;
                    Node<K,V> hiHead = null, hiTail = null;
                    Node<K,V> next;
                    do {
                        next = e.next;
                        if ((e.hash & oldCap) == 0) {   // 新增的那一位是 0 → 留在 j
                            if (loTail == null) loHead = e; else loTail.next = e;
                            loTail = e;
                        } else {                        // 是 1 → 去 j + oldCap
                            if (hiTail == null) hiHead = e; else hiTail.next = e;
                            hiTail = e;
                        }
                    } while ((e = next) != null);
                    if (loTail != null) { loTail.next = null; newTab[j] = loHead; }
                    if (hiTail != null) { hiTail.next = null; newTab[j + oldCap] = hiHead; }
                }
            }
        }
    }
    return newTab;
}
```

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="HashMap 扩容时按 hash 与 oldCap 的结果把一条链拆为 lo 链和 hi 链">
<text class="ts" x="20" y="30">旧表 oldCap = 16，桶 j = 5（四个节点低 4 位都是 0101）</text>
<rect class="b" x="20" y="50" width="80" height="40" rx="6"/>
<text class="tm" x="60" y="70" text-anchor="middle" dominant-baseline="middle">tab[5]</text>
<line class="l" x1="100" y1="70" x2="140" y2="70" marker-end="url(#arr)"/>
<rect class="b2" x="140" y="50" width="100" height="40" rx="6"/>
<text class="tm" x="190" y="70" text-anchor="middle" dominant-baseline="middle">hash=5</text>
<line class="l" x1="240" y1="70" x2="260" y2="70" marker-end="url(#arr)"/>
<rect class="b3" x="260" y="50" width="100" height="40" rx="6"/>
<text class="tm" x="310" y="70" text-anchor="middle" dominant-baseline="middle">hash=21</text>
<line class="l" x1="360" y1="70" x2="380" y2="70" marker-end="url(#arr)"/>
<rect class="b2" x="380" y="50" width="100" height="40" rx="6"/>
<text class="tm" x="430" y="70" text-anchor="middle" dominant-baseline="middle">hash=37</text>
<line class="l" x1="480" y1="70" x2="500" y2="70" marker-end="url(#arr)"/>
<rect class="b3" x="500" y="50" width="100" height="40" rx="6"/>
<text class="tm" x="550" y="70" text-anchor="middle" dominant-baseline="middle">hash=53</text>
<text class="ts" x="190" y="106" text-anchor="middle">&amp; 16 = 0</text>
<text class="ts" x="310" y="106" text-anchor="middle">&amp; 16 = 16</text>
<text class="ts" x="430" y="106" text-anchor="middle">&amp; 16 = 0</text>
<text class="ts" x="550" y="106" text-anchor="middle">&amp; 16 = 16</text>
<text class="t" x="20" y="142">resize：遍历一次，按 (e.hash &amp; oldCap) 分到 lo / hi 两条链，保持原相对顺序</text>
<text class="ts" x="20" y="172">新表 newCap = 32</text>
<rect class="b" x="20" y="185" width="100" height="40" rx="6"/>
<text class="tm" x="70" y="205" text-anchor="middle" dominant-baseline="middle">newTab[5]</text>
<line class="l" x1="120" y1="205" x2="160" y2="205" marker-end="url(#arr)"/>
<rect class="b2" x="160" y="185" width="100" height="40" rx="6"/>
<text class="tm" x="210" y="205" text-anchor="middle" dominant-baseline="middle">hash=5</text>
<line class="l" x1="260" y1="205" x2="280" y2="205" marker-end="url(#arr)"/>
<rect class="b2" x="280" y="185" width="100" height="40" rx="6"/>
<text class="tm" x="330" y="205" text-anchor="middle" dominant-baseline="middle">hash=37</text>
<text class="ts" x="410" y="209">lo 链：下标不变，仍为 j = 5</text>
<rect class="b" x="20" y="245" width="100" height="40" rx="6"/>
<text class="tm" x="70" y="265" text-anchor="middle" dominant-baseline="middle">newTab[21]</text>
<line class="l" x1="120" y1="265" x2="160" y2="265" marker-end="url(#arr)"/>
<rect class="b3" x="160" y="245" width="100" height="40" rx="6"/>
<text class="tm" x="210" y="265" text-anchor="middle" dominant-baseline="middle">hash=21</text>
<line class="l" x1="260" y1="265" x2="280" y2="265" marker-end="url(#arr)"/>
<rect class="b3" x="280" y="245" width="100" height="40" rx="6"/>
<text class="tm" x="330" y="265" text-anchor="middle" dominant-baseline="middle">hash=53</text>
<text class="ts" x="410" y="269">hi 链：下标 = j + oldCap = 21</text>
</svg>
<figcaption>图 1：容量从 16 翻倍到 32，新下标只取决于 hash 的第 5 位（值 16）</figcaption>
</figure>

为什么只看一位？旧下标 = `hash & 0b01111`，新下标 = `hash & 0b11111`，两者只差第 5 位：该位为 0 则下标不变，为 1 则加 16。JDK 8 用 4 个指针**尾插**构造两条链，保持了原有顺序，这正是 JDK 7 死链问题在 JDK 8 消失的原因。

## JDK 7 头插法并发扩容死链

JDK 7 的迁移代码逐个把节点**头插**到新桶：

```java
// JDK 7 HashMap#transfer
void transfer(Entry[] newTable, boolean rehash) {
    int newCapacity = newTable.length;
    for (Entry<K,V> e : table) {
        while (null != e) {
            Entry<K,V> next = e.next;        // ★ 线程 T1 执行完这一行后被挂起
            if (rehash) e.hash = null == e.key ? 0 : hash(e.key);
            int i = indexFor(e.hash, newCapacity);
            e.next = newTable[i];            // 头插：e 指向新桶当前的头
            newTable[i] = e;
            e = next;
        }
    }
}
```

两个线程同时触发扩容，各自建了自己的 `newTable`，但**共享同一批 Entry 对象**。设旧桶为 `A → B → null`，且 A、B 在新表中仍落在同一个桶：

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="JDK 7 HashMap 并发扩容时头插导致 A 与 B 互相指向形成环">
<rect class="bg" x="10" y="10" width="240" height="230" rx="10"/>
<rect class="bg" x="260" y="10" width="240" height="230" rx="10"/>
<rect class="bg" x="510" y="10" width="240" height="230" rx="10"/>
<text class="tb" x="130" y="36" text-anchor="middle">① T1 读到 e=A, next=B 后挂起</text>
<rect class="b1" x="40" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="70" y="100" text-anchor="middle" dominant-baseline="middle">A</text>
<line class="l" x1="100" y1="100" x2="150" y2="100" marker-end="url(#arr)"/>
<rect class="b1" x="150" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="180" y="100" text-anchor="middle" dominant-baseline="middle">B</text>
<text class="ts" x="130" y="150" text-anchor="middle">旧桶：A.next = B，B.next = null</text>
<text class="ts" x="130" y="172" text-anchor="middle">T1 局部变量：e = A，next = B</text>
<text class="tb" x="380" y="36" text-anchor="middle">② T2 完成整个迁移</text>
<rect class="b2" x="290" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="320" y="100" text-anchor="middle" dominant-baseline="middle">B</text>
<line class="l" x1="350" y1="100" x2="400" y2="100" marker-end="url(#arr)"/>
<rect class="b2" x="400" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="430" y="100" text-anchor="middle" dominant-baseline="middle">A</text>
<text class="ts" x="380" y="150" text-anchor="middle">头插使顺序反转：B.next = A</text>
<text class="ts" x="380" y="172" text-anchor="middle">A.next = null</text>
<text class="tb" x="630" y="36" text-anchor="middle">③ T1 恢复，继续头插</text>
<rect class="b4" x="550" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="580" y="100" text-anchor="middle" dominant-baseline="middle">A</text>
<rect class="b4" x="660" y="80" width="60" height="40" rx="6"/>
<text class="tb" x="690" y="100" text-anchor="middle" dominant-baseline="middle">B</text>
<line class="la" x1="610" y1="91" x2="660" y2="91" marker-end="url(#arr-a)"/>
<line class="la" x1="660" y1="111" x2="610" y2="111" marker-end="url(#arr-a)"/>
<text class="ts" x="630" y="150" text-anchor="middle">放 A；e=B，B.next 已是 A</text>
<text class="ts" x="630" y="172" text-anchor="middle">放 B；e=A，再放 A：A.next = B</text>
<text class="ta" x="630" y="208" text-anchor="middle">A ⇄ B 成环，get 死循环</text>
</svg>
<figcaption>图 2：JDK 7 并发扩容死链的三个阶段</figcaption>
</figure>

逐步推演 T1 恢复后的执行（`newTable` 是 T1 自己的新表）：

| 轮次 | e | next = e.next | 操作后 |
| --- | --- | --- | --- |
| 1 | A | B（挂起前已读） | `A.next = null`，桶 = A |
| 2 | B | **A**（被 T2 改过） | `B.next = A`，桶 = B → A |
| 3 | A | null | `A.next = B`，桶 = A → B → A … **成环** |

之后任何落到这个桶且不存在的 key 的 `get`，或者再次扩容，都会在环上无限循环，表现为某几个线程 CPU 100%，jstack 中停在 `HashMap.get` / `HashMap.transfer`。

> [!WARNING] JDK 8 并不意味着 HashMap 能并发用
> 尾插消除了这一种成环，但并发下仍有：
> - **丢数据**：两个线程同时判断某桶为空，后写的覆盖先写的；链表尾部同时追加同理。
> - **size 不准**：`++size` 非原子。
> - **扩容期间读到 null**：`resize` 先把空的 `newTab` 赋给 `table` 再迁移，另一个线程此时 `get` 可能查不到已存在的 key。
> - **红黑树操作并发**：有线上案例报告 JDK 8 下多线程写 HashMap 时，线程卡在 `TreeNode.balanceInsertion` / `root()` 等方法中 CPU 打满。
> 结论：并发场景一律用 [ConcurrentHashMap](#/java/api/chm)。

## 容量预估

阈值是 `capacity × 0.75`，所以要放 N 个元素又不扩容，需要 `capacity ≥ N / 0.75`：

```java
// 预计放 1000 个元素
new HashMap<>(1000);                     // 容量 1024，阈值 768 → 插到第 769 个时扩容到 2048
new HashMap<>((int) (1000 / 0.75f) + 1); // 1334 → 容量 2048，阈值 1536，不会扩容
Maps.newHashMapWithExpectedSize(1000);   // Guava，同样的换算
HashMap.newHashMap(1000);                // JDK 19+ 官方 API，参数语义就是「预计元素数」
```

> [!TIP]
> - `new HashMap<>(n)` 的参数是**容量**不是元素数，这是最常见的误用。JDK 19 同时为 `HashSet`、`LinkedHashMap`、`LinkedHashSet`、`WeakHashMap` 添加了 `newXxx(int numElements)` 工厂。
> - `ConcurrentHashMap(int)` 的参数语义恰好相反，被当作预计元素数自动放大，见 [ConcurrentHashMap 源码剖析](#/java/api/chm)。
> - 容量设得过大也有代价：迭代 HashMap 要扫描整个桶数组，`new HashMap<>(1 << 20)` 后只放几个元素，`keySet()` 遍历依然要走 100 万个槽。

## 生产实践与踩坑

### key 可变导致「找不到」

```java
Map<List<String>, Integer> m = new HashMap<>();
List<String> k = new ArrayList<>(List.of("a"));
m.put(k, 1);
k.add("b");                       // hashCode 变了，但节点还躺在旧桶里
m.get(k);                         // null：按新 hash 去别的桶找
m.containsKey(List.of("a"));      // false：桶对了，但 equals 不再相等
m.size();                         // 1：内存泄漏——这个 entry 永远取不出、删不掉
```

- key 用不可变对象：`String`、包装类、`record`、枚举。
- 自定义 key 必须同时重写 `equals` 与 `hashCode`，且只依赖不可变字段；只重写 `equals` 会导致「相等的对象落在不同桶」。
- Lombok `@Data` 生成的 `hashCode` 包含所有字段，实体被 JPA 回填 id 后 hash 就变了，放进 `HashSet` 的实体会「丢失」。

### 其它常见问题

1. **迭代顺序依赖**：HashMap 的顺序取决于 hash 与容量，JDK 7 → 8 升级时迭代顺序变化曾导致大量单测失败、接口返回 JSON 字段顺序变化。需要顺序就用 `LinkedHashMap`。
2. **`computeIfAbsent` 的 mapping 函数里再修改同一个 map**：JDK 9+ 的 HashMap 会检测并抛 `ConcurrentModificationException`；JDK 8 下可能出现数据错乱。递归缓存（如斐波那契 memo）不要这么写。
3. **大 map 的内存估算**：每个 Node 约 32 字节（压缩指针下：对象头 12 + hash 4 + 3 个引用 12，对齐到 32），再加 key/value 对象本身与桶数组。百万级 `HashMap<Long, Long>` 轻松占用 80～100 MB，考虑 fastutil / Eclipse Collections 等原生类型 Map。
4. **hashCode 质量差导致退化**：例如用 `x * 31 + y` 组合的小整数坐标、以 `(int) longId` 截断等，导致大量碰撞，CPU 飙高时 profiler 中能看到 `HashMap.getNode`/`TreeNode.find` 占比异常。
5. **`HashMap` 当缓存无上限增长**：没有淘汰策略的静态 Map 是最常见的内存泄漏源头之一，用 Caffeine 或 `LinkedHashMap` LRU。
6. **null 值的歧义**：`get(k) == null` 可能是不存在，也可能是存的 null；需要区分时用 `containsKey` 或 `getOrDefault`。

## 相关阅读

- [复杂度与核心数据结构](#/cs/algo-ds)：哈希表、红黑树与负载因子的通用原理
- [工程中的算法：布隆、一致性哈希、限流与 Top K](#/cs/algo-engineering)：一致性哈希与布隆过滤器

## 面试追问

> [!QUESTION] 为什么 HashMap 的容量是 2 的幂？如果传入 17 会怎样？
> - `(n-1) & hash` 代替取模，扩容时用 `hash & oldCap` 一位判断去向。
> - 传 17 时 `tableSizeFor(17) = 32`，暂存在 `threshold` 中，首次 put 时 `resize` 才真正建 32 长度的表，阈值 24。

> [!QUESTION] 链表什么时候转红黑树？为什么不一开始就用树？
> - 追加后链表达到 9 个节点（插入前 ≥ 8）且表长 ≥ 64 才树化；表长 < 64 时调用 `resize()` 扩容代替树化。
> - TreeNode 约是 Node 的两倍大，且按泊松分布正常情况下桶长到 8 的概率约千万分之六，树化只是劣质 hash / 碰撞攻击的兜底。

> [!QUESTION] JDK 8 扩容为什么不需要重新计算 hash？迁移后顺序会变吗？
> Node 里缓存了 hash；容量翻倍后新下标要么是 j 要么是 j+oldCap，由 `hash & oldCap` 决定。用 lo/hi 头尾指针尾插，相对顺序保持不变；JDK 7 头插会反转顺序，这也是并发成环的根源。

> [!QUESTION] JDK 7 HashMap 死循环是怎么形成的？JDK 8 还有并发问题吗？
> - 两个线程同时 transfer，T1 读取 `next` 后挂起，T2 用头插把 A→B 反转成 B→A，T1 恢复后继续头插，最终 `A.next = B` 且 `B.next = A` 成环。
> - JDK 8 尾插不再成环，但仍会覆盖丢数据、size 不准、扩容中读到 null，不能当并发容器用。

> [!QUESTION] hash 方法为什么要 h ^ (h >>> 16)？
> 下标只用 hash 的低位（表长 16 只用 4 位），高位差异会被丢掉。把高 16 位异或进低 16 位，以极低成本让高位参与寻址，减少碰撞；JDK 8 因为有树化兜底，把 JDK 7 的多次扰动简化为一次。

> [!QUESTION] 想要放 1000 个元素，初始容量应该设多少？
> 1000 / 0.75 + 1 ≈ 1334，向上取整为 2048。直接写 1000 会得到 1024 容量、768 阈值，插入过程中仍会扩容一次。JDK 19+ 用 `HashMap.newHashMap(1000)`。
