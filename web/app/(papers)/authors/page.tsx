import type { Metadata } from "next";
import { Suspense } from "react";
import { TalkToAuthor } from "@/components/papers/talk-to-author";

export const metadata: Metadata = {
  title: "Talk to Author — AP-RAG",
  description:
    "Interview a researcher in the corpus: they answer in their own voice, only from papers they wrote, with every claim cited.",
};

export default function TalkToAuthorPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
      <TalkToAuthor />
    </Suspense>
  );
}
