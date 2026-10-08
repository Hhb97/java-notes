---
level: 深入
tags: [分布式锁, SETNX, Redisson, 看门狗, RedLock, fencing token, ZooKeeper]
summary: 从 SET NX PX 的正确写法出发，讲清锁过期、误删、主从切换丢锁等陷阱，Redisson 看门狗与可重入实现，以及 RedLock 的争议和 fencing token。
---

# 分布式锁

> [!ABSTRACT] 核心要点
> - 单实例正确写法：`SET key uuid NX PX ttl` 加锁，**Lua 比较 value 后再 DEL** 解锁；缺任何一步都会出事故。
> - 三个经典坑：**锁过期业务未完成**、**误删他人锁**、**主从切换导致锁丢失**。
> - **Redisson** 用 Hash 结构实现可重入锁，**看门狗**每 `lockWatchdogTimeout/3` 自动续期；指定了 leaseTime 则不续期。
> - Redis 锁是**效率锁**（偶发失效可容忍）；要求**绝对互斥**的场景需要 **fencing token** 或用 ZooKeeper / etcd + 业务层幂等。
> - RedLock 争议：依赖时钟与进程不暂停的假设，Kleppmann 认为不能保证安全，实践中少用。

## 最朴素的实现与问题

```text
# 加锁：不存在才设置，同时设置过期时间（必须原子，不能先 SETNX 再 EXPIRE）
SET lock:order:1001 <uuid> NX PX 30000
```

| 问题 | 原因 | 对策 |
| --- | --- | --- |
| 死锁 | 持有者崩溃，没设置过期 | 一定带 `PX`，且与 `NX` 在同一条命令 |
| 误删他人锁 | A 超时，锁过期被 B 获得，A 完成后 `DEL` 把 B 的锁删了 | value 存**唯一标识**，解锁时比较再删 |
| 解锁不原子 | `GET` 判断后 `DEL` 之间锁可能过期 | **Lua 脚本**保证原子 |
| 业务超时 | 业务执行时间 > TTL，锁自动释放，出现并发 | 看门狗续期 / 合理 TTL / 业务幂等兜底 |

```lua
-- 安全解锁：KEYS[1]=锁名，ARGV[1]=加锁时的唯一值
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
```

```java
// Spring Data Redis 示例
String token = UUID.randomUUID().toString();
Boolean ok = redis.opsForValue().setIfAbsent(key, token, Duration.ofSeconds(30));
if (Boolean.TRUE.equals(ok)) {
    try {
        doBusiness();
    } finally {
        redis.execute(UNLOCK_SCRIPT, List.of(key), token);   // DefaultRedisScript<Long>
    }
}
```

> [!WARNING] 不要用 value 当作可重入标识
> 简单实现里 value 是每次随机的，**不可重入**：同一线程再次加锁会失败（死等自己）。需要可重入请使用 Redisson，或自己实现“线程标识 + 计数”。

## Redisson：可重入锁与看门狗

### 数据结构

Redisson 用 **Hash** 保存锁：

```text
lock:order:1001  →  { "8f3a...:thread-21" : 2 }     # field = 客户端UUID:线程ID，value = 重入次数
PEXPIRE 30000
```

加锁 Lua（简化）：

```lua
if redis.call('exists', KEYS[1]) == 0 then
    redis.call('hincrby', KEYS[1], ARGV[2], 1)
    redis.call('pexpire', KEYS[1], ARGV[1])
    return nil
end
if redis.call('hexists', KEYS[1], ARGV[2]) == 1 then   -- 同一线程重入
    redis.call('hincrby', KEYS[1], ARGV[2], 1)
    redis.call('pexpire', KEYS[1], ARGV[1])
    return nil
end
return redis.call('pttl', KEYS[1])                      -- 被他人持有，返回剩余 TTL
```

解锁：重入计数 -1，减到 0 时 `DEL` 并 `PUBLISH` 通知等待者，等待者**订阅频道而不是自旋**，避免空转。

