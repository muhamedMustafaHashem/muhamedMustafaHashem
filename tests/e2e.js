// Browser end-to-end test with Playwright + the mock API server.
// Renders Arabic questions to images and drives the real app.
//   Suites A/B run twice: with subjects built into the app ("bundled") and with the same two subjects
//   uploaded through the app's own upload dialog ("upload", stored in the phone's IndexedDB):
//     photo flow in each OCR mode, subject picker (persistence, wrong-subject fallback, cross-subject
//     clash), typed search (as-you-type, strict match badge, offline, all-subjects, edit-text bridge).
//   Suite C covers uploading itself: empty state, preview and column check, warnings, unsupported files,
//     CSV, replacing a subject, rename/delete, persistence and the privacy of what is sent to the server.
// Run: NODE_PATH=$(npm root -g) node tests/e2e.js   (uses the installed playwright + chromium)
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }

const PORT_BUNDLED = 8123, PORT_UPLOAD = 8124, PORT_NOVERIFY = 8126;
const SAMPLE = path.join(__dirname, 'sample_bundled');
const load = (f) => JSON.parse(fs.readFileSync(path.join(SAMPLE, f), 'utf8'));
const bundled = load('manifest.json');
const GEO = load(`${bundled.subjects.find((s) => s.name === 'جغرافيا').file}`).items;
const SCI = load(`${bundled.subjects.find((s) => s.name === 'علوم').file}`).items;
const find = (items, prefix) => items.find((i) => i.q.startsWith(prefix));

// workbooks used for uploading
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const FILES = { subjects: path.join(tmp, 'subjects'), fx: path.join(tmp, 'fx'), v2: path.join(tmp, 'v2') };
execFileSync('python3', [path.join(__dirname, 'make_sample_subjects.py'), FILES.subjects], { stdio: 'ignore' });
execFileSync('python3', [path.join(__dirname, 'make_import_fixtures.py'), FILES.fx], { stdio: 'ignore' });
execFileSync('python3', ['-c', `import sys; sys.path.insert(0, '${__dirname}'); import make_sample_subjects as m, os; os.makedirs('${FILES.v2}', exist_ok=True); m.write('${FILES.v2}/جغرافيا.xlsx', m.GEOGRAPHY + [('ما هي عاصمة كندا؟', 'أوتاوا')])`], { stdio: 'ignore' });
const GEO_XLSX = path.join(FILES.subjects, 'جغرافيا.xlsx'), SCI_XLSX = path.join(FILES.subjects, 'علوم.xlsx');
fs.writeFileSync(path.join(tmp, 'old.xls'), 'not really xls');
fs.writeFileSync(path.join(tmp, 'notes.docx'), 'not really docx');
fs.writeFileSync(path.join(tmp, 'تاريخ.csv'), '﻿السؤال,الإجابة\n"في أي عام قامت ثورة 23 يوليو؟",1952\n"من بنى الهرم الأكبر؟","الملك خوفو"\n', 'utf8');

let passed = 0, failed = 0, PREFIX = '';
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${PREFIX}${name}${extra ? '  ' + extra : ''}`);
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

function startMock(port, env) {
  const p = spawn('node', [path.join(__dirname, 'mock_server.js'), String(port)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((ok) => p.stdout.on('data', () => ok(p)));
}

// ------------------------------------------------------------------ app helpers
let CTX = { mode: 'bundled', base: `http://localhost:${PORT_BUNDLED}/` };

async function newPage(browser, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true });
  page.logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page.logs.push(m.text()); });
  page.on('pageerror', (e) => page.logs.push('pageerror ' + e.message));
  if (opts.breakVerify) await page.route('**/api/verify', (route) => route.abort());
  await page.route('**/api/ocr', (route) => route.continue({ headers: { ...route.request().headers(), 'x-mock-ocr': encodeURIComponent(opts.mockOcr || '') } }));
  await page.addInitScript(() => {
    if (!localStorage.getItem('answer-app')) localStorage.setItem('answer-app', JSON.stringify({ debug: true, installHintSeen: true }));
  });
  return page;
}

