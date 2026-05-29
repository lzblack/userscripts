'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  QUICK_RE,
  parseOffsetMinutes,
  findTimeMatches,
  extractDate,
  planAnnotations,
  containerAnnots,
  localOffsetMinutes,
  formatLocal,
  convert,
} = require('./local-time-annotator.user.js');

test('parseOffsetMinutes: zero-offset markers', () => {
  assert.equal(parseOffsetMinutes('Z'), 0);
  assert.equal(parseOffsetMinutes('UTC'), 0);
  assert.equal(parseOffsetMinutes('GMT'), 0);
});

test('parseOffsetMinutes: UTC/GMT with whole-hour offset', () => {
  assert.equal(parseOffsetMinutes('UTC+8'), 480);
  assert.equal(parseOffsetMinutes('GMT-5'), -300);
  assert.equal(parseOffsetMinutes('UTC + 8'), 480);
});

test('parseOffsetMinutes: half/quarter-hour offsets', () => {
  assert.equal(parseOffsetMinutes('GMT+5:30'), 330);
  assert.equal(parseOffsetMinutes('UTC+05:45'), 345);
  assert.equal(parseOffsetMinutes('-05:30'), -330);
});

test('parseOffsetMinutes: bare numeric offsets', () => {
  assert.equal(parseOffsetMinutes('+05:00'), 300);
  assert.equal(parseOffsetMinutes('-0500'), -300);
  assert.equal(parseOffsetMinutes('+0000'), 0);
});

test('parseOffsetMinutes: bounds offsets to real-world range', () => {
  assert.equal(parseOffsetMinutes('+14:00'), 840); // Kiribati, valid max
  assert.equal(parseOffsetMinutes('-12:00'), -720); // valid min
  assert.equal(parseOffsetMinutes('+15:00'), null);
  assert.equal(parseOffsetMinutes('-16:00'), null);
  assert.equal(parseOffsetMinutes('UTC+15'), null);
});

test('parseOffsetMinutes: rejects ambiguous / unknown tokens', () => {
  assert.equal(parseOffsetMinutes('EDT'), null);
  assert.equal(parseOffsetMinutes('CST'), null);
  assert.equal(parseOffsetMinutes('PST'), null);
  assert.equal(parseOffsetMinutes(''), null);
  assert.equal(parseOffsetMinutes('hello'), null);
});

test('findTimeMatches: basic UTC in a sentence', () => {
  const text = 'Meeting at 14:42 UTC tomorrow';
  const r = findTimeMatches(text);
  assert.equal(r.length, 1);
  assert.deepEqual(
    { h: r[0].h, m: r[0].m, s: r[0].s, off: r[0].srcOffsetMin },
    { h: 14, m: 42, s: 0, off: 0 }
  );
  assert.equal(text.slice(r[0].index, r[0].index + r[0].length), '14:42 UTC');
});

test('findTimeMatches: zulu suffix with no space', () => {
  const r = findTimeMatches('19:00Z');
  assert.equal(r.length, 1);
  assert.equal(r[0].h, 19);
  assert.equal(r[0].srcOffsetMin, 0);
});

test('findTimeMatches: 12-hour clock with AM/PM', () => {
  assert.equal(findTimeMatches('2:42 PM GMT')[0].h, 14);
  assert.equal(findTimeMatches('12:00 AM UTC')[0].h, 0);
  assert.equal(findTimeMatches('12:15 PM UTC')[0].h, 12);
});

test('findTimeMatches: explicit and half-hour offsets', () => {
  assert.equal(findTimeMatches('09:30 UTC+8')[0].srcOffsetMin, 480);
  assert.equal(findTimeMatches('15:00 -05:00')[0].srcOffsetMin, -300);
  assert.equal(findTimeMatches('11:00 GMT+5:30')[0].srcOffsetMin, 330);
});

test('findTimeMatches: rejects naked markers and offset-less times', () => {
  assert.equal(findTimeMatches('the UTC standard is great').length, 0);
  assert.equal(findTimeMatches('join the GMT zone channel').length, 0);
  assert.equal(findTimeMatches('lunch at 14:00 today').length, 0);
  assert.equal(findTimeMatches('19:00Zen garden opens').length, 0);
});

test('findTimeMatches: ignores out-of-range time-like numbers', () => {
  assert.equal(findTimeMatches('ratio 25:99 UTC').length, 0);
});

test('findTimeMatches: multiple matches in one string', () => {
  const r = findTimeMatches('from 14:00 UTC to 18:30 UTC');
  assert.equal(r.length, 2);
  assert.equal(r[0].h, 14);
  assert.equal(r[1].h, 18);
  assert.equal(r[1].m, 30);
});

test('findTimeMatches: rejects out-of-range bare offset (numeric range, not a time)', () => {
  assert.equal(findTimeMatches('score 15:00 -16:00 today').length, 0);
});

test('QUICK_RE gate is a safe superset of findTimeMatches (no false negatives)', () => {
  // Anything findTimeMatches accepts, the cheap gate MUST also accept, or the
  // scoped walk is skipped and real content goes unannotated. Regression for "19:00Z".
  const positives = [
    'Standup at 19:00Z sharp.',
    'Deploy 14:42 UTC',
    'Doors 2:42 PM GMT',
    'Call 09:30 UTC+8',
    'Cutoff 15:00 -05:00',
    'Sync 11:00 GMT+5:30',
    'low 19:00z case',
  ];
  for (const s of positives) {
    assert.ok(findTimeMatches(s).length > 0, `findTimeMatches should match: ${s}`);
    assert.ok(QUICK_RE.test(s), `QUICK_RE must gate-pass: ${s}`);
  }
});

