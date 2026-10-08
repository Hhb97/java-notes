---
level: 进阶
tags: [Maven, 依赖调解, BOM, 多模块, 生命周期, 插件, enforcer]
summary: 讲清 Maven 的生命周期与插件绑定、依赖调解与传递规则、BOM 统一版本、多模块组织，以及依赖冲突的排查方法。
---

# Maven 构建与依赖管理

> [!ABSTRACT] 核心要点
> - Maven 三套生命周期（clean / default / site）由**阶段 phase** 构成，阶段本身不做事，**插件目标 goal 绑定到阶段**才执行具体任务。
> - 依赖调解两条规则：**最短路径优先**，路径相同则**先声明者优先**；`dependencyManagement` 与 **BOM** 统一版本；`exclusions` 排除传递依赖。
> - 冲突典型症状是 `NoSuchMethodError`、`ClassNotFoundException`、`NoClassDefFoundError`，用 `mvn dependency:tree -Dverbose` 定位，`maven-enforcer` 防止再发生。
> - 多模块：父 pom 聚合（`modules`）+ 继承（`parent`），公共版本和插件在父工程集中管理。
> - SNAPSHOT 依赖不稳定，生产发布应使用 release 版本并锁定。

## 生命周期与插件绑定

<figure class="fig">
<svg viewBox="0 0 760 250" class="dg" role="img" aria-label="Maven default 生命周期的阶段与绑定的插件目标">
<rect class="b1" x="14" y="50" width="100" height="44" rx="8"/>
<text class="tb" x="64" y="72" text-anchor="middle" dominant-baseline="middle">validate</text>
<rect class="b1" x="132" y="50" width="100" height="44" rx="8"/>
<text class="tb" x="182" y="72" text-anchor="middle" dominant-baseline="middle">compile</text>
<rect class="b1" x="250" y="50" width="100" height="44" rx="8"/>
<text class="tb" x="300" y="72" text-anchor="middle" dominant-baseline="middle">test</text>
<rect class="b1" x="368" y="50" width="100" height="44" rx="8"/>
<text class="tb" x="418" y="72" text-anchor="middle" dominant-baseline="middle">package</text>
<rect class="b1" x="486" y="50" width="100" height="44" rx="8"/>
<text class="tb" x="536" y="72" text-anchor="middle" dominant-baseline="middle">verify</text>
<rect class="b1" x="604" y="50" width="70" height="44" rx="8"/>
<text class="tb" x="639" y="72" text-anchor="middle" dominant-baseline="middle">install</text>
<rect class="b1" x="686" y="50" width="62" height="44" rx="8"/>
<text class="tb" x="717" y="72" text-anchor="middle" dominant-baseline="middle">deploy</text>
<line class="l" x1="114" y1="72" x2="132" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="232" y1="72" x2="250" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="72" x2="368" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="468" y1="72" x2="486" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="586" y1="72" x2="604" y2="72" marker-end="url(#arr)"/>
<line class="l" x1="674" y1="72" x2="686" y2="72" marker-end="url(#arr)"/>
<line class="ld" x1="182" y1="94" x2="182" y2="130"/>
<line class="ld" x1="300" y1="94" x2="300" y2="130"/>
<line class="ld" x1="418" y1="94" x2="418" y2="130"/>
<line class="ld" x1="536" y1="94" x2="536" y2="130"/>
<rect class="b3" x="112" y="130" width="140" height="44" rx="6"/>
<text class="tm" x="182" y="152" text-anchor="middle" dominant-baseline="middle">compiler:compile</text>
<rect class="b3" x="240" y="130" width="120" height="44" rx="6"/>
<text class="tm" x="300" y="152" text-anchor="middle" dominant-baseline="middle">surefire:test</text>
<rect class="b3" x="368" y="130" width="100" height="44" rx="6"/>
<text class="tm" x="418" y="152" text-anchor="middle" dominant-baseline="middle">jar:jar</text>
<rect class="b3" x="476" y="130" width="120" height="44" rx="6"/>
<text class="tm" x="536" y="152" text-anchor="middle" dominant-baseline="middle">failsafe:verify</text>
<text class="ts" x="380" y="208" text-anchor="middle">执行某个阶段会按顺序先执行它之前的所有阶段；mvn package = validate → compile → test → package</text>
<text class="ts" x="380" y="228" text-anchor="middle">Spring Boot 的 spring-boot:repackage 绑定到 package 阶段，把 jar 重打包成可执行 fat jar</text>
</svg>
<figcaption>图 1：生命周期阶段与默认绑定的插件目标</figcaption>
</figure>

```bash
mvn clean package -DskipTests              # 跳过测试执行（仍编译测试代码）；-Dmaven.test.skip=true 连编译也跳过
mvn -pl order-service -am package          # 多模块：只构建指定模块及其依赖的模块
mvn -T 1C -B -ntp verify                   # 并行构建，批处理模式，不显示下载进度
mvn dependency:tree -Dincludes=com.fasterxml.jackson.core   # 过滤依赖树
mvn help:effective-pom                     # 查看合并父 pom 后的最终配置
```

