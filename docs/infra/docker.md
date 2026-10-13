---
level: 进阶
tags: [Docker, Namespace, Cgroups, overlay2, Dockerfile, JVM 容器化]
summary: 容器的三大内核基础、镜像分层与写时复制、Java 应用的 Dockerfile 最佳实践、JVM 在容器中的内存与 CPU 感知，以及本地依赖编排与镜像安全
---

# Docker 容器化

> [!ABSTRACT] 核心要点
> - 容器不是轻量虚拟机，而是**宿主机上的普通进程**：Namespace 负责「看不见别人」（隔离），Cgroups 负责「用不超额」（限制），UnionFS 提供分层的根文件系统。所有容器**共享宿主机内核**。
> - 镜像由只读层叠加而成，容器在最上面加一个可写层，修改下层文件时**整文件复制上来（copy-up）**；Dockerfile 指令顺序决定缓存命中率。
> - Java 镜像：**多阶段构建 + Spring Boot 分层 jar + JRE 精简基础镜像 + 非 root 用户 + exec 形式的 ENTRYPOINT**。
> - JVM 8u191+ / 10+ 能识别容器内存与 CPU 限制，默认堆只有容器内存的 1/4；用 `-XX:MaxRAMPercentage` 按比例设置，并为堆外内存留足余量，否则会被 **OOMKilled（exit 137）**，而且 Java 侧没有任何 OOM 日志。
> - CPU limit 是按周期（默认 100ms）配额，GC、JIT 线程的突发很容易触发 **throttling**，表现为 RT 毛刺而不是 CPU 打满。

## 容器与虚拟机

<figure class="fig">
<svg viewBox="0 0 720 300" class="dg" role="img" aria-label="虚拟机每个实例都有独立的 Guest OS 运行在 Hypervisor 上，容器共享宿主机内核，只打包应用和依赖库">
<text class="th" x="180" y="28" text-anchor="middle">虚拟机</text>
<text class="th" x="540" y="28" text-anchor="middle">容器</text>
<rect class="b1" x="20" y="50" width="100" height="34" rx="6"/>
<text class="tb" x="70" y="67" text-anchor="middle" dominant-baseline="middle">App A</text>
<rect class="b1" x="130" y="50" width="100" height="34" rx="6"/>
<text class="tb" x="180" y="67" text-anchor="middle" dominant-baseline="middle">App B</text>
<rect class="b1" x="240" y="50" width="100" height="34" rx="6"/>
<text class="tb" x="290" y="67" text-anchor="middle" dominant-baseline="middle">App C</text>
<rect class="b" x="20" y="90" width="100" height="34" rx="6"/>
<text class="t" x="70" y="107" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b" x="130" y="90" width="100" height="34" rx="6"/>
<text class="t" x="180" y="107" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b" x="240" y="90" width="100" height="34" rx="6"/>
<text class="t" x="290" y="107" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b4" x="20" y="130" width="100" height="34" rx="6"/>
<text class="tb" x="70" y="147" text-anchor="middle" dominant-baseline="middle">Guest OS</text>
<rect class="b4" x="130" y="130" width="100" height="34" rx="6"/>
<text class="tb" x="180" y="147" text-anchor="middle" dominant-baseline="middle">Guest OS</text>
<rect class="b4" x="240" y="130" width="100" height="34" rx="6"/>
<text class="tb" x="290" y="147" text-anchor="middle" dominant-baseline="middle">Guest OS</text>
<rect class="b3" x="20" y="170" width="320" height="34" rx="6"/>
<text class="tb" x="180" y="187" text-anchor="middle" dominant-baseline="middle">Hypervisor（KVM / ESXi）</text>
<rect class="b" x="20" y="210" width="320" height="34" rx="6"/>
<text class="tb" x="180" y="227" text-anchor="middle" dominant-baseline="middle">Host OS</text>
<rect class="b" x="20" y="250" width="320" height="34" rx="6"/>
<text class="tb" x="180" y="267" text-anchor="middle" dominant-baseline="middle">硬件</text>
<rect class="b1" x="380" y="90" width="100" height="34" rx="6"/>
<text class="tb" x="430" y="107" text-anchor="middle" dominant-baseline="middle">App A</text>
<rect class="b1" x="490" y="90" width="100" height="34" rx="6"/>
<text class="tb" x="540" y="107" text-anchor="middle" dominant-baseline="middle">App B</text>
<rect class="b1" x="600" y="90" width="100" height="34" rx="6"/>
<text class="tb" x="650" y="107" text-anchor="middle" dominant-baseline="middle">App C</text>
<rect class="b2" x="380" y="130" width="100" height="34" rx="6"/>
<text class="t" x="430" y="147" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b2" x="490" y="130" width="100" height="34" rx="6"/>
<text class="t" x="540" y="147" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b2" x="600" y="130" width="100" height="34" rx="6"/>
<text class="t" x="650" y="147" text-anchor="middle" dominant-baseline="middle">Bins/Libs</text>
<rect class="b3" x="380" y="170" width="320" height="34" rx="6"/>
<text class="tb" x="540" y="187" text-anchor="middle" dominant-baseline="middle">容器运行时（containerd + runc）</text>
<rect class="b5" x="380" y="210" width="320" height="34" rx="6"/>
<text class="tb" x="540" y="227" text-anchor="middle" dominant-baseline="middle">Host OS 内核：Namespace + Cgroups</text>
<rect class="b" x="380" y="250" width="320" height="34" rx="6"/>
<text class="tb" x="540" y="267" text-anchor="middle" dominant-baseline="middle">硬件</text>
<text class="ts" x="540" y="66" text-anchor="middle">每个容器 = 宿主机上的一组进程</text>
</svg>
<figcaption>图 1：虚拟机虚拟化硬件，容器只隔离进程视图并共享内核</figcaption>
</figure>

