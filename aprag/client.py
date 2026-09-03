"""
aprag.client — thin async HTTP client for the AP-RAG query server.

This is the single place that knows the wire protocol. Both the CLI (`aprag.cli`)
and the MCP server (`aprag.mcp`) call into it, so the two frontends stay in sync.

The query server (see `query_server.py`) exposes:
    GET  /health    — liveness + capability flags
    POST /query     — synthesized answer (LLM over retrieved context)
    POST /retrieve  — structured retrieval only (entities/relationships/chunks), no LLM
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx

# ── Configuration ────────────────────────────────────────────────────────────

#: Modes accepted by LightRAG's QueryParam.
VALID_MODES = ("local", "global", "hybrid", "mix", "naive")

#: General default. A specific deployment (e.g. the always-on PC over Tailscale)
#: is selected via the APRAG_QUERY_URL env var, the --server flag, --local, or the
#: persisted config file (see CONFIG_PATH).
DEFAULT_BASE_URL = "http://localhost:8001"

#: Persistent config file (shell-independent — survives without an env var). Holds
#: an `APRAG_QUERY_URL=<url>` line. Override the location with $APRAG_CONFIG.
CONFIG_PATH = Path(
    os.environ.get("APRAG_CONFIG", Path.home() / ".config" / "aprag" / "config")
)

CONNECT_TIMEOUT_SECONDS = float(os.environ.get("APRAG_CONNECT_TIMEOUT", "10"))
#: Generous read timeout: /query waits on the answer LLM; /retrieve is faster.
REQUEST_TIMEOUT = httpx.Timeout(120.0, connect=CONNECT_TIMEOUT_SECONDS)


class APRAGError(Exception):
    """A user-facing error from the client (already formatted for display).

    ``status`` carries the HTTP status when the failure was an error *response*
    (e.g. 404 for an unknown paper) and is None when the request never got that
    far (connection refused, timeout). Callers use it to tell "you asked for
    something that does not exist" apart from "the server is down".
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _auth_headers() -> dict | None:
    """Shared-secret header for a server behind a gated tunnel. Sent only when
    $APRAG_API_KEY is set; the server enforces it only when it has the same key set."""
    key = os.environ.get("APRAG_API_KEY")
    return {"X-API-Key": key} if key else None


def read_config_url() -> str | None:
    """Read the persisted `APRAG_QUERY_URL` from the config file, if present."""
    try:
        for line in CONFIG_PATH.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("APRAG_QUERY_URL="):
                value = stripped.split("=", 1)[1].strip().strip('"').strip("'")
                return value or None
    except OSError:
        return None
    return None


