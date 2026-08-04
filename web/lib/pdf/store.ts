"use client";

import { create } from "zustand";

// State for the in-app PDF reader: a set of open papers shown as tabs beside the chat.
// A tiny global store (rather than context) because the triggers live deep inside
// message rendering — a citation popover, a reference row, a chunk card — while the
// reader pane is mounted once at the layout level.
//
// Tabs belong to a SCOPE, which is the chat they were opened from (or the page, for the
// Papers Database). Opening a different chat swaps in that chat's papers — usually none,
// so the reader closes — and returning re-opens exactly what was there. Without this the
// reader followed you around the app, showing one chat's sources next to another's.

export type PdfSpan = {
  page: number;
  rects: [number, number, number, number][]; // fractional, top-left origin
};

export type PdfLocation = {
  page: number | null; // first page of the passage (null = not found)
  rects: [number, number, number, number][]; // that page's rects
  // A passage can run across a page break, so the highlight is per page.
  spans?: PdfSpan[];
};

export type PdfTab = {
  id: string; // the filename doubles as the tab identity (one tab per paper)
  filename: string;
  page: number; // page currently shown
  requestedPage?: number; // page to jump to once the document is ready
  quote?: string; // passage to locate + highlight
  label?: string; // APA in-text or title, for the tab and header
  driveUrl?: string; // fallback link when the PDF isn't on the server
  located?: PdfLocation; // resolved by /api/pdf-locate
};

export type PdfOpenTarget = {
  filename: string;
  page?: number;
  quote?: string;
  label?: string;
  driveUrl?: string;
};

type PdfViewerState = {
  scope: string;
  tabsByScope: Record<string, PdfTab[]>;
  activeByScope: Record<string, string | null>;
  /** Tabs of the current scope — what the reader renders. */
  tabs: PdfTab[];
  activeId: string | null;
  setScope: (scope: string) => void;
  openPdf: (target: PdfOpenTarget) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
  setPage: (id: string, page: number) => void;
  setLocated: (id: string, located: PdfLocation) => void;
};

const MAX_TABS = 8;
/** Scopes remembered at once; the oldest are dropped so this can't grow forever. */
const MAX_SCOPES = 12;

function trimScopes<T>(record: Record<string, T>, keep: string): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= MAX_SCOPES) {
    return record;
  }
  const out: Record<string, T> = {};
  for (const key of keys.slice(-MAX_SCOPES)) {
    out[key] = record[key];
  }
  out[keep] = record[keep];
  return out;
}

/** Apply a change to the current scope's tabs and re-derive what the reader shows. */
function withTabs(
  state: PdfViewerState,
  update: (tabs: PdfTab[]) => { tabs: PdfTab[]; activeId?: string | null }
) {
  const current = state.tabsByScope[state.scope] ?? [];
  const { tabs, activeId } = update(current);
  const nextActive =
    activeId !== undefined ? activeId : (state.activeByScope[state.scope] ?? null);
  return {
    tabsByScope: { ...state.tabsByScope, [state.scope]: tabs },
    activeByScope: { ...state.activeByScope, [state.scope]: nextActive },
    tabs,
    activeId: nextActive,
  };
}

export const usePdfViewer = create<PdfViewerState>((set) => ({
  scope: "default",
  tabsByScope: {},
  activeByScope: {},
  tabs: [],
  activeId: null,

  // Called as the route (or active chat) changes: swap in that scope's papers.
  setScope: (scope) =>
    set((state) => {
      if (scope === state.scope) {
        return state;
      }
      return {
        scope,
        tabsByScope: trimScopes(state.tabsByScope, scope),
        activeByScope: trimScopes(state.activeByScope, scope),
        tabs: state.tabsByScope[scope] ?? [],
        activeId: state.activeByScope[scope] ?? null,
      };
    }),

  // Opening a paper that is already open re-uses its tab and re-aims it at the new
  // citation, rather than stacking duplicates of the same PDF.
  openPdf: (target) =>
    set((state) =>
      withTabs(state, (tabs) => {
        const id = target.filename;
        const existing = tabs.find((t) => t.id === id);
        const next: PdfTab = {
          id,
          filename: target.filename,
          page: target.page ?? existing?.page ?? 1,
          requestedPage: target.page,
          quote: target.quote,
          label: target.label ?? existing?.label,
          driveUrl: target.driveUrl ?? existing?.driveUrl,
          // A new citation needs its own lookup; keep the old one only when re-opening
          // the same passage.
          located:
            existing && existing.quote === target.quote
              ? existing.located
              : undefined,
        };
        return {
          tabs: existing
            ? tabs.map((t) => (t.id === id ? next : t))
            : [...tabs, next].slice(-MAX_TABS),
          activeId: id,
        };
      })
    ),

  closeTab: (id) =>
    set((state) =>
      withTabs(state, (tabs) => {
        const index = tabs.findIndex((t) => t.id === id);
        const remaining = tabs.filter((t) => t.id !== id);
        if (remaining.length === 0) {
          return { tabs: remaining, activeId: null };
        }
        const wasActive = state.activeByScope[state.scope] === id;
        return {
          tabs: remaining,
          activeId: wasActive
            ? remaining[Math.min(index, remaining.length - 1)].id
            : (state.activeByScope[state.scope] ?? null),
        };
      })
    ),

  closeAll: () => set((state) => withTabs(state, () => ({ tabs: [], activeId: null }))),

  setActive: (id) => set((state) => withTabs(state, (tabs) => ({ tabs, activeId: id }))),

  // Manual page navigation drops the pending jump; the highlight stays attached to the
  // page the passage was found on, so it simply won't paint elsewhere.
  setPage: (id, page) =>
    set((state) =>
      withTabs(state, (tabs) => ({
        tabs: tabs.map((t) =>
          t.id === id
            ? { ...t, page: Math.max(1, page), requestedPage: undefined }
            : t
        ),
      }))
    ),

  setLocated: (id, located) =>
    set((state) =>
      withTabs(state, (tabs) => ({
        tabs: tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                located,
                // Found it: aim the reader at that page.
                page: located.page ?? t.page,
                requestedPage: located.page ?? t.requestedPage,
              }
            : t
        ),
      }))
    ),
}));