| 维度 | 虚拟机 | 容器 |
| --- | --- | --- |
| 隔离级别 | 硬件级，独立内核 | 进程级，共享内核；内核漏洞可能导致逃逸 |
| 启动时间 | 数十秒到分钟 | 毫秒到秒（JVM 启动本身才是大头） |
| 镜像大小 | GB 级 | MB 到数百 MB |
| 资源开销 | 每个实例一套 OS | 接近裸进程 |
| 内核特性 | 可运行不同内核 / 不同 OS | 只能用宿主机内核（Linux 容器跑在 Linux 内核上） |

需要更强隔离（多租户、运行不可信代码）时可用 gVisor、Kata Containers 这类沙箱 / 轻量虚拟机运行时。

## 三大底层技术

### Namespace：隔离

| Namespace | 隔离内容 | 容器内表现 |
| --- | --- | --- |
| PID | 进程号 | 应用是 PID 1，看不到宿主机其他进程 |
| NET | 网卡、IP、路由、iptables、端口 | 独立的 `eth0`、`lo`，可以监听相同端口 |
| MNT | 挂载点 | 独立的根文件系统 |
| UTS | 主机名、域名 | 独立的 hostname |
| IPC | System V IPC、POSIX 消息队列 | 共享内存隔离 |
| USER | UID/GID 映射 | 容器内 root 可映射为宿主机普通用户（Docker 需开启 `userns-remap`） |

新内核还有 Cgroup Namespace 与 Time Namespace。可以用 `lsns`、`ls -l /proc/<pid>/ns` 查看进程所属 namespace；排查时常用 `nsenter -t <容器进程 PID> -n tcpdump -i eth0` 进入容器网络命名空间抓包，而不必在镜像里装工具。

