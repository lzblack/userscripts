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
  classifyInterestResponse,
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
  // 冒号写法的变体：排版扩展会插空格，实际页面上出现过「类别 : 游戏」
  assert.equal(getCategoryFromItem(itemWithAbstract('\n      \n          类别 : 游戏\n')), 'game');
  assert.equal(getCategoryFromItem(itemWithAbstract('类别：游戏')), 'game');
  assert.equal(getCategoryFromItem(itemWithAbstract('类别 ： 游戏')), 'game');
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

test('parseIlmenInterest: rating 是 1-5 的数字，只在标记过时才读', () => {
  assert.deepEqual(
    parseIlmenInterest({ r: 0, action: 'collect', is_modify: true, rating: 4 }),
    { status: 'collect', rating: 4 }
  );
  assert.equal(parseIlmenInterest({ r: 0, action: null, is_modify: false, rating: 5 }).rating, 0);
});

// ── 响应分类：失败绝不能当成「未标记」──────────────────────────────────────
// 失败（非 200、验证页/登录页 HTML、字段缺失）不缓存、不渲染，下次 scan 重新请求；
// 只有 ok 的响应才写缓存。以前失败也被缓存成未标记 24 小时，一次限流整页标记就没了。

const ILMEN_UNMARKED = '{"r": 0, "action": null, "is_modify": false, "rating": null}';

test('classifyInterestResponse: 非 200 一律失败（两个接口）', () => {
  // 未登录实测（2026-10-30，curl 匿名）：两个接口都是 403 + 这段 JSON
  const anon = '{"code": 403, "r": 1, "error": "???"}';
  assert.equal(classifyInterestResponse('game', 403, anon).ok, false);
  assert.equal(classifyInterestResponse('book', 403, anon).ok, false);
  assert.equal(classifyInterestResponse('movie', 429, '').ok, false);
  assert.equal(classifyInterestResponse('game', 500, ILMEN_UNMARKED).ok, false);
});

test('classifyInterestResponse: 未登录（403 + r:1 code:403）单独标出，其他失败不标', () => {
  const anon = '{"code": 403, "r": 1, "error": "???"}';
  assert.equal(classifyInterestResponse('game', 403, anon).loggedOut, true);
  assert.equal(classifyInterestResponse('book', 403, anon).loggedOut, true);
  // 限流、服务器错误、验证页不是未登录，下次 scan 还要重试
  assert.equal(classifyInterestResponse('book', 429, '').loggedOut, undefined);
  assert.equal(classifyInterestResponse('book', 403, '<html></html>').loggedOut, undefined);
  assert.equal(classifyInterestResponse('game', 500, anon).loggedOut, undefined);
  assert.equal(classifyInterestResponse('game', 200, ILMEN_UNMARKED).loggedOut, undefined);
});

test('classifyInterestResponse: 200 但响应体是 HTML（验证页/登录页被跟随重定向）→ 失败', () => {
  const page = '<!DOCTYPE html><html><head><title>登录豆瓣</title></head><body></body></html>';
  assert.equal(classifyInterestResponse('book', 200, page).ok, false);
  assert.equal(classifyInterestResponse('game', 200, page).ok, false);
  assert.equal(classifyInterestResponse('music', 200, '').ok, false);
});

test('classifyInterestResponse: 200 + JSON 但不是对象 → 失败', () => {
  assert.equal(classifyInterestResponse('book', 200, 'null').ok, false);
  assert.equal(classifyInterestResponse('game', 200, '[]').ok, false);
  assert.equal(classifyInterestResponse('movie', 200, '"ok"').ok, false);
});

test('classifyInterestResponse: ilmen 缺字段或 r 非 0 → 失败', () => {
  assert.equal(classifyInterestResponse('game', 200, '{}').ok, false);
  // 未登录时 ilmen 返回的就是 r:1 code:403，以前被当成未标记
  assert.equal(classifyInterestResponse('game', 200, '{"code": 403, "r": 1}').ok, false);
  assert.equal(classifyInterestResponse('game', 200, '{"r": 0, "is_modify": false}').ok, false);
  assert.equal(classifyInterestResponse('game', 200, '{"r": 0, "action": null}').ok, false);
});

