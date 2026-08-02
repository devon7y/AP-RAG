"use client";

import { Brain, NetworkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { compactAuthors, displayTitle, paperFetcher } from "@/components/papers/lib";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  REASONING_EFFORTS,
  RETRIEVAL_MODES,
  type ReasoningEffort,
  type RetrievalMode,
} from "@/lib/ai/models";
import type { Facets } from "@/lib/aprag/client";
import { detectFilters } from "@/lib/aprag/detect";
import type { PaperListResponse, RagFilters } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { FacetInput, useFacets, usePapersIndex } from "./facet-input";

const MODE_LABEL: Record<RetrievalMode, string> = {
  auto: "Auto Retrieval",
  hybrid: "Hybrid Retrieval",
  local: "Local Retrieval",
  global: "Global Retrieval",
  mix: "Mix Retrieval",
  naive: "Naive Retrieval",
};

const MODE_HINT: Record<RetrievalMode, string> = {
  auto: "The model picks the method (recommended)",
  hybrid: "Graph + vector",
  local: "Entity-focused (specific leads)",
  global: "Theme-focused (relationships)",
  mix: "Combined graph + vector",
  naive: "Plain vector search",
};

// Short label for the closed trigger.
const REASONING_LABEL: Record<ReasoningEffort, string> = {
  none: "No reasoning",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};
// Descriptive hint for the open menu.
const REASONING_HINT: Record<ReasoningEffort, string> = {
  none: "Fastest (no reasoning)",
  low: "A little reasoning",
  medium: "More careful",
  high: "Very careful",
  xhigh: "Most careful (slowest)",
};

// Each metadata filter that maps to a Facets key, surfaced as its own composer button.
const FACET_FILTERS: { key: keyof RagFilters & keyof Facets; label: string }[] =
  [
    { key: "authors", label: "Authors" },
    { key: "journals", label: "Journals" },
    { key: "subjects", label: "Subjects" },
    { key: "keywords", label: "Keywords" },
    { key: "affiliations", label: "Affiliations" },
  ];

export function RagControls() {
  const {
    reasoning,
    setReasoning,
    retrievalMode,
    setRetrievalMode,
    filters,
    setFilters,
    input,
  } = useActiveChat();

  // Facets (autocomplete options) are large: load once a filter is first opened OR the
  // user starts typing (so we can highlight buttons for auto-detected filters).
  const [facetsEnabled, setFacetsEnabled] = useState(false);
  const facets = useFacets(facetsEnabled || input.trim().length > 0);
  const papersIndex = usePapersIndex(
    facetsEnabled || input.trim().length > 0
  );

  // What the composer text would auto-apply — used to light up the matching buttons, the
  // same signal the in-text filter chips use.
  const detected = useMemo(
    () => detectFilters(input, facets, papersIndex),
    [input, facets, papersIndex]
  );

  const setList = (key: keyof Facets | "papers") => (next: string[]) =>
    setFilters((prev) => {
      const merged: RagFilters = { ...(prev ?? {}) };
      if (next.length > 0) {
        merged[key] = next;
      } else {
        delete merged[key];
      }
      return Object.keys(merged).length > 0 ? merged : null;
    });

  // A dimension's button is "active" if it has an applied filter OR the typed text would
  // add one.
  const dimActive = (key: keyof Facets | "papers") =>
    (filters?.[key]?.length ?? 0) > 0 || (detected[key]?.length ?? 0) > 0;
  const yearActive =
    filters?.year_from != null ||
    filters?.year_to != null ||
    (filters?.years?.length ?? 0) > 0 ||
    detected.year_from != null ||
    detected.year_to != null ||
    detected.year != null ||
    (detected.years?.length ?? 0) > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Retrieval mode — full label in the trigger, hint in the menu */}
      <Select
        onValueChange={(v) => setRetrievalMode(v as RetrievalMode)}
        value={retrievalMode}
      >
        <SelectTrigger
          className="h-7 gap-1.5 rounded-lg border-0 px-2 text-xs shadow-none hover:bg-accent"
          size="sm"
        >
          <NetworkIcon className="size-3.5" />
          {MODE_LABEL[retrievalMode]}
        </SelectTrigger>
        <SelectContent align="start" position="popper">
          {RETRIEVAL_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              <span>{MODE_LABEL[m]}</span>
              <span className="ml-2 text-muted-foreground text-xs">
                {MODE_HINT[m]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Reasoning effort — short label in the trigger, hint in the menu */}
      <Select
        onValueChange={(v) => setReasoning(v as ReasoningEffort)}
        value={reasoning}
      >
        <SelectTrigger
          className="h-7 gap-1.5 rounded-lg border-0 px-2 text-xs shadow-none hover:bg-accent"
          size="sm"
        >
          <Brain className="size-3.5" />
          {REASONING_LABEL[reasoning]}
        </SelectTrigger>
        <SelectContent align="start" position="popper">
          {REASONING_EFFORTS.map((r) => (
            <SelectItem key={r} value={r}>
              <span>{REASONING_LABEL[r]}</span>
              <span className="ml-2 text-muted-foreground text-xs">
                {REASONING_HINT[r]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Individual metadata filters, inline. Papers first: pin specific papers —
          retrieval is scoped to exactly those files (pin several to compare them). */}
      <PapersFilterButton
        active={dimActive("papers")}
        onChange={setList("papers")}
        selected={filters?.papers ?? []}
      />
      {FACET_FILTERS.map((f) => (
        <FacetFilterButton
          active={dimActive(f.key)}
          key={f.key}
          label={f.label}
          onChange={setList(f.key)}
          onOpen={() => setFacetsEnabled(true)}
          options={facets[f.key] ?? []}
          selected={filters?.[f.key] ?? []}
        />
      ))}

      <YearFilterButton
        active={yearActive}
        filters={filters}
        setFilters={setFilters}
      />
    </div>
  );
}

function FacetFilterButton({
  active,
  label,
  options,
  selected,
  onChange,
  onOpen,
}: {
  active: boolean;
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  onOpen: () => void;
}) {
  return (
    <Popover onOpenChange={(open) => open && onOpen()}>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "h-7 gap-1.5 rounded-lg px-2 text-xs",
            active && "bg-accent text-foreground"
          )}
          size="sm"
          type="button"
          variant="ghost"
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <FacetInput
          label={label}
          onChange={onChange}
          options={options}
          placeholder={`Type a ${label.replace(/s$/, "").toLowerCase()}…`}
          selected={selected}
        />
      </PopoverContent>
    </Popover>
  );
}