> [!WARNING] PID 1 的特殊性
> PID 1 不会被内核施加默认信号处理：没有显式注册 SIGTERM 处理器的 PID 1 进程会忽略 SIGTERM。另外 PID 1 要负责回收孤儿僵尸进程。JVM 会注册信号处理器，所以 `java` 直接作为 PID 1 能正常响应 `docker stop`；但如果用 shell 形式 `ENTRYPOINT java -jar app.jar`，PID 1 是 `/bin/sh`，信号不会转发给 java，`docker stop` 等满 10 秒后被 SIGKILL，优雅停机完全失效。用 **exec 形式**，或在脚本最后用 `exec java ...`，需要回收子进程时加 `--init`（tini）。

### Cgroups：限制

| 资源 | Docker 参数 | cgroup v2 文件 | 说明 |
| --- | --- | --- | --- |
| 内存 | `--memory=2g` | `memory.max` | 超出触发 cgroup 内的 OOM Killer，容器内进程被 SIGKILL |
| CPU 配额 | `--cpus=2` | `cpu.max`（如 `200000 100000`） | 每 100ms 周期最多使用 200ms CPU 时间，用完即被**节流**到下个周期 |
| CPU 权重 | `--cpu-shares` | `cpu.weight` | 只在争抢时按比例分配，不是上限 |
| 进程数 | `--pids-limit` | `pids.max` | 线程也计数，防 fork 炸弹 |
| 块设备 IO | `--device-read-bps` 等 | `io.max` | 限制磁盘带宽 / IOPS |

主流发行版和 K8s 已转向 **cgroup v2**（统一层级）。查看当前容器的限制与节流情况：

```bash
cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max    # 在容器内（cgroup v2）
cat /sys/fs/cgroup/cpu.stat        # nr_throttled / throttled_usec 持续增长 = 被节流
docker stats --no-stream           # 各容器实时 CPU / 内存
```

### UnionFS：分层文件系统（overlay2）

<figure class="fig">
<svg viewBox="0 0 720 320" class="dg" role="img" aria-label="overlay2 把多个只读镜像层与容器可写层合并为统一视图，修改下层文件时复制到可写层，删除时创建 whiteout 文件">
<rect class="b1" x="20" y="20" width="400" height="40" rx="6"/>
<text class="tb" x="32" y="40" dominant-baseline="middle">merged：容器看到的根目录 /</text>
<rect class="b2" x="20" y="80" width="400" height="44" rx="6"/>
<text class="tb" x="32" y="102" dominant-baseline="middle">upperdir 容器层（可写）</text>
<rect class="b4" x="190" y="88" width="100" height="28" rx="4"/>
<text class="ts" x="240" y="106" text-anchor="middle">whiteout a.txt</text>
<rect class="b3" x="305" y="88" width="105" height="28" rx="4"/>
<text class="ts" x="357" y="106" text-anchor="middle">app.yml（副本）</text>
<rect class="b" x="20" y="144" width="400" height="44" rx="6"/>
<text class="tb" x="32" y="166" dominant-baseline="middle">层 3：COPY app.jar</text>
<rect class="b" x="20" y="200" width="400" height="44" rx="6"/>
<text class="tb" x="32" y="222" dominant-baseline="middle">层 2：RUN 安装工具</text>
<rect class="b" x="190" y="208" width="100" height="28" rx="4"/>
<text class="ts" x="240" y="226" text-anchor="middle">a.txt</text>
<rect class="b" x="20" y="256" width="400" height="44" rx="6"/>
<text class="tb" x="32" y="278" dominant-baseline="middle">层 1：基础镜像 JRE</text>
<rect class="b" x="305" y="264" width="105" height="28" rx="4"/>
<text class="ts" x="357" y="282" text-anchor="middle">app.yml</text>
<line class="la" x1="357" y1="264" x2="357" y2="118" marker-end="url(#arr-a)"/>
<line class="ld" x1="240" y1="208" x2="240" y2="118"/>
<text class="ts" x="430" y="166">lowerdir：只读镜像层，</text>
<text class="ts" x="430" y="182">多个容器共享同一份</text>
<text class="tb" x="460" y="40">读</text>
<text class="ts" x="490" y="40">自上而下找到第一个存在的文件</text>
<text class="tb" x="460" y="94">写</text>
<text class="ts" x="490" y="94">copy-up：整个文件先复制到</text>
<text class="ts" x="490" y="110">upperdir 再修改（大文件代价高）</text>
<text class="tb" x="460" y="230">删</text>
<text class="ts" x="490" y="230">在 upperdir 建 whiteout 遮住下层，</text>
<text class="ts" x="490" y="246">下层文件仍在，镜像不会变小</text>
</svg>
<figcaption>图 2：overlay2 的分层与写时复制（copy-up）、删除（whiteout）</figcaption>
</figure>

