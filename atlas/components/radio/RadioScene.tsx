"use client";

import { LoadingVeil, useCorpus, useKnn } from "@/lib/useCorpus";
import DriftMap from "./DriftMap";
import LyricsPanel from "./LyricsPanel";
import NowPlaying from "./NowPlaying";
import PowerOverlay from "./PowerOverlay";
import TunerPanel from "./TunerPanel";
import { useRadioStore } from "./radioStore";
import { useRadioEngine } from "./useRadioEngine";

function OnAirBadge() {
  const powered = useRadioStore((s) => s.powered);
  const playing = useRadioStore((s) => s.playing);
  if (!powered) return null;
  return (
    <div className="hud-panel pointer-events-none absolute top-5 right-5 z-40 flex items-center gap-2 px-3 py-1.5">
      <span
        className={`inline-block h-2 w-2 rounded-full ${playing ? "pulse-soft" : ""}`}
        style={{ background: playing ? "#d03b3b" : "#898781" }}
      />
      <span className="text-[11px] tracking-[0.3em] text-ink-2 uppercase">
        {playing ? "on air" : "standby"}
      </span>
    </div>
  );
}

export default function RadioScene() {
  const { corpus, error } = useCorpus();
  const knn = useKnn();
  const engine = useRadioEngine(corpus, knn);
  const powered = useRadioStore((s) => s.powered);
  const ready = corpus !== null && knn !== null;

  return (
    <div className="absolute inset-0">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!corpus && !error && <LoadingVeil label="warming the transmitter…" />}
      {corpus && (
        <>
          <DriftMap corpus={corpus} />
          <OnAirBadge />
          <LyricsPanel />
          <NowPlaying corpus={corpus} />
          <TunerPanel engine={engine} />
          {!powered && <PowerOverlay ready={ready} onPower={engine.powerOn} />}
        </>
      )}
    </div>
  );
}
