"""
delete_doc.py — Remove one or more ingested documents from the LightRAG store.

Wraps LightRAG's `adelete_by_doc_id`, which is graph-aware: it deletes the
document, its chunks, and the entities/relationships derived *only* from it,
while *rebuilding* entities/relationships that are shared with surviving
documents (from the cached LLM extraction results — no re-extraction). It also
cleans the vector stores (Qdrant collections when QDRANT_URL is set, else the
NanoVectorDB JSON files). Use it to drop a bad-OCR paper before re-ingesting it.

This script builds the LightRAG instance from `pipeline.ingest`'s own config and
embedding wiring, so the embedding space, Qdrant collection names, and KV /
doc-status backends are identical to how the corpus was ingested.

  Typical "redo a bad-OCR paper" workflow:
    1. python scripts/delete_doc.py Smith_2019.pdf --delete-llm-cache
    2. re-OCR the PDF, drop it back in PAPERS_DIR
    3. resubmit pipeline/ingest.py (resume mode re-ingests it)

Usage:
    python scripts/delete_doc.py <target> [<target> ...] [options]

    <target> may be a doc_id ("doc-abc123...") or a PDF filename / path
    ("Smith_2019.pdf"); filenames are resolved against kv_store_doc_status.json
    by basename.

Options:
    --list               Resolve targets to doc_ids and print, then exit.
    --dry-run            Show what would be deleted without deleting.
    --delete-llm-cache   Also drop cached LLM extractions for the doc's chunks
                         (passes delete_llm_cache=True). Recommended for a redo;
                         re-OCR'd text hashes differently and won't reuse them
                         anyway, so this just avoids orphaned cache entries.
    --yes                Skip the confirmation prompt.

Env: inherits WORKDIR / STORAGE_SUBDIR / QDRANT_URL / EMBED_* / KV_STORAGE /
DOC_STATUS_STORAGE from pipeline.ingest (set the same values used at ingest).

  Optional LLM endpoint (only needed if a *shared* entity must be re-summarized
  during the rebuild — uncommon; most single-doc deletes never call the LLM):
    DELETE_LLM_URL     OpenAI-compatible base URL (e.g. http://localhost:8000/v1
                       on a cluster vLLM node, or an OpenAI endpoint on the PC)
    DELETE_LLM_MODEL   model id (default: pipeline.ingest LLM_MODEL)
    DELETE_LLM_KEY     api key (default: "EMPTY")
  If DELETE_LLM_URL is unset, a placeholder LLM is used that raises a clear
  error *only if* the rebuild actually needs it — the deletion fails loudly
  rather than silently producing a stale summary.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Allow `python scripts/delete_doc.py` from the repo root even without
# `pip install -e .` (which is the normal way the `pipeline` package resolves).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _load_doc_status(storage_dir: Path) -> dict:
    """Load kv_store_doc_status.json (doc_id -> {status, file_path, ...})."""
    f = storage_dir / "kv_store_doc_status.json"
    if not f.exists():
        sys.exit(f"ERROR: {f} not found — is STORAGE_SUBDIR / WORKDIR correct?")
    return json.loads(f.read_text(encoding="utf-8"))


def _resolve_targets(targets: list[str], doc_status: dict) -> list[tuple[str, str, str]]:
    """Map each user target to (doc_id, file_path, status).

    A target is either a doc_id present in doc_status, or a filename/path matched
    against each record's file_path by basename. Unresolved/ambiguous targets
    abort the run so we never delete the wrong document.
    """
    # basename -> list of doc_ids, for filename lookups
    by_name: dict[str, list[str]] = {}
    for doc_id, rec in doc_status.items():
        if not isinstance(rec, dict):
            continue
        fp = rec.get("file_path") or ""
        if fp:
            by_name.setdefault(Path(fp).name, []).append(doc_id)

    resolved: list[tuple[str, str, str]] = []
    errors: list[str] = []
    for t in targets:
        if t in doc_status:
            rec = doc_status[t]
            resolved.append((t, rec.get("file_path", ""), rec.get("status", "?")))
            continue
        name = Path(t).name
        hits = by_name.get(name, [])
        if len(hits) == 1:
            rec = doc_status[hits[0]]
            resolved.append((hits[0], rec.get("file_path", ""), rec.get("status", "?")))
        elif not hits:
            errors.append(f"  {t!r}: no doc_id and no file_path basename match")
        else:
            joined = ", ".join(hits)
            errors.append(f"  {t!r}: ambiguous — {len(hits)} docs match ({joined})")

    if errors:
        sys.exit("ERROR: could not resolve these target(s):\n" + "\n".join(errors))
    return resolved


def _build_llm_func():
    """Real OpenAI-compatible LLM func if DELETE_LLM_URL is set, else a
    placeholder that raises only if the rebuild actually invokes the LLM."""
    url = os.environ.get("DELETE_LLM_URL", "").strip()
    if url:
        from lightrag.llm.openai import openai_complete_if_cache

        import pipeline.ingest as ing

        model = os.environ.get("DELETE_LLM_MODEL", ing.LLM_MODEL)
        key = os.environ.get("DELETE_LLM_KEY", ing.LLM_API_KEY)

        async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
            kwargs.pop("_priority", None)  # role wrapper adds this; the caller rejects it
            return await openai_complete_if_cache(
                model, prompt,
                system_prompt=system_prompt,
                history_messages=history_messages or [],
                api_key=key, base_url=url, **kwargs,
            )

        print(f"LLM (for shared-entity re-summary): {model} @ {url}")
        return llm_func

    async def _no_llm(*args, **kwargs):
        raise RuntimeError(
            "This deletion needs to re-summarize a shared entity, which requires "
            "an LLM, but DELETE_LLM_URL is not set. Re-run with DELETE_LLM_URL "
            "pointing at an OpenAI-compatible endpoint (e.g. a vLLM node or "
            "OpenAI). Nothing was left half-deleted: LightRAG raised before "
            "committing the rebuild."
        )

    print("LLM endpoint: none (DELETE_LLM_URL unset) — shared-entity re-summary "
          "will error if triggered.")
    return _no_llm


async def _run(resolved, delete_llm_cache: bool):
    # Imported here so a bad WORKDIR / missing env fails with a clear message
    # before we touch the store.
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc
    import pipeline.ingest as ing

    rag_kwargs = dict(
        working_dir=str(ing.STORAGE_DIR),
        llm_model_func=_build_llm_func(),
        embedding_func=EmbeddingFunc(
            embedding_dim=ing.EMBEDDING_DIM,
            max_token_size=8192,
            func=ing.local_embed,
            supports_asymmetric=True,
        ),
        embedding_func_max_async=ing.EMBED_FUNC_MAX_ASYNC,
        embedding_batch_num=ing.EMBEDDING_BATCH_NUM,
    )
    # Match ingest's backend selection so we open the same stores/collections.
    if ing.KV_STORAGE:
        rag_kwargs["kv_storage"] = ing.KV_STORAGE
    if ing.DOC_STATUS_STORAGE:
        rag_kwargs["doc_status_storage"] = ing.DOC_STATUS_STORAGE
    if ing.USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
        print(f"Vector store: Qdrant ({ing.QDRANT_URL})")
    else:
        print("Vector store: NanoVectorDB (QDRANT_URL not set)")

    rag = LightRAG(**rag_kwargs)
    await rag.initialize_storages()  # also auto-inits pipeline_status for this workspace

    try:
        failures = 0
        for doc_id, file_path, _status in resolved:
            label = file_path or doc_id
            print(f"\nDeleting {label}  ({doc_id})…", flush=True)
            result = await rag.adelete_by_doc_id(doc_id, delete_llm_cache=delete_llm_cache)
            mark = "OK" if result.status == "success" else result.status.upper()
            print(f"  [{mark}] {result.message}", flush=True)
            if result.status != "success":
                failures += 1
    finally:
        await rag.finalize_storages()

    return failures


def main():
    ap = argparse.ArgumentParser(description="Delete ingested document(s) from the LightRAG store.")
    ap.add_argument("targets", nargs="+", help="doc_id(s) or PDF filename(s)/path(s)")
    ap.add_argument("--list", action="store_true", help="resolve targets and print, then exit")
    ap.add_argument("--dry-run", action="store_true", help="show what would be deleted, then exit")
    ap.add_argument("--delete-llm-cache", action="store_true",
                    help="also drop cached LLM extractions for the doc's chunks")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    # pipeline.ingest reads os.environ["WORKDIR"] at import — surface that clearly.
    try:
        import pipeline.ingest as ing
    except KeyError:
        sys.exit("ERROR: WORKDIR is not set. Export the same WORKDIR/STORAGE_SUBDIR "
                 "(and QDRANT_URL etc.) used at ingest before running this script.")
    except ModuleNotFoundError as e:
        sys.exit(f"ERROR: could not import the pipeline package ({e}). Run from the "
                 "repo root, or `pip install -e .` first.")

    doc_status = _load_doc_status(ing.STORAGE_DIR)
    resolved = _resolve_targets(args.targets, doc_status)

    print(f"Store: {ing.STORAGE_DIR}")
    print(f"Resolved {len(resolved)} document(s):")
    for doc_id, file_path, status in resolved:
        print(f"  {doc_id}  status={status}  {file_path}")

    if args.list:
        return

    if args.dry_run:
        print("\nDry run — nothing deleted.")
        return

    if not args.yes:
        reply = input(f"\nDelete {len(resolved)} document(s) from {ing.STORAGE_DIR.name}? [y/N] ")
        if reply.strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return

    failures = asyncio.run(_run(resolved, delete_llm_cache=args.delete_llm_cache))
    if failures:
        sys.exit(f"\n{failures} deletion(s) did not succeed — see messages above.")
    print("\nDone.")


if __name__ == "__main__":
    main()
