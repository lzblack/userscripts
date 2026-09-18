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
  cleanDescription,
  descriptionBlockText,
  isPayloadFresh,
  bindingRadioValue,
  buildFillPlan,
  isBookCategory,
} = require('./douban-add-book.user.js');

const SAPIENS = {
  title: 'Sapiens',
  subtitle: 'A Brief History of Humankind',
  authors: ['Yuval Noah Harari'],
  isbn13: '9780062316097',
  publisher: 'Harper',
  pubDate: { y: 2015, m: 2, d: 10 },
  pageCount: 464,
  binding: 'hardcover',
  bindingRaw: 'Hardcover',
  price: { currency: 'USD', amount: '27.63' },
  description: 'Long description here.',
  authorBio: '',
};

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

// ── isBookCategory ────────────────────────────────────────────────────────────
// 类目标记取自实测：纸质书 #dp.book、Kindle #dp.ebooks、电子产品 #dp.ce。
test('isBookCategory: print book — #dp class "book en_US"', () => {
  assert.equal(isBookCategory({ dpClass: 'book en_US', breadcrumb: 'Books›Biographies & Memoirs' }), true);
});

test('isBookCategory: Kindle edition — #dp class "ebooks en_US"', () => {
  // 守住无 ISBN 的「切换 print edition」流程
  assert.equal(isBookCategory({ dpClass: 'ebooks en_US', breadcrumb: 'Kindle Store›Kindle eBooks' }), true);
});

test('isBookCategory: breadcrumb fallback when #dp class missing', () => {
  assert.equal(isBookCategory({ dpClass: '', breadcrumb: 'Books›Literature & Fiction' }), true);
  assert.equal(isBookCategory({ dpClass: '', breadcrumb: 'Kindle Store›Kindle eBooks' }), true);
});

test('isBookCategory: non-book product (Anker charger) — silent', () => {
  assert.equal(
    isBookCategory({ dpClass: 'ce en_US', breadcrumb: 'Cell Phones & Accessories›Chargers & Power Adapters' }),
    false
  );
});

test('isBookCategory: does not false-match substrings (audiobook/ebook-store words)', () => {
  assert.equal(isBookCategory({ dpClass: 'audiobook en_US', breadcrumb: '' }), false); // 'book' not a whole class token
  assert.equal(isBookCategory({ dpClass: 'gateway en_US', breadcrumb: 'Electronics›Headphones' }), false);
});

test('isBookCategory: defensive on missing/garbage input', () => {
  assert.equal(isBookCategory(undefined), false);
  assert.equal(isBookCategory({}), false);
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

// ── cleanDescription ────────────────────────────────────────────────────────
test('cleanDescription: strips trailing Read more/less toggle', () => {
  assert.equal(cleanDescription('A great book. Read more'), 'A great book.');
  assert.equal(cleanDescription('A great book. Read less'), 'A great book.');
  assert.equal(cleanDescription('A great book.'), 'A great book.');
  assert.equal(cleanDescription('  spaced  '), 'spaced');
  assert.equal(cleanDescription(''), '');
});

// ── descriptionBlockText ────────────────────────────────────────────────────
// 最小 DOM 替身：只实现 descriptionBlockText 用到的 nodeType/tagName/nodeValue/
// childNodes/textContent/querySelectorAll('p, li')，用来钉住真实页面的结构。
function txt(s) {
  return { nodeType: 3, nodeValue: s, get textContent() { return s; } };
}
function el(tag, ...kids) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: kids.map((k) => (typeof k === 'string' ? txt(k) : k)),
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
    querySelectorAll(sel) {
      assert.equal(sel, 'p, li');
      const out = [];
      const walk = (n) => n.childNodes.forEach((c) => {
        if (c.nodeType !== 1) return;
        if (c.tagName === 'P' || c.tagName === 'LI') out.push(c);
        walk(c);
      });
      walk(this);
      return out;
    },
  };
  return node;
}

test('descriptionBlockText: empty <p> as separators between bare spans (Red Ants/1640098089)', () => {
  const content = el('div',
    ' ',
    el('span', 'LONGLISTED FOR THE NATIONAL BOOK AWARD '),
    el('p'),
    el('span', 'This bold and genre-defying prose debut'),
    el('p'),
    el('span', "Kimberly Blaeser's singular stories. "),
    el('p'),
    el('span', 'For readers of '),
    el('span', 'Night of the Living Rez'),
    el('span', ' and '),
    el('span', 'Crooked Hallelujah'),
    el('span', ', a debut.'),
    '  ');
  assert.equal(descriptionBlockText(content), [
    'LONGLISTED FOR THE NATIONAL BOOK AWARD',
    'This bold and genre-defying prose debut',
    "Kimberly Blaeser's singular stories.",
    'For readers of Night of the Living Rez and Crooked Hallelujah, a debut.',
  ].join('\n\n'));
});

