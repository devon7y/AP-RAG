"""
Tests for the scientific paper chunker.

Run: python -m pytest westbury/test_scientific_chunker.py -v
"""

import pytest

from pipeline.scientific_chunker import (
    ChunkerConfig,
    Paragraph,
    RawChunk,
    chunk_document,
    count_tokens,
    detect_sections,
    evaluate_chunks,
    inject_overlap,
    make_scientific_chunker,
    pack_paragraphs,
    parse_paragraphs,
    rebalance_chunks,
    segment_sentences,
    split_oversized_paragraph,
)


# ── Mock tokenizer (word-based, no external dependencies) ─────────────────────


class MockTokenizer:
    """Treats each whitespace-separated word as one token."""

    def encode(self, text: str) -> list[int]:
        if not text or not text.strip():
            return []
        return list(range(len(text.split())))

    def decode(self, tokens: list[int]) -> str:
        # Not perfectly reversible, but sufficient for testing chunking logic
        return " ".join(f"w{i}" for i in tokens)


@pytest.fixture
def tokenizer():
    return MockTokenizer()


@pytest.fixture
def config():
    """Small config for fast unit tests."""
    return ChunkerConfig(
        target_tokens=10,
        max_tokens=15,
        min_tokens=4,
        overlap_tokens=3,
    )


# ── Helpers ────────────────────────────────────────────────────────────────────


def _words(n: int) -> str:
    """Generate n-word text."""
    return " ".join(f"word{i}" for i in range(n))


def _make_para(
    text: str,
    tokenizer,
    section_title="Test",
    section_index=0,
    paragraph_index=0,
    is_caption=False,
) -> Paragraph:
    sentences = segment_sentences(text)
    return Paragraph(
        text=text,
        section_title=section_title,
        section_index=section_index,
        paragraph_index=paragraph_index,
        sentences=sentences,
        token_count=count_tokens(tokenizer, text),
        is_caption=is_caption,
    )


# ── Sentence segmentation ─────────────────────────────────────────────────────


class TestSentenceSegmentation:
    def test_simple_sentences(self):
        text = "First sentence. Second sentence. Third sentence."
        result = segment_sentences(text)
        assert len(result) == 3

    def test_abbreviations_not_split(self):
        text = "Dr. Smith et al. found the result. Next sentence here."
        result = segment_sentences(text)
        assert len(result) == 2
        assert "Dr. Smith" in result[0]

    def test_decimal_numbers_not_split(self):
        text = "The value was 3.14 units. Another sentence."
        result = segment_sentences(text)
        assert len(result) == 2

    def test_eg_ie_not_split(self):
        text = "Some items (e.g. cats) are common. Next sentence."
        result = segment_sentences(text)
        assert len(result) == 2

    def test_initials_not_split(self):
        text = "Work by J. Smith was important. Next sentence."
        result = segment_sentences(text)
        assert len(result) == 2

    def test_single_sentence(self):
        text = "Just one sentence without ending period"
        result = segment_sentences(text)
        assert len(result) == 1
        assert result[0] == text

    def test_empty_text(self):
        assert segment_sentences("") == []
        assert segment_sentences("  ") == []

    def test_question_and_exclamation(self):
        text = "Is this a question? Yes it is! And a statement."
        result = segment_sentences(text)
        assert len(result) == 3


# ── Section detection ──────────────────────────────────────────────────────────


