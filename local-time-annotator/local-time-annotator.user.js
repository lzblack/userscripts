// ==UserScript==
// @name         Local Time Annotator
// @namespace    https://github.com/lzblack/userscripts
// @version      0.1.0
// @description  Append local time after unambiguous absolute times on any page (e.g. "14:42 UTC" -> " (10:42 AM EDT)").
// @author       Zhi
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─── pure core (headlessly testable) ──────────────────────────────────────

  // Zero-ambiguity offset marker: Z | UTC/GMT(±offset) | bare ±HH:MM / ±HHMM.
  const OFFSET_MARKER =
    '(Z|UTC(?:\\s*[+-]\\s*\\d{1,2}(?::?\\d{2})?)?|GMT(?:\\s*[+-]\\s*\\d{1,2}(?::?\\d{2})?)?|[+-]\\d{2}:?\\d{2})';
  // Time (24/12h, optional seconds, optional AM/PM) immediately adjacent to a marker.
  const TIME_RE = new RegExp(
    '\\b(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\s*(AM|PM))?\\s*' + OFFSET_MARKER + '(?![\\w])',
    'gi'
  );
  // Cheap pre-test gate: a safe SUPERSET of TIME_RE markers (no false negatives).
  // Zulu "Z" attaches directly to digits ("19:00Z"), so it has no left word boundary —
  // match a digit immediately followed by Z rather than a bounded \bZ\b.
  const QUICK_RE = /UTC|GMT|[+-]\d{2}:?\d{2}|\dZ/i;

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const MDY_RE = new RegExp('\\b' + MONTH + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'i');
  const DMY_RE = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH + '\\.?\\s+(\\d{4})\\b', 'i');


  /**
   * Parse an unambiguous timezone token into minutes east of UTC.
   * Accepts: Z, UTC, GMT (= 0); UTC±N / GMT±N with optional :MM; bare ±HH:MM / ±HHMM.
   * Returns null for anything ambiguous or unrecognised (e.g. named abbreviations).
   * @param {string} token
   * @returns {number|null}
   */
  function parseOffsetMinutes(token) {
    if (typeof token !== 'string') return null;
    const t = token.trim();
    if (/^(Z|UTC|GMT)$/i.test(t)) return 0;

    let m = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(t);
    if (!m) m = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(t);
    if (!m) return null;

    const sign = m[1] === '-' ? -1 : 1;
    const hh = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    if (mm >= 60) return null;
    const total = sign * (hh * 60 + mm);
    if (total < -720 || total > 840) return null; // real-world range: UTC-12 .. UTC+14
    return total;
  }

  /**
   * Extract a calendar date from free text (ISO YYYY-MM-DD or "Month D, YYYY").
   * @param {string} text
   * @returns {{y:number,mo:number,d:number}|null} mo is 0-based
   */
  function extractDate(text) {
    let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    if (m) return { y: +m[1], mo: +m[2] - 1, d: +m[3] };

    m = MDY_RE.exec(text);
    if (m) return { y: +m[3], mo: MONTHS[m[1].slice(0, 3).toLowerCase()], d: +m[2] };

    m = DMY_RE.exec(text);
    if (m) return { y: +m[3], mo: MONTHS[m[2].slice(0, 3).toLowerCase()], d: +m[1] };

    return null;
  }

  /**
   * Plan non-destructive annotations for one text node's content.
   * Returns an ordered segment list (matched times isolated so each annot is the
   * matched node's nextSibling), or null when nothing should be annotated.
   * @param {string} nodeText
   * @param {{y:number,mo:number,d:number}} dateCtx
   * @param {string} zone
   * @param {string} locale
   * @returns {Array<{type:'text'|'annot',value:string}>|null}
   */
  function planAnnotations(nodeText, dateCtx, zone, locale, skipSameOffset) {
    const matches = findTimeMatches(nodeText);
    if (matches.length === 0) return null;

    const segs = [];
    let cursor = 0;
    let annotated = false;
    for (const mt of matches) {
      const before = nodeText.slice(cursor, mt.index);
      if (before) segs.push({ type: 'text', value: before });
      segs.push({ type: 'text', value: nodeText.slice(mt.index, mt.index + mt.length) });

      const r = convert(
        { y: dateCtx.y, mo: dateCtx.mo, d: dateCtx.d, h: mt.h, m: mt.m, s: mt.s, srcOffsetMin: mt.srcOffsetMin },
        zone,
        locale
      );
      if (!(r.skip && skipSameOffset !== false)) {
        segs.push({ type: 'annot', value: ' (' + r.text + ')' });
        annotated = true;
      }
      cursor = mt.index + mt.length;
    }
    const tail = nodeText.slice(cursor);
    if (tail) segs.push({ type: 'text', value: tail });

    return annotated ? segs : null;
  }

  /**
   * Annotations to append at the END of an inline container whose timestamp is split
   * across child nodes (Tier 2b). Returns the annotation strings (e.g. " (4:45 AM EDT)")
   * in document order; empty array when nothing should be appended.
   * @param {string} text  assembled container text (excluding existing .lt-annot output)
   * @param {{y:number,mo:number,d:number}} dateCtx
   * @param {string} zone
   * @param {string} locale
   * @param {boolean} [skipSameOffset]
   * @returns {string[]}
   */
  function containerAnnots(text, dateCtx, zone, locale, skipSameOffset) {
    const out = [];
    for (const mt of findTimeMatches(text)) {
      const r = convert(
        { y: dateCtx.y, mo: dateCtx.mo, d: dateCtx.d, h: mt.h, m: mt.m, s: mt.s, srcOffsetMin: mt.srcOffsetMin },
        zone,
        locale
      );
      if (!(r.skip && skipSameOffset !== false)) out.push(' (' + r.text + ')');
    }
    return out;
  }

  /**
   * Scan free text for unambiguous absolute times (Tier 2).
   * A match REQUIRES the time to be immediately adjacent (whitespace only) to a
   * zero-ambiguity offset marker: Z / UTC / GMT (with optional ±offset) or a bare
   * numeric ±HH:MM / ±HHMM. Named abbreviations are never matched.
   * @param {string} text
   * @returns {Array<{index:number,length:number,h:number,m:number,s:number,srcOffsetMin:number}>}
   */
  function findTimeMatches(text) {
    const out = [];
    TIME_RE.lastIndex = 0;
    let m;
    while ((m = TIME_RE.exec(text)) !== null) {
      const ampm = m[4] ? m[4].toUpperCase() : null;
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const s = m[3] ? parseInt(m[3], 10) : 0;

      const hourValid = ampm ? h >= 1 && h <= 12 : h >= 0 && h <= 23;
      if (!hourValid || min > 59 || s > 59) continue;

      if (ampm === 'PM' && h < 12) h += 12;
      else if (ampm === 'AM' && h === 12) h = 0;

      const srcOffsetMin = parseOffsetMinutes(m[5]);
      if (srcOffsetMin === null) continue;

      out.push({ index: m.index, length: m[0].length, h, m: min, s, srcOffsetMin });
    }
    return out;
  }

  /**
   * Local UTC offset (minutes east) for a given instant in a given IANA zone.
   * @param {Date} instant
   * @param {string} zone
   * @returns {number}
   */
  function localOffsetMinutes(instant, zone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(instant);
    const tn = parts.find((p) => p.type === 'timeZoneName').value; // "GMT-04:00" | "GMT"
    const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(tn);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }

  /**
   * Format an instant in the local zone as e.g. "10:42 AM EDT".
   * @param {Date} instant
   * @param {string} zone
   * @param {string} locale
   * @returns {string}
   */
  function formatLocal(instant, zone, locale) {
    return new Intl.DateTimeFormat(locale || 'en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(instant);
  }

  /**
   * Convert parsed time components to a local-time annotation.
   * @param {{y:number,mo:number,d:number,h:number,m:number,s:number,srcOffsetMin:number}} parts
   * @param {string} localZone
   * @param {string} locale
   * @returns {{instant:Date, text:string, skip:boolean}}
   */
  function convert(parts, localZone, locale) {
    const { y, mo, d, h, m, s, srcOffsetMin } = parts;
    const instant = new Date(Date.UTC(y, mo, d, h, m, s) - srcOffsetMin * 60000);
    const skip = localOffsetMinutes(instant, localZone) === srcOffsetMin;
    const text = formatLocal(instant, localZone, locale);
    return { instant, text, skip };
  }

  // ─── node test export ─────────────────────────────────────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      QUICK_RE,
      parseOffsetMinutes,
      findTimeMatches,
      extractDate,
      planAnnotations,
      containerAnnots,
      localOffsetMinutes,
      formatLocal,
      convert,
    };
    return;
  }

  // ─── config (module-level constants; no UI) ────────────────────────────────
  // null = browser auto-detect. globalThis.__LTA_ZONE__ is a fixture-only seam to force
  // a zone for deterministic, machine-TZ-independent acceptance tests.
  const LOCAL_ZONE = (typeof globalThis !== 'undefined' && globalThis.__LTA_ZONE__) || null;
  const OUTPUT_LOCALE = 'en-US'; // matches the AM/PM output style
  const ANNOT_CLASS = 'lt-annot'; // render class + idempotency marker
  const SKIP_IF_SAME_OFFSET = true;
  const DEBOUNCE_MS = 300;

  const ZONE = LOCAL_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);

  // ─── formatters / shared instances (cached once, never per-match) ───────────
  const TODAY_FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  function todayInZone() {
    const [y, mo, d] = TODAY_FMT.format(new Date()).split('-').map(Number);
    return { y, mo: mo - 1, d };
  }

  function isSkippableAncestor(node) {
    for (let el = node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      if (el.classList && el.classList.contains(ANNOT_CLASS)) return true;
    }
    return false;
  }

  const BLOCK_SELECTOR =
    'address,article,aside,blockquote,details,dialog,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,table,ul';

  // An element safe to append a trailing annotation to: holds only inline content
  // (no block-level descendant), so the appended span reads as part of the same line.
  function isInlineLeaf(el) {
    return !el.querySelector(BLOCK_SELECTOR);
  }

  // Assembled text of an element, EXCLUDING our own .lt-annot output — so a re-matchable
  // annotation (e.g. "GMT+8") can never feed back into matching.
  function liveText(el) {
    let s = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1 && !c.classList.contains(ANNOT_CLASS)) s += liveText(c);
    }
    return s;
  }

  function makeAnnot(value) {
    const span = document.createElement('span');
    span.className = ANNOT_CLASS;
    span.textContent = value;
    span.style.cssText = 'opacity:.6;font-size:.85em;';
    return span;
  }

  // ─── Tier 1: <time datetime> ────────────────────────────────────────────────
  function annotateTimeElements(root) {
    const els = root.querySelectorAll
      ? root.querySelectorAll('time[datetime]:not([data-lt-done])')
      : [];
    for (const el of els) {
      if (isSkippableAncestor(el)) continue;
      const instant = new Date(el.getAttribute('datetime'));
      if (isNaN(instant.getTime())) continue;
      el.dataset.ltDone = '1';
      el.after(makeAnnot(' (' + formatLocal(instant, ZONE, OUTPUT_LOCALE) + ')'));
    }
  }

  // ─── Tier 2: free-text scan over text nodes ─────────────────────────────────
  function annotateTextNodes(root) {
    const rootText = root.textContent || '';
    if (!QUICK_RE.test(rootText)) return; // §5 cheap early-exit: skip the walk entirely

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data || !QUICK_RE.test(node.data)) return NodeFilter.FILTER_REJECT;
        if (isSkippableAncestor(node)) return NodeFilter.FILTER_REJECT;
        const sib = node.nextSibling;
        if (sib && sib.nodeType === 1 && sib.classList.contains(ANNOT_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Pass split: in-node matches (Tier 2a) vs. marker-bearing fragments whose
    // timestamp is assembled across sibling nodes (Tier 2b candidates).
    const inNode = []; // { node, plan }
    const inNodeParents = new Set();
    const containers = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const dateCtx = extractDate(n.data) || todayInZone();
      const plan = planAnnotations(n.data, dateCtx, ZONE, OUTPUT_LOCALE, SKIP_IF_SAME_OFFSET);
      if (plan) {
        inNode.push({ node: n, plan });
        if (n.parentElement) inNodeParents.add(n.parentElement);
      } else if (n.parentElement) {
        containers.add(n.parentElement);
      }
    }

    // Tier 2a: replace each in-node text node with its planned fragment.
    for (const { node, plan } of inNode) {
      const frag = document.createDocumentFragment();
      for (const seg of plan) {
        frag.appendChild(seg.type === 'annot' ? makeAnnot(seg.value) : document.createTextNode(seg.value));
      }
      node.replaceWith(frag);
    }

    // Tier 2b: for eligible containers, append local-time annotation(s) at the end.
    for (const C of containers) {
      if (!(C instanceof HTMLElement) || C.dataset.ltDone) continue;
      if (inNodeParents.has(C) || !isInlineLeaf(C) || isSkippableAncestor(C)) continue;
      const text = liveText(C);
      const dateCtx = extractDate(text) || todayInZone();
      const annots = containerAnnots(text, dateCtx, ZONE, OUTPUT_LOCALE, SKIP_IF_SAME_OFFSET);
      C.dataset.ltDone = '1';
      for (const a of annots) C.appendChild(makeAnnot(a));
    }
  }

  function annotateRoot(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    annotateTimeElements(root);
    annotateTextNodes(root);
  }

  // ─── scoped, debounced MutationObserver ─────────────────────────────────────
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) pending.add(node);
        else if (node.nodeType === 3 && node.parentNode) pending.add(node.parentNode);
      }
    }
    schedule();
  });

  const pending = new Set();
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      flush();
    };
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: DEBOUNCE_MS });
    else setTimeout(run, DEBOUNCE_MS);
  }

  function flush() {
    if (pending.size === 0) return;
    const roots = [...pending];
    pending.clear();
    observer.disconnect(); // write isolation: our own mutations must not re-trigger us
    try {
      for (const root of roots) {
        if (root.isConnected) annotateRoot(root);
      }
    } finally {
      connect();
    }
  }

  function connect() {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── boot ───────────────────────────────────────────────────────────────────
  annotateRoot(document.body); // initial pass before the observer is live (no self-trigger)
  connect();
})();
