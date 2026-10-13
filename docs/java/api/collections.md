---
level: 进阶
tags: [集合, ArrayList, ArrayDeque, PriorityQueue, TreeMap, LinkedHashMap, 不可变集合]
summary: 从源码层面梳理 JDK 集合体系：底层结构、扩容策略、fail-fast、各实现的复杂度与选型依据
---

# 集合体系总览

> [!ABSTRACT] 核心要点
> - 集合分两棵树：`Collection`（List / Set / Queue）与 `Map`；`Set` 几乎都是对应 `Map` 的包装（`HashSet` 内部就是 `HashMap`）。
> - `ArrayList` 默认构造不分配数组，首次 `add` 才扩到 10，之后按 **1.5 倍** 扩容；结构性修改会 `modCount++`，迭代器据此 **fail-fast** 抛 `ConcurrentModificationException`。
> - 栈和队列首选 `ArrayDeque`（环形数组，不允许 null），优先级调度用 `PriorityQueue`（数组实现的二叉小顶堆），有序/范围查询用 `TreeMap`（红黑树）。
> - `LinkedHashMap(cap, lf, true)` + 重写 `removeEldestEntry` 就是一个 LRU；但注意 accessOrder 下 `get` 也是结构性修改。
> - `List.of / Set.of / Map.of`（JDK 9+）是真正不可变的紧凑实现：**拒绝 null**（连 `contains(null)` 都抛 NPE），`Set.of/Map.of` 的迭代顺序每次 JVM 启动都可能不同。

