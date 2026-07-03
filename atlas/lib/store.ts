"use client";

import { create } from "zustand";

export type CanvasMode = "webgpu-hdr" | "webgpu-sdr" | "webgl";

interface AtlasStore {
  canvasMode: CanvasMode;
  setCanvasMode: (m: CanvasMode) => void;
  /** brightness overshoot factor scenes may use (>1 only when the canvas is truly HDR) */
  hdrBoost: number;
  /** selected chunk index (global cross-experience selection) */
  selectedChunk: number | null;
  setSelectedChunk: (i: number | null) => void;
  selectedPaper: number | null;
  setSelectedPaper: (i: number | null) => void;
}

export const useAtlasStore = create<AtlasStore>((set) => ({
  canvasMode: "webgl",
  setCanvasMode: (m) =>
    set({ canvasMode: m, hdrBoost: m === "webgpu-hdr" ? 2.2 : 1.0 }),
  hdrBoost: 1.0,
  selectedChunk: null,
  setSelectedChunk: (i) => set({ selectedChunk: i }),
  selectedPaper: null,
  setSelectedPaper: (i) => set({ selectedPaper: i }),
}));
