import "server-only";

import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

// Multi-turn RAG needs a standalone retrieval query: a bare follow-up ("what about the
// other classifier?") retrieves poorly on its own. Condense the conversation + the new
// message into one self-contained query (cheap, minimal-reasoning gpt-5-mini call).
// First turn (no history) returns the question unchanged — no LLM call.
export async function condenseQuery(
  history: HistoryTurn[],
  question: string
): Promise<string> {
  const priorTurns = history.filter((t) => t.content.trim().length > 0);
  if (priorTurns.length === 0) {
    return question;
  }

  const convo = priorTurns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  try {
    const { text } = await generateText({
      model: getLanguageModel(),
      system:
        "Rewrite the user's latest message into a single standalone search query for " +
        "retrieving relevant academic papers. Resolve pronouns and references using the " +
        "conversation so the query stands on its own. Preserve specific names, numbers, " +
        "and terms. Output ONLY the query text — no preamble, no quotes.",
      prompt: `Conversation so far:\n${convo}\n\nLatest user message: ${question}\n\nStandalone search query:`,
      providerOptions: { openai: { reasoningEffort: "minimal" } },
      abortSignal: AbortSignal.timeout(20_000),
    });
    return text.trim() || question;
  } catch {
    // Never let condensing break the turn — fall back to the raw question.
    return question;
  }
}
