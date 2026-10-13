# Engineer's Notes · Java 后端知识库

面向资深 Java 后端工程师的深度笔记站点，在线阅读：https://hhb97.github.io/java-notes/

## 内容

| 分类 | 覆盖 |
| --- | --- |
| Java 核心 | 语言基础、面向对象、集合（HashMap / ConcurrentHashMap 源码）、反射与代理、IO/NIO、并发（JMM、synchronized、AQS、线程池）、JVM（内存、GC、G1/ZGC、类加载、JIT、调优）、Maven、测试、设计模式 |
| Spring 生态 | IoC、AOP、事务、Spring MVC、MyBatis、Spring Boot、Spring Cloud 与微服务治理（OpenFeign、Gateway、熔断限流、配置与全链路灰度、微服务安全、可观测、Boot 3 与虚拟线程演进） |
| MySQL | 架构、InnoDB 存储、B+ 树索引、SQL 调优、MVCC、锁、redo/undo/binlog、主从复制、分库分表 |
| PostgreSQL | 进程模型与 WAL、MVCC 与 VACUUM、锁、索引类型与优化、流复制/Patroni/PITR/分区 |
| Redis | 线程模型、数据结构编码、过期淘汰、持久化、哨兵与 Cluster、缓存一致性、分布式锁、场景实战，以及运维治理（Cluster 运维、大 key 与热 key、内存优化、故障排查与安全、使用规范与平台化） |
| NoSQL、NewSQL、时序与分析库 | MongoDB（文档建模、索引与聚合、复制集/分片/事务）、TiDB（TiKV/PD/Raft、Percolator 分布式事务、热点与迁移、选型）、InfluxDB（数据模型与 TSM 引擎、基数治理、降采样、Java 写入、时序库选型）、ClickHouse（MergeTree 与稀疏索引、集群与写入、漏斗留存与近似计算） |
| 中间件 | 消息队列通用问题与平台化治理、Kafka（原理、可靠性、运维、Connect/Streams）、RocketMQ、RabbitMQ、Pulsar、Elasticsearch（原理、实战、运维）、Dubbo、gRPC 与 Protobuf、Nacos 注册与配置中心、ZooKeeper 与 etcd |
| 物联网 | MQTT 协议、EMQX 集群、Java 接入、IoT 平台架构（设备影子、OTA、时序数据）；MQTT 深入（报文字节级、QoS 与会话语义、5.0、弱网与安全排障、协议生态选型） |
| AI 应用 | 全景与学习路线、大模型应用基础、提示词工程与结构化输出、RAG（流水线、文档解析与多模态、检索优化、评估）、Agent 与 MCP（协议深入、工作流编排、上下文工程）、微调实战、评测体系、Spring AI / LangChain4j、LLM 工程化与安全、推理服务原理、**智能客服 / Text-to-SQL / 代码助手架构案例** |
| **AI 模型与数学**（初学者友好） | 线性代数、微积分、概率；机器学习入门；MLP、CNN、RNN/LSTM、Transformer、LLM；模型家族地图与“性格画像” |
| 大数据 | Flink（时间窗口、状态与 Exactly-Once、反压调优）、CDC 与实时数仓、ClickHouse / Doris、Spark 与 Iceberg / Paimon、Flink 内部机制、**电商实时数据平台架构案例** |
| 计算机基础 | 操作系统（进程线程与调度、虚拟内存、文件系统与页缓存/零拷贝）、**计算机网络（IP/路由/NAT/MTU、DNS 与 CDN、TCP 深入与 QUIC、容器网络与排障）**、算法（复杂度与数据结构、解题套路、布隆/一致性哈希/限流/Top K 等工程算法） |
| 安全 | 认证授权（Session/JWT/OAuth2/OIDC/SSO、Spring Security）、OWASP 常见漏洞防护、加密签名/HTTPS/密钥管理 |
| 分布式 | CAP/BASE、分布式时钟与 HLC、Raft 与 Paxos 族、复制（主从/多主/无主）、分片与一致性哈希、故障检测与脑裂、分布式事务、幂等设计、数据一致性实战、分布式 ID、限流熔断降级 |
| 网络与运维 | TCP/HTTP、IO 模型与 Netty（源码与实战）、Linux 排查、**可观测性（Prometheus/Micrometer、OpenTelemetry 链路、日志、SLO）**、Nginx、Docker、Kubernetes、**CI/CD 与 GitOps、发布策略（灰度/蓝绿/特性开关/数据库变更）** |
| 系统设计 | 高并发方法论、**架构专题（高可用与容灾、异地多活、整洁架构、多租户 SaaS、API 设计）**、秒杀系统、**DDD（战略/战术）、事件驱动与 Saga、CQRS 与事件溯源**、**架构案例（订单支付对账、即时通讯、短链接、Feed 流与排行榜、搜索、分布式任务调度、API 网关、推荐系统、分布式对象存储、实时消息推送、高并发写入与热点治理、直播系统）、工程能力（压测与容量规划、稳定性与混沌工程、事故响应与复盘、技术方案与 ADR）**、面试速查 |

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
3. 运行 `python tools/build_index.py` 刷新搜索索引，并用 `python tools/check.py` 自检；修改了 `assets/` 下的文件时，把 `index.html` 里的 `?v=` 版本号加一，避免浏览器缓存旧版本；
4. 提交并推送，GitHub Pages 自动更新。

## 校验与索引

- `python tools/check.py`：校验页面登记、H1 与导航标题一致、SVG 图解规范、站内链接、孤儿页面、搜索索引是否最新（GitHub Actions 在每次推送时自动运行）；
- `python tools/build_index.py`：重新生成 `assets/search-index.json`（新增或修改笔记后必须运行并一并提交，浏览器搜索只下载这一个文件）；
- `python tools/gen_home.py`：重新生成首页「技术全景」图（修改脚本顶部的行与方块列表）。
