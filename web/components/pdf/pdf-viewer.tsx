"use client";

import "pdfjs-dist/web/pdf_viewer.css";

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getPdfjs,
  loadPdf,
  pdfPageImageUrl,
  pdfUrl,
} from "@/lib/pdf/loader";
import { type PdfTarget, usePdfViewer } from "@/lib/pdf/store";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

// The in-app PDF viewer: opens a cited paper at the cited page with the quoted passage
// highlighted, beside the answer. Rendering notes:
//   * A WebP raster of the page (served pre-rendered by the PC) paints IMMEDIATELY while
//     pdf.js is still fetching/parsing, so opening never shows an empty panel.
//   * pdf.js draws the real page into a canvas over that image, plus a selectable text
//     layer (pdf.js's own CSS, imported above, positions those spans).
//   * The highlight is best-effort: it searches the text layer for the passage's opening
//     words. Scanned pages with no/garbled text layer simply land on the right page.

const ZOOM_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2, 3] as const;
const HIGHLIGHT_WORD_TRIES = [12, 8, 6, 4] as const;

export function PdfViewerHost() {
  const target = usePdfViewer((s) => s.target);
  const closePdf = usePdfViewer((s) => s.closePdf);

  return (
    <Sheet onOpenChange={(open) => !open && closePdf()} open={Boolean(target)}>
      <SheetContent
        className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
        side="right"
      >
        {target ? <PdfPane target={target} /> : null}
      </SheetContent>
    </Sheet>
  );
}

type Status = "loading" | "ready" | "missing" | "error";

