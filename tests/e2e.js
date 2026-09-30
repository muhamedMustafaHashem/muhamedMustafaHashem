// Browser end-to-end test with Playwright + the mock API server.
// Renders Arabic questions to images and drives the real app: photo flow in each OCR mode, the subject
// picker (persistence, deep link, first-launch rule, wrong-subject fallback, cross-subject clash) and
// typed search (as-you-type, strict match badge, offline, all-subjects, edit-text bridge).
// Run: NODE_PATH=$(npm root -g) node tests/e2e.js   (uses the installed playwright + chromium)
// Needs public/data built from tests/sample_subjects (the committed sample data).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }

const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', f), 'utf8'));
const manifest = load('manifest.json');
const geoNo = String(manifest.subjects.find((s) => s.name === 'جغرافيا').number);
const sciNo = String(manifest.subjects.find((s) => s.name === 'علوم').number);
const GEO = load(`${geoNo}.json`).items;
const SCI = load(`${sciNo}.json`).items;
const find = (items, prefix) => items.find((i) => i.q.startsWith(prefix));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? passed++ : failed++;
}

async function renderQuestion(browser, item, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 });
  const options = opts.options ? `<ol style="font-size:30px;margin-top:18px"><li>القاهرة</li><li>الإسكندرية</li><li>أسوان</li></ol>` : '';
  await page.setContent(`<html dir="rtl"><body style="margin:0;background:#fff;padding:40px;font-family:'FreeSerif','DejaVu Sans',serif">
    <div style="font-size:40px;line-height:1.6;color:#111">7- ${item.q}</div>${options}</body></html>`);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

function startMock(env) {
  const p = spawn('node', [path.join(__dirname, 'mock_server.js'), String(PORT)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((ok) => p.stdout.on('data', () => ok(p)));
}

// Opens the app on a phone-sized page. opts.subject preselects a subject (only on the very first load).
async function openApp(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true });
  page.logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.logs.push(m.text()); });
  page.on('pageerror', (e) => page.logs.push('pageerror ' + e.message));
  if (opts.breakVerify) await page.route('**/api/verify', (route) => route.abort());
  await page.route('**/api/ocr', (route) => route.continue({ headers: { ...route.request().headers(), 'x-mock-ocr': encodeURIComponent(opts.mockOcr || '') } }));
  await page.addInitScript((subject) => {
    if (!localStorage.getItem('answer-app')) localStorage.setItem('answer-app', JSON.stringify({ debug: true, installHintSeen: true, subject: subject || '' }));
  }, opts.subject || '');
  await page.goto(BASE + (opts.query || ''));
  await page.waitForSelector('#subject option[value="' + geoNo + '"]', { state: 'attached' });
  if (opts.subject || opts.query) await page.waitForFunction(() => window.__items && window.__items.length > 0);
  return page;
}

const snapshot = (page) => page.evaluate(() => {
  const a = document.querySelector('#result .answer');
  const notice = document.querySelector('#result .notice');
  return {
    status: a ? (a.classList.contains('confident') ? 'confident' : 'candidates') : (notice ? 'notice' : 'none'),
    badge: a ? a.querySelector('.badge').textContent.trim() : '',
    subj: a && a.querySelector('.subj') ? a.querySelector('.subj').textContent.trim() : '',
    q: a ? (a.querySelector('.q') || {}).textContent || '' : '',
    a: a ? (a.querySelector('.a') || {}).textContent || '' : '',
    notice: notice ? notice.textContent.trim() : '',
    text: document.querySelector('#result').textContent,
    debug: (document.querySelector('#result .debug') || {}).textContent || '',
    cands: [...document.querySelectorAll('#result .cand .q')].map((e) => e.textContent.trim()),
    buttons: [...document.querySelectorAll('#result [data-act]')].map((b) => b.dataset.act),
    chips: [...document.querySelectorAll('.chip')].map((c) => `${c.dataset.tier}:${c.dataset.state}`).join(' '),
  };
});

