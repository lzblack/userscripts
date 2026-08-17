'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseAppId,
  parseDate,
  htmlToText,
  normalizeLatin,
  normalizeCjk,
  isTitleMatch,
  mapGenres,
  mapPlatforms,
  coverCandidates,
  isSupportedType,
  isPayloadFresh,
  parseGameSearchResults,
  buildPayload,
  classifyDedup,
  buildFillPlan,
} = require('./douban-add-game.user.js');

// ── Steam appdetails 样本（字段取自实测响应，正文截短） ────────────────────────
// 1145360 Hades：无中文商店名（schinese name 仍是 "Hades"）。
const HADES_ZH = {
  name: 'Hades',
  short_description: '挑战死神，在地狱中杀出血路。',
  about_the_game:
    '<span class="bb_img_ctn"><video class="bb_img" autoplay muted loop playsinline poster="https://x/p.avif" width=600 height=338 >' +
    '<source src="https://x/a.webm" type="video/webm; codecs=vp9"></video></span><br>' +
    '<strong>Hades</strong> 是一款高自由度砍杀型地下城游戏。' +
    '<h2 class="bb_tag" >杀出地狱</h2>作为不朽的冥界王子，你将挥舞着来自奥林匹斯山的武器。' +
    '<ul class="bb_ul"><li>肉鸽式玩法<br></li><li>数千种武器组合<br></li></ul>' +
    '<img src="https://x/img.jpg">Supergiant &amp; Co.',
  website: 'http://www.supergiantgames.com',
  header_image:
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1145360/header.jpg?t=1758127023',
  developers: ['Supergiant Games'],
  publishers: ['Supergiant Games'],
  platforms: { windows: true, mac: true, linux: false },
  genres: [
    { id: '1', description: '动作' },
    { id: '23', description: '独立' },
    { id: '3', description: '角色扮演' },
  ],
  release_date: { coming_soon: false, date: '2020 年 9 月 17 日' },
};
const HADES_EN = {
  name: 'Hades',
  release_date: { coming_soon: false, date: 'Sep 17, 2020' },
};

// 2358720 黑神话：悟空——有中文商店名，中英名都在。
const WUKONG_ZH = {
  name: '黑神话：悟空',
  short_description: '《黑神话：悟空》是一款以中国神话为背景的动作角色扮演游戏。',
  about_the_game: '<p>你将扮演一位「天命人」。</p>',
  website: 'https://www.heishenhua.com',
  developers: ['Game Science'],
  publishers: ['Game Science'],
  platforms: { windows: true, mac: false, linux: false },
  genres: [
    { id: '1', description: '动作' },
    { id: '25', description: '冒险' },
    { id: '3', description: '角色扮演' },
  ],
  release_date: { coming_soon: false, date: '2024 年 8 月 19 日' },
};
const WUKONG_EN = {
  name: 'Black Myth: Wukong',
  release_date: { coming_soon: false, date: 'Aug 19, 2024' },
};

const AT = 1_700_000_000_000;
const build = (zh, en, appid) =>
  buildPayload({ zh, en, appid, url: `https://store.steampowered.com/app/${appid}/`, now: AT });

// ── parseAppId ──────────────────────────────────────────────────────────────
test('parseAppId: 取 /app/{id}/ 的数字段', () => {
  assert.equal(parseAppId('/app/1145360/Hades/'), 1145360);
  assert.equal(parseAppId('/app/1145360'), 1145360);
  assert.equal(parseAppId('/app/1145360/Hades/?snr=1_7_7_230_150_1'), 1145360);
  // 年龄门页面同样落在 /app/{id}/ 下，因此不需要特判
  assert.equal(parseAppId('/agecheck/app/1145360/'), 1145360);
});

test('parseAppId: 非 app 页返回 null', () => {
  assert.equal(parseAppId('/search/?term=hades'), null);
  assert.equal(parseAppId('/bundle/232/'), null);
  assert.equal(parseAppId(''), null);
  assert.equal(parseAppId(null), null);
});

