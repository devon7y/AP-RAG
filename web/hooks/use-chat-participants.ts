"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/utils";

export type Participant = {
  id: string;
  email: string;
  name: string | null;
  isOwner: boolean;
};

export type ShareableUser = {
  id: string;
  email: string;
  name: string | null;
};

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Who currently has access to a chat. Shared by the share dialog (the roster it edits)
// and the transcript (which labels each message with its sender).
export function useChatParticipants(chatId: string | null) {
  const { data, mutate, isLoading } = useSWR<{
    participants: Participant[];
    isOwner: boolean;
  }>(chatId ? `${base}/api/chat/${chatId}/members` : null, fetcher, {
    revalidateOnFocus: false,
  });

  return {
    participants: data?.participants ?? [],
    isOwner: data?.isOwner ?? false,
    isLoading,
    refresh: mutate,
  };
}

// Everyone this deployment can share with — an allowlisted lab, so a short list.
export function useShareableUsers(enabled: boolean) {
  const { data, isLoading } = useSWR<{ users: ShareableUser[] }>(
    enabled ? `${base}/api/users` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  return { users: data?.users ?? [], isLoading };
}

// "Devon Y" if we have a name, otherwise the local part of the email — a full address is
// too wide for a message byline.
export function displayName(person: {
  name?: string | null;
  email: string;
}): string {
  if (person.name?.trim()) {
    return person.name.trim();
  }
  return person.email.split("@")[0];
}
