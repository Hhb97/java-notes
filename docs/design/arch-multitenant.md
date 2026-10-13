---
level: 深入
tags: [多租户, SaaS, 租户隔离, 共享表, 独立库, Schema 隔离, 行级安全, 租户上下文, 噪声邻居, 计量计费, 数据驻留, 租户迁移]
summary: 多租户 SaaS 架构设计：租户模型与隔离级别的谱系（共享表/Schema/独立库/独立部署）及取舍、租户识别与上下文传递、数据隔离的实现（ORM 过滤、行级安全、动态数据源）、缓存/消息/搜索/文件/日志的隔离、噪声邻居治理（配额、限流、资源隔离）、租户配置与扩展（元数据驱动）、计量计费、租户生命周期与迁移、安全与合规、监控与成本归因。
---

# 多租户 SaaS 架构：隔离、治理与运营

> [!ABSTRACT] 核心要点
> - **多租户（Multi-tenancy）** = 一套软件实例服务**多个互相隔离的客户（租户）**。目标是**用共享换取成本与运维效率**，同时**保证隔离（数据安全、性能、可用性、个性化）**。所有设计都在**“共享程度 vs 隔离强度”**这条轴上取舍。
> - **隔离谱系**：**共享表 + tenant_id**（成本最低、隔离最弱、大租户难迁）→ **共享库独立 Schema**（中间态）→ **独立数据库**（隔离强、成本高、数量受限）→ **独立部署（Silo）**（最强隔离，成本与运维最高，面向大客户/私有化）。**主流是分层混合**：**绝大多数中小租户共享池，大/高价值/合规要求高的租户独占资源**，并保证**同一套代码能无痛迁移租户**。
> - **租户上下文（Tenant Context）是整个体系的脊梁**：请求入口**识别租户**（域名/Token/Header）→ **全链路透传**（线程、异步、MQ、RPC）→ **数据访问强制带租户条件**。**最危险的缺陷是“漏掉租户条件导致跨租户读写”**，必须用**框架层统一拦截 + 测试 + 数据库层兜底（行级安全）**，而不是靠开发者自觉。
> - **噪声邻居（Noisy Neighbor）** 是共享架构的头号运营问题：一个租户的突发流量/大查询拖垮其他租户。对策：**租户级限流与配额、资源隔离（线程池/连接池/队列分组）、公平调度、租户分层与迁移、慢查询与大任务隔离**。
> - **多租户不只是数据库**：缓存、消息、搜索、文件、日志、配置、定时任务、权限、加密密钥、监控、计费都要**租户感知**。
> - **可运营性**决定 SaaS 成败：**自助开通、租户级配置与灰度、计量与计费、租户级备份恢复与删除（合规）、成本归因与容量规划**。

## 租户模型与隔离级别

