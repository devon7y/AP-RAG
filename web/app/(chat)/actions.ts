"use server";

import { generateText, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { openaiOptions } from "@/lib/ai/models";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel } from "@/lib/ai/providers";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  removeAllChatMembers,
  resolveChatAccess,
  updateChatVisibilityById,
} from "@/lib/db/queries";
import { getTextFromMessage } from "@/lib/utils";

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set("chat-model", model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const { text } = await generateText({
    model: getTitleModel(),
    system: titlePrompt,
    prompt: getTextFromMessage(message),
    // Mechanical: a 2-5 word title never benefits from reasoning.
    providerOptions: openaiOptions("none"),
  });
  return text
    .replace(/^[#*"\s]+/, "")
    .replace(/["]+$/, "")
    .trim();
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const [message] = await getMessageById({ id });
  if (!message) {
    throw new Error("Message not found");
  }

  const chat = await getChatById({ id: message.chatId });
  if (!chat) {
    throw new Error("Unauthorized");
  }

  // Editing a message discards everything after it, so in a shared chat this is NOT open
  // to every participant — only the person who sent that message, or the chat's owner.
  // Otherwise anyone could truncate someone else's thread. Messages predating attribution
  // carry no sender, so they're owner-only.
  const isSender =
    message.userId !== null && message.userId === session.user.id;
  const isOwner = chat.userId === session.user.id;
  if (!(isSender || isOwner)) {
    throw new Error("Unauthorized");
  }

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const access = await resolveChatAccess({ chatId, userId: session.user.id });
  if (!access?.isOwner) {
    throw new Error("Unauthorized");
  }

  await updateChatVisibilityById({ chatId, visibility });

  // Going private is an explicit revoke: drop the member rows rather than leaving them
  // dormant, so flipping back to shared later doesn't silently re-grant access to people
  // the owner meant to remove.
  if (visibility === "private") {
    await removeAllChatMembers({ chatId });
  }
}
