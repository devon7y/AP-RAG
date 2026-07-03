"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useCorpus, useKnn, LoadingVeil } from "@/lib/atlas/useCorpus";
import type { CorpusData } from "@/lib/atlas/types";
import {
  buildGraph,
  pathCost,
  pickPair,
  routeClusterNames,
  shortPaperLabel,
  type HopEdge,
  type WormholePair,
} from "./graph";
import { PLAYERS, WORMHOLE_ACCENT, type PlayerRun } from "./types";
import RacePane from "./RacePane";
import ReplayScene, { type ReplayTrail } from "./ReplayScene";

/**
 * Wormhole racing — six degrees of citation. Two papers from opposite ends of
 * the embedding space; cross from one to the other by hopping only along
 * nearest-neighbor edges, reading the actual passages as you go. Solo against
 * par, or split-screen duel. The replay draws both routes on the Atlas.
 */

type Phase = "intro" | "race" | "replay";
type Mode = "solo" | "duel";

function freshRun(startChunk: number): PlayerRun {
  return { path: [startChunk], sims: [], finished: false, gaveUp: false, ms: null };
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function winnerIndex(runs: PlayerRun[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!r.finished) continue;
    if (best === null) {
      best = i;
      continue;
    }
    const b = runs[best];
    if (r.path.length !== b.path.length) {
      if (r.path.length < b.path.length) best = i;
      continue;
    }
    const rc = pathCost(r.sims);
    const bc = pathCost(b.sims);
    if (Math.abs(rc - bc) > 1e-9) {
      if (rc < bc) best = i;
      continue;
    }
    if ((r.ms ?? Infinity) < (b.ms ?? Infinity)) best = i;
  }
  return best;
}