## 体系结构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Java 集合体系：Collection 下分 List、Set、Queue 及其实现，Map 为独立体系">
<rect class="bg" x="10" y="10" width="480" height="340" rx="12"/>
<rect class="bg" x="505" y="10" width="245" height="340" rx="12"/>
<rect class="b" x="185" y="26" width="120" height="34" rx="6"/>
<text class="tb" x="245" y="43" text-anchor="middle" dominant-baseline="middle">Collection</text>
<line class="l" x1="245" y1="60" x2="95" y2="96" marker-end="url(#arr)"/>
<line class="l" x1="245" y1="60" x2="245" y2="96" marker-end="url(#arr)"/>
<line class="l" x1="245" y1="60" x2="395" y2="96" marker-end="url(#arr)"/>
<rect class="b" x="25" y="96" width="140" height="34" rx="6"/>
<text class="tb" x="95" y="113" text-anchor="middle" dominant-baseline="middle">List</text>
<rect class="b" x="175" y="96" width="140" height="34" rx="6"/>
<text class="tb" x="245" y="113" text-anchor="middle" dominant-baseline="middle">Set</text>
<rect class="b" x="325" y="96" width="140" height="34" rx="6"/>
<text class="tb" x="395" y="113" text-anchor="middle" dominant-baseline="middle">Queue / Deque</text>
<line class="l" x1="35" y1="130" x2="35" y2="265"/>
<line class="l" x1="35" y1="165" x2="47" y2="165"/>
<line class="l" x1="35" y1="215" x2="47" y2="215"/>
<line class="l" x1="35" y1="265" x2="47" y2="265"/>
<rect class="b1" x="47" y="150" width="118" height="30" rx="6"/>
<text class="tm" x="106" y="165" text-anchor="middle" dominant-baseline="middle">ArrayList</text>
<rect class="b1" x="47" y="200" width="118" height="30" rx="6"/>
<text class="tm" x="106" y="215" text-anchor="middle" dominant-baseline="middle">LinkedList</text>
<rect class="b1" x="47" y="250" width="118" height="30" rx="6"/>
<text class="tm" x="106" y="265" text-anchor="middle" dominant-baseline="middle">CopyOnWrite…</text>
<line class="l" x1="185" y1="130" x2="185" y2="265"/>
<line class="l" x1="185" y1="165" x2="197" y2="165"/>
<line class="l" x1="185" y1="215" x2="197" y2="215"/>
<line class="l" x1="185" y1="265" x2="197" y2="265"/>
<rect class="b2" x="197" y="150" width="118" height="30" rx="6"/>
<text class="tm" x="256" y="165" text-anchor="middle" dominant-baseline="middle">HashSet</text>
<rect class="b2" x="197" y="200" width="118" height="30" rx="6"/>
<text class="tm" x="256" y="215" text-anchor="middle" dominant-baseline="middle">LinkedHashSet</text>
<rect class="b2" x="197" y="250" width="118" height="30" rx="6"/>
<text class="tm" x="256" y="265" text-anchor="middle" dominant-baseline="middle">TreeSet</text>
<line class="l" x1="335" y1="130" x2="335" y2="265"/>
<line class="l" x1="335" y1="165" x2="347" y2="165"/>
<line class="l" x1="335" y1="215" x2="347" y2="215"/>
<line class="l" x1="335" y1="265" x2="347" y2="265"/>
<rect class="b3" x="347" y="150" width="118" height="30" rx="6"/>
<text class="tm" x="406" y="165" text-anchor="middle" dominant-baseline="middle">ArrayDeque</text>
<rect class="b3" x="347" y="200" width="118" height="30" rx="6"/>
<text class="tm" x="406" y="215" text-anchor="middle" dominant-baseline="middle">PriorityQueue</text>
<rect class="b3" x="347" y="250" width="118" height="30" rx="6"/>
<text class="tm" x="406" y="265" text-anchor="middle" dominant-baseline="middle">BlockingQueue</text>
<text class="ts" x="25" y="310">灰底 = 接口；彩色 = 常用实现。LinkedList 同时实现 List 与 Deque；</text>
<text class="ts" x="25" y="328">HashSet / LinkedHashSet / TreeSet 内部分别委托 HashMap / LinkedHashMap / TreeMap</text>
<text class="ts" x="520" y="38">Map：独立体系，不继承 Collection</text>
<rect class="b" x="520" y="96" width="140" height="34" rx="6"/>
<text class="tb" x="590" y="113" text-anchor="middle" dominant-baseline="middle">Map</text>
<line class="l" x1="530" y1="130" x2="530" y2="315"/>
<line class="l" x1="530" y1="165" x2="542" y2="165"/>
<line class="l" x1="530" y1="215" x2="542" y2="215"/>
<line class="l" x1="530" y1="265" x2="542" y2="265"/>
<line class="l" x1="530" y1="315" x2="542" y2="315"/>
<rect class="b5" x="542" y="150" width="190" height="30" rx="6"/>
<text class="tm" x="637" y="165" text-anchor="middle" dominant-baseline="middle">HashMap</text>
<rect class="b5" x="542" y="200" width="190" height="30" rx="6"/>
<text class="tm" x="637" y="215" text-anchor="middle" dominant-baseline="middle">LinkedHashMap</text>
<rect class="b5" x="542" y="250" width="190" height="30" rx="6"/>
<text class="tm" x="637" y="265" text-anchor="middle" dominant-baseline="middle">TreeMap</text>
<rect class="b5" x="542" y="300" width="190" height="30" rx="6"/>
<text class="tm" x="637" y="315" text-anchor="middle" dominant-baseline="middle">ConcurrentHashMap</text>
</svg>
<figcaption>图 1：集合体系主干（省略了 AbstractXxx 骨架类与 Sorted/Navigable 中间接口）</figcaption>
</figure>

几个容易被忽略的结构事实：

- `Iterable` 是 `Collection` 的父接口，所以只有 `Collection` 能直接 for-each，`Map` 要走 `entrySet()`。
- `Sorted*` → `Navigable*`（JDK 6）提供 `floor/ceiling/higher/lower`、`headMap/tailMap/subMap` 等范围操作，只有 `TreeMap/TreeSet` 与 `ConcurrentSkipListMap/Set` 实现。
- JDK 21（JEP 431）引入 `SequencedCollection / SequencedMap`，给 `List`、`Deque`、`LinkedHashSet`、`LinkedHashMap`、`SortedSet` 等统一了 `getFirst/getLast/addFirst/reversed()` 等方法，终于不用写 `list.get(list.size() - 1)`。
- `RandomAccess` 是一个标记接口：`Collections.binarySearch`、`Collections.shuffle` 等算法会据此选择「下标访问」还是「迭代器访问」。

