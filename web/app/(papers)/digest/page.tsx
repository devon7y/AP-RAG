import type { Metadata } from "next";
import { Suspense } from "react";
import { DigestLibrary } from "@/components/digest/digest-library";

export const metadata: Metadata = {
  title: "Research Digest — AP-RAG",
  description:
    "Chronological research summaries by topic and date window — saved, revisitable, and updatable as papers are added to the corpus.",
};

export default function DigestPage() {
  // Suspense: DigestLibrary reads ?topic= via useSearchParams.
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <DigestLibrary />
    </Suspense>
  );
}
