import type { Metadata } from "next";
import { Suspense } from "react";
import { EntityView } from "@/components/graph/entity-view";

// Entity detail lives at /graph/entity?name=<entity> (a query param, not a path
// segment — extracted entity names can contain slashes, e.g. "N400/P600").

export const metadata: Metadata = {
  title: "Knowledge Graph entity — AP-RAG",
  description:
    "A knowledge-graph entity's corpus-wide description, its connections, and the papers behind it.",
};

export default function GraphEntityPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <EntityView />
    </Suspense>
  );
}
