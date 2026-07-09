import type { Metadata } from "next";
import { Suspense } from "react";
import { PapersBrowser } from "@/components/papers/papers-browser";

export const metadata: Metadata = {
  title: "Paper Database — AP-RAG",
  description:
    "Browse, sort, filter, and search every paper in the AP-RAG corpus.",
};

export default function PapersPage() {
  // Suspense: PapersBrowser reads the URL via useSearchParams.
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <PapersBrowser />
    </Suspense>
  );
}
