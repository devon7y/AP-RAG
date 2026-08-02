r"""
merge_qdrant_grpc.py — gRPC bulk merge of one Qdrant collection into another.

Faster sibling of merge_qdrant_collections.py. Same contract (scroll every point
out of a source instance, upsert into the destination; content-derived point IDs
make it idempotent), but it moves vectors over gRPC/protobuf instead of HTTP/JSON.

WHY gRPC: a 4096-dim float32 vector is 16 KB binary but ~45 KB as a JSON array of
floats, and Python pays json encode/decode on every one. At 2000 points per batch
that is 8.19M floats serialised per request. protobuf through qdrant-client's
C-accelerated path removes both the bytes and most of the CPU.

PORT COLLISION — Qdrant serves gRPC on 6334 BY DEFAULT. Running a second instance
with QDRANT__SERVICE__HTTP_PORT=6334 therefore silently kills gRPC on the first
("Error while starting gRPC server: transport error"). Always assign all four
ports explicitly:
    src  HTTP 6333  gRPC 6335
    dst  HTTP 6334  gRPC 6336

Bulk-load behaviour matches the HTTP version:
  * indexing_threshold=0 on the destination during the load, restored at the end
  * wait=false upserts, with a wait=true barrier before the final count
  * skip-existing: the destination's point IDs are scrolled once (ids only) and
    matching source points are skipped, so the base range shared by every shard
    store is not re-sent and a resumed merge is nearly free

Usage:
    python merge_qdrant_grpc.py --src-host localhost --src-grpc 6335 \
        --dst-host localhost --dst-grpc 6336 \
        --collection lightrag_vdb_relationships
"""

import argparse
import signal
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from qdrant_client import QdrantClient
from qdrant_client.http import models as rest


def connect(host: str, grpc_port: int, http_port: int) -> QdrantClient:
    return QdrantClient(host=host, port=http_port, grpc_port=grpc_port,
                        prefer_grpc=True, timeout=1800)


