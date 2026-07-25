"use client";

import * as THREE from "three";
import { glowTexture, ringTexture } from "./derive";
import type { AircraftSpec } from "./aircraft";

/**
 * Ordnance and missions — the paper-themed game layer.
 *
 * The A380 flies cargo runs: packages are released with the aircraft's own
 * momentum and fall ballistically, so you have to lead the target and account
 * for altitude. The F-117 flies strike missions: missiles leave the rails fast
 * and flat, and a hit is judged by closest approach along the flight segment
 * (not by sampling positions, which would tunnel straight through a target at
 * 45 units/s).
 *
 * Either way the payload is a paper: score a hit and that paper's card opens,
 * exactly as if you had clicked its beacon.
 */

const MAX_SHOTS = 16;
const MAX_PUFFS = 10;
const PUFF_LIFE = 1.1;

export interface Shot {
  live: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  sprite: THREE.Sprite;
}

export interface HitEvent {
  ok: boolean;
  /** where it landed, for the impact puff */
  at: THREE.Vector3;
  /** horizontal miss distance in world units */
  miss: number;
}

export interface OrdnanceRig {
  group: THREE.Group;
  fire(from: THREE.Vector3, forward: THREE.Vector3, planeSpeed: number): boolean;
  /** advance every shot; returns the hits/misses resolved this frame */
  step(
    dt: number,
    ground: (x: number, z: number) => number,
    target: THREE.Vector3 | null,
  ): HitEvent[];
  cool(dt: number): void;
  ready(): boolean;
  dispose(): void;
}

