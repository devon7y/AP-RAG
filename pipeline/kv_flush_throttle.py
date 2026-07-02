"""Throttle LightRAG's per-document full-file storage flushes (wrapper-side).

The problem (docs/INGEST_CONCURRENCY_PLAN.md Fix 1, "biggest win"): LightRAG 1.5.3
calls ``index_done_callback()`` on EVERY storage after EVERY document
(``pipeline.py::_insert_done``), and the JSON/GraphML file backends rewrite their
ENTIRE file on each call — ``kv_store_llm_response_cache.json`` (hundreds of MB),
``kv_store_text_chunks.json``, ``kv_store_full_docs.json`` and
``graph_chunk_entity_relation.graphml`` (322 MB at ~1.5k docs) included. Over a
9.7k-doc corpus that is O(N²) bytes written, plus a multi-second synchronous
``json.dump``/``write_graphml`` on the event loop per document late in the run.
``JsonDocStatusStorage.upsert`` additionally self-flushes on every status change.

This module fixes it from the AP-RAG wrapper side — **no files under LightRAG/ are
edited**. After the ``LightRAG`` instance is constructed, ``install()`` replaces the
``index_done_callback`` *bound attribute* on each file-rewriting storage instance
with a throttled version: a real flush happens at most once per ``interval_s``
seconds, and when it does, ALL wrapped storages flush together in a strict order:

    data stores first (full_docs, text_chunks, entity/relation KVs, graph,
    llm_response_cache) → doc_status LAST.

Crash-consistency invariant: ``doc_status`` (the resume source of truth) is never
newer on disk than the data stores. A hard kill (SIGKILL / walltime) between ticks
loses at most the last interval's in-memory state, so on resume those documents
simply re-process (cheap once the contextualization + extraction caches hit). The
reverse — a document marked processed on disk whose chunks/graph were lost — cannot
happen.

What is NOT throttled:
  * Vector DBs (Qdrant/Nano) — their flush is where deferred embeddings actually
    happen, not a file rewrite; deferring them saves nothing and delays failure
    surfacing.
  * Non-file backends (Redis/Postgres via KV_STORAGE) — their flushes are already
    incremental; only ``JsonKVStorage`` / ``JsonDocStatusStorage`` /
    ``NetworkXStorage`` instances are wrapped.

Single-process only: the ingest is one process (PDF-extraction subprocesses never
touch storage). Do not use under LightRAG's multi-process server, where other
workers rely on the cross-process flush protocol.

Usage (see pipeline/ingest.py):
    throttle = KVFlushThrottle.install(rag, interval_s=300)
    try:
        ...run pipeline...
    finally:
        if throttle:
            await throttle.flush_all(final=True)   # BEFORE rag.finalize_storages()
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Optional

# Storage attributes flushed by LightRAG's _insert_done, in the order we flush them.
# doc_status is intentionally LAST (see module docstring). Missing attributes are
# skipped, so this stays compatible if a future LightRAG renames or drops one.
_DATA_STORE_ATTRS = (
    "full_docs",
    "text_chunks",
    "full_entities",
    "full_relations",
    "entity_chunks",
    "relation_chunks",
    "chunk_entity_relation_graph",
    "llm_response_cache",
)
_STATUS_ATTR = "doc_status"

# Only wrap the full-file-rewrite implementations. Anything else (Redis, Postgres,
# Qdrant, …) flushes incrementally and must keep its native behaviour.
_FILE_BACKED_CLASS_NAMES = {
    "JsonKVStorage",
    "JsonDocStatusStorage",
    "NetworkXStorage",
}


class KVFlushThrottle:
    """Interval-throttled, strictly-ordered flusher for file-backed storages."""

    def __init__(self, interval_s: float):
        self.interval_s = float(interval_s)
        self._ordered: list[tuple[str, Callable[[], Any]]] = []  # (name, original cb)
        self._lock = asyncio.Lock()
        self._last_flush = time.monotonic()
        self._final = False
        self.stats = {"flush_ticks": 0, "flush_skips": 0}

    @property
    def wrapped_names(self) -> list[str]:
        return [name for name, _ in self._ordered]

    # ── wiring ──────────────────────────────────────────────────────────────

    @classmethod
    def install(cls, rag: Any, interval_s: float) -> Optional["KVFlushThrottle"]:
        """Wrap the file-backed storages on ``rag``. Returns None if nothing to wrap
        or ``interval_s`` <= 0 (throttling disabled — upstream per-doc behaviour)."""
        if interval_s <= 0:
            return None
        self = cls(interval_s)
        for attr in (*_DATA_STORE_ATTRS, _STATUS_ATTR):
            storage = getattr(rag, attr, None)
            if storage is None:
                continue
            if type(storage).__name__ not in _FILE_BACKED_CLASS_NAMES:
                continue
            original = storage.index_done_callback  # bound method
            self._ordered.append((attr, original))
            # Instance-attribute assignment shadows the bound method — upstream
            # code paths (per-doc _insert_done, doc_status.upsert's self-flush,
            # finalize) all route through the throttle from here on.
            storage.index_done_callback = self._make_wrapped()
        if not self._ordered:
            return None
        return self

    def _make_wrapped(self):
        async def wrapped_index_done_callback() -> None:
            if self._final:
                # After the final flush, behave like upstream so LightRAG's own
                # finalize/shutdown paths persist any last dirty state directly.
                await self._flush_ordered()
                return
            await self._maybe_tick()

        return wrapped_index_done_callback

    # ── flushing ────────────────────────────────────────────────────────────

    async def _flush_ordered(self) -> None:
        """Run every original callback in data→status order. Each original checks
        its own dirty flag, so clean storages are no-ops. Exceptions propagate —
        matching upstream ``_insert_done`` semantics (a failed flush must surface,
        not be swallowed)."""
        for _name, original in self._ordered:
            await original()

    async def _maybe_tick(self) -> None:
        if time.monotonic() - self._last_flush < self.interval_s:
            self.stats["flush_skips"] += 1
            return
        async with self._lock:
            if time.monotonic() - self._last_flush < self.interval_s:
                self.stats["flush_skips"] += 1
                return
            await self._flush_ordered()
            self._last_flush = time.monotonic()
            self.stats["flush_ticks"] += 1

    async def flush_all(self, final: bool = False) -> None:
        """Force an ordered flush now. With ``final=True`` the throttle also enters
        passthrough mode (every later callback flushes directly), so LightRAG's own
        ``finalize_storages()`` keeps its persistence guarantees."""
        async with self._lock:
            if final:
                self._final = True
            await self._flush_ordered()
            self._last_flush = time.monotonic()
            self.stats["flush_ticks"] += 1
