---
level: 进阶
tags: [算法, 数据结构, 复杂度, 数组, 链表, 哈希表, 堆, 二叉树, 红黑树, B+树, 跳表, LRU]
summary: 面向后端面试与工程的数据结构基础：时间/空间复杂度与均摊分析，数组、链表、栈与队列、哈希表（冲突与扩容）、堆与优先队列、二叉搜索树/AVL/红黑树/B+ 树/跳表的对比，并发容器与典型实现（LRU、最小栈），每种结构对应 Java 集合、MySQL 与 Redis 的使用位置。
---

# 复杂度与核心数据结构

> [!ABSTRACT] 核心要点
> - 复杂度描述**随数据规模 n 增长的趋势**，忽略常数与低阶项：O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ)。工程里还要看**常数、缓存局部性和 IO 次数**——B+ 树比二叉树“理论上更差”的层数，却因为一次读一个页而胜出。
> - 选数据结构就是选**操作的代价分布**：数组随机访问 O(1) 但中间插入 O(n)；链表插入 O(1)（已定位）但访问 O(n)；哈希表均摊 O(1)；有序结构（红黑树/跳表/B+ 树）O(log n) 且支持范围查询。
> - **哈希表**的核心：好的哈希函数 + 冲突处理 + 负载因子触发扩容；`HashMap` 链表转红黑树防哈希攻击（见 [HashMap](#/java/api/hashmap)）。
> - **堆**解决“反复取最大/最小”：Top K、定时器、合并 K 路、调度；**二叉搜索树家族**解决“有序 + 动态增删 + 范围”。
> - 每个结构都对应一个熟悉的工程位置：ArrayList、LinkedList、HashMap、PriorityQueue、TreeMap、InnoDB 的 B+ 树、Redis 的跳表与压缩列表。

## 一、复杂度分析

### 1. 大 O 与常见量级

| 复杂度 | 名称 | n = 10⁶ 时约操作数 | 例 |
| --- | --- | --- | --- |
| O(1) | 常数 | 1 | 哈希查找、数组下标 |
| O(log n) | 对数 | 20 | 二分查找、平衡树、堆插入 |
| O(n) | 线性 | 10⁶ | 遍历 |
| O(n log n) | 线性对数 | 2×10⁷ | 归并/快速/堆排序 |
| O(n²) | 平方 | 10¹² | 冒泡、朴素双重循环 |
| O(2ⁿ) / O(n!) | 指数/阶乘 | 不可行 | 暴力枚举子集/排列 |

经验：**一秒内 CPU 约能做 10⁸~10⁹ 次简单操作**，所以 n=10⁵ 要 O(n log n) 以内，n=10⁶ 以上要 O(n)/O(log n)，n≤20 可用指数（回溯/状压）。

### 2. 几个常被忽略的点

- **均摊复杂度**：`ArrayList.add` 偶尔扩容 O(n)，但均摊 O(1)（每次扩 1.5 倍，扩容次数是对数级，总拷贝与元素数同阶）；`HashMap` 扩容同理；
- **最坏 vs 平均**：快排平均 O(n log n) 最坏 O(n²)（随机化/三数取中避免）；哈希表平均 O(1) 最坏 O(n)（链表退化，JDK 8 用红黑树降到 O(log n)）；
- **空间复杂度**与**原地算法**：递归深度也算栈空间（O(n) 深的递归会栈溢出，需改迭代）；
- **常数与缓存**：连续内存（数组）因 **CPU 缓存行预取**，实测常比链表快数倍到数十倍，所以 `ArrayList` 在绝大多数场景胜过 `LinkedList`；
- **IO 为主的场景**：成本以**磁盘/网络访问次数**计，所以出现 B+ 树（矮胖，减少层数）、LSM、批量请求。

## 二、线性结构

### 1. 数组与 ArrayList

- 连续内存，**随机访问 O(1)**；头部/中间插入删除要搬移 O(n)；尾部追加均摊 O(1)；
- `ArrayList`：默认扩容 **1.5 倍**并 `Arrays.copyOf`，已知规模请指定初始容量避免多次扩容；`remove(int)`/`remove(Object)` 要小心重载与遍历中删除（`ConcurrentModificationException`，见 [集合框架](#/java/api/collections)）；
- 二维数组/矩阵按行遍历比按列快（行主序，缓存友好）。

### 2. 链表

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

// 反转链表：迭代，O(n) 时间 O(1) 空间
ListNode reverse(ListNode head) {
    ListNode prev = null, cur = head;
    while (cur != null) {
        ListNode next = cur.next;   // 先保存后继
        cur.next = prev;            // 反向
        prev = cur; cur = next;
    }
    return prev;
}
```

| | 数组 | 链表 |
| --- | --- | --- |
| 随机访问 | O(1) | O(n) |
| 头插/中间插（已定位） | O(n) | **O(1)** |
| 内存 | 紧凑、缓存友好 | 每节点指针开销、碎片、缓存差 |
| 典型 | `ArrayList` | `LinkedList`（也实现 Deque）、LRU 的双向链表、AQS 等待队列 |

链表高频技巧：**哨兵（dummy）节点**简化头结点处理；**快慢指针**找中点/判环（Floyd）/倒数第 k 个；**反转**与**合并有序链表**。

### 3. 栈、队列、双端队列

| 结构 | 规则 | Java | 场景 |
| --- | --- | --- | --- |
| 栈 | 后进先出 LIFO | `ArrayDeque`（不推荐 `Stack`/`Vector`，同步且过时） | 括号匹配、函数调用、DFS、单调栈、表达式求值 |
| 队列 | 先进先出 FIFO | `ArrayDeque`、`LinkedList`、阻塞队列 | BFS、任务队列、消息队列 |
| 双端队列 | 两端进出 | `ArrayDeque` | 滑动窗口最大值（单调队列）、工作窃取 |
| 环形队列 | 固定数组首尾相接 | — | Disruptor RingBuffer、网卡/日志缓冲、io_uring |

```java
// 最小栈：O(1) 取最小值——辅助栈同步记录“当前最小值”
class MinStack {
    private final Deque<int[]> st = new ArrayDeque<>();            // [值, 当前栈内最小]
    void push(int x) { int m = st.isEmpty() ? x : Math.min(x, st.peek()[1]); st.push(new int[]{x, m}); }
    void pop() { st.pop(); }
    int top() { return st.peek()[0]; }
    int getMin() { return st.peek()[1]; }
}
```

## 三、哈希表

### 1. 原理

<figure class="fig">
<svg viewBox="0 0 800 300" class="dg" role="img" aria-label="哈希表：键经过哈希函数和取模得到桶下标；冲突用拉链法把同桶元素串成链表，链表过长转红黑树；开放寻址法冲突时探测下一个空位；负载因子超过阈值触发扩容并重新分布元素">
<rect class="b1" x="20" y="30" width="120" height="44" rx="8"/>
<text class="tb" x="80" y="52" text-anchor="middle" dominant-baseline="middle">key</text>
<rect class="b5" x="180" y="30" width="170" height="44" rx="8"/>
<text class="tb" x="265" y="52" text-anchor="middle" dominant-baseline="middle">hash(key) &amp; (n-1)</text>
<line class="l" x1="140" y1="52" x2="180" y2="52" marker-end="url(#arr)"/>
<rect class="b3" x="420" y="20" width="60" height="26" rx="4"/>
<text class="ts" x="450" y="33" text-anchor="middle" dominant-baseline="middle">桶 0</text>
<rect class="b3" x="420" y="50" width="60" height="26" rx="4"/>
<text class="ts" x="450" y="63" text-anchor="middle" dominant-baseline="middle">桶 1</text>
<rect class="b3" x="420" y="80" width="60" height="26" rx="4"/>
<text class="ts" x="450" y="93" text-anchor="middle" dominant-baseline="middle">桶 2</text>
<rect class="b3" x="420" y="110" width="60" height="26" rx="4"/>
<text class="ts" x="450" y="123" text-anchor="middle" dominant-baseline="middle">桶 3</text>
<line class="l" x1="350" y1="52" x2="420" y2="63" marker-end="url(#arr)"/>
<rect class="b2" x="510" y="50" width="60" height="26" rx="4"/>
<text class="ts" x="540" y="63" text-anchor="middle" dominant-baseline="middle">A</text>
<rect class="b2" x="590" y="50" width="60" height="26" rx="4"/>
<text class="ts" x="620" y="63" text-anchor="middle" dominant-baseline="middle">B（冲突）</text>
<rect class="b2" x="670" y="50" width="60" height="26" rx="4"/>
<text class="ts" x="700" y="63" text-anchor="middle" dominant-baseline="middle">C</text>
<line class="l" x1="480" y1="63" x2="510" y2="63" marker-end="url(#arr)"/>
<line class="l" x1="570" y1="63" x2="590" y2="63" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="63" x2="670" y2="63" marker-end="url(#arr)"/>
<text class="ts" x="620" y="96" text-anchor="middle">拉链法：同桶元素串成链表（长度 ≥ 8 且表容量 ≥ 64 转红黑树）</text>
<rect class="bg" x="20" y="160" width="760" height="124" rx="10"/>
<text class="th" x="36" y="184">关键点</text>
<text class="ts" x="36" y="206">• 哈希函数：均匀分布、雪崩效应；HashMap 用 (h ^ h>>>16) 把高位混入低位，容量取 2 的幂用位与代替取模</text>
<text class="ts" x="36" y="226">• 冲突处理：拉链法（Java HashMap）；开放寻址（线性/二次探测/双重哈希，ThreadLocalMap、Python dict 类似）</text>
<text class="ts" x="36" y="246">• 负载因子 α = 元素数 / 桶数：默认 0.75；超过阈值扩容 2 倍并重新分布（rehash，渐进式 rehash 见 Redis dict）</text>
<text class="ts" x="36" y="266">• 键需要正确实现 hashCode/equals，且作为键的对象应不可变；否则放进去找不出来（内存泄漏/丢数据）</text>
</svg>
<figcaption>图 1：哈希表：哈希函数、冲突与扩容</figcaption>
</figure>

| 实现 | 特点 |
| --- | --- |
| `HashMap` | 非线程安全；拉链 + 红黑树；允许 null 键值 |
| `LinkedHashMap` | 在 HashMap 基础上维护双向链表：**插入序/访问序**——LRU 缓存的天然工具 |
| `ConcurrentHashMap` | 并发安全（CAS + synchronized 锁桶头，见 [ConcurrentHashMap](#/java/api/chm)） |
| `TreeMap` | 红黑树，有序，`O(log n)`，支持范围查询 `subMap` |
| Redis dict | 两张哈希表 + **渐进式 rehash**，避免一次性扩容阻塞（见 [Redis 数据结构编码](#/redis/types)） |

### 2. 哈希表的典型应用题

```java
// 两数之和：用哈希表把 O(n²) 降为 O(n)——“用空间换时间”
int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();            // 值 → 下标
    for (int i = 0; i < nums.length; i++) {
        Integer j = seen.get(target - nums[i]);
        if (j != null) return new int[]{j, i};
        seen.put(nums[i], i);
    }
    return new int[0];
}
```

高频套路：**计数**（频次统计、字母异位词）、**去重/判重**、**前缀和 + 哈希**（子数组和为 K）、**分组**（按特征归类）。

## 四、堆与优先队列

**堆**是完全二叉树，满足堆序：**最小堆**每个节点 ≤ 子节点（堆顶是最小值）。用**数组**存储（下标 i 的子节点为 2i+1、2i+2，父节点 (i−1)/2）。

| 操作 | 复杂度 | 说明 |
| --- | --- | --- |
| 取堆顶 | O(1) | |
| 插入（上浮 sift-up） | O(log n) | 放末尾，与父比较上浮 |
| 删除堆顶（下沉 sift-down） | O(log n) | 末尾元素补到堆顶，下沉 |
| **建堆** | **O(n)**（不是 n log n） | 从最后一个非叶节点开始自底向上下沉 |
| 堆排序 | O(n log n)，原地 | 不稳定 |

```java
// Top K 大：维护大小为 K 的最小堆，O(n log K)；比全排序 O(n log n) 更省，且适合流式数据
int[] topK(int[] nums, int k) {
    PriorityQueue<Integer> heap = new PriorityQueue<>(k);   // 最小堆
    for (int x : nums) {
        if (heap.size() < k) heap.offer(x);
        else if (x > heap.peek()) { heap.poll(); heap.offer(x); }   // 比堆顶大才替换
    }
    return heap.stream().mapToInt(Integer::intValue).toArray();
}
```

工程应用：**定时任务调度**（`ScheduledThreadPoolExecutor` 的 DelayedWorkQueue 是堆、Netty/Kafka 时间轮是替代）、**合并 K 个有序流**（归并、Flink/ES 的多路合并）、**Dijkstra**、**中位数维护（对顶堆）**、**Top K 热词**（见 [工程中的算法](#/cs/algo-engineering)）。`PriorityQueue` 不是线程安全且迭代无序，并发场景用 `PriorityBlockingQueue`。

## 五、树

### 1. 二叉树遍历

```java
class TreeNode { int val; TreeNode left, right; }

void inorder(TreeNode r, List<Integer> out) {       // 前/中/后序只是访问根的时机不同
    if (r == null) return;
    inorder(r.left, out); out.add(r.val); inorder(r.right, out);
}
// 层序遍历（BFS）：队列
List<List<Integer>> levelOrder(TreeNode root) {
    List<List<Integer>> res = new ArrayList<>();
    if (root == null) return res;
    Deque<TreeNode> q = new ArrayDeque<>(); q.offer(root);
    while (!q.isEmpty()) {
        int sz = q.size(); List<Integer> level = new ArrayList<>();
        for (int i = 0; i < sz; i++) {
            TreeNode n = q.poll(); level.add(n.val);
            if (n.left != null) q.offer(n.left);
            if (n.right != null) q.offer(n.right);
        }
        res.add(level);
    }
    return res;
}
```

**BST（二叉搜索树）的中序遍历是有序序列**，这条性质能解决很多题（验证 BST、第 K 小）。

### 2. 平衡树家族对比

<figure class="fig">
<svg viewBox="0 0 800 320" class="dg" role="img" aria-label="有序结构对比：普通二叉搜索树可能退化为链表；AVL 严格平衡查询快但旋转多；红黑树近似平衡插入删除旋转少，是 TreeMap 和 HashMap 桶的实现；B+ 树多叉矮胖，内部节点只存键，叶子存数据并用链表串联，适合磁盘和范围查询；跳表通过多层索引链表实现 O(log n)，实现简单便于并发，Redis 有序集合使用">
<rect class="b4" x="20" y="30" width="240" height="120" rx="10"/>
<text class="th" x="36" y="54">二叉搜索树 BST</text>
<text class="ts" x="36" y="78">有序插入退化成链表 O(n)</text>
<text class="ts" x="36" y="98">仅作概念基础</text>
<rect class="b2" x="280" y="30" width="240" height="120" rx="10"/>
<text class="th" x="296" y="54">AVL（严格平衡）</text>
<text class="ts" x="296" y="78">左右子树高度差 ≤ 1</text>
<text class="ts" x="296" y="98">查询最快，增删旋转多</text>
<text class="ts" x="296" y="118">读多写少的内存索引</text>
<rect class="b3" x="540" y="30" width="240" height="120" rx="10"/>
<text class="th" x="556" y="54">红黑树（近似平衡）</text>
<text class="ts" x="556" y="78">最长路径 ≤ 2 × 最短路径</text>
<text class="ts" x="556" y="98">增删最多 3 次旋转，均衡</text>
<text class="ts" x="556" y="118">TreeMap · HashMap 桶 · Linux CFS</text>
<rect class="b1" x="20" y="170" width="370" height="130" rx="10"/>
<text class="th" x="36" y="194">B+ 树（多叉、磁盘友好）</text>
<text class="ts" x="36" y="218">一个节点 = 一页（16KB），扇出上千，3~4 层存千万级数据</text>
<text class="ts" x="36" y="238">内部节点只存键；数据全在叶子；叶子双向链表 → 范围/排序</text>
<text class="ts" x="36" y="258">MySQL InnoDB 索引（见 B+ 树索引）、文件系统、数据库</text>
<text class="ts" x="36" y="278">为什么不用二叉树：层数高 = 磁盘 IO 次数多</text>
<rect class="b5" x="410" y="170" width="370" height="130" rx="10"/>
<text class="th" x="426" y="194">跳表 Skip List</text>
<text class="ts" x="426" y="218">多层有序链表：底层全量，上层稀疏“快速通道”</text>
<text class="ts" x="426" y="238">随机层数（概率 1/2 或 1/4），查询/插入期望 O(log n)</text>
<text class="ts" x="426" y="258">实现简单、范围遍历方便、并发友好（局部修改）</text>
<text class="ts" x="426" y="278">Redis ZSet · ConcurrentSkipListMap · LevelDB/RocksDB 内存表</text>
</svg>
<figcaption>图 2：有序数据结构对比</figcaption>
</figure>

要点：

- **红黑树** 5 条性质（根黑、叶黑、红节点子为黑、任一路径黑高相同）保证最长路径不超过最短的 2 倍，**插入最多 2 次旋转、删除最多 3 次**，比 AVL 写入更省；
- **B+ 树 vs B 树**：B+ 树数据只在叶子，内部节点更小 → 扇出更大、层数更少；叶子链表 → 范围扫描高效；查询稳定（总要到叶子）。详见 [B+ 树索引](#/mysql/index)；
- **跳表 vs 红黑树**（Redis 为何选跳表）：范围查询更简单（找到起点沿底层链表走）、实现简单、插入删除只改局部指针，不需要旋转，便于并发；

```java
// 跳表思想示意：查找 = 自上而下、向右走到“再右就过头”，再下一层
//  L3:  1 ─────────────────► 9
//  L2:  1 ───────► 5 ──────► 9
//  L1:  1 ──► 3 ─► 5 ─► 7 ─► 9
```

### 3. Trie（前缀树）与并查集

- **Trie**：按字符逐层分支，**查前缀 O(L)**（L 为字符串长度），用于自动补全、敏感词过滤（AC 自动机在其上加失败指针）、IP 路由最长前缀匹配、词频统计；空间大，可用压缩 Trie/双数组实现；
- **并查集 Union-Find**：维护“不相交集合”，**路径压缩 + 按秩合并** 后近似 O(1)；用于连通分量、最小生成树（Kruskal）、判断是否同组、朋友圈。

```java
class UnionFind {
    int[] parent;
    UnionFind(int n) { parent = new int[n]; for (int i = 0; i < n; i++) parent[i] = i; }
    int find(int x) { return parent[x] == x ? x : (parent[x] = find(parent[x])); }   // 路径压缩
    void union(int a, int b) { parent[find(a)] = find(b); }
    boolean connected(int a, int b) { return find(a) == find(b); }
}
```

## 六、经典设计题：LRU 缓存

**需求**：`get/put` 都是 O(1)，容量满时淘汰**最久未使用**的。**哈希表（快速定位）+ 双向链表（维护使用顺序）**。

```java
// 方案一：LinkedHashMap（accessOrder=true）+ 覆写 removeEldestEntry（面试说明原理后可直接这样用）
class LRUCache<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;
    LRUCache(int capacity) { super(16, 0.75f, true); this.capacity = capacity; }   // true = 按访问顺序
    @Override protected boolean removeEldestEntry(Map.Entry<K, V> eldest) { return size() > capacity; }
}