def existing_ids(client: QdrantClient, coll: str) -> set:
    ids, offset = set(), None
    t0 = time.time()
    while True:
        pts, offset = client.scroll(collection_name=coll, limit=16384,
                                    offset=offset, with_payload=False,
                                    with_vectors=False)
        if not pts:
            break
        ids.update(p.id for p in pts)
        if offset is None:
            break
    print(f"[merge] destination already holds {len(ids):,} ids "
          f"(scanned in {time.time() - t0:.0f}s)", flush=True)
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-host", default="localhost")
    ap.add_argument("--dst-host", default="localhost")
    ap.add_argument("--src-grpc", type=int, default=6335)
    ap.add_argument("--dst-grpc", type=int, default=6336)
    ap.add_argument("--src-http", type=int, default=6333)
    ap.add_argument("--dst-http", type=int, default=6334)
    ap.add_argument("--collection", required=True)
    ap.add_argument("--batch", type=int, default=4000)
    ap.add_argument("--inflight", type=int, default=8)
    ap.add_argument("--no-skip-existing", action="store_true")
    ap.add_argument("--keep-indexing", action="store_true")
    ap.add_argument("--restore-threshold", type=int, default=None,
                    help="indexing_threshold to restore when done. ALWAYS pass this "
                         "explicitly: reading the 'original' off the collection is "
                         "unsafe, because a previous run killed mid-merge leaves 0 "
                         "persisted, and concurrent mergers each read whatever the "
                         "other already set. Both happened; the result was a store "
                         "with every point present but only 2.6% of vectors indexed.")
    args = ap.parse_args()

    # Python's DEFAULT SIGTERM handler exits WITHOUT unwinding, so `finally` never
    # runs and the indexing threshold is left at 0. Turn SIGTERM into an exception
    # so the restore below always executes when a walltime trap kills us.
    def _term(signum, frame):
        raise KeyboardInterrupt("SIGTERM")
    signal.signal(signal.SIGTERM, _term)

    src = connect(args.src_host, args.src_grpc, args.src_http)
    dst = connect(args.dst_host, args.dst_grpc, args.dst_http)
    coll = args.collection

    c_src = src.count(coll, exact=True).count
    c_dst0 = dst.count(coll, exact=True).count
    print(f"[merge] src={c_src:,}  dst(before)={c_dst0:,}", flush=True)

    skip = set()
    if not args.no_skip_existing and c_dst0:
        skip = existing_ids(dst, coll)

    orig_threshold = None
    if not args.keep_indexing:
        if args.restore_threshold is not None:
            orig_threshold = args.restore_threshold
        else:
            info = dst.get_collection(coll)
            orig_threshold = info.config.optimizer_config.indexing_threshold
            if not orig_threshold:
                raise SystemExit(
                    "refusing to run: collection reports indexing_threshold="
                    f"{orig_threshold!r}, which means a previous run died before "
                    "restoring it. Pass --restore-threshold explicitly.")
        dst.update_collection(
            collection_name=coll,
            optimizers_config=rest.OptimizersConfigDiff(indexing_threshold=0))
        print(f"[merge] indexing disabled during load "
              f"(will restore threshold={orig_threshold})", flush=True)

    moved = skipped = 0
    last_batch: list = []
    offset = None
    t0 = time.time()
    pool = ThreadPoolExecutor(max_workers=args.inflight)
    # The semaphore is the only thing bounding in-flight work; it is released in
    # push()'s finally, so a failing upsert can never deadlock the producer.
    sem = threading.Semaphore(args.inflight)
    futures: list = []

    def push(points):
        try:
            dst.upsert(collection_name=coll, points=points, wait=False)
        finally:
            sem.release()

    try:
        while True:
            pts, offset = src.scroll(collection_name=coll, limit=args.batch,
                                     offset=offset, with_payload=True,
                                     with_vectors=True)
            if not pts:
                break

            up = [rest.PointStruct(id=p.id, vector=p.vector, payload=p.payload or {})
                  for p in pts if p.id not in skip]
            skipped += len(pts) - len(up)

            if up:
                last_batch = up
                sem.acquire()
                futures.append(pool.submit(push, up))
                moved += len(up)
                # Surface upsert failures promptly and keep the list bounded.
                if len(futures) > args.inflight * 4:
                    for f in [f for f in futures if f.done()]:
                        f.result()
                    futures = [f for f in futures if not f.done()]

            if (moved + skipped) % 100000 < args.batch:
                el = max(time.time() - t0, 1)
                print(f"[merge] {moved + skipped:,}/{c_src:,} "
                      f"(moved {moved:,}, skipped {skipped:,}, "
                      f"{(moved + skipped) / el:.0f} pts/s)", flush=True)
            if offset is None:
                break

        for f in futures:
            f.result()
        # Durability barrier: the upserts above are wait=false, so force them to be
        # applied before we count. Qdrant REJECTS an empty update ("Bad request:
        # Empty update request"), so re-send the last real batch instead — the point
        # IDs are content-derived, making the rewrite a harmless idempotent overwrite.
        if last_batch:
            dst.upsert(collection_name=coll, points=last_batch, wait=True)
    finally:
        pool.shutdown(wait=True)
        if orig_threshold is not None:
            dst.update_collection(
                collection_name=coll,
                optimizers_config=rest.OptimizersConfigDiff(
                    indexing_threshold=orig_threshold))
            print(f"[merge] indexing threshold restored to {orig_threshold}",
                  flush=True)

    c_dst1 = dst.count(coll, exact=True).count
    print(f"[merge] DONE: moved={moved:,} skipped={skipped:,} "
          f"dst(after)={c_dst1:,} (was {c_dst0:,}) in {time.time() - t0:.0f}s",
          flush=True)

    if c_dst1 < max(c_src, c_dst0):
        print("[merge] ERROR: destination count below max(src, dst-before) — "
              "merge incomplete", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
