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


# ── Efficiency layers (docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md P1/P2) ──────────

from pipeline.contextual_retrieval import context_cache_key  # noqa: E402


def _chunks(n=4):
    return [{"content": f"chunk {i}", "chunk_order_index": i} for i in range(n)]


class _RecordingLLM:
    """Async LLM stub recording concurrency, kwargs, and warm-up ordering."""

    def __init__(self, delay=0.01):
        self.calls = []
        self.kwargs = []
        self.active = 0
        self.max_active = 0
        self.first_done_before_others = None
        self._first_finished = False
        self.delay = delay

    async def __call__(self, prompt, **kwargs):
        started_after_first = self._first_finished
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.calls.append(prompt)
        self.kwargs.append(kwargs)
        await asyncio.sleep(self.delay)
        self.active -= 1
        if len(self.calls) == 1:
            self._first_finished = True
        elif self.first_done_before_others is None:
            self.first_done_before_others = started_after_first
        return f"CTX{len(self.calls)}"


def test_cache_second_run_makes_no_llm_calls():
    cache, stats = {}, {}
    llm = _RecordingLLM()
    chunker = make_contextualizing_chunker(
        lambda *a: _chunks(), llm,
        cache_get=cache.get, cache_put=cache.__setitem__, cache_salt="m1",
    )
    first = _run(chunker)
    assert len(llm.calls) == 4 and len(cache) == 4

    llm2 = _RecordingLLM()
    chunker2 = make_contextualizing_chunker(
        lambda *a: _chunks(), llm2,
        cache_get=cache.get, cache_put=cache.__setitem__, cache_salt="m1",
        stats=stats,
    )
    second = _run(chunker2)
    assert len(llm2.calls) == 0                     # fully served from cache
    assert stats["context_cache_hits"] == 4
    assert [c["content"] for c in second] == [c["content"] for c in first]


def test_cache_salt_prevents_stale_blurb_reuse():
    cache = {}
    chunker = make_contextualizing_chunker(
        lambda *a: _chunks(), _RecordingLLM(),
        cache_get=cache.get, cache_put=cache.__setitem__, cache_salt="model-A",
    )
    _run(chunker)
    llm_b = _RecordingLLM()
    chunker_b = make_contextualizing_chunker(
        lambda *a: _chunks(), llm_b,
        cache_get=cache.get, cache_put=cache.__setitem__, cache_salt="model-B",
    )
    _run(chunker_b)
    assert len(llm_b.calls) == 4  # different salt → cache miss, fresh blurbs
    p = CONTEXT_PROMPT.format(doc_content="d", chunk_content="c")
    assert context_cache_key(p, "model-A") != context_cache_key(p, "model-B")


def test_warm_first_serializes_first_chunk_before_fanout():
    llm = _RecordingLLM()
    chunker = make_contextualizing_chunker(lambda *a: _chunks(), llm, warm_first=True)
    _run(chunker)
    assert len(llm.calls) == 4
    # The first (prefix-warming) call fully completed before any other started.
    assert llm.first_done_before_others is True


def test_shared_semaphore_caps_across_documents():
    llm = _RecordingLLM(delay=0.02)
    sem = asyncio.Semaphore(1)

    async def two_docs():
        chunker = make_contextualizing_chunker(
            lambda *a: _chunks(), llm, semaphore=sem, warm_first=False,
        )
        await asyncio.gather(
            chunker(None, "doc A", None, False, 51, 512),
            chunker(None, "doc B", None, False, 51, 512),
        )

    asyncio.run(two_docs())
    assert len(llm.calls) == 8
    assert llm.max_active == 1  # a true GLOBAL cap, not per-document


def test_llm_kwargs_and_per_doc_affinity():
    llm = _RecordingLLM()
    chunker = make_contextualizing_chunker(
        lambda *a: _chunks(), llm,
        llm_kwargs={"max_tokens": 300}, use_affinity=True, warm_first=False,
    )
    _run(chunker, doc="document alpha")
    affinities = {kw["_endpoint_affinity"] for kw in llm.kwargs}
    assert len(affinities) == 1 and isinstance(next(iter(affinities)), int)
    assert all(kw["max_tokens"] == 300 for kw in llm.kwargs)
    _run(chunker, doc="a completely different document")
    assert len({kw["_endpoint_affinity"] for kw in llm.kwargs}) == 2


def test_all_cached_with_warm_first_makes_zero_calls():
    cache = {}
    chunker = make_contextualizing_chunker(
        lambda *a: _chunks(), _RecordingLLM(),
        cache_get=cache.get, cache_put=cache.__setitem__, warm_first=True,
    )
    _run(chunker)
    llm2 = _RecordingLLM()
    chunker2 = make_contextualizing_chunker(
        lambda *a: _chunks(), llm2,
        cache_get=cache.get, cache_put=cache.__setitem__, warm_first=True,
    )
    out = _run(chunker2)
    assert len(llm2.calls) == 0
    assert len(out) == 4 and all(c["content"].startswith("CTX") for c in out)


def test_failed_blurbs_are_not_cached():
    cache = {}

    async def boom(prompt, **kwargs):
        raise RuntimeError("endpoint down")

    chunker = make_contextualizing_chunker(
        lambda *a: _chunks(1), boom,
        cache_get=cache.get, cache_put=cache.__setitem__,
    )
    out = _run(chunker)
    assert out[0]["content"] == "chunk 0"
    assert cache == {}  # failures must never poison the persistent cache
