"use client";

import type { CorpusData } from "@/lib/types";
import EndpointPicker from "./EndpointPicker";
import {
  COOL,
  STEPS,
  THIRD,
  WARM,
  type ArithResult,
  type Endpoint,
  type Mode,
  type Trace,
} from "./engine";

interface GeoPreset {
  label: string;
  a: Endpoint;
  b: Endpoint;
}
interface ArithPreset {
  label: string;
  a: Endpoint;
  b: Endpoint;
  c: Endpoint;
}

const GEO_PRESETS: GeoPreset[] = [
  {
    label: "semantic memory ⟶ LLMs",
    a: { kind: "phrase", text: "semantic memory and the structure of word meaning" },
    b: { kind: "phrase", text: "large language models as models of human cognition" },
  },
  {
    label: "EEG ⟶ chatbot romance",
    a: { kind: "phrase", text: "EEG neural signatures of learning and feedback" },
    b: { kind: "phrase", text: "romantic relationships between humans and AI chatbots" },
  },
];

const ARITH_PRESETS: ArithPreset[] = [
  {
    label: "LLM − machine + human",
    a: { kind: "phrase", text: "large language models" },
    b: { kind: "phrase", text: "artificial neural networks and machines" },
    c: { kind: "phrase", text: "human participants in psychology experiments" },
  },
];

export default function ConsolePanel({
  corpus,
  mode,
  setMode,
  epA,
  setEpA,
  epB,
  setEpB,
  epC,
  setEpC,
  busy,
  error,
  trace,
  arith,
  onTrace,
  onSolve,
  onSwap,
  onGeoPreset,
  onArithPreset,
}: {
  corpus: CorpusData;
  mode: Mode;
  setMode: (m: Mode) => void;
  epA: Endpoint | null;
  setEpA: (e: Endpoint | null) => void;
  epB: Endpoint | null;
  setEpB: (e: Endpoint | null) => void;
  epC: Endpoint | null;
  setEpC: (e: Endpoint | null) => void;
  busy: string | null;
  error: string | null;
  trace: Trace | null;
  arith: ArithResult | null;
  onTrace: () => void;
  onSolve: () => void;
  onSwap: () => void;
  onGeoPreset: (a: Endpoint, b: Endpoint) => void;
  onArithPreset: (a: Endpoint, b: Endpoint, c: Endpoint) => void;
}) {
  const geo = mode === "geodesic";
  const ready = geo ? !!(epA && epB) : !!(epA && epB && epC);
  const passageTotal = trace?.steps.reduce((s, st) => s + st.hits.length, 0) ?? 0;

  return (
    <div className="hud-panel pointer-events-auto absolute top-24 left-5 z-40 w-[330px] p-4">
      {/* mode tabs */}
      <div className="flex gap-1 rounded-lg border border-white/10 bg-black/30 p-1">
        {(
          [
            ["geodesic", "Geodesic slider"],
            ["arithmetic", "A − B + C"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
              mode === m ? "bg-white/10 text-ink" : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        {geo
          ? "slerp between two ideas — every waypoint retrieves the passages that really live there."
          : "vector arithmetic over the corpus: the answer to A − B + C is a real cited passage."}
      </p>

      {/* endpoint slots */}
      <div className="mt-3 space-y-2">
        <EndpointPicker
          slot="A"
          color={COOL}
          endpoint={epA}
          onChange={setEpA}
          corpus={corpus}
          placeholder="paper, author, or phrase…"
        />
        {geo && (
          <div className="flex justify-center">
            <button
              onClick={onSwap}
              disabled={!epA && !epB}
              className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-ink-3 transition-colors hover:text-ink disabled:opacity-40"
              title="swap A and B"
            >
              ⇅ swap
            </button>
          </div>
        )}
        <EndpointPicker
          slot={geo ? "B" : "−B"}
          color={WARM}
          endpoint={epB}
          onChange={setEpB}
          corpus={corpus}
          placeholder={geo ? "the other idea…" : "what to subtract…"}
        />
        {!geo && (
          <EndpointPicker
            slot="+C"
            color={THIRD}
            endpoint={epC}
            onChange={setEpC}
            corpus={corpus}
            placeholder="what to add…"
          />
        )}
      </div>

      {/* CTA */}
      <button
        onClick={geo ? onTrace : onSolve}
        disabled={!ready || !!busy}
        className="mt-3 w-full rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          borderColor: "#e6676788",
          background: "#e6676722",
          color: "#ffb3b3",
        }}
      >
        {geo ? "Trace the geodesic" : "Solve A − B + C"}
      </button>

      {/* presets */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] tracking-widest text-ink-3 uppercase">try:</span>
        {geo
          ? GEO_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => onGeoPreset(p.a, p.b)}
                disabled={!!busy}
                className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-white/25 hover:text-ink disabled:opacity-40"
              >
                {p.label}
              </button>
            ))
          : ARITH_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => onArithPreset(p.a, p.b, p.c)}
                disabled={!!busy}
                className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-white/25 hover:text-ink disabled:opacity-40"
              >
                {p.label}
              </button>
            ))}
      </div>

      {/* status */}
      <div className="mt-3 min-h-[1.1rem] text-xs">
        {busy ? (
          <span className="pulse-soft text-ink-2">{busy}</span>
        ) : error ? (
          <span style={{ color: WARM }}>{error}</span>
        ) : geo && trace ? (
          <span className="text-ink-3">
            Δ {trace.angleDeg.toFixed(1)}° · {STEPS} waypoints · {passageTotal} passages on the
            path
          </span>
        ) : !geo && arith ? (
          <span className="text-ink-3">
            {arith.hits.length} nearest passages{arith.excluded > 0 && ` · ${arith.excluded} input hits excluded`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
