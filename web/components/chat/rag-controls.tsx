"use client";

import { Brain, LayersIcon, ListFilterIcon, NetworkIcon } from "lucide-react";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  RETRIEVAL_MODES,
  type RetrievalMode,
} from "@/lib/ai/models";
import type { RagFilters } from "@/lib/aprag/types";
import { cn } from "@/lib/utils";
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
  SelectValue,
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

const REASONING_HINT: Record<ReasoningEffort, string> = {
  minimal: "Fastest",
  low: "A little more careful",
  medium: "More careful",
  high: "Most careful (slowest)",
};

function countActiveFilters(f: RagFilters | null): number {
  if (!f) {
    return 0;
  }
  return Object.values(f).filter(
    (v) => v != null && (Array.isArray(v) ? v.length > 0 : true)
  ).length;
}

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

  const activeFilterCount = countActiveFilters(filters);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-1">
        {/* Chunk-mode toggle: synthesized answer vs raw retrieved chunks. */}
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

        {/* Retrieval mode (LightRAG strategy). */}
        <Select
          onValueChange={(v) => setRetrievalMode(v as RetrievalMode)}
          value={retrievalMode}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger
                className="h-7 gap-1.5 rounded-lg border-0 px-2 text-xs shadow-none hover:bg-accent"
                size="sm"
              >
                <NetworkIcon className="size-3.5" />
                <SelectValue />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent>Retrieval mode</TooltipContent>
          </Tooltip>
          <SelectContent>
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

        {/* Reasoning effort (answer mode only). */}
        <Select
          onValueChange={(v) => setReasoning(v as ReasoningEffort)}
          value={reasoning}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger
                className={cn(
                  "h-7 gap-1.5 rounded-lg border-0 px-2 text-xs shadow-none hover:bg-accent",
                  chunkMode && "pointer-events-none opacity-40"
                )}
                size="sm"
              >
                <Brain className="size-3.5" />
                <SelectValue />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {chunkMode
                ? "Reasoning applies to synthesized answers"
                : "Answer reasoning effort"}
            </TooltipContent>
          </Tooltip>
          <SelectContent>
            {REASONING_EFFORTS.map((r) => (
              <SelectItem key={r} value={r}>
                <span className="capitalize">{r}</span>
                <span className="ml-2 text-muted-foreground text-xs">
                  {REASONING_HINT[r]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Metadata filters (scope retrieval to a paper subset). */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  className={cn(
                    "h-7 gap-1.5 rounded-lg px-2 text-xs",
                    activeFilterCount > 0 && "bg-primary/10 text-primary"
                  )}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ListFilterIcon className="size-3.5" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge
                      className="ml-0.5 h-4 min-w-4 justify-center px-1 text-[10px]"
                      variant="secondary"
                    >
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              Scope retrieval to papers matching metadata
            </TooltipContent>
          </Tooltip>
          <FiltersForm filters={filters} setFilters={setFilters} />
        </Popover>
      </div>
    </TooltipProvider>
  );
}

function FiltersForm({
  filters,
  setFilters,
}: {
  filters: RagFilters | null;
  setFilters: (f: RagFilters | null) => void;
}) {
  const update = (patch: Partial<RagFilters>) => {
    const next: RagFilters = { ...(filters ?? {}), ...patch };
    // Drop empty fields so countActiveFilters stays honest.
    for (const k of Object.keys(next) as (keyof RagFilters)[]) {
      const v = next[k];
      if (v == null || (Array.isArray(v) && v.length === 0) || v === ("" as never)) {
        delete next[k];
      }
    }
    setFilters(Object.keys(next).length > 0 ? next : null);
  };

  const csv = (value: string): string[] | undefined => {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  };

  const num = (value: string): number | undefined => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  return (
    <PopoverContent align="start" className="w-80 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-medium text-sm">Filter papers</p>
        <Button
          className="h-6 px-2 text-muted-foreground text-xs"
          onClick={() => setFilters(null)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear
        </Button>
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor="filter-authors">
          Authors (surnames, comma-separated)
        </Label>
        <Input
          className="h-8 text-sm"
          defaultValue={filters?.authors?.join(", ") ?? ""}
          id="filter-authors"
          onChange={(e) => update({ authors: csv(e.target.value) })}
          placeholder="Westbury, Yanitski"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="filter-year-from">
            Year from
          </Label>
          <Input
            className="h-8 text-sm"
            defaultValue={filters?.year_from ?? ""}
            id="filter-year-from"
            inputMode="numeric"
            onChange={(e) => update({ year_from: num(e.target.value) })}
            placeholder="2015"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="filter-year-to">
            Year to
          </Label>
          <Input
            className="h-8 text-sm"
            defaultValue={filters?.year_to ?? ""}
            id="filter-year-to"
            inputMode="numeric"
            onChange={(e) => update({ year_to: num(e.target.value) })}
            placeholder="2026"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor="filter-journals">
          Journals / venues (comma-separated)
        </Label>
        <Input
          className="h-8 text-sm"
          defaultValue={filters?.journals?.join(", ") ?? ""}
          id="filter-journals"
          onChange={(e) => update({ journals: csv(e.target.value) })}
          placeholder="Cognition"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs" htmlFor="filter-keywords">
          Keywords (comma-separated)
        </Label>
        <Input
          className="h-8 text-sm"
          defaultValue={filters?.keywords?.join(", ") ?? ""}
          id="filter-keywords"
          onChange={(e) => update({ keywords: csv(e.target.value) })}
          placeholder="semantics, humor"
        />
      </div>
    </PopoverContent>
  );
}
