"use client";

import { create } from "zustand";

// State for the in-app PDF reader: a set of open papers shown as tabs beside the chat.
// A tiny global store (rather than context) because the triggers live deep inside
// message rendering — a citation popover, a reference row, a chunk card — while the
// reader pane is mounted once at the layout level.

export type PdfLocation = {
  page: number | null; // page the passage was found on (null = not found)
  rects: [number, number, number, number][]; // fractional, top-left origin
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
  tabs: PdfTab[];
  activeId: string | null;
  openPdf: (target: PdfOpenTarget) => void;
  closeTab: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
  setPage: (id: string, page: number) => void;
  setLocated: (id: string, located: PdfLocation) => void;
};

const MAX_TABS = 8;

export const usePdfViewer = create<PdfViewerState>((set) => ({
  tabs: [],
  activeId: null,

  // Opening a paper that is already open re-uses its tab and re-aims it at the new
  // citation, rather than stacking duplicates of the same PDF.
  openPdf: (target) =>
    set((state) => {
      const id = target.filename;
      const existing = state.tabs.find((t) => t.id === id);
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
      const tabs = existing
        ? state.tabs.map((t) => (t.id === id ? next : t))
        : [...state.tabs, next].slice(-MAX_TABS);
      return { tabs, activeId: id };
    }),

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      const tabs = state.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        return { tabs, activeId: null };
      }
      const activeId =
        state.activeId === id
          ? tabs[Math.min(index, tabs.length - 1)].id
          : state.activeId;
      return { tabs, activeId };
    }),

  closeAll: () => set({ tabs: [], activeId: null }),

  setActive: (id) => set({ activeId: id }),

  // Manual page navigation drops the pending jump; the highlight stays attached to the
  // page the passage was found on, so it simply won't paint elsewhere.
  setPage: (id, page) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? { ...t, page: Math.max(1, page), requestedPage: undefined }
          : t
      ),
    })),

  setLocated: (id, located) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
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
    })),
}));
