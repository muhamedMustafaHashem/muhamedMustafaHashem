// Worker tests: the Gemini requests the Worker builds, how it reads replies, how it retries when Gemini
// rejects an optional setting, cost estimates, and access control. Gemini is stubbed (no network, no key).
// Run: node tests/worker.test.mjs
import worker from '../worker/index.js';

let fails = 0;
const check = (cond, msg, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg + (extra && !cond ? '  ' + extra : '')); if (!cond) fails++; };

const realFetch = globalThis.fetch;
let calls = [];
let script = []; // queue of {status, body} replies, consumed in order; the last one repeats
function stub() {
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init && init.headers, body });
    const r = script.length > 1 ? script.shift() : script[0];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
}
const reply = (text, usage) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage || { promptTokenCount: 1800, candidatesTokenCount: 60 } });

const ENV = { GEMINI_API_KEY: 'k', APP_TOKEN: 't' };
const CANDS = [{ id: 100001, q: 'ما هي عاصمة فرنسا؟' }, { id: 100002, q: 'ما هي عاصمة مصر؟' }];
function verifyReq(extra = {}, token = 't') {
  const fd = new FormData();
  fd.append('image', new Blob([new Uint8Array([255, 216, 255, 224, 1, 2, 3])], { type: 'image/jpeg' }), 'q.jpg');
  fd.append('candidates', JSON.stringify(CANDS));
  fd.append('ocr', 'ما هي عاصمه فرنسا');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return new Request('http://app/api/verify', { method: 'POST', body: fd, headers: token ? { 'x-app-token': token } : {} });
}
async function call(req, env = ENV) { const r = await worker.fetch(req, env); return { status: r.status, json: await r.json() }; }

