"use client";

import "pdfjs-dist/web/pdf_viewer.css";

import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getPdfjs, loadPdf, pdfPageImageUrl, pdfUrl } from "@/lib/pdf/loader";
import { type PdfTab, usePdfViewer } from "@/lib/pdf/store";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";

// The reader pane: open papers as tabs, scrolled continuously, opened at the cited page
// with the quoted passage highlighted.
//
// Three properties this file works hard for:
//   * Switching tabs is instant — every open tab stays mounted and inactive ones are
//     just hidden, so their canvases, text layers and scroll positions survive.
//   * Dragging the divider is smooth — re-rendering pdf.js on every pixel of a drag is
//     what made it crawl, so the pages are CSS-scaled during the drag and re-rastered
//     once it settles.
//   * Zoom feels native — trackpad pinch (ctrl+wheel on Chrome, gesture events on
//     Safari) zooms the PDF only, never the page.
//
// Rendering is continuous + virtualized: each page is an absolutely positioned slot
// sized from page 1, only pages near the viewport render to canvas, and the
// server-rendered WebP stands in everywhere else.

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
/** Pages rendered on each side of the viewport. */
const RENDER_WINDOW = 1;
const PAGE_GAP = 12;
/** How long the divider must be still before pages are re-rastered. */
const RESIZE_SETTLE_MS = 160;

type PageBox = { width: number; height: number };