## ArrayList：扩容与 fail-fast

### 扩容源码

```java
// JDK 17 ArrayList（节选）
private static final int DEFAULT_CAPACITY = 10;
private static final Object[] DEFAULTCAPACITY_EMPTY_ELEMENTDATA = {};
transient Object[] elementData;   // transient：序列化时只写 size 个元素（自定义 writeObject）

public ArrayList() {
    this.elementData = DEFAULTCAPACITY_EMPTY_ELEMENTDATA;   // 懒分配：先不建数组
}

private Object[] grow(int minCapacity) {
    int oldCapacity = elementData.length;
    if (oldCapacity > 0 || elementData != DEFAULTCAPACITY_EMPTY_ELEMENTDATA) {
        int newCapacity = ArraysSupport.newLength(oldCapacity,
                minCapacity - oldCapacity,   // 至少要长这么多
                oldCapacity >> 1);           // 期望增长 0.5 倍 → 1.5 倍扩容
        return elementData = Arrays.copyOf(elementData, newCapacity);
    } else {
        // 默认构造的空数组：第一次扩容直接到 10
        return elementData = new Object[Math.max(DEFAULT_CAPACITY, minCapacity)];
    }
}
```

- 增长序列：0 → 10 → 15 → 22 → 33 → 49 …；每次扩容都是 `Arrays.copyOf`（底层 `System.arraycopy`），代价 O(n)，均摊到每次 `add` 是 O(1)。
- `new ArrayList<>(0)` 与 `new ArrayList<>()` 不同：前者用 `EMPTY_ELEMENTDATA`，扩容序列是 0 → 1 → 2 → 3 → 4 → 6 …，小容量阶段反而会频繁拷贝。
- 已知大小时用 `new ArrayList<>(n)` 或 `ensureCapacity(n)`；批量追加用 `addAll`（只扩容一次）。
- `trimToSize()` 可回收多余容量，适合长期驻留的大列表。

### modCount 与 fail-fast

`AbstractList` 里有一个 `protected transient int modCount`，所有**结构性修改**（改变 size 的操作：add / remove / clear / 扩容）都会 `modCount++`，`set` 不算。迭代器创建时记下 `expectedModCount`，每次 `next()` 校验：

```java
// JDK 17 ArrayList.Itr（节选）
private class Itr implements Iterator<E> {
    int cursor;                 // 下一个要返回的下标
    int lastRet = -1;
    int expectedModCount = modCount;

    public boolean hasNext() { return cursor != size; }

    public E next() {
        checkForComodification();          // modCount != expectedModCount → CME
        int i = cursor;
        ...
        cursor = i + 1;
        return (E) elementData[lastRet = i];
    }

    public void remove() {
        ...
        ArrayList.this.remove(lastRet);
        cursor = lastRet;
        lastRet = -1;
        expectedModCount = modCount;       // 通过迭代器删除会同步 expectedModCount
    }
}
```

> [!WARNING] 「删倒数第二个元素不报错」的诡异现象
> `List<String> l = new ArrayList<>(List.of("a", "b", "c"));` 然后 `for (String s : l) if (s.equals("b")) l.remove(s);` **不会抛异常**：删除后 size 变成 2，而 cursor 恰好是 2，`hasNext()` 返回 false 直接退出——但 `"c"` 根本没被遍历到。fail-fast 是**尽力而为**的检测，不是正确性保证，代码里不能依赖它。

正确的删除方式：`iterator.remove()`、`list.removeIf(pred)`（JDK 8，内部先标记再一次性压缩，O(n)），或者倒序下标删除。

fail-fast 的另外两个经典来源：

- `subList` 返回的是**视图**，持有父列表的 `modCount` 快照；对父列表做结构性修改后再访问 subList → CME。分页切片后需要独立使用的，`new ArrayList<>(list.subList(a, b))`。
- `Arrays.asList` 返回的是 `Arrays$ArrayList`（与 `java.util.ArrayList` 同名不同类），**定长**、写穿到原数组：`add/remove` 抛 `UnsupportedOperationException`，`set` 会改原数组。另外 `Arrays.asList(new int[]{1,2})` 得到的是 `List<int[]>`，只有 1 个元素。

