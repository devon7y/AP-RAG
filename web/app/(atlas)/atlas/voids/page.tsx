"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/atlas/ExperienceShell";

const VoidScene = dynamic(() => import("@/components/atlas/voids/VoidScene"), {
  ssr: false,
});

export default function VoidsPage() {
  return (
    <ExperienceShell
      title="Ghost Papers"
      tag="dark matter"
      accent="#9085e9"
      hint="drag to orbit · scroll to zoom · click a spire"
    >
      <VoidScene />
    </ExperienceShell>
  );
}
