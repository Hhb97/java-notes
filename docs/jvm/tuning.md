# 调优与问题排查

> 原则：**先定位，后调参**。没有数据的调优都是猜测；多数性能问题出在代码与 SQL，而不是 JVM 参数。

## 常用 JVM 参数

```bash
java -Xms4g -Xmx4g \                       # 堆初始 / 最大设相同，避免动态伸缩
     -Xss512k \                            # 线程栈大小
     -XX:MaxMetaspaceSize=512m \
     -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
     -XX:+HeapDumpOnOutOfMemoryError \     # OOM 时自动 dump，生产必开
     -XX:HeapDumpPath=/data/dump/ \
     -Xlog:gc*:file=/data/logs/gc.log:time \
     -jar app.jar
```

容器环境下用 `-XX:MaxRAMPercentage=75` 按容器内存比例设置堆，别写死。

## 命令行诊断工具

| 工具 | 用途 | 示例 |
| --- | --- | --- |
| `jps` | 列出 Java 进程 | `jps -lv` |
| `jstack` | 线程快照：死锁、CPU 高、卡死 | `jstack -l <pid>` |
| `jmap` | 堆统计 / dump | `jmap -histo:live <pid>`、`jmap -dump:live,format=b,file=a.hprof <pid>` |
| `jstat` | GC 统计 | `jstat -gcutil <pid> 1000` |
| `jcmd` | 万能入口 | `jcmd <pid> Thread.print`、`GC.heap_info` |
| Arthas | 在线诊断神器 | `thread -n 3`、`trace`、`watch`、`jad` |
| JFR | 低开销事件记录 | `jcmd <pid> JFR.start duration=60s filename=a.jfr` |

## 场景一：CPU 飙高

```bash
top -Hp <pid>                 # 1. 找到最耗 CPU 的线程 id（十进制）
printf '%x\n' <tid>           # 2. 转成十六进制
jstack <pid> | grep -A 20 <hex_tid>   # 3. 在线程快照里定位代码位置
```

常见原因：死循环、频繁 Full GC、正则回溯、锁自旋。（`Arthas` 里 `thread -n 3` 一步到位。）

## 场景二：内存泄漏 / OOM

1. 先看 GC 日志：老年代回收后是否持续上涨？
2. `jmap -histo:live <pid>` 看哪种对象数量异常；
3. 拿 `.hprof` 用 **MAT / VisualVM** 打开，看 **Dominator Tree** 与 **Path to GC Roots**；
4. 常见泄漏源：
   - 静态集合不断增长（缓存无上限）；
   - `ThreadLocal` 未 `remove()`；
   - 未关闭的连接 / 流 / 监听器；
   - 自定义类加载器未释放。

## 场景三：频繁 Full GC

- 看老年代增长曲线：被**大对象**直接进入老年代？晋升过快？
- Survivor 过小导致对象过早晋升 → 调整新生代比例；
- 元空间不足 → 动态代理 / 反射生成大量类，调大 `MaxMetaspaceSize`；
- 排除代码中 `System.gc()`。

## 场景四：死锁 / 线程卡住

`jstack` 输出末尾直接列出死锁线程与它们互相等待的锁。线程大量 `BLOCKED` / `WAITING` 在同一个位置，通常是锁竞争或下游（数据库、HTTP）变慢。

## 调优流程

```text
监控发现问题 → 定位瓶颈（CPU / 内存 / IO / 锁）→ 假设 → 改一处 → 压测对比 → 固化配置
```

一次只改一个变量，并用同一套压测对比前后指标（吞吐、P99 延迟、GC 次数与总停顿）。
