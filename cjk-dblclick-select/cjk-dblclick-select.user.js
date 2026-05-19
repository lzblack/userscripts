// ==UserScript==
// @name         双击选中文短语 | CJK Double-Click Phrase Select (Firefox)
// @name:zh-CN   双击选中文短语（Firefox）
// @name:en      CJK Double-Click Phrase Select (Firefox)
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      0.1.0
// @author       lzblack
// @description        Restore the pre-ICU4X Firefox double-click behavior for CJK text: double-clicking a Han character selects the contiguous run of CJK ideographs up to the nearest non-CJK boundary (punctuation, space, letters, etc.), instead of just one character. Firefox only — Chrome / Edge / Safari keep their native word-level selection.
// @description:zh-CN  恢复 Firefox 双击中文的旧行为：双击汉字时选中"连续整段汉字"，直到下一个非汉字边界（标点、空格、字母等）为止。修复 ICU4X 引入的"双击只选单字"回归。仅 Firefox 生效，Chrome / Edge / Safari 保留原生分词。
// @description:en     Restore the pre-ICU4X Firefox double-click behavior for CJK text: double-clicking a Han character selects the contiguous run of CJK ideographs up to the nearest non-CJK boundary (punctuation, space, letters, etc.), instead of just one character. Firefox only — Chrome / Edge / Safari keep their native word-level selection.
// @match        *://*/*
// @run-at       document-end
// @all-frames   true
// @grant        none
// @license      MIT
// @supportURL   https://github.com/lzblack/userscripts/issues
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/cjk-dblclick-select/cjk-dblclick-select.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/cjk-dblclick-select/cjk-dblclick-select.user.js
// ==/UserScript==

/*
 * What & why
 * ----------
 * Pre-ICU4X Firefox treated a double-click on a CJK character as "select the
 * contiguous run of CJK characters up to the nearest punctuation/space". ICU4X
 * replaced that with per-character selection (a single ideograph). This script
 * restores the old behavior: when a dblclick's default selection contains any
 * CJK ideograph, expand the selection outward to the maximal run of contiguous
 * CJK ideographs around the cursor.
 *
 * Upstream bug: https://bugzilla.mozilla.org/show_bug.cgi?id=2040746
 * (uninstall this script once that bug is fixed upstream)
 *
 * Manual test cases (each is one <p> in an HTML document; click target shown):
 *
 *   <p>今天天气很好我们一起去公园吧</p>            click any char  → 今天天气很好我们一起去公园吧
 *   <p>今天天气很好，我们一起去公园吧。</p>        click 好         → 今天天气很好
 *   <p>今天天气很好，我们一起去公园吧。</p>        click 园         → 我们一起去公园吧
 *   <p>Today 今天 is 晴天 weather</p>             click 今         → 今天
 *   <p>价格是 100 元整</p>                         click 元         → 元整
 *   <p>The quick brown fox</p>                    click quick      → quick (no CJK, untouched)
 *   <input value="今天天气">                       click 天         → native (form control, skipped)
 *   <p><span>今天</span><span>天气很好</span></p>  click 好         → 今天天气很好 (crosses spans)
 *   <p>今天<div>新段落</div>剩余</p>               click 余         → 剩余 (stops at nested block)
 */

