"""
Structure-aware scientific paper chunker for LightRAG.

Replaces LightRAG's default fixed-length token chunker with a structure-aware
chunker that respects section, paragraph, and sentence boundaries.

Hierarchy of preferred split boundaries: section > paragraph > sentence > token.

Integration:
    from scientific_chunker import make_scientific_chunker, ChunkerConfig

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

    @classmethod
    def from_env(cls) -> ChunkerConfig:
        return cls(
            target_tokens=int(os.environ.get("CHUNK_TARGET_TOKENS", 800)),
            max_tokens=int(os.environ.get("CHUNK_MAX_TOKENS", 1000)),
            min_tokens=int(os.environ.get("CHUNK_MIN_TOKENS", 300)),
            overlap_tokens=int(os.environ.get("CHUNK_OVERLAP_TOKENS", 150)),
            exclude_references=os.environ.get("CHUNK_EXCLUDE_REFS", "1") == "1",
            exclude_acknowledgements=os.environ.get("CHUNK_EXCLUDE_ACK", "1") == "1",
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

_NUM_PREFIX = re.compile(r"^(\d+(?:\.\d+)*\.?\s+|[IVXivx]+\.\s+)")

_CAPTION_START = re.compile(
    r"^(?:Figure|Fig\.|Table|Plate|Chart|Scheme)\s+\d",
    re.IGNORECASE,
)


def _is_section_header(line: str) -> tuple[bool, str]:
    """Return (is_header, title) for a single line."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False, ""

    # Remove number prefix for matching
    num_match = _NUM_PREFIX.match(stripped)
    title_core = stripped[num_match.end() :].strip() if num_match else stripped

    # Known section name (case-insensitive)
    core_lower = title_core.lower().rstrip(".:")
    if core_lower in _KNOWN_SECTIONS:
        return True, stripped

    # All-caps line matching a known section
    if stripped.isupper() and stripped.lower().rstrip(".:") in _KNOWN_SECTIONS:
        return True, stripped

    # Numbered header with short capitalized text (e.g. "3.2 Feature Extraction")
    if num_match and title_core and title_core[0].isupper():
        words = title_core.split()
        if 1 <= len(words) <= 8 and not title_core.rstrip().endswith("."):
            return True, stripped

    return False, ""


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
    lines = text.split("\n")
    sections: list[Section] = []
    current_title = "Untitled"
    current_lines: list[str] = []
    section_idx = 0

    for line in lines:
        is_header, title = _is_section_header(line)
        if is_header:
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
            current_lines = []
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

    return sections


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
    """If the last chunk is below min_tokens, rebalance with the previous chunk."""
    if len(chunks) < 2:
        return chunks

    last = chunks[-1]
    if last.token_count >= config.min_tokens:
        return chunks

    prev = chunks[-2]

    # Option 1: merge entirely
    merged_text = prev.text + "\n\n" + last.text
    merged_tokens = count_tokens(tokenizer, merged_text)

    if merged_tokens <= config.max_tokens:
        merged = RawChunk(
            text=merged_text,
            section_title=prev.section_title,
            section_index=prev.section_index,
            paragraph_start=prev.paragraph_start,
            paragraph_end=last.paragraph_end,
            sentence_start=prev.sentence_start,
            sentence_end=last.sentence_end,
            token_count=merged_tokens,
        )
        return chunks[:-2] + [merged]

    # Option 2: sentence-level rebalancing
    prev_sents = segment_sentences(prev.text)
    last_sents = segment_sentences(last.text)
    all_sents = prev_sents + last_sents

    if len(all_sents) < 2:
        return chunks

    best_split = len(prev_sents)
    best_balance = abs(prev.token_count - last.token_count)

    for split_at in range(1, len(all_sents)):
        text_a = " ".join(all_sents[:split_at])
        text_b = " ".join(all_sents[split_at:])
        tok_a = count_tokens(tokenizer, text_a)
        tok_b = count_tokens(tokenizer, text_b)

        if tok_a > config.max_tokens or tok_b > config.max_tokens:
            continue
        if tok_b < config.min_tokens:
            continue

        balance = abs(tok_a - tok_b)
        if balance < best_balance:
            best_balance = balance
            best_split = split_at

    if best_split != len(prev_sents):
        text_a = " ".join(all_sents[:best_split])
        text_b = " ".join(all_sents[best_split:])

        chunks[-2] = RawChunk(
            text=text_a,
            section_title=prev.section_title,
            section_index=prev.section_index,
            paragraph_start=prev.paragraph_start,
            paragraph_end=prev.paragraph_end,
            sentence_start=prev.sentence_start,
            sentence_end=prev.sentence_start + best_split - 1,
            token_count=count_tokens(tokenizer, text_a),
        )
        chunks[-1] = RawChunk(
            text=text_b,
            section_title=last.section_title,
            section_index=last.section_index,
            paragraph_start=last.paragraph_start,
            paragraph_end=last.paragraph_end,
            sentence_start=prev.sentence_start + best_split,
            sentence_end=last.sentence_end,
            token_count=count_tokens(tokenizer, text_b),
        )

    return chunks


def rebalance_chunks(
    tokenizer: Tokenizer,
    chunks: list[RawChunk],
    config: ChunkerConfig,
) -> list[RawChunk]:
    """Rebalance the last pair within each section to eliminate tiny tails."""
    if len(chunks) < 2:
        return chunks

    # Group chunk indices by section
    section_groups: dict[int, list[int]] = {}
    for i, chunk in enumerate(chunks):
        section_groups.setdefault(chunk.section_index, []).append(i)

    result = list(chunks)
    remove: set[int] = set()

    for indices in section_groups.values():
        if len(indices) < 2:
            continue
        last_idx = indices[-1]
        prev_idx = indices[-2]

        pair = _rebalance_pair(
            tokenizer,
            [result[prev_idx], result[last_idx]],
            config,
        )
        if len(pair) == 1:
            result[prev_idx] = pair[0]
            remove.add(last_idx)
        else:
            result[prev_idx] = pair[0]
            result[last_idx] = pair[1]

    return [c for i, c in enumerate(result) if i not in remove]


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

    # 3. Pack paragraphs into chunks (per section, excluding filtered sections)
    raw_chunks: list[RawChunk] = []
    for section in sections:
        if section.is_excluded or not section.paragraphs:
            continue
        raw_chunks.extend(pack_paragraphs(tokenizer, section.paragraphs, config))

    if not raw_chunks:
        # Fallback: entire text as one chunk
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

    # 4. Rebalance to eliminate tiny tails
    raw_chunks = rebalance_chunks(tokenizer, raw_chunks, config)

    # 5. Inject overlap and build output dicts
    results = inject_overlap(tokenizer, raw_chunks, config)

    # 6. Stamp document_id
    for r in results:
        r["document_id"] = document_id

    return results


# ── LightRAG-compatible factory ────────────────────────────────────────────────


def make_scientific_chunker(config: ChunkerConfig | None = None) -> Callable:
    """
    Return a chunking function compatible with LightRAG's chunking_func parameter.

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
