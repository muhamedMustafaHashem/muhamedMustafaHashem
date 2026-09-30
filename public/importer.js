/* Importer: turns an Excel/CSV file into a subject's questions, on the phone.
 * Works in the browser (window.Importer) and in Node (module.exports) so tests can compare it with
 * tools/build_data.py. The header detection, multiple-choice handling and normalization mirror that script;
 * tests/importer.test.js checks both give the same questions for the same workbook.
 * Unlike the build script, a question that appears twice with different answers is KEPT (both entries),
 * because the matcher never shows such a question as a confirmed answer; the import report warns about it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./matcher.js'));
  else root.Importer = factory(root.Matcher);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  const ID_STRIDE = 100000; // question id = subject number * ID_STRIDE + position in the subject
  const MAX_QUESTIONS = ID_STRIDE - 1;
  const MAX_BYTES = 25 * 1024 * 1024;

  class ImportError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  // ---- header normalization: like Matcher.normalize but keeps digits (a header "1" stays "1") ----
  const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
  const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
  const LETTERS = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك', 'ی': 'ي' };
  function lightNorm(text) { // digits + letters unified, no punctuation stripping
    return String(text).normalize('NFKC').replace(/[٠-٩۰-۹]/g, (c) => AR_DIGITS[c]).replace(TASHKEEL, '')
      .replace(/[أإآٱةىؤئکی]/g, (c) => LETTERS[c]).toLowerCase();
  }
  function hnorm(text) {
    return lightNorm(text).replace(/[^\p{L}\p{N}\p{M}_\s]/gu, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const Q_WORDS = ['سؤال', 'السؤال', 'أسئلة', 'الأسئلة', 'question', 'questions'].map(hnorm);
  const A_WORDS = ['إجابة', 'الإجابة', 'جواب', 'الجواب', 'الصحيح', 'answer', 'correct answer', 'correct'].map(hnorm);
  const Q_EXACT = /^q\d*$/;
  const A_EXACT = /^(a|ans)$/;
  const OPT_HEADERS = {
    'ا': ['أ', 'ا', 'a', 'option a', 'option 1', 'الاختيار الأول', 'اختيار 1', '1'],
    'ب': ['ب', 'b', 'option b', 'option 2', 'الاختيار الثاني', 'اختيار 2', '2'],
    'ج': ['ج', 'c', 'option c', 'option 3', 'الاختيار الثالث', 'اختيار 3', '3'],
    'د': ['د', 'd', 'option d', 'option 4', 'الاختيار الرابع', 'اختيار 4', '4'],
  };
  const OPT_LOOKUP = {};
  Object.keys(OPT_HEADERS).forEach((k) => OPT_HEADERS[k].forEach((h) => { OPT_LOOKUP[hnorm(h)] = k; }));
  const OPT_DISPLAY = { 'ا': 'أ', 'ب': 'ب', 'ج': 'ج', 'د': 'د' };
  const LETTER_ANSWER = { 'ا': 'ا', 'أ': 'ا', 'a': 'ا', '1': 'ا', 'ب': 'ب', 'b': 'ب', '2': 'ب', 'ج': 'ج', 'c': 'ج', '3': 'ج', 'د': 'د', 'd': 'د', '4': 'د' };

  function cellStr(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v).trim();
  }

  function headerScore(hn, words, exact) {
    if (words.includes(hn) || exact.test(hn)) return 3;
    if (words.some((w) => hn.startsWith(w + ' ') || hn.endsWith(' ' + w))) return 2;
    return words.some((w) => hn.includes(w)) ? 1 : 0;
  }

  /** Detect question / answer / option columns in one row of headers. Returns {q, a, opts} or null. */
  function detectColumns(headerRow) {
    const hns = headerRow.map((h) => (cellStr(h) ? hnorm(cellStr(h)) : ''));
    const pick = (words, exact, exclude) => {
      let best = 0, bestI = null;
      hns.forEach((hn, i) => {
        if (!hn || exclude.has(i)) return;
        const s = headerScore(hn, words, exact);
        if (s > best) { best = s; bestI = i; } // first column wins ties
      });
      return bestI;
    };
    const q = pick(Q_WORDS, Q_EXACT, new Set());
    if (q === null) return null;
    const a = pick(A_WORDS, A_EXACT, new Set([q]));
    const opts = {};
    hns.forEach((hn, i) => { if (i !== q && i !== a && hn && OPT_LOOKUP[hn]) opts[OPT_LOOKUP[hn]] = i; });
    return { q, a, opts };
  }

  /** Look at a sheet's rows and propose a column mapping.
   *  status: 'ok' (headers found), 'guess' (no headers: first two text columns, user should check),
   *  'invalid' (cannot tell which column holds the answers). */
  function analyzeSheet(rows) {
    const width = rows.slice(0, 60).reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
    // header row = the first of the first 10 rows with BOTH a question and an answer column (a title row such
    // as "أسئلة مادة الجغرافيا" has a question word but no answer column); else the first with a question column
    let headerRow = -1, cols = null, partial = null;
    for (let r = 0; r < Math.min(10, rows.length); r++) {
      const found = detectColumns(rows[r] || []);
      if (found && found.a !== null) { headerRow = r; cols = found; break; }
      if (found && !partial) partial = { r, found };
    }
    if (!cols && partial) { headerRow = partial.r; cols = partial.found; }
    let status = 'ok';
    if (!cols) {
      const first = rows[0] || [];
      const text = first.map((v, i) => [v, i]).filter(([v]) => typeof v === 'string' && v.trim()).map(([, i]) => i);
      if (text.length >= 2) { cols = { q: text[0], a: text[1], opts: {} }; status = 'guess'; }
      else cols = { q: null, a: null, opts: {} };
    }
    if (cols.a === null || cols.q === null) status = 'invalid';
    const headerCells = headerRow >= 0 ? rows[headerRow] : [];
    const labels = [];
    for (let i = 0; i < width; i++) {
      const t = cellStr(headerCells[i]);
      labels.push(t || 'عمود ' + (i + 1));
    }
    return { headerRow, q: cols.q, a: cols.a, opts: cols.opts || {}, status, labels, rows: rows.length };
  }

  /** Read the questions of one sheet with a column mapping {headerRow, q, a, opts}. Returns [{q, a}]. */
  function extractItems(rows, map) {
    if (map.q === null || map.a === null || map.q === undefined || map.a === undefined) return [];
    const hasOpts = map.opts && Object.keys(map.opts).length > 0;
    const out = [];
    for (let r = map.headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const q = map.q < row.length ? cellStr(row[map.q]) : '';
      let a = map.a < row.length ? cellStr(row[map.a]) : '';
      if (!q) continue;
      if (hasOpts) {
        // light normalization only: the leading-number rule of normalize() would erase "3"
        const letter = lightNorm(a).replace(/^[ .)\-(]+|[ .)\-(]+$/g, '');
        const key = LETTER_ANSWER[letter];
        if (key && map.opts[key] !== undefined && map.opts[key] < row.length) {
          const optText = cellStr(row[map.opts[key]]);
          if (optText) a = OPT_DISPLAY[key] + ') ' + optText;
        }
      }
      out.push({ q, a });
    }
    return out;
  }

  // ---- quality gate, per subject ----
  function wordBigrams(toks) {
    if (toks.length < 2) return new Set(toks);
    const s = new Set();
    for (let i = 0; i < toks.length - 1; i++) s.add(toks[i] + ' ' + toks[i + 1]);
    return s;
  }
  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach((x) => { if (b.has(x)) inter++; });
    return (2 * inter) / (a.size + b.size);
  }
  function findNear(items, threshold) {
    if (items.length > 20000) return []; // report only; skip on huge subjects
    const inv = new Map(), bigrams = [];
    items.forEach((it, i) => {
      const toks = M.tokens(it.n);
      bigrams.push(wordBigrams(toks));
      new Set(toks).forEach((w) => { let a = inv.get(w); if (!a) inv.set(w, (a = [])); a.push(i); });
    });
    const near = [];
    const seen = new Set();
    items.forEach((it, i) => {
      const cands = new Map();
      new Set(M.tokens(it.n)).forEach((w) => {
        const ids = inv.get(w) || [];
        if (ids.length > 200) return;
        for (const j of ids) if (j > i) cands.set(j, (cands.get(j) || 0) + 1);
      });
      cands.forEach((shared, j) => {
        if (shared < 2) return;
        const key = i * items.length + j;
        if (seen.has(key)) return;
        seen.add(key);
        if (it.n === items[j].n) return; // same question, different answer: already reported as a conflict
        const s = dice(bigrams[i], bigrams[j]);
        if (s >= threshold) near.push({ score: s, q1: it.q, q2: items[j].q, sameAnswer: M.normalize(it.a) === M.normalize(items[j].a) });
      });
    });
    near.sort((x, y) => y.score - x.score);
    return near;
  }

  /** Merge raw [{q, a}] rows into a subject's items [{q, a, n}] and report what was found.
   *  Empty answers are dropped, exact duplicates merged, and a question with two different answers is
   *  kept twice (flagged in report.conflicts) so it can never be shown as a confirmed answer. */
  function dedupe(raw, opts) {
    opts = opts || {};
    const report = { read: raw.length, empty: 0, merged: 0, conflicts: [], near: [] };
    const byNorm = new Map();
    const items = [];
    for (const it of raw) {
      if (!it.a) { report.empty++; continue; }
      const n = M.normalize(it.q);
      if (!n) continue;
      const an = M.normalize(it.a);
      const list = byNorm.get(n);
      if (list) {
        if (list.some((x) => M.normalize(x.a) === an)) { report.merged++; continue; }
        report.conflicts.push({ q: list[0].q, a1: list[0].a, a2: it.a });
        const entry = { q: it.q, a: it.a, n };
        list.push(entry); items.push(entry);
        continue;
      }
      const entry = { q: it.q, a: it.a, n };
      byNorm.set(n, [entry]);
      items.push(entry);
    }
    report.near = findNear(items, opts.near || 0.85);
    return { items, report };
  }

  /** Give the items their permanent ids: number * ID_STRIDE + position (1-based). */
  function assignIds(items, number) {
    if (items.length > MAX_QUESTIONS) throw new ImportError('too_many', 'too many questions');
    return items.map((it, i) => ({ id: number * ID_STRIDE + i + 1, q: it.q, a: it.a, n: it.n }));
  }

  /** Short content hash (FNV-1a) used as the subject's version. */
  function hashItems(items) {
    let h = 0x811c9dc5;
    for (const it of items) {
      const s = it.q + '\u0001' + it.a + '\u0002';
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    }
    return h.toString(16).padStart(8, '0');
  }

  // ---- CSV ----
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const count = (ch) => firstLine.split(ch).length - 1;
    const delim = [',', ';', '\t'].map((d) => [d, count(d)]).sort((x, y) => y[1] - x[1])[0][0];
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((v) => (v === '' ? null : v))).filter((r) => r.some((v) => v !== null));
  }
  function decodeCsv(buffer) { // UTF-8, or Windows-1256 (what Arabic Excel writes for "CSV")
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return new TextDecoder('windows-1256').decode(buffer); }
  }

  /** Read a File/Blob into sheets [{name, rows}]. readXlsx is the read-excel-file function. */
  async function readFile(file, readXlsx) {
    const name = file.name || 'file';
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    const stem = name.replace(/\.[^.]+$/, '');
    if (file.size > MAX_BYTES) throw new ImportError('too_big');
    if (ext === 'xlsx' || ext === 'xlsm') {
      if (!readXlsx) throw new ImportError('no_reader');
      let sheets;
      try { sheets = await readXlsx(file); } catch (e) { throw new ImportError('corrupt', e && e.message); }
      return { stem, sheets: sheets.map((s) => ({ name: s.sheet, rows: s.data })) };
    }
    if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
      const buf = await file.arrayBuffer();
      return { stem, sheets: [{ name: 'CSV', rows: parseCsv(decodeCsv(buf)) }] };
    }
    if (ext === 'xls' || ext === 'ods' || ext === 'numbers') throw new ImportError('old_format');
    throw new ImportError('unsupported');
  }

  /** Full pipeline for the sheets of one file with (possibly user-corrected) mappings.
   *  sheets: [{name, rows, map}] where map = {headerRow, q, a, opts} or null to skip the sheet. */
  function buildFromSheets(sheets, opts) {
    const raw = [];
    for (const s of sheets) if (s.map) raw.push(...extractItems(s.rows, s.map));
    return dedupe(raw, opts);
  }

  return { ImportError, ID_STRIDE, MAX_QUESTIONS, hnorm, detectColumns, analyzeSheet, extractItems, dedupe, assignIds,
    hashItems, parseCsv, decodeCsv, readFile, buildFromSheets };
});
