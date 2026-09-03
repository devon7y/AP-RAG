"use client";

import { PanelLeftIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveChat } from "@/hooks/use-active-chat";
import { usePdfViewer } from "@/lib/pdf/store";
import { cn } from "@/lib/utils";
import { AppTitle } from "./app-title";
import { DigestIndicator } from "./digest-indicator";
import { PageHeader } from "./page-header";
import { PersonaIndicator } from "./persona-indicator";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const { state, toggleSidebar, isMobile, peek } = useSidebar();
  const readerOpen = usePdfViewer((s) => s.tabs.length > 0);
  const { personaAuthor, digest } = useActiveChat();
  const isAuthorChat = Boolean(personaAuthor);
  const isDigestChat = Boolean(digest);

  // The header stays put whether or not the sidebar is collapsed. It used to be removed
  // entirely in that state, which meant opening the PDF reader — which collapses the
  // sidebar — also took away the corpus status and the persona/digest pill, exactly
  // when the reader makes them most useful.
  // A peeking sidebar is only transiently expanded, so it still counts as collapsed
  // here; otherwise the toggle would flicker in and out as the pointer passes.
  const sidebarTucked = peek || state === "collapsed";

  return (
    <PageHeader>
      <Button
        className={cn(!sidebarTucked && "md:hidden")}
        onClick={toggleSidebar}
        size="icon-sm"
        title={sidebarTucked ? "Open sidebar" : "Close sidebar"}
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
      </Button>

      <AppTitle
        showBackend={!(isAuthorChat || isDigestChat)}
        showExpansion={!readerOpen}
      />

      {/* Persona / digest pill sits centered between the title and the right controls.
          `min-w-0` is load-bearing: without it this wrapper's automatic minimum size is
          the pill's min-content width (the topic is nowrap), so it refuses to shrink —
          and since `flex-1` also gives it a zero basis, it can't shrink either, leaving
          the title to absorb every pixel. The title would collapse under the pill while
          its shrink-0 "AP-RAG" kept its width, which is how the two came to overlap once
          the reader took half the header. */}
      <div className="flex min-w-0 flex-1 justify-center">
        <PersonaIndicator />
        <DigestIndicator />
      </div>

      <div className="flex items-center gap-2">
        {!isReadonly && (
          <VisibilitySelector
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
          />
        )}
      </div>
    </PageHeader>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
  );
});
