"use client";

import { PanelLeftIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveChat } from "@/hooks/use-active-chat";
import { usePdfViewer } from "@/lib/pdf/store";
import { cn } from "@/lib/utils";
import { AppTitle } from "./app-title";
import { ConnectDialog } from "./connect-dialog";
import { DigestIndicator } from "./digest-indicator";
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
  // sidebar — also took away the corpus status, the connect dialog and the persona/
  // digest pill, exactly when the reader makes them most useful.
  // A peeking sidebar is only transiently expanded, so it still counts as collapsed
  // here; otherwise the toggle would flicker in and out as the pointer passes.
  const sidebarTucked = peek || state === "collapsed";

  return (
    <header className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3">
      <Button
        className={cn(!sidebarTucked && "md:hidden")}
        onClick={toggleSidebar}
        size="icon-sm"
        title={sidebarTucked ? "Open sidebar" : "Close sidebar"}
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
      </Button>

      <AppTitle showBackend={!(isAuthorChat || isDigestChat)} />

      {/* Persona / digest pill sits centered between the title and the right controls. */}
      <div className="flex flex-1 justify-center">
        <PersonaIndicator />
        <DigestIndicator />
      </div>

      <div className="flex items-center gap-2">
        {/* Author/digest chats hide the corpus connect/status badge to spotlight the
            pill; so does the reader, where the header has half the width to work with
            and reading the source matters more than setup instructions. */}
        {!(isAuthorChat || isDigestChat || readerOpen) && <ConnectDialog />}
        {!isReadonly && (
          <VisibilitySelector
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
          />
        )}
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
  );
});