const PAPER_SEARCH_DEBOUNCE_MS = 250;
const MAX_PAPER_SUGGESTIONS = 8;

// "Papers" filter: search the corpus (same quick match as the Paper Database — title/
// author/journal/DOI/filename tokens) and pin specific papers. Retrieval is then scoped
// to exactly those files; pinning several makes the answer weigh/compare exactly them.
function PapersFilterButton({
  active,
  selected,
  onChange,
}: {
  active: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), PAPER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading } = useSWR<PaperListResponse>(
    debounced.trim()
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/papers?q=${encodeURIComponent(
          debounced.trim()
        )}&limit=${MAX_PAPER_SUGGESTIONS}&sort=year&order=desc`
      : null,
    paperFetcher,
    { revalidateOnFocus: false, keepPreviousData: true }
  );

  const suggestions = (data?.papers ?? []).filter(
    (p) => !selected.includes(p.filename)
  );

  const add = (filename: string) => {
    if (filename && !selected.includes(filename)) {
      onChange([...selected, filename]);
    }
    setQuery("");
    setDebounced("");
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "h-7 gap-1.5 rounded-lg px-2 text-xs",
            active && "bg-accent text-foreground"
          )}
          size="sm"
          type="button"
          variant="ghost"
        >
          Papers
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96">
        <div className="space-y-1.5">
          <Label className="text-xs">Papers</Label>
          <Input
            autoComplete="off"
            className="h-8 text-sm"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestions[0]) {
                  add(suggestions[0].filename);
                }
              } else if (e.key === "Tab" && suggestions.length > 0) {
                e.preventDefault();
                add(suggestions[0].filename);
              }
            }}
            placeholder="Search a paper — title, author, year…"
            value={query}
          />
          {query.trim() && suggestions.length === 0 && !isLoading && (
            <p className="px-1 text-muted-foreground text-xs">
              No papers match.
            </p>
          )}
          {suggestions.length > 0 && (
            <ul className="max-h-56 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-sm">
              {suggestions.map((p, i) => (
                <li key={p.filename}>
                  <button
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-2 py-1.5 text-left text-sm hover:bg-accent",
                      i === 0 && "bg-accent/40"
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(p.filename);
                    }}
                    type="button"
                  >
                    <span className="line-clamp-1">{displayTitle(p)}</span>
                    <span className="text-muted-foreground text-xs">
                      {[compactAuthors(p.authors), p.year]
                        .filter(Boolean)
                        .join(", ")}
                      {i === 0 && (
                        <span className="ml-2 rounded border px-1 text-[10px]">
                          tab
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="px-1 text-[11px] text-muted-foreground">
            Answers draw only on pinned papers. Pin two or more and ask to
            compare them.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function YearFilterButton({
  active,
  filters,
  setFilters,
}: {
  active: boolean;
  filters: RagFilters | null;
  setFilters: ReturnType<typeof useActiveChat>["setFilters"];
}) {
  const num = (value: string): number | undefined => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const setYear = (key: "year_from" | "year_to", value: number | undefined) =>
    setFilters((prev) => {
      const merged: RagFilters = { ...(prev ?? {}) };
      if (value == null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
      return Object.keys(merged).length > 0 ? merged : null;
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            "h-7 gap-1.5 rounded-lg px-2 text-xs",
            active && "bg-accent text-foreground"
          )}
          size="sm"
          type="button"
          variant="ghost"
        >
          Year
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-56 grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="filter-year-from">
            From
          </Label>
          <Input
            className="h-8 text-sm"
            defaultValue={filters?.year_from ?? ""}
            id="filter-year-from"
            inputMode="numeric"
            onChange={(e) => setYear("year_from", num(e.target.value))}
            placeholder="2015"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="filter-year-to">
            To
          </Label>
          <Input
            className="h-8 text-sm"
            defaultValue={filters?.year_to ?? ""}
            id="filter-year-to"
            inputMode="numeric"
            onChange={(e) => setYear("year_to", num(e.target.value))}
            placeholder="2026"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
