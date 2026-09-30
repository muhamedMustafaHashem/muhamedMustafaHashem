// Importer tests (Node): the in-app Excel reader must give the same questions as tools/build_data.py,
// handle the layouts real users bring, keep conflicting duplicates (never confirmable), and reject
// unsupported files with a clear reason. Run: node tests/importer.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const M = require('../public/matcher.js');
const I = require('../public/importer.js');
// the vendored read-excel-file bundle is a UMD script: load it the way a browser <script> would
const shim = { exports: {} };
new Function('module', 'exports', fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'read-excel-file.min.js'), 'utf8'))(shim, shim.exports);
const readXlsx = shim.exports;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
const fx = path.join(tmp, 'fixtures');
execFileSync('python3', [path.join(__dirname, 'make_import_fixtures.py'), fx], { stdio: 'ignore' });
execFileSync('python3', [path.join(__dirname, 'make_sample_subjects.py'), path.join(tmp, 'subjects')], { stdio: 'ignore' });

let fails = 0;
function check(cond, msg, extra) { console.log((cond ? 'PASS ' : 'FAIL ') + msg + (extra && !cond ? '  ' + extra : '')); if (!cond) fails++; }

function asFile(p) { // a File-like object as the browser gives it
  const buf = fs.readFileSync(p);
  return { name: path.basename(p), size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), _buf: buf };
}
// the reader accepts Blob/ArrayBuffer; in Node hand it a Blob
async function readSheets(p) {
  const f = asFile(p);
  return I.readFile({ ...f, name: f.name }, (file) => readXlsx(new Blob([f._buf])));
}
function importAuto(sheetsInfo) { // analyse each sheet and build with the proposed mapping
  const sheets = sheetsInfo.sheets.map((s) => {
    const a = I.analyzeSheet(s.rows);
    return { ...s, info: a, map: a.status === 'invalid' ? null : { headerRow: a.headerRow, q: a.q, a: a.a, opts: a.opts } };
  });
  return { sheets, ...I.buildFromSheets(sheets) };
}
function pyBuild(file) { // what tools/build_data.py produces for the same workbook
  const out = path.join(tmp, 'py_' + path.basename(file, '.xlsx'));
  execFileSync('python3', [path.join(ROOT, 'tools', 'build_data.py'), file, '--source', '/nonexistent', '--out-dir', out,
    '--registry', path.join(out + '.json'), '--report', path.join(out + '.txt'), '--near', '0.85'], { stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(out, '1.json'), 'utf8')).items;
}

