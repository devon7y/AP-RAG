"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CorpusData } from "@/lib/atlas/types";
import { sampleHeight, toWorld } from "@/lib/atlas/data";
import { clusterColor } from "@/lib/atlas/palette";
import { useAtlasStore } from "@/lib/atlas/store";
import { GHOST_GREEN, HEIGHT_SCALE } from "./theme";

/**
 * The corpus at a séance: the full landmass dimmed and desaturated to near-
 * monochrome, the summoned author's own chunks lit in spectral green, and the
 * chunks of currently-cited papers flaring warm. Three point clouds total —
 * each a single buffer geometry.
 */

function buildPositions(corpus: CorpusData, indices?: number[]): Float32Array {
  const { atlas, heightmap } = corpus;
  const idx = indices ?? Array.from({ length: atlas.n }, (_, i) => i);
  const pos = new Float32Array(idx.length * 3);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const x01 = atlas.pos2[i * 2];
    const y01 = atlas.pos2[i * 2 + 1];
    const [wx, wz] = toWorld(x01, y01);
    pos[j * 3] = wx;
    pos[j * 3 + 1] = sampleHeight(heightmap, x01, y01) * HEIGHT_SCALE;
    pos[j * 3 + 2] = wz;
  }
  return pos;
}

/** Indices of chunks belonging to any paper in `paperIdx`. */
function chunksOfPapers(corpus: CorpusData, paperIdx: number[]): number[] {
  const want = new Set(paperIdx);
  const out: number[] = [];
  for (let i = 0; i < corpus.atlas.n; i++) {
    if (want.has(corpus.atlas.paper[i])) out.push(i);
  }
  return out;
}

export default function SeanceLandmass({
  corpus,
  authorPapers,
  citedPapers,
}: {
  corpus: CorpusData;
  /** paper indices of the summoned author (their chunks glow green) */
  authorPapers: number[];
  /** paper indices cited by the latest answer (their chunks flare) */
  citedPapers: number[];
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const citedMat = useRef<THREE.PointsMaterial>(null);

  const baseGeom = useMemo(() => {
    const { atlas } = corpus;
    const pos = buildPositions(corpus);
    const col = new Float32Array(atlas.n * 3);
    const c = new THREE.Color();
    const gray = new THREE.Color("#3a3f3c");
    for (let i = 0; i < atlas.n; i++) {
      const h = pos[i * 3 + 1] / HEIGHT_SCALE;
      // heavily desaturated cluster tint, brighter with elevation
      c.set(clusterColor(atlas.cluster[i])).lerp(gray, 0.72).multiplyScalar(0.28 + 0.4 * h);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [corpus]);

  const authorGeom = useMemo(() => {
    if (!authorPapers.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(buildPositions(corpus, chunksOfPapers(corpus, authorPapers)), 3),
    );
    return g;
  }, [corpus, authorPapers]);

  const citedGeom = useMemo(() => {
    if (!citedPapers.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(buildPositions(corpus, chunksOfPapers(corpus, citedPapers)), 3),
    );
    return g;
  }, [corpus, citedPapers]);

  const authorColor = useMemo(
    () => new THREE.Color(GHOST_GREEN).multiplyScalar(0.75 * boost),
    [boost],
  );
  const citedColor = useMemo(
    () => new THREE.Color("#eafff2").multiplyScalar(0.9 * boost),
    [boost],
  );

  useFrame((state) => {
    if (citedMat.current) {
      citedMat.current.opacity = 0.55 + 0.35 * Math.sin(state.clock.elapsedTime * 2.4);
    }
  });

  return (
    <group>
      <points geometry={baseGeom}>
        <pointsMaterial
          size={0.5}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.55}
          depthWrite={false}
        />
      </points>
      {authorGeom && (
        <points geometry={authorGeom}>
          <pointsMaterial
            color={authorColor}
            size={0.85}
            sizeAttenuation
            transparent
            opacity={0.9}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </points>
      )}
      {citedGeom && (
        <points geometry={citedGeom}>
          <pointsMaterial
            ref={citedMat}
            color={citedColor}
            size={1.05}
            sizeAttenuation
            transparent
            opacity={0.8}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </points>
      )}
    </group>
  );
}