<figure class="fig">
<svg viewBox="0 0 760 340" class="dg" role="img" aria-label="多租户隔离谱系：共享库共享表通过租户 ID 区分，成本最低隔离最弱；共享库独立 Schema 每租户一套表；独立数据库每租户一个库；独立部署每租户整套应用与数据；隔离强度、成本、运维复杂度、可定制性沿谱系递增；混合模式把大租户放独立资源，小租户共享">
<rect class="b3" x="20" y="14" width="170" height="150" rx="10"/>
<text class="tb" x="105" y="34" text-anchor="middle" dominant-baseline="middle">① 共享表</text>
<text class="ts" x="105" y="60" text-anchor="middle">同库同表</text>
<text class="ts" x="105" y="80" text-anchor="middle">tenant_id 区分</text>
<text class="ts" x="105" y="108" text-anchor="middle">成本最低</text>
<text class="ts" x="105" y="128" text-anchor="middle">隔离最弱，易串数据</text>
<text class="ts" x="105" y="148" text-anchor="middle">租户数可到百万级</text>
<rect class="b5" x="200" y="14" width="170" height="150" rx="10"/>
<text class="tb" x="285" y="34" text-anchor="middle" dominant-baseline="middle">② 独立 Schema</text>
<text class="ts" x="285" y="60" text-anchor="middle">同库不同 Schema</text>
<text class="ts" x="285" y="80" text-anchor="middle">每租户一套表</text>
<text class="ts" x="285" y="108" text-anchor="middle">隔离较好，可单租户备份</text>
<text class="ts" x="285" y="128" text-anchor="middle">表数量爆炸，DDL 升级难</text>
<text class="ts" x="285" y="148" text-anchor="middle">租户数受限（千级）</text>
<rect class="b1" x="380" y="14" width="170" height="150" rx="10"/>
<text class="tb" x="465" y="34" text-anchor="middle" dominant-baseline="middle">③ 独立数据库</text>
<text class="ts" x="465" y="60" text-anchor="middle">每租户一个库实例/库</text>
<text class="ts" x="465" y="80" text-anchor="middle">应用共享，数据分离</text>
<text class="ts" x="465" y="108" text-anchor="middle">隔离强，性能互不影响</text>
<text class="ts" x="465" y="128" text-anchor="middle">连接与运维成本高</text>
<text class="ts" x="465" y="148" text-anchor="middle">适合中大型租户</text>
<rect class="b4" x="560" y="14" width="180" height="150" rx="10"/>
<text class="tb" x="650" y="34" text-anchor="middle" dominant-baseline="middle">④ 独立部署（Silo）</text>
<text class="ts" x="650" y="60" text-anchor="middle">整套应用 + 数据独占</text>
<text class="ts" x="650" y="80" text-anchor="middle">可私有化/专属集群</text>
<text class="ts" x="650" y="108" text-anchor="middle">隔离与定制最强</text>
<text class="ts" x="650" y="128" text-anchor="middle">成本、运维、升级最重</text>
<text class="ts" x="650" y="148" text-anchor="middle">面向大客户/强合规</text>
<line class="l" x1="20" y1="184" x2="740" y2="184" marker-end="url(#arr)"/>
<text class="ta" x="380" y="176" text-anchor="middle">隔离强度、定制能力、单租户成本、运维复杂度 ↑</text>
<rect class="bg" x="20" y="200" width="720" height="130" rx="8"/>
<text class="th" x="32" y="220">混合分层（最常见的生产形态）</text>
<text class="ts" x="380" y="246" text-anchor="middle">长尾小租户 → 共享池（共享表或共享库）：成本最低，按租户分片到多个池，池满了开新池</text>
<text class="ts" x="380" y="268" text-anchor="middle">大租户/高价值/强合规 → 独立库或独立集群，甚至独立部署；套餐（免费/标准/企业）对应不同隔离级别</text>
<text class="ts" x="380" y="290" text-anchor="middle">关键能力：同一套代码支持多种隔离模式，租户可在共享池与独占资源间迁移（路由表 + 数据迁移工具）</text>
<text class="ts" x="380" y="312" text-anchor="middle">路由层维护“租户 → 数据源/集群”映射，这也是目录式分片在多租户中的应用</text>
</svg>
<figcaption>图 1：多租户隔离谱系与混合分层</figcaption>
</figure>

### 选择依据

| 维度 | 偏共享 | 偏独占 |
| --- | --- | --- |
| **租户规模与数量** | 租户多（万~百万）、单租户数据量小 | 租户少、单租户数据量大 |
| **价值与付费** | 免费/低价、自助 | 高价值企业客户 |
| **合规与安全** | 通用合规 | 金融、医疗、政企，要求数据物理隔离/驻留 |
| **性能互扰容忍** | 可接受一定互扰，有治理 | 要求稳定性能与独立 SLA |
| **定制需求** | 配置化即可 | 需要深度定制/独立版本/独立升级节奏 |
| **运维能力** | 少量集群运维 | 能自动化管理大量独立资源 |
| **成本目标** | 极致单租户成本 | 可承担更高成本 |

> [!TIP] 设计建议
> 一开始就把“**租户 ID 贯穿全栈 + 数据访问层统一入口**”做好，**默认走共享，保留升级为独占的路径**。**很难事后给没有租户概念的系统加租户隔离**，而从共享升级到独占（有租户 ID 的前提下）相对容易。

