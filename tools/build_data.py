#!/usr/bin/env python3
"""Build the per-subject question bank in public/data/ from the Excel files in data/source/.

One Excel file = one subject (all its sheets are merged). The subject's display name is the
file name without extension; edit `name` in data/subjects.json to change it. Each file gets a
permanent number in that registry, and question ids are number * 100000 + row sequence, so ids
stay unique across subjects and stable when files are added later.

Output:
    public/data/manifest.json    {version, subjects: [{number, name, count, file, version}]}
    public/data/<number>.json    {number, name, version, count, items: [{id, q, a, n}]}

Usage:
    python3 tools/build_data.py                    # all .xlsx/.xlsm in data/source/
    python3 tools/build_data.py a.xlsx b.xlsx      # specific files
    python3 tools/build_data.py --q-col "السؤال" --a-col "الإجابة"   # force columns
    python3 tools/build_data.py --allow-conflicts  # ship even if one subject has a question with 2 answers

The Arabic normalization here MUST stay identical to normalize() in
public/matcher.js. tests/normalize_parity.py checks that.
"""
import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("openpyxl missing: pip install openpyxl")

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "data" / "source"
OUT_DIR = ROOT / "public" / "data"
REGISTRY_FILE = ROOT / "data" / "subjects.json"
REPORT_FILE = ROOT / "data" / "build_report.txt"
ID_STRIDE = 100000  # question id = subject number * ID_STRIDE + row sequence

