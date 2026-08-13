"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";

// Per-author corpus footprint, aggregated client-side from the static papers manifest
// (public/data/papers.json — paper metadata only, no passage text). `papers.json`'s
// `authors` field is a display byline ("Smith", "Smith & Jones", "Smith et al."), so
// the FIRST-author family name is extracted from it before grouping. That family name
// is also what gets sent to the query server as the persona's `authors` filter, which
// matches manifest author families — so it must never be the raw byline. Used by the
// Talk-to-Author picker and the persona chat header.

type PaperMeta = {
  authors: string;
  year: number;
  nChunks: number;
};

export type AuthorStat = {
  author: string;
  nPapers: number;
  nChunks: number;
  yearMin: number;
  yearMax: number;
};

const PAPERS_URL = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/papers.json`;

/** "Smith & Jones" / "Smith et al." / "Smith" → "Smith". */
function firstFamily(byline: string): string {
  return byline
    .replace(/\s+et al\.?$/i, "")
    .split(/\s*&\s*/)[0]
    .trim();
}

function aggregate(papers: PaperMeta[]): AuthorStat[] {
  const byAuthor = new Map<string, AuthorStat>();
  for (const p of papers) {
    const author = firstFamily(p.authors || "");
    if (!author) {
      continue;
    }
    let s = byAuthor.get(author);
    if (!s) {
      s = {
        author,
        nPapers: 0,
        nChunks: 0,
        yearMin: Number.POSITIVE_INFINITY,
        yearMax: Number.NEGATIVE_INFINITY,
      };
      byAuthor.set(author, s);
    }
    s.nPapers += 1;
    s.nChunks += p.nChunks || 0;
    if (p.year > 0) {
      s.yearMin = Math.min(s.yearMin, p.year);
      s.yearMax = Math.max(s.yearMax, p.year);
    }
  }
  const out = [...byAuthor.values()].map((s) =>
    Number.isFinite(s.yearMin) ? s : { ...s, yearMin: 0, yearMax: 0 }
  );
  out.sort((a, b) => b.nChunks - a.nChunks || a.author.localeCompare(b.author));
  return out;
}

/** All summonable authors, ranked by corpus footprint (passages, then papers). */
export function useAuthorStats(): {
  stats: AuthorStat[];
  byAuthor: Map<string, AuthorStat>;
  isLoading: boolean;
} {
  const { data, isLoading } = useSWR<PaperMeta[]>(PAPERS_URL, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 600_000,
  });
  const stats = useMemo(() => aggregate(data ?? []), [data]);
  const byAuthor = useMemo(
    () => new Map(stats.map((s) => [s.author, s])),
    [stats]
  );
  return { stats, byAuthor, isLoading };
}

/** "8 papers · 548 passages" (+ " · 2019–2025" when years are known). */
export function formatAuthorStat(s: AuthorStat | undefined): string {
  if (!s) {
    return "";
  }
  const papers = `${s.nPapers} paper${s.nPapers === 1 ? "" : "s"}`;
  const passages = `${s.nChunks.toLocaleString()} passage${s.nChunks === 1 ? "" : "s"}`;
  const years =
    s.yearMin > 0
      ? s.yearMin === s.yearMax
        ? ` · ${s.yearMin}`
        : ` · ${s.yearMin}–${s.yearMax}`
      : "";
  return `${papers} · ${passages}${years}`;
}
