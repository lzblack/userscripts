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
  // Renderer — 确定性插槽式 UI 渲染
  // ============================================================

  function ensureStyles() {
    if (document.getElementById('rating-hub-style')) return;
    var style = document.createElement('style');
    style.id = 'rating-hub-style';
    style.textContent = [
      '.rating-hub-container { margin-top: 8px; font-size: 12px; }',
      '.rating-hub-row { display: flex; align-items: center; gap: 8px; line-height: 2; }',
      '.rating-hub-label { color: #37a; text-decoration: none; min-width: 90px; border-radius: 3px; padding: 0 3px; transition: color 0.2s, background-color 0.2s; }',
      '.rating-hub-label:hover { color: #fff; background-color: #37a; }',
      '.rating-hub-label.no-link { cursor: default; }',
      '.rating-hub-label.no-link:hover { color: #37a; background-color: transparent; }',
      '.rating-hub-score { font-weight: bold; color: #333; }',
      '.rating-hub-count { color: #999; }',
      '.rating-hub-status { color: #999; }',
      '.rating-hub-status a { color: #37a; text-decoration: none; }',
      '.rating-hub-status a:hover { text-decoration: underline; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function createSlots(channels) {
    var anchor = document.querySelector('#interest_sectl') || document.querySelector('#wrapper');
    if (!anchor) return null;

    var container = document.createElement('div');
    container.className = 'rating-hub-container';
    container.setAttribute('data-rating-hub', '1');

    channels.forEach(function (ch) {
      var row = document.createElement('div');
      row.className = 'rating-hub-row';
      row.setAttribute('data-channel', ch.channelKey);

      var label = document.createElement('span');
      label.className = 'rating-hub-label no-link';
      label.textContent = ch.label;

      var status = document.createElement('span');
      status.className = 'rating-hub-status';
      status.textContent = '加载中...';

      row.appendChild(label);
      row.appendChild(status);
      container.appendChild(row);
    });

    anchor.appendChild(container);
    return container;
  }

  function fillSlot(channelKey, result) {
    var row = document.querySelector('.rating-hub-row[data-channel="' + channelKey + '"]');
    if (!row) return;

    // 重建行内容：label + 状态区
    var label = row.querySelector('.rating-hub-label');

    // 先清空旧状态区（label 保留）
    while (row.lastChild !== label) {
      row.removeChild(row.lastChild);
    }

    var status = result.status;

    if (status === 'success') {
      // Label → 可点击链接
      var a = document.createElement('a');
      a.className = 'rating-hub-label';
      a.href = result.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label.textContent;
      row.replaceChild(a, label);

      var scoreEl = document.createElement('span');
      scoreEl.className = 'rating-hub-score';
      scoreEl.textContent = result.score;
      row.appendChild(scoreEl);

      if (result.count) {
        var countEl = document.createElement('span');
        countEl.className = 'rating-hub-count';
        countEl.textContent = '(' + result.count + ')';
        row.appendChild(countEl);
      }

    } else if (status === 'no_match' || status === 'no_rating') {
      var a = document.createElement('a');
      a.className = 'rating-hub-label';
      a.href = result.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label.textContent;
      row.replaceChild(a, label);

      var statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = status === 'no_match' ? '未收录' : '暂无评分';
      row.appendChild(statusEl);

    } else if (status === 'rate_limited') {
      var statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = '请求频繁，稍后重试';
      row.appendChild(statusEl);

    } else if (status === 'disabled') {
      var statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      var configLink = document.createElement('a');
      configLink.href = '#';
      configLink.textContent = '未配置 API Key';
      configLink.addEventListener('click', function (e) {
        e.preventDefault();
        openConfigPanel(sources);
      });
      statusEl.appendChild(configLink);
      row.appendChild(statusEl);

    } else if (status === 'coexist_skip') {
      var statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = '已由其他脚本提供';
      row.appendChild(statusEl);

    } else {
      // error (and any unknown status)
      var statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = '加载失败';
      row.appendChild(statusEl);
    }
  }

  // ============================================================
  // Registry — 评分来源注册表
  // ============================================================

  var sources = [];

  function getApplicableSources(type, config, meta) {
    return sources.filter(function (source) {
      // 必须支持当前条目类型
      if (!source.types || source.types.indexOf(type) === -1) return false;
      // 用户已禁用
      if (config.enabledSources[source.key] === false) return false;
      // anydb 仅在动画类型时启用
      if (source.key === 'anydb' && meta.genres.indexOf('动画') === -1) return false;
      return true;
    });
  }

  // ============================================================
  // Sources — 各平台评分获取定义
  // ============================================================

  // --- NeoDB ---
  sources.push({
    key: 'neodb',
    label: 'NeoDB',
    version: 1,
    types: ['book', 'movie', 'music', 'game'],
    requiredConfig: null,
    channels: [{ channelKey: 'neodb', label: 'NeoDB' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        // 分类映射：music → album
        var categoryMap = { book: 'book', movie: 'movie', music: 'album', game: 'game' };
        var category = categoryMap[meta.type] || 'all';

        // 搜索查询瀑布：豆瓣页面 URL → originalTitle → title
        var doubanUrl = location.href.split('?')[0].split('#')[0];
        var queries = [doubanUrl];
        if (meta.originalTitle && meta.originalTitle !== meta.title) {
          queries.push(meta.originalTitle);
        }
        if (meta.title) {
          queries.push(meta.title);
        }

        // 匹配 NeoDB 条目详情页路径
        var detailPathRe = /neodb\.social\/(book|movie|album|music|game|tv\/season|tv|podcast|performance)\//;

        function parseDetail(doc, url) {
          // 优先用 JSON-LD aggregateRating
          var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (var i = 0; i < scripts.length; i++) {
            try {
              var data = JSON.parse(scripts[i].textContent);
              var ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                var score = parseFloat(ar.ratingValue);
                var count = parseInt(ar.ratingCount, 10) || 0;
                if (isNaN(score)) continue;
                return { found: true, hasRating: count > 0, score: score, count: count, url: url };
              }
            } catch (e) { /* skip */ }
          }
          // 回退：DOM 结构解析
          var displayBlock =
            doc.querySelector('#item-rating .display') ||
            doc.querySelector('.rating .display') ||
            doc.querySelector('.display');
          var undisplayEl = doc.querySelector('.undisplay');
          if (undisplayEl && !displayBlock) {
            return { found: true, hasRating: false, url: url };
          }
          // 尝试找评分数字
          var ratingEl =
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
          var ratingMatch = ratingEl.textContent.match(/[\d.]+/);
          if (!ratingMatch) return { found: true, hasRating: false, url: url };
          var score = parseFloat(ratingMatch[0]);
          // 评分人数
          var countEl =
            doc.querySelector('.rating-people') ||
            doc.querySelector('[itemprop="ratingCount"]');
          if (!countEl && displayBlock) {
            countEl = Array.from(displayBlock.querySelectorAll('p,span,small')).find(function (el) {
              return /\d+\s*(个评分|人评分|ratings?)/i.test(el.textContent);
            });
          }
          var count = 0;
          if (countEl) {
            var cm = countEl.textContent.replace(/,/g, '').match(/(\d+)/);
            if (cm) count = parseInt(cm[1], 10);
          }
          return { found: true, hasRating: count > 0, score: score, count: count, url: url };
        }

        function buildResult(parsed, matchedBy, confidence) {
          var searchUrl = 'https://neodb.social/search?q=' + encodeURIComponent(queries[0]) + '&category=' + category;
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
            var doc = deps.parseHTML(resp.responseText);
            var parsed = parseDetail(doc, resp.finalUrl || url);
            onSuccess(parsed, matchedBy, confidence);
          }).catch(onFail);
        }

        function tryQuery(queryIndex) {
          if (queryIndex >= queries.length) {
            var searchUrl = 'https://neodb.social/search?q=' + encodeURIComponent(queries[0]) + '&category=' + category;
            resolve({ neodb: { channelKey: 'neodb', status: 'no_match', url: searchUrl } });
            return;
          }
          var query = queries[queryIndex];
          var isUrlQuery = /^https?:\/\//.test(query);
          var matchedBy = isUrlQuery ? 'douban_url' : 'title';
          var confidence = isUrlQuery ? 'exact' : 'fuzzy';
          var searchUrl = 'https://neodb.social/search?' + new URLSearchParams({ q: query, category: category }).toString();

          deps.request(searchUrl).then(function (resp) {
            if (resp.status < 200 || resp.status >= 300) {
              tryQuery(queryIndex + 1);
              return;
            }
            var finalUrl = resp.finalUrl || searchUrl;
            // 情况一：搜索直接重定向到详情页
            if (detailPathRe.test(finalUrl)) {
              var doc = deps.parseHTML(resp.responseText);
              var parsed = parseDetail(doc, finalUrl);
              if (parsed && parsed.found) {
                resolve(buildResult(parsed, matchedBy, confidence));
              } else {
                tryQuery(queryIndex + 1);
              }
              return;
            }
            // 情况二：搜索列表页，找第一个结果卡片
            var doc = deps.parseHTML(resp.responseText);
            var card = doc.querySelector('.entity-card, .catalog-card, .subject-card');
            if (!card) { tryQuery(queryIndex + 1); return; }
            var linkEl = card.querySelector('.title a') || card.querySelector('a');
            if (!linkEl) { tryQuery(queryIndex + 1); return; }
            var href = linkEl.getAttribute('href') || '';
            var detailUrl = href.startsWith('http') ? href : 'https://neodb.social' + href;
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

  // --- IMDB ---
  sources.push({
    key: 'imdb', label: 'IMDB', version: 1,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'imdb', label: 'IMDB' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        var searchUrl = 'https://www.imdb.com/search/title/?title=' + encodeURIComponent(meta.title || '');
        if (!meta.imdbId) {
          resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: searchUrl } });
          return;
        }
        var itemUrl = 'https://www.imdb.com/title/' + meta.imdbId + '/';
        deps.request(itemUrl).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) {
            resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: itemUrl } });
            return;
          }
          var doc = deps.parseHTML(resp.responseText);
          // Parse LD+JSON for aggregateRating
          var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (var i = 0; i < scripts.length; i++) {
            try {
              var data = JSON.parse(scripts[i].textContent);
              var ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                var score = parseFloat(ar.ratingValue);
                var count = parseInt(ar.ratingCount, 10) || 0;
                if (isNaN(score)) continue;
                if (count === 0) {
                  resolve({ imdb: { channelKey: 'imdb', status: 'no_rating', url: itemUrl } });
                  return;
                }
                resolve({
                  imdb: {
                    channelKey: 'imdb',
                    status: 'success',
                    score: score,
                    scoreMax: 10,
                    displayValue: score.toFixed(1) + '/10',
                    count: count,
                    countText: count.toLocaleString(),
                    url: itemUrl,
                    matchedBy: 'imdb_id',
                    matchConfidence: 'exact',
                    externalId: meta.imdbId,
                  },
                });
                return;
              }
            } catch (e) { /* skip */ }
          }
          // No aggregateRating found
          resolve({ imdb: { channelKey: 'imdb', status: 'no_rating', url: itemUrl } });
        }).catch(function () {
          resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: itemUrl } });
        });
      });
    },
  });

  // --- Letterboxd ---
  sources.push({
    key: 'letterboxd', label: 'Letterboxd', version: 1,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'letterboxd', label: 'Letterboxd' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        var searchUrl = 'https://letterboxd.com/search/' + encodeURIComponent(meta.title || '') + '/';
        if (!meta.imdbId) {
          resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: searchUrl } });
          return;
        }

        var csiUrl = 'https://letterboxd.com/csi/film/imdb/' + meta.imdbId + '/ratings-summary/';
        var fallbackUrl = 'https://letterboxd.com/imdb/' + meta.imdbId + '/';

        function parseFromPage(html, pageUrl) {
          var doc = deps.parseHTML(html);
          // Try LD+JSON first
          var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (var i = 0; i < scripts.length; i++) {
            try {
              var data = JSON.parse(scripts[i].textContent);
              var ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                var score = parseFloat(ar.ratingValue);
                var count = parseInt(ar.ratingCount, 10) || 0;
                if (!isNaN(score)) {
                  return { score: score, count: count, url: pageUrl };
                }
              }
            } catch (e) { /* skip */ }
          }
          // Regex fallback
          var rvMatch = html.match(/"ratingValue"\s*:\s*([\d.]+)/);
          var rcMatch = html.match(/"ratingCount"\s*:\s*([\d]+)/);
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

        // PRIMARY: CSI ratings-summary endpoint
        deps.request(csiUrl).then(function (resp) {
          if (resp.status >= 200 && resp.status < 300) {
            var html = resp.responseText;
            // Extract weighted average and count
            var ratingMatch = html.match(/Weighted average of ([\d.]+) based on ([\d,]+)/);
            if (ratingMatch) {
              var score = parseFloat(ratingMatch[1]);
              var count = parseInt(ratingMatch[2].replace(/,/g, ''), 10);
              // Try to extract film URL from CSI response
              var filmUrlMatch = html.match(/href="(\/film\/[^"]+)"/);
              var filmUrl = filmUrlMatch
                ? 'https://letterboxd.com' + filmUrlMatch[1]
                : fallbackUrl;
              resolve(buildSuccess(score, count, filmUrl));
              return;
            }
          }
          // FALLBACK: full page fetch
          deps.request(fallbackUrl).then(function (pageResp) {
            var finalUrl = pageResp.finalUrl || fallbackUrl;
            var parsed = parseFromPage(pageResp.responseText, finalUrl);
            if (parsed && !isNaN(parsed.score)) {
              resolve(buildSuccess(parsed.score, parsed.count, parsed.url));
            } else {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_rating', url: finalUrl } });
            }
          }).catch(function () {
            resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: fallbackUrl } });
          });
        }).catch(function () {
          // CSI request failed entirely, try fallback
          deps.request(fallbackUrl).then(function (pageResp) {
            var finalUrl = pageResp.finalUrl || fallbackUrl;
            var parsed = parseFromPage(pageResp.responseText, finalUrl);
            if (parsed && !isNaN(parsed.score)) {
              resolve(buildSuccess(parsed.score, parsed.count, parsed.url));
            } else {
              resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_rating', url: finalUrl } });
            }
          }).catch(function () {
            resolve({ letterboxd: { channelKey: 'letterboxd', status: 'no_match', url: fallbackUrl } });
          });
        });
      });
    },
  });

  // --- Metacritic ---
  sources.push({
    key: 'metacritic', label: 'Metacritic', version: 1,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'metacritic', label: 'Metacritic' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        var titleForSlug = meta.originalTitle || meta.title || '';
        // Build slug: lowercase, remove non-alphanumeric except spaces, replace spaces with hyphens
        var slug = titleForSlug
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, '')
          .trim()
          .replace(/\s+/g, '-');

        var searchUrl = 'https://www.metacritic.com/search/' + encodeURIComponent(titleForSlug) + '/';
        var matchConfidence = meta.originalTitle ? 'high' : 'fuzzy';

        if (!slug) {
          resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
          return;
        }

        var apiUrl = 'https://backend.metacritic.com/movies/metacritic/' + slug + '/web';
        deps.request(apiUrl, { headers: { 'Accept': 'application/json' } }).then(function (resp) {
          if (resp.status === 404) {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
            return;
          }
          if (resp.status < 200 || resp.status >= 300) {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
            return;
          }
          try {
            var data = JSON.parse(resp.responseText);
            var score = data && data.criticScoreSummary && data.criticScoreSummary.score;
            if (score == null || isNaN(Number(score))) {
              resolve({ metacritic: { channelKey: 'metacritic', status: 'no_rating', url: 'https://www.metacritic.com/movie/' + slug + '/' } });
              return;
            }
            score = Number(score);
            resolve({
              metacritic: {
                channelKey: 'metacritic',
                status: 'success',
                score: score,
                scoreMax: 100,
                displayValue: score + '/100',
                count: null,
                countText: null,
                url: 'https://www.metacritic.com/movie/' + slug + '/',
                matchedBy: 'title_slug',
                matchConfidence: matchConfidence,
                externalId: slug,
              },
            });
          } catch (e) {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
          }
        }).catch(function () {
          resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
        });
      });
    },
  });

  // --- Rotten Tomatoes ---
  sources.push({
    key: 'rottentomatoes', label: 'Rotten Tomatoes', version: 1,
    types: ['movie'], requiredConfig: null,
    channels: [
      { channelKey: 'rt_critics', label: 'RT Critics' },
      { channelKey: 'rt_audience', label: 'RT Audience' },
    ],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        var titleForSearch = meta.originalTitle || meta.title || '';
        var searchUrl = 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(titleForSearch);
        var matchConfidence = meta.originalTitle ? 'high' : 'fuzzy';

        function noMatchBoth() {
          resolve({
            rt_critics: { channelKey: 'rt_critics', status: 'no_match', url: searchUrl },
            rt_audience: { channelKey: 'rt_audience', status: 'no_match', url: searchUrl },
          });
        }

        function buildResults(criticsScore, audienceScore, movieUrl) {
          var results = {};
          if (criticsScore != null && !isNaN(criticsScore)) {
            results.rt_critics = {
              channelKey: 'rt_critics',
              status: 'success',
              score: criticsScore,
              scoreMax: 100,
              displayValue: criticsScore + '%',
              count: null,
              countText: null,
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
              count: null,
              countText: null,
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

        // Step 1: Search RT to find movie path
        deps.request(searchUrl).then(function (searchResp) {
          if (searchResp.status < 200 || searchResp.status >= 300) {
            noMatchBoth();
            return;
          }
          var searchDoc = deps.parseHTML(searchResp.responseText);
          var linkEl = searchDoc.querySelector('search-page-media-row a[data-qa="info-name"]');
          if (!linkEl) {
            noMatchBoth();
            return;
          }
          var moviePath = linkEl.getAttribute('href') || '';
          if (!moviePath) {
            noMatchBoth();
            return;
          }
          var movieUrl = moviePath.startsWith('http') ? moviePath : 'https://www.rottentomatoes.com' + moviePath;

          // Step 2: Fetch movie detail page and extract scores
          deps.request(movieUrl).then(function (movieResp) {
            if (movieResp.status < 200 || movieResp.status >= 300) {
              noMatchBoth();
              return;
            }
            var html = movieResp.responseText;
            var criticsScore = null;
            var audienceScore = null;

            // Method A: JSON in <script type="application/json"> tags
            var criticsMatch = html.match(/"criticsScore"\s*:\s*(\d+)/);
            var audienceMatch = html.match(/"audienceScore"\s*:\s*(\d+)/);
            if (criticsMatch) criticsScore = parseInt(criticsMatch[1], 10);
            if (audienceMatch) audienceScore = parseInt(audienceMatch[1], 10);

            // Method B: DOM selectors fallback
            if (criticsScore == null || audienceScore == null) {
              var movieDoc = deps.parseHTML(html);
              if (criticsScore == null) {
                var csEl = movieDoc.querySelector('rt-text[slot="critics-score"]');
                if (csEl) {
                  var parsed = parseInt(csEl.textContent, 10);
                  if (!isNaN(parsed)) criticsScore = parsed;
                }
              }
              if (audienceScore == null) {
                var asEl = movieDoc.querySelector('rt-text[slot="audience-score"]');
                if (asEl) {
                  var parsedA = parseInt(asEl.textContent, 10);
                  if (!isNaN(parsedA)) audienceScore = parsedA;
                }
              }
            }

            resolve(buildResults(criticsScore, audienceScore, movieUrl));
          }).catch(function () {
            noMatchBoth();
          });
        }).catch(function () {
          noMatchBoth();
        });
      });
    },
  });

  // ============================================================
  // Scheduler — 并发抓取、缓存、限流、共存检测
  // ============================================================

  function checkCoexistence() {
    if (document.getElementById('douban-neodb-rating-style')) return true;
    var thirdParty = document.querySelector('.douban-thirdparty-rating');
    if (thirdParty && thirdParty.textContent.indexOf('NeoDB') !== -1) return true;
    return false;
  }

  function isCooldownActive(sourceKey) {
    var entry = deps.storage.get('rh:cooldown:' + sourceKey);
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
      var channelKeys = source.channels.map(function (ch) { return ch.channelKey; });

      function emitAll(result) {
        channelKeys.forEach(function (key) { onChannelReady(key, result); });
      }

      // Pre-flight: NeoDB 共存检测
      if (source.key === 'neodb' && checkCoexistence()) {
        emitAll({ status: 'coexist_skip' });
        return;
      }

      // Pre-flight: 必要配置缺失
      if (source.requiredConfig) {
        var missing = source.requiredConfig.some(function (cfgKey) {
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
      var cached = {};
      var allCached = true;
      channelKeys.forEach(function (key) {
        var hit = getCache(meta.doubanId, key, source.version || '1');
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
          var result = (results && results[key]) || { status: 'error' };
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
  // init — 主入口
  // ============================================================

  function init() {
    var meta = extractMeta();
    if (meta.type === 'unknown' || !meta.doubanId) return;

    // 排除非条目主页路径
    var excludedPaths = ['/doulists', '/photos', '/discussion', '/reviews', '/comments', '/collections'];
    var path = location.pathname;
    for (var i = 0; i < excludedPaths.length; i++) {
      if (path.indexOf(excludedPaths[i]) !== -1) return;
    }

    var config = readConfig();
    var applicable = getApplicableSources(meta.type, config, meta);
    if (applicable.length === 0) return;

    registerMenu(sources);

    var allChannels = [];
    applicable.forEach(function (s) {
      s.channels.forEach(function (ch) { allChannels.push(ch); });
    });

    ensureStyles();
    evictStale();
    createSlots(allChannels);
    fetchAll(applicable, meta, config, function (channelKey, result) {
      fillSlot(channelKey, result);
    });

    deps.log('Initialized for', meta.type, ':', meta.title);
  }

  // DOM 就绪后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }
})();
