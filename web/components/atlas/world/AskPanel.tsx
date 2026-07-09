"use client";

import { useEffect, useState } from "react";
import * as THREE from "three";
import type { CorpusData } from "@/lib/atlas/types";
import { paperWorldPos } from "./PaperBeacons";
import type { WorldData } from "./derive";
import { fitPointsWarp } from "./fit";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * Ask the Atlas: the answer card for a "?" question from the command bar.
 * The RAG engine (the same one behind the chat) synthesizes an answer from
 * the corpus; every cited paper lights up gold on the map, and the tour
 * button flies the camera through the evidence, paper by paper — the
 * inspector card doubles as each stop's caption.
 */

const ASK_BLUE = "#3987e5";
const TOUR_DWELL_MS = 4200;

export default function AskPanel({
  data,
  corpus,
}: {
  data: WorldData;
  corpus: CorpusData;
}) {
  const ask = useWorld((s) => s.ask);
  const set = useWorld((s) => s.set);
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);
  const [tour, setTour] = useState<number | null>(null);

  const located = ask?.refs.filter((r) => r.paperIdx >= 0) ?? [];

  // the guided evidence tour: warp + select each cited paper in turn
  useEffect(() => {
    if (tour === null) return;
    if (!ask || ask.status !== "done" || tour >= located.length) {
      setTour(null);
      return;
    }
    const ref = located[tour];
    select({ kind: "paper", idx: ref.paperIdx });
    const v = paperWorldPos(data, ref.paperIdx, uMorph.value, new THREE.Vector3());
    requestWarp([v.x, v.y, v.z], 11, 1.9);
    const t = setTimeout(
      () => setTour(tour + 1 < located.length ? tour + 1 : null),
      TOUR_DWELL_MS,
    );
    return () => clearTimeout(t);
    // located is derived from ask — depending on ask covers it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, ask, data]);

  // Esc (the world-wide clear) also ends a running tour
  useEffect(() => {
    const onEsc = () => setTour(null);
    window.addEventListener("world:esc", onEsc);
    return () => window.removeEventListener("world:esc", onEsc);
  }, []);

  const flyToAll = () => {
    const pts = located.map((r) =>
      paperWorldPos(data, r.paperIdx, uMorph.value, new THREE.Vector3()),
    );
    if (pts.length) fitPointsWarp(pts, 2.2);
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
          Ask the atlas
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Ask the corpus a question and the RAG engine answers from the papers
          themselves. Every source it cites{" "}
          <span className="text-ink-2">lights up gold on the map</span>, so you
          can see where in the literature the answer was assembled from.
        </p>
      </div>

      {!ask && (
        <p className="rounded-md border hairline p-2.5 text-[11px] leading-relaxed text-ink-3">
          Type a question in the search bar — start with{" "}
          <code className="text-ink-2">?</code> or just end with one:{" "}
          <code className="text-ink-2">what predicts humor ratings?</code>
        </p>
      )}

      {ask?.status === "running" && (
        <div>
          <p className="text-xs leading-snug text-ink">{ask.question}</p>
          <p className="pulse-soft mt-2 text-[11px] tracking-[0.25em] text-[#3987e5] uppercase">
            reading the corpus…
          </p>
          <p className="mt-1 text-[10px] text-ink-3">
            retrieval + synthesis can take up to a minute
          </p>
        </div>
      )}

      {ask?.status === "error" && (
        <div>
          <p className="text-xs leading-snug text-ink">{ask.question}</p>
          <p className="mt-2 text-[11px] text-[#fab219]">{ask.error}</p>
        </div>
      )}

      {ask?.status === "done" && (
        <>
          <p className="text-xs leading-snug text-ink">{ask.question}</p>
          <div className="max-h-[34vh] overflow-y-auto rounded-md border hairline p-2.5 text-[11px] leading-relaxed whitespace-pre-line text-ink-2 hud-scroll">
            {ask.answer}
          </div>

          {ask.refs.length > 0 && (
            <div>
              <div className="flex items-baseline justify-between">
                <p className="text-[11px] text-ink-2">
                  Evidence · {ask.refs.length} paper
                  {ask.refs.length === 1 ? "" : "s"} cited
                </p>
                {located.length > 0 && (
                  <button
                    type="button"
                    className="text-[10px] text-ink-3 underline decoration-dotted hover:text-ink"
                    onClick={flyToAll}
                  >
                    frame all
                  </button>
                )}
              </div>
              <ul className="mt-1 space-y-0.5">
                {ask.refs.map((r, i) => {
                  const onTour =
                    tour !== null && located[tour]?.paperIdx === r.paperIdx;
                  return (
                    <li key={`${r.filename}-${i}`}>
                      <button
                        type="button"
                        disabled={r.paperIdx < 0}
                        title={r.apa}
                        className={`w-full rounded px-2 py-1 text-left text-xs transition-colors disabled:opacity-50 ${
                          onTour
                            ? "bg-white/10 text-ink"
                            : "text-ink-2 hover:bg-white/5 hover:text-ink"
                        }`}
                        onClick={() => {
                          setTour(null);
                          select({ kind: "paper", idx: r.paperIdx });
                          const v = paperWorldPos(
                            data,
                            r.paperIdx,
                            uMorph.value,
                            new THREE.Vector3(),
                          );
                          requestWarp([v.x, v.y, v.z], 10, 1.7);
                        }}
                      >
                        <span className="line-clamp-1">
                          {r.intext || r.filename}
                          {r.pages.length > 0 && (
                            <span className="text-ink-3">
                              {" "}
                              · p{r.pages.length > 1 ? "p" : ""}.{" "}
                              {r.pages.join(", ")}
                            </span>
                          )}
                          {r.paperIdx < 0 && (
                            <span className="text-ink-3"> · not in atlas</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            {located.length > 0 && (
              <button
                type="button"
                onClick={() => setTour(tour === null ? 0 : null)}
                className="flex-1 rounded-md border px-3 py-1.5 text-[11px] tracking-widest uppercase transition-colors"
                style={{
                  borderColor: `${ASK_BLUE}99`,
                  color: tour !== null ? "#d03b3b" : ASK_BLUE,
                  ...(tour !== null ? { borderColor: "#d03b3b99" } : {}),
                }}
              >
                {tour !== null
                  ? `stop tour (${tour + 1}/${located.length})`
                  : "tour the evidence"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setTour(null);
                select(null);
                set("ask", null);
              }}
              className="rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase hover:text-ink"
            >
              clear
            </button>
          </div>

          {corpus.papers.length > 0 && located.length === 0 && ask.refs.length > 0 && (
            <p className="text-[10px] leading-relaxed text-ink-3">
              None of the cited files are in this atlas pack, so nothing lights
              up — the answer still stands.
            </p>
          )}
        </>
      )}

      <p className="border-t hairline pt-3 text-[10px] leading-relaxed text-ink-3">
        Shortcut: any search ending in <code className="text-ink-2">?</code>{" "}
        becomes a question. Answers cite in APA; click a citation to inspect
        the paper.
      </p>
    </div>
  );
}
