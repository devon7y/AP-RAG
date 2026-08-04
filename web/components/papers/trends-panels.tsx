"use client";

// Panels for the Research Trends dashboard, split out of trends-dashboard.tsx to keep
// the orchestrator readable. Every panel is presentational: it takes already-computed
// data and an `onPick` for promoting a term into the main chart.

import {
  ArrowRightIcon,
  ExternalLinkIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  TrendBurst,
  TrendDetail,
  TrendLeadLag,
  TrendNewcomer,
  TrendTerm,
} from "@/lib/aprag/client";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Sparkline, type YearCount } from "./charts";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function SectionTitle({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5">
      <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {children}
      </h2>
      {hint && <p className="mt-0.5 text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Corpus-level facts, stated once so every number below has a denominator. */
export function StatTiles({
  tiles,
}: {
  tiles: { label: string; value: string; hint?: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <div
          className="rounded-lg border border-border px-3 py-2"
          key={t.label}
          title={t.hint}
        >
          <div className="font-semibold text-foreground text-lg tabular-nums leading-tight">
            {t.value}
          </div>
          <div className="text-muted-foreground text-xs">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The discovery grid: the heaviest terms in a dimension as bare trajectories.
 *
 * The dashboard's original failure mode was requiring you to know what to type
 * before anything appeared. Shape first, name second — a term whose curve is
 * interesting gets clicked, whether or not you knew it existed.
 */
export function SparklineGrid({
  terms,
  selected,
  onPick,
  mode,
  corpusYears,
  limit = 40,
}: {
  terms: TrendTerm[];
  selected: Set<string>;
  onPick: (term: string) => void;
  mode: "count" | "share";
  corpusYears: Map<number, number>;
  limit?: number;
}) {
  const rows = terms.slice(0, limit);
  if (rows.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((t, i) => {
        const points: YearCount[] = Object.entries(t.counts)
          .map(([year, count]) => {
            const y = Number(year);
            if (mode === "share") {
              const total = corpusYears.get(y) ?? 0;
              return { year: y, count: total > 0 ? (count / total) * 100 : 0 };
            }
            return { year: y, count };
          })
          .sort((a, b) => a.year - b.year);
        const isOn = selected.has(t.term.toLowerCase());
        return (
          <button
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
              isOn ? "bg-accent" : "hover:bg-accent/60"
            )}
            key={t.term}
            onClick={() => onPick(t.term)}
            title={`${t.term} — ${t.total.toLocaleString()} papers${
              t.stats ? `, peak ${t.stats.peak}` : ""
            }`}
            type="button"
          >
            <Sparkline
              height={26}
              points={points}
              showPeak
              slot={i % 6}
              width={92}
            />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {t.term}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {t.stats?.peak ?? ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A ranked list of terms with a one-line quantitative tail. */
function TermList({
  items,
  onPick,
  empty,
}: {
  items: {
    term: string;
    right: string;
    glyph?: React.ReactNode;
    title?: string;
  }[];
  onPick: (term: string) => void;
  empty: string;
}) {
  if (items.length === 0) {
    return <p className="px-2 py-1 text-muted-foreground text-xs">{empty}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.term}>
          <button
            className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent"
            onClick={() => onPick(item.term)}
            title={item.title}
            type="button"
          >
            {item.glyph}
            <span className="min-w-0 truncate">{item.term}</span>
            <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
              {item.right}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RisingFading({
  rising,
  fading,
  windows,
  onPick,
  label,
}: {
  rising: TrendTerm[];
  fading: TrendTerm[];
  windows: { base: [number, number]; recent: [number, number] };
  onPick: (term: string) => void;
  label: string;
}) {
  const columns = [
    {
      title: "Rising",
      items: rising,
      icon: (
        <TrendingUpIcon className="size-3 shrink-0 text-muted-foreground" />
      ),
    },
    {
      title: "Fading",
      items: fading,
      icon: (
        <TrendingDownIcon className="size-3 shrink-0 text-muted-foreground" />
      ),
    },
  ];
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {columns.map((col) => (
        <div key={col.title}>
          <SectionTitle
            hint={`${windows.base.join("–")} vs ${windows.recent.join("–")}, as a share of collected output.`}
          >
            {col.title} {label}
          </SectionTitle>
          <TermList
            empty="Nothing notable in this window."
            items={col.items.map((t) => ({
              term: t.term,
              glyph: col.icon,
              right: `${t.delta && t.delta > 0 ? "+" : ""}${t.delta?.toFixed(2)}pp`,
              title: `${t.base ?? 0} papers then → ${t.recent ?? 0} now`,
            }))}
            onPick={onPick}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Terms that did not exist in the corpus before the recent window.
 *
 * Rising/fading structurally cannot surface these: a term absent from the base
 * window has nothing to have risen from, and the minimum-total floor excludes most
 * new arrivals anyway.
 */
export function Newcomers({
  items,
  onPick,
  label,
}: {
  items: TrendNewcomer[];
  onPick: (term: string) => void;
  label: string;
}) {
  return (
    <div>
      <SectionTitle hint="First appearance in the corpus, newest arrivals by volume since.">
        New {label}
      </SectionTitle>
      <TermList
        empty="No recent first-appearances above the threshold."
        items={items.map((n) => ({
          term: n.term,
          glyph: (
            <SparklesIcon className="size-3 shrink-0 text-muted-foreground" />
          ),
          right: `${n.first} · ${n.recent}`,
          title: `First seen ${n.first}; ${n.recent} papers in the recent window (${n.total} total)`,
        }))}
        onPick={onPick}
      />
    </div>
  );
}

/**
 * Short sharp concentrations, scored as Poisson surprise against the term's own
 * baseline. A decade-over-decade delta averages these flat.
 */
export function Bursts({
  items,
  onPick,
  label,
}: {
  items: TrendBurst[];
  onPick: (term: string) => void;
  label: string;
}) {
  return (
    <div>
      <SectionTitle hint="Sharpest 3-year concentration relative to the term's own rate.">
        Bursts in {label}
      </SectionTitle>
      <TermList
        empty="No bursts above the threshold."
        items={items.map((b) => ({
          term: b.term,
          glyph: (
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {b.from}
            </span>
          ),
          right: `${b.n} vs ${b.expected} exp.`,
          title: `${b.from}–${b.to}: ${b.n} papers against ${b.expected} expected (z = ${b.z})`,
        }))}
        onPick={onPick}
      />
    </div>
  );
}

/**
 * Term pairs whose curves correlate best at a non-zero lag, after beating their own
 * zero-lag correlation — otherwise the pair simply moves together and the lag is an
 * artefact. Lexically overlapping pairs are filtered server-side.
 */
export function LeadLag({
  items,
  onPick,
}: {
  items: TrendLeadLag[];
  onPick: (term: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <SectionTitle hint="One term's curve tracking another's, offset in time. Correlation is not causation — these are leads worth looking at, not findings.">
        Leads and lags
      </SectionTitle>
      <ul className="space-y-0.5">
        {items.slice(0, 10).map((p) => (
          <li
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px]"
            key={`${p.lead}->${p.follow}`}
          >
            <button
              className="min-w-0 max-w-[38%] truncate text-left hover:underline"
              onClick={() => onPick(p.lead)}
              type="button"
            >
              {p.lead}
            </button>
            <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
            <button
              className="min-w-0 max-w-[38%] truncate text-left hover:underline"
              onClick={() => onPick(p.follow)}
              type="button"
            >
              {p.follow}
            </button>
            <span
              className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums"
              title={`r = ${p.r} at a ${p.lag}-year lag (${p.gain} above their zero-lag correlation)`}
            >
              {p.lag}y · r{p.r}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Two side-by-side ranked lists, for a then-vs-now comparison. */
function ThenNow({
  title,
  then: thenRows,
  now,
  hrefFor,
}: {
  title: string;
  then: { term: string; n: number }[];
  now: { term: string; n: number }[];
  hrefFor?: (term: string) => string;
}) {
  if (thenRows.length === 0 && now.length === 0) {
    return null;
  }
  const render = (rows: { term: string; n: number }[], heading: string) => (
    <div className="min-w-0 flex-1">
      <div className="mb-0.5 text-muted-foreground text-xs">{heading}</div>
      <ul className="space-y-px">
        {rows.slice(0, 6).map((r) => (
          <li className="flex items-baseline gap-2 text-[13px]" key={r.term}>
            {hrefFor ? (
              <Link
                className="min-w-0 truncate hover:underline"
                href={hrefFor(r.term)}
              >
                {r.term}
              </Link>
            ) : (
              <span className="min-w-0 truncate">{r.term}</span>
            )}
            <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
              {r.n}
            </span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="text-muted-foreground text-xs">—</li>
        )}
      </ul>
    </div>
  );
  return (
    <div>
      <div className="mb-1 font-medium text-xs">{title}</div>
      <div className="flex gap-4">
        {render(thenRows, "then")}
        {render(now, "now")}
      </div>
    </div>
  );
}

/**
 * The context behind one line: what the term travels with, and who published it in
 * each window. Fetched on demand — the overview payload deliberately omits this.
 */
export function TermDetail({
  dim,
  term,
  onPick,
}: {
  dim: string;
  term: string;
  onPick: (term: string) => void;
}) {
  const [data, setData] = useState<TrendDetail | null>(null);
  const [error, setError] = useState(false);
  const [explain, setExplain] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    setExplain(null);
    const sp = new URLSearchParams({ dim, term });
    fetch(`${BASE}/api/trend-detail?${sp.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((json) => {
        if (!cancelled) {
          setData(json as TrendDetail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dim, term]);

  const runExplain = async () => {
    setExplaining(true);
    try {
      const res = await fetch(`${BASE}/api/trend-explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "term", dim, term }),
      });
      const json = await res.json();
      setExplain(json.text ?? "Explanation unavailable.");
    } catch {
      setExplain("Explanation unavailable.");
    } finally {
      setExplaining(false);
    }
  };

  if (error) {
    return (
      <p className="text-muted-foreground text-xs">
        Context unavailable for this term.
      </p>
    );
  }
  if (!data) {
    return <Skeleton className="h-24 w-full" />;
  }

  const shifted = data.cooccur.recent.filter(
    (r) => !data.cooccur.base.some((b) => b.term === r.term)
  );

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-sm">{data.term}</span>
        <span className="text-muted-foreground text-xs">
          {data.total.toLocaleString()} papers
        </span>
        <Button
          className="ml-auto h-6 gap-1.5 px-2 text-xs"
          disabled={explaining}
          onClick={runExplain}
          size="sm"
          type="button"
          variant="outline"
        >
          <SparklesIcon className="size-3" />
          {explaining ? "Reading…" : "Explain this trend"}
        </Button>
      </div>

      {explain && (
        <p className="rounded-md bg-muted/50 px-2.5 py-2 text-[13px] leading-relaxed">
          {explain}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 font-medium text-xs">Travels with</div>
          <div className="flex flex-wrap gap-1">
            {data.cooccur.all.slice(0, 10).map((c) => (
              <button
                className="rounded-md border border-border px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
                key={c.term}
                onClick={() => onPick(c.term)}
                type="button"
              >
                {c.term}{" "}
                <span className="text-muted-foreground tabular-nums">
                  {c.n}
                </span>
              </button>
            ))}
            {data.cooccur.all.length === 0 && (
              <span className="text-muted-foreground text-xs">
                No co-occurring terms.
              </span>
            )}
          </div>
          {shifted.length > 0 && (
            <div className="mt-2 text-muted-foreground text-xs">
              New in {data.windows.recent.join("–")}:{" "}
              {shifted
                .slice(0, 5)
                .map((s) => s.term)
                .join(", ")}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <ThenNow
            hrefFor={(t) => `${BASE}/authors/${encodeURIComponent(t)}`}
            now={data.authors.recent}
            then={data.authors.base}
            title="Who publishes it"
          />
          <ThenNow
            hrefFor={(t) =>
              `${BASE}/papers?${new URLSearchParams([["journals", t]]).toString()}`
            }
            now={data.journals.recent}
            then={data.journals.base}
            title="Where it appears"
          />
        </div>
      </div>

      {data.papers.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
            Recent papers ({data.papers.length})
          </summary>
          <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto">
            {data.papers.slice(0, 30).map((p) => (
              <li
                className="flex items-baseline gap-2 text-[13px]"
                key={p.filename}
              >
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {p.year ?? "—"}
                </span>
                <Link
                  className="min-w-0 truncate hover:underline"
                  href={`${BASE}/papers?q=${encodeURIComponent(p.filename)}`}
                >
                  {p.title || p.filename}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Regions of the Atlas the corpus is growing into that it was not before. */
export function Frontier({
  cells,
  window: win,
}: {
  cells: {
    x: number;
    y: number;
    n: number;
    recentN: number;
    z: number;
    name: string;
    titles: string[];
  }[];
  window: [number, number];
}) {
  if (cells.length === 0) {
    return null;
  }
  return (
    <div>
      <SectionTitle
        hint={`Map regions where ${win[0]}–${win[1]} papers cluster far beyond the corpus-wide recent rate. Derived from chunk embeddings, so no keyword is involved.`}
      >
        The frontier
      </SectionTitle>
      <div className="grid gap-2 sm:grid-cols-2">
        {cells.slice(0, 8).map((cell) => (
          <Link
            className="group rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent"
            href={`${BASE}/atlas?x=${cell.x}&y=${cell.y}`}
            key={`${cell.x},${cell.y}`}
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 truncate font-medium text-[13px]">
                {cell.name}
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                {cell.recentN}/{cell.n}
              </span>
              <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
              {cell.titles[0]}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
