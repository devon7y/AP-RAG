"use client";

import { create } from "zustand";

/** What the telescope is locked onto. */
export type Selection =
  | { kind: "star"; idx: number }
  | { kind: "entity"; idx: number }
  | null;

export interface SearchHit {
  idx: number;
  chunkId: string;
  score: number;
}

/** A slew request for the camera rig: fly so `center` fills the eyepiece. */
export interface WarpRequest {
  seq: number;
  center: [number, number, number];
  standoff: number;
  duration: number;
}

interface ObservatoryState {
  selection: Selection;
  hoveredStar: number | null;
  /** entity index currently under the pointer (labels / nebulae) — blocks empty-space deselect */
  hoveredEntity: number | null;
  searchHits: SearchHit[] | null;
  searchQuery: string;
  warp: WarpRequest | null;
  warping: boolean;
  showFigures: boolean;
  showNebulae: boolean;
  showWeb: boolean;

  selectStar: (idx: number | null) => void;
  selectEntity: (idx: number | null) => void;
  setHoveredStar: (idx: number | null) => void;
  setHoveredEntity: (idx: number | null) => void;
  setSearch: (query: string, hits: SearchHit[] | null) => void;
  clearSearch: () => void;
  requestWarp: (center: [number, number, number], standoff: number, duration?: number) => void;
  setWarping: (w: boolean) => void;
  toggle: (layer: "showFigures" | "showNebulae" | "showWeb") => void;
}

let warpSeq = 0;

export const useObservatory = create<ObservatoryState>((set) => ({
  selection: null,
  hoveredStar: null,
  hoveredEntity: null,
  searchHits: null,
  searchQuery: "",
  warp: null,
  warping: false,
  showFigures: true,
  showNebulae: true,
  showWeb: true,

  selectStar: (idx) => set({ selection: idx === null ? null : { kind: "star", idx } }),
  selectEntity: (idx) => set({ selection: idx === null ? null : { kind: "entity", idx } }),
  setHoveredStar: (idx) => set({ hoveredStar: idx }),
  setHoveredEntity: (idx) => set({ hoveredEntity: idx }),
  setSearch: (query, hits) => set({ searchQuery: query, searchHits: hits }),
  clearSearch: () => set({ searchQuery: "", searchHits: null }),
  requestWarp: (center, standoff, duration = 2.0) =>
    set({ warp: { seq: ++warpSeq, center, standoff, duration } }),
  setWarping: (w) => set({ warping: w }),
  toggle: (layer) => set((s) => ({ [layer]: !s[layer] }) as Partial<ObservatoryState>),
}));
