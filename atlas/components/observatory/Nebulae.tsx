"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useAtlasStore } from "@/lib/store";
import { glowTexture, NEBULA_COUNT, TYPE_FALLBACK, type ObservatoryData } from "./derive";
import { useObservatory } from "./store";

/**
 * Nebulae mark the dense relation networks: the higher an entity's degree in
 * the knowledge graph, the bigger and brighter its gas cloud. Two additive
 * glow sprites per site (a wide wisp + a tighter core), tinted by entity type.
 * Clicking a nebula opens its constellation.
 */

interface NebulaSite {
  entityIdx: number;
  pos: THREE.Vector3;
  color: THREE.Color;
  scale: number;
  strength: number; // 0..1 by degree
  drift: number;
}

function Nebula({ site }: { site: NebulaSite }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const selectEntity = useObservatory((s) => s.selectEntity);
  const setHoveredEntity = useObservatory((s) => s.setHoveredEntity);
  const selection = useObservatory((s) => s.selection);
  const focused = selection?.kind === "entity" && selection.idx === site.entityIdx;

  const { outer, inner } = useMemo(() => {
    const mk = () =>
      new THREE.SpriteMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 1,
      });
    return { outer: new THREE.Sprite(mk()), inner: new THREE.Sprite(mk()) };
  }, []);

  useEffect(() => {
    const k = (focused ? 1.7 : 1.0) * boost;
    outer.material.color.copy(site.color).multiplyScalar((0.10 + 0.10 * site.strength) * k);
    inner.material.color.copy(site.color).multiplyScalar((0.16 + 0.14 * site.strength) * k);
  }, [outer, inner, site, boost, focused]);

  useEffect(
    () => () => {
      outer.material.dispose();
      inner.material.dispose();
    },
    [outer, inner],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const breathe = 1 + 0.06 * Math.sin(t * 0.22 + site.drift);
    outer.scale.setScalar(site.scale * breathe);
    inner.scale.setScalar(site.scale * 0.45 * (2 - breathe));
    outer.material.rotation = t * 0.016 + site.drift;
    inner.material.rotation = -t * 0.022 + site.drift;
  });

  return (
    <group position={site.pos}>
      <primitive object={outer} />
      <primitive object={inner} />
      {/* generous invisible hit target so the cloud is clickable */}
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          setHoveredEntity(site.entityIdx);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHoveredEntity(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          selectEntity(site.entityIdx);
        }}
      >
        <sphereGeometry args={[Math.max(1.6, site.scale * 0.22), 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

export default function Nebulae({ data }: { data: ObservatoryData }) {
  const show = useObservatory((s) => s.showNebulae);

  const sites = useMemo<NebulaSite[]>(() => {
    // untyped/"other" entities would render as gray smoke — leave them dark
    const top = data.entities.filter((e) => e.color !== TYPE_FALLBACK).slice(0, NEBULA_COUNT);
    const maxDeg = top[0]?.deg ?? 1;
    return top.map((e, i) => {
      const strength = Math.pow(e.deg / maxDeg, 0.7);
      return {
        entityIdx: e.idx,
        pos: e.pos,
        color: new THREE.Color(e.color),
        scale: 7 + 13 * strength,
        strength,
        drift: i * 0.73,
      };
    });
  }, [data]);

  if (!show) return null;
  return (
    <group>
      {sites.map((s) => (
        <Nebula key={s.entityIdx} site={s} />
      ))}
    </group>
  );
}
