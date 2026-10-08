# Java 学习笔记

一份按层级组织的 Java 工程知识库：从语法基础到并发、JVM，再到 Spring 工程实践。左侧是目录，右侧是本页大纲，顶部可全文搜索（按 `/` 快速聚焦）。

> 笔记基于 **JDK 17 / 21（LTS）**，涉及版本差异时会特别标注。

## 学习路线

<div class="cards">
<a class="card" href="#/basics/intro"><b>01 Java 基础</b><span>环境、类型、流程控制、字符串</span></a>
<a class="card" href="#/oop/class"><b>02 面向对象</b><span>类、继承多态、接口、枚举与记录</span></a>
<a class="card" href="#/api/collections"><b>03 核心 API</b><span>集合、泛型、异常、IO</span></a>
<a class="card" href="#/concurrency/thread"><b>04 并发编程</b><span>线程、锁、线程池、JUC</span></a>
<a class="card" href="#/jvm/memory"><b>05 JVM</b><span>内存、GC、类加载、调优</span></a>
<a class="card" href="#/modern/lambda"><b>06 现代 Java</b><span>Lambda、Stream、新特性</span></a>
<a class="card" href="#/eng/maven"><b>07 工程与框架</b><span>Maven、Spring、Spring Boot</span></a>
<a class="card" href="#/patterns/creational"><b>08 设计模式</b><span>创建型、结构型、行为型</span></a>
</div>

## 怎么读

1. **初学者**：按 01 → 02 → 03 顺序读，每章末尾的代码都动手敲一遍。
2. **有基础**：直接跳到 04 并发与 05 JVM，这两块是进阶与面试的分水岭。
3. **查漏补缺**：用顶部搜索，或在 [面试高频速查](#/appendix/interview) 里扫一遍。

## 约定

- 代码块右上角悬停可 **复制**。
- 「注意」「坑」类内容用引用块标出。
- 页面之间用底部的上一篇 / 下一篇串联。
