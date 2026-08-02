import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthorProfile } from "@/components/papers/author-profile";

// Author profile: /authors/<family-name> — the author's corpus footprint (papers,
// timeline, venues, topics, co-authors) with jumps into chat, the Paper Database,
// and Talk to Author. The name segment is the manifest's author family name.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ author: string }>;
}): Promise<Metadata> {
  const { author } = await params;
  const name = decodeURIComponent(author);
  return {
    title: `${name} — AP-RAG`,
    description: `${name}'s papers, topics, venues, and co-authors in the AP-RAG corpus.`,
  };
}

export default async function AuthorPage({
  params,
}: {
  params: Promise<{ author: string }>;
}) {
  const { author } = await params;
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <AuthorProfile family={decodeURIComponent(author)} />
    </Suspense>
  );
}
