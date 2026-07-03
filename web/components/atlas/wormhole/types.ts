export interface PlayerMeta {
  name: string;
  /** trail / accent color for this player */
  color: string;
  /** keyboard keys mapped to the first 8 hop options */
  keys: string[];
}

export interface PlayerRun {
  /** chunk indices visited; [0] is the start chunk, last is current */
  path: number[];
  /** edge similarity per hop (path.length - 1 entries) */
  sims: number[];
  finished: boolean;
  gaveUp: boolean;
  /** finish time in ms since race start (finished players only) */
  ms: number | null;
}

export const PLAYERS: PlayerMeta[] = [
  { name: "Player 1", color: "#3987e5", keys: ["1", "2", "3", "4", "5", "6", "7", "8"] },
  { name: "Player 2", color: "#e66767", keys: ["q", "w", "e", "r", "t", "y", "u", "i"] },
];

export const WORMHOLE_ACCENT = "#199e70";
