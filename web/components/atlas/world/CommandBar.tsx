"use client";

import { useEffect, useRef, useState } from "react";
import { Search as SearchIcon } from "lucide-react";
import type { AuthorRec, CorpusData } from "@/lib/atlas/types";
import { solveArithmeticWorld, traceGeodesicWorld } from "./engineBridge";
import { findAuthor, parseCommand, slotToEndpoint } from "./parse";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * The command line of the world (press "/"). Plain words work exactly like
 * the keyword lens — matching papers light up gold and everything else steps
 * back. "a -> b" runs the interpolation engine; "a - b + c" runs embedding
 * arithmetic; "@author" lights their career trail; "year:", "journal:",
 * "kw:" set lenses; "ghost", "radio", "clear" drive instruments.
 * Escape always clears lenses, search, and selection.
 */

export default function CommandBar({
  corpus,
  authors,
}: {
  corpus: CorpusData;
  authors: AuthorRec[];
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (typing) {
          (e.target as HTMLElement).blur();
          return;
        }
        // escape clears the world state: planting, lenses, search, selection
        const st = useWorld.getState();
        st.set("planting", false);
        st.setSearch("", null);
        st.clearLens(); // also closes an open author card
        st.select(null);
        setValue("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = parseCommand(value);
    if (!cmd || busy) return;
    setNotice(null);
    const st = useWorld.getState();

    try {
      switch (cmd.kind) {
        case "warp": {
          // plain words = the keyword lens: matching papers light up
          st.setLens({ keyword: cmd.query });
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
          st.select({ kind: "author", idx });
          const a = authors[idx];
          const m = uMorph.value;
          const [gx, gz] = [(a.pos2[0] - 0.5) * 100, (a.pos2[1] - 0.5) * 100];
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
          break;
        case "keyword":
          st.setLens({ keyword: cmd.value });
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

  return (
    <div className="absolute bottom-5 left-1/2 z-40 w-[560px] max-w-[92vw] -translate-x-1/2">
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