test('extractDate: ISO and month-name forms', () => {
  assert.deepEqual(extractDate('Posted 2026-05-28 at 14:42 UTC'), { y: 2026, mo: 4, d: 28 });
  assert.deepEqual(extractDate('May 28, 2026 release'), { y: 2026, mo: 4, d: 28 });
  assert.deepEqual(extractDate('28 May 2026 release'), { y: 2026, mo: 4, d: 28 });
  assert.equal(extractDate('no date in here at 14:42 UTC'), null);
});

test('planAnnotations: single match isolates matched text before the annotation', () => {
  const segs = planAnnotations('Meeting at 14:42 UTC tomorrow', { y: 2026, mo: 4, d: 28 }, 'America/New_York', 'en-US');
  assert.deepEqual(segs, [
    { type: 'text', value: 'Meeting at ' },
    { type: 'text', value: '14:42 UTC' },
    { type: 'annot', value: ' (10:42 AM EDT)' },
    { type: 'text', value: ' tomorrow' },
  ]);
});

test('planAnnotations: multi-match keeps every index correct (no shift bug)', () => {
  const segs = planAnnotations('from 14:00 UTC to 18:30 UTC', { y: 2026, mo: 4, d: 28 }, 'America/New_York', 'en-US');
  assert.deepEqual(segs, [
    { type: 'text', value: 'from ' },
    { type: 'text', value: '14:00 UTC' },
    { type: 'annot', value: ' (10:00 AM EDT)' },
    { type: 'text', value: ' to ' },
    { type: 'text', value: '18:30 UTC' },
    { type: 'annot', value: ' (2:30 PM EDT)' },
  ]);
});

test('planAnnotations: returns null when nothing to annotate', () => {
  assert.equal(planAnnotations('14:42 UTC', { y: 2026, mo: 4, d: 28 }, 'UTC', 'en-US'), null); // same offset => skip
  assert.equal(planAnnotations('just some prose', { y: 2026, mo: 4, d: 28 }, 'America/New_York', 'en-US'), null);
});

test('containerAnnots: statuspage-style assembled timestamp', () => {
  // "<small>May 29, <var>08:45</var> UTC</small>" assembles to this text.
  const annots = containerAnnots('May 29, 08:45 UTC', { y: 2026, mo: 4, d: 29 }, 'America/New_York', 'en-US');
  assert.deepEqual(annots, [' (4:45 AM EDT)']);
});

test('containerAnnots: empty when no match or when already-local', () => {
  assert.deepEqual(containerAnnots('May 29, no time here', { y: 2026, mo: 4, d: 29 }, 'America/New_York', 'en-US'), []);
  // 08:45 UTC viewed from UTC => same offset => skipped
  assert.deepEqual(containerAnnots('May 29, 08:45 UTC', { y: 2026, mo: 4, d: 29 }, 'UTC', 'en-US'), []);
});

test('containerAnnots: multiple split times in one container', () => {
  const annots = containerAnnots('Window 14:00 UTC to 18:30 UTC', { y: 2026, mo: 4, d: 29 }, 'America/New_York', 'en-US');
  assert.deepEqual(annots, [' (10:00 AM EDT)', ' (2:30 PM EDT)']);
});

test('localOffsetMinutes: DST-aware per instant', () => {
  // late May => EDT (UTC-4)
  assert.equal(localOffsetMinutes(new Date('2026-05-28T12:00:00Z'), 'America/New_York'), -240);
  // mid Jan => EST (UTC-5)
  assert.equal(localOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York'), -300);
  assert.equal(localOffsetMinutes(new Date('2026-05-28T12:00:00Z'), 'Asia/Shanghai'), 480);
  assert.equal(localOffsetMinutes(new Date('2026-05-28T12:00:00Z'), 'UTC'), 0);
  assert.equal(localOffsetMinutes(new Date('2026-05-28T12:00:00Z'), 'Asia/Kolkata'), 330);
});

test('formatLocal: en-US short zone name', () => {
  const inst = new Date('2026-05-28T14:42:00Z');
  assert.equal(formatLocal(inst, 'America/New_York', 'en-US'), '10:42 AM EDT');
  assert.equal(formatLocal(inst, 'UTC', 'en-US'), '2:42 PM UTC');
});

test('convert: UTC source to EDT, no skip', () => {
  const r = convert({ y: 2026, mo: 4, d: 28, h: 14, m: 42, s: 0, srcOffsetMin: 0 }, 'America/New_York', 'en-US');
  assert.equal(r.text, '10:42 AM EDT');
  assert.equal(r.skip, false);
});

test('convert: source already local => skip', () => {
  const r = convert({ y: 2026, mo: 4, d: 28, h: 14, m: 42, s: 0, srcOffsetMin: 0 }, 'UTC', 'en-US');
  assert.equal(r.skip, true);
});

test('convert: DST handled by Intl per instant (winter => EST)', () => {
  const r = convert({ y: 2026, mo: 0, d: 15, h: 14, m: 42, s: 0, srcOffsetMin: 0 }, 'America/New_York', 'en-US');
  assert.equal(r.text, '9:42 AM EST');
});

test('convert: UTC+8 source crossing midnight back to EDT', () => {
  // 09:30 UTC+8 on May 28 == 01:30Z == 21:30 EDT on May 27
  const r = convert({ y: 2026, mo: 4, d: 28, h: 9, m: 30, s: 0, srcOffsetMin: 480 }, 'America/New_York', 'en-US');
  assert.equal(r.text, '9:30 PM EDT');
  assert.equal(r.skip, false);
});
