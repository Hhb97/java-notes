# HashMap 原理

> JDK 8+ 的实现：**数组 + 链表 + 红黑树**。

## 数据结构

```text
table[0]  → null
table[1]  → Node → Node → Node            （链表）
table[2]  → TreeNode（红黑树，链表长度 ≥ 8 且数组 ≥ 64）
...
table[n-1]
```

- `table` 是 `Node<K,V>[]`，长度始终是 **2 的幂**（默认 16）。
- 链表长度 ≥ 8 且数组容量 ≥ 64 时转红黑树；红黑树节点 ≤ 6 时退化回链表。

## put 流程

1. 计算 hash：`(h = key.hashCode()) ^ (h >>> 16)`，高 16 位参与运算以减少碰撞（**扰动函数**）。
2. 下标：`(n - 1) & hash`（容量是 2 的幂，等价于取模但更快）。
3. 该位置为空 → 直接放入。
4. 不为空：key 相同（`hash` 相等且 `==` 或 `equals`）→ 覆盖旧值；否则遍历链表 / 树，找到则覆盖，否则**尾插**。
5. 元素个数 `size > threshold`（容量 × 负载因子 0.75）→ **扩容**。

## 扩容 resize

- 容量翻倍，创建新数组，把节点迁移过去。
- JDK 8 的巧妙之处：因为容量翻倍，每个节点要么留在原下标，要么移动到 `原下标 + 旧容量`，只需看 `hash & oldCap` 那一位是 0 还是 1，不需要重新计算 hash。
- 扩容代价高：已知数量时用 `new HashMap<>((int) (n / 0.75f) + 1)` 预设容量。

## 为什么线程不安全

- 多线程 `put` 可能互相覆盖，丢数据；
- JDK 7 头插法在并发扩容时可能形成**环形链表**导致死循环；JDK 8 改为尾插，避免了死循环但仍会丢数据；
- 多线程请使用 `ConcurrentHashMap`。

## ConcurrentHashMap 简述

- JDK 7：分段锁（`Segment`）。
- JDK 8+：数组 + 链表 / 红黑树，**空桶用 CAS 写入，非空桶对头节点加 `synchronized`**，锁粒度细化到单个桶。
- 不允许 `null` 的 key 与 value（无法区分「不存在」与「值为 null」）。
- 计数使用类似 `LongAdder` 的分散 `CounterCell`，降低竞争。

## 对 key 的要求

```java
Map<List<String>, Integer> m = new HashMap<>();
List<String> k = new ArrayList<>(List.of("a"));
m.put(k, 1);
k.add("b");                 // key 的 hashCode 变了！
System.out.println(m.get(k));   // null —— 再也找不到
```

- key 应当**不可变**（`String`、`Integer`、`record` 都很合适）。
- 自定义 key 必须同时重写 `equals` 与 `hashCode`。

## 面试速答

| 问题 | 要点 |
| --- | --- |
| 为什么容量是 2 的幂？ | 用 `&` 代替取模；扩容时迁移位置只看一个 bit |
| 为什么负载因子是 0.75？ | 空间与时间的折中，泊松分布下碰撞概率低 |
| 链表为何转红黑树？ | 极端碰撞时把查找从 O(n) 降到 O(log n) |
| `HashMap` 与 `Hashtable` | 后者方法全加 `synchronized`、不允许 null，已过时 |
