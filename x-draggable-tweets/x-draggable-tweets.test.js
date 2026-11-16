'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStatus, pickStatusUrl, shouldForwardClick } = require('./x-draggable-tweets.user.js');

const BASE = 'https://x.com';

// ── parseStatus: any status-ish href → canonical tweet URL ──────────────────

test('plain status link', () => {
  assert.deepEqual(parseStatus('/alspee/status/2122383950048084124', BASE), {
    id: '2122383950048084124',
    url: 'https://x.com/alspee/status/2122383950048084124',
  });
});

test('suffixes are dropped: analytics, photo, video, query, hash', () => {
  const want = 'https://x.com/ufobtc27/status/2122287853606707624';
  assert.equal(parseStatus('/ufobtc27/status/2122287853606707624/analytics', BASE).url, want);
  assert.equal(parseStatus('/ufobtc27/status/2122287853606707624/photo/1', BASE).url, want);
  assert.equal(parseStatus('/ufobtc27/status/2122287853606707624/video/1', BASE).url, want);
  assert.equal(parseStatus('/ufobtc27/status/2122287853606707624?s=20#m', BASE).url, want);
});

test('absolute URLs keep the page origin, twitter.com included', () => {
  assert.equal(parseStatus('https://x.com/a/status/1', BASE).url, 'https://x.com/a/status/1');
  assert.equal(
    parseStatus('/a/status/1', 'https://twitter.com').url,
    'https://twitter.com/a/status/1',
  );
});

test('/i/web/status/{id} has no user but is still a tweet', () => {
  assert.deepEqual(parseStatus('/i/web/status/42', BASE), { id: '42', url: 'https://x.com/i/web/status/42' });
});

test('non-tweet links are rejected', () => {
  assert.equal(parseStatus('/alspee', BASE), null);
  assert.equal(parseStatus('/compose/post?in_reply_to=20', BASE), null);
  assert.equal(parseStatus('/i/status/abc', BASE), null);
  assert.equal(parseStatus('https://example.com/a/status/1', BASE), null);
  assert.equal(parseStatus('', BASE), null);
  assert.equal(parseStatus(undefined, BASE), null);
  assert.equal(parseStatus('http://[bad', BASE), null);
});

// ── pickStatusUrl: first candidate that is a tweet and not an excluded id ────

test('picks the first tweet candidate', () => {
  assert.equal(pickStatusUrl(['/a', '/a/status/1/analytics', '/b/status/2'], [], BASE), 'https://x.com/a/status/1');
});

test('skips excluded ids (quote card must not resolve to the outer tweet)', () => {
  assert.equal(pickStatusUrl(['/outer/status/1', '/quoted/status/2'], ['1'], BASE), 'https://x.com/quoted/status/2');
});

test('returns null when nothing qualifies', () => {
  assert.equal(pickStatusUrl(['/outer/status/1'], ['1'], BASE), null);
  assert.equal(pickStatusUrl([], [], BASE), null);
});

// ── shouldForwardClick: plain left click goes to X, the rest stay native ─────

test('plain left click is forwarded to the tweet underneath', () => {
  assert.equal(shouldForwardClick({ button: 0 }), true);
});

test('new-tab / new-window clicks stay on the real <a> so the browser opens the tweet natively', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'shiftKey']) {
    assert.equal(shouldForwardClick({ button: 0, [mod]: true }), false, mod);
  }
});

test('alt+click is forwarded: on a native <a> it would download the page instead', () => {
  assert.equal(shouldForwardClick({ button: 0, altKey: true }), true);
});

test('keyboard-activated clicks (detail 0, no pointer position) are never forwarded', () => {
  assert.equal(shouldForwardClick({ button: 0, detail: 0 }), false);
  assert.equal(shouldForwardClick({ button: 0, detail: 1 }), true);
});

test('non-left buttons are never forwarded', () => {
  assert.equal(shouldForwardClick({ button: 1 }), false);
  assert.equal(shouldForwardClick({ button: 2 }), false);
});
