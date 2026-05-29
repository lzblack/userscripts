恢复 Firefox 双击 CJK 文本（中文、日文、韩文）的旧行为。Firefox 自 116 切换到 ICU4X 后，双击一个 CJK 字符只会选中**单个字**（如双击「今」只选「今」），过去那种"选中连续整段"的体验没了。这个脚本把老行为还回来。

## 效果对比

双击 `今天天气很好` 中的「今」：

- **Firefox 旧版**：`今天天气很好`（整段，到非 CJK 边界为止）
- **Firefox 现在**：`今`（只一个字）❌
- **Chrome / Edge / Safari**：`今天`（按 ICU 词典分词）
- **本脚本（Firefox 装上后）**：`今天天气很好` ✅

日文同样生效——双击 `今日は天気がいい` 中的任意字（含假名 `は` / `がいい`），整段一起选中，假名不再把短语切碎。

## 适用范围

- ✅ **仅 Firefox 生效**。脚本在启动时检测 UA，Chrome / Edge / Safari 装上后直接 no-op，不影响原生行为
- ✅ 所有网站（`*://*/*`），含 iframe
- ✅ contenteditable 编辑区
- ⚠️ `<input>` / `<textarea>`：跳过，用浏览器原生选择
- ⚠️ Shadow DOM：best-effort

## 边界规则

完全由 Unicode 决定：CJK 字符（`\p{Script=Han}` 全部表意字平面、日文假名、注音、谚文，以及 `々ー〆` 等段内记号）= 同一段；其他任何字符（标点、空格、字母数字、Emoji…）= 边界。**不维护字符列表**，因此中英标点、全角空格、新 Emoji、奇怪符号都能自然作为边界，不会漏。

## 跨节点

`<span>今天</span><span>天气很好</span>` 会合并为一段。`<p>` / `<div>` / `<li>` 等块级元素阻断合并。

## 不做

- 不调用 `Intl.Segmenter`（避开 ICU4X，本来就是想绕开它）
- 不维护标点白名单
- 不分句、不分词，只做"扩展到下一个非 CJK 边界"

## 上游 bug 跟踪

已在 Mozilla Bugzilla 提报：[Bug 2040746](https://bugzilla.mozilla.org/show_bug.cgi?id=2040746)。本脚本是该 bug 修复前的临时替代方案——Mozilla 修好后即可卸载。

## 反馈

[提交 Issue](https://github.com/lzblack/userscripts/issues)

完整说明 / 算法细节 / 测试用例见 [GitHub README](https://github.com/lzblack/userscripts/tree/main/cjk-dblclick-select)。

更新日志：[CHANGELOG](https://github.com/lzblack/userscripts/blob/main/cjk-dblclick-select/CHANGELOG.md)

---

## 同作者的其他脚本

- [豆瓣评分汇](https://greasyfork.org/zh-CN/scripts/572796) — 豆瓣全品类评分聚合（16 个平台 + 榜单胶囊）
- [豆瓣书名号转搜索链接](https://greasyfork.org/zh-CN/scripts/558844) — 《书名号》转可点击的豆瓣搜索链接
- [豆瓣读书版本标记提示](https://greasyfork.org/zh-CN/scripts/572604) — 提示你标记过同一本书的其他版本
- [豆瓣广播标记助手](https://greasyfork.org/zh-CN/scripts/572857) — 在首页广播流中显示你的书影音游标记状态和评分
