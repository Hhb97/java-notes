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
          { title: '字节码与执行引擎', path: 'java/jvm/bytecode' }
        ]
      },
      {
        title: '现代 Java', children: [
          { title: 'Lambda 与 Stream', path: 'java/modern/lambda' }
        ]
      }
    ]
  },
  {
    id: 'spring', title: 'Spring 生态', desc: '容器、AOP、事务、MVC、MyBatis、Boot、Cloud',
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
          { title: 'Spring Boot 自动配置与启动', path: 'spring/boot' }
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
      }
    ]
  },
  {
    id: 'redis', title: 'Redis', desc: '数据结构、持久化、集群、缓存与分布式锁',
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
          { title: '缓存设计与一致性', path: 'redis/cache' }
        ]
      }
    ]
  },
  {
    id: 'mw', title: '中间件', desc: 'Kafka、RocketMQ、Elasticsearch',
    children: [
      {
        title: '消息队列', children: [
          { title: '消息队列核心问题', path: 'mw/mq' },
          { title: 'Kafka 架构与存储', path: 'mw/kafka' },
          { title: 'Kafka 副本与可靠性', path: 'mw/kafka-reliability' },
          { title: 'RocketMQ 原理与事务消息', path: 'mw/rocketmq' }
        ]
      },
      {
        title: '搜索引擎', children: [
          { title: 'Elasticsearch 原理', path: 'mw/es' }
        ]
      }
    ]
  },
  {
    id: 'distributed', title: '分布式', desc: 'CAP、共识、分布式事务、ID、限流熔断',
    children: [
      {
        title: '理论', children: [
          { title: 'CAP、BASE 与一致性模型', path: 'distributed/theory' },
          { title: 'Raft 与共识算法', path: 'distributed/consensus' }
        ]
      },
      {
        title: '实践', children: [
          { title: '分布式事务', path: 'distributed/transaction' },
          { title: '分布式 ID 生成', path: 'distributed/id' },
          { title: '限流、熔断与降级', path: 'distributed/governance' }
        ]
      }
    ]
  },
  {
    id: 'infra', title: '网络与运维', desc: 'TCP/HTTP、Netty、Linux、Nginx、Docker、K8s',
    children: [
      {
        title: '网络与 IO', children: [
          { title: 'TCP/IP 与 HTTP(S)', path: 'infra/network' },
          { title: 'IO 模型与 Netty', path: 'infra/netty' }
        ]
      },
      {
        title: '运维部署', children: [
          { title: 'Linux 线上排查', path: 'infra/linux' },
          { title: 'Nginx 与负载均衡', path: 'infra/nginx' },
          { title: 'Docker 容器化', path: 'infra/docker' }
        ]
      }
    ]
  },
  {
    id: 'design', title: '系统设计', desc: '高并发方法论、秒杀、面试速查',
    children: [
      { title: '高并发系统设计方法论', path: 'design/method' }
    ]
  }
];
