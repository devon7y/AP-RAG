"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchChunkText } from "@/lib/api";
import type { CorpusData } from "@/lib/types";
import type { HopEdge, WormholeGraph, WormholePair } from "./graph";
import { pathCost } from "./graph";
import type { PlayerMeta, PlayerRun } from "./types";
import { WORMHOLE_ACCENT } from "./types";
import MiniMap from "./MiniMap";

/**
 * One racer's cockpit: the current passage (full text streamed from the PC),
 * the nearest-neighbor hop options, a proximity meter and a minimap.
 * Purely presentational — the parent owns the run state and applies hops.
 */

interface PassageState {
  text: string;
  section: string;
  page: number | null;
  fallback: boolean;
}

const passageCache = new Map<string, Promise<PassageState>>();

function loadPassage(chunkId: string, fallbackSnippet: string): Promise<PassageState> {
  let p = passageCache.get(chunkId);
  if (!p) {
    p = fetchChunkText(chunkId)
      .then((r) => ({ text: r.text, section: r.section, page: r.page, fallback: false }))
      .catch(() => {
        passageCache.delete(chunkId); // allow retry on next visit
        return { text: fallbackSnippet, section: "", page: null, fallback: true };
      });
    passageCache.set(chunkId, p);
  }
  return p;
}

function simBarWidth(sim: number): string {
  return `${Math.round(Math.min(1, Math.max(0.06, (sim - 0.45) / 0.55)) * 100)}%`;
}

