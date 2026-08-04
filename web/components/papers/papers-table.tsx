"use client";

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ExternalLinkIcon,
} from "lucide-react";
import Link from "next/link";
import type React from "react";
import type { GraphFileEntity } from "@/lib/aprag/client";
import type {
  PaperAuthor,
  PaperRow,
  RagFilters,
  RankedPaper,
} from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import {
  authorName,
  displayTitle,
  fullAuthorList,
  type ListFilterKey,
  type SortOrder,
  volIssuePages,
} from "./lib";

// Column model. `sort` names the server sort key a header click drives; columns without
// one are unsortable. `width` is the default px width — the user can drag the header
// edge to resize (persisted), and visibility is toggled from the toolbar (title always
// shows). The table uses fixed layout, so widths are exact and the row scrolls
// horizontally inside its container when the sum exceeds the viewport.
export type ColumnId =
  | "title"
  | "authors"
  | "year"
  | "date"
  | "journal"
  | "volisspp"
  | "type"
  | "doi"
  | "publisher"
  | "keywords"
  | "subjects"
  | "affiliations"
  | "graph"
  | "source";

export const COLUMNS: {
  id: ColumnId;
  label: string;
  sort?: string;
  defaultVisible: boolean;
  width: number;
}[] = [
  {
    id: "title",
    label: "Title",
    sort: "title",
    defaultVisible: true,
    width: 510,
  },
  {
    id: "authors",
    label: "Authors",
    sort: "first_author",
    defaultVisible: true,
    width: 260,
  },
  { id: "year", label: "Year", sort: "year", defaultVisible: true, width: 72 },
  {
    id: "date",
    label: "Date",
    sort: "date",
    defaultVisible: false,
    width: 100,
  },
  {
    id: "journal",
    label: "Journal",
    sort: "journal",
    defaultVisible: true,
    width: 200,
  },
  { id: "volisspp", label: "Vol(Iss), pp", defaultVisible: false, width: 120 },
  { id: "type", label: "Type", defaultVisible: false, width: 88 },
  { id: "doi", label: "DOI", defaultVisible: true, width: 160 },
  { id: "publisher", label: "Publisher", defaultVisible: false, width: 160 },
  { id: "keywords", label: "Keywords", defaultVisible: false, width: 240 },
  { id: "subjects", label: "Subjects", defaultVisible: false, width: 240 },
  {
    id: "affiliations",
    label: "Affiliations",
    defaultVisible: true,
    width: 260,
  },
  // On by default, but the priciest column: each paper's entities cost a graph lookup,
  // so turning it off in the Columns menu also stops the per-page batch request.
  { id: "graph", label: "Knowledge graph", defaultVisible: true, width: 280 },
  { id: "source", label: "Source", defaultVisible: false, width: 90 },
];

const MIN_COL_WIDTH = 56;
const MATCH_COL_WIDTH = 80; // the deep-search "Match" column (not user-resizable)

export function defaultColumnVisibility(): Record<ColumnId, boolean> {
  return Object.fromEntries(
    COLUMNS.map((c) => [c.id, c.defaultVisible])
  ) as Record<ColumnId, boolean>;
}

// One clickable chip that toggles a filter. Chips never open the row drawer (they stop
// propagation) — hover:bg-muted-foreground/30 rather than accent, which is ~invisible
// against the background in light mode.
function FilterChip({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Badge
      asChild
      className={cn(
        "max-w-full cursor-pointer font-normal transition-colors hover:border-muted-foreground/50 hover:bg-muted-foreground/30",
        active && "border-primary/50 bg-primary/15"
      )}
      variant="outline"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        title={title}
        type="button"
      >
        <span className="truncate">{label}</span>
      </button>
    </Badge>
  );
}

function ChipList({
  values,
  dim,
  active,
  onToggleFilter,
}: {
  values: string[];
  dim: ListFilterKey;
  active: RagFilters | null;
  onToggleFilter: (dim: ListFilterKey, value: string) => void;
}) {
  if (values.length === 0) {
    return null;
  }
  const on = active?.[dim] ?? [];
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <FilterChip
          active={on.includes(v)}
          key={v}
          label={v}
          onClick={() => onToggleFilter(dim, v)}
          title={`Filter by ${v}`}
        />
      ))}
    </span>
  );
}