## LinkedList：几乎没有用武之地

双向链表，`Node{item, prev, next}`。`get(index)` 会根据 `index < (size >> 1)` 从头或尾开始遍历，仍是 O(n)。

- 理论上头尾插删 O(1)，但每个元素额外一个 Node 对象（开了压缩指针约 24 字节），缓存局部性差；实测作为队列/栈通常比 `ArrayDeque` 慢。
- 「中间插入快」只在你**已经持有位置的迭代器**时成立（`ListIterator.add`），按下标插入要先 O(n) 定位。
- 唯一常见的正当用途：需要 `List` + `Deque` 双接口且允许 null 元素。

## ArrayDeque：环形数组

<figure class="fig">
<svg viewBox="0 0 720 210" class="dg" role="img" aria-label="ArrayDeque 环形数组：head 在下标 6，tail 在下标 2，元素绕回数组开头">
<text class="ts" x="60" y="30">elements[]（JDK 8：长度恒为 2 的幂，这里取 8）</text>
<text class="ts" x="95" y="60" text-anchor="middle">0</text>
<text class="ts" x="165" y="60" text-anchor="middle">1</text>
<text class="ts" x="235" y="60" text-anchor="middle">2</text>
<text class="ts" x="305" y="60" text-anchor="middle">3</text>
<text class="ts" x="375" y="60" text-anchor="middle">4</text>
<text class="ts" x="445" y="60" text-anchor="middle">5</text>
<text class="ts" x="515" y="60" text-anchor="middle">6</text>
<text class="ts" x="585" y="60" text-anchor="middle">7</text>
<rect class="b2" x="60" y="70" width="70" height="44"/>
<text class="tm" x="95" y="92" text-anchor="middle" dominant-baseline="middle">e2</text>
<rect class="b2" x="130" y="70" width="70" height="44"/>
<text class="tm" x="165" y="92" text-anchor="middle" dominant-baseline="middle">e3</text>
<rect class="b" x="200" y="70" width="70" height="44"/>
<text class="ts" x="235" y="92" text-anchor="middle" dominant-baseline="middle">null</text>
<rect class="b" x="270" y="70" width="70" height="44"/>
<text class="ts" x="305" y="92" text-anchor="middle" dominant-baseline="middle">null</text>
<rect class="b" x="340" y="70" width="70" height="44"/>
<text class="ts" x="375" y="92" text-anchor="middle" dominant-baseline="middle">null</text>
<rect class="b" x="410" y="70" width="70" height="44"/>
<text class="ts" x="445" y="92" text-anchor="middle" dominant-baseline="middle">null</text>
<rect class="b2" x="480" y="70" width="70" height="44"/>
<text class="tm" x="515" y="92" text-anchor="middle" dominant-baseline="middle">e0</text>
<rect class="b2" x="550" y="70" width="70" height="44"/>
<text class="tm" x="585" y="92" text-anchor="middle" dominant-baseline="middle">e1</text>
<line class="la" x1="515" y1="150" x2="515" y2="118" marker-end="url(#arr-a)"/>
<text class="ta" x="515" y="166" text-anchor="middle">head = 6（队首）</text>
<line class="l" x1="235" y1="150" x2="235" y2="118" marker-end="url(#arr)"/>
<text class="t" x="235" y="166" text-anchor="middle">tail = 2（下一个写入位）</text>
<text class="ts" x="60" y="196">addLast：elements[tail] = e; tail = (tail + 1) &amp; (len - 1)；若 tail == head 说明写满 → doubleCapacity()</text>
</svg>
<figcaption>图 2：ArrayDeque 逻辑顺序 e0 → e1 → e2 → e3，物理上绕回数组开头</figcaption>
</figure>

```java
// JDK 8 ArrayDeque（节选）
public void addFirst(E e) {
    if (e == null) throw new NullPointerException();          // null 被用作「空槽」标记
    elements[head = (head - 1) & (elements.length - 1)] = e;   // head 向左绕
    if (head == tail) doubleCapacity();
}
public void addLast(E e) {
    if (e == null) throw new NullPointerException();
    elements[tail] = e;
    if ((tail = (tail + 1) & (elements.length - 1)) == head) doubleCapacity();
}
```

