#!/usr/bin/env python3
"""Check that tools/build_data.py normalize() and public/matcher.js normalize() agree.
Run: python3 tests/normalize_parity.py  (needs node)"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from build_data import normalize  # noqa: E402

SAMPLES = [
    "ما هي عاصمة جمهورية مصر العربية؟",
    "١٢- مَا هُوَ أَطْوَلُ نَهْرٍ فِي الْعَالَمِ؟",
    "س3: كم عدد أيام السنة الميلادية ؟",
    "Question 7) What is H2O?",
    "الإجابة: ثاني أكسيد الكربون (CO2)",
    "تـــطــويــل  التـــطويل",
    "ئ ؤ ى ة أ إ آ ٱ ک ی",
    "  spaces\tand\nnewlines  ",
    "12345",
    "",
    "٩٩) اختر الإجابة الصحيحة: أ) القاهرة ب) الجيزة",
    "ma@x.com — punctuation…!؟،؛",
]

js = r"""
const M = require(process.argv[1]);
const samples = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(samples.map(M.normalize)));
"""
out = subprocess.run(
    ["node", "-e", js, str(ROOT / "public" / "matcher.js")],
    input=json.dumps(SAMPLES), capture_output=True, text=True, check=True,
).stdout
js_results = json.loads(out)
bad = 0
for s, j in zip(SAMPLES, js_results):
    p = normalize(s)
    if p != j:
        bad += 1
        print(f"MISMATCH for {s!r}\n  py: {p!r}\n  js: {j!r}")
print(f"{len(SAMPLES) - bad}/{len(SAMPLES)} samples agree")
sys.exit(1 if bad else 0)
