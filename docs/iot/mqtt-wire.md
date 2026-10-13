---
level: 深入
tags: [MQTT, 报文格式, 固定报头, 剩余长度, CONNECT, PUBLISH, SUBSCRIBE, Packet Identifier, 十六进制解码, 协议实现, 抓包]
summary: MQTT 协议的字节级详解：固定报头的类型与标志位、剩余长度的变长编码与解码算法、14 种控制报文的方向与标志、CONNECT/CONNACK/PUBLISH/SUBSCRIBE 的可变报头与载荷逐字段结构、UTF-8 字符串与主题规则、Packet Identifier 的分配与复用、保活与报文校验的实现要点，以及用十六进制抓包还原一次完整交互。
---

# MQTT 报文详解：从字节看协议

> [!ABSTRACT] 核心要点
> - 理解 MQTT 的“底层”，就是读懂**每个报文的字节**：**固定报头（1 字节类型+标志，1~4 字节剩余长度）→ 可变报头（因报文类型而异）→ 载荷（可选）**。整个协议设计得极其精简，最小的报文只有 **2 字节**（PINGREQ=`C0 00`），这正是它适合窄带、低功耗设备的原因。
> - **剩余长度（Remaining Length）是变长整数**：每字节低 7 位存数据、最高位表示“后面还有字节”，**最多 4 字节，最大 268,435,455（约 256MB）**。实现解码器时这是最容易出错的地方（粘包、半包、超长攻击）。
> - **标志位不是随意的**：`PUBLISH` 的低 4 位是 `DUP / QoS(2位) / RETAIN`；`PUBREL`、`SUBSCRIBE`、`UNSUBSCRIBE` 的低 4 位**必须是 `0010`**，其余报文必须为 `0000`，违反即**协议错误、必须断开连接**。
> - **Packet Identifier（报文标识符）** 是 16 位非零整数，用于**把 QoS1/2 的应答与请求配对**，在**同一方向、同一时刻处于“未完成”状态的报文之间必须唯一**，完成后可复用；它的管理（分配、占用、释放）直接决定**飞行窗口（in-flight window）**与重传行为。
> - 字符串都是**带 2 字节长度前缀的 UTF-8**（主题、客户端 ID、用户名等），长度上限 65535 字节；**主题名不得含通配符**，**主题过滤器**才可含 `+` 与 `#`，且 `$` 开头的系统主题不被首级通配符匹配。
> - 本页以 **3.1.1** 为主线（最通用），并标注 **5.0** 的差异；5.0 增强见 [MQTT 5.0 深入](#/iot/mqtt-v5)。

## 控制报文总览

### 报文类型与标志位

固定报头第 1 字节：**高 4 位 = 报文类型，低 4 位 = 标志位**。

| 值 | 名称 | 方向 | 标志位（低 4 位） | 有 Packet ID | 载荷 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **CONNECT** | C→S | `0000` | 否 | 必有 | 建立连接，携带客户端 ID、保活、遗嘱、认证 |
| 2 | **CONNACK** | S→C | `0000` | 否 | 无 | 连接应答，含 Session Present 与返回码 |
| 3 | **PUBLISH** | 双向 | `DUP QoS QoS RETAIN` | QoS>0 时有 | 可选 | 发布消息 |
| 4 | **PUBACK** | 双向 | `0000` | 是 | 无 | QoS1 应答 |
| 5 | **PUBREC** | 双向 | `0000` | 是 | 无 | QoS2 第一步应答（已收到） |
| 6 | **PUBREL** | 双向 | **`0010`** | 是 | 无 | QoS2 第二步（释放） |
| 7 | **PUBCOMP** | 双向 | `0000` | 是 | 无 | QoS2 第三步（完成） |
| 8 | **SUBSCRIBE** | C→S | **`0010`** | 是 | 必有 | 订阅（一个或多个主题过滤器+QoS） |
| 9 | **SUBACK** | S→C | `0000` | 是 | 必有 | 订阅应答，每个过滤器一个返回码 |
| 10 | **UNSUBSCRIBE** | C→S | **`0010`** | 是 | 必有 | 取消订阅 |
| 11 | **UNSUBACK** | S→C | `0000` | 是 | 无 | 取消订阅应答 |
| 12 | **PINGREQ** | C→S | `0000` | 否 | 无 | 心跳请求 |
| 13 | **PINGRESP** | S→C | `0000` | 否 | 无 | 心跳应答 |
| 14 | **DISCONNECT** | C→S（5.0 双向） | `0000` | 否 | 无 | 正常断开 |
| 15 | **AUTH**（仅 5.0） | 双向 | `0000` | 否 | 无 | 增强认证（3.1.1 中该值保留） |

> [!WARNING] 保留值与非法标志位
> 值 0 保留；固定标志位错误（例如 `SUBSCRIBE` 写成 `0000`）按规范**接收方必须关闭网络连接**。自研网关/解码器应严格校验，既是兼容性要求，也是**安全加固**（拒绝畸形报文）。

### 通用结构

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="MQTT 报文通用结构：固定报头第一个字节高四位为报文类型、低四位为标志位；随后是一到四个字节的剩余长度；然后是因报文类型而异的可变报头；最后是可选的载荷；剩余长度等于可变报头加载荷的字节数；PINGREQ 只有固定报头共两个字节">
<rect class="b3" x="20" y="30" width="300" height="70" rx="8"/>
<text class="tb" x="170" y="48" text-anchor="middle" dominant-baseline="middle">固定报头（2~5 字节）</text>
<rect class="b5" x="34" y="58" width="130" height="30" rx="6"/>
<text class="ts" x="99" y="73" text-anchor="middle" dominant-baseline="middle">字节1：类型|标志</text>
<rect class="b5" x="176" y="58" width="130" height="30" rx="6"/>
<text class="ts" x="241" y="73" text-anchor="middle" dominant-baseline="middle">剩余长度（1~4）</text>
<rect class="b1" x="330" y="30" width="200" height="70" rx="8"/>
<text class="tb" x="430" y="52" text-anchor="middle" dominant-baseline="middle">可变报头</text>
<text class="ts" x="430" y="76" text-anchor="middle">随报文类型而异（可无）</text>
<rect class="b2" x="540" y="30" width="200" height="70" rx="8"/>
<text class="tb" x="640" y="52" text-anchor="middle" dominant-baseline="middle">载荷（Payload）</text>
<text class="ts" x="640" y="76" text-anchor="middle">可选，PUBLISH 的消息体</text>
<line class="l" x1="320" y1="65" x2="330" y2="65" marker-end="url(#arr)"/>
<line class="l" x1="530" y1="65" x2="540" y2="65" marker-end="url(#arr)"/>
<text class="ta" x="430" y="122" text-anchor="middle">剩余长度 = 可变报头字节数 + 载荷字节数（不含固定报头自身）</text>
<rect class="bg" x="20" y="140" width="720" height="82" rx="8"/>
<text class="th" x="32" y="160">固定报头第 1 字节（位布局）</text>
<text class="ts" x="380" y="186" text-anchor="middle">bit7 bit6 bit5 bit4 │ bit3 bit2 bit1 bit0</text>
<text class="ts" x="380" y="208" text-anchor="middle">　　报文类型（1~15）　│　标志位（PUBLISH：DUP · QoS高位 · QoS低位 · RETAIN）</text>
<rect class="bg" x="20" y="238" width="720" height="80" rx="8"/>
<text class="th" x="32" y="258">最小与最大</text>
<text class="ts" x="380" y="282" text-anchor="middle">最小报文：PINGREQ = C0 00，PINGRESP = D0 00，DISCONNECT = E0 00，仅 2 字节</text>
<text class="ts" x="380" y="304" text-anchor="middle">最大报文：剩余长度 268,435,455 字节 + 固定报头约 256MB；实践中 Broker 会限制最大报文（如 1MB），超限直接断开</text>
</svg>
<figcaption>图 1：MQTT 报文的通用结构</figcaption>
</figure>

## 剩余长度：变长整数

### 编码规则

| 字节数 | 可表示范围 |
| --- | --- |
| 1 | 0 ~ 127 |
| 2 | 128 ~ 16,383 |
| 3 | 16,384 ~ 2,097,151 |
| 4 | 2,097,152 ~ 268,435,455 |

每个字节：**低 7 位**存数据（低位在前），**最高位（0x80）=1 表示后面还有一个长度字节**。例：长度 321 → `321 % 128 = 65`，`65 | 0x80 = 0xC1`；`321 / 128 = 2` → `0x02`，所以编码为 **`C1 02`**。

```java
// 编码：把长度写入变长字节
static int encodeRemainingLength(int x, byte[] out, int off) {
    int n = 0;
    do {
        int digit = x % 128;
        x /= 128;
        if (x > 0) digit |= 0x80;         // 还有后续字节
        out[off + n++] = (byte) digit;
    } while (x > 0);
    return n;                              // 占用的字节数
}

// 解码：返回长度与占用字节数；注意半包与超长保护
static long[] decodeRemainingLength(ByteBuf in) {
    int multiplier = 1; long value = 0; int bytes = 0;
    while (true) {
        if (!in.isReadable()) return null;  // 数据不够（半包），等待更多字节，不能当作错误
        int digit = in.readUnsignedByte();
        bytes++;
        value += (long) (digit & 0x7F) * multiplier;
        if ((digit & 0x80) == 0) break;     // 最后一个长度字节
        multiplier *= 128;
        if (bytes == 4) throw new CorruptedFrameException("remaining length too long"); // 超过 4 字节：畸形报文
    }
    return new long[]{value, bytes};
}
```

要点：

- **半包**：读到一半字节不够时必须**回退读指针并等待**（Netty 里用 `ReplayingDecoder` 或 `markReaderIndex/resetReaderIndex`），见 [Netty 实战：编解码、内存与调优](#/infra/netty-practice)；
- **第 4 个字节还有延续位**就是非法，**必须断开**（防止恶意构造超长长度）；
- **按剩余长度读取整个报文体之前先检查最大报文限制**，避免被诱导分配巨大缓冲（拒绝服务）；
- 长度较大的 PUBLISH 才会用到 3~4 字节长度，**绝大多数物联网报文是 1~2 字节长度**。

## CONNECT 与 CONNACK

### CONNECT 的结构

<figure class="fig">
<svg viewBox="0 0 760 360" class="dg" role="img" aria-label="CONNECT 报文逐字节分解：固定报头 10 0E；可变报头包含协议名长度 00 04、协议名 MQTT 的 4D 51 54 54、协议级别 04、连接标志 02、保活 00 3C；载荷包含客户端标识符长度 00 02 与内容 63 31；连接标志各位含义：用户名、密码、遗嘱保留、遗嘱 QoS、遗嘱标志、清理会话、保留位">
<text class="th" x="20" y="22">示例：CONNECT（clientId=c1，Clean Session，Keep Alive=60 秒，无遗嘱、无用户名）</text>
<rect class="b3" x="20" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="42" y="52" text-anchor="middle" dominant-baseline="middle">10</text>
<rect class="b3" x="68" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="90" y="52" text-anchor="middle" dominant-baseline="middle">0E</text>
<rect class="b5" x="124" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="146" y="52" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b5" x="172" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="194" y="52" text-anchor="middle" dominant-baseline="middle">04</text>
<rect class="b5" x="220" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="242" y="52" text-anchor="middle" dominant-baseline="middle">4D</text>
<rect class="b5" x="268" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="290" y="52" text-anchor="middle" dominant-baseline="middle">51</text>
<rect class="b5" x="316" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="338" y="52" text-anchor="middle" dominant-baseline="middle">54</text>
<rect class="b5" x="364" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="386" y="52" text-anchor="middle" dominant-baseline="middle">54</text>
<rect class="b1" x="420" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="442" y="52" text-anchor="middle" dominant-baseline="middle">04</text>
<rect class="b1" x="468" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="490" y="52" text-anchor="middle" dominant-baseline="middle">02</text>
<rect class="b1" x="516" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="538" y="52" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b1" x="564" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="586" y="52" text-anchor="middle" dominant-baseline="middle">3C</text>
<rect class="b2" x="620" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="642" y="52" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b2" x="668" y="34" width="44" height="36" rx="4"/>
<text class="ts" x="690" y="52" text-anchor="middle" dominant-baseline="middle">02</text>
<rect class="b2" x="20" y="82" width="44" height="36" rx="4"/>
<text class="ts" x="42" y="100" text-anchor="middle" dominant-baseline="middle">63</text>
<rect class="b2" x="68" y="82" width="44" height="36" rx="4"/>
<text class="ts" x="90" y="100" text-anchor="middle" dominant-baseline="middle">31</text>
<text class="ts" x="260" y="92" text-anchor="start">← 载荷：客户端 ID “c1” 的 UTF-8 字节</text>
<text class="ta" x="20" y="128">10＝CONNECT；0E＝剩余长度 14 │ 00 04 "MQTT"＝协议名 │ 04＝协议级别(3.1.1)</text>
<text class="ta" x="20" y="146">02＝连接标志 │ 00 3C＝保活 60 秒 │ 00 02 "c1"＝客户端 ID</text>
<rect class="bg" x="20" y="158" width="350" height="190" rx="8"/>
<text class="th" x="32" y="178">连接标志（1 字节）各位</text>
<text class="ts" x="195" y="204" text-anchor="middle">bit7 用户名标志　　bit6 密码标志</text>
<text class="ts" x="195" y="226" text-anchor="middle">bit5 遗嘱保留　　　bit4-3 遗嘱 QoS</text>
<text class="ts" x="195" y="248" text-anchor="middle">bit2 遗嘱标志　　　bit1 清理会话</text>
<text class="ts" x="195" y="270" text-anchor="middle">bit0 保留（必须为 0）</text>
<text class="ts" x="195" y="298" text-anchor="middle">0x02 = 仅清理会话；0xC2 = 带用户名密码</text>
<text class="ts" x="195" y="320" text-anchor="middle">遗嘱标志为 0 时，遗嘱 QoS/保留必须为 0</text>
<rect class="bg" x="390" y="158" width="350" height="190" rx="8"/>
<text class="th" x="402" y="178">载荷字段顺序（出现与否由标志决定）</text>
<text class="ts" x="565" y="204" text-anchor="middle">① 客户端标识符（必有，可为空串）</text>
<text class="ts" x="565" y="226" text-anchor="middle">② 遗嘱主题 ③ 遗嘱消息（遗嘱标志=1）</text>
<text class="ts" x="565" y="248" text-anchor="middle">④ 用户名（用户名标志=1）</text>
<text class="ts" x="565" y="270" text-anchor="middle">⑤ 密码（密码标志=1）</text>
<text class="ts" x="565" y="298" text-anchor="middle">字符串均为：2 字节长度 + UTF-8；</text>
<text class="ts" x="565" y="320" text-anchor="middle">遗嘱消息与密码是二进制：长度+原始字节</text>
</svg>
<figcaption>图 2：CONNECT 报文的字节级分解</figcaption>
</figure>

要点：

- **协议名与级别**：`MQTT` + 级别 `04`（3.1.1）/`05`（5.0）/`03`（3.1，协议名为 `MQIsdp`）；服务器遇到不支持的级别应回 CONNACK 返回码 1 并断开；
- **保活（Keep Alive）**：秒，0 表示关闭保活；服务器在 **1.5 倍保活时间**内未收到任何报文，视为客户端失联并断开（并发布遗嘱），见 [会话、遗嘱与保活的实现语义](#/iot/mqtt-qos-session)；
- **客户端 ID**：3.1.1 要求服务器至少接受 1~23 字节的字母数字，实际多数 Broker 放宽；**允许零长度 ID**但必须 `Clean Session=1`，由服务器分配临时 ID；
- **CONNECT 必须是连接上的第一个报文**，且只能出现一次（再次出现为协议错误）；连接后若迟迟不发 CONNECT，Broker 应超时断开（防止空连接占资源）；
- **一个有趣的细节**：用户名/密码**在载荷中**，是**明文传输**，所以**必须配合 TLS**（见 [弱网、可靠性、安全与排障](#/iot/mqtt-practice)）。

### CONNACK

结构：`20 02 [连接确认标志] [返回码]`，**固定 4 字节**。

| 返回码（3.1.1） | 含义 | 常见触发 |
| --- | --- | --- |
| 0 | 连接已接受 | — |
| 1 | 不支持的协议版本 | 老 Broker 不认 5.0 |
| 2 | 客户端标识符不合格 | ID 过长/含非法字符/为空且 Clean Session=0 |
| 3 | 服务端不可用 | 过载、维护 |
| 4 | 用户名或密码错误 | 认证失败 |
| 5 | 未授权 | ACL/黑名单 |

- **Session Present（连接确认标志 bit0）**：`Clean Session=0` 时，**服务器是否保留了该客户端的旧会话**。客户端据此判断**是否需要重新订阅**：若 Session Present=0 但客户端以为有会话，必须重新订阅（常见的“重连后收不到消息”根因）；
- 5.0 把返回码扩展为**原因码（Reason Code）**并增加属性，见 [MQTT 5.0 深入](#/iot/mqtt-v5)；
- 若认证失败，Broker 可以**直接断开而不回 CONNACK**（部分实现为避免暴露信息）；客户端要处理“无 CONNACK 即断开”。

## PUBLISH 与应答

### PUBLISH 报文

固定报头低 4 位：

| 位 | 名称 | 含义 |
| --- | --- | --- |
| bit3 | **DUP** | 重发标志：**此报文是之前发送过的重发**（QoS0 必须为 0）；**接收端不能据此去重**，它只是提示 |
| bit2-1 | **QoS** | 0/1/2；`11` 非法 |
| bit0 | **RETAIN** | 发送给服务器时：要求保留；服务器转发给订阅者时的取值规则见 [会话与保留消息语义](#/iot/mqtt-qos-session) |

可变报头：**主题名（2 字节长度+UTF-8）** + **Packet Identifier（仅 QoS>0，2 字节）**；载荷：任意二进制，**长度 = 剩余长度 − 可变报头长度**（载荷没有自己的长度字段，也可以为 0）。

<figure class="fig">
<svg viewBox="0 0 760 330" class="dg" role="img" aria-label="PUBLISH QoS1 与 PUBACK 的字节级示例：发布者发送 32 09 00 03 61 2F 62 00 0A 68 69，其中 32 表示类型 3 QoS 1，剩余长度 9，主题 a/b，报文标识符 10，载荷 hi；Broker 回复 40 02 00 0A；Packet Identifier 的生命周期从分配、飞行中、收到应答到释放">
<text class="th" x="20" y="22">示例：PUBLISH（QoS1，主题 a/b，Packet ID=10，载荷 "hi"）与 PUBACK</text>
<rect class="b3" x="20" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="42" y="51" text-anchor="middle" dominant-baseline="middle">32</text>
<rect class="b3" x="68" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="90" y="51" text-anchor="middle" dominant-baseline="middle">09</text>
<rect class="b5" x="124" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="146" y="51" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b5" x="172" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="194" y="51" text-anchor="middle" dominant-baseline="middle">03</text>
<rect class="b5" x="220" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="242" y="51" text-anchor="middle" dominant-baseline="middle">61</text>
<rect class="b5" x="268" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="290" y="51" text-anchor="middle" dominant-baseline="middle">2F</text>
<rect class="b5" x="316" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="338" y="51" text-anchor="middle" dominant-baseline="middle">62</text>
<rect class="b1" x="372" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="394" y="51" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b1" x="420" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="442" y="51" text-anchor="middle" dominant-baseline="middle">0A</text>
<rect class="b2" x="476" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="498" y="51" text-anchor="middle" dominant-baseline="middle">68</text>
<rect class="b2" x="524" y="34" width="44" height="34" rx="4"/>
<text class="ts" x="546" y="51" text-anchor="middle" dominant-baseline="middle">69</text>
<text class="ta" x="20" y="92">32＝PUBLISH，QoS1（0011 0010）│ 09＝剩余长度 │ 00 03 "a/b"＝主题 │ 00 0A＝Packet ID 10 │ 68 69＝载荷 "hi"</text>
<rect class="b4" x="20" y="108" width="44" height="34" rx="4"/>
<text class="ts" x="42" y="125" text-anchor="middle" dominant-baseline="middle">40</text>
<rect class="b4" x="68" y="108" width="44" height="34" rx="4"/>
<text class="ts" x="90" y="125" text-anchor="middle" dominant-baseline="middle">02</text>
<rect class="b4" x="124" y="108" width="44" height="34" rx="4"/>
<text class="ts" x="146" y="125" text-anchor="middle" dominant-baseline="middle">00</text>
<rect class="b4" x="172" y="108" width="44" height="34" rx="4"/>
<text class="ts" x="194" y="125" text-anchor="middle" dominant-baseline="middle">0A</text>
<text class="ts" x="240" y="130" text-anchor="start">← PUBACK：40＝类型 4，02＝剩余长度，Packet ID=10（4 字节）</text>
<rect class="bg" x="20" y="158" width="720" height="162" rx="8"/>
<text class="th" x="32" y="178">Packet Identifier 的生命周期</text>
<text class="ts" x="380" y="204" text-anchor="middle">分配：发送方为新的 QoS1/2 PUBLISH 选一个当前未被占用的 1~65535 的值（0 非法）</text>
<text class="ts" x="380" y="226" text-anchor="middle">占用：从发送到收到最终应答（QoS1=PUBACK；QoS2=PUBCOMP）期间，该 ID 不能用于其他报文（同一方向）</text>
<text class="ts" x="380" y="248" text-anchor="middle">释放：收到最终应答后可复用；重发时必须使用原 ID（DUP=1），不能换 ID，否则对端无法去重配对</text>
<text class="ts" x="380" y="270" text-anchor="middle">方向独立：客户端→服务器与服务器→客户端各有自己的 ID 空间，互不影响</text>
<text class="ts" x="380" y="292" text-anchor="middle">同样的 ID 空间也被 SUBSCRIBE/UNSUBSCRIBE 使用：它们与 PUBLISH 共用客户端侧的“占用”集合</text>
<text class="ta" x="380" y="312" text-anchor="middle">实现提示：用位图/环形计数器分配；占用数上限即飞行窗口，见 QoS 与会话页</text>
</svg>
<figcaption>图 3：PUBLISH(QoS1) 与 PUBACK 的字节分解与 Packet ID 生命周期</figcaption>
</figure>

### QoS 2 的 4 个报文

`PUBLISH(QoS2)` → `PUBREC` → `PUBREL` → `PUBCOMP`，**后三个报文固定 4 字节**（`50 02 id`、`62 02 id`、`70 02 id`，注意 `PUBREL` 固定报头是 **`62`** 即 `0110 0010` 含必须的 `0010` 标志）。握手的**状态机与存储要求**见 [QoS、会话与 Broker 语义](#/iot/mqtt-qos-session)。

## SUBSCRIBE / SUBACK / UNSUBSCRIBE

**SUBSCRIBE**：固定报头 `82`（`1000 0010`）+ 剩余长度 + **Packet Identifier** + 一个或多个 **[主题过滤器（长度+UTF-8）+ 请求 QoS（1 字节）]**。

```text
82 0C 00 15 00 07 73 65 6E 73 6F 72 2F 01
│  │  └─┬─┘ └─┬─┘ └──── "sensor/" ────┘ └ 请求 QoS=1
│  │    │     └ 主题过滤器长度 7，内容 "sensor/"（示意）
│  │    └ Packet ID = 21
│  └ 剩余长度
└ SUBSCRIBE 固定标志 0010
```

**SUBACK**：`90` + 剩余长度 + Packet ID + **每个过滤器一个返回码**：`0x00/0x01/0x02` = **授予的最大 QoS**（可能低于请求）；`0x80` = 失败（如无权限、过滤器非法）。注意：

- **订阅可部分失败**：多过滤器订阅里某个失败不影响其他，客户端必须**逐个检查返回码**；
- **授予的 QoS 可能被降级**：Broker 配置上限或 ACL 限制导致；客户端不能假设拿到的就是请求的 QoS；
- **订阅生效的时刻**：SUBACK 之前，Broker 可能已开始投递匹配的消息（规范允许），所以客户端回调要**在发送 SUBSCRIBE 前就准备好**；
- **UNSUBSCRIBE**：`A2` + Packet ID + 过滤器列表，`UNSUBACK`（`B0 02 id`）确认；**取消订阅后，已在途的消息仍可能到达**。

### 主题名与主题过滤器的规则

| 规则 | 说明 |
| --- | --- |
| **UTF-8 且无空字符** | 不得包含 U+0000；长度 1~65535 字节 |
| **PUBLISH 的主题名不得含通配符** | 含 `+`/`#` 的 PUBLISH 是协议错误 |
| **层级分隔符 `/`** | 主题以 `/` 分层；开头或结尾的 `/` 会产生**空层级**（`/a` 与 `a` 是不同主题） |
| **`+`** | 恰好匹配**一层**，必须占满整层（`a/+/c` 合法，`a/b+` 非法） |
| **`#`** | 匹配**任意多层**，**必须是过滤器最后一个字符**且前面是 `/` 或单独存在；`a/#` 同时匹配 `a`、`a/b`、`a/b/c` |
| **`$` 开头的主题** | 如 `$SYS/...`、`$share/...`；**不被以通配符开头的过滤器匹配**（`#` 与 `+/x` 不匹配 `$SYS/x`），客户端不应发布以 `$` 开头的主题 |
| **区分大小写** | `A/b` 与 `a/b` 不同 |

## PINGREQ / PINGRESP / DISCONNECT

- **保活**：若客户端在保活时间内**没有发送任何其他报文**，必须发送 `PINGREQ`（`C0 00`），服务器回 `PINGRESP`（`D0 00`）。**任何报文都算活动**，所以活跃连接不需要额外心跳；
- 客户端发出 `PINGREQ` 后**应在合理时间内收到 `PINGRESP`**，否则应关闭连接并重连（检测**半开连接**）；
- **DISCONNECT**（`E0 00`）：客户端正常断开，**服务器因此丢弃遗嘱**；发送后客户端必须关闭网络连接。**没有 DISCONNECT 的断开（网络断、超时、协议错误）会触发遗嘱**。

## 一次完整交互的抓包还原

```text
C→S  10 0E 00 04 4D 51 54 54 04 02 00 3C 00 02 63 31      CONNECT  clientId=c1 keepalive=60 clean
S→C  20 02 00 00                                            CONNACK  SessionPresent=0 rc=0
C→S  82 08 00 01 00 03 61 2F 62 01                          SUBSCRIBE id=1  "a/b" QoS1
S→C  90 03 00 01 01                                         SUBACK   id=1  granted QoS1
C→S  32 09 00 03 61 2F 62 00 0A 68 69                       PUBLISH  QoS1 "a/b" id=10 "hi"
S→C  40 02 00 0A                                            PUBACK   id=10
S→C  32 09 00 03 61 2F 62 00 01 68 69                       PUBLISH  （转发给订阅者，Broker 侧的 id=1）
C→S  40 02 00 01                                            PUBACK   id=1
C→S  C0 00                                                  PINGREQ  （保活时间内无其他报文时）
S→C  D0 00                                                  PINGRESP
C→S  E0 00                                                  DISCONNECT
```

抓包与调试方法：Wireshark 显示过滤器 `mqtt`（可对非标准端口用 “Decode As”）；`tcpdump -i any -w mqtt.pcap port 1883`；命令行用 `mosquitto_sub -d -v` 打开调试输出，可看到每个报文的类型与 ID；**TLS 连接抓包需要会话密钥日志**才能解密。更多排障见 [弱网、可靠性、安全与排障](#/iot/mqtt-practice)。

## 实现解码器的检查清单

| 检查 | 原因 |
| --- | --- |
| 固定标志位校验（`PUBREL/SUBSCRIBE/UNSUBSCRIBE`=`0010`，其他非 PUBLISH=`0000`） | 违规必须断开 |
| 剩余长度最多 4 字节，末字节不得再有延续位 | 防畸形/攻击 |
| 剩余长度 ≤ 配置的最大报文大小 | 防内存攻击 |
| 字符串长度前缀不得超过剩余长度；UTF-8 合法、无 `U+0000` | 防越界与注入 |
| QoS 取值 ≠ 3；QoS0 的 DUP=0 | 协议要求 |
| Packet ID ≠ 0，且 QoS>0 的 PUBLISH 才有 ID | 协议要求 |
| 半包/粘包处理：基于长度的帧解码，不足则等待 | 网络流是字节流 |
| 第一个报文必须是 CONNECT，限时内到达 | 防空连接占用 |
| 主题名不含通配符；过滤器通配符位置合法 | 协议要求 |
| 载荷不做假设（二进制），应用层再解析 | MQTT 对载荷不透明 |

Netty 自带 `MqttDecoder/MqttEncoder` 已实现上述大部分，自建网关时直接使用，见 [Java 接入：Paho、Spring 与 Netty](#/iot/java) 的 Netty 章节。

## 相关阅读

- [MQTT 协议详解](#/iot/mqtt)：整体概念与使用入门
- [QoS、会话与 Broker 语义：状态机、离线队列与共享订阅](#/iot/mqtt-qos-session)：握手状态机与 Broker 行为
- [MQTT 5.0 深入：属性、原因码与新机制](#/iot/mqtt-v5)：5.0 对报文的扩展
- [Netty 实战：编解码、内存与调优](#/infra/netty-practice)：基于长度的帧解码与半包处理
- [TCP 深入：状态机、拥塞控制与调优](#/cs/net-tcp)：MQTT 之下的传输层

## 面试追问

> [!QUESTION] MQTT 报文的基本结构是什么？
> 由固定报头、可变报头和载荷组成。固定报头第一个字节高 4 位是报文类型，低 4 位是标志位，后面跟 1 到 4 字节的剩余长度；可变报头随报文类型而异；载荷可选。剩余长度等于可变报头加载荷的字节数，最小报文如 PINGREQ 只有 2 字节。

> [!QUESTION] 剩余长度是怎么编码的？实现时要注意什么？
> 变长整数，每字节低 7 位存数据、最高位表示后面还有字节，最多 4 字节，最大约 256MB。解码要处理半包，数据不够时等待而不是报错；超过 4 字节仍有延续位是畸形报文要断开；还要在读取报文体之前校验不超过最大报文限制，防止恶意长度造成内存攻击。

> [!QUESTION] Packet Identifier 有什么作用？有什么规则？
> 用来把 QoS1/2 的应答与请求配对，是 16 位非零整数，在同一方向上处于未完成状态的报文间必须唯一，收到最终应答后才能复用，重发时必须用原 ID 并置 DUP。两个方向各自独立，SUBSCRIBE 和 UNSUBSCRIBE 也使用它，未完成数量构成飞行窗口。

> [!QUESTION] 为什么 PUBREL、SUBSCRIBE 的固定标志位必须是 0010？
> 规范为这些报文保留了固定的标志位，接收方必须校验，不符合就当作协议错误关闭连接。这既保证互操作，也是对畸形报文的一道防线；自研解码器必须严格实现。

> [!QUESTION] SUBACK 里的返回码有什么含义？客户端要怎么处理？
> 每个主题过滤器一个返回码，0、1、2 表示授予的最大 QoS（可能低于请求的 QoS），0x80 表示该过滤器订阅失败。订阅可以部分失败，客户端必须逐个检查，不能假设全部成功或拿到请求的 QoS，也要在发出订阅前就准备好回调，因为 SUBACK 到达前可能已有消息投递。

> [!QUESTION] CONNACK 的 Session Present 有什么用？
> 当 Clean Session 为 0 时，告诉客户端服务器是否保留了它的旧会话。如果为 0 而客户端以为有会话，就必须重新订阅，否则会出现重连后收不到消息的问题；客户端应据此决定是否重新订阅和重发未确认的消息。
