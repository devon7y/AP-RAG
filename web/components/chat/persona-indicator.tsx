"use client";

import { UserRoundIcon } from "lucide-react";
import { useActiveChat } from "@/hooks/use-active-chat";
import { formatAuthorStat, useAuthorStats } from "@/lib/aprag/author-stats";

// Shown in the chat header while a Talk-to-Author chat is active: who you're speaking with
// and how much of the corpus grounds them (papers · passages).
export function PersonaIndicator() {
  const { personaAuthor } = useActiveChat();
  const { byAuthor } = useAuthorStats();

  if (!personaAuthor) {
    return null;
  }
  const stat = formatAuthorStat(byAuthor.get(personaAuthor));

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 py-1 pr-2.5 pl-2 text-xs">
      <UserRoundIcon className="size-3.5 shrink-0 text-primary/80" />
      <span className="shrink-0 font-semibold text-foreground">Author Chat:</span>
      <span className="truncate font-medium text-foreground">{personaAuthor}</span>
      {stat && (
        <span className="hidden shrink-0 text-muted-foreground sm:inline">
          · {stat}
        </span>
      )}
    </div>
  );
}
