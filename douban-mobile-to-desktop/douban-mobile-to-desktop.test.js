'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toDesktop, unwrapGoogle, rewriteHref } = require('./douban-mobile-to-desktop.user.js');

// ── 服务器本来会跳的，也直接改，省一跳 ────────────────────────────────────

test('书影音条目及其子页', () => {
  assert.equal(toDesktop('https://m.douban.com/movie/subject/1292052/'), 'https://movie.douban.com/subject/1292052/');
  assert.equal(toDesktop('https://m.douban.com/book/subject/1007305/comments'), 'https://book.douban.com/subject/1007305/comments');
  assert.equal(toDesktop('https://m.douban.com/music/subject/3390002/'), 'https://music.douban.com/subject/3390002/');
  assert.equal(toDesktop('https://m.douban.com/movie/subject/1292052/reviews?start=20'), 'https://movie.douban.com/subject/1292052/reviews?start=20');
  assert.equal(toDesktop('http://m.douban.com/movie/subject/1292052'), 'https://movie.douban.com/subject/1292052/');
});

test('游戏在 www 上', () => {
  assert.equal(toDesktop('https://m.douban.com/game/subject/26817171/'), 'https://www.douban.com/game/26817171/');
  assert.equal(toDesktop('https://m.douban.com/game/subject/26817171/comments'), 'https://www.douban.com/game/26817171/comments');
});

test('影评书评乐评', () => {
  assert.equal(toDesktop('https://m.douban.com/movie/review/1000369/'), 'https://movie.douban.com/review/1000369/');
  assert.equal(toDesktop('https://m.douban.com/book/review/1000369/'), 'https://book.douban.com/review/1000369/');
});

test('影人旧链接交给 movie 子域（它再跳 personage）', () => {
  assert.equal(toDesktop('https://m.douban.com/movie/celebrity/1054521/'), 'https://movie.douban.com/celebrity/1054521/');
});

// ── 服务器不跳的，脚本必须补 ──────────────────────────────────────────────

test('人物页', () => {
  assert.equal(toDesktop('https://m.douban.com/personage/27260288/'), 'https://www.douban.com/personage/27260288/');
  assert.equal(toDesktop('https://m.douban.com/personage/27260288'), 'https://www.douban.com/personage/27260288/');
});

test('用户主页只映射根页，子页不猜', () => {
  assert.equal(toDesktop('https://m.douban.com/people/ahbei/'), 'https://www.douban.com/people/ahbei/');
  assert.equal(toDesktop('https://m.douban.com/people/ahbei/movie'), null);
});

test('搜索 query → q', () => {
  assert.equal(toDesktop('https://m.douban.com/search/?query=%E4%B8%89%E4%BD%93'), 'https://www.douban.com/search?q=%E4%B8%89%E4%BD%93');
  assert.equal(toDesktop('https://m.douban.com/search/?query=a%20b&type=movie'), 'https://www.douban.com/search?q=a+b');
  assert.equal(toDesktop('https://m.douban.com/search/'), null);
});

test('首页与频道首页', () => {
  assert.equal(toDesktop('https://m.douban.com/'), 'https://www.douban.com/');
  assert.equal(toDesktop('https://m.douban.com/movie/'), 'https://movie.douban.com/');
  assert.equal(toDesktop('https://m.douban.com/book'), 'https://book.douban.com/');
  assert.equal(toDesktop('https://m.douban.com/music/'), 'https://music.douban.com/');
});

test('小组、日记、豆列同路径搬到 www', () => {
  assert.equal(toDesktop('https://m.douban.com/group/topic/505335068/'), 'https://www.douban.com/group/topic/505335068/');
  assert.equal(toDesktop('https://m.douban.com/group/586674/'), 'https://www.douban.com/group/586674/');
  assert.equal(toDesktop('https://m.douban.com/note/123456/'), 'https://www.douban.com/note/123456/');
  assert.equal(toDesktop('https://m.douban.com/doulist/1/'), 'https://www.douban.com/doulist/1/');
});

test('Top250 合集对应桌面版榜单页', () => {
  assert.equal(toDesktop('https://m.douban.com/subject_collection/movie_top250'), 'https://movie.douban.com/top250');
  assert.equal(toDesktop('https://m.douban.com/subject_collection/book_top250/'), 'https://book.douban.com/top250');
});

// ── 不动的 ────────────────────────────────────────────────────────────────

test('没有桌面对应物或未知路径一律不动', () => {
  assert.equal(toDesktop('https://m.douban.com/subject_collection/movie_showing'), null);
  // 移动版没有 music_top250 这个合集（API 返回 traversal_error）
  assert.equal(toDesktop('https://m.douban.com/subject_collection/music_top250'), null);
  assert.equal(toDesktop('https://m.douban.com/tv/subject/26357307/'), null);
  assert.equal(toDesktop('https://m.douban.com/movie/subject/abc/'), null);
});

test('桌面版和其他站点不动', () => {
  assert.equal(toDesktop('https://movie.douban.com/subject/1292052/'), null);
  assert.equal(toDesktop('https://zh.m.wikipedia.org/wiki/X'), null);
  assert.equal(toDesktop('https://m.youtube.com/watch?v=1'), null);
});

test('非 URL 输入返回 null 而不是抛错', () => {
  assert.equal(toDesktop(''), null);
  assert.equal(toDesktop('javascript:void(0)'), null);
  assert.equal(toDesktop('not a url'), null);
});

// ── Google 结果页链接 ─────────────────────────────────────────────────────

test('unwrapGoogle：拆出 /url?q= 和 /url?url= 的目标', () => {
  assert.equal(unwrapGoogle('https://www.google.com/url?q=https://m.douban.com/people/ahbei/&sa=U'), 'https://m.douban.com/people/ahbei/');
  assert.equal(unwrapGoogle('https://www.google.co.jp/url?sa=t&url=https%3A%2F%2Fm.douban.com%2Fpeople%2Fahbei%2F'), 'https://m.douban.com/people/ahbei/');
  assert.equal(unwrapGoogle('https://www.google.com/search?q=x'), null);
  assert.equal(unwrapGoogle('https://m.douban.com/people/ahbei/'), null);
});

test('rewriteHref：直链与包装链都改成桌面直链；不相关的返回 null', () => {
  assert.equal(rewriteHref('https://m.douban.com/movie/subject/1292052/'), 'https://movie.douban.com/subject/1292052/');
  assert.equal(rewriteHref('https://www.google.com/url?q=https://m.douban.com/personage/1/&sa=U'), 'https://www.douban.com/personage/1/');
  assert.equal(rewriteHref('https://www.google.com/url?q=https://movie.douban.com/subject/1/'), null);
  assert.equal(rewriteHref('https://www.google.com/search?q=x&start=10'), null);
});
