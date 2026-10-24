# 豆仓（Douban Archive）：计划

Status: v0.7，2026-10-24 界面实跑通过（v0.3.0）；进行 §6 第 4 步（文档与发布）。

## 1. 目标

在已登录豆瓣的浏览器里，导出自己的全部书影音游戏舞台剧标记，**含私密标记**，下载为：

- **JSON：** 接口返回的原始条目，原样保存
- **NeoDB CSV（zip）：** NeoDB 自己的导出格式，可直接导入 NeoDB（见 §4）；纯文本，不用 xlsx（2026-10-23 定，原计划的豆伴 xlsx 作废）

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

本脚本的不同：Rexxar JSON 后台翻页（每页 50 条，请求约为翻网页的三分之一，网页改版不受影响）；按 `is_private` 标出私密；五类 × 三状态一次导完；NeoDB CSV；与 `total` 核对。

## 2. 数据来源

豆伴读标记用 Rexxar（m.douban.com 背后的接口，见豆伴 `extension/tasks/interest.js`）：

```
https://m.douban.com/rexxar/api/v2/user/{uid}/interests?type={type}&status={status}&start={start}&count=50&ck={ck}&for_mobile=1
```

带登录 cookie，`ck` 取自同名 cookie；豆伴另设 `X-Override-Referer: https://m.douban.com/mine/`。

**动手前在 Tampermonkey 里临时装 §2.1 的探针**，在已登录的 www.douban.com 页面点菜单"豆仓探针"。取数方式与正式脚本相同（www 上 `GM_xmlhttpRequest` 跨域），只打印计数与字段名，不打印标题和短评。确认：

1. 跨域请求能拿到数据（带 cookie），`ck` 能从 `document.cookie` 读到；记下不设 Referer、设 `Referer`、设 `X-Override-Referer` 三种里哪些成功
2. `total` 与豆瓣个人主页上该书架显示的数字一致
3. 私密条目在返回里，且带 `is_private: true`
4. 条目与 `subject` 的字段（标题、评分、短评、标签、标记时间、链接）都在

1 不成立就退回方案 B（§3）；2–4 任何一条不成立就回到这里重新设计。测完删掉探针。

**2、4 的结果（2026-10-23，14 个书架各取第一页）：** 全部 200、无 `code`。

- 2 成立：书 2001 / 277 / 1014、影 1728 / 55 / 2522、音 103 / 21 / 876（想 / 在 / 过）与个人主页一致；游戏（430 / 64 / 183）与舞台剧（6 / 23）未对照
- 4 成立：条目字段 `charts comment create_time id is_editable is_private platforms rating sharing_text sharing_url status subject tags vote_count`；`subject` 含 `title url uri id type subtype cover_url pic rating year pubdate author press directors actors singer genres cn_name platforms` 等 44 个，各类别字段不同
- uid：www 页面上 `/people/` 链接有 31 个（首页动态里的别人），自己的 `lzblack` 混在其中，§3 读 uid 不能取第一个，要认导航栏"我的豆瓣"
- 3 待定：`is_private` 字段存在，但 14 个书架第一页私密数都为 0；用户的私密标记在电影里，用探针第二个命令把电影翻到底再判

**电影翻到底（2026-10-23，www 上 GM 跨域，带 Referer）：** 第 3 条不成立，且发现新问题。

| 书架 | total | 取到 | 私密 | 不足 50 条的中间页 | 错误 |
| --- | --- | --- | --- | --- | --- |
| 想看 | 1728 | 1582 | 0 | start=300/350/500/550/700/750/900/950/1200，每页 28–37 条 | 无 |
| 在看 | 55 | 55 | 0 | 无 | 无 |
| 看过 | 2522 | 150 | 0 | 无 | start=200 超时（15 秒），约连续第 40 个请求 |