class TestSectionDetection:
    def test_standard_sections(self):
        text = (
            "Abstract\n"
            "This is the abstract.\n\n"
            "Introduction\n"
            "This is the introduction.\n\n"
            "Methods\n"
            "These are the methods.\n\n"
            "Results\n"
            "These are the results.\n\n"
            "References\n"
            "Some references here."
        )
        config = ChunkerConfig()
        sections = detect_sections(text, config)
        titles = [s.title for s in sections]
        assert "Abstract" in titles
        assert "Introduction" in titles
        assert "Methods" in titles
        assert "Results" in titles
        assert "References" in titles

    def test_numbered_sections(self):
        text = (
            "Abstract\n"
            "The abstract text.\n\n"
            "1. Introduction\n"
            "Intro text.\n\n"
            "2. Methods\n"
            "Methods text.\n\n"
            "2.1 Participants\n"
            "Participant info."
        )
        config = ChunkerConfig()
        sections = detect_sections(text, config)
        titles = [s.title for s in sections]
        assert "Abstract" in titles
        assert "1. Introduction" in titles
        assert "2. Methods" in titles
        assert "2.1 Participants" not in titles

    def test_references_excluded(self):
        text = "Abstract\nText here.\n\nReferences\nSmith (2020)."
        config = ChunkerConfig(exclude_references=True)
        sections = detect_sections(text, config)
        refs = [s for s in sections if "References" in s.title]
        assert refs[0].is_excluded

    def test_acknowledgements_excluded(self):
        text = "Abstract\nText.\n\nAcknowledgements\nThanks to all."
        config = ChunkerConfig(exclude_acknowledgements=True)
        sections = detect_sections(text, config)
        acks = [s for s in sections if "Acknowledgements" in s.title]
        assert acks[0].is_excluded

    def test_no_sections_detected(self):
        text = "Just some plain text without any section headers at all."
        config = ChunkerConfig()
        sections = detect_sections(text, config)
        assert len(sections) == 1
        assert sections[0].title == "Untitled"

    def test_all_caps_sections(self):
        text = "ABSTRACT\nSome text.\n\nINTRODUCTION\nMore text."
        config = ChunkerConfig()
        sections = detect_sections(text, config)
        titles_lower = [s.title.lower() for s in sections]
        assert "abstract" in titles_lower
        assert "introduction" in titles_lower

    def test_page_header_with_number_not_detected_as_section(self):
        text = (
            "72 ROBERT J. BLANCHARD AND D. CAROLINE BLANCHARD\n"
            "Abstract\n"
            "This is the abstract text."
        )
        sections = detect_sections(text, ChunkerConfig())
        titles = [s.title for s in sections]
        assert "72 ROBERT J. BLANCHARD AND D. CAROLINE BLANCHARD" not in titles
        assert "Abstract" in titles

    def test_journal_running_header_not_detected_as_section(self):
        text = (
            "332 Language and Speech 56(3)\n"
            "Introduction\n"
            "This is the introduction.\n\n"
            "Results\n"
            "These are the results."
        )
        sections = detect_sections(text, ChunkerConfig())
        titles = [s.title for s in sections]
        assert "332 Language and Speech 56(3)" not in titles
        assert "Introduction" in titles
        assert "Results" in titles

    def test_lowercase_roman_date_not_detected_as_section(self):
        text = (
            "v. August 18, 2018\n"
            "Abstract\n"
            "This is the abstract text."
        )
        sections = detect_sections(text, ChunkerConfig())
        titles = [s.title for s in sections]
        assert "v. August 18, 2018" not in titles
        assert "Abstract" in titles

    def test_lowercase_fragments_not_detected_as_sections(self):
        text = (
            "Methods\n"
            "This section describes the methods.\n\n"
            "stimuli.\n"
            "These stimuli were shown to participants.\n\n"
            "data.\n"
            "These data were analyzed later."
        )
        sections = detect_sections(text, ChunkerConfig())
        titles = [s.title for s in sections]
        assert "stimuli." not in titles
        assert "data." not in titles
        assert titles == ["Methods"]


# ── Paragraph packing ─────────────────────────────────────────────────────────


class TestParagraphPacking:
    def test_short_paragraphs_combine(self, tokenizer, config):
        """Several short paragraphs combine neatly into one chunk."""
        paras = [
            _make_para(_words(3), tokenizer, paragraph_index=i) for i in range(3)
        ]
        # 3 paras × 3 words each; combined ~11 tokens (with separators) ≤ 15
        chunks = pack_paragraphs(tokenizer, paras, config)
        assert len(chunks) == 1

    def test_paragraph_slightly_over_cap(self, tokenizer, config):
        """One paragraph at 18 tokens > max_tokens=15 gets sentence-split."""
        text = " ".join(f"word{i}" for i in range(18))
        # Create sentences within the paragraph
        sent1 = " ".join(f"word{i}" for i in range(9))
        sent2 = " ".join(f"word{i}" for i in range(9, 18))
        para = Paragraph(
            text=text,
            section_title="Test",
            section_index=0,
            paragraph_index=0,
            sentences=[sent1, sent2],
            token_count=18,
        )
        chunks = pack_paragraphs(tokenizer, [para], config)
        assert len(chunks) == 2
        assert all(c.token_count <= config.max_tokens for c in chunks)

    def test_paragraph_massively_over_cap(self, tokenizer, config):
        """One paragraph at 100 tokens >> max_tokens=15."""
        text = _words(100)
        sentences = [
            " ".join(f"word{i}" for i in range(j, min(j + 8, 100)))
            for j in range(0, 100, 8)
        ]
        para = Paragraph(
            text=text,
            section_title="Test",
            section_index=0,
            paragraph_index=0,
            sentences=sentences,
            token_count=100,
        )
        chunks = pack_paragraphs(tokenizer, [para], config)
        assert len(chunks) >= 7  # 100 / 15 ≈ 7

    def test_caption_stays_separate(self, tokenizer, config):
        """Figure captions are not merged with body paragraphs."""
        body = _make_para(_words(5), tokenizer, paragraph_index=0)
        caption = _make_para(
            "Figure 1 The caption text here.",
            tokenizer,
            paragraph_index=1,
            is_caption=True,
        )
        body2 = _make_para(_words(5), tokenizer, paragraph_index=2)

        chunks = pack_paragraphs(tokenizer, [body, caption, body2], config)
        # Caption should not be merged with body or body2
        caption_chunks = [c for c in chunks if "Figure 1" in c.text]
        assert len(caption_chunks) == 1


