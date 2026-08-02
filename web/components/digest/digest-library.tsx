"use client";

import {
  CalendarClockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { formatDigestWindow } from "@/components/chat/digest-indicator";
import { SidebarToggle } from "@/components/chat/sidebar-toggle";
import { paperFetcher } from "@/components/papers/lib";
import type { DigestChatConfig } from "@/hooks/use-active-chat";
import { cn, generateUUID } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type DigestRow = {
  chatId: string;
  title: string;
  createdAt: string;
  digest: DigestChatConfig | null;
};

type DigestListResponse = { digests: DigestRow[]; papersNow: number | null };

type Unit = "months" | "years";

function ymMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function ymNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The Research Digest page: write a new digest (topic + window, optionally tracking
// the present) and revisit saved ones. Open-ended digests show how much the corpus
// has grown since their last run and can be re-run in place ("Update").
export function DigestLibrary() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, error, isLoading, mutate } = useSWR<DigestListResponse>(
    `${BASE}/api/digest`,
    paperFetcher,
    { revalidateOnFocus: false }
  );

  // ── Creator state ────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState(searchParams.get("topic") ?? "");
  const [rangeMode, setRangeMode] = useState<"past" | "custom">("past");
  const [amount, setAmount] = useState("6");
  const [unit, setUnit] = useState<Unit>("months");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [toPresent, setToPresent] = useState(true);

  const n = Math.max(1, Math.floor(Number(amount) || 0));
  const months = unit === "years" ? n * 12 : n;

  const config = (): DigestChatConfig | null => {
    const topic = prompt.trim();
    if (!topic) {
      return null;
    }
    if (rangeMode === "past") {
      // "Past N months/years" always ends now and keeps tracking it.
      return { topic, from: ymMonthsAgo(months), to: ymNow(), openEnded: true };
    }
    if (!/^\d{4}-\d{2}$/.test(customFrom)) {
      return null;
    }
    if (toPresent) {
      return { topic, from: customFrom, to: ymNow(), openEnded: true };
    }
    if (!/^\d{4}-\d{2}$/.test(customTo) || customTo < customFrom) {
      return null;
    }
    return { topic, from: customFrom, to: customTo };
  };

  const start = () => {
    const digest = config();
    if (!digest) {
      return;
    }
    const id = generateUUID();
    // `?digest=` is captured by use-active-chat, which stamps the config and auto-sends
    // the prompt as the first message — the chat opens straight into the live digest.
    router.push(
      `/chat/${id}?digest=${encodeURIComponent(JSON.stringify(digest))}`
    );
  };

  const removeDigest = (row: DigestRow) => {
    toast(`Delete "${row.digest?.topic ?? row.title}"?`, {
      action: {
        label: "Delete",
        onClick: async () => {
          await fetch(`${BASE}/api/chat?id=${row.chatId}`, {
            method: "DELETE",
          });
          mutate();
          toast.success("Digest deleted");
        },
      },
    });
  };

  const valid = config() !== null;
  const digests = data?.digests ?? [];

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-y-auto bg-background">
      <header className="flex items-center gap-2 px-3 py-2 md:px-4">
        <SidebarToggle />
        <CalendarClockIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold text-sm">Research Digest</h1>
        {digests.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {digests.length} saved
          </span>
        )}
      </header>

      <div className="mx-auto w-full max-w-4xl space-y-8 px-4 pb-10">
        {/* ── Creator ── */}
        <section className="rounded-xl border border-border bg-card/60 p-4">
          <h2 className="mb-1 font-medium text-sm">New digest</h2>
          <p className="mb-3 text-muted-foreground text-xs">
            Give a topic and a window; the digest reads the corpus and writes
            dated sections building up to now — then the chat continues
            normally. Digests that end at the present can be updated as papers
            are added.
          </p>

          <Textarea
            autoComplete="off"
            className="max-h-48 min-h-[4.5rem] resize-none text-[13px] leading-relaxed"
            maxLength={2000}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                start();
              }
            }}
            placeholder="e.g. Summarize recent work on LLM agents for autonomous research, focusing on tool use and planning"
            rows={3}
            value={prompt}
          />

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex overflow-hidden rounded-lg border border-border">
              {(
                [
                  { key: "past", label: "Past…" },
                  { key: "custom", label: "Custom range" },
                ] as const
              ).map((m) => (
                <button
                  className={cn(
                    "px-3 py-1.5 text-xs transition-colors",
                    rangeMode === m.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent"
                  )}
                  key={m.key}
                  onClick={() => setRangeMode(m.key)}
                  type="button"
                >
                  {m.label}
                </button>
              ))}
            </div>

            {rangeMode === "past" ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">Past</span>
                <Input
                  aria-label="Number of months or years"
                  className="h-8 w-16 text-center text-sm"
                  inputMode="numeric"
                  onChange={(e) =>
                    setAmount(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  value={amount}
                />
                <div className="flex overflow-hidden rounded-lg border border-border">
                  {(["months", "years"] as const).map((u) => (
                    <button
                      className={cn(
                        "px-2.5 py-1.5 text-xs capitalize transition-colors",
                        unit === u
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent"
                      )}
                      key={u}
                      onClick={() => setUnit(u)}
                      type="button"
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <span className="text-muted-foreground text-xs">
                  → present (auto-updates)
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="From month"
                  className="h-8 w-36 text-sm"
                  onChange={(e) => setCustomFrom(e.target.value)}
                  type="month"
                  value={customFrom}
                />
                <span className="text-muted-foreground">–</span>
                {toPresent ? (
                  <span className="text-muted-foreground text-sm">present</span>
                ) : (
                  <Input
                    aria-label="To month"
                    className="h-8 w-36 text-sm"
                    onChange={(e) => setCustomTo(e.target.value)}
                    type="month"
                    value={customTo}
                  />
                )}
                <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
                  <input
                    checked={toPresent}
                    onChange={(e) => setToPresent(e.target.checked)}
                    type="checkbox"
                  />
                  to present
                </label>
              </div>
            )}

            <Button
              className="ml-auto"
              disabled={!valid}
              onClick={start}
              size="sm"
              type="button"
            >
              Write the digest
            </Button>
          </div>
        </section>

        {/* ── Library ── */}
        <section>
          <h2 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Saved digests
          </h2>

          {isLoading && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
          {error && (
            <p className="text-muted-foreground text-sm">
              Couldn't load your digests.
            </p>
          )}
          {!(isLoading || error) && digests.length === 0 && (
            <p className="rounded-lg border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
              No digests yet — write one above. Digests are saved here so you
              can come back, keep chatting, and update them as the corpus
              grows.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {digests.map((row) => {
              const d = row.digest;
              if (!d) {
                return null;
              }
              const newPapers =
                d.openEnded &&
                data?.papersNow != null &&
                d.papersAtRefresh != null
                  ? Math.max(0, data.papersNow - d.papersAtRefresh)
                  : null;
              const stamp = d.refreshedAt ?? row.createdAt;
              return (
                <div
                  className="flex flex-col gap-2 rounded-xl border border-border bg-card/60 p-3.5"
                  key={row.chatId}
                >
                  <button
                    className="text-left"
                    onClick={() => router.push(`/chat/${row.chatId}`)}
                    type="button"
                  >
                    <span className="line-clamp-2 font-medium text-[13px] leading-snug hover:underline">
                      {d.topic}
                    </span>
                  </button>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                    <span className="inline-flex items-center gap-1">
                      <CalendarClockIcon className="size-3" />
                      {formatDigestWindow(d)}
                    </span>
                    <span>
                      · updated{" "}
                      {new Date(stamp).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    {newPapers != null && newPapers > 0 && (
                      <Badge className="font-normal" variant="secondary">
                        +{newPapers.toLocaleString()} paper
                        {newPapers === 1 ? "" : "s"} since last update
                      </Badge>
                    )}
                  </div>
                  <div className="mt-auto flex items-center gap-2 pt-1">
                    <Button
                      onClick={() => router.push(`/chat/${row.chatId}`)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <MessageSquareIcon className="size-3.5" />
                      Open
                    </Button>
                    {d.openEnded && (
                      <Button
                        onClick={() =>
                          router.push(`/chat/${row.chatId}?digestRefresh=1`)
                        }
                        size="sm"
                        title="Re-run the digest over its window extended to now"
                        type="button"
                        variant="outline"
                      >
                        <RefreshCwIcon className="size-3.5" />
                        Update
                      </Button>
                    )}
                    <Button
                      aria-label="Delete digest"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() => removeDigest(row)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
