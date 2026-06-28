"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { RagChunk, RagReference } from "@/lib/aprag/types";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../ui/hover-card";
import { ChunkCard } from "./rag-chunks";

type CitationData = {
  chunkByCiteIndex: Map<number, RagChunk>;
  refByReferenceId: Map<string, RagReference>;
};

export const CitationContext = createContext<CitationData | null>(null);

// Custom markdown <a> renderer: a `#cite-3_5` href (from rewriteIntext) becomes a hover/
// tap card revealing the exact retrieved passage(s) the model cited — in the same card
// format as Chunks mode. Any other link renders normally.
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
    <HoverCard closeDelay={80} openDelay={120}>
      <HoverCardTrigger asChild>
        <button
          className="cursor-help rounded-sm font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80"
          type="button"
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="max-h-[26rem] w-[min(92vw,34rem)] overflow-y-auto p-2.5"
        side="top"
      >
        <p className="mb-2 px-1 text-muted-foreground text-xs">
          Cited passage{chunks.length > 1 ? "s" : ""} ({chunks.length}) — the retrieved
          text this citation draws on
        </p>
        <div className="flex flex-col gap-2">
          {chunks.map((c, i) => (
            <ChunkCard
              chunk={c}
              index={i + 1}
              key={c.chunk_id || i}
              reference={ctx.refByReferenceId.get(c.reference_id ?? "")}
            />
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// Passed to the answer's <MessageResponse components={...}> so links render as citations.
export const CITATION_COMPONENTS = { a: CitationAnchor };
