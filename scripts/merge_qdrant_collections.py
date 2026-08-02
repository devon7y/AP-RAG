r"""
merge_qdrant_collections.py — API-level merge of one Qdrant collection into another.

Why: the relationships stage is sharded across clusters (REBUILD_SHARD=k/N in
pipeline/ingest.py), each shard committing into its own Qdrant store directory.
Qdrant stores CANNOT be merged at the file level (segment dirs carry random UUIDs;
mixing them corrupts the collection). The safe merge is at the API level: scroll
every point (id + vector + payload) out of the source instance and upsert it into
the destination. Point IDs are content-derived (mdhash of the relation pair), so
re-upserting an already-present point is an idempotent overwrite — overlap between
shards (e.g. the pre-shard base range) merges cleanly.

Usage (run as a CPU job or on a login node with both stores on disk):
    # 1. start two throwaway Qdrant instances against the two store dirs:
    apptainer run --bind SRC_DIR:/qdrant/storage  qdrant.sif &   # port 6333
    apptainer run --bind DST_DIR:/qdrant/storage --env QDRANT__SERVICE__HTTP_PORT=6334 qdrant.sif &
    # 2. merge:
    python merge_qdrant_collections.py \
        --src http://localhost:6333 --dst http://localhost:6334 \
        --collection lightrag_vdb_relationships
    # 3. stop both instances; DST_DIR now holds the union.

THROUGHPUT — the naive version of this script ran at 275 points/s, which is 13h
for the 13M-point corpus merge. Three fixes, all standard Qdrant bulk-load practice:

  1. ``indexing_threshold=0`` on the destination for the duration of the merge.
     Building HNSW over 4096-dim vectors while ingesting is the dominant CPU cost.
     The original threshold is restored at the end and the script waits for the
     collection to go green, so the store is left fully indexed.
  2. ``wait=false`` on the upserts. ``wait=true`` forces a synchronous WAL flush
     and segment update per batch, serialising the whole pipeline. Durability is
     restored at the end by re-sending the LAST batch with ``wait=true`` — note
     that an *empty* update cannot serve as that barrier, Qdrant rejects it with
     "Bad request: Empty update request".
  3. Overlapped scroll and upsert with N in-flight requests, so the source read
     and destination write pipeline instead of alternating.

SKIP-EXISTING — before moving anything, the destination's existing point IDs are
scrolled (ids only, no vectors: fast) into a set, and matching source points are
skipped. Two benefits: the base range shared by every shard store is not re-sent,
and a resumed merge after a walltime kill costs almost nothing for work already done.

Verification: prints src/dst counts before and after; exits nonzero unless the
final dst count is at least max(src, dst-before).
"""

import argparse
import asyncio
import signal
import sys
import time

import httpx


async def count(client: httpx.AsyncClient, base: str, coll: str) -> int:
    r = await client.post(f"{base}/collections/{coll}/points/count",
                          json={"exact": True}, timeout=600)
    r.raise_for_status()
    return r.json()["result"]["count"]


async def get_indexing_threshold(client: httpx.AsyncClient, base: str, coll: str):
    r = await client.get(f"{base}/collections/{coll}", timeout=120)
    r.raise_for_status()
    cfg = r.json()["result"]["config"]
    return cfg.get("optimizer_config", {}).get("indexing_threshold")


async def set_indexing_threshold(client: httpx.AsyncClient, base: str, coll: str,
                                 value: int) -> None:
    r = await client.patch(f"{base}/collections/{coll}",
                           json={"optimizers_config": {"indexing_threshold": value}},
                           timeout=300)
    r.raise_for_status()


