"use client";

import { CalendarClockIcon } from "lucide-react";
import { useActiveChat } from "@/hooks/use-active-chat";

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "2024-06" → {y:2024, m:6}; "2024" → {y:2024, m:0}
function part(s: string): { y: number; m: number } {
  const [y, m] = s.split("-");
  return { y: Number(y), m: m ? Number(m) : 0 };
}

// Compact range label: "Jan–Jun 2024", "Nov 2023 – Feb 2024", or "2020–2024".
export function formatDigestRange(from: string, to: string): string {
  const a = part(from);
  const b = part(to);
  if (a.m === 0 || b.m === 0) {
    return a.y === b.y ? `${a.y}` : `${a.y}–${b.y}`;
  }
  if (a.y === b.y) {
    return `${MONTHS_SHORT[a.m - 1]}–${MONTHS_SHORT[b.m - 1]} ${a.y}`;
  }
  return `${MONTHS_SHORT[a.m - 1]} ${a.y} – ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

// Window label that respects open-endedness: "Jan 2024 – present" vs a fixed range.
export function formatDigestWindow(d: {
  from: string;
  to: string;
  openEnded?: boolean;
}): string {
  if (d.openEnded) {
    const a = part(d.from);
    const start = a.m > 0 ? `${MONTHS_SHORT[a.m - 1]} ${a.y}` : `${a.y}`;
    return `${start} – present`;
  }
  return formatDigestRange(d.from, d.to);
}

// Shown in the chat header while a Research Digest chat is active: the topic and window.
export function DigestIndicator() {
  const { digest } = useActiveChat();
  if (!digest) {
    return null;
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 py-1 pr-2.5 pl-2 text-xs">
      <CalendarClockIcon className="size-3.5 shrink-0 text-primary/80" />
      <span className="shrink-0 font-semibold text-foreground">Digest:</span>
      <span className="truncate font-medium text-foreground">{digest.topic}</span>
      <span className="hidden shrink-0 text-muted-foreground sm:inline">
        · {formatDigestWindow(digest)}
      </span>
    </div>
  );
}
