"use client";

import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { updateChatVisibility } from "@/app/(chat)/actions";
import {
  type ChatHistory,
  getChatHistoryPaginationKey,
} from "@/components/chat/sidebar-history";
import type { VisibilityType } from "@/components/chat/visibility-selector";

export function useChatVisibility({
  chatId,
  initialVisibilityType,
}: {
  chatId: string;
  initialVisibilityType: VisibilityType;
}) {
  const { mutate, cache } = useSWRConfig();
  const history: ChatHistory = cache.get(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history`
  )?.data;

  const { data: localVisibility, mutate: setLocalVisibility } =
    useSWR<VisibilityType>(`${chatId}-visibility`, null, {
      fallbackData: initialVisibilityType,
    });

  const visibilityType: VisibilityType = useMemo(() => {
    if (!history) {
      return localVisibility ?? initialVisibilityType;
    }
    const chat = history.chats.find((currentChat) => currentChat.id === chatId);
    // Absent from history isn't "private" — a public chat opened by link, or one shared
    // with you that hasn't paged in yet, simply isn't in the loaded window. Trust the
    // value the server sent for this chat instead of mislabelling it.
    if (!chat) {
      return localVisibility ?? initialVisibilityType;
    }
    return chat.visibility;
  }, [history, chatId, localVisibility, initialVisibilityType]);

  const setVisibilityType = (updatedVisibilityType: VisibilityType) => {
    setLocalVisibility(updatedVisibilityType);
    mutate(unstable_serialize(getChatHistoryPaginationKey));

    updateChatVisibility({
      chatId,
      visibility: updatedVisibilityType,
    });
  };

  return { visibilityType, setVisibilityType };
}