### 看门狗（Watchdog）

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="Redisson 看门狗自动续期时序">
<rect class="b1" x="40" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="95" y="37" text-anchor="middle" dominant-baseline="middle">业务线程</text>
<rect class="b2" x="310" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="365" y="37" text-anchor="middle" dominant-baseline="middle">看门狗定时任务</text>
<rect class="b3" x="580" y="20" width="110" height="34" rx="6"/>
<text class="tb" x="635" y="37" text-anchor="middle" dominant-baseline="middle">Redis</text>
<line class="ld" x1="95" y1="54" x2="95" y2="262"/>
<line class="ld" x1="365" y1="54" x2="365" y2="262"/>
<line class="ld" x1="635" y1="54" x2="635" y2="262"/>
<line class="l" x1="95" y1="84" x2="635" y2="84" marker-end="url(#arr)"/>
<text class="ts" x="365" y="76" text-anchor="middle">lock()：未指定 leaseTime，默认 TTL 30s</text>
<line class="l" x1="95" y1="114" x2="365" y2="114" marker-end="url(#arr)"/>
<text class="ts" x="230" y="106" text-anchor="middle">注册续期任务</text>
<text class="ta" x="365" y="148" text-anchor="middle">每 10s（TTL/3）</text>
<line class="la" x1="365" y1="160" x2="635" y2="160" marker-end="url(#arr-a)"/>
<text class="ts" x="500" y="152" text-anchor="middle">检查持有者仍是自己 → PEXPIRE 30s</text>
<text class="t" x="110" y="196">业务执行中…（可超过 30s）</text>
<line class="l" x1="95" y1="226" x2="635" y2="226" marker-end="url(#arr)"/>
<text class="ts" x="365" y="218" text-anchor="middle">unlock()：删除锁并取消续期任务</text>
<text class="ts" x="365" y="254" text-anchor="middle">客户端进程崩溃 → 不再续期 → 锁最多 30s 后自动过期</text>
</svg>
<figcaption>图 1：看门狗续期保证“业务不结束锁不过期，进程崩溃锁会过期”</figcaption>
</figure>

- 默认 `lockWatchdogTimeout=30000ms`，每 `1/3` 周期续期；
- **只有不指定 leaseTime 才启用看门狗**：`lock.lock(10, TimeUnit.SECONDS)` 或 `tryLock(wait, lease, unit)` 指定了 lease 则到期自动释放、不续期；
- 看门狗运行在客户端线程，**GC 长停顿或进程卡死会让续期失败**，这是下文 fencing token 要解决的问题。

```java
RLock lock = redisson.getLock("lock:order:" + orderId);
boolean ok = lock.tryLock(3, TimeUnit.SECONDS);   // 最多等 3s，不指定 lease → 看门狗
if (!ok) throw new BizException("系统繁忙");
try {
    doBusiness();
} finally {
    if (lock.isHeldByCurrentThread()) lock.unlock();   // 避免解他人锁抛 IllegalMonitorStateException
}
```

### Redisson 的其他锁

| 类型 | 用途 |
| --- | --- |
| `getFairLock` | 公平锁，按请求顺序获取（基于列表 + 有序集合） |
| `getReadWriteLock` | 读写锁，读读共享 |
| `getMultiLock` | 联锁，多把锁同时获取（跨 Redis 实例）|
| `getSemaphore` / `getCountDownLatch` | 分布式信号量、闭锁 |
| `getSpinLock` | 自旋锁，减少 pub/sub 通知开销 |

## 主从切换丢锁

