"use client";

import { useEffect, useState } from "react";
import type { VoidSite } from "./types";

let voidsPromise: Promise<VoidSite[]> | null = null;

export function loadVoids(): Promise<VoidSite[]> {
  voidsPromise ??= fetch("/data/voids.json").then((r) => {
    if (!r.ok) throw new Error(`voids.json: ${r.status}`);
    return r.json();
  });
  return voidsPromise;
}

export function useVoids(): VoidSite[] | null {
  const [voids, setVoids] = useState<VoidSite[] | null>(null);
  useEffect(() => {
    loadVoids().then(setVoids, () => setVoids([]));
  }, []);
  return voids;
}
