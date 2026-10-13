---
level: 进阶
tags: [Kubernetes, Pod, Deployment, Service, 探针, 滚动更新, HPA, 优雅停机]
summary: 面向 Java 后端工程师讲清 Kubernetes 的架构、工作负载与 Service 机制，重点是探针、滚动更新与优雅停机、资源限制与 JVM 的配合，以及常见故障排查。
---

# Kubernetes 核心概念

> [!ABSTRACT] 核心要点
> - K8s 是**声明式 + 控制循环**：你声明期望状态（YAML），控制器不断把实际状态调谐到期望状态。
> - **Pod** 是最小调度单元；**Deployment** 管无状态应用的滚动更新；**StatefulSet** 管有状态应用；**Service** 提供稳定访问入口与负载均衡。
> - **三种探针**：`startupProbe`（启动慢的应用）→ `readinessProbe`（决定是否接流量）→ `livenessProbe`（失败则重启）。**readiness 与 liveness 不要用同一个会受下游影响的接口。**
> - 零中断发布依赖：就绪探针 + `preStop` 延迟 + 应用**优雅停机** + `terminationGracePeriodSeconds`。
> - Java 容器要设 **requests/limits**，并让 JVM 按容器内存比例分配堆（`MaxRAMPercentage`），否则容易被 **OOMKilled**。

## 架构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="Kubernetes 架构：控制面与工作节点">
<rect class="bg" x="20" y="20" width="720" height="130" rx="12"/>
<text class="th" x="36" y="44">控制面 Control Plane</text>
<rect class="b1" x="40" y="62" width="150" height="62" rx="8"/>
<text class="tb" x="115" y="84" text-anchor="middle" dominant-baseline="middle">kube-apiserver</text>
<text class="ts" x="115" y="104" text-anchor="middle">唯一入口 · 认证鉴权</text>
<rect class="b3" x="210" y="62" width="130" height="62" rx="8"/>
<text class="tb" x="275" y="84" text-anchor="middle" dominant-baseline="middle">etcd</text>
<text class="ts" x="275" y="104" text-anchor="middle">集群状态存储（Raft）</text>
<rect class="b2" x="360" y="62" width="150" height="62" rx="8"/>
<text class="tb" x="435" y="84" text-anchor="middle" dominant-baseline="middle">scheduler</text>
<text class="ts" x="435" y="104" text-anchor="middle">为 Pod 选择节点</text>
<rect class="b2" x="530" y="62" width="190" height="62" rx="8"/>
<text class="tb" x="625" y="84" text-anchor="middle" dominant-baseline="middle">controller-manager</text>
<text class="ts" x="625" y="104" text-anchor="middle">Deployment/Node 等控制器</text>
<line class="l" x1="190" y1="93" x2="210" y2="93" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="190" width="340" height="150" rx="12"/>
<text class="th" x="36" y="214">Worker Node 1</text>
<rect class="b5" x="40" y="228" width="90" height="42" rx="8"/>
<text class="tb" x="85" y="249" text-anchor="middle" dominant-baseline="middle">kubelet</text>
<rect class="b5" x="140" y="228" width="100" height="42" rx="8"/>
<text class="tb" x="190" y="249" text-anchor="middle" dominant-baseline="middle">kube-proxy</text>
<rect class="b5" x="250" y="228" width="90" height="42" rx="8"/>
<text class="tb" x="295" y="249" text-anchor="middle" dominant-baseline="middle">containerd</text>
<rect class="b4" x="40" y="284" width="130" height="40" rx="8"/>
<text class="t" x="105" y="304" text-anchor="middle" dominant-baseline="middle">Pod: order-1</text>
<rect class="b4" x="190" y="284" width="130" height="40" rx="8"/>
<text class="t" x="255" y="304" text-anchor="middle" dominant-baseline="middle">Pod: order-2</text>
<rect class="bg" x="400" y="190" width="340" height="150" rx="12"/>
<text class="th" x="416" y="214">Worker Node 2</text>
<rect class="b5" x="420" y="228" width="90" height="42" rx="8"/>
<text class="tb" x="465" y="249" text-anchor="middle" dominant-baseline="middle">kubelet</text>
<rect class="b5" x="520" y="228" width="100" height="42" rx="8"/>
<text class="tb" x="570" y="249" text-anchor="middle" dominant-baseline="middle">kube-proxy</text>
<rect class="b5" x="630" y="228" width="90" height="42" rx="8"/>
<text class="tb" x="675" y="249" text-anchor="middle" dominant-baseline="middle">containerd</text>
<rect class="b4" x="420" y="284" width="130" height="40" rx="8"/>
<text class="t" x="485" y="304" text-anchor="middle" dominant-baseline="middle">Pod: stock-1</text>
<line class="la" x1="190" y1="124" x2="190" y2="190" marker-end="url(#arr-a)"/>
<line class="la" x1="530" y1="124" x2="530" y2="190" marker-end="url(#arr-a)"/>
<text class="ts" x="200" y="164">kubelet 监听 apiserver</text>
</svg>
<figcaption>图 1：控制面决策，节点上的 kubelet 执行</figcaption>
</figure>