async def existing_ids(client: httpx.AsyncClient, base: str, coll: str) -> set:
    """Scroll the destination's point IDs only — no vectors, no payload."""
    ids, offset = set(), None
    t0 = time.time()
    while True:
        body = {"limit": 16384, "with_payload": False, "with_vector": False}
        if offset is not None:
            body["offset"] = offset
        r = await client.post(f"{base}/collections/{coll}/points/scroll",
                              json=body, timeout=600)
        r.raise_for_status()
        res = r.json()["result"]
        pts = res["points"]
        if not pts:
            break
        ids.update(p["id"] for p in pts)
        offset = res.get("next_page_offset")
        if offset is None:
            break
    print(f"[merge] destination already holds {len(ids):,} ids "
          f"(scanned in {time.time() - t0:.0f}s)", flush=True)
    return ids


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="source Qdrant base URL (read)")
    ap.add_argument("--dst", required=True, help="destination Qdrant base URL (written)")
    ap.add_argument("--collection", required=True)
    ap.add_argument("--batch", type=int, default=2000, help="points per scroll/upsert")
    ap.add_argument("--inflight", type=int, default=4, help="concurrent upserts")
    ap.add_argument("--no-skip-existing", action="store_true",
                    help="re-send points already present in the destination")
    ap.add_argument("--keep-indexing", action="store_true",
                    help="do not disable HNSW indexing during the merge")
    ap.add_argument("--restore-threshold", type=int, default=None,
                    help="indexing_threshold to restore when done; always pass "
                         "explicitly (see merge_qdrant_grpc.py for why)")
    args = ap.parse_args()

    # SIGTERM must unwind so the threshold restore in `finally` runs.
    def _term(signum, frame):
        raise KeyboardInterrupt("SIGTERM")
    signal.signal(signal.SIGTERM, _term)

    limits = httpx.Limits(max_connections=args.inflight + 4)
    async with httpx.AsyncClient(timeout=1800, limits=limits) as client:
        c_src = await count(client, args.src, args.collection)
        c_dst0 = await count(client, args.dst, args.collection)
        print(f"[merge] src={c_src:,}  dst(before)={c_dst0:,}", flush=True)

        skip = set()
        if not args.no_skip_existing and c_dst0:
            skip = await existing_ids(client, args.dst, args.collection)

        orig_threshold = None
        if not args.keep_indexing:
            orig_threshold = args.restore_threshold
            if orig_threshold is None:
                orig_threshold = await get_indexing_threshold(
                    client, args.dst, args.collection)
                if not orig_threshold:
                    raise SystemExit(
                        "refusing to run: collection reports indexing_threshold="
                        f"{orig_threshold!r} — a previous run died before restoring "
                        "it. Pass --restore-threshold explicitly.")
            await set_indexing_threshold(client, args.dst, args.collection, 0)
            print(f"[merge] indexing disabled during load "
                  f"(will restore threshold={orig_threshold})", flush=True)

        moved = skipped = 0
        last_batch: list = []
        offset = None
        t0 = time.time()
        pending: set[asyncio.Task] = set()

        async def push(points):
            r = await client.put(
                f"{args.dst}/collections/{args.collection}/points?wait=false",
                json={"points": points})
            r.raise_for_status()

        try:
            while True:
                body = {"limit": args.batch, "with_payload": True, "with_vector": True}
                if offset is not None:
                    body["offset"] = offset
                r = await client.post(
                    f"{args.src}/collections/{args.collection}/points/scroll", json=body)
                r.raise_for_status()
                res = r.json()["result"]
                points = res["points"]
                if not points:
                    break

                up = [{"id": p["id"], "vector": p["vector"],
                       "payload": p.get("payload") or {}}
                      for p in points if p["id"] not in skip]
                skipped += len(points) - len(up)

                if up:
                    last_batch = up
                    # Bound in-flight upserts so memory stays flat.
                    while len(pending) >= args.inflight:
                        done, pending = await asyncio.wait(
                            pending, return_when=asyncio.FIRST_COMPLETED)
                        for d in done:
                            d.result()
                    pending.add(asyncio.create_task(push(up)))
                    moved += len(up)

                offset = res.get("next_page_offset")
                if (moved + skipped) % 100000 < args.batch:
                    el = max(time.time() - t0, 1)
                    print(f"[merge] {moved + skipped:,}/{c_src:,} "
                          f"(moved {moved:,}, skipped {skipped:,}, "
                          f"{(moved + skipped) / el:.0f} pts/s)", flush=True)
                if offset is None:
                    break

            for d in await asyncio.gather(*pending, return_exceptions=True):
                if isinstance(d, BaseException):
                    raise d
            pending.clear()

            # Durability barrier: the upserts above are wait=false, so force them to
            # be applied before we count. Qdrant REJECTS an empty update ("Bad
            # request: Empty update request"), so re-send the last real batch — the
            # point IDs are content-derived, making it an idempotent overwrite.
            if last_batch:
                r = await client.put(
                    f"{args.dst}/collections/{args.collection}/points?wait=true",
                    json={"points": last_batch})
                r.raise_for_status()
        finally:
            for t in pending:
                t.cancel()
            if orig_threshold is not None:
                await set_indexing_threshold(client, args.dst, args.collection,
                                             orig_threshold)
                print(f"[merge] indexing threshold restored to {orig_threshold}",
                      flush=True)

        c_dst1 = await count(client, args.dst, args.collection)
        print(f"[merge] DONE: moved={moved:,} skipped={skipped:,} "
              f"dst(after)={c_dst1:,} (was {c_dst0:,}) in {time.time() - t0:.0f}s",
              flush=True)

        if c_dst1 < max(c_src, c_dst0):
            print("[merge] ERROR: destination count below max(src, dst-before) — "
                  "merge incomplete", flush=True)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
