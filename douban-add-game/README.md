# 豆瓣一键添游戏 | One-Click Add Game to Douban

在 Steam 商店页查豆瓣是否已收录该游戏；未收录则一键跳转豆瓣「创建游戏条目」、自动回填全部可填字段并注入封面。人工只审核和提交，绝不自动提交任何表单。

与 [`douban-add-book/`](../douban-add-book/)（Amazon → 豆瓣图书）同构，payload 是两侧之间的契约，豆瓣侧与来源无关。

## 状态

- ✅ Steam 侧：元数据提取、豆瓣查重、角标 UI、跨标签交接。
- ⏳ 豆瓣侧：`www.douban.com/game/create` 在登录墙后，表单 DOM 未知，回填器待补。
  需要一份登录态下另存的 `fixture-create.html`（见「开发」）。

## 使用流程

1. 打开 Steam 商店页（`store.steampowered.com/app/…`），标题下方角标显示豆瓣查重结果：
   - **已收录** → 条目链接 + 评分，流程结束。
   - **名字相近** → 列出相近条目让你先排除，再决定是否仍要添加。
   - **没搜到** → 「+ 添加到豆瓣」按钮。
   - **查重失败**（风控/网络）→ 降级为手动搜索链接，不假装「没有」。

   角标同时列出脚本提取到的字段和告警（缺中文名、豆瓣没有对应的类型等）。

2. 点「添加到豆瓣」→ 新标签打开 `www.douban.com/game/create?thing_name=…`，脚本回填字段，你核对后提交。

## 设计要点

- **不刮 Steam 的 DOM**，全部走官方 `store.steampowered.com/api/appdetails`。因此页面改版不影响，成人内容年龄门也不需要特判。
- **拉两份响应**：`l=schinese` 给中文名与中文简介，`l=english` 只为拿可解析的发行日期——中文那份返回的是「2020 年 9 月 17 日」。
- **类型按 genre id 映射**，不按文案：id 跨语言稳定，description 会变。豆瓣只有 15 个类型，Steam 的「独立 / 休闲 / 大型多人在线 / 免费开玩」等无处可落，一律进告警让人工补，不猜。
- **平台只填 Steam 能确知的三个**（PC / Mac / Linux），主机平台留空。
- **查重没有主键**。图书有 ISBN，`/isbn/404` 是硬证据；游戏只能按名字搜 `www.douban.com/search?cat=3114`，所以「没搜到」只作弱信号呈现，措辞是「没搜到」而非「未收录」。中英名各搜一次后合并判定。
- **中文名拿不到就留空**，不臆造翻译（Steam 没有中文商店名时 `l=schinese` 返回的仍是英文名）。
- **绝不自动提交**：每一步都由你确认。
- 跨标签数据走本地存储传递，10 分钟过期、消费即删。

## 开发

纯函数层（appid 解析、HTML 转文本、类型/平台映射、标题匹配、查重判定、回填计划）有 `node --test` 单测：

```sh
node --test douban-add-game.test.js
```

`fixture-search.html` 截自真实的 `?cat=3114` 搜索结果页（匿名可取），覆盖精确命中、同系列续作、含 HTML 实体且无评分三种形态。

补豆瓣侧回填器需要的 fixture（登录态下「另存为 → 仅 HTML」）：

- `fixture-create.html` ← `https://www.douban.com/game/create?thing_name=Hades`
- 若是多步表单，每步各存一份
- 若封面是独立上传页，另存 `fixture-cover.html`

无构建步骤，单文件 IIFE；纯函数与运行期共用同一文件，靠 `module.exports` 守卫区分 node 与浏览器。

## 权限与隐私

- `@match` 仅 `store.steampowered.com/app/*` 与 `www.douban.com/game/create*`。成人内容游戏会先跳到 `/agecheck/app/…`，那一页不在匹配范围内，过了年龄门再看角标。
- `@connect store.steampowered.com`：读官方 appdetails 接口。
- `@connect www.douban.com`：用你的登录态搜索该游戏是否已收录（只读，不做任何写操作）。
- `@connect shared.akamai.steamstatic.com`：抓取封面图。
- 不上传任何数据、不接入第三方或分析服务。
