"use client";

import { useEffect, useMemo, useRef } from "react";
import HDRCanvas from "@/components/HDRCanvas";
import { useConstellations, useCorpus, LoadingVeil } from "@/lib/useCorpus";
import type { Constellations as ConstellationsData, CorpusData } from "@/lib/types";
import CameraRig from "./CameraRig";
import ConstellationLayer from "./Constellations";
import EntityPanel from "./EntityPanel";
import Nebulae from "./Nebulae";
import StarPanel from "./StarPanel";
import Starfield from "./Starfield";
import WarpBar from "./WarpBar";
import WarpOverlay from "./WarpOverlay";
import {
  AGE_MID,
  AGE_NEW,
  AGE_OLD,
  TYPE_FALLBACK,
  deriveObservatory,
  typeColor,
} from "./derive";
import { useObservatory } from "./store";

/** Sky legend + instrument toggles (bottom-left, like the /voids legend). */
function Legend({
  corpus,
  nEntities,
  yearMin,
  yearMax,
  typeKey,
}: {
  corpus: CorpusData;
  nEntities: number;
  yearMin: number;
  yearMax: number;
  typeKey: { type: string; color: string }[];
}) {
  const showFigures = useObservatory((s) => s.showFigures);
  const showNebulae = useObservatory((s) => s.showNebulae);
  const showWeb = useObservatory((s) => s.showWeb);
  const toggle = useObservatory((s) => s.toggle);

  return (
    <div className="hud-panel absolute bottom-5 left-5 z-40 hidden w-[270px] px-4 py-3 text-xs text-ink-2 sm:block">
      <p className="text-ink-3">
        {corpus.atlas.n.toLocaleString()} stars · {corpus.papers.length} papers ·{" "}
        {nEntities} constellations
      </p>

      <div className="mt-2.5">
        <div
          className="h-1.5 rounded-full"
          style={{
            background: `linear-gradient(90deg, ${AGE_OLD}, ${AGE_MID}, ${AGE_NEW})`,
          }}
        />
        <div className="mt-1 flex justify-between text-[10px] text-ink-3">
          <span>{yearMin}</span>
          <span>publication age</span>
          <span>{yearMax}</span>
        </div>
      </div>

      <p className="mt-2 text-[10px] text-ink-3">
        brightness — knowledge-graph centrality
      </p>

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-3">
        {typeKey.map((t) => (
          <span key={t.type} className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.color }} />
            {t.type}
          </span>
        ))}
      </div>

      <div className="mt-3 flex gap-3 border-t pt-2.5 hairline text-[10px] text-ink-3">
        {(
          [
            ["figures", "showFigures", showFigures],
            ["nebulae", "showNebulae", showNebulae],
            ["web", "showWeb", showWeb],
          ] as const
        ).map(([label, key, on]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={on}
              onChange={() => toggle(key)}
              className="h-3 w-3 accent-[#3987e5]"
            />
            {label}
          </label>
        ))}
      </div>

      <p className="mt-2.5 border-t pt-2.5 hairline text-[10px] leading-relaxed text-ink-3">
        drag to orbit · scroll to zoom · click a star to observe · double-click to
        fly · <kbd className="rounded border border-white/15 px-1">/</kbd> to warp
      </p>
    </div>
  );
}

function Scene({
  corpus,
  constellations,
}: {
  corpus: CorpusData;
  constellations: ConstellationsData;
}) {
  const data = useMemo(
    () => deriveObservatory(corpus, constellations),
    [corpus, constellations],
  );
  const requestWarp = useObservatory((s) => s.requestWarp);
  const introDone = useRef(false);

  // opening move: dive from deep space into the heart of the corpus
  useEffect(() => {
    if (introDone.current) return;
    introDone.current = true;
    requestWarp([0, 0, 0], 95, 3.0);
  }, [requestWarp]);

  const typeKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of data.entities) {
      const t = e.type.toLowerCase();
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .filter(([t]) => typeColor(t) !== TYPE_FALLBACK)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type]) => ({ type, color: typeColor(type) }));
    return [...top, { type: "other", color: TYPE_FALLBACK }];
  }, [data]);

  return (
    <>
      <HDRCanvas
        camera={{ position: [0, 46, 185], fov: 55, near: 0.1, far: 1200 }}
        clearColor={0x05060e}
      >
        <CameraRig />
        <Starfield data={data} corpus={corpus} />
        <Nebulae data={data} />
        <ConstellationLayer data={data} />
      </HDRCanvas>

      <WarpOverlay />
      <WarpBar data={data} corpus={corpus} />
      <StarPanel data={data} corpus={corpus} />
      <EntityPanel data={data} corpus={corpus} />
      <Legend
        corpus={corpus}
        nEntities={data.entities.length}
        yearMin={data.yearMin}
        yearMax={data.yearMax}
        typeKey={typeKey}
      />
    </>
  );
}

export default function ObservatorySceneRoot() {
  const { corpus, error } = useCorpus();
  const constellations = useConstellations();

  return (
    <div className="absolute inset-0">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!error && (!corpus || !constellations) && (
        <LoadingVeil label="aligning the telescope…" />
      )}
      {corpus && constellations && (
        <Scene corpus={corpus} constellations={constellations} />
      )}
    </div>
  );
}
