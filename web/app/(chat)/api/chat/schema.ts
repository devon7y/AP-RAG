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
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
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
  reasoning: z.enum(["minimal", "low", "medium", "high"]).optional(),
  mode: z.enum(["hybrid", "local", "global", "mix", "naive"]).optional(),
  chunkMode: z.boolean().optional(),
  filters: filtersSchema.optional(),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
