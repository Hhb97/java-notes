---
level: 进阶
tags: [CI/CD, 流水线, Jenkins, GitLab CI, GitHub Actions, GitOps, ArgoCD, Helm, 制品, 供应链安全]
summary: 把“代码提交到上线”做成可重复、可追溯、可回滚的流水线：持续集成/交付/部署的区别、典型 Java 流水线阶段与质量门禁、构建加速与缓存、制品与镜像管理、环境与配置分离、Jenkins/GitLab CI/GitHub Actions 对比、GitOps（ArgoCD）的拉取式部署、流水线安全与供应链、度量指标（DORA）与常见坑。
---

# CI/CD 流水线与 GitOps

> [!ABSTRACT] 核心要点
> - **CI（持续集成）**：每次提交都自动构建 + 测试，**尽早暴露集成问题**；**CD** 有两层含义：**持续交付**（随时可发布，上线由人点按钮）与**持续部署**（通过全部检查后自动上线）。
> - 流水线的设计原则：**一次构建，处处部署**（同一份制品从测试一路晋级到生产，不为环境重新构建）、**快速失败**（便宜的检查放前面）、**一切即代码**（流水线、配置、基础设施都进 Git）、**每一步可追溯可回滚**。
> - **质量门禁**把“口头规范”变成自动拦截：编译、单测、静态扫描、覆盖率、依赖漏洞、镜像扫描，不过就不能合并/发布。
> - **GitOps**：期望状态声明在 Git，集群里的控制器（ArgoCD/Flux）**拉取并持续对账**；部署 = 合并一个 PR，回滚 = `git revert`，并天然留有审计。
> - 好的交付能力用 **DORA 四指标**衡量：部署频率、变更前置时间、变更失败率、恢复时间。**小步快跑**比“大版本窗口发布”更安全。

