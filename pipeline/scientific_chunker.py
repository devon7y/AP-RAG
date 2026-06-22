"""
Structure-aware scientific paper chunker for LightRAG.

Replaces LightRAG's default fixed-length token chunker with a structure-aware
chunker that respects section, paragraph, and sentence boundaries.

Hierarchy of preferred split boundaries: section > paragraph > sentence > token.

Integration:
    from pipeline.scientific_chunker import make_scientific_chunker, ChunkerConfig

    rag = LightRAG(
        chunking_func=make_scientific_chunker(ChunkerConfig(target_tokens=800)),
        ...
    )

Environment variables (used by ChunkerConfig.from_env()):
    CHUNK_TARGET_TOKENS  (default 800)
    CHUNK_MAX_TOKENS     (default 1000)
    CHUNK_MIN_TOKENS     (default 300)
    CHUNK_OVERLAP_TOKENS (default 150)
    CHUNK_EXCLUDE_REFS   (default 1)
    CHUNK_EXCLUDE_ACK    (default 1)
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


# ── Configuration ──────────────────────────────────────────────────────────────


@dataclass
class ChunkerConfig:
    """All thresholds for the scientific chunker."""

    target_tokens: int = 800
    max_tokens: int = 1000
    min_tokens: int = 300
    overlap_tokens: int = 150
    respect_sections: bool = True
    respect_paragraphs: bool = True
    split_oversize_paragraphs_by_sentence: bool = True
    exclude_references: bool = True
    exclude_acknowledgements: bool = True
    strip_repeated_page_furniture: bool = True
    exclusion_safety_valve: bool = True

    @classmethod
    def from_env(cls) -> ChunkerConfig:
        return cls(
            target_tokens=int(os.environ.get("CHUNK_TARGET_TOKENS", 800)),
            max_tokens=int(os.environ.get("CHUNK_MAX_TOKENS", 1000)),
            min_tokens=int(os.environ.get("CHUNK_MIN_TOKENS", 300)),
            overlap_tokens=int(os.environ.get("CHUNK_OVERLAP_TOKENS", 150)),
            exclude_references=os.environ.get("CHUNK_EXCLUDE_REFS", "1") == "1",
            exclude_acknowledgements=os.environ.get("CHUNK_EXCLUDE_ACK", "1") == "1",
            exclusion_safety_valve=os.environ.get("CHUNK_EXCLUSION_SAFETY", "1") == "1",
        )


# ── Data structures ────────────────────────────────────────────────────────────


@dataclass
class Paragraph:
    text: str
    section_title: str
    section_index: int
    paragraph_index: int
    sentences: list[str] = field(default_factory=list)
    token_count: int = 0
    is_caption: bool = False


@dataclass
class Section:
    title: str
    index: int
    text: str
    paragraphs: list[Paragraph] = field(default_factory=list)
    is_excluded: bool = False


@dataclass
class RawChunk:
    """Intermediate chunk before overlap injection."""

    text: str
    section_title: str
    section_index: int
    paragraph_start: int
    paragraph_end: int
    sentence_start: int
    sentence_end: int
    token_count: int
    is_hard_split: bool = False


# ── Tokenizer protocol ────────────────────────────────────────────────────────


class Tokenizer(Protocol):
    def encode(self, text: str) -> list[int]: ...
    def decode(self, tokens: list[int]) -> str: ...


# ── Token counting ─────────────────────────────────────────────────────────────


def count_tokens(tokenizer: Tokenizer, text: str) -> int:
    """Count tokens using the provided tokenizer."""
    if not text or not text.strip():
        return 0
    return len(tokenizer.encode(text))


# ── Sentence segmentation ─────────────────────────────────────────────────────

_ABBREVS = frozenset(
    {
        "dr",
        "mr",
        "mrs",
        "ms",
        "prof",
        "jr",
        "sr",
        "vs",
        "etc",
        "al",
        "fig",
        "figs",
        "eq",
        "eqs",
        "ref",
        "refs",
        "vol",
        "no",
        "nos",
        "pp",
        "approx",
        "ca",
        "cf",
        "ed",
        "eds",
        "est",
        "dept",
        "inc",
        "corp",
        "univ",
        "assoc",
        "natl",
        "intl",
        "govt",
        "resp",
        "gen",
        "st",
        "ave",
        "blvd",
    }
)

# Sentence-ending punctuation followed by whitespace then uppercase/digit/bracket
_SENT_SPLIT = re.compile(
    r"(?<=[.!?])"  # After sentence-ending punctuation
    r"(?:\s+)"  # Whitespace
    r"(?=[A-Z\d\"'(\[])"  # Before uppercase, digit, quote, or bracket
)


def segment_sentences(text: str) -> list[str]:
    """Split text into sentences using rules tuned for scientific English."""
    if not text or not text.strip():
        return []

    # Normalize whitespace (preserve meaning, not layout)
    text = re.sub(r"\s+", " ", text).strip()

    candidates = list(_SENT_SPLIT.finditer(text))
    if not candidates:
        return [text]

    sentences = []
    prev_end = 0

    for match in candidates:
        split_pos = match.start()

        # ── Guard: abbreviation before period ──
        before = text[max(0, split_pos - 30) : split_pos]
        word_match = re.search(r"(\w+)\.$", before)
        if word_match and word_match.group(1).lower() in _ABBREVS:
            continue

        # ── Guard: "e.g." / "i.e." ──
        if re.search(r"(?:e\.g|i\.e)\.$", before):
            continue

        # ── Guard: decimal number ("3.14") ──
        if split_pos > 0 and text[split_pos - 1] == ".":
            char_before_dot = text[split_pos - 2] if split_pos >= 2 else ""
            after = text[match.end() : match.end() + 1] if match.end() < len(text) else ""
            if char_before_dot.isdigit() and after.isdigit():
                continue

        # ── Guard: single-letter initial ("J. Smith") ──
        if split_pos >= 2 and text[split_pos - 1] == "." and text[split_pos - 2].isupper():
            if split_pos < 3 or not text[split_pos - 3].isalpha():
                continue

        sentence = text[prev_end : split_pos].strip()
        if sentence:
            sentences.append(sentence)
        prev_end = match.end()

    remainder = text[prev_end:].strip()
    if remainder:
        sentences.append(remainder)

    return sentences if sentences else [text]


# ── Section detection ──────────────────────────────────────────────────────────

_KNOWN_SECTIONS = frozenset(
    {
        "abstract",
        "introduction",
        "background",
        "related work",
        "literature review",
        "theoretical framework",
        "theory",
        "methods",
        "method",
        "methodology",
        "materials and methods",
        "experimental setup",
        "experimental design",
        "research methods",
        "experiment",
        "experiments",
        "data",
        "dataset",
        "datasets",
        "data collection",
        "participants",
        "subjects",
        "sample",
        "procedure",
        "measures",
        "instruments",
        "materials",
        "stimuli",
        "apparatus",
        "analysis",
        "data analysis",
        "statistical analysis",
        "results",
        "findings",
        "discussion",
        "general discussion",
        "conclusion",
        "conclusions",
        "concluding remarks",
        "summary",
        "summary and conclusions",
        "limitations",
        "future work",
        "future directions",
        "implications",
        "practical implications",
        "theoretical implications",
        "acknowledgements",
        "acknowledgments",
        "acknowledgement",
        "acknowledgment",
        "references",
        "bibliography",
        "works cited",
        "literature cited",
        "appendix",
        "appendices",
        "supplementary",
        "supplementary materials",
        "supplementary material",
        "supporting information",
    }
)

_HARD_SECTIONS = frozenset(
    {
        "abstract",
        "introduction",
        "background",
        "related work",
        "literature review",
        "theoretical framework",
        "theory",
        "methods",
        "method",
        "methodology",
        "materials and methods",
        "experimental setup",
        "experimental design",
        "research methods",
        "experiment",
        "experiments",
        "results",
        "findings",
        "discussion",
        "general discussion",
        "conclusion",
        "conclusions",
        "concluding remarks",
        "summary",
        "summary and conclusions",
        "limitations",
        "future work",
        "future directions",
        "implications",
        "practical implications",
        "theoretical implications",
        "acknowledgements",
        "acknowledgments",
        "acknowledgement",
        "acknowledgment",
        "references",
        "bibliography",
        "works cited",
        "literature cited",
        "appendix",
        "appendices",
        "supplementary",
        "supplementary materials",
        "supplementary material",
        "supporting information",
    }
)

_EXCLUDED_SECTIONS = frozenset(
    {
        "references",
        "bibliography",
        "works cited",
        "literature cited",
    }
)

_ACK_SECTIONS = frozenset(
    {
        "acknowledgements",
        "acknowledgments",
        "acknowledgement",
        "acknowledgment",
    }
)

# Strips any number prefix (digits only — roman numerals handled separately below)
_NUM_PREFIX = re.compile(r"^(\d+(?:\.\d+)*\.?\s+)")

# Requires a dot after the number — used for catch-all numbered-header detection
# to avoid matching page headers like "72 Author Name". Uppercase roman numerals
# only, to avoid matching "v. August" (common date format).
_NUM_PREFIX_DOT = re.compile(r"^(\d+(?:\.\d+)*\.\s+|[IVX]+\.\s+)")

# Chapter-level headers: "Chapter 1", "Chapter 1. Title", "CHAPTER TWO"
_CHAPTER_HEADER = re.compile(
    r"^chapter\s+"
    r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[ivx]+)"
    r"[.:]?",
    re.IGNORECASE,
)

# Splits at sentence-ending punctuation immediately before a numbered section
# header that is embedded mid-line (e.g. "...word.  2. Method The next ...").
_INLINE_SECTION_BOUNDARY = re.compile(
    r"(?<=[\.\!\?])\s{1,5}(?=\d+(?:\.\d+)*\.\s+[A-Z])"
)

# TOC entry guard: title ends with whitespace then a bare page number (e.g. "Title 24").
_TOC_TRAILING_PAGE = re.compile(r"\s+\d+\s*$")

_CAPTION_START = re.compile(
    r"^(?:Figure|Fig\.|Table|Plate|Chart|Scheme)\s+\d",
    re.IGNORECASE,
)

_PAGE_PREFIX = re.compile(r"^(?:\d+|[ivxlcdm]+)\.?\s+", re.IGNORECASE)
_PAGE_NUMBER_ONLY = re.compile(r"^(?:\d+|[ivxlcdm]+)\.?\s*$", re.IGNORECASE)
_MONTH_NAME = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)\b",
    re.IGNORECASE,
)
_DOI_OR_URL = re.compile(r"\b(?:doi:|https?://|www\.)", re.IGNORECASE)
_JOURNALISH = re.compile(
    r"\b(?:journal|vol\.?|volume|issue|copyright|permissions|sagepub|"
    r"science direct|sciencedirect|language and speech|cognition|omeg[ao])\b",
    re.IGNORECASE,
)
_INLINE_SECTION_TITLES = sorted(_KNOWN_SECTIONS, key=lambda s: (-len(s.split()), -len(s)))
_INLINE_CONNECTORS = frozenset({"a", "an", "and", "for", "in", "of", "on", "the", "to", "with"})


def _normalize_title_core(title: str) -> str:
    """Normalize a section title for matching."""
    title_lower = title.lower().rstrip(".:")
    num_match = _NUM_PREFIX.match(title_lower)
    if num_match:
        title_lower = title_lower[num_match.end() :].strip()
    return title_lower


def _header_kind_for_title(title: str) -> str:
    """Classify a normalized title as hard, soft, or none."""
    normalized = _normalize_title_core(title)
    if normalized in _HARD_SECTIONS:
        return "hard"
    if normalized in _KNOWN_SECTIONS:
        return "soft"
    return "none"


def _normalize_page_furniture_line(line: str) -> str:
    """Normalize boundary lines so repeated running headers compare equal."""
    stripped = re.sub(r"\s+", " ", line.strip())
    if not stripped:
        return ""
    stripped = _PAGE_PREFIX.sub("", stripped)
    stripped = re.sub(r"\s+\d+\s*$", "", stripped)
    return stripped.casefold()


def _looks_like_page_furniture(line: str) -> bool:
    """Heuristic for page headers/footers and page numbers."""
    stripped = re.sub(r"\s+", " ", line.strip())
    if not stripped:
        return False
    if _PAGE_NUMBER_ONLY.fullmatch(stripped):
        return True

    normalized = _normalize_page_furniture_line(stripped)
    if not normalized or normalized in _KNOWN_SECTIONS:
        return False

    upper_words = sum(word.isupper() for word in re.findall(r"[A-Za-z]+", stripped))
    total_words = len(re.findall(r"[A-Za-z]+", stripped))

    if _MONTH_NAME.search(stripped):
        return True
    if _DOI_OR_URL.search(stripped):
        return True
    if _JOURNALISH.search(stripped):
        return True
    if stripped[0].isdigit() and total_words <= 12:
        return True
    if total_words and upper_words / total_words >= 0.6:
        return True
    return False


def _strip_repeated_page_furniture(text: str, config: ChunkerConfig) -> str:
    """Remove repeated page headers/footers while preserving page flow."""
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
            if _PAGE_NUMBER_ONLY.fullmatch(stripped) or normalized in removable:
                start += 1
                continue
            break

        while end >= start:
            stripped = lines[end].strip()
            normalized = _normalize_page_furniture_line(stripped)
            if not stripped:
                end -= 1
                continue
            if _PAGE_NUMBER_ONLY.fullmatch(stripped) or normalized in removable:
                end -= 1
                continue
            break

        cleaned = "\n".join(lines[start : end + 1]).strip()
        if cleaned:
            cleaned_pages.append(cleaned)

    return "\n".join(cleaned_pages).strip()


def preprocess_extracted_text(text: str, config: ChunkerConfig) -> str:
    """Clean extracted PDF text while preserving page-aware cleanup opportunities."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return ""
    normalized = _strip_repeated_page_furniture(normalized, config)
    return normalized.strip()


