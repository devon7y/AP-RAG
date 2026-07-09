"use client";

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ExternalLinkIcon,
} from "lucide-react";
import type React from "react";
import type { PaperRow, RankedPaper } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import {
  compactAuthors,
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
    width: 340,
  },
  {
    id: "authors",
    label: "Authors",
    sort: "first_author",
    defaultVisible: true,
    width: 150,
  },
  { id: "year", label: "Year", sort: "year", defaultVisible: true, width: 64 },
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
  { id: "source", label: "Source", defaultVisible: false, width: 90 },
];

const MIN_COL_WIDTH = 56;

export function defaultColumnVisibility(): Record<ColumnId, boolean> {
  return Object.fromEntries(
    COLUMNS.map((c) => [c.id, c.defaultVisible])
  ) as Record<ColumnId, boolean>;
}

function ChipList({
  values,
  dim,
  onAddFilter,
}: {
  values: string[];
  dim: ListFilterKey;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
}) {
  if (values.length === 0) {
    return null;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <Badge
          asChild
          // hover:bg-muted-foreground/30 (not accent — accent is ~invisible against the
          // background in light mode): a clearly visible lighten/darken in both themes.
          className="max-w-[14rem] cursor-pointer font-normal transition-colors hover:border-muted-foreground/50 hover:bg-muted-foreground/30"
          key={v}
          variant="outline"
        >
          <button
            onClick={(e) => {
              e.stopPropagation(); // add a filter without opening the row drawer
              onAddFilter(dim, v);
            }}
            title={`Filter by ${v}`}
            type="button"
          >
            <span className="truncate">{v}</span>
          </button>
        </Badge>
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
  const startResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent) => {
      onResize(
        columnId,
        Math.max(MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX))
      );
    };
    const up = () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  let sortControl: React.ReactNode = label;
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
      className="relative overflow-hidden px-3 py-2 text-left font-medium"
      style={{ width }}
    >
      {sortControl}
      <button
        aria-label={`Resize ${label} column`}
        className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none border-0 bg-transparent p-0 hover:bg-primary/30 active:bg-primary/40"
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
  onAddFilter,
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
  onOpen: (filename: string) => void;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
  deepMode: boolean;
  isLoading: boolean;
}) {
  const columns = COLUMNS.filter((c) => c.id === "title" || visible[c.id]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="min-w-full table-fixed border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
          <tr>
            {deepMode && (
              <th
                className="px-3 py-2 text-left font-medium"
                style={{ width: 80 }}
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
                onClick={() => onOpen(row.filename)}
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
                      onAddFilter={onAddFilter}
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

function Cell({
  row,
  column,
  deepMode,
  onAddFilter,
}: {
  row: PaperRow | RankedPaper;
  column: ColumnId;
  deepMode: boolean;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
}) {
  switch (column) {
    case "title": {
      const title = displayTitle(row);
      const snippet = deepMode ? (row as RankedPaper).snippet : "";
      return (
        <div>
          <div
            className={cn(
              "line-clamp-2 font-medium",
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
        </div>
      );
    }
    case "authors":
      return (
        <span className="block truncate" title={fullAuthorList(row.authors)}>
          {compactAuthors(row.authors)}
        </span>
      );
    case "year":
      return <span className="tabular-nums">{row.year}</span>;
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
          dim="keywords"
          onAddFilter={onAddFilter}
          values={row.keywords}
        />
      );
    case "subjects":
      return (
        <ChipList
          dim="subjects"
          onAddFilter={onAddFilter}
          values={row.subjects}
        />
      );
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
