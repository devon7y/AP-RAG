"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { RagChunk, RagReference } from "@/lib/aprag/types";
import { promotePdf } from "@/lib/pdf/loader";
import { usePdfViewer } from "@/lib/pdf/store";
import { splitChunkContent } from "./rag-chunks";

// In-text citations. Clicking one opens the cited paper in the reader beside the chat,
// scrolled to the passage with it highlighted — the PDF *is* the preview, so there is
// no hover card. Hovering still warms the document in the background so the click has
// nothing to wait for.

type CitationData = {
  chunkByCiteIndex: Map<number, RagChunk>;
  refByReferenceId: Map<string, RagReference>;
};

export const CitationContext = createContext<CitationData | null>(null);

export function CitationAnchor({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const ctx = useContext(CitationContext);
  const openPdf = usePdfViewer((s) => s.openPdf);

  if (!href?.startsWith("#cite-") || !ctx) {
    return href ? (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <>{children}</>
    );
  }

  // A citation can cover several passages of the same paper; the first is the anchor.
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

  const chunk = chunks[0];
  const reference = ctx.refByReferenceId.get(chunk.reference_id ?? "");
  const filename = reference?.filename ?? "";
  const page = chunk.page ?? reference?.pages?.[0] ?? 1;
  const passage = splitChunkContent(chunk.content).text;

  if (!filename) {
    return <span className="whitespace-nowrap">{children}</span>;
  }

  const warm = () => promotePdf(filename, page);

  return (
    <button
      className="cursor-pointer whitespace-nowrap rounded-sm font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80"
      onClick={() =>
        openPdf({
          filename,
          page,
          quote: passage,
          label: reference?.intext || filename,
          driveUrl: reference?.drive_url,
        })
      }
      onFocus={warm}
      onMouseEnter={warm}
      title="Open this passage in the PDF"
      type="button"
    >
      {children}
    </button>
  );
}

// Passed to the answer's <MessageResponse components={...}> so links render as citations.
export const CITATION_COMPONENTS = { a: CitationAnchor };
