"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ragQuery, ragRetrieve } from "@/lib/api";
import { STATUS } from "@/lib/palette";
import { Meter } from "./Hud";
import {
  damageFor,
  extractEvidence,
  judgeQuestion,
  judgeRubric,
  parseVerdict,
  referenceLines,
} from "./judge";
import type { EvidenceChunk, Room, Verdict } from "./types";

/**
 * The argument loop: stake a claim → retrieval pulls the passages the court
 * consults → the LLM judge (POST /api/rag/query) rules on whether the
 * literature backs you, with APA citations. Convincing claims wound the boss;
 * weak ones cost credibility.
 */

interface FightEvent {
  id: number;
  kind: "claim" | "consult";
  claim?: string;
  status: "pending" | "done" | "error";
  verdict?: Verdict;
  refs?: string[];
  evidence?: EvidenceChunk[];
  error?: string;
}

const VERDICT_COLOR: Record<Verdict["verdict"], string> = {
  SUPPORTED: STATUS.good,
  PARTIAL: STATUS.warning,
  UNSUPPORTED: STATUS.serious,
  CONTRADICTED: STATUS.critical,
};

function EvidenceCard({ chunk }: { chunk: EvidenceChunk }) {
  const [expanded, setExpanded] = useState(false);
  const long = chunk.text.length > 380;
  return (
    <div className="rounded-lg border border-hairline bg-black/25 p-3">
      <p className="text-[11px] leading-snug text-ink-3">
        {chunk.apa ?? chunk.file}
        {chunk.page !== null && ` · p. ${chunk.page}`}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
        {expanded || !long ? chunk.text : `${chunk.text.slice(0, 380)}…`}
      </p>
      {long && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
        >
          {expanded ? "collapse" : "read full passage"}
        </button>
      )}
    </div>
  );
}

