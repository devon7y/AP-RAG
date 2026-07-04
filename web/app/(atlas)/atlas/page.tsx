"use client";

import dynamic from "next/dynamic";

/**
 * /atlas — Papers Atlas: the unified world. The chat sidebar drops the user
 * straight in here (no card hub); the standalone experiments live on at
 * /atlas/experiments, reachable from the instrument rail.
 */
const WorldScene = dynamic(() => import("@/components/atlas/world/WorldScene"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-page">
      <p className="pulse-soft font-display text-xl text-ink-2">growing the world…</p>
    </div>
  ),
});

export default function PapersAtlasPage() {
  return <WorldScene />;
}