- 镜像的每条 `RUN` / `COPY` / `ADD` 指令产生一层，层以内容哈希寻址，多个镜像共享相同的层（如同一个基础镜像只下载一次）。
- **在后面的层删除前面层的文件不会让镜像变小**：`RUN apt-get install ... && rm -rf /var/lib/apt/lists/*` 必须写在同一条 RUN 中。
- 容器层随容器删除而消失，日志、上传文件、数据库数据必须写到**数据卷**；频繁写容器层（尤其是大文件改写）性能差且会把节点磁盘写满。
- `docker history <image>` 看每层大小与生成指令，`docker system df` 看镜像 / 容器 / 卷的磁盘占用。

## Java 应用 Dockerfile 最佳实践

```dockerfile
# syntax=docker/dockerfile:1
# ---------- 构建阶段 ----------
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -q dependency:go-offline   # 依赖层：pom 不变就命中缓存
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -q -DskipTests package
# 拆分 Spring Boot 分层 jar（Boot 3.3+ 用 tools 模式；更早版本为 -Djarmode=layertools -jar app.jar extract）
RUN java -Djarmode=tools -jar target/app.jar extract --layers --launcher --destination /layers

# ---------- 运行阶段 ----------
FROM eclipse-temurin:21-jre
RUN groupadd --system app && useradd --system --gid app app
WORKDIR /app
# 按变化频率从低到高 COPY：依赖几乎不变，业务代码每次都变
COPY --from=build /layers/dependencies/ ./
COPY --from=build /layers/spring-boot-loader/ ./
COPY --from=build /layers/snapshot-dependencies/ ./
COPY --from=build /layers/application/ ./
USER app
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
```

要点：

1. **多阶段构建**：JDK、Maven、源码只存在于构建阶段，最终镜像只有 JRE + 应用，体积和攻击面都小得多。
2. **分层 jar**：Spring Boot 2.3+ 支持把 fat jar 拆成 `dependencies` / `spring-boot-loader` / `snapshot-dependencies` / `application` 四层。只改业务代码时，推送和拉取的只有几百 KB 的 application 层，而不是 100MB 的 fat jar。Spring Boot 3.2 起启动类为 `org.springframework.boot.loader.launch.JarLauncher`（之前是 `org.springframework.boot.loader.JarLauncher`）。
3. **基础镜像**：`eclipse-temurin:21-jre`（Ubuntu，兼容性最好）；`-alpine` 更小但基于 musl libc，个别依赖 glibc 的 native 库（部分 Netty native、字体、性能分析工具）会出问题；`gcr.io/distroless/java21-debian12` 没有 shell 和包管理器，最安全，但排查时无法 `exec` 进去，需配合临时调试容器。
4. **非 root 运行**：`USER app`。容器内 root 一旦逃逸就是宿主机 root。注意挂载卷的目录权限。
5. **exec 形式 ENTRYPOINT**，让 java 成为 PID 1 并直接收到 SIGTERM。
6. **`.dockerignore`** 排除 `target/`、`.git/`、`*.log`，减小构建上下文、避免泄露。
7. 不想写 Dockerfile 时，可用 `mvn spring-boot:build-image`（Cloud Native Buildpacks）或 Jib，它们默认就做了分层和非 root。

