# Fix: PARALLEL_DOCS > 1 Deadlock

## Problem

Running the ingestion pipeline with `PARALLEL_DOCS > 1` caused deadlocks. The pipeline would hang indefinitely with no LLM calls being made. This also meant multiple vLLM instances (`N_VLLM > 1`) were underutilized — only one doc could make LLM calls at a time.

## Root Causes

### 1. Global `_current_pdf_path` race condition

Every concurrent `process_one()` task wrote to the same global variable `_current_pdf_path` with no synchronization:

```python
_current_pdf_path: Path | None = None  # single global

# Task A sets it to pdf_A
global _current_pdf_path
_current_pdf_path = pdf_path  # Task B can overwrite this at any time
await rag.ainsert(...)
_current_pdf_path = None
```

When SIGALRM fired for task A's timeout, the handler would see task B's path and move the **wrong PDF** to the excluded directory. The actually-hung task would then get a `FileNotFoundError`, and the wrongly-moved task would also fail.

### 2. SIGALRM is process-global, not per-task

`signal.alarm()` sets a **single** process-wide timer. With multiple concurrent tasks:

- Task A sets a 600s alarm
- Task B starts 30s later and sets its own 600s alarm — **task A's alarm is cancelled**
- Task A can now hang forever (no timeout will fire for it)
- When the single alarm fires, the `ChunkingTimeoutError` is raised in whatever code the main thread is executing at that moment — which could be task B's chunker, the embedding function, or any other code

### 3. Synchronous chunking blocks the event loop

The `SCIENTIFIC_CHUNKER` function was called synchronously within `rag.ainsert()`. Since it wasn't offloaded to a thread, it blocked the asyncio event loop. With `PARALLEL_DOCS=1` this is fine (nothing else needs the loop). With `PARALLEL_DOCS > 1`, all other tasks are starved — they can't make progress on LLM calls, embeddings, or I/O while one doc chunks.

Cache hits (from `chunk_cache.json`) are instant dict lookups and don't block, but cache **misses** (new docs) block the entire event loop for the duration of chunking.

## Fix

### Replaced SIGALRM with async thread-pool execution + `asyncio.wait_for()`

**Before (SIGALRM-based, process-global):**
```python
def SCIENTIFIC_CHUNKER(tokenizer, content, ...):
    signal.signal(signal.SIGALRM, _sigalrm_handler)
    signal.alarm(CHUNK_TIMEOUT)
    try:
        result = _raw_chunker(tokenizer, content, ...)
        signal.alarm(0)
        return result
    except ChunkingTimeoutError:
        # race: _current_pdf_path might point to wrong doc
        if _current_pdf_path is not None:
            _current_pdf_path.rename(EXCLUDED_DIR / _current_pdf_path.name)
        raise
```

**After (per-task async timeout):**
```python
_chunk_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

async def SCIENTIFIC_CHUNKER(tokenizer, content, ...):
    loop = asyncio.get_running_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(_chunk_executor, partial(_raw_chunker, ...)),
            timeout=CHUNK_TIMEOUT,
        )
        return result
    except asyncio.TimeoutError:
        raise ChunkingTimeoutError(...)
```

| Aspect | Before | After |
|---|---|---|
| Timeout mechanism | `signal.alarm()` (one per process) | `asyncio.wait_for()` (one per task) |
| Event loop blocking | Yes — sync chunker blocks all tasks | No — runs in thread pool |
| PDF exclusion | In signal handler via global `_current_pdf_path` | In `process_one()` via local `pdf_path` |
| Concurrency safety | Races on global state | Each task independent |
| Shared state | `_current_pdf_path` global | None |

### File exclusion moved to `process_one()`

Each task now catches `ChunkingTimeoutError` directly and moves its own PDF (which it knows via the local `pdf_path` variable):

```python
except ChunkingTimeoutError:
    EXCLUDED_DIR.mkdir(parents=True, exist_ok=True)
    dest = EXCLUDED_DIR / pdf_path.name
    if pdf_path.exists():
        pdf_path.rename(dest)
```

No global state, no race conditions.

### Why `max_workers=1` on the thread pool

The chunker is CPU-bound. Multiple chunker threads fighting over cores would thrash the CPU cache and slow everything down. Serializing chunking through a single worker means:

- Only one doc chunks at a time (CPU-bound work is serialized)
- Other docs can still make progress on async I/O (LLM calls, embeddings)
- The event loop stays responsive

### Why this works with LightRAG

LightRAG calls `chunking_func()` and then checks `inspect.isawaitable()` on the result (lightrag.py lines 1916-1927). Our `async def SCIENTIFIC_CHUNKER` returns a coroutine, which LightRAG detects and awaits. No LightRAG changes needed.