async function photo(browser, page, item, mode, opts = {}) {
  const png = await renderQuestion(browser, item, opts);
  await page.click(`#mode button[data-mode="${mode}"]`);
  const t0 = Date.now();
  await page.setInputFiles('#file', { name: 'q.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#view-work[data-done="1"]', { timeout: 120000 });
  const res = await snapshot(page);
  res.ms = Date.now() - t0;
  return res;
}

// ---------------------------------------------------------------- photo flow
async function photoCase(browser, { name, mode, subject, item, mockOcr, expectBadge, expectStatus, options, breakVerify }) {
  const page = await openApp(browser, { subject, mockOcr, breakVerify });
  const r = await photo(browser, page, item, mode, { options });
  const ok = r.status === expectStatus && (!expectBadge || r.badge.includes(expectBadge)) && (expectStatus !== 'confident' || r.a.trim() === item.a);
  check(`photo: ${name} [${mode}]`, ok, `${r.ms} ms -> ${r.status} "${r.badge}" answer="${r.a.trim()}" chips=${r.chips}${r.status !== expectStatus ? ' ocr=' + JSON.stringify(r.debug.slice(0, 200)) : ''}`);
  await page.close();
}

// ---------------------------------------------------------------- subjects
async function subjectCases(browser) {
  const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
  const days = find(GEO, 'كم عدد أيام السنة');

  // first launch: no subject chosen -> capture and search locked until a subject is picked
  let page = await openApp(browser, {});
  check('subject: first launch asks for a subject', await page.evaluate(() => document.body.dataset.needSubject === '1'
    && getComputedStyle(document.querySelector('#search-box')).pointerEvents === 'none' && !!document.querySelector('#subject-hint').textContent));
  await page.selectOption('#subject', geoNo);
  await page.waitForFunction(() => window.__items && window.__items.length === 12);
  check('subject: choosing one unlocks the app and loads only that subject', await page.evaluate(() => document.body.dataset.needSubject === '' && window.__items.length === 12));
  // persistence: reload keeps the choice
  await page.reload();
  await page.waitForFunction(() => window.__items && window.__items.length === 12);
  check('subject: choice survives a reload', (await page.inputValue('#subject')) === geoNo);
  await page.close();

  // deep link
  page = await openApp(browser, { query: `?subject=${sciNo}` });
  check('subject: deep link ?subject= preselects it', (await page.inputValue('#subject')) === sciNo && (await page.evaluate(() => window.__items.every((i) => !i.subject))));
  await page.close();

  // wrong subject: geography question photographed while science is selected -> not found, offer all subjects
  page = await openApp(browser, { subject: sciNo, mockOcr: capital.q });
  let r = await photo(browser, page, capital, 'google');
  check('subject: photo of another subject is never green and says it is not in this subject',
    r.status !== 'confident' && r.a === '' && r.text.includes('هذه المادة') && !r.cands.some((c) => c.includes('عاصمة')), `-> ${r.status} ${JSON.stringify(r.text.slice(0, 80))}`);
  check('subject: not-found offers "search all subjects" and "edit text"', r.buttons.includes('all') && r.buttons.includes('edit'), JSON.stringify(r.buttons));
  await page.click('#result [data-act="all"]');
  await page.waitForFunction(() => document.querySelector('#view-work').dataset.done === '1' && document.querySelector('#result .answer'));
  r = await snapshot(page);
  check('subject: widening to all subjects gives a verified answer with the subject name', r.status === 'confident' && r.a.trim() === capital.a && r.subj.includes('جغرافيا'), `-> ${r.status} "${r.badge}" ${r.subj} ${r.a}`);
  await page.close();

  // cross-subject clash: same question, different answers -> never green
  page = await openApp(browser, { subject: 'all', mockOcr: days.q });
  r = await photo(browser, page, days, 'google');
  check('subject: same question with different answers in two subjects is never green', r.status === 'candidates' && r.text.includes('أكثر من مادة') && r.cands.length >= 2, `-> ${r.status} ${JSON.stringify(r.cands)}`);
  check('subject: both subject names are shown on the clash', r.cands.some((c) => c.includes('جغرافيا')) && r.cands.some((c) => c.includes('علوم')));
  await page.close();

  // edit-text bridge: unreadable photo -> "edit text" fills the search box with what the OCR read
  page = await openApp(browser, { subject: geoNo, mockOcr: 'نص غير مفهوم تماماً' });
  r = await photo(browser, page, days, 'google');
  await page.click('#result [data-act="edit"]');
  const filled = await page.inputValue('#q-input');
  check('search: "edit text" pre-fills the search box with the OCR text', filled.includes('نص غير مفهوم') && await page.isVisible('#view-home'), JSON.stringify(filled));
  await page.close();
}

// ---------------------------------------------------------------- typed search
async function searchCases(browser) {
  const river = find(GEO, 'ما هو أطول نهر في العالم');
  const days = find(GEO, 'كم عدد أيام السنة');
  const page = await openApp(browser, { subject: geoNo });
  const results = () => page.evaluate(() => ({
    badge: (document.querySelector('#search-results .badge') || {}).textContent || '',
    cards: [...document.querySelectorAll('#search-results .cand')].map((c) => ({ q: c.querySelector('.q').textContent.trim(), open: c.classList.contains('open'), a: c.querySelector('.a').textContent.trim(), marks: c.querySelectorAll('mark').length })),
    text: document.querySelector('#search-results').textContent,
  }));

  const typed = async (text, enter) => {
    await page.fill('#q-input', text);
    if (enter) await page.press('#q-input', 'Enter');
    await page.waitForFunction((q) => document.querySelector('#search-results').dataset.q === q, text);
    return results();
  };
  let r = await typed('أطول نهر');
  check('search: a fragment finds the question, top card open, words highlighted', r.cards[0].q.includes('أطول نهر') && r.cards[0].open && r.cards[0].marks >= 2, JSON.stringify(r.cards[0]));
  check('search: a fragment is a suggestion, not a "مطابق"', r.badge.includes('نتائج مقترحة'), r.badge);

  r = await typed(river.q, true);
  check('search: the full question + Enter is "✓ مطابق" with its answer', r.badge.includes('مطابق') && r.cards[0].open && r.cards[0].a === river.a, `${r.badge} ${r.cards[0].a}`);

  // as-you-type: half-typed last word still finds it
  r = await typed('ما هي أكبر صحر');
  check('search: a half-typed last word matches by prefix', r.cards[0].q.includes('صحراء'), r.cards[0].q);

  // works offline (pure local)
  await page.context().setOffline(true);
  r = await typed('عاصمة فرنسا');
  check('search: works with the network off', r.cards[0].q.includes('فرنسا') && r.cards[0].a === 'باريس', r.cards[0].q);
  await page.context().setOffline(false);

  // nothing found -> message and "search all subjects"
  r = await typed('الفيزياء النووية المتقدمة');
  check('search: no result shows a message and offers all subjects', r.text.includes('لا توجد') && (await page.isVisible('#search-results [data-act="search-all"]')));

  // widen to all subjects from the search box, then a clash question
  await page.click('#search-results [data-act="search-all"]');
  await page.waitForFunction(() => window.__items && window.__items.length === 24);
  r = await typed(days.q, true);
  const subjTags = await page.evaluate(() => [...document.querySelectorAll('#search-results .subj')].map((e) => e.textContent.trim()));
  check('search: same question in two subjects lists both with subject names, no ✓ مطابق, nothing auto-opened',
    !r.badge.includes('مطابق') && r.cards.length >= 2 && r.cards.every((c) => !c.open) && subjTags.includes('جغرافيا') && subjTags.includes('علوم') && r.text.includes('إجابات مختلفة'),
    `${r.badge} ${JSON.stringify(subjTags)}`);
  // clear button
  await page.click('#q-clear');
  check('search: the clear button empties the box and the results', (await page.inputValue('#q-input')) === '' && (await page.$$('#search-results .cand')).length === 0);
  await page.close();
}

(async () => {
  const mock = await startMock({ MOCK_DELAY: '200' });
  const browser = await chromium.launch();
  try {
    const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
    const river = find(GEO, 'ما هو أطول نهر في العالم');
    const bulb = find(SCI, 'من مخترع المصباح') || find(SCI, 'من هو مخترع المصباح');
    const oxygen = find(SCI, 'ما هو العنصر الكيميائي');
    // photo flow, geography selected (accuracy first: always verified by the photo verifier)
    await photoCase(browser, { name: 'cloud clean', mode: 'google', subject: geoNo, item: capital, mockOcr: `7- ${capital.q}\nأ) القاهرة ب) الإسكندرية`, expectBadge: 'تحقق', expectStatus: 'confident' });
    await photoCase(browser, { name: 'cloud unreadable', mode: 'google', subject: geoNo, item: river, mockOcr: 'نص غير مفهوم تماماً', expectStatus: 'notice' });
    await photoCase(browser, { name: 'cloud partial -> verify', mode: 'google', subject: geoNo, item: river, mockOcr: 'ما هو اطول نهر في', expectBadge: 'تحقق', expectStatus: 'confident' });
    await photoCase(browser, { name: 'auto', mode: 'auto', subject: geoNo, item: capital, mockOcr: capital.q, expectBadge: 'تحقق', expectStatus: 'confident' });
    // real Tesseract on rendered images, science selected
    await photoCase(browser, { name: 'local tesseract', mode: 'local', subject: sciNo, item: bulb, expectBadge: 'تحقق', expectStatus: 'confident', options: true });
    await photoCase(browser, { name: 'local tesseract 2', mode: 'local', subject: sciNo, item: oxygen, expectBadge: 'تحقق', expectStatus: 'confident' });
    // verifier unreachable -> never green; most likely question shown as unverified
    await photoCase(browser, { name: 'verify down -> likely', mode: 'local', subject: sciNo, item: bulb, breakVerify: true, expectBadge: 'الأرجح', expectStatus: 'candidates' });
    await subjectCases(browser);
    await searchCases(browser);
  } finally {
    await browser.close();
    mock.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
