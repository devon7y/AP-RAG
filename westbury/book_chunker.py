"""
Structure-aware book chunker for LightRAG.

Handles two document types found in the Westbury lab corpus:

  - Edited volumes / handbooks: numbered chapters each written by a different
    author (e.g. Handbook of Humor Research). Each chapter is treated as an
    independent unit, chunked with scientific-paper-style logic inside.

  - Philosophical / theoretical monographs: continuous authored text organised
    by Part → Division → §N or Roman-numeral section (e.g. Being and Time).

Key differences from the scientific chunker:
  - Section detection is structure-based (Part/Chapter/§N/Roman) rather than
    vocabulary-based (IMRaD section names).
  - Front matter and back matter are excluded by name.
  - Larger default chunks (target 1000, max 1500, overlap 200) to preserve
    argumentative context across denser prose.

Integration:
    from book_chunker import make_book_chunker, BookChunkerConfig

    rag = LightRAG(
        chunking_func=make_book_chunker(BookChunkerConfig()),
        ...
    )

Environment variables (used by BookChunkerConfig.from_env()):
    BOOK_CHUNK_TARGET_TOKENS  (default 1000)
    BOOK_CHUNK_MAX_TOKENS     (default 1500)
    BOOK_CHUNK_MIN_TOKENS     (default 400)
    BOOK_CHUNK_OVERLAP_TOKENS (default 200)
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Any, Callable

from scientific_chunker import (
    RawChunk,
    Section,
    Tokenizer,
    _INLINE_SECTION_BOUNDARY,
    _NUM_PREFIX,
    _NUM_PREFIX_DOT,
    _PAGE_NUMBER_ONLY,
    _TOC_TRAILING_PAGE,
    count_tokens,
    inject_overlap,
    _looks_like_page_furniture,
    _normalize_page_furniture_line,
    pack_paragraphs,
    parse_paragraphs,
    rebalance_chunks,
)


# ── Configuration ──────────────────────────────────────────────────────────────


@dataclass
class BookChunkerConfig:
    """Configuration for the book chunker."""

    target_tokens: int = 1000
    max_tokens: int = 1500
    min_tokens: int = 250
    overlap_tokens: int = 200
    strip_repeated_page_furniture: bool = True
    exclude_front_matter: bool = True
    exclude_back_matter: bool = True
    exclusion_safety_valve: bool = True

    # Compatibility attributes consumed by shared scientific_chunker functions
    # (inject_overlap, rebalance_chunks, pack_paragraphs, etc.)
    exclude_references: bool = True
    exclude_acknowledgements: bool = False
    respect_sections: bool = True
    respect_paragraphs: bool = True
    split_oversize_paragraphs_by_sentence: bool = True

    @classmethod
    def from_env(cls) -> BookChunkerConfig:
        return cls(
            target_tokens=int(os.environ.get("BOOK_CHUNK_TARGET_TOKENS", 1000)),
            max_tokens=int(os.environ.get("BOOK_CHUNK_MAX_TOKENS", 1500)),
            min_tokens=int(os.environ.get("BOOK_CHUNK_MIN_TOKENS", 250)),
            overlap_tokens=int(os.environ.get("BOOK_CHUNK_OVERLAP_TOKENS", 200)),
        )


# ── Exclusion sets ─────────────────────────────────────────────────────────────

_BOOK_FRONT_MATTER: frozenset[str] = frozenset(
    {
        "preface",
        "foreword",
        "dedication",
        "table of contents",
        "contents",
        "list of illustrations",
        "list of figures",
        "list of tables",
        "abbreviations",
        "list of abbreviations",
        "about the author",
        "about the editor",
        "about the editors",
        "translator's preface",
        "translators' preface",
        "editor's preface",
        "editors' preface",
        "publisher's note",
        "note to the reader",
        "series preface",
        "general preface",
        "acknowledgements",
        "acknowledgments",
        "acknowledgement",
        "acknowledgment",
    }
)

_BOOK_BACK_MATTER: frozenset[str] = frozenset(
    {
        "index",
        "subject index",
        "author index",
        "name index",
        "general index",
        "bibliography",
        "references",
        "works cited",
        "literature cited",
        "further reading",
        "suggested reading",
        "glossary",
        "appendix",
        "appendices",
        "notes on contributors",
        "contributors",
        "about the contributors",
    }
)

# Combined for fast lookup
_BOOK_EXCLUDED: frozenset[str] = _BOOK_FRONT_MATTER | _BOOK_BACK_MATTER


# ── Section header patterns ────────────────────────────────────────────────────

# "Part One", "Part I", "Part 1", "PART TWO", "Volume I"
_BOOK_PART = re.compile(
    r"^(?:part|volume|book)\s+"
    r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"i{1,3}v?|iv|vi{0,3}|ix|xi{1,3}|xiv|xv|xvi{0,3}|xix|xx)[.:]?\s*$",
    re.IGNORECASE,
)

# "DIVISION ONE", "Division Two", "DIVISION ONE: ..."
_BOOK_DIVISION = re.compile(
    r"^division\s+"
    r"(?:one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)[.:]?",
    re.IGNORECASE,
)

# "Chapter 1", "CHAPTER ONE", "Chapter 1. Title", "Chapter 1: Title"
_BOOK_CHAPTER = re.compile(
    r"^chapter\s+"
    r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[ivx]+)"
    r"[.:]?",
    re.IGNORECASE,
)

# "§14", "§ 14", "§14. Title", "§ 3 Title"
_SECTION_SYMBOL = re.compile(r"^§\s*\d+\.?\s*")

# "I. Title", "IV. Title" — Roman numeral section headers.
# Require uppercase roman numerals only (avoids matching "i.e.", "v. August").
# The title must start with an uppercase letter or digit.
_ROMAN_SECTION = re.compile(
    r"^(?:I{1,4}|IV|VI{0,4}|IX|X[IVX]{0,4}|XI{1,4}|XIV|XV|XVI{0,4}|XIX|XX)\.\s+[A-Z\d]"
)

# Section names that are always hard splits even in books (content, not front/back matter)
_BOOK_KNOWN_HARD: frozenset[str] = frozenset(
    {
        "abstract",
        "introduction",
        "conclusion",
        "conclusions",
        "summary",
        "discussion",
        "overview",
        "epilogue",
        "prologue",
        "afterword",
        "postscript",
        "general discussion",
        "general conclusion",
        "general introduction",
    }
)

_STRUCTURAL_ORDINALS = (
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    "i{1,3}v?|iv|vi{0,3}|ix|xi{1,3}|xiv|xv|xvi{0,3}|xix|xx"
)

_BOOK_PART_COMPACT = re.compile(
    rf"^(?:part|volume|book)(?:\d+|{_STRUCTURAL_ORDINALS})$",
    re.IGNORECASE,
)
_BOOK_DIVISION_COMPACT = re.compile(
    rf"^division(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|[ivx]+)$",
    re.IGNORECASE,
)
_TOC_PAGE_REF = re.compile(
    r"(?:\b[A-Z]\.\s*)?(?:[ivxlcdm]+|\d+[A-Za-z]?)(?:\s+(?:[ivxlcdm]+|\d+[A-Za-z]?)){0,2}\s*$",
    re.IGNORECASE,
)
_STANDALONE_SECTION_MARKER = re.compile(r"^(?:\d+|[IVX]+|§\s*\d+)[.:·]?\s*$")
_LEADING_SECTION_NUMBER_TITLE = re.compile(r"^(?:\d+|[IVX]+)\s+[A-Z]")
_TITLE_CONNECTORS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "and",
        "as",
        "at",
        "by",
        "de",
        "for",
        "from",
        "in",
        "into",
        "of",
        "on",
        "or",
        "the",
        "to",
        "versus",
        "vs",
        "with",
    }
)
_NON_NAME_WORDS: frozenset[str] = frozenset(
    {
        "abstract",
        "analysis",
        "basic",
        "book",
        "chapter",
        "conclusion",
        "contents",
        "division",
        "discussion",
        "editor",
        "editors",
        "first",
        "foreword",
        "future",
        "general",
        "handbook",
        "humor",
        "index",
        "introduction",
        "issues",
        "language",
        "linguistic",
        "mind",
        "notes",
        "part",
        "past",
        "practice",
        "preface",
        "present",
        "primer",
        "prologue",
        "real",
        "research",
        "second",
        "section",
        "studies",
        "summary",
        "theory",
        "third",
        "thoughts",
        "title",
        "volume",
    }
)
_HEADER_META_PREFIX = re.compile(
    r"^(?:by|edited by|translated by|translation by|translator['’]s preface)\b",
    re.IGNORECASE,
)


# ── Title normalisation ────────────────────────────────────────────────────────


def _normalize_book_title(title: str) -> str:
    """Strip leading number/chapter prefix and normalise to lowercase."""
    t = title.strip().lower().rstrip(".:")
    # Strip leading numeric prefix (e.g. "3.1. " → "")
    m = _NUM_PREFIX.match(t)
    if m:
        t = t[m.end() :].strip()
    # Strip leading "chapter N" prefix
    ch = _BOOK_CHAPTER.match(t)
    if ch:
        t = t[ch.end() :].strip().lstrip(".:-–— ")
    return t


def _matches_excluded_title(norm: str, excluded_titles: frozenset[str]) -> bool:
    """Match excluded titles exactly or as a short descriptive prefix."""
    for excluded in excluded_titles:
        if norm == excluded:
            return True
        for suffix in (" ", ":", " (", " - "):
            if norm.startswith(excluded + suffix):
                return True
    return False


def _should_exclude_book(title: str, config: BookChunkerConfig) -> bool:
    """Return True if this section should be excluded from retrieval chunks."""
    norm = _normalize_book_title(title)
    if not norm:
        return False
    if config.exclude_front_matter and _matches_excluded_title(norm, _BOOK_FRONT_MATTER):
        return True
    if config.exclude_back_matter and _matches_excluded_title(norm, _BOOK_BACK_MATTER):
        return True
    return False


# ── Preprocessing ──────────────────────────────────────────────────────────────


def _strip_repeated_page_furniture_preserve_pages(
    text: str, config: BookChunkerConfig
) -> str:
    """Remove repeated running headers/footers while keeping form-feed page breaks."""
    if not config.strip_repeated_page_furniture or "\f" not in text:
        return text

    pages = [page for page in re.split(r"\s*\f\s*", text) if page.strip()]
    if len(pages) < 2:
        return text

    boundary_counts: dict[str, int] = {}
    page_boundaries: list[tuple[list[str], list[str], list[str]]] = []
    for page in pages:
        lines = page.splitlines()
        nonempty = [line for line in lines if line.strip()]
        leading = nonempty[:3]
        trailing = nonempty[-3:]
        page_boundaries.append((lines, leading, trailing))
        for line in leading + trailing:
            normalized = _normalize_page_furniture_line(line)
            if normalized and _looks_like_page_furniture(line):
                boundary_counts[normalized] = boundary_counts.get(normalized, 0) + 1

    removable = {line for line, count in boundary_counts.items() if count >= 2}
    cleaned_pages: list[str] = []

    for lines, _, _ in page_boundaries:
        start = 0
        end = len(lines) - 1

        while start <= end:
            stripped = lines[start].strip()
            normalized = _normalize_page_furniture_line(stripped)
            if not stripped:
                start += 1
                continue
            if _PAGE_NUMBER_ONLY.fullmatch(stripped):
                start += 1
                continue
            if normalized in removable and not _looks_like_book_boundary_line(stripped):
                start += 1
                continue
            break

        while end >= start:
            stripped = lines[end].strip()
            normalized = _normalize_page_furniture_line(stripped)
            if not stripped:
                end -= 1
                continue
            if _PAGE_NUMBER_ONLY.fullmatch(stripped):
                end -= 1
                continue
            if normalized in removable and not _looks_like_book_boundary_line(stripped):
                end -= 1
                continue
            break

        cleaned = "\n".join(lines[start : end + 1]).strip()
        if cleaned:
            cleaned_pages.append(cleaned)

    return "\f\n".join(cleaned_pages).strip()


def _preprocess_book_text(text: str, config: BookChunkerConfig) -> str:
    """Normalize extracted text while preserving page boundaries for book heuristics."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return ""
    return _strip_repeated_page_furniture_preserve_pages(normalized, config).strip()


