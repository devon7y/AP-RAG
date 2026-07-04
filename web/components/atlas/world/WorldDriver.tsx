"use client";

import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtlasStore } from "@/lib/atlas/store";
import type { WorldData } from "./derive";
import { useWorld } from "./store";
import {
  heightTexA,
  heightTexB,
  uCalm,
  uEraMix,
  uFlash,
  uHit,
  uLensDim,
  uMorph,
  uYear,
  uYearLo,
} from "./uniforms";

/**
 * The world's clock: eases the morph, advances the time machine, and keeps the
 * era height-field textures bracketing the current year. Every material reads
 * the shared uniforms this component drives.
 */
export default function WorldDriver({ data }: { data: WorldData }) {
  const boost = useAtlasStore((s) => s.hdrBoost);

  useEffect(() => {
    uCalm.value = 0.55 + 0.45 * boost;
    uHit.value = boost;
  }, [boost]);

  useFrame((_, rawDt) => {
    const st = useWorld.getState();
    const dt = Math.min(rawDt, 0.1);

    // morph spring (atlas ⇄ space)
    const target = st.view === "space" ? 1 : 0;
    uMorph.value += (target - uMorph.value) * Math.min(1, dt * 2.4);
    if (Math.abs(uMorph.value - target) < 0.001) uMorph.value = target;

    // time machine playback
    let y = st.year;
    if (st.timePlaying) {
      y = Math.min(st.yearMax + 1, y + dt * 3.0);
      st.set("year", y);
      if (y >= st.yearMax + 1) st.set("timePlaying", false);
      uFlash.value = Math.min(1, uFlash.value + dt * 3);
    } else {
      uFlash.value = Math.max(0, uFlash.value - dt * 1.2);
    }
    uYear.value += (y - uYear.value) * Math.min(1, dt * 5);
    uYearLo.value += (st.yearLo - uYearLo.value) * Math.min(1, dt * 5);

    // metadata lens presence (terrain steps back while one is active)
    const lensOn =
      st.lens.author !== null || st.lens.journal || st.lens.keyword ? 1 : 0;
    uLensDim.value += (lensOn - uLensDim.value) * Math.min(1, dt * 4);

    // era height-field bracket
    const { years, texes } = data.eras;
    const last = years.length - 1;
    const yy = Math.min(uYear.value, years[last]);
    let i = 0;
    while (i < last - 1 && years[i + 1] <= yy) i++;
    heightTexA.value = texes[i];
    heightTexB.value = texes[Math.min(i + 1, last)];
    const y0 = years[i];
    const y1 = years[Math.min(i + 1, last)];
    uEraMix.value =
      y1 > y0 ? Math.min(1, Math.max(0, (yy - y0) / (y1 - y0))) : 1;
  });

  return null;
}
