---
level: 进阶
tags: [Nginx, 反向代理, 负载均衡, 限流, Keepalived, 502/504]
summary: Nginx 进程模型与请求阶段、upstream 负载均衡与健康检查、限流与超时缓冲参数、灰度发布、502/504/499 排查及 Keepalived 高可用，附生产配置模板
---

# Nginx 与负载均衡

> [!ABSTRACT] 核心要点
> - Nginx 是 **master + 多个单线程 worker** 的多进程模型，每个 worker 用 epoll 事件循环处理成千上万个连接；`reload` 时新旧 worker 交替，连接不中断。
> - 反向代理到 Java 服务务必开启 **upstream keepalive**（同时设置 `proxy_http_version 1.1` 和清空 `Connection` 头），否则每个请求都新建连接，Nginx 机器堆积大量 TIME_WAIT。
> - 内置健康检查是**被动**的：`max_fails` 次失败后在 `fail_timeout` 内摘除；主动探活需要第三方模块或 Nginx Plus。
> - 状态码定位：**502** 上游连接失败或异常断开，**504** 上游响应超时（`proxy_read_timeout`），**499** 客户端先断开——三者都要结合 error.log 与上游耗时判断。
> - 四层（LVS / stream）只看 IP 和端口，性能高；七层（HTTP）能按 URL、Header、Cookie 路由。常见架构是 LVS/云 SLB + Keepalived + Nginx 集群。

## 进程模型与事件驱动

<figure class="fig">
<svg viewBox="0 0 720 280" class="dg" role="img" aria-label="Nginx master 进程管理多个 worker 进程，每个 worker 用 epoll 事件循环处理大量客户端连接并通过 upstream 长连接转发到后端 Java 实例">
<rect class="b1" x="20" y="60" width="90" height="36" rx="6"/>
<text class="tb" x="65" y="78" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b1" x="20" y="120" width="90" height="36" rx="6"/>
<text class="tb" x="65" y="138" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b1" x="20" y="180" width="90" height="36" rx="6"/>
<text class="tb" x="65" y="198" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="bg" x="150" y="20" width="390" height="240" rx="12"/>
<text class="ts" x="164" y="38">Nginx</text>
<rect class="b3" x="245" y="40" width="200" height="50" rx="8"/>
<text class="tb" x="345" y="58" text-anchor="middle" dominant-baseline="middle">master 进程</text>
<text class="ts" x="345" y="80" text-anchor="middle">读配置、管理 worker、处理信号</text>
<line class="ld" x1="345" y1="90" x2="222" y2="138" marker-end="url(#arr)"/>
<line class="ld" x1="345" y1="90" x2="345" y2="138" marker-end="url(#arr)"/>
<line class="ld" x1="345" y1="90" x2="466" y2="138" marker-end="url(#arr)"/>
<text class="ts" x="425" y="112">fork + 信号控制</text>
<rect class="b2" x="165" y="140" width="115" height="80" rx="8"/>
<text class="tb" x="222" y="160" text-anchor="middle" dominant-baseline="middle">worker 1</text>
<text class="ts" x="222" y="184" text-anchor="middle">epoll 事件循环</text>
<text class="ts" x="222" y="202" text-anchor="middle">单线程、非阻塞</text>
<rect class="b2" x="287" y="140" width="115" height="80" rx="8"/>
<text class="tb" x="345" y="160" text-anchor="middle" dominant-baseline="middle">worker 2</text>
<text class="ts" x="345" y="184" text-anchor="middle">epoll 事件循环</text>
<text class="ts" x="345" y="202" text-anchor="middle">单线程、非阻塞</text>
<rect class="b2" x="409" y="140" width="115" height="80" rx="8"/>
<text class="tb" x="466" y="160" text-anchor="middle" dominant-baseline="middle">worker N</text>
<text class="ts" x="466" y="184" text-anchor="middle">epoll 事件循环</text>
<text class="ts" x="466" y="202" text-anchor="middle">通常 = CPU 核数</text>
<text class="ts" x="345" y="246" text-anchor="middle">新连接由各 worker 竞争 accept，开启 reuseport 时由内核分发</text>
<line class="l" x1="110" y1="78" x2="163" y2="160" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="138" x2="163" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="110" y1="198" x2="163" y2="200" marker-end="url(#arr)"/>
<rect class="b5" x="590" y="60" width="110" height="36" rx="6"/>
<text class="tb" x="645" y="78" text-anchor="middle" dominant-baseline="middle">app-1:8080</text>
<rect class="b5" x="590" y="120" width="110" height="36" rx="6"/>
<text class="tb" x="645" y="138" text-anchor="middle" dominant-baseline="middle">app-2:8080</text>
<rect class="b5" x="590" y="180" width="110" height="36" rx="6"/>
<text class="tb" x="645" y="198" text-anchor="middle" dominant-baseline="middle">app-3:8080</text>
<line class="la" x1="524" y1="170" x2="588" y2="78" marker-end="url(#arr-a)"/>
<line class="la" x1="524" y1="180" x2="588" y2="138" marker-end="url(#arr-a)"/>
<line class="la" x1="524" y1="190" x2="588" y2="198" marker-end="url(#arr-a)"/>
<text class="ts" x="645" y="240" text-anchor="middle">upstream 长连接池</text>
</svg>
<figcaption>图 1：master/worker 进程模型，worker 之间相互独立、各自事件循环</figcaption>
</figure>

