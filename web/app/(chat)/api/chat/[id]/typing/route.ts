import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { resolveChatAccess, setChatTyping } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

const bodySchema = z.object({ typing: z.boolean() });

// Heartbeat "I'm composing a message here" (or clear it on send / on emptying the box).
// The client re-posts every few seconds while its composer has text; the row ages out on
// its own, so a closed tab needs no goodbye.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });
  // Announcing that you're typing is a write, so it takes write access.
  if (!access?.canWrite) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  await setChatTyping({
    chatId: id,
    userId: session.user.id,
    typing: body.typing,
  });

  return new Response(null, { status: 204 });
}
