"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { qsearch } from "@/lib/atlas/api";
import { SEQ_BLUE } from "@/lib/atlas/palette";
import type { CorpusData } from "@/lib/atlas/types";
import { shortCite, type ObservatoryData } from "./derive";
import { useObservatory, type SearchHit } from "./store";

/**
 * The warp drive: semantic search over the real chunk embeddings
 * (POST /api/qsearch), then a camera slew to the result cluster. Hits pulse
 * in the sky and are listed here, ranked by cosine score.
 */
export default function WarpBar({
  data,
  corpus,
}: {
  data: ObservatoryData;
  corpus: CorpusData;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchHits = useObservatory((s) => s.searchHits);
  const searchQuery = useObservatory((s) => s.searchQuery);
  const setSearch = useObservatory((s) => s.setSearch);
  const clearSearch = useObservatory((s) => s.clearSearch);
  const requestWarp = useObservatory((s) => s.requestWarp);
  const selectStar = useObservatory((s) => s.selectStar);

  // "/" focuses the drive; Escape backs out of search → selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (typing) (e.target as HTMLElement).blur();
        else if (useObservatory.getState().searchHits) clearSearch();
        else if (useObservatory.getState().selection) selectStar(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSearch, selectStar]);

  const engage = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const raw = await qsearch({ text: q, limit: 12 });
      const seen = new Set<number>();
      const hits: SearchHit[] = [];
      for (const h of raw) {
        const idx = data.chunkIdToIdx.get(h.chunkId);
        if (idx === undefined || seen.has(idx)) continue;
        seen.add(idx);
        hits.push({ idx, chunkId: h.chunkId, score: h.score });
      }
      if (!hits.length) {
        setNotice("no charted stars matched — try different coordinates");
        setSearch(q, null);
        return;
      }
      setSearch(q, hits);
      // fly to the score-weighted centre of the result cluster
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let wsum = 0;
      for (const h of hits) {
        const w = Math.max(0.01, h.score);
        cx += data.positions[h.idx * 3] * w;
        cy += data.positions[h.idx * 3 + 1] * w;
        cz += data.positions[h.idx * 3 + 2] * w;
        wsum += w;
      }
      cx /= wsum;
      cy /= wsum;
      cz /= wsum;
      let radius = 0;
      for (const h of hits) {
        const dx = data.positions[h.idx * 3] - cx;
        const dy = data.positions[h.idx * 3 + 1] - cy;
        const dz = data.positions[h.idx * 3 + 2] - cz;
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      requestWarp([cx, cy, cz], Math.min(130, Math.max(14, radius * 2.2)), 2.4);
      inputRef.current?.blur();
    } catch {
      setNotice("warp drive offline — is the PC stack reachable?");
    } finally {
      setBusy(false);
    }
  };

  const maxScore = searchHits?.length ? Math.max(...searchHits.map((h) => h.score)) : 1;

  return (
    <div className="absolute bottom-5 left-1/2 z-40 w-[560px] max-w-[92vw] -translate-x-1/2">
      <AnimatePresence>
        {searchHits && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            transition={{ duration: 0.25 }}
            className="hud-panel hud-scroll mb-2 max-h-[38vh] overflow-y-auto p-3"
          >
            <div className="flex items-center justify-between px-1">
              <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
                destination · “{searchQuery}” · {searchHits.length} stars
              </p>
              <button
                onClick={clearSearch}
                className="text-ink-3 transition-colors hover:text-ink"
                aria-label="Clear search"
              >
                ✕
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {searchHits.map((h, rank) => {
                const paper = corpus.papers[corpus.atlas.paper[h.idx]];
                const section = corpus.atlas.section[h.idx];
                return (
                  <li key={h.chunkId}>
                    <button
                      className="group w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                      onClick={() => {
                        selectStar(h.idx);
                        requestWarp(
                          [
                            data.positions[h.idx * 3],
                            data.positions[h.idx * 3 + 1],
                            data.positions[h.idx * 3 + 2],
                          ],
                          7,
                          1.6,
                        );
                      }}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="line-clamp-1 text-xs text-ink">
                          <span className="text-ink-3">{rank + 1}.</span>{" "}
                          {paper?.title ?? "Unknown paper"}
                        </p>
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-3">
                          {h.score.toFixed(3)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/5">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((h.score / maxScore) * 100)}%`,
                              background: SEQ_BLUE[6],
                            }}
                          />
                        </div>
                        <span className="line-clamp-1 max-w-[45%] shrink-0 text-[10px] text-ink-3">
                          {shortCite(paper)}
                          {section && section !== "Untitled" ? ` · ${section}` : ""}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {notice && (
        <p className="mb-2 text-center text-[11px] text-[#fab219]">{notice}</p>
      )}

      <form onSubmit={engage} className="hud-panel flex items-center gap-3 px-4 py-2.5">
        <span
          className={`text-[10px] font-medium tracking-[0.3em] uppercase ${
            busy ? "pulse-soft text-atlas-accent" : "text-ink-3"
          }`}
        >
          {busy ? "charging" : "warp"}
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          placeholder="name an idea — semantic search slews the telescope…"
          className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-full border border-atlas-accent/60 px-3 py-1 text-[11px] tracking-widest text-atlas-accent uppercase transition-opacity disabled:opacity-30"
        >
          engage
        </button>
      </form>
    </div>
  );
}