# ── Section header classification ─────────────────────────────────────────────


def _clean_book_line(line: str) -> str:
    """Normalize whitespace and remove soft hyphen artifacts in extracted text."""
    return re.sub(r"\s+", " ", line.replace("\xad", "").strip())


def _compact_structural_text(line: str) -> str:
    """Compact a line for structure matching while ignoring OCR-introduced gaps."""
    return re.sub(r"[^A-Za-z0-9]+", "", _clean_book_line(line)).lower()


def _render_structural_marker(line: str) -> str:
    """Normalize simple structural markers like 'PART ON E' -> 'Part One'."""
    cleaned = _clean_book_line(line)
    compact = _compact_structural_text(line)

    for prefix in ("part", "volume", "book", "division"):
        if not compact.startswith(prefix):
            continue
        suffix = compact[len(prefix) :]
        if not suffix:
            break
        if re.fullmatch(r"[ivx]+", suffix, re.IGNORECASE):
            rendered_suffix = suffix.upper()
        elif suffix.isdigit():
            rendered_suffix = suffix
        else:
            rendered_suffix = suffix.title()
        return f"{prefix.title()} {rendered_suffix}"

    return cleaned


def _looks_like_reference_entry(line: str) -> bool:
    """Reject bibliography-style numbered entries that are not real section headers."""
    ref_match = _NUM_PREFIX_DOT.match(line)
    if not ref_match:
        return False
    after_num = line[ref_match.end() :].strip()
    return bool(re.search(r"^[A-Z][a-z]+,", after_num[:25]))