// 1. verify: request shape
stub(); calls = []; script = [{ body: reply('{"photo_question":"ما هي عاصمة فرنسا؟","match_id":100001,"confidence":"high","reason":"same"}') }];
let r = await call(verifyReq());
const c0 = calls[0];
check(r.status === 200 && r.json.match_id === 100001 && r.json.confidence === 'high' && r.json.photo_question === 'ما هي عاصمة فرنسا؟', 'verify returns the matched id, confidence and transcription');
check(c0.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', 'calls the default Flash-Lite model', c0.url);
check(c0.headers['x-goog-api-key'] === 'k', 'sends the key in the x-goog-api-key header, not in the URL');
const gc = c0.body.generationConfig;
check(gc.responseMimeType === 'application/json' && gc.responseSchema && gc.responseSchema.required.includes('match_id') && gc.temperature === 0, 'asks for schema-shaped JSON at temperature 0');
check(JSON.stringify(gc.thinkingConfig) === '{"thinkingLevel":"low"}', 'Gemini 3.x: thinking level low (thinking tokens are billed)', JSON.stringify(gc.thinkingConfig));
const parts = c0.body.contents[0].parts;
check(parts[0].inline_data.mime_type === 'image/jpeg' && parts[0].inline_data.data.length > 0, 'the photo is sent as inline base64');
check(parts[1].text.includes('100001. ما هي عاصمة فرنسا؟') && c0.body.systemInstruction.parts[0].text.includes('closed list'), 'candidate questions and the instructions are sent');
check(!JSON.stringify(c0.body).includes('باريس'), 'no answer text is in the request');
check(r.json.usage.input_tokens === 1800 && r.json.usage.output_tokens === 60 && r.json.cost_usd === 0.00054, 'usage and cost estimate are returned', JSON.stringify([r.json.usage, r.json.cost_usd]));

// 2. verify: safety of the reply
script = [{ body: reply('{"photo_question":"x","match_id":999,"confidence":"high","reason":"?"}') }];
r = await call(verifyReq());
check(r.json.match_id === null && r.json.confidence === 'low', 'an id that is not among the candidates is discarded');
script = [{ body: reply('{"photo_question":"x","match_id":null,"confidence":"high","reason":"?"}') }];
r = await call(verifyReq());
check(r.json.match_id === null && r.json.confidence === 'low', '"high" without a match is downgraded to low');
script = [{ body: reply('Sure! {"photo_question":"x","match_id":100002,"confidence":"high","reason":"ok"} done') }];
r = await call(verifyReq());
check(r.json.match_id === 100002, 'JSON wrapped in other words is still read');
script = [{ body: reply('not json at all') }];
r = await call(verifyReq());
check(r.json.match_id === null && r.json.reason === 'unparseable', 'an unreadable reply is low confidence, never a match');
script = [{ body: { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: {} } }];
r = await call(verifyReq());
check(r.json.match_id === null && r.json.reason.startsWith('blocked'), 'a blocked reply is low confidence');

// 3. retries when Gemini rejects an optional setting
script = [{ status: 400, body: 'Unknown name "thinkingConfig"' }, { body: reply('{"photo_question":"a","match_id":100001,"confidence":"high","reason":"r"}') }];
calls = []; r = await call(verifyReq());
check(calls.length === 2 && !('thinkingConfig' in calls[1].body.generationConfig) && r.json.match_id === 100001, '400 on the thinking setting: retried without it');
script = [{ status: 400, body: 'bad thinking' }, { status: 400, body: 'bad schema' }, { body: reply('{"photo_question":"a","match_id":100002,"confidence":"low","reason":"r"}') }];
calls = []; r = await call(verifyReq());
check(calls.length === 3 && !('responseSchema' in calls[2].body.generationConfig) && r.json.match_id === 100002, '400 on the schema: retried with plain JSON mode');
script = [{ status: 400, body: 'nope' }];
calls = []; r = await call(verifyReq());
check(r.status === 502 && r.json.error.includes('rejected') && calls.length === 4, 'if every variant is rejected, a clear 502 is returned');
script = [{ status: 404, body: 'models/x is not found' }];
r = await call(verifyReq());
check(r.status === 502 && r.json.error.includes('GEMINI_MODEL'), 'unknown model name: the error says to set GEMINI_MODEL');

// 4. model-specific settings
script = [{ body: reply('{"photo_question":"a","match_id":100001,"confidence":"high","reason":"r"}') }]; calls = [];
await call(verifyReq(), { ...ENV, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
check(calls[0].url.includes('gemini-2.5-flash-lite:') && JSON.stringify(calls[0].body.generationConfig.thinkingConfig) === '{"thinkingBudget":0}', 'Gemini 2.x models get a zero thinking budget');
calls = []; r = await call(verifyReq(), { ...ENV, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
check(r.json.cost_usd === 0.000204, '2.5 Flash-Lite cost estimate', String(r.json.cost_usd));
calls = []; r = await call(verifyReq(), { ...ENV, GEMINI_MODEL: 'some-future-model', PRICE_IN: '1', PRICE_OUT: '2' });
check(r.json.cost_usd === 0.00192, 'PRICE_IN / PRICE_OUT override the price list', String(r.json.cost_usd));
calls = []; r = await call(verifyReq(), { ...ENV, GEMINI_MODEL: 'some-future-model' });
check(r.json.cost_usd === null, 'unknown model without prices: cost is null, not a guess');
calls = []; await call(verifyReq(), { ...ENV, GEMINI_THINKING: 'default' });
check(!('thinkingConfig' in calls[0].body.generationConfig), 'GEMINI_THINKING=default sends no thinking setting');

// 5. OCR
function ocrReq(token = 't') {
  const fd = new FormData(); fd.append('image', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'q.png');
  return new Request('http://app/api/ocr', { method: 'POST', body: fd, headers: token ? { 'x-app-token': token } : {} });
}
script = [{ body: reply('  7- ما هي عاصمة فرنسا؟\nأ) لندن  ') }]; calls = [];
r = await call(ocrReq());
check(r.status === 200 && r.json.text === '7- ما هي عاصمة فرنسا؟\nأ) لندن', 'OCR via Gemini returns the transcription');
const oc = calls[0].body;
check(!oc.generationConfig.responseMimeType && oc.contents[0].parts[0].inline_data.mime_type === 'image/png' && oc.contents[0].parts[1].text.includes('Arabic'), 'OCR asks for plain text with an Arabic transcription prompt');
calls = [];
script = [{ body: { responses: [{ fullTextAnnotation: { text: 'نص من فيجن' } }] } }];
r = await call(ocrReq(), { ...ENV, OCR_PROVIDER: 'vision', GOOGLE_VISION_KEY: 'v' });
check(r.json.text === 'نص من فيجن' && calls[0].url.startsWith('https://vision.googleapis.com/'), 'OCR_PROVIDER=vision still uses Cloud Vision');

// 6. selftest, health, access control
script = [{ body: reply('{"ok": true}', { promptTokenCount: 12, candidatesTokenCount: 6 }) }]; calls = [];
r = await call(new Request('http://app/api/selftest', { method: 'POST', headers: { 'x-app-token': 't' } }));
check(r.status === 200 && r.json.ok === true && r.json.model === 'gemini-3.1-flash-lite' && r.json.usage.input_tokens === 12, 'selftest confirms the key and model with a tiny request');
r = await call(new Request('http://app/api/health'));
check(r.json.ok && r.json.model === 'gemini-3.1-flash-lite' && r.json.gemini === true, 'health reports the model');
r = await call(verifyReq({}, null));
check(r.status === 401, 'a missing app token is rejected');
r = await call(verifyReq({}, 'wrong'));
check(r.status === 401, 'a wrong app token is rejected');
r = await call(verifyReq(), { APP_TOKEN: 't' });
check(r.status === 503 && r.json.error.includes('GEMINI_API_KEY'), 'no key configured: a clear 503');
const big = new FormData(); big.append('image', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/jpeg' }), 'q.jpg'); big.append('candidates', '[]');
r = await call(new Request('http://app/api/verify', { method: 'POST', body: big, headers: { 'x-app-token': 't' } }));
check(r.status === 413, 'an image over 2 MB is rejected');
r = await call(verifyReq({ candidates: '[]' }));
check(r.status === 400, 'no candidates is a 400');
let limited = 0;
r = await call(verifyReq(), { ...ENV, RATE_LIMITER: { limit: async () => { limited++; return { success: false }; } } });
check(r.status === 429 && limited === 1, 'the rate limiter is applied');

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
