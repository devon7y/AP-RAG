import type { RagReference } from "@/lib/api";
import type { EvidenceChunk, Verdict } from "./types";

/**
 * The boss fight's referee: prompt construction for the LLM judge
 * (POST /api/rag/query) and defensive parsing of its ruling, plus extraction of
 * the raw passages from POST /api/rag/retrieve into evidence cards.
 */

export function judgeQuestion(bossName: string, claim: string): string {
  return `A researcher makes the following claim about ${bossName}: "${claim}". Does the literature support this claim?`;
}

export function judgeRubric(bossName: string): string {
  return [
    `You are the adversarial examiner in a peer-review gauntlet. A challenger has staked the claim quoted in the question. Judge STRICTLY whether the retrieved literature supports it — reward specific, falsifiable, evidence-backed claims and punish vague ones.`,
    `Scoring guide: 85–100 the literature decisively backs the claim; 60–84 supported with caveats; 40–59 mixed or only partially supported; 20–39 the literature does not support it; 0–19 the literature contradicts it. If the claim is vague, unfalsifiable, trivially true, or not substantively about ${bossName}, score it below 35 and say why.`,
    `Respond in EXACTLY this format (three lines, no preamble):`,
    `VERDICT: one of SUPPORTED, PARTIAL, UNSUPPORTED, CONTRADICTED`,
    `SCORE: an integer 0-100`,
    `RULING: 2-4 sentences naming the specific findings that support or undercut the claim, citing sources with bracketed reference numbers.`,
  ].join("\n");
}

const VERDICTS: Verdict["verdict"][] = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "CONTRADICTED"];

/** Parse the judge's answer; degrade gracefully when the LLM strays from the format. */
export function parseVerdict(answer: string): Verdict {
  const text = answer.trim();
  const verdictMatch = text.match(/VERDICT:\s*(?:PARTIALLY\s+SUPPORTED|[A-Z]+)/i)?.[0] ?? "";
  const scoreMatch = text.match(/SCORE:\s*(\d{1,3})/i);
  const rulingMatch = text.match(/RULING:\s*([\s\S]+)/i);

  let verdict =
    VERDICTS.find((v) => new RegExp(`\\b${v}\\b`).test(verdictMatch.toUpperCase())) ?? null;
  if (!verdict && /PARTIALLY/i.test(verdictMatch)) verdict = "PARTIAL";

  let score = scoreMatch ? Math.min(100, parseInt(scoreMatch[1], 10)) : NaN;
  if (Number.isNaN(score)) {
    // No score line — infer a conservative one from the verdict, or from tone.
    if (verdict === "SUPPORTED") score = 80;
    else if (verdict === "PARTIAL") score = 50;
    else if (verdict === "CONTRADICTED") score = 10;
    else if (verdict === "UNSUPPORTED") score = 25;
    else if (/no relevant information/i.test(text)) score = 25;
    else score = 45;
  }
  if (!verdict) {
    verdict = score >= 70 ? "SUPPORTED" : score >= 45 ? "PARTIAL" : score >= 20 ? "UNSUPPORTED" : "CONTRADICTED";
  }

  const ruling = (rulingMatch?.[1] ?? text.replace(/VERDICT:[^\n]*\n?|SCORE:[^\n]*\n?/gi, "")).trim();
  return { verdict, score, ruling: ruling || "The panel deliberated in silence." };
}

/** Pull evidence cards out of the /retrieve payload (aquery_data shape), defensively. */
export function extractEvidence(res: Record<string, unknown>): EvidenceChunk[] {
  const data = (res?.data ?? {}) as Record<string, unknown>;
  const chunks = Array.isArray(data.chunks) ? (data.chunks as Record<string, unknown>[]) : [];
  const refs = Array.isArray(data.references) ? (data.references as Record<string, unknown>[]) : [];
  const apaByRef = new Map<string, string>();
  for (const r of refs) {
    const id = String(r.reference_id ?? "");
    if (id && typeof r.apa === "string") apaByRef.set(id, r.apa);
  }
  return chunks
    .map((c) => {
      const refId = String(c.reference_id ?? "");
      return {
        text: typeof c.content === "string" ? c.content : "",
        file: typeof c.file_path === "string" ? c.file_path : "",
        page: typeof c.page === "number" ? c.page : null,
        refId,
        apa: apaByRef.get(refId) ?? null,
      };
    })
    .filter((c) => c.text.length > 0);
}

/** APA strings for the judge's reference list. */
export function referenceLines(refs: RagReference[]): string[] {
  return (refs ?? [])
    .map((r) =>
      typeof r.apa === "string" && r.apa ? r.apa : String(r.filename ?? r.file ?? ""),
    )
    .filter((s) => s && s !== "undefined");
}

/* ── damage model ───────────────────────────────────────────────────────── */

export const PLAYER_MAX_HP = 100;
export const bossMaxHp = (floorIdx: number) => 140 + floorIdx * 30;

/** A convincing claim wounds the boss; a weak one costs you standing. */
export function damageFor(v: Verdict): { toBoss: number; toPlayer: number } {
  if (v.score >= 50) {
    return { toBoss: Math.round(v.score * (v.score >= 80 ? 1.0 : 0.75)), toPlayer: 0 };
  }
  const base = Math.round((55 - v.score) * 1.1);
  return { toBoss: 0, toPlayer: base + (v.verdict === "CONTRADICTED" ? 10 : 0) };
}