def _is_all_capsish(line: str) -> bool:
    """Heuristic for headings extracted as uppercase or heavily OCR-distorted caps."""
    letters = re.findall(r"[A-Za-z]", line)
    if not letters:
        return False
    upper = sum(ch.isupper() for ch in letters)
    return upper / len(letters) >= 0.75


def _looks_like_running_header(line: str) -> bool:
    """Heuristic for residual running heads/page furniture that survived preprocessing."""
    tokens = re.findall(r"[A-Za-z0-9]+", line)
    if len(tokens) < 3 or len(tokens) > 10:
        return False

    pageish = 0
    long_words = 0
    for token in tokens:
        if re.fullmatch(r"(?:[IVX]+|[A-Za-z]?\d+[A-Za-z]?|\d+)", token, re.IGNORECASE):
            pageish += 1
        if any(ch.isalpha() for ch in token) and len(token) >= 3:
            long_words += 1

    return pageish >= 2 and long_words >= 1


def _is_toc_entry_line(line: str) -> bool:
    """Return True for table-of-contents style lines with page references."""
    stripped = _clean_book_line(line)
    if not stripped:
        return False
    tokens = stripped.split()
    if len(tokens) < 3:
        return False
    if _TOC_TRAILING_PAGE.search(stripped):
        return True
    if len(stripped) > 150:
        return False
    match = _TOC_PAGE_REF.search(stripped)
    if not match:
        return False
    prefix = stripped[: match.start()].strip()
    return bool(prefix)


