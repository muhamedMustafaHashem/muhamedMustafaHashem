// Browser end-to-end test with Playwright + the mock API server.
// Renders Arabic questions to images, uploads them to the app in each OCR mode, checks the result.
// Run: node tests/e2e.js   (uses the globally installed playwright and /opt/pw-browsers chromium)
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }

const PORT = 8123;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample.questions.json'), 'utf8'));
const Q = data.items;

async function renderQuestion(browser, item, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 });
  const n = opts.number || 7;
  const options = opts.options ? `<ol style="font-size:30px;margin-top:18px"><li>القاهرة</li><li>الإسكندرية</li><li>أسوان</li></ol>` : '';
  await page.setContent(`<html dir="rtl"><body style="margin:0;background:#fff;padding:40px;font-family:'FreeSerif','DejaVu Sans',serif">
    <div style="font-size:40px;line-height:1.6;color:#111">${n}- ${item.q}</div>${options}</body></html>`);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

function startMock(env) {
  const p = spawn('node', [path.join(__dirname, 'mock_server.js'), String(PORT)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((ok) => p.stdout.on('data', () => ok(p)));
}

async function runCase(browser, { name, mode, item, mockOcr, expectTier, expectStatus, timeoutMs, options, breakVerify }) {
  const png = await renderQuestion(browser, item, { options });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
  if (breakVerify) await page.route('**/api/verify', (route) => route.abort());
  await page.route('**/api/ocr', (route) => route.continue({ headers: { ...route.request().headers(), 'x-mock-ocr': encodeURIComponent(mockOcr || '') } }));
  await page.addInitScript(() => localStorage.setItem('answer-app', JSON.stringify({ debug: true })));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click(`#mode button[data-mode="${mode}"]`);
  const t0 = Date.now();
  await page.setInputFiles('#file', { name: 'q.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('#view-work[data-done="1"]', { timeout: timeoutMs || 120000 });
  // wait until the run finished (timer stops / actions visible) - result rendered means finish() ran
  const res = await page.evaluate(() => {
    const a = document.querySelector('#result .answer');
    const notice = document.querySelector('#result .notice');
    return {
      status: a ? (a.classList.contains('confident') ? 'confident' : 'candidates') : (notice ? 'notice' : 'none'),
      badge: a ? a.querySelector('.badge').textContent.trim() : '',
      q: a ? (a.querySelector('.q') || {}).textContent || '' : '',
      notice: notice ? notice.textContent.trim() : '',
      debug: (document.querySelector('#result .debug') || {}).textContent || '',
      a: a ? (a.querySelector('.a') || {}).textContent || '' : '',
      cands: [...document.querySelectorAll('#result .cand .q')].map((e) => e.textContent.trim()),
      chips: [...document.querySelectorAll('.chip')].map((c) => `${c.dataset.tier}:${c.dataset.state}`).join(' '),
    };
  });
  const ms = Date.now() - t0;
  await page.close();
  const tierOk = !expectTier || res.badge.includes({ AB: 'قراءتان', C: 'تحقق', L: 'الأرجح' }[expectTier]);
  const statusOk = res.status === expectStatus;
  const answerOk = expectStatus !== 'confident' || res.a.trim() === item.a;
  const ok = tierOk && statusOk && answerOk;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} [${mode}] ${ms} ms -> ${res.status} "${res.badge}" answer="${res.a.trim()}" chips=${res.chips}${res.cands.length ? ' cands=' + JSON.stringify(res.cands) : ''}`);
  if (logs.length) console.log('   console:', logs.slice(0, 5).join(' | '));
  if (!ok) console.log('   notice:', res.notice, '\n   ocr:', JSON.stringify(res.debug.slice(0, 300)));
  return ok;
}

(async () => {
  const mock = await startMock({ MOCK_DELAY: '200' });
  const browser = await chromium.launch();
  const results = [];
  try {
    const q1 = Q[0], q2 = Q[1], q3 = Q[3], q4 = Q[12];
    // Google mock returns clean text -> candidates -> verifier confirms (accuracy first: always verified)
    results.push(await runCase(browser, { name: 'cloud clean', mode: 'google', item: q1, mockOcr: `7- ${q1.q}\nأ) القاهرة ب) الإسكندرية`, expectTier: 'C', expectStatus: 'confident' }));
    // Tier B returns garbage -> verifier (mock) picks the right one using the OCR hint from... nothing -> candidates
    results.push(await runCase(browser, { name: 'cloud unreadable', mode: 'google', item: q2, mockOcr: 'نص غير مفهوم تماماً', expectStatus: 'notice' }));
    // Tier B partial (one distinctive word missing) -> not confident -> Tier C (mock verifier) confirms
    results.push(await runCase(browser, { name: 'cloud partial -> verify', mode: 'google', item: q2, mockOcr: 'ما هو اطول نهر في', expectTier: 'C', expectStatus: 'confident' }));
    // Tier A: real Tesseract on a rendered image, local mode (no network OCR)
    results.push(await runCase(browser, { name: 'local tesseract', mode: 'local', item: q3, expectTier: 'C', expectStatus: 'confident', options: true }));
    results.push(await runCase(browser, { name: 'local tesseract 2', mode: 'local', item: q4, expectTier: 'C', expectStatus: 'confident' }));
    // verifier unreachable -> never a green answer; most likely question shown as unverified
    results.push(await runCase(browser, { name: 'verify down -> likely', mode: 'local', item: q4, breakVerify: true, expectTier: 'L', expectStatus: 'candidates' }));
    // Tier A with a poor photo of a question containing a Latin letter -> not confident -> verifier
    results.push(await runCase(browser, { name: 'local -> verify', mode: 'local', item: Q[5], expectTier: 'C', expectStatus: 'confident' }));
    // Auto: both OCRs run, verifier starts on Google's read
    results.push(await runCase(browser, { name: 'auto', mode: 'auto', item: q1, mockOcr: `${q1.q}`, expectTier: 'C', expectStatus: 'confident' }));
  } finally {
    await browser.close();
    mock.kill();
  }
  const pass = results.filter(Boolean).length;
  console.log(`${pass}/${results.length} cases passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