function PdfPane({ target }: { target: PdfTarget }) {
  const goToPage = usePdfViewer((s) => s.goToPage);
  const { filename, page, quote, label, driveUrl } = target;

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const [status, setStatus] = useState<Status>("loading");
  const [numPages, setNumPages] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(2); // 1.0
  const [showPreview, setShowPreview] = useState(true);
  const [highlightFound, setHighlightFound] = useState<boolean | null>(null);

  // Load the document (cached across opens by the loader's LRU).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setShowPreview(true);
    docRef.current = null;
    loadPdf(filename)
      .then((doc) => {
        if (cancelled) {
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const status_ = (error as { status?: number }).status;
        const name = (error as { name?: string }).name;
        setStatus(status_ === 404 || name === "MissingPDFException" ? "missing" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [filename]);

  const renderPage = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const holder = pageRef.current;
    const textLayer = textLayerRef.current;
    if (!(doc && canvas && holder && textLayer)) {
      return;
    }
    const pageNumber = Math.min(Math.max(1, page), doc.numPages);
    const pdfPage = await doc.getPage(pageNumber);

    // Fit the panel width, then apply the user's zoom.
    const available = Math.max(240, (holder.clientWidth || 640) - 8);
    const unscaled = pdfPage.getViewport({ scale: 1 });
    const scale = (available / unscaled.width) * ZOOM_STEPS[zoomIndex];
    const viewport = pdfPage.getViewport({ scale });

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    holder.style.width = `${Math.floor(viewport.width)}px`;
    holder.style.height = `${Math.floor(viewport.height)}px`;

    renderTaskRef.current?.cancel();
    const task = pdfPage.render({
      canvas,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    renderTaskRef.current = task;
    try {
      await task.promise;
    } catch (error) {
      if ((error as { name?: string }).name === "RenderingCancelledException") {
        return; // superseded by a newer render
      }
      throw error;
    }
    setShowPreview(false);

    // Selectable text layer (also what the highlight searches).
    const mod = await getPdfjs();
    textLayer.replaceChildren();
    textLayer.style.width = `${Math.floor(viewport.width)}px`;
    textLayer.style.height = `${Math.floor(viewport.height)}px`;
    textLayer.style.setProperty("--total-scale-factor", String(scale));
    const layer = new mod.TextLayer({
      textContentSource: pdfPage.streamTextContent(),
      container: textLayer,
      viewport,
    });
    await layer.render();

    highlightRef.current?.replaceChildren();
    if (quote) {
      const found = highlightQuote(
        holder,
        textLayer,
        highlightRef.current,
        quote,
        scrollRef.current
      );
      setHighlightFound(found);
    } else {
      setHighlightFound(null);
    }
  }, [page, quote, zoomIndex]);

  // Re-render on page/zoom change, once the document is ready.
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    setShowPreview(true);
    renderPage().catch(() => setStatus("error"));
  }, [status, renderPage]);

  // Re-render on panel resize (the fit-width scale changes).
  useEffect(() => {
    const holder = pageRef.current?.parentElement;
    if (!holder || status !== "ready") {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        renderPage().catch(() => undefined);
      });
    });
    observer.observe(holder);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [status, renderPage]);

  useEffect(
    () => () => {
      renderTaskRef.current?.cancel();
    },
    []
  );

  const canPrev = page > 1;
  const canNext = numPages > 0 && page < numPages;

  // Arrow keys page through the document.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) {
        return;
      }
      if (e.key === "ArrowLeft" && page > 1) {
        goToPage(page - 1);
      } else if (e.key === "ArrowRight" && numPages > 0 && page < numPages) {
        goToPage(page + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, numPages, goToPage]);

  return (
    <>
      <SheetTitle className="sr-only">
        {label ? `PDF: ${label}` : `PDF: ${filename}`}
      </SheetTitle>

      <header className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-[13px]">{label || filename}</p>
          <p className="truncate text-muted-foreground text-xs">
            {status === "ready" && numPages > 0
              ? `Page ${Math.min(page, numPages)} of ${numPages}`
              : status === "loading"
                ? "Loading…"
                : filename}
            {highlightFound === false && " · passage not found on this page"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            aria-label="Previous page"
            disabled={!canPrev}
            onClick={() => goToPage(page - 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button
            aria-label="Next page"
            disabled={!canNext}
            onClick={() => goToPage(page + 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
          <Button
            aria-label="Zoom out"
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <MinusIcon className="size-4" />
          </Button>
          <Button
            aria-label="Zoom in"
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            onClick={() =>
              setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))
            }
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
          </Button>
          <Button aria-label="Open in a new tab" asChild size="icon-sm" type="button" variant="ghost">
            <a href={pdfUrl(filename)} rel="noopener noreferrer" target="_blank">
              <ExternalLinkIcon className="size-4" />
            </a>
          </Button>
          <Button aria-label="Download" asChild size="icon-sm" type="button" variant="ghost">
            <a download={filename} href={pdfUrl(filename, true)}>
              <DownloadIcon className="size-4" />
            </a>
          </Button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto bg-muted/40 p-1"
        ref={scrollRef}
      >
        {(status === "missing" || status === "error") && (
          <div className="mx-auto mt-10 max-w-sm space-y-3 px-4 text-center">
            <p className="text-muted-foreground text-sm">
              {status === "missing"
                ? "This paper isn't on the server yet — it may have been added since the last sync."
                : "Couldn't load this PDF from the server."}
            </p>
            {driveUrl && (
              <Button asChild size="sm" type="button" variant="outline">
                <a href={driveUrl} rel="noopener noreferrer" target="_blank">
                  <ExternalLinkIcon className="size-3.5" />
                  Open in Drive
                </a>
              </Button>
            )}
          </div>
        )}

        {status !== "missing" && status !== "error" && (
          <div className="mx-auto w-fit">
            {/* Positioned stack: preview image, canvas, text layer, highlights. */}
            <div className="relative shadow-sm" ref={pageRef}>
              {showPreview && (
                // biome-ignore lint/performance/noImgElement: pdf page raster, not a static asset
                <img
                  alt=""
                  className="absolute inset-0 h-full w-full bg-white object-contain"
                  src={pdfPageImageUrl(filename, page)}
                />
              )}
              <canvas className="block bg-white" ref={canvasRef} />
              <div
                className="textLayer absolute inset-0"
                ref={textLayerRef}
              />
              <div
                className="pointer-events-none absolute inset-0"
                ref={highlightRef}
              />
              {showPreview && (
                <div className="absolute top-2 right-2 rounded-full bg-background/80 p-1.5">
                  <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Passage highlighting ─────────────────────────────────────────────────────

const normalizeQuote = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Find the passage's opening words in the rendered text layer and paint highlight rects
 * over them, then scroll the first one into view. Returns false when no match is found
 * (a scanned page, or a chunk whose text differs from the page's text layer) — the
 * caller reports that in the header rather than failing the open.
 */
function highlightQuote(
  pageEl: HTMLElement,
  textLayer: HTMLElement,
  highlightLayer: HTMLElement | null,
  quote: string,
  scroller: HTMLElement | null
): boolean {
  if (!highlightLayer) {
    return false;
  }

  // Build a whitespace-normalized string plus a map from each character back to its
  // (text node, offset), so a match can be turned into a real DOM Range — the browser
  // then computes the rectangles for us, including across span and line boundaries.
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const chars: string[] = [];
  const positions: { node: Text; offset: number }[] = [];
  let lastWasSpace = true;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    for (let i = 0; i < text.data.length; i++) {
      const ch = text.data[i];
      if (/\s/.test(ch)) {
        if (lastWasSpace) {
          continue;
        }
        chars.push(" ");
        positions.push({ node: text, offset: i });
        lastWasSpace = true;
      } else {
        chars.push(ch.toLowerCase());
        positions.push({ node: text, offset: i });
        lastWasSpace = false;
      }
    }
  }
  const haystack = chars.join("");
  const words = normalizeQuote(quote).split(" ").filter(Boolean);
  if (words.length === 0 || haystack.length === 0) {
    return false;
  }

  // Try a long phrase first, then shorter ones: extraction differences (ligatures,
  // hyphenation, column order) make long exact matches unreliable.
  const lengths = Array.from(
    new Set(
      [...HIGHLIGHT_WORD_TRIES, words.length]
        .map((n) => Math.min(n, words.length))
        .filter((n) => n > 0)
    )
  ).sort((a, b) => b - a);

  for (const len of lengths) {
    const needle = words.slice(0, len).join(" ");
    if (needle.length < 8) {
      continue;
    }
    const index = haystack.indexOf(needle);
    if (index < 0) {
      continue;
    }
    const start = positions[index];
    const end = positions[index + needle.length - 1];
    if (!(start && end)) {
      continue;
    }
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
    } catch {
      return false;
    }

    const box = pageEl.getBoundingClientRect();
    const fragment = document.createDocumentFragment();
    let first: HTMLElement | null = null;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }
      const mark = document.createElement("div");
      mark.style.position = "absolute";
      mark.style.left = `${rect.left - box.left}px`;
      mark.style.top = `${rect.top - box.top}px`;
      mark.style.width = `${rect.width}px`;
      mark.style.height = `${rect.height}px`;
      mark.style.borderRadius = "2px";
      // Multiply keeps the page text legible through the wash. PDF pages render white
      // in both app themes, so this needs no light/dark variant.
      mark.style.background = "rgb(250 204 21 / 0.42)";
      mark.style.mixBlendMode = "multiply";
      fragment.appendChild(mark);
      first ??= mark;
    }
    if (!first) {
      return false;
    }
    highlightLayer.replaceChildren(fragment);
    if (scroller) {
      const offset = first.offsetTop + pageEl.offsetTop;
      scroller.scrollTo({
        top: Math.max(0, offset - scroller.clientHeight / 3),
        behavior: "smooth",
      });
    }
    return true;
  }
  return false;
}