def _is_titleish_line(line: str) -> bool:
    """Detect short title-like lines used in chapter/part header blocks."""
    stripped = _clean_book_line(line)
    if not stripped or len(stripped) > 140:
        return False
    if _is_toc_entry_line(stripped) or _looks_like_running_header(stripped):
        return False
    if stripped.endswith((".", "?", "!")):
        return False

    words = re.findall(r"[A-Za-z][A-Za-z'’.-]*|\d+", stripped)
    if not words or len(words) > 18:
        return False

    if _is_all_capsish(stripped):
        return True

    alpha_words = [word for word in words if re.search(r"[A-Za-z]", word)]
    if not alpha_words:
        return False

    titleish = 0
    for word in alpha_words:
        if word[0].isupper() or word.lower() in _TITLE_CONNECTORS:
            titleish += 1

    return titleish / len(alpha_words) >= 0.75


def _is_page_header_line(line: str) -> bool:
    """More permissive heading heuristic for top-of-page title blocks."""
    stripped = _clean_book_line(line)
    if not stripped or len(stripped) > 100:
        return False
    if _is_titleish_line(stripped):
        return True
    if (
        _is_toc_entry_line(stripped)
        or _looks_like_running_header(stripped)
        or _looks_like_reference_entry(stripped)
        or _looks_like_author_line(stripped)
    ):
        return False
    if (
        stripped.endswith((".", "!", "?"))
        or "," in stripped
        or ";" in stripped
        or re.search(r"[?!]\s+\S", stripped)
    ):
        return False

    words = re.findall(r"[A-Za-z][A-Za-z'’.-]*|\d+", stripped)
    if not (2 <= len(words) <= 14):
        return False

    if stripped[0].isdigit():
        return True
    if stripped.endswith(":"):
        return True

    alpha_words = [word for word in words if re.search(r"[A-Za-z]", word)]
    capitalized_after_first = sum(
        1 for word in alpha_words[1:] if word and word[0].isupper()
    )
    if capitalized_after_first >= 1:
        return True
    if stripped[0].isupper() and len(words) <= 8:
        return True
    return words[0].lower() in _TITLE_CONNECTORS and len(words) <= 6


def _looks_like_body_line(line: str) -> bool:
    """Detect paragraph-like lines that should remain body text, not headers."""
    stripped = _clean_book_line(line)
    if not stripped:
        return False
    if (
        _is_toc_entry_line(stripped)
        or _looks_like_running_header(stripped)
        or _looks_like_reference_entry(stripped)
        or _looks_like_author_line(stripped)
    ):
        return False
    if len(stripped) >= 60 and not _is_titleish_line(stripped):
        return True

    words = re.findall(r"[A-Za-z][A-Za-z'’.-]*|\d+", stripped)
    if len(words) < 10 or stripped.endswith(":"):
        return False

    alpha_words = [word for word in words if re.search(r"[A-Za-z]", word)]
    if len(alpha_words) < 8:
        return False

    capitalized_after_first = sum(
        1 for word in alpha_words[1:] if word and word[0].isupper()
    )
    return capitalized_after_first == 0 and not _is_titleish_line(stripped)


def _looks_like_book_boundary_line(line: str) -> bool:
    """Return True for lines that are plausible book/chapter boundary markers."""
    stripped = _clean_book_line(line)
    compact = _compact_structural_text(stripped)
    return bool(
        _BOOK_CHAPTER.match(stripped)
        or _BOOK_PART.match(stripped)
        or _BOOK_DIVISION.match(stripped)
        or _BOOK_PART_COMPACT.match(compact)
        or _BOOK_DIVISION_COMPACT.match(compact)
        or _SECTION_SYMBOL.match(stripped)
        or _STANDALONE_SECTION_MARKER.fullmatch(stripped)
        or _LEADING_SECTION_NUMBER_TITLE.match(stripped)
    )


