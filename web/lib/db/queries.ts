import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { ChatbotError } from "../errors";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  chatMember,
  type DBMessage,
  document,
  message,
  type Suggestion,
  stream,
  suggestion,
  type User,
  user,
  vote,
} from "./schema";
import { generateHashedPassword } from "./utils";

const client = postgres(process.env.POSTGRES_URL ?? "");
const db = drizzle(client);

export async function getUser(email: string): Promise<User[]> {
  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
  personaAuthor,
  digest,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
  // "Talk to Author": the author this chat is scoped to (null for a normal chat).
  personaAuthor?: string | null;
  // "Research Digest": the topic + date range this chat summarizes (null for a normal chat).
  digest?: {
    topic: string;
    from: string;
    to: string;
    bucket: "month" | "year";
  } | null;
}) {
  try {
    return await db.insert(chat).values({
      id,
      createdAt: new Date(),
      userId,
      title,
      visibility,
      personaAuthor: personaAuthor ?? null,
      digest: digest ?? null,
    });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save chat");
  }
}

// Re-stamp a chat's Research Digest config (window end, refreshedAt, papersAtRefresh)
// after a digest generation run.
export async function updateChatDigest({
  chatId,
  digest: digestValue,
}: {
  chatId: string;
  digest: Chat["digest"];
}) {
  try {
    return await db
      .update(chat)
      .set({ digest: digestValue })
      .where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to update chat digest"
    );
  }
}

// Every digest chat of a user (the /digest library), newest first.
export async function getDigestChatsByUserId({
  id,
}: {
  id: string;
}): Promise<Chat[]> {
  try {
    return await db
      .select()
      .from(chat)
      .where(and(eq(chat.userId, id), isNotNull(chat.digest)))
      .orderBy(desc(chat.createdAt));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get digest chats"
    );
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));
    await db.delete(chatMember).where(eq(chatMember.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));
    await db.delete(chatMember).where(inArray(chatMember.chatId, chatIds));
    // Chats OTHERS shared with this user survive — deleting your own history shouldn't
    // delete someone else's conversation. Just drop the membership rows.
    await db.delete(chatMember).where(eq(chatMember.userId, userId));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    // The sidebar lists chats the user OWNS plus chats shared with them (a ChatMember
    // row). `isOwner` lets the sidebar split them into "Chats" and "Shared with me"
    // without a second round trip. Public chats are deliberately NOT swept in — being
    // readable by everyone shouldn't dump every chat into everyone's sidebar; a public
    // chat reaches you by its link, or by being explicitly shared with you.
    const query = (whereCondition?: SQL<unknown>) =>
      db
        .select({
          ...getTableColumns(chat),
          isOwner: sql<boolean>`(${chat.userId} = ${id})`.as("isOwner"),
        })
        .from(chat)
        .leftJoin(
          chatMember,
          and(eq(chatMember.chatId, chat.id), eq(chatMember.userId, id))
        )
        .where(
          whereCondition
            ? and(
                whereCondition,
                or(eq(chat.userId, id), isNotNull(chatMember.userId))
              )
            : or(eq(chat.userId, id), isNotNull(chatMember.userId))
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: (Chat & { isOwner: boolean })[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get chats by user id"
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to get chat by id");
  }
}

export type ChatAccess = {
  chat: Chat;
  isOwner: boolean;
  isMember: boolean;
  canRead: boolean;
  canWrite: boolean;
};

// The single place that answers "what may this user do with this chat". Every route that
// touches a chat goes through here rather than re-deriving `chat.userId === user.id`.
//
// Read and write are deliberately the SAME right for shared/public chats: a group chat
// where the other participants can watch but not ask isn't a group chat, and the old
// read-only behaviour is what "private + link" already gave. Only the owner may delete
// the chat or change who it's shared with.
export async function resolveChatAccess({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string | null;
}): Promise<ChatAccess | null> {
  const selected = await getChatById({ id: chatId });
  if (!selected) {
    return null;
  }

  const isOwner = Boolean(userId) && selected.userId === userId;
  // Membership only counts while the chat is actually shared. Setting a chat back to
  // private revokes everyone even if their rows survive — "private" means private.
  const isMember =
    !isOwner &&
    Boolean(userId) &&
    selected.visibility !== "private" &&
    (await isChatMember({ chatId, userId: userId as string }));

  // Public chats are open to every SIGNED-IN user. Anonymous readers are refused even on
  // a public chat: a participant can post into one, so "anyone with the link" would mean
  // anyone on the internet spending the lab's tokens against the corpus.
  const isPublicParticipant =
    selected.visibility === "public" && Boolean(userId);
  const allowed = isOwner || isMember || isPublicParticipant;

  return {
    chat: selected,
    isOwner,
    isMember,
    canRead: allowed,
    canWrite: allowed,
  };
}

