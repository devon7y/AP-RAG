"use client";

import { useCallback, useRef, useState } from "react";
import type { CorpusData } from "@/lib/types";
import {
  type AuthorSpirit,
  type CitedSite,
  type SeanceRef,
  normalizeRefs,
  resolveCitations,
  stripReferencesSection,
} from "./authors";

export type SeanceRole = "you" | "them" | "note";

export interface SeanceMessage {
  id: number;
  role: SeanceRole;
  text: string;
  /** structured references (them-messages only) */
  refs?: SeanceRef[];
  /** cited papers resolved onto the map */
  cited?: CitedSite[];
  /** retrieval came back empty — nothing to ground an answer in */
  silent?: boolean;
  /** the spirit disclaimed the topic ("I never wrote about that") */
  demurred?: boolean;
}

/** The persona's mandated disclaimer (and close variants). */
const SILENCE_RE =
  /never wrote about|did(?: not|n't) write about|no(?:thing)? in my (?:papers|writing|work)|my papers do(?: not|n't) (?:cover|address)/i;

/**
 * Séance chat state. All server access goes through POST /api/seance, which
 * scopes retrieval to the summoned author and enforces the grounding rules.
 */
export function useSeance(corpus: CorpusData | null) {
  const [spirit, setSpirit] = useState<AuthorSpirit | null>(null);
  const [messages, setMessages] = useState<SeanceMessage[]>([]);
  const [channeling, setChanneling] = useState(false);
  /** bumped on summon/release so stale in-flight answers are dropped */
  const session = useRef(0);
  const nextId = useRef(1);

  const summon = useCallback((s: AuthorSpirit) => {
    session.current += 1;
    setSpirit(s);
    setChanneling(false);
    const years =
      s.yearMin > 0
        ? s.yearMin === s.yearMax
          ? `${s.yearMin}`
          : `${s.yearMin}–${s.yearMax}`
        : "";
    setMessages([
      {
        id: nextId.current++,
        role: "note",
        text:
          `The candles settle. ${s.name} is listening — grounded in ` +
          `${s.nChunks.toLocaleString()} passages from ${s.nPapers} paper${s.nPapers === 1 ? "" : "s"}` +
          `${years ? ` (${years})` : ""}. They can only speak from what they wrote.`,
      },
    ]);
  }, []);

  const release = useCallback(() => {
    session.current += 1;
    setSpirit(null);
    setMessages([]);
    setChanneling(false);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!spirit || channeling || !q) return;
      const mySession = session.current;
      const history = messages
        .filter((m) => m.role !== "note")
        .slice(-8)
        .map((m) => ({ role: m.role === "you" ? "user" : "author", text: m.text }));
      setMessages((ms) => [...ms, { id: nextId.current++, role: "you", text: q }]);
      setChanneling(true);
      try {
        const r = await fetch("/api/seance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ author: spirit.name, question: q, history }),
        });
        const data = await r.json().catch(() => ({}));
        if (session.current !== mySession) return;
        if (!r.ok) {
          throw new Error(String((data as { error?: string }).error || `HTTP ${r.status}`));
        }
        const answer = stripReferencesSection(String((data as { answer?: unknown }).answer ?? ""));
        const refs = normalizeRefs((data as { references?: unknown }).references);
        const cited = corpus ? resolveCitations(refs, corpus.papers, corpus.clusters) : [];
        const silent = refs.length === 0;
        const demurred = SILENCE_RE.test(answer);
        setMessages((ms) => [
          ...ms,
          {
            id: nextId.current++,
            role: "them",
            text: answer || "…the spirit stirs, but no words come.",
            refs,
            cited,
            silent,
            demurred,
          },
        ]);
      } catch (e) {
        if (session.current !== mySession) return;
        setMessages((ms) => [
          ...ms,
          {
            id: nextId.current++,
            role: "note",
            text: `The connection wavers — ${e instanceof Error ? e.message : String(e)}. Ask again.`,
          },
        ]);
      } finally {
        if (session.current === mySession) setChanneling(false);
      }
    },
    [spirit, channeling, messages, corpus],
  );

  return { spirit, messages, channeling, summon, release, ask };
}
