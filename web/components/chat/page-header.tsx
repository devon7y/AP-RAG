import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { BackendStatus } from "./app-title";

// One header shape for every full-page view: the chat header's height and
// sidebar-toned background, so moving between chat, the digest, trends, the graph
// and the papers database never changes the chrome. Each page supplies its own
// content — sidebar toggle, icon, title, counts, actions.
export function PageHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 bg-sidebar px-3",
        className
      )}
    >
      {children}
    </header>
  );
}

// The inset panel that carries a page's content below the header: page-colored,
// its top-left corner rounded away from the sidebar, with a hairline top and left
// edge. ChatShell renders this same panel, so chat is the one definition and every
// other page inherits it rather than approximating it.
export const PAGE_PANEL_CLASS =
  "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-t md:border-l md:border-border/40";

// Header + inset panel, the whole frame of a full-page view. The outer column is
// sidebar-toned so the panel's rounded corner reveals it. Pages whose whole body
// scrolls pass className="overflow-y-auto"; pages that scroll an inner region
// (the papers table) keep the panel's own overflow-hidden.
export function PageShell({
  header,
  children,
  className,
}: {
  header: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-dvh min-w-0 flex-col bg-sidebar">
      <PageHeader>
        {header}
        {/* Whether retrieval is actually up matters on every page, not just in chat —
            a dead backend is why the graph, trends or the papers table came back
            empty. Rendered here so no page can forget it. (The Atlas has its own
            chrome and does not use this shell.) */}
        <div className="ml-auto flex shrink-0 items-center pl-2">
          <BackendStatus />
        </div>
      </PageHeader>
      <div className={cn(PAGE_PANEL_CLASS, "pt-4", className)}>{children}</div>
    </div>
  );
}
