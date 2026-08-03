"use client";

import { create } from "zustand";
import type { ArithResult, Trace } from "./engineBridge";
import type { Station } from "./walk";
import type { AircraftKey } from "./aircraft";
import type { GhostPaper } from "@/lib/atlas/types";

/**
 * State shared between the world's 3D layers and the instrument pane.
 * Instrument-local transients (input fields, busy spinners) live in their
 * panels; anything a shader or scene layer renders lives here.
 */

export type WorldView = "atlas" | "space";

export type Instrument =
  | "navigate"
  | "ask"
  | "time"
  | "lenses"
  | "interpolate"
  | "ghosts"
  | "draft"
  | "radio"
  | "plane"
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
  /** explicit end camera position — overrides the standoff/direction rule */
  pose?: [number, number, number];
  /** land on the idle-orbit circle (fixed radius + height around center) at
   *  the point NEAREST the current camera — the rig resolves the azimuth */
  orbit?: { radius: number; height: number };
}

/** The canonical resting orbits — fixed height and downward angle. */
export const HOME = {
  atlas: {
    center: [0, 4, 0] as [number, number, number],
    orbit: { radius: 92, height: 62 },
  },
  space: {
    center: [0, 0, 0] as [number, number, number],
    orbit: { radius: 118, height: 55 },
  },
};

/** A view's resting orbit resolved at the +Z azimuth — exactly where warpHome
 *  would land a fresh camera. The scene mounts here directly rather than
 *  flying in, so the controls are live on the first frame instead of after an
 *  entry animation. View matters on a return visit: the store outlives
 *  client-side navigation, so the world can come back up in galaxy view. */
export function homeShot(view: WorldView): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const h = view === "space" ? HOME.space : HOME.atlas;
  return {
    position: [h.center[0], h.orbit.height, h.center[2] + h.orbit.radius],
    target: h.center,
  };
}

/** The cold-load shot (the store opens in atlas view). */
export const OPENING_SHOT = homeShot("atlas");