function HeaderCell({
  label,
  columnId,
  sortKey,
  activeSort,
  order,
  width,
  onSort,
  onResize,
}: {
  label: string;
  columnId: ColumnId;
  sortKey?: string;
  activeSort: string;
  order: SortOrder;
  width: number;
  onSort: (key: string) => void;
  onResize: (id: ColumnId, px: number) => void;
}) {
  // Window-level listeners (not element capture): the header cell re-renders on every
  // width update, so listeners must outlive it; window always sees the drag through.
  const startResize = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      onResize(
        columnId,
        Math.max(MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX))
      );
    };
    const up = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  let sortControl: React.ReactNode = (
    <span className="block truncate">{label}</span>
  );
  if (sortKey) {
    const isActive = activeSort === sortKey;
    let Icon = ArrowUpDownIcon;
    if (isActive) {
      Icon = order === "asc" ? ArrowUpIcon : ArrowDownIcon;
    }
    sortControl = (
      <button
        className={cn(
          "inline-flex max-w-full items-center gap-1 hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground"
        )}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        <span className="truncate">{label}</span>
        <Icon className={cn("size-3 shrink-0", !isActive && "opacity-50")} />
      </button>
    );
  }

  return (
    <th
      className="relative px-3 py-2 text-left font-medium"
      style={{ width, minWidth: width, maxWidth: width }}
    >
      {sortControl}
      {/* The grab handle straddles the column edge (translate-x-1/2) so it is reachable
          from either side, and sits above the sticky header's stacking context. */}
      <button
        aria-label={`Resize ${label} column`}
        className="absolute inset-y-0 right-0 z-20 w-3 translate-x-1/2 cursor-col-resize touch-none select-none border-0 bg-transparent p-0 hover:bg-primary/30 active:bg-primary/40"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={startResize}
        type="button"
      />
    </th>
  );
}

