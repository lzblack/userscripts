# 豆仓（Douban Archive）：计划

Status: v0.2，2026-10-23 定范围（§5）；动手前先过 §2 的验证。

## 1. 目标

在已登录豆瓣的浏览器里，导出自己的全部书影音游戏舞台剧标记，**含私密标记**，下载为：

- **JSON：** 接口返回的原始条目，原样保存
- **xlsx：** 豆伴的格式（NeoDB 可直接导入，见 §4），换个工具也能读

只做导出：不上传到任何服务器，不联系豆瓣以外的任何地址。文件拿去做什么是用户自己的事。

为什么要做：豆伴（doufen-org/tofu）是目前唯一能导出私密标记的工具，但它只支持 Chromium 内核浏览器，2022-09 的 v0.11.0 之后只在 2025-03 为 Manifest V3 改过一次 manifest，97 个 issue 无人处理。Firefox 用户没有可用的工具。

### 1.1 已有的脚本（2026-10-23 读过源码）

| 脚本 | 取数 | 覆盖 | 输出 | 缺的 |
| --- | --- | --- | --- | --- |
| byJming《豆瓣书影音游戏数据导出工具》（Greasy Fork 586975，v2.4.0，2026-08） | 浏览器逐页打开网页版列表（每页 15 条，随机等 1.2–3 秒），一次一个类别 × 状态 | 影书音游 × 想 / 在 / 过 | 自定义列的 xlsx、JSON、封面 ZIP | 舞台剧；豆伴 / NeoDB 格式；不区分私密；不核对总数 |
| bambooooo《豆瓣读书+电影+音乐+游戏+舞台剧导出工具》（420999，v0.4.4，2024-01，安装 3347） | 同上，翻网页列表 | 五类 × 想 / 过 | 每类一个 CSV | "在"；xlsx；`dexie@latest` 未锁版本 |
| RiTian96《豆瓣观影数据导出Trakt》（594897，2026-09） | 翻网页列表 | 电影 | Trakt JSON（匹配 IMDb） | 只为迁移到 Trakt |
| 豆伴（Chrome 扩展） | Rexxar | 全部 | 豆伴 xlsx | 只支持 Chromium，基本不维护 |
| zcyoung2000/douban-backup（Python，2026-06） | 读浏览器 cookie 后请求 | 五类 | 豆伴 xlsx、SQLite、增量 | 要装 Python，把 cookie 交给脚本 |

本脚本的不同：Rexxar JSON 后台翻页（每页 50 条，请求约为翻网页的三分之一，网页改版不受影响）；按 `is_private` 标出私密；五类 × 三状态一次导完；豆伴 / NeoDB 格式；与 `total` 核对。

## 2. 数据来源

豆伴读标记用 Rexxar（m.douban.com 背后的接口，见豆伴 `extension/tasks/interest.js`）：

```
https://m.douban.com/rexxar/api/v2/user/{uid}/interests?type={type}&status={status}&start={start}&count=50&ck={ck}&for_mobile=1
```

带登录 cookie，`ck` 取自同名 cookie；豆伴另设 `X-Override-Referer: https://m.douban.com/mine/`。

**动手前要在已登录的 `https://m.douban.com/mine/` 控制台跑一次 §2.1**（只打印计数与字段名，不打印标题和短评），确认：

1. 同源 `fetch` 不设 Referer 头也能拿到数据，`ck` 能从 `document.cookie` 读到
2. `total` 与豆瓣个人主页上该书架显示的数字一致
3. 私密条目在返回里，且带 `is_private: true`
4. 条目与 `subject` 的字段（标题、评分、短评、标签、标记时间、链接）都在

任何一条不成立就回到这里重新设计。

运行位置首选 www（§3 方案 C），所以还要在 Tampermonkey 里临时装 §2.2 的脚本，在已登录的 www.douban.com 页面点菜单"豆仓探针"，确认：

5. www 上 `GM_xmlhttpRequest` 跨域请求 Rexxar 能拿到数据（带 cookie）；记下不设 Referer、设 `Referer`、设 `X-Override-Referer` 三种里哪些成功

5 不成立（三种都失败）就退回方案 B。测完删掉这个临时脚本。

### 2.1 验证片段

每个书架只取第一页（14 次请求，约 30 秒）：`total` 对照个人主页的数字，私密与字段名在全部书架里找。另打印页面上能找到的 uid 候选，供 §3 自动读 uid。

