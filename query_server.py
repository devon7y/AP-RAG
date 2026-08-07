"""
query_server.py — AP-RAG query server (LightRAG + Qdrant + embeddings).

Place at C:\\rag_server\\query_server.py

Run:
    C:\\rag_server\\venv\\Scripts\\python -m uvicorn query_server:app --host 0.0.0.0 --port 8001

Endpoints:
    GET  /health          — liveness check + capability flags
    POST /query           — synthesized answer (LLM over retrieved context)
    POST /retrieve        — structured retrieval only (entities/relationships/chunks), no LLM
    POST /search          — metadata-filtered semantic search → ranked papers
    GET  /papers          — manifest as a table: filter/quick-match/sort/paginate (Paper Database)
    GET  /paper           — full manifest record for one paper (detail drawer)
    POST /embed           — raw query/document embeddings (Atlas of Mind support)
    POST /qsearch         — raw chunk-vector search over Qdrant (Atlas of Mind support)
    POST /vectors         — fetch stored chunk vectors by Qdrant point id (Atlas support)
    POST /paper_centroid  — unit-norm mean vector of one paper's chunks (Atlas support)
    GET  /trends          — corpus trend aggregation (Research Trends dashboard)
    GET  /trend_detail    — one term's co-occurrence / owners / papers
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from openai import AsyncOpenAI
from pydantic import BaseModel

from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.base import DocStatus
from lightrag.utils import EmbeddingFunc

import apa_citations as apa     # APA7 rewriting of the answer LLM's numeric citations
import aprag_graph as kg        # knowledge-graph explorer shaping (pure helpers)
import aprag_pdf as pdfsrv      # PDF serving: path safety, cache identity, page raster
import aprag_search as search   # metadata-filtered semantic search (pure helpers)
import aprag_trends as trends_mod  # corpus trend aggregation (pure helpers)

# ── Config ────────────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))

STORAGE_DIR   = os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_westbury_qwen3_32b")
# Use 127.0.0.1, never "localhost". Every service here binds 0.0.0.0 (IPv4 only),
# but Windows resolves "localhost" to ::1 first; that refusal takes ~2.05s to come
# back, so every non-pooled connection paid a ~2s toll. That alone was most of the
# old per-query latency (naive 2.3s -> 0.12s just from this).
EMBED_HOST    = os.environ.get("EMBED_HOST", "http://127.0.0.1:8000/v1")
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL     = os.environ.get("LLM_MODEL", "gpt-5.6-luna")
# OpenAI processing tier for every LLM call. "fast" (formerly "priority") buys ~2.5x
# faster, more consistent latency for a 2x per-token premium — on Luna that is still
# ~half the price of gpt-5.4-mini at standard speed. Set LLM_SERVICE_TIER="" (or
# "default") to fall back to standard processing. The API echoes the tier it actually
# served as; under a hard traffic ramp it may silently downgrade to "default".
LLM_SERVICE_TIER = os.environ.get("LLM_SERVICE_TIER", "fast").strip()
# Output verbosity (low|medium|high). Lower = fewer output tokens, generated faster. The
# deployment checklist says to choose it per use case: "low" is unambiguously right for
# the mechanical JSON calls (keyword extraction), and is the default for synthesis too —
# raise to "medium" here if answers start dropping citations or nuance.
LLM_VERBOSITY = os.environ.get("LLM_VERBOSITY", "low").strip()
EMBEDDING_DIM = 4096
# Storage backends (docs/SCALING_ISSUES.md §3.3/§3.4/§7): defaults are LightRAG's
# file backends (whole store in process RAM — fine for small corpora). For 10K+
# papers set KV_STORAGE=PGKVStorage / DOC_STATUS_STORAGE=PGDocStatusStorage /
# GRAPH_STORAGE=Neo4JStorage (+ POSTGRES_* / NEO4J_* env, populated by
# scripts/migrate_to_db_backends.py) so RAM scales with the hot set, not the corpus.
KV_STORAGE         = os.environ.get("KV_STORAGE", "JsonKVStorage")
DOC_STATUS_STORAGE = os.environ.get("DOC_STATUS_STORAGE", "JsonDocStatusStorage")
GRAPH_STORAGE      = os.environ.get("GRAPH_STORAGE", "NetworkXStorage")
HOST          = os.environ.get("HOST", "0.0.0.0")
PORT          = int(os.environ.get("PORT", 8001))

# Shared-secret gate for the data endpoints. When set (e.g. once the server is exposed
# through a public Cloudflare Tunnel for the web frontend), every /query·/retrieve·
# /search·/stats request must carry a matching `X-API-Key` header; unset = open, so the
# local CLI/MCP keep working with no key. /health stays open for liveness checks. The
# aprag client sends this automatically from its own $APRAG_API_KEY.
APRAG_API_KEY = os.environ.get("APRAG_API_KEY", "")

# APA citations: a filename→bib-record manifest (built by scripts/build_apa_manifest.py),
# deployed next to this file, and the hades fallback share shown when a reader has no
# local copy of a cited PDF.
APA_MANIFEST      = os.environ.get("APA_MANIFEST", os.path.join(_HERE, "papers_metadata.json"))
HADES_PAPERS_BASE = os.environ.get("HADES_PAPERS_BASE", apa.DEFAULT_HADES_BASE)
# filename → Google Drive webViewLink map (built by scripts/build_drive_map.py). When
# present, references fall back to the Drive link before hades. Set HADES_PAPERS_BASE=""
# to drop hades entirely once the Drive map covers the corpus.
APRAG_DRIVE_MAP   = os.environ.get("APRAG_DRIVE_MAP", os.path.join(_HERE, "drive_links.json"))

# The corpus PDFs, served to the web app's in-app viewer (GET /pdf, GET /pdf_page).
# Kept on the roomy D: drive (C: has little headroom) and synced from the papers library
# by scripts/sync_papers_to_pc.sh. Rendered pages are cached beside it. Serving is
# read-only; a missing directory simply disables the two endpoints (the UI falls back to
# its Google Drive links).
PAPERS_DIR     = os.environ.get("PAPERS_DIR", r"D:\aprag_papers")
PAGE_CACHE_DIR = os.environ.get("PAGE_CACHE_DIR", r"D:\aprag_page_cache")
# Rasterizing a page costs ~240ms of CPU; cap concurrent renders so a burst of hover
# previews cannot starve the retrieval path on this single box.
PAGE_RENDER_CONCURRENCY = int(os.environ.get("PAGE_RENDER_CONCURRENCY", 2))

# Set QDRANT_URL for LightRAG's Qdrant backend
os.environ.setdefault("QDRANT_URL", QDRANT_URL)

# LightRAG constructs QdrantClient(url=..., api_key=...) with no timeout, so it
# inherits qdrant_client's 5s default. That is far too short for the full corpus
# store: at 12.1M vectors / 4096 dims the store is ~195GB against 33.5GB of RAM on
# the serving box, so Qdrant mmaps from SSD and a single search costs ~2s warm and
# up to ~7s cold. A hybrid query issues several, and the 5s default turned that
# into "ResponseHandlingException: timed out" -> HTTP 500 on every request.
#
# Patched here rather than in lightrag/kg/qdrant_impl.py on purpose: the vendored
# LightRAG must stay unmodified so it can be upgraded in place (see CLAUDE.md).
QDRANT_TIMEOUT = int(os.environ.get("QDRANT_TIMEOUT", 120))
try:
    import qdrant_client as _qc

    _qc_init = _qc.QdrantClient.__init__

    def _qc_init_with_timeout(self, *args, **kwargs):
        kwargs.setdefault("timeout", QDRANT_TIMEOUT)
        return _qc_init(self, *args, **kwargs)

    _qc.QdrantClient.__init__ = _qc_init_with_timeout
except ImportError:      # NanoVectorDB deployments have no qdrant_client
    pass

# ── Embedding via local Qwen3-Embedding server (scripts/server.py) ────────────
# These calls are all query-side; the embedding server applies the Qwen3 query
# instruction. The `model` field is ignored by that server.

_embed_client = AsyncOpenAI(base_url=EMBED_HOST, api_key="ignored")


async def pc_embed(texts: list[str], context: str = "query") -> np.ndarray:
    # Forward LightRAG's task-aware context to the embedding server (extra_body adds
    # it to the request JSON). "query" → instruction applied, "document" → none.
    _t0 = time.perf_counter()
    resp = await _embed_client.embeddings.create(
        model="qwen3-embedding-8b",
        input=texts,
        extra_body={"context": context},
    )
    print(f"[TIMING] embed {time.perf_counter()-_t0:.2f}s ({len(texts)} text(s), ctx={context})", flush=True)
    return np.array([d.embedding for d in resp.data])


# ── LLM via OpenAI ────────────────────────────────────────────────────────────

# Reasoning effort for gpt-5.6-luna. Defaults to "none" (no reasoning tokens — fastest);
# the answer synthesis level is overridable per request (CLI/MCP/API). Keyword extraction
# and any other structured/JSON call stay "none" — they are mechanical, so reasoning only
# adds latency. Set per-request via a process global (see below) so it reaches the awaited
# LightRAG calls in the same task.
#
# NOTE on the ladder (probed against the live API, 2026-08-02): GPT-5.6's documented
# levels are none/low/medium/high/xhigh/max, but "max" is only reachable through the
# *Responses* API (reasoning.effort). LightRAG calls *Chat Completions*, whose flat
# reasoning_effort rejects it on every 5.6 variant: "Supported values are: 'none', 'low',
# 'medium', 'high', and 'xhigh'". "minimal" is likewise rejected. So this path tops out at
# xhigh; a "max" request is clamped to xhigh below rather than silently falling to "none".
# (Offering true max here would mean calling /v1/responses from this module instead of
# LightRAG's chat helper — deliberately not done, to keep LightRAG patch-free.)
VALID_REASONING = ("none", "low", "medium", "high", "xhigh")
# Per-request answer-synthesis effort. A process-global holder (not a ContextVar):
# LightRAG dispatches LLM calls through a worker pool that captures the async context
# early, so a ContextVar set per request never reaches the synthesis call. Serving is
# single-user/serial so this is safe; truly concurrent callers at different levels
# could race (acceptable for this use).
_REASONING = {"effort": "none"}


def _valid_reasoning(value) -> str:
    v = (value or "none").strip().lower()
    if v == "max":            # documented for 5.6 but Responses-API-only; don't drop to "none"
        return "xhigh"
    return v if v in VALID_REASONING else "none"


async def openai_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
    if "reasoning_effort" not in kwargs:
        # Structured calls (keyword extraction passes response_format=json_object)
        # never need reasoning; the free-text answer synthesis uses the request level.
        kwargs["reasoning_effort"] = (
            "none" if kwargs.get("response_format") is not None else _REASONING["effort"]
        )
    if LLM_SERVICE_TIER and "service_tier" not in kwargs:
        kwargs["service_tier"] = LLM_SERVICE_TIER
    if LLM_VERBOSITY and "verbosity" not in kwargs:
        # Chat Completions takes a flat `verbosity`; the nested text.verbosity form in
        # the docs is Responses-API-only and 400s here ("Unknown parameter: 'text'").
        kwargs["verbosity"] = LLM_VERBOSITY
    _t0 = time.perf_counter()
    _r = await openai_complete_if_cache(
        LLM_MODEL, prompt,
        system_prompt=system_prompt,
        history_messages=history_messages or [],
        api_key=OPENAI_API_KEY,
        base_url="https://api.openai.com/v1",
        **kwargs,
    )
    _pl = len(prompt) if isinstance(prompt, str) else -1
    print(f"[TIMING] llm {time.perf_counter()-_t0:.2f}s effort={kwargs['reasoning_effort']} "
          f"tier={kwargs.get('service_tier', 'default')} verb={kwargs.get('verbosity', '-')} "
          f"(prompt {_pl} chars -> out {len(_r or '')} chars)", flush=True)
    return _r


# ── RAG (loaded once at startup) ──────────────────────────────────────────────

_rag: LightRAG | None = None
# Whether the deployed store carries per-chunk page numbers (set by re-ingesting with
# the page-aware chunker). Sampled once at startup; None = undeterminable.
_PAGE_AWARE: bool | None = None


async def _sample_page_aware() -> bool | None:
    """Cheaply sample a few chunks (Qdrant scroll → text_chunks lookup) to see whether
    they carry ``page_start`` — i.e. whether reference/chunk page locators will appear."""
    vdb = getattr(_rag, "chunks_vdb", None)
    client = getattr(vdb, "_client", None)
    collection = getattr(vdb, "final_namespace", None) or getattr(vdb, "namespace", None)
    if not (client and collection and hasattr(_rag, "text_chunks")):
        return None
    try:
        points, _ = await asyncio.to_thread(
            client.scroll, collection_name=collection, limit=5, with_payload=True)
        ids = [p.payload.get("id") for p in points if p.payload and p.payload.get("id")]
        if not ids:
            return None
        recs = [r for r in await _rag.text_chunks.get_by_ids(ids) if isinstance(r, dict)]
        if not recs:
            return None
        return any(r.get("page_start") is not None for r in recs)
    except Exception as exc:  # diagnostic only — never block startup
        print(f"page-aware sample failed ({exc!r})", flush=True)
        return None


# Per-collection Qdrant search params, applied by wrapping the storage objects
# AFTER LightRAG builds them. LightRAG's QdrantVectorDBStorage.query() sends no
# search_params at all, so Qdrant falls back to its defaults -- and for scalar
# quantization the default is rescore=true, which reads the int8 copy AND the
# fp32 originals. That configuration measured 10.6s on entities, slower than no
# quantization at all (7.4s).
#
# Measured recall vs the fp32 ranking with rescore OFF (24 real queries, on Ror
# where both stores could be mounted together):
#     chunks 0.979 | entities 0.983 | relationships 0.996  (recall@10)
# So rescore can be dropped for int8 -- unlike binary, where it fell to 0.79.
#
# This is a runtime wrapper, not an edit inside LightRAG/, so it survives an
# upstream upgrade. Set QDRANT_NO_RESCORE="" to disable entirely.
# OFF by default -- measured on entities with fresh queries (n=8, disjoint sets):
#   binary + rescore    p50 7120 ms
#   int8, rescore OFF   p50 5988 ms   <- this wrapper
#   int8, rescore ON    p50 4516 ms   <- qdrant's DEFAULT, fastest
# int8 traversal is disk-bound at 14.7 GB on a 31 GB box, so skipping the bounded
# ~40-vector fp32 rescore does not pay for itself. Kept for a future config where
# the quantised data IS resident. Opt in with QDRANT_NO_RESCORE=<collection,...>.
#
# NB: do NOT try to disable this from a .bat with `set QDRANT_NO_RESCORE=` --
# Windows DELETES the variable, so os.environ.get() falls back to its default.
QDRANT_NO_RESCORE = os.environ.get("QDRANT_NO_RESCORE", "").strip()


def _apply_qdrant_search_params(rag) -> None:
    if not QDRANT_NO_RESCORE:
        print("[qdrant] rescore override disabled", flush=True)
        return
    # qdrant_client is imported lazily elsewhere in this module; do the same here
    # rather than adding a hard module-level dependency.
    from qdrant_client import models
    targets = {c.strip() for c in QDRANT_NO_RESCORE.split(",") if c.strip()}

    # Wrap each distinct client's query_points ONCE, at startup, and decide by
    # collection_name inside. An earlier version wrapped per query() call and
    # restored in `finally` -- that mutates shared client state, so two
    # concurrent searches (hybrid issues entities+relationships together, and
    # requests overlap) would race and one could run unpatched or leave the
    # patch installed. Patch-once has no shared mutable state at query time.
    seen_clients: dict[int, bool] = {}
    for attr in ("chunks_vdb", "entities_vdb", "relationships_vdb"):
        store = getattr(rag, attr, None)
        client = getattr(store, "_client", None)
        if client is None or id(client) in seen_clients:
            continue
        seen_clients[id(client)] = True
        real = client.query_points

        def make(real_qp):
            def query_points(*a, **kw):
                if kw.get("collection_name") in targets:
                    kw.setdefault("search_params", models.SearchParams(
                        quantization=models.QuantizationSearchParams(
                            rescore=False)))
                return real_qp(*a, **kw)
            return query_points

        client.query_points = make(real)
    print(f"[qdrant] rescore=False for: {', '.join(sorted(targets))} "
          f"({len(seen_clients)} client(s) wrapped)", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _rag, _PAGE_AWARE
    print(f"Loading LightRAG knowledge graph... "
          f"(kv={KV_STORAGE}, graph={GRAPH_STORAGE}, doc_status={DOC_STATUS_STORAGE})",
          flush=True)
    _rag = LightRAG(
        working_dir=STORAGE_DIR,
        llm_model_func=openai_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=pc_embed,
            supports_asymmetric=True,  # forward context="query"/"document" to pc_embed
        ),
        vector_storage="QdrantVectorDBStorage",
        vector_db_storage_cls_kwargs={"cosine_better_than_threshold": 0.2},
        kv_storage=KV_STORAGE,
        doc_status_storage=DOC_STATUS_STORAGE,
        graph_storage=GRAPH_STORAGE,
    )
    await _rag.initialize_storages()
    _apply_qdrant_search_params(_rag)
    await _load_corpus_files()
    _PAGE_AWARE = await _sample_page_aware()
    print(f"Knowledge graph ready. (page_aware={_PAGE_AWARE})", flush=True)
    yield
    await _rag.finalize_storages()
    print("Shutting down.", flush=True)


app = FastAPI(title="AP-RAG Query Server", lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────


class Filters(BaseModel):
    """Metadata filters resolved against the manifest to scope retrieval to a paper set."""
    papers: list[str] | None = None        # pinned papers by filename (".pdf" optional, exact)
    authors: list[str] | None = None       # surname substrings (any-match)
    year: int | None = None
    years: list[int] | None = None         # discrete years (any-match)
    year_from: int | None = None
    year_to: int | None = None
    date_from: str | None = None           # "YYYY" | "YYYY-MM" | "YYYY-MM-DD" (precision-aware)
    date_to: str | None = None             # window is inclusive; year-only records still match
    journals: list[str] | None = None      # container-title substrings
    subjects: list[str] | None = None
    keywords: list[str] | None = None
    affiliations: list[str] | None = None
    types: list[str] | None = None         # record types (article/book/chapter/…), exact


# Callers may supply the retrieval keywords themselves. LightRAG's
# get_keywords_from_query (operate.py) returns pre-supplied keywords WITHOUT
# calling the LLM, so passing them here removes a ~1.0-1.5s round-trip from every
# KG-mode query. The web app's router already makes one LLM call to condense the
# question, pick a mode and extract filters — asking it for keywords in the same
# call measured at +0.18s, so this is a net ~0.9s saving. Omit them and the
# behaviour is unchanged (LightRAG extracts them as before).
class QueryRequest(BaseModel):
    question: str
    mode: str = "hybrid"
    top_k: int | None = None
    chunk_top_k: int | None = None
    user_prompt: str | None = None
    reasoning: str | None = None    # answer-synthesis reasoning: none|low|medium|high|xhigh (default none)
    filters: Filters | None = None
    hl_keywords: list[str] | None = None   # high-level: overarching concepts/themes
    ll_keywords: list[str] | None = None   # low-level: specific entities/methods/measures


class RetrieveRequest(BaseModel):
    question: str
    mode: str = "naive"
    top_k: int | None = None
    chunk_top_k: int | None = None
    filters: Filters | None = None
    hl_keywords: list[str] | None = None
    ll_keywords: list[str] | None = None


class SearchRequest(BaseModel):
    """Metadata-filtered semantic search → ranked papers."""
    question: str
    top_k: int = 40            # chunks pulled from Qdrant before folding into papers
    filters: Filters | None = None


# Always-on citation-style instruction fed to LightRAG's answer prompt (its
# {user_prompt} slot). The LLM cites by bracketed reference number; apa_citations
# rewrites [n] → (Author, Year). Keeping the brackets clean yields proper APA7
# in-text citations with no "see"/"Supported by" wrappers or doubled parentheses.
CITATION_STYLE_PROMPT = (
    "Citation style (APA7): cite each supporting source by placing its bracketed "
    "reference number directly after the statement it supports, e.g. \"Lexical "
    "decision times fall as word frequency rises [2].\" Use the bracket only — do NOT "
    "add words such as \"see\", \"cf.\", \"e.g.\", or \"Supported by\" before it, do NOT "
    "wrap it in extra parentheses, and do NOT cite the same source more than once in a "
    "sentence. When several sources support one statement, group them in adjacent "
    "brackets, e.g. \"… as widely reported [1][3].\""
)


def _build_query_param(req) -> QueryParam:
    """Build a QueryParam, leaving LightRAG defaults intact for unset optionals."""
    kwargs = {"mode": req.mode}
    if req.top_k is not None:
        kwargs["top_k"] = req.top_k
    if req.chunk_top_k is not None:
        kwargs["chunk_top_k"] = req.chunk_top_k
    # Caller-supplied keywords short-circuit LightRAG's keyword-extraction LLM call
    # (get_keywords_from_query returns them directly when either list is non-empty).
    # naive mode never extracts keywords, so this only affects local/global/hybrid/mix.
    hl = [k for k in (getattr(req, "hl_keywords", None) or []) if k and k.strip()]
    ll = [k for k in (getattr(req, "ll_keywords", None) or []) if k and k.strip()]
    if hl or ll:
        kwargs["hl_keywords"] = hl
        kwargs["ll_keywords"] = ll
    # Always apply the citation style. Fold the reasoning level into user_prompt too:
    # LightRAG's answer cache keys on query_param.user_prompt (operate.py), so this makes
    # the cache distinguish effort levels without patching LightRAG — a `high` answer
    # won't be served a cached `none` one. The bracketed marker is inert to the LLM.
    parts = [CITATION_STYLE_PROMPT, f"[answer-effort: {_valid_reasoning(getattr(req, 'reasoning', None))}]"]
    user_prompt = getattr(req, "user_prompt", None)
    if user_prompt:
        parts.append(user_prompt)
    kwargs["user_prompt"] = "\n\n".join(parts)
    return QueryParam(**kwargs)


def _filters_dict(req) -> dict | None:
    """The request's metadata filters as a plain dict (None if unset)."""
    f = getattr(req, "filters", None)
    if f is None:
        return None
    return f.model_dump(exclude_none=True) if hasattr(f, "model_dump") else f.dict(exclude_none=True)