// ── parseDate ───────────────────────────────────────────────────────────────
test('parseDate: 解析 Steam 英文发行日期', () => {
  assert.deepEqual(parseDate('Sep 17, 2020'), { y: 2020, m: 9, d: 17 });
  assert.deepEqual(parseDate('Aug 19, 2024'), { y: 2024, m: 8, d: 19 });
  assert.deepEqual(parseDate('December 10, 2020'), { y: 2020, m: 12, d: 10 });
  assert.deepEqual(parseDate('Q3 2026'), { y: 2026, m: null, d: null });
  assert.deepEqual(parseDate('2026'), { y: 2026, m: null, d: null });
});

test('parseDate: 无年份或未定档返回 null', () => {
  assert.equal(parseDate('Coming soon'), null);
  assert.equal(parseDate('To be announced'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
});

// ── htmlToText ──────────────────────────────────────────────────────────────
test('htmlToText: 丢弃媒体、块级换行、li 加前缀、解实体', () => {
  const t = htmlToText(HADES_ZH.about_the_game);
  assert.ok(!/video|source|img|<|>/.test(t), `残留标签: ${t}`);
  assert.ok(t.startsWith('Hades 是一款高自由度砍杀型地下城游戏。'), t);
  assert.ok(t.includes('\n杀出地狱\n'), t); // h2 前后成块
  assert.ok(t.includes('· 肉鸽式玩法'), t);
  assert.ok(t.includes('· 数千种武器组合'), t);
  assert.ok(t.endsWith('Supergiant & Co.'), t); // &amp; 已解码
});

test('htmlToText: 空白折叠且不留超过一个空行', () => {
  const t = htmlToText('<p>一</p><br><br><br><p>二</p>');
  assert.equal(t, '一\n\n二');
  assert.equal(htmlToText('&nbsp;&nbsp;a&nbsp;b'), 'a b');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
});

// ── 标题归一 / 匹配 ─────────────────────────────────────────────────────────
test('normalizeLatin / normalizeCjk: 各取一路字符', () => {
  assert.equal(normalizeLatin('哈迪斯 Hades'), 'hades');
  assert.equal(normalizeLatin("Hades' Star: DARK NEBULA"), 'hadesstardarknebula');
  assert.equal(normalizeLatin('Sam & Max'), 'samandmax');
  assert.equal(normalizeCjk('黑神话：悟空 Black Myth: Wukong'), '黑神话悟空');
  assert.equal(normalizeCjk('Hades'), '');
});

test('isTitleMatch: 中英任一路精确相等即命中', () => {
  const hades = build(HADES_ZH, HADES_EN, 1145360);
  const wukong = build(WUKONG_ZH, WUKONG_EN, 2358720);
  assert.equal(isTitleMatch('哈迪斯 Hades', hades), true); // 英文路命中
  assert.equal(isTitleMatch('黑神话：悟空 Black Myth: Wukong', wukong), true);
  assert.equal(isTitleMatch('黑神话：悟空', wukong), true); // 中文路命中
  assert.equal(isTitleMatch('哈迪斯2 Hades II', hades), false);
  assert.equal(isTitleMatch("冥王星：黑暗星云 Hades' Star: DARK NEBULA", hades), false);
});

test('isTitleMatch: 空归一结果不算命中（纯中文条目 vs 纯英文 payload）', () => {
  const hades = build(HADES_ZH, HADES_EN, 1145360);
  assert.equal(isTitleMatch('仙剑奇侠传', hades), false); // 双方 CJK 都不为空才比
  assert.equal(isTitleMatch('', hades), false);
});

// ── 类型 / 平台映射 ─────────────────────────────────────────────────────────
test('mapGenres: 按 Steam genre id 映射，无对应的进 unmapped', () => {
  const r = mapGenres(HADES_ZH.genres);
  assert.deepEqual(r.genres, [
    { id: 1, name: '动作' },
    { id: 5, name: '角色扮演' },
  ]);
  assert.deepEqual(r.unmapped, ['独立']); // Steam 23 Indie 在豆瓣无对应
});

test('mapGenres: 覆盖全部七条映射且去重', () => {
  const ids = [1, 2, 3, 9, 18, 25, 28].map((id) => ({ id: String(id), description: 'x' }));
  assert.deepEqual(mapGenres(ids).genres.map((g) => g.id), [1, 2, 5, 6, 3, 4, 7]);
  const dup = mapGenres([{ id: '1', description: 'a' }, { id: '1', description: 'a' }]);
  assert.equal(dup.genres.length, 1);
  assert.deepEqual(mapGenres(null), { genres: [], unmapped: [] });
});

test('mapPlatforms: 只映射 Steam 能确知的三个', () => {
  assert.deepEqual(mapPlatforms({ windows: true, mac: true, linux: false }), [
    { id: 94, name: 'PC' },
    { id: 17, name: 'Mac' },
  ]);
  assert.deepEqual(mapPlatforms({ windows: true, mac: false, linux: true }), [
    { id: 94, name: 'PC' },
    { id: 152, name: 'Linux' },
  ]);
  assert.deepEqual(mapPlatforms(null), []);
});

// ── 封面 ────────────────────────────────────────────────────────────────────
const A = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';

test('coverCandidates: 两种基址同源时去重，竖版优先、header 兜底', () => {
  assert.deepEqual(coverCandidates(`${A}/1145360/header.jpg?t=1758127023`, 1145360), [
    `${A}/1145360/library_600x900_2x.jpg`,
    `${A}/1145360/library_600x900.jpg`,
    `${A}/1145360/header.jpg?t=1758127023`,
  ]);
});

test('coverCandidates: 带哈希段时哈希基址与 appid 裸基址都要试', () => {
  // 实测 3807750 的 header 在 .../apps/3807750/d0e9…/ 下；而 1091500 反过来，
  // 竖版只存在于 appid 裸路径上——所以两条都得进候选。
  const hash = 'd0e999375da882ad74494708486dc3e3db7344cd';
  const hashed = `${A}/3807750/${hash}/header.jpg?t=1786979515`;
  assert.deepEqual(coverCandidates(hashed, 3807750), [
    `${A}/3807750/${hash}/library_600x900_2x.jpg`,
    `${A}/3807750/library_600x900_2x.jpg`,
    `${A}/3807750/${hash}/library_600x900.jpg`,
    `${A}/3807750/library_600x900.jpg`,
    hashed,
  ]);
});

test('coverCandidates: 无 header 时仍可凭 appid 试竖版；两者皆无则空', () => {
  assert.deepEqual(coverCandidates('', 1145360), [
    `${A}/1145360/library_600x900_2x.jpg`,
    `${A}/1145360/library_600x900.jpg`,
  ]);
  assert.deepEqual(coverCandidates('', null), []);
  assert.deepEqual(coverCandidates(null, null), []);
  assert.deepEqual(coverCandidates('https://x/weird', null), ['https://x/weird']);
});

test('isSupportedType: 只接 game，DLC/原声带/demo 一律不接', () => {
  assert.equal(isSupportedType('game'), true);
  assert.equal(isSupportedType('music'), false); // 1206340 Hades Original Soundtrack
  assert.equal(isSupportedType('dlc'), false);
  assert.equal(isSupportedType('demo'), false);
  assert.equal(isSupportedType(undefined), false);
});

// ── isPayloadFresh ──────────────────────────────────────────────────────────
test('isPayloadFresh: TTL 窗口内为真', () => {
  const p = { source: { capturedAt: 1000 } };
  assert.equal(isPayloadFresh(p, 1500, 300), false); // 已过期
  assert.equal(isPayloadFresh(p, 1500, 600), true); // 边界内
  assert.equal(isPayloadFresh(p, 1500, 500), false); // 边界上（严格小于）
  assert.equal(isPayloadFresh({}, 1500, 600_000), false);
  assert.equal(isPayloadFresh(null, 1500, 600_000), false);
});

// ── buildPayload ────────────────────────────────────────────────────────────
test('buildPayload: 无中文名时中英同名，别名为空', () => {
  const p = build(HADES_ZH, HADES_EN, 1145360);
  assert.equal(p.appid, 1145360);
  assert.equal(p.title, 'Hades');
  assert.equal(p.titleEn, 'Hades');
  assert.deepEqual(p.aliases, []);
  assert.equal(p.hasChineseName, false);
  assert.deepEqual(p.developers, ['Supergiant Games']);
  assert.deepEqual(p.releaseDate, { y: 2020, m: 9, d: 17 }); // 取自英文响应
  assert.equal(p.comingSoon, false);
  assert.deepEqual(p.genres.map((g) => g.id), [1, 5]);
  assert.deepEqual(p.unmappedGenres, ['独立']);
  assert.deepEqual(p.platforms.map((x) => x.id), [94, 17]);
  assert.equal(p.website, 'http://www.supergiantgames.com');
  assert.ok(p.description.startsWith('Hades 是一款高自由度砍杀型地下城游戏。'));
  assert.equal(p.coverCandidates.length, 3);
  assert.ok(p.coverCandidates[0].endsWith('/1145360/library_600x900_2x.jpg'));
  assert.equal(p.source.name, 'steam');
  assert.equal(p.source.capturedAt, AT);
});

test('buildPayload: 有中文名时正标题用中文、英文名进别名', () => {
  const p = build(WUKONG_ZH, WUKONG_EN, 2358720);
  assert.equal(p.title, '黑神话：悟空');
  assert.equal(p.titleEn, 'Black Myth: Wukong');
  assert.deepEqual(p.aliases, ['Black Myth: Wukong']);
  assert.equal(p.hasChineseName, true);
  assert.deepEqual(p.releaseDate, { y: 2024, m: 8, d: 19 });
});

test('buildPayload: 未发售走 comingSoon，日期可为 null', () => {
  const zh = { ...HADES_ZH, release_date: { coming_soon: true, date: '即将推出' } };
  const en = { name: 'Hades', release_date: { coming_soon: true, date: 'Coming soon' } };
  const p = build(zh, en, 1145360);
  assert.equal(p.comingSoon, true);
  assert.equal(p.releaseDate, null);
});

test('buildPayload: 英文响应缺失时退回中文响应，不崩', () => {
  const p = build(HADES_ZH, null, 1145360);
  assert.equal(p.titleEn, 'Hades'); // 无英文响应就沿用 schinese name
  assert.equal(p.releaseDate, null); // 中文日期不解析，宁缺勿错
  assert.ok(p.warnings.includes('缺发行日期'));
});

test('buildPayload: 简介缺失时退回 short_description 并告警', () => {
  const p = build({ ...HADES_ZH, about_the_game: '' }, HADES_EN, 1145360);
  assert.equal(p.description, '挑战死神，在地狱中杀出血路。');
  const empty = build({ ...HADES_ZH, about_the_game: '', short_description: '' }, HADES_EN, 1145360);
  assert.equal(empty.description, '');
  assert.ok(empty.warnings.includes('缺简介'));
});

// ── parseGameSearchResults ──────────────────────────────────────────────────
const SEARCH_HTML = fs.readFileSync(path.join(__dirname, 'fixture-search.html'), 'utf8');

test('parseGameSearchResults: 从 sid 重建裸条目 URL，不用 link2 包装', () => {
  const items = parseGameSearchResults(SEARCH_HTML);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: 30397999,
    title: '哈迪斯 Hades',
    url: 'https://www.douban.com/game/30397999/',
    rating: '9.2',
    cast: '游戏 / 乱斗/清版 / 角色扮演 / 动作 PC / iPhone / iPad / PS5 / XSX / Nintendo Switch / Steam Deck / PS4 / Xbox One',
  });
});

