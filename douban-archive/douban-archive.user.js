// ==UserScript==
// @name         豆仓：豆瓣书影音标记与个人内容备份（含私密）
// @namespace    https://github.com/lzblack
// @homepageURL  https://github.com/lzblack/userscripts
// @version      0.3.0
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
// @updateURL    https://raw.githubusercontent.com/lzblack/userscripts/main/douban-archive/douban-archive.user.js
// @downloadURL  https://raw.githubusercontent.com/lzblack/userscripts/main/douban-archive/douban-archive.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============ 常量 ============

  const VERSION = '0.3.0';

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

      // total 含私密（§2 全量导出证实）：取到 total 就是取全了，不重取、不再请求空页；
      // 没到 total 的短页可能是服务端暂时丢条，要重取
      // 整页却超过 total 说明 total 偏小（导出中途新加了标记），继续翻
      const reached = res.total > 0 && (merged.size < PAGE_SIZE ? start + merged.size >= res.total : start + merged.size === res.total);
      if (merged.size >= PAGE_SIZE || reached) return { kind: 'page', rows: [...merged.values()], end: reached };
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
      onUpdate({ shelf, fetched: st.fetched, totalFetched: totalFetched(progress), index: progress.shelfIndex, count: shelves.length });
      const r = await fetchPage(ctx, shelf, progress.start, st);
      if (r.kind === 'cancel') return { state: 'cancelled' };
      if (r.kind === 'pause') { save(); return { state: 'paused', reason: r.reason, http: r.http, shelf }; }
      if (r.kind === 'fail') { save(); return { state: 'failed', http: r.http, code: r.code, msg: r.msg, shelf }; }
      const index = progress.shelfIndex;
      if (r.rows.length) {
        io.setValue(pageKey(shelf.key, progress.start), r.rows);
        st.pages.push(progress.start);
        st.fetched += r.rows.length;
      }
      if (r.end) {
        progress.shelfIndex++;
        progress.start = 0;
      } else {
        progress.start += PAGE_SIZE;
      }
      save();
      onUpdate({ shelf, fetched: st.fetched, totalFetched: totalFetched(progress), index, count: shelves.length });
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

  // ============ 界面用的纯逻辑 ============

  const REMIND_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
  // 实测：9304 条约 21 分钟，约 243 次请求，每次约 5.2 秒（间隔 2 秒 + 接口耗时）
  const MS_PER_REQUEST = 5200;
  const TYPE_SHORT = { book: '书', movie: '影', music: '音', game: '游', drama: '剧' };
  const SHELF_SHORT = { mark: { drama: '想看' }, done: { drama: '看过' } };

  /**
   * 首页侧栏入口什么时候出现：从没导出过；或开了定期提醒且满 30 天。
   * 点过 ✕ 的暂停期内都不出现。cfg: { lastExportAt, remind, snoozeUntil }
   */
  function shouldShowEntry(cfg, now) {
    if (cfg.snoozeUntil && now < cfg.snoozeUntil) return false;
    if (!cfg.lastExportAt) return true;
    return !!cfg.remind && now - cfg.lastExportAt >= REMIND_INTERVAL_MS;
  }

  /** 开始前的预计耗时：每页 50 条，每个书架的末页约多一次请求 */
  function estimateTotalMs(total) {
    return (Math.ceil(total / PAGE_SIZE) + SHELVES.length) * MS_PER_REQUEST;
  }

  /** 按本次运行的速率外推；续跑前取的条数不计入速率 */
  function estimateRemainingMs({ elapsedMs, fetchedThisRun, fetched, total }) {
    if (!total || fetchedThisRun <= 0) return null;
    return Math.max(0, total - fetched) * (elapsedMs / fetchedThisRun);
  }

  function totalFetched(progress) {
    return Object.values(progress.shelves).reduce((n, st) => n + st.fetched, 0);
  }

  /** 完成卡片：每类一行 */
  function summaryRows(meta) {
    const rows = [];
    for (const s of meta.shelves) {
      const type = TYPE_SHORT[s.type];
      let row = rows.find((r) => r.type === type);
      if (!row) { row = { type, items: [] }; rows.push(row); }
      const label = (SHELF_SHORT[s.status] && SHELF_SHORT[s.status][s.type]) || s.label;
      row.items.push({ label, fetched: s.fetched, total: s.lastTotal === null ? 0 : s.lastTotal, ok: s.consistent });
    }
    return rows;
  }

  function formatNumber(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ── node 测试导出（在任何 GM_/DOM 调用之前 return） ──────────────────────
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SHELVES, PAGE_SIZE, MAX_REFETCH, INTERVAL_MS, PROGRESS_TTL_MS,
      interestsUrl, parseUsernameFromUrl, classifyResponse,
      createProgress, isProgressFresh, pageKey, runExport, buildExport, exportFilename,
      NEODB_HEADER, neodbCategory, beijingToIso, neodbMarkRow, csvLine, buildNeodbCsvFiles, buildZip, neodbZipFilename,
      REMIND_INTERVAL_MS, shouldShowEntry, estimateTotalMs, estimateRemainingMs, totalFetched, summaryRows, formatNumber,
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

  /** 全部标记的总数（豆伴的用法：不带类型，count=1）；拿不到就是 null，界面不显示总数 */
  async function fetchGrandTotal(numericId) {
    const res = classifyResponse(await gmGet(
      `https://m.douban.com/rexxar/api/v2/user/${numericId}/interests?ck=${readCk()}&count=1&for_mobile=1`));
    return res.kind === 'ok' && res.total > 0 ? res.total : null;
  }

  // ── 设置（不随导出缓存清除） ──

  const CFG = { lastExportAt: 'dacfg:lastExportAt', remind: 'dacfg:remind', snoozeUntil: 'dacfg:snoozeUntil' };
  const readCfg = () => Object.fromEntries(Object.entries(CFG).map(([k, key]) => [k, GM_getValue(key)]));
  const writeCfg = (k, v) => GM_setValue(CFG[k], v);

  // ── 界面 ──

  const CSS = `
.da-mod{margin-bottom:30px}
.da-mod h2{color:#072;font-size:15px;margin:0 0 12px;line-height:150%;display:flex;justify-content:space-between}
.da-mod p{color:#666;font-size:13px;line-height:1.7;margin:0 0 10px}
.da-btn{display:inline-block;padding:4px 14px;border:1px solid #3ba94d;border-radius:3px;background:#3ba94d;color:#fff!important;font-size:13px;line-height:1.6;cursor:pointer;text-decoration:none!important}
.da-btn:hover{background:#2e963d;border-color:#2e963d}
.da-btn.da-plain{background:#fff;color:#3ba94d!important}
.da-btn.da-plain:hover{background:#f2f8f2}
.da-x{color:#999;cursor:pointer;font-size:14px;line-height:1;font-weight:normal}
.da-card{position:fixed;right:20px;bottom:20px;z-index:99999;width:360px;max-width:calc(100vw - 40px);background:#fff;border:1px solid #dcdcdc;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.12);font:13px/1.7 Helvetica,Arial,sans-serif;color:#111;text-align:left}
.da-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eee;color:#072;font-size:14px}
.da-body{padding:12px 14px}
.da-body ul,.da-body ol{margin:4px 0 8px;padding-left:20px}
.da-body ul li{list-style:disc}
.da-body ol li{list-style:decimal}
.da-muted{color:#888}
.da-bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin:4px 0 8px}
.da-bar i{display:block;height:100%;background:#3ba94d;transition:width .3s}
.da-row{display:flex;justify-content:space-between;gap:8px}
.da-warn{background:#fff8e6;border:1px solid #f3dca0;border-radius:3px;padding:6px 8px;margin:8px 0}
.da-ok{color:#2e963d}
.da-bad{color:#c60}
.da-table{width:100%;border-collapse:collapse;margin:6px 0}
.da-table td{padding:2px 0;vertical-align:top}
.da-table td:first-child{color:#888;width:28px}
.da-foot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:0 14px 12px}
.da-link{color:#37a;cursor:pointer}`;

  function injectCss() {
    if (document.getElementById('da-css')) return;
    const style = document.createElement('style');
    style.id = 'da-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /** el('div', { class: 'x', onclick }, '文本', 子节点…)；文本一律走 textNode，不拼 HTML */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  const btn = (label, onclick, plain) => el('a', { class: plain ? 'da-btn da-plain' : 'da-btn', onclick }, label);

  let card = null;

  function showCard(title, body, buttons, closable) {
    injectCss();
    if (card) card.remove();
    card = el('div', { class: 'da-card' },
      el('div', { class: 'da-head' }, `豆仓 · ${title}`, closable ? el('span', { class: 'da-x', onclick: hideCard }, '✕') : null),
      el('div', { class: 'da-body' }, body),
      buttons && buttons.length ? el('div', { class: 'da-foot' }, buttons) : null);
    document.body.appendChild(card);
  }

  function hideCard() {
    if (card) { card.remove(); card = null; }
  }

  const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
  const shelfLabel = (shelf) => `${TYPE_SHORT[shelf.type]} · ${(SHELF_SHORT[shelf.status] && SHELF_SHORT[shelf.status][shelf.type]) || SHELF_LABELS[shelf.type][shelf.status]}`;

  // ── 首页侧栏入口 ──

  let entry = null;

  function renderEntry() {
    const aside = document.querySelector('.aside');
    if (location.pathname !== '/' || !aside || !document.querySelector('.nav-user-account')) return;
    const cfg = readCfg();
    if (!shouldShowEntry(cfg, Date.now())) return;
    injectCss();
    const days = cfg.lastExportAt ? Math.floor((Date.now() - cfg.lastExportAt) / (24 * 60 * 60 * 1000)) : 0;
    entry = el('div', { class: 'mod da-mod' },
      el('h2', {}, '豆仓 · · · · · ·',
        el('span', { class: 'da-x', title: '30 天内不再显示', onclick: () => { writeCfg('snoozeUntil', Date.now() + REMIND_INTERVAL_MS); removeEntry(); } }, '✕')),
      el('p', {}, cfg.lastExportAt
        ? `已经 ${days} 天没有备份豆瓣标记了。`
        : '把你在豆瓣的全部书影音游戏舞台剧标记（含私密）导出到本机。'),
      btn('导出我的标记', startExport));
    aside.insertBefore(entry, aside.firstChild);
  }

  function removeEntry() {
    if (entry) { entry.remove(); entry = null; }
  }

  // ── 流程 ──

  let running = false;
  let cancelRequested = false;

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

  const resume = () => run(io.getValue(PROGRESS_KEY));

  function abandon() {
    clearStorage();
    hideCard();
  }

  function showRunning(u, startedAt, fetchedAtStart, grandTotal) {
    const fetched = u.totalFetched;
    const eta = estimateRemainingMs({
      elapsedMs: Date.now() - startedAt, fetchedThisRun: fetched - fetchedAtStart, fetched, total: grandTotal,
    });
    showCard('正在导出', [
      el('div', { class: 'da-row' },
        el('span', {}, shelfLabel(u.shelf), ' ', el('span', { class: 'da-muted' }, `（第 ${u.index + 1} / ${u.count} 个书架）`)),
        el('span', {}, grandTotal ? `${formatNumber(fetched)} / ${formatNumber(grandTotal)}` : `已取 ${formatNumber(fetched)} 条`)),
      grandTotal ? el('div', { class: 'da-bar' }, el('i', { style: `width:${Math.min(100, (fetched / grandTotal) * 100).toFixed(1)}%` })) : null,
      el('div', { class: 'da-muted' }, cancelRequested ? '正在取消…'
        : `${eta === null ? '' : `约剩 ${minutes(eta)} 分钟 · `}请保持本标签页打开`),
    ], [btn('取消', () => { cancelRequested = true; showRunning(u, startedAt, fetchedAtStart, grandTotal); }, true)]);
  }

  function showDone(data) {
    const rows = summaryRows(data.meta);
    const total = data.meta.shelves.reduce((n, s) => n + s.fetched, 0);
    const priv = data.meta.shelves.reduce((n, s) => n + s.private, 0);
    const allOk = data.meta.shelves.every((s) => s.consistent);
    const remindLine = el('div', { style: 'margin-top:6px' });
    const renderRemind = () => {
      remindLine.textContent = '';
      if (readCfg().remind) remindLine.append(el('span', { class: 'da-muted' }, '已开启定期提醒：每 30 天在豆瓣首页提醒一次。'));
      else remindLine.append('需要定期提醒你备份吗？', el('a', { class: 'da-link', onclick: () => { writeCfg('remind', true); renderRemind(); } }, '每 30 天提醒我'));
    };
    renderRemind();
    showCard('导出完成', [
      el('div', {}, allOk ? el('span', { class: 'da-ok' }, '✓ ') : null, el('b', {}, formatNumber(total)), ` 条（私密 ${priv} 条）`,
        allOk ? `，${data.meta.shelves.length} 个书架全部核对一致` : ''),
      el('table', { class: 'da-table' }, rows.map((r) => el('tr', {}, el('td', {}, r.type), el('td', {},
        r.items.map((it, i) => [i ? ' · ' : '', it.ok
          ? `${it.label} ${formatNumber(it.fetched)}`
          : el('span', { class: 'da-bad' }, `${it.label} ${formatNumber(it.fetched)} ⚠ 豆瓣显示 ${formatNumber(it.total)}`)]))))),
      allOk ? null : el('div', { class: 'da-muted' }, '有书架条数对不上，详情见 .json 文件的 meta；可以稍后重新导出。'),
      el('div', { style: 'margin-top:6px' }, '已下载 ', el('b', {}, '.json'), '（完整存档）与 ', el('b', {}, '-neodb.zip'), '（可导入 NeoDB）。'),
      el('div', { class: 'da-warn' }, '⚠ 导入 NeoDB 时请把可见性选为"仅自己"，否则私密标记会被公开。'),
      remindLine,
    ], [
      btn('再下载一次', () => download(io.getValue(PROGRESS_KEY)), true),
      btn('完成，清除缓存', () => { clearStorage(); hideCard(); }),
    ], true);
  }

  async function run(progress) {
    if (running) return;
    running = true;
    cancelRequested = false;
    const startedAt = Date.now();
    const fetchedAtStart = totalFetched(progress);
    let result;
    try {
      result = await runExport({
        progress, io, ck: readCk(), now: Date.now,
        isCancelled: () => cancelRequested,
        onUpdate: (u) => showRunning(u, startedAt, fetchedAtStart, progress.grandTotal),
      });
    } catch (e) {
      // 比如存储写满：进度停在上一个页边界，可以再试
      showCard('出错了', [el('div', {}, `导出出错：${e && e.message}`), el('div', { class: 'da-muted' }, '已取到的部分保留 24 小时。')],
        [btn('放弃', abandon, true), btn('继续', resume)]);
      return;
    } finally {
      running = false;
    }

    const got = formatNumber(totalFetched(progress));
    if (result.state === 'cancelled') {
      clearStorage();
      showCard('已取消', [el('div', {}, '已取到的数据已清除。')], [btn('关闭', hideCard)], true);
    } else if (result.state === 'paused') {
      showCard('已暂停', [
        el('div', {}, '豆瓣暂时没有返回数据，可能需要安全验证。'),
        el('ol', {}, el('li', {}, '点"打开豆瓣"，按提示完成验证'), el('li', {}, '回到这里点"继续"，从断点接着导')),
        el('div', { class: 'da-muted' }, `停在 ${shelfLabel(result.shelf)}，已取 ${got} 条，进度保留 24 小时。（${result.reason}）`),
      ], [btn('放弃', abandon, true), btn('打开豆瓣', () => window.open('https://m.douban.com/mine/', '_blank'), true), btn('继续', resume)]);
    } else if (result.state === 'failed') {
      showCard('导出停止', [
        el('div', {}, `豆瓣返回错误（${shelfLabel(result.shelf)}）：${result.http} ${result.code || ''} ${result.msg || ''}`),
        el('div', { class: 'da-muted' }, `没有下载半份数据。已取 ${got} 条，保留 24 小时，可以稍后点"继续"再试。`),
      ], [btn('放弃', abandon, true), btn('继续', resume)]);
    } else {
      const data = download(progress);
      writeCfg('lastExportAt', Date.now());
      removeEntry();
      showDone(data);
    }
  }

  async function startExport() {
    if (running) return;
    const existing = io.getValue(PROGRESS_KEY);
    if (isProgressFresh(existing, Date.now()) && existing.shelfIndex < SHELVES.length) {
      showCard('有一份未完成的导出', [el('div', {}, `已取 ${formatNumber(totalFetched(existing))} 条，可以从断点接着导。`)],
        [btn('从头开始', startFresh, true), btn('继续', resume)], true);
      return;
    }
    startFresh();
  }

  async function startFresh() {
    if (running) return;
    showCard('导出我的标记', [el('div', { class: 'da-muted' }, '正在读取当前用户与标记总数…')], [], true);
    let user, grandTotal;
    try {
      user = await resolveUser();
      grandTotal = await fetchGrandTotal(user.numericId);
    } catch (e) {
      showCard('导出我的标记', [el('div', {}, e.message)], [btn('关闭', hideCard)], true);
      return;
    }
    showCard('导出我的标记', [
      el('div', {}, grandTotal
        ? ['共 ', el('b', {}, formatNumber(grandTotal)), ' 条标记，预计约 ', el('b', {}, `${minutes(estimateTotalMs(grandTotal))} 分钟`), '。']
        : '标记越多越久，约一万条要 20 分钟左右。'),
      el('div', {}, '导出期间请保持本标签页打开；中途关掉也没关系，24 小时内可回来继续。'),
      el('div', { style: 'margin-top:8px' }, '完成后下载两个文件：'),
      el('ul', {}, el('li', {}, el('b', {}, '.json'), ' 完整存档（含私密）'), el('li', {}, el('b', {}, '-neodb.zip'), ' 可导入 NeoDB')),
      el('div', { class: 'da-muted' }, '数据只在你的浏览器里处理，不上传到任何地方。'),
    ], [btn('取消', hideCard, true), btn('开始导出', () => {
      clearStorage();
      const progress = createProgress(user.username, user.numericId, Date.now());
      progress.grandTotal = grandTotal;
      io.setValue(PROGRESS_KEY, progress);
      run(progress);
    })], true);
  }

  function toggleRemind() {
    const on = !readCfg().remind;
    writeCfg('remind', on);
    showCard('定期提醒', [el('div', {}, on ? '已开启：距上次导出满 30 天时，在豆瓣首页侧栏提醒一次。' : '已关闭定期提醒。')],
      [btn('好', hideCard)], true);
  }

  GM_registerMenuCommand('导出全部标记', startExport);
  GM_registerMenuCommand('开启 / 关闭定期提醒', toggleRemind);

  // 关掉页面也能续：有未完成的进度就提示；过期的清掉
  const pending = io.getValue(PROGRESS_KEY);
  if (pending && !isProgressFresh(pending, Date.now())) {
    clearStorage();
  } else if (pending && pending.shelfIndex < SHELVES.length) {
    showCard('有一份未完成的导出', [el('div', {}, `已取 ${formatNumber(totalFetched(pending))} 条，可以从断点接着导。`)],
      [btn('放弃', abandon, true), btn('继续', resume)], true);
  }
  renderEntry();
})();