export function createOrdnance(spec: AircraftSpec): OrdnanceRig {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const W = spec.weapon;
  const glow = glowTexture();

  const shots: Shot[] = [];
  for (let i = 0; i < MAX_SHOTS; i++) {
    const m = new THREE.SpriteMaterial({
      map: glow,
      color: W.color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    disposables.push(m);
    const sp = new THREE.Sprite(m);
    sp.visible = false;
    // a missile reads as a streak, a package as a compact parcel
    sp.scale.set(W.size, W.kind === "missile" ? W.size * 0.55 : W.size, 1);
    group.add(sp);
    shots.push({
      live: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      age: 0,
      sprite: sp,
    });
  }

  // impact puffs — gold for a hit on the paper, cold grey for a miss
  const puffs: { life: number; ok: boolean; ring: THREE.Sprite; flash: THREE.Sprite }[] = [];
  for (let i = 0; i < MAX_PUFFS; i++) {
    const mk = (map: THREE.Texture) => {
      const m = new THREE.SpriteMaterial({
        map,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        toneMapped: false,
      });
      disposables.push(m);
      const sp = new THREE.Sprite(m);
      sp.visible = false;
      group.add(sp);
      return sp;
    };
    puffs.push({ life: 0, ok: false, ring: mk(ringTexture()), flash: mk(glow) });
  }

  let cooldown = 0;
  const tmp = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();

  const puff = (at: THREE.Vector3, ok: boolean) => {
    const p = puffs.find((q) => q.life <= 0) ?? puffs[0];
    p.life = PUFF_LIFE;
    p.ok = ok;
    p.ring.position.copy(at);
    p.flash.position.copy(at);
    p.ring.visible = true;
    p.flash.visible = true;
    const c = ok ? "#ffd27a" : "#93a4b4";
    p.ring.material.color.set(c);
    p.flash.material.color.set(c);
  };

  return {
    group,
    ready: () => cooldown <= 0,
    cool(dt) {
      if (cooldown > 0) cooldown -= dt;
    },
    fire(from, forward, planeSpeed) {
      if (cooldown > 0) return false;
      const s = shots.find((q) => !q.live);
      if (!s) return false;
      cooldown = W.cooldown;
      s.live = true;
      s.age = 0;
      s.pos.copy(from);
      // released WITH the aircraft's momentum — a package keeps the jet's
      // velocity and only then starts falling, so you must lead the drop
      s.vel.copy(forward).multiplyScalar(planeSpeed + W.launchSpeed);
      s.sprite.position.copy(s.pos);
      s.sprite.visible = true;
      s.sprite.material.opacity = 1;
      return true;
    },
    step(dt, ground, target) {
      const events: HitEvent[] = [];
      for (const s of shots) {
        if (!s.live) continue;
        s.age += dt;
        seg.copy(s.pos); // where it was, for the swept hit test
        s.vel.y -= W.gravity * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.sprite.position.copy(s.pos);

        let done = false;
        let ok = false;
        let miss = Number.POSITIVE_INFINITY;

        if (target) {
          if (W.kind === "missile") {
            // closest approach of this frame's segment to the beacon: at 45
            // units/s a point test would step straight past a 1.6-unit target
            rel.copy(target).sub(seg);
            tmp.copy(s.pos).sub(seg);
            const len2 = tmp.lengthSq();
            const t = len2 > 1e-9 ? THREE.MathUtils.clamp(rel.dot(tmp) / len2, 0, 1) : 0;
            miss = tmp.multiplyScalar(t).add(seg).distanceTo(target);
            if (miss <= W.hitRadius) {
              ok = true;
              done = true;
            }
          }
        }

        // ground contact ends any shot. A package is judged where it lands; a
        // missile that ploughs into terrain still reports how far off it was,
        // so a miss always gets feedback rather than silently vanishing.
        if (!done) {
          const gy = Math.max(ground(s.pos.x, s.pos.z), 0);
          if (s.pos.y <= gy) {
            s.pos.y = gy;
            done = true;
            if (target) {
              miss = Math.hypot(s.pos.x - target.x, s.pos.z - target.z);
              ok = W.kind === "package" && miss <= W.hitRadius;
            }
          }
        }
        if (!done && s.age > W.life) done = true;

        if (done) {
          s.live = false;
          s.sprite.visible = false;
          if (Number.isFinite(miss)) events.push({ ok, at: s.pos.clone(), miss });
          else events.push({ ok: false, at: s.pos.clone(), miss: -1 });
          puff(s.pos, ok);
        }
      }

      for (const p of puffs) {
        if (p.life <= 0) continue;
        p.life -= dt;
        const k = Math.max(0, p.life / PUFF_LIFE);
        const grow = 1 - k;
        p.ring.scale.setScalar(0.6 + 9 * grow);
        p.ring.material.opacity = k * 0.85;
        p.flash.scale.setScalar(2.4 + 5 * grow);
        p.flash.material.opacity = k * k * 0.9;
        if (p.life <= 0) {
          p.ring.visible = false;
          p.flash.visible = false;
        }
      }
      return events;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/* ---------------- the target marker ---------------- */

export interface TargetMarker {
  group: THREE.Group;
  place(at: THREE.Vector3 | null): void;
  step(t: number, boost: number): void;
  dispose(): void;
}

/** A shaft of light over the paper you are hunting, visible from altitude. */
export function createTargetMarker(): TargetMarker {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 60, 12, 1, true);
  beamGeo.translate(0, 30, 0);
  const beamMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color("#ffd27a"),
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  disposables.push(beamGeo, beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  group.add(beam);

  const ringMat = new THREE.SpriteMaterial({
    map: ringTexture(),
    color: new THREE.Color("#ffd27a"),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  disposables.push(ringMat);
  const ring = new THREE.Sprite(ringMat);
  ring.renderOrder = 12;
  group.add(ring);

  group.visible = false;
  return {
    group,
    place(at) {
      group.visible = at !== null;
      if (at) group.position.copy(at);
    },
    step(t, boost) {
      if (!group.visible) return;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.1);
      beamMat.opacity = (0.07 + 0.07 * pulse) * boost;
      ring.scale.setScalar(3.4 + 1.1 * pulse);
      ringMat.opacity = (0.5 + 0.35 * pulse) * boost;
      ringMat.rotation = t * 0.5;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
