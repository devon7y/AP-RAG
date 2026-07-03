import type { Metadata } from "next";
import { Fraunces } from "next/font/google";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "../(auth)/auth";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Atlas of Mind — AP-RAG",
  description:
    "Games and instruments for exploring the semantic space of the AP-RAG corpus — maps, ghosts, races, and séances over its real embeddings and knowledge graph.",
};

export default function AtlasLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // .atlas-app scopes the always-dark atlas token set (see globals.css) so the
  // experiences keep their own look without leaking styles into the chat UI.
  return (
    <div className={`${fraunces.variable} atlas-app`}>
      <Suspense fallback={<div className="min-h-dvh" />}>
        <AuthGate>{children}</AuthGate>
      </Suspense>
    </div>
  );
}

async function AuthGate({ children }: { children: React.ReactNode }) {
  // Private deployment: same login wall as the chat UI.
  const session = await auth();
  if (!session?.user) {
    redirect(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/login`);
  }
  return <>{children}</>;
}