test('parseGameSearchResults: 评价人数不足时 rating 为 null，标题实体已解码', () => {
  const items = parseGameSearchResults(SEARCH_HTML);
  assert.equal(items[2].rating, null);
  assert.equal(items[2].title, "冥王星：黑暗星云 Hades' Star: DARK NEBULA");
});

test('parseGameSearchResults: 空页/垃圾输入返回空数组', () => {
  assert.deepEqual(parseGameSearchResults('<div class="result-list"></div>'), []);
  assert.deepEqual(parseGameSearchResults(''), []);
  assert.deepEqual(parseGameSearchResults(null), []);
});

// ── classifyDedup ───────────────────────────────────────────────────────────
test('classifyDedup: 精确命中 → hit，附带条目与评分', () => {
  const p = build(HADES_ZH, HADES_EN, 1145360);
  const r = classifyDedup(p, parseGameSearchResults(SEARCH_HTML));
  assert.equal(r.kind, 'hit');
  assert.equal(r.item.id, 30397999);
  assert.equal(r.item.rating, '9.2');
});

test('classifyDedup: 有结果但不精确 → maybe，只留前三条', () => {
  const p = build({ ...HADES_ZH, name: 'Bastion' }, { ...HADES_EN, name: 'Bastion' }, 107100);
  const items = parseGameSearchResults(SEARCH_HTML);
  const r = classifyDedup(p, [...items, ...items]);
  assert.equal(r.kind, 'maybe');
  assert.equal(r.items.length, 3);
});

