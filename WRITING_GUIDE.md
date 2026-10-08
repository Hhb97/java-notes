# 笔记写作规范

本知识库定位为「**高级工程师笔记**」：不是入门教程，而是能支撑线上排障、技术选型与资深面试的深度笔记。所有页面都是 `docs/<path>.md`，目录在 `assets/nav.js`。

## 1. 页面骨架

```markdown
---
level: 进阶            # 基础 | 进阶 | 深入
tags: [InnoDB, B+树, 索引]
summary: 一句话说明本页解决什么问题（显示在标题下方）
---

# 页面标题（与 nav.js 中的 title 一致）

> [!ABSTRACT] 核心要点
> - 3～5 条结论式要点，读完这几条就能答出主干
> - …

## 一级小节
### 二级小节
…

## 生产实践与踩坑
…

## 面试追问

> [!QUESTION] 问题一句话？
> 回答要点，2～5 行，可以用列表。

> [!QUESTION] 问题二？
> …
```

- 只允许一个 `#` 标题；正文用 `##` / `###`（右侧大纲取 h2/h3）。
- front matter 必须是文件的第一行开始，三个 `-` 包围，字段只用 `level` / `tags` / `summary`。

## 2. 提示块（GitHub 风格 alert）

| 写法 | 用途 |
| --- | --- |
| `> [!ABSTRACT] 标题` | 页首核心要点 |
| `> [!NOTE]` | 补充说明、版本差异 |
| `> [!TIP]` | 最佳实践、经验 |
| `> [!WARNING]` | 坑、常见误区 |
| `> [!CAUTION]` | 会导致事故的危险操作 |
| `> [!QUESTION] 问题` | 面试追问（问题写在标记后面，回答写在下面几行） |

标记后面同一行的文字是提示块标题（可省略）。提示块内可以用列表、行内代码、加粗。

## 3. 代码

- 代码块必须标注语言：`java` `sql` `bash` `yaml` `xml` `json` `properties` `nginx` `dockerfile` `lua` `text`（纯文本 / ASCII 图）。
- 源码剖析时贴**精简后的关键源码**并加中文注释，注明 JDK / 组件版本，如 `// JDK 17 HashMap#putVal（节选）`。
- 站内链接写成 `[文字](#/mysql/index)`，路径见 `assets/nav.js`；外链写完整 https 地址。

## 4. SVG 图解（重点）

每个讲机制的页面应有 **1～3 张 SVG 图**，画的是真实机制（数据结构布局、时序流程、组件架构、状态机），不是装饰。图直接以内联 HTML 写在 Markdown 里：

```html
<figure class="fig">
<svg viewBox="0 0 720 240" class="dg" role="img" aria-label="一句话描述这张图">
<rect class="b1" x="20" y="40" width="140" height="48" rx="8"/>
<text class="tb" x="90" y="64" text-anchor="middle" dominant-baseline="middle">Client</text>
<line class="l" x1="160" y1="64" x2="260" y2="64" marker-end="url(#arr)"/>
<text class="ts" x="210" y="54" text-anchor="middle">请求</text>
<rect class="bg" x="260" y="20" width="440" height="200" rx="12"/>
<text class="ts" x="276" y="40">MySQL Server</text>
</svg>
<figcaption>图 1：一句话图注</figcaption>
</figure>
```

**硬性规则（违反会导致页面渲染错乱）：**

1. `<figure>` … `</figure>` 整块**内部不能有空行**，前后各留一个空行。
2. `<svg>` 只写 `viewBox` + `class="dg"` + `role` + `aria-label`，**不要写 width / height**（CSS 自适应）。宽度建议 640～760，高度按内容。
3. **不要写任何颜色**（不写 fill / stroke / style 颜色），只用下面的 class，这样明暗主题自动适配：

| 元素 | class | 效果 |
| --- | --- | --- |
| 矩形 / 圆 / 路径（形状） | `b` | 中性方块（背景色 + 边框） |
| | `b1` `b2` `b3` `b4` `b5` | 蓝 / 绿 / 琥珀 / 红 / 紫 的浅色底 + 同色描边，用于区分层次或类型 |
| | `bg` | 分组容器：虚线边框、极浅底色 |
| | `bf` | 实心强调色块（配合 `tw` 白字使用，少量用） |
| 文字 | `t` | 正文 13px |
| | `tb` | 粗体 13px（方块标题） |
| | `th` | 粗体 15px（图内大标题） |
| | `ts` | 小号灰色 11.5px（注释、标签） |
| | `ta` | 强调色文字 |
| | `tw` | 白色文字（仅用于 `bf` 上） |
| | `tm` | 等宽字体 12px（字段、地址、命令） |
| 线 | `l` | 普通连线 |
| | `ld` | 虚线 |
| | `la` | 强调色连线 |
| 箭头 | `marker-end="url(#arr)"` | 普通箭头（全站已定义，直接引用） |
| | `marker-end="url(#arr-a)"` | 强调色箭头（配合 `la`） |

4. 文字大小靠 class，不要写 `font-size`；居中用 `text-anchor="middle"` + `dominant-baseline="middle"`。
5. **自己算好坐标**：中文字宽 ≈ 13px/字，英文 ≈ 7.5px/字符；方块宽度要容纳文字并留 12px 以上内边距；元素之间不重叠，不出 viewBox。
6. 时序图：参与者方块在顶部，下面用 `ld` 竖线作生命线，消息用带箭头的 `l` 横线，上方 `ts` 标注，按 y 递增排列；可以在左侧用 `ts` 写序号 ①②③。
7. `figcaption` 用「图 n：…」格式，n 在页内递增。

## 5. 深度要求

每一页至少覆盖：

- **原理**：数据结构、关键流程、源码级关键字段/方法，标注版本差异（JDK 8 vs 17/21、MySQL 5.7 vs 8.0、Redis 6 vs 7 等）。
- **图解**：见第 4 节。
- **关键参数**：配置项 + 默认值 + 调优建议（表格）。
- **对比与取舍**：方案对比表（适用场景、优缺点、代价）。
- **生产实践与踩坑**：真实会遇到的问题、现象、排查方法、修复方式。
- **面试追问**：页尾 3～6 个 `[!QUESTION]`，偏资深面试深挖方向。

篇幅：每页正文约 3000～6000 中文字（含代码与表格），宁缺毋滥，不写空话套话。**准确性优先**：不确定的数字和版本不要编造，用「通常」「默认约」等措辞或省略。