<figure class="fig">
<svg viewBox="0 0 740 260" class="dg" role="img" aria-label="Redis 主从切换导致两个客户端同时持有锁">
<rect class="b1" x="30" y="30" width="110" height="34" rx="6"/>
<text class="tb" x="85" y="47" text-anchor="middle" dominant-baseline="middle">Client A</text>
<rect class="b3" x="250" y="30" width="110" height="34" rx="6"/>
<text class="tb" x="305" y="47" text-anchor="middle" dominant-baseline="middle">Master</text>
<rect class="b5" x="470" y="30" width="110" height="34" rx="6"/>
<text class="tb" x="525" y="47" text-anchor="middle" dominant-baseline="middle">Replica</text>
<rect class="b2" x="640" y="30" width="80" height="34" rx="6"/>
<text class="tb" x="680" y="47" text-anchor="middle" dominant-baseline="middle">Client B</text>
<line class="ld" x1="85" y1="64" x2="85" y2="240"/>
<line class="ld" x1="305" y1="64" x2="305" y2="240"/>
<line class="ld" x1="525" y1="64" x2="525" y2="240"/>
<line class="ld" x1="680" y1="64" x2="680" y2="240"/>
<line class="l" x1="85" y1="94" x2="305" y2="94" marker-end="url(#arr)"/>
<text class="ts" x="195" y="86" text-anchor="middle">① SET lock NX → OK</text>
<text class="ts" x="330" y="124">② 异步复制尚未同步</text>
<text class="ta" x="305" y="154" text-anchor="middle">③ Master 宕机</text>
<text class="ts" x="525" y="154" text-anchor="middle">④ 选举为新 Master（没有 lock）</text>
<line class="l" x1="680" y1="184" x2="525" y2="184" marker-end="url(#arr)"/>
<text class="ts" x="602" y="176" text-anchor="middle">⑤ SET lock NX → OK</text>
<text class="ta" x="380" y="226" text-anchor="middle">A 与 B 同时认为自己持有锁</text>
</svg>
<figcaption>图 2：异步复制下，主从切换会导致锁丢失</figcaption>
</figure>

对策：

1. **业务幂等兜底**：把锁当作“减少重复执行”的优化，而不是唯一的正确性保证；数据库用唯一键、版本号做最终防线；
2. `WAIT numreplicas timeout` 强制同步到从库（降低概率，仍不能完全保证）；
3. 要求强一致就不要用 Redis 锁，换 **ZooKeeper / etcd**（基于共识协议）。

## RedLock 与争议

算法（Redis 作者 antirez 提出）：

1. 取当前时间 T1；
2. 依次向 **N 个（通常 5 个）独立**的 Redis 主节点用相同 key 和随机值加锁，每次请求设置很短的超时；
3. 当**多数派（≥ N/2+1）加锁成功**且总耗时（T2-T1）小于锁的有效期，才算获得锁；有效期 = 初始 TTL - 耗时 - 时钟漂移；
4. 失败则向所有节点释放。

Martin Kleppmann 的批评：

- **进程暂停**（GC、调度、网络延迟）：客户端拿到锁后暂停，锁过期，另一个客户端拿到锁，恢复后仍以为自己持有 → 同时写；
- **时钟跳跃**：系统时间被 NTP 调整，导致锁提前过期；
- 因此 RedLock 在“正确性”场景下不安全，在“效率”场景下又过重（要部署 5 个独立节点）。

### fencing token

<figure class="fig">
<svg viewBox="0 0 740 250" class="dg" role="img" aria-label="fencing token 通过存储端拒绝旧令牌来保证安全">
<rect class="b1" x="30" y="30" width="100" height="34" rx="6"/>
<text class="tb" x="80" y="47" text-anchor="middle" dominant-baseline="middle">Client A</text>
<rect class="b3" x="270" y="30" width="110" height="34" rx="6"/>
<text class="tb" x="325" y="47" text-anchor="middle" dominant-baseline="middle">锁服务</text>
<rect class="b2" x="440" y="30" width="100" height="34" rx="6"/>
<text class="tb" x="490" y="47" text-anchor="middle" dominant-baseline="middle">Client B</text>
<rect class="b5" x="620" y="30" width="100" height="34" rx="6"/>
<text class="tb" x="670" y="47" text-anchor="middle" dominant-baseline="middle">存储/DB</text>
<line class="ld" x1="80" y1="64" x2="80" y2="230"/>
<line class="ld" x1="325" y1="64" x2="325" y2="230"/>
<line class="ld" x1="490" y1="64" x2="490" y2="230"/>
<line class="ld" x1="670" y1="64" x2="670" y2="230"/>
<text class="ts" x="200" y="92" text-anchor="middle">获得锁，token=33</text>
<line class="l" x1="325" y1="98" x2="80" y2="98" marker-end="url(#arr)"/>
<text class="ts" x="80" y="126" text-anchor="start">A 长时间 GC 暂停…</text>
<text class="ts" x="408" y="126" text-anchor="middle">锁过期 → B 获得锁，token=34</text>
<line class="l" x1="490" y1="160" x2="670" y2="160" marker-end="url(#arr)"/>
<text class="ts" x="580" y="152" text-anchor="middle">写入（token=34）→ 接受</text>
<line class="l" x1="80" y1="198" x2="670" y2="198" marker-end="url(#arr)"/>
<text class="ta" x="375" y="190" text-anchor="middle">A 恢复后写入（token=33）→ 被拒绝（小于已见最大 token）</text>
</svg>
<figcaption>图 3：fencing token——由资源端拒绝过期持有者的写入</figcaption>
</figure>

