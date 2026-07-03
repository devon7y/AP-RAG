"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { LoadingVeil, useCorpus } from "@/lib/atlas/useCorpus";
import type { CorpusData } from "@/lib/atlas/types";
import ConsolePanel from "./ConsolePanel";
import GeodesicSlider from "./GeodesicSlider";
import PathScene from "./PathScene";
import ResultsPanel from "./ResultsPanel";
import {
  STEPS,
  solveArithmetic,
  traceGeodesic,
  type ArithResult,
  type ChunkRec,
  type Endpoint,
  type Hit,
  type Mode,
  type Trace,
} from "./engine";

function Engine({ corpus }: { corpus: CorpusData }) {
  const [mode, setMode] = useState<Mode>("geodesic");
  const [epA, setEpA] = useState<Endpoint | null>(null);
  const [epB, setEpB] = useState<Endpoint | null>(null);
  const [epC, setEpC] = useState<Endpoint | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [arith, setArith] = useState<ArithResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState(0.5);
  const tRef = useRef(0.5);
  // mirror t into a ref so the canvas can read it per-frame without re-rendering
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [openChunk, setOpenChunk] = useState<string | null>(null);
  const seq = useRef(0);
  const textCache = useMemo(() => new Map<string, ChunkRec>(), []);

  const stepIdx = Math.round(t * (STEPS - 1));

  const runTrace = useCallback(
    async (a: Endpoint | null, b: Endpoint | null) => {
      if (!a || !b) return;
      const id = ++seq.current;
      setBusy("starting…");
      setError(null);
      try {
        const tr = await traceGeodesic(a, b, corpus, (m) => {
          if (seq.current === id) setBusy(m);
        });
        if (seq.current !== id) return;
        setTrace(tr);
        setOpenChunk(null);
        setT(0.5);
        setBusy(null);
      } catch (e) {
        if (seq.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [corpus, setT],
  );

  const runSolve = useCallback(
    async (a: Endpoint | null, b: Endpoint | null, c: Endpoint | null) => {
      if (!a || !b || !c) return;
      const id = ++seq.current;
      setBusy("starting…");
      setError(null);
      try {
        const res = await solveArithmetic(a, b, c, corpus, (m) => {
          if (seq.current === id) setBusy(m);
        });
        if (seq.current !== id) return;
        setArith(res);
        setOpenChunk(null);
        setBusy(null);
      } catch (e) {
        if (seq.current !== id) return;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [corpus],
  );

  const onPickHit = useCallback(
    (h: Hit) => {
      if (h.step >= 0) setT(h.step / (STEPS - 1));
      setOpenChunk(h.chunkId);
    },
    [setT],
  );

  const onPickStep = useCallback((i: number) => setT(i / (STEPS - 1)), [setT]);

  const onSwap = useCallback(() => {
    setEpA(epB);
    setEpB(epA);
  }, [epA, epB]);

  const onGeoPreset = useCallback(
    (a: Endpoint, b: Endpoint) => {
      setMode("geodesic");
      setEpA(a);
      setEpB(b);
      void runTrace(a, b);
    },
    [runTrace],
  );

  const onArithPreset = useCallback(
    (a: Endpoint, b: Endpoint, c: Endpoint) => {
      setMode("arithmetic");
      setEpA(a);
      setEpB(b);
      setEpC(c);
      void runSolve(a, b, c);
    },
    [runSolve],
  );

  return (
    <>
      <HDRCanvas
        camera={{ position: [0, 46, 78], fov: 55, near: 0.1, far: 400 }}
        clearColor={0x08070c}
      >
        <PathScene
          corpus={corpus}
          mode={mode}
          trace={trace}
          arith={arith}
          stepIdx={stepIdx}
          tRef={tRef}
          hoverKey={hoverKey}
          openChunk={openChunk}
          onPickStep={onPickStep}
          onPickHit={onPickHit}
          onHover={setHoverKey}
        />
      </HDRCanvas>

      <ConsolePanel
        corpus={corpus}
        mode={mode}
        setMode={setMode}
        epA={epA}
        setEpA={setEpA}
        epB={epB}
        setEpB={setEpB}
        epC={epC}
        setEpC={setEpC}
        busy={busy}
        error={error}
        trace={trace}
        arith={arith}
        onTrace={() => void runTrace(epA, epB)}
        onSolve={() => void runSolve(epA, epB, epC)}
        onSwap={onSwap}
        onGeoPreset={onGeoPreset}
        onArithPreset={onArithPreset}
      />

      <ResultsPanel
        corpus={corpus}
        mode={mode}
        trace={trace}
        arith={arith}
        stepIdx={stepIdx}
        busy={busy}
        openChunk={openChunk}
        onToggleChunk={(id) => setOpenChunk((cur) => (cur === id ? null : id))}
        onHover={setHoverKey}
        textCache={textCache}
      />

      {mode === "geodesic" && trace && (
        <GeodesicSlider
          t={t}
          onT={setT}
          stepIdx={stepIdx}
          aLabel={trace.aLabel}
          bLabel={trace.bLabel}
          angleDeg={trace.angleDeg}
        />
      )}
    </>
  );
}

export default function InterpolateSceneRoot() {
  const { corpus, error } = useCorpus();
  return (
    <div className="absolute inset-0">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!corpus && !error && <LoadingVeil label="loading the semantic map…" />}
      {corpus && <Engine corpus={corpus} />}
    </div>
  );
}
