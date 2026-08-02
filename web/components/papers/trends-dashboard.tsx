"use client";

import { CalendarClockIcon, TrendingUpIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import type { TrendsData, TrendTerm } from "@/lib/aprag/client";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import {
  MAX_TREND_SERIES,
  SERIES_SLOTS,
  type TrendSeries,
  TrendLinesChart,
  YearBarChart,
  type YearCount,
} from "./charts";
import { paperFetcher } from "./lib";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const DIMENSIONS = [
  { key: "keywords", label: "Keywords", papersParam: "keywords" },
  { key: "subjects", label: "Subjects", papersParam: "subjects" },
  { key: "journals", label: "Journals", papersParam: "journals" },
  { key: "authors", label: "Authors", papersParam: "authors" },
] as const;

type DimKey = (typeof DIMENSIONS)[number]["key"];

type Selected = { term: string; slot: number };

function countsToPoints(t: TrendTerm): YearCount[] {
  return Object.entries(t.counts)
    .map(([year, count]) => ({ year: Number(year), count }))
    .sort((a, b) => a.year - b.year);
}

// The Research Trends dashboard: corpus output over time, topic trajectories for
// user-picked terms, and rising/fading threads — every mark clicking through to the
// Paper Database (or an author page) and into a Research Digest.
export function TrendsDashboard() {
  const router = useRouter();
  const { data, error, isLoading } = useSWR<TrendsData>(
    `${BASE}/api/trends`,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  const [dim, setDim] = useState<DimKey>("keywords");
  // Per-dimension selections; slots stick to the term (color follows the entity —
  // removing a series never repaints the survivors).
  const [selectedByDim, setSelectedByDim] = useState<
    Record<DimKey, Selected[]>
  >({ keywords: [], subjects: [], journals: [], authors: [] });
  const [mode, setMode] = useState<"count" | "share">("count");
  const [query, setQuery] = useState("");

  // First data arrival: preselect the top 3 keywords so the page opens alive.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !data) {
      return;
    }
    setSeeded(true);
    setSelectedByDim((prev) => ({
      ...prev,
      keywords: data.keywords
        .slice(0, 3)
        .map((t, i) => ({ term: t.term, slot: i })),
    }));
  }, [data, seeded]);

  const terms: TrendTerm[] = data?.[dim] ?? [];
  const byTerm = useMemo(
    () => new Map(terms.map((t) => [t.term.toLowerCase(), t])),
    [terms]
  );
  const selected = selectedByDim[dim];

  const addTerm = (term: string) => {
    setSelectedByDim((prev) => {
      const cur = prev[dim];
      if (
        cur.length >= MAX_TREND_SERIES ||
        cur.some((s) => s.term.toLowerCase() === term.toLowerCase())
      ) {
        return prev;
      }
      const used = new Set(cur.map((s) => s.slot));
      let slot = 0;
      while (used.has(slot)) {
        slot++;
      }
      return { ...prev, [dim]: [...cur, { term, slot }] };
    });
    setQuery("");
  };

  const removeTerm = (term: string) =>
    setSelectedByDim((prev) => ({
      ...prev,
      [dim]: prev[dim].filter((s) => s.term !== term),
    }));

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }
    return terms
      .filter(
        (t) =>
          t.term.toLowerCase().includes(q) &&
          !selected.some((s) => s.term.toLowerCase() === t.term.toLowerCase())
      )
      .slice(0, 8);
  }, [query, terms, selected]);

  // Corpus output series + share denominators.
  const corpusYears: YearCount[] = useMemo(
    () =>
      Object.entries(data?.years ?? {})
        .map(([year, count]) => ({ year: Number(year), count }))
        .sort((a, b) => a.year - b.year),
    [data]
  );
  const totalPapers = useMemo(
    () => corpusYears.reduce((acc, d) => acc + d.count, 0),
    [corpusYears]
  );

  const series: TrendSeries[] = useMemo(
    () =>
      selected
        .map((s) => {
          const t = byTerm.get(s.term.toLowerCase());
          if (!t) {
            return null;
          }
          let points = countsToPoints(t);
          if (mode === "share") {
            const totals = data?.years ?? {};
            points = points.map((p) => ({
              year: p.year,
              count:
                Number(totals[String(p.year)]) > 0
                  ? Math.round((p.count / Number(totals[String(p.year)])) * 1000) / 10
                  : 0,
            }));
          }
          return { label: t.term, slot: s.slot, points };
        })
        .filter((s): s is TrendSeries => s !== null),
    [selected, byTerm, mode, data]
  );

  // Rising / fading: the last decade's share of corpus output vs the decade before.
  const risingFading = useMemo(() => {
    if (!data || corpusYears.length === 0) {
      return { rising: [], fading: [], recent: [0, 0], base: [0, 0] };
    }
    const maxYear = corpusYears.at(-1)!.year;
    const recent: [number, number] = [maxYear - 9, maxYear];
    const base: [number, number] = [maxYear - 19, maxYear - 10];
    const windowTotal = (a: number, b: number) =>
      corpusYears
        .filter((d) => d.year >= a && d.year <= b)
        .reduce((acc, d) => acc + d.count, 0);
    const corpusRecent = Math.max(1, windowTotal(...recent));
    const corpusBase = Math.max(1, windowTotal(...base));

    const scored = terms
      .filter((t) => t.total >= 8)
      .map((t) => {
        const inWindow = (a: number, b: number) =>
          Object.entries(t.counts).reduce(
            (acc, [y, n]) => (Number(y) >= a && Number(y) <= b ? acc + n : acc),
            0
          );
        const r = inWindow(...recent);
        const b = inWindow(...base);
        return { term: t.term, r, b, delta: r / corpusRecent - b / corpusBase };
      });
    return {
      rising: scored
        .filter((s) => s.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 6),
      fading: scored
        .filter((s) => s.delta < 0)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, 6),
      recent,
      base,
    };
  }, [data, terms, corpusYears]);

  const dimDef = DIMENSIONS.find((d) => d.key === dim)!;
  const termHref = (term: string) =>
    dim === "authors"
      ? `/authors/${encodeURIComponent(term)}`
      : `/papers?${new URLSearchParams([[dimDef.papersParam, term]]).toString()}`;

  const digestTopic = selected.map((s) => s.term).join(", ");

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-background">
      <header className="flex items-center gap-2 px-3 py-2 md:px-4">
        <SidebarToggle />
        <TrendingUpIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">Research Trends</h1>
        {totalPapers > 0 && (
          <span className="text-muted-foreground text-xs">
            {totalPapers.toLocaleString()} dated papers ·{" "}
            {corpusYears[0]?.year}–{corpusYears.at(-1)?.year}
          </span>
        )}
      </header>

      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 pb-10">
        {isLoading && (
          <div className="space-y-3 pt-2">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-44 w-full" />
          </div>
        )}
        {error && (
          <p className="pt-2 text-muted-foreground text-sm">
            Trends unavailable — the backend may be offline. Retry in a moment.
          </p>
        )}

        {data && (
          <>
            <section>
              <h2 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Corpus output per year
              </h2>
              <p className="mb-2 text-muted-foreground text-xs">
                Click a year to open it in the Paper Database.
              </p>
              <YearBarChart
                data={corpusYears}
                height={180}
                onYearClick={(year) =>
                  router.push(
                    `${BASE}/papers?year_from=${year}&year_to=${year}`
                  )
                }
              />
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Topic trends
                </h2>
                <div className="flex overflow-hidden rounded-lg border border-border">
                  {DIMENSIONS.map((d) => (
                    <button
                      className={cn(
                        "px-2.5 py-1 text-xs transition-colors",
                        dim === d.key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent"
                      )}
                      key={d.key}
                      onClick={() => {
                        setDim(d.key);
                        setQuery("");
                      }}
                      type="button"
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex overflow-hidden rounded-lg border border-border">
                  {(["count", "share"] as const).map((m) => (
                    <button
                      className={cn(
                        "px-2.5 py-1 text-xs transition-colors",
                        mode === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent"
                      )}
                      key={m}
                      onClick={() => setMode(m)}
                      title={
                        m === "share"
                          ? "Percent of that year's papers"
                          : "Papers per year"
                      }
                      type="button"
                    >
                      {m === "count" ? "Papers" : "% of year"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative mb-2 max-w-md">
                <Input
                  autoComplete="off"
                  className="h-8 text-sm"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && suggestions[0]) {
                      e.preventDefault();
                      addTerm(suggestions[0].term);
                    }
                  }}
                  placeholder={`Add a ${dimDef.label.toLowerCase().replace(/s$/, "")} to compare… (${selected.length}/${MAX_TREND_SERIES})`}
                  value={query}
                />
                {suggestions.length > 0 && (
                  <ul className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover py-1 shadow-md">
                    {suggestions.map((t) => (
                      <li key={t.term}>
                        <button
                          className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            addTerm(t.term);
                          }}
                          type="button"
                        >
                          <span className="truncate">{t.term}</span>
                          <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                            {t.total.toLocaleString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* The legend: interactive chips keyed by the series color. */}
              {selected.length > 0 && (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {selected.map((s) => (
                    <Badge
                      className="gap-1.5 pr-1 font-normal"
                      key={s.term}
                      variant="secondary"
                    >
                      <span
                        className={cn(
                          "h-0.5 w-3 shrink-0 rounded-full",
                          SERIES_SLOTS[s.slot % SERIES_SLOTS.length].bg
                        )}
                      />
                      <Link
                        className="max-w-52 truncate hover:underline"
                        href={termHref(s.term)}
                        title={
                          dim === "authors"
                            ? `${s.term}'s author page`
                            : `Open in Paper Database`
                        }
                      >
                        {s.term}
                      </Link>
                      <button
                        aria-label={`Remove ${s.term}`}
                        className="rounded-sm hover:text-foreground"
                        onClick={() => removeTerm(s.term)}
                        type="button"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </Badge>
                  ))}
                  {digestTopic &&
                    (dim === "keywords" || dim === "subjects") && (
                      <Button
                        asChild
                        className="h-6 gap-1.5 px-2 text-xs"
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Link
                          href={`/digest?topic=${encodeURIComponent(digestTopic)}`}
                        >
                          <CalendarClockIcon className="size-3" />
                          Write a Research Digest
                        </Link>
                      </Button>
                    )}
                </div>
              )}

              {series.length > 0 ? (
                <TrendLinesChart
                  series={series}
                  valueSuffix={mode === "share" ? "%" : ""}
                />
              ) : (
                <p className="rounded-lg border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
                  Add a {dimDef.label.toLowerCase().replace(/s$/, "")} above to
                  chart its trajectory.
                </p>
              )}
            </section>

            <section className="grid gap-6 sm:grid-cols-2">
              {(
                [
                  { title: "Rising", items: risingFading.rising, glyph: "▲" },
                  { title: "Fading", items: risingFading.fading, glyph: "▼" },
                ] as const
              ).map((col) => (
                <div key={col.title}>
                  <h2 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    {col.title} {dimDef.label.toLowerCase()}
                  </h2>
                  <p className="mb-1.5 text-muted-foreground text-xs">
                    {risingFading.base[0]}–{risingFading.base[1]} vs{" "}
                    {risingFading.recent[0]}–{risingFading.recent[1]} (share of
                    corpus output). Click to chart.
                  </p>
                  <ul className="space-y-0.5">
                    {col.items.map((t) => (
                      <li key={t.term}>
                        <button
                          className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent"
                          onClick={() => addTerm(t.term)}
                          type="button"
                        >
                          <span aria-hidden className="text-muted-foreground text-xs">
                            {col.glyph}
                          </span>
                          <span className="min-w-0 truncate">{t.term}</span>
                          <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                            {t.b} → {t.r}
                          </span>
                        </button>
                      </li>
                    ))}
                    {col.items.length === 0 && (
                      <li className="px-2 py-1 text-muted-foreground text-xs">
                        Nothing notable in this window.
                      </li>
                    )}
                  </ul>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
