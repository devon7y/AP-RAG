"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/atlas/ExperienceShell";

const WormholeExperience = dynamic(
  () => import("@/components/atlas/wormhole/WormholeExperience"),
  { ssr: false },
);

export default function WormholePage() {
  return (
    <ExperienceShell
      title="Wormhole"
      tag="race"
      accent="#199e70"
      hint="hop nearest neighbors · read your way across the field · fewest hops wins"
    >
      <WormholeExperience />
    </ExperienceShell>
  );
}
