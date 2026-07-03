import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChunkText } from "./types";

/** Server-side chunk-text lookup, loaded once per process from server-data/. */
let table: Record<string, ChunkText> | null = null;

export function chunkTextTable(): Record<string, ChunkText> {
  table ??= JSON.parse(
    readFileSync(join(process.cwd(), "server-data", "chunk_text.json"), "utf-8"),
  );
  return table!;
}