# ── Page lookups (read page_start from the text-chunks KV; no LightRAG patch) ───


async def _pages_for_chunk_ids(chunk_ids: list[str]) -> dict[str, int]:
    """Map chunk_id → page_start by reading the text-chunks KV store. Empty for a
    store ingested before page-tracking, or if the lookup isn't available."""
    if not chunk_ids or not hasattr(_rag, "text_chunks"):
        return {}
    try:
        stored = await _rag.text_chunks.get_by_ids(list(chunk_ids))
    except Exception as exc:  # never let page lookup break a query
        print(f"page lookup failed ({exc!r})", flush=True)
        return {}
    out: dict[str, int] = {}
    for cid, rec in zip(chunk_ids, stored):
        if isinstance(rec, dict) and rec.get("page_start") is not None:
            out[cid] = rec["page_start"]
    return out


def _group_pages(chunks: list[dict], key: str, page_by_cid: dict[str, int]) -> dict:
    grouped: dict[str, list[str]] = {}
    for c in chunks:
        cid, k = c.get("chunk_id"), str(c.get(key) or "")
        if cid and k:
            grouped.setdefault(k, []).append(cid)
    return {
        k: sorted({page_by_cid[c] for c in cids if c in page_by_cid})
        for k, cids in grouped.items()
        if any(c in page_by_cid for c in cids)
    }


