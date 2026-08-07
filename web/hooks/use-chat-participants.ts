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

// The handle shown inside the conversation — message bylines, "X is typing…", the
// blocked-composer hint. Everything before the @ in the address, so people read as
// "devon7y" rather than as a full address or a display name they never chose.
export function username(person: { email: string }): string {
  return person.email.split("@")[0];
}

// A fuller label for the share dialog, where there's room and the full address is shown
// alongside: a real name if the account has one, else the same handle.
export function displayName(person: {
  name?: string | null;
  email: string;
}): string {
  if (person.name?.trim()) {
    return person.name.trim();
  }
  return username(person);
}
