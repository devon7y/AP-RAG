"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  chooseNext,
  readMs,
  splitSentences,
} from "./walk";
import {
  cancelSpeech,
  primeVoices,
  speak,
  type SpeakHandle,
} from "./tts";
import { fetchChunkText } from "@/lib/atlas/api";
import type { CorpusData, KnnGraph } from "@/lib/atlas/types";
import { glowTexture, toWorldXZ, sampleField, type WorldData } from "./derive";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * Radio, reimagined as a rover: the same temperature-sampled kNN walk
 * (radio/walk.ts) now physically drives across the landscape, reading
 * passages aloud as it goes. The camera can follow (CameraRig), the tuner
 * biases the drive toward a station, and the trail glows behind it.
 */

const TRAIL_MAX = 80;
const ROVER_WARM = "#ffd9a8";

/* ---------------- the drive loop ---------------- */

export function useRover(corpus: CorpusData | null, knn: KnnGraph | null) {
  const radioOn = useWorld((s) => s.radioOn);
  const handle = useRef<SpeakHandle | null>(null);

  useEffect(() => {
    if (!radioOn || !corpus || !knn) return;
    let cancelled = false;
    const st = () => useWorld.getState();
    primeVoices();

    const run = async () => {
      let prev: number | null = null;
      let current =
        st().radioIdx ??
        st().radioStation?.topIdx ??
        Math.floor(Math.random() * corpus.atlas.n);
      while (!cancelled && st().radioOn) {
        st().set("radioIdx", current);
        st().set("radioTrail", [...st().radioTrail, current].slice(-TRAIL_MAX));

        let text = corpus.atlas.snippet[current];
        try {
          const rec = await fetchChunkText(corpus.atlas.chunkId[current]);
          text = rec.text;
        } catch {
          /* offline PC — drift on the snippet */
        }
        if (cancelled || !st().radioOn) break;

        for (const sentence of splitSentences(text).slice(0, 7)) {
          if (cancelled || !st().radioOn) break;
          st().set("radioSentence", sentence);
          if (st().radioMuted) {
            await new Promise((r) => setTimeout(r, readMs(sentence) * 0.7));
          } else {
            handle.current = speak(sentence, 1);
            await handle.current.done;
          }
        }
        if (cancelled || !st().radioOn) break;

        const next = chooseNext(
          knn,
          corpus.atlas,
          current,
          prev,
          st().radioTrail,
          st().radioStation,
          st().radioBias,
        );
        prev = current;
        current = next;
      }
      st().set("radioSentence", null);
    };
    run();

    return () => {
      cancelled = true;
      handle.current?.cancel();
      cancelSpeech();
    };
  }, [radioOn, corpus, knn]);
}

/* ---------------- visuals ---------------- */

function chunkMorphPos(data: WorldData, idx: number, m: number, out: THREE.Vector3) {
  return out.set(
    THREE.MathUtils.lerp(data.chunkGround[idx * 3], data.chunkSpace[idx * 3], m),
    THREE.MathUtils.lerp(data.chunkGroundY[idx], data.chunkSpace[idx * 3 + 1], m),
    THREE.MathUtils.lerp(data.chunkGround[idx * 3 + 2], data.chunkSpace[idx * 3 + 2], m),
  );
}

export default function RoverLayer({
  data,
  roverPosRef,
}: {
  data: WorldData;
  roverPosRef: { current: THREE.Vector3 | null };
}) {
  const radioOn = useWorld((s) => s.radioOn);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const { rover, halo, trailLine, trailGeo, stationFlag } = useMemo(() => {
    const glow = glowTexture();
    const rover = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    rover.material.color.set("#ffffff");
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.material.color.set(ROVER_WARM);

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    trailGeo.setDrawRange(0, 0);
    const trailLine = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({
        color: ROVER_WARM,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    trailLine.frustumCulled = false;

    const stationFlag = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    stationFlag.material.color.set("#d55181");
    return { rover, halo, trailLine, trailGeo, stationFlag };
  }, []);

  useEffect(
    () => () => {
      rover.material.dispose();
      halo.material.dispose();
      trailGeo.dispose();
      (trailLine.material as THREE.Material).dispose();
      stationFlag.material.dispose();
    },
    [rover, halo, trailGeo, trailLine, stationFlag],
  );

  // hop animation state
  const anim = useRef<{ from: THREE.Vector3; toIdx: number; t: number } | null>(null);
  const lastIdx = useRef<number | null>(null);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const target = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const st = useWorld.getState();
    const m = uMorph.value;
    const t = state.clock.elapsedTime;
    const on = st.radioOn && st.radioIdx !== null;
    rover.visible = on;
    halo.visible = on;
    trailLine.visible = on && st.radioTrail.length > 1;
    stationFlag.visible = st.radioStation !== null && m < 0.9;

    if (st.radioStation) {
      const [sx, sz] = toWorldXZ(st.radioStation.centroid[0], st.radioStation.centroid[1]);
      const sy =
        sampleField(data.eras.final, st.radioStation.centroid[0], st.radioStation.centroid[1]) *
        HEIGHT_SCALE;
      stationFlag.position.set(sx, sy + 5.5, sz);
      stationFlag.scale.set(1.8, 9, 1);
      stationFlag.material.opacity = (0.3 + 0.12 * Math.sin(t * 2.2)) * (1 - m);
    }

    if (!on || st.radioIdx === null) {
      roverPosRef.current = null;
      return;
    }

    // start a new hop when the walk advances
    if (st.radioIdx !== lastIdx.current) {
      anim.current = {
        from: lastIdx.current === null ? chunkMorphPos(data, st.radioIdx, m, pos).clone() : pos.clone(),
        toIdx: st.radioIdx,
        t: 0,
      };
      lastIdx.current = st.radioIdx;
    }

    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / 1.6);
      const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - (-2 * a.t + 2) ** 2 / 2;
      chunkMorphPos(data, a.toIdx, m, target);
      pos.lerpVectors(a.from, target, e);
      pos.y += Math.sin(Math.PI * e) * 1.6; // gentle hop
    }

    rover.position.copy(pos);
    rover.scale.setScalar(1.5 + 0.2 * Math.sin(t * 5.2));
    rover.material.opacity = 0.95 * boost;
    halo.position.copy(pos);
    halo.scale.setScalar(5.4 + 0.7 * Math.sin(t * 2.3));
    halo.material.opacity = 0.3;
    roverPosRef.current = pos;

    // trail through the recent walk (morph-aware)
    const attr = trailGeo.getAttribute("position") as THREE.BufferAttribute;
    const trail = st.radioTrail;
    const nPts = Math.min(trail.length, TRAIL_MAX);
    for (let i = 0; i < nPts; i++) {
      chunkMorphPos(data, trail[trail.length - nPts + i], m, target);
      attr.setXYZ(i, target.x, target.y + 0.35, target.z);
    }
    if (nPts > 0) attr.setXYZ(nPts - 1, pos.x, pos.y, pos.z);
    attr.needsUpdate = true;
    trailGeo.setDrawRange(0, nPts);
  });

  if (!radioOn) {
    // keep mounted while powered off so refs stay warm; visuals hide themselves
  }

  return (
    <group>
      <primitive object={trailLine} />
      <primitive object={halo} />
      <primitive object={rover} />
      <primitive object={stationFlag} />
    </group>
  );
}
