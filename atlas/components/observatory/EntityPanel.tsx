"use client";

import { AnimatePresence, motion } from "framer-motion";
import { SEQ_BLUE } from "@/lib/palette";
import type { CorpusData } from "@/lib/types";
import { shortCite, type ObservatoryData } from "./derive";
import { useObservatory } from "./store";

/**
 * The constellation dossier: a knowledge-graph entity, its member stars
 * (each cited), and its strongest relations to other constellations.
 */
export default function EntityPanel({
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

  const idx = selection?.kind === "entity" ? selection.idx : null;
  const entity = idx !== null ? data.entities[idx] : null;
  const edges = idx !== null ? (data.edgesByEntity.get(idx) ?? []).slice(0, 8) : [];
  const maxW = edges.length ? edges[0].w : 1;

  const warpToEntity = (eIdx: number) => {
    const e = data.entities[eIdx];
    requestWarp(
      [e.pos.x, e.pos.y, e.pos.z],
      Math.min(120, Math.max(12, e.radius * 2.2 + 6)),
      2.0,
    );
  };

  return (
    <AnimatePresence>
      {entity && (
        <motion.aside
          key={entity.idx}
          initial={{ opacity: 0, x: 36 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 36 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="hud-panel hud-scroll pointer-events-auto absolute top-24 right-5 z-40 max-h-[74vh] w-[400px] max-w-[92vw] overflow-y-auto p-6"
        >
          <div className="flex items-center justify-between">
            <span
              className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-[0.25em] uppercase"
              style={{ borderColor: entity.color, color: entity.color }}
            >
              Constellation · {entity.type}
            </span>
            <button
              onClick={() => selectEntity(null)}
              className="text-ink-3 transition-colors hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <h2 className="font-display mt-4 text-2xl leading-tight edr-glow">{entity.id}</h2>

          <div className="mt-2 flex gap-4 text-[11px] text-ink-3">
            <span>{entity.deg} relations</span>
            <span>{entity.nChunks} linked passages</span>
            <span>{entity.members.length} charted stars</span>
          </div>

          {entity.desc && (
            <p className="mt-3 text-sm leading-relaxed text-ink-2">{entity.desc}</p>
          )}

          <div className="mt-4">
            <button
              onClick={() => warpToEntity(entity.idx)}
              className="rounded-full border border-accent/60 px-3 py-1 text-[11px] tracking-widest text-accent uppercase transition-colors hover:bg-accent/10"
            >
              warp to constellation
            </button>
          </div>

          {entity.members.length > 0 && (
            <div className="mt-5 border-t pt-4 hairline">
              <p className="text-[11px] tracking-widest text-ink-3 uppercase">
                Member stars
              </p>
              <ul className="mt-2 space-y-1">
                {entity.members.map((m) => {
                  const paper = corpus.papers[corpus.atlas.paper[m]];
                  return (
                    <li key={m}>
                      <button
                        className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                        onClick={() => {
                          selectStar(m);
                          requestWarp(
                            [
                              data.positions[m * 3],
                              data.positions[m * 3 + 1],
                              data.positions[m * 3 + 2],
                            ],
                            6.5,
                            1.6,
                          );
                        }}
                      >
                        <p className="line-clamp-2 text-xs leading-snug text-ink-2">
                          {corpus.atlas.snippet[m]}
                        </p>
                        <p className="mt-0.5 text-[10px] text-ink-3">
                          {shortCite(paper)}
                          {corpus.atlas.section[m] &&
                          corpus.atlas.section[m] !== "Untitled"
                            ? ` · ${corpus.atlas.section[m]}`
                            : ""}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {edges.length > 0 && (
            <div className="mt-4 border-t pt-4 hairline">
              <p className="text-[11px] tracking-widest text-ink-3 uppercase">
                Strongest relations
              </p>
              <ul className="mt-2 space-y-1">
                {edges.map((e) => {
                  const other = data.entities[e.other];
                  return (
                    <li key={`${e.other}`}>
                      <button
                        className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                        onClick={() => {
                          selectEntity(e.other);
                          warpToEntity(e.other);
                        }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="line-clamp-1 text-xs text-ink">
                            <span
                              className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                              style={{ background: other.color }}
                            />
                            {other.id}
                          </p>
                          <span className="shrink-0 text-[10px] tabular-nums text-ink-3">
                            w {e.w.toFixed(0)}
                          </span>
                        </div>
                        <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/5">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((e.w / maxW) * 100)}%`,
                              background: SEQ_BLUE[6],
                            }}
                          />
                        </div>
                        {e.desc && (
                          <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-ink-3">
                            {e.desc}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
