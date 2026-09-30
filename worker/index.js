/* Cloudflare Worker: API for the photo-answer app. One Google Gemini key does both jobs.
 *   POST /api/ocr      image (multipart "image")                   -> { text }
 *   POST /api/verify   image + candidates JSON + ocr text          -> { match_id, confidence, photo_question, reason, usage, cost_usd }
 *   POST /api/selftest                                            -> checks the key and the model name with a tiny request
 *   GET  /api/health                                              -> { ok, model, ocr, verify }
 * Static files in ../public are served by Workers Static Assets (see wrangler.toml).
 * Secrets:  GEMINI_API_KEY, APP_TOKEN            (wrangler secret put ...)
 * Optional: GOOGLE_VISION_KEY when OCR_PROVIDER = "vision" (Cloud Vision instead of Gemini for reading text). */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// A fast, cheap, GA Flash-Lite model. Model names change often: set GEMINI_MODEL in wrangler.toml to use another
// (for example a bigger Flash model for more accuracy) and run POST /api/selftest to confirm the name works.
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
// USD per million tokens [input, output] for the cost estimate. A guide only (prices change);
// override with PRICE_IN / PRICE_OUT in wrangler.toml.
const PRICES = [
  [/^gemini-3\.1-flash-lite/, [0.25, 1.5]],
  [/^gemini-2\.5-flash-lite/, [0.10, 0.40]],
  [/^gemini-2\.5-flash/, [0.30, 2.50]],
];

const VERIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    photo_question: { type: 'STRING', description: 'the question text exactly as written in the photo, Arabic, without the answer options; empty string if unreadable' },
    match_id: { type: 'INTEGER', nullable: true, description: 'id of the candidate that is the same question as in the photo, or null' },
    confidence: { type: 'STRING', enum: ['high', 'low'] },
    reason: { type: 'STRING', description: 'one short sentence' },
  },
  required: ['photo_question', 'match_id', 'confidence', 'reason'],
  propertyOrdering: ['photo_question', 'match_id', 'confidence', 'reason'],
};

const VERIFY_PROMPT = `You verify which question from a closed list is the one shown in a photo.
The photo shows an Arabic exam question, possibly with answer options, numbering, neighbouring questions or glare.
You receive a numbered list of candidate questions (id + text) and, as a hint only, the raw OCR text.

Rules:
- First transcribe the question in the photo yourself into photo_question, exactly as written (no options). Do not trust the OCR text when it disagrees with the photo.
- Return match_id only when a candidate asks the same question as the photo (same meaning, same subject). Small OCR-style differences in spelling, diacritics, punctuation or numbering do not matter.
- Two candidates that differ in a key word (e.g. "أطول" vs "أقصر", "العالم" vs "أفريقيا", a year or a number) are different questions; pick the one whose key words match the photo.
- If the photo contains several questions, answer for the one that fills most of the image or is most prominent.
- confidence "high" only when you are certain the chosen candidate is the same question. If no candidate matches, or you cannot read the photo, return match_id null with confidence "low".

Reply with one JSON object and nothing else: {"photo_question": string, "match_id": integer or null, "confidence": "high" or "low", "reason": string}.`;

const OCR_PROMPT = `Transcribe all the text in this image exactly as written. The text is Arabic (right to left) and may contain English letters, digits and symbols. Keep each line of the image on its own line. Output only the text, with no commentary.`;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });
}

function corsHeaders(env, req) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'access-control-allow-headers': 'content-type, x-app-token', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
  if (allowed.length === 0) return h; // same-origin deployment: no CORS needed
  if (allowed.includes('*') || allowed.includes(origin)) h['access-control-allow-origin'] = allowed.includes('*') ? '*' : origin;
  return h;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function readImage(req) {
  const ct = req.headers.get('content-type') || '';
  let file, fields = {};
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    file = fd.get('image');
    for (const [k, v] of fd.entries()) if (typeof v === 'string') fields[k] = v;
  } else if (ct.startsWith('image/')) {
    file = new Blob([await req.arrayBuffer()], { type: ct });
  }
  if (!file || typeof file === 'string') throw new HttpError(400, 'image missing');
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(413, 'image too large (max 2 MB)');
  const type = (file.type || 'image/jpeg').split(';')[0];
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'image must be jpeg, png or webp');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, type, fields };
}

