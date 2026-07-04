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
  title: "Papers Atlas — AP-RAG",
  description:
    "The AP-RAG corpus as one 3D world — a landscape of papers that unfolds into the embedding galaxy, with a time machine, metadata lenses, interpolation arcs, ghost papers, radio, and games over its real embeddings and knowledge graph.",
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
  // Local visual smoke-testing only: `ATLAS_DEV_OPEN=1 pnpm dev` skips the wall
  // for the atlas pages (never in production builds).
  if (process.env.NODE_ENV === "development" && process.env.ATLAS_DEV_OPEN === "1") {
    return <>{children}</>;
  }
  // Private deployment: same login wall as the chat UI.
  const session = await auth();
  if (!session?.user) {
    redirect(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/login`);
  }
  return <>{children}</>;
}
