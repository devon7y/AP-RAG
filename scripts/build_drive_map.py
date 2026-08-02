#!/usr/bin/env python3
"""Build ``drive_links.json`` — a ``filename → Google Drive webViewLink`` map for the
corpus, so query answers can fall back to a per-file Drive link when a reader has no
local copy (see ``apa_citations.py`` / ``query_server.py``).

A Drive file's URL is an opaque per-file ID (``drive.google.com/file/d/<ID>/view``) — it
cannot be derived from the filename — so this enumerates the (private, shared) Drive
folder once and records each PDF's link. Re-run after adding papers.

Two ways to enumerate the folder:

    # rclone (simplest: `rclone config` a Google Drive remote once), recursive:
    python3 build_drive_map.py rclone gdrive:aprag_papers [--out drive_links.json]

    # Google Drive API v3 (needs `pip install google-api-python-client google-auth`
    # and an OAuth/service-account creds JSON; the folder must be shared with it):
    python3 build_drive_map.py api <FOLDER_ID> --creds creds.json [--out drive_links.json]

Deploy ``drive_links.json`` next to ``query_server.py``; point the server at it with
``APRAG_DRIVE_MAP`` (default: alongside the script). The links open only for Google
accounts the folder is shared with — nothing is exposed publicly.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys


def _drive_url(file_id: str) -> str:
    return f"https://drive.google.com/file/d/{file_id}/view?usp=drivesdk"


def _dedup(pairs: list[tuple[str, str]]) -> dict:
    """{name: url}, warning on duplicate filenames (first kept) since the manifest keys
    on a unique canonical basename."""
    out: dict[str, str] = {}
    for name, url in pairs:
        if not name.lower().endswith(".pdf"):
            continue
        if name in out:
            print(f"  WARN duplicate filename in Drive, keeping first: {name}", file=sys.stderr)
            continue
        out[name] = url
    return out


def from_mount(directory: str) -> dict:
    """Read each PDF's Drive file ID from the Google Drive for Desktop mount's
    ``com.google.drivefs.item-id#S`` extended attribute — no auth/API needed. Slow on a
    cold mount (Drive streams the directory listing); progress is logged."""
    import ctypes
    import ctypes.util
    import os

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

    def getxattr(path: str, name: str) -> str:
        buf = ctypes.create_string_buffer(512)
        # macOS: ssize_t getxattr(path, name, value, size, u_int32_t position, int options)
        n = libc.getxattr(os.fsencode(path), name.encode(), buf, 512, 0, 0)
        return buf.raw[:n].decode("utf-8", "ignore") if n and n > 0 else ""

    pairs: list[tuple[str, str]] = []
    seen_id = 0
    total = 0
    for root, _dirs, files in os.walk(directory):
        for nm in files:
            if not nm.lower().endswith(".pdf"):
                continue
            total += 1
            fid = getxattr(os.path.join(root, nm), "com.google.drivefs.item-id#S")
            if fid:
                pairs.append((nm, _drive_url(fid)))
                seen_id += 1
            if total % 500 == 0:
                print(f"  ...{total} pdfs scanned ({seen_id} with Drive IDs)", file=sys.stderr)
    print(f"scanned {total} pdfs; {seen_id} had Drive IDs", file=sys.stderr)
    return _dedup(pairs)


def from_rclone(remote: str) -> dict:
    """List a Drive remote recursively via `rclone lsjson` and build the map."""
    try:
        res = subprocess.run(
            ["rclone", "lsjson", "--files-only", "-R", "--no-modtime", remote],
            capture_output=True, text=True, timeout=1800, check=True,
        )
    except FileNotFoundError:
        print("error: rclone not found on PATH (install it + `rclone config` a Drive remote)",
              file=sys.stderr)
        raise SystemExit(2)
    except subprocess.CalledProcessError as e:
        print(f"error: rclone failed: {e.stderr[:400]}", file=sys.stderr)
        raise SystemExit(2)
    items = json.loads(res.stdout)
    pairs = [(it.get("Name", ""), _drive_url(it["ID"])) for it in items if it.get("ID")]
    return _dedup(pairs)


def from_api(folder_id: str, creds_path: str) -> dict:
    """List a Drive folder (recursively) via the Drive API v3 and build the map."""
    try:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        print("error: pip install google-api-python-client google-auth", file=sys.stderr)
        raise SystemExit(2)
    creds = Credentials.from_service_account_file(
        creds_path, scopes=["https://www.googleapis.com/auth/drive.readonly"])
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)

    pairs: list[tuple[str, str]] = []
    folders = [folder_id]
    while folders:
        fid = folders.pop()
        page = None
        while True:
            resp = svc.files().list(
                q=f"'{fid}' in parents and trashed=false",
                fields="nextPageToken, files(id, name, mimeType, webViewLink)",
                pageSize=1000, pageToken=page,
                supportsAllDrives=True, includeItemsFromAllDrives=True,
            ).execute()
            for f in resp.get("files", []):
                if f.get("mimeType") == "application/vnd.google-apps.folder":
                    folders.append(f["id"])
                else:
                    pairs.append((f.get("name", ""), f.get("webViewLink") or _drive_url(f["id"])))
            page = resp.get("nextPageToken")
            if not page:
                break
    return _dedup(pairs)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)
    pm = sub.add_parser("mount", help="read Drive IDs from a Google Drive for Desktop mount")
    pm.add_argument("directory", help="path to the mounted papers folder")
    pr = sub.add_parser("rclone", help="enumerate via an rclone Drive remote")
    pr.add_argument("remote", help="e.g. gdrive:aprag_papers")
    pa = sub.add_parser("api", help="enumerate via the Drive API v3")
    pa.add_argument("folder_id")
    pa.add_argument("--creds", required=True, help="service-account / OAuth creds JSON")
    for p in (pm, pr, pa):
        p.add_argument("--out", default="data/drive_links.json")
    args = ap.parse_args()

    if args.mode == "mount":
        mapping = from_mount(args.directory)
    elif args.mode == "rclone":
        mapping = from_rclone(args.remote)
    else:
        mapping = from_api(args.folder_id, args.creds)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(mapping, fh, indent=1, ensure_ascii=False)
    print(f"wrote {len(mapping)} Drive links → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
