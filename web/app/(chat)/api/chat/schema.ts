import { z } from "zod";

const textPartSchema = z.object({
  type: z.enum(["text"]),
  text: z.string().min(1).max(2000),
});

const filePartSchema = z.object({
  type: z.enum(["file"]),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  name: z.string().min(1).max(100),
  url: z.string().url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

const userMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user"]),
  parts: z.array(partSchema),
});

// AP-RAG metadata filters (all optional; snake_case to match the query server).
const filtersSchema = z.object({
  papers: z.array(z.string()).optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  years: z.array(z.number().int()).optional(),
  year_from: z.number().int().optional(),
  year_to: z.number().int().optional(),
  journals: z.array(z.string()).optional(),
  subjects: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  affiliations: z.array(z.string()).optional(),
});

const toolApprovalMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.record(z.unknown())),
});

export const postRequestBodySchema = z.object({
  id: z.string().uuid(),
  message: userMessageSchema.optional(),
  messages: z.array(toolApprovalMessageSchema).optional(),
  selectedChatModel: z.string(),
  selectedVisibilityType: z.enum(["public", "private"]),
  // AP-RAG controls (mirror the CLI flags).
  reasoning: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  mode: z.enum(["auto", "hybrid", "local", "global", "mix", "naive"]).optional(),
  chunkMode: z.boolean().optional(),
  filters: filtersSchema.optional(),
  // "Talk to Author": on the FIRST message of a new author-scoped chat, the surname this
  // chat is pinned to. Persisted onto the Chat row; ignored thereafter (read from the row).
  personaAuthor: z.string().min(1).max(120).optional(),
  // "Research Digest": on the FIRST message of a new digest chat, the topic + date window.
  // `from`/`to` are concrete "YYYY-MM"[-DD]. `openEnded` marks a "to present" digest — the
  // window's end tracks "now" and the digest can be refreshed as papers are added.
  // Persisted onto the Chat row; ignored thereafter.
  digest: z
    .object({
      topic: z.string().min(1).max(2000),
      from: z.string().regex(/^\d{4}(-\d{2}){0,2}$/),
      to: z.string().regex(/^\d{4}(-\d{2}){0,2}$/),
      openEnded: z.boolean().optional(),
    })
    .optional(),
  // Re-run an open-ended digest over its window extended to now (sent by the /digest
  // library's "Update" action); appends a fresh digest message to the chat.
  digestRefresh: z.boolean().optional(),
  // Filter keys ("authors:caplan", "year_from:2020") the user dismissed in the preview,
  // so the server's second-pass extraction won't re-add them.
  dismissed: z.array(z.string()).optional(),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
