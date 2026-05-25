'use strict';

// Unit tests for the pure cross-platform matching/disambiguation helpers.
// Run: node --test douban-rating-hub/test/match.test.cjs
//
// Covers the v1.1.7 fix where Rotten Tomatoes / Metacritic matched a wrong-year
// same-title film (Douban 36929221 "Lee Cronin's The Mummy" 2026 picked up the
// 1999 classic's score). Data is transcribed from / parsed out of live RT/MC
// responses captured 2026-05-25.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rh = require('../douban-rating-hub.user.js');

// Real RT search rows for query "The Mummy" (release-year + normalized title + href),
// in RT relevance order. RT's list is clean (every row is an actual Mummy film).
function rtMummyCandidates() {
  return [
    { nameNorm: 'leecroninsthemummy', year: '2026', href: 'https://www.rottentomatoes.com/m/lee_cronins_the_mummy' },
    { nameNorm: 'themummy', year: '1999', href: 'https://www.rottentomatoes.com/m/the_mummy' },
    { nameNorm: 'themummy', year: '2026', href: 'https://www.rottentomatoes.com/m/the_mummy_2026_2' },
    { nameNorm: 'themummy', year: '2017', href: 'https://www.rottentomatoes.com/m/the_mummy_2017' },
    { nameNorm: 'themummyreturns', year: '2001', href: 'https://www.rottentomatoes.com/m/the_mummy_returns' },
  ];
}

test('normalizeTitle strips punctuation/case and maps & to and', () => {
  assert.strictEqual(rh.normalizeTitle("Lee Cronin's The Mummy"), 'leecroninsthemummy');
  assert.strictEqual(rh.normalizeTitle('Fast & Furious'), 'fastandfurious');
  assert.strictEqual(rh.normalizeTitle('  The Mummy  '), 'themummy');
});

test('yearWithinOne: same year and ±1 are within tolerance', () => {
  assert.strictEqual(rh.yearWithinOne(2026, 2026), true);
  assert.strictEqual(rh.yearWithinOne(2025, 2026), true);   // CN release often lags
  assert.strictEqual(rh.yearWithinOne('2026', 2026), true); // string coercion
});

test('yearWithinOne: far-off years and missing values are rejected', () => {
  assert.strictEqual(rh.yearWithinOne(1999, 2026), false);
  assert.strictEqual(rh.yearWithinOne(null, 2026), false);
  assert.strictEqual(rh.yearWithinOne(2026, undefined), false);
  assert.strictEqual(rh.yearWithinOne('', 2026), false);
});

test('pickByYearThenTitle: with year, picks the year-matching film by rank (the bug fix)', () => {
  // Douban year 2026 -> must select Lee Cronin's (2026), NOT the 1999 classic.
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', '2026');
  assert.ok(chosen, 'expected a match');
  assert.match(chosen.href, /lee_cronins_the_mummy/);
});

test('pickByYearThenTitle: year 2026 must NOT return the 1999 classic', () => {
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', '2026');
  assert.doesNotMatch(chosen.href, /\/m\/the_mummy$/);
});

test('pickByYearThenTitle: an existing classic film still resolves correctly (no regression)', () => {
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', '1999');
  assert.match(chosen.href, /\/m\/the_mummy$/);
});

test('pickByYearThenTitle: 2017 remake resolves to the 2017 entry', () => {
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', '2017');
  assert.match(chosen.href, /the_mummy_2017/);
});

test('pickByYearThenTitle: no year falls back to exact-title match', () => {
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', null);
  assert.ok(chosen);
  assert.strictEqual(chosen.nameNorm, 'themummy');
});

test('pickByYearThenTitle: year known but none match falls back to exact-title (no over-rejection)', () => {
  const chosen = rh.pickByYearThenTitle(rtMummyCandidates(), 'themummy', '2050');
  assert.ok(chosen);
  assert.strictEqual(chosen.nameNorm, 'themummy');
});

test('pickByYearThenTitle: a year-matching but title-IRRELEVANT candidate is never chosen', () => {
  // MC-style fuzzy results: an unrelated 2026 film ranked above the real one.
  // Title-relevance filter must exclude it, even though its year matches.
  const cands = [
    { nameNorm: 'nirvannathebandtheshowthemovie', year: '2026', href: '/movie/nirvanna/' },
    { nameNorm: 'leecroninsthemummy', year: '2026', href: '/movie/lee-cronins-the-mummy/' },
    { nameNorm: 'thepowerofthedog', year: '2021', href: '/movie/the-power-of-the-dog/' },
  ];
  const chosen = rh.pickByYearThenTitle(cands, 'themummy', '2026');
  assert.match(chosen.href, /lee-cronins-the-mummy/);
});

test('pickByYearThenTitle: empty candidates returns null', () => {
  assert.strictEqual(rh.pickByYearThenTitle([], 'themummy', '2026'), null);
});

test('pickByYearThenTitle: no title-relevant candidate returns null', () => {
  const cands = [{ nameNorm: 'thepowerofthedog', year: '2026', href: '/movie/x/' }];
  assert.strictEqual(rh.pickByYearThenTitle(cands, 'themummy', '2026'), null);
});

