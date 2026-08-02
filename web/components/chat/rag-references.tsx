"use client";

import {
  CalendarIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { formatPages } from "@/lib/aprag/citations";
import type { RagReference } from "@/lib/aprag/types";
import { promotePdf } from "@/lib/pdf/loader";
import { usePdfViewer } from "@/lib/pdf/store";
import { cn } from "@/lib/utils";
import { MessageResponse } from "../ai-elements/message";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "2024-03-17" → "17 Mar 2024"; "2024-03" → "Mar 2024"; "2024" → "2024".
export function formatRefDate(date?: string): string {
  if (!date) {
    return "";
  }
  const [y, m, d] = date.split("-");
  const mon = m ? MONTHS_SHORT[Number(m) - 1] : "";
  if (d) {
    return `${Number(d)} ${mon} ${y}`;
  }
  if (mon) {
    return `${mon} ${y}`;
  }
  return y;
}

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
  const openPdf = usePdfViewer((s) => s.openPdf);
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
          const refDate = formatRefDate(ref.date);
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
                  {refDate && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarIcon className="size-3" />
                      {refDate}
                    </span>
                  )}
                  {pages && <span>{pages}</span>}
                  {ref.filename && (
                    <button
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      onClick={() =>
                        openPdf({
                          filename: ref.filename,
                          page: ref.pages?.[0] ?? 1,
                          label: ref.intext || ref.filename,
                          driveUrl: ref.drive_url,
                        })
                      }
                      onFocus={() => promotePdf(ref.filename, ref.pages?.[0] ?? 1)}
                      onMouseEnter={() =>
                        promotePdf(ref.filename, ref.pages?.[0] ?? 1)
                      }
                      type="button"
                    >
                      <FileTextIcon className="size-3" />
                      Open PDF
                    </button>
                  )}
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
                      {ref.filename}
                    </span>
                  )}
                  {ref.filename && (
                    <Link
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={`/papers?similar=${encodeURIComponent(ref.filename)}`}
                      title="Papers most similar to this one"
                    >
                      <SparklesIcon className="size-3" />
                      Similar
                    </Link>
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
