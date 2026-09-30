// Typed-search and multi-subject tests. Builds the two sample subjects, then checks
// Matcher.search (as-you-type, fragments, reordered words, typos), twin collapsing and the
// cross-subject ambiguity rules. Run: node tests/search.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../public/matcher.js');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subjects-'));
execFileSync('python3', [path.join(__dirname, 'make_sample_subjects.py'), path.join(tmp, 'src')], { stdio: 'ignore' });
execFileSync('python3', [path.join(ROOT, 'tools', 'build_data.py'), '--source', path.join(tmp, 'src'), '--out-dir', path.join(tmp, 'out'),
  '--registry', path.join(tmp, 'reg.json'), '--report', path.join(tmp, 'report.txt')], { stdio: 'ignore' });
const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'manifest.json'), 'utf8'));
const subjects = manifest.subjects.map((s) => JSON.parse(fs.readFileSync(path.join(tmp, 'out', s.file), 'utf8')));
const geo = subjects.find((s) => s.name === 'جغرافيا');
const sci = subjects.find((s) => s.name === 'علوم');
const geoIndex = M.buildIndex(geo.items);
const allItems = subjects.flatMap((s) => s.items.map((i) => ({ ...i, subject: s.name })));
const allIndex = M.buildIndex(allItems);

let fails = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; }
const words = (q) => q.replace(/[؟?]/g, '').split(/\s+/).filter(Boolean);

// 1. full typed questions are top-1 and "confident" in their subject
let fullOk = 0;
for (const it of geo.items) {
  const r = M.search(geoIndex, it.q, 8, { prefix: false });
  const d = M.decide(r);
  if (r[0] && r[0].id === it.id && d.status === 'confident') fullOk++;
  else console.log('   full-question miss:', it.q, '->', d.status, r.slice(0, 2).map((c) => c.q + ' ' + c.score.toFixed(2)));
}
check(fullOk === geo.items.length, `full typed question ranks first and is confident (${fullOk}/${geo.items.length})`);

// 2. as-you-type: first ~70% of the words with the last word cut short must keep the right question in the top 3
let typeTop3 = 0, typeTop1 = 0, typeN = 0;
for (const it of geo.items) {
  const w = words(it.q);
  if (w.length < 4) continue;
  const k = Math.ceil(w.length * 0.7);
  const head = w.slice(0, k);
  const last = head[head.length - 1];
  head[head.length - 1] = last.length > 3 ? last.slice(0, last.length - 2) : last;
  const r = M.search(geoIndex, head.join(' '));
  typeN++;
  if (r.slice(0, 3).some((c) => c.id === it.id)) typeTop3++;
  if (r[0] && r[0].id === it.id) typeTop1++;
}
check(typeTop3 === typeN, `as-you-type prefix keeps the right question in the top 3 (${typeTop3}/${typeN}, top-1 ${typeTop1})`);

// 3. reordered words: same words, reversed order
let revOk = 0, revN = 0;
for (const it of geo.items) {
  const w = words(it.q);
  if (w.length < 4) continue;
  revN++;
  const r = M.search(geoIndex, w.slice().reverse().join(' ') + ' ', 8);
  if (r[0] && r[0].id === it.id) revOk++;
  else console.log('   reversed miss:', it.q, '->', r.slice(0, 2).map((c) => c.q));
}
check(revOk >= revN - 1, `reordered words still find the question first (${revOk}/${revN})`);

// 4. typos in typed words (one changed letter in the longest word)
let typoOk = 0, typoN = 0;
for (const it of geo.items) {
  const w = words(it.q);
  if (w.length < 3) continue;
  const iLong = w.reduce((b, x, i) => (x.length > w[b].length ? i : b), 0);
  if (w[iLong].length < 5) continue;
  typoN++;
  const x = w.slice();
  x[iLong] = x[iLong].slice(0, 2) + 'ط' + x[iLong].slice(3);
  const r = M.search(geoIndex, x.join(' ') + ' ');
  if (r.slice(0, 2).some((c) => c.id === it.id)) typoOk++;
  else console.log('   typo miss:', x.join(' '), '->', r.slice(0, 2).map((c) => c.q));
}
check(typoOk === typoN, `one typo per query keeps the question in the top 2 (${typoOk}/${typoN})`);

// 5. too-short and empty queries return nothing
check(M.search(geoIndex, '').length === 0 && M.search(geoIndex, ' ؟ ').length === 0 && M.search(geoIndex, 'ا').length === 0, 'empty / one-letter queries return nothing');

// 6. highlight marks the words that matched
const hl = M.highlight('ما هو أطول نهر في العالم؟', 'اطول نهر');
check(hl.filter((p) => p.hit).map((p) => p.text).join(' ') === 'أطول نهر', 'highlight marks the matched words only');

// 7. cross-subject: same question, different answers -> two entries, never confident, twin detected
const yearQ = 'كم عدد أيام السنة؟';
const r7 = M.search(allIndex, yearQ, 8, { prefix: false });
const top2 = r7.slice(0, 2);
check(top2.length === 2 && top2[0].n === top2[1].n && top2[0].an !== top2[1].an, 'same question with different answers stays as two entries');
check(M.decide(r7).status !== 'confident', 'ambiguous cross-subject question is never confident');
check(M.hasConflictingTwin(r7[0], r7), 'hasConflictingTwin flags the clash (blocks a green answer)');
check(new Set(top2.map((c) => c.subject)).size === 2, 'both subject names are present on the entries');

// 8. same question AND same answer in two subjects collapses into one entry with `also`
const twinItems = allItems.concat([{ ...geo.items[0], id: 999999, subject: 'علوم' }]);
const twinIndex = M.buildIndex(twinItems);
const r8 = M.search(twinIndex, geo.items[0].q, 8, { prefix: false });
check(r8.filter((c) => c.n === geo.items[0].n).length === 1 && (r8[0].also || []).includes('علوم'), 'identical question+answer in two subjects collapses, listing the other subject');
check(M.decide(r8).status === 'confident', 'collapsed twin is still confident (no false ambiguity)');

// 9. unrelated text is not confident in either mode
check(M.decide(M.search(allIndex, 'قائمة الطعام كشري فول طعمية', 8, { prefix: false })).status !== 'confident', 'unrelated typed text is not confident');

// 10. subject scoping: a geography question is not offered by the science index
const sciIndex = M.buildIndex(sci.items);
const r10 = M.rank(sciIndex, geo.items[7].q, 3);
check(!r10.some((c) => c.q === geo.items[7].q), 'photo matching in subject A never returns subject B questions');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
