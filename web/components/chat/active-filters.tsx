"use client";

import { XIcon } from "lucide-react";
import { useActiveChat } from "@/hooks/use-active-chat";
import { type FilterListKey, FILTER_LIST_KEYS } from "@/lib/aprag/filters";
import type { RagFilters } from "@/lib/aprag/types";
import { Badge } from "../ui/badge";

const LABEL: Record<FilterListKey, string> = {
  papers: "Paper",
  authors: "Author",
  journals: "Journal",
  subjects: "Subject",
  keywords: "Keyword",
  affiliations: "Affiliation",
};

// Paper filter values are filenames; chips read better without the extension.
export function filterValueLabel(key: FilterListKey, value: string): string {
  return key === "papers" ? value.replace(/\.pdf$/i, "") : value;
}

// The active metadata filters (manual + LLM-inferred) as removable chips, shown above the
// composer input so it's clear what retrieval is scoped to.
export function ActiveFilters() {
  const { filters, setFilters } = useActiveChat();
  if (!filters) {
    return null;
  }

  const removeValue = (key: FilterListKey, value: string) =>
    setFilters((prev) => {
      if (!prev) {
        return prev;
      }
      const next: RagFilters = { ...prev };
      const arr = (next[key] ?? []).filter((v) => v !== value);
      if (arr.length > 0) {
        next[key] = arr;
      } else {
        delete next[key];
      }
      return Object.keys(next).length > 0 ? next : null;
    });

  const removeYears = () =>
    setFilters((prev) => {
      if (!prev) {
        return prev;
      }
      const next: RagFilters = { ...prev };
      next.year = undefined;
      next.year_from = undefined;
      next.year_to = undefined;
      const cleaned = Object.fromEntries(
        Object.entries(next).filter(([, v]) => v != null)
      ) as RagFilters;
      return Object.keys(cleaned).length > 0 ? cleaned : null;
    });

  const removeYear = (year: number) =>
    setFilters((prev) => {
      if (!prev) {
        return prev;
      }
      const next: RagFilters = { ...prev };
      const arr = (next.years ?? []).filter((y) => y !== year);
      if (arr.length > 0) {
        next.years = arr;
      } else {
        delete next.years;
      }
      return Object.keys(next).length > 0 ? next : null;
    });

  const chips: { id: string; label: string; onRemove: () => void }[] = [];
  for (const key of FILTER_LIST_KEYS) {
    for (const v of filters[key] ?? []) {
      chips.push({
        id: `${key}-${v}`,
        label: `${LABEL[key]}: ${filterValueLabel(key, v)}`,
        onRemove: () => removeValue(key, v),
      });
    }
  }
  for (const y of filters.years ?? []) {
    chips.push({
      id: `year-${y}`,
      label: `Year: ${y}`,
      onRemove: () => removeYear(y),
    });
  }
  if (filters.year != null) {
    chips.push({
      id: "year",
      label: `Year: ${filters.year}`,
      onRemove: removeYears,
    });
  } else if (filters.year_from != null || filters.year_to != null) {
    chips.push({
      id: "year-range",
      label: `Year: ${filters.year_from ?? "…"}–${filters.year_to ?? "…"}`,
      onRemove: removeYears,
    });
  }

  if (chips.length === 0) {
    return null;
  }

  // Just the chips — the composer renders these in the SAME row as the auto-detected
  // (pending) filter chips, so manual and natural-language filters share one display.
  return (
    <>
      {chips.map((c) => (
        <Badge className="gap-1 pr-1 font-normal" key={c.id} variant="secondary">
          {c.label}
          <button
            aria-label={`Remove ${c.label}`}
            className="rounded-sm hover:text-foreground"
            onClick={c.onRemove}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
    </>
  );
}