## Concurrency Verification: All Components

### Chunking (fixed)

- Runs in dedicated `ThreadPoolExecutor(max_workers=1)` — doesn't block the event loop
- Each task gets an independent `asyncio.wait_for(timeout=CHUNK_TIMEOUT)` — no cross-task interference
- No shared global state — `_current_pdf_path` and SIGALRM machinery removed entirely

### Round-robin LLM dispatch (already safe)

- `_endpoint_lock` (asyncio.Lock) serializes endpoint selection; actual HTTP calls run concurrently outside the lock
- `next(cycle) % len(_live_endpoints)` distributes calls across all `N_VLLM` endpoints
- `LLM_MAX_ASYNC=8` allows up to 8 concurrent LLM calls in-flight, distributed across vLLM instances
- Failover logic (endpoint removal + re-discovery) is protected by the same lock

### Embedding (already safe)

- `EMBED_FUNC_MAX_ASYNC=1` at the LightRAG level ensures only one concurrent embedding call — no GPU contention
- `run_in_executor(None, ...)` keeps it off the event loop

### LightRAG internal parallelism (already safe)

- `max_parallel_insert=2` controls LightRAG's internal semaphore per `ainsert()` call
- `llm_model_max_async=8` allows multiple chunk extractions per doc concurrently
- Both interact correctly with our outer `PARALLEL_DOCS` semaphore

### Context cap stats (already safe)

- `context_cap_stats["documents"] += 1` uses no lock, but this is fine — pure asyncio with no `await` between read and write means no interleaving. Only used for final summary stats.

## How Multiple vLLMs Benefit

With `PARALLEL_DOCS=1` (old forced setting), only one doc's LLM calls are in-flight at a time (up to `llm_model_max_async=8`). The round-robin distributes those across endpoints, but utilization is low — one vLLM is often idle while the other processes a request.

With `PARALLEL_DOCS > 1` now working:

- While doc A is chunking (in the thread pool), doc B can make LLM calls
- While doc A waits on LLM responses, doc B can start its LLM calls
- The round-robin distributes all concurrent LLM calls across all vLLM endpoints
- Net result: much higher vLLM utilization, especially with `N_VLLM > 1`

## Recommended Settings

```bash
# Conservative (start here)
PARALLEL_DOCS=2  N_VLLM=1

# With multiple vLLMs
PARALLEL_DOCS=4  N_VLLM=2

# Aggressive (monitor for OOM)
PARALLEL_DOCS=8  N_VLLM=2
```

Higher `PARALLEL_DOCS` increases memory usage (each doc's text + chunks held in memory concurrently). Monitor with `sacct -j <JOBID> --format=MaxRSS`.

## Known Limitation — Hung Threads Are Not Interruptible

`asyncio.wait_for()` raises `TimeoutError` at the asyncio level, but **does not interrupt the underlying thread**. The thread continues running until `_raw_chunker` returns or the job is killed by SLURM.

With `max_workers=1`, if a PDF triggers a true infinite loop in `_raw_chunker`:

1. `asyncio.wait_for()` fires after `CHUNK_TIMEOUT` seconds
2. The PDF is correctly moved to the excluded directory
3. The outer code moves on — but the single worker thread is permanently occupied
4. All subsequent chunking requests queue behind the hung thread and eventually time out too
5. The thread pool is silently dead; no more chunking occurs

The original SIGALRM approach actually raised an exception *inside the running thread*, which interrupted the chunker. `run_in_executor` loses that property.

**This matters** because some PDFs are known to trigger genuine infinite loops (not just slow processing) in the scientific chunker — they are the reason the timeout mechanism exists.

**Mitigations (not yet implemented):**

- `ProcessPoolExecutor` — subprocess can be killed via `.terminate()`; most robust but higher overhead
- Spawn a fresh `ThreadPoolExecutor` per doc — guarantees no carry-over from a hung thread, but more expensive
- Accept the risk — infinite-loop PDFs are already catalogued in the excluded dir and are rare; a hung pool would eventually be noticed from the ingest log going quiet

**In practice:** The fix is correct for slow-but-finite chunking (the common case) and fully resolves the deadlock/race conditions. The hung-thread edge case only manifests if a *new*, uncatalogued infinite-loop PDF appears.

## Testing Checklist

- [ ] `PARALLEL_DOCS=2`: multiple docs make progress concurrently (interleaved log lines)
- [ ] `N_VLLM=2`: LLM calls distributed across both endpoints (check `[LLM_DEBUG]` logs)
- [ ] Chunker timeout: one doc timing out doesn't affect others
- [ ] Timed-out PDFs moved to correct excluded directory (not another doc's PDF)
- [ ] No deadlocks after 1+ hours of ingestion
