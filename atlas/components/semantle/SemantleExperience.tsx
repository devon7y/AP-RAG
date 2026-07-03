"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoadingVeil, useCorpus } from "@/lib/useCorpus";
import type { Paper } from "@/lib/types";
import SemantleScene, { type SceneEnd, type ScenePing } from "./SemantleScene";
import GuessConsole from "./GuessConsole";
import GuessList from "./GuessList";
import EndCard from "./EndCard";
import {
  apiGuess,
  apiIdentify,
  apiReveal,
  emptyDayState,
  fetchMeta,
  friendlyError,
  loadDayState,
  loadStats,
  normGuess,
  saveDayState,
  saveStats,
  utcDay,
  type DayState,
  type GameStatus,
  type SemantleMeta,
  type Stats,
  type StoredGuess,
} from "./game";

/** Must match the pool filter in app/api/semantle/route.ts. */
const MIN_CHUNKS = 15;

export default function SemantleExperience() {
  const { corpus, error: corpusError } = useCorpus();
  const [meta, setMeta] = useState<SemantleMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [state, setState] = useState<DayState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const [staleDay, setStaleDay] = useState(false);

  useEffect(() => {
    fetchMeta().then(
      (m) => {
        setMeta(m);
        setState(loadDayState(m.day) ?? emptyDayState(m.day));
        setStats(loadStats());
      },
      (e) => setMetaError(friendlyError(e)),
    );
  }, []);

  // The server picks a new paper at UTC midnight; stop the presses when it does.
  useEffect(() => {
    if (!meta) return;
    const check = () => setStaleDay(utcDay() !== meta.day);
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [meta]);

  const chunkIndexById = useMemo(() => {
    if (!corpus) return null;
    const m = new Map<string, number>();
    corpus.atlas.chunkId.forEach((id, i) => m.set(id, i));
    return m;
  }, [corpus]);

  const paperIdxByFile = useMemo(() => {
    if (!corpus) return null;
    const m = new Map<string, number>();
    corpus.papers.forEach((p, i) => m.set(p.file, i));
    return m;
  }, [corpus]);

  const pool = useMemo(
    () =>
      corpus
        ? corpus.papers
            .filter((p) => p.nChunks >= MIN_CHUNKS)
            .sort((a, b) => a.title.localeCompare(b.title))
        : [],
    [corpus],
  );

  const persist = useCallback((s: DayState) => {
    setState(s);
    saveDayState(s);
  }, []);

  /** Close out the day and bump personal stats exactly once. */
  const endGame = useCallback(
    (prev: DayState, status: Exclude<GameStatus, "playing">, targetFile: string, idAttempts?: number) => {
      persist({
        ...prev,
        status,
        targetFile,
        idAttempts: idAttempts ?? prev.idAttempts,
      });
      setStats((cur) => {
        const st = { ...(cur ?? loadStats()) };
        if (st.lastEndedDay === prev.day) return cur; // already counted
        st.played += 1;
        st.lastEndedDay = prev.day;
        if (status === "won") {
          st.won += 1;
          st.streak = st.lastWonDay === prev.day - 1 ? st.streak + 1 : 1;
          st.maxStreak = Math.max(st.maxStreak, st.streak);
          st.lastWonDay = prev.day;
          st.totalGuessesOnWins += prev.guesses.length;
        } else {
          st.streak = 0;
        }
        saveStats(st);
        return st;
      });
    },
    [persist],
  );

  const onGuess = useCallback(
    async (text: string) => {
      if (!state || state.status !== "playing" || busy) return;
      if (utcDay() !== state.day) {
        setStaleDay(true);
        return;
      }
      const q = normGuess(text);
      const dup = state.guesses.find((g) => normGuess(g.text) === q);
      if (dup) {
        setFocusKey(dup.ts);
        setNotice("already guessed — highlighted on the map");
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiGuess(text);
        const chunkIdx =
          res.ping && chunkIndexById
            ? (chunkIndexById.get(res.ping.chunkId) ?? null)
            : null;
        const g: StoredGuess = {
          text: text.trim(),
          temperature: res.temperature,
          cosine: res.cosine,
          chunkIdx,
          file: res.ping?.file ?? null,
          ts: Date.now(),
        };
        persist({ ...state, guesses: [...state.guesses, g] });
        setFocusKey(null);
      } catch (e) {
        setNotice(friendlyError(e));
      } finally {
        setBusy(false);
      }
    },
    [state, busy, chunkIndexById, persist],
  );

  const onIdentify = useCallback(
    async (file: string) => {
      if (!state || state.status !== "playing" || busy) return;
      if (state.eliminated.includes(file)) return;
      if (utcDay() !== state.day) {
        setStaleDay(true);
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const res = await apiIdentify(file);
        if (res.correct && res.target) {
          endGame(state, "won", res.target.file, state.idAttempts + 1);
        } else {
          persist({
            ...state,
            eliminated: [...state.eliminated, file],
            idAttempts: state.idAttempts + 1,
          });
          setNotice("not that one — struck from the pool");
        }
      } catch (e) {
        setNotice(friendlyError(e));
      } finally {
        setBusy(false);
      }
    },
    [state, busy, endGame, persist],
  );

  const onReveal = useCallback(async () => {
    if (!state || state.status !== "playing" || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiReveal();
      endGame(state, "revealed", res.target.file);
    } catch (e) {
      setNotice(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }, [state, busy, endGame]);

  // ---- derived scene data ----

  const pings: ScenePing[] = useMemo(() => {
    if (!corpus || !state) return [];
    const lastTs = state.guesses[state.guesses.length - 1]?.ts;
    return state.guesses
      .filter((g) => g.chunkIdx !== null)
      .map((g) => ({
        key: g.ts,
        x01: corpus.atlas.pos2[(g.chunkIdx as number) * 2],
        y01: corpus.atlas.pos2[(g.chunkIdx as number) * 2 + 1],
        temperature: g.temperature,
        text: g.text,
        latest: g.ts === lastTs,
      }));
  }, [corpus, state]);

  const targetPaper: Paper | null = useMemo(() => {
    if (!corpus || !state?.targetFile) return null;
    return corpus.papers.find((p) => p.file === state.targetFile) ?? null;
  }, [corpus, state?.targetFile]);

  const end: SceneEnd | null = useMemo(() => {
    if (!state || state.status === "playing" || !state.targetFile) return null;
    if (!paperIdxByFile || !targetPaper) return null;
    const paperIdx = paperIdxByFile.get(state.targetFile);
    if (paperIdx === undefined) return null;
    return {
      paperIdx,
      centroid: targetPaper.centroid,
      won: state.status === "won",
    };
  }, [state, paperIdxByFile, targetPaper]);

  // ---- render ----

  const fatal = corpusError || metaError;
  const ready = corpus && meta && state && stats;

  return (
    <div className="absolute inset-0">
      {fatal && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-8 text-center text-sm text-ink-3">
          {corpusError
            ? `Failed to load corpus data: ${corpusError}`
            : `Failed to start today's game: ${metaError}`}
        </div>
      )}
      {!ready && !fatal && <LoadingVeil label="hiding today's paper…" />}

      {ready && (
        <>
          <SemantleScene
            corpus={corpus}
            pings={pings}
            focusKey={focusKey}
            end={end}
          />

          <div className="pointer-events-none absolute top-24 bottom-5 left-5 z-40 flex w-[380px] max-w-[calc(100vw-2.5rem)] flex-col gap-3">
            <GuessConsole
              meta={meta}
              state={state}
              stats={stats}
              busy={busy}
              error={notice}
              staleDay={staleDay}
              pool={pool}
              onGuess={onGuess}
              onIdentify={onIdentify}
              onReveal={onReveal}
            />
            <GuessList
              state={state}
              corpus={corpus}
              focusKey={focusKey}
              onFocus={setFocusKey}
            />
          </div>

          <EndCard state={state} paper={targetPaper} stats={stats} />
        </>
      )}
    </div>
  );
}
