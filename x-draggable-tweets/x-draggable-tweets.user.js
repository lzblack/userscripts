// ==UserScript==
// @name         X.com Draggable Tweets
// @namespace    https://github.com/lzblack
// @version      1.0.1
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

  const INTERACTIVE =
    'a, button, [role="button"], [role="link"], input, textarea, video, ' +
    '[data-testid="like"], [data-testid="retweet"], [data-testid="reply"], ' +
    '[data-testid="bookmark"], [data-testid="caret"], [data-testid="tweetPhoto"]';

  function getStatusKey(url) {
    const m = url.match(/\/([^/]+)\/status\/(\d+)/);
    return m ? m[1] + "/status/" + m[2] : null;
  }

  // Primary: extract URL from <a href="/user/status/id"> inside the element
  function getTweetURL(el) {
    const timeLink = el.querySelector('a[href*="/status/"] time');
    if (timeLink) return timeLink.closest("a").href;
    const link = el.querySelector('a[href*="/status/"]');
    return link ? link.href : null;
  }

  // Fallback: extract URL from React fiber (for div[role="link"] quote cards)
  function getURLFromFiber(el) {
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith("__reactFiber$") ||
        k.startsWith("__reactInternalInstance$"),
    );
    if (!key) return null;
    let fiber = el[key];
    for (let i = 0; i < 30 && fiber; i++) {
      const p = fiber.memoizedProps || fiber.pendingProps;
      if (p) {
        for (const prop of ["href", "to"]) {
          if (typeof p[prop] === "string" && p[prop].includes("/status/")) {
            return new URL(p[prop], location.origin).href;
          }
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function addOverlay(target, url) {
    if (target.dataset.xDragTarget) return;
    target.dataset.xDragTarget = "1";

    const cs = getComputedStyle(target);
    if (cs.position === "static") target.style.position = "relative";

    const overlay = document.createElement("a");
    overlay.href = url;
    overlay.draggable = true;
    overlay.className = "x-drag-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;z-index:1;opacity:0;pointer-events:none;";

    overlay.addEventListener("click", (e) => {
      e.preventDefault();
      overlay.style.pointerEvents = "none";
      const below = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = "";
      if (below) below.click();
    });

    overlay.addEventListener("dragstart", () => {
      const fresh = getTweetURL(target) || getURLFromFiber(target);
      if (fresh) overlay.href = fresh;
    });

    target.appendChild(overlay);
  }

  function process() {
    const pageKey = getStatusKey(location.pathname);

    document.querySelectorAll("article").forEach((article) => {
      if (article.dataset.xDrag) return;
      article.dataset.xDrag = "1";

      const url = getTweetURL(article);
      if (!url) return;

      const isFocal = pageKey && getStatusKey(url) === pageKey;

      if (!isFocal) {
        // Timeline tweet or reply -- whole article is draggable
        addOverlay(article, url);
      } else {
        // Focal tweet: find quoted tweet cards inside
        // They are div[role="link"] containing tweet content
        article.querySelectorAll('div[role="link"]').forEach((card) => {
          if (card.dataset.xDragTarget) return;
          // Must contain tweet-like content (avatar or tweet text)
          if (
            !card.querySelector(
              '[data-testid="Tweet-User-Avatar"], [data-testid="tweetText"]',
            )
          )
            return;
          const cardURL = getTweetURL(card) || getURLFromFiber(card);
          if (!cardURL) return;
          // Must point to a different tweet
          const cardKey = getStatusKey(cardURL);
          if (cardKey && cardKey !== pageKey) {
            addOverlay(card, cardURL);
          }
        });
      }
    });
  }

  function cleanup() {
    document.querySelectorAll(".x-drag-overlay").forEach((el) => el.remove());
    document
      .querySelectorAll("[data-x-drag]")
      .forEach((el) => delete el.dataset.xDrag);
    document
      .querySelectorAll("[data-x-drag-target]")
      .forEach((el) => delete el.dataset.xDragTarget);
  }

  // Single global mousemove -- toggle overlay pointer-events
  let raf = 0;
  let activeOverlay = null;

  document.addEventListener(
    "mousemove",
    (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;

        if (activeOverlay) {
          activeOverlay.style.pointerEvents = "none";
          activeOverlay = null;
        }

        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;

        const target = el.closest("[data-x-drag-target]");
        if (!target) return;

        const overlay = target.querySelector(":scope > .x-drag-overlay");
        if (!overlay) return;

        // Over interactive element (that isn't the target itself) -> keep overlay off
        const inter = el.closest(INTERACTIVE);
        if (inter && inter !== target && target.contains(inter)) return;

        overlay.style.pointerEvents = "";
        activeOverlay = overlay;
      });
    },
    true,
  );

  // SPA navigation
  let lastPath = location.pathname;
  const observer = new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cleanup();
    }
    process();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  process();
})();
