"use client";

import { useEffect, useRef, useState } from "react";
import { STEPS } from "./engineBridge";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { shortCite, type WorldData } from "./derive";
import { fitArith, fitTrace } from "./fit";
import {
  endpointLabel,
  solveArithmeticWorld,
  traceGeodesicWorld,
  type WorldEndpoint,
} from "./engineBridge";
import { findAuthor } from "./parse";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * The Interpolation Engine's controls. Endpoints come from typed phrases,
 * "@author" names, or "send to interpolate" actions in the inspector
 * (via the world:set-endpoint event). The arc itself renders in ArcLayer.
 */

type Slot = "A" | "B" | "C";

interface SlotState {
  ep: WorldEndpoint;
  label: string;
}

const SLOT_COLORS: Record<Slot, string> = {
  A: "#3987e5",
  B: "#e66767",
  C: "#199e70",
};

function SlotInput({
  slot,
  label,
  state,
  onSet,
  onEnter,
  authors,
  corpus,
}: {
  slot: Slot;
  /** concrete role shown to the user ("From", "Subtract", …) */
  label: string;
  state: SlotState | null;
  onSet: (s: SlotState | null) => void;
  /** called after an Enter commit — the panel runs if all slots are filled */
  onEnter?: () => void;
  authors: AuthorRec[];
  corpus: CorpusData;
}) {
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim();
    if (!t) return;
    let ep: WorldEndpoint;
    if (t.startsWith("@")) {
      const idx = findAuthor(authors, t.slice(1));
      if (idx === null) return;
      ep = { kind: "authorRec", rec: authors[idx] };
    } else {
      ep = { kind: "phrase", text: t };
    }
    onSet({ ep, label: endpointLabel(ep, corpus) });
    setText("");
  };

  return (
    <div>
      <p className="text-[11px]" style={{ color: SLOT_COLORS[slot] }}>
        {label}
      </p>
      {state ? (
        <div
          className="mt-1 flex items-center justify-between rounded-md border px-2 py-1.5"
          style={{ borderColor: `${SLOT_COLORS[slot]}66` }}
        >
          <span className="line-clamp-1 text-xs text-ink">{state.label}</span>
          <button
            type="button"
            className="ml-2 shrink-0 text-ink-3 hover:text-ink"
            onClick={() => onSet(null)}
          >
            ✕
          </button>
        </div>
      ) : (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              onEnter?.();
            }
          }}
          onBlur={commit}
          placeholder="a phrase or @author…"
          className="mt-1 w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
      )}
    </div>
  );
}

