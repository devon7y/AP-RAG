"use client";

import {
  Columns3Icon,
  DownloadIcon,
  FilterIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FacetInput, useFacets } from "@/components/chat/facet-input";
import type { RagFilters } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  countActiveFilters,
  FILTER_LABEL,
  LIST_FILTER_KEYS,
  type ListFilterKey,
} from "./lib";
import { COLUMNS, type ColumnId } from "./papers-table";

const DEBOUNCE_MS = 300;

// The universal search bar + filter/column/export controls. Two search tiers share the
// one input: typing quick-matches metadata live (title/author/journal/DOI/filename
// tokens); Enter runs a semantic deep search over the papers' actual text.
export function PapersToolbar({
  q,
  deep,
  deepLoading,
  filters,
  visible,
  exporting,
  onQChange,
  onDeepSearch,
  onFiltersChange,
  onToggleColumn,
  onExport,
}: {
  q: string;
  deep: string;
  deepLoading: boolean;
  filters: RagFilters | null;
  visible: Record<ColumnId, boolean>;
  exporting: boolean;
  onQChange: (q: string) => void;
  onDeepSearch: (query: string) => void;
  onFiltersChange: (f: RagFilters | null) => void;
  onToggleColumn: (id: ColumnId) => void;
  onExport: (format: "csv" | "bibtex") => void;
}) {
  const [text, setText] = useState(q || deep);

  // Keep the input in sync when the URL changes from elsewhere (back button, chips).
  useEffect(() => {
    setText(q || deep);
  }, [q, deep]);

  // Debounced instant tier. Deep mode is left alone until the user commits (Enter).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeText = (value: string) => {
    setText(value);
    if (deep) {
      return; // editing while a deep search is shown — wait for Enter/clear
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => onQChange(value), DEBOUNCE_MS);
  };

  const clear = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    setText("");
    if (deep) {
      onDeepSearch("");
    } else {
      onQChange("");
    }
  };

  const nFilters = countActiveFilters(filters);

  return (
    <div className="flex flex-col gap-2 border-border/60 border-b px-3 pb-2 md:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            autoComplete="off"
            className={cn("h-9 pl-8", text.trim() ? "pr-24 sm:pr-56" : "pr-9")}
            onChange={(e) => changeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (debounceRef.current) {
                  clearTimeout(debounceRef.current);
                }
                onDeepSearch(text.trim());
              } else if (e.key === "Escape") {
                clear();
              }
            }}
            placeholder="Search title, author, journal, DOI… — press Enter for semantic search"
            value={text}
          />
          <div className="-translate-y-1/2 absolute top-1/2 right-2 flex items-center gap-1.5">
            {deepLoading && (
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            )}
            {!deepLoading && text.trim() && (
              <span
                className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex"
                title="Semantic search over the papers' text — finds papers even when you don't remember exact details"
              >
                <kbd className="rounded border border-border bg-muted px-1 py-px font-sans">
                  Enter
                </kbd>
                for semantic search
              </span>
            )}
            {(text || deep) && (
              <button
                aria-label="Clear search"
                className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                onClick={clear}
                type="button"
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
        </div>

        <FiltersPopover
          filters={filters}
          n={nFilters}
          onChange={onFiltersChange}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="h-9" type="button" variant="outline">
              <Columns3Icon className="size-4" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Show columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {COLUMNS.filter((c) => c.id !== "title").map((c) => (
              <DropdownMenuCheckboxItem
                checked={visible[c.id]}
                key={c.id}
                onCheckedChange={() => onToggleColumn(c.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {c.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="h-9"
              disabled={exporting}
              type="button"
              variant="outline"
            >
              {exporting ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <DownloadIcon className="size-4" />
              )}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Current filtered set</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onExport("csv")}>
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onExport("bibtex")}>
              BibTeX
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <FilterChips
        deep={deep}
        filters={filters}
        onDeepSearch={onDeepSearch}
        onFiltersChange={onFiltersChange}
      />
    </div>
  );
}

function FiltersPopover({
  filters,
  onChange,
  n,
}: {
  filters: RagFilters | null;
  onChange: (f: RagFilters | null) => void;
  n: number;
}) {
  const [open, setOpen] = useState(false);
  const facets = useFacets(open);

  const setList = (key: ListFilterKey, values: string[]) => {
    const next: RagFilters = { ...(filters ?? {}) };
    if (values.length > 0) {
      next[key] = values;
    } else {
      delete next[key];
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  const setYear = (key: "year_from" | "year_to", raw: string) => {
    const next: RagFilters = { ...(filters ?? {}) };
    const v = Number(raw);
    if (raw && Number.isInteger(v) && v > 0) {
      next[key] = v;
    } else {
      delete next[key];
    }
    onChange(Object.keys(next).length > 0 ? next : null);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button className="h-9" type="button" variant="outline">
          <FilterIcon className="size-4" />
          Filters
          {n > 0 && (
            <Badge className="px-1.5" variant="secondary">
              {n}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <FacetInput
          label="Authors"
          onChange={(v) => setList("authors", v)}
          options={facets.authors}
          placeholder="e.g. Westbury"
          selected={filters?.authors ?? []}
        />
        <FacetInput
          label="Journals"
          onChange={(v) => setList("journals", v)}
          options={facets.journals}
          placeholder="e.g. Memory & Cognition"
          selected={filters?.journals ?? []}
        />
        <FacetInput
          label="Subjects"
          onChange={(v) => setList("subjects", v)}
          options={facets.subjects}
          placeholder="e.g. Psycholinguistics"
          selected={filters?.subjects ?? []}
        />
        <FacetInput
          label="Keywords"
          onChange={(v) => setList("keywords", v)}
          options={facets.keywords}
          placeholder="e.g. word frequency"
          selected={filters?.keywords ?? []}
        />
        <FacetInput
          label="Affiliations"
          onChange={(v) => setList("affiliations", v)}
          options={facets.affiliations}
          placeholder="e.g. University of Alberta"
          selected={filters?.affiliations ?? []}
        />
        <FacetInput
          label="Type"
          onChange={(v) => setList("types", v)}
          options={facets.types ?? []}
          placeholder="e.g. article, book"
          selected={filters?.types ?? []}
        />
        <div className="space-y-1.5">
          <Label className="text-xs">Year range</Label>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 text-sm"
              inputMode="numeric"
              onChange={(e) => setYear("year_from", e.target.value)}
              placeholder="from"
              value={filters?.year_from ?? ""}
            />
            <span className="text-muted-foreground">–</span>
            <Input
              className="h-8 text-sm"
              inputMode="numeric"
              onChange={(e) => setYear("year_to", e.target.value)}
              placeholder="to"
              value={filters?.year_to ?? ""}
            />
          </div>
        </div>
        {n > 0 && (
          <Button
            className="w-full"
            onClick={() => onChange(null)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear all filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Active filter + deep-search chips (removable), mirroring the chat's filter chips.
function FilterChips({
  filters,
  deep,
  onFiltersChange,
  onDeepSearch,
}: {
  filters: RagFilters | null;
  deep: string;
  onFiltersChange: (f: RagFilters | null) => void;
  onDeepSearch: (q: string) => void;
}) {
  const chips: {
    id: string;
    label: string;
    onRemove: () => void;
    deep?: boolean;
  }[] = [];

  if (deep) {
    chips.push({
      id: "deep",
      label: `Deep search: ${deep}`,
      onRemove: () => onDeepSearch(""),
      deep: true,
    });
  }
  for (const key of LIST_FILTER_KEYS) {
    for (const v of filters?.[key] ?? []) {
      chips.push({
        id: `${key}-${v}`,
        label: `${FILTER_LABEL[key]}: ${v}`,
        onRemove: () => {
          const next: RagFilters = { ...(filters ?? {}) };
          const arr = (next[key] ?? []).filter((x) => x !== v);
          if (arr.length > 0) {
            next[key] = arr;
          } else {
            delete next[key];
          }
          onFiltersChange(Object.keys(next).length > 0 ? next : null);
        },
      });
    }
  }
  if (filters?.year_from != null || filters?.year_to != null) {
    chips.push({
      id: "year-range",
      label: `Year: ${filters.year_from ?? "…"}–${filters.year_to ?? "…"}`,
      onRemove: () => {
        const next: RagFilters = { ...(filters ?? {}) };
        next.year_from = undefined;
        next.year_to = undefined;
        const cleaned = Object.fromEntries(
          Object.entries(next).filter(([, v]) => v != null)
        ) as RagFilters;
        onFiltersChange(Object.keys(cleaned).length > 0 ? cleaned : null);
      },
    });
  }

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <Badge
          className={cn("gap-1 pr-1 font-normal", c.deep && "max-w-[24rem]")}
          key={c.id}
          variant={c.deep ? "default" : "secondary"}
        >
          <span className="truncate">{c.label}</span>
          <button
            aria-label={`Remove ${c.label}`}
            className="rounded-sm hover:opacity-70"
            onClick={c.onRemove}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}