async def _pages_by_reference(data: dict) -> dict:
    chunks = (data or {}).get("chunks") or []
    ids = [c.get("chunk_id") for c in chunks if c.get("chunk_id")]
    return _group_pages(chunks, "reference_id", await _pages_for_chunk_ids(ids))


async def _attach_chunk_pages(chunks: list[dict]) -> None:
    """Stamp each chunk with its own ``page`` (PDF page) from the text-chunks KV, so the
    `aprag chunks` view can label 'Chunk N (p. 12)'. No-op for a pre-page-aware store."""
    ids = [c.get("chunk_id") for c in chunks if c.get("chunk_id")]
    page_by_cid = await _pages_for_chunk_ids(ids)
    for c in chunks:
        page = page_by_cid.get(c.get("chunk_id"))
        if page is not None:
            c["page"] = page


async def _pages_by_file(chunks: list[dict]) -> dict:
    ids = [c.get("chunk_id") for c in chunks if c.get("chunk_id")]
    return _group_pages(chunks, "file_path", await _pages_for_chunk_ids(ids))


# ── Metadata-filtered vector search (parallel Qdrant path; read-only) ──────────


async def _embed_query(text: str) -> list[float]:
    return np.asarray(await pc_embed([text], context="query"))[0].tolist()


async def _vector_chunk_search(question: str, filenames, top_k: int) -> list[dict]:
    """Semantic chunk search, optionally restricted to a filename set via a Qdrant
    payload filter. ``filenames``: None = whole corpus; set() = nothing; set = restrict."""
    if filenames is not None and len(filenames) == 0:
        return []
    try:
        from qdrant_client import models
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=501, detail=f"qdrant_client unavailable: {exc}")
    vdb = getattr(_rag, "chunks_vdb", None)
    client = getattr(vdb, "_client", None)
    collection = getattr(vdb, "final_namespace", None) or getattr(vdb, "namespace", None)
    if not (vdb is not None and client is not None and collection):
        raise HTTPException(status_code=501,
                            detail="filtered search requires the Qdrant chunk store")
    workspace = getattr(vdb, "effective_workspace", "_")
    must = [models.FieldCondition(key="workspace_id",
                                  match=models.MatchValue(value=workspace))]
    if filenames is not None:
        must.append(models.FieldCondition(key="file_path",
                                          match=models.MatchAny(any=list(filenames))))
    emb = await _embed_query(question)
    resp = await asyncio.to_thread(
        client.query_points, collection_name=collection, query=emb,
        limit=top_k, with_payload=True, query_filter=models.Filter(must=must),
    )
    chunks = []
    for p in resp.points:
        payload = p.payload or {}
        chunks.append({
            "content": payload.get("content", ""),
            "file_path": payload.get("file_path", ""),
            "chunk_id": payload.get("id") or str(getattr(p, "id", "")),
            "score": getattr(p, "score", None),
        })
    return chunks


async def _filtered_answer(req, filenames: set, manifest: dict) -> dict:
    """Synthesize an answer restricted to the filtered papers (APA-cited)."""
    top_k = req.chunk_top_k or req.top_k or 20
    chunks = await _vector_chunk_search(req.question, filenames, top_k)
    if not chunks:
        return {"answer": "No matching passages within the filtered papers.",
                "references": [], "mode": "filtered"}
    references = search.assign_reference_ids(chunks)
    context = search.build_synthesis_context(references, chunks)
    user_prompt = getattr(req, "user_prompt", None)
    prompt = f"{req.question}\n\n{context}"
    if user_prompt:
        prompt = f"{user_prompt}\n\n{prompt}"
    content = await openai_llm(prompt, system_prompt=search.SYNTH_SYSTEM_PROMPT)
    try:
        id_to_pages = await _pages_by_reference({"chunks": chunks})
        answer, ref_models = apa.render_answer(
            content, references, manifest, HADES_PAPERS_BASE, id_to_pages=id_to_pages,
            drive_map=apa.load_drive_map(APRAG_DRIVE_MAP),
        )
    except Exception as exc:  # never let citation rewriting break a good answer
        print(f"APA rewrite (filtered) failed ({exc!r}); raw answer", flush=True)
        answer, ref_models = content, []
    return {"answer": answer, "references": ref_models, "mode": "filtered"}


