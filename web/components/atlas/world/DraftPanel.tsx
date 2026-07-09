"use client";

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { embed, qsearch } from "@/lib/atlas/api";
import type { CorpusData } from "@/lib/atlas/types";
import { paperWorldPos } from "./PaperBeacons";
import { DRAFT_TEAL, draftAnchors } from "./DraftLayer";
import { shortCite, type WorldData } from "./derive";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * Drop a draft: paste your own abstract, paragraph, or working title and see
 * where it lands in the corpus. The text is embedded with the same model as
 * every passage; a teal star marks the landing spot, the nearest papers
 * become an instant related-work list, and the neighborhood tells you whether
 * you're on well-trodden ground or near open space.
 */

export default function DraftPanel({
  data,
  corpus,
}: {
  data: WorldData;
  corpus: CorpusData;
}) {
  const draft = useWorld((s) => s.draft);
  const set = useWorld((s) => s.set);
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);
  const [text, setText] = useState(draft?.text ?? "");

  // Esc (the world-wide clear) empties the composer too
  useEffect(() => {
    const onEsc = () => setText("");
    window.addEventListener("world:esc", onEsc);
    return () => window.removeEventListener("world:esc", onEsc);
  }, []);

  const locate = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || draft?.status === "locating") return;
    set("draft", { text: t, status: "locating", hits: [] });
    try {
      const [vec] = await embed([t], "query");
      const raw = await qsearch({ vector: vec, limit: 24 });
      const seen = new Set<number>();
      const hits: { idx: number; score: number }[] = [];
      for (const h of raw) {
        const idx = data.chunkIdToIdx.get(h.chunkId);
        if (idx === undefined || seen.has(idx)) continue;
        seen.add(idx);
        hits.push({ idx, score: h.score });
      }
      const st = useWorld.getState();
      if (st.draft?.text !== t) return; // superseded by a newer draft
      st.set("draft", { text: t, status: "done", hits });
      const anchors = draftAnchors(data, hits);
      if (anchors) {
        const p = anchors.ground.clone().lerp(anchors.space, uMorph.value);
        st.requestWarp([p.x, p.y, p.z], 30, 2.2);
      }
    } catch (err) {
      const st = useWorld.getState();
      if (st.draft?.text !== t) return;
      st.set("draft", { text: t, status: "error", hits: [], error: String(err) });
    }
  };

  // neighborhood readout: nearest papers, landing cluster, journals, crowding
  const report = useMemo(() => {
    if (!draft || draft.status !== "done" || !draft.hits.length) return null;
    const byPaper = new Map<number, number>();
    const byCluster = new Map<number, number>();
    for (const h of draft.hits) {
      const p = corpus.atlas.paper[h.idx];
      byPaper.set(p, Math.max(byPaper.get(p) ?? 0, h.score));
      const cl = corpus.atlas.cluster[h.idx];
      byCluster.set(cl, (byCluster.get(cl) ?? 0) + 1);
    }
    const papers = [...byPaper.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    let clusterId = -1;
    let clusterCt = 0;
    for (const [cl, ct] of byCluster) {
      if (ct > clusterCt) {
        clusterCt = ct;
        clusterId = cl;
      }
    }
    const cluster = data.clusterById.get(clusterId) ?? null;
    const journals = new Map<string, number>();
    for (const [p] of papers) {
      const j = corpus.papers[p]?.journal;
      if (j) journals.set(j, (journals.get(j) ?? 0) + 1);
    }
    const topJournals = [...journals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([j]) => j);
    const top = draft.hits.slice(0, 5);
    const crowding = top.reduce((s, h) => s + h.score, 0) / top.length;
    return { papers, cluster, topJournals, crowding };
  }, [draft, corpus, data]);

  const crowdingLabel = (c: number) =>
    c >= 0.62
      ? "crowded — this ground is well covered"
      : c >= 0.48
        ? "populated — clear neighbors, room to differ"
        : "open ground — sparse neighbors here";

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
          Drop a draft
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Paste an abstract, a paragraph, or a working title of{" "}
          <span className="text-ink-2">your own writing</span>. It's embedded
          with the same model as the corpus, and a{" "}
          <span style={{ color: DRAFT_TEAL }}>teal star</span> marks where it
          lands — the nearest papers are your related work.
        </p>
      </div>

      <form onSubmit={locate} className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="Your abstract, paragraph, or title…"
          className="w-full resize-y rounded-md border hairline bg-transparent px-2 py-1.5 text-xs leading-relaxed text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="submit"
          disabled={!text.trim() || draft?.status === "locating"}
          className="w-full rounded-md border px-3 py-2 text-[11px] tracking-widest uppercase transition-colors disabled:opacity-30"
          style={{ borderColor: `${DRAFT_TEAL}99`, color: DRAFT_TEAL }}
        >
          {draft?.status === "locating" ? "embedding…" : "locate my draft"}
        </button>
      </form>

      {draft?.status === "error" && (
        <p className="text-[11px] text-[#fab219]">{draft.error}</p>
      )}

      {report && (
        <>
          <div className="rounded-md border hairline p-2.5">
            <p className="text-[11px] leading-relaxed text-ink-2">
              {report.cluster ? (
                <>
                  Lands in{" "}
                  <span style={{ color: DRAFT_TEAL }}>
                    {report.cluster.name || report.cluster.terms.slice(0, 2).join(" · ")}
                  </span>
                  .{" "}
                </>
              ) : null}
              {crowdingLabel(report.crowding)}{" "}
              <span className="text-ink-3">
                (mean similarity {report.crowding.toFixed(2)} to the nearest
                passages)
              </span>
              {report.topJournals.length > 0 && (
                <>
                  {" "}
                  · neighborhood journals:{" "}
                  <span className="text-ink-3">
                    {report.topJournals.join(", ")}
                  </span>
                </>
              )}
            </p>
          </div>

          <div>
            <p className="text-[11px] text-ink-2">Nearest papers</p>
            <ul className="mt-1 space-y-0.5">
              {report.papers.map(([pi, score]) => {
                const p = corpus.papers[pi];
                return (
                  <li key={p.file}>
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                      onClick={() => {
                        select({ kind: "paper", idx: pi });
                        const v = paperWorldPos(
                          data,
                          pi,
                          uMorph.value,
                          new THREE.Vector3(),
                        );
                        requestWarp([v.x, v.y, v.z], 10, 1.7);
                      }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="line-clamp-1">{p.title}</span>
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-3">
                          {score.toFixed(2)}
                        </span>
                      </div>
                      <span className="text-[10px] text-ink-3">{shortCite(p)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const d = useWorld.getState().draft;
                const anchors = d ? draftAnchors(data, d.hits) : null;
                if (!anchors) return;
                const p = anchors.ground.clone().lerp(anchors.space, uMorph.value);
                requestWarp([p.x, p.y, p.z], 30, 2.0);
              }}
              className="flex-1 rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-2 uppercase hover:text-ink"
            >
              fly to the star
            </button>
            <button
              type="button"
              onClick={() => {
                set("draft", null);
                setText("");
              }}
              className="rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase hover:text-ink"
            >
              clear
            </button>
          </div>
        </>
      )}

      <p className="border-t hairline pt-3 text-[10px] leading-relaxed text-ink-3">
        Shortcut: type <code className="text-ink-2">/draft</code> in the search
        bar. Your text is embedded transiently and never stored.
      </p>
    </div>
  );
}
