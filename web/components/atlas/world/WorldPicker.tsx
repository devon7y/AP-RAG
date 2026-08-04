"use client";

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { sampleEraHeight } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import type { WorldData } from "./derive";
import { entityWorldPos } from "./SkyLayer";
import { useWorld, type Selection } from "./store";
import { uMorph } from "./uniforms";

/**
 * Pointer picking against papers (always), entities (always) and chunks
 * (nearest-wins fallback) with angular cones, mirroring the morphed GPU
 * positions on the CPU. Double-click flies to the pick; in planting mode a
 * click drops a ghost flag on the map instead.
 *
 * Scale note: the chunk pass is a linear scan (fine at 9k; at ~500k gate it
 * on camera height or move to the uniform grid in derive).
 */

export default function WorldPicker({
  data,
  ghostSites,
}: {
  data: WorldData;
  ghostSites: { id: string; pos: THREE.Vector3 }[];
}) {
  const { camera, gl } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const sitesRef = useMemo(() => ({ current: ghostSites }), []);
  sitesRef.current = ghostSites;

  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let hovered: Selection = null;
    let down: { x: number; y: number; t: number } | null = null;
    let dragging = false;

    const pick = (e: PointerEvent | MouseEvent): Selection => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      const o = ray.ray.origin;
      const dir = ray.ray.direction;
      const morph = uMorph.value;

      let best: Selection = null;
      let bestQ = 1;

      const consider = (
        px: number,
        py: number,
        pz: number,
        appSize: number,
        make: () => Selection,
        priority = 1,
      ) => {
        const vx = px - o.x;
        const vy = py - o.y;
        const vz = pz - o.z;
        const dot = vx * dir.x + vy * dir.y + vz * dir.z;
        if (dot <= 0.5) return;
        const l2 = vx * vx + vy * vy + vz * vz;
        const cos2 = (dot * dot) / l2;
        const sin2 = 1 - cos2;
        const ang = Math.max(0.014, appSize / Math.sqrt(l2));
        const q = sin2 / (ang * ang) / priority;
        if (q < bestQ) {
          bestQ = q;
          best = make();
        }
      };

      if (morph < 0.6) {
        for (const site of sitesRef.current) {
          consider(
            site.pos.x,
            site.pos.y + 2.4,
            site.pos.z,
            3.4,
            () => ({ kind: "ghost", id: site.id }),
            1.5,
          );
        }
      }
      const st = useWorld.getState();
      // the graph only exists in the galaxy — no entity picking on the ground
      if (morph > 0.4) {
        for (let i = 0; i < data.entities.length; i++) {
          entityWorldPos(data, i, morph, tmp);
          consider(tmp.x, tmp.y, tmp.z, 1.6, () => ({ kind: "entity", idx: i }), 1.35);
        }
      }
      // a hidden layer is not a target — picking follows what is drawn, and
      // that includes the time lens: an unborn paper is invisible, so it must
      // not answer the cursor either
      const yHi = st.year + 0.01;
      const yLo = st.yearLo;
      const born = (y: number) => y === 0 || (y <= yHi && y >= yLo);
      // heights must come from the era the shader is drawing, not the present
      const groundY = (wx: number, wz: number, lift: number) =>
        sampleEraHeight(
          data.eras,
          st.year,
          wx / WORLD_SIZE + 0.5,
          wz / WORLD_SIZE + 0.5,
        ) + lift;
      if (st.showPapers) {
      for (let i = 0; i < data.nPapers; i++) {
        if (!born(data.paperYear[i])) continue;
        paperWorldPos(data, i, morph, tmp);
        tmp.y =
          groundY(data.paperGround[i * 3], data.paperGround[i * 3 + 2], data.paperLift[i]) *
            (1 - morph) +
          data.paperSpace[i * 3 + 1] * morph;
        consider(
          tmp.x,
          tmp.y,
          tmp.z,
          data.paperSize[i] * 1.1,
          () => ({ kind: "paper", idx: i }),
          1.25,
        );
      }
      }
      if (st.showChunks) {
      for (let i = 0; i < data.n; i++) {
        if (!born(data.chunkYear[i])) continue;
        const gx = data.chunkGround[i * 3];
        const gy = groundY(gx, data.chunkGround[i * 3 + 2], data.chunkSize[i] * 0.35);
        const gz = data.chunkGround[i * 3 + 2];
        const x = gx + (data.chunkSpace[i * 3] - gx) * morph;
        const y = gy + (data.chunkSpace[i * 3 + 1] - gy) * morph;
        const z = gz + (data.chunkSpace[i * 3 + 2] - gz) * morph;
        consider(x, y, z, data.chunkSize[i] * 0.8, () => ({ kind: "chunk", idx: i }));
      }
      }
      return best;
    };

    /** Map-plane coordinates for ghost planting (atlas view only). */
    const mapPoint = (e: MouseEvent): [number, number] | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      const t = -ray.ray.origin.y / ray.ray.direction.y;
      if (!Number.isFinite(t) || t <= 0) return null;
      const x = ray.ray.origin.x + ray.ray.direction.x * t;
      const z = ray.ray.origin.z + ray.ray.direction.z * t;
      const x01 = x / WORLD_SIZE + 0.5;
      const y01 = z / WORLD_SIZE + 0.5;
      if (x01 < 0 || x01 > 1 || y01 < 0 || y01 > 1) return null;
      return [x01, y01];
    };

    const same = (a: Selection, b: Selection) =>
      a === b ||
      (a !== null &&
        b !== null &&
        a.kind === b.kind &&
        (a as { idx?: number }).idx === (b as { idx?: number }).idx &&
        (a as { id?: string }).id === (b as { id?: string }).id);

    const onMove = (e: PointerEvent) => {
      if (down && (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5)) {
        dragging = true;
      }
      const st = useWorld.getState();
      if (dragging || st.warping) {
        if (hovered !== null) {
          hovered = null;
          st.hover(null);
          el.style.cursor = st.planting ? "crosshair" : "";
        }
        return;
      }
      if (st.planting) {
        el.style.cursor = "crosshair";
        return;
      }
      const hit = pick(e);
      if (!same(hit, hovered)) {
        hovered = hit;
        st.hover(hit);
        el.style.cursor = hit !== null ? "pointer" : "";
      }
    };

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      dragging = false;
    };

    const onUp = (e: PointerEvent) => {
      const wasDrag = dragging || !down || performance.now() - down.t > 450;
      down = null;
      dragging = false;
      if (wasDrag) return;
      const st = useWorld.getState();
      if (st.planting) {
        const pt = mapPoint(e);
        if (pt) {
          st.set("planting", false);
          el.style.cursor = "";
          window.dispatchEvent(
            new CustomEvent("world:plant-ghost", { detail: { x01: pt[0], y01: pt[1] } }),
          );
        }
        return;
      }
      const hit = pick(e);
      if (hit !== null) st.select(hit);
      else if (st.selection) st.select(null);
    };

    const onDblClick = (e: MouseEvent) => {
      const st = useWorld.getState();
      if (st.planting) return;
      const hit = pick(e);
      if (!hit) return;
      st.select(hit);
      const morph = uMorph.value;
      if (hit.kind === "paper") {
        paperWorldPos(data, hit.idx, morph, tmp);
        st.requestWarp([tmp.x, tmp.y, tmp.z], 9 + data.paperSize[hit.idx] * 2, 1.7);
      } else if (hit.kind === "entity") {
        entityWorldPos(data, hit.idx, morph, tmp);
        st.requestWarp([tmp.x, tmp.y, tmp.z], 13, 1.7);
      } else if (hit.kind === "chunk") {
        const i = hit.idx;
        const gx = data.chunkGround[i * 3];
        const gz = data.chunkGround[i * 3 + 2];
        // fly to where the passage is DRAWN in this era, not the present-day
        // surface, or the camera lands short whenever time is scrubbed back
        const gy =
          sampleEraHeight(
            data.eras,
            st.year,
            gx / WORLD_SIZE + 0.5,
            gz / WORLD_SIZE + 0.5,
          ) + data.chunkSize[i] * 0.35;
        const x = gx + (data.chunkSpace[i * 3] - gx) * morph;
        const y = gy + (data.chunkSpace[i * 3 + 1] - gy) * morph;
        const z = gz + (data.chunkSpace[i * 3 + 2] - gz) * morph;
        st.requestWarp([x, y, z], 6.5, 1.6);
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDblClick);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDblClick);
      el.style.cursor = "";
      useWorld.getState().hover(null);
    };
  }, [camera, gl, data, tmp]);

  return null;
}
