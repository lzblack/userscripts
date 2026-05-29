# 双击选中文短语 | CJK Double-Click Phrase Select (Firefox)

恢复 Firefox 双击 CJK 文本（中文、日文、韩文）的旧行为。Firefox 116 起切换到 ICU4X 后，双击一个 CJK 字符只会选中**单个字**（如双击「今」只选「今」），而不是过去的"选中连续整段到下一个非 CJK 边界为止"。这个脚本把老行为还回来。

> **上游 bug**：已在 Mozilla Bugzilla 提报，跟踪进度见 [Bug 2040746](https://bugzilla.mozilla.org/show_bug.cgi?id=2040746)。本脚本是这个 bug 修复前的临时替代方案。

## 修了什么

| 浏览器 | 双击 `今天天气很好` 中的 `今` | 来源 |
|---|---|---|
| Firefox 旧版（pre-ICU4X，~116 前） | `今天天气很好`（整段） | "连续 CJK run" |
| Firefox 现在（post-ICU4X） | `今`（只一个字）❌ | ICU4X 词典缺失 |
| Chrome / Edge / Safari | `今天`（按词） | ICU `BreakIterator` 分词 |
| **本脚本（Firefox 装上后）** | `今天天气很好`（整段）✅ | 自定义算法 |

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)（Firefox 推荐 Violentmonkey）
2. 从 [GreasyFork](https://greasyfork.org/zh-CN/scripts/) 安装本脚本
3. 任意网页上双击 CJK 字符即可生效，无需配置

> **Chrome / Edge / Safari 用户**：脚本会在启动时自检 UA，若不是 Firefox 直接 no-op，**不会影响**你浏览器原生的分词选择行为。装上也无害。

## 算法说明

双击触发后：

1. 检查 `window.getSelection()` 是否含 CJK 字符。不含 → 不动（保留英文 / 代码的原生行为）
2. 用 `caretPositionFromPoint(x, y)` 定位光标
3. 从光标位置向左、向右扩展，遇到第一个**非 CJK** 字符即停止
4. 用扩展后的范围覆盖原选区

"是否 CJK 字符"由 Unicode 脚本属性判定：`\p{Script=Han}`（全部表意字平面，含扩展 A–F、兼容区）、日文假名、注音、谚文，外加 `々ー〆` 等连写在段内的记号。**不维护标点列表**——中英标点、空格、字母数字、Emoji 全部天然作为边界。

## 跨节点处理

`<span>今天</span><span>天气很好</span>` 这种被 inline 元素切碎的情况会合并为一段；但跨过 `display: block`（含 flex / grid）的子元素时停止，所以 `<p>今天<div>新段落</div>剩余</p>` 中双击 `余` 只选 `剩余`，不会吸进 `新段落`。

## 不处理

- **`<input>` / `<textarea>`**：用浏览器原生选择
- **Shadow DOM**：best-effort（支持新版 `caretPositionFromPoint` 的 `shadowRoots` 选项时生效）
- **`<br>` 隔开的同段文字**：会合并（BR 是 inline）。如果不希望合并请提 issue

## 测试

打开仓库内的 [`test.html`](test.html)，按页面里的"预期"逐条双击验证。

## 反馈

[提交 Issue](https://github.com/lzblack/userscripts/issues)

## License

MIT
