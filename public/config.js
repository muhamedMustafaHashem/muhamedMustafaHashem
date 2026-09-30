// App configuration. Safe to ship: no secrets here.
window.APP_CONFIG = {
  // Base URL of the API (Cloudflare Worker). Empty string = same origin (/api/...).
  apiBase: '',
  // Public app token sent with every API call; the Worker rejects requests without it.
  // It only stops casual abuse; the real secrets stay in the Worker.
  appToken: 'change-me',
  // Cloud OCR timeout before we stop waiting and go to the verifier.
  cloudOcrTimeoutMs: 4000,
  verifyTimeoutMs: 12000,
  // Confidence rule (tune on the golden set, then freeze).
  // confident = top >= score AND no other candidate >= score AND top - second >= lead
  thresholds: { score: 0.92, lead: 0.10, min: 0.30 },
  // Longest image side sent to OCR / verifier.
  maxImageSide: 1600,
  jpegQuality: 0.8,
  // Local OCR assets (same origin, cached by the service worker).
  tesseract: {
    workerPath: 'vendor/tesseract/worker.min.js',
    corePath: 'vendor/tesseract',
    langPath: 'vendor/lang',
    lang: 'ara',
    psm: 3,             // page segmentation: 3 = automatic
    sides: [1000, 700], // local OCR runs on a copy this many px wide; retries smaller if it reads < 3 words
  },
};
