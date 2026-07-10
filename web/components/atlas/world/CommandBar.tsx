"use client";

import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import * as THREE from "three";
import { qsearch, ragQuery } from "@/lib/atlas/api";
import { SEQ_BLUE } from "@/lib/atlas/palette";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { paperWorldPos } from "./PaperBeacons";
import { shortCite, type WorldData } from "./derive";
import { solveArithmeticWorld, traceGeodesicWorld } from "./engineBridge";
import { fitArith, fitAuthorTrail, fitPointsWarp, fitTrace } from "./fit";
import { findAuthor, parseCommand, slotToEndpoint } from "./parse";
import { useWorld, warpHome, type AskRef, type SearchHit } from "./store";
import { uMorph } from "./uniforms";

/**
 * The command line of the world (press "/"). A bare phrase warps you there;
 * a "?" prefix (or a trailing "?") asks the RAG engine and lights the cited
 * papers; "a -> b" runs the interpolation engine; "a - b + c" runs embedding
 * arithmetic; "@author" lights their career trail; "year:", "journal:",
 * "kw:" set lenses; "ghost", "draft", "radio", "clear" drive instruments.
 */

/** The server appends its own "### References" block — the ask panel renders
 *  the structured refs instead, so drop the text block (same heading regex as
 *  apa_citations.strip_references_section). */
function stripReferencesBlock(answer: string): string {
  const m = answer.match(
    /^[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*[ \t]*)?references[ \t]*:?[ \t]*\**[ \t]*$/im,
  );
  return m?.index !== undefined ? answer.slice(0, m.index).trimEnd() : answer;
}

const baseName = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? "";

/** Fire the RAG query without holding the command bar hostage (it can take
 *  tens of seconds); the ask panel shows progress, and a newer question
 *  simply supersedes this one. */
