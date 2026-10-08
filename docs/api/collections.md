# 集合总览

## 体系结构

```text
Iterable
└── Collection
    ├── List     有序、可重复     ArrayList  LinkedList  (Vector)
    ├── Set      无序、不重复     HashSet  LinkedHashSet  TreeSet
    └── Queue    队列             ArrayDeque  PriorityQueue  LinkedList

Map（独立体系）  键值对          HashMap  LinkedHashMap  TreeMap  ConcurrentHashMap
```

## 如何选择

| 需求 | 选择 |
| --- | --- |
| 按下标读多、尾部追加 | `ArrayList`（默认首选） |
| 频繁在头尾增删、做栈 / 队列 | `ArrayDeque` |
| 元素去重、不关心顺序 | `HashSet` |
| 去重且保留插入顺序 | `LinkedHashSet` |
| 去重且排序 | `TreeSet` |
| 键值查找 | `HashMap` |
| 键值 + 保留插入 / 访问顺序（LRU） | `LinkedHashMap` |
| 键值 + 按键排序 | `TreeMap` |
| 多线程键值 | `ConcurrentHashMap` |
| 优先级出队 | `PriorityQueue` |

## ArrayList

- 底层 `Object[]`，默认容量 10，满了按 **1.5 倍**扩容（`Arrays.copyOf`）。
- 随机访问 O(1)；中间插入 / 删除 O(n)（需要移动元素）。
- 已知大小时用 `new ArrayList<>(n)` 避免多次扩容。
- 非线程安全。

## LinkedList

双向链表，增删头尾 O(1)，按下标访问 O(n)。实际项目里几乎总是 `ArrayList` / `ArrayDeque` 更快（CPU 缓存友好），LinkedList 很少是最优选择。

## Set

`HashSet` 内部就是一个 `HashMap`，元素作为 key。判重依赖 `hashCode()` + `equals()`，见 [HashMap 原理](#/api/hashmap)。

## 常用操作

```java
List<Integer> list = new ArrayList<>(List.of(3, 1, 2));
Collections.sort(list);                         // 或 list.sort(null)
list.sort(Comparator.reverseOrder());

Map<String, List<String>> groups = new HashMap<>();
groups.computeIfAbsent("a", k -> new ArrayList<>()).add("x");   // 分组惯用法

map.getOrDefault("k", 0);
map.merge("k", 1, Integer::sum);                // 计数惯用法

List<String> ro = List.of("a", "b");            // 不可变集合，修改抛 UnsupportedOperationException
```

## 快速失败（fail-fast）

遍历时若结构被其他方式修改，迭代器抛 `ConcurrentModificationException`（通过 `modCount` 检测）。解决：用迭代器自己的 `remove()`、`removeIf`，或使用并发集合（`CopyOnWriteArrayList`、`ConcurrentHashMap`）。

## 并发集合速览

| 类 | 特点 |
| --- | --- |
| `ConcurrentHashMap` | 分段 / CAS，高并发读写首选 |
| `CopyOnWriteArrayList` | 写时复制，读多写少 |
| `ConcurrentLinkedQueue` | 无锁非阻塞队列 |
| `ArrayBlockingQueue` / `LinkedBlockingQueue` | 阻塞队列，生产者-消费者 |

> `Collections.synchronizedList()` 只是给每个方法加锁，复合操作和遍历仍需自行同步。