- JDK 8：长度是 2 的幂，用 `& (len-1)` 取模；默认 16；写满才扩容（翻倍并把两段搬成连续）。
- JDK 9+ 重写：不再要求 2 的幂，用 `inc/dec` 比较绕回；内部始终保留至少一个空槽来区分空/满；小容量时约翻倍、大容量时约增长 50%。
- 优势：无节点对象、数组连续、`addFirst/addLast/pollFirst/pollLast` 都是 O(1)。`Stack`（继承 `Vector`，方法全同步）和 `LinkedList` 当栈/队列用都不如它。
- 限制：不支持 null、不支持按下标访问、非线程安全（并发用 `ConcurrentLinkedDeque` / `LinkedBlockingDeque`）。

## PriorityQueue：二叉堆

`Object[] queue` 存一棵**完全二叉树**（默认小顶堆）：下标 `i` 的子节点是 `2i+1`、`2i+2`，父节点是 `(i-1) >>> 1`。

```java
// JDK 17 PriorityQueue（节选，简化了比较器分支）
public boolean offer(E e) {
    int i = size;
    if (i >= queue.length) grow(i + 1);   // 小于 64 时约翻倍(+2)，否则增长 50%
    siftUp(i, e);                         // 放到末尾，向上冒泡
    size = i + 1;
    return true;
}
public E poll() {
    final Object[] es = queue;
    final E result = (E) es[0];          // 堆顶即最小值
    if (result != null) {
        final int n = --size;
        final E x = (E) es[n];           // 取最后一个元素
        es[n] = null;
        if (n > 0) siftDown(0, x);       // 放到堆顶，向下沉
    }
    return result;
}
private static <T> void siftUpComparable(int k, T x, Object[] es) {
    Comparable<? super T> key = (Comparable<? super T>) x;
    while (k > 0) {
        int parent = (k - 1) >>> 1;
        Object e = es[parent];
        if (key.compareTo((T) e) >= 0) break;
        es[k] = e;                       // 父节点下移（不是交换，少一次写）
        k = parent;
    }
    es[k] = key;
}
```

- 复杂度：`offer/poll` O(log n)，`peek` O(1)，`remove(Object)` 和 `contains` O(n)。
- 用集合构造时走 `heapify()`，自底向上建堆，O(n) 而非 O(n log n)。
- **迭代器和 `toString` 不保证有序**，只有不断 `poll` 才是有序的。
- 默认初始容量 11；不允许 null；非线程安全，并发版本是 `PriorityBlockingQueue`，延迟任务用 `DelayQueue`（内部也是 `PriorityQueue`）。
- 经典用法：Top K 用大小为 K 的**小顶堆**（堆顶是当前第 K 大，新元素比它大才替换），O(n log K)。

## TreeMap：红黑树

`Entry{key, value, left, right, parent, color}`。红黑树是一棵近似平衡的 BST：根黑、红节点的子必黑、任一节点到其所有叶子路径上的黑节点数相同，因此最长路径不超过最短路径的 2 倍，高度 ≤ 2·log₂(n+1)。

- 插入最多 2 次旋转，删除最多 3 次旋转，其余靠变色；相比 AVL 写操作更省。
- `get/put/remove` O(log n)；`firstKey/floorKey/ceilingKey/subMap` 适合做**区间路由**：一致性哈希环（`tailMap(hash)` 找顺时针第一个节点）、IP 段/价格段匹配、按时间范围检索。
- 比较只看 `compareTo`/`Comparator`，**不调用 `equals` 和 `hashCode`**。

> [!WARNING] 比较器与 equals 不一致导致「丢数据」
> `new TreeSet<>(Comparator.comparing(User::getAge))`：两个同龄用户 `compare` 返回 0，后一个被当成重复元素直接丢弃。比较器必须能区分所有业务上不同的元素，常见写法是追加 tie-breaker：`comparing(User::getAge).thenComparing(User::getId)`。同理，`new BigDecimal("1.0")` 与 `new BigDecimal("1.00")` 在 `HashSet` 中是 2 个元素，在 `TreeSet` 中是 1 个。