async function checkAccess(req, env) {
  if (env.APP_TOKEN && req.headers.get('x-app-token') !== env.APP_TOKEN) throw new HttpError(401, 'bad app token');
  if (env.RATE_LIMITER) {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw new HttpError(429, 'too many requests, slow down');
  }
}

// ---------- Gemini ----------
const modelOf = (env) => env.GEMINI_MODEL || DEFAULT_MODEL;
// VERIFY_MODE: "gemini" = the model confirms the question from the photo; "off" = no confirmation call,
// the app then shows a green answer only when its two text readers agree on the same question.
const verifyMode = (env) => (String(env.VERIFY_MODE || 'gemini').toLowerCase() === 'off' ? 'off' : 'gemini');

// Gemini 2.x switches thinking off with a zero budget; Gemini 3.x takes a level. Thinking tokens are billed
// as output, and reading one question needs none, so keep it as small as the model allows.
function thinkingFor(model, env) {
  if (env.GEMINI_THINKING === 'default') return null;
  if (/^gemini-2\./.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: env.GEMINI_THINKING || 'low' };
}

/** One generateContent call. If Gemini rejects an optional setting (400), retry with fewer settings:
 *  drop the thinking config, then the response schema, then the JSON mime type. */
async function gemini(env, { system, parts, schema, json: wantJson, maxOutputTokens }) {
  if (!env.GEMINI_API_KEY) throw new HttpError(503, 'GEMINI_API_KEY not configured');
  const model = modelOf(env);
  const variants = [
    { thinking: true, schema: !!schema, mime: wantJson },
    { thinking: false, schema: !!schema, mime: wantJson },
    { thinking: false, schema: false, mime: wantJson },
    { thinking: false, schema: false, mime: false },
  ].filter((v, i, a) => i === a.findIndex((w) => w.thinking === v.thinking && w.schema === v.schema && w.mime === v.mime));
  let lastError = '';
  for (const v of variants) {
    const generationConfig = { temperature: 0, maxOutputTokens };
    if (v.mime) generationConfig.responseMimeType = 'application/json';
    if (v.schema) generationConfig.responseSchema = schema;
    const th = v.thinking ? thinkingFor(model, env) : null;
    if (th) generationConfig.thinkingConfig = th;
    const body = { contents: [{ role: 'user', parts }], generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetch(`${GEMINI_URL}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.status === 400) { lastError = (await res.text()).slice(0, 300); continue; }
    if (res.status === 404) throw new HttpError(502, `model "${model}" not found: set GEMINI_MODEL in wrangler.toml to a current Gemini Flash model name`);
    if (!res.ok) throw new HttpError(502, `gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    const blocked = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && /SAFETY|RECITATION|PROHIBITED/.test(cand.finishReason || '') ? cand.finishReason : '');
    const u = data.usageMetadata || {};
    return { text, blocked, model, usage: { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
  }
  throw new HttpError(502, `gemini rejected the request: ${lastError}`);
}

function costOf(env, model, usage) {
  let price = PRICES.find(([re]) => re.test(model));
  price = price ? price[1] : null;
  if (env.PRICE_IN && env.PRICE_OUT) price = [Number(env.PRICE_IN), Number(env.PRICE_OUT)];
  if (!price || !usage) return null;
  return Math.round(usage.input_tokens * price[0] + usage.output_tokens * price[1]) / 1e6; // USD
}

// The reply is JSON; take the first {...} block in case the model added a word around it.
function parseReply(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

async function ocrGemini(bytes, type, env) {
  const r = await gemini(env, {
    parts: [{ inline_data: { mime_type: type, data: bytesToBase64(bytes) } }, { text: OCR_PROMPT }],
    json: false, maxOutputTokens: 1024,
  });
  return { text: r.blocked ? '' : r.text.trim(), usage: r.usage, cost_usd: costOf(env, r.model, r.usage) };
}

// Optional alternative reader (set OCR_PROVIDER = "vision"): Google Cloud Vision.
async function ocrVision(bytes, env) {
  if (!env.GOOGLE_VISION_KEY) throw new HttpError(503, 'GOOGLE_VISION_KEY not configured');
  const body = { requests: [{ image: { content: bytesToBase64(bytes) }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: { languageHints: ['ar'] } }] };
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(502, `vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const r = (data.responses && data.responses[0]) || {};
  if (r.error) throw new HttpError(502, `vision: ${r.error.message}`);
  return { text: (r.fullTextAnnotation && r.fullTextAnnotation.text) || '', usage: null, cost_usd: null };
}

async function verifyWithGemini(bytes, type, candidates, ocrText, env) {
  const list = candidates.map((c) => `${c.id}. ${c.q}`).join('\n');
  const userText = `Candidates:\n${list}\n\nOCR hint (may contain errors):\n${(ocrText || '').slice(0, 1500)}\n\nWhich candidate id is the question in the photo?`;
  const r = await gemini(env, {
    system: VERIFY_PROMPT,
    parts: [{ inline_data: { mime_type: type, data: bytesToBase64(bytes) } }, { text: userText }],
    schema: VERIFY_SCHEMA, json: true, maxOutputTokens: 400,
  });
  const extra = { model: r.model, usage: r.usage, cost_usd: costOf(env, r.model, r.usage) };
  if (r.blocked) return { match_id: null, confidence: 'low', photo_question: '', reason: 'blocked: ' + r.blocked, ...extra };
  const parsed = parseReply(r.text);
  if (!parsed) return { match_id: null, confidence: 'low', photo_question: '', reason: 'unparseable', ...extra };
  const ids = new Set(candidates.map((c) => c.id));
  const matchId = Number.isInteger(parsed.match_id) && ids.has(parsed.match_id) ? parsed.match_id : null;
  return {
    match_id: matchId,
    confidence: matchId && parsed.confidence === 'high' ? 'high' : 'low',
    photo_question: String(parsed.photo_question || '').slice(0, 500),
    reason: String(parsed.reason || '').slice(0, 200),
    ...extra,
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, model: modelOf(env), ocr: env.OCR_PROVIDER || 'gemini', verify: verifyMode(env), gemini: !!env.GEMINI_API_KEY }, 200, cors);
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await checkAccess(req, env);

      if (url.pathname === '/api/ocr') {
        const { bytes, type } = await readImage(req);
        const t0 = Date.now();
        const out = env.OCR_PROVIDER === 'vision' ? await ocrVision(bytes, env) : await ocrGemini(bytes, type, env);
        return json({ ...out, ms: Date.now() - t0 }, 200, cors);
      }
      if (url.pathname === '/api/verify') {
        if (verifyMode(env) === 'off') throw new HttpError(503, 'photo verification is off (VERIFY_MODE)');
        const { bytes, type, fields } = await readImage(req);
        let candidates;
        try { candidates = JSON.parse(fields.candidates || '[]'); } catch { throw new HttpError(400, 'candidates must be JSON'); }
        candidates = candidates.filter((c) => c && Number.isInteger(c.id) && typeof c.q === 'string').slice(0, 10);
        if (!candidates.length) throw new HttpError(400, 'no candidates');
        const t0 = Date.now();
        const result = await verifyWithGemini(bytes, type, candidates, fields.ocr, env);
        return json({ ...result, ms: Date.now() - t0 }, 200, cors);
      }
      if (url.pathname === '/api/selftest') { // a tiny text request: proves the key works and the model name exists
        const t0 = Date.now();
        const r = await gemini(env, { parts: [{ text: 'Reply with the JSON {"ok": true} and nothing else.' }], json: true, maxOutputTokens: 50 });
        return json({ ok: true, model: r.model, reply: r.text.slice(0, 80), usage: r.usage, ms: Date.now() - t0 }, 200, cors);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || 'error' }, status, cors);
    }
  },
};
