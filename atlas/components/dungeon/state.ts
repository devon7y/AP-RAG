import { bossMaxHp, damageFor, PLAYER_MAX_HP } from "./judge";
import { ENTRANCE_ID, type Dungeon, type Floor, type Verdict } from "./types";

/**
 * The run: pure reducer over explore/fight phases. Async work (retrieval, the
 * LLM judge) lives in the components; only resolved outcomes reach the reducer.
 */

export type Phase = "explore" | "boss" | "floor-cleared" | "victory" | "defeat";

export interface RoundLog {
  claim: string;
  verdict: Verdict;
  toBoss: number;
  toPlayer: number;
}

export interface GameState {
  floorIdx: number;
  phase: Phase;
  hp: number;
  insight: number;
  currentRoom: string;
  visited: string[];
  bossHp: number;
  bossMax: number;
  rounds: RoundLog[];
  /** transient banner text (insight pickups, sealed-door bumps) */
  notice: string | null;
}

export type GameAction =
  | { type: "MOVE"; roomId: string; floor: Floor }
  | { type: "ENTER_BOSS" }
  | { type: "RETREAT"; floor: Floor }
  | { type: "RESOLVE_ROUND"; claim: string; verdict: Verdict }
  | { type: "SPEND_INSIGHT" }
  | { type: "DESCEND"; dungeon: Dungeon }
  | { type: "DISMISS_NOTICE" };

const FLOOR_HEAL = 35;

export function initialState(): GameState {
  return {
    floorIdx: 0,
    phase: "explore",
    hp: PLAYER_MAX_HP,
    insight: 1,
    currentRoom: ENTRANCE_ID,
    visited: [ENTRANCE_ID],
    bossHp: bossMaxHp(0),
    bossMax: bossMaxHp(0),
    rounds: [],
    notice: null,
  };
}

export function exploredCount(state: GameState, floor: Floor): number {
  return state.visited.filter((id) => {
    const room = floor.rooms.find((r) => r.id === id);
    return room && !room.isEntrance && !room.isBoss;
  }).length;
}

export function bossUnsealed(state: GameState, floor: Floor): boolean {
  return exploredCount(state, floor) >= floor.roomsToUnseal;
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "MOVE": {
      const { roomId, floor } = action;
      if (state.phase !== "explore") return state;
      if (!(floor.adj[state.currentRoom] ?? []).includes(roomId)) return state;
      const room = floor.rooms.find((r) => r.id === roomId);
      if (!room) return state;
      if (room.isBoss) {
        if (!bossUnsealed(state, floor)) {
          return {
            ...state,
            notice: `The boss gate is sealed — chart ${floor.roomsToUnseal - exploredCount(state, floor)} more chamber(s) first.`,
          };
        }
        return { ...state, currentRoom: roomId, phase: "boss", notice: null };
      }
      const firstVisit = !state.visited.includes(roomId);
      const gained = firstVisit && room.grantsInsight ? 1 : 0;
      return {
        ...state,
        currentRoom: roomId,
        visited: firstVisit ? [...state.visited, roomId] : state.visited,
        insight: state.insight + gained,
        notice: gained ? "You found an Insight — spend it mid-fight to consult the stacks." : null,
      };
    }

    case "ENTER_BOSS":
      return state.phase === "explore" ? { ...state, phase: "boss", notice: null } : state;

    case "RETREAT": {
      if (state.phase !== "boss") return state;
      // Step back through the gate (so the boss room is clickable again);
      // the panel is patient: the boss keeps its wounds, you keep yours.
      const gateRoom =
        (action.floor.adj[state.currentRoom] ?? []).find((id) => state.visited.includes(id)) ??
        (action.floor.adj[state.currentRoom] ?? [])[0] ??
        state.currentRoom;
      return {
        ...state,
        phase: "explore",
        currentRoom: gateRoom,
        notice: "You withdraw to gather more evidence.",
      };
    }

    case "RESOLVE_ROUND": {
      if (state.phase !== "boss") return state;
      const { toBoss, toPlayer } = damageFor(action.verdict);
      const bossHp = Math.max(0, state.bossHp - toBoss);
      const hp = Math.max(0, state.hp - toPlayer);
      const round: RoundLog = { claim: action.claim, verdict: action.verdict, toBoss, toPlayer };
      const rounds = [...state.rounds, round];
      if (hp <= 0) return { ...state, hp, bossHp, rounds, phase: "defeat" };
      if (bossHp <= 0) return { ...state, hp, bossHp, rounds, phase: "floor-cleared" };
      return { ...state, hp, bossHp, rounds };
    }

    case "SPEND_INSIGHT":
      return state.insight > 0 ? { ...state, insight: state.insight - 1 } : state;

    case "DESCEND": {
      if (state.phase !== "floor-cleared") return state;
      const next = state.floorIdx + 1;
      if (next >= action.dungeon.floors.length) return { ...state, phase: "victory" };
      return {
        ...state,
        floorIdx: next,
        phase: "explore",
        hp: Math.min(PLAYER_MAX_HP, state.hp + FLOOR_HEAL),
        insight: state.insight + 1,
        currentRoom: ENTRANCE_ID,
        visited: [ENTRANCE_ID],
        bossHp: bossMaxHp(next),
        bossMax: bossMaxHp(next),
        rounds: [],
        notice: `Floor ${next + 1}. The literature deepens. (+${FLOOR_HEAL} credibility)`,
      };
    }

    case "DISMISS_NOTICE":
      return state.notice ? { ...state, notice: null } : state;

    default:
      return state;
  }
}
