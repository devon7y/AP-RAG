import type { Metadata } from "next";
import { Suspense } from "react";
import { GraphExplorer } from "@/components/graph/graph-explorer";

export const metadata: Metadata = {
  title: "Knowledge Graph — AP-RAG",
  description:
    "Browse the concepts, methods, theories, authors, and findings extracted from the corpus — and how they connect.",
};

export default function GraphPage() {
  // Suspense: GraphExplorer reads ?q=/&type= via useSearchParams.
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <GraphExplorer />
    </Suspense>
  );
}
