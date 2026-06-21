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
  * concurrency bounded by a semaphore (``max_async`` ← ``CONTEXT_MAX_ASYNC``),
  * a failed contextualization call falls back to the original chunk content.

The one intentional difference: LightRAG derives each chunk id from the returned
``content``, so chunk ids are now hashed from the *contextualized* text rather than the
raw chunk. Contextualization changes always require a fresh re-embed anyway, so this is
a non-issue in practice.
"""

from __future__ import annotations

import asyncio
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


def make_contextualizing_chunker(
    inner_chunker: ChunkingFunc,
    llm_func: LLMFunc,
    *,
    max_async: int = 8,
    cap_doc_content: Optional[CapDocFunc] = None,
    on_doc: Optional[Callable[[bool], None]] = None,
) -> ChunkingFunc:
    """Wrap ``inner_chunker`` so each produced chunk is prefixed with LLM-generated context.

    Args:
        inner_chunker: the underlying structure-aware ``chunking_func`` (sync or async).
            It is called first and unchanged, so its SIGALRM watchdog / chunk cache / etc.
            keep working exactly as before.
        llm_func: async LLM callable invoked as ``llm_func(prompt)`` — typically the same
            function passed to ``LightRAG(llm_model_func=...)``.
        max_async: max concurrent contextualization LLM calls per document.
        cap_doc_content: optional callable to shrink the document text placed in the
            prompt (mirrors ``MAX_DOC_TOKENS``). May return ``text`` or ``(text, truncated)``.
        on_doc: optional callback invoked once per document with ``was_truncated: bool``;
            use it to accumulate cap statistics.

    Returns:
        An async ``chunking_func`` suitable for ``LightRAG(chunking_func=...)``.
    """
    semaphore_size = max(1, int(max_async))

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

        # 3) Contextualize every chunk concurrently, prepending the situating blurb.
        semaphore = asyncio.Semaphore(semaphore_size)

        async def _contextualize_one(chunk: dict) -> dict:
            original = chunk.get("content", "")
            if not original or not original.strip():
                return chunk
            prompt = CONTEXT_PROMPT.format(
                doc_content=doc_for_prompt, chunk_content=original
            )
            async with semaphore:
                try:
                    context = await llm_func(prompt)
                    context = str(context).strip()
                    if context:
                        return {**chunk, "content": f"{context}\n\n{original}"}
                except Exception as e:  # noqa: BLE001 — never let one chunk fail the doc
                    logger.warning(
                        "Chunk contextualization failed (%s); using original content.", e
                    )
            return chunk

        return list(await asyncio.gather(*[_contextualize_one(c) for c in chunks]))

    return contextualizing_chunker