def _match_inline_heading(block: str) -> tuple[str, str, str] | None:
    """Detect headings embedded at the start of a paragraph block."""
    collapsed = re.sub(r"\s+", " ", block).strip()
    if not collapsed:
        return None

    prefix_match = _NUM_PREFIX.match(collapsed)
    prefix = prefix_match.group(0) if prefix_match else ""
    remainder = collapsed[len(prefix) :]

    for title in _INLINE_SECTION_TITLES:
        if not remainder.lower().startswith(title):
            continue
        title_text = remainder[: len(title)]
        if title_text.lower() != title:
            continue

        title_words = re.findall(r"[A-Za-z]+", title_text)
        if not title_words:
            continue
        if not title_text.isupper():
            if not all(
                word[0].isupper() or word.lower() in _INLINE_CONNECTORS
                for word in title_words
            ):
                continue

        if remainder[: len(title_text) + 1].endswith("."):
            continue

        rest = remainder[len(title) :].lstrip(" :.-–—")
        if not rest:
            continue
        if not (rest[0].isupper() or rest[0].isdigit() or rest[0] == "("):
            continue

        rendered_title = (prefix + title_text).strip()
        return _header_kind_for_title(rendered_title), rendered_title, rest

    return None


def _build_section(
    title: str,
    index: int,
    blocks: list[str],
    config: ChunkerConfig,
) -> Section | None:
    """Construct a Section from buffered blocks."""
    section_text = "\n\n".join(block for block in blocks if block.strip()).strip()
    if not section_text:
        return None
    return Section(
        title=title,
        index=index,
        text=section_text,
        is_excluded=_should_exclude(title, config),
    )


