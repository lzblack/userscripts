// ==UserScript==
// @name         豆瓣评分汇 | Douban Rating Hub
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.1.0
// @description  豆瓣全品类（电影、剧集、图书、音乐、游戏、播客）评分聚合 — IMDB、烂番茄、Letterboxd、Goodreads 等 16 个平台；在 title 上方显示外部权威榜单胶囊
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
          onload(resp) { resolve(resp); },
          onerror(err) { reject(new Error('Request failed: ' + url)); },
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
    // 3. h1 span[property="v:itemreviewed"] 去掉中文标题得到英文部分
    //    （参考：豆瓣资源下载大师的方法）
    if (!originalTitle) {
      const reviewedEl = document.querySelector('#content h1 span[property="v:itemreviewed"]');
      if (reviewedEl) {
        // 完整标题如 "路易不容易 第一季 Louie Season 1"，去掉中文部分
        const fullText = reviewedEl.textContent.trim();
        // 提取连续英文段（含数字、空格、常见标点）
        const engMatch = fullText.match(/([A-Za-z][A-Za-z0-9 :&'.,-]{2,})/);
        if (engMatch) originalTitle = engMatch[1].trim();
      }
    }
    // 4. 最终 fallback：直接从 title 变量提取英文段
    if (!originalTitle && title) {
      const engMatch = title.match(/([A-Za-z][A-Za-z0-9 :&'.,-]{2,})/);
      if (engMatch) originalTitle = engMatch[1].trim();
    }

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

    // 年份：电影用 [property="v:initialReleaseDate"]，书籍用「出版年:」
    let year = null;
    const releaseDateEl = document.querySelector('[property="v:initialReleaseDate"]');
    if (releaseDateEl) {
      const yearMatch = releaseDateEl.textContent.match(/(\d{4})/);
      if (yearMatch) year = yearMatch[1];
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

  const CACHE_PREFIX = 'rh2:';

  function cacheKey(doubanId, channelKey, sourceVersion) {
    return CACHE_PREFIX + doubanId + ':' + channelKey + ':' + sourceVersion;
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
    // error/disabled 状态不缓存
    if (!status || status === 'error' || status === 'disabled') return;

    let ttl;
    if (status === 'rate_limited') {
      ttl = CACHE_TTL_RATE_LIMITED;
    } else if (status === 'no_match' || status === 'no_rating') {
      ttl = CACHE_TTL_NEGATIVE;
    } else {
      // success
      ttl = CACHE_TTL_SUCCESS;
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

    // 读已识别的 source（只读 cache，不发起网络请求）
    const cacheKey = 'rating_hub_rankings_cache_v1:movie';
    const cached = deps.storage.get(cacheKey);
    const sources = (cached && cached.data && cached.data.categories
      && cached.data.categories.movie && cached.data.categories.movie.sources) || {};
    const sourceIds = Object.keys(sources);

    if (sourceIds.length === 0) {
      const hint = document.createElement('p');
      hint.style.cssText = 'color:#888;font-size:12px;margin:8px 0 0;';
      hint.textContent = '榜单数据尚未加载。访问一次豆瓣电影条目页后回来此处即可看到已识别的榜单。';
      section.appendChild(hint);
    } else {
      const listLabel = document.createElement('div');
      listLabel.style.cssText = 'color:#888;font-size:12px;margin:8px 0 4px;';
      listLabel.textContent = '启用的榜单（已识别）：';
      section.appendChild(listLabel);

      sourceIds.sort(function (a, b) {
        return (sources[a].priority || 99) - (sources[b].priority || 99);
      });

      sourceIds.forEach(function (sid) {
        const src = sources[sid];
        const enabled = prefs.enabledSources[sid] !== false;
        const label = document.createElement('label');
        label.className = 'rh-config-source';
        const kindText = src.kind === 'permanent' ? '永久' : (src.kind === 'yearly' ? '年度' : '时效');
        label.innerHTML = ''
          + '<input type="checkbox" class="rh-config-checkbox" ' + (enabled ? 'checked' : '') + '>'
          + '<span class="rh-config-source-text">'
          +   '<span class="rh-config-source-name">' + escapeHtml(src.titleZh || src.title || sid) + '</span>'
          +   '<span class="rh-config-source-meta">' + escapeHtml(kindText + ' · ' + (src.itemCount || '?')) + '</span>'
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
    if (!channels || channels.length <= 7) return [];
    if (meta.type !== 'movie' && meta.type !== 'drama') return [];

    const isAnime = meta.type === 'movie' && meta.genres && meta.genres.indexOf('动画') !== -1;
    const visibleKeys = isAnime
      ? ['imdb', 'rt_critics', 'rt_audience', 'bangumi', 'mal', 'neodb']
      : ['imdb', 'rt_critics', 'rt_audience', 'metacritic', 'letterboxd', 'neodb'];
    const visibleSet = new Set(visibleKeys);

    return channels
      .filter(function (ch) { return !visibleSet.has(ch.channelKey); })
      .map(function (ch) { return ch.channelKey; });
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

    if (status === 'success') {
      // Label → 可点击链接
      const a = document.createElement('a');
      a.className = 'rating-hub-label';
      a.href = result.url;
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
        a.href = result.url;
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
        a.href = result.url;
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
    key: 'rottentomatoes', label: '烂番茄', version: 2,
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
        const matchConfidence = meta.originalTitle ? 'high' : 'fuzzy';

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

        if (!titleForSearch) {
          noMatchBoth();
          return;
        }

        // Step 1: Search RT to find movie/tv path — validate title match
        deps.request(searchUrl).then(function (searchResp) {
          if (searchResp.status < 200 || searchResp.status >= 300) {
            noMatchBoth();
            return;
          }
          const searchDoc = deps.parseHTML(searchResp.responseText);
          const allResults = searchDoc.querySelectorAll('search-page-media-row');
          if (!allResults || allResults.length === 0) {
            noMatchBoth();
            return;
          }
          // 精确匹配 only — normalize 后完全相等才用
          const normalize = function (s) { return (s || '').replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, ''); };
          const queryNorm = normalize(titleForSearch);
          let bestLink = null;
          for (let i = 0; i < Math.min(allResults.length, 30); i++) {
            const nameEl = allResults[i].querySelector('a[data-qa="info-name"]');
            if (!nameEl) continue;
            if (normalize(nameEl.textContent) === queryNorm) { bestLink = nameEl; break; }
          }
          if (!bestLink) {
            // 没有匹配的结果
            noMatchBoth();
            return;
          }
          const moviePath = bestLink.getAttribute('href') || '';
          if (!moviePath) {
            noMatchBoth();
            return;
          }
          const movieUrl = moviePath.startsWith('http') ? moviePath : 'https://www.rottentomatoes.com' + moviePath;

          // Step 2: Fetch movie detail page and extract scores
          deps.request(movieUrl).then(function (movieResp) {
            if (movieResp.status < 200 || movieResp.status >= 300) {
              noMatchBoth();
              return;
            }
            const html = movieResp.responseText;
            let criticsScore = null;
            let audienceScore = null;
            let criticsCount = null;
            let audienceCount = null;

            // Method A: JSON in <script type="application/json"> tags
            const criticsMatch = html.match(/"criticsScore"\s*:\s*(\d+)/);
            const audienceMatch = html.match(/"audienceScore"\s*:\s*(\d+)/);
            if (criticsMatch) criticsScore = parseInt(criticsMatch[1], 10);
            if (audienceMatch) audienceScore = parseInt(audienceMatch[1], 10);
            // 评论数量：从 criticsScore/audienceScore JSON 对象中提取 reviewCount
            const criticsObj = html.match(/"criticsScore"\s*:\s*\{[^}]+\}/);
            const audienceObj = html.match(/"audienceScore"\s*:\s*\{[^}]+\}/);
            if (criticsObj) {
              const cm = criticsObj[0].match(/"reviewCount"\s*:\s*(\d+)/);
              if (cm) criticsCount = parseInt(cm[1], 10);
            }
            if (audienceObj) {
              const am = audienceObj[0].match(/"reviewCount"\s*:\s*(\d+)/);
              if (am) audienceCount = parseInt(am[1], 10);
            }

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

            resolve(buildResults(criticsScore, audienceScore, criticsCount, audienceCount, movieUrl));
          }).catch(function () {
            noMatchBoth();
          });
        }).catch(function () {
          noMatchBoth();
        });
      });
    },
  });

  // --- Metacritic ---
  sources.push({
    key: 'metacritic', label: 'Metacritic', version: 4,
    types: ['movie', 'game'], requiredConfig: null,
    channels: [{ channelKey: 'metacritic', label: 'Metacritic', icon: 'https://www.metacritic.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const titleRaw = meta.originalTitle || meta.title || '';
        const titleForSlug = stripSeason(titleRaw);
        const searchUrl = 'https://www.metacritic.com/search/' + encodeURIComponent(titleForSlug) + '/';
        const matchConfidence = meta.originalTitle ? 'high' : 'fuzzy';

        // If title contains no ASCII letters it's CJK-only — Metacritic has no match
        if (!titleForSlug || !/[a-zA-Z]/.test(titleForSlug)) {
          resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
          return;
        }

        // Build slug: & → and, lowercase, strip non-alphanumeric, collapse hyphens
        const slug = titleForSlug
          .replace(/&/g, 'and')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .replace(/-{2,}/g, '-')
          .replace(/^-+|-+$/g, '');

        if (!slug) {
          resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
          return;
        }

        // Finder 搜索兜底 — slug 匹配全部失败后用标题搜索
        function tryFinderSearch() {
          const normalize = function (s) { return (s || '').replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, ''); };
          const queryNorm = normalize(titleForSlug);
          // mcoTypeId: 2=movies, 1=TV shows, 13=games
          function tryFinderForType(typeId, onFail) {
            const finderUrl = 'https://backend.metacritic.com/finder/metacritic/web?query=' +
              encodeURIComponent(titleForSlug) + '&mcoTypeId=' + typeId + '&limit=20';
            deps.request(finderUrl, { headers: { 'Accept': 'application/json' } }).then(function (resp) {
              if (resp.status < 200 || resp.status >= 300) { onFail(); return; }
              try {
                const data = JSON.parse(resp.responseText);
                const items = data && data.data && data.data.items;
                if (!items || items.length === 0) { onFail(); return; }
                let matched = null;
                for (let i = 0; i < items.length; i++) {
                  if (normalize(items[i].title) === queryNorm) { matched = items[i]; break; }
                }
                if (!matched) { onFail(); return; }
                const score = matched.criticScoreSummary && matched.criticScoreSummary.score;
                const finderSlug = matched.slug || '';
                const mcUrlType = typeId === 1 ? 'tv' : (typeId === 13 ? 'game' : 'movie');
                if (score == null || isNaN(Number(score))) {
                  resolve({ metacritic: { channelKey: 'metacritic', status: 'no_rating', url: 'https://www.metacritic.com/' + mcUrlType + '/' + finderSlug + '/' } });
                  return;
                }
                const reviewCount = (matched.criticScoreSummary && matched.criticScoreSummary.reviewCount) || null;
                resolve({
                  metacritic: {
                    channelKey: 'metacritic', status: 'success',
                    score: Number(score), scoreMax: 100,
                    displayValue: Number(score) + '/100',
                    count: reviewCount, countText: reviewCount ? reviewCount.toLocaleString() : null,
                    url: 'https://www.metacritic.com/' + mcUrlType + '/' + finderSlug + '/',
                    matchedBy: 'finder_search', matchConfidence: 'high',
                    externalId: finderSlug,
                  },
                });
              } catch (e) { onFail(); }
            }).catch(function () { onFail(); });
          }
          function noMatchFinal() {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
          }
          if (meta.type === 'game') {
            tryFinderForType(13, noMatchFinal);
          } else {
            tryFinderForType(2, function () { tryFinderForType(1, noMatchFinal); });
          }
        }

        // 尝试 movies path，404 则尝试 shows path（TV/剧集），最后 finder 搜索兜底
        function tryMetacritic(paths) {
          if (paths.length === 0) {
            tryFinderSearch();
            return;
          }
          const pathType = paths[0];
          const apiUrl = 'https://backend.metacritic.com/' + pathType + '/metacritic/' + slug + '/web';
          deps.request(apiUrl, { headers: { 'Accept': 'application/json' } }).then(function (resp) {
            if (resp.status === 404) {
              tryMetacritic(paths.slice(1));
              return;
            }
            if (resp.status < 200 || resp.status >= 300) {
              tryMetacritic(paths.slice(1));
              return;
            }
            try {
              const data = JSON.parse(resp.responseText);
              const item = data && data.data && data.data.item;
              let score = item && item.criticScoreSummary && item.criticScoreSummary.score;
              if (score == null || isNaN(Number(score))) {
                const mcUrlNoRating = pathType === 'shows' ? 'tv' : (pathType === 'games' ? 'game' : 'movie');
                resolve({ metacritic: { channelKey: 'metacritic', status: 'no_rating', url: 'https://www.metacritic.com/' + mcUrlNoRating + '/' + slug + '/' } });
                return;
              }
              score = Number(score);
              const reviewCount = (item && item.criticScoreSummary && item.criticScoreSummary.reviewCount) || null;
              const mcUrlType = pathType === 'shows' ? 'tv' : (pathType === 'games' ? 'game' : 'movie');
              resolve({
                metacritic: {
                  channelKey: 'metacritic',
                  status: 'success',
                  score: score,
                  scoreMax: 100,
                  displayValue: score + '/100',
                  count: reviewCount,
                  countText: reviewCount ? reviewCount.toLocaleString() : null,
                  url: 'https://www.metacritic.com/' + mcUrlType + '/' + slug + '/',
                  matchedBy: 'title_slug',
                  matchConfidence: matchConfidence,
                  externalId: slug,
                },
              });
            } catch (e) {
              tryMetacritic(paths.slice(1));
            }
          }).catch(function () { tryMetacritic(paths.slice(1)); });
        }
        // 按条目类型决定尝试顺序
        const mcPaths = meta.type === 'game' ? ['games'] : ['movies', 'shows'];
        tryMetacritic(mcPaths);
      });
    },
  });

  // --- Letterboxd ---
  sources.push({
    key: 'letterboxd', label: 'Letterboxd', version: 1,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'letterboxd', label: 'Letterboxd', icon: 'https://letterboxd.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const searchUrl = 'https://letterboxd.com/search/' + encodeURIComponent(stripSeason(meta.originalTitle || meta.title || '')) + '/';
        if (!meta.imdbId) {
          resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
          return;
        }

        const csiUrl = 'https://letterboxd.com/csi/film/imdb/' + meta.imdbId + '/ratings-summary/';
        const fallbackUrl = 'https://letterboxd.com/imdb/' + meta.imdbId + '/';

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

        function buildSuccess(score, count, filmUrl) {
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
              matchedBy: 'imdb_id',
              matchConfidence: 'exact',
              externalId: filmUrl,
            },
          };
        }

        // THIRD FALLBACK: search by title
        function tryTitleSearch() {
          // Letterboxd 只有英文内容，用 originalTitle 去掉季数
          const searchTitle = stripSeason(meta.originalTitle || meta.title || '');
          if (!/[a-zA-Z]/.test(searchTitle)) {
            resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
            return;
          }
          const titleSearchUrl = 'https://letterboxd.com/search/films/' + encodeURIComponent(searchTitle) + '/';
          deps.request(titleSearchUrl).then(function (searchResp) {
            if (searchResp.status < 200 || searchResp.status >= 300) {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
              return;
            }
            const searchDoc = deps.parseHTML(searchResp.responseText);
            const filmLink = searchDoc.querySelector('.results .film-detail-content a')
              || searchDoc.querySelector('a[href*="/film/"]');
            if (!filmLink) {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
              return;
            }
            let filmUrl = filmLink.getAttribute('href');
            if (!filmUrl.startsWith('http')) filmUrl = 'https://letterboxd.com' + filmUrl;
            deps.request(filmUrl).then(function (filmResp) {
              const finalUrl = filmResp.finalUrl || filmUrl;
              const parsed = parseFromPage(filmResp.responseText, finalUrl);
              if (parsed && !isNaN(parsed.score)) {
                resolve(buildSuccess(parsed.score, parsed.count, parsed.url));
              } else {
                resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_rating', url: finalUrl } });
              }
            }).catch(function () {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
            });
          }).catch(function () {
            resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
          });
        }

        // SECOND FALLBACK: fetch /imdb/{id}/ page directly
        function tryImdbPage() {
          deps.request(fallbackUrl).then(function (pageResp) {
            if (pageResp.status === 403) {
              tryTitleSearch();
              return;
            }
            const finalUrl = pageResp.finalUrl || fallbackUrl;
            const parsed = parseFromPage(pageResp.responseText, finalUrl);
            if (parsed && !isNaN(parsed.score)) {
              resolve(buildSuccess(parsed.score, parsed.count, parsed.url));
            } else {
              tryTitleSearch();
            }
          }).catch(function () {
            tryTitleSearch();
          });
        }

        // PRIMARY: CSI ratings-summary endpoint
        deps.request(csiUrl).then(function (resp) {
          if (resp.status >= 200 && resp.status < 300) {
            const html = resp.responseText;
            // Extract weighted average and count
            const ratingMatch = html.match(/Weighted average of ([\d.]+) based on ([\d,]+)/);
            if (ratingMatch) {
              const score = parseFloat(ratingMatch[1]);
              const count = parseInt(ratingMatch[2].replace(/,/g, ''), 10);
              // Try to extract film URL from CSI response
              const filmUrlMatch = html.match(/href="(\/film\/[^"]+)"/);
              const filmUrl = filmUrlMatch
                ? 'https://letterboxd.com' + filmUrlMatch[1]
                : fallbackUrl;
              resolve(buildSuccess(score, count, filmUrl));
              return;
            }
          }
          // CSI returned non-success or no rating data — try IMDB page
          tryImdbPage();
        }).catch(function () {
          // CSI request failed entirely — try IMDB page
          tryImdbPage();
        });
      });
    },
  });

  // --- TMDB ---
  sources.push({
    key: 'tmdb', label: 'TMDB', version: 1,
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
            handleResp(resp, function (data) {
              return (data.movie_results && data.movie_results[0]) || (data.tv_results && data.tv_results[0]);
            }, 'imdb_id', 'exact');
          }).catch(function () { noMatch(); });
        } else {
          // Fallback to title search
          const year = meta.year ? '&year=' + encodeURIComponent(meta.year) : '';
          const queryUrl = 'https://api.themoviedb.org/3/search/movie?api_key=' +
            encodeURIComponent(apiKey) + '&query=' + encodeURIComponent(meta.title || '') + year;
          deps.request(queryUrl).then(function (resp) {
            handleResp(resp, function (data) {
              return data.results && data.results[0];
            }, 'title', 'fuzzy');
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
    key: 'goodreads', label: 'Goodreads', version: 1,
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
          const searchUrl = 'https://www.goodreads.com/search?q=' + encodeURIComponent(query);

          deps.request(searchUrl).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) { tryQuery(queryIndex + 1); return; }
            const finalUrl = resp.finalUrl || searchUrl;
            // If search redirected directly to a book detail page
            if (detailPathRe.test(finalUrl)) {
              const doc = deps.parseHTML(resp.responseText);
              const parsed = parseDetail(doc, finalUrl);
              if (parsed) { buildSuccess(parsed, matchedBy, confidence); }
              else { tryQuery(queryIndex + 1); }
              return;
            }
            // Search results page — find first bookTitle link
            const doc = deps.parseHTML(resp.responseText);
            const linkEl = doc.querySelector('a.bookTitle');
            if (!linkEl) { tryQuery(queryIndex + 1); return; }
            const href = linkEl.getAttribute('href') || '';
            const detailUrl = href.startsWith('http') ? href : 'https://www.goodreads.com' + href;
            deps.request(detailUrl).then(function (detailResp) {
              if (detailResp.status < 200 || detailResp.status >= 300) { tryQuery(queryIndex + 1); return; }
              const detailDoc = deps.parseHTML(detailResp.responseText);
              const parsed = parseDetail(detailDoc, detailResp.finalUrl || detailUrl);
              if (parsed) { buildSuccess(parsed, matchedBy, confidence); }
              else { tryQuery(queryIndex + 1); }
            }).catch(function () { tryQuery(queryIndex + 1); });
          }).catch(function () { tryQuery(queryIndex + 1); });
        }

        tryQuery(0);
      });
    },
  });

  // --- Amazon ---
  sources.push({
    key: 'amazon', label: 'Amazon', version: 1,
    types: ['book'], requiredConfig: null,
    channels: [{ channelKey: 'amazon', label: 'Amazon', icon: 'https://www.amazon.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // Query cascade: ISBN → originalTitle+creator → title+creator
        const creator = meta.creator || '';
        const queries = [];
        if (meta.isbn) queries.push(meta.isbn);
        if (meta.originalTitle && meta.originalTitle !== meta.title) {
          queries.push(creator ? meta.originalTitle + ' ' + creator : meta.originalTitle);
        }
        if (meta.title) {
          queries.push(creator ? meta.title + ' ' + creator : meta.title);
        }
        if (!queries.length) {
          resolve({ amazon: { channelKey: 'amazon', status: 'no_match', url: 'https://www.amazon.com/' } });
          return;
        }

        const dpPathRe = /amazon\.com(\/[^/]+)?\/dp\//;

        function noMatch() {
          const url = 'https://www.amazon.com/s?k=' + encodeURIComponent(queries[0]);
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
          const query = queries[queryIndex];
          const isIsbn = queryIndex === 0 && !!meta.isbn;
          const matchedBy = isIsbn ? 'isbn' : 'title';
          const confidence = isIsbn ? 'exact' : 'fuzzy';
          const searchUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(query);

          deps.request(searchUrl, { headers: { 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } })
            .then(function (resp) {
              if (resp.status < 200 || resp.status >= 300) { tryQuery(queryIndex + 1); return; }
              const finalUrl = resp.finalUrl || searchUrl;
              // If search landed directly on a product detail page
              if (dpPathRe.test(finalUrl)) {
                const doc = deps.parseHTML(resp.responseText);
                const parsed = parseDetail(doc, finalUrl);
                if (parsed) { buildSuccess(parsed, matchedBy, confidence); }
                else { tryQuery(queryIndex + 1); }
                return;
              }
              // Search results — find first result link
              const doc = deps.parseHTML(resp.responseText);
              const resultEl = doc.querySelector('[data-component-type="s-search-result"]');
              if (!resultEl) { tryQuery(queryIndex + 1); return; }
              const linkEl = resultEl.querySelector('h2 a') || resultEl.querySelector('a[href*="/dp/"]');
              if (!linkEl) { tryQuery(queryIndex + 1); return; }
              const href = linkEl.getAttribute('href') || '';
              const detailUrl = href.startsWith('http') ? href : 'https://www.amazon.com' + href;
              fetchDetail(detailUrl, matchedBy, confidence, function () { tryQuery(queryIndex + 1); });
            }).catch(function () { tryQuery(queryIndex + 1); });
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
    version: 1,
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
                matchConfidence: normalize(bestItem.name) === queryNorm ? 'high' : 'fuzzy',
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
      source.fetch(meta, deps).then(function (results) {
        // results: { [channelKey]: ChannelResult }
        channelKeys.forEach(function (key) {
          if (cached[key]) return; // 已从缓存渲染，跳过
          const result = (results && results[key]) || { status: 'error' };
          setCache(meta.doubanId, key, source.version || '1', result);
          if (result.status === 'rate_limited') setCooldown(source.key);
          onChannelReady(key, result);
        });
      }).catch(function (err) {
        deps.log('fetchAll error for source', source.key, ':', err);
        channelKeys.forEach(function (key) {
          if (!cached[key]) onChannelReady(key, { status: 'error' });
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
      const h1 = document.querySelector('#content > h1');
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
        +   '<a href="' + escapeHtml(mark.url || '#') + '" target="_blank" rel="noopener">' + escapeHtml(mark.title) + '</a>'
        + '</span>';
      return el;
    },

    _formatRank(mark) {
      if (mark.rank != null) return 'No.' + mark.rank;
      if (mark.spineNumber) return '#' + mark.spineNumber;
      // Fallback：过渡期 scraper 尚未加 spineNumber 字段时，
      // Criterion 源的 externalId 就是 spine 号，可以直接用。
      // 等 scraper 产出 spineNumber 后这段 fallback 自然不触发（可保留作防御）。
      if (mark.sourceId === 'criterion' && mark.externalId) return '#' + mark.externalId;
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

      // 仅 v1 支持的 category
      const supportedCategories = ['movie'];
      if (supportedCategories.indexOf(meta.type) === -1) return;

      const prefs = normalizeRankingPrefs(deps.storage.get('rating_hub_ranking_prefs_v1'));
      if (!prefs.showRankingMarks) return;

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

  // DOM 就绪后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }
})();
