"use client";

/**
 * Thin SpeechSynthesis wrapper for the radio voice. One sentence per utterance
 * (long utterances stall on Chromium); every speak() carries a watchdog so a
 * silently-dropped utterance can never freeze the broadcast.
 */

let cachedVoice: SpeechSynthesisVoice | null = null;
let voicesHooked = false;

const PREFERRED = [
  "Samantha",
  "Ava",
  "Karen",
  "Daniel",
  "Moira",
  "Alex",
  "Google US English",
  "Google UK English Female",
];

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = en.length ? en : voices;
  for (const name of PREFERRED) {
    const v = pool.find((p) => p.name.includes(name));
    if (v) return v;
  }
  return pool.find((v) => v.localService) ?? pool[0];
}

/** Warm the voice list (async on most browsers) and unlock speech on a gesture. */
export function primeVoices(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  cachedVoice = pickVoice();
  if (!voicesHooked) {
    voicesHooked = true;
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      cachedVoice = pickVoice();
    });
  }
  // Zero-volume nudge inside the user gesture unlocks TTS on strict browsers.
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    /* no speech available — the radio still plays tones + lyrics */
  }
}

export function ttsAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export interface SpeakHandle {
  done: Promise<void>;
  cancel: () => void;
}

/**
 * Speak one sentence. Resolves on end, error, cancel, or watchdog timeout —
 * never rejects, never hangs.
 */
export function speak(text: string, volume = 1): SpeakHandle {
  if (!ttsAvailable()) {
    return { done: Promise.resolve(), cancel: () => {} };
  }
  const synth = window.speechSynthesis;
  let settle: () => void = () => {};
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let settled = false;

  const done = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (keepAlive) clearInterval(keepAlive);
      resolve();
    };
  });

  const u = new SpeechSynthesisUtterance(text);
  if (!cachedVoice) cachedVoice = pickVoice();
  if (cachedVoice) u.voice = cachedVoice;
  u.rate = 0.97;
  u.pitch = 1.0;
  u.volume = Math.min(1, Math.max(0, volume));
  u.onend = () => settle();
  u.onerror = () => settle();

  const words = text.split(/\s+/).length;
  watchdog = setTimeout(() => {
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
    settle();
  }, Math.min(45000, Math.max(6000, words * 520 + 3000)));

  // Chromium pauses long-running synthesis when it feels like it; nudge it.
  keepAlive = setInterval(() => {
    if (synth.speaking && !synth.paused) return;
    try {
      synth.resume();
    } catch {
      /* ignore */
    }
  }, 8000);

  try {
    synth.speak(u);
    synth.resume();
  } catch {
    settle();
  }

  return {
    done,
    cancel: () => {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      settle();
    },
  };
}

export function cancelSpeech(): void {
  if (!ttsAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}
