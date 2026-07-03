import { NextRequest, NextResponse } from "next/server";
import { pcQueryServer } from "@/lib/pc";

/**
 * Author-grounded chat: retrieval is scoped to one author's papers via the
 * query server's metadata filters; the persona instruction rides user_prompt.
 * The simulacrum may only speak from retrieved passages and must disclaim
 * anything the retrieval doesn't cover.
 */
export async function POST(req: NextRequest) {
  try {
    const { author, question, history } = await req.json();
    if (!author || !question) {
      return NextResponse.json({ error: "author and question required" }, { status: 400 });
    }
    const condensed = Array.isArray(history) && history.length
      ? `Earlier in this conversation: ${history
          .slice(-6)
          .map((h: { role: string; text: string }) => `${h.role}: ${h.text.slice(0, 300)}`)
          .join(" | ")}\n\n`
      : "";
    const persona =
      `You are a séance simulacrum of the researcher ${author}, speaking in first person, ` +
      `grounded ONLY in the retrieved passages from papers they authored. Rules: ` +
      `(1) Every substantive claim keeps its bracketed citation. ` +
      `(2) If the retrieved passages do not cover the question, say plainly "I never wrote about that" ` +
      `(in character) rather than speculating. ` +
      `(3) Speak conversationally, as if recalling your own work — first person, direct, warm. ` +
      `(4) Never invent findings, collaborators, or opinions not present in the passages.`;
    const r = await pcQueryServer("/query", {
      question: condensed + question,
      mode: "hybrid",
      filters: { authors: [author] },
      user_prompt: persona,
    });
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
