// ==UserScript==
// @name         豆瓣广播：这个我标过
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.2.0
// @author       lzblack
// @description  在豆瓣广播流（首页 + 成员 statuses 页）中，显示你对好友分享的书影音游戏的标记状态和评分
// @match        https://www.douban.com/
// @match        https://www.douban.com/?*
// @match        https://www.douban.com/people/*/statuses
// @match        https://www.douban.com/people/*/statuses?*
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
// @connect      game.douban.com
// @supportURL   https://github.com/lzblack/userscripts/issues
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-feed-mark/douban-feed-mark.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-feed-mark/douban-feed-mark.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============ 常量 ============

  const CACHE_PREFIX = 'dfm:v2:';
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
    game: 'game.douban.com',
  };

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
    if (url.includes('game.douban.com')) return 'game';
    return null;
  }

  function getSubjectId(url) {
    const match = url.match(/\/subject\/(\d+)/);
    return match ? match[1] : null;
  }

  function renderStars(rating) {
    if (!rating) return '';
    return ' ' + '★'.repeat(rating);
  }

  // ============ 缓存 ============

  function getCache(subjectId) {
    const entry = GM_getValue(CACHE_PREFIX + subjectId);
    if (!entry) return null;
    if (Date.now() > entry.fetchedAt + entry.ttl) {
      GM_deleteValue(CACHE_PREFIX + subjectId);
      return null;
    }
    return entry;
  }

  function setCache(subjectId, status, rating) {
    const ttl = status ? CACHE_TTL_MARKED : CACHE_TTL_UNMARKED;
    GM_setValue(CACHE_PREFIX + subjectId, {
      fetchedAt: Date.now(),
      ttl,
      status,
      rating,
    });
  }

  function evictStale() {
    const now = Date.now();
    for (const key of GM_listValues()) {
      if (!key.startsWith(CACHE_PREFIX)) continue;
      const entry = GM_getValue(key);
      if (!entry || now > entry.fetchedAt + entry.ttl) {
        GM_deleteValue(key);
      }
    }
  }

  // ============ API ============

  function fetchInterest(subjectId, category) {
    const host = CATEGORY_HOSTS[category];
    if (!host) return Promise.resolve({ status: null, rating: null });
    const url = `https://${host}/j/subject/${subjectId}/interest`;

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
            resolve({ status, rating });
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
    const card = link.closest('.block-subject');
    const content = card ? card.querySelector('.content') : null;
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

  function scan() {
    // 扫描所有条目链接
    const links = document.querySelectorAll('a[href*="/subject/"]');
    const subjectMap = new Map();

    for (const link of links) {
      if (link.dataset.dfmDone) continue;
      // 只处理有文字内容的链接（跳过纯图片链接如海报）
      if (!link.textContent.trim()) continue;
      const id = getSubjectId(link.href);
      const category = getCategoryFromUrl(link.href);
      if (!id || !category) continue;

      link.dataset.dfmDone = '1';

      if (!subjectMap.has(id)) {
        subjectMap.set(id, { category, links: [] });
      }
      subjectMap.get(id).links.push(link);
    }

    if (subjectMap.size === 0) {
      log('未找到条目链接');
      return;
    }
    log('发现', subjectMap.size, '个条目');

    // 查缓存 + 构建请求队列
    const toFetch = [];

    for (const [id, info] of subjectMap) {
      const cached = getCache(id);
      if (cached) {
        if (cached.status) {
          for (const link of info.links) {
            renderTag(link, cached.status, cached.rating, info.category);
          }
        }
      } else {
        toFetch.push({ id, info });
      }
    }

    if (toFetch.length === 0) {
      log('全部命中缓存');
      return;
    }
    log('需要请求', toFetch.length, '个条目');

    // 并发请求
    const tasks = toFetch.map(({ id, info }) => () =>
      fetchInterest(id, info.category).then(function (result) {
        setCache(id, result.status, result.rating);
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