export async function isChatMember({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  try {
    const [row] = await db
      .select({ userId: chatMember.userId })
      .from(chatMember)
      .where(and(eq(chatMember.chatId, chatId), eq(chatMember.userId, userId)))
      .limit(1);
    return Boolean(row);
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to check chat membership"
    );
  }
}

export type ChatParticipant = {
  id: string;
  email: string;
  name: string | null;
  isOwner: boolean;
};

// Owner first, then members in the order they were added. Used both by the share dialog
// and by the transcript, which labels each message with its sender.
export async function getChatParticipants({
  chatId,
}: {
  chatId: string;
}): Promise<ChatParticipant[]> {
  try {
    const [owner] = await db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(chat)
      .innerJoin(user, eq(user.id, chat.userId))
      .where(eq(chat.id, chatId))
      .limit(1);

    const members = await db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(chatMember)
      .innerJoin(user, eq(user.id, chatMember.userId))
      .where(eq(chatMember.chatId, chatId))
      .orderBy(asc(chatMember.createdAt));

    return [
      ...(owner ? [{ ...owner, isOwner: true }] : []),
      ...members.map((m) => ({ ...m, isOwner: false })),
    ];
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get chat participants"
    );
  }
}

export async function addChatMember({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  try {
    await db
      .insert(chatMember)
      .values({ chatId, userId, createdAt: new Date() })
      .onConflictDoNothing();
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to add chat member");
  }
}

export async function removeChatMember({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  try {
    await db
      .delete(chatMember)
      .where(and(eq(chatMember.chatId, chatId), eq(chatMember.userId, userId)));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to remove chat member"
    );
  }
}

export async function removeAllChatMembers({ chatId }: { chatId: string }) {
  try {
    await db.delete(chatMember).where(eq(chatMember.chatId, chatId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to remove chat members"
    );
  }
}

// Everyone this deployment could share with (it's an allowlisted lab, so the whole User
// table is the picker's candidate set), minus the requesting user.
export async function getShareableUsers({
  excludeUserId,
}: {
  excludeUserId: string;
}) {
  try {
    return await db
      .select({ id: user.id, email: user.email, name: user.name })
      .from(user)
      .where(and(ne(user.id, excludeUserId), eq(user.isAnonymous, false)))
      .orderBy(asc(user.email));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get shareable users"
    );
  }
}

// How long a claimed turn may sit before another participant can take it. A turn that
// crashed mid-flight (function timeout, dropped connection) would otherwise wedge the
// chat forever, since only the sender's own onFinish releases it.
const TURN_LOCK_STALE_MS = 5 * 60 * 1000;

// Atomically claim the chat for one turn. Returns false when someone else already holds
// it and their claim is still fresh. A single conditional UPDATE, so two simultaneous
// senders can't both win.
export async function claimChatTurn({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - TURN_LOCK_STALE_MS);
    const claimed = await db
      .update(chat)
      .set({
        activeUserId: userId,
        activeSince: new Date(),
        activeStreamId: null,
      })
      .where(
        and(
          eq(chat.id, chatId),
          or(
            isNull(chat.activeSince),
            lt(chat.activeSince, cutoff),
            // The holder may always re-claim: a stream that died without releasing
            // shouldn't lock its own sender out for the full staleness window.
            eq(chat.activeUserId, userId)
          )
        )
      )
      .returning({ id: chat.id });
    return claimed.length > 0;
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to claim chat turn");
  }
}

// Publish the resumable-stream id followers should attach to. Guarded on still holding
// the turn so a stale writer can't overwrite a newer sender's stream.
export async function setChatActiveStream({
  chatId,
  userId,
  streamId,
}: {
  chatId: string;
  userId: string;
  streamId: string;
}) {
  try {
    await db
      .update(chat)
      .set({ activeStreamId: streamId })
      .where(and(eq(chat.id, chatId), eq(chat.activeUserId, userId)));
  } catch (_error) {
    /* non-fatal: followers fall back to polling for the finished message */
  }
}

