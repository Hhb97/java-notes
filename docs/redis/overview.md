---
level: 深入
tags: [Redis, 事件循环, epoll, IO 多线程, Pipeline, Lua, Functions]
summary: Redis 为什么快、单线程事件循环与 6.0 IO 多线程的真实分工、命令执行全链路，以及 Pipeline、事务、Lua/Functions 的原子性边界
---

# 线程模型与高性能原理

> [!ABSTRACT] 核心要点
> - Redis 快的根本原因：**纯内存操作 + 高效数据结构 + IO 多路复用 + 命令执行单线程（无锁、无上下文切换）**。瓶颈通常是网络与内存，而不是 CPU。
> - 「单线程」指**命令执行**由主线程串行完成；持久化 fork 子进程、bio 后台线程（关闭文件、fsync、lazyfree）、6.0+ 的 IO 线程都是额外的执行单元。
> - 6.0 IO 多线程只并行化**读 socket + 协议解析**与**写回复**，命令执行仍在主线程，所以不存在并发安全问题，也不会提升单个慢命令的速度。
> - Pipeline 省的是 RTT 和系统调用，**不保证原子性**；MULTI/EXEC 保证串行不被插队但**没有回滚**；需要「读-判断-写」原子性就用 Lua 或 7.0 Functions。
> - 任何 O(N) 大命令（`KEYS`、大 key 的 `DEL`/`HGETALL`、长 Lua）都会阻塞整个事件循环，表现为全实例 RT 飙升、哨兵/集群误判下线。

## 为什么快

