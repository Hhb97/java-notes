# Spring Boot 入门

Spring Boot 通过**起步依赖 + 自动配置**让你几乎零配置地启动一个生产级应用，内嵌 Tomcat，直接 `java -jar` 运行。

## 最小应用

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.3.0</version>
</parent>
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
</dependencies>
```

```java
@SpringBootApplication
public class App {
    public static void main(String[] args) {
        SpringApplication.run(App.class, args);
    }
}

@RestController
@RequestMapping("/api/users")
class UserController {
    @GetMapping("/{id}")
    public User get(@PathVariable long id) { return service.find(id); }

    @PostMapping
    public User create(@Valid @RequestBody UserDTO dto) { return service.create(dto); }
}
```

> Spring Boot 3.x 需要 **JDK 17+**，且 `javax.*` 包全面改为 `jakarta.*`。

## 自动配置原理

`@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan`。

1. 启动时读取 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`（旧版是 `spring.factories`）里列出的自动配置类；
2. 每个配置类用 `@ConditionalOnClass`、`@ConditionalOnMissingBean`、`@ConditionalOnProperty` 等条件注解判断**是否生效**；
3. 满足条件就注册对应 Bean，**用户自定义的 Bean 优先**（`@ConditionalOnMissingBean`）。

排查哪些自动配置生效：启动参数加 `--debug`，查看 *Conditions Evaluation Report*。

## 配置文件

`application.yml`：

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:mysql://localhost:3306/demo
    username: ${DB_USER:root}          # 环境变量，带默认值
    password: ${DB_PASSWORD}           # 敏感信息不要写进仓库
  profiles:
    active: dev

app:
  upload-dir: /data/upload
```

```java
@ConfigurationProperties(prefix = "app")
public record AppProps(String uploadDir) {}   // 类型安全绑定，需 @EnableConfigurationProperties 或 @ConfigurationPropertiesScan
```

- **多环境**：`application-dev.yml`、`application-prod.yml`，通过 `spring.profiles.active` 切换。
- 优先级（高→低）：命令行参数 > 环境变量 > `application-{profile}.yml` > `application.yml`。

## 常用 Starter

| Starter | 作用 |
| --- | --- |
| `spring-boot-starter-web` | Spring MVC + 内嵌 Tomcat |
| `spring-boot-starter-validation` | 参数校验（`@NotBlank`、`@Valid`） |
| `spring-boot-starter-data-jpa` / `mybatis-spring-boot-starter` | 持久层 |
| `spring-boot-starter-data-redis` | Redis |
| `spring-boot-starter-actuator` | 健康检查、指标监控 |
| `spring-boot-starter-test` | JUnit 5、Mockito、MockMvc |

## 统一异常处理

```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Void>> biz(BizException e) {
        return ResponseEntity.badRequest().body(Result.fail(e.getCode(), e.getMessage()));
    }
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> invalid(MethodArgumentNotValidException e) {
        return Result.fail(400, e.getBindingResult().getFieldError().getDefaultMessage());
    }
}
```

## 测试

```java
@SpringBootTest
@AutoConfigureMockMvc
class UserControllerTest {
    @Autowired MockMvc mvc;

    @Test
    void getUser() throws Exception {
        mvc.perform(get("/api/users/1"))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.name").value("Tom"));
    }
}
```

## 打包部署

```bash
mvn clean package -DskipTests
java -jar target/app.jar --spring.profiles.active=prod
```

生产环境建议：开启 Actuator 的 `/actuator/health` 作为存活探针、配置 `-Xmx`、日志输出到文件或标准输出交给容器收集。
