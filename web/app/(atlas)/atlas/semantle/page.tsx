"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/atlas/ExperienceShell";

const SemantleExperience = dynamic(
  () => import("@/components/atlas/semantle/SemantleExperience"),
  { ssr: false },
);

export default function SemantlePage() {
  return (
    <ExperienceShell
      title="Semantle"
      tag="daily game"
      accent="#c98500"
      hint="guess what the hidden paper is about — hot pings huddle around it · name the paper to win"
    >
      <SemantleExperience />
    </ExperienceShell>
  );
}