# ── Auth + corpus stats ────────────────────────────────────────────────────────


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Gate the data endpoints with a shared secret when APRAG_API_KEY is set; a no-op
    otherwise, so local/dev use needs no key. Applied as a route dependency."""
    if APRAG_API_KEY and x_api_key != APRAG_API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Key")


async def _count_papers() -> int:
    """Number of papers in the database = doc_status PROCESSED (+ PREPROCESSED, which is
    fully text-ingested with only VLM captioning pending). Best-effort; 0 on failure so
    the header never breaks the server."""
    try:
        counts = await _rag.doc_status.get_status_counts()
        return int(counts.get("processed", 0)) + int(counts.get("preprocessed", 0))
    except Exception as exc:  # noqa: BLE001
        print(f"paper count failed ({exc!r})", flush=True)
        return 0


# ── Corpus-scoped manifest ────────────────────────────────────────────────────
# The manifest is built from the whole papers library, so it also carries records for
# papers that were never ingested. Browsing those in the Paper Database is misleading:
# they cannot be retrieved or cited, yet they inflate the table's total and disagree
# with the /stats header. So the browse endpoints are scoped to the ingested corpus:
#
#   manifest ∩ ingested   -> full bibliographic record
#   ingested, no record   -> minimal record derived from the Author_Year filename, so a
#                            queryable paper is never invisible in the browser
#   record, not ingested  -> excluded
#
# Computed once at startup and cached. If doc_status is unreachable the unscoped
# manifest is used, preserving the "works even when the databases are down" property.
_CORPUS_FILES: dict = {"data": None}
_SCOPED_MANIFEST: dict = {"data": None}


async def _load_corpus_files() -> None:
    """Cache the set of ingested PDF basenames from doc_status."""
    try:
        docs = await _rag.doc_status.get_docs_by_statuses(
            [DocStatus.PROCESSED, DocStatus.PREPROCESSED]
        )
        names = set()
        for d in (docs or {}).values():
            fp = (d.get("file_path") if isinstance(d, dict) else getattr(d, "file_path", "")) or ""
            base = os.path.basename(str(fp).replace("\\", "/"))
            if base:
                names.add(base)
        _CORPUS_FILES["data"] = names or None
        print(f"corpus scope: {len(names):,} ingested filenames", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"corpus scope unavailable ({exc!r}) — browsing the full manifest", flush=True)
        _CORPUS_FILES["data"] = None


def _minimal_record(fn: str) -> dict:
    """Bib record inferred from an `Author_Year.pdf` filename, for an ingested paper the
    manifest has no entry for. Marked so the UI can show it as unverified metadata."""
    stem = fn[:-4] if fn.lower().endswith(".pdf") else fn
    parts = stem.split("_")
    year = None
    for p in reversed(parts):
        if p.isdigit() and len(p) == 4:
            year = int(p); break
    fam = parts[0] if parts else stem
    return {"type": "article", "authors": [{"family": fam, "given": ""}], "year": year,
            "title": stem.replace("_", " "), "container_title": "", "doi": "",
            "keywords": [], "abstract": "", "subjects": [], "metadata_source": "filename"}


def corpus_manifest() -> dict:
    """Manifest scoped to the ingested corpus (see note above). Cached."""
    if _SCOPED_MANIFEST["data"] is not None:
        return _SCOPED_MANIFEST["data"]
    manifest = apa.load_manifest(APA_MANIFEST)
    files = _CORPUS_FILES["data"]
    if not files:
        _SCOPED_MANIFEST["data"] = manifest
        return manifest
    scoped = {fn: rec for fn, rec in manifest.items() if fn in files}
    for fn in files - set(manifest):
        scoped[fn] = _minimal_record(fn)
    print(f"corpus manifest: {len(scoped):,} papers "
          f"({len(files - set(manifest)):,} filename-derived, "
          f"{len(set(manifest) - files):,} library-only excluded)", flush=True)
    _SCOPED_MANIFEST["data"] = scoped
    return scoped


# Distinct filter values (for the web UI's filter autocomplete), computed once from the
# manifest and cached. The manifest is read-mostly, so this never needs invalidation
# within a server lifetime.
_FACETS: dict = {"data": None}


def _compute_facets(manifest: dict) -> dict:
    authors: set[str] = set()
    journals: set[str] = set()
    subjects: set[str] = set()
    keywords: set[str] = set()
    affiliations: set[str] = set()
    types: set[str] = set()
    for rec in (manifest or {}).values():
        if not isinstance(rec, dict):
            continue
        for a in (rec.get("authors") or []) + (rec.get("editors") or []):
            fam = (a.get("family") or "").strip()
            if fam:
                authors.add(fam)
        ct = (rec.get("container_title") or "").strip()
        if ct:
            journals.add(ct)
        t = (rec.get("type") or "").strip()
        if t:
            types.add(t)
        for key, bucket in (("subjects", subjects), ("keywords", keywords),
                            ("affiliations", affiliations)):
            for v in (rec.get(key) or []):
                v = str(v).strip()
                if v:
                    bucket.add(v)
    srt = lambda s: sorted(s, key=str.lower)  # noqa: E731
    return {"authors": srt(authors), "journals": srt(journals),
            "subjects": srt(subjects), "keywords": srt(keywords),
            "affiliations": srt(affiliations), "types": srt(types)}


# ── Routes ────────────────────────────────────────────────────────────────────


def _qdrant_ok() -> bool:
    """Is the Qdrant vector DB reachable? (The query-server process can be up while
    Qdrant is down — then retrieval fails.)"""
    try:
        client = getattr(getattr(_rag, "chunks_vdb", None), "_client", None)
        if client is None:
            return False
        client.get_collections()  # raises if Qdrant is unreachable
        return True
    except Exception:
        return False


def _embedding_ok() -> bool:
    """Is the local embedding server reachable?"""
    try:
        import urllib.request
        base = EMBED_HOST.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        with urllib.request.urlopen(base.rstrip("/") + "/health", timeout=3) as r:
            return 200 <= r.status < 500
    except Exception:
        return False


@app.get("/health")
def health():
    qdrant = _qdrant_ok()
    embedding = _embedding_ok()
    return {
        "status": "ok",
        "storage": STORAGE_DIR,
        "llm": LLM_MODEL,
        "llm_service_tier": LLM_SERVICE_TIER or "default",
        "llm_verbosity": LLM_VERBOSITY or "default",
        # Lets clients/deploys detect an older LightRAG that lacks structured retrieval.
        "lightrag_has_aquery_data": hasattr(LightRAG, "aquery_data"),
        # Whether reference/chunk page locators will appear (True after a page-aware
        # re-ingest; False on an older store; None if undeterminable).
        "page_aware": _PAGE_AWARE,
        # Dependency liveness — retrieval_ready is the real "can we answer?" signal
        # (the process can be up while Qdrant/embedding are down).
        "qdrant": qdrant,
        "embedding": embedding,
        "retrieval_ready": bool(_rag is not None and qdrant and embedding),
        # Feature/deploy visibility:
        "manifest_papers": len(apa.load_manifest(APA_MANIFEST)),
        "drive_map_loaded": bool(apa.load_drive_map(APRAG_DRIVE_MAP)),
        # In-app PDF viewer: are the corpus PDFs present on this box?
        "pdf_serving": os.path.isdir(PAPERS_DIR),
        "pdf_dir": PAPERS_DIR,
    }


@app.get("/stats", dependencies=[Depends(require_api_key)])
async def stats():
    """Corpus size for the web UI header: number of papers ingested into the database."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    return {"papers": await _count_papers()}


@app.get("/facets", dependencies=[Depends(require_api_key)])
def facets():
    """Distinct authors/journals/subjects/keywords/affiliations (from the manifest) for
    the web UI's filter autocomplete. Computed once and cached."""
    if _FACETS["data"] is None:
        _FACETS["data"] = _compute_facets(apa.load_manifest(APA_MANIFEST))
    return _FACETS["data"]


@app.post("/query", dependencies=[Depends(require_api_key)])
async def query(req: QueryRequest):
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    _REASONING["effort"] = _valid_reasoning(req.reasoning)  # answer-synthesis effort for this request
    manifest = apa.load_manifest(APA_MANIFEST)

    # Metadata filters → restrict to the matching papers (parallel filtered path).
    filenames = search.resolve_filter(_filters_dict(req), manifest)
    if filenames is not None:
        return await _filtered_answer(req, filenames, manifest)

    param = _build_query_param(req)
    # Older LightRAG without aquery_llm: keep the legacy answer (no APA rewrite).
    if not hasattr(_rag, "aquery_llm"):
        result = await _rag.aquery(req.question, param=param)
        return {"answer": result or "No relevant information found.",
                "references": [], "mode": req.mode}

    # aquery_llm returns the answer AND the reference_id→file_path map in one call,
    # so we can rewrite numeric citations to APA7 without a second retrieval or any
    # patch to LightRAG.
    _tq = time.perf_counter()
    result = await _rag.aquery_llm(req.question, param=param)
    print(f"[TIMING] aquery_llm TOTAL {time.perf_counter()-_tq:.2f}s (mode={req.mode})", flush=True)
    content = (result.get("llm_response") or {}).get("content") or ""
    references = (result.get("data") or {}).get("references") or []
    if not content:
        return {"answer": "No relevant information found.",
                "references": [], "mode": req.mode}

    try:
        _tp = time.perf_counter()
        id_to_pages = await _pages_by_reference(result.get("data"))
        print(f"[TIMING] pages {time.perf_counter()-_tp:.2f}s", flush=True)
        _tr = time.perf_counter()
        answer, ref_models = apa.render_answer(
            content, references, manifest, HADES_PAPERS_BASE, id_to_pages=id_to_pages,
            drive_map=apa.load_drive_map(APRAG_DRIVE_MAP),
        )
        print(f"[TIMING] render {time.perf_counter()-_tr:.2f}s", flush=True)
    except Exception as exc:  # never let citation rewriting break a good answer
        print(f"APA rewrite failed ({exc!r}); returning raw answer", flush=True)
        answer, ref_models = content, []

    return {"answer": answer, "references": ref_models, "mode": req.mode}


