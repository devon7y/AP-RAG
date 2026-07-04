"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { loadAuthors, loadPaperMeta, WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import type { AuthorRec, GhostPaper, PaperMeta } from "@/lib/atlas/types";
import { LoadingVeil, useConstellations, useCorpus, useKnn } from "@/lib/atlas/useCorpus";
import ArcLayer from "./ArcLayer";
import CameraRig, { useIntroWarp } from "./CameraRig";
import ChunkCloud from "./ChunkCloud";
import CommandBar from "./CommandBar";
import { deriveWorld, type WorldData } from "./derive";
import GhostLayer, { useGhostSites } from "./GhostLayer";
import InspectorPanel from "./InspectorPanel";
import Labels from "./Labels";
import LeftPane from "./LeftPane";
import PaperBeacons from "./PaperBeacons";
import RoverLayer, { useRover } from "./RoverLayer";
import SkyLayer from "./SkyLayer";
import { useWorld, type PlantedGhost } from "./store";
import Terrain from "./Terrain";
import TrailsLayer from "./TrailsLayer";
import { uMorph } from "./uniforms";
import WorldDriver from "./WorldDriver";
import WorldPicker from "./WorldPicker";

/**
 * Papers Atlas — one world over the whole corpus. A landscape grown from the
 * embedding density that unfolds into the embedding cube; the knowledge graph
 * hangs above it as constellations; every instrument (time machine, lenses,
 * interpolation, ghosts, radio, the daily game) is a layer over the same scene.
 */

/* ---------------- extra data hooks ---------------- */

function useAuthors(): AuthorRec[] | null {
  const [a, setA] = useState<AuthorRec[] | null>(null);
  useEffect(() => {
    loadAuthors().then(setA, () => setA([]));
  }, []);
  return a;
}

function usePaperMeta(): PaperMeta | null {
  const [m, setM] = useState<PaperMeta | null>(null);
  useEffect(() => {
    loadPaperMeta().then(setM, () => setM(null));
  }, []);
  return m;
}

/* ---------------- atmosphere ---------------- */

function Atmosphere() {
  const scene = useThree((s) => s.scene);
  const grid = useRef<THREE.GridHelper>(null);
  useEffect(() => {
    scene.fog = new THREE.Fog(0x06070c, 120, 420);
    return () => {
      scene.fog = null;
    };
  }, [scene]);
  useFrame(() => {
    const m = uMorph.value;
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = THREE.MathUtils.lerp(110, 400, m);
      fog.far = THREE.MathUtils.lerp(420, 1100, m);
    }
    if (grid.current) {
      const mat = grid.current.material as THREE.Material & { opacity: number };
      mat.opacity = 0.38 * (1 - m);
      grid.current.visible = m < 0.97;
    }
  });
  return (
    <gridHelper
      ref={grid}
      args={[WORLD_SIZE + 44, 26, 0x2c2c2a, 0x191920]}
      position={[0, -0.06, 0]}
      material-transparent={true}
      material-depthWrite={false}
    />
  );
}

