"use client";

import { XIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import useSWR from "swr";
import type { Facets } from "@/lib/aprag/client";
import { fetcher } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

// Distinct filter values (authors/journals/...) for autocomplete, loaded once.
export function useFacets(): Facets {
  const { data } = useSWR<Facets>(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/facets`,
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

// A multi-value filter field: type to autocomplete against `options` (native datalist,
// dynamically narrowed so huge lists stay fast), Enter to add a chip, × to remove.
// Free text is allowed too (so you can filter on a value not in the list).
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
  const listId = useId();
  const [query, setQuery] = useState("");

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? options.filter((o) => o.toLowerCase().includes(q))
      : options;
    return base.slice(0, 30);
  }, [query, options]);

  const add = (value: string) => {
    const v = value.trim();
    if (v && !selected.includes(v)) {
      onChange([...selected, v]);
    }
    setQuery("");
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor={listId}>
        {label}
      </Label>
      <Input
        autoComplete="off"
        className="h-8 text-sm"
        id={listId}
        list={`${listId}-list`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(query);
          }
        }}
        placeholder={placeholder}
        value={query}
      />
      <datalist id={`${listId}-list`}>
        {suggestions.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
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
    </div>
  );
}