> [!NOTE] surefire 与 failsafe
> `surefire` 在 `test` 阶段跑单元测试（`*Test`）；`failsafe` 在 `integration-test/verify` 阶段跑集成测试（`*IT`），失败不会阻止环境清理。见 [单元测试：JUnit 5 与 Mockito](#/java/eng/testing)。

## 依赖：scope 与传递

| scope | 编译 | 测试 | 运行 | 是否传递 | 例子 |
| --- | :-: | :-: | :-: | :-: | --- |
| `compile`（默认） | ✔ | ✔ | ✔ | ✔ | Spring |
| `provided` | ✔ | ✔ | | ✘ | Servlet API、Lombok（运行时由容器提供） |
| `runtime` | | ✔ | ✔ | ✔ | JDBC 驱动 |
| `test` | | ✔ | | ✘ | JUnit、Mockito |
| `import` | | | | | 仅用于 `dependencyManagement` 导入 BOM |

## 依赖调解

<figure class="fig">
<svg viewBox="0 0 740 280" class="dg" role="img" aria-label="依赖调解：最短路径优先，路径相同先声明优先">
<rect class="b1" x="290" y="16" width="160" height="40" rx="8"/>
<text class="tb" x="370" y="36" text-anchor="middle" dominant-baseline="middle">我的项目 app</text>
<rect class="b" x="60" y="100" width="130" height="40" rx="8"/>
<text class="t" x="125" y="120" text-anchor="middle" dominant-baseline="middle">A 1.0</text>
<rect class="b" x="300" y="100" width="130" height="40" rx="8"/>
<text class="t" x="365" y="120" text-anchor="middle" dominant-baseline="middle">B 1.0</text>
<rect class="b2" x="540" y="100" width="150" height="40" rx="8"/>
<text class="tb" x="615" y="120" text-anchor="middle" dominant-baseline="middle">C 1.0（直接依赖）</text>
<rect class="b3" x="60" y="190" width="130" height="40" rx="8"/>
<text class="t" x="125" y="210" text-anchor="middle" dominant-baseline="middle">D 1.1</text>
<rect class="b3" x="300" y="190" width="130" height="40" rx="8"/>
<text class="t" x="365" y="210" text-anchor="middle" dominant-baseline="middle">D 2.0</text>
<rect class="b2" x="540" y="190" width="150" height="40" rx="8"/>
<text class="tb" x="615" y="210" text-anchor="middle" dominant-baseline="middle">D 3.0（路径更短）</text>
<line class="l" x1="330" y1="56" x2="150" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="370" y1="56" x2="370" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="410" y1="56" x2="590" y2="100" marker-end="url(#arr)"/>
<line class="l" x1="125" y1="140" x2="125" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="365" y1="140" x2="365" y2="190" marker-end="url(#arr)"/>
<line class="l" x1="615" y1="140" x2="615" y2="190" marker-end="url(#arr)"/>
<text class="ts" x="370" y="256" text-anchor="middle">D 的三条路径长度都是 3 时取“最先声明”的 A→D 1.1；若 app 直接声明了 D，则路径为 1，直接胜出</text>
</svg>
<figcaption>图 2：依赖调解规则示意</figcaption>
</figure>

规则要点：

1. **最短路径优先**（路径长度即依赖深度）；
2. 长度相同 → **pom 中先声明的优先**；
3. 直接声明（深度 1）总是优先于传递依赖——**想固定某个传递依赖的版本，最直接的办法就是在 `dependencyManagement` 或自己的 `dependencies` 中声明它**。

## 版本统一：dependencyManagement 与 BOM

```xml
<dependencyManagement>
  <dependencies>
    <dependency>                                   <!-- 导入 BOM：一次性管理一整套依赖的版本 -->
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>3.3.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>common</artifactId>
      <version>${project.version}</version>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>                                     <!-- 使用时不写 version -->
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
</dependencies>
```

`dependencyManagement` 只**声明版本**，不会真的引入依赖；子模块使用时才引入。覆盖 BOM 里的某个版本：`<properties><jackson-bom.version>2.17.1</jackson-bom.version></properties>`（Spring Boot BOM 中很多版本由属性控制）。

## 多模块项目

```text
parent                    (packaging=pom：聚合 + 版本/插件管理)
├── pom.xml               <modules> common / order-api / order-service
├── common                工具、通用 DTO
├── order-api             对外接口与契约（被其他服务依赖）
└── order-service         启动模块（依赖 common、order-api）
```

- **继承**（`<parent>`）：子模块继承父 pom 的 properties、dependencyManagement、pluginManagement；
- **聚合**（`<modules>`）：在父工程执行命令会按**模块依赖关系的拓扑顺序**构建；
- 版本统一：用 `${revision}` + `flatten-maven-plugin` 做 CI 友好版本管理，或用 `versions-maven-plugin` 批量改版本；
- 分层建议：`api`（契约，极少依赖）← `service`（实现）；避免循环依赖，Maven 会直接拒绝循环。

## 依赖冲突排查

### 典型症状

| 异常 | 含义 |
| --- | --- |
| `NoSuchMethodError` / `NoSuchFieldError` | 编译用的是新版本，运行时加载了旧版本（方法不存在）|
| `ClassNotFoundException` / `NoClassDefFoundError` | 依赖缺失或被排除 |
| `AbstractMethodError` / `IncompatibleClassChangeError` | 接口/类在不同版本间不兼容 |
| `LinkageError` | 同一个类被不同类加载器加载，见 [类加载与双亲委派](#/java/jvm/classloader) |

### 排查步骤

```bash
# 1. 看依赖树，-Dverbose 会显示被调解“省略”的版本及原因
mvn dependency:tree -Dverbose -Dincludes=org.slf4j

# 2. 找出出问题的类实际来自哪个 jar（运行时）
#    启动参数  -verbose:class | grep NoSuchClass   或   Arthas: sc -d com.foo.Bar

# 3. 分析未使用 / 隐式使用的依赖
mvn dependency:analyze
```

```xml
<!-- 排除传递依赖 -->
<dependency>
  <groupId>com.foo</groupId><artifactId>foo</artifactId><version>1.0</version>
  <exclusions>
    <exclusion><groupId>commons-logging</groupId><artifactId>commons-logging</artifactId></exclusion>
  </exclusions>
</dependency>
```

### 用 enforcer 把规则固化到构建中

```xml
<plugin>
  <artifactId>maven-enforcer-plugin</artifactId>
  <executions><execution>
    <goals><goal>enforce</goal></goals>
    <configuration><rules>
      <dependencyConvergence/>                  <!-- 同一依赖出现多个版本时直接构建失败 -->
      <requireJavaVersion><version>[17,)</version></requireJavaVersion>
      <bannedDependencies><excludes><exclude>commons-logging:commons-logging</exclude></excludes></bannedDependencies>
    </rules></configuration>
  </execution></executions>
</plugin>
```

## 常用插件

| 插件 | 作用 |
| --- | --- |
| `maven-compiler-plugin` | 编译，设置 `release`，注解处理器路径（Lombok + MapStruct 需注意顺序） |
| `maven-surefire/failsafe` | 单元 / 集成测试 |
| `spring-boot-maven-plugin` | 打包可执行 jar，构建镜像（`build-image`） |
| `maven-shade-plugin` / `maven-assembly` | 打 uber jar / 自定义分发包 |
| `jacoco-maven-plugin` | 覆盖率 |
| `versions-maven-plugin` | 升级依赖、统一版本 |
| `maven-source/javadoc-plugin` | 附带源码与文档发布 |

## 仓库与 settings

- 解析顺序：**本地仓库** `~/.m2/repository` → 私服（Nexus / Artifactory，代理中央仓库并托管内部包）→ 中央仓库；
- `settings.xml` 配置镜像（国内常用阿里云镜像）、私服账号（密码用加密形式 `mvn --encrypt-password`）、`profile`；
- **SNAPSHOT** 版本每次构建可能拉取最新快照，**生产构建要用固定的 release 版本**；发布 release 后不可覆盖；
- 本地缓存损坏表现为 `.lastUpdated` 文件，删除对应目录后重新下载。

## Gradle 对比

| | Maven | Gradle |
| --- | --- | --- |
| 配置 | 声明式 XML，约定强 | Groovy/Kotlin DSL，灵活 |
| 构建速度 | 一般 | **增量构建、构建缓存、守护进程**更快 |
| 学习成本 | 低，一致性好 | 较高，脚本可写逻辑 |
| 生态 | 企业项目主流 | Android 默认、大型项目增多 |

## 面试追问

> [!QUESTION] Maven 的依赖冲突是如何解决的？
> 遵循最短路径优先；路径相同取先声明的；直接声明优先于传递依赖。可用 `dependencyManagement`/BOM 统一版本，用 `exclusions` 排除，并用 `dependency:tree` 与 enforcer 的 `dependencyConvergence` 检查。

> [!QUESTION] `mvn package` 和 `mvn install` 的区别？
> package 只打包到 target；install 在 package 之后把构件安装到本地仓库，供本机其他项目引用；deploy 则发布到远程仓库。

> [!QUESTION] dependencyManagement 和 dependencies 的区别？
> 前者只声明版本与范围，不引入依赖，用于统一管理；后者才真正引入依赖。子模块在 dependencies 中引用时可省略版本。

> [!QUESTION] 线上出现 NoSuchMethodError 怎么排查？
> 用 `dependency:tree -Dverbose` 找到同一库的多个版本，确认运行时加载的是哪个 jar（`-verbose:class` 或 Arthas `sc -d`），再通过 dependencyManagement 固定版本或排除旧版本，最后用 enforcer 防止回归。

> [!QUESTION] SNAPSHOT 为什么不建议用于生产？
> SNAPSHOT 版本内容可变，同一版本号两次构建结果可能不同，导致构建不可重现；生产应使用不可变的 release 版本并锁定依赖。