def _enrich_references(refs: list[dict], id_to_pages: dict | None = None) -> list[dict]:
    """Add APA citation + Drive/hades locator fields to each {reference_id, file_path}
    so /retrieve consumers (the `aprag chunks` CLI, the MCP, the web frontend) can show a
    readable, cited source per chunk instead of a bare filename. ``id_to_pages`` maps a
    reference_id to the PDF pages its chunks came from (so the references list can show
    'pp. 3, 12'); empty for a pre-page-aware store. Keeps the original keys."""
    manifest = apa.load_manifest(APA_MANIFEST)
    drive_map = apa.load_drive_map(APRAG_DRIVE_MAP)
    id_to_pages = id_to_pages or {}
    out = []
    for r in refs or []:
        rid = str(r.get("reference_id") or "")
        rm = apa.build_ref_model(rid, r.get("file_path") or "", manifest,
                                 HADES_PAPERS_BASE, pages=id_to_pages.get(rid),
                                 drive_map=drive_map)
        mrec = manifest.get(rm["filename"]) if isinstance(manifest, dict) else None
        mrec = mrec if isinstance(mrec, dict) else {}
        out.append({**r, "apa": rm["apa"], "intext": rm["intext"],
                    "filename": rm["filename"], "drive_url": rm["drive_url"],
                    "hades_path": rm["hades_path"], "pages": rm["pages"],
                    "date": mrec.get("date") or "",
                    "date_precision": mrec.get("date_precision") or ""})
    return out


@app.post("/retrieve", dependencies=[Depends(require_api_key)])
async def retrieve(req: RetrieveRequest):
    """Structured retrieval without LLM synthesis — the agentic multi-hop primitive."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")

    # Metadata filters → filtered vector search (chunks only), in the aquery_data shape.
    filenames = search.resolve_filter(_filters_dict(req), apa.load_manifest(APA_MANIFEST))
    if filenames is not None:
        top_k = req.chunk_top_k or req.top_k or 20
        chunks = await _vector_chunk_search(req.question, filenames, top_k)
        await _attach_chunk_pages(chunks)
        refs = search.assign_reference_ids(chunks)
        references = _enrich_references(refs, await _pages_by_reference({"chunks": chunks}))
        return {
            "status": "success", "message": "filtered retrieval",
            "data": {"entities": [], "relationships": [], "chunks": chunks,
                     "references": references},
            "metadata": {"query_mode": "filtered", "filtered_files": len(filenames),
                         "final_chunks_count": len(chunks)},
        }

    if not hasattr(_rag, "aquery_data"):
        raise HTTPException(
            status_code=501,
            detail="Installed LightRAG lacks aquery_data; upgrade lightrag_hku for /retrieve.",
        )
    result = await _rag.aquery_data(req.question, param=_build_query_param(req))
    try:
        data = result.get("data") or {}
        await _attach_chunk_pages(data.get("chunks") or [])
        if data.get("references"):
            data["references"] = _enrich_references(
                data["references"], await _pages_by_reference(data))
    except Exception as exc:  # never let enrichment break raw retrieval
        print(f"reference enrichment failed ({exc!r})", flush=True)
    return result


@app.post("/search", dependencies=[Depends(require_api_key)])
async def search_papers(req: SearchRequest):
    """Metadata-filtered semantic search → ranked papers (with APA citation + path)."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    manifest = apa.load_manifest(APA_MANIFEST)
    filenames = search.resolve_filter(_filters_dict(req), manifest)  # None = whole corpus
    if filenames is not None and not filenames:
        return {"status": "success", "papers": [], "count": 0, "matched_files": 0}
    chunks = await _vector_chunk_search(req.question, filenames, req.top_k)
    pages_by_file = await _pages_by_file(chunks)
    papers = search.rank_papers(chunks, manifest, HADES_PAPERS_BASE, pages_by_file,
                                drive_map=apa.load_drive_map(APRAG_DRIVE_MAP))
    # Merge the slim bib fields onto each ranked paper so the web Paper Database's
    # deep-search view can fill its table columns without a second lookup. Additive —
    # the aprag CLI/MCP ignore the extra keys.
    for p in papers:
        rec = manifest.get(p["filename"])
        if isinstance(rec, dict):
            p.update({k: v for k, v in search.slim_paper_row(p["filename"], rec).items()
                      if k not in p})
    return {"status": "success", "papers": papers, "count": len(papers),
            "matched_files": (None if filenames is None else len(filenames))}


# ── Paper Database listing (the web /papers table) ────────────────────────────


def _paper_row(filename: str, record: dict, manifest: dict, drive_map: dict) -> dict:
    """Slim manifest fields + APA strings + Drive link for one table row."""
    rm = apa.build_ref_model("", filename, manifest, HADES_PAPERS_BASE,
                             drive_map=drive_map)
    return {**search.slim_paper_row(filename, record),
            "apa": rm["apa"], "intext": rm["intext"], "drive_url": rm["drive_url"]}


@app.get("/papers", dependencies=[Depends(require_api_key)])
def list_papers(
    q: str | None = None,
    sort: str = "year",
    order: str = "desc",
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=1000),
    authors: list[str] | None = Query(default=None),
    journals: list[str] | None = Query(default=None),
    subjects: list[str] | None = Query(default=None),
    keywords: list[str] | None = Query(default=None),
    affiliations: list[str] | None = Query(default=None),
    types: list[str] | None = Query(default=None),
    year: int | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
):
    """Browse the manifest as a table: metadata filters (same semantics as /query·
    /retrieve·/search) + quick text match + sort + pagination. Pure manifest read —
    works even when Qdrant/embeddings are down."""
    manifest = corpus_manifest()
    filters = {k: v for k, v in {
        "authors": authors, "journals": journals, "subjects": subjects,
        "keywords": keywords, "affiliations": affiliations, "types": types,
        "year": year, "year_from": year_from, "year_to": year_to,
        "date_from": date_from, "date_to": date_to,
    }.items() if v not in (None, [], "")}
    total, page = search.list_papers(manifest, filters=filters or None, q=q,
                                     sort=sort, order=order, offset=offset, limit=limit)
    drive_map = apa.load_drive_map(APRAG_DRIVE_MAP)
    rows = [_paper_row(fn, rec, manifest, drive_map) for fn, rec in page]
    return {"papers": rows, "total": total, "offset": offset, "limit": limit}


@app.get("/paper", dependencies=[Depends(require_api_key)])
def paper_detail(filename: str):
    """Full manifest record for one paper (abstract, affiliations, editors, provenance
    flags) + APA strings + locators — the Paper Database detail drawer."""
    manifest = apa.load_manifest(APA_MANIFEST)
    record = manifest.get(apa._basename(filename))
    if not isinstance(record, dict):
        raise HTTPException(status_code=404, detail="unknown paper")
    rm = apa.build_ref_model("", filename, manifest, HADES_PAPERS_BASE,
                             drive_map=apa.load_drive_map(APRAG_DRIVE_MAP))
    return {**record, "filename": rm["filename"], "apa": rm["apa"],
            "intext": rm["intext"], "drive_url": rm["drive_url"],
            "hades_path": rm["hades_path"]}


# ── Papers index / related papers / trends (web exploration features) ──────────


# Slim per-paper index for the web client's in-composer paper detection ("Westbury
# (2019)" → a pinned-paper filter chip). One manifest pass, cached like _FACETS.
_PAPERS_INDEX: dict = {"data": None}


def _compute_papers_index(manifest: dict) -> list[list]:
    rows: list[list] = []
    for fn, rec in (manifest or {}).items():
        if not isinstance(rec, dict):
            continue
        authors = rec.get("authors") or []
        fam = (authors[0].get("family") or "").strip() if authors else ""
        year = search._record_year(rec)
        rows.append([fn, (rec.get("title") or "").strip(), fam, year or 0])
    rows.sort(key=lambda r: r[0].lower())
    return rows


@app.get("/papers_index", dependencies=[Depends(require_api_key)])
def papers_index():
    """Every paper as a compact [filename, title, first_author_family, year] row —
    the corpus-wide lookup the web composer uses to detect paper mentions client-side."""
    if _PAPERS_INDEX["data"] is None:
        _PAPERS_INDEX["data"] = _compute_papers_index(corpus_manifest())
    return {"papers": _PAPERS_INDEX["data"]}


class SimilarRequest(BaseModel):
    """Papers most similar to one paper (chunk-centroid nearest neighbours)."""
    filename: str
    top_k: int = 12                 # papers returned
    chunk_top_k: int | None = None  # raw chunks scanned before folding (default top_k*5)


