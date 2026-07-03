"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/atlas/ExperienceShell";

const SeanceScene = dynamic(() => import("@/components/atlas/seance/SeanceScene"), {
  ssr: false,
});

export default function SeancePage() {
  return (
    <ExperienceShell
      title="The Séance"
      tag="chat"
      accent="#008300"
      hint="drag to orbit · scroll to zoom · they speak only from what they wrote"
    >
      <SeanceScene />
    </ExperienceShell>
  );
}
