"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { glowTexture, ringTexture, sampleField, toWorldXZ, type WorldData } from "./derive";
import { useWorld, type PlantedGhost } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * The gap finder's markers: a violet column per user-picked spot. A finished
 * gap paper also gets an ECHO STAR — the point where its generated abstract
 * actually embeds — connected to the flag by a thin thread: a live check of
 * whether the proposed paper really fills the gap. Ground-anchored visuals
 * fade as the world lifts into space; echo stars persist in both frames.
 */

export const VOID_VIOLET = "#9085e9";
const BUSY_AMBER = "#c98500";
const ECHO_WHITE = "#e8e2ff";

export interface GhostSite {
  id: string;
  pos: THREE.Vector3;
}

/** World positions of the planted gap markers (for the picker + this layer). */
export function useGhostSites(data: WorldData): GhostSite[] {
  const ghosts = useWorld((s) => s.ghosts);
  return useMemo(
    () =>
      ghosts.map((g) => {
        const [x, z] = toWorldXZ(g.x01, g.y01);
        const y = sampleField(data.eras.final, g.x01, g.y01) * HEIGHT_SCALE;
        return { id: g.id, pos: new THREE.Vector3(x, y + 1.2, z) };
      }),
    [data, ghosts],
  );
}

function Well({
  pos,
  color,
  selected,
  busy,
  beamScale = 1,
}: {
  pos: THREE.Vector3;
  color: string;
  selected: boolean;
  busy?: boolean;
  beamScale?: number;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const { beam, base, ring } = useMemo(() => {
    const tex = glowTexture();
    const mk = () =>
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    const beam = new THREE.Sprite(mk());
    const base = new THREE.Sprite(mk());
    const ring = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    return { beam, base, ring };
  }, []);

  useEffect(() => {
    beam.material.color.set(color);
    base.material.color.set(color);
    ring.material.color.set(color);
  }, [beam, base, ring, color]);

  useEffect(
    () => () => {
      beam.material.dispose();
      base.material.dispose();
      ring.material.dispose();
    },
    [beam, base, ring],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const g = 1 - uMorph.value;
    const pulse = busy
      ? 0.65 + 0.35 * Math.sin(t * 7)
      : 0.55 + 0.2 * Math.sin(t * 1.7 + pos.x);
    const sel = selected ? 1.45 : 1;

    beam.position.set(pos.x, pos.y + 4.6 * beamScale, pos.z);
    beam.scale.set(2.3 * sel * beamScale, 11.5 * beamScale, 1);
    beam.material.opacity = 0.5 * pulse * g * boost * (selected ? 1 : 0.8);

    base.position.set(pos.x, pos.y + 0.4, pos.z);
    base.scale.setScalar(8.5 * sel);
    base.material.opacity = 0.32 * pulse * g;

    ring.position.set(pos.x, pos.y + 0.6, pos.z);
    ring.scale.setScalar(3.4 * (1.05 + 0.18 * Math.sin(t * 2.2)));
    ring.material.opacity = (selected ? 0.9 : 0.4) * g;
    ring.material.rotation = t * 0.4;

    const vis = g > 0.03;
    beam.visible = vis;
    base.visible = vis;
    ring.visible = vis && (selected || busy === true);
  });

  return (
    <group>
      <primitive object={beam} />
      <primitive object={base} />
      <primitive object={ring} />
    </group>
  );
}

/** The echo star: where a written ghost actually embeds (both frames). */
function EchoStar({ ghost, data }: { ghost: PlantedGhost; data: WorldData }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const { star, thread, threadGeo } = useMemo(() => {
    const star = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    star.material.color.set(ECHO_WHITE);
    const threadGeo = new THREE.BufferGeometry();
    threadGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const thread = new THREE.Line(
      threadGeo,
      new THREE.LineBasicMaterial({
        color: VOID_VIOLET,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    return { star, thread, threadGeo };
  }, []);

  useEffect(
    () => () => {
      star.material.dispose();
      threadGeo.dispose();
      (thread.material as THREE.Material).dispose();
    },
    [star, thread, threadGeo],
  );

  const anchors = useMemo(() => {
    if (!ghost.echo?.length) return null;
    const g = new THREE.Vector3();
    const s = new THREE.Vector3();
    let w = 0;
    for (const h of ghost.echo) {
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
    const [fx, fz] = toWorldXZ(ghost.x01, ghost.y01);
    const fy = sampleField(data.eras.final, ghost.x01, ghost.y01) * HEIGHT_SCALE + 1.2;
    return { g, s, flag: new THREE.Vector3(fx, fy, fz) };
  }, [ghost, data]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    if (!anchors) return;
    const m = uMorph.value;
    tmp.copy(anchors.g).lerp(anchors.s, m);
    star.position.copy(tmp);
    const t = state.clock.elapsedTime;
    star.scale.setScalar(3.1 * (1 + 0.15 * Math.sin(t * 3.1)));
    star.material.opacity = 0.85 * boost;

    const p = threadGeo.getAttribute("position") as THREE.BufferAttribute;
    p.setXYZ(0, anchors.flag.x, anchors.flag.y + 1, anchors.flag.z);
    p.setXYZ(1, tmp.x, tmp.y, tmp.z);
    p.needsUpdate = true;
    (thread.material as THREE.LineBasicMaterial).opacity = 0.4 * (1 - m);
    thread.visible = m < 0.95;
  });

  if (!anchors) return null;
  return (
    <group>
      <primitive object={star} />
      <primitive object={thread} />
    </group>
  );
}

export default function GhostLayer({
  data,
  sites,
}: {
  data: WorldData;
  sites: GhostSite[];
}) {
  const ghosts = useWorld((s) => s.ghosts);
  const selection = useWorld((s) => s.selection);
  const selectedId = selection?.kind === "ghost" ? selection.id : null;
  const byId = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  return (
    <group>
      {ghosts.map((g) => {
        const site = byId.get(g.id);
        if (!site) return null;
        return (
          <group key={g.id}>
            <Well
              pos={site.pos}
              color={g.ghost ? VOID_VIOLET : BUSY_AMBER}
              selected={selectedId === g.id}
              busy={!g.ghost && !g.error}
              beamScale={0.75}
            />
            {g.ghost && <EchoStar ghost={g} data={data} />}
          </group>
        );
      })}
    </group>
  );
}
