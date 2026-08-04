"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { LineBasicNodeMaterial } from "three/webgpu";
import { attribute, mix, positionLocal, uniform, vec3 } from "three/tsl";
import { tempRGB } from "./temperature";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import { glowTexture, sampleField, type WorldData } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import { authorAnchors } from "./derive";
import { useWorld } from "./store";
import { HEIGHT_SCALE } from "./uniforms";
import { uCalm, uMorph } from "./uniforms";

/**
 * Metadata made visible:
 *  - AuthorTrail — whenever an author is selected or lensed, a gold,
 *    year-ordered comet line runs through their papers (a career's semantic
 *    drift), with a clickable waypoint dot per paper.
 *  - GamePings — Semantle guesses flare at the guessed oeuvre's location,
 *    colored by temperature.
 */

/** Clearance the trail keeps over terrain BETWEEN beacons (zero at each). */
const TRAIL_CLEARANCE = 2.2;

const TRAIL_GOLD = "#ffd27a";

interface TrailWaypoint {
  paperIdx: number;
  g: THREE.Vector3;
  s: THREE.Vector3;
}

/**
 * Every paper on the trail gets an always-visible label chip, kept close to
 * its beacon but de-overlapped in screen space each frame (labels are sorted
 * by projected y and pushed apart to a minimum gap).
 */
function TrailLabels({
  waypoints,
  corpus,
}: {
  waypoints: TrailWaypoint[];
  corpus: CorpusData;
}) {
  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const innerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const proj = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size }) => {
    const items: { i: number; y: number; visible: boolean }[] = [];
    waypoints.forEach((w, i) => {
      const g = groupRefs.current[i];
      if (!g) return;
      g.position.copy(w.g).lerp(w.s, uMorph.value);
      proj.copy(g.position).project(camera);
      items.push({
        i,
        y: ((1 - proj.y) / 2) * size.height,
        visible: proj.z < 1,
      });
    });
    items.sort((a, b) => a.y - b.y);
    let prevY = Number.NEGATIVE_INFINITY;
    let shown = 0;
    // A prolific author has hundreds of papers, and de-overlapping every label
    // by pushing it down the screen buries the map under a column of chips.
    // Only a budget of them gets named; the trail itself still shows the rest,
    // and clicking any dot opens that paper.
    const MAX_LABELS = 14;
    for (const it of items) {
      const el = innerRefs.current[it.i];
      if (!el) continue;
      if (!it.visible) {
        el.style.display = "none";
        continue;
      }
      if (shown >= MAX_LABELS) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      let y = it.y;
      if (y < prevY + 19) y = prevY + 19;
      prevY = y;
      shown++;
      el.style.transform = `translate(10px, ${y - it.y - 9}px)`;
    }
  });

  return (
    <>
      {waypoints.map((w, i) => {
        const p = corpus.papers[w.paperIdx];
        return (
          <group
            key={w.paperIdx}
            ref={(el) => {
              groupRefs.current[i] = el;
            }}
          >
            {/* no labels: de-overlapping a prolific author's papers buried the
                map under a column of chips. The trail shows them; click to open. */}
          </group>
        );
      })}
    </>
  );
}

