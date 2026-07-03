"use client";

import { useEffect, useState } from "react";
import { fetchChunkText } from "@/lib/atlas/api";
import type { CorpusData } from "@/lib/atlas/types";
import {
  COOL,
  STEPS,
  WARM,
  apaCite,
  hitKey,
  shortCite,
  type ArithResult,
  type ChunkRec,
  type Hit,
  type Mode,
  type Trace,
} from "./engine";

/** One retrieved passage: score bar + citation + snippet, expandable to the
 *  full passage with its APA reference. */
function HitRow({
  corpus,
  hit,
  open,
  onToggle,
  onHover,
  textCache,
}: {
  corpus: CorpusData;
  hit: Hit;
  open: boolean;
  onToggle: () => void;
  onHover: (key: string | null) => void;
  textCache: Map<string, ChunkRec>;
}) {
  const paper = hit.paperIdx >= 0 ? corpus.papers[hit.paperIdx] : null;
  const section = hit.chunkIdx >= 0 ? corpus.atlas.section[hit.chunkIdx] : "";
  const snippet = hit.chunkIdx >= 0 ? corpus.atlas.snippet[hit.chunkIdx] : "";
  const [rec, setRec] = useState<ChunkRec | null>(textCache.get(hit.chunkId) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || rec) return;
    let dead = false;
    fetchChunkText(hit.chunkId).then(
      (r) => {
        if (dead) return;
        textCache.set(hit.chunkId, r);
        setRec(r);
      },
      () => {
        if (!dead) setFailed(true);
      },
    );
    return () => {
      dead = true;
    };
  }, [open, rec, hit.chunkId, textCache]);

  const doi = paper?.doi ?? "";
  const doiHref = doi ? (doi.startsWith("http") ? doi : `https://doi.org/${doi}`) : null;

  return (
    <div className="border-b border-white/10 last:border-0">
      <button
        onClick={onToggle}
        onMouseEnter={() => onHover(hitKey(hit))}
        onMouseLeave={() => onHover(null)}
        className="group w-full py-2.5 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="w-9 shrink-0 text-[10px] text-ink-3 tabular-nums">
            {hit.score.toFixed(2)}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(Math.max(hit.score, 0), 1) * 100}%`,
                background: "#3987e5",
              }}
            />
          </div>
          <span className="shrink-0 text-[10px] text-ink-3">{open ? "▾" : "▸"}</span>
        </div>
        <p className="mt-1.5 text-sm leading-snug">
          <span className="font-medium text-ink">{shortCite(corpus, hit)}</span>
          {section && <span className="text-ink-3"> · {section}</span>}
        </p>
        {snippet && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-2">{snippet}…</p>
        )}
      </button>

      {open && (
        <div className="pb-3">
          {rec ? (
            <>
              <div className="hud-scroll max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">
                {rec.text}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                {paper ? apaCite(paper) : rec.file}
                {rec.page != null && ` p. ${rec.page}.`}{" "}
                {doiHref && (
                  <a
                    href={doiHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-atlas-accent hover:underline"
                  >
                    doi ↗
                  </a>
                )}
              </p>
            </>
          ) : failed ? (
            <p className="text-xs text-ink-3">couldn’t load this passage.</p>
          ) : (
            <p className="pulse-soft text-xs text-ink-3">fetching passage…</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ResultsPanel({
  corpus,
  mode,
  trace,
  arith,
  stepIdx,
  busy,
  openChunk,
  onToggleChunk,
  onHover,
  textCache,
}: {
  corpus: CorpusData;
  mode: Mode;
  trace: Trace | null;
  arith: ArithResult | null;
  stepIdx: number;
  busy: string | null;
  openChunk: string | null;
  onToggleChunk: (id: string) => void;
  onHover: (key: string | null) => void;
  textCache: Map<string, ChunkRec>;
}) {
  const active = mode === "geodesic" ? trace : arith;

  return (
    <aside className="hud-panel hud-scroll pointer-events-auto absolute top-24 right-5 z-40 max-h-[calc(100dvh-13rem)] w-[400px] overflow-y-auto p-5">
      {busy ? (
        <p className="pulse-soft py-6 text-center text-sm text-ink-3">{busy}</p>
      ) : !active ? (
        <>
          <p className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">The instrument</p>
          <h2 className="font-display mt-2 text-xl leading-tight">
            A straight line through the literature
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Pick two ideas — a paper, an author, or any phrase. The engine places both in the
            corpus&rsquo;s 4096-dimensional embedding space and walks the geodesic between them in{" "}
            {STEPS} steps. Every waypoint runs a real vector search, so what you see is the actual
            work that sits conceptually between your endpoints, citation and all.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Or switch to <span className="text-ink">arithmetic</span>: A − B + C finds the passages
            nearest the analogy point — word2vec&rsquo;s{" "}
            <em>king − man + woman</em>, except every answer is a real page from a real paper.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ink-3">
            Try a preset in the console, then drag the slider and click any glowing marker on the
            map.
          </p>
        </>
      ) : mode === "geodesic" && trace ? (
        <>
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">
              Waypoint {stepIdx + 1} / {STEPS}
            </p>
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{
                background: `color-mix(in srgb, ${WARM} ${(stepIdx / (STEPS - 1)) * 100}%, ${COOL})`,
              }}
            />
          </div>
          <p className="mt-1.5 text-sm leading-snug">
            <span style={{ color: COOL }}>{trace.aLabel}</span>
            <span className="text-ink-3"> ⟶ </span>
            <span style={{ color: WARM }}>{trace.bLabel}</span>
          </p>
          <p className="mt-1 text-xs text-ink-3">
            the real passages nearest t = {(stepIdx / (STEPS - 1)).toFixed(2)} on the geodesic
          </p>
          <div className="mt-2">
            {trace.steps[stepIdx].hits.map((h) => (
              <HitRow
                key={hitKey(h)}
                corpus={corpus}
                hit={h}
                open={openChunk === h.chunkId}
                onToggle={() => onToggleChunk(h.chunkId)}
                onHover={onHover}
                textCache={textCache}
              />
            ))}
            {trace.steps[stepIdx].hits.length === 0 && (
              <p className="py-4 text-sm text-ink-3">nothing retrieved at this waypoint.</p>
            )}
          </div>
        </>
      ) : arith ? (
        <>
          <p className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">Embedding arithmetic</p>
          <p className="mt-1.5 text-sm leading-snug">
            {arith.anchors.map((an, i) => (
              <span key={i}>
                {i > 0 && <span className="text-ink-3"> {an.sign} </span>}
                <span style={{ color: an.color }}>{an.label}</span>
              </span>
            ))}
            <span className="text-ink-3"> ≈</span>
          </p>
          {arith.excluded > 0 && (
            <p className="mt-1 text-xs text-ink-3">
              {arith.excluded} passage{arith.excluded === 1 ? "" : "s"} from the input papers hidden
            </p>
          )}
          <div className="mt-2">
            {arith.hits.map((h, i) => (
              <div key={hitKey(h)}>
                {i === 0 && (
                  <p className="mt-1 text-[10px] tracking-widest text-ink-3 uppercase">
                    ≈ nearest passage
                  </p>
                )}
                <HitRow
                  corpus={corpus}
                  hit={h}
                  open={openChunk === h.chunkId}
                  onToggle={() => onToggleChunk(h.chunkId)}
                  onHover={onHover}
                  textCache={textCache}
                />
              </div>
            ))}
            {arith.hits.length === 0 && (
              <p className="py-4 text-sm text-ink-3">
                everything nearby came from the inputs themselves — try different terms.
              </p>
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}
