import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { openaiOptions } from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { pcEmbed, qdrantSearch } from "@/lib/atlas/pc";

export const maxDuration = 120;

/**
 * Ghost-paper writer: given the papers surrounding an empty pocket of the
 * embedding space, author the paper that WOULD live there (clearly marked
 * hallucinated), then embed its abstract and vector-search the corpus so the
 * client can show where the ghost *actually* lands — the echo star.
 *
 * The prompt only ever carries clean metadata (titles + cluster terms),
 * mirroring make_ghosts.py's sanitization discipline: no raw passage prose.
 */

const GhostSchema = z.object({
  title: z.string().describe("scholarly paper title, no quotes"),
  fields: z
    .string()
    .describe('the two literatures it bridges, e.g. "computational law × fairness evaluation"'),
  methods: z.string().describe("one clause naming the concrete methods it would use"),
  abstract: z
    .string()
    .describe(
      "90-130 word scholarly abstract for this absent paper, framed as the research gap it fills; no citations, no first person",
    ),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { neighbors, terms } = (await req.json()) as {
      neighbors?: string[];
      terms?: string[];
    };
    const titles = (neighbors ?? []).filter((t) => typeof t === "string").slice(0, 10);
    const regionTerms = (terms ?? []).filter((t) => typeof t === "string").slice(0, 12);
    if (titles.length < 2) {
      return NextResponse.json(
        { error: "need at least 2 neighboring paper titles" },
        { status: 400 },
      );
    }

    const { object: ghost } = await generateObject({
      model: getLanguageModel(),
      // Schema-bounded creative write-up; the abstract's length is fixed by the schema,
      // so keep reasoning off and verbosity tight.
      providerOptions: openaiOptions("none", "low"),
      schema: GhostSchema,
      prompt:
        `You are the cartographer of a semantic map of a research corpus ` +
        `(psycholinguistics, memory, cognitive science, NLP). A reader has found an ` +
        `EMPTY region — a pocket of embedding space where no paper exists. ` +
        `The papers nearest the void are:\n${titles.map((t) => `- ${t}`).join("\n")}\n` +
        (regionTerms.length
          ? `The surrounding region's characteristic terms: ${regionTerms.join(", ")}.\n`
          : "") +
        `Write the plausible, genuinely interesting paper that WOULD live in this gap — ` +
        `sitting between the surrounding literatures, combining their questions or methods ` +
        `in a way none of them did. It must read like a real paper a good researcher could ` +
        `write next, not science fiction. Do not reuse any neighbor title.`,
    });

    // where does the ghost's own abstract actually embed?
    const [vec] = await pcEmbed([`${ghost.title}. ${ghost.abstract}`], "query");
    const hits = await qdrantSearch(vec, 10);

    return NextResponse.json({ ghost: { ...ghost, marker: "GHOST" }, hits });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
