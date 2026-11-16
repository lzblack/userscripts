// ==UserScript==
// @name         X.com Draggable Tweets
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.1.0
// @author       lzblack
// @description  Make entire tweet cards draggable as real links (works with Glitter Drag)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @icon64       https://abs.twimg.com/responsive-web/client-web/icon-ios.77d25eba.png
// @grant        none
// @license      MIT
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/x-draggable-tweets/x-draggable-tweets.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/x-draggable-tweets/x-draggable-tweets.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ── Pure logic ──────────────────────────────────────────────────────────────

  // /{user}/status/{id}[/anything] or /i/web/status/{id}
  const STATUS_PATH = /^\/(?:([A-Za-z0-9_]{1,15})|i\/web)\/status\/(\d+)(?:\/|$)/;
  const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/;

  // Any status-ish href → { id, url } with url = canonical tweet URL on the
  // page's origin (no /analytics, /photo/1, query or hash). null if not a tweet.
  function parseStatus(href, base) {
    if (typeof href !== "string" || !href) return null;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      return null;
    }
    if (!X_HOSTS.test(u.hostname)) return null;
    const m = u.pathname.match(STATUS_PATH);
    if (!m) return null;
    const path = m[1] ? `/${m[1]}/status/${m[2]}` : `/i/web/status/${m[2]}`;
    return { id: m[2], url: new URL(base).origin + path };
  }

  // First candidate that is a tweet whose id is not excluded.
  function pickStatusUrl(candidates, excludeIds, base) {
    for (const c of candidates) {
      const s = parseStatus(c, base);
      if (s && !excludeIds.includes(s.id)) return s.url;
    }
    return null;
  }

  // Ctrl/Meta/Shift-click and non-left buttons stay on the overlay <a>, so the
  // browser opens the tweet in a new tab/window natively. Alt is forwarded:
  // alt+click on a native link downloads it.
  function shouldForwardClick(e) {
    return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseStatus, pickStatusUrl, shouldForwardClick };
    return;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  // Hovering any of these keeps the overlay off, so X (or the browser) handles
  // them natively. tweetText is here so tweet text stays selectable.
  const PASSTHROUGH =
    'a, button, [role="button"], [role="link"], input, textarea, video, ' +
    '[data-testid="tweetText"], [data-testid="tweetPhoto"]';

  // A quote card is a div[role=link] that renders a tweet.
  const QUOTE_CARD = 'div[role="link"]';
  const QUOTE_MARK = '[data-testid="Tweet-User-Avatar"], [data-testid="tweetText"]';

  const base = () => location.origin;
  const pageStatusId = () => {
    const s = parseStatus(location.pathname, base());
    return s ? s.id : null;
  };

  // A tweet's own link is the <a> around its <time>.
  function articleUrl(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const s = time && parseStatus(time.closest("a").getAttribute("href"), base());
    return s ? s.url : null;
  }

  // Quote cards contain no status <a>; their target lives in React props.
  // Collect every status-ish string up the fiber chain; callers exclude the
  // outer tweet's id so the walk cannot resolve to it.
  function fiberCandidates(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    const out = [];
    let fiber = key ? el[key] : null;
    for (let i = 0; i < 30 && fiber; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (!p || typeof p !== "object") continue;
      for (const prop of ["href", "to", "link"]) {
        const v = p[prop];
        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object" && typeof v.pathname === "string") out.push(v.pathname);
      }
    }
    return out;
  }

  function quoteUrl(card, excludeIds) {
    return pickStatusUrl(fiberCandidates(card), excludeIds, base());
  }

  function idOf(url) {
    const s = parseStatus(url, base());
    return s ? s.id : null;
  }

  // Resolved fresh on hover and on dragstart: X recycles DOM nodes.
  function resolveUrl(target) {
    if (target.tagName === "ARTICLE") return articleUrl(target);
    const article = target.closest("article");
    const outer = article && articleUrl(article);
    return quoteUrl(target, [idOf(outer), pageStatusId()].filter(Boolean));
  }

  let decorated = new WeakSet();

  function addOverlay(target, url) {
    decorated.add(target);
    target.dataset.xDragTarget = "1";
    if (getComputedStyle(target).position === "static") target.style.position = "relative";

    const overlay = document.createElement("a");
    overlay.href = url;
    overlay.draggable = true;
    overlay.className = "x-drag-overlay";
    overlay.style.cssText = "position:absolute;inset:0;z-index:1;opacity:0;pointer-events:none;";

    // X never sees clicks on the overlay itself: its root handler would
    // preventDefault them and navigate in place. Modifier and middle clicks
    // then fall through to the browser's own link handling (new tab/window).
    overlay.addEventListener("auxclick", (e) => e.stopPropagation());
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!shouldForwardClick(e)) return;
      e.preventDefault();
      overlay.style.pointerEvents = "none";
      const below = document.elementFromPoint(e.clientX, e.clientY);
      if (!below) return;
      below.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          detail: e.detail,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          altKey: e.altKey,
          button: 0,
          buttons: e.buttons,
        }),
      );
    });

    overlay.addEventListener("dragstart", () => {
      const fresh = resolveUrl(target);
      if (fresh) overlay.href = fresh;
    });

    target.appendChild(overlay);
  }

  function process() {
    const pageId = pageStatusId();
    for (const article of document.querySelectorAll("article")) {
      const url = articleUrl(article);
      if (!url) continue; // not rendered yet; retried on the next mutation

      // The focal tweet on its own status page is not draggable itself.
      if (!decorated.has(article) && idOf(url) !== pageId) addOverlay(article, url);

      for (const card of article.querySelectorAll(QUOTE_CARD)) {
        if (decorated.has(card) || !card.querySelector(QUOTE_MARK)) continue;
        if (card.closest("article") !== article) continue; // belongs to a nested article
        const q = quoteUrl(card, [idOf(url), pageId].filter(Boolean));
        if (q) addOverlay(card, q);
      }
    }
  }

  function reset() {
    document.querySelectorAll(".x-drag-overlay").forEach((el) => el.remove());
    document.querySelectorAll("[data-x-drag-target]").forEach((el) => delete el.dataset.xDragTarget);
    decorated = new WeakSet();
  }

  // ── Overlay activation: one global mousemove, at most once per frame ────────

  let moveRaf = 0;
  let active = null;

  document.addEventListener(
    "mousemove",
    (e) => {
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (active) active.style.pointerEvents = "none";
        active = null;

        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el && el.closest("[data-x-drag-target]");
        if (!target) return;
        const overlay = target.querySelector(":scope > .x-drag-overlay");
        if (!overlay) return;

        // Over something X handles itself (or tweet text) → leave it native.
        const pass = el.closest(PASSTHROUGH);
        if (pass && pass !== target && target.contains(pass)) return;

        const fresh = resolveUrl(target);
        if (fresh) overlay.href = fresh;
        overlay.style.pointerEvents = "";
        active = overlay;
      });
    },
    true,
  );

  // ── SPA navigation + lazy rendering, coalesced to one pass per frame ────────

  let lastPath = location.pathname;
  let scanRaf = 0;
  new MutationObserver(() => {
    if (scanRaf) return;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        reset();
      }
      process();
    });
  }).observe(document.body, { childList: true, subtree: true });

  process();
})();
