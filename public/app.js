/* Photo -> answer app. Flow: capture -> downscale -> OCR tiers race -> match -> (verify) -> render. */
(function () {
  'use strict';
  const C = window.APP_CONFIG;
  const M = window.Matcher;
  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'answer-app';

  // ---------- settings ----------
  const settings = Object.assign({ mode: 'auto', autoRun: true, debug: false, installHintSeen: false, subject: '' }, load());
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { return {}; } }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ } }

  const MODE_HINTS = {
    auto: 'القراءة المحلية وجوجل تعملان معاً، ويُعرض أسرع نتيجة مؤكدة.',
    local: 'القراءة على الهاتف فقط، تعمل بدون إنترنت، أبطأ في الصور الصعبة.',
    google: 'القراءة عبر جوجل فقط، أدق وأسرع لكنها تحتاج إنترنت.',
  };
  // Photo-check mode, set on the server (VERIFY_MODE in wrangler.toml): 'gemini' = a model confirms the
  // question from the photo before a green answer; 'off' = green only when the phone's reader and the
  // cloud reader independently agree on the same question. Read from /api/health at start, remembered
  // for offline starts.
  let verifyMode = settings.verifyMode || 'gemini';
  const verifierOn = () => verifyMode !== 'off';
  let modeReady = Promise.resolve(); // resolves when /api/health has answered (or failed)
  async function loadVerifyMode() {
    try {
      const res = await fetch(apiUrl('health'), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j.verify === 'off' || j.verify === 'gemini') { verifyMode = j.verify; settings.verifyMode = j.verify; save(); }
    } catch { /* offline: keep the remembered mode */ }
    document.body.dataset.verify = verifyMode;
    $('#mode-hint').textContent = modeHint(settings.mode);
  }
  function modeHint(mode) {
    if (!verifierOn()) return MODE_HINTS[mode] + ' التحقق بالصورة مطفأ: الإجابة الخضراء تحتاج اتفاق القراءة المحلية وجوجل معاً، لذا تعمل القراءتان دائماً.';
    return MODE_HINTS[mode];
  }
  function setMode(mode) {
    settings.mode = mode; save();
    document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('#mode-hint').textContent = modeHint(mode);
    if (mode !== 'google' || !verifierOn()) warmLocalOcr();
  }
  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- subjects: uploaded by the user (kept on this phone) and, optionally, built into the app ----------
  // Each subject is one Excel file. Only the selected subject is indexed for matching.
  let manifest = { subjects: [] };   // [{number, name, count, version, source: 'user' | 'bundled', file?}]
  let bundledVersion = '';
  let storeOk = true;
  const subjectCache = new Map();    // "number:version" -> {number, name, items}
  let index = null;                  // matcher index of the current selection
  const subjectByNumber = (n) => manifest.subjects.find((s) => String(s.number) === String(n));
  const multiSubject = () => manifest.subjects.length > 1;
  const cacheKey = (s) => `${s.number}:${s.version}`;

  // Subjects built into the app by tools/build_data.py are optional: no data/manifest.json means none.
  async function loadBundled() {
    try {
      const res = await fetch('data/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return [];
      const m = await res.json();
      bundledVersion = m.version || '';
      return m.subjects.map((s) => ({ ...s, source: 'bundled' }));
    } catch { return []; }
  }
  async function loadUploaded() {
    try { const list = await Store.list(); storeOk = true; return list.map((s) => ({ ...s, source: 'user' })); }
    catch (e) { console.warn('store', e); storeOk = false; return []; }
  }
  async function reloadLibrary() {
    const [bundled, mine] = await Promise.all([loadBundled(), loadUploaded()]);
    manifest = { subjects: [...bundled, ...mine] };
  }
  async function loadSubject(s) {
    const key = cacheKey(s);
    if (subjectCache.has(key)) return subjectCache.get(key);
    let doc;
    if (s.source === 'user') {
      doc = await Store.get(s.number);
    } else {
      const res = await fetch(`data/${s.file}?v=${s.version}`);
      if (!res.ok) throw new Error(`${s.file} ${res.status}`);
      doc = await res.json();
    }
    if (!doc) throw new Error('subject missing ' + s.number);
    subjectCache.set(key, doc);
    return doc;
  }
  // Build the index for the current choice: one subject, or all subjects merged ("كل المواد").
  async function applySelection() {
    const all = settings.subject === 'all';
    const list = all ? manifest.subjects : [subjectByNumber(settings.subject)].filter(Boolean);
    const docs = await Promise.all(list.map(loadSubject));
    const items = docs.flatMap((d) => (all ? d.items.map((i) => ({ ...i, subject: d.name })) : d.items));
    index = M.buildIndex(items);
    window.__items = items; // used by tests/golden_run.js
    $('#about').textContent = `${items.length} سؤال في ${docs.length} مادة${bundledVersion ? '، إصدار ' + bundledVersion : ''}`;
    return items.length;
  }
  function renderPicker() {
    const sel = $('#subject');
    sel.innerHTML = '<option value="" disabled>اختر المادة…</option>' +
      manifest.subjects.map((s) => `<option value="${s.number}">${esc(s.name)} (${s.count})</option>`).join('') +
      (manifest.subjects.length > 1 ? '<option value="all">كل المواد</option>' : '');
  }
  // After the list of subjects changed (first load, upload, rename, delete): show the right cards and
  // keep the selection valid. The caller re-applies the selection.
  function refreshLibraryUI() {
    const n = manifest.subjects.length;
    document.body.dataset.empty = n ? '' : '1';
    $('#empty-card').hidden = n > 0;
    $('#subject-card').hidden = n === 0;
    renderPicker();
    if (n === 1) settings.subject = String(manifest.subjects[0].number);
    if (settings.subject === 'all' && n < 2) settings.subject = '';
    if (settings.subject !== 'all' && !subjectByNumber(settings.subject)) settings.subject = '';
    save();
    syncPicker();
  }
  function syncPicker() {
    $('#subject').value = settings.subject || '';
    document.body.dataset.needSubject = settings.subject ? '' : '1';
    $('#subject-hint').textContent = settings.subject ? '' : 'اختر المادة أولاً: البحث داخل مادة واحدة أدق وأسرع.';
  }
  async function setSubject(value) {
    settings.subject = String(value); save();
    syncPicker();
    setStatus('جارٍ تحميل الأسئلة…');
    try { await applySelection(); setStatus(''); } catch (e) { console.warn(e); setStatus('تعذر تحميل الأسئلة، تحقق من الاتصال'); }
    runSearch();
  }
  $('#subject').addEventListener('change', (e) => setSubject(e.target.value));
  // Idle prefetch of the other subjects so switching works offline later.
  function prefetchOthers() { // only built-in subjects come over the network; uploaded ones are already local
    const go = () => manifest.subjects.forEach((s) => { if (s.source === 'bundled' && !subjectCache.has(cacheKey(s))) loadSubject(s).catch(() => {}); });
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(go);
  }
  let ready = null; // resolves when the subjects and the current selection are loaded
  async function bootData() {
    await reloadLibrary();
    const want = new URLSearchParams(location.search).get('subject'); // deep link (built-in subjects): ?subject=2 or ?subject=all
    if (want && (want === 'all' || subjectByNumber(want))) settings.subject = want;
    refreshLibraryUI();
    if (settings.subject) { await applySelection(); setStatus(''); }
    prefetchOthers();
  }
  // Reload the list after a change, keep a valid selection and rebuild the index.
  async function reloadAndReapply() {
    await reloadLibrary();
    refreshLibraryUI();
    index = null; window.__items = [];
    if (settings.subject) { try { await applySelection(); } catch (e) { console.warn(e); } }
    runSearch();
  }
  async function ensureIndex() {
    try { await ready; } catch { setStatus('تعذر تحميل الأسئلة، تحقق من الاتصال'); return false; }
    if (!settings.subject) { $('#subject').focus(); return false; }
    if (!index) { try { await applySelection(); } catch { setStatus('تعذر تحميل الأسئلة، تحقق من الاتصال'); return false; } }
    return true;
  }

  // ---------- local OCR (Tesseract.js) ----------
  let tessPromise = null;
  function warmLocalOcr() {
    if (tessPromise || typeof Tesseract === 'undefined') return tessPromise;
    setStatus('جارٍ تجهيز القراءة المحلية…');
    const t = C.tesseract;
    tessPromise = Tesseract.createWorker(t.lang, Tesseract.OEM.LSTM_ONLY, {
      workerPath: t.workerPath, corePath: t.corePath, langPath: t.langPath,
      gzip: false, legacyCore: false, legacyLang: false,
    }).then(async (w) => {
      await w.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: String(C.tesseract.psm || 3) });
      setStatus('');
      return w;
    }).catch((err) => { tessPromise = null; setStatus('تعذر تجهيز القراءة المحلية'); throw err; });
    return tessPromise;
  }
  // Tesseract reads best when text is 20-40 px tall, so local OCR runs on a smaller copy of the
  // photo (cloud OCR gets the full 1600 px). If the first pass finds almost nothing, retry smaller.
  // No single size reads every line (very large or very small glyphs both fail), so try several sizes,
  // keep the read that matches the question bank best, and stop as soon as one is confident.
  async function localOcr(blob) {
    const worker = await warmLocalOcr();
    const sides = C.tesseract.sides || [1000, 800, 700, 1300];
    let best = { text: '', score: -1 };
    for (const side of sides) {
      const small = await resizeBlob(blob, side);
      const { data } = await worker.recognize(small);
      const text = data.text || '';
      const ranked = index ? M.rank(index, text, 2) : [];
      const score = ranked.length ? ranked[0].score : 0;
      if (score > best.score) best = { text, score };
      if (index && M.decide(ranked, C.thresholds).status === 'confident') break;
    }
    return best.text;
  }
  async function resizeBlob(blob, maxSide) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1) { if (bmp.close) bmp.close(); return blob; }
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    if (bmp.close) bmp.close();
    return new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.9));
  }

  // ---------- cloud calls ----------
  function apiUrl(path) { return (C.apiBase || '') + '/api/' + path; }
  async function cloudOcr(blob, signal) {
    const fd = new FormData();
    fd.append('image', blob, 'q.jpg');
    const res = await fetch(apiUrl('ocr'), { method: 'POST', body: fd, signal, headers: { 'x-app-token': C.appToken } });
    if (!res.ok) throw new Error('ocr ' + res.status);
    const j = await res.json();
    return j.text || '';
  }
  async function verify(blob, candidates, ocrText, signal) {
    const fd = new FormData();
    fd.append('image', await resizeBlob(blob, C.verifyImageSide || 1280), 'q.jpg');
    fd.append('candidates', JSON.stringify(candidates.map((c) => ({ id: c.id, q: c.q }))));
    fd.append('ocr', ocrText || '');
    const res = await fetch(apiUrl('verify'), { method: 'POST', body: fd, signal, headers: { 'x-app-token': C.appToken } });
    if (!res.ok) throw new Error('verify ' + res.status);
    return res.json();
  }
  function withTimeout(ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return { signal: ctrl.signal, cancel: () => clearTimeout(t), abort: () => { clearTimeout(t); ctrl.abort(); } };
  }

  // ---------- image handling ----------
  let fullCanvas = null;   // downscaled, orientation-fixed photo
  let currentBlob = null;  // blob currently being analysed (full or crop)
  async function fileToCanvas(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { bmp = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = URL.createObjectURL(file); }); }
    const w = bmp.width, h = bmp.height;
    const scale = Math.min(1, C.maxImageSide / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    if (bmp.close) bmp.close();
    return cv;
  }
  function canvasToBlob(cv) { return new Promise((ok) => cv.toBlob(ok, 'image/jpeg', C.jpegQuality)); }
  function cropCanvas(cv, r) {
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(r.w)); out.height = Math.max(1, Math.round(r.h));
    out.getContext('2d').drawImage(cv, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return out;
  }

  // ---------- UI helpers ----------
  function setStatus(t) { $('#status-line').textContent = t; }
  function show(view) { $('#view-home').hidden = view !== 'home'; $('#view-work').hidden = view !== 'work'; }
  function chip(tier, state) { const el = document.querySelector(`.chip[data-tier="${tier}"]`); if (el) el.dataset.state = state; }
  let timer = null, t0 = 0;
  function startTimer() { t0 = performance.now(); clearInterval(timer); timer = setInterval(() => { $('#elapsed').textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' ث'; }, 100); }
  function stopTimer() { clearInterval(timer); $('#elapsed').textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' ث'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  const TIER_NAME = { A: 'قراءة محلية', B: 'قراءة جوجل', C: 'تحقق ذكي' };

  // Subject label shown when several subjects are searched together, plus the other subjects
  // that contain the identical question and answer.
  function subjectTag(c) {
    // diagnostic mode also shows the question's position in its subject (the "#seq" used in golden labels)
    const seq = settings.debug ? `<span class="subj idtag">#${c.id % 100000}</span>` : '';
    if (!c.subject) return seq;
    const also = c.also && c.also.length ? ` · أيضاً في: ${c.also.map(esc).join('، ')}` : '';
    return `<span class="subj">${esc(c.subject)}${also}</span>${seq}`;
  }
  function renderConfident(best, via, debugText) {
    $('#result').innerHTML = `
      <article class="answer confident">
        <span class="badge ok">✓ مؤكد · ${esc(via)}</span> ${subjectTag(best)}
        <p class="q">${esc(best.q)}</p>
        <p class="a">${esc(best.a)}</p>
      </article>` + debugBlock(debugText);
  }
  // Buttons under a result that is not green: widen the search to every subject (only when the
  // user picked one subject) and open the typed search pre-filled with the text the OCR read.
  function extraActions(canEdit) {
    const canAll = settings.subject !== 'all' && multiSubject();
    if (!canAll && !canEdit) return '';
    return `<div class="actions">${canAll ? '<button class="secondary" data-act="all">🔎 ابحث في كل المواد</button>' : ''}${canEdit ? '<button class="secondary" data-act="edit">✎ عدّل النص وابحث</button>' : ''}</div>`;
  }
  // Verification could not run (offline / API down): show the most likely question with its answer
  // visible but clearly marked unverified, plus the runners-up to tap.
  function renderLikely(cands, note, debugText) {
    const [top, ...rest] = cands;
    const cards = rest.map(candCard).join('');
    $('#result').innerHTML = `
      <article class="answer unverified">
        <span class="badge warn">الأرجح · غير مؤكد</span> ${subjectTag(top)}
        <p class="q">${esc(top.q)} <span class="score">${Math.round(top.score * 100)}%</span></p>
        <p class="a">${esc(top.a)}</p>
        <p class="src">${esc(note)}</p>
      </article>${cards}${extraActions(true)}${debugBlock(debugText)}`;
    bindCards();
  }
  // Verifier rejected or unsure: answers stay hidden until the user taps the matching question.
  function renderCandidates(cands, debugText, note) {
    $('#result').innerHTML = `<div class="answer unverified"><span class="badge warn">غير مؤكد</span>
      <p class="q">${esc(note || 'لم أتأكد من السؤال. اضغط على السؤال المطابق لعرض إجابته، أو قص السؤال وأعد المحاولة.')}</p></div>${cands.map(candCard).join('')}${extraActions(true)}${debugBlock(debugText)}`;
    bindCards();
  }
  function candCard(c) {
    return `<article class="cand" data-id="${c.id}">
        <p class="q">${esc(c.q)} <span class="score">${Math.round(c.score * 100)}%</span> ${subjectTag(c)}</p>
        <p class="a">${esc(c.a)}</p>
      </article>`;
  }
  function bindCards() { document.querySelectorAll('.cand').forEach((el) => { el.onclick = () => el.classList.toggle('open'); }); }
  function renderNotice(text, isError, debugText, withActions) {
    $('#result').innerHTML = `<p class="notice${isError ? ' error' : ''}">${esc(text)}</p>${withActions ? extraActions(!!(debugText && debugText.trim())) : ''}${debugBlock(debugText)}`;
  }
  function debugBlock(t) { return settings.debug && t ? `<pre class="debug">${esc(t)}</pre>` : ''; }

  // The action buttons are rendered as HTML, so one delegated handler serves every result.
  $('#result').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'all') searchAllSubjects();
    if (b.dataset.act === 'edit') editTextAndSearch();
  });
  let lastRun = null; // {blob, texts: {A, B}} of the latest photo, reused when widening to all subjects
  async function searchAllSubjects() {
    await setSubject('all');
    if (lastRun && !$('#view-work').hidden) startRun(lastRun.blob, { reuse: lastRun.texts });
  }
  function editTextAndSearch() {
    const t = (lastRun && (lastRun.texts.B || lastRun.texts.A) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (run) run.cancel();
    show('home');
    const input = $('#q-input');
    input.value = t;
    runSearch(true);
    input.focus();
    input.scrollIntoView({ block: 'center' });
  }

  // ---------- matching ----------
  function analyse(text) {
    const ranked = M.rank(index, text, 10);
    const decision = M.decide(ranked, C.thresholds);
    const multi = M.splitQuestions(text).length > 1;
    return { ranked, decision, multi };
  }

  // ---------- pipeline (accuracy first) ----------
  // OCR tiers only produce the candidate list. A green "مؤكد" answer requires the verifier to look at
  // the photo and pick a candidate with high confidence, that candidate to be in the OCR top 3, and the
  // verifier's own transcription of the photo to match that same question.
  let run = null; // current run context
  // opts.reuse = {A?, B?}: OCR text already read for this photo (used when widening to all subjects);
  // the OCR engines are skipped and the same text is ranked against the new index, then verified again.
  async function startRun(blob, opts) {
    opts = opts || {};
    // a photo taken in the first moments waits (briefly) for the server to say whether the photo check is on
    await Promise.race([modeReady, new Promise((ok) => setTimeout(ok, 1500))]);
    if (run) run.cancel();
    const mode = settings.mode;
    const online = navigator.onLine;
    const ctx = { done: false, aborters: [], results: {}, verifyStarted: false, cancel() { this.done = true; this.aborters.forEach((a) => a.abort()); } };
    run = ctx;
    currentBlob = blob;
    if (!opts.reuse) lastRun = { blob, texts: {} };
    $('#view-work').dataset.done = '';
    $('#result').innerHTML = '';
    ['A', 'B', 'C'].forEach((t) => chip(t, 'idle'));
    startTimer();

    const reuse = opts.reuse || null;
    const noVerifier = !verifierOn();
    // without the photo check, a green answer needs both readers, so the local one always runs
    const useA = !reuse && (mode !== 'google' || noVerifier);
    const useB = !reuse && mode !== 'local' && online;
    chip('A', useA ? 'running' : 'skip');
    chip('B', useB ? 'running' : (online ? 'skip' : 'fail'));
    chip('C', online && !noVerifier ? 'idle' : 'skip');
    const markDone = () => { $('#view-work').dataset.done = '1'; };
    if (!reuse && !useA && !useB) { stopTimer(); renderNotice('لا يوجد اتصال بالإنترنت. اختر وضع "محلي" للقراءة بدون إنترنت.', true); markDone(); return; }

    const pending = { A: useA || (!!reuse && reuse.A != null), B: useB || (!!reuse && reuse.B != null) };
    const finish = (fn) => { if (ctx.done) return; ctx.cancel(); stopTimer(); fn(); markDone(); };

    function onOcr(tier, text) {
      if (ctx.done) return;
      pending[tier] = false;
      if (lastRun) lastRun.texts[tier] = text;
      const r = analyse(text);
      ctx.results[tier] = { text, r };
      chip(tier, r.decision.status === 'confident' ? 'done' : r.decision.status === 'none' ? 'fail' : 'partial');
      // Two independent OCR engines confident on the same question: the green rule when the photo check is
      // off (VERIFY_MODE = "off"), or an optional fast path (fastPath in config.js) when it is on.
      if ((noVerifier || C.fastPath) && ctx.results.A && ctx.results.B) {
        const a = ctx.results.A.r.decision, b = ctx.results.B.r.decision;
        if (a.status === 'confident' && b.status === 'confident' && a.best.id === b.best.id && !M.hasConflictingTwin(a.best, ctx.results.B.r.ranked)) {
          return finish(() => renderConfident(a.best, 'قراءتان متطابقتان', text));
        }
      }
      // Start verification as soon as the candidate list is trustworthy: a confident OCR read,
      // Google's read (better than local), or the last read we are going to get.
      if (r.decision.status === 'confident' || tier === 'B' || !pending.B) maybeVerify();
    }
    function onOcrFail(tier, err) {
      if (ctx.done) return;
      pending[tier] = false;
      chip(tier, 'fail');
      console.warn(tier, err);
      if (!pending.A && !pending.B) maybeVerify();
    }
    // Union of both OCR rankings (Google first), so a word one engine misread does not drop the right question.
    function merged() {
      const order = [ctx.results.B, ctx.results.A].filter(Boolean);
      const best = new Map(); // keep each question's best score over both readers: a weak read must not hide a strong one
      for (const res of order) for (const c of res.r.ranked) { const cur = best.get(c.id); if (!cur || c.score > cur.score) best.set(c.id, c); }
      const list = [...best.values()];
      list.sort((x, y) => y.score - x.score);
      const primary = order[0];
      return { list: list.slice(0, 10), text: primary ? primary.text : '', multi: order.some((o) => o.r.multi) };
    }
    async function maybeVerify() {
      if (ctx.done || ctx.verifyStarted) return;
      const m = merged();
      const stillWaiting = pending.A || pending.B;
      if (!m.list.length || m.list[0].score < C.thresholds.min) {
        if (stillWaiting) return; // the other engine may still read it
        return finish(() => m.text.trim()
          ? renderNotice(settings.subject === 'all' ? 'لم أجد السؤال، حاول تصوير السؤال أقرب وبوضوح.' : 'لم أجد السؤال في هذه المادة. جرّب كل المواد أو صوّر السؤال أقرب.', false, m.text, true)
          : renderNotice('تعذرت قراءة الصورة. حاول التصوير في إضاءة أفضل.', true, '', true));
      }
      if (m.multi) return finish(() => renderCandidates(m.list.slice(0, 3), m.text, 'الصورة تحتوي على أكثر من سؤال. قص السؤال المطلوب وأعد المحاولة، أو اضغط على السؤال المطابق.'));
      if (noVerifier) {
        if (stillWaiting) return; // the agreement rule needs both readers
        const conf = ['A', 'B'].filter((t) => ctx.results[t] && ctx.results[t].r.decision.status === 'confident');
        return finish(() => conf.length
          ? renderLikely(m.list.slice(0, 3), conf.length === 2 ? 'القراءتان لم تتفقا على نفس السؤال. تأكد بنفسك أن السؤال مطابق.' : 'قراءة واحدة فقط واثقة، والتحقق بالصورة مطفأ. تأكد بنفسك أن السؤال مطابق.', m.text)
          : renderCandidates(m.list.slice(0, 3), m.text));
      }
      if (!online) return finish(() => renderLikely(m.list.slice(0, 3), 'لا يوجد إنترنت للتحقق من الصورة. تأكد بنفسك أن السؤال مطابق.', m.text));
      ctx.verifyStarted = true;
      chip('C', 'running');
      const t = withTimeout(C.verifyTimeoutMs); ctx.aborters.push(t);
      try {
        const v = await verify(blob, m.list, m.text, t.signal);
        t.cancel();
        if (ctx.done) return;
        const hit = m.list.find((c) => c.id === v.match_id);
        const inTop3 = hit && m.list.slice(0, 3).some((c) => c.id === hit.id);
        // cross-check: the verifier's own transcription of the photo must match the chosen question
        let transcriptionOk = !C.verify.requireTranscription;
        if (hit && v.photo_question) {
          const tr = M.rank(index, v.photo_question, 3);
          transcriptionOk = !!tr.length && tr[0].id === hit.id && tr[0].score >= C.verify.transcriptionMinScore;
        }
        const debug = m.text + (v.photo_question ? '\n--- verifier read ---\n' + v.photo_question : '') + (v.reason ? '\n--- ' + v.reason : '') +
          (v.usage ? `\n--- ${v.model || ''} tokens in ${v.usage.input_tokens} out ${v.usage.output_tokens}${v.cost_usd != null ? ' ≈ $' + v.cost_usd : ''}` : '');
        // the same question with a different answer in another subject can never be green
        const clash = hit && M.hasConflictingTwin(hit, m.list);
        if (hit && v.confidence === 'high' && inTop3 && transcriptionOk && !clash) {
          chip('C', 'done');
          finish(() => renderConfident(hit, 'تم التحقق من الصورة', debug));
        } else {
          chip('C', 'fail');
          finish(() => renderCandidates(m.list.slice(0, 3), debug, clash
            ? 'هذا السؤال موجود أكثر من مرة بإجابات مختلفة (في مادتين أو أكثر، أو مكرر في ملفك). اختر الإجابة الصحيحة بنفسك:'
            : hit
              ? 'التحقق لم يؤكد التطابق. اضغط على السؤال المطابق لعرض إجابته، أو قص السؤال وأعد المحاولة.'
              : settings.subject !== 'all' && multiSubject()
                ? 'الصورة لا تطابق أسئلة هذه المادة على الأرجح. جرّب "ابحث في كل المواد"، أو اضغط على أقرب سؤال:'
                : undefined));
        }
      } catch (err) {
        if (ctx.done) return;
        chip('C', 'fail');
        console.warn('verify', err);
        finish(() => renderLikely(m.list.slice(0, 3), 'تعذر التحقق عبر الإنترنت. تأكد بنفسك أن السؤال مطابق.', m.text));
      }
    }

    if (reuse) {
      // text already read: rank it against the new index, then verify against the photo again
      if (reuse.A != null) onOcr('A', reuse.A);
      if (reuse.B != null) onOcr('B', reuse.B);
      if (!ctx.done && !ctx.verifyStarted) maybeVerify();
      return;
    }
    if (useA) localOcr(blob).then((t) => onOcr('A', t), (e) => onOcrFail('A', e));
    if (useB) {
      const t = withTimeout(C.cloudOcrTimeoutMs); ctx.aborters.push(t);
      cloudOcr(blob, t.signal).then((txt) => { t.cancel(); onOcr('B', txt); }, (e) => { t.cancel(); onOcrFail('B', e); });
    }
  }

  // ---------- capture ----------
  async function handleFile(file) {
    if (!file) return;
    if (!(await ensureIndex())) return;
    show('work');
    $('#view-work').dataset.done = '';
    $('#result').innerHTML = '<p class="notice">جارٍ تجهيز الصورة…</p>';
    hideCrop();
    fullCanvas = await fileToCanvas(file);
    $('#preview').src = fullCanvas.toDataURL('image/jpeg', 0.7);
    const blob = await canvasToBlob(fullCanvas);
    if (settings.autoRun) startRun(blob);
    else { $('#result').innerHTML = ''; showCrop(); }
  }
  $('#file').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('#btn-gallery').addEventListener('click', () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.addEventListener('change', () => handleFile(inp.files[0]));
    inp.click();
  });
  $('#btn-again').addEventListener('click', () => { if (run) run.cancel(); show('home'); $('#file').click(); });

  // ---------- crop ----------
  let crop = null; // in preview pixel coordinates
  function showCrop() { $('#crop-box').hidden = true; crop = null; $('#btn-crop').hidden = true; $('#btn-crop-go').hidden = false; $('#btn-crop-go').disabled = true;
    $('#btn-crop-go').textContent = 'ارسم مربعاً حول السؤال'; }
  function hideCrop() { $('#crop-box').hidden = true; crop = null; $('#btn-crop').hidden = false; $('#btn-crop-go').hidden = true; }
  $('#btn-crop').addEventListener('click', () => { if (run) run.cancel(); stopTimer(); showCrop(); });
  const wrap = $('.preview-wrap');
  let drag = null;
  function imgRect() { // where the image actually sits inside the wrapper (object-fit: contain)
    const img = $('#preview'); const wr = wrap.getBoundingClientRect();
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const s = Math.min(wr.width / iw, wr.height / ih);
    const w = iw * s, h = ih * s;
    return { left: wr.left + (wr.width - w) / 2, top: wr.top + (wr.height - h) / 2, w, h, s, wr };
  }
  wrap.addEventListener('pointerdown', (e) => {
    if ($('#btn-crop-go').hidden) return;
    const r = imgRect(); if (!r) return;
    drag = { x0: e.clientX, y0: e.clientY, r };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { r } = drag;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const x1 = clamp(drag.x0, r.left, r.left + r.w), y1 = clamp(drag.y0, r.top, r.top + r.h);
    const x2 = clamp(e.clientX, r.left, r.left + r.w), y2 = clamp(e.clientY, r.top, r.top + r.h);
    crop = { x: Math.min(x1, x2) - r.left, y: Math.min(y1, y2) - r.top, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    const box = $('#crop-box'); box.hidden = false;
    box.style.left = (crop.x + r.left - r.wr.left) + 'px'; box.style.top = (crop.y + r.top - r.wr.top) + 'px';
    box.style.width = crop.w + 'px'; box.style.height = crop.h + 'px';
    const okSize = crop.w > 30 && crop.h > 15;
    $('#btn-crop-go').disabled = !okSize;
    $('#btn-crop-go').textContent = okSize ? 'ابحث في الجزء المحدد' : 'ارسم مربعاً حول السؤال';
  });
  wrap.addEventListener('pointerup', () => { drag = null; });
  $('#btn-crop-go').addEventListener('click', async () => {
    if (!crop || !fullCanvas) return;
    const r = imgRect(); if (!r) return;
    const k = 1 / r.s; // preview px -> canvas px
    const cv = cropCanvas(fullCanvas, { x: crop.x * k, y: crop.y * k, w: crop.w * k, h: crop.h * k });
    hideCrop();
    startRun(await canvasToBlob(cv));
  });

  // ---------- typed search (local, instant, works offline) ----------
  const S = Object.assign({ minChars: 2, debounceMs: 150, maxResults: 8 }, C.search);
  let searchTimer = null;
  function runSearch(immediate, enterPressed) {
    clearTimeout(searchTimer);
    const go = async () => {
      const q = $('#q-input').value;
      $('#q-clear').hidden = !q;
      const box = $('#search-results');
      if (M.normalize(q).replace(/ /g, '').length < S.minChars) { box.innerHTML = ''; box.dataset.q = ''; return; }
      if (!(await ensureIndex())) { box.innerHTML = ''; box.dataset.q = ''; return; }
      renderSearch(M.search(index, q, S.maxResults, { prefix: !enterPressed, minChars: S.minChars }), q);
      box.dataset.q = q; // marks which query the visible results belong to (used by tests)
    };
    if (immediate) go(); else searchTimer = setTimeout(go, S.debounceMs);
  }
  function searchCard(c, q, open) {
    const html = M.highlight(c.q, q).map((p) => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join('');
    return `<article class="cand${open ? ' open' : ''}" data-id="${c.id}">
        <p class="q">${html} ${subjectTag(c)}</p>
        <p class="a">${esc(c.a)}</p>
      </article>`;
  }
  function searchActions() {
    return settings.subject !== 'all' && multiSubject()
      ? '<div class="actions"><button class="secondary" data-act="search-all">🔎 ابحث في كل المواد</button></div>' : '';
  }
  // "✓ مطابق" needs the same strict rule as a photo OCR read (score, lead, no clash); otherwise the
  // list is just suggestions. The top card is open unless the same question exists with different answers.
  function renderSearch(results, q) {
    const box = $('#search-results');
    if (!results.length) { box.innerHTML = '<p class="notice">لا توجد نتائج مطابقة. جرّب كلمات أخرى.</p>' + searchActions(); return; }
    const clash = M.hasConflictingTwin(results[0], results);
    const sure = M.decide(results, C.thresholds).status === 'confident' && !clash;
    box.innerHTML = `<div class="search-head">${sure ? '<span class="badge ok">✓ مطابق</span>' : '<span class="badge neutral">نتائج مقترحة</span>'}
      ${clash ? '<p class="src">هذا السؤال موجود أكثر من مرة بإجابات مختلفة، تأكد من الإجابة الصحيحة.</p>' : ''}</div>` +
      results.map((c, i) => searchCard(c, q, !clash && i === 0)).join('') + searchActions();
    bindCards();
  }
  $('#q-input').addEventListener('input', () => runSearch());
  $('#q-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(true, true); e.target.blur(); } });
  $('#q-clear').addEventListener('click', () => { $('#q-input').value = ''; runSearch(true); $('#q-input').focus(); });
  $('#search-results').addEventListener('click', (e) => { if (e.target.closest('[data-act="search-all"]')) setSubject('all'); });

  // ---------- uploading Excel files: parsed on the phone and kept there ----------
  const XL_ERRORS = {
    old_format: 'صيغة Excel القديمة (xls) غير مدعومة. افتح الملف في Excel واحفظه بصيغة xlsx ثم ارفعه.',
    unsupported: 'نوع الملف غير مدعوم. ارفع ملف Excel (xlsx) أو csv.',
    too_big: 'الملف كبير جداً (الحد 25 ميغابايت).',
    corrupt: 'تعذرت قراءة الملف. تأكد أنه ملف Excel سليم وغير محمي بكلمة مرور.',
    empty: 'الملف لا يحتوي على بيانات.',
    no_reader: 'قارئ Excel لم يُحمَّل بعد. حدّث الصفحة وحاول مرة أخرى.',
    too_many: 'عدد الأسئلة في هذه المادة كبير جداً.',
  };
  let jobs = [];               // one per chosen file
  let pendingReplace = null;   // subject number chosen with "تحديث": the next single file replaces it
  const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

  function openFilePicker(replaceNumber) { pendingReplace = replaceNumber || null; $('#xl-input').click(); }
  $('#btn-upload').addEventListener('click', () => openFilePicker());
  $('#btn-upload-empty').addEventListener('click', () => openFilePicker());
  $('#manage-add').addEventListener('click', () => openFilePicker());
  $('#xl-input').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) startImport(files); });

  // Column choice of a sheet -> the mapping used to read it (null = sheet is skipped).
  function applyMap(s) {
    const ok = s.q != null && s.a != null && s.q !== s.a;
    s.map = ok ? { headerRow: s.info.headerRow, q: s.q, a: s.a,
      opts: Object.fromEntries(Object.entries(s.info.opts).filter(([, c]) => c !== s.q && c !== s.a)) } : null;
  }
  async function makeJob(file) {
    const job = { file, name: file.name.replace(/\.[^.]+$/, ''), sheets: [], error: null, items: [], report: null, replace: null };
    try {
      if (!window.readXlsxFile && /\.xlsx?m?$/i.test(file.name)) throw new Importer.ImportError('no_reader');
      const parsed = await Importer.readFile(file, window.readXlsxFile);
      job.name = parsed.stem;
      job.sheets = parsed.sheets.filter((s) => s.rows.length).map((s) => {
        const info = Importer.analyzeSheet(s.rows);
        const sheet = { name: s.name, rows: s.rows, info, q: info.q, a: info.a, map: null };
        applyMap(sheet);
        return sheet;
      });
      if (!job.sheets.length) throw new Importer.ImportError('empty');
    } catch (e) {
      console.warn('import', file.name, e);
      job.error = XL_ERRORS[e.code] ? e.code : 'corrupt';
    }
    return job;
  }
  const sameName = (job) => manifest.subjects.find((s) => s.source === 'user' && s.name.trim().toLowerCase() === job.name.trim().toLowerCase()) || null;
  function recompute(job) {
    if (job.error) return;
    const res = Importer.buildFromSheets(job.sheets.map((s) => ({ rows: s.rows, map: s.map })));
    job.items = res.items;
    job.report = res.report;
    job.replace = sameName(job);
  }
  async function startImport(files) {
    if (!(await Store.available())) { setStatus('التخزين غير متاح في هذا المتصفح (ربما الوضع الخاص). افتح التطبيق في نافذة عادية.'); return; }
    const dlg = $('#import-dialog');
    $('#import-error').hidden = true;
    $('#import-list').innerHTML = '<p class="notice">جارٍ قراءة الملفات…</p>';
    $('#import-save').disabled = true;
    if (!dlg.open) dlg.showModal();
    const forced = pendingReplace; pendingReplace = null;
    jobs = [];
    for (const f of files) jobs.push(await makeJob(f)); // one at a time: keeps memory low on phones
    if (forced && jobs.length === 1) { const s = subjectByNumber(forced); if (s) jobs[0].name = s.name; }
    jobs.forEach(recompute);
    renderJobs();
  }
  const colOptions = (labels, selected) => '<option value="">— تجاهل —</option>' +
    labels.map((l, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
  function replaceText(job) {
    return job.replace ? `مادة بهذا الاسم موجودة (${job.replace.count} سؤال) وسيتم استبدالها.` : '';
  }
  function jobHtml(job, i) {
    const head = `<div class="imp-head"><input class="imp-name" data-i="${i}" value="${esc(job.name)}" aria-label="اسم المادة">
      <button class="imp-x" data-imp="remove" data-i="${i}" aria-label="إزالة الملف">✕</button></div>`;
    if (job.error) return `<article class="imp bad" data-i="${i}">${head}<p class="notice error">${esc(XL_ERRORS[job.error])}</p></article>`;
    const r = job.report;
    const warn = [];
    job.sheets.forEach((s) => {
      if (s.q == null || s.a == null) warn.push(['warn', `ورقة «${s.name}»: اختر عمود السؤال وعمود الإجابة، وإلا ستُتجاهل.`]);
      else if (s.info.status === 'guess') warn.push(['warn', `ورقة «${s.name}»: لم أجد عناوين الأعمدة، تحقق من الاختيار.`]);
    });
    if (r.empty) warn.push(['info', `تم تخطي ${r.empty} سؤال بلا إجابة.`]);
    if (r.merged) warn.push(['info', `تم دمج ${r.merged} سؤال مكرر بنفس الإجابة.`]);
    if (r.conflicts.length) warn.push(['warn', `${r.conflicts.length} سؤال مكرر بإجابتين مختلفتين: لن يُعرض أي منهما كإجابة مؤكدة. مثال: «${trunc(r.conflicts[0].q, 60)}»`]);
    if (r.near.length) warn.push(['info', `${r.near.length} زوج أسئلة متشابهة جداً، راجعها إن أمكن.`]);
    const needsCheck = job.sheets.some((s) => s.info.status !== 'ok' || s.q == null || s.a == null);
    const sheets = job.sheets.map((s, si) => `<div class="imp-sheet"><span class="sname">ورقة «${esc(s.name)}» · ${s.rows.length} صف</span>
        <label>السؤال <select data-imp="q" data-i="${i}" data-s="${si}">${colOptions(s.info.labels, s.q)}</select></label>
        <label>الإجابة <select data-imp="a" data-i="${i}" data-s="${si}">${colOptions(s.info.labels, s.a)}</select></label></div>`).join('');
    const sample = job.items.slice(0, 3).map((it) => `<p><b>س:</b> ${esc(trunc(it.q, 70))}<br><b>ج:</b> ${esc(trunc(it.a, 70))}</p>`).join('');
    return `<article class="imp${job.items.length ? '' : ' bad'}" data-i="${i}">${head}
      <p class="imp-count">${job.items.length ? `✓ ${job.items.length} سؤال` : 'لا توجد أسئلة صالحة، لن يُحفظ هذا الملف.'}</p>
      <p class="imp-replace">${esc(replaceText(job))}</p>
      ${warn.map(([k, t]) => `<p class="imp-note ${k}">${k === 'warn' ? '⚠︎ ' : ''}${esc(t)}</p>`).join('')}
      <details class="imp-cols"${needsCheck ? ' open' : ''}><summary>الأعمدة المستخدمة</summary>${sheets}</details>
      ${sample ? `<div class="imp-sample"><span class="small">أمثلة مما قرأته:</span>${sample}</div>` : ''}
    </article>`;
  }
  function renderJobs() {
    $('#import-list').innerHTML = jobs.length ? jobs.map(jobHtml).join('') : '<p class="notice">لا توجد ملفات.</p>';
    updateSaveButton();
  }
  const savable = () => jobs.filter((j) => !j.error && j.items.length && j.name.trim());
  function updateSaveButton() {
    const n = savable().length;
    $('#import-save').disabled = n === 0;
    $('#import-save').textContent = n > 1 ? `حفظ (${n} مواد)` : 'حفظ';
  }
  $('#import-list').addEventListener('input', (e) => {
    const el = e.target.closest('.imp-name');
    if (!el) return;
    const job = jobs[+el.dataset.i];
    job.name = el.value;
    job.replace = sameName(job);
    el.closest('.imp').querySelector('.imp-replace').textContent = replaceText(job);
    updateSaveButton();
  });
  $('#import-list').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-imp]');
    if (!sel) return;
    const job = jobs[+sel.dataset.i], s = job.sheets[+sel.dataset.s];
    s[sel.dataset.imp] = sel.value === '' ? null : +sel.value;
    applyMap(s); recompute(job); renderJobs();
  });
  $('#import-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-imp="remove"]');
    if (!b) return;
    jobs.splice(+b.dataset.i, 1); renderJobs();
  });
  $('#import-cancel').addEventListener('click', () => { jobs = []; $('#import-dialog').close(); });
  $('#import-save').addEventListener('click', saveJobs);

  async function saveJobs() {
    const todo = savable();
    if (!todo.length) return;
    $('#import-save').disabled = true;
    const saved = [];
    try {
      for (const job of todo) {
        const name = job.name.trim();
        const same = sameName(job);
        const number = same ? same.number : await Store.nextNumber();
        const items = Importer.assignIds(job.items, number);
        await Store.put({ number, name, count: items.length, version: Importer.hashItems(items), file: job.file.name, added: Date.now() }, items);
        for (const k of [...subjectCache.keys()]) if (k.startsWith(number + ':')) subjectCache.delete(k);
        saved.push(number);
      }
    } catch (e) {
      console.warn('save', e);
      $('#import-error').textContent = e && e.code === 'too_many' ? XL_ERRORS.too_many : 'تعذر حفظ الملفات على هذا الهاتف. تأكد من وجود مساحة كافية وحاول مرة أخرى.';
      $('#import-error').hidden = false;
      $('#import-save').disabled = false;
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // ask the browser not to evict the data
    jobs = [];
    $('#import-dialog').close();
    await reloadLibrary();
    refreshLibraryUI();
    const keep = settings.subject && (settings.subject === 'all' || subjectByNumber(settings.subject));
    await setSubject(saved.length === 1 || !keep ? saved[0] : settings.subject);
    setStatus(saved.length === 1 ? 'تم حفظ المادة' : `تم حفظ ${saved.length} مواد`);
    setTimeout(() => { if ($('#status-line').textContent.startsWith('تم حفظ')) setStatus(''); }, 4000);
    if ($('#manage-dialog').open) renderManage();
  }

  // ---------- managing uploaded subjects ----------
  function renderManage() {
    $('#manage-list').innerHTML = manifest.subjects.length ? manifest.subjects.map((s) => `
      <div class="mrow" data-n="${s.number}">
        <div class="mname"><b>${esc(s.name)}</b><small>${s.count} سؤال${s.source === 'bundled' ? ' · مدمجة في التطبيق' : ''}</small></div>
        ${s.source === 'user' ? `<div class="mbtns">
          <button data-mg="rename">✎ الاسم</button><button data-mg="update">↻ تحديث</button><button data-mg="delete" class="danger">🗑 حذف</button></div>` : ''}
      </div>`).join('') : '<p class="notice">لا توجد مواد بعد.</p>';
  }
  $('#btn-manage').addEventListener('click', () => { renderManage(); $('#manage-dialog').showModal(); });
  $('#manage-close').addEventListener('click', () => $('#manage-dialog').close());
  $('#manage-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mg]');
    if (!b) return;
    const s = subjectByNumber(b.closest('.mrow').dataset.n);
    if (!s || s.source !== 'user') return;
    if (b.dataset.mg === 'rename') {
      const name = (window.prompt('اسم المادة', s.name) || '').trim();
      if (!name || name === s.name) return;
      await Store.rename(s.number, name);
      await reloadAndReapply();
      renderManage();
    } else if (b.dataset.mg === 'update') {
      $('#manage-dialog').close();
      openFilePicker(s.number);
    } else if (b.dataset.mg === 'delete') {
      if (!window.confirm(`حذف مادة «${s.name}» و${s.count} سؤال من هذا الهاتف؟`)) return;
      await Store.remove(s.number);
      for (const k of [...subjectCache.keys()]) if (k.startsWith(s.number + ':')) subjectCache.delete(k);
      await reloadAndReapply();
      renderManage();
    }
  });

  // ---------- settings dialog ----------
  $('#btn-settings').addEventListener('click', () => { $('#opt-auto-run').checked = settings.autoRun; $('#opt-debug').checked = settings.debug; $('#settings').showModal(); });
  $('#btn-close-settings').addEventListener('click', () => $('#settings').close());
  $('#opt-auto-run').addEventListener('change', (e) => { settings.autoRun = e.target.checked; save(); });
  $('#opt-debug').addEventListener('change', (e) => { settings.debug = e.target.checked; save(); });

  // ---------- install hint ----------
  function installHint() {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone || settings.installHintSeen) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const el = $('#install-hint');
    el.innerHTML = ios
      ? 'لتثبيت التطبيق: اضغط زر المشاركة <b>⎋</b> في سفاري ثم <b>إضافة إلى الشاشة الرئيسية</b>. <a href="#" id="dismiss-hint">إخفاء</a>'
      : 'لتثبيت التطبيق: افتح قائمة المتصفح <b>⋮</b> ثم <b>إضافة إلى الشاشة الرئيسية</b> أو <b>تثبيت التطبيق</b>. <a href="#" id="dismiss-hint">إخفاء</a>';
    el.hidden = false;
    $('#dismiss-hint').addEventListener('click', (e) => { e.preventDefault(); settings.installHintSeen = true; save(); el.hidden = true; });
  }

  // ---------- boot ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setMode(settings.mode);
  installHint();
  ready = bootData();
  ready.catch((e) => { console.warn(e); setStatus('تعذر تحميل الأسئلة، تحقق من الاتصال'); });
  modeReady = loadVerifyMode();
  window.addEventListener('load', () => { if (settings.mode !== 'google') warmLocalOcr(); });
  window.addEventListener('online', () => { if (settings.mode !== 'local') setStatus(''); });
  window.addEventListener('offline', () => setStatus(settings.mode === 'google' ? 'لا يوجد إنترنت: وضع جوجل لن يعمل' : ''));
})();