自然排序时 `put(null, v)` 抛 NPE；用自定义 Comparator 且能处理 null（如 `Comparator.nullsFirst`）才可以存 null key。

## LinkedHashMap：顺序与 LRU

`LinkedHashMap extends HashMap`，节点 `Entry extends HashMap.Node` 额外加了 `before/after` 两个指针，所有节点串成一条双向链表（`head` 最老，`tail` 最新）。它通过覆盖 `HashMap` 预留的三个钩子维护链表：

```java
// JDK 8/17 LinkedHashMap（节选）
final boolean accessOrder;   // false = 插入顺序（默认）；true = 访问顺序

void afterNodeAccess(Node<K,V> e) {       // get / put 已存在的 key 后调用
    if (accessOrder && tail != e) {
        ... 把 e 从链表中摘下并挂到 tail ...
        ++modCount;                       // 注意：访问顺序下 get 是结构性修改
    }
}

void afterNodeInsertion(boolean evict) {  // putVal 插入新节点后调用
    LinkedHashMap.Entry<K,V> first;
    if (evict && (first = head) != null && removeEldestEntry(first)) {
        K key = first.key;
        removeNode(hash(key), key, null, false, true);   // 淘汰最老节点
    }
}

protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
    return false;                         // 默认不淘汰，留给子类覆盖
}
```

```java
// 十几行的 LRU 缓存
public class LruCache<K, V> extends LinkedHashMap<K, V> {
    private final int maxSize;
    public LruCache(int maxSize) {
        super(16, 0.75f, true);           // 第三个参数 accessOrder = true
        this.maxSize = maxSize;
    }
    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > maxSize;          // 插入后超过上限就淘汰 head
    }
}
```

- 迭代 `LinkedHashMap` 是 O(size)（走链表），而迭代 `HashMap` 是 O(capacity + size)（要扫描整个桶数组）；容量很大、元素很少时差异明显。
- accessOrder 模式下，**一边遍历一边 `get` 会抛 CME**，因为 `get` 改变了链表顺序并 `modCount++`。
- 它非线程安全，`Collections.synchronizedMap` 包一层能用但全局一把锁；生产级本地缓存应直接用 **Caffeine**（W-TinyLFU，命中率和并发性能都远好于 LRU 链表）。

## 不可变集合：List.of 的实现与限制

JDK 9 引入的 `List.of / Set.of / Map.of` 由 `java.util.ImmutableCollections` 提供，按元素个数选择紧凑实现：

| 工厂方法 | 内部类 | 说明 |
| --- | --- | --- |
| `List.of()` / `of(e1)` / `of(e1,e2)` | `List12` / `ListN` | 1～2 个元素用字段直接存，省掉数组 |
| `List.of(e1..en)` | `ListN` | 内部 `Object[]`，构造时逐个 `requireNonNull` |
| `Set.of(...)` | `Set12` / `SetN` | `SetN` 是**开放寻址**哈希表，探测起点混入随机 `SALT` |
| `Map.of(...)` | `Map1` / `MapN` | `MapN` 把 k、v 交替放在同一个数组里，同样开放寻址 |

行为差异总结：

```java
List<Integer> a = List.of(1, 2, 3);
a.add(4);                 // UnsupportedOperationException
List.of(1, null);         // NullPointerException：构造时拒绝 null
a.contains(null);         // NullPointerException！查询 null 也不行
Set.of(1, 1);             // IllegalArgumentException：重复元素
Map.of("k", 1, "k", 2);   // IllegalArgumentException：重复 key

List<Integer> b = Collections.unmodifiableList(src);  // 只是「只读视图」，src 改了 b 也变
List<Integer> c = List.copyOf(src);                   // 真拷贝；若 src 本身已是不可变集合则直接返回
List<Integer> d = stream.toList();                    // JDK 16：不可变，但允许 null
List<Integer> e = stream.collect(Collectors.toList()); // 目前实现是 ArrayList，可变（规范不保证）
```

