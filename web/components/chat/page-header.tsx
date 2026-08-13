import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

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
