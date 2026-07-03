"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/atlas/ExperienceShell";

const ObservatoryScene = dynamic(
  () => import("@/components/atlas/observatory/ObservatoryScene"),
  { ssr: false },
);

export default function ObservatoryPage() {
  return (
    <ExperienceShell title="The Observatory" tag="starfield" accent="#9085e9">
      <ObservatoryScene />
    </ExperienceShell>
  );
}