function AuthorTrail({
  data,
  corpus,
  author,
}: {
  data: WorldData;
  corpus: CorpusData;
  author: AuthorRec;
}) {
  const built = useMemo(() => {
    const papers = [...author.papers].sort(
      (a, b) => (corpus.papers[a].year || 3000) - (corpus.papers[b].year || 3000),
    );
    if (papers.length < 2) return null;
    const tmp = new THREE.Vector3();
    const gPts: THREE.Vector3[] = [];
    const sPts: THREE.Vector3[] = [];
    for (const p of papers) {
      // the trail lands ON each beacon; clearing terrain is handled per-sample
      // below, so the curve arcs over hills instead of floating above them
      paperWorldPos(data, p, 0, tmp);
      gPts.push(tmp.clone());
      paperWorldPos(data, p, 1, tmp);
      sPts.push(tmp.clone());
    }
    const gCurve = new THREE.CatmullRomCurve3(gPts, false, "centripetal", 0.65);
    const sCurve = new THREE.CatmullRomCurve3(sPts, false, "centripetal", 0.65);
    // Samples must scale with the trail, not be a fixed budget: at 90 for the
    // whole curve a prolific author got barely one sample per segment, so the
    // Catmull-Rom curvature — and the bowing that lifts the line over terrain —
    // was never evaluated and the trail drew as straight runs between beacons.
    const N = Math.min(2400, Math.max(120, (gPts.length - 1) * 16));
    const pos = new Float32Array((N + 1) * 3);
    const spc = new Float32Array((N + 1) * 3);
    const col = new Float32Array((N + 1) * 3);
    const c = new THREE.Color(TRAIL_GOLD);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const gp = gCurve.getPoint(t);
      const sp = sCurve.getPoint(t);
      // Push the sample up only where the ground would swallow it. The lift
      // tapers to nothing at the waypoints, so the curve still touches every
      // beacon while bowing over whatever ridge lies between two of them.
      const gy = sampleField(
        data.eras.final,
        gp.x / WORLD_SIZE + 0.5,
        gp.z / WORLD_SIZE + 0.5,
      ) * HEIGHT_SCALE;
      const nearWaypoint = Math.abs(t * (gPts.length - 1) - Math.round(t * (gPts.length - 1)));
      const taper = Math.min(1, nearWaypoint * 4);
      const clear = gy + TRAIL_CLEARANCE * taper;
      pos.set([gp.x, Math.max(gp.y, clear), gp.z], i * 3);
      spc.set([sp.x, sp.y, sp.z], i * 3);
      const w = 0.35 + 0.65 * t; // brightens toward the present
      col.set([c.r * w, c.g * w, c.b * w], i * 3);
    }
    const waypoints = papers.map((p, i) => ({
      paperIdx: p,
      g: gPts[i],
      s: sPts[i],
    }));
    return { gCurve, sCurve, pos, spc, col, waypoints };
  }, [data, corpus, author]);

  const hdrBoost = useAtlasStore((s) => s.hdrBoost);
  const uTrailHdr = useMemo(() => uniform(1), []);
  useEffect(() => {
    uTrailHdr.value = hdrBoost;
  }, [hdrBoost, uTrailHdr]);

  const { line, geo, mat } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const mat = new LineBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.positionNode = mix(positionLocal, attribute<"vec3">("aSpace", "vec3"), uMorph);
    // The trail is a SCENE object, so unlike the DOM labels it can genuinely
    // overshoot: pushing gold past 1.0 on an extended-tone-mapped canvas lights
    // the display's HDR headroom, and the line already blends additively. The
    // uniform carries hdrBoost (2.2 on a true-HDR canvas, 1.0 otherwise) so SDR
    // and WebGL2 keep the old look instead of clipping to a flat yellow.
    mat.colorNode = vec3(attribute<"vec3">("aCol", "vec3"))
      .mul(uCalm.mul(1.6))
      .mul(uTrailHdr);
    mat.opacityNode = uCalm.mul(0.75);
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    return { line, geo, mat };
  }, []);

  useEffect(() => {
    if (!built) return;
    geo.setAttribute("position", new THREE.BufferAttribute(built.pos, 3));
    geo.setAttribute("aSpace", new THREE.BufferAttribute(built.spc, 3));
    geo.setAttribute("aCol", new THREE.BufferAttribute(built.col, 3));
    geo.computeBoundingSphere();
  }, [built, geo]);

  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );

  if (!built) return null;
  return (
    <group>
      <primitive object={line} />
      <TrailLabels waypoints={built.waypoints} corpus={corpus} />
    </group>
  );
}

const PING_LIFE = 7; // seconds

function GamePings({ data, authors }: { data: WorldData; authors: AuthorRec[] }) {
  const pings = useWorld((s) => s.gamePings);
  const group = useMemo(() => new THREE.Group(), []);

  useEffect(() => {
    // (re)build sprites for the current ping set
    for (const c of [...group.children]) {
      ((c as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
      group.remove(c);
    }
    const tex = glowTexture();
    for (const p of pings.slice(-14)) {
      const a = authors[p.authorIdx];
      if (!a) continue;
      const anchor = authorAnchors(a, data);
      const [r, g, b] = tempRGB(p.temperature);
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      s.material.color.setRGB(r, g, b);
      s.userData = { ...p, ground: anchor.ground, space: anchor.space };
      group.add(s);
    }
  }, [pings, authors, data, group]);

  useFrame(() => {
    const now = Date.now();
    const m = uMorph.value;
    for (const c of group.children) {
      const s = c as THREE.Sprite;
      const u = s.userData as {
        ts: number;
        temperature: number;
        ground: THREE.Vector3;
        space: THREE.Vector3;
      };
      const age = (now - u.ts) / 1000;
      const k = Math.max(0, 1 - age / PING_LIFE);
      s.visible = k > 0;
      if (!s.visible) continue;
      s.position.lerpVectors(u.ground, u.space, m);
      s.position.y += (1 - k) * 3.5;
      s.scale.setScalar(2 + (u.temperature / 100) * 4 + (1 - k) * 2.5);
      s.material.opacity = 0.75 * k;
    }
  });

  useEffect(
    () => () => {
      for (const c of group.children)
        ((c as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
    },
    [group],
  );

  return <primitive object={group} />;
}

export default function TrailsLayer({
  data,
  corpus,
  authors,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
}) {
  const lensAuthor = useWorld((s) => s.lens.author);
  const selection = useWorld((s) => s.selection);
  // the trail rides both the lens AND a plain author selection
  const authorIdx =
    lensAuthor ?? (selection?.kind === "author" ? selection.idx : null);
  const author = authorIdx !== null ? authors[authorIdx] : null;
  return (
    <group>
      {author && <AuthorTrail data={data} corpus={corpus} author={author} />}
      <GamePings data={data} authors={authors} />
    </group>
  );
}
