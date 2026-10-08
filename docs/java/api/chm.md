---
level: 深入
tags: [ConcurrentHashMap, CAS, synchronized, 扩容, LongAdder, 源码]
summary: 对比 JDK 7 分段锁与 JDK 8 CAS + synchronized 实现，拆解 sizeCtl、putVal、多线程协助扩容、CounterCell 计数与 get 无锁读
---

# ConcurrentHashMap 源码剖析

> [!ABSTRACT] 核心要点
> - JDK 7：`Segment[]`（继承 `ReentrantLock`）+ `HashEntry[]`，锁粒度是段，并发度在构造时固定（默认 16）。JDK 8：与 HashMap 同构的 `Node[]` + 链表/红黑树，**空桶 CAS、非空桶 `synchronized` 锁头节点**，锁粒度是单个桶。
> - `sizeCtl` 是控制中枢：0 = 未指定；正数 = 初始容量或下次扩容阈值；-1 = 正在初始化；其它负数 = 正在扩容（高 16 位为扩容戳，低 16 位为「参与线程数 + 1」）。
> - 扩容由多个线程协作：每个线程从 `transferIndex` 自高向低认领 `stride`（至少 16）个桶，迁完的桶放 `ForwardingNode`（hash = -1），读请求经它转发到新表，写请求遇到它就 `helpTransfer` 一起搬。
> - 计数采用 LongAdder 思想：无竞争时 CAS `baseCount`，竞争时分散到 `CounterCell[]`；`size()` 是求和得到的**估计值**。
> - `get` 全程不加锁：`table` 引用与 `Node.val/next` 都是 volatile，桶元素用 `Unsafe.getObjectVolatile`（`tabAt`）读取；JDK 8 的 `computeIfAbsent` 递归修改同桶会**死循环**，JDK 9 起抛 `IllegalStateException: Recursive update`。

## JDK 7 与 JDK 8 结构对比