@app.post("/similar", dependencies=[Depends(require_api_key)])
async def similar_papers(req: SimilarRequest):
    """Rank the corpus against one paper's chunk centroid — "more like this".

    The query vector is the paper's unit-norm mean chunk vector (same computation and
    cache as /paper_centroid); its own chunks are excluded via a Qdrant must_not filter,
    then hits fold into ranked papers exactly like /search."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    from qdrant_client import models
    manifest = apa.load_manifest(APA_MANIFEST)
    filename = apa._basename(req.filename)
    centroid = await _paper_centroid_vec(filename)
    client, collection, workspace = _chunks_qdrant()
    flt = models.Filter(
        must=[models.FieldCondition(key="workspace_id",
                                    match=models.MatchValue(value=workspace))],
        must_not=[models.FieldCondition(key="file_path",
                                        match=models.MatchValue(value=filename))],
    )
    limit = max(10, min(req.chunk_top_k or req.top_k * 5, 300))
    resp = await asyncio.to_thread(
        client.query_points, collection_name=collection, query=centroid,
        limit=limit, with_payload=True, query_filter=flt,
    )
    chunks = []
    for p in resp.points:
        payload = p.payload or {}
        chunks.append({
            "content": payload.get("content", ""),
            "file_path": payload.get("file_path", ""),
            "chunk_id": payload.get("id") or str(getattr(p, "id", "")),
            "score": getattr(p, "score", None),
        })
    papers = search.rank_papers(chunks, manifest, HADES_PAPERS_BASE,
                                drive_map=apa.load_drive_map(APRAG_DRIVE_MAP))
    papers = papers[:max(1, min(req.top_k, 50))]
    for p in papers:
        rec = manifest.get(p["filename"])
        if isinstance(rec, dict):
            p.update({k: v for k, v in search.slim_paper_row(p["filename"], rec).items()
                      if k not in p})
    return {"status": "success", "filename": filename,
            "papers": papers, "count": len(papers)}


# Corpus trends: papers per year, per-term-per-year counts across six facet
# dimensions, plus the derived scoring (rising/fading, newcomers, bursts, lead/lag).
# One manifest pass, cached for the server lifetime (the manifest is read-mostly).
# All of the aggregation lives in aprag_trends; this is just the cache + routes.
_TRENDS: dict = {"data": None}
# Per-term detail is computed on demand and memoised per (dim, term) — a full
# manifest scan each, but small and read-mostly, and the dashboard only asks for the
# term the user actually opened.
_TREND_DETAIL: dict = {}
_TREND_DETAIL_MAX = 256


@app.get("/trends", dependencies=[Depends(require_api_key)])
def trends():
    """Corpus-wide publication trends for the web Trends dashboard."""
    if _TRENDS["data"] is None:
        _TRENDS["data"] = trends_mod.compute_trends(apa.load_manifest(APA_MANIFEST))
    return _TRENDS["data"]


@app.get("/trend_detail", dependencies=[Depends(require_api_key)])
def trend_detail(dim: str = Query(...), term: str = Query(...)):
    """One term's co-occurrence neighbourhood, then-vs-now owners, and papers.

    The overview says a term rose; this says what it rose *with*, who was publishing
    it in each window, and where it was published — the context the line chart raises
    a question about but cannot answer.
    """
    key = f"{dim}::{term.strip().lower()}"
    cached = _TREND_DETAIL.get(key)
    if cached is not None:
        return cached
    try:
        data = trends_mod.trend_detail(apa.load_manifest(APA_MANIFEST), dim, term)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if len(_TREND_DETAIL) >= _TREND_DETAIL_MAX:
        _TREND_DETAIL.clear()
    _TREND_DETAIL[key] = data
    return data


# ── PDF serving (the web app's in-app viewer) ────────────────────────────────
# Two endpoints, both pure filesystem work (no RAG store involved):
#   GET /pdf      — the PDF itself, with byte-range support so pdf.js fetches only the
#                   objects it needs for the page being read.
#   GET /pdf_page — one page rasterized to WebP, disk-cached. Gives the viewer an
#                   instant first paint and the citation popover a preview without
#                   loading/parsing a multi-megabyte PDF.
# Both validate the browser-supplied filename through aprag_pdf.safe_pdf_path (basename
# only, must resolve inside PAPERS_DIR) and validate with an mtime+size ETag, so a
# re-OCR'd paper invalidates rather than serving stale bytes forever.

_PAGE_RENDER_SEM: asyncio.Semaphore | None = None


def _page_render_sem() -> asyncio.Semaphore:
    global _PAGE_RENDER_SEM
    if _PAGE_RENDER_SEM is None:
        _PAGE_RENDER_SEM = asyncio.Semaphore(max(1, PAGE_RENDER_CONCURRENCY))
    return _PAGE_RENDER_SEM


def _resolved_pdf(filename: str) -> tuple[str, os.stat_result]:
    """The on-disk PDF for a request, or 404/503. Raises HTTPException."""
    if not os.path.isdir(PAPERS_DIR):
        raise HTTPException(status_code=503,
                            detail="PDF serving is not configured on this server")
    path = pdfsrv.safe_pdf_path(PAPERS_DIR, apa._basename(filename))
    if not path:
        raise HTTPException(status_code=404, detail="unknown PDF")
    return path, os.stat(path)


@app.get("/pdf", dependencies=[Depends(require_api_key)])
def get_pdf(request: Request, filename: str, download: bool = False):
    """Stream one corpus PDF. Starlette's FileResponse handles Range/If-Range, so
    pdf.js can fetch page objects instead of the whole file."""
    path, st = _resolved_pdf(filename)
    etag = pdfsrv.file_etag(st)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag,
                                                 "Cache-Control": "private, max-age=3600"})
    disposition = "attachment" if download else "inline"
    name = apa._basename(filename)
    return FileResponse(
        path,
        media_type="application/pdf",
        stat_result=st,
        headers={
            # FileResponse uses setdefault for etag, so ours stays authoritative.
            "ETag": etag,
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": f'{disposition}; filename="{name}"',
            "Accept-Ranges": "bytes",
        },
    )


class LocateRequest(BaseModel):
    """Where does this passage appear in this paper?"""
    filename: str
    quote: str
    hint_page: int | None = None


# Located passages, keyed by (file signature, quote) — the viewer asks for the same
# citation every time the reader reopens it. Bounded; the corpus is read-mostly.
_LOCATE_CACHE: dict[str, dict] = {}
_LOCATE_CACHE_MAX = 2048


@app.post("/pdf_locate", dependencies=[Depends(require_api_key)])
async def pdf_locate(req: LocateRequest):
    """Find the page a cited passage sits on, plus its highlight rectangles.

    The store carries no per-chunk page numbers, so the viewer recovers the location
    from the PDF text itself. A miss (scanned page, mangled text) returns page=None —
    the viewer then opens at page 1 without a highlight rather than erroring."""
    path, st = _resolved_pdf(req.filename)
    key = f"{pdfsrv.file_signature(st)}|{pdfsrv.normalize_quote(req.quote)[:300]}"
    cached = _LOCATE_CACHE.get(key)
    if cached is not None:
        return {**cached, "cached": True}

    _t0 = time.perf_counter()
    async with _page_render_sem():  # same CPU budget as rasterizing
        try:
            found = await asyncio.to_thread(
                pdfsrv.locate_quote, path, req.quote, req.hint_page)
        except RuntimeError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    print(f"[TIMING] pdf_locate {time.perf_counter()-_t0:.2f}s "
          f"{apa._basename(req.filename)} -> page {found.get('page')} "
          f"({len(found.get('rects') or [])} rects)", flush=True)

    if len(_LOCATE_CACHE) >= _LOCATE_CACHE_MAX:
        _LOCATE_CACHE.clear()
    _LOCATE_CACHE[key] = found
    return {**found, "cached": False}


@app.get("/pdf_page", dependencies=[Depends(require_api_key)])
async def get_pdf_page(
    request: Request,
    filename: str,
    page: int = Query(default=1, ge=1),
    width: int | None = None,
    quality: int | None = None,
):
    """One page of a corpus PDF as WebP (disk-cached, ~285KB at the default width)."""
    path, st = _resolved_pdf(filename)
    w = pdfsrv.clamp_width(width if width is not None else pdfsrv.DEFAULT_WIDTH)
    q = pdfsrv.clamp_quality(quality if quality is not None else pdfsrv.DEFAULT_QUALITY)
    signature = pdfsrv.file_signature(st)
    etag = f'"{signature}-p{page}-w{w}-q{q}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag,
                                                 "Cache-Control": "private, max-age=3600"})

    cache_path = pdfsrv.page_cache_path(PAGE_CACHE_DIR, apa._basename(filename),
                                        page, w, q, signature)
    headers = {"ETag": etag, "Cache-Control": "private, max-age=3600"}

    if not os.path.isfile(cache_path):
        async with _page_render_sem():
            # Re-check: a concurrent request for the same page may have just rendered it.
            if not os.path.isfile(cache_path):
                _t0 = time.perf_counter()
                try:
                    data, count, rendered = await asyncio.to_thread(
                        pdfsrv.render_page_image, path, page, w, q)
                except RuntimeError as exc:
                    raise HTTPException(status_code=422, detail=str(exc))
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                tmp = f"{cache_path}.{os.getpid()}.tmp"
                with open(tmp, "wb") as fh:
                    fh.write(data)
                os.replace(tmp, cache_path)  # atomic: readers never see a partial file
                print(f"[TIMING] pdf_page {time.perf_counter()-_t0:.2f}s "
                      f"{apa._basename(filename)} p{rendered}/{count} "
                      f"{len(data)//1024}KB", flush=True)
                headers["X-Page-Count"] = str(count)
                headers["X-Page-Rendered"] = str(rendered)
    return FileResponse(cache_path, media_type="image/webp", headers=headers)


# ── Knowledge-graph explorer (web /graph) ───────────────────────────────────
# Read-only browsing of the LightRAG entity/relation graph. Two backends are supported
# and detected at call time, because the serving stack switched from NetworkX to Neo4j
# (and a small file-based store still uses NetworkX):
#
#   Neo4j    — the production path. The graph is ~3.6M nodes / 8.1M relationships, so
#              NOTHING is indexed in this process: every query is bounded Cypher.
#              Measured: exact lookup 26ms, substring candidates 0.3s, bounded
#              neighbours 0.08s, type counts 2.2s (cached), global top-degree 0.55s.
#              Ordering *all* substring matches by degree costs ~9s, so search fetches a
#              bounded candidate set and ranks it here (aprag_graph.rank_search_rows).
#   NetworkX — the in-memory path (small stores): the original degree-sorted index.

_KG: dict = {"index": None, "by_lower": None, "file_map": None,
             "overview": None, "top": None}

#: Candidate rows pulled before ranking a search (see rank_search_rows).
KG_SEARCH_CANDIDATES = 300


def _kg_store():
    """(backend, store) for the live graph — ("neo4j"|"networkx", storage)."""
    store = getattr(_rag, "chunk_entity_relation_graph", None)
    if store is None:
        raise HTTPException(status_code=501, detail="knowledge graph unavailable")
    if getattr(store, "_driver", None) is not None:
        return "neo4j", store
    if getattr(store, "_graph", None) is not None:
        return "networkx", store
    raise HTTPException(status_code=501, detail="knowledge graph unavailable")


def _kg_label(store) -> str:
    """The workspace label Neo4j nodes carry (LightRAG scopes a workspace by label)."""
    try:
        return store._get_workspace_label()
    except Exception:  # noqa: BLE001 — fall back to LightRAG's default
        return "base"


async def _neo4j(store, cypher: str, **params) -> list[dict]:
    """Run one read-only Cypher statement and return plain dict rows."""
    async with store._driver.session(
        database=getattr(store, "_DATABASE", None), default_access_mode="READ"
    ) as session:
        result = await session.run(cypher, **params)
        try:
            return [dict(record) async for record in result]
        finally:
            await result.consume()


def _kg_index() -> list:
    """NetworkX-only: the degree-sorted entity index, built once."""
    if _KG["index"] is None:
        _t0 = time.perf_counter()
        _backend, store = _kg_store()
        idx = kg.build_entity_index(store._graph)
        _KG["index"] = idx
        _KG["by_lower"] = {r[0]: r[1] for r in idx}
        print(f"[TIMING] kg index {time.perf_counter()-_t0:.2f}s ({len(idx)} entities)",
              flush=True)
    return _KG["index"]


def _row_to_summary(row: dict) -> dict:
    """One Cypher row -> the list-row payload the web explorer renders."""
    return {
        "name": row.get("id") or "",
        "type": kg.clean_type(row.get("type")) or "unknown",
        "degree": int(row.get("degree") or 0),
        "papers": len(kg.node_files({"file_path": row.get("file_path")})),
        "description": kg.snippet(row.get("description")),
    }


@app.get("/graph/overview", dependencies=[Depends(require_api_key)])
async def graph_overview():
    """Graph size + per-entity-type counts (cached: the type census is a full scan)."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    backend, store = _kg_store()
    if backend == "networkx":
        return kg.overview(store._graph, _kg_index())

    if _KG["overview"] is None:
        _t0 = time.perf_counter()
        label = _kg_label(store)
        counts = await _neo4j(
            store,
            f"MATCH (n:`{label}`) RETURN n.entity_type AS type, count(*) AS c "
            "ORDER BY c DESC LIMIT 24")
        totals = await _neo4j(
            store,
            f"MATCH (n:`{label}`) RETURN count(n) AS nodes")
        rels = await _neo4j(
            store,
            f"MATCH (:`{label}`)-[r]-() RETURN count(r) / 2 AS rels")
        _KG["overview"] = {
            "entities": int(totals[0]["nodes"]) if totals else 0,
            "relations": int(rels[0]["rels"]) if rels else 0,
            # `top` is intentionally empty here: naming each type's top entities would
            # cost a degree sort per type, and the explorer is search-first anyway.
            "types": [{"type": kg.clean_type(r["type"]) or "unknown",
                       "count": int(r["c"]), "top": []}
                      for r in counts if r.get("type")],
        }
        print(f"[TIMING] kg overview {time.perf_counter()-_t0:.2f}s", flush=True)
    return _KG["overview"]


