// ==UserScript==
// @name         豆瓣移动版转桌面版
// @namespace    https://github.com/lzblack/userscripts
// @homepageURL  https://github.com/lzblack/userscripts
// @version      0.1.0
// @author       lzblack
// @description  把 Google 搜索结果里的豆瓣移动版链接直接改成桌面版；误入服务器不会自动跳转的移动版页面时补一次跳转
// @include      /^https:\/\/(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?\/search/
// @match        *://m.douban.com/*
// @icon         https://img3.doubanio.com/favicon.ico
// @run-at       document-start
// @grant        none
// @license      MIT
// @supportURL   https://github.com/lzblack/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-mobile-to-desktop/douban-mobile-to-desktop.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-mobile-to-desktop/douban-mobile-to-desktop.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ── 纯逻辑：m.douban.com URL → 桌面版 URL（不认识的一律返回 null，不猜） ──

  // 按顺序匹配第一条，原查询串和锚点保留。
  // 2026-11 用桌面 UA 实测：条目、短评长评、影评、小组首页、游戏这些服务器本来就会 302 回桌面版，
  // 映射它们只为在 Google 上省一跳；人物、用户主页、搜索、首页服务器不跳，靠这里补。
  // 不能一刀切换成 www 同路径：www 上游戏条目、移动版独有页、用户主页子页都是 404，搜索参数名也不同。
  const DOUBAN_RULES = [
    // 书影音条目及其子页（comments、reviews、annotation…路径与桌面版一致）
    [/^\/(movie|book|music)\/subject\/(\d+)(\/.*)?$/, (m) => `https://${m[1]}.douban.com/subject/${m[2]}${m[3] || '/'}`],
    // 游戏没有自己的子域，住在 www.douban.com/game/{id}/
    [/^\/game\/subject\/(\d+)(\/.*)?$/, (m) => `https://www.douban.com/game/${m[1]}${m[2] || '/'}`],
    [/^\/(movie|book|music)\/review\/(\d+)(\/.*)?$/, (m) => `https://${m[1]}.douban.com/review/${m[2]}${m[3] || '/'}`],
    // 旧影人链接：服务器会把它跳到「移动版」人物页；movie.douban.com/celebrity/{id}/ 则跳到 www 的 personage
    [/^\/movie\/celebrity\/(\d+)\/?$/, (m) => `https://movie.douban.com/celebrity/${m[1]}/`],
    [/^\/personage\/(\d+)\/?$/, (m) => `https://www.douban.com/personage/${m[1]}/`],
    // 用户主页只映射根页：移动版子页和桌面版结构不同，不猜
    [/^\/people\/([^/]+)\/?$/, (m) => `https://www.douban.com/people/${m[1]}/`],
    [/^\/(group|note|doulist)\/(.+)$/, (m) => `https://www.douban.com/${m[1]}/${m[2]}`],
    [/^\/?$/, () => 'https://www.douban.com/'],
    [/^\/(movie|book|music)\/?$/, (m) => `https://${m[1]}.douban.com/`],
  ];

  function parseUrl(href) {
    try {
      const u = new URL(href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  }

  function toDesktop(href) {
    const u = parseUrl(href);
    if (!u || u.hostname !== 'm.douban.com') return null;
    // 搜索：移动版用 query，桌面版用 q；type 与桌面版的分类码不是一一对应，丢掉
    if (/^\/search\/?$/.test(u.pathname)) {
      const q = u.searchParams.get('query');
      return q ? `https://www.douban.com/search?${new URLSearchParams({ q })}` : null;
    }
    for (const [re, build] of DOUBAN_RULES) {
      const m = u.pathname.match(re);
      if (m) return build(m) + u.search + u.hash;
    }
    return null;
  }

  // Google 有时把结果包成 /url?q=… 或 /url?url=…，拆出真正的目标
  function unwrapGoogle(href) {
    const u = parseUrl(href);
    if (!u || !/(^|\.)google\.[a-z.]+$/.test(u.hostname) || u.pathname !== '/url') return null;
    const target = u.searchParams.get('q') || u.searchParams.get('url');
    return target && parseUrl(target) ? target : null;
  }

  // 返回应写回 href 的桌面版直链；不需要改时返回 null
  function rewriteHref(href) {
    return toDesktop(unwrapGoogle(href) || href);
  }

  // ── node 测试导出（在任何 DOM/location 调用之前 return） ──────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { toDesktop, unwrapGoogle, rewriteHref };
    return;
  }

  // ── 移动版页面：补跳转 ────────────────────────────────────────────────────

  // 防循环：若桌面版又把我们送回同一个移动版（例如浏览器用的是手机 UA），
  // 10 秒内第二次跳向同一目标就停下，留在移动版。
  const LOOP_KEY = 'dm2d:last';
  const LOOP_WINDOW_MS = 10000;

  function redirectFromMobile() {
    const target = toDesktop(location.href);
    if (!target) return;
    try {
      const last = JSON.parse(sessionStorage.getItem(LOOP_KEY) || 'null');
      if (last && last.to === target && Date.now() - last.t < LOOP_WINDOW_MS) return;
      sessionStorage.setItem(LOOP_KEY, JSON.stringify({ to: target, t: Date.now() }));
    } catch {
      // sessionStorage 不可用时没法防循环，宁可不跳
      return;
    }
    location.replace(target);
  }

  // ── Google 结果页：改写链接 ───────────────────────────────────────────────

  function fixAnchor(a) {
    const next = rewriteHref(a.href);
    if (next) a.href = next;
  }

  function scan(root) {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.matches?.('a[href]')) fixAnchor(root);
    root.querySelectorAll('a[href]').forEach(fixAnchor);
  }

  function rewriteGoogleResults() {
    scan(document);
    // 结果是陆续插入的（含无限滚动）；改写 href 会再触发一次 attributes 变动，
    // 但那时已是桌面版链接，rewriteHref 返回 null，不会循环
    new MutationObserver((mutations) => {
      for (const mu of mutations) {
        if (mu.type === 'attributes') fixAnchor(mu.target);
        else mu.addedNodes.forEach(scan);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  // ── 入口 ──────────────────────────────────────────────────────────────────

  if (location.hostname === 'm.douban.com') redirectFromMobile();
  else rewriteGoogleResults();
})();
