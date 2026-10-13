rows=[
 ("接入层","b1",[("CDN","infra/network"),("Nginx / LVS","infra/nginx"),("Gateway","spring/cloud"),("OAuth2 · JWT","security/auth"),("HTTPS · TLS","security/crypto")]),
 ("服务层","b2",[("Spring Boot","spring/boot"),("Spring MVC","spring/mvc"),("OpenFeign","spring/cloud"),("gRPC","mw/grpc"),("Dubbo","mw/dubbo"),("Sentinel","distributed/governance"),("Nacos","spring/cloud")]),
 ("架构层","b4",[("DDD 限界上下文","design/ddd-strategic"),("聚合 · 领域事件","design/ddd-tactical"),("事件驱动 · Saga","design/event-driven"),("CQRS","design/cqrs-es"),("支付 · IM 案例","design/case-payment")]),
 ("中间件","b3",[("Redis","redis/overview"),("Kafka","mw/kafka"),("RocketMQ","mw/rocketmq"),("Elasticsearch","mw/es"),("MQTT","iot/mqtt"),("MyBatis","spring/mybatis")]),
 ("存储层","b5",[("MySQL · InnoDB","mysql/architecture"),("主从复制","mysql/replication"),("ShardingSphere","mysql/sharding"),("PostgreSQL","pg/architecture"),("MongoDB","db/mongo-model"),("TiDB","db/tidb-arch"),("InfluxDB","db/influx-model"),("ClickHouse","bigdata/ck-engine")]),
 ("数据与 AI","b1",[("Flink","bigdata/flink-core"),("OLAP","bigdata/olap"),("RAG","ai/rag"),("Agent","ai/agent"),("Spring AI","ai/spring-ai"),("LLM 原理","aimodel/llm")]),
 ("基础层","b",[("JVM","java/jvm/memory"),("并发编程","java/concurrency/thread"),("操作系统","cs/os-process"),("算法","cs/algo-ds"),("Netty","infra/netty"),("Linux","infra/linux"),("Docker","infra/docker"),("Kubernetes","infra/k8s")]),
]
right=[("CAP / BASE","distributed/theory"),("Raft 共识","distributed/consensus"),("分布式事务","distributed/transaction"),("分布式 ID","distributed/id"),("分布式锁","redis/lock"),("限流熔断","distributed/governance"),("可观测性","infra/obs-metrics"),("CI/CD 发布","infra/cicd"),("Web 安全","security/web")]
def w(t): return int(sum(13.5 if ord(ch)>127 else 7.6 for ch in t))+22
INNER=478; X0=136; out=[]; y=20
for name,cls,items in rows:
    lines=[[]]; cur=0
    for t,pth in items:
        ww=w(t)
        if cur+ww>INNER and lines[-1]: lines.append([]); cur=0
        lines[-1].append((t,pth,ww)); cur+=ww+8
    h=12+len(lines)*44
    out.append(f'<rect class="b" x="20" y="{y}" width="92" height="{h}" rx="10"/>')
    out.append(f'<text class="tb" x="66" y="{y+h//2}" text-anchor="middle" dominant-baseline="middle">{name}</text>')
    out.append(f'<rect class="bg" x="124" y="{y}" width="502" height="{h}" rx="10"/>')
    for li,line in enumerate(lines):
        x=X0; yy=y+12+li*44
        for t,pth,ww in line:
            out.append(f'<a href="#/{pth}"><rect class="{cls}" x="{x}" y="{yy}" width="{ww}" height="36" rx="7"/><text class="t" x="{x+ww//2}" y="{yy+18}" text-anchor="middle" dominant-baseline="middle">{t}</text></a>')
            x+=ww+8
    y+=h+12
total=y-12
out.append(f'<rect class="b4" x="640" y="20" width="100" height="{total-20}" rx="10"/>')
out.append('<text class="th" x="690" y="48" text-anchor="middle" dominant-baseline="middle">横切能力</text>')
out.append('<line class="ld" x1="656" y1="66" x2="724" y2="66"/>')
step=(total-20-60)/len(right)
for i,(t,pth) in enumerate(right):
    out.append(f'<a href="#/{pth}"><text class="t" x="690" y="{int(66+step*(i+0.5)+8)}" text-anchor="middle" dominant-baseline="middle">{t}</text></a>')
H=total+30
out.append(f'<text class="ts" x="380" y="{total+20}" text-anchor="middle">请求自上而下穿过各层；右侧能力横跨所有层</text>')
svg=f'<svg viewBox="0 0 760 {H}" class="dg" role="img" aria-label="Java 后端技术栈分层全景">\n'+'\n'.join(out)+'\n</svg>'
p='docs/index.md'
s=open(p,encoding='utf-8',newline='').read().replace('\r\n','\n')
a=s.index('<svg viewBox="0 0 760'); b=s.index('</svg>',a)+6
s=s[:a]+svg+s[b:]
open(p,'w',encoding='utf-8',newline='').write(s.replace('\n','\r\n'))
print(H)
