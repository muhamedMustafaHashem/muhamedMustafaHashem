# إجابة بالصورة — Photo → Answer

A tiny installable web app (PWA): photograph an Arabic exam question, get the correct answer from your
own Excel question bank. Works on iPhone (Safari) and Android (Chrome), shared as one link on WhatsApp.

```
pick the subject ──► photo ──► local OCR (Tesseract, on the phone)  ─┐
                          └─► Google Vision OCR (cloud)             ─┴─► rank against that subject's questions
                                                                            │
                                            photo + top 10 candidates ──► Claude verifier ──► confirmed? ──► answer ✓
                                                                                                   │ no
                                                                                                   ▼
                                                     top 3 candidates (tap to reveal) · "search all subjects" · "edit text"

or type the question ──► instant local search in the chosen subject (works offline)
```

The app never shows a single answer as correct from a photo unless the photo verifier confirms it (see
Confidence rule). The OCR mode switch (تلقائي / محلي / جوجل) chooses which OCR tiers run.

## Subjects and typed search

- **One Excel file = one subject.** The picker on the home screen lists them ("الفيزياء (412)") plus
  "كل المواد". Searching inside one subject is more accurate (fewer look-alike questions) and faster.
  The first launch asks for a subject; the choice is remembered. With a single subject the picker is hidden.
- **Share one link per subject** on WhatsApp: `https://<your-app>/?subject=2` opens with subject 2 selected
  (`?subject=all` for all subjects). Numbers are in `data/subjects.json`.
- **Wrong subject?** If a photo is not found in the chosen subject, the result offers **ابحث في كل المواد**,
  which re-ranks the text already read and verifies against the photo again (same accuracy rules).
- **Same question in two subjects with different answers** is never shown green in "كل المواد"; both
  entries are listed with their subject names. Identical question and answer in two subjects is merged.
- **Typed search** (box under the camera button): type any part of the question, even half a word, in any
  word order. Results highlight the matched words. "✓ مطابق" appears only for a full, unambiguous match;
  otherwise the list is "نتائج مقترحة". It needs no internet and no API key. Under any unverified photo
  result, **عدّل النص وابحث** copies the OCR text into this box so you can fix a word and search.

## Layout

| Path | What |
|---|---|
| `public/` | The PWA: `index.html`, `app.js` (flow + UI), `matcher.js` (normalization, ranking, typed search, confidence rule), `sw.js`, `manifest.json`, `config.js`, icons, vendored Tesseract.js and the Arabic model |
| `public/data/` | Generated from your Excel files: `manifest.json` and one `<number>.json` per subject. **Currently a two-subject sample** until you provide the real sheets |
| `tools/build_data.py` | Excel files → per-subject JSON with Arabic normalization and a quality report |
| `data/subjects.json` | Created by the first build: permanent number and display name per Excel file (commit it) |
| `worker/` | Cloudflare Worker: `/api/ocr` (Google Vision) and `/api/verify` (Claude). Also serves `public/` |
| `tests/` | Unit, build, browser and golden-set tests; `tests/sample_subjects/` holds the sample workbooks |
| `data/source/` | Put your `.xlsx` files here (git-ignored) |

## 1. Build the question bank

```bash
pip install openpyxl
cp /path/to/subject-files/*.xlsx data/source/     # one file per subject, e.g. الفيزياء.xlsx
python3 tools/build_data.py                        # writes public/data/*, data/subjects.json, data/build_report.txt
```

Each file becomes one subject named after the file (edit `name` in `data/subjects.json` to rename; reorder
the entries there to reorder the picker). All sheets of a file are merged into its subject. Every subject
gets a permanent number the first time it is built, and question ids are `number * 100000 + row`, so ids
stay valid when you add subjects later (removing a file keeps its number reserved).

The script finds the question and answer columns by header (`السؤال`, `الإجابة`, `Question`, `Answer`, …;
force with `--q-col` / `--a-col`), resolves multiple-choice answers given as a letter (أ/ب/ج/د or A/B/C/D)
to the option text when option columns exist, merges exact duplicates, and **refuses to build if the same
question has two different answers inside one subject** (fix the sheet, or `--allow-conflicts`). The
same question in two different subjects is allowed and only reported. Read `data/build_report.txt`:
near-duplicate questions listed there are the main cause of wrong answers, so clean them up in Excel and rebuild.

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

## Confidence rule (accuracy first, speed second)

OCR only produces the candidate list. Every OCR read is normalized (diacritics, hamza forms, ة/ه, ى/ي,
punctuation, numbering) and scored against each question: half unigram coverage, half ordered-bigram
coverage, tolerant to one or two character errors per word and to words glued together by OCR. Local
and Google readings are merged (union of their top 10), so a word one engine misread does not drop the
right question.

A green **مؤكد** answer is shown only when all of these hold:

1. the Claude verifier, looking at the photo itself, picks a candidate with `confidence: "high"`;
2. that candidate is in the OCR top 3;
3. the verifier's own transcription of the question in the photo ranks that same question first with a
   match score ≥ 0.85 (`verify.transcriptionMinScore` in `public/config.js`).

Anything else is orange: either the top 3 candidates with answers hidden until tapped (verifier said
no), or, when the verifier cannot run at all (offline, API down), the most likely question marked
**الأرجح · غير مؤكد** with its answer visible so the user can judge for themselves.

Speed comes second but is not ignored: verification starts as soon as a trustworthy candidate list
exists (a confident OCR read, or Google's read), so the typical online path is Google OCR ≈ 1 s plus
the verifier ≈ 1.5 to 2 s. `fastPath: true` in `config.js` re-enables the shortcut "local and Google
OCR both confident on the same question → answer without the verifier"; keep it off unless the golden
set proves it never misfires.

## Tests

```bash
node tests/matcher.test.js                 # ranking + confidence rule on noisy variants (uses tests/sample.questions.json)
node tests/search.test.js                  # typed search, twins and cross-subject rules on the two sample subjects
python3 tests/build_subjects_test.py       # per-subject build: ids, stable numbers, conflicts, stale data
python3 tests/normalize_parity.py          # Python and JS normalization agree
NODE_PATH=$(npm root -g) node tests/e2e.js # browser test: photo flow, subjects, typed search (real Tesseract + mock API)
```

**Golden set (acceptance test before shipping):** put 100 real phone photos in `tests/golden/` and list
them in `tests/golden/labels.csv` as `filename,expected_id` (the id comes from `public/data/<n>.json`; it
also names the subject, which the runner selects before each photo, like a real user). Then:

```bash
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode auto
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode local
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode google
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --mode auto --subject all   # worst case
```

The summary is printed overall and per subject. Targets: **0 wrong confident answers** in every run
(including `--subject all`), ≥ 95 % of photos get a confident answer with the subject selected, median
time under 3 s.

## Local development

```bash
node tests/mock_server.js 8080     # serves public/ with fake /api/ocr and /api/verify (no keys needed)
# or, with real keys in worker/.dev.vars:
cd worker && npx wrangler dev
```

Enable "عرض النص المقروء" in the app settings to see the raw OCR text under each result.