// Files are passed as in-memory payloads: Playwright cannot open paths with Arabic names in this
// container's locale, and the app only sees the file name and bytes anyway.
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
async function uploadFiles(page, files) {
  await page.setInputFiles('#xl-input', files.map((f) => ({ name: path.basename(f), mimeType: MIME[f.split('.').pop()] || 'application/octet-stream', buffer: fs.readFileSync(f) })));
  await page.waitForSelector('#import-dialog[open] .imp');
}
async function saveUpload(page) {
  await page.click('#import-save');
  await page.waitForSelector('#import-dialog', { state: 'hidden' });
  await page.waitForFunction(() => window.__items && window.__items.length > 0);
}
const wantItems = { geo: 12, sci: 12, all: 24 };
async function selectSubject(page, key) {
  await page.selectOption('#subject', key === 'all' ? 'all' : page.nums[key]);
  await page.waitForFunction((n) => window.__items && window.__items.length === n, wantItems[key]);
}
async function readNums(page) {
  page.nums = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#subject option').forEach((o) => {
      const name = o.textContent.trim().split(' (')[0];
      if (name === 'جغرافيا') out.geo = o.value;
      if (name === 'علوم') out.sci = o.value;
    });
    return out;
  });
}
// Opens the app with the two sample subjects available, in the current mode, optionally selecting one.
async function openApp(browser, opts = {}) {
  const page = await newPage(browser, opts);
  await page.goto(CTX.base + (opts.query || ''));
  if (CTX.mode === 'bundled') {
    await page.waitForSelector('#subject option[value="1"]', { state: 'attached' });
  } else {
    await page.waitForSelector('#empty-card:not([hidden])');
    await uploadFiles(page, [GEO_XLSX, SCI_XLSX]);
    await saveUpload(page);
  }
  await readNums(page);
  if (opts.subject) await selectSubject(page, opts.subject);
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

// ------------------------------------------------------------------ suite A: photo flow
async function photoCase(browser, { name, mode, subject, item, mockOcr, expectBadge, expectStatus, options, breakVerify }) {
  const page = await openApp(browser, { subject, mockOcr, breakVerify });
  const r = await photo(browser, page, item, mode, { options });
  const ok = r.status === expectStatus && (!expectBadge || r.badge.includes(expectBadge)) && (expectStatus !== 'confident' || r.a.trim() === item.a);
  check(`photo: ${name} [${mode}]`, ok, `${r.ms} ms -> ${r.status} "${r.badge}" answer="${r.a.trim()}" chips=${r.chips}${r.status !== expectStatus ? ' ocr=' + JSON.stringify(r.debug.slice(0, 200)) : ''}`);
  await page.close();
}
async function photoSuite(browser) {
  const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
  const river = find(GEO, 'ما هو أطول نهر في العالم');
  const bulb = find(SCI, 'من هو مخترع المصباح');
  const oxygen = find(SCI, 'ما هو العنصر الكيميائي');
  await photoCase(browser, { name: 'cloud clean', mode: 'google', subject: 'geo', item: capital, mockOcr: `7- ${capital.q}\nأ) القاهرة ب) الإسكندرية`, expectBadge: 'تحقق', expectStatus: 'confident' });
  await photoCase(browser, { name: 'cloud unreadable', mode: 'google', subject: 'geo', item: river, mockOcr: 'نص غير مفهوم تماماً', expectStatus: 'notice' });
  await photoCase(browser, { name: 'cloud partial -> verify', mode: 'google', subject: 'geo', item: river, mockOcr: 'ما هو اطول نهر في', expectBadge: 'تحقق', expectStatus: 'confident' });
  await photoCase(browser, { name: 'auto', mode: 'auto', subject: 'geo', item: capital, mockOcr: capital.q, expectBadge: 'تحقق', expectStatus: 'confident' });
  await photoCase(browser, { name: 'local tesseract', mode: 'local', subject: 'sci', item: bulb, expectBadge: 'تحقق', expectStatus: 'confident', options: true });
  await photoCase(browser, { name: 'local tesseract 2', mode: 'local', subject: 'sci', item: oxygen, expectBadge: 'تحقق', expectStatus: 'confident' });
  await photoCase(browser, { name: 'verify down -> likely', mode: 'local', subject: 'sci', item: bulb, breakVerify: true, expectBadge: 'الأرجح', expectStatus: 'candidates' });
}

// ------------------------------------------------------------------ suite B: subjects and typed search
async function subjectSuite(browser) {
  const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
  const days = find(GEO, 'كم عدد أيام السنة');

  if (CTX.mode === 'bundled') {
    // first launch: no subject chosen -> capture and search locked until a subject is picked
    let page = await newPage(browser);
    await page.goto(CTX.base);
    await page.waitForSelector('#subject option[value="1"]', { state: 'attached' });
    check('subject: first launch asks for a subject', await page.evaluate(() => document.body.dataset.needSubject === '1'
      && getComputedStyle(document.querySelector('#search-box')).pointerEvents === 'none' && !!document.querySelector('#subject-hint').textContent));
    await page.close();
    // deep link (built-in subjects)
    page = await newPage(browser);
    await page.goto(CTX.base + '?subject=2');
    await page.waitForFunction(() => window.__items && window.__items.length > 0);
    check('subject: deep link ?subject= preselects it', (await page.inputValue('#subject')) === '2' && (await page.evaluate(() => window.__items.every((i) => !i.subject))));
    await page.close();
  }

  let page = await openApp(browser, { subject: 'geo' });
  check('subject: choosing one loads only that subject and unlocks the app', await page.evaluate(() => document.body.dataset.needSubject === '' && window.__items.length === 12));
  await page.reload();
  await page.waitForFunction(() => window.__items && window.__items.length === 12);
  check('subject: choice survives a reload', (await page.inputValue('#subject')) === page.nums.geo);
  await page.close();

  // wrong subject: geography question photographed while science is selected -> not found, offer all subjects
  page = await openApp(browser, { subject: 'sci', mockOcr: capital.q });
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
  check('subject: same question with different answers in two subjects is never green', r.status === 'candidates' && r.text.includes('أكثر من مرة') && r.cands.length >= 2, `-> ${r.status} ${JSON.stringify(r.cands)}`);
  check('subject: both subject names are shown on the clash', r.cands.some((c) => c.includes('جغرافيا')) && r.cands.some((c) => c.includes('علوم')));
  await page.close();

  // edit-text bridge: unreadable photo -> "edit text" fills the search box with what the OCR read
  page = await openApp(browser, { subject: 'geo', mockOcr: 'نص غير مفهوم تماماً' });
  r = await photo(browser, page, days, 'google');
  await page.click('#result [data-act="edit"]');
  const filled = await page.inputValue('#q-input');
  check('search: "edit text" pre-fills the search box with the OCR text', filled.includes('نص غير مفهوم') && await page.isVisible('#view-home'), JSON.stringify(filled));
  await page.close();
}

async function searchSuite(browser) {
  const river = find(GEO, 'ما هو أطول نهر في العالم');
  const days = find(GEO, 'كم عدد أيام السنة');
  const page = await openApp(browser, { subject: 'geo' });
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
  r = await typed('ما هي أكبر صحر');
  check('search: a half-typed last word matches by prefix', r.cards[0].q.includes('صحراء'), r.cards[0].q);
  await page.context().setOffline(true);
  r = await typed('عاصمة فرنسا');
  check('search: works with the network off', r.cards[0].q.includes('فرنسا') && r.cards[0].a === 'باريس', r.cards[0].q);
  await page.context().setOffline(false);
  r = await typed('الفيزياء النووية المتقدمة');
  check('search: no result shows a message and offers all subjects', r.text.includes('لا توجد') && (await page.isVisible('#search-results [data-act="search-all"]')));
  await page.click('#search-results [data-act="search-all"]');
  await page.waitForFunction(() => window.__items && window.__items.length === 24);
  r = await typed(days.q, true);
  const subjTags = await page.evaluate(() => [...document.querySelectorAll('#search-results .subj:not(.idtag)')].map((e) => e.textContent.trim()));
  check('search: same question in two subjects lists both with subject names, no ✓ مطابق, nothing auto-opened',
    !r.badge.includes('مطابق') && r.cards.length >= 2 && r.cards.every((c) => !c.open) && subjTags.includes('جغرافيا') && subjTags.includes('علوم') && r.text.includes('بإجابات مختلفة'),
    `${r.badge} ${JSON.stringify(subjTags)}`);
  await page.click('#q-clear');
  check('search: the clear button empties the box and the results', (await page.inputValue('#q-input')) === '' && (await page.$$('#search-results .cand')).length === 0);
  await page.close();
}

// ------------------------------------------------------------------ suite C: uploading itself
async function selectSubjectByLabel(page, label) {
  await page.selectOption('#subject', { label });
  await page.waitForFunction(() => window.__items && window.__items.length > 0);
}
async function uploadSuite(browser) {
  const base = `http://localhost:${PORT_UPLOAD}/`;
  const cards = (page) => page.evaluate(() => [...document.querySelectorAll('#import-list .imp')].map((c) => ({
    name: c.querySelector('.imp-name').value, count: (c.querySelector('.imp-count') || {}).textContent || '',
    replace: (c.querySelector('.imp-replace') || {}).textContent || '', notes: [...c.querySelectorAll('.imp-note')].map((n) => n.textContent),
    error: (c.querySelector('.notice.error') || {}).textContent || '', colsOpen: !!(c.querySelector('details') || {}).open, sample: (c.querySelector('.imp-sample') || {}).textContent || '',
  })));
  const options = (page) => page.evaluate(() => [...document.querySelectorAll('#subject option')].map((o) => o.textContent.trim()));

  // 1. empty state: nothing built in and nothing uploaded
  let page = await newPage(browser);
  await page.goto(base);
  await page.waitForSelector('#empty-card:not([hidden])');
  check('upload: empty state invites the user to upload; camera and search are locked, picker hidden',
    await page.evaluate(() => document.querySelector('#subject-card').hidden && getComputedStyle(document.querySelector('.capture')).pointerEvents === 'none'
      && getComputedStyle(document.querySelector('#search-box')).pointerEvents === 'none'));
  check('upload: the empty state says where the data lives', (await page.textContent('#empty-card')).includes('على هاتفك فقط'));

  // 2. preview of two files: names from file names, counts, sample rows, nothing saved yet
  await uploadFiles(page, [GEO_XLSX, SCI_XLSX]);
  let c = await cards(page);
  check('upload: preview shows one card per file with subject name and question count', c.length === 2 && c[0].name === 'جغرافيا' && c[0].count.includes('12') && c[1].name === 'علوم' && c[1].count.includes('12'), JSON.stringify(c.map((x) => [x.name, x.count])));
  check('upload: preview shows sample rows from the file', c[0].sample.includes('ما هي عاصمة جمهورية مصر') && c[0].sample.includes('القاهرة'));
  check('upload: nothing is saved until the user confirms', (await options(page)).length <= 1);
  check('upload: save button counts the subjects', (await page.textContent('#import-save')).includes('2'));
  await saveUpload(page);
  const opts = await options(page);
  check('upload: after saving the picker lists both subjects and "كل المواد"; the first one is selected', opts.includes('جغرافيا (12)') && opts.includes('علوم (12)') && opts.includes('كل المواد') && (await page.evaluate(() => window.__items.length)) === 12, JSON.stringify(opts));
  check('upload: saving confirms with a message', (await page.textContent('#status-line')).includes('تم حفظ'));

  // 3. persistence across a reload (IndexedDB)
  await page.reload();
  await page.waitForFunction(() => window.__items && window.__items.length === 12);
  check('upload: subjects and the selection survive a reload', (await options(page)).includes('علوم (12)') && (await page.evaluate(() => document.body.dataset.empty)) === '');

  // 4. unsupported files fail with a clear reason and can be removed
  await uploadFiles(page, [path.join(tmp, 'old.xls'), path.join(tmp, 'notes.docx')]);
  c = await cards(page);
  check('upload: an old .xls file is refused with instructions to save as xlsx', c[0].error.includes('xlsx') && c[0].error.includes('xls'), c[0].error);
  check('upload: an unsupported file type is refused', c[1].error.includes('غير مدعوم'), c[1].error);
  check('upload: nothing can be saved when every file failed', await page.isDisabled('#import-save'));
  await page.click('#import-cancel');

  // 5. column check: an unrecognised answer column must be chosen by the user
  await uploadFiles(page, [path.join(FILES.fx, 'unknown_cols.xlsx')]);
  c = await cards(page);
  check('upload: unrecognised columns are flagged, the column selector is open and save is blocked',
    c[0].colsOpen && c[0].notes.some((n) => n.includes('اختر عمود')) && (await page.isDisabled('#import-save')), JSON.stringify(c[0]));
  const sels = await page.$$('#import-list select');
  await sels[1].selectOption({ index: 2 }); // answer column = the second column (option 0 is "ignore")
  c = await cards(page);
  check('upload: choosing the answer column imports the sheet and enables save', c[0].count.includes('1') && !(await page.isDisabled('#import-save')), JSON.stringify(c[0]));
  await page.click('#import-cancel');

  // 6. warnings: conflicting duplicates are kept, reported, and never confirmable
  await uploadFiles(page, [path.join(FILES.fx, 'conflict.xlsx')]);
  c = await cards(page);
  check('upload: a question with two different answers is reported as a warning', c[0].notes.some((n) => n.includes('إجابتين مختلفتين') && n.includes('⚠')) && c[0].notes.some((n) => n.includes('دمج')), JSON.stringify(c[0].notes));
  await saveUpload(page);
  await selectSubjectByLabel(page, 'conflict (3)');
  await page.fill('#q-input', 'ما هو الكوكب الأقرب للشمس؟');
  await page.press('#q-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#search-results').dataset.q === 'ما هو الكوكب الأقرب للشمس؟');
  const clash = await page.evaluate(() => ({ badge: document.querySelector('#search-results .badge').textContent, open: document.querySelectorAll('#search-results .cand.open').length, n: document.querySelectorAll('#search-results .cand').length }));
  check('upload: a question kept with two answers is never "مطابق" and shows both', !clash.badge.includes('مطابق') && clash.open === 0 && clash.n >= 2, JSON.stringify(clash));

  // 7. CSV upload (UTF-8 with BOM)
  await uploadFiles(page, [path.join(tmp, 'تاريخ.csv')]);
  c = await cards(page);
  check('upload: a CSV file becomes a subject named after the file', c[0].name === 'تاريخ' && c[0].count.includes('2'), JSON.stringify(c[0]));
  await saveUpload(page);
  check('upload: the CSV subject is selected and searchable', (await page.evaluate(() => window.__items.length)) === 2);

  // 8. same name again = replace, with a notice; counts update
  await selectSubjectByLabel(page, 'جغرافيا (12)');
  await uploadFiles(page, [path.join(FILES.v2, 'جغرافيا.xlsx')]);
  c = await cards(page);
  check('upload: a file with the name of an existing subject says it will replace it', c[0].replace.includes('استبدالها') && c[0].replace.includes('12') && c[0].count.includes('13'), JSON.stringify(c[0]));
  await saveUpload(page);
  const opts2 = await options(page);
  check('upload: the subject was replaced (13 questions) and not duplicated', opts2.includes('جغرافيا (13)') && !opts2.includes('جغرافيا (12)') && opts2.filter((o) => o.startsWith('جغرافيا')).length === 1, JSON.stringify(opts2));

  // 9. manage: rename, delete, and both persist
  await page.click('#btn-manage');
  await page.waitForSelector('#manage-dialog[open] .mrow');
  page.once('dialog', (d) => d.accept('تاريخ مصر'));
  await page.click('#manage-list .mrow:has-text("تاريخ") [data-mg="rename"]');
  await page.waitForFunction(() => [...document.querySelectorAll('#subject option')].some((o) => o.textContent.startsWith('تاريخ مصر')));
  check('upload: renaming a subject updates the picker', (await options(page)).includes('تاريخ مصر (2)'));
  page.once('dialog', (d) => d.accept());
  await page.click('#manage-list .mrow:has-text("conflict") [data-mg="delete"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('#subject option')].some((o) => o.textContent.startsWith('conflict')));
  check('upload: deleting a subject removes it', !(await options(page)).some((o) => o.startsWith('conflict')));
  await page.click('#manage-close');
  await page.reload();
  await page.waitForFunction(() => window.__items && window.__items.length > 0);
  const opts3 = await options(page);
  check('upload: rename and delete persist after a reload', opts3.includes('تاريخ مصر (2)') && !opts3.some((o) => o.startsWith('conflict')), JSON.stringify(opts3));
  await page.close();

  // 10. deleting everything brings the empty state back
  page = await newPage(browser);
  await page.goto(base);
  await page.waitForSelector('#empty-card:not([hidden])');
  await uploadFiles(page, [path.join(tmp, 'تاريخ.csv')]);
  await saveUpload(page);
  await page.click('#btn-manage');
  page.once('dialog', (d) => d.accept());
  await page.click('#manage-list [data-mg="delete"]');
  await page.waitForSelector('#empty-card:not([hidden])');
  check('upload: deleting the last subject shows the empty state again', await page.evaluate(() => document.body.dataset.empty === '1' && document.querySelector('#subject-card').hidden));
  await page.close();

  // 11. privacy: the verify request carries the photo and candidate QUESTIONS, never the answers
  CTX = { mode: 'upload', base };
  const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
  page = await openApp(browser, { subject: 'geo', mockOcr: capital.q });
  await photo(browser, page, capital, 'google');
  const sent = JSON.parse(await (await page.request.get(base + 'api/_last_verify')).text()).text;
  const all = GEO.concat(SCI);
  const answers = all.map((i) => i.a).filter((a) => a.length > 3 && !all.some((i) => i.q.includes(a)));
  check('privacy: the server receives the candidate questions', sent.includes('ما هي عاصمة جمهورية مصر'));
  check('privacy: no answer text is sent to the server', !answers.some((a) => sent.includes(a)), JSON.stringify(answers.filter((a) => sent.includes(a))));
  await page.close();
}

// ------------------------------------------------------------------ suite D: photo check switched off (VERIFY_MODE=off)
async function noVerifySuite(browser) {
  const base = `http://localhost:${PORT_NOVERIFY}/`;
  const capital = find(GEO, 'ما هي عاصمة جمهورية مصر');
  const river = find(GEO, 'ما هو أطول نهر في العالم');
  const days = find(GEO, 'كم عدد أيام السنة');
  CTX = { mode: 'bundled', base };
  // both readers agree (local Tesseract reads the rendered photo, mock cloud returns the clean text) -> green without any verify call
  let page = await openApp(browser, { subject: 'geo', mockOcr: capital.q });
  await page.waitForFunction(() => document.body.dataset.verify === 'off');
  check('no-verify: the app learns the mode from /api/health and says so in the hint', (await page.textContent('#mode-hint')).includes('مطفأ'));
  let r = await photo(browser, page, capital, 'auto');
  check('no-verify: both readers agree -> green "قراءتان متطابقتان", verifier chip skipped', r.status === 'confident' && r.badge.includes('قراءتان') && r.a.trim() === capital.a && r.chips.includes('C:skip'), `${r.status} "${r.badge}" ${r.chips}`);
  await page.close();
  // Google-only mode still runs the local reader, because the rule needs two readers
  page = await openApp(browser, { subject: 'geo', mockOcr: capital.q });
  r = await photo(browser, page, capital, 'google');
  check('no-verify: google mode still runs the phone reader and can be green', r.status === 'confident' && r.chips.includes('A:done'), `${r.status} ${r.chips}`);
  await page.close();
  // readers disagree (cloud text names another question) -> never green
  page = await openApp(browser, { subject: 'geo', mockOcr: river.q });
  r = await photo(browser, page, capital, 'auto');
  check('no-verify: readers disagree -> orange "likely", never green', r.status === 'candidates' && r.badge.includes('الأرجح') && r.text.includes('لم تتفقا'), `${r.status} "${r.badge}"`);
  await page.close();
  // only one reader confident (cloud unreadable) -> orange
  page = await openApp(browser, { subject: 'geo', mockOcr: 'نص غير مفهوم تماماً' });
  r = await photo(browser, page, capital, 'auto');
  check('no-verify: one confident reader only -> orange, says so', r.status === 'candidates' && r.text.includes('قراءة واحدة'), `${r.status} "${r.badge}" ${r.text.slice(0, 60)}`);
  await page.close();
  // same question with two answers in all subjects -> never green even when both readers agree
  page = await openApp(browser, { subject: 'all', mockOcr: days.q });
  r = await photo(browser, page, days, 'auto');
  check('no-verify: a question with two different answers is never green', r.status !== 'confident', `${r.status} "${r.badge}"`);
  await page.close();
  // the remembered mode survives a start without network access to /api/health
  page = await newPage(browser);
  await page.route('**/api/health', (route) => route.abort());
  await page.goto(base);
  await page.waitForSelector('#subject option[value="1"]', { state: 'attached' });
  await page.waitForTimeout(400);
  check('no-verify: a fresh page with no health reply falls back to "gemini" (safe default)', await page.evaluate(() => document.body.dataset.verify) === 'gemini');
  await page.close();
}

// ------------------------------------------------------------------ run
(async () => {
  const mockBundled = await startMock(PORT_BUNDLED, { MOCK_DELAY: '200', DATA_DIR: SAMPLE });
  const mockUpload = await startMock(PORT_UPLOAD, { MOCK_DELAY: '200', DATA_DIR: 'none' });
  const mockNoVerify = await startMock(PORT_NOVERIFY, { MOCK_DELAY: '200', DATA_DIR: SAMPLE, VERIFY_MODE: 'off' });
  const browser = await chromium.launch();
  try {
    for (const mode of ['bundled', 'upload']) {
      CTX = { mode, base: `http://localhost:${mode === 'bundled' ? PORT_BUNDLED : PORT_UPLOAD}/` };
      PREFIX = `[${mode}] `;
      await photoSuite(browser);
      await subjectSuite(browser);
      await searchSuite(browser);
    }
    PREFIX = '';
    await uploadSuite(browser);
    await noVerifySuite(browser);
  } finally {
    await browser.close();
    mockBundled.kill(); mockUpload.kill(); mockNoVerify.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
