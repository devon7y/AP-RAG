"use client";

import * as THREE from "three";
import { glowTexture, ringTexture } from "./derive";
import type { AircraftSpec } from "./aircraft";

/**
 * Ordnance and missions — the paper-themed game layer.
 *
 * The A380 flies cargo runs: crates fall straight down out of the bay, so the
 * job is to be directly over the paper when you release. The F-117 flies
 * strike missions: missiles leave the rails fast
 * and flat, and a hit is judged by closest approach along the flight segment
 * (not by sampling positions, which would tunnel straight through a target at
 * ~64 units/s).
 *
 * Everything here is sized against the AIRFRAME, which is only ~0.16–0.26
 * world units long — ordnance lives in world space, so a "0.5" sprite would be
 * twice the length of the jet that fired it.
 *
 * Either way the payload is a paper: score a hit and that paper's card opens,
 * exactly as if you had clicked its beacon.
 */

const MAX_SHOTS = 16;
const MAX_PUFFS = 10;
const PUFF_LIFE = 1.1;
const TRAIL_N = 22;
const FORWARD = new THREE.Vector3(0, 0, 1);

export interface HitEvent {
  ok: boolean;
  at: THREE.Vector3;
  /** horizontal miss distance in world units (−1 = expired, no verdict) */
  miss: number;
}

interface Shot {
  live: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  spin: number;
  body: THREE.Object3D;
  flame: THREE.Sprite | null;
  trailGeo: THREE.BufferGeometry | null;
  trailLine: THREE.Line | null;
  trail: number[];
}

export interface OrdnanceRig {
  group: THREE.Group;
  fire(from: THREE.Vector3, forward: THREE.Vector3, planeSpeed: number): boolean;
  step(
    dt: number,
    ground: (x: number, z: number) => number,
    target: THREE.Vector3 | null,
    t: number,
  ): HitEvent[];
  cool(dt: number): void;
  ready(): boolean;
  dispose(): void;
}

