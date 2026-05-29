<!--
GreasyFork 附加信息（多语言）。GreasyFork 的「附加信息」按站点语言分版本展示：
把下面 ===== 分隔的三段分别粘贴到 GreasyFork 对应语言（中文 / 日本語 / English）的输入框。
每段都自包含，可独立粘贴。
-->

===== 中文（简体）=====

恢复 Firefox 双击 CJK 文本（中文、日文、韩文）的旧行为。Firefox 自 116 切换到 ICU4X 后，双击一个 CJK 字符只会选中**单个字**（如双击「今」只选「今」），过去那种"选中连续整段"的体验没了。这个脚本把老行为还回来。

## 效果对比

双击 `今天天气很好` 中的「今」：

- **Firefox 旧版**：`今天天气很好`（整段，到非 CJK 边界为止）
- **Firefox 现在**：`今`（只一个字）❌
- **Chrome / Edge / Safari**：`今天`（按 ICU 词典分词）
- **本脚本（Firefox 装上后）**：`今天天气很好` ✅

日文同样生效——双击 `今日は天気がいい` 中的任意字（含假名 `は` / `がいい`），整段一起选中，假名不再把短语切碎。韩文（谚文）也支持：因韩文词间有空格，双击会选到空格为止，正好一个词。

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

[提交 Issue](https://github.com/lzblack/userscripts/issues)。完整说明 / 算法细节 / 测试用例见 [GitHub README](https://github.com/lzblack/userscripts/tree/main/cjk-dblclick-select)；更新日志：[CHANGELOG](https://github.com/lzblack/userscripts/blob/main/cjk-dblclick-select/CHANGELOG.md)。

## 同作者的其他脚本

- [豆瓣评分汇](https://greasyfork.org/zh-CN/scripts/572796) — 豆瓣全品类评分聚合（16 个平台 + 榜单胶囊）
- [豆瓣书名号转搜索链接](https://greasyfork.org/zh-CN/scripts/558844) — 《书名号》转可点击的豆瓣搜索链接
- [豆瓣读书版本标记提示](https://greasyfork.org/zh-CN/scripts/572604) — 提示你标记过同一本书的其他版本
- [豆瓣广播标记助手](https://greasyfork.org/zh-CN/scripts/572857) — 在首页广播流中显示你的书影音游标记状态和评分

===== 日本語 =====

ICU4X 導入前の Firefox における CJK テキストのダブルクリック動作を復元します。Firefox 116 で ICU4X に切り替わって以降、CJK 文字をダブルクリックしても**1 文字しか選択されず**（例：「今」をダブルクリックすると「今」だけ）、かつての「連続したまとまりを選択する」挙動が失われました。このスクリプトは旧来の挙動を取り戻します。

## 動作の比較

`今天天气很好` の「今」をダブルクリック：

- **旧 Firefox**：`今天天气很好`（非 CJK 境界までのまとまり）
- **現在の Firefox**：`今`（1 文字だけ）❌
- **Chrome / Edge / Safari**：`今天`（ICU 辞書による分かち書き）
- **本スクリプト（Firefox）**：`今天天气很好` ✅

日本語でも有効です。`今日は天気がいい` の任意の文字（かな `は` / `がいい` を含む）をダブルクリックすると、まとまり全体が選択され、かなで語句が分断されません。韓国語（ハングル）にも対応——韓国語は単語間に空白があるため、空白までが選択され、ちょうど 1 単語になります。

## 対応範囲

- ✅ **Firefox 専用**。起動時に UA を判定し、Chrome / Edge / Safari では何もしません（ネイティブ動作に影響なし）
- ✅ すべてのサイト（`*://*/*`）、iframe を含む
- ✅ contenteditable の編集領域
- ⚠️ `<input>` / `<textarea>`：対象外（ブラウザのネイティブ選択を使用）
- ⚠️ Shadow DOM：ベストエフォート

## 境界の判定

完全に Unicode で決まります。CJK 文字（`\p{Script=Han}` の全表意文字面、日本語のかな、注音、ハングル、および `々ー〆` などまとまり内の記号）＝同一のまとまり。それ以外の文字（句読点・空白・英数字・絵文字など）＝境界。**文字リストを保守しない**ため、和欧の約物・全角空白・新しい絵文字・特殊記号もすべて自然に境界として機能します。

## ノードをまたぐ場合

`<span>今天</span><span>天气很好</span>` は 1 つのまとまりに結合されます。`<p>` / `<div>` / `<li>` などのブロック要素は結合を遮断します。

## 行わないこと

- `Intl.Segmenter` を呼ばない（ICU4X を回避するのが目的）
- 約物のホワイトリストを保守しない
- 文や単語の分割はせず、「次の非 CJK 境界まで拡張する」だけ

## 上流バグの追跡

Mozilla Bugzilla に報告済み：[Bug 2040746](https://bugzilla.mozilla.org/show_bug.cgi?id=2040746)。本スクリプトは修正までの一時的な代替策です。Mozilla 側で修正されたらアンインストールしてください。

## フィードバック

[Issue を提出](https://github.com/lzblack/userscripts/issues)。詳細・アルゴリズム・テストケースは [GitHub README](https://github.com/lzblack/userscripts/tree/main/cjk-dblclick-select)、更新履歴は [CHANGELOG](https://github.com/lzblack/userscripts/blob/main/cjk-dblclick-select/CHANGELOG.md) を参照。

===== English =====

Restore the pre-ICU4X Firefox double-click behavior for CJK text (Chinese, Japanese, Korean). Since Firefox 116 switched to ICU4X, double-clicking a CJK character selects **only a single character** (e.g. double-clicking 今 selects just 今), losing the old "select the whole contiguous run" behavior. This script brings the old behavior back.

## Behavior comparison

Double-click 今 in `今天天气很好`:

- **Old Firefox**: `今天天气很好` (the whole run, up to a non-CJK boundary)
- **Current Firefox**: `今` (one character only) ❌
- **Chrome / Edge / Safari**: `今天` (ICU dictionary segmentation)
- **This script (on Firefox)**: `今天天气很好` ✅

It works for Japanese too — double-click any character in `今日は天気がいい` (including kana like `は` / `がいい`) and the whole run is selected; kana no longer breaks the phrase apart. Korean (Hangul) is supported as well: because Korean words are space-separated, the selection extends to the whitespace, giving exactly one word.

## Scope

- ✅ **Firefox only**. The script checks the UA on startup and no-ops on Chrome / Edge / Safari (native behavior untouched)
- ✅ All sites (`*://*/*`), including iframes
- ✅ contenteditable regions
- ⚠️ `<input>` / `<textarea>`: skipped, uses the browser's native selection
- ⚠️ Shadow DOM: best-effort

## Boundary rule

Determined entirely by Unicode: a CJK character (`\p{Script=Han}` across every ideograph plane, Japanese kana, Bopomofo, Hangul, plus in-run marks like `々ー〆`) = same run; any other character (punctuation, space, alphanumerics, Emoji…) = boundary. **No character list to maintain**, so CJK/Latin punctuation, full-width spaces, new Emoji, and odd symbols all act as boundaries naturally.

## Across nodes

`<span>今天</span><span>天气很好</span>` merges into one run. Block-level elements like `<p>` / `<div>` / `<li>` stop the merge.

## What it does not do

- Does not call `Intl.Segmenter` (avoiding ICU4X is the whole point)
- Does not maintain a punctuation allowlist
- No sentence or word splitting — only "expand to the next non-CJK boundary"

## Upstream bug tracking

Reported on Mozilla Bugzilla: [Bug 2040746](https://bugzilla.mozilla.org/show_bug.cgi?id=2040746). This script is a temporary workaround until that bug is fixed — uninstall it once Mozilla ships the fix.

## Feedback

[Open an issue](https://github.com/lzblack/userscripts/issues). Full docs / algorithm / test cases: [GitHub README](https://github.com/lzblack/userscripts/tree/main/cjk-dblclick-select); changelog: [CHANGELOG](https://github.com/lzblack/userscripts/blob/main/cjk-dblclick-select/CHANGELOG.md).