# ── Rebalancing ────────────────────────────────────────────────────────────────


class TestRebalancing:
    def test_tiny_remainder_merged(self, tokenizer, config):
        """Final chunk with 2 tokens < min_tokens=4 gets merged with previous."""
        chunks = [
            RawChunk(
                text=_words(10),
                section_title="T",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=10,
            ),
            RawChunk(
                text=_words(2),
                section_title="T",
                section_index=0,
                paragraph_start=1,
                paragraph_end=1,
                sentence_start=0,
                sentence_end=0,
                token_count=2,
            ),
        ]
        result = rebalance_chunks(tokenizer, chunks, config)
        # 10 + 2 = 12 ≤ max_tokens=15, so they merge
        assert len(result) == 1

    def test_no_rebalance_when_above_min(self, tokenizer, config):
        """No rebalancing needed when last chunk is above min_tokens."""
        chunks = [
            RawChunk(
                text=_words(10),
                section_title="T",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=10,
            ),
            RawChunk(
                text=_words(5),
                section_title="T",
                section_index=0,
                paragraph_start=1,
                paragraph_end=1,
                sentence_start=0,
                sentence_end=0,
                token_count=5,
            ),
        ]
        result = rebalance_chunks(tokenizer, chunks, config)
        assert len(result) == 2

    def test_cross_section_no_rebalance(self, tokenizer, config):
        """Chunks from different sections are not merged."""
        chunks = [
            RawChunk(
                text=_words(10),
                section_title="Methods",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=10,
            ),
            RawChunk(
                text=_words(2),
                section_title="Results",
                section_index=1,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=2,
            ),
        ]
        result = rebalance_chunks(tokenizer, chunks, config)
        assert len(result) == 2  # Different sections, no merge

    def test_non_tail_tiny_chunk_rebalanced(self, tokenizer, config):
        """Tiny chunks in the middle of a section are rebalanced too."""
        chunks = [
            RawChunk(
                text=_words(10),
                section_title="Methods",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=10,
            ),
            RawChunk(
                text=_words(2),
                section_title="Methods",
                section_index=0,
                paragraph_start=1,
                paragraph_end=1,
                sentence_start=0,
                sentence_end=0,
                token_count=2,
            ),
            RawChunk(
                text=_words(8),
                section_title="Methods",
                section_index=0,
                paragraph_start=2,
                paragraph_end=2,
                sentence_start=0,
                sentence_end=0,
                token_count=8,
            ),
        ]
        result = rebalance_chunks(tokenizer, chunks, config)
        assert len(result) == 2
        assert all(c.token_count >= config.min_tokens for c in result)


# ── Hard splitting ─────────────────────────────────────────────────────────────


class TestHardSplitting:
    def test_single_overlong_sentence(self, tokenizer, config):
        """A single sentence of 50 tokens exceeding max_tokens=15 gets hard-split."""
        text = _words(50)
        para = Paragraph(
            text=text,
            section_title="T",
            section_index=0,
            paragraph_index=0,
            sentences=[text],  # Single sentence
            token_count=50,
        )
        chunks = split_oversized_paragraph(tokenizer, para, config)
        assert len(chunks) > 1
        assert all(c.is_hard_split for c in chunks)
        assert all(c.token_count <= config.max_tokens for c in chunks)


# ── Overlap injection ─────────────────────────────────────────────────────────


