"use client";

import { Share2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useChatParticipants } from "@/hooks/use-chat-participants";
import { useChatVisibility } from "@/hooks/use-chat-visibility";
import { cn } from "@/lib/utils";
import { ShareDialog } from "./share-dialog";

// "private" — owner only. "shared" — the owner plus explicitly invited users. "public" —
// every signed-in user. Shared and public both allow POSTING, not just reading: anyone
// with access can ask a question and the answer streams to everyone watching.
export type VisibilityType = "private" | "shared" | "public";

const labels: Record<VisibilityType, string> = {
  private: "Private",
  shared: "Shared",
  public: "Public",
};

export function VisibilitySelector({
  chatId,
  className,
  selectedVisibilityType,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
} & React.ComponentProps<typeof Button>) {
  const [open, setOpen] = useState(false);

  const { visibilityType, setVisibilityType } = useChatVisibility({
    chatId,
    initialVisibilityType: selectedVisibilityType,
  });

  // Only fetched while the chat is actually shared, so a private chat's header costs
  // nothing extra. The count tells the owner at a glance who else is in here.
  const { participants } = useChatParticipants(
    visibilityType === "shared" ? chatId : null
  );
  const memberCount = participants.filter((p) => !p.isOwner).length;

  return (
    <>
      <Button
        className={cn(
          "gap-1.5 rounded-lg border-border/50 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 focus-visible:border-border/50 active:translate-y-0",
          className
        )}
        data-testid="visibility-selector"
        onClick={() => setOpen(true)}
        size="sm"
        title={`Share this chat — currently ${labels[visibilityType]}`}
        variant="outline"
      >
        <Share2Icon className="size-3.5" />
        {/* The button says what it does. Current visibility is no longer carried by a
            varying icon, so it lives in the tooltip and the dialog — except the member
            count, which is worth seeing without opening anything. */}
        <span>
          Share
          {visibilityType === "shared" && memberCount > 0
            ? ` · ${memberCount + 1}`
            : ""}
        </span>
      </Button>

      <ShareDialog
        chatId={chatId}
        onOpenChange={setOpen}
        open={open}
        setVisibilityType={setVisibilityType}
        visibilityType={visibilityType}
      />
    </>
  );
}