def _refine_sections_with_inline_headers(
    sections: list[Section], config: ChunkerConfig
) -> list[Section]:
    """Split hard inline headings into sections and preserve soft headings in-place."""
    refined: list[Section] = []
    section_idx = 0

    for section in sections:
        current_title = section.title
        current_blocks: list[str] = []
        blocks = [block for block in re.split(r"\n\s*\n", section.text) if block.strip()]

        for block in blocks:
            inline = _match_inline_heading(block)
            if not inline:
                current_blocks.append(block)
                continue

            kind, title, body = inline
            if kind == "hard":
                built = _build_section(current_title, section_idx, current_blocks, config)
                if built is not None:
                    refined.append(built)
                    section_idx += 1
                current_title = title
                current_blocks = [body]
            else:
                current_blocks.append(f"{title}\n{body}")

        built = _build_section(current_title, section_idx, current_blocks, config)
        if built is not None:
            refined.append(built)
            section_idx += 1

    return refined or sections


def _classify_section_header(line: str) -> tuple[str, str]:
    """
    Return (kind, title) where kind is 'hard', 'soft', or 'none'.

    title may be shorter than the full line when a known section name is
    detected at the start of a long line that also contains body text
    (e.g. "1. Introduction The Sapir-Whorf..."). In that case, the caller
    is responsible for keeping the remainder as body text.
    """
    stripped = line.strip()
    if not stripped:
        return "none", ""

    # ── Long-line fast path ────────────────────────────────────────────────────
    # Lines > 120 chars are almost never standalone section headers, EXCEPT when
    # a numbered prefix is immediately followed by a known section name. Handle
    # that case, then bail for all other long lines.
    if len(stripped) > 120:
        num_match_dot = _NUM_PREFIX_DOT.match(stripped)
        if num_match_dot:
            title_core_dot = stripped[num_match_dot.end():].strip()
            # Check longest known names first (greedy match)
            for name in _INLINE_SECTION_TITLES:
                if title_core_dot.lower().startswith(name):
                    rest = title_core_dot[len(name):]
                    if not rest or rest[0] in (" ", "\t", "\n", ":"):
                        full_title = (stripped[: num_match_dot.end()] + title_core_dot[: len(name)]).strip()
                        return _header_kind_for_title(full_title), full_title
        if _CHAPTER_HEADER.match(stripped):
            ch = _CHAPTER_HEADER.match(stripped)
            return "hard", stripped[: ch.end()].strip()
        return "none", ""

    # ── TOC entry guard ────────────────────────────────────────────────────────
    # Lines that end with two or more spaces followed by a page number are TOC
    # entries (e.g. "1.1. Word Decoding    3"), not real section headers.
    if _TOC_TRAILING_PAGE.search(stripped):
        return "none", ""

    # Strip any leading digit-based number prefix to get the title body
    num_match = _NUM_PREFIX.match(stripped)
    title_core = stripped[num_match.end() :].strip() if num_match else stripped
    normalized_core = title_core.lower().rstrip(".:")

    # Known section name — require the line to start with an uppercase letter or
    # digit to avoid matching lowercase sentence fragments ("stimuli.", "data.").
    if stripped[0].isupper() or stripped[0].isdigit():
        if normalized_core in _KNOWN_SECTIONS:
            return _header_kind_for_title(stripped), stripped

    # All-caps line matching a known section
    if stripped.isupper() and normalized_core in _KNOWN_SECTIONS:
        return _header_kind_for_title(stripped), stripped

    # Numbered header with short capitalized text (e.g. "3.2 Feature Extraction").
    # Require a DOT after the number to avoid matching page headers like
    # "72 Author Name" or "332 Language and Speech 56(3)".
    num_match_dot = _NUM_PREFIX_DOT.match(stripped)
    if num_match_dot:
        title_core_dot = stripped[num_match_dot.end() :].strip()
        normalized_core_dot = title_core_dot.lower().rstrip(".:")
        if normalized_core_dot in _KNOWN_SECTIONS:
            return _header_kind_for_title(stripped), stripped
        if title_core_dot and title_core_dot[0].isupper():
            words = title_core_dot.split()
            depth = num_match_dot.group(0).count(".")
            if 1 <= len(words) <= 15 and not title_core_dot.rstrip().endswith("."):
                # Depth ≤ 2 means N. or N.M. (section/subsection) → hard split.
                # Deeper (N.M.L.) stays soft to avoid over-fragmenting.
                return ("hard" if depth <= 2 else "soft"), stripped

    # Chapter-level headers: "Chapter 1. Title", "CHAPTER ONE", "Chapter 3"
    if _CHAPTER_HEADER.match(stripped):
        return "hard", stripped

    return "none", ""


