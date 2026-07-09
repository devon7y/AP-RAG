"use client";

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ExternalLinkIcon,
} from "lucide-react";
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
// one are unsortable. Visibility is toggled from the toolbar (title is always shown).
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
  className: string;
}[] = [
  {
    id: "title",
    label: "Title",
    sort: "title",
    defaultVisible: true,
    className: "min-w-[20rem]",
  },
  {
    id: "authors",
    label: "Authors",
    sort: "first_author",
    defaultVisible: true,
    className: "min-w-[9rem]",
  },
  {
    id: "year",
    label: "Year",
    sort: "year",
    defaultVisible: true,
    className: "w-16",
  },
  {
    id: "date",
    label: "Date",
    sort: "date",
    defaultVisible: false,
    className: "w-24",
  },
  {
    id: "journal",
    label: "Journal",
    sort: "journal",
    defaultVisible: true,
    className: "min-w-[12rem]",
  },
  {
    id: "volisspp",
    label: "Vol(Iss), pp",
    defaultVisible: false,
    className: "min-w-[7rem]",
  },
  { id: "type", label: "Type", defaultVisible: false, className: "w-20" },
  { id: "doi", label: "DOI", defaultVisible: true, className: "min-w-[8rem]" },
  {
    id: "publisher",
    label: "Publisher",
    defaultVisible: false,
    className: "min-w-[10rem]",
  },
  {
    id: "keywords",
    label: "Keywords",
    defaultVisible: false,
    className: "min-w-[12rem]",
  },
  {
    id: "subjects",
    label: "Subjects",
    defaultVisible: false,
    className: "min-w-[12rem]",
  },
  { id: "source", label: "Source", defaultVisible: false, className: "w-20" },
];

export function defaultColumnVisibility(): Record<ColumnId, boolean> {
  return Object.fromEntries(
    COLUMNS.map((c) => [c.id, c.defaultVisible])
  ) as Record<ColumnId, boolean>;
}

const CHIP_LIMIT = 2;

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
      {values.slice(0, CHIP_LIMIT).map((v) => (
        <Badge
          asChild
          className="max-w-[10rem] cursor-pointer font-normal"
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
      {values.length > CHIP_LIMIT && (
        <span className="text-muted-foreground text-xs">
          +{values.length - CHIP_LIMIT}
        </span>
      )}
    </span>
  );
}

function HeaderCell({
  label,
  sortKey,
  activeSort,
  order,
  onSort,
  className,
}: {
  label: string;
  sortKey?: string;
  activeSort: string;
  order: SortOrder;
  onSort: (key: string) => void;
  className: string;
}) {
  if (!sortKey) {
    return (
      <th className={cn("px-3 py-2 text-left font-medium", className)}>
        {label}
      </th>
    );
  }
  const isActive = activeSort === sortKey;
  let Icon = ArrowUpDownIcon;
  if (isActive) {
    Icon = order === "asc" ? ArrowUpIcon : ArrowDownIcon;
  }
  return (
    <th className={cn("px-3 py-2 text-left font-medium", className)}>
      <button
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground"
        )}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        {label}
        <Icon className={cn("size-3", !isActive && "opacity-50")} />
      </button>
    </th>
  );
}

export function PapersTable({
  rows,
  visible,
  sort,
  order,
  onSort,
  onOpen,
  onAddFilter,
  deepMode,
  isLoading,
}: {
  rows: (PaperRow | RankedPaper)[];
  visible: Record<ColumnId, boolean>;
  sort: string;
  order: SortOrder;
  onSort: (key: string) => void;
  onOpen: (filename: string) => void;
  onAddFilter: (dim: ListFilterKey, value: string) => void;
  deepMode: boolean;
  isLoading: boolean;
}) {
  const columns = COLUMNS.filter((c) => c.id === "title" || visible[c.id]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_0_var(--border)]">
          <tr>
            {deepMode && (
              <th className="w-20 px-3 py-2 text-left font-medium">Match</th>
            )}
            {columns.map((c) => (
              <HeaderCell
                activeSort={sort}
                className={c.className}
                key={c.id}
                label={c.label}
                onSort={onSort}
                // Relevance order is fixed in deep mode — header sorting is browse-only.
                order={order}
                sortKey={deepMode ? undefined : c.sort}
              />
            ))}
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
                  <td className={cn("px-3 py-2", c.className)} key={c.id}>
                    <Cell
                      column={c.id}
                      deepMode={deepMode}
                      onAddFilter={onAddFilter}
                      row={row}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && !isLoading && (
        <div className="flex flex-col items-center gap-1 py-16 text-center text-muted-foreground text-sm">
          <p>No papers match.</p>
          <p className="text-xs">
            Try fewer filters, or press Enter for a semantic deep search.
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
        <span title={fullAuthorList(row.authors)}>
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
      return <span className="tabular-nums">{volIssuePages(row)}</span>;
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
