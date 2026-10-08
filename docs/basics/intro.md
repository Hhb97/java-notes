# 语言概览与环境

## Java 是什么

Java 是一门**静态类型、面向对象、编译到字节码**的语言。源码 `.java` 经 `javac` 编译成 `.class` 字节码，由 JVM 解释执行并经 JIT 编译为机器码，因此能做到「一次编写，到处运行」。

| 概念 | 含义 |
| --- | --- |
| JVM | Java 虚拟机，执行字节码，屏蔽操作系统差异 |
| JRE | JVM + 核心类库，运行程序所需 |
| JDK | JRE + 编译器、调试工具（`javac`、`jar`、`jcmd`…），开发所需 |

## 版本选择

LTS（长期支持）版本：**8、11、17、21**。新项目建议 17 或 21；老系统多数停留在 8 / 11。

## 第一个程序

```java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello, Java!");
    }
}
```

```bash
javac Hello.java   # 生成 Hello.class
java Hello         # 运行
java Hello.java    # JDK 11+ 可直接运行单文件源码
```

## 项目结构约定

```text
my-app
├── pom.xml                  # Maven 配置
└── src
    ├── main
    │   ├── java             # 源码，目录与包名一致
    │   └── resources        # 配置文件
    └── test
        └── java             # 单元测试
```

- **包（package）** 用域名倒置命名，如 `com.example.order.service`。
- 一个 `.java` 文件里最多一个 `public` 类，且类名与文件名相同。

## 常用工具

- **IDE**：IntelliJ IDEA（首选）、Eclipse、VS Code + Java 扩展。
- **构建**：Maven / Gradle，见 [Maven 构建](#/eng/maven)。
- **诊断**：`jps`、`jstack`、`jmap`、`jcmd`，见 [调优与问题排查](#/jvm/tuning)。
