#!/usr/bin/env python3
"""Quarantine a poison doc by marking it 'failed' in doc_status so the ingest
skips it (the pipeline's own resume-skip + LightRAG only-process-pending rules).
Usage: quarantine_doc.py <doc-id>   (backs up doc_status first; idempotent)."""
import sys, json, shutil, time
DS = "/scratch/devon7y/westbury_rag/rag_storage_full/kv_store_doc_status.json"
doc = sys.argv[1] if len(sys.argv) > 1 else ""
if not doc.startswith("doc-"):
    print("NOOP: not a doc id:", doc); sys.exit(0)
d = json.load(open(DS))
if doc not in d:
    print("NOOP: unknown doc", doc); sys.exit(0)
if d[doc].get("status") == "failed":
    print("NOOP: already failed", doc); sys.exit(0)
shutil.copy(DS, DS + ".bak_autoq")
fp = d[doc].get("file_path", "?")
d[doc]["status"] = "failed"
json.dump(d, open(DS, "w"))
from collections import Counter
c = dict(Counter(v.get("status") for v in d.values()))
print(f"QUARANTINED {doc} ({fp}) -> failed | counts={c}")
