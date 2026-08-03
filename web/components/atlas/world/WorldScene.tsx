"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { loadAuthors, loadPaperMeta, WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import type {
  AuthorRec,
  CorpusData,
  GhostPaper,
  PaperMeta,
} from "@/lib/atlas/types";
import { LoadingVeil, useConstellations, useCorpus, useKnn } from "@/lib/atlas/useCorpus";
import ArcLayer from "./ArcLayer";
import CameraRig from "./CameraRig";
import ChunkCloud from "./ChunkCloud";
import CommandBar from "./CommandBar";
import { deriveWorld, shortCite, type WorldData } from "./derive";
import DraftLayer from "./DraftLayer";
import GhostLayer, { useGhostSites } from "./GhostLayer";
import InspectorPanel from "./InspectorPanel";
import Labels from "./Labels";
import LeftPane from "./LeftPane";
import PaperBeacons from "./PaperBeacons";
import PlaneHud from "./PlaneHud";
import PlaneLayer, { type PlanePose } from "./PlaneLayer";
import RoverLayer, { useRover } from "./RoverLayer";
import SkyLayer from "./SkyLayer";
import { OPENING_SHOT, useWorld, type PlantedGhost } from "./store";
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
    loadPaperMeta().then(setM, () =>
      // never block the world on a failed metadata fetch — derive falls back
      // to the atlas's integer years and hides the metadata affordances
      setM({
        keywords: [],
        subjects: [],
        affil: [],
        first: [],
        drive: [],
        frac: [],
        dateStr: [],
      }),
    );
  }, []);
  return m;
}

/* ---------------- mouse-following hover tooltip ---------------- */

