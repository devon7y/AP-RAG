"""Unit tests for the Contextual Retrieval wrapper (contextual_retrieval.py).

These are fast, dependency-free tests (stdlib only) — run from inside westbury/:
    python -m pytest test_contextual_retrieval.py -v

They lock in behavioural parity with the former in-library `_contextualize_chunks`
patch: situating-context prepend, graceful per-chunk fallback, document-context cap,
concurrency bound, and sync/async inner-chunker support.
"""

import asyncio

from pipeline.contextual_retrieval import CONTEXT_PROMPT, make_contextualizing_chunker


def _run(chunker, doc="full document text"):
    return asyncio.run(chunker(None, doc, None, False, 100, 1000))


def test_prepends_context_and_preserves_other_fields():
    async def fake_llm(prompt):
        return "  SITUATING CONTEXT  "  # whitespace should be stripped

    def inner(tok, content, *a):
        return [
            {"content": "chunk one", "tokens": 2, "chunk_order_index": 0},
            {"content": "chunk two", "tokens": 2, "chunk_order_index": 1},
        ]

    out = _run(make_contextualizing_chunker(inner, fake_llm, max_async=2))
    assert out[0]["content"] == "SITUATING CONTEXT\n\nchunk one"
    assert out[1]["content"] == "SITUATING CONTEXT\n\nchunk two"
    # Non-content fields must survive untouched.
    assert out[0]["tokens"] == 2 and out[0]["chunk_order_index"] == 0
    assert out[1]["chunk_order_index"] == 1


def test_prompt_contains_document_and_chunk():
    seen = {}

    async def fake_llm(prompt):
        seen["prompt"] = prompt
        return "ctx"

    def inner(tok, content, *a):
        return [{"content": "the chunk body"}]

    _run(make_contextualizing_chunker(inner, fake_llm), doc="THE WHOLE DOCUMENT")
    assert "THE WHOLE DOCUMENT" in seen["prompt"]
    assert "the chunk body" in seen["prompt"]
    # Sanity: we use the exact carried-over prompt template.
    assert seen["prompt"] == CONTEXT_PROMPT.format(
        doc_content="THE WHOLE DOCUMENT", chunk_content="the chunk body"
    )


def test_fallback_to_original_on_llm_error():
    async def boom(prompt):
        raise RuntimeError("endpoint down")

    def inner(tok, content, *a):
        return [{"content": "original content"}]

    out = _run(make_contextualizing_chunker(inner, boom))
    assert out[0]["content"] == "original content"


def test_empty_context_keeps_original():
    async def blank_llm(prompt):
        return "   "  # strips to empty -> no prepend

    def inner(tok, content, *a):
        return [{"content": "keep me"}]

    out = _run(make_contextualizing_chunker(inner, blank_llm))
    assert out[0]["content"] == "keep me"


def test_doc_cap_tuple_and_on_doc_callback():
    captured, stats = {}, []

    async def fake_llm(prompt):
        captured["prompt"] = prompt
        return "ctx"

    def inner(tok, content, *a):
        return [{"content": "c"}]

    def cap(text):
        return ("CAPPED DOC", True)

    chunker = make_contextualizing_chunker(
        inner, fake_llm, cap_doc_content=cap, on_doc=lambda t: stats.append(t)
    )
    _run(chunker, doc="a very long original document " * 100)
    assert "CAPPED DOC" in captured["prompt"]
    assert "very long original document" not in captured["prompt"]
    assert stats == [True]


def test_doc_cap_plain_string_return():
    captured = {}

    async def fake_llm(prompt):
        captured["prompt"] = prompt
        return "ctx"

    def inner(tok, content, *a):
        return [{"content": "c"}]

    chunker = make_contextualizing_chunker(
        inner, fake_llm, cap_doc_content=lambda t: "PLAIN CAP"
    )
    _run(chunker)
    assert "PLAIN CAP" in captured["prompt"]


def test_empty_chunk_list_makes_no_llm_calls():
    calls = []

    async def fake_llm(prompt):
        calls.append(1)
        return "ctx"

    def inner(tok, content, *a):
        return []

    out = _run(make_contextualizing_chunker(inner, fake_llm))
    assert out == []
    assert calls == []


def test_blank_chunk_is_skipped():
    calls = []

    async def fake_llm(prompt):
        calls.append(1)
        return "ctx"

    def inner(tok, content, *a):
        return [{"content": "   "}, {"content": "real chunk"}]

    out = _run(make_contextualizing_chunker(inner, fake_llm))
    assert out[0]["content"] == "   "           # blank left untouched
    assert out[1]["content"] == "ctx\n\nreal chunk"
    assert len(calls) == 1                        # only the real chunk hit the LLM


def test_async_inner_chunker_is_awaited():
    async def fake_llm(prompt):
        return "ctx"

    async def inner(tok, content, *a):
        return [{"content": "x"}]

    out = _run(make_contextualizing_chunker(inner, fake_llm))
    assert out[0]["content"] == "ctx\n\nx"


def test_concurrency_is_bounded_by_max_async():
    state = {"cur": 0, "peak": 0}

    async def fake_llm(prompt):
        state["cur"] += 1
        state["peak"] = max(state["peak"], state["cur"])
        await asyncio.sleep(0.01)
        state["cur"] -= 1
        return "ctx"

    def inner(tok, content, *a):
        return [{"content": f"chunk {i}"} for i in range(12)]

    _run(make_contextualizing_chunker(inner, fake_llm, max_async=3))
    assert state["peak"] <= 3


def test_inner_chunker_exception_propagates():
    """A chunker error (e.g. the SIGALRM chunk-timeout) must not be swallowed."""

    async def fake_llm(prompt):
        return "ctx"

    def inner(tok, content, *a):
        raise RuntimeError("chunker hung")

    try:
        _run(make_contextualizing_chunker(inner, fake_llm))
    except RuntimeError as e:
        assert "chunker hung" in str(e)
    else:
        raise AssertionError("expected inner chunker error to propagate")
