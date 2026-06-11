'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateIsbn13,
  isbn10to13,
  splitTitle,
  parseDate,
  splitPublisherDate,
  normalizePrice,
  mapBinding,
  normalizeTitle,
  parsePageCount,
  isPayloadFresh,
} = require('./douban-book-bridge.user.js');

// ── validateIsbn13 ──────────────────────────────────────────────────────────
test('validateIsbn13: canonical valid 978/979', () => {
  assert.equal(validateIsbn13('9780306406157'), true); // textbook example
  assert.equal(validateIsbn13('978-0-306-40615-7'), true); // hyphens stripped
  assert.equal(validateIsbn13('979-8995221913'), true); // hyphens stripped, 979 prefix (KDP)
});

test('validateIsbn13: rejects bad checksum / length / prefix', () => {
  assert.equal(validateIsbn13('9780306406158'), false); // wrong check digit
  assert.equal(validateIsbn13('978030640615'), false); // 12 digits
  assert.equal(validateIsbn13('1234567890123'), false); // bad prefix
  assert.equal(validateIsbn13(''), false);
  assert.equal(validateIsbn13(null), false);
});

// ── isbn10to13 ──────────────────────────────────────────────────────────────
test('isbn10to13: converts and recomputes check digit', () => {
  assert.equal(isbn10to13('0306406152'), '9780306406157');
  assert.equal(isbn10to13('0-306-40615-2'), '9780306406157');
  assert.equal(isbn10to13('080442957X'), '9780804429573'); // X check digit input
});

test('isbn10to13: returns null on invalid input', () => {
  assert.equal(isbn10to13('123'), null);
  assert.equal(isbn10to13('9780306406157'), null); // already 13
});

// ── splitTitle ──────────────────────────────────────────────────────────────
test('splitTitle: splits on first colon only', () => {
  assert.deepEqual(splitTitle('Messy Jobs'), { title: 'Messy Jobs', subtitle: '' });
  assert.deepEqual(splitTitle('Sapiens: A Brief History of Humankind'), {
    title: 'Sapiens',
    subtitle: 'A Brief History of Humankind',
  });
  assert.deepEqual(splitTitle('A: B: C'), { title: 'A', subtitle: 'B: C' });
  assert.deepEqual(splitTitle('  Padded : Sub  '), { title: 'Padded', subtitle: 'Sub' });
});

// ── parseDate ───────────────────────────────────────────────────────────────
test('parseDate: full / partial / abbreviated', () => {
  assert.deepEqual(parseDate('March 5, 2024'), { y: 2024, m: 3, d: 5 });
  assert.deepEqual(parseDate('Mar 5, 2024'), { y: 2024, m: 3, d: 5 });
  assert.deepEqual(parseDate('March 2024'), { y: 2024, m: 3, d: null });
  assert.deepEqual(parseDate('2024'), { y: 2024, m: null, d: null });
});

test('parseDate: returns null when no year', () => {
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
});

// ── splitPublisherDate ──────────────────────────────────────────────────────
test('splitPublisherDate: combined publisher + (date)', () => {
  assert.deepEqual(splitPublisherDate('Penguin Press (March 5, 2024)'), {
    publisher: 'Penguin Press',
    date: { y: 2024, m: 3, d: 5 },
  });
  assert.deepEqual(splitPublisherDate('Tor Books; 1st edition (January 11, 2014)'), {
    publisher: 'Tor Books; 1st edition',
    date: { y: 2014, m: 1, d: 11 },
  });
});

test('splitPublisherDate: publisher only, no date', () => {
  assert.deepEqual(splitPublisherDate('Penguin Press'), { publisher: 'Penguin Press', date: null });
});

// ── normalizePrice ──────────────────────────────────────────────────────────
test('normalizePrice: USD symbol and code forms', () => {
  assert.deepEqual(normalizePrice('$30.00'), { currency: 'USD', amount: '30.00' });
  assert.deepEqual(normalizePrice('$30'), { currency: 'USD', amount: '30.00' });
  assert.deepEqual(normalizePrice('USD 30.00'), { currency: 'USD', amount: '30.00' });
  assert.deepEqual(normalizePrice('$1,234.50'), { currency: 'USD', amount: '1234.50' });
});

test('normalizePrice: null on empty/garbage', () => {
  assert.equal(normalizePrice(''), null);
  assert.equal(normalizePrice('free'), null);
});

// ── mapBinding ──────────────────────────────────────────────────────────────
test('mapBinding: hardcover / paperback / other', () => {
  assert.equal(mapBinding('Hardcover'), 'hardcover');
  assert.equal(mapBinding('Paperback'), 'paperback');
  assert.equal(mapBinding('Mass Market Paperback'), 'paperback');
  assert.equal(mapBinding('Kindle Edition'), 'other');
  assert.equal(mapBinding('Board book'), 'other');
  assert.equal(mapBinding(''), 'other');
});

// ── normalizeTitle ──────────────────────────────────────────────────────────
test('normalizeTitle: matches rating-hub semantics', () => {
  assert.equal(normalizeTitle('Q & A'), 'qanda');
  assert.equal(normalizeTitle('The Lord of the Rings!'), 'thelordoftherings');
  assert.equal(normalizeTitle('三体'), ''); // CJK stripped (suggest matches separately)
});

// ── parsePageCount ──────────────────────────────────────────────────────────
test('parsePageCount: extracts integer, strips commas', () => {
  assert.equal(parsePageCount('320 pages'), 320);
  assert.equal(parsePageCount('320'), 320);
  assert.equal(parsePageCount('1,024 pages'), 1024);
  assert.equal(parsePageCount('xii, 416 pages'), 416);
  assert.equal(parsePageCount('no number'), null);
});

// ── isPayloadFresh ──────────────────────────────────────────────────────────
test('isPayloadFresh: TTL window', () => {
  const ttl = 600000;
  assert.equal(isPayloadFresh({ source: { capturedAt: 1000 } }, 1000 + 599999, ttl), true);
  assert.equal(isPayloadFresh({ source: { capturedAt: 1000 } }, 1000 + 600001, ttl), false);
  assert.equal(isPayloadFresh({}, 5000, ttl), false); // no capturedAt
  assert.equal(isPayloadFresh(null, 5000, ttl), false);
});
