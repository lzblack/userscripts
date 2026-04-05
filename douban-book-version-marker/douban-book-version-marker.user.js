// ==UserScript==
// @name         豆瓣读书版本标记提示
// @namespace    https://github.com/lzblack
// @version      1.0.0
// @author       lzblack
// @description  在豆瓣读书条目页提示你标记过同一作品的其他版本
// @match        https://book.douban.com/subject/*
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
    const matches = html.matchAll(/\/subject\/(\d+)\//g);
    const seen = new Set();
    const ids = [];
    for (const m of matches) {
      const id = m[1];
      if (id !== currentId && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return { ids, html };
  }

  async function checkInterest(subjectId) {
    const resp = await fetch(`/j/subject/${subjectId}/interest`, {
      credentials: 'include',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.html) return null;
    const match = data.html.match(
      /<input[^>]*value="(wish|do|collect)"[^>]*checked="checked"[^>]*\/?>|<input[^>]*checked="checked"[^>]*value="(wish|do|collect)"[^>]*\/?>/
    );
    return match ? (match[1] || match[2]) : null;
  }

  function fetchVersionName(subjectId, worksPageHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(worksPageHtml, 'text/html');
    const links = doc.querySelectorAll('a');
    for (const link of links) {
      if (link.href && link.href.includes(`/subject/${subjectId}/`)) {
        const text = link.textContent.trim();
        if (text) return text;
      }
    }
    // Fallback: try matching href attribute directly (DOMParser may resolve relative URLs differently)
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (href.includes(`/subject/${subjectId}/`) || href.includes(`/subject/${subjectId}`)) {
        const text = link.textContent.trim();
        if (text) return text;
      }
    }
    return `版本 ${subjectId}`;
  }

  async function checkAllVersions(versionIds, worksPageHtml) {
    const results = await Promise.all(
      versionIds.map(async (id) => {
        const status = await checkInterest(id);
        if (!status) return null;
        const name = fetchVersionName(id, worksPageHtml);
        return {
          status,
          name,
          url: `https://book.douban.com/subject/${id}/`,
        };
      })
    );

    return results
      .filter(Boolean)
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
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
      .version-marker-loading {
        font-size: 12px;
        color: #999;
        margin-top: 8px;
      }
    `;
    document.head.appendChild(style);
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
    if (loadingEl && loadingEl.parentNode) {
      loadingEl.parentNode.removeChild(loadingEl);
    }
    if (!markedVersions || markedVersions.length === 0) return;

    const anchor = document.getElementById('interest_sect_level');
    if (!anchor) return;

    const container = document.createElement('div');
    container.className = 'version-marker-tip';

    for (const v of markedVersions) {
      const line = document.createElement('div');

      const label = STATUS_LABELS[v.status] || v.status;
      const textNode = document.createTextNode(`${label}另一版本：`);
      line.appendChild(textNode);

      const link = document.createElement('a');
      link.href = v.url;
      link.setAttribute('target', '_blank');
      link.textContent = v.name;
      line.appendChild(link);

      container.appendChild(line);
    }

    anchor.insertAdjacentElement('afterend', container);
  }

  async function init() {
    const currentId = getCurrentSubjectId();
    if (!currentId) {
      log('No subject ID found, abort.');
      return;
    }

    const worksUrl = getWorksUrl();
    if (!worksUrl) {
      log('No works link found, skip.');
      return;
    }

    log('Works URL:', worksUrl);
    ensureStyles();

    const loadingEl = insertLoadingTip();

    try {
      const { ids, html } = await fetchVersionIds(worksUrl);
      log('Found', ids.length, 'other version(s).');

      if (ids.length === 0) {
        if (loadingEl && loadingEl.parentNode) {
          loadingEl.parentNode.removeChild(loadingEl);
        }
        return;
      }

      const markedVersions = await checkAllVersions(ids, html);
      log('Marked versions:', markedVersions);

      renderTip(markedVersions, loadingEl);
    } catch (err) {
      console.error('[VersionMarker] Error:', err);
      if (loadingEl && loadingEl.parentNode) {
        loadingEl.parentNode.removeChild(loadingEl);
      }
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
