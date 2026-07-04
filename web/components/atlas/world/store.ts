"use client";

import { create } from "zustand";
import type { ArithResult, Trace } from "@/components/atlas/interpolate/engine";
import type { Station } from "@/components/atlas/radio/radioStore";
import type { GhostPaper } from "@/lib/atlas/types";

/**
 * State shared between the world's 3D layers and the instrument pane.
 * Instrument-local transients (input fields, busy spinners) live in their
 * panels; anything a shader or scene layer renders lives here.
 */

export type WorldView = "atlas" | "space";

export type Instrument =
  | "navigate"
  | "time"
  | "lenses"
  | "interpolate"
  | "ghosts"
  | "radio"
  | "game";

export type Selection =
  | { kind: "paper"; idx: number }
  | { kind: "chunk"; idx: number }
  | { kind: "entity"; idx: number }
  | { kind: "author"; idx: number }
  | { kind: "ghost"; id: string }
  | null;

export interface SearchHit {
  idx: number; // chunk idx
  chunkId: string;
  score: number;
}

export interface WarpRequest {
  seq: number;
  center: [number, number, number];
  standoff: number;
  duration: number;
}

export interface Lens {
  author: number | null; // authors.json idx
  journal: string | null;
  keyword: string | null;
}

export const NO_LENS: Lens = { author: null, journal: null, keyword: null };

export interface PlantedGhost {
  id: string;
  x01: number;
  y01: number;
  ghost: GhostPaper | null; // null while the LLM writes it
  neighbors: string[];
  /** where the ghost's own abstract actually embeds (chunk idx + score) */
  echo: { idx: number; score: number }[] | null;
  error?: string;
}

export interface GamePing {
  authorIdx: number;
  temperature: number;
  ts: number;
}

interface WorldState {
  view: WorldView;
  instrument: Instrument;
  paneOpen: boolean;
  selection: Selection;
  hovered: Selection;

  // time machine
  year: number; // upper bound of the lens; yearMax+1 = "now" (everything)
  yearLo: number; // lower bound; 0 = open
  yearMin: number;
  yearMax: number;
  timePlaying: boolean;

  lens: Lens;

  searchQuery: string;
  searchHits: SearchHit[] | null;

  warp: WarpRequest | null;
  warping: boolean;

  // layer toggles
  showSky: boolean;
  showWeb: boolean;
  showLabels: boolean;

  // interpolation engine
  trace: Trace | null;
  traceT: number; // probe position 0..1 along the geodesic
  arith: ArithResult | null;

  // ghosts
  ghosts: PlantedGhost[];
  planting: boolean; // next map click plants a flag

  // radio rover
  radioOn: boolean;
  radioMuted: boolean;
  radioIdx: number | null;
  radioTrail: number[];
  radioStation: Station | null;
  radioBias: number;
  radioFollow: boolean;
  radioSentence: string | null;

  // daily author game
  gamePings: GamePing[];

  set: <K extends keyof WorldState>(k: K, v: WorldState[K]) => void;
  setView: (v: WorldView) => void;
  setInstrument: (i: Instrument) => void;
  select: (s: Selection) => void;
  hover: (s: Selection) => void;
  setSearch: (query: string, hits: SearchHit[] | null) => void;
  requestWarp: (
    center: [number, number, number],
    standoff: number,
    duration?: number,
  ) => void;
  setLens: (patch: Partial<Lens>) => void;
  clearLens: () => void;
  addGhost: (g: PlantedGhost) => void;
  updateGhost: (id: string, patch: Partial<PlantedGhost>) => void;
  removeGhost: (id: string) => void;
}

let warpSeq = 0;

export const useWorld = create<WorldState>((set) => ({
  view: "atlas",
  instrument: "navigate",
  paneOpen: true,
  selection: null,
  hovered: null,

  year: 3000,
  yearLo: 0,
  yearMin: 1950,
  yearMax: 2026,
  timePlaying: false,

  lens: NO_LENS,

  searchQuery: "",
  searchHits: null,

  warp: null,
  warping: false,

  showSky: true,
  showWeb: true,
  showLabels: true,

  trace: null,
  traceT: 0.5,
  arith: null,

  ghosts: [],
  planting: false,

  radioOn: false,
  radioMuted: false,
  radioIdx: null,
  radioTrail: [],
  radioStation: null,
  radioBias: 0,
  radioFollow: true,
  radioSentence: null,

  gamePings: [],

  set: (k, v) => set({ [k]: v } as Partial<WorldState>),
  setView: (v) => set({ view: v }),
  setInstrument: (i) => set({ instrument: i, paneOpen: true }),
  select: (s) => set({ selection: s }),
  hover: (s) => set({ hovered: s }),
  setSearch: (query, hits) => set({ searchQuery: query, searchHits: hits }),
  requestWarp: (center, standoff, duration = 2.0) =>
    set({ warp: { seq: ++warpSeq, center, standoff, duration } }),
  setLens: (patch) => set((s) => ({ lens: { ...s.lens, ...patch } })),
  clearLens: () => set({ lens: NO_LENS }),
  addGhost: (g) => set((s) => ({ ghosts: [...s.ghosts, g] })),
  updateGhost: (id, patch) =>
    set((s) => ({
      ghosts: s.ghosts.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  removeGhost: (id) => set((s) => ({ ghosts: s.ghosts.filter((g) => g.id !== id) })),
}));
