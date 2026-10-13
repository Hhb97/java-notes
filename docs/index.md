<div class="hero">
<div class="eyebrow">Senior Java Backend Notes</div>
<h1>Java 后端工程师知识库</h1>
<p>面向 3～5 年以上 Java 后端工程师的深度笔记：从 JVM 与并发原理，到 Spring、MySQL/PG/MongoDB/TiDB、Redis、消息队列与 gRPC，再到分布式、DDD 与事件驱动、安全、可观测、CI/CD 与系统设计，另含 AI 应用、大数据与计算机基础。每篇包含源码级原理、SVG 图解、生产踩坑和面试追问。</p>
</div>

<div id="home-stats"></div>

## 技术全景

一个典型 Java 后端系统从接入、服务、架构设计、中间件、存储，到数据与 AI、基础设施的分层，以及贯穿其中的分布式、可观测、交付与安全能力。图中方块可点击跳转。

<figure class="fig">
<svg viewBox="0 0 760 778" class="dg" role="img" aria-label="Java 后端技术栈分层全景">
<rect class="b" x="20" y="20" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="70" text-anchor="middle" dominant-baseline="middle">接入层</text>
<rect class="bg" x="124" y="20" width="502" height="100" rx="10"/>
<a href="#/infra/network"><rect class="b1" x="136" y="32" width="44" height="36" rx="7"/><text class="t" x="158" y="50" text-anchor="middle" dominant-baseline="middle">CDN</text></a>
<a href="#/infra/nginx"><rect class="b1" x="188" y="32" width="105" height="36" rx="7"/><text class="t" x="240" y="50" text-anchor="middle" dominant-baseline="middle">Nginx / LVS</text></a>
<a href="#/spring/cloud"><rect class="b1" x="301" y="32" width="75" height="36" rx="7"/><text class="t" x="338" y="50" text-anchor="middle" dominant-baseline="middle">Gateway</text></a>
<a href="#/security/auth"><rect class="b1" x="384" y="32" width="119" height="36" rx="7"/><text class="t" x="443" y="50" text-anchor="middle" dominant-baseline="middle">OAuth2 · JWT</text></a>
<a href="#/security/crypto"><rect class="b1" x="136" y="76" width="111" height="36" rx="7"/><text class="t" x="191" y="94" text-anchor="middle" dominant-baseline="middle">HTTPS · TLS</text></a>
<rect class="b" x="20" y="132" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="182" text-anchor="middle" dominant-baseline="middle">服务层</text>
<rect class="bg" x="124" y="132" width="502" height="100" rx="10"/>
<a href="#/spring/boot"><rect class="b2" x="136" y="144" width="105" height="36" rx="7"/><text class="t" x="188" y="162" text-anchor="middle" dominant-baseline="middle">Spring Boot</text></a>
<a href="#/spring/mvc"><rect class="b2" x="249" y="144" width="98" height="36" rx="7"/><text class="t" x="298" y="162" text-anchor="middle" dominant-baseline="middle">Spring MVC</text></a>
<a href="#/spring/cloud"><rect class="b2" x="355" y="144" width="90" height="36" rx="7"/><text class="t" x="400" y="162" text-anchor="middle" dominant-baseline="middle">OpenFeign</text></a>
<a href="#/mw/grpc"><rect class="b2" x="453" y="144" width="52" height="36" rx="7"/><text class="t" x="479" y="162" text-anchor="middle" dominant-baseline="middle">gRPC</text></a>
<a href="#/mw/dubbo"><rect class="b2" x="513" y="144" width="60" height="36" rx="7"/><text class="t" x="543" y="162" text-anchor="middle" dominant-baseline="middle">Dubbo</text></a>
<a href="#/distributed/governance"><rect class="b2" x="136" y="188" width="82" height="36" rx="7"/><text class="t" x="177" y="206" text-anchor="middle" dominant-baseline="middle">Sentinel</text></a>
<a href="#/spring/cloud"><rect class="b2" x="226" y="188" width="60" height="36" rx="7"/><text class="t" x="256" y="206" text-anchor="middle" dominant-baseline="middle">Nacos</text></a>
<rect class="b" x="20" y="244" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="294" text-anchor="middle" dominant-baseline="middle">架构层</text>
<rect class="bg" x="124" y="244" width="502" height="100" rx="10"/>
<a href="#/design/ddd-strategic"><rect class="b4" x="136" y="256" width="119" height="36" rx="7"/><text class="t" x="195" y="274" text-anchor="middle" dominant-baseline="middle">DDD 限界上下文</text></a>
<a href="#/design/ddd-tactical"><rect class="b4" x="263" y="256" width="131" height="36" rx="7"/><text class="t" x="328" y="274" text-anchor="middle" dominant-baseline="middle">聚合 · 领域事件</text></a>
<a href="#/design/event-driven"><rect class="b4" x="402" y="256" width="135" height="36" rx="7"/><text class="t" x="469" y="274" text-anchor="middle" dominant-baseline="middle">事件驱动 · Saga</text></a>
<a href="#/design/cqrs-es"><rect class="b4" x="545" y="256" width="52" height="36" rx="7"/><text class="t" x="571" y="274" text-anchor="middle" dominant-baseline="middle">CQRS</text></a>
<a href="#/design/case-payment"><rect class="b4" x="136" y="300" width="127" height="36" rx="7"/><text class="t" x="199" y="318" text-anchor="middle" dominant-baseline="middle">支付 · IM 案例</text></a>
<rect class="b" x="20" y="356" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="406" text-anchor="middle" dominant-baseline="middle">中间件</text>
<rect class="bg" x="124" y="356" width="502" height="100" rx="10"/>
<a href="#/redis/overview"><rect class="b3" x="136" y="368" width="60" height="36" rx="7"/><text class="t" x="166" y="386" text-anchor="middle" dominant-baseline="middle">Redis</text></a>
<a href="#/mw/kafka"><rect class="b3" x="204" y="368" width="60" height="36" rx="7"/><text class="t" x="234" y="386" text-anchor="middle" dominant-baseline="middle">Kafka</text></a>
<a href="#/mw/rocketmq"><rect class="b3" x="272" y="368" width="82" height="36" rx="7"/><text class="t" x="313" y="386" text-anchor="middle" dominant-baseline="middle">RocketMQ</text></a>
<a href="#/mw/es"><rect class="b3" x="362" y="368" width="120" height="36" rx="7"/><text class="t" x="422" y="386" text-anchor="middle" dominant-baseline="middle">Elasticsearch</text></a>
<a href="#/iot/mqtt"><rect class="b3" x="490" y="368" width="52" height="36" rx="7"/><text class="t" x="516" y="386" text-anchor="middle" dominant-baseline="middle">MQTT</text></a>
<a href="#/spring/mybatis"><rect class="b3" x="136" y="412" width="75" height="36" rx="7"/><text class="t" x="173" y="430" text-anchor="middle" dominant-baseline="middle">MyBatis</text></a>
<rect class="b" x="20" y="468" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="518" text-anchor="middle" dominant-baseline="middle">存储层</text>
<rect class="bg" x="124" y="468" width="502" height="100" rx="10"/>
<a href="#/mysql/architecture"><rect class="b5" x="136" y="480" width="134" height="36" rx="7"/><text class="t" x="203" y="498" text-anchor="middle" dominant-baseline="middle">MySQL · InnoDB</text></a>
<a href="#/mysql/replication"><rect class="b5" x="278" y="480" width="76" height="36" rx="7"/><text class="t" x="316" y="498" text-anchor="middle" dominant-baseline="middle">主从复制</text></a>
<a href="#/mysql/sharding"><rect class="b5" x="362" y="480" width="128" height="36" rx="7"/><text class="t" x="426" y="498" text-anchor="middle" dominant-baseline="middle">ShardingSphere</text></a>
<a href="#/pg/architecture"><rect class="b5" x="498" y="480" width="98" height="36" rx="7"/><text class="t" x="547" y="498" text-anchor="middle" dominant-baseline="middle">PostgreSQL</text></a>
<a href="#/db/mongo-model"><rect class="b5" x="136" y="524" width="75" height="36" rx="7"/><text class="t" x="173" y="542" text-anchor="middle" dominant-baseline="middle">MongoDB</text></a>
<a href="#/db/tidb-arch"><rect class="b5" x="219" y="524" width="52" height="36" rx="7"/><text class="t" x="245" y="542" text-anchor="middle" dominant-baseline="middle">TiDB</text></a>
<a href="#/db/influx-model"><rect class="b5" x="279" y="524" width="82" height="36" rx="7"/><text class="t" x="320" y="542" text-anchor="middle" dominant-baseline="middle">InfluxDB</text></a>
<a href="#/bigdata/ck-engine"><rect class="b5" x="369" y="524" width="98" height="36" rx="7"/><text class="t" x="418" y="542" text-anchor="middle" dominant-baseline="middle">ClickHouse</text></a>
<rect class="b" x="20" y="580" width="92" height="56" rx="10"/>
<text class="tb" x="66" y="608" text-anchor="middle" dominant-baseline="middle">数据与 AI</text>
<rect class="bg" x="124" y="580" width="502" height="56" rx="10"/>
<a href="#/bigdata/flink-core"><rect class="b1" x="136" y="592" width="60" height="36" rx="7"/><text class="t" x="166" y="610" text-anchor="middle" dominant-baseline="middle">Flink</text></a>
<a href="#/bigdata/olap"><rect class="b1" x="204" y="592" width="52" height="36" rx="7"/><text class="t" x="230" y="610" text-anchor="middle" dominant-baseline="middle">OLAP</text></a>
<a href="#/ai/rag"><rect class="b1" x="264" y="592" width="44" height="36" rx="7"/><text class="t" x="286" y="610" text-anchor="middle" dominant-baseline="middle">RAG</text></a>
<a href="#/ai/agent"><rect class="b1" x="316" y="592" width="60" height="36" rx="7"/><text class="t" x="346" y="610" text-anchor="middle" dominant-baseline="middle">Agent</text></a>
<a href="#/ai/spring-ai"><rect class="b1" x="384" y="592" width="90" height="36" rx="7"/><text class="t" x="429" y="610" text-anchor="middle" dominant-baseline="middle">Spring AI</text></a>
<a href="#/aimodel/llm"><rect class="b1" x="482" y="592" width="79" height="36" rx="7"/><text class="t" x="521" y="610" text-anchor="middle" dominant-baseline="middle">LLM 原理</text></a>
<rect class="b" x="20" y="648" width="92" height="100" rx="10"/>
<text class="tb" x="66" y="698" text-anchor="middle" dominant-baseline="middle">基础层</text>
<rect class="bg" x="124" y="648" width="502" height="100" rx="10"/>
<a href="#/java/jvm/memory"><rect class="b" x="136" y="660" width="44" height="36" rx="7"/><text class="t" x="158" y="678" text-anchor="middle" dominant-baseline="middle">JVM</text></a>
<a href="#/java/concurrency/thread"><rect class="b" x="188" y="660" width="76" height="36" rx="7"/><text class="t" x="226" y="678" text-anchor="middle" dominant-baseline="middle">并发编程</text></a>
<a href="#/cs/os-process"><rect class="b" x="272" y="660" width="76" height="36" rx="7"/><text class="t" x="310" y="678" text-anchor="middle" dominant-baseline="middle">操作系统</text></a>
<a href="#/cs/algo-ds"><rect class="b" x="356" y="660" width="49" height="36" rx="7"/><text class="t" x="380" y="678" text-anchor="middle" dominant-baseline="middle">算法</text></a>
<a href="#/infra/netty"><rect class="b" x="413" y="660" width="60" height="36" rx="7"/><text class="t" x="443" y="678" text-anchor="middle" dominant-baseline="middle">Netty</text></a>
<a href="#/infra/linux"><rect class="b" x="481" y="660" width="60" height="36" rx="7"/><text class="t" x="511" y="678" text-anchor="middle" dominant-baseline="middle">Linux</text></a>
<a href="#/infra/docker"><rect class="b" x="136" y="704" width="67" height="36" rx="7"/><text class="t" x="169" y="722" text-anchor="middle" dominant-baseline="middle">Docker</text></a>
<a href="#/infra/k8s"><rect class="b" x="211" y="704" width="98" height="36" rx="7"/><text class="t" x="260" y="722" text-anchor="middle" dominant-baseline="middle">Kubernetes</text></a>
<rect class="b4" x="640" y="20" width="100" height="728" rx="10"/>
<text class="th" x="690" y="48" text-anchor="middle" dominant-baseline="middle">横切能力</text>
<line class="ld" x1="656" y1="66" x2="724" y2="66"/>
<a href="#/distributed/theory"><text class="t" x="690" y="111" text-anchor="middle" dominant-baseline="middle">CAP / BASE</text></a>
<a href="#/distributed/consensus"><text class="t" x="690" y="185" text-anchor="middle" dominant-baseline="middle">Raft 共识</text></a>
<a href="#/distributed/transaction"><text class="t" x="690" y="259" text-anchor="middle" dominant-baseline="middle">分布式事务</text></a>
<a href="#/distributed/id"><text class="t" x="690" y="333" text-anchor="middle" dominant-baseline="middle">分布式 ID</text></a>
<a href="#/redis/lock"><text class="t" x="690" y="408" text-anchor="middle" dominant-baseline="middle">分布式锁</text></a>
<a href="#/distributed/governance"><text class="t" x="690" y="482" text-anchor="middle" dominant-baseline="middle">限流熔断</text></a>
<a href="#/infra/obs-metrics"><text class="t" x="690" y="556" text-anchor="middle" dominant-baseline="middle">可观测性</text></a>
<a href="#/infra/cicd"><text class="t" x="690" y="630" text-anchor="middle" dominant-baseline="middle">CI/CD 发布</text></a>
<a href="#/security/web"><text class="t" x="690" y="704" text-anchor="middle" dominant-baseline="middle">Web 安全</text></a>
<text class="ts" x="380" y="768" text-anchor="middle">请求自上而下穿过各层；右侧能力横跨所有层</text>
</svg>
<figcaption>图 1：Java 后端技术栈分层全景</figcaption>
</figure>