<figure class="fig">
<svg viewBox="0 0 760 300" class="dg" role="img" aria-label="JDK 7 ConcurrentHashMap 分段锁结构与 JDK 8 桶级锁结构对比">
<rect class="bg" x="10" y="10" width="360" height="280" rx="12"/>
<rect class="bg" x="390" y="10" width="360" height="280" rx="12"/>
<text class="th" x="190" y="34" text-anchor="middle">JDK 7：Segment 分段锁</text>
<rect class="b3" x="30" y="50" width="110" height="36" rx="6"/>
<text class="tm" x="85" y="68" text-anchor="middle" dominant-baseline="middle">Segment 0</text>
<rect class="b3" x="30" y="100" width="110" height="36" rx="6"/>
<text class="tm" x="85" y="118" text-anchor="middle" dominant-baseline="middle">Segment 1</text>
<rect class="b3" x="30" y="150" width="110" height="36" rx="6"/>
<text class="tm" x="85" y="168" text-anchor="middle" dominant-baseline="middle">…</text>
<rect class="b3" x="30" y="200" width="110" height="36" rx="6"/>
<text class="tm" x="85" y="218" text-anchor="middle" dominant-baseline="middle">Segment 15</text>
<line class="l" x1="140" y1="68" x2="170" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="140" y1="118" x2="170" y2="118" marker-end="url(#arr)"/>
<line class="l" x1="140" y1="218" x2="170" y2="218" marker-end="url(#arr)"/>
<rect class="b" x="170" y="50" width="110" height="36" rx="6"/>
<text class="tm" x="225" y="68" text-anchor="middle" dominant-baseline="middle">HashEntry[]</text>
<rect class="b" x="170" y="100" width="110" height="36" rx="6"/>
<text class="tm" x="225" y="118" text-anchor="middle" dominant-baseline="middle">HashEntry[]</text>
<rect class="b" x="170" y="200" width="110" height="36" rx="6"/>
<text class="tm" x="225" y="218" text-anchor="middle" dominant-baseline="middle">HashEntry[]</text>
<line class="l" x1="280" y1="68" x2="300" y2="68" marker-end="url(#arr)"/>
<line class="l" x1="280" y1="118" x2="300" y2="118" marker-end="url(#arr)"/>
<rect class="b" x="300" y="50" width="50" height="36" rx="6"/>
<text class="tm" x="325" y="68" text-anchor="middle" dominant-baseline="middle">e→e</text>
<rect class="b" x="300" y="100" width="50" height="36" rx="6"/>
<text class="tm" x="325" y="118" text-anchor="middle" dominant-baseline="middle">e</text>
<text class="ts" x="30" y="262">每个 Segment 是一把 ReentrantLock，put 锁整段</text>
<text class="ts" x="30" y="280">段数构造时固定，之后只扩容段内的 HashEntry[]</text>
<text class="th" x="570" y="34" text-anchor="middle">JDK 8+：CAS + synchronized</text>
<rect class="b" x="410" y="50" width="90" height="36" rx="6"/>
<text class="tm" x="455" y="68" text-anchor="middle" dominant-baseline="middle">tab[0]</text>
<rect class="b" x="410" y="100" width="90" height="36" rx="6"/>
<text class="tm" x="455" y="118" text-anchor="middle" dominant-baseline="middle">tab[1]</text>
<rect class="b" x="410" y="150" width="90" height="36" rx="6"/>
<text class="tm" x="455" y="168" text-anchor="middle" dominant-baseline="middle">tab[2]</text>
<rect class="b" x="410" y="200" width="90" height="36" rx="6"/>
<text class="tm" x="455" y="218" text-anchor="middle" dominant-baseline="middle">tab[3]</text>
<line class="l" x1="500" y1="68" x2="520" y2="68" marker-end="url(#arr)"/>
<text class="ts" x="526" y="72">null：casTabAt 无锁插入</text>
<line class="l" x1="500" y1="118" x2="520" y2="118" marker-end="url(#arr)"/>
<rect class="b4" x="520" y="100" width="90" height="36" rx="6"/>
<text class="tm" x="565" y="118" text-anchor="middle" dominant-baseline="middle">f（加锁）</text>
<line class="l" x1="610" y1="118" x2="630" y2="118" marker-end="url(#arr)"/>
<rect class="b" x="630" y="100" width="60" height="36" rx="6"/>
<text class="tm" x="660" y="118" text-anchor="middle" dominant-baseline="middle">Node</text>
<line class="l" x1="500" y1="168" x2="520" y2="168" marker-end="url(#arr)"/>
<rect class="b5" x="520" y="150" width="210" height="36" rx="6"/>
<text class="tm" x="625" y="168" text-anchor="middle" dominant-baseline="middle">ForwardingNode hash=-1</text>
<line class="l" x1="500" y1="218" x2="520" y2="218" marker-end="url(#arr)"/>
<rect class="b2" x="520" y="200" width="210" height="36" rx="6"/>
<text class="tm" x="625" y="218" text-anchor="middle" dominant-baseline="middle">TreeBin hash=-2</text>
<text class="ts" x="410" y="262">锁粒度 = 单个桶头节点；get 全程无锁（volatile 读）</text>
<text class="ts" x="410" y="280">计数：baseCount + CounterCell[] 分散累加</text>
</svg>
<figcaption>图 1：JDK 7 锁住整个 Segment，JDK 8 只锁冲突桶的头节点</figcaption>
</figure>

| 维度 | JDK 7 | JDK 8+ |
| --- | --- | --- |
| 结构 | `Segment[]` → `HashEntry[]` → 链表 | `Node[]` → 链表 / `TreeBin` 红黑树 |
| 锁 | `Segment extends ReentrantLock`，`tryLock` 自旋若干次后阻塞 | 空桶 CAS；非空桶 `synchronized(头节点)` |
| 并发度 | `concurrencyLevel`（默认 16）决定段数，之后不可变 | 理论上等于桶数，随扩容增长 |
| 扩容 | 段内各自扩容，单线程 | 全表扩容，多线程协作迁移 |
| size | 先不加锁累加两次，各段 `modCount` 之和不变则返回；否则锁住所有段再算 | `baseCount + Σ CounterCell`，不加锁 |
| 哈希冲突退化 | 链表 O(n) | 红黑树 O(log n) |

