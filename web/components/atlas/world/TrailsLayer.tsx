"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { LineBasicNodeMaterial } from "three/webgpu";
import { attribute, mix, positionLocal, vec3 } from "three/tsl";
import { tempRGB } from "./temperature";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { glowTexture, type WorldData } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import { authorAnchors } from "./derive";
import { useWorld } from "./store";
import { uCalm, uMorph } from "./uniforms";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * Metadata made visible:
 *  - AuthorTrail — whenever an author is selected or lensed, a gold,
 *    year-ordered comet line runs through their papers (a career's semantic
 *    drift), with a clickable waypoint dot per paper.
 *  - GamePings — Semantle guesses flare at the guessed oeuvre's location,
 *    colored by temperature.
 */

const TRAIL_GOLD = "#ffd27a";

/** Clickable waypoint dot on the trail — native title tooltip, morph-aware. */
function Waypoint({
  paperIdx,
  g,
  s,
  title,
  year,
}: {
  paperIdx: number;
  g: THREE.Vector3;
  s: THREE.Vector3;
  title: string;
  year: number;
}) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    group.current?.position.copy(g).lerp(s, uMorph.value);
  });
  return (
    <group ref={group}>
      <Html center zIndexRange={[24, 0]} style={{ pointerEvents: "none" }}>
        <button
          type="button"
          title={`${year || "n.d."} — ${title}`}
          onClick={() => useWorld.getState().select({ kind: "paper", idx: paperIdx })}
          className="pointer-events-auto block h-3 w-3 cursor-pointer rounded-full border transition-transform hover:scale-150"
          style={{
            borderColor: TRAIL_GOLD,
            background: "rgba(255,210,122,0.35)",
            boxShadow: "0 0 8px rgba(255,210,122,0.8)",
          }}
        />
      </Html>
    </group>
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
  const boost = useAtlasStore((s) => s.hdrBoost);

  const built = useMemo(() => {
    const papers = [...author.papers].sort(
      (a, b) => (corpus.papers[a].year || 3000) - (corpus.papers[b].year || 3000),
    );
    if (papers.length < 2) return null;
    const tmp = new THREE.Vector3();
    const gPts: THREE.Vector3[] = [];
    const sPts: THREE.Vector3[] = [];
    for (const p of papers) {
      paperWorldPos(data, p, 0, tmp);
      gPts.push(tmp.clone().add(new THREE.Vector3(0, 1.2, 0)));
      paperWorldPos(data, p, 1, tmp);
      sPts.push(tmp.clone());
    }
    const gCurve = new THREE.CatmullRomCurve3(gPts, false, "centripetal", 0.65);
    const sCurve = new THREE.CatmullRomCurve3(sPts, false, "centripetal", 0.65);
    const N = 90;
    const pos = new Float32Array((N + 1) * 3);
    const spc = new Float32Array((N + 1) * 3);
    const col = new Float32Array((N + 1) * 3);
    const c = new THREE.Color(TRAIL_GOLD);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const gp = gCurve.getPoint(t);
      const sp = sCurve.getPoint(t);
      pos.set([gp.x, gp.y, gp.z], i * 3);
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

  const { line, geo, mat, comet } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const mat = new LineBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.positionNode = mix(positionLocal, attribute<"vec3">("aSpace", "vec3"), uMorph);
    mat.colorNode = vec3(attribute<"vec3">("aCol", "vec3")).mul(uCalm.mul(1.3));
    mat.opacityNode = uCalm.mul(0.75);
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    const comet = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    comet.material.color.set(TRAIL_GOLD);
    return { line, geo, mat, comet };
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
      comet.material.dispose();
    },
    [geo, mat, comet],
  );

  useFrame((state) => {
    if (!built) return;
    const t = (state.clock.elapsedTime * 0.07) % 1;
    const gp = built.gCurve.getPoint(t);
    const sp = built.sCurve.getPoint(t);
    comet.position.lerpVectors(gp, sp, uMorph.value);
    comet.scale.setScalar(2.0 + 0.3 * Math.sin(state.clock.elapsedTime * 4));
    comet.material.opacity = 0.85 * boost;
  });

  if (!built) return null;
  return (
    <group>
      <primitive object={line} />
      <primitive object={comet} />
      {built.waypoints.map((w) => (
        <Waypoint
          key={w.paperIdx}
          paperIdx={w.paperIdx}
          g={w.g}
          s={w.s}
          title={corpus.papers[w.paperIdx].title}
          year={corpus.papers[w.paperIdx].year}
        />
      ))}
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
