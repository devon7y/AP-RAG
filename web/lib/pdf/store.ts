"use client";

import { create } from "zustand";

// What the in-app PDF viewer is currently showing. A tiny global store (rather than
// context) because the trigger lives deep inside message rendering — a citation popover,
// a reference row, a chunk card — while the viewer panel is mounted once at the layout
// level.

export type PdfTarget = {
  filename: string;
  page: number; // 1-based; the cited page when opened from a citation
  quote?: string; // passage text to highlight on that page
  label?: string; // APA in-text or title, for the panel header
  driveUrl?: string; // fallback link when the PDF isn't on the server
};

type PdfViewerState = {
  target: PdfTarget | null;
  openPdf: (target: PdfTarget) => void;
  closePdf: () => void;
  /** Page navigation inside the viewer. Clears the highlight: the quote belongs to the
   *  page it was cited from, so carrying it to another page would be a false positive. */
  goToPage: (page: number) => void;
};

export const usePdfViewer = create<PdfViewerState>((set) => ({
  target: null,
  openPdf: (target) => set({ target: { ...target, page: Math.max(1, target.page) } }),
  closePdf: () => set({ target: null }),
  goToPage: (page) =>
    set((state) =>
      state.target
        ? { target: { ...state.target, page: Math.max(1, page), quote: undefined } }
        : state
    ),
}));
