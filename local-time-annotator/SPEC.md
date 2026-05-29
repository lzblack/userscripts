# Local Time Annotator — v1 定稿 Spec

**目标**:任意网页上、非本地时区的绝对时间,在原文后非破坏性追加本地时间。
例:`14:42 UTC` → 追加 ` (10:42 AM EDT)`。

**v1 范围**:只处理偏移完全确定的时间(零歧义)。
**显式非目标**:具名缩写(EDT/CST 等,留 Tier 3,因 CST 同时是中国/美中/古巴时间,静态无法消解)、相对时间("2 hours ago")、时间区间共享尾部 offset(`14:00–18:00 UTC` 仅标 `18:00`,见已知限制)。

> **范围变更(经 Zhi 批准,2026-05-29)**:原非目标「跨多 DOM 节点拆开的时间」已实现为 **Tier 2b**——见 §1.2。触发原因:Atlassian Statuspage 等大量真实页面把时间戳拆成兄弟节点,是最常见场景而非边缘。

---

## 1. 源识别(两层,按优先级)

- **Tier 1 — `<time datetime>`**:`new Date(el.getAttribute('datetime'))`,有效则格式化追加。最优先、零歧义。
- **Tier 2 — 文本中偏移确定的时间**:正则匹配 `时间 + (Z | UTC | GMT)` 可带数字偏移,或裸数字偏移 `±HH:MM` / `±HHMM`。**不匹配任何具名缩写**。

时间部分:`HH:MM(:SS)?` + 可选 `AM/PM`,24/12 小时都支持。

### 1.2 Tier 2b — 跨节点拆分时间戳

真实页面常把时间戳拆成兄弟 DOM 节点,单个文本节点不含完整「时间+标记」,故 Tier 2(单节点)漏掉:

```
<small>"May" <var data-var="date">29</var> "," <var data-var="time">08:45</var> "UTC"</small>
```

**算法**:遍历时,凡含标记但单节点无法独立命中的文本节点(fragment),记其父元素为「容器候选」。容器满足以下条件才追加注解:
- 不含块级后代(`isInlineLeaf` — 否则会把注解追加到无关块内容之后)
- 其子文本节点无任何 Tier 2a 命中(与单节点 pass 不重叠,避免重复)
- 非 skippable、未标 `dataset.ltDone`

命中后用 **`liveText`(排除已有 `.lt-annot` 输出,杜绝 `GMT+8` 自匹配)** 组装容器文本,对每个匹配算本地时间,**追加到容器末尾**,并打 `dataset.ltDone` 幂等。

### 1.1 正则鲁棒性硬约束(命门所在,先写 fixture 再写正则)

- **时间必须紧贴 offset 标记**:`UTC`/`GMT` 在正文、时区下拉框中大量裸出现,严禁单独匹配。要求 `时间 [空白]* (Z|UTC|GMT)` 连续。
- **非整时偏移**:必须支持 `GMT+5:30`(印度)、`+05:45`(尼泊尔)、`UTC+8`。`UTC±N` 分支须允许后接 `:MM`,不能只认裸 `±HH:MM`。
- **空格容忍但不跨词**:`UTC + 8`、`UTC+8`、`UTC +8` 均可,但不得跨越非空白词。

---

## 2. 转换算法(唯一正确路径)

```
解析 h/m/s + am/pm
srcOffsetMin = (Z|UTC|GMT → 0) | 解析 ±offset | 解析 UTC±N(含 :MM)
date = 同 text node 内的日期(月名式 或 YYYY-MM-DD);找不到 → today(见已知限制)
instant = new Date(Date.UTC(y,mo,d,h,m,s) - srcOffsetMin*60000)
输出 = 用本地时区格式化 instant
```

本地时区 = `Intl.DateTimeFormat().resolvedOptions().timeZone`(浏览器自动,唯一正确来源)。
目标 DST 交给 `Intl` 按 `instant` 自动处理,**绝不手算**。
输出格式:`{ hour:'numeric', minute:'2-digit', hour12:true, timeZoneName:'short' }` → `10:42 AM EDT`。

---

## 3. "已是本地"跳过

