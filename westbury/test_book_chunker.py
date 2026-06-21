"""
Tests for the structure-aware book chunker.

Run: python -m pytest westbury/test_book_chunker.py -v
"""

import pytest

from book_chunker import (
    BookChunkerConfig,
    _sanitize_detected_section_title,
    _should_exclude_book,
    chunk_book_document,
    detect_book_sections,
)


class MockTokenizer:
    """Treat each whitespace-separated token as one token."""

    def encode(self, text: str) -> list[int]:
        if not text or not text.strip():
            return []
        return list(range(len(text.split())))

    def decode(self, tokens: list[int]) -> str:
        return " ".join(f"w{i}" for i in tokens)


@pytest.fixture
def tokenizer():
    return MockTokenizer()


def test_multiline_chapter_heading_uses_title_block():
    text = (
        "Chapter 1\n"
        "Felt versus Feigned Funniness:\n"
        "Issues in Coding Smiling and Laughing\n"
        "MARIANNE LAFRANCE\n"
        "A not-infrequent way to begin a treatise on humor is to state that although.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == (
        "Chapter 1 Felt versus Feigned Funniness: Issues in Coding Smiling and Laughing"
    )
    assert sections[0].text.startswith("MARIANNE LAFRANCE")


def test_contents_pages_are_skipped_before_real_chapter():
    text = (
        "Contents\n"
        "Chapter 1 11\n"
        "Chapter 2 23\n"
        "\f"
        "I. The necessity for explicitly restating the question of\n"
        "2. The formal structure of the question of Being\n"
        "Part One\n"
        "\f"
        "Chapter 1\n"
        "Real Chapter Title\n"
        "Body text starts here.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert [section.title for section in sections] == ["Chapter 1 Real Chapter Title"]
    assert sections[0].text == "Body text starts here."


def test_top_of_page_number_and_title_detected_as_boundary():
    text = (
        "18\n"
        "THE ROMANTIC MOVEMENT\n"
        "From the latter part of the eighteenth century to the present day.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "18 THE ROMANTIC MOVEMENT"
    assert sections[0].text.startswith("From the latter part")


def test_top_of_page_numbered_title_without_dot_detected():
    text = (
        "1 Linguistic contributions to the study\n"
        "of mind: past\n"
        "In these lectures, I would like to focus attention on the question.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "1 Linguistic contributions to the study of mind: past"


def test_numbered_title_with_lowercase_continuation_detected():
    text = (
        "2 Linguistic contributions to the study of mind:\n"
        "present\n"
        "One difficulty in the psychological sciences lies in the familiarity of the phenomena.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "2 Linguistic contributions to the study of mind: present"
    assert sections[0].text.startswith(
        "One difficulty in the psychological sciences lies in the familiarity"
    )


def test_single_line_page_start_numbered_title_detected():
    text = (
        "7 Biolinguistics and the human capacity\n"
        "I would like to say a few words about what has come to be called the biolinguistic perspective.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "7 Biolinguistics and the human capacity"
    assert sections[0].text.startswith("I would like to say a few words")


def test_title_only_page_block_detected_as_section():
    text = (
        "Theory of humor and practice of humor research:\n"
        "Editor's notes and thoughts\n"
        "VICTOR RASKIN\n"
        "Introduction\n"
        "This chapter is different than the others.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == (
        "Theory of humor and practice of humor research: Editor's notes and thoughts"
    )
    assert sections[0].text.startswith("VICTOR RASKIN")


def test_page_number_and_author_prefix_are_removed_from_real_subheading():
    text = (
        "Chapter 1\n"
        "First Chapter\n"
        "Opening body text.\n"
        "\f"
        "10 Marianne LaFrance\n"
        "SOCIAL CONTEXT OF SMILING AND LAUGHING\n"
        "Smiling and laughter vary across contexts.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert [section.title for section in sections] == [
        "Chapter 1 First Chapter",
        "SOCIAL CONTEXT OF SMILING AND LAUGHING",
    ]


def test_reference_like_page_top_false_split_is_merged_back():
    text = (
        "Chapter 2\n"
        "Second Chapter\n"
        "Main discussion text.\n"
        "\f"
        "36 Paul E. McGhee\n"
        "Gur, R. C., Packer, I. K., Hungerbuhler, J. P.\n"
        "Further reference details continue here.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "Chapter 2 Second Chapter"
    assert "Gur, R. C., Packer" in sections[0].text


def test_sentence_like_page_top_false_split_is_merged_back():
    text = (
        "Chapter 3\n"
        "Third Chapter\n"
        "Main chapter discussion.\n"
        "\f"
        "It is probably somewhat premature yet to attempt a full-fledged ontologic-\n"
        "Further discussion continues here.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "Chapter 3 Third Chapter"
    assert "It is probably somewhat premature" in sections[0].text


def test_index_like_page_top_title_is_sanitized_and_excluded():
    title = _sanitize_detected_section_title("190 Index semantic interpretation (cont.)")

    assert title == "Index semantic interpretation (cont.)"
    assert _should_exclude_book(title, BookChunkerConfig()) is True


def test_in_body_numbered_list_does_not_create_new_sections():
    text = (
        "Chapter 1\n"
        "The Theme of the Analytic of Dasein\n"
        "We are ourselves the entities to be analysed.\n"
        "1. The essence of this entity lies in its to be.\n"
        "2. That Being which is an issue for this entity is in each case mine.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "Chapter 1 The Theme of the Analytic of Dasein"


def test_running_header_is_not_mistaken_for_section_boundary():
    text = (
        "I. 1 Being and Time 69\n"
        "This is body text continuing the argument on the page.\n"
    )

    sections = detect_book_sections(text, BookChunkerConfig())

    assert len(sections) == 1
    assert sections[0].title == "Untitled"


def test_chunker_starts_chunks_at_detected_section_boundaries(tokenizer):
    text = (
        "Chapter 1\n"
        "First Chapter\n"
        "Alpha beta gamma delta.\n\n"
        "Chapter 2\n"
        "Second Chapter\n"
        "Epsilon zeta eta theta.\n"
    )
    config = BookChunkerConfig(
        target_tokens=100,
        max_tokens=100,
        min_tokens=1,
        overlap_tokens=0,
    )

    chunks = chunk_book_document(tokenizer, text, config)

    assert [chunk["section_title"] for chunk in chunks] == [
        "Chapter 1 First Chapter",
        "Chapter 2 Second Chapter",
    ]
