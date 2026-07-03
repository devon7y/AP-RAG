"use client";

/**
 * The power button — also the user gesture that unlocks SpeechSynthesis and
 * the AudioContext. Until it's pressed the map idles silently underneath.
 */
export default function PowerOverlay({
  ready,
  onPower,
}: {
  ready: boolean;
  onPower: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
      <div className="hud-panel mx-6 w-full max-w-md p-8 text-center">
        <p className="text-[11px] tracking-[0.35em] text-ink-3 uppercase">ambient broadcast</p>
        <h2 className="font-display edr-glow mt-2 text-4xl">Radio Westbury</h2>
        <p className="mt-4 text-sm leading-relaxed text-ink-2">
          A slow random walk across 9,009 passages of the corpus, read aloud over
          tones generated from the field itself — dense regions sound rich, every
          cluster strikes its own chord, and static creeps in when you drift off
          station. One knob: tune a topic, then bias the walk toward or away
          from it.
        </p>
        <button
          onClick={onPower}
          disabled={!ready}
          aria-label="Power on"
          className="group mx-auto mt-7 flex h-20 w-20 items-center justify-center rounded-full border transition-transform hover:scale-105 disabled:opacity-40"
          style={{
            borderColor: "#d55181",
            color: "#d55181",
            boxShadow: "0 0 36px rgba(213,81,129,0.25)",
          }}
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 3v9" />
            <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
          </svg>
        </button>
        <p className="mt-4 text-xs text-ink-3">
          {ready ? "switch on — voice and tones start together" : "loading the field…"}
        </p>
      </div>
    </div>
  );
}