export async function releaseChatTurn({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  try {
    await db
      .update(chat)
      .set({ activeUserId: null, activeSince: null, activeStreamId: null })
      .where(and(eq(chat.id, chatId), eq(chat.activeUserId, userId)));
  } catch (_error) {
    /* non-fatal: the staleness window releases it */
  }
}

export type ChatActivity = {
  activeStreamId: string | null;
  activeUserId: string | null;
  activeSince: string | null;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  title: string;
  visibility: VisibilityType;
};

// The payload behind the participants' poll: enough to decide "has anything changed?"
// and "is an answer streaming right now, and under which stream id?" — without shipping
// the transcript on every tick.
export async function getChatActivity({
  chatId,
}: {
  chatId: string;
}): Promise<ChatActivity | null> {
  try {
    const [row] = await db
      .select({
        activeStreamId: chat.activeStreamId,
        activeUserId: chat.activeUserId,
        activeSince: chat.activeSince,
        title: chat.title,
        visibility: chat.visibility,
      })
      .from(chat)
      .where(eq(chat.id, chatId))
      .limit(1);

    if (!row) {
      return null;
    }

    const [[latest], [counted]] = await Promise.all([
      db
        .select({ id: message.id, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.chatId, chatId))
        .orderBy(desc(message.createdAt))
        .limit(1),
      db
        .select({ count: count(message.id) })
        .from(message)
        .where(eq(message.chatId, chatId)),
    ]);

    // A claim older than the staleness window is treated as gone, so a crashed turn
    // never leaves the other participants staring at a frozen "X is asking…".
    const stale =
      row.activeSince !== null &&
      row.activeSince.getTime() < Date.now() - TURN_LOCK_STALE_MS;

    return {
      activeStreamId: stale ? null : row.activeStreamId,
      activeUserId: stale ? null : row.activeUserId,
      activeSince: stale ? null : (row.activeSince?.toISOString() ?? null),
      lastMessageId: latest?.id ?? null,
      lastMessageAt: latest?.createdAt.toISOString() ?? null,
      messageCount: counted?.count ?? 0,
      title: row.title,
      visibility: row.visibility,
    };
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get chat activity"
    );
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save messages");
  }
}

export async function updateMessage({
  id,
  parts,
}: {
  id: string;
  parts: DBMessage["parts"];
}) {
  try {
    return await db.update(message).set({ parts }).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to update message");
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

// Votes are per (message, user) — in a shared chat each participant keeps their own.
export async function voteMessage({
  chatId,
  messageId,
  userId,
  type,
}: {
  chatId: string;
  messageId: string;
  userId: string;
  type: "up" | "down";
}) {
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId), eq(vote.userId, userId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(
          and(
            eq(vote.messageId, messageId),
            eq(vote.chatId, chatId),
            eq(vote.userId, userId)
          )
        );
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      userId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to vote message");
  }
}

// Only the requesting user's own votes: the thumbs in the UI reflect what YOU thought of
// an answer, not an aggregate of everyone in the chat.
export async function getVotesByChatId({
  id,
  userId,
}: {
  id: string;
  userId: string;
}) {
  try {
    return await db
      .select()
      .from(vote)
      .where(and(eq(vote.chatId, id), eq(vote.userId, userId)));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save document");
  }
}

export async function updateDocumentContent({
  id,
  content,
}: {
  id: string;
  content: string;
}) {
  try {
    const docs = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt))
      .limit(1);

    const latest = docs[0];
    if (!latest) {
      throw new ChatbotError("not_found:database", "Document not found");
    }

    return await db
      .update(document)
      .set({ content })
      .where(and(eq(document.id, id), eq(document.createdAt, latest.createdAt)))
      .returning();
  } catch (_error) {
    if (_error instanceof ChatbotError) {
      throw _error;
    }
    throw new ChatbotError(
      "bad_request:database",
      "Failed to update document content"
    );
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  try {
    return await db.update(chat).set({ title }).where(eq(chat.id, chatId));
  } catch (_error) {
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  try {
    const cutoffTime = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    // Charge each message to whoever SENT it (message.userId), not to whoever owns the
    // chat — otherwise posting into a chat shared with you would spend the owner's
    // hourly allowance. Messages predating attribution fall back to the old rule.
    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          or(
            eq(message.userId, id),
            and(isNull(message.userId), eq(chat.userId, id))
          ),
          gte(message.createdAt, cutoffTime),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}