@app.get("/graph/entities", dependencies=[Depends(require_api_key)])
async def graph_entities(
    q: str | None = None,
    entity_type: str | None = Query(default=None, alias="type"),
    file: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Search/browse entities. ``q`` = name substring (ranked by relevance then
    connectedness), ``type`` = exact entity type, ``file`` = only entities extracted
    from that paper ("concepts in this paper")."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    backend, store = _kg_store()

    if backend == "networkx":
        index = _kg_index()
        names = None
        if file:
            if _KG["file_map"] is None:
                _KG["file_map"] = kg.build_file_map(index, store._graph)
            names = set(_KG["file_map"].get(apa._basename(file).lower(), []))
        total, page = kg.search_entities(
            index, q=q, etype=entity_type, names=names, limit=limit, offset=offset)
        return {"total": total,
                "entities": [kg.entity_summary(store._graph, r) for r in page],
                "offset": offset, "limit": limit}

    label = _kg_label(store)
    needle = " ".join(str(q or "").lower().split())
    etype = (entity_type or "").strip().lower()
    _t0 = time.perf_counter()

    if file:
        # "Concepts in this paper": file_path is a <SEP>-joined list, so match the
        # basename as a substring and bound the result.
        rows = await _neo4j(
            store,
            f"MATCH (n:`{label}`) WHERE n.file_path CONTAINS $f "
            + ("AND toLower(n.entity_type) = $t " if etype else "")
            + "RETURN n.entity_id AS id, n.entity_type AS type, "
              "COUNT{(n)--()} AS degree, n.description AS description, "
              "n.file_path AS file_path "
              "ORDER BY degree DESC LIMIT $lim",
            f=apa._basename(file), t=etype, lim=min(limit + offset, 200))
    elif needle:
        # Two steps: cheap bounded candidates, then details/degrees for just those.
        # (One combined query that orders every match by degree measured ~9s.)
        candidates = await _neo4j(
            store,
            f"MATCH (n:`{label}`) WHERE toLower(n.entity_id) CONTAINS $q "
            + ("AND toLower(n.entity_type) = $t " if etype else "")
            + "RETURN n.entity_id AS id LIMIT $cap",
            q=needle, t=etype, cap=KG_SEARCH_CANDIDATES)
        ids = [r["id"] for r in candidates if r.get("id")]
        rows = await _neo4j(
            store,
            f"MATCH (n:`{label}`) WHERE n.entity_id IN $ids "
            "RETURN n.entity_id AS id, n.entity_type AS type, COUNT{(n)--()} AS degree, "
            "n.description AS description, n.file_path AS file_path",
            ids=ids) if ids else []
    else:
        rows = await _neo4j(
            store,
            f"MATCH (n:`{label}`) "
            + ("WHERE toLower(n.entity_type) = $t " if etype else "")
            + "RETURN n.entity_id AS id, n.entity_type AS type, "
              "COUNT{(n)--()} AS degree, n.description AS description, "
              "n.file_path AS file_path "
              "ORDER BY degree DESC LIMIT $lim",
            t=etype, lim=min(limit + offset, 200))

    summaries = kg.rank_search_rows([_row_to_summary(r) for r in rows], needle)
    print(f"[TIMING] kg entities {time.perf_counter()-_t0:.2f}s "
          f"(q={needle!r} type={etype!r} rows={len(summaries)})", flush=True)
    return {
        # Bounded search: `total` is what we can show, not a corpus-wide count.
        "total": len(summaries),
        "entities": summaries[offset:offset + limit],
        "offset": offset,
        "limit": limit,
        "bounded": True,
    }


class GraphFilesRequest(BaseModel):
    """The graph entities extracted from each of several papers (one round trip)."""
    files: list[str]
    limit: int = 8  # entities per paper


#: Per-paper entity cache for /graph/entities_by_file. The Papers Database asks for a
#: whole page of rows at once, and each lookup is a label scan (file_path is not
#: indexed), so caching is what makes paging back and forth cheap.
_KG_FILE_ENTS: dict[str, list] = {}
KG_FILE_ENTS_TOP = 12          # entities fetched (and cached) per paper
KG_FILE_ENTS_CONCURRENCY = 8   # simultaneous per-paper lookups
KG_FILE_ENTS_MAX_FILES = 250   # per request
KG_FILE_ENTS_CACHE_MAX = 50_000


@app.post("/graph/entities_by_file", dependencies=[Depends(require_api_key)])
async def graph_entities_by_file(req: GraphFilesRequest):
    """The top entities extracted from each of the given papers, keyed by filename.

    The per-paper equivalent of /graph/entities?file=…, batched so the Papers Database
    can fill a knowledge-graph column for a whole page in one request. Missing/unknown
    papers simply come back with an empty list."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    backend, store = _kg_store()

    names = []
    seen = set()
    for f in (req.files or [])[:KG_FILE_ENTS_MAX_FILES]:
        base = apa._basename(str(f or ""))
        if base and base not in seen:
            seen.add(base)
            names.append(base)

    todo = [n for n in names if n not in _KG_FILE_ENTS]
    _t0 = time.perf_counter()

    if backend == "networkx":
        index = _kg_index()
        if _KG["file_map"] is None:
            _KG["file_map"] = kg.build_file_map(index, store._graph)
        for base in todo:
            hits = set(_KG["file_map"].get(base.lower(), []))
            _total, page = kg.search_entities(index, names=hits, limit=KG_FILE_ENTS_TOP)
            _KG_FILE_ENTS[base] = [
                {k: s[k] for k in ("name", "type", "degree")}
                for s in (kg.entity_summary(store._graph, r) for r in page)
            ]
    elif todo:
        label = _kg_label(store)
        sem = asyncio.Semaphore(KG_FILE_ENTS_CONCURRENCY)

        async def one(base: str) -> None:
            async with sem:
                try:
                    rows = await _neo4j(
                        store,
                        f"MATCH (n:`{label}`) WHERE n.file_path CONTAINS $f "
                        "RETURN n.entity_id AS id, n.entity_type AS type, "
                        "COUNT{(n)--()} AS degree "
                        "ORDER BY degree DESC LIMIT $lim",
                        f=base, lim=KG_FILE_ENTS_TOP)
                except Exception as exc:  # one bad paper must not fail the page
                    print(f"kg entities_by_file {base!r} failed ({exc!r})", flush=True)
                    return
                _KG_FILE_ENTS[base] = [
                    {"name": r.get("id") or "",
                     "type": kg.clean_type(r.get("type")) or "unknown",
                     "degree": int(r.get("degree") or 0)}
                    for r in rows if r.get("id")
                ]

        await asyncio.gather(*(one(b) for b in todo))

    if len(_KG_FILE_ENTS) > KG_FILE_ENTS_CACHE_MAX:
        _KG_FILE_ENTS.clear()  # crude but bounded; refills a page at a time

    if todo:
        print(f"[TIMING] kg entities_by_file {time.perf_counter()-_t0:.2f}s "
              f"({len(todo)} uncached of {len(names)})", flush=True)
    per = max(1, min(int(req.limit or 8), KG_FILE_ENTS_TOP))
    return {"entities": {n: _KG_FILE_ENTS.get(n, [])[:per] for n in names}}


@app.get("/graph/entity", dependencies=[Depends(require_api_key)])
async def graph_entity(name: str):
    """One entity's full card: consolidated description, strongest connections, and
    the papers it was extracted from (slim bib fields)."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    backend, store = _kg_store()

    if backend == "networkx":
        _kg_index()
        canonical = _KG["by_lower"].get(str(name).strip().lower())
        detail = kg.entity_detail(store._graph, canonical) if canonical else None
        if detail is None:
            raise HTTPException(status_code=404, detail="unknown entity")
        files = detail.pop("files")
    else:
        label = _kg_label(store)
        want = str(name or "").strip()
        node = await _neo4j(
            store,
            f"MATCH (n:`{label}` {{entity_id: $name}}) "
            "RETURN n.entity_id AS id, n.entity_type AS type, n.description AS description, "
            "n.file_path AS file_path, COUNT{(n)--()} AS degree LIMIT 1",
            name=want)
        if not node:
            # Fall back to a case-insensitive match (links can carry any casing).
            node = await _neo4j(
                store,
                f"MATCH (n:`{label}`) WHERE toLower(n.entity_id) = $name "
                "RETURN n.entity_id AS id, n.entity_type AS type, n.description AS description, "
                "n.file_path AS file_path, COUNT{(n)--()} AS degree LIMIT 1",
                name=want.lower())
        if not node:
            raise HTTPException(status_code=404, detail="unknown entity")
        row = node[0]
        canonical = row["id"]

        # Take the strongest edges FIRST, then compute neighbour degrees — a hub can
        # have tens of thousands of edges, and degree-per-neighbour before the limit
        # would scan all of them.
        neighbours = await _neo4j(
            store,
            f"MATCH (n:`{label}` {{entity_id: $name}})-[r]-(m:`{label}`) "
            "WITH m, r ORDER BY coalesce(r.weight, 0) DESC LIMIT 60 "
            "RETURN m.entity_id AS entity, m.entity_type AS entity_type, "
            "COUNT{(m)--()} AS degree, r.description AS description, "
            "r.keywords AS keywords, coalesce(r.weight, 0) AS weight",
            name=canonical)
        detail = {
            "name": canonical,
            "type": kg.clean_type(row.get("type")) or "unknown",
            "description": " ".join(str(row.get("description") or "").split()),
            "degree": int(row.get("degree") or 0),
            "n_relations": int(row.get("degree") or 0),
            "relations": [{
                "entity": n.get("entity") or "",
                "entity_type": kg.clean_type(n.get("entity_type")) or "unknown",
                "degree": int(n.get("degree") or 0),
                "description": kg.snippet(n.get("description"), 320),
                "keywords": kg.snippet(n.get("keywords"), 120),
                "weight": float(n.get("weight") or 0.0),
            } for n in neighbours],
        }
        files = kg.node_files({"file_path": row.get("file_path")})
        detail["n_papers"] = len(files)
        files = files[:60]

    manifest = apa.load_manifest(APA_MANIFEST)
    papers = []
    for fn in files:
        base = apa._basename(fn)
        rec = manifest.get(base)
        rec = rec if isinstance(rec, dict) else {}
        papers.append({
            "filename": base,
            "title": (rec.get("title") or "").strip(),
            "year": str(rec.get("year") or ""),
        })
    detail["papers"] = papers
    return detail


# ── Atlas of Mind support (web/app/(atlas) proxies these over the tunnel) ─────
# Raw vector-space primitives the atlas experiences need beyond /query·/retrieve:
# embeddings for arbitrary text, direct chunk-vector search, stored-vector fetch,
# and per-paper centroids (the Semantle daily target). All key-gated like the rest.


class EmbedRequest(BaseModel):
    texts: list[str]
    context: str = "query"          # "query" applies the Qwen3 task instruction


class QSearchRequest(BaseModel):
    """Chunk-vector search. Provide text (embedded server-side) OR a raw vector."""
    text: str | None = None
    vector: list[float] | None = None
    limit: int = 10


class VectorsRequest(BaseModel):
    qids: list[str]                 # Qdrant point ids (from /qsearch hits)


class PaperCentroidRequest(BaseModel):
    file: str                       # file_path payload value (paper filename)


def _chunks_qdrant():
    """(client, collection, workspace) for the chunk store, or 501 when absent."""
    vdb = getattr(_rag, "chunks_vdb", None)
    client = getattr(vdb, "_client", None)
    collection = getattr(vdb, "final_namespace", None) or getattr(vdb, "namespace", None)
    if not (client and collection):
        raise HTTPException(status_code=501, detail="Qdrant chunk store unavailable")
    return client, collection, getattr(vdb, "effective_workspace", "_")


@app.post("/embed", dependencies=[Depends(require_api_key)])
async def embed(req: EmbedRequest):
    if not 1 <= len(req.texts) <= 16:
        raise HTTPException(status_code=400, detail="texts: 1-16 strings")
    context = "document" if req.context == "document" else "query"
    vecs = await pc_embed([t[:2000] for t in req.texts], context=context)
    return {"embeddings": np.asarray(vecs).tolist()}


@app.post("/qsearch", dependencies=[Depends(require_api_key)])
async def qsearch(req: QSearchRequest):
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    from qdrant_client import models
    client, collection, workspace = _chunks_qdrant()
    vector = req.vector
    if vector is None:
        if not (req.text and req.text.strip()):
            raise HTTPException(status_code=400, detail="text or vector required")
        vector = await _embed_query(req.text)
    flt = models.Filter(must=[models.FieldCondition(
        key="workspace_id", match=models.MatchValue(value=workspace))])
    resp = await asyncio.to_thread(
        client.query_points, collection_name=collection, query=vector,
        limit=max(1, min(req.limit, 100)), with_payload=True, query_filter=flt,
    )
    hits = []
    for p in resp.points:
        payload = p.payload or {}
        hits.append({
            "qid": str(p.id),
            "chunkId": payload.get("id", ""),
            "file": payload.get("file_path", ""),
            "score": getattr(p, "score", None),
        })
    return {"hits": hits}


@app.post("/vectors", dependencies=[Depends(require_api_key)])
async def vectors(req: VectorsRequest):
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    if not 1 <= len(req.qids) <= 64:
        raise HTTPException(status_code=400, detail="qids: 1-64 ids")
    client, collection, _workspace = _chunks_qdrant()
    points = await asyncio.to_thread(
        client.retrieve, collection_name=collection, ids=req.qids,
        with_vectors=True, with_payload=False,
    )
    return {"vectors": {str(p.id): p.vector for p in points if p.vector is not None}}


class ChunkTextRequest(BaseModel):
    ids: list[str]                  # chunk_ids (as returned by /qsearch)


@app.post("/chunk_text", dependencies=[Depends(require_api_key)])
async def chunk_text(req: ChunkTextRequest):
    """Read passages straight out of the text-chunks KV by chunk_id.

    The Atlas needs a passage's prose the moment you click it, and at full corpus
    scale (~445k chunks) that text is far too big to ship to the browser — so the
    map carries positions only and reads the words from here on demand.
    """
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    if not 1 <= len(req.ids) <= 64:
        raise HTTPException(status_code=400, detail="ids: 1-64 chunk ids")
    if not hasattr(_rag, "text_chunks"):
        raise HTTPException(status_code=503, detail="text chunks unavailable")
    try:
        stored = await _rag.text_chunks.get_by_ids(list(req.ids))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"chunk lookup failed: {exc!r}")
    out: dict[str, dict] = {}
    for cid, rec in zip(req.ids, stored):
        if not isinstance(rec, dict):
            continue
        text = rec.get("raw_text_without_overlap") or rec.get("content") or ""
        out[cid] = {
            "text": text[:6000],
            "section": rec.get("section_title") or "",
            "page": rec.get("page_start"),
            "file": rec.get("file_path") or "",
        }
    return {"chunks": out}


