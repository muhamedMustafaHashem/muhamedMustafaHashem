/* Service worker: app shell cached on install, questions.json and OCR assets cached on first use.
 * Bump CACHE when shipping a new app version; questions.json is refreshed in the background. */
const CACHE = 'answer-app-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'matcher.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/tesseract/tesseract.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // never cache API calls

  // questions.json: serve cached copy instantly, refresh in the background
  if (url.pathname.endsWith('questions.json')) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(req);
        const network = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
        return cached || network || Response.error();
      })
    );
    return;
  }

  // everything else (shell, vendor, language model): cache first, then network
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
