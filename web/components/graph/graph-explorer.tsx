"use client";

import { SearchIcon, WaypointsIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { PageHeader } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import { paperFetcher } from "@/components/papers/lib";
import type { GraphEntitySummary, GraphOverview } from "@/lib/aprag/client";
import {
  formatSourcePapers,
  isSourcePapersCapped,
  SOURCE_PAPERS_CAPPED_HINT,
} from "@/lib/aprag/graph";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const PAGE_SIZE = 50;
const MAX_LIMIT = 200;

export function entityHref(name: string): string {
  return `/graph/entity?name=${encodeURIComponent(name)}`;
}

type EntityList = {
  total: number;
  entities: GraphEntitySummary[];
  // The graph is far too large to count matches corpus-wide, so the server ranks a
  // bounded candidate set instead. `total` is then "what we can show", not a census.
  bounded?: boolean;
};

// The Knowledge Graph explorer: what the ingest LLM extracted from the corpus —
// typed entities (concepts, methods, theories, authors, …) ranked by connectedness,
// searchable and filterable by type. Every row opens the entity's card.
export function GraphExplorer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const type = searchParams.get("type") ?? "";

  const [text, setText] = useState(q);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    setText(q);
    setLimit(PAGE_SIZE);
  }, [q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset paging on type change
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [type]);

  const navigate = (nextQ: string, nextType: string) => {
    const sp = new URLSearchParams();
    if (nextQ.trim()) {
      sp.set("q", nextQ.trim());
    }
    if (nextType) {
      sp.set("type", nextType);
    }
    const qs = sp.toString();
    router.replace(`${BASE}/graph${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Debounced search → URL (the URL is the source of truth, so views are shareable).
  useEffect(() => {
    if (text === q) {
      return;
    }
    const t = setTimeout(() => navigate(text, type), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const { data: overview } = useSWR<GraphOverview>(
    `${BASE}/api/graph/overview`,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  const listKey = useMemo(() => {
    const sp = new URLSearchParams();
    if (q) {
      sp.set("q", q);
    }
    if (type) {
      sp.set("type", type);
    }
    sp.set("limit", String(limit));
    return `${BASE}/api/graph/entities?${sp.toString()}`;
  }, [q, type, limit]);

  const {
    data: list,
    error,
    isLoading,
  } = useSWR<EntityList>(listKey, paperFetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const entities = list?.entities ?? [];
  const total = list?.total ?? 0;

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-background">
      <PageHeader>
        <SidebarToggle />
        <WaypointsIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">Knowledge Graph</h1>
        {overview && (
          <span className="text-muted-foreground text-xs">
            {overview.entities.toLocaleString()} entities ·{" "}
            {overview.relations.toLocaleString()} relations
          </span>
        )}
      </PageHeader>

      <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-10">
        <p className="text-muted-foreground text-xs">
          The concepts, methods, theories, authors, and findings the ingest
          model extracted from the corpus — and how they connect. Click an
          entity to see its corpus-wide description, its neighbours, and the
          papers behind it. <strong>Search for a topic</strong> to find what
          you care about: the graph has millions of entities, and the most
          connected ones are generic by nature.
        </p>

        <div className="relative">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            autoComplete="off"
            className="h-9 pl-8"
            onChange={(e) => setText(e.target.value)}
            placeholder="Search entities — e.g. semantic memory, lexical decision…"
            value={text}
          />
          {text && (
            <button
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setText("");
                navigate("", type);
              }}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>

        {overview && overview.types.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeChip
              active={type === ""}
              label="All"
              onClick={() => navigate(q, "")}
            />
            {overview.types.map((t) => (
              <TypeChip
                active={type.toLowerCase() === t.type.toLowerCase()}
                count={t.count}
                key={t.type}
                label={t.type}
                onClick={() =>
                  navigate(
                    q,
                    type.toLowerCase() === t.type.toLowerCase() ? "" : t.type
                  )
                }
              />
            ))}
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
            Knowledge graph unavailable — the backend may be offline. Retry in
            a moment.
          </p>
        )}
        {isLoading && !list && (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}

        {list && (
          <>
            <p className="text-muted-foreground text-xs">
              {list.bounded && (q || type)
                ? `Top ${entities.length} of the best matches · most relevant first`
                : list.bounded
                  ? `The ${entities.length} most connected entities · search to narrow`
                  : `${total.toLocaleString()} entit${total === 1 ? "y" : "ies"}${q || type ? " match" : ""} · sorted by connections`}
            </p>
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {entities.map((e) => (
                <li key={e.name}>
                  <Link
                    className="block px-3 py-2 transition-colors hover:bg-accent"
                    href={entityHref(e.name)}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium text-[13px]">{e.name}</span>
                      <Badge className="font-normal" variant="outline">
                        {e.type}
                      </Badge>
                      <span
                        className="text-muted-foreground text-xs tabular-nums"
                        title={
                          isSourcePapersCapped(e.papers)
                            ? SOURCE_PAPERS_CAPPED_HINT
                            : undefined
                        }
                      >
                        {e.degree.toLocaleString()} link
                        {e.degree === 1 ? "" : "s"}
                        {e.papers > 0 && ` · ${formatSourcePapers(e.papers)}`}
                      </span>
                    </span>
                    {e.description && (
                      <span className="mt-0.5 line-clamp-2 block text-muted-foreground text-xs leading-snug">
                        {e.description}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
              {entities.length === 0 && (
                <li className="px-3 py-6 text-center text-muted-foreground text-sm">
                  No entities match.
                </li>
              )}
            </ul>
            {entities.length < total &&
              (limit < MAX_LIMIT ? (
                <Button
                  className="w-full"
                  onClick={() =>
                    setLimit((l) => Math.min(MAX_LIMIT, l + PAGE_SIZE))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Show more
                </Button>
              ) : (
                <p className="text-center text-muted-foreground text-xs">
                  Showing the top {MAX_LIMIT} — refine the search to see the
                  rest.
                </p>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
      onClick={onClick}
      type="button"
    >
      {label}
      {count != null && (
        <span className={cn("ml-1", active ? "opacity-80" : "opacity-60")}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}
