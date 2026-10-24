# 豆仓 | Douban Archive

在已登录豆瓣的浏览器里，导出自己全部的书、影、音、游戏、舞台剧标记（含私密），下载为原始 JSON 与 NeoDB CSV（zip）。只读、只在本机处理，不联系豆瓣以外的任何地址。

计划、验证记录与决策见 [`PLAN.md`](PLAN.md)。

## 状态

v0.3.0。在 Firefox + Tampermonkey 上对一个 9304 条（含 6 条私密）的账号完整跑通两次，14 个书架条数全部与 `total` 一致。NeoDB CSV 按 NeoDB `CsvImporter` 的读法解析通过，尚未在 NeoDB 上真实导入。暂停后续跑、安全验证只有单元测试，没在真实环境触发过。

## 使用

首页 `www.douban.com` 侧栏的「豆仓」→「导出我的标记」，或 Tampermonkey 菜单「导出全部标记」。导出期间保持标签页打开，约一万条 20 分钟。完成后下载 `douban-archive-<用户名>-<日期>.json` 与 `…-neodb.zip`。

## 设计要点

- **数据来源是 Rexxar**（m.douban.com 背后的接口，豆伴同源）：`/rexxar/api/v2/user/{数字 id}/interests?type=&status=&start=&count=50`，带登录 cookie 与 `ck`。每页 50 条，比翻网页列表（15 条）请求少，网页改版也不受影响。
- **从 www 跨域请求，必须带 `Referer: https://m.douban.com/mine/`**：不带返回 400 / `code 1287`。豆伴设的 `X-Override-Referer` 是它扩展内部改写 Referer 用的，豆瓣不认。Tampermonkey 的 `GM_xmlhttpRequest` 能设 `Referer`。
- **uid**：同源请求 `/mine/`，从跳转后的 `/people/{用户名}/` 读用户名，再用 `/rexxar/api/v2/user/{用户名}` 换数字 id。页面上的 `/people/` 链接不可用（首页动态里全是别人的）。
- **`total` 含私密**（全量导出证实：三个有私密的书架都是 取到 = `total`）。新加一条私密后 `total` 没变，曾让人以为不含，是同期别的标记增减抵消了。
- **服务端会暂时丢条**：同一页第一次请求可能只回 34 条，紧接着重取就是 50 条（并集正好 50）；还会偶发 200 + 空页 + `total: 0`。所以没取到 `total` 的短页与空页要重取（最多 3 次、按 `id` 合并），`total: 0` 的空页不能当成结束。取到 `total` 就停，不再请求空页；整页却超过 `total`（导出中途新加了标记）继续翻。
- **暂停与失败分开**：不是"200 + JSON"也不是"带 `code` 的 JSON"的一律暂停（网络错误、超时、中止、不是 JSON——安全验证跳转经 `GM_xmlhttpRequest` 的具体表现没实测过）；带 `code` 才算失败。两种都保留已取的页 24 小时，失败时不下载半份数据。
- **存储按页**：每页一个 `GM_setValue` 键，另有一个小的进度键，只在页边界存档。全量约 24 MB，不反复重写一个越来越大的值。下载后不立即删，用户确认文件已保存再清。
- **NeoDB CSV**：表头照 NeoDB 导出（`title, info, links, timestamp, status, rating, comment, tags`），另加 `visibility`（私密为 2）供计划中的 NeoDB PR 用；按 `subject.type` 分文件（电影书架里有 947 条剧集进 `tv_mark.csv`，舞台剧进 `performance_mark.csv`）；时间补 `+08:00`；评分 × 2；UTF-8 无 BOM。zip 是手写的 store 格式，无外部库。
- **界面**：首页侧栏入口只在从没导出过、或开启了定期提醒且满 30 天时出现；右下角卡片走开始前 / 导出中 / 暂停 / 出错 / 完成几种状态。所有文本走 textNode，不拼 HTML。

## 测试

```sh
node --test douban-archive/
```

纯逻辑（翻页与停止、重取合并、暂停 / 续跑 / 失败 / 取消、`meta` 核对、NeoDB 行转换、CSV 转义、zip 结构与 CRC、入口显示规则、预计时间）都有用例，假服务端按 §2 实测到的响应序列构造。界面用无头 Chromium 加载保存下来的首页、注入假的 GM 函数与接口做过端到端渲染（不进仓库）。

手动：Tampermonkey 新建脚本，粘贴 `douban-archive.user.js` 全文，打开豆瓣首页。首次跨域请求会弹权限确认，选「总是允许」。
