"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/ExperienceShell";

const InterpolateScene = dynamic(
  () => import("@/components/interpolate/InterpolateScene"),
  { ssr: false },
);

export default function InterpolatePage() {
  return (
    <ExperienceShell
      title="The Interpolation Engine"
      tag="instrument"
      accent="#e66767"
      hint="pick two ideas · trace the geodesic · drag the slider — every waypoint is a real passage"
    >
      <InterpolateScene />
    </ExperienceShell>
  );
}
