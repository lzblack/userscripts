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
// @match        https://www.douban.com/location/drama/*
// @match        https://www.douban.com/podcast/*
// @connect      imdb.com
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
// @connect      itunes.apple.com
// @connect      podcasts.apple.com
// @connect      xyzrank.eddiehe.top
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
    // 1. #info 原作名
    const originalTitleMatch = infoText.match(/原作名:\s*(.+)/);
    if (originalTitleMatch) {
      originalTitle = originalTitleMatch[1].trim();
    }
    // 2. #info 又名（取第一个纯 ASCII 项）
    if (!originalTitle) {
      const alsoKnownMatch = infoText.match(/又名:\s*(.+)/);
      if (alsoKnownMatch) {
        const candidates = alsoKnownMatch[1].split(/\s*\/\s*/);
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

  function cacheKey(doubanId, channelKey, sourceVersion) {
    return 'rh:' + doubanId + ':' + channelKey + ':' + sourceVersion;
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
    // エラー系・スキップ系はキャッシュしない
    if (!status || status === 'error' || status === 'disabled' || status === 'coexist_skip') return;

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
      if (!key.startsWith('rh:')) return;
      // 設定キーとクールダウンキーはスキップ
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

  function openConfigPanel(sources) {
    // 面板已存在则关闭（Toggle 行为）
    const existing = document.getElementById('rh-config-overlay');
    if (existing) {
      existing.remove();
      return;
    }

    const config = readConfig();

    // 遮罩层
    const overlay = document.createElement('div');
    overlay.id = 'rh-config-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.45)',
      'z-index:999999', 'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    // 面板
    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#fff', 'border-radius:8px', 'padding:24px 28px',
      'min-width:320px', 'max-width:460px', 'width:90vw',
      'font-family:sans-serif', 'font-size:14px', 'line-height:1.6',
      'box-shadow:0 8px 32px rgba(0,0,0,.2)',
    ].join(';');

    // 标题
    const heading = document.createElement('h3');
    heading.textContent = '评分汇 设置';
    heading.style.cssText = 'margin:0 0 16px;font-size:16px;font-weight:600;';
    panel.appendChild(heading);

    // TMDB API Key 输入框
    const tmdbLabel = document.createElement('label');
    tmdbLabel.style.cssText = 'display:block;margin-bottom:4px;font-weight:500;';
    tmdbLabel.textContent = 'TMDB API Key';
    const tmdbInput = document.createElement('input');
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
      const sourcesLabel = document.createElement('p');
      sourcesLabel.style.cssText = 'margin:0 0 8px;font-weight:500;';
      sourcesLabel.textContent = '启用的评分来源';
      panel.appendChild(sourcesLabel);

      const checkboxes = {};
      sources.forEach(function (src) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        // 默认启用（enabledSources 中未设置 false 时视为已启用）
        cb.checked = config.enabledSources[src.key] !== false;
        checkboxes[src.key] = cb;

        const cbLabel = document.createElement('span');
        cbLabel.textContent = src.label || src.key;

        row.appendChild(cb);
        row.appendChild(cbLabel);
        panel.appendChild(row);
      });

      // 保存按钮回调需要能读到 checkboxes
      panel._checkboxes = checkboxes;
    }

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:20px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:6px 18px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f5f5f5;';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = [
      'padding:6px 18px', 'border:none', 'border-radius:4px',
      'cursor:pointer', 'background:#e9722e', 'color:#fff', 'font-weight:600',
    ].join(';');
    saveBtn.addEventListener('click', function () {
      const newConfig = readConfig();
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
    const style = document.createElement('style');
    style.id = 'rating-hub-style';
    style.textContent = [
      '.rating-hub-container { margin-top: 8px; font-size: 12px; }',
      '.rating-hub-row { display: flex; align-items: center; gap: 4px; line-height: 2; white-space: nowrap; }',
      '.rating-hub-label { color: #37a; text-decoration: none; width: 90px; flex-shrink: 0; border-radius: 3px; padding: 0 2px; transition: color 0.2s, background-color 0.2s; font-size: 12px; }',
      '.rating-hub-score { font-weight: bold; color: #333; }',
      '.rating-hub-label:hover { color: #fff; background-color: #37a; }',
      '.rating-hub-label.no-link { cursor: default; }',
      '.rating-hub-label.no-link:hover { color: #37a; background-color: transparent; }',
      '.rating-hub-count { color: #999; margin-left: -2px; }',
      '.rating-hub-status { color: #999; }',
      '.rating-hub-status a { color: #37a; text-decoration: none; }',
      '.rating-hub-status a:hover { text-decoration: underline; }',
      '.rating-hub-icon { width: 14px; height: 14px; vertical-align: middle; margin-right: 4px; border-radius: 2px; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  function createSlots(channels) {
    const anchor = document.querySelector('#interest_sectl')
      || document.querySelector('.drama-info .meta .rating')  // 话剧：评分区块后
      || document.querySelector('.drama-info .meta')           // 话剧：meta 容器
      || document.querySelector('#interest_sect_level')
      || document.querySelector('#wrapper');
    if (!anchor) return null;

    const container = document.createElement('div');
    container.className = 'rating-hub-container';
    container.setAttribute('data-rating-hub', '1');

    channels.forEach(function (ch) {
      const row = document.createElement('div');
      row.className = 'rating-hub-row';
      row.setAttribute('data-channel', ch.channelKey);

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
      scoreEl.textContent = result.displayValue || result.score;
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
      statusEl.textContent = '请求频繁，稍后重试';
      row.appendChild(statusEl);

    } else if (status === 'disabled') {
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      const configLink = document.createElement('a');
      configLink.href = '#';
      configLink.textContent = '未配置 API Key';
      configLink.addEventListener('click', function (e) {
        e.preventDefault();
        openConfigPanel(sources);
      });
      statusEl.appendChild(configLink);
      row.appendChild(statusEl);

    } else if (status === 'coexist_skip') {
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      statusEl.textContent = '已由其他脚本提供';
      row.appendChild(statusEl);

    } else {
      // error (and any unknown status)
      const statusEl = document.createElement('span');
      statusEl.className = 'rating-hub-status';
      if (result.url) {
        const errLink = document.createElement('a');
        errLink.href = result.url;
        errLink.target = '_blank';
        errLink.rel = 'noopener noreferrer';
        errLink.textContent = '查看 →';
        statusEl.appendChild(errLink);
      } else {
        statusEl.textContent = '加载失败';
      }
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

  // --- IMDB ---
  sources.push({
    key: 'imdb', label: 'IMDB', version: 3,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'imdb', label: 'IMDB', icon: 'https://www.imdb.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const searchUrl = 'https://www.imdb.com/search/title/?title=' + encodeURIComponent(meta.title || '');
        if (!meta.imdbId) {
          resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: searchUrl } });
          return;
        }
        const itemUrl = 'https://www.imdb.com/title/' + meta.imdbId + '/';
        deps.request(itemUrl).then(function (resp) {
          if (resp.status < 200 || resp.status >= 300) {
            resolve({ imdb: { channelKey: 'imdb', status: 'no_match', url: itemUrl } });
            return;
          }
          const doc = deps.parseHTML(resp.responseText);
          // Parse LD+JSON for aggregateRating
          const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
          for (let i = 0; i < scripts.length; i++) {
            try {
              const data = JSON.parse(scripts[i].textContent);
              const ar = data.aggregateRating;
              if (ar && ar.ratingValue != null) {
                const score = parseFloat(ar.ratingValue);
                const count = parseInt(ar.ratingCount || ar.reviewCount, 10) || 0;
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
        const titleForSearch = meta.originalTitle || meta.title || '';
        const searchUrl = 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(titleForSearch);
        const matchConfidence = meta.originalTitle ? 'high' : 'fuzzy';

        function noMatchBoth() {
          resolve({
            rt_critics: { channelKey: 'rt_critics', status: 'no_match', url: searchUrl },
            rt_audience: { channelKey: 'rt_audience', status: 'no_match', url: searchUrl },
          });
        }

        function buildResults(criticsScore, audienceScore, movieUrl) {
          const results = {};
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

            // Method A: JSON in <script type="application/json"> tags
            const criticsMatch = html.match(/"criticsScore"\s*:\s*(\d+)/);
            const audienceMatch = html.match(/"audienceScore"\s*:\s*(\d+)/);
            if (criticsMatch) criticsScore = parseInt(criticsMatch[1], 10);
            if (audienceMatch) audienceScore = parseInt(audienceMatch[1], 10);

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

  // --- Metacritic ---
  sources.push({
    key: 'metacritic', label: 'Metacritic', version: 4,
    types: ['movie'], requiredConfig: null,
    channels: [{ channelKey: 'metacritic', label: 'Metacritic', icon: 'https://www.metacritic.com/favicon.ico' }],
    fetch: function (meta, deps) {
      return new Promise(function (resolve) {
        const titleForSlug = meta.originalTitle || meta.title || '';
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

        // 尝试 movies path，404 则尝试 shows path（TV/剧集）
        function tryMetacritic(paths) {
          if (paths.length === 0) {
            resolve({ metacritic: { channelKey: 'metacritic', status: 'no_match', url: searchUrl } });
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
                resolve({ metacritic: { channelKey: 'metacritic', status: 'no_rating', url: 'https://www.metacritic.com/' + pathType.replace('shows', 'tv') + '/' + slug + '/' } });
                return;
              }
              score = Number(score);
              const mcUrlType = pathType === 'shows' ? 'tv' : 'movie';
              resolve({
                metacritic: {
                  channelKey: 'metacritic',
                  status: 'success',
                  score: score,
                  scoreMax: 100,
                  displayValue: score + '/100',
                  count: null,
                  countText: null,
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
        tryMetacritic(['movies', 'shows']);
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
        const searchUrl = 'https://letterboxd.com/search/' + encodeURIComponent(meta.title || '') + '/';
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
          // Letterboxd 只有英文内容，用 originalTitle；纯中文标题不搜
          const searchTitle = meta.originalTitle || meta.title || '';
          if (!/[a-zA-Z]/.test(searchTitle)) {
            resolve(noMatch());
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
        // Search: https://api.bgm.tv/search/subject/{keyword}?type=2&responseGroup=small
        // type=2 → anime; MUST send User-Agent header (otherwise 403)
        const keyword = encodeURIComponent(meta.title || '');
        const apiUrl = 'https://api.bgm.tv/search/subject/' + keyword + '?type=2&responseGroup=small';

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
    version: 2,
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
    version: 5,
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
  // Scheduler — 并发抓取、缓存、限流、共存检测
  // ============================================================

  function checkCoexistence() {
    if (document.getElementById('douban-neodb-rating-style')) return true;
    const thirdParty = document.querySelector('.douban-thirdparty-rating');
    if (thirdParty && thirdParty.textContent.indexOf('NeoDB') !== -1) return true;
    return false;
  }

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

      // Pre-flight: NeoDB 共存检测
      if (source.key === 'neodb' && checkCoexistence()) {
        emitAll({ status: 'coexist_skip' });
        return;
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
    createSlots(allChannels);
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
  }

  // DOM 就绪后执行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }
})();
