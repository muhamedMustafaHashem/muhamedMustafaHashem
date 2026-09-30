// Golden set runner: pushes real phone photos through the real app UI (Playwright) and
// reports accuracy and timing per OCR mode. This is the acceptance test before shipping.
//
//   tests/golden/labels.csv     lines of:  filename,expected_id     (# comments allowed)
//   tests/golden/*.jpg          the photos (git-ignored)
//
// Run against the deployed app:   node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode auto
// Run against the local mock:     node tests/golden_run.js --mock --mode local
// Writes tests/golden/results-<mode>.json and prints the summary table.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); }

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const MODE = args.mode || 'auto';
const DIR = path.join(__dirname, 'golden');
const labelsFile = path.join(DIR, 'labels.csv');
if (!fs.existsSync(labelsFile)) { console.error('missing tests/golden/labels.csv'); process.exit(2); }
const cases = fs.readFileSync(labelsFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const [file, id] = l.split(','); return { file: file.trim(), expected: Number(id) }; });

(async () => {
  let mock = null, url = args.url;
  if (args.mock || !url) {
    mock = spawn('node', [path.join(__dirname, 'mock_server.js'), '8125'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((ok) => mock.stdout.on('data', ok));
    url = 'http://localhost:8125/';
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true });
  await page.goto(url);
  await page.click(`#mode button[data-mode="${MODE}"]`);
  // give the local OCR engine time to warm up, as a real user opening the app would
  if (MODE !== 'google') await page.waitForTimeout(3000);

  const results = [];
  for (const c of cases) {
    const file = path.join(DIR, c.file);
    if (!fs.existsSync(file)) { results.push({ ...c, status: 'missing' }); continue; }
    const t0 = Date.now();
    await page.setInputFiles('#file', file);
    try { await page.waitForSelector('#view-work[data-done="1"]', { timeout: 30000 }); }
    catch { results.push({ ...c, status: 'timeout', ms: Date.now() - t0 }); await page.click('#btn-again'); continue; }
    const r = await page.evaluate(() => {
      const a = document.querySelector('#result .answer');
      const q = a && a.querySelector('.q');
      return {
        status: a ? (a.classList.contains('confident') ? 'confident' : 'candidates') : 'none',
        badge: a ? a.querySelector('.badge').textContent.trim() : '',
        matched_q: q ? q.textContent.trim() : '',
        cands: [...document.querySelectorAll('#result .cand')].map((e) => Number(e.dataset.id)),
      };
    });
    const ms = Date.now() - t0;
    // map the shown question back to an id via the dataset loaded in the page
    const shownId = await page.evaluate((qText) => {
      const M = window.Matcher; const n = M.normalize(qText);
      const it = window.__items && window.__items.find((i) => i.n === n); return it ? it.id : null;
    }, r.matched_q);
    const tier = r.badge.includes('محلية') ? 'A' : r.badge.includes('جوجل') ? 'B' : r.badge.includes('تحقق') ? 'C' : '';
    const correct = r.status === 'confident' ? shownId === c.expected : null;
    results.push({ ...c, status: r.status, tier, shownId, correct, inCandidates: r.cands.includes(c.expected), ms });
    console.log(`${c.file}: ${r.status}${tier ? ' via ' + tier : ''} ${ms} ms ${correct === true ? 'OK' : correct === false ? 'WRONG!' : ''}`);
    await page.click('#btn-again');
  }
  await browser.close(); if (mock) mock.kill();

  const n = results.length;
  const conf = results.filter((r) => r.status === 'confident');
  const wrong = conf.filter((r) => r.correct === false);
  const times = results.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  const med = times.length ? times[Math.floor(times.length / 2)] : 0;
  const byTier = ['A', 'B', 'C'].map((t) => `${t}=${conf.filter((r) => r.tier === t).length}`).join(' ');
  console.log('\n=== golden summary (mode ' + MODE + ') ===');
  console.log(`photos: ${n}`);
  console.log(`confident answers: ${conf.length} (${Math.round(100 * conf.length / n)}%), by tier ${byTier}`);
  console.log(`WRONG confident answers: ${wrong.length}  <- must be 0`);
  console.log(`candidates shown: ${results.filter((r) => r.status === 'candidates').length}, not found: ${results.filter((r) => r.status === 'none').length}, timeouts: ${results.filter((r) => r.status === 'timeout').length}`);
  console.log(`time: median ${med} ms, max ${times[times.length - 1] || 0} ms`);
  fs.writeFileSync(path.join(DIR, `results-${MODE}.json`), JSON.stringify(results, null, 2));
  process.exit(wrong.length ? 1 : 0);
})();
