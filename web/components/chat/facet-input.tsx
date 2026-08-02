"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { Facets, PapersIndexRow } from "@/lib/aprag/client";
import type { PaperIndexEntry } from "@/lib/aprag/detect";
import { cn, fetcher } from "@/lib/utils";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

// Distinct filter values (authors/journals/...) for autocomplete. Lazy: only fetched
// once `enabled` is true (i.e. when the user first opens a filter), since the payload is
// large.
export function useFacets(enabled = true): Facets {
  const { data } = useSWR<Facets>(
    enabled ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/facets` : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 600_000 }
  );
  return (
    data ?? {
      authors: [],
      journals: [],
      subjects: [],
      keywords: [],
      affiliations: [],
    }
  );
}

const EMPTY_PAPERS_INDEX: PaperIndexEntry[] = [];

// The slim corpus paper index for in-composer paper-mention detection. Lazy like
// useFacets (the payload covers every paper); rows arrive compact and are widened once.
export function usePapersIndex(enabled = true): PaperIndexEntry[] {
  const { data } = useSWR<{ papers: PapersIndexRow[] }>(
    enabled
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/papers/index`
      : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 3_600_000 }
  );
  return useMemo(
    () =>
      data?.papers
        ? data.papers.map(([filename, title, firstAuthor, year]) => ({
            filename,
            title,
            firstAuthor,
            year,
          }))
        : EMPTY_PAPERS_INDEX,
    [data]
  );
}

const MAX_SUGGESTIONS = 8;

// An "add a filter value" autocomplete: typing shows a suggestion list (only once you
// start typing). Click a suggestion or press Tab to add the top match; Enter adds the top
// match (or your free text). Added values render as removable chips in the chat box (the
// same place the in-text/natural-language filters show) — not inside this popup.
export function FacetInput({
  label,
  placeholder,
  options,
  selected,
  onChange,
}: {
  label: string;
  placeholder?: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return []; // nothing until the user types
    }
    return options
      .filter((o) => o.toLowerCase().includes(q) && !selected.includes(o))
      .slice(0, MAX_SUGGESTIONS);
  }, [query, options, selected]);

  const add = (value: string) => {
    const v = value.trim();
    if (v && !selected.includes(v)) {
      onChange([...selected, v]);
    }
    setQuery("");
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>

      <Input
        autoComplete="off"
        className="h-8 text-sm"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(suggestions[0] ?? query);
          } else if (e.key === "Tab" && suggestions.length > 0) {
            e.preventDefault(); // Tab completes the top suggestion
            add(suggestions[0]);
          }
        }}
        placeholder={placeholder}
        value={query}
      />

      {suggestions.length > 0 && (
        <ul className="max-h-44 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-sm">
          {suggestions.map((o, i) => (
            <li key={o}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent",
                  i === 0 && "bg-accent/40"
                )}
                // onMouseDown (not onClick) so the input keeps focus and the click
                // registers before any blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o);
                }}
                type="button"
              >
                <span className="truncate">{o}</span>
                {i === 0 && (
                  <span className="ml-auto shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    tab
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
