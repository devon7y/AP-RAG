"use client";

import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useAtlasStore } from "@/lib/atlas/store";
import {
  isGenericEntityName,
  LABELED_ENTITIES,
  type EntityView,
  type ObservatoryData,
} from "./derive";
import { useObservatory } from "./store";

/**
 * Knowledge-graph entities drawn onto the sky the way star charts draw
 * constellations: line figures threading each entity's member stars, named in
 * small caps, plus an ultra-faint web of the strongest entity–entity relations.
 * Focusing an entity brightens its figure and reveals its relation lines.
 *
 * Labels are drei <Html> (DOM), not troika <Text>: troika's GlyphsGeometry
 * leaves instanceCount = Infinity until its async sync, and three r185's
 * WebGPU backend passes that straight to drawIndexed — one mounted label
 * kills the whole render pass. DOM labels also give native click targets.
 */

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(segments, 3));
  return g;
}

function LineLayer({
  segments,
  color,
  opacity,
  renderOrder = 1,
  boostK = 0.25,
}: {
  segments: Float32Array;
  color: string;
  opacity: number;
  renderOrder?: number;
  /** how much of the HDR headroom the layer uses (hairlines burn out at full boost) */
  boostK?: number;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const obj = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(segmentsGeometry(segments), mat);
    lines.frustumCulled = false;
    return lines;
  }, [segments]);

  useEffect(() => {
    obj.material.color.set(color).multiplyScalar(1 + (boost - 1) * boostK);
    obj.material.opacity = opacity;
    obj.renderOrder = renderOrder;
  }, [obj, color, opacity, boost, boostK, renderOrder]);

  useEffect(
    () => () => {
      obj.geometry.dispose();
      obj.material.dispose();
    },
    [obj],
  );

  return <primitive object={obj} />;
}

function ConstellationLabel({ entity, focused }: { entity: EntityView; focused: boolean }) {
  const selectEntity = useObservatory((s) => s.selectEntity);
  const setHoveredEntity = useObservatory((s) => s.setHoveredEntity);
  const hoveredEntity = useObservatory((s) => s.hoveredEntity);
  const hovered = hoveredEntity === entity.idx;
  const active = focused || hovered;

  const t = 1 - Math.min(1, entity.rank / LABELED_ENTITIES);
  const namePx = 13 + Math.round(10 * Math.pow(t, 1.4));

  return (
    <Html
      position={[entity.pos.x, entity.pos.y + 1.2, entity.pos.z]}
      center
      distanceFactor={62}
      zIndexRange={[20, 0]}
      style={{ pointerEvents: "none" }}
    >
      <button
        onClick={() => selectEntity(entity.idx)}
        onPointerEnter={() => setHoveredEntity(entity.idx)}
        onPointerLeave={() => setHoveredEntity(null)}
        className="block cursor-pointer select-none text-center"
        style={{ pointerEvents: "auto", background: "none", border: "none", padding: "2px 6px" }}
      >
        <span
          className="font-display block leading-tight whitespace-nowrap"
          style={{
            fontSize: namePx,
            color: active ? "#ffffff" : entity.color,
            opacity: active ? 1 : 0.78,
            textShadow: `0 0 10px ${entity.color}${active ? "cc" : "55"}, 0 1px 3px #05060e`,
          }}
        >
          {entity.id}
        </span>
        <span
          className="block whitespace-nowrap uppercase"
          style={{
            fontSize: Math.max(8, Math.round(namePx * 0.5)),
            letterSpacing: "0.28em",
            color: entity.color,
            opacity: active ? 0.95 : 0.55,
            textShadow: "0 1px 3px #05060e",
          }}
        >
          {entity.type} · {entity.deg}
        </span>
      </button>
    </Html>
  );
}

export default function Constellations({ data }: { data: ObservatoryData }) {
  const showFigures = useObservatory((s) => s.showFigures);
  const showWeb = useObservatory((s) => s.showWeb);
  const selection = useObservatory((s) => s.selection);
  const hoveredEntity = useObservatory((s) => s.hoveredEntity);

  const focusedIdx = selection?.kind === "entity" ? selection.idx : null;
  const focusIdx = focusedIdx ?? hoveredEntity;
  const focus = focusIdx !== null ? data.entities[focusIdx] : null;

  // relation lines radiating from the focused constellation
  const focusEdges = useMemo(() => {
    if (!focus) return null;
    const edges = (data.edgesByEntity.get(focus.idx) ?? []).slice(0, 10);
    if (!edges.length) return null;
    const seg = new Float32Array(edges.length * 6);
    edges.forEach((e, i) => {
      const o = data.entities[e.other].pos;
      seg.set([focus.pos.x, focus.pos.y, focus.pos.z, o.x, o.y, o.z], i * 6);
    });
    return seg;
  }, [focus, data]);

  const labeled = useMemo(() => {
    const list = data.entities
      .filter((e) => !isGenericEntityName(e.id))
      .slice(0, LABELED_ENTITIES);
    if (focusIdx !== null && !list.includes(data.entities[focusIdx]))
      list.push(data.entities[focusIdx]);
    return list;
  }, [data, focusIdx]);

  return (
    <group>
      {showWeb && (
        <LineLayer segments={data.webSegments} color="#9085e9" opacity={0.05} renderOrder={1} />
      )}
      {showFigures && (
        <LineLayer segments={data.ambientFigures} color="#8f9bd9" opacity={0.1} renderOrder={2} />
      )}
      {focus && focus.figure.length > 0 && (
        <LineLayer
          segments={focus.figure}
          color="#dfe6ff"
          opacity={0.8}
          renderOrder={3}
          boostK={1}
        />
      )}
      {focus && focusEdges && (
        <LineLayer segments={focusEdges} color={focus.color} opacity={0.38} renderOrder={2} />
      )}
      {labeled.map((e) => (
        <ConstellationLabel key={e.idx} entity={e} focused={focusIdx === e.idx} />
      ))}
    </group>
  );
}
