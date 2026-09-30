/* Photo -> answer app. Flow: capture -> downscale -> OCR tiers race -> match -> (verify) -> render. */
(function () {
  'use strict';
  const C = window.APP_CONFIG;
  const M = window.Matcher;
  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'answer-app';

  // ---------- settings ----------
  const settings = Object.assign({ mode: 'auto', autoRun: true, debug: false, installHintSeen: false }, load());
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

  // ---------- dataset ----------
  let index = null;
  let datasetInfo = '';
  async function loadQuestions() {
    const res = await fetch('questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('questions.json ' + res.status);
    const data = await res.json();
    index = M.buildIndex(data.items);
    window.__items = data.items; // used by tests/golden_run.js
    datasetInfo = `${data.count} سؤال، إصدار ${data.version}`;
    $('#about').textContent = datasetInfo;
    return data;
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

  function renderConfident(items, tier, debugText) {
    const html = items.map((best) => `
      <article class="answer confident">
        <span class="badge ok">✓ مؤكد · ${TIER_NAME[tier]}</span>
        <p class="q">${esc(best.q)}</p>
        <p class="a">${esc(best.a)}</p>
      </article>`).join('');
    $('#result').innerHTML = html + debugBlock(debugText);
  }
  function renderCandidates(cands, debugText, note) {
    const cards = cands.map((c) => `
      <article class="cand" data-id="${c.id}">
        <p class="q">${esc(c.q)} <span class="score">${Math.round(c.score * 100)}%</span></p>
        <p class="a">${esc(c.a)}</p>
      </article>`).join('');
    $('#result').innerHTML = `<div class="answer unverified"><span class="badge warn">غير مؤكد</span>
      <p class="q">${esc(note || 'لم أتأكد من السؤال. اضغط على السؤال المطابق لعرض إجابته، أو قص السؤال وأعد المحاولة.')}</p></div>${cards}${debugBlock(debugText)}`;
    document.querySelectorAll('.cand').forEach((el) => el.addEventListener('click', () => el.classList.toggle('open')));
  }
  function renderNotice(text, isError, debugText) {
    $('#result').innerHTML = `<p class="notice${isError ? ' error' : ''}">${esc(text)}</p>${debugBlock(debugText)}`;
  }
  function debugBlock(t) { return settings.debug && t ? `<pre class="debug">${esc(t)}</pre>` : ''; }

  // ---------- matching ----------
  function analyse(text) {
    // several numbered questions in one photo -> answer each if all are confident
    const parts = M.splitQuestions(text);
    if (parts.length > 1) {
      const per = parts.map((p) => M.decide(M.rank(index, p), C.thresholds));
      if (per.every((d) => d.status === 'confident')) {
        const ids = new Set();
        const bests = per.map((d) => d.best).filter((b) => !ids.has(b.id) && ids.add(b.id));
        return { status: 'confident', bests, candidates: [] };
      }
    }
    const ranked = M.rank(index, text, 10);
    const d = M.decide(ranked, C.thresholds);
    return { status: d.status, bests: d.best ? [d.best] : [], candidates: d.status === 'none' ? [] : ranked };
  }

  // ---------- pipeline ----------
  let run = null; // current run context
  async function startRun(blob) {
    if (run) run.cancel();
    const mode = settings.mode;
    const online = navigator.onLine;
    const ctx = { done: false, aborters: [], results: {}, verifyStarted: false, cancel() { this.done = true; this.aborters.forEach((a) => a.abort()); } };
    run = ctx;
    currentBlob = blob;
    $('#view-work').dataset.done = '';
    $('#result').innerHTML = '';
    ['A', 'B', 'C'].forEach((t) => chip(t, 'idle'));
    startTimer();

    const useA = mode !== 'google';
    const useB = mode !== 'local' && online;
    chip('A', useA ? 'running' : 'skip');
    chip('B', useB ? 'running' : (online ? 'skip' : 'fail'));
    chip('C', online ? 'idle' : 'skip');
    const markDone = () => { $('#view-work').dataset.done = '1'; };
    if (!useA && !useB) { stopTimer(); renderNotice('لا يوجد اتصال بالإنترنت. اختر وضع "محلي" للقراءة بدون إنترنت.', true); markDone(); return; }

    const pending = { A: useA, B: useB };
    const finish = (fn) => { if (ctx.done) return; ctx.cancel(); stopTimer(); fn(); markDone(); };

    function onOcr(tier, text) {
      if (ctx.done) return;
      pending[tier] = false;
      const r = analyse(text);
      ctx.results[tier] = { text, r };
      chip(tier, r.status === 'confident' ? 'done' : 'fail');
      if (r.status === 'confident') return finish(() => renderConfident(r.bests, tier, text));
      // not confident: verify with the best OCR we have, preferring Google's text
      if (tier === 'B' || !pending.B) maybeVerify();
    }
    function onOcrFail(tier, err) {
      if (ctx.done) return;
      pending[tier] = false;
      chip(tier, 'fail');
      console.warn(tier, err);
      if (!pending.A && !pending.B) maybeVerify();
    }
    function bestResult() { return ctx.results.B || ctx.results.A || null; }
    async function maybeVerify() {
      if (ctx.done || ctx.verifyStarted) return;
      const br = bestResult();
      if (!br) return finish(() => renderNotice('تعذرت قراءة الصورة. حاول التصوير في إضاءة أفضل.', true));
      if (br.r.status === 'none' || !online) {
        return finish(() => br.r.status === 'none'
          ? renderNotice('لم أجد السؤال، حاول تصوير السؤال أقرب وبوضوح.', false, br.text)
          : renderCandidates(br.r.candidates.slice(0, 3), br.text, online ? undefined : 'لا يوجد إنترنت للتحقق. اختر السؤال المطابق:'));
      }
      ctx.verifyStarted = true;
      chip('C', 'running');
      const t = withTimeout(C.verifyTimeoutMs); ctx.aborters.push(t);
      try {
        const v = await verify(blob, br.r.candidates, br.text, t.signal);
        t.cancel();
        if (ctx.done) return;
        const top3 = br.r.candidates.slice(0, 3).map((c) => c.id);
        const hit = br.r.candidates.find((c) => c.id === v.match_id);
        if (hit && v.confidence === 'high' && top3.includes(hit.id)) {
          chip('C', 'done');
          finish(() => renderConfident([hit], 'C', br.text));
        } else {
          chip('C', 'fail');
          finish(() => renderCandidates(br.r.candidates.slice(0, 3), br.text));
        }
      } catch (err) {
        if (ctx.done) return;
        chip('C', 'fail');
        console.warn('verify', err);
        finish(() => renderCandidates(br.r.candidates.slice(0, 3), br.text, 'تعذر التحقق عبر الإنترنت. اختر السؤال المطابق:'));
      }
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
    if (!index) { setStatus('جارٍ تحميل الأسئلة…'); try { await loadQuestions(); } catch { setStatus('تعذر تحميل الأسئلة'); return; } }
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
  loadQuestions().then(() => setStatus(''), () => setStatus('تعذر تحميل الأسئلة، تحقق من الاتصال'));
  window.addEventListener('load', () => { if (settings.mode !== 'google') warmLocalOcr(); });
  window.addEventListener('online', () => { if (settings.mode !== 'local') setStatus(''); });
  window.addEventListener('offline', () => setStatus(settings.mode === 'google' ? 'لا يوجد إنترنت: وضع جوجل لن يعمل' : ''));
})();
