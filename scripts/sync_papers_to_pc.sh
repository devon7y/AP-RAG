#!/usr/bin/env bash
# Sync the corpus PDFs to the always-on PC so query_server.py can serve them to the web
# app's in-app PDF viewer (GET /pdf, GET /pdf_page).
#
# Source of truth is the papers manifest (data/papers_metadata.json): only files it lists
# are shipped, so the PC mirrors the corpus rather than the whole local library. Files are
# located under $PAPERS_ROOTS (default ~/Papers) and staged flat via hardlinks (no extra
# disk) before a single rsync, because the library is nested and the server wants one flat
# directory keyed by the manifest's basenames.
#
# Destination is on the PC's roomy D: drive (C: has little headroom).
#
# Usage:
#   scripts/sync_papers_to_pc.sh            # sync missing/changed files
#   DRY_RUN=1 scripts/sync_papers_to_pc.sh  # list what would transfer
#
# Re-run after adding papers (the add_papers.py pipeline's natural follow-up step).
#
# NOTE: a pure Drive→PC pull (rclone on the PC, no Mac involvement) is the eventual
# target; it needs one interactive Google OAuth consent click to authorize rclone, so
# until that happens this Mac-side push keeps the PC current from the same content.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${MANIFEST:-$REPO_ROOT/data/papers_metadata.json}"
PAPERS_ROOTS="${PAPERS_ROOTS:-$HOME/Papers}"
PC_HOST="${PC_HOST:-pc}"
PC_DEST="${PC_DEST:-/cygdrive/d/aprag_papers}"
PC_DEST_WIN="${PC_DEST_WIN:-D:\\aprag_papers}"
STAGE="${STAGE:-${TMPDIR:-/tmp}/aprag_pdf_stage}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest not found: $MANIFEST" >&2
  exit 1
fi

echo "== Staging manifest PDFs (hardlinks) =="
rm -rf "$STAGE"
mkdir -p "$STAGE"

python3 - "$MANIFEST" "$STAGE" $PAPERS_ROOTS <<'PY'
import json, os, sys

manifest_path, stage = sys.argv[1], sys.argv[2]
roots = sys.argv[3:]
wanted = set(json.load(open(manifest_path)))

# First match wins; walking in the given root order makes that deterministic.
linked, missing = 0, []
seen = set()
for root in roots:
    root = os.path.expanduser(root)
    if not os.path.isdir(root):
        print(f"  (skipping absent root {root})")
        continue
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name in wanted and name not in seen:
                seen.add(name)
                src = os.path.join(dirpath, name)
                dst = os.path.join(stage, name)
                try:
                    os.link(src, dst)          # hardlink: instant, no extra space
                except OSError:
                    os.symlink(src, dst)       # cross-device: rsync -L copies content
                linked += 1

missing = sorted(wanted - seen)
print(f"  staged {linked} of {len(wanted)} manifest PDFs")
if missing:
    print(f"  NOT FOUND locally ({len(missing)}): {', '.join(missing[:10])}"
          + (" …" if len(missing) > 10 else ""))
PY

echo
echo "== rsync -> $PC_HOST:$PC_DEST =="
ssh "$PC_HOST" "if not exist $PC_DEST_WIN mkdir $PC_DEST_WIN"

RSYNC_FLAGS=(-rltL --copy-unsafe-links --info=progress2 --human-readable)
if [[ -n "${DRY_RUN:-}" ]]; then
  RSYNC_FLAGS+=(--dry-run --itemize-changes)
fi
rsync "${RSYNC_FLAGS[@]}" "$STAGE/" "$PC_HOST:$PC_DEST/"

if [[ -z "${DRY_RUN:-}" ]]; then
  # cygwin rsync leaves files owned by the SSH user with non-inheriting ACLs and the
  # read-only attribute; the query server runs as SYSTEM and would get PermissionDenied.
  # (Same trap that broke Qdrant's WAL — a plain icacls /grant is NOT enough.)
  echo
  echo "== Fixing Windows ACLs so the SYSTEM-run query server can read =="
  ssh "$PC_HOST" "attrib -R $PC_DEST_WIN\\*.pdf /S 2>nul & icacls $PC_DEST_WIN /reset /T /C /Q" \
    >/dev/null 2>&1 || echo "  (icacls reported warnings; verify readability)"
  ssh "$PC_HOST" "dir /b $PC_DEST_WIN | find /c \".pdf\"" | tail -1 | \
    sed 's/^/  PDFs on PC: /'
fi

rm -rf "$STAGE"
echo "Done."
