"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { RagChunk, RagReference } from "@/lib/aprag/types";
import { pdfPageImageUrl, promotePdf } from "@/lib/pdf/loader";
import { usePdfViewer } from "@/lib/pdf/store";
import { MessageResponse } from "../ai-elements/message";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { splitChunkContent } from "./rag-chunks";

type CitationData = {
  chunkByCiteIndex: Map<number, RagChunk>;
  refByReferenceId: Map<string, RagReference>;
};

export const CitationContext = createContext<CitationData | null>(null);

// Only one citation card is open at a time: each card registers a close handler; opening
// one closes all others (fixes hovering a second citation while one is pinned open).
const closeHandlers = new Set<() => void>();

export function CitationAnchor({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const ctx = useContext(CitationContext);

  if (!href?.startsWith("#cite-") || !ctx) {
    return href ? (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <>{children}</>
    );
  }

  const indices = href
    .slice("#cite-".length)
    .split("_")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const chunks = indices
    .map((i) => ctx.chunkByCiteIndex.get(i))
    .filter((c): c is RagChunk => Boolean(c));

  if (chunks.length === 0) {
    return <span className="whitespace-nowrap">{children}</span>;
  }

  return (
    <CitationCard chunks={chunks} refByReferenceId={ctx.refByReferenceId}>
      {children}
    </CitationCard>
  );
}

function CitationCard({
  chunks,
  refByReferenceId,
  children,
}: {
  chunks: RagChunk[];
  refByReferenceId: Map<string, RagReference>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const pinned = useRef(false);
  // Mirror of `pinned` for rendering: a pinned card (an explicit click, i.e. real intent)
  // is where the page preview appears — hover stays instant and text-only.
  const [isPinned, setIsPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfHandler = useRef<() => void>(() => {});
  const openPdf = usePdfViewer((s) => s.openPdf);

  useEffect(() => {
    const fn = () => {
      pinned.current = false;
      setIsPinned(false);
      setOpen(false);
    };
    selfHandler.current = fn;
    closeHandlers.add(fn);
    return () => {
      closeHandlers.delete(fn);
    };
  }, []);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closeOthers = () => {
    for (const h of closeHandlers) {
      if (h !== selfHandler.current) {
        h();
      }
    }
  };
  const openNow = () => {
    cancelClose();
    closeOthers();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pinned.current) {
        setOpen(false);
      }
    }, 140);
  };
  const togglePin = () => {
    if (pinned.current && open) {
      pinned.current = false;
      setIsPinned(false);
      setOpen(false);
    } else {
      pinned.current = true;
      setIsPinned(true);
      cancelClose();
      closeOthers();
      setOpen(true);
    }
  };

  const n = chunks.length;
  const chunk = chunks[Math.min(idx, n - 1)];
  const reference = refByReferenceId.get(chunk.reference_id ?? "");
  const label = reference?.apa || reference?.filename || chunk.file_path;
  const score = typeof chunk.score === "number" ? chunk.score.toFixed(3) : null;
  const { context, text } = splitChunkContent(chunk.content);

  // The cited page: stamped on the chunk by a page-aware store, else the reference's
  // first known page, else the front page.
  const citedPage = chunk.page ?? reference?.pages?.[0] ?? 1;
  const pdfName = reference?.filename ?? "";

  // Hovering a citation is a strong signal that the reader may open the PDF — start
  // warming it now so the click renders with no network wait.
  const warmPdf = () => {
    if (pdfName) {
      promotePdf(pdfName, citedPage);
    }
  };

  const openInViewer = () => {
    if (!pdfName) {
      return;
    }
    openPdf({
      filename: pdfName,
      page: citedPage,
      quote: text,
      label: reference?.intext || reference?.filename,
      driveUrl: reference?.drive_url,
    });
  };

  return (
    <Popover
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          pinned.current = false;
        }
      }}
      open={open}
    >
      <PopoverAnchor asChild>
        <button
          className="cursor-pointer whitespace-nowrap rounded-sm font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80"
          onClick={togglePin}
          onFocus={warmPdf}
          onMouseEnter={() => {
            openNow();
            warmPdf();
          }}
          onMouseLeave={scheduleClose}
          type="button"
        >
          {children}
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="flex max-h-[min(85vh,var(--radix-popover-content-available-height))] w-[min(94vw,46rem)] flex-col overflow-hidden p-0"
        collisionPadding={8}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
        side="top"
        sideOffset={6}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-border/60 border-b bg-muted/40 px-3 py-1.5">
          <span className="text-muted-foreground text-xs">
            Cited passage{n > 1 ? `  ·  ${Math.min(idx, n - 1) + 1} of ${n}` : ""}
          </span>
          {n > 1 && (
            <div className="flex items-center gap-0.5">
              <button
                aria-label="Previous passage"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setIdx((i) => (i - 1 + n) % n)}
                type="button"
              >
                <ChevronLeftIcon className="size-4" />
              </button>
              <button
                aria-label="Next passage"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setIdx((i) => (i + 1) % n)}
                type="button"
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
          <div className="mb-2 flex items-start justify-between gap-3 text-[13px]">
            <div className="min-w-0 font-medium [&_p]:m-0 [&_p]:inline">
              <MessageResponse>{label}</MessageResponse>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
              {chunk.page != null && <span>p. {chunk.page}</span>}
              {score && (
                <span className="tabular-nums" title="Relevance score (vector similarity)">
                  {score}
                </span>
              )}
              {pdfName && (
                <button
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  onClick={openInViewer}
                  title={`Open the PDF at page ${citedPage} with this passage highlighted`}
                  type="button"
                >
                  <FileTextIcon className="size-3" />
                  Open PDF
                </button>
              )}
              {reference?.drive_url && (
                <a
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  href={reference.drive_url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <ExternalLinkIcon className="size-3" />
                  PDF
                </a>
              )}
              {reference?.filename && (
                <Link
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  href={`/papers?similar=${encodeURIComponent(reference.filename)}`}
                  title="Papers most similar to this one"
                >
                  <SparklesIcon className="size-3" />
                  Similar
                </Link>
              )}
            </div>
          </div>
          {context && (
            <p className="mb-2 text-muted-foreground text-xs italic leading-snug">
              {context}
            </p>
          )}
          <p className="whitespace-pre-wrap text-[13px] text-foreground/90 leading-[1.6]">
            {text ? `“${text}”` : ""}
          </p>
          {/* Pinned (clicked) cards show the cited page itself — one cheap image request,
              already warmed by the hover that preceded the click. */}
          {isPinned && pdfName && (
            <button
              className="mt-2.5 block w-full overflow-hidden rounded-md border border-border/60 bg-white transition-opacity hover:opacity-90"
              onClick={openInViewer}
              title={`Open page ${citedPage} in the viewer`}
              type="button"
            >
              {/* biome-ignore lint/performance/noImgElement: rendered pdf page, not a static asset */}
              <img
                alt={`Page ${citedPage}`}
                className="max-h-72 w-full object-contain object-top"
                loading="lazy"
                src={pdfPageImageUrl(pdfName, citedPage)}
              />
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Passed to the answer's <MessageResponse components={...}> so links render as citations.
export const CITATION_COMPONENTS = { a: CitationAnchor };
