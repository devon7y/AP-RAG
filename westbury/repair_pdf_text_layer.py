#!/usr/bin/env python3
"""Add an invisible OCR text layer to PDFs that have no extractable text.

This preserves the original page appearance and writes repaired copies to a
separate output directory. It is aimed at PDFs whose visible text was exported
as vector outlines instead of PDF text objects.

Examples:
    python repair_pdf_text_layer.py /path/to/input.pdf
    python repair_pdf_text_layer.py /path/to/folder --recursive
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
import sys

import fitz


def iter_pdfs(input_path: Path, recursive: bool) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    pattern = "**/*.pdf" if recursive else "*.pdf"
    return sorted(path for path in input_path.glob(pattern) if path.is_file())


def has_extractable_text(doc: fitz.Document) -> bool:
    for page in doc:
        if page.get_text("text").strip():
            return True
    return False


def group_words_into_lines(words: list[tuple]) -> list[tuple[fitz.Point, float, str]]:
    lines: dict[tuple[int, int], list[tuple]] = defaultdict(list)
    for x0, y0, x1, y1, text, block_no, line_no, word_no in words:
        if not text.strip():
            continue
        lines[(block_no, line_no)].append((x0, y0, x1, y1, text, word_no))

    inserts: list[tuple[fitz.Point, float, str]] = []
    for key in sorted(lines):
        items = sorted(lines[key], key=lambda item: item[5])
        line_text = " ".join(item[4] for item in items).strip()
        if not line_text:
            continue

        x0 = min(item[0] for item in items)
        y0 = min(item[1] for item in items)
        y1 = max(item[3] for item in items)
        height = max(1.0, y1 - y0)

        # Use line-level insertion instead of textbox placement because OCR word
        # boxes are often too tight for insert_textbox(), which silently skips.
        point = fitz.Point(x0, y1 - max(1.0, height * 0.15))
        fontsize = max(4.0, height * 0.85)
        inserts.append((point, fontsize, line_text))

    return inserts


def add_ocr_text_layer(src_pdf: Path, dst_pdf: Path, dpi: int, language: str) -> tuple[int, int]:
    doc = fitz.open(src_pdf)
    if has_extractable_text(doc):
        doc.close()
        return 0, 0

    pages_with_text = 0
    inserted_lines = 0

    for page in doc:
        textpage = page.get_textpage_ocr(full=True, dpi=dpi, language=language)
        words = page.get_text("words", textpage=textpage, sort=True)
        line_inserts = group_words_into_lines(words)
        if line_inserts:
            pages_with_text += 1
        for point, fontsize, line_text in line_inserts:
            page.insert_text(
                point,
                line_text,
                fontsize=fontsize,
                fontname="helv",
                render_mode=3,
                overlay=True,
            )
        inserted_lines += len(line_inserts)

    dst_pdf.parent.mkdir(parents=True, exist_ok=True)
    doc.save(
        dst_pdf,
        garbage=3,
        deflate=True,
        use_objstms=1,
    )
    doc.close()
    return pages_with_text, inserted_lines


def build_output_path(pdf_path: Path, input_root: Path, output_dir: Path | None) -> Path:
    if output_dir is None:
        return pdf_path.with_name(f"{pdf_path.stem}.searchable.pdf")
    if input_root.is_file():
        rel = Path(pdf_path.name)
    else:
        rel = pdf_path.relative_to(input_root)
    return output_dir / rel


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="PDF file or directory")
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory for repaired PDFs. Defaults to sibling *.searchable.pdf files.",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Recurse into subdirectories when input is a directory",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=300,
        help="OCR rasterization DPI (default: 300)",
    )
    parser.add_argument(
        "--language",
        default="eng",
        help="OCR language passed to Tesseract through PyMuPDF (default: eng)",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 1

    pdfs = iter_pdfs(args.input, args.recursive)
    if not pdfs:
        print(f"No PDFs found under {args.input}", file=sys.stderr)
        return 1

    repaired = skipped = failed = 0
    for index, pdf_path in enumerate(pdfs, 1):
        print(f"[{index:03d}/{len(pdfs)}] {pdf_path}")
        try:
            output_path = build_output_path(pdf_path, args.input, args.output_dir)
            pages_with_text, inserted_lines = add_ocr_text_layer(
                pdf_path,
                output_path,
                dpi=args.dpi,
                language=args.language,
            )
            if inserted_lines == 0:
                skipped += 1
                print("  skip: extractable text already present or OCR found nothing")
                continue

            repaired += 1
            print(
                f"  wrote: {output_path} "
                f"(pages_with_text={pages_with_text}, inserted_lines={inserted_lines})"
            )
        except Exception as exc:
            failed += 1
            print(f"  error: {exc}", file=sys.stderr)

    print(
        f"\nDone. repaired={repaired} skipped={skipped} failed={failed} total={len(pdfs)}"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
