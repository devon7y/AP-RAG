"use client";

import { Brain, LayersIcon, NetworkIcon } from "lucide-react";
import { useState } from "react";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  RETRIEVAL_MODES,
  type RetrievalMode,
} from "@/lib/ai/models";
import type { Facets } from "@/lib/aprag/client";
import type { RagFilters } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
import { FacetInput, useFacets } from "./facet-input";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const MODE_HINT: Record<RetrievalMode, string> = {
  hybrid: "Graph + vector (recommended)",
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
const FACET_FILTERS: { key: keyof RagFilters & keyof Facets; label: string }[] = [
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
    chunkMode,
    setChunkMode,
    filters,
    setFilters,
  } = useActiveChat();

  // Facets (autocomplete options) are large, so only load them once the user opens a
  // filter for the first time.
  const [facetsEnabled, setFacetsEnabled] = useState(false);
  const facets = useFacets(facetsEnabled);

  const setList = (key: keyof Facets) => (next: string[]) =>
    setFilters((prev) => {
      const merged: RagFilters = { ...(prev ?? {}) };
      if (next.length > 0) {
        merged[key] = next;
      } else {
        delete merged[key];
      }
      return Object.keys(merged).length > 0 ? merged : null;
    });

  const yearActive = filters?.year_from != null || filters?.year_to != null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-wrap items-center gap-1">
        {/* Answer vs raw chunks */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className={cn(
                "h-7 gap-1.5 rounded-lg px-2 text-xs",
                chunkMode && "bg-primary/10 text-primary"
              )}
              onClick={() => setChunkMode((v) => !v)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <LayersIcon className="size-3.5" />
              {chunkMode ? "Chunks" : "Answer"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {chunkMode
              ? "Showing raw retrieved chunks (no LLM). Click for synthesized answers."
              : "Showing synthesized answers. Click to show raw retrieved chunks."}
          </TooltipContent>
        </Tooltip>

        {/* Retrieval mode — short label in the trigger, hint in the menu */}
        <Select
          onValueChange={(v) => setRetrievalMode(v as RetrievalMode)}
          value={retrievalMode}
        >
          <SelectTrigger
            className="h-7 gap-1.5 rounded-lg border-0 px-2 text-xs capitalize shadow-none hover:bg-accent"
            size="sm"
          >
            <NetworkIcon className="size-3.5" />
            {retrievalMode}
          </SelectTrigger>
          <SelectContent align="start" position="popper">
            {RETRIEVAL_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                <span className="capitalize">{m}</span>
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
            className={cn(
              "h-7 gap-1.5 rounded-lg border-0 px-2 text-xs shadow-none hover:bg-accent",
              chunkMode && "pointer-events-none opacity-40"
            )}
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

        {/* Individual metadata filters, inline */}
        {FACET_FILTERS.map((f) => (
          <FacetFilterButton
            key={f.key}
            label={f.label}
            onChange={setList(f.key)}
            onOpen={() => setFacetsEnabled(true)}
            options={facets[f.key]}
            selected={filters?.[f.key] ?? []}
          />
        ))}

        <YearFilterButton active={yearActive} filters={filters} setFilters={setFilters} />
      </div>
    </TooltipProvider>
  );
}

function FacetFilterButton({
  label,
  options,
  selected,
  onChange,
  onOpen,
}: {
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
            selected.length > 0 && "bg-primary/10 text-primary"
          )}
          size="sm"
          type="button"
          variant="ghost"
        >
          {label}
          {selected.length > 0 && (
            <Badge
              className="ml-0.5 h-4 min-w-4 justify-center px-1 text-[10px]"
              variant="secondary"
            >
              {selected.length}
            </Badge>
          )}
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
            active && "bg-primary/10 text-primary"
          )}
          size="sm"
          type="button"
          variant="ghost"
        >
          Year
          {active && (
            <Badge
              className="ml-0.5 h-4 justify-center px-1 text-[10px]"
              variant="secondary"
            >
              {filters?.year_from ?? "…"}–{filters?.year_to ?? "…"}
            </Badge>
          )}
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
