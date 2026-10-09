---
level: 进阶
tags: [面试, 速查, 高频题, 系统设计, STAR]
summary: 面向 3~5 年以上 Java 后端岗位的跨领域速查表：每类高频问题给出一到两句答题要点和详解页面链接，并附系统设计答题框架与项目经历讲述模板。
---

# 面试高频速查

> [!ABSTRACT] 使用方式
> - 每个表格是「问题 → 答题要点 → 详见」；**先自己用话讲一遍**，卡壳的点再点「详见」回到对应笔记。
> - 资深面试不止于背结论，会追问**原理、边界、线上踩坑和取舍**；回答时尽量带上“**为什么**”和“**遇到过什么问题**”。
> - 页面底部有**系统设计题答题框架**和**项目经历 STAR 模板**。

## Java 核心

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| `String` 为什么不可变？`intern` 做什么 | `final` byte 数组 + 无修改方法；利于常量池、线程安全、缓存 hash。`intern` 把字符串放入常量池（JDK 7 起在堆） | [数组与字符串](#/java/basics/string) |
| `Integer` 缓存陷阱 | `-128~127` 范围内 `valueOf` 复用对象，`==` 为 true；其余新建；比较用 `equals` | [数据类型与变量](#/java/basics/types) |
| 重载与重写的绑定时机 | 重载编译期按参数静态类型；重写运行期按实际类型（vtable / invokevirtual） | [继承与多态](#/java/oop/inherit) |
| `equals` 与 `hashCode` 契约 | equals 相等则 hashCode 必须相等；否则 HashMap/Set 行为异常；key 应不可变 | [类与对象](#/java/oop/class) |
| 接口与抽象类选择 | 接口表能力、可多实现，有 default；抽象类表本质、可有状态与构造器；优先接口，需要共享状态/模板才用抽象类 | [接口与抽象类](#/java/oop/interface) |
| HashMap 底层与扩容 | 数组 + 链表 + 红黑树；扰动 hash、`(n-1)&hash`；负载因子 0.75；扩容翻倍，节点要么原位要么 +oldCap | [HashMap 源码剖析](#/java/api/hashmap) |
| ConcurrentHashMap 线程安全原理 | JDK 8：数组 + 桶头 `synchronized` + 空桶 CAS；协助扩容；`size` 用 CounterCell | [ConcurrentHashMap 源码剖析](#/java/api/chm) |
| 泛型擦除的影响 | 编译期检查、运行期擦除到上界；桥方法；不能 `new T()`、泛型数组；PECS 规则 | [泛型与类型擦除](#/java/api/generics) |
| 受检异常与最佳实践 | 受检需处理；不吞异常、保留 cause、统一异常处理；try-with-resources | [异常体系与最佳实践](#/java/api/exception) |
| 动态代理与反射 | JDK 代理基于接口，CGLIB 基于子类；反射有性能与封装问题；框架广泛使用 | [反射、注解与动态代理](#/java/api/reflect) |
| 零拷贝是什么 | 减少用户态/内核态拷贝与上下文切换：`sendfile`、`mmap`；Kafka、Netty 的基础 | [IO / NIO 与零拷贝](#/java/api/io) |
| Lambda 原理与 Stream 注意点 | `invokedynamic` + `LambdaMetafactory`；Stream 惰性、只能消费一次、并行流用公共池慎用 | [Lambda 与 Stream](#/java/modern/lambda) |
| Java 17/21 有哪些新特性 | record、sealed、模式匹配、文本块；21 虚拟线程、分代 ZGC | [Java 8–21 新特性](#/java/modern/features) |

## 并发与 JVM

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 线程状态与转换 | NEW/RUNNABLE/BLOCKED/WAITING/TIMED_WAITING/TERMINATED；`wait` 释放锁，`sleep` 不释放 | [线程与生命周期](#/java/concurrency/thread) |
| JMM、可见性与重排序 | 工作内存/主内存抽象；happens-before；volatile 保证可见性与有序性，不保证原子性 | [Java 内存模型与 volatile](#/java/concurrency/jmm) |
| `synchronized` 原理与锁升级 | monitor + Mark Word；偏向（JDK 15 起默认禁用）→ 轻量级 → 重量级 | [synchronized 与锁升级](#/java/concurrency/sync) |
| AQS 原理 | `state` + CLH 变体队列；独占/共享；Condition 条件队列；ReentrantLock、Semaphore 等基于它 | [AQS 与显式锁](#/java/concurrency/aqs) |
| 线程池参数与执行流程 | 核心线程 → 队列 → 最大线程 → 拒绝策略；有界队列；`ctl` 记录状态与线程数 | [线程池原理与调优](#/java/concurrency/pool) |
| 线程数怎么定 | CPU 密集 N+1；IO 密集 N×(1+等待/计算)；压测确定，隔离不同业务 | [线程池原理与调优](#/java/concurrency/pool) |
| CompletableFuture 要点 | 编排 API；务必传自定义线程池；处理异常与超时 | [并发工具与 CompletableFuture](#/java/concurrency/juc) |
| `ThreadLocal` 内存泄漏 | Entry key 弱引用、value 强引用；线程池中必须 `remove()` | [线程与生命周期](#/java/concurrency/thread) |
| JVM 内存结构 | 堆、元空间（共享）；栈、本地方法栈、PC（私有）；直接内存 | [运行时数据区与对象模型](#/java/jvm/memory) |
| 对象怎么判断可回收，GC 算法 | 可达性分析（GC Roots）；标记-清除/复制/整理；分代假说 | [垃圾回收算法与分代](#/java/jvm/gc) |
| G1 与 ZGC 的区别 | G1 Region + 可预测停顿；ZGC 着色指针 + 读屏障，停顿 <1ms（毫秒内） | [G1 与 ZGC 深入](#/java/jvm/collectors) |
| 双亲委派与打破 | 先委托父加载器保证核心类安全；SPI、Tomcat、热部署会打破 | [类加载与双亲委派](#/java/jvm/classloader) |
| JIT 与分层编译 | 解释器 + C1 + C2；热点探测；内联、逃逸分析、去优化 | [字节码与执行引擎](#/java/jvm/bytecode) |
| CPU 飙高 / OOM / 频繁 Full GC 排查 | `top -Hp` + `jstack`；MAT 分析 dump；GC 日志判断泄漏 vs 容量 | [线上调优与故障排查](#/java/jvm/tuning) |

## Spring 与持久层

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| Bean 生命周期 | 实例化 → 属性填充 → Aware → BPP before → init → BPP after（AOP 代理）→ 使用 → 销毁 | [IoC 容器与 Bean 生命周期](#/spring/ioc) |
| 三级缓存与循环依赖 | 解决 setter/字段注入的单例循环依赖；第三级为提前 AOP；构造器注入无解 | [IoC 容器与 Bean 生命周期](#/spring/ioc) |
| AOP 实现与自调用失效 | JDK/CGLIB 动态代理；this 调用绕过代理；通知顺序 | [AOP 与代理机制](#/spring/aop) |
| `@Transactional` 失效场景 | 自调用、非 public、异常被吞、未配 rollbackFor、非容器 Bean、传播行为误用 | [声明式事务原理](#/spring/tx) |
| Spring MVC 请求流程 | DispatcherServlet → HandlerMapping → HandlerAdapter → 参数解析 → 返回值处理 | [Spring MVC 请求链路](#/spring/mvc) |
| MyBatis 缓存与 `#{}`/`${}` | 一级缓存（会话）、二级缓存（Mapper）；`#{}` 预编译防注入，`${}` 拼接 | [MyBatis 原理与实践](#/spring/mybatis) |
| Spring Boot 自动配置 | `AutoConfiguration.imports` + `@Conditional`；用户 Bean 优先 | [Spring Boot 自动配置与启动](#/spring/boot) |
| 微服务核心组件 | 网关、注册配置中心、Feign、熔断限流、链路追踪、分布式事务 | [Spring Cloud 微服务全景](#/spring/cloud) |
| 怎么写好单元测试 | 金字塔；切片测试；mock 外部协作者；Testcontainers | [单元测试：JUnit 5 与 Mockito](#/java/eng/testing) |

## MySQL

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 一条 SQL 的执行流程 | 连接器 → 解析器 → 优化器 → 执行器 → 存储引擎；8.0 已无查询缓存 | [架构与 SQL 执行流程](#/mysql/architecture) |
| 为什么用 B+ 树 | 高扇出、矮树（3 层约千万~两千万行）、叶子链表利于范围；非叶子不存数据 | [B+ 树索引原理](#/mysql/index) |
| 聚簇索引、回表、覆盖索引 | 主键索引叶子存整行；二级索引存主键值需回表；覆盖索引免回表 | [B+ 树索引原理](#/mysql/index) |
| 最左前缀与索引失效 | 联合索引按列顺序排序；函数、隐式转换、前导 `%`、范围后列失效 | [B+ 树索引原理](#/mysql/index) |
| EXPLAIN 重点看什么 | type、key、key_len、rows、Extra（filesort、temporary、Using index） | [EXPLAIN 与 SQL 调优](#/mysql/optimize) |
| 深分页怎么优化 | 延迟关联（先查主键再回表）、游标式（`id > last`） | [EXPLAIN 与 SQL 调优](#/mysql/optimize) |
| 隔离级别与 MVCC | undo 版本链 + ReadView；RC 每次读新建，RR 首次读建；快照读与当前读 | [事务隔离与 MVCC](#/mysql/transaction) |
| 间隙锁与死锁 | RR 下 Next-Key Lock 防幻读；死锁排查看 `SHOW ENGINE INNODB STATUS` | [锁机制与死锁分析](#/mysql/lock) |
| redo / undo / binlog | redo 保持久性（WAL）；undo 保原子性与 MVCC；binlog 复制与恢复；两阶段提交 | [redo / undo / binlog](#/mysql/log) |
| 主从延迟与高可用 | 并行复制 + WRITESET；半同步；GTID；故障切换防脑裂 | [主从复制与高可用](#/mysql/replication) |
| 分库分表怎么做 | 分片键、路由、跨库问题、不停机扩容流程 | [分库分表实践](#/mysql/sharding) |

## Redis

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| Redis 为什么快 | 内存、单线程避免锁、IO 多路复用、高效数据结构；6.0 起 IO 多线程 | [线程模型与高性能原理](#/redis/overview) |
| 数据结构底层 | SDS、dict（渐进式 rehash）、quicklist/listpack、skiplist | [数据结构与底层编码](#/redis/types) |
| 过期与淘汰策略 | 惰性 + 定期删除；LRU（采样）/LFU；`maxmemory-policy` | [过期策略与内存淘汰](#/redis/expire) |
| RDB 与 AOF | 快照 fork + COW；追加日志三种刷盘；混合持久化 | [RDB 与 AOF](#/redis/persistence) |
| 哨兵与 Cluster | 哨兵：主观/客观下线 + 选主；Cluster：16384 槽、MOVED/ASK、Gossip | [主从、哨兵与 Cluster](#/redis/cluster) |
| 缓存一致性与三大问题 | Cache Aside：先更新库再删缓存；穿透/击穿/雪崩及对策 | [缓存设计与一致性](#/redis/cache) |
| 分布式锁 | `SET NX PX` + 唯一值 + Lua 释放；Redisson 看门狗；主从切换丢锁与 fencing | [分布式锁](#/redis/lock) |
| 限流、排行榜、延迟队列 | 令牌桶 Lua、ZSET、Stream | [高频场景实战](#/redis/practice) |

## PostgreSQL

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 与 MySQL 的架构差异 | 多进程（需连接池）、堆表 + 二级索引、MVCC 在堆里需 VACUUM、DDL 可事务回滚 | [架构、WAL 与存储结构](#/pg/architecture) |
| 表膨胀与 VACUUM | 死元组被长事务/复制槽阻止回收；调小 autovacuum scale factor；pg_repack | [MVCC、VACUUM 与锁](#/pg/mvcc) |
| 事务 ID 回卷 | 32 位 XID，靠 freeze 避免；监控 `age(datfrozenxid)` | [MVCC、VACUUM 与锁](#/pg/mvcc) |
| 索引类型选择 | B-tree 通用；GIN 用于 JSONB/数组/全文；GiST 几何；BRIN 海量有序 | [索引类型与查询优化](#/pg/index) |
| 看执行计划 | `EXPLAIN (ANALYZE, BUFFERS)`，预估与实际行数偏差、Rows Removed、溢出磁盘 | [索引类型与查询优化](#/pg/index) |
| 流复制与高可用 | WAL 流复制；synchronous_commit 级别；Patroni + etcd；复制槽风险 | [复制、高可用与实战](#/pg/ops) |

## 网络编程与物联网

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| Netty 线程模型 | 主从 Reactor；Channel 绑定唯一 EventLoop；耗时业务不阻塞 EventLoop | [Netty 源码：线程模型与 Pipeline](#/infra/netty-core) |
| 粘包拆包与 ByteBuf | 长度字段解码器；池化堆外内存；引用计数泄漏排查；写背压 | [Netty 实战：编解码、内存与调优](#/infra/netty-practice) |
| MQTT 的 QoS 与会话 | 0/1/2；QoS 是分段协商；持久会话 + 业务幂等 | [MQTT 协议详解](#/iot/mqtt) |
| 在线状态怎么做 | 遗嘱 + 保留消息，或 Broker 连接事件；以最新连接为准 | [MQTT 协议详解](#/iot/mqtt) |
| 百万设备接入 | EMQX 集群、共享订阅 + Kafka、重连风暴保护、内核调优 | [Broker 架构与集群（EMQX）](#/iot/broker) |
| 设备影子与 OTA | desired/reported/delta；A/B 分区、验签、灰度 | [IoT 平台架构与设备管理](#/iot/platform) |

## AI 应用

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 大模型应用的基本原理与成本构成 | 无状态、每次重传历史；Prefill/Decode；按输入输出 Token 计费；提示词缓存与小模型路由 | [大模型应用基础与 API 调用](#/ai/llm) |
| RAG 流程与为什么不直接微调 | 离线入库（解析、切分、向量化）+ 在线检索生成；RAG 管知识，微调管风格 | [RAG 原理与完整流水线](#/ai/rag) |
| RAG 效果差怎么排查 | 先看检索（Recall@K）：切分、混合检索、重排、查询改写；再看提示词与拒答 | [RAG 检索优化、向量库与评估](#/ai/rag-advanced) |
| HNSW 与向量库选型 | 多层近邻图、内存大；pgvector 起步，亿级用 Milvus；权限在检索阶段过滤 | [RAG 检索优化、向量库与评估](#/ai/rag-advanced) |
| Agent 与工作流的区别 | 控制流由模型决定 vs 代码写死；能用工作流就不用 Agent | [Agent、工具调用与 MCP](#/ai/agent) |
| 工具调用与 MCP | 模型只产出调用意图，代码执行并鉴权；MCP 把 M×N 集成变成 M+N | [Agent、工具调用与 MCP](#/ai/agent) |
| 提示注入怎么防 | 无法根治；最小权限、代码层鉴权、外部内容不可信、关键操作确认、避免致命三要素 | [LLM 应用工程化、安全与评测](#/ai/llmops) |
| KV Cache 与推理服务优化 | KV 显存 = 2×层×KV头×维×长度×字节；连续批处理、PagedAttention、前缀缓存、量化、投机解码 | [大模型原理与推理服务（KV Cache、vLLM、量化、微调）](#/ai/llm-internals) |
| Agent 上下文工程与长任务 | 压缩/按需加载/笔记/隔离；状态机+检查点；人在回路；轨迹评测 | [Agent 进阶：上下文工程、记忆与多智能体](#/ai/agent-deep) |
| 设计一个企业智能客服 | 路由+RAG+受限 Agent；精确数据走工具；写操作两阶段；延迟预算、配额与降级、评测门禁 | [案例：企业智能客服与知识库（RAG + Agent）设计详解](#/ai/case-kb) |
| Java 里怎么落地 | Spring AI（ChatClient/Advisor/VectorStore）或 LangChain4j（AiServices）；流式 SSE、幂等工具 | [Java 实战：Spring AI 与 LangChain4j](#/ai/spring-ai) |

## 大数据

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 事件时间与 Watermark | 事件时间可复现；Watermark 表示进度，多输入取最小；空闲分区要 withIdleness | [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core) |
| 迟到数据怎么处理 | Watermark 延迟 + allowedLateness + 侧输出；Sink 幂等 | [Flink 核心：时间、窗口与 Watermark](#/bigdata/flink-core) |
| Checkpoint 原理 | Barrier 异步分布式快照；对齐与非对齐；增量 Checkpoint；Savepoint 用于升级 | [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state) |
| 端到端 Exactly-Once | 可重放 Source + Checkpoint + 幂等/两阶段提交 Sink | [Flink 状态、Checkpoint 与 Exactly-Once](#/bigdata/flink-state) |
| 反压与数据倾斜 | 找第一个忙的算子；加盐两阶段聚合、Local-Global；外部系统批量/异步 | [Flink SQL、反压与性能调优](#/bigdata/flink-ops) |
| CDC 与全量增量一致 | 读 binlog；增量快照：Chunk 并行 + 水位修正，无需全局锁 | [CDC 与实时数仓架构](#/bigdata/cdc) |
| 实时数仓分层与 Lambda/Kappa | ODS/DWD/DWS/ADS；流批一体 + 湖仓取代双链路；对账 | [CDC 与实时数仓架构](#/bigdata/cdc) |
| ClickHouse 与 Doris | ClickHouse 单表聚合强、批量写入；Doris 主键更新、Join、高并发、MySQL 协议 | [OLAP：ClickHouse 与 Doris](#/bigdata/olap) |
| Flink 内部：Mailbox、反压、Key Group | 单线程 Mailbox 串行处理；信用流控产生反压；Key Group 决定状态分片，maxParallelism 不可随意改 | [Flink 内部机制：执行图、网络栈、内存与 Key Group](#/bigdata/flink-internals) |
| 设计电商实时数据平台 | 按延迟/状态/一致性拆作业；Paimon partial-update 宽表；CUMULATE+Upsert；同口径对账；湖仓回溯 | [案例：电商实时数据平台设计详解（CDC → Flink → 湖仓 → Doris）](#/bigdata/case-realtime) |
| Spark 倾斜与数据湖表格式 | AQE/加盐/广播；Iceberg 元数据树与原子提交；Paimon LSM 适合高频更新 | [Spark 与数据湖（Iceberg / Paimon）](#/bigdata/spark-lake) |

## 中间件

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 消息丢失、重复、顺序、积压 | 三环节保证不丢；幂等消费；分区有序；积压扩容/转储 | [消息队列核心问题](#/mw/mq) |
| Kafka 为什么快 | 顺序写、page cache、零拷贝、批量压缩、分区并行 | [Kafka 架构与存储](#/mw/kafka) |
| Kafka 如何不丢消息 | acks=all、min.insync.replicas、禁用 unclean 选举、手动提交 offset | [Kafka 副本与可靠性](#/mw/kafka-reliability) |
| ISR、HW、LEO | ISR 同步副本集；HW 对消费者可见水位；Leader Epoch 修复截断问题 | [Kafka 副本与可靠性](#/mw/kafka-reliability) |
| RocketMQ 事务消息 | 半消息 → 本地事务 → 提交/回滚 → 回查 | [RocketMQ 原理与事务消息](#/mw/rocketmq) |
| ES 为什么快、近实时 | 倒排索引 + FST；refresh 生成 segment（默认 1s） | [Elasticsearch 原理](#/mw/es) |
| ES 深分页与同步 | search_after + PIT；Canal 订阅 binlog + 幂等 + 对账 | [ES 实战与数据同步](#/mw/es-practice) |
| Dubbo 一次调用的链路 | 代理 → Filter → Cluster/Directory/Router/LoadBalance → Netty；requestId 配对异步响应；SPI 可插拔 | [Dubbo 架构与调用链路](#/mw/dubbo) |
| Dubbo 容错与重试陷阱 | 默认 Failover 重试 2 次；写接口 `retries=0` 并保证幂等；超时自内向外递减 | [Dubbo 集群容错与服务治理](#/mw/dubbo-practice) |

## 分布式

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| CAP / BASE | 分区时在 C 与 A 间取舍；最终一致；柔性事务 | [CAP、BASE 与一致性模型](#/distributed/theory) |
| Raft 选主与日志复制 | 随机超时选举、多数派提交、选举限制；脑裂靠多数派 | [Raft 与共识算法](#/distributed/consensus) |
| 分布式事务方案 | 2PC/TCC/Saga/本地消息表/事务消息/Seata AT，各有取舍 | [分布式事务](#/distributed/transaction) |
| 分布式 ID | 雪花、号段；时钟回拨处理；workerId 分配 | [分布式 ID 生成](#/distributed/id) |
| 限流熔断降级 | 令牌桶/滑动窗口；熔断三态；超时与重试预算 | [限流、熔断与降级](#/distributed/governance) |

## 网络与运维

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 三次握手四次挥手、TIME_WAIT | 同步序列号；TIME_WAIT 保证最后 ACK 与旧包消失；CLOSE_WAIT 多为没关连接 | [TCP/IP 与 HTTP(S)](#/infra/network) |
| epoll 与 Reactor | 红黑树 + 就绪链表；主从 Reactor | [IO 模型与 Netty](#/infra/netty) |
| Linux 排查命令 | USE 方法；top/vmstat/iostat/ss/lsof | [Linux 线上排查](#/infra/linux) |
| Nginx 负载均衡与高可用 | upstream 策略；Keepalived + VIP | [Nginx 与负载均衡](#/infra/nginx) |
| Docker 与 JVM | Namespace/Cgroups；容器感知；OOMKilled 与内存比例 | [Docker 容器化](#/infra/docker) |
| K8s 探针与优雅停机 | startup/readiness/liveness；preStop + 优雅停机 | [Kubernetes 核心概念](#/infra/k8s) |

## 系统设计

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 如何设计高并发系统 | 分层拦截、缓存、异步、拆分、限流降级、容量评估、压测 | [高并发系统设计方法论](#/design/method) |
| 秒杀系统 | 静态化、限流、Redis Lua 预扣、MQ 异步下单、防刷、对账 | [秒杀系统设计](#/design/seckill) |

## 系统设计题答题框架

<figure class="fig">
<svg viewBox="0 0 760 210" class="dg" role="img" aria-label="系统设计题答题的六个步骤">
<rect class="b1" x="14" y="50" width="108" height="76" rx="8"/>
<text class="tb" x="68" y="72" text-anchor="middle" dominant-baseline="middle">1 澄清需求</text>
<text class="ts" x="68" y="94" text-anchor="middle">功能 / 规模</text>
<text class="ts" x="68" y="110" text-anchor="middle">边界 / 约束</text>
<rect class="b1" x="136" y="50" width="108" height="76" rx="8"/>
<text class="tb" x="190" y="72" text-anchor="middle" dominant-baseline="middle">2 容量估算</text>
<text class="ts" x="190" y="94" text-anchor="middle">QPS / 存储</text>
<text class="ts" x="190" y="110" text-anchor="middle">带宽 / 读写比</text>
<rect class="b3" x="258" y="50" width="108" height="76" rx="8"/>
<text class="tb" x="312" y="72" text-anchor="middle" dominant-baseline="middle">3 总体设计</text>
<text class="ts" x="312" y="94" text-anchor="middle">架构图 / 主流程</text>
<text class="ts" x="312" y="110" text-anchor="middle">API / 数据模型</text>
<rect class="b3" x="380" y="50" width="108" height="76" rx="8"/>
<text class="tb" x="434" y="72" text-anchor="middle" dominant-baseline="middle">4 深入关键点</text>
<text class="ts" x="434" y="94" text-anchor="middle">瓶颈 / 热点</text>
<text class="ts" x="434" y="110" text-anchor="middle">一致性 / 并发</text>
<rect class="b5" x="502" y="50" width="108" height="76" rx="8"/>
<text class="tb" x="556" y="72" text-anchor="middle" dominant-baseline="middle">5 可用与扩展</text>
<text class="ts" x="556" y="94" text-anchor="middle">容灾 / 降级</text>
<text class="ts" x="556" y="110" text-anchor="middle">监控 / 扩容</text>
<rect class="b2" x="624" y="50" width="122" height="76" rx="8"/>
<text class="tb" x="685" y="72" text-anchor="middle" dominant-baseline="middle">6 取舍与演进</text>
<text class="ts" x="685" y="94" text-anchor="middle">方案对比</text>
<text class="ts" x="685" y="110" text-anchor="middle">分阶段落地</text>
<line class="l" x1="122" y1="88" x2="136" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="244" y1="88" x2="258" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="366" y1="88" x2="380" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="488" y1="88" x2="502" y2="88" marker-end="url(#arr)"/>
<line class="l" x1="610" y1="88" x2="624" y2="88" marker-end="url(#arr)"/>
<text class="ts" x="380" y="170" text-anchor="middle">全程主动沟通假设、说明取舍；先给能跑通的最小方案，再针对瓶颈逐层优化</text>
</svg>
<figcaption>图 1：系统设计题的通用答题顺序</figcaption>
</figure>

- **先问再答**：用户规模、读写比例、一致性要求、延迟目标、是否多机房；
- **估算要有依据**：日活 → 峰值 QPS = 日活 × 人均请求 ÷ 86400 × 峰值系数（常取 3~10）；存储 = 单条大小 × 条数 × 副本 × 保留期；
- **分层展开**：接入层 → 服务层 → 缓存 → 存储 → 异步/MQ，每层说清**为什么**这样放；
- **主动暴露风险**：热点、单点、数据不一致、级联故障，并给出对策；
- 参考实战：[高并发系统设计方法论](#/design/method)、[秒杀系统设计](#/design/seckill)。

## 项目经历 STAR 讲述模板

> [!TIP] 一个 2~3 分钟的项目回答
> 1. **S 背景**：业务是什么、规模多大（用数字）、你的角色；
> 2. **T 任务/挑战**：遇到什么具体难题（性能、稳定性、一致性）及目标指标；
> 3. **A 行动**：你做了什么**技术决策**，为什么不选其他方案（对比与取舍），遇到什么坑；
> 4. **R 结果**：量化收益（P99 从 800ms 降到 120ms、故障率下降、成本节约）与复盘。

示例骨架：

```text
背景：订单服务日均 500 万单，大促峰值 3000 QPS，P99 延迟 1.2s，偶发超卖。
挑战：库存扣减在数据库行锁上排队，同时下单链路过长。
行动：① 引入 Redis Lua 预扣库存并做对账；② 订单落库改 MQ 异步，削峰；③ 对下游调用加熔断和超时递减；
      ④ 通过压测定位到连接池与热点行，把库存分段。放弃了分布式锁方案：吞吐受限于锁。
结果：峰值 QPS 提升到 1.5 万，P99 降至 150ms，超卖为 0；沉淀出大促压测与降级预案。
```

回答时准备好**被深挖的下一层**：用到的每个组件，面试官都可能追问原理（Redis 单线程为何快、Kafka 如何不丢消息、MySQL 间隙锁、线程池参数怎么定），对应本笔记的各章。

## 复习建议

1. **按领域建立知识图谱**：先掌握整体（架构图、数据流），再深入细节；
2. 每个知识点能讲出：**是什么 → 为什么这么设计 → 有什么代价 → 线上遇到过什么问题**；
3. 并发、JVM、MySQL、Redis 要能**手画图**（线程池流程、内存区域、B+ 树、MVCC、主从复制）；
4. 把项目里的每个技术选型和性能优化整理成**问题-方案-结果**，配数据；
5. 模拟面试：对着对话讲一遍，录音回听，修正逻辑断点与口头禅。