- **master**：以 root 启动（绑定 80/443），解析配置、创建监听 socket、fork worker、响应信号（`reload`、`reopen`、`quit`），不处理请求。
- **worker**：单线程事件循环（Linux 上用 epoll，边缘触发），所有 IO 非阻塞。一个请求在 worker 中按阶段推进，遇到等待（读客户端、连上游、等响应）就注册事件、切去处理别的连接。与 Netty 的 EventLoop 是同一思路（见 [IO 模型与 Netty](#/infra/netty)）。
- **为什么多进程而非多线程**：worker 互不共享状态（共享数据走共享内存 zone），一个 worker 崩溃不影响其他；无锁，CPU 亲和性好（`worker_cpu_affinity auto`）。
- **热重载**：`nginx -t && nginx -s reload`，master 校验配置后启动新 worker，旧 worker 停止 accept、处理完存量请求后退出（`worker_shutdown_timeout` 控制最长等待，长连接 / WebSocket 场景要设置，否则旧 worker 可能长期不退）。

| 参数 | 默认值 | 建议 |
| --- | --- | --- |
| `worker_processes` | 1 | `auto`（等于 CPU 核数） |
| `worker_connections` | 512 | 10240～65535；反向代理时每个请求占用**客户端 + 上游两个连接** |
| `worker_rlimit_nofile` | 系统限制 | ≥ `worker_connections`，同时调大系统 fd 上限 |
| `accept_mutex` | off（1.11.3 起） | 保持 off；高并发下用 `listen ... reuseport` 让内核在 worker 间均衡 |
| `multi_accept` | off | 一般保持默认 |

## 请求处理的 11 个阶段

| 阶段 | 典型模块 / 指令 |
| --- | --- |
| `POST_READ` | `realip`（从 `X-Forwarded-For` 还原真实 IP） |
| `SERVER_REWRITE` | `server` 块中的 `rewrite`、`return`、`set` |
| `FIND_CONFIG` | 根据 URI 匹配 `location`（不可挂载模块） |
| `REWRITE` | `location` 块中的 `rewrite`、`set` |
| `POST_REWRITE` | URI 被改写时回到 FIND_CONFIG 重新匹配（有次数上限防止死循环） |
| `PREACCESS` | `limit_req`、`limit_conn` |
| `ACCESS` | `allow` / `deny`、`auth_basic`、`auth_request` |
| `POST_ACCESS` | 处理 `satisfy any/all` |
| `PRECONTENT` | `try_files`、`mirror` |
| `CONTENT` | `proxy_pass`、`fastcgi_pass`、`static`、`index`、`return` 内容 |
| `LOG` | `access_log` |

理解阶段顺序可以解释很多「配置不生效」：例如 `return` 在 REWRITE 阶段就结束请求，后面的 `limit_req`、`allow/deny` 都不会执行。

**location 匹配优先级**：`=` 精确匹配 → `^~` 最长前缀（命中后不再查正则）→ `~` / `~*` 正则按书写顺序第一个命中 → 普通最长前缀。

## 反向代理与 upstream

```nginx
upstream order_service {
    least_conn;
    server 10.0.1.11:8080 weight=5 max_fails=3 fail_timeout=10s;
    server 10.0.1.12:8080 weight=5 max_fails=3 fail_timeout=10s;
    server 10.0.1.13:8080 backup;            # 其他节点都不可用时才启用
    keepalive 64;                            # 每个 worker 缓存的空闲长连接数
    keepalive_timeout 60s;                   # 小于后端（Tomcat）keep-alive 超时
}

server {
    location /api/order/ {
        proxy_pass http://order_service;     # 末尾不带 /：URI 原样转发
        proxy_http_version 1.1;              # upstream keepalive 必需
        proxy_set_header Connection "";      # 清掉客户端的 Connection: close
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> [!WARNING] proxy_pass 末尾斜杠
> `location /api/ { proxy_pass http://up; }` 转发 `/api/user` 为 `/api/user`；`proxy_pass http://up/;` 则把匹配到的 `/api/` 替换为 `/`，转发为 `/user`。迁移配置时这是最常见的 404 来源。

Java 侧要配合识别代理头：Spring Boot 设置 `server.forward-headers-strategy=native`（由 Tomcat 处理）或 `framework`，否则 `request.getRemoteAddr()` 拿到的是 Nginx 的 IP、重定向地址变成 http。

## 负载均衡策略

| 策略 | 指令 | 原理 | 适用 / 注意 |
| --- | --- | --- | --- |
| 加权轮询 | 默认，`weight=` | **平滑加权轮询**：每轮各节点 current += weight，选最大者后减去总权重，避免权重大的节点被连续选中 | 无状态服务的默认选择 |
| IP 哈希 | `ip_hash` | 按客户端 IP 哈希（IPv4 取前三段） | 会话粘滞；大量用户在同一 NAT 后会严重倾斜；增删节点会重新分布 |
| 最少连接 | `least_conn` | 选活跃连接数最少的（结合权重） | 请求耗时差异大、长连接（WebSocket） |
| 通用哈希 | `hash $key [consistent]` | 按任意变量哈希；加 `consistent` 使用 ketama 一致性哈希 | 按 URI / 用户 ID 路由到固定节点，提高本地缓存命中；扩缩容只影响少量 key |
| 随机 | `random [two least_conn]` | 随机选两个，再取连接少的 | 多个 Nginx 实例各自统计连接数不准时的折中 |

### 被动健康检查与重试

```nginx
server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
proxy_next_upstream error timeout http_502 http_503;   # 哪些情况换下一个节点重试
proxy_next_upstream_tries 2;                           # 最多尝试次数（含首次）
proxy_next_upstream_timeout 5s;                        # 重试总时长上限
```

- `max_fails`（默认 1）：在 `fail_timeout`（默认 10s）时间窗内失败达到次数，节点被标记不可用 `fail_timeout` 时长，之后放少量请求试探。
- 什么算失败由 `proxy_next_upstream` 决定，默认只有 `error timeout`；**HTTP 500 默认不算失败**。
- 1.9.13 起，**非幂等请求（POST、PATCH 等）默认不会重试到下一个节点**，除非显式加 `non_idempotent`——不要轻易加，可能导致重复下单。
- 所有节点都被摘除时 error.log 出现 `no live upstreams`，Nginx 直接返回 502。
- 主动健康检查（定时探测 `/actuator/health`）需要 Nginx Plus、Tengine 的 `nginx_upstream_check_module` 或 OpenResty 的 `lua-resty-upstream-healthcheck`；K8s 环境下通常交给 Service + readiness 探针。

## 限流

```nginx
# 以客户端 IP 为 key，10MB 共享内存约可存十几万个 IP 状态
limit_req_zone  $binary_remote_addr zone=api_ip:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=conn_ip:10m;

location /api/ {
    limit_req  zone=api_ip burst=40 nodelay;   # 允许突发 40 个，突发部分不排队立即处理
    limit_req_status 429;                       # 默认返回 503，改成语义更准确的 429
    limit_conn conn_ip 20;                      # 单 IP 并发连接数
    limit_conn_status 429;
    proxy_pass http://order_service;
}
```

| 配置 | 行为 |
| --- | --- |
| 只有 `rate` | **漏桶**：以毫秒粒度均匀放行，20r/s 即每 50ms 一个，同一时刻的第二个请求直接拒绝 |
| `burst=N` | 桶容量 N，超出速率的请求排队，按速率依次放出，排队带来延迟 |
| `burst=N nodelay` | 突发的 N 个请求立即处理（但占用桶的位置），桶满再拒绝；对 API 最常用 |
| `limit_req_dry_run on` | 只记录不拦截，上线前评估阈值 |

> [!TIP] Nginx 限流的定位
> Nginx 适合做**入口粗粒度**的防刷与保护（按 IP、按接口），每个 Nginx 实例独立计数，多实例时总限额 = 单实例限额 × 实例数。按用户、按租户、集群维度精确限流应放在网关或应用层（Sentinel、Redis 令牌桶，见 [限流、熔断与降级](#/distributed/governance)）。

## 超时与缓冲参数

<figure class="fig">
<svg viewBox="0 0 720 340" class="dg" role="img" aria-label="Nginx 反向代理各超时参数作用的位置：客户端读取超时、上游建连超时、发送超时、读取响应超时，以及 502、504、499 的产生位置">
<rect class="b1" x="30" y="16" width="140" height="36" rx="6"/>
<text class="tb" x="100" y="34" text-anchor="middle" dominant-baseline="middle">Client</text>
<rect class="b3" x="290" y="16" width="140" height="36" rx="6"/>
<text class="tb" x="360" y="34" text-anchor="middle" dominant-baseline="middle">Nginx</text>
<rect class="b5" x="540" y="16" width="160" height="36" rx="6"/>
<text class="tb" x="620" y="34" text-anchor="middle" dominant-baseline="middle">Upstream（Java）</text>
<line class="ld" x1="100" y1="52" x2="100" y2="295"/>
<line class="ld" x1="360" y1="52" x2="360" y2="295"/>
<line class="ld" x1="620" y1="52" x2="620" y2="295"/>
<line class="l" x1="100" y1="84" x2="356" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="230" y="76" text-anchor="middle">请求（client_header / body_timeout）</text>
<line class="l" x1="360" y1="120" x2="616" y2="120" marker-end="url(#arr)"/>
<text class="ts" x="490" y="112" text-anchor="middle">TCP 建连（proxy_connect_timeout）</text>
<line class="l" x1="360" y1="156" x2="616" y2="156" marker-end="url(#arr)"/>
<text class="ts" x="490" y="148" text-anchor="middle">发送请求（proxy_send_timeout）</text>
<rect class="b3" x="354" y="166" width="12" height="70" rx="3"/>
<text class="tm" x="376" y="196">proxy_read_timeout</text>
<text class="ts" x="376" y="214">两次读之间的最大间隔</text>
<line class="l" x1="620" y1="246" x2="364" y2="246" marker-end="url(#arr)"/>
<text class="ts" x="490" y="238" text-anchor="middle">响应头 + 响应体</text>
<line class="l" x1="360" y1="278" x2="104" y2="278" marker-end="url(#arr)"/>
<text class="ts" x="230" y="270" text-anchor="middle">响应（send_timeout）</text>
<text class="ts" x="20" y="318">502：建连被拒、上游 RST / 提前关闭、响应头过大或非法；504：proxy_read_timeout 等超时</text>
<text class="ts" x="20" y="334">499：Nginx 还没返回响应时客户端先断开（客户端超时短于服务端处理时间）</text>
</svg>
<figcaption>图 2：反向代理链路上各超时参数的作用位置与 5xx/499 的来源</figcaption>
</figure>

| 参数 | 默认值 | 说明与建议 |
| --- | --- | --- |
| `proxy_connect_timeout` | 60s | 与上游建连超时，通常不超过 75s；内网建议 1～3s，配合重试快速切节点 |
| `proxy_send_timeout` | 60s | 两次写之间的间隔，不是总时长 |
| `proxy_read_timeout` | 60s | 两次读之间的间隔；按接口最慢合理耗时设置，长轮询 / 导出接口单独 location |
| `client_max_body_size` | 1m | 超过返回 **413**，上传接口单独调大 |
| `client_body_buffer_size` | 8k/16k | 超出写临时文件 |
| `proxy_buffering` | on | 先缓冲上游响应再慢慢发给客户端，让上游连接尽快释放；**SSE、流式输出要关闭** |
| `proxy_buffer_size` | 4k/8k（一个内存页） | 存放响应头；Cookie / 头很大时报 `upstream sent too big header` → 502 |
| `proxy_buffers` | 8 4k/8k | 响应体缓冲，超出写临时文件（`proxy_max_temp_file_size`，默认 1024m） |
| `keepalive_timeout` | 75s | 客户端长连接空闲超时 |

## HTTPS 与 HTTP/2

```nginx
server {
    listen 443 ssl;
    http2 on;                                    # 1.25.1+ 写法；旧版本写 listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/nginx/cert/fullchain.pem;  # 必须包含中间证书，否则 Java 客户端 PKIX 校验失败
    ssl_certificate_key /etc/nginx/cert/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;               # TLS 1.3 下由客户端选择即可
    ssl_session_cache shared:SSL:20m;            # 会话复用，减少完整握手
    ssl_session_timeout 1h;
    ssl_stapling on;                             # OCSP Stapling
    ssl_stapling_verify on;
    add_header Strict-Transport-Security "max-age=31536000" always;
}
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}
```

TLS 在 Nginx 终结，Nginx 到后端通常是内网 HTTP；后端用 `X-Forwarded-Proto` 判断原始协议。握手细节见 [TCP/IP 与 HTTP(S)](#/infra/network)。

## 动静分离与缓存

```nginx
location ~* \.(js|css|png|jpg|svg|woff2)$ {
    root /data/static;
    expires 30d;                                 # 文件名带 hash 时可以放心长缓存
    access_log off;
}
location = /index.html {
    root /data/static;
    add_header Cache-Control "no-cache";         # 入口页每次协商，避免发版后用户拿到旧版本
}

proxy_cache_path /data/nginx/cache levels=1:2 keys_zone=api_cache:50m max_size=2g inactive=10m;
location /api/catalog/ {
    proxy_cache api_cache;
    proxy_cache_key $scheme$host$request_uri;
    proxy_cache_valid 200 1m;
    proxy_cache_use_stale error timeout updating http_500 http_502;  # 上游故障时返回旧缓存兜底
    proxy_cache_lock on;                          # 同一 key 只放一个请求回源，防击穿
    add_header X-Cache-Status $upstream_cache_status;
    proxy_pass http://catalog_service;
}

gzip on;
gzip_types application/json text/css application/javascript;
gzip_min_length 1k;
```

## 灰度发布

```nginx
# 1) 按 Header / Cookie 精确分流：内部测试人员、指定用户
map $http_x_canary $by_header {
    default "";
    "true"  canary;
}
map $cookie_canary $pool {
    default $by_header;
    "1"     canary;
}

# 2) 按比例分流：基于用户 ID 哈希，保证同一用户稳定落在同一版本
split_clients "${cookie_uid}" $ratio_pool {
    10%  canary;
    *    "";
}

upstream stable { server 10.0.1.11:8080; server 10.0.1.12:8080; keepalive 32; }
upstream canary { server 10.0.2.11:8080; keepalive 32; }

server {
    location /api/ {
        set $target stable;
        if ($ratio_pool = canary) { set $target canary; }
        if ($pool = canary)       { set $target canary; }   # 显式标记优先
        proxy_pass http://$target;                          # 变量中的名字会匹配到 upstream 块
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

> [!NOTE] 灰度放在哪一层
> Nginx 灰度适合按入口流量切分；微服务内部调用的灰度（全链路标签透传）要在网关和 RPC 框架层做。K8s 中可用 Ingress-NGINX 的 canary 注解（`nginx.ingress.kubernetes.io/canary-by-header`、`canary-weight`）实现同样效果。

## 502 / 504 / 499 排查

| 状态码 | error.log 典型信息 | 常见原因 | 处理 |
| --- | --- | --- | --- |
| 502 | `connect() failed (111: Connection refused)` | Java 进程挂了、端口没起来、正在重启 | 查进程与发布；优雅上下线 |
| 502 | `upstream prematurely closed connection` / `recv() failed (104: Connection reset by peer)` | 上游主动断开：**Nginx 复用的长连接已被后端按 keep-alive 超时关闭**；后端 OOM / 崩溃 | Nginx upstream `keepalive_timeout` 小于后端（Tomcat `keepAliveTimeout`）；查后端 GC 与日志 |
| 502 | `upstream sent too big header` | 响应头（大 Cookie、长 Header）超过 `proxy_buffer_size` | 调大 `proxy_buffer_size`、`proxy_buffers` |
| 502 | `no live upstreams` | 所有节点都被 `max_fails` 摘除 | 修复后端；检查是否把 500 也算作失败导致雪崩式摘除 |
| 504 | `upstream timed out (110: Connection timed out) while reading response header` | 后端处理慢：慢 SQL、下游超时、线程池满、Full GC | 看后端 RT 与线程栈；不要只调大超时 |
| 504 | `upstream timed out ... while connecting to upstream` | 建连超时：后端 accept 队列满、网络不通、安全组 | 查 `ss -lnt`、`netstat -s` 溢出计数 |
| 499 | access.log 中状态码 499 | 客户端（App、上游服务、LB）超时先断开 | 对比客户端超时与 `$upstream_response_time`；后端慢才是根因 |

建议的日志格式，排查时可以直接区分「Nginx 慢」还是「上游慢」：

```nginx
log_format main '$remote_addr [$time_local] "$request" $status $body_bytes_sent '
                '"$http_x_forwarded_for" ua="$http_user_agent" '
                'rt=$request_time uct=$upstream_connect_time urt=$upstream_response_time '
                'ups=$upstream_addr ustatus=$upstream_status';
```

`$request_time` 远大于 `$upstream_response_time` 说明时间耗在客户端侧（上传慢、弱网下发慢）；两者接近说明是上游慢。`$upstream_addr` 出现多个地址表示发生了重试。

## 四层与七层负载

| | 四层（L4） | 七层（L7） |
| --- | --- | --- |
| 依据 | IP + 端口（TCP/UDP） | HTTP 方法、URL、Header、Cookie |
| 代表 | LVS（DR / NAT / TUN 模式）、Nginx `stream`、云 NLB | Nginx `http`、HAProxy、Envoy、云 ALB、API 网关 |
| 性能 | 高，LVS 在内核转发，DR 模式回包不经过 LVS | 需要解析协议、终结 TLS，CPU 开销更大 |
| 能力 | 无法按内容路由、改写；连接级均衡 | 路由、改写、限流、缓存、灰度、WAF；请求级均衡 |
| 适用 | 入口第一层、MySQL/Redis 等 TCP 服务、gRPC 直通 | Web/API 入口 |

```nginx
# Nginx stream：四层代理 MySQL 只读库
stream {
    upstream mysql_ro {
        server 10.0.3.11:3306 max_fails=2 fail_timeout=10s;
        server 10.0.3.12:3306 max_fails=2 fail_timeout=10s;
    }
    server {
        listen 3307;
        proxy_connect_timeout 2s;
        proxy_timeout 10m;            # 双向空闲超时，需大于连接池的空闲检测间隔
        proxy_pass mysql_ro;
    }
}
```

## Keepalived + VIP 高可用

<figure class="fig">
<svg viewBox="0 0 720 370" class="dg" role="img" aria-label="Keepalived 通过 VRRP 让 VIP 绑定在 MASTER 节点，MASTER 故障时 VIP 漂移到 BACKUP，两台 Nginx 都把请求转发到后端 Java 实例">
<rect class="b1" x="290" y="10" width="140" height="36" rx="6"/>
<text class="tb" x="360" y="28" text-anchor="middle" dominant-baseline="middle">Client / DNS</text>
<line class="l" x1="360" y1="46" x2="360" y2="68" marker-end="url(#arr)"/>
<rect class="bf" x="285" y="70" width="150" height="34" rx="6"/>
<text class="tw" x="360" y="87" text-anchor="middle" dominant-baseline="middle">VIP 10.0.0.100</text>
<line class="la" x1="330" y1="104" x2="190" y2="124" marker-end="url(#arr-a)"/>
<text class="ts" x="255" y="110" text-anchor="end">VIP 在 MASTER 上</text>
<line class="ld" x1="390" y1="104" x2="530" y2="124" marker-end="url(#arr)"/>
<text class="ts" x="468" y="110">故障时漂移</text>
<rect class="bg" x="60" y="126" width="260" height="114" rx="10"/>
<text class="ts" x="74" y="144">节点 A：MASTER（priority 100）</text>
<rect class="b2" x="90" y="152" width="200" height="34" rx="6"/>
<text class="tb" x="190" y="169" text-anchor="middle" dominant-baseline="middle">Keepalived</text>
<rect class="b3" x="90" y="196" width="200" height="34" rx="6"/>
<text class="tb" x="190" y="213" text-anchor="middle" dominant-baseline="middle">Nginx</text>
<rect class="bg" x="400" y="126" width="260" height="114" rx="10"/>
<text class="ts" x="414" y="144">节点 B：BACKUP（priority 90）</text>
<rect class="b" x="430" y="152" width="200" height="34" rx="6"/>
<text class="tb" x="530" y="169" text-anchor="middle" dominant-baseline="middle">Keepalived</text>
<rect class="b3" x="430" y="196" width="200" height="34" rx="6"/>
<text class="tb" x="530" y="213" text-anchor="middle" dominant-baseline="middle">Nginx</text>
<line class="ld" x1="290" y1="169" x2="430" y2="169"/>
<text class="ts" x="360" y="162" text-anchor="middle">VRRP 心跳</text>
<line class="la" x1="190" y1="240" x2="200" y2="286" marker-end="url(#arr-a)"/>
<line class="la" x1="190" y1="240" x2="360" y2="286" marker-end="url(#arr-a)"/>
<line class="la" x1="190" y1="240" x2="520" y2="286" marker-end="url(#arr-a)"/>
<line class="ld" x1="530" y1="240" x2="210" y2="286"/>
<line class="ld" x1="530" y1="240" x2="370" y2="286"/>
<line class="ld" x1="530" y1="240" x2="530" y2="286"/>
<rect class="b5" x="140" y="288" width="120" height="36" rx="6"/>
<text class="tb" x="200" y="306" text-anchor="middle" dominant-baseline="middle">app-1:8080</text>
<rect class="b5" x="300" y="288" width="120" height="36" rx="6"/>
<text class="tb" x="360" y="306" text-anchor="middle" dominant-baseline="middle">app-2:8080</text>
<rect class="b5" x="460" y="288" width="120" height="36" rx="6"/>
<text class="tb" x="520" y="306" text-anchor="middle" dominant-baseline="middle">app-3:8080</text>
<text class="ts" x="360" y="356" text-anchor="middle">vrrp_script 定期检测 Nginx，失败则降低优先级，BACKUP 接管 VIP 并发送免费 ARP</text>
</svg>
<figcaption>图 3：Keepalived + VIP 的主备高可用架构</figcaption>
</figure>

```text
# /etc/keepalived/keepalived.conf（节点 A）
vrrp_script chk_nginx {
    script "/usr/bin/pgrep -x nginx"     # 也可 curl 本机健康检查地址
    interval 2
    weight -20                            # 检测失败优先级降 20，低于 BACKUP 触发切换
}
vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51                  # 同一组主备必须一致，且同网段内唯一
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass changeme
    }
    virtual_ipaddress {
        10.0.0.100/24
    }
    track_script {
        chk_nginx
    }
}
```

- **主备**：一个 VIP，BACKUP 平时空闲；**双主**：两个 VIP 互为主备，DNS 解析两个 VIP，资源利用率更高。
- **脑裂**：VRRP 心跳被防火墙拦截或网络分区时，两台都认为自己是 MASTER、同时持有 VIP。确保放通 VRRP（IP 协议号 112），使用单播 `unicast_peer`，并对「双方都持有 VIP」做监控告警。
- 公有云 VPC 通常不支持 VRRP 组播和自由漂移 IP（需借助云厂商的 HAVIP 或直接使用云负载均衡），云上更常见的架构是**云 SLB → 多台 Nginx（无状态横向扩展）**。
- 更大规模：DNS 轮询 / GSLB → LVS（DR）+ Keepalived → Nginx 集群 → 网关 → 服务。

## 生产配置模板

```nginx
user nginx;
worker_processes auto;
worker_rlimit_nofile 65535;
worker_shutdown_timeout 30s;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 20480;
    use epoll;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    server_tokens off;                         # 不暴露版本号
    sendfile on;                               # 静态文件零拷贝
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65s;
    keepalive_requests 1000;
    client_max_body_size 20m;

    log_format main '$remote_addr [$time_local] "$request" $status $body_bytes_sent '
                    'rt=$request_time urt=$upstream_response_time ups=$upstream_addr '
                    'xff="$http_x_forwarded_for" tid=$http_x_trace_id';
    access_log /var/log/nginx/access.log main buffer=32k flush=5s;

    proxy_connect_timeout 3s;
    proxy_send_timeout 10s;
    proxy_read_timeout 30s;
    proxy_buffer_size 16k;
    proxy_buffers 8 16k;
    proxy_next_upstream error timeout;
    proxy_next_upstream_tries 2;

    limit_req_zone $binary_remote_addr zone=per_ip:20m rate=50r/s;

    upstream app {
        server 10.0.1.11:8080 max_fails=3 fail_timeout=10s;
        server 10.0.1.12:8080 max_fails=3 fail_timeout=10s;
        keepalive 64;
        keepalive_timeout 50s;                 # 小于 Tomcat keepAliveTimeout
    }

    server {
        listen 443 ssl reuseport;
        http2 on;
        server_name api.example.com;
        ssl_certificate     /etc/nginx/cert/fullchain.pem;
        ssl_certificate_key /etc/nginx/cert/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:20m;

        location /api/ {
            limit_req zone=per_ip burst=100 nodelay;
            limit_req_status 429;
            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
        location = /nginx_status {               # 连接数监控，供 Prometheus exporter 采集
            stub_status;
            allow 10.0.0.0/8;
            deny all;
        }
    }
}
```

## 生产实践与踩坑

1. **没开 upstream keepalive**：Nginx 到 Java 全是短连接，Nginx 机器 TIME_WAIT 数万、端口耗尽，后端也被频繁握手拖累。三件套：`keepalive N`、`proxy_http_version 1.1`、`proxy_set_header Connection ""`。
2. **偶发 502 且后端没有任何错误日志**：Nginx 复用了后端刚好按超时关闭的长连接。让 Nginx 侧空闲超时小于后端，并允许对幂等请求在 `error` 时重试。
3. **`if` 里写复杂逻辑**：`if` 在 location 中行为反直觉（官方文档称「If is Evil」），只在其中用 `return`、`rewrite ... last`、`set`；复杂分流用 `map`。
4. **`proxy_pass` 使用域名**：域名只在启动 / reload 时解析一次，后端 IP 变化（云 SLB、K8s Service 重建）后一直连旧 IP。用 `resolver` + 变量形式的 `proxy_pass`，或使用 upstream 的 `server ... resolve`（较新版本支持）。
5. **上传大文件 413**：`client_max_body_size` 默认 1m，在网关、Ingress、Spring（`spring.servlet.multipart.max-file-size`）每一层都要放开。
6. **reload 后旧 worker 不退出**：存在 WebSocket / 长连接，设置 `worker_shutdown_timeout`。
7. **获取真实 IP 错误**：多层代理时用 `real_ip_header X-Forwarded-For` + `set_real_ip_from` 指定可信代理网段，不要直接信任客户端传来的 XFF 做风控。

## 面试追问

> [!QUESTION] Nginx 为什么能扛高并发？和 Tomcat 的线程模型有什么不同？
> master/worker 多进程，每个 worker 单线程 epoll 事件循环，所有 IO 非阻塞，一个 worker 可同时处理上万连接，几乎没有线程切换和锁开销。Tomcat NIO 虽然也用 Selector 处理连接，但请求的业务处理在工作线程池中同步执行，并发能力受线程数约束；Nginx 不跑业务逻辑，只做转发和静态资源，所以能完全事件驱动。

> [!QUESTION] 502 和 504 有什么区别？各举两个原因。
> 502 是网关从上游拿到了「坏」结果：连接被拒（进程挂了）、连接被重置或提前关闭（长连接超时不匹配、后端崩溃）、响应头过大或格式非法、所有节点被摘除。504 是等上游超时：后端处理慢（慢 SQL、下游超时、Full GC）超过 `proxy_read_timeout`，或建连超时。

> [!QUESTION] limit_req 的 burst 和 nodelay 分别起什么作用？
> 不配 burst 时严格按速率放行，同一个时间片内多出的请求立即拒绝。burst 相当于漏桶容量，超速请求进桶排队按速率放出，会增加延迟；加 nodelay 后桶内的突发请求立即处理，但仍然占用桶位置，桶位按速率释放，所以长期速率不变，只是允许瞬时突发。

> [!QUESTION] 用 ip_hash 做会话保持有什么问题？有什么更好的方案？
> 大量用户在同一 NAT / 公司出口后时流量严重倾斜；节点增减或宕机会导致大面积会话迁移；客户端 IP 变化（移动网络）会话丢失。更好的做法是服务无状态化，会话放 Redis（Spring Session）或用 JWT；确需粘滞时用 `hash $cookie_xxx consistent` 一致性哈希。

> [!QUESTION] Keepalived 的脑裂是怎么产生的，如何避免？
> 主备之间 VRRP 通告丢失（防火墙拦截协议 112、网络分区、心跳网卡故障），BACKUP 认为 MASTER 已死而升主，两台同时持有 VIP，造成 ARP 冲突、请求乱飞。应对：放通 VRRP 并使用单播、配置冗余心跳链路、脚本检测网关连通性后再决定是否持有 VIP、对 VIP 归属做监控告警。
