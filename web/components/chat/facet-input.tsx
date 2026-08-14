"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import type {
  AuthorSuggestion,
  Facets,
  PapersIndexRow,
} from "@/lib/aprag/client";
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

const AUTHOR_SEARCH_DEBOUNCE_MS = 200;
const MAX_AUTHOR_SUGGESTIONS = 12;

// "6 papers · 1999–2011 · The Journal of Neuroscience · with Blair" — everything that
// separates one Zhang from the next.
function authorMeta(a: AuthorSuggestion): string {
  const parts: string[] = [];
  if (a.n_papers > 0) {
    parts.push(`${a.n_papers} paper${a.n_papers === 1 ? "" : "s"}`);
  }
  if (a.year_min > 0) {
    parts.push(
      a.year_min === a.year_max
        ? `${a.year_min}`
        : `${a.year_min}–${a.year_max}`
    );
  }
  if (a.journal) {
    parts.push(a.journal);
  }
  if (a.coauthor) {
    parts.push(`with ${a.coauthor}`);
  }
  return parts.join(" · ");
}

// The Authors filter's autocomplete, everywhere it appears. The corpus holds ~80
// different Zhangs, so this picks a *person* ("Zhang, Kechen") rather than a surname,
// showing each candidate's papers, active years, main journal and main co-author.
// Matches come back most-published first, so Tab takes the surname's best-known author.
//
// `enabled` gates the lookup (pass the containing popover's open state — an empty query
// lists the most prolific authors, so it's worth a request, but not on every render).
// Falls back to plain surname suggestions from `fallbackOptions` (the facets payload)
// when the query server has no /authors endpoint or the lookup fails.
export function AuthorInput({
  label = "Authors",
  enabled = true,
  fallbackOptions,
  selected,
  onChange,
}: {
  label?: string;
  enabled?: boolean;
  fallbackOptions: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), AUTHOR_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading } = useSWR<{ authors: AuthorSuggestion[] }>(
    enabled
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/authors?q=${encodeURIComponent(
          debounced.trim()
        )}&limit=${MAX_AUTHOR_SUGGESTIONS}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 60_000,
    }
  );

  const people = data?.authors ?? [];
  const q = debounced.trim().toLowerCase();
  const fallback: AuthorSuggestion[] =
    people.length === 0 && q
      ? fallbackOptions
          .filter((o) => o.toLowerCase().includes(q))
          .slice(0, MAX_AUTHOR_SUGGESTIONS)
          .map((o) => ({
            name: o,
            family: o,
            given: "",
            n_papers: 0,
            year_min: 0,
            year_max: 0,
            journal: "",
            coauthor: "",
          }))
      : [];

  const suggestions = (people.length > 0 ? people : fallback).filter(
    (a) => !selected.includes(a.name)
  );

  const add = (name: string) => {
    const v = name.trim();
    if (v && !selected.includes(v)) {
      onChange([...selected, v]);
    }
    setQuery("");
    setDebounced("");
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
            add(suggestions[0]?.name ?? query);
          } else if (e.key === "Tab" && suggestions.length > 0) {
            e.preventDefault(); // Tab completes the top suggestion
            add(suggestions[0].name);
          }
        }}
        placeholder="Type a surname — e.g. Zhang"
        value={query}
      />
      {query.trim() && suggestions.length === 0 && !isLoading && (
        <p className="px-1 text-muted-foreground text-xs">No authors match.</p>
      )}
      {suggestions.length > 0 && (
        <ul className="max-h-64 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-sm">
          {suggestions.map((a, i) => (
            <li key={a.name}>
              <button
                className={cn(
                  "flex w-full flex-col gap-0.5 px-2 py-1.5 text-left text-sm hover:bg-accent",
                  i === 0 && "bg-accent/40"
                )}
                // onMouseDown (not onClick) so the input keeps focus and the click
                // registers before any blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(a.name);
                }}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <span className="truncate">{a.name}</span>
                  {i === 0 && (
                    <span className="ml-auto shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                      tab
                    </span>
                  )}
                </span>
                {authorMeta(a) && (
                  <span className="line-clamp-1 text-muted-foreground text-xs">
                    {authorMeta(a)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="px-1 text-[11px] text-muted-foreground">
        Same surname, different people — pick the one you mean.
      </p>
    </div>
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
