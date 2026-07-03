import type { Constellations, Entity, KgEdge } from "@/lib/atlas/types";
import { ENTRANCE_ID, type Corridor, type Dungeon, type Floor, type Room } from "./types";

/**
 * Procedural dungeon generation from the knowledge graph.
 *
 * Deterministic per seed: substantive entities become rooms, real KG relations
 * become corridors, and the highest-degree concepts/theories become the floor
 * bosses (ordered weakest → strongest, so the final floor is the corpus's most
 * connected idea). Layout is a BFS-layered crawl from a synthetic entrance to
 * the boss chamber at the far end.
 */

export const N_FLOORS = 5;
const MAX_ROOMS = 11;
const MIN_ROOMS = 6;
/** fraction of a floor's rooms that must be explored to unseal the boss gate */
const UNSEAL_FRACTION = 0.6;

/* ── seeded RNG ─────────────────────────────────────────────────────────── */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/* ── entity curation ────────────────────────────────────────────────────── */

// The KG extractor tags paper furniture as entities ("Table 2", "Experiment 1",
// "Corollary 4.3"…). None of that makes a room worth entering.
const JUNK_NAME =
  /^(table|figure|fig|experiment|exp|study|studies|session|appendix|corollary|theorem|lemma|proposition|equation|eq|section|chapter|page|block|trial|phase|step|item|list|box|panel|note|model|models|method|methods|task|tasks|participants?|subjects?|results?|discussion|introduction|abstract|conclusion|analysis|analyses|data|stimuli|stimulus|procedure|materials?|measures?|general discussion|current study|present study|pilot( study)?|(study|test|encoding|retrieval|learning|practice) phase|the (authors?|study|model|task)|authors?|paper|article|researchers?|reference|references)\s*\.?\s*\d*([.\-]\d+)*[a-z]?$/i;

const ROOM_TYPES = new Set([
  "concept", "method", "theory", "dataset", "finding", "result",
  "model", "brainregion", "reliability", "other",
]);
const BOSS_TYPES = new Set(["concept", "theory"]);

function isSubstantive(e: Entity): boolean {
  const name = e.id.trim();
  if (name.length < 3) return false;
  if (/^\d+([.\-]\d+)*$/.test(name)) return false;
  if (JUNK_NAME.test(name)) return false;
  return ROOM_TYPES.has(e.type);
}

/** Keep one entity per lowercase name (the KG holds near-duplicates), highest degree wins. */
function dedupe(entities: Entity[]): Entity[] {
  const byName = new Map<string, Entity>();
  for (const e of entities) {
    const k = e.id.trim().toLowerCase();
    const prev = byName.get(k);
    if (!prev || e.deg > prev.deg) byName.set(k, e);
  }
  return [...byName.values()];
}

/* ── generation ─────────────────────────────────────────────────────────── */

export function generateDungeon(data: Constellations, seed: number): Dungeon {
  const rng = mulberry32(seed);
  const pool = dedupe(data.entities.filter(isSubstantive));

  // Edge lookup over the curated pool, both directions.
  const poolIds = new Set(pool.map((e) => e.id));
  const edgesOf = new Map<string, KgEdge[]>();
  for (const edge of data.edges) {
    if (!poolIds.has(edge.s) || !poolIds.has(edge.t)) continue;
    for (const end of [edge.s, edge.t]) {
      const list = edgesOf.get(end) ?? [];
      list.push(edge);
      edgesOf.set(end, list);
    }
  }

  // Bosses: top concepts/theories by degree, one seeded pick per rank band so
  // every run climbs from a mid-tier idea to the corpus's best-connected one.
  const candidates = pool
    .filter((e) => BOSS_TYPES.has(e.type) && (edgesOf.get(e.id)?.length ?? 0) >= 3)
    .sort((a, b) => a.deg - b.deg);
  const bosses: Entity[] = [];
  const bandSize = Math.max(1, Math.floor(candidates.length / N_FLOORS));
  for (let f = 0; f < N_FLOORS && candidates.length > 0; f++) {
    const start = Math.min(f * bandSize, candidates.length - 1);
    const band = candidates.slice(start, f === N_FLOORS - 1 ? undefined : start + bandSize);
    let choice = pick(rng, band);
    while (bosses.includes(choice) && band.length > bosses.filter((b) => band.includes(b)).length) {
      choice = pick(rng, band);
    }
    if (!bosses.includes(choice)) bosses.push(choice);
  }

  const usedRooms = new Set<string>(bosses.map((b) => b.id));
  const byId = new Map(pool.map((e) => [e.id, e]));
  const floors = bosses.map((boss, i) =>
    buildFloor(boss, i, rng, edgesOf, byId, usedRooms),
  );
  return { seed, floors };
}

