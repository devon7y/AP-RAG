import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import {
  getVotesByChatId,
  resolveChatAccess,
  voteMessage,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

const voteSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  type: z.enum(["up", "down"]),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter chatId is required."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:vote").toResponse();
  }

  const access = await resolveChatAccess({ chatId, userId: session.user.id });

  if (!access) {
    return new ChatbotError("not_found:chat").toResponse();
  }

  if (!access.canRead) {
    return new ChatbotError("forbidden:vote").toResponse();
  }

  // Your own votes only — in a shared chat the thumbs show what YOU thought, not an
  // aggregate over everyone reading.
  const votes = await getVotesByChatId({ id: chatId, userId: session.user.id });

  return Response.json(votes, { status: 200 });
}

export async function PATCH(request: Request) {
  let chatId: string;
  let messageId: string;
  let type: "up" | "down";

  try {
    const parsed = voteSchema.parse(await request.json());
    chatId = parsed.chatId;
    messageId = parsed.messageId;
    type = parsed.type;
  } catch {
    return new ChatbotError(
      "bad_request:api",
      "Parameters chatId, messageId, and type are required."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:vote").toResponse();
  }

  const access = await resolveChatAccess({ chatId, userId: session.user.id });

  if (!access) {
    return new ChatbotError("not_found:vote").toResponse();
  }

  if (!access.canWrite) {
    return new ChatbotError("forbidden:vote").toResponse();
  }

  await voteMessage({
    chatId,
    messageId,
    userId: session.user.id,
    type,
  });

  return new Response("Message voted", { status: 200 });
}
