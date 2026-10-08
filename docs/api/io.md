# IO 与 NIO

## 传统 IO：流

| | 字节流 | 字符流 |
| --- | --- | --- |
| 输入 | `InputStream` | `Reader` |
| 输出 | `OutputStream` | `Writer` |
| 文件 | `FileInputStream` / `FileOutputStream` | `FileReader` / `FileWriter` |
| 缓冲 | `BufferedInputStream` ... | `BufferedReader` ... |
| 桥接 | | `InputStreamReader`（字节 → 字符，可指定编码） |

采用**装饰器模式**叠加功能：

```java
try (var reader = new BufferedReader(
        new InputStreamReader(new FileInputStream("a.txt"), StandardCharsets.UTF_8))) {
    String line;
    while ((line = reader.readLine()) != null) {
        System.out.println(line);
    }
}
```

## NIO.2：Files 与 Path（推荐）

日常文件操作优先使用 `java.nio.file`，一行搞定：

```java
Path p = Path.of("data", "a.txt");

String text = Files.readString(p);                        // 11+
List<String> lines = Files.readAllLines(p);
Files.writeString(p, "hello", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING);

try (Stream<Path> s = Files.walk(Path.of("."))) {         // 递归遍历，Stream 需要关闭
    s.filter(f -> f.toString().endsWith(".java")).forEach(System.out::println);
}
```

大文件逐行处理用 `Files.lines(p)`（惰性读取，同样要关闭）。

## NIO 三大件

- **Buffer**：数据容器，有 `position / limit / capacity`；`flip()` 切换读写模式。
- **Channel**：双向通道（`FileChannel`、`SocketChannel`），数据在 Channel 与 Buffer 之间流动。
- **Selector**：**多路复用**，一个线程监控多个 Channel 的就绪事件，是高并发网络服务（Netty）的基础。

```text
BIO：一连接一线程，阻塞        → 连接数一多线程爆炸
NIO：Selector 多路复用，非阻塞 → 少量线程处理大量连接
AIO：异步回调（Linux 上实际基于 epoll 模拟，使用较少）
```

## 序列化

```java
class User implements Serializable {
    private static final long serialVersionUID = 1L;
    private String name;
    private transient String password;   // transient：不参与序列化
}
```

JDK 原生序列化有安全隐患（反序列化漏洞）且性能一般，实际项目多用 **JSON（Jackson）/ Protobuf**。

## 小结

- 读写文本：`Files.readString` / `writeString`。
- 流式处理：`try-with-resources` + `Buffered*`。
- 永远**显式指定字符集**，永远**关闭资源**。
