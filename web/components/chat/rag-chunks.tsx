"use client";

import { ExternalLinkIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import type {
  RagChunk,
  RagEntity,
  RagReference,
  RagRelationship,
  RagRetrieval,
} from "@/lib/aprag/types";
import { promotePdf } from "@/lib/pdf/loader";
import { usePdfViewer } from "@/lib/pdf/store";
import { MessageResponse } from "../ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

// Entity names link into the Knowledge Graph explorer (entity card by name).
function EntityLink({ name }: { name: string }) {
  return (
    <Link
      className="font-medium hover:text-primary hover:underline"
      href={`/graph/entity?name=${encodeURIComponent(name)}`}
      title={`Open "${name}" in the Knowledge Graph`}
    >
      {name}
    </Link>
  );
}

// PDF text extraction sometimes leaves a newline after every word/line; collapse all
// whitespace to single spaces so chunks read as flowing text instead of one word per line.
export function cleanChunkText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Contextual retrieval stores each chunk as "<situating context>\n\n<original passage>".
// Split the situating context (a short LLM-written header) from the actual paper text.
export function splitChunkContent(content: string): {
  context: string | null;
  text: string;
} {
  const raw = content || "";
  const i = raw.indexOf("\n\n");
  // The context blurb is short; if the first segment is long, it's all passage text.
  if (i > 0 && i < 600) {
    return {
      context: cleanChunkText(raw.slice(0, i)),
      text: cleanChunkText(raw.slice(i + 2)),
    };
  }
  return { context: null, text: cleanChunkText(raw) };
}

// Raw-chunk view (the web version of `aprag chunks`): the retrieved passages as cards,
// each headed by its APA citation + PDF page + relevance, with a Drive link when known.
export function RagChunks({ retrieval }: { retrieval: RagRetrieval }) {
  const { chunks, references, entities, relationships } = retrieval;
  const refById = new Map<string, RagReference>(
    references.map((r) => [r.reference_id, r])
  );

  if (chunks.length === 0) {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 text-muted-foreground text-sm">
        No chunks retrieved for this query.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-xs">
        {chunks.length} chunk{chunks.length === 1 ? "" : "s"} · mode{" "}
        <span className="font-medium">{retrieval.mode}</span>
      </div>
      {chunks.map((chunk, i) => (
        <ChunkCard
          chunk={chunk}
          index={i + 1}
          key={chunk.chunk_id || i}
          reference={refById.get(chunk.reference_id ?? "")}
        />
      ))}
      <GraphSection entities={entities} relationships={relationships} />
    </div>
  );
}

export function ChunkCard({
  chunk,
  index,
  reference,
}: {
  chunk: RagChunk;
  index: number;
  reference?: RagReference;
}) {
  const openPdf = usePdfViewer((s) => s.openPdf);
  const label = reference?.apa || reference?.filename || chunk.file_path;
  const score = typeof chunk.score === "number" ? chunk.score.toFixed(3) : null;
  const pdfName = reference?.filename ?? "";
  const citedPage = chunk.page ?? reference?.pages?.[0] ?? 1;
  return (
    <article className="rounded-xl border border-border/60 bg-card/40 px-3.5 py-3">
      <header className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0 font-medium text-[13px] [&_p]:m-0 [&_p]:inline">
          <span className="mr-1.5 text-muted-foreground tabular-nums">
            {index}.
          </span>
          <MessageResponse>{label}</MessageResponse>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
          {reference?.uploaded && (
            <span
              className="rounded border border-border/60 px-1 py-px text-[10px] uppercase tracking-wide"
              title="Uploaded to this chat — not in the database"
            >
              Uploaded
            </span>
          )}
          {chunk.page != null && <span>p. {chunk.page}</span>}
          {score && <span className="tabular-nums">{score}</span>}
          {pdfName && (
            <button
              className="inline-flex items-center gap-1 text-primary hover:underline"
              onClick={() =>
                openPdf({
                  filename: pdfName,
                  page: citedPage,
                  quote: splitChunkContent(chunk.content).text,
                  label: reference?.intext || pdfName,
                  driveUrl: reference?.drive_url,
                })
              }
              onMouseEnter={() => promotePdf(pdfName, citedPage)}
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
        </div>
      </header>
      <p className="text-[13px] text-foreground/90 leading-[1.6]">
        {cleanChunkText(chunk.content)}
      </p>
    </article>
  );
}

function GraphSection({
  entities,
  relationships,
}: {
  entities: RagEntity[];
  relationships: RagRelationship[];
}) {
  if (entities.length === 0 && relationships.length === 0) {
    return null;
  }
  return (
    <Collapsible className="rounded-xl border border-border/60 bg-muted/20">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3.5 py-2 text-left text-muted-foreground text-xs hover:text-foreground">
        <span>
          Knowledge graph · {entities.length} entit
          {entities.length === 1 ? "y" : "ies"}, {relationships.length}{" "}
          relationship
          {relationships.length === 1 ? "" : "s"}
        </span>
        <span aria-hidden>▾</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-3.5 pb-3 text-[13px]">
        {entities.length > 0 && (
          <ul className="space-y-1">
            {entities.map((e) => (
              <li key={`${e.entity_name}-${e.entity_type}`}>
                <EntityLink name={e.entity_name} />{" "}
                <span className="text-muted-foreground">[{e.entity_type}]</span>
                {e.description ? `: ${e.description}` : ""}
              </li>
            ))}
          </ul>
        )}
        {relationships.length > 0 && (
          <ul className="space-y-1 border-border/50 border-t pt-2">
            {relationships.map((r) => (
              <li key={`${r.src_id}-${r.tgt_id}`}>
                <span className="font-medium">
                  <EntityLink name={r.src_id} /> →{" "}
                  <EntityLink name={r.tgt_id} />
                </span>
                {r.description ? `: ${r.description}` : ""}
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
