'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHELVES, PAGE_SIZE, MAX_REFETCH, INTERVAL_MS, PROGRESS_TTL_MS,
  interestsUrl, parseUsernameFromUrl, classifyResponse,
  createProgress, isProgressFresh, pageKey, runExport, buildExport, exportFilename,
} = require('./douban-archive.user.js');

// ── 合成数据 ──────────────────────────────────────────────────────────────

const row = (id, isPrivate = false) => ({ id: String(id), is_private: isPrivate, subject: { id: `s${id}` } });
const rows = (from, to, isPrivate = false) => {
  const out = [];
  for (let i = from; i < to; i++) out.push(row(i, isPrivate));
  return out;
};
const ok = (total, interests) => ({ status: 200, responseText: JSON.stringify({ total, interests }) });

// 假服务端：handler(shelfKey, start, nthCallForThisPage) → 响应
function fakeServer(handler) {
  const calls = [];
  const counts = new Map();
  return {
    calls,
    request: async (url) => {
      const u = new URL(url);
      const key = `${u.searchParams.get('type')}/${u.searchParams.get('status')}`;
      const start = Number(u.searchParams.get('start'));
      const n = (counts.get(`${key}@${start}`) || 0) + 1;
      counts.set(`${key}@${start}`, n);
      calls.push({ key, start, n });
      return handler(key, start, n);
    },
  };
}

// 一个书架完整的数据，按 start 切页；total 含私密（§2：2026-10-23 全量导出证实）
const shelfServer = (all, total) => (key, start) => ok(total, all.slice(start, start + PAGE_SIZE));

function fakeIo(server) {
  const store = new Map();
  const sleeps = [];
  return {
    store, sleeps,
    request: server.request,
    sleep: async (ms) => { sleeps.push(ms); },
    setValue: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))),
    getValue: (k) => store.get(k),
  };
}

const ONE = [{ type: 'movie', status: 'mark', key: 'movie/mark' }];

async function exportOne(handler, shelves = ONE) {
  const server = fakeServer(handler);
  const io = fakeIo(server);
  const progress = createProgress('someone', '42', 0);
  const result = await runExport({ progress, io, shelves });
  return { server, io, progress, result, built: result.state === 'done' ? buildExport(progress, io.getValue, { now: 0, version: 't' }) : null };
}

const shelfMeta = (built, key) => built.meta.shelves.find((s) => `${s.type}/${s.status}` === key);

// ── 常量与 URL ────────────────────────────────────────────────────────────

test('SHELVES: 五类 × 想/在/过，舞台剧没有"在"，共 14 个', () => {
  assert.equal(SHELVES.length, 14);
  assert.ok(!SHELVES.some((s) => s.key === 'drama/doing'));
  assert.deepEqual(SHELVES.filter((s) => s.type === 'book').map((s) => s.status), ['mark', 'doing', 'done']);
});

test('interestsUrl: 数字 id、count=50、ck、for_mobile', () => {
  assert.equal(
    interestsUrl('1331681', 'movie', 'done', 150, 'abc'),
    'https://m.douban.com/rexxar/api/v2/user/1331681/interests?type=movie&status=done&start=150&count=50&ck=abc&for_mobile=1',
  );
});

test('parseUsernameFromUrl: 从 /mine/ 跳转后的地址读用户名', () => {
  assert.equal(parseUsernameFromUrl('https://www.douban.com/people/lzblack/'), 'lzblack');
  assert.equal(parseUsernameFromUrl('https://www.douban.com/people/1331681/?x=1'), '1331681');
  assert.equal(parseUsernameFromUrl('https://www.douban.com/mine/'), null);
  assert.equal(parseUsernameFromUrl('https://accounts.douban.com/passport/login'), null);
});

// ── 响应分类 ──────────────────────────────────────────────────────────────

