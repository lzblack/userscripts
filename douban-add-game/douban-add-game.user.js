// ==UserScript==
// @name         豆瓣一键添游戏 | One-Click Add Game to Douban
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @supportURL   https://github.com/lzblack/userscripts/issues
// @version      1.0.0
// @author       lzblack
// @description  在 Steam 商店页查豆瓣是否已收录该游戏；未收录则一键跳转「创建游戏条目」、自动回填全字段并注入封面。人工只审核和提交。
// @match        https://store.steampowered.com/app/*
// @match        https://www.douban.com/game/create*
// @connect      store.steampowered.com
// @connect      www.douban.com
// @connect      shared.akamai.steamstatic.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @icon         https://img3.doubanio.com/favicon.ico
// @icon64       https://img3.doubanio.com/favicon.ico
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-add-game/douban-add-game.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-add-game/douban-add-game.user.js
// ==/UserScript==

(function () {
  'use strict';

  /** null/undefined 安全的 String()——全脚本统一用它收口空值。 */
  const str = (v) => String(v == null ? '' : v);

  // ============================================================
  // 纯函数解析层 — 无 DOM/网络副作用（见 douban-add-game.test.js）
  // ============================================================

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  /**
   * 建条目页（/game/create 第二步）的「类型」全表，共 19 项。
   * 比 /game/explore 筛选器上的 15 项多出 卡牌 / 大型多人在线 / 光枪射击 / 文字冒险，
   * 所以 explore 的那套 id 对建条目页不作数——回填一律按标签文本匹配复选框。
   */
  const DOUBAN_GENRES = [
    '动作', '策略', '体育', '冒险', '角色扮演', '竞速', '模拟', '格斗', '射击', '即时战略',
    '卡牌', '大型多人在线', '益智', '音乐/旋律', '第一人称射击', '光枪射击', '文字冒险',
    '乱斗/清版', '横版过关',
  ];

  /**
   * Steam genre id → 豆瓣「类型」名。
   * 按 **id** 映射而非文案：实测同一 app 的 genre id 跨 l=schinese / l=english 稳定，
   * 只有 description 变（2358720 两种语言均为 1/25/3）。
   * Steam 的 4 休闲 / 23 独立 / 37 免费开玩 / 70 抢先体验在豆瓣没有落点——
   * 一律进 unmapped 让人工补，不猜。
   */
  const GENRE_MAP = {
    1: '动作',
    2: '策略',
    3: '角色扮演',
    9: '竞速',
    18: '体育',
    25: '冒险',
    28: '模拟',
    29: '大型多人在线',
  };

  /** Steam 只能确知这三个平台；主机平台无从得知，留空由人工补。名称与建条目页复选框一致。 */
  const PLATFORM_MAP = [
    ['windows', 'PC'],
    ['mac', 'Mac'],
    ['linux', 'Linux'],
  ];

  /**
   * 豆瓣建条目页的字段标签（DOM 执行器按这些文本定位控件），取自登录态实拍。
   * 第一步「基本资料」只收一个名字然后由豆瓣自己查重；第二步「详细资料」就是下面这些。
   * 要点：名称（原文）与中文名称是**两个分开的字段**，没有「别名」；日期只有一个
   * 「发售时间」（提示语写明未发售就填预计时间，不像条目展示页分成
   * 「发行日期 / 预计上市时间」两栏）；图标上传也在这一页，封面无需跨页交接。
   */
  const FIELD = {
    titleOriginal: '名称',
    title: '中文名称',
    description: '简介',
    date: '发售时间',
    genres: '类型',
    platforms: '平台',
  };

  /**
   * Steam 有、但建条目页两步都收不下的字段——只能等条目建成后去条目编辑页补。
   * 不放进回填计划，改为单独列给用户，免得「已填」列表骗人。
   */
  const MANUAL_FIELD = [
    ['developers', '开发商'],
    ['publishers', '发行商'],
    ['website', '官方网站'],
  ];

  /** 从 Steam 路径取 appid；年龄门页 /agecheck/app/{id}/ 同样命中，故无需特判。 */
  function parseAppId(pathname) {
    const m = str(pathname).match(/\/app\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  /** 解析 "Sep 17, 2020" / "Aug 2024" / "2026" → {y,m,d}（缺位为 null）；无年份返回 null。 */
  function parseDate(input) {
    const s = str(input).trim();
    const ym = s.match(/([A-Za-z]{3,})[^0-9A-Za-z]+(?:(\d{1,2})[^0-9A-Za-z]+)?(\d{4})/);
    if (ym) {
      const mon = MONTHS[ym[1].slice(0, 3).toLowerCase()];
      if (mon) {
        return { y: Number(ym[3]), m: mon, d: ym[2] ? Number(ym[2]) : null };
      }
    }
    const yOnly = s.match(/\b(\d{4})\b/);
    if (yOnly) return { y: Number(yOnly[1]), m: null, d: null };
    return null;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  /** 解 HTML 实体（数字型 + 常见命名型）；&amp; 最后解，避免二次解码。 */
  function decodeEntities(input) {
    return str(input)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&(lt|gt|quot|apos|nbsp);/g, (_, n) => ENTITIES[n])
      .replace(/&amp;/g, '&');
  }

  const DROP_TAGS_RE = /<(script|style|video|audio|iframe|noscript)\b[\s\S]*?<\/\1\s*>/gi;
  const BLOCK_TAGS_RE = /<\/?(p|div|h[1-6]|ul|ol|table|tr|blockquote|section)\b[^>]*>/gi;

  /**
   * Steam 的 about_the_game / short_description 是富文本 HTML（bb_tag 小标题、
   * bb_ul 列表、内嵌 video/img）。这里做纯正则转纯文本——刻意不用 DOMParser，
   * 好让这一层能在 node 里单测。
   */
  function htmlToText(input) {
    let s = str(input);
    if (!s) return '';
    s = s.replace(DROP_TAGS_RE, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n· ').replace(/<\/li\s*>/gi, '\n');
    s = s.replace(BLOCK_TAGS_RE, '\n');
    s = s.replace(/<[^>]*>/g, ''); // 余下的 inline 标签（strong/span/a/img…）直接摘掉
    s = decodeEntities(s);
    return s
      .replace(/[^\S\n]+/g, ' ')
      .split('\n').map((l) => l.trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 拉丁路归一（&→and、小写、只留 a-z0-9）；中文字符会被剥掉，故只用于英文名比对。 */
  function normalizeLatin(input) {
    return str(input).replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** 中文路归一（只留 CJK 统一表意文字）。 */
  function normalizeCjk(input) {
    return str(input).replace(/[^一-鿿]/g, '');
  }

  const HAS_CJK_RE = /[一-鿿]/;

  /**
   * 剥掉整对包住标题的书名号——Steam 的中文商店名有时自带（实测 2584270 的
   * schinese name 就是「《致命躯壳 II》」），而豆瓣条目名一律不带。
   * 只在《》正好包住整串且中间没有别的》时才剥，免得把「《一》与《二》」削成「一》与《二」。
   */
  function stripOuterBrackets(input) {
    const s = str(input);
    return /^《[^》]*》$/.test(s) ? s.slice(1, -1).trim() : s;
  }

  /**
   * 取标题里的「英文段」：按空白切开后丢掉含 CJK 的词块。
   * 豆瓣把序号写在中文名上（「哈迪斯2 Hades II」），直接整串归一会得到
   * '2hadesii'，和英文名 'hadesii' 对不上——而续作常常没有中文商店名，
   * 中文那路也救不回来。整串都含 CJK（如没有空格分隔的「哈迪斯Hades」）时
   * 退回原串，保持旧行为。
   */
  function latinSegment(input) {
    const s = str(input);
    const kept = s.split(/\s+/).filter((t) => t && !HAS_CJK_RE.test(t)).join(' ');
    return kept || s;
  }

  /**
   * 豆瓣条目标题（形如「哈迪斯 Hades」）与 payload 是否同一款游戏。
   * 两路各自归一后精确相等即命中；归一后为空的一路不参与比较，
   * 否则「纯中文条目 × 纯英文 payload」会双双归一成 '' 而误判。
   */
  function isTitleMatch(candidateTitle, payload) {
    const p = payload || {};
    const cl = normalizeLatin(latinSegment(candidateTitle));
    const pl = normalizeLatin(latinSegment(p.titleEn));
    if (cl && pl && cl === pl) return true;
    const cc = normalizeCjk(candidateTitle);
    const pc = normalizeCjk(p.title);
    return Boolean(cc && pc && cc === pc);
  }

  /** Steam genres → {genres:[豆瓣类型名], unmapped:[Steam 原文案]}，按输入顺序去重。 */
  function mapGenres(input) {
    const list = Array.isArray(input) ? input : [];
    const genres = [];
    const unmapped = [];
    for (const g of list) {
      if (!g) continue;
      const hit = GENRE_MAP[Number(g.id)];
      if (!hit) {
        const label = str(g.description).trim();
        if (label && !unmapped.includes(label)) unmapped.push(label);
        continue;
      }
      if (!genres.includes(hit)) genres.push(hit);
    }
    return { genres, unmapped };
  }

  /** Steam platforms 布尔组 → 豆瓣平台名。 */
  function mapPlatforms(input) {
    const p = input || {};
    return PLATFORM_MAP.filter(([key]) => p[key]).map(([, name]) => name);
  }

  const STEAM_ASSETS = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

  /**
   * 封面候选，按偏好排序，运行期逐个试到拿得到图为止：
   * 竖版 library capsule（600×900，形状最接近豆瓣条目封面）→ 1x 版 → header_image。
   *
   * 竖版 URL 不在 appdetails 响应里，只能拼，而且**两种基址都得试**（实测 8 个
   * app）：
   *   - 按 appid 裸拼 `…/apps/{appid}/`：1091500、2707930 只在这里有竖版；
   *   - 从 header_image 剥出的基址：新 app 多一段哈希（3807750 的 header 在
   *     `…/apps/3807750/d0e9…/` 下），1145360、2358720 两种基址都有。
   * 竖版对未发售/小体量 app 常常压根不存在（3527290、3807750、4380770、3756870
   * 两种基址皆 404），因此 header 兜底是必需的，不是保险。
   */
  function coverCandidates(headerImage, appid) {
    const header = str(headerImage).trim();
    const bases = [];
    const m = header.match(/^(.*)\/[^/]+\.(?:jpg|png|webp|avif)(?:\?.*)?$/i);
    if (m) bases.push(m[1]);
    if (appid) bases.push(`${STEAM_ASSETS}/${appid}`);

    const out = [];
    const push = (u) => { if (u && !out.includes(u)) out.push(u); };
    for (const name of ['library_600x900_2x.jpg', 'library_600x900.jpg']) {
      for (const base of bases) push(`${base}/${name}`);
    }
    push(header);
    return out;
  }

  /** appdetails 的 type：只处理 'game'，DLC / 原声带（'music'）/ demo 一律不接。 */
  function isSupportedType(type) {
    return str(type) === 'game';
  }

  /** payload 是否在 TTL 窗口内（now - capturedAt < ttl）。 */
  function isPayloadFresh(payload, now, ttl) {
    const at = payload && payload.source && payload.source.capturedAt;
    if (typeof at !== 'number') return false;
    return now - at < ttl;
  }

  /**
   * 这份 HTML 是不是一张真的搜索结果页。
   * 豆瓣的风控/验证码页同样回 200 且同样没有 .result——若把它当成「零结果」，
   * 用户会照着建出重复条目。所以要求两个结构标记同时在场；缺任一就宁可报错、
   * 退到人工搜索，也不谎称「没搜到」。两个标记在真结果页和真零结果页上都实测存在。
   */
  function isSearchResultsPage(input) {
    const html = str(input);
    return /class="search-result"/.test(html) && /_SEARCH_CONFIG/.test(html);
  }

  const RESULT_SPLIT_RE = /<div class="result">/g;

  /**
   * 解析 https://www.douban.com/search?cat=3114&q=… 的结果页。
   * 条目 URL 由 `sid: {id}` 重建成裸地址——页面上的 a[href] 是 /link2/ 跳转包装，
   * 带 query/pos 参数，不适合当稳定标识。
   */
  function parseGameSearchResults(input) {
    const html = str(input);
    if (!html) return [];
    const chunks = html.split(RESULT_SPLIT_RE).slice(1);
    const out = [];
    const seen = new Set();
    for (const chunk of chunks) {
      const sid = chunk.match(/sid:\s*(\d+)/);
      if (!sid) continue;
      const id = Number(sid[1]);
      if (seen.has(id)) continue;
      const title = chunk.match(/<a[^>]*\btitle="([^"]*)"/);
      const rating = chunk.match(/class="rating_nums"[^>]*>\s*([\d.]+)\s*</);
      const cast = chunk.match(/class="subject-cast"[^>]*>([\s\S]*?)<\/span>/);
      seen.add(id);
      out.push({
        id,
        title: decodeEntities(title ? title[1] : '').trim(),
        url: `https://www.douban.com/game/${id}/`,
        rating: rating ? rating[1] : null,
        cast: decodeEntities(cast ? cast[1] : '').replace(/\s+/g, ' ').trim(),
      });
    }
    return out;
  }

  /**
   * 两份 appdetails 响应（schinese + english）→ canonical payload。
   * 中文那份给名字和简介，英文那份只为拿可解析的日期——schinese 返回的是
   * "2020 年 9 月 17 日"，parseDate 不吃。
   */
  function buildPayload(opts) {
    const o = opts || {};
    const zh = o.zh || {};
    const en = o.en || null;
    const appid = o.appid || null;
    const warnings = [];

    const title = stripOuterBrackets(str(zh.name).trim());
    const titleEn = str(en && en.name).trim() || title;
    const hasChineseName = normalizeCjk(title) !== '';
    if (!hasChineseName) warnings.push('缺中文名（豆瓣游戏条目通常用中文名，请人工补）');

    const rd = (en && en.release_date) || zh.release_date || {};
    const comingSoon = Boolean(rd.coming_soon);
    // 只信英文日期；没有英文响应时宁缺勿错，不去解析中文格式。
    const releaseDate = en && en.release_date ? parseDate(en.release_date.date) : null;
    if (!releaseDate) warnings.push(comingSoon ? '未定档（上市时间留空）' : '缺发行日期');

    const { genres, unmapped } = mapGenres(zh.genres);
    // about_the_game 是唯一干净的正文。detailed_description 看着更长，实则混了
    // 版本/DLC/社群推广样板（2358720 开头是「数字豪华版…兵器：铜云棒」，
    // 2707930 开头是「Join Our Community!」），故排除。about 可能整段只有视频
    // 没有文字（1091500 实测 3665 字 HTML 转出来 0 字），这时才退 short。
    const description = htmlToText(zh.about_the_game) || htmlToText(zh.short_description);
    if (!description) warnings.push('缺简介');

    return {
      appid,
      title,
      titleEn,
      hasChineseName,
      developers: Array.isArray(zh.developers) ? zh.developers.filter(Boolean) : [],
      publishers: Array.isArray(zh.publishers) ? zh.publishers.filter(Boolean) : [],
      releaseDate,
      comingSoon,
      genres,
      unmappedGenres: unmapped,
      platforms: mapPlatforms(zh.platforms),
      website: str(zh.website).trim(),
      description,
      coverCandidates: coverCandidates(zh.header_image, appid),
      warnings,
      source: { name: 'steam', url: str(o.url), capturedAt: o.now },
    };
  }

  /** 查重判定：无 ISBN 这类主键，「搜不到」只能是弱信号，故 maybe/none 分开表述。 */
  function classifyDedup(payload, items) {
    const list = Array.isArray(items) ? items : [];
    const uniq = [];
    const seen = new Set();
    for (const it of list) {
      if (!it || seen.has(it.id)) continue;
      seen.add(it.id);
      uniq.push(it);
    }
    const exact = uniq.find((it) => isTitleMatch(it.title, payload));
    if (exact) return { kind: 'hit', item: exact, items: uniq };
    if (uniq.length) return { kind: 'maybe', items: uniq.slice(0, 3) };
    return { kind: 'none', items: [] };
  }

  /**
   * 纯函数：payload → 豆瓣建条目页的回填计划。字段按「标签文本」标识，
   * DOM 执行器据此定位控件（与 douban-add-book 同构）。
   */
  function buildFillPlan(payload) {
    const p = payload || {};
    const texts = [];
    const textareas = [];
    const filled = [];
    const skipped = [];
    const warnings = [...(Array.isArray(p.warnings) ? p.warnings : [])];

    const push = (bucket, label, value) => {
      if (value) { bucket.push({ label, value }); filled.push(label); }
      else skipped.push(label);
    };
    push(texts, FIELD.titleOriginal, p.titleEn);
    // 没有中文名就把「中文名称」留空——不拿英文名去凑，也不臆造翻译。
    push(texts, FIELD.title, p.hasChineseName ? p.title : '');
    push(textareas, FIELD.description, p.description);

    const manual = [];
    for (const [key, label] of MANUAL_FIELD) {
      const v = Array.isArray(p[key]) ? p[key].join(' / ') : str(p[key]);
      if (v) manual.push({ label, value: v });
    }

    const genres = [...(p.genres || [])];
    if (genres.length) filled.push(FIELD.genres);
    else skipped.push(FIELD.genres);
    for (const label of p.unmappedGenres || []) {
      warnings.push(`类型「${label}」豆瓣无对应，请人工补选`);
    }

    const platforms = [...(p.platforms || [])];
    if (platforms.length) filled.push(FIELD.platforms);
    else skipped.push(FIELD.platforms);

    const d = p.releaseDate || {};
    const date = { field: FIELD.date, y: d.y || null, m: d.m || null, d: d.d || null };
    if (date.y) filled.push(FIELD.date);
    else skipped.push(FIELD.date);
    if (p.comingSoon && date.y) warnings.push('尚未发售，填的是 Steam 上的预计发售时间');

    if (!payload) warnings.push('无有效 payload');

    return { texts, textareas, genres, platforms, date, manual, warnings, filled, skipped };
  }

  /** 标签归一：去掉全部空白、尾随冒号、必填标记，再做精确比较。 */
  function normLabel(input) {
    return str(input).replace(/\s+/g, '').replace(/[*＊]/g, '').replace(/[:：]$/, '');
  }

  const FIELD_LABELS = Object.values(FIELD).concat(['图标']);

  /**
   * 把线性化的表单 token 流按「最近的前驱字段标签」归组。
   *
   * 刻意不写 `.item > label` 这类结构选择器：豆瓣建条目页的 HTML 没到手，
   * 而这个算法对 table / div / dl 任何一种排版都成立——只要标签在控件前面出现过。
   * 只有 FIELD_LABELS 里的标签会开新组，所以提示语、复选框自带的「PC」「动作」、
   * 以及日期后面的「年/月/日」都只是过路 token，不会截断分组。
   *
   * token: {kind:'label', text} | {kind:'control', control, text}
   * 控件自身没带文字时（`<label for>PC</label><input>` 这种写法），取紧邻的前一个标签。
   */
  function groupControls(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    const wanted = new Set(FIELD_LABELS.map(normLabel));
    const groups = {};
    let current = null;
    let lastLabel = '';
    list.forEach((t, index) => {
      if (!t) return;
      if (t.kind === 'label') {
        const norm = normLabel(t.text);
        lastLabel = str(t.text).trim();
        if (wanted.has(norm)) {
          current = norm;
          if (!groups[current]) groups[current] = [];
        }
        return;
      }
      if (t.kind !== 'control' || !current) return; // 字段标签之前的游离控件不归任何组
      groups[current].push({
        index,
        control: t.control,
        text: str(t.text).trim() || lastLabel,
        el: t.el,
      });
    });
    const missing = FIELD_LABELS.filter((l) => !groups[normLabel(l)]);
    return { groups, missing };
  }

  /**
   * 当前停在建条目流程的哪一步。两步共用同一个 URL
   * （都是 https://www.douban.com/game/create），只能靠页面内容判断。
   */
  function detectStep(groups) {
    const g = groups || {};
    if (g[FIELD.genres] || g[FIELD.platforms]) return 'detail';
    if (g[FIELD.titleOriginal]) return 'basic';
    return 'unknown';
  }

  // ── node 测试导出（在 DOM 启动代码之前 return） ──────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseAppId, parseDate, htmlToText, decodeEntities,
      normalizeLatin, normalizeCjk, latinSegment, stripOuterBrackets, isTitleMatch, isSearchResultsPage,
      mapGenres, mapPlatforms, coverCandidates, isSupportedType, isPayloadFresh,
      parseGameSearchResults, buildPayload, classifyDedup, buildFillPlan,
      normLabel, groupControls, detectStep,
      GENRE_MAP, PLATFORM_MAP, DOUBAN_GENRES, FIELD,
    };
    return;
  }

  // ============================================================
  // 运行期：配置 + GM 封装
  // ============================================================

  const STORAGE_KEY = 'dag:pending';
  const COVER_KEY = 'dag:cover';
  const TTL_MS = 10 * 60 * 1000;
  const CREATE_BASE = 'https://www.douban.com/game/create';
  const SEARCH_BASE = 'https://www.douban.com/search?cat=3114&q=';
  const HIGHLIGHT_SHADOW = '0 0 0 3px rgba(46,125,50,.6)'; // 绿色「该点这个」描边

  const deps = {
    // 默认带 cookie：跨域目标是豆瓣，登录态既是 /game/create 的前提，
    // 也是对抗搜索接口风控的主要手段。匿名请求请显式传 anonymous:true。
    request(url, opts = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url,
          headers: opts.headers || {},
          timeout: opts.timeout || 15000,
          responseType: opts.responseType || undefined,
          anonymous: opts.anonymous === true,
          onload: resolve,
          onerror: () => reject(new Error('request failed: ' + url)),
          ontimeout: () => reject(new Error('request timeout: ' + url)),
        });
      });
    },
  };

  function escapeHtml(input) {
    return str(input)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeLinkUrl(input) {
    const url = str(input).trim();
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  // ============================================================
  // Steam 适配器：appdetails API → canonical payload（完全不刮 DOM）
  // ============================================================

  /** 取一份 appdetails；下架/区域封锁/非游戏条目（success:false）返回 null。 */
  async function fetchAppDetails(appid, lang) {
    try {
      const resp = await deps.request(
        `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${lang}`
      );
      const json = JSON.parse(resp.responseText);
      const entry = json && json[String(appid)];
      return entry && entry.success ? entry.data : null;
    } catch {
      return null;
    }
  }

  // ============================================================
  // 豆瓣查重服务（与来源无关）
  // ============================================================

  /** 单次搜索；风控/网络失败抛出，由 dedup 统一收成 error 态。 */
  async function searchDouban(query) {
    const resp = await deps.request(SEARCH_BASE + encodeURIComponent(query));
    if (resp.status !== 200) throw new Error('douban search status ' + resp.status);
    if (!isSearchResultsPage(resp.responseText)) throw new Error('douban search not a results page');
    return parseGameSearchResults(resp.responseText);
  }

  /**
   * 先按英文名查；命中就收工，没命中才补一次中文名查询。
   * 豆瓣搜索有频率限制（连续请求实测会整页 403），所以常见的「已收录」路径
   * 只花一次请求。任一次失败即整体 error——绝不把风控当成「没搜到」。
   */
  async function dedup(payload) {
    const queries = [...new Set([payload.titleEn, payload.title].filter(Boolean))];
    let items = [];
    let result = { kind: 'none', items: [] };
    try {
      for (const q of queries) {
        items = items.concat(await searchDouban(q));
        result = classifyDedup(payload, items);
        if (result.kind === 'hit') return result;
      }
    } catch {
      return { kind: 'error' };
    }
    return result;
  }

  // ============================================================
  // 跨域交接
  // ============================================================

  function stashAndOpen(payload) {
    GM_setValue(STORAGE_KEY, JSON.stringify(payload));
    // 送原文名：第一步问的是「游戏名称（原文）」，中文名在第二步另有一格。
    GM_openInTab(`${CREATE_BASE}?thing_name=${encodeURIComponent(payload.titleEn)}`, {
      active: true,
      insert: true,
    });
  }

  // ============================================================
  // Steam 侧角标 UI
  // ============================================================

  const BADGE_ID = 'dag-badge';
  const DETAIL_ID = 'dag-detail';
  const TOGGLE_ID = 'dag-toggle';

  /**
   * 配色取自 Steam 商店页自身的面板（深色底），而不是豆瓣侧那张米色卡片——
   * 米色卡片贴在 #1b2838 的页面上过于突兀。两侧共享的是版式与那颗绿色行动按钮，
   * 不是底色。
   */
  const C = {
    bg: '#1b2838',
    border: 'rgba(255,255,255,.12)',
    text: '#c6d4df',
    muted: '#8f98a0',
    link: '#66c0f4',
    warn: '#e3b341',
    ok: '#a4d007',
    bad: '#ff7b72',
    btn: '#388e3c',
  };
  const LINK_STYLE = `color:${C.link};text-decoration:none`;
  const CELL = 'display:flex;gap:8px;min-width:0';
  const KEY = `flex:0 0 52px;color:${C.muted}`;

  /** 展开区的字段表：两列六格，比原先九行竖排省一半高度。 */
  function fieldGridHtml(p) {
    const date = p.releaseDate
      ? [p.releaseDate.y, p.releaseDate.m, p.releaseDate.d].filter(Boolean).join('-')
      : '—';
    const cells = [
      ['名称', p.titleEn],
      ['类型', p.genres.join(' / ') || '（无对应）'],
      ['中文名', p.hasChineseName ? p.title : '（缺）'],
      ['平台', p.platforms.join(' / ') || '—'],
      [p.comingSoon ? '预计' : '发行', date],
      ['简介', p.description ? `${p.description.length} 字` : '（缺失）'],
    ];
    return (
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 18px;margin-top:6px">` +
      cells
        .map(([k, v]) => `<div style="${CELL}"><b style="${KEY}">${k}</b><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(String(v))}</span></div>`)
        .join('') +
      '</div>'
    );
  }

  /** 建条目页收不下的字段：单独一行提示，别混进「已填」的错觉里。 */
  function manualHtml(plan) {
    if (!plan.manual.length) return '';
    const list = plan.manual.map((m) => `${escapeHtml(m.label)} ${escapeHtml(m.value)}`).join(' · ');
    return `<div style="margin-top:6px;color:${C.muted}">建条目页无此字段，创建后到条目编辑页补：${list}</div>`;
  }

  function ensureBadge() {
    let box = document.getElementById(BADGE_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = BADGE_ID;
    box.style.cssText =
      `margin:10px 0;padding:8px 12px;border:1px solid ${C.border};border-radius:4px;` +
      `background:${C.bg};font-size:13px;line-height:1.6;color:${C.text};max-width:640px`;
    // 主锚点：塞进标题条容器内部（实测落在 top≈506px 首屏内，且 x 与正文栏对齐；
    // 插到它后面会落进全宽的 .page_top_area，左边缘顶到 x=0 跟页面栅格错开）。
    // 左侧正文栏是次选——它自己就在 1165px 处，要滚动才看得到。
    const titleArea = document.querySelector('.page_title_area');
    const leftcol = document.querySelector('.leftcol.game_description_column');
    if (titleArea) {
      titleArea.appendChild(box);
    } else if (leftcol) {
      leftcol.insertBefore(box, leftcol.firstChild);
    } else {
      box.style.cssText += ';position:fixed;top:12px;right:12px;z-index:99999;box-shadow:0 2px 12px rgba(0,0,0,.4)';
      document.body.appendChild(box);
    }
    return box;
  }

  function itemLink(it) {
    const rating = it.rating ? ` <span style="color:${C.muted}">${escapeHtml(it.rating)}</span>` : '';
    return `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" style="${LINK_STYLE}">${escapeHtml(it.title)}</a>${rating}`;
  }

  /** 首行：结论 + 证据链接。相近条目属于决策依据，必须常驻，不能藏进「详情」。 */
  function headHtml(state, payload, result) {
    const tag = (color, text) => `<b style="color:${color}">${text}</b>`;
    if (state === 'loading') return `<span style="color:${C.muted}">豆瓣 · 查重中…</span>`;
    if (state === 'error') {
      const q = encodeURIComponent(payload ? payload.titleEn : '');
      return `${tag(C.bad, '豆瓣 · 查重失败')} <a href="${SEARCH_BASE}${q}" target="_blank" rel="noopener" style="${LINK_STYLE}">手动搜索 →</a>`;
    }
    if (state === 'hit') return `${tag(C.ok, '豆瓣 · 已收录')} ${itemLink(result.item)}`;
    if (state === 'maybe') {
      return `${tag(C.warn, '豆瓣 · 名字相近')} ${result.items.map(itemLink).join('　')}`;
    }
    return `${tag(C.text, '豆瓣 · 没搜到')}<span style="color:${C.muted}">（搜不到不等于一定没有）</span>`;
  }

  function renderBadge(state, payload, result) {
    const box = ensureBadge();
    const addable = state === 'maybe' || state === 'none';
    const action = addable
      ? `<button id="dag-add" style="flex:none;cursor:pointer;padding:4px 12px;border:0;border-radius:3px;background:${C.btn};color:#fff;font-size:13px">${state === 'maybe' ? '都不是，去添加' : '+ 添加到豆瓣'}</button>`
      : '';
    const toggle = payload
      ? `<button id="${TOGGLE_ID}" style="flex:none;cursor:pointer;padding:4px 6px;border:0;background:none;color:${C.muted};font-size:12px">详情 ▾</button>`
      : '';

    // 只在真要添加时列告警——已收录的条目不用管抓取缺了什么。
    const plan = payload && addable ? buildFillPlan(payload) : null;
    const warn = plan && plan.warnings.length
      ? `<div style="margin-top:6px;color:${C.warn}">${plan.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('　')}</div>`
      : '';
    const detail = payload
      ? `<div id="${DETAIL_ID}" style="display:none;border-top:1px solid ${C.border};margin-top:8px;padding-top:6px">${warn}${fieldGridHtml(payload)}${plan ? manualHtml(plan) : ''}</div>`
      : '';

    box.innerHTML =
      `<div style="display:flex;align-items:center;gap:10px">` +
      `<div style="flex:1 1 auto;min-width:0">${headHtml(state, payload, result)}</div>${action}${toggle}</div>${detail}`;

    const btn = box.querySelector('#dag-add');
    if (btn) btn.addEventListener('click', () => stashAndOpen(payload));
    const tog = box.querySelector('#' + TOGGLE_ID);
    const det = box.querySelector('#' + DETAIL_ID);
    if (tog && det) {
      tog.addEventListener('click', () => {
        const open = det.style.display === 'none';
        det.style.display = open ? 'block' : 'none';
        tog.textContent = open ? '详情 ▴' : '详情 ▾';
      });
    }
  }

  async function runSteam() {
    const appid = parseAppId(location.pathname);
    if (!appid) return;

    const [zh, en] = await Promise.all([
      fetchAppDetails(appid, 'schinese'),
      fetchAppDetails(appid, 'english'),
    ]);
    if (!zh) return; // 下架 / 区域封锁：静默早退
    if (!isSupportedType(zh.type)) return; // DLC / 原声带 / demo：静默早退

    const payload = buildPayload({
      zh, en, appid, url: `https://store.steampowered.com/app/${appid}/`, now: Date.now(),
    });
    renderBadge('loading', payload, null);
    const result = await dedup(payload);
    renderBadge(result.kind, payload, result);
  }

  // ============================================================
  // 分派
  // ============================================================

  // ============================================================
  // 豆瓣侧回填器（与来源无关）
  // ============================================================

  const BANNER_ID = 'dag-banner';

  function fireValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelect(sel, value) {
    const want = String(value);
    if (![...sel.options].some((o) => o.value === want)) return false;
    sel.value = want;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function controlKind(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    const type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'file') return type;
    if (type === 'hidden' || type === 'submit' || type === 'button') return 'other';
    return 'text';
  }

  /** 元素自己的直接文本（不含后代），用来把「标签」与「容器」区分开。 */
  function ownText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return out.trim();
  }

  /** DOM → token 流，交给纯函数 groupControls 归组。 */
  function formTokens(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        const label = el.closest('label');
        out.push({ kind: 'control', control: controlKind(el), text: label ? ownText(label) : '', el });
        continue;
      }
      const own = ownText(el);
      if (own) out.push({ kind: 'label', text: own });
    }
    return out;
  }

  /** 页面上不止一个 form（页头搜索框也是）——挑归出字段最多的那个。 */
  function pickForm() {
    const roots = [...document.querySelectorAll('form'), document.body];
    let best = null;
    for (const root of roots) {
      const scan = groupControls(formTokens(root));
      const n = Object.keys(scan.groups).length;
      if (!best || n > best.n) best = { root, scan, n };
    }
    return best;
  }

  const firstOf = (list, kind) => (list || []).find((c) => c.control === kind);

  /** 按名字勾选复选框组；返回真正勾上的名字，便于如实汇报。 */
  function checkByName(list, names) {
    const done = [];
    for (const name of names) {
      const hit = (list || []).find((c) => c.control === 'checkbox' && normLabel(c.text) === normLabel(name));
      if (!hit || !hit.el) continue;
      if (!hit.el.checked) {
        hit.el.checked = true;
        hit.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      done.push(name);
    }
    return done;
  }

  /** 「日」下拉常由页面脚本在「月」change 后异步填充，轮询到目标 option 出现为止。 */
  function pollSelect(sel, value, attempts) {
    if (value == null) return;
    const tick = (n) => {
      if (setSelect(sel, value)) return;
      if (n > 0) setTimeout(() => tick(n - 1), 60);
    };
    tick(attempts);
  }

  /** 执行回填，返回真正落地的字段——没落地的绝不算进「已填」。 */
  function applyPlan(groups, plan) {
    const filled = [];
    const failed = [];
    const mark = (label, ok) => (ok ? filled : failed).push(label);

    for (const t of plan.texts) {
      const el = (firstOf(groups[normLabel(t.label)], 'text') || {}).el;
      if (el) fireValue(el, t.value);
      mark(t.label, Boolean(el));
    }
    for (const a of plan.textareas) {
      const el = (firstOf(groups[normLabel(a.label)], 'textarea') || {}).el;
      if (el) fireValue(el, a.value);
      mark(a.label, Boolean(el));
    }
    for (const [label, names] of [[FIELD.genres, plan.genres], [FIELD.platforms, plan.platforms]]) {
      if (!names.length) continue;
      const done = checkByName(groups[normLabel(label)], names);
      mark(`${label} ${done.join('/')}`.trim(), done.length === names.length);
    }
    if (plan.date.y) {
      const sels = (groups[normLabel(plan.date.field)] || []).filter((c) => c.control === 'select');
      if (sels.length >= 1) {
        setSelect(sels[0].el, plan.date.y);
        if (sels.length >= 2 && plan.date.m) {
          setSelect(sels[1].el, plan.date.m);
          if (sels.length >= 3) pollSelect(sels[2].el, plan.date.d, 20);
        }
      }
      mark(plan.date.field, sels.length >= 1);
    }
    return { filled, failed };
  }

  function injectBanner(root, innerHtml) {
    const old = document.getElementById(BANNER_ID);
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.id = BANNER_ID;
    // 豆瓣侧沿用与 douban-add-book 同一张米色卡片；换成深色的只是 Steam 那半边。
    bar.style.cssText =
      'margin:0 0 14px;padding:12px 14px;border:1px solid #d6c79b;border-radius:8px;' +
      'background:#fcf9ef;font-size:13px;line-height:1.7;color:#333';
    bar.innerHTML = innerHtml;
    root.parentElement.insertBefore(bar, root);
    return bar;
  }

  function chips(items, color) {
    return items
      .map((t) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:10px;background:${color};font-size:12px">${escapeHtml(t)}</span>`)
      .join('');
  }

  function highlightSubmit(root) {
    const btn = root.querySelector('input[type="submit"], button[type="submit"]');
    if (btn) btn.style.boxShadow = HIGHLIGHT_SHADOW;
  }

  /** 逐个试封面候选，第一个拿到真图片就用它。 */
  async function fetchCover(candidates) {
    for (const url of candidates || []) {
      try {
        const resp = await deps.request(url, { anonymous: true, responseType: 'blob' });
        const blob = resp.response;
        if (blob && blob.size && /^image\//.test(blob.type || '')) return { blob, url };
      } catch { /* 试下一个 */ }
    }
    return null;
  }

  async function injectCover(fileEl, payload) {
    const got = await fetchCover(payload.coverCandidates);
    if (!got) return null;
    const ext = (got.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([got.blob], `cover.${ext}`, { type: got.blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileEl.files = dt.files;
    fileEl.dispatchEvent(new Event('change', { bubbles: true }));
    return URL.createObjectURL(got.blob);
  }

  function loadPayload() {
    const raw = GM_getValue(STORAGE_KEY);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw);
      if (isPayloadFresh(p, Date.now(), TTL_MS)) return p;
    } catch { /* 损坏即忽略 */ }
    GM_deleteValue(STORAGE_KEY);
    return null;
  }

  async function fillDetail(root, groups, payload) {
    // 安全闸门：表单已有的名字与 payload 对不上就只出横幅、不动表单、不消费 payload。
    // 这道闸门比添书那边的 ISBN 校验弱（thing_name 是我们自己送过去的），
    // 但仍挡得住「TTL 窗口内换了一款游戏、手动打开建条目页」这种真实误伤。
    const nameEl = (firstOf(groups[normLabel(FIELD.titleOriginal)], 'text') || {}).el;
    const existing = nameEl ? nameEl.value.trim() : '';
    if (existing && !isTitleMatch(existing, payload)) {
      injectBanner(root, `<b style="color:#c0392b">未自动回填</b>：表单里的名称（${escapeHtml(existing)}）与 Steam 抓到的（${escapeHtml(payload.titleEn)}）对不上，疑似不是同一款。请手动核对。`);
      return;
    }

    const plan = buildFillPlan(payload);
    const { filled, failed } = applyPlan(groups, plan);

    const fileEl = (firstOf(groups[normLabel('图标')], 'file') || {}).el;
    let cover = '';
    if (fileEl) {
      const preview = await injectCover(fileEl, payload);
      cover = preview
        ? `<div style="margin-top:8px">封面已注入（来自 Steam），核对后一并提交：<br><img src="${escapeHtml(preview)}" alt="封面预览" style="margin-top:4px;max-height:180px;border:1px solid #d6c79b;border-radius:4px"></div>`
        : '<div style="margin-top:8px;color:#b8500b">⚠ 封面自动获取失败，请手动上传。</div>';
    }

    const warn = plan.warnings.length
      ? `<div style="margin-top:8px;color:#b8500b">${plan.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br>')}</div>`
      : '';
    const manual = plan.manual.length
      ? `<div style="margin-top:8px;color:#666">建条目页没有这些字段，创建成功后请到条目编辑页补：${plan.manual.map((m) => `${escapeHtml(m.label)} ${escapeHtml(m.value)}`).join(' · ')}</div>`
      : '';
    const bad = failed.length
      ? `<div style="margin-top:4px;color:#c0392b">没找到控件：${chips(failed, '#f6d6d0')}</div>`
      : '';

    injectBanner(
      root,
      '<b>豆瓣一键添游戏 · 已回填</b>　<span style="color:#888">请核对后人工提交</span>' +
        `<div style="margin-top:8px">已填：${chips(filled, '#dbefda')}</div>` +
        bad + warn + manual + cover
    );
    highlightSubmit(root);
    GM_deleteValue(STORAGE_KEY); // 消费即删，免得第二步重载时覆盖你的编辑
  }

  function runDouban() {
    const payload = loadPayload();
    if (!payload) return; // 没有有效 payload：你可能在正常手动建条目，什么都不做

    const best = pickForm();
    if (!best) return;
    const step = detectStep(best.scan.groups);
    if (step === 'detail') {
      fillDetail(best.root, best.scan.groups, payload);
      return;
    }
    if (step === 'basic') {
      // 第一步是豆瓣自己的查重闸门——名字已由 thing_name 带过来，剩下的由人点。
      // 绝不代点「以上都不是，继续创建」。
      injectBanner(
        best.root,
        `<b>豆瓣一键添游戏</b>　已带上名称 <code>${escapeHtml(payload.titleEn)}</code>。` +
          '这一步是豆瓣自己的查重，请确认列出的都不是同一款，再点「以上都不是，继续创建」——下一步脚本会自动回填全部字段。'
      );
      return;
    }
    // 一个字段标签都没认出来：多半是豆瓣改了文案或版式。宁可自报家门，
    // 也不要装作「还在第一步」——把认出/没认出的都列出来，照着改一处就行。
    injectBanner(
      best.root,
      '<b style="color:#c0392b">没认出这一步的表单</b>，未做任何回填（数据仍留着，10 分钟内有效）。' +
        `<div style="margin-top:6px">认出的字段：${chips(Object.keys(best.scan.groups), '#dbefda') || '（无）'}</div>` +
        `<div style="margin-top:4px">没找到：${chips(best.scan.missing, '#eee')}</div>` +
        '<div style="margin-top:6px;color:#666">若豆瓣改了字段名，改脚本里的 <code>FIELD</code> 表即可。</div>'
    );
  }

  if (location.hostname === 'store.steampowered.com') {
    runSteam();
  } else if (location.hostname === 'www.douban.com') {
    runDouban();
  }
})();