def _looks_like_name_sequence(line: str) -> bool:
    """Detect simple author/editor name lines in either title case or all caps."""
    stripped = _clean_book_line(line).strip(",;:")
    if not stripped or len(stripped) > 100:
        return False

    tokens = [tok.strip(",;:") for tok in stripped.split()]
    if not (2 <= len(tokens) <= 12):
        return False
    if any(token.lower() in _NON_NAME_WORDS for token in tokens):
        return False

    nameish = 0
    saw_joiner = False
    has_initial = False
    non_joiner_tokens: list[str] = []
    for token in tokens:
        lowered = token.lower()
        if lowered in _TITLE_CONNECTORS and lowered != "and":
            return False
        if lowered in {"and", "&"}:
            saw_joiner = True
            continue
        if re.fullmatch(r"[A-Z]\.", token):
            has_initial = True
            continue
        if re.fullmatch(r"[A-Z][A-Za-z'’.-]+", token) or re.fullmatch(r"[A-Z]{2,}", token):
            nameish += 1
            non_joiner_tokens.append(token)
            continue
        return False

    if saw_joiner and nameish < 4:
        return False
    if (
        not saw_joiner
        and not has_initial
        and len(non_joiner_tokens) > 2
        and all(token.isupper() for token in non_joiner_tokens)
    ):
        return False
    return 2 <= nameish <= 8


def _looks_like_author_line(line: str) -> bool:
    """Detect author/editor metadata that should not be folded into the title."""
    stripped = _clean_book_line(line)
    if not stripped:
        return False
    if _HEADER_META_PREFIX.match(stripped):
        return True
    return _looks_like_name_sequence(stripped)


def _looks_like_toc_page(lines: list[str], previous_page_was_toc: bool) -> bool:
    """Detect a table-of-contents page, including continuation pages."""
    cleaned = [_clean_book_line(line) for line in lines if _clean_book_line(line)]
    if not cleaned:
        return False

    top_labels = {_normalize_book_title(line) for line in cleaned[:4]}
    if "contents" in top_labels or "table of contents" in top_labels:
        return True

    toc_entries = sum(_is_toc_entry_line(line) for line in cleaned)
    titleish = sum(_is_titleish_line(line) for line in cleaned[:20])
    header_like = sum(
        _classify_book_header(
            line,
            at_block_start=True,
            at_page_start=True,
        )[0]
        != "none"
        for line in cleaned[:20]
    )
    bodyish = sum(
        (
            len(line) >= 70
            and not _is_titleish_line(line)
            and not _is_toc_entry_line(line)
        )
        or bool(re.search(r"[a-z]{3,}", line) and line.endswith((".", "!", "?", ";")))
        for line in cleaned[:20]
    )

    if previous_page_was_toc and toc_entries + titleish >= max(5, bodyish + 2):
        return True
    if previous_page_was_toc and bodyish == 0 and (toc_entries >= 2 or header_like >= 2):
        return True

    return toc_entries >= 5 and titleish >= 4 and bodyish <= 3


def _split_page_into_blocks(page_text: str) -> list[list[str]]:
    """Split a page into blocks of consecutive non-empty lines."""
    blocks: list[list[str]] = []
    current: list[str] = []

    for raw_line in page_text.split("\n"):
        if raw_line.strip():
            current.append(raw_line)
            continue
        if current:
            blocks.append(current)
            current = []

    if current:
        blocks.append(current)

    return blocks


def _classify_book_header(
    line: str,
    *,
    at_block_start: bool,
    at_page_start: bool,
) -> tuple[str, str]:
    """
    Classify a block-opening line as a book section header.

    Generic roman/numbered headers are only trusted at block starts so in-body
    enumerations and list items do not fragment the document.
    """
    stripped = _clean_book_line(line)
    compact = _compact_structural_text(line)
    if not stripped or len(stripped) > 150:
        return "none", ""

    if _looks_like_running_header(stripped) or _is_toc_entry_line(stripped):
        return "none", ""
    if _looks_like_reference_entry(stripped):
        return "none", ""

    if _BOOK_PART.match(stripped) or _BOOK_PART_COMPACT.match(compact):
        return "hard", _render_structural_marker(stripped)

    if _BOOK_DIVISION.match(stripped) or _BOOK_DIVISION_COMPACT.match(compact):
        return "hard", _render_structural_marker(stripped)

    chapter_match = _BOOK_CHAPTER.match(stripped)
    if chapter_match:
        rest_after = stripped[chapter_match.end() :].strip()
        if not rest_after or not rest_after[0].islower():
            return "hard", stripped

    if _SECTION_SYMBOL.match(stripped):
        return "hard", stripped

    if not at_block_start:
        return "none", ""

    if _ROMAN_SECTION.match(stripped):
        return "hard", stripped

    num_match = _NUM_PREFIX.match(stripped)
    title_core = stripped[num_match.end() :].strip() if num_match else stripped
    normalized = title_core.lower().rstrip(".:")
    if (stripped[0].isupper() or stripped[0].isdigit()) and normalized in _BOOK_KNOWN_HARD:
        return "hard", stripped

    num_match_dot = _NUM_PREFIX_DOT.match(stripped)
    if num_match_dot:
        title_core_dot = stripped[num_match_dot.end() :].strip()
        if title_core_dot and title_core_dot[0].isupper():
            words = title_core_dot.split()
            depth = num_match_dot.group(0).count(".")
            if (
                1 <= len(words) <= 12
                and len(stripped) <= 95
                and _is_titleish_line(stripped)
                and not title_core_dot.rstrip().endswith(".")
            ):
                return ("hard" if depth <= 2 else "soft"), stripped

    if (
        at_page_start
        and _STANDALONE_SECTION_MARKER.fullmatch(stripped)
        and stripped[0] != "§"
    ):
        return "hard", stripped

    return "none", ""