# ---------------------------------------------------------------------------
# Normalization (keep in sync with public/matcher.js)
# ---------------------------------------------------------------------------
_TASHKEEL = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_LETTER_MAP = str.maketrans({
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
    "ة": "ه", "ى": "ي", "ؤ": "و", "ئ": "ي", "ک": "ك", "ی": "ي",
})
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_LEADING_NUMBER = re.compile(r"^\s*(?:س|q|question)?\s*\d{1,4}\s*[-.)/:]*\s*", re.IGNORECASE)
_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Lowercase, strip diacritics/punctuation, unify letters, collapse spaces."""
    if text is None:
        return ""
    t = unicodedata.normalize("NFKC", str(text))
    t = t.translate(_ARABIC_DIGITS)
    t = _TASHKEEL.sub("", t)
    t = t.translate(_LETTER_MAP)
    t = t.lower()
    t = _LEADING_NUMBER.sub("", t)
    t = _NON_WORD.sub(" ", t)
    t = t.replace("_", " ")
    return _WS.sub(" ", t).strip()


def tokens(norm: str):
    return [w for w in norm.split(" ") if w]


def word_bigrams(toks):
    if len(toks) < 2:
        return set(toks)
    return {toks[i] + " " + toks[i + 1] for i in range(len(toks) - 1)}


def dice(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


# ---------------------------------------------------------------------------
# Column detection
# ---------------------------------------------------------------------------
Q_HEADERS = re.compile(r"(سؤال|السؤال|الاسئله|الأسئلة|question|^q$|^q\d*$)", re.IGNORECASE)
A_HEADERS = re.compile(r"(اجابه|الاجابه|إجابة|الإجابة|جواب|الجواب|الصحيح|answer|^a$|^ans$|correct)", re.IGNORECASE)
OPT_HEADERS = {
    "ا": ["أ", "ا", "a", "option a", "option 1", "الاختيار الأول", "اختيار 1", "1"],
    "ب": ["ب", "b", "option b", "option 2", "الاختيار الثاني", "اختيار 2", "2"],
    "ج": ["ج", "c", "option c", "option 3", "الاختيار الثالث", "اختيار 3", "3"],
    "د": ["د", "d", "option d", "option 4", "الاختيار الرابع", "اختيار 4", "4"],
}
OPT_LOOKUP = {normalize(h): key for key, hs in OPT_HEADERS.items() for h in hs}
OPT_DISPLAY = {"ا": "أ", "ب": "ب", "ج": "ج", "د": "د"}
LETTER_ANSWER = {
    "ا": "ا", "أ": "ا", "a": "ا", "1": "ا",
    "ب": "ب", "b": "ب", "2": "ب",
    "ج": "ج", "c": "ج", "3": "ج",
    "د": "د", "d": "د", "4": "د",
}


def cell_str(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def detect_columns(header_row, q_override=None, a_override=None):
    """Return (q_idx, a_idx, {letter: idx}) or None if no question column found."""
    headers = [cell_str(h) for h in header_row]
    q_idx = a_idx = None
    opts = {}
    for i, h in enumerate(headers):
        if not h:
            continue
        hn = normalize(h)
        if q_override and hn == normalize(q_override):
            q_idx = i
        elif a_override and hn == normalize(a_override):
            a_idx = i
        elif not q_override and q_idx is None and Q_HEADERS.search(h):
            q_idx = i
        elif not a_override and a_idx is None and A_HEADERS.search(h):
            a_idx = i
        elif hn in OPT_LOOKUP:
            opts[OPT_LOOKUP[hn]] = i
    if q_idx is None:
        return None
    return q_idx, a_idx, opts


def read_sheet(ws, args, report):
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    # find the header row within the first 10 rows
    header_at = None
    cols = None
    for r in range(min(10, len(rows))):
        cols = detect_columns(rows[r], args.q_col, args.a_col)
        if cols:
            header_at = r
            break
    if cols is None:
        # fallback: first two text columns, no header
        report.append(f"  ! no header found, using first two text columns")
        first = rows[0]
        text_cols = [i for i, v in enumerate(first) if isinstance(v, str) and v.strip()]
        if len(text_cols) < 2:
            report.append("  ! skipped: fewer than two text columns")
            return []
        cols = (text_cols[0], text_cols[1], {})
        header_at = -1
    q_idx, a_idx, opts = cols
    if a_idx is None:
        report.append("  ! no answer column detected; rows will be skipped")
        return []
    report.append(f"  header row {header_at + 1}: question col {q_idx + 1}, answer col {a_idx + 1}"
                  + (f", options {sorted(opts)}" if opts else ""))

    items = []
    for r in rows[header_at + 1:]:
        q = cell_str(r[q_idx]) if q_idx < len(r) else ""
        a = cell_str(r[a_idx]) if a_idx < len(r) else ""
        if not q:
            continue
        if opts:
            # light normalization only: the leading-number rule would erase "3"
            letter = a.translate(_ARABIC_DIGITS).translate(_LETTER_MAP).lower().strip(" .)-(")
            key = LETTER_ANSWER.get(letter)
            if key and key in opts and opts[key] < len(r):
                opt_text = cell_str(r[opts[key]])
                if opt_text:
                    a = f"{OPT_DISPLAY[key]}) {opt_text}"
        items.append({"q": q, "a": a})
    return items


def read_subject(f, args, report):
    """Read every sheet of one workbook; returns raw [{q, a, src}] rows."""
    raw = []
    wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
    for ws in wb.worksheets:
        report.append(f" sheet '{ws.title}'")
        items = read_sheet(ws, args, report)
        for it in items:
            it["src"] = f"{f.name}/{ws.title}"
        report.append(f"  {len(items)} rows")
        raw.extend(items)
    return raw


def dedupe(raw, subject, report):
    """Per-subject quality gate: empty answers dropped, exact duplicates merged, conflicts reported."""
    empty = [it for it in raw if not it["a"]]
    for it in empty:
        report.append(f"! EMPTY ANSWER ({it['src']}): {it['q'][:80]}")
    by_norm, conflicts, merged = {}, [], 0
    for it in raw:
        if not it["a"]:
            continue
        n = normalize(it["q"])
        if not n:
            continue
        if n in by_norm:
            prev = by_norm[n]
            if normalize(prev["a"]) == normalize(it["a"]):
                merged += 1
            else:
                conflicts.append((prev, it))
            continue
        by_norm[n] = {"q": it["q"], "a": it["a"], "n": n, "src": it["src"]}
    for prev, it in conflicts:
        report.append(f"! CONFLICT in subject '{subject}', same question with different answers "
                      f"({prev['src']} vs {it['src']}):\n"
                      f"    Q: {prev['q'][:100]}\n    A1: {prev['a'][:80]}\n    A2: {it['a'][:80]}")
    return list(by_norm.values()), len(empty), merged, conflicts


def find_near_duplicates(items, threshold):
    """Word-bigram Dice on a shortlist of questions that share words. Items need id and n."""
    inv, bigrams = {}, {}
    for it in items:
        toks = tokens(it["n"])
        bigrams[it["id"]] = word_bigrams(toks)
        for w in set(toks):
            inv.setdefault(w, []).append(it["id"])
    by_id = {it["id"]: it for it in items}
    seen, near = set(), []
    for it in items:
        cands = {}
        for w in set(tokens(it["n"])):
            ids = inv.get(w, [])
            if len(ids) > 200:  # very common word, skip
                continue
            for j in ids:
                if j > it["id"]:
                    cands[j] = cands.get(j, 0) + 1
        for j, shared in cands.items():
            if shared < 2 or (it["id"], j) in seen:
                continue
            seen.add((it["id"], j))
            s = dice(bigrams[it["id"]], bigrams[j])
            if s >= threshold:
                near.append((s, it, by_id[j]))
    near.sort(key=lambda x: -x[0])
    return near


def sync_registry(registry, files):
    """Give every source file a permanent subject number. Numbers of vanished files stay reserved."""
    by_file = {r["file"]: r for r in registry}
    nxt = max([r["number"] for r in registry], default=0) + 1
    changed = False
    for f in files:
        if f.name not in by_file:
            entry = {"file": f.name, "number": nxt, "name": f.stem}
            registry.append(entry)
            by_file[f.name] = entry
            nxt += 1
            changed = True
    return by_file, changed


def content_hash(obj):
    return hashlib.sha1(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:10]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="Excel files (default: every .xlsx/.xlsm in --source)")
    ap.add_argument("--source", default=str(SOURCE_DIR))
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--registry", default=str(REGISTRY_FILE), help="subject numbers and names (editable)")
    ap.add_argument("--report", default=str(REPORT_FILE))
    ap.add_argument("--q-col")
    ap.add_argument("--a-col")
    ap.add_argument("--allow-conflicts", action="store_true")
    ap.add_argument("--near", type=float, default=0.85, help="near-duplicate threshold")
    args = ap.parse_args()

    files = [Path(f) for f in args.files] or sorted(
        p for p in Path(args.source).glob("*")
        if p.suffix.lower() in (".xlsx", ".xlsm") and not p.name.startswith("~$")
    )
    if not files:
        sys.exit(f"No Excel files found in {args.source}")

    reg_path = Path(args.registry)
    registry = json.loads(reg_path.read_text(encoding="utf-8")) if reg_path.exists() else []
    by_file, reg_changed = sync_registry(registry, files)
    for r in registry:
        if r["file"] not in {f.name for f in files}:
            print(f"note: '{r['file']}' (subject {r['number']}) is in the registry but not in this build; not shipped")

    report = [f"build_data {datetime.now(timezone.utc).isoformat(timespec='seconds')}"]
    subjects, all_conflicts, totals = [], [], {"read": 0, "empty": 0, "merged": 0, "near": 0}

    for f in files:
        entry = by_file[f.name]
        report.append(f"{f.name}  ->  subject {entry['number']} '{entry['name']}'")
        raw = read_subject(f, args, report)
        items, empty, merged, conflicts = dedupe(raw, entry["name"], report)
        if len(items) >= ID_STRIDE:
            sys.exit(f"'{f.name}' has {len(items)} questions; at most {ID_STRIDE - 1} per subject")
        for i, it in enumerate(items, 1):
            it["id"] = entry["number"] * ID_STRIDE + i
        near = find_near_duplicates(items, args.near)
        for s, a, b in near:
            same = "same answer" if normalize(a["a"]) == normalize(b["a"]) else "DIFFERENT answers"
            report.append(f"~ near-duplicate in '{entry['name']}' {s:.2f} ({same}) #{a['id']} / #{b['id']}:\n"
                          f"    {a['q'][:100]}\n    {b['q'][:100]}")
        all_conflicts.extend(conflicts)
        totals["read"] += len(raw)
        totals["empty"] += empty
        totals["merged"] += merged
        totals["near"] += len(near)
        subjects.append({"entry": entry, "items": items})
        report.append(f"  => {len(items)} questions shipped")

    # picker order = order of entries in data/subjects.json (edit that file to reorder)
    subjects.sort(key=lambda s: registry.index(s["entry"]))

    # same question in more than one subject: allowed (answers may differ by subject), reported as info
    seen = {}
    for s in subjects:
        for it in s["items"]:
            seen.setdefault(it["n"], []).append((s["entry"]["name"], it))
    cross = {n: v for n, v in seen.items() if len(v) > 1}
    for n, v in cross.items():
        same = len({normalize(it["a"]) for _, it in v}) == 1
        report.append(f"i same question in subjects {', '.join(name for name, _ in v)} "
                      f"({'same' if same else 'DIFFERENT'} answers): {v[0][1]['q'][:90]}")

    summary = (f"\nsubjects {len(subjects)}, rows read {totals['read']}, empty answers {totals['empty']}, "
               f"exact duplicates merged {totals['merged']}, conflicts {len(all_conflicts)}, "
               f"near-duplicates {totals['near']}, cross-subject duplicates {len(cross)}, "
               f"shipped {sum(len(s['items']) for s in subjects)}")
    report.append(summary)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    print(f"\nreport: {args.report}")

    if all_conflicts and not args.allow_conflicts:
        sys.exit("\nREFUSED: a question has different answers inside one subject (see CONFLICT lines). "
                 "Fix the Excel, or rerun with --allow-conflicts to ship the first answer.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_subjects, keep = [], {"manifest.json"}
    for s in subjects:
        e = s["entry"]
        items = [{"id": it["id"], "q": it["q"], "a": it["a"], "n": it["n"]} for it in s["items"]]
        version = content_hash(items)
        name = f"{e['number']}.json"
        doc = {"number": e["number"], "name": e["name"], "version": version, "count": len(items), "items": items}
        (out_dir / name).write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        keep.add(name)
        manifest_subjects.append({"number": e["number"], "name": e["name"], "count": len(items),
                                  "file": name, "version": version})
        print(f"wrote {out_dir / name} ({(out_dir / name).stat().st_size // 1024} KB, {len(items)} questions, '{e['name']}')")
    manifest = {"version": content_hash([m["version"] + m["name"] for m in manifest_subjects]),
                "subjects": manifest_subjects}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for p in out_dir.glob("*.json"):  # drop data of subjects that are no longer built
        if p.name not in keep and re.fullmatch(r"\d+\.json", p.name):
            p.unlink()
            print(f"removed stale {p.name}")

    if reg_changed or not reg_path.exists():
        reg_path.parent.mkdir(parents=True, exist_ok=True)
        reg_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"updated {reg_path} (edit 'name' there to rename a subject)")


if __name__ == "__main__":
    main()
