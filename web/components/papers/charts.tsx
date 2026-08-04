"use client";

// Hand-rolled SVG charts for the corpus-exploration pages (author profiles, Research
// Trends). Specs follow the dataviz method: thin marks (bars ≤24px, 4px rounded data-
// end square at the baseline, 2px gaps), 2px lines with ≥8px surface-ringed end
// markers, recessive hairline grid, text in text tokens (never the series color),
// hover tooltips by default, and a <details> data table under every chart so no value
// is gated behind hover. Series colors are the validated reference palette (light and
// dark are separately-chosen steps, swapped via Tailwind's `dark:` variant).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

// Fixed categorical slot order (CVD-validated; assign in order, never cycle — callers
// fold extra series into "Other" or cap the selection instead).
export const SERIES_SLOTS = [
  {
    name: "blue",
    fill: "fill-[#2a78d6] dark:fill-[#3987e5]",
    stroke: "stroke-[#2a78d6] dark:stroke-[#3987e5]",
    bg: "bg-[#2a78d6] dark:bg-[#3987e5]",
  },
  {
    name: "aqua",
    fill: "fill-[#1baf7a] dark:fill-[#199e70]",
    stroke: "stroke-[#1baf7a] dark:stroke-[#199e70]",
    bg: "bg-[#1baf7a] dark:bg-[#199e70]",
  },
  {
    name: "yellow",
    fill: "fill-[#eda100] dark:fill-[#c98500]",
    stroke: "stroke-[#eda100] dark:stroke-[#c98500]",
    bg: "bg-[#eda100] dark:bg-[#c98500]",
  },
  {
    name: "green",
    fill: "fill-[#008300] dark:fill-[#008300]",
    stroke: "stroke-[#008300] dark:stroke-[#008300]",
    bg: "bg-[#008300] dark:bg-[#008300]",
  },
  {
    name: "violet",
    fill: "fill-[#4a3aa7] dark:fill-[#9085e9]",
    stroke: "stroke-[#4a3aa7] dark:stroke-[#9085e9]",
    bg: "bg-[#4a3aa7] dark:bg-[#9085e9]",
  },
  {
    name: "red",
    fill: "fill-[#e34948] dark:fill-[#e66767]",
    stroke: "stroke-[#e34948] dark:stroke-[#e66767]",
    bg: "bg-[#e34948] dark:bg-[#e66767]",
  },
] as const;

export const MAX_TREND_SERIES = SERIES_SLOTS.length;

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) {
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Clean y-axis ticks: 0 and ~3 steps of 1/2/5×10^k covering the max.
function niceTicks(max: number): number[] {
  if (max <= 0) {
    return [0, 1];
  }
  const rough = max / 3;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) {
    ticks.push(v);
  }
  if (ticks.at(-1)! < max) {
    ticks.push(ticks.at(-1)! + step);
  }
  return ticks;
}

// X-axis year ticks: at most ~8, on clean decade-ish boundaries.
function yearTicks(minYear: number, maxYear: number): number[] {
  const span = maxYear - minYear;
  const step =
    [1, 2, 5, 10, 20, 25, 50].find((s) => span / s <= 8) ?? 100;
  const ticks: number[] = [];
  const start = Math.ceil(minYear / step) * step;
  for (let y = start; y <= maxYear; y += step) {
    ticks.push(y);
  }
  return ticks.length > 0 ? ticks : [minYear];
}

export type YearCount = { year: number; count: number };

// Fill missing years with zeros so the x-axis is truly linear.
export function fillYears(data: YearCount[]): YearCount[] {
  if (data.length === 0) {
    return [];
  }
  const byYear = new Map(data.map((d) => [d.year, d.count]));
  const min = Math.min(...byYear.keys());
  const max = Math.max(...byYear.keys());
  const out: YearCount[] = [];
  for (let y = min; y <= max; y++) {
    out.push({ year: y, count: byYear.get(y) ?? 0 });
  }
  return out;
}

