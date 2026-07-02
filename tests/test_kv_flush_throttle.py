"""Unit tests for the KV flush throttle (pipeline/kv_flush_throttle.py).

Verifies the wrapper-side fix for LightRAG 1.5.3's per-document full-file
rewrites: interval throttling, the strict data→doc_status flush order (the
crash-consistency invariant), passthrough after the final flush, and that
non-file backends are left untouched.
"""

import asyncio
import types

from pipeline.kv_flush_throttle import KVFlushThrottle

FLUSH_LOG: list[str] = []


def _make_storage(class_name: str, label: str):
    """Instance whose type NAME matches LightRAG's file-backed classes."""
    cls = type(class_name, (), {})
    inst = cls()

    async def index_done_callback():
        FLUSH_LOG.append(label)

    inst.index_done_callback = index_done_callback
    return inst


def _make_rag(extra_attrs=None):
    rag = types.SimpleNamespace()
    rag.full_docs = _make_storage("JsonKVStorage", "full_docs")
    rag.text_chunks = _make_storage("JsonKVStorage", "text_chunks")
    rag.chunk_entity_relation_graph = _make_storage("NetworkXStorage", "graph")
    rag.llm_response_cache = _make_storage("JsonKVStorage", "llm_cache")
    rag.doc_status = _make_storage("JsonDocStatusStorage", "doc_status")
    for k, v in (extra_attrs or {}).items():
        setattr(rag, k, v)
    return rag


def run(coro):
    return asyncio.run(coro)


def test_install_disabled_for_nonpositive_interval():
    assert KVFlushThrottle.install(_make_rag(), interval_s=0) is None
    assert KVFlushThrottle.install(_make_rag(), interval_s=-5) is None


def test_non_file_backends_are_not_wrapped():
    redis_like = _make_storage("RedisKVStorage", "redis")
    original_cb = redis_like.index_done_callback
    rag = _make_rag()
    rag.llm_response_cache = redis_like
    throttle = KVFlushThrottle.install(rag, interval_s=1000)
    assert "llm_response_cache" not in throttle.wrapped_names
    assert rag.llm_response_cache.index_done_callback is original_cb


def test_callbacks_are_throttled_within_interval():
    FLUSH_LOG.clear()
    rag = _make_rag()
    throttle = KVFlushThrottle.install(rag, interval_s=1000)

    async def scenario():
        # Simulate several per-document _insert_done rounds.
        for _ in range(5):
            await rag.full_docs.index_done_callback()
            await rag.text_chunks.index_done_callback()
            await rag.llm_response_cache.index_done_callback()
            await rag.doc_status.index_done_callback()

    run(scenario())
    assert FLUSH_LOG == []  # nothing flushed inside the interval
    assert throttle.stats["flush_skips"] == 20
    assert throttle.stats["flush_ticks"] == 0


def test_tick_flushes_all_in_order_after_interval():
    FLUSH_LOG.clear()
    rag = _make_rag()
    throttle = KVFlushThrottle.install(rag, interval_s=0.05)

    async def scenario():
        await rag.doc_status.index_done_callback()   # inside interval → skip
        await asyncio.sleep(0.08)
        await rag.text_chunks.index_done_callback()  # past interval → full tick

    run(scenario())
    assert throttle.stats["flush_ticks"] == 1
    # Strict order: data stores first, doc_status LAST.
    assert FLUSH_LOG == ["full_docs", "text_chunks", "graph", "llm_cache", "doc_status"]


def test_flush_all_final_flushes_ordered_then_passthrough():
    FLUSH_LOG.clear()
    rag = _make_rag()
    throttle = KVFlushThrottle.install(rag, interval_s=1000)

    async def scenario():
        await rag.llm_response_cache.index_done_callback()  # throttled no-op
        await throttle.flush_all(final=True)
        FLUSH_LOG.append("--after-final--")
        # After the final flush, wrapped callbacks flush directly so LightRAG's
        # own finalize_storages() keeps its persistence guarantees.
        await rag.llm_response_cache.index_done_callback()

    run(scenario())
    assert FLUSH_LOG[:5] == ["full_docs", "text_chunks", "graph", "llm_cache", "doc_status"]
    assert FLUSH_LOG[5] == "--after-final--"
    # The passthrough call runs the whole ordered flush again (idempotent —
    # real storages check their dirty flag and no-op when clean).
    assert FLUSH_LOG[6:] == ["full_docs", "text_chunks", "graph", "llm_cache", "doc_status"]


def test_missing_attributes_are_skipped():
    rag = types.SimpleNamespace()
    rag.llm_response_cache = _make_storage("JsonKVStorage", "llm_cache")
    throttle = KVFlushThrottle.install(rag, interval_s=1000)
    assert throttle.wrapped_names == ["llm_response_cache"]


def test_flush_exception_propagates():
    rag = _make_rag()

    async def boom():
        raise OSError("disk full")

    rag.text_chunks.index_done_callback = boom
    throttle = KVFlushThrottle.install(rag, interval_s=1000)

    async def scenario():
        try:
            await throttle.flush_all(final=True)
        except OSError as e:
            return str(e)
        return None

    assert run(scenario()) == "disk full"  # failures surface, matching upstream
