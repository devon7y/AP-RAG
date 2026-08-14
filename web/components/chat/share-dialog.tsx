"use client";

import {
  CheckIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  displayName,
  useChatParticipants,
  useShareableUsers,
} from "@/hooks/use-chat-participants";
import { cn } from "@/lib/utils";
import { toast } from "./toast";
import { UserAvatar } from "./user-avatar";
import type { VisibilityType } from "./visibility-selector";

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const accessModes: Array<{
  id: VisibilityType;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "private",
    label: "Private",
    description: "Only you can open this chat",
    icon: <LockIcon className="size-4" />,
  },
  {
    id: "shared",
    label: "Specific people",
    description: "Only the people you invite below",
    icon: <UsersIcon className="size-4" />,
  },
  {
    id: "public",
    label: "Everyone signed in",
    description: "Anyone with an account on this deployment",
    icon: <GlobeIcon className="size-4" />,
  },
];

export function ShareDialog({
  chatId,
  open,
  onOpenChange,
  visibilityType,
  setVisibilityType,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visibilityType: VisibilityType;
  setVisibilityType: (visibility: VisibilityType) => void;
}) {
  const { participants, isOwner, refresh } = useChatParticipants(
    open ? chatId : null
  );
  const { users } = useShareableUsers(open && visibilityType === "shared");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const { mutate } = useSWRConfig();

  // The open chat reads its visibility from /api/messages, and only starts polling for
  // other participants' messages once it knows it's shared. Changing access here has to
  // invalidate that, or the person who just shared the chat would sit there not receiving
  // anything until a reload.
  const refreshChatAccess = () =>
    mutate(`${base}/api/messages?chatId=${chatId}`);

  const changeMode = (mode: VisibilityType) => {
    setVisibilityType(mode);
    refreshChatAccess();
  };

  const members = participants.filter((p) => !p.isOwner);

  // People who could still be added: everyone shareable who isn't already in the chat,
  // narrowed by the search box.
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    const alreadyIn = new Set(participants.map((p) => p.id));
    return users
      .filter((u) => !alreadyIn.has(u.id))
      .filter(
        (u) =>
          !q ||
          u.email.toLowerCase().includes(q) ||
          (u.name ?? "").toLowerCase().includes(q)
      );
  }, [users, search, participants]);

  const addMember = async (userId: string) => {
    setPending(userId);
    try {
      const response = await fetch(`${base}/api/chat/${chatId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.cause ?? body?.message ?? "Could not share");
      }
      await refresh();
      // The server promotes a private chat to "shared" on the first invite; mirror that
      // locally so the header button and the sidebar agree without a reload.
      if (visibilityType === "private") {
        setVisibilityType("shared");
      }
      refreshChatAccess();
      setSearch("");
    } catch (error) {
      toast({
        type: "error",
        description:
          error instanceof Error ? error.message : "Could not share the chat.",
      });
    } finally {
      setPending(null);
    }
  };

  const removeMember = async (userId: string) => {
    setPending(userId);
    try {
      const response = await fetch(`${base}/api/chat/${chatId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!response.ok) {
        throw new Error("Could not remove that person.");
      }
      const body = (await response.json()) as {
        participants: { isOwner: boolean }[];
      };
      await refresh();
      // Removing the last person returns the chat to private, server-side. Reflect it.
      const remaining = body.participants.filter((p) => !p.isOwner).length;
      if (remaining === 0 && visibilityType === "shared") {
        setVisibilityType("private");
      }
      refreshChatAccess();
    } catch (error) {
      toast({
        type: "error",
        description:
          error instanceof Error
            ? error.message
            : "Could not remove that person.",
      });
    } finally {
      setPending(null);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/chat/${chatId}`);
    toast({ type: "success", description: "Link copied." });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription>
            Everyone with access can read the conversation and ask their own
            questions. Answers stream to all of you at once.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          {accessModes.map((mode) => (
            <button
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                visibilityType === mode.id && "bg-accent/60"
              )}
              disabled={!isOwner}
              key={mode.id}
              onClick={() => changeMode(mode.id)}
              type="button"
            >
              <span className="text-muted-foreground">{mode.icon}</span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">{mode.label}</span>
                <span className="text-muted-foreground text-xs">
                  {mode.description}
                </span>
              </span>
              {visibilityType === mode.id && (
                <CheckIcon className="ml-auto size-4 shrink-0" />
              )}
            </button>
          ))}
        </div>

        {visibilityType === "shared" && (
          <div className="flex flex-col gap-2 border-border/60 border-t pt-3">
            {members.length > 0 && (
              <ul className="flex flex-col gap-1">
                {members.map((member) => (
                  <li
                    className="flex items-center gap-2 rounded-md px-1 py-1"
                    key={member.id}
                  >
                    <UserAvatar className="size-6" person={member} />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {displayName(member)}
                      <span className="ml-1.5 text-muted-foreground text-xs">
                        {member.email}
                      </span>
                    </span>
                    {isOwner && (
                      <Button
                        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                        disabled={pending === member.id}
                        onClick={() => removeMember(member.id)}
                        size="icon"
                        title="Remove"
                        variant="ghost"
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isOwner && (
              <>
                <Input
                  className="h-8"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search people by name or email"
                  value={search}
                />
                <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                  {candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                        disabled={pending === candidate.id}
                        onClick={() => addMember(candidate.id)}
                        type="button"
                      >
                        <UserAvatar className="size-6" person={candidate} />
                        <span className="min-w-0 flex-1 truncate">
                          {displayName(candidate)}
                          <span className="ml-1.5 text-muted-foreground text-xs">
                            {candidate.email}
                          </span>
                        </span>
                        <UserPlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                  {candidates.length === 0 && (
                    <li className="px-2 py-1.5 text-muted-foreground text-xs">
                      {members.length > 0
                        ? "Everyone else is already in this chat."
                        : "No other accounts have signed in to this deployment yet."}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-border/60 border-t pt-3">
          <span className="text-muted-foreground text-xs">
            {visibilityType === "private"
              ? "Only you can open this chat."
              : `${members.length + 1} ${members.length === 0 ? "person" : "people"} can post here.`}
          </span>
          <Button
            className="gap-1.5"
            onClick={copyLink}
            size="sm"
            variant="outline"
          >
            <LinkIcon className="size-3.5" />
            Copy link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
