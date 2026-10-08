# 运算符与流程控制

## 运算符速查

| 类别 | 运算符 | 备注 |
| --- | --- | --- |
| 算术 | `+ - * / % ++ --` | 整数除法向零取整 |
| 比较 | `== != < > <= >=` | 引用类型 `==` 比较地址 |
| 逻辑 | `&& \|\| !` | `&&` `\|\|` 短路 |
| 位运算 | `& \| ^ ~ << >> >>>` | `>>>` 无符号右移 |
| 三元 | `cond ? a : b` | 注意两侧类型提升 |
| 类型判断 | `instanceof` | 17+ 支持模式匹配 |

```java
int x = 7;
System.out.println(x / 2);   // 3
System.out.println(x % 2);   // 1
System.out.println(-7 % 3);  // -1，符号跟被除数
System.out.println(x >> 1);  // 3
```

## 分支

```java
if (score >= 90) {
    grade = "A";
} else if (score >= 60) {
    grade = "B";
} else {
    grade = "C";
}
```

### switch 表达式（14+ 正式）

```java
String name = switch (day) {
    case MONDAY, TUESDAY -> "工作日前半";
    case SATURDAY, SUNDAY -> "周末";
    default -> {
        String s = "其他";
        yield s;           // 代码块里用 yield 返回值
    }
};
```

新语法没有 fall-through，不需要写 `break`，且作为表达式时要求穷尽所有分支。

## 循环

```java
for (int i = 0; i < 5; i++) { }          // 普通 for
for (String s : list) { }                // 增强 for，遍历数组 / Iterable
while (cond) { }
do { } while (cond);                     // 至少执行一次

outer:
for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
        if (j == 2) continue outer;      // 带标签的 continue / break
        if (i == 2) break outer;
    }
}
```

> **坑：** 增强 for 遍历集合时不要增删元素，否则抛 `ConcurrentModificationException`；需要删除请用 `Iterator.remove()` 或 `list.removeIf(...)`。

## 方法

```java
static int sum(int... nums) {   // 可变参数，本质是数组
    int s = 0;
    for (int n : nums) s += n;
    return s;
}
```

- Java 只有**值传递**：传基本类型是值的拷贝，传对象是**引用的拷贝**，所以方法内能改对象内容，但不能让调用方的变量指向别的对象。
- 方法**重载**看参数列表（个数、类型、顺序），与返回值无关。