// 方案二：手写 HashMap + 双向链表（面试要求）
class LRU {
    class Node { int key, val; Node prev, next; Node(int k, int v) { key = k; val = v; } }
    private final Map<Integer, Node> map = new HashMap<>();
    private final Node head = new Node(0, 0), tail = new Node(0, 0);     // 哨兵：head 侧最新，tail 侧最旧
    private final int cap;
    LRU(int cap) { this.cap = cap; head.next = tail; tail.prev = head; }

    int get(int key) {
        Node n = map.get(key);
        if (n == null) return -1;
        remove(n); addFirst(n);                // 刚访问过，移到最前
        return n.val;
    }
    void put(int key, int val) {
        Node n = map.get(key);
        if (n != null) { n.val = val; remove(n); addFirst(n); return; }
        if (map.size() == cap) { Node last = tail.prev; remove(last); map.remove(last.key); }   // 淘汰最旧
        n = new Node(key, val); map.put(key, n); addFirst(n);
    }
    private void remove(Node n) { n.prev.next = n.next; n.next.prev = n.prev; }
    private void addFirst(Node n) { n.next = head.next; n.prev = head; head.next.prev = n; head.next = n; }
}
```

注意：线程安全需加锁或使用 Caffeine（**W-TinyLFU**，命中率更高，见 [缓存](#/redis/cache)）；Redis 采用**近似 LRU**（随机采样），MySQL Buffer Pool 用**young/old 分区**防止扫描污染，都是对朴素 LRU 的工程改良。

## 七、并发容器怎么选

| 需求 | 选择 |
| --- | --- |
| 线程安全 Map | `ConcurrentHashMap`（不是 `Hashtable`/`synchronizedMap`） |
| 读多写极少的 List | `CopyOnWriteArrayList`（写时复制，写贵） |
| 有序并发 Map | `ConcurrentSkipListMap` |
| 生产者消费者 | `ArrayBlockingQueue`（有界）、`LinkedBlockingQueue`、`LinkedTransferQueue`、`Disruptor` |
| 延迟队列 | `DelayQueue`、`ScheduledThreadPoolExecutor` |

详见 [并发工具类 JUC](#/java/concurrency/juc)。

## 八、选型速查

| 需求 | 数据结构 |
| --- | --- |
| 按下标快速访问 | 数组 / `ArrayList` |
| 频繁头尾增删 | `ArrayDeque` |
| 按键 O(1) 查找 | `HashMap` |
| 按键有序、范围查询 | `TreeMap` / 跳表 / B+ 树 |
| 反复取最值 / Top K | 堆 `PriorityQueue` |
| 判重 / 集合运算 | `HashSet`；海量数据用布隆过滤器 |
| 前缀匹配 | Trie |
| 连通性 / 分组 | 并查集 |
| 先进先出 / 缓冲 | 队列、环形缓冲 |
| LRU / LFU | HashMap + 双向链表 / 频次桶 |

## 面试追问

> [!QUESTION] ArrayList 和 LinkedList 的区别？为什么实际中很少用 LinkedList？
> ArrayList 基于数组，随机访问 O(1)，尾部追加均摊 O(1)，中间插入需搬移；LinkedList 基于双向链表，已定位节点时插入删除 O(1)，但访问和定位 O(n)，且每个节点有指针开销、缓存局部性差。实际中数组的缓存友好让 ArrayList 在多数场景更快，需要双端操作时用 ArrayDeque。

> [!QUESTION] 哈希表如何解决冲突？HashMap 为什么扩容是 2 的幂？
> 常用拉链法和开放寻址。HashMap 用拉链加红黑树，容量取 2 的幂使取模可用位与代替，且扩容时元素要么留在原位置要么移动原容量的偏移，便于拆分链表。负载因子默认 0.75 平衡空间与冲突。

> [!QUESTION] 红黑树相比 AVL 树有什么优势？
> AVL 严格平衡查询更快但插入删除需要更多旋转；红黑树只要求最长路径不超过最短路径两倍，插入最多两次旋转、删除最多三次，写入代价更低，综合性能更均衡，所以 TreeMap、HashMap 桶和内核调度使用红黑树。

> [!QUESTION] MySQL 为什么用 B+ 树而不是红黑树或哈希？
> 数据在磁盘，成本以 IO 次数计，B+ 树多叉矮胖，一个节点对应一页，三四层就能存千万级数据，查询只需几次 IO；叶子用链表串联，范围查询和排序高效；内部节点不存数据，扇出更大。红黑树层数太高，哈希不支持范围和排序。

> [!QUESTION] Redis 的有序集合为什么用跳表而不是红黑树？
> 跳表实现简单，范围查询只需定位起点后沿底层链表遍历，插入删除只修改局部指针无需旋转，性能与平衡树同阶，也更容易调试和并发。

> [!QUESTION] 如何在海量数据中求 Top K？
> 维护大小为 K 的最小堆，遍历数据，比堆顶大才替换，时间 O(n log K)，空间 O(K)，适合流式数据；数据极大时分片并行求局部 Top K 再合并，或使用快速选择算法平均 O(n)；统计频次场景先哈希计数或用 Count-Min Sketch。

> [!QUESTION] 手写 LRU 缓存的思路？
> 哈希表保存键到链表节点的映射，双向链表按使用顺序排列，最新在头最旧在尾；get 命中时把节点移到头部，put 新键时若满则删除尾节点并移除映射，所有操作 O(1)。Java 中也可用 accessOrder 为 true 的 LinkedHashMap 覆写 removeEldestEntry。
