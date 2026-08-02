"use client";

import {
  ArrowLeftIcon,
  MessageSquareIcon,
  SearchIcon,
  UserRoundIcon,
  WaypointsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import { type ListFilterKey, paperFetcher } from "@/components/papers/lib";
import { PaperDrawer } from "@/components/papers/paper-drawer";
import type { GraphEntityDetail, GraphRelation } from "@/lib/aprag/client";
import { generateUUID } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { entityHref } from "./graph-explorer";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// One entity's card: the corpus-consolidated description, its neighbours in the
// knowledge graph (strongest connections first, grouped by what they are), and the
// papers it was extracted from — with jumps into chat, paper search, and (for
// authors) the author profile page.
export function EntityView() {
  const router = useRouter();
  const name = useSearchParams().get("name")?.trim() ?? "";
  const [openFilename, setOpenFilename] = useState<string | null>(null);

  const { data, error, isLoading } = useSWR<GraphEntityDetail>(
    name
      ? `${BASE}/api/graph/entity?name=${encodeURIComponent(name)}`
      : null,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  const relationGroups = useMemo(() => {
    const groups = new Map<string, GraphRelation[]>();
    for (const r of data?.relations ?? []) {
      const key = r.entity_type || "unknown";
      const arr = groups.get(key);
      if (arr) {
        arr.push(r);
      } else {
        groups.set(key, [r]);
      }
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data]);

  const askAbout = () => {
    if (!data) {
      return;
    }
    const prompt = `What does the corpus say about "${data.name}"? Summarize the key findings, methods, and debates around it.`;
    router.push(`/chat/${generateUUID()}?query=${encodeURIComponent(prompt)}`);
  };

  const onAddFilter = (dim: ListFilterKey, value: string) => {
    const sp = new URLSearchParams();
    sp.append(dim, value);
    router.push(`${BASE}/papers?${sp.toString()}`);
  };

  // For Author-type entities, offer the author profile (keyed by family name —
  // heuristically the last name token).
  const isAuthor = (data?.type ?? "").toLowerCase() === "author";
  const familyName = data?.name.trim().split(/\s+/).at(-1) ?? "";

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-background">
      <header className="flex items-center gap-2 px-3 py-2 md:px-4">
        <SidebarToggle />
        <WaypointsIcon className="size-4 text-muted-foreground" />
        <h1 className="min-w-0 truncate font-semibold text-sm">
          {data?.name ?? name ?? "Entity"}
        </h1>
        {data && (
          <Badge className="shrink-0 font-normal" variant="outline">
            {data.type}
          </Badge>
        )}
      </header>

      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 pb-10">
        <Link
          className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
          href="/graph"
        >
          <ArrowLeftIcon className="size-3" />
          Knowledge Graph
        </Link>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {error && (
          <p className="text-muted-foreground text-sm">
            {(error as Error).message?.includes("404")
              ? `No entity named "${name}" in the knowledge graph.`
              : "Knowledge graph unavailable — the backend may be offline."}
          </p>
        )}

        {data && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button onClick={askAbout} size="sm" type="button">
                <MessageSquareIcon className="size-4" />
                Ask about this
              </Button>
              <Button asChild size="sm" type="button" variant="outline">
                <Link href={`/papers?deep=${encodeURIComponent(data.name)}`}>
                  <SearchIcon className="size-4" />
                  Search papers
                </Link>
              </Button>
              {isAuthor && familyName && (
                <Button asChild size="sm" type="button" variant="outline">
                  <Link href={`/authors/${encodeURIComponent(familyName)}`}>
                    <UserRoundIcon className="size-4" />
                    Author page
                  </Link>
                </Button>
              )}
            </div>

            <p className="text-muted-foreground text-xs">
              {data.degree.toLocaleString()} connection
              {data.degree === 1 ? "" : "s"} · extracted from{" "}
              {data.n_papers.toLocaleString()} paper
              {data.n_papers === 1 ? "" : "s"}
            </p>

            {data.description && (
              <section className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[13px] leading-relaxed">
                  {data.description}
                </p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Consolidated by the ingest model from every mention across
                  the corpus.
                </p>
              </section>
            )}

            {relationGroups.length > 0 && (
              <section>
                <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Connected entities
                  {data.n_relations > data.relations.length &&
                    ` — strongest ${data.relations.length} of ${data.n_relations.toLocaleString()}`}
                </h2>
                <div className="space-y-3">
                  {relationGroups.map(([groupType, rels]) => (
                    <div key={groupType}>
                      <h3 className="mb-1 text-muted-foreground text-xs">
                        {groupType}
                        <span className="ml-1 opacity-60">{rels.length}</span>
                      </h3>
                      <ul className="divide-y divide-border/50 rounded-lg border border-border">
                        {rels.map((r) => (
                          <li key={r.entity}>
                            <Link
                              className="block px-3 py-1.5 transition-colors hover:bg-accent"
                              href={entityHref(r.entity)}
                            >
                              <span className="font-medium text-[13px]">
                                {r.entity}
                              </span>
                              {r.description && (
                                <span className="mt-0.5 line-clamp-2 block text-muted-foreground text-xs leading-snug">
                                  {r.description}
                                </span>
                              )}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {data.papers.length > 0 && (
              <section>
                <h2 className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Papers
                  {data.n_papers > data.papers.length &&
                    ` — ${data.papers.length} of ${data.n_papers.toLocaleString()}`}
                </h2>
                <ul className="divide-y divide-border/60 rounded-lg border border-border">
                  {data.papers.map((p) => (
                    <li key={p.filename}>
                      <button
                        className="w-full px-3 py-2 text-left transition-colors hover:bg-accent"
                        onClick={() => setOpenFilename(p.filename)}
                        type="button"
                      >
                        <span className="line-clamp-2 text-[13px] leading-snug">
                          {p.title || p.filename.replace(/\.pdf$/i, "")}
                        </span>
                        {p.year && (
                          <span className="mt-0.5 block text-muted-foreground text-xs">
                            {p.year}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      <PaperDrawer
        filename={openFilename}
        onAddFilter={onAddFilter}
        onClose={() => setOpenFilename(null)}
        onOpenPaper={setOpenFilename}
      />
    </div>
  );
}
