---
level: 进阶
tags: [面试, 速查, 高频题, 系统设计, STAR]
summary: 面向 3~5 年以上 Java 后端岗位的跨领域速查表（含安全、数据库、DDD 与事件驱动、可观测与发布、操作系统/网络/算法、AI 等）：每类高频问题给出一到两句答题要点和详解页面链接，并附系统设计答题框架与项目经历讲述模板。
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
| OpenFeign 超时重试怎么配才不雪崩 | 显式超时且自内向外递减；写接口不自动重试用幂等键；重试一层；熔断+舱壁；透传 deadline | [OpenFeign 深入：调用链、超时重试与上下文透传](#/spring/cloud-feign) |
| Spring Cloud Gateway 的坑 | WebFlux 事件循环不能阻塞；读 body 需缓存重包装；DataBuffer 释放；动态路由先校验再灰度 | [Spring Cloud Gateway 深入：过滤器链、动态路由与响应式陷阱](#/spring/cloud-gateway) |
| Sentinel 与 Resilience4j 怎么选、规则怎么管 | Sentinel 规则丰富+控制台+热点/系统保护；R4j 轻量模块化；规则持久化到 Nacos；业务异常不计熔断 | [熔断限流实战：Sentinel 与 Resilience4j](#/spring/cloud-resilience) |
| 配置中心动态刷新与全链路灰度 | RefreshScope 重建与边界；染色→标签透传→选路→回退；数据/缓存/消息兼容；回滚优先 | [配置管理与全链路灰度](#/spring/cloud-config-gray) |
| 微服务认证授权怎么分工 | 网关认证+粗授权，服务做资源级授权；JWT 校验完整；令牌交换；mTLS 服务身份；防 IDOR | [微服务安全：网关鉴权、服务间认证与令牌传递](#/spring/cloud-security) |
| 微服务如何做可观测、trace 为什么断 | Observation 一次埋点；traceparent 传播；线程池/消息/手建客户端是断点；标签基数；liveness/readiness 分离 | [微服务可观测：Micrometer、链路追踪与排障](#/spring/cloud-observability) |
| Boot 3 升级与虚拟线程 | JDK17+、jakarta、Security 6；分步灰度升级；虚拟线程瓶颈转移到连接池与下游，注意 pinning | [微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍](#/spring/cloud-evolution) |
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
| Redis Cluster 怎么扩容、怎么升级、故障转移的条件 | 加空节点→按槽 MIGRATE 迁移（大 key 阻塞）；先升副本+手动 failover；需多数主投票；full-coverage 取舍 | [Redis Cluster 生产运维：规划、扩缩容与故障处理](#/redis/cluster-ops) |
| 大 key、热 key 怎么发现与治理 | 副本限速 SCAN+MEMORY USAGE/离线 RDB；拆分分桶、UNLINK；热 key 本地缓存+打散+读写分离；扩分片对热 key 无效 | [Redis 大 key 与热 key 治理](#/redis/bigkey) |
| Redis 内存怎么优化 | 内存画像；补 TTL；小 key 合并 Hash（紧凑编码）；精简+二进制序列化+压缩；碎片率与 COW 余量 | [Redis 内存优化与容量治理](#/redis/memory) |
| Redis 变慢/超时怎么排查、怎么加固 | SLOWLOG/LATENCY/fork/AOF fsync/swap；backlog 与输出缓冲；ACL+内网+TLS+禁危险命令 | [Redis 故障排查与安全加固](#/redis/troubleshooting) |
| 多团队共用 Redis 怎么治理 | 用法边界；key/TTL/命令规范；统一 SDK（超时/连接池/重试/降级）；缓存与存储分集群；Key 画像巡检 | [Redis 使用规范与平台化治理](#/redis/governance) |

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
| MQTT 报文结构与剩余长度编码 | 固定报头类型+标志；剩余长度 1~4 字节变长；PUBREL/SUBSCRIBE 标志必须 0010；Packet ID 唯一与复用 | [MQTT 报文详解：从字节看协议](#/iot/mqtt-wire) |
| QoS1/2 状态机与重传规则 | QoS1 发送方存报文至 PUBACK；QoS2 接收方记 ID 到 PUBREL；仅重连后重发；逐跳 QoS=min | [QoS、会话与 Broker 语义：状态机、离线队列与共享订阅](#/iot/mqtt-qos-session) |
| MQTT 5.0 新特性 | 属性/原因码；会话与消息过期；Will Delay；Receive Maximum；Topic Alias；请求响应；共享订阅；增强认证 | [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5) |
| 设备在线却收不到指令、保活怎么设 | NAT 老化/半开连接；Keep Alive<NAT 超时；PINGRESP 超时检测；重连退避+抖动；应用层指令闭环 | [弱网、可靠性、安全与排障：MQTT 工程实践](#/iot/mqtt-practice) |
| MQTT 与 CoAP/MQTT-SN/Sparkplug 的区别与选型 | TCP 发布订阅 vs UDP REST；MQTT-SN 网关+主题 ID；Sparkplug 出生/死亡证书；QUIC 连接迁移 | [MQTT 协议生态与选型：MQTT-SN、CoAP、Sparkplug B 与 QUIC](#/iot/mqtt-ecosystem) |

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
| 提示词怎么写、结构化输出怎么保证 | 目标/约束/格式/示例分层；Schema 约束输出+业务校验+带错误重试+兜底；提示词版本化并过评测 | [提示词工程进阶与结构化输出](#/ai/prompt-eng) |
| 文档解析对 RAG 的影响、表格与图片怎么处理 | 解析决定上限；版面分析/OCR 分级；表格带表头或入结构化库；图片转文字或多模态嵌入；ACL 入元数据 | [文档解析与多模态 RAG（PDF、表格、OCR、图片）](#/ai/rag-parsing) |
| MCP 的原语、传输与安全 | Tools/Resources/Prompts；stdio 与 Streamable HTTP；工具投毒、令牌透传、混淆代理；网关治理 | [MCP 深入：协议、服务端开发与安全](#/ai/mcp-deep) |
| 工作流与 Agent 怎么选、有哪些编排模式 | 提示链/路由/并行/编排者-执行者/评估-优化；状态图+检查点+中断；能工作流就不用 Agent | [工作流与 Agent 选型：编排模式与状态图](#/ai/agent-workflow) |
| 什么时候微调、LoRA 怎么用 | RAG 管知识、微调管风格与稳定性；数据质量优先；LoRA/QLoRA；防遗忘；评测对比基线 | [微调实战：数据、LoRA/QLoRA、偏好对齐与评估](#/ai/finetune) |
| 怎么评测 LLM 应用 | 评测集分层+盲测；检索/生成/端到端指标；LLM 评审偏差与校准；CI 回归门禁；线上回流 | [评测体系实战：数据集、LLM 评审与回归门禁](#/ai/eval) |
| 设计 Text-to-SQL 数据分析助手 | 语义层定口径；Schema 检索；AST 校验与权限改写；只读沙箱；执行准确率评测；澄清歧义 | [案例：Text-to-SQL 数据分析助手设计详解](#/ai/case-text2sql) |
| 设计代码助手与自动 Code Review | 仓库符号索引+上下文装配；确定性工具先行；噪声控制；沙箱内验证闭环；PR 人审；采纳率指标 | [案例：代码助手与自动 Code Review 设计详解](#/ai/case-codeagent) |

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
| gRPC 相比 REST 的优缺点 | Protobuf 二进制 + HTTP/2 多路复用 + 强类型代码生成 + 四种流；缺点：可读性差、浏览器需 grpc-web、对 L4 LB 不友好 | [gRPC 与 Protobuf](#/mw/grpc) |
| Protobuf 如何保证兼容 | 字段编号标识数据；只增不改；删除字段用 reserved 且编号永不复用；CI 用 buf breaking 检查 | [gRPC 与 Protobuf](#/mw/grpc) |
| gRPC 在 K8s 里为什么负载不均 | HTTP/2 单长连接复用，L4 只在建连时分配；用 Headless + 客户端 round_robin 或 L7 代理，服务端设最大连接存活 | [gRPC 与 Protobuf](#/mw/grpc) |
| gRPC 的 Deadline 与重试 | 每个调用必须设 Deadline 并向下游传播；只对幂等方法与 UNAVAILABLE 重试，带退避与重试预算 | [gRPC 与 Protobuf](#/mw/grpc) |
| RabbitMQ 怎么路由、怎么保证不丢 | Exchange/Binding/Queue；四种交换机；发布确认+持久化+仲裁队列+手动 ack+死信重试 | [RabbitMQ 原理与可靠性（AMQP、仲裁队列与死信）](#/mw/rabbitmq) |
| Kafka 分区数怎么定、Rebalance 与积压怎么治 | 吞吐/并行度/增长取最大；分区只增不减；协作式+静态成员；Lag 看时间维度 | [Kafka 生产运维：容量规划、Rebalance 治理与故障排查](#/mw/kafka-ops) |
| Kafka Connect、Streams 与 Schema Registry | Connector/Task/Worker；流表对偶与变更日志；兼容性规则与升级顺序 | [Kafka 生态：Connect、Streams 与 Schema Registry](#/mw/kafka-ecosystem) |
| Pulsar 与 Kafka 的区别 | 存算分离（Broker+BookKeeper）；订阅模式；多租户；分层存储；跨地域复制 | [Pulsar 架构与存算分离](#/mw/pulsar) |
| 注册中心与配置中心怎么设计 | 偏 AP + 本地缓存；剔除窗口与优雅下线；保护阈值；配置灰度、回滚与审计 | [Nacos 与服务注册发现、配置中心](#/mw/registry) |
| ZooKeeper 与 etcd、分布式锁的正确性 | znode+Watch / MVCC+Lease；顺序临时节点避免羊群；fencing token 防僵尸持有者 | [分布式协调：ZooKeeper 与 etcd](#/mw/coordination) |
| ES 集群变红怎么排查、日志场景怎么降本 | health→未分配分片→allocation explain；数据流+ILM+冷热分层 | [ES 集群运维：生命周期、故障排查与日志场景](#/mw/es-ops) |
| 多团队共用消息队列怎么治理 | 台账与负责人、模板与审批、配额隔离、统一 SDK、轨迹与重放、积压告警 | [消息队列平台化与治理](#/mw/mq-governance) |

## 分布式

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| CAP / BASE | 分区时在 C 与 A 间取舍；最终一致；柔性事务 | [CAP、BASE 与一致性模型](#/distributed/theory) |
| Raft 选主与日志复制 | 随机超时选举、多数派提交、选举限制；脑裂靠多数派 | [Raft 与共识算法](#/distributed/consensus) |
| 分布式事务方案 | 2PC/TCC/Saga/本地消息表/事务消息/Seata AT，各有取舍 | [分布式事务](#/distributed/transaction) |
| 分布式 ID | 雪花、号段；时钟回拨处理；workerId 分配 | [分布式 ID 生成](#/distributed/id) |
| 限流熔断降级 | 令牌桶/滑动窗口；熔断三态；超时与重试预算 | [限流、熔断与降级](#/distributed/governance) |
| 分布式时钟、HLC 与 TrueTime | 物理时钟漂移/回拨；单调时钟度量间隔；Lamport/向量时钟/HLC；TSO vs TrueTime commit-wait | [分布式时钟：物理时间、逻辑时钟与 HLC](#/distributed/clock) |
| Paxos 如何保证安全、与 Raft 的区别 | 两阶段+多数派相交+采用最大编号已接受值；Multi-Paxos 稳定领导者与日志槽；Raft 连续日志与选主约束 | [Paxos 与共识算法族：原理、变体与对比](#/distributed/paxos) |
| 主从/多主/无主复制与复制延迟 | 同步/半同步/异步；读自己的写、单调读；多主冲突（LWW/版本向量/CRDT）；Quorum 不等于强一致 | [复制与一致性：主从、多主与无主](#/distributed/replication) |
| 分片策略与一致性哈希 | 范围/哈希/槽位/一致性哈希+虚拟节点；不要 mod N；再平衡；热点加盐；二级索引 | [分片、一致性哈希与再平衡](#/distributed/partitioning) |
| 故障检测、脑裂与 fencing | 无法区分慢与死；SWIM/Phi Accrual；租约+fencing token；多数派/STONITH；重试风暴与亚稳态 | [故障模型、故障检测与脑裂](#/distributed/fault) |
| 幂等怎么设计 | 发起方稳定幂等键；唯一约束/去重表同事务；状态机条件更新；处理中并发；超时未知三态+对账 | [幂等设计与重试：幂等键、去重表与超时未知](#/distributed/idempotent) |
| 多处写入如何保证数据一致 | 单一写入源+派生数据；Outbox/CDC；对账分类与修复原则；迁移双写+影子读 | [数据一致性实战：双写、对账与修复](#/distributed/consistency-practice) |

## 网络与运维

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 三次握手四次挥手、TIME_WAIT | 同步序列号；TIME_WAIT 保证最后 ACK 与旧包消失；CLOSE_WAIT 多为没关连接 | [TCP/IP 与 HTTP(S)](#/infra/network) |
| epoll 与 Reactor | 红黑树 + 就绪链表；主从 Reactor | [IO 模型与 Netty](#/infra/netty) |
| Linux 排查命令 | USE 方法；top/vmstat/iostat/ss/lsof | [Linux 线上排查](#/infra/linux) |
| Nginx 负载均衡与高可用 | upstream 策略；Keepalived + VIP | [Nginx 与负载均衡](#/infra/nginx) |
| Docker 与 JVM | Namespace/Cgroups；容器感知；OOMKilled 与内存比例 | [Docker 容器化](#/infra/docker) |
| K8s 探针与优雅停机 | startup/readiness/liveness；preStop + 优雅停机 | [Kubernetes 核心概念](#/infra/k8s) |
| 监控该看哪些指标 | 黄金信号（延迟/流量/错误/饱和度）；服务用 RED，资源用 USE；加业务指标 | [指标监控](#/infra/obs-metrics) |
| Prometheus 四种指标类型与分位数 | Counter/Gauge/Histogram/Summary；分位数用 Histogram 桶聚合后 histogram_quantile，不能对各实例 P99 取平均 | [指标监控](#/infra/obs-metrics) |
| 什么是高基数，怎么避免 | series 数 = 标签取值乘积；别把 userId/URL 当标签；用路由模板，高基数放日志或链路 | [指标监控](#/infra/obs-metrics) |
| 链路追踪原理与断链 | Trace/Span + traceparent 跨服务传递；线程池、MQ、异步要做上下文传播；头部低比例 + 尾部保错保慢采样 | [链路追踪、日志与告警](#/infra/obs-trace) |
| SLO 与燃烧率告警 | SLI→SLO→错误预算；长短窗口同时超燃烧率阈值才告警；预算耗尽暂停发布 | [链路追踪、日志与告警](#/infra/obs-trace) |
| 线上变慢怎么排查 | 指标定范围→看变更与依赖饱和度→链路找慢 span→traceId 查日志；先止血后定位 | [链路追踪、日志与告警](#/infra/obs-trace) |
| CI/CD 与一次构建处处部署 | 构建一次镜像，用摘要晋级各环境，差异靠配置注入；质量门禁、快速失败、可追溯 | [CI/CD 流水线与 GitOps](#/infra/cicd) |
| GitOps 是什么 | Git 为唯一事实来源，ArgoCD 拉取并持续对账；回滚即 git revert；集群凭据不出集群 | [CI/CD 流水线与 GitOps](#/infra/cicd) |
| 灰度、蓝绿、滚动怎么选 | 滚动省资源但回滚慢；蓝绿秒级回滚但双倍资源；金丝雀渐进放量 + 指标对比，适合核心高风险变更 | [发布策略](#/infra/release) |
| 数据库变更如何可回滚发布 | 扩展-收缩：加列→双写→回填→切读→删旧列，每步兼容新旧版本；大表 DDL 用 gh-ost | [发布策略](#/infra/release) |
| 特性开关的价值与风险 | 部署与发布解耦、关开关即回滚；风险是僵尸开关与组合爆炸，需负责人与过期时间 | [发布策略](#/infra/release) |

## 系统设计

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 如何设计高并发系统 | 分层拦截、缓存、异步、拆分、限流降级、容量评估、压测 | [高并发系统设计方法论](#/design/method) |
| 秒杀系统 | 静态化、限流、Redis Lua 预扣、MQ 异步下单、防刷、对账 | [秒杀系统设计](#/design/seckill) |
| 设计订单、支付与对账系统 | 订单与支付单分离；状态机条件更新；幂等键；回调验签落库秒回；主动查询补偿；本地消息表；复式记账 + T+1 对账 | [订单支付对账案例](#/design/case-payment) |
| 支付超时结果未知怎么办 | 保持 PAYING 不当失败；回调与主动查询共用幂等逻辑；关单前先查渠道；多付自动退款 | [订单支付对账案例](#/design/case-payment) |
| 设计即时通讯 IM | 接入层有状态业务层无状态；路由表；先存储后投递；ACK + 会话 seq + 去重；拉取兜底；小群写扩散大群读扩散 | [IM 案例](#/design/case-im) |
| IM 消息如何不丢不重不乱序 | 服务端 ACK 前已持久化；client_msg_id 幂等；会话内单调 seq，空洞补拉；离线按 last_seq 增量拉 | [IM 案例](#/design/case-im) |
| 设计短链接服务 | 号段发号器 + Base62 + 可逆混淆（不冲突、防枚举）；302 保留统计；本地缓存 + Redis + 布隆过滤器；点击事件异步写 Kafka | [短链接服务案例](#/design/case-shorturl) |
| 短链用 301 还是 302 | 301 被浏览器长期缓存，统计与下线失效；302/307 每次经服务端，便于统计管控，靠缓存扛压力 | [短链接服务案例](#/design/case-shorturl) |
| 设计 Feed 流 | 推（写扩散）/拉（读扩散）/混合：普通推活跃粉丝，大 V 读时拉；收件箱存 ID，游标分页，读时过滤取关与删帖 | [Feed 流与排行榜案例](#/design/case-feed) |
| 设计热门排行榜 | Redis ZSET；时间衰减热度分；周期榜按 key 拆分；大榜分片归并只维护 Top N；同分稳定排序；榜单可由事件重建 | [Feed 流与排行榜案例](#/design/case-feed) |
| 设计搜索系统 | CDC→MQ→索引构建→ES（幂等+外部版本）；别名零停机重建；查询理解→召回→粗排→精排→重排；search_after 深分页 | [搜索系统案例](#/design/case-search) |
| 搜索相关性怎么调与评估 | BM25 + 业务信号 function_score/LTR；NDCG 线下回归 + 线上 A/B；零结果词与 badcase 驱动词典 | [搜索系统案例](#/design/case-search) |
| 设计分布式任务调度 | 调度中心 + 执行器；行锁 SKIP LOCKED 抢占保证只触发一次；分片广播；misfire 与重试；任务幂等；时间轮预读 | [分布式任务调度案例](#/design/case-scheduler) |
| 压测与容量估算 | 开环阶梯压测找满足 SLO 的拐点；Little 定律估并发；水位 60~70% + N+1 冗余 + 依赖木桶；警惕协调遗漏 | [压测与容量规划](#/design/eng-loadtest) |
| 全链路压测怎么不污染数据 | 流量染色全链路透传；影子库/表/Key/Topic；第三方挡板；占比上限与一键熔断；统计排除压测流量 | [压测与容量规划](#/design/eng-loadtest) |
| 混沌工程与故障演练 | 稳态假设→控制爆炸半径→渐进注入→中止条件；桌面推演→预发→生产→GameDay；演练验证预案与降级开关 | [稳定性工程](#/design/eng-chaos) |
| 重试风暴怎么避免 | 多层重试乘法放大；只在边缘层重试，其余快速失败；重试预算+退避抖动+熔断；操作幂等 | [稳定性工程](#/design/eng-chaos) |
| 线上严重故障怎么处理 | 分级拉群定角色；先看变更并回滚/降级/切流止血；IC 统一授权记录；恢复后验证数据；无责复盘 | [事故响应与复盘](#/design/eng-postmortem) |
| 复盘怎么写才有价值 | 时间线、根因（5 Why 到系统缺陷）、贡献因素、做得好与运气成分；改进项 SMART 有负责人期限并演练验证 | [事故响应与复盘](#/design/eng-postmortem) |
| 技术方案文档与 ADR | 问题→目标/非目标→≥2 备选及取舍→详细设计含失败路径→风险回滚；ADR 记录决策背景与后果入库 | [技术方案与 ADR](#/design/eng-adr) |
| 设计 API 网关 | 数据面与控制面分离、配置热推原子切换；过滤器链先便宜后昂贵（黑名单→限流→鉴权→路由→灰度→LB→熔断重试）；全异步非阻塞 | [API 网关案例](#/design/case-gateway) |
| 网关性能事故与内部头可信 | EventLoop 里同步调用外部依赖会全线卡死；入口清洗内部头，向内注入可验证身份，后端仍二次校验（零信任） | [API 网关案例](#/design/case-gateway) |
| 网关限流与失败语义 | 多维度分层限流；本地令牌桶 + Redis 批量预取；Redis 不可用 fail-open 还是 fail-closed 要事先定；429 + Retry-After | [API 网关案例](#/design/case-gateway) |
| 设计推荐系统 | 离线/近线/在线三层；召回(万)→粗排(千)→精排(百)→重排(几十)；多路召回 + 多目标融合 + 重排多样性；日志闭环 | [推荐系统案例](#/design/case-recsys) |
| 双塔召回与特征一致性 | 用户/物品向量 + ANN(HNSW)；物品向量离线建索引；线上特征落盘作训练样本避免训练服务不一致；防特征穿越 | [推荐系统案例](#/design/case-recsys) |
| 推荐冷启动与评估 | 新用户热门+上下文+兴趣引导，新物品内容召回+流量池赛马+bandit 探索；离线 GAUC/NDCG，线上 A/B 加护栏指标 | [推荐系统案例](#/design/case-recsys) |
| 设计分布式对象存储 | 元数据与数据分离；先写数据后原子提交元数据；多副本 + 跨机架放置；校验和 + scrub + 限速修复；预签名直传 | [分布式对象存储案例](#/design/case-objectstore) |
| 三副本与纠删码怎么选 | 副本读快修复简单但 3x；EC 如 RS(6,3) 仅 1.5x，但读重建/修复放大、小对象不适合；先副本后冷转 EC | [分布式对象存储案例](#/design/case-objectstore) |
| 海量小文件与大文件上传 | 小文件追加合并大卷（元数据记卷/偏移/长度）；大文件分片并发上传 + ListParts 断点续传 + Complete 零拷贝合并 | [分布式对象存储案例](#/design/case-objectstore) |
| 秒传与对象 GC 的风险 | 秒传要 proof of possession 防越权探测；GC 两阶段删除 + 安全窗口，误回收等于永久丢数据 | [分布式对象存储案例](#/design/case-objectstore) |
| 设计实时推送系统 | 在线长连接 + 离线厂商通道多通道降级；任务分片幂等；多优先级队列；频控免打扰；推送轻量 + 拉取详情 | [实时消息推送案例](#/design/case-push) |
| 全员广播给亿级用户 | 不逐用户查路由；消息广播到每个接入节点本地遍历连接；离线按设备令牌分片限速交通道网关 | [实时消息推送案例](#/design/case-push) |
| 推送后的点击惊群怎么办 | 广播分批匀速、客户端随机延迟拉取、接口缓存预热 CDN 化、限流降级 | [实时消息推送案例](#/design/case-push) |
| 高并发写同一行/同一 Key 怎么办 | 单行吞吐≈1/持锁时间；拆分（分段计数/库存/子账户）、合并写、异步削峰、预分配、按 Key 串行化、限流降级；幂等+对账兜底 | [高并发写入与热点治理](#/design/case-highwrite) |
| 点赞计数怎么设计 | 关系表唯一键作事实来源；Redis 去重+原子 INCR；MQ 按内容聚合批量落库；爆款 Key 分段；定期对账；允许短暂不精确 | [高并发写入与热点治理](#/design/case-highwrite) |
| 抢红包怎么设计 | 发时预拆分（二倍均值）存 Redis List 并落库；Lua 原子判重+弹出份额；抢到与入账解耦（流水先行批量汇总）；过期退回、对账 | [高并发写入与热点治理](#/design/case-highwrite) |
| 热点账户/热点库存怎么提升吞吐 | 账户：流水先行批量汇总、子账户拆分；库存：条件更新→分段库存→Redis 预扣异步落库→排队合并/单线程 | [高并发写入与热点治理](#/design/case-highwrite) |
| 设计直播系统 | 媒体面（推流→转码→CDN→播放）与互动面解耦；RTMP 推流+FLV/HLS 观看+WebRTC 连麦；GOP 缓存秒开；多 CDN 调度 | [直播系统案例](#/design/case-live) |
| 高可用架构怎么设计 | 可用性串并联计算；SLO/错误预算；跨故障域冗余+N+1容量；RTO/RPO；变更是最大风险 | [高可用架构设计：可用性计算、故障域与容灾](#/design/arch-availability) |
| 异地多活怎么做 | 单元化：分区键路由+单元封闭；分区/全局/强一致三类数据；切换隔离先于接管；回切 | [异地多活与单元化架构](#/design/arch-multi-active) |
| 六边形/整洁架构与模块化单体 | 依赖倒置、端口与适配器；ArchUnit 守护；先模块化再拆服务；绞杀者+防腐层 | [分层、六边形与整洁架构：应用内部的边界](#/design/arch-clean) |
| 多租户 SaaS 怎么设计 | 共享表/Schema/独立库分层混合；租户上下文全链路+RLS；噪声邻居治理；计量计费与生命周期 | [多租户 SaaS 架构：隔离、治理与运营](#/design/arch-multitenant) |
| API 设计与版本兼容 | REST 语义与幂等；游标分页；统一错误模型；只增不改；弃用流程；签名与 Webhook | [API 设计与演进：REST、兼容性与开放平台](#/design/arch-api) |
| 设计附近的人/打车派单 | 网格空间索引+邻格；只存最新位置；ETA 精排+批量匹配；原子占用防重复派单；热点分片 | [案例：LBS 附近的人与打车派单设计详解](#/design/case-lbs) |
| 设计在线协作文档 | OT 中心服务器 vs CRDT 唯一 ID；房间路由串行化；日志+快照；Awareness 与文档分离；离线合并 | [案例：在线协作文档（OT 与 CRDT）设计详解](#/design/case-collab) |
| 直播协议怎么选与首屏秒开 | RTMP 1~3s、FLV 低延迟主流、HLS 兼容高延迟、LL-HLS 折中、WebRTC <1s 成本高；边缘缓存最近 GOP，从关键帧起播，ABR 抗卡顿 | [直播系统案例](#/design/case-live) |
| 百万人房间弹幕怎么做 | 限频审核前置；降采样+合并+100ms 批量打包；房间连接分片按节点广播；优先级；不保证每人全收 | [直播系统案例](#/design/case-live) |
| 礼物打赏与直播成本 | 礼物强一致：幂等订单先扣款后异步派生；带宽最大成本：H.265、多 CDN、按需转码、P2P | [直播系统案例](#/design/case-live) |

## 安全与认证

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| Session 与 JWT 的区别 | Session 状态在服务端易撤销；JWT 无状态易扩展但难撤销，用短期 Access + 可轮换 Refresh + 黑名单/版本号 | [认证授权](#/security/auth) |
| OAuth2 授权码 + PKCE 流程 | 重定向授权→回调带一次性 code→code+verifier 换令牌；PKCE 让被截获的 code 无法换令牌 | [认证授权](#/security/auth) |
| OAuth2 与 OIDC 区别 | OAuth2 管授权（令牌能访问什么），OIDC 加身份层（ID Token 说明用户是谁）；不要拿 ID Token 调 API | [认证授权](#/security/auth) |
| Spring Security 认证流程 | 过滤器链→AuthenticationManager→Provider→UserDetailsService+PasswordEncoder→SecurityContext；URL 授权 + 方法安全 | [认证授权](#/security/auth) |
| 微服务统一认证 | 授权服务器签发 JWT + JWKS；网关验令牌并限流；各服务再验并做数据权限；零信任 | [认证授权](#/security/auth) |
| 水平越权怎么防 | 每次访问校验资源归属，查询带当前用户；DTO 白名单防批量赋值；多租户在数据层强制 | [Web 安全](#/security/web) |
| SQL 注入与 MyBatis `${}` | 参数化查询；`#{}` 预编译，`${}` 拼接；动态列名走白名单 | [Web 安全](#/security/web) |
| XSS 与 CSRF 防护 | 输出按上下文编码 + CSP + HttpOnly；CSRF 用 SameSite + Token + Origin 校验，Bearer 头天然免疫 | [Web 安全](#/security/web) |
| SSRF 怎么防 | 协议与域名白名单；解析后拒绝内网/回环/链路本地；防 DNS 重绑定与重定向；云上用 IMDSv2 | [Web 安全](#/security/web) |
| Java 反序列化与 Log4Shell | 不反序列化不可信数据、关 autoType、类白名单；依赖是攻击面，要有 SBOM 与快速升级能力 | [Web 安全](#/security/web) |
| 密码怎么存 | bcrypt/Argon2 带随机盐的慢哈希，成本可调；禁止 MD5/SHA 无盐与可逆加密 | [加密与密钥管理](#/security/crypto) |
| HTTPS 握手与前向保密 | ECDHE 协商会话密钥 + 证书验身份 + 对称加密传输；临时密钥使私钥泄露也解不开历史流量 | [加密与密钥管理](#/security/crypto) |
| 信封加密与 KMS | DEK 加密数据，KMS 主密钥加密 DEK；轮换只重加密 DEK；主密钥不出 KMS | [加密与密钥管理](#/security/crypto) |
| 防篡改防重放的接口签名 | HMAC/非对称签名覆盖方法、路径、参数、时间戳、nonce、body 摘要；Redis 去重 nonce | [加密与密钥管理](#/security/crypto) |

## NoSQL、NewSQL、时序与分析库

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| MongoDB 适合什么场景 | 结构多变、以聚合对象读写、高写入半结构化数据；不适合强事务与大量联表 | [MongoDB 数据模型](#/db/mongo-model) |
| MongoDB 嵌入还是引用 | 一起读、数量有界、同生命周期则嵌入；独立访问、多对多、无界增长则引用；子集/扩展引用模式 | [MongoDB 数据模型](#/db/mongo-model) |
| MongoDB 复合索引 ESR 规则 | 等值→排序→范围；最左前缀；覆盖查询；explain 看 IXSCAN 与 docsExamined/nReturned | [MongoDB 数据模型](#/db/mongo-model) |
| MongoDB `w:1` 为什么可能丢数据 | 仅主确认，主节点故障后未复制的写被回滚；重要数据用 w:majority + j:true + majority 读 | [MongoDB 复制集与分片](#/db/mongo-cluster) |
| MongoDB 分片键怎么选 | 高基数、写入均匀、查询带分片键；避免单调递增键写热点，用哈希或复合键；低基数产生 jumbo chunk | [MongoDB 复制集与分片](#/db/mongo-cluster) |
| TiDB 架构与分布式事务 | TiDB 无状态 SQL 层 + TiKV(Raft Region) + PD(元数据/TSO/调度) + TiFlash；Percolator 两阶段提交，primary 提交是原子点 | [TiDB 架构](#/db/tidb-arch) |
| TiDB 隔离级别与 MySQL RR 差异 | 快照隔离，无间隙锁，写偏斜；依赖 gap lock 的逻辑要改用唯一索引或 FOR UPDATE | [TiDB 架构](#/db/tidb-arch) |
| TiDB 写入热点与迁移 | 自增主键集中最后 Region，用 AUTO_RANDOM；DM 全量+增量、校验、灰度、反向回流；大事务分批 | [TiDB 实战](#/db/tidb-practice) |
| 何时选 TiDB | 数据 TB 级、写入需水平扩展、分库分表痛苦、要强一致事务与 HTAP；小规模延迟敏感用单机 MySQL | [TiDB 实战](#/db/tidb-practice) |
| InfluxDB tag 与 field | tag 带索引低基数用于过滤分组，field 存数值；series 基数是关键，ID/URL 不能当 tag | [InfluxDB 数据模型](#/db/influx-model) |
| 时序库降采样与保留策略 | 分级 bucket；Task/CQ 聚合并保留 min/max/mean/count；按 shard 整体过期 | [InfluxDB 实战](#/db/influx-practice) |
| 时序库选型 | 云原生监控用 Prometheus；要 SQL 联查用 TimescaleDB；海量设备用 TDengine/IoTDB；分析用 ClickHouse | [InfluxDB 实战](#/db/influx-practice) |
| ClickHouse 为什么快 | 列存少读 + 压缩 + 稀疏索引/分区跳过 + 向量化与多核并行 | [ClickHouse 存储与执行](#/bigdata/ck-engine) |
| MergeTree 稀疏索引与排序键 | 每 8192 行一条索引、mark 定位列文件；排序键前缀有效，低基数在前；PK 不唯一，点查非强项 | [ClickHouse 存储与执行](#/bigdata/ck-engine) |
| ClickHouse Too many parts | 小批量高频写入或分区过细；批量、async_insert、Kafka 引擎/Flink 攒批、减分区 | [ClickHouse 存储与执行](#/bigdata/ck-engine) |
| ReplacingMergeTree 去重的坑 | 仅合并时同分区去重；查询要 FINAL 或 argMax；排序键须含去重键 | [ClickHouse 存储与执行](#/bigdata/ck-engine) |
| ClickHouse 集群与分布式 Join | ReplicatedMergeTree + Keeper + Distributed 表；写本地表；大表 Join 用 colocate/宽表/字典，GLOBAL 广播小表 | [ClickHouse 集群与实战](#/bigdata/ck-cluster) |
| 漏斗/留存/UV 怎么做 | windowFunnel/retention 按用户一次扫描，分片键用 user_id；UV 用 uniq 系列，周 UV 不能日 UV 相加，用 State/Merge | [ClickHouse 行为分析](#/bigdata/ck-analytics) |

## 领域驱动与事件驱动

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| DDD 战略与战术设计的区别 | 战略：通用语言、子域、限界上下文、上下文映射；战术：实体、值对象、聚合、领域服务、仓储、领域事件 | [DDD 战略设计](#/design/ddd-strategic) |
| 限界上下文与微服务 | 上下文是边界候选，不必一一对应；先模块化单体再拆；按语言变化、业务能力、团队、一致性划分 | [DDD 战略设计](#/design/ddd-strategic) |
| 防腐层的作用 | 领域层定义自己的接口，基础设施层翻译外部模型与错误码，隔离遗留/第三方变化 | [DDD 战略设计](#/design/ddd-strategic) |
| 聚合如何设计 | 以不变量定边界；小聚合、只引用 ID、一个事务改一个聚合、跨聚合用领域事件最终一致；乐观锁 | [DDD 战术设计](#/design/ddd-tactical) |
| 贫血与充血模型 | 贫血：规则散在 Service 易被绕过；充血：状态转移与校验在聚合内；简单 CRUD 不必强求 | [DDD 战术设计](#/design/ddd-tactical) |
| 业务变更与事件发布如何一致 | Outbox：同一本地事务写业务表与 outbox，中继/CDC 投递；消费端幂等 | [事件驱动架构](#/design/event-driven) |
| 事件重复、乱序、丢失怎么办 | eventId 去重表/条件更新；按聚合分区 + 版本号丢旧事件；重试主题 + 死信 | [事件驱动架构](#/design/event-driven) |
| Saga 协同式与编排式 | 协同靠事件接力无中心；编排由协调者集中控制与补偿；补偿幂等且必须成功，注意空补偿与悬挂 | [事件驱动架构](#/design/event-driven) |
| CQRS 与事件溯源 | CQRS 读写模型分离（可同库分层起步）；ES 存事件重放得状态，需读模型、快照、事件版本升级；只用于特定聚合 | [CQRS 与事件溯源](#/design/cqrs-es) |

## 计算机基础：操作系统、网络与算法

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 进程、线程、协程的区别 | 进程资源隔离、线程共享地址空间是调度单位、协程用户态调度；切换开销依次降低 | [进程、线程与 CPU 调度](#/cs/os-process) |
| 上下文切换的代价与线程数 | 直接 µs 级，间接是缓存/TLB 失效；CPU 密集 N+1，IO 密集按等待比例，压测校准 | [进程、线程与 CPU 调度](#/cs/os-process) |
| 容器 CPU limit 为何延迟抖动 | CFS 带宽控制耗尽配额被强制暂停，看 throttled 指标；放宽 limit、让 JVM 感知核数 | [进程、线程与 CPU 调度](#/cs/os-process) |
| 死锁四条件与预防 | 互斥/持有并等待/不可抢占/循环等待；统一加锁顺序、tryLock 超时；jstack 排查 | [进程、线程与 CPU 调度](#/cs/os-process) |
| 虚拟内存、缺页与 swap | 页表 + TLB 翻译；主要缺页读盘毫秒级；延迟敏感服务关 swap；free 看 available | [虚拟内存与内存管理](#/cs/os-memory) |
| Java 容器 OOMKilled 但堆没满 | RSS = 堆 + 元空间 + 线程栈 + 直接内存 + 代码缓存 + GC 结构 + glibc arena；NMT 核算 | [虚拟内存与内存管理](#/cs/os-memory) |
| write 成功就落盘了吗 | 只进页缓存，需 fsync；组提交摊薄成本；Kafka 靠多副本而非 fsync | [文件系统、页缓存与零拷贝](#/cs/os-io) |
| 零拷贝与 mmap/sendfile | 传统 4 次拷贝，sendfile 在内核内转发；mmap 适合用户态处理，sendfile 适合纯转发 | [文件系统、页缓存与零拷贝](#/cs/os-io) |
| IP 同网段与跨网段通信 | 同网段 ARP 解析目的 MAC；跨网段发给网关，IP 不变 MAC 逐跳改写；路由最长前缀匹配 | [网络层：IP、路由、NAT 与 MTU](#/cs/net-ip) |
| NAT 与 conntrack 的坑 | conntrack 表满静默丢包；SNAT 端口耗尽；空闲超时回收；源 IP 用 XFF/Proxy Protocol 传递 | [网络层：IP、路由、NAT 与 MTU](#/cs/net-ip) |
| 小包正常大包卡死 | PMTU 黑洞：ICMP 需分片被屏蔽；放行 ICMP、MSS clamping、统一 overlay MTU | [网络层：IP、路由、NAT 与 MTU](#/cs/net-ip) |
| DNS 解析过程与切换为何慢 | 多级缓存按 TTL；JVM 缓存与连接池不重解析；迁移前提前调低 TTL | [DNS 与 CDN](#/cs/net-dns) |
| K8s DNS 偶发 5 秒与 ndots | ndots:5 放大查询，A/AAAA 并行 UDP 的 conntrack 竞争；FQDN、调 ndots、NodeLocal DNSCache | [DNS 与 CDN](#/cs/net-dns) |
| 快速重传与超时重传 | 3 个重复 ACK 立即重传；超时按 RTO 指数退避；SACK 只补缺失段；SYN 丢失表现为 1s/3s 慢 | [TCP 深入与 UDP/QUIC](#/cs/net-tcp) |
| 接口固定 40ms 延迟 | Nagle 与延迟 ACK 相互等待；开 TCP_NODELAY 并一次写完整消息 | [TCP 深入与 UDP/QUIC](#/cs/net-tcp) |
| keepalive 与连接被静默回收 | 默认 2 小时太长；间隔小于 NAT/LB 空闲超时 + 应用层心跳；连接池 maxLifetime 更小 | [TCP 深入与 UDP/QUIC](#/cs/net-tcp) |
| Connection reset 怎么排查 | 两端抓包看谁发 RST：无监听、对端已关、空闲回收、SO_LINGER 0、队列溢出、中间设备注入 | [TCP 深入与 UDP/QUIC](#/cs/net-tcp) |
| QUIC 为何基于 UDP | 用户态可靠传输 + 多流独立无队头阻塞 + 1-RTT 握手 + 连接迁移；弱网收益明显 | [TCP 深入与 UDP/QUIC](#/cs/net-tcp) |
| Docker 网络与 K8s Service 原理 | netns + veth + bridge，-p 是 iptables DNAT；ClusterIP 是虚拟 IP，kube-proxy 用 iptables/IPVS 做 DNAT | [容器网络与网络排障](#/cs/net-debug) |
| 请求慢卡在哪一层 | curl -w 分阶段耗时，ss 看队列重传，两端 tcpdump 对比握手/重传/RST，区分网络与应用 | [容器网络与网络排障](#/cs/net-debug) |
| 复杂度与常见数据结构选型 | 按操作代价选：数组/链表/哈希/堆/红黑树/B+ 树/跳表；LRU = 哈希 + 双向链表 | [复杂度与核心数据结构](#/cs/algo-ds) |
| 常见解题套路 | 二分（单调性）、双指针/滑窗、前缀和、回溯、DP 四步、BFS 最短步数、拓扑排序 | [解题套路](#/cs/algo-patterns) |
| 布隆过滤器与缓存穿透 | 位数组 + 多哈希，无假阴性有假阳性，不能删；参数由 n 与误判率估算 | [工程中的算法](#/cs/algo-engineering) |
| 一致性哈希与虚拟节点 | 增删节点只迁移约 K/N；虚拟节点解决倾斜与故障压力集中 | [工程中的算法](#/cs/algo-engineering) |
| 限流算法对比 | 固定窗口有临界突刺；滑动窗口平滑；漏桶整形；令牌桶允许突发；分布式用 Redis + Lua | [工程中的算法](#/cs/algo-engineering) |
| 海量数据 Top K 与去重 | 哈希分片 + 局部堆再合并；UV 用 HyperLogLog；整数集合用位图；频次近似用 Count-Min Sketch | [工程中的算法](#/cs/algo-engineering) |

## AI 模型与数学

| 问题 | 答题要点 | 详见 |
| --- | --- | --- |
| 梯度下降与学习率 | 沿负梯度更新；学习率过大震荡发散，过小收敛慢；动量/Adam 改进 | [微积分：导数与梯度](#/aimodel/math-calc2) |
| 过拟合与欠拟合 | 训练好验证差 = 过拟合：正则、Dropout、早停、更多数据；两者都差 = 欠拟合：加容量 | [机器学习入门](#/aimodel/ml-intro) |
| 反向传播本质 | 链式法则从输出层向输入层逐层求梯度，复用中间结果 | [MLP 与反向传播](#/aimodel/mlp) |
| CNN 为什么适合图像 | 局部连接、权值共享、平移不变性；池化降维；参数远少于全连接 | [CNN](#/aimodel/cnn) |
| RNN/LSTM 的问题与门控 | 长序列梯度消失/爆炸；LSTM 用输入/遗忘/输出门控制信息流；仍难并行 | [RNN 与 LSTM](#/aimodel/rnn) |
| Transformer 与注意力 | QKV 自注意力并行建模全局依赖；多头；位置编码；复杂度随长度平方增长 | [Transformer](#/aimodel/transformer) |
| LLM 如何训练与推理 | 预训练(next token)→指令微调→对齐(RLHF/DPO)；推理 Prefill + Decode，KV Cache | [大语言模型](#/aimodel/llm) |
| 交叉熵、Softmax 与概率 | Softmax 转概率；交叉熵衡量预测与真实分布差异；最大似然视角 | [概率与统计基础](#/aimodel/math-prob) |

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

## 相关阅读

- [高并发系统设计方法论](#/design/method)：系统设计方法论
- [案例：订单、支付与对账系统设计详解](#/design/case-payment)：案例：订单、支付与对账
- [案例：即时通讯（IM）系统设计详解](#/design/case-im)：案例：即时通讯
- [技术方案与 ADR 写作](#/design/eng-adr)：如何把项目方案讲清楚