def write_config_url(url: str) -> Path:
    """Persist the default server URL to the config file; return its path."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(f"APRAG_QUERY_URL={url.rstrip('/')}\n")
    return CONFIG_PATH


def resolve_base_url(explicit: str | None = None, local: bool = False) -> str:
    """
    Resolve which query server to talk to.

    Precedence: explicit (--server) > local (--local → localhost) >
    APRAG_QUERY_URL env > config file (CONFIG_PATH) > DEFAULT_BASE_URL.
    The config file makes the default shell-independent (no env var / re-sourcing needed).
    """
    if explicit:
        return explicit.rstrip("/")
    if local:
        return "http://localhost:8001"
    env = os.environ.get("APRAG_QUERY_URL")
    if env:
        return env.rstrip("/")
    cfg = read_config_url()
    if cfg:
        return cfg.rstrip("/")
    return DEFAULT_BASE_URL


# ── Error helpers (ported from the original mcp_server_westbury.py) ───────────


def _exception_details(exc: BaseException) -> str:
    """Collect nested exception messages without leaking a full traceback."""
    details: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        message = str(current).strip()
        if message:
            details.append(message)
        current = current.__cause__ or current.__context__
    return " | ".join(details) or exc.__class__.__name__


def _connect_hint(details: str) -> str:
    if "Operation not permitted" in details or "Errno 1" in details:
        return (
            "network access was denied before reaching the server. This usually means "
            "the process is running in a sandbox without network/Tailscale access."
        )
    return (
        "the query server is unreachable. Check the host/port (APRAG_QUERY_URL or "
        "--server) and that the server-side services are listening."
    )


def _raise_friendly(exc: Exception, base_url: str) -> APRAGError:
    """Convert an httpx exception into a single user-facing APRAGError."""
    if isinstance(exc, httpx.ConnectError):
        details = _exception_details(exc)
        return APRAGError(
            f"cannot connect to the AP-RAG query server at {base_url}. "
            f"{_connect_hint(details)} Details: {details}"
        )
    if isinstance(exc, httpx.TimeoutException):
        details = _exception_details(exc)
        return APRAGError(
            f"timed out contacting the AP-RAG query server at {base_url}. "
            f"The server may be starting or overloaded. Details: {details}"
        )
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        detail = ""
        try:  # FastAPI puts the useful part in {"detail": ...}
            body = exc.response.json()
            if isinstance(body, dict) and body.get("detail"):
                detail = f": {body['detail']}"
        except Exception:  # noqa: BLE001 — a non-JSON error body is fine
            pass
        return APRAGError(f"server at {base_url} returned {status}{detail}",
                          status=status)
    return APRAGError(f"{_exception_details(exc)}")


# ── API calls ────────────────────────────────────────────────────────────────


def _query_param_body(
    question: str,
    mode: str,
    top_k: int | None,
    chunk_top_k: int | None,
) -> dict:
    body: dict = {"question": question, "mode": mode}
    if top_k is not None:
        body["top_k"] = top_k
    if chunk_top_k is not None:
        body["chunk_top_k"] = chunk_top_k
    return body


async def query_full(
    question: str,
    mode: str = "hybrid",
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    chunk_top_k: int | None = None,
    user_prompt: str | None = None,
    reasoning: str | None = None,
    filters: dict | None = None,
) -> dict:
    """Return the full POST /query payload: {"answer", "references", "mode"}.

    ``references`` is a list of structured APA citations
    ({"n", "apa", "intext", "filename", "hades_path", "pages"}) the frontends use to
    swap in clickable local file links; it is [] from an older server. ``filters``
    scopes the answer to papers matching the metadata (authors/year/journal/...).
    ``reasoning`` sets the answer LLM's effort (minimal|low|medium|high; default minimal).
    """
    base_url = base_url or resolve_base_url()
    body = _query_param_body(question, mode, top_k, chunk_top_k)
    if user_prompt is not None:
        body["user_prompt"] = user_prompt
    if reasoning is not None:
        body["reasoning"] = reasoning
    if filters:
        body["filters"] = filters
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/query", json=body, headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def query(
    question: str,
    mode: str = "hybrid",
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    chunk_top_k: int | None = None,
    user_prompt: str | None = None,
    filters: dict | None = None,
) -> str:
    """Return just the synthesized answer string (back-compat over ``query_full``)."""
    payload = await query_full(
        question, mode, base_url=base_url, top_k=top_k,
        chunk_top_k=chunk_top_k, user_prompt=user_prompt, filters=filters,
    )
    return payload.get("answer", "No relevant information found.")


async def retrieve(
    question: str,
    mode: str = "naive",
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    chunk_top_k: int | None = None,
    filters: dict | None = None,
) -> dict:
    """
    Return structured retrieval (no LLM) from POST /retrieve.

    Shape: {"status", "message", "data": {entities[], relationships[], chunks[],
    references[]}, "metadata": {...}}. `naive` mode returns chunks only. ``filters``
    scopes retrieval to papers matching the metadata.
    """
    base_url = base_url or resolve_base_url()
    body = _query_param_body(question, mode, top_k, chunk_top_k)
    if filters:
        body["filters"] = filters
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/retrieve", json=body, headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def search(
    question: str,
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    filters: dict | None = None,
) -> dict:
    """
    Metadata-filtered semantic search → ranked papers, from POST /search.

    Shape: {"status", "papers": [{filename, apa, hades_path, pages, score, n_chunks,
    snippet}], "count", "matched_files"}.
    """
    base_url = base_url or resolve_base_url()
    body: dict = {"question": question}
    if top_k is not None:
        body["top_k"] = top_k
    if filters:
        body["filters"] = filters
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/search", json=body, headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def health(*, base_url: str | None = None) -> dict:
    """Return the server's /health payload."""
    base_url = base_url or resolve_base_url()
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.get(f"{base_url}/health", headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def add_papers(paths: list[str], *, base_url: str | None = None) -> dict:
    """Upload PDFs for incremental ingest (POST /ingest).

    Returns {"job_id", "accepted": [...], "rejected": [{"name", "reason"}]}. The
    server ingests asynchronously — poll ``ingest_job(job_id)`` for progress. Once a
    paper reaches "done" it is searchable in chat, listed in the Papers browser, and
    placed on the Atlas map.
    """
    base_url = base_url or resolve_base_url()
    files = []
    for p in paths:
        from pathlib import Path
        pp = Path(p).expanduser()
        files.append(("files", (pp.name, pp.read_bytes(), "application/pdf")))
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(f"{base_url}/ingest", files=files,
                                     headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def ingest_job(job_id: str, *, base_url: str | None = None) -> dict:
    """One ingest job's state: {"id", "state", "created", "papers": [...], "log"}."""
    base_url = base_url or resolve_base_url()
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.get(f"{base_url}/ingest/job", params={"id": job_id},
                                    headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def ingest_jobs(limit: int = 20, *, base_url: str | None = None) -> dict:
    """Recent ingest jobs: {"jobs": [...]} newest first."""
    base_url = base_url or resolve_base_url()
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.get(f"{base_url}/ingest/jobs", params={"limit": limit},
                                    headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


# ── Generic request helpers (used by the discovery/exploration endpoints) ─────
#
# The call wrappers above predate these and each inline their own httpx block.
# Everything added below funnels through these two so a new endpoint is one
# small function rather than another copy of the try/except boilerplate.


async def _get_json(path: str, params: dict | None = None, *,
                    base_url: str | None = None, timeout=None) -> dict:
    """GET ``path`` on the query server and return the decoded JSON body."""
    base_url = base_url or resolve_base_url()
    clean = {k: v for k, v in (params or {}).items() if v not in (None, [], "")}
    try:
        async with httpx.AsyncClient(timeout=timeout or REQUEST_TIMEOUT) as client:
            resp = await client.get(f"{base_url}{path}", params=clean,
                                    headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def _post_json(path: str, body: dict, *, base_url: str | None = None,
                     timeout=None) -> dict:
    """POST ``body`` to ``path`` on the query server and return the JSON body."""
    base_url = base_url or resolve_base_url()
    try:
        async with httpx.AsyncClient(timeout=timeout or REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}{path}", json=body,
                                     headers=_auth_headers())
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


# ── Corpus discovery (what values do the metadata filters actually accept?) ───


async def facets(*, base_url: str | None = None) -> dict:
    """Distinct authors/journals/subjects/keywords/affiliations/types (GET /facets).

    Server-cached, but ~1.5 MB on a 10k-paper corpus — callers should filter it
    down rather than render it whole.
    """
    return await _get_json("/facets", base_url=base_url)


async def author_suggestions(q: str | None = None, limit: int = 15, *,
                             base_url: str | None = None) -> dict:
    """Author suggestions as *people* (GET /authors) → {"authors": [...], "total"}.

    Each row carries ``name`` ("Zhang, Kechen") — the value to send back as an
    ``authors`` filter — plus disambiguating context (n_papers, years, journal).
    """
    return await _get_json("/authors", {"q": q, "limit": limit}, base_url=base_url)


async def stats(*, base_url: str | None = None) -> dict:
    """Corpus size (GET /stats) → {"papers": N}."""
    return await _get_json("/stats", base_url=base_url)


async def list_papers(q: str | None = None, *, sort: str = "year",
                      order: str = "desc", offset: int = 0, limit: int = 50,
                      filters: dict | None = None,
                      base_url: str | None = None) -> dict:
    """Browse the manifest (GET /papers) → {"papers", "total", "offset", "limit"}.

    A pure manifest read that applies the same filter semantics as /query and
    /search, so it doubles as the authoritative "how many papers does this filter
    actually match?" probe — and it keeps working when Qdrant/embeddings are down.
    """
    params: dict = {"q": q, "sort": sort, "order": order,
                    "offset": offset, "limit": limit}
    params.update(filters or {})
    return await _get_json("/papers", params, base_url=base_url)


async def paper_detail(filename: str, *, base_url: str | None = None) -> dict:
    """Full manifest record for one paper (GET /paper)."""
    return await _get_json("/paper", {"filename": filename}, base_url=base_url)


# ── Exploration (similar papers, quote location, knowledge graph, trends) ─────


async def similar(filename: str, *, top_k: int = 12, chunk_top_k: int | None = None,
                  base_url: str | None = None) -> dict:
    """Papers nearest one paper's chunk centroid (POST /similar)."""
    body: dict = {"filename": filename, "top_k": top_k}
    if chunk_top_k is not None:
        body["chunk_top_k"] = chunk_top_k
    return await _post_json("/similar", body, base_url=base_url)


async def pdf_locate(filename: str, quote: str, hint_page: int | None = None, *,
                     base_url: str | None = None) -> dict:
    """Find the page a quote sits on (POST /pdf_locate) → {"page", "rects", ...}.

    ``page`` is None when the passage could not be located (scanned page, mangled
    text) — that is a miss, not an error.
    """
    body: dict = {"filename": filename, "quote": quote}
    if hint_page is not None:
        body["hint_page"] = hint_page
    return await _post_json("/pdf_locate", body, base_url=base_url)


async def graph_overview(*, base_url: str | None = None) -> dict:
    """Knowledge-graph size and top entity types (GET /graph/overview)."""
    return await _get_json("/graph/overview", base_url=base_url)


async def graph_entities(q: str | None = None, *, entity_type: str | None = None,
                         file: str | None = None, limit: int = 50, offset: int = 0,
                         base_url: str | None = None) -> dict:
    """Search/browse KG entities (GET /graph/entities)."""
    return await _get_json(
        "/graph/entities",
        {"q": q, "type": entity_type, "file": file, "limit": limit, "offset": offset},
        base_url=base_url,
    )


async def graph_entity(name: str, *, base_url: str | None = None) -> dict:
    """One entity's card: description, connections, source papers (GET /graph/entity)."""
    return await _get_json("/graph/entity", {"name": name}, base_url=base_url)


async def trends(*, base_url: str | None = None) -> dict:
    """Corpus-wide publication trends (GET /trends)."""
    return await _get_json("/trends", base_url=base_url)


async def trend_detail(dim: str, term: str, *, base_url: str | None = None) -> dict:
    """One term's trend neighbourhood and owners (GET /trend_detail)."""
    return await _get_json("/trend_detail", {"dim": dim, "term": term},
                           base_url=base_url)


async def papers_index(*, base_url: str | None = None) -> list[list]:
    """Every paper as a compact ``[filename, title, first_author_family, year]`` row
    (GET /papers_index) — the corpus-wide lookup used for filename suggestions."""
    payload = await _get_json("/papers_index", base_url=base_url)
    return payload.get("papers") or []