def _is_page_header_continuation_line(line: str) -> bool:
    """Allow short lowercase continuation lines that complete a page-start heading."""
    stripped = _clean_book_line(line)
    if not stripped or len(stripped) > 80:
        return False
    if _is_page_header_line(stripped):
        return True
    if (
        _is_toc_entry_line(stripped)
        or _looks_like_running_header(stripped)
        or _looks_like_reference_entry(stripped)
        or _looks_like_author_line(stripped)
    ):
        return False
    if stripped.endswith((".", "!", "?")) or "," in stripped or ";" in stripped:
        return False

    words = re.findall(r"[A-Za-z][A-Za-z'’.-]*|\d+", stripped)
    return 1 <= len(words) <= 6


def _extract_header_from_block(
    block: list[str], *, at_page_start: bool
) -> tuple[str, str, list[str]]:
    """Extract a header/title block and return (kind, title, remaining_lines)."""
    if not block:
        return "none", "", []

    cleaned = [_clean_book_line(line) for line in block]
    first = cleaned[0]
    kind, first_title = _classify_book_header(
        first,
        at_block_start=True,
        at_page_start=at_page_start,
    )

    if kind == "none" and at_page_start:
        if (
            len(cleaned) >= 2
            and _STANDALONE_SECTION_MARKER.fullmatch(first)
            and _is_page_header_line(cleaned[1])
            and not _looks_like_running_header(cleaned[1])
        ):
            kind = "hard"
            first_title = first
        elif (
            len(cleaned) >= 2
            and _LEADING_SECTION_NUMBER_TITLE.match(first)
            and _is_page_header_line(first)
            and _is_page_header_continuation_line(cleaned[1])
        ):
            kind = "hard"
            first_title = first
        elif (
            len(cleaned) >= 2
            and _is_page_header_line(first)
            and _is_page_header_line(cleaned[1])
            and not _looks_like_author_line(first)
            and not _is_toc_entry_line(cleaned[1])
            and (
                first.endswith(":")
                or _is_all_capsish(first)
                or _is_all_capsish(cleaned[1])
                or (len(cleaned) >= 3 and _looks_like_author_line(cleaned[2]))
            )
        ):
            kind = "hard"
            first_title = first
        elif (
            len(cleaned) >= 2
            and _LEADING_SECTION_NUMBER_TITLE.match(first)
            and _is_page_header_line(first)
            and _looks_like_body_line(cleaned[1])
        ):
            kind = "hard"
            first_title = first

    if kind == "none":
        return "none", "", block

    title_lines = [first_title]
    consumed = 1
    allow_continuation = (
        at_page_start
        or _BOOK_CHAPTER.match(first)
        or _BOOK_PART.match(first)
        or _BOOK_DIVISION.match(first)
        or _BOOK_PART_COMPACT.match(_compact_structural_text(first))
        or _BOOK_DIVISION_COMPACT.match(_compact_structural_text(first))
        or _STANDALONE_SECTION_MARKER.fullmatch(first)
    )

    while allow_continuation and consumed < len(cleaned) and len(title_lines) < 6:
        line = cleaned[consumed]
        if _looks_like_author_line(line):
            break
        if not (
            _is_titleish_line(line)
            or (
                at_page_start
                and (
                    _is_page_header_line(line)
                    or _is_page_header_continuation_line(line)
                )
            )
        ):
            break
        if _classify_book_header(
            line,
            at_block_start=False,
            at_page_start=False,
        )[0] == "hard":
            break
        title_lines.append(line)
        consumed += 1

    rendered_title = " ".join(title_lines).strip()
    rendered_title = re.sub(r"\s+", " ", rendered_title)
    return kind, rendered_title, block[consumed:]


def _trim_candidate_title(candidate: str) -> str:
    """Trim obvious body spillover from a candidate heading."""
    cleaned = _clean_book_line(candidate)
    if not cleaned:
        return ""

    if cleaned.startswith("§"):
        return cleaned

    tokens = cleaned.split()
    uppercase_prefix: list[str] = []
    for token in tokens:
        bare = token.strip(",;:")
        if bare.lower() in _TITLE_CONNECTORS and uppercase_prefix:
            uppercase_prefix.append(token)
            continue
        letters = re.findall(r"[A-Za-z]", bare)
        if letters and all(ch.isupper() for ch in letters):
            uppercase_prefix.append(token)
            continue
        break

    if len([tok for tok in uppercase_prefix if re.search(r"[A-Za-z]", tok)]) >= 3:
        return " ".join(uppercase_prefix).rstrip(":")

    if "." in cleaned:
        sentence_prefix = cleaned.split(".", 1)[0].strip()
        if 2 <= len(sentence_prefix.split()) <= 12 and _is_titleish_line(sentence_prefix):
            return sentence_prefix

    return cleaned