锁服务每次授予锁时返回**单调递增的令牌**，客户端带着令牌访问资源，资源端记录已见最大令牌并拒绝更小者。数据库里的等价做法是**版本号 / 乐观锁**：`UPDATE ... SET ver=ver+1 WHERE id=? AND ver=?`。Redis 没有原生单调令牌（可用 `INCR` 另行生成，但与锁不是原子绑定）；ZooKeeper 的 `zxid` / 临时顺序节点序号、etcd 的 `revision` 天然可用。

## 与 ZooKeeper / etcd 对比

| | Redis | ZooKeeper | etcd |
| --- | --- | --- | --- |
| 一致性 | 异步复制，AP 倾向 | ZAB，强一致 | Raft，强一致 |
| 性能 | 极高 | 中 | 中 |
| 锁释放 | TTL 过期 | **会话断开自动删除临时节点** | Lease 租约 |
| 公平性 | 默认非公平 | 顺序节点天然公平，**监听前一个节点**避免惊群 | Revision 排队 |
| 令牌 | 无 | zxid / 节点序号 | revision |
| 适用 | 高并发、可容忍极低概率重复 | 强正确性、选主 | 同上 |

## 选型与使用建议

- **默认 Redisson + 业务幂等**：绝大多数场景（防重复提交、定时任务单实例执行、缓存重建）足够；
- 锁粒度尽量小（`lock:order:{id}` 而不是全局锁），临界区尽量短，不要在锁里调用慢 IO 或下游；
- `tryLock` 带等待超时，失败快速返回，不要无限等；
- 解锁放 `finally`，并判断 `isHeldByCurrentThread()`；
- 强一致场景：数据库行锁 / 唯一约束、ZooKeeper/etcd、或业务层 fencing；
- 监控：锁等待时间、获取失败率、持有时长，发现热点锁。

## 面试追问

> [!QUESTION] 如何正确实现 Redis 分布式锁？
> `SET key uuid NX PX ttl` 原子加锁；唯一 value 标识持有者；Lua 比较 value 后删除来解锁；通过看门狗续期解决业务超时；业务层再做幂等兜底。

> [!QUESTION] 锁过期但业务没执行完怎么办？
> 使用 Redisson 看门狗自动续期（不指定 leaseTime）；续期失败（进程卡死/GC）要靠 fencing token 或数据库乐观锁在资源端兜底。

> [!QUESTION] Redisson 看门狗的原理和注意点？
> 加锁时未指定 leaseTime，默认 30s，并启动定时任务每 10s 对锁 `PEXPIRE` 续期；解锁时取消。注意：指定 leaseTime 就不会续期；它在客户端线程里运行，进程冻结时无法续期。

> [!QUESTION] 主从切换为什么会丢锁？RedLock 能解决吗？
> 异步复制，锁还没同步到从库主库就挂了，新主上没有锁。RedLock 用多个独立实例的多数派降低概率，但依赖时钟与进程不暂停的假设，Kleppmann 指出仍不安全，且部署成本高，实践中很少采用。

> [!QUESTION] Redis 锁与 ZooKeeper 锁怎么选？
> Redis 性能高、实现简单，适合效率型场景；ZooKeeper 基于共识协议，临时节点随会话消失自动释放，有序节点公平，更适合强正确性与选主。两者都不能替代资源端的幂等与版本校验。
