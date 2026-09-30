/* Cloudflare Worker: API for the photo-answer app.
 *   POST /api/ocr     image (multipart "image")                 -> { text }
 *   POST /api/verify  image + candidates JSON + ocr text        -> { match_id, confidence, reason }
 *   GET  /api/health                                            -> { ok, model }
 * Static files in ../public are served by Workers Static Assets (see wrangler.toml).
 * Secrets: GOOGLE_VISION_KEY, ANTHROPIC_API_KEY, APP_TOKEN (wrangler secret put ...). */
import Anthropic from '@anthropic-ai/sdk';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL = 'claude-opus-5-5';

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['match_id', 'confidence', 'reason'],
  properties: {
    match_id: { type: ['integer', 'null'], description: 'id of the candidate that is the same question as in the photo, or null' },
    confidence: { type: 'string', enum: ['high', 'low'] },
    reason: { type: 'string', description: 'one short sentence' },
  },
};

const SYSTEM_PROMPT = `You verify which question from a closed list is the one shown in a photo.
The photo shows an Arabic exam question, possibly with answer options, numbering, neighbouring questions or glare.
You receive a numbered list of candidate questions (id + text) and, as a hint only, the raw OCR text.

Rules:
- Read the question in the photo yourself; do not trust the OCR text when it disagrees with the photo.
- Return match_id only when a candidate asks the same question as the photo (same meaning, same subject). Small OCR-style differences in spelling, diacritics, punctuation or numbering do not matter.
- Two candidates that differ in a key word (e.g. "أطول" vs "أقصر", "العالم" vs "أفريقيا", a year or a number) are different questions; pick the one whose key words match the photo.
- If the photo contains several questions, answer for the one that fills most of the image or is most prominent.
- confidence "high" only when you are certain the chosen candidate is the same question. If no candidate matches, or you cannot read the photo, return match_id null with confidence "low".`;

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

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function checkAccess(req, env, ctx) {
  if (env.APP_TOKEN && req.headers.get('x-app-token') !== env.APP_TOKEN) throw new HttpError(401, 'bad app token');
  if (env.RATE_LIMITER) {
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) throw new HttpError(429, 'too many requests, slow down');
  }
}

// ---------- Google Vision OCR ----------
async function ocr(bytes, env) {
  if (!env.GOOGLE_VISION_KEY) throw new HttpError(503, 'GOOGLE_VISION_KEY not configured');
  const body = {
    requests: [{
      image: { content: bytesToBase64(bytes) },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['ar'] },
    }],
  };
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(502, `vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const r = (data.responses && data.responses[0]) || {};
  if (r.error) throw new HttpError(502, `vision: ${r.error.message}`);
  return (r.fullTextAnnotation && r.fullTextAnnotation.text) || '';
}

// ---------- Claude verifier ----------
async function verifyWithClaude(bytes, type, candidates, ocrText, env) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'ANTHROPIC_API_KEY not configured');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
  const list = candidates.map((c) => `${c.id}. ${c.q}`).join('\n');
  const userText = `Candidates:\n${list}\n\nOCR hint (may contain errors):\n${(ocrText || '').slice(0, 1500)}\n\nWhich candidate id is the question in the photo?`;
  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;
  const response = await client.beta.messages.create({
    model,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    output_config: { effort: env.CLAUDE_EFFORT || 'low', format: { type: 'json_schema', schema: VERIFY_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: type, data: bytesToBase64(bytes) } },
        { type: 'text', text: userText },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') return { match_id: null, confidence: 'low', reason: 'refused' };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { match_id: null, confidence: 'low', reason: 'unparseable' }; }
  const ids = new Set(candidates.map((c) => c.id));
  const matchId = Number.isInteger(parsed.match_id) && ids.has(parsed.match_id) ? parsed.match_id : null;
  return { match_id: matchId, confidence: matchId && parsed.confidence === 'high' ? 'high' : 'low', reason: String(parsed.reason || '').slice(0, 200), model: response.model };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/api/health') return json({ ok: true, model: env.CLAUDE_MODEL || DEFAULT_MODEL, vision: !!env.GOOGLE_VISION_KEY, claude: !!env.ANTHROPIC_API_KEY }, 200, cors);
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      await checkAccess(req, env, ctx);

      if (url.pathname === '/api/ocr') {
        const { bytes } = await readImage(req);
        const t0 = Date.now();
        const text = await ocr(bytes, env);
        return json({ text, ms: Date.now() - t0 }, 200, cors);
      }
      if (url.pathname === '/api/verify') {
        const { bytes, type, fields } = await readImage(req);
        let candidates;
        try { candidates = JSON.parse(fields.candidates || '[]'); } catch { throw new HttpError(400, 'candidates must be JSON'); }
        candidates = candidates.filter((c) => c && Number.isInteger(c.id) && typeof c.q === 'string').slice(0, 10);
        if (!candidates.length) throw new HttpError(400, 'no candidates');
        const t0 = Date.now();
        const result = await verifyWithClaude(bytes, type, candidates, fields.ocr, env);
        return json({ ...result, ms: Date.now() - t0 }, 200, cors);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || 'error' }, status, cors);
    }
  },
};
