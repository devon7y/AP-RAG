"use client";

import { CopyIcon, ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import useSWR from "swr";
import type { PaperDetail } from "@/lib/aprag/types";
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
  displayTitle,
  fullAuthorList,
  type ListFilterKey,
  paperFetcher,
  volIssuePages,
} from "./lib";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Full-record drawer for one paper: APA reference, abstract, provenance, links, and a
// jump into a chat scoped to this paper.
export function PaperDrawer({
  filename,
  onClose,
  onAddFilter,
}: {
  filename: string | null;
  onClose: () => void;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
}) {
  const router = useRouter();
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
    // `?query=` is auto-sent as the first message of a fresh chat (use-active-chat), so
    // this opens a conversation already anchored on the paper.
    const prompt = data.title.trim()
      ? `Tell me about the paper "${title}" (${data.intext}). What are its main questions, methods, and findings?`
      : `Tell me about the paper ${filename}. What are its main questions, methods, and findings?`;
    router.push(`/chat/${generateUUID()}?query=${encodeURIComponent(prompt)}`);
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
          <SheetDescription>
            {data ? fullAuthorList(data.authors) : ""}
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
            <Button className="w-full" onClick={askAboutPaper} type="button">
              <MessageSquareIcon className="size-4" />
              Ask about this paper
            </Button>

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
            className="cursor-pointer font-normal transition-colors hover:bg-accent hover:text-accent-foreground"
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
