<div class="hero">
<div class="eyebrow">Senior Java Backend Notes</div>
<h1>Java 后端工程师知识库</h1>
<p>面向 3～5 年以上 Java 后端工程师的深度笔记：从 JVM 与并发原理，到 Spring、MySQL、Redis、消息队列，再到分布式与系统设计。每篇包含源码级原理、SVG 图解、生产踩坑和面试追问。</p>
</div>

<div id="home-stats"></div>

## 技术全景

一个典型 Java 后端系统从接入到存储的分层，以及贯穿其中的分布式能力。图中方块可点击跳转。

<figure class="fig">
<svg viewBox="0 0 760 392" class="dg" role="img" aria-label="Java 后端技术栈分层全景">
<rect class="b" x="20" y="20" width="92" height="60" rx="10"/>
<text class="tb" x="66" y="50" text-anchor="middle" dominant-baseline="middle">接入层</text>
<rect class="bg" x="124" y="20" width="502" height="60" rx="10"/>
<a href="#/infra/network"><rect class="b1" x="136" y="32" width="64" height="36" rx="7"/><text class="t" x="168" y="50" text-anchor="middle" dominant-baseline="middle">CDN</text></a>
<a href="#/infra/nginx"><rect class="b1" x="208" y="32" width="110" height="36" rx="7"/><text class="t" x="263" y="50" text-anchor="middle" dominant-baseline="middle">Nginx / LVS</text></a>
<a href="#/spring/cloud"><rect class="b1" x="326" y="32" width="180" height="36" rx="7"/><text class="t" x="416" y="50" text-anchor="middle" dominant-baseline="middle">Spring Cloud Gateway</text></a>
<rect class="b" x="20" y="92" width="92" height="60" rx="10"/>
<text class="tb" x="66" y="122" text-anchor="middle" dominant-baseline="middle">服务层</text>
<rect class="bg" x="124" y="92" width="502" height="60" rx="10"/>
<a href="#/spring/boot"><rect class="b2" x="136" y="104" width="108" height="36" rx="7"/><text class="t" x="190" y="122" text-anchor="middle" dominant-baseline="middle">Spring Boot</text></a>
<a href="#/spring/mvc"><rect class="b2" x="252" y="104" width="96" height="36" rx="7"/><text class="t" x="300" y="122" text-anchor="middle" dominant-baseline="middle">Spring MVC</text></a>
<a href="#/spring/cloud"><rect class="b2" x="356" y="104" width="88" height="36" rx="7"/><text class="t" x="400" y="122" text-anchor="middle" dominant-baseline="middle">OpenFeign</text></a>
<a href="#/distributed/governance"><rect class="b2" x="452" y="104" width="80" height="36" rx="7"/><text class="t" x="492" y="122" text-anchor="middle" dominant-baseline="middle">Sentinel</text></a>
<a href="#/spring/cloud"><rect class="b2" x="540" y="104" width="72" height="36" rx="7"/><text class="t" x="576" y="122" text-anchor="middle" dominant-baseline="middle">Nacos</text></a>
<rect class="b" x="20" y="164" width="92" height="60" rx="10"/>
<text class="tb" x="66" y="194" text-anchor="middle" dominant-baseline="middle">中间件</text>
<rect class="bg" x="124" y="164" width="502" height="60" rx="10"/>
<a href="#/redis/overview"><rect class="b3" x="136" y="176" width="72" height="36" rx="7"/><text class="t" x="172" y="194" text-anchor="middle" dominant-baseline="middle">Redis</text></a>
<a href="#/mw/kafka"><rect class="b3" x="216" y="176" width="72" height="36" rx="7"/><text class="t" x="252" y="194" text-anchor="middle" dominant-baseline="middle">Kafka</text></a>
<a href="#/mw/rocketmq"><rect class="b3" x="296" y="176" width="96" height="36" rx="7"/><text class="t" x="344" y="194" text-anchor="middle" dominant-baseline="middle">RocketMQ</text></a>
<a href="#/mw/es"><rect class="b3" x="400" y="176" width="124" height="36" rx="7"/><text class="t" x="462" y="194" text-anchor="middle" dominant-baseline="middle">Elasticsearch</text></a>
<a href="#/spring/mybatis"><rect class="b3" x="532" y="176" width="80" height="36" rx="7"/><text class="t" x="572" y="194" text-anchor="middle" dominant-baseline="middle">MyBatis</text></a>
<rect class="b" x="20" y="236" width="92" height="60" rx="10"/>
<text class="tb" x="66" y="266" text-anchor="middle" dominant-baseline="middle">存储层</text>
<rect class="bg" x="124" y="236" width="502" height="60" rx="10"/>
<a href="#/mysql/architecture"><rect class="b5" x="136" y="248" width="130" height="36" rx="7"/><text class="t" x="201" y="266" text-anchor="middle" dominant-baseline="middle">MySQL · InnoDB</text></a>
<a href="#/mysql/replication"><rect class="b5" x="274" y="248" width="88" height="36" rx="7"/><text class="t" x="318" y="266" text-anchor="middle" dominant-baseline="middle">主从复制</text></a>
<a href="#/mysql/sharding"><rect class="b5" x="370" y="248" width="136" height="36" rx="7"/><text class="t" x="438" y="266" text-anchor="middle" dominant-baseline="middle">ShardingSphere</text></a>
<rect class="b" x="20" y="308" width="92" height="60" rx="10"/>
<text class="tb" x="66" y="338" text-anchor="middle" dominant-baseline="middle">基础层</text>
<rect class="bg" x="124" y="308" width="502" height="60" rx="10"/>
<a href="#/java/jvm/memory"><rect class="b" x="136" y="320" width="56" height="36" rx="7"/><text class="t" x="164" y="338" text-anchor="middle" dominant-baseline="middle">JVM</text></a>
<a href="#/java/concurrency/thread"><rect class="b" x="200" y="320" width="84" height="36" rx="7"/><text class="t" x="242" y="338" text-anchor="middle" dominant-baseline="middle">并发编程</text></a>
<a href="#/infra/netty"><rect class="b" x="292" y="320" width="66" height="36" rx="7"/><text class="t" x="325" y="338" text-anchor="middle" dominant-baseline="middle">Netty</text></a>
<a href="#/infra/linux"><rect class="b" x="366" y="320" width="66" height="36" rx="7"/><text class="t" x="399" y="338" text-anchor="middle" dominant-baseline="middle">Linux</text></a>
<a href="#/infra/docker"><rect class="b" x="440" y="320" width="74" height="36" rx="7"/><text class="t" x="477" y="338" text-anchor="middle" dominant-baseline="middle">Docker</text></a>
<a href="#/infra/k8s"><rect class="b" x="522" y="320" width="90" height="36" rx="7"/><text class="t" x="567" y="338" text-anchor="middle" dominant-baseline="middle">Kubernetes</text></a>
<rect class="b4" x="640" y="20" width="100" height="348" rx="10"/>
<text class="th" x="690" y="52" text-anchor="middle" dominant-baseline="middle">分布式</text>
<line class="ld" x1="656" y1="74" x2="724" y2="74"/>
<a href="#/distributed/theory"><text class="t" x="690" y="104" text-anchor="middle" dominant-baseline="middle">CAP / BASE</text></a>
<a href="#/distributed/consensus"><text class="t" x="690" y="140" text-anchor="middle" dominant-baseline="middle">Raft 共识</text></a>
<a href="#/distributed/transaction"><text class="t" x="690" y="176" text-anchor="middle" dominant-baseline="middle">分布式事务</text></a>
<a href="#/distributed/id"><text class="t" x="690" y="212" text-anchor="middle" dominant-baseline="middle">分布式 ID</text></a>
<a href="#/redis/lock"><text class="t" x="690" y="248" text-anchor="middle" dominant-baseline="middle">分布式锁</text></a>
<a href="#/distributed/governance"><text class="t" x="690" y="284" text-anchor="middle" dominant-baseline="middle">限流熔断</text></a>
<a href="#/design/method"><text class="t" x="690" y="320" text-anchor="middle" dominant-baseline="middle">可观测性</text></a>
<text class="ts" x="380" y="386" text-anchor="middle">请求自上而下穿过各层；右侧能力横跨所有层</text>
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

## 阅读约定

- **页首「核心要点」**：先看结论，再读原理。
- **SVG 图解**：点击可放大，深色模式下同样清晰。
- **提示块**：<b>说明</b>、<b>实践建议</b>、<b>注意</b>、<b>危险操作</b>分别用不同颜色标出。
- **面试追问**：页尾的问题默认折叠，先自己回答，再展开核对。
- 快捷键：<kbd>Ctrl</kbd> + <kbd>K</kbd> 或 <kbd>/</kbd> 打开全文搜索。
