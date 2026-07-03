import type { Entity } from "@/lib/types";

/** A dungeon room — a knowledge-graph entity given walls. */
export interface Room {
  id: string;
  /** null only for the synthetic entrance stairwell */
  entity: Entity | null;
  /** world x,z on the floor plane */
  pos: [number, number];
  /** BFS depth from the entrance (drives the left→right layout) */
  depth: number;
  isBoss: boolean;
  isEntrance: boolean;
  /** first visit yields an Insight token (spent to consult the stacks mid-fight) */
  grantsInsight: boolean;
}

/** A corridor — a real KG relation between the two rooms (or a collapsed passage). */
export interface Corridor {
  a: string;
  b: string;
  /** relation description from the KG; lore the player can actually use in claims */
  desc: string;
  kw: string;
  /** boss gates stay sealed until enough of the floor is explored */
  bossGate: boolean;
}

export interface Floor {
  index: number;
  /** floor id: the boss entity name */
  bossId: string;
  rooms: Room[];
  corridors: Corridor[];
  /** roomId → adjacent roomIds (corridors are undirected) */
  adj: Record<string, string[]>;
  /** rooms (excluding entrance/boss) that must be explored to unseal the boss gate */
  roomsToUnseal: number;
}

export interface Dungeon {
  seed: number;
  floors: Floor[];
}

export const ENTRANCE_ID = "__entrance__";

/** One argued round of a boss fight. */
export interface Verdict {
  verdict: "SUPPORTED" | "PARTIAL" | "UNSUPPORTED" | "CONTRADICTED";
  score: number;
  ruling: string;
}

export interface EvidenceChunk {
  text: string;
  file: string;
  page: number | null;
  refId: string;
  apa: string | null;
}
