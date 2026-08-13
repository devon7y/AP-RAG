"use client";

// The Research Trends dashboard.
//
// Two properties of this corpus shape almost every decision here, and both make the
// obvious version of the page misleading:
//
// 1. It is a library, not a census. Collected output peaks in the 2000s and falls
//    after (3,387 papers in the 2000s, 2,717 in the 2010s, 1,325 so far in the
//    2020s), so raw counts make *every* term look like it is dying. Share of that
//    year's collected output is therefore the default mode, raw counts are labelled
//    as collection-biased, and the OpenAlex world baseline is overlaid where we have
//    it so a corpus trend can be checked against the field.
//
// 2. Keyword vocabulary is uncontrolled — 16.6k distinct keywords, 72% appearing
//    exactly once. Subjects behave far better, and the semantic regions (clustered
//    from chunk embeddings, so no keyword is involved) sidestep the problem
//    entirely. All three are offered as dimensions.

import {
  CalendarClockIcon,
  SparklesIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { PageHeader } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import type { TrendDim, TrendsData, TrendTerm } from "@/lib/aprag/client";
import {
  type CitationsData,
  type ClusterTrendsData,
  loadStatic,
} from "@/lib/aprag/trends-static";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import {
  MAX_TREND_SERIES,
  SERIES_SLOTS,
  StackedAreaChart,
  smoothYears,
  TrendLinesChart,
  type TrendSeries,
  YearBarChart,
  type YearCount,
} from "./charts";
import { paperFetcher } from "./lib";
import { CitationsPanels } from "./trends-citations";
import {
  Bursts,
  Frontier,
  LeadLag,
  Newcomers,
  RisingFading,
  SectionTitle,
  SparklineGrid,
  StatTiles,
  TermDetail,
} from "./trends-panels";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// `regions` is not a manifest dimension — it comes from the static cluster payload —
// but it behaves identically once loaded, so it sits in the same picker.
const DIMENSIONS = [
  { key: "subjects", label: "Subjects", papersParam: "subjects" },
  { key: "keywords", label: "Keywords", papersParam: "keywords" },
  { key: "regions", label: "Regions", papersParam: "" },
  { key: "journals", label: "Journals", papersParam: "journals" },
  { key: "authors", label: "Authors", papersParam: "authors" },
  { key: "affiliations", label: "Affiliations", papersParam: "affiliations" },
  { key: "types", label: "Type", papersParam: "" },
] as const;

type DimKey = (typeof DIMENSIONS)[number]["key"];

// Everything before 1960 is 135 papers across 140 years. Charting from the true
// minimum spends most of the width on an empty century.
const DEFAULT_MIN_YEAR = 1960;

type Selected = { term: string; slot: number };

const EMPTY_SELECTION: Record<DimKey, Selected[]> = {
  subjects: [],
  keywords: [],
  regions: [],
  journals: [],
  authors: [],
  affiliations: [],
  types: [],
};

function countsToPoints(counts: Record<string, number>): YearCount[] {
  return Object.entries(counts)
    .map(([year, count]) => ({ year: Number(year), count }))
    .sort((a, b) => a.year - b.year);
}

export function TrendsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, error, isLoading } = useSWR<TrendsData>(
    `${BASE}/api/trends`,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  // The two precomputed layers. Optional build products: when either is missing its
  // sections simply do not render.
  const [clusters, setClusters] = useState<ClusterTrendsData | null>(null);
  const [citations, setCitations] = useState<CitationsData | null>(null);
  useEffect(() => {
    loadStatic<ClusterTrendsData>(`${BASE}/data/cluster_trends.json`).then(
      setClusters
    );
    loadStatic<CitationsData>(`${BASE}/data/citations.json`).then(setCitations);
  }, []);

  // ── State, seeded from the URL so a chart you found can be sent to someone.
  const [dim, setDim] = useState<DimKey>(
    () => (searchParams.get("dim") as DimKey) || "subjects"
  );
  const [selectedByDim, setSelectedByDim] =
    useState<Record<DimKey, Selected[]>>(EMPTY_SELECTION);
  const [mode, setMode] = useState<"count" | "share">(() =>
    searchParams.get("mode") === "count" ? "count" : "share"
  );
  const [smooth, setSmooth] = useState(
    () => searchParams.get("smooth") !== "0"
  );
  const [showAllYears, setShowAllYears] = useState(
    () => searchParams.get("all") === "1"
  );
  const [query, setQuery] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [corpusSummary, setCorpusSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);

  const terms: TrendTerm[] = useMemo(() => {
    if (dim === "regions") {
      return (clusters?.clusters ?? []) as unknown as TrendTerm[];
    }
    return (data?.[dim as TrendDim] ?? []) as TrendTerm[];
  }, [dim, data, clusters]);

  const byTerm = useMemo(
    () => new Map(terms.map((t) => [t.term.toLowerCase(), t])),
    [terms]
  );
  const selected = selectedByDim[dim];

  // First data arrival: seed from ?terms= if present, else the top three, so the
  // page opens with something on it.
  useEffect(() => {
    if (seeded || terms.length === 0) {
      return;
    }
    setSeeded(true);
    const fromUrl = (searchParams.get("terms") ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    const picks =
      fromUrl.length > 0 ? fromUrl : terms.slice(0, 3).map((t) => t.term);
    setSelectedByDim((prev) => ({
      ...prev,
      [dim]: picks
        .slice(0, MAX_TREND_SERIES)
        .map((term, i) => ({ term, slot: i })),
    }));
  }, [terms, seeded, dim, searchParams]);

  // Mirror state into the URL (replace, so it never floods history).
  useEffect(() => {
    if (!seeded) {
      return;
    }
    const sp = new URLSearchParams();
    sp.set("dim", dim);
    if (selected.length > 0) {
      sp.set("terms", selected.map((s) => s.term).join("|"));
    }
    if (mode === "count") {
      sp.set("mode", "count");
    }
    if (!smooth) {
      sp.set("smooth", "0");
    }
    if (showAllYears) {
      sp.set("all", "1");
    }
    window.history.replaceState(null, "", `${BASE}/trends?${sp.toString()}`);
  }, [dim, selected, mode, smooth, showAllYears, seeded]);

  const addTerm = useCallback(
    (term: string) => {
      setSelectedByDim((prev) => {
        const cur = prev[dim];
        if (cur.some((s) => s.term.toLowerCase() === term.toLowerCase())) {
          return prev;
        }
        const used = new Set(cur.map((s) => s.slot));
        let slot = 0;
        while (used.has(slot)) {
          slot++;
        }
        // At the cap, the oldest selection makes way rather than the click being
        // silently ignored — a dead-feeling button is worse than a rotation.
        const next =
          cur.length >= MAX_TREND_SERIES
            ? [...cur.slice(1), { term, slot: cur[0].slot }]
            : [...cur, { term, slot }];
        return { ...prev, [dim]: next };
      });
      setQuery("");
    },
    [dim]
  );

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

  // ── Corpus output.
  const corpusYears: YearCount[] = useMemo(
    () =>
      Object.entries(data?.years ?? {})
        .map(([year, count]) => ({ year: Number(year), count }))
        .sort((a, b) => a.year - b.year),
    [data]
  );
  const yearTotals = useMemo(
    () => new Map(corpusYears.map((d) => [d.year, d.count])),
    [corpusYears]
  );
  const minYear = showAllYears ? Number.NEGATIVE_INFINITY : DEFAULT_MIN_YEAR;
  const visibleYears = useMemo(
    () => corpusYears.filter((d) => d.year >= minYear),
    [corpusYears, minYear]
  );
  const totalPapers = data?.totals?.dated ?? 0;
  const hiddenBefore = corpusYears.length - visibleYears.length;
  const hiddenPapers = useMemo(
    () =>
      corpusYears
        .filter((d) => d.year < minYear)
        .reduce((acc, d) => acc + d.count, 0),
    [corpusYears, minYear]
  );

  const windows = data?.windows ?? {
    base: [0, 0] as [number, number],
    recent: [0, 0] as [number, number],
  };

  // ── Charted series.
  const series: TrendSeries[] = useMemo(
    () =>
      selected
        .map((s) => {
          const t = byTerm.get(s.term.toLowerCase());
          if (!t) {
            return null;
          }
          let points = countsToPoints(t.counts).filter(
            (p) => p.year >= minYear
          );
          if (mode === "share") {
            points = points.map((p) => {
              const total = yearTotals.get(p.year) ?? 0;
              return {
                year: p.year,
                count:
                  total > 0 ? Math.round((p.count / total) * 1000) / 10 : 0,
              };
            });
          }
          if (smooth) {
            points = smoothYears(points, 3).map((p) => ({
              year: p.year,
              count: Math.round(p.count * 10) / 10,
            }));
          }
          return { label: t.term, slot: s.slot, points };
        })
        .filter((s): s is TrendSeries => s !== null),
    [selected, byTerm, mode, yearTotals, smooth, minYear]
  );

  // The world baseline for a charted term, where OpenAlex has one. This is the only
  // thing on the page that can distinguish a real trend from a collection artifact.
  const baselineFor = useCallback(
    (term: string) => citations?.baseline?.[term.toLowerCase()] ?? null,
    [citations]
  );
  const baselineSeries: TrendSeries[] = useMemo(() => {
    if (!citations) {
      return [];
    }
    return selected
      .map((s) => {
        const curve = baselineFor(s.term);
        if (!curve) {
          return null;
        }
        const points = Object.entries(curve)
          .map(([year, count]) => ({ year: Number(year), count }))
          .filter((p) => p.year >= Math.max(minYear, 1960))
          .sort((a, b) => a.year - b.year);
        return points.length > 4
          ? { label: `${s.term} (world)`, slot: s.slot, points }
          : null;
      })
      .filter((s): s is TrendSeries => s !== null);
  }, [selected, baselineFor, citations, minYear]);

  // ── Composition: the top terms of the dimension as shares of each year.
  const compositionBands = useMemo(() => {
    const top = terms.slice(0, 6);
    return top.map((t) => ({
      label: t.term,
      points: countsToPoints(t.counts),
    }));
  }, [terms]);

  // ── Rising / fading, straight from the server's share deltas.
  const scored = useMemo(
    () => terms.filter((t) => t.delta !== undefined && t.total >= 8),
    [terms]
  );
  const rising = useMemo(
    () =>
      [...scored]
        .filter((t) => (t.delta ?? 0) > 0)
        .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
        .slice(0, 8),
    [scored]
  );
  const fading = useMemo(
    () =>
      [...scored]
        .filter((t) => (t.delta ?? 0) < 0)
        .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
        .slice(0, 8),
    [scored]
  );

  const dimDef = DIMENSIONS.find((d) => d.key === dim) ?? DIMENSIONS[0];
  const isManifestDim = dim !== "regions";
  const termHref = (term: string) => {
    if (dim === "authors") {
      return `${BASE}/authors/${encodeURIComponent(term)}`;
    }
    if (!dimDef.papersParam) {
      return `${BASE}/papers`;
    }
    return `${BASE}/papers?${new URLSearchParams([[dimDef.papersParam, term]]).toString()}`;
  };

  const digestTopic = selected.map((s) => s.term).join(", ");
  const focusTerm = selected.at(-1)?.term ?? null;

  const runCorpusSummary = async () => {
    setSummarising(true);
    try {
      const res = await fetch(`${BASE}/api/trend-explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "corpus",
          rising: rising.map((t) => ({ term: t.term, delta: t.delta })),
          fading: fading.map((t) => ({ term: t.term, delta: t.delta })),
          newcomers: data?.newcomers?.[dim as TrendDim] ?? [],
          bursts: data?.bursts?.[dim as TrendDim] ?? [],
          windows,
          span: [corpusYears[0]?.year ?? 0, corpusYears.at(-1)?.year ?? 0],
          totalPapers,
        }),
      });
      const json = await res.json();
      setCorpusSummary(json.text ?? "Summary unavailable.");
    } catch {
      setCorpusSummary("Summary unavailable.");
    } finally {
      setSummarising(false);
    }
  };

  const statTiles = useMemo(() => {
    if (!data) {
      return [];
    }
    const peak = corpusYears.reduce(
      (best, d) => (d.count > best.count ? d : best),
      { year: 0, count: 0 }
    );
    const tiles = [
      {
        label: "dated papers",
        value: totalPapers.toLocaleString(),
        hint: `${data.totals?.undated ?? 0} undated records are excluded from every chart`,
      },
      {
        label: "span",
        value: `${corpusYears[0]?.year ?? "—"}–${corpusYears.at(-1)?.year ?? "—"}`,
      },
      {
        label: `peak year (${peak.count} papers)`,
        value: String(peak.year || "—"),
        hint: "Collection volume, not field volume",
      },
      {
        label: `distinct ${dimDef.label.toLowerCase()}`,
        value: (
          data.totals?.dims?.[dim] ??
          (dim === "regions" ? clusters?.totals.regions : undefined) ??
          terms.length
        ).toLocaleString(),
      },
    ];
    if (citations) {
      tiles.push({
        label: "citations to this corpus",
        value: `${(citations.coverage.totalCitations / 1e6).toFixed(1)}M`,
        hint: `${citations.coverage.matched.toLocaleString()} papers matched in OpenAlex`,
      });
    }
    return tiles.slice(0, 4);
  }, [data, corpusYears, totalPapers, dim, dimDef, terms, citations, clusters]);

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-background">
      <PageHeader>
        <SidebarToggle />
        <TrendingUpIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">Research Trends</h1>
        {totalPapers > 0 && (
          <span className="text-muted-foreground text-xs">
            {totalPapers.toLocaleString()} dated papers · {corpusYears[0]?.year}
            –{corpusYears.at(-1)?.year}
          </span>
        )}
      </PageHeader>

      <div className="mx-auto w-full max-w-5xl space-y-9 px-4 pb-16">
        {isLoading && (
          <div className="space-y-3 pt-2">
            <Skeleton className="h-16 w-full" />
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
            <StatTiles tiles={statTiles} />

            {/* The caveat that governs every number below. */}
            <div className="rounded-lg border border-border border-dashed px-3 py-2 text-muted-foreground text-xs">
              This is one lab's library, not a census of the literature.
              Collected output peaks in{" "}
              {
                corpusYears.reduce((b, d) => (d.count > b.count ? d : b), {
                  year: 0,
                  count: 0,
                }).year
              }{" "}
              and falls after, so raw counts understate anything recent —
              comparisons default to each term's{" "}
              <strong>share of that year's collected papers</strong>.
              {citations
                ? " Where OpenAlex has a matching term, the world-wide curve is available as an overlay."
                : ""}
            </div>

            <section className="flex flex-wrap items-start gap-3">
              <Button
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={summarising}
                onClick={runCorpusSummary}
                size="sm"
                type="button"
                variant="outline"
              >
                <SparklesIcon className="size-3" />
                {summarising ? "Reading…" : "Summarise the corpus"}
              </Button>
              {corpusSummary && (
                <p className="min-w-64 flex-1 rounded-md bg-muted/50 px-3 py-2 text-[13px] leading-relaxed">
                  {corpusSummary}
                </p>
              )}
            </section>

            <section>
              <SectionTitle
                hint={
                  <>
                    Click a year to open it in the Paper Database.
                    {hiddenBefore > 0 && (
                      <>
                        {" "}
                        {hiddenPapers} papers before {DEFAULT_MIN_YEAR} are
                        hidden.{" "}
                        <button
                          className="underline hover:text-foreground"
                          onClick={() => setShowAllYears(true)}
                          type="button"
                        >
                          Show all years
                        </button>
                      </>
                    )}
                    {showAllYears && (
                      <>
                        {" "}
                        <button
                          className="underline hover:text-foreground"
                          onClick={() => setShowAllYears(false)}
                          type="button"
                        >
                          Back to {DEFAULT_MIN_YEAR}+
                        </button>
                      </>
                    )}
                    {data.partialFrom && (
                      <> {data.partialFrom} is still being collected.</>
                    )}
                  </>
                }
              >
                Corpus output per year
              </SectionTitle>
              <YearBarChart
                data={visibleYears}
                height={180}
                onYearClick={(year) =>
                  router.push(
                    `${BASE}/papers?year_from=${year}&year_to=${year}`
                  )
                }
              />
            </section>

            {/* ── Topic trends ─────────────────────────────────────────────── */}
            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Topic trends
                </h2>
                <div className="flex flex-wrap overflow-hidden rounded-lg border border-border">
                  {DIMENSIONS.filter(
                    (d) => d.key !== "regions" || clusters !== null
                  ).map((d) => (
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
                      title={
                        d.key === "regions"
                          ? "Topic regions clustered from chunk embeddings — no keyword involved, so every paper is covered"
                          : undefined
                      }
                      type="button"
                    >
                      {d.label}
                    </button>
                  ))}
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    className={cn(
                      "rounded-lg border border-border px-2 py-1 text-xs transition-colors",
                      smooth
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    )}
                    onClick={() => setSmooth((s) => !s)}
                    title="3-year rolling mean. At ~200 papers a year, single-year counts for one term are mostly noise."
                    type="button"
                  >
                    Smooth
                  </button>
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    {(["share", "count"] as const).map((m) => (
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
                            ? "Percent of that year's collected papers — corrects for the collection's own volume"
                            : "Raw papers per year. Collection-biased: the corpus itself shrinks after the 2000s."
                        }
                        type="button"
                      >
                        {m === "share" ? "% of year" : "Raw count"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {mode === "count" && (
                <p className="mb-2 text-muted-foreground text-xs">
                  Raw counts follow the collection's own volume, which peaks in
                  the 2000s. Use % of year to compare eras.
                </p>
              )}

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
                      {isManifestDim ? (
                        <Link
                          className="max-w-52 truncate hover:underline"
                          href={termHref(s.term)}
                          title={
                            dim === "authors"
                              ? `${s.term}'s author page`
                              : "Open in Paper Database"
                          }
                        >
                          {s.term}
                        </Link>
                      ) : (
                        <span className="max-w-52 truncate">{s.term}</span>
                      )}
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
                          href={`${BASE}/digest?topic=${encodeURIComponent(digestTopic)}`}
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
                  Pick a {dimDef.label.toLowerCase().replace(/s$/, "")} above,
                  or click one of the trajectories below.
                </p>
              )}

              {/* Per-term facts the line alone does not carry. */}
              {selected.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground text-xs">
                  {selected.map((s) => {
                    const t = byTerm.get(s.term.toLowerCase());
                    if (!t?.stats) {
                      return null;
                    }
                    return (
                      <span key={s.term}>
                        <span
                          className={cn(
                            "mr-1.5 inline-block h-0.5 w-3 rounded-full align-middle",
                            SERIES_SLOTS[s.slot % SERIES_SLOTS.length].bg
                          )}
                        />
                        first {t.stats.first} · peak {t.stats.peak} · median{" "}
                        {t.stats.median} · {t.total.toLocaleString()} papers
                        {t.delta !== undefined && (
                          <>
                            {" "}
                            · {t.delta > 0 ? "+" : ""}
                            {t.delta.toFixed(2)}pp
                          </>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}

              {baselineSeries.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
                    Compare against the world ({baselineSeries.length} of{" "}
                    {selected.length} terms matched in OpenAlex)
                  </summary>
                  <p className="mt-1 mb-1 text-muted-foreground text-xs">
                    Papers per year across OpenAlex's whole index, not this
                    corpus. Where the two shapes disagree, the corpus curve is
                    telling you about the collection rather than the field.
                  </p>
                  <TrendLinesChart height={200} series={baselineSeries} />
                </details>
              )}
            </section>

            {/* ── Discovery grid ───────────────────────────────────────────── */}
            <section>
              <SectionTitle hint="The heaviest terms in this dimension, as shapes. Click any to chart it; the number is its peak year.">
                Browse {dimDef.label.toLowerCase()}
              </SectionTitle>
              <SparklineGrid
                corpusYears={yearTotals}
                mode={mode}
                onPick={addTerm}
                selected={new Set(selected.map((s) => s.term.toLowerCase()))}
                terms={terms}
              />
            </section>

            {/* ── Composition ──────────────────────────────────────────────── */}
            {compositionBands.length > 0 && (
              <section>
                <SectionTitle hint="The six heaviest terms as shares of each year, normalised to 100%. Shows the corpus changing shape, which the per-term lines cannot.">
                  Composition over time
                </SectionTitle>
                <StackedAreaChart
                  bands={compositionBands}
                  minYear={showAllYears ? undefined : DEFAULT_MIN_YEAR}
                  onBandClick={addTerm}
                />
              </section>
            )}

            {/* ── Term context ─────────────────────────────────────────────── */}
            {focusTerm && isManifestDim && (
              <section>
                <SectionTitle hint="What the most recently added term travels with, and who has been publishing it.">
                  Context
                </SectionTitle>
                <TermDetail dim={dim} onPick={addTerm} term={focusTerm} />
              </section>
            )}

            {/* ── Movement ─────────────────────────────────────────────────── */}
            <section>
              <RisingFading
                fading={fading}
                label={dimDef.label.toLowerCase()}
                onPick={addTerm}
                rising={rising}
                windows={windows}
              />
            </section>

            <section className="grid gap-6 sm:grid-cols-2">
              {isManifestDim && data.newcomers?.[dim as TrendDim] && (
                <Newcomers
                  items={data.newcomers[dim as TrendDim] ?? []}
                  label={dimDef.label.toLowerCase()}
                  onPick={addTerm}
                />
              )}
              {isManifestDim && data.bursts?.[dim as TrendDim] && (
                <Bursts
                  items={data.bursts[dim as TrendDim] ?? []}
                  label={dimDef.label.toLowerCase()}
                  onPick={addTerm}
                />
              )}
            </section>

            {data.leadlag && data.leadlag.length > 0 && (
              <section>
                <LeadLag items={data.leadlag} onPick={addTerm} />
              </section>
            )}

            {/* ── Semantic frontier ────────────────────────────────────────── */}
            {clusters && clusters.frontier.length > 0 && (
              <section>
                <Frontier
                  cells={clusters.frontier}
                  window={clusters.frontierWindow}
                />
              </section>
            )}

            {/* ── Citations ────────────────────────────────────────────────── */}
            {citations && (
              <CitationsPanels
                data={citations}
                dim={dim === "keywords" ? "keywords" : "subjects"}
                onPick={(term) => {
                  if (dim !== "keywords" && dim !== "subjects") {
                    setDim("subjects");
                  }
                  addTerm(term);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