(async () => {
  // 1. parity with the Python build on every layout that the Python build accepts
  const parity = [
    [path.join(fx, 'header_row3.xlsx'), 3], [path.join(fx, 'english.xlsx'), 3], [path.join(fx, 'mcq.xlsx'), 5],
    [path.join(fx, 'noheader.xlsx'), 3], [path.join(fx, 'multi_sheet.xlsx'), 4],
    [path.join(tmp, 'subjects', 'جغرافيا.xlsx'), 12], [path.join(tmp, 'subjects', 'علوم.xlsx'), 12], [path.join(ROOT, 'tests', 'sample.xlsx'), 25],
  ];
  for (const [file, expected] of parity) {
    const res = importAuto(await readSheets(file));
    const py = pyBuild(file);
    const same = res.items.length === py.length && res.items.every((it, i) => it.q === py[i].q && it.a === py[i].a && it.n === py[i].n);
    check(same && res.items.length === expected, `parity with build_data.py: ${path.basename(file)} (${res.items.length} questions)`,
      `js ${res.items.length} vs py ${py.length} vs expected ${expected}; first diff: ${JSON.stringify(res.items.find((it, i) => !py[i] || it.q !== py[i].q || it.a !== py[i].a || it.n !== py[i].n))} / ${JSON.stringify(py.find((p, i) => !res.items[i] || p.q !== res.items[i].q || p.a !== res.items[i].a))}`);
  }

  // 2. layout-specific expectations
  let r = importAuto(await readSheets(path.join(fx, 'header_row3.xlsx')));
  check(r.sheets[0].info.headerRow === 2 && r.items[0].q === 'ما هي عاصمة اليابان؟' && r.items[0].a === 'طوكيو', 'header on row 3, "رقم السؤال" not mistaken for the question column', JSON.stringify(r.sheets[0].info));
  r = importAuto(await readSheets(path.join(fx, 'english.xlsx')));
  check(r.items.map((i) => i.a).join('|') === '7|3.14|٣٦٦', 'numeric answers (int, float, text) kept as written', r.items.map((i) => i.a).join('|'));
  r = importAuto(await readSheets(path.join(fx, 'mcq.xlsx')));
  check(r.items.map((i) => i.a).join('|') === 'ب) باريس|ج) المشتري|ب) 4|ج) أكسجين|إجابة مكتوبة',
    'multiple choice: letter answers resolve to the option text, other spellings too, free text untouched', r.items.map((i) => i.a).join('|'));
  r = importAuto(await readSheets(path.join(fx, 'noheader.xlsx')));
  check(r.sheets[0].info.status === 'guess' && r.items.length === 3, 'no header row: columns are guessed and flagged for the user to check');
  r = importAuto(await readSheets(path.join(fx, 'multi_sheet.xlsx')));
  check(r.items.length === 4 && r.report.empty === 1, 'two sheets merge into one subject; an empty answer is skipped and counted', `${r.items.length} items, ${r.report.empty} empty`);
  r = importAuto(await readSheets(path.join(fx, 'unknown_cols.xlsx')));
  check(r.sheets[0].info.status === 'invalid' && r.items.length === 0, 'answer column not recognised: sheet is invalid until the user picks a column');
  const manual = I.buildFromSheets([{ rows: r.sheets[0].rows, map: { headerRow: r.sheets[0].info.headerRow, q: 0, a: 1, opts: {} } }]);
  check(manual.items.length === 1 && manual.items[0].a === 'الدوحة', 'a manual column choice imports the sheet');
  check(r.sheets[0].info.labels.join(',') === 'السؤال,ملاحظات', 'column labels offered to the user come from the header row');

  // 3. conflicting duplicates are kept twice, exact duplicates merged, never confirmable
  r = importAuto(await readSheets(path.join(fx, 'conflict.xlsx')));
  check(r.items.length === 3 && r.report.merged === 1 && r.report.conflicts.length === 1, 'conflict: both answers kept, exact duplicate merged, conflict reported', JSON.stringify(r.report.conflicts));
  const idx = M.buildIndex(I.assignIds(r.items, 1001));
  const found = M.search(idx, 'ما هو الكوكب الأقرب للشمس؟', 8, { prefix: false });
  check(M.decide(found).status !== 'confident' && M.hasConflictingTwin(found[0], found), 'a question with two answers is never confident');
  const ok = M.search(idx, 'ما هي عاصمة مصر؟', 8, { prefix: false });
  check(M.decide(ok).status === 'confident', 'a merged exact duplicate stays confident');

  // 4. ids and version
  const items = I.assignIds(importAuto(await readSheets(path.join(fx, 'english.xlsx'))).items, 1002);
  check(items[0].id === 1002 * 100000 + 1 && items[2].id === 1002 * 100000 + 3, 'ids are number*100000+position');
  check(I.hashItems(items) === I.hashItems(items.map((x) => ({ ...x }))) && I.hashItems(items) !== I.hashItems(items.slice(1)), 'content version is stable and changes with the content');

  // 5. CSV: quotes, embedded comma/newline, BOM, semicolon delimiter, Windows-1256
  const csv = '﻿السؤال,الإجابة\r\n"ما هي عاصمة مصر؟",القاهرة\r\n"سؤال, فيه فاصلة","إجابة ""مقتبسة"""\r\n"سطرين\nهنا",ج\r\n';
  let rows = I.parseCsv(csv);
  check(rows.length === 4 && rows[2][0] === 'سؤال, فيه فاصلة' && rows[2][1] === 'إجابة "مقتبسة"' && rows[3][0] === 'سطرين\nهنا', 'CSV: BOM, quotes, comma and newline inside a cell');
  rows = I.parseCsv('السؤال;الإجابة\nما هي عاصمة قطر؟;الدوحة\n');
  check(rows.length === 2 && rows[1][1] === 'الدوحة', 'CSV: semicolon delimiter detected');
  check(I.decodeCsv(new Uint8Array([0xC7, 0xE1, 0xD3, 0xC4, 0xC7, 0xE1]).buffer) === 'السؤال', 'CSV: Windows-1256 (Arabic Excel "CSV") is decoded');
  check(I.decodeCsv(new TextEncoder().encode('السؤال').buffer) === 'السؤال', 'CSV: UTF-8 is decoded');

  // 6. unsupported files fail with a reason the app can explain
  const fail = async (name, size, code) => { try { await I.readFile({ name, size }, readXlsx); return false; } catch (e) { return e.code === code; } };
  check(await fail('q.xls', 10, 'old_format'), '.xls (old format) is rejected with a clear code');
  check(await fail('q.docx', 10, 'unsupported'), 'other file types are rejected');
  check(await fail('big.xlsx', 26 * 1024 * 1024, 'too_big'), 'files over 25 MB are rejected');
  check(await (async () => { try { await I.readFile({ name: 'bad.xlsx', size: 5, arrayBuffer: async () => new ArrayBuffer(5) }, () => readXlsx(new Blob([Buffer.from('not a zip')]))); return false; } catch (e) { return e.code === 'corrupt'; } })(), 'a corrupt .xlsx is reported as corrupt');

  // 7. near duplicates are reported
  const near = I.dedupe([{ q: 'ما هو أطول نهر في العالم؟', a: 'النيل' }, { q: 'ما هو أطول نهر في العالم كله؟', a: 'النيل' }, { q: 'ما هي عاصمة فرنسا؟', a: 'باريس' }], { near: 0.7 });
  check(near.report.near.length === 1 && near.report.near[0].sameAnswer, 'near-duplicate questions are reported');

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
