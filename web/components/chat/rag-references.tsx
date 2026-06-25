"use client";

import { ExternalLinkIcon, FileTextIcon } from "lucide-react";
import { formatPages } from "@/lib/aprag/citations";
import type { RagReference } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { MessageResponse } from "../ai-elements/message";

// The "References" list shown beneath a synthesized answer (and as the source list for
// chunk mode). Each entry is the server-formatted APA7 citation, the PDF page(s) the
// cited passages came from, and a Google Drive "open PDF" link when available.
export function RagReferences({
  references,
  className,
}: {
  references: RagReference[];
  className?: string;
}) {
  if (references.length === 0) {
    return null;
  }
  return (
    <section className={cn("mt-3 border-border/60 border-t pt-3", className)}>
      <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        References
      </h3>
      <ol className="space-y-2">
        {references.map((ref, i) => {
          const pages = formatPages(ref.pages);
          return (
            <li
              className="flex gap-2 text-[13px] leading-snug"
              id={`ref-${ref.reference_id}`}
              key={`${ref.reference_id}-${ref.filename}`}
            >
              <span className="mt-px shrink-0 text-muted-foreground tabular-nums">
                [{i + 1}]
              </span>
              <div className="min-w-0 flex-1">
                <div className="[&_p]:m-0 [&_p]:inline">
                  <MessageResponse>{ref.apa || ref.filename}</MessageResponse>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
                  {pages && <span>{pages}</span>}
                  {ref.drive_url ? (
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={ref.drive_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLinkIcon className="size-3" />
                      Open in Drive
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <FileTextIcon className="size-3" />
                      {ref.filename}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
