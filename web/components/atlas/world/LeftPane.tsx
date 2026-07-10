"use client";

import { useMemo, useState } from "react";
import {
  CircleDashed,
  Clock,
  Compass,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plane,
  Radio,
  RotateCcw,
  Shuffle,
  SkipForward,
  SlidersHorizontal,
  Spline,
  Trophy,
} from "lucide-react";
import { qsearch } from "@/lib/atlas/api";
import type { AuthorRec, CorpusData, PaperMeta } from "@/lib/atlas/types";
import { buildStation } from "./walk";
import { primePlaneAudio } from "./planeAudio";
import { primeVoices } from "./tts";
import {
  AGE_MID,
  AGE_NEW,
  AGE_OLD,
  sampleField,
  toWorldXZ,
  type WorldData,
} from "./derive";
import { fitAuthorTrail } from "./fit";
import AskPanel from "./AskPanel";
import DraftPanel from "./DraftPanel";
import GamePanel from "./GamePanel";
import InterpolatePanel from "./InterpolatePanel";
import { useWorld, warpHome, type Instrument } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";
import { VOID_VIOLET } from "./GhostLayer";

/**
 * The instrument pane: every capability of the world, one floating panel on
 * the left. A vertical rail picks the instrument; the panel hosts its
 * controls. Scenes render underneath — the pane is chrome, never a page.
 */

const INSTRUMENTS: { key: Instrument; icon: React.ReactNode; label: string }[] = [
  { key: "navigate", icon: <Compass className="size-4" />, label: "Navigate" },
  {
    key: "ask",
    icon: <MessageCircleQuestion className="size-4" />,
    label: "Ask the atlas",
  },
  { key: "time", icon: <Clock className="size-4" />, label: "Time machine" },
  { key: "lenses", icon: <SlidersHorizontal className="size-4" />, label: "Lenses" },
  { key: "interpolate", icon: <Spline className="size-4" />, label: "Interpolate" },
  { key: "ghosts", icon: <CircleDashed className="size-4" />, label: "Research gaps" },
  { key: "draft", icon: <PenLine className="size-4" />, label: "Drop a draft" },
  { key: "radio", icon: <Radio className="size-4" />, label: "Radio" },
  { key: "plane", icon: <Plane className="size-4" />, label: "Boeing 747" },
  { key: "game", icon: <Trophy className="size-4" />, label: "Semantle" },
];

