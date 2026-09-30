/* Service worker: app shell cached on install; question data and OCR assets cached on first use.
 * data/manifest.json is served from cache and refreshed in the background; data/<n>.json?v=<version>
 * files are immutable per version (cache first). Bump CACHE when shipping a new app version. */
const CACHE = 'answer-app-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'matcher.js', 'importer.js', 'store.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/tesseract/tesseract.min.js', 'vendor/read-excel-file.min.js',
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

  // manifest: serve the cached copy instantly, refresh in the background
  if (url.pathname.endsWith('/data/manifest.json')) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(req);
        const network = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
        return cached || network || Response.error();
      })
    );
    return;
  }
  // subject files: the URL carries the content version, so a cached copy is always right for it;
  // offline with a newer manifest, fall back to any cached version of the same file
  if (/\/data\/\d+\.json$/.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const cached = await c.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) c.put(req, res.clone());
          return res;
        } catch (err) {
          return (await c.match(req, { ignoreSearch: true })) || Response.error();
        }
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
