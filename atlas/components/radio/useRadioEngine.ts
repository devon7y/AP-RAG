"use client";

import { useEffect, useMemo, useRef } from "react";
import { fetchChunkText, qsearch } from "@/lib/api";
import { sampleHeight } from "@/lib/data";
import type { CorpusData, KnnGraph } from "@/lib/types";
import { RadioAudio } from "./audioEngine";
import { useRadioStore } from "./radioStore";
import { cancelSpeech, primeVoices, speak, ttsAvailable } from "./tts";
import { buildStation, chooseNext, computeSignal, readMs, splitSentences } from "./walk";

/**
 * The broadcast loop. Owns the walk lifecycle (choose → fetch passage → read →
 * dwell → hop), the TTS voice, and the sonification engine. All passage text
 * flows browser-side only: /api/chunk → store → lyrics panel → SpeechSynthesis.
 *
 * Cancellation model: a single token; every await re-checks it, so power-off,
 * skip, and unmount kill any in-flight step instantly and orphan loops exit.
 */

const SENTENCE_GAP_MS = 220;
const PASSAGE_DWELL_MS = 2600;

export interface RadioEngine {
  powerOn: () => void;
  powerOff: () => void;
  togglePlay: () => void;
  skip: () => void;
  tune: (query: string) => Promise<void>;
  clearStation: () => void;
  setBias: (b: number) => void;
  setTts: (on: boolean) => void;
  setTones: (on: boolean) => void;
  setVolume: (v: number) => void;
}

