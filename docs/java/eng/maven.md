# Maven 构建

Maven 以**约定优于配置**管理项目构建、依赖和发布。

## 坐标与 pom.xml

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.example</groupId>        <!-- 组织 -->
  <artifactId>order-service</artifactId><!-- 项目名 -->
  <version>1.0.0-SNAPSHOT</version>     <!-- 版本；SNAPSHOT 表示开发中 -->
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>2.0.13</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
```

## 依赖范围 scope

| scope | 编译 | 测试 | 运行 | 例子 |
| --- | :-: | :-: | :-: | --- |
| `compile`（默认） | ✔ | ✔ | ✔ | Spring |
| `provided` | ✔ | ✔ | | Servlet API、Lombok |
| `runtime` | | ✔ | ✔ | JDBC 驱动 |
| `test` | | ✔ | | JUnit |

## 生命周期与常用命令

```bash
mvn clean            # 清理 target
mvn compile          # 编译
mvn test             # 运行测试
mvn package          # 打包 jar / war
mvn install          # 安装到本地仓库 ~/.m2
mvn deploy           # 发布到远程仓库

mvn clean package -DskipTests     # 跳过测试
mvn -pl order-service -am package # 多模块：只构建指定模块及其依赖
mvn dependency:tree               # 查看依赖树，排查冲突
```

默认生命周期阶段按序执行：`validate → compile → test → package → verify → install → deploy`，**执行某阶段会先执行它之前的所有阶段**。

## 依赖管理

### 依赖传递与冲突

- 依赖具有传递性；冲突时遵循**最短路径优先**，路径相同则**先声明者优先**。
- 排除不想要的传递依赖：

```xml
<dependency>
  <groupId>com.foo</groupId><artifactId>foo</artifactId><version>1.0</version>
  <exclusions>
    <exclusion><groupId>commons-logging</groupId><artifactId>commons-logging</artifactId></exclusion>
  </exclusions>
</dependency>
```

### dependencyManagement 统一版本

```xml
<dependencyManagement>
  <dependencies>
    <dependency>                              <!-- 导入 BOM -->
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>3.3.0</version>
      <type>pom</type><scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

子模块再引用时**不写 version**，由父工程集中管理。

## 多模块项目

```text
parent (packaging=pom)
├── common
├── order-api
└── order-service   ← 依赖 common、order-api
```

父 pom 里用 `<modules>` 聚合，子模块用 `<parent>` 继承。

## 仓库

查找顺序：**本地仓库** `~/.m2/repository` → 私服（Nexus / Artifactory）→ 中央仓库。国内通常在 `settings.xml` 配置镜像加速。

## Gradle 对比

Gradle 用 Groovy / Kotlin DSL，增量构建与缓存更快、配置更灵活；Maven 约定清晰、生态与文档广泛，企业项目仍以 Maven 居多。