test('classifyResponse: 200 + JSON 是数据', () => {
  const r = classifyResponse(ok(7, [row(1)]));
  assert.equal(r.kind, 'ok');
  assert.equal(r.total, 7);
  assert.equal(r.rows.length, 1);
});

test('classifyResponse: 缺 total 或 interests 时按 0 / 空处理', () => {
  const r = classifyResponse({ status: 200, responseText: '{}' });
  assert.deepEqual([r.kind, r.total, r.rows.length], ['ok', 0, 0]);
});

test('classifyResponse: 网络错误、超时、中止、不是 JSON 都暂停', () => {
  for (const failure of ['error', 'timeout', 'abort']) {
    assert.equal(classifyResponse({ failure }).kind, 'pause');
  }
  assert.equal(classifyResponse({ status: 200, responseText: '<html>安全验证</html>' }).kind, 'pause');
  assert.equal(classifyResponse({ status: 403, responseText: '' }).kind, 'pause');
});

test('classifyResponse: 带 code 的 JSON 或非 200 的 JSON 是失败（§2 见过 400/1287）', () => {
  const r = classifyResponse({ status: 400, responseText: JSON.stringify({ code: 1287, msg: 'invalid_request_1284' }) });
  assert.deepEqual([r.kind, r.http, r.code, r.msg], ['fail', 400, 1287, 'invalid_request_1284']);
  assert.equal(classifyResponse({ status: 200, responseText: JSON.stringify({ code: 999 }) }).kind, 'fail');
  assert.equal(classifyResponse({ status: 500, responseText: '{}' }).kind, 'fail');
});

// ── 翻页与停止 ────────────────────────────────────────────────────────────

test('翻页：120 条按 50 翻，短的末页重取 3 次，下一页空且 start ≥ total 直接停', async () => {
  const { server, result, built } = await exportOne(shelfServer(rows(0, 120), 120));
  assert.equal(result.state, 'done');
  assert.deepEqual(server.calls.map((c) => c.start), [0, 50, 100, 100, 100, 100, 150]);
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.fetched, m.private, m.consistent], [120, 0, true]);
  assert.deepEqual(m.anomalies, []);
});

test('短页（§2：34 条，重取得 50 条）按 id 合并', async () => {
  const all = rows(0, 100);
  const { server, built } = await exportOne((key, start, n) =>
    ok(100, start === 50 && n === 1 ? all.slice(50, 84) : all.slice(start, start + 50)));
  assert.deepEqual(server.calls.filter((c) => c.start === 50).length, 2);
  assert.equal(shelfMeta(built, 'movie/mark').fetched, 100);
  assert.deepEqual(built.interests.movie.mark.map((r) => r.id), all.map((r) => r.id));
});

test('重取各次缺的条目不同时取并集', async () => {
  const all = rows(0, 100);
  const page = all.slice(0, 50);
  const { built } = await exportOne((key, start, n) => {
    if (start === 0 && n === 1) return ok(100, page.filter((_, i) => i % 2 === 0));
    if (start === 0 && n === 2) return ok(100, page.filter((_, i) => i % 2 === 1));
    return ok(100, all.slice(start, start + 50));
  });
  assert.equal(shelfMeta(built, 'movie/mark').fetched, 100);
});

test('中途空页且 total: 0（§2 见过）重取后恢复，不当成结束', async () => {
  const all = rows(0, 150);
  const { built } = await exportOne((key, start, n) =>
    (start === 50 && n === 1 ? ok(0, []) : ok(150, all.slice(start, start + 50))));
  const m = shelfMeta(built, 'movie/mark');
  assert.equal(m.fetched, 150);
  assert.deepEqual(m.anomalies, []);
});

test('末页一直返回 total: 0 的空页：停，且不拿 0 覆盖已见到的 total', async () => {
  const all = rows(0, 120);
  const { built } = await exportOne((key, start) => (start >= 150 ? ok(0, []) : ok(120, all.slice(start, start + 50))));
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.lastTotal, m.fetched, m.consistent], [120, 120, true]);
});