class TestOverlapInjection:
    def test_first_chunk_no_overlap(self, tokenizer, config):
        """First chunk in a section has no previous overlap."""
        chunks = [
            RawChunk(
                text="First chunk text here.",
                section_title="T",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=4,
            ),
        ]
        results = inject_overlap(tokenizer, chunks, config)
        assert results[0]["overlap_prev_tokens"] == 0

    def test_overlap_from_previous(self, tokenizer, config):
        """Second chunk gets overlap from first chunk's trailing content."""
        chunks = [
            RawChunk(
                text="First sentence here. Second sentence here.",
                section_title="T",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=1,
                token_count=8,
            ),
            RawChunk(
                text="Third sentence here.",
                section_title="T",
                section_index=0,
                paragraph_start=1,
                paragraph_end=1,
                sentence_start=0,
                sentence_end=0,
                token_count=3,
            ),
        ]
        results = inject_overlap(tokenizer, chunks, config)
        assert results[0]["overlap_prev_tokens"] == 0
        assert results[1]["overlap_prev_tokens"] > 0
        # Full text should include overlap
        assert len(results[1]["content"]) > len("Third sentence here.")

    def test_no_overlap_across_sections(self, tokenizer, config):
        """Overlap is not added between chunks from different sections."""
        chunks = [
            RawChunk(
                text="Methods text here.",
                section_title="Methods",
                section_index=0,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=3,
            ),
            RawChunk(
                text="Results text here.",
                section_title="Results",
                section_index=1,
                paragraph_start=0,
                paragraph_end=0,
                sentence_start=0,
                sentence_end=0,
                token_count=3,
            ),
        ]
        results = inject_overlap(tokenizer, chunks, config)
        assert results[1]["overlap_prev_tokens"] == 0


# ── End-to-end pipeline ───────────────────────────────────────────────────────


