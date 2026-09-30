/* Matcher: Arabic normalization, candidate shortlist, scoring and the confidence rule.
 * Works in the browser (window.Matcher) and in Node (module.exports) so tests share it.
 * normalize() MUST stay identical to normalize() in tools/build_data.py. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Matcher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
  const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
  const LETTER_MAP = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ؤ': 'و', 'ئ': 'ي', 'ک': 'ك', 'ی': 'ي' };
  // Python's \w (unicode) ~ letters, digits, underscore. \p{L}\p{N}\p{M}_ is the closest JS equivalent.
  const NON_WORD = /[^\p{L}\p{N}\p{M}_\s]/gu;
  const LEADING_NUMBER = /^\s*(?:س|q|question)?\s*\d{1,4}\s*[-.)/:]*\s*/i;

  function normalize(text) {
    if (text == null) return '';
    let t = String(text).normalize('NFKC');
    t = t.replace(/[٠-٩۰-۹]/g, (c) => ARABIC_DIGITS[c]);
    t = t.replace(TASHKEEL, '');
    t = t.replace(/[أإآٱةىؤئکی]/g, (c) => LETTER_MAP[c]);
    t = t.toLowerCase();
    t = t.replace(LEADING_NUMBER, '');
    t = t.replace(NON_WORD, ' ');
    t = t.replace(/_/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function tokens(norm) {
    return norm ? norm.split(' ').filter(Boolean) : [];
  }

  // Levenshtein distance with early exit once it exceeds `max`.
  function editDistance(a, b, max) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      let rowMin = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      [prev, cur] = [cur, prev];
    }
    return prev[lb];
  }

  function allowedEdits(len) {
    if (len <= 3) return 0;
    if (len <= 6) return 1;
    return 2;
  }

  /** Build an index over items [{id,q,a,n}]. */
  function buildIndex(items) {
    const inv = new Map();
    const docs = items.map((it) => {
      const toks = tokens(it.n || normalize(it.q));
      return { id: it.id, q: it.q, a: it.a, toks };
    });
    docs.forEach((d, di) => {
      new Set(d.toks).forEach((w) => {
        let arr = inv.get(w);
        if (!arr) inv.set(w, (arr = []));
        arr.push(di);
      });
    });
    // words present in > 20% of questions are too common to shortlist by
    const commonCut = Math.max(20, Math.floor(docs.length * 0.2));
    const common = new Set();
    inv.forEach((arr, w) => { if (arr.length > commonCut) common.add(w); });
    return { docs, inv, common, byId: new Map(docs.map((d) => [d.id, d])) };
  }

  /** Score one question against the OCR token list.
   *  score = 0.5 * unigram coverage + 0.5 * ordered-bigram coverage, with fuzzy token equality. */
  function scoreDoc(doc, ocrToks, ocrSet) {
    const n = doc.toks.length;
    if (n === 0) return 0;
    // position of each matched question token in the OCR token list (-1 if absent)
    const pos = new Array(n);
    for (let i = 0; i < n; i++) {
      const w = doc.toks[i];
      let p = ocrSet.get(w);
      if (p === undefined) {
        p = -1;
        const maxE = allowedEdits(w.length);
        if (maxE > 0) {
          for (let k = 0; k < ocrToks.length; k++) {
            const o = ocrToks[k];
            if (Math.abs(o.length - w.length) <= maxE && editDistance(w, o, maxE) <= maxE) { p = k; break; }
          }
        }
        // OCR often glues two Arabic words together: accept a question word found inside a longer OCR token
        if (p < 0 && w.length >= 2) {
          for (let k = 0; k < ocrToks.length; k++) {
            const o = ocrToks[k];
            if (o.length <= w.length) continue;
            // 2-letter words (في, ما, هو...) only at the edges of the glued token to limit false hits
            if (w.length >= 3 ? o.includes(w) : (o.startsWith(w) || o.endsWith(w))) { p = k; break; }
          }
        }
      }
      pos[i] = p;
    }
    let uni = 0;
    for (let i = 0; i < n; i++) if (pos[i] >= 0) uni++;
    const uniCov = uni / n;
    if (n === 1) return uniCov;
    let bi = 0;
    for (let i = 0; i < n - 1; i++) {
      if (pos[i] >= 0 && pos[i + 1] >= 0 && pos[i + 1] - pos[i] >= 0 && pos[i + 1] - pos[i] <= 2) bi++; // 0 = both inside one glued token
    }
    const biCov = bi / (n - 1);
    return 0.5 * uniCov + 0.5 * biCov;
  }

  /** Return ranked candidates [{id,q,a,score}] for an OCR text. */
  function rank(index, ocrText, limit) {
    limit = limit || 10;
    const ocrToks = tokens(normalize(ocrText));
    if (ocrToks.length === 0) return [];
    const ocrSet = new Map();
    ocrToks.forEach((w, i) => { if (!ocrSet.has(w)) ocrSet.set(w, i); });

    // shortlist: docs sharing >= 2 exact non-common tokens (>= 1 if the doc is very short)
    const hits = new Map();
    ocrSet.forEach((_, w) => {
      if (index.common.has(w)) return;
      const arr = index.inv.get(w);
      if (arr) for (const di of arr) hits.set(di, (hits.get(di) || 0) + 1);
    });
    let shortlist = [];
    hits.forEach((c, di) => {
      const d = index.docs[di];
      if (c >= 2 || d.toks.length <= 3) shortlist.push(d);
    });
    // fallback: nothing shared exactly (heavy OCR noise) -> score everything
    if (shortlist.length === 0) shortlist = index.docs;

    const scored = shortlist.map((d) => ({ id: d.id, q: d.q, a: d.a, score: scoreDoc(d, ocrToks, ocrSet) }));
    scored.sort((x, y) => y.score - x.score || x.id - y.id);
    return scored.slice(0, limit);
  }

  // confident = top >= score AND no other candidate >= score AND top - second >= lead
  const DEFAULT_THRESHOLDS = { score: 0.92, lead: 0.10, min: 0.30 };

  /** Apply the confidence rule. Returns {status:'confident'|'candidates'|'none', best, candidates}. */
  function decide(candidates, th) {
    th = Object.assign({}, DEFAULT_THRESHOLDS, th || {});
    if (!candidates.length || candidates[0].score < th.min) return { status: 'none', best: null, candidates: [] };
    const top = candidates[0];
    const second = candidates[1] ? candidates[1].score : 0;
    if (top.score >= th.score && second < th.score && top.score - second >= th.lead) {
      return { status: 'confident', best: top, candidates };
    }
    return { status: 'candidates', best: null, candidates: candidates.slice(0, 3) };
  }

  /** Split OCR text that contains several numbered questions. Returns [text] when it doesn't. */
  function splitQuestions(ocrText) {
    const parts = String(ocrText || '').split(/(?:^|\n)\s*(?:س|q)?\s*[0-9٠-٩]{1,3}\s*[-.)\/:]\s*/iu)
      .map((s) => s.trim()).filter((s) => tokens(normalize(s)).length >= 3);
    return parts.length >= 2 ? parts : [String(ocrText || '')];
  }

  return { normalize, tokens, editDistance, buildIndex, rank, decide, splitQuestions, DEFAULT_THRESHOLDS };
});