test('descriptionBlockText: text-bearing <p>/<li> read as blocks (McCartney Legacy/0063000709)', () => {
  const content = el('div',
    el('p', 'Intro   paragraph.'),
    el('ul', el('li', 'First'), el('li', ' '), el('li', 'Second')),
    el('p', 'Closing.'));
  assert.equal(descriptionBlockText(content), 'Intro paragraph.\n\n· First\n\n· Second\n\nClosing.');
});

test('descriptionBlockText: block mode ignores text outside blocks (author card Follow/Read more)', () => {
  const content = el('div', el('p', 'Bio paragraph.'), el('span', 'Follow'), el('a', 'Read more'));
  assert.equal(descriptionBlockText(content), 'Bio paragraph.');
});

test('descriptionBlockText: span + <br> structure (Math for Web Design/1633434826)', () => {
  const content = el('div',
    el('span', 'Para one line.', el('br'), el('br'), 'Para   two.', el('br'), el('br')),
    el('span', el('b', 'About the author'), el('br'), ' Author bio.'));
  assert.equal(descriptionBlockText(content), 'Para one line.\n\nPara two.\n\nAbout the author\nAuthor bio.');
});

test('descriptionBlockText: empty or whitespace-only content → empty string', () => {
  assert.equal(descriptionBlockText(el('div')), '');
  assert.equal(descriptionBlockText(el('div', '  ', el('p'), el('p', ' '))), '');
});

// ── isPayloadFresh ──────────────────────────────────────────────────────────
test('isPayloadFresh: TTL window', () => {
  const ttl = 600000;
  assert.equal(isPayloadFresh({ source: { capturedAt: 1000 } }, 1000 + 599999, ttl), true);
  assert.equal(isPayloadFresh({ source: { capturedAt: 1000 } }, 1000 + 600001, ttl), false);
  assert.equal(isPayloadFresh({}, 5000, ttl), false); // no capturedAt
  assert.equal(isPayloadFresh(null, 5000, ttl), false);
});

// ── bindingRadioValue ───────────────────────────────────────────────────────
test('bindingRadioValue: canonical → douban radio value', () => {
  assert.equal(bindingRadioValue('hardcover'), 'Hardcover');
  assert.equal(bindingRadioValue('paperback'), 'Paperback');
  assert.equal(bindingRadioValue('other'), 'other');
});

// ── buildFillPlan ───────────────────────────────────────────────────────────
test('buildFillPlan: happy path maps every fillable field', () => {
  const plan = buildFillPlan(SAPIENS);
  const byLabel = Object.fromEntries(plan.texts.map((t) => [t.label, t.value]));
  assert.equal(byLabel['书名'], 'Sapiens');
  assert.equal(byLabel['副标题'], 'A Brief History of Humankind');
  assert.equal(byLabel['定价'], 'USD 27.63');
  assert.equal(byLabel['出版社'], 'Harper');
  assert.equal(byLabel['页数'], '464');
  assert.deepEqual(plan.authors, ['Yuval Noah Harari']);
  assert.deepEqual(plan.date, { y: 2015, m: 2, d: 10 });
  assert.deepEqual(plan.binding, { radioValue: 'Hardcover', otherText: '' });
  assert.equal(plan.textareas.find((a) => a.label === '内容简介').value, 'Long description here.');
  assert.deepEqual(plan.warnings, []);
});

test('buildFillPlan: all authors carried for auto-add, no manual warning', () => {
  const plan = buildFillPlan({ ...SAPIENS, authors: ['A Author', 'B Author', 'C Author'] });
  assert.deepEqual(plan.authors, ['A Author', 'B Author', 'C Author']);
  assert.deepEqual(plan.warnings, []);
  assert.ok(plan.filled.includes('作者 ×3'));
});

test('buildFillPlan: missing required fields produce warnings, not throws', () => {
  const plan = buildFillPlan({ ...SAPIENS, authors: [], description: '' });
  assert.ok(plan.warnings.some((w) => /缺作者/.test(w)));
  assert.ok(plan.warnings.some((w) => /内容简介缺失/.test(w)));
  assert.ok(plan.skipped.includes('作者'));
  assert.ok(plan.skipped.includes('内容简介'));
});

test('buildFillPlan: binding other carries raw text and warns', () => {
  const plan = buildFillPlan({ ...SAPIENS, binding: 'other', bindingRaw: 'Spiral-bound' });
  assert.deepEqual(plan.binding, { radioValue: 'other', otherText: 'Spiral-bound' });
  assert.ok(plan.warnings.some((w) => /装帧落「其他」.*Spiral-bound/.test(w)));
});

test('buildFillPlan: null price is skipped, not filled', () => {
  const plan = buildFillPlan({ ...SAPIENS, price: null });
  assert.ok(!plan.texts.some((t) => t.label === '定价'));
  assert.ok(plan.skipped.includes('定价'));
});
