"use client";

import { ChevronLeftIcon, ChevronRightIcon, DatabaseIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { useLocalStorage } from "usehooks-ts";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import type {
  PaperListResponse,
  PaperRow,
  RagFilters,
  RankedPaper,
} from "@/lib/aprag/types";
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
  type ListFilterKey,
  type PapersQuery,
  PER_CHOICES,
  paperFetcher,
  papersQueryString,
  parsePapersQuery,
  postJson,
} from "./lib";
import { PaperDrawer } from "./paper-drawer";
import {
  type ColumnId,
  defaultColumnVisibility,
  PapersTable,
} from "./papers-table";
import { PapersToolbar } from "./papers-toolbar";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type DeepResult = { papers: RankedPaper[]; matched_files: number | null };

// The Paper Database page: a server-driven table over the papers manifest with a
// two-tier universal search. All view state (search, filters, sort, page) lives in the
// URL, so any view is shareable and the back button walks through view changes.
export function PapersBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = useMemo(() => parsePapersQuery(searchParams), [searchParams]);

  const navigate = useCallback(
    (next: PapersQuery) => {
      const qs = papersQueryString(next);
      router.replace(`${BASE}/papers${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router]
  );
  // Any change other than explicit paging returns to the first page.
  const update = (patch: Partial<PapersQuery>) =>
    navigate({ ...query, page: 0, ...patch });

  // Browse tier: server-paginated listing.
  const browseKey = query.deep
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

  const [storedColumns, setStoredColumns] = useLocalStorage<
    Partial<Record<ColumnId, boolean>>
  >("aprag:papers:columns", {});
  const visible = useMemo(
    () => ({ ...defaultColumnVisibility(), ...storedColumns }),
    [storedColumns]
  );

  const [openFilename, setOpenFilename] = useState<string | null>(null);
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

  const onAddFilter = (dim: ListFilterKey, value: string) => {
    const current = query.filters?.[dim] ?? [];
    if (current.includes(value)) {
      return;
    }
    const filters: RagFilters = {
      ...(query.filters ?? {}),
      [dim]: [...current, value],
    };
    update({ filters });
    setOpenFilename(null); // adding from the drawer should reveal the filtered table
  };

  const onExport = async (format: "csv" | "bibtex") => {
    setExporting(true);
    try {
      const rows: PaperRow[] = query.deep
        ? (deep?.papers ?? [])
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
  const rows: (PaperRow | RankedPaper)[] = deepMode
    ? (deep?.papers ?? [])
    : (list?.papers ?? []);
  const total = list?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / query.per));
  const error = deepMode ? deepError : listError;
  const isLoading = deepMode ? deepLoading : listLoading;

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2 md:px-4">
        <SidebarToggle />
        <DatabaseIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">Paper Database</h1>
        {!deepMode && total > 0 && (
          <span className="text-muted-foreground text-xs">
            {total.toLocaleString()} papers
          </span>
        )}
      </header>

      <PapersToolbar
        deep={query.deep}
        deepLoading={deepLoading}
        exporting={exporting}
        filters={query.filters}
        onDeepSearch={(deepQuery) =>
          update(deepQuery ? { deep: deepQuery, q: "" } : { deep: "", q: "" })
        }
        onExport={onExport}
        onFiltersChange={(filters) => update({ filters })}
        onQChange={(q) => update({ q })}
        onToggleColumn={(id) =>
          setStoredColumns((prev) => ({ ...prev, [id]: !visible[id] }))
        }
        q={query.q}
        visible={visible}
      />

      {error && (
        <div className="border-border/60 border-b bg-destructive/10 px-4 py-2 text-destructive text-sm">
          Paper database unreachable — the backend may be offline. Retry in a
          moment.
        </div>
      )}

      <PapersTable
        deepMode={deepMode}
        isLoading={isLoading}
        onAddFilter={onAddFilter}
        onOpen={setOpenFilename}
        onSort={onSort}
        order={query.order}
        rows={rows}
        sort={query.sort}
        visible={visible}
      />

      <footer className="flex flex-wrap items-center justify-between gap-2 border-border/60 border-t px-3 py-2 md:px-4">
        {deepMode ? (
          <span className="text-muted-foreground text-xs">
            {deepLoading
              ? "Searching the corpus…"
              : `${rows.length} paper${rows.length === 1 ? "" : "s"} ranked by relevance`}
            {deep?.matched_files != null &&
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

        {!deepMode && (
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(v) => update({ per: Number(v) })}
              value={String(query.per)}
            >
              <SelectTrigger className="h-8 w-28 text-xs">
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

      <PaperDrawer
        filename={openFilename}
        onAddFilter={onAddFilter}
        onClose={() => setOpenFilename(null)}
      />
    </div>
  );
}
