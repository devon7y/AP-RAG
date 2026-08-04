"use client";

import { useActiveChat } from "@/hooks/use-active-chat";
import { PdfSplit } from "./pdf-split";

// Scopes the PDF reader to the chat it was opened from. The chat id (not the URL) is
// the right key: a brand-new chat mints its id client-side before the URL catches up,
// and papers opened in those first moments should stay with that conversation.
export function ChatPdfSplit({ children }: { children: React.ReactNode }) {
  const { chatId } = useActiveChat();
  return <PdfSplit scope={`chat:${chatId}`}>{children}</PdfSplit>;
}
