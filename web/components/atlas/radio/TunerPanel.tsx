"use client";

import { useState } from "react";
import { SEQ_BLUE, STATUS } from "@/lib/atlas/palette";
import { useRadioStore } from "./radioStore";
import type { RadioEngine } from "./useRadioEngine";

const ACCENT = "#d55181";
const PRESETS = ["entropy", "humor", "semantic memory"];

/** Signal strength as a magnitude meter (sequential blue ramp, per dataviz rules). */
function SignalMeter({ level }: { level: number }) {
  const lit = Math.round(level * 5);
  return (
    <div className="flex items-end gap-1" aria-label={`signal ${Math.round(level * 100)}%`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="w-2 rounded-[2px]"
          style={{
            height: 6 + i * 3,
            background: i < lit ? SEQ_BLUE[4 + i * 2] : "var(--atlas-baseline)",
          }}
        />
      ))}
    </div>
  );
}

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-full border px-2.5 py-1 text-[11px] tracking-wider uppercase transition-colors"
      style={
        on
          ? { borderColor: ACCENT, color: ACCENT }
          : { borderColor: "var(--atlas-hairline)", color: "var(--atlas-ink-3)" }
      }
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 text-ink-2 transition-colors hover:border-white/25 hover:text-ink"
    >
      {children}
    </button>
  );
}

/**
 * The radio faceplate: the tuning dial (the one semantic knob — bias the drift
 * toward or away from a tuned topic), signal meter, and transport/voice/tones.
 */
export default function TunerPanel({ engine }: { engine: RadioEngine }) {
  const powered = useRadioStore((s) => s.powered);
  const playing = useRadioStore((s) => s.playing);
  const ttsOn = useRadioStore((s) => s.ttsOn);
  const tonesOn = useRadioStore((s) => s.tonesOn);
  const volume = useRadioStore((s) => s.volume);
  const bias = useRadioStore((s) => s.bias);
  const station = useRadioStore((s) => s.station);
  const signal = useRadioStore((s) => s.signal);
  const tuning = useRadioStore((s) => s.tuning);
  const tuneError = useRadioStore((s) => s.tuneError);
  const [draft, setDraft] = useState("");

  if (!powered) return null;

  const submit = () => {
    const q = draft.trim();
    if (q && !tuning) void engine.tune(q);
  };

  const modeLine = !station
    ? "free drift — tune a station to bias the walk"
    : bias > 0
      ? `drifting toward “${station.query}”`
      : bias < 0
        ? `drifting away from “${station.query}”`
        : `“${station.query}” tuned — dial centered, free drift`;

  return (
    <div className="hud-panel pointer-events-auto absolute right-5 bottom-5 z-40 w-[300px] p-4">
      {/* station tuner */}
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">station</p>
        {tuning && <p className="pulse-soft text-[11px] text-ink-3">tuning…</p>}
        {!tuning && tuneError && (
          <p className="text-[11px]" style={{ color: STATUS.warning }}>
            {tuneError}
          </p>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="drift toward…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-white/30 focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={tuning || !draft.trim()}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs tracking-wider text-ink-2 uppercase transition-colors hover:text-ink disabled:opacity-40"
        >
          tune
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setDraft(p);
              if (!tuning) void engine.tune(p);
            }}
            className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:text-ink-2"
          >
            {p}
          </button>
        ))}
        {station && (
          <button
            onClick={() => engine.clearStation()}
            className="ml-auto rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:text-ink"
            title="Clear station"
          >
            ✕ clear
          </button>
        )}
      </div>

      {/* the dial */}
      <div className="mt-4">
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={bias}
          disabled={!station}
          onChange={(e) => {
            let v = parseFloat(e.target.value);
            if (Math.abs(v) < 0.08) v = 0; // center detent
            engine.setBias(v);
          }}
          className="w-full disabled:opacity-30"
          style={{ accentColor: ACCENT }}
          aria-label="Drift bias dial"
        />
        <div className="flex justify-between text-[10px] tracking-widest text-ink-3 uppercase">
          <span>away</span>
          <span>free</span>
          <span>toward</span>
        </div>
        <p className="mt-1.5 min-h-4 text-xs leading-snug text-ink-2">{modeLine}</p>
      </div>

      {/* signal */}
      {station && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">signal</p>
          <div className="flex items-center gap-2">
            <SignalMeter level={signal} />
            <span className="w-8 text-right text-[11px] text-ink-2">
              {Math.round(signal * 100)}%
            </span>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-white/10 pt-3">
        {/* transport + layers */}
        <div className="flex items-center gap-2">
          <IconButton onClick={() => engine.powerOff()} title="Power off">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 3v8" />
              <path d="M17.7 7a8 8 0 1 1-11.4 0" />
            </svg>
          </IconButton>
          <IconButton onClick={() => engine.togglePlay()} title={playing ? "Pause the drift" : "Resume the drift"}>
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="4" width="5" height="16" rx="1" />
                <rect x="14" y="4" width="5" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4l14 8-14 8z" />
              </svg>
            )}
          </IconButton>
          <IconButton onClick={() => engine.skip()} title="Skip to the next passage">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 4l10 8-10 8z" />
              <rect x="17" y="4" width="3" height="16" rx="1" />
            </svg>
          </IconButton>
          <div className="ml-auto flex items-center gap-1.5">
            <Chip on={ttsOn} onClick={() => engine.setTts(!ttsOn)} title="Read passages aloud (Web Speech)">
              voice
            </Chip>
            <Chip on={tonesOn} onClick={() => engine.setTones(!tonesOn)} title="Ambient sonification (Web Audio)">
              tones
            </Chip>
          </div>
        </div>

        {/* tone volume */}
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[11px] tracking-[0.25em] text-ink-3 uppercase">vol</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={volume}
            onChange={(e) => engine.setVolume(parseFloat(e.target.value))}
            className="w-full"
            style={{ accentColor: ACCENT }}
            aria-label="Tone volume"
          />
        </div>
      </div>
    </div>
  );
}
