"use client";

import { useEffect, useMemo } from "react";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { useAtlasStore } from "@/lib/atlas/store";
import { LABELED_ENTITIES, type EntityView, type ObservatoryData } from "./derive";
import { useObservatory } from "./store";

/**
 * Knowledge-graph entities drawn onto the sky the way star charts draw
 * constellations: line figures threading each entity's member stars, named in
 * small caps, plus an ultra-faint web of the strongest entity–entity relations.
 * Focusing an entity brightens its figure and reveals its relation lines.
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
}: {
  segments: Float32Array;
  color: string;
  opacity: number;
  renderOrder?: number;
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
    obj.material.color.set(color).multiplyScalar(boost);
    obj.material.opacity = opacity;
    obj.renderOrder = renderOrder;
  }, [obj, color, opacity, boost, renderOrder]);

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

  const t = 1 - Math.min(1, entity.rank / LABELED_ENTITIES);
  const fontSize = 1.1 + 1.05 * Math.pow(t, 1.4);
  const active = focused || hovered;
  const hitW = Math.min(17, entity.id.length * fontSize * 0.52) + 1.5;
  const hitH = fontSize * 2.2;

  return (
    <Billboard position={[entity.pos.x, entity.pos.y + 1.4, entity.pos.z]}>
      <Text
        fontSize={fontSize}
        color={active ? "#ffffff" : entity.color}
        fillOpacity={active ? 1 : 0.62}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.035}
        outlineColor="#05060e"
        maxWidth={17}
        textAlign="center"
        letterSpacing={0.06}
        renderOrder={10}
      >
        {entity.id}
      </Text>
      <Text
        position={[0, -0.42, 0]}
        fontSize={Math.max(0.55, fontSize * 0.34)}
        color={entity.color}
        fillOpacity={active ? 0.95 : 0.5}
        anchorX="center"
        anchorY="top"
        letterSpacing={0.28}
        outlineWidth={0.02}
        outlineColor="#05060e"
        renderOrder={10}
      >
        {`${entity.type.toUpperCase()} · ${entity.deg}`}
      </Text>
      {/* invisible hit plate so the name is reliably clickable */}
      <mesh
        position={[0, hitH * 0.25, -0.01]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHoveredEntity(entity.idx);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHoveredEntity(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          selectEntity(entity.idx);
        }}
      >
        <planeGeometry args={[hitW, hitH]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </Billboard>
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
    const list = data.entities.slice(0, LABELED_ENTITIES);
    if (focusIdx !== null && focusIdx >= LABELED_ENTITIES) list.push(data.entities[focusIdx]);
    return list;
  }, [data, focusIdx]);

  return (
    <group>
      {showWeb && (
        <LineLayer segments={data.webSegments} color="#9085e9" opacity={0.05} renderOrder={1} />
      )}
      {showFigures && (
        <LineLayer segments={data.ambientFigures} color="#8f9bd9" opacity={0.13} renderOrder={2} />
      )}
      {focus && focus.figure.length > 0 && (
        <LineLayer segments={focus.figure} color="#dfe6ff" opacity={0.8} renderOrder={3} />
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
