#!/usr/bin/env python3
"""Diagnose PDF text extractability and OCR outline-only PDFs to sidecar text.

This is intended for PDFs that display crisp vector-looking text but have no
real PDF text layer. In that case, `pdftotext` and `pypdf` will return nothing
because the glyphs were exported as drawing paths instead of text objects.

Examples:
    python westbury/extract_pdf_text_with_ocr.py some.pdf --diagnose-only
    python westbury/extract_pdf_text_with_ocr.py /path/to/pdfs --recursive
    python westbury/extract_pdf_text_with_ocr.py some.pdf --force-ocr
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from pypdf import PdfReader


TEXT_OP_RE = re.compile(rb"(?<!\S)(?:BT|Tj|TJ|Tf|Tm|Td|TD|Ts|Tc|Tw|TL)(?!\S)")


def _page_content_bytes(page) -> bytes:
    content = page.get_contents()
    if content is None:
        return b""
    if isinstance(content, list):
        return b"".join(stream.get_data() for stream in content)
    return content.get_data()


def analyze_pdf(pdf_path: Path) -> dict:
    reader = PdfReader(str(pdf_path))
    extracted_chars = 0
    has_font_resources = False
    has_text_ops = False

    for page in reader.pages:
        page_text = (page.extract_text() or "").strip()
        extracted_chars += len(page_text)

        resources = page.get("/Resources")
        if resources and "/Font" in resources and len(resources["/Font"]) > 0:
            has_font_resources = True

        if not has_text_ops:
            data = _page_content_bytes(page)
            if TEXT_OP_RE.search(data):
                has_text_ops = True

    metadata = reader.metadata or {}
    return {
        "pages": len(reader.pages),
        "extracted_chars": extracted_chars,
        "has_font_resources": has_font_resources,
        "has_text_ops": has_text_ops,
        "creator": metadata.get("/Creator", ""),
        "producer": metadata.get("/Producer", ""),
        "outline_only": (
            extracted_chars == 0 and not has_font_resources and not has_text_ops
        ),
    }


def ensure_tool(name: str) -> None:
    if shutil.which(name):
        return
    raise RuntimeError(f"Required tool not found on PATH: {name}")


def ocr_pdf_to_text(
    pdf_path: Path,
    *,
    dpi: int,
    lang: str,
    psm: int | None,
) -> str:
    ensure_tool("pdftoppm")
    ensure_tool("tesseract")

    with TemporaryDirectory(prefix="ocr_pdf_") as tmpdir:
        prefix = Path(tmpdir) / "page"
        render_cmd = [
            "pdftoppm",
            "-r",
            str(dpi),
            "-gray",
            str(pdf_path),
            str(prefix),
        ]
        subprocess.run(render_cmd, check=True, capture_output=True, text=True)

        images = sorted(Path(tmpdir).glob("page-*.pgm"))
        if not images:
            raise RuntimeError(f"pdftoppm produced no page images for {pdf_path}")

        page_texts: list[str] = []
        for image in images:
            cmd = ["tesseract", str(image), "stdout", "-l", lang]
            if psm is not None:
                cmd.extend(["--psm", str(psm)])
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            text = result.stdout.strip()
            if text:
                page_texts.append(text)

    return "\n\f\n".join(page_texts).strip()


def iter_pdfs(input_path: Path, recursive: bool) -> list[Path]:
    if input_path.is_file():
        return [input_path]
    pattern = "**/*.pdf" if recursive else "*.pdf"
    return sorted(path for path in input_path.glob(pattern) if path.is_file())


def build_output_path(pdf_path: Path, input_root: Path, output_dir: Path | None) -> Path:
    if output_dir is None:
        return pdf_path.with_suffix(".ocr.txt")

    if input_root.is_file():
        rel = Path(pdf_path.name)
    else:
        rel = pdf_path.relative_to(input_root)
    return output_dir / rel.with_suffix(".ocr.txt")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="PDF file or directory")
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Recurse into subdirectories when input is a directory",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Write OCR sidecars under this directory instead of next to each PDF",
    )
    parser.add_argument(
        "--force-ocr",
        action="store_true",
        help="OCR even when pypdf extracts some text",
    )
    parser.add_argument(
        "--diagnose-only",
        action="store_true",
        help="Only print diagnostics; do not OCR or write files",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=400,
        help="Rasterization DPI for OCR (default: 400)",
    )
    parser.add_argument(
        "--lang",
        default="eng",
        help="Tesseract language code (default: eng)",
    )
    parser.add_argument(
        "--psm",
        type=int,
        default=None,
        help="Optional Tesseract page segmentation mode",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"Input not found: {args.input}", file=sys.stderr)
        return 1

    pdfs = iter_pdfs(args.input, args.recursive)
    if not pdfs:
        print(f"No PDFs found under {args.input}", file=sys.stderr)
        return 1

    processed = skipped = failed = 0
    for pdf_path in pdfs:
        try:
            info = analyze_pdf(pdf_path)
            summary = (
                f"{pdf_path}: pages={info['pages']} extracted_chars={info['extracted_chars']} "
                f"fonts={info['has_font_resources']} text_ops={info['has_text_ops']} "
                f"outline_only={info['outline_only']}"
            )
            print(summary)

            if info["creator"] or info["producer"]:
                print(
                    f"  creator={info['creator']!r} producer={info['producer']!r}"
                )

            if args.diagnose_only:
                continue

            if info["extracted_chars"] > 0 and not args.force_ocr:
                skipped += 1
                print("  skip: text already extractable")
                continue

            text = ocr_pdf_to_text(
                pdf_path,
                dpi=args.dpi,
                lang=args.lang,
                psm=args.psm,
            )
            if not text:
                raise RuntimeError("OCR produced no text")

            output_path = build_output_path(pdf_path, args.input, args.output_dir)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(text)
            processed += 1
            print(f"  wrote: {output_path} ({len(text):,} chars)")
        except Exception as exc:
            failed += 1
            print(f"  error: {exc}", file=sys.stderr)

    print(
        f"\nDone. OCR-written={processed} skipped={skipped} failed={failed} total={len(pdfs)}"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