算出 `instant` 在本地时区的偏移(`formatToParts` + `timeZoneName:'longOffset'` 解析,或 `(utc-local)/60000` 反算),若 `=== srcOffsetMin` 则不追加。

---

## 4. DOM

- `TreeWalker(SHOW_TEXT)` 改 text node,**禁用 innerHTML**。
- 跳过祖先含 `script/style/noscript/textarea/code/pre`、`contenteditable`、或 `.lt-annot` 的节点。

---

## 5. 动态内容 + 性能(v1 必做,非 v1.x)

核心策略:**全站覆盖 + 强制廉价早退 + 轻量 observer**,不退化为域名白名单。

- **首扫廉价早退**:全页 `TreeWalker` 前,先用 `UTC|GMT|\bZ\b|±\d{2}:?\d{2}` 对 `body.textContent` 跑一次 `test()`。未命中 → **跳过整页 walk**(绝大多数网页一次正则即退出,零 walk)。observer 照常挂。
- **scoped 重扫**:`MutationObserver` 回调**只处理 `addedNodes`**(过滤 attribute/characterData record),对新增子树同样先 `test()` 再 walk;用 `requestIdleCallback`(或 ~300ms timeout)debounce 批处理。idle 时回调成本趋近 0。
- **写入隔离**:写 DOM 前 `observer.disconnect()`,写完 `reconnect`。
- **幂等**:追加前检查匹配项相邻 sibling 是否已是 `.lt-annot`;`<time>` 用 `dataset.ltDone`。SPA 替换节点时注解一并消失 → 自动重标,正确。

---

## 6. 渲染

追加 `<span class="lt-annot"> (10:42 AM EDT)</span>`,半透明小字,不覆盖原文。`.lt-annot` 同时用作幂等标记。

---

## 7. 配置面(模块顶部常量,均不暴露 UI)

| 常量 | 默认 | 说明 |
|---|---|---|
| `LOCAL_ZONE` | `null` | `null` = 浏览器自动检测;非空仅供 **fixture 测试强制时区**,验证 `+8` 用户所见 |
| `OUTPUT_LOCALE` | `'en-US'` | 匹配 `AM/PM` 样式 |
| `ANNOT_CLASS` | `'lt-annot'` | 兼作幂等标记 |
| `SKIP_IF_SAME_OFFSET` | `true` | 见 §3 |
| `DEBOUNCE_MS` | `300` | observer 批处理 |
| `ENABLE_NAMED` | `false` | Tier 3 开关,v1 恒 false |

---

## 8. 已知限制(v1 接受,文档化)

- **无日期时 fallback `today`**:仅在命中目标时区 DST 切换日时偏 1 小时。v1 只输出 time-of-day,影响低频,不解决。
- **时间区间**:`14:00–18:00 UTC` 仅 `18:00` 带 offset → 仅标注 `18:00`。
- **具名缩写**:不处理(Tier 3)。
- **`GMT` 宽松用法**:页面写 `GMT` 即按 +0 处理(英国夏令时实为 BST,但页面常写 GMT)。

---

## 9. 验收(fixture 页面 = 格式动物园)

先建此页,正则对它做 TDD,逐项核对:

- `19:00Z`、`14:42 UTC`、`2:42 PM GMT` → 追加正确
- `<time datetime="2026-05-28T14:42:00+00:00">` → Tier 1 命中
- `09:30 UTC+8`、`15:00 -05:00`、`11:00 GMT+5:30` → 偏移正确(含半时偏移)
- 本地时区的一个时间 → **不追加**(§3)
- 正文裸 `UTC`/`GMT` 单词(无前置时间) → **不误匹配**(§1.1)
- `<textarea>`/`<code>` 内的时间 → **忽略**
- 初始干净、JS 动态注入含时间节点 → observer 命中、**不死循环**(打开 1 分钟 CPU 应回 0)
- 用 `LOCAL_ZONE='Asia/Shanghai'` 强制,核对 `+8` 用户所见

---

## 10. 部署

Tampermonkey:`@match *://*/*`、`@run-at document-idle`、`@grant none`。
扩展移植:IIFE 内容原样进 content script,删 UserScript 头即可。
