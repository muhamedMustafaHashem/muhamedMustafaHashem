// Local dev server: serves public/ and fakes /api/ocr and /api/verify so the app can be
// tried in a browser without any keys. Run: node tests/mock_server.js [port]
// Mock behaviour: /api/ocr returns the text passed in the "x-mock-ocr" header (or the
// MOCK_OCR env var); /api/verify picks the candidate whose text best matches that OCR text.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const M = require('../public/matcher.js');

const PUB = path.join(__dirname, '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
// Built-in subjects (public/data by default). DATA_DIR=<dir> serves another folder as /data/, DATA_DIR=none serves none.
const DATA_DIR = process.env.DATA_DIR === 'none' ? null : (process.env.DATA_DIR || path.join(PUB, 'data'));
let lastVerify = ''; // raw body of the latest /api/verify request, for the privacy test
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream', '.txt': 'text/plain' };

function readBody(req) { return new Promise((ok) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => ok(Buffer.concat(b))); }); }
function field(body, ct, name) { // minimal multipart text-field parser (test use only)
  const m = /boundary=(.+)$/.exec(ct || ''); if (!m) return '';
  const parts = body.toString('utf8').split('--' + m[1]);
  for (const p of parts) {
    const h = p.indexOf('\r\n\r\n'); if (h < 0) continue;
    if (p.slice(0, h).includes(`name="${name}"`)) return p.slice(h + 4).replace(/\r\n$/, '');
  }
  return '';
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const ocrText = req.headers['x-mock-ocr'] ? decodeURIComponent(req.headers['x-mock-ocr']) : (process.env.MOCK_OCR || '');
    const delay = Number(process.env.MOCK_DELAY || 300);
    await new Promise((r) => setTimeout(r, delay));
    if (url.pathname === '/api/ocr') return send({ text: ocrText, ms: delay });
    if (url.pathname === '/api/_last_verify') return send({ text: lastVerify });
    if (url.pathname === '/api/verify') {
      if (process.env.VERIFY_MODE === 'off') return send({ error: 'photo verification is off (VERIFY_MODE)' }, 503);
      lastVerify = body.toString('utf8');
      const cands = JSON.parse(field(body, req.headers['content-type'], 'candidates') || '[]');
      const hint = field(body, req.headers['content-type'], 'ocr') || ocrText;
      const idx = M.buildIndex(cands.map((c) => ({ id: c.id, q: c.q, a: '' })));
      const ranked = M.rank(idx, hint, 3);
      const best = ranked[0];
      const ok = best && best.score >= 0.6;
      // a real verifier transcribes the photo; the mock pretends it read the picked question exactly
      return send({ match_id: ok ? best.id : null, confidence: best && best.score >= 0.8 ? 'high' : 'low', photo_question: ok ? best.q : hint, reason: 'mock', ms: delay });
    }
    if (url.pathname === '/api/health') return send({ ok: true, mock: true, verify: process.env.VERIFY_MODE === 'off' ? 'off' : 'gemini' });
    return send({ error: 'not found' }, 404);
  }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  let f = path.join(PUB, p);
  if (p.startsWith('/data/')) {
    if (!DATA_DIR) { res.writeHead(404); return res.end('no built-in subjects'); }
    f = path.join(DATA_DIR, p.slice('/data/'.length));
    if (!f.startsWith(DATA_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  } else if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`));