export function createOrdnance(spec: AircraftSpec): OrdnanceRig {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const W = spec.weapon;
  const missile = W.kind === "missile";
  const L = W.size; // body length in world units

  // shared geometry/materials — 16 shots, one set of resources
  const skin = new THREE.MeshBasicMaterial({ color: new THREE.Color(W.color) });
  const dark = new THREE.MeshBasicMaterial({ color: new THREE.Color("#2b3138") });
  disposables.push(skin, dark);

  let bodyGeo: THREE.BufferGeometry;
  let noseGeo: THREE.BufferGeometry | null = null;
  let finGeo: THREE.BufferGeometry | null = null;
  if (missile) {
    bodyGeo = new THREE.CylinderGeometry(L * 0.1, L * 0.1, L * 0.72, 8);
    bodyGeo.rotateX(Math.PI / 2); // lie along +Z, the flight direction
    noseGeo = new THREE.ConeGeometry(L * 0.1, L * 0.28, 8);
    noseGeo.rotateX(Math.PI / 2);
    noseGeo.translate(0, 0, L * 0.5);
    finGeo = new THREE.BoxGeometry(L * 0.26, L * 0.02, L * 0.16);
    disposables.push(noseGeo, finGeo);
  } else {
    // a crate, not a glowing orb
    bodyGeo = new THREE.BoxGeometry(L, L * 0.8, L * 0.8);
  }
  disposables.push(bodyGeo);

  const shots: Shot[] = [];
  for (let i = 0; i < MAX_SHOTS; i++) {
    const holder = new THREE.Group();
    holder.visible = false;
    holder.add(new THREE.Mesh(bodyGeo, missile ? skin : dark));
    if (missile && noseGeo && finGeo) {
      holder.add(new THREE.Mesh(noseGeo, dark));
      for (let f = 0; f < 4; f++) {
        const fin = new THREE.Mesh(finGeo, dark);
        fin.position.z = -L * 0.3;
        fin.rotation.z = (f * Math.PI) / 2;
        fin.translateY(L * 0.13);
        holder.add(fin);
      }
    }
    group.add(holder);

    let flame: THREE.Sprite | null = null;
    let trailGeo: THREE.BufferGeometry | null = null;
    let trailLine: THREE.Line | null = null;
    if (missile) {
      const fm = new THREE.SpriteMaterial({
        map: glowTexture(),
        color: new THREE.Color("#ffd9a0"),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      disposables.push(fm);
      flame = new THREE.Sprite(fm);
      flame.position.z = -L * 0.45; // burning out of the tail
      flame.scale.setScalar(L * 0.85);
      holder.add(flame);

      trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      trailGeo.setDrawRange(0, 0);
      const tm = new THREE.LineBasicMaterial({
        color: new THREE.Color("#cfd8e6"),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      disposables.push(trailGeo, tm);
      trailLine = new THREE.Line(trailGeo, tm);
      trailLine.frustumCulled = false;
      trailLine.visible = false;
      group.add(trailLine); // world-space, so it stays put as the shot flies
    }

    shots.push({
      live: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      age: 0,
      spin: 0,
      body: holder,
      flame,
      trailGeo,
      trailLine,
      trail: [],
    });
  }

  // impact puffs — the ring expands to exactly the hit radius, so you can see
  // how close the shot came
  const puffs: {
    life: number;
    ring: THREE.Sprite;
    flash: THREE.Sprite;
  }[] = [];
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
    puffs.push({ life: 0, ring: mk(ringTexture()), flash: mk(glowTexture()) });
  }

  let cooldown = 0;
  const tmp = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const puff = (at: THREE.Vector3, ok: boolean) => {
    const p = puffs.find((q) => q.life <= 0) ?? puffs[0];
    p.life = PUFF_LIFE;
    p.ring.position.copy(at);
    p.flash.position.copy(at);
    p.ring.visible = true;
    p.flash.visible = true;
    const c = ok ? "#ffd27a" : "#93a4b4";
    p.ring.material.color.set(c);
    p.flash.material.color.set(c);
    p.ring.userData.ok = ok;
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
      s.spin = 0;
      s.pos.copy(from);
      // a missile carries the jet's velocity out of the rails; a crate does
      // not — it simply falls out of the bay, straight down from the release
      // point, so the drop is a matter of being over the target
      if (W.inheritMomentum) {
        s.vel.copy(forward).multiplyScalar(planeSpeed + W.launchSpeed);
      } else {
        s.vel.set(0, 0, 0);
      }
      s.body.position.copy(s.pos);
      s.body.visible = true;
      s.trail.length = 0;
      if (s.trailGeo) s.trailGeo.setDrawRange(0, 0);
      if (s.trailLine) s.trailLine.visible = true;
      return true;
    },
    step(dt, ground, target, t) {
      const events: HitEvent[] = [];
      for (const s of shots) {
        if (!s.live) continue;
        s.age += dt;
        seg.copy(s.pos);
        s.vel.y -= W.gravity * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.body.position.copy(s.pos);

        if (missile) {
          // point the airframe down its own velocity vector
          dir.copy(s.vel).normalize();
          s.body.quaternion.setFromUnitVectors(FORWARD, dir);
          if (s.flame) {
            s.flame.material.opacity = 0.75 + 0.25 * Math.sin(t * 60);
            s.flame.scale.setScalar(L * (0.75 + 0.25 * Math.sin(t * 47)));
          }
          s.trail.push(s.pos.x, s.pos.y, s.pos.z);
          if (s.trail.length > TRAIL_N * 3) s.trail.splice(0, 3);
          if (s.trailGeo) {
            const attr = s.trailGeo.getAttribute("position") as THREE.BufferAttribute;
            (attr.array as Float32Array).set(s.trail);
            attr.needsUpdate = true;
            s.trailGeo.setDrawRange(0, s.trail.length / 3);
          }
        } else {
          // a crate tumbles as it falls
          s.spin += dt * 3.2;
          s.body.rotation.set(s.spin, s.spin * 0.6, s.spin * 0.4);
        }

        let done = false;
        let ok = false;
        let miss = Number.POSITIVE_INFINITY;

        if (target && missile) {
          // closest approach of this frame's segment to the beacon: at ~64
          // units/s a point test would step straight past a 1.7-unit target
          rel.copy(target).sub(seg);
          tmp.copy(s.pos).sub(seg);
          const len2 = tmp.lengthSq();
          const k = len2 > 1e-9 ? THREE.MathUtils.clamp(rel.dot(tmp) / len2, 0, 1) : 0;
          miss = tmp.multiplyScalar(k).add(seg).distanceTo(target);
          if (miss <= W.hitRadius) {
            ok = true;
            done = true;
          }
        }

        // ground contact ends any shot. A crate is judged where it lands; a
        // missile that ploughs into terrain still reports how far off it was,
        // so a miss always gets feedback rather than silently vanishing.
        if (!done) {
          const gy = Math.max(ground(s.pos.x, s.pos.z), 0);
          if (s.pos.y <= gy) {
            s.pos.y = gy;
            done = true;
            if (target) {
              miss = Math.hypot(s.pos.x - target.x, s.pos.z - target.z);
              ok = !missile && miss <= W.hitRadius;
            }
          }
        }
        if (!done && s.age > W.life) done = true;

        if (done) {
          s.live = false;
          s.body.visible = false;
          if (s.trailLine) s.trailLine.visible = false;
          events.push({
            ok,
            at: s.pos.clone(),
            miss: Number.isFinite(miss) ? miss : -1,
          });
          puff(s.pos, ok);
        }
      }

      for (const p of puffs) {
        if (p.life <= 0) continue;
        p.life -= dt;
        const k = Math.max(0, p.life / PUFF_LIFE);
        const grow = 1 - k;
        // the ring opens out to the weapon's tolerance — a visible verdict
        p.ring.scale.setScalar(0.3 + W.hitRadius * 2 * grow);
        p.ring.material.opacity = k * (p.ring.userData.ok ? 0.95 : 0.6);
        p.flash.scale.setScalar(0.5 + 1.8 * grow);
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
