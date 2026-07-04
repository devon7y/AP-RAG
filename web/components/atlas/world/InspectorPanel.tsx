"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { fetchChunkText } from "@/lib/atlas/api";
import { generateUUID } from "@/lib/utils";
import type {
  AuthorRec,
  Constellations,
  CorpusData,
  GhostPaper,
  PaperMeta,
} from "@/lib/atlas/types";
import { paperWorldPos } from "./PaperBeacons";
import { entityColor, shortCite, type WorldData } from "./derive";
import type { WorldEndpoint } from "./engineBridge";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";
import { VOID_VIOLET } from "./GhostLayer";

/**
 * The right-hand inspector: whatever is selected — paper, passage, entity,
 * author, or ghost — gets its full card here, with actions that feed the
 * other instruments (fly, lens, interpolation endpoints, radio).
 */

function sendEndpoint(slot: "A" | "B" | "C", ep: WorldEndpoint) {
  useWorld.getState().setInstrument("interpolate");
  window.dispatchEvent(new CustomEvent("world:set-endpoint", { detail: { slot, ep } }));
}

function Action({
  onClick,
  children,
  accent = "#3987e5",
}: {
  onClick: () => void;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-2.5 py-1 text-[10px] tracking-widest uppercase transition-opacity hover:opacity-80"
      style={{ borderColor: `${accent}66`, color: accent }}
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border hairline px-2 py-0.5 text-[10px] text-ink-3">
      {children}
    </span>
  );
}

export default function InspectorPanel({
  data,
  corpus,
  authors,
  paperMeta,
  constellations,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
  paperMeta: PaperMeta | null;
  constellations: Constellations;
}) {
  const selection = useWorld((s) => s.selection);
  const hasBack = useWorld((s) => s.selectionStack.length > 0);
  if (!selection) return null;

  return (
    <aside className="hud-panel hud-scroll absolute top-20 right-4 bottom-24 z-40 w-[330px] max-w-[85vw] overflow-y-auto p-4">
      {/* in-flow header row so the buttons never sit on top of card titles */}
      <div className="-mt-1 mb-2 flex items-center justify-end gap-1 border-b hairline pb-1.5">
        {hasBack && (
          <button
            type="button"
            className="rounded px-1.5 text-sm text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
            onClick={() => useWorld.getState().back()}
            aria-label="Back"
            title="Back"
          >
            ←
          </button>
        )}
        <button
          type="button"
          className="rounded px-1.5 text-sm text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
          onClick={() => useWorld.getState().select(null)}
          aria-label="Close"
          title="Close"
        >
          ✕
        </button>
      </div>
      {selection.kind === "paper" && (
        <PaperCard
          data={data}
          corpus={corpus}
          authors={authors}
          paperMeta={paperMeta}
          idx={selection.idx}
        />
      )}
      {selection.kind === "chunk" && (
        <ChunkCard data={data} corpus={corpus} idx={selection.idx} />
      )}
      {selection.kind === "entity" && (
        <EntityCard data={data} constellations={constellations} idx={selection.idx} />
      )}
      {selection.kind === "author" && (
        <AuthorCard corpus={corpus} authors={authors} idx={selection.idx} />
      )}
      {selection.kind === "ghost" && <GhostCard corpus={corpus} id={selection.id} />}
    </aside>
  );
}

/* ---------------- paper ---------------- */

