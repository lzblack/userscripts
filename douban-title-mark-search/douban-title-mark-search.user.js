// ==UserScript==
// @name         豆瓣书名号转搜索链接
// @namespace    https://github.com/lzblack
// @version      1.2.1
// @author       lzblack
// @description  将豆瓣网站上的书名号《》中的内容转换为可点击的搜索链接，就像豆瓣 App 一样！点击书名号内的文字即可快速搜索，无需手动复制粘贴。
// @license      MIT
// @icon         https://img1.doubanio.com/favicon.ico
// @match        https://*.douban.com/*
// @match        http://*.douban.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-title-mark-search/douban-title-mark-search.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-title-mark-search/douban-title-mark-search.user.js
// ==/UserScript==

(function () {
    "use strict";

    const processedElements = new WeakSet();

    // 不带 g 标志，用于 test() 检测——避免 lastIndex 状态问题
    const titleMarkTest = /《([^《》]+)》/;

    function shouldSkipElement(element) {
        if (!element) return true;

        const tagName = element.tagName;
        if (
            tagName === "SCRIPT" ||
            tagName === "STYLE" ||
            tagName === "A" ||
            tagName === "NOSCRIPT" ||
            tagName === "IFRAME"
        ) {
            return true;
        }

        if (processedElements.has(element)) {
            return true;
        }

        return false;
    }

    function processTextNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || shouldSkipElement(parent)) {
            return;
        }

        const text = textNode.textContent;
        if (!titleMarkTest.test(text)) {
            return;
        }

        // replace() 内部用带 g 的局部正则
        const newHTML = text.replace(/《([^《》]+)》/g, (match, content) => {
            const encodedContent = encodeURIComponent(content);
            const searchUrl = `https://www.douban.com/search?q=${encodedContent}`;
            return `《<a href="${searchUrl}" target="_blank" style="color: #007722; text-decoration: none;">${content}</a>》`;
        });

        if (newHTML !== text) {
            const wrapper = document.createElement("span");
            wrapper.innerHTML = newHTML;
            parent.replaceChild(wrapper, textNode);
            processedElements.add(wrapper);
        }
    }

    function processContainer(container) {
        if (shouldSkipElement(container)) {
            return;
        }

        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    const parent = node.parentElement;
                    if (!parent || shouldSkipElement(parent)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    const closestLink = parent.closest("a");
                    if (closestLink && closestLink.href && closestLink.href.includes("douban.com/search")) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (titleMarkTest.test(node.textContent)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                },
            },
            false
        );

        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) {
            textNodes.push(node);
        }

        textNodes.forEach(processTextNode);
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
