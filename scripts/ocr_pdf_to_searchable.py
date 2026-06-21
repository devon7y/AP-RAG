#!/usr/bin/env python3
"""Create searchable PDFs from image-only PDFs using Tesseract PDF output.

This rasterizes each source page, asks Tesseract to emit a searchable PDF for
that page, and then concatenates the page PDFs into a final document.

The result is more robust than custom invisible-text overlays for scanned /
rotated / cropped source PDFs, at the cost of producing rasterized output
pages instead of preserving the original vector page contents.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from bs4 import BeautifulSoup
import fitz
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject
import re


def ensure_tool(name: str) -> None:
    if shutil.which(name):
        return
    raise RuntimeError(f"Required tool not found on PATH: {name}")


def iter_pdfs(input_path: Path, recursive: bool) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    pattern = "**/*.pdf" if recursive else "*.pdf"
    return sorted(path for path in input_path.glob(pattern) if path.is_file())


def build_output_path(pdf_path: Path, input_root: Path, output_dir: Path | None) -> Path:
    if output_dir is None:
        return pdf_path.with_name(f"{pdf_path.stem}.searchable.pdf")
    if input_root.is_file():
        rel = Path(pdf_path.name)
    else:
        rel = pdf_path.relative_to(input_root)
    return output_dir / rel


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def parse_hocr_careas(hocr_path: Path, pdf_width: float, pdf_height: float) -> list[tuple[int, float, float, float, float]]:
    soup = BeautifulSoup(hocr_path.read_text(), "xml")
    page_tag = soup.select_one("div.ocr_page")
    if page_tag is None:
        return []

    match = re.search(r"bbox 0 0 (\d+) (\d+)", page_tag.get("title", ""))
    if not match:
        return []

    img_width, img_height = map(int, match.groups())
    scale_x = pdf_width / img_width
    scale_y = pdf_height / img_height

    careas = []
    for index, carea in enumerate(soup.select("div.ocr_carea")):
        match = re.search(r"bbox (\d+) (\d+) (\d+) (\d+)", carea.get("title", ""))
        if not match:
            continue
        left, top, right, bottom = map(int, match.groups())
        x0 = left * scale_x
        x1 = right * scale_x
        y0 = pdf_height - bottom * scale_y
        y1 = pdf_height - top * scale_y
        careas.append((index, x0, y0, x1, y1))
    return careas


def reorder_tesseract_pdf_by_careas(page_pdf: Path, hocr_path: Path) -> None:
    reader = PdfReader(str(page_pdf))
    page = reader.pages[0]
    data = page.get_contents().get_data()
    first_bt = data.find(b"BT")
    if first_bt == -1:
        return

    prefix = data[:first_bt]
    text_part = data[first_bt:]
    text_blocks = re.findall(rb"BT\s.*?ET\s*", text_part, flags=re.S)
    if not text_blocks:
        return

    pdf_width = float(page.mediabox.right)
    pdf_height = float(page.mediabox.top)
    careas = parse_hocr_careas(hocr_path, pdf_width, pdf_height)
    if not careas:
        return

    assigned: dict[int, list[tuple[int, bytes]]] = {index: [] for index, *_ in careas}
    unassigned: list[tuple[int, bytes]] = []

    for original_index, block in enumerate(text_blocks):
        match = re.search(rb"1 0 0 1 ([0-9.]+) ([0-9.]+) Tm", block)
        if not match:
            unassigned.append((original_index, block))
            continue

        x = float(match.group(1))
        y = float(match.group(2))
        carea_index = None
        for index, x0, y0, x1, y1 in careas:
            if x0 - 2 <= x <= x1 + 2 and y0 - 6 <= y <= y1 + 6:
                carea_index = index
                break

        if carea_index is None:
            unassigned.append((original_index, block))
        else:
            assigned[carea_index].append((original_index, block))

    reordered = []
    for index, *_ in careas:
        reordered.extend(block for _, block in assigned[index])
    reordered.extend(block for _, block in unassigned)

    writer = PdfWriter(clone_from=str(page_pdf))
    writer_page = writer.pages[0]
    stream = DecodedStreamObject()
    stream.set_data(prefix + b"".join(reordered))
    writer_page.replace_contents(stream)

    with open(page_pdf, "wb") as handle:
        writer.write(handle)


def make_searchable_pdf(src_pdf: Path, dst_pdf: Path, dpi: int, language: str) -> tuple[int, int]:
    ensure_tool("pdftoppm")
    ensure_tool("tesseract")

    with TemporaryDirectory(prefix="ocr_pdf_") as tmpdir:
        tmp = Path(tmpdir)
        image_prefix = tmp / "page"

        run(
            [
                "pdftoppm",
                "-r",
                str(dpi),
                "-png",
                str(src_pdf),
                str(image_prefix),
            ]
        )

        images = sorted(tmp.glob("page-*.png"))
        if not images:
            raise RuntimeError(f"pdftoppm produced no page images for {src_pdf}")

        out_doc = fitz.open()
        total_chars = 0

        for index, image_path in enumerate(images, 1):
            page_pdf_prefix = tmp / f"ocr-{index:04d}"
            run(
                [
                    "tesseract",
                    str(image_path),
                    str(page_pdf_prefix),
                    "-l",
                    language,
                    "pdf",
                    "hocr",
                ]
            )

            page_pdf = page_pdf_prefix.with_suffix(".pdf")
            page_hocr = page_pdf_prefix.with_suffix(".hocr")
            if not page_pdf.exists():
                raise RuntimeError(f"Tesseract did not create {page_pdf}")
            if not page_hocr.exists():
                raise RuntimeError(f"Tesseract did not create {page_hocr}")

            reorder_tesseract_pdf_by_careas(page_pdf, page_hocr)

            with fitz.open(page_pdf) as part:
                total_chars += len(part[0].get_text("text").strip())
                out_doc.insert_pdf(part)

        dst_pdf.parent.mkdir(parents=True, exist_ok=True)
        out_doc.save(dst_pdf, garbage=3, deflate=True, use_objstms=1)
        out_doc.close()
        return len(images), total_chars


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="PDF file or directory")
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory for searchable PDFs. Defaults to sibling *.searchable.pdf files.",
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
        help="Rasterization DPI for OCR (default: 300)",
    )
    parser.add_argument(
        "--language",
        default="eng",
        help="Tesseract language (default: eng)",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 1

    pdfs = iter_pdfs(args.input, args.recursive)
    if not pdfs:
        print(f"No PDFs found under {args.input}", file=sys.stderr)
        return 1

    converted = failed = 0
    for index, pdf_path in enumerate(pdfs, 1):
        print(f"[{index:03d}/{len(pdfs)}] {pdf_path}")
        try:
            output_path = build_output_path(pdf_path, args.input, args.output_dir)
            page_count, total_chars = make_searchable_pdf(
                pdf_path,
                output_path,
                dpi=args.dpi,
                language=args.language,
            )
            converted += 1
            print(
                f"  wrote: {output_path} "
                f"(pages={page_count}, extracted_chars={total_chars})"
            )
        except Exception as exc:
            failed += 1
            print(f"  error: {exc}", file=sys.stderr)

    print(f"\nDone. converted={converted} failed={failed} total={len(pdfs)}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
