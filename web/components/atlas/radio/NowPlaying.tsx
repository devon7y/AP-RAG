"use client";

import type { CorpusData } from "@/lib/atlas/types";
import { useRadioStore } from "./radioStore";
import { cleanTerms } from "./walk";

/** Citation strip for the passage on air: authors (year) · title · venue · section · page. */
export default function NowPlaying({ corpus }: { corpus: CorpusData }) {
  const powered = useRadioStore((s) => s.powered);
  const np = useRadioStore((s) => s.nowPlaying);
  const current = useRadioStore((s) => s.current);
  const stepCount = useRadioStore((s) => s.stepCount);

  if (!powered || !np) return null;

  const cluster = current !== null ? corpus.atlas.cluster[current] : null;
  const region =
    cluster !== null ? cleanTerms(corpus.clusters[cluster]?.terms ?? []).join(" · ") : "";
  const meta = [
    np.journal || null,
    np.section ? `§ ${np.section}` : null,
    np.page !== null && np.page !== undefined ? `p. ${np.page}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="hud-panel pointer-events-none absolute bottom-5 left-1/2 z-30 w-[min(86vw,40rem)] -translate-x-1/2 px-5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="truncate text-[11px] tracking-[0.25em] text-ink-3 uppercase">
          now playing{region ? ` · ${region}` : ""}
        </p>
        <p className="shrink-0 text-[11px] text-ink-3">hop {stepCount}</p>
      </div>
      <p className="mt-1 truncate text-sm text-ink" title={`${np.authors} (${np.year}). ${np.title}`}>
        <span className="text-ink-2">
          {np.authors} ({np.year}).
        </span>{" "}
        {np.title}
      </p>
      {meta && <p className="truncate text-xs text-ink-3">{meta}</p>}
    </div>
  );
}