> [!NOTE] 关联
> 发布时如何控制风险（灰度、蓝绿、特性开关、数据库变更）见 [发布策略](#/infra/release)；容器与 K8s 基础见 [Docker](#/infra/docker)、[Kubernetes](#/infra/k8s)；依赖与安全扫描见 [Maven](#/java/eng/maven)、[Web 安全](#/security/web)。

## 一、基本概念

<figure class="fig">
<svg viewBox="0 0 800 260" class="dg" role="img" aria-label="持续集成、持续交付、持续部署的范围：开发提交代码触发持续集成，包含构建与自动化测试；持续交付在此基础上把制品部署到预发环境并保证随时可发布，生产发布需要人工批准；持续部署则在通过所有检查后自动发布到生产">
<rect class="b1" x="20" y="40" width="130" height="60" rx="10"/>
<text class="tb" x="85" y="64" text-anchor="middle" dominant-baseline="middle">提交 / PR</text>
<text class="ts" x="85" y="84" text-anchor="middle">主干 / 短分支</text>
<rect class="b3" x="190" y="40" width="190" height="60" rx="10"/>
<text class="tb" x="285" y="64" text-anchor="middle" dominant-baseline="middle">持续集成 CI</text>
<text class="ts" x="285" y="84" text-anchor="middle">构建 · 单测 · 扫描 · 制品</text>
<rect class="b5" x="420" y="40" width="170" height="60" rx="10"/>
<text class="tb" x="505" y="64" text-anchor="middle" dominant-baseline="middle">持续交付 CD</text>
<text class="ts" x="505" y="84" text-anchor="middle">自动部署到测试/预发</text>
<rect class="b2" x="630" y="40" width="150" height="60" rx="10"/>
<text class="tb" x="705" y="64" text-anchor="middle" dominant-baseline="middle">生产</text>
<text class="ts" x="705" y="84" text-anchor="middle">人工审批 / 自动</text>
<line class="l" x1="150" y1="70" x2="190" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="380" y1="70" x2="420" y2="70" marker-end="url(#arr)"/>
<line class="l" x1="590" y1="70" x2="630" y2="70" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="130" width="760" height="110" rx="10"/>
<text class="ts" x="36" y="156"><tspan class="tb">持续交付</tspan>：每个通过流水线的版本都“随时可以上线”，上线动作由人触发（审批窗口、业务时机）</text>
<text class="ts" x="36" y="180"><tspan class="tb">持续部署</tspan>：通过所有自动化检查后直接上线，无人工步骤；要求很高的测试与监控、自动回滚能力</text>
<text class="ts" x="36" y="204"><tspan class="tb">前提</tspan>：自动化测试可靠、主干开发/短生命周期分支、小批量变更、可观测（见 指标监控）、可快速回滚</text>
<text class="ts" x="36" y="228">目标不是“全自动”，而是“让发布变成无聊的日常”：频繁、小步、低风险</text>
</svg>
<figcaption>图 1：CI、持续交付与持续部署的范围</figcaption>
</figure>

## 二、典型 Java 流水线

### 1. 阶段与质量门禁

<figure class="fig">
<svg viewBox="0 0 820 330" class="dg" role="img" aria-label="Java 服务流水线阶段：拉取代码、编译与单元测试、静态代码扫描与依赖漏洞检查、构建制品与镜像并推送仓库、部署到测试环境、集成与接口测试、部署预发并冒烟、审批后灰度发布生产；前面阶段便宜且快，后面阶段昂贵，失败即停止并通知">
<rect class="b1" x="20" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="75" y="52" text-anchor="middle" dominant-baseline="middle">① 拉取代码</text>
<text class="ts" x="75" y="74" text-anchor="middle">检出 + 缓存</text>
<rect class="b3" x="150" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="205" y="52" text-anchor="middle" dominant-baseline="middle">② 编译+单测</text>
<text class="ts" x="205" y="74" text-anchor="middle">mvn verify</text>
<rect class="b3" x="280" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="335" y="52" text-anchor="middle" dominant-baseline="middle">③ 质量扫描</text>
<text class="ts" x="335" y="74" text-anchor="middle">Sonar · SCA</text>
<rect class="b5" x="410" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="465" y="52" text-anchor="middle" dominant-baseline="middle">④ 构建制品</text>
<text class="ts" x="465" y="74" text-anchor="middle">镜像 + 签名</text>
<rect class="b2" x="540" y="30" width="110" height="64" rx="8"/>
<text class="tb" x="595" y="52" text-anchor="middle" dominant-baseline="middle">⑤ 部署测试</text>
<text class="ts" x="595" y="74" text-anchor="middle">自动</text>
<rect class="b2" x="670" y="30" width="130" height="64" rx="8"/>
<text class="tb" x="735" y="52" text-anchor="middle" dominant-baseline="middle">⑥ 集成/接口测试</text>
<text class="ts" x="735" y="74" text-anchor="middle">Testcontainers</text>
<line class="l" x1="130" y1="62" x2="150" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="260" y1="62" x2="280" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="390" y1="62" x2="410" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="520" y1="62" x2="540" y2="62" marker-end="url(#arr)"/>
<line class="l" x1="650" y1="62" x2="670" y2="62" marker-end="url(#arr)"/>
<rect class="b4" x="540" y="130" width="130" height="56" rx="8"/>
<text class="tb" x="605" y="152" text-anchor="middle" dominant-baseline="middle">⑦ 预发 + 冒烟</text>
<text class="ts" x="605" y="172" text-anchor="middle">近生产配置</text>
<rect class="b4" x="700" y="130" width="100" height="56" rx="8"/>
<text class="tb" x="750" y="152" text-anchor="middle" dominant-baseline="middle">⑧ 审批</text>
<text class="ts" x="750" y="172" text-anchor="middle">人工</text>
<path class="l nf" d="M735 94 L735 112 L605 112 L605 130" marker-end="url(#arr)"/>
<line class="l" x1="670" y1="158" x2="700" y2="158" marker-end="url(#arr)"/>
<rect class="b2" x="540" y="215" width="260" height="46" rx="8"/>
<text class="tb" x="670" y="238" text-anchor="middle" dominant-baseline="middle">⑨ 灰度发布生产 + 自动验证/回滚</text>
<line class="l" x1="750" y1="186" x2="750" y2="215" marker-end="url(#arr)"/>
<rect class="bg" x="20" y="120" width="480" height="195" rx="10"/>
<text class="th" x="36" y="144">设计原则</text>
<text class="ts" x="36" y="168">• 快速失败：便宜的检查（编译、单测、扫描）放前面</text>
<text class="ts" x="36" y="190">• 一次构建、处处部署：镜像只构建一次，晋级过程不重建</text>
<text class="ts" x="36" y="212">• 并行化：单测分片、扫描与镜像构建并行，缩短反馈时间</text>
<text class="ts" x="36" y="234">• 目标：提交到“可发布”反馈 &lt; 10~15 分钟（PR 级检查更快）</text>
<text class="ts" x="36" y="256">• 每次执行可追溯到提交、制品版本、执行人</text>
<text class="ts" x="36" y="278">• 失败要有清晰日志与通知；不稳定（flaky）测试要隔离修复，</text>
<text class="ts" x="36" y="298">  否则团队会习惯性点“重跑”，流水线失去可信度</text>
</svg>
<figcaption>图 2：典型 Java 服务的流水线阶段</figcaption>
</figure>

| 门禁 | 内容 | 拦截条件示例 |
| --- | --- | --- |
| 编译与单元测试 | `mvn -B verify` | 编译失败、测试失败 |
| **代码质量**（SAST） | SonarQube、SpotBugs/FindSecBugs、Checkstyle | 新增代码出现 Blocker/Critical 问题；**新代码覆盖率 < 80%**（只卡“新增代码”，避免历史包袱） |
| **依赖漏洞**（SCA） | OWASP Dependency-Check、Snyk、`mvn dependency:tree` 审计 | 存在高危（CVSS ≥ 7）且可修复的漏洞 |
| 密钥泄露扫描 | gitleaks、trufflehog | 提交含密钥/令牌 |
| **镜像扫描** | Trivy、Grype | 基础镜像高危漏洞 |
| 许可证合规 | license 扫描 | 引入禁用许可证 |
| 集成测试 | Testcontainers 起真实 MySQL/Redis/Kafka | 用例失败 |
| 契约测试 | Pact、Spring Cloud Contract | 破坏消费者契约 |
| 性能/冒烟 | 预发环境关键路径 | 核心接口失败、性能退化超阈值 |

测试金字塔：**大量快速的单元测试 + 适量集成测试 + 少量端到端测试**。倒金字塔（主要靠慢且不稳定的 E2E）会让流水线又慢又脆。测试方法见 [测试](#/java/eng/testing)。

### 2. Jenkinsfile / GitLab CI / GitHub Actions 示例

```groovy
// Jenkins 声明式流水线（简化）
pipeline {
  agent { label 'maven-docker' }
  options { timeout(time: 30, unit: 'MINUTES'); disableConcurrentBuilds() }
  environment { REGISTRY = 'registry.example.com/shop'; VERSION = "${env.GIT_COMMIT.take(8)}" }
  stages {
    stage('Build & Test') {
      steps { sh 'mvn -B -ntp verify' }
      post { always { junit '**/target/surefire-reports/*.xml' } }
    }
    stage('Quality Gate') {
      steps { withSonarQubeEnv('sonar') { sh 'mvn -B sonar:sonar' }; timeout(10) { waitForQualityGate abortPipeline: true } }
    }
    stage('Image') {
      steps { sh 'docker build -t $REGISTRY/order:$VERSION . && trivy image --exit-code 1 --severity HIGH,CRITICAL $REGISTRY/order:$VERSION && docker push $REGISTRY/order:$VERSION' }
    }
    stage('Deploy Staging') { steps { sh './deploy.sh staging $VERSION' } }
  }
  post { failure { /* 通知到群 */ } }
}
```

```yaml
# GitHub Actions / GitLab CI 风格（简化，思路相同）
name: ci
on: { pull_request: {}, push: { branches: [main] } }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21, cache: maven }    # 依赖缓存
      - run: mvn -B -ntp verify
      - uses: actions/upload-artifact@v4
        with: { name: jar, path: target/*.jar }
```

### 3. 主流工具对比

| 工具 | 特点 | 适合 |
| --- | --- | --- |
| **Jenkins** | 插件生态最丰富、高度可定制；需自行运维，插件质量参差 | 复杂/历史企业环境 |
| **GitLab CI** | 与 GitLab 一体，`.gitlab-ci.yml`，Runner 灵活 | 使用 GitLab 的团队 |
| **GitHub Actions** | 与 GitHub 一体，市场丰富，托管 Runner 省运维 | 开源/GitHub 团队 |
| 云效、CODING、TeamCity、Drone、Tekton | 各有定位（国内云厂商、K8s 原生等） | 按生态选 |

选择要点：**Runner 隔离与弹性**（用容器/K8s 动态 Agent，避免构建机“雪花化”）、**权限与密钥管理**、**与代码托管集成**、**可复用的流水线模板**（共享库）。

## 三、构建加速

构建慢会直接拖垮开发体验和交付效率。

| 手段 | 说明 |
| --- | --- |
| **依赖缓存** | 缓存 `~/.m2`（Maven）、Gradle 缓存；用**私有仓库代理（Nexus/Artifactory）**加速并防止中央仓库抖动 |
| **增量/并行构建** | `mvn -T 1C` 并行模块；Gradle 构建缓存与增量；只构建改动的模块（monorepo 用变更检测） |
| **Docker 层缓存** | Dockerfile 依赖层在前、代码层在后；BuildKit 缓存挂载、`--cache-from` 远程缓存；多阶段构建（见 [Docker](#/infra/docker)） |
| **测试分片与并行** | 单测分多个 Job 并行；慢测试隔离到夜间流水线 |
| **分层流水线** | PR 只跑快检查（编译、单测、扫描）；合并主干后跑完整集成/E2E；夜间跑耗时的性能/兼容测试 |
| **构建机规格与就近** | 足够 CPU/内存/SSD；Runner 与仓库/镜像仓库同地域 |
| **镜像更小** | JRE/distroless 基础镜像、Spring Boot 分层 JAR（`layertools`）减少推送与拉取量；考虑 **GraalVM Native Image**（构建慢但启动快，按需） |

## 四、制品、镜像与版本

- **制品库**：JAR/依赖放 Nexus/Artifactory，**镜像放 Harbor/云镜像仓库**；制品**不可变**（同一个 tag 不能被覆盖），禁止在生产使用 `latest`；
- **版本与可追溯**：镜像 tag 用 `语义化版本 + 提交 SHA`（如 `1.8.2-3f9a1c2`），并在镜像/应用中暴露构建信息（Spring Boot `build-info`、Actuator `/info`），线上任何实例都能反查到提交和流水线；
- **签名与 SBOM**：用 **Cosign** 对镜像签名，生成 **SBOM**（CycloneDX/SPDX），部署时由准入控制器（Kyverno/OPA Gatekeeper）校验只允许“已签名、已扫描”的镜像；
- **晋级而不是重建**：测试通过的**同一个镜像摘要（digest）**晋级到预发、生产；环境差异只体现在**配置**；
- **保留策略**：定期清理旧镜像与构建产物，保留最近 N 个版本与所有线上正在使用的版本，保证可回滚。

## 五、环境与配置

| 原则 | 做法 |
| --- | --- |
| **配置与代码分离**（12-Factor） | 同一镜像，通过环境变量/ConfigMap/配置中心注入差异；不要为每个环境打一个包 |
| **密钥不入库** | 用 K8s Secret（配合 External Secrets/Vault/云 KMS）、流水线密钥存储；日志中屏蔽（见 [加密与密钥管理](#/security/crypto)） |
| **环境一致** | 开发/测试/预发/生产尽量同构（容器化 + IaC），减少“我这里没问题”；预发使用接近生产的数据规模与配置 |
| **基础设施即代码（IaC）** | Terraform/Pulumi 管理云资源，Helm/Kustomize 管理 K8s 清单，全部走 PR 评审 |
| **临时环境（Preview Env）** | 每个 PR 动态拉起独立环境，评审/测试后自动销毁 |

### Helm 与 Kustomize

- **Helm**：把 K8s 清单模板化为 **Chart**，`values.yaml` 控制差异，版本化发布与回滚（`helm rollback`）；
- **Kustomize**：基于 base + overlay 的**无模板**补丁方式（`kubectl apply -k`），更贴近原生 YAML；
- 两者常与 GitOps 组合：Git 仓库里放 Chart/overlay，控制器渲染并同步。

## 六、GitOps：拉取式部署

### 1. 传统推送 vs GitOps 拉取

<figure class="fig">
<svg viewBox="0 0 820 340" class="dg" role="img" aria-label="GitOps 流程：开发者在应用仓库提交代码，CI 构建并推送镜像，然后更新配置仓库中的镜像版本；集群中的 ArgoCD 持续比较 Git 中的期望状态和集群实际状态，发现差异后自动同步；回滚就是在 Git 中回退提交；集群凭据不外泄到 CI">
<rect class="b1" x="20" y="30" width="150" height="56" rx="8"/>
<text class="tb" x="95" y="52" text-anchor="middle" dominant-baseline="middle">应用仓库</text>
<text class="ts" x="95" y="72" text-anchor="middle">代码 + Dockerfile</text>
<rect class="b3" x="220" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="285" y="52" text-anchor="middle" dominant-baseline="middle">CI 流水线</text>
<text class="ts" x="285" y="72" text-anchor="middle">构建 · 测试 · 推镜像</text>
<rect class="b5" x="400" y="30" width="130" height="56" rx="8"/>
<text class="tb" x="465" y="52" text-anchor="middle" dominant-baseline="middle">镜像仓库</text>
<rect class="b4" x="580" y="30" width="220" height="56" rx="8"/>
<text class="tb" x="690" y="52" text-anchor="middle" dominant-baseline="middle">配置仓库（期望状态）</text>
<text class="ts" x="690" y="72" text-anchor="middle">Helm values / Kustomize / YAML</text>
<line class="l" x1="170" y1="58" x2="220" y2="58" marker-end="url(#arr)"/>
<line class="l" x1="350" y1="58" x2="400" y2="58" marker-end="url(#arr)"/>
<path class="l nf" d="M285 86 L285 112 L690 112 L690 86" marker-end="url(#arr)"/>
<text class="ts" x="488" y="106" text-anchor="middle">CI 改配置仓库的镜像版本（PR/自动提交）</text>
<rect class="b2" x="340" y="160" width="300" height="100" rx="12"/>
<text class="th" x="356" y="184">Kubernetes 集群</text>
<rect class="b" x="356" y="196" width="130" height="50" rx="8"/>
<text class="ts" x="421" y="214" text-anchor="middle" dominant-baseline="middle">ArgoCD / Flux</text>
<text class="ts" x="421" y="232" text-anchor="middle" dominant-baseline="middle">对账 + 同步</text>
<rect class="b" x="500" y="196" width="126" height="50" rx="8"/>
<text class="ts" x="563" y="221" text-anchor="middle" dominant-baseline="middle">实际运行的工作负载</text>
<line class="l" x1="486" y1="221" x2="500" y2="221" marker-end="url(#arr)"/>
<line class="la" x1="690" y1="86" x2="560" y2="160" marker-end="url(#arr-a)"/>
<text class="ta" x="640" y="132" text-anchor="start">拉取</text>
<rect class="bg" x="20" y="160" width="300" height="160" rx="10"/>
<text class="th" x="36" y="184">GitOps 的好处</text>
<text class="ts" x="36" y="206">• 部署 = 合并 PR，评审与审计天然具备</text>
<text class="ts" x="36" y="226">• 回滚 = git revert，状态可复现</text>
<text class="ts" x="36" y="246">• 持续对账：手工改集群会被发现/纠正（防漂移）</text>
<text class="ts" x="36" y="266">• 集群凭据不交给 CI，安全面更小</text>
<text class="ts" x="36" y="286">• 多集群/多环境统一管理（ApplicationSet）</text>
<text class="ts" x="36" y="306">• 灾难恢复：从 Git 重建整个环境</text>
<text class="ts" x="660" y="300" text-anchor="middle">CI（构建）与 CD（部署）职责分离</text>
</svg>
<figcaption>图 3：GitOps：Git 是唯一的事实来源，控制器拉取并对账</figcaption>
</figure>

| | 推送式（CI 里 `kubectl apply`） | **GitOps 拉取式（ArgoCD/Flux）** |
| --- | --- | --- |
| 集群凭据 | 存在 CI 中（泄露风险） | 只在集群内 |
| 状态来源 | 流水线执行结果（难追溯、易漂移） | **Git（声明式、持续对账）** |
| 回滚 | 重新跑流水线或手工 | `git revert`，控制器同步 |
| 审计 | 依赖 CI 日志 | Git 历史 |

### 2. ArgoCD 的 Application 示例

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: order-service-prod, namespace: argocd }
spec:
  project: shop
  source:
    repoURL: https://git.example.com/platform/deploy-config.git
    targetRevision: main
    path: apps/order-service/overlays/prod          # Kustomize/Helm 路径
  destination: { server: https://kubernetes.default.svc, namespace: shop }
  syncPolicy:
    automated: { prune: true, selfHeal: true }      # 自动同步；删除多余资源；纠正手工改动
    syncOptions: [ CreateNamespace=true ]
```

实践要点：

- **应用仓库与配置仓库分离**：避免“CI 更新版本号 → 触发 CI”的循环，也让运维变更与代码变更各自评审；
- **生产建议由 PR 触发并设审批**（`automated` 可只用于测试环境）；
- **Secret 不能明文进 Git**：用 Sealed Secrets、SOPS 加密，或 External Secrets Operator 从 Vault/云密钥服务同步；
- **与渐进式发布结合**：Argo Rollouts / Flagger 实现金丝雀与自动分析回滚（见 [发布策略](#/infra/release)）；
- 同步顺序用 sync waves 与 hooks（数据库迁移 Job 先于应用）。

## 七、分支与提交策略

| 策略 | 说明 | 适用 |
| --- | --- | --- |
| **主干开发（Trunk-Based）** | 短分支（≤ 1~2 天）频繁合入主干，未完成功能用**特性开关**隐藏 | 追求高频交付，需要强自动化测试 |
| **GitHub Flow** | 主干 + 功能分支 + PR，合并即部署 | Web 服务、持续部署 |
| **Git Flow** | develop/release/hotfix 等长期分支 | 版本化交付（客户端、私有化发行）；分支多、合并冲突多 |

建议：服务端团队优先**主干开发 + 短分支 + PR 门禁**；保护主干（必须通过检查、必须评审、禁止强推）；提交规范（Conventional Commits）便于自动生成变更日志与语义化版本。

## 八、流水线自身的安全（供应链）

流水线能拿到源码、密钥和生产权限，是高价值攻击目标：

| 风险 | 对策 |
| --- | --- |
| 恶意 PR 在 CI 里窃取密钥（尤其来自 Fork 的 PR） | 不向 Fork PR 暴露密钥；PR 流水线用最小权限；GitHub 使用 `pull_request` 而非 `pull_request_target` 运行不可信代码 |
| 密钥写在脚本/日志里 | 使用密钥管理器、屏蔽输出；密钥短期化（OIDC 联合身份换取临时凭证，而不是长期 AK/SK） |
| 第三方 Action/插件被投毒 | **固定到提交 SHA**而非可变 tag；审查与白名单；Jenkins 插件及时更新 |
| 依赖投毒/混淆 | 私有仓库代理 + 锁定版本 + 校验和；内部包名保留命名空间防“依赖混淆” |
| 构建机被入侵 | 一次性 Runner（用完销毁）、隔离网络、最小权限；构建与部署凭据分离 |
| 制品被替换 | 不可变 tag/摘要、**镜像签名 + 准入校验**、SLSA 构建溯源 |
| 越权发布 | 生产环境需要审批与角色控制、双人复核、变更窗口与审计 |

参见 [Web 安全：依赖与供应链](#/security/web)、[加密、签名与密钥管理](#/security/crypto)。

## 九、度量：DORA 四指标

| 指标 | 含义 | 精英团队的量级（参考） |
| --- | --- | --- |
| **部署频率** | 多久向生产部署一次 | 按需（每天多次） |
| **变更前置时间** | 提交到上线的时长 | 小于一天 |
| **变更失败率** | 引发故障/回滚的变更占比 | 较低（约 0~15%） |
| **服务恢复时间** | 故障到恢复的时长 | 小于一小时 |

反直觉的结论：**发布越频繁、单次越小，失败率反而越低、恢复越快**；这些指标要用来改进流程，而不是考核个人。再辅以流水线时长、排队时长、flaky 测试比例、回滚率等。

## 十、常见坑

| 坑 | 对策 |
| --- | --- |
| 流水线很慢（>30 分钟），大家绕过它 | 缓存、并行、分层；把慢测试挪出 PR 路径 |
| flaky 测试，习惯性重跑 | 记录并隔离，限时修复；禁止无脑 re-run |
| 为每个环境单独构建一次 | 一次构建，配置注入；用镜像摘要晋级 |
| 手工改线上配置，造成漂移 | GitOps `selfHeal`、限制 `kubectl` 写权限 |
| 密钥进代码/日志 | 密钥管理 + 扫描 + 轮换 |
| 数据库变更和应用发布耦合，无法回滚 | 向后兼容的迁移，分阶段发布（见 [发布策略](#/infra/release)） |
| 部署成功 ≠ 业务正常 | 发布后自动冒烟与指标验证（错误率、延迟），失败自动回滚 |
| `latest` 标签、可变 tag | 使用不可变版本与摘要 |
| 构建机“雪花”，换机器就不通 | 容器化构建环境、Runner 弹性、构建脚本进仓库 |
| 变更只有开发能发，运维不知情 | 发布通知、变更日志、与监控大盘联动（发布事件打注解） |

## 面试追问

> [!QUESTION] CI、持续交付、持续部署的区别？
> CI 是每次提交自动构建并测试，尽早暴露集成问题；持续交付是在此基础上保证每个通过的版本随时可发布，上线由人决定；持续部署是通过全部自动化检查后自动上线。它们依赖可靠的自动化测试、小批量变更、可观测和快速回滚能力。

> [!QUESTION] 一条合格的 Java 服务流水线包含哪些阶段和质量门禁？
> 拉取代码、编译与单元测试、代码质量与依赖漏洞扫描、构建并扫描镜像、部署测试环境、集成与接口测试、预发冒烟、审批后灰度发布和自动验证回滚。门禁包括测试通过、新代码覆盖率、静态扫描、高危漏洞、密钥泄露和镜像漏洞，原则是便宜的检查靠前、快速失败。

> [!QUESTION] 为什么强调“一次构建、处处部署”？
> 在不同环境重新构建会引入差异，测试通过的产物不是上线的产物。应只构建一次镜像，用同一个镜像摘要从测试晋级到生产，环境差异通过外部配置注入，这样可追溯且可复现。

> [!QUESTION] GitOps 是什么？相比在 CI 里直接 kubectl apply 有什么好处？
> GitOps 把期望状态声明在 Git，集群内的控制器如 ArgoCD 持续拉取并对账同步。好处是部署即合并 PR 具备评审和审计，回滚就是 git revert，持续纠正手工漂移，集群凭据不必放在 CI，多集群统一管理，也便于灾难恢复。

> [!QUESTION] 如何加速一条很慢的流水线？
> 缓存依赖和镜像层，并行构建模块与分片测试，PR 只跑快检查而把完整集成和性能测试放到合并后或夜间，使用更合适的构建机和就近的仓库，精简镜像，并修复不稳定测试避免重跑。

> [!QUESTION] 流水线本身有哪些安全风险？
> 来自 Fork 的恶意 PR 窃取密钥、密钥泄露到日志、第三方插件或 Action 被投毒、依赖混淆、构建机被入侵和制品被替换。应最小权限、不向不可信 PR 暴露密钥、固定第三方依赖到摘要、使用短期凭证、一次性 Runner、镜像签名和准入校验，并给生产发布加审批。

> [!QUESTION] 如何衡量研发交付效率？
> 用 DORA 四指标：部署频率、变更前置时间、变更失败率和服务恢复时间。高频小批量发布通常失败率更低、恢复更快，指标用于改进流程而非考核个人。
