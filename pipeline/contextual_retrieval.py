"""Anthropic-style Contextual Retrieval, implemented as a LightRAG *wrapper*.

This is the AP-RAG replacement for the old in-library patch that added
``contextualize_chunks`` directly to ``LightRAG/lightrag/lightrag.py``. Editing the
upstream library makes every LightRAG upgrade a manual merge conflict; expressing the
same behaviour as a wrapper around an injected ``chunking_func`` keeps the nested
``LightRAG/`` checkout patch-free and therefore trivially upgradable (see the project
``CLAUDE.md`` "Why LightRAG is nested" note).

How it works
------------
LightRAG calls ``chunking_func(tokenizer, content, split_by_character,
split_by_character_only, overlap_token_size, max_token_size)`` once per document and
awaits the result if it is a coroutine (``lightrag.apipeline_process_enqueue_documents``
guards the call with ``inspect.isawaitable``). We exploit that: the wrapper runs the
real structure-aware chunker, then — still inside the same call, before LightRAG
embeds the chunks or extracts entities — prepends a short LLM-generated situating
context to each chunk. The returned chunk ``content`` (context + original) is exactly
what LightRAG vectorises and feeds to entity extraction, matching the behaviour the
in-library patch produced.

Behavioural parity with the old patch:
  * identical situating-context prompt,
  * the full-document text placed in the prompt can be capped (``cap_doc_content``)
    to honour ``MAX_DOC_TOKENS`` / the vLLM ``--max-model-len`` limit,
  * a failed contextualization call falls back to the original chunk content.

Efficiency layers (see docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md, P1/P2):
  * **Global concurrency** — ``semaphore`` (shared across ALL in-flight documents)
    makes ``CONTEXT_MAX_ASYNC`` a true global cap. The old per-document semaphore
    allowed ``MAX_PARALLEL_INSERT × CONTEXT_MAX_ASYNC`` concurrent 20k-token prompts,
    which oversubscribed the vLLM KV cache and evicted prefix caches.
  * **Prefix warm-up** — the first *uncached* chunk of a document is contextualized
    alone before the concurrent fan-out. vLLM's prefix cache only reuses KV blocks
    already computed, so firing 30 identical-prefix requests simultaneously prefills
    the same ~20k-token document up to CONTEXT_MAX_ASYNC times. Warming commits the
    document prefix once; the fan-out then hits the cache.
  * **Persistent blurb cache** — ``cache_get``/``cache_put`` hooks (content-addressed
    on the exact prompt + a salt) make re-runs/resumes skip contextualization
    entirely. Because chunk ids and the entity-extraction cache key both derive from
    the *contextualized* content, a stable blurb also restores LightRAG's
    extraction-cache hits across runs.
  * **Endpoint affinity** — with >1 vLLM endpoint, all of a document's context calls
    carry the same ``_endpoint_affinity`` value so the round-robin caller can pin
    them to one endpoint and keep its prefix cache hot (instead of re-prefilling the
    document on every endpoint).

The one intentional difference from the old patch: LightRAG derives each chunk id
from the returned ``content``, so chunk ids are hashed from the *contextualized*
text rather than the raw chunk. Contextualization changes always require a fresh
re-embed anyway, so this is a non-issue in practice.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
from typing import Any, Awaitable, Callable, Optional, Union

logger = logging.getLogger(__name__)

# Exact prompt carried over from the former in-library implementation so retrieval
# behaviour does not drift when switching from the patch to this wrapper.
CONTEXT_PROMPT = (
    "<document>\n{doc_content}\n</document>\n\n"
    "Here is the chunk we want to situate within the whole document:\n"
    "<chunk>\n{chunk_content}\n</chunk>\n\n"
    "Please give a short succinct context to situate this chunk within the "
    "overall document for the purposes of improving search retrieval of the "
    "chunk. Answer only with the succinct context and nothing else."
)

# A LightRAG-compatible chunking_func: (tokenizer, content, split_by_character,
# split_by_character_only, overlap_token_size, max_token_size) -> list[dict] (or awaitable).
ChunkingFunc = Callable[..., Union[list, Awaitable[list]]]
# Async LLM callable, e.g. the ingest round-robin caller: (prompt, ...) -> str.
LLMFunc = Callable[..., Awaitable[Any]]
# Optional document-context cap; returns either the capped text or (text, was_truncated).
CapDocFunc = Callable[[str], Union[str, "tuple[str, bool]"]]


def context_cache_key(prompt: str, salt: str = "") -> str:
    """Content-addressed cache key for one contextualization call.

    The prompt embeds both the (capped) document text and the raw chunk, so the key
    changes whenever either changes — including a MAX_DOC_TOKENS change. ``salt``
    should identify anything else that alters the blurb distribution (LLM model,
    temperature), so switching models never reuses stale blurbs.
    """
    h = hashlib.md5()
    h.update(salt.encode("utf-8"))
    h.update(b"\x00")
    h.update(prompt.encode("utf-8"))
    return h.hexdigest()


def make_contextualizing_chunker(
    inner_chunker: ChunkingFunc,
    llm_func: LLMFunc,
    *,
    max_async: int = 8,
    semaphore: Optional[asyncio.Semaphore] = None,
    cap_doc_content: Optional[CapDocFunc] = None,
    on_doc: Optional[Callable[[bool], None]] = None,
    llm_kwargs: Optional[dict] = None,
    cache_get: Optional[Callable[[str], Optional[str]]] = None,
    cache_put: Optional[Callable[[str, str], None]] = None,
    cache_salt: str = "",
    use_affinity: bool = False,
    warm_first: bool = True,
    stats: Optional[dict] = None,
) -> ChunkingFunc:
    """Wrap ``inner_chunker`` so each produced chunk is prefixed with LLM-generated context.

    Args:
        inner_chunker: the underlying structure-aware ``chunking_func`` (sync or async).
            It is called first and unchanged, so its SIGALRM watchdog / chunk cache / etc.
            keep working exactly as before.
        llm_func: async LLM callable invoked as ``llm_func(prompt, **llm_kwargs)`` —
            typically the same function passed to ``LightRAG(llm_model_func=...)``.
        max_async: max concurrent contextualization LLM calls **per document** when no
            shared ``semaphore`` is given (legacy behaviour).
        semaphore: a shared semaphore making the cap global across all in-flight
            documents. Prefer this: pass ``asyncio.Semaphore(CONTEXT_MAX_ASYNC)`` once.
        cap_doc_content: optional callable to shrink the document text placed in the
            prompt (mirrors ``MAX_DOC_TOKENS``). May return ``text`` or ``(text, truncated)``.
        on_doc: optional callback invoked once per document with ``was_truncated: bool``;
            use it to accumulate cap statistics.
        llm_kwargs: extra kwargs forwarded to every context LLM call (e.g.
            ``{"max_tokens": 300}`` so a runaway blurb can't decode for minutes).
        cache_get / cache_put: persistent blurb cache hooks keyed by
            ``context_cache_key(prompt, cache_salt)``. ``cache_put`` is only called for
            successful, non-empty blurbs.
        cache_salt: extra identity mixed into cache keys (LLM model, temperature, …).
        use_affinity: pass ``_endpoint_affinity=<stable per-doc int>`` to ``llm_func``
            so a multi-endpoint caller can route all of a doc's calls to one endpoint.
        warm_first: contextualize the first uncached chunk alone before the concurrent
            fan-out, committing the document prefix to the vLLM prefix cache once.
        stats: optional dict accumulating ``context_cache_hits`` / ``context_llm_calls``
            / ``context_failures`` counters (for the status monitor).

    Returns:
        An async ``chunking_func`` suitable for ``LightRAG(chunking_func=...)``.
    """
    per_doc_async = max(1, int(max_async))
    if stats is not None:
        stats.setdefault("context_cache_hits", 0)
        stats.setdefault("context_llm_calls", 0)
        stats.setdefault("context_failures", 0)

    def _bump(key: str) -> None:
        if stats is not None:
            stats[key] += 1

    async def contextualizing_chunker(
        tokenizer,
        content,
        split_by_character=None,
        split_by_character_only=False,
        overlap_token_size=128,
        max_token_size=1024,
    ) -> list:
        # 1) Run the real chunker first (sync or async). Errors (e.g. the SIGALRM
        #    chunk-timeout) propagate untouched so LightRAG fails the doc as before.
        result = inner_chunker(
            tokenizer,
            content,
            split_by_character,
            split_by_character_only,
            overlap_token_size,
            max_token_size,
        )
        if inspect.isawaitable(result):
            result = await result
        chunks = list(result)
        if not chunks:
            return chunks

        # 2) Cap the full-document text used inside each prompt (vLLM context limit).
        doc_for_prompt = content
        was_truncated = False
        if cap_doc_content is not None:
            capped = cap_doc_content(content)
            if isinstance(capped, tuple):
                doc_for_prompt, was_truncated = capped
            else:
                doc_for_prompt = capped
        if on_doc is not None:
            on_doc(bool(was_truncated))

        call_kwargs: dict[str, Any] = dict(llm_kwargs or {})
        if use_affinity:
            # One stable value per document: every chunk's call routes to the same
            # endpoint, so the ~20k-token document prefix is prefilled (and cached)
            # on exactly one vLLM instead of once per endpoint.
            call_kwargs["_endpoint_affinity"] = int(
                hashlib.md5(content[:4096].encode("utf-8")).hexdigest()[:8], 16
            )

        sem = semaphore if semaphore is not None else asyncio.Semaphore(per_doc_async)

        async def _contextualize_one(chunk: dict) -> dict:
            original = chunk.get("content", "")
            if not original or not original.strip():
                return chunk
            prompt = CONTEXT_PROMPT.format(
                doc_content=doc_for_prompt, chunk_content=original
            )
            if cache_get is not None:
                key = context_cache_key(prompt, cache_salt)
                cached = cache_get(key)
                if cached:
                    _bump("context_cache_hits")
                    return {**chunk, "content": f"{cached}\n\n{original}"}
            async with sem:
                try:
                    context = await llm_func(prompt, **call_kwargs)
                    context = str(context).strip()
                    _bump("context_llm_calls")
                    if context:
                        if cache_put is not None:
                            cache_put(context_cache_key(prompt, cache_salt), context)
                        return {**chunk, "content": f"{context}\n\n{original}"}
                except Exception as e:  # noqa: BLE001 — never let one chunk fail the doc
                    _bump("context_failures")
                    logger.warning(
                        "Chunk contextualization failed (%s); using original content.", e
                    )
            return chunk

        # 3) Warm the prefix cache: run the FIRST chunk that will actually hit the
        #    LLM by itself, so the shared document prefix is computed and committed
        #    once. Only then fan out the rest concurrently — those calls now reuse
        #    the cached prefix instead of racing N identical ~20k-token prefills.
        out: list[Optional[dict]] = [None] * len(chunks)
        remaining = list(range(len(chunks)))
        if warm_first:
            for i in list(remaining):
                chunk = chunks[i]
                original = chunk.get("content", "")
                if not original or not original.strip():
                    out[i] = chunk
                    remaining.remove(i)
                    continue
                if cache_get is not None:
                    key = context_cache_key(
                        CONTEXT_PROMPT.format(
                            doc_content=doc_for_prompt, chunk_content=original
                        ),
                        cache_salt,
                    )
                    if cache_get(key):
                        continue  # cached chunks don't warm anything — skip ahead
                out[i] = await _contextualize_one(chunk)
                remaining.remove(i)
                break

        if remaining:
            rest = await asyncio.gather(
                *[_contextualize_one(chunks[i]) for i in remaining]
            )
            for i, done in zip(remaining, rest):
                out[i] = done
        return [c for c in out if c is not None]

    return contextualizing_chunker
