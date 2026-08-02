"use client";

import { PanelLeftIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveChat } from "@/hooks/use-active-chat";
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
  const { state, toggleSidebar, isMobile } = useSidebar();
  const { personaAuthor, digest } = useActiveChat();
  const isAuthorChat = Boolean(personaAuthor);
  const isDigestChat = Boolean(digest);

  if (state === "collapsed" && !isMobile) {
    return null;
  }

  return (
    <header className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3">
      <Button
        className="md:hidden"
        onClick={toggleSidebar}
        size="icon-sm"
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
        {/* Author/digest chats hide the corpus connect/status badge to spotlight the pill. */}
        {!(isAuthorChat || isDigestChat) && <ConnectDialog />}
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