test('pickByYearThenTitle: parses the real RT search fixture and picks Lee Cronin\'s 2026', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'rt-search-the-mummy.html'), 'utf8');
  const candidates = parseRtRows(html, rh.normalizeTitle);
  assert.ok(candidates.length >= 4, 'fixture should yield several rows');
  const chosen = rh.pickByYearThenTitle(candidates, rh.normalizeTitle('The Mummy'), '2026');
  assert.ok(chosen, 'expected a match from RT fixture');
  assert.match(chosen.href, /lee_cronins_the_mummy/);
});

test('pickByYearThenTitle: parses the real MC search fixture and picks Lee Cronin\'s 2026', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'mc-search-the-mummy.html'), 'utf8');
  const candidates = parseMcRows(html, rh.normalizeTitle);
  assert.ok(candidates.length >= 5, 'fixture should yield several rows');
  const chosen = rh.pickByYearThenTitle(candidates, rh.normalizeTitle('The Mummy'), '2026');
  assert.ok(chosen, 'expected a match from MC fixture');
  assert.match(chosen.href, /lee-cronins-the-mummy/);
});

test('earliestReleaseYear: picks the original year, ignoring later China re-releases', () => {
  // 海上钢琴师: Douban lists the 2019 China re-release FIRST, original 1998 last.
  // External DBs (RT/MC) index the original year, so we must use the earliest.
  assert.strictEqual(rh.earliestReleaseYear([
    '2019-11-15(中国大陆)', '2024-11-15(中国大陆重映)', '1998-10-28(意大利)',
  ]), '1998');
});

test('earliestReleaseYear: same-year release dates collapse to that year', () => {
  assert.strictEqual(rh.earliestReleaseYear([
    '2025-05-30(中国大陆)', '2025-05-14(戛纳国际电影节)', '2025-05-23(美国)',
  ]), '2025');
});

test('earliestReleaseYear: empty or yearless input returns null', () => {
  assert.strictEqual(rh.earliestReleaseYear([]), null);
  assert.strictEqual(rh.earliestReleaseYear(['no year here']), null);
});

test('extractRtDetailYear: reads releaseYear from detail-page JSON', () => {
  assert.strictEqual(rh.extractRtDetailYear('foo"releaseYear":"2026"bar'), 2026);
  assert.strictEqual(rh.extractRtDetailYear('x "releaseYear": "1999" y'), 1999);
  assert.strictEqual(rh.extractRtDetailYear('no year here'), null);
});

// --- fixture parsers: mirror the userscript's DOM extraction with regex ---

function parseRtRows(html, normalize) {
  const rows = [];
  const re = /<search-page-media-row\b[\s\S]*?<\/search-page-media-row>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const yearM = block.match(/release-year="(\d{0,4})"/);
    const nameM = block.match(/data-qa="info-name"[^>]*>\s*([\s\S]*?)\s*<\/a>/);
    // Pull href from the info-name <a> tag itself, order-independent (mirrors getAttribute).
    const aTagM = block.match(/<a\b[^>]*data-qa="info-name"[^>]*>/);
    const hrefM = aTagM ? aTagM[0].match(/href="([^"]*)"/) : null;
    if (!nameM) continue;
    rows.push({
      nameNorm: normalize(decode(nameM[1])),
      year: yearM ? yearM[1] : '',
      href: hrefM ? hrefM[1] : '',
    });
  }
  return rows;
}

function parseMcRows(html, normalize) {
  const rows = [];
  const chunks = html.split('<div class="search-item"').slice(1);
  for (const chunk of chunks) {
    const hrefM = chunk.match(/href="(\/(?:movie|tv)\/[^"]+)"/);
    const titleM = chunk.match(/c-search-item__title"[^>]*>\s*([\s\S]*?)\s*<\/p>/);
    const dateM = chunk.match(/release-date[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/);
    const yearM = dateM ? dateM[1].match(/(\d{4})/) : null;
    if (!titleM || !hrefM) continue;
    rows.push({
      nameNorm: normalize(decode(titleM[1])),
      year: yearM ? yearM[1] : '',
      href: hrefM[1],
    });
  }
  return rows;
}

function decode(s) {
  return s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

// ===========================================================================
// fetchSearchDetail — shared "search page → candidate link → detail page" helper
// used by the Letterboxd/Goodreads/Amazon title-search refactor. Tested with a
// fake `deps` (canned responses) so every branch is locked down without network.
// parseHTML is identity here, so opts.pickDetailHref/parseDetail receive the raw
// responseText — fine, since we're testing orchestration, not per-source parsing.
// ===========================================================================

function fakeDeps(handlers) {
  return {
    parseHTML: function (html) { return html; },
    request: function (url) {
      const h = handlers[url];
      if (h === undefined) return Promise.reject(new Error('no handler: ' + url));
      if (h instanceof Error) return Promise.reject(h);
      return Promise.resolve(h);
    },
  };
}
const SEARCH = 'https://site.test/search?q=x';
const okResp = (text, finalUrl) => ({ status: 200, responseText: text, finalUrl: finalUrl });

test('fetchSearchDetail: search response not ok → reachedDetail false, url=searchUrl', async () => {
  const deps = fakeDeps({ [SEARCH]: { status: 500, responseText: '', finalUrl: SEARCH } });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    pickDetailHref: () => 'SHOULD_NOT_BE_CALLED', parseDetail: () => ({ score: 1 }),
  });
  assert.deepStrictEqual(r, { reachedDetail: false, url: SEARCH });
});

