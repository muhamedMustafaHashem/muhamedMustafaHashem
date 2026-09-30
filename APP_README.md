# إجابة بالصورة — Photo → Answer

A tiny installable web app (PWA): photograph an Arabic exam question, get the correct answer from a
question bank **each user uploads as Excel files, one file per subject**. Works on iPhone (Safari) and
Android (Chrome), shared as one link on WhatsApp. You (the owner) never handle the Excel files.

```
upload Excel files (once, on the phone) ──► one subject per file, kept on the phone (IndexedDB)

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

## Uploading Excel files (done by each user, in the app)

A new user opens the link and sees **ابدأ برفع ملفات الأسئلة**. Tapping **＋ رفع ملفات Excel** opens the
phone's file picker (Files, iCloud Drive, Downloads, or a file saved from WhatsApp); several files can be
chosen at once.

- **One file = one subject**, named after the file (`الفيزياء.xlsx` → "الفيزياء"; editable in the preview).
  All sheets of a file are merged into its subject.
- **Format:** two columns, **السؤال** and **الإجابة** (also `Question` / `Answer`, `الجواب`, `الاجابة`, …).
  A title row above the headers is fine. Multiple-choice files with option columns أ ب ج د and an answer
  letter (أ, B, 3, ج) show the text of the chosen option. Supported files: `.xlsx`, `.xlsm`, `.csv`
  (UTF-8 or Windows-1256). An old `.xls` file is refused with the instruction to save it as `.xlsx`.
- **Preview before saving:** the user sees the subject name, the number of questions, three sample
  question/answer pairs and the columns the app chose, with dropdowns to correct them. If the headers
  cannot be recognised, the column selector opens and saving is blocked until the user picks the answer
  column.
- **Warnings shown in the preview:** questions skipped for an empty answer, exact duplicates merged, very
  similar questions, and **a question that appears twice with different answers**. Both copies are kept
  and such a question is never shown as a confirmed answer.
- **Same name again = update.** Uploading a file whose name matches an existing subject replaces it
  (the preview says so). **إدارة المواد** lets the user rename, update from a new file, or delete a subject.
- **Where the data lives:** in the browser's IndexedDB on that phone only. It works offline afterwards.
  Only the photo and the *text of the candidate questions* are sent to the server for verification;
  **answers are never sent** (`tests/e2e.js` checks this). Users should add the app to the Home Screen:
  Safari can clear the data of sites that are not used for a long time, the app asks the browser to keep
  it, and if it is ever cleared the user simply uploads the files again.
- Built-in subjects (optional, section 1 below) can be shipped with the app as well; uploaded subjects
  appear next to them.

## Subjects and typed search

- The picker on the home screen lists the subjects ("الفيزياء (412)") plus "كل المواد". Searching inside
  one subject is more accurate (fewer look-alike questions) and faster. The first launch asks for a
  subject; the choice is remembered.
- **Built-in subjects only:** a link like `https://<your-app>/?subject=2` opens with subject 2 selected
  (`?subject=all` for all subjects); numbers are in `data/subjects.json`. Uploaded subjects are numbered
  per phone (from 1001), so their links are not shareable.
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
| `public/` | The PWA: `index.html`, `app.js` (flow + UI), `matcher.js` (normalization, ranking, typed search, confidence rule), `importer.js` (Excel/CSV → questions, on the phone), `store.js` (IndexedDB), `sw.js`, `manifest.json`, `config.js`, icons, vendored Tesseract.js + Arabic model and read-excel-file (MIT) |
| `public/data/` | **Optional** built-in subjects generated by `tools/build_data.py` (absent by default: users upload their own) |
| `tools/build_data.py` | Optional: Excel files → built-in per-subject JSON, same reading rules as the in-app importer |
| `worker/` | Cloudflare Worker: `/api/ocr` (Google Vision) and `/api/verify` (Claude). Also serves `public/` |
| `tests/` | Unit, import, build, browser and golden-set tests; `tests/sample_subjects/` sample workbooks, `tests/sample_bundled/` sample built-in data |

## 1. Optional: ship built-in subjects

Not needed when users upload their own files. Use it only if you want some subjects to come with the app for
everyone.

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

App changes are just `npx wrangler deploy` again. Users' uploaded questions live on their phones and are
not touched by a deploy.

## 4. Share on WhatsApp

Send the link with this note:

> 1) افتح الرابط في المتصفح ثم اضغط **مشاركة ← إضافة إلى الشاشة الرئيسية** (آيفون) أو **⋮ ← تثبيت التطبيق** (أندرويد).
> 2) افتح التطبيق واضغط **＋ رفع ملفات Excel** واختر ملف كل مادة (عمودان: السؤال والإجابة).
> 3) اختر المادة ثم صوّر السؤال، أو اكتبه.

iPhone cannot install an app file from WhatsApp; the link plus "Add to Home Screen" is the supported
route on both platforms and gives a home-screen icon that opens full screen and offline. Installing to
the Home Screen also protects the uploaded questions from being cleared by Safari.

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
node tests/importer.test.js                # in-app Excel/CSV reader: layouts, MCQ, conflicts, CSV encodings, errors, parity with build_data.py
python3 tests/build_subjects_test.py       # optional built-in build: ids, stable numbers, conflicts, stale data
python3 tests/normalize_parity.py          # Python and JS normalization agree
NODE_PATH=$(npm root -g) node tests/e2e.js # browser test (real Tesseract + mock API): photo flow, subjects and typed search with built-in
                                           # AND uploaded data, upload dialog, replace/rename/delete, persistence, privacy of what is sent
```

**Golden set (acceptance test before shipping):** put about 100 real phone photos in `tests/golden/` and
list them in `tests/golden/labels.csv` as `filename,SubjectName#position` (for example
`IMG_0007.jpg,الفيزياء#17`; the position is the `#17` shown next to a question when "عرض النص المقروء
(للتشخيص)" is on in the app settings). The runner uploads the Excel files you give it through the app's
own upload dialog, then selects each photo's subject, like a real user:

```bash
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --excel ./my-excel-files --mode auto
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --excel ./my-excel-files --mode local
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --excel ./my-excel-files --mode google
node tests/golden_run.js --url https://answer-app.<you>.workers.dev --excel ./my-excel-files --mode auto --subject all   # worst case
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
