# Retrieval latency on the serving PC

Investigation into why `local`/`global`/`hybrid` retrieval took 7–11 s, what
fixed it, and what didn't. Every number here was measured on the live PC
(8-core, 31 GB RAM, NVMe) against the ~10,700-paper corpus.

**Bottom line:** two changes account for all the improvement. Four attempts to
shrink the vector store produced nothing, for one shared reason explained in
[Why shrinking the store doesn't help](#why-shrinking-the-store-doesnt-help).
The largest remaining lever is not a storage format at all — it is page-cache
warmth, worth 4–5×.

---

## Result

Representative condition: a **novel** question arriving at a system already in
active use. 40 queries, 8 per mode, interleaved round-robin, no restart and no
warm-up pass. Zero errors.

| mode | before | p50 | p90 |
|---|---|---|---|
| naive | 2.3 s | **0.31 s** | 0.42 s |
| local | 8–9 s | **3.00 s** | 3.30 s |
| global | 7 s | **3.09 s** | 3.60 s |
| hybrid | 11 s | **3.80 s** | 4.28 s |
| mix | — | **4.11 s** | 5.16 s |

Both changes are lossless or near-lossless; neither trades quality for speed.
The mode ordering is as expected: naive (chunks only) << local ~ global (one KG
search each) < hybrid (both, run sequentially in LightRAG) < mix (both plus a
chunks vector search).

### Latency depends far more on cache state than on mode

Quoting a single number is misleading. Same store, same modes, `hybrid` as the
example:

| condition | hybrid |
|---|---|
| first query after a Qdrant restart | 43 s |
| a few queries in | 4–6 s |
| **novel query, system in use (representative)** | **3.8 s** |
| repeated / near-repeat query | 1.3–1.9 s |

Always state the condition with the number.

---

## What worked

### 1. `localhost` → `127.0.0.1` (transport)

Every service binds `0.0.0.0` (IPv4 only), but Windows resolves `localhost` to
`::1` first. Nothing listens there, and the IPv6 refusal takes **~2.05 s** to
come back before the client falls back to IPv4. Every non-pooled connection paid
it — Qdrant :6333, embedder :8000, query server :8001, Neo4j :7687, Postgres :5432.

```
TCP connect localhost:6333   2063 ms
TCP connect 127.0.0.1:6333      0.3 ms
```

Per-mode latency was almost exactly *N × 2.06 s*, where N = the number of fresh
connections a mode opens — which is why `local`/`hybrid` (most graph calls)
looked worst. This looked like a database-scale problem and was pure transport.

Fixed in `query_server.py` defaults and in the launcher `.bat`. **Never use
`localhost` anywhere on this box.**

### 2. Binary quantization (all three collections)

12.1M × 4096 fp32 = 198 GB of vectors on a 31 GB box. Vectors were mmap'd, so
HNSW traversal did one random disk read per candidate visit — cold search was
16.3 s (entities) and 14.1 s (relationships) against ~10 ms warm. Latency scaled
linearly with `hnsw_ef`, the signature of a zero-cache-hit index.

Binary quantization is 512 B/vector: entities 1.84 GB + relationships 4.15 GB +
chunks 0.23 GB ≈ **6.2 GB**, which fits in RAM with `always_ram: true`.

```
PATCH /collections/{c}  {"quantization_config": {"binary": {"always_ram": true}}}
```

Recall@40 vs the fp32 ranking: **entities 1.000, relationships 0.997, chunks
0.992**; top-1 identical on 20/20 queries. Keep `rescore` on (Qdrant's default) —
disabling it drops recall to ~0.79.

Note int8 scalar quantization was already enabled on entities and was a **net
negative**: with `always_ram: false` it held 14.7 GB of private memory *and* made
search slower (10.6 s) than ignoring quantization entirely (7.4 s), because it
read the int8 copy **and** the fp32 originals.

---

## What didn't work

| attempt | result | why |
|---|---|---|
| Matryoshka truncation 4096→1024 | recall@10 **0.792** | too lossy; 25 GB would have fit RAM, but the quality cost is unacceptable |
| `datatype: uint8` | recall **0.000** | Qdrant stores *bytes*; every \|x\|<1 value truncates to 0. See below |
| int8 scalar quantization | net **slower** end-to-end | adds a 14.7 GB copy that competes for the cache relationships' rescore needs |
| fp16 storage (201→105 GiB) | **no measurable gain** | still ~6× over RAM; see next section |

### The uint8 trap

`datatype: uint8` accepted float vectors with HTTP 200, truncated every value to
zero, then reported `status=green`, `indexed_vectors_count == points_count`,
correct dtype and quantization. **A store of pure zeros passed every structural
check.** Recall measured 0.000.

It cannot be fixed by pre-mapping either: encoding signed values into unsigned
bytes needs an additive shift, and cosine is not shift-invariant —
`cos(a+c, b+c) ≠ cos(a,b)`.

> After any datatype change, scroll one point back with `with_vector=true` and
> assert `len(set(values)) > 1` before converting millions.

---

## Why shrinking the store doesn't help

The intuition "halve the store, halve the read time" assumes cost ∝ bytes. That
holds when bandwidth-limited. Rescore does scattered **random** reads, which are
**latency**-limited:

```
cost ≈ fixed overhead + bytes ÷ bandwidth
```

On NVMe that is ~100 µs fixed against ~8 µs of transfer for a 16 KB fp32 vector.
Halving to 8 KB saves ~4 µs of ~108 — under 5%. On this box the measured
effective cost is **~10 ms per read** (roughly 100× NVMe hardware latency,
dominated by Windows page-fault handling), at which point payload size is
irrelevant.

The cache-hit argument is also weaker than it looks:

| | store | cacheable with ~15 GB | miss rate |
|---|---|---|---|
| fp32 | 201 GiB | 7.5% | 92.5% |
| fp16 | 105 GiB | 14% | 86% |

Doubling the hit rate cuts misses by only ~7%, because ~90% still miss either
way. Combined with the ~5% from smaller reads, fp16's predicted gain is ~10% —
inside measurement noise, which is what was observed.

**This is why binary quantization worked and fp16 did not.** BQ was not an
incremental shrink; it *crossed a threshold*. At 6.2 GB the traversal data is
entirely RAM-resident, so those reads stop being disk operations — a change of
regime, not degree. fp16 at 105 GiB stays in the same regime as 201 GiB.

> **Rule for this box: a size reduction only pays if it gets the working set
> under RAM.** Anything that leaves you disk-bound leaves you the same speed.

---

## The biggest remaining lever: cache warmth

Same store, same queries-per-run, one run apart:

| mode | cold run | after one warm-up run |
|---|---|---|
| local | 12.79 s | **2.54 s** |
| global | 16.87 s | **3.08 s** |

Measured cold (first query after a Qdrant restart), all five modes:

| naive | local | global | hybrid | mix |
|---|---|---|---|---|
| 2.79 s | 21.47 s | 34.54 s | 43.13 s | 25.03 s |

**4–5×, larger than any format change tried.** Warmth does not shrink anything;
it exploits *locality*. Repeat and near-repeat queries walk the same HNSW regions
and hit the same popular entities, so the working set that actually matters is
far smaller than the store.

Practical implication: a periodic background sweep of representative queries
would hold those regions resident and deliver ~2.5–3 s consistently, instead of
paying 13–17 s whenever the cache goes cold. No storage change, no quality
trade-off.

The structural fix remains **more RAM** — at 64–128 GB the working set becomes
largely cacheable and rescore stops being disk-bound at all.

---

## Benchmarking methodology (read before trusting any number)

This box's page cache swamps everything. Three separate times a favourable
measurement here turned out to be cache state:

- fp16 measured **10.51 s** then **3.79 s** on *identical configuration*, purely
  from a prior run.
- An early "settled ~3 s" figure was page cache warmed by repeated benchmarking
  on similar queries; genuinely novel queries were 13–16 s.
- An isolated component A/B showed int8 beating binary by 37% on entity search,
  while end-to-end int8 was *worse* — measuring one collection in isolation
  ignores that the binding constraint is shared cache.

Rules:

1. **Never-before-issued queries only.** Reusing a query measures the cache.
2. **Disjoint query sets per mode**, or earlier modes warm later ones.
3. **Matched treatment when comparing configs** — same settle time, same number
   of prior runs. Never compare run 2 of one config against run 1 of another.
4. **End-to-end, not per-component.** Shared page cache means a component win can
   be a system loss.
5. **Use an unchanged mode as a control.** If `global` regresses while only
   entities changed, the measurement is cache noise.

---

## Ruled out: graph fan-out

`_find_most_related_edges_from_entities` fetches **every** edge of the top_k
entities with no cap, and the log shows this ranging from ~170 to ~2,900
relations depending on which entities a query hits. That looks like an obvious
suspect for the slow modes. It is not:

| relations | cold | warm |
|---|---|---|
| 2,713 | 2.24 s | 1.71 s |
| 1,866 | 13.52 s | 1.54 s |
| 395 | 11.76 s | 1.77 s |
| 2,866 | 5.53 s | 1.56 s |

Correlation between fan-out and latency: **r = -0.17 cold, +0.20 warm** — none.
A query pulling 2,866 relations runs in 1.56 s warm; one pulling 395 takes
1.77 s. Neo4j handles those batches in ~105 ms for ~500 pairs. Do not spend
effort capping fan-out.

## Current state

- Serving the canonical **fp32** store (`D:/rag_server/qdrant_storage_full_v2`)
- All three collections: binary quantization, `always_ram: true`, rescore on
- `query_server.py` carries an inert `QDRANT_NO_RESCORE` wrapper (off by default;
  opt in per-collection only if a future config makes quantised data resident)
- An fp16 store exists at `D:/rag_server/qdrant_fp16_4096` (105 GiB). It is
  equivalent in speed and slightly lossy — safe to delete to reclaim space.

See also: `docs/CANONICAL_INGEST_PARAMS.md`, `docs/APRAG_ACCESS.md`.
