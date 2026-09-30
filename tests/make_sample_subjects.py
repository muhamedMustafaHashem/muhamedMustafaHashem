"""Create small two-subject sample workbooks used by the subject tests.

    python3 tests/make_sample_subjects.py [out_dir] [--third]

Files: جغرافيا.xlsx and علوم.xlsx (and تاريخ.xlsx with --third).
Deliberate cases: "كم عدد أيام السنة؟" exists in both subjects with different answers
(allowed across subjects), and geography has a near-duplicate pair about the longest river.
"""
import sys
from pathlib import Path

import openpyxl

GEOGRAPHY = [
    ("ما هي عاصمة جمهورية مصر العربية؟", "القاهرة"),
    ("ما هو أطول نهر في العالم؟", "نهر النيل"),
    ("ما هي أكبر قارة في العالم من حيث المساحة؟", "آسيا"),
    ("ما هي أصغر دولة في العالم؟", "الفاتيكان"),
    ("ما هو أكبر محيط في العالم؟", "المحيط الهادئ"),
    ("ما اسم أعلى جبل في العالم؟", "إيفرست"),
    ("في أي قارة تقع دولة البرازيل؟", "أمريكا الجنوبية"),
    ("ما هي عاصمة فرنسا؟", "باريس"),
    ("كم عدد قارات العالم؟", "7"),
    ("ما هي أكبر صحراء حارة في العالم؟", "الصحراء الكبرى"),
    ("ما هو أطول نهر في قارة أفريقيا؟", "نهر النيل"),
    ("كم عدد أيام السنة؟", "365 يوماً"),
]
SCIENCE = [
    ("ما هو العنصر الكيميائي الذي رمزه O؟", "الأكسجين"),
    ("ما هو الكوكب الأقرب إلى الشمس؟", "عطارد"),
    ("كم عدد الكواكب في المجموعة الشمسية؟", "8"),
    ("ما هو الغاز الذي تمتصه النباتات من الهواء؟", "ثاني أكسيد الكربون"),
    ("ما هو العضو المسؤول عن ضخ الدم في جسم الإنسان؟", "القلب"),
    ("ما هو أكبر كوكب في المجموعة الشمسية؟", "المشتري"),
    ("كم عدد أضلاع المثلث؟", "3"),
    ("ما هو الحيوان الأسرع على الأرض؟", "الفهد"),
    ("من هو مخترع المصباح الكهربائي؟", "توماس إديسون"),
    ("ما هي وحدة قياس القوة؟", "نيوتن"),
    ("ما هو الغاز الذي نتنفسه لنعيش؟", "الأكسجين"),
    ("كم عدد أيام السنة؟", "365.25 يوماً تقريباً"),
]
HISTORY = [
    ("في أي عام قامت ثورة 23 يوليو؟", "1952"),
    ("من بنى الهرم الأكبر في الجيزة؟", "الملك خوفو"),
]


def write(path, rows, sheet="الأسئلة"):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(["السؤال", "الإجابة"])
    for q, a in rows:
        ws.append([q, a])
    wb.save(path)


def main(out_dir="tests/sample_subjects", third=False):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    write(out / "جغرافيا.xlsx", GEOGRAPHY)
    write(out / "علوم.xlsx", SCIENCE)
    if third:
        write(out / "تاريخ.xlsx", HISTORY)
    print("wrote sample subjects to", out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(*(args[:1]), third="--third" in sys.argv)