test('fetchSearchDetail: search redirects straight to a detail page (isDetailUrl)', async () => {
  const deps = fakeDeps({ [SEARCH]: okResp('DETAIL_HTML', 'https://site.test/book/show/42') });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    isDetailUrl: (u) => /\/book\/show\//.test(u),
    pickDetailHref: () => { throw new Error('pickDetailHref must not run on direct-detail path'); },
    parseDetail: (doc, url) => ({ score: 7, doc: doc, url: url }),
  });
  assert.strictEqual(r.reachedDetail, true);
  assert.strictEqual(r.url, 'https://site.test/book/show/42');
  assert.strictEqual(r.parsed.score, 7);
  assert.strictEqual(r.parsed.doc, 'DETAIL_HTML'); // parseHTML(responseText) passed through
});

test('fetchSearchDetail: search ok but no candidate href → reachedDetail false, url=finalSearchUrl', async () => {
  const deps = fakeDeps({ [SEARCH]: okResp('SEARCH_HTML', 'https://site.test/search-final') });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    isDetailUrl: () => false, pickDetailHref: () => '', parseDetail: () => ({ score: 1 }),
  });
  assert.deepStrictEqual(r, { reachedDetail: false, url: 'https://site.test/search-final' });
});

test('fetchSearchDetail: relative href → detail ok → parsed (absolutized against baseUrl)', async () => {
  const deps = fakeDeps({
    [SEARCH]: okResp('SEARCH_HTML', SEARCH),
    'https://site.test/film/abc': okResp('DETAIL_HTML', 'https://site.test/film/abc'),
  });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    isDetailUrl: () => false,
    pickDetailHref: () => '/film/abc',
    parseDetail: () => ({ score: 8 }),
  });
  assert.strictEqual(r.reachedDetail, true);
  assert.strictEqual(r.url, 'https://site.test/film/abc');
  assert.strictEqual(r.parsed.score, 8);
});

test('fetchSearchDetail: absolute href is used as-is', async () => {
  const deps = fakeDeps({
    [SEARCH]: okResp('SEARCH_HTML', SEARCH),
    'https://other.test/d': okResp('DETAIL_HTML', 'https://other.test/d'),
  });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    isDetailUrl: () => false,
    pickDetailHref: () => 'https://other.test/d',
    parseDetail: () => ({ score: 9 }),
  });
  assert.strictEqual(r.reachedDetail, true);
  assert.strictEqual(r.url, 'https://other.test/d');
});

test('fetchSearchDetail: detail response rejected by acceptDetailResp → reachedDetail false, url=detailUrl', async () => {
  const detailUrl = 'https://site.test/film/x';
  const deps = fakeDeps({
    [SEARCH]: okResp('SEARCH_HTML', SEARCH),
    [detailUrl]: { status: 404, responseText: '', finalUrl: detailUrl },
  });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    pickDetailHref: () => '/film/x',
    acceptDetailResp: (resp) => resp.status >= 200 && resp.status < 300,
    parseDetail: () => ({ score: 1 }),
  });
  assert.deepStrictEqual(r, { reachedDetail: false, url: detailUrl });
});

test('fetchSearchDetail: detail request rejects → reachedDetail false, url=detailUrl', async () => {
  const detailUrl = 'https://site.test/film/y';
  const deps = fakeDeps({
    [SEARCH]: okResp('SEARCH_HTML', SEARCH),
    [detailUrl]: new Error('network'),
  });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    pickDetailHref: () => '/film/y', parseDetail: () => ({ score: 1 }),
  });
  assert.deepStrictEqual(r, { reachedDetail: false, url: detailUrl });
});

test('fetchSearchDetail: search request rejects → reachedDetail false, url=searchUrl', async () => {
  const deps = fakeDeps({ [SEARCH]: new Error('network') });
  const r = await rh.fetchSearchDetail(deps, {
    searchUrl: SEARCH, baseUrl: 'https://site.test',
    pickDetailHref: () => '/x', parseDetail: () => ({ score: 1 }),
  });
  assert.deepStrictEqual(r, { reachedDetail: false, url: SEARCH });
});

test('absolutizeUrl: relative joins baseUrl, absolute passes through, empty → empty', () => {
  assert.strictEqual(rh.absolutizeUrl('/a/b', 'https://x.test'), 'https://x.test/a/b');
  assert.strictEqual(rh.absolutizeUrl('https://y.test/c', 'https://x.test'), 'https://y.test/c');
  assert.strictEqual(rh.absolutizeUrl('', 'https://x.test'), '');
});