## 租户识别与上下文

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="租户上下文贯穿请求：入口根据域名、子域名、令牌或请求头识别租户并校验，写入租户上下文；同步线程内通过过滤器和 ThreadLocal 传递；调用下游服务时通过请求头透传；发送消息时写入消息头；异步线程池和定时任务需要显式传递或恢复上下文；数据访问层、缓存、搜索、文件、日志、限流、计量都从租户上下文读取租户 ID；任一环节丢失租户上下文都会导致串租户或失败">
<rect class="b3" x="20" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="85" y="52" text-anchor="middle" dominant-baseline="middle">入口识别</text>
<text class="ts" x="85" y="74" text-anchor="middle">域名/令牌/头</text>
<rect class="b5" x="170" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="235" y="52" text-anchor="middle" dominant-baseline="middle">校验与上下文</text>
<text class="ts" x="235" y="74" text-anchor="middle">租户状态·权限</text>
<rect class="b1" x="320" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="385" y="52" text-anchor="middle" dominant-baseline="middle">全链路透传</text>
<text class="ts" x="385" y="74" text-anchor="middle">线程·RPC·MQ</text>
<rect class="b4" x="470" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="535" y="52" text-anchor="middle" dominant-baseline="middle">数据访问</text>
<text class="ts" x="535" y="74" text-anchor="middle">强制租户条件</text>
<rect class="b2" x="620" y="30" width="120" height="64" rx="8"/>
<text class="tb" x="680" y="52" text-anchor="middle" dominant-baseline="middle">周边设施</text>
<text class="ts" x="680" y="74" text-anchor="middle">缓存·搜索·文件</text>
<line class="l" x1="150" y1="62" x2="170" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="300" y1="62" x2="320" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="450" y1="62" x2="470" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="600" y1="62" x2="620" y2="62" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="116" width="350" height="204" rx="8"/>
<text class="th" x="32" y="136">如何识别租户</text>
<text class="ts" x="195" y="162" text-anchor="middle">子域名/自定义域名：acme.saas.com（B2B 常见）</text>
<text class="ts" x="195" y="184" text-anchor="middle">令牌中的 tenant_id 声明（JWT，服务端签发）</text>
<text class="ts" x="195" y="206" text-anchor="middle">请求头 X-Tenant-Id（仅限内部可信链路）</text>
<text class="ts" x="195" y="228" text-anchor="middle">路径参数 /t/{tenant}/…（简单但易被篡改）</text>
<text class="ts" x="195" y="256" text-anchor="middle">原则：租户 ID 必须来自可信来源，</text>
<text class="ts" x="195" y="276" text-anchor="middle">不能信任请求体/参数里客户端传的租户</text>
<text class="ts" x="195" y="302" text-anchor="middle">令牌里的租户与访问域名的租户要一致性校验</text>
<rect class="b4" x="390" y="116" width="350" height="204" rx="8"/>
<text class="th" x="402" y="136">上下文丢失的高发点</text>
<text class="ts" x="565" y="162" text-anchor="middle">@Async/线程池/CompletableFuture 切换线程</text>
<text class="ts" x="565" y="184" text-anchor="middle">响应式链路（ThreadLocal 失效 → Reactor Context）</text>
<text class="ts" x="565" y="206" text-anchor="middle">消息消费者：未从消息头恢复租户</text>
<text class="ts" x="565" y="228" text-anchor="middle">定时任务/批处理：没有“当前租户”，需循环租户执行</text>
<text class="ts" x="565" y="256" text-anchor="middle">后果：丢失租户 → 查询无条件 → 全表/跨租户数据</text>
<text class="ts" x="565" y="276" text-anchor="middle">对策：缺失租户时 fail-fast（抛异常），而不是默认放行</text>
<text class="ts" x="565" y="302" text-anchor="middle">并用测试覆盖异步与消息路径</text>
</svg>
<figcaption>图 2：租户识别、上下文传递与高发的丢失点</figcaption>
</figure>

```java
// 租户上下文：入口过滤器写入，业务与数据访问读取；缺失即失败
public final class TenantContext {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();
    public static void set(String tenantId) { CURRENT.set(tenantId); }
    public static String require() {                         // 缺失时 fail-fast，绝不返回 null 放行
        String t = CURRENT.get();
        if (t == null) throw new IllegalStateException("Tenant context missing");
        return t;
    }
    public static void clear() { CURRENT.remove(); }         // 请求结束必须清理，防止线程复用串租户
}

@Component
public class TenantFilter extends OncePerRequestFilter {
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        try {
            String tenant = tenantResolver.resolve(req);      // 从域名/令牌解析，并校验一致、租户状态有效
            TenantContext.set(tenant);
            chain.doFilter(req, res);
        } finally {
            TenantContext.clear();                            // 必须清理
        }
    }
}
```

要点：**线程池要用上下文装饰器**（提交任务时捕获、执行时设置、结束清理）；**消息**生产时写租户头，消费时恢复；**定时任务**按租户循环或分片执行，每次设置上下文。

## 数据隔离的实现

### 共享表（tenant_id）

所有业务表加 `tenant_id` 列，**所有查询/更新/删除都必须带条件**，**主键、唯一索引、外键都要把 `tenant_id` 纳入**（唯一约束是 `(tenant_id, 业务唯一键)` 而不是全局唯一）。

**强制过滤的三道防线：**