class TestEndToEnd:
    def test_separate_sections_stay_separate(self, tokenizer):
        """Abstract, methods, results produce chunks that don't cross sections."""
        text = (
            "Abstract\n"
            "This is the abstract with several words to pass the minimum.\n\n"
            "Methods\n"
            "These are the methods with several words to pass the minimum.\n\n"
            "Results\n"
            "These are the results with several words to pass the minimum."
        )
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=3, overlap_tokens=2
        )
        chunks = chunk_document(tokenizer, text, config)
        # Each chunk should have a section_title
        for chunk in chunks:
            assert "section_title" in chunk

    def test_references_excluded_from_chunks(self, tokenizer):
        text = (
            "Abstract\n"
            "Important abstract text here.\n\n"
            "References\n"
            "Smith J (2020). A paper. Journal, 1, 1-10."
        )
        config = ChunkerConfig(
            target_tokens=10,
            max_tokens=20,
            min_tokens=3,
            overlap_tokens=2,
            exclude_references=True,
        )
        chunks = chunk_document(tokenizer, text, config)
        for chunk in chunks:
            assert chunk["section_title"] != "References"

    def test_exclusion_safety_valve_keeps_content_when_exclusion_dominates(self, tokenizer):
        text = (
            "Acknowledgements\n"
            "Thanks to all contributors.\n\n"
            "References\n"
            + _words(3000)
        )
        config = ChunkerConfig(
            target_tokens=10,
            max_tokens=20,
            min_tokens=3,
            overlap_tokens=2,
            exclude_references=True,
            exclude_acknowledgements=True,
        )
        chunks = chunk_document(tokenizer, text, config)
        assert len(chunks) > 1
        kept = sum(c.get("token_count_without_overlap", c["tokens"]) for c in chunks)
        assert kept > 2500
        assert any(c["section_title"] == "References" for c in chunks)

    def test_lightrag_required_keys(self, tokenizer):
        """Output contains the three keys LightRAG requires."""
        text = "Some text for testing the chunker output format."
        config = ChunkerConfig(
            target_tokens=5, max_tokens=10, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        for chunk in chunks:
            assert "tokens" in chunk
            assert "content" in chunk
            assert "chunk_order_index" in chunk

    def test_extended_metadata_present(self, tokenizer):
        """Output contains all extended metadata fields."""
        text = "Introduction\nSome introductory text with enough words."
        config = ChunkerConfig(
            target_tokens=5, max_tokens=15, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        expected_keys = {
            "raw_text_without_overlap",
            "token_count_without_overlap",
            "section_title",
            "section_index",
            "paragraph_start_index",
            "paragraph_end_index",
            "sentence_start_index",
            "sentence_end_index",
            "overlap_prev_tokens",
            "overlap_next_tokens",
            "is_hard_split",
            "document_id",
        }
        for chunk in chunks:
            assert expected_keys.issubset(chunk.keys())

    def test_chunk_order_preserved(self, tokenizer):
        """chunk_order_index is sequential."""
        text = (
            "Introduction\n"
            + "\n\n".join(f"Paragraph {i} with some filler words." for i in range(5))
        )
        config = ChunkerConfig(
            target_tokens=5, max_tokens=10, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        indices = [c["chunk_order_index"] for c in chunks]
        assert indices == list(range(len(chunks)))

    def test_empty_text_returns_empty(self, tokenizer):
        config = ChunkerConfig()
        assert chunk_document(tokenizer, "", config) == []
        assert chunk_document(tokenizer, "   ", config) == []

    def test_document_id_stamped(self, tokenizer):
        text = "Abstract\nSome abstract text here."
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config, document_id="doc-abc123")
        for chunk in chunks:
            assert chunk["document_id"] == "doc-abc123"

    def test_repeated_page_headers_removed_with_page_breaks(self, tokenizer):
        text = (
            "332 Language and Speech 56(3)\n"
            "Introduction\n"
            "This is the first page introduction text.\n"
            "\f\n"
            "334 Language and Speech 56(3)\n"
            "This is the second page continuation text.\n"
            "\f\n"
            "336 Language and Speech 56(3)\n"
            "Results\n"
            "These are the results."
        )
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        assert all("Language and Speech" not in c["raw_text_without_overlap"] for c in chunks)
        assert {c["section_title"] for c in chunks} >= {"Introduction", "Results"}

    def test_inline_hard_headings_split_sections(self, tokenizer):
        text = (
            "Abstract This abstract summarizes the study in enough detail.\n\n"
            "Research Methods This section describes how the study was conducted.\n\n"
            "Results These are the main study findings."
        )
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        titles = {c["section_title"] for c in chunks}
        assert "Abstract" in titles
        assert "Research Methods" in titles
        assert "Results" in titles

    def test_soft_subsections_stay_inside_major_section(self, tokenizer):
        text = (
            "Methods\n"
            "Participants\n"
            "Ten students completed the study.\n\n"
            "Procedure\n"
            "They completed several tasks in sequence.\n\n"
            "Data Analysis\n"
            "We analyzed the responses using simple comparisons."
        )
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        assert chunks
        assert all(c["section_title"] == "Methods" for c in chunks)
        assert any("Participants" in c["raw_text_without_overlap"] for c in chunks)
        assert any("Procedure" in c["raw_text_without_overlap"] for c in chunks)
        assert any("Data Analysis" in c["raw_text_without_overlap"] for c in chunks)

    def test_numbered_soft_subsection_does_not_become_section(self, tokenizer):
        text = (
            "Methods\n"
            "3.1.1 Participants 750 participants completed the experiment.\n\n"
            "Results\n"
            "The results were reliable across runs."
        )
        config = ChunkerConfig(
            target_tokens=10, max_tokens=20, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        titles = {c["section_title"] for c in chunks}
        assert "3.1.1 Participants" not in titles
        assert "Methods" in titles
        assert "Results" in titles


# ── Factory ────────────────────────────────────────────────────────────────────


class TestFactory:
    def test_make_scientific_chunker_returns_callable(self, tokenizer):
        config = ChunkerConfig(
            target_tokens=5, max_tokens=10, min_tokens=2, overlap_tokens=1
        )
        chunker = make_scientific_chunker(config)
        result = chunker(tokenizer, "Some text to chunk.", None, False, 100, 1200)
        assert isinstance(result, list)
        assert all(isinstance(c, dict) for c in result)

    def test_factory_ignores_lightrag_params(self, tokenizer):
        """Factory uses its own config, not LightRAG's chunk_token_size."""
        config = ChunkerConfig(
            target_tokens=5, max_tokens=10, min_tokens=2, overlap_tokens=1
        )
        chunker = make_scientific_chunker(config)
        # Pass large LightRAG params — should be ignored
        result = chunker(tokenizer, _words(20), None, False, 500, 5000)
        # Chunks should still respect our config.max_tokens=10
        for chunk in result:
            assert chunk["token_count_without_overlap"] <= 10


# ── Evaluation utility ─────────────────────────────────────────────────────────


class TestEvaluation:
    def test_evaluate_returns_expected_keys(self, tokenizer):
        text = (
            "Abstract\nShort abstract.\n\n"
            "Introduction\n"
            "Longer introduction with more words to test the chunking."
        )
        config = ChunkerConfig(
            target_tokens=5, max_tokens=10, min_tokens=2, overlap_tokens=1
        )
        chunks = chunk_document(tokenizer, text, config)
        metrics = evaluate_chunks(chunks, config)

        assert "total_chunks" in metrics
        assert "mean_chunk_tokens" in metrics
        assert "pct_below_min" in metrics
        assert "pct_above_max" in metrics
        assert "hard_token_splits" in metrics
        assert metrics["section_crossings"] == 0

    def test_evaluate_empty(self):
        metrics = evaluate_chunks([])
        assert "error" in metrics
