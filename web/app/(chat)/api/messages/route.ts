import { auth } from "@/app/(auth)/auth";
import {
  getChatParticipants,
  getMessagesByChatId,
  resolveChatAccess,
} from "@/lib/db/queries";
import { convertToUIMessages } from "@/lib/utils";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return Response.json({ error: "chatId required" }, { status: 400 });
  }

  const session = await auth();
  const userId = session?.user?.id ?? null;

  const access = await resolveChatAccess({ chatId, userId });

  // No such chat yet — the client is opening a brand-new conversation whose row is
  // written on the first message.
  if (!access) {
    return Response.json({
      messages: [],
      visibility: "private",
      userId: null,
      isReadonly: false,
      personaAuthor: null,
      digest: null,
      participants: [],
      isOwner: true,
      viewerId: userId,
    });
  }

  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!access.canRead) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const [messages, participants] = await Promise.all([
    getMessagesByChatId({ id: chatId }),
    getChatParticipants({ chatId }),
  ]);

  return Response.json({
    messages: convertToUIMessages(messages),
    visibility: access.chat.visibility,
    userId: access.chat.userId,
    // Everyone who can read a shared/public chat can also post into it — the read-only
    // transcript is what a private chat's link already gave.
    isReadonly: !access.canWrite,
    isOwner: access.isOwner,
    viewerId: userId,
    // Owner first, then members: the transcript labels each message with its sender and
    // the share dialog lists who currently has access.
    participants,
    personaAuthor: access.chat.personaAuthor ?? null,
    digest: access.chat.digest ?? null,
  });
}