function EventCard({ event }: { event: FightEvent }) {
  const v = event.verdict;
  const dmg = v ? damageFor(v) : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-hairline bg-black/20 p-4"
    >
      {event.kind === "claim" ? (
        <p className="text-sm leading-snug text-ink">“{event.claim}”</p>
      ) : (
        <p className="text-[11px] tracking-widest text-ink-3 uppercase">
          ◆ Consulted the stacks
        </p>
      )}

      {event.status === "pending" && (
        <p className="pulse-soft mt-2 text-xs text-ink-3">
          {event.kind === "claim" ? "The panel deliberates…" : "Pulling the strongest passages…"}
        </p>
      )}
      {event.status === "error" && (
        <p className="mt-2 text-xs" style={{ color: STATUS.serious }}>
          The court is unreachable — no ruling, no damage. ({event.error})
        </p>
      )}

      {v && (
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <span
              className="rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-widest uppercase"
              style={{ borderColor: VERDICT_COLOR[v.verdict], color: VERDICT_COLOR[v.verdict] }}
            >
              {v.verdict}
            </span>
            <span className="text-sm tabular-nums text-ink-2">{v.score}/100</span>
            {dmg && dmg.toBoss > 0 && (
              <span className="text-xs" style={{ color: "#ffb38a" }}>
                boss −{dmg.toBoss}
              </span>
            )}
            {dmg && dmg.toPlayer > 0 && (
              <span className="text-xs" style={{ color: STATUS.critical }}>
                you −{dmg.toPlayer}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">{v.ruling}</p>
          {event.refs && event.refs.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-hairline pt-2">
              {event.refs.map((r, i) => (
                <li key={i} className="text-[11px] leading-snug text-ink-3">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {event.evidence && event.evidence.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] tracking-widest text-ink-3 uppercase">
            Passages consulted ({event.evidence.length})
          </p>
          {event.evidence.map((c, i) => (
            <EvidenceCard key={i} chunk={c} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

export default function BossFight({
  boss,
  bossHp,
  bossMax,
  insight,
  onVerdict,
  onSpendInsight,
  onRetreat,
}: {
  boss: Room;
  bossHp: number;
  bossMax: number;
  insight: number;
  onVerdict: (claim: string, verdict: Verdict) => void;
  onSpendInsight: () => void;
  onRetreat: () => void;
}) {
  const [events, setEvents] = useState<FightEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [judging, setJudging] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const nextId = useRef(0);
  const usedClaims = useRef(new Set<string>());
  const bossName = boss.entity?.id ?? boss.id;

  const patch = (id: number, p: Partial<FightEvent>) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...p } : e)));

  async function submitClaim() {
    const claim = draft.trim().replace(/\s+/g, " ");
    if (judging) return;
    if (claim.length < 15) {
      setWarn("Stake a real claim — at least a full sentence.");
      return;
    }
    const norm = claim.toLowerCase();
    if (usedClaims.current.has(norm)) {
      setWarn("You already argued that. The panel remembers.");
      return;
    }
    usedClaims.current.add(norm);
    setWarn(null);
    setDraft("");
    setJudging(true);
    const id = nextId.current++;
    setEvents((prev) => [{ id, kind: "claim" as const, claim, status: "pending" as const }, ...prev]);

    // Evidence and ruling race in parallel; passages appear as soon as they land.
    ragRetrieve({ question: `${bossName}: ${claim}`, mode: "naive", chunk_top_k: 5 })
      .then((res) => patch(id, { evidence: extractEvidence(res) }))
      .catch(() => {});
    try {
      const res = await ragQuery({
        question: judgeQuestion(bossName, claim),
        mode: "mix",
        user_prompt: judgeRubric(bossName),
        chunk_top_k: 10,
      });
      const verdict = parseVerdict(res.answer);
      patch(id, { status: "done", verdict, refs: referenceLines(res.references) });
      onVerdict(claim, verdict);
    } catch (e) {
      patch(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setJudging(false);
    }
  }

  async function consult() {
    if (insight <= 0 || judging) return;
    onSpendInsight();
    const id = nextId.current++;
    setEvents((prev) => [{ id, kind: "consult" as const, status: "pending" as const }, ...prev]);
    try {
      const res = await ragRetrieve({
        question: `${bossName}: key findings, mechanisms, boundary conditions, and critiques`,
        mode: "mix",
        chunk_top_k: 8,
      });
      patch(id, { status: "done", evidence: extractEvidence(res) });
    } catch (e) {
      patch(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <>
      {/* boss header */}
      <div className="hud-panel pointer-events-none absolute top-5 left-1/2 z-40 w-[420px] max-w-[80vw] -translate-x-1/2 p-4">
        <p className="text-center text-[11px] tracking-[0.3em] uppercase" style={{ color: "#ffb38a" }}>
          Boss fight
        </p>
        <h2 className="font-display edr-glow mt-1 text-center text-2xl leading-tight">{bossName}</h2>
        <div className="mt-3">
          <Meter label="Boss standing" value={bossHp} max={bossMax} color="#d95926" />
        </div>
      </div>

      {/* fight log */}
      <div className="hud-scroll pointer-events-auto absolute top-56 right-5 bottom-44 z-40 w-[400px] max-w-[42vw] space-y-3 overflow-y-auto pr-1">
        <AnimatePresence>
          {events.map((e) => (
            <EventCard key={e.id} event={e} />
          ))}
        </AnimatePresence>
        {events.length === 0 && (
          <div className="hud-panel p-4 text-xs leading-relaxed text-ink-3">
            Stake a claim about <span className="text-ink-2">{bossName}</span> — specific and
            falsifiable. Retrieval pulls the passages; the judge rules whether the literature
            backs you. Scores ≥ 50 wound the boss; weaker claims wound you.
          </div>
        )}
      </div>

      {/* claim console */}
      <div className="hud-panel pointer-events-auto absolute bottom-5 left-1/2 z-40 w-[560px] max-w-[92vw] -translate-x-1/2 p-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submitClaim();
            }
          }}
          rows={2}
          placeholder={`e.g. "Word frequency effects on lexical decision are better explained by contextual diversity than by raw frequency."`}
          className="w-full resize-none rounded-lg border border-hairline bg-black/30 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-white/25 focus:outline-none"
        />
        {warn && (
          <p className="mt-1.5 text-[11px]" style={{ color: STATUS.warning }}>
            {warn}
          </p>
        )}
        <div className="mt-2.5 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={consult}
              disabled={insight <= 0 || judging}
              className="rounded-lg border border-hairline px-3 py-1.5 text-xs text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              title="Spend an Insight to see what the corpus says before committing a claim"
            >
              ◆ Consult the stacks ×{insight}
            </button>
            <button
              onClick={onRetreat}
              disabled={judging}
              className="rounded-lg border border-hairline px-3 py-1.5 text-xs text-ink-3 transition-colors hover:text-ink-2 disabled:opacity-40"
            >
              Retreat
            </button>
          </div>
          <button
            onClick={() => void submitClaim()}
            disabled={judging || draft.trim().length === 0}
            className="rounded-lg border px-4 py-1.5 text-sm transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "#d95926", color: "#ffb38a" }}
          >
            {judging ? "Deliberating…" : "Stake the claim"}
          </button>
        </div>
      </div>
    </>
  );
}
