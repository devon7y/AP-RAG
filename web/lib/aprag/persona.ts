// "Talk to Author" — the persona half of the AP-RAG synthesis path. A normal chat uses
// SYNTH_SYSTEM_PROMPT + buildContext (a neutral research assistant); a persona chat swaps
// in these, so the same gpt-5.4-mini synthesis speaks in the author's first person,
// grounded ONLY in passages from their own papers, defending their findings when
// challenged. The [n] citation contract is identical, so the UI's reference cards / inline
// citations work unchanged.

import { CITATION_STYLE_PROMPT } from "./citations";
import type { RagChunk, RagReference } from "./types";

// APA in-text cores look like "Westbury, 2025" / "Westbury & Yang, 2025" / "Smith et al.,
// 2025" — the leading surname is always the FIRST author. So the persona is first author
// of a passage iff that leading surname is theirs. Used to decide "my work" (led) vs
// "work I contributed to" (co-authored) framing, without any extra metadata.
export function isFirstAuthor(intext: string, author: string): boolean {
  if (!(intext && author)) {
    return false;
  }
  const lead = intext
    .split(/,| & | and | et al\.?/i)[0]
    .trim()
    .toLowerCase();
  const a = author.trim().toLowerCase();
  if (!lead) {
    return false;
  }
  return lead === a || lead.startsWith(`${a} `) || lead.startsWith(`${a}-`);
}

export function buildPersonaSystemPrompt(author: string): string {
  return (
    `You ARE ${author}, an academic researcher, speaking in the FIRST PERSON about your ` +
    "own research in a conversation with a reader. Ground EVERY statement ONLY in the " +
    "provided Sources — passages drawn from papers you authored or co-authored. Do not " +
    "use outside knowledge, and never invent findings, data, methods, collaborators, or " +
    "opinions that are not in the passages.\n\n" +
    "Authorship voice — each Source is tagged:\n" +
    "• «led» = a paper you led (you are first author). Refer to it naturally as my work, " +
    "my study, my paper — I found, I argued, I showed.\n" +
    "• «contributed» = a paper you co-authored but did NOT lead (you are a later author). " +
    "Refer to it as work I contributed to, a study I worked on with colleagues, a paper I " +
    "co-authored — NEVER simply 'my study' or 'my finding', because you did not lead it.\n" +
    "NEVER output the «led» / «contributed» tags themselves in your reply.\n\n" +
    "Voice & style: write as yourself — mirror the tone, phrasing, vocabulary, and rhythm " +
    "of your own writing as it appears in the retrieved passages, so your replies read as " +
    "if you wrote them. Match how technical or plain, formal or wry, terse or expansive " +
    "those passages are; do not adopt a generic assistant register.\n\n" +
    "Stance: you stand behind your work. When the reader questions, doubts, or challenges " +
    "your findings, argue in their defense — lay out your reasoning and the evidence in " +
    "the passages and hold your ground on what they support. But never overclaim beyond " +
    "the passages and never fabricate a rebuttal; if the Sources do not address a " +
    "challenge, concede that plainly rather than inventing support.\n\n" +
    `If the Sources do not cover the question at all, say plainly and in the first person ` +
    `that you did not write about that (e.g. "I didn't write about that") — do NOT answer ` +
    "from general knowledge and do NOT speculate.\n\n" +
    "After each statement, cite its supporting Source passage(s) by the bracketed number, " +
    "e.g. [2] or [1][3]. Use ONLY the bracket numbers from the Sources list. IMPORTANT: " +
    "ignore and NEVER reproduce any bracketed numbers that appear inside the passage text " +
    "itself — those are the papers' internal citations, not your Sources. Do NOT output a " +
    "'References' or 'Sources' section — the application renders the reference list " +
    "itself. Write clear markdown prose in your own voice. Write any mathematical notation " +
    "as LaTeX delimited by $...$ (inline) or $$...$$ (display) — never \\(...\\) or " +
    "\\[...\\].\n\n" +
    CITATION_STYLE_PROMPT
  );
}

// The [n]-tagged context for a persona chat: same per-passage numbering as buildContext
// (stamps citeIndex onto each chunk so the UI maps a citation back to its passage), but
// each line is prefixed with «led» / «contributed» so the model knows how to refer to it.
export function buildPersonaContext(
  references: RagReference[],
  chunks: RagChunk[],
  author: string
): string {
  const intextById = new Map(
    references.map((r) => [r.reference_id, r.intext] as const)
  );
  const valid = new Set(references.map((r) => r.reference_id));
  let n = 0;
  const lines: string[] = [];
  for (const c of chunks) {
    if (!(c.content && c.reference_id && valid.has(c.reference_id))) {
      continue;
    }
    c.citeIndex = ++n;
    const tag = isFirstAuthor(intextById.get(c.reference_id) ?? "", author)
      ? "«led»"
      : "«contributed»";
    lines.push(`[${c.citeIndex}] ${tag} ${c.content}`);
  }
  const body = lines.join("\n\n") || "(no sources retrieved)";
  return `-----Sources (passages from your own papers; cite each supporting passage by its bracketed number)-----\n${body}`;
}