export default function InterpolatePanel({
  data,
  corpus,
  authors,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
}) {
  const [mode, setMode] = useState<"geodesic" | "arithmetic">("geodesic");
  const [slotA, setSlotA] = useState<SlotState | null>(null);
  const [slotB, setSlotB] = useState<SlotState | null>(null);
  const [slotC, setSlotC] = useState<SlotState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trace = useWorld((s) => s.trace);
  const arith = useWorld((s) => s.arith);
  const traceT = useWorld((s) => s.traceT);
  const set = useWorld((s) => s.set);
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);

  // inspector "send to interpolate" actions
  useEffect(() => {
    const onSet = (e: Event) => {
      const { slot, ep } = (e as CustomEvent<{ slot: Slot; ep: WorldEndpoint }>).detail;
      const s: SlotState = { ep, label: endpointLabel(ep, corpus) };
      if (slot === "A") setSlotA(s);
      else if (slot === "B") setSlotB(s);
      else setSlotC(s);
    };
    window.addEventListener("world:set-endpoint", onSet);
    return () => window.removeEventListener("world:set-endpoint", onSet);
  }, [corpus]);

  // Esc clears the endpoint inputs along with everything else
  useEffect(() => {
    const clear = () => {
      setSlotA(null);
      setSlotB(null);
      setSlotC(null);
    };
    window.addEventListener("world:esc", clear);
    return () => window.removeEventListener("world:esc", clear);
  }, []);

  const run = async () => {
    if (!slotA || !slotB || busy) return;
    setError(null);
    try {
      if (mode === "geodesic") {
        setBusy("resolving…");
        const t = await traceGeodesicWorld(slotA.ep, slotB.ep, corpus, setBusy);
        set("arith", null);
        set("trace", t);
        set("traceT", 0);
        fitTrace(data, t); // frame the whole bridge
      } else {
        if (!slotC) return;
        setBusy("resolving…");
        const a = await solveArithmeticWorld(
          [
            { ep: slotA.ep, sign: "+" },
            { ep: slotB.ep, sign: "−" },
            { ep: slotC.ep, sign: "+" },
          ],
          corpus,
          setBusy,
        );
        set("trace", null);
        set("arith", a);
        fitArith(data, a);
        const top = a.hits[0];
        if (top && top.chunkIdx >= 0) select({ kind: "chunk", idx: top.chunkIdx });
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(null);
    }
  };

  // Enter in a slot input starts the engine once every field is filled
  const stateRef = useRef({ slotA, slotB, slotC, mode });
  stateRef.current = { slotA, slotB, slotC, mode };
  const runRef = useRef(run);
  runRef.current = run;
  const runOnEnter = () => {
    setTimeout(() => {
      const s = stateRef.current;
      if (s.slotA && s.slotB && (s.mode === "geodesic" || s.slotC)) {
        runRef.current();
      }
    }, 0);
  };

  const flyToChunk = (idx: number) => {
    if (idx < 0) return;
    select({ kind: "chunk", idx });
    const m = uMorph.value;
    const gx = data.chunkGround[idx * 3];
    const gy = data.chunkGroundY[idx];
    const gz = data.chunkGround[idx * 3 + 2];
    requestWarp(
      [
        gx + (data.chunkSpace[idx * 3] - gx) * m,
        gy + (data.chunkSpace[idx * 3 + 1] - gy) * m,
        gz + (data.chunkSpace[idx * 3 + 2] - gz) * m,
      ],
      7,
      1.6,
    );
  };

  const activeStep = trace ? Math.round(traceT * (STEPS - 1)) : 0;
  const stepHits = trace?.steps[activeStep]?.hits ?? [];

  // the inspector follows the slider: always show the passage living at the
  // current waypoint, no clicking required
  const topHitChunk = stepHits[0]?.chunkIdx ?? -1;
  useEffect(() => {
    if (!trace || topHitChunk < 0) return;
    select({ kind: "chunk", idx: topHitChunk });
  }, [trace, topHitChunk, select]);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
          Interpolation engine
        </p>
        <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-lg border hairline text-center text-xs">
          {(["geodesic", "arithmetic"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`py-1.5 transition-colors ${
                mode === m ? "bg-white/10 text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {m === "geodesic" ? "bridge two ideas" : "idea math"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          {mode === "geodesic"
            ? "Pick two ideas and slide between them — each point on the bridge retrieves the real passages that live there."
            : "Start with one idea, subtract a second, add a third — see which real papers live at the result. The inputs themselves are excluded."}
        </p>
      </div>

      <SlotInput
        slot="A"
        label={mode === "geodesic" ? "From" : "Start with"}
        state={slotA}
        onSet={setSlotA}
        onEnter={runOnEnter}
        authors={authors}
        corpus={corpus}
      />
      <SlotInput
        slot="B"
        label={mode === "geodesic" ? "To" : "Subtract"}
        state={slotB}
        onSet={setSlotB}
        onEnter={runOnEnter}
        authors={authors}
        corpus={corpus}
      />
      {mode === "arithmetic" && (
        <SlotInput
          slot="C"
          label="Add"
          state={slotC}
          onSet={setSlotC}
          onEnter={runOnEnter}
          authors={authors}
          corpus={corpus}
        />
      )}

      <p className="text-[10px] leading-relaxed text-ink-3">
        Shortcut: type{" "}
        <code className="text-ink-2">humor -&gt; memory</code> or{" "}
        <code className="text-ink-2">humor - comedy + recall</code> straight
        into the search bar. <code className="text-ink-2">@name</code> works as
        an endpoint here too.
      </p>

      <button
        type="button"
        disabled={!slotA || !slotB || (mode === "arithmetic" && !slotC) || busy !== null}
        onClick={run}
        className="w-full rounded-md border border-[#3987e5]/60 px-3 py-2 text-[11px] tracking-widest text-[#3987e5] uppercase disabled:opacity-30"
      >
        {busy ?? (mode === "geodesic" ? "build the bridge" : "solve")}
      </button>
      {error && <p className="text-[11px] text-[#fab219]">{error}</p>}

      {trace && (
        <div className="space-y-2 border-t hairline pt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] text-ink-2">
              {trace.aLabel} <span className="text-ink-3">→</span> {trace.bLabel}
            </p>
            <button
              type="button"
              className="text-[10px] text-ink-3 hover:text-ink"
              onClick={() => set("trace", null)}
            >
              clear
            </button>
          </div>
          <p className="text-[10px] text-ink-3">
            {trace.angleDeg.toFixed(1)}° apart in embedding space
          </p>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={traceT}
            onChange={(e) => set("traceT", Number(e.target.value))}
            className="w-full accent-[#e66767]"
          />
          <p className="text-[10px] text-ink-3">
            waypoint {activeStep + 1}/{STEPS} — passages living here:
          </p>
          <ul className="space-y-0.5">
            {stepHits.map((h) => (
              <li key={`${h.step}:${h.qid}`}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                  onClick={() => flyToChunk(h.chunkIdx)}
                >
                  <span className="tabular-nums text-ink-3">{h.score.toFixed(2)}</span>{" "}
                  <span className="line-clamp-1 inline">
                    {h.paperIdx >= 0 ? shortCite(corpus.papers[h.paperIdx]) : h.file}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {arith && (
        <div className="space-y-2 border-t hairline pt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] text-ink-2">
              {arith.anchors.map((a, i) => (
                <span key={a.label}>
                  {i > 0 && (
                    <span className="text-ink-3"> {a.sign === "−" ? "−" : "+"} </span>
                  )}
                  <span style={{ color: a.color }}>{a.label}</span>
                </span>
              ))}
            </p>
            <button
              type="button"
              className="text-[10px] text-ink-3 hover:text-ink"
              onClick={() => set("arith", null)}
            >
              clear
            </button>
          </div>
          <ul className="space-y-0.5">
            {arith.hits.map((h) => (
              <li key={h.qid}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                  onClick={() => flyToChunk(h.chunkIdx)}
                >
                  <span className="tabular-nums text-ink-3">{h.score.toFixed(2)}</span>{" "}
                  <span className="line-clamp-1 inline">
                    {h.paperIdx >= 0 ? shortCite(corpus.papers[h.paperIdx]) : h.file}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {arith.excluded > 0 && (
            <p className="text-[10px] text-ink-3">
              {arith.excluded} hits hidden (they came from the inputs)
            </p>
          )}
        </div>
      )}
    </div>
  );
}
