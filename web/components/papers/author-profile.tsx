"use client";

import {
  ArrowLeftIcon,
  DatabaseIcon,
  MessageSquareIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { PageShell } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import type { PaperListResponse, PaperRow } from "@/lib/aprag/types";
import { usePdfViewer } from "@/lib/pdf/store";
import { generateUUID } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { YearBarChart, type YearCount } from "./charts";
import { compactAuthors, displayTitle, paperFetcher } from "./lib";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type CoAuthor = { family: string; given: string; count: number };
type Counted = { value: string; count: number };

function topCounts(values: string[], cap: number): Counted[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v) {
      continue;
    }
    const key = v.toLowerCase();
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { value: v, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, cap);
}

// The author's corpus footprint, aggregated client-side from their (≤1000) paper rows.
export function AuthorProfile({ family }: { family: string }) {
  const router = useRouter();
  // Clicking a paper goes straight to the PDF reader, which splits the page beside
  // the profile — the same affordance the Papers Database row has.
  const openPdf = usePdfViewer((s) => s.openPdf);

  // Profiles are reached from several places — the Talk to Author picker, an author
  // chip in the Papers Database, a graph entity — so "back" is the page you came
  // from, not a fixed destination. A tab opened straight onto a profile has nothing
  // to go back to; that case falls back to the picker.
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, []);

  const goBack = () => {
    if (canGoBack) {
      router.back();
    } else {
      router.push("/authors");
    }
  };

  // The server's author filter is a substring any-position match; keep only rows where
  // some author's family name EQUALS the page's name so "Li" doesn't absorb "Liang".
  const { data, error, isLoading } = useSWR<PaperListResponse>(
    `${BASE}/api/papers?authors=${encodeURIComponent(family)}&limit=1000&sort=year&order=desc`,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  const papers = useMemo(() => {
    const lc = family.toLowerCase();
    return (data?.papers ?? []).filter((p) =>
      p.authors.some((a) => (a.family ?? "").toLowerCase() === lc)
    );
  }, [data, family]);

  // The route segment is the family name — that is the vocabulary the manifest matches
  // on — so the given name has to come from the papers themselves, where spellings
  // vary across records ("Chris", "Chris F.", "C."). Prefer a spelled-out given name
  // over bare initials, then the most common, then the fullest; an initial should
  // never win just by being more frequent.
  const displayName = useMemo(() => {
    const lc = family.toLowerCase();
    const counts = new Map<string, number>();
    for (const p of papers) {
      for (const a of p.authors) {
        const given = (a.given ?? "").trim();
        if (given && (a.family ?? "").toLowerCase() === lc) {
          counts.set(given, (counts.get(given) ?? 0) + 1);
        }
      }
    }
    let best = "";
    let bestSpelled = false;
    let bestCount = -1;
    for (const [given, n] of counts) {
      const spelled = /[A-Za-z]{2,}/.test(given);
      const better =
        spelled !== bestSpelled
          ? spelled
          : n === bestCount
            ? given.length > best.length
            : n > bestCount;
      if (better) {
        best = given;
        bestSpelled = spelled;
        bestCount = n;
      }
    }
    return best ? `${best} ${family}` : family;
  }, [papers, family]);

  const stats = useMemo(() => {
    const perYear = new Map<number, number>();
    const coAuthors = new Map<string, CoAuthor>();
    const journals: string[] = [];
    const keywords: string[] = [];
    const subjects: string[] = [];
    let firstAuthored = 0;
    const lc = family.toLowerCase();

    for (const p of papers) {
      const y = Number.parseInt(p.year, 10);
      if (Number.isFinite(y) && y > 1800) {
        perYear.set(y, (perYear.get(y) ?? 0) + 1);
      }
      if ((p.authors[0]?.family ?? "").toLowerCase() === lc) {
        firstAuthored += 1;
      }
      for (const a of p.authors) {
        const fam = (a.family ?? "").trim();
        if (!fam || fam.toLowerCase() === lc) {
          continue;
        }
        const key = fam.toLowerCase();
        const entry = coAuthors.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          coAuthors.set(key, { family: fam, given: a.given ?? "", count: 1 });
        }
      }
      if (p.container_title) {
        journals.push(p.container_title);
      }
      keywords.push(...p.keywords);
      subjects.push(...p.subjects);
    }

    const years = [...perYear.keys()];
    const timeline: YearCount[] = [...perYear.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year - b.year);

    return {
      timeline,
      yearMin: years.length > 0 ? Math.min(...years) : 0,
      yearMax: years.length > 0 ? Math.max(...years) : 0,
      firstAuthored,
      coAuthors: [...coAuthors.values()]
        .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
        .slice(0, 16),
      journals: topCounts(journals, 8),
      keywords: topCounts(keywords, 14),
      subjects: topCounts(subjects, 8),
    };
  }, [papers, family]);

  const talkToAuthor = () =>
    router.push(
      `/chat/${generateUUID()}?author=${encodeURIComponent(family)}`
    );

  const papersHref = (extra?: Record<string, string>) => {
    const sp = new URLSearchParams();
    sp.append("authors", family);
    for (const [k, v] of Object.entries(extra ?? {})) {
      sp.set(k, v);
    }
    return `/papers?${sp.toString()}`;
  };

  return (
    <PageShell
      className="overflow-y-auto"
      header={
        <>
          <SidebarToggle />
          <Button
            aria-label="Go back"
            className="shrink-0 text-muted-foreground"
            onClick={goBack}
            size="icon-sm"
            title="Back"
            type="button"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <UserRoundIcon className="size-4 text-muted-foreground" />
          <h1 className="min-w-0 truncate font-semibold text-sm">
            {displayName}
          </h1>
          {papers.length > 0 && (
            <span className="text-muted-foreground text-xs">
              {papers.length.toLocaleString()} paper
              {papers.length === 1 ? "" : "s"}
              {stats.yearMin > 0 &&
                ` · ${stats.yearMin}${stats.yearMax !== stats.yearMin ? `–${stats.yearMax}` : ""}`}
              {stats.firstAuthored > 0 && ` · ${stats.firstAuthored} as first author`}
            </span>
          )}
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 pb-10">
        <div className="flex flex-wrap gap-2">
          <Button onClick={talkToAuthor} size="sm" type="button">
            <MessageSquareIcon className="size-4" />
            Talk to {displayName}
          </Button>
          <Button asChild size="sm" type="button" variant="outline">
            <Link
              href={papersHref()}
              title={`Open the Papers Database filtered to ${family}`}
            >
              <DatabaseIcon className="size-4" />
              Filter in Papers Database
            </Link>
          </Button>
        </div>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {error && (
          <p className="text-muted-foreground text-sm">
            Couldn't load this author's papers — the backend may be offline.
          </p>
        )}
        {!(isLoading || error) && papers.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No papers in the corpus list an author with the family name "
            {family}".
          </p>
        )}

        {papers.length > 0 && (
          <>
            <section>
              <h2 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Papers per year
              </h2>
              <YearBarChart
                data={stats.timeline}
                onYearClick={(year) =>
                  router.push(
                    papersHref({
                      year_from: String(year),
                      year_to: String(year),
                    })
                  )
                }
              />
            </section>

            {stats.keywords.length > 0 && (
              <section>
                <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Topics
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {stats.keywords.map((k) => (
                    <Badge asChild className="cursor-pointer font-normal" key={k.value} variant="outline">
                      <Link href={papersHref({ keywords: k.value })}>
                        {k.value}
                        <span className="ml-1 text-muted-foreground">
                          {k.count}
                        </span>
                      </Link>
                    </Badge>
                  ))}
                </div>
              </section>
            )}

            <div className="grid gap-6 sm:grid-cols-2">
              {stats.journals.length > 0 && (
                <section>
                  <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    Venues
                  </h2>
                  <ul className="space-y-1 text-[13px]">
                    {stats.journals.map((j) => (
                      <li className="flex items-baseline gap-2" key={j.value}>
                        <Link
                          className="min-w-0 truncate hover:underline"
                          href={papersHref({ journals: j.value })}
                        >
                          {j.value}
                        </Link>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {j.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {stats.coAuthors.length > 0 && (
                <section>
                  <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    Co-authors
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {stats.coAuthors.map((c) => (
                      <Badge
                        asChild
                        className="cursor-pointer font-normal"
                        key={c.family}
                        variant="secondary"
                      >
                        <Link href={`/authors/${encodeURIComponent(c.family)}`}>
                          {[c.given, c.family].filter(Boolean).join(" ")}
                          <span className="ml-1 text-muted-foreground">
                            {c.count}
                          </span>
                        </Link>
                      </Badge>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <section>
              <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Papers
              </h2>
              <ul className="divide-y divide-border/60 rounded-lg border border-border">
                {papers.map((p: PaperRow) => (
                  <li key={p.filename}>
                    <button
                      className="w-full px-3 py-2 text-left transition-colors hover:bg-accent"
                      onClick={() =>
                        openPdf({
                          filename: p.filename,
                          page: 1,
                          label: p.intext || displayTitle(p),
                          driveUrl: p.drive_url,
                        })
                      }
                      type="button"
                    >
                      <span className="line-clamp-2 text-[13px] leading-snug">
                        {displayTitle(p)}
                      </span>
                      <span className="mt-0.5 block text-muted-foreground text-xs">
                        {[compactAuthors(p.authors), p.year, p.container_title]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

    </PageShell>
  );
}