test('total 含私密：61 条（1 条私密）、total 61，核对一致', async () => {
  const all = [...rows(0, 60), row(60, true)];
  const { built } = await exportOne(shelfServer(all, 61));
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.fetched, m.private, m.consistent], [61, 1, true]);
});

test('少取了条数等于私密数时不能算一致', async () => {
  const all = [...rows(0, 60), row(60, true)];
  const { built } = await exportOne((key, start) => ok(62, all.slice(start, start + 50)));
  assert.equal(shelfMeta(built, 'movie/mark').consistent, false);
});

test('total 偏小时多出来的条目也继续翻（不见短页就停）', async () => {
  const all = [...rows(0, 40), ...rows(40, 130, true)];
  const { built } = await exportOne(shelfServer(all, 40));
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.fetched, m.private, m.consistent], [130, 90, false]);
});

test('真的空书架：total: 0 的空页重取 3 次后停', async () => {
  const { server, built } = await exportOne(() => ok(0, []));
  assert.equal(server.calls.length, 1 + MAX_REFETCH);
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.fetched, m.consistent], [0, true]);
  assert.deepEqual(built.interests.movie.mark, []);
});

test('全是私密的书架：total 3、3 条，取到 3 条', async () => {
  const { built } = await exportOne(shelfServer(rows(0, 3, true), 3));
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.fetched, m.private, m.consistent], [3, 3, true]);
});

test('重取用完仍短、又不在末尾的页记为异常，继续翻', async () => {
  const all = rows(0, 150);
  const { built } = await exportOne((key, start) =>
    ok(150, start === 50 ? all.slice(50, 80) : all.slice(start, start + 50)));
  const m = shelfMeta(built, 'movie/mark');
  assert.equal(m.fetched, 130);
  assert.equal(m.consistent, false);
  assert.deepEqual(m.anomalies, [{ start: 50, got: 30 }]);
});

test('重取用完仍空、start 未到 total 的页记为异常，继续翻', async () => {
  const all = rows(0, 150);
  const { built } = await exportOne((key, start) =>
    (start === 50 ? ok(150, []) : ok(150, all.slice(start, start + 50))));
  const m = shelfMeta(built, 'movie/mark');
  assert.equal(m.fetched, 100);
  assert.deepEqual(m.anomalies, [{ start: 50, got: 0 }]);
});

test('导出中途 total 变化：meta 记首末 total', async () => {
  const all = rows(0, 100);
  const { built } = await exportOne((key, start) => ok(start === 0 ? 100 : 101, all.slice(start, start + 50)));
  const m = shelfMeta(built, 'movie/mark');
  assert.deepEqual([m.firstTotal, m.lastTotal], [100, 101]);
});