两种解释：(a) 服务端没把请求当本人（GM 跨域没带上登录身份，或用户名 uid 被当作他人视角），私密被滤掉、页变短；(b) 缺的是已下架条目。§2.2 的身份探针用一页（想看 start=300）分辨：`is_editable` 是否为真、m 站同源 `fetch` 是否返回 50 条、数字 id 与用户名结果是否相同。都显示本人视角才考虑 (b)，再拿同区间的网页版列表比对缺的 id。(a) 成立则方案 C 不成立，回到方案 B。

**身份探针（2026-10-23，想看 start=300，同一页）：**

| 方式 | 本页条数 | `is_editable` | 私密 |
| --- | --- | --- | --- |
| www GM 跨域，用户名 `lzblack` | 34（翻到底时同一页 37） | 34 | 0 |
| www GM 跨域，数字 id（`/rexxar/api/v2/user/lzblack` 返回的 `id`） | 50 | 50 | 0 |
| m 站同源 `fetch`，用户名 | 50 | 50 | 0 |

- 三种都是本人视角，GM 跨域带上了登录身份，方案 C 成立
- ~~只有"GM 跨域 + 用户名"漏条~~ 撤回：只有一次采样，下面用数字 id 翻到底同样漏条
- 私密仍未见到；用数字 id 把电影翻到底（`fetched` 应等于 `total`）再判第 3 条

**第 3 条（2026-10-23）：** 成立。用户新加一条私密"想看"后，GM 跨域 + 数字 id 取想看第一页：`private: 1`，`subject.id` 为新加的那部（37068446）。但 `total` 仍为 1728（加之前也是 1728）：`total` 可能不含私密，或有缓存。翻页停止不能依赖 `total`，翻到空页才停；`total` 只用于核对，用翻到底的 `fetched` 与 `total` 的差判断是哪种。个人主页"想看"也显示 1728。

**数字 id 翻到底（2026-10-23，翻到空页才停）：**

| 书架 | total | 取到 | 私密 | 不足 50 条的中间页 |
| --- | --- | --- | --- | --- |
| 想看 | 1728 | 1680 | 1 | start=550（31）、950（28）、1100（43） |
| 在看 | 55 | 55 | 0 | 无 |
| 看过 | 2522（最后一次响应为 0） | 288 | 3 | start=200（38）；约 start=300 返回空页且 `total: 0`，被当成结束 |

- 漏条与 uid 形式无关，位置每次不同（上一轮用户名漏在 300/350/500/…），像是服务端随机丢条目
- 会出现 200、空页、`total: 0` 的异常响应，不能当作"翻完"
- 豆伴（`extension/tasks/interest.js`）按 `ceil(total / 50)` 翻页，仅对 HTTP 500 拆成 `count=1` 重取，对短页不处理，可能同样漏条
- 下一步：同一短页重复请求几次，看缺的条目能否补回（§2.1"重复取同一页"）

**重复取同一页（2026-10-23，每次间隔 3 秒）：** 想看 start=550 五次：34、50、50、50、50 条，id 并集 50；看过 start=300 两次都是 50 条（`total` 2523，用户期间多标了一条）。

- 丢条是暂时的，重取能补回；像是一页第一次被请求时服务端没查全（身份探针里排第一个的请求也是唯一短的那个），未直接证实
- 200 + 空页 + `total: 0` 也是暂时的，重取正常

**第 1 步结论：** 四条都成立（2 只对照了书影音），方案 C 成立，uid 用数字 id 或用户名都可以（脚本用 `/rexxar/api/v2/user/{用户名}` 读出数字 id）。与原设计不同的三点已改进 §3：短页与空页要重取；~~`total` 很可能不含私密~~（被下方全量导出推翻：`total` 含私密）；翻页停止不依赖 `total`。

**第 2 步实跑（2026-10-23，v0.1.0，Firefox + Tampermonkey，www）：** 14 个书架全部 取到 = `total`，首末 `total` 无变化，无异常页；共 9304 条，id 全部唯一；私密 6 条（书读过 1、影想看 1 即测试条目 37068446、影看过 4），都带 `is_private: true`。

