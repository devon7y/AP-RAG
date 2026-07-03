"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { useCorpus, LoadingVeil } from "@/lib/atlas/useCorpus";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/atlas/data";
import type { CorpusData } from "@/lib/atlas/types";
import { buildSpirits } from "./authors";
import { useSeance } from "./useSeance";
import { HEIGHT_SCALE, GHOST_GREEN } from "./theme";
import SeanceLandmass from "./SeanceLandmass";
import GhostFigure from "./GhostFigure";
import CitationThreads from "./CitationThreads";
import AuthorPicker from "./AuthorPicker";
import ChatPanel from "./ChatPanel";

const FOG_COLOR = 0x070a08; // green-black séance night
const OVERVIEW_POS = new THREE.Vector3(0, 46, 78);
const OVERVIEW_TGT = new THREE.Vector3(0, 4, 0);

/** Flies the camera between the overview and the summoned ghost; hands control
 *  back to the user (orbit/zoom) once the flight lands. */
function CameraRig({ focus }: { focus: [number, number, number] | null }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const anim = useRef<{
    fromPos: THREE.Vector3;
    fromTgt: THREE.Vector3;
    toPos: THREE.Vector3;
    toTgt: THREE.Vector3;
    t: number;
  } | null>(null);
  const prevKey = useRef("overview");

  useEffect(() => {
    const key = focus ? focus.join(",") : "overview";
    if (key === prevKey.current || !controls.current) return;
    prevKey.current = key;
    const toPos = focus
      ? new THREE.Vector3(focus[0] + 15, focus[1] + 13, focus[2] + 24)
      : OVERVIEW_POS.clone();
    const toTgt = focus
      ? new THREE.Vector3(focus[0], focus[1] + 2.5, focus[2])
      : OVERVIEW_TGT.clone();
    anim.current = {
      fromPos: camera.position.clone(),
      fromTgt: controls.current.target.clone(),
      toPos,
      toTgt,
      t: 0,
    };
  }, [focus, camera]);

  useFrame((_, delta) => {
    const a = anim.current;
    const c = controls.current;
    if (!a || !c) return;
    a.t = Math.min(1, a.t + delta / 2.0);
    const e = a.t * a.t * (3 - 2 * a.t);
    camera.position.lerpVectors(a.fromPos, a.toPos, e);
    c.target.lerpVectors(a.fromTgt, a.toTgt, e);
    c.update();
    if (a.t >= 1) anim.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      enableDamping
      dampingFactor={0.08}
      minDistance={8}
      maxDistance={200}
      maxPolarAngle={Math.PI / 2.05}
      target={[0, 4, 0]}
    />
  );
}

function Scene({ corpus }: { corpus: CorpusData }) {
  const spirits = useMemo(() => buildSpirits(corpus.papers), [corpus.papers]);
  const { spirit, messages, channeling, summon, release, ask } = useSeance(corpus);

  const ghostPos = useMemo<[number, number, number] | null>(() => {
    if (!spirit) return null;
    const [x01, y01] = spirit.centroid;
    const [wx, wz] = toWorld(x01, y01);
    return [wx, sampleHeight(corpus.heightmap, x01, y01) * HEIGHT_SCALE, wz];
  }, [spirit, corpus.heightmap]);

  const lastAnswer = useMemo(
    () => [...messages].reverse().find((m) => m.role === "them"),
    [messages],
  );
  const cited = useMemo(() => lastAnswer?.cited ?? [], [lastAnswer]);
  const citedPapers = useMemo(() => cited.map((c) => c.paperIdx), [cited]);

  const yearsLabel = spirit
    ? spirit.yearMin > 0
      ? spirit.yearMin === spirit.yearMax
        ? `${spirit.yearMin}`
        : `${spirit.yearMin}–${spirit.yearMax}`
      : ""
    : "";

  // silence dims the ghost (empty retrieval most, a demurral somewhat)
  const presence = channeling ? 1 : lastAnswer?.silent ? 0.45 : lastAnswer?.demurred ? 0.7 : 1;

  return (
    <>
      <HDRCanvas
        camera={{ position: [0, 46, 78], fov: 55, near: 0.1, far: 400 }}
        clearColor={FOG_COLOR}
      >
        <fog attach="fog" args={[FOG_COLOR, 90, 240]} />
        <ambientLight intensity={0.4} />

        <SeanceLandmass
          corpus={corpus}
          authorPapers={spirit?.paperIdx ?? []}
          citedPapers={citedPapers}
        />

        {spirit && ghostPos && (
          <GhostFigure
            position={ghostPos}
            name={spirit.name}
            years={yearsLabel}
            presence={presence}
            channeling={channeling}
          />
        )}

        {spirit && ghostPos && cited.length > 0 && (
          <CitationThreads
            key={lastAnswer?.id ?? 0}
            origin={[ghostPos[0], ghostPos[1] + 2.6, ghostPos[2]]}
            sites={cited}
            heightmap={corpus.heightmap}
            heightScale={HEIGHT_SCALE}
          />
        )}

        <gridHelper
          args={[WORLD_SIZE, 20, 0x2c2c2a, 0x141a16]}
          position={[0, -0.5, 0]}
        />

        <CameraRig focus={ghostPos} />
      </HDRCanvas>

      {!spirit && <AuthorPicker spirits={spirits} onSummon={summon} />}

      {spirit && (
        <ChatPanel
          spirit={spirit}
          messages={messages}
          channeling={channeling}
          onAsk={ask}
          onRelease={release}
        />
      )}

      {/* map legend */}
      <div className="hud-panel pointer-events-none absolute bottom-5 left-5 z-40 px-4 py-3 text-xs text-ink-2">
        {spirit ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: GHOST_GREEN }}
              />
              {spirit.name}&apos;s passages
            </span>
            <span className="mx-2 text-ink-3">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-white/90" />
              cited by the last answer
            </span>
            <span className="mt-1 block text-ink-3">
              threads trace each answer back to the papers it was drawn from
            </span>
          </>
        ) : (
          <>
            the corpus lies dim below
            <span className="mt-1 block text-ink-3">
              summon an author to light their corner of it
            </span>
          </>
        )}
      </div>
    </>
  );
}

export default function SeanceSceneRoot() {
  const { corpus, error } = useCorpus();
  return (
    <div className="absolute inset-0">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!corpus && !error && <LoadingVeil label="lighting the candles…" />}
      {corpus && <Scene corpus={corpus} />}
    </div>
  );
}
