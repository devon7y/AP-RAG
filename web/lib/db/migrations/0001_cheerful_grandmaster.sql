-- "Talk to Author": scope a chat to one author (retrieval pinned to their papers,
-- answers in their first-person persona). Nullable; existing chats stay general.
ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "personaAuthor" text;
