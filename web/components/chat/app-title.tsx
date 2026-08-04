"use client";

import useSWR from "swr";
import { cn, fetcher } from "@/lib/utils";

// Header title — "AP-RAG — Academic Paper Retrieval-Augmented Generation" with each
// acronym letter bold. The expansion collapses on small screens. `showBackend` hides the
// paper-count + status badges (author chats drop them to make room for the persona label).
export function AppTitle({
  showBackend = true,
  showExpansion = true,
}: {
  showBackend?: boolean;
  /** The acronym's expansion is decoration; it goes first when width is scarce
   *  (the PDF reader takes half the header). */
  showExpansion?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 font-semibold text-sm tracking-tight">
        AP-RAG
      </span>
      <span
        className={cn(
          "truncate font-light text-foreground/75 text-sm",
          showExpansion ? "hidden md:inline" : "hidden"
        )}
      >
        <span className="text-foreground/45">— </span>
        <b className="font-semibold text-foreground">A</b>cademic{" "}
        <b className="font-semibold text-foreground">P</b>aper{" "}
        <b className="font-semibold text-foreground">R</b>etrieval-
        <b className="font-semibold text-foreground">A</b>ugmented{" "}
        <b className="font-semibold text-foreground">G</b>eneration
      </span>
      {showBackend && (
        <>
          <PaperCount />
          <BackendStatus />
        </>
      )}
    </div>
  );
}

// Live backend status — green when retrieval is actually ready (query server + Qdrant +
// embedding all up), red when not, with the reason shown inline + on hover. Polls so it
// reflects the PC backend going up/down.
export function BackendStatus() {
  const { data } = useSWR<{ online: boolean; detail?: string }>(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/health`,
    fetcher,
    { refreshInterval: 20_000, revalidateOnFocus: true }
  );
  const online = data?.online;
  const label = online == null ? "Checking…" : online ? "Online" : "Offline";
  const detail = online === false ? (data?.detail ?? "backend offline") : undefined;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-foreground/75 text-xs"
      title={
        online === false
          ? `Backend offline: ${detail}`
          : online
            ? "Backend online — retrieval ready"
            : "Checking backend…"
      }
    >
      Status: {label}
      {detail && <span className="text-red-500/90">({detail})</span>}
      <span
        className={cn(
          "size-2 rounded-full",
          online == null && "animate-pulse bg-muted-foreground",
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
