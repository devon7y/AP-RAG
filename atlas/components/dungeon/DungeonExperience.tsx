"use client";

import { useMemo, useReducer, useState } from "react";
import { LoadingVeil, useConstellations } from "@/lib/useCorpus";
import BossFight from "./BossFight";
import DungeonScene from "./DungeonScene";
import { generateDungeon } from "./generate";
import { NoticeToast, RunOverlay, RunStats } from "./Hud";
import RoomCodex from "./RoomCodex";
import { bossUnsealed, gameReducer, initialState } from "./state";
import type { Dungeon } from "./types";

function Run({ dungeon, onNewRun }: { dungeon: Dungeon; onNewRun: () => void }) {
  const [state, dispatch] = useReducer(gameReducer, undefined, initialState);
  const floor = dungeon.floors[Math.min(state.floorIdx, dungeon.floors.length - 1)];
  const visited = useMemo(() => new Set(state.visited), [state.visited]);
  const unsealed = bossUnsealed(state, floor);
  const currentRoom =
    floor.rooms.find((r) => r.id === state.currentRoom) ?? floor.rooms[0];
  const bossRoom = floor.rooms.find((r) => r.isBoss)!;

  return (
    <>
      <DungeonScene
        floor={floor}
        currentId={currentRoom.id}
        visited={visited}
        bossUnsealed={unsealed}
        onRoomClick={(id) => dispatch({ type: "MOVE", roomId: id, floor })}
      />

      <RunStats state={state} floor={floor} nFloors={dungeon.floors.length} />

      {state.phase === "explore" && (
        <RoomCodex room={currentRoom} floor={floor} visited={visited} />
      )}

      {state.phase === "boss" && (
        <BossFight
          boss={bossRoom}
          bossHp={state.bossHp}
          bossMax={state.bossMax}
          insight={state.insight}
          onVerdict={(claim, verdict) => dispatch({ type: "RESOLVE_ROUND", claim, verdict })}
          onSpendInsight={() => dispatch({ type: "SPEND_INSIGHT" })}
          onRetreat={() => dispatch({ type: "RETREAT", floor })}
        />
      )}

      <NoticeToast notice={state.notice} onDismiss={() => dispatch({ type: "DISMISS_NOTICE" })} />
      <RunOverlay
        state={state}
        floor={floor}
        nFloors={dungeon.floors.length}
        onDescend={() => dispatch({ type: "DESCEND", dungeon })}
        onNewRun={onNewRun}
      />
    </>
  );
}

export default function DungeonExperience() {
  const constellations = useConstellations();
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  const dungeon = useMemo(
    () => (constellations ? generateDungeon(constellations, seed) : null),
    [constellations, seed],
  );

  return (
    <div className="absolute inset-0">
      {!dungeon && <LoadingVeil label="excavating the dungeon…" />}
      {dungeon && dungeon.floors.length === 0 && (
        <div className="absolute inset-0 z-30 flex items-center justify-center text-ink-3">
          The knowledge graph yielded no bosses — the dungeon could not be generated.
        </div>
      )}
      {dungeon && dungeon.floors.length > 0 && (
        <Run
          key={seed}
          dungeon={dungeon}
          onNewRun={() => setSeed(Math.floor(Math.random() * 0xffffffff))}
        />
      )}
      {dungeon && (
        <span className="pointer-events-none absolute bottom-4 left-5 z-40 text-[11px] tabular-nums text-ink-3">
          dungeon seed {seed}
        </span>
      )}
    </div>
  );
}