function HoverTooltip({ corpus }: { corpus: CorpusData }) {
  const hovered = useWorld((s) => s.hovered);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.style.left = "-9999px";
    const onMove = (e: PointerEvent) => {
      // over DOM UI (panels, bars, cards) the scene hover is stale — clear it
      if (!(e.target instanceof HTMLCanvasElement)) {
        const st = useWorld.getState();
        if (st.hovered !== null) st.hover(null);
        return;
      }
      const el = ref.current;
      if (!el) return;
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY - 14}px`;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const show = hovered?.kind === "paper" || hovered?.kind === "chunk";
  let head = "";
  let body = "";
  let foot = "";
  if (hovered?.kind === "paper") {
    const p = corpus.papers[hovered.idx];
    head = "paper";
    body = p.title;
    foot = `${shortCite(p)} · ${p.nChunks} passages · click to inspect`;
  } else if (hovered?.kind === "chunk") {
    const p = corpus.papers[corpus.atlas.paper[hovered.idx]];
    head = "passage";
    body = p?.title ?? "Unknown paper";
    foot = `${shortCite(p)} · click to read`;
  }

  return (
    <div
      ref={ref}
      className={`pointer-events-none fixed z-40 -translate-x-1/2 -translate-y-full ${
        show ? "visible" : "invisible"
      }`}
    >
      {show && (
        <div className="hud-panel w-64 px-3 py-2">
          <p className="line-clamp-1 text-[10px] tracking-[0.25em] text-ink-3 uppercase">
            {head}
          </p>
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-ink">{body}</p>
          <p className="mt-1 text-[11px] text-ink-3">{foot}</p>
        </div>
      )}
    </div>
  );
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

/** Distant dust for parallax depth (deterministic mulberry scatter) — the
 *  background sky brightens further as the world lifts into the galaxy. */
function DustShell() {
  const mat = useRef<THREE.PointsMaterial>(null);
  const geom = useMemo(() => {
    let s = 42;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 2600;
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
  useFrame(() => {
    if (mat.current) {
      mat.current.opacity = 0.55 + 0.4 * uMorph.value;
      mat.current.size = 1.6 + 0.7 * uMorph.value;
    }
  });
  return (
    <points geometry={geom} frustumCulled={false}>
      <pointsMaterial
        ref={mat}
        color="#7d87ad"
        size={1.6}
        sizeAttenuation={false}
        transparent
        opacity={0.55}
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
      // show the panel without re-arming planting (setInstrument would)
      st.set("instrument", "ghosts");
      st.set("paneOpen", true);

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
  const instrument = useWorld((s) => s.instrument);
  const ask = useWorld((s) => s.ask);

  useRover(corpus, knn);
  useGhostPlanting(data, corpus !== null);

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

    // ask-the-atlas evidence: while its panel is open, the cited papers
    // pulse gold and everything else steps back (same optics as a lens)
    if (instrument === "ask" && ask?.status === "done") {
      const cited = new Set(
        ask.refs.map((r) => r.paperIdx).filter((i) => i >= 0),
      );
      if (cited.size > 0) {
        const papers = new Float32Array(corpus.papers.length);
        const gold = new Float32Array(corpus.papers.length);
        for (let i = 0; i < corpus.papers.length; i++) {
          papers[i] = cited.has(i) ? 0 : 1;
          gold[i] = cited.has(i) ? 1 : 0;
        }
        const chunks = new Float32Array(data.n);
        for (let i = 0; i < data.n; i++) {
          chunks[i] = cited.has(corpus.atlas.paper[i]) ? 0 : 1;
        }
        return { chunks, papers, gold };
      }
    }

    const { author, journal, keyword } = lens;
    if (author === null && !journal && !keyword)
      return { chunks: null, papers: null, gold: null };

    const authorSet = author !== null ? new Set(authors[author]?.papers ?? []) : null;
    const j = journal?.toLowerCase() ?? null;
    // "|" separates alternatives (used by the live "a -> b" expression glow)
    const terms = (keyword?.toLowerCase() ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);

    const paperPass = corpus.papers.map((p, i) => {
      if (authorSet && !authorSet.has(i)) return false;
      if (j && !p.journal.toLowerCase().includes(j)) return false;
      if (terms.length) {
        const hay = data.paperHaystack[i];
        if (!terms.some((t) => hay.includes(t))) return false;
      }
      return true;
    });

    const papers = new Float32Array(corpus.papers.length);
    const gold = new Float32Array(corpus.papers.length);
    paperPass.forEach((pass, i) => {
      papers[i] = pass ? 0 : 1;
      if (pass) gold[i] = 1; // every lens match pulses gold — the lens must READ
    });
    const chunks = new Float32Array(data.n);
    for (let i = 0; i < data.n; i++) {
      chunks[i] = paperPass[corpus.atlas.paper[i]] ? 0 : 1;
    }
    return { chunks, papers, gold };
  }, [corpus, authors, paperMeta, lens, data, instrument, ask]);

  const roverPosRef = useMemo<{ current: THREE.Vector3 | null }>(
    () => ({ current: null }),
    [],
  );
  const planePoseRef = useMemo<{ current: PlanePose | null }>(
    () => ({ current: null }),
    [],
  );
  const planeOn = useWorld((s) => s.planeOn);
  const planeStatus = useWorld((s) => s.planeStatus);
  const ghostSites = useGhostSites(data);

  if (!corpus || !constellations) return null;

  return (
    <div className="absolute inset-0">
      <HDRCanvas
        camera={{ position: OPENING_SHOT.position, fov: 55, near: 0.1, far: 1400 }}
        clearColor={0x06070c}
      >
        <WorldDriver data={data} />
        <Atmosphere />
        <DustShell />
        <Terrain data={data} />
        <ChunkCloud data={data} lensMask={masks.chunks} />
        <PaperBeacons data={data} lensMask={masks.papers} goldMask={masks.gold} />
        <SkyLayer data={data} corpus={corpus} />
        {instrument === "ghosts" && <GhostLayer data={data} sites={ghostSites} />}
        {instrument === "draft" && <DraftLayer data={data} />}
        <ArcLayer data={data} />
        <RoverLayer data={data} roverPosRef={roverPosRef} />
        <PlaneLayer data={data} poseRef={planePoseRef} />
        <TrailsLayer data={data} corpus={corpus} authors={authors} />
        <Labels data={data} />
        <WorldPicker
          data={data}
          ghostSites={instrument === "ghosts" ? ghostSites : []}
        />
        <CameraRig
          getRoverPos={() => roverPosRef.current}
          getPlanePose={() => planePoseRef.current}
        />
      </HDRCanvas>

      {/* chrome */}
      <header className="pointer-events-none absolute top-0 left-0 z-40 flex items-center gap-4 p-5">
        <Link
          href="/"
          className="hud-panel pointer-events-auto px-3 py-1.5 text-sm text-ink-2 transition-colors hover:text-ink"
        >
          ← Chat
        </Link>
        <h1 className="font-display text-2xl text-ink">Papers Atlas</h1>
      </header>

      <LeftPane data={data} corpus={corpus} authors={authors} paperMeta={paperMeta} />
      <CommandBar data={data} corpus={corpus} authors={authors} />
      <HoverTooltip corpus={corpus} />
      <InspectorPanel
        data={data}
        corpus={corpus}
        authors={authors}
        paperMeta={paperMeta}
        constellations={constellations}
      />

      {planeOn && planeStatus === "ready" && <PlaneHud corpus={corpus} />}

      {planeOn && planeStatus === "loading" && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="hud-panel flex items-center gap-3 px-5 py-3">
            <span className="jet-spinner" aria-hidden="true" />
            <span className="text-[11px] tracking-[0.25em] text-ink-2 uppercase">
              loading aircraft…
            </span>
          </div>
        </div>
      )}

      {planeStatus === "error" && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="hud-panel px-5 py-3 text-[11px] tracking-[0.2em] text-[#ff6b6b] uppercase">
            aircraft failed to load
          </div>
        </div>
      )}

      {!planeOn && (
        <p className="pointer-events-none absolute right-5 bottom-4 z-40 hidden text-[11px] text-ink-3 sm:block">
          drag to orbit · ctrl+drag to pan · scroll to zoom · click to inspect ·
          double-click to fly
        </p>
      )}
    </div>
  );
}

/**
 * Next's `cachedNavigations` (next.config.ts) does NOT unmount this page when
 * you route away — it hides it with React Activity, which tears down effects
 * while keeping state and DOM alive, then re-runs them when you return.
 * react-three-fiber cannot survive that: on teardown it deactivates its root
 * and drops it from its internal `_roots` registry, and on the way back it
 * re-activates the root without re-registering it. Its render loop only ever
 * walks `_roots`, so the loop has nothing to render and never restarts —
 * neither invalidate() nor advance() nor setFrameloop() can revive it (all
 * verified against a live repro). You come back to a world that looks alive
 * but is frozen: no camera, no panning, no picking.
 *
 * So the canvas has to be rebuilt. State survives the hide, so a ref that is
 * already set on setup means this is a return rather than a first mount; that
 * bumps a key and remounts the scene, which builds a fresh renderer and a
 * fresh root. The corpus and the derived world are memoized above this, so
 * only the GPU-side objects are recreated.
 */
function useVisibleGeneration(): { hidden: boolean; generation: number } {
  const seen = useRef(false);
  const [state, setState] = useState({ hidden: false, generation: 0 });
  useEffect(() => {
    if (seen.current) {
      // returning: mount a brand-new scene (fresh renderer + fresh r3f root)
      setState((s) => ({ hidden: false, generation: s.generation + 1 }));
    }
    seen.current = true;
    // hiding: drop the scene entirely rather than leave a dead one to restore
    return () => setState((s) => ({ ...s, hidden: true }));
  }, []);
  return state;
}

export default function WorldSceneRoot() {
  const { hidden, generation } = useVisibleGeneration();
  const { corpus, error } = useCorpus();
  const constellations = useConstellations();
  const authors = useAuthors();
  const paperMeta = usePaperMeta();

  // Extended-tone-mapped canvases hand backdrop-filter a drastically darker
  // sample of the scene (measured ~5× dim in the blur lab); the CSS keys off
  // this stamp to add a brightness() term that restores the sampled glass.
  const canvasMode = useAtlasStore((s) => s.canvasMode);
  useEffect(() => {
    document.body.dataset.canvasMode = canvasMode;
    return () => {
      delete document.body.dataset.canvasMode;
    };
  }, [canvasMode]);


  // paperMeta carries the fractional publication dates the time machine runs
  // on, so the world derivation waits for it (it's a tiny file)
  const data = useMemo(
    () =>
      corpus && constellations && paperMeta
        ? deriveWorld(corpus, constellations, paperMeta)
        : null,
    [corpus, constellations, paperMeta],
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-page">
      {error && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          Failed to load corpus data: {error}
        </div>
      )}
      {!error && !data && <LoadingVeil label="Loading the Papers Atlas…" />}
      {data && authors && !hidden && (
        <World key={generation} data={data} authors={authors} paperMeta={paperMeta} />
      )}
    </div>
  );
}