export default function RacePane({
  corpus,
  graph,
  pair,
  run,
  player,
  showKeys,
  active,
  onHop,
  onGiveUp,
}: {
  corpus: CorpusData;
  graph: WormholeGraph;
  pair: WormholePair;
  run: PlayerRun;
  player: PlayerMeta;
  /** duel mode: label options with this player's keys and listen for them */
  showKeys: boolean;
  /** race in progress (keyboard live) */
  active: boolean;
  onHop: (edge: HopEdge) => void;
  onGiveUp: () => void;
}) {
  const { atlas, papers } = corpus;
  const current = run.path[run.path.length - 1];
  const previous = run.path.length > 1 ? run.path[run.path.length - 2] : -1;
  const playing = active && !run.finished && !run.gaveUp;

  const edges = graph.adj[current] ?? [];
  const visited = useMemo(() => new Set(run.path), [run.path]);

  // --- passage text ---
  const chunkId = atlas.chunkId[current];
  const [passage, setPassage] = useState<PassageState | null>(null);
  const passageBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setPassage(null);
    loadPassage(chunkId, atlas.snippet[current] ?? "").then((p) => {
      if (alive) setPassage(p);
    });
    passageBox.current?.scrollTo({ top: 0 });
    return () => {
      alive = false;
    };
  }, [chunkId, atlas, current]);

  // --- keyboard hops ---
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const slot = player.keys.indexOf(e.key.toLowerCase());
      if (slot < 0) return;
      const edge = edgesRef.current[slot];
      if (edge) {
        e.preventDefault();
        onHop(edge);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, player.keys, onHop]);

  // --- proximity to target (map-space, honest proxy) ---
  const target = papers[pair.targetPaper];
  const proximity = useMemo(() => {
    const d = (chunk: number) =>
      Math.hypot(
        atlas.pos2[chunk * 2] - target.centroid[0],
        atlas.pos2[chunk * 2 + 1] - target.centroid[1],
      );
    const dStart = d(pair.startChunk);
    if (dStart < 1e-6) return 1;
    return Math.min(1, Math.max(0, 1 - d(current) / dStart));
  }, [atlas, target, pair.startChunk, current]);

  const paperIdx = atlas.paper[current];
  const paper = papers[paperIdx];
  const hops = run.path.length - 1;
  const drift = pathCost(run.sims);

  return (
    <section
      className="hud-panel relative flex min-h-0 flex-1 flex-col overflow-hidden p-4"
      style={{ borderColor: `color-mix(in srgb, ${player.color} 35%, transparent)` }}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: player.color }}
            />
            <span className="text-sm font-medium">{player.name}</span>
            <span className="text-xs text-ink-3">
              {hops} {hops === 1 ? "hop" : "hops"} · drift {drift.toFixed(2)}
            </span>
          </div>
          <div className="mt-2 max-w-64">
            <div className="flex items-baseline justify-between text-[10px] tracking-widest text-ink-3 uppercase">
              <span>proximity to target</span>
              <span>{Math.round(proximity * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.max(2, proximity * 100)}%`,
                  background: WORMHOLE_ACCENT,
                }}
              />
            </div>
          </div>
        </div>
        <MiniMap corpus={corpus} path={run.path} targetPaper={pair.targetPaper} color={player.color} />
      </div>

      {/* current passage */}
      <div ref={passageBox} className="hud-scroll mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
        <p className="text-[11px] leading-snug text-ink-3">
          {paper?.authors}
          {paper?.year ? ` (${paper.year})` : ""}
          {paper?.journal ? ` · ${paper.journal}` : ""}
        </p>
        <h3 className="font-display mt-0.5 text-lg leading-snug">{paper?.title}</h3>
        {(passage?.section || atlas.section[current]) && (
          <span className="mt-1.5 inline-block rounded-full border border-hairline px-2 py-0.5 text-[10px] tracking-widest text-ink-3 uppercase">
            {passage?.section || atlas.section[current]}
            {passage?.page != null ? ` · p. ${passage.page}` : ""}
          </span>
        )}
        {passage ? (
          <p className="mt-2.5 text-sm leading-relaxed whitespace-pre-line text-ink-2">
            {passage.text}
          </p>
        ) : (
          <p className="pulse-soft mt-2.5 text-sm text-ink-3">retrieving passage…</p>
        )}
        {passage?.fallback && (
          <p className="mt-2 text-[11px] text-ink-3 italic">
            full text unavailable (server unreachable) — showing the stored snippet
          </p>
        )}
      </div>

      {/* hop options */}
      <div className="mt-3 border-t border-hairline pt-2">
        <p className="text-[10px] tracking-widest text-ink-3 uppercase">
          nearest neighbors · {edges.length} exits
        </p>
        <div className="hud-scroll mt-1.5 grid max-h-[30vh] grid-cols-1 gap-1.5 overflow-y-auto pr-1 xl:grid-cols-2">
          {edges.map((edge, slot) => {
            const p = papers[atlas.paper[edge.j]];
            const isTarget = atlas.paper[edge.j] === pair.targetPaper;
            const isBack = edge.j === previous;
            const seen = visited.has(edge.j);
            return (
              <button
                key={edge.j}
                disabled={!playing}
                onClick={() => onHop(edge)}
                className="group rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50"
                style={{
                  borderColor: isTarget
                    ? WORMHOLE_ACCENT
                    : "color-mix(in srgb, white 10%, transparent)",
                  background: isTarget
                    ? "color-mix(in srgb, #199e70 12%, transparent)"
                    : "color-mix(in srgb, white 3%, transparent)",
                }}
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  {showKeys && slot < player.keys.length && (
                    <kbd
                      className="rounded border border-hairline px-1 font-mono text-[10px] uppercase"
                      style={{ color: player.color }}
                    >
                      {player.keys[slot]}
                    </kbd>
                  )}
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {p?.authors.split(/[,;&]/)[0]?.trim()}
                    {p?.year ? ` (${p.year})` : ""}
                    {atlas.section[edge.j] ? ` · ${atlas.section[edge.j]}` : ""}
                  </span>
                  {isTarget && (
                    <span className="shrink-0 font-medium" style={{ color: WORMHOLE_ACCENT }}>
                      → target
                    </span>
                  )}
                  {isBack && !isTarget && <span className="shrink-0 text-ink-3">↩ back</span>}
                  {seen && !isBack && !isTarget && (
                    <span className="shrink-0 text-ink-3">visited</span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-3">
                  {atlas.snippet[edge.j]}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="h-0.5 flex-1 overflow-hidden rounded bg-white/10">
                    <div
                      className="h-full rounded"
                      style={{ width: simBarWidth(edge.sim), background: "#5598e7" }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-ink-3">{edge.sim.toFixed(3)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* footer */}
      {playing && (
        <button
          onClick={onGiveUp}
          className="absolute top-3 right-3 rounded-full border border-hairline px-2 py-0.5 text-[10px] tracking-wider text-ink-3 uppercase transition-colors hover:text-ink"
        >
          give up
        </button>
      )}

      {/* end-of-run veil */}
      {(run.finished || run.gaveUp) && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <div className="text-center">
            <p
              className="font-display text-3xl"
              style={{ color: run.finished ? WORMHOLE_ACCENT : "#898781" }}
            >
              {run.finished ? "wormhole crossed" : "did not finish"}
            </p>
            {run.finished && (
              <p className="mt-2 text-sm text-ink-2">
                {hops} hops · drift {drift.toFixed(2)}
                {run.ms != null && ` · ${(run.ms / 1000).toFixed(1)}s`}
              </p>
            )}
            <p className="mt-1 text-xs text-ink-3">waiting for the field…</p>
          </div>
        </div>
      )}
    </section>
  );
}
