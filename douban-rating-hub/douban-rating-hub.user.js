// ==UserScript==
// @name         豆瓣评分汇 | Douban Rating Hub
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.1.8
// @description  豆瓣全品类（电影、剧集、图书、音乐、游戏、播客）评分聚合 — IMDB、烂番茄、Letterboxd、Goodreads、Trakt 等 17 个平台；在 title 上方显示外部权威榜单胶囊
// @match        https://book.douban.com/subject/*
// @match        https://movie.douban.com/subject/*
// @match        https://music.douban.com/subject/*
// @match        https://www.douban.com/game/*
// @match        https://game.douban.com/subject/*
// @match        https://www.douban.com/location/drama/*
// @match        https://www.douban.com/podcast/*
// @connect      imdb.com
// @connect      p.media-imdb.com
// @connect      api.graphql.imdb.com
// @connect      rottentomatoes.com
// @connect      backend.metacritic.com
// @connect      www.metacritic.com
// @connect      letterboxd.com
// @connect      api.themoviedb.org
// @connect      neodb.social
// @connect      goodreads.com
// @connect      amazon.com
// @connect      weread.qq.com
// @connect      api.bgm.tv
// @connect      api.jikan.moe
// @connect      api.discogs.com
// @connect      store.steampowered.com
// @connect      itunes.apple.com
// @connect      podcasts.apple.com
// @connect      xyzrank.eddiehe.top
// @connect      rank.douban.zhili.dev
// @connect      api.trakt.tv
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @icon         https://img3.doubanio.com/favicon.ico
// @icon64       https://img3.doubanio.com/favicon.ico
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-rating-hub/douban-rating-hub.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-rating-hub/douban-rating-hub.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Deps — 对 GM API 的迁移友好封装
  // ============================================================

  const deps = {
    request(url, opts = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url,
          headers: opts.headers || {},
          data: opts.data || undefined,
          timeout: opts.timeout || 15000,
          // 默认匿名 — 评分 channel 查的是公开数据，绝不能带用户的
          // Amazon/Goodreads/weread 等站点 cookie，否则返回个性化结果会污染
          // 通用评分视角。调用方若需带 cookie 显式传 anonymous:false。
          anonymous: opts.anonymous !== false,
          onload(resp) { resolve(resp); },
          onerror(err) { reject(new Error('Request failed: ' + url)); },
          ontimeout() { reject(new Error('Request timeout: ' + url)); },
        });
      });
    },
    storage: {
      get(key, fallback = null) {
        const raw = GM_getValue(key);
        if (raw === undefined || raw === null) return fallback;
        try { return JSON.parse(raw); } catch { return raw; }
      },
      set(key, value) { GM_setValue(key, JSON.stringify(value)); },
      remove(key) { GM_deleteValue(key); },
      listKeys() { return GM_listValues(); },
    },
    log(...args) { console.log('[RatingHub]', ...args); },
    parseHTML(html) { return new DOMParser().parseFromString(html, 'text/html'); },
  };

  // ============================================================
  // Util — 给榜单功能用的小工具（v1.1.0 新增）
  // ============================================================

  /**
   * HTML 转义 — 用于安全地把字符串插入 innerHTML。
   * @param {*} input
   * @returns {string}
   */
  function escapeHtml(input) {
    return String(input == null ? '' : input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeLinkUrl(input) {
    const url = String(input == null ? '' : input).trim();
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  // ============================================================
  // 跨平台标题/年份匹配 — 纯函数，无 DOM/网络副作用（见 test/match.test.cjs）
  // ============================================================

  /**
   * 标题归一化 — 用于跨平台标题比较：& → and，转小写，去掉所有非字母数字字符。
   * @param {*} s
   * @returns {string}
   */
  function normalizeTitle(s) {
    return (s == null ? '' : String(s)).replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * 两个年份是否在 ±1 内（视为同一部片）。外片在中国上映常滞后约 1 年，故留 1 年容差。
   * 任一年份缺失或非法 → false（无法判定，不视为匹配）。
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   */
  function yearWithinOne(a, b) {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (isNaN(na) || isNaN(nb)) return false;
    return Math.abs(na - nb) <= 1;
  }

  /**
   * 从搜索候选里挑出最匹配的条目，用「标题相关 → 年份 → 相关度排名」消歧。
   * 通用于 RT 与 MC 的搜索结果。candidates: [{nameNorm, year, href}]，顺序即搜索相关度排序。
   *
   * 1. 先筛标题相关的候选：归一化精确相等，或两边互为**前缀/后缀**且「多出来的那段」
   *    不是另一边的子串（v1.1.8 起，旧规则「任意 indexOf」会错配）。
   *    - 接受："Lee Cronin's The Mummy" 后缀含 "The Mummy"，多出 "leecronins" 不在 query 中
   *    - 拒绝："Home Sweet Home" 后缀含 "Sweet Home"，但多出 "home" 又出现在 query "sweethome" 中
   *      → token 重叠/伪关系，不是同一片名的修饰版本
   *    - 拒绝："Home Sweet Home Alone" 完全是中段子串，无前缀/后缀关系
   *    MC 搜索结果尾部会混入大量无关条目（按 token 模糊匹配），必须先过滤，
   *    否则纯按年份会误命中无关的同年片。
   * 2. 有 queryYear：在相关候选里取年份匹配（±1）的第一条（搜索已把最相关的排前）。
   *    这既避开同名但错年份的经典老片（把 2026 版《木乃伊》配到 1999 版），
   *    也跳过同年但无关/无评分的条目。
   * 3. 无 queryYear 或无年份匹配：相关候选里精确相等优先，否则取第一条（不回归缺年份条目）。
   * @returns {{nameNorm:string, year:string, href:string}|null}
   */
  function pickByYearThenTitle(candidates, queryNorm, queryYear) {
    if (!candidates || candidates.length === 0) return null;
    const relevant = [];
    for (let i = 0; i < candidates.length; i++) {
      const n = candidates[i].nameNorm;
      if (!n) continue;
      if (n === queryNorm) { relevant.push(candidates[i]); continue; }
      if (!queryNorm || queryNorm.length < 4) continue;
      // 必须是前缀/后缀关系：取长串和短串，看长串是否以短串开头或结尾
      const longer = n.length >= queryNorm.length ? n : queryNorm;
      const shorter = n.length >= queryNorm.length ? queryNorm : n;
      let removed = null;
      if (longer.startsWith(shorter)) removed = longer.slice(shorter.length);
      else if (longer.endsWith(shorter)) removed = longer.slice(0, longer.length - shorter.length);
      if (removed === null) continue;
      // 「多出来的那段」反向包含于短串 → token 重叠/伪关系，拒绝
      // 关键例：n="homesweethome", q="sweethome"，removed="home"，"home" ⊂ "sweethome" → 拒绝
      if (shorter.indexOf(removed) !== -1) continue;
      relevant.push(candidates[i]);
    }
    if (relevant.length === 0) return null;
    const qy = parseInt(queryYear, 10);
    if (!isNaN(qy)) {
      for (let i = 0; i < relevant.length; i++) {
        if (yearWithinOne(relevant[i].year, qy)) return relevant[i];
      }
    }
    // 无 queryYear / 无年份匹配：精确相等优先，否则第一条相关候选
    for (let i = 0; i < relevant.length; i++) {
      if (relevant[i].nameNorm === queryNorm) return relevant[i];
    }
    return relevant[0];
  }

  /**
   * 从 RT 详情页 HTML 提取上映年份（JSON 字段 "releaseYear":"2026"）。
   * 用于校验 fast-path 命中的缓存 URL 是否仍指向正确年份的片（治被污染的 slugMap）。
   * @param {string} html
   * @returns {number|null}
   */
  function extractRtDetailYear(html) {
    if (!html) return null;
    const m = html.match(/"releaseYear"\s*:\s*"?(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * 计算 RT 搜索行的「用于年份消歧的年份」。
   * 电影行有 `release-year`，直接用。TV 行只有 `startyear` / `endyear`（多季播出区间）——
   * 若豆瓣季页年份落在 [startYear, endYear || 当前年]，把候选年视为豆瓣年份，避免 S2/S3
   * 因 startyear 与 queryYear 差几年被 ±1 年份消歧拒掉。否则用 startyear。
   * @param {number|string|null} releaseYear  电影行的 release-year（中划线属性）
   * @param {number|string|null} startYear    TV 行的 startyear（无中划线）
   * @param {number|string|null} endYear      TV 行的 endyear（无中划线，空=至今）
   * @param {number|string|null} queryYear    豆瓣条目年份
   * @returns {string} 用作 candidate.year 的字符串（不可用时返回 ''）
   */
  function computeRtCandidateYear(releaseYear, startYear, endYear, queryYear) {
    if (releaseYear) return String(releaseYear);
    const startY = parseInt(startYear, 10);
    if (isNaN(startY)) return '';
    const endY = parseInt(endYear, 10);
    const queryY = parseInt(queryYear, 10);
    const effectiveEnd = isNaN(endY) ? new Date().getFullYear() : endY;
    if (!isNaN(queryY) && queryY >= startY && queryY <= effectiveEnd) {
      return String(queryY);
    }
    return String(startY);
  }

  /**
   * 从 RT 详情页 HTML 抽取 critics / audience 分数与评论数。
   * 兼容两种 JSON 形态：
   *   - 电影页："criticsScore": 83
   *   - TV 页 ："criticsScore": {"score":"83", "reviewCount":12, ...}
   * v1.1.8 之前仅匹配数字形态，TV 页走不上 JSON → DOM fallback 拿到的是季级分而非总评。
   * @param {string} html
   * @returns {{criticsScore: number|null, audienceScore: number|null, criticsCount: number|null, audienceCount: number|null}}
   */
  function extractRtScores(html) {
    let criticsScore = null;
    let audienceScore = null;
    let criticsCount = null;
    let audienceCount = null;
    if (!html) return { criticsScore, audienceScore, criticsCount, audienceCount };

    const criticsNum = html.match(/"criticsScore"\s*:\s*(\d+)/);
    const audienceNum = html.match(/"audienceScore"\s*:\s*(\d+)/);
    if (criticsNum) criticsScore = parseInt(criticsNum[1], 10);
    if (audienceNum) audienceScore = parseInt(audienceNum[1], 10);

    const criticsObj = html.match(/"criticsScore"\s*:\s*\{[^}]+\}/);
    const audienceObj = html.match(/"audienceScore"\s*:\s*\{[^}]+\}/);
    if (criticsObj) {
      const cm = criticsObj[0].match(/"reviewCount"\s*:\s*(\d+)/);
      if (cm) criticsCount = parseInt(cm[1], 10);
      if (criticsScore == null) {
        const sm = criticsObj[0].match(/"score"\s*:\s*"?(\d+)/);
        if (sm) criticsScore = parseInt(sm[1], 10);
      }
    }
    if (audienceObj) {
      const am = audienceObj[0].match(/"reviewCount"\s*:\s*(\d+)/);
      if (am) audienceCount = parseInt(am[1], 10);
      if (audienceScore == null) {
        const sm = audienceObj[0].match(/"score"\s*:\s*"?(\d+)/);
        if (sm) audienceScore = parseInt(sm[1], 10);
      }
    }
    return { criticsScore, audienceScore, criticsCount, audienceCount };
  }

  /**
   * 从豆瓣多条上映日期里取最早的年份（= 原始上映年，外部库 RT/MC/IMDB 均按此编目）。
   * 豆瓣常把中国大陆重映日期排在最前（如《海上钢琴师》2019 重映在前、1998 意大利原版在后），
   * 直接取第一条会得到重映年，导致年份消歧把正确条目误判为错年份。取最早年规避之。
   * @param {string[]} dateTexts
   * @returns {string|null}
   */
  function earliestReleaseYear(dateTexts) {
    if (!dateTexts || !dateTexts.length) return null;
    let min = null;
    for (let i = 0; i < dateTexts.length; i++) {
      const m = String(dateTexts[i]).match(/(\d{4})/);
      if (m) { const y = parseInt(m[1], 10); if (min === null || y < min) min = y; }
    }
    return min === null ? null : String(min);
  }

  const DEFAULT_RANKING_PREFS = {
    showRankingMarks: true,
    enabledSources: {},  // 空对象 = 所有 source 默认启用
  };

  /**
   * 把用户配置归一化为合法形态，防止损坏数据导致崩溃。
   * 未列在 enabledSources 里的 source 默认启用。
   * @param {*} raw
   * @returns {{showRankingMarks: boolean, enabledSources: object}}
   */
  function normalizeRankingPrefs(raw) {
    const next = {
      showRankingMarks: DEFAULT_RANKING_PREFS.showRankingMarks,
      enabledSources: { ...DEFAULT_RANKING_PREFS.enabledSources },
    };
    if (!raw || typeof raw !== 'object') return next;
    next.showRankingMarks = raw.showRankingMarks !== false;
    if (raw.enabledSources && typeof raw.enabledSources === 'object') {
      next.enabledSources = { ...raw.enabledSources };
    }
    return next;
  }

  /**
   * 并发限流门 — 手工维护活跃数，避免 Promise.all 一次性发大量请求。
   * v1 用不上（只请求 1-2 个 JSON），为 v2 多源并发预留。
   * @param {number} maxConcurrency
   */
  function ConcurrencyGate(maxConcurrency) {
    let active = 0;
    const queue = [];
    function next() {
      if (active >= maxConcurrency || queue.length === 0) return;
      active += 1;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(
        (v) => { active -= 1; resolve(v); next(); },
        (e) => { active -= 1; reject(e); next(); }
      );
    }
    return {
      run(fn) {
        return new Promise((resolve, reject) => {
          queue.push({ fn, resolve, reject });
          next();
        });
      },
    };
  }

  // ============================================================
  // PageAdapter — 识别条目类型，从 DOM 提取元信息
  // ============================================================

  /**
   * 返回当前页面对应的豆瓣条目类型。
   * @returns {'book'|'movie'|'music'|'game'|'unknown'}
   */
  function detectType() {
    const host = location.host;
    const path = location.pathname || '';

    if (host.startsWith('book.')) return 'book';
    if (host.startsWith('movie.')) return 'movie';
    if (host.startsWith('music.')) return 'music';
    if (host.startsWith('game.')) return 'game';

    // 社区游戏条目：https://www.douban.com/game/xxxxxxx/
    if (host === 'www.douban.com' && path.startsWith('/game/')) return 'game';

    if (host === 'www.douban.com' && path.startsWith('/location/drama/')) return 'drama';
    if (host === 'www.douban.com' && path.startsWith('/podcast/')) return 'podcast';

    return 'unknown';
  }

  /**
   * 读取豆瓣条目页 DOM，返回统一的元信息对象（ItemMeta）。
   *
   * @returns {{
   *   type: string,
   *   doubanId: string|null,
   *   title: string|null,
   *   originalTitle: string|null,
   *   creator: string|null,
   *   isbn: string|null,
   *   imdbId: string|null,
   *   year: string|null,
   *   genres: string[],
   * }}
   */
  function extractMeta() {
    const type = detectType();

    // --- doubanId ---
    const subjectMatch = location.pathname.match(/\/subject\/(\d+)/);
    const gameMatch = location.pathname.match(/\/game\/(\d+)/);
    const dramaMatch = location.pathname.match(/\/location\/drama\/(\d+)/);
    const podcastMatch = location.pathname.match(/\/podcast\/(\d+)/);
    const doubanId = subjectMatch ? subjectMatch[1]
      : (gameMatch ? gameMatch[1]
      : (dramaMatch ? dramaMatch[1]
      : (podcastMatch ? podcastMatch[1] : null)));

    // --- title（h1 内容，去掉内嵌小字如 span.year）---
    let title = null;
    const h1 = document.querySelector('h1');
    if (h1) {
      // 克隆节点后移除 span.year，避免年份混入标题
      const clone = h1.cloneNode(true);
      const yearSpan = clone.querySelector('span.year');
      if (yearSpan) yearSpan.remove();
      title = clone.textContent.trim();
    }

    // --- 以下字段均从 #info 区域解析 ---
    const infoEl = document.querySelector('#info');
    const infoText = infoEl ? (infoEl.textContent || '') : '';

    // ISBN（书籍）
    let isbn = null;
    const isbnMatch = infoText.match(/ISBN:\s*([\dXx-]+)/);
    if (isbnMatch) isbn = isbnMatch[1].replace(/-/g, '');

    // 英文标题提取：多层 fallback
    let originalTitle = null;
    // 1. #info 原作名（仅含拉丁字母时采用，否则 fallback 到又名提取英文）
    const originalTitleMatch = infoText.match(/原作名:\s*(.+)/);
    if (originalTitleMatch && /[a-zA-Z]/.test(originalTitleMatch[1])) {
      originalTitle = originalTitleMatch[1].trim();
    }
    // 2. 又名/别名（取第一个纯 ASCII 项）
    //    电影/书籍：#info 内 "又名: A / B / C"
    //    游戏：<dt>别名:</dt><dd>A / B / C</dd>（无 #info）
    if (!originalTitle) {
      let aliasText = null;
      const alsoKnownMatch = infoText.match(/又名:\s*(.+)/);
      if (alsoKnownMatch) {
        aliasText = alsoKnownMatch[1];
      } else {
        const dts = document.querySelectorAll('dt');
        for (let i = 0; i < dts.length; i++) {
          if (dts[i].textContent.trim() === '别名:') {
            const dd = dts[i].nextElementSibling;
            if (dd) aliasText = dd.textContent.trim();
            break;
          }
        }
      }
      if (aliasText) {
        const candidates = aliasText.split(/\s*\/\s*/);
        const englishName = candidates.find((c) => /^[\x20-\x7E]+$/.test(c.trim()));
        if (englishName) originalTitle = englishName.trim();
      }
    }
    // h1 span[property="v:itemreviewed"] 的拉丁文段（参考：豆瓣资源下载大师的方法）。
    // 单独算出来：既作为 originalTitle 的 fallback，也作为「备选英文名」供 RT/MC 二次搜索。
    // 这是消除歧义的关键——又名首个英文别名可能是数字形（如「碟中谍8」给 "Mission: Impossible 8"），
    // 而 h1 拉丁段往往是规范英文官方名（"Mission: Impossible - The Final Reckoning"）。
    // 反之外语片 h1 是原文名（意大利语等），又名才是 RT/MC 用的英文名——故二者都留作候选，按年份择优。
    let h1LatinTitle = null;
    const reviewedEl = document.querySelector('#content h1 span[property="v:itemreviewed"]');
    if (reviewedEl) {
      const engMatch = reviewedEl.textContent.trim().match(/([A-Za-z][A-Za-z0-9 :&'.,-]{2,})/);
      if (engMatch) h1LatinTitle = engMatch[1].trim();
    }
    // 3. h1 拉丁段
    if (!originalTitle && h1LatinTitle) originalTitle = h1LatinTitle;
    // 4. 最终 fallback：直接从 title 变量提取英文段
    if (!originalTitle && title) {
      const engMatch = title.match(/([A-Za-z][A-Za-z0-9 :&'.,-]{2,})/);
      if (engMatch) originalTitle = engMatch[1].trim();
    }
    // 备选英文名：h1 拉丁段若与 originalTitle 不同，则留作二次搜索候选
    const altTitle = (h1LatinTitle && h1LatinTitle !== originalTitle) ? h1LatinTitle : null;

    // 主要创作者（作者/导演/表演者/艺术家/开发/制作人）
    let creator = null;
    if (infoEl) {
      const labels = Array.from(infoEl.querySelectorAll('span.pl'));
      const creatorSpan = labels.find((span) => {
        const t = span.textContent.trim();
        return (
          t.includes('作者') ||
          t.includes('导演') ||
          t.includes('表演者') ||
          t.includes('艺术家') ||
          t.includes('开发') ||
          t.includes('制作人')
        );
      });
      if (creatorSpan) {
        // 下一兄弟元素可能是 <a>，也可能是文本节点
        const next = creatorSpan.nextElementSibling;
        if (next && next.tagName === 'A') {
          creator = next.textContent.trim();
        } else if (creatorSpan.nextSibling) {
          creator = creatorSpan.nextSibling.textContent.trim();
        }
        // Sanitize: 取前导单一脚本字符串（前导 CJK 或前导 Latin），
        // 防御浏览器侧 DOM 注入（翻译扩展、注解插件等）污染作者名，
        // 例如把 "郑执" 变成 "郑gums"，进而污染 Amazon/Goodreads 等的搜索查询
        if (creator) {
          const m = creator.match(/^([一-鿿]+|[A-Za-z][A-Za-z\s.'\-]*)/);
          if (m) creator = m[1].trim();
        }
      }
    }

    // IMDb ID — 用正则从 #info 全文提取，比 DOM 遍历更稳健
    // 兼容多种格式：纯文本节点、<a> 标签包裹、冒号在 span 内外
    let imdbId = null;
    if (infoEl) {
      const imdbMatch = infoEl.textContent.match(/IMDb\s*(?:链接)?\s*:?\s*(tt\d+)/i);
      if (imdbMatch) {
        imdbId = imdbMatch[1];
      } else {
        // 备选：从 <a> 链接 href 中提取
        const imdbLink = infoEl.querySelector('a[href*="imdb.com/title/tt"]');
        if (imdbLink) {
          const hrefMatch = imdbLink.href.match(/(tt\d+)/);
          if (hrefMatch) imdbId = hrefMatch[1];
        }
      }
    }

    // 年份：电影用 [property="v:initialReleaseDate"]，书籍用「出版年:」。
    // 电影取所有上映日期里的最早年（= 原始上映年），规避豆瓣把中国重映排在最前的坑。
    let year = null;
    const releaseEls = document.querySelectorAll('[property="v:initialReleaseDate"]');
    if (releaseEls.length) {
      year = earliestReleaseYear(Array.from(releaseEls).map(function (el) { return el.textContent; }));
    }
    if (!year) {
      const pubYearMatch = infoText.match(/出版年:\s*(\d{4})/);
      if (pubYearMatch) year = pubYearMatch[1];
    }

    // 类型标签（电影专属）
    const genreEls = document.querySelectorAll('[property="v:genre"]');
    const genres = Array.from(genreEls).map((el) => el.textContent.trim());

    // Fallback for drama pages (no #info, metadata in dl inside div.meta)
    if (!infoEl && detectType() === 'drama') {
      const metaDiv = document.querySelector('div.meta');
      if (metaDiv) {
        const nameEl = metaDiv.querySelector('[itemprop="name"]');
        if (nameEl && !title) title = nameEl.textContent.trim();
      }
    }

    return {
      type,
      doubanId,
      title,
      originalTitle,
      altTitle,
      creator,
      isbn,
      imdbId,
      year,
      genres,
    };
  }

  // ============================================================
  // Cache — 按 channel 缓存评分结果
  // ============================================================

  const CACHE_TTL_SUCCESS = 7 * 24 * 60 * 60 * 1000;    // 7 天
  const CACHE_TTL_NEGATIVE = 24 * 60 * 60 * 1000;        // 1 天
  const CACHE_TTL_RATE_LIMITED = 5 * 60 * 1000;           // 5 分钟
  const CACHE_TTL_ERROR_SHORT = 30 * 60 * 1000;           // 30 分钟（首次/偶发错误）
  const CACHE_TTL_ERROR_LONG = 7 * 24 * 60 * 60 * 1000;   // 7 天（连续失败后升级）
  const ERROR_ESCALATE_THRESHOLD = 3;                     // 连续 N 次错误后升级到长 TTL
  const FAILURE_RECORD_TTL = 30 * 24 * 60 * 60 * 1000;    // 失败计数本身 30 天后过期

  const CACHE_PREFIX = 'rh2:';

  function cacheKey(doubanId, channelKey, sourceVersion) {
    return CACHE_PREFIX + doubanId + ':' + channelKey + ':' + sourceVersion;
  }

  function failureKey(doubanId, channelKey) {
    return CACHE_PREFIX + 'fail:' + doubanId + ':' + channelKey;
  }

  function getFailureCount(doubanId, channelKey) {
    const key = failureKey(doubanId, channelKey);
    const entry = deps.storage.get(key);
    if (!entry) return 0;
    if (entry.fetchedAt && entry.ttl && Date.now() > entry.fetchedAt + entry.ttl) {
      deps.storage.remove(key);
      return 0;
    }
    return entry.count || 0;
  }

  function incrementFailureCount(doubanId, channelKey) {
    const current = getFailureCount(doubanId, channelKey);
    const newCount = current + 1;
    deps.storage.set(failureKey(doubanId, channelKey), {
      count: newCount,
      fetchedAt: Date.now(),
      ttl: FAILURE_RECORD_TTL,
    });
    return newCount;
  }

  function resetFailureCount(doubanId, channelKey) {
    deps.storage.remove(failureKey(doubanId, channelKey));
  }

  // SlugMap — 跨平台身份缓存（豆瓣 ID → 各 channel 详情页 URL）
  // 长 TTL（90 天），用于在 channel cache 过期后跳过 fuzzy 搜索步骤，
  // 直接拼出 URL 抓分。slug/detail-URL 几乎不变，但分数会变，因此分两层 TTL。
  const SLUGMAP_TTL = 90 * 24 * 60 * 60 * 1000;  // 90 天

  function slugMapKey(doubanId) {
    return CACHE_PREFIX + 'slugmap:' + doubanId;
  }

  function getSlugMap(doubanId) {
    if (!doubanId) return null;
    const entry = deps.storage.get(slugMapKey(doubanId));
    if (!entry) return null;
    if (entry.fetchedAt && entry.ttl && Date.now() > entry.fetchedAt + entry.ttl) {
      deps.storage.remove(slugMapKey(doubanId));
      return null;
    }
    return entry.data || null;
  }

  function addChannelUrlToSlugMap(doubanId, channelKey, channelResult) {
    if (!doubanId || !channelKey || !channelResult || !channelResult.url) return;
    const existing = getSlugMap(doubanId) || { channelUrls: {}, source: 'auto' };
    existing.channelUrls = existing.channelUrls || {};
    // manual override 不被自动写覆盖（P2b 预留 — 当前 'auto' 总是会写）
    if (existing.source === 'manual' && existing.channelUrls[channelKey]) return;
    const entry = {
      url: channelResult.url,
      matchedBy: channelResult.matchedBy || null,
      confidence: channelResult.matchConfidence || 'fuzzy',
    };
    const prev = existing.channelUrls[channelKey];
    if (prev && prev.url === entry.url && prev.matchedBy === entry.matchedBy && prev.confidence === entry.confidence) {
      return;  // 无变化跳过写
    }
    existing.channelUrls[channelKey] = entry;
    deps.storage.set(slugMapKey(doubanId), {
      data: existing,
      fetchedAt: Date.now(),
      ttl: SLUGMAP_TTL,
    });
  }

  function getCache(doubanId, channelKey, sourceVersion) {
    const key = cacheKey(doubanId, channelKey, sourceVersion);
    const entry = deps.storage.get(key);
    if (!entry) return null;

    const ttl = entry.ttl || 0;
    if (Date.now() > entry.fetchedAt + ttl) {
      deps.storage.remove(key);
      return null;
    }
    return entry.result;
  }

  function setCache(doubanId, channelKey, sourceVersion, channelResult) {
    const status = channelResult && channelResult.status;
    // disabled 不缓存（配置缺失时希望用户改完立即生效）
    if (!status || status === 'disabled') return;

    let ttl;
    if (status === 'error') {
      // 负缓存：默认 30 分钟，连续失败 3 次后升级到 7 天（视为暂不可用，避免 hammer）
      const failCount = incrementFailureCount(doubanId, channelKey);
      ttl = failCount >= ERROR_ESCALATE_THRESHOLD ? CACHE_TTL_ERROR_LONG : CACHE_TTL_ERROR_SHORT;
    } else {
      // 任何非 error 响应（success / no_match / no_rating / rate_limited）说明 channel 仍在响应，
      // 重置失败计数
      resetFailureCount(doubanId, channelKey);
      if (status === 'rate_limited') {
        ttl = CACHE_TTL_RATE_LIMITED;
      } else if (status === 'no_match' || status === 'no_rating') {
        ttl = CACHE_TTL_NEGATIVE;
      } else {
        // success
        ttl = CACHE_TTL_SUCCESS;
      }
    }

    const key = cacheKey(doubanId, channelKey, sourceVersion);
    deps.storage.set(key, { fetchedAt: Date.now(), ttl: ttl, result: channelResult });
  }

  function evictStale() {
    const keys = deps.storage.listKeys();
    let removed = 0;
    const now = Date.now();
    keys.forEach(function (key) {
      // 清理新旧前缀的缓存条目，跳过配置键和冷却键
      if (!key.startsWith('rh:') && !key.startsWith('rh2:')) return;
      if (key === 'rh:config' || key.startsWith('rh:cooldown:')) return;

      const entry = deps.storage.get(key);
      if (entry && typeof entry.fetchedAt === 'number' && typeof entry.ttl === 'number') {
        if (now > entry.fetchedAt + entry.ttl) {
          deps.storage.remove(key);
          removed++;
        }
      }
    });
    if (removed > 0) deps.log('evictStale: removed', removed, 'stale cache entries');
  }

  // ============================================================
  // Config — 用户设置面板与持久化
  // ============================================================

  const DEFAULT_CONFIG = {
    tmdbApiKey: '',
    traktClientId: '',
    enabledSources: {},
  };

  function readConfig() {
    const stored = deps.storage.get('rh:config', {});
    return Object.assign({}, DEFAULT_CONFIG, stored, {
      enabledSources: Object.assign({}, DEFAULT_CONFIG.enabledSources, stored.enabledSources || {}),
    });
  }

  function saveConfig(config) {
    deps.storage.set('rh:config', config);
  }

  let activeConfigKeydownHandler = null;

  function getSourceTypeLabels(source) {
    const typeLabels = {
      movie: '影视',
      book: '图书',
      music: '音乐',
      game: '游戏',
      drama: '舞台剧',
      podcast: '播客',
    };
    return (source.types || [])
      .map(function (type) { return typeLabels[type] || type; })
      .join(' / ');
  }

  function isSourceRelevantForMeta(source, meta) {
    if (!source.types || source.types.indexOf(meta.type) === -1) return false;
    return true;
  }

  function buildSourceToggleSection(title, description, items, config) {
    if (!items || items.length === 0) return null;

    const section = document.createElement('section');
    section.className = 'rh-config-section';

    const heading = document.createElement('h4');
    heading.className = 'rh-config-section-title';
    heading.textContent = title;
    section.appendChild(heading);

    if (description) {
      const desc = document.createElement('p');
      desc.className = 'rh-config-section-desc';
      desc.textContent = description;
      section.appendChild(desc);
    }

    const list = document.createElement('div');
    list.className = 'rh-config-source-list';
    section.appendChild(list);

    const checkboxes = {};
    items.forEach(function (src) {
      const row = document.createElement('label');
      row.className = 'rh-config-source';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'rh-config-checkbox';
      cb.checked = config.enabledSources[src.key] !== false;
      checkboxes[src.key] = cb;

      const textWrap = document.createElement('span');
      textWrap.className = 'rh-config-source-text';

      const name = document.createElement('span');
      name.className = 'rh-config-source-name';
      name.textContent = src.label || src.key;

      const meta = document.createElement('span');
      meta.className = 'rh-config-source-meta';
      meta.textContent = getSourceTypeLabels(src);

      textWrap.appendChild(name);
      if (meta.textContent) textWrap.appendChild(meta);

      row.appendChild(cb);
      row.appendChild(textWrap);
      list.appendChild(row);
    });

    section._checkboxes = checkboxes;
    return section;
  }

  function openConfigPanel(sources) {
    ensureStyles();

    // 面板已存在则关闭（Toggle 行为）
    const existing = document.getElementById('rh-config-overlay');
    if (existing) {
      if (activeConfigKeydownHandler) {
        document.removeEventListener('keydown', activeConfigKeydownHandler);
        activeConfigKeydownHandler = null;
      }
      existing.remove();
      return;
    }

    const config = readConfig();
    const meta = extractMeta();
    const currentSources = [];
    const otherSources = [];
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    sources.forEach(function (src) {
      if (isSourceRelevantForMeta(src, meta)) currentSources.push(src);
      else otherSources.push(src);
    });

    // 遮罩层
    const overlay = document.createElement('div');
    overlay.id = 'rh-config-overlay';
    overlay.className = 'rh-config-overlay';

    // 面板
    const panel = document.createElement('div');
    panel.className = 'rh-config-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'rh-config-title');
    panel.setAttribute('tabindex', '-1');

    // 标题
    const heading = document.createElement('h3');
    heading.id = 'rh-config-title';
    heading.className = 'rh-config-title';
    heading.textContent = '评分汇设置';
    panel.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'rh-config-intro';
    intro.textContent = '这里仅控制评分来源的显示方式，条目主内容仍保持豆瓣原样。';
    panel.appendChild(intro);

    // TMDB API Key 输入框
    const tmdbSection = document.createElement('section');
    tmdbSection.className = 'rh-config-section';

    const tmdbHeading = document.createElement('h4');
    tmdbHeading.className = 'rh-config-section-title';
    tmdbHeading.textContent = 'TMDB Key（可选）';
    tmdbSection.appendChild(tmdbHeading);

    const tmdbHelp = document.createElement('p');
    tmdbHelp.id = 'rh-config-tmdb-help';
    tmdbHelp.className = 'rh-config-section-desc';
    tmdbHelp.textContent = '只在电影/剧集页用于显示 TMDB 评分。不填写也能正常使用，只是不显示这一项。';
    tmdbSection.appendChild(tmdbHelp);

    const tmdbLabel = document.createElement('label');
    tmdbLabel.className = 'rh-config-field-label';
    tmdbLabel.textContent = 'TMDB API Key';
    const tmdbInput = document.createElement('input');
    tmdbInput.type = 'text';
    tmdbInput.autocomplete = 'off';
    tmdbInput.spellcheck = false;
    tmdbInput.value = config.tmdbApiKey || '';
    tmdbInput.placeholder = '留空即可';
    tmdbInput.className = 'rh-config-input';
    tmdbInput.setAttribute('aria-describedby', 'rh-config-tmdb-help');
    tmdbSection.appendChild(tmdbLabel);
    tmdbSection.appendChild(tmdbInput);
    panel.appendChild(tmdbSection);

    // Trakt Client ID 输入框（电影/剧集页可选）
    const traktSection = document.createElement('section');
    traktSection.className = 'rh-config-section';

    const traktHeading = document.createElement('h4');
    traktHeading.className = 'rh-config-section-title';
    traktHeading.textContent = 'Trakt Client ID（可选）';
    traktSection.appendChild(traktHeading);

    const traktHelp = document.createElement('p');
    traktHelp.id = 'rh-config-trakt-help';
    traktHelp.className = 'rh-config-section-desc';
    traktHelp.textContent = '只在电影/剧集页用于显示 Trakt 评分。需在 trakt.tv/oauth/applications/new 注册一个 app 获取 Client ID（无需 OAuth、不暴露个人信息）。留空则不显示这一行。';
    traktSection.appendChild(traktHelp);

    const traktLabel = document.createElement('label');
    traktLabel.className = 'rh-config-field-label';
    traktLabel.textContent = 'Trakt Client ID';
    const traktInput = document.createElement('input');
    traktInput.type = 'text';
    traktInput.autocomplete = 'off';
    traktInput.spellcheck = false;
    traktInput.value = config.traktClientId || '';
    traktInput.placeholder = '留空即可';
    traktInput.className = 'rh-config-input';
    traktInput.setAttribute('aria-describedby', 'rh-config-trakt-help');
    traktSection.appendChild(traktLabel);
    traktSection.appendChild(traktInput);
    panel.appendChild(traktSection);

    // 数据来源启用/禁用
    if (sources && sources.length > 0) {
      const currentLabelMap = {
        movie: '当前影视页会显示的来源',
        book: '当前图书页会显示的来源',
        music: '当前音乐页会显示的来源',
        game: '当前游戏页会显示的来源',
        drama: '当前舞台剧页会显示的来源',
        podcast: '当前播客页会显示的来源',
      };

      const currentSection = buildSourceToggleSection(
        currentLabelMap[meta.type] || '当前页面会显示的来源',
        '先列出和当前页面最相关的来源，避免一次看到过多设置。',
        currentSources,
        config
      );
      if (currentSection) panel.appendChild(currentSection);

      if (otherSources.length > 0) {
        const disclosure = document.createElement('details');
        disclosure.className = 'rh-config-disclosure';

        const summary = document.createElement('summary');
        summary.className = 'rh-config-disclosure-summary';
        summary.textContent = '其他条目类型的来源';
        disclosure.appendChild(summary);

        const otherSection = buildSourceToggleSection(
          '其他来源',
          '这些来源不会出现在当前页面，但会影响书、影、音、游戏等其他条目页。',
          otherSources,
          config
        );
        if (otherSection) disclosure.appendChild(otherSection);
        panel.appendChild(disclosure);
      }

      const mergedCheckboxes = {};
      panel.querySelectorAll('.rh-config-section, .rh-config-disclosure').forEach(function (section) {
        if (!section._checkboxes) return;
        Object.keys(section._checkboxes).forEach(function (key) {
          mergedCheckboxes[key] = section._checkboxes[key];
        });
      });
      panel._checkboxes = mergedCheckboxes;
    }

    const footnote = document.createElement('p');
    footnote.className = 'rh-config-footnote';
    footnote.textContent = '来源开关会在刷新当前页面后生效。';
    panel.appendChild(footnote);

    // v1.1.0: 榜单显示 section
    buildRankingPrefsSection(panel);

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.className = 'rh-config-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '关闭';
    cancelBtn.className = 'rh-config-button rh-config-button-secondary';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存并刷新';
    saveBtn.className = 'rh-config-button rh-config-button-primary';

    function closeOverlay() {
      if (activeConfigKeydownHandler) {
        document.removeEventListener('keydown', activeConfigKeydownHandler);
        activeConfigKeydownHandler = null;
      }
      overlay.remove();
      if (previousActiveElement) previousActiveElement.focus();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay();
      }
    }

    cancelBtn.addEventListener('click', function () { closeOverlay(); });
    saveBtn.addEventListener('click', function () {
      const newConfig = readConfig();
      newConfig.tmdbApiKey = tmdbInput.value.trim();
      newConfig.traktClientId = traktInput.value.trim();
      if (panel._checkboxes) {
        Object.keys(panel._checkboxes).forEach(function (k) {
          newConfig.enabledSources[k] = panel._checkboxes[k].checked;
        });
      }
      saveConfig(newConfig);
      closeOverlay();
      location.reload();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    panel.appendChild(btnRow);

    // 点击遮罩背景关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeOverlay();
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    activeConfigKeydownHandler = onKeyDown;
    document.addEventListener('keydown', activeConfigKeydownHandler);
    tmdbInput.focus();
  }

  /**
   * v1.1.0: 在配置面板里添加"⭐ 榜单显示" section。
   * 读 cache 里已识别的 source 列表生成 checkbox；每个 checkbox 变化立刻保存。
   */
  function buildRankingPrefsSection(panelEl) {
    const section = document.createElement('div');
    section.className = 'rh-config-disclosure';
    section.id = 'rh-config-ranking-section';

    const heading = document.createElement('h4');
    heading.textContent = '⭐ 榜单显示';
    heading.style.cssText = 'margin:14px 0 8px;font-size:13px;color:#333;';
    section.appendChild(heading);

    const prefs = normalizeRankingPrefs(deps.storage.get('rating_hub_ranking_prefs_v1'));

    // 总开关
    const masterLabel = document.createElement('label');
    masterLabel.className = 'rh-config-source';
    masterLabel.innerHTML = ''
      + '<input type="checkbox" class="rh-config-checkbox" ' + (prefs.showRankingMarks ? 'checked' : '') + '>'
      + '<span class="rh-config-source-text">'
      +   '<span class="rh-config-source-name">显示榜单胶囊（总开关）</span>'
      + '</span>';
    const masterCheckbox = masterLabel.querySelector('input');
    masterCheckbox.addEventListener('change', function () {
      const cur = normalizeRankingPrefs(deps.storage.get('rating_hub_ranking_prefs_v1'));
      cur.showRankingMarks = !!masterCheckbox.checked;
      deps.storage.set('rating_hub_ranking_prefs_v1', cur);
    });
    section.appendChild(masterLabel);

    // 汇总所有 category cache 里已识别的 source（v1 起不再只读 movie）
    const storageKeys = deps.storage.listKeys();
    const CACHE_PREFIX = 'rating_hub_rankings_cache_v1:';
    const sources = {};
    const sourceCategory = {};  // 记录每个 source 属哪个 category，用于 "启用的榜单（movie · 电影）"
    for (let i = 0; i < storageKeys.length; i++) {
      const k = storageKeys[i];
      if (k.indexOf(CACHE_PREFIX) !== 0) continue;
      const cat = k.slice(CACHE_PREFIX.length);
      const cached = deps.storage.get(k);
      const cs = cached && cached.data && cached.data.categories
        && cached.data.categories[cat] && cached.data.categories[cat].sources;
      if (!cs) continue;
      Object.keys(cs).forEach(function (sid) {
        sources[sid] = cs[sid];
        sourceCategory[sid] = cat;
      });
    }
    const sourceIds = Object.keys(sources);

    if (sourceIds.length === 0) {
      const hint = document.createElement('p');
      hint.style.cssText = 'color:#888;font-size:12px;margin:8px 0 0;';
      hint.textContent = '榜单数据尚未加载。访问一次豆瓣电影或音乐条目页后回来此处即可看到已识别的榜单。';
      section.appendChild(hint);
    } else {
      const listLabel = document.createElement('div');
      listLabel.style.cssText = 'color:#888;font-size:12px;margin:8px 0 4px;';
      listLabel.textContent = '启用的榜单（已识别）：';
      section.appendChild(listLabel);

      // 先按 category 聚类，再按 priority 排序
      sourceIds.sort(function (a, b) {
        const catCmp = (sourceCategory[a] || '').localeCompare(sourceCategory[b] || '');
        if (catCmp !== 0) return catCmp;
        return (sources[a].priority || 99) - (sources[b].priority || 99);
      });

      sourceIds.forEach(function (sid) {
        const src = sources[sid];
        const enabled = prefs.enabledSources[sid] !== false;
        const label = document.createElement('label');
        label.className = 'rh-config-source';
        const kindText = src.kind === 'permanent' ? '永久' : (src.kind === 'yearly' ? '年度' : '时效');
        const catText = sourceCategory[sid] || '?';
        label.innerHTML = ''
          + '<input type="checkbox" class="rh-config-checkbox" ' + (enabled ? 'checked' : '') + '>'
          + '<span class="rh-config-source-text">'
          +   '<span class="rh-config-source-name">' + escapeHtml(src.titleZh || src.title || sid) + '</span>'
          +   '<span class="rh-config-source-meta">' + escapeHtml(catText + ' · ' + kindText + ' · ' + (src.itemCount || '?')) + '</span>'
          + '</span>';
        const cb = label.querySelector('input');
        cb.addEventListener('change', function () {
          const cur = normalizeRankingPrefs(deps.storage.get('rating_hub_ranking_prefs_v1'));
          cur.enabledSources[sid] = !!cb.checked;
          deps.storage.set('rating_hub_ranking_prefs_v1', cur);
        });
        section.appendChild(label);
      });
    }

    // 数据来源提示 + 刷新按钮
    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:10px;color:#888;font-size:12px;';
    footer.innerHTML = '数据每周更新自 <code>rank.douban.zhili.dev</code> ';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'rh-config-button rh-config-button-secondary';
    refreshBtn.style.cssText = 'padding:2px 10px;font-size:12px;min-height:24px;margin-left:6px;';
    refreshBtn.textContent = '🔄 强制刷新缓存';
    refreshBtn.addEventListener('click', function () {
      RankingData.forceRefresh();
      alert('榜单缓存已清空。刷新页面后会重新拉取数据。');
    });
    footer.appendChild(refreshBtn);
    section.appendChild(footer);

    panelEl.appendChild(section);
  }

  function registerMenu(sources) {
    GM_registerMenuCommand('⚙ 评分汇设置', function () { openConfigPanel(sources); });
    GM_registerMenuCommand('🔄 强制刷新榜单数据', function () {
      RankingData.forceRefresh();
      if (confirm('榜单缓存已清空。立即刷新页面？')) {
        location.reload();
      }
    });
    GM_registerMenuCommand('🗑 清除当前条目评分缓存', function () {
      const m = location.pathname.match(/\/(?:subject|game|location\/drama|podcast)\/(\d+)/);
      if (!m) {
        alert('未识别到豆瓣条目 ID。请在条目页（如 /subject/12345/）执行。');
        return;
      }
      const doubanId = m[1];
      // 清三类 key：
      // 1. channel cache: rh2:{doubanId}:{channel}:{ver}
      // 2. slugMap:      rh2:slugmap:{doubanId}
      // 3. 失败计数:      rh2:fail:{doubanId}:{channel}
      const channelPrefix = CACHE_PREFIX + doubanId + ':';
      const slugMapKeyExact = CACHE_PREFIX + 'slugmap:' + doubanId;
      const failPrefix = CACHE_PREFIX + 'fail:' + doubanId + ':';
      const keys = deps.storage.listKeys();
      let removed = 0;
      keys.forEach(function (key) {
        if (key.indexOf(channelPrefix) === 0
            || key === slugMapKeyExact
            || key.indexOf(failPrefix) === 0) {
          deps.storage.remove(key);
          removed++;
        }
      });
      if (confirm('已清除 ' + removed + ' 条评分缓存（条目 ' + doubanId + '）。立即刷新页面以重新拉取？')) {
        location.reload();
      }
    });
  }

  // ============================================================
  // Renderer — 确定性插槽式 UI 渲染
  // ============================================================

  function ensureStyles() {
    if (document.getElementById('rating-hub-style')) return;
    const style = document.createElement('style');
    style.id = 'rating-hub-style';
    style.textContent = [
      '.rating-hub-container { margin-top: 0; padding: 12px 0 0; border-top: 1px solid #eaeaea; font-size: 12px; color: #333; }',
      '.rating-hub-row { display: grid; grid-template-columns: 101px minmax(40px, auto) minmax(0, 1fr); align-items: center; column-gap: 3px; min-height: 24px; }',
      '.rating-hub-label { display: inline-flex; align-items: center; min-width: 0; color: #37a; text-decoration: none; border-radius: 3px; padding: 0 2px; transition: color 0.16s ease-out, background-color 0.16s ease-out, box-shadow 0.16s ease-out; font-size: 12px; line-height: 1.2; }',
      '.rating-hub-score { display: inline-flex; align-items: center; justify-self: start; gap: 0; color: #2f2f2f; font-variant-numeric: tabular-nums; min-width: 3.2em; letter-spacing: 0.01em; line-height: 1; white-space: nowrap; }',
      '.rating-hub-score-main { font-weight: 700; color: #2f2f2f; }',
      '.rating-hub-score-suffix { font-size: 11px; font-weight: 500; color: #8f8f8f; }',
      '.rating-hub-label:hover { color: #fff; background-color: #37a; }',
      '.rating-hub-label.no-link { cursor: default; }',
      '.rating-hub-label.no-link:hover { color: #37a; background-color: transparent; }',
      '.rating-hub-label:focus-visible, .rating-hub-status a:focus-visible, .rh-config-button:focus-visible, .rh-config-input:focus-visible, .rh-config-checkbox:focus-visible, .rh-config-disclosure-summary:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(55, 119, 170, 0.28); background-color: rgba(55, 119, 170, 0.08); }',
      '.rating-hub-count { color: #777; justify-self: start; margin-left: 0; font-variant-numeric: tabular-nums; min-width: 0; white-space: nowrap; line-height: 1; }',
      '.rating-hub-row[data-confidence="fuzzy"] .rating-hub-score { opacity: 0.72; }',
      '.rating-hub-fuzzy-mark { color: #b39a6c; font-weight: 400; margin-left: 3px; font-size: 11px; cursor: help; line-height: 1; user-select: none; }',
      '.rating-hub-status { color: #666; grid-column: 2 / span 2; min-width: 0; white-space: nowrap; line-height: 1.2; }',
      '.rating-hub-status a { color: #37a; text-decoration: none; }',
      '.rating-hub-status a:hover { text-decoration: underline; }',
      '.rating-hub-row[data-status="loading"] .rating-hub-status, .rating-hub-row[data-status="no_match"] .rating-hub-status, .rating-hub-row[data-status="no_rating"] .rating-hub-status { color: #777; }',
      '.rating-hub-row[data-status="rate_limited"] .rating-hub-status, .rating-hub-row[data-status="error"] .rating-hub-status { color: #7a6a55; }',
      '.rating-hub-row[data-status="disabled"] .rating-hub-status { color: #666; }',
      '.rating-hub-row-hidden { display: none; }',
      '.rating-hub-icon { width: 14px; height: 14px; vertical-align: middle; margin-right: 4px; border-radius: 2px; flex-shrink: 0; }',
      '.rating-hub-toggle { display: inline-block; margin-top: 4px; color: #37a; text-decoration: none; font-size: 12px; line-height: 1.4; }',
      '.rating-hub-toggle:hover { text-decoration: underline; }',
      '.rh-config-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0, 0, 0, 0.28); z-index: 999999; }',
      '.rh-config-panel { width: min(520px, calc(100vw - 24px)); max-height: min(78vh, 720px); overflow: auto; background: #fff; color: #333; border: 1px solid #d8d2c4; border-radius: 8px; box-shadow: 0 14px 34px rgba(26, 26, 26, 0.16); padding: 20px 22px 18px; font: 13px/1.65 Helvetica, Arial, sans-serif; }',
      '.rh-config-title { margin: 0; font-size: 16px; font-weight: 700; color: #494949; }',
      '.rh-config-intro { margin: 8px 0 14px; color: #666; }',
      '.rh-config-section { margin-top: 14px; }',
      '.rh-config-section-title { margin: 0 0 4px; font-size: 13px; font-weight: 700; color: #494949; }',
      '.rh-config-section-desc { margin: 0 0 10px; color: #777; }',
      '.rh-config-field-label { display: block; margin-bottom: 6px; color: #555; font-weight: 600; }',
      '.rh-config-input { display: block; width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid #c9c3b8; border-radius: 4px; color: #333; background: #fff; transition: border-color 0.16s ease-out, box-shadow 0.16s ease-out; }',
      '.rh-config-input:hover { border-color: #b5aea1; }',
      '.rh-config-source-list { display: grid; gap: 6px; }',
      '.rh-config-source { display: flex; align-items: flex-start; gap: 10px; padding: 7px 8px; border-radius: 6px; cursor: pointer; transition: background-color 0.16s ease-out; }',
      '.rh-config-source:hover { background: #f7f4ed; }',
      '.rh-config-checkbox { margin-top: 2px; accent-color: #4f946e; }',
      '.rh-config-source-text { display: flex; min-width: 0; flex: 1; align-items: baseline; justify-content: space-between; gap: 10px; }',
      '.rh-config-source-name { color: #333; }',
      '.rh-config-source-meta { color: #999; white-space: nowrap; }',
      '.rh-config-disclosure { margin-top: 14px; border-top: 1px solid #eee9dd; padding-top: 12px; }',
      '.rh-config-disclosure-summary { color: #37a; cursor: pointer; user-select: none; }',
      '.rh-config-disclosure-summary:hover { text-decoration: underline; }',
      '.rh-config-footnote { margin: 14px 0 0; color: #999; }',
      '.rh-config-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }',
      '.rh-config-button { min-height: 34px; padding: 0 16px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; transition: background-color 0.16s ease-out, border-color 0.16s ease-out, color 0.16s ease-out; }',
      '.rh-config-button-secondary { border-color: #d8d2c4; background: #fff; color: #666; }',
      '.rh-config-button-secondary:hover { border-color: #c9c3b8; background: #faf8f2; }',
      '.rh-config-button-primary { border-color: #4f946e; background: #5c9d78; color: #fff; font-weight: 600; }',
      '.rh-config-button-primary:hover { border-color: #467f61; background: #508a69; }',
      '@media (max-width: 480px) { .rating-hub-container { font-size: 13px; padding-top: 10px; } .rating-hub-row { grid-template-columns: 93px minmax(38px, auto) minmax(0, 1fr); column-gap: 3px; min-height: 23px; } .rh-config-overlay { padding: 12px; } .rh-config-panel { max-height: calc(100vh - 24px); padding: 16px; } .rh-config-source-text { display: block; } .rh-config-source-meta { display: block; margin-top: 2px; white-space: normal; } .rh-config-actions { flex-wrap: wrap; } .rh-config-button { flex: 1 1 140px; } }',
      '@media (prefers-reduced-motion: reduce) { .rating-hub-label, .rh-config-source, .rh-config-input, .rh-config-button { transition: none; } }',
      // ========== 榜单胶囊（v1.1.0 新增） ==========
      // 让豆瓣原生 .top250（默认 block）变 inline-flex，这样我们的胶囊能和它并排
      '.top250:has(+ .rating-hub-rank-marks), .rank-label.rank-label-other:has(+ .rating-hub-rank-marks) { display: inline-flex !important; vertical-align: middle; margin-right: 0 !important; }',
      '.rating-hub-rank-marks { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 5px 0; vertical-align: middle; }',
      // 我们容器紧跟豆瓣原生胶囊时，补 6px 左间距保持节奏一致
      '.top250 + .rating-hub-rank-marks, .rank-label.rank-label-other + .rating-hub-rank-marks { margin-left: 6px; }',
      // ===== 内联豆瓣原生 rank-label CSS（带 base64 PNG 纹理）=====
      // 目的：即使条目页没有豆瓣原生 .rank-label 导致豆瓣 CSS 未加载时，我们的胶囊仍然正确渲染
      '.rating-hub-rank-marks .rank-label { align-items:center; border-radius:3px; display:inline-flex; font:12px Helvetica,Arial,sans-serif; margin:5px 0; overflow:hidden; position:relative; }',
      '.rating-hub-rank-marks .rank-label:before { background:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAkCAYAAACJ8xqgAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFKADAAQAAAABAAAAJAAAAAAT/Eh7AAABQElEQVRIDbXVQXLDIAyFYdPpCbvrtvc/A7QN+mCixjNdiCwCT8jW7yeM29fnx7h+fo+/30n8WpuTEQu09XVB5NFvK6Fo8p7J3Lf3udICjba+xnSDekKVBxOidLumOX30R4ReZDeTA4TRRs1SuAexOG39bqwntM+yh1d4uONYJ5t96Xr6BKFX4dmVwdsAo2W1uMw2pOsJOxOUCgT7zjqNUNfF6XrCEe/spU2BsLs7A1k7n/aDzdkBQqbwEmGUBp6W1wPpvrx6QqeNcw+wMZOJ5+7T9YS6xAsE/x1z9+sJt4fPTLzTPXplOXw8Yuh6wuXBUHIyKOxTs3QgOl3E6QOEUSJ3GbnThOZhjtP1hHddRpLJ7uLy6gm3d6nLsfG84zsP4+vxBOGs9IcggPeJ/pooRw8Q5hKhkS0PfXtu8oXLCb8B7eSfBHIa+p4AAAAASUVORK5CYII=) repeat-x 100%/auto 100%; content:""; height:100%; left:0; position:absolute; top:0; width:100%; }',
      '.rating-hub-rank-marks .rank-label span { height:18px; line-height:18px; position:relative; text-align:center; }',
      '.rating-hub-rank-marks .rank-label a { background:none; color:#ffc46c; display:inline-block; height:100%; text-decoration:none; }',
      '.rating-hub-rank-marks .rank-label .rank-label-no { border-radius:2px; color:#8d5500; overflow:hidden; position:relative; width:54px; }',
      '.rating-hub-rank-marks .rank-label .rank-label-no:before { background:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAASCAYAAAAOsR1OAAAABGdBTUEAALGPC/xhBQAAAwRJREFUSA3VVz1rVFEQndlNJIVFGmutDBrQRvAvaGH6CEmlBPE/iJDfICJW2tiIRdKIIP4BOxEE0WBlYaHgxpDdvHedc/eet7N378tuYixy4e2ZO3PmzNyP/dKw825BOvtPROdXRHVRTuOo+g/0wo3NUusavr1+ZotbLwVFzRvsAWLQBv6Pcdx6qgOpd2/q+Vtv87ZsgW9+ntqT86vR8EOq+qqd5HfvnrPJooR0JMfdQa94FPsk6wU5Jxq2QgjXVbVmGx0R2OkJDr3N+FTERkED6G1Xw2v4GtG2HOIs+V4r2npNdrYfW/FmdIanlxqKJ4ki6UER+pqmE9fHGr4tJPK5UeAmH3WIpXwsLmoBve36OCwfmt0zd8PXV+tcoZ1gSmYiEf7aihBh5w9jQDzc/dhcyqXPc6njfdTwyFzqNYtnz1aj8SW7rlS6C4/C55fLWOTcsCmYLSMuuC0GP4oxTqMNQWdsmDqZzzdm0hzjp9ySD/QYtpdazkp3/oV5rmjY2XYVk+isgEzfD21gaaAxtSAbpA08iZH3M9i/lE6QBXJGXhU8clIMU47YuFtAs3qnH/kpiXajAYM1KOqRMac3xjc/e4hpfbuio/tlLlYienHY9BPzOArjvccGaAMxpsXB8drgY96ml/PdvB580KXbn+wEIeBFvY2EowzmEpFbsku+Uh3yiLlenkNe3ZP9/iqiaYEkgsBdg4922sFs2mwudafFJxJYl5gL0D8rWiPaCXKwe1+X1z4iy64orw9F2C3mtBNm05hBX4E+ES87onf4QjGiC81qHvSe6tLac9KHJ5gOaOoGM6sNpx0A+ianpMFYWz/T4jJ4Lxe/3PPStsDql1Ud/U36h83LD9wXauzD9BkjIqlkl3xiP7YHv1dUH45dyY5U/a2himXxAwfo7Vgl85Xi5LWhz/E2+d7nbcZzHHEG0u+t6uWNsX8S2J85Wag2ZO8PfsPZH97O4tinfEh3IiLoNvzu1TbBlzSwNEpXCjzSc6QWv/hn0cd5VXubunxn4r8gSv0Fuc0yllCH+SkAAAAASUVORK5CYII=) no-repeat 100%/auto 100%; content:""; height:100%; left:0; position:absolute; top:0; width:100%; }',
      '.rating-hub-rank-marks .rank-label-link { display:inline-block; padding:0 7px 0 5px; }',
      '.rating-hub-rank-marks .rank-label-other:before { background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAkCAYAAACJ8xqgAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFKADAAQAAAABAAAAJAAAAAAT/Eh7AAABMElEQVRIDbWWURLCIAxEiePxPZsnUqJT9sVpKONP8AeWAnksSav158Nb4e9WuNex1b35+3pPuE2P0SHHgLUxwdvQGwj764iZAJqZIneRSHMcY4FOgN5AKA/xAoLmIpNH6HhOB1LpHYRde6dQECza8JiTyOMdhOOWs4fkFeNogAWGDIt3EI5KWTm4Gg+01NlAqEr5lsYpFgpCNJPwkGXoekJrIw+J8CMQmxA8TYg8TLVeT+jykIgQRouJMTA6nsjQ9YTmeLhASWRITgQZup7QnVomtjySJP8yf7r0jbVsfPVIechA0LihzweZVL2HfJdnALnm1y7m9yR6HyEckyl/BvK6esJlLWMqt4+GGDQSVLqekPdhpDoE0z8GkDQBMuZL1xOShwSKFs9WHsbEc6ec8AO6ZIJn9ClyFgAAAABJRU5ErkJggg==); }',
      '.rating-hub-rank-marks .rank-label-other .rank-label-no:before { background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAASCAYAAAAOsR1OAAAABGdBTUEAALGPC/xhBQAAA0dJREFUSA2tVztrVUEQnrm5RrARAoJXkAjJL9DSSiwMBAQRBFECEhEsrO2CpPI/pBAECxuxECJW/gFLqzR5QIIp0lkEkrvOt2e/kz1z9uTcKxm4Z2bn8c3Mzp7H1RB+z8rhwbpIWJGxjETFRPuBKIP/F3kAAFNXAPRmunblp78MXun1+xsFRNHw58d7GYe3JePUumAZ1aoBB1EGB/XZK6/ua3f8sQzlrl578MsHazjY3LeJjSoDtyQV6L292Tfg/XvXLUCLoK4UTBs4KBuxyo5c0dt6demoslXXoYxPU3MMGKdArD1gUsEEYh7ySjvFFQXm+SiDT0lB5uWvfgohLKtqDTCUUMtTIhbcsw2N1sL+FKLOVH3xffYgS7L/bc0A3xFUw97XECcNjT/j+RGAvZXAOuAxjXZzIAbWlMFB9K3vSejsV5+Anh1pxRfyA21msKyjh5sxZdj7UsND0SBfYMNoi0kSEgOxlLsa9vh9/t32IxnqHR092sY9eAbL3QQHsXXylj0pQgqIhZvMBnKMXCZerqPMHFhDxh2U4Gs5v6tyLDhWNczJiXywyHsadj43XEw5OXXvYBljWv8ySrcWneQbNKvz1QR5T8SR5R4eizbwRI1ppe2uH1zOv9rdbMJmpy7CuQrdsnVLtOr1eDP2esTcecRaAexiUo6GzjtTKCCzU643xOdxBU/izx5Uf+qNJ7sX+5rw9fk1+udUYKMMfpGkciTh0gtATtdgX4F9dh7HxrHOOvNP5cwURb8hrXzmMBjgtfdcbz3dRow1aE9R3oN9AGNzgC84KRPjRKAv6aI/KsqOqC9wbLaID58CMTfr9fVE+8m6LqzGdyAQNGxtWMfIZISdhZzvcGWprr6g3FaUfQA6p85Et6xNcAG17GZgjdHu6lX9Lgur7lNNxwcGdPY9ClCSTwD9eXbW3lUgccnhlw00now4hZSEMgdAXw44j1fdkcv6LP8ORZqB7cjH+GTDEwovffL4AZB0sQqT41Ms8Vye1E4/8hwDct8PcYyBzBrD6bHIyWO9+bLxTwINDmVxbk22Di1QV+wyak4ojaR+jSAkp9KIc7uTvXuCj0czupoiNgCDEeXIK1XzSv+ZN7r4uvVfEL7/AK5h3BZxtIRYAAAAAElFTkSuQmCC); color:#835000; }',
      '.rating-hub-rank-marks .rank-label-other a { color:#835000; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function getCollapsedChannelKeys(channels, meta) {
    if (!channels) return [];
    if (meta.type !== 'movie' && meta.type !== 'drama') return [];

    const isAnime = meta.type === 'movie' && meta.genres && meta.genres.indexOf('动画') !== -1;
    const visibleKeys = isAnime
      ? ['imdb', 'rt_critics', 'rt_audience', 'bangumi', 'mal', 'neodb']
      : ['imdb', 'rt_critics', 'rt_audience', 'metacritic', 'letterboxd', 'trakt', 'neodb'];
    const visibleSet = new Set(visibleKeys);

    const hidden = channels
      .filter(function (ch) { return !visibleSet.has(ch.channelKey); })
      .map(function (ch) { return ch.channelKey; });

    // 只在隐藏 ≥ 2 条时才折叠：每折叠一组多一个 "展开更多" toggle 行，
    // 隐藏 1 条 = 净省 0 行（无意义）；隐藏 2 条 = 净省 1 行；3 条 = 净省 2 行。
    if (hidden.length < 2) return [];
    return hidden;
  }

  function createSlots(channels, meta) {
    const anchor = document.querySelector('#interest_sectl')
      || document.querySelector('.drama-info .meta .rating')  // 话剧：评分区块后
      || document.querySelector('.drama-info .meta')           // 话剧：meta 容器
      || document.querySelector('#interest_sect_level')
      || document.querySelector('#wrapper');
    if (!anchor) return null;

    const container = document.createElement('div');
    container.className = 'rating-hub-container';
    container.setAttribute('data-rating-hub', '1');
    const collapsedKeys = new Set(getCollapsedChannelKeys(channels, meta));

    channels.forEach(function (ch) {
      const row = document.createElement('div');
      row.className = 'rating-hub-row';
      row.setAttribute('data-channel', ch.channelKey);
      row.setAttribute('data-status', 'loading');
      if (collapsedKeys.has(ch.channelKey)) {
        row.classList.add('rating-hub-row-hidden');
      }

      const label = document.createElement('span');
      label.className = 'rating-hub-label no-link';
      if (ch.icon) {
        const iconImg = document.createElement('img');
        iconImg.className = 'rating-hub-icon';
        iconImg.src = ch.icon;
        iconImg.alt = '';
        iconImg.onerror = function () { this.style.display = 'none'; };
        label.appendChild(iconImg);
      }
      label.appendChild(document.createTextNode(ch.label));

      const status = document.createElement('span');
      status.className = 'rating-hub-status';
      status.textContent = '加载中...';

      row.appendChild(label);
      row.appendChild(status);
      container.appendChild(row);
    });

    if (collapsedKeys.size > 0) {
      const toggle = document.createElement('a');
      toggle.href = '#';
      toggle.className = 'rating-hub-toggle';
      toggle.setAttribute('data-expanded', '0');
      toggle.textContent = '展开更多评分来源（' + collapsedKeys.size + '）';
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        const expanded = toggle.getAttribute('data-expanded') === '1';
        collapsedKeys.forEach(function (key) {
          const hiddenRow = container.querySelector('.rating-hub-row[data-channel="' + key + '"]');
          if (!hiddenRow) return;
          hiddenRow.classList.toggle('rating-hub-row-hidden', expanded);
        });
        toggle.setAttribute('data-expanded', expanded ? '0' : '1');
        toggle.textContent = expanded
          ? '展开更多评分来源（' + collapsedKeys.size + '）'
          : '收起更多评分来源';
      });
      container.appendChild(toggle);
    }

    anchor.appendChild(container);
    return container;
  }

  function fillSlot(channelKey, result) {
    const row = document.querySelector('.rating-hub-row[data-channel="' + channelKey + '"]');
    if (!row) return;

    // 重建行内容：label + 状态区
    const label = row.querySelector('.rating-hub-label');

    // 先清空旧状态区（label 保留）
    while (row.lastChild !== label) {
      row.removeChild(row.lastChild);
    }

    const status = result.status;
    row.setAttribute('data-status', status || 'error');
    if (result.matchConfidence) {
      row.setAttribute('data-confidence', result.matchConfidence);
    } else {
      row.removeAttribute('data-confidence');
    }

    if (status === 'success') {
      // Label → 可点击链接
      const a = document.createElement('a');
      a.className = 'rating-hub-label';
      a.href = safeLinkUrl(result.url);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = label.innerHTML; // preserves icon img + text
      row.replaceChild(a, label);

      const scoreEl = document.createElement('span');
      scoreEl.className = 'rating-hub-score';
      const scoreText = String(result.displayValue || result.score);
      const scoreMatch = scoreText.match(/^([^/]+)(\/.+)$/);
      if (scoreMatch) {
        const mainEl = document.createElement('span');
        mainEl.className = 'rating-hub-score-main';
        mainEl.textContent = scoreMatch[1];

        const suffixEl = document.createElement('span');
        suffixEl.className = 'rating-hub-score-suffix';
        suffixEl.textContent = scoreMatch[2];

        scoreEl.appendChild(mainEl);
        scoreEl.appendChild(suffixEl);
      } else {
        const mainEl = document.createElement('span');
        mainEl.className = 'rating-hub-score-main';
        mainEl.textContent = scoreText;
        scoreEl.appendChild(mainEl);
      }
      if (result.matchConfidence === 'fuzzy') {
        const mark = document.createElement('span');
        mark.className = 'rating-hub-fuzzy-mark';
        mark.textContent = '~';
        mark.title = '此匹配为模糊匹配（按标题搜索），分数可能对应错的作品';
        mark.setAttribute('aria-label', '模糊匹配');
        scoreEl.appendChild(mark);
      }
      row.appendChild(scoreEl);

      if (result.count) {
        const countEl = document.createElement('span');
        countEl.className = 'rating-hub-count';
        let countDisplay;
        const c = result.count;
        if (c >= 100000000) countDisplay = Math.round(c / 100000000) + '亿';
        else if (c >= 10000) countDisplay = (c / 10000).toFixed(c >= 1000000 ? 0 : 1) + '万';
        else countDisplay = c.toLocaleString();
        countEl.textContent = '(' + countDisplay + ')';
        row.appendChild(countEl);
      }

    } else if (status === 'no_match' || status === 'no_rating') {
      if (result.url) {
        const a = document.createElement('a');
        a.className = 'rating-hub-label';
        a.href = safeLinkUrl(result.url);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerHTML = label.innerHTML; // preserves icon img + text
        row.replaceChild(a, label);
      }

      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = status === 'no_match' ? '未收录' : '暂无评分';
      row.appendChild(statusEl);

    } else if (status === 'rate_limited') {
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = '访问过快，稍后再试';
      row.appendChild(statusEl);

    } else if (status === 'disabled') {
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      const configLink = document.createElement('a');
      configLink.href = '#';
      configLink.textContent = '配置 TMDB Key';
      configLink.addEventListener('click', function (e) {
        e.preventDefault();
        openConfigPanel(sources);
      });
      statusEl.appendChild(configLink);
      row.appendChild(statusEl);


    } else {
      // error (and any unknown status)
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      // Label → 链接（如果有 url）
      if (result.url) {
        const a = document.createElement('a');
        a.className = 'rating-hub-label';
        a.href = safeLinkUrl(result.url);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerHTML = label.innerHTML;
        row.replaceChild(a, label);
      }
      statusEl.textContent = '暂时无法访问';
      row.appendChild(statusEl);
    }
  }

  // ============================================================
  // Registry — 评分来源注册表
  // ============================================================

  const sources = [];

  function getApplicableSources(type, config, meta) {
    return sources.filter(function (source) {
      // 必须支持当前条目类型
      if (!source.types || source.types.indexOf(type) === -1) return false;
      // 用户已禁用
      if (config.enabledSources[source.key] === false) return false;
      // bangumi/mal 仅在动画类型时启用
      if ((source.key === 'bangumi' || source.key === 'mal') && (!meta.genres || meta.genres.indexOf('动画') === -1)) return false;
      return true;
    });
  }

  // ============================================================
  // Sources — 各平台评分获取定义
  // ============================================================

  // 去除标题中的季数信息，用于 RT/Metacritic 搜索
  // "Louie Season 1" → "Louie", "Breaking Bad Season 5" → "Breaking Bad"
  function stripSeason(title) {
    return (title || '')
      .replace(/\s*[,:]?\s*Season\s+\d+/i, '')
      .replace(/\s*第.{1,3}季/g, '')
      .trim();
  }

  function absolutizeUrl(href, baseUrl) {
    if (!href) return '';
    return href.indexOf('http') === 0 ? href : baseUrl + href;
  }

  function responseOk(resp) {
    return resp && resp.status >= 200 && resp.status < 300;
  }

  /**
   * 标题搜索类来源的公共流程：搜索页 → 候选详情链接 → 详情页解析。
   * 仅封装网络/DOM 串联；具体匹配、评分解析和 no_match/no_rating 仍由各 source 自己决定。
   */
  function fetchSearchDetail(deps, opts) {
    return deps.request(opts.searchUrl, opts.searchOpts || {}).then(function (searchResp) {
      if (!responseOk(searchResp)) {
        return { reachedDetail: false, url: opts.searchUrl };
      }
      const finalSearchUrl = searchResp.finalUrl || opts.searchUrl;
      if (opts.isDetailUrl && opts.isDetailUrl(finalSearchUrl)) {
        return {
          reachedDetail: true,
          url: finalSearchUrl,
          parsed: opts.parseDetail(deps.parseHTML(searchResp.responseText), finalSearchUrl, searchResp),
        };
      }

      const searchDoc = deps.parseHTML(searchResp.responseText);
      const href = opts.pickDetailHref(searchDoc, searchResp);
      if (!href) {
        return { reachedDetail: false, url: finalSearchUrl };
      }
      const detailUrl = absolutizeUrl(href, opts.baseUrl);
      return deps.request(detailUrl, opts.detailOpts || {}).then(function (detailResp) {
        if (opts.acceptDetailResp && !opts.acceptDetailResp(detailResp)) {
          return { reachedDetail: false, url: detailUrl };
        }
        const finalDetailUrl = detailResp.finalUrl || detailUrl;
        return {
          reachedDetail: true,
          url: finalDetailUrl,
          parsed: opts.parseDetail(deps.parseHTML(detailResp.responseText), finalDetailUrl, detailResp),
        };
      }).catch(function () {
        return { reachedDetail: false, url: detailUrl };
      });
    }).catch(function () {
      return { reachedDetail: false, url: opts.searchUrl };
    });
  }

  // --- IMDB ---
  sources.push({
    key: 'imdb', label: 'IMDB', version: 2,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'imdb', label: 'IMDB', icon: 'https://www.imdb.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        if (!meta.imdbId) {
          resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: 'https://www.imdb.com/search/title/?title=' + encodeURIComponent(meta.title || '') } });
          return;
        }
        const itemUrl = 'https://www.imdb.com/title/' + meta.imdbId + '/';

        function buildSuccess(score, count) {
          resolve({
            imdb: {
              channelKey: 'imdb', status: 'success',
              score: score, scoreMax: 10,
              displayValue: score.toFixed(1) + '/10',
              count: count, countText: count.toLocaleString(),
              url: itemUrl, matchedBy: 'imdb_id', matchConfidence: 'exact',
              externalId: meta.imdbId,
            },
          });
        }
        function errorResult() { resolve({ imdb: { channelKey: 'imdb', status: 'error', url: itemUrl } }); }
        function noRating() { resolve({ imdb: { channelKey: 'imdb', status: 'no_rating', url: itemUrl } }); }

        // 兜底：旧版 JSONP 端点
        function tryJsonpFallback() {
          const ratingsUrl = 'https://p.media-imdb.com/static-content/documents/v1/title/' + meta.imdbId + '/ratings%3Fjsonp=imdb.rating.run:imdb.api.title.ratings/data.json';
          deps.request(ratingsUrl).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) { errorResult(); return; }
            try {
              const jsonText = resp.responseText.replace(/^[^(]+\(/, '').replace(/\)\s*$/, '');
              const data = JSON.parse(jsonText);
              const res = data.resource || data;
              const score = parseFloat(res.rating);
              const count = parseInt(res.ratingCount, 10) || 0;
              if (isNaN(score) || score === 0) { noRating(); return; }
              buildSuccess(score, count);
            } catch (e) { errorResult(); }
          }).catch(function () { errorResult(); });
        }

        // 主路径：GraphQL API
        const body = JSON.stringify({
          query: 'query($id:ID!){title(id:$id){ratingsSummary{aggregateRating voteCount}}}',
          variables: { id: meta.imdbId },
        });
        deps.request('https://api.graphql.imdb.com/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: body,
        }).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) { tryJsonpFallback(); return; }
          try {
            const json = JSON.parse(resp.responseText);
            const summary = json.data && json.data.title && json.data.title.ratingsSummary;
            const score = summary && parseFloat(summary.aggregateRating);
            const count = (summary && summary.voteCount) || 0;
            if (score == null || isNaN(score) || score === 0) { noRating(); return; }
            buildSuccess(score, count);
          } catch (e) { tryJsonpFallback(); }
        }).catch(function () { tryJsonpFallback(); });
      });
    },
  });

  // --- Rotten Tomatoes ---
  sources.push({
    key: 'rottentomatoes', label: '烂番茄', version: 6,
    types: ['movie'], requiredConfig: null,
    channels: [
      { channelKey: 'rt_critics', label: '烂番茄 专业', icon: 'https://www.rottentomatoes.com/assets/pizza-pie/images/favicon.ico' },
      { channelKey: 'rt_audience', label: '烂番茄 观众', icon: 'https://www.rottentomatoes.com/assets/pizza-pie/images/favicon.ico' },
    ],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const titleRaw = meta.originalTitle || meta.title || '';
        const titleForSearch = stripSeason(titleRaw);
        const searchUrl = 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(titleForSearch);
        // RT 无 IMDB ID 查询能力，所有匹配本质都是文本搜索，统一标 fuzzy
        const matchConfidence = 'fuzzy';

        function noMatchBoth() {
          resolve({
            rt_critics: { channelKey: 'rt_critics', status: 'no_match', url: searchUrl },
            rt_audience: { channelKey: 'rt_audience', status: 'no_match', url: searchUrl },
          });
        }

        function buildResults(criticsScore, audienceScore, criticsCount, audienceCount, movieUrl) {
          const results = {};
          if (criticsScore != null && !isNaN(criticsScore)) {
            results.rt_critics = {
              channelKey: 'rt_critics',
              status: 'success',
              score: criticsScore,
              scoreMax: 100,
              displayValue: criticsScore + '%',
              count: criticsCount || null,
              countText: criticsCount ? criticsCount.toLocaleString() : null,
              url: movieUrl,
              matchedBy: 'english_title',
              matchConfidence: matchConfidence,
              externalId: movieUrl,
            };
          } else {
            results.rt_critics = { channelKey: 'rt_critics', status: 'no_rating', url: movieUrl };
          }
          if (audienceScore != null && !isNaN(audienceScore)) {
            results.rt_audience = {
              channelKey: 'rt_audience',
              status: 'success',
              score: audienceScore,
              scoreMax: 100,
              displayValue: audienceScore + '%',
              count: audienceCount || null,
              countText: audienceCount ? audienceCount.toLocaleString() : null,
              url: movieUrl,
              matchedBy: 'english_title',
              matchConfidence: matchConfidence,
              externalId: movieUrl,
            };
          } else {
            results.rt_audience = { channelKey: 'rt_audience', status: 'no_rating', url: movieUrl };
          }
          return results;
        }

        // 抽出：取 RT 详情页 → 提取 critics/audience 分数 → resolve
        // 给 fast path 和 normal 搜索路径共用。
        // validateYear=true 时（仅 fast path）校验详情页年份与豆瓣年份是否一致——
        // 用于治理被污染的 slugMap（旧缓存 URL 指向错年份的同名片，如 1999 版《木乃伊》），
        // 冲突则 onFail 回退到 normalFlow 重搜并改写 slugMap。
        function fetchDetailAndResolve(movieUrl, onFail, validateYear) {
          deps.request(movieUrl).then(function (movieResp) {
            if (movieResp.status < 200 || movieResp.status >= 300) {
              onFail();
              return;
            }
            const html = movieResp.responseText;
            // v1.1.8: TV 详情页 releaseYear 是 startYear，不能直接拿来跟豆瓣季度年份比；
            // 跳过 /tv/* 的年份守卫，电影页（/m/*）仍按原逻辑校验 slugMap 是否指向正确年份的片
            const isTvDetail = /\/tv\//.test(movieUrl);
            if (validateYear && meta.year && !isTvDetail) {
              const detailYear = extractRtDetailYear(html);
              if (detailYear && !yearWithinOne(detailYear, meta.year)) { onFail(); return; }
            }

            // Method A: JSON in <script type="application/json"> tags（含 TV 页对象形态）
            const scores = extractRtScores(html);
            let criticsScore = scores.criticsScore;
            let audienceScore = scores.audienceScore;
            const criticsCount = scores.criticsCount;
            const audienceCount = scores.audienceCount;

            // Method B: DOM selectors fallback
            if (criticsScore == null || audienceScore == null) {
              const movieDoc = deps.parseHTML(html);
              if (criticsScore == null) {
                const csEl = movieDoc.querySelector('rt-text[slot="critics-score"]');
                if (csEl) {
                  const parsed = parseInt(csEl.textContent, 10);
                  if (!isNaN(parsed)) criticsScore = parsed;
                }
              }
              if (audienceScore == null) {
                const asEl = movieDoc.querySelector('rt-text[slot="audience-score"]');
                if (asEl) {
                  const parsedA = parseInt(asEl.textContent, 10);
                  if (!isNaN(parsedA)) audienceScore = parsedA;
                }
              }
            }

            // 至少有一个分数命中才视为成功；都没有视为失败
            if (criticsScore == null && audienceScore == null) {
              onFail();
              return;
            }
            resolve(buildResults(criticsScore, audienceScore, criticsCount, audienceCount, movieUrl));
          }).catch(onFail);
        }

        // 搜索 RT → 收集候选行（标题/年份/详情页 URL）→ pickByYearThenTitle 选出最佳。
        // 每行的 release-year 属性是年份消歧关键（区分 1999/2017/2026 版《木乃伊》）。cb(chosen|null)
        function searchAndSelect(searchTitle, cb) {
          const sUrl = 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(searchTitle);
          deps.request(sUrl).then(function (searchResp) {
            if (searchResp.status < 200 || searchResp.status >= 300) { cb(null); return; }
            const searchDoc = deps.parseHTML(searchResp.responseText);
            const allResults = searchDoc.querySelectorAll('search-page-media-row');
            if (!allResults || allResults.length === 0) { cb(null); return; }
            const candidates = [];
            for (let i = 0; i < Math.min(allResults.length, 30); i++) {
              const nameEl = allResults[i].querySelector('a[data-qa="info-name"]');
              if (!nameEl) continue;
              const row = allResults[i];
              candidates.push({
                nameNorm: normalizeTitle(nameEl.textContent),
                year: computeRtCandidateYear(
                  row.getAttribute('release-year'),
                  row.getAttribute('startyear'),
                  row.getAttribute('endyear'),
                  meta.year
                ),
                href: nameEl.getAttribute('href') || '',
              });
            }
            cb(pickByYearThenTitle(candidates, normalizeTitle(searchTitle), meta.year));
          }).catch(function () { cb(null); });
        }

        function toMovieUrl(chosen) {
          return chosen.href.startsWith('http') ? chosen.href : 'https://www.rottentomatoes.com' + chosen.href;
        }

        // 多候选标题轮询：先用主英文名搜；若命中片年份与豆瓣年份对不上、且有备选英文名
        // （h1 拉丁段，如《碟中谍8》主名给数字别名、备选给规范官方名），再用备选名搜一次，
        // 取年份吻合的那个；都对不上则用首个命中（fallback）。仅在有年份可校验时才试备选名。
        function normalFlow() {
          const titles = [];
          if (titleForSearch) titles.push(titleForSearch);
          const altForSearch = meta.altTitle ? stripSeason(meta.altTitle) : null;
          if (altForSearch && meta.year && titles.indexOf(altForSearch) === -1) titles.push(altForSearch);
          if (titles.length === 0) { noMatchBoth(); return; }

          function tryTitle(idx, fallback) {
            if (idx >= titles.length) {
              if (fallback && fallback.href) fetchDetailAndResolve(toMovieUrl(fallback), noMatchBoth);
              else noMatchBoth();
              return;
            }
            searchAndSelect(titles[idx], function (chosen) {
              if (chosen && chosen.href && meta.year && yearWithinOne(chosen.year, meta.year)) {
                // 年份吻合 = 高置信，直接拿分；详情页失败再试下一个标题
                fetchDetailAndResolve(toMovieUrl(chosen), function () { tryTitle(idx + 1, fallback || chosen); });
              } else {
                tryTitle(idx + 1, fallback || chosen);
              }
            });
          }
          tryTitle(0, null);
        }

        // FAST PATH: slugMap 命中过的 RT 详情页 URL 直接抓，跳过搜索
        const fastEntry = meta.cachedUrls && (meta.cachedUrls.rt_critics || meta.cachedUrls.rt_audience);
        if (fastEntry && fastEntry.url) {
          fetchDetailAndResolve(fastEntry.url, normalFlow, true);
          return;
        }

        normalFlow();
      });
    },
  });

  // --- Metacritic ---
  sources.push({
    key: 'metacritic', label: 'Metacritic', version: 9,
    types: ['movie', 'game'], requiredConfig: null,
    channels: [{ channelKey: 'metacritic', label: 'Metacritic', icon: 'https://www.metacritic.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // 标题候选：主英文名 + 备选英文名（h1 拉丁段）。只保留含拉丁字母的，去重。
        // 备选名仅在有年份可校验时才加（否则无法判断哪个更准，保持原行为）。
        // 例：《碟中谍8》主名给数字别名 "Mission: Impossible 8"，备选给规范官方名
        // "Mission: Impossible - The Final Reckoning"——后者的 slug 直接命中正确条目。
        const primaryTitle = stripSeason(meta.originalTitle || meta.title || '');
        const altT = meta.altTitle ? stripSeason(meta.altTitle) : null;
        const titleCandidates = [];
        [primaryTitle, (meta.year ? altT : null)].forEach(function (t) {
          if (t && /[a-zA-Z]/.test(t) && titleCandidates.indexOf(t) === -1) titleCandidates.push(t);
        });
        const searchUrl = 'https://www.metacritic.com/search/' + encodeURIComponent(primaryTitle || '') + '/';

        // 某次尝试命中了正确条目但 MC 暂无评分时，先记住 URL；所有尝试都没拿到 success 才落 no_rating，
        // 避免「主名 slug 年份吻合但无分」抢先短路、挡住后续可能带分的备选 slug / HTML 搜索。
        let pendingNoRating = null;
        function noMatchFinal() {
          if (pendingNoRating) {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_rating', url: pendingNoRating } });
            return;
          }
          resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
        }
        // 标题无拉丁字母（纯 CJK）→ Metacritic 无法匹配
        if (titleCandidates.length === 0) { noMatchFinal(); return; }

        function slugify(t) {
          return t.replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
            .replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
        }

        // 取 slug 详情 API → resolve success；失败/年份不符则 onFail。
        // 命中但无分：记下 URL 走 onFail（让后续尝试有机会拿到带分的条目），不当场 resolve。
        function fetchSlug(apiType, urlType, foundSlug, matchedBy, yearGate, onFail) {
          const apiUrl = 'https://backend.metacritic.com/' + apiType + '/metacritic/' + foundSlug + '/web';
          deps.request(apiUrl, { headers: { 'Accept': 'application/json' } }).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) { onFail(); return; }
            try {
              const data = JSON.parse(resp.responseText);
              const item = data && data.data && data.data.item;
              // 年份守卫：slug 命中同名但错年份的片（如 the-mummy 永远指向 1999 版）→ 视为未命中。
              if (yearGate && meta.year && item && item.premiereYear && !yearWithinOne(item.premiereYear, meta.year)) {
                onFail(); return;
              }
              const pageUrl = 'https://www.metacritic.com/' + urlType + '/' + foundSlug + '/';
              let score = item && item.criticScoreSummary && item.criticScoreSummary.score;
              if (score == null || isNaN(Number(score))) {
                if (!pendingNoRating) pendingNoRating = pageUrl;
                onFail();
                return;
              }
              score = Number(score);
              const reviewCount = (item && item.criticScoreSummary && item.criticScoreSummary.reviewCount) || null;
              resolve({
                metacritic: {
                  channelKey: 'metacritic', status: 'success',
                  score: score, scoreMax: 100, displayValue: score + '/100',
                  count: reviewCount, countText: reviewCount ? reviewCount.toLocaleString() : null,
                  url: pageUrl, matchedBy: matchedBy, matchConfidence: 'fuzzy', externalId: foundSlug,
                },
              });
            } catch (e) { onFail(); }
          }).catch(onFail);
        }

        // 1) slug 直拼路径：每个标题候选 × 路径类型。movie→movies/shows；game→games。
        const slugAttempts = [];
        const seen = {};
        titleCandidates.forEach(function (t) {
          const s = slugify(t);
          if (!s) return;
          const types = meta.type === 'game' ? [['games', 'game']] : [['movies', 'movie'], ['shows', 'tv']];
          types.forEach(function (ty) {
            const key = ty[0] + ':' + s;
            if (seen[key]) return;
            seen[key] = 1;
            slugAttempts.push({ apiType: ty[0], urlType: ty[1], slug: s });
          });
        });

        function trySlugs(i) {
          if (i >= slugAttempts.length) { afterSlugs(); return; }
          const a = slugAttempts[i];
          fetchSlug(a.apiType, a.urlType, a.slug, 'title_slug', true, function () { trySlugs(i + 1); });
        }

        // 2) HTML 搜索兜底（?category=N）：每个标题候选 × category，按年份消歧。
        //    旧 backend finder API 对标题 query 几乎失效，故用渲染好的搜索页（带标题 + 上映年 + 链接）。
        function afterSlugs() {
          if (meta.type === 'game') { noMatchFinal(); return; }
          const cats = [['2', 'movie'], ['1', 'tv']];  // 2=电影, 1=剧集
          const attempts = [];
          titleCandidates.forEach(function (t) {
            cats.forEach(function (c) { attempts.push({ title: t, cat: c[0], urlType: c[1] }); });
          });
          function tryHtml(i) {
            if (i >= attempts.length) { noMatchFinal(); return; }
            const at = attempts[i];
            const url = 'https://www.metacritic.com/search/' + encodeURIComponent(at.title) + '/?category=' + at.cat;
            deps.request(url).then(function (resp) {
              if (resp.status < 200 || resp.status >= 300) { tryHtml(i + 1); return; }
              const doc = deps.parseHTML(resp.responseText);
              const itemEls = doc.querySelectorAll('.search-item');
              const candidates = [];
              for (let j = 0; j < itemEls.length; j++) {
                const a = itemEls[j].querySelector('a[href^="/movie/"], a[href^="/tv/"]');
                const titleEl = itemEls[j].querySelector('.c-search-item__title');
                if (!a || !titleEl) continue;
                const dateEl = itemEls[j].querySelector('.c-search-product-meta__release-date');
                const ym = dateEl ? dateEl.textContent.match(/(\d{4})/) : null;
                candidates.push({
                  nameNorm: normalizeTitle(titleEl.textContent),
                  year: ym ? ym[1] : '',
                  href: a.getAttribute('href') || '',
                });
              }
              const chosen = pickByYearThenTitle(candidates, normalizeTitle(at.title), meta.year);
              // 有年份则要求年份吻合（避免同名错年份/无关片误命中）；无年份则用 pick 结果
              const confident = chosen && chosen.href && (!meta.year || yearWithinOne(chosen.year, meta.year));
              const sm = confident && chosen.href.match(/\/(movie|tv)\/([^/]+)\//);
              if (!sm) { tryHtml(i + 1); return; }
              const fApiType = sm[1] === 'tv' ? 'shows' : 'movies';
              const fUrlType = sm[1] === 'tv' ? 'tv' : 'movie';
              fetchSlug(fApiType, fUrlType, sm[2], 'title_search', false, function () { tryHtml(i + 1); });
            }).catch(function () { tryHtml(i + 1); });
          }
          tryHtml(0);
        }

        trySlugs(0);
      });
    },
  });

  // --- Letterboxd ---
  sources.push({
    key: 'letterboxd', label: 'Letterboxd', version: 2,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'letterboxd', label: 'Letterboxd', icon: 'https://letterboxd.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const searchUrl = 'https://letterboxd.com/search/' + encodeURIComponent(stripSeason(meta.originalTitle || meta.title || '')) + '/';

        function parseFromPage(html, pageUrl) {
          const doc = deps.parseHTML(html);
          // Try LD+JSON first
          const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (let i = 0; i < scripts.length; i++) {
            try {
              const data = JSON.parse(scripts[i].textContent);
              const ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                const score = parseFloat(ar.ratingValue);
                const count = parseInt(ar.ratingCount || ar.reviewCount, 10) || 0;
                if (!isNaN(score)) {
                  return { score: score, count: count, url: pageUrl };
                }
              }
            } catch (e) { /* skip */ }
          }
          // Regex fallback
          const rvMatch = html.match(/"ratingValue"\s*:\s*([\d.]+)/);
          const rcMatch = html.match(/"ratingCount"\s*:\s*([\d]+)/);
          if (rvMatch) {
            return {
              score: parseFloat(rvMatch[1]),
              count: rcMatch ? parseInt(rcMatch[1], 10) : 0,
              url: pageUrl,
            };
          }
          return null;
        }

        function buildSuccess(score, count, filmUrl, matchedBy, confidence) {
          return {
            letterboxd: {
              channelKey: 'letterboxd',
              status: 'success',
              score: score,
              scoreMax: 5,
              displayValue: score.toFixed(2) + '/5',
              count: count || null,
              countText: count ? count.toLocaleString() : null,
              url: filmUrl,
              matchedBy: matchedBy,
              matchConfidence: confidence,
              externalId: filmUrl,
            },
          };
        }

        // FALLBACK: 按 originalTitle 搜 letterboxd.com/search/films/
        // 用于：豆瓣无 IMDB ID 的条目，或 /imdb/{id}/ 主路径失败
        function tryTitleSearch() {
          // Letterboxd 只有英文内容，用 originalTitle 去掉季数
          const searchTitle = stripSeason(meta.originalTitle || meta.title || '');
          if (!/[a-zA-Z]/.test(searchTitle)) {
            resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
            return;
          }
          const titleSearchUrl = 'https://letterboxd.com/search/films/' + encodeURIComponent(searchTitle) + '/';
          fetchSearchDetail(deps, {
            searchUrl: titleSearchUrl,
            baseUrl: 'https://letterboxd.com',
            pickDetailHref: function (searchDoc) {
              const filmLink = searchDoc.querySelector('.results .film-detail-content a')
                || searchDoc.querySelector('a[href*="/film/"]');
              return filmLink ? (filmLink.getAttribute('href') || '') : '';
            },
            parseDetail: function (doc, finalUrl, resp) {
              return parseFromPage(resp.responseText, finalUrl);
            },
          }).then(function (result) {
            if (!result.reachedDetail) {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
              return;
            }
            if (result.parsed && !isNaN(result.parsed.score)) {
              resolve(buildSuccess(result.parsed.score, result.parsed.count, result.parsed.url, 'title', 'fuzzy'));
            } else {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_rating', url: result.url } });
            }
          });
        }

        // 抽出"取详情页 → 解析 → resolve 或 fallback"逻辑，给 fast path 和 IMDB ID 路径共用
        function fetchDetailAndResolve(detailUrl, matchedBy, confidence, onFail) {
          deps.request(detailUrl).then(function (pageResp) {
            if (pageResp.status === 403 || pageResp.status === 404) {
              onFail();
              return;
            }
            const finalUrl = pageResp.finalUrl || detailUrl;
            const parsed = parseFromPage(pageResp.responseText, finalUrl);
            if (parsed && !isNaN(parsed.score)) {
              resolve(buildSuccess(parsed.score, parsed.count, parsed.url, matchedBy, confidence));
            } else {
              onFail();
            }
          }).catch(onFail);
        }

        // PRIMARY: 有 IMDB ID → /imdb/{id}/ 直链（302 → 详情页）
        // 注：原 CSI 端点 /csi/film/imdb/{id}/ratings-summary/ 已废弃（返 404），
        // 之前是 primary，现在删除——直接走 /imdb/{id}/ 省一次失败请求。
        function normalFlow() {
          if (meta.imdbId) {
            const imdbPageUrl = 'https://letterboxd.com/imdb/' + meta.imdbId + '/';
            fetchDetailAndResolve(imdbPageUrl, 'imdb_id', 'exact', tryTitleSearch);
          } else {
            // 无 IMDB ID：直接走 title search（不再一刀切 no_match）
            tryTitleSearch();
          }
        }

        // FAST PATH: slugMap 命中过的详情页 URL 直接抓，跳过任何搜索/匹配
        const fastEntry = meta.cachedUrls && meta.cachedUrls.letterboxd;
        if (fastEntry && fastEntry.url) {
          fetchDetailAndResolve(
            fastEntry.url,
            fastEntry.matchedBy || 'cached_url',
            fastEntry.confidence || 'fuzzy',
            normalFlow
          );
        } else {
          normalFlow();
        }
      });
    },
  });

  // --- TMDB ---
  sources.push({
    key: 'tmdb', label: 'TMDB', version: 2,
    types: ['movie'],
    requiredConfig: ['tmdbApiKey'],
    channels: [{ channelKey: 'tmdb', label: 'TMDB', icon: 'https://www.themoviedb.org/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const config = readConfig();
        const apiKey = config.tmdbApiKey;
        const searchUrl = 'https://www.themoviedb.org/search?query=' + encodeURIComponent(meta.title || '');

        function noMatch() {
          resolve({ tmdb: { channelKey: 'tmdb', status: 'no_match', url: searchUrl } });
        }

        function buildSuccess(movie, matchedBy, matchConfidence) {
          const score = parseFloat(movie.vote_average);
          const count = parseInt(movie.vote_count, 10) || 0;
          const mediaType = movie.media_type === 'tv' || movie.first_air_date ? 'tv' : 'movie';
          const movieUrl = 'https://www.themoviedb.org/' + mediaType + '/' + movie.id;
          if (isNaN(score) || count === 0) {
            resolve({ tmdb: { channelKey: 'tmdb', status: 'no_rating', url: movieUrl } });
            return;
          }
          resolve({
            tmdb: {
              channelKey: 'tmdb',
              status: 'success',
              score: score,
              scoreMax: 10,
              displayValue: score.toFixed(1) + '/10',
              count: count,
              countText: count.toLocaleString(),
              url: movieUrl,
              matchedBy: matchedBy,
              matchConfidence: matchConfidence,
              externalId: String(movie.id),
            },
          });
        }

        function handleResp(resp, extractMovie, matchedBy, matchConfidence) {
          if (resp.status === 401 || resp.status === 403) {
            resolve({ tmdb: { channelKey: 'tmdb', status: 'error', url: searchUrl } });
            return;
          }
          if (resp.status === 429) {
            resolve({ tmdb: { channelKey: 'tmdb', status: 'rate_limited', url: searchUrl } });
            return;
          }
          if (resp.status < 200 || resp.status >= 300) {
            noMatch();
            return;
          }
          try {
            const data = JSON.parse(resp.responseText);
            const movie = extractMovie(data);
            if (!movie) { noMatch(); return; }
            buildSuccess(movie, matchedBy, matchConfidence);
          } catch (e) {
            noMatch();
          }
        }

        if (meta.imdbId) {
          // Prefer IMDB ID lookup via /find
          const findUrl = 'https://api.themoviedb.org/3/find/' + meta.imdbId +
            '?api_key=' + encodeURIComponent(apiKey) + '&external_source=imdb_id';
          deps.request(findUrl).then(function (resp) {
            if (resp.status === 401 || resp.status === 403) {
              resolve({ tmdb: { channelKey: 'tmdb', status: 'error', url: searchUrl } });
              return;
            }
            if (resp.status === 429) {
              resolve({ tmdb: { channelKey: 'tmdb', status: 'rate_limited', url: searchUrl } });
              return;
            }
            if (resp.status < 200 || resp.status >= 300) { noMatch(); return; }
            try {
              const data = JSON.parse(resp.responseText);
              const movie = data.movie_results && data.movie_results[0];
              if (movie) { buildSuccess(movie, 'imdb_id', 'exact'); return; }
              const tv = data.tv_results && data.tv_results[0];
              if (tv) { buildSuccess(tv, 'imdb_id', 'exact'); return; }
              // Episode 或 Season —— 豆瓣 TV 季页常存 episode/season-specific IMDB ID
              // （如 tt17719220 = Euphoria S3E1）。这里 /find 返回 tv_episode_results / tv_season_results，
              // episode 单集评分（vote_count 几十）跟整剧综合分（数千+）差距悬殊且误导。
              // 解法：提取 show_id → 二次 fetch /tv/{show_id} 拿 show 级评分（与 Trakt 行为一致）。
              const epOrSeason = (data.tv_episode_results && data.tv_episode_results[0])
                || (data.tv_season_results && data.tv_season_results[0]);
              if (epOrSeason && epOrSeason.show_id) {
                const showUrl = 'https://api.themoviedb.org/3/tv/' + epOrSeason.show_id +
                  '?api_key=' + encodeURIComponent(apiKey);
                deps.request(showUrl).then(function (showResp) {
                  if (showResp.status < 200 || showResp.status >= 300) { noMatch(); return; }
                  try {
                    const showData = JSON.parse(showResp.responseText);
                    showData.media_type = 'tv';  // 显式标 tv 让 buildSuccess 拼出 /tv/{id} URL
                    buildSuccess(showData, 'imdb_id', 'exact');
                  } catch (e) { noMatch(); }
                }).catch(function () { noMatch(); });
                return;
              }
              noMatch();
            } catch (e) {
              noMatch();
            }
          }).catch(function () { noMatch(); });
        } else {
          // Fallback to title search
          // 修复：(1) 用 originalTitle 优先，剥掉"第X季"等季号后缀，避免拿中文+季号去搜 TMDB；
          //       (2) 用 /search/multi 同时覆盖电影 + 电视剧（之前只搜 /search/movie，剧集必败）。
          const titleForSearch = stripSeason(meta.originalTitle || meta.title || '');
          if (!titleForSearch) { noMatch(); return; }
          const year = meta.year ? '&year=' + encodeURIComponent(meta.year) : '';
          const queryUrl = 'https://api.themoviedb.org/3/search/multi?api_key=' +
            encodeURIComponent(apiKey) + '&query=' + encodeURIComponent(titleForSearch) + year;
          deps.request(queryUrl).then(function (resp) {
            handleResp(resp, function (data) {
              if (!data.results) return null;
              // 跳过 person 结果，只取 movie/tv 第一条
              for (let i = 0; i < data.results.length; i++) {
                const r = data.results[i];
                if (r.media_type === 'movie' || r.media_type === 'tv') return r;
              }
              return null;
            }, 'title', 'fuzzy');
          }).catch(function () { noMatch(); });
        }
      });
    },
  });

  // --- Trakt ---
  // 公开评分端点只需 Client ID（HTTP 头 trakt-api-key），无 OAuth、无用户信息暴露。
  // 用户需自行去 trakt.tv/oauth/applications/new 注册一个 app 拿 Client ID，跟 TMDB Key 同模式。
  sources.push({
    key: 'trakt', label: 'Trakt', version: 2,
    types: ['movie'],  // 'movie' 覆盖豆瓣电影 + 电视剧条目页（豆瓣类型层不区分）
    requiredConfig: ['traktClientId'],
    channels: [{ channelKey: 'trakt', label: 'Trakt', icon: 'https://walter.trakt.tv/hotlink-ok/public/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const config = readConfig();
        const clientId = config.traktClientId;
        const headers = {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': clientId,
        };
        const fallbackUrl = 'https://trakt.tv/search?query=' + encodeURIComponent(meta.title || '');

        function noMatch() {
          resolve({ trakt: { channelKey: 'trakt', status: 'no_match', url: fallbackUrl } });
        }

        // 从 Trakt search response 决定用哪个对象的评分 + 公开 URL。
        // Trakt /search/imdb 可返回 type: 'movie' | 'show' | 'season' | 'episode'。
        //
        // 关键发现：豆瓣 TV 季/集页面（如"亢奋第三季"）的 IMDB ID 通常指向某一集
        // （如 tt17719220 = Euphoria S3E1 "Andale"），Trakt 据此返回 type='episode'。
        // 显示单集评分作为"整季评分"会误导；豆瓣"剧集"页应该展示 show 级别评分（跟 IMDB
        // 在 TV 上的行为一致：show-level rating + show URL）。
        // 所以 season/episode 类型 → 用 parent show 的 rating 和 URL（show 在响应里同时存在）。
        function pickRatingAndUrl(first) {
          const type = first.type;
          if (type === 'movie' && first.movie) {
            const slug = first.movie.ids && first.movie.ids.slug;
            return {
              ratingItem: first.movie,
              url: slug ? 'https://trakt.tv/movies/' + slug : null,
            };
          }
          // show / season / episode 一律走 show 级
          if (first.show) {
            const slug = first.show.ids && first.show.ids.slug;
            return {
              ratingItem: first.show,
              url: slug ? 'https://trakt.tv/shows/' + slug : null,
            };
          }
          return null;
        }

        function buildSuccess(ratingItem, publicUrl, matchedBy, matchConfidence) {
          const score = parseFloat(ratingItem.rating);
          const count = parseInt(ratingItem.votes, 10) || 0;
          const externalId = (ratingItem.ids && (ratingItem.ids.slug || String(ratingItem.ids.trakt))) || null;
          if (isNaN(score) || score === 0) {
            resolve({ trakt: { channelKey: 'trakt', status: 'no_rating', url: publicUrl } });
            return;
          }
          resolve({
            trakt: {
              channelKey: 'trakt',
              status: 'success',
              score: score,
              scoreMax: 10,
              displayValue: score.toFixed(1) + '/10',
              count: count,
              countText: count.toLocaleString(),
              url: publicUrl,
              matchedBy: matchedBy,
              matchConfidence: matchConfidence,
              externalId: externalId,
            },
          });
        }

        function handleResp(resp, matchedBy, matchConfidence) {
          if (resp.status === 401 || resp.status === 403) {
            resolve({ trakt: { channelKey: 'trakt', status: 'error', url: fallbackUrl } });
            return;
          }
          if (resp.status === 429) {
            resolve({ trakt: { channelKey: 'trakt', status: 'rate_limited', url: fallbackUrl } });
            return;
          }
          if (resp.status < 200 || resp.status >= 300) {
            noMatch();
            return;
          }
          try {
            const data = JSON.parse(resp.responseText);
            if (!Array.isArray(data) || data.length === 0) { noMatch(); return; }
            const first = data[0];
            const picked = pickRatingAndUrl(first);
            if (!picked || !picked.ratingItem) { noMatch(); return; }
            buildSuccess(picked.ratingItem, picked.url || fallbackUrl, matchedBy, matchConfidence);
          } catch (e) {
            noMatch();
          }
        }

        if (meta.imdbId) {
          // 优先 IMDB ID 直链 —— 100% 命中（如果该作品在 Trakt 上），无 fuzzy
          const url = 'https://api.trakt.tv/search/imdb/' + encodeURIComponent(meta.imdbId) + '?extended=full';
          deps.request(url, { headers: headers }).then(function (resp) {
            handleResp(resp, 'imdb_id', 'exact');
          }).catch(function () { noMatch(); });
        } else {
          // 无 IMDB ID 时退回标题搜索，仅当含拉丁字母（Trakt 几乎不收华语片）
          const titleForSearch = meta.originalTitle || meta.title || '';
          if (!/[a-zA-Z]/.test(titleForSearch)) { noMatch(); return; }
          const yearParam = meta.year ? '&years=' + encodeURIComponent(meta.year) : '';
          const url = 'https://api.trakt.tv/search/movie,show?query=' +
            encodeURIComponent(titleForSearch) + yearParam + '&extended=full&limit=5';
          deps.request(url, { headers: headers }).then(function (resp) {
            handleResp(resp, 'title', 'fuzzy');
          }).catch(function () { noMatch(); });
        }
      });
    },
  });

  // --- Bangumi ---
  sources.push({
    key: 'bangumi',
    label: 'Bangumi',
    version: 1,
    types: ['movie'],
    requiredConfig: null,
    channels: [{ channelKey: 'bangumi', label: 'Bangumi', icon: 'https://bgm.tv/img/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // Search: https://api.bgm.tv/search/subject/{keyword}?type=2&responseGroup=large
        // type=2 → anime; responseGroup=large 才返回 rating; MUST send User-Agent
        const keyword = encodeURIComponent(meta.title || '');
        const apiUrl = 'https://api.bgm.tv/search/subject/' + keyword + '?type=2&responseGroup=large';

        function noMatch() {
          resolve({ bangumi: { channelKey: 'bangumi', status: 'no_match' } });
        }
        function errResult() {
          resolve({ bangumi: { channelKey: 'bangumi', status: 'error' } });
        }

        deps.request(apiUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'douban-rating-hub/1.0 (https://github.com/lzblack)',
          },
        }).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) { errResult(); return; }
          try {
            const data = JSON.parse(resp.responseText);
            const list = data.list || [];
            // find first result with type=2 (anime)
            let item = null;
            for (let i = 0; i < list.length; i++) {
              if (list[i].type === 2) { item = list[i]; break; }
            }
            if (!item) { noMatch(); return; }
            const score = item.rating ? parseFloat(item.rating.score) : NaN;
            const total = item.rating ? item.rating.total : null;
            const pageUrl = 'https://bgm.tv/subject/' + item.id;
            if (isNaN(score) || score <= 0) {
              resolve({ bangumi: { channelKey: 'bangumi', status: 'no_rating', url: pageUrl } });
              return;
            }
            resolve({
              bangumi: {
                channelKey: 'bangumi',
                status: 'success',
                score: score,
                scoreMax: 10,
                displayValue: score.toFixed(1) + '/10',
                count: total || null,
                countText: total ? total + ' 人评分' : null,
                url: pageUrl,
                matchedBy: 'title',
                matchConfidence: 'fuzzy',
                externalId: String(item.id),
              },
            });
          } catch (e) { errResult(); }
        }).catch(function () { errResult(); });
      });
    },
  });

  // --- MAL ---
  sources.push({
    key: 'mal',
    label: 'MAL',
    version: 1,
    types: ['movie'],
    requiredConfig: null,
    channels: [{ channelKey: 'mal', label: 'MAL', icon: 'https://cdn.myanimelist.net/images/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // Search: https://api.jikan.moe/v4/anime?q={title}&limit=3
        const keyword = encodeURIComponent(meta.originalTitle || meta.title || '');
        const apiUrl = 'https://api.jikan.moe/v4/anime?q=' + keyword + '&limit=3';

        function noMatch() {
          resolve({ mal: { channelKey: 'mal', status: 'no_match' } });
        }
        function errResult() {
          resolve({ mal: { channelKey: 'mal', status: 'error' } });
        }

        deps.request(apiUrl, { headers: { 'Accept': 'application/json' } }).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) { errResult(); return; }
          try {
            const data = JSON.parse(resp.responseText);
            const list = data.data || [];
            if (!list.length) { noMatch(); return; }
            const item = list[0];
            const score = item.score != null ? parseFloat(item.score) : NaN;
            const scoredBy = item.scored_by || null;
            const pageUrl = 'https://myanimelist.net/anime/' + item.mal_id;
            if (isNaN(score) || score <= 0) {
              resolve({ mal: { channelKey: 'mal', status: 'no_rating', url: pageUrl } });
              return;
            }
            resolve({
              mal: {
                channelKey: 'mal',
                status: 'success',
                score: score,
                scoreMax: 10,
                displayValue: score.toFixed(2) + '/10',
                count: scoredBy,
                countText: scoredBy ? scoredBy.toLocaleString() + ' votes' : null,
                url: pageUrl,
                matchedBy: 'title',
                matchConfidence: 'fuzzy',
                externalId: String(item.mal_id),
              },
            });
          } catch (e) { errResult(); }
        }).catch(function () { errResult(); });
      });
    },
  });

  // --- Goodreads ---
  sources.push({
    key: 'goodreads', label: 'Goodreads', version: 2,
    types: ['book'], requiredConfig: null,
    channels: [{ channelKey: 'goodreads', label: 'Goodreads', icon: 'https://www.goodreads.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // Query cascade: ISBN → originalTitle → title
        const queries = [];
        if (meta.isbn) queries.push(meta.isbn);
        if (meta.originalTitle && meta.originalTitle !== meta.title) queries.push(meta.originalTitle);
        if (meta.title) queries.push(meta.title);
        if (!queries.length) {
          resolve({ goodreads: { channelKey: 'goodreads', status: 'no_match', url: 'https://www.goodreads.com/' } });
          return;
        }

        const detailPathRe = /goodreads\.com\/book\/show\//;

        function noMatch() {
          const url = 'https://www.goodreads.com/search?q=' + encodeURIComponent(queries[0]);
          resolve({ goodreads: { channelKey: 'goodreads', status: 'no_match', url: url } });
        }

        function parseDetail(doc, url) {
          const ratingEl = doc.querySelector('.RatingStatistics__rating');
          const score = ratingEl ? parseFloat(ratingEl.textContent.trim()) : NaN;
          if (isNaN(score)) return null;

          const countEl = doc.querySelector('[data-testid="ratingsCount"]');
          let count = 0;
          if (countEl) {
            const cm = countEl.textContent.replace(/,/g, '').match(/(\d+)/);
            if (cm) count = parseInt(cm[1], 10);
          }
          return { score: score, count: count, url: url };
        }

        function buildSuccess(parsed, matchedBy, confidence) {
          resolve({
            goodreads: {
              channelKey: 'goodreads',
              status: 'success',
              score: parsed.score,
              scoreMax: 5,
              displayValue: parsed.score.toFixed(2) + '/5',
              count: parsed.count || null,
              countText: parsed.count ? parsed.count.toLocaleString() : null,
              url: parsed.url,
              matchedBy: matchedBy,
              matchConfidence: confidence,
              externalId: parsed.url,
            },
          });
        }

        function tryQuery(queryIndex) {
          if (queryIndex >= queries.length) { noMatch(); return; }
          const query = queries[queryIndex];
          const isIsbn = queryIndex === 0 && !!meta.isbn;
          const matchedBy = isIsbn ? 'isbn' : 'title';
          const confidence = isIsbn ? 'exact' : 'fuzzy';
          // ISBN 走 /book/isbn/{isbn} 直链（302 → 详情页），跳过被反爬阻断的 /search?q=
          // 非 ISBN 仍走 /search?q=，保留原 fallback 行为（即便目前返 202，未来若恢复也能用）
          const url = isIsbn
            ? 'https://www.goodreads.com/book/isbn/' + encodeURIComponent(query)
            : 'https://www.goodreads.com/search?q=' + encodeURIComponent(query);

          fetchSearchDetail(deps, {
            searchUrl: url,
            baseUrl: 'https://www.goodreads.com',
            isDetailUrl: function (finalUrl) { return detailPathRe.test(finalUrl); },
            pickDetailHref: function (doc) {
              const linkEl = doc.querySelector('a.bookTitle');
              return linkEl ? (linkEl.getAttribute('href') || '') : '';
            },
            acceptDetailResp: responseOk,
            parseDetail: parseDetail,
          }).then(function (result) {
            if (result.reachedDetail && result.parsed) {
              buildSuccess(result.parsed, matchedBy, confidence);
            } else {
              tryQuery(queryIndex + 1);
            }
          });
        }

        tryQuery(0);
      });
    },
  });

  // --- Amazon ---
  sources.push({
    key: 'amazon', label: 'Amazon', version: 2,
    types: ['book'], requiredConfig: null,
    channels: [{ channelKey: 'amazon', label: 'Amazon', icon: 'https://www.amazon.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const creator = meta.creator || '';
        const titleForCheck = meta.originalTitle || meta.title || '';

        // CJK-only 且无 ISBN 的书直接跳过：Amazon US 几乎不收录纯中文书，
        // 避免无谓搜索 + 不把中文书名留在 Amazon 搜索历史/服务端 access log
        if (!meta.isbn && !/[a-zA-Z]/.test(titleForCheck)) {
          resolve({ amazon: { channelKey: 'amazon', status: 'no_match', url: 'https://www.amazon.com/' } });
          return;
        }

        // ISBN-13 → ISBN-10 (978 前缀书，绝大多数)
        // 关键作用：让 ISBN 类查询能走 /dp/{ISBN-10} 直链，完全绕开 /s?k= 搜索
        function isbn13ToIsbn10(isbn13) {
          if (!isbn13 || isbn13.length !== 13 || !isbn13.startsWith('978')) return null;
          const core = isbn13.substring(3, 12);
          let sum = 0;
          for (let i = 0; i < 9; i++) {
            const d = parseInt(core[i], 10);
            if (isNaN(d)) return null;
            sum += d * (i + 1);
          }
          const check = sum % 11;
          return core + (check === 10 ? 'X' : String(check));
        }

        // Query cascade: 每项 { kind: 'dp' | 'search', value, isIsbn }
        const queries = [];
        // 1. 有 ISBN → 优先走 /dp/{ASIN} 直链（不发任何搜索查询）
        if (meta.isbn) {
          const isbn = meta.isbn;
          if (isbn.length === 10) {
            queries.push({ kind: 'dp', value: isbn, isIsbn: true });
          } else if (isbn.length === 13) {
            const isbn10 = isbn13ToIsbn10(isbn);
            if (isbn10) {
              queries.push({ kind: 'dp', value: isbn10, isIsbn: true });
            } else {
              // 979 前缀 ISBN-13 无 ISBN-10 对应，退回搜索（仍按 ISBN 搜，比标题安全）
              queries.push({ kind: 'search', value: isbn, isIsbn: true });
            }
          }
        }
        // 2. originalTitle + creator（含拉丁字母时才搜，CJK-only 上面已 early return）
        if (meta.originalTitle && meta.originalTitle !== meta.title && /[a-zA-Z]/.test(meta.originalTitle)) {
          queries.push({
            kind: 'search',
            value: creator ? meta.originalTitle + ' ' + creator : meta.originalTitle,
            isIsbn: false,
          });
        }
        // 3. title + creator
        if (meta.title && /[a-zA-Z]/.test(meta.title)) {
          queries.push({
            kind: 'search',
            value: creator ? meta.title + ' ' + creator : meta.title,
            isIsbn: false,
          });
        }
        if (!queries.length) {
          resolve({ amazon: { channelKey: 'amazon', status: 'no_match', url: 'https://www.amazon.com/' } });
          return;
        }

        const dpPathRe = /amazon\.com(\/[^/]+)?\/dp\//;

        function noMatch() {
          const first = queries[0];
          const url = first.kind === 'dp'
            ? 'https://www.amazon.com/dp/' + first.value
            : 'https://www.amazon.com/s?k=' + encodeURIComponent(first.value);
          resolve({ amazon: { channelKey: 'amazon', status: 'no_match', url: url } });
        }

        function parseDetail(doc, url) {
          // Try [data-hook="rating-out-of-text"] first, fall back to .a-icon-alt
          let ratingEl = doc.querySelector('[data-hook="rating-out-of-text"]');
          if (!ratingEl) {
            const candidates = doc.querySelectorAll('.a-icon-alt');
            for (let i = 0; i < candidates.length; i++) {
              if (/out of 5 stars/i.test(candidates[i].textContent)) {
                ratingEl = candidates[i];
                break;
              }
            }
          }
          if (!ratingEl) return null;
          const ratingMatch = ratingEl.textContent.match(/([\d.]+)/);
          if (!ratingMatch) return null;
          const score = parseFloat(ratingMatch[1]);
          if (isNaN(score)) return null;

          const countEl = doc.querySelector('#acrCustomerReviewText') ||
                        doc.querySelector('[data-hook="total-review-count"]');
          let count = 0;
          if (countEl) {
            const cm = countEl.textContent.replace(/,/g, '').match(/(\d+)/);
            if (cm) count = parseInt(cm[1], 10);
          }
          return { score: score, count: count, url: url };
        }

        function buildSuccess(parsed, matchedBy, confidence) {
          resolve({
            amazon: {
              channelKey: 'amazon',
              status: 'success',
              score: parsed.score,
              scoreMax: 5,
              displayValue: parsed.score.toFixed(1) + '/5',
              count: parsed.count || null,
              countText: parsed.count ? parsed.count.toLocaleString() : null,
              url: parsed.url,
              matchedBy: matchedBy,
              matchConfidence: confidence,
              externalId: parsed.url,
            },
          });
        }

        function fetchDetail(url, matchedBy, confidence, onFail) {
          deps.request(url, { headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } })
            .then(function (resp) {
              if (resp.status < 200 || resp.status >= 300) { onFail(); return; }
              const doc = deps.parseHTML(resp.responseText);
              const parsed = parseDetail(doc, resp.finalUrl || url);
              if (parsed) { buildSuccess(parsed, matchedBy, confidence); }
              else { onFail(); }
            }).catch(onFail);
        }

        function tryQuery(queryIndex) {
          if (queryIndex >= queries.length) { noMatch(); return; }
          const q = queries[queryIndex];
          const matchedBy = q.isIsbn ? 'isbn' : 'title';
          const confidence = q.isIsbn ? 'exact' : 'fuzzy';

          // /dp/ 直链路径：单次请求拿详情页，零搜索查询泄漏
          if (q.kind === 'dp') {
            const dpUrl = 'https://www.amazon.com/dp/' + q.value;
            fetchDetail(dpUrl, matchedBy, confidence, function () { tryQuery(queryIndex + 1); });
            return;
          }

          // /s?k= 搜索路径
          const searchUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(q.value);
          const htmlHeaders = { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' };
          fetchSearchDetail(deps, {
            searchUrl: searchUrl,
            searchOpts: { headers: htmlHeaders },
            detailOpts: { headers: htmlHeaders },
            baseUrl: 'https://www.amazon.com',
            isDetailUrl: function (finalUrl) { return dpPathRe.test(finalUrl); },
            pickDetailHref: function (doc) {
              const resultEl = doc.querySelector('[data-component-type="s-search-result"]');
              if (!resultEl) return '';
              const linkEl = resultEl.querySelector('h2 a') || resultEl.querySelector('a[href*="/dp/"]');
              return linkEl ? (linkEl.getAttribute('href') || '') : '';
            },
            acceptDetailResp: responseOk,
            parseDetail: parseDetail,
          }).then(function (result) {
            if (result.reachedDetail && result.parsed) {
              buildSuccess(result.parsed, matchedBy, confidence);
            } else {
              tryQuery(queryIndex + 1);
            }
          });
        }

        tryQuery(0);
      });
    },
  });

  // --- 微信读书 ---
  sources.push({
    key: 'weread', label: '微信读书', version: 1,
    types: ['book'], requiredConfig: null,
    channels: [{ channelKey: 'weread', label: '微信读书', icon: 'https://weread.qq.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const title = meta.title || '';
        const searchPageUrl = 'https://weread.qq.com/web/search/books?keyword=' + encodeURIComponent(title);

        function noMatch() {
          resolve({ weread: { channelKey: 'weread', status: 'no_match', url: searchPageUrl } });
        }

        if (!title) { noMatch(); return; }

        // Normalize: lowercase, keep CJK and word chars only
        function normalizeTitle(t) {
          return t.toLowerCase().replace(/[^\w\u4e00-\u9fff\u3040-\u30ff]/g, '');
        }

        const normalizedQuery = normalizeTitle(title);
        const apiUrl = 'https://weread.qq.com/web/search/global?keyword=' + encodeURIComponent(title);

        deps.request(apiUrl, {
          headers: { 'Referer': 'https://weread.qq.com/', 'Accept': 'application/json' },
        }).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) { noMatch(); return; }
          let data;
          try { data = JSON.parse(resp.responseText); } catch (e) { noMatch(); return; }

          const books = (data && data.books) ? data.books : [];
          if (!books.length) { noMatch(); return; }

          // Match: exact → partial → first result
          let matched = null;
          for (let i = 0; i < books.length; i++) {
            const bookInfo = books[i].bookInfo || books[i];
            const bookTitle = normalizeTitle(bookInfo.title || '');
            if (bookTitle === normalizedQuery) { matched = bookInfo; break; }
          }
          if (!matched) {
            for (let j = 0; j < books.length; j++) {
              const bi = books[j].bookInfo || books[j];
              const bt = normalizeTitle(bi.title || '');
              if (bt.indexOf(normalizedQuery) !== -1 || normalizedQuery.indexOf(bt) !== -1) {
                matched = bi;
                break;
              }
            }
          }
          if (!matched) {
            matched = books[0].bookInfo || books[0];
          }

          const rawRating = matched.newRating;
          if (rawRating == null || rawRating === 0) {
            resolve({ weread: { channelKey: 'weread', status: 'no_rating', url: searchPageUrl } });
            return;
          }

          // newRating is on a 0–1000 scale → percentage display
          const percentage = rawRating / 10;
          const count = matched.newRatingCount || 0;

          resolve({
            weread: {
              channelKey: 'weread',
              status: 'success',
              score: percentage,
              scoreMax: 100,
              displayValue: percentage.toFixed(1) + '%',
              count: count || null,
              countText: count ? count.toLocaleString() : null,
              url: searchPageUrl,
              matchedBy: 'title',
              matchConfidence: 'fuzzy',
              externalId: matched.bookId ? String(matched.bookId) : null,
            },
          });
        }).catch(function () { noMatch(); });
      });
    },
  });

  // --- Discogs ---
  sources.push({
    key: 'discogs',
    label: 'Discogs',
    version: 1,
    types: ['music'],
    requiredConfig: null,
    channels: [{ channelKey: 'discogs', label: 'Discogs', icon: 'https://www.discogs.com/favicon.ico' }],
    fetch: function (meta, deps) {
      let query = meta.originalTitle || meta.title;
      if (meta.creator) query += ' ' + meta.creator;
      const searchUrl = 'https://api.discogs.com/database/search?q=' + encodeURIComponent(query) + '&type=master&per_page=3';

      function noMatch() {
        return { discogs: { channelKey: 'discogs', status: 'no_match', url: 'https://www.discogs.com/search?q=' + encodeURIComponent(meta.title) + '&type=master' } };
      }
      function noRating(url) {
        return { discogs: { channelKey: 'discogs', status: 'no_rating', url: url } };
      }

      return deps.request(searchUrl, {
        headers: { 'User-Agent': 'DoubanRatingHub/0.1' },
      }).then(function (resp) {
        if (resp.status !== 200) return noMatch();
        const data = JSON.parse(resp.responseText);
        if (!data.results || data.results.length === 0) return noMatch();

        const master = data.results[0];
        const masterId = master.id;
        const masterUrl = 'https://www.discogs.com/master/' + masterId;

        return deps.request('https://api.discogs.com/masters/' + masterId, {
          headers: { 'User-Agent': 'DoubanRatingHub/0.1' },
        }).then(function (masterResp) {
          const masterData = JSON.parse(masterResp.responseText);
          const mainReleaseId = masterData.main_release;
          if (!mainReleaseId) return noRating(masterUrl);

          return deps.request('https://api.discogs.com/releases/' + mainReleaseId, {
            headers: { 'User-Agent': 'DoubanRatingHub/0.1' },
          }).then(function (releaseResp) {
            const releaseData = JSON.parse(releaseResp.responseText);
            const rating = releaseData.community && releaseData.community.rating;
            if (!rating || !rating.average || rating.count === 0) return noRating(masterUrl);

            return {
              discogs: {
                channelKey: 'discogs',
                status: 'success',
                score: rating.average,
                scoreMax: 5,
                displayValue: rating.average.toFixed(2) + '/5',
                count: rating.count,
                countText: rating.count.toLocaleString(),
                url: masterUrl,
                matchedBy: 'title',
                matchConfidence: 'fuzzy',
                externalId: String(masterId),
              },
            };
          });
        });
      }).catch(function () { return noMatch(); });
    },
  });

  // --- Steam ---
  sources.push({
    key: 'steam',
    label: 'Steam',
    version: 2,
    types: ['game'],
    requiredConfig: null,
    channels: [{ channelKey: 'steam', label: 'Steam', icon: 'https://store.steampowered.com/favicon.ico' }],
    fetch: function (meta, deps) {
      // Use English title for search (Steam search works best with English)
      const query = stripSeason(meta.originalTitle || meta.title || '');
      const searchUrl = 'https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(query) + '&cc=us&l=english';

      return new Promise(function (resolve) {
        function noMatch() {
          resolve({ steam: { channelKey: 'steam', status: 'no_match', url: 'https://store.steampowered.com/search/?term=' + encodeURIComponent(meta.title || '') } });
        }

        deps.request(searchUrl).then(function (resp) {
          if (resp.status !== 200) { noMatch(); return; }
          const data = JSON.parse(resp.responseText);
          if (!data.items || data.items.length === 0) { noMatch(); return; }

          // Title match: normalize and compare
          const normalize = function (s) { return (s || '').replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, ''); };
          const queryNorm = normalize(query);
          let bestItem = null;
          for (let i = 0; i < Math.min(data.items.length, 10); i++) {
            if (normalize(data.items[i].name) === queryNorm) {
              bestItem = data.items[i];
              break;
            }
          }
          // Fallback to first result if no exact match
          if (!bestItem) bestItem = data.items[0];

          const appId = bestItem.id;
          const storeUrl = 'https://store.steampowered.com/app/' + appId + '/';

          // Fetch review summary
          const reviewUrl = 'https://store.steampowered.com/appreviews/' + appId + '?json=1&language=all&purchase_type=all&num_per_page=0';
          deps.request(reviewUrl).then(function (reviewResp) {
            if (reviewResp.status !== 200) {
              resolve({ steam: { channelKey: 'steam', status: 'no_rating', url: storeUrl } });
              return;
            }
            const reviewData = JSON.parse(reviewResp.responseText);
            const summary = reviewData.query_summary;
            if (!summary || summary.total_reviews === 0) {
              resolve({ steam: { channelKey: 'steam', status: 'no_rating', url: storeUrl } });
              return;
            }

            // Calculate positive percentage
            const positive = summary.total_positive || 0;
            const total = summary.total_reviews || 0;
            const pct = Math.round(positive / total * 100);
            // review_score_desc: "Overwhelmingly Positive", "Very Positive", "Positive", "Mostly Positive", "Mixed", etc.
            const desc = summary.review_score_desc || '';

            resolve({
              steam: {
                channelKey: 'steam',
                status: 'success',
                score: pct,
                scoreMax: 100,
                displayValue: pct + '%',
                count: total,
                countText: total.toLocaleString(),
                url: storeUrl,
                matchedBy: normalize(bestItem.name) === queryNorm ? 'title' : 'search_first',
                matchConfidence: 'fuzzy',
                externalId: String(appId),
              },
            });
          }).catch(function () {
            resolve({ steam: { channelKey: 'steam', status: 'no_rating', url: storeUrl } });
          });
        }).catch(function () { noMatch(); });
      });
    },
  });

  // --- Apple Podcasts ---
  sources.push({
    key: 'apple_podcasts',
    label: '苹果播客',
    version: 1,
    types: ['podcast'],
    requiredConfig: null,
    channels: [{ channelKey: 'apple_podcasts', label: '苹果播客', icon: 'https://podcasts.apple.com/favicon.ico' }],
    fetch: function (meta, deps) {
      const searchUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(meta.title) + '&media=podcast&country=us&limit=5';

      function noMatch() {
        return { apple_podcasts: { channelKey: 'apple_podcasts', status: 'no_match', url: 'https://podcasts.apple.com/us/search?term=' + encodeURIComponent(meta.title) } };
      }

      return deps.request(searchUrl, {
        headers: { 'Accept': 'application/json' },
      }).then(function (resp) {
        const data = JSON.parse(resp.responseText);
        if (!data.results || data.results.length === 0) return noMatch();

        // 按标题匹配最佳结果
        const normalizedTitle = meta.title.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
        let best = data.results[0];
        for (let i = 0; i < data.results.length; i++) {
          const nt = data.results[i].trackName.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
          if (nt === normalizedTitle || nt.indexOf(normalizedTitle) !== -1 || normalizedTitle.indexOf(nt) !== -1) {
            best = data.results[i];
            break;
          }
        }

        const trackId = best.trackId;
        const podcastUrl = 'https://podcasts.apple.com/us/podcast/id' + trackId;

        return deps.request(podcastUrl).then(function (pageResp) {
          const doc = deps.parseHTML(pageResp.responseText);

          // 优先尝试 JSON-LD aggregateRating
          const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (let j = 0; j < scripts.length; j++) {
            try {
              const ld = JSON.parse(scripts[j].textContent);
              if (ld.aggregateRating) {
                const score = parseFloat(ld.aggregateRating.ratingValue);
                const count = parseInt(ld.aggregateRating.reviewCount || ld.aggregateRating.ratingCount, 10) || 0;
                if (score > 0) {
                  return {
                    apple_podcasts: {
                      channelKey: 'apple_podcasts',
                      status: 'success',
                      score: score,
                      scoreMax: 5,
                      displayValue: score.toFixed(1) + '/5',
                      count: count,
                      countText: count.toLocaleString(),
                      url: podcastUrl,
                      matchedBy: 'title',
                      matchConfidence: 'fuzzy',
                      externalId: String(trackId),
                    },
                  };
                }
              }
            } catch (e) { /* skip */ }
          }

          // 回退：aria-label 评分元素
          const ratingEl = doc.querySelector('[data-testid="show-hero__rating"]');
          if (ratingEl) {
            const ariaMatch = (ratingEl.getAttribute('aria-label') || '').match(/([\d.]+)\s*out of\s*5/);
            const countMatch = (ratingEl.getAttribute('aria-label') || '').match(/([\d,]+)\s*ratings/);
            if (ariaMatch) {
              const s = parseFloat(ariaMatch[1]);
              const c = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 0;
              return {
                apple_podcasts: {
                  channelKey: 'apple_podcasts',
                  status: 'success',
                  score: s,
                  scoreMax: 5,
                  displayValue: s.toFixed(1) + '/5',
                  count: c,
                  countText: c.toLocaleString(),
                  url: podcastUrl,
                  matchedBy: 'title',
                  matchConfidence: 'fuzzy',
                  externalId: String(trackId),
                },
              };
            }
          }

          return { apple_podcasts: { channelKey: 'apple_podcasts', status: 'no_rating', url: podcastUrl } };
        });
      }).catch(function () { return noMatch(); });
    },
  });

  // --- 小宇宙 ---
  sources.push({
    key: 'xiaoyuzhou',
    label: '小宇宙',
    version: 1,
    types: ['podcast'],
    requiredConfig: null,
    channels: [{ channelKey: 'xiaoyuzhou', label: '小宇宙', icon: 'https://www.xiaoyuzhoufm.com/favicon.ico' }],
    fetch: function (meta, deps) {
      function noMatch() {
        return { xiaoyuzhou: { channelKey: 'xiaoyuzhou', status: 'no_match', url: 'https://xyzrank.com/' } };
      }

      return deps.request('https://xyzrank.eddiehe.top/full.json').then(function (resp) {
        const raw = JSON.parse(resp.responseText);
        const podcasts = raw.data && raw.data.podcasts;
        if (!podcasts) return noMatch();

        // Normalize: lowercase, keep word chars and CJK only
        function norm(t) {
          return t.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, '');
        }
        const normalizedTitle = norm(meta.title || '');
        let match = null;

        // Exact match first, then partial
        for (let i = 0; i < podcasts.length; i++) {
          if (norm(podcasts[i].name) === normalizedTitle) { match = podcasts[i]; break; }
        }
        if (!match) {
          for (let i = 0; i < podcasts.length; i++) {
            const nt = norm(podcasts[i].name);
            if (nt.includes(normalizedTitle) || normalizedTitle.includes(nt)) { match = podcasts[i]; break; }
          }
        }
        if (!match) return noMatch();

        const xyzLink = match.links && match.links.find(function (l) { return l.name === 'xyz'; });
        const xyzUrl = xyzLink ? xyzLink.url : null;
        const avgPlay = match.avgPlayCount || 0;
        const rank = match.rank;

        return {
          xiaoyuzhou: {
            channelKey: 'xiaoyuzhou',
            status: 'success',
            score: rank,
            scoreMax: null,
            displayValue: '榜#' + rank,
            count: avgPlay,
            countText: avgPlay >= 10000 ? (avgPlay / 10000).toFixed(0) + '万播' : avgPlay.toLocaleString(),
            url: xyzUrl || 'https://xyzrank.com/',
            matchedBy: 'title',
            matchConfidence: 'fuzzy',
            externalId: match.id,
          },
        };
      }).catch(function () { return noMatch(); });
    },
  });

  // --- NeoDB ---
  sources.push({
    key: 'neodb',
    label: 'NeoDB',
    version: 1,
    types: ['book', 'movie', 'music', 'game', 'drama', 'podcast'],
    requiredConfig: null,
    channels: [{ channelKey: 'neodb', label: 'NeoDB', icon: 'https://neodb.social/s/img/icon.png' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // 分类映射：music → album；podcast/drama 用 'all' 避免 category 过滤导致空结果
        const categoryMap = { book: 'book', movie: 'movie', music: 'album', game: 'game', drama: 'all', podcast: 'all' };
        const category = categoryMap[meta.type] || 'all';

        // 搜索查询瀑布
        const queries = [];
        // podcast/drama: NeoDB 不索引豆瓣播客/舞台剧 URL，跳过 URL 查询
        if (meta.type !== 'podcast' && meta.type !== 'drama') {
          const doubanUrl = location.href.split('?')[0].split('#')[0];
          queries.push(doubanUrl);
        }
        if (meta.originalTitle && meta.originalTitle !== meta.title) {
          queries.push(meta.originalTitle);
        }
        if (meta.title) {
          // 对含分隔符的标题（如 "半拿铁 | 商业沉浮录"），先试短标题
          const parts = meta.title.split(/[|｜]/);
          if (parts.length > 1) {
            const shortTitle = parts[0].trim();
            if (shortTitle) queries.push(shortTitle);
          }
          queries.push(meta.title);
        }

        // 匹配 NeoDB 条目详情页路径
        const detailPathRe = /neodb\.social\/(book|movie|album|music|game|tv\/season|tv|podcast|performance)\//;

        function parseDetail(doc, url) {
          // 优先用 JSON-LD aggregateRating
          const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (let i = 0; i < scripts.length; i++) {
            try {
              const data = JSON.parse(scripts[i].textContent);
              const ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                const score = parseFloat(ar.ratingValue);
                const count = parseInt(ar.ratingCount || ar.reviewCount, 10) || 0;
                if (isNaN(score)) continue;
                return { found: true, hasRating: score > 0, score: score, count: count, url: url };
              }
            } catch (e) { /* skip */ }
          }
          // 回退：DOM 结构解析
          const displayBlock =
            doc.querySelector('#item-rating .display') ||
            doc.querySelector('.rating .display') ||
            doc.querySelector('.display');
          const undisplayEl = doc.querySelector('.undisplay');
          if (undisplayEl && !displayBlock) {
            return { found: true, hasRating: false, url: url };
          }
          // 尝试找评分数字
          let ratingEl =
            doc.querySelector('.rating-num') ||
            doc.querySelector('[itemprop="ratingValue"]');
          if (!ratingEl && displayBlock) {
            ratingEl = displayBlock.querySelector('hgroup h3') || displayBlock.querySelector('h3');
          }
          if (!ratingEl) {
            ratingEl = Array.from(doc.querySelectorAll('h1,h2,h3,span,strong')).find(function (el) {
              return /[\d.]+\s*\/\s*10/.test(el.textContent);
            });
          }
          if (!ratingEl) return { found: true, hasRating: false, url: url };
          const ratingMatch = ratingEl.textContent.match(/[\d.]+/);
          if (!ratingMatch) return { found: true, hasRating: false, url: url };
          const score = parseFloat(ratingMatch[0]);
          // 评分人数
          let countEl =
            doc.querySelector('.rating-people') ||
            doc.querySelector('[itemprop="ratingCount"]');
          if (!countEl && displayBlock) {
            countEl = Array.from(displayBlock.querySelectorAll('p,span,small')).find(function (el) {
              return /\d+\s*(个评分|人评分|ratings?)/i.test(el.textContent);
            });
          }
          let count = 0;
          if (countEl) {
            const cm = countEl.textContent.replace(/,/g, '').match(/(\d+)/);
            if (cm) count = parseInt(cm[1], 10);
          }
          return { found: true, hasRating: score > 0, score: score, count: count, url: url };
        }

        function buildResult(parsed, matchedBy, confidence) {
          const searchUrl = 'https://neodb.social/search?q=' + encodeURIComponent(queries[0]) + '&category=' + category;
          if (!parsed || !parsed.found) {
            return { neodb: { channelKey: 'neodb', status: 'no_match', url: searchUrl } };
          }
          if (!parsed.hasRating) {
            return { neodb: { channelKey: 'neodb', status: 'no_rating', url: parsed.url } };
          }
          return {
            neodb: {
              channelKey: 'neodb',
              status: 'success',
              score: parsed.score,
              scoreMax: 10,
              displayValue: parsed.score.toFixed(1) + '/10',
              count: parsed.count,
              countText: parsed.count.toLocaleString(),
              url: parsed.url,
              matchedBy: matchedBy,
              matchConfidence: confidence,
              externalId: parsed.url,
            },
          };
        }

        function fetchDetail(url, matchedBy, confidence, onSuccess, onFail) {
          deps.request(url).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) { onFail(); return; }
            const doc = deps.parseHTML(resp.responseText);
            const parsed = parseDetail(doc, resp.finalUrl || url);
            onSuccess(parsed, matchedBy, confidence);
          }).catch(onFail);
        }

        function tryQuery(queryIndex) {
          if (queryIndex >= queries.length) {
            // no_match 链接用标题搜索（不用 Douban URL，因为 NeoDB 不认识）
            const noMatchQuery = meta.title || queries[0];
            const noMatchParams = { q: noMatchQuery };
            if (category !== 'all') noMatchParams.category = category;
            const searchUrl = 'https://neodb.social/search?' + new URLSearchParams(noMatchParams).toString();
            resolve({ neodb: { channelKey: 'neodb', status: 'no_match', url: searchUrl } });
            return;
          }
          const query = queries[queryIndex];
          const isUrlQuery = /^https?:\/\//.test(query);
          const matchedBy = isUrlQuery ? 'douban_url' : 'title';
          const confidence = isUrlQuery ? 'exact' : 'fuzzy';
          const searchParams = { q: query };
          if (category !== 'all') searchParams.category = category;
          const searchUrl = 'https://neodb.social/search?' + new URLSearchParams(searchParams).toString();

          deps.request(searchUrl).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) {
              tryQuery(queryIndex + 1);
              return;
            }
            const finalUrl = resp.finalUrl || searchUrl;
            // 情况一：搜索直接重定向到详情页
            if (detailPathRe.test(finalUrl)) {
              const doc = deps.parseHTML(resp.responseText);
              const parsed = parseDetail(doc, finalUrl);
              if (parsed && parsed.found) {
                resolve(buildResult(parsed, matchedBy, confidence));
              } else {
                tryQuery(queryIndex + 1);
              }
              return;
            }
            // 情况二：搜索列表页，找第一个结果卡片
            const doc = deps.parseHTML(resp.responseText);
            let card = doc.querySelector('.entity-card, .catalog-card, .subject-card');
            let linkEl = card ? (card.querySelector('.title a') || card.querySelector('a')) : null;
            // 回退：podcast/drama 等页面使用不同 class，直接找详情页链接
            if (!linkEl) {
              const detailLinks = doc.querySelectorAll(
                'a[href*="/podcast/"], a[href*="/performance/"], a[href*="/book/"], a[href*="/movie/"], a[href*="/album/"], a[href*="/game/"], a[href*="/tv/"]'
              );
              if (detailLinks.length > 0) linkEl = detailLinks[0];
            }
            if (!linkEl) { tryQuery(queryIndex + 1); return; }
            const href = linkEl.getAttribute('href') || '';
            const detailUrl = href.startsWith('http') ? href : 'https://neodb.social' + href;
            fetchDetail(
              detailUrl,
              matchedBy,
              confidence,
              function (parsed, mb, conf) {
                if (parsed && parsed.found) {
                  resolve(buildResult(parsed, mb, conf));
                } else {
                  tryQuery(queryIndex + 1);
                }
              },
              function () { tryQuery(queryIndex + 1); }
            );
          }).catch(function () { tryQuery(queryIndex + 1); });
        }

        tryQuery(0);
      });
    },
  });

  // ============================================================
  // Scheduler — 并发抓取、缓存、限流
  // ============================================================


  function isCooldownActive(sourceKey) {
    const entry = deps.storage.get('rh:cooldown:' + sourceKey);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      deps.storage.remove('rh:cooldown:' + sourceKey);
      return false;
    }
    return true;
  }

  function setCooldown(sourceKey) {
    deps.storage.set('rh:cooldown:' + sourceKey, { until: Date.now() + 5 * 60 * 1000 });
  }

  function fetchAll(applicableSources, meta, config, onChannelReady) {
    applicableSources.forEach(function (source) {
      const channelKeys = source.channels.map(function (ch) { return ch.channelKey; });

      function emitAll(result) {
        channelKeys.forEach(function (key) {
          onChannelReady(key, Object.assign({ channelKey: key }, result));
        });
      }

      // Pre-flight: 必要配置缺失
      if (source.requiredConfig) {
        const missing = source.requiredConfig.some(function (cfgKey) {
          return !config[cfgKey];
        });
        if (missing) {
          emitAll({ status: 'disabled' });
          return;
        }
      }

      // Pre-flight: 冷却中
      if (isCooldownActive(source.key)) {
        channelKeys.forEach(function (key) {
          onChannelReady(key, { status: 'rate_limited' });
        });
        return;
      }

      // 检查所有 channel 缓存
      const cached = {};
      let allCached = true;
      channelKeys.forEach(function (key) {
        const hit = getCache(meta.doubanId, key, source.version || '1');
        if (hit) {
          cached[key] = hit;
        } else {
          allCached = false;
        }
      });

      if (allCached) {
        channelKeys.forEach(function (key) { onChannelReady(key, cached[key]); });
        return;
      }

      // 先渲染已缓存的 channel
      channelKeys.forEach(function (key) {
        if (cached[key]) onChannelReady(key, cached[key]);
      });

      // 抓取未缓存的
      // 注入 slugMap 给 source 用作 fast path（绕开 fuzzy 搜索）
      const slugMap = getSlugMap(meta.doubanId);
      meta.cachedUrls = (slugMap && slugMap.channelUrls) || {};

      source.fetch(meta, deps).then(function (results) {
        // results: { [channelKey]: ChannelResult }
        channelKeys.forEach(function (key) {
          if (cached[key]) return; // 已从缓存渲染，跳过
          const result = (results && results[key]) || { status: 'error' };
          // 命中后把详情页 URL + matchedBy + 置信度钉进 slugMap（长 TTL 90 天）
          // 下次访问 channel cache 过期时可走 fast path 跳过搜索
          if (result.status === 'success' && result.url) {
            addChannelUrlToSlugMap(meta.doubanId, key, result);
          }
          setCache(meta.doubanId, key, source.version || '1', result);
          if (result.status === 'rate_limited') setCooldown(source.key);
          onChannelReady(key, result);
        });
      }).catch(function (err) {
        deps.log('fetchAll error for source', source.key, ':', err);
        channelKeys.forEach(function (key) {
          if (cached[key]) return;
          const errResult = { status: 'error' };
          // 负缓存 error 状态：避免 fetch 抛异常时每次刷新都重试
          setCache(meta.doubanId, key, source.version || '1', errResult);
          onChannelReady(key, errResult);
        });
      });
    });
  }

  // ============================================================
  // RankingData — 榜单数据获取与缓存（v1.1.0 新增）
  // ============================================================

  const RankingData = {
    _BASE: 'https://rank.douban.zhili.dev',
    _CACHE_KEY_PREFIX: 'rating_hub_rankings_cache_v1:',
    _MANIFEST_CACHE_KEY: 'rating_hub_rankings_manifest_v1',
    _TTL_MS: 24 * 60 * 60 * 1000,     // 24 小时
    _inflight: {},                     // 按 category 缓存 Promise（dedup）

    /**
     * @param {string} category 'movie' | 'book' | ...
     * @returns {Promise<object|null>} 完整 JSON 或 null（静默降级）
     */
    async getForCategory(category) {
      if (!category) return null;
      if (this._inflight[category]) return this._inflight[category];

      const promise = this._loadAndCache(category);
      this._inflight[category] = promise;
      try {
        return await promise;
      } finally {
        delete this._inflight[category];
      }
    },

    forceRefresh() {
      const keys = deps.storage.listKeys();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.indexOf(this._CACHE_KEY_PREFIX) === 0 || k === this._MANIFEST_CACHE_KEY) {
          deps.storage.remove(k);
        }
      }
    },

    async _loadAndCache(category) {
      try {
        // 1. 读 category 数据 cache
        const cacheKey = this._CACHE_KEY_PREFIX + category;
        const cached = deps.storage.get(cacheKey);
        if (cached && cached.ts && (Date.now() - cached.ts) < this._TTL_MS && cached.data) {
          return cached.data;
        }

        // 2. 读 manifest
        const manifest = await this._fetchJson(this._BASE + '/manifest.json');
        if (!manifest || manifest.schemaVersion !== 1) {
          deps.log('RankingData: manifest schemaVersion mismatch or missing');
          return null;
        }
        if (!Array.isArray(manifest.categories) || manifest.categories.indexOf(category) === -1) {
          deps.log('RankingData: category not supported by upstream —', category);
          return null;
        }

        // 3. 读 category JSON
        const url = (manifest.urls && manifest.urls[category]) || (this._BASE + '/' + category + '.json');
        const data = await this._fetchJson(url);
        if (!data || data.schemaVersion !== 1) {
          deps.log('RankingData: data schemaVersion mismatch —', category);
          return null;
        }

        // 4. 写 cache
        deps.storage.set(cacheKey, { ts: Date.now(), data });
        return data;
      } catch (e) {
        deps.log('RankingData error for category', category, e);
        return null;
      }
    },

    _fetchJson(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 15000,
          anonymous: true,                      // 榜单数据是公开静态 JSON，不需要也不应该带 cookie
          onload(resp) {
            if (resp.status < 200 || resp.status >= 300) {
              reject(new Error('HTTP ' + resp.status + ' for ' + url));
              return;
            }
            try {
              resolve(JSON.parse(resp.responseText));
            } catch (e) {
              reject(new Error('Invalid JSON from ' + url));
            }
          },
          onerror() { reject(new Error('Network error for ' + url)); },
          ontimeout() { reject(new Error('Timeout for ' + url)); },
        });
      });
    },
  };

  /**
   * 从 category data 里解析当前 subject 应展示的榜单条目列表。
   * @param {object} data
   * @param {string} category
   * @param {string} subjectId
   * @param {object} prefs
   * @returns {Array}
   */
  function resolveMarksForSubject(data, category, subjectId, prefs) {
    if (!data || !data.categories) return [];
    const categoryData = data.categories[category];
    if (!categoryData) return [];
    const records = (categoryData.items && categoryData.items[subjectId]) || [];
    const result = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || !r.source) continue;
      if (prefs.enabledSources[r.source] === false) continue;   // 未列出 = 默认启用
      const sourceMeta = categoryData.sources && categoryData.sources[r.source];
      if (!sourceMeta) continue;
      result.push({
        sourceId: r.source,
        title: sourceMeta.titleZh || sourceMeta.title,
        url: sourceMeta.url,
        rank: r.rank == null ? null : r.rank,
        spineNumber: r.spineNumber || null,
        externalId: r.externalId || null,            // 过渡期 fallback：CC 条目可能只有 externalId
        priority: typeof sourceMeta.priority === 'number' ? sourceMeta.priority : 99,
      });
    }
    result.sort((a, b) => a.priority - b.priority);
    return result;
  }

  // ============================================================
  // RankingRenderer — 把榜单数据渲染为 title 上方的胶囊（v1.1.0 新增）
  // ============================================================

  const RankingRenderer = {
    mount(marks) {
      this._removeExisting();
      if (!marks || marks.length === 0) return;
      const anchor = this._findAnchor();
      if (!anchor) return;
      const container = this._buildContainer(marks);
      anchor.el.insertAdjacentElement(anchor.placement, container);
    },

    _findAnchor() {
      const native = document.querySelector('.top250, .rank-label.rank-label-other');
      if (native) return { el: native, placement: 'afterend' };
      // fallback：豆瓣各品类 h1 结构不一致（电影 #content > h1；
      // music 页 h1 可能深嵌），放宽 selector
      const h1 = document.querySelector('#content > h1')
              || document.querySelector('#content h1')
              || document.querySelector('h1');
      if (h1) return { el: h1, placement: 'beforebegin' };
      return null;
    },

    _buildContainer(marks) {
      const wrapper = document.createElement('div');
      wrapper.className = 'rating-hub-rank-marks';
      wrapper.setAttribute('data-rating-hub-ranks', '1');
      for (let i = 0; i < marks.length; i++) {
        wrapper.appendChild(this._buildMark(marks[i]));
      }
      return wrapper;
    },

    _buildMark(mark) {
      const el = document.createElement('div');
      // 复用豆瓣原生类名让豆瓣 CSS（或我们内联的同名 CSS）自动作用于此元素
      el.className = 'rank-label rank-label-other rating-hub-mark';
      el.setAttribute('data-source', mark.sourceId);
      el.innerHTML = ''
        + '<span class="rank-label-no"><span>' + escapeHtml(this._formatRank(mark)) + '</span></span>'
        + '<span class="rank-label-link">'
        +   '<a href="' + escapeHtml(safeLinkUrl(mark.url)) + '" target="_blank" rel="noopener">' + escapeHtml(mark.title) + '</a>'
        + '</span>';
      return el;
    },

    _formatRank(mark) {
      if (mark.rank != null) return 'No.' + mark.rank;
      if (mark.spineNumber) return '#' + mark.spineNumber;
      // Fallback：过渡期 scraper 尚未加 spineNumber 字段时，
      // Criterion 源的 externalId 就是 spine 号，可以直接用。
      if (mark.sourceId === 'criterion' && mark.externalId) return '#' + mark.externalId;
      // Grammy 年度专辑：externalId 形如 'grammy-aoty-2024'，左槽显示年份更直观
      if (mark.sourceId && String(mark.sourceId).startsWith('grammy') && mark.externalId) {
        const m = String(mark.externalId).match(/(\d{4})/);
        if (m) return m[1];
      }
      return '—';
    },

    _removeExisting() {
      const existing = document.querySelectorAll('[data-rating-hub-ranks="1"]');
      for (let i = 0; i < existing.length; i++) {
        existing[i].parentNode.removeChild(existing[i]);
      }
    },
  };

  /**
   * 榜单胶囊入口 — 读配置、拉数据、匹配当前 subject、渲染。
   * 独立于现有评分流程，失败不影响其他功能。
   */
  async function rankingMarksMain(meta) {
    try {
      if (!meta || !meta.doubanId) return;
      if (!meta.type || meta.type === 'unknown') return;

      const prefs = normalizeRankingPrefs(deps.storage.get('rating_hub_ranking_prefs_v1'));
      if (!prefs.showRankingMarks) return;

      // 哪些 category 有数据由 upstream manifest.categories 决定，
      // 不在 userscript 侧硬编码（upstream 加新 category 时 consumer 零改动）。
      // RankingData.getForCategory 在 upstream 不支持此 category 时返回 null，静默降级。
      const data = await RankingData.getForCategory(meta.type);
      if (!data) return;

      const marks = resolveMarksForSubject(data, meta.type, meta.doubanId, prefs);
      if (marks.length === 0) return;

      RankingRenderer.mount(marks);
    } catch (e) {
      deps.log('rankingMarksMain error:', e);
    }
  }

  // ============================================================
  // init — 主入口
  // ============================================================

  function init() {
    // 防止重复初始化
    if (document.querySelector('[data-rating-hub]')) return;

    const meta = extractMeta();
    if (meta.type === 'unknown' || !meta.doubanId) return;

    // 排除非条目主页路径
    const excludedPaths = ['/doulists', '/photos', '/discussion', '/reviews', '/comments', '/collections'];
    const path = location.pathname;
    for (let i = 0; i < excludedPaths.length; i++) {
      if (path.indexOf(excludedPaths[i]) !== -1) return;
    }

    const config = readConfig();
    const applicable = getApplicableSources(meta.type, config, meta);
    if (applicable.length === 0) return;

    registerMenu(sources);

    const allChannels = [];
    applicable.forEach(function (s) {
      s.channels.forEach(function (ch) { allChannels.push(ch); });
    });

    ensureStyles();
    evictStale();
    createSlots(allChannels, meta);
    fetchAll(applicable, meta, config, function (channelKey, result) {
      fillSlot(channelKey, result);
    });

    // 将豆瓣页面上的 IMDb ID 纯文本变成可点击的链接
    if (meta.imdbId) {
      const infoEl = document.querySelector('#info');
      if (infoEl) {
        const walker = document.createTreeWalker(infoEl, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.includes(meta.imdbId)) {
            const span = document.createElement('span');
            span.innerHTML = node.textContent.replace(
              meta.imdbId,
              '<a href="https://www.imdb.com/title/' + meta.imdbId + '/" target="_blank" rel="noopener" style="color:#37a;">' + meta.imdbId + '</a>'
            );
            node.parentNode.replaceChild(span, node);
            break;
          }
        }
      }
    }

    deps.log('Initialized for', meta.type, ':', meta.title, '| EN:', meta.originalTitle || '(none)', '| IMDB:', meta.imdbId || '(none)');

    // v1.1.0: 榜单胶囊（独立于评分流程，异步并行）
    rankingMarksMain(meta);
  }

  // DOM 就绪后执行（Node 测试环境下无 document，跳过浏览器初始化）
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      setTimeout(init, 300);
    }
  }

  // Node 测试钩子：仅导出纯决策函数供单测，绝不触发任何浏览器初始化
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeTitle, yearWithinOne, pickByYearThenTitle, extractRtDetailYear, extractRtScores, computeRtCandidateYear, earliestReleaseYear, fetchSearchDetail, absolutizeUrl };
  }
})();
