import type { Metadata } from "next";
import { Suspense } from "react";
import { TrendsDashboard } from "@/components/papers/trends-dashboard";

export const metadata: Metadata = {
  title: "Research Trends — AP-RAG",
  description:
    "Publication trends across the corpus: output per year, topic trajectories, and rising or fading research threads.",
};

export default function TrendsPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <TrendsDashboard />
    </Suspense>
  );
}