(function () {
    "use strict";

    // Firefox-only: Chrome/Edge/Safari use ICU BreakIterator which gives
    // reasonable CJK word-level selection; only Firefox post-ICU4X regressed
    // to single-char selection, and only Firefox is what this script fixes.
    if (!navigator.userAgent.includes("Firefox")) return;

    // Anything outside these ranges is a boundary. CJK punctuation (，。「」),
    // full-width digits, ASCII, whitespace — all live OUTSIDE these ranges,
    // so they naturally act as boundaries without a hand-maintained list.
    function isCJKCodePoint(cp) {
        return (
            (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified Ideographs
            (cp >= 0x3400 && cp <= 0x4DBF) ||  // Extension A
            (cp >= 0x20000 && cp <= 0x2A6DF)   // Extension B (surrogate pair in UTF-16)
        );
    }

    function containsCJK(s) {
        for (let i = 0; i < s.length;) {
            const cp = s.codePointAt(i);
            if (isCJKCodePoint(cp)) return true;
            i += cp > 0xFFFF ? 2 : 1;
        }
        return false;
    }

    // Returns { cp, start } for the code point ending at UTF-16 index `i`, or null.
    function prevCodePoint(text, i) {
        if (i <= 0) return null;
        let start = i - 1;
        const c = text.charCodeAt(start);
        if (c >= 0xDC00 && c <= 0xDFFF && start > 0) {
            const h = text.charCodeAt(start - 1);
            if (h >= 0xD800 && h <= 0xDBFF) start -= 1;
        }
        return { cp: text.codePointAt(start), start };
    }

    function walkLeftInNode(node, offset) {
        const text = node.data;
        let i = offset;
        while (i > 0) {
            const prev = prevCodePoint(text, i);
            if (!prev || !isCJKCodePoint(prev.cp)) return i;
            i = prev.start;
        }
        return 0;
    }

    function walkRightInNode(node, offset) {
        const text = node.data;
        let i = offset;
        while (i < text.length) {
            const cp = text.codePointAt(i);
            if (!isCJKCodePoint(cp)) return i;
            i += cp > 0xFFFF ? 2 : 1;
        }
        return text.length;
    }

    // Closest ancestor whose computed display is not inline-ish. Bounds the
    // cross-node walk so we don't merge runs across <p>, <div>, list items, etc.
    function getBlockAncestor(node) {
        let cur = node.parentElement;
        while (cur) {
            const d = window.getComputedStyle(cur).display;
            if (d && !d.startsWith("inline") && d !== "contents") return cur;
            cur = cur.parentElement;
        }
        return node.ownerDocument.body || node.ownerDocument.documentElement;
    }

    // Reject text nodes whose ancestor chain (up to blockAncestor) crosses a
    // nested block element. FILTER_REJECT on a text node is effectively SKIP
    // since text nodes are leaves, so the practical effect is per-node filtering.
    function makeTextFilter(blockAncestor) {
        return {
            acceptNode(node) {
                let cur = node.parentElement;
                while (cur && cur !== blockAncestor) {
                    const d = window.getComputedStyle(cur).display;
                    if (d && !d.startsWith("inline") && d !== "contents") {
                        return NodeFilter.FILTER_REJECT;
                    }
                    cur = cur.parentElement;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        };
    }

    // Walk left across text nodes within the block ancestor. In real Chinese
    // text the run is bounded by punctuation within ~dozens of chars, so an
    // unbounded walk is fine; no cap is enforced.
    function walkLeftAcrossNodes(anchorNode, anchorOffset) {
        const block = getBlockAncestor(anchorNode);
        let startNode = anchorNode;
        let startOffset = walkLeftInNode(anchorNode, anchorOffset);
        if (startOffset > 0) return { node: startNode, offset: startOffset };
        const tw = anchorNode.ownerDocument.createTreeWalker(
            block, NodeFilter.SHOW_TEXT, makeTextFilter(block)
        );
        tw.currentNode = anchorNode;
        while (startOffset === 0) {
            const prev = tw.previousNode();
            if (!prev) break;
            const len = prev.data.length;
            if (len === 0) { startNode = prev; continue; }
            const last = prevCodePoint(prev.data, len);
            if (!last || !isCJKCodePoint(last.cp)) break;
            startNode = prev;
            startOffset = walkLeftInNode(prev, len);
        }
        return { node: startNode, offset: startOffset };
    }

    function walkRightAcrossNodes(anchorNode, anchorOffset) {
        const block = getBlockAncestor(anchorNode);
        let endNode = anchorNode;
        let endOffset = walkRightInNode(anchorNode, anchorOffset);
        if (endOffset < anchorNode.data.length) return { node: endNode, offset: endOffset };
        const tw = anchorNode.ownerDocument.createTreeWalker(
            block, NodeFilter.SHOW_TEXT, makeTextFilter(block)
        );
        tw.currentNode = anchorNode;
        while (endOffset === endNode.data.length) {
            const next = tw.nextNode();
            if (!next) break;
            const len = next.data.length;
            if (len === 0) { endNode = next; endOffset = 0; continue; }
            const firstCp = next.data.codePointAt(0);
            if (!isCJKCodePoint(firstCp)) break;
            endNode = next;
            endOffset = walkRightInNode(next, 0);
        }
        return { node: endNode, offset: endOffset };
    }

    function getCaretFromPoint(x, y, doc, root) {
        if (typeof doc.caretPositionFromPoint === "function") {
            try {
                const p = root instanceof ShadowRoot
                    ? doc.caretPositionFromPoint(x, y, { shadowRoots: [root] })
                    : doc.caretPositionFromPoint(x, y);
                if (p) return { node: p.offsetNode, offset: p.offset };
            } catch (_) { /* fall through to legacy API */ }
        }
        if (typeof doc.caretRangeFromPoint === "function") {
            const r = doc.caretRangeFromPoint(x, y);
            if (r) return { node: r.startContainer, offset: r.startOffset };
        }
        return null;
    }

    function pickSelection(target) {
        const root = target && target.getRootNode && target.getRootNode();
        if (root instanceof ShadowRoot && typeof root.getSelection === "function") {
            return root.getSelection();
        }
        return window.getSelection();
    }

    let isApplying = false;

    function handleDblClick(e) {
        if (isApplying) return;

        const composedTarget =
            (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
        if (!composedTarget) return;

        // Form controls have their own selection model; leave them alone.
        if (
            composedTarget instanceof HTMLInputElement ||
            composedTarget instanceof HTMLTextAreaElement
        ) return;

        const sel = pickSelection(composedTarget);
        if (!sel || sel.rangeCount === 0) return;
        if (!containsCJK(sel.toString())) return;

        const root = composedTarget.getRootNode && composedTarget.getRootNode();
        const doc = (root && root.ownerDocument) || document;
        const caret = getCaretFromPoint(e.clientX, e.clientY, doc, root);
        if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return;

        const text = caret.node.data;
        const offset = caret.offset;

        // Require that at least one side of the caret is a CJK ideograph.
        // Without this, a click that lands on whitespace between CJK runs
        // would still trigger expansion in an unintuitive direction.
        const right = offset < text.length ? text.codePointAt(offset) : null;
        const leftInfo = prevCodePoint(text, offset);
        const leftCJK = leftInfo && isCJKCodePoint(leftInfo.cp);
        const rightCJK = right !== null && isCJKCodePoint(right);
        if (!leftCJK && !rightCJK) return;

        const start = walkLeftAcrossNodes(caret.node, offset);
        const end = walkRightAcrossNodes(caret.node, offset);

        if (start.node === end.node && start.offset === end.offset) return;

        // Re-entry guard: if our computed range already matches the current
        // selection, do nothing — prevents loops if another handler re-fires
        // dblclick in response to selectionchange.
        const cur = sel.getRangeAt(0);
        if (
            cur.startContainer === start.node && cur.startOffset === start.offset &&
            cur.endContainer === end.node && cur.endOffset === end.offset
        ) return;

        const range = doc.createRange();
        try {
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
        } catch (_) { return; }

        isApplying = true;
        try {
            sel.removeAllRanges();
            sel.addRange(range);
        } finally {
            isApplying = false;
        }
    }

    document.addEventListener("dblclick", handleDblClick, true);
})();
