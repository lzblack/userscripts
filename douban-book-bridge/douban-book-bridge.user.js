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

  /** canonical binding → 豆瓣装帧 radio 的 value（英文对英文精确映射）。 */
  function bindingRadioValue(binding) {
    if (binding === 'hardcover') return 'Hardcover';
    if (binding === 'paperback') return 'Paperback';
    return 'other';
  }

  /**
   * 纯函数：payload → 豆瓣第二步回填计划。无 DOM 副作用，便于单测。
   * 字段按「标签文本」标识；DOM 执行器据此定位控件。
   * @returns {{texts,author,textareas,date,binding,warnings,filled,skipped}}
   */
  function buildFillPlan(payload) {
    const p = payload || {};
    const texts = [];
    const filled = [];
    const skipped = [];
    const warnings = [];

    const pushText = (label, value) => {
      if (value) { texts.push({ label, value }); filled.push(label); }
      else skipped.push(label);
    };
    pushText('书名', p.title);
    pushText('副标题', p.subtitle);
    pushText('定价', p.price ? `${p.price.currency} ${p.price.amount}` : '');
    pushText('出版社', p.publisher);
    pushText('页数', p.pageCount != null ? String(p.pageCount) : '');

    const authors = Array.isArray(p.authors) ? p.authors : [];
    const author = authors[0] || '';
    if (author) filled.push('作者');
    else { skipped.push('作者'); warnings.push('缺作者（豆瓣必填）'); }
    if (authors.length > 1) warnings.push(`还有 ${authors.length - 1} 位作者需手动点 + 添加`);

    const textareas = [];
    const pushArea = (label, value, required) => {
      if (value) { textareas.push({ label, value }); filled.push(label); }
      else { skipped.push(label); if (required) warnings.push(`${label}缺失（豆瓣必填）`); }
    };
    pushArea('内容简介', p.description, true);
    pushArea('作者简介', p.authorBio, false);

    const d = p.pubDate || {};
    const date = { y: d.y || null, m: d.m || null, d: d.d || null };
    if (date.y) filled.push('出版日期');
    else { skipped.push('出版日期'); warnings.push('缺出版日期'); }

    const radioValue = bindingRadioValue(p.binding);
    const binding = { radioValue, otherText: radioValue === 'other' ? (p.bindingRaw || '') : '' };
    filled.push('装帧');
    if (radioValue === 'other') warnings.push(`装帧落「其他」：${p.bindingRaw || '?'}`);

    return { texts, author, textareas, date, binding, warnings, filled, skipped };
  }

  // ── node 测试导出（在 DOM 启动代码之前 return） ──────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      validateIsbn13, isbn10to13, splitTitle, parseDate, splitPublisherDate,
      normalizePrice, mapBinding, normalizeTitle, parsePageCount, isPayloadFresh,
      bindingRadioValue, buildFillPlan,
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

  /** 现代 "Rich Product Information" 卡片布局：值在 .rpi-attribute-value，必须用 textContent
   *  （轮播里离屏卡片 innerText 为空）。归一成与旧布局一致的 {label,value} 行。 */
  function rpiRows() {
    const map = [
      ['ISBN-13', 'isbn13'],
      ['ISBN-10', 'isbn10'],
      ['Publisher', 'publisher'],
      ['Publication date', 'publication_date'],
      ['Print length', 'fiona_pages'],
    ];
    const rows = [];
    for (const [label, key] of map) {
      const el = document.getElementById('rpi-attribute-book_details-' + key);
      const v = el && el.querySelector('.rpi-attribute-value');
      if (v) {
        const value = cleanLabel(v.textContent);
        if (value) rows.push({ label, value });
      }
    }
    return rows;
  }

  function detailValue(rows, labelRe) {
    const row = rows.find((r) => labelRe.test(r.label));
    return row ? row.value : '';
  }

  const BINDING_RE = /^(Hardcover|Paperback|Kindle Edition|Kindle|Board book|Mass Market Paperback|Audiobook|Spiral-bound|Library Binding)$/i;

  /** 当前版本的装帧：rpi 布局放在 #bylineInfo 的叶子节点；旧布局在 #productSubtitle。 */
  function extractBindingRaw() {
    const byline = document.querySelector('#bylineInfo');
    if (byline) {
      const n = [...byline.querySelectorAll('span, a')].find(
        (e) => e.children.length === 0 && BINDING_RE.test(e.textContent.trim())
      );
      if (n) return n.textContent.trim();
    }
    return firstText(['#productSubtitle', '#tmmSwatches .selected', '.swatchElement.selected']);
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
    const rows = [...amazonDetailRows(), ...rpiRows()];
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

    const pageRow = rows.find((r) => /\d+\s*pages/i.test(r.value) || /print length/i.test(r.label));

    const bindingRaw = extractBindingRaw();
    const binding = mapBinding(bindingRaw);

    // 仅取 buybox 当前版本价；不用通用 .a-offscreen（会抓到其他版本/Kindle 的最低价）。
    const price = normalizePrice(
      firstText([
        '#corePriceDisplay_desktop_feature_div span.a-price span.a-offscreen',
        '#corePrice_feature_div span.a-price span.a-offscreen',
        '#price_inside_buybox',
        '#tmmSwatches .a-button-selected .a-color-price',
      ])
    );

    const description = firstText(['#bookDescription_feature_div', '#bookDescription_expander']);
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
      pageCount: parsePageCount(pageRow ? pageRow.value : ''),
      binding,
      bindingRaw: cleanLabel(bindingRaw),
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
  // 豆瓣侧回填器（与来源无关）— 标签文本定位，不依赖 name/id
  // ============================================================

  function normLabel(s) {
    return String(s == null ? '' : s).replace(/\*/g, '').replace(/\s+/g, '').trim();
  }

  /** 在指定表单内按 label 文本找到所属 .item 容器。 */
  function fieldByLabel(root, labelText) {
    const want = normLabel(labelText);
    for (const label of root.querySelectorAll('label')) {
      if (normLabel(label.textContent) === want) return label.closest('.item');
    }
    return null;
  }

  function fireValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setTextByLabel(root, labelText, value) {
    const item = fieldByLabel(root, labelText);
    const el = item && item.querySelector('input.input_basic');
    if (!el) return false;
    fireValue(el, value);
    return true;
  }

  function setTextareaByLabel(root, labelText, value) {
    const item = fieldByLabel(root, labelText);
    const el = item && item.querySelector('textarea.textarea_basic');
    if (!el) return false;
    fireValue(el, value);
    return true;
  }

  function setSelect(sel, val) {
    sel.value = String(val);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 「日」下拉由豆瓣脚本在「月」change 后异步填充，轮询直到目标 option 出现。 */
  function pollDay(daySel, day, attempts) {
    if (day == null) return;
    const tick = (n) => {
      if ([...daySel.options].some((o) => o.value === String(day))) {
        setSelect(daySel, day);
        return;
      }
      if (n > 0) setTimeout(() => tick(n - 1), 60);
    };
    tick(attempts);
  }

  function setPubDate(root, date) {
    if (!date.y) return;
    const item = fieldByLabel(root, '出版日期');
    const sels = item ? item.querySelectorAll('select') : [];
    if (sels.length < 3) return;
    const [yearSel, monthSel, daySel] = sels;
    setSelect(yearSel, date.y);
    if (date.m) {
      setSelect(monthSel, date.m);
      pollDay(daySel, date.d, 20);
    }
  }

  function setBinding(root, binding) {
    const item = fieldByLabel(root, '装帧');
    if (!item) return;
    const radio = item.querySelector(`input[type="radio"][value="${binding.radioValue}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (binding.radioValue === 'other') {
      const other = item.querySelector('input.other');
      if (other) fireValue(other, binding.otherText);
    }
  }

  const SUMMARY_ID = 'dbb-summary';

  function injectBanner(root, innerHtml) {
    let bar = document.getElementById(SUMMARY_ID);
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.id = SUMMARY_ID;
    bar.style.cssText =
      'margin:0 0 14px;padding:12px 14px;border:1px solid #d6c79b;border-radius:8px;' +
      'background:#fcf9ef;font-size:13px;line-height:1.7;color:#333';
    bar.innerHTML = innerHtml;
    root.parentElement.insertBefore(bar, root);
  }

  function chips(items, color) {
    return items
      .map((t) => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:10px;background:${color};font-size:12px">${escapeHtml(t)}</span>`)
      .join('');
  }

  function injectSummary(root, plan) {
    const warn = plan.warnings.length
      ? `<div style="margin-top:8px;color:#b8500b">${plan.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br>')}</div>`
      : '';
    injectBanner(
      root,
      `<b>豆瓣图书桥 · 已回填</b>　<span style="color:#888">请核对后人工点「下一步」提交</span>` +
        `<div style="margin-top:8px">已填：${chips(plan.filled, '#dbefda')}</div>` +
        (plan.skipped.length ? `<div style="margin-top:4px;color:#999">跳过：${chips(plan.skipped, '#eee')}</div>` : '') +
        warn
    );
  }

  function highlightSubmit(root) {
    const btn = root.querySelector('input[type="submit"]');
    if (btn) btn.style.boxShadow = '0 0 0 3px rgba(46,125,50,.6)';
  }

  function fillStep1(root, payload) {
    const item = fieldByLabel(root, 'ISBN');
    const el = item && item.querySelector('input.input_basic');
    if (el && payload.isbn13) fireValue(el, payload.isbn13);
    highlightSubmit(root);
    injectBanner(root, `<b>豆瓣图书桥</b>　已填 ISBN <code>${escapeHtml(payload.isbn13 || '')}</code> — 请点「下一步」（豆瓣将做服务端查重）。`);
  }

  function formIsbnDigits(root) {
    const uid = root.querySelector('input[name="p_uid"]');
    const val = uid ? uid.value : (fieldByLabel(root, 'ISBN')?.querySelector('input')?.value || '');
    return String(val).replace(/[^0-9]/g, '');
  }

  function fillStep2(root, payload) {
    const formIsbn = formIsbnDigits(root);
    if (formIsbn && payload.isbn13 && formIsbn !== payload.isbn13) {
      injectBanner(root, `<b style="color:#c0392b">未自动回填</b>：表单 ISBN（${escapeHtml(formIsbn)}）与 Amazon 抓取的（${escapeHtml(payload.isbn13)}）不一致，疑似不同书。请手动核对。`);
      return; // 不动表单、不消费 payload
    }

    const plan = buildFillPlan(payload);
    for (const t of plan.texts) setTextByLabel(root, t.label, t.value);
    if (plan.author) setTextByLabel(root, '作者', plan.author);
    for (const a of plan.textareas) setTextareaByLabel(root, a.label, a.value);
    setBinding(root, plan.binding);
    setPubDate(root, plan.date);
    injectSummary(root, plan);
    highlightSubmit(root);

    GM_deleteValue(STORAGE_KEY); // 消费即删
  }

  function runDouban() {
    const form = document.querySelector('form.detail_form');
    if (!form) return;

    let payload = null;
    const raw = GM_getValue(STORAGE_KEY);
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (isPayloadFresh(p, Date.now(), TTL_MS)) payload = p;
        else GM_deleteValue(STORAGE_KEY);
      } catch { /* 损坏即忽略 */ }
    }
    if (!payload) return; // 无有效 payload：用户可能在正常手动添加，什么都不做

    if (fieldByLabel(form, '副标题')) fillStep2(form, payload);
    else fillStep1(form, payload);
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