```js
(async () => {
  const UID = 'lzblack';
  const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
  const uidCandidates = [...new Set([...document.querySelectorAll('a[href*="/people/"]')]
    .map(a => (a.href.match(/\/people\/([^/?#]+)/) || [])[1]).filter(Boolean))];
  const shelves = [];
  const keys = new Set(), subjectKeys = new Set();
  let sawPrivateKey = false;
  outer: for (const type of ['book', 'movie', 'music', 'game', 'drama']) {
    for (const status of type === 'drama' ? ['mark', 'done'] : ['mark', 'doing', 'done']) {
      const r = await fetch(`/rexxar/api/v2/user/${UID}/interests?type=${type}&status=${status}&start=0&count=50&ck=${ck}&for_mobile=1`, { credentials: 'include' });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { shelves.push({ type, status, http: r.status, url: r.url, notJson: text.slice(0, 80) }); break outer; }
      const rows = j.interests || [];
      for (const i of rows) {
        Object.keys(i).forEach(k => keys.add(k));
        Object.keys(i.subject || {}).forEach(k => subjectKeys.add(k));
        if ('is_private' in i) sawPrivateKey = true;
      }
      shelves.push({ type, status, http: r.status, code: j.code, total: j.total, page: rows.length, private: rows.filter(i => i.is_private).length });
      await new Promise(s => setTimeout(s, 2000));
    }
  }
  console.table(shelves);
  console.log({ ckFound: !!ck, uidCandidates, sawPrivateKey, keys: [...keys], subjectKeys: [...subjectKeys] });
})();
```

### 2.2 跨域探针（临时脚本，不进仓库）

```js
// ==UserScript==
// @name         豆仓探针
// @match        https://www.douban.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      m.douban.com
// ==/UserScript==
(function () {
  'use strict';
  console.log('豆仓探针：已加载', location.href);
  const UID = 'lzblack';
  const variants = {
    noReferer: {},
    referer: { Referer: 'https://m.douban.com/mine/' },
    xOverride: { 'X-Override-Referer': 'https://m.douban.com/mine/' },
  };
  const get = (url, headers) => new Promise(resolve => GM_xmlhttpRequest({
    method: 'GET', url, headers, anonymous: false, timeout: 15000,
    onload: r => resolve(r),
    onerror: e => resolve({ status: 'error', error: String(e && e.error) }),
    ontimeout: () => resolve({ status: 'timeout' }),
    onabort: () => resolve({ status: 'abort' }),
  }));
  GM_registerMenuCommand('豆仓探针', async () => {
    alert('豆仓探针：开始（点确定后约 10 秒出结果）');
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    const url = `https://m.douban.com/rexxar/api/v2/user/${UID}/interests?type=book&status=mark&start=0&count=50&ck=${ck}&for_mobile=1`;
    const results = [];
    for (const [name, headers] of Object.entries(variants)) {
      console.log(`豆仓探针：请求 ${name}`);
      const r = await get(url, headers);
      let j;
      try { j = JSON.parse(r.responseText); } catch { j = null; }
      results.push({
        name, status: r.status, finalUrl: r.finalUrl, notJson: j ? undefined : String(r.responseText || r.error || '').slice(0, 80),
        code: j && j.code, msg: j && j.msg, total: j && j.total, page: j && (j.interests || []).length,
      });
      await new Promise(s => setTimeout(s, 2000));
    }
    console.table(results);
    console.log({ ckFound: !!ck });
    alert('豆仓探针：完成，结果在控制台');
  });
})();
```

## 3. 脚本

单文件 IIFE、纯 JS、无构建，照仓库 `CLAUDE.md`；纯逻辑（翻页、停止、行转换）用 `node --test` 测，fixture 用合成数据。中文界面。

- **运行位置：** 首选方案 C：`@match https://www.douban.com/*`，用 `GM_xmlhttpRequest` 跨域请求 Rexxar（`@connect m.douban.com`），按 §2.2 的结果决定带哪个 Referer 头。§2.2 不成立则退回方案 B：同时 `@match https://m.douban.com/mine/*`，www 上的命令打开 `https://m.douban.com/mine/#douban-archive`，m 站脚本见到这个标记才开始导出，在那里同源 `fetch`
- **触发：** 菜单命令"导出全部标记"，只手动，不自动运行（方案 B 的 hash 标记只来自这个命令）
- **uid：** 从页面或接口读出当前登录用户，不让用户填；读不到就提示并停止
- **范围：** 书、影、音、游戏、舞台剧 × 想 / 在 / 过（舞台剧没有"在"），按请求的 `count` 翻页，不按返回条数（私密条目可能让页变短）
- **节奏与风控：** 用的是用户自己的登录账号。串行，每次请求间隔 2 秒（约 10000 条标记约 200 次请求、7 分钟），不重试
- **暂停与续跑：** 请求被转到安全验证（`sec.douban.com`，或响应不是 JSON）时暂停，提示用户在新标签页完成验证后点"继续"，从断点那一页接着取；进度（已取的页与条目）存在 `GM_setValue`，关掉页面也能续。其他错误（响应体有 `code`、非 200）停止整次导出，已取到的部分不下载（半份数据容易被当成全量）；续跑的进度保留 24 小时
- **进度：** 页面上显示当前书架与条数，可以取消
- **校验：** 每个书架取完后比较取到的条数与 `total`，不一致写进导出文件的 `meta` 并在完成时提示
- **输出文件名：** `douban-archive-<uid>-<日期>.json` / `.xlsx`