def _sanitize_detected_section_title(title: str) -> str:
    """Strip page-number/running-head prefixes from detected section titles."""
    cleaned = _clean_book_line(title)
    if not cleaned:
        return cleaned

    page_match = re.match(r"^\d+\s+(.+)$", cleaned)
    if not page_match:
        return cleaned

    remainder = page_match.group(1).strip()
    normalized_remainder = _normalize_book_title(remainder)

    if _matches_excluded_title(normalized_remainder, _BOOK_EXCLUDED):
        return remainder

    section_symbol_pos = remainder.find("§")
    if section_symbol_pos >= 0:
        return remainder[section_symbol_pos:].strip()

    structural_match = re.search(r"\b(?:chapter|part|division)\b", remainder, re.IGNORECASE)
    if structural_match:
        return remainder[structural_match.start() :].strip()

    tokens = remainder.split()
    for end in range(2, min(len(tokens), 10) + 1):
        prefix = " ".join(tokens[:end])
        if _looks_like_name_sequence(prefix):
            candidate = " ".join(tokens[end:]).strip()
            if candidate:
                return _trim_candidate_title(candidate)
            return ""

    return cleaned


def _looks_plausible_detected_title(title: str) -> bool:
    """Return True when a normalized detected title still looks like a heading."""
    cleaned = _clean_book_line(title)
    if not cleaned or cleaned == "Untitled":
        return False
    if cleaned[0].islower() or _looks_like_author_line(cleaned):
        return False
    compact = _compact_structural_text(cleaned)
    normalized = _normalize_book_title(cleaned)

    if (
        _BOOK_CHAPTER.match(cleaned)
        or _BOOK_PART.match(cleaned)
        or _BOOK_DIVISION.match(cleaned)
        or _BOOK_PART_COMPACT.match(compact)
        or _BOOK_DIVISION_COMPACT.match(compact)
        or _SECTION_SYMBOL.match(cleaned)
        or _ROMAN_SECTION.match(cleaned)
        or normalized in _BOOK_KNOWN_HARD
    ):
        return True

    return _is_titleish_line(cleaned) or (
        _is_page_header_line(cleaned)
        and (cleaned[0].isdigit() or cleaned.endswith(":") or len(cleaned.split()) <= 8)
    )


def _is_suspicious_detected_section_title(original_title: str, sanitized_title: str) -> bool:
    """Heuristic for false-positive section titles caused by page-top artifacts."""
    original = _clean_book_line(original_title)
    sanitized = _clean_book_line(sanitized_title)
    if not original or original == "Untitled":
        return False
    if not sanitized:
        return bool(re.match(r"^\d+\s+", original) or _looks_like_author_line(original))
    if _looks_plausible_detected_title(sanitized):
        return False

    if re.match(r"^\d+\s+", original):
        return True
    if original.count(",") >= 2 or sanitized.count(",") >= 2:
        return True
    if sanitized.endswith("."):
        return True
    if sanitized.startswith("(") or sanitized[0].islower():
        return True

    return False


def _refine_book_sections(
    sections: list[Section], config: BookChunkerConfig
) -> list[Section]:
    """Sanitize detected titles and merge obvious false-positive page-top splits."""
    refined: list[Section] = []

    for section in sections:
        raw_sanitized_title = _sanitize_detected_section_title(section.title)
        sanitized_title = raw_sanitized_title or section.title

        if (
            refined
            and _is_suspicious_detected_section_title(section.title, raw_sanitized_title)
        ):
            merged_parts = [refined[-1].text]
            title_text = _clean_book_line(section.title)
            if title_text:
                merged_parts.append(title_text)
            if section.text.strip():
                merged_parts.append(section.text.strip())
            refined[-1].text = "\n\n".join(part for part in merged_parts if part.strip())
            continue

        refined.append(
            Section(
                title=sanitized_title,
                index=len(refined),
                text=section.text,
                is_excluded=_should_exclude_book(sanitized_title, config),
            )
        )

    return refined


# ── Section detection ─────────────────────────────────────────────────────────


