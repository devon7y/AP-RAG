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
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from openai import AsyncOpenAI
from pydantic import BaseModel

from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.utils import EmbeddingFunc

import apa_citations as apa     # APA7 rewriting of the answer LLM's numeric citations
import aprag_search as search   # metadata-filtered semantic search (pure helpers)

# ── Config ────────────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))

STORAGE_DIR   = os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_westbury_qwen3_32b")
EMBED_HOST    = os.environ.get("EMBED_HOST", "http://localhost:8000/v1")
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://localhost:6333")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL     = os.environ.get("LLM_MODEL", "gpt-5.4-mini")
EMBEDDING_DIM = 4096
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

# Set QDRANT_URL for LightRAG's Qdrant backend
os.environ.setdefault("QDRANT_URL", QDRANT_URL)

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

# Reasoning effort for gpt-5.4-mini. Defaults to "none" (gpt-5.4-mini supports a no-
# reasoning mode — fastest); the answer synthesis level is overridable per request
# (CLI/MCP/API). Keyword extraction and any other structured/JSON call stay "none" —
# they are mechanical, so reasoning only adds latency. NOTE: gpt-5.4-mini does NOT accept
# "minimal" (it 400s); its levels are none/low/medium/high/xhigh. Set per-request via a
# process global (see below) so it reaches the awaited LightRAG calls in the same task.
VALID_REASONING = ("none", "low", "medium", "high", "xhigh")
# Per-request answer-synthesis effort. A process-global holder (not a ContextVar):
# LightRAG dispatches LLM calls through a worker pool that captures the async context
# early, so a ContextVar set per request never reaches the synthesis call. Serving is
# single-user/serial so this is safe; truly concurrent callers at different levels
# could race (acceptable for this use).
_REASONING = {"effort": "none"}


def _valid_reasoning(value) -> str:
    v = (value or "none").strip().lower()
    return v if v in VALID_REASONING else "none"


async def openai_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
    if "reasoning_effort" not in kwargs:
        # Structured calls (keyword extraction passes response_format=json_object)
        # never need reasoning; the free-text answer synthesis uses the request level.
        kwargs["reasoning_effort"] = (
            "none" if kwargs.get("response_format") is not None else _REASONING["effort"]
        )
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _rag, _PAGE_AWARE
    print("Loading LightRAG knowledge graph...", flush=True)
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
    )
    await _rag.initialize_storages()
    _PAGE_AWARE = await _sample_page_aware()
    print(f"Knowledge graph ready. (page_aware={_PAGE_AWARE})", flush=True)
    yield
    await _rag.finalize_storages()
    print("Shutting down.", flush=True)


app = FastAPI(title="AP-RAG Query Server", lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────


class Filters(BaseModel):
    """Metadata filters resolved against the manifest to scope retrieval to a paper set."""
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


class QueryRequest(BaseModel):
    question: str
    mode: str = "hybrid"
    top_k: int | None = None
    chunk_top_k: int | None = None
    user_prompt: str | None = None
    reasoning: str | None = None    # answer-synthesis reasoning: none|low|medium|high|xhigh (default none)
    filters: Filters | None = None


class RetrieveRequest(BaseModel):
    question: str
    mode: str = "naive"
    top_k: int | None = None
    chunk_top_k: int | None = None
    filters: Filters | None = None


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
    limit: int = Query(default=50, ge=1, le=500),
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
    manifest = apa.load_manifest(APA_MANIFEST)
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


_CENTROID_CACHE: dict[str, list[float]] = {}


@app.post("/paper_centroid", dependencies=[Depends(require_api_key)])
async def paper_centroid(req: PaperCentroidRequest):
    """Unit-norm mean of all chunk vectors of one paper (cached; corpus is read-only)."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    cached = _CENTROID_CACHE.get(req.file)
    if cached is not None:
        return {"centroid": cached, "cached": True}
    from qdrant_client import models
    client, collection, workspace = _chunks_qdrant()
    flt = models.Filter(must=[
        models.FieldCondition(key="workspace_id", match=models.MatchValue(value=workspace)),
        models.FieldCondition(key="file_path", match=models.MatchValue(value=req.file)),
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
    _CENTROID_CACHE[req.file] = centroid
    return {"centroid": centroid, "n_chunks": len(vecs)}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("query_server:app", host=HOST, port=PORT, log_level="info")
