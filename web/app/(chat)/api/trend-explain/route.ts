import { generateText } from "ai";
import { auth } from "@/app/(auth)/auth";
import { openaiOptions } from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { getTrendDetail } from "@/lib/aprag/client";

// The narrative layer over the Trends dashboard. Two shapes:
//
//   kind: "term"    why one term's line moved — the model gets the trajectory plus the
//                   co-occurrence and ownership context from /trend_detail, so it is
//                   describing supplied numbers rather than recalling the literature.
//   kind: "corpus"  three sentences on the state of the corpus, from the already-
//                   computed rising/fading/newcomer/burst lists.
//
// Both are told, explicitly, that this is one lab's library and not a census — the
// collection peaks in the 2000s, so an unguarded model reliably narrates the corpus's
// own decline as a decline in the field.

const CAVEAT =
  "These counts come from one research library (~10,400 papers on memory, " +
  "psycholinguistics and cognitive science), NOT from a complete census of the " +
  "literature. Collected output peaks in the 2000s and falls after, so raw counts " +
  "understate anything recent. Percentages are shares of that year's collected " +
  "papers, which corrects for it. Never describe a fall in raw count as a decline " +
  "in the field; if you mention a decline, tie it to the share figure.";

const TERM_SYSTEM =
  "You explain a trend line from a research-paper corpus to the researcher who " +
  "owns that corpus. Write 2-4 sentences of plain prose, no headings, no bullets, " +
  "no preamble. Lead with the shape of the trajectory (when it started, when it " +
  "peaked, where it is now), then use the co-occurrence and author/journal context " +
  "to say what the movement consists of — a topic changing hands, moving venue, or " +
  "picking up a new neighbouring vocabulary. Cite specific years, terms, and names " +
  "from the data given. If the data does not support an explanation, say the " +
  "trajectory is visible but its cause is not, rather than speculating. " +
  CAVEAT;

const CORPUS_SYSTEM =
  "You summarise the state of a research-paper corpus for the researcher who owns " +
  "it. Exactly three sentences, plain prose, no headings or bullets. One on what " +
  "is growing, one on what is receding, one on what is genuinely new. Name " +
  "specific terms and years. Be concrete and unexcited; do not editorialise about " +
  "the importance of any field. " +
  CAVEAT;

const cache = new Map<string, { at: number; text: string }>();
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

type Point = { year: number; count: number };

function trajectory(points: Point[]): string {
  return points
    .filter((p) => p.count > 0)
    .map((p) => `${p.year}:${p.count}`)
    .join(" ");
}

function nameList(rows: { term: string; n: number }[] | undefined): string {
  return (rows ?? [])
    .slice(0, 6)
    .map((r) => `${r.term} (${r.n})`)
    .join(", ");
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    kind?: "term" | "corpus";
    dim?: string;
    term?: string;
    points?: Point[];
    sharePoints?: Point[];
    stats?: Record<string, number>;
    delta?: number;
    windows?: { base: [number, number]; recent: [number, number] };
    rising?: { term: string; delta?: number }[];
    fading?: { term: string; delta?: number }[];
    newcomers?: { term: string; first: number; recent: number }[];
    bursts?: { term: string; from: number; to: number }[];
    span?: [number, number];
    totalPapers?: number;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const kind = body.kind ?? "term";
  const key =
    kind === "corpus"
      ? `corpus ${(body.rising ?? []).map((r) => r.term).join("|")}`
      : `term ${body.dim} ${body.term}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return Response.json({ text: hit.text, cached: true });
  }

  let system: string;
  let prompt: string;

  if (kind === "corpus") {
    const [from, to] = body.span ?? [0, 0];
    system = CORPUS_SYSTEM;
    prompt = [
      `Corpus: ${body.totalPapers?.toLocaleString() ?? "?"} dated papers, ${from}-${to}.`,
      `Comparison windows: ${body.windows?.base?.join("-")} (then) vs ${body.windows?.recent?.join("-")} (now).`,
      `Rising (change in share of corpus output, percentage points): ${(
        body.rising ?? []
      )
        .slice(0, 8)
        .map(
          (r) =>
            `${r.term} ${r.delta && r.delta > 0 ? "+" : ""}${r.delta?.toFixed(2)}pp`
        )
        .join(", ")}`,
      `Fading: ${(body.fading ?? [])
        .slice(0, 8)
        .map((r) => `${r.term} ${r.delta?.toFixed(2)}pp`)
        .join(", ")}`,
      `First appearing recently: ${(body.newcomers ?? [])
        .slice(0, 8)
        .map((n) => `${n.term} (from ${n.first}, ${n.recent} papers since)`)
        .join(", ")}`,
      `Sharpest bursts: ${(body.bursts ?? [])
        .slice(0, 6)
        .map((b) => `${b.term} (${b.from}-${b.to})`)
        .join(", ")}`,
    ].join("\n");
  } else {
    if (!(body.dim && body.term)) {
      return Response.json({ error: "dim and term required" }, { status: 400 });
    }
    // Pull the context server-side rather than trusting the client to send it —
    // the same memoised call the detail panel makes.
    let detail: Awaited<ReturnType<typeof getTrendDetail>> | null = null;
    try {
      detail = await getTrendDetail(body.dim, body.term);
    } catch {
      detail = null;
    }
    system = TERM_SYSTEM;
    prompt = [
      `Term: "${body.term}" (dimension: ${body.dim})`,
      `Papers per year: ${trajectory(body.points ?? [])}`,
      body.sharePoints?.length
        ? `Share of that year's papers (%): ${trajectory(body.sharePoints)}`
        : "",
      body.stats
        ? `First ${body.stats.first}, peak ${body.stats.peak} (${body.stats.peakN} papers), median year ${body.stats.median}, last ${body.stats.last}.`
        : "",
      body.delta !== undefined
        ? `Change in share of corpus output, ${body.windows?.base?.join("-")} vs ${body.windows?.recent?.join("-")}: ${body.delta > 0 ? "+" : ""}${body.delta.toFixed(2)} percentage points.`
        : "",
      detail
        ? [
            `Co-occurring terms then (${detail.windows.base.join("-")}): ${nameList(detail.cooccur.base)}`,
            `Co-occurring terms now (${detail.windows.recent.join("-")}): ${nameList(detail.cooccur.recent)}`,
            `Authors then: ${nameList(detail.authors.base)}`,
            `Authors now: ${nameList(detail.authors.recent)}`,
            `Journals then: ${nameList(detail.journals.base)}`,
            `Journals now: ${nameList(detail.journals.recent)}`,
            `Recent papers: ${detail.papers
              .slice(0, 6)
              .map((p) => `"${p.title}" (${p.year})`)
              .join("; ")}`,
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  try {
    const { text } = await generateText({
      model: getLanguageModel(),
      system,
      prompt,
      // A short descriptive paragraph over numbers already supplied — reasoning
      // buys nothing and the user is watching a spinner.
      providerOptions: openaiOptions("none", "low"),
      abortSignal: AbortSignal.timeout(45_000),
    });
    const clean = text.trim();
    if (cache.size >= MAX_ENTRIES) {
      cache.clear();
    }
    cache.set(key, { at: Date.now(), text: clean });
    return Response.json({ text: clean });
  } catch {
    return Response.json({ error: "explanation unavailable" }, { status: 502 });
  }
}
