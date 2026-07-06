// ==UserScript==
// @name         豆瓣书名号转搜索链接
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      1.2.4
// @author       lzblack
// @description  将豆瓣网站上的书名号《》中的内容转换为可点击的搜索链接，就像豆瓣 App 一样！点击书名号内的文字即可快速搜索，无需手动复制粘贴。
// @license      MIT
// @icon         https://img1.doubanio.com/favicon.ico
// @icon64       https://img1.doubanio.com/favicon.ico
// @match        https://*.douban.com/*
// @match        http://*.douban.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-title-mark-search/douban-title-mark-search.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-title-mark-search/douban-title-mark-search.user.js
// ==/UserScript==

(function () {
    "use strict";

    // 不带 g 标志，用于 test() 检测——避免 lastIndex 状态问题
    const titleMarkTest = /《([^《》]+)》/;

    // 匹配缓冲区限定在单个块级容器内：富文本编辑器常把《》与标题拆到不同
    // inline 节点（如 <strong>），需跨节点拼接才能匹配；但若跨段落拼接，一个
    // 未闭合的「《」会让 [^《》]+ 贪婪吃到下游段落的「》」，误链一大片无关文本。
    const BLOCK_TAGS = new Set([
        "P", "DIV", "LI", "TD", "TH", "BLOCKQUOTE", "SECTION", "ARTICLE",
        "H1", "H2", "H3", "H4", "H5", "H6", "DD", "DT", "FIGCAPTION",
        "PRE", "ADDRESS", "MAIN", "ASIDE", "HEADER", "FOOTER",
    ]);

    function shouldSkipElement(element) {
        if (!element) return true;
        const tagName = element.tagName;
        return (
            tagName === "SCRIPT" ||
            tagName === "STYLE" ||
            tagName === "A" ||
            tagName === "NOSCRIPT" ||
            tagName === "IFRAME"
        );
    }

    // 文本节点是否可参与转换：父链无脚本/样式，且未落在已生成的搜索链接内
    // （后者保证幂等——重扫时已链接的内容被排除，缓冲区收敛为「《》」不再匹配）
    function isEligibleTextNode(node) {
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent)) {
            return false;
        }
        const closestLink = parent.closest("a");
        if (closestLink && closestLink.href && closestLink.href.includes("douban.com/search")) {
            return false;
        }
        return true;
    }

    // 从文本节点向上找最近的块级祖先，作为匹配缓冲区的边界
    function nearestBlock(node) {
        let el = node.parentElement;
        while (el) {
            if (el.tagName === "BODY" || BLOCK_TAGS.has(el.tagName)) {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    function createSearchLink(content) {
        const link = document.createElement("a");
        link.href = `https://www.douban.com/search?q=${encodeURIComponent(content)}`;
        link.target = "_blank";
        link.style.color = "#007722";
        link.style.textDecoration = "none";
        link.textContent = content;
        return link;
    }

    // 把 textNode 的 [start, end) 子串替换为搜索链接，其余部分保留为文本节点。
    // 返回「[0, start)」对应的前缀文本节点，供同一节点内更靠左的区间继续施工。
    function wrapRange(textNode, start, end, query) {
        const full = textNode.textContent;
        const parent = textNode.parentNode;
        const before = full.slice(0, start);
        const after = full.slice(end);
        const beforeNode = document.createTextNode(before);
        const link = createSearchLink(query);

        if (before) parent.insertBefore(beforeNode, textNode);
        parent.insertBefore(link, textNode);
        if (after) parent.insertBefore(document.createTextNode(after), textNode);
        parent.removeChild(textNode);
        return beforeNode;
    }

    // 处理单个块：拼接块内可转换文本，匹配《》，再把每个命中的「内容」
    // 区间（不含《》本身）逐节点包成搜索链接。链接只包裹内容所在文本节点的
    // 子串，绝不跨元素边界，从而保留 <strong> 等既有 inline 结构。
    function processBlock(textNodes) {
        let buffer = "";
        const segments = [];
        for (const node of textNodes) {
            const text = node.textContent;
            segments.push({ node, start: buffer.length, end: buffer.length + text.length });
            buffer += text;
        }

        if (buffer.indexOf("《") === -1 || !titleMarkTest.test(buffer)) {
            return;
        }

        // 收集每个文本节点上需包成链接的区间（缓冲区坐标映射回节点局部坐标）
        const opsByNode = new Map();
        const re = /《([^《》]+)》/g;
        let match;
        while ((match = re.exec(buffer)) !== null) {
            const query = match[1];
            const contentStart = match.index + 1;               // 跳过「《」
            const contentEnd = contentStart + query.length;     // 「》」之前
            for (const seg of segments) {
                const s = Math.max(contentStart, seg.start);
                const e = Math.min(contentEnd, seg.end);
                if (s < e) {
                    if (!opsByNode.has(seg.node)) opsByNode.set(seg.node, []);
                    opsByNode.get(seg.node).push({ start: s - seg.start, end: e - seg.start, query });
                }
            }
        }

        // 逐节点从右向左施工：先处理靠右区间，左侧区间的偏移量不受 DOM 变更影响
        for (const [node, ranges] of opsByNode) {
            ranges.sort((a, b) => a.start - b.start);
            let current = node;
            for (let i = ranges.length - 1; i >= 0; i--) {
                const r = ranges[i];
                current = wrapRange(current, r.start, r.end, r.query);
            }
        }
    }

    function processContainer(container) {
        if (!container) return;
        if (container.nodeType === Node.ELEMENT_NODE && shouldSkipElement(container)) {
            return;
        }

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                return isEligibleTextNode(node)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            },
        });

        // 按最近块级祖先分组，每个块独立组装缓冲区并匹配
        const blocks = new Map();
        let node;
        while ((node = walker.nextNode())) {
            const block = nearestBlock(node);
            if (!block) continue;
            if (!blocks.has(block)) blocks.set(block, []);
            blocks.get(block).push(node);
        }

        for (const textNodes of blocks.values()) {
            processBlock(textNodes);
        }
    }

    let debounceTimer = null;
    function debounceProcess(container) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            processContainer(container);
        }, 200);
    }

    // 初始执行
    function initProcess() {
        if (document.body) {
            setTimeout(() => {
                processContainer(document.body);
            }, 500);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initProcess);
    } else {
        initProcess();
    }

    // MutationObserver 处理动态加载的内容
    function handleNodeChanges(mutations) {
        const nodesToProcess = new Set();

        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(function (node) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    nodesToProcess.add(node);
                } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
                    nodesToProcess.add(node.parentElement);
                }
            });

            if (mutation.type === "attributes" && mutation.attributeName === "class") {
                const target = mutation.target;
                if (
                    target.classList.contains("expanded") ||
                    target.classList.contains("show-all") ||
                    target.classList.contains("full-content")
                ) {
                    nodesToProcess.add(target);
                }
            }

            if (mutation.type === "characterData" && mutation.target.parentElement) {
                nodesToProcess.add(mutation.target.parentElement);
            }
        });

        nodesToProcess.forEach((node) => {
            if (node && node.nodeType === Node.ELEMENT_NODE) {
                debounceProcess(node);
            }
        });
    }

    if (document.body) {
        const observer = new MutationObserver(handleNodeChanges);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
            characterData: true,
        });
    }
})();