/** Distant 1px dust for parallax depth (deterministic mulberry scatter). */
function DustShell() {
  const geom = useMemo(() => {
    let s = 42;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 1700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = 300 + rand() * 200;
      const s2 = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s2 * Math.cos(th);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s2 * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  return (
    <points geometry={geom} frustumCulled={false}>
      <pointsMaterial
        color="#565e7d"
        size={1.4}
        sizeAttenuation={false}
        transparent
        opacity={0.5}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ---------------- ghost planting ---------------- */

function ghostStorageKey(n: number): string {
  return `atlas-world:ghosts:v1:${n}`;
}

function useGhostPlanting(data: WorldData | null, corpusReady: boolean) {
  const addGhost = useWorld((s) => s.addGhost);
  const updateGhost = useWorld((s) => s.updateGhost);
  const ghosts = useWorld((s) => s.ghosts);
  const loaded = useRef(false);

  // restore the graveyard
  useEffect(() => {
    if (!data || loaded.current) return;
    loaded.current = true;
    try {
      const raw = window.localStorage.getItem(ghostStorageKey(data.n));
      if (raw) {
        for (const g of JSON.parse(raw) as PlantedGhost[]) {
          if (g.ghost) addGhost(g);
        }
      }
    } catch {
      /* fresh graveyard */
    }
  }, [data, addGhost]);

  // persist finished ghosts
  useEffect(() => {
    if (!data || !loaded.current) return;
    try {
      window.localStorage.setItem(
        ghostStorageKey(data.n),
        JSON.stringify(ghosts.filter((g) => g.ghost)),
      );
    } catch {
      /* storage full — the séance continues unsaved */
    }
  }, [ghosts, data]);

  const corpus = useCorpus().corpus;
  useEffect(() => {
    if (!data || !corpus || !corpusReady) return;
    const onPlant = async (e: Event) => {
      const { x01, y01 } = (e as CustomEvent<{ x01: number; y01: number }>).detail;
      const st = useWorld.getState();

      // neighborhood context: nearest paper titles + nearest region terms
      const byDist = corpus.papers
        .map((p, i) => ({
          i,
          d: Math.hypot(p.centroid[0] - x01, p.centroid[1] - y01),
        }))
        .sort((a, b) => a.d - b.d);
      const neighbors: string[] = [];
      for (const { i } of byDist) {
        const t = corpus.papers[i].title;
        if (t && !neighbors.includes(t)) neighbors.push(t);
        if (neighbors.length >= 8) break;
      }
      const nearClusters = [...corpus.clusters]
        .sort(
          (a, b) =>
            Math.hypot(a.center[0] - x01, a.center[1] - y01) -
            Math.hypot(b.center[0] - x01, b.center[1] - y01),
        )
        .slice(0, 2);
      const terms = nearClusters.flatMap((c) => c.terms.slice(0, 6)).slice(0, 12);

      const id = `ghost:${Date.now()}`;
      st.addGhost({ id, x01, y01, ghost: null, neighbors, echo: null });
      st.select({ kind: "ghost", id });
      st.setInstrument("ghosts");

      try {
        const r = await fetch("/api/atlas/ghost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ neighbors, terms }),
        });
        const body = (await r.json()) as {
          ghost?: GhostPaper;
          hits?: { chunkId: string; score: number }[];
          error?: string;
        };
        if (!r.ok || !body.ghost) throw new Error(body.error ?? `ghost: ${r.status}`);
        const echo = (body.hits ?? [])
          .map((h) => ({ idx: data.chunkIdToIdx.get(h.chunkId) ?? -1, score: h.score }))
          .filter((h) => h.idx >= 0)
          .slice(0, 8);
        updateGhost(id, { ghost: body.ghost, echo });
      } catch (err) {
        updateGhost(id, { error: String(err) });
      }
    };
    window.addEventListener("world:plant-ghost", onPlant);
    return () => window.removeEventListener("world:plant-ghost", onPlant);
  }, [data, corpus, corpusReady, updateGhost]);
}

/* ---------------- the scene ---------------- */

function World({
  data,
  authors,
  paperMeta,
}: {
  data: WorldData;
  authors: AuthorRec[];
  paperMeta: PaperMeta | null;
}) {
  const { corpus } = useCorpus();
  const constellations = useConstellations();
  const knn = useKnn();
  const lens = useWorld((s) => s.lens);
  const canvasMode = useAtlasStore((s) => s.canvasMode);

  useRover(corpus, knn);
  useGhostPlanting(data, corpus !== null);
  useIntroWarp(true);

  // seed the time machine bounds once
  useEffect(() => {
    const st = useWorld.getState();
    st.set("yearMin", data.yearMin);
    st.set("yearMax", data.yearMax);
    st.set("year", data.yearMax + 1);
  }, [data]);

  // metadata lens → dim masks + the gold oeuvre
  const masks = useMemo(() => {
    if (!corpus) return { chunks: null, papers: null, gold: null };
    const { author, journal, keyword } = lens;
    if (author === null && !journal && !keyword)
      return { chunks: null, papers: null, gold: null };

    const authorSet = author !== null ? new Set(authors[author]?.papers ?? []) : null;
    const j = journal?.toLowerCase() ?? null;
    const k = keyword?.toLowerCase() ?? null;

    const paperPass = corpus.papers.map((p, i) => {
      if (authorSet && !authorSet.has(i)) return false;
      if (j && !p.journal.toLowerCase().includes(j)) return false;
      if (k) {
        const hay = [
          p.title,
          p.abstract,
          ...(paperMeta?.keywords[i] ?? []),
          ...(paperMeta?.subjects[i] ?? []),
        ]
          .join(" | ")
          .toLowerCase();
        if (!hay.includes(k)) return false;
      }
      return true;
    });

    const papers = new Float32Array(corpus.papers.length);
    const gold = new Float32Array(corpus.papers.length);
    paperPass.forEach((pass, i) => {
      papers[i] = pass ? 0 : 1;
      if (authorSet?.has(i) && pass) gold[i] = 1;
    });
    const chunks = new Float32Array(data.n);
    for (let i = 0; i < data.n; i++) {
      chunks[i] = paperPass[corpus.atlas.paper[i]] ? 0 : 1;
    }
    return { chunks, papers, gold: authorSet ? gold : null };
  }, [corpus, authors, paperMeta, lens, data]);

  const roverPosRef = useMemo<{ current: THREE.Vector3 | null }>(
    () => ({ current: null }),
    [],
  );
  const ghostSites = useGhostSites(data, corpus);

  if (!corpus || !constellations) return null;

  return (
    <div className="absolute inset-0">
      <HDRCanvas
        camera={{ position: [0, 190, 260], fov: 55, near: 0.1, far: 1400 }}
        clearColor={0x06070c}
      >
        <WorldDriver data={data} />
        <Atmosphere />
        <DustShell />
        <Terrain data={data} />
        <ChunkCloud data={data} lensMask={masks.chunks} />
        <PaperBeacons data={data} lensMask={masks.papers} goldMask={masks.gold} />
        <SkyLayer data={data} corpus={corpus} />
        <GhostLayer data={data} corpus={corpus} sites={ghostSites} />
        <ArcLayer data={data} />
        <RoverLayer data={data} roverPosRef={roverPosRef} />
        <TrailsLayer data={data} corpus={corpus} authors={authors} />
        <Labels data={data} corpus={corpus} />
        <WorldPicker data={data} ghostSites={ghostSites} />
        <CameraRig getRoverPos={() => roverPosRef.current} />
      </HDRCanvas>

      {/* chrome */}
      <header className="pointer-events-none absolute top-0 left-0 z-40 flex items-center gap-4 p-5">
        <Link
          href="/"
          className="hud-panel pointer-events-auto px-3 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink"
        >
          ← Chat
        </Link>
        <div className="flex items-baseline gap-3">
          <h1 className="font-display edr-glow text-2xl">Papers Atlas</h1>
          <span className="rounded-full border border-[#3987e5] px-2 py-0.5 text-[10px] tracking-widest text-[#3987e5] uppercase">
            {corpus.papers.length.toLocaleString()} papers ·{" "}
            {data.n.toLocaleString()} passages
          </span>
          {canvasMode === "webgpu-hdr" && (
            <span className="rounded-full border border-[#ffd27a]/60 px-2 py-0.5 text-[10px] tracking-widest text-[#ffd27a] uppercase">
              hdr
            </span>
          )}
        </div>
      </header>

      <LeftPane data={data} corpus={corpus} authors={authors} paperMeta={paperMeta} />
      <CommandBar data={data} corpus={corpus} authors={authors} />
      <InspectorPanel
        data={data}
        corpus={corpus}
        authors={authors}
        paperMeta={paperMeta}
        constellations={constellations}
      />

      <p className="pointer-events-none absolute right-5 bottom-4 z-40 hidden text-[11px] text-ink-3 sm:block">
        drag to orbit · scroll to zoom · click to inspect · double-click to fly ·{" "}
        <kbd className="rounded border border-white/15 px-1">/</kbd> to command
      </p>
    </div>
  );
}

export default function WorldSceneRoot() {
  const { corpus, error } = useCorpus();
  const constellations = useConstellations();
  const authors = useAuthors();
  const paperMeta = usePaperMeta();

  const data = useMemo(
    () => (corpus && constellations ? deriveWorld(corpus, constellations) : null),
    [corpus, constellations],
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-page">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!error && !data && <LoadingVeil label="growing the world…" />}
      {data && authors && (
        <World data={data} authors={authors} paperMeta={paperMeta} />
      )}
    </div>
  );
}