| 因素 | 说明 |
| --- | --- |
| 内存存储 | 读写都是内存访问，单次操作通常在微秒级；持久化交给子进程或后台线程 |
| 数据结构 | SDS、listpack、quicklist、skiplist、intset 等针对内存和 CPU cache 优化，小对象用紧凑编码，见 [数据结构与底层编码](#/redis/types) |
| IO 多路复用 | 一个线程用 epoll 同时监听上万连接，只处理就绪的 fd，没有「一连接一线程」的开销 |
| 单线程执行命令 | 不需要锁，不存在线程切换与竞争；每条命令天然原子 |
| 简单协议 | RESP 协议解析成本低；6.0 起支持 RESP3 |
| 渐进式设计 | rehash、过期删除、碎片整理都是「每次做一点」，避免长时间阻塞 |

单实例 QPS 常见在 10 万量级（取决于命令、value 大小、网络），此时 CPU 往往不是瓶颈，网卡中断和系统调用开销才是。所以 Redis 一直没有让「命令执行」多线程化，而是在 6.0 把 **网络 IO** 拆出去。

## 单线程事件循环

### aeEventLoop 结构

Redis 自己实现了一个极简的 Reactor 框架 `ae`，按平台选择 `ae_epoll.c` / `ae_kqueue.c` / `ae_evport.c` / `ae_select.c`。核心是两类事件：

- **文件事件（File Event）**：socket 可读/可写。监听 socket 的可读事件绑定 `acceptTcpHandler`；客户端 socket 的可读事件绑定 `readQueryFromClient`；需要写回复时（写不完的情况）注册可写事件 `sendReplyToClient`。
- **时间事件（Time Event）**：定时任务，核心只有一个 `serverCron`，频率由 `hz` 控制（默认 10，即每 100ms 一次），负责过期 key 主动清理、渐进式 rehash、统计信息、触发 BGSAVE/AOF 重写、客户端超时检查、主从心跳等。

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="Redis 主线程事件循环：客户端连接经 epoll 产生就绪事件，主线程依次执行 beforeSleep、epoll_wait、处理文件事件和时间事件并循环">
<rect class="b" x="20" y="40" width="110" height="36" rx="8"/>
<text class="tb" x="75" y="58" text-anchor="middle" dominant-baseline="middle">Client A</text>
<rect class="b" x="20" y="92" width="110" height="36" rx="8"/>
<text class="tb" x="75" y="110" text-anchor="middle" dominant-baseline="middle">Client B</text>
<rect class="b" x="20" y="144" width="110" height="36" rx="8"/>
<text class="tb" x="75" y="162" text-anchor="middle" dominant-baseline="middle">Client C</text>
<line class="l" x1="130" y1="58" x2="170" y2="96"/>
<line class="l" x1="130" y1="110" x2="170" y2="108"/>
<line class="l" x1="130" y1="162" x2="170" y2="120"/>
<rect class="b2" x="170" y="80" width="130" height="56" rx="8"/>
<text class="tb" x="235" y="100" text-anchor="middle" dominant-baseline="middle">epoll</text>
<text class="ts" x="235" y="120" text-anchor="middle" dominant-baseline="middle">IO 多路复用</text>
<line class="la" x1="300" y1="108" x2="350" y2="117" marker-end="url(#arr-a)"/>
<text class="ts" x="318" y="98" text-anchor="middle">就绪 fd</text>
<rect class="bg" x="330" y="16" width="375" height="262" rx="12"/>
<text class="ts" x="346" y="36">aeMain 循环（主线程）</text>
<rect class="b1" x="350" y="52" width="330" height="34" rx="8"/>
<text class="t" x="515" y="69" text-anchor="middle" dominant-baseline="middle">beforeSleep：写回复 / AOF 落盘 / 快速过期</text>
<line class="l" x1="515" y1="86" x2="515" y2="100" marker-end="url(#arr)"/>
<rect class="b1" x="350" y="100" width="330" height="34" rx="8"/>
<text class="tm" x="515" y="117" text-anchor="middle" dominant-baseline="middle">aeApiPoll → epoll_wait(timeout)</text>
<line class="l" x1="515" y1="134" x2="515" y2="148" marker-end="url(#arr)"/>
<rect class="b3" x="350" y="148" width="330" height="34" rx="8"/>
<text class="t" x="515" y="165" text-anchor="middle" dominant-baseline="middle">文件事件：accept / 读+解析+执行 / 写回</text>
<line class="l" x1="515" y1="182" x2="515" y2="196" marker-end="url(#arr)"/>
<rect class="b3" x="350" y="196" width="330" height="34" rx="8"/>
<text class="t" x="515" y="213" text-anchor="middle" dominant-baseline="middle">时间事件：serverCron（hz 默认 10）</text>
<line class="l" x1="680" y1="213" x2="694" y2="213"/>
<line class="l" x1="694" y1="213" x2="694" y2="69"/>
<line class="l" x1="694" y1="69" x2="682" y2="69" marker-end="url(#arr)"/>
<text class="ts" x="346" y="252">所有命令在这一个线程里串行执行：无锁、无切换</text>
<text class="ts" x="346" y="268">代价：任何一个慢命令都会让整个循环停住</text>
</svg>
<figcaption>图 1：aeEventLoop 单线程事件循环（Reactor 模型）</figcaption>
</figure>

`epoll_wait` 的超时时间由最近的时间事件决定：如果 50ms 后有 `serverCron` 要跑，就最多阻塞 50ms，保证定时任务不被饿死。

```c
// Redis 7.x ae.c aeMain（节选）
void aeMain(aeEventLoop *eventLoop) {
    eventLoop->stop = 0;
    while (!eventLoop->stop) {
        // beforeSleep 在 aeProcessEvents 内部、epoll_wait 之前调用
        aeProcessEvents(eventLoop, AE_ALL_EVENTS | AE_CALL_BEFORE_SLEEP | AE_CALL_AFTER_SLEEP);
    }
}
```

### beforeSleep 做了什么

`beforeSleep` 是很多「攒一批再做」的优化点：

- `handleClientsWithPendingWrites`：命令执行时回复只写进客户端输出缓冲区，**在进入下一次 epoll_wait 前统一 write**，写不完才注册可写事件；
- `flushAppendOnlyFile`：把 `aof_buf` 写入 AOF 文件，按 `appendfsync` 策略决定是否 fsync；
- 快速模式的主动过期（`activeExpireCycle(ACTIVE_EXPIRE_CYCLE_FAST)`）；
- 处理被 `BLPOP` 等阻塞后被唤醒的客户端、集群状态更新等。

### 一条命令的执行全过程

以 `SET k v` 为例（未开启 IO 线程）：

1. 客户端 socket 可读 → `readQueryFromClient` 把字节读入 `client->querybuf`；
2. `processInputBuffer` 按 RESP 解析成 `argc/argv`；
3. `processCommand`：查命令表 → 校验参数个数 → ACL 鉴权 → 集群模式下检查槽归属（可能返回 MOVED/ASK）→ 内存检查，超过 `maxmemory` 时先 `performEvictions` 淘汰 → 若处于 MULTI 则入队；
4. `call()` → `setCommand` 真正修改 db 字典，记录 slowlog、命令统计、`propagate` 到 AOF 缓冲和从库复制缓冲；
5. `addReply` 把回复写入客户端缓冲区（16KB 的静态 buf + reply 链表），把客户端挂入 `clients_pending_write`；
6. 下一次 `beforeSleep` 统一写回 socket。

这条链路里**只有步骤 4 一定在主线程**，1、2、6 在 6.0+ 可以交给 IO 线程。

## 6.0 IO 多线程

### 为什么要引入

高并发小包场景下，`read`/`write` 系统调用和 RESP 解析占了主线程相当大比例的 CPU。命令执行本身很快，但被网络 IO 拖住了。多线程化 IO 可以在多核机器上把吞吐提升到原来的 1～2 倍左右（官方给出的经验值，视场景而定）。

### 分工

<figure class="fig">
<svg viewBox="0 0 720 290" class="dg" role="img" aria-label="Redis 6 IO 多线程：主线程与 IO 线程并行读取解析，主线程串行执行命令，再并行写回，然后进入下一轮 epoll_wait">
<text class="ts" x="200" y="28" text-anchor="middle">① 分发 + 并行读解析</text>
<text class="ts" x="345" y="28" text-anchor="middle">② 主线程串行执行</text>
<text class="ts" x="490" y="28" text-anchor="middle">③ 并行写回</text>
<text class="ts" x="632" y="28" text-anchor="middle">④ 下一轮</text>
<rect class="b5" x="20" y="44" width="100" height="32" rx="6"/>
<text class="tb" x="70" y="60" text-anchor="middle" dominant-baseline="middle">主线程</text>
<rect class="b" x="20" y="104" width="100" height="32" rx="6"/>
<text class="tb" x="70" y="120" text-anchor="middle" dominant-baseline="middle">IO 线程 1</text>
<rect class="b" x="20" y="154" width="100" height="32" rx="6"/>
<text class="tb" x="70" y="170" text-anchor="middle" dominant-baseline="middle">IO 线程 2</text>
<rect class="b" x="20" y="204" width="100" height="32" rx="6"/>
<text class="tb" x="70" y="220" text-anchor="middle" dominant-baseline="middle">IO 线程 3</text>
<rect class="b2" x="140" y="44" width="120" height="32" rx="6"/>
<text class="t" x="200" y="60" text-anchor="middle" dominant-baseline="middle">读 + 解析</text>
<rect class="b2" x="140" y="104" width="120" height="32" rx="6"/>
<text class="t" x="200" y="120" text-anchor="middle" dominant-baseline="middle">读 + 解析</text>
<rect class="b2" x="140" y="154" width="120" height="32" rx="6"/>
<text class="t" x="200" y="170" text-anchor="middle" dominant-baseline="middle">读 + 解析</text>
<rect class="b2" x="140" y="204" width="120" height="32" rx="6"/>
<text class="t" x="200" y="220" text-anchor="middle" dominant-baseline="middle">读 + 解析</text>
<rect class="b3" x="275" y="44" width="140" height="32" rx="6"/>
<text class="t" x="345" y="60" text-anchor="middle" dominant-baseline="middle">串行执行命令</text>
<text class="ts" x="345" y="170" text-anchor="middle">IO 线程空转等待</text>
<rect class="b2" x="430" y="44" width="120" height="32" rx="6"/>
<text class="t" x="490" y="60" text-anchor="middle" dominant-baseline="middle">写回复</text>
<rect class="b2" x="430" y="104" width="120" height="32" rx="6"/>
<text class="t" x="490" y="120" text-anchor="middle" dominant-baseline="middle">写回复</text>
<rect class="b2" x="430" y="154" width="120" height="32" rx="6"/>
<text class="t" x="490" y="170" text-anchor="middle" dominant-baseline="middle">写回复</text>
<rect class="b2" x="430" y="204" width="120" height="32" rx="6"/>
<text class="t" x="490" y="220" text-anchor="middle" dominant-baseline="middle">写回复</text>
<rect class="b1" x="565" y="44" width="135" height="32" rx="6"/>
<text class="tm" x="632" y="60" text-anchor="middle" dominant-baseline="middle">epoll_wait</text>
<line class="ld" x1="267" y1="40" x2="267" y2="240"/>
<line class="ld" x1="422" y1="40" x2="422" y2="240"/>
<line class="ld" x1="557" y1="40" x2="557" y2="240"/>
<text class="ts" x="20" y="262">io-threads 默认 1（即关闭）；读也交给 IO 线程需额外打开 io-threads-do-reads</text>
<text class="ts" x="20" y="280">每个阶段主线程都等所有 IO 线程完成（屏障），命令执行永远只在主线程</text>
</svg>
<figcaption>图 2：Redis 6/7 IO 多线程一轮循环的分工</figcaption>
</figure>

流程（`networking.c`）：

1. 主线程 `epoll_wait` 拿到可读客户端，放进 `clients_pending_read`，开启线程化时**不立即读**；
2. `handleClientsWithPendingReadsUsingThreads`：轮询分配给各 IO 线程（主线程自己也领一份），各线程读 socket + 解析 RESP；主线程忙等所有线程完成（计数器归零）；
3. 主线程遍历这些客户端，串行执行命令；
4. `handleClientsWithPendingWritesUsingThreads`：同样分发写任务，并行 `write`；
5. 进入下一轮。

| 参数 | 默认 | 建议 |
| --- | --- | --- |
| `io-threads` | 1 | 4 核机器 2～3，8 核 6 左右；超过 8 收益很小。只有确实 CPU 打满在网络 IO 上才开 |
| `io-threads-do-reads` | no | 开启 IO 线程时一般一起打开 |

> [!NOTE] 版本差异
> - 6.0 之前：除 bio 线程外完全单线程。
> - 6.0～7.x：上面这种「主线程分发 + 屏障同步」模型，IO 线程在没有任务时会自旋，CPU 占用看起来偏高。
> - Redis 8.0 重写了 IO 线程实现（客户端固定绑定到某个 IO 线程、异步化），`io-threads-do-reads` 不再需要；本页以 7.x 为准。
> - 线上如果瓶颈在 CPU 但不是网络，开 IO 线程没用；更常见的扩展方式仍是 **Cluster 分片 / 单机多实例**。

## 后台线程与 lazyfree

### bio 线程

Redis 启动时创建若干 bio（Background IO）线程，各自有任务队列：

| 任务 | 作用 |
| --- | --- |
| `BIO_CLOSE_FILE` | 异步 `close()` 文件。关闭一个被 unlink 的大文件（如旧 AOF）会触发真正的磁盘释放，可能耗时数百毫秒 |
| `BIO_AOF_FSYNC` | `appendfsync everysec` 时每秒在后台 `fsync` |
| `BIO_LAZY_FREE` | 异步释放大对象内存 |

### lazyfree

删除一个百万元素的 Hash，`DEL` 需要逐个释放节点，可能阻塞几百毫秒到秒级。4.0 引入 lazyfree：主线程只把 key 从字典摘掉（O(1)），真正释放交给 bio 线程。对象「释放成本」超过阈值（`LAZYFREE_THRESHOLD`，约 64 个元素）才走异步，小对象直接同步释放更省事。

| 场景 | 命令 / 参数 | 7.x 默认 |
| --- | --- | --- |
| 用户主动删除 | `UNLINK`、`FLUSHALL ASYNC` / `FLUSHDB ASYNC` | — |
| 让 `DEL` 行为等同 `UNLINK` | `lazyfree-lazy-user-del`（6.0+） | no |
| `FLUSHALL/FLUSHDB` 不带参数时默认异步 | `lazyfree-lazy-user-flush`（6.2+） | no |
| 淘汰时异步释放 | `lazyfree-lazy-eviction` | no |
| 过期删除异步释放 | `lazyfree-lazy-expire` | no |
| `RENAME`/`SET` 覆盖旧值等隐式删除 | `lazyfree-lazy-server-del` | no |
| 从库全量同步前清空数据 | `replica-lazy-flush` | no |

> [!TIP]
> 生产推荐把以上 lazyfree 开关都设为 `yes`，代码里删除可能较大的 key 一律用 `UNLINK`。注意 lazyfree 只是把释放挪到后台，**内存不会瞬间下降**，监控里看到 `lazyfree_pending_objects` 不为 0 是正常的。

## Pipeline

### 原理

没有 Pipeline 时，每条命令都要经历「客户端发送 → 网络 → 服务端执行 → 网络 → 客户端收到」，执行可能只要 1μs，但 RTT 在同机房也有 0.1～1ms。Pipeline 把 N 条命令一次写进 socket，服务端依次执行、回复依次写进输出缓冲，客户端最后一次性读回：

- 省掉 N-1 次 RTT；
- 服务端一次 `read` 读到多条命令、一次 `write` 写回多条回复，**系统调用次数大幅减少**，这往往比省 RTT 更能提升服务端吞吐。

```java
// Spring Data Redis：executePipelined 回调里的返回值必须是 null，结果从返回的 List 拿
List<Object> results = redisTemplate.executePipelined((RedisCallback<Object>) conn -> {
    for (int i = 0; i < 1000; i++) {
        conn.stringCommands().set(("k:" + i).getBytes(), ("v" + i).getBytes());
    }
    return null;
});
```

```java
// Lettuce 原生：关闭自动 flush，攒一批再发
StatefulRedisConnection<String, String> conn = client.connect();
RedisAsyncCommands<String, String> async = conn.async();
conn.setAutoFlushCommands(false);
List<RedisFuture<?>> futures = new ArrayList<>();
for (int i = 0; i < 1000; i++) futures.add(async.set("k:" + i, "v" + i));
conn.flushCommands();
LettuceFutures.awaitAll(5, TimeUnit.SECONDS, futures.toArray(new RedisFuture[0]));
conn.setAutoFlushCommands(true);
```

### 注意

- **不是原子的**：中间可能插入其他客户端的命令，部分命令失败不影响其他命令。
- 批次不宜过大：服务端要为整个批次缓存回复，客户端也要缓存，一般每批几百到几千条。
- Cluster 模式下 Pipeline 只能发给同一个节点，客户端需要按槽拆分（Lettuce 异步 API 天然支持，Jedis 的 `JedisCluster` 早期不支持 pipeline）。

## 事务 MULTI/EXEC 的局限

```text
MULTI          → OK
INCR a         → QUEUED
LPUSH a x      → QUEUED       （a 是字符串，运行时会报 WRONGTYPE）
EXEC           → 1) (integer) 1   2) (error) WRONGTYPE ...
```

- **入队阶段**的错误（命令不存在、参数个数错）会让 `EXEC` 返回 `EXECABORT`，整个事务不执行；
- **执行阶段**的错误（类型错误等）只影响那一条，**前面执行成功的不会回滚**；
- 事务内命令拿不到前一条的结果，无法做「读出来判断再写」；
- `WATCH` 提供乐观锁：被 watch 的 key 在 `EXEC` 前被改过，`EXEC` 返回 nil，需要业务重试。高冲突场景重试成本高。

所以 Redis 事务提供的是**隔离性（串行不被插队）**，不提供传统意义的原子性（回滚）。实践中几乎都被 Lua 取代。

> [!WARNING] Spring 的坑
> `RedisTemplate` 每条命令默认从连接池取不同连接，直接调用 `multi()` / `exec()` 会报错或不生效。必须用 `SessionCallback` 让同一连接执行，或 `setEnableTransactionSupport(true)` 并在 `@Transactional` 中使用（会绑定连接到线程，且事务内读命令返回 null，很容易误用）。

## Lua 脚本与 Redis Functions

### Lua 脚本

```lua
-- 比较并删除（分布式锁释放）
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
```

```java
DefaultRedisScript<Long> script = new DefaultRedisScript<>(LUA_SRC, Long.class);
Long r = redisTemplate.execute(script, List.of("lock:order:1"), token);
// Spring Data Redis 会先尝试 EVALSHA，NOSCRIPT 时再回退 EVAL
```

- **原子性**：脚本执行期间主线程不处理其他命令，等价于一条大命令；
- 但**不回滚**：脚本中途报错，前面已执行的写命令保留；
- 必须通过 `KEYS` 传入所有要访问的 key，Cluster 模式下所有 key 必须在同一个槽；
- 复制方式：5.0 起默认「效果复制」（把脚本产生的写命令传给从库/AOF），7.0 移除了整脚本复制，因此脚本里使用随机数、时间等不再有一致性问题；
- 超时：`busy-reply-threshold`（7.0 起的名字，旧名 `lua-time-limit`，默认 5000ms）只是超过后**开始响应其他客户端 BUSY 错误**，脚本并不会被中断。没写过数据的脚本可以 `SCRIPT KILL`，写过数据的只能 `SHUTDOWN NOSAVE`。

### Redis Functions（7.0）

Lua 脚本的问题：脚本属于客户端，服务端只缓存（重启、故障切换后 `SCRIPT` 缓存丢失，需要 `NOSCRIPT` 回退）；没有命名和版本管理。Functions 把脚本变成服务端「库」：

```lua
#!lua name=stocklib
redis.register_function('deduct', function(keys, args)
    local stock = tonumber(redis.call('GET', keys[1]) or '0')
    local n = tonumber(args[1])
    if stock < n then return -1 end
    return redis.call('DECRBY', keys[1], n)
end)
```

```bash
redis-cli -x FUNCTION LOAD REPLACE < stocklib.lua
redis-cli FCALL deduct 1 stock:sku:1001 2
```

| 对比 | EVAL / EVALSHA | Functions |
| --- | --- | --- |
| 归属 | 客户端携带，服务端缓存 | 服务端库，随 RDB/AOF 持久化，并复制到从库 |
| 调用 | 脚本内容或 SHA1 | 函数名 `FCALL` / 只读的 `FCALL_RO` |
| 复用 | 脚本之间无法互调 | 同一库内函数可共享代码 |
| 适用 | 简单一次性脚本 | 业务核心原子逻辑、需要版本管理 |

> [!NOTE]
> Cluster 模式下 `FUNCTION LOAD` 只作用于当前节点，需要对每个主节点都加载（`redis-cli --cluster call` 可批量执行）。

## 慢命令阻塞的后果

单线程意味着**一个慢命令的耗时 = 所有客户端的额外排队时间**：

- 业务侧：所有命令 RT 同时飙升，连接池耗尽，大量超时；
- 高可用侧：主线程不响应 PING，哨兵/集群判定下线触发故障转移，恢复后可能出现脑裂；
- 复制侧：主线程阻塞期间复制缓冲积压，可能触发 `client-output-buffer-limit` 断开从库，引起全量同步风暴。

常见的阻塞来源：

| 来源 | 说明 | 对策 |
| --- | --- | --- |
| `KEYS *`、`FLUSHALL`（同步） | O(N) 全量遍历/释放 | `rename-command` 禁用；用 `SCAN`、`FLUSHALL ASYNC` |
| 大 key 读写 | `HGETALL`、`SMEMBERS`、`LRANGE 0 -1` 返回百万元素 | 分批 `HSCAN`；拆分大 key |
| 大 key 删除/过期 | 同步释放内存 | `UNLINK` + lazyfree 参数 |
| 长时间 Lua | 脚本循环过多 | 控制脚本复杂度，必要时拆分 |
| fork | 大内存实例页表复制 | 控制单实例内存（建议 ≤ 10～20GB），见 [RDB 与 AOF](#/redis/persistence) |
| AOF fsync 慢 | everysec 下 fsync 超过 2 秒会阻塞主线程写 AOF | 磁盘隔离，监控 `aof_delayed_fsync` |
| 集中过期 | 大量 key 同时过期，主动过期占满 25% CPU 时间片 | 过期时间加随机，见 [过期策略与内存淘汰](#/redis/expire) |

## 生产实践与踩坑

**排查「Redis 突然变慢」的顺序：**

1. `SLOWLOG GET 128`：看有没有慢命令。注意 slowlog 只记录**命令执行时间**，不含排队与网络，`slowlog-log-slower-than` 默认 10000μs，建议调到 1000～5000μs，`slowlog-max-len` 调到 1000 左右；
2. `INFO stats` 的 `latest_fork_usec`：fork 是否耗时过长；
3. `LATENCY DOCTOR` / `LATENCY LATEST`（需先 `CONFIG SET latency-monitor-threshold 100`）：分析 fork、AOF、过期等事件延迟；
4. `INFO clients` 的 `blocked_clients`、`connected_clients`，`CLIENT LIST` 看 `qbuf`/`omem` 异常大的客户端；
5. 系统层：CPU 是否被其他进程抢占、是否发生 swap（`INFO memory` 与 `/proc/<pid>/smaps` 的 Swap 字段）、网卡是否打满（大 value 的典型问题）；
6. `redis-cli --intrinsic-latency 60`：测宿主机自身的延迟基线，虚拟机上常见几毫秒的固有抖动。

**常见坑：**

- 绑核：Redis 6 起可以用 `server_cpulist`、`bio_cpulist`、`aof_rewrite_cpulist`、`bgsave_cpulist` 绑核，避免主线程与 fork 子进程抢同一个核。
- 连接数：每个连接都有输入/输出缓冲，几万连接也会占用可观内存，`maxclients` 默认 10000。
- 客户端误用 `MONITOR` 排查问题：高 QPS 下 `MONITOR` 会让输出缓冲暴涨并显著拉低性能，只能短时使用。

## 相关阅读

- [文件系统、页缓存与零拷贝](#/cs/os-io)：IO 多路复用与 fork 写时复制的内核基础
- [虚拟内存、分页与内存管理](#/cs/os-memory)：内存碎片、swap 与 THP
- [Redis 故障排查与安全加固](#/redis/troubleshooting)：延迟突刺的排查路径
- [Redis 大 key 与热 key 治理](#/redis/bigkey)：大 key 与慢命令的治理

## 面试追问

> [!QUESTION] Redis 是单线程的吗？6.0 之后呢？
> 命令执行始终是单线程（主线程）。但 Redis 一直有 bio 后台线程（关闭文件、AOF fsync、lazyfree）和 fork 出的持久化子进程；6.0 起增加了可选的 IO 线程，只负责读 socket、解析协议和写回复，命令仍由主线程串行执行，所以不需要任何锁。

> [!QUESTION] 单线程为什么还这么快？什么时候单线程会成为瓶颈？
> 内存操作 + 高效数据结构 + epoll 多路复用 + 无锁无切换。瓶颈一般在网络 IO（系统调用、协议解析），所以 6.0 把 IO 并行化。当命令本身是 O(N) 或大 value 时，单线程会被一条命令拖住，此时多线程 IO 也无济于事，只能改用法或分片。

> [!QUESTION] Pipeline、事务、Lua 三者区别？
> Pipeline 是客户端批量发送优化，不保证原子；MULTI/EXEC 保证命令连续执行不被插队，但执行期错误不回滚、事务内拿不到中间结果；Lua/Functions 在服务端原子执行且可以有逻辑分支，同样不回滚。需要「读-判断-写」原子性只能用 Lua/Functions。

> [!QUESTION] Lua 脚本执行超时了会怎样？
> 超过 `busy-reply-threshold`（旧名 `lua-time-limit`，默认 5s）后，其他客户端收到 BUSY 错误，脚本继续执行。如果脚本还没写数据可以 `SCRIPT KILL`；写过数据则为保证原子性只能 `SHUTDOWN NOSAVE`，未持久化的数据会丢。所以脚本要短小、可预期。

> [!QUESTION] 为什么 DEL 一个大 key 会卡住，怎么处理？
> 同步删除要逐个释放元素内存，O(N)。用 `UNLINK` 把释放交给 bio 线程；同时打开 `lazyfree-lazy-expire/eviction/server-del` 避免过期、淘汰、覆盖写时的隐式大 key 删除阻塞；更早版本（4.0 前）只能用 `HSCAN`+`HDEL` 分批删除。
