'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getCategoryFromUrl,
  getCategoryFromItem,
  getSubjectId,
  cacheKey,
  interestUrl,
  parseIlmenInterest,
} = require('./douban-feed-mark.user.js');

// .abstract 的最小替身：getCategoryFromItem 只读 querySelector('.abstract').textContent
const itemWithAbstract = (text) => ({
  querySelector: (sel) => (sel === '.abstract' ? { textContent: text } : null),
});

// ── 类别识别 ──────────────────────────────────────────────────────────────

test('getCategoryFromUrl: 书影音走子域', () => {
  assert.equal(getCategoryFromUrl('https://book.douban.com/subject/1007305/'), 'book');
  assert.equal(getCategoryFromUrl('https://movie.douban.com/subject/1292052/'), 'movie');
  assert.equal(getCategoryFromUrl('https://music.douban.com/subject/1400895/'), 'music');
});

test('getCategoryFromUrl: 游戏在 www 上，没有自己的子域', () => {
  assert.equal(getCategoryFromUrl('https://www.douban.com/game/26817171/'), 'game');
  assert.equal(getCategoryFromUrl('https://www.douban.com/game/26817171/comments'), 'game');
});

test('getCategoryFromUrl: 认不出来就返回 null，绝不猜', () => {
  // 游戏频道首页、豆列里的裸条目链接、站外链接
  assert.equal(getCategoryFromUrl('https://www.douban.com/game/'), null);
  assert.equal(getCategoryFromUrl('https://www.douban.com/subject/10759791/'), null);
  assert.equal(getCategoryFromUrl('https://example.com/game/123'), null);
});

test('getCategoryFromItem: 只认「类别: 游戏」', () => {
  assert.equal(getCategoryFromItem(itemWithAbstract('类别: 游戏\n2001年SCEJ发行')), 'game');
  // 书影音条目根本不带这一行（13 个豆列 315 条实测），带别的类别一律跳过
  assert.equal(getCategoryFromItem(itemWithAbstract('作者: 博尔赫斯\n出版社: 浙江文艺')), null);
  assert.equal(getCategoryFromItem(itemWithAbstract('类别: 网页')), null);
  assert.equal(getCategoryFromItem(itemWithAbstract('类别: 日记')), null);
});

// ── id 提取 ───────────────────────────────────────────────────────────────

test('getSubjectId: /subject/ 和 /game/ 两种形态', () => {
  assert.equal(getSubjectId('https://book.douban.com/subject/1007305/'), '1007305');
  assert.equal(getSubjectId('https://www.douban.com/game/26817171/'), '26817171');
  // 豆列里的游戏条目用的是裸 /subject/ 链接，id 与 /game/ 空间通用
  assert.equal(getSubjectId('https://www.douban.com/subject/10759791/'), '10759791');
  assert.equal(getSubjectId('https://www.douban.com/game/'), null);
});

// ── 缓存键 ────────────────────────────────────────────────────────────────

test('cacheKey: 同一个数字 id 在不同类别下不能撞车', () => {
  assert.notEqual(cacheKey('10759791', 'game'), cacheKey('10759791', 'book'));
  assert.match(cacheKey('10759791', 'game'), /^dfm:v3:game:10759791$/);
});

// ── 接口地址 ──────────────────────────────────────────────────────────────

test('interestUrl: 游戏走 ilmen，书影音走子域 subject', () => {
  assert.equal(
    interestUrl('26817171', 'game'),
    'https://www.douban.com/j/ilmen/thing/26817171/interest'
  );
  assert.equal(
    interestUrl('1007305', 'book'),
    'https://book.douban.com/j/subject/1007305/interest'
  );
  assert.equal(interestUrl('123', 'podcast'), null);
});

// ── ilmen 响应解析（真实抓包，2026-07-30，已登录）──────────────────────────

test('parseIlmenInterest: 标记过 → action + is_modify 同时成立', () => {
  // 塞尔达传说 旷野之息，在玩
  assert.deepEqual(
    parseIlmenInterest({ r: 0, action: 'do', is_modify: true, rating: null }),
    { status: 'do', rating: 0 }
  );
  // 潜伏之赤途，想玩
  assert.deepEqual(
    parseIlmenInterest({ r: 0, action: 'wish', is_modify: true, rating: null }),
    { status: 'wish', rating: 0 }
  );
});

test('parseIlmenInterest: 未标记 → action 为 null、is_modify 为 false', () => {
  // 英杰们的诗篇 / 巫师3血与酒 / GTA5 三个未标记条目返回的都是这一组
  assert.deepEqual(
    parseIlmenInterest({ r: 0, action: null, is_modify: false, rating: null }),
    { status: null, rating: 0 }
  );
});

test('parseIlmenInterest: 两个条件缺一不可，避免整页误盖印章', () => {
  assert.equal(parseIlmenInterest({ r: 0, action: 'wish', is_modify: false }).status, null);
  assert.equal(parseIlmenInterest({ r: 0, action: null, is_modify: true }).status, null);
});

test('parseIlmenInterest: r 非 0 是错误响应（未登录时是 r:1 code:403）', () => {
  assert.deepEqual(
    parseIlmenInterest({ r: 1, code: 403 }),
    { status: null, rating: 0 }
  );
});

test('parseIlmenInterest: rating 是 1-5 的数字，只在标记过时才读', () => {
  assert.deepEqual(
    parseIlmenInterest({ r: 0, action: 'collect', is_modify: true, rating: 4 }),
    { status: 'collect', rating: 4 }
  );
  assert.equal(parseIlmenInterest({ r: 0, action: null, is_modify: false, rating: 5 }).rating, 0);
});

// 书影音那条解析（parseSubjectInterest）依赖 DOMParser，node 里没有，
// 和仓库其他脚本一样只在浏览器里手测；本次也没有改动它的逻辑。