> [!CAUTION] 不要把密钥打进镜像
> `ENV DB_PASSWORD=...`、`ARG TOKEN` 以及构建过程中复制进去的配置文件都会永久留在镜像层与 `docker history` 中，任何能拉取镜像的人都能看到。构建期的凭证用 BuildKit `--mount=type=secret`，运行期通过环境变量注入、K8s Secret 或配置中心获取。

## JVM 在容器中

<figure class="fig">
<svg viewBox="0 0 720 210" class="dg" role="img" aria-label="容器内 Java 进程内存由堆和多种堆外内存组成，总和超过容器内存限制时被内核 OOMKilled">
<text class="th" x="20" y="26">Java 进程 RSS 的组成（容器 limit = 2Gi）</text>
<rect class="b1" x="20" y="50" width="420" height="50" rx="6"/>
<text class="tb" x="230" y="68" text-anchor="middle" dominant-baseline="middle">Java 堆</text>
<text class="ts" x="230" y="90" text-anchor="middle">-XX:MaxRAMPercentage=75 → 约 1.5Gi</text>
<rect class="b5" x="440" y="50" width="56" height="50" rx="4"/>
<text class="ts" x="468" y="79" text-anchor="middle">元空间</text>
<rect class="b3" x="496" y="50" width="56" height="50" rx="4"/>
<text class="ts" x="524" y="79" text-anchor="middle">线程栈</text>
<rect class="b3" x="552" y="50" width="48" height="50" rx="4"/>
<text class="ts" x="576" y="72" text-anchor="middle">Code</text>
<text class="ts" x="576" y="88" text-anchor="middle">Cache</text>
<rect class="b4" x="600" y="50" width="100" height="50" rx="4"/>
<text class="ts" x="650" y="72" text-anchor="middle">直接内存泄漏</text>
<text class="ts" x="650" y="88" text-anchor="middle">GC / malloc</text>
<line class="la" x1="600" y1="36" x2="600" y2="120"/>
<text class="ta" x="596" y="136" text-anchor="end">memory limit</text>
<text class="ts" x="650" y="136" text-anchor="middle">超出部分</text>
<line class="l" x1="650" y1="142" x2="650" y2="158" marker-end="url(#arr)"/>
<text class="ts" x="700" y="176" text-anchor="end">cgroup OOM → SIGKILL → OOMKilled（exit 137）</text>
<text class="ts" x="20" y="200">堆只是 RSS 的一部分：堆外超出 limit 时内核直接杀进程，Java 侧不会抛 OutOfMemoryError，也不会生成 heap dump</text>
</svg>
<figcaption>图 3：堆 + 堆外内存超过容器 limit 即被 OOMKilled</figcaption>
</figure>

### 内存

| 参数 | 默认 | 建议 |
| --- | --- | --- |
| `-XX:+UseContainerSupport` | JDK 10+ 默认开启，8u191 起回移植 | 保持开启；cgroup v2 需要 JDK 15+ 或 11.0.16+ / 8u372+ |
| `-XX:MaxRAMPercentage` | 25（即容器内存的 1/4） | 2Gi 以上容器一般 70～75；1Gi 以下的小容器要降低，堆外开销占比更高 |
| `-XX:InitialRAMPercentage` | 约 1.5625 | 可与 Max 设成相同，避免运行中扩堆 |
| `-Xmx` | — | 显式设置时会覆盖百分比；**禁止设成等于容器 limit** |
| `-XX:MaxDirectMemorySize` | 默认约等于最大堆 | Netty / NIO 应用显式限制，让泄漏以 Java 异常暴露 |
| `-XX:+ExitOnOutOfMemoryError` | 关闭 | 容器中建议开启：堆 OOM 后立即退出由编排系统重启，而不是半死不活 |
| `-XX:+HeapDumpOnOutOfMemoryError` + `HeapDumpPath` | 关闭 | 路径指向挂载卷，否则 dump 随容器一起消失 |

