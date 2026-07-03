import Link from "next/link";

const EXPERIENCES: {
  href: string;
  name: string;
  tag: string;
  desc: string;
  accent: string;
}[] = [
  {
    href: "/atlas",
    name: "The Atlas",
    tag: "map",
    desc: "A 3D landscape grown from 9,009 paper chunks — fly over named regions of the field, land anywhere, read what the terrain is made of. Includes the time machine.",
    accent: "#3987e5",
  },
  {
    href: "/voids",
    name: "Ghost Papers",
    tag: "dark matter",
    desc: "The inverse map: the empty pockets of the embedding space where no paper sits. Each void reveals the paper that would live there — hallucinated from the gap between its neighbors, a research-gap generator in disguise.",
    accent: "#9085e9",
  },
  {
    href: "/observatory",
    name: "The Observatory",
    tag: "starfield",
    desc: "The corpus as a night sky: every chunk a star, knowledge-graph entities drawn as constellations. Point the telescope; warp to any idea.",
    accent: "#9085e9",
  },
  {
    href: "/semantle",
    name: "Semantle",
    tag: "daily game",
    desc: "A hidden paper is chosen each day. Guess in free text, get temperature from the real embedding space, watch your guesses ping the map.",
    accent: "#c98500",
  },
  {
    href: "/wormhole",
    name: "Wormhole",
    tag: "race",
    desc: "Two papers, opposite ends of the field. Read your way from one to the other through nearest-neighbor hops. Fewest hops wins.",
    accent: "#199e70",
  },
  {
    href: "/interpolate",
    name: "The Interpolation Engine",
    tag: "instrument",
    desc: "Pick two ideas and slide between them — every step retrieves the real passages that live at that point on the geodesic. Embedding arithmetic included.",
    accent: "#e66767",
  },
  {
    href: "/radio",
    name: "Radio",
    tag: "ambient",
    desc: "A slow random walk through semantic space, read aloud. Tune the dial to drift toward or away from a topic. Leave it on.",
    accent: "#d55181",
  },
  {
    href: "/dungeon",
    name: "The Peer-Review Dungeon",
    tag: "roguelike",
    desc: "The knowledge graph as a dungeon: concepts are rooms, theories are bosses. Defend your claims against the literature itself.",
    accent: "#d95926",
  },
  {
    href: "/seance",
    name: "The Séance",
    tag: "chat",
    desc: "Summon any author in the corpus and interview them. They speak only from what they actually wrote — every sentence cited.",
    accent: "#008300",
  },
];

export default function Hub() {
  return (
    <main className="min-h-screen px-6 py-16 sm:px-12">
      <header className="mx-auto max-w-5xl">
        <p className="text-sm tracking-[0.3em] uppercase text-ink-3">
          AP-RAG · 175 papers · 9,009 chunks · one semantic space
        </p>
        <h1 className="font-display edr-glow mt-4 text-6xl font-light sm:text-8xl">
          Atlas of Mind
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-2">
          Ten instruments for exploring the semantic space of a psychology
          corpus — psycholinguistics, memory, brain imaging, AI and more —
          built on its actual embeddings, knowledge graph, and metadata.
        </p>
      </header>

      <section className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2">
        {EXPERIENCES.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="hud-panel group relative overflow-hidden p-6 transition-transform duration-200 hover:-translate-y-0.5"
          >
            <div
              className="absolute inset-x-0 top-0 h-px opacity-60 transition-opacity group-hover:opacity-100"
              style={{
                background: `linear-gradient(90deg, transparent, ${e.accent}, transparent)`,
              }}
            />
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-2xl">{e.name}</h2>
              <span
                className="rounded-full border px-2.5 py-0.5 text-[11px] tracking-widest uppercase"
                style={{ borderColor: e.accent, color: e.accent }}
              >
                {e.tag}
              </span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">{e.desc}</p>
          </Link>
        ))}
      </section>

      <footer className="mx-auto mt-16 max-w-5xl text-xs text-ink-3">
        Test corpus: 175 papers (2025–26). The full ~9,700-paper corpus drops in
        when its ingest completes — same pipeline, bigger world.
      </footer>
    </main>
  );
}
