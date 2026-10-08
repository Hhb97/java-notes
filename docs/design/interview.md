# 面试高频速查

每条都给出「一句话结论」，细节点进对应章节。

## 语言基础

| 问题 | 答案要点 |
| --- | --- |
| `==` 与 `equals` | `==` 基本类型比值、引用类型比地址；`equals` 默认比地址，常被重写为比内容 |
| `String` 为什么不可变 | `final` 数组 + 无修改方法；利于常量池、线程安全、缓存 hash。见 [数组与字符串](#/basics/string) |
| `String` / `StringBuilder` / `StringBuffer` | 不可变 / 可变非线程安全 / 可变线程安全 |
| `Integer` 缓存 | `-128 ~ 127` 之间 `==` 为 true，其余新对象。见 [数据类型与变量](#/basics/types) |
| 重载与重写 | 编译期绑定看参数列表；运行期绑定看实际类型。见 [继承与多态](#/oop/inherit) |
| 接口与抽象类 | 接口表能力、多实现；抽象类表本质、可有状态。见 [接口与抽象类](#/oop/interface) |
| 值传递还是引用传递 | **只有值传递**，对象传的是引用的值 |
| 重写 `equals` 为何要重写 `hashCode` | 保证相等对象哈希相同，否则 HashMap / HashSet 失效 |
| 受检与非受检异常 | 受检需强制处理；`RuntimeException` 及子类不强制。见 [异常处理](#/api/exception) |

## 集合

| 问题 | 答案要点 |
| --- | --- |
| `ArrayList` vs `LinkedList` | 数组随机访问快；链表头尾增删快，实际首选 ArrayList |
| `ArrayList` 扩容 | 默认 10，1.5 倍，`Arrays.copyOf` |
| HashMap 底层 | 数组 + 链表 + 红黑树，哈希扰动、`(n-1)&hash`、0.75 负载因子。见 [HashMap 原理](#/api/hashmap) |
| HashMap 线程安全吗 | 不安全；用 `ConcurrentHashMap`（CAS + synchronized 桶头锁） |
| `HashSet` 去重原理 | 底层是 HashMap，依赖 `hashCode` + `equals` |
| fail-fast 与 fail-safe | `modCount` 检测并抛 CME / 拷贝或弱一致迭代（`CopyOnWrite`、`ConcurrentHashMap`） |

## 并发

| 问题 | 答案要点 |
| --- | --- |
| 创建线程的方式 | `Thread`、`Runnable`、`Callable+Future`、线程池、虚拟线程。见 [线程基础](#/concurrency/thread) |
| `sleep` vs `wait` | `sleep` 不释放锁属于 Thread；`wait` 释放锁、需在 synchronized 内、属于 Object |
| `synchronized` 原理 | monitor + Mark Word，锁升级。见 [synchronized 与 volatile](#/concurrency/sync) |
| `volatile` 作用 | 可见性 + 禁止重排序，**不保证原子性** |
| CAS 的问题 | ABA、自旋开销、单变量 |
| 线程池参数与流程 | 核心线程 → 队列 → 最大线程 → 拒绝策略。见 [线程池](#/concurrency/pool) |
| 为什么不用 `Executors` | 无界队列 / 无界线程数会 OOM |
| AQS 是什么 | `state` + CLH 队列，锁与同步器的框架。见 [JUC 并发工具](#/concurrency/juc) |
| 死锁条件与避免 | 互斥、持有等待、不可剥夺、循环等待；统一加锁顺序、超时 |
| `ThreadLocal` 泄漏 | key 是弱引用、value 强引用，线程池中要 `remove()` |

## JVM

| 问题 | 答案要点 |
| --- | --- |
| 运行时数据区 | 堆、元空间（线程共享）；栈、本地方法栈、PC（线程私有）。见 [运行时内存结构](#/jvm/memory) |
| 如何判断对象可回收 | 可达性分析（GC Roots） |
| 分代与 GC 算法 | 新生代复制，老年代标记整理 / 清除。见 [垃圾回收](#/jvm/gc) |
| G1 与 CMS | G1 分 Region、可预测停顿、JDK 9+ 默认；CMS 已移除 |
| 双亲委派 | 先委托父加载器；保证安全与唯一。见 [类加载机制](#/jvm/classloader) |
| OOM 怎么排查 | `HeapDumpOnOutOfMemoryError` + MAT。见 [调优与问题排查](#/jvm/tuning) |
| 类初始化过程 | 加载、验证、准备、解析、初始化 |

## Spring

| 问题 | 答案要点 |
| --- | --- |
| IoC / DI | 容器负责创建并注入对象，降低耦合。见 [Spring IoC 与 AOP](#/eng/spring) |
| Bean 作用域 | singleton（默认）、prototype、request、session |
| 单例 Bean 线程安全吗 | 容器不保证；Bean 应无状态 |
| AOP 实现 | JDK 动态代理 / CGLIB |
| 事务失效场景 | 自调用、非 public、异常被吞、未配置 rollbackFor |
| 自动配置原理 | `@EnableAutoConfiguration` + `AutoConfiguration.imports` + 条件注解。见 [Spring Boot 入门](#/eng/springboot) |
| 循环依赖 | 三级缓存解决 setter / 字段注入；构造器注入不行 |

## 复习建议

1. 把每个「答案要点」自己**用话讲一遍**，卡壳的地方回到对应章节。
2. 并发与 JVM 要能手画图（线程池流程、内存结构、GC 分代）。
3. 结合项目经验回答，比背书更有说服力：「我们在 XX 场景遇到过 YY 问题，用 ZZ 解决」。
