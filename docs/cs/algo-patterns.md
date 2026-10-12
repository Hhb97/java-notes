---
level: 进阶
tags: [算法, 双指针, 滑动窗口, 二分查找, 动态规划, 回溯, DFS, BFS, 图, 排序, 前缀和]
summary: 面试与工程中最常用的解题套路：如何把题目映射到套路、排序（快排/归并）与二分查找（含边界模板与答案二分）、双指针与滑动窗口、前缀和、递归/回溯、动态规划（状态定义与转移，背包/子序列/股票）、BFS/DFS 与拓扑排序、最短路径，每个套路带可运行的 Java 模板和易错点。
---

# 解题套路：双指针、二分、DP、回溯与图

> [!ABSTRACT] 核心要点
> - 算法题不是靠记题，而是**识别问题形态 → 套用模板 → 处理边界**。先用数据规模反推复杂度（见 [复杂度与核心数据结构](#/cs/algo-ds)），再选套路。
> - **有序/单调 → 二分**；**子数组/子串连续 → 双指针/滑动窗口/前缀和**；**求所有方案/排列组合 → 回溯**；**最优子结构 + 重叠子问题 → 动态规划**；**最短步数/层级 → BFS**；**依赖关系 → 拓扑排序**；**连通性 → DFS/并查集**。
> - 二分的灵魂是**循环不变量与区间定义**（左闭右开或左闭右闭，全程一致）；DP 的灵魂是**状态定义**；回溯的灵魂是**选择、约束、撤销**。
> - 写完要手工用**空输入、单元素、重复元素、极大值（溢出）**验证；整型溢出用 `long` 或 `mid = lo + (hi - lo) / 2`。

## 一、先看数据规模，反推复杂度

| n 的规模 | 可接受复杂度 | 常见做法 |
| --- | --- | --- |
| n ≤ 10~12 | O(n!) | 全排列、暴力回溯 |
| n ≤ 20~25 | O(2ⁿ) | 子集枚举、状压 DP |
| n ≤ 500 | O(n³) | Floyd、三重 DP |
| n ≤ 5000 | O(n²) | 二维 DP、双重循环 |
| n ≤ 10⁵~10⁶ | **O(n log n) / O(n)** | 排序、二分、堆、滑窗、哈希 |
| n ≥ 10⁷ | O(n) / O(log n) / O(1) | 一次扫描、数学、位运算 |

## 二、排序与二分查找

### 1. 常见排序对比

| 算法 | 平均 | 最坏 | 空间 | 稳定 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 快速排序 | O(n log n) | O(n²) | O(log n) | 否 | 最快的通用排序；基准随机/三数取中 |
| 归并排序 | O(n log n) | O(n log n) | O(n) | **是** | 外部排序、链表排序、Java 对象排序（TimSort） |
| 堆排序 | O(n log n) | O(n log n) | O(1) | 否 | 原地；缓存不友好 |
| 插入排序 | O(n²) | O(n²) | O(1) | 是 | 近乎有序/小数组最快（TimSort 的小块） |
| 计数/桶/基数排序 | O(n + k) | | O(k) | 是 | 值域小或可分桶时 |

Java：`Arrays.sort(int[])` 用**双轴快排**，`Arrays.sort(Object[])`/`Collections.sort` 用 **TimSort**（归并 + 插入，稳定）。**比较器要满足自反、对称、传递**，否则抛 `Comparison method violates its general contract!`；不要用 `a - b` 比较（溢出），用 `Integer.compare`。

```java
// 快速选择：第 K 大，平均 O(n)（只需把基准放到最终位置，不必全排序）
int findKthLargest(int[] a, int k) {
    int target = a.length - k, lo = 0, hi = a.length - 1;
    while (true) {
        int p = partition(a, lo, hi);                    // 返回基准最终下标
        if (p == target) return a[p];
        if (p < target) lo = p + 1; else hi = p - 1;
    }
}
int partition(int[] a, int lo, int hi) {
    int r = lo + (int) (Math.random() * (hi - lo + 1)); swap(a, r, hi);   // 随机基准，避免最坏
    int pivot = a[hi], i = lo;
    for (int j = lo; j < hi; j++) if (a[j] < pivot) swap(a, i++, j);
    swap(a, i, hi); return i;
}
void swap(int[] a, int i, int j) { int t = a[i]; a[i] = a[j]; a[j] = t; }
```

### 2. 二分查找：区间定义要始终一致

**适用条件：搜索空间有单调性**（不一定是排序数组，只要“条件在某点由假变真”）。

```java
// 模板 A：找第一个 >= target 的位置（左闭右开 [lo, hi)），最通用；返回 n 表示不存在
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;                     // 注意 hi = n
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;              // 防溢出
        if (a[mid] >= target) hi = mid;            // mid 可能是答案，保留
        else lo = mid + 1;                         // mid 一定不是答案，排除
    }
    return lo;
}
// 第一个 > target 为 upperBound（把 >= 换成 >）；元素出现次数 = upperBound - lowerBound
// 查找是否存在：i = lowerBound(a, t); i < n && a[i] == t
```

**答案二分（二分答案）**：答案范围单调、能“判定给定答案是否可行”时，二分答案 + 贪心/模拟验证，O(log(范围) × 判定)：

```java
// 例：把包裹在 days 天内运完，求最小运载能力（可行性随能力单调）
int shipWithinDays(int[] w, int days) {
    int lo = Arrays.stream(w).max().getAsInt(), hi = Arrays.stream(w).sum();   // 答案在 [最重包裹, 总重]
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (feasible(w, days, mid)) hi = mid; else lo = mid + 1;               // 可行则尝试更小
    }
    return lo;
}
boolean feasible(int[] w, int days, int cap) {
    int d = 1, cur = 0;
    for (int x : w) { if (cur + x > cap) { d++; cur = 0; } cur += x; }
    return d <= days;
}
```

易错：死循环（`mid` 取整方向与收缩方式不匹配）、边界 `hi = n` 还是 `n-1`、旋转数组/有重复元素的二分要先判断哪一半有序。

## 三、双指针、滑动窗口与前缀和

### 1. 双指针

| 类型 | 用法 | 例 |
| --- | --- | --- |
| **对撞指针** | 有序数组两端向中间 | 两数之和（有序）、三数之和（排序后固定一个再对撞）、盛水最多的容器、回文判断 |
| **快慢指针** | 速度不同 | 链表判环、找中点、删除倒数第 k 个、原地去重（慢指针写，快指针读） |
| **同向双指针** | 两个序列各自前进 | 合并有序数组、子序列判断 |

```java
// 原地删除有序数组重复项：慢指针标记“已处理区间末尾”，快指针探路
int removeDuplicates(int[] a) {
    int slow = 0;
    for (int fast = 1; fast < a.length; fast++)
        if (a[fast] != a[slow]) a[++slow] = a[fast];
    return a.length == 0 ? 0 : slow + 1;
}
```

### 2. 滑动窗口

维护窗口 `[left, right]`，**右指针扩张、满足条件时左指针收缩**，每个元素最多进出一次 → O(n)。

<figure class="fig">
<svg viewBox="0 0 800 250" class="dg" role="img" aria-label="滑动窗口：右指针不断右移把元素加入窗口并更新状态；当窗口不再满足约束时左指针右移收缩直到满足；每一步记录最优答案；左右指针都只增不减所以总复杂度线性">
<text class="th" x="20" y="24">例：最长无重复字符子串  s = "abcabcbb"</text>
<rect class="b" x="40" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="64" y="64" text-anchor="middle" dominant-baseline="middle">a</text>
<rect class="b2" x="92" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="116" y="64" text-anchor="middle" dominant-baseline="middle">b</text>
<rect class="b2" x="144" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="168" y="64" text-anchor="middle" dominant-baseline="middle">c</text>
<rect class="b2" x="196" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="220" y="64" text-anchor="middle" dominant-baseline="middle">a</text>
<rect class="b" x="248" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="272" y="64" text-anchor="middle" dominant-baseline="middle">b</text>
<rect class="b" x="300" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="324" y="64" text-anchor="middle" dominant-baseline="middle">c</text>
<rect class="b" x="352" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="376" y="64" text-anchor="middle" dominant-baseline="middle">b</text>
<rect class="b" x="404" y="44" width="48" height="40" rx="4"/>
<text class="ts" x="428" y="64" text-anchor="middle" dominant-baseline="middle">b</text>
<text class="ta" x="116" y="106" text-anchor="middle">left</text>
<text class="ta" x="220" y="106" text-anchor="middle">right</text>
<text class="ts" x="480" y="60" text-anchor="start">窗口 [1,3] = "bca" 无重复，长度 3</text>
<text class="ts" x="480" y="80" text-anchor="start">right 到下一个 'b' 时重复 → left 右移到 'b' 之后</text>
<rect class="bg" x="20" y="124" width="760" height="112" rx="10"/>
<text class="th" x="36" y="148">通用模板</text>
<text class="ts" x="36" y="170">for (right = 0; right &lt; n; right++) { 加入 a[right] 更新窗口状态;</text>
<text class="ts" x="36" y="190">    while (窗口不合法) { 移出 a[left]; left++; }     // 收缩</text>
<text class="ts" x="36" y="210">    更新答案（此时窗口合法）; }</text>
<text class="ts" x="36" y="228">适用：连续子串/子数组 + 单调约束（长度、和、种类数、无重复）；含负数的“和”不满足单调，要用前缀和+哈希</text>
</svg>
<figcaption>图 1：滑动窗口：右扩左缩，线性时间</figcaption>
</figure>

```java
int lengthOfLongestSubstring(String s) {
    int[] cnt = new int[128];                       // 窗口内各字符计数
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        char c = s.charAt(right);
        cnt[c]++;
        while (cnt[c] > 1) cnt[s.charAt(left++)]--;     // 出现重复，收缩直到无重复
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

### 3. 前缀和与差分

- **前缀和** `pre[i] = a[0..i-1]` 之和：区间和 `sum(l..r) = pre[r+1] - pre[l]` O(1)；
- **前缀和 + 哈希**：求和为 K 的子数组个数（允许负数）：`pre[j] - pre[i] = k` → 统计之前出现过多少个 `pre[j] - k`；
- **差分数组**：对区间 `[l, r]` 批量加值 O(1)，最后还原——适合大量区间更新（航班预订、扫描线）。

```java
int subarraySum(int[] nums, int k) {
    Map<Integer, Integer> cnt = new HashMap<>(); cnt.put(0, 1);   // 前缀和为 0 出现 1 次（空前缀）
    int pre = 0, res = 0;
    for (int x : nums) {
        pre += x;
        res += cnt.getOrDefault(pre - k, 0);        // 以当前位置结尾、和为 k 的子数组个数
        cnt.merge(pre, 1, Integer::sum);
    }
    return res;
}
```

## 四、递归与回溯

### 1. 递归三要素

**终止条件、本层做什么、子问题是什么**；注意**重复子问题**（加备忘录变记忆化搜索 → DP）与**栈深度**（Java 默认栈约一万多层，深递归改迭代或显式栈）。

### 2. 回溯：选择 → 递归 → 撤销

**回溯 = DFS 遍历“决策树”**，用于**枚举所有方案**：排列、组合、子集、N 皇后、数独、括号生成。

<figure class="fig">
<svg viewBox="0 0 800 270" class="dg" role="img" aria-label="回溯决策树：对数组 1 2 3 求子集，每层决定是否选择当前元素；到达叶子记录结果；回到上一层时撤销选择；剪枝可以提前终止不可能的分支">
<text class="th" x="20" y="24">求 [1,2,3] 的全部子集：每个元素“选 / 不选”</text>
<rect class="b3" x="340" y="40" width="80" height="34" rx="6"/>
<text class="ts" x="380" y="57" text-anchor="middle" dominant-baseline="middle">[]</text>
<rect class="b2" x="180" y="110" width="80" height="34" rx="6"/>
<text class="ts" x="220" y="127" text-anchor="middle" dominant-baseline="middle">选1 [1]</text>
<rect class="b" x="500" y="110" width="80" height="34" rx="6"/>
<text class="ts" x="540" y="127" text-anchor="middle" dominant-baseline="middle">不选 []</text>
<line class="l" x1="360" y1="74" x2="230" y2="110" marker-end="url(#arr)"/>
<line class="l" x1="400" y1="74" x2="530" y2="110" marker-end="url(#arr)"/>
<rect class="b2" x="100" y="180" width="80" height="34" rx="6"/>
<text class="ts" x="140" y="197" text-anchor="middle" dominant-baseline="middle">[1,2]</text>
<rect class="b" x="240" y="180" width="80" height="34" rx="6"/>
<text class="ts" x="280" y="197" text-anchor="middle" dominant-baseline="middle">[1]</text>
<line class="l" x1="205" y1="144" x2="150" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="235" y1="144" x2="275" y2="180" marker-end="url(#arr)"/>
<rect class="b2" x="420" y="180" width="80" height="34" rx="6"/>
<text class="ts" x="460" y="197" text-anchor="middle" dominant-baseline="middle">[2]</text>
<rect class="b" x="560" y="180" width="80" height="34" rx="6"/>
<text class="ts" x="600" y="197" text-anchor="middle" dominant-baseline="middle">[]</text>
<line class="l" x1="525" y1="144" x2="470" y2="180" marker-end="url(#arr)"/>
<line class="l" x1="555" y1="144" x2="595" y2="180" marker-end="url(#arr)"/>
<text class="ts" x="660" y="130" text-anchor="start">…继续第 3 个元素</text>
<text class="ts" x="20" y="244" text-anchor="start">叶子 = 一个完整方案（共 2³ = 8 个）；返回上一层时“撤销选择”（list.remove(last)），再走另一条分支</text>
<text class="ts" x="20" y="262" text-anchor="start">剪枝：不可能产生答案的分支提前返回（如和已超标、重复元素去重、已不可能凑够长度）</text>
</svg>
<figcaption>图 2：回溯：选择、递归、撤销，配合剪枝</figcaption>
</figure>

```java
// 回溯通用模板
void backtrack(路径 path, 选择列表) {
    if (满足结束条件) { res.add(new ArrayList<>(path)); return; }      // 注意：拷贝！
    for (选择 : 选择列表) {
        if (不合法) continue;                                          // 剪枝
        path.add(选择);                                                // 做选择
        backtrack(path, 新的选择列表);
        path.remove(path.size() - 1);                                  // 撤销选择
    }
}

// 全排列（元素互不相同）
List<List<Integer>> permute(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(nums, new boolean[nums.length], new ArrayList<>(), res);
    return res;
}
void dfs(int[] nums, boolean[] used, List<Integer> path, List<List<Integer>> res) {
    if (path.size() == nums.length) { res.add(new ArrayList<>(path)); return; }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;
        used[i] = true; path.add(nums[i]);
        dfs(nums, used, path, res);
        path.remove(path.size() - 1); used[i] = false;                 // 撤销
    }
}
```

**去重技巧**：数组含重复元素时，**先排序**，同一层遇到与前一个相同的元素就跳过（`i > start && nums[i] == nums[i-1]`）。组合问题用 `start` 下标避免 `[1,2]` 与 `[2,1]` 重复。

## 五、动态规划（DP）

### 1. 何时用 DP

满足：**最优子结构**（大问题的最优解由子问题最优解组成）+ **重叠子问题**（同样子问题被重复计算）。问“**最大/最小/方案数/是否可行**”常是 DP。

### 2. 解题四步

<figure class="fig">
<svg viewBox="0 0 800 220" class="dg" role="img" aria-label="动态规划四步法：一定义状态 dp 的含义；二写状态转移方程；三确定初始值和边界；四确定遍历顺序与答案位置，并可用滚动数组压缩空间">
<rect class="b1" x="20" y="40" width="170" height="90" rx="10"/>
<text class="tb" x="105" y="64" text-anchor="middle" dominant-baseline="middle">① 定义状态</text>
<text class="ts" x="105" y="88" text-anchor="middle">dp[i] / dp[i][j]</text>
<text class="ts" x="105" y="106" text-anchor="middle">“表示什么”最关键</text>
<rect class="b3" x="215" y="40" width="170" height="90" rx="10"/>
<text class="tb" x="300" y="64" text-anchor="middle" dominant-baseline="middle">② 状态转移</text>
<text class="ts" x="300" y="88" text-anchor="middle">由哪些更小状态得出</text>
<text class="ts" x="300" y="106" text-anchor="middle">选/不选、从哪来</text>
<rect class="b5" x="410" y="40" width="170" height="90" rx="10"/>
<text class="tb" x="495" y="64" text-anchor="middle" dominant-baseline="middle">③ 初始与边界</text>
<text class="ts" x="495" y="88" text-anchor="middle">dp[0]、空串、容量 0</text>
<text class="ts" x="495" y="106" text-anchor="middle">不可达用极值标记</text>
<rect class="b2" x="605" y="40" width="170" height="90" rx="10"/>
<text class="tb" x="690" y="64" text-anchor="middle" dominant-baseline="middle">④ 顺序与答案</text>
<text class="ts" x="690" y="88" text-anchor="middle">保证依赖已算好</text>
<text class="ts" x="690" y="106" text-anchor="middle">答案在哪个格子</text>
<line class="l" x1="190" y1="85" x2="215" y2="85" marker-end="url(#arr)"/>
<line class="l" x1="385" y1="85" x2="410" y2="85" marker-end="url(#arr)"/>
<line class="l" x1="580" y1="85" x2="605" y2="85" marker-end="url(#arr)"/>
<text class="ts" x="400" y="170" text-anchor="middle">自顶向下：递归 + 记忆化（好写、只算用到的）；自底向上：迭代填表（无递归开销，易做空间压缩）</text>
<text class="ts" x="400" y="194" text-anchor="middle">先写出暴力递归，找出重复子问题，再加缓存，最后改写成迭代——这是最稳的推导路径</text>
</svg>
<figcaption>图 3：动态规划四步法</figcaption>
</figure>

### 3. 经典模型与代码

**① 线性 DP：爬楼梯 / 打家劫舍**

```java
// 打家劫舍：dp[i] = 偷到第 i 间的最大收益 = max(不偷 i: dp[i-1], 偷 i: dp[i-2] + nums[i])
int rob(int[] nums) {
    int prev2 = 0, prev1 = 0;                       // 滚动变量压缩空间到 O(1)
    for (int x : nums) { int cur = Math.max(prev1, prev2 + x); prev2 = prev1; prev1 = cur; }
    return prev1;
}
```

**② 0-1 背包：每件物品选或不选**

```java
// dp[j] = 容量 j 时的最大价值；一维压缩时容量必须倒序遍历（保证每件物品只用一次）
int knapsack(int[] w, int[] v, int cap) {
    int[] dp = new int[cap + 1];
    for (int i = 0; i < w.length; i++)
        for (int j = cap; j >= w[i]; j--)                // 倒序！正序就变成完全背包（物品可重复）
            dp[j] = Math.max(dp[j], dp[j - w[i]] + v[i]);
    return dp[cap];
}
// 完全背包（每种无限件）：内层 j 正序。零钱兑换（最少硬币数）就是完全背包：dp[j] = min(dp[j], dp[j-coin]+1)
```

**③ 最长公共子序列 LCS / 编辑距离（二维 DP）**

```java
// dp[i][j] = text1 前 i 个字符与 text2 前 j 个字符的 LCS 长度
int lcs(String a, String b) {
    int m = a.length(), n = b.length();
    int[][] dp = new int[m + 1][n + 1];
    for (int i = 1; i <= m; i++)
        for (int j = 1; j <= n; j++)
            dp[i][j] = a.charAt(i - 1) == b.charAt(j - 1)
                    ? dp[i - 1][j - 1] + 1                           // 末尾相同：各去一个字符
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);          // 不同：丢弃其一取较优
    return dp[m][n];
}
// 编辑距离：相同 dp[i-1][j-1]；不同 1 + min(插入 dp[i][j-1], 删除 dp[i-1][j], 替换 dp[i-1][j-1])
```

**④ 最长递增子序列 LIS**：O(n²) DP，或**贪心 + 二分 O(n log n)**（`tails[k]` 维护长度为 k+1 的递增子序列的最小末尾，用 `lowerBound` 替换）。

**⑤ 股票买卖**：状态含“持有/不持有 + 交易次数/冷冻期”，`dp[i][0/1]`。

**⑥ 区间 DP、状压 DP、数位 DP、树形 DP**：进阶题型，状态含区间端点/集合掩码/树节点。

### 4. DP 常见坑

| 坑 | 对策 |
| --- | --- |
| 状态定义模糊，转移写不出 | 用一句话精确描述 `dp[i]` 含义（“以 i 结尾 / 前 i 个 / 恰好 / 至多”） |
| 初始值错误 | 求最小值时不可达初始化为“无穷大”（注意 `+1` 溢出，用 `Integer.MAX_VALUE/2`） |
| 遍历顺序错 | 0-1 背包倒序、完全背包正序；二维依赖决定顺序 |
| 方案数溢出 | 取模；用 `long` |
| 空间压缩后覆盖未用数据 | 明确依赖方向；必要时保存临时变量 |

## 六、图：DFS、BFS 与拓扑排序

### 1. 图的表示

```java
// 邻接表：稀疏图首选，空间 O(V+E)；邻接矩阵 O(V²) 适合稠密图/Floyd
List<List<Integer>> graph = new ArrayList<>();
for (int i = 0; i < n; i++) graph.add(new ArrayList<>());
for (int[] e : edges) { graph.get(e[0]).add(e[1]); /* 无向图再加反向 */ }
```

### 2. BFS：最短步数（无权图）与层序

```java
// 网格最短路径（0 可走，1 墙），四方向；BFS 第一次到达终点的步数就是最短
int shortestPath(int[][] g) {
    int m = g.length, n = g[0].length;
    if (g[0][0] == 1) return -1;
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};
    boolean[][] vis = new boolean[m][n];
    Deque<int[]> q = new ArrayDeque<>(); q.offer(new int[]{0, 0}); vis[0][0] = true;
    int steps = 0;
    while (!q.isEmpty()) {
        for (int sz = q.size(); sz > 0; sz--) {                // 一层一层扩散
            int[] cur = q.poll();
            if (cur[0] == m - 1 && cur[1] == n - 1) return steps;
            for (int[] d : dirs) {
                int x = cur[0] + d[0], y = cur[1] + d[1];
                if (x < 0 || y < 0 || x >= m || y >= n || g[x][y] == 1 || vis[x][y]) continue;
                vis[x][y] = true; q.offer(new int[]{x, y});    // 入队时就标记，避免重复入队
            }
        }
        steps++;
    }
    return -1;
}
```

### 3. DFS：连通性、路径、环检测

DFS = 递归/栈“一条路走到黑再回溯”，适合**连通块计数（岛屿数量）、路径枚举、环检测、拓扑、回溯类问题**；需要 `visited` 防止重复访问（图有环时必须）。

### 4. 拓扑排序：依赖关系

有向无环图（DAG）的线性序，使每条边 u→v 中 u 在 v 之前。**应用：任务依赖调度、课程安排、构建系统（Maven 模块顺序）、Flink/Airflow DAG**。**Kahn 算法（BFS）**：反复取入度为 0 的点，处理后更新后继入度；**若最终处理数 < 点数，说明有环（循环依赖）**。

```java
List<Integer> topo(int n, int[][] edges) {
    List<List<Integer>> g = new ArrayList<>(); int[] indeg = new int[n];
    for (int i = 0; i < n; i++) g.add(new ArrayList<>());
    for (int[] e : edges) { g.get(e[0]).add(e[1]); indeg[e[1]]++; }
    Deque<Integer> q = new ArrayDeque<>();
    for (int i = 0; i < n; i++) if (indeg[i] == 0) q.offer(i);
    List<Integer> order = new ArrayList<>();
    while (!q.isEmpty()) {
        int u = q.poll(); order.add(u);
        for (int v : g.get(u)) if (--indeg[v] == 0) q.offer(v);
    }
    return order.size() == n ? order : List.of();         // 空表示存在环
}
```

### 5. 最短路径

| 算法 | 适用 | 复杂度 | 说明 |
| --- | --- | --- | --- |
| BFS | 无权图 | O(V+E) | 边权相同 |
| **Dijkstra** | 非负权单源 | O((V+E) log V)（堆优化） | 贪心：每次确定距离最小的未定点；**不能有负权边** |
| Bellman-Ford | 含负权、可检测负环 | O(VE) | 松弛 V-1 轮 |
| Floyd | 多源、小图 | O(V³) | 三重循环 DP |
| A* | 带启发函数的单目标 | 依赖启发 | 地图导航 |

```java
// Dijkstra（堆优化）
int[] dijkstra(List<int[]>[] g, int src, int n) {       // g[u] 中元素 {v, w}
    int[] dist = new int[n]; Arrays.fill(dist, Integer.MAX_VALUE); dist[src] = 0;
    PriorityQueue<int[]> pq = new PriorityQueue<>(Comparator.comparingInt(a -> a[1]));   // {节点, 距离}
    pq.offer(new int[]{src, 0});
    while (!pq.isEmpty()) {
        int[] cur = pq.poll(); int u = cur[0];
        if (cur[1] > dist[u]) continue;                  // 过期条目（已有更短路径）
        for (int[] e : g[u]) {
            int v = e[0], nd = dist[u] + e[1];
            if (nd < dist[v]) { dist[v] = nd; pq.offer(new int[]{v, nd}); }
        }
    }
    return dist;
}
```

### 6. 其他

- **最小生成树**：Kruskal（排序边 + 并查集）、Prim（堆）；
- **并查集**：连通性动态合并（见 [数据结构](#/cs/algo-ds)）；
- **二分图判定**：染色（BFS/DFS）。

## 七、贪心

每步选当前最优，**需要证明局部最优能推出全局最优**（常用交换论证）。典型：区间调度（按右端点排序选不重叠最多）、合并区间、跳跃游戏、分发糖果、加油站、霍夫曼编码。不确定能否贪心时，用小数据暴力/DP 对拍验证。

## 八、解题流程与自查清单

1. **复述并确认**：输入范围、是否有负数/重复/空、要不要原地；
2. **用数据规模定复杂度目标**；
3. **先想暴力解**，再找冗余计算（哈希/前缀和/记忆化）、单调性（二分/双指针）；
4. **手工走一个小样例**（含边界）；
5. **写代码**：命名清晰，边界先写；
6. **自测**：空、单元素、全相同、有序/逆序、最大规模（溢出、超时、栈深）。

## 面试追问

> [!QUESTION] 二分查找怎么写才不出错？
> 先明确区间定义（如左闭右开），保持循环不变量：lo 左侧一定不是答案，hi 及右侧可能是答案。找第一个大于等于目标的位置时，满足条件就 hi 等于 mid，不满足就 lo 等于 mid 加一；中点用 lo 加 (hi 减 lo) 除以二防溢出，结束后检查边界和是否存在。二分不要求数组，只要求搜索空间单调，可用于二分答案。

> [!QUESTION] 滑动窗口适用于什么问题？为什么是 O(n)？
> 适用于连续子数组或子串且约束具有单调性的问题，如无重复最长子串、和不小于目标的最短子数组。右指针扩张、不满足时左指针收缩，两个指针都只前进不回退，每个元素最多进出一次，所以线性。含负数的求和问题不单调，要用前缀和加哈希。

> [!QUESTION] 动态规划怎么入手？0-1 背包为什么一维时倒序遍历？
> 先写暴力递归找重复子问题，再定义状态、写转移、定初值和遍历顺序。0-1 背包一维 dp 表示当前容量的最大价值，倒序遍历保证计算 dp[j] 时用到的 dp[j-w] 还是上一轮物品的结果，每件物品只用一次；正序则会在同一轮用到已更新的值，变成完全背包。

> [!QUESTION] 回溯和 DFS、DP 的区别和联系？
> 回溯是在决策树上做 DFS 并带撤销选择，用于枚举所有方案，复杂度往往指数级；当子问题重叠时可加记忆化变成自顶向下的 DP，把指数降为状态数乘转移数。只要求最优值或方案数而不需要列举方案时优先 DP。

> [!QUESTION] 如何检测依赖循环？拓扑排序怎么做？
> 用 Kahn 算法：统计入度，反复取入度为零的节点并更新后继入度，若处理节点数小于总数说明存在环；也可用 DFS 三色标记检测回边。应用于任务调度、构建顺序、DAG 工作流。

> [!QUESTION] Dijkstra 为什么不能处理负权边？
> 它基于贪心，每次确定距离最小的节点后认为其最短距离不会再被更新，这要求边权非负；有负权边时后续路径可能使已确定节点的距离更小，贪心假设被破坏，应使用 Bellman-Ford 或 SPFA，并可检测负环。

> [!QUESTION] 快速排序为什么不稳定？最坏情况怎么避免？
> 分区时元素跨越交换会改变相等元素的相对顺序。最坏情况出现在每次基准都选到极值，如有序数组选首元素，复杂度退化为 O(n²)，用随机基准或三数取中、小区间切换插入排序来避免。