> [!CAUTION] 迭代顺序随机
> `Set.of`/`Map.of` 的 `SALT` 在每次 JVM 启动时随机生成，**同一份代码每次运行遍历顺序都可能不同**。依赖其顺序的单测会「偶发失败」，依赖其顺序生成签名、拼 SQL 条件的线上代码会出现难以复现的问题。需要稳定顺序请用 `LinkedHashMap`/`TreeMap`。

另外，`Map.of` 最多只有 10 对参数的重载，更多时用 `Map.ofEntries(Map.entry(k, v), ...)`。不可变集合用于做 Spring/MyBatis 的入参或返回值时，下游框架若尝试修改（如某些 JSON 库反序列化回填、`Collections.sort`）就会抛 `UnsupportedOperationException`。

## 复杂度速查

| 实现 | 底层 | 访问 / 查找 | 头部插删 | 尾部插删 | 中间插删 | 有序 | null |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ArrayList` | 动态数组 | O(1) 下标 / O(n) 查找 | O(n) | 均摊 O(1) | O(n) | 插入序 | 允许 |
| `LinkedList` | 双向链表 | O(n) | O(1) | O(1) | 定位 O(n) | 插入序 | 允许 |
| `ArrayDeque` | 环形数组 | 不支持下标 | O(1) | O(1) | — | 插入序 | 不允许 |
| `PriorityQueue` | 二叉堆 | `peek` O(1) | — | `offer/poll` O(log n) | `remove(o)` O(n) | 仅堆顶有序 | 不允许 |
| `HashMap/HashSet` | 数组+链表/红黑树 | 平均 O(1)，最坏 O(log n) | — | — | — | 无序 | 允许 1 个 null key |
| `LinkedHashMap` | HashMap + 双向链表 | 平均 O(1) | — | — | — | 插入序/访问序 | 允许 |
| `TreeMap/TreeSet` | 红黑树 | O(log n) | — | — | — | key 排序 | 自然序不允许 null key |
| `CopyOnWriteArrayList` | 写时复制数组 | O(1) | O(n) | O(n) | O(n) | 插入序 | 允许 |

## 选型与对比

| 场景 | 推荐 | 不推荐 / 原因 |
| --- | --- | --- |
| 一般列表 | `ArrayList`（预估容量） | `LinkedList`：内存大、缓存不友好 |
| 栈 / 双端队列 / BFS 队列 | `ArrayDeque` | `Stack`（同步开销、继承 Vector 暴露下标操作） |
| Top K、任务调度、合并 K 路有序流 | `PriorityQueue` | 每次全排序 |
| 范围查询、最近邻 key、一致性哈希 | `TreeMap` / `ConcurrentSkipListMap`（并发） | `HashMap` 无序 |
| 保持插入顺序的 Map / 去重 | `LinkedHashMap` / `LinkedHashSet` | `HashMap` 迭代顺序不定 |
| 简单 LRU | `LinkedHashMap(accessOrder=true)` | 生产缓存用 Caffeine |
| 读多写极少的监听器列表、路由表 | `CopyOnWriteArrayList` | 写多时每次复制整个数组 |
| 常量、配置、对外暴露的只读集合 | `List.of` / `List.copyOf` | `Collections.unmodifiableList`（底层可变） |
| 枚举做 key / 元素 | `EnumMap` / `EnumSet`（数组 / 位图实现，极快） | `HashMap<EnumType, V>` |
| 并发 Map | `ConcurrentHashMap` | `Hashtable`、`synchronizedMap` |

HashMap 与 ConcurrentHashMap 的源码细节见 [HashMap 源码剖析](#/java/api/hashmap) 与 [ConcurrentHashMap 源码剖析](#/java/api/chm)。

## 生产实践与踩坑

1. **大列表反复扩容导致 GC 抖动**：一次查出几十万行装进默认 `ArrayList`，扩容链上产生大量短命大数组，可能直接进老年代（G1 中超过 Region 一半即为 Humongous 对象）。修复：预估容量，或改为流式/分页处理。
2. **`Arrays.asList` 后 `add` 抛 `UnsupportedOperationException`**：多见于把参数数组转 List 再追加元素。用 `new ArrayList<>(Arrays.asList(arr))`。
3. **for-each 中删除元素**：要么 CME，要么悄悄漏处理元素（见上文「删倒数第二个」）。统一用 `removeIf`。
4. **`subList` 长期持有**：subList 引用整个父列表，导致父列表无法回收（隐性内存泄漏），同时父列表修改后再用它会 CME。
5. **多线程往 `ArrayList` 里 `add`**：会出现元素丢失、`null` 元素、`ArrayIndexOutOfBoundsException`（size 自增与扩容不是原子的）。用 `Collections.synchronizedList`、`CopyOnWriteArrayList`，或每个线程各自收集最后合并。
6. **`PriorityQueue` 中元素的排序字段被修改**：堆不会自动调整，堆序被破坏，后续 `poll` 结果错乱。修改前先 `remove` 再 `offer`。
7. **`Set.of` 顺序导致的偶发单测失败**：断言集合内容时用 `containsExactlyInAnyOrder` 之类的无序断言。
8. **`TreeMap`/`TreeSet` 比较器返回 0 丢元素**：比较器追加唯一字段做 tie-breaker。

## 相关阅读

- [复杂度与核心数据结构](#/cs/algo-ds)：背后的数据结构与复杂度分析
- [HashMap 源码剖析](#/java/api/hashmap)：HashMap 源码
- [并发工具与 CompletableFuture](#/java/concurrency/juc)：并发集合如何选

## 面试追问

> [!QUESTION] ArrayList 的扩容机制是怎样的？为什么是 1.5 倍？
> - 默认构造懒分配，首次 add 扩到 10；之后 `old + (old >> 1)`，底层 `Arrays.copyOf`。
> - 1.5 倍是空间浪费与拷贝次数的折中：倍数越大浪费越多，越小拷贝越频繁；位移计算也便宜。（C++ 圈常说「因子小于黄金比例才能复用旧内存块」，对有 GC 与 TLAB 的 Java 意义不大，不必背。）
> - JDK 17 用 `ArraysSupport.newLength` 统一处理溢出与「至少增长 minGrowth」。

> [!QUESTION] fail-fast 和 fail-safe 有什么区别？
> - fail-fast：基于 `modCount` 检测并发修改，立即抛 CME，`java.util` 下的普通集合都是；只是尽力检测，不保证一定抛。
> - fail-safe（弱一致）：迭代的是快照或允许并发修改的结构，不抛 CME，例如 `CopyOnWriteArrayList`（快照）、`ConcurrentHashMap`（弱一致迭代器，可能看到也可能看不到迭代期间的修改）。

> [!QUESTION] 如何用 LinkedHashMap 实现 LRU？它线程安全吗？有什么问题？
> - 构造时 `accessOrder = true`，`get/put` 命中后 `afterNodeAccess` 把节点移到尾部；重写 `removeEldestEntry` 返回 `size() > max`，插入后由 `afterNodeInsertion` 淘汰 head。
> - 非线程安全，且访问顺序模式下 `get` 也会修改链表，读也要加锁；高并发场景用 Caffeine。

> [!QUESTION] 为什么推荐用 ArrayDeque 而不是 Stack 或 LinkedList？
> - `Stack` 继承 `Vector`，每个方法都 `synchronized`，还暴露了 `get(i)/add(i, e)` 破坏栈语义。
> - `LinkedList` 每个元素一个 Node 对象，内存与缓存局部性差。
> - `ArrayDeque` 环形数组，两端操作 O(1)、无额外对象；代价是不允许 null。

> [!QUESTION] List.of 和 Collections.unmodifiableList 有什么区别？
> - `unmodifiableList` 是包装视图：不能通过它改，但底层列表改了它会跟着变，允许 null。
> - `List.of` 是独立的不可变实现（`ImmutableCollections.ListN` 等），不允许 null（`contains(null)` 也抛 NPE），内存更紧凑，`List.copyOf` 对其直接返回自身。

> [!QUESTION] PriorityQueue 建堆为什么是 O(n)？
> 自底向上对每个非叶节点做 `siftDown`：高度为 h 的节点约有 n/2^(h+1) 个，每个下沉代价 O(h)，求和 Σ h·n/2^(h+1) 收敛到 O(n)。逐个 `offer` 才是 O(n log n)。
