# Java 学习笔记

基于纯 HTML + Markdown 的 Java 知识库站点：左侧多级目录、右侧页内大纲、全文搜索、明暗主题、代码高亮与一键复制。无需构建，直接部署到 GitHub Pages。

## 内容

基础 · 面向对象 · 核心 API · 并发编程 · JVM · 现代 Java · 工程与框架 · 设计模式 · 面试速查

## 本地预览

页面通过 `fetch` 加载 Markdown，需要一个本地静态服务器（直接双击打开 `index.html` 会被浏览器拦截）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000
```

## 新增笔记

1. 在 `docs/` 下新建 `xxx/yyy.md`；
2. 在 `assets/nav.js` 的目录树中添加 `{ title: '标题', path: 'xxx/yyy' }`；
3. 提交并推送，Pages 自动更新。
