"use client";

import { useEffect, useState } from "react";
import { loadCorpus, loadKnn, loadConstellations } from "./data";
import type { Constellations, CorpusData, KnnGraph } from "./types";

export function useCorpus(): { corpus: CorpusData | null; error: string | null } {
  const [corpus, setCorpus] = useState<CorpusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadCorpus().then(setCorpus, (e) => setError(String(e)));
  }, []);
  return { corpus, error };
}

export function useKnn(): KnnGraph | null {
  const [knn, setKnn] = useState<KnnGraph | null>(null);
  useEffect(() => {
    loadKnn().then(setKnn, () => {});
  }, []);
  return knn;
}

export function useConstellations(): Constellations | null {
  const [c, setC] = useState<Constellations | null>(null);
  useEffect(() => {
    loadConstellations().then(setC, () => {});
  }, []);
  return c;
}

/** Standard full-screen loading veil while corpus data streams in. */
export function LoadingVeil({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center">
      <p className="pulse-soft font-display text-xl text-ink-2">{label}</p>
    </div>
  );
}