test('翻页错位导致同一条出现在两页：按 id 去重', async () => {
  const all = rows(0, 100);
  const { built } = await exportOne((key, start) =>
    ok(100, start === 50 ? [all[49], ...all.slice(50, 99)] : all.slice(start, start + 50)));
  const ids = built.interests.movie.mark.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('节奏：请求之间等 INTERVAL_MS，第一次请求前不等', async () => {
  const { server, io } = await exportOne(shelfServer(rows(0, 50), 50));
  assert.equal(io.sleeps.length, server.calls.length - 1);
  assert.ok(io.sleeps.every((ms) => ms === INTERVAL_MS));
});

test('多个书架依次导出，结果按类别与状态分组', async () => {
  const two = [ONE[0], { type: 'book', status: 'done', key: 'book/done' }];
  const { built } = await exportOne((key, start) =>
    (key === 'movie/mark' ? ok(2, rows(0, 2).slice(start)) : ok(1, rows(10, 11).slice(start))), two);
  assert.equal(built.interests.movie.mark.length, 2);
  assert.equal(built.interests.book.done.length, 1);
  assert.equal(built.meta.uid, 'someone');
  assert.equal(built.meta.numericId, '42');
});

// ── 暂停、续跑、失败、取消 ─────────────────────────────────────────────────

test('超时暂停，续跑从断点那一页重新取，结果完整', async () => {
  const all = rows(0, 120);
  let timeoutOnce = true;
  const server = fakeServer((key, start) => {
    if (start === 50 && timeoutOnce) { timeoutOnce = false; return { failure: 'timeout' }; }
    return ok(120, all.slice(start, start + 50));
  });
  const io = fakeIo(server);
  const progress = createProgress('u', '1', 0);
  const first = await runExport({ progress, io, shelves: ONE });
  assert.equal(first.state, 'paused');
  const saved = io.getValue('da:progress');
  assert.equal(saved.start, 50);
  assert.ok(io.getValue(pageKey('movie/mark', 0)));

  const second = await runExport({ progress: io.getValue('da:progress'), io, shelves: ONE });
  assert.equal(second.state, 'done');
  const built = buildExport(io.getValue('da:progress'), io.getValue, { now: 0, version: 't' });
  assert.equal(shelfMeta(built, 'movie/mark').fetched, 120);
  assert.equal(server.calls.filter((c) => c.start === 0).length, 1);
});

test('不是 JSON（安全验证跳转）暂停，原因写进结果', async () => {
  const { result } = await exportOne(() => ({ status: 200, responseText: '<!doctype html>' }));
  assert.equal(result.state, 'paused');
  assert.equal(result.reason, 'notJson');
});

test('带 code 的响应：失败，已取的页保留', async () => {
  const all = rows(0, 120);
  const { io, result } = await exportOne((key, start) =>
    (start === 50 ? { status: 400, responseText: JSON.stringify({ code: 1287, msg: 'x' }) } : ok(120, all.slice(start, start + 50))));
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 1287);
  assert.ok(io.getValue(pageKey('movie/mark', 0)));
  assert.equal(io.getValue('da:progress').start, 50);
});

test('取消：两次请求之间检查，不再发请求', async () => {
  const server = fakeServer(shelfServer(rows(0, 200), 200));
  const io = fakeIo(server);
  let cancel = false;
  const progress = createProgress('u', '1', 0);
  const origRequest = io.request;
  io.request = async (url) => { const r = await origRequest(url); if (server.calls.length === 2) cancel = true; return r; };
  const result = await runExport({ progress, io, shelves: ONE, isCancelled: () => cancel });
  assert.equal(result.state, 'cancelled');
  assert.equal(server.calls.length, 2);
});

test('onUpdate 报告当前书架与已取条数', async () => {
  const server = fakeServer(shelfServer(rows(0, 60), 60));
  const io = fakeIo(server);
  const updates = [];
  await runExport({ progress: createProgress('u', '1', 0), io, shelves: ONE, onUpdate: (u) => updates.push(u) });
  const last = updates[updates.length - 1];
  assert.equal(last.shelf.key, 'movie/mark');
  assert.equal(last.fetched, 60);
});

// ── 进度新鲜度、文件名 ────────────────────────────────────────────────────

test('isProgressFresh: 24 小时内有效', () => {
  const p = createProgress('u', '1', 1000);
  assert.equal(isProgressFresh(p, 1000 + PROGRESS_TTL_MS - 1), true);
  assert.equal(isProgressFresh(p, 1000 + PROGRESS_TTL_MS + 1), false);
  assert.equal(isProgressFresh(null, 0), false);
  assert.equal(isProgressFresh({ v: 999, updatedAt: 1000 }, 1000), false);
});

test('exportFilename: douban-archive-<uid>-<本地日期>.json', () => {
  assert.equal(exportFilename('lzblack', new Date(2026, 9, 3, 23, 59)), 'douban-archive-lzblack-2026-10-03.json');
});