def _is_section_header(line: str) -> tuple[bool, str]:
    """Return (is_header, title) for a single line."""
    kind, title = _classify_section_header(line)
    return kind == "hard", title


def _should_exclude(title: str, config: ChunkerConfig) -> bool:
    """Check if a section should be excluded from retrieval chunks."""
    title_lower = title.lower().rstrip(".:")
    num_match = _NUM_PREFIX.match(title_lower)
    if num_match:
        title_lower = title_lower[num_match.end() :].strip()

    if config.exclude_references and title_lower in _EXCLUDED_SECTIONS:
        return True
    if config.exclude_acknowledgements and title_lower in _ACK_SECTIONS:
        return True
    return False


def detect_sections(text: str, config: ChunkerConfig) -> list[Section]:
    """Detect major sections from plain text extracted from a scientific PDF."""
    text = preprocess_extracted_text(text, config)
    # Split long lines at sentence boundaries that precede numbered headers.
    # This handles PDFs where section headers are embedded mid-paragraph
    # (e.g. "...previous sentence. 2. Method The next section...").
    text = _INLINE_SECTION_BOUNDARY.sub("\n", text)
    lines = text.split("\n")
    sections: list[Section] = []
    current_title = "Untitled"
    current_lines: list[str] = []
    section_idx = 0

    for line in lines:
        kind, title = _classify_section_header(line)
        if kind == "hard":
            # Flush accumulated lines as a section
            if current_lines:
                section_text = "\n".join(current_lines).strip()
                if section_text:
                    sections.append(
                        Section(
                            title=current_title,
                            index=section_idx,
                            text=section_text,
                            is_excluded=_should_exclude(current_title, config),
                        )
                    )
                    section_idx += 1
            current_title = title
            # When the detected title is shorter than the full line, the remainder
            # is body text belonging to this new section (inline-header case).
            body_remainder = line.strip()[len(title) :].lstrip(" \t:.-–—").strip()
            current_lines = [body_remainder] if body_remainder else []
        else:
            current_lines.append(line)

    # Flush last section
    if current_lines:
        section_text = "\n".join(current_lines).strip()
        if section_text:
            sections.append(
                Section(
                    title=current_title,
                    index=section_idx,
                    text=section_text,
                    is_excluded=_should_exclude(current_title, config),
                )
            )

    if not sections:
        sections = [Section(title="Untitled", index=0, text=text.strip())]

    return _refine_sections_with_inline_headers(sections, config)


# ── Paragraph parsing ──────────────────────────────────────────────────────────


