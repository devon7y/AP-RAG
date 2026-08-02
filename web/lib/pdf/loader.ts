"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";

// Client-side PDF loading and prefetch policy.
//
// Prefetch matters because the bytes come from the always-on PC over a tunnel: a cold
// open costs ~1s of sequential range requests, which is too slow to feel like part of
// the answer. The retrieval payload (the reference list) arrives BEFORE the synthesis
// finishes streaming, so there is usually 10+ seconds of streaming and reading time in
// which to warm the papers the reader is most likely to check.
//
// Policy (measured against real corpus PDFs: mean paper ~2MB, one rendered page ~285KB):
//   * on retrieval  — warm the top few papers as real pdf.js documents, including the
//                     cited page's objects, so a click renders with no network at all.
//   * on hover      — warm this paper's cited page IMAGE (one cheap request) and start
//                     its document; covers the tail without prefetching everything.
// Both are skipped when the browser reports a metered/slow connection.

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Parsed documents kept alive; insertion order is the LRU order. */
const MAX_CACHED_DOCS = 4;

type Entry = {
  destroy: () => void;
  doc: Promise<PDFDocumentProxy>;
};

const cache = new Map<string, Entry>();
const imagePrefetched = new Set<string>();

type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** Load pdf.js lazily (it is ~400KB) and point it at the self-hosted module worker. */
export function getPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      // Served from public/ rather than resolved through the bundler, so worker loading
      // behaves identically under every bundler. Re-copy with `pnpm sync-pdfjs-worker`
      // whenever pdfjs-dist is upgraded — the worker must match the library version.
      mod.GlobalWorkerOptions.workerSrc = `${BASE}/pdfjs/pdf.worker.min.js`;
      return mod;
    });
  }
  return pdfjsPromise;
}

export function pdfUrl(filename: string, download = false): string {
  return `${BASE}/api/pdf/${encodeURIComponent(filename)}${download ? "?download=1" : ""}`;
}

export function pdfPageImageUrl(filename: string, page: number): string {
  const sp = new URLSearchParams({ filename, page: String(Math.max(1, page)) });
  return `${BASE}/api/pdf-page?${sp.toString()}`;
}

/** Respect metered/slow connections — prefetch is a convenience, never a cost we impose. */
export function shouldPrefetch(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const conn = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (!conn) {
    return true;
  }
  if (conn.saveData) {
    return false;
  }
  return !(conn.effectiveType === "2g" || conn.effectiveType === "slow-2g");
}

function evictOldest() {
  while (cache.size > MAX_CACHED_DOCS) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      return;
    }
    const entry = cache.get(oldestKey);
    cache.delete(oldestKey);
    try {
      entry?.destroy();
    } catch {
      /* already torn down */
    }
  }
}

/**
 * The parsed document for a paper, cached. `disableAutoFetch` keeps pdf.js to the ranges
 * a page actually needs instead of pulling the whole file over the tunnel.
 */
export function loadPdf(filename: string): Promise<PDFDocumentProxy> {
  const hit = cache.get(filename);
  if (hit) {
    cache.delete(filename); // re-insert: most recently used
    cache.set(filename, hit);
    return hit.doc;
  }

  // The loading task only exists once pdf.js itself has loaded, so `destroy` is wired
  // through this closure rather than captured up front.
  let destroyTask: () => void = () => undefined;
  const doc = getPdfjs().then((mod) => {
    const task = mod.getDocument({
      url: pdfUrl(filename),
      disableAutoFetch: true,
      withCredentials: true, // same-origin proxy, but be explicit about the session
    });
    destroyTask = () => {
      void task.destroy();
    };
    return task.promise;
  });

  const entry: Entry = { doc, destroy: () => destroyTask() };
  cache.set(filename, entry);
  evictOldest();
  // A failed load must not poison the cache — the next attempt should retry.
  doc.catch(() => {
    if (cache.get(filename) === entry) {
      cache.delete(filename);
    }
  });
  return doc;
}

function onIdle(run: () => void) {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(run, { timeout: 4000 });
  } else {
    setTimeout(run, 400);
  }
}

/** Warm one paper's document and the objects for its cited page. */
export function prefetchPdf(filename: string, page = 1): void {
  if (!(filename && shouldPrefetch())) {
    return;
  }
  onIdle(() => {
    loadPdf(filename)
      .then((doc) => doc.getPage(Math.min(Math.max(1, page), doc.numPages)))
      .catch(() => {
        /* prefetch is best-effort */
      });
  });
}

/** Warm just the rendered page image (~285KB, one request) — the hover path. */
export function prefetchPageImage(filename: string, page = 1): void {
  if (!(filename && shouldPrefetch())) {
    return;
  }
  const key = `${filename}#${page}`;
  if (imagePrefetched.has(key)) {
    return;
  }
  imagePrefetched.add(key);
  const img = new Image();
  img.decoding = "async";
  img.src = pdfPageImageUrl(filename, page);
}

/**
 * Called when a turn's retrieval payload arrives: warm the papers the answer leans on
 * most. `items` must already be ordered by importance (the chat route returns references
 * frequency-ranked, so reference order is exactly that signal).
 */
export function prefetchReferences(
  items: { filename: string; page?: number }[],
  limit = 5
): void {
  if (!shouldPrefetch()) {
    return;
  }
  for (const item of items.filter((i) => i.filename).slice(0, limit)) {
    prefetchPdf(item.filename, item.page ?? 1);
  }
}

/** Hover promotion: the cheap image now, the document in parallel for the click. */
export function promotePdf(filename: string, page = 1): void {
  prefetchPageImage(filename, page);
  prefetchPdf(filename, page);
}
