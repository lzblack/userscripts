// ==UserScript==
// @name         豆瓣广播：这个我标过
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.4.1
// @author       lzblack
// @description  在豆瓣广播流（首页 + 成员 statuses 页）和豆列页中，显示你对书影音游戏条目的标记状态和评分
// @match        https://www.douban.com/
// @match        https://www.douban.com/?*
// @match        https://www.douban.com/people/*/statuses
// @match        https://www.douban.com/people/*/statuses?*
// @match        https://www.douban.com/doulist/*
// @icon         https://img3.doubanio.com/favicon.ico
// @icon64       https://img3.doubanio.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      book.douban.com
// @connect      movie.douban.com
// @connect      music.douban.com
// @connect      www.douban.com
// @supportURL   https://github.com/lzblack/userscripts/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-feed-mark/douban-feed-mark.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-feed-mark/douban-feed-mark.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============ 常量 ============

  // v3：缓存键加了 category 前缀。游戏走 ilmen 的 id 空间，和书影音的 subject id
  // 是两套编号（10759791 在两边都能解析），不隔离会把书的状态盖到游戏上。
  const CACHE_PREFIX = 'dfm:v3:';
  const CACHE_TTL_MARKED = 7 * 24 * 60 * 60 * 1000;
  const CACHE_TTL_UNMARKED = 24 * 60 * 60 * 1000;
  const MAX_CONCURRENT = 3;

  const STATUS_LABELS = {
    book:  { wish: '已想读', do: '已在读', collect: '已读过' },
    movie: { wish: '已想看', do: '已在看', collect: '已看过' },
    music: { wish: '已想听', do: '已在听', collect: '已听过' },
    game:  { wish: '已想玩', do: '已在玩', collect: '已玩过' },
  };

  const CATEGORY_HOSTS = {
    book: 'book.douban.com',
    movie: 'movie.douban.com',
    music: 'music.douban.com',
  };

  // 豆列里的游戏条目链接是裸的 www.douban.com/subject/{id}/，URL 上读不出类别，
  // 只能看 .abstract 里的「类别: 游戏」。书影音条目一律带子域、也不带这一行
  // （13 个豆列 315 个条目实测），所以这里只需要认游戏。
  const ABSTRACT_CATEGORIES = {
    '游戏': 'game',
  };

  // ── node 测试导出（在任何 GM_/location 调用之前 return） ──────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      getCategoryFromUrl, getCategoryFromItem, getSubjectId,
      cacheKey, interestUrl, parseIlmenInterest,
    };
    return;
  }

  // 覆盖 @match 下的所有 /doulist/ 路径（含 /doulist/ 索引页），否则会退回全页扫描
  const IS_DOULIST = location.pathname.startsWith('/doulist/');

  const DISPLAY_MODE_KEY = 'dfm:displayMode';

  function getDisplayMode() {
    return GM_getValue(DISPLAY_MODE_KEY, 'stamp');
  }

  function toggleDisplayMode() {
    const current = getDisplayMode();
    const next = current === 'stamp' ? 'tag' : 'stamp';
    GM_setValue(DISPLAY_MODE_KEY, next);
    location.reload();
  }

  GM_registerMenuCommand(
    '切换显示模式（印章 / 标签）',
    toggleDisplayMode
  );

  // ============ 工具函数 ============

  function log(...args) {
    console.log('[广播标记]', ...args);
  }

  function getCategoryFromUrl(url) {
    if (url.includes('book.douban.com')) return 'book';
    if (url.includes('movie.douban.com')) return 'movie';
    if (url.includes('music.douban.com')) return 'music';
    // 游戏没有自己的子域（game.douban.com 根本不解析），条目页是 www.douban.com/game/{id}/
    if (/\/\/www\.douban\.com\/game\/\d+/.test(url)) return 'game';
    return null;
  }

  function getCategoryFromItem(item) {
    const abstract = item.querySelector('.abstract');
    // 冒号两侧的空格、以及全角冒号都要容忍：页面上实际出现过「类别 : 游戏」
    // （排版类扩展会在标点前后插空格），卡在这里会让整页游戏条目全被跳过
    const match = abstract && abstract.textContent.match(/类别\s*[:：]\s*(\S+)/);
    // 豆列里也收影评／日记／网页等非条目内容，映射不到就跳过，不猜类别
    return match ? ABSTRACT_CATEGORIES[match[1]] || null : null;
  }

  function getSubjectId(url) {
    const match = url.match(/\/(?:subject|game)\/(\d+)/);
    return match ? match[1] : null;
  }

  function renderStars(rating) {
    if (!rating) return '';
    return ' ' + '★'.repeat(rating);
  }

  // ============ 缓存 ============

  function cacheKey(subjectId, category) {
    return `${CACHE_PREFIX}${category}:${subjectId}`;
  }

  function getCache(subjectId, category) {
    const key = cacheKey(subjectId, category);
    const entry = GM_getValue(key);
    if (!entry) return null;
    if (Date.now() > entry.fetchedAt + entry.ttl) {
      GM_deleteValue(key);
      return null;
    }
    return entry;
  }

  function setCache(subjectId, category, status, rating) {
    const ttl = status ? CACHE_TTL_MARKED : CACHE_TTL_UNMARKED;
    GM_setValue(cacheKey(subjectId, category), {
      fetchedAt: Date.now(),
      ttl,
      status,
      rating,
    });
  }

  function evictStale() {
    const now = Date.now();
    for (const key of GM_listValues()) {
      // v2 的键没有 category 前缀，换 v3 后永远不会再被读到，顺手清掉
      if (key.startsWith('dfm:v2:')) {
        GM_deleteValue(key);
        continue;
      }
      if (!key.startsWith(CACHE_PREFIX)) continue;
      const entry = GM_getValue(key);
      if (!entry || now > entry.fetchedAt + entry.ttl) {
        GM_deleteValue(key);
      }
    }
  }

  // ============ API ============

  // 书影音：子域的 /j/subject/{id}/interest，返回 interest_status + 一段 html
  function parseSubjectInterest(data) {
    let status = data.interest_status || null;
    let rating = 0;
    if (data.html) {
      const doc = new DOMParser().parseFromString(data.html, 'text/html');
      if (!status) {
        const checked = doc.querySelector('input[name="interest"]:checked');
        status = checked ? checked.value || null : null;
      }
      if (status) {
        const ratingEl = doc.querySelector('#n_rating');
        rating = ratingEl ? parseInt(ratingEl.value, 10) || 0 : 0;
      }
    }
    return { status, rating };
  }

  // 游戏：www 的 /j/ilmen/thing/{id}/interest，字段完全不同。
  // 实测未标记时 action 为 null、is_modify 为 false；标记过则 action 是
  // wish/do/collect 且 is_modify 为 true。两个条件都要满足才算标过。
  function parseIlmenInterest(data) {
    if (data.r) return { status: null, rating: 0 };
    const status = data.is_modify && data.action ? data.action : null;
    const rating = status ? parseInt(data.rating, 10) || 0 : 0;
    return { status, rating };
  }

  function interestUrl(subjectId, category) {
    if (category === 'game') {
      return `https://www.douban.com/j/ilmen/thing/${subjectId}/interest`;
    }
    const host = CATEGORY_HOSTS[category];
    return host ? `https://${host}/j/subject/${subjectId}/interest` : null;
  }

  function fetchInterest(subjectId, category) {
    const url = interestUrl(subjectId, category);
    if (!url) return Promise.resolve({ status: null, rating: null });

    return new Promise(function (resolve) {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: false,
        onload(resp) {
          try {
            if (resp.status !== 200) {
              resolve({ status: null, rating: null });
              return;
            }
            const data = JSON.parse(resp.responseText);
            resolve(category === 'game'
              ? parseIlmenInterest(data)
              : parseSubjectInterest(data));
          } catch (e) {
            log('解析失败:', subjectId, e);
            resolve({ status: null, rating: null });
          }
        },
        onerror(e) {
          log('请求失败:', subjectId, e);
          resolve({ status: null, rating: null });
        },
      });
    });
  }

  // ============ 并发控制 ============

  function processQueue(tasks, concurrency) {
    let index = 0;
    const results = new Array(tasks.length);

    function worker() {
      if (index >= tasks.length) return Promise.resolve();
      const i = index++;
      return tasks[i]().then(function (result) {
        results[i] = result;
        return worker();
      });
    }

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
      workers.push(worker());
    }
    return Promise.all(workers).then(() => results);
  }

  // ============ 样式 ============

  function ensureStyles() {
    if (document.getElementById('dfm-styles')) return;
    const style = document.createElement('style');
    style.id = 'dfm-styles';
    style.textContent = `
      .dfm-wrapper {
        position: absolute;
        right: 3px;
        bottom: 3px;
      }
      .dfm-stamp {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 54px;
        height: 54px;
        border: 2px solid rgba(195, 128, 53, 0.45);
        border-radius: 50%;
        box-shadow: 0 0 0 2.5px rgba(195, 128, 53, 0.2);
        color: rgba(195, 128, 53, 0.55);
        transform: rotate(-18deg);
        pointer-events: none;
        line-height: 1.2;
      }
      .dfm-stamp-text {
        font-size: 12px;
        font-weight: bold;
      }
      .dfm-stamp-stars {
        font-size: 8px;
        letter-spacing: -0.5px;
      }
      .dfm-stamp-check {
        line-height: 0;
        height: 10px;
        overflow: visible;
      }
      .dfm-stamp-check svg {
        width: 18px;
        height: 15px;
      }
      .dfm-tag {
        display: inline-block;
        background: #f0fff0;
        color: #2d8a2d;
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        border: 1px solid #b8e6b8;
        margin-left: 6px;
        white-space: nowrap;
        vertical-align: baseline;
        position: relative;
        top: -1px;
      }
    `;
    document.head.appendChild(style);
  }

  // ============ 渲染 ============

  // 印章的落点：广播流是卡片内容区，豆列是条目的书影音信息块（封面 + 标题 + 简介）
  function findStampHost(link) {
    const doulistItem = link.closest('.doulist-item');
    if (doulistItem) return doulistItem.querySelector('.doulist-subject');
    const card = link.closest('.block-subject');
    return card ? card.querySelector('.content') : null;
  }

  function renderTag(link, status, rating, category) {
    const labels = STATUS_LABELS[category];
    if (!labels || !status || !labels[status]) return;
    const mode = getDisplayMode();

    if (mode === 'tag') {
      // 标签模式：inline tag 在标题行
      if (link.parentElement.querySelector('.dfm-tag')) return;
      const tag = document.createElement('span');
      tag.className = 'dfm-tag';
      tag.textContent = labels[status] + renderStars(rating);
      link.parentElement.appendChild(tag);
      return;
    }

    // 印章模式：绝对定位在内容区
    const content = findStampHost(link);
    if (!content) return;
    if (content.querySelector('.dfm-wrapper')) return;

    content.style.position = 'relative';

    const wrapper = document.createElement('div');
    wrapper.className = 'dfm-wrapper';

    const stamp = document.createElement('span');
    stamp.className = 'dfm-stamp';
    const textEl = document.createElement('span');
    textEl.className = 'dfm-stamp-text';
    textEl.textContent = labels[status];
    stamp.appendChild(textEl);
    if (status === 'collect' && rating) {
      const starsEl = document.createElement('span');
      starsEl.className = 'dfm-stamp-stars';
      starsEl.textContent = '★'.repeat(rating);
      stamp.appendChild(starsEl);
    } else {
      const checkEl = document.createElement('span');
      checkEl.className = 'dfm-stamp-check';
      checkEl.innerHTML = '<svg viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10 Q6 16 9 19 Q15.5 12 22 5"/></svg>';
      stamp.appendChild(checkEl);
    }
    wrapper.appendChild(stamp);

    content.appendChild(wrapper);
  }

  // ============ 主逻辑 ============

  // 广播流：全页扫条目链接。游戏条目页是 /game/{id}/，不带 /subject/
  function collectFeedTargets() {
    const targets = [];
    for (const link of document.querySelectorAll('a[href*="/subject/"], a[href*="/game/"]')) {
      if (link.dataset.dfmDone) continue;
      // 只处理有文字内容的链接（跳过纯图片链接如海报）
      if (!link.textContent.trim()) continue;
      const id = getSubjectId(link.href);
      const category = getCategoryFromUrl(link.href);
      if (!id || !category) continue;
      targets.push({ link, id, category });
    }
    return targets;
  }

  // 豆列：只取条目卡片里的标题链接，避开侧栏「相关豆列」「喜欢的人也喜欢」等噪声。
  // 书影音条目的链接都带子域，类别直接从 URL 读；游戏条目是裸 URL，退回读 .abstract。
  function collectDoulistTargets() {
    const targets = [];
    for (const item of document.querySelectorAll('.doulist-item')) {
      const link = item.querySelector('.title a[href]');
      if (!link || link.dataset.dfmDone) continue;
      const id = getSubjectId(link.href);
      const category = getCategoryFromUrl(link.href) || getCategoryFromItem(item);
      if (!id || !category) continue;
      targets.push({ link, id, category });
    }
    return targets;
  }

  function scan() {
    const targets = IS_DOULIST ? collectDoulistTargets() : collectFeedTargets();
    const subjectMap = new Map();

    // 按 category:id 去重——游戏和书影音是两套 id 编号，同一个数字可能各指一个条目
    for (const { link, id, category } of targets) {
      link.dataset.dfmDone = '1';

      const key = `${category}:${id}`;
      if (!subjectMap.has(key)) {
        subjectMap.set(key, { id, category, links: [] });
      }
      subjectMap.get(key).links.push(link);
    }

    if (subjectMap.size === 0) {
      log('未找到条目链接');
      return;
    }
    log('发现', subjectMap.size, '个条目');

    // 查缓存 + 构建请求队列
    const toFetch = [];

    for (const info of subjectMap.values()) {
      const cached = getCache(info.id, info.category);
      if (cached) {
        if (cached.status) {
          for (const link of info.links) {
            renderTag(link, cached.status, cached.rating, info.category);
          }
        }
      } else {
        toFetch.push(info);
      }
    }

    if (toFetch.length === 0) {
      log('全部命中缓存');
      return;
    }
    log('需要请求', toFetch.length, '个条目');

    // 并发请求
    const tasks = toFetch.map((info) => () =>
      fetchInterest(info.id, info.category).then(function (result) {
        setCache(info.id, info.category, result.status, result.rating);
        if (result.status) {
          for (const link of info.links) {
            renderTag(link, result.status, result.rating, info.category);
          }
        }
      })
    );

    processQueue(tasks, MAX_CONCURRENT).then(() => log('处理完成'));
  }

  // ============ 观察动态加载 ============

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  function observeStream() {
    const debouncedScan = debounce(scan, 400);
    const observer = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        if (m.addedNodes.length) {
          debouncedScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    log('初始化');
    ensureStyles();
    evictStale();
    scan();
    observeStream();
  }

  // ============ 入口 ============

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  } else {
    setTimeout(init, 300);
  }
})();
