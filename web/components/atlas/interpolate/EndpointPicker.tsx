"use client";

import { useMemo, useState } from "react";
import type { CorpusData } from "@/lib/atlas/types";
import { endpointLabel, truncate, type Endpoint } from "./engine";

interface Suggestion {
  key: string;
  kind: Endpoint["kind"];
  primary: string;
  secondary: string;
  ep: Endpoint;
}

const KIND_GLYPH: Record<Endpoint["kind"], string> = {
  phrase: "“”",
  paper: "P",
  author: "AU",
};

function SlotBadge({ slot, color }: { slot: string; color: string }) {
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-md border text-[11px] font-medium"
      style={{ borderColor: color, color }}
    >
      {slot}
    </span>
  );
}

/**
 * Combobox for one endpoint slot: type anything to use it as a phrase, or pick
 * a paper / multi-paper author from the corpus.
 */
export default function EndpointPicker({
  slot,
  color,
  endpoint,
  onChange,
  corpus,
  placeholder,
}: {
  slot: string;
  color: string;
  endpoint: Endpoint | null;
  onChange: (ep: Endpoint | null) => void;
  corpus: CorpusData;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const multiAuthors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of corpus.papers) counts.set(p.authors, (counts.get(p.authors) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n >= 2);
  }, [corpus]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const query = q.trim();
    if (!query) return [];
    const lower = query.toLowerCase();
    const out: Suggestion[] = [
      {
        key: "phrase",
        kind: "phrase",
        primary: `“${truncate(query, 44)}”`,
        secondary: "use this phrase",
        ep: { kind: "phrase", text: query },
      },
    ];
    corpus.papers
      .map((p, i) => ({ p, i }))
      .filter(
        ({ p }) =>
          p.title.toLowerCase().includes(lower) || p.authors.toLowerCase().includes(lower),
      )
      .slice(0, 5)
      .forEach(({ p, i }) =>
        out.push({
          key: `p${i}`,
          kind: "paper",
          primary: `${p.authors} (${p.year})`,
          secondary: truncate(p.title, 60),
          ep: { kind: "paper", paperIdx: i },
        }),
      );
    multiAuthors
      .filter(([name]) => name.toLowerCase().includes(lower))
      .slice(0, 3)
      .forEach(([name, n]) =>
        out.push({
          key: `a${name}`,
          kind: "author",
          primary: name,
          secondary: `author · ${n} papers`,
          ep: { kind: "author", name },
        }),
      );
    return out;
  }, [q, corpus, multiAuthors]);

  const pick = (s: Suggestion) => {
    onChange(s.ep);
    setQ("");
    setOpen(false);
    setHi(0);
  };

  if (endpoint) {
    return (
      <div className="flex items-center gap-2">
        <SlotBadge slot={slot} color={color} />
        <div
          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
          style={{ borderColor: `${color}66`, background: `${color}14` }}
        >
          <span className="truncate text-sm text-ink" title={endpointLabel(endpoint, corpus.papers)}>
            {endpointLabel(endpoint, corpus.papers)}
          </span>
          <button
            onClick={() => onChange(null)}
            className="shrink-0 text-ink-3 transition-colors hover:text-ink"
            aria-label={`clear ${slot}`}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2">
      <SlotBadge slot={slot} color={color} />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!suggestions.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(suggestions[Math.min(hi, suggestions.length - 1)]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3/70 focus:border-white/25"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute top-full right-0 left-8 z-50 mt-1 overflow-hidden rounded-lg border border-white/10 bg-[#161519] shadow-2xl">
          {suggestions.map((s, i) => (
            <li key={s.key}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHi(i)}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left ${
                  i === hi ? "bg-white/10" : ""
                }`}
              >
                <span className="w-5 shrink-0 text-[9px] tracking-wider text-ink-3">
                  {KIND_GLYPH[s.kind]}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{s.primary}</span>
                  <span className="block truncate text-xs text-ink-3">{s.secondary}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
