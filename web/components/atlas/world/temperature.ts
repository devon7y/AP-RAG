"use client";

/**
 * Hot/cold presentation for Semantle guesses (moved from the retired
 * standalone experience): a sequential single-hue ramp for magnitude on
 * dark surfaces — dim deep blue (cold) → bright blue → white-hot.
 */

export interface Band {
  label: string;
  emoji: string;
}

export function tempBand(t: number): Band {
  if (t < 20) return { label: "freezing", emoji: "🧊" };
  if (t < 40) return { label: "cold", emoji: "❄️" };
  if (t < 55) return { label: "cool", emoji: "🌫️" };
  if (t < 70) return { label: "warm", emoji: "🌡️" };
  if (t < 85) return { label: "hot", emoji: "🔥" };
  return { label: "scorching", emoji: "🌋" };
}

const TEMP_STOPS: [number, number, number, number][] = [
  [0.0, 0x27 / 255, 0x46 / 255, 0x6b / 255],
  [0.35, 0x2a / 255, 0x78 / 255, 0xd6 / 255],
  [0.6, 0x55 / 255, 0x98 / 255, 0xe7 / 255],
  [0.8, 0x9e / 255, 0xc5 / 255, 0xf4 / 255],
  [0.93, 0xe2 / 255, 0xee / 255, 0xff / 255],
  [1.0, 1, 1, 1],
];

/** temperature 0–100 → rgb floats 0..1 */
export function tempRGB(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t / 100));
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    if (x <= TEMP_STOPS[i][0]) {
      const [x0, r0, g0, b0] = TEMP_STOPS[i - 1];
      const [x1, r1, g1, b1] = TEMP_STOPS[i];
      const f = (x - x0) / (x1 - x0 || 1);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [1, 1, 1];
}

export function tempCSS(t: number): string {
  const [r, g, b] = tempRGB(t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
