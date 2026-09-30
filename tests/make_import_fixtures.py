"""Create workbooks with the different layouts real users bring, for tests/importer.test.js.

    python3 tests/make_import_fixtures.py <out_dir>
"""
import sys
from pathlib import Path

import openpyxl


def save(path, sheets):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, rows in sheets:
        ws = wb.create_sheet(title)
        for r in rows:
            ws.append(r)
    wb.save(path)


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)

    # title rows above the header, a numbering column, and a "رقم السؤال" column that must NOT be taken as the question
    save(out / "header_row3.xlsx", [("ورقة1", [
        ["أسئلة مادة الجغرافيا"], [],
        ["م", "رقم السؤال", "السؤال", "الاجابة"],
        [1, 101, "ما هي عاصمة اليابان؟", "طوكيو"],
        [2, 102, "ما هي عاصمة إيطاليا؟", "روما"],
        [3, 103, "ما هي عاصمة ألمانيا؟", "برلين"],
    ])])

    # English headers, numeric answers (int, float, arabic-indic digits as text)
    save(out / "english.xlsx", [("Sheet1", [
        ["Question", "Answer"],
        ["كم عدد أيام الأسبوع؟", 7],
        ["ما قيمة الثابت باي تقريباً؟", 3.14],
        ["كم عدد أيام السنة الكبيسة؟", "٣٦٦"],
    ])])

    # multiple choice: answer is a letter in several spellings, options in the أ ب ج د columns
    save(out / "mcq.xlsx", [("MCQ", [
        ["السؤال", "أ", "ب", "ج", "د", "الإجابة الصحيحة"],
        ["ما هي عاصمة فرنسا؟", "لندن", "باريس", "روما", "مدريد", "ب"],
        ["ما هو أكبر كوكب؟", "الأرض", "المريخ", "المشتري", "زحل", "C"],
        ["كم عدد أضلاع المربع؟", 3, 4, 5, 6, "2"],
        ["أي مما يلي عنصر؟", "ماء", "ملح", "أكسجين", "سكر", "ج)"],
        ["سؤال بإجابة نصية؟", "أ1", "ب1", "ج1", "د1", "إجابة مكتوبة"],
    ])])

    # no header row at all: first two text columns are guessed
    save(out / "noheader.xlsx", [("S", [
        ["ما هي عاصمة مصر؟", "القاهرة"],
        ["ما هي عاصمة السعودية؟", "الرياض"],
        ["ما هي عاصمة الأردن؟", "عمان"],
    ])])

    # two sheets with different header spellings, and rows with empty answers
    save(out / "multi_sheet.xlsx", [
        ("الأول", [["السؤال", "الجواب"], ["س أول؟", "ج أول"], ["س ثان؟", None], ["س ثالث؟", "ج ثالث"]]),
        ("الثاني", [["الأسئلة", "الاجابة"], ["س رابع؟", "ج رابع"], ["س خامس؟", "ج خامس"]]),
    ])

    # the same question with different answers inside one subject (the app keeps both, never green)
    save(out / "conflict.xlsx", [("S", [
        ["السؤال", "الإجابة"],
        ["ما هو الكوكب الأقرب للشمس؟", "عطارد"],
        ["ما هو الكوكب الأقرب للشمس؟", "الزهرة"],
        ["ما هي عاصمة مصر؟", "القاهرة"],
        ["ما هي عاصمة مصر ؟", "القاهرة"],
    ])])

    # answer column not recognisable: user must pick it
    save(out / "unknown_cols.xlsx", [("S", [["السؤال", "ملاحظات"], ["ما هي عاصمة قطر؟", "الدوحة"]])])
    print("fixtures in", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/import_fixtures")