export function PdfReader({ onClose }: { onClose?: () => void }) {
  const tabs = usePdfViewer((s) => s.tabs);
  const activeId = usePdfViewer((s) => s.activeId);
  const setActive = usePdfViewer((s) => s.setActive);
  const closeTab = usePdfViewer((s) => s.closeTab);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  if (!active) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-border/60 border-l bg-muted/30">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-border/60 border-b bg-background/60 px-1.5 py-1 no-scrollbar">
        {tabs.map((tab) => (
          <div
            className={cn(
              "group flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
              tab.id === active.id
                ? "border-border bg-background font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent"
            )}
            key={tab.id}
          >
            <button
              className="max-w-44 truncate"
              onClick={() => setActive(tab.id)}
              title={tab.label || tab.filename}
              type="button"
            >
              {tab.label || tab.filename.replace(/\.pdf$/i, "")}
            </button>
            <button
              aria-label={`Close ${tab.label || tab.filename}`}
              className="rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground"
              onClick={() => closeTab(tab.id)}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
        {onClose && (
          <Button
            aria-label="Close reader"
            className="ml-auto shrink-0"
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        )}
      </div>

      {/* Every open tab stays mounted; only the active one is visible. Re-mounting on
          each switch is what made switching slow (reload, re-raster, re-locate). */}
      {tabs.map((tab) => (
        <PdfDocumentPane
          active={tab.id === active.id}
          key={tab.id}
          tab={tab}
        />
      ))}
    </div>
  );
}

function PdfDocumentPane({ tab, active }: { tab: PdfTab; active: boolean }) {
  const setPage = usePdfViewer((s) => s.setPage);
  const setLocated = usePdfViewer((s) => s.setLocated);

  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">(
    "loading"
  );
  const [numPages, setNumPages] = useState(0);
  const [baseBox, setBaseBox] = useState<PageBox | null>(null);
  const [zoom, setZoom] = useState(1);
  // `width` drives rasterization and only changes once a resize settles;
  // `liveWidth` follows the divider every frame so the pages can be CSS-scaled.
  const [width, setWidth] = useState(720);
  const [liveWidth, setLiveWidth] = useState(720);
  const [visible, setVisible] = useState({ from: 1, to: 3 });
  const [currentPage, setCurrentPage] = useState(tab.page);

  // ── Load the document ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadPdf(tab.filename)
      .then(async (doc) => {
        if (cancelled) {
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (!cancelled) {
          setBaseBox({ width: vp.width, height: vp.height });
          setStatus("ready");
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const status_ = (error as { status?: number }).status;
        const name = (error as { name?: string }).name;
        setStatus(
          status_ === 404 || name === "MissingPDFException" ? "missing" : "error"
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tab.filename]);

  // ── Resolve where the cited passage lives (page + highlight boxes) ─────────
  useEffect(() => {
    if (!tab.quote || tab.located) {
      return;
    }
    let cancelled = false;
    fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/pdf-locate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: tab.filename,
        quote: tab.quote,
        hintPage: tab.requestedPage,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setLocated(tab.id, { page: data.page ?? null, rects: data.rects ?? [] });
        }
      })
      .catch(() => {
        /* highlight is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id, tab.filename, tab.quote, tab.located, tab.requestedPage, setLocated]);

  // ── Width: track live, commit when the drag settles ───────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    let settle: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // A hidden (inactive) tab measures 0 — ignore, or it would raster at zero width.
      if (next <= 0) {
        return;
      }
      setLiveWidth(next);
      if (settle) {
        clearTimeout(settle);
      }
      settle = setTimeout(() => setWidth(next), RESIZE_SETTLE_MS);
    });
    observer.observe(el);
    const initial = el.clientWidth;
    if (initial > 0) {
      setLiveWidth(initial);
      setWidth(initial);
    }
    return () => {
      if (settle) {
        clearTimeout(settle);
      }
      observer.disconnect();
    };
  }, []);

  const scale = useMemo(() => {
    if (!baseBox) {
      return 1;
    }
    return Math.max(0.1, ((width - 24) / baseBox.width) * zoom);
  }, [baseBox, width, zoom]);

  // While the divider is moving, stretch what is already painted instead of
  // re-rendering: cheap, and visually identical until it settles.
  const previewScale = width > 0 ? liveWidth / width : 1;

  const pageHeight = baseBox ? baseBox.height * scale : 0;
  const pageWidth = baseBox ? baseBox.width * scale : 0;
  const strideY = pageHeight + PAGE_GAP;
  const pageOffset = useCallback((page: number) => (page - 1) * strideY, [strideY]);

  // ── Virtualization + current-page tracking ────────────────────────────────
  const recomputeVisible = useCallback(() => {
    const el = scrollRef.current;
    if (!(el && strideY > 0)) {
      return;
    }
    const first = Math.floor(el.scrollTop / strideY) + 1;
    const last = Math.ceil((el.scrollTop + el.clientHeight) / strideY);
    setVisible({
      from: Math.max(1, first - RENDER_WINDOW),
      to: Math.min(numPages || 1, last + RENDER_WINDOW),
    });
    const middle = Math.floor((el.scrollTop + el.clientHeight / 2) / strideY) + 1;
    setCurrentPage(Math.min(Math.max(1, middle), numPages || 1));
  }, [strideY, numPages]);

  useEffect(() => {
    recomputeVisible();
  }, [recomputeVisible]);

  useEffect(() => {
    if (active && currentPage !== tab.page) {
      setPage(tab.id, currentPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, active]);

  // ── Trackpad pinch zooms the PDF, not the page ────────────────────────────
  const applyZoom = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      const el = scrollRef.current;
      if (el && next !== z) {
        // Keep roughly the same content under the viewport centre.
        const ratio = next / z;
        const centre = el.scrollTop + el.clientHeight / 2;
        requestAnimationFrame(() => {
          el.scrollTop = centre * ratio - el.clientHeight / 2;
        });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    // macOS trackpad pinch arrives as a wheel event with ctrlKey set; the default
    // action is a full-page browser zoom, so it must be cancelled here (which needs a
    // non-passive listener).
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) {
        return;
      }
      e.preventDefault();
      applyZoom(Math.exp(-e.deltaY * 0.01));
    };
    // Safari sends its own gesture events instead.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = (e as Event & { scale: number }).scale || 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const s = (e as Event & { scale: number }).scale || 1;
      applyZoom(s / (gestureStart || 1));
      gestureStart = s;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart as EventListener);
    el.addEventListener("gesturechange", onGestureChange as EventListener);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart as EventListener);
      el.removeEventListener("gesturechange", onGestureChange as EventListener);
    };
  }, [applyZoom]);

  // ── Jump to the requested page once geometry is known ─────────────────────
  const jumpedTo = useRef<number | null>(null);
  useEffect(() => {
    const want = tab.requestedPage;
    const el = scrollRef.current;
    if (!(want && el && status === "ready" && strideY > 0)) {
      return;
    }
    if (jumpedTo.current === want) {
      return;
    }
    jumpedTo.current = want;
    el.scrollTo({ top: pageOffset(want) - 8, behavior: "auto" });
    recomputeVisible();
  }, [tab.requestedPage, status, strideY, pageOffset, recomputeVisible]);

  const goToPage = (page: number) => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const clamped = Math.min(Math.max(1, page), numPages || 1);
    el.scrollTo({ top: pageOffset(clamped) - 8, behavior: "smooth" });
  };

  const highlightPage = tab.located?.page ?? null;
  const highlightRects = tab.located?.rects ?? [];

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", !active && "hidden")}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">{tab.label || tab.filename}</p>
          <p className="truncate text-muted-foreground text-xs">
            {status === "ready" && numPages > 0
              ? `Page ${currentPage} of ${numPages}`
              : status === "loading"
                ? "Loading…"
                : ""}
            {tab.quote &&
              tab.located &&
              (highlightPage
                ? ` · passage on page ${highlightPage}`
                : " · passage not found in the text layer")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => goToPage(currentPage - 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <span aria-hidden>↑</span>
          </Button>
          <Button
            aria-label="Next page"
            disabled={numPages > 0 && currentPage >= numPages}
            onClick={() => goToPage(currentPage + 1)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <span aria-hidden>↓</span>
          </Button>
          {highlightPage && (
            <Button
              className="h-7 px-2 text-xs"
              onClick={() => goToPage(highlightPage)}
              title="Scroll back to the cited passage"
              type="button"
              variant="ghost"
            >
              Passage
            </Button>
          )}
          <Button
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => applyZoom(1 / ZOOM_STEP)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <MinusIcon className="size-4" />
          </Button>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => applyZoom(ZOOM_STEP)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
          </Button>
          <Button aria-label="Open in a new tab" asChild size="icon-sm" type="button" variant="ghost">
            <a href={pdfUrl(tab.filename)} rel="noopener noreferrer" target="_blank">
              <ExternalLinkIcon className="size-4" />
            </a>
          </Button>
          <Button aria-label="Download" asChild size="icon-sm" type="button" variant="ghost">
            <a download={tab.filename} href={pdfUrl(tab.filename, true)}>
              <DownloadIcon className="size-4" />
            </a>
          </Button>
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto overscroll-none p-2"
        onScroll={recomputeVisible}
        ref={scrollRef}
        style={{ touchAction: "pan-x pan-y" }}
      >
        {(status === "missing" || status === "error") && (
          <div className="mx-auto mt-10 max-w-sm space-y-3 px-4 text-center">
            <p className="text-muted-foreground text-sm">
              {status === "missing"
                ? "This paper isn't on the server yet — it may have been added since the last sync."
                : "Couldn't load this PDF from the server."}
            </p>
            {tab.driveUrl && (
              <Button asChild size="sm" type="button" variant="outline">
                <a href={tab.driveUrl} rel="noopener noreferrer" target="_blank">
                  <ExternalLinkIcon className="size-3.5" />
                  Open in Drive
                </a>
              </Button>
            )}
          </div>
        )}

        {status === "loading" && (
          <div className="flex h-32 items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === "ready" && baseBox && (
          <div
            className="relative mx-auto"
            style={{
              width: pageWidth,
              height: strideY * numPages,
              // During a drag this stretches the already-painted pages; it is 1 (a
              // no-op) as soon as the width settles and the pages re-raster.
              transform: previewScale === 1 ? undefined : `scale(${previewScale})`,
              transformOrigin: "top center",
            }}
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
              <PageSlot
                doc={docRef.current}
                filename={tab.filename}
                height={pageHeight}
                highlights={page === highlightPage ? highlightRects : []}
                key={page}
                page={page}
                render={page >= visible.from && page <= visible.to}
                scale={scale}
                top={pageOffset(page)}
                width={pageWidth}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PageSlot({
  doc,
  filename,
  page,
  top,
  width,
  height,
  scale,
  render,
  highlights,
}: {
  doc: PDFDocumentProxy | null;
  filename: string;
  page: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  render: boolean;
  highlights: [number, number, number, number][];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    if (!(render && doc)) {
      setPainted(false); // unmounted canvas: fall back to the page image
      return;
    }
    let cancelled = false;
    (async () => {
      const pdfPage = await doc.getPage(page);
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas || cancelled) {
        return;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      taskRef.current?.cancel();
      const task = pdfPage.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      taskRef.current = task;
      try {
        await task.promise;
      } catch {
        return; // superseded by a newer render, or the pane went away
      }
      if (cancelled) {
        return;
      }
      setPainted(true);

      const layer = textRef.current;
      if (layer) {
        const mod = await getPdfjs();
        layer.replaceChildren();
        layer.style.width = `${Math.floor(viewport.width)}px`;
        layer.style.height = `${Math.floor(viewport.height)}px`;
        layer.style.setProperty("--total-scale-factor", String(scale));
        const textLayer = new mod.TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: layer,
          viewport,
        });
        await textLayer.render();
      }
    })();
    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [render, doc, page, scale]);

  return (
    <div
      className="absolute left-0 bg-white shadow-sm"
      style={{ top, width, height }}
    >
      {(!render || !painted) && (
        // biome-ignore lint/performance/noImgElement: rendered pdf page, not a static asset
        <img
          alt=""
          className="absolute inset-0 h-full w-full object-contain"
          loading="lazy"
          src={pdfPageImageUrl(filename, page)}
        />
      )}
      {render && <canvas className="block" ref={canvasRef} />}
      {render && <div className="textLayer absolute inset-0" ref={textRef} />}

      {highlights.map(([x0, y0, x1, y1], i) => (
        <div
          className="pointer-events-none absolute rounded-[2px]"
          key={`${x0}-${y0}-${i}`}
          style={{
            left: `${x0 * 100}%`,
            top: `${y0 * 100}%`,
            width: `${Math.max(0, x1 - x0) * 100}%`,
            height: `${Math.max(0, y1 - y0) * 100}%`,
            background: "rgb(250 204 21 / 0.42)",
            mixBlendMode: "multiply",
          }}
        />
      ))}

      <span className="absolute right-1 bottom-1 rounded bg-background/70 px-1 text-[10px] text-muted-foreground tabular-nums">
        {page}
      </span>
    </div>
  );
}