export function PapersTable({
  rows,
  visible,
  widths,
  sort,
  order,
  onSort,
  onResizeColumn,
  onOpen,
  onShowSimilar,
  onToggleFilter,
  onToggleYear,
  filters,
  graphEntities,
  deepMode,
  isLoading,
}: {
  rows: (PaperRow | RankedPaper)[];
  visible: Record<ColumnId, boolean>;
  widths: Partial<Record<ColumnId, number>>;
  sort: string;
  order: SortOrder;
  onSort: (key: string) => void;
  onResizeColumn: (id: ColumnId, px: number) => void;
  // Clicking a row opens the paper in the PDF reader.
  onOpen: (row: PaperRow) => void;
  onShowSimilar: (filename: string) => void;
  onToggleFilter: (dim: ListFilterKey, value: string) => void;
  onToggleYear: (year: number) => void;
  filters: RagFilters | null;
  // filename → its knowledge-graph entities (undefined while the batch is in flight).
  graphEntities: Record<string, GraphFileEntity[]> | undefined;
  deepMode: boolean;
  isLoading: boolean;
}) {
  const columns = COLUMNS.filter((c) => c.id === "title" || visible[c.id]);
  // An explicit table width is what makes `table-layout: fixed` honor each column's
  // width exactly (with width:auto the engine falls back to content-driven sizing, and
  // dragging a header edge appears to do nothing). The width-less filler column then
  // absorbs any slack when the columns don't fill the viewport.
  const totalWidth =
    columns.reduce((sum, c) => sum + (widths[c.id] ?? c.width), 0) +
    (deepMode ? MATCH_COL_WIDTH : 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table
        className="table-fixed border-collapse text-[13px]"
        style={{ width: totalWidth, minWidth: "100%" }}
      >
        <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
          <tr>
            {deepMode && (
              <th
                className="px-3 py-2 text-left font-medium"
                style={{ width: MATCH_COL_WIDTH }}
              >
                Match
              </th>
            )}
            {columns.map((c) => (
              <HeaderCell
                activeSort={sort}
                columnId={c.id}
                key={c.id}
                label={c.label}
                onResize={onResizeColumn}
                onSort={onSort}
                order={order}
                // Relevance order is fixed in deep mode — header sorting is browse-only.
                sortKey={deepMode ? undefined : c.sort}
                width={widths[c.id] ?? c.width}
              />
            ))}
            {/* Width-less filler absorbs the leftover container width, so the fixed
                layout honors each column's dragged width exactly instead of
                redistributing the slack across all columns. */}
            <th aria-hidden className="p-0" />
          </tr>
        </thead>
        <tbody className={cn(isLoading && "opacity-50")}>
          {rows.map((row) => {
            const ranked = row as RankedPaper;
            return (
              <tr
                className="cursor-pointer border-border/60 border-b align-top transition-colors hover:bg-accent/40"
                key={row.filename}
                onClick={() => onOpen(row)}
                title="Open this paper in the reader"
              >
                {deepMode && (
                  <td className="px-3 py-2 tabular-nums">
                    <span className="font-medium">
                      {(ranked.score ?? 0).toFixed(3)}
                    </span>
                    {ranked.n_chunks > 1 && (
                      <span className="ml-1 text-muted-foreground text-xs">
                        ×{ranked.n_chunks}
                      </span>
                    )}
                  </td>
                )}
                {columns.map((c) => (
                  <td className="overflow-hidden px-3 py-2" key={c.id}>
                    <Cell
                      column={c.id}
                      deepMode={deepMode}
                      filters={filters}
                      graphEntities={graphEntities?.[row.filename]}
                      onShowSimilar={onShowSimilar}
                      onToggleFilter={onToggleFilter}
                      onToggleYear={onToggleYear}
                      row={row}
                    />
                  </td>
                ))}
                <td aria-hidden className="p-0" />
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && !isLoading && (
        <div className="flex flex-col items-center gap-1 py-16 text-center text-muted-foreground text-sm">
          <p>No papers match.</p>
          <p className="text-xs">
            Try fewer filters, or press Enter for a semantic search.
          </p>
        </div>
      )}
    </div>
  );
}

// The paper's authors that have a printable name, each with a stable React key (a
// repeated name gets a suffix — the array index alone would reorder badly).
function namedAuthors(
  authors: PaperAuthor[] | undefined
): { key: string; name: string; family: string }[] {
  const seen = new Map<string, number>();
  const out: { key: string; name: string; family: string }[] = [];
  for (const a of authors ?? []) {
    const name = authorName(a);
    if (!name) {
      continue;
    }
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.push({
      key: n > 1 ? `${name}#${n}` : name,
      name,
      family: (a.family ?? "").trim(),
    });
  }
  return out;
}

// The entities the ingest model extracted from this paper — each opens that entity in
// the Knowledge Graph explorer. `undefined` means the page's batch lookup is still in
// flight (per-paper graph lookups are scans, so they load after the table).
function GraphCell({ entities }: { entities: GraphFileEntity[] | undefined }) {
  if (entities === undefined) {
    return <Skeleton className="h-4 w-24" />;
  }
  if (entities.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {entities.map((e) => (
        <Badge
          asChild
          className="max-w-full cursor-pointer font-normal transition-colors hover:border-muted-foreground/50 hover:bg-muted-foreground/30"
          key={e.name}
          variant="outline"
        >
          <Link
            href={`/graph/entity?name=${encodeURIComponent(e.name)}`}
            onClick={(event) => event.stopPropagation()} // don't open the row drawer
            title={`${e.type} · ${e.degree} connections — open in the knowledge graph`}
          >
            <span className="truncate">{e.name}</span>
          </Link>
        </Badge>
      ))}
    </span>
  );
}

function Cell({
  row,
  column,
  deepMode,
  filters,
  graphEntities,
  onShowSimilar,
  onToggleFilter,
  onToggleYear,
}: {
  row: PaperRow | RankedPaper;
  column: ColumnId;
  deepMode: boolean;
  filters: RagFilters | null;
  graphEntities: GraphFileEntity[] | undefined;
  onShowSimilar: (filename: string) => void;
  onToggleFilter: (dim: ListFilterKey, value: string) => void;
  onToggleYear: (year: number) => void;
}) {
  switch (column) {
    case "title": {
      const title = displayTitle(row);
      const snippet = deepMode ? (row as RankedPaper).snippet : "";
      return (
        <div>
          {/* Titles wrap in full — never truncated, however many lines they take. */}
          <div
            className={cn(
              "whitespace-normal break-words font-medium",
              !row.title.trim() && "text-muted-foreground italic"
            )}
          >
            {title}
          </div>
          {snippet && (
            <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
              …{snippet}…
            </div>
          )}
          <button
            className="mt-0.5 block text-primary text-xs hover:underline"
            onClick={(e) => {
              e.stopPropagation(); // rank the corpus, don't open the PDF
              onShowSimilar(row.filename);
            }}
            title="Rank the whole corpus by similarity to this paper"
            type="button"
          >
            See all similar papers →
          </button>
        </div>
      );
    }
    case "authors": {
      // Every author, each a chip that filters the table. The filter dimension is the
      // family name (that is the vocabulary the manifest matches on), while the chip
      // shows the full name.
      const authors = namedAuthors(row.authors);
      if (authors.length === 0) {
        return null;
      }
      const on = filters?.authors ?? [];
      return (
        <span
          className="flex flex-wrap gap-1"
          title={fullAuthorList(row.authors)}
        >
          {authors.map(({ key, name, family }) =>
            family ? (
              <FilterChip
                active={on.includes(family)}
                key={key}
                label={name}
                onClick={() => onToggleFilter("authors", family)}
                title={`Filter by ${family}`}
              />
            ) : (
              // No family name to filter on (a corporate author, say) — plain text.
              <span className="text-muted-foreground" key={key}>
                {name}
              </span>
            )
          )}
        </span>
      );
    }
    case "year": {
      const year = Number.parseInt(row.year, 10);
      if (!Number.isFinite(year)) {
        return <span className="tabular-nums">{row.year}</span>;
      }
      return (
        <FilterChip
          active={filters?.year === year}
          label={String(year)}
          onClick={() => onToggleYear(year)}
          title={`Filter by ${year}`}
        />
      );
    }
    case "date":
      return <span className="tabular-nums">{row.date}</span>;
    case "journal":
      return <span className="line-clamp-2">{row.container_title}</span>;
    case "volisspp":
      return (
        <span className="block truncate tabular-nums">
          {volIssuePages(row)}
        </span>
      );
    case "type":
      return <span className="capitalize">{row.type}</span>;
    case "doi":
      if (!row.doi) {
        return null;
      }
      return (
        <a
          className="inline-flex max-w-full items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          href={`https://doi.org/${row.doi}`}
          onClick={(e) => e.stopPropagation()}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span className="truncate">{row.doi}</span>
          <ExternalLinkIcon className="size-3 shrink-0" />
        </a>
      );
    case "publisher":
      return <span className="line-clamp-2">{row.publisher}</span>;
    case "keywords":
      return (
        <ChipList
          active={filters}
          dim="keywords"
          onToggleFilter={onToggleFilter}
          values={row.keywords ?? []}
        />
      );
    case "subjects":
      return (
        <ChipList
          active={filters}
          dim="subjects"
          onToggleFilter={onToggleFilter}
          values={row.subjects ?? []}
        />
      );
    case "affiliations":
      return (
        <ChipList
          active={filters}
          dim="affiliations"
          onToggleFilter={onToggleFilter}
          values={row.affiliations ?? []}
        />
      );
    case "graph":
      return <GraphCell entities={graphEntities} />;
    case "source":
      return (
        <Badge className="font-normal" variant="outline">
          {row.source}
        </Badge>
      );
    default:
      return null;
  }
}
