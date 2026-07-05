"use client";

import * as THREE from "three";
import type { AuthorRec } from "@/lib/atlas/types";
import { traceWaypoints } from "./ArcLayer";
import type { ArithResult, Trace } from "./engineBridge";
import { paperWorldPos } from "./PaperBeacons";
import { sampleField, toWorldXZ, type WorldData } from "./derive";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";

/** Warp so that all given points fit comfortably in frame. */
export function fitPointsWarp(pts: THREE.Vector3[], duration = 2.2): void {
  if (!pts.length) return;
  const box = new THREE.Box3().setFromPoints(pts);
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const standoff = THREE.MathUtils.clamp(sphere.radius * 2.4 + 10, 26, 190);
  useWorld
    .getState()
    .requestWarp([center.x, center.y, center.z], standoff, duration);
}

/** Frame an author's whole trail. */
export function fitAuthorTrail(data: WorldData, rec: AuthorRec): void {
  const m = uMorph.value;
  const pts = rec.papers.map((p) => paperWorldPos(data, p, m, new THREE.Vector3()));
  fitPointsWarp(pts, 2.2);
}

/** Frame an arithmetic result: the three anchors plus every hit. */
export function fitArith(data: WorldData, arith: ArithResult): void {
  const m = uMorph.value;
  const pts: THREE.Vector3[] = [];
  for (const a of arith.anchors) {
    const [x, z] = toWorldXZ(a.pos2[0], a.pos2[1]);
    const y = sampleField(data.eras.final, a.pos2[0], a.pos2[1]) * HEIGHT_SCALE + 3;
    pts.push(new THREE.Vector3(x, y * (1 - m), z));
  }
  for (const h of arith.hits) {
    if (h.chunkIdx < 0) continue;
    const i = h.chunkIdx;
    pts.push(
      new THREE.Vector3(
        THREE.MathUtils.lerp(data.chunkGround[i * 3], data.chunkSpace[i * 3], m),
        THREE.MathUtils.lerp(data.chunkGroundY[i], data.chunkSpace[i * 3 + 1], m),
        THREE.MathUtils.lerp(
          data.chunkGround[i * 3 + 2],
          data.chunkSpace[i * 3 + 2],
          m,
        ),
      ),
    );
  }
  fitPointsWarp(pts, 2.2);
}

/** Frame the whole interpolation arc (waypoints + its lifted apex). */
export function fitTrace(data: WorldData, trace: Trace): void {
  const m = uMorph.value;
  const way = traceWaypoints(data, trace);
  const pts = way.map((p) => p.g.clone().lerp(p.s, m));
  if (pts.length >= 2) {
    const span = pts[0].distanceTo(pts[pts.length - 1]);
    const apex = pts[0]
      .clone()
      .lerp(pts[pts.length - 1], 0.5)
      .add(new THREE.Vector3(0, (3.5 + 5 + span * 0.14) * (1 - m), 0));
    pts.push(apex);
  }
  fitPointsWarp(pts, 2.2);
}
