"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/ExperienceShell";

const DungeonExperience = dynamic(
  () => import("@/components/dungeon/DungeonExperience"),
  { ssr: false },
);

export default function DungeonPage() {
  return (
    <ExperienceShell
      title="The Peer-Review Dungeon"
      tag="roguelike"
      accent="#d95926"
      hint="drag to orbit · click an adjacent chamber to move · unseal the gate, then argue"
    >
      <DungeonExperience />
    </ExperienceShell>
  );
}
