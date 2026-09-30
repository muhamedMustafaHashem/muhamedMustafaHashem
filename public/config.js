// App configuration. Safe to ship: no secrets here.
window.APP_CONFIG = {
  // Base URL of the API (Cloudflare Worker). Empty string = same origin (/api/...).
  apiBase: '',
  // Public app token sent with every API call; the Worker rejects requests without it.
  // It only stops casual abuse; the real secrets stay in the Worker.
  appToken: 'change-me',
  // Cloud OCR timeout before we stop waiting and go to the verifier.
  cloudOcrTimeoutMs: 6000,
  verifyTimeoutMs: 12000,
  // The verifier gets a copy of the photo with this longest side (pixels); the model's price depends on image size.
  verifyImageSide: 1280,
  // Accuracy first: a green answer always needs the photo verifier (Gemini) to agree.
  verify: {
    // the verifier's own transcription of the photo must rank the chosen question first with this score
    requireTranscription: true,
    transcriptionMinScore: 0.85,
  },
  // Optional speed shortcut, OFF: accept without the verifier when local AND Google OCR are both
  // confident on the same question. Turn on only after the golden set shows it never misfires.
  fastPath: false,
  // OCR match rule used to rank candidates and to judge an OCR read "confident".
  // confident = top >= score AND no other candidate >= score AND top - second >= lead
  thresholds: { score: 0.92, lead: 0.10, min: 0.30 },
  // Typed search box.
  search: { minChars: 2, debounceMs: 150, maxResults: 8 },
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
    sides: [1000, 800, 700, 1300], // local OCR tries these widths in turn and keeps the best-matching read; stops early when confident
  },
};