function PaperCard({
  data,
  corpus,
  authors,
  paperMeta,
  idx,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
  paperMeta: PaperMeta | null;
  idx: number;
}) {
  const p = corpus.papers[idx];
  const st = useWorld.getState();
  const paperAuthors = useMemo(
    () =>
      authors
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.papers.includes(idx))
        .slice(0, 8),
    [authors, idx],
  );
  const kws = paperMeta?.keywords[idx] ?? [];
  const subj = paperMeta?.subjects[idx] ?? [];

  return (
    <div className="space-y-3">
      <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
        paper {p.year ? `· ${p.year}` : ""} {p.journal ? `· ${p.journal}` : ""}
      </p>
      <h2 className="font-display text-lg leading-snug text-ink">{p.title}</h2>
      <p className="text-xs text-ink-2">{p.authors}</p>
      {p.abstract && (
        <p className="line-clamp-[9] text-[11px] leading-relaxed text-ink-3">
          {p.abstract}
        </p>
      )}
      {(kws.length > 0 || subj.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {[...kws.slice(0, 6), ...subj.slice(0, 3)].map((k) => (
            <Chip key={k}>{k}</Chip>
          ))}
        </div>
      )}
      <p className="text-[11px] text-ink-3">{p.nChunks} passages in the atlas</p>
      <div className="flex flex-wrap gap-1.5 border-t hairline pt-3">
        <Action
          onClick={() => {
            const v = paperWorldPos(data, idx, uMorph.value, new THREE.Vector3());
            st.requestWarp([v.x, v.y, v.z], 10, 1.7);
          }}
        >
          fly
        </Action>
        <Action onClick={() => sendEndpoint("A", { kind: "paper", paperIdx: idx })}>
          bridge from
        </Action>
        <Action onClick={() => sendEndpoint("B", { kind: "paper", paperIdx: idx })} accent="#e66767">
          bridge to
        </Action>
        {p.doi && (
          <a
            href={`https://doi.org/${p.doi}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-white/20 px-2.5 py-1 text-[10px] tracking-widest text-ink-2 uppercase hover:text-ink"
          >
            doi
          </a>
        )}
      </div>
      {paperAuthors.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-2">Authors in the atlas</p>
          <ul className="mt-1 space-y-0.5">
            {paperAuthors.map(({ a, i }) => (
              <li key={a.name}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                  onClick={() => st.select({ kind: "author", idx: i })}
                >
                  {a.name} <span className="text-ink-3">· {a.papers.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------------- chunk ---------------- */

function ChunkCard({
  data,
  corpus,
  idx,
}: {
  data: WorldData;
  corpus: CorpusData;
  idx: number;
}) {
  const p = corpus.papers[corpus.atlas.paper[idx]];
  const section = corpus.atlas.section[idx];
  const [text, setText] = useState<string | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const st = useWorld.getState();

  useEffect(() => {
    let alive = true;
    setText(null);
    setPage(null);
    fetchChunkText(corpus.atlas.chunkId[idx]).then(
      (rec) => {
        if (!alive) return;
        setText(rec.text);
        setPage(rec.page);
      },
      () => alive && setText(corpus.atlas.snippet[idx]),
    );
    return () => {
      alive = false;
    };
  }, [corpus, idx]);

  return (
    <div className="space-y-3">
      <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
        passage {section && section !== "Untitled" ? `· ${section}` : ""}
        {page ? ` · p. ${page}` : ""}
      </p>
      <h2 className="font-display text-base leading-snug text-ink">
        {p?.title ?? "Unknown paper"}
      </h2>
      <p className="text-[11px] text-ink-3">{shortCite(p)}</p>
      <div className="max-h-[38vh] overflow-y-auto rounded-md border hairline p-2.5 text-[11px] leading-relaxed whitespace-pre-line text-ink-2">
        {text ?? "…"}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t hairline pt-3">
        <Action
          onClick={() =>
            st.select({ kind: "paper", idx: corpus.atlas.paper[idx] })
          }
        >
          open paper
        </Action>
        <Action
          accent="#d55181"
          onClick={() => {
            st.set("radioIdx", idx);
            st.set("radioOn", true);
            st.setInstrument("radio");
          }}
        >
          start radio here
        </Action>
      </div>
    </div>
  );
}

/* ---------------- entity ---------------- */

function EntityCard({
  data,
  constellations,
  idx,
}: {
  data: WorldData;
  constellations: Constellations;
  idx: number;
}) {
  const e = data.entities[idx];
  const st = useWorld.getState();
  const edges = useMemo(() => {
    const byId = new Map(data.entities.map((en) => [en.id, en.idx]));
    return constellations.edges
      .filter((ed) => ed.s === e.id || ed.t === e.id)
      .map((ed) => ({
        other: ed.s === e.id ? ed.t : ed.s,
        otherIdx: byId.get(ed.s === e.id ? ed.t : ed.s),
        w: ed.w,
        desc: ed.desc,
      }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 8);
  }, [constellations, data, e.id]);

  return (
    <div className="space-y-3">
      <p className="text-[10px] tracking-[0.3em] uppercase" style={{ color: e.color }}>
        {e.type || "entity"} · constellation
      </p>
      <h2 className="font-display text-lg leading-snug text-ink">{e.id}</h2>
      {e.desc && (
        <p className="line-clamp-[8] text-[11px] leading-relaxed text-ink-3">{e.desc}</p>
      )}
      <p className="text-[11px] text-ink-3">
        {e.deg} relations · {e.members.length} passages
        {e.minYear ? ` · first appears ${e.minYear}` : ""}
      </p>
      <div className="flex flex-wrap gap-1.5 border-t hairline pt-3">
        <Action
          onClick={() => {
            const v = e.ground.clone().lerp(e.space, uMorph.value);
            st.requestWarp([v.x, v.y, v.z], 14, 1.7);
          }}
        >
          fly
        </Action>
        <Action onClick={() => sendEndpoint("A", { kind: "phrase", text: e.id })}>
          bridge from
        </Action>
        <Action
          accent="#e66767"
          onClick={() => sendEndpoint("B", { kind: "phrase", text: e.id })}
        >
          bridge to
        </Action>
      </div>
      {edges.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-2">Strongest relations</p>
          <ul className="mt-1 space-y-0.5">
            {edges.map((ed) => (
              <li key={ed.other}>
                <button
                  type="button"
                  disabled={ed.otherIdx === undefined}
                  title={ed.desc}
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink disabled:opacity-50"
                  onClick={() =>
                    ed.otherIdx !== undefined &&
                    st.select({ kind: "entity", idx: ed.otherIdx })
                  }
                >
                  <span className="tabular-nums text-ink-3">{ed.w.toFixed(0)}</span>{" "}
                  <span className="line-clamp-1 inline">{ed.other}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------------- author ---------------- */

function AuthorCard({
  corpus,
  authors,
  idx,
}: {
  corpus: CorpusData;
  authors: AuthorRec[];
  idx: number;
}) {
  const a = authors[idx];
  const st = useWorld.getState();
  const router = useRouter();
  const papers = useMemo(
    () =>
      [...a.papers].sort(
        (x, y) => (corpus.papers[x].year || 3000) - (corpus.papers[y].year || 3000),
      ),
    [a, corpus],
  );
  const years = papers
    .map((i) => corpus.papers[i].year)
    .filter((y) => y > 0);

  // the chat's author persona is keyed by the papers.json first-author string —
  // use the exact string of a paper this author led, else fall back to family
  const chatAuthor = useMemo(() => {
    for (const p of a.papers) {
      const s = corpus.papers[p].authors;
      if (s && s.split(/[,;&]/)[0]?.trim().startsWith(a.family)) return s;
    }
    return a.family;
  }, [a, corpus]);

  return (
    <div className="space-y-3">
      <p className="text-[10px] tracking-[0.3em] text-[#ffd27a] uppercase">author</p>
      <h2 className="font-display text-lg leading-snug text-ink">{a.name}</h2>
      <p className="text-[11px] text-ink-3">
        {a.papers.length} paper{a.papers.length === 1 ? "" : "s"} in the corpus
        {years.length > 1 ? ` · ${Math.min(...years)}–${Math.max(...years)}` : ""}
        {" · "}their gold trail runs through the papers below — click a dot to
        open one
      </p>
      <div className="flex flex-wrap gap-1.5 border-t hairline pt-3">
        <Action
          accent="#008300"
          onClick={() =>
            router.push(`/chat/${generateUUID()}?author=${encodeURIComponent(chatAuthor)}`)
          }
        >
          talk to author
        </Action>
        <Action onClick={() => sendEndpoint("A", { kind: "authorRec", rec: a })}>
          bridge from
        </Action>
        <Action
          accent="#e66767"
          onClick={() => sendEndpoint("B", { kind: "authorRec", rec: a })}
        >
          bridge to
        </Action>
      </div>
      <div>
        <p className="text-[11px] text-ink-2">Papers, in order</p>
        <ul className="mt-1 space-y-0.5">
          {papers.map((pi) => {
            const p = corpus.papers[pi];
            return (
              <li key={p.file}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                  onClick={() => st.select({ kind: "paper", idx: pi })}
                >
                  <span className="tabular-nums text-ink-3">{p.year || "—"}</span>{" "}
                  <span className="line-clamp-1 inline">{p.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ---------------- ghost ---------------- */

function GhostCard({ corpus, id }: { corpus: CorpusData; id: string }) {
  const ghosts = useWorld((s) => s.ghosts);
  const removeGhost = useWorld((s) => s.removeGhost);
  const select = useWorld((s) => s.select);

  let ghost: GhostPaper | null = null;
  let neighbors: string[] = [];
  let planted = false;
  let busy = false;
  let error: string | undefined;
  let echoScore: number | null = null;

  const g = ghosts.find((x) => x.id === id);
  if (g) {
    planted = true;
    ghost = g.ghost;
    neighbors = g.neighbors;
    busy = !g.ghost && !g.error;
    error = g.error;
    if (g.echo?.length) {
      echoScore = g.echo.reduce((s, h) => s + h.score, 0) / g.echo.length;
    }
  }

  return (
    <div className="space-y-3">
      <p
        className="text-[10px] tracking-[0.3em] uppercase"
        style={{ color: VOID_VIOLET }}
      >
        research gap · AI-proposed paper
      </p>
      {busy && (
        <p className="pulse-soft font-display text-lg text-ink-2">
          drafting a proposal for this gap…
        </p>
      )}
      {error && <p className="text-[11px] text-[#fab219]">{error}</p>}
      {ghost && (
        <>
          <h2 className="font-display text-lg leading-snug text-ink">{ghost.title}</h2>
          <div className="flex flex-wrap gap-1">
            <Chip>{ghost.fields}</Chip>
          </div>
          <p className="text-xs leading-relaxed text-ink-3">
            <span className="text-ink-2">Methods it would use: </span>
            {ghost.methods}
          </p>
          <p className="text-xs leading-relaxed text-ink-2">{ghost.abstract}</p>
          <p className="rounded-md border hairline p-2 text-[11px] leading-relaxed text-ink-3">
            Generated, not real — a brainstorming aid for what's missing here.
            {echoScore !== null && (
              <>
                {" "}
                The bright marker shows where this abstract actually embeds
                (mean similarity {echoScore.toFixed(2)} to the nearest real
                passages) — the closer it sits to your spot, the truer the gap.
              </>
            )}
          </p>
        </>
      )}
      {neighbors.length > 0 && (
        <div>
          <p className="text-xs text-ink-2">The surrounding literature</p>
          <ul className="mt-1 space-y-0.5">
            {neighbors.slice(0, 6).map((n) => {
              const paperIdx = corpus.papers.findIndex((p) => p.title === n);
              return (
                <li key={n}>
                  <button
                    type="button"
                    disabled={paperIdx < 0}
                    className="w-full rounded px-1.5 py-1 text-left text-xs text-ink-3 hover:bg-white/5 hover:text-ink disabled:hover:bg-transparent"
                    onClick={() =>
                      paperIdx >= 0 && select({ kind: "paper", idx: paperIdx })
                    }
                  >
                    <span className="line-clamp-2">· {n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {planted && (
        <button
          type="button"
          className="w-full rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase hover:text-ink"
          onClick={() => {
            removeGhost(id);
            useWorld.getState().select(null);
          }}
        >
          remove
        </button>
      )}
    </div>
  );
}