**一次 `kubectl apply` 发生了什么**：请求到 apiserver（认证、准入）→ 写入 etcd → Deployment 控制器发现期望副本变化，创建 ReplicaSet → ReplicaSet 控制器创建 Pod → scheduler 为 Pod 绑定节点 → 节点上 kubelet 通过 CRI 调用容器运行时拉镜像、启动容器 → 上报状态回 apiserver。所有组件都**只和 apiserver 交互**，通过 watch 机制响应变化。

## 工作负载

| 资源 | 用途 | 要点 |
| --- | --- | --- |
| **Pod** | 一个或多个共享网络与存储的容器 | 同 Pod 容器共用 IP 与 localhost；临时的，IP 会变 |
| **Deployment** | 无状态应用 | 管理 ReplicaSet，实现滚动更新、回滚 |
| **StatefulSet** | 有状态应用（数据库、ZK、Kafka） | 稳定网络标识（`name-0`）、有序启停、独立 PVC |
| **DaemonSet** | 每个节点一个 Pod | 日志采集、监控 agent |
| **Job / CronJob** | 一次性 / 定时任务 | 批处理 |
| **ConfigMap / Secret** | 配置 / 敏感配置 | 注入为环境变量或挂载文件；Secret 默认只是 base64 |

## Service：稳定入口与负载均衡

Pod 会被重建、IP 会变，Service 通过 **label selector** 选中一组 Pod，提供固定的虚拟 IP（ClusterIP）和 DNS 名（`order-svc.default.svc.cluster.local`）。

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="Service 通过 kube-proxy 规则把流量分发到后端 Pod">
<rect class="b" x="20" y="100" width="100" height="44" rx="8"/>
<text class="tb" x="70" y="122" text-anchor="middle" dominant-baseline="middle">客户端 Pod</text>
<line class="l" x1="120" y1="122" x2="200" y2="122" marker-end="url(#arr)"/>
<text class="ts" x="160" y="112" text-anchor="middle">访问</text>
<rect class="b3" x="200" y="86" width="170" height="72" rx="10"/>
<text class="tb" x="285" y="108" text-anchor="middle" dominant-baseline="middle">Service ClusterIP</text>
<text class="tm" x="285" y="130" text-anchor="middle" dominant-baseline="middle">10.96.12.34:80</text>
<text class="ts" x="285" y="190" text-anchor="middle">kube-proxy 在每个节点写入</text>
<text class="ts" x="285" y="208" text-anchor="middle">iptables / IPVS 规则（DNAT）</text>
<line class="l" x1="370" y1="104" x2="470" y2="50" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="122" x2="470" y2="122" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="140" x2="470" y2="194" marker-end="url(#arr)"/>
<rect class="b2" x="470" y="30" width="150" height="40" rx="8"/>
<text class="tm" x="545" y="50" text-anchor="middle" dominant-baseline="middle">Pod 10.244.1.5:8080</text>
<rect class="b2" x="470" y="102" width="150" height="40" rx="8"/>
<text class="tm" x="545" y="122" text-anchor="middle" dominant-baseline="middle">Pod 10.244.2.7:8080</text>
<rect class="b4" x="470" y="174" width="150" height="40" rx="8"/>
<text class="tm" x="545" y="194" text-anchor="middle" dominant-baseline="middle">Pod 10.244.3.2:8080</text>
<text class="ts" x="650" y="194" text-anchor="start">未就绪</text>
<text class="ts" x="650" y="50" text-anchor="start">Endpoints</text>
<text class="ts" x="650" y="122" text-anchor="start">仅 Ready 的 Pod</text>
<text class="ts" x="650" y="214" text-anchor="start">被摘除</text>
</svg>
<figcaption>图 2：Service 只把流量转发给 Ready 的 Pod</figcaption>
</figure>

