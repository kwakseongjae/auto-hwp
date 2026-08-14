#!/usr/bin/env python3
"""Build tiny no-PII .xlsx fixtures for issue #40. Stdlib only."""
from __future__ import annotations

import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
{overrides}
</Types>
"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""

WB_NS = (
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
)


def esc(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def col_letter(i: int) -> str:
    n = i + 1
    out = ""
    while n:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def workbook(sheet_names: list[str]) -> str:
    sheets = "".join(
        f'<sheet name="{esc(name)}" sheetId="{i+1}" r:id="rId{i+1}"/>'
        for i, name in enumerate(sheet_names)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f"<workbook {WB_NS}><sheets>{sheets}</sheets></workbook>"
    )


def workbook_rels(n: int) -> str:
    rels = "".join(
        '<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'.format(
            i=i + 1
        )
        for i in range(n)
    )
    rels += '<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'.format(
        n + 1
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{rels}</Relationships>"
    )


def shared_strings(values: list[str]) -> str:
    items = "".join(f"<si><t>{esc(v)}</t></si>" for v in values)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{len(values)}" uniqueCount="{len(values)}">{items}</sst>'
    )


def sheet_xml(
    rows: list[list[int | None]],
    *,
    merge: str | None = None,
    extra_empty_rows: int = 0,
) -> str:
    """rows: each cell is a shared-string index or None."""
    body = []
    for r_i, row in enumerate(rows, start=1):
        cells = []
        for c_i, idx in enumerate(row):
            if idx is None:
                continue
            ref = f"{col_letter(c_i)}{r_i}"
            cells.append(f'<c r="{ref}" t="s"><v>{idx}</v></c>')
        body.append(f'<row r="{r_i}">{"".join(cells)}</row>')
    for k in range(extra_empty_rows):
        body.append(f'<row r="{len(rows) + k + 1}"/>')
    merge_xml = ""
    if merge:
        merge_xml = f'<mergeCells count="1"><mergeCell ref="{merge}"/></mergeCells>'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(body)}</sheetData>{merge_xml}</worksheet>"
    )


def write_xlsx(path: Path, sheets: list[tuple[str, str]], sst: list[str]) -> None:
    overrides = "\n".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES.format(overrides=overrides))
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("xl/workbook.xml", workbook([name for name, _ in sheets]))
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels(len(sheets)))
        z.writestr("xl/sharedStrings.xml", shared_strings(sst))
        for i, (_, xml) in enumerate(sheets, start=1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)


def main() -> None:
    # ok: Korean headers, comma inside a cell, two trailing empty rows.
    sst_ok = ["성명", "기업명", "김하나", "하나테크,본사", "이두리", "두리소프트"]
    ok_rows: list[list[int | None]] = [[0, 1], [2, 3], [4, 5]]
    write_xlsx(
        OUT / "ok.xlsx",
        [("명단", sheet_xml(ok_rows, extra_empty_rows=2))],
        sst_ok,
    )

    sst_extra = ["성명", "김하나", "숨김"]
    write_xlsx(
        OUT / "extra-sheet.xlsx",
        [
            ("명단", sheet_xml([[0], [1]])),
            ("다른시트", sheet_xml([[2]])),
        ],
        sst_extra,
    )

    sst_merge = ["성명", "기업명", "김하나", "하나테크"]
    write_xlsx(
        OUT / "merged-header.xlsx",
        [("명단", sheet_xml([[0, 1], [2, 3]], merge="A1:B1"))],
        sst_merge,
    )
    print("wrote", list(OUT.glob("*.xlsx")))


if __name__ == "__main__":
    main()
