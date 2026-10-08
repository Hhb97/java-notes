// 目录结构：children 可无限嵌套；叶子节点用 path 对应 docs/<path>.md
window.NAV = [
  { title: '首页', path: 'index' },
  {
    title: '01 Java 基础',
    children: [
      { title: '语言概览与环境', path: 'basics/intro' },
      { title: '数据类型与变量', path: 'basics/types' },
      { title: '运算符与流程控制', path: 'basics/control' },
      { title: '数组与字符串', path: 'basics/string' }
    ]
  },
  {
    title: '02 面向对象',
    children: [
      { title: '类与对象', path: 'oop/class' },
      { title: '继承与多态', path: 'oop/inherit' },
      { title: '接口与抽象类', path: 'oop/interface' },
      { title: '枚举与记录类', path: 'oop/enum' }
    ]
  },
  {
    title: '03 核心 API',
    children: [
      {
        title: '集合框架',
        children: [
          { title: '集合总览', path: 'api/collections' },
          { title: 'HashMap 原理', path: 'api/hashmap' }
        ]
      },
      { title: '泛型', path: 'api/generics' },
      { title: '异常处理', path: 'api/exception' },
      { title: 'IO 与 NIO', path: 'api/io' }
    ]
  },
  {
    title: '04 并发编程',
    children: [
      { title: '线程基础', path: 'concurrency/thread' },
      { title: 'synchronized 与 volatile', path: 'concurrency/sync' },
      { title: '线程池', path: 'concurrency/pool' },
      { title: 'JUC 并发工具', path: 'concurrency/juc' }
    ]
  },
  {
    title: '05 JVM',
    children: [
      { title: '运行时内存结构', path: 'jvm/memory' },
      { title: '垃圾回收', path: 'jvm/gc' },
      { title: '类加载机制', path: 'jvm/classloader' },
      { title: '调优与问题排查', path: 'jvm/tuning' }
    ]
  },
  {
    title: '06 现代 Java',
    children: [
      { title: 'Lambda 与 Stream', path: 'modern/lambda' },
      { title: 'Java 9–21 新特性', path: 'modern/features' }
    ]
  },
  {
    title: '07 工程与框架',
    children: [
      { title: 'Maven 构建', path: 'eng/maven' },
      { title: 'Spring IoC 与 AOP', path: 'eng/spring' },
      { title: 'Spring Boot 入门', path: 'eng/springboot' }
    ]
  },
  {
    title: '08 设计模式',
    children: [
      { title: '创建型模式', path: 'patterns/creational' },
      { title: '结构型与行为型', path: 'patterns/behavioral' }
    ]
  },
  {
    title: '09 附录',
    children: [
      { title: '面试高频速查', path: 'appendix/interview' }
    ]
  }
];