function buildFloor(
  boss: Entity,
  index: number,
  rng: () => number,
  edgesOf: Map<string, KgEdge[]>,
  byId: Map<string, Entity>,
  usedRooms: Set<string>,
): Floor {
  // Rooms: the boss's strongest KG neighbors not already used on another floor.
  const bossEdges = [...(edgesOf.get(boss.id) ?? [])].sort((a, b) => b.w - a.w);
  const roomEntities: Entity[] = [];
  for (const edge of bossEdges) {
    const otherId = edge.s === boss.id ? edge.t : edge.s;
    const other = byId.get(otherId);
    if (!other || usedRooms.has(otherId)) continue;
    if (roomEntities.some((r) => r.id === otherId)) continue;
    roomEntities.push(other);
    if (roomEntities.length >= MAX_ROOMS) break;
  }
  // Thin neighborhoods get backfilled from the wider pool (uncharted wings).
  if (roomEntities.length < MIN_ROOMS) {
    const fillers = [...byId.values()]
      .filter((e) => !usedRooms.has(e.id) && !roomEntities.some((r) => r.id === e.id) && e.id !== boss.id)
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 30);
    while (roomEntities.length < MIN_ROOMS && fillers.length > 0) {
      const idx = Math.floor(rng() * fillers.length);
      roomEntities.push(fillers.splice(idx, 1)[0]);
    }
  }
  for (const r of roomEntities) usedRooms.add(r.id);

  const roomIds = new Set(roomEntities.map((r) => r.id));
  const corridors: Corridor[] = [];
  const seen = new Set<string>();
  const addCorridor = (a: string, b: string, desc: string, kw: string, bossGate = false) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    corridors.push({ a, b, desc, kw, bossGate });
  };

  // Room↔room relations that exist in the KG.
  for (const id of roomIds) {
    for (const edge of edgesOf.get(id) ?? []) {
      const other = edge.s === id ? edge.t : edge.s;
      if (roomIds.has(other)) addCorridor(id, other, edge.desc, edge.kw);
    }
  }
  // Boss gates: only the two strongest relations lead into the boss chamber,
  // so the crawl doesn't collapse into a star around the boss.
  let gates = 0;
  for (const edge of bossEdges) {
    const other = edge.s === boss.id ? edge.t : edge.s;
    if (!roomIds.has(other)) continue;
    addCorridor(boss.id, other, edge.desc, edge.kw, true);
    if (++gates >= 2) break;
  }
  if (gates === 0 && roomEntities.length > 0) {
    addCorridor(boss.id, pick(rng, roomEntities).id, "A sealed passage into the boss chamber.", "", true);
  }

  // Entrance connects to the two least-connected rooms (the periphery of the idea).
  const byLocalDeg = [...roomEntities].sort(
    (a, b) => corridors.filter((c) => c.a === a.id || c.b === a.id).length -
      corridors.filter((c) => c.a === b.id || c.b === b.id).length,
  );
  for (const r of byLocalDeg.slice(0, Math.min(2, byLocalDeg.length))) {
    addCorridor(ENTRANCE_ID, r.id, "The stairwell opens into the literature.", "");
  }

  // Guarantee connectivity: attach any unreachable room via a collapsed passage.
  const adj = buildAdj(corridors);
  const reachable = bfs(ENTRANCE_ID, adj);
  for (const r of roomEntities) {
    if (reachable.has(r.id)) continue;
    const anchors = roomEntities.filter((o) => reachable.has(o.id));
    const anchor = anchors.length > 0 ? pick(rng, anchors).id : ENTRANCE_ID;
    addCorridor(r.id, anchor, "A collapsed passage, shored up by the groundskeepers.", "");
    for (const now of bfs(r.id, buildAdj(corridors))) reachable.add(now);
  }

  const finalAdj = buildAdj(corridors);
  const rooms = layoutRooms(boss, roomEntities, finalAdj, rng);
  return {
    index,
    bossId: boss.id,
    rooms,
    corridors,
    adj: finalAdj,
    roomsToUnseal: Math.ceil(roomEntities.length * UNSEAL_FRACTION),
  };
}

function buildAdj(corridors: Corridor[]): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const c of corridors) {
    (adj[c.a] ??= []).push(c.b);
    (adj[c.b] ??= []).push(c.a);
  }
  return adj;
}

function bfs(start: string, adj: Record<string, string[]>): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj[cur] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** BFS-layered layout: entrance on the left, boss chamber on the far right. */
function layoutRooms(
  boss: Entity,
  roomEntities: Entity[],
  adj: Record<string, string[]>,
  rng: () => number,
): Room[] {
  const depth = new Map<string, number>([[ENTRANCE_ID, 0]]);
  const queue = [ENTRANCE_ID];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj[cur] ?? []) {
      if (!depth.has(next)) {
        depth.set(next, depth.get(cur)! + 1);
        queue.push(next);
      }
    }
  }
  const roomDepths = roomEntities.map((r) => depth.get(r.id) ?? 1);
  const maxRoomDepth = Math.max(1, ...roomDepths);
  const bossDepth = maxRoomDepth + 1;

  const SPAN_X = 76;
  const xAt = (d: number) => -SPAN_X / 2 + (d / bossDepth) * SPAN_X;

  // Group rooms per depth column and spread them vertically with seeded jitter.
  const columns = new Map<number, Entity[]>();
  for (const r of roomEntities) {
    const d = Math.min(depth.get(r.id) ?? 1, maxRoomDepth);
    (columns.get(d) ?? columns.set(d, []).get(d)!).push(r);
  }

  const rooms: Room[] = [
    {
      id: ENTRANCE_ID,
      entity: null,
      pos: [xAt(0), 0],
      depth: 0,
      isBoss: false,
      isEntrance: true,
      grantsInsight: false,
    },
  ];
  for (const [d, group] of columns) {
    const shuffled = [...group].sort(() => rng() - 0.5);
    const spread = Math.max(14, shuffled.length * 11);
    shuffled.forEach((e, i) => {
      const t = shuffled.length === 1 ? 0.5 : i / (shuffled.length - 1);
      rooms.push({
        id: e.id,
        entity: e,
        pos: [xAt(d) + (rng() - 0.5) * 5, (t - 0.5) * spread + (rng() - 0.5) * 4],
        depth: d,
        isBoss: false,
        isEntrance: false,
        grantsInsight: rng() < 0.4,
      });
    });
  }
  rooms.push({
    id: boss.id,
    entity: boss,
    pos: [xAt(bossDepth) + 4, 0],
    depth: bossDepth,
    isBoss: true,
    isEntrance: false,
    grantsInsight: false,
  });
  return rooms;
}