def detect_book_sections(text: str, config: BookChunkerConfig) -> list[Section]:
    """
    Detect major sections from plain text extracted from a book PDF.

    Uses structure-based detection (Part/Chapter/§N/Roman-numeral) rather than
    IMRaD vocabulary matching.
    """
    text = _preprocess_book_text(text, config)
    text = _INLINE_SECTION_BOUNDARY.sub("\n", text)

    pages = re.split(r"\s*\f\s*", text) if "\f" in text else [text]
    sections: list[Section] = []
    current_title = "Untitled"
    current_blocks: list[str] = []
    section_idx = 0

    def _flush() -> None:
        nonlocal section_idx
        section_text = "\n\n".join(block for block in current_blocks if block.strip()).strip()
        if not section_text:
            return
        sections.append(
            Section(
                title=current_title,
                index=section_idx,
                text=section_text,
                is_excluded=_should_exclude_book(current_title, config),
            )
        )
        section_idx += 1

    previous_page_was_toc = False

    for page in pages:
        page_blocks = _split_page_into_blocks(page)
        page_lines = [line for block in page_blocks for line in block]
        if _looks_like_toc_page(page_lines, previous_page_was_toc):
            previous_page_was_toc = True
            continue
        previous_page_was_toc = False

        for block_index, block in enumerate(page_blocks):
            kind, title, remainder = _extract_header_from_block(
                block, at_page_start=block_index == 0
            )
            if kind == "hard":
                _flush()
                current_title = title
                current_blocks = []
                if remainder:
                    block_text = "\n".join(remainder).strip()
                    if block_text:
                        current_blocks.append(block_text)
                continue

            block_text = "\n".join(block).strip()
            if block_text:
                current_blocks.append(block_text)

    _flush()

    if not sections:
        sections = [Section(title="Untitled", index=0, text=text.strip())]

    return _refine_book_sections(sections, config)


# ── Safety valve ───────────────────────────────────────────────────────────────


def _should_disable_exclusions(
    sections: list[Section], config: BookChunkerConfig
) -> bool:
    """Disable exclusions if they would remove more than 90% of the document."""
    if not (config.exclude_front_matter or config.exclude_back_matter):
        return False

    kept_tokens = 0
    excluded_tokens = 0

    for section in sections:
        if not section.paragraphs:
            continue
        tok = sum(p.token_count for p in section.paragraphs)
        if section.is_excluded:
            excluded_tokens += tok
        else:
            kept_tokens += tok

    total = kept_tokens + excluded_tokens
    if total == 0 or excluded_tokens == 0:
        return False

    if kept_tokens == 0 and excluded_tokens >= 1000:
        return True
    if excluded_tokens / total >= 0.90 and excluded_tokens >= 5000:
        return True

    return False


# ── Main chunking pipeline ─────────────────────────────────────────────────────


def chunk_book_document(
    tokenizer: Tokenizer,
    text: str,
    config: BookChunkerConfig,
    document_id: str = "",
) -> list[dict[str, Any]]:
    """
    Chunk a book into structure-aware retrieval chunks.

    Returns a list of dicts compatible with LightRAG's chunking_func output.
    Required keys: tokens, content, chunk_order_index.
    """
    if not text or not text.strip():
        return []

    # 1. Detect sections
    sections = detect_book_sections(text, config)

    # 2. Parse paragraphs within each section
    for section in sections:
        parse_paragraphs(section, tokenizer)

    # 3. Safety valve
    include_excluded = (
        config.exclusion_safety_valve and _should_disable_exclusions(sections, config)
    )

    # 4. Pack paragraphs into chunks (per section, honouring exclusions)
    raw_chunks: list[RawChunk] = []
    for section in sections:
        if (section.is_excluded and not include_excluded) or not section.paragraphs:
            continue
        raw_chunks.extend(pack_paragraphs(tokenizer, section.paragraphs, config))

    if not raw_chunks:
        tok = count_tokens(tokenizer, text.strip())
        return [
            {
                "tokens": tok,
                "content": text.strip(),
                "chunk_order_index": 0,
                "raw_text_without_overlap": text.strip(),
                "token_count_without_overlap": tok,
                "section_title": "Untitled",
                "section_index": 0,
                "paragraph_start_index": 0,
                "paragraph_end_index": 0,
                "sentence_start_index": 0,
                "sentence_end_index": 0,
                "overlap_prev_tokens": 0,
                "overlap_next_tokens": 0,
                "is_hard_split": False,
                "document_id": document_id,
            }
        ]

    # 5. Rebalance to eliminate tiny tails
    raw_chunks = rebalance_chunks(tokenizer, raw_chunks, config)

    # 6. Inject overlap and build output dicts
    results = inject_overlap(tokenizer, raw_chunks, config)

    # 7. Stamp document_id
    for r in results:
        r["document_id"] = document_id

    return results


# ── LightRAG-compatible factory ────────────────────────────────────────────────


def make_book_chunker(
    config: BookChunkerConfig | None = None,
    chunk_cache: dict[str, list[dict[str, Any]]] | None = None,
) -> Callable:
    """
    Return a chunking function compatible with LightRAG's chunking_func parameter.

    Args:
        config: Book chunker configuration. Defaults to BookChunkerConfig.from_env().
        chunk_cache: Optional pre-computed chunk cache keyed by MD5 hex digest
            of the document content.
    """
    cfg = config or BookChunkerConfig.from_env()

    def chunking_func(
        tokenizer,
        content: str,
        split_by_character=None,
        split_by_character_only=False,
        chunk_overlap_token_size=100,
        chunk_token_size=1200,
    ) -> list[dict[str, Any]]:
        if chunk_cache is not None:
            content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()
            cached = chunk_cache.get(content_hash)
            if cached is not None:
                return cached
        return chunk_book_document(tokenizer, content, cfg)

    return chunking_func