- `total` **含**私密：读过 1014、想看 1728、看过 2523 三个有私密的书架都是 取到 = `total`。v0.1.0 按"取到 − 私密 = total"核对，误报这三个书架对不上，v0.1.1 改为 取到 = `total`
- 文件 24 MB；耗时约 21 分钟（02:29–02:50 UTC），是 §3 估计的三倍
- blob 下载在 Tampermonkey 沙箱里正常

**v0.3.0 实跑（2026-10-24，同一浏览器，首页侧栏入口）：** 14 个书架全部一致，9304 条，id 集合与 v0.1.0 那次完全相同（新的"取到 total 即停"没有漏条）；约 18 分钟（03:33–03:51 UTC，v0.1.0 约 21 分钟）；两个文件都下载成功，zip 6 个成员、`testzip` 通过。完成卡片显示正常。

**第 1 条结果（2026-10-23，Firefox + Tampermonkey，www 首页，`type=book&status=mark`，探针的上一版）：** 成立，用方案 C。

| 请求头 | 结果 |
| --- | --- |
| 不设 | 400，`code: 1287`，`msg: invalid_request_1284` |
| `Referer: https://m.douban.com/mine/` | 200，`total: 2001`，本页 50 条 |
| `X-Override-Referer: https://m.douban.com/mine/` | 400，同上 |

- Rexxar 校验 Referer；Tampermonkey 的 `GM_xmlhttpRequest` 能设 `Referer`。`X-Override-Referer` 是豆伴扩展内部改写 Referer 用的，豆瓣不认
- 跨子域请求带上了登录身份：200 本身不能证明（公开标记不登录也能读），由下方身份探针的 `is_editable` 全为真证明；`ck` 能从 www 的 `document.cookie` 读到
- uid：用户名与数字 id 都能用；"用户名会漏条"的判断已撤回（见下方翻到底结果）

### 2.1 探针（临时脚本，不进仓库）