def parse_paragraphs(section: Section, tokenizer: Tokenizer) -> list[Paragraph]:
    """Parse section text into paragraphs with sentence segmentation."""
    raw_blocks = re.split(r"\n\s*\n", section.text)

    paragraphs = []
    for i, block in enumerate(raw_blocks):
        # Join wrapped lines (PDF line breaks within a paragraph)
        text = re.sub(r"\s*\n\s*", " ", block).strip()
        if not text:
            continue

        sentences = segment_sentences(text)
        is_caption = bool(_CAPTION_START.match(text))

        paragraphs.append(
            Paragraph(
                text=text,
                section_title=section.title,
                section_index=section.index,
                paragraph_index=i,
                sentences=sentences,
                token_count=count_tokens(tokenizer, text),
                is_caption=is_caption,
            )
        )

    section.paragraphs = paragraphs
    return paragraphs


# ── Exclusion safety valve ─────────────────────────────────────────────────────


def _should_disable_exclusions(sections: list[Section], config: ChunkerConfig) -> bool:
    """Detect when exclusion heuristics would drop most document content."""
    if not (config.exclude_references or config.exclude_acknowledgements):
        return False

    kept_tokens = 0
    excluded_tokens = 0
    kept_sections = 0
    excluded_sections = 0

    for section in sections:
        if not section.paragraphs:
            continue
        section_tokens = sum(p.token_count for p in section.paragraphs)
        if section.is_excluded:
            excluded_sections += 1
            excluded_tokens += section_tokens
        else:
            kept_sections += 1
            kept_tokens += section_tokens

    total_tokens = kept_tokens + excluded_tokens
    if total_tokens == 0 or excluded_tokens == 0:
        return False

    excluded_ratio = excluded_tokens / total_tokens

    # Catastrophic case: all meaningful text ended up in excluded sections.
    if kept_tokens == 0 and excluded_tokens >= 1000:
        return True

    # Very little retained and most content excluded.
    if excluded_ratio >= 0.80 and kept_tokens <= 2000 and excluded_tokens >= 10000:
        return True

    # Extremely skewed exclusion is suspicious even for medium-length docs.
    if excluded_ratio >= 0.95 and excluded_tokens >= 5000:
        return True

    # Multiple excluded sections but almost no kept sections usually indicates
    # false header detection from running heads / TOC fragments.
    if kept_sections <= 1 and excluded_sections >= 2 and excluded_ratio >= 0.70:
        if excluded_tokens >= 5000:
            return True

    return False


# ── Oversized paragraph splitting ──────────────────────────────────────────────


