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
  function setMode(mode) {
    settings.mode = mode; save();
    document.querySelectorAll('#mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('#mode-hint').textContent = MODE_HINTS[mode];
    if (mode !== 'google') warmLocalOcr();
  }
  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- dataset: one JSON per subject, only the selected subject is indexed ----------
  let manifest = null;               // {version, subjects: [{number, name, count, file, version}]}
  const subjectCache = new Map();    // number -> {number, name, items}
  let index = null;                  // matcher index of the current selection
  const subjectByNumber = (n) => manifest && manifest.subjects.find((s) => String(s.number) === String(n));
  const multiSubject = () => !!manifest && manifest.subjects.length > 1;

  async function loadManifest() {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('manifest ' + res.status);
    return res.json();
  }
  async function loadSubject(s) {
    if (subjectCache.has(s.number)) return subjectCache.get(s.number);
    const res = await fetch(`data/${s.file}?v=${s.version}`);
    if (!res.ok) throw new Error(`${s.file} ${res.status}`);
    const doc = await res.json();
    subjectCache.set(s.number, doc);
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
    $('#about').textContent = `${items.length} سؤال في ${docs.length} مادة، إصدار ${manifest.version}`;
    return items.length;
  }
  function renderPicker() {
    const sel = $('#subject');
    sel.innerHTML = '<option value="" disabled>اختر المادة…</option>' +
      manifest.subjects.map((s) => `<option value="${s.number}">${esc(s.name)} (${s.count})</option>`).join('') +
      (manifest.subjects.length > 1 ? '<option value="all">كل المواد</option>' : '');
    $('#subject-card').hidden = manifest.subjects.length < 2;
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
  function prefetchOthers() {
    const go = () => manifest.subjects.forEach((s) => { if (!subjectCache.has(s.number)) loadSubject(s).catch(() => {}); });
    (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(go);
  }
  let ready = null; // resolves when the manifest and the current subject are loaded
  async function bootData() {
    manifest = await loadManifest();
    renderPicker();
    const want = new URLSearchParams(location.search).get('subject'); // deep link: ?subject=2 or ?subject=all
    if (want && (want === 'all' || subjectByNumber(want))) settings.subject = want;
    if (manifest.subjects.length === 1) settings.subject = String(manifest.subjects[0].number);
    if (settings.subject !== 'all' && !subjectByNumber(settings.subject)) settings.subject = '';
    save();
    syncPicker();
    if (settings.subject) { await applySelection(); setStatus(''); }
    prefetchOthers();
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
  async function localOcr(blob) {
    const worker = await warmLocalOcr();
    const sides = C.tesseract.sides || [1000, 700];
    let text = '';
    for (const side of sides) {
      const small = await resizeBlob(blob, side);
      const { data } = await worker.recognize(small);
      text = data.text || '';
      if (M.tokens(M.normalize(text)).length >= 3) break;
    }
    return text;
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
    fd.append('image', blob, 'q.jpg');
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
    if (!c.subject) return '';
    const also = c.also && c.also.length ? ` · أيضاً في: ${c.also.map(esc).join('، ')}` : '';
    return `<span class="subj">${esc(c.subject)}${also}</span>`;
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
    const useA = !reuse && mode !== 'google';
    const useB = !reuse && mode !== 'local' && online;
    chip('A', useA ? 'running' : 'skip');
    chip('B', useB ? 'running' : (online ? 'skip' : 'fail'));
    chip('C', online ? 'idle' : 'skip');
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
      // Optional fast path, off by default: two independent OCR engines confident on the same question.
      if (C.fastPath && ctx.results.A && ctx.results.B) {
        const a = ctx.results.A.r.decision, b = ctx.results.B.r.decision;
        if (a.status === 'confident' && b.status === 'confident' && a.best.id === b.best.id) return finish(() => renderConfident(a.best, 'قراءتان متطابقتان', text));
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
      const seen = new Set(), list = [];
      for (const res of order) for (const c of res.r.ranked) if (!seen.has(c.id) && seen.add(c.id)) list.push(c);
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
        const debug = m.text + (v.photo_question ? '\n--- verifier read ---\n' + v.photo_question : '') + (v.reason ? '\n--- ' + v.reason : '');
        // the same question with a different answer in another subject can never be green
        const clash = hit && M.hasConflictingTwin(hit, m.list);
        if (hit && v.confidence === 'high' && inTop3 && transcriptionOk && !clash) {
          chip('C', 'done');
          finish(() => renderConfident(hit, 'تم التحقق من الصورة', debug));
        } else {
          chip('C', 'fail');
          finish(() => renderCandidates(m.list.slice(0, 3), debug, clash
            ? 'هذا السؤال موجود في أكثر من مادة بإجابات مختلفة. اختر المادة الصحيحة من القائمة:'
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
      ${clash ? '<p class="src">هذا السؤال موجود في أكثر من مادة بإجابات مختلفة، تأكد من المادة.</p>' : ''}</div>` +
      results.map((c, i) => searchCard(c, q, !clash && i === 0)).join('') + searchActions();
    bindCards();
  }
  $('#q-input').addEventListener('input', () => runSearch());
  $('#q-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(true, true); e.target.blur(); } });
  $('#q-clear').addEventListener('click', () => { $('#q-input').value = ''; runSearch(true); $('#q-input').focus(); });
  $('#search-results').addEventListener('click', (e) => { if (e.target.closest('[data-act="search-all"]')) setSubject('all'); });

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
  window.addEventListener('load', () => { if (settings.mode !== 'google') warmLocalOcr(); });
  window.addEventListener('online', () => { if (settings.mode !== 'local') setStatus(''); });
  window.addEventListener('offline', () => setStatus(settings.mode === 'google' ? 'لا يوجد إنترنت: وضع جوجل لن يعمل' : ''));
})();