async function answerAsk(question: string, data: WorldData, corpus: CorpusData) {
  const current = () => {
    const st = useWorld.getState();
    return st.ask?.question === question && st.ask.status === "running" ? st : null;
  };
  try {
    const res = await ragQuery({ question, mode: "hybrid" });
    const fileToIdx = new Map(corpus.papers.map((p, i) => [baseName(p.file), i]));
    const refs: AskRef[] = (res.references ?? []).map((r) => ({
      paperIdx: fileToIdx.get(baseName(String(r.filename ?? ""))) ?? -1,
      filename: String(r.filename ?? ""),
      apa: String(r.apa ?? ""),
      intext: String(r.intext ?? ""),
      pages: Array.isArray(r.pages) ? r.pages : [],
      drive: String(r.drive_url ?? ""),
    }));
    const st = current();
    if (!st) return;
    st.set("ask", {
      question,
      status: "done",
      answer: stripReferencesBlock(res.answer ?? ""),
      refs,
    });
    const pts = refs
      .filter((r) => r.paperIdx >= 0)
      .map((r) => paperWorldPos(data, r.paperIdx, uMorph.value, new THREE.Vector3()));
    if (pts.length) fitPointsWarp(pts, 2.4);
  } catch (err) {
    const st = current();
    if (!st) return;
    st.set("ask", {
      question,
      status: "error",
      answer: null,
      refs: [],
      error: String(err instanceof Error ? err.message : err),
    });
  }
}

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
  const planeOn = useWorld((s) => s.planeOn);
  const searchQuery = useWorld((s) => s.searchQuery);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        // seed the slash so slash-commands type naturally after the shortcut
        if (!inputRef.current?.value) setValue("/");
      } else if (e.key === "Escape") {
        // one press clears everything, even while a text field is focused
        if (typing) (e.target as HTMLElement).blur();
        const st = useWorld.getState();
        const hadSomething =
          st.planting ||
          st.planeOn ||
          st.radioOn ||
          st.searchHits !== null ||
          st.selection !== null ||
          st.trace !== null ||
          st.arith !== null ||
          st.ask !== null ||
          st.draft !== null ||
          st.lens.author !== null ||
          st.lens.journal !== null ||
          st.lens.keyword !== null ||
          inputRef.current?.value !== "";
        // radio: Esc powers it off and closes its panel
        if (st.radioOn || st.instrument === "radio") {
          st.set("radioOn", false);
          st.set("paneOpen", false);
        }
        st.set("planting", false);
        const wasFlying = st.planeOn;
        st.set("planeOn", false);
        if (wasFlying) {
          // ejecting drops you mid-air — take the camera home
          st.set("autoRotate", true);
          warpHome(1.5);
        }
        st.setSearch("", null);
        st.clearLens(); // also closes an open author card
        st.select(null);
        st.set("trace", null);
        st.set("arith", null);
        st.set("ask", null);
        st.set("draft", null);
        window.dispatchEvent(new Event("world:esc")); // panels clear local inputs
        setValue("");
        // nothing left to clear (or the camera is still idling) → fly home
        if (!hadSomething || st.autoRotate) {
          if (!hadSomething) st.set("autoRotate", true);
          warpHome(1.3);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Live preview while typing: plain words drive the keyword lens keystroke
   *  by keystroke, so matching papers light up as you type. Command-shaped
   *  input (@author, a -> b, year:, …) leaves the lens alone. */
  const onType = (text: string) => {
    setValue(text);
    histIdx.current = -1; // typing exits history browsing
    const st = useWorld.getState();
    const cmd = parseCommand(text);
    if (cmd?.kind === "warp") st.setLens({ keyword: cmd.query });
    else if (cmd?.kind === "interpolate")
      // both endpoints glow while composing "a -> b"
      st.setLens({ keyword: `${cmd.a}|${cmd.b}`.replaceAll("@", "") });
    else if (cmd?.kind === "arithmetic")
      st.setLens({
        keyword: cmd.terms
          .map((t) => t.text)
          .join("|")
          .replaceAll("@", ""),
      });
    else if (st.lens.keyword !== null) st.setLens({ keyword: null });
  };

  // terminal-style history: ↑/↓ cycle previous submissions
  const history = useRef<string[]>(
    (() => {
      try {
        return JSON.parse(
          window.localStorage.getItem("atlas-world:search-history") ?? "[]",
        ) as string[];
      } catch {
        return [];
      }
    })(),
  );
  const histIdx = useRef(-1); // -1 = live input
  const draft = useRef("");

  const pushHistory = (entry: string) => {
    const h = history.current;
    if (h[0] !== entry) h.unshift(entry);
    if (h.length > 50) h.length = 50;
    histIdx.current = -1;
    try {
      window.localStorage.setItem(
        "atlas-world:search-history",
        JSON.stringify(h),
      );
    } catch {
      /* fine unsaved */
    }
  };

  const onHistoryKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const h = history.current;
    if (e.key === "ArrowUp") {
      if (!h.length || histIdx.current >= h.length - 1) return;
      e.preventDefault();
      if (histIdx.current === -1) draft.current = value;
      histIdx.current += 1;
      setValue(h[histIdx.current]);
    } else if (e.key === "ArrowDown") {
      if (histIdx.current === -1) return;
      e.preventDefault();
      histIdx.current -= 1;
      setValue(histIdx.current === -1 ? draft.current : h[histIdx.current]);
    }
  };

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
    pushHistory(value.trim());
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
        case "ask": {
          // fire-and-forget: the panel shows progress, the bar stays free
          st.setInstrument("ask");
          st.set("ask", {
            question: cmd.question,
            status: "running",
            answer: null,
            refs: [],
          });
          if (st.lens.keyword !== null) st.setLens({ keyword: null });
          void answerAsk(cmd.question, data, corpus);
          setValue("");
          inputRef.current?.blur();
          break;
        }
        case "interpolate": {
          setBusy("tracing the geodesic…");
          st.setInstrument("interpolate");
          const epA = resolveSlot(cmd.a);
          const epB = resolveSlot(cmd.b);
          fillPanelSlots({ A: epA, B: epB }, "geodesic");
          const trace = await traceGeodesicWorld(epA, epB, corpus, setBusy);
          st.set("arith", null);
          st.set("trace", trace);
          st.set("traceT", 0);
          fitTrace(data, trace); // frame the whole bridge
          setValue("");
          break;
        }
        case "arithmetic": {
          setBusy("solving the idea math…");
          st.setInstrument("interpolate");
          const signed = cmd.terms.map((t) => ({
            ep: resolveSlot(t.text),
            sign: t.sign,
          }));
          // mirror what fits into the panel's three slots (best effort)
          const plus = signed.filter((t) => t.sign === "+");
          const minus = signed.filter((t) => t.sign === "−");
          fillPanelSlots(
            {
              ...(plus[0] ? { A: plus[0].ep } : {}),
              ...(minus[0] ? { B: minus[0].ep } : {}),
              ...(plus[1] ? { C: plus[1].ep } : {}),
            },
            "arithmetic",
          );
          const arith = await solveArithmeticWorld(signed, corpus, setBusy);
          st.set("trace", null);
          st.set("arith", arith);
          fitArith(data, arith);
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
          fitAuthorTrail(data, authors[idx]); // frame the whole trail
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
        case "view":
          st.setView(cmd.view);
          setValue("");
          break;
        case "reset":
          st.set("autoRotate", true);
          warpHome(1.3);
          setValue("");
          break;
        case "timeplay":
          st.set("year", st.yearMin);
          st.set("timePlaying", true);
          st.setInstrument("time");
          setValue("");
          break;
        case "timenow":
          st.set("timePlaying", false);
          st.set("year", st.yearMax + 1);
          st.set("yearLo", 0);
          setValue("");
          break;
        case "game":
          st.setInstrument("game");
          setValue("");
          break;
        case "help":
          setNotice(
            "/landscape · /galaxy · /radio · /gap · /draft · /reset · /play · /now · /semantle · /clear — plus a question ending in ?, @author, a -> b, a - b + c, journal:, kw:, year:1990..2005, \"quoted phrase\"",
          );
          setValue("");
          break;
        case "ghost":
          st.set("planting", true);
          st.setInstrument("ghosts");
          setValue("");
          break;
        case "draft":
          st.setInstrument("draft");
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
          st.set("ask", null);
          st.set("draft", null);
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

  /** Mirror search-bar endpoints (and the mode) into the interpolation
   *  panel's inputs. Delayed a tick so the panel has mounted. */
  const fillPanelSlots = (
    slots: Record<string, unknown>,
    mode: "geodesic" | "arithmetic",
  ) => {
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("world:set-interp-mode", { detail: mode }),
      );
      for (const [slot, ep] of Object.entries(slots)) {
        window.dispatchEvent(
          new CustomEvent("world:set-endpoint", { detail: { slot, ep } }),
        );
      }
    }, 60);
  };

  const maxScore = searchHits?.length ? Math.max(...searchHits.map((h) => h.score)) : 1;

  if (planeOn) return null; // cockpit mode: the HUD owns the bottom of the screen

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
                onClick={() => {
                  const st = useWorld.getState();
                  st.setSearch("", null);
                  if (st.lens.keyword !== null) st.setLens({ keyword: null });
                  setValue("");
                }}
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
          <span className="pulse-soft max-w-[45%] shrink-0 truncate text-[10px] font-medium tracking-[0.3em] text-[#3987e5] uppercase">
            {busy}
          </span>
        ) : (
          <SearchIcon className="size-4 shrink-0 text-ink-3" />
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onHistoryKey}
          disabled={busy !== null}
          placeholder="search the papers — end with ? to ask, / for commands…"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
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
