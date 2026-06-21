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
    """A user-facing error from the client (already formatted for display)."""


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
        return APRAGError(f"server at {base_url} returned {exc.response.status_code}")
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


async def query(
    question: str,
    mode: str = "hybrid",
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    chunk_top_k: int | None = None,
    user_prompt: str | None = None,
) -> str:
    """Return a synthesized answer (LLM over retrieved context) from POST /query."""
    base_url = base_url or resolve_base_url()
    body = _query_param_body(question, mode, top_k, chunk_top_k)
    if user_prompt is not None:
        body["user_prompt"] = user_prompt
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/query", json=body)
            resp.raise_for_status()
            return resp.json().get("answer", "No relevant information found.")
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def retrieve(
    question: str,
    mode: str = "naive",
    *,
    base_url: str | None = None,
    top_k: int | None = None,
    chunk_top_k: int | None = None,
) -> dict:
    """
    Return structured retrieval (no LLM) from POST /retrieve.

    Shape: {"status", "message", "data": {entities[], relationships[], chunks[],
    references[]}, "metadata": {...}}. `naive` mode returns chunks only.
    """
    base_url = base_url or resolve_base_url()
    body = _query_param_body(question, mode, top_k, chunk_top_k)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(f"{base_url}/retrieve", json=body)
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc


async def health(*, base_url: str | None = None) -> dict:
    """Return the server's /health payload."""
    base_url = base_url or resolve_base_url()
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.get(f"{base_url}/health")
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:  # noqa: BLE001 — re-raised as a friendly APRAGError
        raise _raise_friendly(exc, base_url) from exc
