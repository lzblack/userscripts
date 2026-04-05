# douban-book-version-marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a userscript that shows "已读/在读/想读另一版本" tips on Douban book pages when the user has marked a different edition of the same work.

**Architecture:** Single-file IIFE userscript. On page load, scrape the sidebar for the works URL, fetch the works page to get all edition IDs, concurrently query each edition's interest status via `/j/subject/{id}/interest`, and render tips below the collect buttons.

**Tech Stack:** Vanilla JavaScript, Tampermonkey userscript, same-domain `fetch` API.

---

## File Structure

- Create: `douban-book-version-marker/douban-book-version-marker.user.js` — the entire script (single file)

---

### Task 1: Metadata block and script skeleton

**Files:**
- Create: `douban-book-version-marker/douban-book-version-marker.user.js`

- [ ] **Step 1: Create the file with metadata block and IIFE skeleton**

```js
// ==UserScript==
// @name         豆瓣读书版本标记提示
// @namespace    https://github.com/lzblack
// @version      1.0.0
// @author       lzblack
// @description  在豆瓣读书页面显示同一作品其他版本的标记状态（想读/在读/已读）
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

  // TODO: tasks 2-5 will add functions here

  async function init() {
    log('init');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

- [ ] **Step 2: Commit**

```bash
git add douban-book-version-marker/douban-book-version-marker.user.js
git commit -m "feat(version-marker): add script skeleton with metadata block"
```

---

### Task 2: Implement getWorksUrl and fetchVersionIds

**Files:**
- Modify: `douban-book-version-marker/douban-book-version-marker.user.js`

- [ ] **Step 1: Add getWorksUrl function**

Replace `// TODO: tasks 2-5 will add functions here` with:

```js
  function getWorksUrl() {
    const link = document.querySelector('a[href*="/works/"]');
    return link ? link.href : null;
  }

  async function fetchVersionIds(worksUrl) {
    const currentId = getCurrentSubjectId();
    const resp = await fetch(worksUrl);
    if (!resp.ok) return [];
    const html = await resp.text();
    const matches = html.match(/\/subject\/(\d+)\//g) || [];
    const ids = [...new Set(matches.map(m => m.match(/(\d+)/)[1]))];
    return ids.filter(id => id !== currentId);
  }

  // TODO: tasks 3-5 will add functions here
```

- [ ] **Step 2: Wire into init to verify**

Update `init()`:

```js
  async function init() {
    const worksUrl = getWorksUrl();
    if (!worksUrl) {
      log('No works URL found, exiting.');
      return;
    }
    log('Works URL:', worksUrl);

    const versionIds = await fetchVersionIds(worksUrl);
    if (versionIds.length === 0) {
      log('No other versions found, exiting.');
      return;
    }
    log('Other version IDs:', versionIds);
  }
```

- [ ] **Step 3: Commit**

```bash
git add douban-book-version-marker/douban-book-version-marker.user.js
git commit -m "feat(version-marker): add works URL extraction and version ID fetching"
```

---

### Task 3: Implement checkInterest and checkAllVersions

**Files:**
- Modify: `douban-book-version-marker/douban-book-version-marker.user.js`

- [ ] **Step 1: Add interest checking functions**

Replace `// TODO: tasks 3-5 will add functions here` with:

```js
  async function checkInterest(subjectId) {
    try {
      const resp = await fetch(`/j/subject/${subjectId}/interest`, { credentials: 'include' });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.html) return null;

      const match = data.html.match(/value="(wish|do|collect)"\s+name="interest"\s+checked="checked"/);
      if (!match) {
        // Try alternate attribute order
        const match2 = data.html.match(/name="interest"\s+checked="checked"[\s\S]*?value="(wish|do|collect)"/);
        if (!match2) return null;
        return match2[1];
      }
      return match[1];
    } catch (e) {
      log('Failed to check interest for', subjectId, e);
      return null;
    }
  }

  async function fetchVersionName(subjectId, worksPageHtml) {
    // Try to extract edition name from works page HTML
    const regex = new RegExp(`/subject/${subjectId}/[^"]*"[^>]*>([^<]+)<`, 'i');
    const match = worksPageHtml.match(regex);
    if (match) return match[1].trim();
    return `版本 ${subjectId}`;
  }

  async function checkAllVersions(versionIds, worksPageHtml) {
    const results = await Promise.all(
      versionIds.map(async (id) => {
        const status = await checkInterest(id);
        if (!status) return null;
        const name = await fetchVersionName(id, worksPageHtml);
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

  // TODO: tasks 4-5 will add functions here
```

- [ ] **Step 2: Update fetchVersionIds to also return works page HTML**

Change `fetchVersionIds` to return both IDs and HTML:

```js
  async function fetchVersionIds(worksUrl) {
    const currentId = getCurrentSubjectId();
    const resp = await fetch(worksUrl);
    if (!resp.ok) return { ids: [], html: '' };
    const html = await resp.text();
    const matches = html.match(/\/subject\/(\d+)\//g) || [];
    const ids = [...new Set(matches.map(m => m.match(/(\d+)/)[1]))];
    return { ids: ids.filter(id => id !== currentId), html };
  }
```

- [ ] **Step 3: Update init to use new return value**

```js
  async function init() {
    const worksUrl = getWorksUrl();
    if (!worksUrl) {
      log('No works URL found, exiting.');
      return;
    }

    const { ids: versionIds, html: worksHtml } = await fetchVersionIds(worksUrl);
    if (versionIds.length === 0) {
      log('No other versions found, exiting.');
      return;
    }
    log('Checking', versionIds.length, 'other versions...');

    const markedVersions = await checkAllVersions(versionIds, worksHtml);
    if (markedVersions.length === 0) {
      log('No marked versions found.');
      return;
    }
    log('Marked versions:', markedVersions);
  }
```

- [ ] **Step 4: Commit**

```bash
git add douban-book-version-marker/douban-book-version-marker.user.js
git commit -m "feat(version-marker): add interest status checking for all editions"
```

---

### Task 4: Implement renderTip and styles

**Files:**
- Modify: `douban-book-version-marker/douban-book-version-marker.user.js`

- [ ] **Step 1: Add styles and renderTip**

Replace `// TODO: tasks 4-5 will add functions here` with:

```js
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
    const anchor = document.querySelector('#interest_sect_level');
    if (!anchor) return null;
    ensureStyles();
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
    if (markedVersions.length === 0) return;

    const anchor = document.querySelector('#interest_sect_level');
    if (!anchor) return;

    ensureStyles();
    const container = document.createElement('div');
    container.className = 'version-marker-tip';

    markedVersions.forEach(v => {
      const line = document.createElement('div');
      const label = STATUS_LABELS[v.status] || v.status;
      line.textContent = `${label}另一版本：`;

      const link = document.createElement('a');
      link.href = v.url;
      link.target = '_blank';
      link.textContent = v.name;
      line.appendChild(link);

      container.appendChild(line);
    });

    anchor.insertAdjacentElement('afterend', container);
  }
```

- [ ] **Step 2: Commit**

```bash
git add douban-book-version-marker/douban-book-version-marker.user.js
git commit -m "feat(version-marker): add UI rendering with loading state and tip display"
```

---

### Task 5: Wire everything together in init and finalize

**Files:**
- Modify: `douban-book-version-marker/douban-book-version-marker.user.js`

- [ ] **Step 1: Update init to use loading indicator and renderTip**

```js
  async function init() {
    const currentId = getCurrentSubjectId();
    if (!currentId) return;

    const worksUrl = getWorksUrl();
    if (!worksUrl) {
      log('No works URL found, exiting.');
      return;
    }

    const loadingEl = insertLoadingTip();

    try {
      const { ids: versionIds, html: worksHtml } = await fetchVersionIds(worksUrl);
      if (versionIds.length === 0) {
        log('No other versions found, exiting.');
        if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
        return;
      }
      log('Checking', versionIds.length, 'other versions...');

      const markedVersions = await checkAllVersions(versionIds, worksHtml);
      renderTip(markedVersions, loadingEl);
    } catch (e) {
      log('Error:', e);
      if (loadingEl && loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
    }
  }
```

- [ ] **Step 2: Remove the TODO comment placeholder (should be gone by now)**

Verify no `// TODO` comments remain in the file.

- [ ] **Step 3: Commit**

```bash
git add douban-book-version-marker/douban-book-version-marker.user.js
git commit -m "feat(version-marker): wire init flow with loading state and error handling"
```

---

### Task 6: Update CLAUDE.md, README.md, and final commit

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Add new script to CLAUDE.md table**

Add a row to the Scripts table:

```
| `douban-book-version-marker/` | Douban (book pages) | Shows tips when the user has marked a different edition of the same work (想读/在读/已读). Uses `/j/subject/{id}/interest` AJAX endpoint. |
```

- [ ] **Step 2: Add new script to README.md table**

Add a row (Greasy Fork link as placeholder until published):

```
| [豆瓣读书版本标记提示](douban-book-version-marker/) | 在豆瓣读书页面显示同一作品其他版本的标记状态（想读/在读/已读） | [Install](https://raw.githubusercontent.com/lzblack/userscripts/main/douban-book-version-marker/douban-book-version-marker.user.js) | [Greasy Fork](https://greasyfork.org/) |
```

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md README.md
git commit -m "docs: add douban-book-version-marker to CLAUDE.md and README"
git push origin main
```

---

### Task 7: Manual testing in Tampermonkey

- [ ] **Step 1: Copy script content into Tampermonkey and test on these pages:**

1. **有标记的书** — 打开你已标记"想读"的 https://book.douban.com/subject/2973335/ ，访问同一作品的另一版本页面（如 https://book.douban.com/subject/33372564/ ），应看到提示。
2. **反向测试** — 在 2973335 页面应看到"想读另一版本"（如果你标记了其他版本）或无提示（如果只标记了当前版本）。
3. **无标记的书** — 打开一本你未标记过任何版本的书，不应显示任何内容。
4. **无其他版本的书** — 打开一本没有"其他版本"区域的书，脚本静默退出。
5. **未登录** — 退出登录后访问有其他版本的书，不应显示任何内容。

- [ ] **Step 2: Fix any issues found during testing**

- [ ] **Step 3: Final commit if fixes were needed**