```bash
# 验证 JVM 识别到的容器资源
docker run --rm -m 2g --cpus 2 eclipse-temurin:21-jre java -XshowSettings:system -version
docker run --rm -m 2g eclipse-temurin:21-jre java -XX:+PrintFlagsFinal -version | grep -E 'MaxHeapSize|UseG1GC|UseSerialGC'
# 容器被杀的原因
docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' <container>
```

**OOMKilled 与 Java OOM 的区别**：

- `java.lang.OutOfMemoryError: Java heap space`：堆满，JVM 自己抛出，有异常栈、可以 dump，退出码取决于应用（开启 `ExitOnOutOfMemoryError` 时为 3）。
- `OOMKilled` / exit 137：整个容器 RSS 超过 limit，被内核杀掉。常见原因：堆比例设太高、直接内存泄漏、线程数暴涨（每线程默认约 1MB 栈）、元空间无上限且类加载泄漏、glibc malloc arena。用 NMT（`-XX:NativeMemoryTracking=summary`）定位，详见 [Linux 线上排查](#/infra/linux)。

### CPU

- JVM 根据 CPU 配额计算 `availableProcessors()`：`--cpus=1.5` 时向上取整为 2。GC 并行线程数、`ForkJoinPool.commonPool` 并行度、Netty EventLoop 数、各种「CPU 核数 × N」的线程池都以此为基准。
- 早期 JDK 也会用 `cpu-shares`（K8s 的 requests）参与计算，JDK 19 起不再这样做（部分更新版本也做了回移植），升级后线程数可能变化。
- **在 1 个 CPU 或内存小于约 1792MB 的容器中，JVM 不认为自己运行在「服务器级机器」上，默认 GC 会退化为 SerialGC**。生产容器建议显式指定 `-XX:+UseG1GC`（或 ZGC），并给到至少 2 个 CPU。
- 需要固定数值时用 `-XX:ActiveProcessorCount=N` 覆盖。

> [!WARNING] CPU throttling 导致的 RT 毛刺
> limit=2 核的容器在 100ms 周期内用满 200ms CPU 时间后，剩余时间所有线程都会被暂停。G1 的并行 GC 线程、JIT 编译线程在同一时刻并发运行，很快耗尽配额，导致请求在某些周期里被「冻结」几十毫秒。监控 `cpu.stat` 中 `nr_throttled` 的增长；对策是减少并行线程数（`-XX:ParallelGCThreads`、`-XX:CICompilerCount`）、适当提高 limit，K8s 中也有团队选择只设 requests 不设 CPU limit（见 [Kubernetes 核心概念](#/infra/k8s)）。

## 网络模式

| 模式 | 参数 | 原理 | 适用 |
| --- | --- | --- | --- |
| bridge（默认） | `--network bridge` | 每个容器一个 NET namespace，通过 veth pair 接到宿主机 `docker0` 网桥；出站做 SNAT，`-p 8080:8080` 通过 iptables DNAT 映射端口 | 单机默认 |
| 自定义 bridge | `docker network create app-net` | 同上，额外提供**内置 DNS（127.0.0.11）**，容器间可用服务名互访 | 本地多容器（compose 默认） |
| host | `--network host` | 不创建 NET namespace，直接使用宿主机网络栈 | 极致网络性能、需要大量端口；牺牲隔离与端口冲突检查 |
| none | `--network none` | 只有 lo | 离线批处理、安全沙箱 |
| container | `--network container:<id>` | 与另一个容器共享 NET namespace | K8s Pod 中多个容器共享网络就是这个思路 |

默认 `docker0` 网桥上的容器**不能用容器名互相访问**，只能用 IP，这是很多「本地 compose 能通、手工 docker run 不通」问题的原因。

## 数据卷

| 类型 | 写法 | 特点 |
| --- | --- | --- |
| 命名卷 | `-v mysql-data:/var/lib/mysql` | 由 Docker 管理（`/var/lib/docker/volumes`），可移植，数据库首选 |
| 绑定挂载 | `-v /data/logs:/app/logs` | 直接挂宿主机目录，便于收集日志、挂配置；注意 UID 权限 |
| tmpfs | `--tmpfs /tmp` | 内存文件系统，容器停止即消失，计入容器内存 |

> [!TIP] 容器日志也会写满磁盘
> 默认 `json-file` 日志驱动不限制大小，标准输出疯狂打日志的容器会把 `/var/lib/docker` 撑满。在 `daemon.json` 中配置 `"log-opts": {"max-size": "100m", "max-file": "3"}`。

## docker compose 搭建本地依赖

```yaml
# compose.yaml：本地开发用的 MySQL + Redis + Kafka（KRaft，无需 ZooKeeper）
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-changeme}   # 从 .env 读取，勿提交真实密码
      MYSQL_DATABASE: demo
      TZ: Asia/Shanghai
    command: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci"]
    ports: ["3306:3306"]
    volumes:
      - mysql-data:/var/lib/mysql
      - ./sql/init:/docker-entrypoint-initdb.d:ro       # 首次启动执行初始化脚本
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      retries: 20

  redis:
    image: redis:7.2
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    volumes: ["redis-data:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  kafka:
    image: apache/kafka:3.7.0
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092   # 宿主机上的应用用 localhost 访问
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@localhost:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_NUM_PARTITIONS: 3

volumes:
  mysql-data:
  redis-data:
```

```bash
docker compose up -d
docker compose ps                    # 看 healthy 状态
docker compose logs -f kafka
docker compose down                  # 保留数据卷；加 -v 才会删除数据
```

- Kafka 的 `ADVERTISED_LISTENERS` 是客户端拿到的连接地址：宿主机上的 Java 应用用 `localhost:9092`；如果应用也跑在 compose 网络里，要再加一个 `kafka:19092` 形式的内部 listener，否则客户端连上后拿到 `localhost` 反而连不通。原理见 [Kafka 架构与存储](#/mw/kafka)。
- Spring Boot 3.1+ 提供 `spring-boot-docker-compose`，启动应用时自动拉起 compose 并注入连接信息；集成测试推荐 Testcontainers（见 [单元测试：JUnit 5 与 Mockito](#/java/eng/testing)）。
- `depends_on` 默认只保证启动顺序，不保证就绪；需要 `condition: service_healthy` 配合 healthcheck。

## 镜像安全

| 措施 | 做法 |
| --- | --- |
| 漏洞扫描 | `trivy image myapp:1.0`、`docker scout cves myapp:1.0`、Grype；CI 中对 HIGH / CRITICAL 设门禁 |
| SBOM | `syft myapp:1.0` 生成软件物料清单，出现 Log4Shell 这类漏洞时能快速确认影响面 |
| 最小化 | JRE / distroless 基础镜像，不装 curl、vim 等工具；多阶段构建 |
| 固定版本 | 基础镜像使用明确 tag，关键场景用 digest（`@sha256:...`）固定；定期重建获取安全补丁 |
| 运行时加固 | 非 root、`--read-only` 只读根文件系统、`--cap-drop ALL`、禁止 `--privileged` |
| 凭证 | 不进镜像；镜像仓库开启签名与访问控制 |

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 registry.example.com/order-service:1.4.2
```

## 生产实践与踩坑

1. **容器内存设置 2G、`-Xmx2g`，运行一段时间被 OOMKilled**：堆外内存没有余量。改用 `MaxRAMPercentage=70~75`，并用 NMT 量化堆外开销。
2. **`docker stop` 后应用没有执行优雅停机**：shell 形式 ENTRYPOINT 导致 SIGTERM 发给了 sh。改为 exec 形式；Spring Boot 开启 `server.shutdown=graceful`。
3. **老版本 JDK 8（< 8u191）在容器里按宿主机 64 核、256G 计算**：堆巨大、GC 线程和线程池过多，容器频繁被杀。升级 JDK 是唯一靠谱的方案。
4. **时区不对**：基础镜像默认 UTC，日志时间差 8 小时。设置 `TZ` 环境变量（镜像需含 tzdata），或 JVM 参数 `-Duser.timezone=Asia/Shanghai`。
5. **镜像里没有排查工具**：精简镜像无法 `jstack`。JRE 镜像不带 `jstack`/`jcmd` 时，可在宿主机用 `nsenter`，或在 K8s 中用 `kubectl debug` 挂一个带 JDK 的临时容器；也可以把 Arthas 作为调试 sidecar 引入。
6. **随机数阻塞导致启动慢**：老环境熵不足时 `SecureRandom` 读 `/dev/random` 阻塞，可设置 `-Djava.security.egd=file:/dev/./urandom`（新版 JDK 默认已基本不受影响）。
7. **Docker 磁盘被占满**：悬空镜像、停止的容器、无限增长的日志。定期 `docker system prune`（注意不要加 `--volumes` 误删数据卷），并配置日志轮转。

## 相关阅读

- [容器网络与网络排障：CNI、iptables/IPVS、tcpdump](#/cs/net-debug)：容器网络原理
- [进程、线程与 CPU 调度](#/cs/os-process)：cgroups、CPU limit 与调度
- [CI/CD 流水线与 GitOps](#/infra/cicd)：镜像构建、扫描与签名

## 面试追问

> [!QUESTION] Docker 的隔离和限制分别是用什么实现的？容器和虚拟机的本质区别？
> 隔离靠 Linux Namespace（PID、NET、MNT、UTS、IPC、USER），让进程只看到自己的资源视图；限制靠 Cgroups（CPU、内存、IO、进程数）；根文件系统靠 overlay2 联合挂载镜像层。容器本质是宿主机上受限的进程，共享内核；虚拟机通过 Hypervisor 虚拟硬件，每个实例有独立内核，隔离更强、开销更大。

> [!QUESTION] 镜像为什么要分层？如何利用分层加速 Java 应用的构建和发布？
> 层可在镜像之间共享和缓存，构建时未变化的指令直接命中缓存，推送 / 拉取时只传输变化的层。Java 应用把变化频率不同的内容拆成不同层：基础 JRE → 第三方依赖 → Spring Boot loader → 业务 class，配合 Dockerfile 中「先 COPY pom 解析依赖、再 COPY 源码」，日常发版只需传输几百 KB 的业务层。

> [!QUESTION] JVM 在容器中如何确定堆大小？为什么设置了 -Xmx 小于 limit 还会被 OOMKilled？
> JDK 8u191+ / 10+ 开启 `UseContainerSupport` 后读取 cgroup 的内存上限，默认最大堆为其 25%，可用 `MaxRAMPercentage` 调整。OOMKilled 由内核按进程总 RSS 判断，RSS 还包括元空间、线程栈、CodeCache、直接内存、GC 数据结构和 native 分配，堆外部分超出余量就会被杀，而且这种情况 JVM 来不及抛出 OOM。

> [!QUESTION] 容器里 CPU 使用率不高，但接口 RT 有周期性毛刺，可能是什么原因？
> CPU 配额节流：CFS 按 100ms 周期发放配额，多线程（GC、JIT、业务线程）在周期前段把配额用完，剩余时间全部被暂停。平均使用率看起来不高，但 `cpu.stat` 中 `nr_throttled` 持续增长。可减少并行线程、提高或取消 CPU limit、拆分为更多小实例。

> [!QUESTION] bridge 网络下，外部请求是怎样到达容器的？
> `-p 8080:80` 时 Docker 在宿主机 iptables 的 nat 表添加 DNAT 规则，把访问宿主机 8080 的流量改写为容器 IP:80；数据包经 `docker0` 网桥和 veth pair 进入容器的网络命名空间。容器访问外网时经 MASQUERADE（SNAT）改写为宿主机 IP。同一自定义网络内的容器通过内置 DNS 用服务名互访。
