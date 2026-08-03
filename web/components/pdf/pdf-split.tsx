"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useSidebar } from "@/components/ui/sidebar";
import { usePdfViewer } from "@/lib/pdf/store";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { PdfReader } from "./pdf-reader";

// Wraps a page so that opening a PDF splits the view: content on the left, the reader
// on the right, with a draggable divider (its ratio persisted by react-resizable-panels).
//
// Two behaviours worth knowing:
//   * The app sidebar collapses when the reader opens, to buy the split its width — and
//     is restored to whatever it was when the reader closes, so the app never appears to
//     have quietly taken it away.
//   * Below the split breakpoint there isn't room for two columns, so the reader falls
//     back to the overlay sheet it used before.

const SPLIT_MIN_WIDTH = 1024;

function useIsWide(min = SPLIT_MIN_WIDTH) {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${min}px)`);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [min]);
  return wide;
}

export function PdfSplit({ children }: { children: React.ReactNode }) {
  const tabs = usePdfViewer((s) => s.tabs);
  const closeAll = usePdfViewer((s) => s.closeAll);
  const isOpen = tabs.length > 0;
  const isWide = useIsWide();
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar();

  // Collapse the sidebar while the reader is open; put it back as it was afterwards.
  const restoreSidebar = useRef<boolean | null>(null);
  useEffect(() => {
    if (isOpen && isWide) {
      if (restoreSidebar.current === null) {
        restoreSidebar.current = sidebarOpen;
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
      }
    } else if (restoreSidebar.current !== null) {
      const previous = restoreSidebar.current;
      restoreSidebar.current = null;
      if (previous) {
        setSidebarOpen(true);
      }
    }
  }, [isOpen, isWide, sidebarOpen, setSidebarOpen]);

  if (!isOpen) {
    return <>{children}</>;
  }

  if (!isWide) {
    return (
      <>
        {children}
        <Sheet onOpenChange={(o) => !o && closeAll()} open>
          <SheetContent className="flex w-full flex-col gap-0 p-0" side="right">
            <SheetTitle className="sr-only">PDF reader</SheetTitle>
            <PdfReader onClose={closeAll} />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <PanelGroup
      autoSaveId="aprag:pdf-split"
      className="h-dvh w-full"
      direction="horizontal"
    >
      <Panel defaultSize={52} minSize={28} order={1}>
        {/* min-w-0/h-full: let the chat column shrink and scroll inside the split
            instead of forcing the page wider than the viewport. */}
        <div className="h-full min-w-0 overflow-hidden">{children}</div>
      </Panel>
      <PanelResizeHandle className="group relative w-1.5 shrink-0 bg-border/40 transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary/60">
        <span className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 h-8 w-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-primary/60" />
      </PanelResizeHandle>
      <Panel defaultSize={48} minSize={25} order={2}>
        <PdfReader onClose={closeAll} />
      </Panel>
    </PanelGroup>
  );
}
