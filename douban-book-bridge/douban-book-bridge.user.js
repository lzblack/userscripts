// ==UserScript==
// @name         豆瓣图书桥 | Douban Book Bridge
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @supportURL   https://github.com/lzblack/userscripts/issues
// @version      0.1.0
// @author       lzblack
// @description  在 Amazon 图书页一键查豆瓣是否收录；未收录则跳转添加流程并自动回填（豆瓣回填器开发中）。人工只负责审核和提交。
// @match        https://www.amazon.com/*
// @match        https://book.douban.com/new_subject*
// @connect      book.douban.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @icon         https://img3.doubanio.com/favicon.ico
// @icon64       https://img3.doubanio.com/favicon.ico
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-book-bridge/douban-book-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-book-bridge/douban-book-bridge.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 纯函数解析层 — 无 DOM/网络副作用（见 douban-book-bridge.test.js）
  // ============================================================

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };

  /** 校验 ISBN-13：长度 13、前缀 978/979、mod-10 校验位。 */
  function validateIsbn13(input) {
    const s = String(input == null ? '' : input).replace(/[^0-9]/g, '');
    if (s.length !== 13) return false;
    if (!/^97[89]/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return sum % 10 === 0;
  }

  /** ISBN-10 → ISBN-13（加 978 前缀、重算校验位）。非 10 位输入返回 null。 */
  function isbn10to13(input) {
    const s = String(input == null ? '' : input).replace(/[^0-9Xx]/g, '');
    if (s.length !== 10) return null;
    const core = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;
    return core + check;
  }

  /** 按第一个冒号拆正/副标题（半角或全角冒号）。 */
  function splitTitle(input) {
    const s = String(input == null ? '' : input).trim();
    const idx = s.search(/[:：]/);
    if (idx === -1) return { title: s, subtitle: '' };
    return { title: s.slice(0, idx).trim(), subtitle: s.slice(idx + 1).trim() };
  }

  /** 解析 "March 5, 2024" / "Mar 2024" / "2024" → {y,m,d}（缺位为 null）；无年份返回 null。 */
  function parseDate(input) {
    const s = String(input == null ? '' : input).trim();
    const ym = s.match(/([A-Za-z]{3,})[^0-9A-Za-z]+(?:(\d{1,2})[^0-9A-Za-z]+)?(\d{4})/);
    if (ym) {
      const mon = MONTHS[ym[1].slice(0, 3).toLowerCase()];
      if (mon) {
        return { y: Number(ym[3]), m: mon, d: ym[2] ? Number(ym[2]) : null };
      }
    }
    const yOnly = s.match(/\b(\d{4})\b/);
    if (yOnly) return { y: Number(yOnly[1]), m: null, d: null };
    return null;
  }

  /** 拆 "Penguin Press (March 5, 2024)" → {publisher, date|null}。无括号日期则 date=null。 */
  function splitPublisherDate(input) {
    const s = String(input == null ? '' : input).trim();
    const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (m) {
      const date = parseDate(m[2]);
      if (date) return { publisher: m[1].trim(), date };
    }
    return { publisher: s, date: null };
  }

  /** 归一化定价 → {currency, amount:'30.00'}；识别 $/£/€ 与三字母代码。无法解析返回 null。 */
  function normalizePrice(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return null;
    const SYMBOL = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'CNY' };
    let currency = null;
    const code = s.match(/\b([A-Z]{3})\b/);
    if (code) currency = code[1];
    if (!currency) {
      const sym = s.match(/[$£€¥]/);
      if (sym) currency = SYMBOL[sym[0]];
    }
    const num = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    if (!currency || !num) return null;
    return { currency, amount: Number(num[0]).toFixed(2) };
  }

  /** 装帧归一化：含 hardcover→'hardcover'，含 paperback→'paperback'，否则 'other'。 */
  function mapBinding(input) {
    const s = String(input == null ? '' : input).toLowerCase();
    if (s.includes('hardcover') || s.includes('hardback')) return 'hardcover';
    if (s.includes('paperback')) return 'paperback';
    return 'other';
  }

  /** 书名归一化（与 rating-hub 一致）：&→and、小写、去非字母数字。用于 suggest 精确匹配。 */
  function normalizeTitle(input) {
    return (input == null ? '' : String(input)).replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** "320 pages" / "1,024 pages" / "xii, 416 pages" → 整数；无数字返回 null。 */
  function parsePageCount(input) {
    const s = String(input == null ? '' : input).replace(/,/g, '');
    const m = s.match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  /** payload 是否在 TTL 窗口内（now - capturedAt < ttl）。 */
  function isPayloadFresh(payload, now, ttl) {
    const at = payload && payload.source && payload.source.capturedAt;
    if (typeof at !== 'number') return false;
    return now - at < ttl;
  }

  // ── node 测试导出（在 DOM 启动代码之前 return） ──────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      validateIsbn13, isbn10to13, splitTitle, parseDate, splitPublisherDate,
      normalizePrice, mapBinding, normalizeTitle, parsePageCount, isPayloadFresh,
    };
    return;
  }

  // ============================================================
  // 运行期：配置 + GM 封装
  // ============================================================

  const STORAGE_KEY = 'dbb:pending';
  const TTL_MS = 10 * 60 * 1000;
  const NEW_SUBJECT_BASE = 'https://book.douban.com/new_subject';

  const deps = {
    // 默认带 cookie：唯一跨域目标是豆瓣，登录态既是 new_subject 的前提，
    // 也是对抗 /isbn/ 风控 403 的主要手段。匿名请求请显式传 anonymous:true。
    request(url, opts = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: opts.method || 'GET',
          url,
          headers: opts.headers || {},
          timeout: opts.timeout || 15000,
          anonymous: opts.anonymous === true,
          onload: resolve,
          onerror: () => reject(new Error('request failed: ' + url)),
          ontimeout: () => reject(new Error('request timeout: ' + url)),
        });
      });
    },
    log(...args) { console.log('[BookBridge]', ...args); },
  };

  function escapeHtml(input) {
    return String(input == null ? '' : input)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 清洗 Amazon 详情里的方向控制符与冒号噪声，折叠空白。 */
  function cleanLabel(s) {
    return String(s == null ? '' : s)
      .replace(/[‎‏‪-‮]/g, '')
      .replace(/[:：]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============================================================
  // Amazon 适配器：DOM → canonical payload + 角标
  // ============================================================

  /** 收集 Amazon 详情区的 {label,value} 行（detail-bullets 列表 + product-details 表格两套布局）。 */
  function amazonDetailRows() {
    const rows = [];
    document
      .querySelectorAll('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li')
      .forEach((li) => {
        const spans = li.querySelectorAll('span');
        if (spans.length >= 2) {
          rows.push({ label: cleanLabel(spans[0].textContent), value: cleanLabel(spans[spans.length - 1].textContent) });
        }
      });
    document
      .querySelectorAll(
        '#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, table.prodDetTable tr'
      )
      .forEach((tr) => {
        const th = tr.querySelector('th');
        const td = tr.querySelector('td');
        if (th && td) rows.push({ label: cleanLabel(th.textContent), value: cleanLabel(td.textContent) });
      });
    return rows;
  }

  function detailValue(rows, labelRe) {
    const row = rows.find((r) => labelRe.test(r.label));
    return row ? row.value : '';
  }

  function extractAuthors() {
    const out = [];
    document.querySelectorAll('#bylineInfo .author').forEach((el) => {
      if (/author/i.test(el.textContent)) {
        const a = el.querySelector('a');
        const name = cleanLabel((a ? a.textContent : el.textContent).replace(/\(author\)/i, ''));
        if (name) out.push(name);
      }
    });
    return out;
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t) return t;
      }
    }
    return '';
  }

  /** 从 Amazon 图书页提取 canonical payload；ISBN 无效则 isbn13=null（调用方据此阻断）。 */
  function extractAmazonPayload() {
    const rows = amazonDetailRows();
    const productTitle = (document.querySelector('#productTitle')?.textContent || '').trim();
    const { title, subtitle } = splitTitle(productTitle);

    let isbn13 = '';
    const raw13 = detailValue(rows, /isbn-13/i).replace(/[^0-9]/g, '');
    if (validateIsbn13(raw13)) {
      isbn13 = raw13;
    } else {
      const conv = isbn10to13(detailValue(rows, /isbn-10/i));
      if (conv && validateIsbn13(conv)) isbn13 = conv;
    }

    const pub = splitPublisherDate(detailValue(rows, /^publisher/i));
    const pubDate = pub.date || parseDate(detailValue(rows, /publication date/i));

    const bindingSubtitle = firstText(['#productSubtitle', '#tmmSwatches .selected', '.swatchElement.selected']);
    const binding = mapBinding(bindingSubtitle);

    const price = normalizePrice(
      firstText([
        '#tmmSwatches .selected .a-color-price',
        '#tmmSwatches .selected .slot-price',
        '#price',
        '.a-price .a-offscreen',
      ])
    );

    const description = firstText(['#bookDescription_expander', '#bookDescription_feature_div']);
    const authorBio = firstText(['#authorBio_feature_div', '#bookAbout_feature_div .a-expander-content']);
    const coverEl = document.querySelector('#landingImage, #imgBlkFront');
    const coverUrl = coverEl ? coverEl.getAttribute('data-old-hires') || coverEl.getAttribute('src') || '' : '';

    return {
      title,
      subtitle,
      authors: extractAuthors(),
      isbn13: isbn13 || null,
      publisher: pub.publisher || '',
      pubDate: pubDate || { y: null, m: null, d: null },
      pageCount: parsePageCount(detailValue(rows, /print length|paperback|hardcover|pages/i)),
      binding,
      bindingRaw: cleanLabel(bindingSubtitle),
      price: price || null,
      description: description || '',
      authorBio: authorBio || '',
      coverUrl,
      source: { name: 'amazon', url: location.href.split('?')[0], capturedAt: Date.now() },
    };
  }

  // ============================================================
  // 豆瓣查重服务（与来源无关）
  // ============================================================

  function parseDoubanRating(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const num = doc.querySelector('#interest_sectl strong.rating_num, strong.rating_num');
      const val = num ? parseFloat(num.textContent.trim()) : NaN;
      return isNaN(val) || val === 0 ? null : val.toFixed(1);
    } catch {
      return null;
    }
  }

  async function titleSearch(title) {
    try {
      const resp = await deps.request(
        `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
        { anonymous: false }
      );
      const list = JSON.parse(resp.responseText);
      if (!Array.isArray(list)) return [];
      const want = normalizeTitle(title);
      return list
        .filter((it) => it && it.type === 'b' && normalizeTitle(it.title) === want)
        .map((it) => ({ title: it.title, url: it.url, year: it.year, author: it.author_name }));
    } catch {
      return [];
    }
  }

  /** /isbn/{isbn}/ 三态查重；miss 时串行回落书名查重。返回 {kind, ...}。 */
  async function dedup(isbn13, title) {
    let resp;
    try {
      resp = await deps.request(`https://book.douban.com/isbn/${isbn13}/`, { anonymous: false });
    } catch {
      return { kind: 'error' };
    }
    const finalUrl = resp.finalUrl || '';
    if (resp.status === 200 && /\/subject\/\d+/.test(finalUrl)) {
      return { kind: 'hit', url: finalUrl, rating: parseDoubanRating(resp.responseText) };
    }
    if (resp.status === 404) {
      const others = await titleSearch(title);
      return others.length ? { kind: 'other', items: others } : { kind: 'absent' };
    }
    return { kind: 'error' };
  }

  // ============================================================
  // 跨域交接
  // ============================================================

  function stashAndOpen(payload) {
    GM_setValue(STORAGE_KEY, JSON.stringify(payload));
    const url = `${NEW_SUBJECT_BASE}?cat=1001&search_text=${encodeURIComponent(payload.title)}`;
    GM_openInTab(url, { active: true, insert: true });
  }

  // ============================================================
  // Amazon 侧角标 UI
  // ============================================================

  const BADGE_ID = 'dbb-badge';

  function fieldSummaryHtml(p) {
    const rows = [
      ['正标题', p.title],
      ['副标题', p.subtitle || '—'],
      ['作者', p.authors.length ? p.authors.join(' / ') : '—'],
      ['ISBN-13', p.isbn13 || '（缺失）'],
      ['出版社', p.publisher || '—'],
      ['出版日期', p.pubDate.y ? [p.pubDate.y, p.pubDate.m, p.pubDate.d].filter(Boolean).join('-') : '—'],
      ['页数', p.pageCount || '—'],
      ['装帧', p.binding === 'other' ? `其他（${p.bindingRaw || '?'}）` : p.binding],
      ['定价', p.price ? `${p.price.currency} ${p.price.amount}` : '—'],
      ['内容简介', p.description ? `${p.description.length} 字` : '（缺失，必填）'],
    ];
    return rows
      .map(([k, v]) => `<div style="display:flex;gap:8px"><b style="flex:0 0 64px;color:#666">${k}</b><span>${escapeHtml(String(v))}</span></div>`)
      .join('');
  }

  function ensureBadge() {
    let box = document.getElementById(BADGE_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = BADGE_ID;
    box.style.cssText =
      'margin:12px 0;padding:12px 14px;border:1px solid #d6c79b;border-radius:8px;' +
      'background:#fcf9ef;font-size:13px;line-height:1.6;color:#333;max-width:640px';
    const title = document.querySelector('#productTitle');
    if (title && title.parentElement) {
      title.parentElement.insertBefore(box, title.nextSibling);
    } else {
      box.style.cssText += ';position:fixed;top:12px;right:12px;z-index:99999;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.2)';
      document.body.appendChild(box);
    }
    return box;
  }

  function renderBadge(state, payload, result) {
    const box = ensureBadge();
    let head = '';
    if (state === 'loading') head = '<b>豆瓣查重中…</b>';
    else if (state === 'no-isbn') head = '<b style="color:#c0392b">未找到 ISBN</b> — 请切换到 print edition 页面。';
    else if (state === 'hit') {
      const r = result.rating ? `豆瓣 ${result.rating} 分` : '豆瓣已收录';
      head = `<b style="color:#2e7d32">✓ ${r}</b> · <a href="${escapeHtml(result.url)}" target="_blank" rel="noopener">直达条目 →</a>`;
    } else if (state === 'error') {
      const q = encodeURIComponent(payload ? payload.title : '');
      head = `<b style="color:#c0392b">查重失败</b>（风控/网络）· <a href="https://search.douban.com/book/subject_search?search_text=${q}" target="_blank" rel="noopener">手动搜索 →</a>`;
    } else if (state === 'other') {
      const links = result.items
        .map((it) => `<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.title)}${it.year ? `(${escapeHtml(it.year)})` : ''}</a>`)
        .join('、');
      head = `<b style="color:#b8860b">豆瓣有其他版本</b>：${links}`;
    } else if (state === 'absent') {
      head = '<b>豆瓣未收录</b>';
    }

    let action = '';
    if (state === 'other' || state === 'absent') {
      if (!payload.description) {
        action = '<div style="margin-top:8px;color:#c0392b">内容简介缺失（豆瓣必填）— 无法自动添加，请确认这是图书详情页。</div>';
      } else {
        const label = state === 'other' ? '仍要添加此版本' : '+ 添加到豆瓣';
        action = `<div style="margin-top:10px"><button id="dbb-add" style="cursor:pointer;padding:6px 14px;border:0;border-radius:6px;background:#2e7d32;color:#fff;font-size:13px">${label}</button></div>`;
      }
    }

    const summary = payload ? `<div style="margin-top:10px;border-top:1px dashed #e0d6b0;padding-top:8px">${fieldSummaryHtml(payload)}</div>` : '';
    box.innerHTML = `<div>${head}</div>${action}${summary}`;

    const btn = box.querySelector('#dbb-add');
    if (btn) btn.addEventListener('click', () => stashAndOpen(payload));
  }

  async function runAmazon() {
    if (!document.querySelector('#productTitle')) return; // 非图书/详情页，静默早退
    const payload = extractAmazonPayload();
    if (!payload.isbn13) {
      renderBadge('no-isbn', payload, null);
      return;
    }
    renderBadge('loading', payload, null);
    const result = await dedup(payload.isbn13, payload.title);
    renderBadge(result.kind, payload, result);
  }

  // ============================================================
  // 豆瓣侧（回填器开发中）— 当前仅验证跨域交接
  // ============================================================

  function runDouban() {
    const raw = GM_getValue(STORAGE_KEY);
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!isPayloadFresh(payload, Date.now(), TTL_MS)) {
      GM_deleteValue(STORAGE_KEY);
      return;
    }
    deps.log('payload received (回填器待实现):', payload);
  }

  // ============================================================
  // 分派
  // ============================================================

  const host = location.hostname;
  if (host === 'www.amazon.com') {
    runAmazon();
  } else if (host === 'book.douban.com') {
    runDouban();
  }
})();