test('classifyDedup: 无结果 → none', () => {
  const p = build(HADES_ZH, HADES_EN, 1145360);
  assert.deepEqual(classifyDedup(p, []), { kind: 'none', items: [] });
});

// ── buildFillPlan ───────────────────────────────────────────────────────────
test('buildFillPlan: 有中文名的完整 payload —— 全字段就位、无告警', () => {
  const plan = buildFillPlan(build(WUKONG_ZH, WUKONG_EN, 2358720));
  const byLabel = Object.fromEntries(plan.texts.map((t) => [t.label, t.value]));
  assert.equal(byLabel['游戏名称'], '黑神话：悟空');
  assert.equal(byLabel['别名'], 'Black Myth: Wukong');
  assert.equal(byLabel['开发商'], 'Game Science');
  assert.equal(byLabel['发行商'], 'Game Science');
  assert.equal(byLabel['官方网站'], 'https://www.heishenhua.com');
  assert.deepEqual(plan.date, { field: '发行日期', y: 2024, m: 8, d: 19 });
  assert.deepEqual(plan.genreIds, [1, 4, 5]);
  assert.deepEqual(plan.platformIds, [94]);
  assert.ok(plan.textareas.some((a) => a.label === '游戏简介' && a.value.includes('天命人')));
  assert.deepEqual(plan.warnings, []);
});

