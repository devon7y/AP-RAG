"use client";

import useSWR from "swr";
import { cn, fetcher } from "@/lib/utils";

// Header title — "AP-RAG — Academic Paper Retrieval-Augmented Generation" with each
// acronym letter bold. The expansion collapses on small screens.
export function AppTitle() {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 font-semibold text-sm tracking-tight">
        AP-RAG
      </span>
      <span className="hidden truncate font-light text-foreground/75 text-sm md:inline">
        <span className="text-foreground/45">— </span>
        <b className="font-semibold text-foreground">A</b>cademic{" "}
        <b className="font-semibold text-foreground">P</b>aper{" "}
        <b className="font-semibold text-foreground">R</b>etrieval-
        <b className="font-semibold text-foreground">A</b>ugmented{" "}
        <b className="font-semibold text-foreground">G</b>eneration
      </span>
      <PaperCount />
      <BackendStatus />
    </div>
  );
}

// Live backend (query server) status — green dot when reachable, red when not. Polls so
// it reflects the PC backend going up/down.
export function BackendStatus() {
  const { data } = useSWR<{ online: boolean }>(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/health`,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true }
  );
  const online = data?.online;
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-foreground/75 text-xs">
      Status: {online == null ? "…" : online ? "Online" : "Offline"}
      <span
        className={cn(
          "size-2 rounded-full",
          online == null && "bg-muted-foreground",
          online === true && "bg-green-500",
          online === false && "bg-red-500"
        )}
      />
    </span>
  );
}

// Live count of papers ingested into the database (fetched from /api/stats → query
// server /stats). Shows a placeholder until loaded; hidden if the count is unavailable.
export function PaperCount() {
  const { data } = useSWR<{ papers: number }>(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/stats`,
    fetcher,
    { revalidateOnFocus: false }
  );
  const papers = data?.papers;
  if (papers != null && papers <= 0) {
    return null;
  }
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-2.5 py-1 font-medium text-foreground/75 text-xs tabular-nums">
      {papers == null ? "…" : papers.toLocaleString()} papers
    </span>
  );
}
