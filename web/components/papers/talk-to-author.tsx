"use client";

import {
  BookOpenIcon,
  MessageSquareQuoteIcon,
  ScaleIcon,
  SearchIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PageShell } from "@/components/chat/page-header";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import {
  type AuthorStat,
  formatAuthorStat,
  useAuthorStats,
} from "@/lib/aprag/author-stats";
import { cn, generateUUID } from "@/lib/utils";
import { Input } from "../ui/input";

const MAX_ROWS = 60;

// Interview a researcher in the corpus. Retrieval is scoped to their papers and the
// answer speaks in their first-person voice — the chat itself is a normal chat page,
// just author-grounded. This page replaces the old picker dialog: the same list, plus
// room to explain what the persona will and will not do before you commit to it.
export function TalkToAuthor() {
  const router = useRouter();
  const { stats, isLoading } = useAuthorStats();
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? stats.filter((s) => s.author.toLowerCase().includes(q))
      : stats;
    return base.slice(0, MAX_ROWS);
  }, [stats, query]);

  const start = (author: string) => {
    const name = author.trim();
    if (!name) {
      return;
    }
    router.push(`/chat/${generateUUID()}?author=${encodeURIComponent(name)}`);
  };

  return (
    <PageShell
      className="overflow-y-auto"
      header={
        <>
          <SidebarToggle />
          <UserRoundIcon className="size-4 text-muted-foreground" />
          <h1 className="font-semibold text-sm">Talk to Author</h1>
          {stats.length > 0 && (
            <span className="text-muted-foreground text-xs">
              {stats.length.toLocaleString()} authors
            </span>
          )}
        </>
      }
    >
      <div className="mx-auto w-full max-w-4xl space-y-8 px-4 pb-10">
        {/* ── Picker ── */}
        <section className="rounded-xl border border-border bg-card/60 p-4">
          <h2 className="mb-1 font-medium text-sm">Choose a researcher</h2>
          <p className="mb-3 text-muted-foreground text-xs">
            Every first author in the corpus, ranked by how much of their
            writing is indexed. Pick one to open a chat where they answer as
            themselves, only from their own papers.
          </p>

          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground" />
            <Input
              autoComplete="off"
              className="h-9 pl-9"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  start(shown[0]?.author ?? query);
                }
              }}
              placeholder="Search an author by surname…"
              value={query}
            />
          </div>

          <ul className="-mr-1 mt-2 max-h-[52vh] space-y-0.5 overflow-y-auto pr-1">
            {shown.map((s: AuthorStat, i) => (
              <li className="flex items-center gap-1" key={s.author}>
                <button
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
                    i === 0 && query.trim() && "bg-accent/40"
                  )}
                  onClick={() => start(s.author)}
                  type="button"
                >
                  <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium text-sm">
                    {s.author}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatAuthorStat(s)}
                  </span>
                </button>
                {/* Sibling of the button, not nested inside it — a link within a
                    button is invalid markup and swallows the row's click. */}
                <Link
                  className="shrink-0 rounded-lg px-2 py-2 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                  href={`/authors/${encodeURIComponent(s.author)}`}
                  title={`${s.author}'s papers, topics, and co-authors`}
                >
                  Profile
                </Link>
              </li>
            ))}

            {shown.length === 0 && (
              <li className="px-2.5 py-6 text-center text-muted-foreground text-sm">
                {isLoading
                  ? "Loading authors…"
                  : query.trim()
                    ? `No author matches “${query.trim()}”. Press Enter to try it anyway.`
                    : "No authors found."}
              </li>
            )}
          </ul>
        </section>

        {/* ── Explainer ── */}
        <section className="space-y-3">
          <h2 className="font-medium text-sm">How it works</h2>
          <ol className="space-y-3">
            {[
              {
                title: "Retrieval is locked to their papers",
                body: "Your question searches only papers that author wrote — as first author or as a collaborator — instead of the whole corpus. Nothing from anyone else's work can reach the answer.",
              },
              {
                title: "They answer in the first person",
                body: "The same model that writes normal answers is told it is that researcher, and it mirrors the tone and vocabulary of their own retrieved writing rather than a generic assistant voice.",
              },
              {
                title: "Papers they led are told apart from papers they joined",
                body: "Each retrieved passage is tagged by authorship position. A paper they led is spoken of as my study; one they co-authored is work I contributed to — so credit is never overstated.",
              },
              {
                title: "Every claim carries a citation",
                body: "Statements are cited with the same numbered references as a normal chat, so you can open the exact paper and page behind anything they say.",
              },
            ].map((step, i) => (
              <li
                className="flex gap-3 rounded-xl border border-border bg-card/60 p-4"
                key={step.title}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent font-medium text-muted-foreground text-xs">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium text-sm">{step.title}</h3>
                  <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Expectations ── */}
        <section className="space-y-3">
          <h2 className="font-medium text-sm">What to expect</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              {
                icon: BookOpenIcon,
                title: "It stays inside the papers",
                body: "Ask about something they never published on and they will say so plainly rather than answering from general knowledge.",
              },
              {
                icon: ScaleIcon,
                title: "It defends its findings",
                body: "Challenge a result and they argue for it from the evidence — but concede when the passages do not support the rebuttal.",
              },
              {
                icon: MessageSquareQuoteIcon,
                title: "It is a reconstruction",
                body: "This is their writing spoken back to you, not the researcher. Treat it as a way to read their work, and check the citations.",
              },
            ].map((note) => (
              <div
                className="rounded-xl border border-border bg-card/60 p-4"
                key={note.title}
              >
                <note.icon className="mb-2 size-4 text-muted-foreground" />
                <h3 className="font-medium text-sm">{note.title}</h3>
                <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
                  {note.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
