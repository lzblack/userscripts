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
  isAmazonHost,
  parseOreillyLd,
  parseOreillyHydration,
  oreillyProductExtras,
  bioHtmlToText,
} = require('./douban-add-book.user.js');
const OREILLY = require('./fixture-oreilly.json');
const OREILLY_PRODUCT = require('./fixture-oreilly-product.json');

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

// ── isAmazonHost ─────────────────────────────────────────────────────────────
// us.amazon.com 是美国站别名：直接 200 返回同一商品页（#dp.book），不跳转 www。
test('isAmazonHost: www and us aliases of the US store', () => {
  assert.equal(isAmazonHost('www.amazon.com'), true);
  assert.equal(isAmazonHost('us.amazon.com'), true);
});

test('isAmazonHost: other hosts are not Amazon pages', () => {
  assert.equal(isAmazonHost('book.douban.com'), false);
  assert.equal(isAmazonHost('www.amazon.co.uk'), false);
  assert.equal(isAmazonHost(''), false);
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

test('buildFillPlan: unknown binding (null) is skipped, not guessed', () => {
  // O'Reilly 只卖电子版，纸书装帧无从得知——不碰装帧控件，也不报「落其他」。
  const plan = buildFillPlan({ ...SAPIENS, binding: null, bindingRaw: '' });
  assert.equal(plan.binding, null);
  assert.ok(plan.skipped.includes('装帧'));
  assert.ok(!plan.filled.includes('装帧'));
  assert.ok(!plan.warnings.some((w) => w.includes('装帧')));
});

// ── parseDate: ISO ───────────────────────────────────────────────────────────
test('parseDate: ISO 8601 date (JSON-LD datePublished)', () => {
  assert.deepEqual(parseDate('2021-06-14'), { y: 2021, m: 6, d: 14 });
  assert.deepEqual(parseDate('2021-06'), { y: 2021, m: 6, d: null });
});

// ── parseOreillyLd ───────────────────────────────────────────────────────────
// fixture-oreilly.json 是 2026-11-08 从 www.oreilly.com 书页原样抓下的 JSON-LD。
test('parseOreillyLd: Programming Rust 2e — print ISBN, not the ebook ISBN in the URL', () => {
  const b = parseOreillyLd(OREILLY['programming-rust-2e'].ld);
  assert.equal(b.isbn13, '9781492052593'); // 页面 URL / og:book:isbn 是电子版 9781492052586
  assert.equal(b.title, 'Programming Rust, 2nd Edition');
  assert.equal(b.subtitle, '');
  assert.deepEqual(b.authors, ['Jim Blandy', 'Jason Orendorff', 'Leonora F. S. Tindall']);
  assert.equal(b.publisher, "O'Reilly Media, Inc.");
  assert.deepEqual(b.pubDate, { y: 2021, m: 6, d: 14 });
  assert.equal(b.pageCount, 738);
  assert.match(b.description, /^Systems programming provides/);
  assert.equal(b.coverUrl, 'https://www.oreilly.com/library/cover/9781492052586/1200w/');
});

test('parseOreillyLd: Programming Rust 3e', () => {
  const b = parseOreillyLd(OREILLY['programming-rust-3e'].ld);
  assert.equal(b.isbn13, '9781098176235');
  assert.equal(b.title, 'Programming Rust, 3rd Edition');
  assert.deepEqual(b.pubDate, { y: 2026, m: 10, d: 22 });
  assert.equal(b.pageCount, 730);
  assert.equal(b.coverUrl, 'https://www.oreilly.com/library/cover/9781098176228/1200w/');
});

test('parseOreillyLd: title with a colon splits into title/subtitle', () => {
  const ld = JSON.stringify({ '@type': 'Book', name: 'Learning Go: An Idiomatic Approach', isbn: '9781492077213' });
  const b = parseOreillyLd([ld]);
  assert.equal(b.title, 'Learning Go');
  assert.equal(b.subtitle, 'An Idiomatic Approach');
});

test('parseOreillyLd: invalid or missing isbn → null (caller blocks)', () => {
  assert.equal(parseOreillyLd([JSON.stringify({ '@type': 'Book', name: 'X', isbn: '9781492052594' })]).isbn13, null);
  assert.equal(parseOreillyLd([JSON.stringify({ '@type': 'Book', name: 'X' })]).isbn13, null);
});

test('parseOreillyLd: finds the Book among other blocks, arrays and @graph; skips bad JSON', () => {
  const book = { '@type': 'Book', name: 'X', isbn: '9781492052593' };
  const org = JSON.stringify({ '@type': 'Organization', name: 'O' });
  assert.equal(parseOreillyLd(['{not json', org, JSON.stringify(book)]).title, 'X');
  assert.equal(parseOreillyLd([JSON.stringify([{ '@type': 'WebPage' }, book])]).title, 'X');
  assert.equal(parseOreillyLd([JSON.stringify({ '@graph': [book] })]).title, 'X');
  assert.equal(parseOreillyLd([JSON.stringify({ ...book, '@type': ['Book', 'Product'] })]).title, 'X');
});

test('parseOreillyLd: no Book block → null', () => {
  assert.equal(parseOreillyLd([]), null);
  assert.equal(parseOreillyLd([JSON.stringify({ '@type': 'Organization' })]), null);
});

test('parseOreillyLd: missing fields degrade to empty values, never throw', () => {
  const b = parseOreillyLd([JSON.stringify({ '@type': 'Book', name: 'X', publisher: 'P', author: { name: 'A' } })]);
  assert.equal(b.publisher, 'P');
  assert.deepEqual(b.authors, ['A']);
  assert.deepEqual(b.pubDate, { y: null, m: null, d: null });
  assert.equal(b.pageCount, null);
  assert.equal(b.description, '');
  assert.equal(b.coverUrl, '');
});

test('parseOreillyLd: isbn equal to the ebook id is not a print ISBN → null', () => {
  // 只有电子版的书，isbn 字段可能就是电子版 ISBN；拿它去豆瓣查不到，用户会照着加出一个错误条目。
  const ld = JSON.stringify({
    '@type': 'Book', name: 'X', isbn: '9781492052586',
    image: { url: 'https://learning.oreilly.com/library/cover/9781492052586/250w/' },
  });
  assert.equal(parseOreillyLd([ld]).isbn13, null);
});

// ── O'Reilly 商品记录（window.__staticRouterHydrationData）──────────────────
// fixture-oreilly-product.json：2026-11-08 从三本书页抓下的商品记录，只留用到的字段（已去掉邮箱）。
const hydrationOf = (key) => ({
  loaderData: { bookShellContainer: { data: { productServiceData: OREILLY_PRODUCT[key].productServiceData } } },
});

test('parseOreillyHydration: reads the JSON.parse("…") string literal in the page script', () => {
  const obj = { loaderData: { a: 'x "quoted" \ back' } };
  const text = 'window.__staticRouterHydrationData = JSON.parse(' + JSON.stringify(JSON.stringify(obj)) + ');';
  assert.deepEqual(parseOreillyHydration(text), obj);
});

test('parseOreillyHydration: other scripts or broken literals → null', () => {
  assert.equal(parseOreillyHydration('window.VWO = []'), null);
  assert.equal(parseOreillyHydration('window.__staticRouterHydrationData = JSON.parse("{bad");'), null);
});

test('oreillyProductExtras: 2e — subtitle, authors-only bios in viewOrder, USD list price', () => {
  const x = oreillyProductExtras(hydrationOf('programming-rust-2e'), '9781492052593');
  assert.equal(x.subtitle, 'Fast, Safe Systems Development');
  assert.deepEqual(x.price, { currency: 'USD', amount: '79.99' });
  const names = x.authorBio.split('\n\n').map((block) => block.split('\n')[0]);
  assert.deepEqual(names, ['Jim Blandy', 'Jason Orendorff', 'Leonora F. S. Tindall']);
  assert.match(x.authorBio, /^Jim Blandy\nJim Blandy has been programming since 1981/);
  assert.ok(!/Roumeliotis|Bleiel|McQuade/.test(x.authorBio)); // 编辑不是作者
});

test('oreillyProductExtras: early-release title with an HTML bio', () => {
  const x = oreillyProductExtras(hydrationOf('from-models-to-money-er'), '9798341674042');
  assert.equal(x.subtitle, 'A Leaders Guide to Understanding AI Unit Economics and the Total Cost of Intelligence');
  assert.deepEqual(x.price, { currency: 'USD', amount: '44.99' });
  assert.ok(!/<p>/.test(x.authorBio));
  assert.match(x.authorBio, /^Davood Shamsi\n/);
  assert.match(x.authorBio, /measurable results\.\n\nPreviously, as Senior Vice President/);
});

test('oreillyProductExtras: no record for this ISBN → empty, never another edition', () => {
  assert.deepEqual(oreillyProductExtras(hydrationOf('programming-rust-2e'), '9781098176235'), { subtitle: '', authorBio: '', price: null });
  assert.deepEqual(oreillyProductExtras(null, '9781492052593'), { subtitle: '', authorBio: '', price: null });
});

test('oreillyProductExtras: a single author gets no name header', () => {
  const h = { loaderData: { bookShellContainer: { data: { productServiceData: { data: [{
    isbn13: '9781492052593',
    contributors: [{ firstName: 'A', lastName: 'B', role: { name: 'Author' }, biography: 'Bio.' }],
  }] } } } } };
  assert.equal(oreillyProductExtras(h, '9781492052593').authorBio, 'Bio.');
});

test('bioHtmlToText: <p>/<br> become breaks, tags dropped, entities decoded', () => {
  assert.equal(bioHtmlToText('One &amp; two.\n<p>\nThree<br>four <b>bold</b>.</p>'), 'One & two.\n\nThree\nfour bold.');
  assert.equal(bioHtmlToText('Plain text.'), 'Plain text.');
});
