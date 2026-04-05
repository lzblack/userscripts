// ==UserScript==
// @name         豆瓣评分汇 | Douban Rating Hub
// @namespace    https://github.com/lzblack
// @version      0.1.0
// @description  在豆瓣条目页聚合显示 IMDB、烂番茄、Metacritic、Letterboxd、Goodreads、Amazon、微信读书、NeoDB 等多平台评分
// @match        https://book.douban.com/subject/*
// @match        https://movie.douban.com/subject/*
// @match        https://music.douban.com/subject/*
// @match        https://www.douban.com/game/*
// @match        https://game.douban.com/subject/*
// @connect      imdb.com
// @connect      rottentomatoes.com
// @connect      backend.metacritic.com
// @connect      letterboxd.com
// @connect      api.themoviedb.org
// @connect      neodb.social
// @connect      goodreads.com
// @connect      amazon.com
// @connect      weread.qq.com
// @connect      anydb.depar.cc
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @icon         https://img3.doubanio.com/favicon.ico
// @license      MIT
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
    const doubanId = subjectMatch ? subjectMatch[1] : (gameMatch ? gameMatch[1] : null);

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

    // 原作名；若没有原作名则尝试从「又名」中提取英文名
    let originalTitle = null;
    const originalTitleMatch = infoText.match(/原作名:\s*(.+)/);
    if (originalTitleMatch) {
      originalTitle = originalTitleMatch[1].trim();
    } else {
      // 「又名」中的第一个斜杠分隔项里，找第一个 ASCII 为主的名字
      const alsoKnownMatch = infoText.match(/又名:\s*(.+)/);
      if (alsoKnownMatch) {
        const candidates = alsoKnownMatch[1].split(/\s*\/\s*/);
        const englishName = candidates.find((c) => /^[\x20-\x7E]+$/.test(c.trim()));
        if (englishName) originalTitle = englishName.trim();
      }
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

    // IMDb ID（电影/剧集条目中通常有「IMDb:」标签）
    let imdbId = null;
    if (infoEl) {
      const labels = Array.from(infoEl.querySelectorAll('span.pl'));
      const imdbSpan = labels.find((span) => span.textContent.includes('IMDb'));
      if (imdbSpan) {
        // IMDb ID 在紧随其后的文本节点中
        const sibling = imdbSpan.nextSibling;
        if (sibling) {
          const raw = sibling.textContent.trim();
          const idMatch = raw.match(/tt\d+/);
          if (idMatch) imdbId = idMatch[0];
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

  var CACHE_TTL_SUCCESS = 7 * 24 * 60 * 60 * 1000;    // 7 天
  var CACHE_TTL_NEGATIVE = 24 * 60 * 60 * 1000;        // 1 天
  var CACHE_TTL_RATE_LIMITED = 5 * 60 * 1000;           // 5 分钟

  function cacheKey(doubanId, channelKey, sourceVersion) {
    return 'rh:' + doubanId + ':' + channelKey + ':' + sourceVersion;
  }

  function getCache(doubanId, channelKey, sourceVersion) {
    var key = cacheKey(doubanId, channelKey, sourceVersion);
    var entry = deps.storage.get(key);
    if (!entry) return null;

    var ttl = entry.ttl || 0;
    if (Date.now() > entry.fetchedAt + ttl) {
      deps.storage.remove(key);
      return null;
    }
    return entry.result;
  }

  function setCache(doubanId, channelKey, sourceVersion, channelResult) {
    var status = channelResult && channelResult.status;
    // エラー系・スキップ系はキャッシュしない
    if (!status || status === 'error' || status === 'disabled' || status === 'coexist_skip') return;

    var ttl;
    if (status === 'rate_limited') {
      ttl = CACHE_TTL_RATE_LIMITED;
    } else if (status === 'no_match' || status === 'no_rating') {
      ttl = CACHE_TTL_NEGATIVE;
    } else {
      // success
      ttl = CACHE_TTL_SUCCESS;
    }

    var key = cacheKey(doubanId, channelKey, sourceVersion);
    deps.storage.set(key, { fetchedAt: Date.now(), ttl: ttl, result: channelResult });
  }

  function evictStale() {
    var keys = deps.storage.listKeys();
    var removed = 0;
    var now = Date.now();
    keys.forEach(function (key) {
      if (!key.startsWith('rh:')) return;
      // 設定キーとクールダウンキーはスキップ
      if (key === 'rh:config' || key.startsWith('rh:cooldown:')) return;

      var entry = deps.storage.get(key);
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

  var DEFAULT_CONFIG = {
    tmdbApiKey: '',
    enabledSources: {},
  };

  function readConfig() {
    var stored = deps.storage.get('rh:config', {});
    return Object.assign({}, DEFAULT_CONFIG, stored, {
      enabledSources: Object.assign({}, DEFAULT_CONFIG.enabledSources, stored.enabledSources || {}),
    });
  }

  function saveConfig(config) {
    deps.storage.set('rh:config', config);
  }

  function openConfigPanel(sources) {
    // 面板已存在则关闭（Toggle 行为）
    var existing = document.getElementById('rh-config-overlay');
    if (existing) {
      existing.remove();
      return;
    }

    var config = readConfig();

    // 遮罩层
    var overlay = document.createElement('div');
    overlay.id = 'rh-config-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.45)',
      'z-index:999999', 'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    // 面板
    var panel = document.createElement('div');
    panel.style.cssText = [
      'background:#fff', 'border-radius:8px', 'padding:24px 28px',
      'min-width:320px', 'max-width:460px', 'width:90vw',
      'font-family:sans-serif', 'font-size:14px', 'line-height:1.6',
      'box-shadow:0 8px 32px rgba(0,0,0,.2)',
    ].join(';');

    // 标题
    var heading = document.createElement('h3');
    heading.textContent = '评分汇 设置';
    heading.style.cssText = 'margin:0 0 16px;font-size:16px;font-weight:600;';
    panel.appendChild(heading);

    // TMDB API Key 输入框
    var tmdbLabel = document.createElement('label');
    tmdbLabel.style.cssText = 'display:block;margin-bottom:4px;font-weight:500;';
    tmdbLabel.textContent = 'TMDB API Key';
    var tmdbInput = document.createElement('input');
    tmdbInput.type = 'text';
    tmdbInput.value = config.tmdbApiKey || '';
    tmdbInput.placeholder = '留空则跳过 TMDB 来源';
    tmdbInput.style.cssText = [
      'display:block', 'width:100%', 'box-sizing:border-box',
      'padding:6px 10px', 'border:1px solid #ccc', 'border-radius:4px',
      'margin-bottom:16px', 'font-size:13px',
    ].join(';');
    panel.appendChild(tmdbLabel);
    panel.appendChild(tmdbInput);

    // 数据来源启用/禁用
    if (sources && sources.length > 0) {
      var sourcesLabel = document.createElement('p');
      sourcesLabel.style.cssText = 'margin:0 0 8px;font-weight:500;';
      sourcesLabel.textContent = '启用的评分来源';
      panel.appendChild(sourcesLabel);

      var checkboxes = {};
      sources.forEach(function (src) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;';

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        // 默认启用（enabledSources 中未设置 false 时视为已启用）
        cb.checked = config.enabledSources[src.key] !== false;
        checkboxes[src.key] = cb;

        var cbLabel = document.createElement('span');
        cbLabel.textContent = src.label || src.key;

        row.appendChild(cb);
        row.appendChild(cbLabel);
        panel.appendChild(row);
      });

      // 保存按钮回调需要能读到 checkboxes
      panel._checkboxes = checkboxes;
    }

    // 按钮行
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:20px;';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:6px 18px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5;';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });

    var saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = [
      'padding:6px 18px', 'border:none', 'border-radius:4px',
      'cursor:pointer', 'background:#e9722e', 'color:#fff', 'font-weight:600',
    ].join(';');
    saveBtn.addEventListener('click', function () {
      var newConfig = readConfig();
      newConfig.tmdbApiKey = tmdbInput.value.trim();
      if (panel._checkboxes) {
        Object.keys(panel._checkboxes).forEach(function (k) {
          newConfig.enabledSources[k] = panel._checkboxes[k].checked;
        });
      }
      saveConfig(newConfig);
      overlay.remove();
      location.reload();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    panel.appendChild(btnRow);

    // 点击遮罩背景关闭
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  function registerMenu(sources) {
    GM_registerMenuCommand('⚙ 评分汇设置', function () { openConfigPanel(sources); });
  }

  // ============================================================
  // 占位初始化 — 后续任务中将替换为完整流程
  // ============================================================

  var meta = extractMeta();
  deps.log('Page type:', meta.type, '| Meta:', meta);
})();
