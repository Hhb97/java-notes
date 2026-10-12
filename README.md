# Engineer's Notes · Java 后端知识库

面向资深 Java 后端工程师的深度笔记站点，在线阅读：https://hhb97.github.io/java-notes/

## 内容

| 分类 | 覆盖 |
| --- | --- |
| Java 核心 | 语言基础、面向对象、集合（HashMap / ConcurrentHashMap 源码）、反射与代理、IO/NIO、并发（JMM、synchronized、AQS、线程池）、JVM（内存、GC、G1/ZGC、类加载、JIT、调优）、Maven、测试、设计模式 |
| Spring 生态 | IoC、AOP、事务、Spring MVC、MyBatis、Spring Boot、Spring Cloud |
| MySQL | 架构、InnoDB 存储、B+ 树索引、SQL 调优、MVCC、锁、redo/undo/binlog、主从复制、分库分表 |
| PostgreSQL | 进程模型与 WAL、MVCC 与 VACUUM、锁、索引类型与优化、流复制/Patroni/PITR/分区 |
| Redis | 线程模型、数据结构编码、过期淘汰、持久化、哨兵与 Cluster、缓存一致性、分布式锁、场景实战 |
| 中间件 | 消息队列通用问题、Kafka、RocketMQ、Elasticsearch、Dubbo |
| 物联网 | MQTT 协议、EMQX 集群、Java 接入、IoT 平台架构（设备影子、OTA、时序数据） |
| AI 应用 | 大模型应用基础、RAG（流水线、检索优化、评估）、Agent 与 MCP、Spring AI / LangChain4j、LLM 工程化与安全、推理服务原理、Agent 进阶、**智能客服架构案例** |
| **AI 模型与数学**（初学者友好） | 线性代数、微积分、概率；机器学习入门；MLP、CNN、RNN/LSTM、Transformer、LLM；模型家族地图与“性格画像” |
| 大数据 | Flink（时间窗口、状态与 Exactly-Once、反压调优）、CDC 与实时数仓、ClickHouse / Doris、Spark 与 Iceberg / Paimon、Flink 内部机制、**电商实时数据平台架构案例** |
| 计算机基础 | 操作系统（进程线程与调度、虚拟内存、文件系统与页缓存/零拷贝）、算法（复杂度与数据结构、解题套路、布隆/一致性哈希/限流/Top K 等工程算法） |
| 安全 | 认证授权（Session/JWT/OAuth2/OIDC/SSO、Spring Security）、OWASP 常见漏洞防护、加密签名/HTTPS/密钥管理 |
| 分布式 | CAP/BASE、Raft、分布式事务、分布式 ID、限流熔断降级 |
| 网络与运维 | TCP/HTTP、IO 模型与 Netty（源码与实战）、Linux 排查、**可观测性（Prometheus/Micrometer、OpenTelemetry 链路、日志、SLO）**、Nginx、Docker、Kubernetes |
| 系统设计 | 高并发方法论、秒杀系统、**DDD（战略/战术）、事件驱动与 Saga、CQRS 与事件溯源**、**订单支付对账案例、即时通讯（IM）案例**、面试速查 |

每篇包含：核心要点、源码/原理、SVG 图解、关键参数、生产踩坑、面试追问。

## 站点功能

顶部分类标签 + 多级目录、页内大纲与滚动高亮、全文搜索（<kbd>Ctrl</kbd>+<kbd>K</kbd>）、明暗主题、代码高亮与复制、图解点击放大、可折叠面试追问、阅读进度。纯静态，无构建步骤。

## 本地预览

页面通过 `fetch` 加载 Markdown，需要本地静态服务器：

```bash
python -m http.server 8000
```

然后打开 http://localhost:8000 。

## 新增笔记

1. 按 [WRITING_GUIDE.md](WRITING_GUIDE.md) 的规范在 `docs/<分类>/` 下新建 `.md`（front matter、提示块、SVG 图解）；
2. 在 `assets/nav.js` 对应分类下添加 `{ title: '标题', path: '分类/文件名' }`；
3. 修改了 `assets/` 下的文件时，把 `index.html` 里的 `?v=` 版本号加一，避免浏览器缓存旧版本；
4. 提交并推送，GitHub Pages 自动更新。