def split_oversized_paragraph(
    tokenizer: Tokenizer,
    paragraph: Paragraph,
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Split a paragraph that exceeds max_tokens by sentence boundaries."""
    sentences = paragraph.sentences
    if not sentences:
        return _hard_token_split(tokenizer, paragraph, config)

    subchunks: list[RawChunk] = []
    current_sents: list[str] = []
    current_tokens = 0
    sent_start = 0

    for i, sent in enumerate(sentences):
        sent_tokens = count_tokens(tokenizer, sent)

        # Single sentence exceeds max_tokens — hard split
        if sent_tokens > config.max_tokens:
            if current_sents:
                text = " ".join(current_sents)
                subchunks.append(
                    RawChunk(
                        text=text,
                        section_title=paragraph.section_title,
                        section_index=paragraph.section_index,
                        paragraph_start=paragraph.paragraph_index,
                        paragraph_end=paragraph.paragraph_index,
                        sentence_start=sent_start,
                        sentence_end=sent_start + len(current_sents) - 1,
                        token_count=count_tokens(tokenizer, text),
                    )
                )
                current_sents = []
                current_tokens = 0
                sent_start = i

            subchunks.extend(
                _hard_split_text(tokenizer, sent, paragraph, i, config)
            )
            sent_start = i + 1
            continue

        # Would adding this sentence exceed max_tokens?
        if current_sents:
            projected_text = " ".join(current_sents + [sent])
            projected = count_tokens(tokenizer, projected_text)
        else:
            projected = sent_tokens

        if projected > config.max_tokens and current_sents:
            text = " ".join(current_sents)
            subchunks.append(
                RawChunk(
                    text=text,
                    section_title=paragraph.section_title,
                    section_index=paragraph.section_index,
                    paragraph_start=paragraph.paragraph_index,
                    paragraph_end=paragraph.paragraph_index,
                    sentence_start=sent_start,
                    sentence_end=sent_start + len(current_sents) - 1,
                    token_count=count_tokens(tokenizer, text),
                )
            )
            current_sents = []
            current_tokens = 0
            sent_start = i

        current_sents.append(sent)
        current_tokens = count_tokens(tokenizer, " ".join(current_sents))

    # Flush remainder
    if current_sents:
        text = " ".join(current_sents)
        subchunks.append(
            RawChunk(
                text=text,
                section_title=paragraph.section_title,
                section_index=paragraph.section_index,
                paragraph_start=paragraph.paragraph_index,
                paragraph_end=paragraph.paragraph_index,
                sentence_start=sent_start,
                sentence_end=sent_start + len(current_sents) - 1,
                token_count=count_tokens(tokenizer, text),
            )
        )

    # Rebalance if final subchunk is too small
    if len(subchunks) >= 2:
        subchunks = _rebalance_pair(tokenizer, subchunks, config)

    return subchunks


def _hard_split_text(
    tokenizer: Tokenizer,
    text: str,
    paragraph: Paragraph,
    sent_idx: int,
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Hard token-level split for a single oversized sentence."""
    tokens = tokenizer.encode(text)
    chunks = []
    for start in range(0, len(tokens), config.max_tokens):
        end = min(start + config.max_tokens, len(tokens))
        chunk_text = tokenizer.decode(tokens[start:end]).strip()
        if chunk_text:
            chunks.append(
                RawChunk(
                    text=chunk_text,
                    section_title=paragraph.section_title,
                    section_index=paragraph.section_index,
                    paragraph_start=paragraph.paragraph_index,
                    paragraph_end=paragraph.paragraph_index,
                    sentence_start=sent_idx,
                    sentence_end=sent_idx,
                    token_count=end - start,
                    is_hard_split=True,
                )
            )
    return chunks


def _hard_token_split(
    tokenizer: Tokenizer,
    paragraph: Paragraph,
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Hard token-level split for text with no parseable sentence boundaries."""
    tokens = tokenizer.encode(paragraph.text)
    chunks = []
    for start in range(0, len(tokens), config.max_tokens):
        end = min(start + config.max_tokens, len(tokens))
        text = tokenizer.decode(tokens[start:end]).strip()
        if text:
            chunks.append(
                RawChunk(
                    text=text,
                    section_title=paragraph.section_title,
                    section_index=paragraph.section_index,
                    paragraph_start=paragraph.paragraph_index,
                    paragraph_end=paragraph.paragraph_index,
                    sentence_start=0,
                    sentence_end=0,
                    token_count=end - start,
                    is_hard_split=True,
                )
            )
    return chunks


# ── Paragraph packing ─────────────────────────────────────────────────────────


def pack_paragraphs(
    tokenizer: Tokenizer,
    paragraphs: list[Paragraph],
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Pack paragraphs into chunks, respecting size constraints and captions."""
    if not paragraphs:
        return []

    chunks: list[RawChunk] = []
    current_paras: list[Paragraph] = []

    def _flush():
        if current_paras:
            chunks.append(_make_chunk_from_paragraphs(tokenizer, current_paras))

    for para in paragraphs:
        # Captions: always emit separately (never merge with body text)
        if para.is_caption:
            _flush()
            current_paras = []
            if para.token_count <= config.max_tokens:
                chunks.append(_make_chunk_from_paragraphs(tokenizer, [para]))
            else:
                chunks.extend(split_oversized_paragraph(tokenizer, para, config))
            continue

        # Oversized paragraph: flush current, then split by sentence
        if para.token_count > config.max_tokens:
            _flush()
            current_paras = []
            chunks.extend(split_oversized_paragraph(tokenizer, para, config))
            continue

        # Would adding this paragraph exceed max_tokens?
        if current_paras:
            combined = "\n\n".join(p.text for p in current_paras + [para])
            projected = count_tokens(tokenizer, combined)
        else:
            projected = para.token_count

        if projected > config.max_tokens and current_paras:
            _flush()
            current_paras = []

        current_paras.append(para)

    _flush()
    return chunks


def _make_chunk_from_paragraphs(
    tokenizer: Tokenizer, paragraphs: list[Paragraph]
) -> RawChunk:
    """Create a RawChunk from one or more accumulated paragraphs."""
    text = "\n\n".join(p.text for p in paragraphs)
    total_sents = sum(len(p.sentences) for p in paragraphs)

    return RawChunk(
        text=text,
        section_title=paragraphs[0].section_title,
        section_index=paragraphs[0].section_index,
        paragraph_start=paragraphs[0].paragraph_index,
        paragraph_end=paragraphs[-1].paragraph_index,
        sentence_start=0,
        sentence_end=max(total_sents - 1, 0),
        token_count=count_tokens(tokenizer, text),
    )


# ── Rebalancing ────────────────────────────────────────────────────────────────


def _rebalance_pair(
    tokenizer: Tokenizer,
    chunks: list[RawChunk],
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Rebalance two adjacent chunks to eliminate undersized chunks."""
    if len(chunks) < 2:
        return chunks

    left = chunks[-2]
    right = chunks[-1]
    if left.token_count >= config.min_tokens and right.token_count >= config.min_tokens:
        return chunks

    # Option 1: merge entirely
    merged_text = left.text + "\n\n" + right.text
    merged_tokens = count_tokens(tokenizer, merged_text)

    if merged_tokens <= config.max_tokens:
        merged = RawChunk(
            text=merged_text,
            section_title=left.section_title,
            section_index=left.section_index,
            paragraph_start=left.paragraph_start,
            paragraph_end=right.paragraph_end,
            sentence_start=left.sentence_start,
            sentence_end=right.sentence_end,
            token_count=merged_tokens,
        )
        return chunks[:-2] + [merged]

    # Option 2: sentence-level rebalancing
    left_sents = segment_sentences(left.text)
    right_sents = segment_sentences(right.text)
    all_sents = left_sents + right_sents

    if len(all_sents) < 2:
        return chunks

    baseline_split = len(left_sents)
    best_split = baseline_split
    best_score = (
        int(left.token_count < config.min_tokens or right.token_count < config.min_tokens),
        abs(left.token_count - right.token_count),
    )

    for split_at in range(1, len(all_sents)):
        text_a = " ".join(all_sents[:split_at])
        text_b = " ".join(all_sents[split_at:])
        tok_a = count_tokens(tokenizer, text_a)
        tok_b = count_tokens(tokenizer, text_b)

        if tok_a > config.max_tokens or tok_b > config.max_tokens:
            continue

        invalid = int(tok_a < config.min_tokens or tok_b < config.min_tokens)
        score = (invalid, abs(tok_a - tok_b))
        if score < best_score:
            best_score = score
            best_split = split_at

    if best_split != baseline_split:
        text_a = " ".join(all_sents[:best_split])
        text_b = " ".join(all_sents[best_split:])

        chunks[-2] = RawChunk(
            text=text_a,
            section_title=left.section_title,
            section_index=left.section_index,
            paragraph_start=left.paragraph_start,
            paragraph_end=left.paragraph_end,
            sentence_start=left.sentence_start,
            sentence_end=left.sentence_start + best_split - 1,
            token_count=count_tokens(tokenizer, text_a),
        )
        chunks[-1] = RawChunk(
            text=text_b,
            section_title=right.section_title,
            section_index=right.section_index,
            paragraph_start=right.paragraph_start,
            paragraph_end=right.paragraph_end,
            sentence_start=left.sentence_start + best_split,
            sentence_end=right.sentence_end,
            token_count=count_tokens(tokenizer, text_b),
        )

    return chunks


def rebalance_chunks(
    tokenizer: Tokenizer,
    chunks: list[RawChunk],
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Rebalance adjacent chunks within each section to eliminate tiny chunks."""
    if len(chunks) < 2:
        return chunks

    # Group chunk indices by section
    section_groups: dict[int, list[RawChunk]] = {}
    section_order: list[int] = []
    for chunk in chunks:
        if chunk.section_index not in section_groups:
            section_groups[chunk.section_index] = []
            section_order.append(chunk.section_index)
        section_groups[chunk.section_index].append(chunk)

    rebalanced: list[RawChunk] = []

    for section_index in section_order:
        section_chunks = list(section_groups[section_index])
        changed = True
        while changed and len(section_chunks) >= 2:
            changed = False
            i = 0
            while i < len(section_chunks):
                current_small = section_chunks[i].token_count < config.min_tokens
                next_small = (
                    i + 1 < len(section_chunks)
                    and section_chunks[i + 1].token_count < config.min_tokens
                )
                if not current_small and not next_small:
                    i += 1
                    continue

                if current_small and i + 1 < len(section_chunks):
                    pair = [section_chunks[i], section_chunks[i + 1]]
                    updated = _rebalance_pair(tokenizer, pair, config)
                    section_chunks[i : i + 2] = updated
                    actually_changed = len(updated) != len(pair) or any(
                        a.text != b.text for a, b in zip(updated, pair)
                    )
                    if actually_changed:
                        changed = True
                        i = max(i - 1, 0)
                        continue
                    i += 1
                    continue

                if next_small:
                    pair = [section_chunks[i], section_chunks[i + 1]]
                    updated = _rebalance_pair(tokenizer, pair, config)
                    section_chunks[i : i + 2] = updated
                    actually_changed = len(updated) != len(pair) or any(
                        a.text != b.text for a, b in zip(updated, pair)
                    )
                    if actually_changed:
                        changed = True
                        i = max(i - 1, 0)
                        continue
                    i += 1
                    continue

                i += 1

        rebalanced.extend(section_chunks)

    return rebalanced


# ── Overlap injection ──────────────────────────────────────────────────────────


def inject_overlap(
    tokenizer: Tokenizer,
    chunks: list[RawChunk],
    config: ChunkerConfig,
) -> list[dict[str, Any]]:
    """Add sentence-aware overlap from the previous chunk and emit final dicts."""
    if not chunks:
        return []

    hard_cap = config.max_tokens + config.overlap_tokens
    results: list[dict[str, Any]] = []

    for i, chunk in enumerate(chunks):
        overlap_text = ""
        overlap_tok = 0

        # Overlap from previous chunk (same section only)
        if i > 0 and chunks[i - 1].section_index == chunk.section_index:
            prev = chunks[i - 1]
            prev_sents = segment_sentences(prev.text)

            # Prefer whole trailing sentences
            overlap_sents: list[str] = []
            acc = 0
            for sent in reversed(prev_sents):
                st = count_tokens(tokenizer, sent)
                if acc + st > config.overlap_tokens:
                    break
                overlap_sents.insert(0, sent)
                acc += st

            if overlap_sents:
                overlap_text = " ".join(overlap_sents)
                overlap_tok = count_tokens(tokenizer, overlap_text)
            else:
                # Token-level fallback
                prev_tokens = tokenizer.encode(prev.text)
                n = min(config.overlap_tokens, len(prev_tokens))
                if n > 0:
                    overlap_text = tokenizer.decode(prev_tokens[-n:]).strip()
                    overlap_tok = count_tokens(tokenizer, overlap_text)

        # Build full text
        if overlap_text:
            full_text = overlap_text + " " + chunk.text
            full_tokens = count_tokens(tokenizer, full_text)
            # Enforce hard cap
            if full_tokens > hard_cap:
                full_text = chunk.text
                full_tokens = chunk.token_count
                overlap_text = ""
                overlap_tok = 0
        else:
            full_text = chunk.text
            full_tokens = chunk.token_count

        results.append(
            {
                # Required by LightRAG
                "tokens": full_tokens,
                "content": full_text,
                "chunk_order_index": i,
                # Extended metadata
                "raw_text_without_overlap": chunk.text,
                "token_count_without_overlap": chunk.token_count,
                "section_title": chunk.section_title,
                "section_index": chunk.section_index,
                "paragraph_start_index": chunk.paragraph_start,
                "paragraph_end_index": chunk.paragraph_end,
                "sentence_start_index": chunk.sentence_start,
                "sentence_end_index": chunk.sentence_end,
                "overlap_prev_tokens": overlap_tok,
                "overlap_next_tokens": 0,
                "is_hard_split": chunk.is_hard_split,
            }
        )

    return results


# ── Page-number assignment ─────────────────────────────────────────────────────

_PAGE_WS_RE = re.compile(r"\s+")


def _norm_for_match(text: str) -> str:
    """Whitespace-collapsed, lowercased text for substring matching across the
    cleaned-chunk vs raw-page boundary (PDF line breaks become single spaces)."""
    return _PAGE_WS_RE.sub(" ", text or "").strip().lower()


def _assign_page_starts(results: list[dict[str, Any]], original_text: str) -> None:
    """Stamp each chunk with ``page_start`` — the 1-based physical PDF page its text
    begins on — by matching the chunk's opening text against the form-feed-delimited
    pages of the original extraction. ``None`` when undeterminable (no form-feeds in
    the source, or no match). This is a transparent post-pass: it never alters chunk
    text or the existing chunking decisions.
    """
    if not results:
        return
    if "\f" not in (original_text or ""):
        for chunk in results:
            chunk["page_start"] = None
        return
    norm_pages = [_norm_for_match(page) for page in original_text.split("\f")]
    for chunk in results:
        probe = _norm_for_match(
            chunk.get("raw_text_without_overlap") or chunk.get("content") or ""
        )
        page = None
        for width in (90, 45):
            key = probe[:width]
            if not key:
                break
            for i, page_text in enumerate(norm_pages):
                if key in page_text:
                    page = i + 1
                    break
            if page is not None:
                break
        chunk["page_start"] = page


# ── Main chunking pipeline ────────────────────────────────────────────────────


def chunk_document(
    tokenizer: Tokenizer,
    text: str,
    config: ChunkerConfig,
    document_id: str = "",
) -> list[dict[str, Any]]:
    """
    Chunk a scientific paper into structure-aware retrieval chunks.

    Returns list of dicts compatible with LightRAG's chunking_func output.
    Required keys: tokens, content, chunk_order_index.
    """
    if not text or not text.strip():
        return []

    # 1. Detect sections
    sections = detect_sections(text, config)

    # 2. Parse paragraphs within each section
    for section in sections:
        parse_paragraphs(section, tokenizer)

    include_excluded_sections = (
        config.exclusion_safety_valve and _should_disable_exclusions(sections, config)
    )

    # 3. Pack paragraphs into chunks (per section, excluding filtered sections)
    raw_chunks: list[RawChunk] = []
    for section in sections:
        if (section.is_excluded and not include_excluded_sections) or not section.paragraphs:
            continue
        raw_chunks.extend(pack_paragraphs(tokenizer, section.paragraphs, config))

    if not raw_chunks:
        # Fallback: entire text as one chunk
        tok = count_tokens(tokenizer, text.strip())
        results = [
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
        _assign_page_starts(results, text)
        return results

    # 4. Rebalance to eliminate tiny tails
    raw_chunks = rebalance_chunks(tokenizer, raw_chunks, config)

    # 5. Inject overlap and build output dicts
    results = inject_overlap(tokenizer, raw_chunks, config)

    # 6. Stamp document_id and the originating PDF page
    for r in results:
        r["document_id"] = document_id
    _assign_page_starts(results, text)

    return results


# ── LightRAG-compatible factory ────────────────────────────────────────────────


def make_scientific_chunker(
    config: ChunkerConfig | None = None,
    chunk_cache: dict[str, list[dict[str, Any]]] | None = None,
) -> Callable:
    """
    Return a chunking function compatible with LightRAG's chunking_func parameter.

    Args:
        config: Chunker configuration. Defaults to ChunkerConfig.from_env().
        chunk_cache: Optional pre-computed chunk cache keyed by MD5 hex digest
            of the document content. When provided, cache hits return instantly
            (no CPU-bound work), allowing PARALLEL_DOCS > 1 without blocking
            the asyncio event loop.

    Usage:
        rag = LightRAG(
            chunking_func=make_scientific_chunker(ChunkerConfig(target_tokens=800)),
            ...
        )
    """
    cfg = config or ChunkerConfig.from_env()

    def chunking_func(
        tokenizer,
        content: str,
        split_by_character=None,
        split_by_character_only=False,
        chunk_overlap_token_size=100,
        chunk_token_size=1200,
    ) -> list[dict[str, Any]]:
        # NOTE: LightRAG's chunk_overlap_token_size / chunk_token_size are
        # intentionally ignored — chunk geometry comes from ChunkerConfig
        # (the CHUNK_* env vars), not LightRAG's settings.
        if chunk_cache is not None:
            content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()
            cached = chunk_cache.get(content_hash)
            if cached is not None:
                return cached
        return chunk_document(tokenizer, content, cfg)

    return chunking_func


# ── Evaluation utility ─────────────────────────────────────────────────────────


def evaluate_chunks(
    chunks: list[dict[str, Any]],
    config: ChunkerConfig | None = None,
) -> dict[str, Any]:
    """Compute quality metrics for a set of chunked outputs."""
    cfg = config or ChunkerConfig()

    if not chunks:
        return {"error": "no chunks"}

    n = len(chunks)
    tok = [c.get("token_count_without_overlap", c.get("tokens", 0)) for c in chunks]
    tok_overlap = [c.get("tokens", 0) for c in chunks]
    sections = set(c.get("section_title", "unknown") for c in chunks)

    # Paragraph boundary preservation: chunk covers exactly 1 paragraph
    para_preserved = sum(
        1
        for c in chunks
        if c.get("paragraph_start_index") == c.get("paragraph_end_index")
    )

    hard_splits = sum(1 for c in chunks if c.get("is_hard_split", False))

    sorted_tok = sorted(tok)

    return {
        "total_chunks": n,
        "mean_chunk_tokens": round(sum(tok) / n, 1),
        "median_chunk_tokens": sorted_tok[n // 2],
        "min_chunk_tokens": min(tok),
        "max_chunk_tokens": max(tok),
        "mean_tokens_with_overlap": round(sum(tok_overlap) / n, 1),
        "pct_below_min": round(100 * sum(1 for t in tok if t < cfg.min_tokens) / n, 1),
        "pct_above_max": round(100 * sum(1 for t in tok if t > cfg.max_tokens) / n, 1),
        "pct_in_target_range": round(
            100 * sum(1 for t in tok if cfg.min_tokens <= t <= cfg.max_tokens) / n, 1
        ),
        "pct_paragraph_boundaries_preserved": round(100 * para_preserved / n, 1),
        "section_crossings": 0,  # By construction, chunks never cross sections
        "hard_token_splits": hard_splits,
        "unique_sections": len(sections),
        "section_names": sorted(sections),
    }
