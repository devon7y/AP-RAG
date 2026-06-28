"use client";

import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import type { RagChunk, RagReference } from "@/lib/aprag/types";
import { MessageResponse } from "../ai-elements/message";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { cleanChunkText } from "./rag-chunks";

type CitationData = {
  chunkByCiteIndex: Map<number, RagChunk>;
  refByReferenceId: Map<string, RagReference>;
};

export const CitationContext = createContext<CitationData | null>(null);

// Custom markdown <a> renderer: a `#cite-3_5` href (from rewriteIntext) becomes a
// hover/click card revealing the exact retrieved passage(s) the model cited. Multiple
// passages are paged through with arrows. Any other link renders normally.
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
    return <span>{children}</span>;
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
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openNow = () => {
    cancelClose();
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
      setOpen(false);
    } else {
      pinned.current = true;
      cancelClose();
      setOpen(true);
    }
  };

  const n = chunks.length;
  const chunk = chunks[Math.min(idx, n - 1)];
  const reference = refByReferenceId.get(chunk.reference_id ?? "");
  const label = reference?.apa || reference?.filename || chunk.file_path;
  const score = typeof chunk.score === "number" ? chunk.score.toFixed(3) : null;

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
          className="cursor-pointer rounded-sm font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80"
          onClick={togglePin}
          onMouseEnter={openNow}
          onMouseLeave={scheduleClose}
          type="button"
        >
          {children}
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[min(94vw,46rem)] overflow-hidden p-0"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
        side="top"
        sideOffset={6}
      >
        <div className="flex items-center justify-between gap-2 border-border/60 border-b bg-muted/40 px-3 py-1.5">
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
        <div className="px-3.5 py-3">
          <div className="mb-1.5 flex items-start justify-between gap-3 text-[13px]">
            <div className="min-w-0 font-medium [&_p]:m-0 [&_p]:inline">
              <MessageResponse>{label}</MessageResponse>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
              {chunk.page != null && <span>p. {chunk.page}</span>}
              {score && <span className="tabular-nums">{score}</span>}
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
            </div>
          </div>
          <p className="whitespace-pre-wrap text-[13px] text-foreground/90 leading-[1.6]">
            {cleanChunkText(chunk.content)}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Passed to the answer's <MessageResponse components={...}> so links render as citations.
export const CITATION_COMPONENTS = { a: CitationAnchor };
