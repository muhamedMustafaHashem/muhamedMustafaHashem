# إجابة بالصورة — Photo → Answer

A tiny installable web app (PWA): photograph an Arabic exam question, get the correct answer from your
own Excel question bank. Works on iPhone (Safari) and Android (Chrome), shared as one link on WhatsApp.

```
photo ──► local OCR (Tesseract, on the phone)  ─┐
      └─► Google Vision OCR (cloud)             ─┴─► match against questions.json ──► confident? ──► answer ✓
                                                                  │ not confident
                                                                  ▼
                                   photo + top 10 candidates ──► Claude verifier ──► confident? ──► answer ✓
                                                                                         │ no
                                                                                         ▼
                                                                                  top 3 candidates (tap to reveal)
```

The app never shows a single answer as correct unless one of the tiers passes the confidence rule.
The OCR mode switch on the main screen (تلقائي / محلي / جوجل) chooses which OCR tiers run.

## Layout

| Path | What |
|---|---|
| `public/` | The PWA: `index.html`, `app.js` (flow + UI), `matcher.js` (normalization, ranking, confidence rule), `sw.js`, `manifest.json`, `config.js`, icons, vendored Tesseract.js and the Arabic model |
| `public/questions.json` | Generated from your Excel files. **Currently the small sample set** until you provide the real sheets |
| `tools/build_data.py` | Excel → `questions.json` with Arabic normalization and a quality report |
| `worker/` | Cloudflare Worker: `/api/ocr` (Google Vision) and `/api/verify` (Claude). Also serves `public/` |
| `tests/` | Matcher unit test, Python/JS normalization parity test, browser end-to-end test, golden-set runner |
| `data/source/` | Put your `.xlsx` files here (git-ignored) |

## 1. Build the question bank

```bash
pip install openpyxl
cp /path/to/your/*.xlsx data/source/
python3 tools/build_data.py            # writes public/questions.json and data/build_report.txt
```

The script reads every sheet of every workbook, finds the question and answer columns by header
(`السؤال`, `الإجابة`, `Question`, `Answer`, …; force with `--q-col` / `--a-col`), resolves
multiple-choice answers given as a letter (أ/ب/ج/د or A/B/C/D) to the option text when option columns
exist, merges exact duplicates, and **refuses to build if the same question has two different answers**
(fix the sheet, or `--allow-conflicts`). Read `data/build_report.txt`: near-duplicate questions listed
there are the main cause of wrong answers, so clean them up in Excel and rebuild.

## 2. Keys and accounts (one-time)

1. **Google Cloud Vision** (cloud OCR, first 1,000 images per month free, then about USD 1.50 per 1,000):
   create a project at console.cloud.google.com → enable "Cloud Vision API" → Credentials → Create API key
   → restrict it to the Cloud Vision API.
2. **Anthropic API key** (verifier): console.anthropic.com → API keys. About USD 0.01 per verification
   with the default model; set `CLAUDE_MODEL = "claude-haiku-4-5"` in `worker/wrangler.toml` for a
   cheaper, slightly faster verifier.
3. **Cloudflare account** (free): hosts both the app and the API.

## 3. Deploy

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put GOOGLE_VISION_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_TOKEN          # any long random string; put the same value in public/config.js
npx wrangler deploy                        # prints https://answer-app.<your-subdomain>.workers.dev
```

Every later change (new questions, tuning) is just `python3 tools/build_data.py` then `npx wrangler deploy`.
Users get the new data the next time they open the app.

## 4. Share on WhatsApp

Send the link with this note:

> افتح الرابط في المتصفح، ثم اضغط **مشاركة → إضافة إلى الشاشة الرئيسية** (آيفون) أو **⋮ → تثبيت التطبيق** (أندرويد).

iPhone cannot install an app file from WhatsApp; the link plus "Add to Home Screen" is the supported
route on both platforms and gives a home-screen icon that opens full screen and offline.

## Confidence rule

Every OCR result is normalized (diacritics, hamza forms, ة/ه, ى/ي, punctuation, numbering) and scored
against each question: half unigram coverage, half ordered-bigram coverage, tolerant to one or two
character errors per word and to words glued together by OCR. A result is **confident** only when

- the top question scores ≥ 0.92, and
- no other question scores ≥ 0.92, and
- the top leads the runner-up by ≥ 0.10.

Otherwise the photo and the top 10 candidates go to the Claude verifier, which must return
`confidence: "high"` for an id that is also in the local top 3. Thresholds live in `public/config.js`;
tune them on the golden set, then freeze them.

## Tests

```bash
node tests/matcher.test.js                 # ranking + confidence rule on noisy variants (uses tests/sample.questions.json)
python3 tests/normalize_parity.py          # Python and JS normalization agree
NODE_PATH=$(npm root -g) node tests/e2e.js # browser test: renders questions, runs real Tesseract + mock API
```

**Golden set (acceptance test before shipping):** put 100 real phone photos in `tests/golden/` and list
them in `tests/golden/labels.csv` as `filename,expected_id`. Then:

```bash
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode auto
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode local
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode google
```

Targets: **0 wrong confident answers**, ≥ 95 % of photos get a confident answer, median time under 1.5 s.

## Local development

```bash
node tests/mock_server.js 8080     # serves public/ with fake /api/ocr and /api/verify (no keys needed)
# or, with real keys in worker/.dev.vars:
cd worker && npx wrangler dev
```

Enable "عرض النص المقروء" in the app settings to see the raw OCR text under each result.
