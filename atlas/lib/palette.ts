/**
 * Design tokens — dark mode is the app's native mode (validated dataviz palette,
 * dark-surface steps). Categorical slots are assigned in this fixed order.
 */
export const INK = {
  surface: "#1a1a19",
  page: "#0d0d0d",
  primary: "#ffffff",
  secondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  baseline: "#383835",
  border: "rgba(255,255,255,0.10)",
} as const;

/** Dark-surface categorical slots, fixed order — never cycled per-series in charts.
 *  For map-region tints (identity carried by direct labels) hues repeat by rank. */
export const CATEGORICAL = [
  "#3987e5", // blue
  "#199e70", // aqua
  "#c98500", // yellow
  "#008300", // green
  "#9085e9", // violet
  "#e66767", // red
  "#d55181", // magenta
  "#d95926", // orange
] as const;

/** Sequential blue ramp (magnitude), light→dark steps 100..700. */
export const SEQ_BLUE = [
  "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7",
  "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b",
] as const;

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

/** Diverging poles (blue ↔ red), neutral dark midpoint. */
export const DIVERGING = { cool: "#3987e5", mid: "#383835", warm: "#e66767" } as const;

export function clusterColor(id: number): string {
  return CATEGORICAL[((id % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}