## 知识分类

<div id="home-cats"></div>

## 进阶路线

| 阶段 | 目标 | 重点章节 |
| --- | --- | --- |
| 夯实基础 | 写出正确、可维护的 Java 代码 | [集合体系](#/java/api/collections)、[异常](#/java/api/exception)、[Lambda 与 Stream](#/java/modern/lambda)、[Maven](#/java/eng/maven) |
| 理解运行时 | 能解释「为什么」，能排查线上问题 | [JMM](#/java/concurrency/jmm)、[AQS](#/java/concurrency/aqs)、[线程池](#/java/concurrency/pool)、[GC](#/java/jvm/gc)、[线上排查](#/java/jvm/tuning) |
| 框架原理 | 读懂框架源码，定位框架层问题 | [IoC](#/spring/ioc)、[AOP](#/spring/aop)、[事务](#/spring/tx)、[MyBatis](#/spring/mybatis)、[自动配置](#/spring/boot) |
| 数据层 | 设计索引与表结构，解决一致性与性能 | [B+ 树索引](#/mysql/index)、[MVCC](#/mysql/transaction)、[锁](#/mysql/lock)、[缓存一致性](#/redis/cache) |
| 分布式 | 拆分服务并保证可用与一致 | [消息队列](#/mw/mq)、[分布式事务](#/distributed/transaction)、[限流熔断](#/distributed/governance) |
| 架构设计 | 独立设计高并发系统 | [设计方法论](#/design/method)、[秒杀系统](#/design/seckill)、[面试速查](#/design/interview) |
| 领域建模与事件驱动 | 划分边界、保证跨服务最终一致 | [DDD 战略设计](#/design/ddd-strategic)、[聚合与领域事件](#/design/ddd-tactical)、[Outbox 与 Saga](#/design/event-driven)、[CQRS 与事件溯源](#/design/cqrs-es) |
| 安全与可观测 | 认证授权、漏洞防护，线上能看见、能定位 | [认证授权](#/security/auth)、[Web 安全](#/security/web)、[指标监控](#/infra/obs-metrics)、[链路追踪与 SLO](#/infra/obs-trace) |
| 交付与发布 | 安全、可回滚地把变更送上线 | [CI/CD 与 GitOps](#/infra/cicd)、[发布策略](#/infra/release)、[gRPC](#/mw/grpc) |
| 多种数据库 | 按场景选型 MongoDB、TiDB、时序与分析库 | [MongoDB](#/db/mongo-model)、[TiDB](#/db/tidb-arch)、[InfluxDB](#/db/influx-model)、[ClickHouse](#/bigdata/ck-engine) |
| 计算机基础 | 把线上现象还原到操作系统与网络层 | [进程与调度](#/cs/os-process)、[虚拟内存](#/cs/os-memory)、[网络层](#/cs/net-ip)、[TCP 深入](#/cs/net-tcp)、[网络排障](#/cs/net-debug) |

## 阅读约定

- **页首「核心要点」**：先看结论，再读原理。
- **SVG 图解**：点击可放大，深色模式下同样清晰。
- **提示块**：<b>说明</b>、<b>实践建议</b>、<b>注意</b>、<b>危险操作</b>分别用不同颜色标出。
- **面试追问**：页尾的问题默认折叠，先自己回答，再展开核对。
- 快捷键：<kbd>Ctrl</kbd> + <kbd>K</kbd> 或 <kbd>/</kbd> 打开全文搜索。