1. **框架层统一注入**：
   - MyBatis：拦截器（如 MyBatis-Plus 的多租户拦截器）自动给 SQL 追加 `tenant_id = ?`，并对 INSERT 自动填充；
   - Hibernate：`@Filter`/`@TenantId`（新版本）；JPA 的多租户支持；
   - 避免手写 SQL 绕过拦截（原生 SQL、存储过程、报表 SQL 要有专门审查）；
2. **数据库层兜底：行级安全（RLS）**——PostgreSQL 的 Row Level Security：
   ```sql
   ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON orders
       USING (tenant_id = current_setting('app.tenant_id')::bigint);
   -- 应用在每个连接/事务开始时：SET app.tenant_id = '1001';
   ```
   即使应用漏掉条件，数据库也只返回当前租户的行；注意连接池复用时要在**事务开始设置并在结束重置**（`SET LOCAL`）；MySQL 无原生 RLS，可用视图 + 会话变量或代理层实现；
3. **测试与审计**：自动化“跨租户访问”测试（用租户 A 的上下文尝试读写租户 B 的数据，必须失败）；SQL 审计发现缺少租户条件的语句；

### 独立 Schema / 独立数据库

- **动态数据源路由**：`AbstractRoutingDataSource` 按 `TenantContext` 选择数据源；租户 → 数据源的映射保存在**租户目录（Catalog）**中，缓存并可热更新；
- **连接池管理**：租户多时连接数爆炸 —— 按需创建、**LRU 回收**、每租户小连接池、共用数据库代理（连接复用）；
- **Schema 迁移**：一次发布要对**所有租户库/Schema 执行 DDL**，需要**版本化迁移工具（Flyway/Liquibase）+ 批量并行 + 失败隔离与重试 + 租户级版本记录**；与 [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release) 的兼容变更（expand/contract）结合，保证**新旧版本代码同时兼容各租户的不同 Schema 版本**；
- **跨租户查询**（运营统计、平台报表）：通过**数据同步到数仓**（CDC 汇总）完成，而不是直接跨库 JOIN，见 [CDC 与实时数仓架构](#/bigdata/cdc)；
- **备份恢复**：独立库天然支持**租户级备份与恢复**；共享表要做“**按租户导出/恢复**”工具，复杂得多。

### 共享表的常见陷阱

| 陷阱 | 说明与对策 |
| --- | --- |
| **漏掉租户条件** | 原生 SQL、联表查询子查询、批处理、报表；统一拦截 + RLS + 测试 |
| **唯一约束全局化** | 不同租户的“用户名/订单号”冲突；唯一索引含 `tenant_id` |
| **自增主键暴露租户规模/可被枚举** | 使用租户内可预测 ID 会引发越权枚举；对外使用不可猜测 ID，且校验租户 |
| **索引不含 tenant_id** | 大表按 tenant 过滤全表扫；联合索引 `tenant_id` 作为前缀 |
| **大租户数据倾斜** | 一个租户占表的大部分；分区（按 tenant_id）、迁出独立库 |
| **统计/缓存串租户** | 缓存 key 缺少租户前缀 |

## 周边设施的租户隔离

| 组件 | 隔离方式 |
| --- | --- |
| **缓存（Redis）** | key 前缀带租户（`t:{tenant}:…`）；大租户独立实例/库；防止租户 A 的大 key 影响他人，见 [Redis 使用规范与平台化治理](#/redis/governance) |
| **消息队列** | 租户 ID 放消息头；按需**租户分 Topic**或分区键包含租户；大租户独立 Topic/消费组，防止单租户积压拖垮共享 Topic，见 [消息队列平台化与治理](#/mw/mq-governance) |
| **搜索（ES）** | 共享索引 + `tenant_id` 过滤（别名带过滤条件 / 文档级安全）；大租户独立索引；注意分片数量与映射爆炸，见 [ES 集群运维](#/mw/es-ops) |
| **文件/对象存储** | 路径前缀或独立桶，预签名 URL 校验租户；加密密钥分租户，见 [分布式文件/对象存储](#/design/case-objectstore) |
| **日志/追踪/指标** | 日志、span、指标带 `tenant_id` 标签，便于按租户排障与统计；**指标标签基数控制**（海量租户时按“租户分层”聚合，避免时序爆炸） |
| **配置/特性开关** | 租户级配置与开关，见下节 |
| **定时任务/工作流** | 租户级调度、公平分配，见 [案例：分布式任务调度平台](#/design/case-scheduler) |
| **权限/RBAC** | 租户内角色权限，租户管理员；平台管理员与租户管理员分离，见 [微服务安全](#/spring/cloud-security) |
| **加密与密钥** | **每租户独立数据密钥（信封加密）**，主密钥在 KMS；租户退出时销毁密钥即“加密删除”，见 [加密与密钥管理](#/security/crypto) |
| **第三方集成** | 每租户独立的回调地址、凭证、速率配额 |

## 噪声邻居与资源公平

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="噪声邻居治理：识别资源占用异常的租户；在入口按租户限流和配额；服务内按租户或租户分层使用独立线程池连接池队列；数据库层限制慢查询、连接数、大事务，并对重度租户迁移到独占资源；批处理和异步任务做公平调度；监控每租户资源使用，及时发现并告警；套餐化的配额和升级路径">
<rect class="b3" x="20" y="14" width="350" height="146" rx="10"/>
<text class="tb" x="195" y="34" text-anchor="middle" dominant-baseline="middle">入口：限流与配额</text>
<text class="ts" x="195" y="60" text-anchor="middle">按租户的 QPS、并发、带宽、API 额度</text>
<text class="ts" x="195" y="82" text-anchor="middle">按套餐分级（免费/标准/企业）</text>
<text class="ts" x="195" y="104" text-anchor="middle">超限：429 + Retry-After，或排队</text>
<text class="ts" x="195" y="132" text-anchor="middle">突发允许（令牌桶），持续超限则限制</text>
<rect class="b5" x="390" y="14" width="350" height="146" rx="10"/>
<text class="tb" x="565" y="34" text-anchor="middle" dominant-baseline="middle">服务内：资源隔离</text>
<text class="ts" x="565" y="60" text-anchor="middle">按租户/分层的线程池、连接池、队列分组</text>
<text class="ts" x="565" y="82" text-anchor="middle">舱壁：单租户最多占用 X% 的并发</text>
<text class="ts" x="565" y="104" text-anchor="middle">租户级熔断：某租户依赖异常不影响他人</text>
<text class="ts" x="565" y="132" text-anchor="middle">Shuffle Sharding：租户映射到随机子集</text>
<rect class="b1" x="20" y="176" width="350" height="146" rx="10"/>
<text class="tb" x="195" y="196" text-anchor="middle" dominant-baseline="middle">数据与异步任务</text>
<text class="ts" x="195" y="222" text-anchor="middle">慢查询/大查询超时与限制，导出走异步</text>
<text class="ts" x="195" y="244" text-anchor="middle">批处理与队列的公平调度（轮询/加权）</text>
<text class="ts" x="195" y="266" text-anchor="middle">大租户 → 独立库/独立消费组/独立队列</text>
<text class="ts" x="195" y="294" text-anchor="middle">共享池按租户数量与负载均衡</text>
<rect class="b2" x="390" y="176" width="350" height="146" rx="10"/>
<text class="tb" x="565" y="196" text-anchor="middle" dominant-baseline="middle">观测与运营</text>
<text class="ts" x="565" y="222" text-anchor="middle">每租户的资源使用 Top N（CPU、DB、QPS）</text>
<text class="ts" x="565" y="244" text-anchor="middle">异常检测与自动限流/告警</text>
<text class="ts" x="565" y="266" text-anchor="middle">租户分层：达到阈值提示升级套餐或迁移</text>
<text class="ts" x="565" y="294" text-anchor="middle">SLA 与资源承诺按套餐明确</text>
</svg>
<figcaption>图 3：噪声邻居的治理手段</figcaption>
</figure>

要点：

- **默认保护**：新租户默认带合理配额，不是“无限”；**不能让任何一个租户无限制地使用共享资源**；
- **限流维度多层**：全局 → 租户 → 租户内的用户/接口，见 [限流、熔断与降级](#/distributed/governance)、[熔断限流实战](#/spring/cloud-resilience)；
- **公平调度**：队列/批处理避免“大租户一次提交 10 万任务饿死其他租户”——每租户配额 + 轮询取任务；
- **租户迁移作为治理手段**：重度租户迁移到独占资源，对其他租户“腾出空间”，也是商业升级路径；
- **压测要包含多租户场景**：模拟一个租户突发时其他租户的 P99，见 [压测与容量规划](#/design/eng-loadtest)。

## 租户配置、扩展与定制

SaaS 要让不同租户有**不同的功能、流程、字段**，但又不能为每个租户维护一份代码分支。

| 层次 | 做法 |
| --- | --- |
| **功能开关与套餐** | **特性开关**按租户/套餐启用功能；套餐 → 能力清单（Entitlement）集中管理，服务端校验（不能只靠前端隐藏） |
| **租户级配置** | 配置分层：平台默认 → 套餐默认 → 租户覆盖；配置变更有版本、审计与灰度，见 [配置管理与全链路灰度](#/spring/cloud-config-gray) |
| **自定义字段** | **元数据驱动**：① 预留扩展列（`ext1..extN`，简单但受限）② **JSON 列**（灵活，注意索引/校验）③ **EAV（实体-属性-值）表**（灵活但查询复杂、性能差）④ 动态建表/列（独立 Schema 才合适）；字段元数据（类型、校验、展示）存在配置表 |
| **自定义流程/规则** | 工作流引擎/规则引擎按租户加载定义；**插件/扩展点（SPI）**，租户级启用；沙箱执行脚本需严格安全隔离 |
| **UI/品牌定制** | 主题、Logo、域名、邮件模板（租户级资源） |
| **多版本与升级节奏** | 共享架构下**所有租户同一版本滚动**（SaaS 优势），重要变更用**特性开关**分批开放；独立部署租户可有独立节奏，但要控制版本数量（支持成本） |
| **集成与开放平台** | 租户自己的 API Key、Webhook、OAuth 应用，配额与签名，见 [API 设计与演进](#/design/arch-api) |

## 计量、计费与成本归因

| 环节 | 要点 |
| --- | --- |
| **计量（Metering）** | 按租户记录**用量事件**（API 调用数、存储量、活跃用户数、任务数）；事件**幂等、不丢、可审计**，用消息 + 流处理聚合；时间窗口与时区对齐，见 [事件驱动架构](#/design/event-driven) |
| **计费（Billing）** | 套餐、阶梯价、超额计费；账单生成与对账；与支付系统对接，见 [案例：订单、支付与对账系统设计详解](#/design/case-payment) |
| **配额执行** | 计量实时/准实时用于**限额控制**（超限限流或升级提示），与计费用的精确口径可分层（实时近似 + 离线精确） |
| **成本归因（Showback/Chargeback）** | 共享资源的成本按租户的用量（CPU、存储、请求量）分摊，找出**亏损租户**与优化方向；需要租户标签贯穿监控与账单 |
| **容量规划** | 以租户增长模型预测资源；共享池的“**每池租户上限**”与扩池流程 |

## 租户生命周期

<figure class="fig">
<svg viewBox="0 0 760 290" class="dg" role="img" aria-label="租户生命周期：注册与开通（创建租户记录、分配资源、初始化数据与默认配置），运行与变更（套餐升降级、配置变更、扩缩容、迁移），暂停与欠费冻结，退订与数据导出，数据删除与密钥销毁（合规），全过程自动化与审计">
<rect class="b3" x="20" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="62" text-anchor="middle" dominant-baseline="middle">① 开通</text>
<text class="ts" x="75" y="84" text-anchor="middle">资源·初始数据</text>
<rect class="b5" x="145" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="200" y="62" text-anchor="middle" dominant-baseline="middle">② 运行</text>
<text class="ts" x="200" y="84" text-anchor="middle">配置·监控·计量</text>
<rect class="b1" x="270" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="325" y="62" text-anchor="middle" dominant-baseline="middle">③ 变更</text>
<text class="ts" x="325" y="84" text-anchor="middle">升降级·迁移</text>
<rect class="b4" x="395" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="450" y="62" text-anchor="middle" dominant-baseline="middle">④ 暂停</text>
<text class="ts" x="450" y="84" text-anchor="middle">欠费·违规冻结</text>
<rect class="b2" x="520" y="40" width="110" height="64" rx="8"/>
<text class="tb" x="575" y="62" text-anchor="middle" dominant-baseline="middle">⑤ 退订</text>
<text class="ts" x="575" y="84" text-anchor="middle">数据导出</text>
<rect class="b3" x="645" y="40" width="95" height="64" rx="8"/>
<text class="tb" x="692" y="62" text-anchor="middle" dominant-baseline="middle">⑥ 删除</text>
<text class="ts" x="692" y="84" text-anchor="middle">合规销毁</text>
<line class="l" x1="130" y1="72" x2="145" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="255" y1="72" x2="270" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="72" x2="395" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="505" y1="72" x2="520" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="630" y1="72" x2="645" y2="72" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="124" width="720" height="154" rx="8"/>
<text class="th" x="32" y="144">要点</text>
<text class="ts" x="380" y="170" text-anchor="middle">开通自动化：自助注册后秒级可用；创建租户记录 → 分配（或选择共享池）→ 执行初始化脚本 → 默认配置与管理员账号</text>
<text class="ts" x="380" y="192" text-anchor="middle">迁移：租户在共享池之间、共享池与独占资源之间搬迁——数据同步、短暂只读、路由切换、校验</text>
<text class="ts" x="380" y="214" text-anchor="middle">暂停/冻结：读写策略（只读/全禁用）、数据保留期；欠费通知与恢复流程</text>
<text class="ts" x="380" y="236" text-anchor="middle">退订与删除：数据导出（可携带权，如 GDPR），保留期后彻底删除（含备份、日志、缓存、搜索、文件），并销毁租户密钥（加密删除）</text>
<text class="ts" x="380" y="258" text-anchor="middle">全过程由平台控制面（Control Plane）驱动，状态机化、可重试、有审计；数据面（Data Plane）处理业务请求</text>
</svg>
<figcaption>图 4：租户生命周期</figcaption>
</figure>

**控制面与数据面分离**：租户管理、开通、计费、套餐、路由目录等**控制面**独立服务，高可用；业务请求走**数据面**，通过缓存的租户目录路由；控制面短暂不可用不应影响数据面（数据面使用本地缓存）。

## 安全与合规

| 方面 | 做法 |
| --- | --- |
| **跨租户越权（IDOR）** | 所有资源访问同时校验租户与资源归属，见 [微服务安全](#/spring/cloud-security)；使用不可枚举的 ID；越权测试自动化 |
| **租户管理员与平台管理员** | 权限分层；平台人员访问租户数据需**审批与审计**（“玻璃破碎”机制），默认不可见 |
| **数据加密** | 传输加密；静态加密；**每租户独立数据密钥**（KMS 信封加密），支持**BYOK（客户自带密钥）**的高端需求 |
| **数据驻留与合规** | 租户数据按地域存放（欧盟/中国等）；路由层按租户归属地域；跨境传输限制；审计日志 |
| **审计日志** | 租户级操作审计，租户可查看自己的；平台级审计不可篡改 |
| **身份集成** | 租户自带 IdP（SAML/OIDC 单点登录）、SCIM 用户同步，见 [认证与授权](#/security/auth) |
| **租户内用户/数据隔离** | 租户内部也有部门/角色级权限（RBAC/ABAC） |
| **滥用防护** | 防刷、反欺诈、内容安全、资源滥用（挖矿）检测，免费租户重点 |
| **供应链与第三方插件** | 租户安装扩展的沙箱与权限边界 |

## 监控、运维与发布

- **租户维度的可观测**：指标/日志/追踪带租户标签（注意基数）；**租户健康视图**（错误率、延迟、配额使用）；客服/运营能按租户排障；
- **租户级 SLA 与告警**：企业租户单独告警与专属支持；
- **发布策略**：多租户共享时，**按租户分批灰度**（先内部租户、再小租户、最后大客户），出问题回滚影响小；特性开关按租户放量，见 [配置管理与全链路灰度](#/spring/cloud-config-gray)；
- **数据库变更**：对大量租户库/Schema 的批量迁移，要有**进度跟踪、失败重试、兼容双版本**；
- **容量与池管理**：共享池水位、扩新池、租户在池间的再平衡；
- **灾备**：按租户/池的备份与恢复演练；**租户级恢复（时间点）** 是常见客户诉求，设计之初就要考虑可行性。

## 常见坑

| 坑 | 说明与对策 |
| --- | --- |
| **漏租户条件，串数据** | 最严重的安全事故；统一拦截 + RLS + 跨租户测试 + SQL 审计 |
| **线程池/异步/消息丢租户上下文** | 串租户或失败；装饰线程池，消息头携带，缺失即 fail-fast |
| **ThreadLocal 未清理** | 线程复用导致下个请求带上上个租户；finally 清理 |
| **缓存 key 不含租户** | 租户 A 读到租户 B 的缓存；统一 key 构造器强制前缀 |
| **唯一索引全局唯一** | 不同租户数据冲突；索引含 tenant_id |
| **大租户拖垮共享池** | 无配额与隔离；限流、迁出、分层 |
| **每租户一个库，连接数爆炸** | 连接池失控；按需连接、LRU、代理 |
| **Schema 升级对所有租户一次性执行** | 长时间锁、失败难回滚；分批、兼容双版本、可重试 |
| **平台运营后台能随意查看租户数据** | 合规与信任风险；最小权限、审批、审计 |
| **自定义字段用 EAV 导致性能差** | 查询复杂；热点字段列化，JSON 加生成列索引 |
| **没有租户迁移能力** | 大租户无法迁出，只能硬抗；设计路由目录与迁移工具 |
| **租户删除不彻底** | 备份/日志/缓存残留，合规风险；删除清单与加密删除 |
| **指标标签含 tenant_id 导致基数爆炸** | 租户万级以上时按分层/Top N 聚合，明细放日志 |
| **事后补多租户** | 全栈改造代价巨大；早期就贯穿租户 ID |

## 设计检查清单

- [ ] 是否明确了**隔离级别策略**（共享池 + 独占分层），并保留租户迁移路径？
- [ ] 租户 ID 是否来自**可信来源**并**全链路透传**（线程、RPC、MQ、异步、定时任务）？缺失时是否 fail-fast？
- [ ] 数据访问是否有**统一的租户强制过滤**，并有 **RLS/数据库兜底**与**跨租户自动化测试**？
- [ ] 唯一约束、索引、缓存 key、消息、搜索、文件路径、加密密钥是否都**租户感知**？
- [ ] 是否有**租户级限流、配额、资源隔离与公平调度**，以及大租户迁出机制？
- [ ] 租户配置、特性开关、自定义字段是否**元数据驱动**，而不是分支代码？
- [ ] 是否有**计量、计费、成本归因**？
- [ ] 开通、变更、暂停、退订、删除是否**自动化且合规**（数据导出、加密删除）？
- [ ] 平台人员访问租户数据是否**受审批与审计**？
- [ ] 发布与数据库变更是否**按租户灰度**，监控是否有**租户视角**？

## 相关阅读

- [微服务安全：网关鉴权、服务间认证与令牌传递](#/spring/cloud-security)：租户隔离与越权防护
- [分片、一致性哈希与再平衡](#/distributed/partitioning)：租户目录与数据迁移
- [配置管理与全链路灰度](#/spring/cloud-config-gray)：租户级配置与灰度
- [限流、熔断与降级](#/distributed/governance)：租户级限流与舱壁
- [案例：API 网关设计详解](#/design/case-gateway)：入口租户识别与配额
- [案例：分布式任务调度平台设计详解](#/design/case-scheduler)：租户公平调度

## 面试追问

> [!QUESTION] 多租户的数据隔离有哪几种方案？怎么选？
> 共享表加 tenant_id 成本最低但隔离最弱；独立 Schema 隔离较好但表多、升级难；独立数据库隔离强、性能互不影响但运维和连接成本高；独立部署隔离最强成本最高。生产常用混合分层：大量小租户共享池，大租户或强合规租户独占库或集群，并保证租户能在两者间迁移。

> [!QUESTION] 共享表模式下怎么保证不串租户数据？
> 三道防线：框架层统一拦截（MyBatis 拦截器、Hibernate 过滤器）自动追加租户条件并在插入时填充；数据库层用行级安全兜底（PostgreSQL RLS，事务内设置当前租户）；自动化跨租户越权测试与 SQL 审计。同时唯一约束和索引都要包含 tenant_id，缓存 key 和消息也带租户，缺失租户上下文时直接失败。

> [!QUESTION] 异步线程和消息消费里租户上下文丢了怎么办？
> ThreadLocal 在线程切换后丢失。线程池用上下文装饰器在提交时捕获、执行时设置、结束时清理；消息生产时把租户写入消息头，消费者恢复；定时任务按租户循环并设置上下文；响应式用 Reactor Context。缺失租户时必须抛异常而不是默认放行，并用测试覆盖异步路径。

> [!QUESTION] 什么是噪声邻居？怎么治理？
> 共享资源下某个租户的突发流量或重查询拖垮其他租户。治理手段：入口按租户和套餐限流与配额，服务内按租户或分层做线程池连接池舱壁，慢查询与导出异步限制，批处理公平调度，监控每租户资源 Top N，重度租户迁移到独占资源，并把套餐、配额与升级路径产品化。

> [!QUESTION] 对大量租户库做数据库结构升级有什么挑战？
> 要对所有租户库批量执行 DDL，需要版本化迁移工具、并行执行、失败隔离重试和租户级版本记录；发布期间新旧代码要同时兼容不同租户处于的不同 Schema 版本，所以采用扩展、迁移、收缩的兼容变更，分批灰度并监控进度。

> [!QUESTION] 租户退订后数据怎么删除才合规？
> 先提供数据导出，保留期后删除所有位置的数据，包括主库、备份、日志、缓存、搜索索引和文件存储，并销毁该租户的数据密钥实现加密删除，使残留备份也不可读；整个过程由控制面状态机驱动，有审计与证明。
