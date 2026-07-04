"use client";

import * as THREE from "three";
import { mix, texture, uniform, vec2, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import { WORLD_SIZE } from "@/lib/atlas/data";

/**
 * Shared TSL uniforms — the world's single clock. Every material (terrain,
 * chunk cloud, paper beacons, sky) reads these same nodes, so the morph, the
 * time machine, and HDR headroom stay frame-perfect across layers.
 *
 * uMorph  0 = atlas (landscape)  →  1 = space (the map unfolds into a galaxy)
 * uYear   time-lens year (points with birth year > uYear are unborn)
 * uFlash  birth-flash strength while the time machine is playing
 * uCalm   resting brightness (scaled by HDR headroom)
 * uHit    highlight overshoot (search pulses, pings — full HDR)
 */

export const GRID = 256; // era height/color field resolution
export const HEIGHT_SCALE = 13;
export const CHUNK_LIFT = 0.55; // points hover just above the terrain skin

export const uMorph = uniform(0);
export const uYear = uniform(3000);
/** lower bound of the year window (0 = open; unknown-year points hide when set) */
export const uYearLo = uniform(0);
export const uFlash = uniform(0);
export const uCalm = uniform(1);
export const uHit = uniform(1);
/** blend between era height fields A→B */
export const uEraMix = uniform(0);

function blankTex(): THREE.DataTexture {
  const t = new THREE.DataTexture(
    new Float32Array([0]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType,
  );
  t.needsUpdate = true;
  return t;
}

/** Era-bracketing height fields (values 0..1); .value swapped by the driver. */
export const heightTexA = texture(blankTex());
export const heightTexB = texture(blankTex());

/** world XZ → density-field uv in [0,1]² */
export function groundUV(worldPos: Node<"vec3">) {
  return vec2(
    worldPos.x.div(WORLD_SIZE).add(0.5),
    worldPos.z.div(WORLD_SIZE).add(0.5),
  );
}

/** Era-blended terrain height (world units) at a world-space position node. */
export function groundHeight(worldPos: Node<"vec3">) {
  const uv = groundUV(worldPos);
  const hA = heightTexA.sample(uv).r;
  const hB = heightTexB.sample(uv).r;
  return mix(hA, hB, uEraMix).mul(HEIGHT_SCALE);
}

/** Morphed position: ground (terrain-following) ⇄ space (embedding cube). */
export function morphPosition(
  aGround: Node<"vec3">,
  aSpace: Node<"vec3">,
  lift = CHUNK_LIFT,
) {
  const grounded = vec3(
    aGround.x,
    groundHeight(aGround).add(lift),
    aGround.z,
  );
  return mix(grounded, aSpace, uMorph);
}
