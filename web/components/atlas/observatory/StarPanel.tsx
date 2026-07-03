"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { fetchChunkText } from "@/lib/atlas/api";
import type { CorpusData } from "@/lib/atlas/types";
import { ageColor, shortCite, type ObservatoryData } from "./derive";
import { useObservatory } from "./store";

/**
 * The eyepiece: full passage text for the observed star, streamed from
 * /api/chunk, under its citation (authors/year/title/journal — convention #8).
 */

interface ChunkView {
  text: string;
  section: string;
  page: number | null;
}

const chunkCache = new Map<string, ChunkView>();

export default function StarPanel({
  data,
  corpus,
}: {
  data: ObservatoryData;
  corpus: CorpusData;
}) {
  const selection = useObservatory((s) => s.selection);
  const selectStar = useObservatory((s) => s.selectStar);
  const selectEntity = useObservatory((s) => s.selectEntity);
  const requestWarp = useObservatory((s) => s.requestWarp);

  const idx = selection?.kind === "star" ? selection.idx : null;
  const [chunk, setChunk] = useState<ChunkView | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (idx === null) return;
    const id = corpus.atlas.chunkId[idx];
    const cached = chunkCache.get(id);
    if (cached) {
      setChunk(cached);
      setState("idle");
      return;
    }
    let stale = false;
    setChunk(null);
    setState("loading");
    fetchChunkText(id).then(
      (r) => {
        if (stale) return;
        const view = { text: r.text, section: r.section, page: r.page };
        chunkCache.set(id, view);
        setChunk(view);
        setState("idle");
      },
      () => {
        if (!stale) setState("error");
      },
    );
    return () => {
      stale = true;
    };
  }, [idx, corpus, retry]);

  const paper = idx !== null ? corpus.papers[corpus.atlas.paper[idx]] : undefined;
  const year = idx !== null ? corpus.atlas.year[idx] : 0;
  const section = idx !== null ? corpus.atlas.section[idx] : "";
  const cluster = idx !== null ? data.clusterById.get(corpus.atlas.cluster[idx]) : undefined;
  const mag = idx !== null ? 6 - 5 * data.centrality[idx] : 6;
  const spectral =
    idx !== null && year > 0
      ? `#${ageColor((year - data.yearMin) / Math.max(1, data.yearMax - data.yearMin)).getHexString()}`
      : "#898781";
  const constellations = idx !== null ? (data.starEntities.get(idx) ?? []) : [];

  return (
    <AnimatePresence>
      {idx !== null && (
        <motion.aside
          key={idx}
          initial={{ opacity: 0, x: 36 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 36 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="hud-panel hud-scroll pointer-events-auto absolute top-24 right-5 z-40 max-h-[74vh] w-[400px] max-w-[92vw] overflow-y-auto p-6"
        >
          <div className="flex items-center justify-between">
            <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-[10px] font-medium tracking-[0.25em] text-ink-2 uppercase">
              Telescope · observing
            </span>
            <button
              onClick={() => selectStar(null)}
              className="text-ink-3 transition-colors hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* spectral readout */}
          <div className="mt-4 flex items-center gap-3 text-[11px] text-ink-3">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: spectral, boxShadow: `0 0 8px ${spectral}` }}
            />
            <span>{year > 0 ? year : "year unknown"}</span>
            <span title="apparent magnitude — brighter stars are more central in the knowledge graph">
              mag {mag.toFixed(1)}
            </span>
            {cluster && <span className="line-clamp-1">region · {cluster.name}</span>}
          </div>

          <h2 className="font-display mt-3 text-xl leading-snug">
            {paper?.title ?? "Unknown paper"}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
            {paper?.authors}
            {paper?.year ? ` (${paper.year})` : ""}
            {paper?.journal ? ` · ${paper.journal}` : ""}
          </p>
          {section && section !== "Untitled" && (
            <p className="mt-2 text-[11px] tracking-widest text-ink-3 uppercase">
              § {section}
              {chunk?.page != null ? ` · p. ${chunk.page}` : ""}
            </p>
          )}

          <div className="mt-4 border-t pt-4 hairline">
            {state === "loading" && (
              <p className="pulse-soft text-sm text-ink-3">collecting photons…</p>
            )}
            {state === "error" && (
              <div className="text-sm text-ink-3">
                the telescope lost the signal.{" "}
                <button
                  onClick={() => setRetry((r) => r + 1)}
                  className="text-atlas-accent underline-offset-2 hover:underline"
                >
                  refocus
                </button>
              </div>
            )}
            {state === "idle" &&
              chunk?.text.split(/\n{2,}/).map((para, i) => (
                <p
                  key={i}
                  className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-2 first:mt-0"
                >
                  {para}
                </p>
              ))}
          </div>

          {constellations.length > 0 && (
            <div className="mt-4 border-t pt-4 hairline">
              <p className="text-[11px] tracking-widest text-ink-3 uppercase">
                In constellations
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {constellations.map((eIdx) => {
                  const e = data.entities[eIdx];
                  return (
                    <button
                      key={eIdx}
                      onClick={() => selectEntity(eIdx)}
                      className="rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-white/5"
                      style={{ borderColor: `${e.color}88`, color: e.color }}
                    >
                      {e.id}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={() =>
                requestWarp(
                  [
                    data.positions[idx * 3],
                    data.positions[idx * 3 + 1],
                    data.positions[idx * 3 + 2],
                  ],
                  6.5,
                  1.8,
                )
              }
              className="rounded-full border border-atlas-accent/60 px-3 py-1 text-[11px] tracking-widest text-atlas-accent uppercase transition-colors hover:bg-atlas-accent/10"
            >
              warp to star
            </button>
            {paper?.doi && (
              <a
                href={`https://doi.org/${paper.doi}`}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              >
                doi:{paper.doi}
              </a>
            )}
          </div>

          <p className="mt-4 text-[10px] leading-relaxed text-ink-3">
            Cited as {shortCite(paper)} — a passage of this paper, one star of{" "}
            {paper?.nChunks ?? "?"} in its cluster.
          </p>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
