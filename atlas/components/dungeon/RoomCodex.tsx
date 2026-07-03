"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ENTRANCE_ID, type Floor, type Room } from "./types";

/** Truncate at a word boundary so the codex never cuts mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
}

const TYPE_LABEL: Record<string, string> = {
  concept: "Concept",
  method: "Method",
  theory: "Theory",
  dataset: "Dataset",
  finding: "Finding",
  result: "Result",
  model: "Model",
  brainregion: "Brain region",
};

/**
 * The codex: what the knowledge graph actually says about the room you're in,
 * plus the relations (corridors) leading out — the lore is real, and it's the
 * ammunition for boss claims.
 */
export default function RoomCodex({
  room,
  floor,
  visited,
}: {
  room: Room;
  floor: Floor;
  visited: Set<string>;
}) {
  const corridors = floor.corridors.filter((c) => c.a === room.id || c.b === room.id);
  const nameOf = (id: string) =>
    id === ENTRANCE_ID ? "Stairwell" : floor.rooms.find((r) => r.id === id)?.entity?.id ?? id;

  return (
    <AnimatePresence mode="wait">
      <motion.aside
        key={room.id}
        initial={{ opacity: 0, x: 36 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 36 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
        className="hud-panel hud-scroll pointer-events-auto absolute top-56 right-5 z-40 max-h-[52vh] w-[340px] overflow-y-auto p-5"
      >
        {room.isEntrance ? (
          <>
            <h2 className="font-display text-xl">Stairwell</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">
              A floor of the literature, generated from the knowledge graph. Chambers are
              real entities; corridors are the relations the corpus itself asserts. Chart
              enough chambers to unseal the boss gate — then argue.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span
                className="rounded-full border border-hairline px-2 py-0.5 text-[10px] tracking-widest text-ink-3 uppercase"
              >
                {TYPE_LABEL[room.entity?.type ?? ""] ?? "Entity"}
              </span>
              {room.isBoss && (
                <span
                  className="rounded-full border px-2 py-0.5 text-[10px] tracking-widest uppercase"
                  style={{ borderColor: "#d95926", color: "#ffb38a" }}
                >
                  Boss
                </span>
              )}
            </div>
            <h2 className="font-display mt-2 text-xl leading-tight">{room.entity?.id}</h2>
            {room.entity?.desc && (
              <p className="mt-3 text-sm leading-relaxed text-ink-2">
                {clip(room.entity.desc, 480)}
              </p>
            )}
          </>
        )}

        {corridors.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-4">
            <p className="text-[11px] tracking-widest text-ink-3 uppercase">
              Corridors ({corridors.length})
            </p>
            <ul className="mt-2 space-y-2.5">
              {corridors.map((c, i) => {
                const otherId = c.a === room.id ? c.b : c.a;
                return (
                  <li key={i} className="text-xs leading-snug">
                    <span className={visited.has(otherId) ? "text-ink-2" : "text-ink-3"}>
                      → {nameOf(otherId)}
                      {c.bossGate && " · boss gate"}
                    </span>
                    {c.desc && (
                      <span className="mt-0.5 block text-ink-3">{clip(c.desc, 160)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </motion.aside>
    </AnimatePresence>
  );
}
