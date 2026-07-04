"use client";

import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { qsearch } from "@/lib/atlas/api";
import { SEQ_BLUE } from "@/lib/atlas/palette";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { shortCite, type WorldData } from "./derive";
import { solveArithmeticWorld, traceGeodesicWorld } from "./engineBridge";
import { findAuthor, parseCommand, slotToEndpoint } from "./parse";
import { useWorld, type SearchHit } from "./store";
import { uMorph } from "./uniforms";

/**
 * The command line of the world (press "/"). A bare phrase warps you there;
 * "a -> b" runs the interpolation engine; "a - b + c" runs embedding
 * arithmetic; "@author" lights their career trail; "year:", "journal:",
 * "kw:" set lenses; "ghost", "radio", "clear" drive instruments.
 */

function chunkWorldPos(data: WorldData, i: number, m: number): [number, number, number] {
  const gx = data.chunkGround[i * 3];
  const gy = data.chunkGroundY[i];
  const gz = data.chunkGround[i * 3 + 2];
  return [
    gx + (data.chunkSpace[i * 3] - gx) * m,
    gy + (data.chunkSpace[i * 3 + 1] - gy) * m,
    gz + (data.chunkSpace[i * 3 + 2] - gz) * m,
  ];
}

export default function CommandBar({
  data,
  corpus,
  authors,
}: {
  data: WorldData;
  corpus: CorpusData;
  authors: AuthorRec[];
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchHits = useWorld((s) => s.searchHits);
  const searchQuery = useWorld((s) => s.searchQuery);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        const st = useWorld.getState();
        if (typing) (e.target as HTMLElement).blur();
        else if (st.planting) st.set("planting", false);
        else if (st.searchHits) st.setSearch("", null);
        else if (st.selection) st.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const warpToHits = (hits: SearchHit[]) => {
    const st = useWorld.getState();
    const m = uMorph.value;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let wsum = 0;
    for (const h of hits) {
      const w = Math.max(0.01, h.score);
      const [x, y, z] = chunkWorldPos(data, h.idx, m);
      cx += x * w;
      cy += y * w;
      cz += z * w;
      wsum += w;
    }
    cx /= wsum;
    cy /= wsum;
    cz /= wsum;
    let radius = 0;
    for (const h of hits) {
      const [x, y, z] = chunkWorldPos(data, h.idx, m);
      radius = Math.max(radius, Math.hypot(x - cx, y - cy, z - cz));
    }
    st.requestWarp([cx, cy, cz], Math.min(120, Math.max(16, radius * 2.2)), 2.3);
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = parseCommand(value);
    if (!cmd || busy) return;
    setNotice(null);
    const st = useWorld.getState();

    try {
      switch (cmd.kind) {
        case "warp": {
          setBusy("searching");
          const raw = await qsearch({ text: cmd.query, limit: 12 });
          const seen = new Set<number>();
          const hits: SearchHit[] = [];
          for (const h of raw) {
            const idx = data.chunkIdToIdx.get(h.chunkId);
            if (idx === undefined || seen.has(idx)) continue;
            seen.add(idx);
            hits.push({ idx, chunkId: h.chunkId, score: h.score });
          }
          if (!hits.length) {
            setNotice("nothing matched — try different words");
            break;
          }
          st.setSearch(cmd.query, hits);
          warpToHits(hits);
          inputRef.current?.blur();
          break;
        }
        case "interpolate": {
          setBusy("tracing the geodesic…");
          st.setInstrument("interpolate");
          const trace = await traceGeodesicWorld(
            resolveSlot(cmd.a),
            resolveSlot(cmd.b),
            corpus,
            setBusy,
          );
          st.set("arith", null);
          st.set("trace", trace);
          st.set("traceT", 0);
          setValue("");
          break;
        }
        case "arithmetic": {
          setBusy("solving A − B + C…");
          st.setInstrument("interpolate");
          const arith = await solveArithmeticWorld(
            resolveSlot(cmd.a),
            resolveSlot(cmd.b),
            resolveSlot(cmd.c),
            corpus,
            setBusy,
          );
          st.set("trace", null);
          st.set("arith", arith);
          setValue("");
          break;
        }
        case "author": {
          const idx = findAuthor(authors, cmd.name);
          if (idx === null) {
            setNotice(`no author matching “${cmd.name}” in the corpus`);
            break;
          }
          st.setLens({ author: idx });
          st.setInstrument("lenses");
          st.select({ kind: "author", idx });
          const a = authors[idx];
          const m = uMorph.value;
          const px = a.pos2[0];
          const py = a.pos2[1];
          const [gx, gz] = [(px - 0.5) * 100, (py - 0.5) * 100];
          const sx = (a.pos3[0] - 0.5) * 100;
          const sy = (a.pos3[1] - 0.5) * 100;
          const sz = (a.pos3[2] - 0.5) * 100;
          st.requestWarp(
            [gx + (sx - gx) * m, 8 + (sy - 8) * m, gz + (sz - gz) * m],
            40,
            2.2,
          );
          setValue("");
          break;
        }
        case "year": {
          st.set("year", Math.min(cmd.to, st.yearMax) + 0.99);
          st.set("yearLo", cmd.from ?? 0);
          st.setInstrument("time");
          setValue("");
          break;
        }
        case "journal":
          st.setLens({ journal: cmd.value });
          st.setInstrument("lenses");
          setValue("");
          break;
        case "keyword":
          st.setLens({ keyword: cmd.value });
          st.setInstrument("lenses");
          setValue("");
          break;
        case "ghost":
          st.set("planting", true);
          st.setInstrument("ghosts");
          setValue("");
          break;
        case "radio":
          st.set("radioOn", !st.radioOn);
          st.setInstrument("radio");
          setValue("");
          break;
        case "clear":
          st.clearLens();
          st.setSearch("", null);
          st.set("trace", null);
          st.set("arith", null);
          st.set("yearLo", 0);
          st.set("year", st.yearMax + 1);
          setValue("");
          break;
      }
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(null);
    }
  };

  const resolveSlot = (slot: string) => {
    const ep = slotToEndpoint(slot);
    if (ep.kind === "author") {
      const idx = findAuthor(authors, ep.name);
      if (idx === null) throw new Error(`no author matching “${ep.name}”`);
      return { kind: "authorRec" as const, rec: authors[idx] };
    }
    return ep;
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
            className="hud-panel hud-scroll mb-2 max-h-[32vh] overflow-y-auto p-3"
          >
            <div className="flex items-center justify-between px-1">
              <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
                “{searchQuery}” · {searchHits.length} passages
              </p>
              <button
                type="button"
                onClick={() => useWorld.getState().setSearch("", null)}
                className="text-ink-3 transition-colors hover:text-ink"
                aria-label="Clear search"
              >
                ✕
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {searchHits.slice(0, 8).map((h, rank) => {
                const paper = corpus.papers[corpus.atlas.paper[h.idx]];
                return (
                  <li key={h.chunkId}>
                    <button
                      type="button"
                      className="group w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                      onClick={() => {
                        const st = useWorld.getState();
                        st.select({ kind: "chunk", idx: h.idx });
                        const [x, y, z] = chunkWorldPos(data, h.idx, uMorph.value);
                        st.requestWarp([x, y, z], 7, 1.6);
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

      {notice && <p className="mb-2 text-center text-[11px] text-[#fab219]">{notice}</p>}

      <form onSubmit={run} className="hud-panel flex items-center gap-3 px-4 py-2.5">
        {busy ? (
          <span className="pulse-soft shrink-0 text-[10px] font-medium tracking-[0.3em] text-[#3987e5] uppercase">
            {busy}
          </span>
        ) : (
          <SearchIcon className="size-4 shrink-0 text-ink-3" />
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy !== null}
          placeholder="search the papers for anything…"
          className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
        />
        <button
          type="submit"
          disabled={busy !== null || !value.trim()}
          className="rounded-full border border-[#3987e5]/60 px-3 py-1 text-[11px] tracking-widest text-[#3987e5] uppercase transition-opacity disabled:opacity-30"
        >
          go
        </button>
      </form>
    </div>
  );
}
