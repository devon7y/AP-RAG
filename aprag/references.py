"""
aprag.references — resolve cited PDFs to a *local* file on the reader's machine.

The query server returns an answer whose ``### References`` section already carries
proper APA7 citations, each followed by the hades fallback path
(``hades.psych.ualberta.ca:/Users/Shared/aprag_papers/<file>``). That path is useless
on a laptop, so this module — which runs client-side (the ``aprag`` CLI / MCP server,
on the user's own machine) — rewrites the section: when the cited PDF is found in one
of the user's local paper directories it becomes a clickable ``file://`` link;
otherwise the hades path is shown unchanged.

Matching is by **filename**, which is identical across the RAG store, hades, and a
user's copy (the path may differ). Local directories come from ``$APRAG_PAPERS_DIR``
(``os.pathsep``-separated) plus a few sensible defaults.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

#: Default places to look for a local PDF copy, lowest priority last.
DEFAULT_PAPER_DIRS = ("~/Zotero", "~/Documents/papers", "~/Papers", "~/Downloads")

# Mirror of apa_citations.strip_references_section — duplicated (not imported) so the
# installed aprag package stays self-contained (it ships without the root modules).
_REFS_HEADING_RE = re.compile(
    r"(?im)^[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*[ \t]*)?references[ \t]*:?[ \t]*\**[ \t]*$"
)


def paper_dirs(extra: list[str] | None = None) -> list[Path]:
    """Resolve the local search paths: explicit ``extra`` > $APRAG_PAPERS_DIR > defaults."""
    raw: list[str] = []
    if extra:
        raw.extend(extra)
    env = os.environ.get("APRAG_PAPERS_DIR")
    if env:
        raw.extend(env.split(os.pathsep))
    if not raw:
        raw.extend(DEFAULT_PAPER_DIRS)
    dirs: list[Path] = []
    seen: set[str] = set()
    for entry in raw:
        if not entry.strip():
            continue
        p = Path(entry).expanduser()
        key = str(p)
        if key not in seen and p.is_dir():
            seen.add(key)
            dirs.append(p)
    return dirs


def build_local_index(dirs: list[str] | None = None) -> dict[str, str]:
    """Index local PDFs by lowercased basename → absolute path (first hit wins).

    Walks each directory once (no symlink following). Earlier directories take
    precedence, so order ``paper_dirs`` from most to least authoritative.
    """
    index: dict[str, str] = {}
    for root in paper_dirs(dirs):
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.lower().endswith(".pdf"):
                    index.setdefault(name.lower(), os.path.join(dirpath, name))
    return index


def find_local(filename: str, index: dict[str, str]) -> str | None:
    return index.get((filename or "").lower())


def _file_url(abspath: str) -> str:
    """A clickable file:// URL with proper percent-encoding (spaces, etc.)."""
    return Path(os.path.abspath(abspath)).as_uri()


def _format_pages(pages) -> str:
    """APA page locator for PDF pages: 'p. 12' / 'pp. 3, 12, 19' (else '')."""
    nums = sorted({int(p) for p in (pages or []) if str(p).strip() not in ("", "None")})
    if not nums:
        return ""
    body = ", ".join(str(n) for n in nums)
    return f"p. {body}" if len(nums) == 1 else f"pp. {body}"


def _strip_references(text: str) -> str:
    matches = list(_REFS_HEADING_RE.finditer(text))
    if not matches:
        return text.rstrip()
    return text[: matches[-1].start()].rstrip()


def locator_for(ref: dict, index: dict[str, str]) -> str:
    """A display locator for a cited paper: a clickable local file:// link when the
    PDF is found on this machine, else the hades fallback path."""
    local = find_local(ref.get("filename", ""), index)
    if local:
        return f"[open PDF]({_file_url(local)})"
    return ref.get("hades_path", "")


def localize_answer(answer: str, references: list[dict],
                    index: dict[str, str] | None = None) -> str:
    """Rewrite the answer's references to clickable local links where the PDF exists.

    ``references`` is the structured list the server returns (each
    ``{apa, filename, hades_path, ...}``). With no references the answer is returned
    unchanged (e.g. an older server, or a no-citation answer).
    """
    if not answer or not references:
        return answer
    if index is None:
        index = build_local_index()

    lines = ["### References", ""]
    for ref in references:
        apa_text = ref.get("apa") or ref.get("filename", "")
        entry = f"- {apa_text}"
        pages = _format_pages(ref.get("pages"))
        if pages:
            entry += f" ({pages})"
        locator = locator_for(ref, index)
        if locator:
            entry += f" — {locator}"
        lines.append(entry)

    return _strip_references(answer).rstrip() + "\n\n" + "\n".join(lines)
