"use client";

import Link from "next/link";
import { useEDR } from "@/lib/edr";

/**
 * Chrome shared by every experience: fixed top-left identity + back link,
 * full-viewport children (scenes render underneath the chrome).
 */
export default function ExperienceShell({
  title,
  tag,
  accent = "#3987e5",
  children,
  hint,
}: {
  title: string;
  tag?: string;
  accent?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  useEDR(); // keeps body[data-edr] current for CSS HDR accents

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-page">
      {children}
      <header className="pointer-events-none absolute top-0 left-0 z-40 flex items-center gap-4 p-5">
        <Link
          href="/"
          className="hud-panel pointer-events-auto px-3 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink"
        >
          ← Atlas of Mind
        </Link>
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl">{title}</h1>
          {tag && (
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] tracking-widest uppercase"
              style={{ borderColor: accent, color: accent }}
            >
              {tag}
            </span>
          )}
        </div>
      </header>
      {hint && (
        <p className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 text-xs text-ink-3">
          {hint}
        </p>
      )}
    </div>
  );
}