JDK 8 选择 `synchronized` 而不是 `ReentrantLock`：每个桶一把锁时，`ReentrantLock` 意味着每个桶多一个 AQS 对象；而头节点本身就是对象，`synchronized` 零额外内存，且在竞争不激烈时有轻量级锁优化（JDK 15 起偏向锁被默认禁用并逐步移除，但不影响这里的结论）。锁的原理见 [synchronized 与锁升级](#/java/concurrency/sync)。

## 关键字段与 sizeCtl

```java
// JDK 8 ConcurrentHashMap（节选）
transient volatile Node<K,V>[] table;
private transient volatile Node<K,V>[] nextTable;   // 仅扩容期间非空
private transient volatile long baseCount;
private transient volatile int sizeCtl;
private transient volatile int transferIndex;      // 下一个待认领区间的上界（不含）
private transient volatile int cellsBusy;          // CounterCell 数组的自旋锁
private transient volatile CounterCell[] counterCells;

static final int MOVED     = -1;   // ForwardingNode 的 hash
static final int TREEBIN   = -2;   // TreeBin 的 hash
static final int RESERVED  = -3;   // ReservationNode（compute 系列占位）
static final int HASH_BITS = 0x7fffffff;

static final int spread(int h) {
    return (h ^ (h >>> 16)) & HASH_BITS;   // 扰动 + 抹掉符号位：负 hash 留给特殊节点
}

static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;
    final K key;
    volatile V val;                 // volatile：保证 get 无锁可见
    volatile Node<K,V> next;
}
```

| sizeCtl 取值 | 阶段 | 含义 |
| --- | --- | --- |
| `0` | 未初始化 | 无参构造，建表时使用默认容量 16 |
| `> 0`（建表前） | 未初始化 | 构造时计算出的初始容量 |
| `-1` | 初始化中 | 某线程 CAS 抢到了建表权，其它线程 `Thread.yield()` 自旋 |
| `< -1` | 扩容中 | 高 16 位 = `resizeStamp(n)`（标识「从长度 n 开始的这次扩容」），低 16 位 = 参与扩容线程数 + 1 |
| `> 0`（建表后） | 正常 | 下次扩容阈值，固定为 `n - (n >>> 2)` 即 0.75n，**不使用 loadFactor 字段** |

> [!NOTE] 源码注释与实现的出入
> JDK 8 的 javadoc 写「-(1 + 活跃扩容线程数)」，但实际编码是 `(resizeStamp(n) << RESIZE_STAMP_SHIFT) + 2`（第一个扩容线程）、每加入一个线程 +1。另外 JDK 8 的 `addCount/helpTransfer` 里判断「扩容是否已结束 / 线程数是否达上限」的条件写成了 `sc == rs + 1 || sc == rs + MAX_RESIZERS`，少了左移，属于已知 bug（JDK-8214427），JDK 12 修复，实际影响很小。

> [!WARNING] 构造参数语义与 HashMap 不同
> `new ConcurrentHashMap<>(32)` 的实际容量是 **64**：JDK 8 中计算 `tableSizeFor(32 + 32/2 + 1) = tableSizeFor(49)`，即把参数当作「预计元素数」自动放大。而 `new HashMap<>(32)` 是 32。三参构造 `(initialCapacity, loadFactor, concurrencyLevel)` 里的 `loadFactor` 只用于计算初始容量，之后阈值恒为 0.75n；`concurrencyLevel` 仅为兼容保留。

## initTable：CAS 抢建表权

```java
// JDK 8 ConcurrentHashMap#initTable
private final Node<K,V>[] initTable() {
    Node<K,V>[] tab; int sc;
    while ((tab = table) == null || tab.length == 0) {
        if ((sc = sizeCtl) < 0)
            Thread.yield();                              // 别人在建表，让出 CPU 等待
        else if (U.compareAndSwapInt(this, SIZECTL, sc, -1)) {   // 抢到建表权
            try {
                if ((tab = table) == null || tab.length == 0) {      // 双重检查
                    int n = (sc > 0) ? sc : DEFAULT_CAPACITY;
                    Node<K,V>[] nt = (Node<K,V>[])new Node<?,?>[n];
                    table = tab = nt;
                    sc = n - (n >>> 2);                  // 阈值 0.75n
                }
            } finally {
                sizeCtl = sc;                            // 释放「锁」，同时写入阈值
            }
            break;
        }
    }
    return tab;
}
```

## putVal：CAS 与 synchronized 的分工

```java
// JDK 8 ConcurrentHashMap#putVal（节选 + 注释）
final V putVal(K key, V value, boolean onlyIfAbsent) {
    if (key == null || value == null) throw new NullPointerException();
    int hash = spread(key.hashCode());
    int binCount = 0;
    for (Node<K,V>[] tab = table;;) {                   // 自旋直到成功
        Node<K,V> f; int n, i, fh;
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();                          // ① 懒初始化
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value, null)))
                break;                                  // ② 空桶：CAS 放入，失败则重试
        }
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);                 // ③ 正在扩容：先帮忙迁移
        else {
            V oldVal = null;
            synchronized (f) {                          // ④ 锁桶头节点
                if (tabAt(tab, i) == f) {               // 加锁后再确认头节点没变
                    if (fh >= 0) {                      // 普通链表
                        binCount = 1;
                        for (Node<K,V> e = f;; ++binCount) {
                            K ek;
                            if (e.hash == hash &&
                                ((ek = e.key) == key || (ek != null && key.equals(ek)))) {
                                oldVal = e.val;
                                if (!onlyIfAbsent) e.val = value;
                                break;
                            }
                            Node<K,V> pred = e;
                            if ((e = e.next) == null) {
                                pred.next = new Node<K,V>(hash, key, value, null);  // 尾插
                                break;
                            }
                        }
                    }
                    else if (f instanceof TreeBin) {    // 红黑树
                        binCount = 2;
                        Node<K,V> p = ((TreeBin<K,V>)f).putTreeVal(hash, key, value);
                        if (p != null) { oldVal = p.val; if (!onlyIfAbsent) p.val = value; }
                    }
                }
            }
            if (binCount != 0) {
                if (binCount >= TREEIFY_THRESHOLD)
                    treeifyBin(tab, i);                 // 同样要求表长 >= 64，否则扩容
                if (oldVal != null)
                    return oldVal;
                break;
            }
        }
    }
    addCount(1L, binCount);                             // ⑤ 计数 + 检查是否需要扩容
    return null;
}

static final <K,V> Node<K,V> tabAt(Node<K,V>[] tab, int i) {
    return (Node<K,V>)U.getObjectVolatile(tab, ((long)i << ASHIFT) + ABASE);
}
static final <K,V> boolean casTabAt(Node<K,V>[] tab, int i, Node<K,V> c, Node<K,V> v) {
    return U.compareAndSwapObject(tab, ((long)i << ASHIFT) + ABASE, c, v);
}
```

- 加锁后必须**再次检查 `tabAt(tab, i) == f`**：等锁期间头节点可能已被扩容替换成 ForwardingNode，或被树化替换成 TreeBin，此时 binCount 仍为 0，循环重来。
- 树桶的头是 `TreeBin` 包装节点而不是根节点，因为红黑树旋转会改变根；锁一个固定不变的 TreeBin 对象才稳定。TreeBin 内部还有一个简易读写锁（`lockState`）：写线程调整树结构时，读线程不会阻塞，而是沿着 `next` 指针**线性遍历**。
- **为什么不允许 null**：并发下 `get(k)` 返回 null 无法区分「不存在」与「值为 null」，而 HashMap 可以用 `containsKey` 二次确认，并发容器两次调用之间状态可能已变。Doug Lea 也认为 null 在并发容器里只会制造歧义。

## 多线程协助扩容：transfer

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="ConcurrentHashMap 多线程按 stride 从高到低认领桶区间迁移，已迁移桶放置 ForwardingNode">
<text class="ts" x="40" y="28">oldTab（n = 64），stride = max((n &gt;&gt;&gt; 3) / NCPU, 16) = 16，从高下标向低下标认领</text>
<rect class="b" x="40" y="45" width="156" height="50" rx="6"/>
<text class="tm" x="118" y="63" text-anchor="middle" dominant-baseline="middle">[0, 15]</text>
<text class="ts" x="118" y="83" text-anchor="middle">待认领</text>
<rect class="b1" x="200" y="45" width="156" height="50" rx="6"/>
<text class="tm" x="278" y="63" text-anchor="middle" dominant-baseline="middle">[16, 31]</text>
<text class="ts" x="278" y="83" text-anchor="middle">T3 迁移中</text>
<rect class="b1" x="360" y="45" width="156" height="50" rx="6"/>
<text class="tm" x="438" y="63" text-anchor="middle" dominant-baseline="middle">[32, 47]</text>
<text class="ts" x="438" y="83" text-anchor="middle">T2 迁移中</text>
<rect class="b5" x="520" y="45" width="156" height="50" rx="6"/>
<text class="tm" x="598" y="63" text-anchor="middle" dominant-baseline="middle">[48, 63]</text>
<text class="ts" x="598" y="83" text-anchor="middle">T1 已完成：全是 fwd</text>
<line class="la" x1="200" y1="130" x2="200" y2="99" marker-end="url(#arr-a)"/>
<text class="ta" x="200" y="146" text-anchor="middle">transferIndex = 16（下一个线程 CAS 为 0，认领 [0, 15]）</text>
<text class="ts" x="40" y="172">单个桶 i 的迁移（持有 synchronized(f)）：</text>
<rect class="b" x="40" y="180" width="150" height="40" rx="6"/>
<text class="tm" x="115" y="200" text-anchor="middle" dominant-baseline="middle">oldTab[i] 链表 f</text>
<line class="l" x1="190" y1="196" x2="560" y2="196" marker-end="url(#arr)"/>
<text class="ts" x="375" y="188" text-anchor="middle">hash &amp; n == 0 → ln 链</text>
<line class="l" x1="190" y1="206" x2="560" y2="240" marker-end="url(#arr)"/>
<text class="ts" x="470" y="244" text-anchor="middle">≠ 0 → hn 链</text>
<rect class="b2" x="560" y="178" width="170" height="36" rx="6"/>
<text class="tm" x="645" y="196" text-anchor="middle" dominant-baseline="middle">nextTab[i] = ln</text>
<rect class="b3" x="560" y="226" width="170" height="36" rx="6"/>
<text class="tm" x="645" y="244" text-anchor="middle" dominant-baseline="middle">nextTab[i+n] = hn</text>
<rect class="b5" x="40" y="236" width="150" height="40" rx="6"/>
<text class="tm" x="115" y="256" text-anchor="middle" dominant-baseline="middle">oldTab[i] = fwd</text>
<text class="ts" x="200" y="272">读：fwd.find() 转到 nextTable；写：helpTransfer</text>
</svg>
<figcaption>图 2：transfer 按 stride 分片并行迁移，每迁完一个桶就用 ForwardingNode 占位</figcaption>
</figure>

```java
// JDK 8 ConcurrentHashMap#transfer（大幅精简）
private final void transfer(Node<K,V>[] tab, Node<K,V>[] nextTab) {
    int n = tab.length, stride;
    if ((stride = (NCPU > 1) ? (n >>> 3) / NCPU : n) < MIN_TRANSFER_STRIDE)
        stride = MIN_TRANSFER_STRIDE;                    // 每个线程一次至少认领 16 个桶
    if (nextTab == null) {                               // 第一个扩容线程负责建新表
        nextTab = (Node<K,V>[])new Node<?,?>[n << 1];
        nextTable = nextTab;
        transferIndex = n;                               // 从末尾开始分配
    }
    int nextn = nextTab.length;
    ForwardingNode<K,V> fwd = new ForwardingNode<K,V>(nextTab);
    boolean advance = true, finishing = false;
    for (int i = 0, bound = 0;;) {
        Node<K,V> f; int fh;
        while (advance) {                                // 认领 / 推进下标
            int nextIndex, nextBound;
            if (--i >= bound || finishing) advance = false;
            else if ((nextIndex = transferIndex) <= 0) { i = -1; advance = false; }
            else if (U.compareAndSwapInt(this, TRANSFERINDEX, nextIndex,
                     nextBound = (nextIndex > stride ? nextIndex - stride : 0))) {
                bound = nextBound; i = nextIndex - 1; advance = false;   // 认领 [bound, nextIndex-1]
            }
        }
        if (i < 0 || i >= n || i + n >= nextn) {         // 没有可认领的区间了
            if (finishing) {                             // 最后一个线程：发布新表
                nextTable = null;
                table = nextTab;
                sizeCtl = (n << 1) - (n >>> 1);          // 新阈值 = 0.75 * 2n
                return;
            }
            int sc;
            if (U.compareAndSwapInt(this, SIZECTL, sc = sizeCtl, sc - 1)) {   // 参与线程数 -1
                if ((sc - 2) != resizeStamp(n) << RESIZE_STAMP_SHIFT)
                    return;                              // 不是最后一个，直接退出
                finishing = advance = true;
                i = n;                                   // 最后一个线程再全表检查一遍
            }
        }
        else if ((f = tabAt(tab, i)) == null)
            advance = casTabAt(tab, i, null, fwd);       // 空桶：直接放 fwd
        else if ((fh = f.hash) == MOVED)
            advance = true;                              // 已处理过
        else {
            synchronized (f) {
                // 链表：先找 lastRun（尾部连续同侧的一段，可整体复用），
                // 之前的节点 new 出副本头插到 ln / hn；树：拆成两棵 TreeBin，必要时 untreeify
                setTabAt(nextTab, i, ln);
                setTabAt(nextTab, i + n, hn);
                setTabAt(tab, i, fwd);                   // 旧桶标记为已迁移
                advance = true;
            }
        }
    }
}
```

要点：

- **为什么复制节点而不是像 HashMap 那样改 next 指针**：迁移时可能有读线程正在旧桶上遍历，如果修改原节点的 `next`，读线程会走丢。复制（只复用 `lastRun` 之后的尾段，那段节点的 next 不需要改）保证旧链表在迁移期间保持完整可读。代价是部分节点顺序反转、产生少量垃圾。
- **ForwardingNode**：hash 为 `MOVED`，持有 `nextTable`。`get` 碰到它时调用 `find` 去新表查；`put/remove/compute` 碰到它就调用 `helpTransfer` 加入扩容（sizeCtl 低位 +1），把「等待」变成「干活」。
- **触发扩容的地方**：`addCount` 发现 `size >= sizeCtl`；`treeifyBin` 发现表长 < 64；`putAll` 前的 `tryPresize`。
- 扩容是**全表**的：表很大时一次扩容需要迁移数百万节点，多核下由多个写线程分担，但写入延迟仍会出现毛刺，所以和 HashMap 一样应该**预估容量**。

## addCount 与 CounterCell

```java
// JDK 8 ConcurrentHashMap#addCount（节选）
private final void addCount(long x, int check) {
    CounterCell[] as; long b, s;
    if ((as = counterCells) != null ||
        !U.compareAndSwapLong(this, BASECOUNT, b = baseCount, s = b + x)) {
        // 已经有 cells，或 CAS baseCount 失败（出现竞争）→ 走分散计数
        CounterCell a; long v; int m;
        boolean uncontended = true;
        if (as == null || (m = as.length - 1) < 0 ||
            (a = as[ThreadLocalRandom.getProbe() & m]) == null ||          // 按线程探针选槽
            !(uncontended = U.compareAndSwapLong(a, CELLVALUE, v = a.value, v + x))) {
            fullAddCount(x, uncontended);   // 初始化 / 扩容 cells、rehash 探针，逻辑同 LongAdder
            return;
        }
        if (check <= 1) return;
        s = sumCount();
    }
    if (check >= 0) {
        // while (s >= sizeCtl && table != null && n < MAXIMUM_CAPACITY)：
        //   sizeCtl < 0 → CAS 低位 +1 加入扩容；否则 CAS 为 (rs << 16) + 2 发起扩容
    }
}

@sun.misc.Contended static final class CounterCell {   // 缓存行填充，避免伪共享
    volatile long value;
}

final long sumCount() {
    CounterCell[] as = counterCells; long sum = baseCount;
    if (as != null)
        for (CounterCell a : as) if (a != null) sum += a.value;
    return sum;
}
public int size() {
    long n = sumCount();
    return (n < 0L) ? 0 : (n > (long)Integer.MAX_VALUE) ? Integer.MAX_VALUE : (int)n;
}
public long mappingCount() {               // JDK 8 新增，推荐使用
    long n = sumCount();
    return (n < 0L) ? 0L : n;
}
```

- 思想与 [LongAdder](#/java/concurrency/juc) 一致：热点从一个变量分散到多个 cell，写不冲突，读时求和。cells 数组上限约为 CPU 核数（向上取 2 的幂）。
- `size()` 与 `mappingCount()` 都是**弱一致的估计值**：求和时其它线程可能正在修改，结果不对应任何一个时刻的快照。用它做精确业务判断（如「满 1000 就拒绝」）是错的，需要额外的原子计数或锁。
- `isEmpty()` 同理只是 `sumCount() <= 0`。

## get 为何无需加锁

```java
// JDK 8 ConcurrentHashMap#get
public V get(Object key) {
    Node<K,V>[] tab; Node<K,V> e, p; int n, eh; K ek;
    int h = spread(key.hashCode());
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (e = tabAt(tab, (n - 1) & h)) != null) {             // volatile 读桶头
        if ((eh = e.hash) == h) {
            if ((ek = e.key) == key || (ek != null && key.equals(ek)))
                return e.val;                                // volatile 读 val
        }
        else if (eh < 0)                                     // fwd / TreeBin / Reservation
            return (p = e.find(h, key)) != null ? p.val : null;
        while ((e = e.next) != null) {                       // volatile 读 next
            if (e.hash == h &&
                ((ek = e.key) == key || (ek != null && key.equals(ek))))
                return e.val;
        }
    }
    return null;
}
```

1. `volatile Node[] table` 只保证**数组引用**可见，数组元素不是 volatile；所以读桶要用 `Unsafe.getObjectVolatile`（`tabAt`），写桶用 CAS 或 `putObjectVolatile`（`setTabAt`），形成 happens-before。
2. `Node.val`、`Node.next` 是 volatile，新节点在构造完成后才通过 volatile 写挂到链上，读线程不会看到「半初始化」的节点。
3. 特殊节点通过多态 `find` 处理：扩容中转发新表；树桶在有写锁时退化为链表遍历。

代价是读的**弱一致性**：get 返回的是「最近完成」的写入结果，不会阻塞等待正在进行的写。迭代器、`size`、`containsValue` 同样是弱一致的，不抛 CME。内存可见性原理见 [Java 内存模型与 volatile](#/java/concurrency/jmm)。

## compute 系列与 JDK 8 递归 bug

`computeIfAbsent/compute/merge` 在空桶时会先 CAS 放入一个 `ReservationNode`（hash = `RESERVED`）并锁住它，再执行 mapping 函数，保证函数**对同一个 key 只执行一次**。

```java
Map<String, Integer> map = new ConcurrentHashMap<>(16);
map.computeIfAbsent("AaAa", k -> map.computeIfAbsent("BBBB", k2 -> 42));
// "AaAa" 与 "BBBB" 的 hashCode 相同 → 同一个桶
// JDK 8：外层在该桶放了 ReservationNode 并持锁执行函数；内层看到 RESERVED 节点，
//        既不能 CAS 空桶，也不满足链表/树的分支，在 for(;;) 中无限自旋 → 线程卡死、CPU 100%
// JDK 9+：检测到 ReservationNode 时直接 throw new IllegalStateException("Recursive update")
```

> [!CAUTION] compute 系列的使用守则
> - mapping 函数里**不要修改同一个 Map**（无论 JDK 版本，HashMap 也一样会出错）。递归缓存请改用显式的「先 get，miss 再计算再 putIfAbsent」。
> - 函数执行期间持有桶锁，**不要在里面做 RPC、IO、长计算**，否则同桶（乃至扩容时整个表）的写入都会被阻塞。
> - JDK 8 的 `computeIfAbsent` 即使 key 已存在也会先对桶加锁（JDK-8161372），热点 key 下性能很差；JDK 9 起会先检查头节点。JDK 8 上的常见优化写法：`V v = map.get(k); if (v == null) v = map.computeIfAbsent(k, f);`。

## 对比与选型

| 方案 | 锁粒度 | 读是否加锁 | null | 迭代 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| `Hashtable` | 整个对象（方法 `synchronized`） | 是 | 不允许 | fail-fast 迭代器 / Enumeration | 遗留代码，不要新用 |
| `Collections.synchronizedMap` | 包装对象上的 mutex | 是 | 取决于底层 Map | 迭代时**必须手动** `synchronized(map)` | 低并发、需要包装任意 Map（如 LinkedHashMap LRU） |
| `ConcurrentHashMap` | 单桶 | 否 | 不允许 | 弱一致，不抛 CME | 绝大多数并发 Map 场景 |
| `ConcurrentSkipListMap` | 无锁（CAS） | 否 | 不允许 | 弱一致，有序 | 需要并发 + 有序 / 范围查询 |

## 生产实践与踩坑

1. **check-then-act 不是原子的**：`if (!map.containsKey(k)) map.put(k, v);` 在并发下会重复写。用 `putIfAbsent / computeIfAbsent / merge`；计数用 `map.merge(k, 1L, Long::sum)` 或 `ConcurrentHashMap<K, LongAdder>` + `computeIfAbsent(k, x -> new LongAdder()).increment()`。
2. **复合操作仍需外部同步**：「读两个 key 再写第三个」这类跨 key 的不变式，CHM 无法保证，需要锁或改数据结构。
3. **value 是可变对象**：CHM 只保证 Map 结构的线程安全，`map.get(k).add(x)`（value 是 `ArrayList`）依然不安全。value 用并发容器或不可变对象。
4. **线上 CPU 100% 且 jstack 停在 `ConcurrentHashMap.computeIfAbsent`**：检查是否在 mapping 函数里递归访问同一 Map（JDK 8 死循环）。
5. **`size()` 用于限流或容量判断**：只是估计值，高并发下可能超限。
6. **大表扩容毛刺**：预估容量；CHM 构造参数本身就是预计元素数，不需要再除以 0.75。
7. **把 CHM 当作本地缓存**：没有过期与淘汰，长期运行必然膨胀。用 Caffeine（其底层正是 CHM）。

## 面试追问

> [!QUESTION] JDK 8 的 ConcurrentHashMap 为什么放弃分段锁？为什么用 synchronized 而不是 ReentrantLock？
> - 分段锁并发度固定、段内仍是大锁，且 size 等全局操作需要锁所有段；JDK 8 锁粒度细化到桶，并发度随扩容增长。
> - 头节点本身就是对象，`synchronized` 无额外内存开销；桶级锁冲突概率低，JVM 对低竞争 synchronized 优化充分。

> [!QUESTION] 说说 sizeCtl 各个取值的含义。
> 0：未初始化，用默认容量；正数：建表前是初始容量，建表后是下次扩容阈值（0.75n）；-1：有线程在初始化；其它负数：扩容中，高 16 位是 `resizeStamp(n)`，低 16 位是参与扩容线程数 + 1。

> [!QUESTION] 多线程如何协作扩容？读写请求在扩容期间怎么办？
> - 第一个线程创建 2 倍的 nextTable，`transferIndex = n`；各线程 CAS 递减 transferIndex 认领 stride（≥16）个桶，从高到低迁移，迁完放 ForwardingNode；最后退出的线程再全表复查并发布新表。
> - 读遇到 fwd 调 `find` 去新表查；写遇到 fwd 调 `helpTransfer` 加入迁移；未迁移的桶照常读写（写要拿桶锁，与迁移互斥）。

> [!QUESTION] get 为什么不用加锁？能保证读到最新值吗？
> 桶用 `getObjectVolatile` 读、CAS / volatile 写；`val`、`next` 是 volatile，节点构造完成后才发布。能读到「已完成」的写，但不会等待正在进行中的写，是弱一致的。

> [!QUESTION] ConcurrentHashMap 的 size 准确吗？是怎么计数的？
> baseCount + CounterCell 数组，无竞争 CAS baseCount，有竞争按线程探针分散到不同 cell，cell 用 `@Contended` 避免伪共享；size 是不加锁的求和，并发修改时只是估计值。超过 int 范围用 `mappingCount()`。

> [!QUESTION] 为什么 ConcurrentHashMap 不允许 null key / value？
> 并发场景下 `get` 返回 null 无法区分「不存在」与「值为 null」，又不能像 HashMap 那样用 containsKey 安全地二次确认（两次调用之间可能被修改）；同时 null 也被内部用作「空桶」标记。
