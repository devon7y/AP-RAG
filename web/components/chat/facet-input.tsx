"use client";

import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import type { Facets } from "@/lib/aprag/client";
import { cn, fetcher } from "@/lib/utils";
import { Badge } from "../ui/badge";
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

const MAX_SUGGESTIONS = 8;

// A multi-value filter field: selected values are chips ABOVE the input; typing shows a
// suggestion list (only once you start typing). Click a suggestion or press Tab to add
// the top match; Enter adds the top match (or your free text). × removes a chip.
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

      {/* Selected chips ABOVE the input so suggestions never cover them. */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((s) => (
            <Badge
              className="gap-1 pr-1 font-normal"
              key={s}
              variant="secondary"
            >
              {s}
              <button
                aria-label={`Remove ${s}`}
                className="rounded-sm hover:text-foreground"
                onClick={() => onChange(selected.filter((x) => x !== s))}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

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
