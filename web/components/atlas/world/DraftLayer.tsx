"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { glowTexture, ringTexture, type WorldData } from "./derive";
import { useWorld, type DraftState } from "./store";
import { uMorph } from "./uniforms";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * Drop-a-draft marker: where the user's own text lands in the corpus. A teal
 * star at the score-weighted centroid of its nearest passages, with thin
 * threads out to the strongest neighbors — the instant related-work fan.
 * Lives in both frames (ground and space) like the ghost echo star.
 */

export const DRAFT_TEAL = "#53d6b0";
const THREADS = 6;

/** Landing anchors in both frames: score²-weighted centroid of the hits. */
export function draftAnchors(
  data: WorldData,
  hits: { idx: number; score: number }[],
): { ground: THREE.Vector3; space: THREE.Vector3 } | null {
  if (!hits.length) return null;
  const g = new THREE.Vector3();
  const s = new THREE.Vector3();
  let w = 0;
  for (const h of hits.slice(0, 8)) {
    const wi = Math.max(0.01, h.score) ** 2;
    g.x += data.chunkGround[h.idx * 3] * wi;
    g.y += data.chunkGroundY[h.idx] * wi;
    g.z += data.chunkGround[h.idx * 3 + 2] * wi;
    s.x += data.chunkSpace[h.idx * 3] * wi;
    s.y += data.chunkSpace[h.idx * 3 + 1] * wi;
    s.z += data.chunkSpace[h.idx * 3 + 2] * wi;
    w += wi;
  }
  g.divideScalar(w);
  s.divideScalar(w);
  g.y += 1.4; // float clear of the terrain
  return { ground: g, space: s };
}

function DraftStar({ data, draft }: { data: WorldData; draft: DraftState }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const { star, ring, threads, threadGeo } = useMemo(() => {
    const star = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    star.material.color.set(DRAFT_TEAL);
    const ring = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.material.color.set(DRAFT_TEAL);
    const threadGeo = new THREE.BufferGeometry();
    threadGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(THREADS * 6), 3),
    );
    const threads = new THREE.LineSegments(
      threadGeo,
      new THREE.LineBasicMaterial({
        color: DRAFT_TEAL,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    return { star, ring, threads, threadGeo };
  }, []);

  useEffect(
    () => () => {
      star.material.dispose();
      ring.material.dispose();
      threadGeo.dispose();
      (threads.material as THREE.Material).dispose();
    },
    [star, ring, threads, threadGeo],
  );

  const anchors = useMemo(() => draftAnchors(data, draft.hits), [data, draft]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  const tmp2 = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    if (!anchors) return;
    const m = uMorph.value;
    const t = state.clock.elapsedTime;
    tmp.copy(anchors.ground).lerp(anchors.space, m);

    star.position.copy(tmp);
    star.scale.setScalar(4.2 * (1 + 0.14 * Math.sin(t * 2.6)));
    star.material.opacity = 0.9 * boost;

    ring.position.copy(tmp);
    ring.scale.setScalar(3.0 * (1.05 + 0.2 * Math.sin(t * 2.2)));
    ring.material.rotation = t * 0.35;
    ring.material.opacity = 0.55;

    const p = threadGeo.getAttribute("position") as THREE.BufferAttribute;
    const top = draft.hits.slice(0, THREADS);
    for (let i = 0; i < THREADS; i++) {
      const h = top[i];
      if (h) {
        tmp2.set(
          THREE.MathUtils.lerp(data.chunkGround[h.idx * 3], data.chunkSpace[h.idx * 3], m),
          THREE.MathUtils.lerp(data.chunkGroundY[h.idx], data.chunkSpace[h.idx * 3 + 1], m),
          THREE.MathUtils.lerp(
            data.chunkGround[h.idx * 3 + 2],
            data.chunkSpace[h.idx * 3 + 2],
            m,
          ),
        );
      } else {
        tmp2.copy(tmp);
      }
      p.setXYZ(i * 2, tmp.x, tmp.y, tmp.z);
      p.setXYZ(i * 2 + 1, tmp2.x, tmp2.y, tmp2.z);
    }
    p.needsUpdate = true;
  });

  if (!anchors) return null;
  return (
    <group>
      <primitive object={star} />
      <primitive object={ring} />
      <primitive object={threads} />
    </group>
  );
}

export default function DraftLayer({ data }: { data: WorldData }) {
  const draft = useWorld((s) => s.draft);
  if (!draft || draft.status !== "done" || !draft.hits.length) return null;
  return <DraftStar data={data} draft={draft} />;
}
