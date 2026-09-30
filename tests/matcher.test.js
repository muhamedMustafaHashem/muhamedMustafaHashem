// Matcher unit test: noisy variants of real questions must rank the right id first,
// clean ones must pass the confidence rule, and unrelated text must not be "confident".
// Run: node tests/matcher.test.js [path/to/questions.json]
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('../public/matcher.js');

const dataPath = process.argv[2] || path.join(__dirname, 'sample.questions.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const index = M.buildIndex(data.items);
console.log(`dataset: ${data.items.length} questions from ${path.basename(dataPath)}`);

let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const AR = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
const NOISE_LINES = ['أ) القاهرة', 'ب) الإسكندرية', 'ج) أسوان', 'د) طنطا', 'اختر الإجابة الصحيحة', 'الصفحة 12', '١٥ -'];

// OCR-like corruption: drop/replace a character in some words, add options and numbering.
function corrupt(q, level) {
  let words = q.split(/\s+/);
  words = words.map((w) => {
    if (w.length < 4 || rnd() > level) return w;
    const i = Math.floor(rnd() * w.length);
    const op = rnd();
    if (op < 0.4) return w.slice(0, i) + w.slice(i + 1);            // drop
    if (op < 0.8) return w.slice(0, i) + pick(AR) + w.slice(i + 1);  // replace
    return w.slice(0, i) + pick(AR) + w.slice(i);                    // insert
  });
  let text = words.join(' ');
  if (rnd() < 0.7) text = `${Math.floor(rnd() * 90) + 1}- ${text}`;
  if (rnd() < 0.8) text += '\n' + pick(NOISE_LINES) + '\n' + pick(NOISE_LINES);
  return text;
}

let failTop1 = 0, failTop3 = 0, cleanNotConfident = 0, falseConfident = 0;
const N = 50;
const items = data.items;

// 1) clean photos must be confident
for (const it of items) {
  const r = M.decide(M.rank(index, `12) ${it.q}\n${pick(NOISE_LINES)}`));
  if (r.status !== 'confident' || r.best.id !== it.id) {
    cleanNotConfident++;
    console.log(`  clean not confident: #${it.id} ${it.q} -> ${r.status} ${r.best ? r.best.id : ''}`);
  }
}

// 2) noisy variants must keep the right id in the top 3 (and usually top 1)
for (let k = 0; k < N; k++) {
  const it = items[k % items.length];
  const noisy = corrupt(it.q, 0.35);
  const ranked = M.rank(index, noisy);
  const top3 = ranked.slice(0, 3).map((c) => c.id);
  if (!ranked.length || ranked[0].id !== it.id) failTop1++;
  if (!top3.includes(it.id)) {
    failTop3++;
    console.log(`  MISSED top3: #${it.id} "${it.q}"\n    noisy: ${JSON.stringify(noisy)}\n    got: ${JSON.stringify(top3)}`);
  }
  // a wrong answer must never be "confident"
  const r = M.decide(ranked);
  if (r.status === 'confident' && r.best.id !== it.id) {
    falseConfident++;
    console.log(`  FALSE CONFIDENT: #${it.id} -> #${r.best.id}`);
  }
}

// 3) unrelated text must not be confident
const unrelated = ['الجو جميل اليوم في الإسكندرية', 'قائمة الطعام: كشري، فول، طعمية', 'lorem ipsum dolor sit amet'];
for (const t of unrelated) {
  const r = M.decide(M.rank(index, t));
  if (r.status === 'confident') { falseConfident++; console.log(`  FALSE CONFIDENT on unrelated: ${t} -> #${r.best.id}`); }
}

console.log(`clean questions confident: ${items.length - cleanNotConfident}/${items.length}`);
console.log(`noisy variants: top1 ${N - failTop1}/${N}, top3 ${N - failTop3}/${N}`);
console.log(`false confident: ${falseConfident}`);
const ok = cleanNotConfident === 0 && failTop3 === 0 && falseConfident === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
