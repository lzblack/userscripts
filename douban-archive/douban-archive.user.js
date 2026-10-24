// ==UserScript==
// @name         豆仓：豆瓣书影音标记与个人内容备份（含私密）
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      0.2.0
// @author       lzblack
// @description  在已登录的豆瓣页面导出自己全部的书、影、音、游戏、舞台剧标记（含私密），下载为 JSON 与 NeoDB CSV。只在本机处理，不联系豆瓣以外的任何地址
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

  const VERSION = '0.2.0';

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

  // ============ NeoDB CSV（§4） ============

  // 表头照 NeoDB 导出（journal/exporters/csv.py），visibility 是给计划中的 NeoDB PR 加的
  const NEODB_HEADER = ['title', 'info', 'links', 'timestamp', 'status', 'rating', 'comment', 'tags', 'visibility'];
  const NEODB_STATUS = { mark: 'wishlist', doing: 'progress', done: 'complete' };
  // 按条目类型分文件，不按书架：电影书架里有剧集（tv）
  const NEODB_CATEGORIES = { book: 'book', movie: 'movie', tv: 'tv', music: 'music', game: 'game', drama: 'performance' };
  // NeoDB 的可见性：0 公开、1 仅关注者、2 仅自己
  const NEODB_PRIVATE = '2';

  function neodbCategory(subjectType) {
    return Object.prototype.hasOwnProperty.call(NEODB_CATEGORIES, subjectType) ? NEODB_CATEGORIES[subjectType] : null;
  }

  /** create_time 是北京时间；NeoDB 把没有时区的时间当 UTC */
  function beijingToIso(s) {
    const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/.exec(s || '');
    return m ? `${m[1]}T${m[2]}+08:00` : '';
  }

  function neodbMarkRow(interest, status) {
    const subject = interest.subject || {};
    const rating = interest.rating && interest.rating.value ? String(interest.rating.value * 2) : '';
    return [
      subject.title || '',
      '',
      subject.url || '',
      beijingToIso(interest.create_time),
      NEODB_STATUS[status],
      rating,
      interest.comment || '',
      (interest.tags || []).map((t) => String(t).replace(/\|/g, ' ')).join('|'),
      interest.is_private ? NEODB_PRIVATE : '',
    ];
  }

  function csvLine(fields) {
    return fields.map((f) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',') + '\r\n';
  }

  /** { 'movie_mark.csv': 文本, … }，只含有条目的类别 */
  function buildNeodbCsvFiles(data) {
    const files = {};
    for (const [, byStatus] of Object.entries(data.interests)) {
      for (const [status, list] of Object.entries(byStatus)) {
        for (const it of list) {
          const category = neodbCategory(it.subject && it.subject.type);
          if (!category) continue;
          const name = `${category}_mark.csv`;
          if (!files[name]) files[name] = csvLine(NEODB_HEADER);
          files[name] += csvLine(neodbMarkRow(it, status));
        }
      }
    }
    return files;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** 不压缩（store）的 zip：文件只有几 MB，省掉压缩库 */
  function buildZip(files, date) {
    const enc = new TextEncoder();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(text);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // 文件名是 UTF-8
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of parts) { out.set(c, p); p += c.length; }
    return out;
  }

  function neodbZipFilename(uid, date) {
    return exportFilename(uid, date).replace(/\.json$/, '-neodb.zip');
  }

  // ── node 测试导出（在任何 GM_/DOM 调用之前 return） ──────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SHELVES, PAGE_SIZE, MAX_REFETCH, INTERVAL_MS, PROGRESS_TTL_MS,
      interestsUrl, parseUsernameFromUrl, classifyResponse,
      createProgress, isProgressFresh, pageKey, runExport, buildExport, exportFilename,
      NEODB_HEADER, neodbCategory, beijingToIso, neodbMarkRow, csvLine, buildNeodbCsvFiles, buildZip, neodbZipFilename,
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

  function saveFile(content, type, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // JSON 是完整存档，NeoDB zip 只为导入 NeoDB；分两个文件
  function download(progress) {
    const now = new Date();
    const data = buildExport(progress, io.getValue, { now: now.getTime(), version: VERSION });
    saveFile(JSON.stringify(data), 'application/json', exportFilename(progress.uid, now));
    saveFile(buildZip(buildNeodbCsvFiles(data), now), 'application/zip', neodbZipFilename(progress.uid, now));
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
      showPanel(`${summarize(data)}\n已下载两个文件：.json 是完整存档，-neodb.zip 用于导入 NeoDB`
        + '（NeoDB 导入时整批选可见性，选"公开"会把私密标记也公开）。\n文件确认保存后点"完成"清除浏览器里的缓存。',
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
