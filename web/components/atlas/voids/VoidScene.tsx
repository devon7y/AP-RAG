"use client";

import { useMemo, useState } from "react";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import GhostVoids from "@/components/atlas/voids/GhostVoids";
import GhostPaperCard from "@/components/atlas/voids/GhostPaperCard";
import { useCorpus, LoadingVeil } from "@/lib/atlas/useCorpus";
import { useVoids } from "@/lib/atlas/voids";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/atlas/data";
import { clusterColor } from "@/lib/atlas/palette";
import type { CorpusData } from "@/lib/atlas/types";

const HEIGHT_SCALE = 16;

/** The corpus as a dim point-cloud landmass, so the voids read as empty holes. */
function Landmass({ corpus }: { corpus: CorpusData }) {
  const geom = useMemo(() => {
    const { atlas, heightmap } = corpus;
    const n = atlas.n;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x01 = atlas.pos2[i * 2];
      const y01 = atlas.pos2[i * 2 + 1];
      const [wx, wz] = toWorld(x01, y01);
      const h = sampleHeight(heightmap, x01, y01) * HEIGHT_SCALE;
      pos[i * 3] = wx;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = wz;
      c.set(clusterColor(atlas.cluster[i]));
      // dim + desaturate so ghosts pop; brighter with elevation
      const lift = 0.25 + 0.5 * (h / HEIGHT_SCALE);
      col[i * 3] = c.r * lift;
      col[i * 3 + 1] = c.g * lift;
      col[i * 3 + 2] = c.b * lift;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [corpus]);

  return (
    <points geometry={geom}>
      <pointsMaterial
        size={0.55}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.7}
        depthWrite={false}
      />
    </points>
  );
}

function Scene() {
  const { corpus } = useCorpus();
  const voids = useVoids();
  const [selected, setSelected] = useState<number | null>(null);
  if (!corpus || !voids) return null;

  const selectedSite = selected !== null ? voids[selected] : null;

  return (
    <>
      <HDRCanvas
        camera={{ position: [0, 46, 78], fov: 55, near: 0.1, far: 400 }}
        clearColor={0x08070c}
      >
        <fog attach="fog" args={[0x08070c, 90, 240]} />
        <ambientLight intensity={0.4} />

        <Landmass corpus={corpus} />
        <GhostVoids
          voids={voids}
          heightmap={corpus.heightmap}
          heightScale={HEIGHT_SCALE}
          selected={selected}
          onSelect={setSelected}
        />

        {/* faint base grid to seat the terrain */}
        <gridHelper
          args={[WORLD_SIZE, 20, 0x2c2c2a, 0x1c1c22]}
          position={[0, -0.5, 0]}
        />

        <OrbitControls
          enableDamping
          dampingFactor={0.08}
          minDistance={12}
          maxDistance={200}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, 4, 0]}
        />
      </HDRCanvas>

      <GhostPaperCard site={selectedSite} onClose={() => setSelected(null)} />

      {/* legend / count */}
      <div className="hud-panel pointer-events-none absolute bottom-5 left-5 z-40 px-4 py-3 text-xs text-ink-2">
        <span className="text-ink-3">{voids.length} voids</span> · empty pockets
        of the embedding space where no paper sits
        <span className="mt-1 block text-ink-3">
          click a violet spire to read its ghost paper
        </span>
      </div>
    </>
  );
}

export default function VoidSceneRoot() {
  const { corpus, error } = useCorpus();
  return (
    <div className="absolute inset-0">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!corpus && !error && <LoadingVeil label="charting the voids…" />}
      <Scene />
    </div>
  );
}