| 类型 | 说明 |
| --- | --- |
| `ClusterIP`（默认） | 仅集群内访问 |
| `NodePort` | 在每个节点开放端口（30000~32767） |
| `LoadBalancer` | 云厂商负载均衡器，对外暴露 |
| `Headless`（`clusterIP: None`） | 不分配虚拟 IP，DNS 直接返回 Pod IP，StatefulSet 常用 |

- kube-proxy 的两种主要模式：**iptables**（规则线性匹配，服务多时规则爆炸）、**IPVS**（哈希表，大规模更优）；
- **Ingress** 在七层（HTTP）做域名和路径路由，由 Ingress Controller（Nginx、Traefik）实现，类似 [Nginx 与负载均衡](#/infra/nginx) 的集群化；
- Java 客户端用**服务名访问**即可（`http://stock-svc:8080`），也可与 Spring Cloud 组合，见 [Spring Cloud 微服务全景](#/spring/cloud)。

## 探针与 Spring Boot

| 探针 | 作用 | 失败后果 |
| --- | --- | --- |
| `startupProbe` | 应用启动是否完成（慢启动应用） | 失败超限则重启；**成功前其他探针不执行** |
| `readinessProbe` | 是否可以接收流量 | 从 Service Endpoints 中摘除（**不重启**） |
| `livenessProbe` | 进程是否“活着” | 失败则 **重启容器** |

> [!WARNING] 常见事故：liveness 依赖下游
> 若 liveness 调用的接口检查了数据库/Redis，数据库一抖，所有 Pod 同时 liveness 失败被重启，故障被放大成雪崩。**liveness 只检查进程自身**（如 Actuator 的 `liveness` 组），下游依赖放到 readiness。

```yaml
# application.yml
management:
  endpoint.health.probes.enabled: true
  endpoint.health.group.readiness.include: readinessState,db   # 就绪依赖数据库
  endpoint.health.group.liveness.include: livenessState         # 存活只看自身
server.shutdown: graceful
spring.lifecycle.timeout-per-shutdown-phase: 30s
```

## 滚动更新与优雅停机

<figure class="fig">
<svg viewBox="0 0 740 300" class="dg" role="img" aria-label="Pod 终止时的优雅停机时序">
<rect class="b1" x="30" y="20" width="120" height="34" rx="6"/>
<text class="tb" x="90" y="37" text-anchor="middle" dominant-baseline="middle">kubelet / 容器</text>
<rect class="b3" x="270" y="20" width="150" height="34" rx="6"/>
<text class="tb" x="345" y="37" text-anchor="middle" dominant-baseline="middle">Endpoints / Service</text>
<rect class="b2" x="560" y="20" width="120" height="34" rx="6"/>
<text class="tb" x="620" y="37" text-anchor="middle" dominant-baseline="middle">Java 应用</text>
<line class="ld" x1="90" y1="54" x2="90" y2="282"/>
<line class="ld" x1="345" y1="54" x2="345" y2="282"/>
<line class="ld" x1="620" y1="54" x2="620" y2="282"/>
<text class="ta" x="40" y="84" text-anchor="start">① Pod 被标记 Terminating</text>
<line class="l" x1="90" y1="100" x2="345" y2="100" marker-end="url(#arr)"/>
<text class="ts" x="218" y="92" text-anchor="middle">从 Endpoints 摘除（异步传播到各节点）</text>
<line class="l" x1="90" y1="132" x2="90" y2="132"/>
<text class="ts" x="100" y="150" text-anchor="start">② 执行 preStop：sleep 10</text>
<text class="ts" x="100" y="168" text-anchor="start">等待摘除规则在集群生效</text>
<line class="l" x1="90" y1="196" x2="620" y2="196" marker-end="url(#arr)"/>
<text class="ts" x="355" y="188" text-anchor="middle">③ 发送 SIGTERM</text>
<text class="t" x="400" y="226" text-anchor="start">④ 优雅停机：拒绝新请求，处理完在途请求</text>
<line class="l" x1="620" y1="250" x2="90" y2="250" marker-end="url(#arr)"/>
<text class="ts" x="355" y="242" text-anchor="middle">⑤ 进程正常退出（超时则 SIGKILL）</text>
<text class="ts" x="370" y="276" text-anchor="middle">总时长必须小于 terminationGracePeriodSeconds（默认 30s）</text>
</svg>
<figcaption>图 3：preStop 缓冲 + SIGTERM 优雅停机，避免滚动更新时请求失败</figcaption>
</figure>

为什么要 `preStop sleep`：摘除 Endpoints 与发送 SIGTERM 是**并行**发生的，规则传播到每个节点的 kube-proxy / Ingress 需要时间，如果立刻停止服务，仍会有流量打到正在退出的 Pod，出现 502/连接拒绝。

滚动更新策略：

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 25%          # 更新期间最多多出的 Pod
    maxUnavailable: 0      # 不允许减少可用 Pod，保证容量
```

回滚：`kubectl rollout undo deployment/order`；查看历史：`kubectl rollout history`。

## 资源与 Java

```yaml
resources:
  requests: { cpu: "500m", memory: "1Gi" }     # 调度依据，保证值
  limits:   { cpu: "2",    memory: "1Gi" }     # 上限；memory 超限被 OOMKilled
```

| 要点 | 说明 |
| --- | --- |
| QoS 等级 | requests=limits 为 **Guaranteed**（最后被驱逐）；有 requests 小于 limits 为 Burstable；都没设为 BestEffort（最先被驱逐） |
| 内存 | 容器内存限制 = **堆 + 元空间 + 线程栈 + 堆外 + JVM 自身**，`-Xmx` 不能等于 limit；用 `-XX:MaxRAMPercentage=70` 留余量 |
| CPU | limit 触发 **CFS 限流（throttling）**，表现为延迟抖动；JVM 根据 limit 推算 `availableProcessors`，影响线程池与 GC 线程数 |
| 查看 | `kubectl top pod`；`kubectl describe pod` 看 `Last State: OOMKilled` |

## 一份完整的 Java 应用部署

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order
spec:
  replicas: 3
  selector:
    matchLabels: { app: order }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 25%, maxUnavailable: 0 }
  template:
    metadata:
      labels: { app: order }
    spec:
      terminationGracePeriodSeconds: 45
      containers:
        - name: app
          image: registry.example.com/order:1.4.2
          ports: [{ containerPort: 8080 }]
          env:
            - name: JAVA_TOOL_OPTIONS
              value: "-XX:MaxRAMPercentage=70 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dump"
            - name: SPRING_PROFILES_ACTIVE
              value: prod
          envFrom:
            - configMapRef: { name: order-config }
            - secretRef:    { name: order-secret }
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits:   { cpu: "2",  memory: 1Gi }
          startupProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            failureThreshold: 30
            periodSeconds: 5
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /actuator/health/liveness, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec: { command: ["sh", "-c", "sleep 10"] }
---
apiVersion: v1
kind: Service
metadata: { name: order-svc }
spec:
  selector: { app: order }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: order }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: order }
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 65 } }
```

HPA 根据 CPU/内存或自定义指标自动扩缩副本；扩容的前提是 **requests 设置合理**（利用率 = 实际 / requests）。

## 常见故障排查

| 状态 | 含义 | 排查 |
| --- | --- | --- |
| `Pending` | 无法调度 | `kubectl describe pod`：资源不足、节点亲和/污点、PVC 未绑定 |
| `ImagePullBackOff` | 镜像拉取失败 | 镜像名/tag、私有仓库凭据（imagePullSecrets）、网络 |
| `CrashLoopBackOff` | 容器反复崩溃重启 | `kubectl logs --previous` 看上次崩溃日志；启动参数、配置、依赖不可达 |
| `OOMKilled` | 内存超过 limit 被杀 | 调大 limit / 调小堆占比；排查内存泄漏与堆外内存 |
| `Running` 但不通 | readiness 失败或 Service 选择器不匹配 | `kubectl get endpoints`；探针路径与端口 |
| `Evicted` | 节点资源压力被驱逐 | 设置 requests，避免 BestEffort |

```bash
kubectl get pod -o wide -l app=order
kubectl describe pod order-xxxx          # 看 Events：调度、拉镜像、探针失败
kubectl logs -f order-xxxx -c app --tail=200
kubectl exec -it order-xxxx -- sh        # 进入容器；用 jcmd / arthas 排查
kubectl top pod --containers
kubectl get events --sort-by=.lastTimestamp
```

Java 进程诊断见 [线上调优与故障排查](#/java/jvm/tuning)，镜像构建见 [Docker 容器化](#/infra/docker)。

## 相关阅读

- [容器网络与网络排障：CNI、iptables/IPVS、tcpdump](#/cs/net-debug)：Service 的 iptables/IPVS 与 CNI
- [发布策略：灰度、蓝绿、特性开关与数据库变更](#/infra/release)：滚动、金丝雀与优雅停机
- [CI/CD 流水线与 GitOps](#/infra/cicd)：GitOps 与 Helm
- [DNS 与 CDN：解析流程、缓存与线上坑](#/cs/net-dns)：CoreDNS 与 ndots
- [微服务可观测：Micrometer、链路追踪与排障](#/spring/cloud-observability)：探针与优雅停机在 Spring Boot 中的配置
- [微服务体系的演进：Boot 3、虚拟线程与云原生下的取舍](#/spring/cloud-evolution)：治理能力在 SDK、网格与平台间的取舍

## 面试追问

> [!QUESTION] Pod 的创建流程？
> kubectl 请求到 apiserver 写入 etcd；控制器创建 ReplicaSet 和 Pod 对象；scheduler 监听到未绑定的 Pod 并绑定节点；节点 kubelet 监听到后通过 CRI 拉镜像、创建容器、启动并上报状态。

> [!QUESTION] 三种探针的区别与配置注意点？
> startup 用于慢启动保护；readiness 失败只摘除流量；liveness 失败重启容器。liveness 不应依赖下游，否则下游故障会引起全体重启的连锁反应。

> [!QUESTION] 如何保证滚动更新不丢请求？
> readiness 探针保证新 Pod 就绪后才接流量；maxUnavailable=0 保证容量；preStop 休眠等待摘除生效；应用开启优雅停机处理完在途请求；terminationGracePeriodSeconds 大于上述总时长。

> [!QUESTION] Java 应用在 K8s 中为什么会 OOMKilled？
> 容器内存限制包含堆外内存、元空间、线程栈等，堆设成接近 limit 会超限被内核 OOM 杀掉；应使用 MaxRAMPercentage 留余量，并限制线程数、直接内存。

> [!QUESTION] Service 是怎么做负载均衡的？
> Service 的 ClusterIP 是虚拟地址，kube-proxy 在每个节点用 iptables 或 IPVS 规则做 DNAT，把请求转到 Endpoints 中 Ready 的 Pod；这是四层、连接级的负载均衡，长连接场景下可能不均衡。