## 4. xlsx 格式

照豆伴（NeoDB 的豆伴导入器 `neodb/journal/importers/douban.py` 按这个读）：

- sheet 名：`想读` `在读` `读过` `想看` `在看` `看过` `想听` `在听` `听过` `想玩` `在玩` `玩过` `想看的舞台剧` `看过的舞台剧`
- 列：`[0]` 标题、`[3]` 链接、`[4]` 标记时间（北京时间 `YYYY-MM-DD HH:MM:SS`）、`[5]` 评分 1–5 或空、`[6]` 逗号分隔的标签、`[7]` 短评；其余列照豆伴的表头填
- SheetJS 从 `cdn.sheetjs.com` 以固定版本 `@require`

Greasy Fork 规则（2026-10-23 核对 code-rules、external-scripts、cdns）：代码不得混淆或压缩；外部库要 `@require` 自认可的 CDN（`cdn.sheetjs.com`、`cdn.jsdelivr.net` 都在列）。本脚本不发数据给作者，不涉及 `@antifeature`。

验收：用一个真实导出跑一遍 NeoDB 的解析逻辑（或任何读豆伴格式的工具），各 sheet 条数与 JSON 一致。

## 5. 豆伴的其他功能

豆伴有 13 项备份，另外记录每条标记的修改历史：

| 功能 | 本脚本 |
| --- | --- |
| 影 / 音 / 书 / 游 / 剧标记 | v1 |
| 广播、评论（长评）、日记、笔记（读书笔记） | v2：个人写作，统一导 JSON（广播没有现成表格格式） |
| 标记的修改历史 | 不做：导出是快照，比较两份导出即可 |
| 豆列、相册、豆邮、留言板、关注 / 被关注、黑名单、图片同步、迁移到另一账号 | 不做 |

v2 另有两项候选：封面 ZIP（byJming 已有）；Letterboxd（电影）与 Goodreads（书）导入用 CSV。

## 5.1 路线（2026-10-23 定）

- **v1：** 五类标记（含私密）导出为 JSON 与豆伴 xlsx；与 `total` 核对；遇安全验证暂停、可续跑（§3）
- **v1.1：消失的标记与提醒。** 每次导出后在 `GM_setValue` 存一份摘要（每条标记的 id 与内容指纹：状态、评分、短评、标签的哈希，不存全文）。下次导出与它比较，给出新增、改过、消失三类；消失的条目从本次未出现的 id 里列出，标题与短评取自用户选择的上一份 JSON（摘要里没有全文）。比较结果写进导出文件的 `meta.diff`，并在完成时显示。另可手动选一份旧 JSON 与本次比较。距上次导出超过设定天数（默认 30）时，在豆瓣页面角落提示一次，不自动运行
- **v2：** 个人写作（广播、长评、日记、读书笔记，JSON）；Obsidian / Markdown 导出（每部作品一篇笔记，YAML 头含评分、标签、标记时间、链接，正文为短评，fflate 打包 ZIP）；离线浏览页（单个 HTML 文件，数据内嵌，可搜索、按类别与评分筛选，无外部依赖）；封面 ZIP；Letterboxd / Goodreads CSV

- **发布后，不急：** 宣传页（豆伴有 doufen.org）：为什么要备份、安装、隐私（数据只在本机）、导出文件怎么用、Greasy Fork 打不开时的备用安装链接。v2 的离线浏览、两份导出的比较、格式转换可放到同一站点，纯前端、不上传

不做：年度统计、口味分析（留给专门的工具，这里只管导出）。

## 6. 构建顺序

1. 跑 §2.1 与 §2.2，结果写回 §2；§2.1 不成立则停，§2.2 不成立则按方案 B
2. 翻页、停止规则、暂停续跑、JSON 导出（测试覆盖翻页、`code` 停止、安全验证暂停与续跑、取消）
3. xlsx 导出（测试覆盖行转换；用真实导出验收 §4）
4. README、`GREASYFORK-DESCRIPTION.md`、仓库 `CLAUDE.md` 与 `README.md` 的脚本表，发布 Greasy Fork

## 7. 待定

- [x] 范围与路线（§5.1，2026-10-23）
- [x] 名字（2026-10-23）：豆仓，英文 Douban Archive，目录 `douban-archive`；Greasy Fork 标题"豆仓：豆瓣书影音标记与个人内容备份（含私密）"