_CENTROID_CACHE: dict[str, list[float]] = {}


async def _paper_centroid_vec(file: str) -> list[float]:
    """Unit-norm mean of all chunk vectors of one paper (cached; corpus is read-only).
    404s when the file has no chunks in the store. Shared by /paper_centroid (Atlas)
    and /similar (related papers)."""
    cached = _CENTROID_CACHE.get(file)
    if cached is not None:
        return cached
    from qdrant_client import models
    client, collection, workspace = _chunks_qdrant()
    flt = models.Filter(must=[
        models.FieldCondition(key="workspace_id", match=models.MatchValue(value=workspace)),
        models.FieldCondition(key="file_path", match=models.MatchValue(value=file)),
    ])
    vecs: list[list[float]] = []
    offset = None
    while True:
        points, offset = await asyncio.to_thread(
            client.scroll, collection_name=collection, scroll_filter=flt,
            limit=256, with_vectors=True, with_payload=False, offset=offset,
        )
        vecs.extend(p.vector for p in points if p.vector is not None)
        if offset is None:
            break
    if not vecs:
        raise HTTPException(status_code=404, detail="no chunks for that file")
    mean = np.asarray(vecs, dtype=np.float64).mean(axis=0)
    centroid = (mean / (np.linalg.norm(mean) + 1e-9)).tolist()
    _CENTROID_CACHE[file] = centroid
    return centroid


@app.post("/paper_centroid", dependencies=[Depends(require_api_key)])
async def paper_centroid(req: PaperCentroidRequest):
    """Unit-norm mean of all chunk vectors of one paper (cached; corpus is read-only)."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    was_cached = req.file in _CENTROID_CACHE
    centroid = await _paper_centroid_vec(req.file)
    return {"centroid": centroid, "cached": was_cached}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("query_server:app", host=HOST, port=PORT, log_level="info")
