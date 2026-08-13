"use client";

import { ChevronLeftIcon, ChevronRightIcon, DatabaseIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { useLocalStorage } from "usehooks-ts";
import { PageShell } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import type { GraphFileEntity } from "@/lib/aprag/client";
import type {
  PaperListResponse,
  PaperRow,
  RankedPaper,
} from "@/lib/aprag/types";
import { usePdfViewer } from "@/lib/pdf/store";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { downloadFile, fetchAllRows, rowsToBibtex, rowsToCsv } from "./export";
import {
  apiListQueryString,
  displayTitle,
  type ListFilterKey,
  type PapersQuery,
  PER_CHOICES,
  paperFetcher,
  papersQueryString,
  parsePapersQuery,
  postJson,
  toggleListFilter,
  toggleYearFilter,
} from "./lib";
import {
  type ColumnId,
  defaultColumnVisibility,
  PapersTable,
} from "./papers-table";
import { PapersToolbar } from "./papers-toolbar";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type DeepResult = { papers: RankedPaper[]; matched_files: number | null };

// The Papers Database page: a server-driven table over the papers manifest with a
// two-tier universal search. All view state (search, filters, sort, page) lives in the
// URL, so any view is shareable and the back button walks through view changes.
export function PapersBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = useMemo(() => parsePapersQuery(searchParams), [searchParams]);
  const openPdf = usePdfViewer((s) => s.openPdf);

  // View changes push a history entry, so the browser's back/forward arrows step back
  // through filters, sorts, and pages rather than leaving the Papers Database. The one
  // exception is the debounced search box, which replaces (a history entry per typed
  // word would make Back useless).
  const navigate = useCallback(
    (next: PapersQuery, opts?: { replace?: boolean }) => {
      const qs = papersQueryString(next);
      const href = `${BASE}/papers${qs ? `?${qs}` : ""}`;
      if (opts?.replace) {
        router.replace(href, { scroll: false });
      } else {
        router.push(href, { scroll: false });
      }
    },
    [router]
  );
  // Any change other than explicit paging returns to the first page.
  const update = (patch: Partial<PapersQuery>, opts?: { replace?: boolean }) =>
    navigate({ ...query, page: 0, ...patch }, opts);

  // Browse tier: server-paginated listing.
  const browseKey =
    query.deep || query.similar
      ? null
      : `${BASE}/api/papers?${apiListQueryString(query)}`;
  const {
    data: list,
    error: listError,
    isLoading: listLoading,
  } = useSWR<PaperListResponse>(browseKey, paperFetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  // Deep tier: semantic search over the papers' text, folded into ranked papers.
  const deepKey = query.deep
    ? [
        `${BASE}/api/papers/search`,
        query.deep,
        JSON.stringify(query.filters ?? {}),
      ]
    : null;
  const {
    data: deep,
    error: deepError,
    isLoading: deepLoading,
  } = useSWR<DeepResult>(
    deepKey,
    ([url, question]: [string, string]) =>
      postJson<DeepResult>(url, { question, filters: query.filters }),
    { keepPreviousData: true, revalidateOnFocus: false }
  );

  // Similar tier: papers ranked against one paper's chunk centroid ("more like this").
  const similarKey = query.similar
    ? `${BASE}/api/papers/similar?filename=${encodeURIComponent(query.similar)}&top_k=40`
    : null;
  const {
    data: similar,
    error: similarError,
    isLoading: similarLoading,
  } = useSWR<{ papers: RankedPaper[] }>(similarKey, paperFetcher, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  const [storedColumns, setStoredColumns] = useLocalStorage<
    Partial<Record<ColumnId, boolean>>
  >("aprag:papers:columns", {});
  const visible = useMemo(
    () => ({ ...defaultColumnVisibility(), ...storedColumns }),
    [storedColumns]
  );
  // User-dragged column widths (px), persisted; unset columns use their defaults.
  const [colWidths, setColWidths] = useLocalStorage<
    Partial<Record<ColumnId, number>>
  >("aprag:papers:colwidths", {});

  const [exporting, setExporting] = useState(false);

  const onSort = (key: string) => {
    if (query.sort === key) {
      update({ order: query.order === "asc" ? "desc" : "asc" });
      return;
    }
    // Fresh sort dimension: numbers/dates read best newest-first, text A→Z.
    const numeric = key === "year" || key === "date";
    update({ sort: key, order: numeric ? "desc" : "asc" });
  };

  // Clicking a chip (author, keyword, subject, affiliation) toggles that filter.
  const onToggleFilter = (dim: ListFilterKey, value: string) =>
    update({ filters: toggleListFilter(query.filters, dim, value) });

  const onToggleYear = (year: number) =>
    update({ filters: toggleYearFilter(query.filters, year) });

  // The row itself is the "open the paper" affordance: every field the old detail
  // drawer showed now lives in a column, so a click goes straight to the PDF reader
  // (which splits the page beside the table rather than covering it).
  const onOpenPaper = (row: PaperRow) =>
    openPdf({
      filename: row.filename,
      page: 1,
      label: row.intext || displayTitle(row),
      driveUrl: row.drive_url,
    });

  const onExport = async (format: "csv" | "bibtex") => {
    setExporting(true);
    try {
      const rows: PaperRow[] = query.deep
        ? (deep?.papers ?? [])
        : query.similar
          ? (similar?.papers ?? [])
          : await fetchAllRows(query);
      if (rows.length === 0) {
        toast.error("Nothing to export");
        return;
      }
      if (format === "csv") {
        downloadFile("aprag-papers.csv", rowsToCsv(rows), "text/csv");
      } else {
        downloadFile(
          "aprag-papers.bib",
          rowsToBibtex(rows),
          "application/x-bibtex"
        );
      }
      toast.success(
        `Exported ${rows.length} paper${rows.length === 1 ? "" : "s"}`
      );
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const deepMode = Boolean(query.deep);
  const similarMode = Boolean(query.similar);
  const rankedMode = deepMode || similarMode; // score-ordered result sets (no pagination)
  const rows: (PaperRow | RankedPaper)[] = deepMode
    ? (deep?.papers ?? [])
    : similarMode
      ? (similar?.papers ?? [])
      : (list?.papers ?? []);
  const total = list?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / query.per));
  const error = deepMode ? deepError : similarMode ? similarError : listError;
  const isLoading = deepMode
    ? deepLoading
    : similarMode
      ? similarLoading
      : listLoading;

  // Knowledge-graph column: one batched lookup for the page's papers, fired only when
  // the column is on (each paper's entities cost a graph scan; the server caches them).
  const graphFiles = visible.graph ? rows.map((r) => r.filename) : [];
  const { data: graph } = useSWR<{
    entities: Record<string, GraphFileEntity[]>;
  }>(
    graphFiles.length > 0
      ? [`${BASE}/api/graph/entities-by-file`, graphFiles.join("|")]
      : null,
    ([url]: [string, string]) =>
      postJson<{ entities: Record<string, GraphFileEntity[]> }>(url, {
        files: graphFiles,
        limit: 8,
      }),
    { keepPreviousData: false, revalidateOnFocus: false }
  );

  return (
    <PageShell
      header={
        <>
          <SidebarToggle />
          <DatabaseIcon className="size-4 text-muted-foreground" />
          <h1 className="font-semibold text-sm">Papers Database</h1>
          {!deepMode && total > 0 && (
            <span className="text-muted-foreground text-xs">
              {total.toLocaleString()} papers
            </span>
          )}
        </>
      }
    >
      <PapersToolbar
        deep={query.deep}
        deepLoading={deepLoading}
        exporting={exporting}
        filters={query.filters}
        onClearSimilar={() => update({ similar: "" })}
        onDeepSearch={(deepQuery) =>
          update(
            deepQuery
              ? { deep: deepQuery, q: "", similar: "" }
              : { deep: "", q: "" }
          )
        }
        onExport={onExport}
        onFiltersChange={(filters) => update({ filters })}
        onQChange={(q) => update({ q }, { replace: true })}
        onToggleColumn={(id) =>
          setStoredColumns((prev) => ({ ...prev, [id]: !visible[id] }))
        }
        q={query.q}
        similar={query.similar}
        visible={visible}
      />

      {error && (
        <div className="border-border/60 border-b bg-destructive/10 px-4 py-2 text-destructive text-sm">
          Papers database unreachable — the backend may be offline. Retry in a
          moment.
        </div>
      )}

      <PapersTable
        deepMode={rankedMode}
        filters={query.filters}
        graphEntities={graph?.entities}
        isLoading={isLoading}
        onOpen={onOpenPaper}
        onResizeColumn={(id, px) =>
          setColWidths((prev) => ({ ...prev, [id]: px }))
        }
        onShowSimilar={(filename) =>
          update({ similar: filename, deep: "", q: "" })
        }
        onSort={onSort}
        onToggleFilter={onToggleFilter}
        onToggleYear={onToggleYear}
        order={query.order}
        rows={rows}
        sort={query.sort}
        visible={visible}
        widths={colWidths}
      />

      <footer className="flex flex-wrap items-center justify-between gap-2 border-border/60 border-t px-3 py-2 md:px-4">
        {rankedMode ? (
          <span className="text-muted-foreground text-xs">
            {isLoading
              ? "Searching the corpus…"
              : similarMode
                ? `${rows.length} paper${rows.length === 1 ? "" : "s"} ranked by similarity to ${query.similar.replace(/\.pdf$/i, "")}`
                : `${rows.length} paper${rows.length === 1 ? "" : "s"} ranked by relevance`}
            {deepMode &&
              deep?.matched_files != null &&
              ` · within ${deep.matched_files.toLocaleString()} filtered paper${deep.matched_files === 1 ? "" : "s"}`}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            {total > 0
              ? `${(query.page * query.per + 1).toLocaleString()}–${Math.min(
                  (query.page + 1) * query.per,
                  total
                ).toLocaleString()} of ${total.toLocaleString()}`
              : " "}
          </span>
        )}

        {!rankedMode && (
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(v) => update({ per: Number(v) })}
              value={String(query.per)}
            >
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PER_CHOICES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} per page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={query.page === 0}
              onClick={() => navigate({ ...query, page: query.page - 1 })}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="text-muted-foreground text-xs tabular-nums">
              {query.page + 1} / {pageCount.toLocaleString()}
            </span>
            <Button
              disabled={query.page + 1 >= pageCount}
              onClick={() => navigate({ ...query, page: query.page + 1 })}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        )}
      </footer>
    </PageShell>
  );
}
