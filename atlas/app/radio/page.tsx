"use client";

import dynamic from "next/dynamic";
import ExperienceShell from "@/components/ExperienceShell";

const RadioScene = dynamic(() => import("@/components/radio/RadioScene"), {
  ssr: false,
});

export default function RadioPage() {
  return (
    <ExperienceShell title="Radio Westbury" tag="ambient" accent="#d55181">
      <RadioScene />
    </ExperienceShell>
  );
}
