"use client";

import { create } from "zustand";

/** A tuned "station": the topic the dial biases the drift toward or away from. */
export interface Station {
  query: string;
  /** score-weighted centroid of the topic's top hits, map coords [0,1]² */
  centroid: [number, number];
  /** atlas index → normalized hit score (0.3..1) for the topic's top chunks */
  hits: Map<number, number>;
  /** strongest matching atlas index (walk start when tuned before power-on) */
  topIdx: number | null;
}

export interface NowPlayingInfo {
  idx: number;
  title: string;
  authors: string;
  year: number;
  journal: string;
  file: string;
  section: string;
  page: number | null;
}

export type RadioStatus = "idle" | "loading" | "reading";

interface RadioState {
  powered: boolean;
  playing: boolean;
  ttsOn: boolean;
  tonesOn: boolean;
  volume: number;
  /** dial position: -1 (drift away) .. 0 (free) .. +1 (drift toward) */
  bias: number;
  tuning: boolean;
  tuneError: string | null;
  status: RadioStatus;
  current: number | null;
  prev: number | null;
  /** recently visited atlas indices, oldest → newest (drives trail + revisit penalty) */
  trail: number[];
  stepCount: number;
  sentences: string[];
  active: number;
  nowPlaying: NowPlayingInfo | null;
  station: Station | null;
  /** current chunk's affinity to the station, 0..1 */
  signal: number;

  setPowered: (v: boolean) => void;
  setPlaying: (v: boolean) => void;
  setTts: (v: boolean) => void;
  setTones: (v: boolean) => void;
  setVolume: (v: number) => void;
  setBias: (v: number) => void;
  setTuning: (v: boolean) => void;
  setTuneError: (v: string | null) => void;
  setStatus: (v: RadioStatus) => void;
  stepTo: (idx: number) => void;
  setPassage: (sentences: string[], nowPlaying: NowPlayingInfo | null) => void;
  setActive: (i: number) => void;
  setStation: (s: Station | null) => void;
  setSignal: (v: number) => void;
  resetTransient: () => void;
}

const TRAIL_MAX = 48;

export const useRadioStore = create<RadioState>((set) => ({
  powered: false,
  playing: false,
  ttsOn: true,
  tonesOn: true,
  volume: 0.6,
  bias: 0,
  tuning: false,
  tuneError: null,
  status: "idle",
  current: null,
  prev: null,
  trail: [],
  stepCount: 0,
  sentences: [],
  active: 0,
  nowPlaying: null,
  station: null,
  signal: 0,

  setPowered: (v) => set({ powered: v }),
  setPlaying: (v) => set({ playing: v }),
  setTts: (v) => set({ ttsOn: v }),
  setTones: (v) => set({ tonesOn: v }),
  setVolume: (v) => set({ volume: v }),
  setBias: (v) => set({ bias: v }),
  setTuning: (v) => set({ tuning: v }),
  setTuneError: (v) => set({ tuneError: v }),
  setStatus: (v) => set({ status: v }),
  stepTo: (idx) =>
    set((s) => {
      if (s.current === idx) return s;
      return {
        prev: s.current,
        current: idx,
        trail: [...s.trail.slice(-(TRAIL_MAX - 1)), idx],
        stepCount: s.stepCount + 1,
      };
    }),
  setPassage: (sentences, nowPlaying) => set({ sentences, nowPlaying, active: 0 }),
  setActive: (i) => set({ active: i }),
  setStation: (s) => set({ station: s, tuneError: null }),
  setSignal: (v) => set({ signal: v }),
  resetTransient: () =>
    set({
      playing: false,
      tuning: false,
      status: "idle",
      sentences: [],
      active: 0,
      nowPlaying: null,
    }),
}));
