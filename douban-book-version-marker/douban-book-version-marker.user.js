// ==UserScript==
// @name         豆瓣读书版本标记提示
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.0.2
// @author       lzblack
// @description  在豆瓣读书条目页提示你标记过同一作品的其他版本
// @match        https://book.douban.com/subject/*
// @icon         https://img3.doubanio.com/favicon.ico
// @icon64       https://img3.doubanio.com/favicon.ico
// @grant        none
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-book-version-marker/douban-book-version-marker.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-book-version-marker/douban-book-version-marker.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STATUS_LABELS = { collect: '已读', do: '在读', wish: '想读' };
  const STATUS_ORDER = ['collect', 'do', 'wish'];

  function log(...args) {
    console.log('[VersionMarker]', ...args);
  }

  function getCurrentSubjectId() {
    const match = location.pathname.match(/\/subject\/(\d+)/);
    return match ? match[1] : null;
  }

  function getWorksUrl() {
    const link = document.querySelector('a[href*="/works/"]');
    return link ? link.href : null;
  }

  async function fetchVersionIds(worksUrl) {
    const currentId = getCurrentSubjectId();
    const resp = await fetch(worksUrl, { credentials: 'include' });
    const html = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const links = doc.querySelectorAll('a[href*="/subject/"]');
    const seen = new Set();
    const ids = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/subject\/(\d+)/);
      if (m && m[1] !== currentId && !seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    return { ids, doc };
  }

  async function checkInterest(subjectId) {
    try {
      const resp = await fetch(`/j/subject/${subjectId}/interest`, {
        credentials: 'include',
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.html) return null;
      const fragment = new DOMParser().parseFromString(data.html, 'text/html');
      const checked = fragment.querySelector('input[name="interest"][checked="checked"]');
      if (!checked) return null;
      const ratingInput = fragment.querySelector('#n_rating');
      const rating = ratingInput ? parseInt(ratingInput.value, 10) || 0 : 0;
      return { status: checked.value, rating };
    } catch (e) {
      log('Failed to check interest for', subjectId, e);
      return null;
    }
  }

  function parseVersionName(subjectId, worksDoc) {
    const links = worksDoc.querySelectorAll('a[href*="/subject/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (href.includes(`/subject/${subjectId}/`) || href.includes(`/subject/${subjectId}`)) {
        const text = link.textContent.trim();
        if (text) return text;
      }
    }
    return `版本 ${subjectId}`;
  }

  async function checkAllVersions(versionIds, worksDoc) {
    const results = [];
    for (const id of versionIds) {
      const interest = await checkInterest(id);
      if (interest) {
        results.push({
          status: interest.status,
          rating: interest.rating,
          name: parseVersionName(id, worksDoc),
          url: `https://book.douban.com/subject/${id}/`,
        });
      }
    }
    return results.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  }

  function ensureStyles() {
    if (document.getElementById('version-marker-style')) return;
    const style = document.createElement('style');
    style.id = 'version-marker-style';
    style.textContent = `
      .version-marker-tip {
        font-size: 12px;
        color: #999;
        margin-top: 8px;
        line-height: 1.8;
      }
      .version-marker-tip a {
        color: #37a;
        text-decoration: none;
      }
      .version-marker-tip a:hover {
        text-decoration: underline;
      }
      .version-marker-stars {
        color: #e09015;
      }
      .version-marker-loading {
        font-size: 12px;
        color: #999;
        margin-top: 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function removeElement(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function insertLoadingTip() {
    const anchor = document.getElementById('interest_sect_level');
    if (!anchor) return null;
    const el = document.createElement('div');
    el.className = 'version-marker-loading';
    el.textContent = '正在检查其他版本...';
    anchor.insertAdjacentElement('afterend', el);
    return el;
  }

  function renderTip(markedVersions, loadingEl) {
    removeElement(loadingEl);
    if (!markedVersions || markedVersions.length === 0) return;

    const anchor = document.getElementById('interest_sect_level');
    if (!anchor) return;

    const container = document.createElement('div');
    container.className = 'version-marker-tip';

    for (const v of markedVersions) {
      const line = document.createElement('div');

      const label = STATUS_LABELS[v.status] || v.status;
      line.appendChild(document.createTextNode(`${label} 另一版本：`));

      const link = document.createElement('a');
      link.href = v.url;
      link.target = '_blank';
      link.textContent = v.name;
      line.appendChild(link);

      if (v.rating > 0 && (v.status === 'collect' || v.status === 'do')) {
        const stars = document.createElement('span');
        stars.className = 'version-marker-stars';
        stars.textContent = ' ' + '★'.repeat(v.rating) + '☆'.repeat(5 - v.rating);
        line.appendChild(stars);
      }

      container.appendChild(line);
    }

    anchor.insertAdjacentElement('afterend', container);
  }

  async function init() {
    const currentId = getCurrentSubjectId();
    if (!currentId) return;

    const worksUrl = getWorksUrl();
    if (!worksUrl) return;

    log('Works URL:', worksUrl);
    ensureStyles();
    const loadingEl = insertLoadingTip();

    try {
      const { ids, doc: worksDoc } = await fetchVersionIds(worksUrl);
      log('Found', ids.length, 'other version(s).');

      if (ids.length === 0) {
        removeElement(loadingEl);
        return;
      }

      const markedVersions = await checkAllVersions(ids, worksDoc);
      log('Marked versions:', markedVersions);
      renderTip(markedVersions, loadingEl);
    } catch (err) {
      log('Error:', err);
      removeElement(loadingEl);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
