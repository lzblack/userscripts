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
  // 占位初始化 — 后续任务中将替换为完整流程
  // ============================================================

  var meta = extractMeta();
  deps.log('Page type:', meta.type, '| Meta:', meta);
})();