function PaperCard({
  corpus,
  paperIdx,
  role,
  color,
}: {
  corpus: CorpusData;
  paperIdx: number;
  role: string;
  color: string;
}) {
  const p = corpus.papers[paperIdx];
  if (!p) return null;
  return (
    <div className="hud-panel flex-1 p-5">
      <span
        className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-[0.25em] uppercase"
        style={{ borderColor: color, color }}
      >
        {role}
      </span>
      <h3 className="font-display mt-3 text-xl leading-snug">{p.title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        {p.authors}
        {p.year ? ` (${p.year})` : ""}
        {p.journal ? ` · ${p.journal}` : ""}
      </p>
      <p className="mt-2 text-[11px] text-ink-3">{p.nChunks} chunks in the field</p>
    </div>
  );
}

export default function WormholeExperience() {
  const { corpus, error } = useCorpus();
  const knn = useKnn();
  const graph = useMemo(() => (knn ? buildGraph(knn) : null), [knn]);

  const [phase, setPhase] = useState<Phase>("intro");
  const [mode, setMode] = useState<Mode>("solo");
  const [pair, setPair] = useState<WormholePair | null>(null);
  const [runs, setRuns] = useState<PlayerRun[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const raceStart = useRef(0);

  const reroll = useCallback(() => {
    if (corpus && graph) setPair(pickPair(corpus, graph));
  }, [corpus, graph]);

  useEffect(() => {
    if (corpus && graph && !pair) reroll();
  }, [corpus, graph, pair, reroll]);

  const startRace = useCallback(() => {
    if (!pair) return;
    const nPlayers = mode === "duel" ? 2 : 1;
    setRuns(Array.from({ length: nPlayers }, () => freshRun(pair.startChunk)));
    raceStart.current = performance.now();
    setElapsed(0);
    setPhase("race");
  }, [pair, mode]);

  // race clock
  useEffect(() => {
    if (phase !== "race") return;
    const iv = setInterval(() => setElapsed(performance.now() - raceStart.current), 500);
    return () => clearInterval(iv);
  }, [phase]);

  const hop = useCallback(
    (playerIdx: number, edge: HopEdge) => {
      if (!corpus || !pair) return;
      setRuns((prev) => {
        const r = prev[playerIdx];
        if (!r || r.finished || r.gaveUp) return prev;
        const finished = corpus.atlas.paper[edge.j] === pair.targetPaper;
        const next: PlayerRun = {
          path: [...r.path, edge.j],
          sims: [...r.sims, edge.sim],
          finished,
          gaveUp: false,
          ms: finished ? performance.now() - raceStart.current : null,
        };
        return prev.map((x, i) => (i === playerIdx ? next : x));
      });
    },
    [corpus, pair],
  );

  const giveUp = useCallback((playerIdx: number) => {
    setRuns((prev) =>
      prev.map((r, i) => (i === playerIdx && !r.finished ? { ...r, gaveUp: true } : r)),
    );
  }, []);

  // all racers done → replay
  useEffect(() => {
    if (phase !== "race" || runs.length === 0) return;
    if (runs.every((r) => r.finished || r.gaveUp)) {
      const t = setTimeout(() => setPhase("replay"), 1100);
      return () => clearTimeout(t);
    }
  }, [phase, runs]);

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-ink-3">
        Failed to load corpus data: {error}
      </div>
    );
  }
  if (!corpus || !graph) {
    return <LoadingVeil label="charting the wormhole…" />;
  }
  if (!pair) {
    return <LoadingVeil label="searching for opposite ends…" />;
  }

  const trails: ReplayTrail[] = runs.map((r, i) => ({
    path: r.path,
    color: PLAYERS[i].color,
  }));
  const winner = winnerIndex(runs);

  return (
    <div className="absolute inset-0">
      <AnimatePresence mode="wait">
        {/* ---------------- intro ---------------- */}
        {phase === "intro" && (
          <motion.div
            key="intro"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="hud-scroll absolute inset-0 overflow-y-auto"
          >
            <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-6 py-24">
              <p className="text-sm leading-relaxed text-ink-2">
                Two papers, opposite ends of the field. Cross from one to the other by
                hopping only to nearest-neighbor chunks — reading your way across the
                literature. Fewest hops wins; ties break on semantic drift, then time.
              </p>

              <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-stretch">
                <PaperCard corpus={corpus} paperIdx={pair.startPaper} role="start" color="#c3c2b7" />
                <div className="flex items-center justify-center px-1 font-display text-3xl text-ink-3">
                  ⟿
                </div>
                <PaperCard
                  corpus={corpus}
                  paperIdx={pair.targetPaper}
                  role="target"
                  color={WORMHOLE_ACCENT}
                />
              </div>

              <p className="mt-4 text-center text-xs text-ink-3">
                {Math.round((pair.mapDist / Math.SQRT2) * 100)}% of the map apart · shortest
                possible crossing: <span className="text-ink-2">{pair.par} hops</span>
              </p>

              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <div className="hud-panel flex overflow-hidden rounded-full p-1">
                  {(["solo", "duel"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className="rounded-full px-4 py-1.5 text-sm transition-colors"
                      style={
                        mode === m
                          ? { background: WORMHOLE_ACCENT, color: "#0d0d0d" }
                          : { color: "var(--atlas-ink-3)" }
                      }
                    >
                      {m === "solo" ? "Solo" : "Duel (split-screen)"}
                    </button>
                  ))}
                </div>
                <button
                  onClick={reroll}
                  className="rounded-full border border-hairline px-4 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink"
                >
                  ↻ new pair
                </button>
                <button
                  onClick={startRace}
                  className="rounded-full px-6 py-1.5 text-sm font-medium"
                  style={{ background: WORMHOLE_ACCENT, color: "#0d0d0d" }}
                >
                  Enter the wormhole →
                </button>
              </div>

              {mode === "duel" && (
                <p className="mt-4 text-center text-xs text-ink-3">
                  one keyboard, two racers —{" "}
                  <span style={{ color: PLAYERS[0].color }}>Player 1 hops with 1–8</span>
                  {" · "}
                  <span style={{ color: PLAYERS[1].color }}>Player 2 with Q–I</span> (or click
                  your own pane)
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* ---------------- race ---------------- */}
        {phase === "race" && (
          <motion.div
            key="race"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col gap-3 px-4 pt-20 pb-4"
          >
            <div className="flex items-center justify-center gap-4 text-xs text-ink-3">
              <span>
                reach{" "}
                <span style={{ color: WORMHOLE_ACCENT }}>
                  {shortPaperLabel(corpus, pair.targetPaper)}
                </span>
              </span>
              <span>par {pair.par}</span>
              <span className="font-mono">{fmtTime(elapsed)}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              {runs.map((run, i) => (
                <RacePane
                  key={i}
                  corpus={corpus}
                  graph={graph}
                  pair={pair}
                  run={run}
                  player={PLAYERS[i]}
                  showKeys
                  active={phase === "race"}
                  onHop={(edge) => hop(i, edge)}
                  onGiveUp={() => giveUp(i)}
                />
              ))}
            </div>
          </motion.div>
        )}

        {/* ---------------- replay ---------------- */}
        {phase === "replay" && (
          <motion.div
            key="replay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
          >
            <ReplayScene pair={pair} trails={trails} />

            <aside className="hud-panel hud-scroll absolute top-24 right-5 z-40 max-h-[70vh] w-[380px] overflow-y-auto p-6">
              <p className="font-display edr-glow text-2xl leading-tight">
                {runs.length === 2
                  ? winner !== null
                    ? `${PLAYERS[winner].name} wins`
                    : "no one crossed"
                  : runs[0]?.finished
                    ? "wormhole crossed"
                    : "the field wins this one"}
              </p>
              <p className="mt-1 text-xs text-ink-3">
                {shortPaperLabel(corpus, pair.startPaper)} ⟿{" "}
                {shortPaperLabel(corpus, pair.targetPaper)} · par {pair.par} hops
              </p>

              <div className="mt-4 space-y-4">
                {runs.map((r, i) => {
                  const via = routeClusterNames(r.path, corpus);
                  const hops = r.path.length - 1;
                  return (
                    <div key={i} className="border-t border-hairline pt-3">
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: PLAYERS[i].color }}
                        />
                        <span className="font-medium">{PLAYERS[i].name}</span>
                        {winner === i && runs.length === 2 && (
                          <span
                            className="rounded-full border px-2 py-0.5 text-[10px] tracking-widest uppercase"
                            style={{ borderColor: WORMHOLE_ACCENT, color: WORMHOLE_ACCENT }}
                          >
                            winner
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-ink-2">
                        {r.finished ? (
                          <>
                            {hops} hops · drift {pathCost(r.sims).toFixed(2)}
                            {r.ms != null && ` · ${fmtTime(r.ms)}`}
                          </>
                        ) : (
                          <>did not finish · {hops} hops wandered</>
                        )}
                      </p>
                      {via.length > 0 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                          via {via.slice(0, 5).join(" → ")}
                          {via.length > 5 ? " → …" : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {runs.length === 1 && runs[0]?.finished && (
                <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
                  {runs[0].path.length - 1 <= pair.par
                    ? "You matched the shortest possible route through the field."
                    : `The field's shortest route was ${pair.par} hops — you took ${
                        runs[0].path.length - 1
                      }.`}
                </p>
              )}

              <div className="mt-5 flex gap-2">
                <button
                  onClick={startRace}
                  className="flex-1 rounded-full px-4 py-1.5 text-sm font-medium"
                  style={{ background: WORMHOLE_ACCENT, color: "#0d0d0d" }}
                >
                  race again
                </button>
                <button
                  onClick={() => {
                    reroll();
                    setPhase("intro");
                  }}
                  className="flex-1 rounded-full border border-hairline px-4 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink"
                >
                  new wormhole
                </button>
              </div>
            </aside>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
