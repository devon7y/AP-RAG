"use client";

import { UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  type AuthorStat,
  formatAuthorStat,
  useAuthorStats,
} from "@/lib/aprag/author-stats";
import { cn, generateUUID } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const MAX_ROWS = 40;

// Pick an author to interview. Retrieval is scoped to their papers and the answer speaks
// in their first-person voice — a normal chat page, just author-grounded.
export function TalkToAuthorDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
    onOpenChange(false);
    setQuery("");
    const id = generateUUID();
    router.push(`/chat/${id}?author=${encodeURIComponent(name)}`);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Talk to an author</DialogTitle>
          <DialogDescription>
            Interview a researcher in the corpus. They answer only from papers they wrote —
            every claim cited — and speak of a paper as their own only when they led it.
          </DialogDescription>
        </DialogHeader>

        <Input
          autoComplete="off"
          autoFocus
          className="h-9"
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

        <ul className="-mr-1 max-h-[46vh] space-y-0.5 overflow-y-auto pr-1">
          {shown.map((s: AuthorStat, i) => (
            <li key={s.author}>
              <button
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent",
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
      </DialogContent>
    </Dialog>
  );
}