test('classifyInterestResponse: ilmen 已登录未标记（真实抓包）→ ok', () => {
  const result = classifyInterestResponse('game', 200, ILMEN_UNMARKED);
  assert.equal(result.ok, true);
  assert.deepEqual(parseIlmenInterest(result.data), { status: null, rating: 0 });
});

test('classifyInterestResponse: 书影音 JSON 里既没有 html 也没有 interest_status → 失败', () => {
  assert.equal(classifyInterestResponse('book', 200, '{}').ok, false);
  assert.equal(classifyInterestResponse('movie', 200, '{"r": 0}').ok, false);
  assert.equal(classifyInterestResponse('music', 200, '{"code": 403, "r": 1}').ok, false);
});

test('classifyInterestResponse: 书影音 html 里没有标记表单 → 失败', () => {
  // 未标记的判断全靠表单里的 interest 单选框；没有表单就无从判断，不能当未标记
  assert.equal(classifyInterestResponse('book', 200, '{"html": ""}').ok, false);
  assert.equal(classifyInterestResponse('book', 200, '{"html": "<div>出错了</div>"}').ok, false);
});

test('classifyInterestResponse: 书影音已登录未标记（真实抓包）→ ok', () => {
  // book.douban.com/j/subject/38929993/interest，2026-10-30，已登录、未标记：
  // 200 application/json，没有 interest_status 键，只有 html（三个都没勾的 interest
  // 单选框 + 空的 #n_rating）和 my_tags/popular_tags/tags。html 删去了样式和分享区，
  // my_tags 清空。
  const body = JSON.stringify({
    my_tags: [],
    html: '\n<div class="indentpop1 clearfix">\n<form action="https://book.douban.com/j/subject/38929993/interest"\n  method="POST"\n  class="j a_interest_form book-sns">\n'
      + '    <span class="interest-status">\n'
      + '      <label><input type="radio" value="wish" name="interest"\n              />&nbsp;想读 </label>\n'
      + '      <label><input type="radio" value="do" name="interest"\n              />&nbsp;在读 </label>\n'
      + '      <label><input type="radio" value="collect" name="interest"\n              />&nbsp;读过 </label>\n'
      + '    </span>\n'
      + '      <input id="n_rating" type="hidden" value=""\n            name="rating"\n          />\n'
      + '</form>\n</div>\n',
    popular_tags: [],
    tags: [],
  });
  const result = classifyInterestResponse('book', 200, body);
  assert.equal(result.ok, true);
  assert.equal('interest_status' in result.data, false);
});

test('classifyInterestResponse: 书影音已登录已标记（真实抓包）→ ok', () => {
  // book.douban.com/j/subject/5939312/interest，2026-10-31，已登录、读过、4 星：
  // 同样没有 interest_status 键，状态只在 checked="checked" 的单选框里，评分在 #n_rating。
  // html 删去了样式、分享区和短评，my_tags 清空。
  const body = JSON.stringify({
    my_tags: [],
    html: '\n<div class="indentpop1 clearfix">\n<form action="https://book.douban.com/j/subject/5939312/interest"\n  method="POST"\n  class="j a_interest_form book-sns">\n'
      + '    <span class="interest-status">\n'
      + '      <label><input type="radio" value="wish" name="interest"\n              />&nbsp;想读 </label>\n'
      + '      <label><input type="radio" value="do" name="interest"\n              />&nbsp;在读 </label>\n'
      + '      <label><input type="radio" value="collect" name="interest"\n                checked="checked"\n              />&nbsp;读过 </label>\n'
      + '    </span>\n'
      + '      <input id="n_rating" type="hidden" value="4"\n            name="rating"\n          />\n'
      + '</form>\n</div>\n',
    popular_tags: [],
    tags: [],
  });
  const result = classifyInterestResponse('book', 200, body);
  assert.equal(result.ok, true);
  assert.equal('interest_status' in result.data, false);
  assert.match(result.data.html, /value="collect" name="interest"\s+checked="checked"/);
});

test('classifyInterestResponse: 认不出的类别 → 失败', () => {
  assert.equal(classifyInterestResponse('podcast', 200, ILMEN_UNMARKED).ok, false);
});

// 书影音的状态/评分提取（parseSubjectInterest）依赖 DOMParser，node 里没有，
// 只在浏览器里手测；结构校验在上面的 classifyInterestResponse 里。