test('buildFillPlan: 无中文名 → 不臆造翻译，出告警', () => {
  const plan = buildFillPlan(build(HADES_ZH, HADES_EN, 1145360));
  const byLabel = Object.fromEntries(plan.texts.map((t) => [t.label, t.value]));
  assert.equal(byLabel['游戏名称'], 'Hades');
  assert.ok(plan.warnings.some((w) => w.includes('中文名')));
  assert.ok(plan.warnings.some((w) => w.includes('独立'))); // 未映射类型要人工补
  assert.ok(plan.skipped.includes('别名'));
});

test('buildFillPlan: 未发售落「预计上市时间」而非「发行日期」', () => {
  const zh = { ...WUKONG_ZH, release_date: { coming_soon: true, date: '即将推出' } };
  const en = { ...WUKONG_EN, release_date: { coming_soon: true, date: 'Q4 2026' } };
  const plan = buildFillPlan(build(zh, en, 2358720));
  assert.equal(plan.date.field, '预计上市时间');
  assert.equal(plan.date.y, 2026);
  assert.equal(plan.date.m, null);
});

test('buildFillPlan: 空 payload 不抛异常', () => {
  const plan = buildFillPlan(null);
  assert.deepEqual(plan.texts, []);
  assert.deepEqual(plan.genreIds, []);
  assert.ok(plan.warnings.length > 0);
});
