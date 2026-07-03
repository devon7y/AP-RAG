"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { AuthorSpirit, SeanceRef } from "./authors";
import type { SeanceMessage } from "./useSeance";
import { GHOST_GREEN, SEANCE_UI } from "./theme";

/** Minimal inline markdown: only **bold** (answers are otherwise plain prose). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong key={i} className="font-semibold text-ink">
            {p}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/**
 * The PC server rewrites in-text [n] citations to APA, but LightRAG context
 * indices that never made the reference list can leak through as dangling
 * brackets. Keep the ones that resolve; drop the rest (the full source list is
 * rendered under the answer either way).
 */
function cleanDanglingCites(text: string, byN: Map<string, SeanceRef>): string {
  return text
    .replace(/\s*\[([0-9,;\s]+)\]/g, (_full, inner: string) => {
      const hit = inner
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((n) => byN.has(n));
      return hit.length ? ` [${hit.join(", ")}]` : "";
    })
    .replace(/\s+([.,;:!?])/g, "$1");
}

type Seg =
  | { kind: "text"; text: string }
  | { kind: "cite"; text: string; title: string };

/** Split a paragraph into prose and resolvable citation segments. */
function segment(text: string, byN: Map<string, SeanceRef>): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([0-9,;\s]+)\]/g)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ kind: "text", text: text.slice(last, idx) });
    const hit = m[1]
      .split(/[,;]/)
      .map((s) => byN.get(s.trim()))
      .filter((r): r is SeanceRef => Boolean(r));
    if (hit.length) {
      segs.push({
        kind: "cite",
        text: hit.map((r) => r.intext || `(${r.filename})`).join(" "),
        title: hit.map((r) => r.apa).join("\n"),
      });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) segs.push({ kind: "text", text: text.slice(last) });
  return segs;
}

function AnswerBody({ text, refs }: { text: string; refs: SeanceRef[] }) {
  const paragraphs = useMemo(() => {
    const byN = new Map(refs.filter((r) => r.n).map((r) => [r.n, r]));
    return text
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => segment(cleanDanglingCites(p, byN), byN));
  }, [text, refs]);
  return (
    <div className="space-y-2.5">
      {paragraphs.map((segs, i) => (
        <p key={i} className="text-sm leading-relaxed whitespace-pre-wrap text-ink-2">
          {segs.map((s, j) =>
            s.kind === "cite" ? (
              <span key={j} title={s.title} className="cursor-help text-ink-3">
                {s.text}
              </span>
            ) : (
              <Inline key={j} text={s.text} />
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Message({ msg }: { msg: SeanceMessage }) {
  if (msg.role === "note") {
    return (
      <p className="px-6 py-1 text-center text-xs leading-relaxed text-ink-3 italic">
        {msg.text}
      </p>
    );
  }
  if (msg.role === "you") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-hairline bg-white/[0.06] px-4 py-2.5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{msg.text}</p>
        </div>
      </div>
    );
  }

  // them — the spirit speaks
  const regions = msg.cited
    ? [...new Map(msg.cited.map((c) => [c.region, c.color])).entries()]
    : [];
  return (
    <div
      className={"border-l-2 pl-4 " + (msg.silent ? "opacity-75" : "")}
      style={{ borderColor: msg.silent ? "var(--baseline)" : GHOST_GREEN }}
    >
      <AnswerBody text={msg.text} refs={msg.refs ?? []} />

      {msg.silent && (
        <p className="mt-2 inline-block rounded-full border border-hairline px-2.5 py-0.5 text-[10px] tracking-widest text-ink-3 uppercase">
          ∅ nothing retrieved — the record is silent
        </p>
      )}
      {!msg.silent && msg.demurred && (
        <p className="mt-2 inline-block rounded-full border border-hairline px-2.5 py-0.5 text-[10px] tracking-widest text-ink-3 uppercase">
          they demur — thin coverage here
        </p>
      )}

      {regions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-[10px] tracking-widest text-ink-3 uppercase">drawn from</span>
          {regions.map(([label, color]) => (
            <span key={label} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: color }}
              />
              {label}
            </span>
          ))}
        </div>
      )}

      {msg.refs && msg.refs.length > 0 && (
        <details className="mt-2 group">
          <summary className="cursor-pointer list-none text-[11px] tracking-wide text-ink-3 uppercase transition-colors hover:text-ink-2">
            sources ({msg.refs.length}) <span className="group-open:hidden">＋</span>
            <span className="hidden group-open:inline">－</span>
          </summary>
          <ul className="mt-2 space-y-1.5">
            {msg.refs.map((r, i) => (
              <li key={`${r.filename}-${i}`} className="text-xs leading-snug text-ink-3">
                {r.apa || r.filename}
                {r.pages.length > 0 && (
                  <span> · pp. {r.pages.join(", ")}</span>
                )}
                {r.link && (
                  <>
                    {" "}
                    <a
                      href={r.link}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-ink-2"
                    >
                      open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const STARTERS = [
  "What is the main thread of your work?",
  "What did you find, in plain terms?",
  "What methods did you rely on?",
];

export default function ChatPanel({
  spirit,
  messages,
  channeling,
  onAsk,
  onRelease,
}: {
  spirit: AuthorSpirit;
  messages: SeanceMessage[];
  channeling: boolean;
  onAsk: (q: string) => void;
  onRelease: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, channeling]);

  const askedYet = messages.some((m) => m.role === "you");

  const send = () => {
    const q = draft.trim();
    if (!q || channeling) return;
    setDraft("");
    onAsk(q);
  };

  return (
    <motion.aside
      initial={{ opacity: 0, x: 36 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 240, damping: 30 }}
      className="hud-panel pointer-events-auto absolute top-20 right-5 bottom-5 z-40 flex w-[440px] max-w-[92vw] flex-col"
    >
      <header className="flex items-start justify-between gap-3 border-b border-hairline p-4">
        <div>
          <h2 className="font-display text-xl leading-tight">Séance with {spirit.name}</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">
            answers retrieved from {spirit.nChunks.toLocaleString()} passages ·{" "}
            {spirit.nPapers} paper{spirit.nPapers === 1 ? "" : "s"} — nothing else
          </p>
        </div>
        <button
          onClick={onRelease}
          className="shrink-0 rounded-full border border-hairline px-2.5 py-1 text-[11px] tracking-wide text-ink-3 uppercase transition-colors hover:text-ink"
        >
          release
        </button>
      </header>

      <div ref={scroller} className="hud-scroll flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((m) => (
          <Message key={m.id} msg={m} />
        ))}

        {channeling && (
          <div className="border-l-2 pl-4" style={{ borderColor: GHOST_GREEN }}>
            <p className="pulse-soft text-sm text-ink-3 italic">channeling…</p>
          </div>
        )}

        {!askedYet && !channeling && (
          <div className="space-y-2 pt-2">
            {STARTERS.map((q) => (
              <button
                key={q}
                onClick={() => onAsk(q)}
                className="block w-full rounded-lg border border-hairline px-3 py-2 text-left text-sm text-ink-2 transition-colors hover:border-[color:var(--accent)] hover:text-ink"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-hairline p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={channeling ? "the spirit is answering…" : `ask ${spirit.name} anything…`}
            disabled={channeling}
            className="hud-scroll min-h-[3.25rem] flex-1 resize-none rounded-lg border border-hairline bg-page/60 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-[color:var(--accent)] disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={channeling || !draft.trim()}
            className="rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: SEANCE_UI, color: SEANCE_UI }}
          >
            ask
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-3">
          Every claim carries its citation. If they never wrote about it, they will say so.
        </p>
      </footer>
    </motion.aside>
  );
}
