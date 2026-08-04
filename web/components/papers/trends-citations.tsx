"use client";

// The citation layer of the Research Trends dashboard, from OpenAlex (see
// scripts/fetch_openalex.py). The manifest carries the citation *of* each paper; none
// of this — how often a paper has been cited, when those citations arrived, or what
// each paper cites — exists locally.
//
// Every per-paper comparison that could be distorted by age is stated as a
// within-year percentile as well as a raw count: a 1998 paper with 200 citations and
// a 2023 paper with 20 are not comparable on counts alone.

import { MoonIcon, NetworkIcon, QuoteIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { CitationsData } from "@/lib/aprag/trends-static";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./trends-panels";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function paperHref(file: string) {
  return `${BASE}/papers?q=${encodeURIComponent(file)}`;
}

function PaperRow({
  title,
  year,
  file,
  right,
  hint,
}: {
  title: string;
  year: number | null;
  file: string;
  right: string;
  hint?: string;
}) {
  return (
    <li className="flex items-baseline gap-2 text-[13px]">
      <span className="w-9 shrink-0 text-muted-foreground text-xs tabular-nums">
        {year ?? "—"}
      </span>
      <Link className="min-w-0 truncate hover:underline" href={paperHref(file)}>
        {title || file}
      </Link>
      <span
        className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums"
        title={hint}
      >
        {right}
      </span>
    </li>
  );
}

export function CitationsPanels({
  data,
  dim,
  onPick,
}: {
  data: CitationsData;
  dim: string;
  onPick: (term: string) => void;
}) {
  const [decade, setDecade] = useState<string | null>(null);
  const decades = Object.keys(data.perDecade).sort();
  const shown = decade ? (data.perDecade[decade] ?? []) : data.top.slice(0, 10);
  const topicRows = data.topic[dim] ?? [];
  const coverage = data.coverage;

  return (
    <div className="space-y-8">
      <section>
        <SectionTitle
          hint={
            <>
              {coverage.matched.toLocaleString()} of{" "}
              {coverage.manifest.toLocaleString()} papers matched in OpenAlex (
              {coverage.totalCitations.toLocaleString()} citations). Papers
              without a DOI are absent.
            </>
          }
        >
          Most cited
        </SectionTitle>

        <div className="mb-2 flex flex-wrap gap-1">
          <button
            className={cn(
              "rounded-md border border-border px-2 py-0.5 text-xs transition-colors",
              decade === null
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            )}
            onClick={() => setDecade(null)}
            type="button"
          >
            All time
          </button>
          {decades.map((d) => (
            <button
              className={cn(
                "rounded-md border border-border px-2 py-0.5 text-xs tabular-nums transition-colors",
                decade === d
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              )}
              key={d}
              onClick={() => setDecade(d)}
              type="button"
            >
              {d}s
            </button>
          ))}
        </div>

        <ul className="space-y-0.5">
          {shown.map((p) => (
            <PaperRow
              file={p.file}
              hint={
                p.pct === undefined
                  ? undefined
                  : `${p.pct}th percentile among corpus papers from ${p.year}`
              }
              key={p.file}
              right={p.cited.toLocaleString()}
              title={p.title}
              year={p.year}
            />
          ))}
        </ul>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <div>
          <SectionTitle hint="Old papers whose citations arrived mostly in the last five years — work the field returned to long after publication.">
            <span className="inline-flex items-center gap-1.5">
              <MoonIcon className="size-3" />
              Sleeping beauties
            </span>
          </SectionTitle>
          <ul className="space-y-0.5">
            {data.sleeping.slice(0, 10).map((p) => (
              <PaperRow
                file={p.file}
                hint={`${p.recent.toLocaleString()} of ${p.cited.toLocaleString()} citations arrived recently`}
                key={p.file}
                right={`${p.share}%`}
                title={p.title}
                year={p.year}
              />
            ))}
            {data.sleeping.length === 0 && (
              <li className="text-muted-foreground text-xs">
                None above the threshold.
              </li>
            )}
          </ul>
        </div>

        <div>
          <SectionTitle
            hint={`${coverage.internalEdges.toLocaleString()} references point from one corpus paper to another. These are the works the library itself is built on.`}
          >
            <span className="inline-flex items-center gap-1.5">
              <NetworkIcon className="size-3" />
              Most cited within the corpus
            </span>
          </SectionTitle>
          <ul className="space-y-0.5">
            {data.internal.slice(0, 10).map((p) => (
              <PaperRow
                file={p.file}
                hint={`${p.inCorpus} citing papers inside the corpus; ${p.cited.toLocaleString()} worldwide`}
                key={p.file}
                right={`${p.inCorpus}`}
                title={p.title}
                year={p.year}
              />
            ))}
            {data.internal.length === 0 && (
              <li className="text-muted-foreground text-xs">
                No internal citation edges found.
              </li>
            )}
          </ul>
        </div>
      </section>

      {topicRows.length > 0 && (
        <section>
          <SectionTitle hint="Mean within-year citation percentile of a topic's papers — age-fair, so a topic is not rewarded for being old. Click to chart the topic.">
            <span className="inline-flex items-center gap-1.5">
              <QuoteIcon className="size-3" />
              Highest-impact {dim}
            </span>
          </SectionTitle>
          <ul className="space-y-0.5">
            {topicRows.slice(0, 12).map((t) => (
              <li key={t.term}>
                <button
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-accent"
                  onClick={() => onPick(t.term)}
                  title={`${t.papers} papers, median ${t.medianCited.toLocaleString()} citations. Top: ${t.top.title}`}
                  type="button"
                >
                  <span className="min-w-0 truncate">{t.term}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                    {t.meanPct.toFixed(0)}th · {t.papers}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
