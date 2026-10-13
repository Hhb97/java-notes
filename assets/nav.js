// 知识库目录
// 顶层是「大分类」（显示为顶部标签），children 可无限嵌套；叶子节点 path 对应 docs/<path>.md
window.NAV = [
  {
    id: 'java', title: 'Java 核心', desc: '语言、集合、并发、JVM 与工程化',
    children: [
      {
        title: '语言基础', children: [
          { title: '语言概览与环境', path: 'java/basics/intro' },
          { title: '数据类型与变量', path: 'java/basics/types' },
          { title: '运算符与流程控制', path: 'java/basics/control' },
          { title: '数组与字符串', path: 'java/basics/string' }
        ]
      },
      {
        title: '面向对象', children: [
          { title: '类与对象', path: 'java/oop/class' },
          { title: '继承与多态', path: 'java/oop/inherit' },
          { title: '接口与抽象类', path: 'java/oop/interface' },
          { title: '枚举与记录类', path: 'java/oop/enum' }
        ]
      },
      {
        title: '核心 API', children: [
          {
            title: '集合框架', children: [
              { title: '集合体系总览', path: 'java/api/collections' },
              { title: 'HashMap 源码剖析', path: 'java/api/hashmap' },
              { title: 'ConcurrentHashMap 源码剖析', path: 'java/api/chm' }
            ]
          },
          { title: '泛型与类型擦除', path: 'java/api/generics' },
          { title: '异常体系与最佳实践', path: 'java/api/exception' },
          { title: '反射、注解与动态代理', path: 'java/api/reflect' },
          { title: 'IO / NIO 与零拷贝', path: 'java/api/io' }
        ]
      },
      {
        title: '并发编程', children: [
          { title: '线程与生命周期', path: 'java/concurrency/thread' },
          { title: 'Java 内存模型与 volatile', path: 'java/concurrency/jmm' },
          { title: 'synchronized 与锁升级', path: 'java/concurrency/sync' },
          { title: 'AQS 与显式锁', path: 'java/concurrency/aqs' },
          { title: '线程池原理与调优', path: 'java/concurrency/pool' },
          { title: '并发工具与 CompletableFuture', path: 'java/concurrency/juc' }
        ]
      },
      {
        title: 'JVM', children: [
          { title: '运行时数据区与对象模型', path: 'java/jvm/memory' },
          { title: '垃圾回收算法与分代', path: 'java/jvm/gc' },
          { title: 'G1 与 ZGC 深入', path: 'java/jvm/collectors' },
          { title: '类加载与双亲委派', path: 'java/jvm/classloader' },
          { title: '字节码与执行引擎', path: 'java/jvm/bytecode' },
          { title: '线上调优与故障排查', path: 'java/jvm/tuning' }
        ]
      },
      {
        title: '现代 Java', children: [
          { title: 'Lambda 与 Stream', path: 'java/modern/lambda' },
          { title: 'Java 8–21 新特性', path: 'java/modern/features' }
        ]
      },
      {
        title: '工程化', children: [
          { title: 'Maven 构建与依赖管理', path: 'java/eng/maven' },
          { title: '单元测试：JUnit 5 与 Mockito', path: 'java/eng/testing' }
        ]
      },
      {
        title: '设计模式', children: [
          { title: '创建型模式', path: 'java/patterns/creational' },
          { title: '结构型与行为型模式', path: 'java/patterns/behavioral' }
        ]
      }
    ]
  },
  {
    id: 'spring', title: 'Spring 生态', desc: '容器、AOP、事务、MVC、MyBatis、Boot、Cloud 与微服务治理',
    children: [
      {
        title: '核心容器', children: [
          { title: 'IoC 容器与 Bean 生命周期', path: 'spring/ioc' },
          { title: 'AOP 与代理机制', path: 'spring/aop' },
          { title: '声明式事务原理', path: 'spring/tx' }
        ]
      },
      {
        title: 'Web 与持久层', children: [
          { title: 'Spring MVC 请求链路', path: 'spring/mvc' },
          { title: 'MyBatis 原理与实践', path: 'spring/mybatis' }
        ]
      },
      {
        title: 'Boot 与 Cloud', children: [
          { title: 'Spring Boot 自动配置与启动', path: 'spring/boot' },
          { title: 'Spring Cloud 微服务全景', path: 'spring/cloud' }
        ]
      },
      {
        title: '微服务治理', children: [
          { title: 'OpenFeign 深入：调用链、超时重试与上下文透传', path: 'spring/cloud-feign' },
          { title: 'Spring Cloud Gateway 深入：过滤器链、动态路由与响应式陷阱', path: 'spring/cloud-gateway' },
          { title: '熔断限流实战：Sentinel 与 Resilience4j', path: 'spring/cloud-resilience' },
          { title: '配置管理与全链路灰度', path: 'spring/cloud-config-gray' },
          { title: '微服务安全：网关鉴权、服务间认证与令牌传递', path: 'spring/cloud-security' },
          { title: '微服务可观测：Micrometer、链路追踪与排障', path: 'spring/cloud-observability' },
          { title: '微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍', path: 'spring/cloud-evolution' }
        ]
      }
    ]
  },
  {
    id: 'mysql', title: 'MySQL', desc: 'InnoDB、索引、事务、锁、日志、复制与分片',
    children: [
      {
        title: '基础架构', children: [
          { title: '架构与 SQL 执行流程', path: 'mysql/architecture' },
          { title: 'InnoDB 存储结构与 Buffer Pool', path: 'mysql/storage' }
        ]
      },
      {
        title: '索引与优化', children: [
          { title: 'B+ 树索引原理', path: 'mysql/index' },
          { title: 'EXPLAIN 与 SQL 调优', path: 'mysql/optimize' }
        ]
      },
      {
        title: '事务、锁与日志', children: [
          { title: '事务隔离与 MVCC', path: 'mysql/transaction' },
          { title: '锁机制与死锁分析', path: 'mysql/lock' },
          { title: 'redo / undo / binlog', path: 'mysql/log' }
        ]
      },
      {
        title: '高可用与扩展', children: [
          { title: '主从复制与高可用', path: 'mysql/replication' },
          { title: '分库分表实践', path: 'mysql/sharding' }
        ]
      }
    ]
  },
  {
    id: 'pg', title: 'PostgreSQL', desc: '进程模型、MVCC 与 VACUUM、索引、复制与运维',
    children: [
      {
        title: '内核原理', children: [
          { title: '架构、WAL 与存储结构', path: 'pg/architecture' },
          { title: 'MVCC、VACUUM 与锁', path: 'pg/mvcc' }
        ]
      },
      {
        title: '索引与运维', children: [
          { title: '索引类型与查询优化', path: 'pg/index' },
          { title: '复制、高可用与实战', path: 'pg/ops' }
        ]
      }
    ]
  },
  {
    id: 'redis', title: 'Redis', desc: '数据结构、持久化、集群、缓存、分布式锁与运维治理',
    children: [
      {
        title: '核心原理', children: [
          { title: '线程模型与高性能原理', path: 'redis/overview' },
          { title: '数据结构与底层编码', path: 'redis/types' },
          { title: '过期策略与内存淘汰', path: 'redis/expire' }
        ]
      },
      {
        title: '持久化与高可用', children: [
          { title: 'RDB 与 AOF', path: 'redis/persistence' },
          { title: '主从、哨兵与 Cluster', path: 'redis/cluster' }
        ]
      },
      {
        title: '实战', children: [
          { title: '缓存设计与一致性', path: 'redis/cache' },
          { title: '分布式锁', path: 'redis/lock' },
          { title: '高频场景实战', path: 'redis/practice' }
        ]
      },
      {
        title: '运维与治理', children: [
          { title: 'Redis Cluster 生产运维：规划、扩缩容与故障处理', path: 'redis/cluster-ops' },
          { title: 'Redis 大 key 与热 key 治理', path: 'redis/bigkey' },
          { title: 'Redis 内存优化与容量治理', path: 'redis/memory' },
          { title: 'Redis 故障排查与安全加固', path: 'redis/troubleshooting' },
          { title: 'Redis 使用规范与平台化治理', path: 'redis/governance' }
        ]
      }
    ]
  },
  {
    id: 'db', title: 'NoSQL、NewSQL、时序与分析库', desc: 'MongoDB 文档库、TiDB 分布式 SQL、InfluxDB 时序库、ClickHouse 列式分析库',
    children: [
      {
        title: 'MongoDB', children: [
          { title: 'MongoDB 数据模型、索引与聚合', path: 'db/mongo-model' },
          { title: 'MongoDB 复制集、分片与事务', path: 'db/mongo-cluster' }
        ]
      },
      {
        title: 'TiDB', children: [
          { title: 'TiDB 架构：TiKV、PD、Raft 与分布式事务', path: 'db/tidb-arch' },
          { title: 'TiDB 实战：热点、迁移、选型与调优', path: 'db/tidb-practice' }
        ]
      },
      {
        title: '时序数据库 InfluxDB', children: [
          { title: 'InfluxDB 数据模型与存储引擎', path: 'db/influx-model' },
          { title: 'InfluxDB 实战：基数、降采样、Java 写入与选型', path: 'db/influx-practice' }
        ]
      },
      {
        title: 'ClickHouse', children: [
          { title: 'ClickHouse 存储与执行：MergeTree、稀疏索引与向量化', path: 'bigdata/ck-engine' },
          { title: 'ClickHouse 集群、写入与表设计实战', path: 'bigdata/ck-cluster' },
          { title: 'ClickHouse 行为分析：漏斗、留存与近似计算', path: 'bigdata/ck-analytics' }
        ]
      }
    ]
  },
  {
    id: 'mw', title: '中间件', desc: 'Kafka、RocketMQ、RabbitMQ、Pulsar、ES、Dubbo、gRPC、注册配置中心与 ZooKeeper/etcd',
    children: [
      {
        title: '消息队列', children: [
          { title: '消息队列核心问题', path: 'mw/mq' },
          { title: 'Kafka 架构与存储', path: 'mw/kafka' },
          { title: 'Kafka 副本与可靠性', path: 'mw/kafka-reliability' },
          { title: 'Kafka 生产运维：容量规划、Rebalance 治理与故障排查', path: 'mw/kafka-ops' },
          { title: 'Kafka 生态：Connect、Streams 与 Schema Registry', path: 'mw/kafka-ecosystem' },
          { title: 'RocketMQ 原理与事务消息', path: 'mw/rocketmq' },
          { title: 'RabbitMQ 原理与可靠性（AMQP、仲裁队列与死信）', path: 'mw/rabbitmq' },
          { title: 'Pulsar 架构与存算分离', path: 'mw/pulsar' },
          { title: '消息队列平台化与治理', path: 'mw/mq-governance' }
        ]
      },
      {
        title: '搜索引擎', children: [
          { title: 'Elasticsearch 原理', path: 'mw/es' },
          { title: 'ES 实战与数据同步', path: 'mw/es-practice' },
          { title: 'ES 集群运维：生命周期、故障排查与日志场景', path: 'mw/es-ops' }
        ]
      },
      {
        title: 'RPC 框架', children: [
          { title: 'Dubbo 架构与调用链路', path: 'mw/dubbo' },
          { title: 'Dubbo 集群容错与服务治理', path: 'mw/dubbo-practice' },
          { title: 'gRPC 与 Protobuf：协议、流式调用与治理', path: 'mw/grpc' }
        ]
      },
      {
        title: '注册、配置与协调', children: [
          { title: 'Nacos 与服务注册发现、配置中心', path: 'mw/registry' },
          { title: '分布式协调：ZooKeeper 与 etcd', path: 'mw/coordination' }
        ]
      }
    ]
  },
  {
    id: 'iot', title: '物联网', desc: 'MQTT 协议、Broker 集群、Java 接入与 IoT 平台架构',
    children: [
      {
        title: 'MQTT', children: [
          { title: 'MQTT 协议详解', path: 'iot/mqtt' },
          { title: 'Broker 架构与集群（EMQX）', path: 'iot/broker' }
        ]
      },
      {
        title: '开发与平台', children: [
          { title: 'Java 接入：Paho、Spring 与 Netty', path: 'iot/java' },
          { title: 'IoT 平台架构与设备管理', path: 'iot/platform' }
        ]
      }
    ]
  },
  {
    id: 'ai', title: 'AI 应用', desc: '大模型应用、提示词、RAG、Agent、MCP、微调、评测与 Spring AI / LangChain4j',
    children: [
      {
        title: '基础', children: [
          { title: 'AI 应用全景与学习路线（工程师视角）', path: 'ai/overview' },
          { title: '大模型应用基础与 API 调用', path: 'ai/llm' },
          { title: '提示词工程进阶与结构化输出', path: 'ai/prompt-eng' },
          { title: '大模型原理与推理服务（KV Cache、vLLM、量化、微调）', path: 'ai/llm-internals' }
        ]
      },
      {
        title: 'RAG', children: [
          { title: 'RAG 原理与完整流水线', path: 'ai/rag' },
          { title: '文档解析与多模态 RAG（PDF、表格、OCR、图片）', path: 'ai/rag-parsing' },
          { title: 'RAG 检索优化、向量库与评估', path: 'ai/rag-advanced' }
        ]
      },
      {
        title: 'Agent 与工具', children: [
          { title: 'Agent、工具调用与 MCP', path: 'ai/agent' },
          { title: 'MCP 深入：协议、服务端开发与安全', path: 'ai/mcp-deep' },
          { title: '工作流与 Agent 选型：编排模式与状态图', path: 'ai/agent-workflow' },
          { title: 'Agent 进阶：上下文工程、记忆与多智能体', path: 'ai/agent-deep' }
        ]
      },
      {
        title: '模型定制与评测', children: [
          { title: '微调实战：数据、LoRA/QLoRA、偏好对齐与评估', path: 'ai/finetune' },
          { title: '评测体系实战：数据集、LLM 评审与回归门禁', path: 'ai/eval' }
        ]
      },
      {
        title: '工程落地', children: [
          { title: 'Java 实战：Spring AI 与 LangChain4j', path: 'ai/spring-ai' },
          { title: 'LLM 应用工程化、安全与评测', path: 'ai/llmops' }
        ]
      },
      {
        title: '架构案例', children: [
          { title: '案例：企业智能客服与知识库（RAG + Agent）设计详解', path: 'ai/case-kb' },
          { title: '案例：Text-to-SQL 数据分析助手设计详解', path: 'ai/case-text2sql' },
          { title: '案例：代码助手与自动 Code Review 设计详解', path: 'ai/case-codeagent' }
        ]
      }
    ]
  },
  {
    id: 'aimodel', title: 'AI 模型与数学', desc: '给初学者：线性代数、微积分，到 MLP、CNN、Transformer 与 LLM',
    children: [
      {
        title: '数学基础', children: [
          { title: '线性代数 1：向量与矩阵', path: 'aimodel/math-la1' },
          { title: '线性代数 2：特征值、SVD 与 PCA', path: 'aimodel/math-la2' },
          { title: '微积分 1：导数、偏导与链式法则', path: 'aimodel/math-calc1' },
          { title: '微积分 2：梯度下降，机器如何“学习”', path: 'aimodel/math-calc2' },
          { title: '概率与信息论入门：损失函数从哪来', path: 'aimodel/math-prob' }
        ]
      },
      {
        title: '机器学习入门', children: [
          { title: '机器学习是什么：回归、分类与过拟合', path: 'aimodel/ml-intro' }
        ]
      },
      {
        title: '神经网络', children: [
          { title: 'MLP：神经元、多层感知机与反向传播', path: 'aimodel/mlp' },
          { title: '训练神经网络：优化器、正则化与常见坑', path: 'aimodel/training' },
          { title: 'CNN：卷积神经网络如何“看图”', path: 'aimodel/cnn' },
          { title: 'RNN 与 LSTM：会“记事”的网络', path: 'aimodel/rnn' },
          { title: '注意力与 Transformer：大模型的骨架', path: 'aimodel/transformer' }
        ]
      },
      {
        title: '大模型与全景', children: [
          { title: 'LLM：从预训练到对话助手', path: 'aimodel/llm' },
          { title: '模型家族地图：Embedding、VAE、GAN、扩散、GNN、强化学习', path: 'aimodel/zoo' },
          { title: 'AI 模型的“性格画像”：怎么选模型', path: 'aimodel/personality' }
        ]
      }
    ]
  },
  {
    id: 'bigdata', title: '大数据', desc: 'Flink 流处理、CDC 与实时数仓、OLAP（ClickHouse 专题见数据库分类）、Spark 与数据湖',
    children: [
      {
        title: 'Flink', children: [
          { title: 'Flink 核心：时间、窗口与 Watermark', path: 'bigdata/flink-core' },
          { title: 'Flink 状态、Checkpoint 与 Exactly-Once', path: 'bigdata/flink-state' },
          { title: 'Flink SQL、反压与性能调优', path: 'bigdata/flink-ops' },
          { title: 'Flink 内部机制：执行图、网络栈、内存与 Key Group', path: 'bigdata/flink-internals' }
        ]
      },
      {
        title: '实时数据架构', children: [
          { title: 'CDC 与实时数仓架构', path: 'bigdata/cdc' },
          { title: 'OLAP：ClickHouse 与 Doris', path: 'bigdata/olap' }
        ]
      },
      {
        title: '离线与湖仓', children: [
          { title: 'Spark 与数据湖（Iceberg / Paimon）', path: 'bigdata/spark-lake' }
        ]
      },
      {
        title: '架构案例', children: [
          { title: '案例：电商实时数据平台设计详解（CDC → Flink → 湖仓 → Doris）', path: 'bigdata/case-realtime' }
        ]
      }
    ]
  },
  {
    id: 'security', title: '安全与认证', desc: '认证授权、OAuth2/JWT、Web 漏洞防护、加密与密钥管理',
    children: [
      {
        title: '认证与授权', children: [
          { title: '认证授权：Session、JWT、OAuth2 与 Spring Security', path: 'security/auth' }
        ]
      },
      {
        title: '应用与数据安全', children: [
          { title: 'Web 安全：OWASP 常见漏洞与防护', path: 'security/web' },
          { title: '加密、签名、HTTPS 与密钥管理', path: 'security/crypto' }
        ]
      }
    ]
  },
  {
    id: 'distributed', title: '分布式', desc: 'CAP、时钟、共识、复制与分片、故障、事务、幂等、一致性实战、ID、限流熔断',
    children: [
      {
        title: '理论', children: [
          { title: 'CAP、BASE 与一致性模型', path: 'distributed/theory' },
          { title: '分布式时钟：物理时间、逻辑时钟与 HLC', path: 'distributed/clock' },
          { title: 'Raft 与共识算法', path: 'distributed/consensus' },
          { title: 'Paxos 与共识算法族：原理、变体与对比', path: 'distributed/paxos' },
          { title: '复制与一致性：主从、多主与无主', path: 'distributed/replication' },
          { title: '分片、一致性哈希与再平衡', path: 'distributed/partitioning' },
          { title: '故障模型、故障检测与脑裂', path: 'distributed/fault' }
        ]
      },
      {
        title: '实践', children: [
          { title: '分布式事务', path: 'distributed/transaction' },
          { title: '幂等设计与重试：幂等键、去重表与超时未知', path: 'distributed/idempotent' },
          { title: '数据一致性实战：双写、对账与修复', path: 'distributed/consistency-practice' },
          { title: '分布式 ID 生成', path: 'distributed/id' },
          { title: '限流、熔断与降级', path: 'distributed/governance' }
        ]
      }
    ]
  },
  {
    id: 'infra', title: '网络与运维', desc: 'TCP/HTTP、Netty、可观测性、Linux、Nginx、Docker、K8s、CI/CD 与发布',
    children: [
      {
        title: '网络与 IO', children: [
          { title: 'TCP/IP 与 HTTP(S)', path: 'infra/network' },
          { title: 'IO 模型与 Netty', path: 'infra/netty' },
          { title: 'Netty 源码：线程模型与 Pipeline', path: 'infra/netty-core' },
          { title: 'Netty 实战：编解码、内存与调优', path: 'infra/netty-practice' }
        ]
      },
      {
        title: '可观测性', children: [
          { title: '指标监控：Prometheus、Micrometer 与 Grafana', path: 'infra/obs-metrics' },
          { title: '链路追踪、日志与告警：OpenTelemetry、ELK 与 SLO', path: 'infra/obs-trace' }
        ]
      },
      {
        title: '运维部署', children: [
          { title: 'Linux 线上排查', path: 'infra/linux' },
          { title: 'Nginx 与负载均衡', path: 'infra/nginx' },
          { title: 'Docker 容器化', path: 'infra/docker' },
          { title: 'Kubernetes 核心概念', path: 'infra/k8s' }
        ]
      },
      {
        title: '交付与发布', children: [
          { title: 'CI/CD 流水线与 GitOps', path: 'infra/cicd' },
          { title: '发布策略：灰度、蓝绿、特性开关与数据库变更', path: 'infra/release' }
        ]
      }
    ]
  },
  {
    id: 'cs', title: '计算机基础', desc: '操作系统（进程、内存、文件与 IO）、计算机网络（IP、DNS、TCP、容器网络）与算法',
    children: [
      {
        title: '操作系统', children: [
          { title: '进程、线程与 CPU 调度', path: 'cs/os-process' },
          { title: '虚拟内存、分页与内存管理', path: 'cs/os-memory' },
          { title: '文件系统、页缓存与零拷贝', path: 'cs/os-io' }
        ]
      },
      {
        title: '计算机网络', children: [
          { title: '网络层：以太网、IP、路由、NAT 与 MTU', path: 'cs/net-ip' },
          { title: 'DNS 与 CDN：解析流程、缓存与线上坑', path: 'cs/net-dns' },
          { title: 'TCP 深入与 UDP/QUIC：重传、保活、RST 与内核调优', path: 'cs/net-tcp' },
          { title: '容器网络与网络排障：CNI、iptables/IPVS、tcpdump', path: 'cs/net-debug' }
        ]
      },
      {
        title: '算法', children: [
          { title: '复杂度与核心数据结构', path: 'cs/algo-ds' },
          { title: '解题套路：双指针、二分、DP、回溯与图', path: 'cs/algo-patterns' },
          { title: '工程中的算法：布隆、一致性哈希、限流与 Top K', path: 'cs/algo-engineering' }
        ]
      }
    ]
  },
  {
    id: 'design', title: '系统设计', desc: '高并发方法论、架构专题（高可用/多活/整洁架构/多租户/API）、DDD 与事件驱动、架构案例、工程能力、面试速查',
    children: [
      { title: '高并发系统设计方法论', path: 'design/method' },
      {
        title: '架构专题', children: [
          { title: '高可用架构设计：可用性计算、故障域与容灾', path: 'design/arch-availability' },
          { title: '异地多活与单元化架构', path: 'design/arch-multi-active' },
          { title: '分层、六边形与整洁架构：应用内部的边界', path: 'design/arch-clean' },
          { title: '多租户 SaaS 架构：隔离、治理与运营', path: 'design/arch-multitenant' },
          { title: 'API 设计与演进：REST、兼容性与开放平台', path: 'design/arch-api' }
        ]
      },
      {
        title: '领域驱动与事件驱动', children: [
          { title: 'DDD 战略设计：限界上下文与上下文映射', path: 'design/ddd-strategic' },
          { title: 'DDD 战术设计：聚合、实体与领域事件（Java 落地）', path: 'design/ddd-tactical' },
          { title: '事件驱动架构：事件设计、Outbox 与 Saga', path: 'design/event-driven' },
          { title: 'CQRS 与事件溯源', path: 'design/cqrs-es' }
        ]
      },
      {
        title: '架构案例', children: [
          { title: '秒杀系统设计', path: 'design/seckill' },
          { title: '案例：订单、支付与对账系统设计详解', path: 'design/case-payment' },
          { title: '案例：即时通讯（IM）系统设计详解', path: 'design/case-im' },
          { title: '案例：短链接服务设计详解', path: 'design/case-shorturl' },
          { title: '案例：Feed 流与排行榜设计详解', path: 'design/case-feed' },
          { title: '案例：搜索系统设计详解', path: 'design/case-search' },
          { title: '案例：分布式任务调度平台设计详解', path: 'design/case-scheduler' },
          { title: '案例：API 网关设计详解', path: 'design/case-gateway' },
          { title: '案例：推荐系统设计详解', path: 'design/case-recsys' },
          { title: '案例：分布式文件/对象存储设计详解', path: 'design/case-objectstore' },
          { title: '案例：实时消息推送系统设计详解', path: 'design/case-push' },
          { title: '案例：高并发写入与热点治理（计数、库存、红包）', path: 'design/case-highwrite' },
          { title: '案例：直播系统设计详解', path: 'design/case-live' },
          { title: '案例：LBS 附近的人与打车派单设计详解', path: 'design/case-lbs' },
          { title: '案例：在线协作文档（OT 与 CRDT）设计详解', path: 'design/case-collab' }
        ]
      },
      {
        title: '工程能力', children: [
          { title: '压测与容量规划', path: 'design/eng-loadtest' },
          { title: '稳定性工程：故障演练与混沌实验', path: 'design/eng-chaos' },
          { title: '事故响应与复盘', path: 'design/eng-postmortem' },
          { title: '技术方案与 ADR 写作', path: 'design/eng-adr' }
        ]
      },
      { title: '面试高频速查', path: 'design/interview' }
    ]
  }
];
