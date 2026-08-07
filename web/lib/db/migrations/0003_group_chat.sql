-- Group chat: a chat can be shared with specific users (or all users) who can then post
-- into it, with answers streaming live to everyone watching.

-- Who a "shared" chat is shared with. The owner is implicit (Chat.userId) and has no row.
CREATE TABLE IF NOT EXISTS "ChatMember" (
  "chatId" uuid NOT NULL REFERENCES "Chat"("id"),
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "createdAt" timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("chatId", "userId")
);
--> statement-breakpoint

-- Listing "shared with me" queries by member, not by chat.
CREATE INDEX IF NOT EXISTS "ChatMember_userId_idx" ON "ChatMember" ("userId");
--> statement-breakpoint

-- Turn lock: a chat answers one question at a time. The sender claims it here; other
-- participants attach to "activeStreamId" to watch the answer stream live.
ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "activeStreamId" text;
--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "activeUserId" uuid;
--> statement-breakpoint
ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "activeSince" timestamp;
--> statement-breakpoint

-- Attribution: who sent each message. Null on assistant messages and on everything
-- written before group chat existed.
ALTER TABLE "Message_v2" ADD COLUMN IF NOT EXISTS "userId" uuid REFERENCES "User"("id");
--> statement-breakpoint

-- Votes become per-user. Existing rows are attributed to the chat owner, who was until
-- now the only person who could vote.
ALTER TABLE "Vote_v2" ADD COLUMN IF NOT EXISTS "userId" uuid;
--> statement-breakpoint

UPDATE "Vote_v2" v SET "userId" = c."userId"
  FROM "Chat" c WHERE c."id" = v."chatId" AND v."userId" IS NULL;
--> statement-breakpoint

DELETE FROM "Vote_v2" WHERE "userId" IS NULL;
--> statement-breakpoint

ALTER TABLE "Vote_v2" ALTER COLUMN "userId" SET NOT NULL;
--> statement-breakpoint

-- The inline PRIMARY KEY ("chatId","messageId") from 0000 was auto-named by Postgres;
-- look it up rather than assuming "Vote_v2_pkey".
DO $$
DECLARE pk_name text;
BEGIN
  SELECT conname INTO pk_name FROM pg_constraint
    WHERE conrelid = '"Vote_v2"'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "Vote_v2" DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "Vote_v2"
  ADD CONSTRAINT "Vote_v2_chatId_messageId_userId_pk"
  PRIMARY KEY ("chatId", "messageId", "userId");
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Vote_v2_userId_User_id_fk'
  ) THEN
    ALTER TABLE "Vote_v2" ADD CONSTRAINT "Vote_v2_userId_User_id_fk"
      FOREIGN KEY ("userId") REFERENCES "User"("id");
  END IF;
END $$;
