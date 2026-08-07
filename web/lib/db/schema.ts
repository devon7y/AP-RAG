import type { InferSelectModel } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  json,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const user = pgTable("User", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  email: varchar("email", { length: 64 }).notNull(),
  password: varchar("password", { length: 64 }),
  name: text("name"),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  isAnonymous: boolean("isAnonymous").notNull().default(false),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export type User = InferSelectModel<typeof user>;

export const chat = pgTable("Chat", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  createdAt: timestamp("createdAt").notNull(),
  title: text("title").notNull(),
  // The creator. Owners alone can delete a chat and manage its member list; everyone
  // in `chatMember` (plus everyone, when visibility is "public") can read and post.
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  // "private" — owner only. "shared" — owner + the rows in `chatMember`. "public" —
  // every signed-in user. Shared and public are both read/WRITE: any participant can
  // send a message and the answer streams to everyone watching.
  visibility: varchar("visibility", { enum: ["public", "private", "shared"] })
    .notNull()
    .default("private"),
  // Group-chat turn lock. A chat answers one question at a time — concurrent sends would
  // interleave retrieval and race the message inserts (which are ordered by createdAt
  // alone). The sender claims the chat here for the duration of the turn; other
  // participants see "X is asking…" and their composer disables. `activeStreamId` is the
  // resumable-stream id the followers attach to, so they watch the answer stream live.
  activeStreamId: text("activeStreamId"),
  activeUserId: uuid("activeUserId"),
  activeSince: timestamp("activeSince"),
  // "Talk to Author": when set, this chat is scoped to one author — retrieval is
  // pinned to their papers and the answer speaks in their first-person persona.
  personaAuthor: text("personaAuthor"),
  // "Research Digest": when set, this chat summarizes a topic over a date range. The first
  // message runs the multi-bucket chronological path; follow-ups apply the range as a
  // filter. `openEnded` digests track "now" and can be re-run ("Update") as papers are
  // added; refreshedAt/papersAtRefresh record the last run for the /digest library.
  digest: json("digest").$type<{
    topic: string;
    from: string;
    to: string;
    bucket: "month" | "year";
    openEnded?: boolean;
    refreshedAt?: string;
    papersAtRefresh?: number;
  }>(),
});

export type Chat = InferSelectModel<typeof chat>;

// Who a "shared" chat is shared WITH. The owner is implicit (they're `chat.userId`) and
// never has a row here. Membership grants read + write; only the owner can edit the list.
export const chatMember = pgTable(
  "ChatMember",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.userId] }),
  })
);

export type ChatMember = InferSelectModel<typeof chatMember>;

// Who is composing a message right now, so the other participants see "devon7y is
// typing…" and know not to start their own question. A row is a heartbeat, not a flag:
// the client re-stamps `updatedAt` every few seconds while the composer has text, and a
// row goes stale on its own if that client closes the tab mid-sentence. Kept in Postgres
// rather than Redis because this deployment has no REDIS_URL — the writes are one small
// upsert per typing user per heartbeat, which is nothing at lab scale.
export const chatTyping = pgTable(
  "ChatTyping",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.userId] }),
  })
);

export type ChatTyping = InferSelectModel<typeof chatTyping>;

export const message = pgTable("Message_v2", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  role: varchar("role").notNull(),
  parts: json("parts").notNull(),
  attachments: json("attachments").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  // Who sent it, for attribution in a group chat. Null on assistant messages and on
  // every message written before group chat existed (rendered unattributed).
  userId: uuid("userId").references(() => user.id),
});

export type DBMessage = InferSelectModel<typeof message>;

// Votes are PER USER: in a group chat two people may disagree about the same answer, and
// a (chatId, messageId) key would let one silently overwrite the other.
export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.chatId, table.messageId, table.userId],
    }),
  })
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    id: uuid("id").notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    kind: varchar("text", { enum: ["text", "code", "image", "sheet"] })
      .notNull()
      .default("text"),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
  })
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    id: uuid("id").notNull().defaultRandom(),
    documentId: uuid("documentId").notNull(),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    description: text("description"),
    isResolved: boolean("isResolved").notNull().default(false),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const stream = pgTable(
  "Stream",
  {
    id: uuid("id").notNull().defaultRandom(),
    chatId: uuid("chatId").notNull(),
    createdAt: timestamp("createdAt").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id] }),
    chatRef: foreignKey({
      columns: [table.chatId],
      foreignColumns: [chat.id],
    }),
  })
);

export type Stream = InferSelectModel<typeof stream>;
