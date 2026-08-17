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
   * Steam genre id → 豆瓣「类型」{id,name}。
   * 按 **id** 映射而非文案：实测同一 app 的 genre id 跨 l=schinese / l=english 稳定，
   * 只有 description 变（2358720 两种语言均为 1/25/3）。
   * 豆瓣只有 15 个类型，Steam 的 4 休闲 / 23 独立 / 29 MMO / 37 F2P / 70 抢先体验
   * 等在豆瓣没有落点——一律进 unmapped 让人工补，不猜。
   */
  const GENRE_MAP = {
    1: { id: 1, name: '动作' },
    2: { id: 2, name: '策略' },
    3: { id: 5, name: '角色扮演' },
    9: { id: 6, name: '竞速' },
    18: { id: 3, name: '体育' },
    25: { id: 4, name: '冒险' },
    28: { id: 7, name: '模拟' },
  };

  /** Steam 只能确知这三个平台；主机平台无从得知，留空由人工补。 */
  const PLATFORM_MAP = [
    ['windows', { id: 94, name: 'PC' }],
    ['mac', { id: 17, name: 'Mac' }],
    ['linux', { id: 152, name: 'Linux' }],
  ];

  /** 豆瓣游戏条目的字段标签（DOM 执行器按这些文本定位控件）。 */
  const FIELD = {
    title: '游戏名称',
    aliases: '别名',
    developers: '开发商',
    publishers: '发行商',
    website: '官方网站',
    description: '游戏简介',
    releaseDate: '发行日期',
    expectedDate: '预计上市时间',
    genres: '类型',
    platforms: '平台',
  };

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

  /**
   * 豆瓣条目标题（形如「哈迪斯 Hades」）与 payload 是否同一款游戏。
   * 两路各自归一后精确相等即命中；归一后为空的一路不参与比较，
   * 否则「纯中文条目 × 纯英文 payload」会双双归一成 '' 而误判。
   */
  function isTitleMatch(candidateTitle, payload) {
    const p = payload || {};
    const cl = normalizeLatin(candidateTitle);
    const pl = normalizeLatin(p.titleEn);
    if (cl && pl && cl === pl) return true;
    const cc = normalizeCjk(candidateTitle);
    const pc = normalizeCjk(p.title);
    return Boolean(cc && pc && cc === pc);
  }

  /** Steam genres → {genres:[{id,name}], unmapped:[description]}，按输入顺序、按豆瓣 id 去重。 */
  function mapGenres(input) {
    const list = Array.isArray(input) ? input : [];
    const genres = [];
    const unmapped = [];
    const seen = new Set();
    for (const g of list) {
      if (!g) continue;
      const hit = GENRE_MAP[Number(g.id)];
      if (!hit) {
        const label = str(g.description).trim();
        if (label && !unmapped.includes(label)) unmapped.push(label);
        continue;
      }
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      genres.push(hit);
    }
    return { genres, unmapped };
  }

  /** Steam platforms 布尔组 → 豆瓣平台 [{id,name}]。 */
  function mapPlatforms(input) {
    const p = input || {};
    return PLATFORM_MAP.filter(([key]) => p[key]).map(([, v]) => v);
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

    const title = str(zh.name).trim();
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
      aliases: titleEn && titleEn !== title ? [titleEn] : [],
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
    push(texts, FIELD.title, p.title);
    push(texts, FIELD.aliases, (p.aliases || []).join(' / '));
    push(texts, FIELD.developers, (p.developers || []).join(' / '));
    push(texts, FIELD.publishers, (p.publishers || []).join(' / '));
    push(texts, FIELD.website, p.website);
    push(textareas, FIELD.description, p.description);

    const genreIds = (p.genres || []).map((g) => g.id);
    if (genreIds.length) filled.push(FIELD.genres);
    else skipped.push(FIELD.genres);
    for (const label of p.unmappedGenres || []) {
      warnings.push(`类型「${label}」豆瓣无对应，请人工补选`);
    }

    const platformIds = (p.platforms || []).map((x) => x.id);
    if (platformIds.length) filled.push(FIELD.platforms);
    else skipped.push(FIELD.platforms);

    const d = p.releaseDate || {};
    const field = p.comingSoon ? FIELD.expectedDate : FIELD.releaseDate;
    const date = { field, y: d.y || null, m: d.m || null, d: d.d || null };
    if (date.y) filled.push(field);
    else skipped.push(field);

    if (!payload) warnings.push('无有效 payload');

    return { texts, textareas, genreIds, platformIds, date, warnings, filled, skipped };
  }

  // ── node 测试导出（在 DOM 启动代码之前 return） ──────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseAppId, parseDate, htmlToText, decodeEntities,
      normalizeLatin, normalizeCjk, isTitleMatch,
      mapGenres, mapPlatforms, coverCandidates, isSupportedType, isPayloadFresh,
      parseGameSearchResults, buildPayload, classifyDedup, buildFillPlan,
      GENRE_MAP, PLATFORM_MAP, FIELD,
    };
    return;
  }
})();
