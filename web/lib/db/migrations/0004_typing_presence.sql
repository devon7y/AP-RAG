-- Typing presence: who is composing a message in a shared chat right now, so the other
-- participants see "devon7y is typing…" and hold off on their own question.
--
-- A row is a heartbeat, not a flag — the client re-stamps updatedAt every few seconds
-- while its composer has text, and a reader treats anything older than a few seconds as
-- no longer typing. That way a closed tab clears itself with no explicit goodbye.
CREATE TABLE IF NOT EXISTS "ChatTyping" (
  "chatId" uuid NOT NULL REFERENCES "Chat"("id"),
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("chatId", "userId")
);
--> statement-breakpoint

-- The read is always "who is typing in THIS chat, recently".
CREATE INDEX IF NOT EXISTS "ChatTyping_chatId_updatedAt_idx"
  ON "ChatTyping" ("chatId", "updatedAt");