/**
 * Centred rolling mean over a year series.
 *
 * At ~200 collected papers a year, a single year's count for one term is mostly
 * sampling noise — a term with 6 papers in 2011 and 2 in 2012 has not halved in
 * importance. Smoothing is offered as a toggle rather than applied silently, since
 * it does move the peak.
 */
export function smoothYears(data: YearCount[], window: number): YearCount[] {
  if (window <= 1 || data.length === 0) {
    return data;
  }
  const half = Math.floor(window / 2);
  return data.map((d, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(data.length, i + half + 1);
    let sum = 0;
    for (let k = lo; k < hi; k++) {
      sum += data[k].count;
    }
    return { year: d.year, count: sum / (hi - lo) };
  });
}

/**
 * A bare trajectory — no axes, no labels, no interaction of its own.
 *
 * The dashboard's discovery problem is that a term has to be *typed* before it can
 * be seen, so nothing invites browsing. A grid of these turns the top of each
 * dimension into something scannable: shape first, name second.
 */
export function Sparkline({
  points,
  width = 116,
  height = 30,
  slot = 0,
  showPeak = false,
  className,
}: {
  points: YearCount[];
  width?: number;
  height?: number;
  slot?: number;
  showPeak?: boolean;
  className?: string;
}) {
  const filled = useMemo(
    () => fillYears([...points].sort((a, b) => a.year - b.year)),
    [points]
  );
  if (filled.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }

  const pad = 2;
  const maxV = Math.max(...filled.map((d) => d.count), 1e-9);
  const xOf = (i: number) =>
    pad + (i / (filled.length - 1)) * (width - pad * 2);
  const yOf = (v: number) =>
    height - pad - (v / maxV) * (height - pad * 2);

  const line = filled
    .map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.count).toFixed(1)}`)
    .join(" L");
  const area = `M${xOf(0).toFixed(1)},${height - pad} L${line} L${xOf(
    filled.length - 1
  ).toFixed(1)},${height - pad} Z`;

  let peakIndex = 0;
  for (let i = 1; i < filled.length; i++) {
    if (filled[i].count > filled[peakIndex].count) {
      peakIndex = i;
    }
  }
  const color = SERIES_SLOTS[slot % SERIES_SLOTS.length];

  return (
    <svg
      aria-hidden
      className={cn("block overflow-visible", className)}
      height={height}
      width={width}
    >
      <path className={cn(color.fill, "opacity-15")} d={area} />
      <path
        className={cn(color.stroke, "fill-none")}
        d={`M${line}`}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
      {showPeak && filled[peakIndex].count > 0 && (
        <circle
          className={cn(color.fill, "stroke-card")}
          cx={xOf(peakIndex)}
          cy={yOf(filled[peakIndex].count)}
          r={2.5}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

export type StackBand = { label: string; points: YearCount[] };

/**
 * Composition over time: each band is a share of that year's total, so the bands
 * always sum to 100%.
 *
 * The per-term line chart answers "how big is this one thing"; nothing on the page
 * answered "what is the corpus made of, and how has that changed". Shares rather
 * than counts on purpose — the collection's own volume peaks in the 2000s, which
 * would otherwise dominate the shape of every band.
 */
export function StackedAreaChart({
  bands,
  height = 220,
  minYear,
  maxYear,
  onBandClick,
  className,
}: {
  bands: StackBand[];
  height?: number;
  minYear?: number;
  maxYear?: number;
  onBandClick?: (label: string) => void;
  className?: string;
}) {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<{ year: number; band: string | null } | null>(
    null
  );
  const tableId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);

  const { years, stacks } = useMemo(() => {
    const all = new Set<number>();
    for (const band of bands) {
      for (const p of band.points) {
        all.add(p.year);
      }
    }
    let list = [...all].sort((a, b) => a - b);
    if (minYear !== undefined) {
      list = list.filter((y) => y >= minYear);
    }
    if (maxYear !== undefined) {
      list = list.filter((y) => y <= maxYear);
    }
    const lookup = bands.map((b) => new Map(b.points.map((p) => [p.year, p.count])));
    // Normalise each year to 100%: the question is composition, not volume.
    const cols = list.map((year) => {
      const raw = lookup.map((m) => m.get(year) ?? 0);
      const total = raw.reduce((a, b) => a + b, 0);
      return total > 0 ? raw.map((v) => (v / total) * 100) : raw.map(() => 0);
    });
    return { years: list, stacks: cols };
  }, [bands, minYear, maxYear]);

  if (years.length < 2 || bands.length === 0) {
    return null;
  }

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const xOf = (i: number) => MARGIN.left + (i / (years.length - 1)) * plotW;
  const yOf = (v: number) => MARGIN.top + plotH * (1 - v / 100);

  // Cumulative offsets, band by band.
  const offsets: number[][] = [];
  const running = new Array(years.length).fill(0);
  for (let b = 0; b < bands.length; b++) {
    const lower = [...running];
    for (let i = 0; i < years.length; i++) {
      running[i] += stacks[i]?.[b] ?? 0;
    }
    offsets.push(lower);
  }

  const bandPath = (b: number) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < years.length; i++) {
      const lower = offsets[b][i];
      const upper = lower + (stacks[i]?.[b] ?? 0);
      top.push(`${xOf(i).toFixed(1)},${yOf(upper).toFixed(1)}`);
      bottom.push(`${xOf(i).toFixed(1)},${yOf(lower).toFixed(1)}`);
    }
    return `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`;
  };

  const xTicks = yearTicks(years[0], years.at(-1) ?? years[0]);
  const hoverIndex = hover != null ? years.indexOf(hover.year) : -1;
  const hoverRows =
    hoverIndex >= 0
      ? bands
          .map((band, b) => ({
            label: band.label,
            slot: b,
            value: stacks[hoverIndex]?.[b] ?? 0,
          }))
          .filter((r) => r.value > 0.05)
          .sort((a, b) => b.value - a.value)
      : [];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) {
      return;
    }
    const rect = svgRef.current.getBoundingClientRect();
    const t = (e.clientX - rect.left - MARGIN.left) / plotW;
    const i = Math.round(t * (years.length - 1));
    if (i >= 0 && i < years.length) {
      setHover({ year: years[i], band: null });
    }
  };

  return (
    <div className={cn("relative", className)} ref={ref}>
      <svg
        aria-describedby={tableId}
        className="block w-full"
        height={height}
        onPointerLeave={() => setHover(null)}
        onPointerMove={onMove}
        ref={svgRef}
        role="img"
        width={width}
      >
        {[0, 25, 50, 75, 100].map((t) => (
          <g key={t}>
            <line
              className="stroke-border"
              strokeWidth={1}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={yOf(t)}
              y2={yOf(t)}
            />
            <text
              className="fill-muted-foreground text-[10px] tabular-nums"
              textAnchor="end"
              x={MARGIN.left - 6}
              y={yOf(t) + 3}
            >
              {t}%
            </text>
          </g>
        ))}
        {bands.map((band, b) => (
          // Focusable and Enter-activatable, matching the bar chart's hit targets —
          // clicking a band promotes it into the line chart, so it has to be
          // reachable without a pointer.
          <path
            aria-label={`${band.label} — add to the trend chart`}
            className={cn(
              SERIES_SLOTS[b % SERIES_SLOTS.length].fill,
              "transition-opacity focus:outline-none",
              onBandClick && "cursor-pointer",
              hover?.band && hover.band !== band.label
                ? "opacity-45"
                : "opacity-85"
            )}
            d={bandPath(b)}
            key={band.label}
            onClick={() => onBandClick?.(band.label)}
            onFocus={() =>
              setHover((h) => ({ year: h?.year ?? years[0], band: band.label }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onBandClick?.(band.label);
              }
            }}
            onPointerEnter={() =>
              setHover((h) => ({ year: h?.year ?? years[0], band: band.label }))
            }
            role={onBandClick ? "button" : "img"}
            tabIndex={onBandClick ? 0 : -1}
          />
        ))}
        {xTicks.map((yr) => {
          const i = years.indexOf(yr);
          return i >= 0 ? (
            <text
              className="fill-muted-foreground text-[10px] tabular-nums"
              key={yr}
              textAnchor="middle"
              x={xOf(i)}
              y={height - 5}
            >
              {yr}
            </text>
          ) : null;
        })}
        {hoverIndex >= 0 && (
          <line
            className="stroke-foreground/40"
            strokeWidth={1}
            x1={xOf(hoverIndex)}
            x2={xOf(hoverIndex)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
          />
        )}
      </svg>

      {hoverIndex >= 0 && hoverRows.length > 0 && (
        <div
          className="-translate-x-1/2 pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-sm"
          style={{
            left: Math.min(Math.max(xOf(hoverIndex), 100), Math.max(100, width - 140)),
          }}
        >
          <div className="mb-1 font-medium text-muted-foreground text-xs tabular-nums">
            {hover?.year}
          </div>
          {hoverRows.slice(0, 8).map((r) => (
            <div className="flex items-center gap-1.5 py-px" key={r.label}>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-[2px]",
                  SERIES_SLOTS[r.slot % SERIES_SLOTS.length].bg
                )}
              />
              <span className="font-semibold text-foreground text-xs tabular-nums">
                {r.value.toFixed(1)}%
              </span>
              <span className="truncate text-muted-foreground text-xs">
                {r.label}
              </span>
            </div>
          ))}
        </div>
      )}

      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
          Data table
        </summary>
        <div className="mt-1 max-h-56 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs" id={tableId}>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Year</th>
                {bands.map((b) => (
                  <th className="px-2 py-1 font-medium" key={b.label}>
                    {b.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {years.map((yr, i) => (
                <tr className="border-border/50 border-b" key={yr}>
                  <td className="px-2 py-0.5 tabular-nums">{yr}</td>
                  {bands.map((b, bi) => (
                    <td className="px-2 py-0.5 tabular-nums" key={b.label}>
                      {(stacks[i]?.[bi] ?? 0).toFixed(1)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

const MARGIN = { top: 8, right: 10, bottom: 20, left: 34 };

/**
 * Papers-per-year column chart (single series — no legend; the section title names
 * it). Per-bar hover tooltip + focusable hit targets; optional click-through per year.
 */
export function YearBarChart({
  data,
  height = 170,
  valueLabel = "papers",
  onYearClick,
  className,
}: {
  data: YearCount[]; // sorted or not; gaps are zero-filled
  height?: number;
  valueLabel?: string;
  onYearClick?: (year: number) => void;
  className?: string;
}) {
  const [ref, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null); // index into filled
  const tableId = useId();

  const filled = useMemo(
    () => fillYears([...data].sort((a, b) => a.year - b.year)),
    [data]
  );
  if (filled.length === 0) {
    return null;
  }

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const maxV = Math.max(1, ...filled.map((d) => d.count));
  const ticks = niceTicks(maxV);
  const yMax = ticks.at(-1)!;
  const y = (v: number) => MARGIN.top + plotH * (1 - v / yMax);
  const slot = plotW / filled.length;
  const barW = Math.min(24, Math.max(1.5, slot - 2));
  const xOf = (i: number) => MARGIN.left + i * slot + (slot - barW) / 2;
  const xTicks = yearTicks(filled[0].year, filled.at(-1)!.year);
  const baseline = MARGIN.top + plotH;

  // 4px rounded data-end, square at the baseline (radius shrinks with tiny bars).
  const barPath = (i: number, v: number) => {
    const x = xOf(i);
    const top = y(v);
    const h = baseline - top;
    const r = Math.min(4, barW / 2, h);
    if (h <= 0.5) {
      return "";
    }
    return `M${x},${baseline} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${baseline} Z`;
  };

  const hovered = hover != null ? filled[hover] : null;
  const tooltipX =
    hover != null
      ? Math.min(Math.max(xOf(hover) + barW / 2, 44), width - 44)
      : 0;

  return (
    <div className={cn("relative", className)} ref={ref}>
      <svg
        aria-describedby={tableId}
        className="block w-full"
        height={height}
        onPointerLeave={() => setHover(null)}
        role="img"
        width={width}
      >
        {/* hairline grid + y ticks (recessive) */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="stroke-border"
              strokeWidth={1}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
            />
            <text
              className="fill-muted-foreground text-[10px] tabular-nums"
              textAnchor="end"
              x={MARGIN.left - 6}
              y={y(t) + 3}
            >
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        {/* bars */}
        {filled.map((d, i) =>
          d.count > 0 ? (
            <path
              className={cn(
                SERIES_SLOTS[0].fill,
                "transition-opacity",
                hover != null && hover !== i && "opacity-55"
              )}
              d={barPath(i, d.count)}
              key={d.year}
            />
          ) : null
        )}
        {/* baseline above bars so bar bottoms stay square/crisp */}
        <line
          className="stroke-muted-foreground/40"
          strokeWidth={1}
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={baseline}
          y2={baseline}
        />
        {/* x ticks */}
        {xTicks.map((yr) => {
          const i = yr - filled[0].year;
          return (
            <text
              className="fill-muted-foreground text-[10px] tabular-nums"
              key={yr}
              textAnchor="middle"
              x={xOf(i) + barW / 2}
              y={height - 5}
            >
              {yr}
            </text>
          );
        })}
        {/* hit targets: full column height, wider than the mark */}
        {filled.map((d, i) => (
          <rect
            aria-label={`${d.year}: ${d.count} ${valueLabel}`}
            className={cn(
              "fill-transparent focus:outline-none",
              onYearClick && d.count > 0 && "cursor-pointer"
            )}
            height={plotH}
            key={d.year}
            onClick={() => d.count > 0 && onYearClick?.(d.year)}
            onFocus={() => setHover(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && d.count > 0) {
                onYearClick?.(d.year);
              }
            }}
            onPointerEnter={() => setHover(i)}
            role={onYearClick ? "button" : undefined}
            tabIndex={onYearClick && d.count > 0 ? 0 : -1}
            width={slot}
            x={MARGIN.left + i * slot}
            y={MARGIN.top}
          />
        ))}
      </svg>

      {hovered && (
        <div
          className="-translate-x-1/2 pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 shadow-sm"
          style={{ left: tooltipX, top: Math.max(0, y(hovered.count) - 34) }}
        >
          <span className="font-semibold text-foreground text-xs tabular-nums">
            {hovered.count.toLocaleString()}
          </span>{" "}
          <span className="text-muted-foreground text-xs">
            {valueLabel} · {hovered.year}
          </span>
        </div>
      )}

      {/* Every charted value, reachable without hovering. */}
      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
          Data table
        </summary>
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-xs" id={tableId}>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Year</th>
                <th className="px-2 py-1 font-medium">
                  {valueLabel[0].toUpperCase() + valueLabel.slice(1)}
                </th>
              </tr>
            </thead>
            <tbody>
              {filled
                .filter((d) => d.count > 0)
                .map((d) => (
                  <tr className="border-border/50 border-b" key={d.year}>
                    <td className="px-2 py-0.5 tabular-nums">{d.year}</td>
                    <td className="px-2 py-0.5 tabular-nums">{d.count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export type TrendSeries = {
  label: string;
  slot: number; // index into SERIES_SLOTS — assigned to the entity, stable across removals
  points: YearCount[];
};

/**
 * Multi-series topic-trend line chart. 2px lines, surface-ringed end markers, a
 * crosshair that snaps to the nearest year, and ONE tooltip listing every series at
 * that year (value first, name second, line-key in the series color). The legend is
 * the caller's interactive chips row (always rendered alongside); direct end labels
 * appear when they don't collide.
 */
export function TrendLinesChart({
  series,
  height = 240,
  valueSuffix = "",
  className,
}: {
  series: TrendSeries[];
  height?: number;
  valueSuffix?: string; // e.g. "%" in share mode
  className?: string;
}) {
  const [ref, width] = useContainerWidth();
  const [hoverYear, setHoverYear] = useState<number | null>(null);
  const tableId = useId();

  const domain = useMemo(() => {
    const years = series.flatMap((s) => s.points.map((p) => p.year));
    if (years.length === 0) {
      return null;
    }
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [series]);

  const byLabelYear = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    for (const s of series) {
      m.set(s.label, new Map(s.points.map((p) => [p.year, p.count])));
    }
    return m;
  }, [series]);

  const svgRef = useRef<SVGSVGElement | null>(null);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!(domain && svgRef.current)) {
        return;
      }
      const rect = svgRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const plotW = Math.max(1, rect.width - MARGIN.left - MARGIN.right);
      const t = (px - MARGIN.left) / plotW;
      const yr = Math.round(domain.min + t * (domain.max - domain.min));
      setHoverYear(Math.min(domain.max, Math.max(domain.min, yr)));
    },
    [domain]
  );

  if (!domain || series.length === 0) {
    return null;
  }

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const span = Math.max(1, domain.max - domain.min);
  const xOf = (yr: number) =>
    MARGIN.left + ((yr - domain.min) / span) * plotW;

  const maxV = Math.max(
    1,
    ...series.flatMap((s) => s.points.map((p) => p.count))
  );
  const ticks = niceTicks(maxV);
  const yMax = ticks.at(-1)!;
  const y = (v: number) => MARGIN.top + plotH * (1 - v / yMax);
  const xTicks = yearTicks(domain.min, domain.max);
  const fmt = (v: number) =>
    `${Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1)}${valueSuffix}`;

  const linePath = (s: TrendSeries) => {
    const pts: string[] = [];
    for (let yr = domain.min; yr <= domain.max; yr++) {
      const v = byLabelYear.get(s.label)?.get(yr) ?? 0;
      pts.push(`${xOf(yr).toFixed(1)},${y(v).toFixed(1)}`);
    }
    return `M${pts.join(" L")}`;
  };

  // Direct end labels: hide any that would collide with an already-placed one
  // (the legend + tooltip carry those instead — never stack detached labels).
  const endLabels: { label: string; yPos: number }[] = [];
  for (const s of [...series].sort(
    (a, b) =>
      (byLabelYear.get(a.label)?.get(domain.max) ?? 0) -
      (byLabelYear.get(b.label)?.get(domain.max) ?? 0)
  )) {
    const v = byLabelYear.get(s.label)?.get(domain.max) ?? 0;
    const yPos = y(v);
    if (endLabels.every((l) => Math.abs(l.yPos - yPos) >= 12)) {
      endLabels.push({ label: s.label, yPos });
    }
  }
  const showEndLabels = series.length <= 4;

  const hoverRows =
    hoverYear != null
      ? series
          .map((s) => ({
            label: s.label,
            slot: s.slot,
            value: byLabelYear.get(s.label)?.get(hoverYear) ?? 0,
          }))
          .sort((a, b) => b.value - a.value)
      : [];
  const tooltipLeft =
    hoverYear != null
      ? Math.min(Math.max(xOf(hoverYear), 90), Math.max(90, width - 130))
      : 0;

  return (
    <div className={cn("relative", className)} ref={ref}>
      <svg
        aria-describedby={tableId}
        className="block w-full"
        height={height}
        onPointerLeave={() => setHoverYear(null)}
        onPointerMove={onMove}
        ref={svgRef}
        role="img"
        width={width}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="stroke-border"
              strokeWidth={1}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
            />
            <text
              className="fill-muted-foreground text-[10px] tabular-nums"
              textAnchor="end"
              x={MARGIN.left - 6}
              y={y(t) + 3}
            >
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((yr) => (
          <text
            className="fill-muted-foreground text-[10px] tabular-nums"
            key={yr}
            textAnchor="middle"
            x={xOf(yr)}
            y={height - 5}
          >
            {yr}
          </text>
        ))}

        {/* crosshair */}
        {hoverYear != null && (
          <line
            className="stroke-muted-foreground/50"
            strokeWidth={1}
            x1={xOf(hoverYear)}
            x2={xOf(hoverYear)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
          />
        )}

        {series.map((s) => (
          <path
            className={cn(
              SERIES_SLOTS[s.slot % SERIES_SLOTS.length].stroke,
              "fill-none"
            )}
            d={linePath(s)}
            key={s.label}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        ))}

        {/* end markers with a 2px surface ring; hover markers at the crosshair year */}
        {series.map((s) => {
          const endV = byLabelYear.get(s.label)?.get(domain.max) ?? 0;
          const hv =
            hoverYear != null
              ? (byLabelYear.get(s.label)?.get(hoverYear) ?? 0)
              : null;
          return (
            <g key={s.label}>
              <circle
                className={cn(
                  SERIES_SLOTS[s.slot % SERIES_SLOTS.length].fill,
                  "stroke-card"
                )}
                cx={xOf(domain.max)}
                cy={y(endV)}
                r={4}
                strokeWidth={2}
              />
              {hv != null && hoverYear !== domain.max && (
                <circle
                  className={cn(
                    SERIES_SLOTS[s.slot % SERIES_SLOTS.length].fill,
                    "stroke-card"
                  )}
                  cx={xOf(hoverYear as number)}
                  cy={y(hv)}
                  r={4}
                  strokeWidth={2}
                />
              )}
            </g>
          );
        })}

        {/* direct end labels (text tokens, surface halo), only when they fit apart */}
        {showEndLabels &&
          endLabels.map((l) => (
            <text
              className="fill-foreground/80 stroke-card text-[10px]"
              key={l.label}
              paintOrder="stroke"
              strokeWidth={3}
              textAnchor="end"
              x={width - MARGIN.right}
              y={l.yPos - 7}
            >
              {l.label.length > 22 ? `${l.label.slice(0, 21)}…` : l.label}
            </text>
          ))}
      </svg>

      {hoverYear != null && hoverRows.length > 0 && (
        <div
          className="-translate-x-1/2 pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-sm"
          style={{ left: tooltipLeft }}
        >
          <div className="mb-1 font-medium text-muted-foreground text-xs tabular-nums">
            {hoverYear}
          </div>
          {hoverRows.map((r) => (
            <div className="flex items-center gap-1.5 py-px" key={r.label}>
              <span
                className={cn(
                  "h-0.5 w-2.5 shrink-0 rounded-full",
                  SERIES_SLOTS[r.slot % SERIES_SLOTS.length].bg
                )}
              />
              <span className="font-semibold text-foreground text-xs tabular-nums">
                {fmt(r.value)}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                {r.label}
              </span>
            </div>
          ))}
        </div>
      )}

      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
          Data table
        </summary>
        <div className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-xs" id={tableId}>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Year</th>
                {series.map((s) => (
                  <th className="px-2 py-1 font-medium" key={s.label}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(
                { length: domain.max - domain.min + 1 },
                (_, i) => domain.min + i
              )
                .filter((yr) =>
                  series.some((s) => (byLabelYear.get(s.label)?.get(yr) ?? 0) > 0)
                )
                .map((yr) => (
                  <tr className="border-border/50 border-b" key={yr}>
                    <td className="px-2 py-0.5 tabular-nums">{yr}</td>
                    {series.map((s) => (
                      <td className="px-2 py-0.5 tabular-nums" key={s.label}>
                        {fmt(byLabelYear.get(s.label)?.get(yr) ?? 0)}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