export default function LeftPane({
  data,
  corpus,
  authors,
  paperMeta,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
  paperMeta: PaperMeta | null;
}) {
  const instrument = useWorld((s) => s.instrument);
  const setInstrument = useWorld((s) => s.setInstrument);
  const paneOpen = useWorld((s) => s.paneOpen);
  const set = useWorld((s) => s.set);
  const planeOn = useWorld((s) => s.planeOn);

  // cockpit mode: while the 747 flies, the world is the whole interface
  if (planeOn) return null;

  return (
    <div className="pointer-events-none absolute top-20 bottom-20 left-4 z-40 flex items-start gap-2">
      <nav className="hud-panel pointer-events-auto flex flex-col gap-1 p-1.5">
        {INSTRUMENTS.map((it) => (
          <button
            key={it.key}
            type="button"
            title={it.label}
            onClick={() => {
              if (instrument === it.key && paneOpen) set("paneOpen", false);
              else setInstrument(it.key);
            }}
            className={`rounded-md p-2 transition-colors ${
              instrument === it.key && paneOpen
                ? "bg-white/10 text-ink"
                : "text-ink-3 hover:bg-white/5 hover:text-ink-2"
            }`}
          >
            {it.icon}
          </button>
        ))}
        <div className="mx-1 my-1 border-t hairline" />
        <button
          type="button"
          title="Reset camera"
          onClick={() => {
            useWorld.getState().set("autoRotate", true);
            warpHome(1.3);
          }}
          className="rounded-md p-2 text-ink-3 transition-colors hover:bg-white/5 hover:text-ink-2"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          title={paneOpen ? "Collapse" : "Expand"}
          onClick={() => set("paneOpen", !paneOpen)}
          className="rounded-md p-2 text-ink-3 transition-colors hover:bg-white/5 hover:text-ink-2"
        >
          {paneOpen ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </button>
      </nav>

      {paneOpen && (
        <section
          className={`hud-panel hud-scroll pointer-events-auto max-h-full overflow-y-auto p-4 ${
            instrument === "ask" ? "w-[360px]" : "w-[292px]"
          }`}
        >
          {instrument === "navigate" && <NavigatePanel data={data} corpus={corpus} />}
          {instrument === "ask" && <AskPanel data={data} corpus={corpus} />}
          {instrument === "time" && <TimePanel />}
          {instrument === "lenses" && (
            <LensesPanel
              data={data}
              corpus={corpus}
              authors={authors}
              paperMeta={paperMeta}
            />
          )}
          {instrument === "interpolate" && (
            <InterpolatePanel data={data} corpus={corpus} authors={authors} />
          )}
          {instrument === "ghosts" && <GhostsPanel data={data} />}
          {instrument === "draft" && <DraftPanel data={data} corpus={corpus} />}
          {instrument === "radio" && <RadioPanel data={data} corpus={corpus} />}
          {instrument === "plane" && <PlanePanel />}
          {instrument === "game" && <GamePanel data={data} authors={authors} />}
        </section>
      )}
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">{children}</p>
  );
}

/* ---------------- navigate ---------------- */

function NavigatePanel({ data, corpus }: { data: WorldData; corpus: CorpusData }) {
  const view = useWorld((s) => s.view);
  const setView = useWorld((s) => s.setView);
  const showSky = useWorld((s) => s.showSky);
  const showWeb = useWorld((s) => s.showWeb);
  const showLabels = useWorld((s) => s.showLabels);
  const set = useWorld((s) => s.set);
  const requestWarp = useWorld((s) => s.requestWarp);

  return (
    <div className="space-y-4">
      <div>
        <H>World</H>
        <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-lg border hairline text-center text-xs">
          {(
            [
              ["atlas", "Landscape"],
              ["space", "Galaxy"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`py-1.5 transition-colors ${
                view === v ? "bg-white/10 text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "atlas" ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            Every passage of every paper is embedded by the language model, then
            flattened onto this map —{" "}
            <span className="text-ink-2">nearby means similar in meaning</span>.{" "}
            <span className="text-ink-2">Height counts passages</span>:
            mountains rise where many passages pile onto the same idea; empty
            areas are unexplored.{" "}
            <span className="text-ink-2">Color marks the semantic region</span>{" "}
            — passages in the same topic cluster share a hue. The small lights
            are individual passages (brighter = more connections in the
            knowledge graph); the haloed beacons are whole papers, placed at
            the center of their passages.{" "}
            <span className="text-ink-2">Peak names</span> come from the corpus
            itself — the paper or knowledge-graph concept that dominates each
            summit.
          </p>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">
              The passages in raw 3D semantic space —{" "}
              <span className="text-ink-2">closeness means related meaning</span>.
              Small stars are passages; brighter = more connections in the
              knowledge graph, and{" "}
              <span className="text-ink-2">colors show publication age</span>.
              The spiked stars are{" "}
              <span className="text-ink-2">knowledge-graph entities</span> —
              concepts, methods, and theories — colored by their type and
              placed at the center of the passages that mention them.
              Constellation lines connect an entity's passages together; the
              fainter web joins entities the graph relates. The floating name
              tags are those entities' names, exactly as the knowledge graph
              recorded them while reading the papers.
            </p>
            <div className="mt-2.5">
              <div
                className="h-1.5 rounded-full"
                style={{
                  background: `linear-gradient(90deg, ${AGE_OLD}, ${AGE_MID}, ${AGE_NEW})`,
                }}
              />
              <div className="mt-1 flex justify-between text-[10px] text-ink-3">
                <span>{data.yearMin}</span>
                <span>publication year</span>
                <span>{data.yearMax}</span>
              </div>
            </div>
          </>
        )}
      </div>

      <div>
        <H>Fly to a region</H>
        <select
          className="mt-2 w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none"
          defaultValue=""
          onChange={(e) => {
            const cl = data.labelClusters.find(
              (c) => c.cluster.id === Number(e.target.value),
            );
            if (!cl) return;
            const p = cl.ground.clone().lerp(cl.space, uMorph.value);
            requestWarp([p.x, p.y, p.z], 36, 2.1);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            {data.labelClusters.length} named regions…
          </option>
          {data.labelClusters.map(({ cluster }) => (
            <option key={cluster.id} value={cluster.id} className="bg-[#1a1a19]">
              {cluster.name} · {cluster.nPapers}
            </option>
          ))}
        </select>
      </div>

      <div>
        <H>Layers</H>
        <div className="mt-2 space-y-1.5 text-xs text-ink-2">
          {(
            view === "space"
              ? ([
                  ["constellations", "showSky", showSky],
                  ["concept web", "showWeb", showWeb],
                  ["labels", "showLabels", showLabels],
                ] as const)
              : ([["labels", "showLabels", showLabels]] as const)
          ).map(([label, key, on]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={on}
                onChange={() => set(key, !on)}
                className="h-3 w-3 accent-[#3987e5]"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <p className="border-t hairline pt-3 text-[11px] leading-relaxed text-ink-3">
        {corpus.papers.length.toLocaleString()} papers ·{" "}
        {data.n.toLocaleString()} passages · {data.entities.length} constellations
      </p>
    </div>
  );
}

/* ---------------- time machine ---------------- */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Fractional year → display. Tight corpora get month-level readouts. */
function formatFracYear(frac: number, span: number): string {
  const y = Math.floor(frac);
  if (span > 25) return String(y);
  const m = Math.min(11, Math.max(0, Math.floor((frac - y) * 12)));
  return `${MONTH_NAMES[m]} ${y}`;
}

function TimePanel() {
  const year = useWorld((s) => s.year);
  const yearLo = useWorld((s) => s.yearLo);
  const yearMin = useWorld((s) => s.yearMin);
  const yearMax = useWorld((s) => s.yearMax);
  const timePlaying = useWorld((s) => s.timePlaying);
  const set = useWorld((s) => s.set);
  const now = year > yearMax;
  const span = yearMax + 1 - yearMin;

  return (
    <div className="space-y-4">
      <div>
        <H>Time machine</H>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Scrub the field's history: the terrain regrows as literatures
          accumulate, newborn papers flash white-hot, constellations ignite
          when their concept first appears. Publication dates are month-exact
          where the metadata knows them.
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <span className="font-display text-3xl text-ink">
            {now ? "present" : formatFracYear(year, span)}
          </span>
          {yearLo > 0 && (
            <button
              type="button"
              className="text-[11px] text-ink-3 underline decoration-dotted"
              onClick={() => set("yearLo", 0)}
            >
              from {yearLo} ✕
            </button>
          )}
        </div>
        <input
          type="range"
          min={yearMin}
          max={yearMax + 1}
          step={span > 25 ? 0.25 : 1 / 24}
          value={year}
          onChange={(e) => {
            set("timePlaying", false);
            set("year", Number(e.target.value));
          }}
          className="mt-2 w-full accent-[#3987e5]"
        />
        <div className="flex justify-between text-[10px] text-ink-3">
          <span>{yearMin}</span>
          <span>now</span>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            if (timePlaying) {
              set("timePlaying", false);
            } else {
              if (year > yearMax) set("year", yearMin);
              set("timePlaying", true);
            }
          }}
          className="flex-1 rounded-md border border-[#3987e5]/60 px-3 py-1.5 text-[11px] tracking-widest text-[#3987e5] uppercase"
        >
          {timePlaying ? "pause" : "play the years"}
        </button>
        <button
          type="button"
          onClick={() => {
            set("timePlaying", false);
            set("year", yearMax + 1);
            set("yearLo", 0);
          }}
          className="rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase"
        >
          now
        </button>
      </div>

      <p className="text-[10px] text-ink-3">
        Tip: type <code className="text-ink-2">year:1990..2005</code> in the
        command bar for a window.
      </p>
    </div>
  );
}

/* ---------------- lenses ---------------- */

function LensesPanel({
  data,
  corpus,
  authors,
  paperMeta,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
  paperMeta: PaperMeta | null;
}) {
  const lens = useWorld((s) => s.lens);
  const setLens = useWorld((s) => s.setLens);
  const clearLens = useWorld((s) => s.clearLens);
  const select = useWorld((s) => s.select);
  const [authorQuery, setAuthorQuery] = useState("");

  const journals = useMemo(() => {
    const s = new Set<string>();
    for (const p of corpus.papers) if (p.journal) s.add(p.journal);
    return [...s].sort();
  }, [corpus]);

  const authorMatches = useMemo(() => {
    const q = authorQuery.trim().toLowerCase();
    if (!q) return [];
    return authors
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.name.toLowerCase().includes(q))
      .slice(0, 10);
  }, [authors, authorQuery]);

  const active = lens.author !== null || lens.journal || lens.keyword;

  const matchCount = useMemo(() => {
    const { author, journal, keyword } = lens;
    if (author === null && !journal && !keyword) return null;
    const authorSet = author !== null ? new Set(authors[author]?.papers ?? []) : null;
    const j = journal?.toLowerCase() ?? null;
    const terms = (keyword?.toLowerCase() ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean);
    let n = 0;
    corpus.papers.forEach((p, i) => {
      if (authorSet && !authorSet.has(i)) return;
      if (j && !p.journal.toLowerCase().includes(j)) return;
      if (terms.length) {
        const hay = [
          p.title,
          p.abstract,
          ...(paperMeta?.keywords[i] ?? []),
          ...(paperMeta?.subjects[i] ?? []),
        ]
          .join(" | ")
          .toLowerCase();
        if (!terms.some((t) => hay.includes(t))) return;
      }
      n++;
    });
    return n;
  }, [lens, corpus, authors, paperMeta]);

  return (
    <div className="space-y-4">
      <div>
        <H>Lenses</H>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Filter the world by its metadata — matching papers pulse gold, the
          rest of the world steps back. Lenses clear when you leave this menu.
        </p>
        {matchCount !== null && (
          <p className="mt-2 rounded-md border border-[#ffd27a]/40 px-2 py-1 text-[11px] text-[#ffd27a]">
            {matchCount} paper{matchCount === 1 ? "" : "s"} in the lens
          </p>
        )}
      </div>

      <div>
        <p className="text-[11px] text-ink-2">Author</p>
        {lens.author !== null ? (
          <div className="mt-1 flex items-center justify-between rounded-md border border-[#ffd27a]/50 px-2 py-1.5">
            <button
              type="button"
              className="text-xs text-[#ffd27a]"
              onClick={() => select({ kind: "author", idx: lens.author! })}
            >
              {authors[lens.author]?.name}
            </button>
            <button
              type="button"
              className="text-ink-3 hover:text-ink"
              onClick={() => setLens({ author: null })}
            >
              ✕
            </button>
          </div>
        ) : (
          <>
            <input
              value={authorQuery}
              onChange={(e) => setAuthorQuery(e.target.value)}
              placeholder={`${authors.length} authors…`}
              className="mt-1 w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
            />
            {authorMatches.length > 0 && (
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                {authorMatches.map(({ a, i }) => (
                  <li key={a.name}>
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                      onClick={() => {
                        setLens({ author: i });
                        setAuthorQuery("");
                        select({ kind: "author", idx: i });
                        fitAuthorTrail(data, a); // frame the whole trail
                      }}
                    >
                      {a.name}{" "}
                      <span className="text-ink-3">· {a.papers.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div>
        <p className="text-[11px] text-ink-2">Journal</p>
        <input
          list="world-journals"
          value={lens.journal ?? ""}
          onChange={(e) => setLens({ journal: e.target.value || null })}
          placeholder={`${journals.length} journals…`}
          className="mt-1 w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
        <datalist id="world-journals">
          {journals.map((j) => (
            <option key={j} value={j} />
          ))}
        </datalist>
      </div>

      <div>
        <p className="text-[11px] text-ink-2">
          Keyword {paperMeta ? "· titles, abstracts, APA keywords/subjects" : ""}
        </p>
        <input
          value={lens.keyword ?? ""}
          onChange={(e) => setLens({ keyword: e.target.value || null })}
          placeholder="entropy, humor, fMRI…"
          className="mt-1 w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
        />
      </div>

      {active && (
        <button
          type="button"
          onClick={clearLens}
          className="w-full rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase hover:text-ink"
        >
          clear lenses
        </button>
      )}

      <p className="border-t hairline pt-3 text-[10px] leading-relaxed text-ink-3">
        Shortcuts in the search bar:{" "}
        <code className="text-ink-2">@name</code> for an author,{" "}
        <code className="text-ink-2">journal:cognition</code>,{" "}
        <code className="text-ink-2">kw:entropy</code>,{" "}
        <code className="text-ink-2">year:1990..2005</code> — plain words
        keyword-filter live as you type. Quote a phrase (
        <code className="text-ink-2">"self - attention"</code>) to search text
        that contains + or −. Esc clears everything.
      </p>
    </div>
  );
}

/* ---------------- ghosts ---------------- */

function GhostsPanel({ data }: { data: WorldData }) {
  const planting = useWorld((s) => s.planting);
  const ghosts = useWorld((s) => s.ghosts);
  const set = useWorld((s) => s.set);
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);
  const removeGhost = useWorld((s) => s.removeGhost);

  const flyTo = (x01: number, y01: number) => {
    const [x, z] = toWorldXZ(x01, y01);
    const y = sampleField(data.eras.final, x01, y01) * HEIGHT_SCALE;
    useWorld.getState().setView("atlas");
    requestWarp([x, y + 2, z], 26, 2.0);
  };

  return (
    <div className="space-y-4">
      <div>
        <H>Research gaps</H>
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          A brainstorming tool for what's missing from the literature.{" "}
          <span className="text-ink">Click any spot on the map</span> —
          especially the dark, empty regions between fields — and the AI drafts
          the paper that would live there: a concrete proposal built from the
          surrounding work. A bright marker then shows where that proposal
          actually embeds, so you can judge how real the gap is.
        </p>
      </div>

      <button
        type="button"
        onClick={() => set("planting", !planting)}
        className={`w-full rounded-md border px-3 py-2 text-xs tracking-widest uppercase transition-colors ${
          planting
            ? "border-[#c98500] text-[#c98500]"
            : "border-[#9085e9]/60 text-[#9085e9]"
        }`}
      >
        {planting ? "now click a spot on the map (esc to cancel)" : "pick a spot"}
      </button>

      <p className="text-[10px] leading-relaxed text-ink-3">
        Shortcut: type <code className="text-ink-2">/gap</code> in the search bar
        to arm the picker from anywhere.
      </p>

      {ghosts.length > 0 && (
        <div>
          <p className="text-xs text-ink-2">Proposed papers</p>
          <ul className="mt-1 space-y-0.5">
            {ghosts.map((g) => (
              <li key={g.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                  onClick={() => {
                    select({ kind: "ghost", id: g.id });
                    flyTo(g.x01, g.y01);
                  }}
                >
                  <span style={{ color: g.ghost ? VOID_VIOLET : "#c98500" }}>
                    {g.ghost ? "◆" : "◇"}
                  </span>{" "}
                  <span className="line-clamp-1 inline">
                    {g.ghost?.title ?? (g.error ? "generation failed" : "drafting…")}
                  </span>
                </button>
                <button
                  type="button"
                  className="shrink-0 px-1 text-ink-3 hover:text-ink"
                  title="Remove"
                  onClick={() => removeGhost(g.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------------- radio ---------------- */

function RadioPanel({ data, corpus }: { data: WorldData; corpus: CorpusData }) {
  const radioOn = useWorld((s) => s.radioOn);
  const radioMuted = useWorld((s) => s.radioMuted);
  const radioRate = useWorld((s) => s.radioRate);
  const radioFollow = useWorld((s) => s.radioFollow);
  const radioBias = useWorld((s) => s.radioBias);
  const radioStation = useWorld((s) => s.radioStation);
  const radioIdx = useWorld((s) => s.radioIdx);
  const radioSentence = useWorld((s) => s.radioSentence);
  const set = useWorld((s) => s.set);
  const [stationQuery, setStationQuery] = useState("");
  const [tuning, setTuning] = useState(false);

  const chunkIndex = useMemo(() => data.chunkIdToIdx, [data]);

  const nowPaper = radioIdx !== null ? corpus.papers[corpus.atlas.paper[radioIdx]] : null;
  const nowSection = radioIdx !== null ? corpus.atlas.section[radioIdx] : "";

  const tune = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = stationQuery.trim();
    if (!q || tuning) return;
    setTuning(true);
    try {
      const hits = await qsearch({ text: q, limit: 24 });
      const station = buildStation(q, hits, chunkIndex, corpus.atlas);
      if (station) {
        set("radioStation", station);
        if (useWorld.getState().radioBias === 0) set("radioBias", 0.8);
      }
    } catch {
      /* tuner static */
    } finally {
      setTuning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <H>Radio</H>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          A slow random walk over the passage graph, read aloud as a rover
          driving the landscape. Tune a station to drift toward (or away from)
          a topic. Leave it on.
        </p>
      </div>

      <button
        type="button"
        onClick={() => {
          primeVoices(); // unlock speech inside the user gesture
          set("radioOn", !radioOn);
        }}
        className={`w-full rounded-md border px-3 py-2 text-[11px] tracking-widest uppercase transition-colors ${
          radioOn
            ? "border-[#d03b3b] text-[#d03b3b]"
            : "border-[#d55181]/70 text-[#d55181]"
        }`}
      >
        {radioOn ? "◼ power off" : "▶ power on"}
      </button>

      <form onSubmit={tune}>
        <p className="text-[11px] text-ink-2">Station</p>
        <div className="mt-1 flex gap-1.5">
          <input
            value={stationQuery}
            onChange={(e) => setStationQuery(e.target.value)}
            placeholder={radioStation ? `tuned: ${radioStation.query}` : "a topic…"}
            className="min-w-0 flex-1 rounded-md border border-ink-3/70 bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
          />
          <button
            type="submit"
            disabled={tuning || !stationQuery.trim()}
            className="shrink-0 rounded-md border border-[#d55181]/60 px-2.5 text-[10px] tracking-widest text-[#d55181] uppercase disabled:opacity-30"
          >
            {tuning ? "…" : "tune"}
          </button>
        </div>
        {radioStation && (
          <button
            type="button"
            className="mt-1 text-[10px] text-ink-3 underline decoration-dotted"
            onClick={() => {
              set("radioStation", null);
              set("radioBias", 0);
            }}
          >
            detune “{radioStation.query}” ✕
          </button>
        )}
      </form>

      <div>
        <div className="flex justify-between text-[10px] text-ink-3">
          <span>drift away</span>
          <span>toward</span>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={radioBias}
          disabled={!radioStation}
          onChange={(e) => set("radioBias", Number(e.target.value))}
          className="w-full accent-[#d55181] disabled:opacity-30"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!radioOn}
          onClick={() => window.dispatchEvent(new Event("world:radio-skip"))}
          className="flex-1 rounded-md border border-current px-2 py-1.5 text-[11px] tracking-widest text-ink-2 uppercase disabled:opacity-30"
        >
          <SkipForward className="mr-1 inline size-3" />
          skip
        </button>
        <button
          type="button"
          disabled={!radioOn}
          onClick={() => window.dispatchEvent(new Event("world:radio-random"))}
          className="flex-1 rounded-md border border-current px-2 py-1.5 text-[11px] tracking-widest text-ink-2 uppercase disabled:opacity-30"
        >
          <Shuffle className="mr-1 inline size-3" />
          random
        </button>
      </div>

      <div>
        <div className="flex justify-between text-[10px] text-ink-3">
          <span>voice speed</span>
          <span>{radioRate.toFixed(1)}×</span>
        </div>
        <input
          type="range"
          min={0.6}
          max={1.8}
          step={0.1}
          value={radioRate}
          onChange={(e) => set("radioRate", Number(e.target.value))}
          className="w-full accent-[#d55181]"
        />
      </div>

      <div className="flex gap-4 text-xs text-ink-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={radioFollow}
            onChange={() => set("radioFollow", !radioFollow)}
            className="h-3 w-3 accent-[#d55181]"
          />
          camera follows
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={radioMuted}
            onChange={() => set("radioMuted", !radioMuted)}
            className="h-3 w-3 accent-[#d55181]"
          />
          mute
        </label>
      </div>

      <p className="text-[10px] leading-relaxed text-ink-3">
        Shortcut: type <code className="text-ink-2">/radio</code> in the search
        bar to toggle the power from anywhere.
      </p>

      {radioOn && nowPaper && (
        <div className="rounded-md border hairline p-2.5">
          <p className="text-[10px] tracking-[0.25em] text-ink-3 uppercase">
            on air {nowSection && nowSection !== "Untitled" ? `· ${nowSection}` : ""}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-ink">{nowPaper.title}</p>
          <p className="mt-1 text-[11px] text-ink-3">
            {nowPaper.authors} ({nowPaper.year || "n.d."})
          </p>
          {radioSentence && (
            <p className="mt-2 border-t hairline pt-2 text-[11px] leading-relaxed text-ink-2">
              {radioSentence}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- the 747 ---------------- */

function PlanePanel() {
  const planeOn = useWorld((s) => s.planeOn);
  const planeFollow = useWorld((s) => s.planeFollow);
  const planeSound = useWorld((s) => s.planeSound);
  const set = useWorld((s) => s.set);
  const setView = useWorld((s) => s.setView);

  return (
    <div className="space-y-4">
      <div>
        <H>Boeing 747</H>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Spawn a jumbo jet over the landscape and fly it yourself. Put it into
          a mountainside and the fireball opens the nearest paper&apos;s card —
          literature review by air disaster.
        </p>
      </div>

      <button
        type="button"
        onClick={() => {
          if (planeOn) {
            set("planeOn", false);
            set("autoRotate", true);
            warpHome(1.4);
          } else {
            primePlaneAudio(); // unlock WebAudio inside the user gesture
            setView("atlas"); // the runway is the landscape, not the galaxy
            set("autoRotate", false);
            set("planeOn", true);
          }
        }}
        className={`w-full rounded-md border px-3 py-2 text-[11px] tracking-widest uppercase transition-colors ${
          planeOn
            ? "border-[#d03b3b] text-[#d03b3b]"
            : "border-[#3987e5]/70 text-[#3987e5]"
        }`}
      >
        {planeOn ? "◼ eject" : "✈ take off"}
      </button>

      <div className="flex gap-4 text-xs text-ink-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={planeFollow}
            onChange={() => set("planeFollow", !planeFollow)}
            className="h-3 w-3 accent-[#3987e5]"
          />
          chase camera
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={planeSound}
            onChange={() => set("planeSound", !planeSound)}
            className="h-3 w-3 accent-[#3987e5]"
          />
          sound
        </label>
      </div>

      <div>
        <p className="text-[11px] text-ink-2">Controls</p>
        <ul className="mt-1.5 space-y-1 text-[11px] text-ink-3">
          <li>
            <code className="text-ink-2">W / ↑</code> climb ·{" "}
            <code className="text-ink-2">S / ↓</code> dive
          </li>
          <li>
            <code className="text-ink-2">A / ←</code> bank left ·{" "}
            <code className="text-ink-2">D / →</code> bank right
          </li>
          <li>
            <code className="text-ink-2">Q</code> yaw left ·{" "}
            <code className="text-ink-2">E</code> yaw right
          </li>
          <li>
            <code className="text-ink-2">Space</code> throttle up ·{" "}
            <code className="text-ink-2">Shift</code> throttle down
          </li>
          <li>
            <code className="text-ink-2">Esc</code> eject
          </li>
        </ul>
      </div>

      <p className="text-[10px] leading-relaxed text-ink-3">
        Crashing selects the paper beacon nearest the wreck, exactly as
        clicking it would.
      </p>

      <p className="border-t hairline pt-2 text-[10px] leading-relaxed text-ink-3">
        Aircraft:{" "}
        <a
          href="https://sketchfab.com/3d-models/boeing-747-400-4c0c7664e4ea4e248311c8ba93fe3b20"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-ink-2"
        >
          “Boeing 747-400”
        </a>{" "}
        by Jonne Okkonen,{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted hover:text-ink-2"
        >
          CC BY-SA 4.0
        </a>{" "}
        (recompressed).
      </p>
    </div>
  );
}
