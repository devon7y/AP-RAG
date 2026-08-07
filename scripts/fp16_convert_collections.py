"""Rebuild Qdrant collections as float16, optionally Matryoshka-truncated.

Why this exists
---------------
The serving PC has 31 GB of RAM and 198 GB of fp32 vectors. Binary quantization
already made HNSW *traversal* RAM-resident (6.2 GB), but Qdrant's rescore step
re-reads the ORIGINAL vectors from disk to produce the final ranking, and that
198 GB copy is uncacheable. Rescore cannot be dropped (measured: recall@40 falls
to 0.79, recall@10 to 0.24), so the only lever left is making the originals
smaller:

    fp32 4096d : 198 GB   (today -- rescore always hits disk)
    fp16 4096d :  99 GB   (halves rescore I/O; still 3x over RAM)
    fp16 1024d :  25 GB   (fits entirely in 31 GB RAM)

`datatype` is fixed at collection creation, so this cannot be a PATCH -- the
vectors must be re-written. Hence: read once on HPC, write both variants.

Qwen3-Embedding-8B is Matryoshka-trained, so a leading slice of each vector is a
valid lower-dimensional embedding. Under Cosine distance no client-side
renormalisation is needed: cosine is scale-invariant and Qdrant normalises on
insert, so truncation alone is the correct MRL operation.

Design notes inherited from scripts/merge_qdrant_collections.py (all learned the
hard way -- do not "simplify" them away):
  * indexing_threshold=0 while loading, restored in `finally`; SIGTERM is turned
    into an exception so that `finally` actually runs (Python's default SIGTERM
    skips it, which previously stranded a collection at threshold 0).
  * upserts use wait=false for throughput, then a durability barrier at the end.
    Qdrant REJECTS an empty update, so the barrier re-sends the last real batch;
    point IDs are content-derived so that is an idempotent overwrite.
  * `green` status means nothing is queued, NOT that vectors are indexed -- gate
    on indexed_vectors_count instead.

Sharding: scroll is a cursor and cannot be split, so ids are dumped once
(--dump-ids) and each worker processes `ids[shard::num_shards]` via point
retrieve. That parallelises cleanly across cores, which matters because the cost
here is client-side JSON float handling, not the source read.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
import time

import httpx


# ── collection plumbing ───────────────────────────────────────────────────────

async def get_collection(client: httpx.AsyncClient, base: str, coll: str):
    r = await client.get(f"{base}/collections/{coll}")
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()["result"]


async def count(client: httpx.AsyncClient, base: str, coll: str) -> int:
    r = await client.post(f"{base}/collections/{coll}/points/count",
                          json={"exact": True})
    if r.status_code == 404:
        return 0
    r.raise_for_status()
    return r.json()["result"]["count"]


async def set_indexing_threshold(client: httpx.AsyncClient, base: str, coll: str,
                                 value: int) -> None:
    r = await client.patch(f"{base}/collections/{coll}",
                           json={"optimizers_config":
                                 {"indexing_threshold": value}})
    r.raise_for_status()


async def ensure_dest(client: httpx.AsyncClient, base: str, coll: str, dims: int,
                      src_cfg: dict, datatype: str = "float16") -> None:
    """Create the destination as float16 at `dims`, mirroring the source config.

    LightRAG needs the tenant payload index on workspace_id, and the m=0 /
    payload_m=16 HNSW shape (global graph disabled, per-tenant subgraph built).
    """
    if await get_collection(client, base, coll) is not None:
        return

    # 32 shard workers race here: they all see "missing" before any of them
    # creates it, so all 32 issue PUT and 31 get 409. The job now pre-creates
    # via --init-dest, but treat 409 as success anyway so the race is harmless.
    params = src_cfg["config"]["params"]
    hnsw = src_cfg["config"].get("hnsw_config") or {}
    body = {
        "vectors": {
            "size": dims,
            "distance": params["vectors"]["distance"],
            "datatype": datatype,
        },
        "on_disk_payload": params.get("on_disk_payload", True),
        "hnsw_config": {
            "m": hnsw.get("m", 0),
            "payload_m": hnsw.get("payload_m", 16),
            "ef_construct": hnsw.get("ef_construct", 100),
            "full_scan_threshold": hnsw.get("full_scan_threshold", 10000),
        },
        # Load with indexing off; the caller re-enables and waits for the build.
        "optimizers_config": {"indexing_threshold": 0},
    }
    r = await client.put(f"{base}/collections/{coll}", json=body)
    if r.status_code == 409:
        return                      # another worker created it first
    r.raise_for_status()
    print(f"[dest] created {coll} dims={dims} datatype={datatype}", flush=True)

    r = await client.put(
        f"{base}/collections/{coll}/index",
        json={"field_name": "workspace_id",
              "field_schema": {"type": "keyword", "is_tenant": True}})
    if r.status_code != 409:
        r.raise_for_status()
    print(f"[dest] tenant payload index on workspace_id for {coll}", flush=True)


# ── id dump ───────────────────────────────────────────────────────────────────

async def dump_ids(client: httpx.AsyncClient, src: str, coll: str, path: str,
                   batch: int) -> int:
    """Scroll ids only (no vectors -- cheap) so workers can shard deterministically."""
    ids, offset, t0 = [], None, time.time()
    while True:
        body = {"limit": batch, "with_payload": False, "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        r = await client.post(f"{src}/collections/{coll}/points/scroll", json=body)
        r.raise_for_status()
        res = r.json()["result"]
        pts = res["points"]
        if not pts:
            break
        ids.extend(p["id"] for p in pts)
        offset = res.get("next_page_offset")
        if len(ids) % 500_000 < batch:
            print(f"[ids] {len(ids):,} in {time.time()-t0:.0f}s", flush=True)
        if offset is None:
            break
    with open(path, "w") as fh:
        json.dump(ids, fh)
    print(f"[ids] wrote {len(ids):,} ids -> {path} ({time.time()-t0:.0f}s)",
          flush=True)
    return len(ids)


# ── conversion ────────────────────────────────────────────────────────────────

async def convert(args) -> int:
    def _term(signum, frame):
        raise KeyboardInterrupt("SIGTERM")
    signal.signal(signal.SIGTERM, _term)

    dests = [(args.dst, args.dims, args.datatype)]
    if args.dst2:
        dests.append((args.dst2, args.dims2, args.datatype2))

    # keepalive_expiry well under any server idle timeout: this is the root
    # cause of the RemoteProtocolError, not just something to retry around.
    limits = httpx.Limits(max_connections=args.inflight * len(dests) + 8,
                          max_keepalive_connections=args.inflight * len(dests),
                          keepalive_expiry=15.0)
    async with httpx.AsyncClient(timeout=1800, limits=limits) as client:
        src_cfg = await get_collection(client, args.src, args.collection)
        if src_cfg is None:
            raise SystemExit(f"source collection {args.collection} not found")
        src_dims = src_cfg["config"]["params"]["vectors"]["size"]

        for base, dims, dt in dests:
            if dims > src_dims:
                raise SystemExit(f"--dims {dims} exceeds source dim {src_dims}")
            await ensure_dest(client, base, args.collection, dims, src_cfg, dt)
            await set_indexing_threshold(client, base, args.collection, 0)

        if args.init_dest:
            print(f"[init] destinations ready for {args.collection}", flush=True)
            return 0

        with open(args.ids_file) as fh:
            all_ids = json.load(fh)
        my_ids = all_ids[args.shard::args.num_shards]
        print(f"[shard {args.shard}/{args.num_shards}] {len(my_ids):,} of "
              f"{len(all_ids):,} points", flush=True)

        moved, t0 = 0, time.time()
        last: dict[str, list] = {}
        pending: set[asyncio.Task] = set()

        async def push(base: str, points: list):
            # Retry upserts too. Job 18302343 lost 8/24 workers to
            # "RemoteProtocolError: Server disconnected without sending a
            # response" -- the httpx keep-alive race, where the pool reuses a
            # connection the server already closed on idle timeout. Retrying is
            # safe here: point ids are content-derived, so a repeated upsert is
            # an idempotent overwrite, not a duplicate.
            for attempt in range(5):
                try:
                    r = await client.put(
                        f"{base}/collections/{args.collection}/points?wait=false",
                        json={"points": points})
                    r.raise_for_status()
                    return
                except Exception as e:
                    if attempt == 4:
                        raise
                    print(f"[shard {args.shard}] upsert retry {attempt+1}/4 "
                          f"-> {base.rsplit(':', 1)[-1]}: {type(e).__name__}",
                          flush=True)
                    await asyncio.sleep(3 * (attempt + 1))

        try:
            for i in range(0, len(my_ids), args.batch):
                chunk = my_ids[i:i + args.batch]
                # Qdrant caps a read at 60s internally and returns HTTP 500 on
                # breach. Under heavy concurrent random reads that is transient,
                # so retry with backoff and halve the batch each time rather
                # than killing the worker (job 18272758 lost all 24 that way).
                # Retry the SAME chunk -- never a subset, or ids get silently
                # dropped and the store ends up quietly incomplete.
                pts = None
                for attempt in range(5):
                    try:
                        r = await client.post(
                            f"{args.src}/collections/{args.collection}/points",
                            json={"ids": chunk, "with_payload": True,
                                  "with_vector": True})
                        r.raise_for_status()
                        pts = r.json()["result"]
                        break
                    except Exception as e:
                        if attempt == 4:
                            raise
                        print(f"[shard {args.shard}] retrieve retry "
                              f"{attempt+1}/4: {type(e).__name__}", flush=True)
                        await asyncio.sleep(3 * (attempt + 1))
                if not pts:
                    continue

                for base, dims, _dt in dests:
                    # Cosine is scale-invariant and Qdrant normalises on insert,
                    # so a leading slice is the whole MRL operation.
                    up = [{"id": p["id"],
                           "vector": (p["vector"][:dims] if dims < src_dims
                                      else p["vector"]),
                           "payload": p.get("payload") or {}}
                          for p in pts]
                    last[base] = up
                    while len(pending) >= args.inflight * len(dests):
                        done, pending = await asyncio.wait(
                            pending, return_when=asyncio.FIRST_COMPLETED)
                        for d in done:
                            d.result()
                    pending.add(asyncio.create_task(push(base, up)))

                moved += len(pts)
                if moved % 100_000 < args.batch:
                    el = max(time.time() - t0, 1)
                    print(f"[shard {args.shard}] {moved:,}/{len(my_ids):,} "
                          f"({moved/el:.0f} pts/s)", flush=True)

            for d in await asyncio.gather(*pending, return_exceptions=True):
                if isinstance(d, BaseException):
                    raise d
            pending.clear()

            # wait=false above -> force application before anyone counts.
            for base, _d, _t in dests:
                if last.get(base):
                    r = await client.put(
                        f"{base}/collections/{args.collection}/points?wait=true",
                        json={"points": last[base]})
                    r.raise_for_status()
        finally:
            for t in pending:
                t.cancel()

        print(f"[shard {args.shard}] DONE moved={moved:,} in "
              f"{time.time()-t0:.0f}s", flush=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="source Qdrant base URL (fp32)")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--ids-file", help="json list of point ids (see --dump-ids)")
    ap.add_argument("--dump-ids", metavar="PATH",
                    help="dump ids for --collection to PATH and exit")
    ap.add_argument("--dst", help="destination Qdrant base URL")
    ap.add_argument("--dims", type=int, default=4096)
    ap.add_argument("--datatype", default="float16",
                    help="float16 | uint8 | float32 (qdrant has no fp8; the "
                         "8-bit slot is uint8)")
    ap.add_argument("--dst2", help="second destination (written in the same pass)")
    ap.add_argument("--dims2", type=int, default=4096)
    ap.add_argument("--datatype2", default="uint8")
    ap.add_argument("--init-dest", action="store_true",
                    help="create destination collections and exit (run ONCE "
                         "before the shard workers, so they cannot race)")
    ap.add_argument("--shard", type=int, default=0)
    ap.add_argument("--num-shards", type=int, default=1)
    ap.add_argument("--batch", type=int, default=128,
                    help="points per retrieve/upsert. Kept small so a retrieve "
                         "never approaches Qdrant's internal 60s read cap under "
                         "concurrent load.")
    ap.add_argument("--inflight", type=int, default=3)
    args = ap.parse_args()

    if args.dump_ids:
        async def _d():
            async with httpx.AsyncClient(timeout=1800) as c:
                await dump_ids(c, args.src, args.collection, args.dump_ids,
                               args.batch if args.batch > 1000 else 4000)
        return asyncio.run(_d()) or 0

    if not args.dst:
        raise SystemExit("--dst is required unless --dump-ids")
    if not args.ids_file and not args.init_dest:
        raise SystemExit("--ids-file is required unless --dump-ids/--init-dest")
    return asyncio.run(convert(args))


if __name__ == "__main__":
    sys.exit(main())
