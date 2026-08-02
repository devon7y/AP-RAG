"use client";

import {
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MessageSquareIcon,
  SparklesIcon,
  WaypointsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import useSWR from "swr";
import type { GraphEntitySummary } from "@/lib/aprag/client";
import type { PaperDetail, RankedPaper } from "@/lib/aprag/types";
import { promotePdf } from "@/lib/pdf/loader";
import { usePdfViewer } from "@/lib/pdf/store";
import { generateUUID } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import {
  compactAuthors,
  displayTitle,
  type ListFilterKey,
  paperFetcher,
  volIssuePages,
} from "./lib";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Full-record drawer for one paper: APA reference, abstract, provenance, links, related
// papers, and a jump into a chat scoped (pinned) to this paper.
export function PaperDrawer({
  filename,
  onClose,
  onAddFilter,
  onOpenPaper,
}: {
  filename: string | null;
  onClose: () => void;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
  // Swap the drawer to another paper (clicking a related paper). Optional — without it,
  // related papers link out to the Papers Database instead.
  onOpenPaper?: (filename: string) => void;
}) {
  const router = useRouter();
  const openPdf = usePdfViewer((s) => s.openPdf);
  const { data, error, isLoading } = useSWR<PaperDetail>(
    filename
      ? `${BASE}/api/papers?filename=${encodeURIComponent(filename)}`
      : null,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  const copyApa = async () => {
    if (!data?.apa) {
      return;
    }
    await navigator.clipboard.writeText(data.apa);
    toast.success("APA reference copied");
  };

  const askAboutPaper = () => {
    if (!data) {
      return;
    }
    const title = displayTitle(data);
    // `?papers=` pins this paper as a filter (retrieval stays scoped to it) and
    // `?query=` auto-sends the first message — the chat opens anchored on the paper.
    const prompt = data.title.trim()
      ? `Tell me about the paper "${title}" (${data.intext}). What are its main questions, methods, and findings?`
      : `Tell me about the paper ${filename}. What are its main questions, methods, and findings?`;
    router.push(
      `/chat/${generateUUID()}?papers=${encodeURIComponent(data.filename)}&query=${encodeURIComponent(prompt)}`
    );
  };

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={filename != null}>
      <SheetContent
        className="w-full gap-0 overflow-y-auto sm:max-w-xl"
        side="right"
      >
        <SheetHeader>
          <SheetTitle className="pr-6 leading-snug">
            {data ? displayTitle(data) : filename}
          </SheetTitle>
          <SheetDescription asChild>
            <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
              {(data?.authors ?? []).map((a, i, arr) => {
                const name = [a.given, a.family].filter(Boolean).join(" ");
                if (!name) {
                  return null;
                }
                return (
                  <span key={`${name}-${i}`}>
                    {a.family ? (
                      <Link
                        className="hover:text-foreground hover:underline"
                        href={`/authors/${encodeURIComponent(a.family)}`}
                        title={`${a.family}'s author page`}
                      >
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                    {i < arr.length - 1 ? "," : ""}
                  </span>
                );
              })}
            </span>
          </SheetDescription>
        </SheetHeader>

        {isLoading && (
          <div className="space-y-3 px-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {error && (
          <p className="px-4 text-muted-foreground text-sm">
            Couldn't load this paper's record.
          </p>
        )}

        {data && (
          <div className="space-y-4 px-4 pb-6">
            <div className="flex gap-2">
              <Button className="flex-1" onClick={askAboutPaper} type="button">
                <MessageSquareIcon className="size-4" />
                Ask about this paper
              </Button>
              <Button
                onClick={() =>
                  openPdf({
                    filename: data.filename,
                    page: 1,
                    label: data.intext || displayTitle(data),
                    driveUrl: data.drive_url,
                  })
                }
                onMouseEnter={() => promotePdf(data.filename, 1)}
                type="button"
                variant="outline"
              >
                <FileTextIcon className="size-4" />
                Read PDF
              </Button>
            </div>

            <section className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[13px] leading-relaxed">{data.apa}</p>
                <Button
                  aria-label="Copy APA reference"
                  className="shrink-0"
                  onClick={copyApa}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            </section>

            <section className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <Meta label="Year" value={data.year} />
              <Meta
                label="Published"
                value={
                  data.date
                    ? `${data.date}${data.date_source ? ` (${data.date_source})` : ""}`
                    : ""
                }
              />
              <Meta label="Journal" value={data.container_title} />
              <Meta label="Vol(Iss), pp" value={volIssuePages(data)} />
              <Meta label="Type" value={data.type} />
              <Meta label="Publisher" value={data.publisher} />
              <Meta label="Filename" value={data.filename} />
              <Meta label="Metadata" value={data.source} />
              {data.year_flag && (
                <Meta label="Year flag" value={data.year_flag} />
              )}
              {data.date_flag && (
                <Meta label="Date flag" value={data.date_flag} />
              )}
            </section>

            {(data.doi || data.drive_url) && (
              <section className="flex flex-wrap gap-2">
                {data.doi && (
                  <Button asChild size="sm" type="button" variant="outline">
                    <a
                      href={`https://doi.org/${data.doi}`}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      DOI
                    </a>
                  </Button>
                )}
                {data.drive_url && (
                  <Button asChild size="sm" type="button" variant="outline">
                    <a
                      href={data.drive_url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      Open PDF in Drive
                    </a>
                  </Button>
                )}
              </section>
            )}

            {data.abstract && (
              <section>
                <h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Abstract
                </h3>
                <p className="text-[13px] leading-relaxed">{data.abstract}</p>
              </section>
            )}

            <RelatedPapers filename={data.filename} onOpenPaper={onOpenPaper} />

            <GraphEntities filename={data.filename} />

            <TermChips
              dim="keywords"
              label="Keywords"
              onAddFilter={onAddFilter}
              values={data.keywords}
            />
            <TermChips
              dim="subjects"
              label="Subjects"
              onAddFilter={onAddFilter}
              values={data.subjects}
            />
            <TermChips
              dim="affiliations"
              label="Affiliations"
              onAddFilter={onAddFilter}
              values={data.affiliations ?? []}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// "More like this": the corpus ranked against this paper's chunk centroid. Clicking a
// related paper swaps the drawer to it (when the host page can); "See all" opens the
// full ranked list in the Papers Database.
function RelatedPapers({
  filename,
  onOpenPaper,
}: {
  filename: string;
  onOpenPaper?: (filename: string) => void;
}) {
  const { data, error, isLoading } = useSWR<{ papers: RankedPaper[] }>(
    `${BASE}/api/papers/similar?filename=${encodeURIComponent(filename)}&top_k=6`,
    paperFetcher,
    { revalidateOnFocus: false }
  );
  const papers = data?.papers ?? [];

  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        <SparklesIcon className="size-3" />
        Related papers
      </h3>
      {isLoading && (
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {error && (
        <p className="text-muted-foreground text-xs">
          Related papers unavailable right now.
        </p>
      )}
      {!(isLoading || error) && papers.length === 0 && (
        <p className="text-muted-foreground text-xs">
          No related papers found.
        </p>
      )}
      {papers.length > 0 && (
        <ul className="space-y-1.5">
          {papers.map((p) => {
            const meta = [compactAuthors(p.authors), p.year, p.container_title]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={p.filename}>
                <button
                  className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  onClick={() => onOpenPaper?.(p.filename)}
                  type="button"
                >
                  <span className="line-clamp-2 text-[13px] leading-snug">
                    {displayTitle(p)}
                  </span>
                  {meta && (
                    <span className="mt-0.5 block text-muted-foreground text-xs">
                      {meta}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {papers.length > 0 && (
        <Link
          className="mt-1.5 inline-block px-2 text-primary text-xs hover:underline"
          href={`/papers?similar=${encodeURIComponent(filename)}`}
        >
          See all similar papers →
        </Link>
      )}
    </section>
  );
}

// "In the knowledge graph": the entities the ingest model extracted from this paper,
// linking into the Knowledge Graph explorer. Supplementary — hidden entirely when the
// graph is unavailable or the paper has no extracted entities.
function GraphEntities({ filename }: { filename: string }) {
  const { data, error } = useSWR<{ entities: GraphEntitySummary[] }>(
    `${BASE}/api/graph/entities?file=${encodeURIComponent(filename)}&limit=12`,
    paperFetcher,
    { revalidateOnFocus: false }
  );
  const entities = data?.entities ?? [];
  if (error || entities.length === 0) {
    return null;
  }
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        <WaypointsIcon className="size-3" />
        In the knowledge graph
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {entities.map((e) => (
          <Badge
            asChild
            className="cursor-pointer font-normal transition-colors hover:border-muted-foreground/50 hover:bg-muted-foreground/30"
            key={e.name}
            variant="outline"
          >
            <Link
              href={`/graph/entity?name=${encodeURIComponent(e.name)}`}
              title={`${e.type} · ${e.degree} connections`}
            >
              {e.name}
            </Link>
          </Badge>
        ))}
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  if (!value) {
    return null;
  }
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </>
  );
}

function TermChips({
  label,
  values,
  dim,
  onAddFilter,
}: {
  label: string;
  values: string[];
  dim: ListFilterKey;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <section>
      <h3 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Badge
            asChild
            className="cursor-pointer font-normal transition-colors hover:border-muted-foreground/50 hover:bg-muted-foreground/30"
            key={v}
            variant="outline"
          >
            <button
              onClick={() => onAddFilter(dim, v)}
              title={`Filter the table by ${v}`}
              type="button"
            >
              {v}
            </button>
          </Badge>
        ))}
      </div>
    </section>
  );
}