/** Fly to the nearest point on the resting orbit for the current view. */
export function warpHome(duration = 1.3): void {
  const st = useWorld.getState();
  const h = st.view === "space" ? HOME.space : HOME.atlas;
  st.requestWarp(h.center, 0, duration, undefined, h.orbit);
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

/** One cited source of an Ask-the-Atlas answer, located in the world. */
export interface AskRef {
  /** papers.json idx (-1 when the cited file isn't in the atlas pack) */
  paperIdx: number;
  filename: string;
  apa: string;
  intext: string;
  /** PDF pages the cited passages came from */
  pages: number[];
  drive: string;
}

export interface AskState {
  question: string;
  status: "running" | "done" | "error";
  answer: string | null;
  refs: AskRef[];
  error?: string;
}

export interface DraftState {
  text: string;
  status: "locating" | "done" | "error";
  /** nearest passages to the draft's embedding (chunk idx + cosine) */
  hits: { idx: number; score: number }[];
  error?: string;
}

interface WorldState {
  view: WorldView;
  instrument: Instrument;
  paneOpen: boolean;
  selection: Selection;
  /** where you came from — powers the inspector's back button */
  selectionStack: Selection[];
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

  /** gentle idle orbit — on until the user moves the camera themselves */
  autoRotate: boolean;

  // interpolation engine
  trace: Trace | null;
  traceT: number; // probe position 0..1 along the geodesic
  arith: ArithResult | null;

  // ask the atlas (question → synthesized answer + cited papers as evidence)
  ask: AskState | null;

  // drop a draft (your own text located in the corpus)
  draft: DraftState | null;

  // ghosts
  ghosts: PlantedGhost[];
  planting: boolean; // next map click plants a flag

  // radio rover
  radioOn: boolean;
  radioMuted: boolean;
  /** TTS speaking rate (1 = normal) */
  radioRate: number;
  radioIdx: number | null;
  radioTrail: number[];
  radioStation: Station | null;
  radioBias: number;
  radioFollow: boolean;
  radioSentence: string | null;
  /** section title of the passage on air (fetched with its text) */
  radioSection: string;

  // the jet (crash-to-read)
  planeOn: boolean;
  /** which airframe is in the hangar bay */
  aircraft: AircraftKey;
  planeFollow: boolean;
  planeSound: boolean;
  /** the airframe streams in on first take-off — nothing flies until it lands */
  planeStatus: "idle" | "loading" | "ready" | "error";
  /** paper-hunting mission: drop cargo on papers, or strike their beacons */
  missionOn: boolean;
  /** papers.json index of the paper currently being hunted */
  missionTarget: number | null;
  missionHits: number;
  missionShots: number;
  /** true once the run is finished — no more targets are assigned */
  missionDone: boolean;
  /** transient banner after each resolved shot */
  missionFlash: { text: string; ok: boolean; seq: number } | null;

  // semantle (daily passage → first author)
  gamePings: GamePing[];
  /** today's passage chunk idx — pulses on the map */
  gameChunk: number | null;

  set: <K extends keyof WorldState>(k: K, v: WorldState[K]) => void;
  setView: (v: WorldView) => void;
  setInstrument: (i: Instrument) => void;
  select: (s: Selection) => void;
  back: () => void;
  hover: (s: Selection) => void;
  setSearch: (query: string, hits: SearchHit[] | null) => void;
  requestWarp: (
    center: [number, number, number],
    standoff: number,
    duration?: number,
    pose?: [number, number, number],
    orbit?: { radius: number; height: number },
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
  selectionStack: [],
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

  autoRotate: true,

  trace: null,
  traceT: 0.5,
  arith: null,

  ask: null,
  draft: null,

  ghosts: [],
  planting: false,

  radioOn: false,
  radioMuted: false,
  radioRate: 1,
  radioIdx: null,
  radioTrail: [],
  radioStation: null,
  radioBias: 0,
  radioFollow: true,
  radioSentence: null,
  radioSection: "",

  planeOn: false,
  aircraft: "a380",
  planeFollow: true,
  planeSound: true,
  planeStatus: "idle",
  missionOn: true,
  missionTarget: null,
  missionHits: 0,
  missionShots: 0,
  missionDone: false,
  missionFlash: null,

  gamePings: [],
  gameChunk: null,

  set: (k, v) => set({ [k]: v } as Partial<WorldState>),
  setView: (v) => set({ view: v }),
  setInstrument: (i) =>
    set((s) => {
      const leavingLenses = s.instrument === "lenses" && i !== "lenses";
      const leavingInterp = s.instrument === "interpolate" && i !== "interpolate";
      const leavingGaps = s.instrument === "ghosts" && i !== "ghosts";
      // closing the lens menu closes the author card the lens opened
      const dropAuthor = leavingLenses && s.selection?.kind === "author";
      // leaving the engine clears its arc and the auto-opened passage
      const dropChunk = leavingInterp && s.selection?.kind === "chunk";
      // leaving the gap tool closes the open gap-paper card
      const dropGhost = leavingGaps && s.selection?.kind === "ghost";
      return {
        instrument: i,
        paneOpen: true,
        lens: leavingLenses ? NO_LENS : s.lens,
        planting: i === "ghosts", // the gap tool arms map-planting on entry
        ...(leavingInterp ? { trace: null, arith: null } : {}),
        ...(dropAuthor || dropChunk || dropGhost
          ? { selection: null, selectionStack: [] }
          : {}),
      };
    }),
  select: (s) =>
    set((st) => {
      const same =
        s !== null &&
        st.selection !== null &&
        st.selection.kind === s.kind &&
        (st.selection as { idx?: number }).idx === (s as { idx?: number }).idx &&
        (st.selection as { id?: string }).id === (s as { id?: string }).id;
      if (same) return {};
      const stack =
        st.selection !== null && s !== null
          ? [...st.selectionStack, st.selection].slice(-24)
          : s === null
            ? []
            : st.selectionStack;
      // closing an author card also clears their lens (and vice versa, in setLens)
      const lens =
        s === null && st.selection?.kind === "author" && st.lens.author !== null
          ? { ...st.lens, author: null }
          : st.lens;
      return { selection: s, selectionStack: stack, lens };
    }),
  back: () =>
    set((st) => {
      const stack = [...st.selectionStack];
      const prev = stack.pop() ?? null;
      return { selection: prev, selectionStack: stack };
    }),
  hover: (s) => set({ hovered: s }),
  setSearch: (query, hits) => set({ searchQuery: query, searchHits: hits }),
  requestWarp: (center, standoff, duration = 2.0, pose, orbit) =>
    set({ warp: { seq: ++warpSeq, center, standoff, duration, pose, orbit } }),
  setLens: (patch) =>
    set((s) => {
      // clearing the author lens closes the author card it opened
      const closing =
        patch.author === null &&
        s.lens.author !== null &&
        s.selection?.kind === "author";
      return {
        lens: { ...s.lens, ...patch },
        ...(closing ? { selection: null, selectionStack: [] } : {}),
      };
    }),
  clearLens: () =>
    set((s) => ({
      lens: NO_LENS,
      // dropping the lens also closes the author card it opened
      ...(s.selection?.kind === "author"
        ? { selection: null, selectionStack: [] }
        : {}),
    })),
  addGhost: (g) => set((s) => ({ ghosts: [...s.ghosts, g] })),
  updateGhost: (id, patch) =>
    set((s) => ({
      ghosts: s.ghosts.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })),
  removeGhost: (id) =>
    set((s) => ({
      ghosts: s.ghosts.filter((g) => g.id !== id),
      // deleting the gap also closes its open card
      ...(s.selection?.kind === "ghost" && s.selection.id === id
        ? { selection: null, selectionStack: [] }
        : {}),
    })),
}));