export function useRadioEngine(
  corpus: CorpusData | null,
  knn: KnnGraph | null,
): RadioEngine {
  const corpusRef = useRef(corpus);
  corpusRef.current = corpus;
  const knnRef = useRef(knn);
  knnRef.current = knn;

  const chunkIndex = useMemo(() => {
    if (!corpus) return null;
    const m = new Map<string, number>();
    for (let i = 0; i < corpus.atlas.chunkId.length; i++) m.set(corpus.atlas.chunkId[i], i);
    return m;
  }, [corpus]);
  const chunkIndexRef = useRef(chunkIndex);
  chunkIndexRef.current = chunkIndex;

  const audioRef = useRef<RadioAudio | null>(null);
  const tokenRef = useRef(0);
  const sleepersRef = useRef<Set<() => void>>(new Set());
  const resumeResolversRef = useRef<(() => void)[]>([]);
  const speakCancelRef = useRef<(() => void) | null>(null);
  const failStreakRef = useRef(0);

  const engine = useMemo<RadioEngine>(() => {
    const stale = (t: number) => t !== tokenRef.current;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sleepersRef.current.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        sleepersRef.current.add(done);
      });

    const wakeAll = () => {
      for (const done of [...sleepersRef.current]) done();
    };

    const flushResume = () => {
      const rs = resumeResolversRef.current;
      resumeResolversRef.current = [];
      for (const r of rs) r();
    };

    const waitWhilePaused = async (token: number) => {
      while (!stale(token)) {
        const s = useRadioStore.getState();
        if (s.playing || !s.powered) return;
        await new Promise<void>((r) => resumeResolversRef.current.push(r));
      }
    };

    const stopVoice = () => {
      speakCancelRef.current?.();
      speakCancelRef.current = null;
      cancelSpeech();
    };

    const advance = async (token: number) => {
      // don't hop while paused — freeze the walk where it is
      await waitWhilePaused(token);
      if (stale(token)) return;
      const c = corpusRef.current;
      const k = knnRef.current;
      const s = useRadioStore.getState();
      if (!c || !k || s.current === null) return;
      const next = chooseNext(k, c.atlas, s.current, s.prev, s.trail, s.station, s.bias);
      void playFrom(next, token);
    };

    async function playFrom(idx: number, token: number): Promise<void> {
      const c = corpusRef.current;
      if (!c || stale(token)) return;
      const atlas = c.atlas;
      const s = useRadioStore.getState();
      s.stepTo(idx);
      s.setStatus("loading");

      // sonify the new locale immediately — the hop is audible before it's readable
      const x01 = atlas.pos2[idx * 2];
      const y01 = atlas.pos2[idx * 2 + 1];
      const a = audioRef.current;
      a?.ping();
      a?.setChord(atlas.cluster[idx]);
      a?.setDensity(sampleHeight(c.heightmap, x01, y01));
      a?.setPan(x01);
      const sig = computeSignal(atlas, idx, s.station);
      s.setSignal(sig);
      a?.setStatic(sig, s.station !== null);

      let rec: Awaited<ReturnType<typeof fetchChunkText>> | null = null;
      try {
        rec = await fetchChunkText(atlas.chunkId[idx]);
      } catch {
        rec = null;
      }
      if (stale(token)) return;

      if (!rec || typeof rec.text !== "string" || !rec.text.trim()) {
        // back off if the chunk API keeps failing — this radio is left unattended
        failStreakRef.current = Math.min(failStreakRef.current + 1, 8);
        await wait(1500 * failStreakRef.current);
        if (stale(token)) return;
        return void advance(token);
      }
      failStreakRef.current = 0;
      const sents = splitSentences(rec.text);
      if (!sents.length) return void advance(token);

      const paper = c.papers[atlas.paper[idx]];
      useRadioStore.getState().setPassage(sents, {
        idx,
        title: paper?.title || rec.file,
        authors: paper?.authors ?? "",
        year: paper?.year ?? atlas.year[idx],
        journal: paper?.journal ?? "",
        file: rec.file || paper?.file || "",
        section: rec.section || atlas.section[idx] || "",
        page: rec.page,
      });
      useRadioStore.getState().setStatus("reading");

      for (let i = 0; i < sents.length; i++) {
        await waitWhilePaused(token);
        if (stale(token)) return;
        useRadioStore.getState().setActive(i);
        if (useRadioStore.getState().ttsOn && ttsAvailable()) {
          audioRef.current?.duck(true);
          const h = speak(sents[i]);
          speakCancelRef.current = h.cancel;
          await h.done;
          speakCancelRef.current = null;
        } else {
          audioRef.current?.duck(false);
          await wait(readMs(sents[i]));
        }
        if (stale(token)) return;
        await wait(SENTENCE_GAP_MS);
        if (stale(token)) return;
      }

      audioRef.current?.duck(false);
      await wait(PASSAGE_DWELL_MS);
      if (stale(token)) return;
      void advance(token);
    }

    const powerOn = () => {
      const c = corpusRef.current;
      const k = knnRef.current;
      const s = useRadioStore.getState();
      if (!c || !k || s.powered) return;
      primeVoices();
      try {
        audioRef.current = new RadioAudio();
        audioRef.current.setMaster(s.volume);
        audioRef.current.setEnabled(s.tonesOn);
        void audioRef.current.start();
      } catch {
        audioRef.current = null; // no Web Audio — voice + lyrics still work
      }
      s.setPowered(true);
      s.setPlaying(true);
      const token = ++tokenRef.current;
      const start =
        s.current ?? s.station?.topIdx ?? Math.floor(Math.random() * c.atlas.n);
      void playFrom(start, token);
    };

    const powerOff = () => {
      tokenRef.current++;
      stopVoice();
      wakeAll();
      flushResume();
      audioRef.current?.dispose();
      audioRef.current = null;
      const s = useRadioStore.getState();
      s.resetTransient();
      s.setPowered(false);
    };

    const togglePlay = () => {
      const s = useRadioStore.getState();
      if (!s.powered) return;
      const playing = !s.playing;
      s.setPlaying(playing);
      audioRef.current?.setPaused(!playing);
      if (playing) flushResume();
      else stopVoice();
    };

    const skip = () => {
      const s = useRadioStore.getState();
      if (!s.powered || s.current === null) return;
      const token = ++tokenRef.current;
      stopVoice();
      wakeAll();
      const c = corpusRef.current;
      const k = knnRef.current;
      if (!c || !k) return;
      const next = chooseNext(k, c.atlas, s.current, s.prev, s.trail, s.station, s.bias);
      void playFrom(next, token);
    };

    const tune = async (query: string) => {
      const q = query.trim();
      const c = corpusRef.current;
      const index = chunkIndexRef.current;
      if (!q || !c || !index) return;
      const s = useRadioStore.getState();
      s.setTuning(true);
      s.setTuneError(null);
      audioRef.current?.sweep();
      try {
        const hits = await qsearch({ text: q, limit: 60 });
        const station = buildStation(q, hits, index, c.atlas);
        const s2 = useRadioStore.getState();
        if (!station) {
          s2.setStation(null);
          s2.setTuneError("no signal on that frequency");
          s2.setSignal(0);
          audioRef.current?.setStatic(0, false);
        } else {
          s2.setStation(station);
          if (s2.bias === 0) s2.setBias(0.65);
          if (s2.current !== null) {
            const sig = computeSignal(c.atlas, s2.current, station);
            s2.setSignal(sig);
            audioRef.current?.setStatic(sig, true);
          }
        }
      } catch {
        useRadioStore.getState().setTuneError("tuner offline — search unavailable");
      } finally {
        useRadioStore.getState().setTuning(false);
      }
    };

    const clearStation = () => {
      const s = useRadioStore.getState();
      s.setStation(null);
      s.setBias(0);
      s.setSignal(0);
      audioRef.current?.setStatic(0, false);
    };

    const setBias = (b: number) => {
      useRadioStore.getState().setBias(Math.min(1, Math.max(-1, b)));
    };

    const setTts = (on: boolean) => {
      useRadioStore.getState().setTts(on);
      if (!on) {
        stopVoice();
        audioRef.current?.duck(false);
      }
    };

    const setTones = (on: boolean) => {
      useRadioStore.getState().setTones(on);
      audioRef.current?.setEnabled(on);
    };

    const setVolume = (v: number) => {
      useRadioStore.getState().setVolume(v);
      audioRef.current?.setMaster(v);
    };

    return {
      powerOn,
      powerOff,
      togglePlay,
      skip,
      tune,
      clearStation,
      setBias,
      setTts,
      setTones,
      setVolume,
    };
  }, []);

  // leaving the room = power off (kills speech, audio graph, and the walk loop)
  useEffect(() => {
    return () => engine.powerOff();
  }, [engine]);

  return engine;
}
