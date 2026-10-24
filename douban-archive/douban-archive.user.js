// ==UserScript==
// @name         豆仓：豆瓣书影音标记与个人内容备份（含私密）
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      0.1.1
// @author       lzblack
// @description  在已登录的豆瓣页面导出自己全部的书、影、音、游戏、舞台剧标记（含私密），下载为 JSON。只在本机处理，不联系豆瓣以外的任何地址
// @match        https://www.douban.com/*
// @noframes
// @icon         https://img3.doubanio.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      m.douban.com
// @supportURL   https://github.com/lzblack/userscripts/issues
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============ 常量 ============

  const VERSION = '0.1.1';

  const TYPES = ['book', 'movie', 'music', 'game', 'drama'];
  // 舞台剧没有"在看"
  const SHELVES = TYPES.flatMap((type) =>
    (type === 'drama' ? ['mark', 'done'] : ['mark', 'doing', 'done'])
      .map((status) => ({ type, status, key: `${type}/${status}` })));

  const SHELF_LABELS = {
    book: { mark: '想读', doing: '在读', done: '读过' },
    movie: { mark: '想看', doing: '在看', done: '看过' },
    music: { mark: '想听', doing: '在听', done: '听过' },
    game: { mark: '想玩', doing: '在玩', done: '玩过' },
    drama: { mark: '想看的舞台剧', done: '看过的舞台剧' },
  };

  const PAGE_SIZE = 50;
  // 一页不满时最多再取 3 次：§2 实测服务端会暂时丢条（34 条，重取得 50 条）
  const MAX_REFETCH = 3;
  const INTERVAL_MS = 2000;
  const PROGRESS_TTL_MS = 24 * 60 * 60 * 1000;
  const PROGRESS_VERSION = 1;
  const KEY_PREFIX = 'da:';
  const PROGRESS_KEY = 'da:progress';

  // ============ 纯逻辑 ============

  function interestsUrl(numericId, type, status, start, ck) {
    return `https://m.douban.com/rexxar/api/v2/user/${numericId}/interests`
      + `?type=${type}&status=${status}&start=${start}&count=${PAGE_SIZE}&ck=${ck}&for_mobile=1`;
  }

  /** /mine/ 会跳到 /people/{用户名}/，从跳转后的地址读用户名 */
  function parseUsernameFromUrl(url) {
    const m = /^https:\/\/www\.douban\.com\/people\/([^/?#]+)/.exec(url || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * 只有"200 + JSON"算数据，"带 code 的 JSON / 非 200 的 JSON"算失败，
   * 其余（网络错误、超时、中止、不是 JSON）一律暂停：安全验证跳转经
   * GM_xmlhttpRequest 时具体是哪种表现没有实测过。
   */
  function classifyResponse(res) {
    if (res.failure) return { kind: 'pause', reason: res.failure };
    let json;
    try { json = JSON.parse(res.responseText); } catch { return { kind: 'pause', reason: 'notJson', http: res.status }; }
    if (!json || typeof json !== 'object') return { kind: 'pause', reason: 'notJson', http: res.status };
    if (res.status !== 200 || json.code) {
      return { kind: 'fail', http: res.status, code: json.code, msg: json.msg };
    }
    const total = Number(json.total);
    return {
      kind: 'ok',
      total: Number.isFinite(total) ? total : 0,
      rows: Array.isArray(json.interests) ? json.interests : [],
    };
  }

  function createProgress(uid, numericId, now) {
    return { v: PROGRESS_VERSION, uid, numericId, startedAt: now, updatedAt: now, shelfIndex: 0, start: 0, shelves: {} };
  }

  function isProgressFresh(progress, now) {
    return !!progress && progress.v === PROGRESS_VERSION && now - progress.updatedAt <= PROGRESS_TTL_MS;
  }

  function pageKey(shelfKey, start) {
    return `${KEY_PREFIX}page:${shelfKey}:${start}`;
  }

  function shelfState(progress, key) {
    if (!progress.shelves[key]) {
      progress.shelves[key] = { firstTotal: null, lastTotal: null, maxTotal: 0, pages: [], fetched: 0, anomalies: [] };
    }
    return progress.shelves[key];
  }

  /**
   * 取一页：不满就重取（最多 MAX_REFETCH 次），各次按 id 合并。
   * 返回 { kind: 'page', rows, end } 或透传 pause / fail / cancel。
   */
  async function fetchPage(ctx, shelf, start, st) {
    const { io, progress, isCancelled } = ctx;
    const merged = new Map();
    for (let attempt = 0; ; attempt++) {
      if (isCancelled()) return { kind: 'cancel' };
      if (ctx.requested) await io.sleep(INTERVAL_MS);
      if (isCancelled()) return { kind: 'cancel' };
      ctx.requested = true;
      const res = classifyResponse(await io.request(
        interestsUrl(progress.numericId, shelf.type, shelf.status, start, ctx.ck)));
      if (res.kind !== 'ok') return res;

      // total: 0 的空页是 §2 见过的暂时异常，不拿它覆盖已见到的 total
      if (res.total > 0 || res.rows.length > 0) {
        if (st.firstTotal === null) st.firstTotal = res.total;
        st.lastTotal = res.total;
        st.maxTotal = Math.max(st.maxTotal, res.total);
      }
      for (const r of res.rows) merged.set(String(r.id), r);

      if (merged.size >= PAGE_SIZE) return { kind: 'page', rows: [...merged.values()], end: false };
      // 正常末尾：只有空页才算到头，短页可能是服务端暂时丢条
      if (merged.size === 0 && res.total > 0 && start >= res.total) return { kind: 'page', rows: [], end: true };
      if (attempt >= MAX_REFETCH) break;
    }
    if (merged.size === 0) {
      if (start >= st.maxTotal) return { kind: 'page', rows: [], end: true };
      st.anomalies.push({ start, got: 0 });
      return { kind: 'page', rows: [], end: false };
    }
    if (start + PAGE_SIZE < st.maxTotal) st.anomalies.push({ start, got: merged.size });
    return { kind: 'page', rows: [...merged.values()], end: false };
  }

  /**
   * 串行导出。只在页边界存档：中断的那页续跑时重取。
   * io: { request(url) → {status, responseText} | {failure}, sleep(ms), setValue(k, v), getValue(k) }
   */
  async function runExport({ progress, io, shelves = SHELVES, ck = '', onUpdate = () => {}, isCancelled = () => false, now = () => 0 }) {
    const ctx = { io, progress, isCancelled, ck, requested: false };
    const save = () => { progress.updatedAt = now(); io.setValue(PROGRESS_KEY, progress); };
    while (progress.shelfIndex < shelves.length) {
      const shelf = shelves[progress.shelfIndex];
      const st = shelfState(progress, shelf.key);
      onUpdate({ shelf, fetched: st.fetched, index: progress.shelfIndex, count: shelves.length });
      const r = await fetchPage(ctx, shelf, progress.start, st);
      if (r.kind === 'cancel') return { state: 'cancelled' };
      if (r.kind === 'pause') { save(); return { state: 'paused', reason: r.reason, http: r.http, shelf }; }
      if (r.kind === 'fail') { save(); return { state: 'failed', http: r.http, code: r.code, msg: r.msg, shelf }; }
      if (r.end) {
        progress.shelfIndex++;
        progress.start = 0;
      } else {
        io.setValue(pageKey(shelf.key, progress.start), r.rows);
        st.pages.push(progress.start);
        st.fetched += r.rows.length;
        progress.start += PAGE_SIZE;
      }
      save();
    }
    return { state: 'done' };
  }

  /** 拼出导出文件：条目原样保存，按 id 去重（导出中途增删标记会让页错位） */
  function buildExport(progress, getValue, { now, version }) {
    const interests = {};
    const metaShelves = [];
    for (const shelf of SHELVES) {
      const st = progress.shelves[shelf.key];
      if (!st) continue;
      const seen = new Set();
      const list = [];
      for (const start of st.pages) {
        for (const r of getValue(pageKey(shelf.key, start)) || []) {
          const id = String(r.id);
          if (seen.has(id)) continue;
          seen.add(id);
          list.push(r);
        }
      }
      const priv = list.filter((r) => r.is_private).length;
      const total = st.lastTotal === null ? 0 : st.lastTotal;
      (interests[shelf.type] = interests[shelf.type] || {})[shelf.status] = list;
      metaShelves.push({
        type: shelf.type, status: shelf.status, label: SHELF_LABELS[shelf.type][shelf.status],
        firstTotal: st.firstTotal, lastTotal: st.lastTotal,
        fetched: list.length, private: priv,
        // total 含私密（§2：2026-10-23 全量导出，三个有私密的书架都是 取到 = total）
        consistent: list.length === total,
        anomalies: st.anomalies,
      });
    }
    return {
      meta: {
        format: 'douban-archive', formatVersion: 1, scriptVersion: version,
        uid: progress.uid, numericId: progress.numericId,
        startedAt: new Date(progress.startedAt).toISOString(), exportedAt: new Date(now).toISOString(),
        shelves: metaShelves,
      },
      interests,
    };
  }

  function exportFilename(uid, date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `douban-archive-${uid}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
  }

  // ── node 测试导出（在任何 GM_/DOM 调用之前 return） ──────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SHELVES, PAGE_SIZE, MAX_REFETCH, INTERVAL_MS, PROGRESS_TTL_MS,
      interestsUrl, parseUsernameFromUrl, classifyResponse,
      createProgress, isProgressFresh, pageKey, runExport, buildExport, exportFilename,
    };
    return;
  }

  // ============ 运行期 ============

  const REFERER = 'https://m.douban.com/mine/';

  function readCk() {
    return (document.cookie.match(/(?:^|; )ck=([^;]+)/) || [])[1] || '';
  }

  // Rexxar 校验 Referer：不带返回 400 / code 1287（§2）
  function gmGet(url) {
    return new Promise((resolve) => GM_xmlhttpRequest({
      method: 'GET', url, headers: { Referer: REFERER }, anonymous: false, timeout: 15000,
      onload: (r) => resolve({ status: r.status, responseText: r.responseText }),
      onerror: () => resolve({ failure: 'error' }),
      ontimeout: () => resolve({ failure: 'timeout' }),
      onabort: () => resolve({ failure: 'abort' }),
    }));
  }

  const io = {
    request: gmGet,
    sleep: (ms) => new Promise((s) => setTimeout(s, ms)),
    setValue: (k, v) => GM_setValue(k, v),
    getValue: (k) => GM_getValue(k),
  };

  function clearStorage() {
    for (const k of GM_listValues()) if (k.startsWith(KEY_PREFIX)) GM_deleteValue(k);
  }

  async function resolveUser() {
    const r = await fetch('/mine/', { credentials: 'include' });
    const username = parseUsernameFromUrl(r.url);
    if (!username) throw new Error(`读不到当前登录的豆瓣用户，请先登录（/mine/ → ${r.status} ${r.url}）`);
    const raw = await gmGet(`https://m.douban.com/rexxar/api/v2/user/${encodeURIComponent(username)}?ck=${readCk()}&for_mobile=1`);
    if (classifyResponse(raw).kind !== 'ok') throw new Error('读不到数字 id（可能需要在豆瓣完成安全验证），稍后再试');
    // classifyResponse 只看列表字段，id 从原始 JSON 里取
    const id = JSON.parse(raw.responseText).id;
    if (!id) throw new Error('读不到数字 id');
    return { username, numericId: String(id) };
  }

  // ── 面板 ──

  let panel = null;
  let running = false;
  let cancelRequested = false;

  function showPanel(text, buttons = []) {
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:340px;padding:12px 14px;'
        + 'background:#fff;color:#111;border:1px solid #ccc;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.15);'
        + 'font:13px/1.6 sans-serif;white-space:pre-line';
      document.body.appendChild(panel);
    }
    panel.textContent = `豆仓\n${text}`;
    if (buttons.length) {
      const bar = document.createElement('div');
      bar.style.cssText = 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap';
      for (const [label, onClick] of buttons) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:2px 10px;cursor:pointer';
        b.addEventListener('click', onClick);
        bar.appendChild(b);
      }
      panel.appendChild(bar);
    }
  }

  function hidePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  const shelfLabel = (shelf) => SHELF_LABELS[shelf.type][shelf.status];

  function download(progress) {
    const data = buildExport(progress, io.getValue, { now: Date.now(), version: VERSION });
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFilename(progress.uid, new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return data;
  }

  function summarize(data) {
    const total = data.meta.shelves.reduce((n, s) => n + s.fetched, 0);
    const priv = data.meta.shelves.reduce((n, s) => n + s.private, 0);
    const bad = data.meta.shelves.filter((s) => !s.consistent || s.anomalies.length);
    const lines = [`已导出 ${total} 条（私密 ${priv} 条）。`];
    if (bad.length) {
      lines.push('以下书架条数与豆瓣的总数对不上，详情见文件 meta：');
      for (const s of bad) lines.push(`· ${s.label}：取到 ${s.fetched}（私密 ${s.private}），豆瓣总数 ${s.lastTotal}`);
    }
    return lines.join('\n');
  }

  async function run(progress) {
    if (running) return;
    running = true;
    cancelRequested = false;
    const cancel = () => { cancelRequested = true; showPanel('正在取消…'); };
    let result;
    try {
      result = await runExport({
        progress, io, ck: readCk(), now: Date.now,
        isCancelled: () => cancelRequested,
        onUpdate: ({ shelf, fetched, index, count }) =>
          showPanel(`正在导出（${index + 1}/${count}）${shelfLabel(shelf)}：已取 ${fetched} 条`, [['取消', cancel]]),
      });
    } catch (e) {
      // 比如存储写满：进度停在上一个页边界，可以再试
      showPanel(`导出出错：${e && e.message}\n已取到的部分保留 24 小时。`,
        [['继续', () => run(io.getValue(PROGRESS_KEY))], ['放弃', abandon]]);
      return;
    } finally {
      running = false;
    }

    if (result.state === 'cancelled') {
      clearStorage();
      showPanel('已取消，已取到的数据已清除。', [['关闭', hidePanel]]);
    } else if (result.state === 'paused') {
      showPanel(`已暂停（${shelfLabel(result.shelf)}）：豆瓣没有返回数据（${result.reason}）。\n`
        + '可能需要安全验证：在新标签页打开豆瓣，按提示完成验证后回来点"继续"。进度保留 24 小时。',
      [['继续', () => run(io.getValue(PROGRESS_KEY))], ['打开豆瓣', () => window.open('https://m.douban.com/mine/', '_blank')], ['放弃', abandon]]);
    } else if (result.state === 'failed') {
      showPanel(`导出停止（${shelfLabel(result.shelf)}）：豆瓣返回错误 ${result.http} ${result.code || ''} ${result.msg || ''}。\n`
        + '没有下载半份数据。已取到的部分保留 24 小时，可以稍后点"继续"再试。',
      [['继续', () => run(io.getValue(PROGRESS_KEY))], ['放弃', abandon]]);
    } else {
      const data = download(progress);
      showPanel(`${summarize(data)}\n文件确认保存后点"完成"清除浏览器里的缓存。`,
        [['再下载一次', () => download(io.getValue(PROGRESS_KEY))], ['完成', () => { clearStorage(); hidePanel(); }]]);
    }
  }

  function abandon() {
    clearStorage();
    hidePanel();
  }

  async function startExport() {
    if (running) return;
    const existing = io.getValue(PROGRESS_KEY);
    if (isProgressFresh(existing, Date.now()) && existing.shelfIndex < SHELVES.length) {
      showPanel('有一份未完成的导出。', [['继续', () => run(io.getValue(PROGRESS_KEY))], ['从头开始', startFresh]]);
      return;
    }
    startFresh();
  }

  async function startFresh() {
    if (running) return;
    showPanel('正在读取当前用户…');
    let user;
    try { user = await resolveUser(); } catch (e) { showPanel(e.message, [['关闭', hidePanel]]); return; }
    clearStorage();
    const progress = createProgress(user.username, user.numericId, Date.now());
    io.setValue(PROGRESS_KEY, progress);
    run(progress);
  }

  GM_registerMenuCommand('导出全部标记', startExport);

  // 关掉页面也能续：有未完成的进度就提示；过期的清掉
  const pending = io.getValue(PROGRESS_KEY);
  if (pending && !isProgressFresh(pending, Date.now())) {
    clearStorage();
  } else if (pending && pending.shelfIndex < SHELVES.length) {
    showPanel('有一份未完成的导出。', [['继续', () => run(io.getValue(PROGRESS_KEY))], ['放弃', abandon]]);
  }
})();
