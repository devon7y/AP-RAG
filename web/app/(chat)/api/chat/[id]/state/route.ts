import { auth } from "@/app/(auth)/auth";
import {
  getChatActivity,
  getChatParticipants,
  getTypingUsers,
  resolveChatAccess,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

// The heartbeat behind a shared chat. Participants poll this a few times a minute; it
// answers two questions cheaply, without shipping the transcript on every tick:
//
//   1. "Has anything changed?" — lastMessageId + messageCount. A change means somebody
//      posted (or an answer landed) and the client refetches /api/messages.
//   2. "Is an answer being written right now, and by whom?" — activeUserId names the
//      participant, activeStreamId is the stream to attach to for live tokens.
//
// Deliberately small: no message bodies, two indexed lookups.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const access = await resolveChatAccess({
    chatId: id,
    userId: session.user.id,
  });

  // A chat that doesn't exist yet is the normal case for an unsent new conversation.
  if (!access) {
    return Response.json({ exists: false });
  }
  if (!access.canRead) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const [activity, participants, typing] = await Promise.all([
    getChatActivity({ chatId: id }),
    getChatParticipants({ chatId: id }),
    getTypingUsers({ chatId: id, excludeUserId: session.user.id }),
  ]);

  if (!activity) {
    return Response.json({ exists: false });
  }

  const busyByOther =
    Boolean(activity.activeUserId) && activity.activeUserId !== session.user.id;

  return Response.json({
    exists: true,
    ...activity,
    participants,
    isOwner: access.isOwner,
    // True when the turn is held by SOMEONE ELSE — the flag the composer disables on.
    busyByOther,
    // Other people with text in their composer right now. Suppressed while a turn is
    // running: the composer is already blocked on that, and "asking…" is the more
    // urgent of the two states to report.
    typing: busyByOther ? [] : typing,
  });
}