每个书架只取第一页（14 次请求，约 30 秒），都带 `Referer`：`total` 对照个人主页的数字，私密与字段名在全部书架里找。另打印页面上能找到的 uid 候选，供 §3 自动读 uid。

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
  const get = url => new Promise(resolve => GM_xmlhttpRequest({
    method: 'GET', url, headers: { Referer: 'https://m.douban.com/mine/' }, anonymous: false, timeout: 15000,
    onload: r => resolve(r),
    onerror: e => resolve({ status: 'error', error: String(e && e.error) }),
    ontimeout: () => resolve({ status: 'timeout' }),
    onabort: () => resolve({ status: 'abort' }),
  }));
  GM_registerMenuCommand('豆仓探针', async () => {
    alert('豆仓探针：开始（约 30 秒，完成时会再弹窗）');
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    const uidCandidates = [...new Set([...document.querySelectorAll('a[href*="/people/"]')]
      .map(a => (a.href.match(/\/people\/([^/?#]+)/) || [])[1]).filter(Boolean))];
    const shelves = [];
    const keys = new Set(), subjectKeys = new Set();
    let sawPrivateKey = false;
    outer: for (const type of ['book', 'movie', 'music', 'game', 'drama']) {
      for (const status of type === 'drama' ? ['mark', 'done'] : ['mark', 'doing', 'done']) {
        console.log(`豆仓探针：${type} ${status}`);
        const r = await get(`https://m.douban.com/rexxar/api/v2/user/${UID}/interests?type=${type}&status=${status}&start=0&count=50&ck=${ck}&for_mobile=1`);
        let j;
        try { j = JSON.parse(r.responseText); } catch {
          shelves.push({ type, status, http: r.status, finalUrl: r.finalUrl, notJson: String(r.responseText || r.error || '').slice(0, 80) });
          break outer;
        }
        const rows = j.interests || [];
        for (const i of rows) {
          Object.keys(i).forEach(k => keys.add(k));
          Object.keys(i.subject || {}).forEach(k => subjectKeys.add(k));
          if ('is_private' in i) sawPrivateKey = true;
        }
        shelves.push({ type, status, http: r.status, code: j.code, msg: j.msg, total: j.total, page: rows.length, private: rows.filter(i => i.is_private).length });
        await new Promise(s => setTimeout(s, 2000));
      }
    }
    console.table(shelves);
    console.log({ ckFound: !!ck, uidCandidates, sawPrivateKey, keys: [...keys], subjectKeys: [...subjectKeys] });
    alert('豆仓探针：完成，结果在控制台');
  });
  // 第 3 条：电影三个书架翻到底，只数条数与私密
  GM_registerMenuCommand('豆仓探针：电影翻到底', async () => {
    alert('豆仓探针：开始翻电影（约 3 分钟，完成时会再弹窗）');
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    let numericId;
    try { numericId = JSON.parse((await get(`https://m.douban.com/rexxar/api/v2/user/${UID}?ck=${ck}&for_mobile=1`)).responseText).id; } catch { /* 下面停止 */ }
    if (!numericId) { alert('豆仓探针：读不到数字 id'); return; }
    await new Promise(s => setTimeout(s, 2000));
    const shelves = [];
    for (const status of ['mark', 'doing', 'done']) {
      let total, fetched = 0, priv = 0, shortPages = [], error;
      // 翻到空页才停，不按 total（total 可能不含私密）
      for (let start = 0; start < 20000; start += 50) {
        console.log(`豆仓探针：movie ${status} start=${start}`);
        const r = await get(`https://m.douban.com/rexxar/api/v2/user/${numericId}/interests?type=movie&status=${status}&start=${start}&count=50&ck=${ck}&for_mobile=1`);
        let j;
        try { j = JSON.parse(r.responseText); } catch { error = { http: r.status, finalUrl: r.finalUrl }; break; }
        if (r.status !== 200 || j.code) { error = { http: r.status, code: j.code, msg: j.msg }; break; }
        const rows = j.interests || [];
        total = j.total;
        if (rows.length === 0) break;
        fetched += rows.length;
        priv += rows.filter(i => i.is_private).length;
        if (rows.length < 50 && start + 50 < total) shortPages.push({ start, page: rows.length });
        await new Promise(s => setTimeout(s, 2000));
      }
      shelves.push({ numericId, status, total, fetched, private: priv, shortPages: JSON.stringify(shortPages), error: error && JSON.stringify(error) });
      if (error) break;
    }
    console.table(shelves);
    alert('豆仓探针：电影翻到底完成，结果在控制台');
  });
  // 第 3 条快测：新加的私密标记在想看第一页
  GM_registerMenuCommand('豆仓探针：想看第一页', async () => {
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    let numericId;
    try { numericId = JSON.parse((await get(`https://m.douban.com/rexxar/api/v2/user/${UID}?ck=${ck}&for_mobile=1`)).responseText).id; } catch { /* 下面停止 */ }
    if (!numericId) { alert('豆仓探针：读不到数字 id'); return; }
    await new Promise(s => setTimeout(s, 2000));
    const r = await get(`https://m.douban.com/rexxar/api/v2/user/${numericId}/interests?type=movie&status=mark&start=0&count=50&ck=${ck}&for_mobile=1`);
    let j;
    try { j = JSON.parse(r.responseText); } catch { alert(`豆仓探针：不是 JSON，http ${r.status}`); return; }
    const rows = j.interests || [];
    const result = { http: r.status, code: j.code, total: j.total, page: rows.length,
      private: rows.filter(i => i.is_private).length,
      privateSubjectIds: rows.filter(i => i.is_private).map(i => i.subject && i.subject.id) };
    console.log(result);
    alert(`豆仓探针：${JSON.stringify(result)}`);
  });
  // 漏条是否随机：同一页重复取 5 次，比较条数与 id 并集；再看看过 start=300 是否仍返回空
  GM_registerMenuCommand('豆仓探针：重复取同一页', async () => {
    alert('豆仓探针：开始重复取（约 30 秒，完成时会再弹窗）');
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    let numericId;
    try { numericId = JSON.parse((await get(`https://m.douban.com/rexxar/api/v2/user/${UID}?ck=${ck}&for_mobile=1`)).responseText).id; } catch { /* 下面停止 */ }
    if (!numericId) { alert('豆仓探针：读不到数字 id'); return; }
    const url = (status, start) => `https://m.douban.com/rexxar/api/v2/user/${numericId}/interests?type=movie&status=${status}&start=${start}&count=50&ck=${ck}&for_mobile=1`;
    const runs = [];
    const union = new Set();
    for (const [status, start, times] of [['mark', 550, 5], ['done', 300, 2]]) {
      for (let k = 0; k < times; k++) {
        await new Promise(s => setTimeout(s, 3000));
        const r = await get(url(status, start));
        let j;
        try { j = JSON.parse(r.responseText); } catch { runs.push({ status, start, http: r.status, notJson: true }); continue; }
        const ids = (j.interests || []).map(i => i.id);
        if (status === 'mark') ids.forEach(id => union.add(id));
        runs.push({ status, start, http: r.status, code: j.code, total: j.total, page: ids.length });
      }
    }
    console.table(runs);
    console.log({ markStart550Union: union.size });
    alert(`豆仓探针：${JSON.stringify({ runs: runs.map(x => `${x.status}@${x.start}:${x.page}/${x.total}`), markStart550Union: union.size })}`);
  });
  // §2.2：同一页（想看 start=300）比较用户名与数字 id，看是不是本人视角
  GM_registerMenuCommand('豆仓探针：身份', async () => {
    alert('豆仓探针：开始查身份（约 10 秒，完成时会再弹窗）');
    const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
    const summarize = (label, r) => {
      let j;
      try { j = JSON.parse(r.responseText); } catch { return { label, http: r.status, finalUrl: r.finalUrl }; }
      const rows = j.interests || [];
      return { label, http: r.status, code: j.code, total: j.total, page: rows.length,
        editable: rows.filter(i => i.is_editable).length, private: rows.filter(i => i.is_private).length };
    };
    const me = await get(`https://m.douban.com/rexxar/api/v2/user/${UID}?ck=${ck}&for_mobile=1`);
    let numericId;
    try { numericId = JSON.parse(me.responseText).id; } catch { /* 下面会显示 undefined */ }
    const page = id => `https://m.douban.com/rexxar/api/v2/user/${id}/interests?type=movie&status=mark&start=300&count=50&ck=${ck}&for_mobile=1`;
    const results = [summarize('username', await get(page(UID)))];
    await new Promise(s => setTimeout(s, 2000));
    if (numericId) results.push(summarize('numericId', await get(page(numericId))));
    console.table(results);
    console.log({ meHttp: me.status, numericId });
    alert('豆仓探针：身份完成，结果在控制台');
  });
})();
```

### 2.2 m 站同源对照（控制台，不进仓库）

在已登录的 `https://m.douban.com/mine/` 控制台跑，与 §2.1 "身份"命令请求同一页：

```js
(async () => {
  const ck = (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1];
  const r = await fetch(`/rexxar/api/v2/user/lzblack/interests?type=movie&status=mark&start=300&count=50&ck=${ck}&for_mobile=1`, { credentials: 'include' });
  const j = await r.json();
  const rows = j.interests || [];
  console.log({ http: r.status, code: j.code, total: j.total, page: rows.length,
    editable: rows.filter(i => i.is_editable).length, private: rows.filter(i => i.is_private).length });
})();
```

## 3. 脚本

单文件 IIFE、纯 JS、无构建，照仓库 `CLAUDE.md`；纯逻辑（翻页、停止、行转换）用 `node --test` 测，fixture 用合成数据。中文界面。

- **运行位置（方案 C，§2 已证实）：** `@match https://www.douban.com/*`，用 `GM_xmlhttpRequest` 跨域请求 Rexxar（`@connect m.douban.com`），每个请求带 `Referer: https://m.douban.com/mine/`（不带返回 400），超时 15 秒。（未用的退路方案 B：同时 `@match https://m.douban.com/mine/*`，www 上的命令打开 m 站页面，在那里同源 `fetch`）
- **触发：** 只手动，不自动运行。两个入口：Tampermonkey 菜单"导出全部标记"（一直在）；首页（`www.douban.com/`，登录后）侧栏 `.aside` 最上面插一块豆瓣侧栏样式的模块（2026-10-23 定，按草图）。侧栏模块只在该出现时出现：从没导出过；或用户开启了定期提醒且距上次导出 ≥ 30 天。模块上 ✕ 让它 30 天内不再出现。导出完成后模块消失（很多人只导一次）
- **定期提醒（默认关）：** 完成卡片里一个按钮"每 30 天提醒我"开启；菜单"开启 / 关闭定期提醒"随时改。上次导出时间、提醒开关、✕ 的暂停期存在 `dacfg:` 前缀的键里，不随导出缓存清除
- **uid：** 同源请求 `/mine/`，从跳转后的 `/people/{用户名}/` 读出用户名（2026-10-23 实测 200 并跳到本人主页），再用 `/rexxar/api/v2/user/{用户名}` 换出数字 id，列表请求用数字 id。任何一步读不到就提示并停止，不让用户填
- **范围：** 书、影、音、游戏、舞台剧 × 想 / 在 / 过（舞台剧没有"在"），按请求的 `count` 翻页，不按返回条数
- **短页与空页（§2 实测服务端会暂时丢条）：** `total` 含私密（§2 全量导出证实），所以一页取到 `total` 就是取全了：短页且 `start` + 条数 ≥ `total`，或整页且正好等于 `total`，即为末页，不重取、不再请求空页（2026-10-23 改，每个书架省约 4 次请求，账号小的用户尤其明显）。整页却超过 `total` 说明 `total` 偏小（导出中途新加了标记），继续翻。没到 `total` 的短页或空页重取，最多 3 次、间隔照常，按条目 `id` 合并；`total: 0` 的空页（§2 见过的暂时异常，也可能是真的空书架）照常重取，重取用完仍空则 `start` ≥ 本书架见过的最大 `total` 时停，否则记为异常、翻下一页。重取用完仍短、又不在末尾的页记进 `meta`
- **节奏与风控：** 用的是用户自己的登录账号。串行，每次请求间隔 2 秒（实测 9304 条约 21 分钟，其中约 56 次是旧规则下末页的重取与空页，v0.3.0 起省掉；每次请求连同接口耗时约 5.2 秒）。除短页与空页外不重试
- **暂停与续跑：** 响应不是 JSON（安全验证跳转多半表现为这个）、网络错误、超时、中止时暂停，提示用户在新标签页打开豆瓣、完成可能的安全验证后点"继续"，从断点那一页重新取；跳转到 `sec.douban.com` 走 `GM_xmlhttpRequest` 时具体表现未实测，所以凡不是"200 + JSON"或"带 `code` 的 JSON"一律按暂停处理。响应体带 `code`（或 JSON 但非 200）时停止整次导出，不下载（半份数据容易被当成全量），但已取的页同样保留，"继续"可以再试（2026-10-23 定：不认识的限流码不该清掉几分钟的进度）
- **进度存储：** 每取完一页写一个 `GM_setValue` 键（该页按 `id` 合并后的原始条目），另有一个小的进度键（当前书架、`start`、各书架见过的 `total`、异常、时间戳）；只在页边界存档，中断的那页续跑时重取。不反复重写一个越来越大的值。取消、放弃、用户确认文件已保存（点"完成"）、或进度超过 24 小时时删除全部这些键（`GM_listValues` / `GM_deleteValue`）。下载后不立即删：沙箱里的 blob 下载未实测，留着可以"再下载一次"

- **界面（右下角卡片，不用模态框：导出约 20 分钟，期间可以看别的）：** 开始前（总条数、预计耗时、保持标签页打开、两个文件的用途、数据只在本机）；导出中（总进度条、当前书架与第几个 / 14、预计剩余时间、取消）；暂停（原因、怎么做、继续 / 打开豆瓣 / 放弃）；完成（各类各书架条数、对不上的书架标出、NeoDB 导入要选"仅自己"的提醒、再下载一次 / 完成）。豆瓣配色，无 UI 框架。总条数用豆伴的不带类型请求 `interests?count=1` 取（未实测）；取不到就不显示总数与进度条，只显示条数
- **校验：** 每个书架取完后按 `id` 去重，比较取到的条数与 `total`（`total` 含私密，§2 第 2 步实跑证实）。`meta` 按书架记原始数字：首次与最后一次见到的 `total`、去重后条数、私密条数、是否一致、异常页；导出中途增删标记会让 `total` 变化、页错位，靠首末 `total` 看出来。不一致在完成时提示
- **输出文件名：** `douban-archive-<uid>-<日期>.json` 与 `douban-archive-<uid>-<日期>-neodb.zip`，分两个文件下载（JSON 约 24 MB，NeoDB 网站的上传大小限制未知，zip 只放 CSV）

## 4. NeoDB CSV 格式

2026-10-23 读 NeoDB 源码定（`neodb/journal/importers/csv.py`、`base.py`、`exporters/csv.py`）。NeoDB 支持十几种导入格式（豆伴 xlsx、Goodreads、Letterboxd、Steam、Trakt 等，还有它自己的 CSV 与 NDJSON）；选它自己的 CSV，因为纯文本、不需要 xlsx 库，且以链接定位条目，豆瓣链接本地没有时会远程抓取（`get_item_by_info_and_links`）。

- **zip 结构：** 成员名 `{category}_mark.csv`，NeoDB 只读这些名字（`_CSV_MEMBER_NAMES`）。category 按条目的 `subject.type`，不按书架：`book` `movie` `tv` `music` `game`，舞台剧 `drama` → `performance`（用户实测的电影书架里有 tv 条目 947 条）。不压缩（store），手写，无外部依赖；NeoDB 解压上限 512 MB
- **列（表头照 NeoDB 导出）：** `title, info, links, timestamp, status, rating, comment, tags`，另加一列 `visibility`
  - `title`：`subject.title`
  - `info`：空（豆瓣列表接口的 `subject` 不含 ISBN / IMDb）
  - `links`：`subject.url`（如 `https://movie.douban.com/subject/…/`、游戏 `https://www.douban.com/game/…/`、舞台剧 `https://www.douban.com/location/drama/…/`）
  - `timestamp`：`create_time` 是北京时间 `YYYY-MM-DD HH:MM:SS`，写成 `YYYY-MM-DDTHH:MM:SS+08:00`（NeoDB 对无时区的按 UTC 解析）
  - `status`：想 / 在 / 过 → `wishlist` / `progress` / `complete`
  - `rating`：`rating.value`（1–5，`max` 实测都是 5）× 2，无评分留空
  - `comment`：短评；`tags`：`|` 连接（实测标签里没有 `|`，有则替换为空格）
  - `visibility`：私密写 `2`（仅自己），其他留空。NeoDB 现在按整批导入设置可见性，不读这一列（`DictReader` 多出的列被忽略），给计划中的 NeoDB PR 用
- **编码：** UTF-8 无 BOM（BOM 会让 NeoDB 读到的第一列名不是 `title`）；RFC 4180 引号转义，短评里的换行与引号保留
- **私密：** 在 NeoDB 加上逐条可见性之前，导入时整批选可见性；选"公开"会把私密条目公开。完成提示与 README 要写明
- **NeoDB PR（第 3 步验收后再提）：** CSV 导入器读可选的 `visibility` 列，逐条设可见性，缺省沿用整批设置

验收：按 NeoDB `CsvImporter` 的读法（`validate_file` 的成员名检查、`csv.DictReader`、`parse_shelf_type`、`parse_tags`、`parse_datetime`、`int(float(rating))`）用 Python 解析真实导出的 zip，各类条数之和与 JSON 一致、每行字段解析成功；能的话在 NeoDB 上真实导入一次（选"仅自己"）。

**验收结果（2026-10-23，v0.2.0 的生成函数跑 2026-10-23 的真实 JSON）：** zip 1.1 MB，6 个成员（book 3292、movie 3359、tv 947、music 1000、game 677、performance 29），`zipfile.testzip()` 通过；按上面的读法 9304 行全部解析成功，与 JSON 条数一致，评分 3753 条都在 2–10，时间都带时区，私密 6 条 `visibility` 为 2；标题、短评（含 3 条带换行的）、标签按"链接 + 状态"逐条比对 9304 条全部原样读回。未做：在 NeoDB 上真实导入。

Greasy Fork 规则（2026-10-23 核对 code-rules、external-scripts、cdns）：代码不得混淆或压缩；本脚本无外部库。不发数据给作者，不涉及 `@antifeature`。

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

- **v1：** 五类标记（含私密）导出为 JSON 与 NeoDB CSV；与 `total` 核对；遇安全验证暂停、可续跑（§3）
- **v1.1：消失的标记。** 每次导出后在 `GM_setValue` 存一份摘要（每条标记的 id 与内容指纹：状态、评分、短评、标签的哈希，不存全文）。下次导出与它比较，给出新增、改过、消失三类；消失的条目从本次未出现的 id 里列出，标题与短评取自用户选择的上一份 JSON（摘要里没有全文）。比较结果写进导出文件的 `meta.diff`，并在完成时显示。另可手动选一份旧 JSON 与本次比较。（提醒部分已并入 v1，见 §3"定期提醒"）
- **v2：** 个人写作（广播、长评、日记、读书笔记，JSON）；Obsidian / Markdown 导出（每部作品一篇笔记，YAML 头含评分、标签、标记时间、链接，正文为短评，fflate 打包 ZIP）；离线浏览页（单个 HTML 文件，数据内嵌，可搜索、按类别与评分筛选，无外部依赖）；封面 ZIP；Letterboxd / Goodreads CSV

- **发布后，不急：** 宣传页（豆伴有 doufen.org）：为什么要备份、安装、隐私（数据只在本机）、导出文件怎么用、Greasy Fork 打不开时的备用安装链接。v2 的离线浏览、两份导出的比较、格式转换可放到同一站点，纯前端、不上传

不做：年度统计、口味分析（留给专门的工具，这里只管导出）。

## 6. 构建顺序

1. 跑 §2.1 的探针，结果写回 §2；第 1 条不成立则按方案 B，2–4 不成立则停
2. 翻页、停止规则、暂停续跑、JSON 导出（测试覆盖翻页、`code` 停止、安全验证暂停与续跑、取消）
3. NeoDB CSV 导出（测试覆盖行转换、CSV 转义、zip 结构；用真实导出验收 §4）
4. README、`GREASYFORK-DESCRIPTION.md`、仓库 `CLAUDE.md` 与 `README.md` 的脚本表，发布 Greasy Fork

## 7. 待定

- [x] 范围与路线（§5.1，2026-10-23）
- [x] 名字（2026-10-23）：豆仓，英文 Douban Archive，目录 `douban-archive`；Greasy Fork 标题"豆仓：豆瓣书影音标记与个人内容备份（含私密）"
