-- Uploaded papers: papers a user attaches to a chat that are NOT in the AP-RAG database.
--
-- The corpus is built by the HPC ingest pipeline, so an uploaded PDF cannot join it on the
-- spot. It lives with its chat instead: the PDF goes to Vercel Blob and its extracted,
-- chunked text is stored here, which is what retrieval reads on every turn.
--
-- No foreign key on "chatId" on purpose — a paper can be attached before the first message
-- is sent, and the Chat row is only written when that message arrives.
CREATE TABLE IF NOT EXISTS "UploadedPaper" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chatId" uuid NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "filename" text NOT NULL,
  "blobUrl" text NOT NULL,
  "blobPathname" text NOT NULL,
  "byteSize" integer DEFAULT 0 NOT NULL,
  "pageCount" integer DEFAULT 0 NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "apa" text DEFAULT '' NOT NULL,
  "intext" text DEFAULT '' NOT NULL,
  "year" text DEFAULT '' NOT NULL,
  "chunks" json NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The read is always "the papers attached to THIS chat, oldest first".
CREATE INDEX IF NOT EXISTS "UploadedPaper_chatId_createdAt_idx"
  ON "UploadedPaper" ("chatId", "createdAt");
